"use strict";

// 弹窗 / 独立小窗共用：只负责读缓存 + 渲染 + 管理自选股与开关。
// 行情由后台 offscreen 常驻连接写入 storage。

const API_BASE = "https://api.tickflow.org";
const INSTRUMENTS_URL = `${API_BASE}/v1/instruments`;
const TENCENT_SEARCH_URL = "https://smartbox.gtimg.cn/s3/"; // 腾讯搜索联想
const BINANCE_BASE = "https://fapi.binance.com";


function marketOf(symbol) {
  if (/\.(SH|SZ|BJ)$/i.test(symbol || "")) return "cn";
  if (/\.HK$/i.test(symbol || "")) return "hk";
  if (/\.US$/i.test(symbol || "")) return "us";
  return "crypto";
}

const state = {
  source: "tencent",    // 数据源：tickflow | tencent
  apiKey: "",
  enabled: true,        // 是否获取行情
  floatWindow: true,    // 是否悬浮窗口
  theme: "system",
  barkKey: "",          // Bark 推送 Key
  barkEnabled: false,   // Bark 推送开关
  tradingMarkets: MARKET_GROUPS.map((g) => g.key),
  footerSymbols: normalizeFooterSymbols(),
  editingSymbol: null,
  watchlist: [],        // [{ symbol, name }]
  quotes: {},           // symbol -> quote（来自后台）
  marketTurnover: null,
  turnoverRefreshing: false,
  turnoverRefreshError: false,
  reconnecting: false,
  status: { mode: "idle", text: "未连接" },
};

let editDraft = {};
let editField = "cost";
let editSelection = null;
let editRevision = 0;

const collapsedGroups = new Set(); // 已折叠的市场分组 key（render 重建后保持折叠状态）

const $ = (sel) => document.querySelector(sel);
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");

function normalizeTheme(theme) {
  return theme === "light" || theme === "dark" ? theme : "system";
}

// ==================== 存储 ====================
async function loadSettings() {
  const [local, sync] = await Promise.all([
    chrome.storage.local.get(["source", "apiKey", "quotes", "status", "enabled", "floatWindow", "theme", "barkKey", "barkEnabled", "tradingMarkets", "footerSymbols", "marketTurnover"]),
    chrome.storage.sync.get("watchlist"),
  ]);
  state.tradingMarkets = normalizeTradingMarkets(local.tradingMarkets);
  state.footerSymbols = normalizeFooterSymbols(local.footerSymbols);
  state.source = local.source || "tencent";
  state.apiKey = local.apiKey || "";
  state.enabled = local.enabled !== false;
  state.floatWindow = local.floatWindow !== false;
  state.theme = normalizeTheme(local.theme);
  state.barkKey = local.barkKey || "";
  state.barkEnabled = local.barkEnabled === true;
  state.quotes = local.quotes || {};
  state.marketTurnover = local.marketTurnover || null;
  state.status = local.status || { mode: "idle", text: "未连接" };
  state.watchlist = Array.isArray(sync.watchlist) ? sync.watchlist : [];
}

// 写入失败（超出 sync 单项 8KB 配额或每分钟写入次数上限）时回滚到已存数据并提示
async function saveWatchlist() {
  try {
    await chrome.storage.sync.set({ watchlist: state.watchlist });
    return true;
  } catch (e) {
    const { watchlist } = await chrome.storage.sync.get("watchlist").catch(() => ({}));
    state.watchlist = Array.isArray(watchlist) ? watchlist : [];
    render();
    showError(/QUOTA_BYTES/i.test(String(e && e.message))
      ? "自选股数量超出同步容量上限，请删减后再试"
      : "保存失败，请稍后重试");
    return false;
  }
}

// 确保后台 offscreen 连接存在
function ensureBackground() {
  try {
    chrome.runtime.sendMessage({ type: "ensure-offscreen" }, () => {
      void chrome.runtime.lastError;
    });
  } catch (e) { /* ignore */ }
}

// 清除工具栏「扭亏为盈」角标
function clearAlert() {
  try {
    chrome.runtime.sendMessage({ type: "clear-alert" }, () => {
      void chrome.runtime.lastError;
    });
  } catch (e) { /* ignore */ }
}

// ==================== 工具 ====================
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function normalizeSymbol(raw) {
  const s = String(raw || "").trim().toUpperCase();
  const m = s.match(/^([A-Z0-9]{1,10})\.(SH|SZ|BJ|US|HK)$/);
  return m ? `${m[1]}.${m[2]}` : null;
}

function isCryptoSymbol(symbol) {
  return !/\.(SH|SZ|BJ|HK|US)$/i.test(symbol || "");
}

function normalizeBinanceSymbol(raw) {
  const s = String(raw || "").trim().toUpperCase().replace(/\.PERP$/, "");
  return /^[\p{L}\p{N}]{1,20}USDT$/u.test(s) ? `${s}.PERP` : null;
}

// Bark Key 规范化：容忍多打斜杠 / 贴了完整 URL，只保留 key 本体
function normalizeBarkKey(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) {
    const m = s.match(/^https?:\/\/[^/]+\/([^/]+)/);
    s = m ? m[1] : s;
  }
  return s.replace(/^\/+|\/+$/g, "");
}

function changePct(q) {
  if (q.prev_close == null || Number(q.prev_close) === 0) return null;
  return (Number(q.last_price) - Number(q.prev_close)) / Number(q.prev_close) * 100;
}

function changeClass(v) {
  if (v == null || Number.isNaN(Number(v)) || v === 0) return "flat";
  return v > 0 ? "up" : "down";
}

function formatPrice(v, symbol) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  const n = Number(v);
  // 币安币价格量级差异巨大（BTC 数万 / SHIB 极低），按量级自适应小数位
  if (isCryptoSymbol(symbol)) {
    const abs = Math.abs(n);
    const d = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 6 : 9;
    return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: d });
  }
  const d = Math.abs(n) >= 1 ? 3 : 4; // 主价格精确到三位小数
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function formatPct(v) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  const n = Number(v);
  return (n > 0 ? "+" : "") + n.toFixed(2) + "%";
}

function displayName(item, q) {
  return item.name || (q && (q.name || (q.ext && q.ext.name))) || item.symbol;
}

// 交易时段标签。session 由 TickFlow 按各市场返回，天然区分 A股/港股/美股：
// 美股才有 pre_market/after_hours，A股只有 regular/lunch_break/closed/halted。
const SESSION_LABEL = {
  regular: null,          // 盘中：不显示
  lunch_break: "午休",
  pre_market: "盘前",
  after_hours: "盘后",
  closed: "已收盘",
  halted: "停牌",
};

function isUsSymbol(symbol, region) {
  if (region) return region === "US";
  return /\.US$/i.test(symbol || "");
}

function sessionBadge(q) {
  if (!q) return "";
  let session = q.session;
  // 美股盘前/盘后/夜盘时段 TickFlow 不返回 session，且价格停在昨收（涨跌幅 0）。
  // 如实标「已收盘」，避免误标成「盘前」误导用户。
  if (state.source === "tickflow" && !session && isUsSymbol(q.symbol, q.region)) {
    session = "closed";
  }
  if (!session) return "";
  const label = SESSION_LABEL[session];
  if (!label) return "";
  const cls = session === "halted" ? "badge badge--halted" : "badge";
  return `<span class="${cls}">${escapeHtml(label)}</span>`;
}

