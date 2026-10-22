import { EXCHANGES } from "../lib/exchanges.js";

export default async function handler(req, res) {
  const ex = String(req.query.ex || "").toLowerCase();
  const adapter = EXCHANGES[ex];
  if (!adapter) return res.status(400).json({ ok: false, error: `unknown exchange: ${ex}` });
  const t0 = Date.now();
  try {
    const markets = await adapter.spot();
    res.setHeader("Cache-Control", "s-maxage=4, stale-while-revalidate=8");
    return res.status(200).json({ ok: true, ex, ts: Date.now(), ms: Date.now() - t0, count: markets.length, markets });
  } catch (e) {
    return res.status(200).json({ ok: false, ex, ms: Date.now() - t0, error: String(e.message || e).slice(0, 300) });
  }
}
