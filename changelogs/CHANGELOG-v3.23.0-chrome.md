# CHANGELOG — Multi-Instance Floating Note/Tape v3.23.0 (Chrome)

Paritas penuh dengan Firefox v3.23.0.

## Fitur baru (permintaan user)

1. **Tombol 📝/🧾 di pill mengambang (4 tombol) = LEMBAR BARU.** Setiap tekan
   membuka RecallNote/RecallTape baru yang kosong — bisa 2-3+ lembar seraya.
2. **Tombol ＋ di header setiap floater** — lembar baru tanpa masuk sidebar.
3. **Tombol ▾ gulung (collapse)** — gulung jadi bar judul, buka lagi kapan saja.
4. **Tombol ✕ tutup** — tutup satu lembar saja; isi tetap tersimpan.
5. **Ukuran ringkas default** — note 300px, tape 320px; resize diingat per-lembar.
6. **Auto merapihkan diri** — note menumpuk rapi dari tepi KANAN, tape dari
   tepi KIRI; wrap ke kolom baru bila melebihi tinggi layar; floater yang
   pernah digeser user tidak diganggu.

## Arsitektur (paritas Firefox)

- State global baru: `noteInstances` / `tapeInstances` (array per-lembar).
- Migrasi otomatis dari `notesSession`+`floatNoteState` / `tapeSession`+
  `floatTapeState`; mirror instance#1 ke session lama demi kompat.
- Sinkron antar tab real-time per-lembar via `storage.onChanged` (reconcile
  idempoten, guard anti-timpa saat fokus mengetik).
- Link vault note (⧉) per-instance: noteId sama = pakai ulang instance terbuka.
- `ADD_TO_NOTE`/`ADD_TO_TAPE` → lembar terakhir yang terbuka, atau lembar baru.
- `OPEN_NOTE`/`OPEN_TAPE` kini berarti lembar baru; routing v3.22.9 utuh.

## Logika yang dipertahankan 100%

- Kalkulator tape (auto-format, Enter=hitung, percent, suffix, print, save).
- Semua fitur note (autosave, print, copy, save, pin, drag, tema).
- Guard anti-echo v3.22.7 (broadcast hanya transisi), routing anti-mati
  v3.22.9, posisi pill kiri-tengah v3.22.9, popup.js tetap identik Firefox.

## Validasi

- `node --check` seluruh file = 0 error.
- `multi_float_sim` (BARU) 28/28 PASS · `float_sync_sim` 11/11 ·
  `vault_float_sim` 36/36 · `chrome_sw_sim` 14/14 · `ff_sim` 10/10 ·
  `echo_sim2` bersih — semua di kedua repo.
