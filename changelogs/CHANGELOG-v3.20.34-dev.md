# CHANGELOG v3.20.34-dev — Fix NetworkError Magic Command di Popout Sidebar

**Tanggal:** 2026-08-05
**Baseline:** v3.20.33
**Tipe:** Bug fix (network layer) — **DEV RELEASE (bukan stable)**
**Status:** Pengembangan — tandai stable setelah user confirm

---

## ⚠️ Status: DEV (Bukan Stable)

Release ini adalah **prerelease untuk testing**. Jangan deploy ke user awam sampai user confirm fix-nya jalan. Tag: `v3.20.34-dev` (bukan `-stable`).

---

## Ringkasan

Fix `NetworkError when attempting to fetch resource` saat Magic Command dijalankan dari **popout sidebar** (iframe context). Sidebar utama (top-level) tidak terpengaruh — bug hanya terjadi di iframe.

---

## Root Cause

### Bug #1: `chat()` tidak wrap `fetch()` dengan try/catch

Di `lib/assistant.js` v3.20.33, `chat()` function panggil `fetch(url, ...)` **tanpa try/catch**. Kalau fetch throw `NetworkError` (typical di iframe cross-origin), exception langsung propagate ke caller.

### Bug #2: `chatWithFallback()` string match salah

```js
// v3.20.33 — kode lama
const shouldFallback =
  msg.includes('NETWORK_ERROR') ||  // ← underscore
  ...
```

Padahal error message asli browser:
- Firefox: `"NetworkError when attempting to fetch resource"` (no underscore)
- Chrome: `"Failed to fetch"`
- Safari: `"Load failed"`

String match `msg.includes('NETWORK_ERROR')` **tidak pernah match** dengan error asli → fallback provider tidak pernah trigger.

### Bug #3: Iframe cross-origin restriction

Popout sidebar = `sidebar.html` yang di-iframe di halaman web via `content/sidebar-cs.js`. Browser (terutama Firefox) kadang block `fetch()` external API dari iframe extension page karena:
- Iframe dianggap "cross-origin" ke parent page
- Parent page CSP bisa affect iframe
- Browser security: iframe extension context dianggap "less privileged"

Background Service Worker tidak punya restriction ini — punya akses penuh ke network via `host_permissions`.

---

## Perbaikan

### Fix #1: `lib/assistant.js` — `fetchWithRetry()` + normalize error

Wrap `fetch()` dengan helper baru `fetchWithRetry()`:
- **Try/catch** di sekitar fetch
- **Retry mechanism** (max 2 retries dengan 500ms + 1000ms backoff) untuk transient network issue
- **Normalize error**: kalau fetch throw `NetworkError` / `Failed to fetch` / `Load failed` / `TypeError`, convert jadi `new Error('NETWORK_ERROR: <original>')` + set `err.isNetworkError = true`
- **Retryable HTTP status**: 5xx, 429, 401 → retry; 4xx lain → tidak retry (input issue)

### Fix #2: `lib/assistant.js` — Auto-relay ke background di iframe context

Deteksi iframe context (`window !== window.top`). Kalau di iframe:
1. **Coba relay via background** (`browser.runtime.sendMessage({ type: 'RF_ASSISTANT_FETCH', ... })`)
2. Background SW fetch API (punya akses penuh network)
3. Kalau background sukses → return response ke iframe
4. Kalau background gagal → fallback ke direct fetch (mungkin masih bisa jalan kalau restriction tidak aktif)

Trade-off: streaming SSE tidak bisa di-relay real-time (background collect full text dulu, lalu kirim). Tapi untuk Magic Command yang butuh response lengkap sebelum parse JSON, ini OK.

### Fix #3: `lib/assistant.js` — Update `chatWithFallback()` string match

