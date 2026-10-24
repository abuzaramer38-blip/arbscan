import { triangular, crossExchange, funding, cleanMarkets, fmtPx, avgDailyPct, histInterval, honestCarry, honestSpread, honestOneOff,
  perpGap, crossFill, bestCrossSize, positiveShare } from "/arb.js";

const EX = ["binance", "bybit", "okx", "bitget", "mexc", "gate", "kucoin", "htx"];
const NAME = { binance: "Binance", bybit: "Bybit", okx: "OKX", bitget: "Bitget", mexc: "MEXC", gate: "Gate", kucoin: "KuCoin", htx: "HTX" };
const nm = (ex) => NAME[ex] || ex;
// Default VIP0 taker fees in % (editable in the Fees tab).
const DEFAULT_FEES = {
  spot: { binance: 0.1, bybit: 0.1, okx: 0.1, bitget: 0.1, mexc: 0.05, gate: 0.1, kucoin: 0.1, htx: 0.2 },
  fut: { binance: 0.05, bybit: 0.055, okx: 0.05, bitget: 0.06, mexc: 0.02, gate: 0.05, kucoin: 0.06, htx: 0.05 },
  wd: 1, // estimated withdrawal fee in $ for one cross-exchange transfer
};
const PERP_SPREAD = 0.05; // assumed bid/ask spread of a perpetual, % (not in our data)
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};
let fees = store.get("arbscan-fees", structuredClone(DEFAULT_FEES));
if (!Number.isFinite(fees.wd)) fees.wd = DEFAULT_FEES.wd;
const state = { raw: {}, clean: {}, fut: {}, perps: {}, spotMeta: {}, futMeta: {}, perpMeta: {}, lastFut: 0, hist: {}, depth: {} };
const $ = (s) => document.querySelector(s);
const inv = () => Math.max(1, parseFloat($("#inv").value) || 100);
// empty / invalid box falls back to $50k; never fully off (hard floor $1k) so totally dead markets stay hidden
const VOL_DEFAULT = 50000;
const VOL_FLOOR = 1000;
const THIN = 100000; // below this 24h volume a route gets a "thin" warning
const minVol = () => {
  const v = parseFloat($("#minVol").value);
  return Number.isFinite(v) ? Math.max(VOL_FLOOR, v) : VOL_DEFAULT;
};
const volCell = (v) => `${usd(v)}${v < THIN ? ' <span class="sus" title="Low volume: your order can move the price">thin</span>' : ""}`;

// ---------- data
async function load(kind, ex) {
  const meta = kind === "spot" ? state.spotMeta : state.futMeta;
  meta[ex] = { ...(meta[ex] || {}), loading: true };
  renderStatus();
  try {
    const r = await fetch(`/api/${kind === "spot" ? "spot" : "funding"}?ex=${ex}`);
    const j = await r.json();
    if (j.ok) {
      if (kind === "spot") state.raw[ex] = j.markets; else state.fut[ex] = j.rows;
      meta[ex] = { ok: true, count: j.count, ms: j.ms };
    } else meta[ex] = { ok: false, error: j.error || "error", ms: j.ms };
  } catch (e) {
    meta[ex] = { ok: false, error: String(e.message || e) };
  }
  renderStatus();
}
async function loadPerps(ex) {
  try {
    const j = await (await fetch(`/api/perps?ex=${ex}`)).json();
    state.perpMeta[ex] = j.ok ? { ok: true, count: j.count } : { ok: false, error: j.error };
    if (j.ok) state.perps[ex] = j.rows;
  } catch (e) {
    state.perpMeta[ex] = { ok: false, error: String(e.message || e) };
  }
}
const activeTab = () => document.querySelector(".tab.active")?.dataset.tab;
async function refreshPerps() {
  await Promise.all(EX.map(loadPerps));
  state.lastPerps = Date.now();
  renderPerp();
}
function rebuildClean() {
  for (const ex of EX) if (state.raw[ex]) state.clean[ex] = cleanMarkets(state.raw[ex], minVol(), true);
}
async function refreshSpot() {
  await Promise.all(EX.map((ex) => load("spot", ex)));
  rebuildClean();
  renderAll();
}
async function refreshFut() {
  await Promise.all(EX.map((ex) => load("fut", ex)));
  state.lastFut = Date.now();
  renderFunding();
  renderFees();
}

