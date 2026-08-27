// lib/storage.js — Wrapper storage.local + storage.sync dengan chunking
// RecallFox v3.8.1 — dengan GDrive Sync hook (Issue #1, #2, #6)

// Lazy import GDriveSync — di-wrap supaya storage.js tetap jalan walau modul
// gdrive-sync belum ada (mis. saat test storage.js standalone).
let _gdriveNotify = null;
let _gdriveUploadScreenshot = null;
async function _loadGDrive() {
  if (_gdriveNotify) return;
  try {
    const mod = await import('./gdrive-sync.js');
    _gdriveNotify = mod.notify || null;
    _gdriveUploadScreenshot = mod.uploadScreenshot || null;
  } catch (e) {
    // Modul belum ada atau gagal load — silent fail, sync GDrive nonaktif
  }
}
function _notifyGDrive(action, data) {
  _loadGDrive().then(() => {
    if (_gdriveNotify) {
      try { _gdriveNotify(action, data).catch(() => {}); } catch (e) {}
    }
  }).catch(() => {});
}
function _uploadScreenshotToGDrive(item, blob) {
  _loadGDrive().then(async () => {
    if (!_gdriveUploadScreenshot) return;
    try {
      const result = await _gdriveUploadScreenshot(item, blob);
      // v3.10.2 (Issue 2 fix): Setelah upload sukses, update vault item dengan
      // gdriveFileId & gdriveFileUrl supaya:
      //   (a) link file Drive muncul di UI vault (kolom screenshot),
      //   (b) spreadsheet 07_Screenshots di-update dengan link file tersebut
      //       (sebelumnya row di spreadsheet dibuat SEBELUM upload selesai,
      //        sehingga kolom gdriveFileId/gdriveFileUrl selalu kosong).
      if (result?.ok && result.gdriveFileId) {
        try {
          // Patch item dengan file info Drive, lalu notify ulang supaya
          // spreadsheet row di-update (upsert by id).
          await _patchScreenshotWithDriveLink(item.id, result.gdriveFileId, result.gdriveFileUrl);
        } catch (e) {
          console.warn('[RecallFox] Failed to update screenshot with Drive link:', e.message);
        }
      } else if (result && !result.ok && result.reason !== 'disabled' && result.reason !== 'screenshots_disabled') {
        console.warn('[RecallFox] Screenshot upload to Drive failed:', result.error || result.reason);
      }
    } catch (e) {
      console.warn('[RecallFox] Screenshot upload exception:', e.message);
    }
  }).catch(() => {});
}

