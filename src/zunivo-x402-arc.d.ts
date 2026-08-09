/** Minimal typings for zunivo-x402-arc (JS package) — just the surface we use. */
declare module "zunivo-x402-arc" {
  import type { RequestHandler } from "express";

  export interface X402SettleAdapter {
    quote?(price: string, payTo: string, memo: string): Promise<{ id: string; payUrl: string; to?: string }>;
    verify(payload: any, accept: any): Promise<{
      settled: boolean; status?: string; reason?: string; amount?: string; to?: string; txHash?: string | null;
    }>;
  }

  export interface X402ConsumedStore {
    reserve?(key: string): Promise<boolean>;
    has(key: string): Promise<boolean>;
    add(key: string): Promise<void>;
  }

  export function paymentRequired(opts: {
    price: string | number;
    payTo: string;
    zunivoApi?: string;
    zunivoKey?: string;
    description?: string;
    verify?: X402SettleAdapter;
    resource?: string;
    consumedStore?: X402ConsumedStore;
    network?: "arc" | "arc-testnet" | "eip155:5042002";
  }): RequestHandler;
}
