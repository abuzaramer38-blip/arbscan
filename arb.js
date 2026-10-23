// Arbitrage math. Pure functions, used by the browser (app.js) and by tests (node).
// market row: [base, quote, bid, ask, bidQty, askQty, quoteVolume24h]
// fee values are in PERCENT (0.1 = 0.1%).

const SUSPICIOUS_PCT = 5;
const STABLES = new Set(["USDT", "USDC", "USD", "FDUSD", "TUSD", "USD1", "RLUSD", "DAI", "USDE", "PYUSD", "BUSD"]);
const LEVERAGED = /^(.+?)(\d+[LS]|UP|DOWN|BULL|BEAR)$/;

/** Price of each quote currency in USD, from the same exchange's markets. */
export function quoteUsdMap(markets) {
  const mid = new Map();
  for (const [b, q, bid, ask] of markets) mid.set(`${b}/${q}`, (bid + ask) / 2);
  const quotes = new Set(markets.map((m) => m[1]));
  const out = { USDT: 1 };
  for (const q of quotes) {
    if (q === "USDT") continue;
    if (mid.has(`${q}/USDT`)) out[q] = mid.get(`${q}/USDT`);
    else if (mid.has(`USDT/${q}`)) out[q] = 1 / mid.get(`USDT/${q}`);
    else if (mid.has(`${q}/USDC`)) out[q] = mid.get(`${q}/USDC`);
    else if (STABLES.has(q)) out[q] = 1;
  }
  return out;
}

/** Remove junk: leveraged tokens and markets with 24h volume below minVolUsd. Adds usd volume as index 7. */
export function cleanMarkets(markets, minVolUsd = 0, dropLeveraged = true) {
  const qUsd = quoteUsdMap(markets);
  const bases = new Set(markets.map((m) => m[0]));
  const out = [];
  for (const m of markets) {
    if (dropLeveraged) {
      const lv = m[0].match(LEVERAGED);
      if (lv && bases.has(lv[1])) continue;
    }
    const usdVol = (m[6] || 0) * (qUsd[m[1]] || 0);
    if (minVolUsd > 0 && !(usdVol >= minVolUsd)) continue;
    out.push([m[0], m[1], m[2], m[3], m[4], m[5], m[6] || 0, usdVol]);
  }
  return out;
}

/** Triangular arbitrage on ONE exchange: start -> A -> B -> start. */
export function triangular(markets, feePct, starts = ["USDT"], minPct = -0.5, limit = 200) {
  const f = 1 - feePct / 100;
  // edges: from -> [{to, rate, cap (in 'from' units, or null), sym, side, px}]
  const g = new Map();
  const add = (from, e) => {
    if (!g.has(from)) g.set(from, []);
    g.get(from).push(e);
  };
  for (const [b, q, bid, ask, bq, aq, , vol] of markets) {
    // buy base with quote at ask
    add(q, { to: b, rate: (1 / ask) * f, cap: aq > 0 ? aq * ask : null, sym: `${b}/${q}`, side: "BUY", px: ask, vol });
    // sell base for quote at bid
    add(b, { to: q, rate: bid * f, cap: bq > 0 ? bq : null, sym: `${b}/${q}`, side: "SELL", px: bid, vol });
  }
  const out = [];
  for (const S of starts) {
    const first = g.get(S) || [];
    for (const e1 of first) {
      const A = e1.to;
      for (const e2 of g.get(A) || []) {
        const B = e2.to;
        if (B === S || B === A) continue;
        for (const e3 of g.get(B) || []) {
          if (e3.to !== S) continue;
          const r = e1.rate * e2.rate * e3.rate;
          const pct = (r - 1) * 100;
          if (pct < minPct) continue;
          // capacity in start currency: each leg's capacity divided by cumulative rate before it
          const caps = [e1.cap, e2.cap == null ? null : e2.cap / e1.rate, e3.cap == null ? null : e3.cap / (e1.rate * e2.rate)];
          const known = caps.filter((c) => c != null);
          const maxStart = known.length === 3 ? Math.min(...known) : null;
          out.push({
            path: `${S} → ${A} → ${B} → ${S}`,
            legs: [e1, e2, e3].map((e) => `${e.side} ${e.sym} @ ${fmtPx(e.px)}`),
            pct, maxStart, start: S,
            minVol: Math.min(e1.vol ?? Infinity, e2.vol ?? Infinity, e3.vol ?? Infinity),
            suspicious: pct > SUSPICIOUS_PCT,
          });
        }
      }
    }
  }
  out.sort((a, b) => b.pct - a.pct);
  return out.slice(0, limit);
}