// ---------- formatting
const pct = (v, d = 3) => `<span class="${v > 0 ? "pos" : "neg"}">${v > 0 ? "+" : ""}${v.toFixed(d)}%</span>`;
const money = (v, d = 2) => `<span class="${v > 0 ? "pos" : v < 0 ? "neg" : ""}">${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(d)}</span>`;
const usd = (v) => (v == null || !Number.isFinite(v) ? "?" : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}k` : `$${v.toFixed(0)}`);
const span = (d) => (!Number.isFinite(d) ? "never" : d < 1 ? `${(d * 24).toFixed(1)} h` : `${d.toFixed(1)} days`);
const empty = (cols, msg) => `<tr><td colspan="${cols}" class="empty">${msg}</td></tr>`;
const sizeCell = (max) => (max == null ? '<span class="muted">unknown</span>'
  : `<span class="${max >= inv() ? "fit" : "nofit"}">${usd(max)}</span>`);

// "you keep" cell for one-off trades: profit only on what fits, minus fixed costs. Unknown size -> not counted.
function keepCell(o, I) {
  if (!o) return '<span class="muted">size unknown — not counted</span>';
  const d = o.netUsd !== 0 && Math.abs(o.netUsd) < 0.1 ? 3 : 2;
  return `${money(o.netUsd, d)}${o.partial ? ` <span class="nofit">only $${o.used.toFixed(0)} of $${I} fits</span>` : ""}`;
}

function bestBanner(el, best, I, what) {
  const box = $(el);
  if (!best) { box.className = "best none"; box.innerHTML = "Checking…"; return; }
  if (best.usd <= 0.005) {
    box.className = "best none";
    box.innerHTML = `<b>Nothing worth doing right now.</b> After all costs, the best ${what} on $${I} ${best.usd < 0 ? `would lose $${Math.abs(best.usd).toFixed(2)}` : "makes $0.00"} (${best.label}).`;
  } else {
    box.className = "best yes";
    box.innerHTML = `<b>Best real result on $${I}: ${money(best.usd)}</b> — ${best.label}`;
  }
}

function setHeaders() {
  document.querySelectorAll(".invh").forEach((th) => { th.textContent = `You keep on $${inv()}`; });
  const d = holdDays();
  document.querySelectorAll(".netd").forEach((th) => { th.textContent = `You keep on $${inv()} after ${d} day${d > 1 ? "s" : ""}`; });
}
const holdDays = () => Math.max(1, parseFloat($("#fdDays").value) || 3);

// ---------- render
function renderStatus() {
  $("#status").innerHTML = EX.map((ex) => {
    const s = state.spotMeta[ex] || {};
    const f = state.futMeta[ex] || {};
    const cls = s.ok ? "ok" : s.error ? "err" : "wait";
    const liquid = state.clean[ex] ? ` (${state.clean[ex].length} liquid)` : "";
    const sp = s.ok ? `spot ${s.count}${liquid}` : s.error ? "spot ✕" : "spot …";
    const fu = f.ok ? `perps ${f.count}` : f.error ? "perps ✕" : "perps …";
    const err = s.error || f.error;
    return `<div class="chip ${cls}" title="${(err || "").replace(/"/g, "'")}"><b>${nm(ex)}</b>${sp} · ${fu}${err ? `<span class="e">${err}</span>` : ""}</div>`;
  }).join("");
}

const TRI_MAX = 2;   // real triangular gaps on liquid markets are far below this; above = stale/broken quote
const CROSS_MAX = 3; // above this the transfer is almost always closed or it's a different token

function renderTri() {
  const exSel = $("#triEx").value;
  const start = $("#triStart").value;
  const minPct = parseFloat($("#triMin").value);
  const onlyFit = $("#triFit").checked;
  const I = inv();
  let rows = [];
  for (const ex of EX) {
    if (exSel !== "all" && exSel !== ex) continue;
    const mk = state.clean[ex];
    if (!mk) continue;
    for (const r of triangular(mk, fees.spot[ex] ?? 0.1, [start], Number.isFinite(minPct) ? minPct : -0.05, 150)) rows.push({ ex, ...r });
  }
  const clean = $("#triClean").checked;
  rows = rows.filter((r) => (!onlyFit || (r.maxStart != null && r.maxStart >= I))
    && (!clean || (r.pct <= TRI_MAX && (r.maxStart == null || r.maxStart >= 10))))
    .map((r) => ({ ...r, keep: honestOneOff({ pct: r.pct, maxSize: r.maxStart, capital: I }) }))
    .sort((a, b) => (b.keep?.netUsd ?? -1e9) - (a.keep?.netUsd ?? -1e9) || b.pct - a.pct).slice(0, 200);
  const b = rows.find((r) => r.keep);
  bestBanner("#triBest", b && { usd: b.keep.netUsd, label: `${nm(b.ex)} ${b.path}, only if all 3 orders fill instantly` }, I, "route");
  $("#triInfo").textContent = `${rows.length} routes · ${rows.filter((r) => r.keep && r.keep.netUsd > 0).length} make money`;
  $("#triTable tbody").innerHTML = rows.length ? rows.map((r) => `<tr>
    <td class="l">${nm(r.ex)}</td><td class="l">${r.path}</td><td class="legs">${r.legs.join("<br>")}</td>
    <td>${pct(r.pct)}</td><td>${keepCell(r.keep, I)}</td>
    <td>${sizeCell(r.maxStart)}</td><td>${volCell(r.minVol)}</td></tr>`).join("")
    : empty(7, "No route matches these filters.");
}

