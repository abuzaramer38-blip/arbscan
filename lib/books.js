// Perpetual best bid/ask (for perp-vs-perp price gaps) and spot order-book depth (for real fill checks).
// perps(ex) -> [[base, bid, ask, bidQtyBase, askQtyBase, vol24hUsd, symbol], ...]  qty 0 = unknown
// depth(ex, base, quote) -> { bids: [[price, qty]], asks: [[price, qty]] }  best first
import { getJSON, cached, firstOk, normBase } from "./exchanges.js";

const num = (x) => {
  const v = parseFloat(x);
  return Number.isFinite(v) ? v : 0;
};
const ok = (r) => r[1] > 0 && r[2] > 0 && r[2] >= r[1];

const PERPS = {
  async binance() {
    const [bt, t24] = await Promise.all([
      getJSON("https://fapi.binance.com/fapi/v1/ticker/bookTicker"),
      getJSON("https://fapi.binance.com/fapi/v1/ticker/24hr").catch(() => []),
    ]);
    const vol = new Map(t24.map((x) => [x.symbol, num(x.quoteVolume)]));
    return bt.filter((x) => x.symbol.endsWith("USDT"))
      .map((x) => [normBase(x.symbol.slice(0, -4)), num(x.bidPrice), num(x.askPrice), num(x.bidQty), num(x.askQty), vol.get(x.symbol) || 0, x.symbol]);
  },
  async bybit() {
    const t = await getJSON("https://api.bybit.com/v5/market/tickers?category=linear");
    return t.result.list.filter((x) => x.symbol.endsWith("USDT"))
      .map((x) => [normBase(x.symbol.slice(0, -4)), num(x.bid1Price), num(x.ask1Price), num(x.bid1Size), num(x.ask1Size), num(x.turnover24h), x.symbol]);
  },
  async okx() {
    const [inst, t] = await Promise.all([
      cached("okx-swap-inst", () => getJSON("https://www.okx.com/api/v5/public/instruments?instType=SWAP")),
      getJSON("https://www.okx.com/api/v5/market/tickers?instType=SWAP"),
    ]);
    const ct = new Map((inst.data || []).map((x) => [x.instId, num(x.ctVal) || 1]));
    return (t.data || []).filter((x) => x.instId.endsWith("-USDT-SWAP")).map((x) => {
      const c = ct.get(x.instId) || 0;
      return [normBase(x.instId.split("-")[0]), num(x.bidPx), num(x.askPx), num(x.bidSz) * c, num(x.askSz) * c,
        num(x.volCcy24h) * num(x.last), x.instId];
    });
  },
  async bitget() {
    const t = await getJSON("https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES");
    return t.data.filter((x) => x.symbol.endsWith("USDT"))
      .map((x) => [normBase(x.symbol.slice(0, -4)), num(x.bidPr), num(x.askPr), num(x.bidSz), num(x.askSz),
        num(x.usdtVolume || x.quoteVolume), x.symbol]);
  },
  async mexc() {
    const j = await getJSON("https://contract.mexc.com/api/v1/contract/ticker");
    return (j.data || []).filter((x) => x.symbol.endsWith("_USDT"))
      .map((x) => [normBase(x.symbol.slice(0, -5)), num(x.bid1), num(x.ask1), 0, 0, num(x.amount24), x.symbol]);
  },
  async gate() {
    const [c, t] = await Promise.all([
      cached("gate-fut-contracts", () => getJSON("https://api.gateio.ws/api/v4/futures/usdt/contracts")),
      getJSON("https://api.gateio.ws/api/v4/futures/usdt/tickers"),
    ]);
    const mult = new Map(c.filter((x) => !x.in_delisting).map((x) => [x.name, num(x.quanto_multiplier) || 1]));
    return t.filter((x) => mult.has(x.contract)).map((x) => {
      const m = mult.get(x.contract);
      return [normBase(x.contract.slice(0, -5)), num(x.highest_bid), num(x.lowest_ask), num(x.highest_size) * m,
        num(x.lowest_size) * m, num(x.volume_24h_quote), x.contract];
    });
  },
  async kucoin() {
    const [c, t] = await Promise.all([
      cached("kucoin-fut-contracts", () => getJSON("https://api-futures.kucoin.com/api/v1/contracts/active")),
      getJSON("https://api-futures.kucoin.com/api/v1/allTickers"),
    ]);
    const meta = new Map(c.data.filter((x) => x.quoteCurrency === "USDT" && x.isInverse === false)
      .map((x) => [x.symbol, x]));
    return (t.data || []).filter((x) => meta.has(x.symbol)).map((x) => {
      const m = meta.get(x.symbol);
      const mult = num(m.multiplier) || 1;
      return [normBase(m.baseCurrency), num(x.bestBidPrice), num(x.bestAskPrice), num(x.bestBidSize) * mult,
        num(x.bestAskSize) * mult, num(m.turnoverOf24h), x.symbol];
    });
  },
  async htx() {
    const [info, t] = await Promise.all([
      cached("htx-swap-info", () => getJSON("https://api.hbdm.com/linear-swap-api/v1/swap_contract_info?business_type=swap")),
      getJSON("https://api.hbdm.com/linear-swap-ex/market/detail/batch_merged?business_type=swap"),
    ]);
    const size = new Map((info.data || []).map((x) => [x.contract_code, num(x.contract_size) || 1]));
    return (t.ticks || []).filter((x) => x.contract_code.endsWith("-USDT") && size.has(x.contract_code)).map((x) => {
      const s = size.get(x.contract_code);
      const bid = x.bid || [];
      const ask = x.ask || [];
      return [normBase(x.contract_code.split("-")[0]), num(bid[0]), num(ask[0]), num(bid[1]) * s, num(ask[1]) * s,
        num(x.trade_turnover), x.contract_code];
    });
  },
};

