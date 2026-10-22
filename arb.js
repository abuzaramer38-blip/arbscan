// Arbitrage math. Pure functions, used by the browser (app.js) and by tests (node).
// market row: [base, quote, bid, ask, bidQty, askQty]
// fee values are in PERCENT (0.1 = 0.1%).

const SUSPICIOUS_PCT = 5;

/** Triangular arbitrage on ONE exchange: start -> A -> B -> start. */
export function triangular(markets, feePct, starts = ["USDT"], minPct = -0.5, limit = 200) {
  const f = 1 - feePct / 100;
  // edges: from -> [{to, rate, cap (in 'from' units, or null), sym, side, px}]
  const g = new Map();
  const add = (from, e) => {
    if (!g.has(from)) g.set(from, []);
    g.get(from).push(e);
  };
  for (const [b, q, bid, ask, bq, aq] of markets) {
    // buy base with quote at ask
    add(q, { to: b, rate: (1 / ask) * f, cap: aq > 0 ? aq * ask : null, sym: `${b}/${q}`, side: "BUY", px: ask });
    // sell base for quote at bid
    add(b, { to: q, rate: bid * f, cap: bq > 0 ? bq : null, sym: `${b}/${q}`, side: "SELL", px: bid });
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
    for (const [b, q, bid, ask, bq, aq] of mk) {
      if (q !== quote) continue;
      if (!book.has(b)) book.set(b, []);
      book.get(b).push({ ex, bid, ask, bq, aq });
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
        base, ex: r.ex, ratePct: r.rate * 100, ivh: r.ivh, apr: r.apr, dailyPct, feesPct: fees,
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
      base, shortEx: hi.ex, shortRate: hi.rate * 100, shortIv: hi.ivh, longEx: lo.ex, longRate: lo.rate * 100, longIv: lo.ivh,
      diff8Pct: diff8 * 100, apr: diff8 * 3 * 365 * 100, feesPct: fees,
      breakevenDays: dailyPct > 0 ? fees / dailyPct : Infinity, netHoldPct: dailyPct * holdDays - fees,
    });
  }
  spread.sort((a, b) => b.netHoldPct - a.netHoldPct);
  return { carry: carry.slice(0, 300), spread: spread.slice(0, 300) };
}

export function fmtPx(p) {
  if (!Number.isFinite(p)) return "-";
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  const d = Math.min(12, Math.max(4, 2 - Math.floor(Math.log10(p)) + 3));
  return p.toFixed(d);
}
