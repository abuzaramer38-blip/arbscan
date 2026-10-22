import { triangular, crossExchange, funding, fmtPx } from "/arb.js";

const EX = ["binance", "bybit", "okx", "bitget", "mexc", "gate", "kucoin", "htx"];
const NAME = { binance: "Binance", bybit: "Bybit", okx: "OKX", bitget: "Bitget", mexc: "MEXC", gate: "Gate", kucoin: "KuCoin", htx: "HTX" };
const nm = (ex) => NAME[ex] || ex;
// Default VIP0 taker fees in % (user can edit in the Fees tab).
const DEFAULT_FEES = {
  spot: { binance: 0.1, bybit: 0.1, okx: 0.1, bitget: 0.1, mexc: 0.05, gate: 0.1, kucoin: 0.1, htx: 0.2 },
  fut: { binance: 0.05, bybit: 0.055, okx: 0.05, bitget: 0.06, mexc: 0.02, gate: 0.05, kucoin: 0.06, htx: 0.05 },
};
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};
let fees = store.get("arbscan-fees", structuredClone(DEFAULT_FEES));
const state = { spot: {}, fut: {}, spotMeta: {}, futMeta: {}, lastSpot: 0, lastFut: 0 };
const $ = (s) => document.querySelector(s);

// ---------- fetching
async function load(kind, ex) {
  const meta = kind === "spot" ? state.spotMeta : state.futMeta;
  meta[ex] = { ...(meta[ex] || {}), loading: true };
  renderStatus();
  try {
    const r = await fetch(`/api/${kind === "spot" ? "spot" : "funding"}?ex=${ex}`);
    const j = await r.json();
    if (j.ok) {
      (kind === "spot" ? state.spot : state.fut)[ex] = kind === "spot" ? j.markets : j.rows;
      meta[ex] = { ok: true, count: j.count, ms: j.ms, ts: j.ts };
    } else {
      meta[ex] = { ok: false, error: j.error || "error", ms: j.ms };
    }
  } catch (e) {
    meta[ex] = { ok: false, error: String(e.message || e) };
  }
  renderStatus();
}
async function refreshSpot() {
  await Promise.all(EX.map((ex) => load("spot", ex)));
  state.lastSpot = Date.now();
  renderAll();
}
async function refreshFut() {
  await Promise.all(EX.map((ex) => load("fut", ex)));
  state.lastFut = Date.now();
  renderFunding();
  renderFees();
}

// ---------- rendering helpers
const pct = (v, d = 3) => `<span class="${v > 0 ? "pos" : "neg"}">${v > 0 ? "+" : ""}${v.toFixed(d)}%</span>`;
const usd = (v) => (v == null ? "?" : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}k` : `$${v.toFixed(0)}`);
const days = (d) => (!Number.isFinite(d) ? "—" : d < 1 ? `${(d * 24).toFixed(1)} ghante` : `${d.toFixed(1)} din`);
const empty = (cols, msg) => `<tr><td colspan="${cols}" class="empty">${msg}</td></tr>`;

function renderStatus() {
  $("#status").innerHTML = EX.map((ex) => {
    const s = state.spotMeta[ex] || {};
    const f = state.futMeta[ex] || {};
    const cls = s.loading && !s.ok ? "wait" : s.ok ? "ok" : s.error ? "err" : "wait";
    const sp = s.ok ? `spot ${s.count} · ${s.ms}ms` : s.error ? "spot ✕" : "spot …";
    const fu = f.ok ? `futures ${f.count}` : f.error ? "futures ✕" : "futures …";
    const err = s.error || f.error;
    return `<div class="chip ${cls}" title="${(err || "").replace(/"/g, "'")}"><b>${nm(ex)}</b>${sp} · ${fu}${err ? `<span class="e">${err}</span>` : ""}</div>`;
  }).join("");
}

function renderTri() {
  const exSel = $("#triEx").value;
  const start = $("#triStart").value;
  const minPct = parseFloat($("#triMin").value) || 0;
  const minSize = parseFloat($("#triSize").value) || 0;
  let rows = [];
  for (const ex of EX) {
    if (exSel !== "all" && exSel !== ex) continue;
    const mk = state.spot[ex];
    if (!mk) continue;
    for (const r of triangular(mk, fees.spot[ex] ?? 0.1, [start], minPct, 150)) rows.push({ ex, ...r });
  }
  rows = rows.filter((r) => (r.maxStart == null ? minSize <= 0 : r.maxStart >= minSize * (start === "USDT" || start === "USDC" ? 1 : 0)))
    .sort((a, b) => b.pct - a.pct).slice(0, 200);
  $("#triInfo").textContent = `${rows.length} chakkar · ${rows.filter((r) => r.pct > 0).length} munafe mein`;
  $("#triTable tbody").innerHTML = rows.length ? rows.map((r) => `<tr>
    <td class="l">${nm(r.ex)}</td><td class="l">${r.path}</td><td class="legs">${r.legs.join("<br>")}</td>
    <td>${pct(r.pct)}${r.suspicious ? '<span class="sus">shak</span>' : ""}</td>
    <td>${r.maxStart == null ? "?" : start === "USDT" || start === "USDC" ? usd(r.maxStart) : `${r.maxStart.toPrecision(3)} ${start}`}</td></tr>`).join("")
    : empty(5, "Is filter par koi chakkar nahi. Min profit kam kar ke dekho.");
}

