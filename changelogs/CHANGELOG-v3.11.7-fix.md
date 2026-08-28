# Changelog v3.11.7 (Re-issue) — Penyempurnaan dari v3.11.6 + 6 Fix Log Troubleshooting Sesi 5

> **Versi:** 3.11.7 (re-issue, bukan versi baru)
> **Baseline:** v3.11.6 (ditandai sebagai **STABLE**)
> **Strategi:** amend commit `9faba8d` + recreate tag `v3.11.7`
> **Sumber catatan:** Log Troubleshooting — Aplikasi Web & Addon (Sesi 5, 6 issues)

---

## 📋 Catatan Perbaikan dari v3.11.6 (Stable Baseline)

v3.11.6 adalah versi stabil terakhir sebelum v3.11.7. Berikut adalah ringkasan
apa yang dibawa dari v3.11.6 (yang menjadi dasar v3.11.7 re-issue ini):

- ✅ Salin dari Vault ke clipboard (1 klik)
- ✅ Editor pintasan web (custom shortcut untuk ngaji/olahraga)
- ✅ Sidebar responsive collapse (w-sm, w-xs, w-xxs)
- ✅ Notes bar flat 1-row dengan flex-wrap
- ✅ Tools header compact + tool pin/hide/reorder

v3.11.7 re-issue ini **menambahkan** fitur Multi-PC Bidirectional Sync dari
versi v3.11.7 original, **PLUS** 6 fix dari Log Troubleshooting Sesi 5.

---

## 🐛 6 Fix dari Log Troubleshooting Sesi 5

### Issue #1 — Dropdown Kompresi Screenshot (sedikit/sedang/tinggi)

**Sebelumnya:** User pakai format PNG (lossless) atau JPEG dengan quality 90.
Screenshot full-page bisa 5–20 MB. Upload ke GDrive sering gagal karena
limit Apps Script Web App ~10 MB per POST request.

**Sekarang:** 1 dropdown "Tingkat Kompresi" menggantikan 2 field (Format + Quality):

| Tingkat | Format | Quality | Estimasi ukuran | Cocok untuk |
|---------|--------|---------|-----------------|-------------|
| Lossless | PNG | 100% | puluhan MB | Kualitas maksimal, GDrive bisa gagal |
| Sedikit | JPEG | 90 | 1–3 MB | Kualitas tinggi, GDrive OK |
| Sedang | JPEG | 75 | 500 KB – 1.5 MB | Balance |
| **Tinggi** (DEFAULT) | JPEG | 60 | 200–800 KB | **Recommended** untuk GDrive sync |

**Default** diubah ke "Tinggi" supaya upload GDrive selalu berhasil.

**Perubahan kode:**
- `lib/storage.js`: Tambah setting `screenshotCompression: 'high'` (default). Hapus default `screenshotFormat: 'png'` → `jpeg`, `screenshotJpegQuality: 90` → `60`.
- `background.js`: `captureFullPage()` baca `screenshotCompression` dulu, lalu map ke format+quality via switch.
- `settings/settings.html`: Ganti 2 field (Format + Kualitas JPEG) → 1 dropdown "Tingkat kompresi gambar".
- `settings/settings.js`: Update `setVal` + binding array.
- `popup/popup.js`: Tambah `openShotPickerSheet()` — sheet pilih mode + tingkat kompresi sebelum capture. doShot tanpa mode sekarang buka picker.

---

### Issue #2 — Lebar Sheet Editor Menyesuaikan Sidebar

**Sebelumnya:** Di sidebar mode (lebar > 340px), sheet editor (terutama Edit Bundle)
melebar penuh. Tombol "Simpan" terdorong ke kanan ekstrim karena:
1. CSS `.btn-row .btn { flex:1 }` + spacer inline `style="flex:1"` di Edit Bundle bikin
   tombol terpisah jauh.
2. Sheet pakai `position:absolute; left:0; right:0` tanpa max-width.

**Sekarang:**
- Sheet di sidebar mode dibatasi `max-width: 560px` + `transform: translate(-50%, ...)` centered.
- Page (slide-in catatan editor) juga dibatasi `max-width: 560px` untuk header/body/footer.
- Edit Bundle: hapus spacer `style="flex:1"`, pakai 3 tombol flex:1 yang merata (Arsipkan | Batal | Simpan).
- `.page-foot` sekarang `flex-wrap: wrap` supaya tombol wrap bila sempit.

**Perubahan kode:**
- `popup/popup.css`: Tambah `body.rf-sidebar-body .sheet { max-width:560px; ... }` + `.page-foot { flex-wrap: wrap }`.
- `popup/popup.js`: Hapus spacer di `openBundleEditorSheet`.

---

### Issue #3 — Copy URL Web App + Lock Token

**Sebelumnya:**
- Web App URL tidak ada tombol copy — user harus select-all + Ctrl+C manual.
- Token bisa diedit sembarang (rentan ketimpa tidak sengaja, terutama kalau
  user klik 🎲 Generate padahal token sudah ada).

**Sekarang:**
- Tambah tombol **📋 Copy URL** di samping input Web App URL. Klik → URL disalin
  ke clipboard → tinggal paste di PC lain.
