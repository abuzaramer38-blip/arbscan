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
console.log("all arbitrage math tests passed");
