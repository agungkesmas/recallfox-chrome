# RecallFox Chrome v3.20.5 — Comprehensive Audit: 6 Chrome-MV3 Parity Fixes

**Release date:** 2026-07-30
**Tag:** `v3.20.5-chrome` + `v3.20.5-chrome-stable`

## TL;DR

v3.20.4 fixed the headline dynamic-import bug, but a focused audit of
Firefox v3.20.1 vs Chrome v3.20.4 surfaced **6 additional Chrome-MV3 parity
gaps** that were silently breaking features. v3.20.5 closes all 6.

## Audit method

1. Cloned both repos at their latest stable tags (`v3.20.1-stable` Firefox,
   `v3.20.4-chrome-stable` Chrome).
2. Programmatic diff of every source file. Filtered out intentional Chrome
   adaptations (`browser.menus` → `browser.contextMenus`, `sidebarAction` →
   `sidePanel`, dynamic → static imports, etc.) to isolate real parity gaps.
3. Verified all 89 message handlers exist in both branches (only diff:
   Chrome adds `RF_COMMAND_FALLBACK` for keyboard-shortcut fallback).
4. Loaded the unpacked extension into Chrome 149 (Chrome for Testing) via
   Puppeteer, opened popup + sidebar + settings pages, clicked every tool
   page, sent every message type, captured SW + popup + sidebar + settings
   console errors.

## Bugs found & fixed

### FIX 1 — SVG icons in notifications (18 sites)

**Symptom:** Notifications either didn't appear or appeared without an icon
in Chrome. Firefox supports SVG `iconUrl` in `notifications.create`; Chrome
requires PNG.

**Root cause:** 17 sites in `background.js` + 1 in `lib/clearcache.js` used
`browser.runtime.getURL('icons/icon-96.svg')` for `iconUrl`.

**Fix:** Replaced all 18 `icons/icon-96.svg` → `icons/icon-96.png` (the PNG
file already exists at `icons/icon-96.png`).

**Affected features:**
- Element-blocker notification
- ContentGuard takeover notification
- Prayer reminder notification
- Exercise reminder notification
- Sunnah fast notification
- Auto-discard notification
- Ad-dismissal notification
- Clear-cache success notification

### FIX 2 — `URL.createObjectURL` in 7 sites (Chrome SW lacks this API)

**Symptom:** Downloading screenshots (PNG/JPG/PDF), exporting backups, and
the "download as file" fallback when clipboard write fails all silently
failed in Chrome. No file ever landed in Downloads.

**Root cause:** Chrome MV3 service worker does NOT implement
`URL.createObjectURL()` (only Firefox SW + extension pages do). 7 sites in
`background.js` called it directly to convert a `Blob` into a URL for
`browser.downloads.download()`.

**Fix:** Added two helpers at the top of `background.js`:
- `blobToDownloadUrl(blob)` — uses `URL.createObjectURL` when available
  (Firefox SW / popup context), falls back to base64 `data:` URL in Chrome
  SW (via `Blob.arrayBuffer()` → `btoa`).
- `revokeDownloadUrl(urlInfo)` — revokes blob URLs (no-op for data: URLs).

Replaced all 7 call sites:
- `SAVE_CAPTURE_AS` handler (screenshot download as PNG/JPG/PDF)
- `EXPORT_BACKUP` handler (encrypted `.rfvault` backup download)
- `DOWNLOAD_SCREENSHOT` handler (download existing screenshot from vault)
- 4× clipboard-write fallback paths in `COPY_SCREENSHOT_TO_CLIPBOARD` +
  `COPY_DATAURL_TO_CLIPBOARD` (download PNG when clipboard API unsupported)

### FIX 3 — Dynamic `import()` in Supabase-realtime alarm handler

**Symptom:** Supabase realtime sync via 1-minute alarm polling was silently
dead in Chrome. The alarm fired, but the handler never ran.

