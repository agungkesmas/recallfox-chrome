# CHANGELOG v3.20.21 — FIX: Tombol "Salin ↵" Tidak Berfungsi di Popout Sidebar

**Tanggal:** 2026-08-03
**Baseline:** v3.20.20-chrome-stable
**Tipe:** Bug fix (clipboard + UI handler)

---

## Ringkasan

Versi v3.20.20 punya 4 root cause kenapa tombol "Salin ↵" (untuk item prompt/context/snapshot) tidak berfungsi di popout sidebar:

1. **Tombol "Salin ↵" tidak punya handler khusus** — `cta-pill` generik (untuk prompt/context/snapshot) tidak punya `data-*` attribute, jadi klik jatuh ke `primaryAction()` yang selalu inject ke textarea AI. User expect "Salin" = copy ke clipboard.

2. **Background Service Worker Chrome MV3 tidak bisa akses `navigator.clipboard`** — kode lama di `background.js` panggil `navigator.clipboard.writeText()` langsung dari SW, yang **selalu gagal** di Chrome MV3 (SW tidak punya document context).

3. **Message `COPY_TEXT` tidak ada listener** — background kirim `{ type: 'COPY_TEXT' }` ke content script, tapi tidak ada file yang listen untuk message type ini. Fallback diam-diam gagal.

4. **Sidebar pakai iframe approach** — RecallFox Chrome pakai iframe yang di-inject ke halaman web via `sidebar-cs.js` (bukan `chrome.sidePanel` API). `navigator.clipboard` di iframe cross-origin akan gagal karena document tidak dianggap "focused" oleh Chrome.

---

## Perbaikan

### 1. `popup/popup.js` — Handler cta-pill generik + `copyTextWithFallback()`

**Tambah handler untuk tombol "Salin ↵" / "Sisipkan ↵"** (prompt/context/snapshot):
- Deteksi klik pada `.cta-pill` yang tidak punya `data-link-action` / `data-bundle-action` / `data-shot-action`
- Cek label tombol: kalau mengandung "Salin" ATAU bukan di halaman AI → copy ke clipboard
- Kalau "Sisipkan" DAN di halaman AI → inject ke textarea AI (fall through ke `primaryAction`)

**Tambah fungsi `copyTextWithFallback(text)`** dengan 3 lapis fallback:
- **A.** `navigator.clipboard.writeText()` — modern API, works di popup yang focused
- **B.** `document.execCommand('copy')` via `<textarea>` tersembunyi — works di iframe sidebar
- **C.** `browser.runtime.sendMessage({ type: 'COPY_TO_CLIPBOARD' })` → background → content script

**Refactor 14 call site** yang sebelumnya pakai `navigator.clipboard.writeText` langsung untuk pakai `copyTextWithFallback`:
- `vaultBatchCopyTextAction` — batch copy teks
- `vaultBatchCopyUrlsAction` — batch copy URL gambar
- `copyImageUrlToClipboard` — copy URL gambar single
- `vaultBatchCopyMetaAction` — batch copy teks metadata
- `vaultBatchCopyBundleAction` — batch copy bundle
- `_vaultBatchCopyTextFallback` — fallback composite image text
- `copyLinkToClipboard` — copy URL link
- `doInject` — fallback saat inject gagal
- `continueInOtherAI` — copy snapshot body saat pindah AI
- `injectBundle` — copy bundle saat inject gagal
- `copyScreenshotMetaToClipboard` — copy teks metadata screenshot
- Catatan editor `nCopy` button — copy catatan
- GDrive `rfGdCopyUrl` dan `rfGdCopyToken` — copy URL & token
- AI Assistant `askAiCopy` — copy jawaban AI
- Resume context `copy-resume` action — copy resume context

### 2. `background.js` — Fix `COPY_TO_CLIPBOARD` handler

**Hapus** `navigator.clipboard.writeText()` dari Service Worker (selalu gagal di Chrome MV3).

**Strategi baru:**
1. Kirim `{ type: 'COPY_TEXT' }` ke content script di tab aktif
2. Kalau tab aktif adalah halaman internal (`chrome://`, `about:blank`), coba tab lain yang ada content script-nya
3. Kalau semua gagal, return error — popup sudah harusnya pakai `execCommand` fallback sendiri sebelum kirim ke sini

### 3. `content/content.js` — Tambah listener `COPY_TEXT`

Content script yang ada di halaman AI tool sekarang listen untuk `COPY_TEXT` message dan panggil `copyToClipboard()` lokal (sudah ada fungsi `copyToClipboard` di file ini dengan fallback `execCommand`).

### 4. `content/overlay.js` — Tambah listener `COPY_TEXT`

Karena `overlay.js` ada di **SEMUA halaman http(s)** (bukan cuma halaman AI), ini fallback paling reliable. Listen `COPY_TEXT`, pakai `navigator.clipboard.writeText` kalau halaman focused, fallback ke `document.execCommand('copy')` via textarea tersembunyi.

---

## File yang Dimodifikasi

| File | Perubahan |
|---|---|
| `manifest.json` | Bump version 3.20.20 → 3.20.21 |
| `popup/popup.js` | +1 fungsi `copyTextWithFallback`, +1 handler `cta-pill`, refactor 14 call site `navigator.clipboard.writeText` |
| `background.js` | Rewrite `COPY_TO_CLIPBOARD` handler (hapus `navigator.clipboard` dari SW) |
| `content/content.js` | +1 handler `COPY_TEXT` di `runtime.onMessage` listener |
| `content/overlay.js` | +1 handler `COPY_TEXT` di `runtime.onMessage` listener |

---

## Test Plan

