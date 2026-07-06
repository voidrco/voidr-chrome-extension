# Voidr Collector Script

Browser-side session recording script for the Voidr platform. Captures DOM snapshots, user interactions, network requests, console logs, errors, and routing events — then sends them in compressed batches to the [voidr-collector](https://github.com/voidrco/voidr-collector) server.

Built on [rrweb](https://github.com/rrweb-io/rrweb) and deployed as a single IIFE bundle via CDN.

## Architecture

```
src/
  index.js                     Entry point — Proxy error wrapper + window.VoidrCollector export
  collector.js                 Public API (init, identify, updateConfig, endSession, getSessionId)
  recording.js                 rrweb setup + orchestration of all listeners/interceptors
  session.js                   Session lifecycle — user/session init, JWT authentication
  state.js                     Mutable state singleton shared across all modules
  constants.js                 Version, default config, content-type lists, automation detection
  transport.js                 Event batching, gzip compression, chunk sending, token refresh

  utils/
    helpers.js                 Pure utilities: safeStringify, generateSelector, throttle, debounce, truncate
    image-compression.js       Compress base64-encoded images via canvas (WebP, 0.4 quality)

  network/
    extractors.js              Header sanitization, body extraction, Performance API timing, content-type filtering
    fetch-interceptor.js       Monkey-patch window.fetch to capture requests/responses
    xhr-interceptor.js         Monkey-patch XMLHttpRequest to capture requests/responses

  listeners/
    events.js                  DOM event listeners (input, change, click, scroll)
    routing.js                 SPA routing capture (pushState, replaceState, popstate, hashchange)
    tracking.js                Error/rejection tracking + MutationObserver snapshot heuristics
```

## How It Works

### Initialization Flow

1. Validate API key
2. Merge user config with defaults
3. Skip recording checks (manual override, automation detection, sampling rate)
4. Initialize user ID and session ID (from sessionStorage or new)
5. Authenticate with collector server (`POST /init`) → receive JWT
6. Start rrweb recording with configured plugins and masking options
7. Initialize all listeners: DOM events, network interceptors, error tracking, routing, UI heuristics
8. Begin periodic event sending (every 7 seconds)

### Data Flow

```
Browser Events (rrweb + custom listeners)
  → Event buffer (state.events[])
  → Batch (max 100 events)
  → Compress base64 images
  → gzip with pako
  → POST /sessions/chunk (with JWT)
  → Collector server stores to cloud storage (S3/GCS/Azure)
```

### Network Capture

Both `fetch` and `XMLHttpRequest` are intercepted to capture:
- URL, method, status, duration
- Request/response headers (sensitive headers redacted)
- Request/response bodies (JSON/XML/FormData only, max 2MB)
- Performance API timing (DNS, connect, SSL, TTFB, download)
- Third-party flag (different domain than current page)

Requests to the collector itself are excluded to avoid feedback loops.

### Session Management

- Session ID: timestamp-based, stored in `sessionStorage['voidr_session_id']`
- Session expiry: configurable timeout (default 30 minutes of inactivity)
- JWT token: cached in `sessionStorage['voidr_jwt']` (1h TTL). Renewed proactively ~5 min before expiry via a scheduled `POST /refresh-token`, so long-lived tabs don't hit a 401 on the chunk-send path. A reactive refresh-on-401 remains as a fallback (e.g. server-side revocation or a missed timer), and the expiry is re-checked when the tab becomes visible again, since timers don't tick through system sleep.
- On `beforeunload`: synchronous XHR fallback to ensure event delivery

### Data Privacy

- **Block selectors**: Elements matching `[data-sensitivity="block"]` or custom selectors are excluded
- **Text masking**: Optional global text masking via `dataMasking.text`
- **Input masking**: Optional input value masking via `dataMasking.inputs`
- **Header redaction**: Authorization, cookies, tokens, API keys → `[REDACTED]`
- **Automation skip**: Recording is automatically skipped in Playwright, Selenium, Puppeteer, PhantomJS

### Error Safety

All public methods are wrapped in a `Proxy` that catches both synchronous and asynchronous errors. The collector script never throws uncaught errors that could break the host application.

## Public API

### `VoidrCollector.init(options)`

Initialize the collector. Must be called once.

```javascript
VoidrCollector.init({
  apiKey: 'your-api-key',          // Required
  user: { id: 'user-123' },       // Required

  // Optional
  collectorUrl: 'https://collector.voidr.co',
  applicationId: 'my-app',
  environment: 'production',
  samplingRate: 0.1,               // 0-1, default 10%
  sessionTimeout: 30,              // minutes
  skipRecording: false,
  system: false,
  networkCapture: true,
  captureConsole: true,
  dataMasking: {
    text: false,
    inputs: false,
    blockSelectors: ['[data-sensitivity="block"]']
  },
  meta: { tenant: 'acme' }
});
```

### `VoidrCollector.identify(id, traits)`

Update user identity mid-session. Retries up to 3 times with exponential backoff.

```javascript
VoidrCollector.identify('user-456', {
  email: 'user@example.com',
  name: 'Jane Doe'
});
```

### `VoidrCollector.updateConfig(updates)`

Update configuration at runtime (shallow merge).

```javascript
VoidrCollector.updateConfig({ samplingRate: 0.5 });
```

### `VoidrCollector.endSession()`

Stop recording, restore intercepted globals, clear sessionStorage, reset state.

### `VoidrCollector.getSessionId()`

Returns the current session ID string, or `null` if not initialized.

### `VoidrCollector.version`

Returns the SDK version string (e.g. `'1.8.2'`).

## Development

### Prerequisites

- Node.js 18+
- npm

### Setup

```bash
npm install
```

### Dev Server

Starts the Vite dev server on port 5173 with CORS enabled. Serves the built script at `/dist/recorder.min.js`.

```bash
npm run dev
```

### Build

Produces `dist/recorder.min.js` — a single minified IIFE bundle (~360 kB, ~115 kB gzipped).

```bash
npm run build
```

The `__VOIDR_COLLECTOR_URL__` define is injected at build time via the `VOIDR_COLLECTOR_URL` environment variable (defaults to `https://collector.voidr.co`).

### Format

```bash
npm run format
```

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `rrweb` | ^2.0.0-alpha.4 | Core session recording (DOM snapshots, incremental events) |
| `@rrweb/rrweb-plugin-console-record` | ^2.0.0-alpha.18 | Capture console.log/warn/error/info |
| `pako` | ^2.1.0 | gzip compression for event payloads |

## Deployment

Automated via Google Cloud Build, triggered by Git tags.

### CDN Paths

- **Versioned**: `https://cdn.voidr.co/voidr-collector/default/{TAG_NAME}/recorder.min.js`
- **Latest**: `https://cdn.voidr.co/voidr-collector/default/latest/recorder.min.js`
- **Staging**: `https://cdn.voidr.co/voidr-collector/staging/{SHORT_SHA|latest}/recorder.min.js`

### Release Process

```bash
# Bump version, commit, tag, push → triggers Cloud Build
./release.sh patch   # v1.10.0 → v1.10.1
./release.sh minor   # v1.10.0 → v1.11.0
./release.sh major   # v1.10.0 → v2.0.0
```

Cloud Build pipeline:
1. `npm install`
2. `npm run build` (with production collector URL)
3. Upload versioned + latest to GCS bucket
4. Invalidate Cloud CDN cache
5. Purge Cloudflare cache

## Technical Notes

- **SDK version**: 1.8.2 (constant in `src/constants.js`)
- **Package version**: 1.11.0 (in `package.json`)
- **Full snapshots**: Every 60 seconds or 1000 events
- **Checkout interval**: Every 120 seconds (resets incremental diff baseline)
- **Event batch frequency**: Every 7 seconds
- **Minimum batch size**: 10 events
- **Max body capture**: 2 MB (truncated beyond)
- **Image compression**: WebP, 0.4 quality, max 480px dimension
- **Build target**: ES2018
- **Output format**: IIFE (self-executing, no module loader required)
