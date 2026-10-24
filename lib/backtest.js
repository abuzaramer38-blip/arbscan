// Walk-forward backtest of a funding bot on REAL funding history (last ~7 days).
// The bot only ever looks at the past 24h when deciding — no peeking at the future.
// Universe = most-traded perpetuals on each exchange (chosen by volume, NOT by funding, to avoid hindsight).
// Not included: price differences between legs (basis), liquidations, exchange downtime.
import { EXCHANGES } from "./exchanges.js";
import { perps } from "./books.js";
import { fundingHistory } from "./history.js";

const H = 3600000;
const SPOT_FEE = { binance: 0.1, bybit: 0.1, okx: 0.1, bitget: 0.1, mexc: 0.05, gate: 0.1, kucoin: 0.1, htx: 0.2 };
const FUT_FEE = { binance: 0.05, bybit: 0.055, okx: 0.05, bitget: 0.06, mexc: 0.02, gate: 0.05, kucoin: 0.06, htx: 0.05 };
const SPREAD = 0.08; // % lost to bid/ask per leg per round trip (liquid coins)
const STABLES = new Set(["USDC", "FDUSD", "TUSD", "DAI", "USDE", "USD1", "BUSD", "PYUSD"]);

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k]); } catch { out[k] = null; }
    }
  }));
  return out;
}

export async function loadUniverse(topPerEx = 25) {
  const exs = Object.keys(EXCHANGES);
  const lists = await Promise.all(exs.map(async (ex) => {
    try {
      const [p, f] = await Promise.all([perps(ex), EXCHANGES[ex].futures()]);
      const symOf = new Map(f.map((r) => [r[0], r[5]]));
      return p.filter((r) => !STABLES.has(r[0]) && symOf.has(r[0]))
        .sort((a, b) => b[5] - a[5]).slice(0, topPerEx).map((r) => ({ ex, base: r[0], sym: symOf.get(r[0]) }));
    } catch {
      return [];
    }
  }));
  const items = lists.flat();
  const hist = await pool(items, 16, (it) => fundingHistory(it.ex, it.sym));
  return items.map((it, k) => ({ ...it, rows: (hist[k] || []).slice().sort((a, b) => a.t - b.t) }))
    .filter((s) => s.rows.length >= 3);
}

const sumIn = (rows, a, b) => rows.reduce((t, r) => (r.t > a && r.t <= b ? t + r.rate : t), 0);
const cntIn = (rows, a, b) => rows.filter((r) => r.t > a && r.t <= b);

/**
 * strategy: "carry" (spot long + perp short on one exchange) or "spread" (short high-funding perp, long low one).
 * capital split: position = capital/2 (other half is spot/margin).
 */
export function simulate(series, { start, end, capital = 100, step = 8 * H, look = 24 * H, strategy = "carry", maxDaily = 1, minPos = 0.8 }) {
  const pos = capital / 2;
  // candidates
  let cands = [];
  if (strategy === "carry") {
    cands = series.map((s) => ({
      id: `${s.base}@${s.ex}`, label: `${s.base} on ${s.ex} (spot + short)`, legs: [{ s, sign: 1 }],
      cost: pos * (2 * (SPOT_FEE[s.ex] + FUT_FEE[s.ex]) + 2 * SPREAD) / 100,
    }));
  } else {
    const by = new Map();
    for (const s of series) { if (!by.has(s.base)) by.set(s.base, []); by.get(s.base).push(s); }
    for (const [base, list] of by) {
      for (const a of list) for (const b of list) {
        if (a.ex === b.ex) continue;
        cands.push({
          id: `${base}:${a.ex}>${b.ex}`, label: `${base}: short ${a.ex}, long ${b.ex}`, legs: [{ s: a, sign: 1 }, { s: b, sign: -1 }],
          cost: pos * (2 * (FUT_FEE[a.ex] + FUT_FEE[b.ex]) + 2 * SPREAD) / 100,
        });
      }
    }
  }
  // score = funding we'd have received over the lookback (% of position per day), only from data before `t`
  const score = (c, t) => {
    let tot = 0;
    for (const { s, sign } of c.legs) {
      const r = cntIn(s.rows, t - look, t);
      if (r.length < 2 || s.rows[0].t > t - look * 0.8) return null; // not enough past data
      if (Math.abs(r.reduce((x, y) => x + y.rate, 0)) * 100 * (24 * H / look) > maxDaily) return null; // squeeze coin
      tot += sign * r.reduce((x, y) => x + y.rate, 0);
    }
    // stability: share of payments (of the receiving leg) that went our way
    const main = c.legs[0];
    const r0 = cntIn(main.s.rows, t - look, t);
    const good = r0.filter((x) => main.sign * x.rate > 0).length / r0.length;
    if (strategy === "carry" && good < minPos) return null;
    return tot * 100 * (24 * H / look);
  };
  let cash = capital, held = null, heldScore = 0, earnedTotal = 0, costTotal = 0;
  const log = [];
  const daily = [];
  let dayStart = start, dayEarn = 0, dayCost = 0;
  for (let t = start; t < end; t += step) {
    // decide
    let best = null, bestScore = -Infinity;
    for (const c of cands) {
      const sc = score(c, t);
      if (sc != null && sc > bestScore) { best = c; bestScore = sc; }
    }
    const curScore = held ? (score(held, t) ?? -Infinity) : -Infinity;
    const worthSwitch = best && bestScore > 0 && (!held || (best.id !== held.id && (bestScore - curScore) / 100 * pos > held.cost + best.cost) || curScore <= 0);
    if (held && (curScore <= 0 || (worthSwitch && best.id !== held.id))) {
      costTotal += held.cost / 2; dayCost += held.cost / 2;
      log.push({ t, action: "close", label: held.label });
      held = null;
    }
    if (!held && best && bestScore > 0) {
      held = best; heldScore = bestScore;
      costTotal += best.cost / 2; dayCost += best.cost / 2;
      log.push({ t, action: "open", label: best.label, score: +bestScore.toFixed(3) });
    }
    // earn until next step
    const t2 = Math.min(t + step, end);
    if (held) {
      let e = 0;
      for (const { s, sign } of held.legs) e += sign * sumIn(s.rows, t, t2) * pos;
      earnedTotal += e; dayEarn += e;
    }
    if (t2 - dayStart >= 24 * H || t2 >= end) {
      daily.push({ from: dayStart, to: t2, earned: +dayEarn.toFixed(3), costs: +dayCost.toFixed(3) });
      dayStart = t2; dayEarn = 0; dayCost = 0;
    }
  }
  if (held) { costTotal += held.cost / 2; log.push({ t: end, action: "close", label: held.label }); }
  cash = capital + earnedTotal - costTotal;
  return { strategy, capital, final: +cash.toFixed(2), earned: +earnedTotal.toFixed(3), costs: +costTotal.toFixed(3), trades: log.filter((x) => x.action === "open").length, log, daily };
}
