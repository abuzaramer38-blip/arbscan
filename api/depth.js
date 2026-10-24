import { depth } from "../lib/books.js";

export default async function handler(req, res) {
  const ex = String(req.query.ex || "").toLowerCase();
  const base = String(req.query.base || "").replace(/[^A-Za-z0-9]/g, "");
  const quote = String(req.query.quote || "USDT").replace(/[^A-Za-z0-9]/g, "");
  if (!base) return res.status(400).json({ ok: false, error: "base required" });
  const t0 = Date.now();
  try {
    const d = await depth(ex, base, quote);
    res.setHeader("Cache-Control", "s-maxage=3, stale-while-revalidate=5");
    return res.status(200).json({ ok: true, ex, base, quote, ms: Date.now() - t0, ...d });
  } catch (e) {
    return res.status(200).json({ ok: false, ex, base, ms: Date.now() - t0, error: String(e.message || e).slice(0, 300) });
  }
}
