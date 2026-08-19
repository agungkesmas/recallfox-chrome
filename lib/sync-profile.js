// lib/sync-profile.js — Multi-PC bidirectional sync via Apps Script
// RecallFox v3.11.7 — Multi-PC Sync + Multi-Profile support
//
// Konsep:
//   - "Sync Profile" = kombinasi (name + Apps Script URL + Token + Device ID)
//   - Setiap profile maps ke 1 spreadsheet Google (via Apps Script Web App)
//   - Multiple devices bisa share 1 profile → multi-PC sync (kantor + rumah)
//   - User berbeda (istri/teman) = deploy Apps Script sendiri = profile sendiri
//
// Sync flow:
//   - PUSH: kirim full state (vault + notes + settings + habits + customizations)
//     sebagai JSON blob ke sheet "SyncState" di spreadsheet
//   - PULL: GET latest state dari spreadsheet → merge ke local (last-write-wins)
//   - AUTO-SYNC: debounced 30s setelah vault berubah (opsional)
//
// Security:
//   - Sensitive fields (API keys, tokens, syncProfiles itu sendiri) TIDAK di-sync
//   - Token bearer dipakai untuk auth ke Apps Script
//
// Conflict resolution:
//   - Vault items & notes: merge by id, latest updatedAt wins
//   - Settings: take remote (whole object) — kecuali sensitive fields
//   - Habits: merge by date key
//   - Customizations: take remote as-is

import { getVault, saveVault, saveSettings, getNotes, saveNotes } from './storage.js';

const SYNC_PROFILE_KEY = 'recallfox_sync_profiles';
const DEVICE_ID_KEY = 'recallfox_device_id';

// ===== Device ID (unique per browser install) =====

export async function getDeviceId() {
  const data = await browser.storage.local.get(DEVICE_ID_KEY);
  if (data[DEVICE_ID_KEY]) return data[DEVICE_ID_KEY];
  const id = 'dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  await browser.storage.local.set({ [DEVICE_ID_KEY]: id });
  return id;
}

export async function getDeviceName() {
  const platform = (typeof navigator !== 'undefined' && navigator.platform) || 'Unknown';
  // Detect OS
  let os = 'Unknown';
  if (/Win/i.test(platform)) os = 'Windows';
  else if (/Mac/i.test(platform)) os = 'macOS';
  else if (/Linux/i.test(platform)) os = 'Linux';
  else if (/Android/i.test(navigator.userAgent || '')) os = 'Android';
  return os + '-' + (await getDeviceId()).slice(-6);
}

// ===== Profile management =====

export async function getSyncProfiles() {
  const data = await browser.storage.local.get(SYNC_PROFILE_KEY);
  return data[SYNC_PROFILE_KEY] || { profiles: [], activeProfileId: null };
}

export async function saveSyncProfiles(profilesData) {
  await browser.storage.local.set({ [SYNC_PROFILE_KEY]: profilesData });
}

export async function addSyncProfile({ name, url, token }) {
  if (!name || !url || !token) throw new Error('name, url, token required');
  const data = await getSyncProfiles();
  const id = 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  const deviceId = await getDeviceId();
  const profile = {
    id,
    name: name.trim(),
    url: url.trim(),
    token: token.trim(),
    deviceId,
    lastSyncAt: null,
    lastSyncDirection: null, // 'push' | 'pull' | 'both'
    createdAt: new Date().toISOString()
  };
  data.profiles.push(profile);
  // Auto-activate if first profile
  if (!data.activeProfileId) data.activeProfileId = id;
  await saveSyncProfiles(data);
  return profile;
}

export async function updateSyncProfile(id, patch) {
  const data = await getSyncProfiles();
  const idx = data.profiles.findIndex(p => p.id === id);
  if (idx < 0) throw new Error('profile not found');
  data.profiles[idx] = { ...data.profiles[idx], ...patch, updatedAt: new Date().toISOString() };
  await saveSyncProfiles(data);
  return data.profiles[idx];
}

export async function deleteSyncProfile(id) {
  const data = await getSyncProfiles();
  data.profiles = data.profiles.filter(p => p.id !== id);
  if (data.activeProfileId === id) {
    data.activeProfileId = data.profiles[0]?.id || null;
  }
  await saveSyncProfiles(data);
  return data;
}

export async function setActiveProfile(id) {
  const data = await getSyncProfiles();
  if (!data.profiles.find(p => p.id === id)) throw new Error('profile not found');
  data.activeProfileId = id;
  await saveSyncProfiles(data);
  return data;
}

