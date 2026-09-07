# RecallFox v3.24.11 — Upload File: dukungan arsip ZIP/RAR/7z/TAR/GZ (Fase 3)

## Permintaan user
> "perhatikan fitur upload file di addon berikut. apakah mungkin ditambah fitur
> upload .zip? karena saya sering memakai .zip dan semua ekstensi file compress
> lainnya."

Sejak Fase 2 (v3.22.0), arsip `.zip/.rar/.7z/.tar/.gz` sengaja masuk daftar
`REJECTED_BINARY_HINT` — upload ditolak dengan pesan "arsip ZIP belum didukung
Fase 2". Versi ini membuka dukungan tersebut.

## Perubahan — `lib/file-kinds.js` (Fase 3)
- **9 ekstensi arsip baru** di `BINARY_FILE_KINDS`, family `archive`,
  preview `none` (blob disimpan utuh, TIDAK diekstrak isinya):
  | Ekstensi | Kind | MIME |
  |---|---|---|
  | `.zip` | `zip` | application/zip |
  | `.rar` | `rar` | application/vnd.rar |
  | `.7z` | `7z` | application/x-7z-compressed |
  | `.tar` | `tar` | application/x-tar |
  | `.gz` | `gz` | application/gzip (mencakup `.tar.gz` — ekstensi terakhir) |
  | `.tgz` | `tgz` | application/gzip |
  | `.bz2` | `bz2` | application/x-bzip2 (mencakup `.tar.bz2`) |
  | `.xz` | `xz` | application/x-xz (mencakup `.tar.xz`) |
  | `.zst` | `zst` | application/zstd |
- `REJECTED_BINARY_HINT`: lima entri arsip dihapus; sisa hint (audio/video/
  ebook/exe/dll.) dipertahankan, teks "Fase 2" dibersihkan.
- `kindIcon`: semua kind arsip → 📦.
- `cloudExt`: 9 kind arsip dipetakan ke ekstensi aslinya (fallback nama file
  asli di `_fileExtForUpload` tetap prioritas utama — berkas `.zip` terupload
  ke cloud sebagai `.zip`).
- `FILE_ACCEPT_ATTR` otomatis ikut memuat arsip (derivasi dari whitelist).

## Perubahan — `popup/popup.js`
- Sheet-note mode screenshot/upload kini menyebut arsip:
  "…PDF/Office/gambar/**arsip .zip/.rar/.7z/.tar/.gz** (maks 10MB)".
- `previewFileItem`: pesan penolakan pratinjau kini family-aware — arsip
  menampilkan "File arsip tidak bisa dipratinjau di browser — gunakan Unduh"
  (sebelumnya selalu "File Office …"). Arsip memang tidak bisa dipratinjau
  browser; alur unduh lokal (blob `rf_file_{id}`) & fetch cloud tidak berubah.

## Yang sengaja TIDAK berubah
- Batas ukuran: teks 2MB, binary (termasuk arsip) 10MB — keputusan user
  2026-08-29 untuk aman terhadap kuota Supabase free (1GB).
- Alur simpan: arsip diperlakukan persis Office binary — `arrayBuffer()` →
  blob `rf_file_{id}` di storage.local → upload Storage `documents` via
  `_uploadFileDocument` → PATCH `gdrive_file_url`. Byte-per-byte identik,
  tanpa ekstraksi/repak isi arsip.
- Jalur Chrome `popup/upload-window.js` (legacy v3.20.40, teks-only, tidak
  lagi dipakai popup) tidak disentuh.

## Validasi
- **Uji Node 54/54 PASS** (`test/file-kinds.test.mjs`) — termasuk 13 asersi
  baru Fase 3: deteksi 9 ekstensi (kapital & `.tar.gz`/`.tar.bz2`/`.tar.xz`
  via ekstensi terakhir), family `archive`, preview `none`, ikon 📦,
  `cloudExt` zip/7z, `rejectHintFor('.zip')` kini `null`, dan
  `FILE_ACCEPT_ATTR` memuat `.zip/.rar/.7z/.tar/.gz`.
- Regresi Fase 1/2 lolos semua (teks lama, programming, Office, gambar,
  penolakan `.mp3`/`.exe`, `.pdf.exe` ekstensi terakhir, tanpa ekstensi,
  nama kosong, `null`).
- `node --check popup.js` lolos (kedua repo); file `lib/file-kinds.js` dan
  `popup/popup.js` md5-identik antara repo Firefox & Chrome (paritas penuh).