// ---------- order books (fetched only for the top rows, cached a few seconds)
const DEPTH_TTL = 8000;
let depthRender = null;
function needDepth(ex, base) {
  const k = `${ex}|${base}`;
  const d = state.depth[k];
  if (d && (d.loading || Date.now() - d.t < DEPTH_TTL)) return;
  state.depth[k] = { ...(d || {}), loading: true, t: Date.now() };
  fetch(`/api/depth?ex=${ex}&base=${encodeURIComponent(base)}`).then((r) => r.json())
    .then((j) => { state.depth[k] = j.ok ? { ok: true, bids: j.bids, asks: j.asks, t: Date.now() } : { ok: false, t: Date.now(), error: j.error }; })
    .catch((e) => { state.depth[k] = { ok: false, t: Date.now(), error: String(e) }; })
    .finally(() => { clearTimeout(depthRender); depthRender = setTimeout(renderCross, 200); });
}
const getDepth = (ex, base) => state.depth[`${ex}|${base}`];
const DEPTH_ROWS = 8;

function renderCross() {
  const minPct = parseFloat($("#crMin").value);
  const onlyFit = $("#crFit").checked;
  const I = inv();
  const clean = $("#crClean").checked;
  const inventory = $("#crInv").checked; // coin + USDT already on both exchanges: no transfer, no withdrawal fee
  const wd = inventory ? 0 : (fees.wd ?? 1);
  const rows = crossExchange(state.clean, fees.spot, "USDT", Number.isFinite(minPct) ? minPct : 0, 800)
    .filter((r) => (!onlyFit || (r.maxUsd != null && r.maxUsd >= I))
      && (!clean || (r.pct <= CROSS_MAX && (r.maxUsd == null || r.maxUsd >= 10))))
    .map((r) => ({ ...r, keep: honestOneOff({ pct: r.pct, maxSize: r.maxUsd, capital: I, fixedCostUsd: wd }) }))
    .sort((a, b) => (b.keep?.netUsd ?? -1e9) - (a.keep?.netUsd ?? -1e9) || b.pct - a.pct).slice(0, 250);
  // real order-book check for the top rows that look positive before fees we cannot see
  rows.forEach((r, i) => {
    if (i >= DEPTH_ROWS || r.pct <= 0) return;
    needDepth(r.buyEx, r.base);
    needDepth(r.sellEx, r.base);
    const A = getDepth(r.buyEx, r.base), B = getDepth(r.sellEx, r.base);
    if (A?.ok && B?.ok) {
      const fa = fees.spot[r.buyEx] ?? 0.1, fb = fees.spot[r.sellEx] ?? 0.1;
      r.book = { at: crossFill(A.asks, B.bids, I, fa, fb, wd), best: bestCrossSize(A.asks, B.bids, I, fa, fb, wd) };
    } else if (A?.ok === false || B?.ok === false) r.book = { error: true };
    else r.book = { loading: true };
  });
  const checked = rows.filter((r) => r.book?.at);
  const best = checked.sort((a, b) => b.book.best.profit - a.book.best.profit)[0];
  const how = inventory ? "same second, no transfer (you already hold both sides)" : "if price holds during the transfer";
  bestBanner("#crBest", best ? { usd: best.book.best.profit, label: `${best.base}: buy ${nm(best.buyEx)}, sell ${nm(best.sellEx)}, real order book, best size $${best.book.best.size.toFixed(0)} — ${how}` }
    : rows.length && rows[0].pct <= 0 ? { usd: rows[0].keep?.netUsd ?? -0.01, label: "no positive gap after fees" } : null, I, "trade");
  $("#crInfo").textContent = `${rows.length} pairs · ${rows.filter((r) => r.keep && r.keep.netUsd > 0).length} positive on top-of-book${wd ? ` after the $${wd} withdrawal fee` : ""}`;
  const bookCell = (r) => {
    if (!r.book) return '<span class="muted">—</span>';
    if (r.book.loading) return '<span class="muted">checking…</span>';
    if (r.book.error) return '<span class="muted">book not available</span>';
    const a = r.book.at, b = r.book.best;
    return `${money(a.profit)} on $${a.spent.toFixed(0)}${a.full ? "" : ' <span class="nofit">book too thin</span>'}`
      + (b.profit > a.profit + 0.005 ? `<br><span class="muted">best: ${money(b.profit)} on $${b.size.toFixed(0)}</span>` : "");
  };
  $("#crTable tbody").innerHTML = rows.length ? rows.map((r) => `<tr>
    <td class="l"><b>${r.base}</b></td><td>${nm(r.buyEx)} @ ${fmtPx(r.buy)}</td><td>${nm(r.sellEx)} @ ${fmtPx(r.sell)}</td>
    <td>${r.gross.toFixed(3)}%</td><td>${pct(r.pct)}</td><td>${keepCell(r.keep, I)}</td><td>${bookCell(r)}</td>
    <td>${sizeCell(r.maxUsd)}</td><td>${volCell(r.minVol)}</td></tr>`).join("")
    : empty(9, "No opportunity matches these filters.");
}