function parsePositionFields(raw, symbol) {
  const fields = {};
  for (const [key, label] of [["cost", "成本价"], ["quantity", "数量"]]) {
    const value = raw[key];
    const blank = value == null || (typeof value === "string" && value.trim() === "");
    const number = blank ? null : Number(value);
    if (!blank && ((typeof value !== "string" && typeof value !== "number") || !Number.isFinite(number) || number < 0)) {
      throw new Error(`${label}需为不小于 0 的数字`);
    }
    fields[key] = number;
  }
  if (symbol.endsWith(".PERP")) {
    const side = raw.side ?? "long";
    if (!["", "long", "short"].includes(side)) throw new Error("请选择仅看行情、做多或做空");
    fields.side = side;
    fields.leverage = null;
    if (side !== "") {
      const leverage = raw.leverage == null ? 1 : Number(raw.leverage);
      if (!Number.isSafeInteger(leverage) || leverage < 1 || (raw.leverage != null && !["string", "number"].includes(typeof raw.leverage))) {
        throw new Error("杠杆倍数需为不小于 1 的整数");
      }
      fields.leverage = leverage;
    }
  }
  return fields;
}

function quantityUnit(symbol) {
  if (!isCryptoSymbol(symbol)) return "股";
  return symbol.replace(/\.PERP$/, "").replace(/USDT$/, "");
}

function positionCurrency(symbol) {
  const market = marketOf(symbol);
  return market === "cn" ? "CNY" : market === "hk" ? "HKD" : market === "us" ? "USD" : "USDT";
}

function formatAmount(value) {
  const number = Number(value.toFixed(2));
  return (number > 0 ? "+" : "") + number.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderPositionInputs() {
  const raw = $("#symbol-input").value.trim();
  const stock = normalizeSymbol(raw);
  const futures = !stock && (selectedMarket() === "crypto" || !!normalizeBinanceSymbol(raw));
  $("#contract-fields").classList.toggle("hidden", !futures);
  $("#side-input").disabled = !futures;
  $("#leverage-input").disabled = !futures || $("#side-input").value === "";
  const symbol = stock || normalizeBinanceSymbol(raw);
  $("#quantity-label").textContent = symbol ? `数量（${quantityUnit(symbol)}）` : futures ? "数量（标的单位）" : "数量（股）";
  $("#quantity-input").title = futures ? "实际持仓数量，不是保证金或 USDT 金额" : "实际持仓股数";
}

// ==================== 渲染 ====================
function formatTurnover(value, signed = false) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const amount = Math.round(value / 1e7) / 10 || 0;
  return (signed && amount > 0 ? "+" : "") + amount.toLocaleString("en-US", {
    minimumFractionDigits: 1, maximumFractionDigits: 1,
  }) + " 亿";
}

function renderMarketTurnover() {
  const el = $("#market-turnover");
  el.classList.toggle("hidden", !state.tradingMarkets.includes("cn"));
  const data = state.marketTurnover;
  const diff = data && Number.isFinite(data.comparisonAmount) && Number.isFinite(data.previousAmount)
    ? data.comparisonAmount - data.previousAmount : null;
  const time = data && data.date && data.time ? `${data.date.slice(5)} ${data.time}` : "";
  const status = !state.enabled ? "已暂停" : state.turnoverRefreshError || data && data.error ? "更新失败"
    : state.status.cnClosed ? "已休市" : !data ? "获取中" : "";
  const comparisonTime = [data && data.comparisonTime, data && data.comparisonError ? "更新失败" : ""].filter(Boolean).join(" · ") || "暂无同期数据";
  const comparisonTitle = data && data.previousDate && data.comparisonTime
    ? `与 ${data.previousDate} ${data.comparisonTime} 的累计成交额比较` : "与上一交易日同一时刻的累计成交额比较";
  el.innerHTML = `<div class="turnover-row">
    <span class="turnover-label turnover-heading">A股成交额<button type="button"
      class="turnover-refresh${state.turnoverRefreshing ? " is-refreshing" : ""}"
      title="${state.turnoverRefreshing ? "刷新中" : !state.enabled ? "已暂停" : "刷新成交额"}"
      aria-label="刷新成交额" aria-busy="${state.turnoverRefreshing}"${!state.enabled || state.turnoverRefreshing ? " disabled" : ""}>
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 12a9 9 0 0 1 15.36-6.36L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.36 6.36L3 16M8 16H3v5"/>
      </svg></button></span>
    <span class="turnover-value">${formatTurnover(data && data.amount)}</span>
    <span class="turnover-time">${escapeHtml([time, status].filter(Boolean).join(" · "))}</span>
  </div>
  <div class="turnover-row" title="${escapeHtml(comparisonTitle)}">
    <span class="turnover-label">较上一交易日同期</span>
    <span class="turnover-diff ${changeClass(diff)}">${formatTurnover(diff, true)}</span>
    <span class="turnover-time">${escapeHtml(comparisonTime)}</span>
  </div>`;
}

async function refreshMarketTurnover() {
  if (state.turnoverRefreshing || !state.enabled || !state.tradingMarkets.includes("cn")) return;
  state.turnoverRefreshing = true;
  state.turnoverRefreshError = false;
  renderMarketTurnover();
  try {
    const result = await chrome.runtime.sendMessage({ type: "refresh-market-turnover" });
    state.turnoverRefreshError = !result || !result.ok;
  } catch (e) {
    state.turnoverRefreshError = true;
  } finally {
    state.turnoverRefreshing = false;
    renderMarketTurnover();
  }
}

function renderIndices() {
  renderMarketTurnover();
  const el = $("#indices");
  const items = activeFooterItems(state.tradingMarkets, state.footerSymbols);
  el.classList.toggle("hidden", items.length === 0);
  el.innerHTML = items.map((item) => {
    const q = state.quotes[item.symbol];
    const pct = q ? changePct(q) : null;
    const value = q && q.last_price != null && Number.isFinite(Number(q.last_price))
      ? Number(q.last_price).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : "—";
    return `<div class="idx-item" data-symbol="${escapeHtml(item.symbol)}" title="${item.market === "crypto" ? "币安 USDT 永续合约 · 24小时涨跌幅" : escapeHtml(item.symbol)}">
      <span class="idx-name">${escapeHtml(item.name)}</span>
      <span class="idx-value">${value}</span>
      <span class="idx-pct ${changeClass(pct)}">${pct == null ? "—" : formatPct(pct)}</span>
    </div>`;
  }).join("");
}

let footerSaving = false;

function renderFooterOptions() {
  $("#footer-options").innerHTML = MARKET_GROUPS.filter((g) => state.tradingMarkets.includes(g.key)).map((g) => `
    <div class="footer-option-group">
      <span class="footer-option-title">${escapeHtml(g.label)}</span>
      <div class="footer-option-items">${FOOTER_ITEMS.filter((item) => item.market === g.key).map((item) => {
        const selected = state.footerSymbols.includes(item.symbol);
        return `<button type="button" class="footer-option${selected ? " active" : ""}" data-symbol="${escapeHtml(item.symbol)}" aria-pressed="${selected}"${footerSaving ? " disabled" : ""}>${escapeHtml(item.name)}</button>`;
      }).join("")}</div>
    </div>`).join("");
}

