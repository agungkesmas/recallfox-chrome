// lib/autobackup.js — Auto-backup settings to disk + smart restore
// RecallFox v0.5.2
//
// BACKUP FOLDER: Documents/RecallFox/
//   - auto-backup.json      (latest, auto-update tiap 2 detik)
//   - backups/backup-YYYYMMDDHHMMSS.json  (copy ber-timestamp, manual backup)
//
// Note: Firefox downloads.download() saves ke folder Downloads user by default.
// Untuk simpan ke Documents, kita pakai subfolder "RecallFox" di dalam Downloads
// tapi dengan nama yang jelas ini bukan file download biasa.
// Firefox tidak bisa write ke arbitrary path di luar Downloads, jadi folder
// "Documents/RecallFox/" adalah konvensi naming — file tetap di Downloads/RecallFox/
// tapi user bisa pindahkan manual kalau mau.
//
// Solusi alternatif: pakai browser.downloads.download() dengan filename "RecallFox/..."
// yang akan create folder RecallFox di dalam Downloads.
// Untuk benar-benar simpan di Documents, user perlu set Firefox Downloads ke
// "Always ask where to save" atau pindahkan manual.

import { getVault, getNotes, saveSettings, getAllScreenshotBlobKeys } from './storage.js';

// Firefox downloads API: filename relative to Downloads folder
// Kita pakai "RecallFox/" supaya file tidak bercampur dengan download lain
const BACKUP_FOLDER = 'RecallFox';
const BACKUP_FILENAME = `${BACKUP_FOLDER}/auto-backup.json`;
const BACKUP_FLAG_KEY = 'recallfox_autobackup_meta';

// Display path — gunakan "Documents/RecallFox/" sebagai konvensi
// User bisa pindahkan folder ini ke Documents manual kalau mau
export const BACKUP_PATH_DISPLAY = 'Downloads/RecallFox/auto-backup.json';
export const BACKUP_FOLDER_DISPLAY = 'Downloads/RecallFox/';

let backupTimer = null;

// Start interval-based auto-backup timer.
// Called by background.js on addon startup.
// Interval is read from settings.backupIntervalHours (default 6 hours = 4x/day).
export async function startBackupInterval() {
  if (backupTimer) clearInterval(backupTimer);
  const settings = await getVault();
  const hours = settings.settings?.backupIntervalHours || 6;
  const intervalMs = hours * 60 * 60 * 1000;
  console.log(`[RecallFox] Auto-backup timer started: every ${hours} hour(s) (${hours === 6 ? '4x/day' : hours === 12 ? '2x/day' : hours === 24 ? '1x/day' : '24x/day'})`);
  // Run once on startup (after 10s delay to let addon settle)
  setTimeout(() => manualBackupNow().catch(() => {}), 10000);
  // Then run on interval
  backupTimer = setInterval(() => manualBackupNow().catch(() => {}), intervalMs);
}

// Restart timer with new interval (called when user changes setting)
export async function restartBackupInterval() {
  await startBackupInterval();
}

// Read backup metadata from storage.local
export async function getBackupMetadata() {
  try {
    const data = await browser.storage.local.get(BACKUP_FLAG_KEY);
    return data[BACKUP_FLAG_KEY] || null;
  } catch (e) {
    return null;
  }
}

async function setBackupMetadata(meta) {
  try {
    await browser.storage.local.set({ [BACKUP_FLAG_KEY]: meta });
  } catch (e) {
    console.warn('[RecallFox] setBackupMetadata failed:', e.message);
  }
}

