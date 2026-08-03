# CHANGELOG v3.20.22 — FIX: 4 Tombol Screenshot Copy Mati di Popout Sidebar

**Tanggal:** 2026-08-03
**Baseline:** v3.20.21-chrome-stable
**Tipe:** Bug fix (image clipboard di iframe sidebar)

---

## Ringkasan

4 tombol screenshot copy di item sheet gagal di popout sidebar (iframe context):

| Tombol | data-a | Fungsi |
|---|---|---|
| 🖼️ **Salin Gambar** | `copy-img` | Copy gambar saja ke clipboard |
| 📋 **Salin + Keterangan** | `copy-bundle` | Gambar + caption (URL, judul, waktu, mode) |
| 📝 **Salin Teks Metadata** | `copy-meta` | Text-only (judul, waktu, URL) |
| 🔗 **Salin URL Gambar** | `copy-url` | URL cloud (Supabase Storage) |

v3.20.21 sudah fix `copy-meta` dan `copy-url` (text-based, pakai `copyTextWithFallback`).
v3.20.22 ini fix `copy-img` dan `copy-bundle` (image-based, butuh `navigator.clipboard.write`).

---

## Root Cause

`writeImageOnlyToClipboard` dan `writeScreenshotToClipboard` di `lib/copy-format.js` pakai:
- `navigator.clipboard.write([new ClipboardItem({ 'image/png': blob, ... })])`

API ini **gagal di iframe popout sidebar Chrome** karena:

1. **Document focus loss** — Chrome anggap iframe cross-origin tidak focused. Click di iframe → focus ke iframe → tapi `navigator.clipboard.write` tetap reject dengan `DOMException: Document is not focused`.

2. **Transient user activation kadang expired** — kalau ada `await` panjang sebelum `clipboard.write` (mis. `await buildCompositeImage` untuk multi-page), gesture dianggap expired.

3. **Tidak ada fallback ke context yang lebih reliable** — sebelumnya kalau strategi A/B/C gagal, hanya return `{ ok: false }` tanpa coba relay ke background/content script.

Firefox lebih permissive di sidebar/iframe context, jadi user ngasih feedback "tiru dari Firefox yang jalan normal". Tapi sebenarnya `copy-format.js` identik di kedua repo — bedanya cuma context handling browser-nya.

---

## Perbaikan

### 1. `lib/copy-format.js` — Tambah Strategi D (Background Relay)

**`writeImageOnlyToClipboard` (Salin Gambar):**
- Strategi A: `ClipboardItem({ 'image/png': blob })` (existing)
- Strategi B: `ClipboardItem({ 'text/html': '<img src=dataUrl>' })` (existing)
- Strategi C: `navigator.clipboard.writeText(dataUrl)` (existing)
- **Strategi D (BARU):** `browser.runtime.sendMessage({ type: 'COPY_IMAGE', dataUrl, mode: 'image_only' })` → background → content script tab aktif → `navigator.clipboard.write` dari halaman web context (focused)

**`writeScreenshotToClipboard` (Salin + Keterangan):**
- Strategi 1: `ClipboardItem multi-mime` (existing)
- Strategi 2: `ClipboardItem text/html + text/plain` (existing)
- Strategi 3: `navigator.clipboard.writeText(textPlain)` (existing)
- **Strategi 4 (BARU):** `browser.runtime.sendMessage({ type: 'COPY_IMAGE', dataUrl, textPlain, textHtml, mode: 'image_with_caption' })` → background → content script

### 2. `background.js` — Tambah Handler `COPY_IMAGE`

Background Service Worker terima message `COPY_IMAGE` dari popup/sidebar, lalu:
1. Kirim ke content script di **tab aktif** (strategi 1)
2. Kalau gagal, cari **tab lain** yang punya content script (strategi 2)
3. Kalau semua gagal, return error

### 3. `content/overlay.js` — Tambah Handler `COPY_IMAGE`

`overlay.js` ada di **SEMUA halaman http(s)** — fallback paling reliable. Terima `COPY_IMAGE` dari background, eksekusi `navigator.clipboard.write` dari halaman web context (yang focused).

4 strategi di content script:
1. `ClipboardItem multi-mime` (image/png + text/html + text/plain)
2. `ClipboardItem image/png` only
3. `ClipboardItem text/html` dengan `<img src="dataUrl">` embedded
4. `navigator.clipboard.writeText` (text-only fallback)

### 4. `content/content.js` — Tambah Handler `COPY_IMAGE`

Sama dengan overlay.js, tapi khusus untuk halaman AI tool (z.ai, ChatGPT, Claude, dll). Kalau sidebar dibuka di halaman AI, content.js yang handle.

---

## File yang Dimodifikasi

| File | Perubahan |
|---|---|
| `manifest.json` | Bump version 3.20.21 → 3.20.22 |
| `lib/copy-format.js` | + Strategi D di `writeImageOnlyToClipboard` dan `writeScreenshotToClipboard` |
| `background.js` | + Handler `COPY_IMAGE` (relay ke content script tab aktif) |
| `content/overlay.js` | + Handler `COPY_IMAGE` (4 strategi: multi-mime, image-only, html-embedded, text-only) |
| `content/content.js` | + Handler `COPY_IMAGE` (sama dengan overlay.js, untuk halaman AI) |

---

## Test Plan

### Test 1: Salin Gambar di popup toolbar
1. Buka halaman web http(s) → klik ikon RecallFox toolbar → popup muncul
2. Klik screenshot/document item → item sheet muncul
3. Klik tombol **🖼️ Salin Gambar**
4. **Expected:** Toast "✓ Gambar tersalin ke clipboard"
5. Paste di Google Docs / WA / Telegram → gambar muncul