**Root cause:** `background.js` line ~3770 (v3.20.4) still had:
```js
import('./lib/supabase-sync.js').then(({ handleRealtimeAlarm }) => { ... });
```
inside the `browser.alarms.onAlarm` listener. Dynamic `import()` is
forbidden on `ServiceWorkerGlobalScope` per the HTML spec
([w3c/ServiceWorker#1356](https://github.com/w3c/ServiceWorker/issues/1356))
— v3.20.4 converted 62 other dynamic imports but missed this one.

**Fix:** Added `handleRealtimeAlarm` to the existing static import block
from `./lib/supabase-sync.js`, then replaced the dynamic-import call with a
direct invocation:
```js
if (alarm.name === 'rf-supabase-realtime') {
  try { handleRealtimeAlarm().catch(...); } catch (e) { ... }
}
```

**Verification:** Manually triggered the `rf-supabase-realtime` alarm in
Chrome 149 headless — handler executed with zero SW errors (would silently
fail in v3.20.4).

### FIX 4 — Prayer & exercise reminders: `setInterval` → `browser.alarms`

**Symptom:** Prayer-time reminders and exercise reminders didn't fire
reliably in Chrome. If the SW was asleep when the prayer time hit, no
reminder appeared.

**Root cause:** `startPrayerReminderChecker()` used `setInterval(..., 60000)`
for both prayer and exercise reminders. Chrome MV3 SW is terminated after
~30s of inactivity, killing any `setInterval` callbacks. The 60s interval
would essentially never fire unless the user happened to be actively using
the extension.

**Fix:** Created two new alarms `rf-prayer-reminder` and
`rf-exercise-reminder` (both `periodInMinutes: 1`), added cases to the
existing `browser.alarms.onAlarm` listener that call `checkPrayerReminder()`
and `checkExerciseReminder()`. Kept `setInterval` as a fallback (with a
warning) if `browser.alarms.create` throws — belt-and-suspenders.

The Firefox addon already uses this exact pattern for Supabase realtime
(`rf-supabase-realtime` alarm) and auto-discard (`rf-auto-discard` alarm),
so this aligns Chrome with the proven-Firefox approach.

### FIX 5 — Auto-backup: `setInterval` → `browser.alarms`

**Symptom:** Auto-backup (default every 6 hours) would essentially never
fire on schedule in Chrome. User could lose data if they relied on it.

**Root cause:** Same as FIX 4 — `lib/autobackup.js` `startBackupInterval()`
used `setInterval(..., hours * 3600 * 1000)`. A 6-hour interval will never
survive Chrome SW's 30-second idle timeout.

**Fix:** Added `BACKUP_ALARM_NAME = 'rf-auto-backup'` constant. Rewrote
`startBackupInterval()` to create a `browser.alarms` alarm with
`periodInMinutes: Math.max(1, hours * 60)`. Added new exported function
`handleBackupAlarm()` that calls `manualBackupNow()`. Added a case to the
`browser.alarms.onAlarm` listener in `background.js` for `rf-auto-backup`.

Verified in Chrome 149 headless: the `rf-auto-backup` alarm is registered
with `period=360min` (6h), and manually triggering it executes
`handleBackupAlarm()` with zero SW errors.

### FIX 6 — Browser-aware sidebar error message in content.js

**Symptom:** When a user pressed the sidebar-toggle keyboard shortcut in
Chrome and the side panel didn't open (because `chrome.sidePanel.open()`
requires a user gesture, which is lost when going through
`runtime.sendMessage`), they saw a misleading message: "Tekan tombol
RecallFox (🦊) di toolbar Firefox untuk buka sidebar".

**Root cause:** Hardcoded "Firefox" in the error message — leftover from
the Firefox-only addon.

**Fix:** Detect Chrome vs Firefox at runtime via
`browser.runtime.getURL('').startsWith('chrome-extension://')`. In Chrome,
show: "Buka side panel RecallFox: klik tombol side panel di toolbar Chrome,
atau klik kanan icon 🦊 → 'Open side panel'". In Firefox, keep the original
message.

## Verification

Tested with Chrome 149 (Chrome for Testing) in headless mode via Puppeteer:

| Test | Result |
|------|--------|
| SW loads without errors | ✅ |
| All 4 alarms registered (`rf-auto-discard`, `rf-prayer-reminder`, `rf-exercise-reminder`, `rf-auto-backup`) | ✅ |
| Manually trigger `rf-prayer-reminder` alarm → handler runs without SW error | ✅ |
| Manually trigger `rf-auto-backup` alarm → handler runs without SW error | ✅ |
| Manually trigger `rf-supabase-realtime` alarm → handler runs (was broken in v3.20.4) | ✅ |
| `PRAYER_FETCH` returns full timings (Fajr/Dhuhr/Asr/Maghrib/Isha) | ✅ |
| `SUPABASE_STATUS` returns `{ loggedIn: false }` | ✅ |
| `SUPABASE_TEST_CONNECTION` returns `{ ok: true, url: ... }` | ✅ |
| `SAVE_TAPE_TO_VAULT` returns `{ ok: true, noteId: ... }` | ✅ |
| `VOLUME_GET_STATE` / `VOLUME_GET` return current state | ✅ |
| `SYNC_GET_PROFILES` / `SYNC_STATUS` return state | ✅ |
| `GDRIVE_STATUS` returns state | ✅ |
| Popup prayer strip: "🕌 Ashar 15:14 −29m" | ✅ |
| Popup fast note: "🌙 Puasa sunnah berikutnya: Puasa Senin-Kamis (hari ini)" | ✅ |
| Popup habits strip: "📖 Ngaji 0 hal", "🏃 Olahraga" | ✅ |
| All 12 popup tool pages render without console errors | ✅ |
| SW console errors during entire test suite | 0 |

## Firefox compatibility

The Firefox addon (`agungkesmas/recallfox`) is **untouched** — Firefox SW
supports dynamic imports, `URL.createObjectURL`, SVG notification icons, and
keeps `setInterval` alive longer. The Chrome fixes use Firefox-compatible
patterns (e.g., `if (typeof URL.createObjectURL === 'function')`), so if
these changes were ever ported back they'd be no-ops in Firefox.

## Files changed

```
background.js              | +35 lines (helpers + alarm handlers), -8 lines (URL.createObjectURL + dynamic import)
lib/autobackup.js          | rewrote startBackupInterval to use browser.alarms; added handleBackupAlarm export
lib/clearcache.js          | icon-96.svg → icon-96.png (1 site)
content/content.js         | browser-aware sidebar error message
manifest.json              | version bump 3.20.4 → 3.20.5
```

Total: 18 icon replacements + 7 `URL.createObjectURL` replacements + 1
dynamic-import removal + 3 new `browser.alarms` registrations + 1
browser-aware error message.

## Manual testing checklist

1. Download the ZIP from the release assets.
2. Extract to a folder.
3. Open `chrome://extensions` → enable **Developer mode** (top right).
4. Click **Load unpacked** → select the extracted folder.
5. Open the popup → verify the prayer strip shows "🕌 [PrayerName] [Time] −[Countdown]".
6. Open `chrome://extensions` → click **Service worker** (under RecallFox) →
   verify NO errors in console.
7. In SW console, run `chrome.alarms.getAll(a => console.log(a))` → verify
   4 alarms: `rf-auto-discard`, `rf-prayer-reminder`, `rf-exercise-reminder`,
   `rf-auto-backup`.
8. Open popup → tab **Alat** → **Bersihkan Cache** → click **Bersihkan** →
   verify a notification appears WITH the RecallFox icon (was iconless before).
9. Capture a screenshot (Alt+Shift+5) → in the snapshot modal, click
   **Download** → verify the PNG file lands in `Downloads/RecallFox/`
   (would silently fail before FIX 2).
10. Open popup → tab **Alat** → **Backup** → click **Export Backup** →
    verify `recallfox-backup-YYYYMMDDHHMMSS.json` lands in Downloads
    (would silently fail before FIX 2).
11. Login to Supabase in **Sync Cloud** → wait 1 minute → check SW console
    for "Realtime alarm fired" log (was silent before FIX 3).
12. Leave the extension idle for 5+ minutes → check SW console for periodic
    "Prayer reminder" / "Exercise reminder" alarm fires (was unreliable
    before FIX 4).
13. Wait 6 hours (or temporarily set `backupIntervalHours: 0.1` in storage)
    → verify `auto-backup.json` is regenerated (would never fire on
    schedule before FIX 5).
