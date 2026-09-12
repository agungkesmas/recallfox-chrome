# CHANGELOG v3.24.23 — Tombol CLEAR di Gabung PDF + daftar otomatis dibersihkan setelah gabung

## Latar
Permintaan pengguna: "tolong ada tombol clear untuk menghapus pdf yang sudah tidak diperlukan,
jangan terus terusan draft di fitur gabung pdf". Di addon, daftar berkas Gabung bertahan selama
halaman alat terbuka dan setelah gabung sukses daftar tidak ikut dibersihkan — plus tidak ada
cara membuang SEMUA berkas sekaligus (hanya ✕ per berkas).

## Perubahan

### 1. Tombol 🧹 Kosongkan semua
- **Layar daftar berkas (Kelola)**: tombol baru `🧹 Kosongkan semua (N berkas)` di bawah
  "Lanjut pilih halaman →" — membuang seluruh daftar setelah konfirmasi `confirm()`.
- **Layar Ringkasan**: tombol `🧹 Kosongkan semua berkas` di bawah "← Kembali pilih halaman".
- Saat dibersihkan: thumbnail dihentikan (`abort`), state kembali ke layar awal, toast
  "🧹 Daftar gabung dikosongkan".

### 2. Daftar otomatis dikosongkan setelah gabung sukses
- 6 detik setelah PDF gabungan berhasil dibuat & terunduh, daftar dibersihkan otomatis
  (state kembali ke layar awal + catatan hijau "✓ Daftar dikosongkan otomatis...").
- Aman: bila user sudah mulai menambah daftar baru dalam jeda itu, pembersihan dilewati;
  bila proses lain sedang berjalan (`busy`), juga dilewati.
- Hint alur di tab Gabung diperbarui supaya perilaku ini terlihat jelas.

## Skala perubahan
Hanya `popup/popup.js` (blok wizard Gabung: 2 view + delegasi klik + tail `rfMergeDownload`)
dan `manifest.json` (3.24.23). Mesin `pdftool/merge-engine.js`, tab Urutkan/Rekonsiliasi,
kompres ala iLovePDF — **tidak tersentuh**.

## Verifikasi
- Sintaks ESM popup.js valid (node --check), md5 popup.js identik antar repo Firefox & Chrome.
- Unit regresi: merge-engine + temp-upload 74/74 + file-kinds + storage-binary — semua PASS.
