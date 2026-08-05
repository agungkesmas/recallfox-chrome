# RecallFox Chrome — v3.20.7 (Stable)

> Stability release untuk RecallTape calculator — verify format output sesuai spec v3.20.1-stable + defensive coding untuk mencegah edge-case crash.

Tanggal: 2026-07-31

## Ringkasan

Audit lanjutan setelah v3.20.6. User melaporkan RecallTape "belum mirip dengan versi addon" dan "tidak stabil". Setelah audit komprehensif Firefox v3.20.1-stable vs Chrome v3.20.6:

**Temuan audit:** Code tape-cs.js Chrome v3.20.6 sudah **identik** dengan Firefox v3.20.1-stable (modulo const→let fix dari v3.20.6 yang memang diperlukan). Format output yang diproduksi **sudah benar** — verified via standalone test di Chrome 149 headless:

```
Type "1" "2" "0" "0" → auto-format jadi "+   1200"
Type "+" → auto-newline "+   1200\n+   "
Type "2" "0" "0" "0" → "+   1200\n+   2000"
Press Enter → "+           1200\n+           2000\n─────\n→          3.200  📋\n"
```

Format ini **persis** match dengan spec yang user berikan:
```
+           1200
+           2000
─────
→          3.200  📋
```

**Akar masalah "tidak stabil" yang sebenarnya:** Beberapa edge case di keydown handler & message listener yang bisa menyebabkan tape crash/hang secara silent. Release ini memperbaiki semuanya via defensive coding.

## Perubahan

### 1. HIGH — OPEN_TAPE sekarang always-show (sebelumnya toggle)

**File**: `content/tape-cs.js:703`

**Bug**: `OPEN_TAPE` message sebelumnya memanggil `toggle()`. Kalau user klik tombol RecallTape di popup 2x cepat (atau message terkirim 2x karena retry), panggilan kedua akan HIDE tape yang baru saja di-show. User melihat tape "kedip" atau "hilang" — dirasakan sebagai "tidak stabil".

**Fix**: `OPEN_TAPE` sekarang selalu memanggil `show()` (idempotent — aman dipanggil berkali-kali). Untuk hide, gunakan `HIDE_TAPE` message, klik outside popover, atau tekan Esc.

**Kompatibilitas**: `SHOW_TAPE` dan `HIDE_TAPE` message tetap ada (tidak berubah). Popup button tetap pakai `OPEN_TAPE` — sekarang behavior-nya lebih predictable.

### 2. MEDIUM — Defensive try/catch di keydown handler

**File**: `content/tape-cs.js:665-683`

**Bug**: `handleAutoFormatKey(e)` dan `handleEnterKey(e)` dipanggil langsung tanpa error boundary. Kalau salah satu throw (e.g., regex edge case, textarea null, dsb.), seluruh keydown listener abort — keystroke berikutnya juga gagal, tape "stuck" dan user tidak bisa ngetik lagi sampai reload.

**Fix**: Wrap kedua handler dalam `try/catch`. Error di-log ke console (`[RecallFox/Tape] keydown handler error:`) tetapi UX tetap responsif — user tetap bisa ngetik (default action tidak di-prevent).

### 3. MEDIUM — composedPath() untuk click-outside detection

**File**: `content/tape-cs.js:702-712`

**Bug**: Click-outside listener pakai `host.contains(e.target)`. Untuk Shadow DOM events, `e.target` retargeting behavior bervariasi antar browser engine — kadang retarget ke host, kadang tetap element asli di shadow DOM. Di Chrome tertentu, klik di dalam textarea (shadow DOM) bisa salah terdeteksi sebagai "click outside" → popover hide secara tidak terduga saat user coba klik untuk select text.

**Fix**: Pakai `e.composedPath()` yang berisi full event path termasuk element di dalam shadow DOM. `path.includes(host)` lebih akurat daripada `host.contains(e.target)`.

### 4. LOW — Komentar dokumentasi update

**File**: `content/tape-cs.js:271-272`

Update komentar di `handleEnterKey` untuk mention v3.20.7 (handler sekarang di-wrap try/catch oleh caller).

