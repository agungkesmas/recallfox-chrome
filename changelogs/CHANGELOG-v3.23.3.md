# RecallFox v3.23.3 — Sejajar Sempurna + Bar Pomodoro Hidup + Palet Warna Bangkit

Tanggal: 2026-08-30

## Latar — tiga keluhan user (audit lanjutan v3.23.2)

1. **RecallPomodoro offset / tidak sejajar** — bar tergulung Pomodoro lebih
   panjang daripada header RecallNote/RecallTape di bawahnya sehingga deretan
   terlihat "jelek" (pomodoro menjorok, tepi kiri tidak segaris).
2. **Bar Pomodoro tergulung terasa kosong** — hanya berisi judul + jam; user
   minta ada tombol **pause, reset, dan bell on/off** langsung di situ, yang
   penting **jangan keliatan kosong**.
3. **Color picker 🎨 di RecallNote tidak berfungsi** — klik warna tidak
   mengubah warna lembar (dirasa mati total).

## 1. Deretan kini SEJAJAR SEMPURNA — semua bar persis 320px

- **Akar masalah terukur**: lebar bar tergulung tidak seragam — Pomodoro 320px,
  RecallNote 300px (default lama v3.23.0), RecallTape bisa 300-an karena
  `data.w` warisan era resize tetap dipakai sebagai lebar bar. Karena dock
  rapat-kanan, bar yang lebih panjang (Pomodoro) menjorok ke kiri → offset.
- **Bar tergulung DIPAKSA 320px** untuk semua jenis (`width:320px!important`
  pada `.rfn-min` / `.rft-min`; Pomodoro memang sudah 320). Tepi kiri dan
  kanan ketiga jenis kini **segararis sempurna** di semua keadaan — termasuk
  lembar yang pernah di-resize user.
- **RecallNote default 300 → 320px** (senada tape & pomodoro). Resize manual
  tetap dihormati saat lembar TERBUKA; begitu digulung, bar kembali 320 rapi.
- **Lepas drag → langsung restack.** Sebelumnya posisi hasil drag bertahan
  sampai restack berikutnya (bisa tampak berantakan lama). Kini begitu mouse
  dilepas, floater langsung kembali rapat ke deretan — dock satu-satunya
  sumber kebenaran posisi, deretan **tidak mungkin berantakan** lagi.

## 2. Bar Pomodoro tergulung kini HIDUP (tidak kosong lagi)

- **Tiga tombol mini baru di bar**: **▶/⏸ Mulai-Pause**, **↺ Reset**, dan
  **🔊/🔇 Bell on-off** — semuanya berfungsi langsung dari bar tergulung,
  tanpa perlu membuka panel (klik ▾ tetap tersedia untuk panel penuh).
- **Jam mini diperbesar & ditebalkan** (13px bold) sehingga ⏱ sisa waktu
  terbaca jelas dari jauh; judul "RecallPomodoro" otomatis disembunyikan saat
  bar tergulung agar bar ringkas tapi penuh fungsi.
- **Panel penuh saat dibuka tetap lengkap** (tidak berubah): timer besar +
  mode, ▶/⏸/↺, 🔊, chips preset 25/5 · 50/10 · 52/17 · 90/20 · Custom +
  input manual + Terapkan, siklus 0/4, pilihan bell Soft/Classic/Digital +
  Test, long break 15 menit, auto-lanjut, notifikasi. State sinkron antar
  tab dan model detik turunan anti-drift tetap utuh.

## 3. Color picker 🎨 RecallNote & RecallTape BANGKIT (bug CSS ditemukan)

- **Akar masalah**: selector CSS di template berupa `..rfn-popover.rfn-pal-open
  .rfn-palette{display:flex}` — **dobel titik** membuat rule dibuang parser
  CSS browser, jadi palet warna **tidak pernah tampil** sama sekali (klik 🎨
  tidak bereaksi). Typo yang sama ada di RecallTape (`..rft-popover...`).
  Simulator lama lolos karena menguji logika klik, bukan parsing CSS sungguhan.
- **Fix**: selector diperbaiki (satu titik) di kedua file + audit sumber baru
  yang menegakkan "tidak boleh ada selector dobel-titik" di sim.
- **Bonus fix**: palet memakai `position:absolute` di dalam popover yang
  `overflow:hidden` — saat bar TERGULUNG, palet akan terpotong tak terlihat.
  Kini `overflow:visible` otomatis saat palet terbuka, jadi 🎨 berfungsi dari
  bar tergulung maupun lembar terbuka, 8 warna, per-lembar, sinkron antar tab.

## 4. Yang TIDAK disentuh (nol risiko sidebar & popout)

- `sidebar-cs.js` (pill 5 tombol), `popup.js/popup.html`, `background.js`,
  `float-dock.js`, dan seluruh logika kalkulator/vault/anti-echo **tidak
  diubah sama sekali** — perubahan hanya di `notes-cs.js`, `tape-cs.js`,
  `pomodoro-cs.js` (CSS template + wiring tombol mini + dock width) dan
  `manifest.json` (versi).

## Validasi

- `node --check` seluruh file JS kedua repo: 0 error.
- Sim dock (31/31 ×2 repo): deretan sejajar kiri-kanan (semua left=690),
  restack gulung/buka/tutup, wrap kolom, migrasi, audit sumber S1–S9.
- Sim warna+pomodoro (45/45 ×2 repo): tombol mini ▶/⏸/↺/🔊 di bar berfungsi,
  transisi timer/bell/notifikasi, warna otomatis & manual, lintas tab.
- Regresi warisan: multi_float 28/28, float_sync 11/11, vault_float 36/36
  (×2 repo), ff_sim 10/10, chrome_sw_sim 14/14, echo_sim2 bersih.
