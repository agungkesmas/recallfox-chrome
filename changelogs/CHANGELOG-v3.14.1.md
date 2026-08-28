# RecallFox v3.14.1 — RecallTape CalcTape-Faithful Rebuild

**Tanggal:** 24 Jul 2026
**Tag sebelumnya:** v3.14.0
**Tipe:** Major UI rebuild (fitur RecallTape dirancang ulang total)

## Ringkasan

Rebuild total fitur RecallTape agar 100% identik dengan CalcTape Web (calctape.app).
Perubahan mencakup UI popover, editor behavior, color palette, typography, print
handler, dan tambah percent support. Parser lama dipertahankan (backward compatible).

## Perubahan Utama

### 1. Editor: textarea → contenteditable per-line

**Sebelumnya (v3.14.0):** Editor pakai `<textarea>` polos — user mengetik multiline
tanpa visual feedback. Number formatting tidak muncul real-time.

**Sekarang (v3.14.1):** Editor pakai `<div contenteditable="true">` dengan setiap
baris adalah `<div class="rft-line">` terpisah — persis seperti CalcTape.

Behavior baru:
- Saat user mengetik di baris → text disimpan mentah di `dataset.raw`
- Saat user pindah baris (Enter / klik baris lain) → baris di-render formatted:
  - Baris angka: `<span class="op">+ </span><span class="number">100,00</span><span class="comment"> Gaji</span>`
  - Baris subtotal: dengan separator otomatis + warna emerald
  - Baris text: warna slate, font Nunito
- Saat user klik baris lama → kembali ke mode raw (editable)
- Saat user edit baris lama → SEMUA hasil di bawah re-calculate real-time
- Empty line (Enter di baris kosong) → trigger block separator (border-top dashed)

### 2. CalcTape-faithful color palette (Dark Mode)

```css
--rft-paper:    #273953;  /* editor bg, navy slate */
--rft-ink:      #E8EEF7;  /* main text */
--rft-line:     #364C6C;  /* grid lines */
--rft-surface:  #0E182A;  /* popover outer bg */
--rft-card:     #1A293D;  /* header/footer */
--rft-accent:   #60A5FA;  /* active line border */
--rft-accent-bg:#1E3A8A;  /* active line bg */
--rft-muted:    #A3B0C2;  /* hint, comment */
--rft-neg:      #FB7185;  /* negative numbers (rose) */
--rft-pos:      #42C6A0;  /* positive results (emerald) */
```

Warna diambil langsung dari CSS variables CalcTape asli (`--paper`, `--ink`,
`--line`, `--accent-500`, `--red-500`, `--th-positive`, dll).

### 3. Lined paper background

Editor punya `background-image: linear-gradient(...)` dengan `background-size:
100% 24px` — garis horizontal tipis transparan tiap 24px (sama dengan
line-height), persis seperti kertas notebook CalcTape.

### 4. Active line highlight

Baris dengan cursor (`document.activeElement`) dapat:
- `background: color-mix(in srgb, var(--rft-accent-bg) 75%, transparent)` (biru transparan)
- `border-left: 2px solid var(--rft-accent)` (border biru di kiri)

### 5. Typography dual-font (mirip CalcTape)

- **Numbers & operators**: `"IBM Plex Mono", "Cascadia Mono", Menlo, Consolas, monospace`
- **Comments & text**: `"Nunito", "Segoe UI", -apple-system, sans-serif`

Sesuai CalcTape yang pakai IBM Plex Mono untuk angka dan Nunito untuk text.

### 6. Percent support (fitur baru)

Sesuai permintaan user "jalankan full function". Sekarang parser support:

```
+ 19%       → tambah 19% dari running total
- 10%       → kurang 10% dari running total
+ 50% PPN   → tambah 50% dengan label "PPN"
19%         → default +, tambah 19% dari running total
```

Display di editor:
- Baris dengan percent dapat kelas `.rft-percent`
- Hint absolut ditampilkan setelah angka: `+ 19% | 246,24`
  (246,24 = 19% dari running sebelumnya, mis. 1296 × 0.19)

Evaluator (`lib/tape.js`):
- `parseLine('+ 19%')` → `{op:'+', amount:19, isPercent:true, note:'', raw:'+ 19%'}`
- `evaluate()` menghitung `running += running * (amt/100)` jika `isPercent && op ∈ {+,-}`
- Untuk `*` dan `/` percent tidak masuk akal, treat as normal operation
- Entry dapat field baru: `isPercent: boolean`, `percentValue: number|null`