/** Cross-exchange: buy on X (ask), sell on Y (bid). spotByEx: {ex: markets}. fees: {ex: takerPct} */
export function crossExchange(spotByEx, fees, quote = "USDT", minPct = -0.2, limit = 300) {
  const book = new Map(); // base -> [{ex, bid, ask, bq, aq}]
  for (const [ex, mk] of Object.entries(spotByEx)) {
    for (const [b, q, bid, ask, bq, aq, , vol] of mk) {
      if (q !== quote) continue;
      if (!book.has(b)) book.set(b, []);
      book.get(b).push({ ex, bid, ask, bq, aq, vol });
    }
  }
  const out = [];
  for (const [base, quotes] of book) {
    if (quotes.length < 2) continue;
    for (const buy of quotes) {
      for (const sell of quotes) {
        if (buy.ex === sell.ex) continue;
        const fb = 1 - (fees[buy.ex] ?? 0.1) / 100;
        const fs = 1 - (fees[sell.ex] ?? 0.1) / 100;
        const pct = ((sell.bid * fs * fb) / buy.ask - 1) * 100;
        if (pct < minPct) continue;
        const qty = Math.min(buy.aq || Infinity, sell.bq || Infinity);
        out.push({
          base, buyEx: buy.ex, sellEx: sell.ex, buy: buy.ask, sell: sell.bid,
          gross: (sell.bid / buy.ask - 1) * 100, pct,
          maxUsd: Number.isFinite(qty) ? qty * buy.ask : null,
          minVol: Math.min(buy.vol ?? Infinity, sell.vol ?? Infinity),
          suspicious: pct > SUSPICIOUS_PCT * 2,
        });
      }
    }
  }
  out.sort((a, b) => b.pct - a.pct);
  return out.slice(0, limit);
}

/** Funding: (1) same exchange spot long + perp short, (2) cross-exchange perp vs perp. */
export function funding(futByEx, spotByEx, spotFees, futFees, holdDays = 7) {
  const perBase = new Map();
  for (const [ex, rows] of Object.entries(futByEx)) {
    for (const [base, rate, ivh, next, mark, sym] of rows) {
      const per8 = rate * (8 / (ivh || 8));
      if (!perBase.has(base)) perBase.set(base, []);
      perBase.get(base).push({ ex, rate, ivh: ivh || 8, per8, apr: rate * (24 / (ivh || 8)) * 365 * 100, next, mark, sym });
    }
  }
  const hasSpot = (ex, base) => (spotByEx[ex] || []).some((m) => m[0] === base && m[1] === "USDT");
  const carry = [];
  for (const [base, list] of perBase) {
    for (const r of list) {
      if (r.rate <= 0) continue;
      const fees = 2 * ((spotFees[r.ex] ?? 0.1) + (futFees[r.ex] ?? 0.05)); // open + close, both legs, %
      const dailyPct = r.rate * (24 / r.ivh) * 100;
      carry.push({
        base, ex: r.ex, sym: r.sym, rate: r.rate, ratePct: r.rate * 100, ivh: r.ivh, apr: r.apr, dailyPct, feesPct: fees,
        breakevenDays: dailyPct > 0 ? fees / dailyPct : Infinity,
        netHoldPct: dailyPct * holdDays - fees, spot: hasSpot(r.ex, base), next: r.next,
      });
    }
  }
  carry.sort((a, b) => b.netHoldPct - a.netHoldPct);
  const spread = [];
  for (const [base, list] of perBase) {
    if (list.length < 2) continue;
    const hi = list.reduce((a, b) => (b.per8 > a.per8 ? b : a));
    const lo = list.reduce((a, b) => (b.per8 < a.per8 ? b : a));
    if (hi.ex === lo.ex) continue;
    const diff8 = hi.per8 - lo.per8;
    const fees = 2 * ((futFees[hi.ex] ?? 0.05) + (futFees[lo.ex] ?? 0.05));
    const dailyPct = diff8 * 3 * 100;
    spread.push({
      base, shortEx: hi.ex, shortSym: hi.sym, shortRate: hi.rate * 100, shortIv: hi.ivh,
      longEx: lo.ex, longSym: lo.sym, longRate: lo.rate * 100, longIv: lo.ivh, dailyPct,
      diff8Pct: diff8 * 100, apr: diff8 * 3 * 365 * 100, feesPct: fees,
      breakevenDays: dailyPct > 0 ? fees / dailyPct : Infinity, netHoldPct: dailyPct * holdDays - fees,
    });
  }
  spread.sort((a, b) => b.netHoldPct - a.netHoldPct);
  return { carry: carry.slice(0, 300), spread: spread.slice(0, 300) };
}