export async function getActiveProfile() {
  const data = await getSyncProfiles();
  if (!data.activeProfileId) return null;
  return data.profiles.find(p => p.id === data.activeProfileId) || null;
}

// ===== Build sync payload (full state) =====

// Sensitive fields yang TIDAK boleh di-sync (security)
const SENSITIVE_SETTINGS_KEYS = [
  'appsScriptUrl', 'appsScriptToken',
  'assistantApiKey', 'assistantFallbackApiKey',
  'assistantBaseUrl', 'assistantFallbackBaseUrl'
];

export async function buildSyncPayload() {
  const vault = await getVault();
  const notes = await getNotes();
  const deviceId = await getDeviceId();
  const deviceName = await getDeviceName();

  // Settings: strip sensitive fields
  const settings = { ...(vault.settings || {}) };
  for (const key of SENSITIVE_SETTINGS_KEYS) {
    delete settings[key];
  }
  // Jangan sync syncProfiles itu sendiri (circular)
  delete settings.syncProfiles;
  delete settings.activeProfileId;

  // Collect extra data from storage.local
  let habits = null, assistantChat = null, volumeSettings = null;
  let pomodoroState = null, musicPlaylists = null, kidsafeCustom = null;
  try {
    const all = await browser.storage.local.get(null);
    habits = all.recallfox_habits || null;
    assistantChat = all.recallfox_assistant_chat || null;
    volumeSettings = all.recallfox_volume_settings || null;
    pomodoroState = all.recallfox_pomodoro || null;
    musicPlaylists = all.recallfox_music_playlists || null;
    kidsafeCustom = all.recallfox_kidsafe_sites || null;
  } catch (e) {
    console.warn('[RecallFox/Sync] Failed to collect extra data:', e.message);
  }

  return {
    version: 1,
    deviceId,
    deviceName,
    updatedAt: new Date().toISOString(),
    addonVersion: browser.runtime.getManifest().version,
    vault: {
      version: vault.version,
      items: vault.items || [],
      bundles: vault.bundles || [],
      toppings: vault.toppings || []
      // settings excluded from vault — sync separately
    },
    settings,
    notes,
    habits,
    assistantChat,
    volumeSettings,
    pomodoroState,
    musicPlaylists,
    kidsafeCustom
  };
}

// ===== PUSH: upload state to cloud =====

export async function pushStateToCloud(profile) {
  if (!profile || !profile.url || !profile.token) {
    return { ok: false, error: 'Profile tidak valid (URL/token kosong)' };
  }

  const payload = await buildSyncPayload();
  const body = JSON.stringify({
    action: 'sync_state',
    token: profile.token,
    profile: profile.name,
    deviceId: payload.deviceId,
    deviceName: payload.deviceName,
    payload
  });

  console.log('[RecallFox/Sync] Pushing state to cloud, profile:', profile.name, 'payload size:', (body.length / 1024).toFixed(1), 'KB');

  // v3.11.19 (Issue fix): Tambah token di query string SEBAGAI FALLBACK.
  // Apps Script Web App sering strip Authorization header dari browser fetch()
  // karena CORS restriction. Token juga sudah ada di body JSON, tapi untuk safety
  // tambah di query string juga.
  const syncUrl = profile.url + (profile.url.includes('?') ? '&' : '?') + 'action=sync_state&alt=json&token=' + encodeURIComponent(profile.token);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  let res;
  try {
    res = await fetch(syncUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=utf-8',
        'Authorization': 'Bearer ' + profile.token
      },
      body,
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timeoutId);
    return { ok: false, error: e.name === 'AbortError' ? 'Timeout (60s)' : e.message };
  }
  clearTimeout(timeoutId);

  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try {
      const errText = await res.text();
      if (errText) msg += ': ' + errText.slice(0, 200);
    } catch (e) {}
    return { ok: false, error: msg };
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    try {
      const txt = await res.text();
      data = txt ? JSON.parse(txt) : {};
    } catch (e2) {
      return { ok: false, error: 'Response tidak valid: ' + e2.message };
    }
  }

  if (!data || data.ok !== true) {
    return { ok: false, error: data?.error || 'Apps Script tidak return {ok:true}' };
  }

  // Update profile lastSyncAt
  await updateSyncProfile(profile.id, {
    lastSyncAt: new Date().toISOString(),
    lastSyncDirection: 'push',
    remoteUpdatedAt: data.updatedAt
  });

  return {
    ok: true,
    remoteUpdatedAt: data.updatedAt,
    itemsCount: payload.vault.items.length,
    notesCount: payload.notes.length
  };
}

