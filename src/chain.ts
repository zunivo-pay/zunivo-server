import { createPublicClient, defineChain, http, parseAbi, parseAbiItem } from "viem";

/**
 * Network selection — ONE switch for the whole server.
 *
 *   NETWORK=mainnet   Arc mainnet, v1.3 contracts, real USDC   (api.zunivo.io)
 *   NETWORK=testnet   Arc testnet, sandbox contracts            (testnet-api.zunivo.io)
 *
 * Every chain-specific value (chain def, RPC, explorer, contract addresses, start
 * blocks, x402 network id) derives from this. Individual env vars still override
 * for ops (RPC_URL, *_ADDRESS, *_START_BLOCK) but you never have to set them just
 * to pick a network.
 */
export type NetworkName = "mainnet" | "testnet";

const rawNet = (process.env.NETWORK ?? "testnet").toLowerCase();
if (rawNet !== "mainnet" && rawNet !== "testnet") {
  throw new Error(`NETWORK must be "mainnet" or "testnet" (got "${rawNet}")`);
}
export const NETWORK: NetworkName = rawNet;
export const IS_MAINNET = NETWORK === "mainnet";

type NetConfig = {
  chainId: number;
  chainName: string;
  rpc: string;
  explorer: string;
  x402Network: "arc" | "arc-testnet";
  caip2: string;
  contracts: { router: string; names: string; sched: string; split: string; records: string };
  startBlocks: { router: string; sched: string; names: string };
  /** v1.3 semantics: a name transfer bumps nameEpoch and implicitly invalidates its records. */
  recordsInvalidateOnTransfer: boolean;
  /** Where the *other* environment lives (for the app's network badge / API discovery). */
  siblingApi: string;
};

const CONFIGS: Record<NetworkName, NetConfig> = {
  mainnet: {
    chainId: 5042,
    chainName: "Arc",
    rpc: "https://rpc.mainnet.arc.io",
    explorer: "https://arc.etherscan.io",
    x402Network: "arc",
    caip2: "eip155:5042",
    // v1.3, deployed 2026-09-17 block 21240365, verified on arc.etherscan.io
    // (zunivo-contracts/deployments/arc-mainnet-v1.3.json)
    contracts: {
      router:  "0xAa8c293495446d04a51A32e2e4557EDE3BfC7119",
      names:   "0x824218447E8Dbf10E535dC7fB6ab7b68105c7dDa",
      sched:   "0x8d2193555Ad7C3f2EEfe66Ede0F8A3477774050c",
      split:   "0x3c07F894A14AA080191b2Cc95dd4d0BfA31E5715",
      records: "0xFE9fca63CaA64FBf0B2F089786A706f0C99dCbB1",
    },
    startBlocks: { router: "21240365", sched: "21240365", names: "21240365" },
    recordsInvalidateOnTransfer: true,
    siblingApi: "https://testnet-api.zunivo.io",
  },
  testnet: {
    chainId: 5042002,
    chainName: "Arc Testnet",
    rpc: "https://rpc.testnet.arc.network",
    explorer: "https://testnet.arcscan.app",
    x402Network: "arc-testnet",
    caip2: "eip155:5042002",
    // the ORIGINAL testnet set that app.zunivo.io has run on (kept as the sandbox)
    contracts: {
      router:  "0x4210D40a9899e42b4946B9dC7E0C35d3cf14Ea55",
      names:   "0x244e0c8bE1Ed59636901F98920413d414B158cc5",
      sched:   "0xad5121668867a234Bd1f7D62eC40D09Ee3f47c02",
      split:   "0x12F21A2AC582061598445874c6C5f4F3bcE53eCF",
      records: "0x4f405f0aA04FD6FaE0838DeE6FD184B1f3cC306B",
    },
    startBlocks: { router: "52904490", sched: "53036093", names: "52965184" },
    recordsInvalidateOnTransfer: false,
    siblingApi: "https://api.zunivo.io",
  },
};

export const NET = CONFIGS[NETWORK];

