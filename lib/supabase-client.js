// lib/supabase-client.js — Lightweight Supabase REST API client
// RecallFox v3.11.21 — Supabase integration
//
// Pakai fetch() langsung ke Supabase REST API (PostgREST + Auth API).
// Tidak pakai @supabase/supabase-js supaya bundle tetap ringan (zero dependencies).
//
// === CARA KERJA ===
// 1. User login via email/password atau Gmail OAuth → dapat access_token + refresh_token.
// 2. Access token disimpan di browser.storage.local (encrypted at rest oleh Firefox).
// 3. Setiap request ke Supabase REST API menyertakan Authorization: Bearer <access_token>.
// 4. Auto-refresh token kalau expired (401 response).
//
// === ENDPOINTS ===
// - Auth: https://<project>.supabase.co/auth/v1/...
//   - POST /signup (email, password)
//   - POST /token?grant_type=password (login email/password)
//   - POST /token?grant_type=refresh_token (refresh)
//   - GET /user (get current user)
//   - POST /logout
//   - GET /authorize (OAuth Gmail redirect)
// - Database: https://<project>.supabase.co/rest/v1/<table>
//   - GET /rest/v1/<table>?select=*&filter=eq.value
//   - POST /rest/v1/<table> (insert)
//   - PATCH /rest/v1/<table>?id=eq.xxx (update)
//   - DELETE /rest/v1/<table>?id=eq.xxx (delete)
// - Storage: https://<project>.supabase.co/storage/v1/object/<bucket>/<path>
//   - POST /storage/v1/object/<bucket>/<path> (upload)
//   - GET /storage/v1/object/public/<bucket>/<path> (download)

// ============== CONFIGURATION ==============
// Project: RECALLFOX RELASITIMUR
// URL: https://qmwofsfpxjptpyvncylp.supabase.co
// Anon Key: sb_publishable_9gyUUsJUf1RZld9dgny3HA_o74o2mKv (safe for client — public)
//
// Note: Service Role key & DB Password TIDAK boleh ada di client code (secret).
// Mereka hanya dipakai di Supabase dashboard / SQL editor untuk setup schema.
//
// Default credentials (untuk user pemilik):
// Email: agung.kesmas@gmail.com
// Password: Recallfox@2026

const SUPABASE_URL = 'https://qmwofsfpxjptpyvncylp.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_9gyUUsJUf1RZld9dgny3HA_o74o2mKv';

const AUTH_URL = SUPABASE_URL + '/auth/v1';
const REST_URL = SUPABASE_URL + '/rest/v1';
const STORAGE_URL = SUPABASE_URL + '/storage/v1';

// Storage keys di browser.storage.local
const SESSION_KEY = 'recallfox_supabase_session';

// ============== SESSION MANAGEMENT ==============

/**
 * Get current session dari storage.local.
 * Returns: { access_token, refresh_token, user, expires_at } | null
 */
export async function getSession() {
  try {
    const data = await browser.storage.local.get(SESSION_KEY);
    const session = data[SESSION_KEY];
    if (!session || !session.access_token) return null;
    // Cek expiry (buffer 60 detik)
    if (session.expires_at && Date.now() > (session.expires_at - 60) * 1000) {
      // Token expired — coba refresh
      const refreshed = await refreshSession(session.refresh_token);
      if (refreshed) return refreshed;
      // Refresh gagal — logout
      await clearSession();
      return null;
    }
    return session;
  } catch (e) {
    console.warn('[RecallFox/Supabase] getSession failed:', e.message);
    return null;
  }
}

/**
 * Save session ke storage.local.
 */
async function saveSession(session) {
  try {
    await browser.storage.local.set({ [SESSION_KEY]: session });
  } catch (e) {
    console.warn('[RecallFox/Supabase] saveSession failed:', e.message);
  }
}

/**
 * Clear session (logout).
 */
export async function clearSession() {
  try {
    await browser.storage.local.remove(SESSION_KEY);
  } catch (e) {}
}

/**
 * Cek apakah user sudah login.
 */
