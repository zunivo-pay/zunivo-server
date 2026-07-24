import { parseEther } from "viem";
import db from "./db.js";
import { parseEventLogs } from "viem";
import { publicClient, ROUTER_ADDRESS, PAYMENT_EVENT, SPLIT_ADDRESS, SPLIT_ABI } from "./chain.js";

const START_BLOCK = BigInt(process.env.START_BLOCK ?? "52904490");
const POLL_MS = 20_000;
const LIMIT_COOLDOWN_MS = 60_000;
const CHUNK = 9000n;

const getCursor = (): bigint => {
  const row = db.prepare("SELECT v FROM cursor WHERE k='last_block'").get() as { v: string } | undefined;
  return row ? BigInt(row.v) : START_BLOCK - 1n;
};
const setCursor = (b: bigint) =>
  db.prepare("INSERT INTO cursor(k,v) VALUES('last_block',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(b.toString());

const insertPayment = db.prepare(
  `INSERT OR IGNORE INTO payments(tx_hash,log_index,order_hash,payer,merchant,gross,fee,block,ts)
   VALUES(?,?,?,?,?,?,?,?,?)`
);

function settleOrders() {
  const unpaid = db.prepare("SELECT * FROM orders WHERE status='unpaid'").all() as any[];
  const byHash = db.prepare("SELECT * FROM payments WHERE order_hash=?");
  const markPaid = db.prepare("UPDATE orders SET status='paid' WHERE id=?");
  for (const o of unpaid) {
    const pays = byHash.all(o.id_hash) as any[];
    const need = parseEther(o.amount);
    const got = pays
      .filter((p) => o.split_id != null || p.merchant.toLowerCase() === o.merchant.toLowerCase())
      .reduce((s, p) => s + BigInt(p.gross), 0n);
    if (got >= need) markPaid.run(o.id);
  }
}

async function tick() {
  const latest = await publicClient.getBlockNumber();
  let from = getCursor() + 1n;
  if (from > latest) return;
  while (from <= latest) {
    const to = from + CHUNK > latest ? latest : from + CHUNK;
    const logs = await publicClient.getLogs({
      address: ROUTER_ADDRESS,
      event: PAYMENT_EVENT,
      fromBlock: from,
      toBlock: to,
    });
    const tsCache = new Map<bigint, number>();
    const tsCache2 = new Map<bigint, number>();
    for (const log of logs) {
      const a = log.args;
      let ts = tsCache.get(log.blockNumber);
      if (ts === undefined) {
        const block = await publicClient.getBlock({ blockNumber: log.blockNumber });
        ts = Number(block.timestamp);
        tsCache.set(log.blockNumber, ts);
      }
      insertPayment.run(
        log.transactionHash,
        Number(log.logIndex ?? 0),
        a.orderId,
        a.payer,
        a.merchant,
        a.grossAmount!.toString(),
        a.feeAmount!.toString(),
        Number(log.blockNumber),
        ts
      );
    }
    // split-contract payments in the same range (best-effort: never aborts the tick)
    let splitLogs: any[] = [];
    try {
      const splitRaw = await publicClient.getLogs({ address: SPLIT_ADDRESS, fromBlock: from, toBlock: to });
      splitLogs = parseEventLogs({ abi: SPLIT_ABI, logs: splitRaw }) as any[];
    } catch {}
    for (const log of splitLogs as any[]) {
      if (log.eventName !== "SplitPaid") continue;
      const a = log.args;
      let ts = tsCache2.get(log.blockNumber);
      if (ts === undefined) {
        const block = await publicClient.getBlock({ blockNumber: log.blockNumber });
        ts = Number(block.timestamp);
        tsCache2.set(log.blockNumber, ts);
      }
      insertPayment.run(
        log.transactionHash, Number(log.logIndex ?? 0), a.orderId, a.payer, SPLIT_ADDRESS,
        a.grossAmount.toString(), a.feeAmount.toString(), Number(log.blockNumber), ts
      );
    }
    setCursor(to);
    from = to + 1n;
  }
  settleOrders();
}

export function startIndexer() {
  const loop = async () => {
    let delay = POLL_MS;
    try {
      await tick();
    } catch (e) {
      try { settleOrders(); } catch {} // settlement never waits for a clean scan
      const msg = (e as Error).message ?? "";
      if (/limit/i.test(msg)) {
        delay = LIMIT_COOLDOWN_MS;
        console.warn("[indexer] rpc quota hit — cooling down 60s (no data lost)");
      } else {
        console.error("[indexer]", msg.slice(0, 90));
      }
    } finally {
      setTimeout(loop, delay);
    }
  };
  loop();
  console.log(`[indexer] watching ${ROUTER_ADDRESS} from block ${getCursor() + 1n}`);
}
