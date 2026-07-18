# 🦊 RecallFox (Chrome Version)

> **Chrome extension all-in-one untuk produktivitas AI + kehidupan Muslim Indonesia.**
> Vault prompt & konteks, screenshot FireShot-style, Content Guardian, waktu shalat Muhammadiyah, tracker ngaji & olahraga, volume booster, side panel — semua lokal-first, tanpa server, tanpa telemetry.

**Versi:** 3.7.2 · **Manifest:** V3 · **Browser:** Chrome 114+ · **Lisensi:** MIT

Ini adalah versi Chrome dari [RecallFox](https://github.com/agungkesmas/recallfox) (aslinya Firefox addon). Semua fitur sama, hanya adaptasi API untuk Chrome.

## Perbedaan dengan Firefox version

| Aspek | Firefox | Chrome |
|-------|---------|--------|
| Background | `background.scripts` (module) | `background.service_worker` (module) |
| Sidebar | `sidebar_action` (auto-toggle) | `side_panel` API (manual toggle via `chrome.sidePanel.open()`) |
| API namespace | `browser.*` (promise-based) | `chrome.*` (mixed, polyfill via `lib/browser-polyfill.js`) |
| Icons | SVG supported | PNG recommended (untuk notifications) |
| Permissions | `menus` | `contextMenus` |
| Min browser | Firefox 115+ | Chrome 114+ (sidePanel API) |

## Fitur

Semua fitur RecallFox Firefox tersedia:
- 🗄️ Vault (Prompt, Konteks, Link, Bundle, Snapshot, Screenshot)
- 🤖 AI Integration (7 AI domain + 6 provider)
- 🛡️ Content Guardian (filter berita negatif + Mode Anak)
- 🧱 Element Blocker
- 🎯 Screenshot (3 mode)
- 🔊 Volume Booster
- 🕌 Waktu Shalat Muhammadiyah + tracker ngaji/olahraga
- 📝 Catatan (12 warna + group)
- 💾 Backup & Sync

## Install

### Cara 1 — Load unpacked (untuk dev)
1. Download/clone repo ini
2. Buka `chrome://extensions`
3. Aktifkan **Developer mode** (toggle kanan atas)
4. Klik **Load unpacked**
5. Pilih folder repo ini
6. Addon aktif — ikon 🦊 RecallFox muncul di toolbar

### Cara 2 — Install dari ZIP
1. Download file ZIP dari [Releases](../../releases)
2. Extract ZIP ke folder
3. Ikuti langkah 2-6 di atas

### Cara 3 — Chrome Web Store (coming soon)
Akan di-submit ke Chrome Web Store setelah review internal.

## Cara Pakai

1. Klik ikon 🦊 di toolbar → popup muncul
2. Atau tekan `Alt+Shift+4` → side panel terbuka
3. Setup AI: Tools → Tanya AI → pilih provider (Groq gratis recommended)
4. Mulai simpan prompt/konteks/link via klik kanan di halaman web
5. Screenshot: `Alt+Shift+5/6/7` untuk full/area/viewport

## Lisensi

MIT — bebas pakai, modifikasi, distribusi.
