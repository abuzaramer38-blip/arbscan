// Funding-rate history (last ~3 days) per exchange, public endpoints only.
// Returns [{t: ms, rate: fraction}] newest first.
import { getJSON } from "./exchanges.js";

const n = (x) => {
  const v = parseFloat(x);
  return Number.isFinite(v) ? v : null;
};
const DAY = 86400000;

const H = {
  async binance(sym) {
    const j = await getJSON(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&limit=30`);
    return j.map((x) => ({ t: +x.fundingTime, rate: n(x.fundingRate) }));
  },
  async bybit(sym) {
    const j = await getJSON(`https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${sym}&limit=30`);
    return (j.result?.list || []).map((x) => ({ t: +x.fundingRateTimestamp, rate: n(x.fundingRate) }));
  },
  async okx(sym) {
    const j = await getJSON(`https://www.okx.com/api/v5/public/funding-rate-history?instId=${sym}&limit=30`);
    return (j.data || []).map((x) => ({ t: +x.fundingTime, rate: n(x.realizedRate ?? x.fundingRate) }));
  },
  async bitget(sym) {
    const j = await getJSON(`https://api.bitget.com/api/v2/mix/market/history-fund-rate?symbol=${sym}&productType=USDT-FUTURES&pageSize=30`);
    return (j.data || []).map((x) => ({ t: +x.fundingTime, rate: n(x.fundingRate) }));
  },
  async mexc(sym) {
    const j = await getJSON(`https://contract.mexc.com/api/v1/contract/funding_rate/history?symbol=${sym}&page_num=1&page_size=30`);
    return (j.data?.resultList || []).map((x) => ({ t: +x.settleTime, rate: n(x.fundingRate) }));
  },
  async gate(sym) {
    const j = await getJSON(`https://api.gateio.ws/api/v4/futures/usdt/funding_rate?contract=${sym}&limit=30`);
    return j.map((x) => ({ t: +x.t * 1000, rate: n(x.r) }));
  },
  async kucoin(sym) {
    const to = Date.now();
    const j = await getJSON(`https://api-futures.kucoin.com/api/v1/contract/funding-rates?symbol=${sym}&from=${to - 3 * DAY}&to=${to}`);
    return (j.data || []).map((x) => ({ t: +x.timepoint, rate: n(x.fundingRate) }));
  },
  async htx(sym) {
    const j = await getJSON(`https://api.hbdm.com/linear-swap-api/v1/swap_historical_funding_rate?contract_code=${sym}&page_size=30`);
    return (j.data?.data || []).map((x) => ({ t: +x.funding_time, rate: n(x.realized_rate ?? x.funding_rate) }));
  },
};

export async function fundingHistory(ex, sym) {
  const f = H[ex];
  if (!f) throw new Error(`unknown exchange ${ex}`);
  const rows = await f(sym);
  const since = Date.now() - 3 * DAY;
  return rows.filter((r) => r.rate != null && Number.isFinite(r.t) && r.t >= since).sort((a, b) => b.t - a.t);
}