### Test 2: Salin Gambar di popout sidebar (iframe) — CRITICAL
1. Buka halaman web http(s) → aktifkan popout sidebar (klik tombol "rf" floater)
2. Klik screenshot/document item → item sheet muncul di iframe
3. Klik tombol **🖼️ Salin Gambar**
4. **Expected:** Toast "✓ Gambar tersalin via tab aktif" (fallback strategi D)
5. Paste di Google Docs / WA / Telegram → gambar muncul

### Test 3: Salin + Keterangan di popout sidebar
1. Ulangi Test 2, tapi klik **📋 Salin + Keterangan**
2. **Expected:** Gambar + caption (URL, judul, waktu, mode) tersalin
3. Paste ke Google Docs → gambar + teks keterangan muncul

### Test 4: Multi-page document
1. Buka document item (multi-page) di popout sidebar
2. Klik **🖼️ Salin Gambar**
3. **Expected:** Composite grid bernomor tersalin (semua halaman jadi 1 gambar)
4. Paste → gambar grid muncul

### Test 5: Salin Teks Metadata (sudah di-fix v3.20.21)
1. Klik **📝 Salin Teks Metadata** di popout sidebar
2. **Expected:** Text-only (judul, waktu, URL) tersalin
3. Paste ke WA / Gemini chat → teks muncul

### Test 6: Salin URL Gambar (sudah di-fix v3.20.21)
1. Klik **🔗 Salin URL Gambar** di popout sidebar
2. **Expected:** URL cloud tersalin
3. Paste ke AI chat → URL muncul

### Test 7: Halaman internal (chrome://, about:blank)
1. Buka sidebar di `chrome://extensions` → klik Salin Gambar
2. **Expected:** Strategi D gagal (tidak ada content script di halaman internal)
3. Strategi C (writeText dataUrl) harusnya jalan sebagai fallback terakhir

---

## Alur Clipboard Image di v3.20.22

```
User klik "Salin Gambar" di sidebar iframe
        ↓
writeImageOnlyToClipboard(dataUrl)
        ↓
Strategi A: ClipboardItem image/png     ← GAGAL (iframe not focused)
        ↓
Strategi B: ClipboardItem text/html     ← GAGAL (same reason)
        ↓
Strategi C: clipboard.writeText(dataUrl) ← Mungkin gagal juga
        ↓
Strategi D (BARU): browser.runtime.sendMessage({ type: 'COPY_IMAGE', ... })
        ↓
background.js COPY_IMAGE handler
        ↓
Kirim ke content script di tab aktif
        ↓
overlay.js COPY_IMAGE handler (jalan di halaman web context — FOCUSED ✓)
        ↓
ClipboardItem image/png → navigator.clipboard.write
        ↓
✓ Gambar tersalin ke clipboard
```

---

## Catatan Teknis

### Kenapa `navigator.clipboard.write` gagal di iframe sidebar?

Chrome security policy: `navigator.clipboard.write()` butuh:
1. **Document focused** — iframe cross-origin sering tidak dianggap focused
2. **Transient user activation** — gesture click harus fresh (< 5 detik)
3. **Permission** — `clipboardWrite` manifest permission OK, tapi tidak cukup

Di popout sidebar (iframe `chrome-extension://<id>/sidebar/sidebar.html` yang di-embed di halaman web), kondisi #1 sering gagal. Bahkan kalau user klik tombol di iframe, Chrome tetap anggap document utama (parent page) yang focused, bukan iframe.

### Kenapa relay ke content script tab aktif works?

Content script jalan di **context halaman web** (parent page), bukan iframe extension. Halaman web pasti focused (user lihat itu sekarang). Jadi `navigator.clipboard.write` dari content script context → works.

Trade-off: butuh 1 message round-trip (popup → background → content script → response). Latensi tambahan ~50-100ms, acceptable.

### Kenapa 4 strategi di content script?

Kalau content script juga gagal (mis. halaman internal `chrome://`, `about:blank`, atau CSP ketat):
1. Multi-mime (terbaik — gambar + caption)
2. Image-only (kalau text/html Blob ditolak)
3. HTML embedded (kalau image/png Blob ditolak)
4. Text-only (last resort — setidaknya caption tersalin)

---

## Limitasi yang Masih Ada

1. **Sidebar di `chrome://` page** — content script tidak inject. Strategi D gagal. Hanya strategi A/B/C yang jalan (kemungkinan gagal juga). Workaround: buka halaman web http(s) dulu sebelum buka sidebar.

2. **Sidebar di `about:blank`** — sama seperti `chrome://`. Workaround sama.

3. **Tab aktif tidak punya content script** — kalau tab aktif adalah `chrome://extensions` atau PDF viewer, strategi D gagal. Background cari tab lain yang http(s) — kalau tidak ada, return error.

4. **Image besar (>5MB)** — message passing Chrome ada limit ~64MB untuk single message, tapi gambar base64 bisa besar. Untuk screenshot full-page 16384px, dataUrl bisa 10-20MB. Masih dalam limit, tapi kalau gagal, strategi C (text-only) akan jalan.

---

## Cara Update dari v3.20.21

1. Backup vault: Settings → Backup Lokal → Export (.json atau .rfvault)
2. Unload extension v3.20.21 dari `chrome://extensions`
3. Load extension v3.20.22 (folder ini)
4. Test: buka popout sidebar di halaman web → klik screenshot item → klik **🖼️ Salin Gambar** → paste di Google Docs → gambar muncul
