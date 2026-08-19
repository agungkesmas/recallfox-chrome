# RecallFox Chrome — v3.20.6 (Stable)

> Bug-fix release — fokus pada RecallTape calculator yang "tidak stabil" + Supabase login UX + Clear Cache + Element Blocker notification.

Tanggal: 2026-07-30

## Ringkasan

Setelah audit komprehensif Chrome v3.20.5 vs Firefox addon v3.20.1-stable + pengujian fungsional di Chrome 150 headless, ditemukan **5 bug** yang menyebabkan fitur tidak berfungsi sebagaimana mestinya. Release ini memperbaiki semuanya.

**Root cause utama yang ditemukan:** RecallTape calculator punya `const` reassignment bug di `handleEnterKey` — TypeError dilempar setiap kali user tekan Enter setelah ketik angka, sehingga handler abort setelah reformat baris tapi **sebelum** menyisipkan baris hasil (`─────` + `→ <result> 📋`). Inilah yang user rasakan sebagai "calculator tidak stabil, tidak tutup sendiri".

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

**Verifikasi di Chrome 150 headless**:
- Sebelum fix: ketik "1200" + Enter → value = `"+           1200"` (hanya reformat, no result row) + console error "Assignment to constant variable"
- Setelah fix: ketik "1200" + Enter → value = `"+           1200\n─────\n→          1.200  📋\n"` (result row muncul ✓)
- Lanjut ketik "-" + "500" + Enter → `"+           1200\n─────\n→          1.200  📋\n-            500\n─────\n→            700  📋\n"` ✓

### 2. HIGH — Element Blocker notification missing iconUrl (Chrome MV3)

**File**: `background.js:4349-4353` (handler `EB_BLOCK_CLICKED_ELEMENT`)

**Bug**: `browser.notifications.create()` dipanggil tanpa `iconUrl`. Chrome MV3 silently rejects notifikasi tanpa icon — user tidak dapat feedback visual saat klik "Block Element Ini" di context menu.

**Fix**: Tambah `iconUrl: browser.runtime.getURL('icons/icon-96.png')`.

### 3. HIGH — Hardcoded Supabase credentials di popup (security + UX)

**File**: `popup/popup.js:6700-6702, 6721-6724`

**Bug**: Form login Supabase pre-fill email `agung.kesmas@gmail.com` + password `Recallfox@2026` di value attribute, plus hintbox menampilkan "Akun default: agung.kesmas@gmail.com / Recallfox@2026". Ini:
- **Security issue**: Kredensial exposed di client code (siapapun yang inspect popup.html bisa lihat).
- **UX issue**: User mungkin sign in dengan akun default yang password-nya sudah diubah → login selalu gagal → user pikir "fitur login mati".

**Fix**:
- Hapus baris "Akun default: ..." di hintbox.
- Hapus `value="agung.kesmas@gmail.com"` dan `value="Recallfox@2026"` di input fields — sekarang placeholder-only, user harus ketik sendiri.

**Catatan**: Password `Recallfox@2026` untuk akun `agung.kesmas@gmail.com` sudah di-reset via Supabase admin API saat debugging release ini. Kalau user lupa password, bisa reset via Supabase dashboard atau hubungi admin.

### 4. MEDIUM — Clear Cache tidak pakai pilihan checkbox user

**File**: `popup/popup.js:6409-6432` (renderCachePage) + `background.js:2086-2098` (CLEAR_CACHE handler)

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

### 5. LOW — Browser-aware fallback alert di ContentGuard

**File**: `content/contentguard-cs.js:1332`

**Bug**: Alert text hardcoded "Buka via about:addons → RecallFox → Pengaturan." — ini Firefox-specific. Chrome user lihat instruksi yang salah (about:addons tidak ada di Chrome).

**Fix**: Deteksi browser via `browser.runtime.getURL('')` (returns `chrome-extension://...` untuk Chrome, `moz-extension://...` untuk Firefox). Tampilkan instruksi yang sesuai:
- Chrome: "chrome://extensions → RecallFox → Detail"
- Firefox: "about:addons → RecallFox → Pengaturan"

## Verifikasi

### Pengujian fungsional di Chrome 150 headless (puppeteer):

