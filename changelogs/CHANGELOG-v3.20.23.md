# RecallFox v3.20.23 — Fix Definitif: Tombol Pengaturan (Gerigi) Mati di Popout Sidebar

**Release date:** 2026-08-03
**Tag:** `v3.20.23` (bug fix — lanjutan dari v3.20.22 yang masih gagal)
**Manifest version bump:** `3.20.22` → `3.20.23`

---

## TL;DR

v3.20.22 sudah coba fix tombol `#settingsBtn` di popout sidebar, **tapi user report masih gagal**. Investigasi ulang nemuin 3 masalah dengan fix v3.20.22:

1. **`browser.runtime.openOptionsPage()` bisa resolve tanpa error TAPI no-op** — bug Firefox terkenal di sidebar/iframe context. v3.20.22 cuma pakai try/catch, jadi silent failure tidak ketahuan.
2. **Deteksi iframe `window !== window.top` kurang lengkap** — native Firefox sidebar punya `window === window.top` TAPI `openOptionsPage()` tetap no-op di sana.
3. **Tidak ada feedback ke user** — saat klik gagal, toast tidak muncul, user pikir tombol "mati".

---

## Yang Diperbaiki di v3.20.23

### 1. `popup/popup.js` — Rewrite helper `openSettings()` dengan 3 lapis + verifikasi

**Strategi baru:**

| Layer | API | Kapan Dipakai |
|---|---|---|
| **A** | `browser.tabs.create({ url })` | Default — paling reliable di semua context (iframe, native sidebar, popup) |
| **B** | `browser.runtime.openOptionsPage()` | Fallback kalau A throw error (kadang works di top-level popup) |
| **C** | `browser.runtime.sendMessage({ type: 'RF_OPEN_SETTINGS_VIA_BG' })` | Last resort — background SW handle, paling reliable |

**Verifikasi tab benar-benar terbuka:**
- Snapshot `browser.tabs.query({ url: settingsUrl })` sebelum call
- Polling tiap 150ms selama 1.5 detik setelah call untuk cek tab baru muncul
- Kalau tab baru muncul → toast sukses "✓ Pengaturan terbuka di tab baru"
- Kalau belum muncul dalam 1.5 detik → fallback ke layer berikutnya

**Feedback jelas ke user:**
- Toast "⚙️ Membuka pengaturan…" saat klik (user tahu klik terdaftar)
- Toast "✓ Pengaturan terbuka di tab baru" setelah verifikasi sukses
- Toast error jelas kalau semua gagal: "⚠️ Tidak bisa buka pengaturan. Coba: klik kanan ikon RecallFox → Options..."

### 2. `background.js` — Tambah handler `RF_OPEN_SETTINGS_VIA_BG`

Last-resort fallback. Dipanggil dari popup/sidebar kalau Layer A dan B keduanya no-op.

Background Service Worker punya akses penuh ke `browser.tabs` tanpa restriction sidebar/iframe.

**Logika:**
1. Cek apakah tab settings sudah terbuka (`browser.tabs.query({ url })`)
2. Kalau sudah ada → fokus ke tab itu (`browser.tabs.update` + `browser.windows.update`)
3. Kalau belum → buat tab baru (`browser.tabs.create`)

### 3. `manifest.json` — Bump version `3.20.22` → `3.20.23`

---

## File yang Berubah

| File | Perubahan |
|---|---|
| `manifest.json` | Bump version 3.20.22 → 3.20.23 |
| `popup/popup.js` | Rewrite `openSettings()` helper (line 6037-6127) — 3 layer + verifikasi |
| `background.js` | Tambah handler `RF_OPEN_SETTINGS_VIA_BG` (line 4382-4411) |

Tidak ada perubahan di:
- `sidebar/sidebar.html` (sudah pakai popup.js via `import '../popup/popup.js'`)
- `sidebar/sidebar.js`
- `content/sidebar-cs.js`
- 6 call site yang pakai `openSettings()` — tidak perlu diubah, mereka tetap panggil `openSettings()`

---

## Skenario Test

### Test 1: Popout sidebar (iframe context)
1. Buka halaman web http(s) — mis. `https://example.com`
2. Klik tombol "rf" di floater → popout sidebar muncul (iframe)
3. Klik ikon gerigi `#settingsBtn` di header
4. **Expected:**
   - Toast "⚙️ Membuka pengaturan…" muncul instan
   - Setelah ~200ms, toast "✓ Pengaturan terbuka di tab baru"
   - Tab baru terbuka dengan URL `moz-extension://<id>/settings/settings.html`
5. **Verify di console:** Tidak ada error

### Test 2: Native Firefox sidebar (`Alt+Shift+4`)
1. Tekan `Alt+Shift+4` → sidebar RecallFox muncul (native, bukan iframe)
2. Klik ikon gerigi
3. **Expected:** Sama seperti Test 1 — tab baru terbuka dengan settings

### Test 3: Popup toolbar
1. Klik ikon RecallFox di toolbar → popup kecil muncul
2. Klik ikon gerigi
3. **Expected:** Tab baru terbuka, popup otomatis close