// v3.10.2 (Issue 2 fix): Update screenshot vault item dengan gdriveFileId/Url,
// lalu notify ulang ke GDrive sync supaya row di spreadsheet 07_Screenshots
// ter-update dengan link file Drive.
async function _patchScreenshotWithDriveLink(itemId, gdriveFileId, gdriveFileUrl) {
  try {
    const vault = await getVault();
    const idx = vault.items.findIndex(i => i.id === itemId);
    if (idx < 0) return;
    vault.items[idx] = {
      ...vault.items[idx],
      gdriveFileId,
      gdriveFileUrl,
      updatedAt: new Date().toISOString()
    };
    await saveVault(vault);
    // Notify GDrive sync (upsert) supaya row di spreadsheet diperbarui
    _notifyGDrive('save_screenshot', vault.items[idx]);
    console.log('[RecallFox] Screenshot updated with Drive link:', itemId, '→', gdriveFileUrl);
  } catch (e) {
    console.warn('[RecallFox] _patchScreenshotWithDriveLink failed:', e.message);
  }
}

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
  framingEnabled: true, // v3.16.4: wrap inject text dengan instruksi singkat supaya AI tahu ini konteks
  displayMode: 'popup', // 'popup' | 'sidebar'
  theme: 'auto', // 'auto' | 'light' | 'dark'
  locale: 'auto',
  // AI Assistant (primary)
  assistantProvider: 'groq',
  assistantApiKey: '', // ⚠️ SECURITY: Never ship a real API key. Set your own in Settings → AI Assistant. Get one free at https://console.groq.com/keys
  assistantModel: 'llama-3.3-70b-versatile',
  assistantBaseUrl: '', // for custom OpenAI-compatible endpoints
  // AI Assistant (fallback — used when primary fails)
  assistantFallbackEnabled: true,
  assistantFallbackProvider: 'gemini',
  assistantFallbackApiKey: '', // user needs to add Gemini API key (free tier)
  assistantFallbackModel: 'gemini-2.0-flash',
  assistantFallbackBaseUrl: '',
  // Screenshot (FireShot-style capture)
  screenshotFormat: 'jpeg',        // v3.11.7-fix: default jpeg (kompresi) supaya upload GDrive berhasil
  screenshotJpegQuality: 60,       // v3.11.7-fix: default quality 60 (kompresi tinggi) supaya < 5MB
  screenshotCompression: 'lossless',   // v3.11.8 (Issue #1 fix): default LOSSLESS (PNG) supaya capture selalu jalan.
  // Sebelumnya default 'high' (JPEG q60) — tapi Firefox captureVisibleTab dengan format=jpeg
  // error di beberapa halaman (CSP strict, cross-origin). User report: "gambar hanya bisa
  // ditangkap di lossless, jika dengan kompresi error". Sekarang default lossless (selalu jalan),
  // user bisa pilih kompresi manual di Settings → Screenshot kalau mau ukuran lebih kecil.
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
  // v3.11.7-fix (Issue #6): Adzan sound untuk 5 waktu sholat
  prayerAdzanEnabled: false,               // mainkan suara adzan saat masuk waktu sholat (default OFF)
  prayerAdzanVolume: 0.7,                  // volume adzan (0.0 - 1.0)
  prayerAdzanSound: 'default',             // 'default' | 'short' | 'custom'
  prayerAdzanCustomUrl: '',                // URL file adzan custom (mp3/ogg/wav)
  prayerAdzanPrayers: ['Fajr','Dhuhr','Asr','Maghrib','Isha'],  // waktu mana yang bunyi adzan
  prayerAdzanLastPlayedKey: null,           // tracking: `${date}-${prayerName}` supaya tidak double-play
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
  // v3.11.5 (Issue 2 dari Google Doc): Pintasan web ngaji & olahraga
  // User request: "di bagian sini harusnya ditambahkan tombol pintasan untuk
  //   web yang sering dikunjungi untuk mengaji / belajar berolahraga"
  // Format: array of { name, url, emoji } — maksimal 6 per kategori (supaya UI tidak overflow)
  quranShortcuts: [
    { name: 'Quran.com', url: 'https://quran.com/', emoji: '📖' },
    { name: 'Tafsir Web', url: 'https://tafsirweb.com/', emoji: '📚' },
    { name: 'Quran Kemenag', url: 'https://quran.kemenag.go.id/', emoji: '🕌' }
  ],
  exerciseShortcuts: [
    { name: 'YouTube Yoga', url: 'https://www.youtube.com/results?search_query=yoga+pemula', emoji: '🧘' },
    { name: 'YouTube Cardio', url: 'https://www.youtube.com/results?search_query=cardio+15+menit', emoji: '🏃' }
  ],
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
  sidebarAutoCloseMinutes: 0,              // v3.9.0 (Issue 5): auto-close sidebar after N min idle (0=off)
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
  contentGuardYoutubeKidsOnly: false,       // Redirect semua youtube.com → youtubekids.com (legacy)
  contentGuardKidModeFilter: false,         // v3.10.0 (Issue 2): Mode Anak — filter konten di youtube.com (no redirect), hide non-kid content
  contentGuardKidModeArmUntil: 0,           // epoch-ms hingga mode anak aktif (0 = permanen saat toggle on)

  // ===== v3.11.1 (Issue 4): AI Tools Management =====
  // Customizations untuk AI_TOOLS (lib/ai-tools.js):
  //   { toolId: { pinned: bool, hidden: bool } }
  //   atau { customId: { custom: true, name, url, region, emoji, alt, pinned, hidden } }
  // Untuk add/pin/hide/delete site AI lewat UI.
  aiToolsCustomizations: {},

  // ===== v3.8.1: Google Drive Sync (Apps Script Bridge) — Issue #1, #2, #6 =====
  // Untuk integrasi dengan Google Spreadsheet via Apps Script Web App.
  // Lihat lib/gdrive-sync.js untuk detail implementasi bridge.
  gdriveSyncEnabled: false,                 // master switch
  gdriveWebAppUrl: '',                      // URL Web App Apps Script (https://script.google.com/macros/s/.../exec)
  gdriveAuthToken: '',                      // Token rahasia (HARUS sama dengan CONFIG.AUTH_TOKEN di Apps Script)
  gdriveTokenLocked: true,                  // v3.11.7-fix (Issue #3): Lock token read-only by default
  gdriveSyncOnSave: true,                   // sync setiap operasi save (real-time, debounced 2s)
  gdriveSyncScreenshots: true,              // upload screenshot full image ke Drive folder terpisah
  gdriveSyncIntervalMinutes: 5,             // interval flush queue periodik via browser.alarm (min 1)
  gdriveLastSyncAt: null,                   // timestamp sync terakhir sukses
  gdriveLastError: null,                    // pesan error terakhir (display di Settings)
  gdriveAutoBackupOnLocalBackup: true,      // saat user klik "Backup sekarang" lokal, kirim juga ke GDrive

  // ===== v3.11.7: Multi-PC Bidirectional Sync =====
  // Sync profiles disimpan di storage.local (key: recallfox_sync_profiles) — BUKAN di vault.settings
  // supaya tidak ikut ter-sync (circular). Lihat lib/sync-profile.js.
  // Active profile ID + auto-sync flag disimpan di sini untuk kemudahan akses.
  syncAutoEnabled: false                    // auto-sync (debounced 30s) saat vault berubah
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
  // v3.11.21: Trigger Supabase auto-sync (debounced 5s) — fire-and-forget.
  // Hanya kalau user sudah login Supabase (cek dilakukan di triggerAutoSync).
  browser.runtime.sendMessage({ type: 'SUPABASE_AUTO_SYNC' }).catch(() => {});
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

  // === v3.8.1 GDrive Sync hook — kirim snapshot settings ke sheet 15_Settings ===
  // Hanya kirim field yang berubah (patch), bukan seluruh settings.
  const snapshotAt = new Date().toISOString();
  for (const key in settings) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) {
      const val = settings[key];
      const settingType = typeof val === 'boolean' ? 'BOOLEAN'
                        : typeof val === 'number' ? 'NUMBER'
                        : (val && typeof val === 'object') ? 'JSON'
                        : 'STRING';
      _notifyGDrive('save_setting', {
        snapshotAt,
        settingKey: key,
        settingValue: val,
        settingType,
        category: _categorizeSettingKey(key),
        defaultValue: '',
        notes: ''
      });
    }
  }
}