// ---------- funding history (3 days) — fetched only for the top candidates
const HIST_TTL = 10 * 60 * 1000;
const histKey = (ex, sym) => `${ex}|${sym}`;
const histQueue = [];
let histRunning = 0;
let histRender = null;
function needHist(ex, sym) {
  if (!sym) return;
  const k = histKey(ex, sym);
  const h = state.hist[k];
  if (h && (h.loading || Date.now() - h.t < HIST_TTL)) return;
  state.hist[k] = { loading: true, t: Date.now() };
  histQueue.push([ex, sym]);
  pumpHist();
}
function pumpHist() {
  while (histRunning < 6 && histQueue.length) {
    const [ex, sym] = histQueue.shift();
    histRunning++;
    fetch(`/api/history?ex=${ex}&sym=${encodeURIComponent(sym)}`).then((r) => r.json())
      .then((j) => { state.hist[histKey(ex, sym)] = j.ok ? { ok: true, rows: j.rows, t: Date.now() } : { ok: false, t: Date.now(), error: j.error }; })
      .catch((e) => { state.hist[histKey(ex, sym)] = { ok: false, t: Date.now(), error: String(e) }; })
      .finally(() => {
        histRunning--;
        pumpHist();
        clearTimeout(histRender);
        histRender = setTimeout(renderFunding, 250);
      });
  }
}
// returns {avg} (avg daily %, or null when not enough data), or {loading:true}
function histAvg(ex, sym, ivh) {
  const h = state.hist[histKey(ex, sym)];
  if (!h || h.loading) return { loading: true };
  if (!h.ok) return { avg: null, why: "no history" };
  const rows3 = h.rows.filter((x) => x.t >= Date.now() - 3 * 86400000);
  const avg = avgDailyPct(rows3, ivh);
  const iv = histInterval(h.rows);
  return avg == null ? { avg: null, why: "too new" }
    : { avg, n: rows3.length, iv: iv || ivh, pos: positiveShare(rows3, 1), neg: positiveShare(rows3, -1), rows: rows3 };
}
function spotSpreadPct(ex, base) {
  const m = (state.raw[ex] || []).find((x) => x[0] === base && x[1] === "USDT");
  if (!m) return 0.2;
  return ((m[3] - m[2]) / ((m[3] + m[2]) / 2)) * 100;
}
const CANDIDATES = 30;
const STABLE = 0.8; // at least 80% of the last 3 days' payments went our way