### Test 4: Settings sudah terbuka (dedupe)
1. Buka settings (Test 1/2/3 berhasil)
2. Buka popup/sidebar lagi, klik gerigi lagi
3. **Expected:** Tab settings yang sudah terbuka di-fokus (tidak buka tab duplikat)
   - Ini via Layer C (`RF_OPEN_SETTINGS_VIA_BG`) yang cek existing tabs duluan

### Test 5: 6 call site lain
Cek semua tombol yang pakai `openSettings()`:
- `#goSettings` (sheet "Buka di Pengaturan" — feature kosong)
- `#rfGoSettings` (tombol di settings page)
- `#askAiSetup` (Tanya AI setup button)
- `#askAiSend` (kirim tanpa AI configured)
- `#askAiSendTab` (tanya tentang tab tanpa config)

---

## Kenapa v3.20.22 Masih Gagal?

### Bug #1: `openOptionsPage()` silent no-op

```javascript
// v3.20.22 — kode lama
if (!inIframe) {
  try {
    await browser.runtime.openOptionsPage();  // ← resolve tanpa error, tapi no-op!
    return;  // ← return padahal tab tidak terbuka
  } catch (e) {
    // Tidak pernah masuk sini karena tidak throw
  }
}
```

Di Firefox 115+, `browser.runtime.openOptionsPage()` dari **native sidebar context** kadang resolve OK tanpa throw error, tapi tab settings tidak pernah terbuka. Bug Firefox terkenal.

### Bug #2: Deteksi iframe tidak lengkap

```javascript
const inIframe = (window !== window.top);  // ← true di popout, TAPI false di native sidebar
```

Di **native sidebar** (via `sidebar_action` manifest key), `window === window.top` is `true` (sidebar jalan di top-level context-nya sendiri). Tapi `openOptionsPage()` tetap no-op. Jadi kode v3.20.22 masuk branch `openOptionsPage()` yang silent gagal.

### Bug #3: Tidak ada verifikasi

v3.20.22 trust promise resolve = sukses. Padahal bug di atas bikin promise resolve tapi tidak ada efek. User tidak lihat feedback apa-apa → pikir tombol mati.

---

## v3.20.23 vs v3.20.22

| Aspek | v3.20.22 | v3.20.23 |
|---|---|---|
| Strategy utama | `openOptionsPage()` duluan | `tabs.create()` duluan (lebih reliable) |
| Deteksi context | Cuma cek `window !== window.top` | Tidak perlu deteksi — semua context pakai strategi sama |
| Verifikasi sukses | Tidak ada (trust promise) | Polling `tabs.query` 1.5s untuk pastikan tab baru muncul |
| Fallback layer | 2 layer (openOptionsPage → tabs.create) | 3 layer (tabs.create → openOptionsPage → background) |
| Feedback user | Tidak ada toast | Toast loading "⚙️ Membuka…" + toast sukses "✓ Pengaturan terbuka" |
| Last resort | Cuma `try/catch` + console.error | Background SW handler yang dedupe + force buka tab |
| Saat semua gagal | Silent failure (user bingung) | Toast error jelas + saran alternatif |

---

## Catatan Teknis

### Kenapa `tabs.create` dipilih sebagai Layer A (bukan `openOptionsPage`)?

`browser.tabs.create({ url })` dengan URL eksplisit **selalu reliable** di semua context:
- Popup toolbar: works
- Native sidebar: works
- Iframe popout sidebar: works
- Content script: works (butuh background relay)

Sedangkan `openOptionsPage()`:
- Popup toolbar: works (paling reliable)
- Native sidebar: kadang no-op (bug Firefox)
- Iframe popout sidebar: sering no-op

Karena `open_in_tab: true` di manifest, behavior `openOptionsPage()` sebenarnya sama dengan `tabs.create({ url: 'settings/settings.html' })`. Jadi tidak ada downside pakai `tabs.create` duluan.

### Kenapa perlu verifikasi polling?

Karena bug Firefox silent no-op. Promise resolve tanpa error, tapi tab tidak terbuka. Polling `tabs.query({ url })` adalah satu-satunya cara untuk **benar-benar memverifikasi** tab muncul.

1.5 detik timeout cukup — di hardware modern, `tabs.create` resolve dalam <100ms. Kalau belum muncul dalam 1.5s, kemungkinan besar memang gagal.

### Kenapa Layer C (background) perlu dedupe?

Kalau user klik settings berkali-kali cepat, atau kalau Layer A sukses tapi Layer B juga trigger (race condition), bisa terbuka multiple tab settings. Layer C cek existing tabs duluan → fokus ke yang sudah ada → hindari duplikat.

---

## Cara Update

1. Backup vault: Settings → Backup Lokal → Export (.json atau .rfvault)
2. Update addon ke v3.20.23 (via `about:debugging` → Reload temporary addon, atau install dari GitHub release)
3. Test: buka popout sidebar → klik ikon gerigi → toast "⚙️ Membuka pengaturan…" → tab baru terbuka
4. Kalau masih gagal, buka DevTools (F12) → Console → lihat error `[RecallFox] openSettings:` — kirim screenshot ke issue tracker
