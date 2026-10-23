import { triangular, crossExchange, funding, cleanMarkets, fmtPx } from "/arb.js";

const EX = ["binance", "bybit", "okx", "bitget", "mexc", "gate", "kucoin", "htx"];
const NAME = { binance: "Binance", bybit: "Bybit", okx: "OKX", bitget: "Bitget", mexc: "MEXC", gate: "Gate", kucoin: "KuCoin", htx: "HTX" };
const nm = (ex) => NAME[ex] || ex;
// Default VIP0 taker fees in % (editable in the Fees tab).
const DEFAULT_FEES = {
  spot: { binance: 0.1, bybit: 0.1, okx: 0.1, bitget: 0.1, mexc: 0.05, gate: 0.1, kucoin: 0.1, htx: 0.2 },
  fut: { binance: 0.05, bybit: 0.055, okx: 0.05, bitget: 0.06, mexc: 0.02, gate: 0.05, kucoin: 0.06, htx: 0.05 },
};
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};
let fees = store.get("arbscan-fees", structuredClone(DEFAULT_FEES));
const state = { raw: {}, clean: {}, fut: {}, spotMeta: {}, futMeta: {}, lastFut: 0 };
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

// what you end up with; if the best price cannot absorb the whole investment, say how much fits
function backCell(I, p, max) {
  if (max != null && max < I) return `<span class="nofit">only $${max.toFixed(0)} fits → ${money((max * p) / 100)}</span>`;
  return `$${(I * (1 + p / 100)).toFixed(2)}`;
}

// profit only on the amount the best price can actually take
function profitFit(I, p, max) {
  if (max != null && max < I) return `${money((max * p) / 100)} <span class="nofit">only $${max.toFixed(0)} fits</span>`;
  return money((I * p) / 100);
}

function setHeaders() {
  document.querySelectorAll(".invh").forEach((th) => { th.textContent = `Profit on $${inv()}`; });
  const d = Math.max(1, parseFloat($("#fdDays").value) || 7);
  document.querySelectorAll(".netd").forEach((th) => { th.textContent = `Net after ${d} days`; });
}

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
    && (!clean || (r.pct <= 5 && (r.maxStart == null || r.maxStart >= 10))))
    .sort((a, b) => b.pct - a.pct).slice(0, 200);
  $("#triInfo").textContent = `${rows.length} routes · ${rows.filter((r) => r.pct > 0).length} profitable`;
  $("#triTable tbody").innerHTML = rows.length ? rows.map((r) => {
    const profit = (I * r.pct) / 100;
    return `<tr>
    <td class="l">${nm(r.ex)}</td><td class="l">${r.path}</td><td class="legs">${r.legs.join("<br>")}</td>
    <td>${pct(r.pct)}</td><td>${money(profit, profit !== 0 && Math.abs(profit) < 0.1 ? 3 : 2)}</td><td>${backCell(I, r.pct, r.maxStart)}</td>
    <td>${sizeCell(r.maxStart)}</td><td>${volCell(r.minVol)}</td></tr>`;
  }).join("") : empty(8, "No route matches these filters. Lower the min profit or the min 24h volume.");
}

function renderCross() {
  const minPct = parseFloat($("#crMin").value);
  const onlyFit = $("#crFit").checked;
  const I = inv();
  const clean = $("#crClean").checked;
  const rows = crossExchange(state.clean, fees.spot, "USDT", Number.isFinite(minPct) ? minPct : 0, 800)
    .filter((r) => (!onlyFit || (r.maxUsd != null && r.maxUsd >= I))
      && (!clean || (r.pct <= 10 && (r.maxUsd == null || r.maxUsd >= 10)))).slice(0, 250);
  $("#crInfo").textContent = `${rows.length} opportunities`;
  $("#crTable tbody").innerHTML = rows.length ? rows.map((r) => `<tr>
    <td class="l"><b>${r.base}</b></td><td>${nm(r.buyEx)} @ ${fmtPx(r.buy)}</td><td>${nm(r.sellEx)} @ ${fmtPx(r.sell)}</td>
    <td>${r.gross.toFixed(3)}%</td><td>${pct(r.pct)}</td><td>${profitFit(I, r.pct, r.maxUsd)}</td>
    <td>${sizeCell(r.maxUsd)}</td><td>${volCell(r.minVol)}</td></tr>`).join("")
    : empty(8, "No opportunity matches these filters.");
}

function renderFunding() {
  const d = Math.max(1, parseFloat($("#fdDays").value) || 7);
  const spotOnly = $("#fdSpotOnly").checked;
  const I = inv();
  setHeaders();
  const { carry, spread } = funding(state.fut, state.clean, fees.spot, fees.fut, d);
  const c = carry.filter((r) => !spotOnly || r.spot).slice(0, 120);
  $("#fdInfo").textContent = `${c.length} carry · ${spread.length} spread`;
  $("#fdCarry tbody").innerHTML = c.length ? c.map((r) => `<tr>
    <td class="l"><b>${r.base}</b></td><td>${nm(r.ex)}${r.spot ? "" : ' <span class="sus">no liquid spot</span>'}</td>
    <td>${r.ratePct.toFixed(4)}%</td><td>${r.ivh}h</td><td>${r.apr.toFixed(1)}%</td><td>${r.feesPct.toFixed(2)}%</td>
    <td>${span(r.breakevenDays)}</td><td>${pct(r.netHoldPct, 2)}</td><td>${money((I * r.netHoldPct) / 100)}</td></tr>`).join("")
    : empty(9, "Loading…");
  $("#fdSpread tbody").innerHTML = spread.length ? spread.slice(0, 120).map((r) => `<tr>
    <td class="l"><b>${r.base}</b></td><td>${nm(r.shortEx)} ${r.shortRate.toFixed(4)}%/${r.shortIv}h</td>
    <td>${nm(r.longEx)} ${r.longRate.toFixed(4)}%/${r.longIv}h</td><td>${r.diff8Pct.toFixed(4)}%</td>
    <td>${r.apr.toFixed(1)}%</td><td>${r.feesPct.toFixed(2)}%</td><td>${span(r.breakevenDays)}</td><td>${pct(r.netHoldPct, 2)}</td>
    <td>${money((I * r.netHoldPct) / 100)}</td></tr>`).join("")
    : empty(9, "Loading…");
}

function renderFees() {
  const order = [...EX].sort((a, b) => (fees.spot[a] - fees.spot[b]) || (fees.fut[a] - fees.fut[b]));
  $("#feeTable tbody").innerHTML = order.map((ex) => `<tr>
    <td class="l"><b>${nm(ex)}</b></td>
    <td><input type="number" step="0.005" min="0" data-k="spot" data-ex="${ex}" value="${fees.spot[ex]}"></td>
    <td><input type="number" step="0.005" min="0" data-k="fut" data-ex="${ex}" value="${fees.fut[ex]}"></td>
    <td>${state.spotMeta[ex]?.count ?? "—"}</td><td>${state.clean[ex]?.length ?? "—"}</td><td>${state.futMeta[ex]?.count ?? "—"}</td></tr>`).join("");
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