- Tambah tombol **🔒 Lock / 🔓 Unlock** untuk token. Default LOCKED (read-only).
  Untuk edit token, user harus klik Unlock dulu.
- Tombol **🎲 Generate** sekarang **butuh konfirmasi** kalau sudah ada token:
  "Token sudah ada. Yakin generate token baru? Token lama: rf-xxx... Token baru
  akan MENGUBAH token di addon. Pastikan Anda juga update AUTH_TOKEN di Code.gs
  Apps Script dan deploy ulang."
- Saat klik Generate, auto-unlock token supaya bisa diisi.

**Perubahan kode:**
- `lib/storage.js`: Tambah setting `gdriveTokenLocked: true` (default locked).
- `popup/popup.js`: `renderGDrivePage()` — tambah tombol Copy URL, Lock/Unlock, konfirmasi Generate.

---

### Issue #4 — Tag v3.11.6 sebagai STABLE

v3.11.6 (commit `0c9225a`) ditandai sebagai **release stabil** via GitHub Release
dengan label "Stable". Ini jadi checkpoint pengembangan sebelum mencapai versi
stabil baru.

**Aksi:** Buat GitHub Release untuk tag `v3.11.6` dengan:
- Name: "RecallFox v3.11.6 — STABLE BASELINE"
- Body: ringkasan fitur + catatan bahwa ini versi stabil untuk production
- Prerelease: false (sudah stabil)

---

### Issue #5 — Satukan Pengaturan Sync di Sidebar

**Sebelumnya (v3.11.7 original):** Pengaturan sync **terdobel** di 2 tempat:
1. **Sidebar/popup** → "Sync GDrive" (konfigurasi URL+Token, Test Koneksi, Full Backup, sync real-time)
2. **Settings page (Options)** → "Multi-PC Sync (Beta)" (auto-sync, Push, Pull, Sync Full, Kelola Profile modal)

User harus buka 2 tempat berbeda untuk fungsi yang sama (URL+Token sama). Ribet.

**Sekarang:** Semua pengaturan sync **disatukan di sidebar** (RecallFox Vault → Alat → Sync Cloud):

**Section 1 — Status (gabungan GDrive + Multi-PC)**
Tampilan status real-time untuk GDrive Sync (queue, total synced, last sync) dan
Multi-PC Sync (profile aktif, last sync direction).

**Section 2 — Konfigurasi (URL + Token + Copy URL + Lock Token)**
Satu set URL + Token dipakai untuk GDrive Sync & Multi-PC Sync.

**Section 3 — Aksi Cepat (1 klik)**
- 🔗 Test Koneksi
- 🔄 Sync Sekarang (GDrive queue)
- 💾 Full Backup ke GDrive (one-time)
- 🔄 Sync Full Multi-PC (push+pull bidirectional)
- 📤 Push (Multi-PC)
- 📥 Pull (Multi-PC)
- 🗑 Reset Queue GDrive

**Section 4 — Multi-PC Profile Manager (inline, bukan modal)**
List profile + form tambah profile + tombol Test/Aktifkan/Hapus — semua inline.

**Section 5 — Opsi Sync**
Toggle: GDrive real-time on save, GDrive upload screenshot, Multi-PC auto-sync (30s),
auto-sync GDrive saat backup lokal, interval flush periodik.

**Section 6 — Panduan Setup Detil (Step-by-Step)**
Penjelasan detil perbedaan GDrive Sync vs Multi-PC Sync, setup PC pertama (3 langkah),
setup PC kedua (3 langkah), dan 11 langkah deploy Apps Script Web App.

**Di Settings page:** Section "Sync Cloud" sekarang hanya berisi penjelasan
perbedaan GDrive Sync vs Multi-PC Sync + tombol "🦊 Buka Sidebar" yang membuka
sidebar RecallFox dan mengarahkan user ke Alat → Sync Cloud.

**Perubahan kode:**
- `settings/settings.html`: Hapus section Multi-PC Sync + modal → ganti dengan info card + tombol redirect.
- `settings/settings.js`: Hapus `initMultiPCSync`, `doSyncAction`, `openSyncProfileManager`, `renderSyncProfileList`, `addProfileFromForm`, `testProfileFromForm` → ganti dengan `initSidebarSyncRedirect`.
- `popup/popup.js`: Rewrite `renderGDrivePage()` jadi "Sync Cloud Dashboard" terintegrasi. Tambah helpers `_doMultiPcSync`, `_renderSyncProfileListInline`, `_addSyncProfileInline`, `_testSyncProfileInline`.

---

### Issue #6 — Amend Commit + Recreate Tag v3.11.7

