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

## Run

```bash
cp .env.example .env      # defaults point at the deployed contracts
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
GET  /api/health
```

## Notes

- Server-issued orders close the link-tampering hole: `/pay?oid=…` links carry
  no merchant/amount — the pay page fetches them from this server.
- Multi-RPC fallback against Arc's public gateways; ingest endpoints make new
  mints/cards visible in seconds without waiting for the poller.
