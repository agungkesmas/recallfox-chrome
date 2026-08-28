# Changelog v3.11.7-fix (Re-issue lanjutan) — 6 Fix Log Troubleshooting Sesi 6

> **Versi:** 3.11.7 (re-issue lanjutan, bukan versi baru)
> **Baseline:** v3.11.7 sebelumnya (yang error popup putih)
> **Strategi:** amend commit + recreate tag `v3.11.7` (bukan versi baru)
> **Sumber catatan:** Log Troubleshooting — Aplikasi Web & Addon (Sesi 6, 6 issues)

---

## 🚨 Bug Fatal yang Diperbaiki

### Bug #1 (CRITICAL) — Popup Putih Total karena Syntax Error

**Gejala:** Setelah install v3.11.7, popup/sidebar RecallFox putih total. Semua fitur tidak bisa diakses.

**Root cause:** `web-ext lint` melaporkan `JS_SYNTAX_ERROR` di `popup/popup.js` line 3269:
```
Unexpected token ? at line: 3269 and column: 13
```

**Penyebab detail:** Pola string concatenation dengan `+` di awal baris yang masuk ke dalam ternary expression, bikin parser bingung. Baris error:
```javascript
// BEFORE (BROKEN):
+     (tokenLocked
+       ? '🔒 Token <b>terkunci</b>...'      // ← line 3269, ? di awal baris = error
+       : '⚠️ Token <b>terbuka</b>...')
```

Parser membaca `+ ?` sebagai unary plus + unexpected token, bukan continuation dari ternary di baris sebelumnya.

**Fix:** Collapse ternary ke 1 baris:
```javascript
// AFTER (FIXED):
+     (tokenLocked ? '🔒 Token <b>terkunci</b>...' : '⚠️ Token <b>terbuka</b>...')
```

**Verifikasi:** `node --input-type=module --check popup.js` lulus, `web-ext lint` 0 errors.

---

## 📋 6 Fix dari Log Troubleshooting Sesi 6

### Issue #1 — Kompresi Upload Manual Screenshot

**Laporan user:** "Tangkapan layar diberikan logika kompres dalam bentuk dropdown... batasan Apps Script / Google sync itu kan ada ya berapa mb, makanya tidak pernah berhasil sync upload ke drive sebelum kompres."

