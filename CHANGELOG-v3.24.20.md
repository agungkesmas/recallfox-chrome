# v3.24.20 — GABUNG PDF (tab ke-3 Olah File Tagihan)

Tanggal: 11 September 2026

## Fitur baru: 🔗 Gabung PDF (100% offline)

Tab ketiga di halaman **Olah File Tagihan** (sebelumnya 2 tab: Urutkan PDF +
Rekonsiliasi). Menyatukan beberapa berkas PDF tapi **hanya halaman yang
dicentang** dari tiap berkas, lengkap dengan **halaman pemisah (section) antar
berkas**.

### Alur pakai

1. **📄＋ Pilih berkas PDF (bisa banyak)** — multi-pilih sekaligus.
2. Tiap berkas dianalisa lokal (pdf.js): jumlah halaman + **cuplikan teks per
   halaman** (membantu mengenali halaman "RINCIAN KWITANSI" dll.) +
   **thumbnail tiap halaman** (render canvas → JPEG, antrian latar).
3. **Centang hanya halaman yang dibutuhkan** per berkas (default kosong —
   halaman tak dicentang tidak ikut). Tombol bantu: **Semua / Nihil / Balik**.
4. Atur **urutan berkas** (↑ ↓) atau buang berkas (✕).
5. Opsi **halaman pemisah antar berkas** (default ON): berisi "BAGIAN n" +
   nama berkas + ringkasan jumlah halaman diambil — ukuran halamannya
   mengikuti berkas setelahnya (A4 tetap A4, Letter tetap Letter).
6. **🔗 Gabungkan & unduh** → `<berkas pertama> - GABUNG.pdf`.

Contoh dari user: 2 berkas × 10 halaman, ambil 3 halaman dari masing-masing →
hasil 7 halaman: 3 + pemisah + 3. Cocok untuk verifikasi berkas tagihan RS
(kwitansi / rincian kwitansi / penunjang medis) — ambil rincian kwitansinya
saja dari tiap berkas.

### Teknis

- Mesin baru: `pdftool/merge-engine.js` (global `RFMergeEngine`) — murni &
  Node-testable: `analyzeDocument()` (pdf.js, salinan buffer,
  `isEvalSupported:false`, cuplikan teks dibatasi 120 halaman) dan `merge()`
  (pdf-lib `copyPages`; indeks di-clamp/dedupe/urut; berkas 0 halaman
  terpilih dilewati; teks pemisah lewat `sanitizeWinAnsi` agar font
  standard pdf-lib tidak pernah melempar error pada emoji/kutip).
- Runtime PDF dimuat **malas** dan berbagi cache dengan tab Urutkan
  (`rfPdfSortEnsureRuntime`) + `rfLoadScriptOnce(pdftool/merge-engine.js)`.
- Thumbnail: antrian per berkas, cache `file.thumbs[]` (dataURL JPEG) —
  centang/hilangkan centang memakai cache sehingga instan tanpa kedip;
  buang berkas menandai `abort` untuk menghentikan antrian.
- Unduh via `browser.downloads` (blob lokal, `conflictAction: uniquify`) —
  pola sama dengan Rekonsiliasi.
- **100% offline** — tanpa server, tanpa login, tanpa permission baru.

### Yang TIDAK diubah

- Tab 1 (Urutkan PDF) & tab 2 (Rekonsiliasi): alur, ID elemen, dan fungsi
  analisa tidak disentuh — hanya shell tab yang bertambah 1 tombol + 1 pane.
- Alur simpan/vault/temp (`_dest === 'temp'`), engine.js, xlsx-engine.js,
  vendor/, dan semua batas ukuran.

## Validasi

- Sintaks: `node --input-type=module --check` (parser V8, mode ES module).
- Unit: `test/merge-engine.test.mjs` — 43/43 PASS (urutan isi halaman
  diverifikasi via ekstraksi teks pdf.js: A2,A5,A7 | PEMISAH | B1,B3,B9;
  clamp indeks; ukuran pemisah mengikuti berkas berikutnya; nama emoji
  tidak melempar error; penolakan wajar).
- Regresi: temp-upload, file-kinds, storage-binary, pdfsort — tetap PASS.
- E2E Chromium (build extension asli, chromium-1200 + Xvfb): **61 PASS /
  0 FAIL, 0 pageerror** — 3 tab tampil, tab lama tetap utuh, tambah 2 PDF uji
  (10 halaman masing-masing), thumbnail lengkap 20/20, centang subset
  (3 dari A + 2 dari B), Semua/Nihil/Balik, pindah urutan, gabung → unduh
  (state COMPLETE di downloads API), isi PDF keluaran diverifikasi via
  ekstraksi teks pdf.js (B1, B3 | PEMISAH "3 dari 10" | A2, A5, A7),
  mode tanpa pemisah, buang berkas.
