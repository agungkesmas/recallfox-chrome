# CHANGELOG v3.24.19 — Chrome

Tanggal: 2026-09-11

## Daftar situs upload manual: gofile.io → temp.sh + BISA DIKELOLA USER

**Permintaan user:**

1. "gofile.io ini sudah tidak berlaku tidak bisa dipake, ganti dengan temp.sh"
2. "harusnya daftar situs upload manualnya juga bisa diupdate atau delet
   mandiri" — user bisa tambah/ubah/hapus isi daftar sendiri.

## Perubahan

### 1. Default daftar situs — gofile.io keluar, temp.sh masuk

- `lib/temp-upload.js` — `MANUAL_SITES` kini: litterbox.catbox.moe,
  catbox.moe, **temp.sh**, tmpfiles.org.
- Verifikasi curl 2026-09-11: `POST https://temp.sh/upload` sukses
  (`https://temp.sh/<id>/<file>`), file disimpan server **3 hari** —
  sinkron dengan TTL vault manual 72 jam.
- Catatan jujur di tooltip situs: URL temp.sh membuka **halaman unduh
  (tombol "Click here to download")**, bukan file mentah. Untuk alur
  MANUAL ini bukan masalah — item vault manual tidak pernah fetch isi
  file (body kosong, size 0); user unduh lewat tombolnya.
- Upload otomatis (`uploadToTempHost`) **tetap litterbox** — tidak
  disentuh sama sekali.

### 2. Daftar situs bisa dikelola user (tambah / ubah / hapus / pulihkan)

- Panel 🔗 Manual kini punya tombol **✏️ Kelola**:
  - **＋ Tambah** — isi nama situs + URL (wajib `https://`), daftar
    tervalidasi: label 1–40 char, URL 1–300 char, dedupe URL (beda
    garis miring/case dianggap sama), maks **12 situs**.
  - **✏️** pada baris — isi form dengan data situs, tombol berubah
    **✓ Update** (＋ **Batal edit** untuk membatalkan).
  - **🗑** pada baris — hapus langsung dari daftar.
  - **↺ Pulihkan default** — kembalikan 4 situs bawaan kapan pun.
  - **✓ Selesai** — kembali ke mode chips (klik situs → tab baru).
- **Penyimpanan:** `browser.storage.local` key `recallfox_manual_sites`
  — per browser, persisten antar buka-tutup popup.
- **Defensif (pelajaran revert v3.24.18 lama, semuanya dipatuhi):**
  - Guard `if (_dest === 'temp') {` + cabang simpan manual + batas
    ukuran — TIDAK disentuh.
  - Semua elemen baru dicek eksplisit (ada yang hilang → toast
    "sheet rusak" + close, bukan tombol mati diam-diam).
  - Semua listener dipasang SEKALI; render chips tetap DI LUAR
    `_paintDest` (tidak ada duplikasi listener).
  - Semua data user (label/URL/note) di-escape sebelum masuk
    innerHTML (aman dari injeksi HTML).
  - Storage gagal → fallback daftar default + toast jelas, tidak crash.
  - Fungsi murni `sanitizeManualSites()` + `manualSiteHost()` +
    `MANUAL_SITES_MAX` di `lib/temp-upload.js` — paritas 1:1 dengan
    repo Firefox dan PWA.

## Validasi

- Syntax: `node --input-type=module --check` + acorn `sourceType:module`
  → popup.js & lib/temp-upload.js OK.
- Unit: temp-upload **74 PASS** (termasuk 20 asersi baru
  sanitizeManualSites/manualSiteHost + upload live litterbox roundtrip),
  file-kinds **56/56**, storage-binary **10/10**.
- Paritas md5 popup.js + lib/temp-upload.js + test: **identik** dengan
  repo Chrome.
- E2E Chromium asli (chromium-1200 via Xvfb, load-unpacked, jaringan
  cloud diblokir): **66 PASS, 0 FAIL, 0 pageerror** — termasuk 7 skenario
  baru: mode Kelola, validasi form (label kosong / http:// ditolak /
  duplikat URL ditolak), tambah kustom, edit, hapus, pulihkan default,
  dan persistensi daftar antar buka-tutup sheet.
