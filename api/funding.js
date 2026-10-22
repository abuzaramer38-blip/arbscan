import { EXCHANGES } from "../lib/exchanges.js";

export default async function handler(req, res) {
  const ex = String(req.query.ex || "").toLowerCase();
  const adapter = EXCHANGES[ex];
  if (!adapter) return res.status(400).json({ ok: false, error: `unknown exchange: ${ex}` });
  const t0 = Date.now();
  try {
    const rows = await adapter.futures();
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json({ ok: true, ex, ts: Date.now(), ms: Date.now() - t0, count: rows.length, rows });
  } catch (e) {
    return res.status(200).json({ ok: false, ex, ms: Date.now() - t0, error: String(e.message || e).slice(0, 300) });
  }
}