```js
// v3.20.34-dev — kode baru
const msgLower = msg.toLowerCase();
const shouldFallback =
  msgLower.includes('network_error') ||      // normalized oleh fetchWithRetry
  msgLower.includes('networkerror') ||       // Firefox original
  msgLower.includes('failed to fetch') ||    // Chrome original
  msgLower.includes('load failed') ||        // Safari original
  msgLower.includes('timeout') ||
  /\b5\d\d\b/.test(msg) ||
  msgLower.includes('429') ||
  msgLower.includes('rate limit') ||
  msgLower.includes('401') ||
  msgLower.includes('unauthorized') ||
  msgLower.includes('expired');
```

Sekarang fallback provider akan trigger untuk semua varian network error message.

### Fix #4: `background.js` — Tambah handler `RF_ASSISTANT_FETCH`

Background SW terima message dari iframe, lakukan fetch ke API AI provider, return response.

**Logika:**
1. Terima `{ type: 'RF_ASSISTANT_FETCH', url, method, headers, body, stream }`
2. `fetch(url, { method, headers, body })` — background punya `host_permissions: <all_urls>` jadi bisa fetch ke mana saja
3. Kalau `!stream` → return JSON response
4. Kalau `stream` → collect full text, return sebagai string (trade-off: no real-time SSE)
5. Kalau fetch throw → normalize error jadi `NETWORK_ERROR: <msg>`

---

## File yang Diubah

| File | Perubahan |
|---|---|
| `manifest.json` | Bump version 3.20.33 → 3.20.34 |
| `lib/assistant.js` | + `fetchWithRetry()` helper (try/catch + retry + normalize); + auto-relay ke background di iframe context; update `chatWithFallback()` string match |
| `background.js` | + handler `RF_ASSISTANT_FETCH` (relay fetch untuk iframe popout) |
| `CHANGELOG-v3.20.34-dev.md` | BARU — dokumentasi ini |

---

## Anti-Regression Safeguard

**TIDAK ada perubahan di:**
- `lib/magic-command.js` — parser + applier logic (6 action) tetap sama
- `popup/popup.js` — Magic Command modal + handler tetap sama
- `popup/popup.html` — UI tetap sama
- `sidebar/sidebar.html` — UI tetap sama
- `lib/vault-tree.js`, `lib/storage.js` — Vault API tetap sama
- Schema Supabase — tidak ada perubahan

**Perubahan HANYA di network layer** (`lib/assistant.js` + `background.js`).

Sidebar utama (top-level, `window === window.top`) tidak terpengaruh karena:
1. `inIframe` check = `false` → skip background relay → direct fetch (seperti v3.20.33)
2. `fetchWithRetry()` masih wrap fetch, tapi kalau tidak ada error, behavior sama seperti sebelumnya
3. String match update hanya affect fallback logic — kalau primary provider sukses, fallback tidak trigger

---

## Test Plan

### Test 1: Sidebar utama (top-level) — regression test
1. Buka sidebar utama RecallFox (Alt+Shift+4 di Firefox native, atau popup toolbar)
2. Klik "💬 Perintah"
3. Ketik: "Pindahkan semua link ke folder Link"
4. Klik "🪄 Eksekusi Perintah"
5. **Expected:** Modal confirm muncul (tidak ada NetworkError)
6. **Verify:** Behavior sama seperti v3.20.33 — tidak ada regression

### Test 2: Popout sidebar (iframe) — bug fix utama
1. Buka halaman web http(s) — mis. `https://example.com`
2. Klik tombol "rf" floater → popout sidebar muncul (iframe)
3. Klik "💬 Perintah" (tombol yang sudah di-fix di v3.20.33)
4. Ketik: "Pindahkan semua link ke folder Link"
5. Klik "🪄 Eksekusi Perintah"
6. **Expected (v3.20.33):** Toast "⚠ Gagal: NetworkError when attempting to fetch resource"
7. **Expected (v3.20.34-dev):** Modal confirm muncul (NetworkError hilang)
8. **Verify di console:** Lihat log `[RecallFox] Background relay failed, trying direct fetch` atau langsung sukses

