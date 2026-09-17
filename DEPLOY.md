# Mainnet cut-over runbook (app / server / SDK)

Target state:

| Host | Serves | Source |
|---|---|---|
| `app.zunivo.io` | **Arc mainnet** app | Vercel project `zunivo-app`, `VITE_NETWORK=mainnet` |
| `testnet.zunivo.io` | Arc testnet sandbox app | Vercel project `zunivo-app-testnet`, `VITE_NETWORK=testnet` |
| `api.zunivo.io` | **Arc mainnet** API + indexer | pm2 `zunivo-mainnet`, port 8787, `zunivo-mainnet.db` |
| `testnet-api.zunivo.io` | Arc testnet API + indexer | pm2 `zunivo-testnet`, port 8788, `zunivo.db` (the existing DB) |

Order matters: **SDK → server → app → DNS → verify → Marketplace**.

## 0. Prerequisites (one-time)

- `zunivo-x402-arc@1.0.0` published to npm (`npm publish` in `x402-020`). The server's `npm install` needs it.
- A **mainnet payout wallet** for the paid x402 services (`X402_DEMO_PAYTO`) — real USDC lands here.
- Optional: a **keeper wallet** funded with a little mainnet USDC (`KEEPER_PK`) if auto-release of scheduled sends should run on mainnet.
- DNS access for `zunivo.io`; Vercel access; VPS shell.

## 1. Server (VPS)

```bash
cd /path/to/zunivo-server
git pull
npm install                      # pulls zunivo-x402-arc 1.0.0
mkdir -p logs
```

Create the two env files (never commit them):

`.env.mainnet`
```
NETWORK=mainnet
PORT=8787
APP_ORIGIN=https://app.zunivo.io
API_BASE=https://api.zunivo.io
X402_DEMO_PAYTO=0x<mainnet payout wallet>
# RPC_URL=https://<dedicated mainnet rpc>      # strongly recommended
# KEEPER_PK=0x<keeper key with mainnet USDC>   # optional
```

`.env.testnet`
```
NETWORK=testnet
PORT=8788
APP_ORIGIN=https://testnet.zunivo.io
API_BASE=https://testnet-api.zunivo.io
DB_PATH=zunivo.db
X402_DEMO_PAYTO=0x<the testnet payout wallet you use today>
# KEEPER_PK=...                                # the existing testnet keeper key, if any
```

Copy any other values from the old `.env` (it was testnet) into `.env.testnet`. Then:

```bash
pm2 delete zunivo-server 2>/dev/null || true     # old single-instance name, if that's what it was called
pm2 start ecosystem.config.cjs
pm2 save
pm2 logs --lines 20
```

Expected first lines: `[zunivo-server] mainnet (chainId 5042) http://localhost:8787` and `[zunivo-server] testnet (chainId 5042002) http://localhost:8788`, with the indexer on mainnet starting from block 21240365.

Reverse proxy — add a second vhost (nginx shown; adapt for Caddy):

```
server { server_name api.zunivo.io;         location / { proxy_pass http://127.0.0.1:8787; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto https; } }
server { server_name testnet-api.zunivo.io; location / { proxy_pass http://127.0.0.1:8788; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto https; } }
```

Issue a certificate for `testnet-api.zunivo.io` (certbot / Caddy auto).

## 2. DNS

- `testnet-api.zunivo.io` → A record → VPS IP
- `testnet.zunivo.io` → CNAME → `cname.vercel-dns.com` (Vercel will show the exact value)

## 3. App (Vercel)

**Existing project (app.zunivo.io) → mainnet.** In Project → Settings → Environment Variables:

- set `VITE_NETWORK=mainnet`
- set `VITE_API_URL=https://api.zunivo.io`
- **delete** `VITE_NAMES_ADDRESS`, `VITE_RECORDS_ADDRESS`, `VITE_ROUTER_ADDRESS`, `VITE_SCHED_ADDRESS`, `VITE_NAMES_DEPLOY_BLOCK` if present — they would pin testnet addresses over the mainnet defaults
- set `VITE_CIRCLE_CLIENT_KEY` to **empty** until Circle issues a live key (a `TEST_` key is refused on mainnet builds → pay page shows "coming soon")
- keep `VITE_WC_PROJECT_ID`, `VITE_ENABLE_WC=1`
- optional `VITE_RPC_URL=<dedicated mainnet rpc>`

Redeploy (push of the commit does it).

**New project (testnet.zunivo.io) → sandbox.** Import the same GitHub repo as `zunivo-app-testnet`:

- `VITE_NETWORK=testnet`, `VITE_API_URL=https://testnet-api.zunivo.io`
- `VITE_CIRCLE_CLIENT_KEY=<the TEST_ key>`, `VITE_CIRCLE_CLIENT_URL=https://modular-sdk.circle.com/v1/rpc/w3s/buidl`
- `VITE_WC_PROJECT_ID`, `VITE_ENABLE_WC=1`
- Domains → add `testnet.zunivo.io`

## 4. Verify

```bash
curl -s https://api.zunivo.io/api/health            # {"ok":true,"network":"mainnet","chainId":5042}
curl -s https://api.zunivo.io/api/network | head -c 300
curl -s https://testnet-api.zunivo.io/api/health    # network testnet, 5042002
curl -s -o /dev/null -w '%{http_code}\n' https://api.zunivo.io/x402/arc-pulse   # 402
curl -s https://api.zunivo.io/x402/arc-pulse | grep -o '"network":"[^"]*"'       # "arc" and "eip155:5042"
```

Browser: app.zunivo.io shows the green **Mainnet** badge; testnet.zunivo.io shows the amber **Testnet** badge; each links to the other.

First real product transactions on mainnet (tiny, but real):

```bash
# 1) one paid x402 call through the SDK (0.10 USDC to your own payout wallet)
cd ~/projects/zunivo/x402-020
read -s AGENT_PK && export AGENT_PK
API_URL=https://api.zunivo.io/x402/arc-pulse MAX_PRICE=0.2 npm run example:agent
unset AGENT_PK
```

Then in the app on mainnet: mint one `.agent` name (1 USDC → your treasury), and pay one payment link. Screenshot the receipts — that's the launch-day proof.

## 5. Circle Agent Marketplace

The listed endpoints (`https://api.zunivo.io/x402/...`) now serve **Arc mainnet** and advertise `eip155:5042`. Update the listing's network field / note to Circle that the services moved from `eip155:5042002` to `eip155:5042`; keep the OpenAPI at `/x402/openapi.json`.

## 6. MCP users

`zunivo-mcp@0.2.0` defaults to mainnet. Anyone (including your own `claude_desktop_config.json`) who wants the sandbox adds `"ZUNIVO_NETWORK": "arc-testnet"` to the env block. Publish with `npm publish` in `zunivo-mcp` once the SDK is on npm.

## Rollback

Server: `pm2 stop zunivo-mainnet`; point `api.zunivo.io` at :8788 in the proxy. App: flip `VITE_NETWORK` back to `testnet` in Vercel and redeploy. Contracts are untouched either way.
