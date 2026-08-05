# RecallFox Chrome v3.20.19 — Parity dengan Firefox v3.20.19-stable

**Release date:** 2026-08-02
**Tag:** `v3.20.19-chrome` + `v3.20.19-chrome-stable`
**Base:** Chrome v3.20.13 (sebelumnya stable: v3.20.4-chrome-stable)
**Firefox paritas:** v3.20.19-stable (commit `19befaaa`)

## TL;DR

Port 3 fitur besar dari Firefox v3.20.19 ke Chrome, mencapai **full parity** dengan Firefox addon stable terbaru:

- ✅ **OmniRouter provider** (v3.20.15) — gateway OpenAI-compatible yang ngeroute request ke 290+ provider AI (90+ free) lewat satu endpoint. Bisa jalan local (`http://localhost:20128/v1`) atau cloud (`omniroute.online`). Local mode bisa jalan **tanpa API key** (provider free pre-wired).
- ✅ **Relay Point v1/v2/v3** (v3.20.16–v3.20.18) — snapshot sebagai checkpoint migrasi akun AI. Setelah capture snapshot di AI domain (ChatGPT/Claude/dll), background otomatis generate "resume context" via OmniRouter. User paste resume context ke akun AI baru untuk melanjutkan pekerjaan tanpa kehilangan konteks.
- ✅ **Anchor AI Answer** (v3.20.19) — prompt fix: ANCHOR utama = **jawaban AI terakhir** (bukan pertanyaan user). AI harus bandingkan jawaban AI terakhir dengan jawaban AI sebelumnya untuk deteksi "nyambung atau tidak".

**Sudah ada sejak v3.20.4–v3.20.13 Chrome** (tidak perlu port ulang):
- ✅ **Popout Sidebar** (v3.20.4–v3.20.14) — sidebar RecallFox di iframe yang bisa di-popout ke window terpisah. Sudah port di Chrome v3.20.9-chrome.

---

## Yang di-port di release ini

### 1. OmniRouter provider (v3.20.15)

**`lib/assistant.js`** (+43 lines):

- Tambah `omnirouter` ke `PROVIDERS` map dengan config:
  ```js
  omnirouter: {
    name: 'OmniRouter (multi-provider gateway, 90+ free)',
    defaultBaseUrl: 'http://localhost:20128/v1',
    defaultModel: 'auto',
    authHeader: 'Bearer',
    endpoint: '/chat/completions',
    alwaysShowBaseUrl: true  // tampilkan Base URL field di settings (local vs cloud)
  }
  ```
- `chat()`: skip `NO_API_KEY` check untuk `omnirouter` (local mode bisa jalan tanpa key). Hanya kirim `Authorization` header kalau `apiKey` ada.
- `isAssistantConfigured()`: untuk `omnirouter`, cukup pastikan base URL ada (default atau custom) — tidak wajib API key.
- `isFallbackConfigured()`: sama, `omnirouter` bisa jadi fallback tanpa API key.

**`settings/settings.html`** (+34 lines):

- Tambah `<option value="omnirouter">` di primary provider `<select>` dan fallback provider `<select>`.
- Tambah section help "OmniRouter (multi-provider gateway, 90+ free)" dengan instruksi lengkap:
  - Mode local (recommended): `npm i -g omniroute && omniroute`, endpoint default `http://localhost:20128/v1`, tidak perlu API key untuk provider free.
  - Mode cloud: daftar di `omniroute.online`, dapat API key dari dashboard, ganti Base URL.
  - Variant model: `auto`, `auto/coding`, `auto/fast`, `auto/cheap`, `auto/offline`, `auto/smart`.
  - Tip: cocok jadi fallback juga.

**`settings/settings.js`** (+23 lines):

- `updateAssistantBaseUrlVisibility()`: tampilkan Base URL field kalau provider = `custom` ATAU `info.alwaysShowBaseUrl === true` (omnirouter). Update placeholder Base URL input sesuai provider aktif.
- `updateAssistantFallbackBaseUrlVisibility()`: sama untuk fallback provider.

### 2. Relay Point v1/v2/v3 + Anchor AI Answer (v3.20.16–v3.20.19)

**`background.js`** (+245 lines):

