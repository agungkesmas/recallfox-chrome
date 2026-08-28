# Changelog v3.11.21 — Clipboard fix + Migrasi Supabase

> **Versi:** 3.11.21
> **Baseline:** v3.11.20 (commit 9a440b4)
> **Sumber catatan:** Log Troubleshooting — Aplikasi Web & Addon (Sesi terakhir, 2 issues)

---

## 🐛 2 Fix dari Log Troubleshooting Sesi terakhir

### Issue #1 — Fix `clipboard_write_failed` (Salin Gambar / Salin + Keterangan gagal)

**User feedback:**
> "tombol tombol ini ya yang ada di screnshot warna hijau yaitu Salin Gambar, Salin gambar saja ke clipboard, Salin + Keterangan (Gambar + URL, judul, waktu, mode) > ini selalu gagal saat dipencet tombol nya keluar pesan eror Gagal salin: clipboard_write_failed"

**Root cause:**
Di `background.js`, handler `COPY_SCREENSHOT_TO_CLIPBOARD` pakai `browser.scripting.executeScript()` untuk inject fungsi ke content script. Fungsi tersebut memanggil `sendResponse(...)` di dalam func body — tapi `sendResponse` adalah **background context function**, TIDAK BISA diakses dari content script context. Akibatnya:
1. `sendResponse(...)` throw `ReferenceError: sendResponse is not defined`
2. Error ditangkap oleh `catch (e)` di dalam func
3. Catch handler juga coba `sendResponse({ ok: false, error: e.message })` — gagal lagi
4. `executeScript` return `undefined` (karena func tidak return value)
5. Background handler terima `result = undefined`, kirim `clipboard_write_failed` ke popup

**Fix:**
Ganti `sendResponse(...)` ke `return { ... }` pattern di dalam `executeScript.func`. Return value akan diterima via `results[0].result` di background context, lalu background kirim ke popup via `sendResponse`.

```javascript
// SEBELUMNYA (bug):
func: async (dataUrl, withCaption, textPlain, textHtml) => {
  try {
    // ...
    await navigator.clipboard.write([item]);
    sendResponse({ ok: true, message: '✓ Gambar tersalin' }); return;  // ❌ ReferenceError
  } catch (e) {
    sendResponse({ ok: false, error: e.message }); return;  // ❌ ReferenceError lagi
  }
}

// SEKARANG (fix):
func: async (dataUrl, withCaption, textPlain, textHtml) => {
  try {
    // ...
    await navigator.clipboard.write([item]);
    return { ok: true, message: '✓ Gambar tersalin' };  // ✅ return value
  } catch (e) {
    return { ok: false, error: e.message };  // ✅ return value
  }
}
```

**Bonus fix:** Tambah normalisasi JPEG → PNG via canvas (sebelumnya pakai `new Blob([await blob.arrayBuffer()], { type: 'image/png' })` yang TIDAK convert format — cuma ganti MIME type, padahal data masih JPEG. Clipboard API Firefox hanya support `image/png`).

**Fallback:** Kalau `ClipboardItem` tidak tersedia (Firefox < 127), return `{ needsFallback: true }` supaya background context handle via `browser.clipboard.setImageData()`.

**File diubah:** `background.js` (handler `COPY_SCREENSHOT_TO_CLIPBOARD`, line ~2043-2182)

---

### Issue #2 — Migrasi dari Apps Script ke Supabase

**User feedback:**
> "saya frustasi dengan apps script yang tidak berhasil sudah dua hari untuk save gambar screenshot di drive. oleh karena itu buatkan databasenya menggunakan suppabase untuk menyimpan seluruh data yang dihasilkan di dalam addon seperti desain apps sync nya aja namun versi otomatis karena ini kan pake suppabase, ingat harus detil ya simpan datanya"

