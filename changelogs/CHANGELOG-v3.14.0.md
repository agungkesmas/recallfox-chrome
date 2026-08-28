# RecallFox v3.14.0 — RecallTape: Keyboard-First Tape Calculator

**Tanggal:** 24 Jul 2026
**Tag sebelumnya:** v3.13.7
**Tipe:** Feature release (new tool, zero dependencies)

## Ringkasan

Menambahkan **RecallTape** — kalkulator pita digital keyboard-first yang terinspirasi dari CalcTape Web (calctape.app). Pengguna mengetik angka + catatan teks di popover compact yang melayang di atas halaman aktif. Setiap baris dapat diedit kembali dan seluruh hasil di bawahnya dihitung ulang secara otomatis (auto-recalculate).

Fitur ini ditujukan untuk skenario "cepat hitung" tanpa membuka app kalkulator terpisah: hitung gaji + bonus - pengeluaran, proyek biaya, konversi satuan, subtotal belanja, dll — langsung dari tab browser mana saja.

## Spec yang dipenuhi

- ✅ **Placement:** Top Header (tombol 🧾 di `.hd-actions` popup & sidebar) + Tools grid (entri pertama di TOOLS array).
- ✅ **Vault Type:** Save to Vault sebagai tipe `prompt` dengan tags `['tape','calculator']`.
- ✅ **Sync:** Local-only — session + pin state ke `browser.storage.local`, tidak lewat Supabase.
- ✅ **Context Menu:** "🧾 Tambah ke RecallTape" / "🧾 Add to RecallTape" (klik kanan teks/angka terseleksi).
- ✅ **Keyboard-first:** Input 100% via textarea; tidak ada numpad visual besar, tidak ada shortcut keyboard standar (Ctrl+Enter untuk save, Esc untuk tutup).

## File baru

### `lib/tape.js` (≈470 baris)
Pure module (zero dependencies) berisi:
- `parseAmount(token)` — parser nomor Indonesia+English. Mendukung suffix `k`, `rb`, `ribu`, `jt`, `juta`, `m` (million), `b`, `bn` (billion). Mendukung separator ribuan `.` (ID) dan `,` (EN), serta decimal `2,5` (ID) / `2.5` (EN). Heuristik middle-group-3-digit untuk disambiguasi `1.250.000` (thousand sep) vs `1.25` (decimal).
- `parseLine(rawLine)` — split `[Operator] [Amount] [Note]` dengan regex yang tahan false-match (mis. `4 Bagi 4 orang` tidak salah parse `b` sebagai suffix billion).
- `evaluate(lines)` — evaluator real-time. Op: `+` (default), `-`, `*`, `/` (guard divide-by-zero), `=` (subtotal marker). Output: `{ entries, grandTotal, error }`.
- `formatNumber(n)` / `formatCurrency(n)` — format Indonesia (titik thousand sep, koma decimal).
- `toPlainText(tape)` / `toMarkdown(tape, opts)` — export clipboard & vault.
- `loadSession()` / `saveSession(text)` / `savePinState(pinned)` — persistence helpers.
- `selfTest()` — 18 test cases untuk validasi parser.

### `content/tape-cs.js` (≈350 baris)
Content script yang inject popover ke halaman aktif via Shadow DOM:
- Mount ke `document.documentElement` dengan `z-index: 2147483647`.
- Shadow DOM untuk style isolation (tidak bocor ke / dari halaman).
- **Header bar:** Title "🧾 RecallTape" + 5 micro icon buttons (24×24px):
  - 📌 **Pin** — toggle agar popover tetap terbuka saat klik di luar (state disimpan ke storage.local).
  - 🖨️ **Print** — buka window baru dengan format resi 58mm/80mm + `@page` CSS, lalu trigger `window.print()`.
  - 📋 **Copy** — salin tape sebagai plain text (WhatsApp/Email friendly, right-aligned amount column).
  - 💾 **Save** — simpan ke Vault sebagai tipe Prompt (markdown table format) lewat message `TAPE_SAVE_TO_VAULT` ke background.
  - 🗑️ **Clear** — konfirmasi lalu kosongkan textarea + canvas.
