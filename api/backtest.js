import { loadUniverse, simulate } from "../lib/backtest.js";

const H = 3600000;
export default async function handler(req, res) {
  const t0 = Date.now();
  const capital = Math.max(1, parseFloat(req.query.capital) || 100);
  try {
    const series = await loadUniverse(parseInt(req.query.top, 10) || 25);
    const end = Math.max(...series.map((s) => s.rows[s.rows.length - 1].t)) + 1;
    // requested start (ms) or 7 days ago; first 24h of data is only used for looking back
    const earliest = Math.min(...series.map((s) => s.rows[0].t));
    const want = parseInt(req.query.start, 10) || end - 7 * 24 * H;
    const start = Math.max(want, earliest + 24 * H);
    const runs = [
      simulate(series, { start, end, capital, strategy: "carry" }),
      simulate(series, { start, end, capital, strategy: "spread" }),
      simulate(series, { start, end, capital, strategy: "spread", maxDaily: 100 }),
    ];
    runs[2].strategy = "spread-aggressive (incl. high-risk coins)";
    const iso = (t) => new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC";
    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=1800");
    return res.status(200).json({
      ok: true, ms: Date.now() - t0, series: series.length, from: iso(start), to: iso(end), capital,
      note: "Funding only. Not included: price gap between legs, liquidation, downtime.",
      results: runs.map((r) => ({ ...r, log: r.log.map((x) => ({ ...x, t: iso(x.t) })), daily: r.daily.map((d) => ({ ...d, from: iso(d.from), to: iso(d.to) })) })),
    });
  } catch (e) {
    return res.status(200).json({ ok: false, ms: Date.now() - t0, error: String(e.message || e).slice(0, 300) });
  }
}
