// lib/storage.js — Wrapper storage.local + storage.sync dengan chunking
// RecallFox v0.3.0

const SYNC_CHUNK_SIZE = 90000; // 90KB per chunk (limit 100KB)
const SYNC_META_KEY = 'sync_meta';
const SYNC_CHUNK_PREFIX = 'sync_chunk_';
const LOCAL_KEY = 'recallfox_vault';
const NOTES_KEY = 'recallfox_notes';  // Catatan sementara (notepad)
const SHOT_PREFIX = 'rf_shot_'; // storage.local key prefix for screenshot blobs
const BYPASS_KEY = 'rf_cg_bypass'; // bypass URLs untuk Content Guardian

const DEFAULT_SETTINGS = {
  syncEnabled: false,
  // v3.7.2 (Issue 2): Default OFF — tombol mengambang mengganggu banyak user.
  // User bisa tetap mengaktifkan kapan saja via Settings → Tampilan.
  floatingButtonEnabled: false,
  overlayButtonEnabled: false,      // FireShot-style floating screenshot button on all http(s) pages
  injectMode: 'append', // 'append' | 'prepend' | 'replace'
  displayMode: 'popup', // 'popup' | 'sidebar'
  theme: 'auto', // 'auto' | 'light' | 'dark'
  locale: 'auto',
  // AI Assistant (primary)
  assistantProvider: 'groq',
  // ⚠️ SECURITY: Set your own Groq API key in Settings → AI Assistant.
  // Default empty — never ship a real key in source code.
  // Get one free at: https://console.groq.com/keys
  assistantApiKey: '',
  assistantModel: 'llama-3.3-70b-versatile',
  assistantBaseUrl: '', // for custom OpenAI-compatible endpoints
  // AI Assistant (fallback — used when primary fails)
  assistantFallbackEnabled: true,
  assistantFallbackProvider: 'gemini',
  assistantFallbackApiKey: '', // user needs to add Gemini API key (free tier)
  assistantFallbackModel: 'gemini-2.0-flash',
  assistantFallbackBaseUrl: '',
  // Screenshot (FireShot-style capture)
  screenshotFormat: 'png',         // 'png' | 'jpeg'
  screenshotJpegQuality: 90,        // 50..100 (only used when format=jpeg)
  screenshotDefaultMode: 'visible', // 'visible' | 'entire' | 'selection'
  screenshotMaxFullHeight: 16384,   // px safety cap for stitched full-page
  screenshotSyncFullImage: false,  // if true, full image bytes go into the synced vault (NOT recommended)
  // Clear Cache (clearcache-style browsingData cleaner)
  clearCacheDataTypes: ['cache'],          // array of: cache, cookies, history, indexedDB, localStorage, serviceWorkers, downloads, formData, passwords
  clearCacheTimePeriod: 'all',             // '15min' | '1hour' | '24hours' | '1week' | 'all'
  clearCacheCurrentTabOnly: false,         // clear only for active site (cookies/localStorage/etc)
  clearCacheReload: true,                  // reload active tab after clearing
  clearCacheNotify: true,                  // show browser notification after clearing
  // Prayer Times (Salah Time, Muhammadiyah method)
  prayerEnabled: true,                     // auto-enabled with Cirebon default
  prayerLatitude: -6.7167,                 // Cirebon default latitude
  prayerLongitude: 108.5667,               // Cirebon default longitude
  prayerLocation: 'Cirebon, Jawa Barat, Indonesia',
  prayerAsrSchool: 0,                      // 0 = Shafi (default for Muhammadiyah/Indonesia), 1 = Hanafi
  prayerTimeFormat: '24h',                 // '24h' | '12h'
  prayerLastFetch: null,                   // ISO-string of last successful fetch
  prayerCachedTimes: null,                 // cached PrayerTimes object (per-day)
  prayerReminderEnabled: true,             // show notification N minutes before next prayer
  prayerReminderMinutes: 10,               // minutes before prayer to notify (5/10/15/30)
  prayerLastReminderKey: null,             // tracking key to avoid duplicate reminders (e.g. "2026-07-05-Fajr")
  prayerShowSunnah: true,                  // show sunnah prayers section (Dhuha, Tahajud, Ishraq, Awwabin, Witir)
  prayerShowElapsed: true,                 // show "+Nm sejak {last prayer}" indicator
  prayerShowBadge: true,                   // show countdown badge on toolbar icon + update title
  // Quran / Ngaji tracker
  quranEnabled: true,                      // enable ngaji tracking
  quranTargetPages: 1,                     // target halaman per hari (1-10)
  quranReminderTime: '07:00',              // waktu notifikasi pengingat ngaji (HH:MM)
  quranTodayPages: 0,                      // halaman yang dibaca hari ini
  quranLastReadDate: null,                 // tanggal terakhir ngaji (YYYY-MM-DD)
  quranStreak: 0,                          // berapa hari berturut-turut ngaji
  quranLastReminderKey: null,              // tracking untuk notifikasi (date-based)
  quranDays: [0,1,2,3,4,5,6],             // v0.8.41: hari ngaji (0=Minggu, 1=Senin, ... 6=Sabtu). Default: semua hari
  // Exercise / Movement reminder
  exerciseEnabled: true,                   // enable movement reminder
  exerciseIntervalMinutes: 45,             // interval notifikasi (15/30/45/60/90 menit)
  exerciseLastReminderAt: null,            // timestamp reminder terakhir
  exerciseSnoozeUntil: null,               // timestamp snooze sampai kapan
  exerciseTodayCount: 0,                   // berapa kali sudah bergerak hari ini
  exerciseLastResetDate: null,             // tanggal terakhir reset counter
  exerciseDays: [1,3,5],                   // v0.8.41: hari treadmill (0=Minggu, 1=Senin, ... 6=Sabtu). Default: Senin/Rabu/Jumat
  exerciseReminderTime: '18:30',           // v0.8.42: waktu spesifik reminder treadmill (HH:MM). Kosong = pakai interval mode.
  exerciseLastReminderKey: null,           // v0.8.42: tracking untuk mode waktu spesifik (date-based)
  // v0.8.42: Element Blocker — hide elemen + block script per-domain
  elementBlockerEnabled: true,             // master switch
  elementBlockerRules: null,               // diisi oleh lib/elementblocker.js saat init (preset ninospositano, dll)
  // v0.8.44: Auto Tab Discard — otomatis discard tab inactive untuk hemat memory
  autoDiscardEnabled: true,                // master switch (default ON)
  autoDiscardInterval: 30,                 // menit idle sebelum discard (default 30 menit)
  autoDiscardExcludePinned: true,          // jangan discard tab yang di-pin
  autoDiscardExcludeActive: true,          // jangan discard tab yang sedang aktif
  autoDiscardExcludeMedia: true,           // jangan discard tab yang playing audio/video
  autoDiscardExcludeInput: true,           // jangan discard tab yang ada form input unsaved
  autoDiscardMinTabs: 1,                   // v0.9.1: default 1 (jangan block kalau cuma 1 tab)
  autoDiscardExcludedDomains: [],          // list domain yang di-exclude dari discard (e.g., ['youtube.com', 'gmail.com'])
  // Persistence
  sidebarAutoOpen: false,                  // auto-open sidebar on Firefox startup
  rememberLastTab: true,                   // restore last active tab (prompt/notes/prayer/etc) on popup/sidebar reopen
  lastActiveTab: 'all',                    // which tab was last active
  lastSidebarWidth: null,                  // user's preferred sidebar width (px) — restored on open
  showWelcomeOnFirstUse: true,             // show welcome modal once
  // Backup
  backupIntervalHours: 6,                  // auto-backup interval (1, 6, 12, 24 hours). Default 6h = 4x/day
  lastBackupAt: null,
  lastSyncAt: null,
  // ===== Content Guardian (v0.8.20 → 0.8.21) =====
  // Filter berita negatif Indonesia & arahkan ke konten positif Tiongkok
  contentGuardEnabled: true,                // master switch
  contentGuardBlockIdNews: true,            // block domain berita Indonesia
  contentGuardForceRedirect: false,         // v0.8.35: default OFF — redirect YouTube home bikin loop. User bisa enable manual.
  contentGuardFilterFeeds: true,            // filter feed YouTube/X (hide video/tweet negatif)
  contentGuardStrictMode: true,             // mode paksa: bypass butuh 2 klik
  contentGuardNotifyOnBlock: true,          // notifikasi saat redirect dilakukan
  contentGuardBlockYtChannels: true,        // block channel YouTube berita Indonesia (v0.8.21)
  contentGuardBlockXAccounts: true,         // block akun X berita Indonesia (v0.8.21)
  contentGuardDebugMode: false,             // mode debug: log ke console + alt+click badge untuk overlay (v0.8.22)
  contentGuardNuclearMode: true,            // nuclear mode: blokir SEMUA konten yang menyebut politisi/partai/lembaga politik Indonesia (v0.8.23)
  contentGuardBlockSearchQueries: false,    // v0.8.36: default OFF — redirect search bikin loop
  contentGuardScanDescription: true,        // v0.8.24: scan juga description video (preview)
  contentGuardShowFloating: false,          // v3.4: default OFF — panel Guardian pindah ke sidebar (bukan floating)
  contentGuardNegativeKeywords: null,       // diisi oleh lib/contentguard.js saat init
  contentGuardIdNewsDomains: null,          // diisi oleh lib/contentguard.js saat init
  contentGuardBlockedYtChannels: null,      // daftar channel YouTube yang diblokir (v0.8.21)
  contentGuardBlockedXAccounts: null,       // daftar akun X yang diblokir (v0.8.21)
  contentGuardUserBlocklist: [],            // dynamic blocklist user (klik kanan "Blokir Konten Ini")
  contentGuardBlockedSearchQueries: null,   // v0.8.24: daftar query search yang di-block
  contentGuardChinaSearches: null,          // daftar pencarian YouTube positif Tiongkok
  contentGuardChinaXAccounts: null,         // daftar akun X positif Tiongkok
  contentGuardChinaXSearches: null,         // daftar pencarian X positif Tiongkok
  // v3.7.2 (Issue 6): Mode ramah anak — 1 klik untuk amankan laptop saat dipinjam anak.
  contentGuardBlockShorts: false,           // Sembunyikan SEMUA YouTube Shorts (feed + /shorts/ URL)
  contentGuardYoutubeKidsOnly: false,       // Redirect semua youtube.com → youtubekids.com
  contentGuardKidModeArmUntil: 0            // epoch-ms hingga mode anak aktif (0 = permanen saat toggle on)
};

