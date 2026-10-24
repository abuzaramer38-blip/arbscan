// Right-now snapshot of "buy and sell immediately" opportunities with money pre-held on both exchanges:
// cross-exchange spot (checked on the real order books), triangular (top of book), perp-vs-perp gap (top of book).
import { EXCHANGES } from "../lib/exchanges.js";
import { perps, depth } from "../lib/books.js";
import { cleanMarkets, crossExchange, triangular, perpGap, bestCrossSize } from "../arb.js";

const SPOT = { binance: 0.1, bybit: 0.1, okx: 0.1, bitget: 0.1, mexc: 0.05, gate: 0.1, kucoin: 0.1, htx: 0.2 };
const FUT = { binance: 0.05, bybit: 0.055, okx: 0.05, bitget: 0.06, mexc: 0.02, gate: 0.05, kucoin: 0.06, htx: 0.05 };

export default async function handler(req, res) {
  const t0 = Date.now();
  const capital = Math.max(1, parseFloat(req.query.capital) || 100);
  const side = capital / 2; // half on each exchange
  const minVol = parseFloat(req.query.minvol) || 50000;
  const exs = Object.keys(EXCHANGES);
  try {
    const [spots, pps] = await Promise.all([
      Promise.all(exs.map((ex) => EXCHANGES[ex].spot().catch(() => null))),
      Promise.all(exs.map((ex) => perps(ex).catch(() => null))),
    ]);
    const clean = {}, perpBy = {};
    exs.forEach((ex, i) => { if (spots[i]) clean[ex] = cleanMarkets(spots[i], minVol, true); if (pps[i]) perpBy[ex] = pps[i]; });

    // 1) cross-exchange spot, verified on order books
    const cand = crossExchange(clean, SPOT, "USDT", 0, 400).filter((r) => r.pct <= 3).slice(0, 15);
    const checked = await Promise.all(cand.map(async (r) => {
      try {
        const [A, B] = await Promise.all([depth(r.buyEx, r.base), depth(r.sellEx, r.base)]);
        const best = bestCrossSize(A.asks, B.bids, side, SPOT[r.buyEx], SPOT[r.sellEx], 0);
        return { coin: r.base, buy: r.buyEx, sell: r.sellEx, topOfBookPct: +r.pct.toFixed(3), realProfit: +best.profit.toFixed(3), atSize: +best.spent.toFixed(2) };
      } catch {
        return { coin: r.base, buy: r.buyEx, sell: r.sellEx, topOfBookPct: +r.pct.toFixed(3), realProfit: null, error: "book not available" };
      }
    }));
    checked.sort((a, b) => (b.realProfit ?? -1e9) - (a.realProfit ?? -1e9));

    // 2) triangular, top of book, only on what fits
    const tri = [];
    for (const ex of Object.keys(clean)) {
      for (const r of triangular(clean[ex], SPOT[ex], ["USDT"], 0, 20)) {
        if (r.pct > 2 || r.maxStart == null) continue;
        const used = Math.min(capital, r.maxStart);
        tri.push({ ex, route: r.path, pct: +r.pct.toFixed(3), profit: +(used * r.pct / 100).toFixed(3), atSize: +used.toFixed(2) });
      }
    }
    tri.sort((a, b) => b.profit - a.profit);

    // 3) perp vs perp gap (closes later when prices meet; profit after 4 fees + spreads)
    const pg = perpGap(perpBy, FUT, 0, 200, minVol).filter((r) => r.pct <= 3 && r.maxUsd != null)
      .map((r) => ({ coin: r.base, long: r.longEx, short: r.shortEx, pct: +r.pct.toFixed(3), profit: +(Math.min(side, r.maxUsd) * r.pct / 100).toFixed(3), atSize: +Math.min(side, r.maxUsd).toFixed(2) }))
      .sort((a, b) => b.profit - a.profit);

    res.setHeader("Cache-Control", "s-maxage=5, stale-while-revalidate=10");
    return res.status(200).json({
      ok: true, at: new Date().toISOString(), ms: Date.now() - t0, capital, perSide: side,
      exchanges: { spot: Object.keys(clean), perps: Object.keys(perpBy) },
      cross: { positive: checked.filter((x) => x.realProfit > 0).length, rows: checked },
      triangular: { positive: tri.length, rows: tri.slice(0, 10) },
      perpGap: { positive: pg.length, rows: pg.slice(0, 10) },
    });
  } catch (e) {
    return res.status(200).json({ ok: false, ms: Date.now() - t0, error: String(e.message || e).slice(0, 300) });
  }
}
