# RecallFox v3.20.27 — Industry-standard session persistence (fix "sehari logout")

**Tanggal:** 2026-08-04
**Base:** v3.20.26
**Scope:** Auth/session fix di lib/supabase-client.js + background.js. Tidak ada schema change.

## TL;DR

User report: "login recallfox di addon/extension itu kenapa ga ada sehari logout ya? di pwa juga. kenapa tidak dibuat standar industri aja. kan sering dipake."

**Root cause:** 3 bug di session management:

1. **Race condition** — saat access_token expired (1 jam), multiple concurrent `getSession()` calls ALL try to refresh. Supabase rotates refresh_token — first refresh succeeds + invalidates old token, second refresh FAILS (401) → `clearSession()` → **USER LOGGED OUT**.
2. **Aggressive logout** — `refreshSession()` returns `null` for ALL failures (network error, 5xx, 401) → `getSession()` always calls `clearSession()`. Logout terjadi bahkan pada transient failures.
3. **No proactive refresh** — token hanya di-refresh saat expired AND user aktif. No background alarm untuk keep session alive.

**Fix (industry standard):**

1. **Refresh lock** (Promise-based mutex) — only one refresh in flight at a time. Other callers await the same Promise → no race condition.
2. **Proactive refresh** — refresh when token is within 5 min of expiry (not just after). Reduces window for race condition.
3. **Background alarm** — `browser.alarms` fires every 45 min, calls `proactiveRefresh()` → `getSession()` → refreshes if needed. Keeps refresh_token alive indefinitely (Supabase extends expiry on each rotation).
4. **Graceful failure** — only `clearSession()` on HTTP 401 (refresh_token truly invalid). For network error / 5xx, return old session — don't logout on transient failures.

## Perubahan

### 1. `lib/supabase-client.js` — rewrite session management

**`getSession()`** — new logic:
- If token valid (>5 min remaining) → return as-is
- If token expires within 5 min OR already expired → acquire refresh lock
  - If lock acquired (first caller) → call `_doRefreshWithLock()`
  - If lock NOT acquired (another refresh in progress) → await same Promise
