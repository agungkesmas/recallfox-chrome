# RecallFox v3.23.2 — FLOAT DOCK: Satu Deretan Rapi (Note + Tape + Pomodoro)

Tanggal: 2026-08-30

## Latar — keluhan user

Ketika RecallNote/RecallTape **digulung (▾) atau dibuka lagi (>)**, header
tergulung masih "numpang" di posisi lama era ter-expand sehingga tampilan
**misah-misah** (header berserakan di ketinggian yang jauh berjauhan). Selain
itu Pomodoro mengambang masih memakai posisi default sendiri (kiri bawah pill)
sehingga terasa terpisah dari RecallNote/Tape.

## 1. FLOAT DOCK — semua floater satu deretan rapi (file baru: `content/float-dock.js`)

- **Satu kolom, kanan-atas.** RecallNote + RecallTape + RecallPomodoro kini
  disusun oleh SATU dock global: satu kolom vertikal rapat di tepi kanan-atas
  layar (jangkar 14px), urutan stabil **Pomodoro → RecallNote → RecallTape**,
  tiap jenis mengikuti urutan lembar dibuat. Tepi kanan semua floater segaris.
- **Restack penuh pada setiap aksi.** Gulung (▾), buka lagi (>), buka lembar
  baru (＋/📝/🧾/🍅), tutup lembar (✕), resize, dan sinkron antar tab — semua
  memicu penataan ulang seluruh deretan. Header tergulung hanya setinggi bar
  (~44px) sehingga deretan selalu kompak: **tidak pernah misah-misah lagi**.
  Jeda antar floater rapat (10px) seperti tampilan yang diharapkan user.
- **Wrap kolom otomatis.** Bila muatan melebihi tinggi layar, floater berikut
  wrap ke kolom kedua di kirinya (langkah 346px), dst — tidak pernah keluar
  layar dan tidak pernah menumpuk persis di posisi yang sama.
- **Drag tetap bisa.** Floater masih bisa digeser bebas; posisi hasil drag
  bertahan sampai restack berikutnya (dock adalah sumber kebenaran posisi —
  koordinat x/y per-instance tidak lagi dipakai maupun disimpan).
- **Sinkron antar tab tetap deterministik.** Layout adalah fungsi murni dari
  daftar instance (urutan penyimpanan), jadi semua tab menghitung susunan yang
  identik. Tab lain yang menggulung/membuka lembar ikut merapikan deretan di
  tab ini secara real-time.
- File `float-dock.js` idempoten dan dipasang sebagai content script pertama
  pada entry tape/notes/pomodoro di manifest (kedua browser).

## 2. Pomodoro mengambang ikut deretan (permintaan user)

- **Nempel satu deretan.** Klik 🍅 di pill → Pomodoro tampil di deretan yang
  SAMA dengan RecallNote/Tape, selalu di posisi paling atas kolom.
- **Default TERTUTUP + TERPIN** (persis gambar referensi user): tampil sebagai
  bar ramping `🍅 RecallPomodoro 🍅 MM:SS` — timer tetap berjalan dan terlihat
  hidup di bar. Klik ▾ (berubah >) untuk membuka panel penuh; klik lagi untuk
  menggulung. Deretan otomatis menyesuaikan tinggi saat membuka/menggulung.
- **Lebar senada**: 264px → **320px** (sama dengan RecallTape; RecallNote 300px
  — kolom terlihat seragam karena kanan-rata).
- **Migrasi sekali (dv:2)**: state pomodoroFloatState lama v3.23.1 otomatis
  dilipat (collapsed) sekali saat upgrade; setelah itu pilihan gulung user
  dihormati permanen. Pin tetap default aktif (perilaku v3.23.1).

## 3. Hal yang sengaja TIDAK diubah

- Pill 5 tombol (sidebar-cs.js), sidebar, popup, dan background.js tidak
  disentuh sama sekali — tidak ada risiko baru pada tombol sidebar.
- Seluruh fitur lama utuh: warna-warni 🎨 + warna otomatis (v3.23.1), lembar
  baru ＋ / 📝 / 🧾 (v3.23.0), kalkulator tape, vault ⧉ reuse, autosave vault,
  anti-echo modal, anti `<div>` literal, routing tombol ⧉, pill kiri-tengah,
  sinkron isi antar tab (termasuk file:// & localhost).
- RecallTape yang sebelumnya menumpuk dari tepi KIRI kini ikut deretan kanan
  bersama yang lain (konsekuensi "satu deretan" — drag tetap bisa selama
  sesi, restack berikutnya menata ulang).

## Validasi

- Sim BARU `dock_sim` 20/20 PASS ×2 repo (satu deretan pomo→note→tape,
  restack gulung/buka/tutup, wrap kolom, kanan-rata, posisi unik, pomo dibuka
  belakangan tetap di atas, restack lintas tab, migrasi state lama).
- Regresi: multi_float_sim 28/28, color_pomo_sim 37/37, float_sync_sim 11/11,
  vault_float_sim 36/36 (pill kiri-tengah aman), ff_sim 10/10,
  chrome_sw_sim 14/14, echo_sim2 bersih (0 modal bangkit) — semuanya di
  KEDUA repo.
- `node --check` 124 file JS × 2 repo = 0 error; manifest JSON valid.