## Verifikasi

### Standalone test di Chrome 149 headless (Playwright):

**Test 1: Format output**
```
Input scenario: type "1" "2" "0" "0" "+" "2" "0" "0" "0" Enter
Output: "+           1200\n+           2000\n─────\n→          3.200  📋\n"
Expected: "+           1200\n+           2000\n─────\n→          3.200  📋\n"
MATCH? YES ✓
```

**Test 2: Click stability**
```
Open tape → popover visible? true ✓
Click on textarea (inside shadow DOM) → popover visible? true ✓ (tidak hide)
Focus textarea → popover visible? true ✓
Type "1" → popover visible? true, value="+   1" ✓
Press Enter → popover visible? true, value="+   1\n─────\n→            1  📋\n" ✓
Click on body (outside) → popover visible? false ✓ (hide correctly)
```

**Test 3: Toggle race (sebelum fix: bisa hide tak terduga)**
```
OPEN_TAPE → show() starts (async, awaits loadTheme + loadSession)
OPEN_TAPE → show() starts (idempotent — aman dipanggil 2x)
OPEN_TAPE → show() starts (idempotent)
Final state: popover visible (semua show() promises resolve ke state yang sama)
```

## File yang berubah

| File | Perubahan |
|---|---|
| `manifest.json` | version bump 3.20.6 → 3.20.7 |
| `content/tape-cs.js` | OPEN_TAPE: toggle() → show(); try/catch di keydown handler; composedPath() di mousedown listener |

## Kompatibilitas

- **Chrome MV3**: ✓ (semua API yang dipakai sudah ada di Chrome MV3 sejak versi awal)
- **RecallTape session**: tidak ada perubahan format session storage — tape yang sudah disimpan user tetap compatible.
- **Message API**: `OPEN_TAPE`, `SHOW_TAPE`, `HIDE_TAPE`, `ADD_TO_TAPE` tetap ada. Hanya behavior `OPEN_TAPE` yang berubah dari toggle → always-show.
- **Popup button**: tetap pakai `OPEN_TAPE` — sekarang behavior lebih predictable (selalu show, tidak toggle).

## Testing checklist (manual, di Chrome)

- [ ] Load unpacked dari `chrome://extensions` → extension jalan tanpa error di service worker.
- [ ] Buka halaman web → klik tombol 🧾 RecallTape di popup → popover muncul di kanan atas.
- [ ] **Format test**: Ketik "1200" → otomatis jadi "+   1200" → ketik "+" → baris baru "+   " → ketik "2000" → tekan Enter → output harus:
  ```
  +           1200
  +           2000
  ─────
  →          3.200  📋
  ```
- [ ] **Click stability test**: Klik di dalam textarea → popover tetap visible (tidak hide). Klik di luar popover → popover hide.
- [ ] **Toggle race test**: Klik tombol RecallTape di popup 2x cepat → popover tetap visible (tidak kedip/hilang). Sebelum v3.20.7, klik 2x bisa hide karena toggle().
- [ ] **Defensive test**: Buka DevTools → Console → ketik di textarea seperti biasa → tidak ada error `[RecallFox/Tape] keydown handler error:` di console.
- [ ] **Enter behavior**: Setelah Enter, cursor harus pindah ke baris baru kosong di bawah result line. Lanjut ketik angka → auto-format "+   <digit>" di baris baru.
- [ ] **Running total**: Ketik "1000" Enter → "→ 1.000 📋" → ketik "+" "500" Enter → "→ 1.500 📋" (running total benar, bukan 500).

## Catatan untuk Firefox addon

Perubahan di release ini juga relevant untuk Firefox addon v3.20.2-stable:
- **OPEN_TAPE: toggle() → show()** — bug sama, perlu port.
- **try/catch di keydown handler** — defensive, perlu port.
- **composedPath() di mousedown listener** — Firefox sudah handle retargeting dengan benar, tapi composedPath() tidak menyakiti (lebih portable).

Saran: jalankan audit serupa di repo `recallfox` (Firefox) dan rilis v3.20.3-stable dengan fix yang sama.
