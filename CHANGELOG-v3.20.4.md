# RecallFox Chrome v3.20.4 — Critical Fix: Service Worker Dynamic Import + Auto-backup

**Release date:** 2026-07-30
**Tag:** `v3.20.4-chrome` + `v3.20.4-chrome-stable`

## TL;DR

v3.20.3 shipped with **every dynamic-import-based feature broken in Chrome**.
This release fixes the root cause and restores:

- ✅ **Waktu Sholat** — prayer times now load (was "🕌 Gagal muat")
- ✅ **Sync Supabase** — login / status / push / pull / realtime all reachable
- ✅ **RecallTape** — "Save to Vault" works
- ✅ **Clear Cache** — `Kelola Situs → Bersihkan Cache` works
- ✅ **Volume booster** — site volume control message routing works
- ✅ **Auto-backup** — now succeeds in Chrome SW (was silently failing)
- ✅ **Habits / Ngaji / Olahraga / Islamic Calendar** — all lib modules load

## Root Cause

Chrome MV3 service workers **disallow `await import()`** per the HTML spec
([w3c/ServiceWorker#1356](https://github.com/w3c/ServiceWorker/issues/1356)).
Firefox MV3 background scripts DO support dynamic import, so the Firefox addon
worked fine — but the same code path throws in Chrome:

```
import() is disallowed on ServiceWorkerGlobalScope by the HTML specification.
```

This silently killed:

- `onInstalled` → `initBackup`, `startRealtimeSync`, `subscribeRealtimeVault`,
  migration code
- `PRAYER_FETCH` handler → popup showed "🕌 Gagal muat"
- `SUPABASE_*` handlers → sync panel showed no state
- `SAVE_TAPE_TO_VAULT` handler → RecallTape save silently dropped
- All 62 `await import(...)` call sites in `background.js`
- 7 `import(...).then(...)` lazy-load sites in `lib/storage.js`
- 3 lazy-load sites in `lib/supabase-sync.js`
- 1 lazy-load site in `lib/ai-detect.js`

A second Chrome-SW-specific bug also broke auto-backup:
`URL.createObjectURL()` is not available in MV3 service workers, so
`manualBackupNow()` was throwing — the catch swallowed it, but no backup
file was ever written.

## Fix

### 1. Convert ALL dynamic imports to static imports

**`background.js`** (+96 lines, -62 dynamic import sites):
Added a single block of static imports for every previously-lazy-loaded module:
`salahtime.js`, `supabase-client.js`, `supabase-sync.js`, `autobackup.js`,
`clearcache.js`, `volume.js`, `sync-profile.js`, `pdf.js`, `islamicCalendar.js`,
`habits.js`, `ai-detect.js`, plus extended the existing `storage.js` import
with `saveVault`, `getScreenshotBlob`, `deleteItem`, `deleteBundle`, `addNote`.

Name conflicts resolved with aliases:
- `sync-profile.js`'s `fullSync` → `profileFullSync`
- `supabase-sync.js`'s `fullSync` → `supabaseFullSync`
- `supabase-client.js`'s `testConnection` → `testSupabaseConnection`

**`lib/storage.js`** (+13 lines, -7 `.then()` lazy-load sites):
Added static imports for `notify`, `uploadScreenshot` (from `gdrive-sync.js`)
and `addToDeleteRegistry`, `directDeleteVaultItem`, `directUpsertVaultItem`,
`directUpsertNote`, `directDeleteNote` (from `supabase-sync.js`). Replaced
every `import('./supabase-sync.js').then(mod => { if (mod.X) mod.X(...) })`
block with a direct `if (X) X(...)` call.

**`lib/supabase-sync.js`** (+1 line):
Extended the existing `storage.js` static import to include
`getScreenshotBlob` and `setScreenshotBlob` (previously lazy-loaded in 3
places inside the module).

**`lib/ai-detect.js`** (+2 lines, -1 lazy-load site):
Added `import { getEffectiveTools } from './ai-tools.js';` at the top;
removed the inline `await import(...)` from `migrateFromAiTools`.

### 2. Circular import safety

The refactor creates ES module cycles:
- `storage.js ↔ supabase-sync.js` (each imports from the other)
- `storage.js ↔ gdrive-sync.js` (each imports from the other)

ES modules handle this safely for **function declarations** — functions are
hoisted at module init, and we never call the imported functions at top-level
evaluation time. All calls happen inside event handlers / message handlers /
user actions, by which point both modules have finished loading.

### 3. Fix `URL.createObjectURL` in Chrome SW

**`lib/autobackup.js`** `writeToDisk()`:
Detect `typeof URL.createObjectURL === 'function'`. If available (Firefox SW,
popup context), use the efficient blob URL. If not (Chrome MV3 SW), fall back
to a base64 `data:application/json;base64,...` URL — `btoa` and `TextEncoder`
are both available in Chrome SW. This restores auto-backup functionality.

## Verification

Tested with Chrome 149 (Chrome for Testing) in headless mode via Playwright:

| Test | Result |
|------|--------|
| SW loads without `import()` errors | ✅ |
| `onInstalled` completes (backup, prayer, contentguard, element blocker, supabase realtime) | ✅ |
| `PRAYER_FETCH` returns full timings (Fajr/Dhuhr/Asr/Maghrib/Isha + sunnah) | ✅ |
| Popup prayer strip shows "🕌 Ashar 15:14 −55m" (not "Gagal muat") | ✅ |
| `SUPABASE_STATUS` returns `{ loggedIn: false }` | ✅ |
| `SUPABASE_TEST_CONNECTION` returns `{ ok: true, url: 'https://qmwofsfpxjptpyvncylp.supabase.co' }` | ✅ |
| `SUPABASE_LOGIN` with wrong creds returns proper auth error (Supabase reachable) | ✅ |
| `SAVE_TAPE_TO_VAULT` returns `{ ok: true, noteId: 'n_...' }` | ✅ |
| `VOLUME_GET` / `VOLUME_GET_STATE` return current state | ✅ |
| Auto-backup creates `auto-backup.json` (no `URL.createObjectURL` error) | ✅ |
| SW stays alive 8s+ and continues handling messages | ✅ |

## Firefox compatibility

The Firefox addon (`agungkesmas/recallfox`) is **untouched** — it still uses
dynamic imports, which Firefox supports. No need to port this fix back.

## Files changed

```
background.js              | refactored: 62 dynamic imports → static imports
lib/storage.js             | refactored: 7 lazy imports → static; removed _loadGDrive
lib/supabase-sync.js       | extended static import of storage.js (+2 functions)
lib/ai-detect.js           | refactored: 1 lazy import → static
lib/autobackup.js          | fix: URL.createObjectURL fallback to data: URL in Chrome SW
manifest.json              | version bump 3.20.3 → 3.20.4
```

## Manual testing checklist

1. Download the ZIP from the release assets.
2. Extract to a folder.
3. Open `chrome://extensions` → enable **Developer mode** (top right).
4. Click **Load unpacked** → select the extracted folder.
5. Open the popup → verify the prayer strip shows "🕌 [PrayerName] [Time] −[Countdown]" (not "Gagal muat").
6. Open the popup → tab **Alat** → **Waktu Shalat** → enable prayer times →
   set location → verify prayer grid populates with today's times.
7. Open the popup → tab **Alat** → **Sync Cloud** → click **Test Koneksi** →
   verify "✅ Terhubung ke https://qmwofsfpxjptpyvncylp.supabase.co".
8. Try **Login** with a real account → verify `loggedIn: true` shows.
9. Right-click any selection on a page → **🧾 Tambah ke RecallTape** →
   open the tape popover → click **Save to Vault** → verify success toast.
10. Open any page → press **Alt+Shift+C** → verify cache is cleared.
11. Check `chrome://extensions` → click **Service worker** (under RecallFox) →
    verify NO errors in console (only benign warnings).
12. Check your Downloads folder → `RecallFox/auto-backup.json` should exist
    and contain a valid JSON snapshot of your vault.