const addr = (env: string | undefined, fallback: string) => {
  const v = env ?? fallback;
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`bad contract address "${v}"`);
  return v as `0x${string}`;
};

export const arcChain = defineChain({
  id: NET.chainId,
  name: NET.chainName,
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL ?? NET.rpc] } },
  blockExplorers: { default: { name: "ArcScan", url: NET.explorer } },
  testnet: !IS_MAINNET,
});
/** @deprecated use arcChain — kept so old imports keep compiling. */
export const arcTestnet = arcChain;

const RPC_URL = process.env.RPC_URL ?? NET.rpc;
export const publicClient = createPublicClient({ chain: arcChain, transport: http(RPC_URL) });
export const EXPLORER = NET.explorer;
export const txUrl = (hash: string) => `${NET.explorer}/tx/${hash}`;

export const ROUTER_ADDRESS  = addr(process.env.ROUTER_ADDRESS,  NET.contracts.router);
export const SCHED_ADDRESS   = addr(process.env.SCHED_ADDRESS,   NET.contracts.sched);
export const NAMES_ADDRESS   = addr(process.env.NAMES_ADDRESS,   NET.contracts.names);
export const SPLIT_ADDRESS   = addr(process.env.SPLIT_ADDRESS,   NET.contracts.split);
export const RECORDS_ADDRESS = addr(process.env.RECORDS_ADDRESS, NET.contracts.records);

export const START_BLOCK       = BigInt(process.env.START_BLOCK       ?? NET.startBlocks.router);
export const SCHED_START_BLOCK = BigInt(process.env.SCHED_START_BLOCK ?? NET.startBlocks.sched);
export const NAMES_START_BLOCK = BigInt(process.env.NAMES_START_BLOCK ?? NET.startBlocks.names);

/** Public, non-secret description of this deployment (served at /api/network). */
export const NETWORK_INFO = {
  network: NETWORK,
  chainId: NET.chainId,
  chainName: NET.chainName,
  x402Network: NET.x402Network,
  caip2: NET.caip2,
  explorer: NET.explorer,
  contracts: {
    router: ROUTER_ADDRESS, names: NAMES_ADDRESS, scheduled: SCHED_ADDRESS,
    split: SPLIT_ADDRESS, records: RECORDS_ADDRESS,
  },
  siblingApi: NET.siblingApi,
};

// ---------------------------------------------------------------------------
// ABIs (unchanged between the sandbox set and v1.3 for everything we read)
// ---------------------------------------------------------------------------

export const PAYMENT_EVENT = parseAbiItem(
  "event PaymentReceived(bytes32 indexed orderId, address indexed payer, address indexed merchant, uint256 grossAmount, uint256 feeAmount)"
);

export const SCHED_ABI = parseAbi([
  "event SendScheduled(uint256 indexed id, bytes32 indexed orderId, address indexed recipient, address sender, uint256 amount, uint64 unlockAt, uint64 reclaimAt)",
  "event Released(uint256 indexed id, bytes32 indexed orderId, address indexed recipient, uint256 netAmount, uint256 feeAmount)",
  "event Reclaimed(uint256 indexed id, address indexed sender, uint256 amount)",
  "function release(uint256 id) external",
]);

export const NAMES_ABI = parseAbi([
  "event NameRegistered(string name, uint256 indexed tokenId, address indexed holder, uint256 pricePaid)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "function resolve(string label) view returns (address)",
]);

export const SPLIT_ABI = parseAbi([
  "event SplitPaid(uint256 indexed splitId, bytes32 indexed orderId, address indexed payer, uint256 grossAmount, uint256 feeAmount)",
]);

// --- Agent service-discovery records (ZunivoAgentRecords) ---
export const RECORDS_ABI = parseAbi([
  "event TextChanged(uint256 indexed tokenId, string indexed indexedKey, string key, string value)",
  "event RecordsCleared(uint256 indexed tokenId, uint64 newVersion)",
  "function texts(string label, string[] keys) view returns (string[] values)",
]);