export async function perps(ex) {
  const f = PERPS[ex];
  if (!f) throw new Error(`unknown exchange ${ex}`);
  return (await f()).filter(ok);
}

// ------------------------------------------------------------------ spot depth
const BINANCE_HOSTS = ["https://api.binance.com", "https://data-api.binance.vision", "https://api1.binance.com"];
const pairs = (rows) => (rows || []).map((r) => [num(r[0]), num(r[1])]).filter((r) => r[0] > 0 && r[1] > 0);

const DEPTH = {
  async binance(b, q) {
    const j = await firstOk(BINANCE_HOSTS.map((h) => `${h}/api/v3/depth?symbol=${b}${q}&limit=50`));
    return { bids: pairs(j.bids), asks: pairs(j.asks) };
  },
  async mexc(b, q) {
    const j = await getJSON(`https://api.mexc.com/api/v3/depth?symbol=${b}${q}&limit=50`);
    return { bids: pairs(j.bids), asks: pairs(j.asks) };
  },
  async bybit(b, q) {
    const j = await getJSON(`https://api.bybit.com/v5/market/orderbook?category=spot&symbol=${b}${q}&limit=50`);
    return { bids: pairs(j.result?.b), asks: pairs(j.result?.a) };
  },
  async okx(b, q) {
    const j = await getJSON(`https://www.okx.com/api/v5/market/books?instId=${b}-${q}&sz=50`);
    const d = (j.data || [])[0] || {};
    return { bids: pairs(d.bids), asks: pairs(d.asks) };
  },
  async bitget(b, q) {
    const j = await getJSON(`https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${b}${q}&type=step0&limit=50`);
    return { bids: pairs(j.data?.bids), asks: pairs(j.data?.asks) };
  },
  async gate(b, q) {
    const j = await getJSON(`https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${b}_${q}&limit=50`);
    return { bids: pairs(j.bids), asks: pairs(j.asks) };
  },
  async kucoin(b, q) {
    const j = await getJSON(`https://api.kucoin.com/api/v1/market/orderbook/level2_100?symbol=${b}-${q}`);
    return { bids: pairs(j.data?.bids), asks: pairs(j.data?.asks) };
  },
  async htx(b, q) {
    const j = await getJSON(`https://api.huobi.pro/market/depth?symbol=${b.toLowerCase()}${q.toLowerCase()}&type=step0&depth=20`);
    return { bids: pairs(j.tick?.bids), asks: pairs(j.tick?.asks) };
  },
};

export async function depth(ex, base, quote = "USDT") {
  const f = DEPTH[ex];
  if (!f) throw new Error(`unknown exchange ${ex}`);
  const d = await f(base.toUpperCase(), quote.toUpperCase());
  d.bids.sort((a, b) => b[0] - a[0]);
  d.asks.sort((a, b) => a[0] - b[0]);
  return d;
}