// ------------------------------------------------------------------ honest (conservative) profit
// Everything below answers one question: "how many dollars do I actually keep?"
// Rules: never project a spike forward, count every cost we know, and return null when we cannot know.

/** Average funding per DAY (%) from history rows [{t, rate}] of one contract. null if too little data. */
export function avgDailyPct(hist, ivh, minPoints = 3) {
  if (!hist || hist.length < minPoints) return null;
  const mean = hist.reduce((s, h) => s + h.rate, 0) / hist.length;
  return mean * (24 / (ivh || 8)) * 100;
}

/**
 * Cash & carry on one exchange with total capital C: C/2 buys spot, C/2 is margin for a 1x short perp.
 * Funding is earned on the C/2 position only. Rate used = the LOWER of now and the 3-day average.
 * costs: open+close taker fees on both legs + crossing the bid/ask spread on both legs.
 */
export function honestCarry({ dailyNowPct, avgDaily, spotFee, futFee, spreadPct, capital, days }) {
  if (avgDaily == null) return null;
  const usedDaily = Math.min(dailyNowPct, avgDaily);
  const half = capital / 2;
  const feeUsd = half * (2 * spotFee + 2 * futFee) / 100;
  const spreadUsd = half * (2 * spreadPct) / 100; // spot spread + (assumed equal) perp spread
  const costUsd = feeUsd + spreadUsd;
  const perDayUsd = half * usedDaily / 100;
  return {
    usedDaily, perDayUsd, costUsd,
    netUsd: perDayUsd * days - costUsd,
    breakevenDays: perDayUsd > 0 ? costUsd / perDayUsd : Infinity,
  };
}

/** Funding spread between two exchanges: C/2 margin each side, 1x. Diff used = lower of now and 3-day average. */
export function honestSpread({ diffNowDaily, diffAvgDaily, futFeeA, futFeeB, spreadPct, capital, days }) {
  if (diffAvgDaily == null) return null;
  const usedDaily = Math.min(diffNowDaily, diffAvgDaily);
  const half = capital / 2;
  const costUsd = half * (2 * futFeeA + 2 * futFeeB) / 100 + half * (2 * spreadPct) / 100; // round trip crosses the spread once per leg
  const perDayUsd = half * usedDaily / 100;
  return {
    usedDaily, perDayUsd, costUsd,
    netUsd: perDayUsd * days - costUsd,
    breakevenDays: perDayUsd > 0 ? costUsd / perDayUsd : Infinity,
  };
}

/** One-off trade (triangular / cross): profit only on the size the best price can take, minus fixed costs ($). null when size unknown. */
export function honestOneOff({ pct, maxSize, capital, fixedCostUsd = 0 }) {
  if (maxSize == null) return null;
  const used = Math.min(capital, maxSize);
  return { used, netUsd: used * pct / 100 - fixedCostUsd, partial: maxSize < capital };
}

export function fmtPx(p) {
  if (!Number.isFinite(p)) return "-";
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  const d = Math.min(12, Math.max(4, 2 - Math.floor(Math.log10(p)) + 3));
  return p.toFixed(d);
}
