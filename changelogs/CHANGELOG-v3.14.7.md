# RecallFox v3.14.7 — Rewrite Tombol Copy Viewer (Salin Gambar / +Keterangan / Teks Metadata)

**Tanggal:** 25 Jul 2026
**Tag sebelumnya:** v3.14.6
**Tipe:** UI/UX rewrite (Sesi 1 follow-up #2)

## Ringkasan

User feedback setelah v3.14.6:

> "fitur salin masih tidak berfungsi, kalau tidak ngikutin logika ini saja biar selaras
> 
> - Salin Gambar — Salin gambar saja ke clipboard
> - Salin + Keterangan — Gambar + URL, judul, waktu, mode
> - Salin Teks Metadata — Teks saja (judul, waktu, URL) - paste ke WA/Gemini/AI chat
> 
> sedangkan yang untuk 2 halaman ngikut logika seperti kopi gambar saja menggunakan batch itu kan jadinya grid bernomor."

Investigasi menemukan bahwa tombol-tombol v3.14.6 (`📋 Hal Ini / 📚 Semua / 📋 + Keterangan`) membingungkan karena:
1. "Hal Ini" hanya copy 1 page aktif → tidak intuitif untuk multi-page dokumen
2. "Semua" hanya muncul untuk multi-page → layout berubah antara single & multi
3. "Keterangan" redundant dengan "Hal Ini"
4. Label tidak menjelaskan apa yang disalin

**Fix v3.14.7:** Rewrite total jadi 3 tombol yang selaras dengan pola vault batch copy, dengan logika konsisten untuk single-page dan multi-page:

| Tombol | Single-page | Multi-page |
|--------|-------------|------------|
| 🖼️ **Salin Gambar** | Copy gambar page aktif saja | Composite grid bernomor via `buildCompositeImage` (pattern vault batch) |
| 📋 **Salin + Keterangan** | Gambar + caption (URL, judul, waktu, mode) | Composite grid bernomor + caption gabungan semua halaman |
| 📝 **Salin Teks Metadata** | Teks caption saja (no image) | Gabungan caption semua halaman (no image) — paste-ready ke WA/Gemini/AI chat |

## Spec compliance

### Tombol 1: 🖼️ Salin Gambar
- **Title:** "Salin gambar saja ke clipboard" (single) / "Salin semua halaman jadi 1 gambar (grid bernomor)" (multi)
- **Single-page:** `writeScreenshotToClipboard(dataUrl, label, '')` — image only, textPlain minimal sebagai fallback.
- **Multi-page:** `buildCompositeImage(screenshots)` → blob → dataURL → `writeScreenshotToClipboard`. Pattern sama dengan `vaultBatchCopyAction` di line 1033. Grid otomatis: 2 gambar=1 kolom vertical, 3-4=2x2, 5-6=3x2, 7-9=3x3. Setiap gambar dapat badge nomor di pojok kiri atas.

### Tombol 2: 📋 Salin + Keterangan
- **Title:** "Gambar + URL, judul, waktu, mode" (single) / "Gambar gabungan + keterangan semua halaman (URL, judul, waktu)" (multi)
- **Single-page:** Caption via `buildScreenshotCaption(item, dataUrl)` atau `buildDocumentCaption(item, dataUrl, {currentPage})`. Lengkap dengan URL sumber, judul, waktu, mode (Viewport/Area/Seluruh halaman), dimensi, anotasi.
- **Multi-page:** Composite grid (sama dengan Tombol 1) + caption gabungan. Caption gabungan iterasi setiap halaman dengan `index` + `currentPage`:
  ```
  # 📄 Dokumen — Laporan Bulanan
  Tanggal: 25 Jul 2026 · Total: 3 halaman

  📄 1. Laporan Bulanan (hal 1/3)
  Waktu: ...
  Total halaman: 3
  Ditangkap oleh RecallFox

  [📄 Halaman 1]

  ---

  📄 2. Laporan Bulanan (hal 2/3)
  ...

  — Ditangkap oleh RecallFox —
  ```

### Tombol 3: 📝 Salin Teks Metadata
- **Title:** "Teks saja (judul, waktu, URL) - paste ke WA/Gemini/AI chat" (single) / "Teks saja (judul, waktu, semua halaman) - paste ke WA/Gemini/AI chat" (multi)
- **Single-page:** `buildScreenshotCaption(item, null)` atau `buildDocumentCaption(item, null, {currentPage})` — textPlain saja (dataUrl=null berarti tidak ada `<img>` di HTML, tapi textPlain tetap lengkap).
- **Multi-page:** Gabungan textPlain semua halaman dengan separator `---`. Pattern sama dengan `vaultBatchCopyMetaAction` (line 851).
- **Clipboard write:** Langsung `navigator.clipboard.writeText(textPlain)` (tidak pakai `writeScreenshotToClipboard` karena tidak ada image). Fallback: delegate ke background via `COPY_TO_CLIPBOARD` message.

## Perubahan

### File: `popup/popup.js` — function `openImageModalViewer()`

#### Hapus (v3.13.7–v3.14.6)
- Tombol `📋 Hal Ini` — hanya copy 1 page aktif, membingungkan.
- Tombol `📚 Semua` — hanya muncul untuk multi-page, layout berubah.
- Tombol `📋 + Keterangan` — redundant dengan "Hal Ini".
- Logika composite vertical manual (canvas + drawImage loop) — diganti dengan `buildCompositeImage` yang lebih robust (auto-layout grid + numbering).

#### Tambah (v3.14.7)
- Helper `blobToDataUrl(blob)` — FileReader wrapper untuk konversi composite blob → dataURL.
- Helper `getAllPageDataUrls()` — extract semua dataUrl dari validPages (filter null).
- Helper `buildScreenshotsArray()` — format array untuk `buildCompositeImage` / `buildBatchCaption`.
- 3 tombol baru dengan logika branching `isMulti && dataUrls.length > 1`:
  - Single-page: operasi pada page aktif (`validPages[cur]`).
  - Multi-page: operasi pada semua pages via composite + caption gabungan.

### File: `manifest.json`

Version `3.14.6` → `3.14.7`.

## Test plan

- [x] `node --check popup/popup.js` — OK
- [x] `JSON.parse(manifest.json)` — OK
- [x] `web-ext lint`: 0 errors, 120 warnings (baseline sama v3.14.6)
- [x] Sanity test 3 skenario PASS:
  - Single screenshot: 3 tombol operasi pada 1 page, caption lengkap (URL/judul/waktu/mode/dimensi)
  - Multi-page document (3 halaman): composite grid bernomor + caption gabungan dengan index `📄 1.`, `📄 2.`, `📄 3.` + label `[📄 Halaman N]`
  - Text-only multi-page: tidak ada `data:image` di output, siap paste ke WA/Gemini/AI chat
- [ ] Manual test: buka screenshot → klik "🖼️ Salin Gambar" → paste ke WhatsApp → gambar muncul
- [ ] Manual test: buka dokumen multi-page → klik "🖼️ Salin Gambar" → paste → 1 gambar gabungan dengan nomor di setiap halaman
- [ ] Manual test: buka dokumen multi-page → klik "📋 Salin + Keterangan" → paste ke Google Docs → gambar gabungan + keterangan semua halaman
- [ ] Manual test: buka dokumen multi-page → klik "📝 Salin Teks Metadata" → paste ke Gemini/ChatGPT → teks keterangan saja, siap untuk prompt AI