const DEFAULT_VAULT = {
  version: 1,
  items: [],
  bundles: [],
  toppings: [], // custom toppings (built-in ada di lib/toppings.js)
  settings: { ...DEFAULT_SETTINGS }
};

// ===== LOCAL STORAGE =====

export async function getVault() {
  const data = await browser.storage.local.get(LOCAL_KEY);
  const vault = data[LOCAL_KEY] || structuredClone(DEFAULT_VAULT);
  // ensure settings keys exist
  vault.settings = { ...DEFAULT_SETTINGS, ...(vault.settings || {}) };
  if (!vault.items) vault.items = [];
  if (!vault.bundles) vault.bundles = [];
  if (!vault.toppings) vault.toppings = [];
  return vault;
}

export async function saveVault(vault) {
  await browser.storage.local.set({ [LOCAL_KEY]: vault });
  // schedule sync (debounced in background.js)
  if (vault.settings.syncEnabled) {
    await browser.runtime.sendMessage({ type: 'TRIGGER_SYNC' }).catch(() => {});
  }
  // Auto-backup is now interval-based (every N hours), not on every save.
  // See background.js → startBackupTimer()
}

export async function getSettings() {
  const vault = await getVault();
  return vault.settings;
}

export async function saveSettings(settings) {
  const vault = await getVault();
  vault.settings = { ...vault.settings, ...settings };
  await saveVault(vault);
}

