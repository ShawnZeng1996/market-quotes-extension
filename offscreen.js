"use strict";

// Offscreen Document：持有后台 WebSocket 长连接（弹窗关闭后仍持续接收行情）。
// 注意：offscreen 不能访问 chrome.storage，行情/状态通过消息交给 Service Worker 落盘。

const WS_URL = "wss://api.tickflow.org/v1/ws/stream";
const API_BASE = "https://api.tickflow.org";
const REST_URL = `${API_BASE}/v1/quotes`;
const POLL_INTERVAL = 5000;   // 降级轮询间隔（毫秒）
const WRITE_THROTTLE = 500;   // 上报行情节流（毫秒）
const WS_RETRY_MIN = 60 * 1000;      // WS 断线后首次重连间隔
const WS_RETRY_MAX = 10 * 60 * 1000; // WS 重连最大间隔
const TENCENT_URL = "https://qt.gtimg.cn"; // 腾讯免费行情（GBK 编码，纯轮询）
const BINANCE_REST_URL = "https://data-api.binance.vision/api/v3/ticker/24hr"; // 币安免费行情
const BINANCE_FUTURES_URL = "https://fapi.binance.com/fapi/v1/ticker/24hr";
const TURNOVER_QUOTE_URL = "https://push2.eastmoney.com/api/qt/stock/get?secid=47.800004&fields=f57,f58,f48,f86&fltt=2";
const TURNOVER_TRENDS_URL = "https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=47.800004&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=2&iscr=0";

let source = "tencent";       // 数据源：tickflow | tencent
let apiKey = "";
let enabled = true;           // 是否获取行情
let watchlist = [];           // [{ symbol, name }]
let tradingMarkets = normalizeTradingMarkets();
let footerSymbols = normalizeFooterSymbols();
let generation = 0;
let stockGeneration = 0;
let futuresTimer = null;
let hkIndexTimer = null;
let turnoverTimer = null;
let turnoverPendingRun = null;
let turnoverPendingTask = null;
let marketTurnover = null;
let futuresStatus = null;
let hkIndexStatus = null;
let turnoverStatus = null;
let ws = null;
let wsRetryTimer = null;
let wsRetryDelay = WS_RETRY_MIN;
let pollTimer = null;
let binanceTimer = null;      // 币安轮询定时器
let stockMode = "idle";       // 股票通道：ws | poll | idle
let stockStatus = null;       // { mode, text }，null 表示股票通道未启用
let cryptoStatus = null;      // { ok, text }，null 表示币安通道未启用
let lastStatusKey = "";
let stopped = true;
let quotesCache = {};         // symbol -> quote（内存常驻，合并更新）
let writeTimer = null;
let lastPlState = {};         // symbol -> 'profit' | 'loss'（扭亏为盈检测基线）

function symbols() { return watchlist.map((w) => w.symbol); }

function isCryptoSymbol(symbol) {
  return !/\.(SH|SZ|BJ|HK|US)$/i.test(symbol || "");
}
function stockSymbols() { return symbols().filter((s) => !isCryptoSymbol(s)); }
function cryptoSymbols() { return symbols().filter(isCryptoSymbol); }
function footerItems() { return activeFooterItems(tradingMarkets, footerSymbols); }
function stockAllSymbols() {
  const indices = footerItems().filter((item) => item.market !== "crypto" && (source === "tencent" || item.market !== "hk"));
  return [...new Set([...stockSymbols(), ...indices.map((item) => item.symbol)])];
}
function hkIndexSymbols() {
  return source === "tencent" ? [] : footerItems().filter((item) => item.market === "hk").map((item) => item.symbol);
}
function futuresItems() {
  const items = new Map(footerItems().filter((item) => item.market === "crypto").map((item) => [item.symbol, item]));
  for (const symbol of cryptoSymbols().filter((s) => s.endsWith(".PERP"))) {
    const binanceSymbol = symbol.slice(0, -5);
    items.set(symbol, { symbol, binanceSymbol, name: `${binanceSymbol} 永续` });
  }
  return [...items.values()];
}
function allSymbols() { return [...new Set([...symbols(), ...footerItems().map((item) => item.symbol)])]; }

