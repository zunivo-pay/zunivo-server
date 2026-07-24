import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import db from "./db.js";
import { parseEventLogs } from "viem";
import { publicClient, arcTestnet, SCHED_ADDRESS, SCHED_ABI, NAMES_ADDRESS, NAMES_ABI } from "./chain.js";

const START = BigInt(process.env.SCHED_START_BLOCK ?? "53036093");
const NAMES_START = BigInt(process.env.NAMES_START_BLOCK ?? "52965184");
const POLL_MS = 30_000;
const LIMIT_COOLDOWN_MS = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let errStreak = 0;
const CHUNK = 2000n;
const NCHUNK = 10_000n; // names contract is event-sparse — big strides

const getCur = (): bigint => {
  const r = db.prepare("SELECT v FROM cursor WHERE k='sched_block'").get() as { v: string } | undefined;
  return r ? BigInt(r.v) : START - 1n;
};
const setCur = (b: bigint) =>
  db.prepare("INSERT INTO cursor(k,v) VALUES('sched_block',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(b.toString());

async function scan() {
  const latest = await publicClient.getBlockNumber();
  let from = getCur() + 1n;
  while (from <= latest) {
    const to = from + CHUNK > latest ? latest : from + CHUNK;
    // one address-only query per chunk; decode locally (3x fewer RPC calls)
    const raw = await publicClient.getLogs({ address: SCHED_ADDRESS, fromBlock: from, toBlock: to });
    const logs = parseEventLogs({ abi: SCHED_ABI, logs: raw });
    await sleep(200);
    for (const log of logs as any[]) {
      const a = log.args;
      if (log.eventName === "SendScheduled") {
        db.prepare(
          `INSERT OR IGNORE INTO scheduled(id,order_hash,sender,recipient,amount,unlock_at,reclaim_at,created_tx)
           VALUES(?,?,?,?,?,?,?,?)`
        ).run(Number(a.id), a.orderId, a.sender, a.recipient, a.amount.toString(),
              Number(a.unlockAt), Number(a.reclaimAt), log.transactionHash);
      } else if (log.eventName === "Released") {
        db.prepare("UPDATE scheduled SET status='released', settled_tx=? WHERE id=?")
          .run(log.transactionHash, Number(a.id));
      } else if (log.eventName === "Reclaimed") {
        db.prepare("UPDATE scheduled SET status='reclaimed', settled_tx=? WHERE id=?")
          .run(log.transactionHash, Number(a.id));
      }
    }
    setCur(to);
    from = to + 1n;
  }
}

const getNCur = (): bigint => {
  const r = db.prepare("SELECT v FROM cursor WHERE k='names_block'").get() as { v: string } | undefined;
  return r ? BigInt(r.v) : NAMES_START - 1n;
};
const setNCur = (b: bigint) =>
  db.prepare("INSERT INTO cursor(k,v) VALUES('names_block',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(b.toString());

async function scanNames() {
  const latest = await publicClient.getBlockNumber();
  let from = getNCur() + 1n;
  const startedBehind = latest - from;
  while (from <= latest) {
    const to = from + NCHUNK > latest ? latest : from + NCHUNK;
    const raw = await publicClient.getLogs({ address: NAMES_ADDRESS, fromBlock: from, toBlock: to });
    const logs = parseEventLogs({ abi: NAMES_ABI, logs: raw });
    for (const log of logs as any[]) {
      const a = log.args;
      if (log.eventName === "NameRegistered") {
        db.prepare("INSERT OR REPLACE INTO names(token_id,label,owner) VALUES(?,?,?)")
          .run(a.tokenId.toString(), a.name, a.holder);
      } else if (log.eventName === "Transfer" && a.from !== "0x0000000000000000000000000000000000000000") {
        db.prepare("UPDATE names SET owner=? WHERE token_id=?").run(a.to, a.tokenId.toString());
      }
    }
    setNCur(to);
    from = to + 1n;
    await sleep(200);
  }
  if (startedBehind > 10_000n) {
    const count = (db.prepare("SELECT COUNT(*) c FROM names").get() as any).c;
    console.log(`[names] caught up to block ${latest} — ${count} name(s) indexed`);
  }
}

async function autoRelease() {
  const pk = process.env.KEEPER_PK;
  if (!pk) return;
  const due = db.prepare(
    "SELECT id FROM scheduled WHERE status='locked' AND unlock_at <= ? LIMIT 10"
  ).all(Math.floor(Date.now() / 1000)) as { id: number }[];
  if (due.length === 0) return;
  const account = privateKeyToAccount(pk as `0x${string}`);
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: http() });
  for (const { id } of due) {
    try {
      const hash = await wallet.writeContract({
        address: SCHED_ADDRESS, abi: SCHED_ABI, functionName: "release", args: [BigInt(id)],
      });
      console.log(`[keeper] released lock ${id}: ${hash}`);
      await publicClient.waitForTransactionReceipt({ hash });
    } catch (e) {
      console.error(`[keeper] release ${id} failed:`, (e as Error).message?.slice(0, 120));
    }
  }
}

export function startKeeper() {
  const loop = async () => {
    let delay = POLL_MS;
    try {
      await scan();
      await scanNames();
      await autoRelease();
      if (errStreak > 0) console.log("[keeper] rpc recovered, scan caught up");
      errStreak = 0;
    } catch (e) {
      errStreak++;
      const msg = (e as Error)?.message ?? "";
      if (/limit/i.test(msg)) {
        delay = LIMIT_COOLDOWN_MS;
        if (errStreak === 1) console.warn("[keeper] rpc quota hit — cooling down 60s (no data lost)");
      } else if (errStreak === 1) {
        console.warn("[keeper]", msg.slice(0, 90));
      }
    } finally { setTimeout(loop, delay); }
  };
  loop();
  console.log(`[keeper] watching ${SCHED_ADDRESS} from block ${getCur() + 1n}${process.env.KEEPER_PK ? " (auto-release ON)" : " (auto-release off — set KEEPER_PK to enable)"}`);
}
