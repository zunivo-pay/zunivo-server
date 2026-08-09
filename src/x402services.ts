/**
 * x402services.ts — Zunivo's paid x402 services on Arc (Circle Agent Marketplace).
 *
 *   GET /x402/agent-check/:name  0.05 USDC  KYA — counterparty diligence for agents
 *   GET /x402/arc-pulse          0.10 USDC  Arc payment-economy snapshot (exclusive index)
 *   GET /x402/crypto10           0.05 USDC  top-10 crypto market snapshot (starter demo)
 *   GET /x402/openapi.json       free       OpenAPI 3.1 spec for all endpoints
 *
 * The first two are backed by data ONLY Zunivo has: our index of every payment
 * through the verified ArcPayRouter, every .agent name, and every published
 * agent card.
 *
 * Hardening (carried from the audited v3 + kept per-endpoint):
 *   A-1 durable replay store (sqlite, atomic INSERT OR IGNORE)
 *   A-2 order provenance     (per-endpoint memo tag — no cross-endpoint reuse,
 *                             no third-party paid order can unlock anything)
 *   A-3 quote rate limit     (per-IP on unpaid 402s; best-effort abuse control)
 *   A-4 no pay-for-nothing   (goods checked BEFORE payment: unknown .agent → 404
 *                             pre-payment; crypto10 upstream down → 503 pre-payment)
 *
 * Env: X402_DEMO_PAYTO (required, dedicated 0x wallet) · X402_DEMO_PRICE (crypto10, default 0.05)
 */
import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { paymentRequired } from "zunivo-x402-arc";
import db, { hashOrderId } from "./db.js";
import { formatEther } from "viem";

const PAYTO = process.env.X402_DEMO_PAYTO ?? "";
const ORIGIN = process.env.APP_ORIGIN ?? "https://app.zunivo.io";
const PRICE_CRYPTO10 = process.env.X402_DEMO_PRICE ?? "0.05";
const PRICE_AGENT_CHECK = "0.05";
const PRICE_PULSE = "0.10";

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
const consumedStore = sqliteConsumedStore(); // one shared table; keys are resource-scoped

