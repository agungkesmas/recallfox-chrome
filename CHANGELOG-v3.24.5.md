# v3.24.5 — Drag Float Beneran Jalan (anti lengket) + Capture Fullpage Anti-Error di Halaman Header+Scrollable + Anotasi via Klik Preview Diperbaiki

Laporan user v3.24.4 (3 isu):

1. **Floating note/tape/pomodoro tidak bisa dipindah sama sekali, dan "lengket ke kursor ga mau lepas"** — diminta bisa drag & drop tapi deretan tetap rapi.
2. **Screenshot fullpage gagal (error) di halaman yang ada header + konten scrollable** (contoh: intranet BPJS Ketenagakerjaan).
3. **Anotasi dengan mengklik gambar preview belum bisa** — harus lewat tombol Anotasi; seharusnya dua cara.

## 1. DRAG FLOAT — dua akar bug dibunuh (`float-dock.js` + 3 floater)

- **AKAR 1 — hasil drag selalu dibatalkan.** Sejak v3.23.3, melepas drag memanggil `tidy()` = `layout()` → widget **snap balik ke deretan** → seakan tak bisa dipindah sama sekali. Kini hasil drop **DIPERTAHANKAN sebagai slot khusus** (`RFDock.pinCustom`) — widget lain tetap ditata rapi di deretan dengan **menghindari kotak slot** (didorong ke bawah slot, wrap kolom bila meluber) — anti tumpang-tindih, deretan tetap rapat kanan.
- **AKAR 2 — lengket ke kursor.** `mousemove/mouseup` lama dipasang di `document` — mouseup yang terjadi **di atas iframe** atau **di luar window** tidak pernah diterima → flag drag stuck → widget mengikuti kursor selamanya. Kini **Pointer Events + `setPointerCapture` pada header**: semua `pointermove/up` tetap mengalir ke header walau kursor di atas iframe / keluar window; `pointercancel`, `lostpointercapture`, dan `blur` ikut mengakhiri drag.
- **Slot khusus per-tab**: tersimpan di `sessionStorage` (hilang saat tab ditutup, tidak bocor lintas situs) dan **dipulihkan otomatis** saat widget register ulang (mis. reload halaman).
- **Klik ganda judul** = lepas slot, kembali rapat ke deretan (`RFDock.clearCustom`). Tooltip header menjelaskan.
- Drag dari **tombol** (pin/gulung/warna/dll) tetap ditolak — klik tombol tidak pernah jadi drag. Drag via sentuhan didukung (`touch-action:none` di header). Posisi drag selalu di-clamp ke dalam viewport (widget tak bisa hilang keluar layar).

## 2. CAPTURE FULLPAGE — anti-error di halaman header + scrollable (`capture.js`)

- **AKAR 1 — kuota Chrome `captureVisibleTab` (maks 2 panggilan/detik).** Pace v3.24.4 (~350–400ms/frame) melanggar batas ini → di halaman panjang capture **melempar error di tengah jalan** ("tidak berhasil, eror"). Kini **throttle 550ms antar grab** + **retry otomatis** (maks 4 percobaan) bila tetap kena rate-limit.
- **AKAR 2 — banner progress ikut tercapture.** Banner "Menangkap halaman penuh…" (fixed, puncak viewport) masuk ke **tiap frame** → kini disembunyikan sesaat di sekitar tiap grab dan ditampilkan kembali di antara frame.
- **AKAR 3 — header fixed/sticky lebar ikut tercapture di tiap frame** → pita header berulang / sambungan bergeser di halaman ala intranet BPJS. Kini pita header **terdeteksi otomatis** (elemen `fixed`/`sticky` hampir selebar layar yang menempel puncak), **dilewati di semua frame**, dan digambar **SEKALI di puncak hasil**. Mapping per-baris tetap presisi — termasuk kasus **nested scroller yang mulai di bawah header**.
- Bonus: host pomodoro (`#recallfox-pomodoro-host`) kini ikut disembunyikan saat capture (terlewat sebelumnya; note/tape sudah).

## 3. ANOTASI VIA KLIK PREVIEW — wiring dipindah ke modal yang benar (`overlay.js`)

- v3.24.4 memasang blok klik-preview di **`showModePicker()`** (dialog "Ambil screenshot" — **tidak punya** gambar preview) sehingga wiring-nya mati singkat → klik gambar tak pernah berfungsi. Kini terpasang di **modal "Screenshot diambil"**: **klik gambar = buka editor anotasi** (cara kedua selain tombol "✏️ Anotasi"), lewat jalur tombol yang sama (spinner/disable/status otomatis ikut). Hint pill "✏️ Klik gambar untuk anotasi" + cursor pointer + ring hover tetap ada.

## Validasi

- Suite browser-nyata dwi-browser BARU `audit3245/test_real_3245.js`: **166/166 KEDUA browser** (Chromium + Firefox):
  - **Capture** 7 skenario **pixel-exact per baris** (doc-scroller, smooth, nested, halaman pendek, sticky 32px, **fixed header 48px + spacer (kasus BPJS)**, **fixed header 60px + nested scroller (kasus BPJS)**) + varian JPEG; kuota Chrome 2x/detik **disimulasikan nyata** (stub menolak >2 panggilan/1000ms) — pacing 550ms terbukti aman; **banner anti-bocor** diverifikasi pixel (sampling kolom kiri + tengah).
  - **Drag** D0–D6: drop mengikuti kursor & **dipertahankan** (tidak snap balik), mouseup di atas **iframe** berakhir benar (anti-lengket), slot tersimpan & **dipulihkan** saat register ulang, **klik ganda** kembali ke deretan, note kedua tidak menumpuk.
  - **Modal 2 cara**: tombol Anotasi & klik gambar preview sama-sama membuka editor (default kotak), modal tetap utuh setelah 2 siklus.
  - **Regresi auto-save pill** RecallNote (B1–B4) tetap hijau.
- Regresi penuh: `test_real_3243` **68/68** ×2 browser; task_sim **109/109** ×2 repo; keyboard **34/34**; dock **50/50** (S9 diperbarui ke perilaku slot); float_sync **11/11**; multi_float **28/28**; color_pomo **45/45**; vault_float **36/36**; ff **10/10**; chrome_sw **14/14**.
- Paritas: `capture.js`, `float-dock.js`, `pomodoro-cs.js` **md5-identik** antar repo; `notes-cs.js`/`tape-cs.js`/`overlay.js` hanya berbeda di header khusus Firefox (bundle classic / komentar Bugzilla).
