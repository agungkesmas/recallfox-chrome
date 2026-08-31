# v3.24.4 — Capture Fullpage Mulus + Anotasi Kotak Default + RecallNote Auto-Save Supabase

## 1. CAPTURE FULLPAGE "patah-patah, mengulang-ulang halaman pertama" — FIXED (rewrite `captureEntire`)

Laporan user: hasil capture halaman penuh patah-patah dan mengulang potongan halaman pertama. Tiga akar bug dibuktikan & dibunuh di `content/capture.js`:

- **AKAR 1 — duplikasi 40px di tiap sambungan.** Scroll sengaja tumpang-tindih 40px per langkah (proteksi sticky-header ala FireShot), tapi stitch lama **menumpuk frame PENUH** tanpa membuang 40px pengulangan di puncak frame berikutnya → hasil "patah-patah" + potongan halaman berulang di setiap sambungan. Kini tiap frame hanya menggambar **baris konten yang belum tercakup** frame sebelumnya (bookkeeping `covered`); scroll kurung (smooth belum selesai) otomatis memperbesar skip — tetap tanpa gap & tanpa duplikat.
- **AKAR 2 — smooth scroll.** Penugasan `scroller.scrollTop = N` TETAP dianimasikan bila halaman memasang CSS `scroll-behavior: smooth`, dan penonaktifan lama hanya menyentuh `<html>` (bukan nested scroller) → frame tercapture di posisi lama ("mengulang halaman pertama"). Kini `scroll-behavior: 'auto'` dipasang di `<html>` **dan** di scroller, plus `scrollToY()` yang menunggu scroll **benar-benar tuntas** (polling stabil) sebelum frame diambil; posisi frame dihitung dari **posisi aktual**, bukan yang diminta.
- **AKAR 3 — `overflow:hidden` pada `<body>` + metrik nested scroller keliru.** Body overflow bisa mematikan scroll dokumen (propagasi overflow viewport), dan bottom-check memakai `window.innerHeight` + tinggi dokumen walau yang digulung elemen dalam → loop menumpuk frame identik di dasar nested scroller. Kini scrollbar disembunyikan via `<style>` (tanpa menyentuh overflow), `visH`/`pageH` dihitung sesuai jenis scroller, dan frame yang tidak membawa konten baru dibuang + loop berhenti mulus.

Bonus: pace per frame ~120–350ms (dulu ~1.250ms karena check stabilitas 600+300ms per frame) — proses capture terasa mulus. Halaman lazy-render kini justru ter-capture lebih lengkap (`pageH` diukur ulang tiap frame; abort "dynamic page" hanya untuk host chat yang dikenal).

## 2. ANOTASI — dua cara membuka + default kotak

- **Klik gambar di preview modal = buka editor anotasi** (cara kedua selain tombol "✏️ Anotasi"). Affordance: cursor pointer, ring ungu saat hover, hint pill "✏️ Klik gambar untuk anotasi" di bawah preview.
- **Default tool anotasi kini KOTAK (rect)**, bukan panah (permintaan user). Semua tool lain (garis, lingkaran, teks, highlighter, pena, blur) tetap tersedia; pilihan tool tetap diingat selama sesi editor.

## 3. RECALLNOTE (pill mengambang) — AUTO-SAVE ke Catatan/Supabase

Laporan user: note baru dari pill mengambang tidak pernah masuk Supabase (masih local), dan tombol header sudah terlalu banyak untuk ditambah tombol simpan.

- **Lazy-link tanpa tombol baru**: begitu lembar RecallNote berisi teks, vault note dibuat **otomatis sekali** dan lembar tertaut (`vaultNoteId`); autosave berikutnya menyink real-time via `UPDATE_VAULT_NOTE` → `updateNote()` → `directUpsertNote` (Supabase **immediate**). Note kosong tidak membuat sampah di daftar Catatan.
- **FIX bonus bug lama**: handler `UPDATE_VAULT_NOTE` sejak v3.21.15 mencari note di store **SALAH** (`vault.notes`; store catatan sebenarnya = `recallfox_notes` via `getNotes/updateNote`) → autosave lembar tertaut selalu gagal senyap (`not_found`). Kini via `updateNote()` (store benar) yang sekaligus upsert Supabase langsung.
- **Judul note cerdas**: baris pertama catatan (maks 48 karakter) menggantikan "📝 RecallNote — tanggal" (prefiks `> `/`>x ` dibersihkan) supaya daftar Catatan mudah dipindai.
- Tombol simpan manual (bila tersedia) kini ikut **menautkan** lembar ke note yang sama — tidak lagi berisiko membuat note duplikat saat autosave lanjutan.

## Validasi

- Suite browser-nyata dwi-browser BARU `audit3244/test_real_3244.js`: **98/98 KEDUA browser**:
  - capture fullpage **pixel-exact per baris** di 5 skenario (doc-scroller 5000px, `scroll-behavior:smooth`, nested scroller, halaman pendek, sticky header 32px) + varian JPEG (verifikasi blok 2px mean-diff) — tinggi hasil persis, nol duplikasi, nol gap;
  - anotasi: default tool = kotak; gambar kotak benar (border merah (98,73)–(281,196), tengah tetap putih) + switch tool jalan;
  - auto-save pill: note kosong tidak membuat note; ketik → note + link otomatis; ketik lagi → note **yang sama** ter-update via `UPDATE_VAULT_NOTE`.
- Regresi penuh: `test_real_3243` **68/68** ×2 browser; task_sim **109/109**; keyboard 34/34; dock 50/50; float_sync 11/11; multi_float 28/28; color_pomo 45/45; chrome_sw 14/14; vault_float 36/36 ×2 repo; `node --check` semua file berubah = 0 error; `capture.js` & `annotate.js` **identik byte-per-byte** antar repo.
