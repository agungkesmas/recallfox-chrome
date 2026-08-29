// lib/supabase-sync.js — Sync vault items, notes, settings, screenshots ke Supabase
// RecallFox v3.11.21
//
// Modul ini menggantikan (atau melengkapi) sync-profile.js (Apps Script).
// User feedback: "saya frustasi dengan apps script yang tidak berhasil sudah dua hari
// untuk save gambar screenshot di drive. oleh karena itu buatkan databasenya menggunakan
// suppabase untuk menyimpan seluruh data yang dihasilkan di dalam addon seperti desain
// apps sync nya aja namun versi otomatis karena ini kan pake suppabase"
//
// === CARA KERJA ===
// 1. User login via Supabase Auth (email/password atau Gmail OAuth).
// 2. Setiap perubahan vault (tambah/edit/hapus item) → trigger pushToSupabase()
//    (debounced 5 detik, fire-and-forget).
// 3. User bisa klik "Pull dari Cloud" untuk download state terbaru.
// 4. Screenshot full image di-upload ke Supabase Storage bucket 'screenshots'.
//
// === TABLES ===
// - vault_items: prompt, context, link, snapshot, screenshot metadata, bundle
// - notes: catatan notepad
// - settings: preferensi user (key-value)
// - screenshots: metadata + storage path
// - sync_log: audit trail
//
// === RLS ===
// Semua table punya Row Level Security — user hanya bisa akses row miliknya
// (filter: user_id = auth.uid()).

import {
  getSession, isLoggedIn, getUserId,
  selectRows, upsertRow, deleteRow, insertRow, updateRow,
  uploadFile, deleteFile,
  SUPABASE_URL, SUPABASE_ANON_KEY
} from './supabase-client.js';
import { getVault, getNotes, saveVault, saveNotes, getSettings, saveSettings, getAllScreenshotBlobKeys } from './storage.js';

const SYNC_LOG_TABLE = 'sync_log';
const VAULT_TABLE = 'vault_items';
const NOTES_TABLE = 'notes';
const SETTINGS_TABLE = 'settings';
const SCREENSHOTS_TABLE = 'screenshots';
const STORAGE_BUCKET = 'screenshots';
const DOCUMENTS_BUCKET = 'documents';

// ============== DELETE REGISTRY (v3.11.31) ==============
// User feedback: "harus ada logika device mana duluan yang dipake dan ada perubahan
// di data / pergerakan data di addon nya maka itu yang dipake sebagai acuan terakhir
// untuk disingkronkan di seluruh device, jangan mengulang ulang menampilkan yang
// pernah dihapus. harus ada batasan interaksi perubahan data terakhir yang dipake."
//
// Strategi: tombstone-based sync dengan delete registry lokal.
// 1. Saat user hapus item di device A → deleteItem() tambah id ke deleteRegistry lokal
//    + kirim soft-delete (deleted_at=NOW()) ke cloud.
// 2. Saat device A push → SKIP item yang ada di deleteRegistry (jangan timpa soft-delete
//    cloud dengan item yang sama tanpa deleted_at).
// 3. Saat device B pull → lihat item cloud dengan deleted_at → hapus dari lokal + tambah
//    ke deleteRegistry lokal (supaya device B juga tidak push ulang item itu).
// 4. deleteRegistry di-cleanup otomatis: entry >30 hari dihapus (item cloud sudah
//    di-cleanup oleh SQL cron juga).
//
// Storage key: recallfox_supabase_delete_registry
// Format: { items: { id: deletedAtIso }, notes: { id: deletedAtIso } }

const DELETE_REGISTRY_KEY = 'recallfox_supabase_delete_registry';
const DELETE_REGISTRY_MAX_AGE_DAYS = 30;

async function _getDeleteRegistry() {
  try {
    const data = await browser.storage.local.get(DELETE_REGISTRY_KEY);
    const reg = data[DELETE_REGISTRY_KEY] || { items: {}, notes: {} };
    if (!reg.items) reg.items = {};
    if (!reg.notes) reg.notes = {};
    return reg;
  } catch (e) {
    return { items: {}, notes: {} };
  }
}

async function _saveDeleteRegistry(reg) {
  try {
    await browser.storage.local.set({ [DELETE_REGISTRY_KEY]: reg });
  } catch (e) {
    console.warn('[RecallFox/Supabase] Failed to save delete registry:', e.message);
  }
}

/**
 * Tambah item ID ke delete registry lokal.
 * Dipanggil saat user hapus item di device ini, ATAU saat pull menemukan item cloud
 * dengan deleted_at (dihapus di device lain).
 */
export async function addToDeleteRegistry(itemId, deletedAtIso) {
  const reg = await _getDeleteRegistry();
  reg.items[itemId] = deletedAtIso || new Date().toISOString();
  await _saveDeleteRegistry(reg);
}

/**
 * Tambah note ID ke delete registry lokal.
 */
export async function addNoteToDeleteRegistry(noteId, deletedAtIso) {
  const reg = await _getDeleteRegistry();
  reg.notes[noteId] = deletedAtIso || new Date().toISOString();
  await _saveDeleteRegistry(reg);
}

/**
 * Cek apakah item ID ada di delete registry (sudah dihapus).
 */
export async function isInDeleteRegistry(itemId) {
  const reg = await _getDeleteRegistry();
  return Object.prototype.hasOwnProperty.call(reg.items, itemId);
}

/**
 * Cek apakah note ID ada di delete registry (sudah dihapus).
 */
export async function isNoteInDeleteRegistry(noteId) {
  const reg = await _getDeleteRegistry();
  return Object.prototype.hasOwnProperty.call(reg.notes, noteId);
}

/**
 * Cleanup entry delete registry yang sudah >30 hari.
 * Dipanggil sebelum push untuk hindari registry bengkak.
 */