async function onFooterOptionChange(symbol) {
  if (footerSaving || !FOOTER_ITEMS.some((item) => item.symbol === symbol && state.tradingMarkets.includes(item.market))) return;
  const deselect = state.footerSymbols.includes(symbol);
  footerSaving = true;
  renderFooterOptions();
  try {
    await navigator.locks.request("quote-market-settings", async () => {
      const stored = await chrome.storage.local.get(["footerSymbols", "tradingMarkets"]);
      const markets = normalizeTradingMarkets(stored.tradingMarkets);
      if (!FOOTER_ITEMS.some((item) => item.symbol === symbol && markets.includes(item.market))) return;
      const current = normalizeFooterSymbols(stored.footerSymbols);
      const next = deselect ? current.filter((s) => s !== symbol) : [...new Set([...current, symbol])];
      await chrome.storage.local.set({ footerSymbols: next });
      state.footerSymbols = next;
    });
    showError("");
  } catch (e) {
    showError("保存失败，请稍后重试");
  } finally {
    footerSaving = false;
    renderFooterOptions();
    renderIndices();
    renderStatus();
  }
}

// 构建单个自选股行（分组渲染时复用）
function buildPositionEditor(item) {
  const input = (field, label, mode = "decimal", disabled = false) => `<label class="position-field">${escapeHtml(label)}<input class="position-input" data-field="${field}" type="text" inputmode="${mode}" autocomplete="off" spellcheck="false" value="${escapeHtml(editDraft[field] ?? "")}" placeholder="可选"${disabled ? " disabled" : ""}></label>`;
  return `<div class="position-editor">
    <div class="position-fields">${input("cost", "成本价")}${input("quantity", `数量（${quantityUnit(item.symbol)}）`)}</div>
    ${item.symbol.endsWith(".PERP") ? `<div class="position-fields">
      <label class="position-field">方向<select class="position-input" data-field="side"><option value=""${editDraft.side === "" ? " selected" : ""}>仅看行情</option><option value="long"${editDraft.side === "long" ? " selected" : ""}>做多</option><option value="short"${editDraft.side === "short" ? " selected" : ""}>做空</option></select></label>
      ${input("leverage", "杠杆倍数", "numeric", editDraft.side === "")}</div>` : ""}
    <div class="position-actions"><button type="button" class="position-save">保存</button><button type="button" class="position-cancel">取消</button></div>
  </div>`;
}

function buildRowHtml(item) {
  const q = state.quotes[item.symbol];
  const pct = q ? changePct(q) : null;
  const cost = item.cost != null ? Number(item.cost) : null;
  const pl = calcPositionPl(item, q);
  const futures = item.symbol.endsWith(".PERP");
  const quotesOnly = futures && item.side === "";
  const editing = state.editingSymbol === item.symbol;

  const daySub = `<div class="change ${changeClass(pct)}"${isCryptoSymbol(item.symbol) ? ' title="24小时涨跌幅"' : ""}>${pct == null ? "—" : formatPct(pct)}</div>`;
  const plSub = pl != null
    ? `<div class="change ${changeClass(pl.percent)}" title="${futures ? "按开仓成本和杠杆估算的保证金收益率" : "相对成本价的收益率"}，未计手续费及资金费">${futures ? "收益率" : "成本"} ${formatPct(pl.percent)}</div>
       ${pl.amount == null ? "" : `<div class="change ${changeClass(pl.amount)}" title="未计手续费及资金费">盈亏 ${formatAmount(pl.amount)} ${positionCurrency(item.symbol)}</div>`}`
    : "";

  const symbolHtml = `${escapeHtml(item.symbol)}${isCryptoSymbol(item.symbol) && !futures ? " · 现货" : ""}`;
  const details = quotesOnly ? "" : [
    cost != null ? `成本 ${formatPrice(cost, item.symbol)}` : "",
    item.quantity != null ? `数量 ${Number(item.quantity).toLocaleString("en-US", { maximumFractionDigits: 10 })} ${quantityUnit(item.symbol)}` : "",
    futures ? `${item.side === "short" ? "做空" : "做多"} · ${item.leverage ?? 1}x` : "",
  ].filter(Boolean).join(" · ");

  const alertSwitch = (!editing && cost != null && !quotesOnly)
    ? `<label class="alert-toggle" title="盈利提示开关">
         <span class="alert-label">盈利提示</span>
         <span class="mini-switch">
           <input type="checkbox" class="alert-check" aria-label="${escapeHtml(item.symbol)} 盈利提示" data-symbol="${escapeHtml(item.symbol)}"${item.alert === true ? " checked" : ""}>
           <span class="mini-slider"></span>
         </span>
       </label>`
    : "";

  return `
    <div class="row-main">
      <div class="name"><span class="name-text">${escapeHtml(displayName(item, q))}</span>${sessionBadge(q)}</div>
      <div class="symbol">${symbolHtml}</div>
      ${details ? `<div class="position-details">${escapeHtml(details)}</div>` : ""}
      ${alertSwitch}
    </div>
    <div class="row-quote">
      <div class="price">${q ? formatPrice(q.last_price, item.symbol) : "—"}</div>
      ${daySub}
      ${plSub}
    </div>
    ${editing ? buildPositionEditor(item) : ""}
    <button class="edit" data-symbol="${escapeHtml(item.symbol)}" title="编辑持仓" aria-label="编辑 ${escapeHtml(item.symbol)} 持仓">✎</button>
    <button class="remove" data-symbol="${escapeHtml(item.symbol)}" title="移除">×</button>
  `;
}

function marketPlAmount(items) {
  let amount = null;
  for (const item of items) {
    const pl = calcPositionPl(item, state.quotes[item.symbol]);
    if (pl?.amount != null) amount = (amount ?? 0) + pl.amount;
  }
  return amount;
}

function render() {
  const focused = document.activeElement;
  if (focused && focused.classList.contains("position-input")) {
    editField = focused.dataset.field;
    editSelection = { start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection };
  }
  renderIndices();
  const list = $("#watchlist");
  const empty = $("#empty");

  if (state.watchlist.length === 0) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
  } else {
    empty.classList.add("hidden");
    list.innerHTML = "";

    // 按市场分组：A股 → 港股 → 美股 → 币安，空分组不显示
    const groups = { cn: [], hk: [], us: [], crypto: [] };
    for (const item of state.watchlist) {
      (groups[marketOf(item.symbol)] || groups.crypto).push(item);
    }
    for (const g of MARKET_GROUPS) {
      const items = groups[g.key];
      if (!items || items.length === 0) continue;
      const collapsed = collapsedGroups.has(g.key);
      const header = document.createElement("li");
      header.className = "group-header" + (collapsed ? " collapsed" : "");
      header.dataset.group = g.key;
      const amount = marketPlAmount(items);
      header.innerHTML = `<span class="group-arrow">▸</span><span class="group-label">${escapeHtml(g.label)}</span>
        <span class="group-pl ${changeClass(amount)}" title="仅汇总有成本、数量及有效报价的持仓，未计手续费及资金费">盈亏 ${amount == null ? "—" : formatAmount(amount)} ${positionCurrency(items[0].symbol)}</span>`;
      list.appendChild(header);
      if (collapsed) continue;
      for (const item of items) {
        const li = document.createElement("li");
        li.className = "row";
        li.innerHTML = buildRowHtml(item);
        list.appendChild(li);
      }
    }
  }

  if (state.editingSymbol) {
    const input = $(`#watchlist .position-input[data-field="${editField}"]`);
    if (input) {
      const selection = editSelection;
      input.focus();
      if (input.tagName === "INPUT") {
        const start = selection?.start ?? input.value.length;
        const end = selection?.end ?? start;
        input.setSelectionRange(start, end, selection?.direction ?? "none");
      }
    }
  }

  renderStatus();
  updateSourceUI();
}

