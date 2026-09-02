# RecallFox v3.24.8 — Popup Aware (floater tidak muncul di jendela popout)

## Laporan user
> "ketika ada popout windows, tapi bukan tab lain ya/atau tab baru, ini di popout.
> masih keluar floating button. apakah bisa di hide? karena popout kan kecil ya.
> jadinya mengganggu interaksi"

## Penyebab
Semua halaman mendapat UI RecallFox yang sama: pill floating button (🦊📸📝📏⏱️)
selalu di-mount oleh `sidebar-cs.js`, dan RecallNote/Tape/Pomodoro yang sedang
"open" ikut auto-pulih di SETIAP halaman baru (boot reconcile dari storage
lintas-tab) — termasuk di jendela popout kecil hasil `window.open` (popup OAuth,
popup detail aplikasi, dsb). Di jendela kecil, pill + floater menutupi konten
dan mengganggu interaksi. Browser tidak menawarkan CSS "sembunyikan di popup
window", jadi addon harus mendeteksinya sendiri.

## Perbaikan — POPUP AWARE (deteksi dua lapis)

### 1. Deteksi terpusat di `content/float-dock.js` (idempoten, jalan pertama)
- **Heuristik sinkron (instan, anti-kedip)**: `window.opener` ada + jendela kecil
  (`outerWidth < 850` dan `outerHeight < 650`) = popout klasik. Tab baru / link
  `target=_blank` / jendela penuh TIDAK terdeteksi popup (aman — user:
  "bukan tab lain ya").
- **Verdict otoritatif via background**: content script kirim
  `RF_GET_WINDOW_INFO` → background jawab `browser.windows.get(
  sender.tab.windowId).type` — `type !== 'normal'` (popup/panel/devtools) =
  popup terkonfirmasi. Verdict menggantikan heuristik begitu tiba, sehingga:
  - popup BESAR yang lolos heuristik ikut tertangkap (koreksi: pill dicabut);
  - salah-duga heuristik pada tab/jendela normal dikoreksi (floater dipasang
    ulang / pulihan boot dijalankan);
  - background gagal/tidak merespons → fallback ke heuristik, TIDAK menggantung.
- API untuk konsumen: `window.__RFDock.isPopup()` (nilai terkini) dan
  `window.__RFDock.whenPopupVerdict(cb)` (dipanggil sekali saat verdict final).

### 2. Guard di semua titik kemunculan UI
| Titik | File | Perilaku di popup |
|---|---|---|
| `mountFloater()` + koreksi verdict | sidebar-cs.js | Pill tidak dipasang; yang sudah terpasang dicabut |
| Boot reconcile `noteInstances` + storage.onChanged | notes-cs.js | Tidak auto-pulihkan / tidak sinkron-render (state storage TIDAK diubah) |
| Boot reconcile `tapeInstances` + storage.onChanged | tape-cs.js | Idem |
| Boot `pomodoroFloatState` + storage.onChanged | pomodoro-cs.js | Idem (timer tetap berjalan, hanya tidak dirender) |

Penting: popup hanya TIDAK MERENDER — state `open` di storage tidak pernah
ditulis, jadi lembar yang terbuka di jendela normal tetap utuh, dan popup yang
di-maximize + reload kembali normal.

### 3. `background.js` (kedua repo)
Listener baru `RF_GET_WINDOW_INFO` → `browser.windows.get(sender.tab.windowId)`
→ `{ ok, wtype, width, height }`.

## Validasi
- Playwright `scripts/popup_test_3248.js`: **15/15 PASS** — float-dock.js ASLI
  dieksekusi; blok guard + verdict sidebar-cs.js ASLI diekstrak dari source;
  `browser.runtime.sendMessage` di-stub untuk 7 skenario:
  T1 tab normal (pill tampil, pesan terkirim) · T2 popout klasik 500×400
  (heuristik menahan tanpa kedip) · T3 popout besar 900×700 (verdict mencabut
  pill) · T4 tab baru tanpa features (pill tetap tampil) · T5 verdict telat
  300 ms (heuristik menahan) · T6 background gagal (fallback, tidak
  menggantung) · T7 jendela kecil milik user tanpa opener (tidak
  false-positive).
- `node --check` lolos semua file yang berubah, kedua repo.
- Paritas: `float-dock.js` & `pomodoro-cs.js` md5-identik antar repo;
  `sidebar-cs.js` / `notes-cs.js` / `tape-cs.js` diterapkan edit yang sama di
  kedua repo (file memang berbeda karena jalur khusus Firefox — blok baru
  identik, jumlah referensi terverifikasi).

## Catatan Firefox
Paritas penuh — blok POPUP AWARE identik di kedua repo; jalur khusus Firefox
(preload classic `__RF_LIB_NOTES__`, shim edit) tidak disentuh.
