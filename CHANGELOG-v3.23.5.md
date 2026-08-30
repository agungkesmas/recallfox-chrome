# CHANGELOG v3.23.5 — Anti Bocor Keyboard

## Masalah
Saat mengetik di RecallNote / RecallTape, spasi, `/` dan beberapa tombol lain
"bocor" ke halaman yang sedang dibuka — shortcut situs ikut terpicu
(contoh: YouTube — spasi mem-pause video, `/` membuka pencarian; Google —
`/` memfokuskan kotak pencarian).

## Akar Masalah (hasil audit)
Host floater RecallNote/RecallTape/RecallPomodoro (shadow DOM) ditempel di
`document.documentElement`. Event keyboard dari textarea/input DI DALAM shadow
root adalah *composed event*: ia naik (bubble) melewati host → html →
document → window, sehingga listener `document`/`window` milik HALAMAN ikut
menerimanya (target ter-retarget jadi div host, bukan elemen editable) —
shortcut situs pun terpicu seolah user mengetik di halaman.

Vektor tambahan yang ditemukan saat audit:
- Pill tombol mengambang memakai `tabindex="0"` (bisa fokus keyboard) →
  Enter/Space dari tombol terfokus juga bisa bocor.
- Panel sidebar popout mengikuti pola yang sama untuk tombol-tombolnya.

## Perbaikan
API baru `RFDock.isolateKeys(el)` di `content/float-dock.js` (dimuat pertama
di semua entry manifest): memasang listener fase-bubble di host floater untuk
`keydown / keyup / keypress / input / beforeinput / composition*` yang HANYA
memanggil `stopPropagation()`:

- Event tetap sampai ke elemen internal (textarea/input dan semua handler
  RecallFox di dalam shadow root berada DI BAWAH host) → ketikan, Enter =
  hitung tape, Esc menutup note yang lepas pin, dsb. tetap berfungsi.
- Aksi bawaan browser TIDAK tersentuh (tidak ada `preventDefault`) —
  mengetik, copy/paste, dan navigasi form tetap normal.
- Handler `document`/`window` milik halaman (fase bubble) tidak lagi
  menerima event yang berasal dari dalam floater → tidak bocor lagi.
- Activity-tracker RecallFox (fase capture di document) tetap berjalan →
  deteksi idle tidak rusak.

Dipasang di 5 titik: host RecallNote, host RecallTape, host RecallPomodoro
(termasuk input menit custom), panel sidebar popout, dan pill tombol.

## Batasan Teknis (penting)
Listener halaman yang terpasang pada fase **CAPTURE** di document/window tetap
melihat event (fase capture berjalan sebelum event turun ke host floater).
Memblokirnya berarti mematikan ketikan itu sendiri — tidak mungkin dilakukan
tanpa efek samping. Pola ini jarang dipakai sistem shortcut situs; mayoritas
(fase bubble) kini terblokir sempurna. Jika ada situs tertentu yang masih
bocor, laporkan situsnya untuk dicek polanya.

## Pengujian
- `keyboard_sim.js` BARU 34/34 (×2 repo): unit isolateKeys asli di harness
  bubbling sungguhan (spasi/`/`/keyup/keypress/input/composition terblokir;
  keyboard di luar floater tetap normal; idempoten; tanpa preventDefault) +
  integrasi notes-cs/tape-cs asli (ketikan tersimpan, Esc tutup note lepas
  pin, Enter = hitung 100−40=60) + audit sumber/manifest/paritas.
- Regresi: dock_sim 50/50, color_pomo_sim 45/45, multi_float_sim 28/28,
  float_sync_sim 11/11, vault_float_sim 36/36, ff_sim 10/10,
  chrome_sw_sim 14/14, echo_sim2 bersih — semua ×2 repo.
- Sidebar, popup, background tidak diubah (nol risiko tombol sidebar).

Catatan paritas: perbedaan semantik `sidebar-cs.js` antar repo (ack/fallback)
adalah varian per-browser yang sengaja ada sejak v3.22.x — bukan bagian dari
rilis ini; baris v3.23.5 ditambahkan identik di kedua repo.
