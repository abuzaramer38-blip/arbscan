import { perps } from "../lib/books.js";

export default async function handler(req, res) {
  const ex = String(req.query.ex || "").toLowerCase();
  const t0 = Date.now();
  try {
    const rows = await perps(ex);
    res.setHeader("Cache-Control", "s-maxage=4, stale-while-revalidate=8");
    return res.status(200).json({ ok: true, ex, ts: Date.now(), ms: Date.now() - t0, count: rows.length, rows });
  } catch (e) {
    return res.status(200).json({ ok: false, ex, ms: Date.now() - t0, error: String(e.message || e).slice(0, 300) });
  }
}
