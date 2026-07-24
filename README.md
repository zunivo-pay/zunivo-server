# zunivo-server (v0.2) — indexer + orders API

Watches ArcPayRouter's PaymentReceived events, stores orders + payments in
SQLite, marks orders paid when the on-chain amount covers the order
(merchant-verified), and serves the dashboard/receipt API.

## Run
cp .env.example .env      # defaults already point at the deployed router
npm install
npm run dev               # http://localhost:8787

## Endpoints
POST /api/orders                         {merchant, amount, memo} → {id}
GET  /api/orders/:id                     order + payments + status
GET  /api/merchants/:addr/activity       orders for a merchant
GET  /api/merchants/:addr/export.csv     reconciliation CSV
GET  /api/health

## Notes
- Server-issued orders close the link-tampering hole: /pay?oid=… links carry
  no merchant/amount — the pay page fetches them from this server.
- Duplicate/underpaid protection: an order flips to "paid" only when payments
  matching BOTH its orderId hash AND its merchant sum to >= the amount due.
- v0.3 (planned): wallet-signature auth for dashboard/memos, webhooks, email receipts.