**Kredensial Supabase (dari Google Doc):**
```
RECALLFOX RELASITIMUR
┌─ SUPABASE RECALLFOX ──────────────────────────┐
│ Project URL  : https://qmwofsfpxjptpyvncylp.supabase.co
│ Anon Key     : sb_publishable_9gyUUsJUf1RZld9dgny3HA_o74o2mKv
│ Service Role : [REDACTED — secret, tidak boleh di client code]
│ DB Password  : [REDACTED — secret, hanya untuk SQL editor]
└────────────────────────────────────────────────┘
```

> **Catatan keamanan:** Service Role key & DB Password TIDAK dimasukkan ke kode addon
> (GitHub Push Protection akan menolak). Hanya Anon Key (yang aman untuk client)
> yang hardcoded di `lib/supabase-client.js`. User menjalankan `supabase-schema.sql`
> sendiri di Supabase dashboard pakai akun mereka sendiri.

**Akun login default:**
- Email: `agung.kesmas@gmail.com`
- Password: `Recallfox@2026`

**Implementasi:**

#### A. `lib/supabase-client.js` (NEW — 480 baris)
Lightweight Supabase REST API client (zero dependencies, pakai `fetch()` langsung):
- **Auth API**: `signInWithEmail`, `signUpWithEmail`, `signOut`, `getSession`, `isLoggedIn`, `getCurrentUser`, `fetchUserProfile`, `signInWithGmail` (OAuth redirect), `handleOAuthCallback` (parse token dari URL hash)
- **Database (PostgREST)**: `selectRows`, `insertRow`, `upsertRow`, `updateRow`, `deleteRow` — semua dengan auto-refresh token kalau 401
- **Storage**: `uploadFile`, `deleteFile` — untuk upload screenshot ke bucket
- **Session management**: simpan di `browser.storage.local` dengan key `recallfox_supabase_session`, auto-refresh token expired
- **Config hardcoded**: `SUPABASE_URL` + `SUPABASE_ANON_KEY` (anon key aman untuk client, service role JANGAN dipakai di client)

#### B. `lib/supabase-sync.js` (NEW — 470 baris)
Sync engine — ganti `sync-profile.js` (Apps Script):
- **`pushToSupabase()`** — upload local state ke cloud:
  - Vault items (prompt, context, link, snapshot, screenshot) → upsert ke `vault_items` table
  - Bundles → upsert ke `vault_items` dengan `type='bundle'`
  - Notes → upsert ke `notes` table
  - Settings → upsert ke `settings` table (skip sensitive fields: API keys, tokens)
  - Screenshot blobs → upload ke Supabase Storage bucket `screenshots` + insert row ke `screenshots` table
- **`pullFromSupabase()`** — download cloud state ke local:
  - Merge strategy: last-write-wins by `updated_at` timestamp
  - Items: tambah baru atau update yang sudah ada
  - Notes: sama
  - Settings: cloud menang (local tidak track updated_at per setting)
- **`fullSync()`** — push + pull sekaligus
- **`deleteItemFromCloud(id)`** — hapus item + screenshot storage
- **`deleteNoteFromCloud(id)`** — hapus note
- **`triggerAutoSync()`** — debounced 5 detik, fire-and-forget (dipanggil otomatis saat vault berubah)
- **`getSupabaseStatus()`** — status login + last sync untuk UI

#### C. `supabase-schema.sql` (NEW — 230 baris)
SQL schema lengkap untuk Supabase SQL Editor:
- **6 tables**: `profiles`, `vault_items`, `notes`, `settings`, `screenshots`, `sync_log`
- **Triggers**: auto-create profile saat signup, auto-update `updated_at`
- **Row Level Security (RLS)**: 24 policies — user hanya bisa akses row miliknya (`user_id = auth.uid()`)
- **Storage bucket**: `screenshots` (public-readable, user hanya upload/delete di folder sendiri)
- **Indexes**: untuk query cepat (user_id, type, archived, updated_at)

