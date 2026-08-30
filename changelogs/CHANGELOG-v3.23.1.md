# RecallFox v3.23.1 — Warna-warni Floating Note/Tape + Pomodoro Mengambang

Tanggal: 2026-08-30

## 1. Warna-warni RecallNote & RecallTape (permintaan user)

Setiap lembar floating note/tape kini punya **warna sendiri**:

- **Pilih sendiri** — tombol 🎨 baru di header tiap floater membuka palet
  8 warna: Hijau, Biru, Kuning, Merah Muda, Ungu, Cyan, Oranye, Hijau Limau.
  Pilihan tersimpan per-lembar (field `color` di `noteInstances`/`tapeInstances`)
  dan tersinkron antar tab real-time.
- **Otomatis** — lembar baru otomatis mendapat warna yang paling jarang dipakai
  lembar terbuka lain. Buka 2–3 lembar sekaligus → warnanya selalu berbeda,
  tanpa diatur. Menutup lembar lalu membuka yang baru akan mengisi kembali
  warna yang kosong.
- Lembar pertama tetap tampilan klasik (note hijau, tape amber) — tampilan lama
  tidak berubah. Instance warisan tanpa field `color` dianggap warna default.
- Implementasi: token warna header/border/judul/tombol-aktif diubah menjadi
  CSS variables (`--p-*`) + override `data-color` per warna, di dalam Shadow DOM
  (aman terhadap CSS halaman). Semua token dark & light theme dijangkau.

## 2. Pomodoro Mengambang (permintaan user)

- Pill mengambang di halaman kini **5 tombol**: 🦊 sidebar, 📸 screenshot,
  📝 note, 🧾 tape, **🍅 pomodoro** (baru, merah tomat).
- Floater Pomodoro (`content/pomodoro-cs.js`) berperilaku persis RecallNote/
  RecallTape: **transparan saat idle** (opacity 0.35, hover penuh), bisa
  digeser, bisa digulung (▾), dan **default TERPIN** (tidak tertutup klik luar;
  lepas pin via 📌 jika ingin klik-luar menutup).
- Bentuk = strip Pomodoro sidebar yang sudah ada: 🍅 timer besar + label mode
  (Fokus/Istirahat/Long Break), ▶ Mulai/⏸ Pause/↺ Reset, 🔊 bell, chips preset
  25/5 · 50/10 · 52/17 · 90/20 · Custom (input menit + Terapkan), siklus 0/4,
  pilihan bell (Soft/Classic/Digital) + ▶ Test. Long break 15 menit otomatis
  setelah 4 siklus; transisi auto-lanjut + bell + notifikasi sistem
  (via background `POMODORO_NOTIFY` — content script tidak punya akses
  notifications). Posisi default: kiri, sedikit di bawah pill.
- **Detik turunan (derived countdown)**: state menyimpan `{remaining, running,
  updatedAt}`; semua tab menghitung sisa detik dari `Date.now() - updatedAt`.
  Tidak ada tulisan storage per-detik → hemat dan bebas drift multi-tab.
  Tulisan hanya saat aksi user & transisi mode (guard re-read + hanya tab
  visible yang menulis). State global `pomodoroFloatState` tersinkron antar
  tab via storage.onChanged — buka di tab A, arahkan tab B, ikut jalan.
  Saat pertama dibuka, preset/custom/sound diwarisi dari strip Pomodoro
  sidebar (`pomodoroState`) bila ada.
- Routing: `RF_OPEN_POMODORO` di background (inject + retry, pola
  RF_OPEN_NOTE/TAPE), fallback `RF_FORWARD_TO_ACTIVE_TAB msgType:OPEN_POMODORO`
  + CustomEvent `rf-open-pomodoro`. Terdaftar di manifest kedua repo
  (http/https/file).

## Validasi

- **Sim BARU `color_pomo_sim.js` 34/34 PASS** (kedua repo): warna otomatis
  berbeda 3 lembar, persist per-instance, pilih manual 🎨, sinkron lintas tab,
  kompat instance warisan, tape amber-klasik dulu; pomodoro default terpin,
  posisi default, detik turunan (24:50 tanpa tulis per-detik), transisi
  fokus→istirahat auto-lanjut + siklus + bell + POMODORO_NOTIFY, pause/reset,
  chip 50/10, custom 15/3, sound toggle/test, gulung, idempoten, unpin & tutup
  lintas tab.
- Regresi penuh: multi_float_sim 28/28, float_sync_sim 11/11,
  vault_float_sim 36/36 (kedua repo), ff_sim 10/10 (Firefox),
  chrome_sw_sim 14/14 (Chrome), echo_sim2 bersih (0 modal bangkit).
- `node --check` 122 file kedua repo: 0 error.

## File berubah

- `content/notes-cs.js`, `content/tape-cs.js` — palet warna + 🎨 + auto-color.
- `content/pomodoro-cs.js` — BARU (identik kedua repo).
- `content/sidebar-cs.js` — pill 4→5 tombol (🍅), openPomodoro, lebar 212px.
- `background.js` — RF_OPEN_POMODORO, POMODORO_NOTIFY, map OPEN_POMODORO.
- `manifest.json` — versi 3.23.1 + entry pomodoro-cs.js.
