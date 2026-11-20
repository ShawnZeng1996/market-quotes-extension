"use strict";

// Service Worker：创建并保活 Offscreen Document，作为 offscreen 与 storage 之间的桥，
// 同时处理「悬浮窗口」与「是否获取行情」两个开关。

// ---------- offscreen 生命周期 ----------
async function ensureOffscreen() {
  try {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["DOM_PARSER"],
      justification: "后台保持 TickFlow WebSocket 实时行情连接，弹窗关闭后继续接收行情",
    });
  } catch (e) {
    // 已存在等竞态，忽略
  }
}

// ---------- 悬浮窗口：点击图标打开独立小窗 ----------
async function applyFloatMode() {
  const { floatWindow } = await chrome.storage.local.get("floatWindow");
  const on = floatWindow !== false; // 默认开启
  // 开启时清空 default_popup，使 onClicked 生效；关闭时恢复普通弹窗
  await chrome.action.setPopup({ popup: on ? "" : "popup.html" });
}

async function openFloatWindow() {
  const { floatWindowId } = await chrome.storage.local.get("floatWindowId");
  if (floatWindowId != null) {
    try {
      await chrome.windows.update(floatWindowId, { focused: true });
      return;
    } catch (e) { /* 窗口已关闭，重新创建 */ }
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL("popup.html"),
    type: "popup",
    width: 360,
    height: 560,
  });
  await chrome.storage.local.set({ floatWindowId: win.id });
}

chrome.action.onClicked.addListener(() => { openFloatWindow(); });

chrome.windows.onRemoved.addListener((id) => {
  chrome.storage.local.get("floatWindowId").then(({ floatWindowId }) => {
    if (floatWindowId === id) chrome.storage.local.set({ floatWindowId: null });
  });
});

// ---------- 启动 ----------
ensureOffscreen();
chrome.alarms.create("keep-offscreen", { periodInMinutes: 5 });
applyFloatMode();

chrome.runtime.onStartup.addListener(() => { ensureOffscreen(); applyFloatMode(); });
chrome.runtime.onInstalled.addListener(() => { ensureOffscreen(); applyFloatMode(); });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keep-offscreen") ensureOffscreen();
});

// ---------- 配置 ----------
async function readConfig() {
  const [local, sync] = await Promise.all([
    chrome.storage.local.get(["apiKey", "enabled", "source", "tradingMarkets", "footerSymbols"]),
    chrome.storage.sync.get("watchlist"),
  ]);
  return {
    apiKey: local.apiKey || "",
    enabled: local.enabled !== false, // 默认开启
    source: local.source || "tencent", // 默认腾讯免费
    tradingMarkets: local.tradingMarkets,
    footerSymbols: local.footerSymbols,
    watchlist: Array.isArray(sync.watchlist) ? sync.watchlist : [],
  };
}

function notifyOffscreen(msg) {
  return chrome.runtime.sendMessage(msg).catch(() => {});
}

function sendBark(key, symbol, name) {
  const title = "扭亏为盈";
  const body = `${name || symbol} 已扭亏为盈`;
  const url = `https://api.day.app/${encodeURIComponent(key)}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`;
  fetch(url)
    .then((resp) => {
      if (!resp.ok) {
        // Bark Key 无效等失败：打红色「!」角标提示，避免静默失败
        console.warn("Bark 推送失败 HTTP", resp.status, "，请检查 Bark Key");
        chrome.action.setBadgeText({ text: "!" });
        chrome.action.setBadgeBackgroundColor({ color: "#f6465d" });
      }
    })
    .catch(() => {});
}

// ---------- 消息桥 ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  switch (msg.type) {
    case "ensure-offscreen": // 来自 popup
      ensureOffscreen()
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;

    case "get-config": // 来自 offscreen
      readConfig()
        .then((config) => sendResponse(config))
        .catch(() => sendResponse({ apiKey: "", enabled: true, source: "tencent", watchlist: [] }));
      return true;

    case "quotes": // 来自 offscreen，行情落盘
      chrome.storage.local.set({ quotes: msg.data }).catch(() => {});
      return false;

    case "market-turnover":
      chrome.storage.local.set({ marketTurnover: msg.data }).catch(() => {});
      return false;

    case "status": // 来自 offscreen，状态落盘
      chrome.storage.local.set({ status: { mode: msg.mode, text: msg.text } }).catch(() => {});
      return false;

    case "pl-alert": // 来自 offscreen，扭亏为盈 → 角标 + Bark 推送
      chrome.action.setBadgeText({ text: "盈" });
      chrome.action.setBadgeBackgroundColor({ color: "#0ecb81" });
      chrome.storage.local.get(["barkKey", "barkEnabled"]).then(({ barkKey, barkEnabled }) => {
        if (barkEnabled && barkKey) sendBark(barkKey, msg.symbol, msg.name);
      });
      return false;

    case "clear-alert": // 来自 popup，打开面板后清除角标
      chrome.action.setBadgeText({ text: "" });
      return false;

    default:
      return false;
  }
});

// ---------- 配置变化 ----------
chrome.storage.onChanged.addListener((changes) => {
  if (changes.floatWindow !== undefined) applyFloatMode();
  if (
    changes.apiKey !== undefined ||
    changes.watchlist !== undefined ||
    changes.enabled !== undefined ||
    changes.source !== undefined ||
    changes.tradingMarkets !== undefined ||
    changes.footerSymbols !== undefined
  ) {
    readConfig().then((config) => notifyOffscreen({ type: "config-changed", ...config }));
  }
});