async function _cleanupDeleteRegistry() {
  const reg = await _getDeleteRegistry();
  const cutoff = Date.now() - (DELETE_REGISTRY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
  let cleaned = 0;
  for (const [id, ts] of Object.entries(reg.items)) {
    if (new Date(ts).getTime() < cutoff) {
      delete reg.items[id];
      cleaned++;
    }
  }
  for (const [id, ts] of Object.entries(reg.notes)) {
    if (new Date(ts).getTime() < cutoff) {
      delete reg.notes[id];
      cleaned++;
    }
  }
  if (cleaned > 0) {
    await _saveDeleteRegistry(reg);
    console.log('[RecallFox/Supabase] Delete registry cleanup:', cleaned, 'entries removed');
  }
}

// ============== STATUS ==============

/**
 * Get status sync Supabase — apakah login, user info, last sync, dll.
 */
export async function getSupabaseStatus() {
  const loggedIn = await isLoggedIn();
  if (!loggedIn) {
    return { loggedIn: false };
  }
  const user = await getCurrentUser();
  const userId = await getUserId();
  // Ambil last sync dari storage.local
  let lastSync = null;
  try {
    const data = await browser.storage.local.get('recallfox_supabase_last_sync');
    lastSync = data.recallfox_supabase_last_sync || null;
  } catch (e) {}
  return {
    loggedIn: true,
    user,
    userId,
    lastSync
  };
}

async function getCurrentUser() {
  const session = await getSession();
  return session?.user || null;
}

async function _setLastSync(direction, counts) {
  const lastSync = {
    at: new Date().toISOString(),
    direction,
    counts
  };
  try {
    await browser.storage.local.set({ 'recallfox_supabase_last_sync': lastSync });
  } catch (e) {}
}

// ============== PUSH (upload local → cloud) ==============

/**
 * Push state lokal ke Supabase Cloud.
 * - Vault items → upsert ke vault_items table
 * - Notes → upsert ke notes table
 * - Settings → upsert ke settings table
 * - Screenshot blobs → upload ke Storage bucket
 *
 * Returns: { ok, stats: { items, notes, settings, screenshots, errors } }
 */
export async function pushToSupabase() {
  // v3.11.24 (Sesi 14): Tambah logging detail supaya user tahu kenapa "0 item".
  // User report: "ketika push manual saya pencet disitu keluar 0 item ter push,
  // padahal kan banyak itu isinya. inget harus berhasil sync supabase."
  // Root cause analysis: 0 item bisa terjadi karena:
  //   (a) isLoggedIn return false → return early { ok: false, error: 'not_logged_in' }
  //   (b) getUserId return null → return early { ok: false, error: 'no_user_id' }
  //   (c) vault.items kosong (seharusnya tidak — user bilang ada 11 prompt)
  //   (d) upsertRow gagal untuk semua item tapi errors juga 0 (tidak mungkin)
  //   (e) RLS reject insert → 404/403 → return { ok: false, error: 'http_403' }
  //       tapi di pushToSupabase, errors.push → stats.errors.length > 0
  // Fix: log setiap step + return stats lengkap dengan debug info.
  if (!(await isLoggedIn())) {
    console.warn('[RecallFox/Supabase] Push gagal: not_logged_in');
    return { ok: false, error: 'not_logged_in', stats: { items: 0, notes: 0, settings: 0, screenshots: 0, errors: [] } };
  }
  const userId = await getUserId();
  if (!userId) {
    console.warn('[RecallFox/Supabase] Push gagal: no_user_id (session tidak punya user.id)');
    return { ok: false, error: 'no_user_id', stats: { items: 0, notes: 0, settings: 0, screenshots: 0, errors: [] } };
  }

  console.log('[RecallFox/Supabase] Push started, userId:', userId);
  const startTime = Date.now();
  const stats = { items: 0, notes: 0, settings: 0, screenshots: 0, errors: [] };

  // v3.11.31: Cleanup delete registry (hapus entry >30 hari)
  await _cleanupDeleteRegistry();

  // v3.11.31: Load delete registry — item/note yang ada di registry TIDAK boleh di-push
  // (jangan timpa soft-delete cloud dengan item tanpa deleted_at).
  // User feedback: "jangan mengulang ulang menampilkan yang pernah dihapus"
  const deleteReg = await _getDeleteRegistry();
  const deletedItemIds = new Set(Object.keys(deleteReg.items));
  const deletedNoteIds = new Set(Object.keys(deleteReg.notes));
  let skippedDeleted = 0;

  try {
    // === 1. Push vault items ===
    const vault = await getVault();
    const items = vault.items || [];
    const bundles = vault.bundles || [];
    const allToppings = vault.toppings || [];

    console.log('[RecallFox/Supabase] Vault loaded:', items.length, 'items,', bundles.length, 'bundles');
    console.log('[RecallFox/Supabase] Delete registry:', deletedItemIds.size, 'items,', deletedNoteIds.size, 'notes');

    // Items (prompt, context, link, snapshot, screenshot)
    for (const item of items) {
      try {
        // v3.11.31: Skip item yang ada di delete registry — jangan push ulang
        if (deletedItemIds.has(item.id)) {
          skippedDeleted++;
          continue;
        }
        const row = _buildVaultItemRow(item, userId);
        const res = await upsertRow(VAULT_TABLE, row);
        if (res.ok) {
          stats.items++;
        } else {
          stats.errors.push({ id: item.id, type: item.type, title: item.title, error: res.error });
          console.warn('[RecallFox/Supabase] Item upsert failed:', item.id, item.type, res.error);
        }

        // Kalau screenshot, upload blob ke Storage juga
        if (item.type === 'screenshot') {
          const blobRes = await _uploadScreenshotBlob(item, userId);
          if (blobRes.ok) {
            stats.screenshots++;
            console.log('[RecallFox/Supabase] Screenshot uploaded:', item.id);
          } else {
            // v3.11.28: Error detail lengkap supaya user bisa debug
            const errDetail = blobRes.error + (blobRes.detail ? ' | ' + blobRes.detail : '');
            stats.errors.push({
              id: item.id,
              type: 'screenshot',
              title: item.title,
              error: 'storage: ' + errDetail,
              path: blobRes.path,
              blobSize: blobRes.blobSize
            });
            console.warn('[RecallFox/Supabase] Screenshot upload failed:', item.id, errDetail);
          }
        }

        // v3.20.39: File type — upload ke Storage + PATCH gdrive_file_url.
        //   Sebelumnya: push hanya upsert row dengan gdrive_file_url: null (kalau
        //   local belum update) → cloud ke-NULL → "Kopi Link" tidak ada URL.
        //   Sekarang: mirror screenshot pattern — upload + PATCH supaya cloud
        //   selalu punya URL valid. Fix BUG 2 (Kopi Link NULL).
        // v3.22.0 (Fase 2): binary file (body kosong) juga ikut di-upload —
        //   kondisinya diperluas dengan cek source.isBinary.
        if (item.type === 'file' && (item.body || (item.source && item.source.isBinary))) {
          const fileRes = await _uploadFileDocument(item, userId);
          if (fileRes.ok) {
            stats.files = (stats.files || 0) + 1;
            console.log('[RecallFox/Supabase] File uploaded:', item.id, '→', fileRes.url);
          } else {
            const errDetail = fileRes.error + (fileRes.detail ? ' | ' + fileRes.detail : '');
            stats.errors.push({
              id: item.id,
              type: 'file',
              title: item.title,
              error: 'storage: ' + errDetail,
              path: fileRes.path
            });
            console.warn('[RecallFox/Supabase] File upload failed:', item.id, errDetail);
          }
        }
      } catch (e) {
        stats.errors.push({ id: item.id, error: e.message });
        console.warn('[RecallFox/Supabase] Item exception:', item.id, e.message);
      }
    }

    // Bundles (simpan sebagai row type='bundle')
    for (const bundle of bundles) {
      try {
        // v3.11.31: Skip bundle yang ada di delete registry
        if (deletedItemIds.has(bundle.id)) {
          skippedDeleted++;
          continue;
        }
        const row = _buildBundleRow(bundle, userId);
        const res = await upsertRow(VAULT_TABLE, row);
        if (res.ok) stats.items++;
        else stats.errors.push({ id: bundle.id, error: res.error });
      } catch (e) {
        stats.errors.push({ id: bundle.id, error: e.message });
      }
    }

    // === 2. Push notes ===
    const notes = await getNotes();
    console.log('[RecallFox/Supabase] Notes loaded:', notes.length);
    for (const note of notes) {
      try {
        // v3.11.31: Skip note yang ada di delete registry
        if (deletedNoteIds.has(note.id)) {
          skippedDeleted++;
          continue;
        }
        const row = _buildNoteRow(note, userId);
        const res = await upsertRow(NOTES_TABLE, row);
        if (res.ok) stats.notes++;
        else stats.errors.push({ id: note.id, error: res.error });
      } catch (e) {
        stats.errors.push({ id: note.id, error: e.message });
      }
    }

    if (skippedDeleted > 0) {
      console.log('[RecallFox/Supabase] Skipped', skippedDeleted, 'deleted items/notes (in delete registry)');
    }

    // === 3. Push settings ===
    const settings = vault.settings || {};
    const settingKeys = Object.keys(settings).filter(k => !_isSensitiveSetting(k));
    console.log('[RecallFox/Supabase] Settings loaded:', settingKeys.length, '(filtered from', Object.keys(settings).length, ')');
    for (const key of settingKeys) {
      try {
        const row = _buildSettingRow(key, settings[key], userId);
        const res = await upsertRow(SETTINGS_TABLE, row);
        if (res.ok) stats.settings++;
      } catch (e) {
        stats.errors.push({ key, error: e.message });
      }
    }

    // === 4. Log sync ===
    await _logSync('push', 'upload', stats, Date.now() - startTime);
    await _setLastSync('push', stats);

    console.log('[RecallFox/Supabase] Push done:', stats.items, 'items,', stats.notes, 'notes,', stats.errors.length, 'errors');

    // v3.11.24: Return debug info supaya UI bisa tampilkan detail error
    return {
      ok: true,
      stats,
      debug: {
        userId,
        vaultItems: items.length,
        bundles: bundles.length,
        notes: notes.length,
        settingsKeys: settingKeys.length,
        duration: Date.now() - startTime
      }
    };
  } catch (e) {
    console.error('[RecallFox/Supabase] Push exception:', e.message);
    return { ok: false, error: e.message, stats };
  }
}

// ============== PULL (download cloud → local) ==============

/**
 * Pull state terbaru dari Supabase Cloud ke local.
 * - Vault items → merge ke vault local (upsert by id)
 * - Notes → merge ke notes local
 * - Settings → merge ke settings local (cloud menang)
 *
 * Strategy merge: last-write-wins by updated_at.
 *
 * Returns: { ok, stats: { itemsAdded, itemsUpdated, notesAdded, notesUpdated, settingsUpdated } }
 */
export async function pullFromSupabase() {
  if (!(await isLoggedIn())) {
    return { ok: false, error: 'not_logged_in' };
  }
  const userId = await getUserId();
  if (!userId) return { ok: false, error: 'no_user_id' };

  const startTime = Date.now();
  const stats = { itemsAdded: 0, itemsUpdated: 0, notesAdded: 0, notesUpdated: 0, settingsUpdated: 0, errors: [] };

  try {
    // === 1. Pull vault items ===
    // v3.11.29: Filter out soft-deleted items (deleted_at IS NOT NULL)
    // Tapi tetap proses deleted items untuk hapus dari lokal kalau ada
    const itemsRes = await selectRows(VAULT_TABLE, {
      select: '*',
      filter: `user_id=eq.${userId}`,
      order: 'updated_at.desc'
    });
    if (itemsRes.ok && itemsRes.data) {
      const vault = await getVault();
      const localItems = vault.items || [];
      const localBundles = vault.bundles || [];
      let itemsDeleted = 0;

      for (const row of itemsRes.data) {
        try {
          // v3.11.29: Cek soft-delete — kalau deleted_at ada, hapus dari lokal
          // v3.11.31: JUGA tambah ke delete registry lokal supaya device ini tidak
          // push ulang item itu (yang akan menimpa soft-delete cloud).
          if (row.deleted_at) {
            const idx = localItems.findIndex(i => i.id === row.id);
            if (idx >= 0) {
              localItems.splice(idx, 1);
              itemsDeleted++;
            }
            const bIdx = localBundles.findIndex(b => b.id === row.id);
            if (bIdx >= 0) {
              localBundles.splice(bIdx, 1);
              itemsDeleted++;
            }
            // v3.11.31: Tambah ke delete registry lokal (pakai deleted_at dari cloud)
            await addToDeleteRegistry(row.id, row.deleted_at);
            continue; // Skip further processing untuk deleted item
          }

          if (row.type === 'bundle') {
            // v3.13.7: Cek delete registry — jangan re-add bundle yang sudah dihapus
            const reg = await _getDeleteRegistry();
            if (reg.items[row.id]) {
              continue;
            }
            // Bundle
            const bundle = _parseBundleRow(row);
            const idx = localBundles.findIndex(b => b.id === bundle.id);
            if (idx < 0) {
              localBundles.push(bundle);
              stats.itemsAdded++;
            } else if (new Date(row.updated_at) > new Date(localBundles[idx].updatedAt || 0)) {
              localBundles[idx] = bundle;
              stats.itemsUpdated++;
            }
          } else {
            // Item
            const item = _parseVaultItemRow(row);
            const idx = localItems.findIndex(i => i.id === item.id);
            if (idx < 0) {
              localItems.push(item);
              stats.itemsAdded++;
            } else if (new Date(row.updated_at) > new Date(localItems[idx].updatedAt || 0)) {
              localItems[idx] = item;
              stats.itemsUpdated++;
            }
          }
        } catch (e) {
          stats.errors.push({ id: row.id, error: e.message });
        }
      }

      vault.items = localItems;
      vault.bundles = localBundles;
      await saveVault(vault);
      if (itemsDeleted > 0) {
        stats.itemsDeleted = itemsDeleted;
        console.log('[RecallFox/Supabase] Pull: removed', itemsDeleted, 'deleted items from local');
      }
    }

    // === 2. Pull notes ===
    // v3.11.29: Handle soft-deleted notes juga
    const notesRes = await selectRows(NOTES_TABLE, {
      select: '*',
      filter: `user_id=eq.${userId}`,
      order: 'updated_at.desc'
    });
    if (notesRes.ok && notesRes.data) {
      const localNotes = await getNotes();
      let notesDeleted = 0;

      for (const row of notesRes.data) {
        try {
          if (row.deleted_at) {
            const idx = localNotes.findIndex(n => n.id === row.id);
            if (idx >= 0) {
              localNotes.splice(idx, 1);
              notesDeleted++;
            }
            // v3.11.31: Tambah ke delete registry lokal
            await addNoteToDeleteRegistry(row.id, row.deleted_at);
            continue;
          }

          const note = _parseNoteRow(row);
          const idx = localNotes.findIndex(n => n.id === note.id);
          if (idx < 0) {
            localNotes.push(note);
            stats.notesAdded++;
          } else if (new Date(row.updated_at) > new Date(localNotes[idx].updatedAt || 0)) {
            localNotes[idx] = note;
            stats.notesUpdated++;
          }
        } catch (e) {
          stats.errors.push({ id: row.id, error: e.message });
        }
      }
      await saveNotes(localNotes);
      if (notesDeleted > 0) {
        stats.notesDeleted = notesDeleted;
        console.log('[RecallFox/Supabase] Pull: removed', notesDeleted, 'deleted notes from local');
      }
    }

    // === 3. Pull settings ===
    const settingsRes = await selectRows(SETTINGS_TABLE, {
      select: '*',
      filter: `user_id=eq.${userId}`
    });
    if (settingsRes.ok && settingsRes.data) {
      const vault = await getVault();
      const localSettings = vault.settings || {};
      let changed = false;
      for (const row of settingsRes.data) {
        if (!row.setting_key) continue;
        const cloudValue = row.setting_value;
        const cloudUpdatedAt = new Date(row.updated_at).getTime();
        // Local tidak track updated_at per setting, jadi cloud always wins
        if (JSON.stringify(localSettings[row.setting_key]) !== JSON.stringify(cloudValue)) {
          localSettings[row.setting_key] = cloudValue;
          stats.settingsUpdated++;
          changed = true;
        }
      }
      if (changed) {
        vault.settings = localSettings;
        await saveVault(vault);
      }
    }

    // === 4. Log sync ===
    await _logSync('pull', 'download', stats, Date.now() - startTime);
    await _setLastSync('pull', stats);

    return { ok: true, stats };
  } catch (e) {
    return { ok: false, error: e.message, stats };
  }
}

// ============== FULL SYNC (push + pull) ==============

/**
 * Sync penuh — push state lokal lalu pull state cloud.
 * Berguna untuk conflict resolution: push dulu, lalu ambil yang terbaru.
 */
export async function fullSync() {
  if (!(await isLoggedIn())) {
    return { ok: false, error: 'not_logged_in' };
  }
  const startTime = Date.now();
  // v3.11.31: PULL DULU, lalu PUSH.
  // Sebelumnya: push dulu, lalu pull. Ini bikin bug: device B punya item X (sudah dihapus
  // di device A). Device B push → item X di-upsert tanpa deleted_at → menimpa soft-delete
  // cloud → device A pull → item X muncul lagi!
  // Fix: pull dulu supaya device B tahu item X sudah dihapus (deleted_at di cloud) →
  // tambah ke delete registry lokal → saat push, item X di-skip (tidak menimpa soft-delete).
  // User feedback: "harus ada logika device mana duluan yang dipake dan ada perubahan
  // di data / pergerakan data di addon nya maka itu yang dipake sebagai acuan terakhir"
  console.log('[RecallFox/Supabase] FullSync: PULL first, then PUSH (v3.11.31 fix)');
  const pullRes = await pullFromSupabase();
  const pushRes = await pushToSupabase();
  const duration = Date.now() - startTime;

  await _logSync('sync_full', 'both', {
    pushed: pushRes.stats,
    pulled: pullRes.stats
  }, duration);

  return {
    ok: pushRes.ok && pullRes.ok,
    push: pushRes,
    pull: pullRes,
    duration
  };
}

// ============== SCREENSHOT STORAGE ==============

/**
 * Upload screenshot blob ke Supabase Storage.
 * Path: 'user-<uuid>/<screenshot-id>.<ext>'
 */
async function _uploadScreenshotBlob(item, userId) {
  try {
    const { getScreenshotBlob } = await import('./storage.js');
    const dataUrl = await getScreenshotBlob(item.id);
    if (!dataUrl) return { ok: false, error: 'no_blob (screenshot tidak punya gambar tersimpan di storage.local — coba re-capture)' };

    // Convert dataUrl → Blob
    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
    if (!blob || blob.size === 0) {
      return { ok: false, error: 'empty_blob (gambar corrupt — coba re-capture)' };
    }
    const ext = item.screenshotFormat === 'jpeg' ? 'jpg' : 'png';
    const contentType = item.screenshotFormat === 'jpeg' ? 'image/jpeg' : 'image/png';
    const path = `user-${userId}/${item.id}.${ext}`;

    console.log('[RecallFox/Supabase] Uploading screenshot:', {
      id: item.id,
      path,
      size: blob.size,
      type: contentType,
      bucket: STORAGE_BUCKET
    });

    const upRes = await uploadFile(STORAGE_BUCKET, path, blob, contentType);
    if (!upRes.ok) {
      console.warn('[RecallFox/Supabase] Screenshot upload FAILED:', upRes);
      return {
        ok: false,
        error: `${upRes.error}${upRes.detail ? ': ' + upRes.detail : ''}`,
        path,
        bucket: STORAGE_BUCKET,
        blobSize: blob.size
      };
    }

    console.log('[RecallFox/Supabase] Screenshot upload OK:', upRes.url);

    // Update screenshots table dengan storage path + URL
    const screenshotRow = {
      id: item.id,
      user_id: userId,
      vault_item_id: item.id,
      storage_path: path,
      storage_url: upRes.url,
      file_size: item.screenshotBytes || blob.size,
      width: item.screenshotWidth || 0,
      height: item.screenshotHeight || 0,
      format: item.screenshotFormat || 'png',
      annotation_note: item.annotationNote || item.source?.annotationNote || '',
      captured_at: item.source?.capturedAt || item.createdAt,
      source_url: item.source?.url,
      source_title: item.source?.title,
      created_at: item.createdAt || new Date().toISOString()
    };
    const screenshotRes = await upsertRow(SCREENSHOTS_TABLE, screenshotRow);
    if (!screenshotRes.ok) {
      console.warn('[RecallFox/Supabase] Screenshot row upsert failed:', screenshotRes);
      // Tidak return error — file sudah ter-upload, cuma metadata gagal
    }

    // v3.11.39 (Sesi 3, cross-device bug fix): Update vault_items.gdrive_file_url
    // pakai PATCH (bukan upsert). Sebelumnya pakai upsertRow dengan hanya 5 field
    // → gagal dengan error "null value in column type violates not-null constraint"
    // karena upsert butuh semua kolom NOT NULL diisi (type, title, dll). PATCH hanya
    // update kolom yang dikirim, tidak trigger constraint.
    //
    // Akibat bug ini: file ter-upload ke Storage, tapi URL tidak masuk tabel →
    // PWA & device lain tidak bisa load image (gdrive_file_url = NULL).
    // Fix ini mengembalikan URL ke tabel supaya PWA bisa akses image cross-device.
    const updateRes = await updateRow(VAULT_TABLE, `id=eq.${item.id}`, {
      gdrive_file_id: path,
      gdrive_file_url: upRes.url,
      updated_at: new Date().toISOString()
    });
    if (!updateRes.ok) {
      console.warn('[RecallFox/Supabase] v3.11.39: Update gdrive_file_url gagal (file sudah ter-upload, retry di next sync):', updateRes.error);
      // Tetap return ok=true karena file sudah ter-upload. Update row akan di-retry
      // oleh fullSync() di cycle berikutnya kalau item ini di-push lagi.
    } else {
      console.log('[RecallFox/Supabase] v3.11.39: gdrive_file_url updated di vault_items:', item.id);
    }

    return { ok: true, url: upRes.url, path };
  } catch (e) {
    console.warn('[RecallFox/Supabase] _uploadScreenshotBlob exception:', e);
    return { ok: false, error: e.message, stack: e.stack };
  }
}

// v3.22.0 (Fase 2): Resolve blob binary untuk upload cloud.
// Prioritas: 1) item.fileDataUrl (in-memory, dari addItem) → 2) storage.local
// key rf_file_{id} (push sync biasa / retry).
async function _resolveFileBlob(item) {
  const tryFetchBlob = async (dataUrl) => {
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
    try {
      const res = await fetch(dataUrl);
      if (res.ok) return await res.blob();
    } catch (e) {
      console.warn('[RecallFox/Supabase] _resolveFileBlob fetch dataUrl failed:', e.message);
    }
    return null;
  };
  const inMemory = await tryFetchBlob(item.fileDataUrl);
  if (inMemory) return inMemory;
  try {
    const key = 'rf_file_' + item.id;
    const data = await browser.storage.local.get(key);
    if (data[key]) return await tryFetchBlob(data[key]);
  } catch (e) {
    console.warn('[RecallFox/Supabase] _resolveFileBlob storage read failed:', e.message);
  }
  return null;
}

// Ekstensi untuk path cloud: ekstensi asli fileName (validasi [a-z0-9]{1,8}),
// fallback ke map kind (diperluas v3.22.0), fallback 'bin'/'txt'.
function _fileExtForUpload(fileName, kind, isBinary) {
  if (fileName) {
    const dotIdx = fileName.lastIndexOf('.');
    if (dotIdx > 0) {
      const ext = fileName.slice(dotIdx + 1).toLowerCase();
      if (/^[a-z0-9]{1,8}$/.test(ext)) return ext;
    }
  }
  const extMap = {
    md: 'md', markdown: 'md', txt: 'txt', json: 'json', html: 'html', htm: 'html',
    csv: 'csv', yaml: 'yaml', yml: 'yaml', js: 'js', jsx: 'jsx', ts: 'ts', tsx: 'tsx',
    vue: 'vue', svelte: 'svelte', astro: 'astro', css: 'css', scss: 'scss', sass: 'sass',
    less: 'less', py: 'py', java: 'java', go: 'go', php: 'php', rb: 'rb', cs: 'cs',
    rs: 'rs', c: 'c', h: 'h', cpp: 'cpp', kt: 'kt', swift: 'swift', dart: 'dart',
    lua: 'lua', r: 'r', pl: 'pl', ex: 'ex', exs: 'exs', sh: 'sh', bat: 'bat', ps1: 'ps1',
    sql: 'sql', prisma: 'prisma', graphql: 'graphql', gql: 'graphql', proto: 'proto',
    toml: 'toml', xml: 'xml', svg: 'svg', ini: 'ini', env: 'env', conf: 'conf',
    log: 'log', rtf: 'rtf', tsv: 'tsv', tex: 'tex', lock: 'lock', gitignore: 'gitignore',
    dockerfile: 'dockerfile', makefile: 'makefile', license: 'license',
    pdf: 'pdf', docx: 'docx', doc: 'doc', xlsx: 'xlsx', xls: 'xls',
    pptx: 'pptx', ppt: 'ppt', odt: 'odt', ods: 'ods', odp: 'odp',
    png: 'png', jpg: 'jpg', gif: 'gif', webp: 'webp', avif: 'avif', bmp: 'bmp'
  };
  return extMap[kind] || (isBinary ? 'bin' : 'txt');
}

// v3.20.35-dev: Upload file teks ke Storage bucket 'documents'.
// v3.22.0 (Fase 2): Dukungan file binary (PDF/Office/gambar) — blob diambil
// dari item.fileDataUrl (in-memory, saat addItem) atau key storage.local
// rf_file_{id} (saat push sync biasa). Ekstensi cloud pakai ekstensi asli
// fileName supaya file tidak salah tipe.
// Mirror pola _uploadScreenshotBlob — upload blob, PATCH gdrive_file_url.
// PENTING: update lokal pakai getVault/saveVault (BUKAN updateItem) untuk
// hindari circular import: addItem -> directUpsertVaultItem ->
// _uploadFileDocument -> updateItem -> directUpsertVaultItem -> infinity.
async function _uploadFileDocument(item, userId) {
  try {
    const isBinary = !!(item.source && item.source.isBinary);
    const kind = (item.source && item.source.kind) || 'txt';
    const mime = (item.source && item.source.mime) || 'text/plain';
    const fileName = (item.source && item.source.fileName) || item.title || '';

    let blob = null;
    if (isBinary) {
      // Binary: TIDAK ada isi di item.body — resolve blob dari dataUrl.
      blob = await _resolveFileBlob(item);
      if (!blob || blob.size === 0) return { ok: false, error: 'empty_binary_blob' };
    } else if (item.body) {
      blob = new Blob([item.body], { type: mime });
      if (!blob || blob.size === 0) return { ok: false, error: 'empty_blob' };
    } else {
      return { ok: false, error: 'empty_file_body' };
    }

    // Ekstensi cloud: pakai ekstensi asli fileName kalau valid, fallback ke map kind.
    const ext = _fileExtForUpload(fileName, kind, isBinary);
    const path = 'user-' + userId + '/' + item.id + '.' + ext;
    const upRes = await uploadFile(DOCUMENTS_BUCKET, path, blob, mime);
    if (!upRes.ok) {
      console.warn('[RecallFox/Supabase] File document upload FAILED:', upRes);
      // v3.20.38-dev: Track error ke storage.local supaya UI bisa tampilkan ke user.
      try {
        const errDetail = upRes.error + (upRes.detail ? ': ' + upRes.detail : '');
        browser.storage.local.set({ 'recallfox_last_sync_error': JSON.stringify({
          ts: new Date().toISOString(),
          source: '_uploadFileDocument',
          itemId: item.id,
          error: errDetail,
          hint: upRes.error === 'not_logged_in'
            ? 'Login Supabase dulu di Settings -> Sync Cloud'
            : (upRes.error === 'http_403'
              ? 'RLS policy block - jalankan SQL fix-documents-rls.sql'
              : 'Upload gagal - coba lagi nanti')
        }) }).catch(() => {});
      } catch (_) {}
      return { ok: false, error: upRes.error + (upRes.detail ? ': ' + upRes.detail : '') };
    }
    console.log('[RecallFox/Supabase] File document upload OK:', upRes.url);

    // PATCH gdrive_file_url (pola v3.11.39 — bukan upsert, hindari NOT NULL constraint)
    const updateRes = await updateRow(VAULT_TABLE, 'id=eq.' + item.id, {
      gdrive_file_id: path,
      gdrive_file_url: upRes.url,
      device_id: await _getDeviceId(),
      updated_at: new Date().toISOString()
    });
    if (!updateRes.ok) {
      console.warn('[RecallFox/Supabase] File: update gdrive_file_url gagal (retry di next sync):', updateRes.error);
    }

    // Update lokal vault item via getVault/saveVault (BUKAN updateItem — hindari circular import)
    try {
      const vault = await getVault();
      const idx = vault.items.findIndex(i => i.id === item.id);
      if (idx >= 0) {
        vault.items[idx].gdriveFileId = path;
        vault.items[idx].gdriveFileUrl = upRes.url;
        await saveVault(vault);
      }
    } catch (localUpdateErr) {
      console.warn('[RecallFox/Supabase] File: update lokal vault gagal (tidak fatal):', localUpdateErr.message);
    }

    return { ok: true, url: upRes.url, path };
  } catch (e) {
    console.warn('[RecallFox/Supabase] _uploadFileDocument exception:', e);
    return { ok: false, error: e.message };
  }
}

// ============== v3.11.35: LAZY DOWNLOAD SCREENSHOT BLOB ==============
// User audit (Sesi 1, 18 Jul 2026): "Pull sync hanya transfer metadata (URL,
// dimensi), bukan blob gambar. Saat device lain coba copy/paste, blob lokal
// tidak ada → error 'no_blob'."
//
// Strategi: LAZY DOWNLOAD — jangan download saat pull (bisa lambat kalau
// banyak screenshot). Download saat user pertama kali view/copy screenshot
// di device lain. Setelah download, cache ke storage.local (rf_shot_<id>)
// supaya akses berikutnya instan.
//
// Path:
//   1. getScreenshotBlob(id) → cari di storage.local
//   2. Kalau null, cari vault item → cek gdriveFileUrl (URL public Supabase)
//   3. fetch(url) → blob() → convert ke dataUrl (base64)
//   4. Cache ke storage.local via setScreenshotBlob(id, dataUrl)
//   5. Return dataUrl

/**
 * v3.11.35: Download screenshot blob dari Supabase Storage (URL public).
 * v3.13.4: Multi-strategy URL resolution. Sebelumnya hanya cek gdriveFileUrl —
 *           kalau NULL (PWA upload berhasil tapi URL tidak tersimpan ke row,
 *           bug v1.5.1 IndexedDB-first), addon tidak bisa muat gambar meski
 *           file ADA di Storage. Sekarang cek beberapa sumber URL + reconstruct
 *           dari pattern sebagai fallback terakhir.
 *
 * @param {Object} item - vault item
 * @returns {Promise<{ok: boolean, dataUrl?: string, error?: string}>}
 */
export async function downloadScreenshotBlob(item) {
  if (!item?.id) return { ok: false, error: 'no_id' };

  // v3.13.4: Kumpulkan semua kandidat URL — cek satu per satu.
  // Urutan: gdriveFileUrl → source.pages[0].url → source.url → reconstruct pattern.
  const candidates = [];

  // 1. URL eksplisit di row (normal case — addon capture & PWA capture yang sukses)
  if (item.gdriveFileUrl) candidates.push(item.gdriveFileUrl);
  if (item.gdrive_file_url && item.gdrive_file_url !== item.gdriveFileUrl) {
    candidates.push(item.gdrive_file_url);
  }

  // 2. URL di source.pages[0].url (document multi-page dari PWA — selalu ada)
  const src = item.source || {};
  if (Array.isArray(src.pages) && src.pages[0]?.url) {
    candidates.push(src.pages[0].url);
  }

  // 3. URL di source.url (legacy screenshot)
  if (src.url) candidates.push(src.url);

  // 4. v3.13.4 RECONSTRUCT URL dari pattern — fallback terakhir.
  // PWA upload ke path: user-<userId>/<id>.png (screenshot) atau
  // user-<userId>/<id>_p1.jpg (document page 1). File ada di Storage
  // meskipun URL tidak tersimpan di row (PWA bug v1.5.1).
  // Pattern ini konsisten dengan PWA sync.js uploadScreenshotBlob + createDocumentItemMultiPage.
  if (item.user_id || item.userId) {
    const uid = item.user_id || item.userId;
    const isDoc = item.type === 'document';
    if (isDoc) {
      // Document: <id>_p1.jpg
      candidates.push(`${SUPABASE_URL}/storage/v1/object/public/screenshots/user-${uid}/${item.id}_p1.jpg`);
    } else {
      // Screenshot: <id>.png (PWA) atau <id>.jpg (jarang)
      candidates.push(`${SUPABASE_URL}/storage/v1/object/public/screenshots/user-${uid}/${item.id}.png`);
      candidates.push(`${SUPABASE_URL}/storage/v1/object/public/screenshots/user-${uid}/${item.id}.jpg`);
    }
  }

  // Dedupe
  const uniqueCandidates = [...new Set(candidates.filter(Boolean))];
  if (uniqueCandidates.length === 0) {
    return { ok: false, error: 'no_cloud_url' };
  }

  console.log('[RecallFox/Supabase] downloadScreenshotBlob:', item.id, '- trying', uniqueCandidates.length, 'URL candidates');

  // Coba setiap kandidat sampai ada yang berhasil
  let lastError = 'all_candidates_failed';
  for (let i = 0; i < uniqueCandidates.length; i++) {
    const cloudUrl = uniqueCandidates[i];
    try {
      const res = await fetch(cloudUrl);
      if (!res.ok) {
        // v3.13.5: Better error classification untuk 404/400 (orphan URL).
        // Supabase Storage return 400 untuk 404 object (quirk). Map ke pesan
        // yang jelas: file tidak ada di cloud.
        console.warn('[RecallFox/Supabase] URL candidate ' + (i + 1) + ' HTTP ' + res.status + ':', cloudUrl);
        if (res.status === 400 || res.status === 404) {
          lastError = 'file_not_found_in_cloud';
        } else {
          lastError = 'http_' + res.status;
        }
        continue;
      }
      const blob = await res.blob();
      if (!blob || blob.size === 0) {
        console.warn('[RecallFox/Supabase] URL candidate ' + (i + 1) + ' empty blob:', cloudUrl);
        lastError = 'empty_blob';
        continue;
      }

      // Convert blob → dataUrl (base64)
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('filereader_failed'));
        reader.readAsDataURL(blob);
      });

      if (!dataUrl) {
        lastError = 'dataurl_conversion_failed';
        continue;
      }

      // Cache ke storage.local supaya akses berikutnya instan
      try {
        const { setScreenshotBlob } = await import('./storage.js');
        await setScreenshotBlob(item.id, dataUrl);
      } catch (e) {
        console.warn('[RecallFox/Supabase] Failed to cache screenshot blob:', e.message);
        // Tetap return dataUrl — cache gagal bukan masalah fatal
      }

      // v3.13.4: Self-repair — kalau URL reconstruct berhasil, PATCH vault_items.gdrive_file_url
      // supaya pull berikutnya langsung pakai URL yang benar (tanpa perlu reconstruct lagi).
      if (cloudUrl !== item.gdriveFileUrl && cloudUrl !== item.gdrive_file_url) {
        try {
          const userId = item.user_id || item.userId;
          if (userId) {
            await updateRow('vault_items',
              { gdrive_file_url: cloudUrl, gdrive_file_id: cloudUrl.split('/screenshots/')[1] || null },
              `id=eq.${item.id}`);
            console.log('[RecallFox/Supabase] Self-repair gdrive_file_url:', item.id, '→', cloudUrl);
          }
        } catch (e) {
          console.warn('[RecallFox/Supabase] Self-repair gdrive_file_url failed (non-fatal):', e.message);
        }
      }

      console.log('[RecallFox/Supabase] downloadScreenshotBlob OK:', item.id, '(' + Math.round(blob.size / 1024) + 'KB) via candidate ' + (i + 1));
      return { ok: true, dataUrl };
    } catch (e) {
      console.warn('[RecallFox/Supabase] URL candidate ' + (i + 1) + ' exception:', cloudUrl, e.message);
      lastError = e.message;
      continue;
    }
  }

  console.warn('[RecallFox/Supabase] downloadScreenshotBlob ALL candidates failed:', item.id);
  return { ok: false, error: lastError };
}