### Test 3: Magic Command dengan fallback provider
1. Setup 2 provider di Settings → AI Assistant (primary + fallback)
2. Buka popout sidebar
3. Ketik perintah yang trigger network error (mis. matikan internet sebentar)
4. Eksekusi
5. **Expected:** Primary gagal dengan `NETWORK_ERROR: ...` → fallback trigger → sukses (kalau fallback provider online)

### Test 4: Retry mechanism
1. Buka popout sidebar
2. Eksekusi Magic Command saat koneksi internet tidak stabil
3. **Expected:** Console log `[RecallFox] Network error attempt 1: ... — retrying...` lalu `attempt 2`
4. Kalau retry ke-2 sukses → response kembali normal
5. Kalau retry ke-3 (max) gagal → toast error

### Test 5: All 6 Magic Command actions di popout sidebar
Test setiap action di popout sidebar untuk pastikan network fix tidak break logic:
1. `move` — "Pindahkan link MDN ke folder Referensi"
2. `create-and-move` — "Bikin folder Coding, masukkan prompt Express"
3. `archive-folder` — "Arsipkan folder Lama"
4. `restore-folder` — "Restore folder Lama dari arsip"
5. `add-tag` — "Tambahkan tag favorit ke semua link"
6. `remove-tag` — "Hapus tag lama dari semua prompt"

**Expected:** Semua action jalan tanpa NetworkError.

### Test 6: AI Assistant di Settings page
1. Buka Settings → AI Assistant
2. Test chat dengan provider yang sama
3. **Expected:** Tidak ada regression — Settings page adalah top-level context, jadi `inIframe = false`, direct fetch (tidak relay via background)

### Test 7: Magic Folder (Auto Group AI)
1. Klik "🪄 Auto" di vault header
2. AI analisa item + propose folder structure
3. **Expected:** Tidak ada regression — Magic Folder juga pakai `chatWithFallback`, tapi di sidebar utama `inIframe = false`

---

## Cara Test di Firefox vs Chrome

### Firefox
1. Download `recallfox-firefox-v3.20.34-dev.zip`
2. Extract → `about:debugging` → Load Temporary Add-on → pilih `manifest.json`
3. Buka halaman web → klik tombol "rf" floater → popout sidebar muncul
4. Klik "💬 Perintah" → ketik perintah → eksekusi
5. Cek console (F12) untuk log `[RecallFox]` messages

### Chrome
1. Download `recallfox-firefox-v3.20.34-dev.zip`
2. Extract → `chrome://extensions` → enable Developer mode → Load unpacked
3. Buka halaman web → klik tombol "rf" floater → popout sidebar muncul
4. Klik "💬 Perintah" → ketik perintah → eksekusi
5. Cek console untuk log

---

## Limitasi

1. **Streaming SSE tidak real-time di iframe popout** — background collect full text dulu, lalu kirim ke iframe. User tidak lihat token-by-token. Untuk Magic Command ini OK (butuh full response sebelum parse JSON). Untuk AI Assistant chat streaming, ini akan terasa "laggy" di popout sidebar.

2. **Background SW bisa terminate di Chrome MV3** — kalau SW mati saat fetch berlangsung, relay gagal. Tapi `fetch()` di SW otomatis keep-alive selama await.

3. **Tidak ada retry untuk 4xx (selain 401/429)** — input issue tidak akan sembuh dengan retry. Langsung throw error.

---

## Cara Update dari v3.20.33

1. Backup vault: Settings → Backup Lokal → Export (.json atau .rfvault)
2. Update addon ke v3.20.34-dev
3. Test di popout sidebar — Magic Command seharusnya sekarang jalan tanpa NetworkError
4. Kalau masih gagal, kirim console log (F12 → Console) untuk trace lebih lanjut

---

## Next Steps (setelah user confirm)

Kalau fix ini jalan dengan baik di testing:
- Tag `v3.20.34-stable` (Chrome + Firefox)
- Buat GitHub Release stable
- Bump version ke `3.20.34` (tanpa `-dev`)

Kalau masih ada bug:
- Iterasi fix → bump ke `v3.20.35-dev`
- Ulangi testing