// Helper: kategorisasi setting key (untuk sheet 15_Settings)
function _categorizeSettingKey(k) {
  if (k.indexOf('sync') === 0 || k === 'lastSyncAt') return 'sync';
  if (k === 'theme' || k === 'displayMode' || k === 'injectMode' ||
      k === 'floatingButtonEnabled' || k === 'overlayButtonEnabled' ||
      k === 'sidebarAutoOpen' || k === 'sidebarAutoCloseMinutes' ||
      k === 'rememberLastTab' || k === 'lastActiveTab' ||
      k === 'lastSidebarWidth' || k === 'showWelcomeOnFirstUse' || k === 'locale') return 'ui';
  if (k.indexOf('assistant') === 0) return 'assistant';
  if (k.indexOf('screenshot') === 0) return 'screenshot';
  if (k.indexOf('clearCache') === 0) return 'clearcache';
  if (k.indexOf('prayer') === 0) return 'prayer';
  if (k.indexOf('quran') === 0) return 'quran';
  if (k.indexOf('exercise') === 0) return 'exercise';
  if (k.indexOf('elementBlocker') === 0) return 'element_blocker';
  if (k.indexOf('autoDiscard') === 0) return 'auto_discard';
  if (k.indexOf('backup') === 0 || k === 'lastBackupAt') return 'backup';
  if (k.indexOf('contentGuard') === 0) return 'content_guard';
  if (k.indexOf('gdrive') === 0) return 'gdrive';
  return 'other';
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
    : type === 'file' ? 'f'
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

  // v3.15.0 P0-S1: snapshot-specific metadata.
  // Sebelumnya: snapshotDomain + snapshotMessageCount di-pass oleh background.js
  // tapi TIDAK di-include di newItem schema → silently stripped.
  // Sekarang: persist di local vault + sync ke cloud (supabase-sync.js _buildVaultItemRow).
  if (type === 'snapshot') {
    newItem.snapshotDomain = item.snapshotDomain || '';
    newItem.snapshotMessageCount = item.snapshotMessageCount || 0;
    // v3.20.16: Relay Point — resume context generated via OmniRouter (silent, async).
    // Disimpan menyatu di metadata snapshot (bukan item baru). null = belum di-generate
    // (OmniRouter belum dikonfigurasi, atau generate gagal — snapshot tetap berfungsi normal).
    //
    // PENTING: Field ini HANYA disimpan di LOCAL storage. TIDAK sync ke Supabase
    // (lihat lib/supabase-sync.js — _buildVaultItemRow TIDAK mengirim resume_context).
    // Alasan: kolom resume_context belum ada di vault_items table. Kalau dipaksakan
    // kirim, Supabase akan reject dengan PGRST204 → SEMUA snapshot sync gagal.
    // Trade-off: resume context tidak sync antar device. Tapi user biasanya generate
    // resume context di device yang sama tempat dia ambil snapshot, jadi OK.
    newItem.resumeContext = item.resumeContext || null;
    newItem.resumeContextAt = item.resumeContextAt || null;
  }

  // v3.15.0 P0-K1: context-specific metadata.
  // Sebelumnya: contextPurpose di-pass oleh popup.js saveKonteksSheet
  // tapi TIDAK di-include di newItem schema → silently stripped.
  // Sekarang: persist di local vault + sync ke cloud (setelah ALTER TABLE tambah kolom context_purpose).
  if (type === 'context') {
    newItem.contextPurpose = item.contextPurpose || 'custom';
  }

  // v3.20.39: Defense-in-depth — jangan push kalau ID sudah ada di vault.
  //   Sebelumnya: vault.items.push(newItem) tanpa cek → kalau ada race condition
  //   (e.g. realtime event + manual addItem untuk ID yang sama), duplikat tercipta.
  //   Sekarang: cek existing ID dulu. Kalau ada, update (last-write-wins by updatedAt)
  //   bukan push duplikat. Fix BUG 1 root cause di layer storage.
  const existingIdx = vault.items.findIndex(i => i.id === newItem.id);
  if (existingIdx >= 0) {
    console.warn('[RecallFox/storage] addItem: ID already exists, updating instead of duplicating:', newItem.id);
    const existing = vault.items[existingIdx];
    const existingUpdated = new Date(existing.updatedAt || 0).getTime();
    const newUpdated = new Date(newItem.updatedAt || Date.now()).getTime();
    if (newUpdated >= existingUpdated) {
      vault.items[existingIdx] = { ...existing, ...newItem };
    } else {
      // Existing lebih baru — skip (cloud/local sudah lebih update)
      console.log('[RecallFox/storage] addItem: existing item newer, skip update:', newItem.id);
      return { ok: true, id: existing.id, skipped: true };
    }
  } else {
    vault.items.push(newItem);
  }
  await saveVault(vault);

  // Store full image separately (always — even if also synced, for fast local access)
  if (type === 'screenshot' && screenshotBlob) {
    try {
      await browser.storage.local.set({ [`${SHOT_PREFIX}${newItem.id}`]: screenshotBlob });
    } catch (e) {
      console.warn('[RecallFox] Failed to store screenshot blob:', e);
    }
    // GDrive: upload full image ke Drive folder (fire-and-forget)
    _uploadScreenshotToGDrive(newItem, screenshotBlob);
  }

  // === GDrive Sync hook (Issue #1, #2) — fire-and-forget ===
  if (type === 'prompt')         _notifyGDrive('save_prompt', newItem);
  else if (type === 'context')   _notifyGDrive('save_konteks', newItem);
  else if (type === 'link')      _notifyGDrive('save_link', newItem);
  else if (type === 'snapshot')  _notifyGDrive('save_snapshot', newItem);
  else if (type === 'screenshot')_notifyGDrive('save_screenshot', newItem);

  // v3.11.34: Direct upsert ke Supabase (immediate, no debounce).
  // FIX v3.11.33 bug: jangan set screenshotDataUrl di newItem — itu akan
  // mutasi vault in-memory (newItem sudah di-push by reference) → vault JSON
  // membengkak dengan data URL gambar inline → storage.local lambat/crash.
  // Sebagai gantinya, kirim object temporary ke directUpsertVaultItem.
  // v3.13.3 (A4 fix): Sebelumnya error ditelan `.catch(()=>{})` → user tidak
  // pernah tahu kalau upload ke cloud gagal. Sekarang log + simpan ke storage
  // supaya UI bisa tampilkan.
  if (type === 'screenshot' && screenshotBlob) {
    const itemForCloud = { ...newItem, screenshotDataUrl: screenshotBlob };
    import('./supabase-sync.js').then(mod => {
      if (mod.directUpsertVaultItem) {
        mod.directUpsertVaultItem(itemForCloud).catch(e => {
          console.warn('[RecallFox] directUpsertVaultItem failed (addItem screenshot):', e.message);
          try {
            browser.storage.local.set({ 'recallfox_last_sync_error': JSON.stringify({ ts: new Date().toISOString(), source: 'directUpsertVaultItem:addItem', itemId: newItem.id, error: e.message }) });
          } catch (_) {}
        });
      }
    }).catch(e => console.warn('[RecallFox] supabase-sync.js import failed:', e.message));
  } else {
    import('./supabase-sync.js').then(mod => {
      if (mod.directUpsertVaultItem) {
        mod.directUpsertVaultItem(newItem).catch(e => {
          console.warn('[RecallFox] directUpsertVaultItem failed (addItem):', e.message);
          try {
            browser.storage.local.set({ 'recallfox_last_sync_error': JSON.stringify({ ts: new Date().toISOString(), source: 'directUpsertVaultItem:addItem', itemId: newItem.id, error: e.message }) });
          } catch (_) {}
        });
      }
    }).catch(e => console.warn('[RecallFox] supabase-sync.js import failed:', e.message));
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

  // === GDrive Sync hook (Issue #1, #2) ===
  const updated = vault.items[idx];
  if (updated.type === 'prompt')         _notifyGDrive('save_prompt', updated);
  else if (updated.type === 'context')   _notifyGDrive('save_konteks', updated);
  else if (updated.type === 'link')      _notifyGDrive('save_link', updated);
  else if (updated.type === 'snapshot')  _notifyGDrive('save_snapshot', updated);
  else if (updated.type === 'screenshot')_notifyGDrive('save_screenshot', updated);

  // v3.11.33: Direct upsert ke Supabase (immediate, no debounce).
  // v3.13.3 (A4 fix): Log + simpan error ke storage supaya UI bisa tampilkan.
  import('./supabase-sync.js').then(mod => {
    if (mod.directUpsertVaultItem) {
      mod.directUpsertVaultItem(updated).catch(e => {
        console.warn('[RecallFox] directUpsertVaultItem failed (updateItem):', e.message);
        try {
          browser.storage.local.set({ 'recallfox_last_sync_error': JSON.stringify({ ts: new Date().toISOString(), source: 'directUpsertVaultItem:updateItem', itemId: id, error: e.message }) });
        } catch (_) {}
      });
    }
  }).catch(e => console.warn('[RecallFox] supabase-sync.js import failed:', e.message));

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

  // === GDrive Sync hook (Issue #1, #2) ===
  if (removed) {
    if (removed.type === 'prompt')         _notifyGDrive('delete_prompt', { id });
    else if (removed.type === 'context')   _notifyGDrive('delete_konteks', { id });
    else if (removed.type === 'link')      _notifyGDrive('delete_link', { id });
    else if (removed.type === 'snapshot')  _notifyGDrive('delete_snapshot', { id });
    else if (removed.type === 'screenshot')_notifyGDrive('delete_screenshot', { id });
  }

  // v3.11.33: Direct HARD DELETE dari cloud (immediate, no debounce).
  // Sebelumnya: soft-delete (set deleted_at) via SUPABASE_DELETE_ITEM message +
  // debounced triggerAutoSync. Race condition antara soft-delete paralel +
  // auto-push menyebabkan deleted_at tidak konsisten → pull masih return item
  // yang seharusnya sudah dihapus.
  //
  // Fix: panggil directDeleteVaultItem yang langsung DELETE row dari cloud.
  // Tambahkan ke delete registry lokal supaya pull tidak re-add.
  // Realtime subscription akan broadcast DELETE event ke device lain.
  // v3.13.3 (A4 fix): Log + simpan error ke storage supaya UI bisa tampilkan.
  import('./supabase-sync.js').then(mod => {
    if (mod.directDeleteVaultItem) {
      mod.directDeleteVaultItem(id).catch(e => {
        console.warn('[RecallFox] directDeleteVaultItem failed (deleteItem):', e.message);
        try {
          browser.storage.local.set({ 'recallfox_last_sync_error': JSON.stringify({ ts: new Date().toISOString(), source: 'directDeleteVaultItem:deleteItem', itemId: id, error: e.message }) });
        } catch (_) {}
      });
    }
  }).catch(e => console.warn('[RecallFox] supabase-sync.js import failed:', e.message));

  // Fallback: tetap kirim SUPABASE_DELETE_ITEM untuk backward compat
  // (kalau mod.directDeleteVaultItem tidak ada di versi lama yang running)
  browser.runtime.sendMessage({
    type: 'SUPABASE_DELETE_ITEM',
    itemId: id,
    itemType: removed?.type || 'unknown'
  }).catch(() => {});
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

// v3.8.1 (Issue #5): addBundle sekarang terima opts { color, note, noteIds, inlinePrompt, saveAsPrompt, archived }
// - noteIds: array ID catatan (notes) yang ikut jadi anggota bundle
// - inlinePrompt: prompt cepat yang ditulis langsung di editor bundle (bukan item)
// - saveAsPrompt: jika true, inlinePrompt juga disimpan sebagai item prompt terpisah
export async function addBundle(name, itemIds = [], opts = {}) {
  const vault = await getVault();
  let finalItemIds = [...itemIds];

  // Issue #5b+c: Inline prompt editor + save-as-prompt checkbox
  let inlinePromptItem = null;
  if (opts.inlinePrompt && opts.inlinePrompt.trim()) {
    const inlineTitle = (opts.inlineTitle || '').trim() || (name || 'Prompt dari Bundle') + ' — inline';
    if (opts.saveAsPrompt) {
      // Simpan inlinePrompt sebagai item prompt terpisah
      inlinePromptItem = await addItem({
        type: 'prompt',
        title: inlineTitle,
        body: opts.inlinePrompt,
        tags: ['bundle-inline'],
        category: 'Bundle'
      });
      finalItemIds.push(inlinePromptItem.id);
    }
  }

  const bundle = {
    id: genId('b'),
    name,
    itemIds: finalItemIds,
    injectOrder: [...finalItemIds],
    noteIds: Array.isArray(opts.noteIds) ? opts.noteIds : [],   // Issue #5a: bundle dukung catatan
    color: opts.color || '',                                     // Issue #5d: warna badge
    note: opts.note || '',
    inlinePrompt: opts.inlinePrompt || '',                       // Issue #5b: simpan teks inline
    inlinePromptItemId: inlinePromptItem?.id || null,
    archived: !!opts.archived,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  vault.bundles.push(bundle);
  await saveVault(vault);

  _notifyGDrive('save_bundle', bundle);
  return bundle;
}

export async function deleteBundle(id) {
  const vault = await getVault();
  vault.bundles = vault.bundles.filter(b => b.id !== id);
  await saveVault(vault);
  _notifyGDrive('delete_bundle', { id });

  // v3.13.7: HARD DELETE bundle dari cloud — sama seperti deleteItem.
  // Sebelumnya pakai soft-delete (set deleted_at) yang fragile + tidak propagate.
  // User complaint: "bundle udah didelet muncul lagi muncul lagi".
  // Root cause: soft-delete bisa gagal/overwrite, lalu pullFromSupabaseV33
  // re-insert bundle tanpa cek delete-registry. Hard-delete menghapus row
  // dari cloud → pull tidak return row → tidak ada resurrection.
  try {
    const mod = await import('./supabase-sync.js');
    // Add to delete registry DULU (supaya pull/realtime tidak re-insert)
    if (mod.addToDeleteRegistry) {
      await mod.addToDeleteRegistry(id, new Date().toISOString());
    }
    // Hard delete dari cloud (immediate, no debounce)
    if (mod.directDeleteVaultItem) {
      const res = await mod.directDeleteVaultItem(id);
      if (!res.ok) {
        console.warn('[RecallFox] deleteBundle cloud delete failed:', id, res.error);
        // Simpan error supaya UI bisa tampilkan
        try {
          await browser.storage.local.set({
            recallfox_last_sync_error: {
              op: 'delete_bundle',
              id: id,
              error: res.error || 'unknown',
              at: new Date().toISOString()
            }
          });
        } catch (e) { /* ignore */ }
      } else {
        console.log('[RecallFox] deleteBundle cloud HARD DELETE OK:', id);
      }
    }
  } catch (e) {
    console.warn('[RecallFox] deleteBundle exception:', e.message);
  }

  // v3.11.29: Fallback — tetap kirim SUPABASE_DELETE_ITEM untuk backward compat
  browser.runtime.sendMessage({
    type: 'SUPABASE_DELETE_ITEM',
    itemId: id,
    itemType: 'bundle'
  }).catch(() => {});
  browser.runtime.sendMessage({ type: 'SUPABASE_AUTO_SYNC' }).catch(() => {});
}

// v3.7.2 (Issue 1): Update bundle — patch {name?, itemIds?, injectOrder?, archived?, color?, note?}
// v3.8.1 (Issue #5): + noteIds?, inlinePrompt?, saveAsPrompt?
// Memungkinkan reassign item ke bundle lain, edit nama, dsb. tanpa hapus-buat.
export async function updateBundle(id, patch) {
  const vault = await getVault();
  const idx = vault.bundles.findIndex(b => b.id === id);
  if (idx < 0) return null;

  // Issue #5b+c: Handle inlinePrompt update dengan save-as-prompt
  if (patch.inlinePrompt !== undefined && patch.saveAsPrompt) {
    const existing = vault.bundles[idx];
    if (patch.inlinePrompt && patch.inlinePrompt.trim()) {
      const inlineTitle = (patch.inlineTitle || '').trim() || (existing.name || 'Prompt dari Bundle') + ' — inline';
      // Update atau buat item prompt inline
      if (existing.inlinePromptItemId) {
        await updateItem(existing.inlinePromptItemId, { title: inlineTitle, body: patch.inlinePrompt });
      } else {
        const newItem = await addItem({
          type: 'prompt',
          title: inlineTitle,
          body: patch.inlinePrompt,
          tags: ['bundle-inline'],
          category: 'Bundle'
        });
        patch.inlinePromptItemId = newItem.id;
        // Tambahkan ke itemIds kalau belum ada
        if (!patch.itemIds) patch.itemIds = [...(existing.itemIds || [])];
        if (!patch.itemIds.includes(newItem.id)) patch.itemIds.push(newItem.id);
        if (!patch.injectOrder) patch.injectOrder = [...(existing.injectOrder || [])];
        if (!patch.injectOrder.includes(newItem.id)) patch.injectOrder.push(newItem.id);
      }
    }
  }
  // Bersihkan field helper yang tidak disimpan
  delete patch.saveAsPrompt;
  delete patch.inlineTitle;

  vault.bundles[idx] = {
    ...vault.bundles[idx],
    ...patch,
    updatedAt: new Date().toISOString()
  };
  await saveVault(vault);
  _notifyGDrive('save_bundle', vault.bundles[idx]);
  return vault.bundles[idx];
}

// v3.7.2 (Issue 1): Tambah / lepas item dari bundle (reassign).
// action: 'add' | 'remove'
// v3.8.1 (Issue #5a): support itemType='note' untuk reassign catatan ke bundle
// Returns updated bundle or null.
export async function reassignToBundle(bundleId, itemId, action = 'add', itemType = 'item') {
  const vault = await getVault();
  const b = vault.bundles.find(x => x.id === bundleId);
  if (!b) return null;

  if (itemType === 'note') {
    // Issue #5a: reassign catatan ke bundle
    b.noteIds = Array.isArray(b.noteIds) ? b.noteIds : [];
    if (action === 'add') {
      if (!b.noteIds.includes(itemId)) b.noteIds.push(itemId);
    } else if (action === 'remove') {
      b.noteIds = b.noteIds.filter(x => x !== itemId);
    }
  } else {
    b.itemIds = Array.isArray(b.itemIds) ? b.itemIds : [];
    b.injectOrder = Array.isArray(b.injectOrder) ? b.injectOrder : [];
    if (action === 'add') {
      if (!b.itemIds.includes(itemId)) b.itemIds.push(itemId);
      if (!b.injectOrder.includes(itemId)) b.injectOrder.push(itemId);
    } else if (action === 'remove') {
      b.itemIds = b.itemIds.filter(x => x !== itemId);
      b.injectOrder = b.injectOrder.filter(x => x !== itemId);
    }
  }
  b.updatedAt = new Date().toISOString();
  await saveVault(vault);
  _notifyGDrive('save_bundle', b);
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

  // v3.13.7: merge bundles by id dengan updatedAt check + delete-registry filter.
  // Sebelumnya: unconditional overwrite (bundleMap.set(b.id, b)) — tidak cek
  // updatedAt, tidak cek delete-registry. Akibatnya bundle yang dihapus di device
  // ini bisa di-resurrect oleh Firefox Sync dari profile lain.
  const bundleMap = new Map();
  for (const b of local.bundles) bundleMap.set(b.id, b);
  // Load delete registry untuk filter bundle yang sudah dihapus
  let deleteReg = { items: {} };
  try {
    const mod = await import('./supabase-sync.js');
    if (mod._getDeleteRegistry) {
      deleteReg = await mod._getDeleteRegistry();
    }
  } catch (e) { /* ignore */ }
  for (const b of (synced.bundles || [])) {
    // Skip bundle yang ada di delete registry (sudah dihapus di device ini)
    if (deleteReg.items[b.id]) continue;
    const existing = bundleMap.get(b.id);
    if (!existing || new Date(b.updatedAt || 0) > new Date(existing.updatedAt || 0)) {
      bundleMap.set(b.id, b);
    }
  }
  // Filter ulang local bundles — hapus yang ada di delete registry
  local.bundles = [...bundleMap.values()].filter(b => !deleteReg.items[b.id]);

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
  _notifyGDrive('save_topping', newTopping);
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
  _notifyGDrive('save_topping', vault.toppings[idx]);
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
  _notifyGDrive('delete_topping', { id });
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
// Schema per note (v3.21.19 — P1-P4 + dueAt + labels + done):
//   {
//     id:        'n_<timestamp>_<rand>',
//     title:     string,         // opsional — judul singkat. Kosong = pakai preview body.
//     body:      string,         // plain text, multiline
//     color:     'default' | 'yellow' | 'green' | 'blue' | 'pink' | 'purple'
//                | 'orange' | 'red' | 'teal' | 'indigo' | 'slate' | 'rose',  // v3.7.2: 12 warna
//     group:     string,         // opsional — nama proyek/grup, mis. "Proyek A". Kosong = tanpa grup.
//     pinned:    boolean,
//     archived:  boolean,        // v3.7.2: arsipkan tanpa hapus
//     done:      boolean,        // v3.21.18: todo done
//     doneAt:    ISO-string|null,// v3.21.18: kapan selesai
//     priority:  1|2|3|4,         // v3.21.19: P1 (merah) paling penting, P4 abu default
//     dueAt:     ISO-string|null,// v3.21.19: tanggal jatuh tempo (besok, 27 Agustus)
//     labels:    string[],       // v3.21.19: #tag
//     createdAt: ISO-string,
//     updatedAt: ISO-string
//   }

export async function getNotes() {
  const data = await browser.storage.local.get(NOTES_KEY);
  let notes = data[NOTES_KEY] || [];
  // v3.21.19: migrasi done/doneAt/priority/dueAt/labels untuk notes lama
  notes = notes.map(n => ({ done: false, doneAt: null, priority: 4, dueAt: null, labels: [], ...n }));
  // Sort: pinned first, then by updatedAt desc (popup.js notesSorted akan override dengan done di atas)
  notes = [...notes].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });
  return notes;
}

export async function saveNotes(notes) {
  await browser.storage.local.set({ [NOTES_KEY]: notes });
  // v3.11.21: Trigger Supabase auto-sync untuk notes juga
  browser.runtime.sendMessage({ type: 'SUPABASE_AUTO_SYNC' }).catch(() => {});
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
    done: !!opts.done,
    doneAt: opts.doneAt || null,
    priority: [1,2,3,4].includes(opts.priority) ? opts.priority : 4,
    dueAt: opts.dueAt || null,
    labels: Array.isArray(opts.labels) ? opts.labels : [],
    createdAt: now,
    updatedAt: now
  };
  notes.push(note);
  await saveNotes(notes);
  _notifyGDrive('save_catatan', note);

  // v3.11.33: Direct upsert ke Supabase (immediate)
  // v3.13.3 (A4 fix): Log + simpan error ke storage supaya UI bisa tampilkan.
  import('./supabase-sync.js').then(mod => {
    if (mod.directUpsertNote) {
      mod.directUpsertNote(note).catch(e => {
        console.warn('[RecallFox] directUpsertNote failed (createNote):', e.message);
        try {
          browser.storage.local.set({ 'recallfox_last_sync_error': JSON.stringify({ ts: new Date().toISOString(), source: 'directUpsertNote:createNote', noteId: note.id, error: e.message }) });
        } catch (_) {}
      });
    }
  }).catch(e => console.warn('[RecallFox] supabase-sync.js import failed:', e.message));

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
  _notifyGDrive('save_catatan', notes[idx]);

  // v3.11.33: Direct upsert ke Supabase (immediate)
  // v3.13.3 (A4 fix): Log + simpan error ke storage supaya UI bisa tampilkan.
  import('./supabase-sync.js').then(mod => {
    if (mod.directUpsertNote) {
      mod.directUpsertNote(notes[idx]).catch(e => {
        console.warn('[RecallFox] directUpsertNote failed (updateNote):', e.message);
        try {
          browser.storage.local.set({ 'recallfox_last_sync_error': JSON.stringify({ ts: new Date().toISOString(), source: 'directUpsertNote:updateNote', noteId: id, error: e.message }) });
        } catch (_) {}
      });
    }
  }).catch(e => console.warn('[RecallFox] supabase-sync.js import failed:', e.message));

  return notes[idx];
}

export async function deleteNote(id) {
  const notes = await getNotes();
  const filtered = notes.filter(n => n.id !== id);
  await saveNotes(filtered);
  _notifyGDrive('delete_catatan', { id });

  // v3.11.33: Direct HARD DELETE dari cloud (immediate, no debounce)
  // v3.13.3 (A4 fix): Log + simpan error ke storage supaya UI bisa tampilkan.
  import('./supabase-sync.js').then(mod => {
    if (mod.directDeleteNote) {
      mod.directDeleteNote(id).catch(e => {
        console.warn('[RecallFox] directDeleteNote failed (deleteNote):', e.message);
        try {
          browser.storage.local.set({ 'recallfox_last_sync_error': JSON.stringify({ ts: new Date().toISOString(), source: 'directDeleteNote:deleteNote', noteId: id, error: e.message }) });
        } catch (_) {}
      });
    }
  }).catch(e => console.warn('[RecallFox] supabase-sync.js import failed:', e.message));

  // Fallback: tetap kirim untuk backward compat
  browser.runtime.sendMessage({
    type: 'SUPABASE_DELETE_NOTE',
    noteId: id
  }).catch(() => {});
}

export async function toggleNotePin(id) {
  const notes = await getNotes();
  const idx = notes.findIndex(n => n.id === id);
  if (idx < 0) return null;
  notes[idx].pinned = !notes[idx].pinned;
  notes[idx].updatedAt = new Date().toISOString();
  await saveNotes(notes);
  _notifyGDrive('save_catatan', notes[idx]);
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
  _notifyGDrive('save_blocklist', newEntry);
  return { ok: true, entry: newEntry };
}

export async function removeUserBlocklistEntry(id) {
  const vault = await getVault();
  if (!Array.isArray(vault.settings.contentGuardUserBlocklist)) return { ok: false };
  vault.settings.contentGuardUserBlocklist =
    vault.settings.contentGuardUserBlocklist.filter(e => e.id !== id);
  await saveVault(vault);
  _notifyGDrive('delete_blocklist', { id });
  return { ok: true };
}

export async function clearUserBlocklist() {
  const vault = await getVault();
  vault.settings.contentGuardUserBlocklist = [];
  await saveVault(vault);
  return { ok: true };
}