**Cara setup:**
1. Buka https://supabase.com/dashboard/project/qmwofsfpxjptpyvncylp/sql/new
2. Paste isi `supabase-schema.sql`, klik Run
3. Verifikasi: 6 tables muncul di Table Editor

#### D. `background.js` — 13 message handlers baru
- `SUPABASE_LOGIN` — login email/password
- `SUPABASE_SIGNUP` — signup akun baru
- `SUPABASE_GMAIL` — login via Gmail OAuth (redirect)
- `SUPABASE_LOGOUT` — logout
- `SUPABASE_STATUS` — cek login status + user info + last sync
- `SUPABASE_PUSH` — upload local → cloud
- `SUPABASE_PULL` — download cloud → local
- `SUPABASE_FULL_SYNC` — push + pull
- `SUPABASE_TEST_CONNECTION` — test koneksi ke project (tanpa login)
- `SUPABASE_DELETE_ITEM` — hapus item dari cloud
- `SUPABASE_DELETE_NOTE` — hapus note dari cloud
- `SUPABASE_AUTO_SYNC` — trigger push debounced (auto saat vault berubah)
- `SUPABASE_OAUTH_CALLBACK` — handle redirect dari Gmail OAuth

#### E. `popup/popup.js` — UI Supabase di Sync Cloud Dashboard
Tambah Section 0 (paling atas) di `renderGDrivePage()`:
- **Header card hijau** — status Supabase (login/belum, last sync)
- **Form login** (kalau belum login):
  - Input email (pre-fill `agung.kesmas@gmail.com`)
  - Input password (pre-fill `Recallfox@2026`)
  - Tombol "🔐 Login" (email/password)
  - Tombol "Login dengan Gmail" (Google OAuth, dengan logo Google)
  - Tombol "📝 Buat akun baru" (signup)
  - Tombol "🔌 Test Koneksi Supabase"
- **User info + tombol sync** (kalau sudah login):
  - Email + User ID
  - "🔄 Sync Full (push + pull)"
  - "📤 Push ke Cloud" + "📥 Pull dari Cloud"
  - "🚪 Logout"
- **Result display** — hasil operasi (sukses/error)
- **Helper functions**: `_doSupabaseSync(B, action)`, `_showSupaResult(B, ok, msg)`

#### F. `lib/storage.js` — Auto-sync trigger
- `saveVault()` → kirim `SUPABASE_AUTO_SYNC` message (fire-and-forget)
- `saveNotes()` → kirim `SUPABASE_AUTO_SYNC` message
- Auto-sync debounced 5 detik, cek login status sebelum push

#### G. `manifest.json` — Host permissions
Tambah:
- `https://qmwofsfpxjptpyvncylp.supabase.co/*`
- `https://*.supabase.co/*`

---

## File yang Diubah (v3.11.21)

| File | Jenis | Ringkasan |
|---|---|---|
| `manifest.json` | Modify | Bump 3.11.20 → 3.11.21. Tambah host permissions untuk supabase.co |
| `background.js` | Modify | Fix `COPY_SCREENSHOT_TO_CLIPBOARD` (return pattern + JPEG→PNG conversion + fallback). Tambah 13 message handlers Supabase |
| `lib/supabase-client.js` | **NEW** | Lightweight Supabase REST API client (Auth + Database + Storage) |
| `lib/supabase-sync.js` | **NEW** | Sync engine — push/pull/full sync vault items, notes, settings, screenshots |
| `supabase-schema.sql` | **NEW** | SQL schema — 6 tables + RLS + triggers + storage bucket |
| `lib/storage.js` | Modify | Tambah `SUPABASE_AUTO_SYNC` trigger di `saveVault()` + `saveNotes()` |
| `popup/popup.js` | Modify | Tambah Section 0 Supabase di `renderGDrivePage()` + 3 helper functions (`_doSupabaseSync`, `_showSupaResult`, event bindings) |
| `README.md` | Modify | Update header ke v3.11.21 + section Setup Supabase |
| `CHANGELOG-v3.11.21.md` | **NEW** | File ini |

