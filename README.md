# zunivo-server — indexer + API

Watches the zunivo contracts on Arc (payments, `.agent` name mints, agent-card
records), stores everything in SQLite, and serves the orders / dashboard /
directory API behind `api.zunivo.io`.

## What it indexes

- `ArcPayRouter` — `PaymentReceived` events → orders flip to **paid** only when
  payments matching BOTH the orderId hash AND the merchant sum to ≥ the amount due.
- `ZunivoNames` — mints/transfers → name ↔ address resolution.
- `ZunivoAgentRecords` — `TextChanged`/`RecordsCleared` → the public agent
  directory (names that published a service endpoint).

## Networks — one switch

`NETWORK=mainnet` or `NETWORK=testnet` in `.env` selects the chain, the contract
set, start blocks, explorer, x402 network id and the SQLite file. Nothing else
needs to change between environments.

| | mainnet | testnet |
|---|---|---|
| Chain | Arc, chainId 5042 (`eip155:5042`) | Arc Testnet, 5042002 (`eip155:5042002`) |
| Contracts | v1.3 (verified on arc.etherscan.io) | original sandbox set |
| DB | `zunivo-mainnet.db` | `zunivo.db` |
| Public URL | `https://api.zunivo.io` | `https://testnet-api.zunivo.io` |
| API keys | `zk_live_…` | `zk_test_…` |

`GET /api/network` tells you which one you're talking to. In production run two
pm2 processes (one per `.env`), never one process for both.

## Run

```bash
cp .env.example .env      # set NETWORK, APP_ORIGIN, API_BASE, X402_DEMO_PAYTO
npm install
npm run dev               # http://localhost:8787
```

## Endpoints

```
POST /api/orders                        {merchant, amount, memo} → {id}
GET  /api/orders/:id                    order + payments + status
GET  /api/merchants/:addr/activity      received orders
GET  /api/merchants/:addr/sent          outgoing payments
GET  /api/merchants/:addr/export.csv    reconciliation CSV
GET  /api/names/:address                .agent names owned by an address
POST /api/names/ingest                  fast-track a mint tx into the index
GET  /api/agents                        public directory (published agent cards)
GET  /api/agents/:label                 one agent's card
POST /api/agents/ingest                 fast-track a setTexts tx
GET  /api/scheduled/:address            scheduled sends touching an address
POST /api/keys                          issue an API key (x402 middleware)
POST /v1/orders · GET /v1/orders/:id    key-authenticated programmatic orders
GET  /api/health                        { ok, network, chainId }
GET  /api/network                       chain + contract addresses this instance serves
GET  /x402/agent-check/:name · /x402/arc-pulse · /x402/crypto10   paid (HTTP 402) services
```

## Notes

- Server-issued orders close the link-tampering hole: `/pay?oid=…` links carry
  no merchant/amount — the pay page fetches them from this server.
- Multi-RPC fallback against Arc's public gateways; ingest endpoints make new
  mints/cards visible in seconds without waiting for the poller.