function renderFunding() {
  const d = holdDays();
  const spotOnly = $("#fdSpotOnly").checked;
  const unified = $("#fdUnified").checked;
  const stableOnly = $("#fdStable").checked;
  const share = unified ? 0.8 : 0.5;
  const I = inv();
  setHeaders();
  const { carry, spread } = funding(state.fut, state.clean, fees.spot, fees.fut, d);
  // candidates by today's rate; then judged by the honest (lower) rate
  const cands = carry.filter((r) => !spotOnly || r.spot).sort((a, b) => b.dailyPct - a.dailyPct).slice(0, CANDIDATES);
  const c = cands.map((r) => {
    needHist(r.ex, r.sym);
    const h = histAvg(r.ex, r.sym, r.ivh);
    const spr = spotSpreadPct(r.ex, r.base);
    const iv = h.iv || r.ivh; // real interval seen in history beats the exchange's/assumed one
    const nowDaily = r.rate * (24 / iv) * 100;
    r = { ...r, ivh: iv, dailyPct: nowDaily };
    const hc = h.avg == null ? null : honestCarry({
      dailyNowPct: nowDaily, avgDaily: h.avg, spotFee: fees.spot[r.ex] ?? 0.1, futFee: fees.fut[r.ex] ?? 0.05,
      spreadPct: (spr + PERP_SPREAD) / 2, capital: I, days: d, share,
    });
    return { ...r, h, hc, stable: h.pos != null && h.pos >= STABLE, spike: h.avg != null && r.dailyPct > 3 * Math.max(h.avg, 0.0001) };
  }).filter((r) => !stableOnly || r.h.loading || r.stable)
    .sort((a, b) => (b.hc?.netUsd ?? -1e9) - (a.hc?.netUsd ?? -1e9));
  state.carryRows = c;
  const bc = c.find((r) => r.hc);
  const pos = unified ? `$${(I * share).toFixed(0)} position in a unified account` : `$${(I / 2).toFixed(0)} spot + $${(I / 2).toFixed(0)} margin`;
  bestBanner("#fdBest", bc && { usd: bc.hc.netUsd, label: `${bc.base} on ${nm(bc.ex)}, ${d} day${d > 1 ? "s" : ""}, ${pos}` }, I, "funding trade");
  // spreading the money over the 5 best stable, non-risky trades: one bad coin can't wipe everything
  const five = c.filter((r) => r.hc && r.hc.netUsd > 0 && r.stable && r.dailyPct <= 1).slice(0, 5);
  $("#fdSplit").innerHTML = five.length >= 2
    ? `Split $${I} into ${five.length} × $${(I / five.length).toFixed(0)} (${five.map((r) => `${r.base}/${nm(r.ex)}`).join(", ")}): about ${money(five.reduce((t, r) => t + honestCarry({
      dailyNowPct: r.dailyPct, avgDaily: r.h.avg, spotFee: fees.spot[r.ex] ?? 0.1, futFee: fees.fut[r.ex] ?? 0.05,
      spreadPct: (spotSpreadPct(r.ex, r.base) + PERP_SPREAD) / 2, capital: I / five.length, days: d, share }).netUsd, 0))} in ${d} day${d > 1 ? "s" : ""} — lower but safer than one coin.`
    : "";

  const sc = spread.sort((a, b) => b.dailyPct - a.dailyPct).slice(0, 20).map((r0) => {
    let r = r0;
    needHist(r.shortEx, r.shortSym);
    needHist(r.longEx, r.longSym);
    const hs = histAvg(r.shortEx, r.shortSym, r.shortIv);
    const hl = histAvg(r.longEx, r.longSym, r.longIv);
    const loading = hs.loading || hl.loading;
    // recompute today's gap with the REAL payment intervals from history
    const sIv = hs.iv || r.shortIv, lIv = hl.iv || r.longIv;
    const nowDiff = r.shortRate * (24 / sIv) - r.longRate * (24 / lIv);
    const ivFixed = sIv !== r.shortIv || lIv !== r.longIv;
    r = { ...r, shortIv: sIv, longIv: lIv, dailyPct: nowDiff, ivFixed };
    // small coins: perp spread is at least the spot spread we can see
    const pSpr = Math.max(PERP_SPREAD, spotSpreadPct(r.shortEx, r.base), spotSpreadPct(r.longEx, r.base));
    const extreme = Math.abs(r.shortRate * (24 / sIv)) > 1 || Math.abs(r.longRate * (24 / lIv)) > 1;
    r.extreme = extreme;
    const avgDiff = hs.avg != null && hl.avg != null ? hs.avg - hl.avg : null;
    const hc = avgDiff == null ? null : honestSpread({
      diffNowDaily: r.dailyPct, diffAvgDaily: avgDiff, futFeeA: fees.fut[r.shortEx] ?? 0.05, futFeeB: fees.fut[r.longEx] ?? 0.05,
      spreadPct: pSpr, capital: I, days: d,
    });
    return { ...r, loading, avgDiff, hc, hs, hl };
  }).sort((a, b) => (b.hc?.netUsd ?? -1e9) - (a.hc?.netUsd ?? -1e9));
  state.spreadRows = sc;

  $("#fdInfo").textContent = `${c.filter((r) => r.hc && r.hc.netUsd > 0).length} carry + ${sc.filter((r) => r.hc && r.hc.netUsd > 0).length} spread trades make money after costs`;
  const avgCell = (h, ivh) => h.loading ? '<span class="muted">checking…</span>'
    : h.avg == null ? `<span class="muted">${h.why} — not counted</span>` : `${(h.avg / (24 / ivh)).toFixed(4)}%`;
  $("#fdCarry tbody").innerHTML = c.length ? c.map((r) => `<tr>
    <td class="l"><b>${r.base}</b></td><td>${nm(r.ex)}${r.spot ? "" : ' <span class="sus">no liquid spot</span>'}</td>
    <td>${r.ratePct.toFixed(4)}% / ${r.ivh}h${r.dailyPct > 1 ? ' <span class="sus" title="Over 1% a day: the coin is being squeezed and can move 30-100%">high risk</span>' : ""}${r.spike ? ' <span class="sus" title="Today is far above its 3-day average; it usually falls back">spike</span>' : ""}</td>
    <td>${avgCell(r.h, r.ivh)}</td>
    <td>${r.h.pos == null ? "—" : `<span class="${r.stable ? "fit" : "nofit"}">${Math.round(r.h.pos * r.h.n)}/${r.h.n}</span>`}</td>
    <td>${r.hc ? `${(r.hc.usedDaily).toFixed(3)}%/day` : "—"}</td>
    <td>${r.hc ? `$${r.hc.costUsd.toFixed(2)}` : "—"}</td>
    <td>${r.hc ? span(r.hc.breakevenDays) : "—"}</td>
    <td>${r.hc ? money(r.hc.netUsd) : '<span class="muted">—</span>'}</td>
    <td>${r.hc ? `<button class="btn mini" data-track="carry" data-i="${c.indexOf(r)}">Paper</button>` : ""}</td></tr>`).join("")
    : empty(10, "Loading…");
  $("#fdSpread tbody").innerHTML = sc.length ? sc.map((r) => `<tr>
    <td class="l"><b>${r.base}</b></td><td>${nm(r.shortEx)} ${r.shortRate.toFixed(4)}%/${r.shortIv}h</td>
    <td>${nm(r.longEx)} ${r.longRate.toFixed(4)}%/${r.longIv}h</td><td>${r.dailyPct.toFixed(3)}%/day${r.extreme ? ' <span class="sus" title="Over 1% a day on one side: the coin is being squeezed. Price can jump 30-100% and liquidate one leg; rates change every hour.">high risk</span>' : ""}</td>
    <td>${r.loading ? '<span class="muted">checking…</span>' : r.avgDiff == null ? '<span class="muted">no history — not counted</span>' : `${r.avgDiff.toFixed(3)}%/day`}</td>
    <td>${r.hc ? `$${r.hc.costUsd.toFixed(2)}` : "—"}</td><td>${r.hc ? span(r.hc.breakevenDays) : "—"}</td>
    <td>${r.hc ? money(r.hc.netUsd) : '<span class="muted">—</span>'}</td>
    <td>${r.hc ? `<button class="btn mini" data-track="spread" data-i="${sc.indexOf(r)}">Paper</button>` : ""}</td></tr>`).join("")
    : empty(9, "Loading…");
  if (activeTab() === "paper") renderPaper();
}