function needsApiKey() {
  if (!state.enabled || state.source !== "tickflow" || state.apiKey) return false;
  const active = (symbol) => !isCnSymbol(symbol) || isCnPollingTime();
  return state.watchlist.some((w) => !isCryptoSymbol(w.symbol) && active(w.symbol)) ||
    activeFooterItems(state.tradingMarkets, state.footerSymbols).some((item) => item.market !== "crypto" && item.market !== "hk" && active(item.symbol));
}

function renderStatus() {
  const el = $("#status");
  const txt = $("#status-text");
  let mode, text;
  if (state.enabled === false) {
    mode = "idle"; text = "已暂停";
  } else if (state.reconnecting) {
    mode = "idle"; text = "重连中";
  } else if (needsApiKey()) {
    mode = "idle"; text = "需要 API Key";
  } else {
    mode = state.status.mode || "idle";
    text = state.status.text || "未连接";
  }
  el.className = "status status--" + mode;
  el.title = state.enabled ? `${text} · 点击重连` : "已暂停";
  txt.textContent = text;
  const button = $("#btn-reconnect");
  button.disabled = !state.enabled || state.reconnecting;
  button.classList.toggle("is-reconnecting", state.reconnecting);
  button.setAttribute("aria-busy", String(state.reconnecting));
  button.title = !state.enabled ? "已暂停" : state.reconnecting ? "重连中" : "重新连接行情";
}

async function reconnectQuotes() {
  if (!state.enabled || state.reconnecting) return;
  if (needsApiKey()) { $("#settings").classList.remove("hidden"); return; }
  state.reconnecting = true;
  renderStatus();
  try {
    const result = await chrome.runtime.sendMessage({ type: "reconnect-quotes" });
    if (!result || !result.ok) showError("重连失败，请重试");
    else showError("");
  } catch (e) {
    showError("重连失败，请重试");
  } finally {
    state.reconnecting = false;
    renderStatus();
  }
}

function showError(msg) {
  const el = $("#error");
  el.textContent = msg || "";
  el.classList.remove("ok");
  el.classList.toggle("hidden", !msg);
}

// 成功提示（绿色），与错误提示共用 #error 元素
function showNotice(msg) {
  const el = $("#error");
  el.textContent = msg || "";
  el.classList.add("ok");
  el.classList.remove("hidden");
}

// ==================== 标的名称 ====================
// 腾讯源行情自带中文名：写回自选股，行情缺失（如 .BJ、休市）时也能显示名称
function fillNamesFromQuotes() {
  let changed = false;
  for (const w of state.watchlist) {
    if (w.name || isCryptoSymbol(w.symbol)) continue;
    const q = state.quotes[w.symbol];
    if (q && q.name) { w.name = q.name; changed = true; }
  }
  if (changed) saveWatchlist();
}

async function fetchNames() {
  if (!state.apiKey || state.source === "tencent") return;
  const missing = state.watchlist.filter((w) => !w.name && !isCryptoSymbol(w.symbol)).map((w) => w.symbol);
  if (missing.length === 0) return;

  try {
    const resp = await fetch(INSTRUMENTS_URL, {
      method: "POST",
      headers: { "x-api-key": state.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ symbols: missing }),
    });
    if (!resp.ok) return;
    const json = await resp.json();

    const nameMap = {};
    for (const inst of json.data || []) {
      if (inst && inst.symbol && inst.name) nameMap[inst.symbol] = inst.name;
    }

    let changed = false;
    for (const w of state.watchlist) {
      if (!w.name && nameMap[w.symbol]) { w.name = nameMap[w.symbol]; changed = true; }
    }
    if (changed) { await saveWatchlist(); render(); }
  } catch (e) {
    // 静默失败，名称留空，下次触发时再补
  }
}

// ==================== 标的搜索（按名称/代码） ====================
// TickFlow 无名称搜索接口，改为拉取市场标的列表后本地模糊匹配。
// 列表较大，做两级缓存：内存（本次弹窗）+ chrome.storage.local（跨弹窗，24h 内复用），
// 多市场并行拉取，避免串行等待导致搜索卡顿。

const INSTRUMENT_CACHE = {};                    // market -> { fetchedAt, list }
const INSTRUMENT_STORAGE_KEY = "instrumentCache";
const INSTRUMENT_TTL = 24 * 60 * 60 * 1000;     // 24 小时
let cacheLoaded = false;

function isMarketAllowed(symbol) {
  return state.tradingMarkets.includes(marketOf(symbol));
}

function selectedMarket() {
  const el = $("#market-seg .active");
  return el ? el.dataset.market : "auto";
}

function renderMarketUI() {
  renderFooterOptions();
  renderIndices();
  renderStatus();
  $("#trading-markets").querySelectorAll(".seg-btn").forEach((btn) => {
    const active = state.tradingMarkets.includes(btn.dataset.market);
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  });
  let market = selectedMarket();
  if (state.tradingMarkets.length === 1) market = state.tradingMarkets[0];
  else if (!state.tradingMarkets.includes(market)) market = "auto";
  $("#market-seg").classList.toggle("hidden", state.tradingMarkets.length === 1);
  $("#market-seg").querySelectorAll(".seg-btn").forEach((btn) => {
    const available = btn.dataset.market === "auto" || state.tradingMarkets.includes(btn.dataset.market);
    btn.classList.toggle("hidden", !available);
    btn.classList.toggle("active", btn.dataset.market === market);
  });
  const examples = { cn: "600000.SH / 浦发", hk: "00700.HK / 腾讯", us: "AAPL.US / 苹果", crypto: "BTCUSDT / ETHUSDT" };
  const example = market === "auto"
    ? state.tradingMarkets.map((m) => examples[m].split(" / ")[0]).join(" / ")
    : examples[market];
  $("#symbol-input").placeholder = `代码或名称，如 ${example}`;
  $("#empty .hint").textContent = `点击「添加自选」输入代码或名称，例如 ${example}`;
  renderPositionInputs();
}

function guessMarkets(query) {
  const m = selectedMarket();
  let markets;
  if (m === "cn") markets = ["SH", "SZ", "BJ"];
  else if (m === "hk") markets = ["HK"];
  else if (m === "us") markets = ["US"];
  else if (m === "crypto") markets = [];
  else if (/[一-龥]/.test(query)) markets = ["SH", "SZ", "BJ", "HK"];
  else if (/^\d{6}$/.test(query)) markets = ["SH", "SZ", "BJ"];
  else if (/^\d{5}$/.test(query)) markets = ["HK", "SH", "SZ"];
  else if (/^\d/.test(query)) markets = ["SH", "SZ", "BJ", "HK", "US"];
  else markets = ["US", "HK", "SH", "SZ", "BJ"];
  return markets.filter((exchange) => isMarketAllowed(`X.${exchange}`));
}

