# RecallFox v3.23.4 — Pin yang Jujur + Deretan Mengikuti Sidebar

Tanggal: 2026-08-30

## Latar — dua laporan user (audit lanjutan v3.23.3)

1. **Tombol 📌 RecallNote/Tape tidak tampak "terpin"** — kondisinya memang
   terpin (klik di luar tidak menutup popout), tapi tombol pin-nya tampak
   seperti tidak terpin (tidak tebal). Bandingkan dengan RecallPomodoro:
   pin-nya tebal, diklik langsung transparan, dan begitu tidak dipin klik di
   luar langsung menutup popout.
2. **Deretan floater harus mengikuti sidebar** — saat popout sidebar dibuka
   lewat kepala rubah (🦊), deretan Pomodoro + Note + Tape otomatis "minggir"
   ke kiri; saat sidebar ditutup deretan balik mepet kanan.

## 1. Pin kini JUJUR — visual selalu sama dengan kondisi

- **Akar masalah**: state pin default `pinned: true` (memang terpin sejak
  awal), tapi class visual `rfn-active` / `rft-active` baru dipasang
  **setelah klik pertama** — template tidak membawa class aktif dan tidak ada
  sinkronisasi awal. Hasilnya: kondisi terpin tapi tampilan tidak terpin,
  dan user harus mengklik dua kali untuk melihat tombol "menyala".
  RecallPomodoro tidak mengalami ini karena template-nya membawa
  `rfp-active` sejak awal.
- **Fix**: tombol 📌 di template RecallNote & RecallTape kini membawa class
  aktif sejak awal + sinkronisasi visual saat lembar dibangun (paritas penuh
  dengan Pomodoro). Sekarang: **terpin = tebal**, klik → transparan (lepas
  pin), klik lagi → tebal kembali; saat lepas pin, klik di luar / Esc menutup
  lembar — persis perilaku Pomodoro.
- Perilaku inti pin (toggle, klik-luar-menutup-saat-lepas, Esc) tidak diubah
  — hanya visualnya yang diperbaiki agar jujur pada kondisi.

## 2. Deretan Pomodoro + Note + Tape otomatis MINGGIR saat sidebar buka

- **float-dock.js kini SIDEBAR AWARE**: API baru `setSidebar(lebar)` —
  jangkar kanan kolom deretan berubah dari `lebar layar − 14` menjadi
  `lebar layar − 14 − lebar sidebar − jeda 12px`, sehingga seluruh deretan
  (termasuk kolom wrap kedua) bergeser rapi dan tidak pernah menutupi
  sidebar.
- **sidebar-cs.js memberi tahu dock** di semua peristiwa: sidebar **buka**
  (tombol 🦊 / pesan OPEN_SIDEBAR_IN_PAGE / restore saat halaman dibuka) →
  deretan minggir; sidebar **tutup** → deretan kembali mepet kanan;
  sidebar **di-resize** (drag pegangan kiri) → deretan mengikuti langsung
  selama drag; lebar diubah lewat API `__recallfox.setWidth` pun ikut.
- **Perpindahan halus** — mengandalkan transisi CSS `.15s` yang sudah ada
  pada popover, jadi deretan "meluncur" bukan lompat.
- float-dock.js juga kini dipasang di entry sidebar (manifest) — idempoten,
  menjamin dock sudah ada sebelum sidebar-cs berjalan.

## 3. Yang TIDAK disentuh (nol risiko sidebar & popout)

- Tidak ada tombol/handler yang diubah atau dihapus: pill 5 tombol, seluruh
  tombol header RecallNote/RecallTape/RecallPomodoro, popup, background,
  iframe sidebar, logika kalkulator/vault/anti-echo — semuanya utuh.
- Perubahan hanya: tambah class + 1 baris sinkron visual (notes/tape),
  tambah API + offset (float-dock), tambah 4 pemanggilan `notifyDock()`
  (sidebar), manifest (float-dock di entry sidebar + versi 3.23.4).

## Validasi

- `node --check` seluruh file JS kedua repo: 0 error.
- Sim dock (50/50 ×2 repo): **D13** sidebar buka → semua floater minggir
  kiri (292px), resize live mengikuti, tutup → balik mepet kanan, kolom wrap
  ikut bergeser, tidak ada floater menabrak sidebar; **D14** pin note/tape
  terpasang class aktif sejak build, klik → transparan → tebal kembali,
  klik-luar-menutup-saat-lepas tetap terpasang; audit sumber S10–S12
  (wiring notifyDock tepat 5, API setSidebar, manifest float-dock sebelum
  sidebar-cs + versi 3.23.4).
- Regresi warisan: color_pomo 45/45, multi_float 28/28, float_sync 11/11,
  vault_float 36/36 (×2 repo), ff_sim 10/10, chrome_sw_sim 14/14, echo_sim2
  bersih.