function send(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function sendQuotes() {
  send({ type: "quotes", data: quotesCache });
}

function scheduleWrite() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    sendQuotes();
  }, WRITE_THROTTLE);
}

// 股票与币安两路状态合并成一条展示；内容不变不重复上报
function emitStatus() {
  let mode = "idle";
  let text = "未连接";
  if (stockStatus) {
    mode = stockStatus.mode;
    text = stockStatus.text;
    if (cryptoStatus && !cryptoStatus.ok) text += " · 币安异常";
  } else if (cryptoStatus) {
    mode = "poll";
    text = cryptoStatus.text;
  } else if (hkIndexStatus) {
    mode = "poll";
    text = hkIndexStatus.text;
  } else if (futuresStatus) {
    mode = "poll";
    text = futuresStatus.text;
  } else if (turnoverStatus) {
    mode = "poll";
    text = turnoverStatus.text;
  } else if (!allSymbols().length && enabled) {
    text = "暂无关注行情";
  }
  if (hkIndexStatus && !hkIndexStatus.ok && (stockStatus || cryptoStatus)) text += " · 港股指数异常";
  if (futuresStatus && !futuresStatus.ok && (stockStatus || cryptoStatus || hkIndexStatus)) text += " · 合约异常";
  if (turnoverStatus && !turnoverStatus.ok && (stockStatus || cryptoStatus || hkIndexStatus || futuresStatus)) text += " · 成交额异常";
  const key = mode + "|" + text;
  if (key === lastStatusKey) return;
  lastStatusKey = key;
  send({ type: "status", mode, text });
}

function setStockStatus(m, text) {
  stockMode = m;
  stockStatus = { mode: m, text };
  emitStatus();
}

function setCryptoStatus(ok, text) {
  cryptoStatus = { ok, text };
  emitStatus();
}

// 移除已不在自选股里的标的残留数据
function pruneQuotes() {
  const keep = new Set(allSymbols());
  let removed = false;
  for (const s of Object.keys(quotesCache)) {
    if (!keep.has(s)) { delete quotesCache[s]; removed = true; }
  }
  return removed;
}

function stopStocks() {
  stockGeneration++;
  if (ws) {
    const old = ws;
    ws = null;
    try { old.close(); } catch (e) { /* ignore */ }
  }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
  wsRetryDelay = WS_RETRY_MIN;
}

function stopAll() {
  stopped = true;
  generation++;
  stopStocks();
  if (binanceTimer) { clearInterval(binanceTimer); binanceTimer = null; }
  if (futuresTimer) { clearInterval(futuresTimer); futuresTimer = null; }
  if (hkIndexTimer) { clearInterval(hkIndexTimer); hkIndexTimer = null; }
  if (turnoverTimer) { clearInterval(turnoverTimer); turnoverTimer = null; }
}

function start() {
  stopAll();
  stopped = false;
  stockMode = "idle";
  stockStatus = null;
  cryptoStatus = null;
  futuresStatus = null;
  hkIndexStatus = null;
  turnoverStatus = null;
  if (pruneQuotes()) scheduleWrite();
  if (!enabled) { setStockStatus("idle", "已暂停"); return; }
  startStocks();
  startCrypto();
  startFutures();
  startHkIndices();
  startMarketTurnover();
  emitStatus();
}

function startStocks() {
  if (!stockAllSymbols().length) return;
  if (source === "tencent") startTencent();
  else startTickflow();
}

function startCrypto() {
  if (!cryptoSymbols().some((s) => !s.endsWith(".PERP"))) return;
  setCryptoStatus(true, "币安现货 · 轮询中");
  pollBinanceOnce();
  binanceTimer = setInterval(pollBinanceOnce, POLL_INTERVAL);
}

function startFutures() {
  if (!futuresItems().length) return;
  futuresStatus = { ok: true, text: "币安合约 · 连接中" };
  pollFuturesOnce();
  futuresTimer = setInterval(pollFuturesOnce, POLL_INTERVAL);
}

