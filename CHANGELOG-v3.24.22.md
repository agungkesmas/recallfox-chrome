# v3.24.22 — Gabung PDF: KOMPRESI hasil ala iLovePDF (Ekstrem / Sedang / Tanpa)

## Permintaan user
> "kamu lupa menambahkan fitur kompress di addonya kah? chrome dan versi
> firefox?" — lanjutan keputusan sesi sebelumnya: fitur kompres Gabung PDF
> dgn 3 pilihan seperti iLovePDF ("extreme, sedang dan tanpa compress"),
> diterapkan juga di addon (PWA desktop v1.23.0 sudah punya lebih dulu).

## Perubahan

### UI (popup/popup.js — layar Ringkasan wizard Gabung PDF)
- Blok **🗜 KOMPRESI HASIL** (ala iLovePDF, 100% offline) berisi 3 kartu preset:
  - 🔥 **Ekstrem** — 96 DPI · JPEG 45% — "paling kecil — buat kirim WA/email"
  - ⚖️ **Sedang** — 150 DPI · JPEG 62% — "seimbang — direkomendasikan" (DEFAULT,
    setara "Recommended" iLovePDF)
  - 📄 **Tanpa kompres** — salin vektor utuh — "kualitas & teks asli" (perilaku lama)
- Pilihan tersimpan di `localStorage` (`rf-merge-comp`) — ikut di sesi berikutnya.
- **Estimasi ukuran hasil** sebelum menggabung: sampel halaman terpilih pertama
  tiap berkas × jumlah halaman (render 150/96 DPI sekali per berkas, anti-race
  dgn sequence guard) — "Perkiraan hasil: ≈ X dari N halaman (sampel n berkas
  × DPI)".
- **Peringatan teks asli**: bila ada berkas born-digital (>40 karakter teks),
  tampil "⚠ hasil kompres jadi gambar: teks tak bisa dicari/diseleksi — pilih
  Tanpa kompres bila teks penting."
- **Progress raster** per halaman saat menggabung: "Menggabung bagian i/n —
  halaman k/m (Sedang)…".
- **Hasil jujur**: bila kompres tak mengecilkan (sumber sudah efisien) tampil
  catatan; bila mengecilkan → toast + catatan "🗜 Sedang: 2,1 MB → 640 KB (−70%)".

### Mesin (pdftool/merge-engine.js → v1.2.0)
- `COMP_PRESETS` (extreme/sedang/none) + API baru: `openRasterDoc`,
  `rasterPageJpeg` (pdf.js → canvas → JPEG, cap 4096 px, putih-kan latar,
  lepaskan memori kanvas), `pageHasText` (>40 kar. non-spasi),
  `estimateCompressed` (sampel + estRaw + hasText; aman di Node).
- `merge({ compress, onProgress })`: halaman ISI di-rasterize → JPEG → embed;
  **fallback vektor per halaman** bila raster gagal (hasil tetap benar);
  halaman pembuka & pemisah **TETAP VEKTOR** (teks daftar bagian utuh).
  Dokumen pdf.js di-destroy setelah selesai (hemat memori).
- Hasil merge baru: `comp`, `compIn` (perkiraan ukuran sebelum),
  `rasterized`, `vectorFallback`. Default `compress:'none'` → perilaku lama
  100% utuh (semua pemanggil lama aman).

### Uji
- Unit merge-engine: **86/86 PASS** (24 asersi kompres baru: preset, fallback
  vektor di Node, compress invalid → none, estimasi aman Node, deteksi teks,
  urutan pembuka→isi→pemisah→isi dgn compress aktif; regresi lama utuh).
- E2E Chromium (jalur raster asli via canvas): **17/17 PASS** — 3 hlm raster
  penuh 0 fallback; scan 2 hlm **691 KB → 305 KB (−56%)**; PDF vektor sintetis
  2,9 KB jadi lebih besar saat raster (kasus catatan jujur); cover/pemisah
  tetap ber-teks; halaman raster benar-benar tak ber-teks; estimasi ter-sampel;
  0 pageerror.
- Regresi: temp-upload 74/74, file-kinds 56/56, storage-binary 10/10
  (pdfsort tetap butuh asset PDF user — pre-existing, bukan regresi).

## TIDAK disentuh
- Tab 1 (Urutkan PDF) & tab 2 (Rekonsiliasi) — alur & kode utuh.
- Guard `_dest === 'temp'`, alur simpan/temp/vault, MAX_*, sync.js.
- PWA desktop v1.23.0 (https://recallfox-pwa.vercel.app/desktop.html) sudah
  memiliki kompres identik sejak rilis sebelumnya; PWA mobile menyusul.