// ---------- perp vs perp price gap (no transfer: futures on both exchanges)
const PERP_MAX = 3; // bigger gaps are almost always a broken/different contract or a halted market
function renderPerp() {
  const I = inv();
  const minPct = parseFloat($("#pgMin").value);
  const clean = $("#pgClean").checked;
  const posSize = I / 2; // half the money is margin on each exchange, 1x
  const fr = new Map();
  for (const [ex, rows] of Object.entries(state.fut)) for (const [base, rate, ivh] of rows) fr.set(`${ex}|${base}`, [rate, ivh || 8]);
  const rows = perpGap(state.perps, fees.fut, Number.isFinite(minPct) ? minPct : 0, 400, minVol())
    .filter((r) => !clean || (r.pct <= PERP_MAX && (r.maxUsd == null || r.maxUsd >= 10)))
    .map((r) => {
      const s = fr.get(`${r.shortEx}|${r.base}`), l = fr.get(`${r.longEx}|${r.base}`);
      const fundDaily = s && l ? (s[0] * 24 / s[1] - l[0] * 24 / l[1]) * 100 : null;
      return { ...r, fundDaily, keep: honestOneOff({ pct: r.pct, maxSize: r.maxUsd, capital: posSize }) };
    })
    .sort((a, b) => (b.keep?.netUsd ?? -1e9) - (a.keep?.netUsd ?? -1e9) || b.pct - a.pct).slice(0, 200);
  const b = rows.find((r) => r.keep);
  bestBanner("#pgBest", b && { usd: b.keep.netUsd, label: `${b.base}: long ${nm(b.longEx)}, short ${nm(b.shortEx)} ($${posSize.toFixed(0)} each side, 1x) — paid when the two prices meet` }, I, "futures gap");
  $("#pgInfo").textContent = `${rows.length} pairs · ${rows.filter((r) => r.keep && r.keep.netUsd > 0).length} make money after 4 fees + spreads`;
  const fund = (r) => r.fundDaily == null ? '<span class="muted">?</span>'
    : `${money(posSize * r.fundDaily / 100, 3)}/day`;
  $("#pgTable tbody").innerHTML = rows.length ? rows.map((r) => `<tr>
    <td class="l"><b>${r.base}</b></td><td>${nm(r.longEx)} @ ${fmtPx(r.long)}</td><td>${nm(r.shortEx)} @ ${fmtPx(r.short)}</td>
    <td>${r.gross.toFixed(3)}%</td><td>${pct(r.pct)}</td><td>${keepCell(r.keep, posSize)}</td><td>${fund(r)}</td>
    <td>${sizeCell(r.maxUsd)}</td><td>${volCell(r.minVol)}</td></tr>`).join("")
    : empty(9, Object.keys(state.perps).length ? "No futures gap matches these filters." : "Loading…");
}

