# RecallFox v3.20.51-stable — CHECKPOINT

**Release date:** 2026-08-07
**Tag:** `v3.20.51-stable` (CHECKPOINT — stable release)
**Manifest version:** `3.20.51`

## TL;DR

Versi ini ditandai sebagai **STABLE CHECKPOINT** setelah serangkaian fix kritis dari v3.20.32 sampai v3.20.51. Semua fitur utama sudah tested + syntax valid + tidak ada regression known.

## Fitur stabil di checkpoint ini

### 1. Magic Folder (Auto Group AI) — v3.20.28-v3.20.31
- ✅ AI reasoning untuk struktur folder optimal (baca konteks item)
- ✅ Subfolder support (nested, max depth 2)
- ✅ Checkbox per folder di preview modal (user bisa pilih folder mana yang dibuat)
- ✅ Tombol "🔄 Usulan Lain" untuk regenerate struktur alternatif
- ✅ "Ketik ide struktur sendiri" (collapsible section) — user bisa ketik ide, AI ikuti kerangka
- ✅ Folder existing bisa dipindahkan ke folder baru via `folderIds`
- ✅ Item yang sudah di folder TIDAK dipertimbangkan (hanya item loose)
- ✅ Strict rollback guardrail (snapshot vault sebelum apply, rollback kalau gagal)
- ✅ Fix bug "messages: expected array, received string" (defensive payload)

### 2. Magic Command — v3.20.32
- ✅ Ketik perintah natural language untuk pindahkan item ke folder
- ✅ AI parse intent + cari item yang cocok + tentukan folder tujuan
- ✅ Support: move to existing folder OR create-and-move (folder baru)
- ✅ Confirmation modal sebelum apply
- ✅ Contoh perintah clickable

### 3. Folder Archive Recursive — v3.20.32
- ✅ Arsipkan folder + semua isinya sekaligus (recursive)
- ✅ Restore balik ke parent folder asalnya (parentId tetap sama)
- ✅ Menu folder: "📦 Arsipkan Folder" + "📤 Restore Folder"

### 4. Import Paket Multi-Type — v3.20.26
- ✅ Schema v2 (`recallfox-pack`): link + prompt + context + note + snapshot
- ✅ Schema v1 (`recallfox-link-pack`): link-only, backward compat 100%
- ✅ Type DITOLAK: screenshot, document, bundle (risiko tinggi)
- ✅ Validasi per-type: url untuk link, body untuk text, contextPurpose whitelist, color whitelist
- ✅ Auto-extract variables `{{var}}` untuk prompt
- ✅ Preview modal dengan type counts + reasoning

### 5. Standarisasi Tombol Sisip + Salin — v3.20.47
- ✅ Prompt/context/snapshot: 2 tombol eksplisit (Sisip + Salin)
- ✅ `data-prompt-action="inject"` → doInject (coba sisip ke active tab)
- ✅ `data-prompt-action="copy"` → copyItemBody (clipboard only, TIDAK coba inject)
- ✅ 4-level clipboard fallback chain (modern API → background → content script → textarea)
- ✅ console.log untuk debugging

### 6. Upload File Teks — v3.20.40 (Chrome only)
- ✅ Chrome: detached window (`chrome.windows.create`) — fix popup closes saat file picker
- ✅ Firefox: direct file input di popup (popup stays alive)
- ✅ Support: .md, .txt, .json, .html, .csv, .yaml (maks 2MB)
- ✅ Drag & drop + click to select

### 7. Popout Sidebar Fixes — v3.20.21-v3.20.22
- ✅ Tombol pengaturan (gerigi) jalan di popout sidebar (openSettings helper dengan fallback)
- ✅ Tombol Salin jalan di popout sidebar (4-level clipboard fallback)
- ✅ Screenshot capture tidak ikut popout sidebar (display:none + try/finally restore)
- ✅ Fallback timer 5s untuk restore sidebar setelah screenshot

### 8. Session Persistence — v3.20.27
- ✅ Industry-standard session management (refresh lock + proactive refresh)
- ✅ Fix "sehari logout" bug (race condition + aggressive logout)
- ✅ Background alarm every 45 min untuk keep session alive

## File kritis yang sudah stabil

### Firefox (`recallfox/`)
- `popup/popup.js` — UI logic, item actions, Magic Folder, Magic Command
- `background.js` — message handlers, session, screenshot capture
- `content/content.js` — injectText, getEditor, clipboard fallback
- `content/sidebar-cs.js` — popout sidebar logic
- `lib/vault-tree.js` — aiAutoGroup (Magic Folder AI)
- `lib/magic-command.js` — parseMagicCommand, applyMagicCommand, archive folder
- `lib/link-pack.js` — import paket multi-type
- `lib/assistant.js` — chat() defensive payload, isAssistantConfigured
- `lib/storage.js` — addItem, updateItem, getVault, saveVault
- `lib/supabase-client.js` — session management

### Chrome (`recallfox-chrome/`)
- Semua file di atas (parity dengan Firefox)
- `popup/upload-window.html` + `popup/upload-window.js` — detached window untuk upload file teks
- `lib/browser-polyfill.min.js` — browser API polyfill

## Regression check

- ✅ Syntax valid semua file kritis (node --check pass)
- ✅ Magic Folder: 9 test scenarios passed (nested, reasoning, checkbox, regenerate, userInstruction)
- ✅ Magic Command: 7 test scenarios passed (parse, apply, archive recursive)
- ✅ Import Paket: 8 test scenarios passed (v1 compat, v2 multi-type, validation)
- ✅ Standarisasi tombol: console.log untuk debugging, 4-level clipboard fallback
- ✅ Backward compat: schema v1 link-pack tetap jalan, aiAutoGroup tanpa userInstruction tetap jalan

## Cara rollback ke checkpoint ini

```bash
# Firefox
git clone https://github.com/agungkesmas/recallfox.git
cd recallfox
git checkout v3.20.51-stable

# Chrome
git clone https://github.com/agungkesmas/recallfox-chrome.git
cd recallfox-chrome
git checkout v3.20.51-chrome-stable
```

## Versi dev setelah checkpoint ini

Setelah v3.20.51-stable, versi dev berikutnya akan mulai dari v3.20.52-dev. Kalau ada regression di versi dev, user bisa selalu rollback ke v3.20.51-stable.

## Catatan

- **Chrome upload file teks** pakai detached window karena Chrome MV3 popup closes saat file picker terbuka. Firefox tidak butuh ini.
- **Magic Folder AI** butuh AI Assistant configured (Groq/OmniRouter/dll). Kalau belum setup, toast "⚠ Setup AI Assistant dulu".
- **Import Paket** support max 100 item per paket, max 10MB file size.
- **Folder Archive** recursive — folder + semua subfolder + items diarsipkan sekaligus.
