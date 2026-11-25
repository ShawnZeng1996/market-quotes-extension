"use strict";

const MARKET_GROUPS = [
  { key: "cn", label: "A股" },
  { key: "hk", label: "港股" },
  { key: "us", label: "美股" },
  { key: "crypto", label: "币安" },
];

const FOOTER_ITEMS = [
  { symbol: "000001.SH", name: "上证指数", market: "cn" },
  { symbol: "399001.SZ", name: "深证成指", market: "cn" },
  { symbol: "399006.SZ", name: "创业板指", market: "cn" },
  { symbol: "000300.SH", name: "沪深300", market: "cn" },
  { symbol: "000016.SH", name: "上证50", market: "cn" },
  { symbol: "000688.SH", name: "科创50", market: "cn" },
  { symbol: "HSI.HK", name: "恒生指数", market: "hk" },
  { symbol: "HSCEI.HK", name: "国企指数", market: "hk" },
  { symbol: "HSTECH.HK", name: "恒生科技", market: "hk" },
  { symbol: "IXIC.US", name: "纳斯达克", market: "us" },
  { symbol: "INX.US", name: "标普500", market: "us" },
  { symbol: "DJI.US", name: "道琼斯", market: "us" },
  { symbol: "BTCUSDT.PERP", name: "BTC 永续", market: "crypto", binanceSymbol: "BTCUSDT" },
  { symbol: "ETHUSDT.PERP", name: "ETH 永续", market: "crypto", binanceSymbol: "ETHUSDT" },
];

function normalizeTradingMarkets(value) {
  const markets = MARKET_GROUPS.map((g) => g.key);
  const selected = Array.isArray(value) ? markets.filter((m) => value.includes(m)) : [];
  return selected.length ? selected : markets;
}

function normalizeFooterSymbols(value) {
  return FOOTER_ITEMS.filter((item) => !Array.isArray(value) || value.includes(item.symbol)).map((item) => item.symbol);
}

function activeFooterItems(markets, selected) {
  return FOOTER_ITEMS.filter((item) => markets.includes(item.market) && selected.includes(item.symbol));
}

function isCnSymbol(symbol) {
  return /\.(SH|SZ|BJ)$/i.test(symbol || "");
}

function calcPositionPl(item, quote) {
  if (!quote || item.cost == null) return null;
  const cost = Number(item.cost);
  const price = Number(quote.last_price);
  if (!Number.isFinite(cost) || cost <= 0 || !Number.isFinite(price) || price <= 0) return null;
  const futures = item.symbol.endsWith(".PERP");
  const direction = futures && item.side === "short" ? -1 : 1;
  const leverage = futures ? Number(item.leverage ?? 1) : 1;
  const difference = (price - cost) * direction;
  // 数量是实际持仓量，杠杆只影响保证金收益率，不能重复放大盈亏金额。
  return {
    percent: difference / cost * leverage * 100,
    amount: item.quantity == null ? null : difference * Number(item.quantity),
  };
}

function isCnPollingTime(now = Date.now()) {
  const date = new Date(now + 8 * 3600000);
  const day = date.getUTCDay();
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  return day >= 1 && day <= 5 && minute >= 555 && minute < 900;
}

function nextCnSessionDelay(now = Date.now()) {
  const date = new Date(now + 8 * 3600000);
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - 8 * 3600000;
  for (let offset = 0; offset <= 7; offset++) {
    const dayStart = midnight + offset * 86400000;
    const day = new Date(dayStart + 8 * 3600000).getUTCDay();
    if (day === 0 || day === 6) continue;
    for (const minute of [555, 900]) {
      const boundary = dayStart + minute * 60000;
      if (boundary > now) return boundary - now;
    }
  }
}