### Test 1: Tombol "Salin ↵" di popup toolbar (non-AI page)
1. Buka halaman web biasa (mis. `https://example.com`)
2. Klik ikon RecallFox di toolbar → popup muncul
3. Klik tombol "Salin ↵" pada item prompt/context/snapshot
4. **Expected:** Toast "📋 Teks disalin (X karakter)" muncul
5. Paste di mana saja (Ctrl+V) → teks item ter-paste

### Test 2: Tombol "Salin ↵" di popout sidebar (iframe)
1. Buka halaman web biasa
2. Aktifkan popout sidebar RecallFox (klik tombol sidebar in-page)
3. Klik tombol "Salin ↵" pada item prompt/context/snapshot
4. **Expected:** Toast "📋 Teks disalin (X karakter)" muncul
5. Paste di mana saja → teks item ter-paste

### Test 3: Tombol "Salin ↵" setelah pencarian
1. Buka popup/sidebar RecallFox
2. Ketik kata kunci di kotak pencarian
3. Klik tombol "Salin ↵" pada item hasil pencarian
4. **Expected:** Sama seperti Test 1/2 — teks tersalin
5. **Verify:** Tidak ada error "undefined" atau item tidak ditemukan

### Test 4: Tombol "Sisipkan ↵" di halaman AI
1. Buka `https://chatgpt.com` (atau AI tool lain)
2. Klik ikon RecallFox → popup muncul, tombol berubah jadi "Sisipkan ↵"
3. Klik tombol "Sisipkan ↵" pada item prompt
4. **Expected:** Teks ter-inject ke textarea ChatGPT

### Test 5: Salin URL Link
1. Klik tombol "Salin ↵" pada item Link
2. **Expected:** URL (bukan body) tersalin ke clipboard

### Test 6: Salin Bundle
1. Klik tombol "Salin ↵" pada item Bundle
2. **Expected:** Gabungan semua anggota bundle tersalin

### Test 7: Batch copy
1. Aktifkan mode Batch
2. Pilih beberapa item
3. Klik "📋 Copy Teks" / "📋 Copy + Keterangan" / "📝 Copy Teks Saja"
4. **Expected:** Semua item tersalin dengan format rapi

---

## Catatan Teknis

### Kenapa `navigator.clipboard.writeText` gagal di iframe sidebar?

RecallFox Chrome pakai pendekatan **iframe** untuk sidebar (lihat `content/sidebar-cs.js`):
- Iframe di-inject ke halaman web dengan `src = chrome-extension://<id>/sidebar/sidebar.html`
- Iframe jalan di context `chrome-extension://` tapi embedded di halaman web lain
- Chrome security policy: `navigator.clipboard.writeText` di iframe cross-origin **hanya works kalau iframe document focused**
- Saat user klik tombol di iframe, iframe document memang focused — TAPI beberapa browser version masih gagal karena iframe dianggap "cross-origin embedded"

Solusi: fallback ke `document.execCommand('copy')` via `<textarea>` tersembunyi yang di-append ke `document.body` iframe. Karena textarea ada di document yang sama dengan tombol yang di-klik, focus sudah benar dan execCommand works.

### Kenapa `navigator.clipboard.writeText` gagal di background Service Worker Chrome MV3?

Chrome MV3 Service Worker **tidak punya DOM** (tidak ada `document`, `window`). `navigator.clipboard` ada di SW context tapi `writeText()` butuh "transient user activation" yang tidak bisa didapat dari SW context. Hasilnya: Promise reject dengan `DOMException: Document is not focused`.

Solusi: background tidak boleh panggil clipboard langsung. Yang dilakukan: kirim message ke content script di tab aktif, content script yang execute clipboard call di context halaman web (yang focused).

### Kenapa butuh 2 content script listener (content.js + overlay.js)?

- `content/content.js` hanya inject di halaman AI tool (7 domain: z.ai, ChatGPT, Claude, Gemini, DeepSeek, Qwen, Kimi)
- `content/overlay.js` inject di SEMUA halaman http(s) — untuk floating screenshot button

Karena user bisa buka sidebar di halaman mana saja (bukan cuma AI), kita butuh `overlay.js` yang lebih universal untuk handle `COPY_TEXT`. Kalau sidebar dibuka di halaman AI, `content.js` akan handle duluan (karena manifest urutkan `overlay.js` dulu, baru `content.js` di halaman AI — keduanya listen, tapi `content.js` punya fungsi `copyToClipboard` yang lebih lengkap dengan execCommand fallback).

Sebenarnya `overlay.js` akan handle dulu karena di-listen duluan di listener chain, tapi keduanya akan respond. Chrome akan pakai response pertama yang `ok: true`.

---

## Limitasi yang Masih Ada

1. **Clipboard image (composite screenshot)** — `writeScreenshotToClipboard` masih pakai `navigator.clipboard.write` (ClipboardItem) yang juga bisa gagal di iframe sidebar. Untuk image, fallback-nya sudah ada: download file PNG + copy textPlain. User bisa download manual + paste text.

2. **Sidebar di halaman `chrome://`** — content script tidak bisa inject ke halaman internal browser. Kalau user buka sidebar di `chrome://extensions` lalu klik Salin, hanya `execCommand` fallback yang jalan. Ini masih works karena `execCommand` di iframe extension context tetap jalan (iframe document focused).

3. **Sidebar di `about:blank`** — sama seperti `chrome://`, content script tidak inject. Fallback `execCommand` di iframe masih works.

---

## Cara Update dari v3.20.20

1. Backup vault: Settings → Backup Lokal → Export (.json atau .rfvault)
2. Unload extension v3.20.20 dari `chrome://extensions`
3. Load extension v3.20.21 (folder ini)
4. Verify: klik tombol "Salin ↵" di popup/sidebar — harus muncul toast "📋 Teks disalin"
5. Test paste (Ctrl+V) di notepad/chat → teks item harus ter-paste
