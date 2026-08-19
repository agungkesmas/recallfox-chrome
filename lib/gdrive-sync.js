// lib/gdrive-sync.js — Bridge RecallFox ↔ Google Apps Script Web App
// RecallFox v3.8.1 — Issue #1, #2, #6
//
// Modul ini menghubungkan addon RecallFox dengan Google Apps Script Web App
// yang sudah di-deploy user. Setiap kali ada operasi simpan/hapus di storage,
// modul ini akan async POST ke Web App URL → Apps Script upsert ke sheet yang sesuai.
//
// === CARA KERJA ===
// 1. User set gdriveSyncEnabled=true + gdriveWebAppUrl + gdriveAuthToken di Settings.
// 2. storage.js / popup.js / background.js panggil GDriveSync.notify('save_prompt', item)
//    (async, fire-and-forget — tidak block UI).
// 3. Modul ini queue + debounce request, kirim via fetch() ke Web App.
// 4. Jika gagal (network/offline), simpan ke queue, retry nanti.
//
// === PRIVACY ===
// - Hanya aktif kalau user explicit enable + isi URL + token.
// - API key AI Assistant TIDAK di-sync (di-mask di sisi client sebelum kirim).
// - Token disimpan di browser.storage.local (encrypted at rest oleh Firefox).

import { getSettings, saveSettings } from './storage.js';

const QUEUE_KEY = 'recallfox_gdrive_queue';
const META_KEY = 'recallfox_gdrive_meta';

// Action name → RecallFox item type/sheet mapping (semua action yang didukung)
const ACTION_MAP = {
  // Vault items (save = upsert, delete = remove)
  save_prompt: 'save_prompt',
  save_konteks: 'save_konteks',
  save_link: 'save_link',
  save_bundle: 'save_bundle',
  save_snapshot: 'save_snapshot',
  save_screenshot: 'save_screenshot',
  save_catatan: 'save_catatan',
  save_topping: 'save_topping',
  save_assistant_msg: 'save_assistant_msg',
  save_habit: 'save_habit',
  save_prayer: 'save_prayer',
  save_volume: 'save_volume',
  save_blocklist: 'save_blocklist',
  save_setting: 'save_setting',
  save_backup_log: 'save_backup_log',
  save_sync_meta: 'save_sync_meta',
  // Deletes
  delete_prompt: 'delete_prompt',
  delete_konteks: 'delete_konteks',
  delete_link: 'delete_link',
  delete_bundle: 'delete_bundle',
  delete_snapshot: 'delete_snapshot',
  delete_screenshot: 'delete_screenshot',
  delete_catatan: 'delete_catatan',
  delete_topping: 'delete_topping',
  delete_blocklist: 'delete_blocklist'
};

// Field yang akan di-mask sebelum kirim ke GDrive (privacy)
const SENSITIVE_FIELDS = new Set([
  'assistantApiKey',
  'assistantFallbackApiKey',
  'gdriveAuthToken'
]);

// ============== QUEUE PERSISTENCE ==============

async function _loadQueue() {
  try {
    const data = await browser.storage.local.get(QUEUE_KEY);
    return data[QUEUE_KEY] || [];
  } catch (e) { return []; }
}

async function _saveQueue(queue) {
  try {
    await browser.storage.local.set({ [QUEUE_KEY]: queue });
  } catch (e) {
    console.warn('[GDriveSync] Failed to persist queue:', e.message);
  }
}

async function _loadMeta() {
  try {
    const data = await browser.storage.local.get(META_KEY);
    return data[META_KEY] || {
      lastSyncAt: null,
      lastError: null,
      totalSynced: 0,
      totalFailed: 0,
      queueLength: 0
    };
  } catch (e) {
    return { lastSyncAt: null, lastError: null, totalSynced: 0, totalFailed: 0, queueLength: 0 };
  }
}

async function _saveMeta(meta) {
  try {
    await browser.storage.local.set({ [META_KEY]: meta });
  } catch (e) {}
}

// ============== PUBLIC API ==============

/**
 * Cek apakah GDrive sync aktif & terkonfigurasi.
 */
export async function isGDriveSyncEnabled() {
  try {
    const s = await getSettings();
    return !!(s.gdriveSyncEnabled && s.gdriveWebAppUrl && s.gdriveAuthToken);
  } catch (e) { return false; }
}

