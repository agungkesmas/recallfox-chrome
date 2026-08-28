# RecallFox v3.13.3 — Sync Reliability Patch

**Tanggal:** 24 Jul 2026
**Tag sebelumnya:** v3.13.2
**Tipe:** Bug fix (5 surgical changes, no feature changes)

## Ringkasan

Audit mendalam addon + PWA + Supabase mengungkap 4 critical bug di addon yang menyebabkan sync rusak setelah update dan item yang dihapus di PWA tetap muncul di addon. Patch ini fix semua bug tersebut + 1 bonus alarm interval.

## Perubahan

### A1 — `onInstalled` sekarang start realtime sync + alarm
**File:** `background.js` (onInstalled handler, sekitar line 101-114)

**Bug:** Sebelumnya, alarm `rf-supabase-realtime` hanya di-start di `onStartup`. Setelah user update addon, alarm mati sampai Firefox di-restart → sync tidak real-time sampai restart.

**Fix:** Tambah blok di onInstalled yang gated `isLoggedIn()` (mirror onStartup pattern) → panggil `startRealtimeSync()` + `subscribeRealtimeVault()`.

### A2 — Alarm + auto-sync pakai `pullFromSupabaseV33` (reconciliation)
**File:** `lib/supabase-sync.js` (4 call sites) + `background.js` (SUPABASE_PULL handler)

**Bug:** `handleRealtimeAlarm`, `triggerAutoSync`, initial pull di `startRealtimeSync`, dan `SUPABASE_PULL` message handler semuanya panggil `pullFromSupabase()` (variant lama tanpa reconciliation). Item yang di-hard-delete di PWA tetap muncul di addon karena pull lama tidak filter `deleted_at IS NULL` dan tidak hapus item lokal yang tidak ada di cloud.

**Fix:** Ganti semua 4 call site → `pullFromSupabaseV33()` (variant yang filter server-side + hapus item lokal yang sudah tidak ada di cloud, dengan 60s grace period untuk item baru).

### A3 — WebSocket URL + topic diperbaiki
**File:** `lib/supabase-sync.js` (`subscribeRealtimeVault`)

**Bug:** 
- `wsUrl` pakai `session.access_token` (JWT user) sebagai `apikey` — Supabase Realtime mengharapkan **ANON KEY** sebagai `apikey`, JWT sebagai Authorization.
- Topic `realtime:vault_${userId}` salah — Supabase Realtime V1 expect topic format `realtime:public:<table>`.

**Fix:**
- `wsUrl` pakai `SUPABASE_ANON_KEY` sebagai `apikey`.
- Topic → `realtime:public:vault_items`.
- Sertakan `access_token` di payload `phx_join` supaya RLS bisa identifikasi user.
- Subscribe hanya `vault_items` di channel utama (1 channel = 1 table). Notes di-handle polling backup.

### A4 — Error tidak lagi ditelan
**File:** `lib/storage.js` (6 call sites: addItem, updateItem, deleteItem untuk vault; createNote, updateNote, deleteNote untuk notes)

**Bug:** Semua pemanggilan `directUpsertVaultItem` / `directUpsertNote` / `directDeleteVaultItem` / `directDeleteNote` pakai `.catch(() => {})` — error benar-benar silent. User tidak pernah tahu kalau upload/delete ke cloud gagal.

**Fix:** Ganti ke `.catch(e => { console.warn(...); browser.storage.local.set({recallfox_last_sync_error: ...}) })`. UI bisa baca `recallfox_last_sync_error` untuk tampilkan status sync terakhir.

### A5 (Bonus) — Alarm polling 2 menit → 1 menit
**File:** `lib/supabase-sync.js` (`subscribeRealtimeVault`)

**Bug:** Backup polling alarm setiap 2 menit — terlalu lama kalau WS mati (kasus umum di Firefox MV3 service worker).

**Fix:** Ubah `periodInMinutes: 2` → `periodInMinutes: 1`. `handleRealtimeAlarm` sudah cek dulu `updated_at` latest sebelum pull penuh, jadi tidak boros bandwidth.

## Yang TIDAK Diubah

- IndexedDB / storage.local schema
- Auth flow (Supabase Auth)
- Realtime subscription code (tetap ada sebagai backup kalau WS jalan)
- Schema DB / RLS policies
- Polling 10s PWA (di PWA sisi)
- Semua fitur lain (capture, screenshot, content guardian, dsb.)

## Verifikasi Post-Deploy

User harus:
1. Update addon via Firefox (download XPI baru atau auto-update)
2. **Restart Firefox** (atau disable + enable addon) supaya `onInstalled` fire ulang + alarm baru aktif
3. Login ke Supabase kalau belum
4. Buka DevTools (Ctrl+Shift+J) → Console → pastikan log `[RecallFox/Supabase] Realtime alarm created: rf-supabase-realtime` muncul
5. Test: hapus 1 item di PWA → tunggu 1 menit → item harus hilang dari addon vault

## Files Changed

- `manifest.json` — version bump 3.13.2 → 3.13.3
- `background.js` — A1 (onInstalled start sync) + A2 (SUPABASE_PULL handler pakai V33)
- `lib/supabase-sync.js` — A2 (3 call sites pakai V33) + A3 (WS URL + topic) + A5 (alarm 1 min)
- `lib/storage.js` — A4 (6 call sites log + simpan error)
- `CHANGELOG-v3.13.3.md` — file ini
