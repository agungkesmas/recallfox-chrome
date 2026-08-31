# RecallFox v3.24.3 — Firefox Bisa Hapus Lagi (Shim Edit Firefox) + Enter Lanjut Subtask

**Tanggal**: 2026-08-31 (UTC+8)
**Repo**: recallfox-chrome · recallfox — tag `v3.24.3-chrome` / `v3.24.3-firefox`

## Laporan user

1. *"di versi chrome berhasil, bisa dihapus teksnya. di versi firefox tidak bisa dihapus teksnya"* — setelah v3.24.2, Chrome normal tetapi di Firefox teks RecallNote tetap tidak bisa dihapus sama sekali.
2. Fitur baru: *"ketika dalam mode > itu saat pencet enter langsung buat > lagi seperti layaknya membuat bullet di word sampai saya pencet backspace untuk mendelet untuk beralih ke mode ngetik normal."*

## Akar bug Firefox — dibuktikan dengan reproduksi dwi-browser

Harness browser-nyata v3.24.2 diperluas: `notes-cs.js` asli (build masing-masing repo) dijalankan
dengan aksi keyboard/mouse yang SAMA di Chromium dan Firefox headless (Playwright, event trusted).

Hasil reproduksi (identik dengan laporan user):

| Aksi | Chromium | Firefox (v3.24.2) |
|---|---|---|
| Backspace ×5 | `halo dunia` → `halo ` | **tidak berubah** |
| Ctrl+A + Backspace | kosong | **tidak berubah** |
| Delete maju / Ctrl+Backspace / Ctrl+Delete | normal | **tidak berubah** |
| Ketik menggantikan seleksi | terganti | **tidak berubah** |
| Ketik biasa + Enter + konversi `>` | normal | normal |

Akar: **Firefox tidak memiliki `ShadowRoot.getSelection()`** dan perintah edit nativenya
(Backspace/Delete/ganti-seleksi/Ctrl+A) menuntun seleksi level-dokumen yang **ter-retarget ke
host** Shadow DOM — semua perintah hapus gagal senyap di dalam floater. Ketikan & Enter selamat
karena lewat jalur kode berbeda. Chrome tidak punya masalah ini.

## Solusi — shim edit khusus Firefox (Chrome tetap 100% native)

Engine RecallNote kini memiliki lapisan `RF_IS_FF` yang **aktif hanya di Firefox**:

- **Hapus manual model datar**: Backspace/Delete karakter, hapus kata (Ctrl/Alt+Backspace,
  Ctrl+Delete), dan hapus seleksi rentang — semuanya bedah `deleteData` pada struktur baris
  (`.rfn-line > .rfn-line-txt`), node teks dipertahankan, caret selalu dipulihkan.
- **Ctrl+A manual**: membuat range INNER dari awal baris pertama ke akhir baris terakhir
  (seleksi dokumen bawaan Firefox tak terbaca engine).
- **Ctrl+C / Ctrl+X manual**: tulis clipboard via `navigator.clipboard` (fallback
  `execCommand`), cut menghapus seleksi lewat bedah yang sama.
- **Ketik-ganti-seleksi**: sebelum input — seleksi dihapus dulu lalu teks disisipkan di titik
  sambung (di keydown untuk tombol karakter, plus jaring pengaman `beforeinput` untuk
  `delete*`/`insertText` dari menu konteks).
- Di Chrome seluruh lapisan ini **mati total** (guard `RF_IS_FF`) — jalur native v3.24.2 tidak
  disentuh sama sekali.

## Fitur baru: Enter = lanjut subtask (ala bullet Word)

- **Enter pada baris task aktif** → langsung membuat baris task baru ber-radio di bawahnya,
  caret siap mengetik — persis perilaku bullet di Word; tekan Enter terus = radio terus.
- **Enter pada baris task KOSONG** → keluar mode (radio hilang, kembali teks biasa) — cara
  kedua menutup daftar tanpa menumpuk radio kosong.
- **Backspace di depan isi baris** → tangga dedent ala Word: *done* → *task aktif* (coret
  hilang, tetap di tempat) → *plain* (radio lepas) → merge ke baris atas.
- **Enter pada baris done** → lanjutan plain (bukan task).
- **`>` redundan yang diketik di dalam baris task ditelan** (anti `> > teks`) — refleks
  mengetik `>` setelah auto-continue tetap menghasilkan serialisasi bersih; `>x` di baris task
  sekalian menandai selesai. Spasi pertama setelahnya juga ditelan (anti dobel spasi).

## Perbaikan intern yang ditemukan saat uji browser nyata

1. **TDZ ReferenceError senyap**: `RF_IS_FF` semula dideklarasikan di level `buildCtrl`
   (baris 774) padahal `installNoteTaskEngine()` dipanggil di baris 91 — akses sebelum
   inisialisasi melempar ReferenceError yang ditelan `try{}` call site sehingga listener
   keydown/paste/click GAGAL TERPASANG di kedua browser. Kini deteksi Firefox = variabel lokal
   pertama di dalam `installNoteTaskEngine` (check R1/R2 mencegah regresi).
2. **Caret baris kosong melompat baris**: menaruh caret pada text-node kosong membuat
   Chromium melemparkannya ke baris tetangga. Kini baris kosong menempatkan caret di level
   span (posisi stabil lintas browser) dan `rfCaretAlive` menganggap caret level-elemen dalam
   baris sebagai hidup (tidak lagi "diselamatkan" ke baris lain).

## Validasi

- **Suite browser-nyata dwi-browser 68/68** (Chromium + Firefox, event trusted): ketik natural,
  Backspace stres ×24, Ctrl+A+Backspace, Delete/Ctrl+Backspace/Ctrl+Delete kata, seleksi
  Shift+panah & double-click + ketik-ganti, konversi `>`, auto-continue Enter, keluar mode
  (Enter kosong & Backspace dedent), klik radio = coret + turun sesuai urutan, un-check,
  split tengah teks mempertahankan mode, paste multi-baris, tape tak tersentuh, nol pageerror —
  **semua hijau di KEDUA browser**.
- task_sim **109/109** ×2 repo (seksi Q: auto-continue/dedent/chevron-eat; seksi R: audit shim
  FF + guard anti-TDZ), keyboard_sim 34/34, dock_sim 50/50, color_pomo_sim 45/45,
  multi_float_sim 28/28, float_sync_sim 11/11, vault_float_sim 36/36 ×2 repo, ff_sim 10/10,
  chrome_sw_sim 14/14, echo_sim2 identik dengan baseline v3.24.2 (dibandingkan via worktree
  tag — bukan regresi), `node --check` 124 file ×2 = 0 error, blok engine md5-identik antar repo.
