/**
 * x402demo.ts — Zunivo's flagship paid endpoint, built for the Circle Agent
 * Marketplace listing.
 *
 *   GET /x402/crypto10      → 402 quote → pay USDC on Arc → top-10 crypto snapshot
 *   GET /x402/openapi.json  → OpenAPI 3.1 spec (a marketplace listing requirement)
 *
 * Settlement is the Zunivo order flow, wired straight into our own SQLite
 * (no HTTP loopback, no API key). Hardening (v2, self-audit findings):
 *   A-1  durable replay store  — consumed payments survive restarts (sqlite,
 *        atomic INSERT OR IGNORE), so a restart can never re-open a spent order.
 *   A-2  order provenance      — only orders THIS endpoint minted (memo marker)
 *        can unlock it; a third-party paid order to the same wallet is refused.
 *   A-3  quote rate limit      — unpaid 402s mint an order row; capped per-IP
 *        so a GET flood cannot grow the orders table unbounded. (Best-effort
 *        abuse control, not a security boundary — XFF can be spoofed.)
 *   A-4  no pay-for-nothing    — data availability is checked BEFORE any
 *        payment is verified/consumed; if upstream is down and no cache
 *        exists, callers get 503 and nobody's payment is burned.
 *
 * Env:
 *   X402_DEMO_PAYTO  (required) — 0x payout address; use a DEDICATED wallet
 *   X402_DEMO_PRICE  (optional) — USDC per call, default "0.05"
 */
import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { paymentRequired } from "zunivo-x402-arc";
import db, { hashOrderId } from "./db.js";

const PAYTO = process.env.X402_DEMO_PAYTO ?? "";
const PRICE = process.env.X402_DEMO_PRICE ?? "0.05";
const ORIGIN = process.env.APP_ORIGIN ?? "https://app.zunivo.io";
const RESOURCE = "https://api.zunivo.io/x402/crypto10";
/** A-2: provenance marker — verify() only honors orders carrying it. */
const MEMO_TAG = "[x402:crypto10]";

/** Human USDC string → 6-decimal base units (strict enough for our own rows). */
function toBase(h: string): bigint {
  const [w, f = ""] = String(h).split(".");
  return BigInt((w || "0") + (f + "000000").slice(0, 6));
}

/** A-1: durable, atomic replay store (middleware's reserve() contract). */
function sqliteConsumedStore() {
  db.exec("CREATE TABLE IF NOT EXISTS x402_consumed(key TEXT PRIMARY KEY, at INTEGER)");
  const ins = db.prepare("INSERT OR IGNORE INTO x402_consumed(key,at) VALUES(?,?)");
  const sel = db.prepare("SELECT 1 FROM x402_consumed WHERE key=?");
  return {
    async reserve(k: string) { return ins.run(k, Math.floor(Date.now() / 1000)).changes === 1; },
    async has(k: string) { return !!sel.get(k); },
    async add(k: string) { ins.run(k, Math.floor(Date.now() / 1000)); },
  };
}

/** Local settlement adapter: same contract as the SDK's zunivoVerify, minus HTTP. */
function localSettle() {
  return {
    async quote(price: string, payTo: string, memo: string) {
      const id = randomUUID();
      db.prepare(
        "INSERT INTO orders(id,id_hash,merchant,amount,memo,created_at) VALUES(?,?,?,?,?,?)",
      ).run(id, hashOrderId(id), payTo, String(price), `${MEMO_TAG} ${memo ?? ""}`.trim(),
            Math.floor(Date.now() / 1000));
      return { id, payUrl: `${ORIGIN}/pay?oid=${id}`, to: payTo };
    },
    async verify(payload: any, accept: any) {
      const orderId = payload?.zunivoOrderId;
      if (!orderId) throw new Error("payload missing zunivoOrderId");
      const o: any = db.prepare("SELECT * FROM orders WHERE id=?").get(orderId);
      if (!o) throw new Error("unknown order");
      // A-2: refuse orders this endpoint didn't mint — a paid order to the same
      // wallet from any OTHER flow (payment link, invoice) is not a data credit.
      if (!String(o.memo ?? "").startsWith(MEMO_TAG)) {
        return { settled: false, status: "foreign-order", reason: "order was not minted by this endpoint" };
      }
      const paid = o.status === "paid";
      if (paid && accept) {
        if (toBase(String(o.amount ?? "0")) < BigInt(accept.maxAmountRequired)) {
          return { settled: false, status: "underpaid", reason: `order paid ${o.amount} < required` };
        }
        const wantTo = String(accept.extra?.payToAddress || accept.payTo || "").toLowerCase();
        const gotTo = String(o.merchant ?? "").toLowerCase();
        if (wantTo.startsWith("0x") && gotTo.startsWith("0x") && wantTo !== gotTo) {
          return { settled: false, status: "wrong-recipient", reason: "order paid to a different recipient" };
        }
      }
      const pay: any = db
        .prepare("SELECT tx_hash FROM payments WHERE order_hash=? ORDER BY block LIMIT 1")
        .get(o.id_hash);
      return { settled: paid, status: o.status, amount: o.amount, to: o.merchant, txHash: pay?.tx_hash ?? null };
    },
  };
}

