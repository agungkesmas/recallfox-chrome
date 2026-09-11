# CHANGELOG v3.24.18 — Firefox

Tanggal: 2026-09-11

## Upload File: tujuan ketiga 🔗 Manual (3 hari vault) — REDO aman

**Permintaan user:** sheet Upload File diberi opsi ketiga selain ☁️ Database &
⏳ Sementara: upload manual ke daftar situs temporari (klik → buka tab baru,
upload di sana), lalu tempel URL-nya → item masuk vault secara manual dan
**hilang otomatis 3 hari** setelah masuk vault — terlepas dari kapan situsnya
menghapus filenya.

**Konteks penting:** percobaan pertama v3.24.18 (3cb9a57) di-REVERT (25032cf)
karena rusak. Akar masalah dibedah tuntas sebelum redo ini:

1. **SyntaxError ES module tersembunyi** — baris guard `if (_dest === 'temp') {`
   terhapus tidak sengaja → kurung penutup blok temp malah menutup `try {`
   handler → `catch (e)` yatim → `SyntaxError: Missing catch or finally after
   try`. popup.js gagal dimuat total.
2. **Validasi palsu** — `node --check` mode script **lolos** untuk file yang
   sebenarnya rusak (file ini ES module — ada import/export). Yang menangkap:
   `node --input-type=module --check` + parse acorn `sourceType:'module'`.
3. **Bug logika** — cabang manual diletakkan SETELAH validasi file → selalu
   terblokir toast "Pilih file dulu".
4. **Listener duplikat** — listener `input` URL manual dipasang DI DALAM
   `_paintDest()` → terpasang ulang tiap pindah tujuan.

**Perubahan (mengikuti pola PWA v1.21.0 yang sudah E2E browser 7/7):**

- `lib/temp-upload.js`: `TEMP_HOST_MANUAL='manual'`, `MANUAL_TEMP_DURATION='72h'`,
  `MANUAL_SITES` — 4 situs hasil verifikasi curl (litterbox, catbox, gofile,
  tmpfiles). 0x0.st / file.io / temp.sh tetap DITOLAK hasil audit.
- `popup/popup.js` `saveFileUploadSheet`:
  - Tombol tujuan kini **3**: `☁️ Database | ⏳ Sementara | 🔗 Manual`.
  - Panel Manual: daftar situs (klik → tab baru, `rel="noopener"`, tooltip
    catatan kapasitas), input `URL file` (wajib `https://`), input `Nama file`
    opsional (otomatis dari ekor URL, ekstensi ditebak via `detectFileKind`).
  - Item manual: `source.tempHost='manual'`, `tempUrl`, `tempExpiresAt=now+72h`,
    `tempDuration='72h'`, `uploadedFrom='addon-upload-manual'`, `body=''`,
    `size=0` — **struktur row identik dengan temp litterbox** → badge countdown
    ⏳, sinkron antar device, dan `cleanupExpiredTempItems` (init + interval 60
    detik) menghapus otomatis 3 hari TANPA perubahan sisi baca/sync.
  - **Cabang manual dicek PALING AWAL** di handler Simpan — tidak butuh file
    terpilih (perbaikan bug #3).
  - **Pola defensif**: semua referensi elemen diambil sekali + guard eksplisit
    (sheet gagal dengan toast jelas, bukan tombol mati diam-diam); daftar situs
    dirender sekali; listener dipasang sekali; state tombol Simpan terpusat di
    `_updateSaveState()` (Manual → butuh URL valid; Database/Sementara → butuh
    file terpilih).
  - **Guard `if (_dest === 'temp') {` dan seluruh jalur Database/Sementara
    TIDAK diubah sama sekali** (perbaikan akar masalah #1).
- Batas ukuran TIDAK diubah (Database 10MB, Sementara 1GB) — keputusan risiko
  minimal, konsisten dengan PWA v1.21.0.
- `manifest.json`: 3.24.18. TANPA permission baru.

**Validasi (protokol baru — anti false-pass):**

- `node --input-type=module --check < popup/popup.js` → OK (pemeriksaan yang
  dulu terlewat), plus parse acorn `sourceType:'module'` → OK.
- Guard temp & jalur db diverifikasi tetap ada (grep + review diff).
- `test/temp-upload.test.mjs` — +12 asersi MANUAL (konstanta, daftar situs,
  TTL 72 jam, isTempItem/isTempExpired item manual) — semua PASS.
- `test/file-kinds.test.mjs` 56/56, `test/pdfsort.test.mjs` 32/32,
  `test/storage-binary.test.mjs` — PASS (tidak ada regresi).