async function ensureCacheLoaded() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const data = await chrome.storage.local.get(INSTRUMENT_STORAGE_KEY);
    const stored = data[INSTRUMENT_STORAGE_KEY];
    if (stored) {
      for (const [market, entry] of Object.entries(stored)) {
        if (entry && Array.isArray(entry.list) && entry.list.length) INSTRUMENT_CACHE[market] = entry;
      }
    }
  } catch (e) { /* 缓存读取失败，忽略，走网络拉取 */ }
}

let persistTimer = null;
function persistInstrumentCache() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const now = Date.now();
    const toStore = {};
    for (const [market, entry] of Object.entries(INSTRUMENT_CACHE)) {
      if (entry && entry.list.length && now - entry.fetchedAt < INSTRUMENT_TTL) toStore[market] = entry;
    }
    chrome.storage.local.set({ [INSTRUMENT_STORAGE_KEY]: toStore }).catch(() => {});
  }, 500);
}

const inflight = {}; // market -> Promise，避免同一市场并发重复拉取

// 带超时的 fetch，避免某个市场请求卡住拖垮整个搜索
function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

async function loadMarket(market) {
  const mem = INSTRUMENT_CACHE[market];
  if (mem && mem.list.length && Date.now() - mem.fetchedAt < INSTRUMENT_TTL) return mem.list;
  if (inflight[market]) return inflight[market];
  inflight[market] = (async () => {
    const resp = await fetchWithTimeout(
      `${API_BASE}/v1/exchanges/${market}/instruments`,
      { headers: { "x-api-key": state.apiKey } },
      10000
    );
    if (!resp.ok) throw new Error("load failed");
    const json = await resp.json();
    const list = (json.data || []).map((it) => ({ symbol: it.symbol, name: it.name || "" }));
    INSTRUMENT_CACHE[market] = { fetchedAt: Date.now(), list };
    persistInstrumentCache();
    return list;
  })();
  try {
    return await inflight[market];
  } finally {
    delete inflight[market];
  }
}

// 腾讯搜索联想：市场前缀+代码 → 统一格式（代码.市场后缀）
function tencentSearchSymbol(prefix, code) {
  const p = String(prefix).toLowerCase();
  let market;
  if (p === "sh") market = "SH";
  else if (p === "sz") market = "SZ";
  else if (p === "hk") market = "HK";
  else if (p === "us") market = "US";
  else if (p === "bj") market = "BJ";
  else return null;
  let c = String(code).toLowerCase();
  if (market === "US") c = c.split(".")[0]; // aapl.oq → aapl
  if (market === "HK") c = c.padStart(5, "0");
  return `${c.toUpperCase()}.${market}`;
}

async function searchTencent(query) {
  try {
    const resp = await fetch(`${TENCENT_SEARCH_URL}?q=${encodeURIComponent(query)}&t=all`, { cache: "no-store" });
    if (!resp.ok) return [];
    const text = await resp.text();
    const m = text.match(/v_hint="([^"]*)"/);
    if (!m || !m[1]) return [];
    // 返回含 \uXXXX unicode 转义，先解码为真实中文
    const raw = m[1].replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    const results = [];
    for (const part of raw.split("^")) {
      const f = part.split("~");
      if (f.length < 3) continue;
      const symbol = tencentSearchSymbol(f[0], f[1]);
      if (!symbol || symbol.endsWith(".BJ")) continue; // 北交所行情不支持，过滤
      results.push({ symbol, name: f[2] || "" });
      if (results.length >= 20) break;
    }
    return results;
  } catch (e) {
    return [];
  }
}