// ===== PULL: download state from cloud + merge =====

export async function pullStateFromCloud(profile) {
  if (!profile || !profile.url || !profile.token) {
    return { ok: false, error: 'Profile tidak valid (URL/token kosong)' };
  }

  // v3.11.19 (Issue fix): Tambah token di query string SEBAGAI FALLBACK.
  // Apps Script Web App sering strip Authorization header dari browser fetch().
  const pullUrl = profile.url + (profile.url.includes('?') ? '&' : '?') + 'action=get_state&profile=' + encodeURIComponent(profile.name) + '&alt=json&token=' + encodeURIComponent(profile.token);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  let res;
  try {
    res = await fetch(pullUrl, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + profile.token }
    });
  } catch (e) {
    clearTimeout(timeoutId);
    return { ok: false, error: e.name === 'AbortError' ? 'Timeout (30s)' : e.message };
  }
  clearTimeout(timeoutId);

  if (!res.ok) {
    return { ok: false, error: 'HTTP ' + res.status };
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    return { ok: false, error: 'Response tidak valid: ' + e.message };
  }

  if (!data || data.ok !== true) {
    return { ok: false, error: data?.error || 'Tidak ada state di cloud' };
  }

  if (!data.payload) {
    return { ok: false, error: 'State cloud kosong (belum pernah push)' };
  }

  // Merge ke local
  const result = await mergeRemoteState(data.payload);

  // Update profile lastSyncAt
  await updateSyncProfile(profile.id, {
    lastSyncAt: new Date().toISOString(),
    lastSyncDirection: 'pull',
    remoteUpdatedAt: data.payload.updatedAt
  });

  return {
    ok: true,
    remoteUpdatedAt: data.payload.updatedAt,
    remoteDeviceName: data.payload.deviceName,
    ...result
  };
}

// ===== Merge remote state ke local (last-write-wins per item) =====

async function mergeRemoteState(remoteState) {
  const localVault = await getVault();
  let added = 0, updated = 0, notesAdded = 0, notesUpdated = 0;

  // === Merge vault items (by id, latest updatedAt wins) ===
  if (remoteState.vault && Array.isArray(remoteState.vault.items)) {
    const itemMap = new Map();
    for (const it of localVault.items) itemMap.set(it.id, it);
    for (const it of remoteState.vault.items) {
      const existing = itemMap.get(it.id);
      if (!existing) {
        itemMap.set(it.id, it);
        added++;
      } else if (new Date(it.updatedAt || 0) > new Date(existing.updatedAt || 0)) {
        itemMap.set(it.id, it);
        updated++;
      }
    }
    localVault.items = [...itemMap.values()];
  }

  // === Merge bundles (by id, latest wins) ===
  if (remoteState.vault && Array.isArray(remoteState.vault.bundles)) {
    const bundleMap = new Map();
    for (const b of localVault.bundles) bundleMap.set(b.id, b);
    for (const b of remoteState.vault.bundles) {
      const existing = bundleMap.get(b.id);
      if (!existing || new Date(b.updatedAt || 0) > new Date(existing.updatedAt || 0)) {
        bundleMap.set(b.id, b);
      }
    }
    localVault.bundles = [...bundleMap.values()];
  }

  // === Merge toppings (by id, latest wins) ===
  if (remoteState.vault && Array.isArray(remoteState.vault.toppings)) {
    const toppingMap = new Map();
    for (const t of localVault.toppings) toppingMap.set(t.id, t);
    for (const t of remoteState.vault.toppings) {
      const existing = toppingMap.get(t.id);
      if (!existing || new Date(t.updatedAt || 0) > new Date(existing.updatedAt || 0)) {
        toppingMap.set(t.id, t);
      }
    }
    localVault.toppings = [...toppingMap.values()];
  }

  // === Settings: take remote (EXCEPT sensitive fields — keep local) ===
  if (remoteState.settings && typeof remoteState.settings === 'object') {
    const localSettings = localVault.settings || {};
    const mergedSettings = { ...localSettings, ...remoteState.settings };
    // Restore sensitive fields dari local (jangan overwrite dengan remote)
    // Note: remoteState.settings sudah di-strip sensitive fields saat push,
    // jadi merge ini aman — sensitive fields tetap dari local.
    localVault.settings = mergedSettings;
  }

  // Save vault
  await browser.storage.local.set({ recallfox_vault: localVault });

  // === Merge notes (by id, latest updatedAt wins) ===
  if (Array.isArray(remoteState.notes)) {
    const localNotes = await getNotes();
    const noteMap = new Map();
    for (const n of localNotes) noteMap.set(n.id, n);
    for (const n of remoteState.notes) {
      const existing = noteMap.get(n.id);
      if (!existing) {
        noteMap.set(n.id, n);
        notesAdded++;
      } else if (new Date(n.updatedAt || 0) > new Date(existing.updatedAt || 0)) {
        noteMap.set(n.id, n);
        notesUpdated++;
      }
    }
    await saveNotes([...noteMap.values()]);
  }

  // === Restore extra data ===
  if (remoteState.habits) {
    await browser.storage.local.set({ recallfox_habits: remoteState.habits });
  }
  if (remoteState.assistantChat) {
    await browser.storage.local.set({ recallfox_assistant_chat: remoteState.assistantChat });
  }
  if (remoteState.volumeSettings) {
    await browser.storage.local.set({ recallfox_volume_settings: remoteState.volumeSettings });
  }
  if (remoteState.pomodoroState) {
    await browser.storage.local.set({ recallfox_pomodoro: remoteState.pomodoroState });
  }
  if (remoteState.musicPlaylists) {
    await browser.storage.local.set({ recallfox_music_playlists: remoteState.musicPlaylists });
  }
  if (remoteState.kidsafeCustom) {
    await browser.storage.local.set({ recallfox_kidsafe_sites: remoteState.kidsafeCustom });
  }

  return {
    itemsAdded: added,
    itemsUpdated: updated,
    notesAdded,
    notesUpdated
  };
}