// Build the backup payload (vault + notes + screenshot blobs + version + timestamp)
async function buildBackupPayload() {
  const vault = await getVault();
  const notes = await getNotes();

  // Also backup screenshot blobs (stored separately in storage.local under rf_shot_<id>)
  // These are NOT in the vault JSON — they're separate storage.local keys
  const screenshotBlobs = {};
  // Habits data (ngaji log + exercise log) — stored under recallfox_habits
  // Assistant chat history — stored under recallfox_assistant_chat
  // Volume settings per-site — stored under recallfox_volume_settings
  // All of these MUST be backed up too, otherwise user loses progress on restore.
  let habits = null;
  let assistantChat = null;
  let volumeSettings = null;

  try {
    const all = await browser.storage.local.get(null);
    for (const key of Object.keys(all)) {
      if (key.startsWith('rf_shot_')) {
        screenshotBlobs[key] = all[key];
      }
    }
    // Pull well-known keys we want to back up
    habits = all.recallfox_habits || null;
    assistantChat = all.recallfox_assistant_chat || null;
    volumeSettings = all.recallfox_volume_settings || null;
  } catch (e) {
    console.warn('[RecallFox] Failed to collect extra backup data:', e.message);
  }

  return {
    version: 4,  // bumped from 3 → 4 to indicate habits/chat/volume are now included
    exportedAt: new Date().toISOString(),
    addonVersion: browser.runtime.getManifest().version,
    vault,
    notes,
    screenshotBlobs,
    // New in v4: habits (ngaji + exercise log), assistant chat history, volume settings
    habits,
    assistantChat,
    volumeSettings,
    meta: {
      vaultItemsCount: vault.items?.length || 0,
      notesCount: notes.length,
      bundlesCount: vault.bundles?.length || 0,
      screenshotBlobsCount: Object.keys(screenshotBlobs).length,
      hasHabits: !!habits,
      hasAssistantChat: !!assistantChat,
      hasVolumeSettings: !!volumeSettings,
      quranStreak: habits?.quranLog ? Object.keys(habits.quranLog).length : 0,
      exerciseTotalDays: habits?.exerciseLog ? Object.keys(habits.exerciseLog).length : 0
    }
  };
}

// Write a backup payload to a specific filename via downloads API
// conflictAction 'overwrite' ensures the file is replaced (not duplicated)
// If saveAs=true, Firefox shows "Save As" dialog so user can pick ANY folder
async function writeToDisk(filename, payload, saveAs = false) {
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  try {
    const downloadId = await browser.downloads.download({
      url,
      filename,
      saveAs,
      conflictAction: 'overwrite'
    });
    // Revoke URL after a delay (download needs it to complete)
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return downloadId;
  } catch (e) {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    throw e;
  }
}