function startHkIndices() {
  if (!hkIndexSymbols().length) return;
  // 港股指数使用腾讯命名代码，不混入 TickFlow 的股票订阅。
  hkIndexStatus = { ok: true, text: "港股指数 · 轮询中" };
  pollHkIndicesOnce();
  hkIndexTimer = setInterval(pollHkIndicesOnce, POLL_INTERVAL);
}

function startMarketTurnover() {
  if (!tradingMarkets.includes("cn")) return;
  turnoverStatus = { ok: true, text: "A股成交额 · 获取中" };
  pollMarketTurnoverOnce();
  turnoverTimer = setInterval(pollMarketTurnoverOnce, POLL_INTERVAL);
}

function startTickflow() {
  if (!apiKey) {
    setStockStatus("idle", "需要 API Key");
    return;
  }
  connectWS();
}

function startTencent() {
  setStockStatus("poll", "腾讯行情 · 轮询中");
  pollTencentOnce();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollTencentOnce, POLL_INTERVAL);
}

function connectWS() {
  if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
  if (stockMode !== "poll") setStockStatus("ws", "连接中…");
  const socket = new WebSocket(`${WS_URL}?api_key=${encodeURIComponent(apiKey)}`);
  ws = socket;

  socket.onopen = () => {
    if (ws !== socket) return;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    wsRetryDelay = WS_RETRY_MIN;
    setStockStatus("ws", "已连接");
    socket.send(JSON.stringify({
      op: "subscribe",
      channel: "quotes",
      symbols: stockAllSymbols(),
    }));
    pollOnce(); // 立即拉一次快照，开盘间隙也能先有数据
  };

  socket.onmessage = (ev) => {
    if (ws !== socket) return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.op === "quotes") handleQuotes(msg.data);
    else if (msg.op === "error") switchToPolling(false); // 服务端明确拒绝（如非 Expert 档），不再重连
  };

  const onDrop = () => {
    if (ws !== socket || stopped) return;
    switchToPolling(true);
  };
  socket.onclose = onDrop;
  socket.onerror = onDrop;
}

// 降级为 REST 轮询；retry 时按退避间隔尝试恢复 WS
function switchToPolling(retry) {
  if (ws) {
    const old = ws;
    ws = null;
    try { old.close(); } catch (e) { /* ignore */ }
  }
  if (!pollTimer) {
    setStockStatus("poll", "轮询中");
    pollOnce();
    pollTimer = setInterval(pollOnce, POLL_INTERVAL);
  }
  if (retry && !wsRetryTimer) {
    wsRetryTimer = setTimeout(() => {
      wsRetryTimer = null;
      if (!stopped && source === "tickflow" && apiKey) connectWS();
    }, wsRetryDelay);
    wsRetryDelay = Math.min(wsRetryDelay * 2, WS_RETRY_MAX);
  }
}

async function pollOnce() {
  if (!apiKey || stopped || !stockAllSymbols().length) return;
  const run = generation;
  const stockRun = stockGeneration;
  try {
    const resp = await fetch(
      `${REST_URL}?symbols=${encodeURIComponent(stockAllSymbols().join(","))}`,
      { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(10000) }
    );
    if (run !== generation || stockRun !== stockGeneration || stopped) return;
    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) {
        stopStocks();
        setStockStatus("idle", "API Key 无效");
      }
      return;
    }
    const json = await resp.json();
    if (run !== generation || stockRun !== stockGeneration || stopped) return;
    handleQuotes(json.data);
    if (stockMode === "poll") setStockStatus("poll", "轮询中");
  } catch (e) {
    if (run !== generation || stockRun !== stockGeneration || stopped) return;
    if (stockMode === "poll") setStockStatus("poll", "轮询中（网络错误）");
  }
}

// ---------- 腾讯数据源（免费行情，GBK 编码，纯轮询） ----------
// 自选股格式（代码.市场后缀）→ 腾讯请求码
function toTencentCode(symbol) {
  const parts = String(symbol).split(".");
  const code = parts[0];
  switch (parts[1]) {
    case "SH": return "sh" + code;
    case "SZ": return "sz" + code;
    case "HK": return "hk" + (/^\d+$/.test(code) ? code.padStart(5, "0") : code);
    case "US": return "us" + code;
    default: return null; // .BJ 腾讯不支持，过滤
  }
}

