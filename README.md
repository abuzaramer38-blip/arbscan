# ArbScan

Read-only crypto arbitrage scanner for **Binance, Bybit, OKX, Bitget, MEXC, Gate, KuCoin, HTX**.
No API keys, no trading — public market data only.

## What it finds
- **Triangular** (same exchange): `USDT → A → B → USDT`, after 3 taker fees, with top-of-book size.
- **Exchange ↔ exchange**: buy where the ask is lowest, sell where the bid is highest (taker fees on both sides; withdrawal fees not included).
- **Honest numbers**: every "You keep" figure is after fees, spread and withdrawal fee, only on the size that fits; funding uses the lower of today's rate and the 3-day average (`api/history.js`).
- **Futures gap** (`api/perps.js`): perp vs perp on two exchanges — long the cheap one, short the expensive one, no transfer.
- **Real order book** (`api/depth.js`): top cross-exchange rows are walked through 20–100 book levels with your amount; best size shown.
- **Instant mode**: cross-exchange with coin + USDT pre-held on both exchanges (no transfer, no withdrawal fee).
- **Paper trades**: track a funding trade in the browser and see the funding actually paid since you started, minus costs.
- **Funding rate**:
  - cash & carry on one exchange (long spot + short perpetual),
  - cross-exchange funding spread (short the high-funding perp, long the low one),
  - fees, break-even days and net result for a chosen holding period.
- **Fees tab**: editable spot/futures taker fees per exchange (stored in your browser).
- **Junk filter**: markets below a minimum 24h USD volume (default $250k, quote volume converted to USD on the
  same exchange) and leveraged tokens (BTC3L, ETHUP, …) are removed; suspicious rows (>5% / size < $10) hidden by default.
- **Investment calculator**: enter an amount (default $100) to see the dollar profit per route, what you get back,
  and whether the best price can absorb the whole amount.

## Structure
- `lib/exchanges.js` — exchange adapters (public REST endpoints), normalised to one format.
- `api/spot.js?ex=binance` — top-of-book bid/ask (+ 24h quote volume) for all active spot markets.
- `api/funding.js?ex=binance` — USDT perpetual funding rates.
- `api/health.js` — which exchanges respond from the server region.
- `arb.js` — arbitrage maths (shared by browser and tests). `npm test` runs `test/arb.test.mjs`.
- `index.html`, `app.js`, `style.css` — dashboard.

Serverless functions run in `fra1` (Frankfurt) because several exchanges block US IPs.

## Caveats
Opportunities shown are snapshots of the best bid/ask. Real fills depend on order-book depth, latency,
deposit/withdrawal status, networks and fee tier. This is not financial advice.

## Paper bot (no real money)
`scripts/paper-bot.mjs` runs every hour on GitHub Actions (`.github/workflows/paper-bot.yml`) and keeps two $100 paper wallets:
funding carry and instant buy-and-sell. State and `REPORT.md` live on the `paper-data` branch; each run's report is also in the
Actions run summary. Data comes from this project's Vercel API (Frankfurt).
