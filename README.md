# ArbScan

Read-only crypto arbitrage scanner for **Binance, Bybit, OKX, Bitget, MEXC, Gate, KuCoin, HTX**.
No API keys, no trading — public market data only.

## What it finds
- **Triangular** (same exchange): `USDT → A → B → USDT`, after 3 taker fees, with top-of-book size.
- **Exchange ↔ exchange**: buy where the ask is lowest, sell where the bid is highest (taker fees on both sides; withdrawal fees not included).
- **Funding rate**:
  - cash & carry on one exchange (long spot + short perpetual),
  - cross-exchange funding spread (short the high-funding perp, long the low one),
  - fees, break-even days and net result for a chosen holding period.
- **Fees tab**: editable spot/futures taker fees per exchange (stored in your browser).

## Structure
- `lib/exchanges.js` — exchange adapters (public REST endpoints), normalised to one format.
- `api/spot.js?ex=binance` — top-of-book bid/ask for all active spot markets.
- `api/funding.js?ex=binance` — USDT perpetual funding rates.
- `api/health.js` — which exchanges respond from the server region.
- `arb.js` — arbitrage maths (shared by browser and tests). `npm test` runs `test/arb.test.mjs`.
- `index.html`, `app.js`, `style.css` — dashboard.

Serverless functions run in `fra1` (Frankfurt) because several exchanges block US IPs.

## Caveats
Opportunities shown are snapshots of the best bid/ask. Real fills depend on order-book depth, latency,
deposit/withdrawal status, networks and fee tier. This is not financial advice.
