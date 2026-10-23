import { triangular, crossExchange, funding, cleanMarkets, fmtPx, avgDailyPct, honestCarry, honestSpread, honestOneOff } from "/arb.js";

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
const state = { raw: {}, clean: {}, fut: {}, spotMeta: {}, futMeta: {}, lastFut: 0, hist: {} };
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

function renderCross() {
  const minPct = parseFloat($("#crMin").value);
  const onlyFit = $("#crFit").checked;
  const I = inv();
  const clean = $("#crClean").checked;
  const wd = fees.wd ?? 1;
  const rows = crossExchange(state.clean, fees.spot, "USDT", Number.isFinite(minPct) ? minPct : 0, 800)
    .filter((r) => (!onlyFit || (r.maxUsd != null && r.maxUsd >= I))
      && (!clean || (r.pct <= CROSS_MAX && (r.maxUsd == null || r.maxUsd >= 10))))
    .map((r) => ({ ...r, keep: honestOneOff({ pct: r.pct, maxSize: r.maxUsd, capital: I, fixedCostUsd: wd }) }))
    .sort((a, b) => (b.keep?.netUsd ?? -1e9) - (a.keep?.netUsd ?? -1e9)).slice(0, 250);
  const b = rows.find((r) => r.keep);
  bestBanner("#crBest", b && { usd: b.keep.netUsd, label: `${b.base}: buy ${nm(b.buyEx)}, sell ${nm(b.sellEx)} — if price holds during the transfer` }, I, "trade");
  $("#crInfo").textContent = `${rows.length} pairs · ${rows.filter((r) => r.keep && r.keep.netUsd > 0).length} make money after the $${wd} withdrawal fee`;
  $("#crTable tbody").innerHTML = rows.length ? rows.map((r) => `<tr>
    <td class="l"><b>${r.base}</b></td><td>${nm(r.buyEx)} @ ${fmtPx(r.buy)}</td><td>${nm(r.sellEx)} @ ${fmtPx(r.sell)}</td>
    <td>${r.gross.toFixed(3)}%</td><td>${pct(r.pct)}</td><td>${keepCell(r.keep, I)}</td>
    <td>${sizeCell(r.maxUsd)}</td><td>${volCell(r.minVol)}</td></tr>`).join("")
    : empty(8, "No opportunity matches these filters.");
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
  const avg = avgDailyPct(h.rows, ivh);
  return avg == null ? { avg: null, why: "too new" } : { avg, n: h.rows.length };
}
function spotSpreadPct(ex, base) {
  const m = (state.raw[ex] || []).find((x) => x[0] === base && x[1] === "USDT");
  if (!m) return 0.2;
  return ((m[3] - m[2]) / ((m[3] + m[2]) / 2)) * 100;
}
const CANDIDATES = 30;

