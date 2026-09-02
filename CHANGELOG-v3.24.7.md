# RecallFox v3.24.7 — Print Clean (widget tidak ikut kecetak)

## Laporan user
> "waktu save as pdf atau print floating button atau tape/note/pomodoro nya keikut"
> (screenshot: print preview menampilkan widget RecallFox di hasil cetak halaman)

## Penyebab
Semua floater RecallFox (RecallNote, RecallTape, RecallPomodoro), tombol floating,
dan sidebar dipasang sebagai elemen `position:fixed` di halaman (host Shadow DOM di
`document.documentElement`). Browser tidak punya cara tahu bahwa itu "chrome addon"
— saat user menekan **Ctrl+P / Save as PDF**, elemen `position:fixed` ikut dirender
(bahkan berulang di tiap halaman cetak) sehingga widget ikut kecetak.

## Perbaikan — PRINT CLEAN
Satu blok `@media print { display:none !important }` yang menyembunyikan **SEMUA**
UI RecallFox dari hasil cetak, dipasang di **dua lapis**:

1. **`content/float-dock.js`** — inject `<style id="recallfox-print-hide">` level
   halaman saat init (idempoten via guard `__RFDock`). Lapis ini menjamin cover
   **semua** skema halaman tempat widget bisa ada: `http/https` **dan** `file://`
   (halaman file:// tidak memuat overlay.css sama sekali).
2. **`content/overlay.css`** — blok `@media print` statis yang identik (manifest
   auto-inject di http/https). Jaminan deklaratif bahkan sebelum JS jalan.

Daftar elemen yang disembunyikan saat print (chrome addon, bukan isi halaman):
- Host floater: `#recallfox-sidebar-host`, `#recallfox-sidebar-floater-pair`,
  `[id^="recallfox-notes-host"]` (termasuk lembar `-2`, `-3`, …),
  `[id^="recallfox-tape-host"]`, `#recallfox-pomodoro-host`
- UI transient: `.rf-capture-modal-overlay` (modal screenshot), `.recallfox-mini-info`,
  `.recallfox-overlay-error`, `.recallfox-capture-toast`, `.recallfox-capture-banner`,
  `.recallfox-sel-overlay`, `#rf-annotate-overlay` + `.rf-ann-text-input`,
  `#recallfox-ai-popup`, `.rf-eb-picker-*` (element blocker), `#rf-cg-empty-banner`,
  `#rf-cg-watch-overlay` (content guard), `#rf-adzan-banner`,
  `.recallfox-modal-overlay` + `#recallfox-toast` (content.js)

**Tidak ada perubahan perilaku di layar** — media screen 100% utuh; hanya media
print yang dibersihkan. Konten halaman tetap kecetak normal.

## Validasi
- Playwright (`scripts/print_test_3247.js`): **9/9 PASS**
  - float-dock.js ASLI dieksekusi di halaman uji; 22 selector terdeteksi dari kode
  - Media screen: semua widget terlihat; media print: semua `display:none`
  - Idempoten: float-dock dijalankan ulang → tetap 1 style
  - Jalur statis overlay.css (tanpa float-dock) juga menyembunyikan semua widget
  - Kontrol tanpa fix: widget tampil di print (reproduksi laporan user)
  - Konten halaman (h1/tabel) tetap kecetak di media print
- PDF end-to-end (headless Chromium `page.pdf()`): PDF **dengan fix** bersih
  (hanya konten halaman); PDF **kontrol** memperlihatkan widget persis seperti
  laporan user.
- `node --check` lolos; `float-dock.js` & `overlay.css` md5-identik antar repo
  (paritas Chrome ↔ Firefox terjaga).

## Catatan Firefox
Paritas penuh dengan Chrome — `float-dock.js` dan `overlay.css` disalin
byte-identik (md5 sama); jalur khusus Firefox tidak disentuh.
