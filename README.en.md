# Market Quotes Assistant

[简体中文](README.md) | English

> For desktop Chrome with Manifest V3 support. Mobile Chrome is not supported. This is a browser extension, not a standalone desktop application, and is not limited to macOS.

A Chrome extension for mainland Chinese, Hong Kong and US stocks, plus Binance USDT perpetual futures. Stocks use **free Tencent quotes by default**, with [TickFlow](https://tickflow.org) as an optional provider requiring an API key. Binance quotes are fetched independently. **Background fetching continues when the popup is closed.**

## Preview

![Market Quotes Assistant screenshot](QQ20261120-104311.png)

## Features

- Multiple providers: **Tencent** (default, free, no key, 5-second polling), **TickFlow** (WebSocket with REST fallback and network reconnection, API key required), and **Binance futures** (free, no key, independent 5-second polling).
- Select mainland China, Hong Kong, US and Binance markets in settings to limit searching, adding and importing symbols.
- Switch the search scope among enabled markets. In the all-markets scope, entering `BTCUSDT` or `SNDKUSDT` directly also adds a perpetual contract.
- Choose footer quotes by market, including stock indices and BTC / ETH perpetual futures. All footer quotes can be deselected.
- Enabling mainland China automatically displays **total A-share turnover across Shanghai, Shenzhen and Beijing**, plus the change versus the same minute of the previous trading day, in units of CNY 100 million.
- An Offscreen Document owns connections and polling tasks, so closing the popup does not stop quote fetching.
- Add and remove watchlist entries, group by market, edit cost prices, and sync the watchlist through `chrome.storage.sync`.
- Import and export the watchlist as JSON, including names, cost prices and profit-alert settings.
- API and Bark keys stay in `chrome.storage.local` and are not synced across devices.
- Red for gains, green for losses; adaptive decimal precision for Binance prices.
- Profit-crossing alerts: when an enabled symbol moves from a loss to a profit relative to its cost price, play a sound and show a toolbar badge. Optional Bark notifications require enabling push and saving a Bark key.
- Pause or resume all quote fetching. Choose between a separate floating window and a regular toolbar popup.

## Installation

1. Download the repository and extract it.
2. Open `chrome://extensions`.
3. Enable **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select the folder containing `manifest.json`.
5. Click the extension icon in the toolbar.

> After changing the code, click **Reload** for the extension on `chrome://extensions`.

## Providers and API Keys

The default stock provider is **Tencent**, which does not require an API key. A previously saved provider selection is preserved when the extension reloads.

| Quotes | Provider | Notes |
|--------|----------|-------|
| Mainland China / Hong Kong / US watchlist and mainland China / US footer indices | Tencent (default) or TickFlow | Select the stock provider in settings |
| Hong Kong footer indices | Tencent | Independent of the selected stock provider |
| A-share turnover and same-minute comparison | Eastmoney total A-share market | Independent, no key required |
| Binance perpetual futures | `fapi.binance.com` | Independent, no key required |
| Legacy Binance spot entries | `data-api.binance.vision` | Remain spot entries; no automatic futures conversion |

Only TickFlow requires setup:

1. Register and sign in at <https://tickflow.org>.
2. Generate an API key in the dashboard.
3. Open the extension settings, select TickFlow, paste the key and save it.

## Markets and Footer Quotes

- **Markets:** all four markets are enabled by default; at least one must remain enabled. Searching, adding and importing only accept enabled markets. If only one market is enabled, the add area uses it automatically and hides the scope buttons.
- **Existing watchlist:** disabling a market does not delete its existing entries or stop fetching their quotes.
- **Footer quotes:** all items are selected by default and can all be deselected. Disabling a market hides its footer and stops the corresponding footer subscriptions while preserving selections. Re-enabling the market restores them. A contract also present in the watchlist continues to receive quotes.

| Market | Available footer quotes |
|--------|-------------------------|
| Mainland China | SSE Composite, Shenzhen Component, ChiNext, CSI 300, SSE 50, STAR 50 |
| Hong Kong | Hang Seng, Hang Seng China Enterprises, Hang Seng TECH |
| US | Nasdaq, S&P 500, Dow Jones |
| Binance | BTC perpetual, ETH perpetual |

### A-Share Turnover

When mainland China is enabled, the footer automatically displays **cumulative turnover across Shanghai, Shenzhen and Beijing A-shares**, in units of CNY 100 million (`亿`). It remains visible even when all footer indices are deselected. Eastmoney data is requested independently every 5 seconds, without an API key and regardless of the stock provider.

- The comparison uses cumulative turnover at the **same minute of the previous trading day**, with a red `+` for an increase and a green `-` for a decrease. Historical intraday data comes from the server; the extension need not have been open the previous day.
- Live turnover and the comparison have separate timestamps. Only completed minutes available on both days are compared, so the comparison may lag slightly behind the live total. Neither yesterday's full-day total nor an unfinished minute is used for the difference.
- Trading dates come from the API. On non-trading days, the actual data date is retained rather than relabeled as today. Missing comparison data is shown as `—`. Fetch failures retain available data and show an update-failed indicator.
- Disabling mainland China hides the section and stops its requests. Pausing quote fetching also pauses turnover requests. The public Eastmoney endpoints have no stability guarantee; polling frequency does not imply real-time source data.

## Symbol Format

Stocks use `code.market`. Newly added Binance futures use `pair.PERP`.

| Market | Suffix | Examples |
|--------|--------|----------|
| Shanghai A-shares / ETFs | `.SH` | `600000.SH`, `510300.SH` |
| Shenzhen A-shares / ChiNext / ETFs | `.SZ` | `000001.SZ`, `300750.SZ`, `159915.SZ` |
| Beijing Stock Exchange (not supported by Tencent) | `.BJ` | `920662.BJ` |
| US | `.US` | `AAPL.US`, `SNDK.US` |
| Hong Kong | `.HK` | `00700.HK` |
| Binance USDT perpetual futures | `.PERP` | `BTCUSDT.PERP`, `CXMTUSDT.PERP`, `SNDKUSDT.PERP` |
| Legacy Binance spot entries / backups | No suffix | `BTCUSDT`, `ETHUSDT` |

### Binance Futures Search and Legacy Spot Entries

- Search uses Binance futures `exchangeInfo` and supports USDT perpetual contracts of type `PERPETUAL` or `TRADIFI_PERPETUAL`. Search by `BTC`, `CXMT`, `sndkusdt` or a complete `.PERP` symbol.
- Results identify perpetual contracts. Adding `BTCUSDT` saves `BTCUSDT.PERP`. The contract must exist in the fetched catalog; catalog failures or missing contracts prevent addition.
- The catalog includes public API statuses `TRADING` and `TRADING_HALT`, excluding pending listings, settling/delisted contracts and non-perpetual products. **Public API status is not equivalent to actual trading availability in the Binance app.**
- Futures quotes use the latest trade price from `/fapi/v1/ticker/24hr`, not the spot, mark or index price. Percentage changes cover **24 hours**, not a stock-market trading day.
- Existing Binance entries without a suffix remain **spot** entries and are labeled accordingly. To switch, remove the spot entry and add the futures contract. Costs and alert settings are not migrated automatically.
- Imports preserve `.PERP` as futures and legacy unsuffixed entries as spot. Entries from disabled markets, duplicates and invalid formats are skipped.

## Architecture

```text
popup.js ── read cache / render / manage watchlist ──▶ chrome.storage
                                                        ▲
offscreen.js ── quotes / status messages ──▶ background.js (SW)
      ▲                                        │
      └──── config-changed messages ◀──── storage.onChanged
```

- **market-config.js:** shared market groups, footer catalog and configuration normalization.
- **offscreen.js:** owns the TickFlow WebSocket and polling for Tencent, Hong Kong indices, legacy Binance spot, Binance futures and Eastmoney A-share turnover. Network disconnection triggers 5-second REST fallback and exponential WebSocket retry delays of 1, 2, 4 seconds and so on, capped at 10 minutes. Explicit server rejection falls back without automatic WebSocket retries. Quotes are merged by timestamp and reported only when changed; the Service Worker persists them because offscreen documents cannot access `chrome.storage` directly. Duplicate futures in the watchlist and footer share requests. Editing costs, names or alert flags does not reconnect.
- **background.js:** Manifest V3 Service Worker that creates and checks the offscreen document, bridges messages and storage, persists quotes/status, and forwards provider, key, pause, market, footer and watchlist changes.
- **popup.js:** reads cached quotes, listens for storage updates, renders the UI, manages settings/watchlist/backups and searches symbol catalogs. Settings stay synchronized between simultaneously open popup and floating windows.

## Limitations and Storage

- **Quote freshness:** polling every 5 seconds does not guarantee real-time prices. Market closures, API caches, network conditions and product differences can cause stale quotes. Data is for reference only and may differ from trading apps.
- **Tencent:** free 5-second polling, not WebSocket streaming. Supports mainland China, Hong Kong and US stocks. Mainland quotes are generally available intraday; Hong Kong quotes are usually delayed by about 15 minutes. US real-time coverage and pre-market / after-hours / overnight sessions are not guaranteed. **Beijing Stock Exchange is not supported**; missing `.BJ` quotes display `—`. Name search uses Tencent's suggestion endpoint and accepts Chinese names, pinyin and codes.
- **TickFlow:** symbol counts and refresh limits depend on current plan and API permissions. Rejected WebSocket access falls back to REST. Missing or invalid keys are reported.
- **Binance:** futures use `fapi.binance.com`; legacy spot uses `data-api.binance.vision`. Neither requires a key. Polling does not guarantee that every product trades all day or always has a fresh quote.
- **Watchlist capacity:** `chrome.storage.sync` has an 8 KB per-item limit. Capacity depends on symbol and name lengths. Failed saves are reported; reduce entries or export a JSON backup. Backups contain only the watchlist, not keys or other settings.
- **Sync scope:** the watchlist syncs through the Chrome account. Provider choice, keys, enabled markets, footer selections and switches are local to the device.
- **Background lifecycle:** the offscreen document is created at browser startup, extension load or popup opening. A Service Worker alarm checks every 5 minutes and recreates it if missing. Pausing fetching stops all quote channels.
- **Floating window:** enabled by default. Chrome has no always-on-top window API, so other windows may cover it. It stays open when clicking a webpage; it is not guaranteed to remain on top. Disable the option for a regular popup.
- **Icons:** built-in blue rounded chart icons at 16 / 32 / 48 / 128 pixels are used for the toolbar, extension list and standalone window. Reload the extension and reopen its window after icon changes.

## Files

```text
manifest.json    Manifest V3 configuration
icons/           16 / 32 / 48 / 128 px extension icons
market-config.js Shared market and footer configuration
background.js    Service Worker, offscreen checks, storage and Bark push
offscreen.html   Hidden document skeleton
offscreen.js     Background WebSocket and multi-provider polling
popup.html       Popup markup
popup.css        Styles
popup.js         Rendering, settings, search, watchlist and backups
README.md        Simplified Chinese documentation
README.en.md     English documentation
```
