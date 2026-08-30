# CHANGELOG v3.24.1 — Fix "Ngetik Vertikal" di RecallNote (Engine Caret-Safe)

## Ringkasan
Perbaikan darurat atas laporan pengguna: setelah v3.24.0, mengetik di
RecallNote menjadi **vertikal** — tiap huruf jatuh ke baris sendiri
(`a`/`j`/`a`/`a`/`s`... tersusun ke bawah), teks hilang-muncul, dan
produktivitas mengetik hancur. Lima perilaku task dari v3.24.0 (Enter =
baris, `>` = subtask radio, klik radio = coret + turun ke dasar sesuai
urutan, hanya di RecallNote) **tetap utuh** — yang diganti adalah motornya.

## Akar Masalah (audit)
Engine v3.24.0 menyentuh DOM pada **setiap** event input melalui tiga jalan
yang saling memperparah:

1. **Editor kosong = nol baris.** Huruf pertama jatuh sebagai text-node liar
   di root editor; `rfAbsorbStray()` memindahkan node itu ke div baru yang
   berbeda → node penumpu caret dibunuh → caret browser mati → huruf
   berikutnya jatuh ke root lagi → tiap huruf menjadi baris sendiri.
2. **Konversi `>` membunuh caret.** `sp.textContent = ...` mengganti text
   node yang sedang ditumpu caret, tanpa pemulihan posisi caret.
3. **Getter `.value` memutasi DOM.** Sekadar membaca teks (autosave, status
   kata) memicu `rfAbsorbStray()` — perusak caret bisa terpicu di tengah
   ketikan oleh kode yang seharusnya hanya membaca.

## Solusi — "Ketikan Native, Bedah Terkendali"
- **Nol mutasi DOM saat mengetik biasa.** Browser mengurus text node secara
  native; pasangan handler input kini no-op total untuk ketikan biasa (tidak
  ada node liar, tidak ada awalan `>`, span bersih).
- **Editor selalu punya ≥ 1 baris.** Caret selalu punya "rumah" di dalam
  span; vektor "huruf pertama jadi baris sendiri" hilang. Placeholder kosong
  pindah dari CSS `:empty` ke class `rfn-empty` (dikelola JS, lebih andal).
- **Span selalu lahir dengan text node sungguhan** (teks kosong pun punya
  node) — caret selalu bisa ditempatkan.
- **Node liar teks digabung, bukan dijadikan baris baru** — `rfAbsorbStray`
  baru menggabungkan teks liar ke baris tetangga via `appendData` (node tetap
  hidup) dan memulihkan caret ke posisi gabungannya. Ada pula "panen" tingkat
  baris (`rfHarvestLine`) untuk teks yang mendarat di dalam baris tapi di
  luar span.
- **Konversi `>` in-place**: marker dibuang lewat `deleteData` pada text node
  yang SAMA (node penumpu caret tidak diganti) + caret baris fokus
  dipulihkan eksplisit (`rfPlaceCaret`) dengan penyesuaian offset.
- **Getter `.value` murni** — membaca tidak pernah memutasi DOM.
- **Hardening tambahan**: radio `contenteditable="false"` (caret tidak bisa
  masuk lingkaran), `beforeinput` `insertLineBreak`/`insertParagraph`
  disanggut (Enter jalur IME/mobile tak lagi menanam `<br>`/`<div>` liar),
  klik area kosong editor memindahkan caret ke akhir baris terakhir.

## Kompatibilitas
- Fasad `.value` 1:1 dan serialisasi teks (`> ` aktif, `>x ` selesai) tidak
  berubah — autosave, sinkron antar-tab, vault, salin/cetak/kosongkan,
  status kata, `ADD_TO_NOTE` tetap berjalan tanpa modifikasi.
- Data lama round-trip byte-identik (diverifikasi sim D3/D3b).
- `isolateKeys` v3.23.5 (anti bocor keyboard) tetap utuh; RecallTape,
  RecallPomodoro, sidebar, dan halaman host tidak tersentuh.

## Validasi
- `task_sim` **77/77 ×2 repo** — termasuk 20 pemeriksaan baru seksi
  "ANTI-NGETIK-VERTIKAL": node liar root digabung (bukan baris baru), 12
  huruf beruntun tetap satu baris, konversi `>` mempertahankan identitas
  text node + memulihkan caret (offset terverifikasi), getter murni,
  `beforeinput` IME, panen teks liar dalam baris, class `rfn-empty`, dan
  lima pengaman sumber.
- Regresi penuh ×2 repo: keyboard_sim 34/34, dock_sim 50/50, color_pomo_sim
  45/45, multi_float_sim 28/28, float_sync_sim 11/11, vault_float_sim 36/36,
  ff_sim 10/10 (Firefox), chrome_sw_sim 14/14 (Chrome), echo_sim2 bersih;
  `node --check` seluruh JS tanpa error; blok engine md5-identik antar repo.