/**
 * v3.11.35: Get screenshot blob with lazy cloud fallback.
 * Dipanggil oleh background.js GET_SCREENSHOT_BLOB handler.
 *
 * Strategi:
 *   1. Cari di storage.local (rf_shot_<id>) — instan kalau ada
 *   2. Kalau null, cari vault item → cek gdriveFileUrl
 *   3. Download dari Supabase Storage → cache → return
 *   4. Kalau tidak ada URL cloud, return null (screenshot lokal-only)
 *
 * @param {string} id - vault item ID
 * @returns {Promise<{ok: boolean, dataUrl: string|null, source?: 'local'|'cloud', error?: string}>}
 */
export async function getOrDownloadScreenshotBlob(id) {
  if (!id) return { ok: false, dataUrl: null, error: 'no_id' };

  // Step 1: cek local storage dulu
  try {
    const { getScreenshotBlob, getVault } = await import('./storage.js');
    let dataUrl = await getScreenshotBlob(id);
    if (dataUrl) {
      return { ok: true, dataUrl, source: 'local' };
    }

    // Step 2: cari vault item untuk dapat gdriveFileUrl
    const vault = await getVault();
    const item = (vault.items || []).find(i => i.id === id);
    if (!item) {
      return { ok: false, dataUrl: null, error: 'item_not_found' };
    }
    // v3.12.0 (Fase 7): Izinkan type='document' juga — PWA set gdrive_file_url
    // ke URL halaman 1, jadi downloadScreenshotBlob(item) bisa langsung pakai
    // tanpa perubahan. Halaman 2+ di-fetch langsung dari source.pages[i].url
    // di openDocumentViewer (popup.js).
    if (item.type !== 'screenshot' && item.type !== 'document') {
      return { ok: false, dataUrl: null, error: 'not_screenshot' };
    }

    // Step 3: download dari cloud
    const dlRes = await downloadScreenshotBlob(item);
    if (dlRes.ok) {
      return { ok: true, dataUrl: dlRes.dataUrl, source: 'cloud' };
    }

    // Step 4: tidak ada URL cloud — return null (lokal-only screenshot)
    return { ok: false, dataUrl: null, error: dlRes.error || 'no_cloud_url' };
  } catch (e) {
    console.warn('[RecallFox/Supabase] getOrDownloadScreenshotBlob exception:', id, e.message);
    return { ok: false, dataUrl: null, error: e.message };
  }
}