// 腾讯返回前缀 → 自选股格式（美股剥 .OQ 等交易所后缀）
function tencentCodeToSymbol(tcode) {
  tcode = tcode.replace(/^r_/, "");
  const market = tcode.slice(0, 2).toUpperCase(); // SH/SZ/HK/US
  let code = tcode.slice(2);
  if (market === "US") code = code.split(".")[0]; // usAAPL.OQ → AAPL
  return `${code}.${market}`;
}

// 腾讯时间戳格式不一（A股 20260918105821 / 港股 2026/09/18 10:43:14 / 美股 2026-09-17 16:00:01）→ epoch ms
function normalizeTencentTs(raw) {
  if (!raw) return null;
  const s = String(raw);
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (m) return new Date(m[1], m[2] - 1, m[3], m[4], m[5], m[6]).getTime();
  const d = new Date(s.replace(/\//g, "-").replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

// 字段数组 → 统一 quote 结构（字段见腾讯接口 ~ 分隔索引）
function mapTencentFields(symbol, fields) {
  return {
    symbol,
    name: fields[1] || "",
    last_price: Number(fields[3]),
    prev_close: Number(fields[4]) || 0,
    timestamp: normalizeTencentTs(fields[30]),
    region: symbol.split(".")[1] || "",
  };
}

function parseTencent(text) {
  const out = [];
  for (const line of text.split(";")) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^v_([^=]+)="(.*)"$/);
    if (!m) continue;
    const fields = m[2].split("~");
    const lp = Number(fields[3]);
    if (fields.length < 5 || fields[3] === "" || !Number.isFinite(lp)) continue; // 无最新价
    const symbol = tencentCodeToSymbol(m[1]);
    if (!symbol) continue;
    out.push(mapTencentFields(symbol, fields));
  }
  return out;
}

async function fetchTencentQuotes(syms) {
  const codes = syms.map(toTencentCode).filter(Boolean);
  if (!codes.length) return [];
  const resp = await fetch(`${TENCENT_URL}?q=${codes.join(",")}`, { cache: "no-store", signal: AbortSignal.timeout(10000) });
  if (!resp.ok) throw new Error("获取失败");
  const text = new TextDecoder("gbk").decode(await resp.arrayBuffer());
  return parseTencent(text);
}

async function pollTencentOnce() {
  if (stopped || source !== "tencent" || !stockAllSymbols().length) return;
  const run = generation;
  try {
    const quotes = await fetchTencentQuotes(stockAllSymbols());
    if (run !== generation || stopped) return;
    if (!quotes.length) { setStockStatus("poll", "腾讯行情 · 无数据"); return; }
    handleQuotes(quotes);
    setStockStatus("poll", "腾讯行情 · 轮询中");
  } catch (e) {
    if (run !== generation || stopped) return;
    setStockStatus("poll", "腾讯行情 · 获取失败");
  }
}

async function pollHkIndicesOnce() {
  const syms = hkIndexSymbols();
  if (stopped || !syms.length) return;
  const run = generation;
  try {
    const quotes = await fetchTencentQuotes(syms);
    if (run !== generation || stopped) return;
    handleQuotes(quotes);
    const ok = syms.every((s) => quotes.some((q) => q.symbol === s));
    hkIndexStatus = { ok, text: ok ? "港股指数 · 轮询中" : "港股指数 · 获取失败" };
  } catch (e) {
    if (run !== generation || stopped) return;
    hkIndexStatus = { ok: false, text: "港股指数 · 获取失败" };
  }
  emitStatus();
}

function turnoverClock(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error("成交额时间无效");
  const date = new Date(timestamp * 1000 + 8 * 3600000);
  if (!Number.isFinite(date.getTime())) throw new Error("成交额时间无效");
  const iso = date.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

function parseTurnoverQuote(json) {
  const q = json && json.data;
  const amount = q && q.f48 != null && String(q.f48).trim() !== "" ? Number(q.f48) : NaN;
  const timestamp = q ? Number(q.f86) : NaN;
  if (!q || q.f57 !== "800004" || !Number.isFinite(amount) || amount < 0) throw new Error("成交额无数据");
  return { amount, timestamp, ...turnoverClock(timestamp) };
}

function compareTurnover(quote, json) {
  const data = json && json.data;
  if (!data || data.code !== "800004" || !Array.isArray(data.trends)) throw new Error("成交额分时无数据");
  const days = new Map();
  for (const line of data.trends) {
    if (typeof line !== "string") throw new Error("成交额分时无效");
    const fields = line.split(",");
    const match = fields[0].match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/);
    const amount = fields[6] != null && fields[6].trim() !== "" ? Number(fields[6]) : NaN;
    if (!match || !Number.isFinite(amount) || amount < 0) throw new Error("成交额分时无效");
    if (!days.has(match[1])) days.set(match[1], new Map());
    const minutes = days.get(match[1]);
    if (minutes.has(match[2])) throw new Error("成交额分时重复");
    minutes.set(match[2], amount);
  }
  const previousDate = [...days.keys()].filter((date) => date < quote.date).sort().pop();
  const current = days.get(quote.date);
  const previous = days.get(previousDate);
  if (!current || !previous) return null;
  const clock = turnoverClock(Math.min(quote.timestamp, Number(data.time)));
  if (clock.date !== quote.date) return null;
  // 分时成交额是每分钟金额；只累加双方已完成的分钟，避免把实时总额与历史整分钟混比。
  const times = [...current.keys()].filter((time) => previous.has(time) &&
    (time < clock.time || time === clock.time && ["11:30", "15:00"].includes(time))).sort();
  const comparisonTime = times.at(-1);
  if (!comparisonTime) return null;
  let comparisonAmount = 0;
  let previousAmount = 0;
  for (let minute = 570; minute <= 900; minute++) {
    if (minute > 690 && minute < 781) continue;
    const time = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
    if (time > comparisonTime) break;
    if (!current.has(time) || !previous.has(time)) return null;
    comparisonAmount += current.get(time);
    previousAmount += previous.get(time);
  }
  return { comparisonAmount, previousAmount, comparisonTime, previousDate };
}

function publishMarketTurnover(data) {
  if (JSON.stringify(data) === JSON.stringify(marketTurnover)) return;
  marketTurnover = data;
  send({ type: "market-turnover", data });
}

function pollMarketTurnoverOnce() {
  if (stopped || !enabled || !tradingMarkets.includes("cn")) return Promise.resolve({ ok: false });
  if (turnoverPendingRun === generation) return turnoverPendingTask;
  const run = generation;
  turnoverPendingRun = run;
  turnoverPendingTask = fetchMarketTurnover(run);
  return turnoverPendingTask;
}

async function fetchMarketTurnover(run) {
  try {
    const results = await Promise.allSettled([TURNOVER_QUOTE_URL, TURNOVER_TRENDS_URL].map(async (url) => {
      const resp = await fetch(url, { credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (!resp.ok) throw new Error("成交额获取失败");
      return resp.json();
    }));
    if (run !== generation || stopped) return { ok: false };
    if (results[0].status !== "fulfilled") throw new Error("成交额获取失败");
    const quote = parseTurnoverQuote(results[0].value);
    let comparison = null;
    let comparisonError = results[1].status !== "fulfilled";
    if (!comparisonError) {
      try { comparison = compareTurnover(quote, results[1].value); }
      catch (e) { comparisonError = true; }
    }
    if (comparisonError && marketTurnover && marketTurnover.date === quote.date) {
      const { comparisonAmount, previousAmount, comparisonTime, previousDate } = marketTurnover;
      comparison = { comparisonAmount, previousAmount, comparisonTime, previousDate };
    }
    publishMarketTurnover({ ...quote, comparisonAmount: null, previousAmount: null,
      comparisonTime: null, previousDate: null, ...comparison, comparisonError, error: false });
    turnoverStatus = { ok: !comparisonError, text: comparisonError ? "A股成交额 · 同期获取失败" : "A股成交额 · 轮询中" };
    emitStatus();
    return { ok: true };
  } catch (e) {
    if (run !== generation || stopped) return { ok: false };
    publishMarketTurnover({ ...marketTurnover, error: true });
    turnoverStatus = { ok: false, text: "A股成交额 · 获取失败" };
    emitStatus();
    return { ok: false };
  } finally {
    if (turnoverPendingRun === run) {
      turnoverPendingRun = null;
      turnoverPendingTask = null;
    }
  }
}

// ---------- 币安数据源（免费行情，REST 轮询） ----------
function mapBinanceFields(t) {
  return {
    symbol: t.symbol,
    name: t.symbol,               // 币安无中文名，用代码作名称
    last_price: Number(t.lastPrice),
    prev_close: Number(t.prevClosePrice) || Number(t.openPrice) || 0,
    timestamp: Number(t.closeTime) || null,
    region: "CRYPTO",
  };
}

async function pollBinanceOnce() {
  const syms = cryptoSymbols().filter((s) => !s.endsWith(".PERP"));
  if (stopped || syms.length === 0) return;
  const run = generation;
  try {
    const resp = await fetch(
      `${BINANCE_REST_URL}?symbols=${encodeURIComponent(JSON.stringify(syms))}`,
      { cache: "no-store", signal: AbortSignal.timeout(10000) }
    );
    if (run !== generation || stopped) return;
    if (!resp.ok) { setCryptoStatus(false, "币安现货 · 获取失败"); return; }
    const data = await resp.json();
    if (run !== generation || stopped) return;
    if (!Array.isArray(data) || data.length === 0) { setCryptoStatus(false, "币安现货 · 无数据"); return; }
    handleQuotes(data.map(mapBinanceFields));
    setCryptoStatus(true, "币安现货 · 轮询中");
  } catch (e) {
    if (run !== generation || stopped) return;
    setCryptoStatus(false, "币安现货 · 轮询中（网络错误）");
  }
}

async function pollFuturesOnce() {
  const items = futuresItems();
  if (stopped || !items.length) return;
  const run = generation;
  const results = await Promise.allSettled(items.map(async (item) => {
    const resp = await fetch(`${BINANCE_FUTURES_URL}?symbol=${encodeURIComponent(item.binanceSymbol)}`, {
      cache: "no-store", signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error("获取失败");
    const t = await resp.json();
    const price = Number(t.lastPrice);
    const open = Number(t.openPrice);
    if (t.symbol !== item.binanceSymbol || !Number.isFinite(price) || price <= 0 || !Number.isFinite(open) || open <= 0) throw new Error("无数据");
    return {
      symbol: item.symbol,
      name: item.name,
      last_price: price,
      prev_close: open,
      timestamp: Number(t.closeTime) || null,
      region: "CRYPTO",
    };
  }));
  if (run !== generation || stopped) return;
  handleQuotes(results.filter((r) => r.status === "fulfilled").map((r) => r.value));
  const ok = results.every((r) => r.status === "fulfilled");
  futuresStatus = { ok, text: ok ? "币安合约 · 轮询中" : "币安合约 · 获取失败" };
  emitStatus();
}

// 扭亏为盈提示音（Web Audio 生成短促"嘀嘀"，无需音频文件）
let audioCtx = null;
function playBeep() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const now = audioCtx.currentTime;
    [880, 1046.5].forEach((freq, i) => {
      const offset = i * 0.22;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.4, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.2);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.22);
    });
  } catch (e) {
    // 播放失败静默，badge 角标仍有效
  }
}

// 检测持仓「扭亏为盈」（盈亏比例由负转正），触发后由 SW 在工具栏图标上打角标
function detectPlTurn(q) {
  const item = watchlist.find((w) => w.symbol === q.symbol);
  if (!item || item.cost == null) return;
  if (item.alert !== true) {
    delete lastPlState[q.symbol]; // 关闭提示的股票不跟踪，清基线避免重开时误报
    return;
  }
  const cost = Number(item.cost);
  const lp = Number(q.last_price);
  if (!Number.isFinite(cost) || !Number.isFinite(lp) || cost === 0) return;

  const cur = lp >= cost ? "profit" : "loss";
  const prev = lastPlState[q.symbol];
  if (prev === undefined) {
    lastPlState[q.symbol] = cur; // 首次建立基线，不触发
    return;
  }
  if (prev === "loss" && cur === "profit") {
    send({ type: "pl-alert", symbol: q.symbol, name: item.name || q.name || q.symbol });
    playBeep();
  }
  lastPlState[q.symbol] = cur;
}

// 按时间戳合并，避免旧数据（如盘前 WS 不推、REST 返回昨收）覆盖新数据。
// 返回 { accepted, changed }：changed 为 false 时无需上报，省掉无效的 storage 写入与弹窗重绘。
function mergeQuote(q) {
  const existing = quotesCache[q.symbol];
  if (existing && existing.timestamp && q.timestamp && q.timestamp < existing.timestamp) {
    return { accepted: false, changed: false };
  }
  quotesCache[q.symbol] = q;
  const changed = !existing ||
    existing.last_price !== q.last_price ||
    existing.prev_close !== q.prev_close ||
    existing.timestamp !== q.timestamp ||
    existing.session !== q.session ||
    existing.name !== q.name;
  return { accepted: true, changed };
}

function handleQuotes(data) {
  if (!Array.isArray(data)) return;
  let dirty = false;
  const keep = new Set(allSymbols());
  for (const q of data) {
    if (!q || !q.symbol || !keep.has(q.symbol)) continue;
    const { accepted, changed } = mergeQuote(q);
    if (accepted) detectPlTurn(q);
    if (changed) dirty = true;
  }
  if (dirty) scheduleWrite();
}

const symbolKey = (list) => list.map((w) => w.symbol).sort().join(",");

// 只有数据源 / Key / 开关 / 标的集合变化才重连；仅改成本、提示开关、名称时原地更新
function applyConfig(cfg) {
  const next = {
    source: (cfg && cfg.source) || "tencent",
    apiKey: (cfg && cfg.apiKey) || "",
    enabled: !(cfg && cfg.enabled === false),
    tradingMarkets: normalizeTradingMarkets(cfg && cfg.tradingMarkets),
    footerSymbols: normalizeFooterSymbols(cfg && cfg.footerSymbols),
    watchlist: Array.isArray(cfg && cfg.watchlist) ? cfg.watchlist : [],
  };
  const sourceChanged = next.source !== source;
  const nextFooter = activeFooterItems(next.tradingMarkets, next.footerSymbols);
  const needRestart = stopped || sourceChanged ||
    next.apiKey !== apiKey ||
    next.enabled !== enabled ||
    next.tradingMarkets.includes("cn") !== tradingMarkets.includes("cn") ||
    symbolKey(next.watchlist) !== symbolKey(watchlist) ||
    symbolKey(nextFooter) !== symbolKey(footerItems());

  // 成本或提示开关变了的标的重建扭亏基线，其余保留，避免误报 / 漏报
  const prev = new Map(watchlist.map((w) => [w.symbol, w]));
  const nextSyms = new Set(next.watchlist.map((w) => w.symbol));
  for (const s of Object.keys(lastPlState)) {
    const p = prev.get(s);
    const n = next.watchlist.find((w) => w.symbol === s);
    if (!nextSyms.has(s) || !p || p.cost !== n.cost || p.alert !== n.alert) delete lastPlState[s];
  }

  source = next.source;
  apiKey = next.apiKey;
  enabled = next.enabled;
  tradingMarkets = next.tradingMarkets;
  footerSymbols = next.footerSymbols;
  watchlist = next.watchlist;
  if (sourceChanged) { quotesCache = {}; scheduleWrite(); } // 切源清缓存，避免跨源时间戳格式混比
  if (needRestart) start();
}

// 接收 SW 下发的配置变化
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "config-changed") applyConfig(msg);
  if (msg && msg.type === "refresh-turnover") {
    applyConfig(msg);
    pollMarketTurnoverOnce().then(sendResponse);
    return true;
  }
});

// 启动：向 SW 请求配置
async function bootstrap() {
  try {
    applyConfig(await chrome.runtime.sendMessage({ type: "get-config" }));
  } catch (e) {
    // SW 尚未就绪，稍后重试
    setTimeout(bootstrap, 1000);
  }
}

bootstrap();