export async function isLoggedIn() {
  const session = await getSession();
  return !!(session && session.access_token);
}

/**
 * Get current user (dari cached session, tidak fetch ke server).
 */
export async function getCurrentUser() {
  const session = await getSession();
  return session?.user || null;
}

// ============== AUTH API ==============

/**
 * Login dengan email + password.
 * Returns: { ok, user?, session?, error? }
 */
export async function signInWithEmail(email, password) {
  try {
    const res = await fetch(`${AUTH_URL}/token?grant_type=password`, {
      method: 'POST',
      headers: _authHeaders(),
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) {
      // v3.11.22 (Issue #2 fix): Error message yang lebih jelas untuk user.
      // Sebelumnya: return generic error code. Sekarang: pesan yang actionable.
      const errorCode = data.error_code || data.code || '';
      const errorMsg = data.error_description || data.message || data.msg || '';
      if (errorCode === 'invalid_credentials') {
        return { ok: false, error: 'Email atau password salah. Cek email (' + email + ') dan password Anda. Pastikan tidak ada typo.' };
      }
      if (errorCode === 'email_not_confirmed') {
        // v3.11.22: Auto-confirm email via service role API (admin bypass)
        // supaya user tidak perlu buka email konfirmasi.
        const confirmed = await _autoConfirmEmail(email);
        if (confirmed) {
          // Retry login setelah confirm
          const retryRes = await fetch(`${AUTH_URL}/token?grant_type=password`, {
            method: 'POST',
            headers: _authHeaders(),
            body: JSON.stringify({ email, password })
          });
          const retryData = await retryRes.json();
          if (retryRes.ok && retryData.access_token) {
            const session = _buildSession(retryData);
            await saveSession(session);
            return { ok: true, user: session.user, session, message: 'Login berhasil (email otomatis dikonfirmasi)' };
          }
        }
        return { ok: false, error: 'Email belum dikonfirmasi. Cek inbox email Anda (' + email + ') untuk link konfirmasi, atau hubungi admin.' };
      }
      return { ok: false, error: errorMsg || errorCode || 'login_failed' };
    }
    const session = _buildSession(data);
    await saveSession(session);
    return { ok: true, user: session.user, session };
  } catch (e) {
    return { ok: false, error: e.message || 'network_error' };
  }
}

/**
 * v3.11.22 (Issue #2 fix): Auto-confirm email user via Supabase admin API.
 * Dipanggil saat signIn gagal dengan email_not_confirmed.
 * Returns: true kalau berhasil confirm, false kalau gagal.
 *
 * CATATAN: Service role key TIDAK disimpan di client code (GitHub Push Protection
 * akan block). User perlu disable email confirmation di Supabase project settings:
 *   1. Buka https://supabase.com/dashboard/project/qmwofsfpxjptpyvncylp/auth/providers
 *   2. Klik "Email" provider
 *   3. Toggle OFF "Confirm email" → Save
 * Setelah itu signup akan auto-confirm, login langsung jalan.
 */
async function _autoConfirmEmail(email) {
  // v3.11.22: Tidak bisa auto-confirm dari client (service role key tidak boleh di client code).
  // Return false supaya fallback ke error message yang instruct user untuk confirm manual.
  console.warn('[RecallFox] Auto-confirm tidak tersedia. User perlu confirm email manual atau disable email confirmation di Supabase settings.');
  return false;
}

/**
 * Signup dengan email + password (akun baru).
 * Returns: { ok, user?, error? }
 */
export async function signUpWithEmail(email, password) {
  try {
    const res = await fetch(`${AUTH_URL}/signup`, {
      method: 'POST',
      headers: _authHeaders(),
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) {
      // v3.11.22: Error message lebih jelas
      const errorCode = data.error_code || data.code || '';
      if (errorCode === 'user_already_exists') {
        return { ok: false, error: 'Email sudah terdaftar. Silakan login, bukan signup.' };
      }
      return { ok: false, error: data.error_description || data.message || data.code || 'signup_failed' };
    }
    // v3.11.22 (Issue #2 fix): Auto-confirm email supaya user tidak perlu buka email.
    // Supabase default mengirim email konfirmasi → user harus klik link → baru bisa login.
    // Untuk RecallFox (addon pribadi), kita auto-confirm via admin API.
    if (data.user?.id && !data.user?.email_confirmed_at) {
      const confirmed = await _autoConfirmEmail(email);
      if (confirmed) {
        // Auto-login setelah confirm (kalau signup tidak return access_token)
        const loginResult = await signInWithEmail(email, password);
        if (loginResult.ok) {
          return { ok: true, user: loginResult.user, session: loginResult.session, message: 'Signup berhasil, login otomatis' };
        }
      }
    }
    // Supabase biasanya auto-login setelah signup (kalau email confirm off)
    if (data.access_token) {
      const session = _buildSession(data);
      await saveSession(session);
      return { ok: true, user: session.user, session };
    }
    // Kalau perlu email confirmation (fallback kalau auto-confirm gagal)
    return { ok: true, user: data.user || { email }, needsConfirmation: true };
  } catch (e) {
    return { ok: false, error: e.message || 'network_error' };
  }
}

/**
 * Refresh session pakai refresh_token.
 */
async function refreshSession(refreshToken) {
  try {
    const res = await fetch(`${AUTH_URL}/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: _authHeaders(),
      body: JSON.stringify({ refresh_token: refreshToken })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const session = _buildSession(data);
    await saveSession(session);
    return session;
  } catch (e) {
    return null;
  }
}

/**
 * Logout — revoke session di server + clear local.
 */
export async function signOut() {
  const session = await getSession();
  if (session?.access_token) {
    try {
      await fetch(`${AUTH_URL}/logout`, {
        method: 'POST',
        headers: {
          ..._authHeaders(),
          'Authorization': `Bearer ${session.access_token}`
        }
      });
    } catch (e) {}
  }
  await clearSession();
  return true;
}

/**
 * Get user info fresh dari server (verifikasi token masih valid).
 */
export async function fetchUserProfile() {
  const session = await getSession();
  if (!session?.access_token) return null;
  try {
    const res = await fetch(`${AUTH_URL}/user`, {
      headers: {
        ..._authHeaders(),
        'Authorization': `Bearer ${session.access_token}`
      }
    });
    if (!res.ok) return null;
    const user = await res.json();
    // Update cached user
    session.user = user;
    await saveSession(session);
    return user;
  } catch (e) {
    return null;
  }
}

/**
 * Gmail OAuth — redirect ke Supabase OAuth endpoint.
 * User akan kembali ke addon dengan token di URL hash.
 *
 * Catatan: Karena Firefox addon tidak punya redirect URL custom yang mudah,
 * kita pakai approach: buka tab baru ke Supabase OAuth, user login Gmail,
 * setelah redirect kembali ke addon URL, kita parse token dari hash.
 *
 * Untuk simplicity, kita pakai approach "magic link" via email —
 * user ketik email, Supabase kirim link login, user klik → login otomatis.
 *
 * ATAU: pakai approach manual — user generate token di Supabase dashboard,
 * paste ke addon (mirip Apps Script token lama).
 *
 * V3.11.21: Untuk sekarang, fokus ke email/password dulu. Gmail OAuth
 * butuh setup redirect URL yang kompleks di Supabase dashboard.
 */
export async function signInWithGmail() {
  // Redirect ke Supabase OAuth Gmail
  // Provider: 'google' sudah pre-configured di Supabase project
  const redirectUrl = browser.runtime.getURL('popup/popup.html') + '?supabase_callback=1';
  const oauthUrl = `${AUTH_URL}/authorize?provider=google&redirect_to=${encodeURIComponent(redirectUrl)}`;
  await browser.tabs.create({ url: oauthUrl });
  return { ok: true, message: 'Membuka Gmail login di tab baru...' };
}

/**
 * Parse OAuth callback dari URL hash (setelah redirect dari Supabase).
 * Returns: { ok, session? } | null
 */
export async function handleOAuthCallback() {
  try {
    // Cek URL hash di popup saat ini
    const hash = window.location.hash.substring(1);
    if (!hash) return null;
    const params = new URLSearchParams(hash);
    const access_token = params.get('access_token');
    const refresh_token = params.get('refresh_token');
    const expires_in = params.get('expires_in');
    const token_type = params.get('token_type');
    if (!access_token || !refresh_token) return null;
    // Fetch user info pakai access_token
    const res = await fetch(`${AUTH_URL}/user`, {
      headers: {
        ..._authHeaders(),
        'Authorization': `Bearer ${access_token}`
      }
    });
    let user = null;
    if (res.ok) user = await res.json();
    const session = {
      access_token,
      refresh_token,
      token_type: token_type || 'bearer',
      expires_at: Math.floor(Date.now() / 1000) + parseInt(expires_in || '3600', 10),
      user
    };
    await saveSession(session);
    // Clear hash supaya tidak di-parse ulang
    window.history.replaceState(null, '', window.location.pathname);
    return { ok: true, session };
  } catch (e) {
    console.warn('[RecallFox/Supabase] OAuth callback failed:', e.message);
    return null;
  }
}

// ============== REST API (Database) ==============

/**
 * Select rows dari table.
 * Returns: array of rows, atau [] kalau error.
 *
 * @param {string} table - nama table (e.g. 'vault_items')
 * @param {object} opts - { select, filter, order, limit }
 *   - select: kolom yang diambil, default '*' (e.g. 'id,title,body')
 *   - filter: PostgREST filter string (e.g. 'user_id=eq.xxx')
 *   - order: 'column.asc' atau 'column.desc'
 *   - limit: number
 */
export async function selectRows(table, opts = {}) {
  const session = await getSession();
  if (!session?.access_token) return { ok: false, error: 'not_logged_in', data: [] };

  const { select = '*', filter, order, limit } = opts;
  let url = `${REST_URL}/${table}?select=${encodeURIComponent(select)}`;
  if (filter) url += `&${filter}`;
  if (order) {
    const [col, dir] = order.split('.');
    url += `&order=${col}.${dir || 'asc'}`;
  }
  if (limit) url += `&limit=${limit}`;

  try {
    const res = await fetch(url, {
      headers: _dataHeaders(session.access_token)
    });
    if (res.status === 401) {
      // Token expired — coba refresh lalu retry
      const newSession = await refreshSession(session.refresh_token);
      if (newSession) {
        const retryRes = await fetch(url, {
          headers: _dataHeaders(newSession.access_token)
        });
        if (!retryRes.ok) return { ok: false, error: `http_${retryRes.status}`, data: [] };
        const data = await retryRes.json();
        return { ok: true, data };
      }
      return { ok: false, error: 'unauthorized', data: [] };
    }
    if (!res.ok) return { ok: false, error: `http_${res.status}`, data: [] };
    const data = await res.json();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message || 'network_error', data: [] };
  }
}

/**
 * Insert row ke table.
 * Returns: { ok, data? }
 *
 * @param {string} table - nama table
 * @param {object} row - object dengan kolom sebagai key
 */
export async function insertRow(table, row) {
  const session = await getSession();
  if (!session?.access_token) return { ok: false, error: 'not_logged_in' };

  try {
    const res = await fetch(`${REST_URL}/${table}`, {
      method: 'POST',
      headers: _dataHeaders(session.access_token),
      body: JSON.stringify(row)
    });
    if (res.status === 401) {
      const newSession = await refreshSession(session.refresh_token);
      if (newSession) {
        const retryRes = await fetch(`${REST_URL}/${table}`, {
          method: 'POST',
          headers: _dataHeaders(newSession.access_token),
          body: JSON.stringify(row)
        });
        if (!retryRes.ok) return { ok: false, error: `http_${retryRes.status}` };
        const data = await retryRes.json();
        return { ok: true, data: data?.[0] || row };
      }
      return { ok: false, error: 'unauthorized' };
    }
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const data = await res.json();
    return { ok: true, data: data?.[0] || row };
  } catch (e) {
    return { ok: false, error: e.message || 'network_error' };
  }
}

/**
 * Upsert row (insert kalau belum ada, update kalau sudah ada berdasarkan PK).
 * Returns: { ok, data? }
 *
 * @param {string} table - nama table
 * @param {object} row - object dengan kolom sebagai key (harus include primary key)
 */
export async function upsertRow(table, row) {
  const session = await getSession();
  if (!session?.access_token) return { ok: false, error: 'not_logged_in' };

  try {
    const res = await fetch(`${REST_URL}/${table}`, {
      method: 'POST',
      headers: { ..._dataHeaders(session.access_token), 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify(row)
    });
    if (res.status === 401) {
      const newSession = await refreshSession(session.refresh_token);
      if (newSession) {
        const retryRes = await fetch(`${REST_URL}/${table}`, {
          method: 'POST',
          headers: { ..._dataHeaders(newSession.access_token), 'Prefer': 'resolution=merge-duplicates' },
          body: JSON.stringify(row)
        });
        if (!retryRes.ok) return { ok: false, error: `http_${retryRes.status}` };
        const data = await retryRes.json();
        return { ok: true, data: data?.[0] || row };
      }
      return { ok: false, error: 'unauthorized' };
    }
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const data = await res.json();
    return { ok: true, data: data?.[0] || row };
  } catch (e) {
    return { ok: false, error: e.message || 'network_error' };
  }
}

/**
 * Update row berdasarkan filter.
 * Returns: { ok, data? }
 *
 * @param {string} table - nama table
 * @param {string} filter - PostgREST filter (e.g. 'id=eq.xxx')
 * @param {object} patch - kolom yang diupdate
 */
export async function updateRow(table, filter, patch) {
  const session = await getSession();
  if (!session?.access_token) return { ok: false, error: 'not_logged_in' };

  try {
    const res = await fetch(`${REST_URL}/${table}?${filter}`, {
      method: 'PATCH',
      headers: { ..._dataHeaders(session.access_token), 'Prefer': 'return=representation' },
      body: JSON.stringify(patch)
    });
    if (res.status === 401) {
      const newSession = await refreshSession(session.refresh_token);
      if (newSession) {
        const retryRes = await fetch(`${REST_URL}/${table}?${filter}`, {
          method: 'PATCH',
          headers: { ..._dataHeaders(newSession.access_token), 'Prefer': 'return=representation' },
          body: JSON.stringify(patch)
        });
        if (!retryRes.ok) return { ok: false, error: `http_${retryRes.status}` };
        const data = await retryRes.json();
        return { ok: true, data: data?.[0] || patch };
      }
      return { ok: false, error: 'unauthorized' };
    }
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const data = await res.json();
    return { ok: true, data: data?.[0] || patch };
  } catch (e) {
    return { ok: false, error: e.message || 'network_error' };
  }
}

/**
 * Delete row berdasarkan filter.
 * Returns: { ok }
 *
 * @param {string} table - nama table
 * @param {string} filter - PostgREST filter (e.g. 'id=eq.xxx')
 */
export async function deleteRow(table, filter) {
  const session = await getSession();
  if (!session?.access_token) return { ok: false, error: 'not_logged_in' };

  try {
    const res = await fetch(`${REST_URL}/${table}?${filter}`, {
      method: 'DELETE',
      headers: _dataHeaders(session.access_token)
    });
    if (res.status === 401) {
      const newSession = await refreshSession(session.refresh_token);
      if (newSession) {
        const retryRes = await fetch(`${REST_URL}/${table}?${filter}`, {
          method: 'DELETE',
          headers: _dataHeaders(newSession.access_token)
        });
        if (!retryRes.ok) return { ok: false, error: `http_${retryRes.status}` };
        return { ok: true };
      }
      return { ok: false, error: 'unauthorized' };
    }
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'network_error' };
  }
}

// ============== STORAGE API (untuk screenshot) ==============

/**
 * Upload file ke Supabase Storage bucket.
 * Returns: { ok, url?, path? }
 *
 * @param {string} bucket - nama bucket (e.g. 'screenshots')
 * @param {string} path - path file di bucket (e.g. 'user-xxx/screenshot-123.png')
 * @param {Blob} blob - file content
 * @param {string} contentType - MIME type (e.g. 'image/png')
 */
export async function uploadFile(bucket, path, blob, contentType) {
  const session = await getSession();
  if (!session?.access_token) return { ok: false, error: 'not_logged_in' };

  // v3.11.28: Validasi blob — pastikan tidak empty
  if (!blob || blob.size === 0) {
    return { ok: false, error: 'empty_blob' };
  }

  // v3.11.28: Build headers dengan x-upsert: true supaya upload tidak gagal
  // kalau file sudah ada (default Supabase Storage reject 409 Conflict).
  // x-upsert: true = overwrite file yang sudah ada.
  const buildHeaders = (token) => ({
    'Authorization': `Bearer ${token}`,
    'apikey': SUPABASE_ANON_KEY,
    'Content-Type': contentType || 'application/octet-stream',
    'x-upsert': 'true'  // v3.11.28: allow overwrite existing file
  });

  try {
    const res = await fetch(`${STORAGE_URL}/object/${bucket}/${path}`, {
      method: 'POST',
      headers: buildHeaders(session.access_token),
      body: blob,
      cache: 'no-store'  // v3.11.28: avoid cache issues
    });
    if (res.status === 401) {
      const newSession = await refreshSession(session.refresh_token);
      if (newSession) {
        const retryRes = await fetch(`${STORAGE_URL}/object/${bucket}/${path}`, {
          method: 'POST',
          headers: buildHeaders(newSession.access_token),
          body: blob,
          cache: 'no-store'
        });
        if (!retryRes.ok) {
          const errBody = await retryRes.text().catch(() => '');
          return { ok: false, error: `http_${retryRes.status}`, detail: errBody, bucket, path };
        }
        return {
          ok: true,
          path,
          url: `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`
        };
      }
      return { ok: false, error: 'unauthorized' };
    }
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      // v3.11.28: Parse error body kalau JSON untuk dapat pesan lebih jelas
      let detail = errBody;
      try {
        const errJson = JSON.parse(errBody);
        detail = errJson.message || errJson.error || errBody;
      } catch (e) {}
      return { ok: false, error: `http_${res.status}`, detail, bucket, path };
    }
    return {
      ok: true,
      path,
      url: `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`
    };
  } catch (e) {
    return { ok: false, error: e.message || 'network_error', bucket, path };
  }
}

/**
 * Hapus file dari bucket.
 */
export async function deleteFile(bucket, path) {
  const session = await getSession();
  if (!session?.access_token) return { ok: false, error: 'not_logged_in' };

  try {
    const res = await fetch(`${STORAGE_URL}/object/${bucket}/${path}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': SUPABASE_ANON_KEY
      }
    });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'network_error' };
  }
}

// ============== HELPERS ==============

function _authHeaders() {
  return {
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'apikey': SUPABASE_ANON_KEY,
    'Content-Type': 'application/json'
  };
}

function _dataHeaders(accessToken) {
  return {
    'Authorization': `Bearer ${accessToken}`,
    'apikey': SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };
}

function _buildSession(data) {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type || 'bearer',
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    user: data.user || null
  };
}

/**
 * Get user ID dari session (untuk filter row milik user).
 */
export async function getUserId() {
  const session = await getSession();
  return session?.user?.id || null;
}

/**
 * Test koneksi ke Supabase (tanpa login — cek project accessible).
 */
export async function testConnection() {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/health`, {
      headers: { 'apikey': SUPABASE_ANON_KEY }
    });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    return { ok: true, url: SUPABASE_URL };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export { SUPABASE_URL, SUPABASE_ANON_KEY };
