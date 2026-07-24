import Database from "better-sqlite3";
import { keccak256, toHex } from "viem";

const db = new Database(process.env.DB_PATH ?? "zunivo.db");
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS orders(
  id TEXT PRIMARY KEY,
  id_hash TEXT NOT NULL UNIQUE,
  merchant TEXT NOT NULL,
  amount TEXT NOT NULL,
  memo TEXT,
  status TEXT NOT NULL DEFAULT 'unpaid',
  created_at INTEGER NOT NULL,
  split_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders(merchant);
CREATE TABLE IF NOT EXISTS payments(
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL DEFAULT 0,
  order_hash TEXT NOT NULL,
  payer TEXT NOT NULL,
  merchant TEXT NOT NULL,
  gross TEXT NOT NULL,
  fee TEXT NOT NULL,
  block INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_payments_merchant ON payments(merchant);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_hash);
CREATE TABLE IF NOT EXISTS cursor(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_keys(
  key_hash TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS names(
  token_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  owner TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_names_owner ON names(owner);
CREATE TABLE IF NOT EXISTS scheduled(
  id INTEGER PRIMARY KEY,
  order_hash TEXT,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  amount TEXT NOT NULL,
  unlock_at INTEGER NOT NULL,
  reclaim_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'locked',
  created_tx TEXT,
  settled_tx TEXT
);
CREATE INDEX IF NOT EXISTS idx_sched_recipient ON scheduled(recipient);
CREATE INDEX IF NOT EXISTS idx_sched_sender ON scheduled(sender);
`);
try { db.exec("ALTER TABLE orders ADD COLUMN split_id TEXT"); } catch {}
// M-3 fix: payments must be keyed by (tx_hash, log_index) — one tx can carry many payments
try {
  const cols = db.prepare("PRAGMA table_info(payments)").all() as any[];
  if (!cols.some((c) => c.name === "log_index")) {
    db.exec(`
      CREATE TABLE payments_v2(
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL DEFAULT 0,
        order_hash TEXT NOT NULL,
        payer TEXT NOT NULL,
        merchant TEXT NOT NULL,
        gross TEXT NOT NULL,
        fee TEXT NOT NULL,
        block INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        PRIMARY KEY (tx_hash, log_index)
      );
      INSERT INTO payments_v2(tx_hash,log_index,order_hash,payer,merchant,gross,fee,block,ts)
        SELECT tx_hash,0,order_hash,payer,merchant,gross,fee,block,ts FROM payments;
      DROP TABLE payments;
      ALTER TABLE payments_v2 RENAME TO payments;
      CREATE INDEX IF NOT EXISTS idx_payments_merchant ON payments(merchant);
    `);
  }
} catch {}


export const hashOrderId = (id: string): `0x${string}` => keccak256(toHex(id));
export default db;
