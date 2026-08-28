# v3.20.15 — OmniRouter provider support (input API key sekali, route ke 290+ provider)

> **Tanggal:** 2026-08-02
> **Tipe:** Feature
> **Tag:** `v3.20.15`, `v3.20.15-stable`

## Ringkasan

Tambah **OmniRouter** sebagai opsi provider AI di Settings → AI Assistant.
OmniRouter = gateway OpenAI-compatible yang ngeroute request ke 290+ provider
(90+ dengan free tier) lewat satu endpoint. Solusi buat user yang capek
gonta-ganti API key Groq/Gemini/OpenAI karena quota habis.

> **Link referensi OmniRouter:**
> - GitHub: https://github.com/diegosouzapw/OmniRoute
> - Cloud dashboard: https://omniroute.online
> - Default local endpoint: `http://localhost:20128/v1`

## Perubahan

### 1. `lib/assistant.js` — PROVIDERS config

Tambah entry `omnirouter`:

```js
omnirouter: {
  name: 'OmniRouter (multi-provider gateway, 90+ free)',
  defaultBaseUrl: 'http://localhost:20128/v1',
  defaultModel: 'auto',
  authHeader: 'Bearer',
  endpoint: '/chat/completions',
  alwaysShowBaseUrl: true   // selalu tampil di Settings (URL bisa local/cloud)
}
```

### 2. `lib/assistant.js` — `chat()` function

- Skip `NO_API_KEY` check untuk provider `omnirouter` (local free mode tanpa auth).
- Hanya kirim `Authorization: Bearer ...` header kalau API key diisi.

### 3. `lib/assistant.js` — `isAssistantConfigured()` & `isFallbackConfigured()`

- Untuk `omnirouter`, return `true` cukup kalau base URL ada (API key opsional).
- Provider lain tetap require API key (behavior lama).

### 4. `settings/settings.html`

- Tambah `<option value="omnirouter">` di dropdown Provider Utama & Provider Fallback.
- Tambah section help "OmniRouter (multi-provider gateway, 90+ free)" di
  `<details>` "Cara dapat API Key" — menjelaskan:
  - Local mode: `npm i -g omniroute && omniroute`, endpoint `http://localhost:20128/v1`, tanpa API key untuk provider free.
  - Cloud mode: daftar di `https://omniroute.online`, isi API key dari dashboard, ganti Base URL.
  - Model variants: `auto`, `auto/coding`, `auto/fast`, `auto/cheap`, `auto/offline`, `auto/smart`.

### 5. `settings/settings.js` — `updateAssistantBaseUrlVisibility()` & `updateAssistantFallbackBaseUrlVisibility()`

- Tampilkan Base URL field juga untuk provider dengan `alwaysShowBaseUrl=true`
  (sebelumnya hanya untuk `custom`).
- Update placeholder Base URL field sesuai provider aktif supaya user tahu
  default URL yang dipakai kalau field dikosongkan.

### 6. `manifest.json`

- Bump version: `3.20.14` → `3.20.15`.
- Tidak perlu tambah `host_permissions` karena `<all_urls>` sudah ada (bisa
  akses `http://localhost:20128/*` & URL cloud OmniRouter).

## Cara pakai (user perspective)

### Mode A: Local (recommended untuk desktop)

1. Install OmniRouter di komputer:
   ```bash
   npm i -g omniroute
   omniroute
   ```
   Server jalan di `http://localhost:20128/v1`.
2. Buka RecallFox Settings → AI Assistant.
3. Pilih Provider: **OmniRouter**.
4. Base URL: biarkan default `http://localhost:20128/v1`.
5. API Key: **kosongkan** (cukup pakai provider free built-in).
6. Model: biarkan default `auto` (atau pilih variant seperti `auto/coding`).
7. Save. Test chat dengan Si Pandai di popup.

### Mode B: Cloud

1. Daftar di https://omniroute.online, dapat API key dari dashboard.
2. Buka RecallFox Settings → AI Assistant.
3. Pilih Provider: **OmniRouter**.
4. Base URL: ganti ke URL cloud yang diberikan dashboard.
5. API Key: paste key dari dashboard.
6. Model: `auto` atau variant.
7. Save.

### Sebagai Fallback

1. Settings → AI Assistant → aktifkan Fallback.
2. Pilih Provider Fallback: **OmniRouter**.
3. Isi Base URL + API Key (kalau cloud) atau biarkan default (local).
4. Save.

Sekarang kalau Groq/Gemini down atau quota habis, request otomatis fallback ke
OmniRouter yang punya 90+ free provider cadangan.

## Catatan teknis

- OmniRouter API 100% OpenAI-compatible (`POST /v1/chat/completions`, body sama
  persis, response format sama). Tidak perlu adapter khusus — pakai code path
  yang sama dengan Groq/Gemini/OpenAI.
- Custom headers OmniRouter (`X-OmniRoute-*`) tidak dipakai di RecallFox karena
  tidak diperlukan untuk basic chat. Cost telemetry & routing decisions tetap
  di-response header kalau user mau inspect.
- `auto` model = OmniRouter pilih model terbaik otomatis (LKGP — Last Known
  Good Path, sticky ke provider yang terakhir sukses).
- `alwaysShowBaseUrl: true` flag baru di PROVIDERS config — supaya Base URL
  field selalu tampil untuk provider yang URL-nya bisa berbeda per install
  (OmniRouter local vs cloud).

## Test plan

- [ ] Settings → pilih Provider "OmniRouter" → Base URL field muncul dengan
      placeholder `http://localhost:20128/v1` → API Key kosong → Save →
      tidak ada error "API key wajib".
- [ ] Jalankan `omniroute` di lokal → chat Si Pandai "halo" → jawab normal.
- [ ] Settings → pilih Provider "Groq" → Base URL field hilang → Save.
- [ ] Settings → aktifkan Fallback → pilih "OmniRouter" → Base URL field
      fallback muncul → Save.
- [ ] Matikan Groq (key salah) → chat → otomatis fallback ke OmniRouter.
- [ ] Cloud mode: ganti Base URL ke URL cloud OmniRouter + isi API key → chat
      berhasil.
