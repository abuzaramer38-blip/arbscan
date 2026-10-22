import { EXCHANGES } from "../lib/exchanges.js";

// Quick check: which exchanges answer from this server region.
export default async function handler(req, res) {
  const out = {};
  await Promise.all(Object.entries(EXCHANGES).map(async ([name, a]) => {
    const t0 = Date.now();
    const [s, f] = await Promise.allSettled([a.spot(), a.futures()]);
    out[name] = {
      spot: s.status === "fulfilled" ? s.value.length : `ERR ${String(s.reason?.message || s.reason).slice(0, 160)}`,
      futures: f.status === "fulfilled" ? f.value.length : `ERR ${String(f.reason?.message || f.reason).slice(0, 160)}`,
      ms: Date.now() - t0,
    };
  }));
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ region: process.env.VERCEL_REGION || "local", ts: new Date().toISOString(), exchanges: out });
}