**Strategi (sesuai instruksi user):**
1. Bekerja di atas v3.11.7 (commit `9faba8d`).
2. Apply semua 5 fix di atas (Issue #1–#5).
3. **Amend** commit `9faba8d` dengan pesan baru yang menjelaskan 6 fix.
4. Hapus tag `v3.11.7` lama (lokal + remote).
5. Recreate tag `v3.11.7` di commit hasil amend.
6. Force-push ke `main` + push tag baru.
7. Hapus GitHub Release v3.11.7 lama (kalau ada) → buat release baru.

**Hasil:** Tag `v3.11.7` sekarang menunjuk ke commit yang sudah disempurnakan,
bukan commit `9faba8d` yang punya bug "pengaturan terdobel".

---

## File yang Diubah (v3.11.7 re-issue)

| File | Jenis | Ringkasan |
|---|---|---|
| `lib/storage.js` | Modify | Tambah `screenshotCompression: 'high'`, `gdriveTokenLocked: true`. Update default format/quality. |
| `background.js` | Modify | `captureFullPage()` baca `screenshotCompression` → map ke format+quality via switch. |
| `settings/settings.html` | Modify | Ganti 2 field format/quality → 1 dropdown kompresi. Hapus section Multi-PC Sync + modal → ganti dengan info card + tombol Buka Sidebar. |
| `settings/settings.js` | Modify | Update binding screenshot. Hapus 5 fungsi Multi-PC Sync → ganti dengan `initSidebarSyncRedirect`. |
| `popup/popup.js` | Modify | Tambah `openShotPickerSheet()`. Rewrite `renderGDrivePage()` jadi Sync Cloud Dashboard terintegrasi dengan Copy URL + Lock Token + Multi-PC Sync inline. Tambah 4 helper fungsi. Hapus spacer di `openBundleEditorSheet`. Update label tool "gdrive" → "Sync Cloud". |
| `popup/popup.css` | Modify | Tambah `body.rf-sidebar-body .sheet { max-width:560px; ... }` + page max-width + `.page-foot { flex-wrap }`. |
| `CHANGELOG-v3.11.7-fix.md` | **NEW** | File ini. |

---

## Testing Checklist

- [ ] Load addon di Firefox (`about:debugging` → Load Temporary Add-on → `manifest.json`)
- [ ] Cek versi: 3.11.7 (re-issue)
- [ ] **Issue #1 — Kompresi screenshot**:
  - [ ] Buka Settings → Screenshot → ada dropdown "Tingkat kompresi gambar" (tidak ada lagi Format + Quality terpisah)
  - [ ] Default = "Tinggi (JPEG q60)"
  - [ ] Klik tombol Shot di sidebar → muncul sheet picker dengan mode + tingkat kompresi
  - [ ] Capture screenshot → cek file size < 1 MB (kompresi tinggi)
  - [ ] Upload ke GDrive → berhasil (tidak PAYLOAD_TOO_LARGE)
- [ ] **Issue #2 — Lebar sheet**:
  - [ ] Buka sidebar (lebar ~500px) → Edit Bundle → tombol "Arsipkan | Batal | Simpan" terlihat rapi (tidak terdorong ke kanan)
  - [ ] Sheet centered dengan max-width 560px (tidak melebar penuh)
  - [ ] Buka catatan editor (slide-in page) → header/body/footer rapi
- [ ] **Issue #3 — Copy URL + Lock Token**:
  - [ ] Buka Alat → Sync Cloud → ada tombol "📋 Copy URL" di samping input URL
  - [ ] Klik Copy URL → URL tercopy ke clipboard
  - [ ] Token default LOCKED (read-only, type=password)
  - [ ] Klik 🔓 Unlock → token bisa diedit (type=text, tidak readonly)
  - [ ] Klik 🔒 Lock → token kembali read-only
  - [ ] Klik 🎲 Generate dengan token sudah ada → muncul konfirmasi
- [ ] **Issue #4 — v3.11.6 stable**:
  - [ ] Cek GitHub Releases: v3.11.6 ada label "Stable"
- [ ] **Issue #5 — Pengaturan disatukan**:
  - [ ] Buka Settings (Options page) → section "Sync Cloud" hanya info + tombol "🦊 Buka Sidebar"
  - [ ] Tidak ada lagi section "Multi-PC Sync (Beta)" dengan Push/Pull/Sync di Settings
  - [ ] Buka sidebar → Alat → "Sync Cloud" → semua operasi sync ada di sini:
    - [ ] Konfigurasi URL+Token (dengan Copy URL + Lock Token)
    - [ ] Aksi: Test, Sync Now, Full Backup, Push, Pull, Sync Full Multi-PC, Reset Queue
    - [ ] Profile Manager inline (list + form tambah + Test/Aktifkan/Hapus)
    - [ ] Opsi: real-time on save, upload screenshot, auto-sync Multi-PC, auto-backup, interval
    - [ ] Panduan setup detil (perbedaan GDrive vs Multi-PC, setup PC-1, setup PC-2, 11 langkah)
- [ ] **Issue #6 — Tag v3.11.7 re-issue**:
  - [ ] `git log` menunjukkan commit terakhir dengan pesan "RecallFox v3.11.7 (re-issue) — 6 fix..."
  - [ ] `git tag v3.11.7` menunjuk ke commit hasil amend (bukan `9faba8d`)
  - [ ] GitHub Release v3.11.7 baru ada dengan body yang updated

---

**Status:** Semua 6 fix selesai ✓ · **Baseline:** v3.11.6 (stable) · **Strategi:** amend + recreate tag
