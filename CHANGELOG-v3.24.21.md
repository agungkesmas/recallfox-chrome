# v3.24.21 — Gabung PDF: alur WIZARD satu-berkas-per-layar + halaman pembuka

## Permintaan user
> "masih kurang bagus. harusnya flow nya gini: 1. pilih beberapa file pdf
> dengan beberapa judul 2. pilih beberapa halaman pdf di judul a 3. pencet
> next beralih ke file pdf judul b ... 5. ada fitur previous atau pilih
> dropdown judul halaman untuk melakukan koreksi 6. jika sudah fix pilih
> gabungkan 7. terbentuk file gabungan dari berbagai file dengan pemisah
> halaman antar file nya" + halaman pertama boleh diberi halaman pembuka
> seperti pemisah (terserah).

## Perubahan

### UI (popup/popup.js — tab 🔗 Gabung PDF dirombak jadi wizard)
- **Layar 1 — Kelola daftar berkas**: hasil multi-pilih tampil sbg daftar
  (judul = nama berkas) + urutan ↑↓ + buang ✕ + tombol [Lanjut pilih halaman →].
- **Layar 2 — Wizard SATU berkas per layar**: "BERKAS n DARI total" + indikator
  titik per berkas + **dropdown judul berkas** (lompat/koreksi kapan saja,
  termasuk opsi "⌂ Kelola daftar berkas…") + badge x/y dipilih + [Semua][Nihil]
  [Balik] + grid thumbnail per halaman (checkbox). Navigasi [← Sebelumnya] /
  [Selanjutnya →]; di berkas terakhir tombol jadi [✓ Selesai — lanjut gabung].
- **Layar 3 — Ringkasan**: per bagian (nama + jumlah + daftar halaman H2, H5…),
  perkiraan total halaman real-time, opsi **☑ Halaman pembuka (daftar bagian)**
  (default ON) + ☑ Halaman pemisah antar berkas (default ON), tombol
  [🔗 Gabungkan & unduh] + [← Kembali pilih halaman].
- Checkbox halaman kini di-update **surgical** (tanpa render ulang grid) →
  thumbnail tidak kedip, scroll stabil.
- BUANG berkas bisa dari wizard (✕ di header) maupun layar kelola.

### Mesin (pdftool/merge-engine.js → v1.1.0)
- Opsi baru `cover`: **halaman pembuka** di awal hasil gabung — judul
  "GABUNGAN PDF" + tanggal + daftar "BAGIAN n — nama berkas (k hlm)".
  Ukuran mengikuti halaman pertama bagian pertama; daftar >tinggi halaman
  diringkas "... +N bagian lainnya"; teks aman WinAnsi.
- Hasil merge kini menyertakan `cover: 0|1`.

### Uji
- Unit merge-engine: 62/62 PASS (18 asersi cover baru; regresi lama utuh).
- Regresi: temp-upload 74/74, file-kinds 56/56, storage-binary 10/10
  (pdfsort tetap butuh asset PDF user — pre-existing, bukan regresi).

## TIDAK disentuh
- Tab 1 (Urutkan PDF) & tab 2 (Rekonsiliasi) — alur & kode utuh.
- Guard `_dest === 'temp'`, alur simpan/temp/vault, MAX_*, sync.js.
- PWA v1.22.0 tidak diubah (tidak punya halaman Olah File Tagihan).
