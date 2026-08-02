# RecallFox Chrome Extension

Port dari Firefox addon [RecallFox](https://github.com/agungkesmas/recallfox) ke Chrome MV3.

## Status

✅ **Stable v3.20.19** — full parity dengan Firefox v3.20.19-stable. Port fitur: Popout Sidebar, OmniRouter provider, Relay Point (snapshot → resume context via AI), Anchor AI Answer (prompt fix — anchor utama = jawaban AI terakhir).

**Download:** [recallfox-chrome-v3.20.19.zip](https://github.com/agungkesmas/recallfox-chrome/releases/download/v3.20.19-chrome-stable/recallfox-chrome-v3.20.19.zip) — extract, lalu `chrome://extensions` → Developer mode → Load unpacked.

Latest release: [v3.20.19-chrome-stable](https://github.com/agungkesmas/recallfox-chrome/releases/tag/v3.20.19-chrome-stable)

## Perbedaan dari Firefox Addon

| Aspek | Firefox | Chrome |
|-------|---------|--------|
| Background | `background.scripts` + `type: module` | `service_worker` + `type: module` |
| Sidebar | `sidebar_action` + `browser.sidebarAction` | `side_panel` + `chrome.sidePanel` (Chrome 114+) |
| Context Menu | `browser.menus` + permission `menus` | `browser.contextMenus` + permission `contextMenus` (via polyfill) |
| Namespace | `browser.*` native | `browser.*` via [webextension-polyfill](https://github.com/mozilla/webextension-polyfill) |
| Icons | SVG | PNG (SVG support inconsistent di Chrome) |
| browser_specific_settings | `gecko.id` | Dihapus |
| Commands | `_execute_sidebar_action` | `_execute_action` |

## Struktur

```
recallfox-chrome/
├── manifest.json           ← Chrome MV3 manifest
├── background.js           ← Service worker (import polyfill di awal)
├── lib/
│   ├── browser-polyfill.min.js  ← webextension-polyfill v0.12.0
│   ├── sidebar-compat.js        ← Abstraksi Firefox sidebarAction vs Chrome sidePanel
│   └── ... (shared dengan Firefox)
├── popup/                  ← Popup UI
├── sidebar/                ← Side panel UI (Chrome 114+)
├── content/                ← Content scripts
├── settings/               ← Settings page
├── icons/                  ← PNG icons (converted dari SVG)
└── _locales/               ← i18n
```

## Cara Load (Development)

1. Buka `chrome://extensions`
2. Aktifkan "Developer mode" (kanan atas)
3. Klik "Load unpacked"
4. Pilih folder `recallfox-chrome/`
5. Extension muncul di toolbar

## Minimum Chrome Version

- **Chrome 114+** (Mei 2023) — untuk Side Panel API
- Chrome 99+ untuk Promise-based `chrome.*` API (polyfill handle)

## Fitur yang Berjalan

✅ Vault (prompt, context, snapshot, link, bundle, document, screenshot)
✅ Folder tree (nested, DnD, sort, tag filter, breadcrumb, color)
✅ Sidebar / Side Panel
✅ Context menu (save as prompt/context/link/snapshot/screenshot)
✅ Keyboard shortcuts (capture, clear cache, volume, dll)
✅ Sync Supabase (cross-device)
✅ Waktu shalat Muhammadiyah + habits tracker
✅ Content Guardian (YouTube/X blocker)
✅ Volume booster (600% per tab)
✅ RecallTape (keyboard-first calculator)
✅ Screenshot FireShot-style (visible/entire/selection)

## Kompatibilitas

- Schema storage sama dengan Firefox addon → sync cross-device via Supabase
- Code shared 95% dengan Firefox (hanya polyfill + sidebar-compat yang beda)
- Tidak ganggu repo Firefox — repo terpisah

## Build

Tidak butuh build step — load langsung dari folder.

Untuk distribusi (`.zip`):
```bash
cd recallfox-chrome
zip -r recallfox-chrome-v3.20.5.zip . -x ".git/*" -x "node_modules/*"
```
