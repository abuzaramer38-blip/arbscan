// Hourly PAPER trading bot (no real money, no API keys).
// Runs on GitHub Actions; market data comes from our Vercel API (Frankfurt), because several exchanges block US servers.
//
// Wallet 1 "funding": $100. Buys spot + shorts the perpetual on the same exchange (price risk cancels out),
//   collects the funding the exchange REALLY paid (from its history), switches coin only when it clearly pays off.
// Wallet 2 "instant": $100 split $50/$50 across two exchanges. Each hour, if the real order book allows buying on one
//   exchange and selling on another at a profit right now, it books that trade (max one per hour). The coin then sits
//   on the buying exchange, so that coin can only trade again in the reverse direction (which brings it back).
//
// usage: node scripts/paper-bot.mjs <state.json> <report.md>
import fs from "node:fs";

const API = process.env.ARBSCAN_URL || "https://arbscan-a2fl.vercel.app";
const [, , STATE = "state.json", REPORT = "report.md"] = process.argv;
const H = 3600000;
const EXS = ["binance", "bybit", "okx", "bitget", "mexc", "gate", "kucoin", "htx"];
const SPOT_FEE = { binance: 0.1, bybit: 0.1, okx: 0.1, bitget: 0.1, mexc: 0.05, gate: 0.1, kucoin: 0.1, htx: 0.2 };
const FUT_FEE = { binance: 0.05, bybit: 0.055, okx: 0.05, bitget: 0.06, mexc: 0.02, gate: 0.05, kucoin: 0.06, htx: 0.05 };
const PERP_SPREAD = 0.05;
const MIN_VOL = 1e6;        // only coins with >= $1M spot volume a day
const MAX_DAILY = 1;        // skip squeeze coins (> 1% a day)
const STABLE = 0.8;         // >= 80% of last-24h payments in our favour
const DECIDE_EVERY = 8 * H;
const INSTANT_MIN = 0.05;   // $ minimum profit to bother

const now = Date.now();
const iso = (t) => new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC";
async function get(path, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(API + path, { headers: { "user-agent": "arbscan-paper-bot" } });
      const j = await r.json();
      if (j.ok) return j;
      if (i === tries - 1) throw new Error(j.error || "not ok");
    } catch (e) {
      if (i === tries - 1) throw e;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch { out[k] = null; } }
  }));
  return out;
}

