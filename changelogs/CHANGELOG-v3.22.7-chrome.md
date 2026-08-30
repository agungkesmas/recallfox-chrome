# CHANGELOG v3.22.7-chrome

Tanggal: 2026-08-30

## Ringkasan
Perbaikan bug **"modal bangkit kembali"**: di v3.22.6-chrome, setelah menutup modal
edit screenshot / RecallNote / RecallTape (klik di luar), modal tersebut **muncul
lagi sendiri beberapa detik kemudian**. Perilaku normal ada di v3.22.6-firefox;
versi Chrome yang dibetulkan mengikuti base perilaku screenshot Firefox.

## Akar masalah (dibuktikan via simulasi runtime `echo_sim2.js`)
1. **Echo loop broadcast lintas-tab** (primer). `background.js` mem-broadcast
   `SHOW_NOTE`/`SHOW_TAPE` ke semua tab pada **setiap** penulisan
   `floatNoteState`/`floatTapeState` dengan `isOpen:true`. Chrome fire
   `storage.onChanged` pada **setiap** `.set()` — termasuk nilai identik — dan
   `show()` di notes-cs/tape-cs **menulis ulang float state di akhir show()**.
   Hasilnya rantai tak berujung:
   `show() → save → onChanged → broadcast SHOW_* → show() → save → ...`
   Broadcast in-flight yang mendarat **setelah** user menutup modal membuat modal
   bangkit kembali ("beberapa detik kemudian keluar lagi") dan siklus lahir ulang.
   Di Firefox rantai ini tidak bertahan, sehingga versi Firefox tampak normal.
2. **Fallback dobel berbasis respons** di `sidebar-cs.js`:
   `if (res && res.ok) return;` — saat channel respons putus (SW idle-kill),
   polyfill me-resolve `undefined` → fallback `RF_FORWARD_TO_ACTIVE_TAB` ikut
   mengirim ulang `OPEN_NOTE`/`OPEN_TAPE` → modal terkirim dobel.
3. **Listener content script Chrome tidak membalas pesan** (tidak punya FIX BUG-3
   yang sejak v3.22.4 ada di Firefox) → retry/inject di background salah mengira
   content script absen → kirim ulang pesan pembuka modal.
4. **Handler `SAVE_NOTE_TO_VAULT` hilang di Chrome** (sudah ada di Firefox sejak
   v3.22.4) → tombol "Simpan ke Catatan" RecallNote selalu gagal.

## Perbaikan
- **background.js**: broadcast SHOW_NOTE/SHOW_TAPE kini **hanya pada transisi
  tertutup → terbuka** (`oldValue.isOpen !== true && newValue.isOpen === true`).
  Echo loop mati total; hemat CPU/message di semua tab.
- **content/notes-cs.js + content/tape-cs.js**: guard `userHiddenAt` — broadcast
  `SHOW_NOTE`/`SHOW_TAPE` yang datang **< 5 detik setelah user menutup** modal
  diabaikan (intent user menang). `show()` mereset guard; `hide()` mencatat waktu.
- **content/sidebar-cs.js**: fallback `RF_FORWARD_TO_ACTIVE_TAB` kini **hanya
  jalan pada kegagalan eksplisit (`ok:false`)** — respons `undefined` (channel
  putus) dianggap sukses karena background sudah handle inject+retry sendiri.
- **Port FIX BUG-3 dari Firefox** ke seluruh content script Chrome
  (notes-cs/tape-cs/sidebar-cs/overlay.js): listener kini **wajib membalas**
  pesan yang di-await background (`sendResponse({ok:true})`) agar retry/inject
  tidak salah putus dan modal tidak terkirim dobel. overlay.js kini membalas
  `TRIGGER_CAPTURE_FROM_POPUP`.
- **background.js**: tambah handler `SAVE_NOTE_TO_VAULT` (parity Firefox) —
  tombol "Simpan ke Catatan" di RecallNote kini berfungsi.

## Validasi
- `node --check` seluruh JS repositori: 0 error.
- Simulator Chrome MV3 (`chrome_sw_sim.js`): **14/14 PASS** (module load,
  onInstalled/onStartup, SUPABASE_LOGIN, SAVE_CAPTURE_AS png/jpg/pdf,
  EXPORT_BACKUP, COPY fallback, RF_OPEN_REAL_SIDEBAR, alarm, dll).
- Simulator alur echo (`echo_sim2.js`): sebelum fix = echo loop tak berujung +
  modal bangkit setelah ditutup; sesudah fix = broadcast hanya transisi,
  broadcast basi diabaikan, **0 modal terbuka di akhir sesi**.
- Simulator Firefox (`ff_sim.js`): **10/10 PASS** (regresi aman).

## Catatan
Paritas perilaku dengan Firefox dijaga; perubahan yang sama pada bagian umum
(broadcast transition-gate, guard SHOW_* basi, fallback ok:false-only) juga
diterapkan di v3.22.7-firefox sebagai hardening.