- If refresh succeeds → return new session
- If refresh returns `false` (HTTP 401) → `clearSession()`, return null (legitimate logout)
- If refresh returns `null` (network/5xx) → return old session (don't logout on transient)

**`_doRefreshWithLock(refreshToken, oldSession)`** — new internal function:
- Returns `session` (object) on success
- Returns `false` on HTTP 401/403 (refresh_token invalid → logout)
- Returns `null` on network error / 5xx (transient → keep old session)

**`refreshSession(refreshToken)`** — now delegates to `_doRefreshWithLock()` for backward compat.

**`proactiveRefresh()`** — new exported function:
- Calls `getSession()` (which triggers refresh if needed)
- Returns `true` if session still valid, `false` if not logged in
- Called by background alarm every 45 min

**New constants:**
- `PROACTIVE_REFRESH_THRESHOLD = 300` — refresh when token expires within 5 min
- `_refreshInFlight` — Promise-based mutex (null when no refresh in progress)

### 2. `background.js` — proactive refresh alarm

**`startProactiveTokenRefresh()`** — new function:
- Creates `browser.alarms.create('rf-supabase-refresh', { periodInMinutes: 45 })`
- Called at top-level (runs on every SW load)

**Alarm handler** — new case in `browser.alarms.onAlarm`:
- `if (alarm.name === 'rf-supabase-refresh')` → call `proactiveRefresh()`
- Firefox: uses dynamic `import('./lib/supabase-client.js')`
- Chrome: uses statically-imported `proactiveRefresh` (Chrome MV3 forbids dynamic import in SW)

### 3. PWA `src/main.js` — session heartbeat

**`startSessionHeartbeat()`** — new function:
- `setInterval` every 30 min → calls `getSession()` → triggers `autoRefreshToken` in `@supabase/supabase-js`
- If session lost → reload to login page

**`visibilitychange` listener:**
- When tab becomes visible → immediately call `getSession()`
- Catches case where user left tab in background for hours

## Behavior flow

### Sebelum v3.20.27 (bug — "sehari logout")

1. User login → session saved (access_token 1h, refresh_token 7d default)
2. User closes browser, comes back next day
3. Multiple things call `getSession()` simultaneously (sync, realtime, popup)
4. All detect token expired → all try to refresh with SAME refresh_token
5. Supabase: first refresh OK + rotates token, second refresh 401 (old token invalid)
6. `getSession()` sees 401 → `clearSession()` → **LOGOUT** ❌

### Sesudah v3.20.27 (fix — industry standard)

1. User login → session saved
2. Background alarm fires every 45 min → `proactiveRefresh()` → `getSession()`
3. `getSession()` detects token near expiry → acquires refresh lock → refreshes
4. New session saved (new access_token + new refresh_token + extended expiry)
5. User closes browser → alarm stops (SW terminated)
6. User comes back next day → SW restarts → alarm re-registered → `getSession()` called
7. If token expired → refresh lock → single refresh → success → session alive ✅
8. If network error during refresh → return old session, don't logout, retry later ✅
9. If refresh_token truly invalid (401) → logout (legitimate) ✅

## Yang TIDAK berubah (AMAN dari regression)

| File | Status |
|---|---|
| `lib/salahtime.js` | UNCHANGED |
| `lib/storage.js` | UNCHANGED |
| `lib/supabase-sync.js` | UNCHANGED — sync logic tetap sama |
| `lib/assistant.js` | UNCHANGED |
| `settings/settings.*` | UNCHANGED |
| `manifest.json commands` | UNCHANGED |
| `content/*.js` | UNCHANGED |
| `popup/popup.js` | UNCHANGED |
| Schema database | UNCHANGED |
| `_buildSession()` | UNCHANGED — tetap `{ access_token, refresh_token, expires_at, user }` |
| `signInWithEmail()`, `signUpWithEmail()`, `signOut()` | UNCHANGED |
| `selectRows`, `upsertRow`, `deleteRow` etc. | UNCHANGED — still call `refreshSession()` on 401 |

## Performance considerations

- **Refresh lock**: in-memory Promise, no storage overhead. Prevents N concurrent refresh requests → only 1 HTTP call to Supabase.
- **Alarm every 45 min**: Chrome MV3 minimum alarm period is 0.5 min, but 45 min is sufficient (access_token lifetime is 60 min, proactive threshold is 5 min → 45 min alarm catches it before expiry).
- **PWA heartbeat every 30 min**: lightweight `getSession()` call, no HTTP if token still valid (just reads from localStorage + checks expiry).
- **visibilitychange**: only fires when tab becomes visible — no overhead when in background.

## Files changed

```
lib/supabase-client.js        | +100 lines (refresh lock + proactive refresh + graceful failure)
background.js                 | +20 lines (alarm + handler)
manifest.json                 | version bump → 3.20.27
CHANGELOG-v3.20.27.md         | new (this file)
```

## Testing checklist

### Test 1: Login → keep session alive for >1 hour
1. Login ke Supabase di addon
2. Tunggu >1 jam (atau set `expires_at` ke waktu lalu di DevTools storage)
3. Buka popup → verify masih logged in (tidak logout)
4. Cek SW console: should see "Token refreshed OK" log

### Test 2: Race condition — multiple concurrent getSession() calls
1. Login → set `expires_at` ke waktu lalu di DevTools storage
2. Trigger multiple sync operations simultaneously (e.g., tambah item + pull + push)
3. Verify: hanya 1 refresh request ke Supabase (cek Network tab)
4. Verify: tidak logout

### Test 3: Network error during refresh → don't logout
1. Login → set `expires_at` ke waktu lalu
2. Block `nominatim.openstreetmap.org` di DevTools (atau matikan internet)
3. Trigger `getSession()` → refresh attempt fails (network error)
4. Verify: session masih ada (tidak logout) — old session returned
5. Restore internet → trigger `getSession()` lagi → refresh succeeds

### Test 4: Refresh_token invalid (401) → logout
1. Login → set refresh_token ke "invalid_token" di DevTools storage
2. Set `expires_at` ke waktu lalu
3. Trigger `getSession()` → refresh attempt returns 401
4. Verify: session cleared, user logged out (legitimate)

### Test 5: Background alarm fires every 45 min
1. Login → biarkan addon running
2. Tunggu 45+ menit (atau trigger alarm manually via `chrome.alarms.create` di DevTools)
3. Cek SW console: "Proactive refresh alarm fired" + "Token refreshed OK"
4. Verify: session masih valid

### Test 6: PWA heartbeat
1. Login di PWA → biarkan tab terbuka
2. Tunggu 30+ menit
3. Cek console: "Session heartbeat: OK, expires_at = ..."
4. Verify: session masih valid

### Test 7: PWA visibilitychange
1. Login di PWA → switch ke tab lain
2. Tunggu 1+ jam
3. Switch back ke PWA tab
4. Cek console: "Tab visible again — session OK"
5. Verify: session masih valid (atau auto-refreshed)

## Compatibility

- **Firefox**: tag `v3.20.27` + `v3.20.27-stable`
- **Chrome**: tag `v3.20.27-chrome` + `v3.20.27-chrome-stable`
- **PWA**: version `1.11.9`
- Code 100% identical antara Firefox dan Chrome untuk fitur ini (supabase-client.js identical, background.js differs only in static vs dynamic import).

— *Implemented by Super Z on 2026-08-04, fix bug user report tentang "sehari logout" di addon + PWA.*
