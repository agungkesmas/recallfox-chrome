# RecallFox v3.14.8 — Fix Tombol "Salin Gambar" Tidak Berfungsi

**Tanggal:** 25 Jul 2026
**Tag sebelumnya:** v3.14.7
**Tipe:** Bug fix (Sesi 1 follow-up #3)

## Ringkasan

User feedback setelah v3.14.7:

> "sudah berjalan tapi salin gambar doangnya tidak bisa. apa ini bug juga?"

Investigasi menemukan akar masalah di `writeScreenshotToClipboard` saat dipanggil dengan `textHtml=''` (empty string):

### Diagnosis

Tombol "Salin Gambar" v3.14.7 memanggil:
```js
writeScreenshotToClipboard(targetDataUrl, label, '')
//                                              ^^^ textHtml kosong
```

Di `writeScreenshotToClipboard`:
- **Strategi 1** (ClipboardItem image/png + text/html + text/plain): sering gagal karena:
  - Empty `text/html` Blob (`new Blob([''], { type: 'text/html' })`) kadang ditolak browser
  - Untuk multi-page, `await buildCompositeImage()` makan waktu lama → user gesture expired → `navigator.clipboard.write` throw `NotAllowedError`
- **Strategi 2** (`if (textHtml)`): **SKIP** karena `''` adalah falsy di JavaScript
- **Strategi 3** (`writeText(label)`): fallback ke text-only, hanya menyalin teks pendek "Laporan Bulanan (3 halaman)"

Hasil: clipboard berisi teks pendek, **bukan gambar**. User paste ke WA/Telegram hanya melihat teks → dianggap "tidak berfungsi".

Sedangkan "Salin + Keterangan" berhasil karena `textHtml` berisi HTML lengkap dengan `<img src="dataUrl">` → strategi 2 jalan sebagai fallback → gambar ter-embed di HTML → paste ke Google Docs/Gmail menampilkan gambar.

### Fix v3.14.8

**1. Helper baru `writeImageOnlyToClipboard(dataUrl)` di `lib/copy-format.js`**

Helper khusus untuk image-only clipboard write, dengan 3 strategi yang fokus:

- **Strategi A (best case):** `ClipboardItem({ 'image/png': pngBlob })` — single mime type, paling robust. Firefox 121+ dan Chrome 76+ support. Paste ke WA/Telegram/Google Docs akan menampilkan gambar.
- **Strategi B (fallback):** `ClipboardItem({ 'text/html': <img src="dataUrl">, 'text/plain': '[Gambar RecallFox]' })` — embed gambar di HTML. Paste ke Google Docs/Gmail/Slack menampilkan gambar. WA/Telegram chat box tidak render HTML → user lihat textPlain.
- **Strategi C (last resort):** `navigator.clipboard.writeText(dataUrl)` — salin dataUrl sebagai teks panjang. User paste ke editor untuk debug. Tidak ideal tapi lebih baik daripada gagal total.

Plus:
- JPEG/JPG auto-converted ke PNG via `createImageBitmap` + canvas (clipboard API hanya support image/png).
- Console logging untuk setiap strategi yang gagal (debugging).
- Empty/null dataUrl rejected early dengan error spesifik.

**2. Update tombol "Salin Gambar" di `popup/popup.js`**

Sebelumnya: `writeScreenshotToClipboard(targetDataUrl, label, '')`
Sekarang: `writeImageOnlyToClipboard(targetDataUrl)`

Toast feedback dibedakan per fallback:
- Default (strategi A berhasil): "✓ Gambar tersalin — paste ke WA/Telegram/Docs"
- `html_embedded` (strategi B): "✓ Gambar tersalin — paste ke Google Docs/Gmail untuk menampilkan"
- `data_url_text` (strategi C): "✓ Data URL tersalin (browser blokir clipboard image)"

## File yang diubah

### `lib/copy-format.js`

Tambah export `writeImageOnlyToClipboard(dataUrl)` — ~80 baris kode baru, dengan 3 strategi + error handling + logging.

### `popup/popup.js`

- Import `writeImageOnlyToClipboard` dari copy-format.js.
- Tombol "Salin Gambar" ganti call dari `writeScreenshotToClipboard(targetDataUrl, label, '')` → `writeImageOnlyToClipboard(targetDataUrl)`.
- Toast feedback conditional berdasarkan `result.fallback`.

### `manifest.json`

Version `3.14.7` → `3.14.8`.

## Test plan

- [x] `node --check popup/popup.js` — OK
- [x] `node --check lib/copy-format.js` — OK
- [x] `JSON.parse(manifest.json)` — OK
- [x] `web-ext lint`: 0 errors, 120 warnings (baseline sama v3.14.7)
- [x] 4 sanity test PASS:
  - Function signature: async function, exported dengan benar
  - Empty dataUrl → reject dengan `no_data_url` error
  - Null dataUrl → reject dengan `no_data_url` error
  - Invalid dataUrl (non-data URL) → reject dengan `blob_fetch_failed` error (graceful)
- [ ] Manual test: buka screenshot → klik "🖼️ Salin Gambar" → paste ke WhatsApp chat → gambar muncul
- [ ] Manual test: buka dokumen multi-page → klik "🖼️ Salin Gambar" → paste ke Google Docs → gambar gabungan grid bernomor muncul
- [ ] Manual test: cek console (F12) untuk logging "strategi A failed" kalau ada edge case