// ===== Test connection (ping) =====

export async function testProfileConnection(profile) {
  if (!profile || !profile.url) return { ok: false, error: 'URL kosong' };
  const pingUrl = profile.url + (profile.url.includes('?') ? '&' : '?') + 'action=ping&alt=json';
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(pingUrl, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + (profile.token || '') }
    });
    clearTimeout(timeoutId);
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const data = await res.json().catch(() => ({}));
    if (data.ok !== true) {
      return { ok: false, error: data.error || 'Apps Script tidak return {ok:true}' };
    }
    return {
      ok: true,
      version: data.version || 'unknown',
      spreadsheetUrl: data.spreadsheetUrl || ''
    };
  } catch (e) {
    clearTimeout(timeoutId);
    return { ok: false, error: e.name === 'AbortError' ? 'Timeout (15s)' : e.message };
  }
}

// ===== Full sync (push + pull in sequence) =====

export async function fullSync(profile) {
  // Push dulu (upload local changes), lalu pull (download remote changes + merge)
  const pushResult = await pushStateToCloud(profile);
  if (!pushResult.ok) return pushResult;
  const pullResult = await pullStateFromCloud(profile);
  if (!pullResult.ok) {
    return { ok: true, pushOk: true, pullOk: false, pullError: pullResult.error, ...pushResult };
  }
  // Update direction to 'both'
  await updateSyncProfile(profile.id, {
    lastSyncAt: new Date().toISOString(),
    lastSyncDirection: 'both'
  });
  return {
    ok: true,
    pushOk: true,
    pullOk: true,
    ...pushResult,
    ...pullResult
  };
}

// ===== Auto-sync scheduler (debounced) =====

let autoSyncTimer = null;
const AUTO_SYNC_DEBOUNCE_MS = 30000;

export function scheduleAutoSync() {
  if (autoSyncTimer) clearTimeout(autoSyncTimer);
  autoSyncTimer = setTimeout(async () => {
    autoSyncTimer = null;
    try {
      const profile = await getActiveProfile();
      if (!profile) return;
      // Check if auto-sync enabled
      const vault = await getVault();
      if (!vault.settings?.syncAutoEnabled) return;
      console.log('[RecallFox/Sync] Auto-sync triggered (debounced 30s), profile:', profile.name);
      const result = await fullSync(profile);
      if (!result.ok) {
        console.warn('[RecallFox/Sync] Auto-sync failed:', result.error);
      } else {
        console.log('[RecallFox/Sync] Auto-sync OK');
      }
    } catch (e) {
      console.warn('[RecallFox/Sync] Auto-sync exception:', e.message);
    }
  }, AUTO_SYNC_DEBOUNCE_MS);
}

// ===== Get sync status (untuk UI display) =====

export async function getSyncStatus() {
  const data = await getSyncProfiles();
  const active = data.profiles.find(p => p.id === data.activeProfileId) || null;
  return {
    profilesCount: data.profiles.length,
    activeProfile: active,
    hasActive: !!active
  };
}
