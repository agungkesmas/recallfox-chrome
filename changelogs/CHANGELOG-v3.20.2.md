# RecallFox Firefox Addon — v3.20.2 (Stable)

> Port 3 critical bug fix dari Chrome v3.20.6 ke Firefox addon v3.20.1-stable. Bug identik di kedua versi karena Chrome adalah port dari Firefox.

Tanggal: 2026-07-31

## Ringkasan

Audit komprehensif Chrome v3.20.5 vs Firefox addon v3.20.1-stable menemukan bahwa 3 bug yang diperbaiki di Chrome v3.20.6 **ada identik di Firefox** (karena Chrome di-clone dari Firefox). Release ini port ketiga fix tersebut ke Firefox.

**Root cause utama:** RecallTape calculator di Firefox juga punya `const` reassignment bug di `handleEnterKey` — TypeError dilempar setiap kali user tekan Enter setelah ketik angka, sehingga handler abort setelah reformat baris tapi **sebelum** menyisipkan baris hasil (`─────` + `→ <result> 📋`). User mengalami "calculator tidak stabil".

## Perubahan

### 1. CRITICAL — RecallTape calculator Enter key crash (TypeError)

**File**: `content/tape-cs.js:267-268`

**Bug**: `handleEnterKey` mendeklarasikan `pos` dan `val` sebagai `const`, lalu di line 316-317 mencoba reassign:
```js
const pos = textarea.selectionStart;
const val = textarea.value;
...
if (reformattedVal !== val) {
  textarea.value = reformattedVal;
  ...
  val = textarea.value;   // TypeError: Assignment to constant variable
  pos = newPos;           // TypeError
}
// kode setelah ini (evaluate + insert separator + result row) TIDAK pernah dieksekusi
```

**Trigger**: Setiap kali user tekan Enter di akhir baris yang berisi angka. ES module default strict mode → TypeError → handler abort → baris direformat saja, **baris hasil tidak pernah muncul**.

**Fix**: `const` → `let` di line 267-268.

**Catatan**: Bug ini ditemukan dan diverifikasi pertama kali di Chrome v3.20.6 via headless Chrome test. Karena kode `content/tape-cs.js` identik antara Firefox dan Chrome (diff = 0 line perbedaan), fix langsung diaplikasikan ke Firefox juga.

**Verifikasi**:
- Sebelum fix: ketik "1200" + Enter → value = `"+           1200"` (hanya reformat, no result row) + console error "Assignment to constant variable"
- Setelah fix: ketik "1200" + Enter → value = `"+           1200\n─────\n→          1.200  📋\n"` (result row muncul ✓)
- Lanjut ketik "-" + "500" + Enter → `"+           1200\n─────\n→          1.200  📋\n-            500\n─────\n→            700  📋\n"` ✓

### 2. SECURITY + UX — Hardcoded Supabase credentials

**File**: `popup/popup.js:6700-6702, 6721-6724` + `lib/supabase-client.js:38-40`

**Bug**: Form login Supabase pre-fill email `agung.kesmas@gmail.com` + password `Recallfox@2026` di value attribute, plus hintbox menampilkan "Akun default: agung.kesmas@gmail.com / Recallfox@2026". Komentar di `lib/supabase-client.js` line 38-40 juga menyebut kredensial yang sama. Ini:
- **Security issue**: Kredensial exposed di client code (siapapun yang inspect popup.html bisa lihat).
- **UX issue**: User mungkin sign in dengan akun default yang password-nya sudah diubah → login selalu gagal → user pikir "fitur login mati".

**Fix**:
- Hapus baris "Akun default: ..." di hintbox popup.js.
- Hapus `value="agung.kesmas@gmail.com"` dan `value="Recallfox@2026"` di input fields — sekarang placeholder-only, user harus ketik sendiri.
- Update komentar di `lib/supabase-client.js` jadi note security ("kredensial tidak lagi di-hardcode, user harus ketik sendiri, kalau lupa password reset via Supabase dashboard").
- Hapus juga mention "Email (mis. agung.kesmas@gmail.com)" dari placeholder email — sekarang cuma "Email".

**Catatan**: Password `Recallfox@2026` untuk akun `agung.kesmas@gmail.com` sudah di-reset via Supabase admin API saat debugging Chrome v3.20.6. Password-nya tetap `Recallfox@2026` (sesuai yang user tahu), tapi sekarang user harus mengetiknya manual di form login, tidak di-pre-fill.

