# RecallFox v3.12.0 — Fase 7: Addon support type='document' (CamScanner-like)

**Tanggal**: 24 Juli 2026
**Sesi**: Fase 7 (addon support untuk PWA v1.4.0+ document scan)
**Pencatat**: Agung Wahyudi
**Total perubahan**: 9 files

---

## Ringkasan

Addon RecallFox sekarang support `type='document'` yang dibuat oleh PWA v1.4.0+ (fitur CamScanner-like). Dokumen multi-halaman yang di-scan di HP sekarang muncul di chip **Media** addon dengan badge `📄 N hal`, bisa dibuka, di-copy, di-download, dan masuk batch mode bersama screenshot.

**Tanpa perubahan schema DB** — semua field sudah ada di `vault_items`, hanya tambah type baru + handler di popup/background.

---

## Yang baru

### 1. Tampilan document di list Media
- Badge hijau `📄 N hal` di pojok kiri thumbnail
- Chip "Media" sekarang merge screenshot + document (sebelumnya screenshot saja)
- Metadata: jumlah halaman, filter (magic/bw/gray), ukuran, tanggal

### 2. Multi-page document viewer (v3.12.0 — bermasalah, fix di v3.12.1)
- Klik dokumen → buka window baru dengan navigasi prev/next
- Arrow keys ←/→ untuk ganti halaman
- Pagination dots
- ⚠️ Bug di v3.12.0: image blank/hitam, hanya navigasi yang tampil → diperbaiki di v3.12.1

### 3. Item sheet (⋯ menu) — 5 aksi juga berlaku untuk dokumen
- Download halaman pertama
- Copy Gambar (halaman pertama)
- Copy + Keterangan (halaman pertama + judul, waktu, jumlah halaman)
- Copy Teks Metadata (text-only, paste ke WA/Gemini/AI)
- Catatan Anotasi (disimpan ke `source.annotationNote` supaya PWA juga bisa baca)

### 4. Batch mode mixed
- Dokumen bisa di-multiselect bersama screenshot
- "Copy + Keterangan" composite — caption dokumen pakai `buildDocumentCaption`
- "Copy Gambar Saja" — composite grid dengan numbering

### 5. Sync engine
- `getOrDownloadScreenshotBlob()` sekarang izinkan type='document' (sebelumnya reject `not_screenshot`)
- Pre-cache blob halaman 1 saat `pullFromSupabase()` (background, non-blocking)

---

## File yang dimodifikasi

| File | Perubahan |
|------|-----------|
| `manifest.json` | Bump 3.11.40 → 3.12.0 |
| `lib/supabase-sync.js` | Relax type guard di `getOrDownloadScreenshotBlob` supaya dokumen bisa lazy-download page 1 |
| `lib/copy-format.js` | Tambah `buildDocumentCaption(item)` — caption khusus dokumen multi-halaman |
| `popup/popup.js` | TYPE map, chip merge, renderList CTA, primaryAction routing, itemSheet 5 aksi, batch bar mixed, searchableText, `openAnnotationNoteSheet` untuk dokumen, `openDocumentViewer` baru, `vaultBatchCopyAction` mixed-case |

---

## Yang TIDAK disentuh

Sesuai instruksi user, fitur existing tidak diganggu:
- ❌ Polling alarm (`checkVaultChanges`) — tidak diubah
- ❌ Sync row builders (`_buildVaultItemRow`, `_parseVaultItemRow`) — tidak diubah
- ❌ Screenshot handlers (copy, paste, download) — tidak diubah
- ❌ Content scripts, overlay, capture — tidak diubah
- ❌ Settings, prayer, adzan, quran — tidak diubah
- ❌ Schema DB — tidak ada migration baru

---

## Validasi

- `node --check` OK di semua file JS yang dimodifikasi
- `web-ext lint`: 0 errors / 111 warnings (baseline 110, +1 dari pola `innerHTML` yang sama dengan kode existing)

---

## Known issue (diperbaiki di v3.12.1)

Multi-page document viewer (window.open + document.write + inline script dengan base64 JSON besar) → **image tidak tampil** (kemungkinan `pages[0]` null saat `render(0)` dipanggil, atau CSP / inline script issue di Firefox MV3). Fix menyusul di v3.12.1.
