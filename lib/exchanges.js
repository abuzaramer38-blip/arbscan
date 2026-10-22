// Public market data adapters for 8 exchanges. Read-only: no API keys, no trading.
// spot()    -> [[base, quote, bid, ask, bidQty, askQty, quoteVolume24h], ...]   (only actively trading markets)
// futures() -> [[base, fundingRate, intervalHours, nextFundingMs, markPrice, symbol], ...]  (USDT linear perpetuals)

const TIMEOUT_MS = 9000;
const META_TTL_MS = 30 * 60 * 1000;
const metaCache = new Map();

export async function getJSON(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { "accept": "application/json", "user-agent": "arbscan/1.0" },
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url.split("?")[0]} ${text.slice(0, 120)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

async function cached(key, fn) {
  const hit = metaCache.get(key);
  if (hit && Date.now() - hit.t < META_TTL_MS) return hit.v;
  const v = await fn();
  metaCache.set(key, { t: Date.now(), v });
  return v;
}

async function firstOk(urls) {
  let err;
  for (const u of urls) {
    try {
      return await getJSON(u);
    } catch (e) {
      err = e;
    }
  }
  throw err;
}

const num = (x) => {
  const v = parseFloat(x);
  return Number.isFinite(v) ? v : 0;
};
const U = (s) => String(s || "").toUpperCase();
// 1000PEPE -> PEPE, 1000000MOG -> MOG, 1MBABYDOGE -> BABYDOGE (futures contracts quoted in bundles)
export function normBase(b) {
  b = U(b);
  if (b === "XBT") return "BTC";
  const m = b.match(/^(1000000|100000|10000|1000|100|1M)(?=[A-Z]{2,})/);
  return m ? b.slice(m[1].length) : b;
}
const row = (base, quote, bid, ask, bq, aq, qv) => [U(base), U(quote), num(bid), num(ask), num(bq), num(aq), num(qv)];
const valid = (r) => r[2] > 0 && r[3] > 0 && r[3] >= r[2];

// ---------------------------------------------------------------- Binance
const BINANCE_HOSTS = ["https://api.binance.com", "https://data-api.binance.vision", "https://api1.binance.com"];
const binance = {
  async spot() {
    const info = await cached("binance-info", () =>
      firstOk(BINANCE_HOSTS.map((h) => `${h}/api/v3/exchangeInfo?symbolStatus=TRADING`)));
    const meta = new Map(info.symbols.filter((s) => s.status === "TRADING").map((s) => [s.symbol, s]));
    const book = await firstOk(BINANCE_HOSTS.map((h) => `${h}/api/v3/ticker/24hr`));
    return book.filter((t) => meta.has(t.symbol)).map((t) => {
      const m = meta.get(t.symbol);
      return row(m.baseAsset, m.quoteAsset, t.bidPrice, t.askPrice, t.bidQty, t.askQty, t.quoteVolume);
    }).filter(valid);
  },
  async futures() {
    const [pi, fi] = await Promise.all([
      getJSON("https://fapi.binance.com/fapi/v1/premiumIndex"),
      getJSON("https://fapi.binance.com/fapi/v1/fundingInfo").catch(() => []),
    ]);
    const iv = new Map(fi.map((x) => [x.symbol, num(x.fundingIntervalHours) || 8]));
    return pi.filter((x) => x.symbol.endsWith("USDT") && x.lastFundingRate !== "")
      .map((x) => [normBase(x.symbol.slice(0, -4)), num(x.lastFundingRate), iv.get(x.symbol) || 8,
        num(x.nextFundingTime), num(x.markPrice), x.symbol]);
  },
};

// ---------------------------------------------------------------- MEXC
const mexc = {
  async spot() {
    const info = await cached("mexc-info", () => getJSON("https://api.mexc.com/api/v3/exchangeInfo"));
    const ok = (s) => (s.status === "1" || s.status === "ENABLED" || s.status === "TRADING") && s.isSpotTradingAllowed !== false;
    const meta = new Map(info.symbols.filter(ok).map((s) => [s.symbol, s]));
    const book = await getJSON("https://api.mexc.com/api/v3/ticker/24hr");
    return book.filter((t) => meta.has(t.symbol)).map((t) => {
      const m = meta.get(t.symbol);
      return row(m.baseAsset, m.quoteAsset, t.bidPrice, t.askPrice, t.bidQty, t.askQty, t.quoteVolume);
    }).filter(valid);
  },
  async futures() {
    const j = await getJSON("https://contract.mexc.com/api/v1/contract/ticker");
    return (j.data || []).filter((x) => x.symbol.endsWith("_USDT"))
      .map((x) => [normBase(x.symbol.slice(0, -5)), num(x.fundingRate), 8, 0, num(x.fairPrice || x.lastPrice), x.symbol]);
  },
};

// ---------------------------------------------------------------- Bitget
const bitget = {
  async spot() {
    const info = await cached("bitget-info", () => getJSON("https://api.bitget.com/api/v2/spot/public/symbols"));
    const meta = new Map(info.data.filter((s) => s.status === "online").map((s) => [s.symbol, s]));
    const t = await getJSON("https://api.bitget.com/api/v2/spot/market/tickers");
    return t.data.filter((x) => meta.has(x.symbol)).map((x) => {
      const m = meta.get(x.symbol);
      return row(m.baseCoin, m.quoteCoin, x.bidPr, x.askPr, x.bidSz, x.askSz, x.quoteVolume);
    }).filter(valid);
  },
  async futures() {
    const [t, fr] = await Promise.all([
      getJSON("https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES"),
      getJSON("https://api.bitget.com/api/v2/mix/market/current-fund-rate?productType=USDT-FUTURES").catch(() => ({ data: [] })),
    ]);
    const iv = new Map((fr.data || []).map((x) => [x.symbol, [num(x.fundingRateInterval) || 8, num(x.nextUpdate)]]));
    return t.data.filter((x) => x.symbol.endsWith("USDT")).map((x) => {
      const [h, nx] = iv.get(x.symbol) || [8, 0];
      return [normBase(x.symbol.slice(0, -4)), num(x.fundingRate), h, nx, num(x.markPrice || x.lastPr), x.symbol];
    });
  },
};

// ---------------------------------------------------------------- Bybit
const bybit = {
  async spot() {
    const info = await cached("bybit-info", () => getJSON("https://api.bybit.com/v5/market/instruments-info?category=spot"));
    const meta = new Map(info.result.list.filter((s) => s.status === "Trading").map((s) => [s.symbol, s]));
    const t = await getJSON("https://api.bybit.com/v5/market/tickers?category=spot");
    return t.result.list.filter((x) => meta.has(x.symbol)).map((x) => {
      const m = meta.get(x.symbol);
      return row(m.baseCoin, m.quoteCoin, x.bid1Price, x.ask1Price, x.bid1Size, x.ask1Size, x.turnover24h);
    }).filter(valid);
  },
  async futures() {
    const t = await getJSON("https://api.bybit.com/v5/market/tickers?category=linear");
    return t.result.list.filter((x) => x.symbol.endsWith("USDT") && x.fundingRate !== "")
      .map((x) => [normBase(x.symbol.slice(0, -4)), num(x.fundingRate), num(x.fundingIntervalHour) || 8,
        num(x.nextFundingTime), num(x.markPrice), x.symbol]);
  },
};

// ---------------------------------------------------------------- OKX
const okx = {
  async spot() {
    const t = await getJSON("https://www.okx.com/api/v5/market/tickers?instType=SPOT");
    return t.data.map((x) => {
      const [b, q] = x.instId.split("-");
      return row(b, q, x.bidPx, x.askPx, x.bidSz, x.askSz, x.volCcy24h);
    }).filter(valid);
  },
  async futures() {
    // OKX only publishes funding per instrument; "ANY" returns all perpetuals where supported.
    const j = await getJSON("https://www.okx.com/api/v5/public/funding-rate?instId=ANY");
    return (j.data || []).filter((x) => x.instId.endsWith("-USDT-SWAP")).map((x) => {
      const iv = num(x.fundingTime) && num(x.nextFundingTime) ? (num(x.nextFundingTime) - num(x.fundingTime)) / 3600000 : 8;
      return [normBase(x.instId.split("-")[0]), num(x.fundingRate), iv || 8, num(x.fundingTime), 0, x.instId];
    });
  },
};

// ---------------------------------------------------------------- Gate
const gate = {
  async spot() {
    const pairs = await cached("gate-info", () => getJSON("https://api.gateio.ws/api/v4/spot/currency_pairs"));
    const meta = new Map(pairs.filter((p) => p.trade_status === "tradable").map((p) => [p.id, p]));
    const t = await getJSON("https://api.gateio.ws/api/v4/spot/tickers");
    return t.filter((x) => meta.has(x.currency_pair)).map((x) => {
      const m = meta.get(x.currency_pair);
      return row(m.base, m.quote, x.highest_bid, x.lowest_ask, x.highest_size, x.lowest_size, x.quote_volume);
    }).filter(valid);
  },
  async futures() {
    const c = await getJSON("https://api.gateio.ws/api/v4/futures/usdt/contracts");
    return c.filter((x) => !x.in_delisting && x.name.endsWith("_USDT"))
      .map((x) => [normBase(x.name.slice(0, -5)), num(x.funding_rate), num(x.funding_interval) / 3600 || 8,
        num(x.funding_next_apply) * 1000, num(x.mark_price), x.name]);
  },
};

// ---------------------------------------------------------------- KuCoin
const kucoin = {
  async spot() {
    const info = await cached("kucoin-info", () => getJSON("https://api.kucoin.com/api/v2/symbols"));
    const meta = new Map(info.data.filter((s) => s.enableTrading).map((s) => [s.symbol, s]));
    const t = await getJSON("https://api.kucoin.com/api/v1/market/allTickers");
    return t.data.ticker.filter((x) => meta.has(x.symbol)).map((x) => {
      const m = meta.get(x.symbol);
      return row(m.baseCurrency, m.quoteCurrency, x.buy, x.sell, x.bestBidSize, x.bestAskSize, x.volValue);
    }).filter(valid);
  },
  async futures() {
    const j = await getJSON("https://api-futures.kucoin.com/api/v1/contracts/active");
    return j.data.filter((x) => x.quoteCurrency === "USDT" && x.isInverse === false && x.fundingFeeRate != null)
      .map((x) => [normBase(x.baseCurrency), num(x.fundingFeeRate), num(x.fundingRateGranularity) / 3600000 || 8,
        num(x.nextFundingRateDateTime) || (Date.now() + num(x.nextFundingRateTime)), num(x.markPrice), x.symbol]);
  },
};

// ---------------------------------------------------------------- HTX (Huobi)
const htx = {
  async spot() {
    const info = await cached("htx-info", () => getJSON("https://api.huobi.pro/v1/common/symbols"));
    const meta = new Map(info.data.filter((s) => s.state === "online").map((s) => [s.symbol, s]));
    const t = await getJSON("https://api.huobi.pro/market/tickers");
    return t.data.filter((x) => meta.has(x.symbol)).map((x) => {
      const m = meta.get(x.symbol);
      return row(m["base-currency"], m["quote-currency"], x.bid, x.ask, x.bidSize, x.askSize, x.vol);
    }).filter(valid);
  },
  async futures() {
    const j = await getJSON("https://api.hbdm.com/linear-swap-api/v1/swap_batch_funding_rate");
    return (j.data || []).filter((x) => x.contract_code.endsWith("-USDT") && x.funding_rate != null)
      .map((x) => [normBase(x.contract_code.split("-")[0]), num(x.funding_rate), 8, num(x.funding_time), 0, x.contract_code]);
  },
};

export const EXCHANGES = { binance, bybit, okx, bitget, mexc, gate, kucoin, htx };