/**
 * Notify (fire-and-forget) bahwa ada operasi save/delete.
 * Akan enqueue + schedule flush.
 *
 * @param {string} action  — salah satu dari ACTION_MAP
 * @param {object} data    — payload (item fields, atau {id} untuk delete)
 * @returns {Promise<boolean>} — true kalau enqueued, false kalau sync disabled
 */
export async function notify(action, data) {
  if (!ACTION_MAP[action]) {
    console.warn('[GDriveSync] Unknown action:', action);
    return false;
  }
  if (!(await isGDriveSyncEnabled())) return false;

  // Sanitize: mask field sensitif sebelum kirim
  const sanitized = _sanitizeData(data);

  const queue = await _loadQueue();
  queue.push({
    action,
    data: sanitized,
    ts: Date.now(),
    attempts: 0
  });
  await _saveQueue(queue);

  _scheduleFlush();
  return true;
}

/**
 * Flush queue sekarang. Dipanggil oleh:
 *   - _scheduleFlush (debounced 2 detik)
 *   - manual tombol "Sync sekarang" di Settings
 *   - alarm periodik dari background.js
 *
 * @returns {Promise<{synced:number, failed:number, remaining:number}>}
 */
export async function flushNow() {
  // v3.10.1 (Issue 1 fix): Validasi explicit + auto-enable
  const settings = await getSettings();
  if (!settings.gdriveWebAppUrl) {
    return { synced: 0, failed: 0, remaining: 0, reason: 'NO_URL', error: 'URL belum diisi' };
  }
  if (!settings.gdriveAuthToken) {
    return { synced: 0, failed: 0, remaining: 0, reason: 'NO_TOKEN', error: 'Token belum diisi' };
  }
  // Auto-enable sync kalau URL+token sudah ada (user jelas mau sync)
  if (!settings.gdriveSyncEnabled) {
    await saveSettings({ gdriveSyncEnabled: true });
    console.log('[RecallFox/GDrive] Auto-enabled sync (flush requested, URL+token present)');
  }

  const webAppUrl = settings.gdriveWebAppUrl;
  const token = settings.gdriveAuthToken;

  const queue = await _loadQueue();
  if (queue.length === 0) {
    return { synced: 0, failed: 0, remaining: 0 };
  }

  // Proses dalam batch kecil (max 15 per batch — hindari timeout Apps Script ~6 menit)
  const BATCH_SIZE = 15;
  const batch = queue.slice(0, BATCH_SIZE);
  const remaining = queue.slice(BATCH_SIZE);

  let synced = 0, failed = 0;
  // Kirim satu-per-satu via Promise.all dengan concurrency 4 (Apps Script terbatas 30 detik per request)
  const CONCURRENCY = 4;
  const chunks = [];
  for (let i = 0; i < batch.length; i += CONCURRENCY) {
    chunks.push(batch.slice(i, i + CONCURRENCY));
  }

  const failedItems = [];
  for (const chunk of chunks) {
    const results = await Promise.allSettled(
      chunk.map(item => _sendSingle(webAppUrl, token, item.action, item.data))
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const origItem = chunk[i];
      if (r.status === 'fulfilled' && r.value && r.value.ok) {
        synced++;
      } else {
        failed++;
        origItem.attempts = (origItem.attempts || 0) + 1;
        // Retry sampai 3x, lalu drop
        if (origItem.attempts < 3) {
          failedItems.push(origItem);
        }
      }
    }
  }

  // Susun ulang queue: item yang gagal + item yang belum diproses
  const newQueue = [...failedItems, ...remaining];
  await _saveQueue(newQueue);

  // Update meta
  const meta = await _loadMeta();
  if (synced > 0) {
    meta.lastSyncAt = new Date().toISOString();
    meta.totalSynced += synced;
    meta.lastError = null;
    // Update juga settings.gdriveLastSyncAt supaya UI settings ikut update
    try {
      const s = await getSettings();
      s.gdriveLastSyncAt = meta.lastSyncAt;
      s.gdriveLastError = null;
      await browser.storage.local.set({ recallfox_vault: { ...((await browser.storage.local.get('recallfox_vault')).recallfox_vault || {}), settings: s } });
    } catch (e) {}
  }
  if (failed > 0) {
    const lastErr = failedItems[0]?.lastError || 'BATCH_FAILED';
    meta.lastError = lastErr;
    meta.totalFailed += failed;
    try {
      const s = await getSettings();
      s.gdriveLastError = lastErr;
      await browser.storage.local.set({ recallfox_vault: { ...((await browser.storage.local.get('recallfox_vault')).recallfox_vault || {}), settings: s } });
    } catch (e) {}
  }
  meta.queueLength = newQueue.length;
  await _saveMeta(meta);

  // Jika masih ada sisanya, schedule flush lagi
  if (newQueue.length > 0) {
    _scheduleFlush(10000); // 10 detik lagi
  }

  return { synced, failed, remaining: newQueue.length };
}