### 7. Print handler: fix "print blank" bug

**Sebelumnya (v3.14.0):** Pakai `window.open('', '_blank')` lalu
`printWin.document.write(...)`. Sering di-block popup blocker Firefox/Chrome →
user lihat window `about:blank` kosong.

**Sekarang (v3.14.1):** Pakai hidden `<iframe>` di dalam Shadow DOM:
1. Buat iframe dengan `width:0;height:0;opacity:0;pointer-events:none`
2. `iframe.contentWindow.document.write(html)`
3. Wait 250ms untuk render
4. `iframe.contentWindow.focus()` + `iframe.contentWindow.print()`
5. Hapus iframe setelah 1.5 detik

Format resi (80mm):
- Header: `🧾 RecallFox Tape Sheet` + tanggal/jam
- Body: setiap baris dengan operator, amount, dan note (font monospace 10px)
- Separator `---------------` sebelum subtotal
- Separator `===============` sebelum grand total
- Footer: tanggal cetak

### 8. Auto-save real-time

Setiap keystroke → debounce 400ms → `saveSession(text)` ke
`browser.storage.local` key `tapeSession`. Status bar menampilkan:
- `⏳ Menyimpan…` (saat debounce berjalan, warna orange)
- `✓ Tersimpan otomatis` (setelah save selesai)
- `⚠ <error message>` (jika ada error parser)

### 9. Status bar (mirip CalcTape)

Baris bawah editor menampilkan:
- `Ln 5:12` — line number + column caret
- Status autosave (saving/saved/error)

### 10. Result sidebar (mini, di bawah)

Dua kolom:
- **Result block ini** (14px) — running total di block saat ini
- **Grand total** (20px, warna emerald) — total keseluruhan semua block

Mirip sidebar CalcTape yang punya "Result current block" + "Grand total" +
"M (Memory)" (Memory tidak diimplementasi sesuai spec user).

### 11. Micro icon buttons — SVG kustom (bukan emoji)

Header popover sekarang pakai SVG icons (11×11px) bukan emoji:
- 📌 → SVG pin
- 🖨️ → SVG printer
- 📋 → SVG clipboard
- 💾 → SVG save (floppy)
- 🗑️ → SVG trash

Lebih konsisten dengan iconography modern CalcTape.

### 12. Tombol header RecallFox (popup & sidebar)

Ganti emoji `🧾` dengan SVG kustom (16×16px) — gambar receipt dengan garis
horizontal. Lebih konsisten dengan ikon header lain (aiBtn, themeBtn, settingsBtn).

### 13. Resizable popover

Popover sekarang `resize: both` — user bisa drag corner untuk resize.
Min 280×320px, default 340×520px, max tergantung viewport.

## File yang Diubah

### `lib/tape.js`
- Tambah percent support di `parseLine()` (regex baru dengan group `(\s*%)?`)
- Tambah percent handling di `evaluate()` (`percentValue` computed untuk hint)
- Tambah test cases di `selfTest()`: 4 percent tests
- Move `\b` ke dalam suffix group untuk fix bug regex `19%` (sebelumnya tidak ke-parse)

### `content/tape-cs.js`
- **Rebuild total** dari 530 → ~770 baris
- Editor: `<textarea>` → `<div contenteditable>` per-line
- Tambah `renderLine()`, `renderLineFromEntry()`, `setActiveLine()`, `attachLineHandlers()`
- Tambah `handleKeydown()` dengan Enter (buat baris baru), Backspace (merge), Arrow Up/Down (navigasi)
- Tambah `updateStatusCursor()` untuk status bar Ln:col
- Tambah `RECEIPT_HTML()` function untuk print via iframe
- CSS template total rewrite dengan CalcTape-faithful palette
- Tambah status bar + result sidebar mini
- Print handler: window.open → iframe (fix print blank bug)

### `popup/popup.html` & `sidebar/sidebar.html`
- Ganti `<button>🧾</button>` dengan `<button><svg>...</svg></button>` (icon receipt)

### `manifest.json`
- Version bump `3.14.0` → `3.14.1`

## Spec Compliance