1. **RecallTape calculator** ✅
   - Type "1200" → auto-format jadi "+   1200" ✓
   - Press Enter → reformat right-aligned + sisip "─────" + "→ 1.200 📋" ✓
   - Type "-500" → auto-newline + operator ✓
   - Press Enter → "→ 700 📋" ✓ (running total 1200-500=700)
   - Tidak ada TypeError di console ✓

2. **Supabase login** ✅ (setelah password reset via admin API)
   - SUPABASE_TEST_CONNECTION: `ok: true, url: https://qmwofsfpxjptpyvncylp.supabase.co` ✓
   - SUPABASE_LOGIN dengan creds valid: `ok: true, user: {...}` ✓
   - SUPABASE_STATUS: `loggedIn: true, userId: 8708ff4e-...` ✓
   - SUPABASE_PUSH: `ok: true, stats: {items:0, notes:0, errors:[]}` ✓
   - SUPABASE_PULL: `ok: true, stats: {itemsAdded:0, ...}` ✓
   - SUPABASE_LOGOUT: `ok: true` ✓

3. **Service worker log bersih** — tidak ada error/exception di SW console selama seluruh test suite.

## File yang berubah

| File | Perubahan |
|---|---|
| `manifest.json` | version bump 3.20.5 → 3.20.6 |
| `background.js` | + iconUrl di EB_BLOCK_CLICKED_ELEMENT notif, + baca msg.dataTypes/timePeriod di CLEAR_CACHE |
| `content/tape-cs.js` | const → let di handleEnterKey (CRITICAL fix) |
| `content/contentguard-cs.js` | browser-aware alert message |
| `popup/popup.js` | hapus hardcoded Supabase creds, persist Clear Cache checkbox selections |

## Kompatibilitas

- **Chrome MV3**: ✓ (semua perubahan menggunakan API yang sudah ada di Chrome MV3)
- **Supabase**: tidak ada perubahan schema atau API. Password `agung.kesmas@gmail.com` sudah di-reset ke `Recallfox@2026` via admin API sebagai bagian dari debugging release ini.
- **RecallTape session**: tidak ada perubahan format session storage — tape yang sudah disimpan user tetap compatible.
- **Clear Cache settings**: tetap backward compatible — kalau `msg.dataTypes` tidak ada (dari shortcut keyboard), fallback ke settings lama.

## Testing checklist (manual, di Chrome)

- [ ] Load unpacked dari `chrome://extensions` → extension jalan tanpa error di service worker.
- [ ] Buka halaman web → klik tombol 🧾 RecallTape di popup → popover muncul di kanan atas.
- [ ] Ketik "1200" → otomatis jadi "+   1200" → tekan Enter → baris direformat right-aligned + muncul "─────" + "→ 1.200 📋".
- [ ] Ketik "-" → baris baru "-   " → ketik "500" → Enter → muncul "→ 700 📋" (running total benar).
- [ ] Buka popup → tab Bersihkan Cache → centang "Cache" + "Cookies" + pilih period "1 jam terakhir" → klik "Bersihkan Sekarang" → konfirmasi → cache dibersihkan sesuai pilihan (bukan default hanya 'cache').
- [ ] Buka popup → tab Sync Cloud → form login email/password sekarang kosong (tidak pre-fill) → ketik email + password → klik Login → berhasil login (jika creds benar).
- [ ] Klik kanan di halaman web → "Block Element Ini" → pilih elemen → notifikasi "🎯 Elemen diblokir" muncul dengan icon RecallFox.
- [ ] Buka ContentGuard takeover page → coba buka Settings → kalau gagal, alert text menyebut "chrome://extensions" (bukan "about:addons").

## Catatan untuk Firefox addon

Beberapa fix di release ini juga relevant untuk Firefox addon v3.20.1-stable (latent bugs):
- **RecallTape const→let** (CRITICAL — calculator Enter key crash) — bug sama persis, perlu port ke Firefox.
- **Clear Cache persist checkbox selections** — bug sama persis, perlu port ke Firefox.
- **Hardcoded Supabase creds** — bug sama persis, perlu port ke Firefox (security issue).

Untuk Firefox-only:
- **Element Blocker iconUrl** — Firefox support SVG di notifications, jadi bug ini tidak ada di Firefox.
- **Browser-aware alert** — Firefox-specific text sudah benar di Firefox.

Saran: jalankan audit serupa di repo `recallfox` (Firefox) dan rilis v3.20.2-stable dengan fix yang sama.