// ===== ITEMS =====

export function genId(prefix = 'p') {
  const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}_${rand}`;
}

export async function addItem(item) {
  const vault = await getVault();
  const type = item.type || 'prompt';
  const prefix =
    type === 'context' ? 'c'
    : type === 'snapshot' ? 's'
    : type === 'link' ? 'l'
    : type === 'screenshot' ? 'sh'
    : 'p';

  // For screenshots: full image goes to a separate storage key, NOT in vault JSON.
  // The vault only keeps the thumbnail + metadata.
  let screenshotBlob = null;
  if (type === 'screenshot') {
    screenshotBlob = item.screenshotDataUrl || null;
    delete item.screenshotDataUrl;
  }

  const newItem = {
    id: item.id || genId(prefix),
    type,
    title: item.title || item.body?.slice(0, 60) || 'Untitled',
    body: item.body || '',
    tags: item.tags || [],
    category: item.category || '',
    variables: item.variables || [],
    toppings: item.toppings || [], // array of topping IDs (built-in or custom)
    source: item.source || null,
    // link-specific fields (only for type='link')
    linkUrl: type === 'link' ? (item.linkUrl || item.body || '') : undefined,
    linkTitle: type === 'link' ? (item.linkTitle || item.title || '') : undefined,
    favorite: !!item.favorite,
    // v3.7.2 (Issue 1): archived flag — item yang diarsipkan tetap tersimpan,
    // tapi disembunyikan dari list default dan ditampilkan di chip "Arsip".
    archived: !!item.archived,
    useCount: 0,
    lastUsedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  // clean up undefined
  if (newItem.linkUrl === undefined) delete newItem.linkUrl;
  if (newItem.linkTitle === undefined) delete newItem.linkTitle;

  // screenshot-specific metadata (kept inline since it's tiny)
  if (type === 'screenshot') {
    newItem.screenshotMode = item.screenshotMode || 'visible';     // 'visible' | 'entire' | 'selection'
    newItem.screenshotWidth = item.screenshotWidth || 0;
    newItem.screenshotHeight = item.screenshotHeight || 0;
    newItem.screenshotFormat = item.screenshotFormat || 'png';
    newItem.thumbnailDataUrl = item.thumbnailDataUrl || '';        // small inline PNG for list view
    newItem.screenshotBytes = item.screenshotBytes || 0;           // size of full image, for display
    if (vault.settings.screenshotSyncFullImage && screenshotBlob) {
      newItem.screenshotDataUrl = screenshotBlob; // optionally sync full image (NOT recommended for big shots)
    }
  }

  vault.items.push(newItem);
  await saveVault(vault);

  // Store full image separately (always — even if also synced, for fast local access)
  if (type === 'screenshot' && screenshotBlob) {
    try {
      await browser.storage.local.set({ [`${SHOT_PREFIX}${newItem.id}`]: screenshotBlob });
    } catch (e) {
      console.warn('[RecallFox] Failed to store screenshot blob:', e);
    }
  }

  return newItem;
}

export async function updateItem(id, patch) {
  const vault = await getVault();
  const idx = vault.items.findIndex(i => i.id === id);
  if (idx < 0) return null;
  vault.items[idx] = {
    ...vault.items[idx],
    ...patch,
    updatedAt: new Date().toISOString()
  };
  await saveVault(vault);
  return vault.items[idx];
}

export async function deleteItem(id) {
  const vault = await getVault();
  const removed = vault.items.find(i => i.id === id);
  vault.items = vault.items.filter(i => i.id !== id);
  // also remove from bundles
  vault.bundles.forEach(b => {
    b.itemIds = (b.itemIds || []).filter(iid => iid !== id);
    b.injectOrder = (b.injectOrder || []).filter(iid => iid !== id);
  });
  await saveVault(vault);
  // If it was a screenshot, also delete its full-image blob from storage.local
  if (removed?.type === 'screenshot') {
    try {
      await browser.storage.local.remove(`${SHOT_PREFIX}${id}`);
    } catch (e) {
      console.warn('[RecallFox] Failed to remove screenshot blob:', e);
    }
  }
}

// ===== Screenshot blob helpers =====

// Get full-size data URL for a screenshot item (lazy-loaded from storage.local)
export async function getScreenshotBlob(id) {
  const key = `${SHOT_PREFIX}${id}`;
  const data = await browser.storage.local.get(key);
  return data[key] || null;
}

// Set / replace full-size data URL for a screenshot item
export async function setScreenshotBlob(id, dataUrl) {
  await browser.storage.local.set({ [`${SHOT_PREFIX}${id}`]: dataUrl });
}

// Get all screenshot blob keys (used for backup/restore)
export async function getAllScreenshotBlobKeys() {
  const all = await browser.storage.local.get(null);
  return Object.keys(all).filter(k => k.startsWith(SHOT_PREFIX));
}

// Export all screenshot blobs as { id: dataUrl } map
export async function exportAllScreenshotBlobs() {
  const all = await browser.storage.local.get(null);
  const out = {};
  for (const k of Object.keys(all)) {
    if (k.startsWith(SHOT_PREFIX)) {
      out[k.slice(SHOT_PREFIX.length)] = all[k];
    }
  }
  return out;
}

// Import screenshot blobs from { id: dataUrl } map
export async function importScreenshotBlobs(map) {
  if (!map || typeof map !== 'object') return;
  const obj = {};
  for (const id of Object.keys(map)) {
    obj[`${SHOT_PREFIX}${id}`] = map[id];
  }
  if (Object.keys(obj).length > 0) {
    await browser.storage.local.set(obj);
  }
}

export async function incrementUseCount(id) {
  const vault = await getVault();
  const idx = vault.items.findIndex(i => i.id === id);
  if (idx < 0) return;
  vault.items[idx].useCount = (vault.items[idx].useCount || 0) + 1;
  vault.items[idx].lastUsedAt = new Date().toISOString();
  await saveVault(vault);
}

// ===== BUNDLES =====

export async function addBundle(name, itemIds = []) {
  const vault = await getVault();
  const bundle = {
    id: genId('b'),
    name,
    itemIds,
    injectOrder: [...itemIds],
    createdAt: new Date().toISOString()
  };
  vault.bundles.push(bundle);
  await saveVault(vault);
  return bundle;
}

export async function deleteBundle(id) {
  const vault = await getVault();
  vault.bundles = vault.bundles.filter(b => b.id !== id);
  await saveVault(vault);
}

// v3.7.2 (Issue 1): Update bundle — patch {name?, itemIds?, injectOrder?, archived?, color?, note?}
// Memungkinkan reassign item ke bundle lain, edit nama, dsb. tanpa hapus-buat.
export async function updateBundle(id, patch) {
  const vault = await getVault();
  const idx = vault.bundles.findIndex(b => b.id === id);
  if (idx < 0) return null;
  vault.bundles[idx] = {
    ...vault.bundles[idx],
    ...patch,
    updatedAt: new Date().toISOString()
  };
  await saveVault(vault);
  return vault.bundles[idx];
}

// v3.7.2 (Issue 1): Tambah / lepas item dari bundle (reassign).
// action: 'add' | 'remove'
// Returns updated bundle or null.
export async function reassignToBundle(bundleId, itemId, action = 'add') {
  const vault = await getVault();
  const b = vault.bundles.find(x => x.id === bundleId);
  if (!b) return null;
  b.itemIds = Array.isArray(b.itemIds) ? b.itemIds : [];
  b.injectOrder = Array.isArray(b.injectOrder) ? b.injectOrder : [];
  if (action === 'add') {
    if (!b.itemIds.includes(itemId)) b.itemIds.push(itemId);
    if (!b.injectOrder.includes(itemId)) b.injectOrder.push(itemId);
  } else if (action === 'remove') {
    b.itemIds = b.itemIds.filter(x => x !== itemId);
    b.injectOrder = b.injectOrder.filter(x => x !== itemId);
  }
  b.updatedAt = new Date().toISOString();
  await saveVault(vault);
  return b;
}

// ===== SYNC (Firefox Sync, chunked) =====

async function hashString(str) {
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function pushToSync() {
  const vault = await getVault();
  if (!vault.settings.syncEnabled) return false;

  const json = JSON.stringify(vault);
  const hash = await hashString(json);

  // delete old chunks
  const all = await browser.storage.sync.get(null);
  const oldKeys = Object.keys(all).filter(k =>
    k === SYNC_META_KEY || k.startsWith(SYNC_CHUNK_PREFIX)
  );
  if (oldKeys.length) await browser.storage.sync.remove(oldKeys);

  // split into chunks
  const chunks = [];
  for (let i = 0; i < json.length; i += SYNC_CHUNK_SIZE) {
    chunks.push(json.slice(i, i + SYNC_CHUNK_SIZE));
  }

  const obj = {
    [SYNC_META_KEY]: {
      totalChunks: chunks.length,
      hash,
      updatedAt: new Date().toISOString(),
      version: 1
    }
  };
  chunks.forEach((c, i) => {
    obj[`${SYNC_CHUNK_PREFIX}${i}`] = c;
  });

  await browser.storage.sync.set(obj);

  // update lastSyncAt
  vault.settings.lastSyncAt = new Date().toISOString();
  await browser.storage.local.set({ [LOCAL_KEY]: vault });
  return true;
}

export async function pullFromSync() {
  const meta = (await browser.storage.sync.get(SYNC_META_KEY))[SYNC_META_KEY];
  if (!meta) return null;

  const chunkKeys = [];
  for (let i = 0; i < meta.totalChunks; i++) chunkKeys.push(`${SYNC_CHUNK_PREFIX}${i}`);
  const chunks = await browser.storage.sync.get(chunkKeys);

  let json = '';
  for (let i = 0; i < meta.totalChunks; i++) {
    json += chunks[`${SYNC_CHUNK_PREFIX}${i}`] || '';
  }

  const hash = await hashString(json);
  if (hash !== meta.hash) {
    console.warn('[RecallFox] Sync hash mismatch — possible corruption');
    return null;
  }

  return JSON.parse(json);
}

// Merge sync data into local (item-level by updatedAt, last-write-wins)
export async function mergeSyncIntoLocal() {
  const synced = await pullFromSync();
  if (!synced) return false;

  const local = await getVault();

  // merge items by id, latest updatedAt wins
  const itemMap = new Map();
  for (const it of local.items) itemMap.set(it.id, it);
  for (const it of (synced.items || [])) {
    const existing = itemMap.get(it.id);
    if (!existing || new Date(it.updatedAt || 0) > new Date(existing.updatedAt || 0)) {
      itemMap.set(it.id, it);
    }
  }
  local.items = [...itemMap.values()];

  // merge bundles by id (latest wins)
  const bundleMap = new Map();
  for (const b of local.bundles) bundleMap.set(b.id, b);
  for (const b of (synced.bundles || [])) bundleMap.set(b.id, b);
  local.bundles = [...bundleMap.values()];

  // settings: keep local for syncEnabled, take synced for others
  local.settings = {
    ...synced.settings,
    syncEnabled: local.settings.syncEnabled
  };

  await browser.storage.local.set({ [LOCAL_KEY]: local });
  return true;
}

// Listen to sync storage changes
export function onSyncChange(callback) {
  browser.storage.sync.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (SYNC_META_KEY in changes) {
      callback();
    }
  });
}

// ===== Custom Toppings CRUD =====
export async function addCustomTopping(topping) {
  const vault = await getVault();
  if (!vault.toppings) vault.toppings = [];
  const newTopping = {
    id: topping.id || genId('t'),
    name: topping.name || 'Untitled Topping',
    emoji: topping.emoji || '⚙️',
    description: topping.description || '',
    body: topping.body || '',
    builtIn: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  vault.toppings.push(newTopping);
  await saveVault(vault);
  return newTopping;
}

export async function updateCustomTopping(id, patch) {
  const vault = await getVault();
  if (!vault.toppings) vault.toppings = [];
  const idx = vault.toppings.findIndex(t => t.id === id);
  if (idx < 0) return null;
  vault.toppings[idx] = {
    ...vault.toppings[idx],
    ...patch,
    updatedAt: new Date().toISOString()
  };
  await saveVault(vault);
  return vault.toppings[idx];
}

export async function deleteCustomTopping(id) {
  const vault = await getVault();
  if (!vault.toppings) vault.toppings = [];
  vault.toppings = vault.toppings.filter(t => t.id !== id);
  // Also remove this topping ID from all items that reference it
  vault.items.forEach(item => {
    if (item.toppings) {
      item.toppings = item.toppings.filter(tid => tid !== id);
    }
  });
  await saveVault(vault);
}

// ===== AI Assistant chat history =====
const ASSISTANT_KEY = 'recallfox_assistant_chat';

export async function getAssistantChat() {
  const data = await browser.storage.local.get(ASSISTANT_KEY);
  return data[ASSISTANT_KEY] || { messages: [], updatedAt: null };
}

export async function saveAssistantChat(chat) {
  chat.updatedAt = new Date().toISOString();
  await browser.storage.local.set({ [ASSISTANT_KEY]: chat });
}

export async function clearAssistantChat() {
  await browser.storage.local.remove(ASSISTANT_KEY);
}

// ===== Notes (Catatan Sementara / Notepad) =====
// Stored separately from vault (so they don't bloat the synced vault object)
// Schema per note (v3.7.2 — title + group added per Issue 5):
//   {
//     id:        'n_<timestamp>_<rand>',
//     title:     string,         // opsional — judul singkat. Kosong = pakai preview body.
//     body:      string,         // plain text, multiline
//     color:     'default' | 'yellow' | 'green' | 'blue' | 'pink' | 'purple'
//                | 'orange' | 'red' | 'teal' | 'indigo' | 'slate' | 'rose',  // v3.7.2: 12 warna
//     group:     string,         // opsional — nama proyek/grup, mis. "Proyek A". Kosong = tanpa grup.
//     pinned:    boolean,
//     archived:  boolean,        // v3.7.2: arsipkan tanpa hapus
//     createdAt: ISO-string,
//     updatedAt: ISO-string
//   }

export async function getNotes() {
  const data = await browser.storage.local.get(NOTES_KEY);
  let notes = data[NOTES_KEY] || [];
  // Sort: pinned first, then by updatedAt desc
  notes = [...notes].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });
  return notes;
}

export async function saveNotes(notes) {
  await browser.storage.local.set({ [NOTES_KEY]: notes });
  // Auto-backup is interval-based, not on every save
}

export async function addNote(body = '', opts = {}) {
  const notes = await getNotes();
  const now = new Date().toISOString();
  const note = {
    id: 'n_' + now.slice(0, 19).replace(/[-:T]/g, '') + '_' + Math.random().toString(36).slice(2, 8),
    title: opts.title || '',
    body: body || '',
    color: opts.color || 'default',
    group: opts.group || '',
    pinned: !!opts.pinned,
    archived: !!opts.archived,
    createdAt: now,
    updatedAt: now
  };
  notes.push(note);
  await saveNotes(notes);
  return note;
}

export async function updateNote(id, patch) {
  const notes = await getNotes();
  const idx = notes.findIndex(n => n.id === id);
  if (idx < 0) return null;
  notes[idx] = {
    ...notes[idx],
    ...patch,
    updatedAt: new Date().toISOString()
  };
  await saveNotes(notes);
  return notes[idx];
}

export async function deleteNote(id) {
  const notes = await getNotes();
  const filtered = notes.filter(n => n.id !== id);
  await saveNotes(filtered);
}

export async function toggleNotePin(id) {
  const notes = await getNotes();
  const idx = notes.findIndex(n => n.id === id);
  if (idx < 0) return null;
  notes[idx].pinned = !notes[idx].pinned;
  notes[idx].updatedAt = new Date().toISOString();
  await saveNotes(notes);
  return notes[idx];
}

// v3.7.2 (Issue 5): Ambil daftar grup unik dari semua catatan.
// Returns array of { name, count } sorted by name asc.
export async function getNoteGroups() {
  const notes = await getNotes();
  const counts = {};
  for (const n of notes) {
    const g = (n.group || '').trim();
    if (!g) continue;
    counts[g] = (counts[g] || 0) + 1;
  }
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => ({ name, count }));
}

// ===== Content Guardian bypass tracking =====
// Saat user klik "Lewati" di halaman takeover/blocked, URL asli ditandai
// selama 60 detik supaya tidak di-redirect ulang oleh background.

export async function markBypass(url) {
  if (!url) return;
  try {
    const data = await browser.storage.local.get(BYPASS_KEY);
    const map = data[BYPASS_KEY] || {};
    // Hapus entry kedaluwarsa (>60s)
    const now = Date.now();
    for (const k of Object.keys(map)) {
      if (now - map[k] > 60000) delete map[k];
    }
    map[url] = now;
    await browser.storage.local.set({ [BYPASS_KEY]: map });
  } catch (e) {
    console.warn('[RecallFox] markBypass failed:', e);
  }
}

export async function isBypassed(url) {
  if (!url) return false;
  try {
    const data = await browser.storage.local.get(BYPASS_KEY);
    const map = data[BYPASS_KEY] || {};
    const ts = map[url];
    if (!ts) return false;
    if (Date.now() - ts > 60000) {
      // kedaluwarsa, hapus
      delete map[url];
      await browser.storage.local.set({ [BYPASS_KEY]: map });
      return false;
    }
    return true;
  } catch (e) { return false; }
}

// ===== Dynamic user blocklist (Content Guardian v0.8.21) =====
// User bisa klik kanan pada video/tweet → "Blokir Konten Ini" untuk
// menambahkannya ke blocklist. Blocklist entry:
//   { id, type: 'keyword'|'title'|'exact_title'|'channel', value,
//     addedAt, source: { url, title, channel } }

export async function getUserBlocklist() {
  const vault = await getVault();
  return Array.isArray(vault.settings.contentGuardUserBlocklist)
    ? vault.settings.contentGuardUserBlocklist
    : [];
}

export async function addUserBlocklistEntry(entry) {
  const vault = await getVault();
  if (!Array.isArray(vault.settings.contentGuardUserBlocklist)) {
    vault.settings.contentGuardUserBlocklist = [];
  }
  const newEntry = {
    id: 'blk_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
    type: entry.type || 'keyword',
    value: (entry.value || '').trim(),
    addedAt: new Date().toISOString(),
    source: entry.source || null  // { url, title, channel }
  };
  // v3.4: Support altValue (untuk x_post_url — simpan juga path sebagai alt matcher)
  if (entry.altValue) {
    newEntry.altValue = String(entry.altValue).trim();
  }
  if (!newEntry.value) return { ok: false, error: 'empty_value' };
  // Cek duplikat (sama type + value)
  const dup = vault.settings.contentGuardUserBlocklist.find(
    e => e.type === newEntry.type && e.value.toLowerCase() === newEntry.value.toLowerCase()
  );
  if (dup) return { ok: false, error: 'duplicate', existing: dup };
  vault.settings.contentGuardUserBlocklist.push(newEntry);
  await saveVault(vault);
  return { ok: true, entry: newEntry };
}

export async function removeUserBlocklistEntry(id) {
  const vault = await getVault();
  if (!Array.isArray(vault.settings.contentGuardUserBlocklist)) return { ok: false };
  vault.settings.contentGuardUserBlocklist =
    vault.settings.contentGuardUserBlocklist.filter(e => e.id !== id);
  await saveVault(vault);
  return { ok: true };
}

export async function clearUserBlocklist() {
  const vault = await getVault();
  vault.settings.contentGuardUserBlocklist = [];
  await saveVault(vault);
  return { ok: true };
}
