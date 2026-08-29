# CHANGELOG v3.22.6-chrome

Tanggal: 2026-08-30

## Ringkasan
Perbaikan mendalam dua bug yang dilaporkan user pada v3.22.5-chrome — **modal edit
screenshot error** dan **login Supabase error** — plus penyempurnaan UI identik
dengan v3.22.6-firefox (pembeda checkbox + tooltip).

**Akar masalah bukan file yang hilang** (perbandingan tree kedua repo: semua file
runtime utama ada; selisih ukuran zip wajar karena Firefox membawa bundel tambahan
`lib/classic/*` dan Chrome menghapus `ff.zip` 816KB di audit v3.22.5). Akarnya:
**keterbatasan runtime Chrome MV3 ServiceWorker** yang tidak dialami Firefox
(background Firefox = event page dengan DOM penuh).

## 1. Login Supabase gagal — "import() is disallowed on ServiceWorkerGlobalScope"
**Penyebab:** `background.js` memakai **68 dynamic `import()`** untuk memuat 13 lib
(supabase-client, supabase-sync, sync-profile, storage, salahtime, autobackup,
volume, habits, clearcache, ai-detect, pdf, islamicCalendar, sidebar-compat).
HTML spec (w3c/ServiceWorker#1356) **melarang `import()` dinamis di ServiceWorker** —
semua handler yang memuat lib itu cara dinamis langsung error di Chrome.

**Solusi:** seluruh dynamic import dikonversi ke **static ESM import** (didukung penuh
module service worker):
- 12 statement import baru di `background.js` + penggabungan ke import existing.
- Collision nama ditangani dengan alias binding: `fullSync` (sync-profile vs
  supabase-sync) dan `getActiveProfile` (contentguard vs sync-profile) — call site
  asli tidak disentuh via baris alias lokal di tiap titik pemakaian.
- 2 pola `import(...).then(...)` di alarm handler ikut dikonversi.
- `lib/storage.js`: lazy-import GDriveSync & supabase-sync → static import
  (siklus storage ↔ gdrive-sync ↔ supabase-sync aman — tidak ada pemanggilan
  top-level antar modul; diverifikasi simulasi).
- `lib/supabase-sync.js`: 3 dynamic import storage → static.
- `lib/ai-detect.js`: dynamic import ai-tools → static.

**Efek samping positif:** fitur lain yang selama ini senyap gagal di Chrome kini
pulih — realtime sync, sync-profile (semua handler), jam sholat, kalender hijriah,
habits, clear cache, volume per-site, auto-backup init, dsb.

## 2. Modal edit screenshot gagal — "URL.createObjectURL is not a function"
**Penyebab:** 8 titik kode membuat `Blob` lalu `URL.createObjectURL(blob)` untuk
`downloads.download` — padahal `URL.createObjectURL` **tidak tersedia di
ServiceWorker** (blob: URL butuh konteks dokumen).

**Solusi:** helper baru `lib/dataurl.js` (`blobToDataUrl` — chunked base64, tanpa
FileReader) — semua titik download kini memakai **data: URL** yang didukung
`downloads.download` di Chrome & Firefox:
- `saveCaptureAs` (Simpan PDF/JPG/PNG di modal edit) ✓ — bug utama user
- EXPORT_BACKUP, 4 fallback clipboard screenshot, download screenshot vault
- `lib/autobackup.js` writeToDisk (auto-backup harian)
- Baris `setTimeout(revokeObjectURL)` ikut dihapus (data: URL tidak perlu revoke).

## 3. Perbaikan tambahan hasil audit simulasi ketat
- **`storage.sync.onChanged`** dipanggil tanpa guard — API ini TIDAK ADA di Chrome
  (hanya Firefox); bila tidak tersedia kini fallback ke `storage.onChanged` dengan
  filter area `sync` (semantik identik) — mencegah background mati total di Chrome
  lama.
- **`_getDeleteRegistry` diekspor** dari supabase-sync — sebelumnya private sehingga
  guard `mod._getDeleteRegistry` di storage.js selalu false (filter delete-registry
  anti-resurrection tidak pernah aktif di browser mana pun).

## 4. UI parity dengan v3.22.6-firefox
- Pembeda visual checkbox: batch select = **kotak indigo**, tugas selesai =
  **lingkaran hijau** (termasuk checkbox subtask).
- Tooltip hover: P1–P4 (editor + chip filter), checkbox batch, chip status selesai,
  batch bar catatan, hapus subtask/prompt, tutup modal.

## Validasi
- `node --check` 57 file JS: 0 error.
- **Simulator Chrome MV3 ServiceWorker ketat baru** (`chrome_sw_sim.js`): global
  scope persis SW (tanpa window/document, `import()` melempar error seperti Chrome
  asli, `URL.createObjectURL` dihapus) — **14/14 PASS**:
  modul termuat, onInstalled/onStartup lengkap, **SUPABASE_LOGIN ok**,
  **SUPABASE_GMAIL ok**, **SAVE_CAPTURE_AS png/jpg/pdf → download data: URL**,
  EXPORT_BACKUP, fallback clipboard, sidePanel, alarm realtime/refresh —
  nol error `import()`/`createObjectURL` sepanjang sesi.