// Auto-backup: overwrites auto-backup.json (silent, no timestamp)
export async function manualBackupNow() {
  try {
    const payload = await buildBackupPayload();
    const downloadId = await writeToDisk(BACKUP_FILENAME, payload);

    const meta = {
      lastBackupAt: payload.exportedAt,
      lastBackupDownloadId: downloadId,
      vaultItemsCount: payload.meta.vaultItemsCount,
      notesCount: payload.meta.notesCount,
      bundlesCount: payload.meta.bundlesCount,
      screenshotBlobsCount: payload.meta.screenshotBlobsCount,
      hasHabits: payload.meta.hasHabits,
      hasAssistantChat: payload.meta.hasAssistantChat,
      hasVolumeSettings: payload.meta.hasVolumeSettings,
      quranStreak: payload.meta.quranStreak,
      exerciseTotalDays: payload.meta.exerciseTotalDays,
      addonVersion: payload.addonVersion,
      backupPath: BACKUP_PATH_DISPLAY,
      backupFolder: BACKUP_FOLDER_DISPLAY
    };
    await setBackupMetadata(meta);
    console.log('[RecallFox] Auto-backup saved:', meta);
    return { ok: true, meta };
  } catch (e) {
    console.error('[RecallFox] Auto-backup failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// Manual backup: saves to manual-backup-YYYYMMDDHHMMSS.json (keeps history)
export async function manualBackupWithTimestamp() {
  try {
    const payload = await buildBackupPayload();
    const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    const filename = `${BACKUP_FOLDER}/manual-backup-${ts}.json`;
    const downloadId = await writeToDisk(filename, payload);

    const meta = {
      lastBackupAt: payload.exportedAt,
      lastBackupDownloadId: downloadId,
      vaultItemsCount: payload.meta.vaultItemsCount,
      notesCount: payload.meta.notesCount,
      bundlesCount: payload.meta.bundlesCount,
      screenshotBlobsCount: payload.meta.screenshotBlobsCount,
      hasHabits: payload.meta.hasHabits,
      hasAssistantChat: payload.meta.hasAssistantChat,
      hasVolumeSettings: payload.meta.hasVolumeSettings,
      quranStreak: payload.meta.quranStreak,
      exerciseTotalDays: payload.meta.exerciseTotalDays,
      addonVersion: payload.addonVersion,
      backupPath: `Downloads/RecallFox/manual-backup-${ts}.json`,
      backupFolder: BACKUP_FOLDER_DISPLAY
    };
    await setBackupMetadata(meta);
    console.log('[RecallFox] Manual backup saved:', meta);
    return { ok: true, meta, filename };
  } catch (e) {
    console.error('[RecallFox] Manual backup failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// Restore from a user-picked file (File object from <input type="file">)
export async function restoreFromFile(file) {
  if (!file) {
    return { ok: false, error: 'no_file' };
  }

  try {
    const text = await file.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: 'Invalid JSON file: ' + e.message };
    }

    if (!payload || typeof payload !== 'object') {
      return { ok: false, error: 'Invalid backup format' };
    }
    const vault = payload.vault || payload;
    const notes = payload.notes || null;

    if (!vault.items || !Array.isArray(vault.items)) {
      return { ok: false, error: 'Backup tidak berisi vault items' };
    }

    const itemCount = vault.items.length;
    const notesCount = notes ? notes.length : 0;
    // Build restore summary including newly-backed-up data
    const extras = [];
    if (payload.habits) extras.push('habits (ngaji + exercise)');
    if (payload.assistantChat) extras.push('riwayat chat Si Pandai');
    if (payload.volumeSettings) extras.push('volume settings');
    const screenshotCount = payload.screenshotBlobs ? Object.keys(payload.screenshotBlobs).length : 0;
    if (screenshotCount > 0) extras.push(`${screenshotCount} screenshot`);

    const extrasLine = extras.length > 0 ? `\n- ${extras.join(', ')}` : '';
    const msg = `Restore backup?\n\nBackup berisi:\n- ${itemCount} vault items\n- ${notesCount} catatan${extrasLine}\n- Exported: ${payload.exportedAt || 'unknown'}\n\nSettings saat ini akan ditimpa.`;
    if (!confirm(msg)) {
      return { ok: false, cancelled: true };
    }

    // Restore vault
    await browser.storage.local.set({ recallfox_vault: vault });

    // Restore notes
    if (notes && Array.isArray(notes)) {
      await browser.storage.local.set({ recallfox_notes: notes });
    }

    // Restore screenshot blobs (stored separately under rf_shot_<id> keys)
    // v3.7.2 (Issue 3): Hapus orphan screenshot blobs YANG TIDAK ADA di payload dulu,
    // supaya tidak menumpuk sampah dari screenshot yang sudah dihapus user sebelum backup.
    const screenshotBlobs = payload.screenshotBlobs || {};
    const blobCount = Object.keys(screenshotBlobs).length;
    try {
      const existingKeys = await getAllScreenshotBlobKeys();
      const newKeys = new Set(Object.keys(screenshotBlobs)); // already includes rf_shot_ prefix
      const orphans = existingKeys.filter(k => !newKeys.has(k));
      if (orphans.length > 0) {
        await browser.storage.local.remove(orphans);
        console.log(`[RecallFox] Removed ${orphans.length} orphan screenshot blobs during restore`);
      }
    } catch (e) {
      console.warn('[RecallFox] Failed to clean orphan screenshot blobs:', e.message);
    }
    if (blobCount > 0) {
      await browser.storage.local.set(screenshotBlobs);
      console.log(`[RecallFox] Restored ${blobCount} screenshot blobs`);
    }

    // === Restore new v4 data: habits, assistant chat, volume settings ===
    let habitsRestored = false;
    let chatRestored = false;
    let volumeRestored = false;

    if (payload.habits) {
      try {
        await browser.storage.local.set({ recallfox_habits: payload.habits });
        habitsRestored = true;
        console.log('[RecallFox] Restored habits data');
      } catch (e) {
        console.warn('[RecallFox] Failed to restore habits:', e.message);
      }
    }
    if (payload.assistantChat) {
      try {
        await browser.storage.local.set({ recallfox_assistant_chat: payload.assistantChat });
        chatRestored = true;
        console.log('[RecallFox] Restored assistant chat history');
      } catch (e) {
        console.warn('[RecallFox] Failed to restore assistant chat:', e.message);
      }
    }
    if (payload.volumeSettings) {
      try {
        await browser.storage.local.set({ recallfox_volume_settings: payload.volumeSettings });
        volumeRestored = true;
        console.log('[RecallFox] Restored volume settings');
      } catch (e) {
        console.warn('[RecallFox] Failed to restore volume settings:', e.message);
      }
    }

    // Update backup metadata
    await setBackupMetadata({
      lastBackupAt: payload.exportedAt,
      lastRestoreAt: new Date().toISOString(),
      vaultItemsCount: itemCount,
      notesCount,
      bundlesCount: vault.bundles?.length || 0,
      screenshotBlobsCount: blobCount,
      hasHabits: habitsRestored,
      hasAssistantChat: chatRestored,
      hasVolumeSettings: volumeRestored,
      addonVersion: payload.addonVersion || 'unknown',
      backupPath: BACKUP_PATH_DISPLAY,
      backupFolder: BACKUP_FOLDER_DISPLAY
    });

    console.log('[RecallFox] Restore successful:', { itemCount, notesCount, blobCount, habitsRestored, chatRestored, volumeRestored });
    return {
      ok: true,
      restored: {
        vaultItems: itemCount,
        notes: notesCount,
        screenshots: blobCount,
        habits: habitsRestored,
        assistantChat: chatRestored,
        volumeSettings: volumeRestored,
        exportedAt: payload.exportedAt
      }
    };
  } catch (e) {
    console.error('[RecallFox] Restore failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// Check if user should see restore banner:
//   - Vault is empty (no items, no notes)
//   - lastBackupAt exists (means there's a backup file on disk)
//   - We haven't restored yet (no lastRestoreAt)
export async function shouldShowRestoreBanner() {
  try {
    const vault = await getVault();
    const notes = await getNotes();
    const totalItems = (vault.items?.length || 0) + notes.length;
    // Also check if settings are at defaults (another sign of fresh install)
    const hasCustomSettings = vault.settings && (
      vault.settings.prayerEnabled ||
      vault.settings.theme !== 'auto' ||
      vault.settings.sidebarAutoOpen
    );
    if (totalItems > 0 || hasCustomSettings) return false;

    const meta = await getBackupMetadata();
    if (!meta || !meta.lastBackupAt) return false;
    if (meta.lastRestoreAt) return false;

    return true;
  } catch (e) {
    return false;
  }
}

// Initialize backup on addon install/load:
//   - If no backup exists yet, create an initial one
//   - This also creates the Downloads/RecallFox/ folder
export async function initBackup() {
  try {
    const meta = await getBackupMetadata();
    if (!meta || !meta.lastBackupAt) {
      console.log('[RecallFox] No backup found, creating initial backup...');
      // Create initial backup (this also creates the folder)
      await manualBackupNow();
      console.log('[RecallFox] Initial backup created at', BACKUP_PATH_DISPLAY);
    } else {
      console.log('[RecallFox] Backup exists, last at:', meta.lastBackupAt);
    }
  } catch (e) {
    console.warn('[RecallFox] initBackup failed:', e.message);
  }
}