/** A-2: local settlement adapter with a per-endpoint provenance tag. */
function localSettle(tag: string) {
  return {
    async quote(price: string, payTo: string, memo: string) {
      const id = randomUUID();
      db.prepare(
        "INSERT INTO orders(id,id_hash,merchant,amount,memo,created_at) VALUES(?,?,?,?,?,?)",
      ).run(id, hashOrderId(id), payTo, String(price), `${tag} ${memo ?? ""}`.trim(),
            Math.floor(Date.now() / 1000));
      return { id, payUrl: `${ORIGIN}/pay?oid=${id}`, to: payTo };
    },
    async verify(payload: any, accept: any) {
      const orderId = payload?.zunivoOrderId;
      if (!orderId) throw new Error("payload missing zunivoOrderId");
      const o: any = db.prepare("SELECT * FROM orders WHERE id=?").get(orderId);
      if (!o) throw new Error("unknown order");
      if (!String(o.memo ?? "").startsWith(tag)) {
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
    if (req.header("X-PAYMENT") || req.header("PAYMENT-SIGNATURE")) return next();
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

// ============================================================================
// Service 1 — Agent check (KYA): counterparty diligence before an agent pays
// ============================================================================

const fmt = (wei: string | bigint) => Number(formatEther(BigInt(wei))).toFixed(2);

function agentCheck(label: string) {
  const name: any = db.prepare("SELECT label, owner, token_id FROM names WHERE label=?").get(label);
  if (!name) return null;
  const owner = String(name.owner);

  const records: Record<string, string> = {};
  for (const r of db.prepare("SELECT key, value FROM agent_records WHERE token_id=?").all(name.token_id) as any[]) {
    records[r.key] = r.value;
  }
  const namesHeld = (db.prepare("SELECT COUNT(*) c FROM names WHERE owner=? COLLATE NOCASE").get(owner) as any).c;

  // money RECEIVED as merchant (through the verified router, order-bound)
  const recv: any = db.prepare(
    `SELECT COUNT(DISTINCT o.id) orders, COALESCE(SUM(p.gross),0) vol, MIN(p.ts) first_ts, MAX(p.ts) last_ts
     FROM orders o JOIN payments p ON p.order_hash=o.id_hash
     WHERE o.merchant=? COLLATE NOCASE AND o.status='paid'`,
  ).get(owner);
  // money SENT as payer
  const sent: any = db.prepare(
    "SELECT COUNT(*) n, COALESCE(SUM(gross),0) vol, MIN(ts) first_ts FROM payments WHERE payer=? COLLATE NOCASE",
  ).get(owner);

  const firstSeen = Math.min(recv.first_ts ?? Infinity, sent.first_ts ?? Infinity);
  const now = Math.floor(Date.now() / 1000);
  const ageDays = Number.isFinite(firstSeen) ? Math.floor((now - firstSeen) / 86400) : null;

  const flags: string[] = [];
  if (recv.orders === 0 && sent.n === 0) flags.push("NO_PAYMENT_HISTORY");
  if (ageDays !== null && ageDays < 7) flags.push("ACTIVE_LESS_THAN_7D");
  if (!records.url) flags.push("NO_PUBLISHED_SERVICE");
  if (records.url && !/^https:\/\//i.test(records.url)) flags.push("NON_HTTPS_ENDPOINT");

  return {
    name: `${label}.agent`,
    owner,
    registered: true,
    serviceCard: { url: records.url ?? null, x402: records.x402 ?? null, description: records.description ?? null },
    namesHeld,
    received: { settledOrders: recv.orders, volumeUsdc: fmt(recv.vol), lastActivity: recv.last_ts ?? null },
    sent: { payments: sent.n, volumeUsdc: fmt(sent.vol) },
    firstSeen: Number.isFinite(firstSeen) ? firstSeen : null,
    accountAgeDays: ageDays,
    riskFlags: flags,
    asOf: new Date().toISOString(),
    basis: "Zunivo index of order-bound settlements via the verified ArcPayRouter, .agent registry, and on-chain agent cards (Arc testnet).",
  };
}

// ============================================================================
// Service 2 — Arc pulse: the payment-economy snapshot only our index can build
// ============================================================================

function arcPulse() {
  const now = Math.floor(Date.now() / 1000);
  const day = now - 86400, week = now - 7 * 86400;
  const span = (since: number) => db.prepare(
    `SELECT COUNT(*) n, COALESCE(SUM(gross),0) vol, COUNT(DISTINCT payer) payers FROM payments WHERE ts>=?`,
  ).get(since) as any;
  const d = span(day), w = span(week), all = span(0);
  const merchants: any = db.prepare(
    "SELECT COUNT(DISTINCT merchant) m FROM orders WHERE status='paid'").get();
  const names: any = db.prepare("SELECT COUNT(*) c FROM names").get();
  const agents: any = db.prepare(
    "SELECT COUNT(DISTINCT token_id) c FROM agent_records WHERE key='url' AND value!=''").get();
  const sched: any = db.prepare(
    "SELECT COUNT(*) n, COALESCE(SUM(amount),0) vol FROM scheduled WHERE status='locked'").get();
  const top = (db.prepare(
    `SELECT o.merchant, SUM(p.gross) vol, COUNT(DISTINCT o.id) orders
     FROM orders o JOIN payments p ON p.order_hash=o.id_hash WHERE o.status='paid'
     GROUP BY o.merchant COLLATE NOCASE ORDER BY SUM(p.gross) DESC LIMIT 5`).all() as any[])
    .map((r) => {
      const n: any = db.prepare("SELECT label FROM names WHERE owner=? COLLATE NOCASE ORDER BY label LIMIT 1").get(r.merchant);
      return {
        merchant: n ? `${n.label}.agent` : `${r.merchant.slice(0, 6)}…${r.merchant.slice(-4)}`,
        volumeUsdc: fmt(r.vol), settledOrders: r.orders,
      };
    });
  return {
    network: "arc-testnet (eip155:5042002)",
    settlement: {
      last24h: { payments: d.n, volumeUsdc: fmt(d.vol), uniquePayers: d.payers },
      last7d: { payments: w.n, volumeUsdc: fmt(w.vol), uniquePayers: w.payers },
      allTime: { payments: all.n, volumeUsdc: fmt(all.vol), uniquePayers: all.payers, uniqueMerchants: merchants.m },
    },
    committedSends: { locked: sched.n, volumeUsdc: fmt(String(sched.vol)) },
    agentNamespace: { namesMinted: names.c, publishedAgents: agents.c },
    topEarners: top,
    asOf: new Date().toISOString(),
    basis: "Zunivo index of the verified ArcPayRouter, ZunivoScheduledSends, ZunivoNames and ZunivoAgentRecords contracts.",
  };
}

// ============================================================================
// Service 3 — crypto10 (starter demo): top-10 market snapshot, 60s cache
// ============================================================================

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

// ============================================================================
// OpenAPI 3.1 — all endpoints (a marketplace listing requirement)
// ============================================================================

const OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "Zunivo Agent Intel",
    version: "2.0.0",
    description:
      "Paid x402 services on Arc, backed by Zunivo's exclusive index of the Arc payment " +
      "economy: every order-bound settlement through the verified ArcPayRouter, every .agent " +
      "name, and every published agent card. Unpaid requests receive HTTP 402 with " +
      "PaymentRequirements (accepts[] carries both 'arc-testnet' and CAIP-2 'eip155:5042002'); " +
      "pay the quoted USDC on Arc and retry with the X-PAYMENT header.",
    contact: { name: "Zunivo", url: "https://zunivo.io" },
  },
  servers: [{ url: "https://api.zunivo.io" }],
  paths: {
    "/x402/agent-check/{name}": {
      get: {
        operationId: "agentCheck",
        summary: `KYA — counterparty diligence for a .agent identity (${PRICE_AGENT_CHECK} USDC per call)`,
        description:
          "Before your agent pays an unknown counterparty: settled-order history, volumes, " +
          "account age, published service card, and risk flags (NO_PAYMENT_HISTORY, " +
          "ACTIVE_LESS_THAN_7D, NO_PUBLISHED_SERVICE, NON_HTTPS_ENDPOINT). Unknown names " +
          "return 404 BEFORE any payment is taken.",
        parameters: [
          { name: "name", in: "path", required: true, schema: { type: "string" },
            description: ".agent name, with or without the suffix (e.g. 'aaa' or 'aaa.agent')" },
          { name: "X-PAYMENT", in: "header", required: false, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Diligence report: identity, service card, received/sent history, accountAgeDays, riskFlags[]." },
          "402": { description: "Payment required (x402 PaymentRequirements)." },
          "404": { description: "Name not registered — no payment taken." },
          "429": { description: "Unpaid quote rate limit." },
        },
      },
    },
    "/x402/arc-pulse": {
      get: {
        operationId: "arcPulse",
        summary: `Arc payment-economy snapshot (${PRICE_PULSE} USDC per call)`,
        description:
          "24h / 7d / all-time settlement volume and counts, unique payers and merchants, " +
          "locked committed sends, .agent namespace stats, and the top-5 earning agents. " +
          "The only queryable index of Arc's order-bound payment economy.",
        parameters: [{ name: "X-PAYMENT", in: "header", required: false, schema: { type: "string" } }],
        responses: {
          "200": { description: "Economy snapshot (settlement, committedSends, agentNamespace, topEarners)." },
          "402": { description: "Payment required (x402 PaymentRequirements)." },
          "429": { description: "Unpaid quote rate limit." },
        },
      },
    },
    "/x402/crypto10": {
      get: {
        operationId: "getCrypto10",
        summary: `Top-10 crypto market snapshot (${PRICE_CRYPTO10} USDC per call) — starter demo`,
        parameters: [{ name: "X-PAYMENT", in: "header", required: false, schema: { type: "string" } }],
        responses: {
          "200": { description: "Market snapshot { asOf, source, coins[10] }." },
          "402": { description: "Payment required (x402 PaymentRequirements)." },
          "429": { description: "Unpaid quote rate limit." },
          "503": { description: "Upstream market data unavailable — no payment taken." },
        },
      },
    },
  },
};

// ============================================================================

export function mountX402Services(app: Express) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(PAYTO)) {
    console.log("[x402] X402_DEMO_PAYTO not set — paid services disabled");
    return;
  }
  if (!/^\d+(\.\d{1,6})?$/.test(PRICE_CRYPTO10)) {
    console.log(`[x402] invalid X402_DEMO_PRICE "${PRICE_CRYPTO10}" — paid services disabled`);
    return;
  }

  // --- agent-check ---
  const payCheck = paymentRequired({
    price: PRICE_AGENT_CHECK, payTo: PAYTO,
    description: "Zunivo Agent Check — KYA diligence for a .agent identity",
    verify: localSettle("[x402:agent-check]"), consumedStore,
  });
  const normalizeName = (req: any, res: any, next: any) => {
    let label = String(req.params.name ?? "").toLowerCase();
    if (label.endsWith(".agent")) label = label.slice(0, -6);
    if (!/^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$/.test(label)) {
      return res.status(400).json({ error: "invalid .agent name format — no payment taken" });
    }
    // A-4: verify the goods exist BEFORE any payment logic runs.
    const report = agentCheck(label);
    if (!report) return res.status(404).json({ error: `${label}.agent is not registered — no payment taken` });
    req.agentReport = report;
    next();
  };
  app.get("/x402/agent-check/:name", normalizeName, quoteLimiter(), payCheck,
    (req: any, res: any) => res.json(req.agentReport));

  // --- arc-pulse ---
  const payPulse = paymentRequired({
    price: PRICE_PULSE, payTo: PAYTO,
    description: "Zunivo Arc Pulse — Arc payment-economy snapshot",
    resource: "https://api.zunivo.io/x402/arc-pulse",
    verify: localSettle("[x402:arc-pulse]"), consumedStore,
  });
  app.get("/x402/arc-pulse", quoteLimiter(), payPulse, (_req: any, res: any) => res.json(arcPulse()));

  // --- crypto10 (starter demo) ---
  const payCrypto = paymentRequired({
    price: PRICE_CRYPTO10, payTo: PAYTO,
    description: "Zunivo Crypto-10 — top-10 crypto market snapshot",
    resource: "https://api.zunivo.io/x402/crypto10",
    verify: localSettle("[x402:crypto10]"), consumedStore,
  });
  const ensureData = async (req: any, res: any, next: any) => {
    try { req.crypto10 = await crypto10(); next(); }
    catch { res.status(503).json({ error: "market data temporarily unavailable — no payment taken, retry shortly" }); }
  };
  app.get("/x402/crypto10", ensureData, quoteLimiter(), payCrypto, (req: any, res: any) => res.json(req.crypto10));

  app.get("/x402/openapi.json", (_req: any, res: any) => res.json(OPENAPI));
  crypto10().catch(() => {});
  console.log(`[x402] live: /x402/agent-check (${PRICE_AGENT_CHECK}) · /x402/arc-pulse (${PRICE_PULSE}) · /x402/crypto10 (${PRICE_CRYPTO10}) → ${PAYTO.slice(0, 8)}…`);
}