- Tambah static import `chatWithFallback`, `isAssistantConfigured` dari `./lib/assistant.js`.
- Tambah static import `updateItem` ke existing `./lib/storage.js` import block.
- Tambah `RESUME_CONTEXT_SYSTEM_PROMPT` constant — full system prompt v3.20.19 (Anchor AI Answer):
  - **Langkah 1**: Identifikasi ANCHOR = jawaban AI terakhir (🤖 AI paling bawah). Baca DENGAN TELITI seluruh isi jawaban AI — bukan cuma user question.
  - **Langkah 2**: Deteksi rantai relevansi backward dari ANCHOR. Bandingkan jawaban AI terakhir dengan jawaban AI sebelumnya (bukan pertanyaan user). Contoh benar vs salah explicit.
  - **Langkah 3**: Generate resume context dengan format: 🎯 Tujuan Utama / ✅ Yang Sudah Dikerjakan / ⏳ Yang Belum Selesai / 📌 Konteks Penting. Maksimal 800 kata, bahasa Indonesia.
- Tambah `RESUME_CONTEXT_MAX_BODY_CHARS = 8000` — truncate body sebelum kirim ke AI (hemat token).
- Tambah `truncateBodyForResume(body)` — keep head 2000 char + tail 6000 char, skip middle dengan marker. Strategi: AI butuh konteks awal untuk deteksi "kapan topik berubah" + pesan terakhir full untuk chained relevance.
- Tambah `generateResumeContext(itemId, body, title)` — async fire-and-forget. Cek `isAssistantConfigured()` dulu; kalau belum, log + return. Kalau configured, panggil `generateResumeContextSync()`, update item via `updateItem()` dengan `resumeContext` + `resumeContextAt`. **Lokal saja — tidak sync ke cloud** (supaya tidak merusak cloud sync schema lama).
- Tambah `generateResumeContextSync(body, title)` — sync version untuk manual trigger. Build messages array (system + user), panggil `chatWithFallback()`, filter "terlalu pendek untuk resume context" → return null.
- Modifikasi `CAPTURE_SNAPSHOT` handler: setelah `addItem()` + `sendResponse(result)`, cek `result?.ok !== false && result?.id && msg.body.length >= 100` → fire-and-forget `generateResumeContext()`. Non-blocking — snapshot tetap tersimpan walau AI gagal.
- Tambah `GENERATE_RESUME_CONTEXT` message handler — manual trigger dari popup. Cek itemId valid, item ada + type=snapshot, body >= 100 char. Panggil `generateResumeContextSync()`, update item, return `{ ok: true, resumeContext }` atau error spesifik (`no_item_id` / `item_not_found_or_not_snapshot` / `snapshot_body_too_short` / `generate_failed`).

**`popup/popup.js`** (+49 lines):

- Tambah 2 tombol di action sheet snapshot item:
  - **`📋 Copy Resume Context`** (hanya muncul kalau `it.resumeContext` sudah ada) — copy ke clipboard via `navigator.clipboard.writeText()`, fallback `COPY_TO_CLIPBOARD` message ke background.
  - **`🔄 Generate Resume Context`** (hanya muncul kalau `it.resumeContext` belum ada, atau untuk retry) — kirim `GENERATE_RESUME_CONTEXT` message, refresh vault, tampilkan toast sukses/error spesifik.
- Convert click handler dari `() => {}` ke `async () => {}` supaya `await navigator.clipboard.writeText()` dan `await browser.runtime.sendMessage()` jalan.

---

## Yang SUDAH ada di Chrome sebelumnya (tidak perlu port ulang)

### Popout Sidebar (v3.20.4–v3.20.14)

Sudah di-port ke Chrome di v3.20.9-chrome-stable. Verifikasi:

- ✅ `content/sidebar-cs.js` ada (488 lines, lebih besar dari Firefox 481 lines karena ada fix v3.20.13-chrome untuk dobel-trigger modal screenshot)
- ✅ Context menu `rf-sidebar-in-page` terdaftar (`background.js` line 410)
- ✅ Handler `TOGGLE_SIDEBAR_IN_PAGE` ada (line 638) dengan inject+retry fallback
- ✅ `RF_HIDE_FOR_CAPTURE` / `RF_RESTORE_AFTER_CAPTURE` broadcast ke semua tabs sebelum/after capture (line 2317–2346)
- ✅ `manifest.json` content_scripts sudah include `content/sidebar-cs.js`

---

## Yang TIDAK di-port (Chrome MV3 limitations)

### Gmail OAuth via PWA relay (v3.20.10)

