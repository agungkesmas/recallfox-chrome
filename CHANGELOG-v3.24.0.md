# CHANGELOG v3.24.0 — RecallNote Task Engine (Daftar Tugas)

## Ringkasan
RecallNote kini mendukung perilaku daftar tugas (task list) di dalam lembar
catatan mengambang — permintaan langsung pengguna:

1. Ketik kalimat lalu **Enter** → menjadi item baris tersendiri.
2. Ketik **`>`** di awal baris → otomatis berubah menjadi **subtask**:
   muncul **tombol radio** dan baris **agak masuk ke dalam** (indent).
3. **Klik tombol radio** → teks baris menjadi **tercoret** (strikethrough)
   dan radio terisi hijau.
4. Teks yang tercoret **turun ke dasar deret**, urutannya mengikuti urutan
   waktu selesai. Klik radio yang terisi lagi → item aktif kembali, posisinya
   tepat di atas blok item selesai.
5. Perilaku ini **hanya ada di dalam RecallNote** — RecallTape, RecallPomodoro,
   sidebar, dan halaman host tidak tersentuh sama sekali.

## Cara Kerja (teknis)
- Editor RecallNote dimigrasi dari `<textarea>` menjadi editor baris berbasis
  `contenteditable` — satu `<div class="rfn-line">` per baris. Baris task
  berisi tombol radio (span `.rfn-radio`) + teks (span `.rfn-line-txt`);
  CSS baru mengatur indent (`padding-left: 25px`), lingkaran radio, dan
  coretan (`line-through`, opacity meredup saat selesai).
- **Fasad `.value` 1:1**: elemen editor baru menyediakan property `value`
  (get = serialisasi baris, set = bangun ulang baris) sehingga SELURUH kode
  lama — autosave, sinkronisasi antar-tab, autosave vault (`UPDATE_VAULT_NOTE`
  ), salin, cetak, kosongkan, status jumlah kata, `ADD_TO_NOTE`, guard
  `pendingExternal` saat fokus — berjalan TANPA perubahan.
- **Serialisasi teks murni, kompatibel data lama**:
  - `> teks`  = subtask aktif
  - `>x teks` = subtask selesai
  - baris polos = apa adanya (data lama tanpa `>` tampil persis sama)
  Karena status task tersimpan di teks, sinkronisasi antar-tab dan vault
  tetap bekerja tanpa skema storage baru.
- Navigasi & struktur baris dikelola manual agar deterministik:
  Enter memecah baris di posisi caret, Backspace di awal baris menggabung ke
  atas, Delete di akhir baris menyerap baris bawah, paste multi-baris menjadi
  beberapa baris (teks polos, format HTML dibuang), node liar (sisa
  edit/paste) otomatis diserap menjadi baris (`rfAbsorbStray`).
- Konversi `>` bersifat live & stateless: setiap event input, baris polos
  yang teksnya mulai `>` langsung diubah menjadi subtask; di tengah komposisi
  IME konversi ditunda sampai `compositionend`.
- Placeholder baru mengajarkan fitur: "Ketik > di awal baris = subtask
  (radio) · klik radio = selesai (coret & turun)". Placeholder tampil kembali
  saat lembar dikosongkan (editor benar-benar kosong = nol baris).

## Batasan yang Disengaja
- Baris lama berawalan `> ` (mis. kutipan) kini tampil sebagai subtask —
  konsekuensi model berbasis teks yang dipilih agar kompatibel penuh.
- Undo (Ctrl+Z) menyeluruh hanya andal untuk pengetikan dalam satu baris;
  operasi struktur (Enter/gabung/klik radio) tidak masuk undo native.
- Untuk batal jadi subtask: hapus isi baris atau ubah teksnya; toggling
  selesai/belum cukup lewat klik radio.
- Listener halaman fase CAPTURE tetap tidak terpengaruh aturan ini (batasan
  v3.23.5 tentang isolateKeys tidak berubah).

## Pengujian
- `task_sim.js` (BARU) 58/58 ×2 repo: model murni (14), audit sumber/manifest
  (13), paritas blok engine & template antar-repo (2), integrasi runner asli
  (28): round-trip data lama byte-identik, render task/radio/done, klik radio
  turun ke dasar sesuai urutan klik, un-check kembali sebelum blok done,
  konversi `>` live, Enter pecah di offset caret, Backspace/Delete merge,
  paste multiline, autosave serial, sinkron antar-tab, pendingExternal saat
  fokus → blur, ADD_TO_NOTE, kosongkan + placeholder, Esc tutup note, status
  kata, git hygiene.
- Regresi penuh ×2 repo: keyboard_sim 34/34, dock_sim 50/50,
  color_pomo_sim 45/45, multi_float_sim 28/28, float_sync_sim 11/11,
  vault_float_sim 36/36, ff_sim 10/10 (Firefox), chrome_sw_sim 14/14
  (Chrome), echo_sim2 bersih; `node --check` seluruh JS terubah 0 error.
- Blok engine notes-cs.js md5-identik antar repo Chrome & Firefox
  (perbedaan file tetap hanya header pemuatan lib per-browser yang disengaja).

## Catatan Rilis
- Versi naik ke 3.24.0 (minor) karena ini fitur perilaku baru, bukan patch.
- Zip: `recallfox-chrome-v3.24.0.zip` / `recallfox-firefox-v3.24.0.zip`.
