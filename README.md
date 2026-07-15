<p align="center">
  <a href="./README.md">English</a> · <a href="./README.zh-CN.md">简体中文</a>
</p>

<div align="center">

# ⏱️ Markline — Bookmark Timeline

**View, search, and organize your Chrome bookmarks on a visual timeline.**
Search, sync, and organize — all in one click.

[![Manifest](https://img.shields.io/badge/Manifest-V3-4285F4?logo=chromewebstore&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Version](https://img.shields.io/badge/version-1.0.0-34A853)](./manifest.json)
[![License](https://img.shields.io/badge/license-MIT-blue)](#license)
[![Languages](https://img.shields.io/badge/i18n-EN%20%7C%20简体中文-EA4335)](#languages)

</div>

---

Markline (from **Mark** + **Book** + time**line**) is a Manifest V3 Chrome extension that reimagines the bookmark manager as a **visual timeline**. It layers on the things the native manager lacks: fuzzy search with a command palette, a rule-engine + optional AI auto-tagging, a knowledge graph, broken-link checking, spaced-repetition review, hover previews (Mozilla Readability), and a statistics/health-score dashboard.

No build step, no dependencies, no framework — pure vanilla JS/HTML/CSS. Load it as an unpacked extension and go.

---

## ✨ Features

### 📅 Timeline & Browsing
- Visual timeline grouped by date (Today / Yesterday / N days ago / month–day) with a vertical rail and per-bookmark favicons.
- Sort modes: **Newest · Oldest · Hottest · Coldest** (by click count).
- **Heat coloring** — backgrounds shade from pale orange to deep "Inferno" based on visit frequency (Warm → Hot → Burning → Blazing → Inferno).
- View tabs: **All / Pinned / Duplicates**.
- Duplicate detection with URL normalization (strips UTM/tracking params and trailing slashes).

### 🔍 Search
- Fuzzy subsequence + substring matching with scoring (title 100 · tags 60 · URL 40 · domain 30 · folder 20).
- Match highlighting, recent-search history, and a keyword-suggestion dropdown navigable by keyboard.
- **Command palette** (`Ctrl/⌘+Shift+E`) with fuzzy search.
- **Omnibox** — type `mk <query>` in the address bar.

### 🏷️ Smart Tagging (the headline feature)
- A multi-signal rule engine with **200+ built-in domain rules** across dev, docs, design, learning, video, reading, news, shopping, and more.
- Combines domain rules, keyword rules, stop words, TF-IDF statistical signals, and folder-path signals.
- **Active Learning queue** — low-confidence bookmarks surface for one-tap confirm/modify/ignore, which retrains the engine.
- Dynamic rules (domain rules, keyword rules, stop words, learned mappings) editable in Settings.

### 🤖 Optional AI Integration
- Providers: **Zhipu GLM-4-Flash (free), DeepSeek, Google Gemini, OpenAI, Alibaba Tongyi, Custom**.
- Compatible with OpenAI Chat Completions, Anthropic Messages, Google Gemini, or full-URL endpoints.
- **Privacy-first** — only the title and URL are sent; page content is **never** sent to AI providers. API keys are stored locally and never synced.

### 🔗 Broken-Bookmark Checker
- HEAD → GET with retries, exponential backoff + jitter.
- Classifies results as **ok / broken (4xx, 404, DNS) / warning (timeout, network)**.
- Configurable concurrency, timeout, retry, backoff, and scheduled checks (daily/weekly/monthly).
- Optional auto-delete broken bookmarks, with desktop notifications.

### 🧠 Knowledge Graph + Spaced Repetition
- Cytoscape.js visualization; cluster by domain / tag / folder; link by domain, tag, similar title.
- Zoom, re-layout, search, export controls over a particle-canvas backdrop.
- **Spaced-repetition review** (Again / Hard / Good / Easy) for revisiting saved articles.

### 📊 Statistics & Health Score
- Totals, tags, unique domains, folders, collection trend (daily/weekly/monthly).
- Charts: top tags, top domains, active hours, folder distribution, auto-tag accuracy trend.
- A **health score** you can favorite (max 50 favorites, one per score per day).
- Export reports as **CSV** or printable **PDF**.

### 🪶 Link Preview
- Hover any bookmark → a compact preview card (image + title + description + site).
- Powered by Mozilla **Readability**; extracts `og:image`, `twitter:image`, first meaningful image, video poster, and apple-touch-icon fallbacks.
- Session + persistent cache with configurable TTL and max entries.

### 🗂️ Bookmark Management
- One-click **sync** from Chrome's native tree (preserves your tags / pins / click counts on re-sync).
- Edit modal: title, URL, tags (with autocomplete), folder picker (tree), smart folder suggestion.
- Pin/unpin to top, bulk select/pin/tag/delete.
- **Recently Deleted** with tombstones and configurable retention (7/15/30/60 days).

### ⚡ Quick Capture
- **Quick Bookmark** (`Alt+Shift+D`) — one keystroke with auto folder suggestion + auto tags.
- Right-click context menu: **"Bookmark this page" / "Remove bookmark this page"**.
- Desktop notification on save.

### 💾 Import / Export
- **JSON** (full data) and **Netscape HTML** (browser-compatible) formats.

### 📖 Standalone Reading Window
- A dedicated **reading window** (open it from the popup's ⋮ menu → "Open Panel") that turns Markline into a focused reading app.
- **MDI desktop** — open many webpages as floating, draggable sub-windows inside one window and read several articles side by side.
- Each sub-window has a **read-aloud** button, a **bookmark** button, and a hover **preview** card.
- A built-in **RSS** tab lets you read subscribed feeds without leaving the window.

### 🔊 Voice Reading (Text-to-Speech)
- Read any MDI webpage aloud with natural neural voices via **edge-tts** (Microsoft's free neural TTS).
- Backed by a tiny **local bridge** (`bridge/voice_bridge.py`, `127.0.0.1:7822`) — the only outbound traffic is to Microsoft's TTS service; nothing else leaves your machine.
- **True streaming playback**: audio begins before synthesis finishes (MediaSource API), with a live **word-level subtitle** track that scrolls in sync using edge-tts `WordBoundary` timestamps.
- **Waveform visualization** driven by the Web Audio API analyser.
- Configurable **voice, rate, pitch, volume**; auto-extracts the article body with Readability so navigation/ads are skipped.
- Long articles are split and synthesized **asynchronously**, with **prefetch** of the next chunk for seamless playback.
- Configure in **Settings → Voice**. Requires the local voice bridge running (see [Local Bridges](#local-bridges-optional)).

### 📰 RSS Subscriptions & Reader
- Subscribe to RSS/Atom feeds and read them in the standalone window's RSS panel or the popup.
- Polling at a configurable interval; **unread badges**, mark-as-read, **star**, and **save-as-bookmark** (auto-tagged).
- **Auto-discover** feeds on visited pages (context menu / active-tab detection).
- Optional **new-article desktop notifications**.
- **Proxy fallback** for sources unreachable from your network (rss2json-style or raw-XML proxies).
- Configure in **Settings → RSS**.

### 📧 Email Push (RSS → Inbox)
- Push new RSS articles to your email so you never miss an update.
- Two strategies: **instant** (a per-feed email as news breaks) or **daily digest** (one combined email at a scheduled time).
- **Providers**: HTTP API (Resend / SendGrid / Mailgun / custom) or **SMTP** via the local bridge (`bridge/smtp_bridge.py`, `127.0.0.1:7821`) — works with Gmail, QQ, 163, Outlook, and more.
- **AI Daily Briefing** (optional): when an AI provider is configured, the daily digest is rewritten into a categorized tech-news briefing (highlights + topic sections) by your chosen model.
- **Quiet hours**, cross-source **deduplication**, and keyword **include/exclude** filters.
- API keys and SMTP passwords are **encrypted at rest** and only decrypted in memory when sending.
- Configure in **Settings → Push**.

---

## 🖥️ Local Bridges (Optional)

Markline is pure client-side, but two features need a tiny local helper because the MV3 service worker cannot run Python or open raw TCP sockets:

| Bridge | Port | Purpose | Launch |
| --- | --- | --- | --- |
| `bridge/voice_bridge.py` | `127.0.0.1:7822` | edge-tts speech synthesis | `pip install -r bridge/requirements-voice.txt && python bridge/voice_bridge.py` |
| `bridge/smtp_bridge.py` | `127.0.0.1:7821` | SMTP relay for email push | `python bridge/smtp_bridge.py` |

Both bind **only to `127.0.0.1`** — they are never reachable from the network. The bridges persist no text, audio, or credentials; SMTP passwords are held in memory only for the duration of a send.

Requirements: Python 3.8+ (voice bridge) / Python 3.7+ (SMTP bridge). No other dependencies beyond `edge-tts` + `aiohttp` for the voice bridge.

---

##  Installation

There is no build step and no `package.json`.

1. **Download / clone** this repository.
2. Open `chrome://extensions` in Chrome (or any Chromium browser).
3. Enable **Developer mode** (top-right toggle).
4. Click **"Load unpacked"** and select the `chrome-bookmark-timeline` folder.
5. The Markline icon appears in your toolbar — pin it for easy access.

> Requires Chrome 102+ (Manifest V3, `chrome.scripting`, `chrome.alarms`).

> **Voice & Email Push (optional):** these features need a local Python bridge. See [Local Bridges](#local-bridges-optional) for the one-line setup.

---

## ⌨️ Shortcuts

| Action | Default | Mac |
| --- | --- | --- |
| Open command palette | `Ctrl+Shift+E` | `⌘+Shift+E` |
| Open popup | `Alt+Shift+B` | `Alt+Shift+B` |
| Quick bookmark current page | `Alt+Shift+D` | `Alt+Shift+D` |
| Omnibox search | `mk <query>` | `mk <query>` |

You can customize these in `chrome://extensions/shortcuts`.

---

## 🗺️ Project Structure

```
chrome-bookmark-timeline/
├── manifest.json              # MV3 manifest
├── rules/
│   └── frame_allow.json       # declarativeNetRequest: allow embedding pages in MDI
├── icons/                     # 16 / 48 / 128 PNG
├── _locales/
│   ├── en/messages.json       # English
│   └── zh_CN/messages.json    # Simplified Chinese
├── bridge/                    # Local Python bridges (optional)
│   ├── voice_bridge.py        # edge-tts speech synthesis server (127.0.0.1:7822)
│   ├── smtp_bridge.py         # SMTP relay server (127.0.0.1:7821)
│   └── requirements-voice.txt # edge-tts + aiohttp
├── background/
│   ├── background.js          # Service worker (sync, CRUD, checker, alarms, omnibox, RSS, push)
│   ├── voice-bridge-client.js # Voice bridge HTTP client
│   ├── push-channel.js        # RSS → email push (instant / daily, AI briefing)
│   ├── feed-fetcher.js        # RSS polling scheduler
│   ├── feed-notifier.js       # New-article notifications
│   ├── feed-discover.js       # Auto-discover feeds on visited pages
│   ├── preview-extractor.js   # Readability preview fetching & caching
│   └── vendor/
│       ├── Readability.js      # Mozilla Readability
│       └── cytoscape.min.js   # Graph library
├── content/
│   └── content-extractor.js   # On-demand content extraction (ISOLATED world)
├── shared/
│   ├── i18n.js                # Runtime i18n (en + zh_CN, switchable live)
│   ├── smart-tagger.js        # Rule-engine tagger (200+ rules)
│   ├── ai-tagger.js           # Optional cloud AI layer
│   ├── ai-logger.js           # AI classification logs
│   ├── bookmark-stats.js      # Statistics & health score
│   ├── simple-charts.js       # Hand-written SVG charts
│   ├── rss-parser.js          # RSS/Atom parsing
│   ├── feed-store.js          # RSS feed/item storage
│   └── voice-store.js         # Voice settings storage
└── pages/
    ├── popup/                 # Main timeline popup
    ├── settings/              # Multi-panel settings (incl. RSS / Push / Voice)
    ├── checker/               # Broken-bookmark checker
    ├── graph/                # Knowledge graph + review
    └── standalone/            # Standalone reading window (MDI + RSS + voice player)
```

---

## 🔐 Permissions Explained

| Permission | Why it's needed |
| --- | --- |
| `bookmarks` | Read & sync your Chrome bookmark tree |
| `storage` | Persist bookmarks, tags, settings, caches |
| `contextMenus` | Right-click "Bookmark this page" actions |
| `activeTab` | Capture the page you're on for quick bookmarking |
| `alarms` | Scheduled broken-link checks |
| `tabs` | Open bookmarks, track navigation for click counts |
| `history` | Enrich click-count statistics |
| `notifications` | Save/checker desktop notifications |
| `scripting` | Inject Readability for preview & tagging |
| `declarativeNetRequest` | Strip `X-Frame-Options`/CSP so pages load inside the MDI reading window |
| `<all_urls>` (host) | Fetch previews, check links, and poll RSS feeds on any site |

All data stays **local** on your machine. Nothing is uploaded unless you explicitly enable and configure an AI provider — and even then only titles + URLs are sent.

---

## 🌍 Languages

| Language | Code | Status |
| --- | --- | --- |
| English | `en` | Default |
| 简体中文 | `zh_CN` | Full |

The display language is switchable live in **Settings → Appearance** (System / English / 简体中文) — no reload required.

---

## 🛠️ Tech Stack

- **Chrome Extension** — Manifest V3, service-worker background
- **Vanilla JavaScript** (ES2020+), HTML5, CSS3 with design tokens
- **Vendored libraries** (no npm):
  - [Mozilla Readability](https://github.com/mozilla/readability) — article extraction
  - [Cytoscape.js](https://js.cytoscape.org/) — knowledge graph
- **Custom modules** — i18n, smart-tagger, ai-tagger, ai-logger, bookmark-stats, simple-charts
- **Optional AI providers** — Zhipu GLM-4-Flash, DeepSeek, Google Gemini, OpenAI, Alibaba Tongyi, Custom
- **Local bridges** (optional Python helpers, no pip required beyond `edge-tts`/`aiohttp`):
  - `bridge/voice_bridge.py` — edge-tts neural TTS (text-to-speech)
  - `bridge/smtp_bridge.py` — SMTP relay for email push

---

## 🧪 Development

There is no test suite and no bundler. To work on the extension:

1. Load it as an unpacked extension (see [Installation](#-installation)).
2. Edit any file under `chrome-bookmark-timeline/`.
3. Go to `chrome://extensions` and click the **reload** ↻ icon on the Markline card.
4. Inspect the service worker via the **"Inspect views: service worker"** link for `console.*` logs.

> Tip: Keep `chrome://extensions` open in a tab while developing for one-click reloads.

---

## 📦 Release / Packaging

To distribute a CRX-free ZIP for sideloading:

1. Zip the contents of `chrome-bookmark-timeline/` (the folder containing `manifest.json` should be the top-level entry, or zip its contents directly).
2. Distribute the `.zip`. Users load it via "Load unpacked" after extracting, or via enterprise policy.

For Chrome Web Store submission, upload the same zip through the [Developer Dashboard](https://chrome.google.com/webstore/devconsole/).

---

## 🗒️ Privacy

- All bookmark data, tags, settings, and caches are stored locally in `chrome.storage.local`.
- The extension does **not** collect analytics or telemetry.
- **AI features are fully opt-in.** When enabled, only bookmark **titles and URLs** are sent to your chosen provider — never page content. API keys are stored locally and never synced.
- **Voice Reading** sends the page text you choose to read to Microsoft's edge-tts service via the local `voice_bridge.py` on `127.0.0.1`. The bridge persists nothing — no text or audio is ever written to disk.
- **Email Push (SMTP)** relays mail through the local `smtp_bridge.py` on `127.0.0.1`; SMTP credentials are encrypted at rest and held in memory only for the duration of a send.
- Readability extraction happens **locally in your browser** for tagging and preview generation; the extracted text never leaves your device unless you paste it somewhere yourself.

---

## <a name="license"></a>📄 License

This project is released under the **MIT License**. See [LICENSE](./LICENSE) for details.

Vendored libraries retain their own licenses:
- `Readability.js` — Apache-2.0 (Mozilla)
- `cytoscape.min.js` — MIT (Cytoscape.js)

---

<div align="center">

**Markline** — give your bookmarks a timeline. ⏱️

Made with vanilla JS and ☕.

</div>
