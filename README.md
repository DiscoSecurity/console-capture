# Console Capture

A browser extension for **Chrome** and **Firefox** (same codebase, Manifest V3) that silently records everything happening in a page's JavaScript context while you browse, so you can analyze it later. Built for **security research and bug bounty hunting**.

> **Hunting bugs with us?** Join the community for daily writeups, payloads, recon tricks and more tools like this: **[linkme.bio/DISCOsecurity](https://linkme.bio/DISCOsecurity)**

---

## What it captures

| Category | Details |
|---|---|
| **Console logs** | `log`, `info`, `warn`, `error`, `debug`, `trace`, `assert`, `table`, `dir` — with file:line source |
| **Unhandled errors** | Uncaught exceptions and unhandled promise rejections with full stack trace |
| **Network errors** | 4xx/5xx, CORS failures, DNS errors, blocked requests (via `webRequest`) |
| **JS Surface** | All functions exposed on `window.*` — path, arity, params, source location, body snippet, "interesting" flag. Re-sweeps on every SPA route change. Detail dialog shows all loaded scripts. |
| **Runtime signals** | localStorage, sessionStorage, cookies; `__NEXT_DATA__`, `__NUXT__`, Redux/Apollo state, `window.env/config`; `postMessage` (sent + received, with origin); `fetch`/XHR/WebSocket/EventSource calls (method, URL, body) |
| **Taint tracking** | Full taint system — monitors values you type into page inputs and alerts when those values reach any of ~30 hooked JS sinks. Survives full page navigations. See the dedicated section below. |
| **Secrets** | JWT, AWS `AKIA`, GCP `AIza`, Stripe `sk_live_`, GitHub `gh[pousr]_`, Slack `xox*`, Bearer tokens, Airtable PAT, PEM keys, and keyword-based patterns (`token=`, `apikey=`, `secret=`, …). The regex is **editable and persisted**. |

All data is stored in **IndexedDB** (tied to the extension's origin) and **survives browser close/reopen**. Nothing is sent anywhere. Data is only deleted when you click "Limpar".

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

## Quickstart

1. Install the extension (see above).
2. Navigate to a target page. The extension starts recording automatically.
3. Interact with the page — fill in forms, click links, trigger API calls.
4. Click the extension icon → **Open viewer** to inspect everything captured.
5. To test taint tracking, type `canxpixo` into any input on the target page. If a taint hit appears in the **Taint** tab, detection is working end-to-end.

---

## Popup controls

| Control | What it does |
|---|---|
| **Toggle** (sliding switch) | Pause/resume recording without losing saved data |
| **Capture network errors** | Toggle `webRequest` 4xx/5xx capture |
| **Map exposed JS functions** | Toggle JS surface sweep |
| **Capture runtime** | Toggle storage/globals/postMessage/network intercept |
| **Capture taint** | Toggle taint sink interception |
| **Open viewer** | Opens the full viewer in a new tab |
| **Limpar** (double-click to confirm) | Wipes all stored data for the current tab |

---

## Viewer

The viewer has five tabs: **Todos** (all), **Console**, **Runtime**, **Funções** (JS surface), **Taint**.

### Common controls

| Control | What it does |
|---|---|
| **Search bar** | Substring match across the active tab's key fields. Click `.*` to switch to full regex. Matches are highlighted in green inline. |
| **Filtros ▾** | Dropdown with filter panels. Content adapts per tab (see below). |
| **Site ▾** | Filter by hostname across all data. |
| **Exportar ▾** | JSON (all tabs), `.log` (console), CSV (runtime / funções). |
| **⋯** | Auto-refresh toggle (polls every ~2 s), manual refresh, clear. |

---

### Tab: Todos

Shows every captured item across all categories in a single list.

**Filters available:**
- Log level checkboxes (log / info / warn / error / debug / trace / rede) + select all/none
- Runtime type checkboxes (storage / global / postMessage / rede)
- **Só segredos** — show only runtime items that matched the secret regex
- **Só interessantes** — show only surface functions flagged as interesting
- **Buscar no código (snippet)** — include function body snippets in the search (see Funções section)

All filters are active simultaneously. The filter badge shows how many are active.

---

### Tab: Console

Captures `console.log/info/warn/error/debug/trace`, `assert`, `table`, `dir`, uncaught exceptions, unhandled rejections, and network errors.

Each entry shows: timestamp, level badge, message, source file:line, page URL.

**Filters:**
- Log level checkboxes — individually toggle which levels are visible
- **Select all / none** quick buttons

**Search:** matches `message + source + pageUrl`.

---

### Tab: Runtime

Captures everything the page stores or exchanges at runtime.

| Type | What it captures |
|---|---|
| `storage` | `localStorage.setItem`, `sessionStorage.setItem`, `document.cookie` writes |
| `global` | `window.*` keys matching config/state patterns (`__NEXT_DATA__`, `redux`, `apollo`, `env`, …) |
| `postmessage` | `window.postMessage` (sent + received), with origin and direction |
| `rede` | `fetch`, XHR, WebSocket, EventSource — method, URL, request body |

Rows are **deduplicated by composite key** — repeated identical signals increment a counter instead of creating duplicate entries.

**Filters:**
- Type checkboxes (storage / global / postMessage / rede)
- **Só segredos** — show only entries matching the secret regex
- **Editar regex de segredos…** — opens the regex editor dialog

**Search:** matches `name + url + origin + value + area + secret[]`.

**Secret regex editor:** edits the pattern used to classify secrets. Changes take effect immediately on all already-captured data (no re-capture needed). Persisted in extension storage. "Reverter ao original" resets to the built-in default.

---

### Tab: Funções (JS Surface)

Sweeps `window.*` to enumerate all page-defined functions. Runs on page load and re-sweeps on every SPA navigation (pushState, replaceState, popstate, hashchange), with a debounce and a labelled sweep reason.

Each function shows:
- **Path** — e.g. `window.myApp.auth.login`
- **Params** — extracted from `fn.toString()`
- **Sweep reason** — when/why it was found (e.g. `init`, `3s-after-load`, `route-change`)
- **Script origin** — `//# sourceURL=` if embedded by the bundler
- **Reasons** — what made it interesting (e.g. `param:url`, `body:innerHTML`)
- **Snippet** — first ~300 chars of the function body (expandable in detail dialog)

A function is flagged **interesting** if any parameter name matches the hint pattern (url, href, redirect, src, html, template, etc.) or if the body contains a dangerous sink (fetch, XMLHttpRequest, innerHTML, eval, location, etc.).

**Filters:**
- **Só interessantes** — show only flagged functions
- **Buscar no código (snippet)** — by default, search only matches path, params, reasons, and scriptOrigin. Enable this checkbox to also search inside function body snippets (useful to find functions that use a specific API, at the cost of more noise).

**Search:** matches `path + params + reasons + scriptOrigin` (plus snippet when "buscar no código" is on).

**Detail dialog** (click any row):
- Full params, reasons, snippet, and sweep metadata
- **Scripts JS carregados** — lists all `<script src>` URLs captured at sweep time (up to 30). Useful for identifying which bundle a function came from when the bundler does not embed `sourceURL`.

---

### Tab: Taint

Dedicated taint-tracking view. The taint system is the most powerful feature of Console Capture. It monitors values you type into page inputs and alerts when those values reach any of ~30 hooked JavaScript sinks.

---

## Taint tracking

### How it works

1. You type a value into an input on the target page (any `<input>`, `<textarea>`, `<select>`, or `[contenteditable]`). The extension captures it automatically when the value is at least `taintMinLen` characters long.
2. `inject.js` hooks ~30 dangerous JS sinks.
3. When a hooked sink receives an argument containing your tracked value (case-insensitive substring match), a **taint hit** is recorded.
4. Hits appear in the **Taint** tab with the sink name, the tainted value, the full argument that reached the sink, and a stack trace.

### Cross-navigation persistence

Taint values captured from inputs survive full page navigations — including form submits that cause a complete page reload. If you type a payload, submit a form, and the next page reflects your input into a sink, the hit is still detected. Custom persistent words (see below) additionally survive browser restarts.

### Monitor bar

The monitor bar sits at the top of the Taint tab and shows all currently tracked words as colored tags. It has two rows:

- **Row 1 — Persistent custom words** (red tags): includes the `canxpixo` default canary plus any words you add manually. These survive browser restarts and page navigations. They are re-sent to `inject.js` on every page load via the config event.
- **Row 2 — Captured from inputs** (teal tags): values dynamically captured from page inputs in the current session. Shows up to 5; click **Palavras** to see all. Each tag has a `×` remove button.

Additional controls on the monitor bar:
- **Refresh button `↺`** — asks the active tab to re-emit its current taint state.
- **Palavras** button — opens a dialog listing all captured and custom words with remove buttons on each, plus an input to add new custom words.
- **Sinks** button — opens a dialog to enable or disable individual sinks. Changes are saved on close. **Reverter** re-enables all sinks (resets `enabledSinks` to null).

### Canary word: `canxpixo`

`canxpixo` is included as a default persistent custom word. Its 8-character length avoids false positives in base64 blobs and random strings. Type it anywhere on a target page to verify that taint detection is working end-to-end before you start a real test.

### Hooked sinks

| Group | Sinks |
|---|---|
| **XSS / HTML injection** | `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `document.writeln` |
| **Code execution** | `eval`, `Function()`, `setTimeout` (string form), `setInterval` (string form), `script.src` |
| **Redirect / Navigation** | `location.href`, `location.assign`, `location.replace`, `window.open`, `history.pushState`, `history.replaceState` |
| **SSRF / Network** | `fetch`, `XMLHttpRequest.open`, `XMLHttpRequest.send`, `WebSocket`, `EventSource` |
| **HTML attribute setters** | `setAttribute` (all attrs), `setAttributeNS` (xlink:href), IDL property setters for `iframe.src`, `object.data`, `embed.src`, `link.href`, `media.src`, `form.action`, `a.href` |
| **Sensitive globals** | `window.name`, `document.domain`, `localStorage.setItem`, `sessionStorage.setItem`, `document.cookie` setter, outbound `postMessage` |

### Taint hit detail dialog

Click any taint hit row to open its detail dialog:

- **Sink name** and the tainted value (highlighted)
- **Full sink argument** — the complete HTML/JS/URL string that reached the sink
- **Stack trace** with directional arrows:
  - `✖` (red) — where the sink fired (top of the trace)
  - `↑` (green) — call frames going back to the origin
  - Read the trace **bottom-to-top**: bottom frame = where the call originated, top frame = where the sink fired
- **Source column notation** — `file:75:35` means line 75, character offset 35 within that line. Hover over any `file:line:col` reference to see a tooltip confirming the line and column.

### Taint configuration

| Setting | Default | Meaning |
|---|---|---|
| `taintMinLen` | `2` | Minimum character length for a captured value to be tracked |
| `taintMaxValues` | `0` (unlimited) | Maximum simultaneous tracked values. 0 = no cap. Set to a positive integer to evict oldest values when full. |
| `enabledSinks` | `null` (all active) | Set to an explicit string array to whitelist specific sinks. `null` means all sinks are enabled. |

---

## Filters and search reference

| Filter | Where | What it does |
|---|---|---|
| **Site ▾** | All tabs | Filter by hostname |
| **Text search** | All tabs | Substring or regex match across key fields |
| **Buscar no código** | Todos, Funções | Extends search into function body snippets |
| **Só interessantes** | Todos, Funções | Shows only functions flagged as interesting |
| **Só segredos** | Todos, Runtime | Shows only items with detected secrets |

---

## Stack traces

Stack traces appear on console errors, unhandled exceptions, and taint hits. Read them **bottom-to-top**:

- Bottom frame = where the call originated (call origin)
- Top frame = where the sink fired or the error was thrown

Arrow conventions used in taint hit traces:
- `✖` (red) = the sink site (where the dangerous call was made)
- `↑` (green) = call frames going back toward the origin

Source locations use the notation `file:line:col`, where `col` is the character offset within that line.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Page (MAIN world)                                       │
│  inject.js — hooks console.*, fetch, XHR, WS, postMsg   │
│              sweeps window globals on route change       │
│              monitors inputs + hooks all taint sinks     │
└─────────────────┬───────────────────────────────────────┘
                  │ CustomEvent (console-capture:*)
┌─────────────────▼───────────────────────────────────────┐
│  Content script (isolated world)                         │
│  bridge.js — batches + relays events to background       │
│              saves taint state snapshot to storage.local │
└─────────────────┬───────────────────────────────────────┘
                  │ chrome.runtime.sendMessage
┌─────────────────▼───────────────────────────────────────┐
│  background.js (service worker)                          │
│  ├─ webRequest.onCompleted / onErrorOccurred (4xx/5xx)   │
│  ├─ stores to IndexedDB via db.js                        │
│  └─ updates badge (green = ON)                           │
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
- Secret detection runs at **view time**, not capture time. The regex is evaluated when rendering and filtering, so editing it re-classifies all existing data instantly.
- The `runtime` store deduplicates by a composite key (type + name/url + area), incrementing a `count` field on repeated signals instead of creating duplicate rows.
- **Taint state** (currently tracked input values) bypasses IndexedDB — it is pushed from inject.js via `CustomEvent` → bridge.js → `storage.local.taintState` so the viewer can read it live without polluting the runtime store.
- **Custom taint words** are stored in `storage.local.taintWordlist` and propagated to inject.js via the CONFIG event on every page load. They are never cleared on navigation.
- **`enabledSinks`** in storage is `null` (all sinks active) or an explicit array of sink names. `null` is the clean default — no stale disabled state.

---

## Storage keys (extension storage.local)

| Key | Type | Meaning |
|---|---|---|
| `enabled` | bool | Recording on/off |
| `captureNetwork` | bool | webRequest capture on/off |
| `captureSurface` | bool | JS surface sweep on/off |
| `captureRuntime` | bool | Runtime signals on/off |
| `captureTaint` | bool | Taint sink capture on/off |
| `maxEntries` | number | 0 = keep forever; N = prune DB to N entries |
| `taintWordlist` | string[] | Persistent custom taint words (survives restart) |
| `taintState` | `{values: [{v, ts}]}` | Live snapshot of captured input values (current page) |
| `enabledSinks` | null \| string[] | null = all sinks active; array = explicit whitelist |
| `secretRegex` | string | Custom secret detection regex |

---

## Limitations

- Messages the browser writes directly to DevTools (CORS header warnings, mixed content warnings, Issues panel deprecations) do not pass through the page's JS — they will not appear here. Network errors are caught via `webRequest`; for the rest, use DevTools.
- `postMessage` **received** events have no source location (the listener fires asynchronously). Sent messages do have source. Use DevTools → Event Listener Breakpoints → Window → `message` for received source tracing.
- **Web Workers and Service Workers** of the page are not captured. Worker URLs are flagged by the `Worker` and `serviceWorker.register` taint sinks if tainted, but their internal execution is not observed.
- Sandboxed iframes with a different origin cannot be instrumented — `inject.js` only runs in the top-level page context.
- If the page overwrites `console.log = () => {}` before `inject.js` runs, those calls are lost (same behavior as DevTools).
- Requests in the very first milliseconds after cold browser start may escape before the service worker initializes.
- The JS surface sweep is most useful on legacy/jQuery-era apps and sites that expose global SDKs. Modern Webpack/Vite SPAs keep everything in module scope — surface yield will be low.
- **Taint tracking** requires you to interact with the page. Values are only captured from input events — pre-filled values at load time are not automatically tracked unless you modify the field.
- `script.src` is hooked for taint via `Object.defineProperty` — dynamically inserted scripts whose `src` is assigned before append are caught; scripts built entirely by the framework before `inject.js` initializes are not.
- Functions whose source contains `[native code]` are skipped in the surface sweep. Proxied or bound functions may show truncated parameter lists.
- `loadedScripts` (script URLs shown in the function detail dialog) is a snapshot of `<script src>` elements present in the DOM **at sweep time** — scripts injected after the sweep are not listed.

---

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest, permissions, content script declarations |
| `inject.js` | MAIN world injector — console hooks, surface sweep, runtime capture, input tracking, taint sink hooks |
| `bridge.js` | Isolated world relay — batches CustomEvents → background; saves taint state to storage |
| `background.js` | Service worker — storage writes, webRequest, badge |
| `db.js` | IndexedDB wrapper (entries, surface, runtime stores) |
| `popup.html/js` | Extension popup UI |
| `viewer.html/js` | Full viewer — tabs, search, filters, export |
| `style.css` | Shared CSS variables (light/dark) and log-level badge styles |
| `icons/` | Extension icons (16/32/48/128 px) |

---

## Data privacy

All captured data is stored locally in IndexedDB on your machine, scoped to the extension's origin. Nothing is transmitted to any server. The extension has no analytics, no telemetry, and no network calls of its own. To wipe all stored data for a tab, double-click **Limpar** in the popup.

---

## License

MIT
