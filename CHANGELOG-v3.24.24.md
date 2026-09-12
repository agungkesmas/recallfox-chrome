# CHANGELOG v3.24.24 (12 Sep 2026)

## Daftar situs upload manual: riset ulang + 10 situs terverifikasi live (gofile KEMBALI)

Permintaan user: *"TOLONG tambahkan https://gofile.io/ dan lainnya jika masih ada upload populer di pilihan upload manual di pwa maupun addon. kamu riset dulu yang lainnya tu apa aja gitu baru perbarui di addon yang lengkap, dan masih bisa digunakan."*

### Riset (12 Sep 2026)
- Uji langsung 18 layanan kandidat: cek homepage + **upload fungsional via curl** (bukan sekadar daftar teori).
- gofile.io: dari jaringan datacenter diblokir, tapi **multi-node check (check-host.net: ES/FR/SE) = HTTP 200** — situs hidup dan dipakai user untuk workspace AI agent; laporan v3.24.19 yang membuang gofile sudah usang. Kembali ke daftar **di urutan pertama**.
- Lolos uji upload live: litterbox, tmpfiles, filebin.net, uguu.se, x0.at, temp.sh (endpoint benar: `POST /upload` multipart; `-T` lama sudah 404/405).
- Terbukti MATI/gagal: transfer.sh (DNS hilang), bashupload.com (DNS hilang), fileconvoy (mati), 0x0.st (flaky), file.io (sekali unduh), krakenfiles (uji 2 langkah tidak selesai).
- pixeldrain: web upload anon masih bisa (API butuh key) → tetap masuk. catbox: hidup tapi upload anonim API kadang ditolak "Invalid uploader" (dilaporkan juga pengguna lain) → tetap ada dengan note peringatan + fallback litterbox.

### Perubahan
- `lib/temp-upload.js` — `MANUAL_SITES` 4 → **10 situs**: gofile.io, litterbox.catbox.moe, tmpfiles.org, filebin.net, temp.sh, uguu.se, x0.at, pixeldrain.com, storage.to, catbox.moe. Note tiap situs memuat batas ukuran/masa simpan/keanehan.
- Alur MANUAL tak berubah: klik situs → upload di tab baru → tempel URL halaman unduh; item manual tidak pernah fetch isi file.
- User yang pernah menyimpan daftar sendiri (storage `recallfox_manual_sites`) tidak terdampak — default hanya dipakai bila user belum pernah mengelola; batas tetap 12 situs.
- `test/temp-upload.test.mjs` — asersi diperbarui: 10 situs, gofile di indeks 0, 9 hostname wajib ada, situs mati wajib tidak ada, tanpa duplikat, note ≤100 char.

### Verifikasi
- `node test/temp-upload.test.mjs` PASS (termasuk live upload + roundtrip litterbox).
- Paritas 1:1 antara popup.js Firefox & Chrome (file popup.js identik) dan PWA desktop (RF_SITES_DEF).
