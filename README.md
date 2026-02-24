# WeebCentral Extractor — Chrome Extension

Extract your WeebCentral manga subscriptions and export them to MangaUpdates, MAL, JSON, CSV, and more.

## Features

- **One-click extraction** from any WeebCentral library/subscription page (no public profile required — it reads your own session)
- **Manual URL extraction** for other profiles (must be public)
- **MangaUpdates verification** — matches titles with confidence scoring
- **Manual match correction** — review and fix low-confidence matches
- **5 export formats**: MangaUpdates list, MAL XML, JSON, CSV, Markdown table
- **Persistent cache** — MangaUpdates lookups are cached to avoid rate limits
- **In-page FAB** — floating "Extract List" button appears on WeebCentral pages
- **Dark anime-aesthetic UI** with smooth animations

## Installation (Developer Mode)

1. Download or clone this folder
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked**
5. Select this folder
6. The extension icon will appear in your toolbar

## How to Use

### Quick Extract (recommended)
1. Go to `https://weebcentral.com/users/YOUR_ID/library`
2. Click the WeebCentral Extractor icon in your toolbar
3. Click **"Extract from Current Tab"**

### URL Extract
1. Get your profile URL: `https://weebcentral.com/users/YOUR_ID/profiles`
2. Open the extension, paste the URL, click Extract

### Verify & Export
1. After extracting, go to **Verify** tab and click **Verify All**
2. Review any low-confidence matches and correct them
3. Go to **Export** tab and pick your format

## File Structure

```
weebcentral-extension/
├── manifest.json       — Extension config (MV3)
├── popup.html          — Main UI
├── popup.js            — UI logic & state management
├── background.js       — Service worker: scraping, MU API, export
├── content.js          — Injected into WeebCentral pages
└── icons/              — Extension icons
```

## Permissions

- `storage` — Save your manga list and cache locally
- `downloads` — Save export files to your computer
- `activeTab` / `scripting` — Read the WeebCentral page you're on
- `weebcentral.com` — Fetch subscription data
- `api.mangaupdates.com` — Verify titles against MangaUpdates

## Privacy

All data stays local. Nothing is sent to any third-party server except MangaUpdates' public API for title matching.
