# Console Capture

A browser extension for **Chrome** and **Firefox** (same codebase, Manifest V3) that silently records everything happening in a page while you browse, so you can analyze it later. Built for bug bounty hunting and web security research.

---

## What it captures

| Category | Details |
|---|---|
| **Console logs** | `log`, `info`, `warn`, `error`, `debug`, `trace`, `assert`, `table`, `dir` — with file:line source |
| **Unhandled errors** | Uncaught exceptions and unhandled promise rejections, with full stack |
| **Network errors** | 4xx/5xx, CORS failures, DNS errors, blocked requests (via `webRequest`) |
| **JS Surface (recon)** | All functions exposed on `window.*` — path, signature, source location, body snippet. Flags **interesting** ones: params that look like URLs/redirects, bodies with sinks (`fetch`, `XMLHttpRequest`, `innerHTML`, `eval`, `location`, …). Candidate SSRF / open redirect / DOM XSS vectors. Re-sweeps on every SPA route change. |
| **Runtime (recon)** | Everything the page stores and exchanges at runtime: localStorage, sessionStorage, cookies; `__NEXT_DATA__`, `__NUXT__`, Redux/Apollo state, `window.env/config`; `postMessage` (sent + received, with origin); `fetch`/XHR/WebSocket/EventSource calls (method, URL, body) |
| **Secrets** | Automatic detection for JWT, AWS AKIA, GCP AIza, Stripe `sk_live_`, GitHub `gh[pousr]_`, Slack `xox*`, Bearer tokens, Airtable PAT, PEM keys, and keyword-based patterns (`token=`, `apikey=`, `secret=`, …). The regex is **editable and persisted** — adapt it to your target's token format. |

All data is stored in **IndexedDB** (tied to the extension's origin) and **survives browser close/reopen**. Nothing is sent anywhere. Data is only deleted when you click "Limpar".

---

## Screenshots

> _Add screenshots here after loading the extension. Suggested: popup, viewer Console tab, viewer Runtime tab with a secret highlighted, viewer Funções tab._

---

## Installation

### Chrome / Edge / Brave

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `console-capture/` folder
4. The extension icon appears in the toolbar. Click it to open the popup.

### Firefox 128+

1. Go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…** → select `manifest.json`
3. The extension stays loaded until Firefox is closed (temporary add-on)

> **Permanent install on Firefox:** sign the extension via `web-ext sign` (can be "unlisted") or use Firefox Developer Edition / Nightly with `xpinstall.signatures.required=false`.

> If the popup shows a permission warning, click **Grant access** — Firefox treats MV3 host permissions as optional.

---

## Usage

### Popup

- **Toggle** (sliding switch) — pause/resume recording without losing saved data
- **Capture network errors** — toggle `webRequest` 4xx/5xx capture
- **Map exposed JS functions** — toggle JS surface sweep
- **Capture runtime** — toggle storage/globals/postMessage/network intercept
- **Open viewer** — opens the full viewer in a new tab
- **Limpar** (double-click to confirm) — wipes all stored data

### Viewer

The viewer has four tabs: **Todos** (all), **Console**, **Runtime**, **Funções** (JS surface).

**Search bar** — substring by default; click `.*` to switch to full regex. Matches are **highlighted in green** inline.

**Filtros ▾** — dropdown with all filter panels. Content adapts per tab:
- **Todos**: all filters combined — kinds, levels, runtime types, só segredos, só interessantes
- **Console**: log levels (log / info / warn / error / debug / trace / rede) + select all/none
- **Runtime**: type (storage / global / postMessage / rede) + secrets-only + editable regex
- **Funções**: "só interessantes" (only flagged candidates)

**Site ▾** — filter by hostname across all data.

**Exportar ▾** — JSON (all tabs), `.log` (console), CSV (runtime / funções).

**⋯** — auto-refresh toggle, manual refresh, clear.

#### Secret regex editor

In Runtime → Filtros → "Editar regex de segredos…": opens a dialog to edit the regex that classifies secrets. Changes take effect immediately on all already-captured data (no re-capture needed). Persisted in extension storage. "Reverter ao original" resets to the built-in default.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Page (MAIN world)                                       │
│  inject.js — hooks console.*, fetch, XHR, WS, postMsg   │
│              sweeps window globals on route change       │
└─────────────────┬───────────────────────────────────────┘
                  │ CustomEvent (console-capture:*)
┌─────────────────▼───────────────────────────────────────┐
│  Content script (isolated world)                         │
│  bridge.js — batches + relays events to background       │
└─────────────────┬───────────────────────────────────────┘
                  │ chrome.runtime.sendMessage
┌─────────────────▼───────────────────────────────────────┐
│  background.js (service worker)                          │
│  ├─ webRequest.onCompleted / onErrorOccurred (4xx/5xx)   │
│  ├─ stores to IndexedDB via db.js                        │
│  └─ updates badge (green ON when enabled)                │
└─────────────────────────────────────────────────────────┘
                  │ IndexedDB (extension origin)
┌─────────────────▼───────────────────────────────────────┐
│  viewer.html + viewer.js                                 │
│  └─ reads db.js directly, renders + filters + exports    │
└─────────────────────────────────────────────────────────┘
```

**Key design choices:**
- `inject.js` runs in `world: "MAIN"` so it shares the page's JavaScript context and can intercept `console.*` before any framework overrides them.
- Source locations (`file:line`) are extracted from `new Error().stack`, filtering out extension frames via a `SELF` constant computed from the first stack frame at init time (Firefox-compatible).
- The JS surface sweep uses a hidden same-origin iframe to get the browser's built-in globals baseline, then excludes those from the `window` walk — only page-defined symbols are reported.
- Secret detection runs at **view time**, not capture time. The regex is evaluated when rendering/filtering, so editing it re-classifies all existing data instantly.
- The `runtime` store deduplicates by a composite key (type + name/url + area), incrementing a `count` field on repeated signals instead of creating duplicate rows.

---

## Limitations

- Messages the browser writes directly to DevTools (CORS headers, mixed content warnings, "Issues" panel deprecations) don't pass through the page's JS — they won't appear here. Network errors are caught via `webRequest`; for the rest, use DevTools.
- `postMessage` **received** has no source location (the listener fires asynchronously). Sent messages do have source. Use DevTools → Event Listener Breakpoints → Window → `message` for received source tracing.
- **Web Workers and Service Workers** of the page are not captured.
- If the page overwrites `console.log = () => {}` before `inject.js` runs, those calls are lost (same behavior as DevTools).
- Requests in the very first milliseconds after cold browser start may escape before the service worker initializes.
- The JS surface sweep is most useful on legacy/jQuery-era apps and sites that expose global SDKs. Modern Webpack/Vite SPAs keep everything in module scope — yield will be low.

---

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest, permissions, content script declarations |
| `inject.js` | MAIN world injector — hooks, surface sweep, runtime capture |
| `bridge.js` | Isolated world relay — batches CustomEvents → background |
| `background.js` | Service worker — storage writes, webRequest, badge |
| `db.js` | IndexedDB wrapper (entries, surface, runtime stores) |
| `popup.html/js` | Extension popup UI |
| `viewer.html/js` | Full viewer — tabs, search, filters, export |
| `style.css` | Shared CSS variables (light/dark) and log-level badge styles |
| `icons/` | Extension icons (16/32/48/128 px) |

---

## License

MIT