// ============== ROW BUILDERS (local object → DB row) ==============

function _buildVaultItemRow(item, userId) {
  return {
    id: item.id,
    user_id: userId,
    type: item.type,
    title: item.title || null,
    body: item.body || null,
    tags: Array.isArray(item.tags) ? item.tags : [],
    category: item.category || null,
    source: item.source || null,
    link_url: item.linkUrl || null,
    link_title: item.linkTitle || null,
    screenshot_mode: item.screenshotMode || null,
    screenshot_width: item.screenshotWidth || 0,
    screenshot_height: item.screenshotHeight || 0,
    screenshot_format: item.screenshotFormat || null,
    screenshot_bytes: item.screenshotBytes || 0,
    thumbnail_data_url: item.thumbnailDataUrl || null,
    gdrive_file_id: item.gdriveFileId || null,
    gdrive_file_url: item.gdriveFileUrl || null,
    // v3.11.27 (Issue #1 fix): annotation_note DIPINDAH ke tabel screenshots (bukan vault_items).
    // Sebelumnya _buildVaultItemRow kirim annotation_note ke vault_items → Supabase reject
    // PGRST204 "column not found" → SEMUA item gagal insert → 0 item ter-push!
    snapshot_domain: item.snapshotDomain || null,
    snapshot_message_count: item.snapshotMessageCount || 0,
    // v3.15.0 P0-K1: context_purpose — kolom baru di vault_items (ALTER TABLE 25 Jul 2026).
    // Sebelumnya: contextPurpose di-set popup.js tapi di-strip addItem() + tidak ada kolom DB.
    // Sekarang: persist lokal + sync ke cloud. Stop prepend [Tujuan:] ke body (K2 fix di Tahap B).
    context_purpose: item.contextPurpose || null,
    toppings: Array.isArray(item.toppings) ? item.toppings : [],
    variables: Array.isArray(item.variables) ? item.variables : [],
    favorite: !!item.favorite,
    archived: !!item.archived,
    use_count: item.useCount || 0,
    last_used_at: item.lastUsedAt || null,
    created_at: item.createdAt || new Date().toISOString(),
    updated_at: item.updatedAt || new Date().toISOString()
  };
}

// v3.21.6: Helper parse array fleksibel — handle camelCase, snake_case, dan JSON string.
// Root cause bug "bundle members terhapus saat sync": data dari cloud/PWA tersimpan
// sebagai String JSON atau snake_case (item_ids). Array.isArray(string) → false →
// itemIds di-reset ke [] → bundle members terhapus.
// Fix: helper ini coba parse dari berbagai bentuk sebelum fallback ke [].
function _parseArrayField(obj, ...keys) {
  for (const k of keys) {
    if (obj[k] === undefined || obj[k] === null) continue;
    // Already array? Return as-is.
    if (Array.isArray(obj[k])) return obj[k];
    // String? Try JSON.parse (could be '["id1","id2"]' from DB/Postgres).
    if (typeof obj[k] === 'string') {
      const trimmed = obj[k].trim();
      if (trimmed === '') continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
      } catch (e) {
        // Not JSON — maybe comma-separated string? Split and filter.
        if (trimmed.includes(',')) {
          const parts = trimmed.split(',').map(s => s.trim()).filter(Boolean);
          if (parts.length > 0) return parts;
        }
        // Single element string — return as single-item array if non-empty.
        return [trimmed];
      }
    }
    // Object with array-like structure? Try to extract.
    if (typeof obj[k] === 'object' && obj[k] !== null) {
      // Some DBs return { items: [...] } wrapper
      if (Array.isArray(obj[k].items)) return obj[k].items;
      if (Array.isArray(obj[k].data)) return obj[k].data;
    }
  }
  return [];
}

function _buildBundleRow(bundle, userId) {
  // v3.21.6: Pakai _parseArrayField untuk handle camelCase + snake_case + JSON string.
  const itemIds = _parseArrayField(bundle, 'itemIds', 'item_ids');
  const injectOrder = _parseArrayField(bundle, 'injectOrder', 'inject_order', 'itemIds', 'item_ids');
  const noteIds = _parseArrayField(bundle, 'noteIds', 'note_ids');
  return {
    id: bundle.id,
    user_id: userId,
    type: 'bundle',
    title: bundle.name || bundle.title || 'Bundle',
    body: bundle.note || bundle.body || null,
    item_ids: itemIds,
    inject_order: injectOrder,
    note_ids: noteIds,
    color: bundle.color || null,
    inline_prompt: bundle.inlinePrompt || bundle.inline_prompt || null,
    inline_prompt_item_id: bundle.inlinePromptItemId || bundle.inline_prompt_item_id || null,
    favorite: !!bundle.favorite,
    archived: !!bundle.archived,
    created_at: bundle.createdAt || bundle.created_at || new Date().toISOString(),
    updated_at: bundle.updatedAt || bundle.updated_at || new Date().toISOString()
  };
}