/** A-3: per-IP limiter for the order-minting (unpaid-402) path only. */
function quoteLimiter(maxPerMin = 20) {
  const hits = new Map<string, number[]>();
  setInterval(() => {
    const cut = Date.now() - 60_000;
    for (const [ip, ts] of hits) {
      const keep = ts.filter((t) => t > cut);
      if (keep.length) hits.set(ip, keep); else hits.delete(ip);
    }
  }, 30_000).unref();
  return (req: any, res: any, next: any) => {
    if (req.header("X-PAYMENT") || req.header("PAYMENT-SIGNATURE")) return next(); // paid retries never limited
    const ip = String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "?").split(",")[0].trim();
    const now = Date.now();
    const ts = (hits.get(ip) ?? []).filter((t) => t > now - 60_000);
    if (ts.length >= maxPerMin) {
      return res.status(429).json({ error: "quote rate limit — retry in a minute, or attach X-PAYMENT" });
    }
    ts.push(now);
    hits.set(ip, ts);
    next();
  };
}

// ---- the data being sold: top-10 crypto market snapshot, 60s cache ---------

let cache: { at: number; coins: any[] } | null = null;

async function crypto10(): Promise<{ asOf: string; source: string; coins: any[] }> {
  const now = Date.now();
  if (!cache || now - cache.at > 60_000) {
    try {
      const r = await fetch(
        "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=10&page=1",
        { signal: AbortSignal.timeout(8_000) },
      );
      if (r.ok) {
        const rows = (await r.json()) as any[];
        cache = {
          at: now,
          coins: rows.map((c) => ({
            rank: c.market_cap_rank, symbol: String(c.symbol).toUpperCase(), name: c.name,
            priceUsd: c.current_price, marketCapUsd: c.market_cap, change24hPct: c.price_change_percentage_24h,
          })),
        };
      }
    } catch { /* keep last cache */ }
  }
  if (!cache) throw new Error("upstream data unavailable");
  return { asOf: new Date(cache.at).toISOString(), source: "coingecko", coins: cache.coins };
}

// ---- OpenAPI 3.1 spec — a Circle Agent Marketplace listing requirement -----

const OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "Zunivo Crypto-10",
    version: "1.0.0",
    description:
      "Top-10 cryptocurrency market snapshot (price, market cap, 24h change), " +
      "priced per call in USDC over the x402 protocol, settled on Arc. " +
      "Unpaid requests receive HTTP 402 with PaymentRequirements; pay the quoted " +
      "USDC amount on Arc and retry with the X-PAYMENT header.",
    contact: { name: "Zunivo", url: "https://zunivo.io" },
  },
  servers: [{ url: "https://api.zunivo.io" }],
  paths: {
    "/x402/crypto10": {
      get: {
        operationId: "getCrypto10",
        summary: `Top-10 crypto market snapshot (${PRICE} USDC per call, x402)`,
        parameters: [
          {
            name: "X-PAYMENT", in: "header", required: false,
            description: "base64 JSON x402 payment payload; omit to receive a 402 quote",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Paid — market snapshot returned; X-PAYMENT-RESPONSE header carries the settlement receipt.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    asOf: { type: "string", format: "date-time" },
                    source: { type: "string" },
                    coins: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          rank: { type: "integer" }, symbol: { type: "string" }, name: { type: "string" },
                          priceUsd: { type: "number" }, marketCapUsd: { type: "number" },
                          change24hPct: { type: "number" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "402": {
            description:
              "Payment required — body and PAYMENT-REQUIRED header carry x402 PaymentRequirements " +
              "(accepts[] lists network 'arc-testnet' and CAIP-2 'eip155:5042002' forms of the same offer).",
          },
          "429": { description: "Unpaid quote rate limit exceeded for this IP." },
        },
      },
    },
  },
};

/** Mount the demo service. No-op (with a loud log) if config is unusable. */
export function mountX402Demo(app: Express) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(PAYTO)) {
    console.log("[x402demo] X402_DEMO_PAYTO not set — /x402/crypto10 disabled");
    return;
  }
  if (!/^\d+(\.\d{1,6})?$/.test(PRICE)) {
    console.log(`[x402demo] invalid X402_DEMO_PRICE "${PRICE}" — /x402/crypto10 disabled`);
    return;
  }
  const pay = paymentRequired({
    price: PRICE,
    payTo: PAYTO,
    description: "Zunivo Crypto-10 — top-10 crypto market snapshot",
    resource: RESOURCE,
    verify: localSettle(),
    consumedStore: sqliteConsumedStore(),   // A-1
  });
  // A-4: check the goods exist BEFORE any payment logic runs. If we can't
  // serve data, reply 503 up front — a payment must never be consumed for a
  // response we cannot deliver.
  const ensureData = async (req: any, res: any, next: any) => {
    try {
      req.crypto10 = await crypto10();
      next();
    } catch {
      res.status(503).json({ error: "market data temporarily unavailable — no payment taken, retry shortly" });
    }
  };
  app.get("/x402/crypto10", ensureData, quoteLimiter(), pay, (req: any, res: any) => {
    res.json(req.crypto10);
  });
  app.get("/x402/openapi.json", (_req: any, res: any) => res.json(OPENAPI));
  crypto10().catch(() => {}); // warm the cache at boot (best-effort)
  console.log(`[x402demo] /x402/crypto10 live · ${PRICE} USDC per call → ${PAYTO.slice(0, 8)}…`);
}
