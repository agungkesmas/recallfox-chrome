# RecallFox v3.24.28 — Susun Sesuai Selera (Tahan Lama & Geser untuk Mengurutkan)

## Laporan user
> "apakah tombol tombol yang saya kotaki itu bisa di klik lama kemudian diubah ubah
> urutannya. biar saya melakukan pengurutan sendiri sesuai preferensi. termasuk
> kalau bisa semua elemen di situ bisa di ubah ubah tata letaknya"
>
> (screenshot: modal RecallFox Vault — dikotaki merah: tombol Prompt/Link, semua
> tombol batch (Copy + Ket., Gambar Saja, Link + Ket., Hapus, Download Semua,
> Copy URL, Copy Teks Saja, Pindah ke Folder, Tambah ke Bundle, Arsipkan), dan
> chip filter (Semua/Terbaru/Prompt/Konteks/Snapshot))

## Jawaban: YA — sekarang semua bisa disusun sendiri
**Cara pakai: tekan-tahan (± setengah detik) pada tombol/chip sampai terasa
getar + tombol terangkat, lalu geser ke posisi yang diinginkan, lepas. Urutan
tersimpan otomatis (per perangkat) dan langsung dipakai lagi saat berikutnya.**

### Area yang bisa disusun (jangkauan "semua elemen di situ")
| # | Area | Item | Simpan di |
|---|------|------|-----------|
| 1 | Tile quick actions Beranda | Prompt / Link / (tile lain) | `vault.settings.activeTiles` (ikut sync vault) |
| 2 | Chip filter vault | Semua, Terbaru, Prompt, Konteks, Snapshot, Media, File, Link, Bundle, Arsip | `localStorage rf-ui-chipOrder` |
| 3 | Batch bar — baris utama | Copy + Ket., Gambar Saja, Link + Ket., Copy Teks, Copy Bundle, Hapus | `localStorage rf-ui-batchOrder` |
| 4 | Batch bar — menu ⋯ | Download Semua, Copy URL, Copy Teks Saja, Pindah ke Folder, Tambah ke Bundle, Arsipkan, Unarsip | `localStorage rf-ui-batchMoreOrder` |
| 5 | Baris aksi vault | Batch, Auto, Perintah, Folder, Collapse, Tag (select urutan tidak ikut) | `localStorage rf-ui-vaultActionOrder` |
| 6 | Urutan seksi Beranda | bar Sholat ↔ bar Pomodoro ↔ Tiles | `localStorage rf-ui-homeOrder` |

Untuk #6 ada penanda grip **⋮⋮** baru di ujung kiri bar Sholat & Pomodoro —
tahan lama di bar-nya lalu geser naik/turun; Tiles bisa dinaikkan di atas bar.

### Jaminan perilaku (tidak merusak kebiasaan lama)
- Ketuk normal (<350ms, tanpa geser) = perilaku lama 100%: chip tetap memilih,
  tombol tetap menjalankan aksi, bar Sholat/Pomodoro tetap buka detail.
- Geser sebelum long-press tercapai = itu scroll; timer batal sendiri.
- `touchmove` hanya di-preventDefault **saat drag aktif** — scroll daftar/chip
  tetap mulus seperti biasa.
- Klik setelah drag selesai ditelan (suppressClick) — tidak memicu aksi tombol
  yang kebetulan ikut terangkat (mis. tidak tiba-tiba pindah chip).
- Context menu long-press Android ditahan saat mode susun aktif.
- Auto-scroll bar horizontal (chips/batch) saat menggeser ke tepi.
- Animasi FLIP ringan: kartu lain menyingkap dengan halus mengikuti item digenggam.
- Tombol yang kontekstual (mis. "Link + Ket." hanya di chip media) tetap tampil/
  sembunyi otomatis — pengurutan tidak mengganggu logika konteksnya.
- Sidebar mendapat fitur yang sama (satu kode, popup.js dipakai bersama).

### Lain-lain
- Halaman **Settings** punya seksi baru **"🔀 Tata Letak (Susun Sesuai Selera)"**
  dengan tombol **Atur ulang** — kembalikan semua urutan (termasuk tile) ke bawaan.
- Petunjuk sekali jalan (toast) setelah pembaruan: "✨ Baru: tahan lama
  tombol/chip lalu geser untuk atur urutan sesuai selera".
- Modul baru `lib/layout-prefs.js` (pure, tanpa DOM) + engine drag `rfSortable*`
  di popup.js (delegation per container, idempotent, aman lintas re-render).

## Validasi
- `node --check`: popup.js, settings.js, lib/layout-prefs.js (chrome & firefox) — OK
- Uji unit `scripts/test_layout_32428.mjs`: **27/27 PASS** (kunci storage, save/load,
  sanitasi id, JSON rusak, duplikat, merge urutan: id basi dibuang, chip baru di
  belakang, kasus tombol batch & urutan seksi)
- Regresi tetap: `test_copy_format_32427.mjs` 26/26 PASS, `test_copy_format_32426.mjs` 19/19 PASS
- Paritas chrome ↔ firefox: lib/layout-prefs.js, popup.js, popup.css,
  settings.html, settings.js — byte-identik