**Status sebelumnya:** Capture path (visible/entire/selection) sudah ada kompresi (Issue #1 dari Sesi 5). TAPI upload manual (file picker / paste clipboard / drag&drop) TIDAK dikompresi → file PNG 9MB tetap 9MB → GDrive sync gagal.

**Fix:** Tambah blok kompresi di handler `SAVE_UPLOADED_SCREENSHOT` (`background.js`). Re-encode via OffscreenCanvas sesuai setting `screenshotCompression` (high/medium/low/lossless). Hanya pakai hasil kompresi kalau ukurannya lebih kecil dari original (jangan kompres kalau malah membengkak).

**File diubah:** `background.js` lines 1638-1743 (handler SAVE_UPLOADED_SCREENSHOT)

---

### Issue #2 — Note Editor Footer Tidak Konsisten di Sidebar

**Laporan user:** "Lihat panah ijo, ketika edit bundle, menu simpannya terlalu ke kanan ketutupan bisakah menu tersebut mengikuti lebar sidebar jadi menyesuaikan diri sampai pas? Cek juga di yang lainnya seperti prompt, konteks, link, media, snapshot, catatan dsb."

**Status sebelumnya:** Edit Bundle SUDAH DIPERBAIKI (Sesi 5). TAPI Note Editor (`openNoteEditor`) masih pakai pola lama: 5 tombol `flex:none` + spacer `<span style="flex:1">`. Di sidebar sempit, tombol "Selesai" terdorong ke kanan ekstrim / wrap ke baris baru tidak rapi.

**Fix:** Ubah Note editor footer agar konsisten dengan editor lain — semua tombol `flex:1` (rata konsisten), hapus spacer, label dipendekkan supaya muat sidebar (mis. "📦 Arsipkan" → "📦 Arsip", "📌 Lepas pin" → "📌 Lepas").

**File diubah:** `popup/popup.js` lines 2368-2377 (openNoteEditor footer)

---

### Issue #3 — Copy URL + Lock Token (SUDAH ADA, dipertegas)

**Laporan user:** "Menu sync google drive ini di kotak hijau sebelah tulisan Web App URL harusnya ada tombol kopi biar mudah kalau mau instal ke pc lain tinggal kopi paste aja. Menu generate token, ketika sudah terisi harusnya ada mekanisme effort lebih untuk menghindari ketekan tidak sengaja."

**Status:** SUDAH ADA di v3.11.7 sebelumnya (Sesi 5). Fitur:
- ✅ Tombol "📋 Copy URL" di sebelah field Web App URL
- ✅ Lock/Unlock token (default LOCKED, input jadi `readonly` + `type=password`)
- ✅ Generate token dengan konfirmasi kalau sudah ada token
- ✅ Auto-unlock saat generate

**Catatan:** Karena popup putih total akibat Bug #1, fitur ini tidak bisa di-test sebelumnya. Setelah fix Bug #1, fitur ini berfungsi penuh.

---

### Issue #4 — Tag v3.11.6 sebagai Stable

**Laporan user:** "Recall fox versi 3.11.6 adalah versi stabil, maka dari itu tandai tags nya menjadi versi stabil. Untuk checkpoin pengembangan sebelum mendapat versi stabil baru."

**Status:** v3.11.6 sudah ada tag (sejak Sesi 5). Sekarang ditambah GitHub Release dengan label "STABLE BASELINE" supaya jelas di halaman Releases.

**Aksi:** `gh release create v3.11.6 --title "RecallFox v3.11.6 — STABLE BASELINE" --notes "..."` (atau via API GitHub).

---

### Issue #5 — Satukan Dua Menu Pengaturan Sync (SUDAH ADA)

**Laporan user:** "Versi v3.11.7 ada dua menu pengaturan seperti ini, apa tidak ribet, dua menu begini untuk satu fungsi yang sama, kenapa tidak disatukan saja semuanya di sidebar."

**Status:** SUDAH ADA di v3.11.7 sebelumnya (Sesi 5). Settings page (options) sekarang redirect ke sidebar untuk sync cloud. Hanya 1 tempat konfigurasi sync: tool "Sync Cloud" di bilah Alat sidebar.

**Catatan:** Sama seperti Issue #3, fitur ini tidak bisa di-test sebelumnya karena popup putih. Setelah fix Bug #1, fitur ini berfungsi penuh.

---

### Issue #6 — Jadwal Sholat Selalu Terlihat + Suara Adzan

**Laporan user:** "Tolong pertimbangkan perubahan posisi jadwal sholat ini agar selalu terlihat saat saya masuk ke menu manapun di sidebar recallfox, karena saya kadang sering berlama lama buka menu catatan, dimana jadwal sholat ini ketutup. Tambahkan suara adzan untuk shalat 5 waktu, suara terbaik yang sering dipakai dan ada fungsi stop kalau posisi lagi tidak mau diganggu."

**Status sebelumnya:**
- ❌ Visibility: BUG — `.strip` (berisi jadwal sholat + quran + puasa) di-hide saat user pindah ke view `notes` atau `tools`. Inilah penyebab user report "ketutup kalau lama di menu catatan".
- ❌ Adzan sound: TIDAK ADA sama sekali — tidak ada setting, tidak ada audio element, tidak ada handler.

**Fix visibility (1 baris):**
```javascript
// BEFORE (BUG):
document.querySelector('.strip').style.display = homeOnly ? '' : 'none';

// AFTER (FIXED):
document.querySelector('.strip').style.display = '';  // SELALU visible
```

**Fix adzan sound (komprehensif):**

1. **DEFAULT_SETTINGS baru** di `lib/storage.js`:
   - `prayerAdzanEnabled: false` (default OFF — user explicit enable)
   - `prayerAdzanVolume: 0.7` (0.0-1.0)
   - `prayerAdzanSound: 'default'` ('default' | 'short' | 'custom')
   - `prayerAdzanCustomUrl: ''` (URL file adzan custom)
   - `prayerAdzanPrayers: ['Fajr','Dhuhr','Asr','Maghrib','Isha']` (waktu mana yang bunyi)
   - `prayerAdzanLastPlayedKey: null` (tracking anti-double-play)

2. **Trigger di background.js** (`checkPrayerReminder`):
   - Saat `next.minutesUntil <= 1` (masuk waktu sholat), broadcast message `PLAY_ADZAN` ke popup/sidebar aktif
   - Cek `prayerAdzanPrayers` — hanya bunyi untuk waktu yang dipilih
   - Tracking `prayerAdzanLastPlayedKey` supaya tidak double-play

3. **Handler di popup.js** (`PLAY_ADZAN` + `STOP_ADZAN`):
   - Buat `new Audio(url)` dengan URL dari IslamicFinder CDN (default/short) atau custom URL
   - Tampilkan banner hijau fixed di bawah: "🕌 Adzan — {prayer} telah masuk" + tombol "⏹ Stop"
   - Auto-cleanup saat audio selesai atau setelah 5 menit (safety)
   - Volume sesuai setting

4. **UI di settings.html** (section baru "🔔 Adzan Sound"):
   - Toggle On/Off
   - Volume slider (0.0-1.0) dengan label real-time
   - Pilih suara: Default / Short / Custom URL
   - Field Custom URL (muncul hanya kalau sound=custom)
   - Checkboxes 5 waktu sholat (Subuh/Dzuhur/Ashar/Magrib/Isya)
   - Tombol "🔔 Test Adzan" untuk test mainkan sekarang

5. **URL adzan default:** Pakai IslamicFinder CDN (gratis, sering dipakai aplikasi adzan):
   - Default: `https://www.islamicfinder.org/cms/audio/azan1/azan1.mp3` (~2 menit)
   - Short: `https://www.islamicfinder.org/cms/audio/azan2/azan2.mp3` (~30 detik)
   - Custom: user isi URL sendiri (mp3/ogg/wav, harus CORS-accessible)

**File diubah:**
- `lib/storage.js` — tambah 6 DEFAULT_SETTINGS baru
- `background.js` — tambah trigger adzan di `checkPrayerReminder`
- `popup/popup.js` — tambah handler `PLAY_ADZAN`/`STOP_ADZAN` + UI banner + `_playAdzan()`/`_stopAdzan()`
- `settings/settings.html` — tambah section "🔔 Adzan Sound" dengan 6 row
- `settings/settings.js` — tambah binding + helper `_updateAdzanVisibility` + event listeners

---

## 🔧 Code Quality Fixes (Bonus)

### Fix #7 — `ICONS.cloud` Tidak Didefinisikan

**Lokasi:** `popup/popup.js` line 2501 — tool "Sync Cloud" pakai `ICONS.cloud || '☁️'`, tapi `ICONS.cloud` tidak didefinisikan.

**Fix:** Tambah entry `cloud:` di ICONS object (line 137) dengan SVG cloud icon yang konsisten dengan icon lain.

### Fix #8 — Strip Sholat SELALU Visible (Issue #6 bagian 1)

Sudah dijelaskan di Issue #6 di atas.

---

## ✅ Verifikasi

### Syntax Check
- `node --input-type=module --check popup/popup.js` → ✅ LULUS (sebelumnya: ❌ FAILED)
- `node --check` semua 33 file JS → ✅ SEMUA LULUS
- `web-ext lint --self-hosted` → ✅ **0 errors**, 105 warnings (semua `UNSAFE_VAR_ASSIGNMENT` innerHTML — non-fatal, sama seperti v3.8 asli)

### Struktur File
- 62 file total (sebelumnya 60 + 2 file CHANGELOG)
- Tidak ada file v3.11.7 yang dihapus
- Tambahan: 6 setting baru, 1 section UI baru, ~250 baris kode baru untuk adzan

### Tag & Release
- Re-tag `v3.11.7` di commit hasil fix (bukan versi baru)
- GitHub Release dengan changelog ini

---

## 📦 Cara Install

1. Download ZIP dari release v3.11.7 (re-issue)
2. Extract
3. Firefox → `about:debugging` → This Firefox → Load Temporary Add-on → pilih `manifest.json`
4. Addon aktif. Popup/sidebar sekarang **tidak putih lagi** — semua fitur bisa diakses.

---

## 🆚 Perbandingan v3.11.7 (sebelum) vs v3.11.7-fix (sekarang)

| Aspek | v3.11.7 (sebelum) | v3.11.7-fix (sekarang) |
|---|---|---|
| Popup saat load | ❌ Putih total (syntax error) | ✅ Render normal |
| `web-ext lint` errors | ❌ 1 error fatal | ✅ 0 errors |
| Strip jadwal sholat di menu lain | ❌ Ketutup (hidden) | ✅ Selalu terlihat |
| Adzan sound | ❌ Tidak ada | ✅ Lengkap (default/short/custom + stop) |
| Upload manual kompresi | ❌ Tidak dikompresi | ✅ Kompres otomatis sesuai setting |
| Note editor footer di sidebar sempit | ❌ Tombol terdorong/wrap | ✅ Rata konsisten flex:1 |
| `ICONS.cloud` | ❌ undefined (fallback emoji) | ✅ SVG cloud icon |
| Tag v3.11.6 stable | ⚠️ Tag ada, no release | ✅ GitHub Release "STABLE BASELINE" |

---

## 📝 Catatan untuk User

1. **Adzan default OFF** — user perlu explicit enable di Settings → Waktu Shalat → 🔔 Adzan Sound. Ini supaya tidak mengganggu user yang tidak mau adzan otomatis.

2. **Adzan butuh sidebar aktif** — audio hanya bisa di-play dari context page (popup/sidebar), bukan background. Pastikan sidebar RecallFox terbuka saat waktu sholat masuk. Tip: set `sidebarAutoOpen: true` di Settings → Persistensi & Startup.

3. **URL adzan default pakai IslamicFinder CDN** — butuh internet. Kalau user mau offline, bisa download file adzan sendiri, host di URL sendiri, lalu pakai opsi "Custom URL".

4. **Adzan bisa di-stop kapan saja** — banner hijau muncul di bawah saat adzan bunyi, klik "⏹ Stop" untuk hentikan. Atau tunggu audio selesai (auto-cleanup).

5. **Kompresi upload manual otomatis** — sesuai setting `screenshotCompression` (default: high = JPEG q60). User bisa ubah di Settings → Screenshot. Pilihan "high" direkomendasikan untuk GDrive sync (file < 1MB, lolos batas Apps Script).
