# RecallFox v3.24.2 — Typing Natural: Teks Bisa Dihapus Lagi & Tanpa Ngetik Vertikal

**Tanggal**: 2026-08-31 (UTC+8)
**Repo**: recallfox-chrome (6f16ca7) · recallfox (b053b9e) — tag `v3.24.2-chrome` / `v3.24.2-firefox`

## Laporan user

1. *"teks jadi tidak bisa di delete sama sekali ... seperti tidak berkesudahan"* — menghapus teks di RecallNote tidak berjalan sama sekali.
2. (rapatan dari v3.24.0–v3.24.1) *"ngetiknya jadi vertikal"* + tuntutan pola mengetik yang natural.

## Akar bug — dibuktikan di Chromium asli (bukan teori)

Audit kali ini memakai reproduksi nyata: `notes-cs.js` asli dijalankan di Chromium headless
(Playwright, event keyboard trusted melalui pipeline input Chrome) dengan stub `browser.*`.
Dua akar ditemukan, satu desain:

1. **Elemen `<span class="rfn-radio" contenteditable="false">` di dalam alur teks** (engine v3.24.0–v3.24.1).
   Caret yang terdampar pada posisi elemen tepat setelah radio membuat Chrome **menolak
   Backspace** — uji nyata: 5× tekan = 0 karakter terhapus. Inilah "tidak bisa delete sama sekali".
2. **Baris kehilangan `span.rfn-line-txt`**. Chrome meninggalkan `<div.rfn-line><br></div>` tanpa
   span setelah Ctrl+A+Backspace; `rfHarvestLine` lama no-op untuk baris tanpa span → kerusakan
   **permanen**: ketikan jadi text node liar di luar span, konversi `>` menghapus node penumpu
   caret (caret mati → jatuh ke root → satu huruf per baris = "ngetik vertikal"), dan ketikan
   berikutnya mendarat SETELAH radio.

Sim lama lolos 58/58 karena berjalan di DOM stub tanpa editing engine asli — bug kelas
contenteditable hanya terdeteksi di browser nyata. (Pelajaran: suite browser-nyata kini bagian
regresi tetap.)

## Solusi — redesain engine, bukan tambal sulam

- **Radio = pseudo-element CSS `::before`** pada `.rfn-task` — NOL elemen non-editable di alur
  teks, sehingga Backspace/Delete **selalu native**. Visual identik (lingkaran 13px, hover
  membesar, terisi saat done). **Toggle = klik gutter kiri ≤25px** baris task.
- **Normalisator `rfNormalize()` + `rfHealLine()`** tiap input (no-op saat sehat):
  - baris tanpa span → dibuat span baru, seluruh konten dipindah masuk, caret dipulihkan;
  - text node liar di root → digabung ke baris tetangga (bukan baris baru);
  - `<br>` sisa di root/dalam baris dibuang;
  - editor selalu ≥ 1 baris; caret mati dipulihkan ke akhir baris terakhir (hanya saat fokus).
- **Konversi `>` menelan satu spasi** ketikan user setelah konversi → serialisasi bersih
  `> teks` (sebelumnya `>  teks` dobel spasi).
- **Seleksi rentang tidak di-intercept**: Backspace/Delete dengan seleksi non-collapsed dibiarkan
  native menghapus seleksi (bug laten v3.24.1: select-all+Backspace bisa ter-merge).
- Ketikan biasa tetap **NOL mutasi DOM**; bedah hanya pada Enter/Backspace tepi/Delete
  tepi/paste/konversi/klik gutter — dan tiap bedah memulihkan caret.

## Kompatibilitas

- Kelima perilaku task v3.24.0 utuh: Enter = baris; `>` = subtask radio + indent; klik radio =
  coret + turun ke dasar sesuai urutan selesai; klik lagi = aktif kembali; hanya di RecallNote.
- Fasad `.value` 1:1, serialisasi `> `/`>x ` tidak berubah — autosave, vault, sinkron antar-tab,
  salin/cetak/status tanpa perubahan. `isolateKeys` v3.23.5 utuh.
- Blok engine md5-identik antar repo (kecuali head pemuatan lib classic Firefox yang memang
  varian per-browser sejak v3.22.4).

## Validasi

| Suite | Hasil |
|---|---|
| task_sim (kedua repo, +10 check P baru) | 87/87 ×2 |
| keyboard_sim (isolateKeys) | 34/34 |
| dock_sim | 50/50 |
| color_pomo_sim | 45/45 |
| multi_float_sim | 28/28 |
| float_sync_sim | 11/11 |
| vault_float_sim | 36/36 |
| ff_sim (firefox) | 10/10 |
| chrome_sw_sim (chrome) | 14/14 |
| echo_sim / echo_sim2 | bersih |
| **Suite browser-nyata Playwright** (ketik natural, hapus semua mode, konversi, klik radio, stres 40× Backspace + 20× Delete, paste multi-baris, IME insertLineBreak, sinkronisasi) | **28/28** |

## Artefak

- `download/recallfox-chrome-v3.24.2.zip` (943 KB, 181 file)
- `download/recallfox-firefox-v3.24.2.zip` (1002 KB, 192 file)
- Release: `v3.24.2-chrome` (id 379432675) · `v3.24.2-firefox` (id 379432663) — asset `uploaded`