function renderFunding() {
  const d = holdDays();
  const spotOnly = $("#fdSpotOnly").checked;
  const I = inv();
  setHeaders();
  const { carry, spread } = funding(state.fut, state.clean, fees.spot, fees.fut, d);
  // candidates by today's rate; then judged by the honest (lower) rate
  const cands = carry.filter((r) => !spotOnly || r.spot).sort((a, b) => b.dailyPct - a.dailyPct).slice(0, CANDIDATES);
  const c = cands.map((r) => {
    needHist(r.ex, r.sym);
    const h = histAvg(r.ex, r.sym, r.ivh);
    const spr = spotSpreadPct(r.ex, r.base);
    const hc = h.avg == null ? null : honestCarry({
      dailyNowPct: r.dailyPct, avgDaily: h.avg, spotFee: fees.spot[r.ex] ?? 0.1, futFee: fees.fut[r.ex] ?? 0.05,
      spreadPct: (spr + PERP_SPREAD) / 2, capital: I, days: d,
    });
    return { ...r, h, hc, spike: h.avg != null && r.dailyPct > 3 * Math.max(h.avg, 0.0001) };
  }).sort((a, b) => (b.hc?.netUsd ?? -1e9) - (a.hc?.netUsd ?? -1e9));
  const bc = c.find((r) => r.hc);
  bestBanner("#fdBest", bc && { usd: bc.hc.netUsd, label: `${bc.base} on ${nm(bc.ex)}, ${d} day${d > 1 ? "s" : ""}, $${(I / 2).toFixed(0)} spot + $${(I / 2).toFixed(0)} margin` }, I, "funding trade");

  const sc = spread.sort((a, b) => b.dailyPct - a.dailyPct).slice(0, 20).map((r) => {
    needHist(r.shortEx, r.shortSym);
    needHist(r.longEx, r.longSym);
    const hs = histAvg(r.shortEx, r.shortSym, r.shortIv);
    const hl = histAvg(r.longEx, r.longSym, r.longIv);
    const loading = hs.loading || hl.loading;
    const avgDiff = hs.avg != null && hl.avg != null ? hs.avg - hl.avg : null;
    const hc = avgDiff == null ? null : honestSpread({
      diffNowDaily: r.dailyPct, diffAvgDaily: avgDiff, futFeeA: fees.fut[r.shortEx] ?? 0.05, futFeeB: fees.fut[r.longEx] ?? 0.05,
      spreadPct: PERP_SPREAD, capital: I, days: d,
    });
    return { ...r, loading, avgDiff, hc };
  }).sort((a, b) => (b.hc?.netUsd ?? -1e9) - (a.hc?.netUsd ?? -1e9));

  $("#fdInfo").textContent = `${c.filter((r) => r.hc && r.hc.netUsd > 0).length} carry + ${sc.filter((r) => r.hc && r.hc.netUsd > 0).length} spread trades make money after costs`;
  const avgCell = (h, ivh) => h.loading ? '<span class="muted">checking…</span>'
    : h.avg == null ? `<span class="muted">${h.why} — not counted</span>` : `${(h.avg / (24 / ivh)).toFixed(4)}%`;
  $("#fdCarry tbody").innerHTML = c.length ? c.map((r) => `<tr>
    <td class="l"><b>${r.base}</b></td><td>${nm(r.ex)}${r.spot ? "" : ' <span class="sus">no liquid spot</span>'}</td>
    <td>${r.ratePct.toFixed(4)}% / ${r.ivh}h${r.spike ? ' <span class="sus" title="Today is far above its 3-day average; it usually falls back">spike</span>' : ""}</td>
    <td>${avgCell(r.h, r.ivh)}</td>
    <td>${r.hc ? `${(r.hc.usedDaily).toFixed(3)}%/day` : "—"}</td>
    <td>${r.hc ? `$${r.hc.costUsd.toFixed(2)}` : "—"}</td>
    <td>${r.hc ? span(r.hc.breakevenDays) : "—"}</td>
    <td>${r.hc ? money(r.hc.netUsd) : '<span class="muted">—</span>'}</td></tr>`).join("")
    : empty(8, "Loading…");
  $("#fdSpread tbody").innerHTML = sc.length ? sc.map((r) => `<tr>
    <td class="l"><b>${r.base}</b></td><td>${nm(r.shortEx)} ${r.shortRate.toFixed(4)}%/${r.shortIv}h</td>
    <td>${nm(r.longEx)} ${r.longRate.toFixed(4)}%/${r.longIv}h</td><td>${r.dailyPct.toFixed(3)}%/day</td>
    <td>${r.loading ? '<span class="muted">checking…</span>' : r.avgDiff == null ? '<span class="muted">no history — not counted</span>' : `${r.avgDiff.toFixed(3)}%/day`}</td>
    <td>${r.hc ? `$${r.hc.costUsd.toFixed(2)}` : "—"}</td><td>${r.hc ? span(r.hc.breakevenDays) : "—"}</td>
    <td>${r.hc ? money(r.hc.netUsd) : '<span class="muted">—</span>'}</td></tr>`).join("")
    : empty(8, "Loading…");
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
  renderStatus();
  $("#updated").textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

// ---------- events
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${b.dataset.tab}`));
  store.set("arbscan-tab", b.dataset.tab);
}));
["#triEx", "#triStart", "#triMin", "#triFit", "#triClean"].forEach((s) => $(s).addEventListener("input", renderTri));
["#crMin", "#crFit", "#crClean"].forEach((s) => $(s).addEventListener("input", renderCross));
["#fdDays", "#fdSpotOnly"].forEach((s) => $(s).addEventListener("input", renderFunding));
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
$("#refresh").addEventListener("click", () => { refreshSpot(); refreshFut(); });

let timer = null;
function schedule() {
  clearInterval(timer);
  if (!$("#auto").checked) return;
  const sec = parseInt($("#every").value, 10) || 10;
  timer = setInterval(() => {
    if (document.hidden) return;
    refreshSpot();
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
schedule();