function renderCross() {
  const minPct = parseFloat($("#crMin").value) || 0;
  const minSize = parseFloat($("#crSize").value) || 0;
  const hide = $("#crHideSus").checked;
  let rows = crossExchange(state.spot, fees.spot, "USDT", minPct, 600)
    .filter((r) => (r.maxUsd == null || r.maxUsd >= minSize) && (!hide || r.pct < 10)).slice(0, 250);
  $("#crInfo").textContent = `${rows.length} mauqe`;
  $("#crTable tbody").innerHTML = rows.length ? rows.map((r) => `<tr>
    <td class="l"><b>${r.base}</b></td><td>${nm(r.buyEx)} @ ${fmtPx(r.buy)}</td>
    <td>${nm(r.sellEx)} @ ${fmtPx(r.sell)}</td><td>${r.gross.toFixed(3)}%</td>
    <td>${pct(r.pct)}${r.suspicious ? '<span class="sus">shak</span>' : ""}</td><td>${usd(r.maxUsd)}</td></tr>`).join("")
    : empty(6, "Is filter par koi mauqa nahi.");
}

function renderFunding() {
  const d = Math.max(1, parseFloat($("#fdDays").value) || 7);
  const spotOnly = $("#fdSpotOnly").checked;
  const { carry, spread } = funding(state.fut, state.spot, fees.spot, fees.fut, d);
  const c = carry.filter((r) => !spotOnly || r.spot).slice(0, 120);
  $("#fdInfo").textContent = `${carry.length} carry · ${spread.length} spread`;
  $("#fdCarry tbody").innerHTML = c.length ? c.map((r) => `<tr>
    <td class="l"><b>${r.base}</b></td><td>${nm(r.ex)}${r.spot ? "" : ' <span class="sus">spot nahi</span>'}</td>
    <td>${r.ratePct.toFixed(4)}%</td><td>${r.ivh}h</td><td>${r.apr.toFixed(1)}%</td><td>${r.feesPct.toFixed(2)}%</td>
    <td>${days(r.breakevenDays)}</td><td>${pct(r.netHoldPct, 2)}</td></tr>`).join("") : empty(8, "Data aa raha hai…");
  $("#fdSpread tbody").innerHTML = spread.length ? spread.slice(0, 120).map((r) => `<tr>
    <td class="l"><b>${r.base}</b></td><td>${nm(r.shortEx)} ${r.shortRate.toFixed(4)}%/${r.shortIv}h</td>
    <td>${nm(r.longEx)} ${r.longRate.toFixed(4)}%/${r.longIv}h</td><td>${r.diff8Pct.toFixed(4)}%</td>
    <td>${r.apr.toFixed(1)}%</td><td>${r.feesPct.toFixed(2)}%</td><td>${days(r.breakevenDays)}</td><td>${pct(r.netHoldPct, 2)}</td></tr>`).join("")
    : empty(8, "Data aa raha hai…");
}

function renderFees() {
  const order = [...EX].sort((a, b) => (fees.spot[a] - fees.spot[b]) || (fees.fut[a] - fees.fut[b]));
  $("#feeTable tbody").innerHTML = order.map((ex) => `<tr>
    <td class="l"><b>${nm(ex)}</b></td>
    <td><input type="number" step="0.005" min="0" data-k="spot" data-ex="${ex}" value="${fees.spot[ex]}"></td>
    <td><input type="number" step="0.005" min="0" data-k="fut" data-ex="${ex}" value="${fees.fut[ex]}"></td>
    <td>${state.spotMeta[ex]?.count ?? "—"}</td><td>${state.futMeta[ex]?.count ?? "—"}</td></tr>`).join("");
}

function renderAll() {
  renderTri();
  renderCross();
  renderFunding();
  $("#updated").textContent = `Update: ${new Date().toLocaleTimeString()}`;
}

// ---------- events
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${b.dataset.tab}`));
  store.set("arbscan-tab", b.dataset.tab);
}));
["#triEx", "#triStart", "#triMin", "#triSize"].forEach((s) => $(s).addEventListener("input", renderTri));
["#crMin", "#crSize", "#crHideSus"].forEach((s) => $(s).addEventListener("input", renderCross));
["#fdDays", "#fdSpotOnly"].forEach((s) => $(s).addEventListener("input", renderFunding));
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
$("#triEx").innerHTML += EX.map((e) => `<option value="${e}">${nm(e)}</option>`).join("");
const savedTab = store.get("arbscan-tab", "tri");
document.querySelector(`.tab[data-tab="${savedTab}"]`)?.click();
renderStatus();
renderFees();
refreshSpot();
refreshFut();
schedule();