/**
 * Upload screenshot full image ke Drive via multipart/form-data.
 * Dipakai oleh capture.js / overlay.js setelah simpan screenshot ke vault.
 *
 * @param {object} screenshotItem — vault item type=screenshot (sudah ada id)
 * @param {string} dataUrl — full-size data URL (data:image/png;base64,...)
 * @returns {Promise<{ok, gdriveFileId?, gdriveFileUrl?, error?}>}
 */
export async function uploadScreenshot(screenshotItem, dataUrl) {
  if (!(await isGDriveSyncEnabled())) return { ok: false, reason: 'disabled' };
  const settings = await getSettings();
  if (!settings.gdriveSyncScreenshots) return { ok: false, reason: 'screenshots_disabled' };

  const webAppUrl = settings.gdriveWebAppUrl;
  const token = settings.gdriveAuthToken;

  // v3.11.20 (Issue: screenshot tidak sync ke Drive): FIX — kirim sebagai JSON+base64
  // alih-alih FormData/multipart. Alasan:
  //   1. Firefox MV3 background script tidak reliable kirim binary FormData via fetch()
  //   2. Server-side _parseMultipart corrupt binary image data (PNG bytes mengandung
  //      sequences yang terlihat seperti boundary)
  //   3. Authorization header tidak terkirim dengan FormData — token hanya di body
  //      yang tidak bisa di-extract oleh parser multipart
  //
  // Sekarang: kirim base64 dalam JSON body — sama dengan sync_state yang sudah terbukti jalan.

  // Parse data URL → extract base64
  const match = dataUrl.match(/^data:(image\/[a-z]+);base64,(.+)$/i);
  if (!match) return { ok: false, error: 'INVALID_DATA_URL' };
  const mimeType = match[1];
  const base64Data = match[2];
  const format = mimeType === 'image/jpeg' ? 'jpeg' : 'png';

  // Compress: kalau image > 2MB base64, coba re-encode sebagai JPEG quality 80
  // (Apps Script POST limit ~10MB, tapi praktis <5MB supaya cepat)
  let finalBase64 = base64Data;
  let finalMimeType = mimeType;
  let finalFormat = format;
  const base64Bytes = Math.floor(base64Data.length * 0.75);
  console.log('[RecallFox/GDrive] Screenshot upload size:', (base64Bytes / 1024).toFixed(1), 'KB');

  if (base64Bytes > 2 * 1024 * 1024 && format === 'png') {
    // Coba compress via OffscreenCanvas (background script punya akses)
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const compressedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
      bitmap.close();
      // Convert compressed blob to base64
      const reader = new FileReader();
      finalBase64 = await new Promise(resolve => {
        reader.onload = () => {
          const result = reader.result;
          const m = result.match(/^data:image\/jpeg;base64,(.+)$/);
          resolve(m ? m[1] : result);
        };
        reader.readAsDataURL(compressedBlob);
      });
      finalMimeType = 'image/jpeg';
      finalFormat = 'jpeg';
      console.log('[RecallFox/GDrive] Compressed to JPEG:', (Math.floor(finalBase64.length * 0.75) / 1024).toFixed(1), 'KB');
    } catch (e) {
      console.warn('[RecallFox/GDrive] Compression failed, sending original:', e.message);
    }
  }

  // Build metadata (sama seperti sebelumnya)
  const metadata = {
    id: screenshotItem.id,
    title: screenshotItem.title,
    source: screenshotItem.source,
    screenshotMode: screenshotItem.screenshotMode,
    screenshotWidth: screenshotItem.screenshotWidth,
    screenshotHeight: screenshotItem.screenshotHeight,
    screenshotFormat: finalFormat,
    screenshotBytes: Math.floor(finalBase64.length * 0.75),
    thumbnailDataUrl: (screenshotItem.thumbnailDataUrl || '').slice(0, 2048),
    tags: screenshotItem.tags,
    category: screenshotItem.category,
    favorite: screenshotItem.favorite,
    archived: screenshotItem.archived,
    useCount: screenshotItem.useCount,
    lastUsedAt: screenshotItem.lastUsedAt,
    createdAt: screenshotItem.createdAt
  };

  // Kirim sebagai JSON dengan base64 image data
  const body = JSON.stringify({
    action: 'upload_screenshot',
    token: token,
    metadata: metadata,
    mimeType: finalMimeType,
    base64Data: finalBase64
  });

  console.log('[RecallFox/GDrive] Uploading screenshot as JSON+base64, total payload:', (body.length / 1024).toFixed(1), 'KB');

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120_000); // 2 menit untuk upload besar
    const res = await fetch(webAppUrl + '?action=upload_screenshot&alt=json', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8', // Avoid CORS preflight (same as sync_state)
        'Authorization': 'Bearer ' + token
      },
      body,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ok: false, error: 'HTTP_' + res.status, detail: errText.slice(0, 200) };
    }
    const json = await res.json();
    return json;
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, error: 'TIMEOUT', detail: 'Upload timeout (120s). Coba gambar lebih kecil.' };
    }
    return { ok: false, error: err.message || 'NETWORK_ERROR' };
  }
}