let binanceSymbols = null;
let binanceSymbolsPromise = null;
async function loadBinanceSymbols() {
  if (binanceSymbols) return binanceSymbols;
  if (binanceSymbolsPromise) return binanceSymbolsPromise;
  binanceSymbolsPromise = (async () => {
    const resp = await fetch(`${BINANCE_BASE}/fapi/v1/exchangeInfo`, {
      cache: "no-store", signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (!data || !Array.isArray(data.symbols)) throw new Error("数据无效");
    // 暂停交易的合约仍提供行情，不能按已下架过滤。
    const symbols = data.symbols
      .filter((x) => x && ["TRADING", "TRADING_HALT"].includes(x.status) && ["PERPETUAL", "TRADIFI_PERPETUAL"].includes(x.contractType) && x.quoteAsset === "USDT")
      .map((x) => normalizeBinanceSymbol(x.symbol))
      .filter(Boolean)
      .sort();
    if (!symbols.length) throw new Error("列表为空");
    binanceSymbols = symbols;
    return binanceSymbols;
  })();
  try {
    return await binanceSymbolsPromise;
  } finally {
    binanceSymbolsPromise = null;
  }
}

async function searchBinance(q) {
  const list = await loadBinanceSymbols();
  const query = q.trim().toLowerCase().replace(/\.perp$/, "");
  const results = [];
  for (const s of list) {
    if (s.slice(0, -5).toLowerCase().includes(query)) {
      results.push({ symbol: s, name: `${s.slice(0, -5)} 永续` });
      if (results.length >= 20) break;
    }
  }
  return results;
}

function binanceCatalogError(error) {
  const reason = error && ["AbortError", "TimeoutError"].includes(error.name) ? "请求超时"
    : error instanceof SyntaxError ? "数据无效"
    : error && /^(HTTP \d{3}|数据无效|列表为空)$/.test(error.message) ? error.message
    : "网络或证书错误";
  return `合约列表获取失败：${reason}`;
}

function renderSearchStatus(message = "", retry = false) {
  $("#search-status").classList.toggle("hidden", !message);
  $("#search-status-text").textContent = message;
  $("#btn-retry-search").classList.toggle("hidden", !retry);
}

function filterByMarket(results, market) {
  return results.filter((r) => isMarketAllowed(r.symbol) &&
    (market === "auto" || marketOf(r.symbol) === market));
}

let searchSeq = 0; // 查询序号，避免旧请求结果覆盖新输入
let searchTimer = null;

function clearSearch() {
  clearTimeout(searchTimer);
  searchTimer = null;
  searchSeq++;
  renderSearchResults([]);
  renderSearchStatus();
}

async function searchInstruments(query) {
  const seq = ++searchSeq;
  const q = query.trim().toLowerCase();
  const market = selectedMarket();
  renderSearchResults([]);
  renderSearchStatus();
  if (!$("#add-panel").open || !q || normalizeSymbol(q)) return;
  const results = [];
  let cryptoResults = [];
  const updateResults = () => {
    if (seq !== searchSeq) return;
    const stockLimit = cryptoResults.length ? Math.max(10, 20 - cryptoResults.length) : 20;
    const stocks = filterByMarket(results, market).slice(0, stockLimit);
    renderSearchResults([...cryptoResults.slice(0, 20 - stocks.length), ...stocks]);
  };
  const searchCrypto = state.tradingMarkets.includes("crypto") && (market === "crypto" || market === "auto");
  if (searchCrypto) renderSearchStatus("合约搜索中…");
  const cryptoSearch = searchCrypto
    ? searchBinance(q).then((items) => {
      if (seq !== searchSeq) return;
      cryptoResults = items;
      renderSearchStatus(!items.length && (market === "crypto" || normalizeBinanceSymbol(q))
        ? "未找到匹配的 USDT 永续合约" : "");
      updateResults();
    }).catch((error) => {
      if (seq === searchSeq) renderSearchStatus(binanceCatalogError(error), true);
    }) : Promise.resolve();
  if (market === "crypto" || normalizeBinanceSymbol(q)) {
    await cryptoSearch;
    return;
  }
  if (state.source === "tencent") {
    const items = await searchTencent(q);
    if (seq === searchSeq) {
      results.push(...items);
      updateResults();
    }
  } else if (state.apiKey) {
    await ensureCacheLoaded();
    if (seq !== searchSeq) return;
    for (const exchange of guessMarkets(q)) {
      if (results.length >= 20) break;
      const list = await loadMarket(exchange).catch(() => null);
      if (seq !== searchSeq) return;
      if (!list) continue;
      for (const it of list) {
        if (results.length >= 20) break;
        if ((it.name + " " + it.symbol).toLowerCase().includes(q)) results.push(it);
      }
      updateResults();
    }
  }
  await cryptoSearch;
}

function renderSearchResults(results) {
  results = filterByMarket(results || [], selectedMarket());
  const el = $("#search-results");
  if (!results || results.length === 0) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.innerHTML = results.map((it) => `
    <div class="search-item" data-symbol="${escapeHtml(it.symbol)}">
      <span class="s-name">${escapeHtml(it.name || it.symbol)}</span>
      <span class="s-symbol">${escapeHtml(it.symbol)}</span>
    </div>
  `).join("");
  el.classList.remove("hidden");
}

// ==================== 自选股管理 ====================
async function addSymbol(raw, positionRaw) {
  let symbol;
  const market = selectedMarket();
  const asCrypto = !normalizeSymbol(raw) && (market === "crypto" || normalizeBinanceSymbol(raw));
  if (asCrypto) {
    symbol = normalizeBinanceSymbol(raw);
    if (!symbol) { showError("合约代码无效，示例：BTCUSDT、ETHUSDT"); return false; }
  } else {
    symbol = normalizeSymbol(raw);
    if (!symbol) { showError("代码格式无效，示例：600000.SH、510300.SH、AAPL.US、00700.HK、BTCUSDT"); return false; }
  }
  if (!isMarketAllowed(symbol)) {
    const label = MARKET_GROUPS.find((g) => g.key === marketOf(symbol)).label;
    showError(`未开启${label}市场`);
    return false;
  }
  let position;
  try {
    position = parsePositionFields(positionRaw, symbol);
  } catch (e) {
    showError(e.message);
    return false;
  }
  if (asCrypto) {
    try {
      const list = await loadBinanceSymbols();
      if (!list.includes(symbol)) { showError("未找到 USDT 永续合约"); return false; }
    } catch (e) {
      showError(binanceCatalogError(e));
      return false;
    }
    if (!isMarketAllowed(symbol)) { showError("未开启币安市场"); return false; }
  }
  if (state.watchlist.some((w) => w.symbol === symbol)) {
    showError("该代码已在自选股中");
    return false;
  }
  const name = asCrypto ? `${symbol.slice(0, -5)} 永续` : null;
  state.watchlist.push({ symbol, name, ...position, alert: false });
  if (!(await saveWatchlist())) return false;
  showError("");
  render();
  ensureBackground();
  fetchNames();   // 补全名称（异步，不阻塞列表刷新）
  return true;
}

async function removeSymbol(symbol) {
  state.watchlist = state.watchlist.filter((w) => w.symbol !== symbol);
  await saveWatchlist();
  render();
  ensureBackground();
}

async function commitPosition() {
  const revision = editRevision;
  const item = state.watchlist.find((w) => w.symbol === state.editingSymbol);
  if (!item) { cancelEdit(); return; }
  let position;
  try {
    position = parsePositionFields(editDraft, item.symbol);
  } catch (e) {
    showError(e.message);
    return;
  }
  Object.assign(item, position);
  if (!(await saveWatchlist()) || revision !== editRevision) return;
  showError("");
  cancelEdit();
}

function cancelEdit() {
  state.editingSymbol = null;
  editDraft = {};
  editField = "cost";
  editSelection = null;
  editRevision++;
  render();
}

// ==================== 自选股导入导出 ====================
function exportWatchlist() {
  if (state.watchlist.length === 0) {
    showError("自选股为空，无需导出");
    return;
  }
  const payload = {
    version: 2,
    type: "watchlist",
    exportedAt: new Date().toISOString(),
    watchlist: state.watchlist.map((w) => ({
      symbol: w.symbol,
      name: w.name || "",
      cost: w.cost ?? null,
      quantity: w.quantity ?? null,
      ...(w.symbol.endsWith(".PERP") ? { side: w.side ?? "long", leverage: w.side === "" ? null : w.leverage ?? 1 } : {}),
      alert: w.alert === true,
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `watchlist-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showNotice("已导出，查看浏览器下载");
}

// 校验导入的 symbol：股票走 normalizeSymbol，币安走 normalizeBinanceSymbol
function normalizeImportedSymbol(raw) {
  const s = String(raw || "").trim().toUpperCase();
  if (!s) return null;
  if (/\.(SH|SZ|BJ|HK|US)$/i.test(s)) return normalizeSymbol(s);
  if (s.endsWith(".PERP")) return normalizeBinanceSymbol(s);
  // 无后缀的旧备份代表现货，不能静默改成合约。
  return /^[A-Z0-9]{3,20}$/.test(s) ? s : null;
}

async function importWatchlist(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    showError("导入失败：不是有效的 JSON 文件");
    return;
  }
  const list = Array.isArray(data)
    ? data
    : (data && Array.isArray(data.watchlist) ? data.watchlist : null);
  if (!list) {
    showError("导入失败：文件格式不正确（缺少自选股列表）");
    return;
  }
  let added = 0, skipped = 0, excluded = 0;
  for (const raw of list) {
    if (!raw || typeof raw !== "object") { skipped++; continue; }
    const symbol = normalizeImportedSymbol(raw.symbol);
    if (!symbol) { skipped++; continue; }
    if (!isMarketAllowed(symbol)) { excluded++; continue; }
    if (state.watchlist.some((w) => w.symbol === symbol)) { skipped++; continue; }
    let position;
    try {
      position = parsePositionFields(raw, symbol);
    } catch (e) {
      skipped++;
      continue;
    }
    state.watchlist.push({
      symbol,
      name: (typeof raw.name === "string" && raw.name.trim()) ? raw.name.trim() : null,
      ...position,
      alert: raw.alert === true,
    });
    added++;
  }
  if (added > 0 && !(await saveWatchlist())) return;
  render();
  ensureBackground();
  if (added > 0) {
    showNotice(`已导入 ${added} 条${excluded > 0 ? `，市场未开启 ${excluded} 条` : ""}${skipped > 0 ? `，跳过 ${skipped} 条` : ""}`);
  } else {
    showError(excluded > 0 ? `市场未开启，跳过 ${excluded} 条` :
      skipped > 0 ? "没有可导入的新自选股（可能已存在或格式无效）" : "文件里没有可导入的条目");
  }
}

// ==================== 设置 ====================
function applyTheme() {
  document.documentElement.dataset.theme = state.theme === "system"
    ? (systemTheme.matches ? "dark" : "light")
    : state.theme;
  $("#theme-seg").querySelectorAll(".seg-btn").forEach((btn) => {
    const selected = btn.dataset.theme === state.theme;
    btn.classList.toggle("active", selected);
    btn.setAttribute("aria-pressed", String(selected));
  });
}

async function onThemeChange(theme) {
  if (!["system", "light", "dark"].includes(theme) || theme === state.theme) return;
  const buttons = $("#theme-seg").querySelectorAll(".seg-btn");
  buttons.forEach((btn) => { btn.disabled = true; });
  try {
    await chrome.storage.local.set({ theme });
    state.theme = theme;
    applyTheme();
  } catch (e) {
    showError("保存失败，请稍后重试");
  } finally {
    buttons.forEach((btn) => { btn.disabled = false; });
  }
}

function renderSettings() {
  applyTheme();
  $("#api-key").value = state.apiKey;
  $("#bark-key").value = state.barkKey;
  $("#toggle-enabled").checked = state.enabled;
  $("#toggle-float").checked = state.floatWindow;
  $("#toggle-bark").checked = state.barkEnabled;
  renderMarketUI();
  updateSourceUI();
}

async function onTradingMarketChange(market) {
  if (!MARKET_GROUPS.some((g) => g.key === market)) return;
  const deselect = state.tradingMarkets.includes(market);
  const buttons = $("#trading-markets").querySelectorAll(".seg-btn");
  buttons.forEach((btn) => { btn.disabled = true; });
  try {
    await navigator.locks.request("quote-market-settings", async () => {
      const stored = await chrome.storage.local.get("tradingMarkets");
      const current = normalizeTradingMarkets(stored.tradingMarkets);
      if (deselect && current.includes(market) && current.length === 1) {
        showError("至少选择一个交易市场");
        return;
      }
      const markets = deselect ? current.filter((m) => m !== market) : [...new Set([...current, market])];
      await chrome.storage.local.set({ tradingMarkets: markets });
      state.tradingMarkets = markets;
      renderMarketUI();
      clearSearch();
      showError("");
      searchInstruments($("#symbol-input").value);
    });
  } catch (e) {
    showError("保存失败，请稍后重试");
  } finally {
    buttons.forEach((btn) => { btn.disabled = false; });
  }
}

// 数据源 UI 联动：腾讯源隐藏 API Key 字段并提示
function updateSourceUI() {
  const seg = $("#source-seg");
  if (seg) {
    seg.querySelectorAll(".seg-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.source === state.source);
    });
  }
  const field = $("#field-tickflow");
  const hint = $("#source-hint");
  if (state.source === "tencent") {
    if (field) field.classList.add("hidden");
    if (hint) hint.textContent = "腾讯免费行情，无需 API Key。A 股盘中实时、港股约 15 分钟延迟、不支持北交所。";
  } else {
    if (field) field.classList.remove("hidden");
    if (hint) hint.textContent = "";
  }
}

async function onSourceChange(value) {
  if (value !== "tickflow" && value !== "tencent") return;
  state.source = value;
  await chrome.storage.local.set({ source: value });
  updateSourceUI();
  renderStatus();
  ensureBackground();
}

async function onSaveKey() {
  state.apiKey = $("#api-key").value.trim();
  state.barkKey = normalizeBarkKey($("#bark-key").value);
  await chrome.storage.local.set({ apiKey: state.apiKey, barkKey: state.barkKey });
  $("#settings").classList.add("hidden");
  showError("");
  renderStatus();
  if (state.apiKey) {
    fetchNames();
    ensureBackground();
  }
}

function setKeyTestResult(el, ok, text) {
  el.textContent = text;
  el.className = "key-test-result " + (ok ? "ok" : "fail");
}

async function testTickflowKey() {
  const key = $("#api-key").value.trim() || state.apiKey;
  const el = $("#test-tickflow-result");
  el.textContent = "测试中…";
  el.className = "key-test-result";
  if (!key) { setKeyTestResult(el, false, "✗ 未填 Key"); return; }
  try {
    const resp = await fetch(`${API_BASE}/v1/exchanges`, { headers: { "x-api-key": key } });
    if (resp.ok) setKeyTestResult(el, true, "✓ 有效");
    else if (resp.status === 401 || resp.status === 403) setKeyTestResult(el, false, "✗ Key 无效或无权限");
    else setKeyTestResult(el, false, `✗ HTTP ${resp.status}`);
  } catch (e) {
    setKeyTestResult(el, false, "✗ 网络错误");
  }
}

async function testBarkKey() {
  const key = normalizeBarkKey($("#bark-key").value) || state.barkKey;
  const el = $("#test-bark-result");
  if (!key) { setKeyTestResult(el, false, "✗ 未填 Key"); return; }
  el.textContent = "发送中…";
  el.className = "key-test-result";
  try {
    const url = `https://api.day.app/${encodeURIComponent(key)}/${encodeURIComponent("行情助手")}/${encodeURIComponent("Bark 推送测试成功，收到请忽略")}`;
    const resp = await fetch(url);
    if (resp.ok) {
      setKeyTestResult(el, true, "✓ 已发送，检查手机");
    } else {
      let msg = "";
      try { msg = (await resp.json()).message || ""; } catch (err) {}
      setKeyTestResult(el, false, msg ? `✗ ${msg}` : `✗ HTTP ${resp.status}`);
    }
  } catch (e) {
    setKeyTestResult(el, false, "✗ 网络错误");
  }
}

// ==================== 事件 ====================
function bindEvents() {
  $("#btn-settings").addEventListener("click", () => {
    $("#settings").classList.toggle("hidden");
  });

  $("#add-panel").addEventListener("toggle", () => {
    clearSearch();
    if ($("#add-panel").open) {
      $("#symbol-input").focus();
      searchInstruments($("#symbol-input").value);
    }
  });

  $("#btn-save-key").addEventListener("click", onSaveKey);
  $("#btn-reconnect").addEventListener("click", reconnectQuotes);
  $("#btn-retry-search").addEventListener("click", () => {
    clearSearch();
    showError("");
    searchInstruments($("#symbol-input").value);
  });

  $("#market-turnover").addEventListener("click", (e) => {
    if (e.target.closest(".turnover-refresh")) refreshMarketTurnover();
  });

  $("#btn-test-tickflow").addEventListener("click", testTickflowKey);

  $("#btn-test-bark").addEventListener("click", testBarkKey);

  $("#btn-export").addEventListener("click", exportWatchlist);
  $("#btn-import").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) importWatchlist(file);
    e.target.value = ""; // 允许重复选择同一文件
  });

  $("#source-seg").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (btn) onSourceChange(btn.dataset.source);
  });

  $("#theme-seg").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (btn) onThemeChange(btn.dataset.theme);
  });
  systemTheme.addEventListener("change", () => {
    if (state.theme === "system") applyTheme();
  });

  $("#trading-markets").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (btn) onTradingMarketChange(btn.dataset.market);
  });

  $("#footer-options").addEventListener("click", (e) => {
    const btn = e.target.closest(".footer-option");
    if (btn) onFooterOptionChange(btn.dataset.symbol);
  });

  // 市场选择：切换后清空候选并按新市场重新搜索
  $("#market-seg").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn || (btn.dataset.market !== "auto" && !state.tradingMarkets.includes(btn.dataset.market))) return;
    $("#market-seg").querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
    renderMarketUI();
    clearSearch();
    searchInstruments($("#symbol-input").value);
  });

  $("#toggle-enabled").addEventListener("change", (e) => {
    state.enabled = e.target.checked;
    chrome.storage.local.set({ enabled: state.enabled });
    renderStatus();
  });

  $("#toggle-float").addEventListener("change", (e) => {
    state.floatWindow = e.target.checked;
    chrome.storage.local.set({ floatWindow: state.floatWindow });
  });

  $("#toggle-bark").addEventListener("change", (e) => {
    state.barkEnabled = e.target.checked;
    chrome.storage.local.set({ barkEnabled: state.barkEnabled });
  });

  $("#side-input").addEventListener("change", renderPositionInputs);

  $("#add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const values = {};
    for (const field of ["cost", "quantity", "side", "leverage"]) {
      const input = $(`#${field}-input`);
      values[field] = input.validity.badInput ? NaN : input.value;
    }
    const ok = await addSymbol($("#symbol-input").value, values);
    if (ok) {
      $("#add-form").reset();
      renderPositionInputs();
      clearSearch();
    }
  });

  // 输入时按名称/代码搜索
  $("#symbol-input").addEventListener("input", (e) => {
    const val = e.target.value.trim();
    renderPositionInputs();
    clearSearch();
    if (!val || normalizeSymbol(val)) return;
    searchTimer = setTimeout(() => searchInstruments(val), 300);
  });

  $("#search-results").addEventListener("click", (e) => {
    const item = e.target.closest(".search-item");
    if (!item || !isMarketAllowed(item.dataset.symbol)) return;
    $("#symbol-input").value = item.dataset.symbol;
    renderPositionInputs();
    clearSearch();
  });

  $("#watchlist").addEventListener("click", (e) => {
    const groupHeader = e.target.closest(".group-header");
    if (groupHeader) {
      const key = groupHeader.dataset.group;
      if (collapsedGroups.has(key)) collapsedGroups.delete(key);
      else collapsedGroups.add(key);
      render();
      return;
    }
    const editBtn = e.target.closest(".edit");
    if (editBtn) {
      const item = state.watchlist.find((w) => w.symbol === editBtn.dataset.symbol);
      state.editingSymbol = editBtn.dataset.symbol;
      editDraft = { cost: item.cost ?? "", quantity: item.quantity ?? "", side: item.side ?? "long", leverage: item.leverage ?? 1 };
      editField = "cost";
      editSelection = null;
      editRevision++;
      render();
      const input = document.querySelector('.position-input[data-field="cost"]');
      if (input) { input.focus(); input.select(); }
      return;
    }
    const saveBtn = e.target.closest(".position-save");
    if (saveBtn) {
      commitPosition();
      return;
    }
    const cancelBtn = e.target.closest(".position-cancel");
    if (cancelBtn) { cancelEdit(); return; }
    const removeBtn = e.target.closest(".remove");
    if (removeBtn) removeSymbol(removeBtn.dataset.symbol);
  });

  // 盈利提示开关：切换后写回 storage，后台据此决定是否跟踪该股
  $("#watchlist").addEventListener("change", (e) => {
    if (!e.target.classList.contains("alert-check")) return;
    const item = state.watchlist.find((w) => w.symbol === e.target.dataset.symbol);
    if (!item) return;
    item.alert = e.target.checked;
    saveWatchlist();
  });

  $("#watchlist").addEventListener("keydown", (e) => {
    if (!e.target.classList.contains("position-input")) return;
    if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); commitPosition(); }
    else if (e.key === "Escape") { cancelEdit(); }
  });

  $("#watchlist").addEventListener("input", (e) => {
    if (e.target.classList.contains("position-input")) {
      editDraft[e.target.dataset.field] = e.target.value;
      if (e.target.dataset.field === "side") {
        $("#watchlist .position-input[data-field=\"leverage\"]").disabled = e.target.value === "";
      }
      editRevision++;
      editField = e.target.dataset.field;
      editSelection = { start: e.target.selectionStart, end: e.target.selectionEnd, direction: e.target.selectionDirection };
    }
  });

  ["keyup", "mouseup", "focusin"].forEach((type) => {
    $("#watchlist").addEventListener(type, (e) => {
      if (e.target.classList.contains("position-input")) {
        editField = e.target.dataset.field;
        editSelection = { start: e.target.selectionStart, end: e.target.selectionEnd, direction: e.target.selectionDirection };
      }
    });
  });

  $("#status").addEventListener("click", reconnectQuotes);
}

