# Voidr Testing Assistant

<img src="https://unicorn-images.b-cdn.net/277503c3-f842-45d5-88de-69c30719b278?optimizer=gif" width="200" alt="Voidr Logo" />

**Chrome extension for in‑context test planning, exploration, and defect reporting**

> **voidr-testing-assistant** brings a floating, workspace‑aware testing experience to any website.
> It lightly integrates with the Voidr platform, using authenticated API calls and a Manifest V3 service worker.

## Overview

A focused, browser‑native assistant for test planning, exploratory testing, and defect reporting directly inside the page under test. Lightly integrated with the Voidr platform, it keeps quality work close to actual user experience while supporting local, staging, and production environments.

### Highlights
- **Floating popup** that opens instantly and reuses the same window to avoid clutter
- **Defect reporting** with screenshots, severity/priority, and automatic context
- **Test planning shortcut** to open the full plan on the platform when needed
- **Session hooks** to start/stop sessions and capture session identifiers
- **Authentication sync** with the platform and safe token lifecycle handling
- **Environment configuration** via `config/env.js` for quick local/prod switching

---

## Features

- **Popup workspace**
  - Minimal, fast UI with modern icons and responsive layout
  - Re-focus existing popup windows instead of spawning duplicates
  - Quick actions: inject widget, capture screenshot, open test plan

- **Defect creation (API-backed)**
  - Create defects with title, description, severity, priority, reproducibility
  - Auto‑capture environment details (OS, browser)
  - File attachments via private storage service
  - Uses a background service worker to submit authenticated API requests

- **Screenshots**
  - Capture the visible tab and attach as evidence when needed

- **Widget injection**
  - Inject the Voidr testing widget in the active tab on demand

- **Sessions**
  - Optional integration with the Voidr Collector to obtain a `sessionId`
  - Broadcast session start/stop events to keep UIs in sync

- **Authentication**
  - Sync with the Voidr platform; validate and refresh state in the background
  - Clear expired tokens automatically and prompt for reconnection

- **Settings and storage**
  - Persist user settings and last context via `chrome.storage`

- **Environment config**
  - `config/env.js` exposes `__VOIDR_ENV__` with sensible defaults:
    - `VOIDR_API_BASE_URL` (default dev: `http://localhost:8000/v1`)
    - `VOIDR_PLATFORM_URL` (default dev: `http://localhost:3030`)
    - Optional: `VOIDR_AUTH0_DOMAIN`, `VOIDR_AUTH0_CLIENT_ID`, `VOIDR_AUTH0_AUDIENCE`
  - Example template provided at `config/env.example.js`

---

## Project Structure

```
.
├── manifest.json
├── assets/
│   ├── logo-light.svg
│   └── lucide-icons.js
├── auth/
│   ├── auth.css
│   ├── auth.html
│   └── auth.js
├── background/
│   └── background.js
├── content/
│   ├── content.css
│   └── content.js
├── popup/
│   ├── popup.css
│   ├── popup.html
│   └── popup.js
├── services/
│   ├── defectsService.js
│   ├── privateStorageService.js
│   └── testPlanningService.js
├── widget/
│   └── widget.js
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
├── config/
│   ├── env.example.js
│   └── env.js
├── build.md
└── README.md
```

---

## Development Setup

1) Clone and install

```bash
git clone <repo-url>
cd voidr-chrome-extension
npm install
```

2) Load unpacked in Chrome

```text
chrome://extensions → Enable Developer Mode → Load unpacked → select this folder
```

3) Configure environment (optional)

```text
Copy config/env.example.js → config/env.js and adjust values as needed
Defaults for local dev:
- VOIDR_API_BASE_URL = http://localhost:8000/v1
- VOIDR_PLATFORM_URL = http://localhost:3030
```

---

## Usage

1) Click the extension icon to open the popup

2) Authenticate (if prompted). The extension syncs with the Voidr platform and validates your session.

3) Use quick actions:
- Inject the widget into the active tab
- Capture a screenshot of the visible area
- Open the full test plan in the platform

4) Report a defect
- Provide title, description, severity/priority, and reproducibility
- Attach screenshots or files if needed
- The background worker sends authenticated API requests on your behalf

---

## Permissions

- `activeTab`: interact with the current tab when you initiate an action
- `storage`: persist settings and local auth state
- `scripting`: inject the widget and helper scripts on demand
- `notifications`: lightweight user feedback
- `host_permissions`: operate across arbitrary domains under test

---

## Build and Packaging

The repository includes scripts to generate a Chrome Web Store‑ready ZIP in `dist/`.

```bash
# Build without minification
npm run extension:build

# Optional: minify JS/CSS then build
npm run extension:build:minified

# Clean generated ZIP
npm run extension:clean
```

See `build.md` for a full production guide (icons, versioning, checklist).

---

## Security & Privacy

- No hidden collection: the extension only injects or captures data when you explicitly trigger an action.
- Token lifecycle: expired tokens are cleared and you’ll be asked to reconnect securely.
- Minimal surface: permissions are limited to what’s necessary for testing workflows.

---

## Troubleshooting

- Inspect the popup: right‑click the extension icon → “Inspect popup”
- Service worker logs: `chrome://extensions` → click the extension → “Service worker”
- Content script logs: open DevTools in the page you’re testing

---

## About Voidr (brief)

Voidr provides a modern, AI‑enhanced testing platform spanning planning, automation, service virtualization, synthetic data, and analytics—designed to work in your cloud and integrate with CI/CD. This extension keeps day‑to‑day testing close to the page under test while remaining a light companion to the broader platform.

---

## License

UNLICENSED
