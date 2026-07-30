# @qa-pipeline/widget

The in-app QA reporter. A dependency-free IIFE (everything, including
`modern-screenshot`, is bundled) that records rolling context buffers from page
load, lets a tester point at a broken element, screenshots it pre-marked, and
POSTs the whole report to the QA site. Budget: ≤80 KB gzipped.

Built by esbuild to `apps/site/public/widget.js` (+ `widget.js.map`) — the one
designated output outside this package.

## Host page integration

```html
<script
  src="https://qa.example.com/widget.js"
  defer
  data-qa-endpoint="https://qa.example.com"
  data-qa-token="…"
  data-qa-email="tester@example.com"
></script>
```

Config is read from `document.currentScript`'s dataset at load. Fallback: a
`window.QAPipeline = { endpoint, token, email, appContext, getToken }` object set
**before** the script loads. `data-qa-endpoint` falls back to the script's own
origin. **No auth (static token or `getToken`) → the widget stays dormant**: no
buffers, no UI, no requests.

### Auth: session-token bridge vs. static token

Resolved **at submit time**, in this order:

1. **`window.QAPipeline.getToken`** (preferred) — a host-provided function
   returning (a promise of) the signed-in user's Supabase access token. It is
   awaited with a 3-second timeout inside try/catch; the report is sent with
   `Authorization: Bearer <token>` and the server derives the reporter from the
   verified JWT.

   ```html
   <script>
     window.QAPipeline = {
       getToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
     };
   </script>
   ```

2. **Static token** (`data-qa-token` / `token`) — sent as `x-qa-token`, exactly
   as before. Also the fallback when the `getToken` bridge throws or times out.
3. **Neither yields a token** → the submit fails fast with the error toast
   "QA widget isn't configured — missing auth"; nothing is sent.

`appContext` (optional, `Record<string, string>`) is only available via the
`window.QAPipeline` fallback and is forwarded verbatim in the report body.

Debug handle: `window.__qaPipeline = { open(), version }`. Double-injection is
guarded via the same global.

## What it captures (from page load)

| Buffer  | Source | Limits |
|---|---|---|
| Console | wrapped `console.error/warn`, `window` `error` + `unhandledrejection` | ring 50, entries ≤500 chars |
| Network | patched `fetch` **and** `XMLHttpRequest` | ring 40; ts/method/url/status/ms for every call |
| Click trail | capture-phase click listener + patched `history.pushState/replaceState` + `popstate` | ring 50, click text ≤40 chars |

Network body snippets (≤2000 chars, via `clone()`) are captured **only** for
same-origin calls whose path contains an `/api` segment, and only when the
response is non-2xx — or a 200 with an empty body, which is stored as
`bodySnippet: ""` (empty string = "the 200 came back empty"; absent field =
"body not captured"). Request/response **headers are never stored**.

Scrubbing (`src/scrub.ts`, pure + unit-tested): `authorization`/`cookie`/
`apikey`/token-shaped keys and values, `Bearer`/`Basic` blobs, and
`eyJ…` (JWT-shaped) strings are redacted from URLs, console text, body
snippets, and any object passed through `scrubValue`.

## Report flow

fab 🐛 → menu (Report an issue / Request a feature / My reports → opens the
board) → element picker (overlaid highlight + `<Component> · file.tsx` chip
from `data-sentry-component`/`data-sentry-source-file` **or**
`data-component`/`data-source-file` — both annotation families are read, first
non-empty wins; click selects, Esc cancels) → viewport screenshot with the
element ring-marked in teal `#14B8A6` (max dimension 1600 px, data URL ≤4 MB,
`null` on any failure — the report still sends) → drawer with the captured
preview + required description → `POST {endpoint}/api/ingest` with the
`IngestBody` shape from `contracts/CONTRACTS.md`, headers
`content-type: application/json` + `Authorization: Bearer` (session bridge) or
`x-qa-token` (static). Success: toast linking to `{endpoint}{url}`. Failure:
error toast, drawer stays open with everything intact.

Feature requests skip the picker; the screenshot is the unmarked viewport.

All UI lives in a single ShadowRoot (adopted stylesheet, `<style>` fallback)
so host-page CSS can't leak in either direction. The widget's own clicks and
its ingest POST are excluded from the buffers.

## Scripts

- `npm run build` — minified IIFE (`--target=es2020`) → `../../apps/site/public/widget.js` + sourcemap
- `npm run dev` — watch-rebuild + serve the demo at http://127.0.0.1:4300
- `npm run test` — vitest (jsdom; fetch/XHR mocked — no network)
- `npm run typecheck` — `tsc --noEmit`

## Manual test (demo)

`npm run dev`, open http://127.0.0.1:4300. Click **Manage Lab Access** — it
logs a console TypeError and fires a same-origin `/api/...` fetch that 404s
(with a query token that must arrive redacted). Then report the button via the
🐛 bubble. Run the site dev server on `http://localhost:3200` for the full
ingest round-trip; without it, submitting demonstrates the failure toast +
kept-drawer path.