Sesuai spec user:
- ✅ Dark Mode konsisten (navy slate khas CalcTape)
- ✅ Grid/line rule di latar editor
- ✅ Kolom 1 (Operator) di kiri, Kolom 2 (Angka) rata kiri dengan format titik ribuan & koma desimal
- ✅ Kolom 3 (Catatan Teks) inline setelah nominal
- ✅ Garis pembatas horizontal tipis sebelum total/subtotal
- ✅ Baris Total dengan warna menonjol (emerald `#42C6A0`)
- ✅ Highlight baris aktif (bg biru transparan + border accent)
- ✅ Input keyboard-first (tidak ada numpad visual)
- ✅ Enter → format angka + buat baris baru
- ✅ Real-time dynamic re-calculation
- ✅ Format Indonesia (titik ribuan, koma desimal)
- ✅ Floating widget, resizable, rounded corners
- ✅ Header dengan 5 micro icon buttons (20×20px): Pin/Print/Copy/Save/Clear
- ✅ Integrasi tombol di Top Header RecallFox Vault (sejajar ikon AI/Theme/Settings)
- ✅ Print handler via DOM (bukan window.open)
- ✅ @media print CSS untuk resi 80mm
- ✅ Header struk: "RecallFox Tape Sheet - [Tanggal & Jam]"
- ✅ Body: monospace rapi dengan operator, angka, catatan
- ✅ Footer: garis pembatas + Total Akhir
- ✅ State persistence via `chrome.storage.local` (real-time, debounced 400ms)
- ✅ Percent support (fitur tambahan, sesuai "jalankan full function")
- ❌ Tidak ada numpad visual (sesuai spec)
- ❌ Tidak ada Memory (M+, MR) (sesuai spec)

## Verifikasi Parser (selfTest)

```
Parse tests: 19 cases, all PASS
  50k → 50000 ✓
  100rb → 100000 ✓
  2,5jt → 2500000 ✓
  2.5jt → 2500000 ✓
  1.250.000 → 1250000 ✓
  1,250,000 → 1250000 ✓
  12.345 → 12345 (Indonesian thousand sep) ✓
  5bn → 5_000_000_000 ✓
  ...

Percent tests: 4 cases, all PASS
  + 19% → isPercent=true, percentValue=246.24 (of 1296) ✓
  - 10% → isPercent=true, percentValue=100 (of 1000) ✓
  + 50% PPN → isPercent=true, note="PPN", percentValue=100 (of 200) ✓
  19% → isPercent=true, op='+', percentValue=19 (of 100) ✓

Backward compat test:
  250000 Gaji → + amount=250000 note="Gaji" ✓
  + 50k Bonus → + amount=50000 note="Bonus" ✓
  - 20rb Makan siang → - amount=20000 note="Makan siang" ✓
  = Subtotal → subtotal marker ✓

Edge case test (false positive prevention):
  4 Bagi 4 orang → op=+ amount=4 note="Bagi 4 orang" ✓ (NOT 4b suffix!)
```

## Yang TIDAK Diubah

- `popup/popup.js` `openTapePopover()` — sudah benar (kirim OPEN_TAPE + fallback inject)
- `background.js` context menu + `TAPE_SAVE_TO_VAULT` handler — sudah benar
- `manifest.json` content_scripts entry — sudah benar
- `lib/tape.js` parser core (50k/rb/jt, Indonesian format) — sudah bagus, hanya tambah percent
- Storage keys `tapeSession`, `tapePin` — tetap sama (backward compatible)
- Tools grid entry `['tape', 'RecallTape', ...]` di popup.js — tetap sama

## Cara Test

1. Load addon di Firefox (about:debugging → Load Temporary Add-on → manifest.json)
2. Buka halaman http/https biasa
3. Klik tombol RecallFox di toolbar → klik ikon receipt di header popup
4. RecallTape popover muncul di pojok kanan-atas halaman
5. Ketik `1000 Gaji` lalu Enter → baris terformat `+ 1.000,00 Gaji`, baris baru muncul
6. Ketik `+ 19% PPN` → baris terformat dengan hint `+ 19% | 190,00 PPN`
7. Ketik `= Total` → baris subtotal muncul dengan separator + angka emerald
8. Klik baris lama → kembali ke raw text, edit → semua hasil bawah re-calculate
9. Klik 📋 Copy → paste di WhatsApp, lihat format rapi
10. Klik 🖨️ Print → dialog print muncul dengan resi 80mm (TIDAK about:blank)
11. Klik 💾 Save → vault item baru muncul di popup dengan type 'prompt'
12. Klik 🗑️ Clear → konfirmasi → editor kosong
13. Klik 📌 Pin → klik di luar popover → popover tetap terbuka
14. Tutup Firefox → buka lagi → buka RecallTape → isi tape sebelumnya kembali (auto-save)