---

## Testing Checklist

### Issue #1 — Clipboard fix
- [ ] Load addon di Firefox (`about:debugging` → Load Temporary Add-on → `manifest.json`)
- [ ] Buka vault → chip "Media" → klik screenshot → klik "Salin Gambar Saja"
- [ ] Harus muncul toast "✓ Gambar tersalin ke clipboard" (BUKAN "Gagal salin: clipboard_write_failed")
- [ ] Paste di image editor (Paint, Photoshop) → gambar muncul
- [ ] Klik "Salin + Keterangan" → paste di Google Docs rich text → gambar + caption muncul
- [ ] Aktifkan batch mode → centang 2 screenshot → "Copy + Keterangan" → paste di Google Docs → semua screenshot muncul

### Issue #2 — Supabase integration
- [ ] **Setup SQL schema**: Buka Supabase SQL Editor → paste `supabase-schema.sql` → Run → sukses
- [ ] Cek Table Editor → 6 tables muncul (profiles, vault_items, notes, settings, screenshots, sync_log)
- [ ] Cek Policies → 24 policies muncul
- [ ] Buka addon → Alat → Sync Cloud → section "🔐 Login Supabase" muncul di paling atas
- [ ] Klik "🔌 Test Koneksi Supabase" → "✅ Supabase accessible: https://qmwofsfpxjptpyvncylp.supabase.co"
- [ ] Email + password sudah pre-fill (agung.kesmas@gmail.com / Recallfox@2026)
- [ ] Klik "🔐 Login" → "✅ Login berhasil! Email: agung.kesmas@gmail.com"
- [ ] UI berubah ke user info + tombol sync
- [ ] Klik "📤 Push ke Cloud" → "✓ Push berhasil · X items, Y catatan, Z screenshot, W settings"
- [ ] Cek di Supabase Table Editor → data muncul di `vault_items`, `notes`, `settings`
- [ ] Cek di Supabase Storage → bucket `screenshots` ada, file `user-<uuid>/<screenshot-id>.png` muncul
- [ ] Hapus 1 item di vault lokal → cek Supabase Table Editor → item hilang dari `vault_items` (auto-sync 5s)
- [ ] Klik "📥 Pull dari Cloud" → "✓ Pull berhasil · +X items baru, ~Y updated"
- [ ] Klik "🔄 Sync Full" → push + pull sekaligus
- [ ] Klik "🚪 Logout" → UI kembali ke form login
- [ ] Test Gmail OAuth: klik "Login dengan Gmail" → tab baru terbuka → login Gmail → redirect kembali ke addon → login otomatis

---

## Architecture Comparison: Apps Script vs Supabase

| Aspect | Apps Script (lama) | Supabase (baru v3.11.21) |
|--------|-------------------|--------------------------|
| **Setup** | Deploy Web App + copy URL + generate token + paste ke addon | Cukup login email/password |
| **Auth** | Token manual (32 char random) | Supabase Auth (email/password atau Gmail OAuth) |
| **Database** | Google Spreadsheet (17 sheets) | PostgreSQL dengan RLS (6 tables) |
| **Storage** | Google Drive folder | Supabase Storage bucket |
| **Limit** | ~10MB per POST request | 50MB per file (Storage), no limit per row |
| **Real-time** | Tidak (polling manual) | Supabase Realtime (belum dipakai, bisa ditambah) |
| **Security** | Token sharing (siapa pun dengan token bisa akses) | RLS — user hanya akses row miliknya |
| **Multi-user** | Share URL+Token (data campur) | Akun terpisah, data terisolasi per user |
| **Auto-sync** | Tidak (manual klik Sync) | Ya (debounced 5s saat vault berubah) |

---

**Status:** Semua 2 fix selesai ✓ · **Baseline:** v3.11.20 · **Validasi:** node --check (0 error semua file)