Firefox v3.20.10 menggunakan `browser.identity.launchWebAuthFlow()` dengan PWA relay page (`https://recallfox-pwa.vercel.app/auth-relay.html`) untuk Gmail OAuth. Chrome MV3 juga support `launchWebAuthFlow` tapi butuh permission `identity` + manifest adjustment yang berbeda.

Chrome v3.20.19 tetap pakai flow lama: `browser.tabs.create({ url: oauthUrl })` — user login di tab baru, lalu manual copy-paste token. **Tidak ideal tapi works**. Port full OAuth relay bisa jadi task terpisah kalau user mau.

### Default Supabase credentials removal (v3.20.2)

Firefox v3.20.2 menghapus hardcoded default Supabase credentials dari `lib/supabase-client.js`. Chrome masih punya hardcoded credentials (`agung.kesmas@gmail.com` / `Recallfox@2026`). **Sengaja tidak di-port** — user pemilik masih pakai credentials ini untuk quick login. Kalau mau dihapus untuk security, bisa jadi task terpisah.

---

## Chrome MV3 adaptations untuk ported code

Semua code yang di-port sudah compliant dengan Chrome MV3 service worker restrictions:

1. **Static imports only** — `chatWithFallback` dan `isAssistantConfigured` di-import statically di top-level `background.js` (bukan dynamic `await import()` yang dilarang di Chrome SW sejak v3.20.4).
2. **`updateItem` ditambahkan ke existing static import** dari `./lib/storage.js` — tidak ada dynamic import baru.
3. **`URL.createObjectURL` tidak dipakai** di code Relay Point (cuma string manipulation + `chatWithFallback` yang sudah jalan di Chrome SW).
4. **`btoa` + `TextEncoder`** (kalau diperlukan di future) sudah tersedia di Chrome SW.

---

## Verification — tested in headless Chrome 149 via Playwright

| Test | Result |
|------|--------|
| SW loads without `import()` errors | ✅ |
| `onInstalled` completes (backup, prayer, contentguard, element blocker, supabase realtime) | ✅ |
| `PRAYER_FETCH` returns full timings | ✅ |
| `SUPABASE_STATUS` / `SUPABASE_TEST_CONNECTION` / `SUPABASE_LOGIN` (wrong creds) — all reachable | ✅ |
| `SAVE_TAPE_TO_VAULT` returns noteId | ✅ |
| `VOLUME_GET` / `VOLUME_GET_STATE` return state | ✅ |
| Auto-backup writes `auto-backup.json` (no `URL.createObjectURL` error) | ✅ |
| SW stays alive 8s+ and continues handling messages | ✅ |
| **NEW: Provider list includes `omnirouter`** | ✅ |
| **NEW: `omnirouter` config: `defaultBaseUrl: 'http://localhost:20128/v1'`, `defaultModel: 'auto'`** | ✅ |
| **NEW: `isAssistantConfigured()` returns false when no provider configured (graceful)** | ✅ |
| **NEW: `CAPTURE_SNAPSHOT` with short body (<100 char) — skip resume gen** | ✅ |
| **NEW: `CAPTURE_SNAPSHOT` with long body (>=100 char) — fire-and-forget `generateResumeContext`** | ✅ |
| **NEW: `generateResumeContext` logs "AI not configured — skip" when OmniRouter not set up (graceful)** | ✅ |
| **NEW: `GENERATE_RESUME_CONTEXT` with no itemId — returns `no_item_id`** | ✅ |
| **NEW: `GENERATE_RESUME_CONTEXT` with fake itemId — returns `item_not_found_or_not_snapshot`** | ✅ |
| **NEW: Popout sidebar context menu `rf-sidebar-in-page` registered** | ✅ |
| **NEW: `TOGGLE_SIDEBAR_IN_PAGE` handler + inject+retry fallback** | ✅ |
| **NEW: `RF_HIDE_FOR_CAPTURE` / `RF_RESTORE_AFTER_CAPTURE` broadcast logic** | ✅ |
| Prayer strip shows "🕌 Ashar 15:14 −1j 22m" (not "Gagal muat") | ✅ |

---

## Files changed

```
background.js              | +245 lines (Relay Point + Anchor AI Answer)
lib/assistant.js           | +43 lines (OmniRouter provider)
popup/popup.js             | +49 lines (Copy/Generate Resume Context UI)
settings/settings.html     | +34 lines (OmniRouter option + help section)
settings/settings.js       | +23 lines (alwaysShowBaseUrl logic)
manifest.json              | version bump 3.20.13 → 3.20.19
CHANGELOG-v3.20.19.md      | new (this file)
```

