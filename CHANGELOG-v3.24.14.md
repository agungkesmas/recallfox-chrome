# CHANGELOG v3.24.14 — Chrome

Tanggal: 2026-09-09

## 1. FIX: Perilaku hapus RecallNote — Chrome kini 1:1 dengan Firefox (laporan user)

**Laporan:** "perilaku hapus di note versi chrome belum seperti versi firefox. ketika sudah
ada bullet (todo) itu tidak bisa bebas mendelet di kolom atau bagian kalimat manapun,
tapi harus dari ujung paling terakhir."

**Akar masalah:** sejak v3.24.3, engine edit RecallNote membagi jalur penghapusan:
Firefox memakai **bedah engine** (shim `rfFFDeleteChar`/`rfFFDeleteRange` — deterministik,
caret selalu dipulihkan), sedangkan Chrome diserahkan **100% ke native browser**. Akibatnya
perilaku hapus di Chrome bergantung pada quirk native `contenteditable` masing-masing build
Chrome — dan pada kondisi tertentu hanya penghapusan dari ujung teks yang terasa jalan.

**Perbaikan (paritas penuh):**
- Handler `beforeinput` yang semula hanya terpasang di Firefox kini dipasang di **semua
  browser** — setiap perintah hapus native dicegah (`preventDefault`) lalu dikerjakan lewat
  bedah engine model baris datar yang sama dengan Firefox:
  - `deleteContentBackward` → `rfEngineDeleteBackward` (hapus 1 char di belakang caret di
    posisi mana pun; caret mati dipulihkan dulu),
  - `deleteContentForward` → `rfEngineDeleteForward`,
  - `deleteWordBackward`/`deleteWordForward` (Ctrl+Backspace / Ctrl+Delete) → hapus kata
    engine,
  - `deleteSoftLine/HardLine Backward/Forward` (Cmd+Delete di macOS dst) → hapus s.d. tepi
    baris,
  - seleksi rentang (klik-seret, Shift+panah, Ctrl+A) → `rfFFDeleteRange` (gabung head+tail,
    kelas baris pertama dipertahankan),
  - `deleteByCut`/`deleteByDrag` (Ctrl+X, potong lewat menu konteks) → clipboard manual +
    hapus rentang (clipboard tidak hilang karena `preventDefault`),
  - ketik MENGGANTIKAN seleksi → `rfFFReplaceSelection`.
- Helper baru bersama FF↔Chrome: `rfBackspaceEdge` (Backspace tepi baris: done → un-done
  dulu, task → lepas mode ala Word, plain → merge ke atas), `rfEngineDeleteBackward`,
  `rfEngineDeleteForward`.
- Jalur keydown Firefox TIDAK diubah (shim keydown tetap jalan lebih dulu; `beforeinput`
  menjadi jaring pengaman) — perilaku Firefox dipertahankan 100%.

**Validasi (Chromium, ekstensi asli load-unpacked):**
- Matriks 10 skenario: klik tengah kata + Backspace (task/plain/done), klik area kosong,
  Backspace tepi (keluar mode), dblclick-hapus-kata, Shift+panah + Backspace, Delete
  mid-line, ketik-sisip lalu Backspace — semua hapus terjadi **tepat di posisi caret**.
- Skenario engine baru 8 kasus: Ctrl+A+Backspace (1 baris tersisa rapi), Ctrl+Backspace
  hapus kata ("cuci baju sore nanti" → "cuci sore nanti"), seleksi lintas baris + Backspace
  (gabungan "beli sus" + " baju sore nanti" persis), baris DONE asli (Backspace mid = tetap
  done; Backspace tepi = un-done), Delete di ujung baris (gabung baris berikut), ketik
  menggantikan seleksi.
- Halaman blank + situs nyata (Wikipedia ID) — hasil identik; 0 pageerror dari engine.
- `node --check` OK; regresi node: file-kinds 56/56, temp-upload 39/39, pdfsort 32/32.

## 2. Batas ukuran upload tujuan ⏳ Sementara: 10MB → 100MB (pertanyaan user)

**Pertanyaan:** "batas maksimal megabite untuk upload file sementara apakah bisa lebih
besar dari 10mb misalkan 50 mb gitu atau lebih besar lagi?"

**Jawaban + implementasi:** BISA. Host sementara yang dipakai (litterbox.catbox.moe)
menerima s.d. **1GB** per file di sisi server; batas 10MB selama ini adalah batas aplikasi
kita sendiri. Karena itu:
- `lib/file-kinds.js`: konstanta baru `MAX_TEMP_UPLOAD_BYTES = 100MB` (Database tetap 10MB
  — aman untuk kuota Supabase free).
- Validasi dua lapis di sheet Upload File: saat **pilih file** batas binary dipakai yang
  terluas (100MB) agar file besar untuk tujuan Sementara tidak ditolak prematur; saat
  **simpan** divalidasi ulang sesuai tujuan yang dipilih (Database 10MB / Sementara 100MB)
  dengan pesan yang jelas.
- Copy UI diperbarui: hintbox sheet, dropzone ("maks 10MB Database · 100MB Sementara"),
  catatan tujuan ⏳ ("Maks 100MB").
- Verifikasi LIVE litterbox (curl, 2026-09-09): upload sukses 20MB, 40MB, 48MB, 52MB, 55MB
  (1x 500 error pada 55MB ternyata transien — retry sukses); integritas isi terverifikasi via
  range-download 1MB pertama md5-identik. Server menerima ≥ 55MB tanpa masalah.
- Catatan: upload berjalan dari konteks popup addon — jaga popup tetap terbuka sampai
  upload selesai (semakin besar file, semakin lama). PWA tidak berubah (upload PWA
  teks-only 2MB).

## Berkas berubah
- `content/notes-cs.js` — paritas hapus engine semua browser
- `lib/file-kinds.js` — `MAX_TEMP_UPLOAD_BYTES`
- `popup/popup.js` — validasi dua lapis + copy UI
- `test/file-kinds.test.mjs` — 2 asersi baru (56 total)
- `manifest.json` — 3.24.14