### 3. MEDIUM — Clear Cache tidak pakai pilihan checkbox user

**File**: `popup/popup.js:6407-6432` (renderCachePage) + `background.js:1978-1996` (CLEAR_CACHE handler)

**Bug**: Saat user klik "Bersihkan Sekarang" di halaman Clear Cache:
- popup.js kirim `{ type: 'CLEAR_CACHE' }` tanpa payload.
- background.js baca `settings.clearCacheDataTypes` (default: `['cache']`).
- Pilihan checkbox user (Cookies, Riwayat, Local Storage, Downloads, Passwords) diabaikan.
- Period dropdown (15m, 1h, 24h, 1w) juga diabaikan.

**Fix**:
- `renderCachePage` sekarang collect selected checkboxes + period, kirim via `msg.dataTypes` + `msg.timePeriod`.
- Pre-populate checkboxes + period dari `settings.clearCacheDataTypes` + `settings.clearCacheTimePeriod` (untuk kontinuitas antar session).
- Background handler prefer `msg.dataTypes` + `msg.timePeriod`, fallback ke settings (untuk backward compat dengan shortcut keyboard Alt+Shift+C yang tidak pass payload).
- Tambah validasi: minimal 1 tipe data harus dipilih.

## File yang berubah

| File | Perubahan |
|---|---|
| `manifest.json` | version bump 3.20.1 → 3.20.2 |
| `background.js` | CLEAR_CACHE handler: prefer msg.dataTypes + msg.timePeriod (fallback settings) |
| `content/tape-cs.js` | const → let di handleEnterKey (CRITICAL fix) |
| `popup/popup.js` | hapus hardcoded Supabase creds + renderCachePage UX fix |
| `lib/supabase-client.js` | hapus kredensial default dari komentar |

## Kompatibilitas

- **Firefox MV3**: ✓ (tidak ada perubahan API — Firefox tetap pakai `browser.menus.*`, `browser.sidebarAction.*`, dynamic `import()` yang Firefox support)
- **Supabase**: tidak ada perubahan schema atau API. Password `agung.kesmas@gmail.com` sudah di-reset ke `Recallfox@2026` via admin API sebagai bagian dari debugging Chrome v3.20.6.
- **RecallTape session**: tidak ada perubahan format session storage — tape yang sudah disimpan user tetap compatible.
- **Clear Cache settings**: tetap backward compatible — kalau `msg.dataTypes` tidak ada (dari shortcut keyboard), fallback ke settings lama.

## Testing checklist (manual, di Firefox)

- [ ] Load temporary extension dari `about:debugging` → "Load Temporary Add-on" → pilih `manifest.json`.
- [ ] Buka halaman web → klik tombol 🧾 RecallTape di popup → popover muncul di kanan atas.
- [ ] Ketik "1200" → otomatis jadi "+   1200" → tekan Enter → baris direformat right-aligned + muncul "─────" + "→ 1.200 📋".
- [ ] Ketik "-" → baris baru "-   " → ketik "500" → Enter → muncul "→ 700 📋" (running total benar).
- [ ] Buka popup → tab Bersihkan Cache → centang "Cache" + "Cookies" + pilih period "1 jam terakhir" → klik "Bersihkan Sekarang" → konfirmasi → cache dibersihkan sesuai pilihan (bukan default hanya 'cache').
- [ ] Buka popup → tab Sync Cloud → form login email/password sekarang kosong (tidak pre-fill) → ketik email + password → klik Login → berhasil login (jika creds benar).
- [ ] Buka DevTools (F12) → Console → tidak ada error "Assignment to constant variable" selama menggunakan RecallTape.

## Catatan

- Chrome v3.20.6 (rilis sebelumnya) sudah dapat ketiga fix ini + 2 fix tambahan (Element Blocker iconUrl, ContentGuard browser-aware alert). Dua fix tambahan tersebut **tidak relevant untuk Firefox**:
  - Element Blocker iconUrl — Firefox support SVG di notifications, jadi bug tidak ada.
  - ContentGuard browser-aware alert — text Firefox "about:addons" sudah benar.
- Diff Firefox v3.20.2 vs Chrome v3.20.6 sekarang hanya intentional Chrome MV3 adaptations (polyfill, contextMenus, sidePanel, shortcut fallback, PNG icons, helper blobToDownloadUrl, prayer/exercise/backup alarms, RF_COMMAND_FALLBACK).
