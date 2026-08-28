# RecallFox v3.12.1 — FIX document viewer blank (image tidak tampil)

**Tanggal**: 24 Juli 2026
**Sesi**: Hotfix v3.12.0 bug
**Pencatat**: Agung Wahyudi
**Total perubahan**: 6 files (3 baru, 3 dimodifikasi)

---

## Ringkasan

Hotfix untuk bug di v3.12.0: multi-page document viewer (window.open + document.write + inline script dengan base64 JSON besar) → **image tidak tampil**, hanya UI navigasi (prev/next/dots) yang muncul, layar hitam.

**Solusi**: Ganti viewer custom → static HTML page yang dibuka sebagai tab biasa via `browser.tabs.create()`. Image di-render via `<img src="cloudUrl">` langsung — **Firefox native yang load** dari Supabase Storage public URL. Tidak ada inline script, tidak ada base64 JSON, CSP-safe, debuggable (user bisa View Source di tab viewer).

---

## User feedback

> "hasilnya blank, hitam aja, multi-page viewer (window baru) dengan navigasi prev/next, arrow keys ←/→, dan pagination dots, navigasinya aja yang muncul, layarnya gelap.
>
> apakah tidak ada solusi? pake yang sudah ada di pasaran aja atau fitur firefox nya sendiri untuk view"

Saran "pakai fitur Firefox sendiri" jadi inspirasi: tombol "↗ Buka di tab" yang membuka halaman saat ini sebagai tab terpisah → user pakai **image viewer native Firefox** dengan zoom controls built-in.

---

## Akar masalah v3.12.0

Viewer lama (`openDocumentViewer` di popup.js):

```js
// v3.12.0 (broken)
const w = window.open('');
const pagesJson = JSON.stringify(pageDataUrls).replace(/<\/script>/gi, '<\\/script>');
w.document.write('<!DOCTYPE html>...' +
  '<script>' +
  'var pages = ' + pagesJson + ';' +
  'function render(i) { ... img.src = p; ... }' +
  'render(0);' +
  '<\/script>' +
  '</body></html>');
```

Penyebab blank kemungkinan besar:
1. **`pages[0]` null** saat `render(0)` dipanggil → image di-`display:none`
2. Atau **CSP / inline script issue** di Firefox MV3 (about:blank + inline script)
3. Atau **JSON besar ter-truncate** saat `document.write` (base64 dataUrl bisa MB)

---

## Solusi v3.12.1

### Arsitektur baru

```
User klik dokumen
  ↓
popup.js openDocumentViewer(id)
  ↓
browser.tabs.create({ url: 'popup/viewer.html?id=...' })
  ↓
viewer.js init() 
  ↓
runtime.sendMessage({ type: 'GET_DOCUMENT_PAGES', id })
  ↓
background.js handler — return { title, pages: [{url, ...}], ... }
  ↓
viewer.js renderPage(0)
  ↓
<img src="cloudUrl"> — Firefox native load dari Supabase Storage
  ↓
(onerror → fallback strategy 2 → fallback strategy 3)
```

### 3 strategi load image (fallback berlapis)

| Strategi | Kapan dipakai | Latency |
|----------|---------------|---------|
| 1. `<img src="page.url">` | Default — cloud URL public Supabase Storage | ~200-500ms |
| 2. `GET_SCREENSHOT_BLOB` message | Untuk halaman 1, mungkin ada di cache lokal `rf_shot_<id>` | <50ms (cache hit) |
| 3. `fetch(url) → blob URL` | Kalau strategi 1 gagal (CORS, network glitch) | ~500ms |

Setiap strategi punya **timeout 15 detik**. Kalau semua gagal, tampilkan error box dengan tombol "Coba lagi".

### File baru

| File | Fungsi |
|------|--------|
| `popup/viewer.html` | Static shell: topbar + page-wrap + dots + nav |
| `popup/viewer.css` | Dark theme minimal (#0c0a09 bg) supaya gambar dokumen menonjol, spinner + error box + responsive |
| `popup/viewer.js` | Logika multi-page: parse `?id=`, request metadata, render dots, handle prev/next/keyboard, 3-strategi image load, download, "Buka di tab" |

### File dimodifikasi

| File | Perubahan |
|------|-----------|
| `manifest.json` | Bump 3.12.0 → 3.12.1, tambah `viewer.{html,js,css}` ke `web_accessible_resources` |
| `popup/popup.js` | Ganti body `openDocumentViewer()` — sekarang hanya cek metadata lalu `browser.tabs.create({ url: viewer.html?id=... })` |
| `background.js` | Tambah handler `GET_DOCUMENT_PAGES` (return page URLs + metadata dari vault) dan `DOWNLOAD_URL` (download via `browser.downloads.download`) |

---

## Fitur baru di viewer

Selain fix bug, viewer baru punya 2 tombol tambahan:

1. **⬇️ Download** — download halaman saat ini via `browser.downloads.download` (filename otomatis: `<title>_hal<N>.jpg`)
2. **↗ Buka di tab** — buka halaman saat ini sebagai tab terpisah → pakai **image viewer native Firefox** dengan zoom controls built-in (Ctrl+scroll, +/-, reset). Ini jawaban langsung untuk saran user "pakai fitur Firefox sendiri untuk view"

---

## Validasi

- `node --check` OK di `popup/popup.js`, `popup/viewer.js`, `background.js`
- `python3 -c "json.load(open('manifest.json'))"` OK
- `web-ext lint`: 0 errors / 111 warnings
  - Baseline v3.12.0: 112 warnings
  - v3.12.1: 111 warnings (−1, karena hapus inline script + document.write)

---

## Cara test

1. `about:debugging` → Load Temporary Add-on → pilih `manifest.json`
2. Buka dokumen dari PWA (atau tunggu polling addon 1 menit untuk sync)
3. Klik dokumen → tab viewer terbuka
4. Test:
   - Navigasi: Prev/Next, arrow keys ←/→, dots pagination
   - Download: tombol ⬇️ → file muncul di Downloads
   - Buka di tab: tombol ↗ → tab baru dengan image viewer native Firefox (zoom pakai Ctrl+scroll)
5. DevTools: F12 di tab viewer → Console — sekarang error bisa kelihatan jelas karena HTML statis (kalau masih ada masalah)

---

## Catatan migration

- **Tidak perlu re-install data** — tidak ada perubahan schema DB
- **Tidak ada migration** — viewer baru tidak tergantung data PWA, hanya baca `source.pages[].url` yang sudah ada
- **Backward compatible** — dokumen yang dibuat di PWA v1.4.0+ tetap bisa di-view; addon v3.12.0 sebelumnya juga tetap bisa lihat document (hanya viewer-nya yang bermasalah)