/**
 * Kirim full backup payload ke Apps Script (action=full_backup).
 * Dipakai saat user klik "Backup ke Google Drive" atau saat auto-backup lokal ter-trigger.
 *
 * @param {object} payload — sama format dengan autobackup.js buildBackupPayload()
 * @returns {Promise<{ok, stats?}>}
 */
export async function sendFullBackup(payload) {
  // v3.10.1 (Issue 1 fix): Validasi explicit sebelum isGDriveSyncEnabled
  const settings = await getSettings();
  if (!settings.gdriveWebAppUrl) {
    return { ok: false, error: 'NO_URL', detail: 'URL Web App Apps Script belum diisi. Buka Settings → Google Drive Sync → Konfigurasi.' };
  }
  if (!settings.gdriveAuthToken) {
    return { ok: false, error: 'NO_TOKEN', detail: 'Auth Token belum diisi. Klik 🎲 Generate lalu copy ke AUTH_TOKEN di Code.gs.' };
  }
  // v3.10.1: Auto-enable sync kalau URL+token sudah ada (user jelas mau sync)
  if (!settings.gdriveSyncEnabled) {
    await saveSettings({ gdriveSyncEnabled: true });
    console.log('[RecallFox/GDrive] Auto-enabled sync (URL+token present, full_backup requested)');
  }

  const webAppUrl = settings.gdriveWebAppUrl;
  const token = settings.gdriveAuthToken;

  // Mask API key sebelum kirim
  const safePayload = _sanitizeData(payload);

  // v3.10.0 (Issue 1): FIX — screenshotBlobs berisi base64 image full-size (bisa puluhan MB).
  // Apps Script Web App punya limit ~10MB per POST request, jadi kalau payload terlalu besar,
  // request akan gagal (HTTP 413 atau network error). Solusi: SKIP screenshotBlobs di full_backup.
  // Screenshot di-upload terpisah via uploadScreenshot() satu per satu (lihat uploadScreenshot()).
  if (safePayload.screenshotBlobs) {
    const blobCount = Object.keys(safePayload.screenshotBlobs).length;
    console.log('[RecallFox/GDrive] Skipping', blobCount, 'screenshot blobs in full_backup (use uploadScreenshot separately)');
    delete safePayload.screenshotBlobs;
  }

  // v3.10.0 (Issue 1): Cek ukuran payload sebelum kirim
  const bodyStr = JSON.stringify({ action: 'full_backup', token, ...safePayload });
  const bodyBytes = new Blob([bodyStr]).size;
  console.log('[RecallFox/GDrive] Full backup payload size:', (bodyBytes / 1024).toFixed(1), 'KB');
  if (bodyBytes > 8 * 1024 * 1024) {
    // >8MB — terlalu besar, kemungkinan akan gagal
    return {
      ok: false,
      error: 'PAYLOAD_TOO_LARGE',
      detail: `Ukuran backup ${(bodyBytes/1024/1024).toFixed(1)}MB melebihi limit Apps Script (~10MB). Kurangi jumlah item atau hapus screenshot lama.`
    };
  }

  try {
    // v3.10.0 (Issue 1): Timeout 90 detik (Apps Script cold start + processing banyak item)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90_000);
    const res = await fetch(webAppUrl + '?action=full_backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyStr,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!res.ok) return { ok: false, error: 'HTTP_' + res.status };
    const json = await res.json();
    return json;
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, error: 'TIMEOUT', detail: 'Server tidak merespons dalam 90 detik. Coba lagi atau kurangi jumlah item.' };
    }
    return { ok: false, error: err.message || 'NETWORK_ERROR' };
  }
}

