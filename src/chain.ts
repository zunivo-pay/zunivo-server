import { createPublicClient, defineChain, http, parseAbiItem } from "viem";

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
  blockExplorers: { default: { name: "ArcScan", url: "https://testnet.arcscan.app" } },
  testnet: true,
});

const RPC_URL = process.env.RPC_URL ?? "https://rpc.testnet.arc.network";
export const publicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC_URL) });

export const ROUTER_ADDRESS = (process.env.ROUTER_ADDRESS ??
  "0x4210D40a9899e42b4946B9dC7E0C35d3cf14Ea55") as `0x${string}`;

export const PAYMENT_EVENT = parseAbiItem(
  "event PaymentReceived(bytes32 indexed orderId, address indexed payer, address indexed merchant, uint256 grossAmount, uint256 feeAmount)"
);

export const SCHED_ADDRESS = (process.env.SCHED_ADDRESS ??
  "0xad5121668867a234Bd1f7D62eC40D09Ee3f47c02") as `0x${string}`;

import { parseAbi } from "viem";
export const SCHED_ABI = parseAbi([
  "event SendScheduled(uint256 indexed id, bytes32 indexed orderId, address indexed recipient, address sender, uint256 amount, uint64 unlockAt, uint64 reclaimAt)",
  "event Released(uint256 indexed id, bytes32 indexed orderId, address indexed recipient, uint256 netAmount, uint256 feeAmount)",
  "event Reclaimed(uint256 indexed id, address indexed sender, uint256 amount)",
  "function release(uint256 id) external",
]);

export const NAMES_ADDRESS = (process.env.NAMES_ADDRESS ??
  "0x244e0c8bE1Ed59636901F98920413d414B158cc5") as `0x${string}`;

export const NAMES_ABI = parseAbi([
  "event NameRegistered(string name, uint256 indexed tokenId, address indexed holder, uint256 pricePaid)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "function resolve(string label) view returns (address)",
]);

export const SPLIT_ADDRESS = (process.env.SPLIT_ADDRESS ??
  "0x12F21A2AC582061598445874c6C5f4F3bcE53eCF") as `0x${string}`;

export const SPLIT_ABI = parseAbi([
  "event SplitPaid(uint256 indexed splitId, bytes32 indexed orderId, address indexed payer, uint256 grossAmount, uint256 feeAmount)",
]);
