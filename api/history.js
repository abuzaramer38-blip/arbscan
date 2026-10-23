import { fundingHistory } from "../lib/history.js";

export default async function handler(req, res) {
  const ex = String(req.query.ex || "").toLowerCase();
  const sym = String(req.query.sym || "").replace(/[^A-Za-z0-9_\-]/g, "");
  if (!sym) return res.status(400).json({ ok: false, error: "sym required" });
  const t0 = Date.now();
  try {
    const rows = await fundingHistory(ex, sym);
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=1200");
    return res.status(200).json({ ok: true, ex, sym, ms: Date.now() - t0, count: rows.length, rows });
  } catch (e) {
    return res.status(200).json({ ok: false, ex, sym, ms: Date.now() - t0, error: String(e.message || e).slice(0, 300) });
  }
}
