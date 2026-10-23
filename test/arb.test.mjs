import assert from "node:assert/strict";
import { triangular, crossExchange, funding } from "../arb.js";

// 1) Triangular: fair prices + fees => negative; injected mispricing => positive and exactly computed
const fair = [
  ["BTC", "USDT", 60000, 60000, 1, 1],
  ["ETH", "USDT", 3000, 3000, 10, 10],
  ["ETH", "BTC", 0.05, 0.05, 10, 10],
];
let r = triangular(fair, 0.1, ["USDT"], -10);
assert.ok(r.length >= 2, "should find both directions");
for (const x of r) assert.ok(Math.abs(x.pct - ((0.999 ** 3) - 1) * 100) < 1e-9, "fair loop = -3 fees");

const mis = [
  ["BTC", "USDT", 60000, 60000, 1, 1],
  ["ETH", "USDT", 3000, 3000, 10, 10],
  ["ETH", "BTC", 0.0505, 0.0505, 10, 10], // ETH rich vs BTC
];
r = triangular(mis, 0.0, ["USDT"], -10);
const best = r[0];
assert.equal(best.path, "USDT → ETH → BTC → USDT");
// 1 USDT -> 1/3000 ETH -> *0.0505 BTC -> *60000 USDT = 1.01
assert.ok(Math.abs(best.pct - 1.0) < 1e-9, `got ${best.pct}`);
// capacity: leg1 3000*10=30000 USDT; leg2 sells 10 ETH = 30000 USDT; leg3 sells 1 BTC: 1/(1/3000*0.0505)=59405.9 USDT
assert.ok(Math.abs(best.maxStart - 30000) < 1e-6, `cap ${best.maxStart}`);

// 2) Cross exchange
const cx = crossExchange({
  a: [["SOL", "USDT", 99, 100, 5, 5]],
  b: [["SOL", "USDT", 101, 102, 3, 3]],
}, { a: 0.1, b: 0.1 }, "USDT", -10);
const top = cx[0];
assert.equal(top.buyEx, "a");
assert.equal(top.sellEx, "b");
assert.ok(Math.abs(top.pct - ((101 * 0.999 * 0.999) / 100 - 1) * 100) < 1e-9);
assert.ok(Math.abs(top.maxUsd - 3 * 100) < 1e-9);

// 3) Funding: 0.01% per 8h => 0.03%/day; fees 2*(0.1+0.05)=0.3% => breakeven 10 days
const fr = funding({ x: [["BTC", 0.0001, 8, 0, 60000, "BTCUSDT"]], y: [["BTC", -0.0001, 4, 0, 60000, "BTCUSDT"]] },
  { x: [["BTC", "USDT", 1, 1, 1, 1]] }, { x: 0.1 }, { x: 0.05, y: 0.05 }, 7);
const c = fr.carry[0];
assert.ok(Math.abs(c.dailyPct - 0.03) < 1e-9 && Math.abs(c.breakevenDays - 10) < 1e-9 && c.spot === true);
const s = fr.spread[0];
// y: -0.01% per 4h = -0.02% per 8h ; diff8 = 0.03% ; daily = 0.09%
assert.equal(s.shortEx, "x");
assert.equal(s.longEx, "y");
assert.ok(Math.abs(s.diff8Pct - 0.03) < 1e-9 && Math.abs(s.apr - 0.03 * 3 * 365) < 1e-9);
// 4) junk filter: leveraged tokens + low volume removed; quote converted to USD
import { cleanMarkets, quoteUsdMap } from "../arb.js";
const raw = [
  ["BTC", "USDT", 60000, 60000, 1, 1, 5e8],
  ["BTC3L", "USDT", 1, 1.01, 1, 1, 9e6],        // leveraged -> dropped
  ["JUP", "USDT", 0.5, 0.501, 1, 1, 2e6],        // NOT leveraged (no base "J")
  ["ETH", "BTC", 0.05, 0.05, 1, 1, 10],          // 10 BTC volume = $600k
  ["DEAD", "BTC", 0.0000001, 0.0000002, 1, 1, 0.01], // $600 -> dropped
  ["ASTER", "THB", 23.9, 24, 1, 1, 1e6],         // 1M THB = ~$29.7k -> dropped at $100k
  ["SOL", "THB", 5000, 5010, 1, 1, 1e8],          // 100M THB = ~$2.97M -> kept
  ["USDT", "THB", 33.6, 33.7, 1, 1, 1e8],
];
const qu = quoteUsdMap(raw);
assert.ok(Math.abs(qu.BTC - 60000) < 1e-9 && Math.abs(qu.THB - 1 / 33.65) < 1e-12);
const cl = cleanMarkets(raw, 100000).map((m) => m[0] + "/" + m[1]);
assert.deepEqual(cl.sort(), ["BTC/USDT", "ETH/BTC", "JUP/USDT", "SOL/THB", "USDT/THB"].sort(), cl.join(","));
const solThb = cleanMarkets(raw, 0).find((m) => m[0] === "SOL" && m[1] === "THB");
assert.ok(Math.abs(solThb[7] - 1e8 / 33.65) < 1, "usd volume");
console.log("all arbitrage math tests passed");

// 5) honest profit
import { honestCarry, honestOneOff, avgDailyPct } from "../arb.js";
// IRYS-like spike: now 1.8188%/4h = 10.91%/day; 3-day avg 0.05%/4h = 0.3%/day
const avg = avgDailyPct([{ rate: 0.0005 }, { rate: 0.0005 }, { rate: 0.0005 }], 4);
assert.ok(Math.abs(avg - 0.3) < 1e-9);
const hc = honestCarry({ dailyNowPct: 10.9128, avgDaily: avg, spotFee: 0.1, futFee: 0.06, spreadPct: 0.1, capital: 100, days: 7 });
// $50 position * 0.3%/day * 7 = $1.05 ; costs = 50*(0.2+0.12)/100 + 50*0.2/100 = 0.16+0.10 = 0.26
assert.ok(Math.abs(hc.netUsd - (1.05 - 0.26)) < 1e-9, `carry ${hc.netUsd}`);
assert.equal(honestCarry({ dailyNowPct: 5, avgDaily: null, spotFee: 0.1, futFee: 0.1, spreadPct: 0, capital: 100, days: 7 }), null);
const o = honestOneOff({ pct: 1, maxSize: 12, capital: 1000, fixedCostUsd: 1 });
assert.ok(Math.abs(o.netUsd - (0.12 - 1)) < 1e-9 && o.partial);
assert.equal(honestOneOff({ pct: 1, maxSize: null, capital: 100 }), null);
console.log("honest profit tests passed");
// 6) interval taken from history timestamps (exchange says 8h but really pays hourly)
import { histInterval } from "../arb.js";
const hourly = Array.from({ length: 10 }, (_, i) => ({ t: 1e12 - i * 3600000, rate: 0.001 }));
assert.equal(histInterval(hourly), 1);
assert.ok(Math.abs(avgDailyPct(hourly, 8) - 2.4) < 1e-9, "0.1%/h = 2.4%/day, not 0.3%");
console.log("interval tests passed");