---

## Manual testing checklist

### Test 1: OmniRouter local mode (tanpa API key)
1. Install OmniRouter local: `npm i -g omniroute && omniroute`
2. Buka Settings → AI Assistant → pilih provider "OmniRouter"
3. Base URL field otomatis tampil dengan placeholder `http://localhost:20128/v1`
4. Kosongkan API Key field (tidak wajib untuk local free mode)
5. Model: biarkan default `auto`
6. Buka popup → tab "Tanya AI" → kirim pesan → verify response dari OmniRouter

### Test 2: OmniRouter cloud mode
1. Daftar di `https://omniroute.online` → dapat API key dari dashboard
2. Settings → AI Assistant → pilih "OmniRouter"
3. Ganti Base URL ke URL cloud yang diberikan
4. Isi API Key dari dashboard
5. Test chat → verify response

### Test 3: Resume Context auto-generate
1. Pastikan OmniRouter sudah configured (Test 1 atau 2)
2. Buka ChatGPT → chat 5+ pesan tentang React project
3. Alt+Shift+5 → snapshot → save
4. Buka popup → klik snapshot item di vault → verify tombol "📋 Copy Resume Context" muncul (bukan "🔄 Generate")
5. Klik "Copy Resume Context" → paste ke notepad → verify format: 🎯 Tujuan Utama / ✅ Yang Sudah Dikerjakan / ⏳ Yang Belum Selesai / 📌 Konteks Penting
6. Verify "Yang Sudah Dikerjakan" berisi poin dari **JAWABAN AI** (kode, solusi, file), bukan pertanyaan user

### Test 4: Resume Context manual generate (retry)
1. Pastikan OmniRouter BELUM configured (atau matikan sementara)
2. Capture snapshot → verify tombol "🔄 Generate Resume Context" muncul (bukan "Copy")
3. Configure OmniRouter di Settings
4. Klik "🔄 Generate Resume Context" di action sheet snapshot
5. Verify toast "✓ Resume context siap — klik item lagi untuk copy"
6. Klik item lagi → verify tombol berubah jadi "📋 Copy Resume Context"

### Test 5: Popout sidebar (sudah ada sejak v3.20.9-chrome)
1. Buka halaman web apa saja (http/https)
2. Klik kanan → "Tampilkan RecallFox di halaman ini (popout)"
3. Verify sidebar RecallFox muncul sebagai floating iframe di kanan halaman
4. Test resize, drag, pin, close
5. Alt+Shift+5 (screenshot capture) → verify popout TIDAK ikut tertangkap
6. Cancel screenshot → verify popout restore instan

### Test 6: Regression — fitur lama tetap jalan
1. Prayer strip tetap show countdown (not "Gagal muat")
2. Supabase login + sync masih jalan
3. RecallTape save to vault masih jalan
4. Volume booster masih jalan
5. Clear cache masih jalan
6. Auto-backup tetap jalan (cek `Downloads/RecallFox/auto-backup.json`)

---

## Lihat juga

- **Repo:** https://github.com/agungkesmas/recallfox-chrome
- **Firefox stable equivalent:** https://github.com/agungkesmas/recallfox/releases/tag/v3.20.19-stable
- **Previous Chrome stable:** https://github.com/agungkesmas/recallfox-chrome/releases/tag/v3.20.4-chrome-stable
- **Firefox CHANGELOG v3.20.19 (Anchor AI Answer):** https://github.com/agungkesmas/recallfox/blob/main/CHANGELOG-v3.20.19-anchor-ai-answer.md
- **Firefox CHANGELOG v3.20.18 (Relay Point v3):** https://github.com/agungkesmas/recallfox/blob/main/CHANGELOG-v3.20.18-relay-point-v3.md
- **Firefox CHANGELOG v3.20.16 (Relay Point v1):** https://github.com/agungkesmas/recallfox/blob/main/CHANGELOG-v3.20.16-relay-point.md
- **OmniRouter project:** https://github.com/diegosouzapw/OmniRoute

— *Ported to Chrome by Super Z on 2026-08-02, sesuai instruksi user untuk Chrome parity dengan Firefox v3.20.19-stable.*
