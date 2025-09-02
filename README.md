<p align="center">
  <img src="assets/logo-light.svg" alt="Voidr logo" width="140" />
</p>

# Voidr Testing Assistant – Chrome Extension (Official)

The official Chrome extension for Voidr’s AI-powered testing assistant. Plan tests and report defects directly on any web page.

## 🚀 Features (PoC)

### Current Version (v1.0.0)

- ✅ Full authentication flow with dark metallic UI
- ✅ Floating widget injectable on any page (authenticated users)
- ✅ Test planning interface (API-ready)
- ✅ Bug report interface (API-ready)
- ✅ Full-page screenshots
- ✅ Persistent settings and JWT token management
- ✅ Popup control with auth check

### Next Iterations

- 🔄 Interactive element selection with highlight
- 🔄 Auto-generation of test cases from interactions
- 🔄 Element-scoped screenshots
- 🔄 Session recording with replay
- 🔄 Automated accessibility checks
- 🔄 Offline sync for collected data

## 📁 Project Structure

```
chrome-extension/
├── manifest.json          # Extension configuration
├── auth/                  # Authentication system
│   ├── auth.html         # Login interface
│   ├── auth.css          # Dark metallic styles
│   └── auth.js           # Authentication logic
├── background/
│   └── background.js      # Service worker (API integration)
├── content/
│   ├── content.js         # Injected script (auth check)
│   └── content.css        # Widget styles
├── popup/
│   ├── popup.html         # Extension popup UI
│   ├── popup.css          # Popup styles
│   └── popup.js           # Popup logic (with auth)
├── widget/
│   └── widget.js          # Standalone widget
├── icons/
│   ├── create-icons.html  # Icon generator
│   └── README.md          # Icon instructions
├── build.md               # Build & deploy guide
└── README.md              # This file
```

## 🛠️ Development Setup

1. Clone the repository:

   ```bash
   git clone [repo-url]
   cd voidr-chrome-extension
   ```

2. Open Chrome and navigate to `chrome://extensions/`

3. Enable Developer Mode (top-right toggle)

4. Click "Load unpacked"

5. Select the project folder (this repo root)

6. The extension should appear in the list

## 🎯 Usage

### 1) First Access – Authentication

1. Install the extension (see above)
2. Click the extension icon in the toolbar
3. Click "Login" if not authenticated
4. Login to the Voidr platform in the opened tab (`localhost:3030` in dev)
5. Return to the extension – it will automatically detect authentication

### 2) Via Popup (Authenticated User)

1. Click the extension icon
2. View user information at the top
3. Use the buttons to:
   - Toggle Widget: show/hide on current page
   - Force Inject: inject widget into the page
   - Capture Screen: full-page screenshot

### 3) On the Page (Widget)

1. The widget appears as a floating button (bottom-right)
2. Click to open a panel with two tabs:
   - Planning: create test cases (API-ready)
   - Bug Report: submit issues (API-ready)

### 4) Settings

- Auto-inject: widget automatically on new pages
- Dark theme by default
- JWT token managed and refreshed automatically

## 🔧 Development Notes

- `manifest.json`: permissions, scripts, extension configuration
- `background/background.js`: service worker for communication
- `content/content.js`: main injected script
- `popup/`: extension control interface
- `widget/widget.js`: standalone widget for manual injection

### Component Communication

```
Popup ←→ Background ←→ Content Script ←→ Widget
```

- Popup: controls settings and actions
- Background: storage and messaging
- Content Script: injects and controls widget
- Widget: UI for test planning and bug reporting

### Next Development Steps

1. API Integration

   ```javascript
   const API_BASE = 'https://voidr-service-785568282479.us-central1.run.app';
   ```

2. Element Selection

   - Element highlight
   - CSS selector capture
   - Auto-generate test cases

3. Advanced Capture

   - Element-only screenshots
   - Interaction recording
   - Performance data

## 🚨 Current Limitations

- Mocked UI (no live API integration)
- Element selection not implemented
- Basic screenshots (full page only)
- No persistence for collected test data

## 🔒 Permissions

The extension requests the following permissions:

- `activeTab`: access the active tab
- `storage`: save extension settings
- `scripting`: inject scripts into pages
- `host_permissions`: run on all sites

## 🐛 Debugging

1. Popup: right‑click icon → "Inspect popup"
2. Background: go to `chrome://extensions/` → "Service worker"
3. Content Script: DevTools on the target page
4. Logs: all components log to console

## 📝 Implementation Notes

- Manifest V3
- Isolated styles with max z-index
- Asynchronous messaging between components
- Settings persist between sessions
- Responsive widget (mobile-friendly)

## 🎨 Design System

- Colors: gradient #667eea → #764ba2
- Theme: dark by default
- Typography: system fonts (-apple-system, etc.)
- Components: consistent with Voidr platform

## 📦 Production Build

Use these steps to produce a ZIP ready for the Chrome Web Store.

1) Prepare assets
- Ensure `icons/icon16.png`, `icons/icon32.png`, `icons/icon48.png`, `icons/icon128.png` exist
- Bump `version` in `manifest.json` and point API URLs to production

2) Optional minification
- You may minify JS/CSS using `uglify-js` and `clean-css-cli` (see `build.md`)

3) Create the ZIP

```bash
cd /Users/mjnr/projects/voidr-chrome-extension
zip -r voidr-extension.zip . -x "*.md" "*.git*" "node_modules/*"
```

4) Local QA
- Go to `chrome://extensions/`
- Enable Developer Mode
- Click "Load unpacked" (dev) or "Load packed" (select `voidr-extension.zip`)

5) Publish
- Upload `voidr-extension.zip` to the Chrome Web Store Developer Console
- Add screenshots and description; submit for review

See `build.md` for the full production guide and checklist.