function _buildNoteRow(note, userId) {
  return {
    id: note.id,
    user_id: userId,
    title: note.title || null,
    body: note.body || null,
    color: note.color || 'default',
    "group": note.group || null,
    pinned: !!note.pinned,
    archived: !!note.archived,
    done: !!note.done,
    done_at: note.doneAt || null,
    priority: [1,2,3,4].includes(note.priority) ? note.priority : 4,
    due_at: note.dueAt || null,
    labels: Array.isArray(note.labels) ? note.labels : [],
    subtasks: Array.isArray(note.subtasks) ? note.subtasks : [],
    recurring: note.recurring || null,
    created_at: note.createdAt || new Date().toISOString(),
    updated_at: note.updatedAt || new Date().toISOString()
  };
}

function _buildSettingRow(key, value, userId) {
  let settingType = 'STRING';
  if (typeof value === 'boolean') settingType = 'BOOLEAN';
  else if (typeof value === 'number') settingType = 'NUMBER';
  else if (value && typeof value === 'object') settingType = 'JSON';

  return {
    user_id: userId,
    setting_key: key,
    setting_value: value,
    setting_type: settingType,
    category: _categorizeSetting(key),
    updated_at: new Date().toISOString()
  };
}

// ============== ROW PARSERS (DB row → local object) ==============

function _parseVaultItemRow(row) {
  return {
    id: row.id,
    // v3.13.6: Tambah user_id supaya downloadScreenshotBlob bisa reconstruct URL pattern
    // untuk item dengan gdrive_file_url = NULL (PWA v1.6.1 simpan NULL kalau upload Storage gagal).
    // Sebelumnya field ini tidak di-extract → reconstruct pattern (line ~732) skip karena
    // item.user_id undefined → addon return 'no_cloud_url' padahal file mungkin ada di Storage.
    user_id: row.user_id || null,
    userId: row.user_id || null,
    type: row.type,
    title: row.title || '',
    body: row.body || '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    category: row.category || '',
    source: row.source || null,
    linkUrl: row.link_url || '',
    linkTitle: row.link_title || '',
    screenshotMode: row.screenshot_mode || 'visible',
    screenshotWidth: row.screenshot_width || 0,
    screenshotHeight: row.screenshot_height || 0,
    screenshotFormat: row.screenshot_format || 'png',
    screenshotBytes: row.screenshot_bytes || 0,
    thumbnailDataUrl: row.thumbnail_data_url || '',
    gdriveFileId: row.gdrive_file_id || null,
    gdriveFileUrl: row.gdrive_file_url || null,
    snapshotDomain: row.snapshot_domain || '',
    snapshotMessageCount: row.snapshot_message_count || 0,
    // v3.15.0 P0-K1: context_purpose — parse dari cloud ke local
    contextPurpose: row.context_purpose || 'custom',
    toppings: Array.isArray(row.toppings) ? row.toppings : [],
    variables: Array.isArray(row.variables) ? row.variables : [],
    favorite: !!row.favorite,
    archived: !!row.archived,
    useCount: row.use_count || 0,
    lastUsedAt: row.last_used_at || null,
    createdAt: row.created_at || new Date().toISOString(),
    updatedAt: row.updated_at || new Date().toISOString()
  };
}

function _parseBundleRow(row) {
  // v3.21.6: Pakai _parseArrayField untuk handle JSON string dari DB/Postgres.
  // Sebelumnya: Array.isArray(row.item_ids) → false kalau DB kirim sebagai String JSON.
  return {
    id: row.id,
    name: row.title || row.name || 'Bundle',
    note: row.body || row.note || '',
    itemIds: _parseArrayField(row, 'item_ids', 'itemIds'),
    injectOrder: _parseArrayField(row, 'inject_order', 'injectOrder', 'item_ids', 'itemIds'),
    noteIds: _parseArrayField(row, 'note_ids', 'noteIds'),
    color: row.color || '',
    inlinePrompt: row.inline_prompt || row.inlinePrompt || '',
    inlinePromptItemId: row.inline_prompt_item_id || row.inlinePromptItemId || null,
    archived: !!row.archived,
    favorite: !!row.favorite,
    createdAt: row.created_at || row.createdAt || new Date().toISOString(),
    updatedAt: row.updated_at || row.updatedAt || new Date().toISOString()
  };
}

function _parseNoteRow(row) {
  // subtasks could be JSON string from Postgres — handle both array and string
  let subtasks = [];
  if (Array.isArray(row.subtasks)) subtasks = row.subtasks;
  else if (typeof row.subtasks === 'string' && row.subtasks.trim()) {
    try { const p=JSON.parse(row.subtasks); if(Array.isArray(p)) subtasks=p; } catch(e){}
  }
  let recurring = null;
  if (row.recurring && typeof row.recurring === 'object') recurring = row.recurring;
  else if (typeof row.recurring === 'string' && row.recurring.trim()) {
    try { recurring = JSON.parse(row.recurring); } catch(e){}
  }
  return {
    id: row.id,
    title: row.title || '',
    body: row.body || '',
    color: row.color || 'default',
    group: row.group || '',
    pinned: !!row.pinned,
    archived: !!row.archived,
    done: !!row.done,
    doneAt: row.done_at || null,
    priority: [1,2,3,4].includes(row.priority) ? row.priority : 4,
    dueAt: row.due_at || null,
    labels: Array.isArray(row.labels) ? row.labels : [],
    subtasks,
    recurring,
    // v1.8.1: source JSONB untuk note metadata (location, dll). Voice notes dihapus.
    source: row.source || null,
    createdAt: row.created_at || new Date().toISOString(),
    updatedAt: row.updated_at || new Date().toISOString()
  };
}

// ============== HELPERS ==============

const SENSITIVE_SETTINGS = new Set([
  'assistantApiKey', 'assistantFallbackApiKey', 'gdriveAuthToken', 'gdriveTokenLocked',
  'gdriveWebAppUrl', 'supabaseAccessToken', 'supabaseRefreshToken'
]);

function _isSensitiveSetting(key) {
  return SENSITIVE_SETTINGS.has(key);
}

function _categorizeSetting(key) {
  if (key.startsWith('gdrive')) return 'gdrive';
  if (key.startsWith('supabase')) return 'supabase';
  if (key.startsWith('assistant')) return 'assistant';
  if (key.startsWith('prayer')) return 'prayer';
  if (key.startsWith('screenshot')) return 'screenshot';
  if (key.startsWith('clearCache')) return 'clearcache';
  if (key.startsWith('contentGuard')) return 'content_guard';
  if (key.startsWith('quran') || key.startsWith('exercise')) return 'habits';
  if (['theme', 'displayMode', 'injectMode', 'floatingButtonEnabled', 'overlayButtonEnabled',
       'sidebarAutoOpen', 'rememberLastTab', 'lastActiveTab', 'lastSidebarWidth',
       'locale', 'syncEnabled', 'syncAutoEnabled'].includes(key)) return 'ui';
  return 'other';
}

async function _logSync(action, direction, stats, durationMs) {
  try {
    const userId = await getUserId();
    if (!userId) return;
    await insertRow(SYNC_LOG_TABLE, {
      user_id: userId,
      action,
      direction,
      items_count: stats.items || stats.itemsAdded || 0,
      notes_count: stats.notes || stats.notesAdded || 0,
      screenshots_count: stats.screenshots || 0,
      duration_ms: durationMs,
      status: stats.errors && stats.errors.length > 0 ? 'error' : 'ok',
      error_message: stats.errors && stats.errors.length > 0
        ? JSON.stringify(stats.errors.slice(0, 5))
        : null,
      created_at: new Date().toISOString()
    });
  } catch (e) {
    // Silent fail — log tidak boleh block sync
  }
}

// ============== DELETE (untuk hapus dari cloud saat item dihapus lokal) ==============

/**
 * v3.11.29: Soft-delete item dari Supabase cloud.
 * Set deleted_at = NOW() (bukan hard delete) supaya:
 *   - Device lain tahu item ini dihapus (via realtime subscription)
 *   - Pull sync bisa detect delete dan hapus lokal juga
 *   - Data tidak benar-benar hilang (bisa di-restore kalau perlu)
 */
