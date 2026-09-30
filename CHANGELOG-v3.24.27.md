# CHANGELOG v3.24.27 — Link gambar di semua hasil copy + Batch bar dirancang ulang agar lega

## FIX — hasil copy kini SELALU menyertakan 🔗 Link gambar (laporan user)

Laporan user: *"lihat hasil kopinya kyk di atas tidak ada linknya"* — hasil
**"📋 Copy + Keterangan"** (batch) menampilkan metadata lengkap tapi tanpa link
cloud gambar. Akar masalah: caption `buildBatchCaption` / `buildScreenshotCaption`
tidak pernah membaca URL cloud (`gdriveFileUrl`), dan screenshot **HP Capture**
tidak punya `source.url` sehingga tidak ada baris link sama sekali.

**Solusi — resolver SATU PINTU `resolveMediaCloudUrl()`** dipakai SEMUA jalur copy
(prioritas: `gdriveFileUrl` → `gdrive_file_url` → `linkUrl` → `pages[0].url` →
`tempUrl` → `source.url`):

- Caption screenshot/dokumen (popup single & batch, viewer, background delegate):
  baris `🔗 Link gambar: {URL cloud}` tepat setelah judul/Sumber, sebelum Waktu.
  text/html dapat anchor `Link gambar (cloud)` yang bisa diklik.
- Format batch "Screenshot Bundle": tiap item kini membawa link-nya masing-masing.
- `_mediaReportEntry` (Salin Link + Ket. & laporan Bundle) kini memakai resolver
  yang sama + mendapat dukungan `source.tempUrl` yang selama ini hanya ada di popup.
- Item lokal-only (belum upload cloud) tetap bersih — tidak ada baris link palsu.
- Firefox: background classic-script tidak bisa import ESM → helper disalin inline
  (`resolveMediaCloudUrlBg`) dengan perilaku identik.

## DESAIN ULANG — batch bar vault tidak lagi penuh sesak (laporan user)

Laporan user: *"tampilannya penuh sesak begitu … sampe gambar yang mau dipilih tu
tidak ada tempat lagi"*. Bar lama = count + hingga 11 tombol `flex-wrap` yang
menggulung 4 baris + chips 2 baris + vault-actions 4 baris di sidebar sempit.

Struktur baru:

- **Baris 1**: `3 dipilih` ··· `⋯` (menu Lainnya) + `Batal`
- **Baris 2**: tindakan utama sesuai konteks — `📋 Copy + Ket.` · `🖼️ Gambar Saja`
  · `🔗 Link + Ket.` · `📋 Copy Teks` · `📋 Copy Bundle` · `🗑️ Hapus`
  (scroll horizontal halus kalau sempit, label dipendekkan)
- **Menu `⋯`**: tindakan sekunder tersembunyi rapi — Download Semua, Copy URL,
  Copy Teks Saja, Pindah ke Folder, Tambah ke Bundle, Arsipkan, Unarsip. Tombol
  `⋯` otomatis hilang kalau tidak ada isinya; menu menutup sendiri setelah aksi.
- **vault-actions** (Batch/Auto/Perintah/Folder/sort) kini 1 baris scroll, dan
  otomatis **disembunyikan selama mode batch** (class `batching` di `#vaultView`).
- **Chips** kembali jadi ribbon 1 baris scroll horizontal.
- Keluar dari mode batch kini lewat SATU PINTU (`endVaultBatchModeSilently`) dari
  semua aksi massal (hapus/arsip/unarsip/pindah/bundle) — class `batching`, menu,
  dan checkbox tidak pernah tertinggal.

## FIX DESYNC — sidebar kini setara popup

`sidebar.html` selama ini TIDAK punya tombol batch **⬇️ Download Semua**,
**🔗 Copy URL** (v3.14.9) dan **🔗 Salin Link + Ket.** (v3.24.26) yang ada di
popup. Desain ulang sekaligus menyatukan keduanya — sidebar mendapat semua tombol.

## Validasi

- `node --check` popup.js / copy-format.js / background.js / overlay.js (chrome &
  firefox) — OK
- Uji unit baru `test_copy_format_32427.mjs`: **26/26 PASS** (rantai prioritas
  resolver, link wajib muncul di caption text/plain+HTML batch & dokumen, tepat
  1 link per item tanpa duplikat, paritas caption ↔ report, tempUrl di report)
- Regresi `test_copy_format_32426.mjs`: **19/19 PASS** (format laporan & paritas
  seleksi↔bundle tidak berubah)
- Paritas file chrome ↔ firefox: popup.js, popup.css, copy-format.js,
  popup.html*, sidebar.html* identik (*hanya beda baris polyfill).
