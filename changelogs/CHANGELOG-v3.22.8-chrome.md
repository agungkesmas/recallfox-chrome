# CHANGELOG — RecallNote/RecallTape v3.22.8 (Chrome)

## Bug yang diperbaiki: "floating note jadi BARU/kosong saat pindah tab"

**Laporan:** Note mengambang berisi "kerjakan laporan sosialisasi arjawinangun" di tab
pertama; saat berpindah ke tab kedua, RecallNote muncul sebagai note BARU (kosong,
placeholder tampil). Yang diharapkan: isi floating note SAMA di semua tab — termasuk
file lokal (`file://`) dan alamat lokal (mis. omniroute di localhost).

## Akar masalah (terbukti via simulasi deterministik — `float_sync_sim.js`)

1. **Vault note tidak pernah masuk penyimpanan global.** Saat vault note di-pin ke
   floater (`OPEN_NOTE_VAULT`), isinya hanya dikirim via message ke tab pembuka dan
   disimpan ke vault. `notesSession` (sumber konten global) tetap kosong, sehingga
   `show()` di tab lain memuat string kosong → floating note baru yang kosong.
2. **Tidak ada live-sync antar tab.** Note yang terbuka di dua tab tidak ikut berubah
   saat tab lain mengetik — hanya tersinkron saat `show()` dijalankan ulang.

## Fix (content/notes-cs.js, content/tape-cs.js)

- **Mirror vault → session global:** handler `OPEN_NOTE_VAULT` kini menulis konten ke
  `notesSession` sebelum `show()`; autosave mode vault (`UPDATE_VAULT_NOTE`) ikut
  men-mirror ke `notesSession`.
- **Fallback show():** `show()` memuat `notesSession` meski `vaultNoteId` terisi
  (bila textarea masih kosong) — note vault yang di-pin tampil sama di tab mana pun.
- **LIVE SYNC:** listener `storage.onChanged` untuk `notesSession` — tab lain yang
  note-nya terbuka ikut berubah real-time. Guard anti-timpa: tidak diterapkan saat
  textarea sedang fokus diketik di tab itu (diterapkan saat blur). Sama untuk
  `tapeSession` di RecallTape.
- **Pulihkan link vault di SHOW_NOTE:** saat tab diaktifkan, `vaultNoteId` dipulihkan
  dari float state — note vault tetap "nyambung" di semua tab.
- **Prioritas auto-show:** konten dari `notesSession`/`tapeSession` (sumber kebenaran
  global) menang; teks float state hanya fallback bila textarea masih kosong.

## Dukungan file lokal & localhost

- `notes-cs.js`, `tape-cs.js`, `sidebar-cs.js` (floater pill) sudah terdaftar untuk
  `file:///*` + `http/https` (termasuk localhost) di manifest — konten note kini
  tersinkron global ke semua halaman tersebut.
- **Catatan Chrome:** injeksi content script di `file://` butuh toggle
  *Allow access to file URLs* (chrome://extensions → RecallFox → Details). Ini
  kebijakan Chrome, tidak bisa dipaksa dari extension.
- **Viewer PDF bawaan** (Chrome & Firefox) tidak bisa menerima DOM injection
  (viewer berprivilege) — floating note tidak dapat tampil di tab PDF, di browser
  mana pun. Gunakan halaman HTML/localhost, atau buka sidebar RecallFox di tab PDF.

## Validasi

- `node --check` 57 file JS Chrome + 63 file Firefox = 0 error.
- `float_sync_sim.js` (skenario laporan user): **7/7 PASS di kedua repo** — S1 pindah
  tab free note, S2 vault note tersinkron, S3 live-sync real-time, S4 auto-show `file://`.
- Regresi: `chrome_sw_sim` 14/14 PASS, `ff_sim` 10/10 PASS, `echo_sim2` (fix v3.22.7
  "modal bangkit kembali") tetap bersih — tidak ada perbaikan yang rusak.
