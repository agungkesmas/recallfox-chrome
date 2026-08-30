# CHANGELOG — Vault ⧉ / Tombol Mengambang v3.22.9 (Chrome)

## Bug yang diperbaiki (laporan user + screenshot sidebar CATATAN)

1. **Tulisan `<div>` literal** muncul di isi catatan (floating note / salinan raw).
2. **Hardening tombol ⧉ "kotak mengambang" pada catatan eksisting** — di Firefox
   tombol ini mati karena pesan `RF_OPEN_NOTE_VAULT` tidak pernah punya penerima;
   Chrome ikut dipatch dengan routing yang sama agar paritas & tahan banting di
   semua konteks (popup, sidePanel, popout iframe).
3. **Pill 4 tombol mengambang (🦊 📸 📝 🧾)** di halaman kini default posisi
   **KIRI TENGAH** layar (paritas dengan Firefox v3.22.9).

## Akar masalah

1. **Editor catatan memakai `contenteditable`.** Browser membungkus setiap baris
   ketikan dalam `<div>` ("div soup"). Body disimpan apa adanya (`ta.innerHTML`),
   lalu floating note (textarea plain text) menampilkan tag-nya sebagai tulisan
   `<div>` literal.
2. **Pesan `RF_OPEN_NOTE_VAULT` tidak pernah ditangani** — fallback postMessage
   dari tombol ⧉ menggantung tanpa listener; `RF_FORWARD_TO_ACTIVE_TAB` juga
   belum meneruskan `noteId` maupun memetakan `OPEN_NOTE_VAULT` ke inject
   `notes-cs.js`.
3. **Default posisi pill** sejak base v3.21.2 adalah `bottom:24px; right:24px`.

## Fix (paritas penuh dengan Firefox v3.22.9)

- **FIX-1 — Routing ⧉/📝 anti-mati (popup/popup.js, content/sidebar-cs.js,
  background.js):**
  - Jalur primer tombol ⧉ kini `RF_FORWARD_TO_ACTIVE_TAB` via `chrome.runtime`
    (selalu tersedia di popup, sidePanel, dan popout iframe). Background
    meneruskan ke tab aktif + otomatis inject `content/notes-cs.js` bila perlu.
  - `RF_FORWARD_TO_ACTIVE_TAB` kini meneruskan `noteId` (link autosave vault) dan
    memetakan `OPEN_NOTE_VAULT` → `notes-cs.js` untuk inject fallback.
  - `sidebar-cs.js` menambah handler postMessage `RF_OPEN_NOTE` & 
    `RF_OPEN_NOTE_VAULT` (semantik respons mengikuti fix v3.22.7 Chrome:
    `res` undefined dianggap sukses — anti modal dobel).
  - Jalur lama (tabs langsung, inject manual, popup PDF) tetap utuh.
  - `popup.html?floatNote=<id>` kini ditangani (`openNoteEditor`) — sebelumnya
    jendela popup PDF terbuka tapi kosong.
- **FIX-3 — Anti "div soup" (popup/popup.js):**
  - `noteBodyToPlain()` — HTML → plain text baris-terjaga (block-aware); dipakai
    saat membuka note vault ke floater sehingga catatan lama yang tercemar tag
    tampil bersih di floating note.
  - `normalizeEditorHtml()` pada autosave editor — ketikan biasa disimpan sebagai
    plain text `\n`; formatting nyata (tabel/bold/heading hasil paste) tetap HTML.
- **FIX-4 — Posisi pill kiri tengah (content/sidebar-cs.js):**
  - Default: `left:14px`, vertikal tengah viewport; posisi lama (format tanpa
    penanda versi) dimigrasi; hasil drag user setelah rilis ini ditandai `v:2`
    dan dihormati.

## Validasi (semua deterministik, tanpa browser)

- `node --check` seluruh file JS = 0 error.
- `chrome_sw_sim` 14/14 PASS; `ff_sim` 10/10 PASS (Firefox tetap hijau).
- `float_sync_sim` 7/7 PASS (sinkron antar tab v3.22.8 tidak rusak).
- `echo_sim2` bersih (fix modal v3.22.7 tidak kebangkitkan kembali).
- `vault_float_sim` (BARU) 36/36 PASS: klik ⧉ semua konteks → note tampil dengan
  isi plain tanpa `<div>`; payload `noteId` + inject `notes-cs.js`; posisi kiri
  tengah + migrasi + hormati drag v2; handler postMessage; param `floatNote`.

## Catatan

- popup/popup.js Chrome kini **identik byte-per-byte** dengan Firefox (parity
  penuh), memudahkan audit diff ke depan.
- Tidak ada tombol/fitur lain yang disentuh. Perubahan hanya pada 3 file:
  `popup/popup.js`, `content/sidebar-cs.js`, `background.js` (+ versi & changelog).