// ---------- paper trades: track a funding trade with no money, see what it really paid
const paper = { list: store.get("arbscan-paper", []) };
const savePaper = () => store.set("arbscan-paper", paper.list);
function addPaper(kind, r) {
  const I = inv();
  const base = { id: Date.now(), kind, base: r.base, capital: I, t0: Date.now(), cost: r.hc.costUsd, expectDay: r.hc.perDayUsd };
  if (kind === "carry") paper.list.push({ ...base, ex: r.ex, sym: r.sym, pos: I * ($("#fdUnified").checked ? 0.8 : 0.5) });
  else paper.list.push({ ...base, shortEx: r.shortEx, shortSym: r.shortSym, longEx: r.longEx, longSym: r.longSym, pos: I / 2 });
  savePaper();
  renderPaper();
  $("#paperNote").textContent = `Added ${r.base} to Paper trades.`;
  setTimeout(() => { $("#paperNote").textContent = ""; }, 3000);
}
const ago = (ms) => { const h = ms / 3600000; return h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`; };
function paid(ex, sym, t0) {
  const h = state.hist[histKey(ex, sym)];
  if (!h || h.loading) return null;
  if (!h.ok) return { err: true };
  const rows = h.rows.filter((x) => x.t > t0);
  return { sum: rows.reduce((t, x) => t + x.rate, 0), n: rows.length };
}
function renderPaper() {
  const tb = $("#paperTable tbody");
  if (!paper.list.length) { tb.innerHTML = empty(8, 'Nothing tracked yet. In the Funding tab press "Paper" on a row.'); $("#paperTotal").textContent = ""; return; }
  let total = 0, done = 0;
  tb.innerHTML = paper.list.map((p) => {
    let got = null, n = 0, label;
    if (p.kind === "carry") {
      needHist(p.ex, p.sym);
      const a = paid(p.ex, p.sym, p.t0);
      if (a && !a.err) { got = p.pos * a.sum; n = a.n; }
      label = `${p.base} · ${nm(p.ex)} (buy spot + short)`;
    } else {
      needHist(p.shortEx, p.shortSym); needHist(p.longEx, p.longSym);
      const a = paid(p.shortEx, p.shortSym, p.t0), b = paid(p.longEx, p.longSym, p.t0);
      if (a && b && !a.err && !b.err) { got = p.pos * (a.sum - b.sum); n = Math.max(a.n, b.n); }
      label = `${p.base} · short ${nm(p.shortEx)} / long ${nm(p.longEx)}`;
    }
    const net = got == null ? null : got - p.cost;
    if (net != null) { total += net; done++; }
    return `<tr><td class="l"><b>${label}</b></td><td>$${p.capital}</td><td>${ago(Date.now() - p.t0)} ago</td><td>${got == null ? '<span class="muted">checking…</span>' : n}</td>
      <td>${got == null ? "—" : money(got, 3)}</td><td>$${p.cost.toFixed(2)}</td><td>${net == null ? "—" : money(net)}</td>
      <td><button class="btn mini ghost" data-del="${p.id}">Remove</button></td></tr>`;
  }).join("");
  $("#paperTotal").innerHTML = done ? `If you closed everything now: <b>${money(total)}</b> (funding actually paid since you started − all open/close costs).` : "";
}

function renderFees() {
  const order = [...EX].sort((a, b) => (fees.spot[a] - fees.spot[b]) || (fees.fut[a] - fees.fut[b]));
  $("#feeTable tbody").innerHTML = order.map((ex) => `<tr>
    <td class="l"><b>${nm(ex)}</b></td>
    <td><input type="number" step="0.005" min="0" data-k="spot" data-ex="${ex}" value="${fees.spot[ex]}"></td>
    <td><input type="number" step="0.005" min="0" data-k="fut" data-ex="${ex}" value="${fees.fut[ex]}"></td>
    <td>${state.spotMeta[ex]?.count ?? "—"}</td><td>${state.clean[ex]?.length ?? "—"}</td><td>${state.futMeta[ex]?.count ?? "—"}</td></tr>`).join("");
  $("#wdFee").value = fees.wd;
}

function renderAll() {
  setHeaders();
  renderTri();
  renderCross();
  renderFunding();
  renderPerp();
  renderStatus();
  $("#updated").textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

// ---------- events
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${b.dataset.tab}`));
  store.set("arbscan-tab", b.dataset.tab);
  if (b.dataset.tab === "paper") renderPaper();
  if (b.dataset.tab === "perp" && Date.now() - (state.lastPerps || 0) > 8000) refreshPerps();
}));
["#triEx", "#triStart", "#triMin", "#triFit", "#triClean"].forEach((s) => $(s).addEventListener("input", renderTri));
["#crMin", "#crFit", "#crClean"].forEach((s) => $(s).addEventListener("input", renderCross));
["#fdDays", "#fdSpotOnly", "#fdUnified", "#fdStable"].forEach((s) => $(s).addEventListener("input", renderFunding));
["#crInv"].forEach((s) => $(s).addEventListener("input", renderCross));
["#pgMin", "#pgClean"].forEach((s) => $(s).addEventListener("input", renderPerp));
["#fdCarry", "#fdSpread"].forEach((sel) => $(sel).addEventListener("click", (e) => {
  const b = e.target.closest("[data-track]");
  if (!b) return;
  const r = (b.dataset.track === "carry" ? state.carryRows : state.spreadRows)?.[+b.dataset.i];
  if (r?.hc) addPaper(b.dataset.track, r);
}));
$("#paperTable").addEventListener("click", (e) => {
  const b = e.target.closest("[data-del]");
  if (!b) return;
  paper.list = paper.list.filter((p) => String(p.id) !== b.dataset.del);
  savePaper();
  renderPaper();
});
$("#inv").addEventListener("input", () => { store.set("arbscan-inv", inv()); renderAll(); });
$("#minVol").addEventListener("change", () => {
  $("#minVol").value = minVol();
  store.set("arbscan-minvol-v2", minVol());
  rebuildClean();
  renderAll();
  renderFees();
});
$("#feeTable").addEventListener("change", (e) => {
  const t = e.target;
  if (!t.dataset.ex) return;
  fees[t.dataset.k][t.dataset.ex] = Math.max(0, parseFloat(t.value) || 0);
  store.set("arbscan-fees", fees);
  renderAll();
  renderFees();
});
$("#wdFee").addEventListener("change", () => {
  fees.wd = Math.max(0, parseFloat($("#wdFee").value) || 0);
  store.set("arbscan-fees", fees);
  renderCross();
});
$("#feeReset").addEventListener("click", () => {
  fees = structuredClone(DEFAULT_FEES);
  store.set("arbscan-fees", fees);
  renderFees();
  renderAll();
});
$("#refresh").addEventListener("click", () => { refreshSpot(); refreshFut(); refreshPerps(); });

let timer = null;
function schedule() {
  clearInterval(timer);
  if (!$("#auto").checked) return;
  const sec = parseInt($("#every").value, 10) || 10;
  timer = setInterval(() => {
    if (document.hidden) return;
    refreshSpot();
    if (activeTab() === "perp") refreshPerps();
    if (Date.now() - state.lastFut > 60000) refreshFut();
  }, sec * 1000);
}
$("#auto").addEventListener("change", schedule);
$("#every").addEventListener("change", schedule);

// ---------- init
$("#inv").value = store.get("arbscan-inv", 100);
$("#minVol").value = Math.max(VOL_FLOOR, Number(store.get("arbscan-minvol-v2", VOL_DEFAULT)) || VOL_DEFAULT);
$("#triEx").innerHTML += EX.map((e) => `<option value="${e}">${nm(e)}</option>`).join("");
document.querySelector(`.tab[data-tab="${store.get("arbscan-tab", "tri")}"]`)?.click();
setHeaders();
renderStatus();
renderFees();
refreshSpot();
refreshFut();
refreshPerps();
schedule();