let S;
try { S = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { S = null; }
if (!S || !S.started) {
  S = {
    started: now, runs: 0, errors: [],
    funding: { capital: 100, earned: 0, costs: 0, pos: null, lastDecision: 0, log: [] },
    instant: { capital: 100, profit: 0, trades: [], taken: {}, checks: 0, seen: 0 },
  };
}
S.runs++;
S.lastRun = now;

// ------------------------------------------------------------------ wallet 1: funding
async function fundingStep() {
  const F = S.funding;
  const half = F.capital / 2;
  // credit what the held position really received since last time
  if (F.pos) {
    const h = await get(`/api/history?ex=${F.pos.ex}&sym=${encodeURIComponent(F.pos.sym)}`);
    const rows = h.rows.filter((r) => r.t > F.pos.creditedTo && r.t <= now);
    const got = rows.reduce((t, r) => t + r.rate, 0) * half;
    if (rows.length) {
      F.earned += got;
      F.pos.earned += got;
      F.pos.payments += rows.length;
      F.pos.creditedTo = Math.max(...rows.map((r) => r.t));
    }
  }
  const due = now - F.lastDecision >= DECIDE_EVERY;
  // score helper: what this coin paid over the last 24h (% per day), only past data
  const scoreOf = (rows, rateNow, ivh) => {
    const r24 = rows.filter((r) => r.t > now - 24 * H && r.t <= now);
    if (r24.length < 2) return null;
    const avg = r24.reduce((t, r) => t + r.rate, 0) * 100; // % over 24h
    const nowDaily = rateNow * (24 / ivh) * 100;
    const good = r24.filter((r) => r.rate > 0).length / r24.length;
    return { daily: Math.min(avg, nowDaily), good, avg };
  };
  let heldScore = null;
  if (F.pos) {
    const h = await get(`/api/history?ex=${F.pos.ex}&sym=${encodeURIComponent(F.pos.sym)}`);
    const rows = h.rows;
    const iv = F.pos.ivh;
    const last = rows[0]?.rate ?? 0;
    heldScore = scoreOf(rows, last, iv);
  }
  if (!due && !(F.pos && heldScore && heldScore.avg <= 0)) return;
  F.lastDecision = now;

  // candidates: positive funding now, liquid spot on the same exchange
  const [futs, spots] = await Promise.all([
    pool(EXS, 8, (ex) => get(`/api/funding?ex=${ex}`)),
    pool(EXS, 8, (ex) => get(`/api/spot?ex=${ex}`)),
  ]);
  const cands = [];
  EXS.forEach((ex, i) => {
    if (!futs[i] || !spots[i]) return;
    const spot = new Map(spots[i].markets.filter((m) => m[1] === "USDT").map((m) => [m[0], m]));
    for (const [base, rate, ivh, , , sym] of futs[i].rows) {
      const m = spot.get(base);
      if (!m || !(rate > 0) || !(m[6] >= MIN_VOL)) continue;
      const daily = rate * (24 / (ivh || 8)) * 100;
      if (daily > MAX_DAILY) continue;
      const spr = ((m[3] - m[2]) / ((m[3] + m[2]) / 2)) * 100;
      cands.push({ ex, base, sym, rate, ivh: ivh || 8, daily, spr });
    }
  });
  cands.sort((a, b) => b.daily - a.daily);
  const top = cands.slice(0, 25);
  const hist = await pool(top, 8, (c) => get(`/api/history?ex=${c.ex}&sym=${encodeURIComponent(c.sym)}`));
  let best = null;
  top.forEach((c, i) => {
    if (!hist[i]) return;
    const sc = scoreOf(hist[i].rows, c.rate, c.ivh);
    if (!sc || sc.good < STABLE || sc.daily <= 0 || sc.avg > MAX_DAILY) return;
    const cost = half * (2 * SPOT_FEE[c.ex] + 2 * FUT_FEE[c.ex] + c.spr + PERP_SPREAD) / 100;
    const v = { ...c, score: sc.daily, cost };
    if (!best || v.score > best.score) best = v;
  });
  const exp3 = (sc) => (sc / 100) * half * 3; // what 3 days at this rate would pay
  const close = (why) => {
    F.costs += F.pos.cost / 2;
    F.log.push({ t: iso(now), action: "SELL", what: `${F.pos.base} on ${F.pos.ex}`, why, earned: +F.pos.earned.toFixed(4), payments: F.pos.payments });
    F.pos = null;
  };
  if (F.pos) {
    const cur = heldScore ? heldScore.daily : -1;
    if (cur <= 0) close("funding turned negative");
    else if (best && best.base + best.ex !== F.pos.base + F.pos.ex && exp3(best.score) - exp3(cur) > F.pos.cost / 2 + best.cost) close(`better: ${best.base} on ${best.ex}`);
  }
  if (!F.pos && best && exp3(best.score) > best.cost) {
    F.costs += best.cost / 2;
    F.pos = { ex: best.ex, base: best.base, sym: best.sym, ivh: best.ivh, cost: best.cost, openedAt: now, creditedTo: now, earned: 0, payments: 0, scoreAtOpen: +best.score.toFixed(4) };
    F.log.push({ t: iso(now), action: "BUY", what: `${best.base} on ${best.ex}`, why: `paid ${best.score.toFixed(3)}%/day last 24h, cost $${best.cost.toFixed(3)}` });
  } else if (!F.pos) {
    F.log.push({ t: iso(now), action: "WAIT", what: "-", why: best ? `best ${best.base}/${best.ex} would not cover its costs in 3 days` : "no stable coin" });
  }
  if (F.log.length > 300) F.log = F.log.slice(-300);
}

// ------------------------------------------------------------------ wallet 2: instant buy & sell
async function instantStep() {
  const I = S.instant;
  const j = await get(`/api/instant?capital=${I.capital}`);
  I.checks++;
  // inventory: after buying on X and selling on Y, the coin sits on X and the USDT on Y.
  // The same trade can only happen again after the opposite trade (buy on Y, sell on X) has moved things back.
  if (!I.stuck) { // rebuild from past trades (older state files)
    I.stuck = {};
    for (const t of I.trades) { if (I.stuck[t.coin]) delete I.stuck[t.coin]; else I.stuck[t.coin] = { buy: t.buy, sell: t.sell, since: now }; }
  }
  const rows = (j.cross?.rows || []).filter((r) => r.realProfit != null && r.realProfit >= INSTANT_MIN);
  I.seen += rows.length ? 1 : 0;
  const allowed = (r) => {
    const st = I.stuck[r.coin];
    if (!st) return true;
    return r.buy === st.sell && r.sell === st.buy; // the reverse trade rebalances
  };
  const pick = rows.find(allowed);
  if (pick) {
    const st = I.stuck[pick.coin];
    if (st) delete I.stuck[pick.coin];
    else I.stuck[pick.coin] = { buy: pick.buy, sell: pick.sell, since: now };
    I.profit += pick.realProfit;
    I.trades.push({ t: iso(now), coin: pick.coin, buy: pick.buy, sell: pick.sell, size: pick.atSize, profit: pick.realProfit, gapPct: pick.topOfBookPct, rebalanced: !!st });
    if (I.trades.length > 500) I.trades = I.trades.slice(-500);
  }
}

for (const [name, fn] of [["funding", fundingStep], ["instant", instantStep]]) {
  try { await fn(); } catch (e) { S.errors.push({ t: iso(now), where: name, error: String(e.message || e).slice(0, 200) }); }
}
if (S.errors.length > 50) S.errors = S.errors.slice(-50);
fs.writeFileSync(STATE, JSON.stringify(S, null, 1));

// ------------------------------------------------------------------ report
const F = S.funding, I = S.instant;
const fNet = F.earned - F.costs - (F.pos ? F.pos.cost / 2 : 0); // as if we closed now
const days = (now - S.started) / (24 * H);
const lines = [
  `# Paper bot report`,
  ``,
  `Running since **${iso(S.started)}** (${days.toFixed(2)} days, ${S.runs} hourly runs). Last run ${iso(now)}. No real money.`,
  ``,
  `| Wallet | Start | Now (if closed now) | Profit |`,
  `|---|---|---|---|`,
  `| Funding (spot + short) | $${F.capital} | $${(F.capital + fNet).toFixed(2)} | ${fNet >= 0 ? "+" : "−"}$${Math.abs(fNet).toFixed(2)} |`,
  `| Instant buy & sell | $${I.capital} | $${(I.capital + I.profit).toFixed(2)} | +$${I.profit.toFixed(2)} |`,
  ``,
  `**Funding wallet**: funding received $${F.earned.toFixed(3)}, fees+spread paid $${F.costs.toFixed(3)}${F.pos ? `, holding **${F.pos.base} on ${F.pos.ex}** since ${iso(F.pos.openedAt)} (${F.pos.payments} payments, $${F.pos.earned.toFixed(3)})` : ", not holding anything"}.`,
  ``,
  `**Instant wallet**: ${I.trades.length} trades in ${I.checks} checks; a profitable gap existed in ${I.seen} of ${I.checks} checks. Assumes the coin was already sitting on the selling exchange; a coin can't be traded the same way again until the reverse trade brings it back. Stuck now: ${Object.keys(I.stuck || {}).join(", ") || "none"}.`,
  ``,
  `## Funding wallet actions (last 15)`,
  ...F.log.filter((x) => x.action !== "WAIT").slice(-15).map((x) => `- ${x.t} **${x.action}** ${x.what} — ${x.why}${x.earned != null ? ` (earned $${x.earned}, ${x.payments} payments)` : ""}`),
  ``,
  `## Instant trades (last 15)`,
  ...I.trades.slice(-15).map((x) => `- ${x.t} ${x.coin}: buy ${x.buy}, sell ${x.sell}, $${x.size} → +$${x.profit}`),
  ``,
  S.errors.length ? `Errors (last 3): ${S.errors.slice(-3).map((e) => `${e.t} ${e.where}: ${e.error}`).join(" | ")}` : "No errors.",
];
fs.writeFileSync(REPORT, lines.join("\n") + "\n");
console.log(lines.slice(0, 12).join("\n"));