- **Canvas:** Render 3-kolom (note | operator symbol | amount) dengan font monospace tabular-nums. Separator dotted-line sebelum subtotal. Active row highlight via focus state.
- **Input:** Textarea multiline dengan placeholder contoh format.
- **Footer:** "GRAND TOTAL: [Nominal]" dengan accent color + font lebih besar.
- Auto-save session (debounce 400ms) ke `browser.storage.local` key `tapeSession`.
- Click-outside-to-hide (kecuali saat pin aktif).
- Theme adaptif: baca `settings.theme` dari storage.local, fallback ke `prefers-color-scheme`. Listen `THEME_CHANGED` message untuk live-update.
- Dynamic import `lib/tape.js` via `browser.runtime.getURL()`.

## File yang dimodifikasi

### `manifest.json`
- Version `3.13.7` → `3.14.0`.
- Tambah content_scripts entry untuk `content/tape-cs.js` (matches: http/https/file, run_at: document_idle, all_frames: false).
- Tambah `lib/tape.js` ke `web_accessible_resources` (diperlukan untuk dynamic import dari content script).

### `popup/popup.html` & `sidebar/sidebar.html`
- Tambah tombol `<button class="iconbtn" id="tapeBtn">🧾</button>` di `.hd-actions` (paling kiri, sebelum aiBtn).

### `popup/popup.js`
- Tambah entry `['tape', 'RecallTape', 'Kalkulator pita · keyboard-first', '🧾']` di TOOLS array (paling atas).
- Update `toolPage(k)`: jika `k === 'tape'`, panggil `openTapePopover()` (bukan render halaman dalam popup).
- Tambah function `openTapePopover()`:
  - Query tab aktif → kirim `OPEN_TAPE` message ke content script.
  - Fallback: jika content script belum loaded, inject via `browser.scripting.executeScript()` lalu kirim ulang.
  - Fallback-final: tampilkan halaman info di dalam popup dengan contoh format input.
  - Auto-close popup setelah 600ms (kecuali di sidebar mode).
- Tambah event listener `$('#tapeBtn').addEventListener('click', openTapePopover)` di `bindEvents()`.

### `background.js`
- Tambah context menu entry `rf-add-to-tape` (contexts: `['selection']`) dengan i18n label.
- Tambah handler klik menu: kirim `ADD_TO_TAPE` message ke tab aktif, dengan inject fallback seperti di popup.
- Tambah handler message `TAPE_SAVE_TO_VAULT`: panggil `addItem({ type:'prompt', title, body, tags:['tape','calculator'], source })` → kirim toast konfirmasi ke tab pengirim.

### `_locales/id/messages.json` & `_locales/en/messages.json`
- Tambah key `ctxMenuAddToTape`: "🧾 Tambah ke RecallTape" / "🧾 Add to RecallTape".

## Contoh penggunaan

Input di textarea popover:
```
250000 Gaji Utama
+ 50k Bonus projek
- 20rb Makan siang
= Subtotal awal
* 2 Pajak 2x lipat
/ 4 Bagi 4 orang
```

Canvas akan menampilkan:
```
Gaji Utama         +   250.000
Bonus projek       +    50.000
Makan siang        −    20.000
- - - - - - - - - - - - - - - -
Subtotal awal          280.000
- - - - - - - - - - - - - - - -
Pajak 2x lipat     ×         2
Bagi 4 orang       ÷         4
```

Footer: **Grand Total: Rp 140.000**

Edit baris mana pun (mis. ganti `50k` menjadi `75k`) → seluruh hasil di bawahnya otomatis dihitung ulang.

## Compatibility

- Firefox 115+ (sesuai `strict_min_version` di manifest).
- MV3 compliant (service worker background, no `eval`, no inline scripts).
- Zero new dependencies. Tidak menambah ukuran bundle secara signifikan (~12KB unminified untuk tape.js + tape-cs.js).
- Tidak mempengaruhi fitur existing — semua perubahan additive.

## Test plan

- [x] Parser smoke test (18 cases) — semua PASS.
- [x] JSON manifest + i18n files valid.
- [x] JS syntax check via `node --check` untuk semua file yang diubah.
- [ ] Manual test di Firefox: load addon → buka halaman web → klik 🧾 di header → popover muncul.
- [ ] Manual test context menu: klik kanan teks/angka di halaman → "Tambah ke RecallTape" → baris baru muncul di popover.
- [ ] Manual test Save to Vault: klik 💾 → item baru muncul di Vault sebagai Prompt dengan tag `tape`.
- [ ] Manual test Print: klik 🖨️ → window print terbuka dengan format resi 80mm.
- [ ] Manual test Pin: klik 📌 → popover tetap terbuka saat klik di luar.
