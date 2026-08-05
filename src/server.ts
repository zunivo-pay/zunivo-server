import "dotenv/config";
import express from "express";
import cors from "cors";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { isAddress, formatEther, parseEventLogs } from "viem";
import db, { hashOrderId } from "./db.js";
import { publicClient, NAMES_ADDRESS, NAMES_ABI, RECORDS_ADDRESS, RECORDS_ABI } from "./chain.js";
import { startIndexer, applyRecordEvent } from "./indexer.js";
import { startKeeper } from "./keeper.js";

const app = express();
app.use(cors({ origin: process.env.APP_ORIGIN ?? true }));
app.use(express.json());

const orderById = db.prepare("SELECT * FROM orders WHERE id=?");
const paymentsForOrder = db.prepare("SELECT * FROM payments WHERE order_hash=? ORDER BY block");

function orderView(o: any) {
  const pays = (paymentsForOrder.all(o.id_hash) as any[]).map((p) => ({
    txHash: p.tx_hash,
    payer: p.payer,
    gross: formatEther(BigInt(p.gross)),
    fee: formatEther(BigInt(p.fee)),
    block: p.block,
    ts: p.ts,
  }));
  return {
    id: o.id,
    merchant: o.merchant,
    amount: o.amount,
    memo: o.memo,
    status: o.status,
    splitId: o.split_id ?? null,
    createdAt: o.created_at,
    payments: pays,
  };
}

app.post("/api/orders", (req, res) => {
  const { merchant, amount, memo, splitId } = req.body ?? {};
  if (!isAddress(merchant ?? "")) return res.status(400).json({ error: "invalid merchant address" });
  const n = Number(amount);
  if (!amount || !isFinite(n) || n <= 0) return res.status(400).json({ error: "invalid amount" });
  if (splitId !== undefined && !/^\d+$/.test(String(splitId))) return res.status(400).json({ error: "invalid splitId" });
  const id = randomUUID();
  db.prepare(
    "INSERT INTO orders(id,id_hash,merchant,amount,memo,created_at,split_id) VALUES(?,?,?,?,?,?,?)"
  ).run(id, hashOrderId(id), merchant, String(amount), memo ?? null, Math.floor(Date.now() / 1000),
        splitId !== undefined ? String(splitId) : null);
  res.json({ id });
});

app.get("/api/orders/:id", (req, res) => {
  const o = orderById.get(req.params.id);
  if (!o) return res.status(404).json({ error: "order not found" });
  res.json(orderView(o));
});

app.get("/api/merchants/:address/activity", (req, res) => {
  const addr = req.params.address;
  if (!isAddress(addr)) return res.status(400).json({ error: "invalid address" });
  const orders = (db.prepare(
    "SELECT * FROM orders WHERE merchant=? COLLATE NOCASE ORDER BY created_at DESC LIMIT 200"
  ).all(addr) as any[]).map(orderView);
  res.json({ orders });
});