export async function deleteItemFromCloud(itemId) {
  if (!(await isLoggedIn())) return { ok: false, error: 'not_logged_in' };
  const userId = await getUserId();
  if (!userId) return { ok: false, error: 'no_user_id' };

  try {
    // v3.11.29: Soft-delete — set deleted_at = NOW() instead of DELETE
    const res = await upsertRow(VAULT_TABLE, {
      id: itemId,
      user_id: userId,
      deleted_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    console.log('[RecallFox/Supabase] Soft-delete item:', itemId, '→', res.ok ? 'OK' : res.error);

    // Screenshot storage tetap di-hard-delete (tidak perlu simpan file gambar yang sudah dihapus)
    const screenshotsRes = await selectRows(SCREENSHOTS_TABLE, {
      filter: `id=eq.${itemId}`,
      limit: 1
    });
    if (screenshotsRes.ok && screenshotsRes.data?.length > 0) {
      const screenshot = screenshotsRes.data[0];
      if (screenshot.storage_path) {
        await deleteFile(STORAGE_BUCKET, screenshot.storage_path);
      }
      await deleteRow(SCREENSHOTS_TABLE, `id=eq.${itemId}`);
    }
    return res;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * v3.11.29: Soft-delete note dari Supabase cloud.
 */
export async function deleteNoteFromCloud(noteId) {
  if (!(await isLoggedIn())) return { ok: false, error: 'not_logged_in' };
  const userId = await getUserId();
  if (!userId) return { ok: false, error: 'no_user_id' };

  // v3.11.29: Soft-delete
  const res = await upsertRow(NOTES_TABLE, {
    id: noteId,
    user_id: userId,
    deleted_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
  console.log('[RecallFox/Supabase] Soft-delete note:', noteId, '→', res.ok ? 'OK' : res.error);
  return res;
}

// ============== AUTO-SYNC (debounced) ==============

let _autoSyncTimer = null;
const AUTO_SYNC_DELAY = 5000; // 5 detik

/**
 * Trigger push ke Supabase (debounced 5 detik).
 * v3.11.29: Setelah push, juga trigger pull otomatis (untuk ambil perubahan dari device lain).
 * Dipanggil otomatis saat vault berubah.
 */
export function triggerAutoSync() {
  if (_autoSyncTimer) clearTimeout(_autoSyncTimer);
  _autoSyncTimer = setTimeout(async () => {
    _autoSyncTimer = null;
    try {
      const loggedIn = await isLoggedIn();
      if (!loggedIn) return;
      console.log('[RecallFox/Supabase] Auto-sync triggered (pull first, then push)');
      // v3.13.7: PULL DULU, lalu PUSH — supaya device belajar delete dari cloud
      // sebelum push re-create bundle yang sudah di-hard-delete di device lain.
      // Sebelumnya: push dulu, lalu pull — Device B yang offline saat Device A
      // delete bundle, akan push bundle-nya kembali ke cloud (re-INSERT) sebelum
      // tahu kalau bundle sudah dihapus. Pull-first mencegah resurrection.
      // Design ini selaras dengan v3.11.31 changelog ("PULL DULU, lalu PUSH").
      const pullRes = await pullFromSupabaseV33();
      if (pullRes.ok && (pullRes.stats.itemsAdded > 0 || pullRes.stats.itemsUpdated > 0 || pullRes.stats.itemsDeleted > 0 || pullRes.stats.notesAdded > 0 || pullRes.stats.notesUpdated > 0 || pullRes.stats.notesDeleted > 0)) {
        console.log('[RecallFox/Supabase] Auto-pull OK:', pullRes.stats);
        browser.runtime.sendMessage({ type: 'VAULT_UPDATED' }).catch(() => {});
      }
      const pushRes = await pushToSupabase();
      if (pushRes.ok) {
        console.log('[RecallFox/Supabase] Auto-push OK:', pushRes.stats);
      } else {
        console.warn('[RecallFox/Supabase] Auto-push failed:', pushRes.error);
      }
    } catch (e) {
      console.warn('[RecallFox/Supabase] Auto-sync error:', e.message);
    }
  }, AUTO_SYNC_DELAY);
}

// ============== REALTIME SUBSCRIPTION (v3.11.30) ==============
// v3.11.30: FIX — gunakan browser.alarms API BUKAN setInterval.
// Root cause v3.11.29: setInterval di Firefox MV3 service worker MATI setelah
// 30 detik idle karena service worker ditidurkan oleh browser.
// browser.alarms API bisa wake-up service worker bahkan dari keadaan tidur.
//
// Limitasi Firefox: minimum periodInMinutes = 1 (60 detik).
// Untuk sync yang lebih cepat, auto-sync debounced 5s (via triggerAutoSync)
// masih pakai setTimeout — itu jalan selama service worker aktif (ada activity).
// Realtime polling via alarms adalah BACKUP untuk deteksi perubahan dari device lain
// saat device ini idle (tidak ada aktivitas addon).

const REALTIME_ALARM_NAME = 'rf-supabase-realtime';

/**
 * v3.11.30: Start realtime sync via browser.alarms.
 * Dipanggil saat user login (di background.js) + saat addon startup.
 */
export async function startRealtimeSync() {
  if (!(await isLoggedIn())) return;
  console.log('[RecallFox/Supabase] Starting realtime sync via browser.alarms (every 1 min)...');

  // Stop existing alarm
  stopRealtimeSync();

  // v3.11.30: Pakai browser.alarms — BISA wake-up service worker dari tidur
  try {
    // periodInMinutes: 1 = setiap 60 detik (minimum Firefox)
    // delayInMinutes: 0.5 = mulai pertama kali setelah 30 detik
    await browser.alarms.create(REALTIME_ALARM_NAME, {
      delayInMinutes: 0.5,
      periodInMinutes: 1
    });
    console.log('[RecallFox/Supabase] Realtime alarm created:', REALTIME_ALARM_NAME);

    // Simpan flag supaya alarm handler tahu realtime aktif
    await browser.storage.local.set({ 'recallfox_realtime_active': true });

    // Initial pull setelah 5 detik (jangan tunggu alarm pertama)
    // v3.13.3 (A2 fix): Pakai pullFromSupabaseV33 (dengan reconciliation)
    setTimeout(async () => {
      try {
        console.log('[RecallFox/Supabase] Initial realtime pull...');
        const pullRes = await pullFromSupabaseV33();
        if (pullRes.ok) {
          const lastPullKey = 'recallfox_supabase_last_pull';
          await browser.storage.local.set({ [lastPullKey]: new Date().toISOString() });
          if (pullRes.stats.itemsAdded > 0 || pullRes.stats.itemsUpdated > 0 ||
              pullRes.stats.itemsDeleted > 0 || pullRes.stats.notesAdded > 0) {
            console.log('[RecallFox/Supabase] Initial pull result:', pullRes.stats);
            browser.runtime.sendMessage({ type: 'VAULT_UPDATED' }).catch(() => {});
          }
        }
      } catch (e) {
        console.warn('[RecallFox/Supabase] Initial realtime pull error:', e.message);
      }
    }, 5000);
  } catch (e) {
    console.warn('[RecallFox/Supabase] Failed to create alarm:', e.message);
  }
}

/**
 * v3.11.30: Stop realtime sync.
 */
export async function stopRealtimeSync() {
  try {
    await browser.alarms.clear(REALTIME_ALARM_NAME);
  } catch (e) {}
  await browser.storage.local.set({ 'recallfox_realtime_active': false });
  console.log('[RecallFox/Supabase] Realtime sync stopped');
}

/**
 * v3.11.30: Check apakah realtime sync sedang berjalan.
 */
export async function isRealtimeRunning() {
  try {
    const alarm = await browser.alarms.get(REALTIME_ALARM_NAME);
    return !!alarm;
  } catch (e) {
    return false;
  }
}

/**
 * v3.11.30: Handler untuk realtime alarm — dipanggil oleh browser.alarms.onAlarm
 * di background.js. Jangan panggil langsung — biarkan background.js yang route.
 */
export async function handleRealtimeAlarm() {
  try {
    const loggedIn = await isLoggedIn();
    if (!loggedIn) {
      await stopRealtimeSync();
      return;
    }
    const userId = await getUserId();
    if (!userId) return;

    // v3.11.40: Cek vault_items AND notes — sebelumnya hanya vault_items.
    // Bug: perubahan notes di PWA tidak terdeteksi di addon (notes ga ke-pull).
    const lastPullKey = 'recallfox_supabase_last_pull';
    const stored = await browser.storage.local.get(lastPullKey);
    const lastPull = stored[lastPullKey] || '1970-01-01T00:00:00.000Z';

    // Query vault_items latest
    const vaultRes = await selectRows(VAULT_TABLE, {
      select: 'updated_at',
      filter: `user_id=eq.${userId}`,
      order: 'updated_at.desc',
      limit: 1
    });
    // Query notes latest
    const notesRes = await selectRows(NOTES_TABLE, {
      select: 'updated_at',
      filter: `user_id=eq.${userId}`,
      order: 'updated_at.desc',
      limit: 1
    });

    const vaultLatest = (vaultRes.ok && vaultRes.data?.[0]?.updated_at) ? vaultRes.data[0].updated_at : null;
    const notesLatest = (notesRes.ok && notesRes.data?.[0]?.updated_at) ? notesRes.data[0].updated_at : null;
    const cloudLatest = [vaultLatest, notesLatest].filter(Boolean).sort().pop();

    if (!cloudLatest) return;

    if (new Date(cloudLatest) > new Date(lastPull)) {
      console.log('[RecallFox/Supabase] Realtime alarm: cloud changed since', lastPull, '→ pulling...', { vaultLatest, notesLatest });
      // v3.13.3 (A2 fix): Pakai pullFromSupabaseV33 — variant dengan reconciliation.
      // BUG A2: Sebelumnya panggil pullFromSupabase (variant lama tanpa reconciliation),
      // sehingga item yang dihapus di PWA tetap muncul di addon.
      const pullRes = await pullFromSupabaseV33();
      if (pullRes.ok) {
        await browser.storage.local.set({ [lastPullKey]: new Date().toISOString() });
        // Notify UI untuk refresh vault
        browser.runtime.sendMessage({ type: 'VAULT_UPDATED' }).catch(() => {});
        // Also broadcast ke semua tabs (popup/sidebar yang terbuka)
        try {
          const tabs = await browser.tabs.query({});
          for (const t of tabs) {
            browser.tabs.sendMessage(t.id, { type: 'VAULT_UPDATED' }).catch(() => {});
          }
        } catch (e) {}
        console.log('[RecallFox/Supabase] Realtime pull done:', pullRes.stats);
      } else {
        // v3.13.3 (A4 fix): Simpan error ke storage supaya UI bisa tampilkan
        try {
          await browser.storage.local.set({ 'recallfox_last_sync_error': JSON.stringify({ ts: new Date().toISOString(), source: 'handleRealtimeAlarm', error: pullRes.error || 'unknown' }) });
        } catch (e2) {}
      }
    } else {
      // No changes — silent
    }
  } catch (e) {
    console.warn('[RecallFox/Supabase] Realtime alarm error:', e.message);
  }
}

// ============== v3.11.33: DIRECT CLOUD OPS (immediate, no debounce) ==============
// User feedback (Sesi 1, 18 Jul 2026):
//   "tombol simpan ke vault ini harus mengandung logika begini, ketika di pencet,
//    itu artinya langsung upload ke suppabase sehingga image nya tersimpan dan
//    selaras diseluruh device. begitu pula ketika pencet batch delet, itu artinya
//    menghapus image di suppabase dan image nya terhapus dan selaras diseluruh
//    device."
//   "kacau eror semua. jadi push data baru ga ngaruh ketika di pull semua ketarik.
//    datanya numpuk. contoh nih, ada di delet 10 gambar, bikin tangkap gambar baru 1,
//    kemudian push. harapannya kan tetep 1 gambar ya ketika di pull, eh malah jadi 11."
//
// Root cause v3.11.32:
//   - Soft-delete (set deleted_at=NOW()) bersamaan dengan triggerAutoSync (debounced 5s)
//     yang push semua item lokal. Push tidak kirim deleted_at, tapi PostgREST upsert
//     dengan resolution=merge-duplicates UPDATE hanya kolom di payload — seharusnya
//     aman. TAPI dalam praktek, race condition antara 10 soft-delete paralel +
//     auto-push menyebabkan deleted_at tidak konsisten ter-set.
//   - Pull tidak filter `deleted_at IS NULL` di query, jadi row dengan deleted_at
//     tetap di-fetch dulu. Kalau deleted_at gagal ter-set di cloud, row tetap muncul.
//
// Fix v3.11.33:
//   1. HARD DELETE di cloud (bukan soft-delete). Langsung DELETE row.
//   2. DIRECT UPSERT per-item (bukan batch push). Setiap addItem/updateItem langsung
//      kirim ke cloud.
//   3. TRUE REALTIME subscription via Supabase Realtime WebSocket (postgres_changes).
//      Bukan polling 1 menit.
//   4. Pull hanya untuk initial load / manual refresh.

/**
 * v3.11.33: Direct upsert satu vault item ke cloud. Tunggu sampai selesai.
 * Dipanggil oleh addItem() dan updateItem() di storage.js.
 *
 * Untuk screenshot: juga upload blob ke Storage bucket.
 *
 * @param {Object} item - vault item (format lokal)
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function directUpsertVaultItem(item) {
  if (!item?.id) return { ok: false, error: 'no_id' };
  if (!(await isLoggedIn())) return { ok: false, error: 'not_logged_in' };
  const userId = await getUserId();
  if (!userId) return { ok: false, error: 'no_user_id' };

  try {
    // Hapus dari delete registry kalau ada (item di-restore / re-add dengan ID sama)
    const reg = await _getDeleteRegistry();
    if (reg.items[item.id]) {
      delete reg.items[item.id];
      await _saveDeleteRegistry(reg);
    }

    const row = _buildVaultItemRow(item, userId);
    // v3.11.33: Eksplisit set deleted_at = NULL supaya upsert meng-clear tombstone
    // kalau ada. Ini fix race condition v3.11.32.
    row.deleted_at = null;
    row.device_id = await _getDeviceId();

    const res = await upsertRow(VAULT_TABLE, row);
    if (!res.ok) {
      console.warn('[RecallFox/Supabase] directUpsertVaultItem failed:', item.id, res.error);
      return res;
    }

    // Upload screenshot blob ke Storage
    if (item.type === 'screenshot') {
      const blobRes = await _uploadScreenshotBlob(item, userId);
      if (!blobRes.ok) {
        console.warn('[RecallFox/Supabase] Screenshot blob upload failed:', item.id, blobRes.error);
        // Tetap return ok = true karena metadata sudah tersimpan
      }
    }
    // v3.20.35-dev: Upload file document ke Storage bucket 'documents'
    if (item.type === 'file') {
      const fileRes = await _uploadFileDocument(item, userId);
      if (!fileRes.ok) {
        console.warn('[RecallFox/Supabase] File document upload failed:', item.id, fileRes.error);
        // Tetap return ok = true — item + body sudah tersimpan, Kopi File jalan
      }
    }
    return { ok: true };
  } catch (e) {
    console.warn('[RecallFox/Supabase] directUpsertVaultItem exception:', item.id, e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * v3.11.33: Direct HARD DELETE satu vault item dari cloud. Tunggu sampai selesai.
 * Dipanggil oleh deleteItem() di storage.js.
 *
 * - Hard delete row dari vault_items (bukan soft-delete).
 * - Hapus screenshot blob dari Storage kalau ada.
 * - Tambah ke delete registry lokal supaya tidak di-push ulang.
 *
 * @param {string} itemId
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function directDeleteVaultItem(itemId) {
  if (!itemId) return { ok: false, error: 'no_id' };
  if (!(await isLoggedIn())) {
    // Tidak login → tetap catat ke registry supaya saat login tidak di-push ulang
    await addToDeleteRegistry(itemId, new Date().toISOString());
    return { ok: false, error: 'not_logged_in' };
  }
  const userId = await getUserId();
  if (!userId) {
    await addToDeleteRegistry(itemId, new Date().toISOString());
    return { ok: false, error: 'no_user_id' };
  }

  try {
    // Tambah ke delete registry lokal DULU (supaya pull berikutnya tidak re-add)
    await addToDeleteRegistry(itemId, new Date().toISOString());

    // v3.20.35-dev: Query row SEBELUM delete untuk dapat type + gdrive_file_id
    // (setelah delete, info hilang → tidak bisa cleanup file di Storage)
    let itemInfo = null;
    try {
      const itemRes = await selectRows(VAULT_TABLE, { filter: 'id=eq.' + itemId, limit: 1 });
      if (itemRes.ok && itemRes.data && itemRes.data.length > 0) {
        itemInfo = itemRes.data[0];
      }
    } catch (e) {
      console.warn('[RecallFox/Supabase] directDeleteVaultItem: query item info failed:', itemId, e.message);
    }

    // Hard delete row dari vault_items
    const delRes = await deleteRow(VAULT_TABLE, `id=eq.${itemId}`);
    if (!delRes.ok) {
      console.warn('[RecallFox/Supabase] directDeleteVaultItem row delete failed:', itemId, delRes.error);
      // Tetap lanjut untuk hapus screenshot
    }

    // Hapus screenshot metadata + storage file
    try {
      const screenshotsRes = await selectRows(SCREENSHOTS_TABLE, {
        filter: `id=eq.${itemId}`,
        limit: 1
      });
      if (screenshotsRes.ok && screenshotsRes.data?.length > 0) {
        const screenshot = screenshotsRes.data[0];
        if (screenshot.storage_path) {
          await deleteFile(STORAGE_BUCKET, screenshot.storage_path);
        }
        await deleteRow(SCREENSHOTS_TABLE, `id=eq.${itemId}`);
      }
    } catch (e) {
      console.warn('[RecallFox/Supabase] Screenshot cleanup failed:', itemId, e.message);
    }

    // v3.20.35-dev: Hapus file document dari bucket 'documents' kalau type='file'
    if (itemInfo && itemInfo.type === 'file' && itemInfo.gdrive_file_id) {
      try {
        const delFileRes = await deleteFile(DOCUMENTS_BUCKET, itemInfo.gdrive_file_id);
        if (!delFileRes.ok) {
          console.warn('[RecallFox/Supabase] File document cleanup failed:', itemId, delFileRes.error);
        } else {
          console.log('[RecallFox/Supabase] File document deleted from Storage:', itemInfo.gdrive_file_id);
        }
      } catch (e) {
        console.warn('[RecallFox/Supabase] File document cleanup exception:', itemId, e.message);
      }
    }

    console.log('[RecallFox/Supabase] directDeleteVaultItem OK:', itemId);
    return { ok: true };
  } catch (e) {
    console.warn('[RecallFox/Supabase] directDeleteVaultItem exception:', itemId, e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * v3.11.33: Direct upsert satu note ke cloud.
 */
export async function directUpsertNote(note) {
  if (!note?.id) return { ok: false, error: 'no_id' };
  if (!(await isLoggedIn())) return { ok: false, error: 'not_logged_in' };
  const userId = await getUserId();
  if (!userId) return { ok: false, error: 'no_user_id' };

  try {
    const reg = await _getDeleteRegistry();
    if (reg.notes[note.id]) {
      delete reg.notes[note.id];
      await _saveDeleteRegistry(reg);
    }

    const row = _buildNoteRow(note, userId);
    row.deleted_at = null;
    row.device_id = await _getDeviceId();

    const res = await upsertRow(NOTES_TABLE, row);
    if (!res.ok) {
      console.warn('[RecallFox/Supabase] directUpsertNote failed:', note.id, res.error);
    }
    return res;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * v3.11.33: Direct HARD DELETE satu note dari cloud.
 */
export async function directDeleteNote(noteId) {
  if (!noteId) return { ok: false, error: 'no_id' };
  if (!(await isLoggedIn())) {
    await addNoteToDeleteRegistry(noteId, new Date().toISOString());
    return { ok: false, error: 'not_logged_in' };
  }
  const userId = await getUserId();
  if (!userId) {
    await addNoteToDeleteRegistry(noteId, new Date().toISOString());
    return { ok: false, error: 'no_user_id' };
  }

  try {
    await addNoteToDeleteRegistry(noteId, new Date().toISOString());
    const res = await deleteRow(NOTES_TABLE, `id=eq.${noteId}`);
    console.log('[RecallFox/Supabase] directDeleteNote:', noteId, '→', res.ok ? 'OK' : res.error);
    return res;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ============== v3.11.33: DEVICE ID ==============
// Device ID unik per browser installation. Dipakai untuk track device mana
// yang terakhir modify (device_id column di vault_items / notes).
const DEVICE_ID_KEY = 'recallfox_device_id';

async function _getDeviceId() {
  try {
    const data = await browser.storage.local.get(DEVICE_ID_KEY);
    if (data[DEVICE_ID_KEY]) return data[DEVICE_ID_KEY];
    const newId = 'dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    await browser.storage.local.set({ [DEVICE_ID_KEY]: newId });
    return newId;
  } catch (e) {
    return 'dev_unknown';
  }
}

// ============== v3.11.33: TRUE REALTIME SUBSCRIPTION ==============
// Sebelumnya: polling via browser.alarms setiap 1 menit (bukan realtime beneran).
// Sekarang: subscribe ke Supabase Realtime WebSocket channel untuk postgres_changes
// di table vault_items + notes, filter by user_id.
//
// Limitasi: Firefox MV3 service worker bisa tidur setelah 30s idle. WebSocket
// mungkin terputus saat tidur. Solusinya: tetap pakai browser.alarms sebagai
// BACKUP polling — tapi interval diperpanjang ke 2 menit (karena realtime WS
// biasanya cukup).
//
// Cara kerja:
//   - subscribeRealtimeVault() dipanggil saat user login.
//   - Subscribe ke channel 'realtime:vault_items' + 'realtime:notes'.
//   - On INSERT (from other device): tambah ke vault lokal.
//   - On UPDATE (from other device): update vault lokal (last-write-wins by updated_at).
//   - On DELETE (from other device): hapus dari vault lokal.

let _realtimeChannel = null;

// v3.20.39: Per-ID lock map untuk serialisasi realtime events.
//   Sebelumnya: _handleRealtimeEvent dipanggil TANPA await dari onmessage →
//   3 events (INSERT+UPDATE+UPDATE) untuk ID yang sama race concurrent →
//   masing-masing lihat localIdx < 0 → push 3 duplikat.
//   Sekarang: setiap ID punya promise chain, event berurutan per-ID.
//   Event untuk ID berbeda tetap parallel (tidak bottleneck).
const _realtimeLocks = new Map();
function _withRealtimeLock(id, fn) {
  const prev = _realtimeLocks.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  _realtimeLocks.set(id, next);
  // Cleanup lock setelah selesai (leak guard)
  next.finally(() => {
    if (_realtimeLocks.get(id) === next) _realtimeLocks.delete(id);
  });
  return next;
}

/**
 * v3.11.33: Subscribe ke Supabase Realtime untuk vault_items + notes.
 * Dipanggil dari background.js saat user login.
 */
export async function subscribeRealtimeVault() {
  if (!(await isLoggedIn())) return;
  const userId = await getUserId();
  if (!userId) return;

  // Unsubscribe channel lama kalau ada
  await unsubscribeRealtimeVault();

  console.log('[RecallFox/Supabase] Subscribing to Realtime channel for user', userId);

  try {
    const session = await getSession();
    if (!session?.access_token) {
      console.warn('[RecallFox/Supabase] No access token — cannot subscribe realtime');
      return;
    }

    // Supabase Realtime via WebSocket
    // v3.13.3 (A3 fix): BUG A3 — sebelumnya wsUrl pakai session.access_token (JWT)
    // sebagai apikey. Supabase Realtime V1 mengharapkan ANON KEY sebagai apikey
    // (untuk RLS lookup) + JWT sebagai Authorization header/param.
    // Topic juga salah: `realtime:vault_${userId}` → harus `realtime:public:vault_items`.
    // Karena satu channel hanya bisa subscribe ke satu table, kita subscribe ke
    // vault_items saja di channel utama; notes di-handle oleh polling backup
    // (interval 1 menit — fix A5).
    const channelName = `realtime:public:vault_items`;
    const wsUrl = `wss://${SUPABASE_URL.replace('https://', '')}/realtime/v1/websocket?apikey=${SUPABASE_ANON_KEY}&vsn=1.0.0`;

    // Firefox MV3: WebSocket di service worker bisa idle-put-to-sleep.
    // Kita tetap buat WS, plus backup polling alarm 1 menit (v3.13.3 A5 fix).
    try {
      _realtimeChannel = new WebSocket(wsUrl);
      _realtimeChannel.onopen = () => {
        console.log('[RecallFox/Supabase] Realtime WS connected');
        // Join channel untuk postgres_changes di vault_items
        const joinMsg = {
          topic: channelName,
          event: 'phx_join',
          payload: {
            config: {
              broadcast: { self: false },
              presence: { key: '' },
              postgres_changes: [
                { event: '*', schema: 'public', table: 'vault_items', filter: `user_id=eq.${userId}` }
              ]
            },
            // v3.13.3 (A3 fix): Sertakan access_token JWT supaya RLS bisa identifikasi user
            access_token: session.access_token
          },
          ref: '1'
        };
        _realtimeChannel.send(JSON.stringify(joinMsg));
      };
      _realtimeChannel.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          // Handle postgres_changes events
          if (msg.event === 'INSERT' || msg.event === 'UPDATE' || msg.event === 'DELETE') {
            // v3.20.39: Serialize per-ID supaya 3 events (INSERT+UPDATE+UPDATE)
            //   untuk ID yang sama tidak race concurrent → no duplicates.
            const record = msg.payload?.record || msg.payload?.old_record;
            const id = record?.id;
            if (id) {
              _withRealtimeLock(id, () => _handleRealtimeEvent(msg.event, msg.payload));
            } else {
              _handleRealtimeEvent(msg.event, msg.payload);
            }
          }
        } catch (e) { /* silent */ }
      };
      _realtimeChannel.onerror = (e) => {
        console.warn('[RecallFox/Supabase] Realtime WS error — fallback to polling');
      };
      _realtimeChannel.onclose = () => {
        console.log('[RecallFox/Supabase] Realtime WS closed — will retry on next alarm');
        _realtimeChannel = null;
      };
    } catch (e) {
      console.warn('[RecallFox/Supabase] WebSocket init failed, using polling only:', e.message);
    }

    // Backup polling: setiap 1 menit (v3.13.3 A5 fix — sebelumnya 2 menit).
    // Realtime WS sering gagal connect / disconnect di Firefox MV3, jadi polling
    // 1 menit tetap relevan. handleRealtimeAlarm cek dulu apakah ada perubahan
    // (query updated_at latest) sebelum pull penuh — jadi tidak boros bandwidth.
    try {
      await browser.alarms.create(REALTIME_ALARM_NAME, {
        delayInMinutes: 0.5,
        periodInMinutes: 1
      });
    } catch (e) { /* silent */ }
    await browser.storage.local.set({ 'recallfox_realtime_active': true });

  } catch (e) {
    console.warn('[RecallFox/Supabase] subscribeRealtimeVault error:', e.message);
  }
}

/**
 * v3.11.33: Unsubscribe Realtime channel.
 */
export async function unsubscribeRealtimeVault() {
  try {
    if (_realtimeChannel) {
      try { _realtimeChannel.close(); } catch (e) {}
      _realtimeChannel = null;
    }
  } catch (e) {}
}

/**
 * v3.11.33: Handle realtime event dari WebSocket (INSERT/UPDATE/DELETE).
 * Apply ke vault lokal.
 */
async function _handleRealtimeEvent(eventType, payload) {
  try {
    if (!payload?.record && !payload?.old_record) return;
    const record = payload.record || payload.old_record;

    if (payload.type === 'vault_items' || payload.table === 'vault_items') {
      const vault = await getVault();
      const items = vault.items || [];
      const bundles = vault.bundles || [];

      if (eventType === 'DELETE') {
        // Hard delete dari lokal
        const id = record.id;
        const beforeLen = items.length;
        vault.items = items.filter(i => i.id !== id);
        vault.bundles = bundles.filter(b => b.id !== id);
        if (vault.items.length !== beforeLen) {
          await saveVault(vault);
          await addToDeleteRegistry(id, new Date().toISOString());
          browser.runtime.sendMessage({ type: 'VAULT_UPDATED' }).catch(() => {});
          console.log('[RecallFox/Supabase] Realtime DELETE applied:', id);
        }
      } else if (eventType === 'INSERT' || eventType === 'UPDATE') {
        // Skip soft-deleted rows (kalau ada)
        if (record.deleted_at) {
          // Hapus dari lokal kalau ada
          const id = record.id;
          const beforeLen = items.length;
          vault.items = items.filter(i => i.id !== id);
          vault.bundles = bundles.filter(b => b.id !== id);
          if (vault.items.length !== beforeLen) {
            await saveVault(vault);
            await addToDeleteRegistry(id, record.deleted_at);
            browser.runtime.sendMessage({ type: 'VAULT_UPDATED' }).catch(() => {});
          }
          return;
        }

        // Last-write-wins
        const localIdx = items.findIndex(i => i.id === record.id);
        const bundleIdx = bundles.findIndex(b => b.id === record.id);
        const cloudUpdatedAt = new Date(record.updated_at).getTime();

        if (record.type === 'bundle') {
          // v3.13.7: Cek delete registry — jangan re-add bundle yang sudah dihapus
          // di device ini. Sebelumnya bundle branch tidak ada check (items branch ada).
          const reg = await _getDeleteRegistry();
          if (reg.items[record.id]) {
            console.log('[RecallFox/Supabase] Realtime: skip bundle in delete registry:', record.id);
            return;
          }
          const bundle = _parseBundleRow(record);
          if (bundleIdx < 0) {
            bundles.push(bundle);
            vault.bundles = bundles;
            await saveVault(vault);
            browser.runtime.sendMessage({ type: 'VAULT_UPDATED' }).catch(() => {});
            console.log('[RecallFox/Supabase] Realtime INSERT bundle:', record.id);
          } else if (cloudUpdatedAt > new Date(bundles[bundleIdx].updatedAt || 0).getTime()) {
            bundles[bundleIdx] = bundle;
            vault.bundles = bundles;
            await saveVault(vault);
            browser.runtime.sendMessage({ type: 'VAULT_UPDATED' }).catch(() => {});
            console.log('[RecallFox/Supabase] Realtime UPDATE bundle:', record.id);
          }
        } else {
          const item = _parseVaultItemRow(record);
          if (localIdx < 0) {
            // Cek delete registry — jangan re-add item yang sudah dihapus di device ini
            const reg = await _getDeleteRegistry();
            if (reg.items[record.id]) {
              // Sudah dihapus di device ini — skip (jangan tampilkan ulang)
              return;
            }
            items.push(item);
            vault.items = items;
            await saveVault(vault);
            browser.runtime.sendMessage({ type: 'VAULT_UPDATED' }).catch(() => {});
            console.log('[RecallFox/Supabase] Realtime INSERT item:', record.id);
          } else if (cloudUpdatedAt > new Date(items[localIdx].updatedAt || 0).getTime()) {
            items[localIdx] = item;
            vault.items = items;
            await saveVault(vault);
            browser.runtime.sendMessage({ type: 'VAULT_UPDATED' }).catch(() => {});
            console.log('[RecallFox/Supabase] Realtime UPDATE item:', record.id);
          }
        }
      }
    } else if (payload.type === 'notes' || payload.table === 'notes') {
      const localNotes = await getNotes();

      if (eventType === 'DELETE') {
        const id = record.id;
        const beforeLen = localNotes.length;
        const filtered = localNotes.filter(n => n.id !== id);
        if (filtered.length !== beforeLen) {
          await saveNotes(filtered);
          await addNoteToDeleteRegistry(id, new Date().toISOString());
          browser.runtime.sendMessage({ type: 'VAULT_UPDATED' }).catch(() => {});
        }
      } else if (eventType === 'INSERT' || eventType === 'UPDATE') {
        if (record.deleted_at) {
          const id = record.id;
          const filtered = localNotes.filter(n => n.id !== id);
          if (filtered.length !== localNotes.length) {
            await saveNotes(filtered);
            await addNoteToDeleteRegistry(id, record.deleted_at);
            browser.runtime.sendMessage({ type: 'VAULT_UPDATED' }).catch(() => {});
          }
          return;
        }

        const note = _parseNoteRow(record);
        const idx = localNotes.findIndex(n => n.id === note.id);
        const cloudUpdatedAt = new Date(record.updated_at).getTime();
        if (idx < 0) {
          const reg = await _getDeleteRegistry();
          if (reg.notes[record.id]) return;
          localNotes.push(note);
          await saveNotes(localNotes);
          browser.runtime.sendMessage({ type: 'VAULT_UPDATED' }).catch(() => {});
        } else if (cloudUpdatedAt > new Date(localNotes[idx].updatedAt || 0).getTime()) {
          localNotes[idx] = note;
          await saveNotes(localNotes);
          browser.runtime.sendMessage({ type: 'VAULT_UPDATED' }).catch(() => {});
        }
      }
    }
  } catch (e) {
    console.warn('[RecallFox/Supabase] _handleRealtimeEvent error:', e.message);
  }
}

/**
 * v3.11.33: Pull HANYA item yang belum di-tombstone (deleted_at IS NULL).
 * Filter di server-side, bukan client-side. Lebih cepat + tidak mungkin
// "lupa" filter.
 */
export async function pullFromSupabaseV33() {
  if (!(await isLoggedIn())) return { ok: false, error: 'not_logged_in' };
  const userId = await getUserId();
  if (!userId) return { ok: false, error: 'no_user_id' };

  const startTime = Date.now();
  const now = startTime;
  const stats = { itemsAdded: 0, itemsUpdated: 0, itemsDeleted: 0, notesAdded: 0, notesUpdated: 0, notesDeleted: 0, errors: [] };

  try {
    // === Pull vault items — HANYA yang deleted_at IS NULL ===
    const itemsRes = await selectRows(VAULT_TABLE, {
      select: '*',
      filter: `user_id=eq.${userId}&deleted_at=is.null`,
      order: 'updated_at.desc'
    });
    if (itemsRes.ok && itemsRes.data) {
      const vault = await getVault();
      let localItems = vault.items || [];
      const localBundles = vault.bundles || [];

      // v3.20.39: Dedup localItems by ID SEBELUM merge.
      //   Sebelumnya: kalau localItems sudah punya duplikat (dari bug lama /
      //   realtime race), findIndex cuma return FIRST match → duplikat lain
      //   tetap ada → muncul berkali-kali di list view.
      //   Sekarang: kalau ada ID sama, keep yang updatedAt-nya paling baru.
      //   Fix BUG 3 (SPEC-recallfox muncul 2x) + BUG 1 (file duplikat).
      const seenIds = new Map();
      const dedupedItems = [];
      for (const it of localItems) {
        const existing = seenIds.get(it.id);
        if (!existing) {
          seenIds.set(it.id, it);
          dedupedItems.push(it);
        } else {
          // Sudah ada — keep yang updatedAt lebih baru
          const existingUpdated = new Date(existing.updatedAt || 0).getTime();
          const newUpdated = new Date(it.updatedAt || 0).getTime();
          if (newUpdated > existingUpdated) {
            const idx = dedupedItems.findIndex(i => i.id === it.id);
            if (idx >= 0) dedupedItems[idx] = it;
            seenIds.set(it.id, it);
            console.warn('[RecallFox/Supabase] pullV33: removed local duplicate (kept newer):', it.id);
          } else {
            console.warn('[RecallFox/Supabase] pullV33: removed local duplicate (kept existing newer):', it.id);
          }
        }
      }
      if (dedupedItems.length !== localItems.length) {
        console.log('[RecallFox/Supabase] pullV33: deduped localItems:', localItems.length, '→', dedupedItems.length);
      }
      localItems = dedupedItems;

      // Build set dari cloud IDs yang masih hidup
      const cloudLiveIds = new Set(itemsRes.data.map(r => r.id));

      // Hapus item lokal yang TIDAK ada di cloud (sudah di-hard-delete di device lain)
      // TAPI jangan hapus item yang baru saja dibuat lokal (belum di-push — kasih grace 60 detik)
      const beforeItemsLen = localItems.length;
      const filteredItems = localItems.filter(i => {
        if (cloudLiveIds.has(i.id)) return true;
        // v3.19.8 FIX: Jangan hapus isGroup items (folders) yang belum sync ke cloud.
        //   Folder items dibuat lokal tapi mungkin belum ter-push ke Supabase.
        //   User report: "ada prompt dan folder yang hilang setelah pwa diperbaiki"
        if (i.source?.isGroup) return true;
        // Grace period: item lokal yang dibuat <60 detik lalu, kemungkinan belum synced
        const createdAt = new Date(i.createdAt || 0).getTime();
        if (now - createdAt < 60000) return true;
        // Item lokal yang tidak ada di cloud + sudah lama = hapus dari lokal
        return false;
      });
      if (filteredItems.length !== beforeItemsLen) {
        stats.itemsDeleted += (beforeItemsLen - filteredItems.length);
      }

      // Merge cloud items ke lokal (last-write-wins)
      for (const row of itemsRes.data) {
        try {
          if (row.type === 'bundle') {
            // v3.13.7: Cek delete registry — jangan re-add bundle yang sudah dihapus
            // di device ini. Sebelumnya bundle branch tidak ada check ini (items branch
            // ada), menyebabkan bundle yang di-hard-delete di cloud tapi masih ada di
            // device lain (yang belum sync) bisa re-appear via pull dari device lain.
            const reg = await _getDeleteRegistry();
            if (reg.items[row.id]) {
              console.log('[RecallFox/Supabase] pullV33: skip bundle in delete registry:', row.id);
              continue;
            }
            const bundle = _parseBundleRow(row);
            const idx = filteredItems.findIndex(b => b.id === bundle.id);
            const localBundlesArr = vault.bundles || [];
            const bIdx = localBundlesArr.findIndex(b => b.id === bundle.id);
            if (bIdx < 0) {
              localBundlesArr.push(bundle);
              stats.itemsAdded++;
            } else if (new Date(row.updated_at) > new Date(localBundlesArr[bIdx].updatedAt || 0)) {
              localBundlesArr[bIdx] = bundle;
              stats.itemsUpdated++;
            }
            vault.bundles = localBundlesArr;
          } else {
            // v3.20.0 FIX BUG sync hapus: Cek delete registry SEBELUM re-add item.
            // Root cause: user hapus item di device A (hard-delete cloud). Device B
            // yang belum sync masih punya item di vault.items lokal. Saat device B
            // pushToSupabase() → item di-INSERT ulang ke cloud → device A pull →
            // item muncul kembali. Loop terus menerus.
            // Fix: kalau item ada di delete registry, SKIP re-add (sudah dihapus).
            const reg = await _getDeleteRegistry();
            if (reg.items[row.id]) {
              console.log('[RecallFox/Supabase] pullV33: skip item in delete registry:', row.id);
              // Pastikan juga dihapus dari lokal (kalau masih ada)
              const idxInFiltered = filteredItems.findIndex(i => i.id === row.id);
              if (idxInFiltered >= 0) {
                filteredItems.splice(idxInFiltered, 1);
                stats.itemsDeleted++;
              }
              continue;
            }
            const item = _parseVaultItemRow(row);
            const idx = filteredItems.findIndex(i => i.id === item.id);
            if (idx < 0) {
              filteredItems.push(item);
              stats.itemsAdded++;
            } else if (new Date(row.updated_at) > new Date(filteredItems[idx].updatedAt || 0)) {
              filteredItems[idx] = item;
              stats.itemsUpdated++;
            }
          }
        } catch (e) {
          stats.errors.push({ id: row.id, error: e.message });
        }
      }
      vault.items = filteredItems;
      await saveVault(vault);
    }

    // === Pull notes ===
    const notesRes = await selectRows(NOTES_TABLE, {
      select: '*',
      filter: `user_id=eq.${userId}&deleted_at=is.null`,
      order: 'updated_at.desc'
    });
    if (notesRes.ok && notesRes.data) {
      const localNotes = await getNotes();
      const cloudNoteIds = new Set(notesRes.data.map(r => r.id));

      const filteredNotes = localNotes.filter(n => {
        if (cloudNoteIds.has(n.id)) return true;
        const createdAt = new Date(n.createdAt || 0).getTime();
        if (now - createdAt < 60000) return true;
        return false;
      });
      if (filteredNotes.length !== localNotes.length) {
        stats.notesDeleted += (localNotes.length - filteredNotes.length);
      }

      for (const row of notesRes.data) {
        try {
          const note = _parseNoteRow(row);
          const idx = filteredNotes.findIndex(n => n.id === note.id);
          if (idx < 0) {
            filteredNotes.push(note);
            stats.notesAdded++;
          } else if (new Date(row.updated_at) > new Date(filteredNotes[idx].updatedAt || 0)) {
            filteredNotes[idx] = note;
            stats.notesUpdated++;
          }
        } catch (e) {
          stats.errors.push({ id: row.id, error: e.message });
        }
      }
      await saveNotes(filteredNotes);
    }

    await _logSync('pull_v33', 'download', stats, Date.now() - startTime);
    await _setLastSync('pull', stats);

    return { ok: true, stats };
  } catch (e) {
    return { ok: false, error: e.message, stats };
  }
}