// ==================== 初始化 ====================
async function init() {
  applyTheme();
  await loadSettings();
  renderSettings();
  bindEvents();
  render();
  clearAlert(); // 打开面板即清除工具栏角标
  fillNamesFromQuotes();

  if (needsApiKey()) {
    $("#settings").classList.remove("hidden");
  } else {
    fetchNames();
    ensureBackground();
  }
}

document.addEventListener("DOMContentLoaded", init);

// 后台行情/状态/自选股/开关变化时实时刷新（弹窗与悬浮窗同时打开时互相同步）
chrome.storage.onChanged.addListener((changes, areaName) => {
  let need = false;
  if (areaName === "local" && changes.theme) {
    state.theme = normalizeTheme(changes.theme.newValue);
    applyTheme();
  }
  if (changes.quotes) { state.quotes = changes.quotes.newValue || {}; need = true; }
  if (changes.marketTurnover) {
    state.marketTurnover = changes.marketTurnover.newValue || null;
    state.turnoverRefreshError = false;
    need = true;
  }
  if (changes.status) { state.status = changes.status.newValue || { mode: "idle", text: "未连接" }; need = true; }
  if (changes.watchlist) { state.watchlist = Array.isArray(changes.watchlist.newValue) ? changes.watchlist.newValue : []; need = true; }
  if (changes.apiKey) { state.apiKey = changes.apiKey.newValue || ""; need = true; }
  if (changes.enabled) { state.enabled = changes.enabled.newValue !== false; $("#toggle-enabled").checked = state.enabled; need = true; }
  if (changes.floatWindow) { state.floatWindow = changes.floatWindow.newValue !== false; $("#toggle-float").checked = state.floatWindow; }
  if (changes.barkEnabled) { state.barkEnabled = changes.barkEnabled.newValue === true; $("#toggle-bark").checked = state.barkEnabled; }
  if (changes.barkKey) { state.barkKey = changes.barkKey.newValue || ""; }
  if (changes.source) { state.source = changes.source.newValue || "tencent"; need = true; }
  if (changes.tradingMarkets) {
    state.tradingMarkets = normalizeTradingMarkets(changes.tradingMarkets.newValue);
    renderMarketUI();
    showError("");
  }
  if (changes.footerSymbols) {
    state.footerSymbols = normalizeFooterSymbols(changes.footerSymbols.newValue);
    renderFooterOptions();
    renderIndices();
    renderStatus();
  }
  if (changes.tradingMarkets || changes.source) {
    clearSearch();
    searchInstruments($("#symbol-input").value);
  }
  if (changes.quotes) fillNamesFromQuotes();
  if (need) render();
});