app.get("/api/merchants/:address/export.csv", (req, res) => {
  const addr = req.params.address;
  if (!isAddress(addr)) return res.status(400).send("invalid address");
  const rows = db.prepare(
    `SELECT o.id, o.amount, o.memo, o.status, o.created_at, p.tx_hash, p.payer, p.gross, p.ts
     FROM orders o LEFT JOIN payments p ON p.order_hash = o.id_hash
     WHERE o.merchant=? COLLATE NOCASE ORDER BY o.created_at DESC`
  ).all(addr) as any[];
  const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = ["order_id,amount_usdc,memo,status,created_at,tx_hash,payer,paid_usdc,paid_at"]
    .concat(
      rows.map((r) =>
        [r.id, r.amount, r.memo, r.status,
         r.created_at ? new Date(r.created_at * 1000).toISOString() : "",
         r.tx_hash, r.payer,
         r.gross ? formatEther(BigInt(r.gross)) : "",
         r.ts ? new Date(r.ts * 1000).toISOString() : ""].map(esc).join(",")
      )
    )
    .join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="zunivo-${addr.slice(0, 8)}.csv"`);
  res.send(csv);
});

app.get("/api/names/:address", (req, res) => {
  const addr = req.params.address;
  if (!isAddress(addr)) return res.status(400).json({ error: "invalid address" });
  const rows = db.prepare(
    "SELECT label, token_id FROM names WHERE owner=? COLLATE NOCASE ORDER BY label"
  ).all(addr) as any[];
  res.json({ names: rows.map((r) => ({ label: r.label, tokenId: r.token_id })) });
});

/** Fast-path: right after minting, the client hands us the tx hash and we
 *  ingest its NameRegistered/Transfer events immediately — no waiting for
 *  the polling indexer. Idempotent; the poller remains the source of truth. */
// ---------------------------------------------------------------
// Agent directory — the service-discovery layer over .agent names
// ---------------------------------------------------------------

/** Every .agent name that has published records; only names with a service
 *  endpoint ("url") count as discoverable agents. */
app.get("/api/agents", (_req, res) => {
  const rows = db.prepare(
    `SELECT n.label, n.owner, r.key, r.value, r.updated_at
     FROM names n JOIN agent_records r ON r.token_id = n.token_id
     ORDER BY n.label`
  ).all() as any[];
  const byLabel: Record<string, any> = {};
  for (const r of rows) {
    byLabel[r.label] ??= { name: `${r.label}.agent`, label: r.label, owner: r.owner, records: {}, updatedAt: 0 };
    byLabel[r.label].records[r.key] = r.value;
    byLabel[r.label].updatedAt = Math.max(byLabel[r.label].updatedAt, r.updated_at);
  }
  const agents = Object.values(byLabel).filter((a: any) => a.records.url);
  res.json({ agents });
});

/** Single agent card by label ("data" or "data.agent" both accepted). */
app.get("/api/agents/:label", (req, res) => {
  let label = String(req.params.label).toLowerCase();
  if (label.endsWith(".agent")) label = label.slice(0, -6);
  const name = db.prepare("SELECT label, owner, token_id FROM names WHERE label=?").get(label) as any;
  if (!name) return res.status(404).json({ error: "name not registered" });
  const rows = db.prepare("SELECT key, value, updated_at FROM agent_records WHERE token_id=?").all(name.token_id) as any[];
  const records: Record<string, string> = {};
  for (const r of rows) records[r.key] = r.value;
  res.json({ name: `${label}.agent`, label, owner: name.owner, records });
});

/** Fast-path: apply a records tx immediately after the client lands it. */
app.post("/api/agents/ingest", async (req, res) => {
  const { txHash } = req.body ?? {};
  if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return res.status(400).json({ error: "invalid txHash" });
  }
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
    const relevant = receipt.logs.filter(
      (l) => l.address.toLowerCase() === RECORDS_ADDRESS.toLowerCase()
    );
    const events = parseEventLogs({ abi: RECORDS_ABI, logs: relevant }) as any[];
    const ts = Math.floor(Date.now() / 1000);
    for (const ev of events) applyRecordEvent(ev, ts);
    res.json({ ok: true, ingested: events.length });
  } catch {
    res.status(502).json({ error: "could not read transaction yet — the indexer will catch it" });
  }
});

app.post("/api/names/ingest", async (req, res) => {
  const { txHash } = req.body ?? {};
  if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return res.status(400).json({ error: "invalid txHash" });
  }
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
    const relevant = receipt.logs.filter(
      (l) => l.address.toLowerCase() === NAMES_ADDRESS.toLowerCase()
    );
    const events = parseEventLogs({ abi: NAMES_ABI, logs: relevant }) as any[];
    let ingested = 0;
    for (const ev of events) {
      if (ev.eventName === "NameRegistered") {
        db.prepare("INSERT OR REPLACE INTO names(token_id,label,owner) VALUES(?,?,?)")
          .run(ev.args.tokenId.toString(), ev.args.name, ev.args.holder);
        ingested++;
      }
    }
    res.json({ ok: true, ingested });
  } catch {
    res.status(502).json({ error: "could not read transaction yet — the indexer will catch it" });
  }
});

app.get("/api/merchants/:address/sent", (req, res) => {
  const addr = req.params.address;
  if (!isAddress(addr)) return res.status(400).json({ error: "invalid address" });
  const rows = db.prepare(
    `SELECT p.tx_hash, p.gross, p.ts, o.id AS order_id, o.merchant, o.memo, o.split_id
     FROM payments p LEFT JOIN orders o ON o.id_hash = p.order_hash
     WHERE p.payer = ? COLLATE NOCASE
     ORDER BY p.ts DESC LIMIT 200`
  ).all(addr) as any[];
  res.json({
    sent: rows.map((r) => ({
      txHash: r.tx_hash,
      amount: formatEther(BigInt(r.gross)),
      ts: r.ts,
      orderId: r.order_id ?? null,
      to: r.merchant ?? null,
      memo: r.memo ?? null,
      splitId: r.split_id ?? null,
    })),
  });
});

app.get("/api/scheduled/:address", (req, res) => {
  const addr = req.params.address;
  if (!isAddress(addr)) return res.status(400).json({ error: "invalid address" });
  const now = Math.floor(Date.now() / 1000);
  const view = (r: any) => ({
    id: r.id,
    sender: r.sender,
    recipient: r.recipient,
    amount: formatEther(BigInt(r.amount)),
    unlockAt: r.unlock_at,
    reclaimAt: r.reclaim_at,
    status: r.status === "locked" && r.unlock_at <= now ? "claimable" : r.status,
    createdTx: r.created_tx,
    settledTx: r.settled_tx,
  });
  const incoming = (db.prepare(
    "SELECT * FROM scheduled WHERE recipient=? COLLATE NOCASE ORDER BY unlock_at DESC LIMIT 100"
  ).all(addr) as any[]).map(view);
  const outgoing = (db.prepare(
    "SELECT * FROM scheduled WHERE sender=? COLLATE NOCASE ORDER BY unlock_at DESC LIMIT 100"
  ).all(addr) as any[]).map(view);
  res.json({ incoming, outgoing });
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------
// Zunivo API v1 — the machine door: programmatic orders with API keys
// ---------------------------------------------------------------

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Self-serve key issuance (testnet). The key is shown exactly once. */
app.post("/api/keys", (req, res) => {
  const label = String(req.body?.label ?? "unnamed").slice(0, 64);
  const key = "zk_test_" + randomBytes(24).toString("hex");
  db.prepare("INSERT INTO api_keys(key_hash,label,created_at) VALUES(?,?,?)")
    .run(sha(key), label, Math.floor(Date.now() / 1000));
  res.json({ key, label, note: "Store this now — it is shown only once." });
});

function requireKey(req: any, res: any, next: any) {
  const key = req.header("X-Api-Key");
  if (!key) return res.status(401).json({ error: "missing X-Api-Key header" });
  const row = db.prepare("SELECT label FROM api_keys WHERE key_hash=?").get(sha(key));
  if (!row) return res.status(401).json({ error: "invalid api key" });
  (req as any).keyLabel = (row as any).label;
  next();
}

async function resolveDest(input: string): Promise<string | null> {
  let dest = String(input ?? "").trim();
  if (dest.startsWith("@") || dest.toLowerCase().endsWith(".agent")) {
    let label = dest.replace(/^@/, "").toLowerCase();
    if (label.endsWith(".agent")) label = label.slice(0, -6);
    if (!/^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$/.test(label)) return null;
    try {
      const addr = (await publicClient.readContract({
        address: NAMES_ADDRESS, abi: NAMES_ABI, functionName: "resolve", args: [label],
      })) as string;
      return addr === "0x0000000000000000000000000000000000000000" ? null : addr;
    } catch {
      return null;
    }
  }
  return isAddress(dest) ? dest : null;
}

/** Create an order programmatically. Accepts a 0x address or a .agent name. */
app.post("/v1/orders", requireKey, async (req, res) => {
  const { to, amount, memo } = req.body ?? {};
  const merchant = await resolveDest(to);
  if (!merchant) return res.status(400).json({ error: "unresolvable recipient (0x address or registered .agent name)" });
  const n = Number(amount);
  if (!amount || !isFinite(n) || n <= 0) return res.status(400).json({ error: "invalid amount" });
  const id = randomUUID();
  db.prepare("INSERT INTO orders(id,id_hash,merchant,amount,memo,created_at) VALUES(?,?,?,?,?,?)")
    .run(id, hashOrderId(id), merchant, String(amount), memo ?? null, Math.floor(Date.now() / 1000));
  const origin = process.env.APP_ORIGIN ?? "http://localhost:5173";
  res.status(201).json({ id, payUrl: `${origin}/pay?oid=${id}`, status: "unpaid", to: merchant, amount: String(amount) });
});

app.get("/v1/orders/:id", requireKey, (req, res) => {
  const o = orderById.get(req.params.id);
  if (!o) return res.status(404).json({ error: "order not found" });
  res.json(orderView(o));
});

const PORT = Number(process.env.PORT ?? 8787);
app.listen(PORT, () => console.log(`[zunivo-server] http://localhost:${PORT}`));
startIndexer();
startKeeper();