/**
 * Test koneksi ke Web App (action=ping).
 * Dipakai saat user klik "Test Koneksi" di Settings.
 */
export async function testConnection() {
  const settings = await getSettings();
  if (!settings.gdriveWebAppUrl) return { ok: false, error: 'NO_URL' };
  if (!settings.gdriveAuthToken) return { ok: false, error: 'NO_TOKEN' };
  try {
    const res = await fetch(settings.gdriveWebAppUrl + '?action=ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'ping', token: settings.gdriveAuthToken })
    });
    if (!res.ok) return { ok: false, error: 'HTTP_' + res.status };
    const json = await res.json();
    return json;
  } catch (err) {
    return { ok: false, error: err.message || 'NETWORK_ERROR' };
  }
}

/**
 * Ambil metadata sync (lastSyncAt, totalSynced, queueLength, dll).
 */
export async function getSyncMeta() {
  return await _loadMeta();
}

/**
 * Ambil jumlah item yang masih antri di queue.
 */
export async function getQueueLength() {
  const q = await _loadQueue();
  return q.length;
}

/**
 * Bersihkan queue (untuk tombol "Reset Queue" di Settings).
 */
export async function clearQueue() {
  await _saveQueue([]);
  const meta = await _loadMeta();
  meta.queueLength = 0;
  await _saveMeta(meta);
  return true;
}

// ============== INTERNAL ==============

let _flushTimer = null;

function _scheduleFlush(delay = 2000) {
  if (_flushTimer) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    flushNow().catch(err => {
      console.warn('[GDriveSync] Flush failed:', err.message);
    });
  }, delay);
}

async function _sendSingle(webAppUrl, token, action, data) {
  try {
    const res = await fetch(webAppUrl + '?action=' + encodeURIComponent(action), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, token, ...data })
    });
    if (!res.ok) return { ok: false, error: 'HTTP_' + res.status };
    const json = await res.json();
    return json;
  } catch (err) {
    return { ok: false, error: err.message || 'NETWORK_ERROR' };
  }
}

/**
 * Sanitize data sebelum kirim — mask field sensitif.
 */
function _sanitizeData(data) {
  if (!data || typeof data !== 'object') return data;
  // Top-level sensitive fields
  const sanitized = { ...data };
  for (const f of SENSITIVE_FIELDS) {
    if (f in sanitized && sanitized[f]) sanitized[f] = '***MASKED***';
  }
  // Nested: vault.settings (untuk full_backup payload)
  if (sanitized.vault && sanitized.vault.settings) {
    sanitized.vault = { ...sanitized.vault };
    sanitized.vault.settings = { ...sanitized.vault.settings };
    for (const f of SENSITIVE_FIELDS) {
      if (f in sanitized.vault.settings && sanitized.vault.settings[f]) {
        sanitized.vault.settings[f] = '***MASKED***';
      }
    }
  }
  // Nested: settings (untuk save_setting dengan key=sensitive)
  if (sanitized.settingKey && SENSITIVE_FIELDS.has(sanitized.settingKey)) {
    sanitized.settingValue = '***MASKED***';
  }
  return sanitized;
}

// ============== AUTO-INIT (background) ==============
let _alarmInitialized = false;

export async function initGDriveSync() {
  if (_alarmInitialized) return;
  _alarmInitialized = true;
  try {
    const settings = await getSettings();
    if (!settings.gdriveSyncEnabled) return; // skip kalau disabled
    const interval = Math.max(1, settings.gdriveSyncIntervalMinutes || 5);
    await browser.alarms.create('gdrive-sync-flush', { periodInMinutes: interval });
    console.log('[GDriveSync] Alarm periodik di-set (' + interval + ' menit)');
    // Flush awal 10 detik setelah startup (kalau ada queue dari sesi sebelumnya)
    setTimeout(() => { flushNow().catch(() => {}); }, 10000);
  } catch (e) {
    console.warn('[GDriveSync] Init failed:', e.message);
  }
}

// Listen alarm
if (typeof browser !== 'undefined' && browser.alarms && browser.alarms.onAlarm) {
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'gdrive-sync-flush') {
      flushNow().catch(err => {
        console.warn('[GDriveSync] Alarm flush failed:', err.message);
      });
    }
  });
}
