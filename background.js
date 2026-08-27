// background.js — Service worker / background script
// RecallFox v0.2.0
// Tanggung jawab:
//   1. Context menu (save selection as prompt / context / snapshot + screenshot)
//   2. Commands (keyboard shortcuts) — incl. screenshot capture
//   3. Screenshot capture pipeline (visible / entire / selection)
//   4. Sync trigger (debounced)
//   5. Sync listener (merge changes from other devices)

// v3.11.11 (Issue #1): Helper escape HTML untuk COPY_SCREENSHOTS_BATCH
function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

import {
  pushToSync,
  mergeSyncIntoLocal,
  onSyncChange,
  getSettings,
  saveSettings,
  addItem,
  updateItem,
  getVault,
  markBypass,
  isBypassed,
  getUserBlocklist,
  addUserBlocklistEntry,
  removeUserBlocklistEntry,
  clearUserBlocklist,
  exportAllScreenshotBlobs
} from './lib/storage.js';
// v3.20.16: Relay Point — generate resume context via OmniRouter (silent, async, lokal saja)
import { chatWithFallback, isAssistantConfigured } from './lib/assistant.js';
// v3.7: Import untuk backup handlers
import { encryptBackup, decryptBackup, isEncryptedBackup } from './lib/crypto.js';
import {
  matchesIdNewsDomain,
  isYouTubeHome,
  isXHome,
  detectSearchQuery,
  matchesBlockedSearchQuery,
  DEFAULT_NEGATIVE_KEYWORDS,
  DEFAULT_ID_NEWS_DOMAINS,
  DEFAULT_BLOCKED_YT_CHANNELS,
  DEFAULT_BLOCKED_X_ACCOUNTS,
  DEFAULT_BLOCKED_SEARCH_QUERIES,
  DEFAULT_CHINA_YOUTUBE_SEARCHES,
  DEFAULT_CHINA_X_ACCOUNTS,
  DEFAULT_CHINA_X_SEARCHES,
  // v3.21.0: Mode Fokus (Allowlist) — Pelindung Konten baru
  DEFAULT_TOPIC_PROFILES,
  generateProfileId,
  seedDefaultTopicProfiles,
  getActiveProfile,
  matchesProfileSearchQuery,
  isProfileFiltering
} from './lib/contentguard.js';
import { DEFAULT_ELEMENT_BLOCKER_RULES } from './lib/elementblocker.js';
// v3.8.1: GDrive Sync (Apps Script bridge) — Issue #1, #2, #6
import { initGDriveSync, flushNow as gdriveFlushNow, sendFullBackup as gdriveSendFullBackup, uploadScreenshot as gdriveUploadScreenshot, testConnection as gdriveTestConnection, getSyncMeta as gdriveGetMeta, getQueueLength as gdriveGetQueueLength, clearQueue as gdriveClearQueue } from './lib/gdrive-sync.js';

// ===== Setup context menu on install =====

browser.runtime.onInstalled.addListener(async () => {
  // Each subsystem initialized independently — one failure must NOT block others.
  // (Same hardening pattern as sidebar/popup init().)

  // 1. Context menu (critical — without this, no right-click save)
  try { await setupContextMenu(); }
  catch (e) { console.warn('[RecallFox] onInstalled: setupContextMenu failed:', e); }

  // 2. Settings load + initial sync pull
  let settings = {};
  try { settings = await getSettings(); }
  catch (e) { console.warn('[RecallFox] onInstalled: getSettings failed:', e); }

  if (settings.syncEnabled) {
    try { await mergeSyncIntoLocal(); }
    catch (e) { console.warn('[RecallFox] onInstalled: sync pull failed:', e); }
  }

  // 3. Auto-backup initialization (creates Downloads/RecallFox/ folder)
  try {
    const { initBackup, startBackupInterval } = await import('./lib/autobackup.js');
    await initBackup();
    await startBackupInterval();
  } catch (e) {
    console.warn('[RecallFox] onInstalled: initBackup failed:', e.message);
  }

  // 4. Prayer reminder checker
  try { startPrayerReminderChecker(); }
  catch (e) { console.warn('[RecallFox] onInstalled: startPrayerReminderChecker failed:', e); }

  // 5. Content Guardian — inisialisasi default settings (v0.8.20)
  try { await initContentGuardDefaults(); }
  catch (e) { console.warn('[RecallFox] onInstalled: initContentGuardDefaults failed:', e); }

  // 6. v0.8.42: Element Blocker — inisialisasi default rules
  try { await initElementBlockerDefaults(); }
  catch (e) { console.warn('[RecallFox] onInstalled: initElementBlockerDefaults failed:', e); }

  // 7. v0.8.44: Auto Tab Discard checker
  try { startAutoDiscardChecker(); }
  catch (e) { console.warn('[RecallFox] onInstalled: startAutoDiscardChecker failed:', e); }

  // 8. v3.8.1: GDrive Sync init (Issue #1, #2, #6)
  try { await initGDriveSync(); }
  catch (e) { console.warn('[RecallFox] onInstalled: GDriveSync init failed:', e); }

  // v3.13.3 (A1 fix): Start Supabase realtime sync + alarm saat onInstalled.
  // BUG A1: Sebelumnya alarm hanya di-start di onStartup. Setelah update addon,
  // alarm mati sampai Firefox di-restart → sync tidak real-time.
  // Solusi: gated isLoggedIn() (mirror onStartup pattern).
  try {
    const { isLoggedIn } = await import('./lib/supabase-client.js');
    const loggedIn = await isLoggedIn();
    if (loggedIn) {
      const { startRealtimeSync, subscribeRealtimeVault } = await import('./lib/supabase-sync.js');
      await startRealtimeSync();
      await subscribeRealtimeVault();
      console.log('[RecallFox] onInstalled: Supabase realtime sync started (v3.13.3)');
    }
  } catch (e) { console.warn('[RecallFox] onInstalled: Supabase realtime start failed:', e.message); }

  // v0.8.36: HAPUS force-inject di onInstalled — bikin duplikat panel + loop.
  // Content script dari manifest.json akan auto-load saat tab di-refresh.
  // User cukup refresh tab YouTube/X manual setelah install.

  // v3.15.0 P0-K1+K2: Migration — backfill contextPurpose untuk existing context items.
  // Sebelumnya: tujuan ditempel jadi teks [Tujuan: ...] di awal body karena tidak ada kolom DB.
  // Sekarang: kolom context_purpose ada di DB + field contextPurpose di local vault.
  // Migration: parse [Tujuan: ...] dari body → set contextPurpose → bersihkan body.
  // Juga backfill snapshotDomain dari source.url untuk existing snapshots.
  try {
    const { getVault, saveVault } = await import('./lib/storage.js');
    const vault = await getVault();
    let migrated = 0;
    for (const item of (vault.items || [])) {
      let changed = false;
      // Migration K1+K2: context — parse [Tujuan: ...] dari body
      if (item.type === 'context' && !item.contextPurpose) {
        const m = (item.body || '').match(/^\[Tujuan:\s*([^\]]+)\]\s*\n\n/);
        if (m) {
          const purposeLabel = m[1].trim();
          // Reverse map label → key
          const labelToKey = {
            'Instruksi Sistem': 'system', 'Konteks Proyek': 'project',
            'Pengetahuan Domain': 'domain', 'Referensi': 'reference',
            'Instruksi Kerja': 'instruction'
          };
          item.contextPurpose = labelToKey[purposeLabel] || 'custom';
          item.body = item.body.slice(m[0].length);
          changed = true;
        } else {
          item.contextPurpose = 'custom';
        }
      }
      // Migration S1: snapshot — backfill snapshotDomain dari source.url
      if (item.type === 'snapshot' && !item.snapshotDomain && item.source?.url) {
        try {
          item.snapshotDomain = new URL(item.source.url).hostname;
          changed = true;
        } catch (e) { /* ignore invalid URL */ }
      }
      if (changed) migrated++;
    }
    if (migrated > 0) {
      await saveVault(vault);
      console.log('[RecallFox] onInstalled: migrated', migrated, 'items (context purpose + snapshot domain backfill)');
    }
  } catch (e) {
    console.warn('[RecallFox] onInstalled: migration failed:', e.message);
  }
});

browser.runtime.onStartup.addListener(async () => {
  // Each subsystem initialized independently.

  let settings = {};
  try { settings = await getSettings(); }
  catch (e) { console.warn('[RecallFox] onStartup: getSettings failed:', e); }

  if (settings.syncEnabled) {
    try { await mergeSyncIntoLocal(); }
    catch (e) { console.warn('[RecallFox] onStartup: sync pull failed:', e); }
  }

  // Auto-open sidebar if user enabled it
  if (settings.sidebarAutoOpen) {
    try {
      setTimeout(async () => {
        try { await browser.sidebarAction.open(); console.log('[RecallFox] Sidebar auto-opened on startup'); }
        catch (e) { console.warn('[RecallFox] Sidebar auto-open failed:', e.message); }
      }, 2000);
    } catch (e) {
      console.warn('[RecallFox] Sidebar auto-open setup failed:', e.message);
    }
  }

  // Prayer reminder checker (runs every 60s)
  try { startPrayerReminderChecker(); }
  catch (e) { console.warn('[RecallFox] onStartup: startPrayerReminderChecker failed:', e); }

  // Auto-backup interval timer
  try {
    const { startBackupInterval } = await import('./lib/autobackup.js');
    await startBackupInterval();
  } catch (e) {
    console.warn('[RecallFox] onStartup: Backup interval start failed:', e.message);
  }

  // Content Guardian — init defaults juga saat startup
  try { await initContentGuardDefaults(); }
  catch (e) { console.warn('[RecallFox] onStartup: initContentGuardDefaults failed:', e); }

  // v3.11.29: Start Supabase realtime sync kalau user sudah logged in
  try {
    const { isLoggedIn } = await import('./lib/supabase-client.js');
    const loggedIn = await isLoggedIn();
    if (loggedIn) {
      const { startRealtimeSync, subscribeRealtimeVault } = await import('./lib/supabase-sync.js');
      await startRealtimeSync();
      await subscribeRealtimeVault();
      console.log('[RecallFox] Supabase realtime sync started on startup (v3.11.33)');
    }
  } catch (e) { console.warn('[RecallFox] onStartup: Supabase realtime start failed:', e.message); }

  // v0.8.42: Element Blocker init
  try { await initElementBlockerDefaults(); }
  catch (e) { console.warn('[RecallFox] onStartup: initElementBlockerDefaults failed:', e); }

  // v0.8.44: Auto Tab Discard checker
  try { startAutoDiscardChecker(); }
  catch (e) { console.warn('[RecallFox] onStartup: startAutoDiscardChecker failed:', e); }

  // v3.8.1: GDrive Sync init (Issue #1, #2, #6)
  try { await initGDriveSync(); }
  catch (e) { console.warn('[RecallFox] onStartup: GDriveSync init failed:', e); }

  // v0.8.36: HAPUS force-inject di onStartup juga — bikin duplikat + loop
});

// v3.11.6: Helper escapeHtml untuk background context (tidak punya DOM).
// Dipakai saat build text/html payload untuk clipboard.
function _escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function setupContextMenu() {
  await browser.menus.removeAll().catch(() => {});

  // Selection-based: save as Prompt / Context
  browser.menus.create({
    id: 'rf-save-prompt',
    title: browser.i18n.getMessage('ctxMenuSaveAsPrompt'),
    contexts: ['selection']
  });
  browser.menus.create({
    id: 'rf-save-context',
    title: browser.i18n.getMessage('ctxMenuSaveAsContext'),
    contexts: ['selection']
  });

  // Page-based: save current page as Link
  browser.menus.create({
    id: 'rf-separator-1',
    type: 'separator',
    contexts: ['page', 'frame', 'selection']
  });
  browser.menus.create({
    id: 'rf-save-page',
    title: browser.i18n.getMessage('ctxMenuSavePage'),
    contexts: ['page'],
    documentUrlPatterns: ['http://*/*', 'https://*/*']
  });
  // Link-based: save specific link as Link
  browser.menus.create({
    id: 'rf-save-link',
    title: browser.i18n.getMessage('ctxMenuSaveLink'),
    contexts: ['link'],
    targetUrlPatterns: ['http://*/*', 'https://*/*']
  });

  // Snapshot (AI domains only)
  browser.menus.create({
    id: 'rf-separator-2',
    type: 'separator',
    contexts: ['page']
  });
  browser.menus.create({
    id: 'rf-snapshot',
    title: browser.i18n.getMessage('ctxMenuSnapshot'),
    contexts: ['page']
    // v3.16.2: Hapus documentUrlPatterns hardcoded — pakai dynamic isAIPageFromOrigin di handler.
    // Menu muncul di semua halaman, tapi handler cek aiSites sebelum eksekusi snapshot.
  });

  // Screenshot single entry (FireShot-style — opens modal with PDF/JPG/PNG/Copy/Vault options)
  browser.menus.create({
    id: 'rf-separator-3',
    type: 'separator',
    contexts: ['page']
  });
  browser.menus.create({
    id: 'rf-screenshot',
    title: browser.i18n.getMessage('ctxMenuCaptureScreenshot') || 'Capture Screenshot',
    contexts: ['page'],
    documentUrlPatterns: ['http://*/*', 'https://*/*']
  });
  // v3.20.4: Popout sidebar — context menu untuk toggle sidebar di halaman
  browser.menus.create({
    id: 'rf-sidebar-in-page',
    title: 'Tampilkan RecallFox di halaman ini (popout)',
    contexts: ['page'],
    documentUrlPatterns: ['http://*/*', 'https://*/*']
  });

  // Clear Cache (clearcache-style) — works on all http(s) pages
  browser.menus.create({
    id: 'rf-separator-4',
    type: 'separator',
    contexts: ['page']
  });
  browser.menus.create({
    id: 'rf-clear-cache',
    title: browser.i18n.getMessage('ctxMenuClearCache') || 'Clear Cache',
    contexts: ['page']
  });

  // "Tanya AI" context menu — sends selected text to AI assistant
  browser.menus.create({
    id: 'rf-separator-5',
    type: 'separator',
    contexts: ['selection']
  });
  browser.menus.create({
    id: 'rf-ask-ai',
    title: '🤖 Tanya Si Pandai',
    contexts: ['selection']
  });

  // v3.14.0: RecallTape — "Add to RecallFox Tape" (klik kanan teks/angka terseleksi)
  // Memunculkan popover RecallTape di tab aktif + menambahkan teks terseleksi sebagai baris baru.
  browser.menus.create({
    id: 'rf-separator-tape',
    type: 'separator',
    contexts: ['selection']
  });
  browser.menus.create({
    id: 'rf-add-to-tape',
    title: browser.i18n.getMessage('ctxMenuAddToTape') || '🧾 Tambah ke RecallTape',
    contexts: ['selection']
  });

  // ===== Content Guardian: "Blokir Konten Ini" (v0.8.21) =====
  // Hanya muncul di YouTube & X — klik kanan untuk blokir konten yang
  // sedang di-hover (video card / tweet).
  browser.menus.create({
    id: 'rf-separator-6',
    type: 'separator',
    contexts: ['page', 'link', 'video'],
    documentUrlPatterns: [
      'https://*.youtube.com/*',
      'https://*.youtube-nocookie.com/*',
      'https://*.x.com/*',
      'https://*.twitter.com/*'
    ]
  });
  // Sub-menu: pilih cara blokir
  browser.menus.create({
    id: 'rf-cg-block-root',
    title: '🚫 Blokir Konten Ini',
    contexts: ['page', 'link', 'video'],
    documentUrlPatterns: [
      'https://*.youtube.com/*',
      'https://*.youtube-nocookie.com/*',
      'https://*.x.com/*',
      'https://*.twitter.com/*'
    ]
  });
  browser.menus.create({
    id: 'rf-cg-block-title',
    parentId: 'rf-cg-block-root',
    title: 'Blokir judul ini (title)',
    contexts: ['page', 'link', 'video']
  });
  browser.menus.create({
    id: 'rf-cg-block-exact-title',
    parentId: 'rf-cg-block-root',
    title: 'Blokir judul PERSIS ini (exact)',
    contexts: ['page', 'link', 'video']
  });
  browser.menus.create({
    id: 'rf-cg-block-channel',
    parentId: 'rf-cg-block-root',
    title: 'Blokir channel/akun ini',
    contexts: ['page', 'link', 'video']
  });
  browser.menus.create({
    id: 'rf-cg-block-keyword',
    parentId: 'rf-cg-block-root',
    title: 'Blokir kata kunci dari teks terseleksi…',
    contexts: ['selection']
  });
  // Blokir berdasarkan teks terseleksi (selection) — paling fleksibel
  browser.menus.create({
    id: 'rf-cg-block-selection',
    parentId: 'rf-cg-block-root',
    title: 'Blokir teks terseleksi: "%s"',
    contexts: ['selection'],
    visible: false  // Tidak terlihat sampai ada selection (pakai onShown)
  });
  // v3.4: Blokir URL post X — muncul hanya di x.com/twitter.com
  // Saat user klik kanan pada link tweet atau di halaman tweet, simpan URL-nya.
  // Semua post dengan URL yang sama (atau path yang sama) akan di-hide di timeline X.
  browser.menus.create({
    id: 'rf-cg-block-x-post-url',
    parentId: 'rf-cg-block-root',
    title: '🔗 Blokir URL post X ini',
    contexts: ['page', 'link'],
    documentUrlPatterns: [
      'https://*.x.com/*',
      'https://*.twitter.com/*'
    ]
  });

  // v0.9.0: Element Blocker — "Block Element Ini" (klik kanan di elemen mana saja)
  browser.menus.create({
    id: 'rf-separator-7',
    type: 'separator',
    contexts: ['page', 'link', 'image', 'video'],
    documentUrlPatterns: ['http://*/*', 'https://*/*']
  });
  browser.menus.create({
    id: 'rf-eb-block-element',
    title: '🚫 Block Element Ini (Element Blocker)',
    contexts: ['page', 'link', 'image', 'video'],
    documentUrlPatterns: ['http://*/*', 'https://*/*']
  });
}

// ===== Handle context menu clicks =====

browser.menus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'rf-save-prompt' || info.menuItemId === 'rf-save-context') {
    const text = (info.selectionText || '').trim();
    if (!text) return;
    const type = info.menuItemId === 'rf-save-prompt' ? 'prompt' : 'context';
    await addItem({
      type,
      title: text.slice(0, 60).replace(/\s+/g, ' '),
      body: text,
      source: {
        url: info.pageUrl,
        title: tab.title,
        capturedAt: new Date().toISOString()
      }
    });
    // notify content script to show toast
    try {
      await browser.tabs.sendMessage(tab.id, { type: 'SHOW_TOAST', message: 'toastSaved' });
    } catch (e) { /* not on a content-script page; ignore */ }
  } else if (info.menuItemId === 'rf-save-page') {
    // Save current page as Link item
    const url = info.pageUrl || tab.url;
    if (!url || !/^https?:\/\//.test(url)) return;
    await addItem({
      type: 'link',
      title: tab.title || url,
      body: url,  // we store URL in body for compatibility
      linkUrl: url,
      linkTitle: tab.title || url,
      source: {
        url: url,
        title: tab.title,
        capturedAt: new Date().toISOString()
      }
    });
    try {
      await browser.tabs.sendMessage(tab.id, { type: 'SHOW_TOAST', message: 'toastSaved' });
    } catch (e) {}
  } else if (info.menuItemId === 'rf-save-link') {
    // Save right-clicked link as Link item
    const url = info.linkUrl;
    if (!url || !/^https?:\/\//.test(url)) return;
    const linkText = info.linkText || url;
    await addItem({
      type: 'link',
      title: linkText,
      body: url,
      linkUrl: url,
      linkTitle: linkText,
      source: {
        url: url,
        title: linkText,
        capturedAt: new Date().toISOString(),
        fromPageUrl: info.pageUrl,
        fromPageTitle: tab.title
      }
    });
    try {
      await browser.tabs.sendMessage(tab.id, { type: 'SHOW_TOAST', message: 'toastSaved' });
    } catch (e) {}
  } else if (info.menuItemId === 'rf-snapshot') {
    // v3.16.2: Cek via isAIPageFromOrigin (dynamic dari storage.aiSites)
    try {
      const { isAIPageFromOrigin } = await import('./lib/ai-detect.js');
      const isAI = await isAIPageFromOrigin(tab.url || info.pageUrl);
      if (!isAI) {
        console.log('[RecallFox] Snapshot dibatalkan — halaman bukan AI site (cek aiSites)');
        try {
          await browser.tabs.sendMessage(tab.id, { type: 'SHOW_TOAST', message: 'Snapshot hanya bisa di halaman AI chat. Tambahkan situs ini ke Kelola Situs AI kalau perlu.' });
        } catch (e) {}
        return;
      }
      await browser.tabs.sendMessage(tab.id, { type: 'OPEN_SNAPSHOT_MODAL' });
    } catch (e) {
      console.warn('[RecallFox] Cannot open snapshot modal:', e);
    }
  } else if (info.menuItemId === 'rf-screenshot') {
    // Single FireShot-style entry — opens capture modal in active tab
    try {
      await browser.tabs.sendMessage(tab.id, { type: 'TRIGGER_CAPTURE_FROM_POPUP' });
    } catch (e) {
      console.warn('[RecallFox] overlay not reachable, falling back to direct save:', e.message);
      await triggerScreenshot(tab, 'entire');
    }
  } else if (info.menuItemId === 'rf-sidebar-in-page') {
    // v3.20.4: Toggle popout sidebar di halaman aktif
    try {
      await browser.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR_IN_PAGE' });
    } catch (e) {
      // Content script belum loaded — inject lalu toggle
      try {
        await browser.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/sidebar-cs.js']
        });
        setTimeout(async () => {
          try { await browser.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR_IN_PAGE' }); }
          catch (e2) { console.warn('[RecallFox] Popout sidebar toggle failed:', e2.message); }
        }, 300);
      } catch (e2) {
        console.warn('[RecallFox] Popout sidebar inject failed:', e2.message);
      }
    }
  } else if (info.menuItemId === 'rf-clear-cache') {
    console.log('[RecallFox] Context menu → clear cache');
    const settings = await getSettings();
    const { clearBrowsingData } = await import('./lib/clearcache.js');
    const res = await clearBrowsingData({
      dataTypes: settings.clearCacheDataTypes,
      timePeriod: settings.clearCacheTimePeriod,
      currentTabOnly: settings.clearCacheCurrentTabOnly,
      reload: settings.clearCacheReload,
      notify: settings.clearCacheNotify
    });
    console.log('[RecallFox] Clear cache result:', res);
  } else if (info.menuItemId === 'rf-eb-block-element') {
    // v0.9.0: Block Element Ini — minta content script dapatkan selector elemen yang di-hover
    console.log('[RecallFox/EB] Block Element clicked');
    let elementInfo = null;
    try {
      elementInfo = await browser.tabs.sendMessage(tab.id, { type: 'EB_GET_ELEMENT_FOR_BLOCK' });
    } catch (e) {
      console.warn('[RecallFox/EB] Cannot reach content script:', e.message);
    }
    if (elementInfo && elementInfo.selector) {
      // Dapatkan domain
      let domain = '';
      try { domain = new URL(tab.url).hostname; } catch (e) {}
      if (!domain) { domain = tab.url || 'unknown'; }

      // Dapatkan rules yang ada
      const s = await getSettings();
      let rules = s.elementBlockerRules || [];

      // Cari rule untuk domain ini, atau buat baru
      let rule = rules.find(r => r.domain === domain);
      if (rule) {
        // Tambah selector kalau belum ada
        if (!rule.selectors.includes(elementInfo.selector)) {
          rule.selectors.push(elementInfo.selector);
        }
      } else {
        // Buat rule baru
        rule = {
          id: 'custom_' + Date.now().toString(36),
          name: 'Custom: ' + domain,
          domain, enabled: true, isPreset: false,
          selectors: [elementInfo.selector],
          blockDomains: [], blockPopups: false
        };
        rules.push(rule);
      }

      // Save
      await saveSettings({ elementBlockerRules: rules });
      // Broadcast update
      browser.tabs.query({}).then(tabs => {
        for (const t of tabs) {
          browser.tabs.sendMessage(t.id, { type: 'EB_RULES_UPDATED' }).catch(() => {});
        }
      }).catch(() => {});

      // Notifikasi
      try {
        await browser.notifications.create({
          type: 'basic',
          title: '🚫 Element Diblokir!',
          message: `Selector "${elementInfo.selector}" ditambahkan untuk ${domain}. Elemen langsung di-hide.`,
          iconUrl: browser.runtime.getURL('icons/icon-96.svg')
        });
      } catch (e) {}
    } else {
      try {
        await browser.notifications.create({
          type: 'basic',
          title: '⚠️ Tidak bisa block element',
          message: 'Arahkan kursor ke elemen yang mau di-block, lalu klik kanan → Block Element Ini. Refresh halaman kalau belum jalan.',
          iconUrl: browser.runtime.getURL('icons/icon-96.svg')
        });
      } catch (e) {}
    }
  } else if (info.menuItemId === 'rf-ask-ai') {
    // Send selected text to AI assistant via sidebar
    const text = (info.selectionText || '').trim();
    if (!text) return;
    console.log('[RecallFox] Ask AI about:', text.slice(0, 80));
    // Use shared orchestration: store pending + open sidebar + deliver message
    await routeAiQuery(text, { sourceUrl: info.pageUrl || '', sourceTitle: tab?.title || '' });
  } else if (info.menuItemId === 'rf-add-to-tape') {
    // v3.14.0: RecallTape — kirim teks terseleksi ke popover Tape di tab aktif
    const text = (info.selectionText || '').trim();
    if (!text) return;
    console.log('[RecallFox/Tape] Add to tape:', text.slice(0, 80));
    try {
      await browser.tabs.sendMessage(tab.id, { type: 'ADD_TO_TAPE', text });
    } catch (e) {
      // Content script belum loaded — inject manual lalu kirim ulang
      console.warn('[RecallFox/Tape] sendMessage failed, trying inject:', e.message);
      try {
        await browser.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/tape-cs.js']
        });
        // Kasih waktu dynamic import selesai
        await new Promise(r => setTimeout(r, 200));
        await browser.tabs.sendMessage(tab.id, { type: 'ADD_TO_TAPE', text });
      } catch (e2) {
        console.error('[RecallFox/Tape] Inject fallback failed:', e2.message);
        try {
          browser.notifications.create({
            type: 'basic',
            iconUrl: browser.runtime.getURL('icons/icon-96.svg'),
            title: 'RecallTape',
            message: 'Tidak bisa membuka tape di halaman ini. Coba di halaman http/https biasa.'
          });
        } catch (_) {}
      }
    }
  } else if (info.menuItemId === 'rf-cg-block-selection') {
    // Blokir teks terseleksi sebagai keyword
    const text = (info.selectionText || '').trim();
    if (!text) return;
    const res = await addUserBlocklistEntry({
      type: 'keyword',
      value: text,
      source: { url: info.pageUrl || '', title: tab?.title || '', channel: '' }
    });
    await notifyBlockResult(res, 'kata kunci', text);
    await broadcastCgUpdate(tab?.id);
  } else if (info.menuItemId === 'rf-cg-block-x-post-url') {
    // v3.4: Blokir URL post X — pakai linkUrl (kalau klik kanan di link tweet)
    // atau pageUrl (kalau klik kanan di halaman tweet itu sendiri)
    let postUrl = info.linkUrl || info.pageUrl || '';
    if (!postUrl) {
      try {
        await browser.notifications.create({
          type: 'basic',
          title: '⚠️ Tidak ada URL',
          message: 'Klik kanan pada link tweet atau di halaman tweet untuk memblokir URL-nya.',
          iconUrl: browser.runtime.getURL('icons/icon-96.svg')
        });
      } catch (e) {}
      return;
    }
    // Normalisasi URL: hapus query params (?s=20, ?ref_src=...) yang sering dipakai untuk tracking
    // tapi pertahankan path (/user/status/123)
    let normalizedUrl = postUrl;
    try {
      const u = new URL(postUrl);
      // Path: /<user>/status/<id> — simpan hanya ini
      normalizedUrl = u.protocol + '//' + u.hostname + u.pathname;
      // Hapus trailing slash
      normalizedUrl = normalizedUrl.replace(/\/$/, '');
    } catch (e) {
      // Kalau URL invalid, pakai apa adanya
    }
    // Extract path hash (untuk identifikasi lebih toleran — /user/status/123)
    // Bisa dipakai untuk match post yang sama meski domain .com vs .x berbeda
    let postPath = '';
    try {
      postPath = new URL(normalizedUrl).pathname;
    } catch (e) {}
    const res = await addUserBlocklistEntry({
      type: 'x_post_url',
      value: normalizedUrl,
      // Simpan juga path sebagai alt matcher
      altValue: postPath,
      source: { url: info.pageUrl || '', title: tab?.title || '', channel: '' }
    });
    await notifyBlockResult(res, 'URL post X', normalizedUrl);
    await broadcastCgUpdate(tab?.id);
  } else if (info.menuItemId === 'rf-cg-block-title' ||
             info.menuItemId === 'rf-cg-block-exact-title' ||
             info.menuItemId === 'rf-cg-block-channel' ||
             info.menuItemId === 'rf-cg-block-keyword') {
    // Untuk opsi ini, kita perlu tanya content script untuk dapat
    // judul/channel dari elemen yang sedang di-hover / aktif
    let payload = null;
    try {
      payload = await browser.tabs.sendMessage(tab.id, {
        type: 'CG_GET_CONTEXT_FOR_BLOCK',
        menuItemId: info.menuItemId,
        selectionText: info.selectionText || ''
      });
    } catch (e) {
      console.warn('[RecallFox/CG] Cannot get context from content script:', e.message);
    }
    if (!payload || !payload.value) {
      // Fallback: kalau ada selectionText, pakai sebagai keyword
      const sel = (info.selectionText || '').trim();
      if (sel) {
        const res = await addUserBlocklistEntry({
          type: 'keyword', value: sel,
          source: { url: info.pageUrl || '', title: tab?.title || '' }
        });
        await notifyBlockResult(res, 'kata kunci', sel);
        await broadcastCgUpdate(tab?.id);
      } else {
        try {
          await browser.notifications.create({
            type: 'basic',
            title: '🚫 Tidak ada konten terdeteksi',
            message: 'Arahkan kursor ke video/tweet dulu, atau blok teks lalu klik kanan → Blokir teks terseleksi.',
            iconUrl: browser.runtime.getURL('icons/icon-96.svg')
          });
        } catch (e) {}
      }
      return;
    }
    const typeMap = {
      'rf-cg-block-title': 'title',
      'rf-cg-block-exact-title': 'exact_title',
      'rf-cg-block-channel': 'channel',
      'rf-cg-block-keyword': 'keyword'
    };
    const type = typeMap[info.menuItemId] || 'keyword';
    const res = await addUserBlocklistEntry({
      type,
      value: payload.value,
      source: {
        url: info.pageUrl || '',
        title: payload.title || tab?.title || '',
        channel: payload.channel || ''
      }
    });
    const labelMap = { title: 'judul', exact_title: 'judul persis', channel: 'channel/akun', keyword: 'kata kunci' };
    await notifyBlockResult(res, labelMap[type] || 'item', payload.value);
    await broadcastCgUpdate(tab?.id);
  }
});

// Helper: notifikasi hasil blokir
async function notifyBlockResult(res, label, value) {
  try {
    if (res?.ok) {
      await browser.notifications.create({
        type: 'basic',
        title: '🚫 Diblokir!',
        message: `${label.charAt(0).toUpperCase() + label.slice(1)} "${value.slice(0, 50)}${value.length > 50 ? '…' : ''}" ditambahkan ke blocklist. Konten serupa akan disembunyikan.`,
        iconUrl: browser.runtime.getURL('icons/icon-96.svg')
      });
    } else if (res?.error === 'duplicate') {
      await browser.notifications.create({
        type: 'basic',
        title: 'ℹ️ Sudah diblokir',
        message: `${label} ini sudah ada di blocklist.`,
        iconUrl: browser.runtime.getURL('icons/icon-96.svg')
      });
    } else {
      await browser.notifications.create({
        type: 'basic',
        title: '⚠️ Gagal blokir',
        message: `Error: ${res?.error || 'unknown'}`,
        iconUrl: browser.runtime.getURL('icons/icon-96.svg')
      });
    }
  } catch (e) { /* notif gagal bukan masalah */ }
}

// Helper: broadcast update ke content script supaya re-scan feed
async function broadcastCgUpdate(tabId) {
  try {
    // Broadcast ke semua tab
    const tabs = await browser.tabs.query({});
    for (const t of tabs) {
      browser.tabs.sendMessage(t.id, { type: 'CG_SETTINGS_UPDATED' }).catch(() => {});
    }
    // Jika ada tabId spesifik, juga kirim CG_RESCAN untuk paksa re-scan segera
    if (tabId) {
      browser.tabs.sendMessage(tabId, { type: 'CG_RESCAN_NOW' }).catch(() => {});
    }
    // Broadcast ke semua tab juga
    await browser.runtime.sendMessage({ type: 'CG_SETTINGS_UPDATED' }).catch(() => {});
  } catch (e) { /* ignore */ }
}

// ===== Context menu visibility toggle (hanya tampilkan opsi yang relevan) =====
// Saat user klik kanan: jika ada selection → tampilkan opsi "Blokir teks terseleksi"
// dan ubah %s ke teks yang terseleksi. Jika tidak ada selection → sembunyikan opsi itu.
if (browser.menus.onShown) {
  browser.menus.onShown.addListener((info, tab) => {
    const hasSelection = !!(info.selectionText && info.selectionText.trim().length > 0);
    const selPreview = hasSelection
      ? info.selectionText.trim().slice(0, 40) + (info.selectionText.trim().length > 40 ? '…' : '')
      : '';
    // Update title dan visibility untuk opsi "Blokir teks terseleksi"
    try {
      browser.menus.update('rf-cg-block-selection', {
        visible: hasSelection,
        title: hasSelection ? `Blokir teks terseleksi: "${selPreview}"` : 'Blokir teks terseleksi'
      }).catch(() => {});
      // Update opsi "Blokir kata kunci dari teks terseleksi" juga
      browser.menus.update('rf-cg-block-keyword', {
        visible: hasSelection,
        title: hasSelection ? `Blokir sebagai kata kunci: "${selPreview}"` : 'Blokir kata kunci dari teks terseleksi…'
      }).catch(() => {});
      browser.menus.refresh().catch(() => {});
    } catch (e) { /* ignore */ }
  });
}

// ===== Screenshot capture pipeline =====
//
// Two flows:
//   A) FireShot-style (default since v0.2.0):
//      user gesture (overlay button / popup button / shortcut / context menu)
//        → captureFullPage(tab) → returns {dataUrl, width, height, bytes}
//        → caller (overlay.js) shows modal with save options
//        → user picks PDF/JPG/PNG/Copy/Vault → message handler saves accordingly
//
//   B) Direct save (legacy / for "Save to Vault" button in modal):
//      saveCaptureToVault(dataUrl, ...) → addItem({type:'screenshot', ...})
//
// captureVisibleTab can only be invoked from the background context.
// We accept CAPTURE_VISIBLE_TAB from content scripts and return the dataUrl.

async function captureFullPage(tab, opts = {}) {
  if (!tab?.id) {
    return { ok: false, error: 'no_tab' };
  }
  if (!tab.url || !/^https?:\/\//.test(tab.url)) {
    return { ok: false, error: 'not_http_page' };
  }

  const settings = await getSettings();
  // v3.11.7-fix (Issue #1): Baca "compression level" dulu, lalu map ke format + quality.
  // Ini menggantikan pembacaan langsung screenshotFormat/screenshotJpegQuality supaya
  // user cukup pilih 1 dropdown (Lossless / Sedikit / Sedang / Tinggi) dan kita yang
  // atur format + quality di belakang. Default = "high" (JPEG q60) supaya upload
  // GDrive sync selalu di bawah limit Apps Script (~10MB) dan Apps Script doGet payload.
  const compLevel = settings.screenshotCompression || 'high';
  let format, quality;
  switch (compLevel) {
    case 'lossless':
      format = 'png'; quality = 100; break;     // PNG lossless — besar, ~puluhan MB
    case 'low':
      format = 'jpeg'; quality = 90; break;     // JPEG q90 — sedikit kompresi, ~1-3 MB
    case 'medium':
      format = 'jpeg'; quality = 75; break;     // JPEG q75 — sedang, ~500KB-1.5 MB
    case 'high':
    default:
      format = 'jpeg'; quality = 60; break;     // JPEG q60 — tinggi, ~200KB-800KB (default)
  }
  // Override kalau user set format/quality eksplisit via settings lama (kompatibilitas)
  // — TIDAK dipakai lagi, biarkan compression level yang menentukan.
  const maxHeight = Math.max(2048, Math.min(32768, settings.screenshotMaxFullHeight || 16384));
  const mode = opts.mode || 'entire';  // FireShot-style default

  // 1. Ensure content/capture.js is loaded in the tab
  try {
    await browser.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      files: ['content/capture.js']
    });
  } catch (e) {
    console.warn('[RecallFox] inject capture.js failed:', e);
    return { ok: false, error: e.message };
  }

  // 2. Invoke the capture function
  let result;
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      func: (mode, opts) => window.__RecallFoxCapture__(mode, opts),
      args: [mode, { format, quality, maxHeight }]
    });
    result = results?.[0]?.result;
  } catch (e) {
    console.warn('[RecallFox] capture invoke failed:', e);
    return { ok: false, error: e.message };
  }

  if (!result || result.cancelled || !result.dataUrl) {
    return { ok: false, error: result?.error || 'cancelled' };
  }

  return {
    ok: true,
    dataUrl: result.dataUrl,
    width: result.width,
    height: result.height,
    bytes: result.bytes,
    mode
  };
}

// Legacy compatibility wrapper
async function triggerScreenshot(tab, mode) {
  const res = await captureFullPage(tab, { mode });
  if (!res.ok) {
    try {
      await browser.tabs.sendMessage(tab.id, { type: 'SHOW_TOAST', message: 'screenshotErrCannotCapture' });
    } catch (e) {}
    return res;
  }

  // Direct save to vault (used by old context-menu flow that bypasses modal)
  let thumbnailDataUrl = '';
  try {
    thumbnailDataUrl = await generateThumbnail(res.dataUrl, 200);
  } catch (e) {
    console.warn('[RecallFox] thumbnail generation failed:', e);
  }

  const titleGuess = (tab.title || 'Screenshot').slice(0, 80);
  const modeLabel = res.mode === 'visible' ? 'Visible' : res.mode === 'entire' ? 'Full page' : 'Selection';
  const newItem = await addItem({
    type: 'screenshot',
    title: `${titleGuess} — ${modeLabel}`,
    body: `[Screenshot captured ${new Date().toISOString()} from ${tab.url}]`,
    tags: ['screenshot', res.mode],
    source: {
      url: tab.url,
      title: tab.title,
      capturedAt: new Date().toISOString()
    },
    screenshotMode: res.mode,
    screenshotWidth: res.width,
    screenshotHeight: res.height,
    screenshotFormat: res.format || (res.dataUrl.startsWith('data:image/jpeg') ? 'jpeg' : 'png'),
    screenshotBytes: res.bytes,
    thumbnailDataUrl,
    screenshotDataUrl: res.dataUrl
  });

  console.log('[RecallFox] Screenshot saved:', newItem.id, `(${res.width}×${res.height})`);

  try {
    await browser.tabs.sendMessage(tab.id, { type: 'SHOW_TOAST', message: 'screenshotSavedToast' });
  } catch (e) {}

  browser.runtime.sendMessage({ type: 'VAULT_UPDATED' }).catch(() => {});

  return { ok: true, id: newItem.id };
}

// Save a captured image to the vault (called from modal "Save to Vault" button)
async function saveCaptureToVault(payload) {
  // payload: { dataUrl, width, height, bytes, mode, url, pageTitle, title?, annotationNote? }
  // v3.20.1: title opsional dari input filename di modal capture (lebih meaningful
  //   daripada "pageTitle — modeLabel"). Kalau tidak dikirim, fallback ke default lama.
  let thumbnailDataUrl = '';
  try {
    thumbnailDataUrl = await generateThumbnail(payload.dataUrl, 200);
  } catch (e) {
    console.warn('[RecallFox] thumbnail generation failed:', e);
  }

  const titleGuess = (payload.pageTitle || 'Screenshot').slice(0, 80);
  const modeLabel = payload.mode === 'visible' ? 'Visible' : payload.mode === 'entire' ? 'Full page' : 'Selection';
  const format = payload.dataUrl.startsWith('data:image/jpeg') ? 'jpeg' : 'png';

  // v3.20.1: Pakai title dari user kalau ada; fallback ke default lama.
  const finalTitle = (payload.title && String(payload.title).trim())
    ? String(payload.title).trim().slice(0, 120)
    : `${titleGuess} — ${modeLabel}`;

  const newItem = await addItem({
    type: 'screenshot',
    title: finalTitle,
    body: `[Screenshot captured ${new Date().toISOString()} from ${payload.url}]`,
    tags: ['screenshot', payload.mode],
    source: {
      url: payload.url,
      title: payload.pageTitle,
      capturedAt: new Date().toISOString(),
      annotationNote: payload.annotationNote || ''  // v3.11.26 (Issue #2): catatan anotasi
    },
    annotationNote: payload.annotationNote || '',  // v3.11.26 (Issue #2): simpan di top-level juga
    screenshotMode: payload.mode,
    screenshotWidth: payload.width,
    screenshotHeight: payload.height,
    screenshotFormat: format,
    screenshotBytes: payload.bytes,
    thumbnailDataUrl,
    screenshotDataUrl: payload.dataUrl
  });

  browser.runtime.sendMessage({ type: 'VAULT_UPDATED' }).catch(() => {});
  // v3.11.25 (Sesi 15, Issue #2): Auto-sync ke Supabase setelah capture screenshot.
  // User feedback: "pastikan gambar yang telah di screnshot dengan menggunakan fitur
  // 'tangkap halaman' itu masuk ke supabase agar saya bisa kopi paste nantinya di
  // device manapun."
  // Sebelumnya: screenshot hanya disimpan lokal, user harus Push manual.
  // Sekarang: auto-trigger Supabase push (debounced 3s) supaya screenshot otomatis
  // masuk ke cloud + Storage bucket.
  try {
    const { triggerAutoSync } = await import('./lib/supabase-sync.js');
    triggerAutoSync();
    console.log('[RecallFox] Auto-sync triggered after screenshot save');
  } catch (e) { /* Supabase mungkin belum di-setup — silent */ }
  return { ok: true, id: newItem.id };
}

// Save a captured image to the user's Downloads folder as PDF / JPG / PNG
async function saveCaptureAs(payload) {
  // payload: { format: 'pdf'|'jpg'|'png', dataUrl, title, filename }
  const { format, dataUrl, filename } = payload;
  let blob, ext, mime;

  if (format === 'pdf') {
    const { buildPdfBlob } = await import('./lib/pdf.js');
    blob = await buildPdfBlob(dataUrl, { title: payload.title || 'RecallFox Screenshot' });
    ext = 'pdf';
    mime = 'application/pdf';
  } else if (format === 'jpg') {
    // Re-encode as JPEG if currently PNG
    if (dataUrl.startsWith('data:image/jpeg')) {
      const arr = await (await fetch(dataUrl)).arrayBuffer();
      blob = new Blob([arr], { type: 'image/jpeg' });
    } else {
      const bytes = await (await fetch(dataUrl)).arrayBuffer();
      const bitmap = await createImageBitmap(new Blob([bytes]));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0);
      blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    }
    ext = 'jpg';
    mime = 'image/jpeg';
  } else if (format === 'png') {
    // Re-encode as PNG if currently JPEG
    if (dataUrl.startsWith('data:image/png')) {
      const arr = await (await fetch(dataUrl)).arrayBuffer();
      blob = new Blob([arr], { type: 'image/png' });
    } else {
      const bytes = await (await fetch(dataUrl)).arrayBuffer();
      const bitmap = await createImageBitmap(new Blob([bytes]));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      blob = await canvas.convertToBlob({ type: 'image/png' });
    }
    ext = 'png';
    mime = 'image/png';
  } else {
    return { ok: false, error: 'unknown_format: ' + format };
  }

  // Build final filename (force correct extension)
  const safeName = (filename || `screenshot_${Date.now()}`).replace(/\.[a-z0-9]+$/i, '');
  const finalName = `${safeName}.${ext}`;

  try {
    const url = URL.createObjectURL(blob);
    const downloadId = await browser.downloads.download({
      url,
      filename: `RecallFox/${finalName}`,
      saveAs: false,
      conflictAction: 'uniquify'
    });
    // Revoke URL after a delay (download needs it to complete)
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return { ok: true, downloadId };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Generate a small thumbnail dataUrl from a full-size dataUrl.
// Returns a PNG dataUrl scaled to fit in `max`×`max` (preserving aspect).
async function generateThumbnail(dataUrl, max) {
  // OffscreenCanvas is available in Firefox 105+ and Chromium.
  // We fall back to a regular <canvas> via dynamic import if needed.
  // But background workers in MV3 don't have DOM — use OffscreenCanvas.
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  const thumbBlob = await canvas.convertToBlob({ type: 'image/png' });
  // Convert blob → dataUrl
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(thumbBlob);
  });
}

// ===== Capture visible tab (called from content/capture.js via message) =====
//
// captureVisibleTab can only be invoked from the background context.
// We accept a CAPTURE_VISIBLE_TAB message from the content script and
// return the dataUrl.

async function handleCaptureVisible(format, quality) {
  // v3.11.7-fix2 (Sesi 7): Tambah fallback JPEG → PNG.
  // User report: "gambar hanya bisa ditangkap di lossless (tanpa kompresi) jika dengan
  // kompresi error". Root cause: di beberapa halaman (CSP strict, cross-origin iframe),
  // Firefox captureVisibleTab dengan format=jpeg melempar error "Format image not supported"
  // atau "Canvas tainted". Fallback: coba JPEG dulu, kalau gagal coba PNG lossless.
  // User tetap dapat screenshot (walau ukuran lebih besar), bukan error total.
  const tryCapture = async (fmt, q) => {
    const opts = { format: fmt || 'png' };
    if (fmt === 'jpeg') opts.quality = (q || 90) / 100;
    return await browser.tabs.captureVisibleTab(undefined, opts);
  };

  try {
    const dataUrl = await tryCapture(format, quality);
    return { ok: true, dataUrl, format: format || 'png' };
  } catch (e) {
    console.error('[RecallFox] captureVisibleTab failed (format=' + format + '):', e.message);
    // v3.11.7-fix2: Kalau JPEG gagal, fallback ke PNG lossless supaya tetap dapat screenshot
    if (format === 'jpeg') {
      console.log('[RecallFox] Fallback: coba PNG lossless karena JPEG gagal...');
      try {
        const dataUrl = await tryCapture('png', 100);
        return { ok: true, dataUrl, format: 'png', fallback: true, originalError: e.message };
      } catch (e2) {
        console.error('[RecallFox] PNG fallback juga gagal:', e2.message);
        // Lanjut ke retry logic di bawah untuk rate-limit
      }
    }
    // Firefox rate-limit error: "An unexpected error occurred" — wait and retry once
    if (e.message && (e.message.includes('unexpected') || e.message.includes('rate'))) {
      console.log('[RecallFox] Retrying captureVisibleTab after rate-limit delay…');
      await new Promise(r => setTimeout(r, 500));
      try {
        const dataUrl = await tryCapture(format, quality);
        return { ok: true, dataUrl, format: format || 'png' };
      } catch (e2) {
        console.error('[RecallFox] captureVisibleTab retry failed:', e2.message);
        // Last resort: coba PNG lossless
        try {
          const dataUrl = await tryCapture('png', 100);
          return { ok: true, dataUrl, format: 'png', fallback: true };
        } catch (e3) {
          return { ok: false, error: e3.message };
        }
      }
    }
    return { ok: false, error: e.message };
  }
}

// ===== AI query orchestration =====
//
// Single entry point used by:
//   - content/selection-ai.js (floating "Tanya Si Pandai" button)
//   - context menu "rf-ask-ai" (right-click → Tanya Si Pandai)
//   - keyboard shortcut "ask-ai" (Alt+Shift+A)
//
// Flow:
//   1. Persist query in browser.storage.local under `recallfox_pending_ai_query`.
//      Sidebar reads this on init — covers the case where sidebar just opened
//      and isn't yet listening for runtime messages.
//   2. Open sidebar if it isn't already open.
//   3. Send `AI_QUERY_FROM_CONTEXT` runtime message. If sidebar was already
//      open, deliver immediately. If sidebar just opened, wait 1200ms so its
//      listener has time to register.
//   4. Sidebar clears `recallfox_pending_ai_query` once it has consumed it,
//      so we never re-fire the same query on next sidebar open.

async function routeAiQuery(text, { sourceUrl = '', sourceTitle = '' } = {}) {
  if (!text || !text.trim()) return;
  text = text.trim();

  // Always persist to storage first — this is the durable fallback in case
  // sidebar is closed or the runtime message gets lost.
  await browser.storage.local.set({
    recallfox_pending_ai_query: {
      text,
      sourceUrl,
      sourceTitle,
      ts: Date.now()
    }
  });

  let sidebarAlreadyOpen = false;
  try {
    sidebarAlreadyOpen = await browser.sidebarAction.isOpen({});
  } catch (e) {
    // isOpen() not available in older Firefox — assume closed.
  }

  if (!sidebarAlreadyOpen) {
    // Sidebar is closed — open it. Sidebar's init() will run, which calls
    // consumePendingAiQuery() at +600ms to pick up this query from storage.
    // We ALSO send the runtime message after a 1500ms delay as a backup,
    // in case isOpen({}) returned false incorrectly (sidebar actually open)
    // or in case the sidebar's init has already run and missed the storage
    // pending. The sidebar's runtime handler clears the storage pending
    // key immediately, so a duplicate fire is prevented.
    try { await browser.sidebarAction.open(); } catch (e) {
      console.warn('[RecallFox] sidebarAction.open failed:', e);
    }
  }

  // Always send the runtime message. If sidebar is open (or just opened),
  // its listener will handle it. If sidebar is closed and didn't open for
  // some reason, the storage pending will be the fallback.
  // Sidebar's handler is dedup-protected (see handleAiQueryFromContext).
  const delay = sidebarAlreadyOpen ? 0 : 1200;
  setTimeout(() => {
    try {
      browser.runtime.sendMessage({
        type: 'AI_QUERY_FROM_CONTEXT',
        text,
        sourceUrl,
        sourceTitle
      }).catch(() => {
        // No listener — that's fine, storage pending has us covered.
      });
    } catch (e) {}
  }, delay);
}

// ===== Keyboard commands listener =====
//
// Wired in manifest.json commands map. Three capture commands:
//   capture-page     → Alt+Shift+5  → full-page capture (scroll-stitch)
//   capture-area     → Alt+Shift+6  → drag-to-select area capture
//   capture-visible  → Alt+Shift+7  → current viewport only

browser.commands.onCommand.addListener(async (cmd) => {
  if (cmd === 'capture-page' || cmd === 'capture-area' || cmd === 'capture-visible') {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const mode = cmd === 'capture-area' ? 'selection'
               : cmd === 'capture-visible' ? 'visible'
               : 'entire';
    console.log('[RecallFox] Command →', cmd, '(mode:', mode + ') on tab', tab.id);
    try {
      await browser.tabs.sendMessage(tab.id, { type: 'TRIGGER_CAPTURE_FROM_POPUP', mode });
    } catch (e) {
      console.warn('[RecallFox] overlay not reachable, falling back to direct save:', e.message);
      await triggerScreenshot(tab, mode);
    }
    return;
  }

  if (cmd === 'clear-cache') {
    console.log('[RecallFox] Command → clear cache');
    const settings = await getSettings();
    const { clearBrowsingData } = await import('./lib/clearcache.js');
    const res = await clearBrowsingData({
      dataTypes: settings.clearCacheDataTypes,
      timePeriod: settings.clearCacheTimePeriod,
      currentTabOnly: settings.clearCacheCurrentTabOnly,
      reload: settings.clearCacheReload,
      notify: settings.clearCacheNotify
    });
    browser.runtime.sendMessage({
      type: 'CLEAR_CACHE_RESULT',
      result: res
    }).catch(() => {});
    return;
  }

  // === Volume control commands ===
  if (cmd === 'volume-up' || cmd === 'volume-down' || cmd === 'volume-reset') {
    const { normalizeDb, getSiteVolume, setSiteVolume, extractDomain, isRestrictedUrl } = await import('./lib/volume.js');
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || isRestrictedUrl(tab.url)) return;

    const domain = extractDomain(tab.url);
    const currentDb = await getSiteVolume(domain);
    let newDb;
    if (cmd === 'volume-up') newDb = normalizeDb(currentDb + 1);
    else if (cmd === 'volume-down') newDb = normalizeDb(currentDb - 1);
    else newDb = 0;  // reset

    await setSiteVolume(domain, newDb);
    try {
      await browser.tabs.sendMessage(tab.id, { command: 'setVolume', dB: newDb });
    } catch (e) { /* volume-cs.js might not be loaded yet */ }
    console.log('[RecallFox] Volume:', cmd, '→', newDb, 'dB for', domain);
    return;
  }

  if (cmd === 'ask-ai') {
    // Alt+Shift+A — get selected text from active tab and send to AI
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    try {
      const results = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.getSelection().toString().trim()
      });
      const text = results?.[0]?.result || '';
      if (text.length < 3) return;
      console.log('[RecallFox] Ask AI (keyboard shortcut):', text.slice(0, 80));
      await routeAiQuery(text, { sourceUrl: tab.url || '', sourceTitle: tab.title || '' });
    } catch (e) {
      console.warn('[RecallFox] Ask AI shortcut failed:', e.message);
    }
    return;
  }
});

// ===== Message router =====

let syncTimer = null;

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
  if (msg.type === 'TAPE_SAVE_TO_VAULT') {
    // v3.14.0: RecallTape — simpan tape ke vault sebagai tipe Prompt
    try {
      const { title, body, source } = msg.payload || {};
      if (!body) { sendResponse({ ok: false, error: 'empty_body' }); return; }
      const item = await addItem({
        type: 'prompt',
        title: title || 'RecallTape',
        body,
        tags: ['tape', 'calculator'],
        source: source || { kind: 'tape', savedAt: new Date().toISOString() }
      });
      console.log('[RecallFox/Tape] Saved to vault:', item.id);
      sendResponse({ ok: true, itemId: item.id });
      // Notify sender tab with toast
      try {
        await browser.tabs.sendMessage(sender.tab.id, { type: 'SHOW_TOAST', message: 'toastSaved' });
      } catch (e) {}
    } catch (e) {
      console.error('[RecallFox/Tape] Save failed:', e);
      sendResponse({ ok: false, error: e.message });
    }
    return;
  }
  if (msg.type === 'TRIGGER_SYNC') {
    // debounce 2s
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(async () => {
      try {
        const ok = await pushToSync();
        if (ok) console.log('[RecallFox] Synced to Firefox Sync');
      } catch (e) {
        console.warn('[RecallFox] Sync failed:', e);
      }
      syncTimer = null;
    }, 2000);
    // v3.11.7: Jika multi-PC auto-sync aktif, jadwalkan juga
    try {
      const settings = await getSettings();
      if (settings.syncAutoEnabled) {
        const { scheduleAutoSync } = await import('./lib/sync-profile.js');
        scheduleAutoSync();
      }
    } catch (e) { /* silent */ }
    return false;
  }
  if (msg.type === 'SYNC_NOW') {
    try {
      const ok = await pushToSync();
      sendResponse({ ok }); return;
    } catch (e) {
      sendResponse({ ok: false, error: e.message }); return;
    }
  }
  if (msg.type === 'PULL_SYNC') {
    try {
      const ok = await mergeSyncIntoLocal();
      sendResponse({ ok }); return;
    } catch (e) {
      sendResponse({ ok: false, error: e.message }); return;
    }
  }
  if (msg.type === 'GET_VAULT') {
    sendResponse(await getVault()); return;
  }
  if (msg.type === 'OPEN_SIDEBAR') {
    // Toggle sidebar: open if closed, close if open
    try {
      // Check if sidebar is open (Firefox 124+)
      let isOpen = false;
      try {
        isOpen = await browser.sidebarAction.isOpen({});
      } catch (e) {
        // isOpen() not available in older Firefox — assume closed
        console.log('[RecallFox] sidebarAction.isOpen not available, trying open()');
      }
      
      if (isOpen) {
        await browser.sidebarAction.close();
        console.log('[RecallFox] Sidebar closed');
        sendResponse({ ok: true, action: 'closed' }); return;
      } else {
        await browser.sidebarAction.open();
        console.log('[RecallFox] Sidebar opened');
        sendResponse({ ok: true, action: 'opened' }); return;
      }
    } catch (e) {
      console.error('[RecallFox] Sidebar toggle failed:', e);
      sendResponse({ ok: false, error: e.message }); return;
    }
  }
  if (msg.type === 'SAVE_SELECTION_FROM_CS') {
    // Sent from content script keyboard listener
    try {
      await addItem({
        type: 'prompt',
        title: (msg.text || '').slice(0, 60).replace(/\s+/g, ' '),
        body: msg.text,
        source: {
          url: msg.url,
          title: msg.title,
          capturedAt: new Date().toISOString()
        }
      });
      sendResponse({ ok: true }); return;
    } catch (e) {
      console.error('[RecallFox] SAVE_SELECTION_FROM_CS failed:', e);
      sendResponse({ ok: false, error: e.message }); return;
    }
  }
  if (msg.type === 'QUICK_SNAPSHOT') {
    // v3.16.1: QUICK_SNAPSHOT sekarang return conversation data ke popup (bukan buka modal di tab).
    // Popup yang handle modal preview (lebih reliable — user pasti lihat di sidebar).
    // Sebelumnya: QUICK_SNAPSHOT → OPEN_SNAPSHOT_MODAL di tab, tapi popup close terlalu cepat
    // → user tidak lihat modal → kira snapshot gagal.
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) { sendResponse({ ok: false, error: 'no_active_tab' }); return; }
    try {
      const res = await browser.tabs.sendMessage(tab.id, { type: 'EXTRACT_SNAPSHOT' });
      sendResponse(res || { ok: false, error: 'no_response' }); return;
    } catch (e) {
      // Content script not loaded — try to inject it
      try {
        await browser.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/ai-resolvers.js', 'content/content.js']
        });
        await browser.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ['content/content.css']
        });
        await new Promise(r => setTimeout(r, 500));
        const res = await browser.tabs.sendMessage(tab.id, { type: 'EXTRACT_SNAPSHOT' });
        sendResponse(res || { ok: false, error: 'no_response' }); return;
      } catch (e2) {
        sendResponse({ ok: false, error: e2.message }); return;
      }
    }
  }
  if (msg.type === 'QUICK_SAVE_SELECTION') {
    // Sent from popup quick-action button — get selection from active tab via scripting API
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) { sendResponse({ ok: false, error: 'no_active_tab' }); return; }
    if (!tab.url || !/^https?:\/\//.test(tab.url)) {
      sendResponse({ ok: false, error: 'not_http_page' }); return;
    }
    try {
      const results = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.getSelection().toString()
      });
      const text = results?.[0]?.result || '';
      if (!text.trim()) {
        sendResponse({ ok: false, error: 'no_selection' }); return;
      }
      await addItem({
        type: 'prompt',
        title: text.slice(0, 60).replace(/\s+/g, ' '),
        body: text,
        source: { url: tab.url, title: tab.title, capturedAt: new Date().toISOString() }
      });
      sendResponse({ ok: true }); return;
    } catch (e) {
      sendResponse({ ok: false, error: e.message }); return;
    }
  }
  if (msg.type === 'INJECT_TO_ACTIVE_TAB') {
    // Used by popup/sidebar when on AI domain
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) { sendResponse({ ok: false, error: 'no_active_tab' }); return; }
    try {
      const res = await browser.tabs.sendMessage(tab.id, {
        type: 'INJECT_TEXT',
        text: msg.text,
        mode: msg.mode
      });
      sendResponse(res); return;
    } catch (e) {
      sendResponse({ ok: false, error: e.message }); return;
    }
  }

  // v3.6: COPY_TO_CLIPBOARD — fallback untuk popup yang tidak punya akses clipboard
  // (mis. di window popup kecil yang navigator.clipboard undefined)
  if (msg.type === 'COPY_TO_CLIPBOARD') {
    try {
      await navigator.clipboard.writeText(msg.text || '');
      sendResponse({ ok: true }); return;
    } catch (e) {
      // Fallback: pakai content script di active tab
      try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          await browser.tabs.sendMessage(tab.id, { type: 'COPY_TEXT', text: msg.text });
          sendResponse({ ok: true }); return;
        }
      } catch (e2) {}
      sendResponse({ ok: false, error: e.message }); return;
    }
  }

  // v3.7: EXPORT_BACKUP — export vault ke file (.json atau .rfvault terenkripsi)
  if (msg.type === 'EXPORT_BACKUP') {
    try {
      const vault = await getVault();
      const shotBlobs = await exportAllScreenshotBlobs();
      const payload = { vault, screenshotBlobs: shotBlobs };
      const json = JSON.stringify(payload, null, 2);
      let content = json;
      let ext = 'json';
      if (msg.encrypted) {
        if (!msg.passphrase || msg.passphrase.length < 1) {
          sendResponse({ ok: false, error: 'passphrase_required' }); return;
        }
        content = await encryptBackup(json, msg.passphrase);
        ext = 'rfvault';
      }
      const blob = new Blob([content], { type: 'application/json' });
      const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
      const filename = 'recallfox-backup-' + ts + '.' + ext;
      // Pakai downloads API
      const url = URL.createObjectURL(blob);
      await browser.downloads.download({
        url,
        filename,
        saveAs: false  // langsung simpan ke Downloads
      });
      // Update lastBackupAt
      await saveSettings({ lastBackupAt: new Date().toISOString(), lastBackupSize: content.length });
      sendResponse({ ok: true, filename, size: content.length }); return;
    } catch (e) {
      console.error('[RecallFox] EXPORT_BACKUP error:', e);
      sendResponse({ ok: false, error: e.message }); return;
    }
  }

  // v3.7: IMPORT_BACKUP — import vault dari file backup
  if (msg.type === 'IMPORT_BACKUP') {
    try {
      const text = msg.text || '';
      if (!text) { sendResponse({ ok: false, error: 'empty_text' }); return; }
      let jsonStr;
      if (isEncryptedBackup(text)) {
        if (!msg.passphrase) { sendResponse({ ok: false, error: 'passphrase_required' }); return; }
        try {
          jsonStr = await decryptBackup(text, msg.passphrase);
        } catch (err) {
          sendResponse({ ok: false, error: err.message === 'WRONG_PASSPHRASE' ? 'Passphrase salah atau file rusak' : 'Gagal decrypt: ' + err.message }); return;
        }
      } else {
        try {
          JSON.parse(text);  // validate
          jsonStr = text;
        } catch (err) {
          sendResponse({ ok: false, error: 'File backup tidak valid' }); return;
        }
      }
      const parsed = JSON.parse(jsonStr);
      const importedVault = parsed.vault || parsed;
      if (!importedVault || !Array.isArray(importedVault.items)) {
        sendResponse({ ok: false, error: 'Format backup tidak dikenal' }); return;
      }
      // Merge: item dengan ID yang sudah ada → skip
      const currentVault = await getVault();
      const existingIds = new Set((currentVault.items || []).map(i => i.id));
      let added = 0, skipped = 0;
      for (const item of importedVault.items) {
        if (!item || !item.id) continue;
        if (existingIds.has(item.id)) {
          skipped++;
          continue;
        }
        try {
          await addItem(item);
          added++;
        } catch (e) {
          console.warn('[RecallFox] Import item gagal:', item.id, e.message);
        }
      }
      // Jangan import bundles otomatis (bisa conflict) — info saja
      console.log('[RecallFox] Import selesai: ' + added + ' added, ' + skipped + ' skipped');
      sendResponse({ ok: true, added, skipped }); return;
    } catch (e) {
      console.error('[RecallFox] IMPORT_BACKUP error:', e);
      sendResponse({ ok: false, error: e.message }); return;
    }
  }

  // v3.7: MANUAL_BACKUP_NOW — trigger backup manual ke Downloads/RecallFox/
  if (msg.type === 'MANUAL_BACKUP_NOW') {
    try {
      const { manualBackupWithTimestamp } = await import('./lib/autobackup.js');
      const result = await manualBackupWithTimestamp();
      // v3.8.1 (Issue #6): Jika gdriveAutoBackupOnLocalBackup aktif, kirim juga ke GDrive
      try {
        const s = await getSettings();
        if (s.gdriveSyncEnabled && s.gdriveAutoBackupOnLocalBackup && result?.ok) {
          // Kirim full backup async (fire-and-forget)
          (async () => {
            try {
              const { buildBackupPayload } = await import('./lib/autobackup.js');
              const payload = await buildBackupPayload();
              payload.backupType = 'manual';
              await gdriveSendFullBackup(payload);
              console.log('[RecallFox] GDrive auto-backup on local backup: OK');
            } catch (e) {
              console.warn('[RecallFox] GDrive auto-backup on local backup failed:', e.message);
            }
          })();
        }
      } catch (e) {}
      return result || { ok: true };
    } catch (e) {
      console.error('[RecallFox] MANUAL_BACKUP_NOW error:', e);
      sendResponse({ ok: false, error: e.message }); return;
    }
  }

  // ========== v3.8.1: GDrive Sync handlers (Issue #1, #2, #6) ==========
  if (msg.type === 'GDRIVE_SYNC_NOW') {
    try {
      const result = await gdriveFlushNow();
      sendResponse({ ok: true, result }); return;
    } catch (e) {
      console.error('[RecallFox] GDRIVE_SYNC_NOW error:', e);
      sendResponse({ ok: false, error: e.message }); return;
    }
  }
  if (msg.type === 'GDRIVE_FULL_BACKUP') {
    try {
      const { buildBackupPayload } = await import('./lib/autobackup.js');
      const payload = await buildBackupPayload();
      payload.backupType = 'manual';
      const result = await gdriveSendFullBackup(payload);
      // Update settings.gdriveLastSyncAt/error
      try {
        const meta = await gdriveGetMeta();
        await saveSettings({
          gdriveLastSyncAt: meta.lastSyncAt,
          gdriveLastError: meta.lastError
        });
      } catch (e) {}
      sendResponse(result); return;
    } catch (e) {
      console.error('[RecallFox] GDRIVE_FULL_BACKUP error:', e);
      sendResponse({ ok: false, error: e.message }); return;
    }
  }
  if (msg.type === 'GDRIVE_TEST') {
    try {
      const result = await gdriveTestConnection();
      sendResponse(result); return;
    } catch (e) {
      sendResponse({ ok: false, error: e.message }); return;
    }
  }
  if (msg.type === 'GDRIVE_STATUS') {
    try {
      const meta = await gdriveGetMeta();
      const queueLen = await gdriveGetQueueLength();
      sendResponse({ ok: true, meta, queueLength: queueLen }); return;
    } catch (e) {
      sendResponse({ ok: false, error: e.message }); return;
    }
  }
  if (msg.type === 'GDRIVE_CLEAR_QUEUE') {
    try {
      await gdriveClearQueue();
      sendResponse({ ok: true }); return;
    } catch (e) {
      sendResponse({ ok: false, error: e.message }); return;
    }
  }

  // ============================================================
  // v3.11.7: Multi-PC Bidirectional Sync handlers
  // ============================================================
  if (msg.type === 'SYNC_GET_PROFILES') {
    try {
      const { getSyncProfiles } = await import('./lib/sync-profile.js');
      sendResponse({ ok: true, data: await getSyncProfiles() }); return;
    } catch (e) { sendResponse({ ok: false, error: e.message }); return; }
  }
  if (msg.type === 'SYNC_ADD_PROFILE') {
    try {
      const { addSyncProfile } = await import('./lib/sync-profile.js');
      const profile = await addSyncProfile(msg.profile);
      sendResponse({ ok: true, profile }); return;
    } catch (e) { sendResponse({ ok: false, error: e.message }); return; }
  }
  if (msg.type === 'SYNC_UPDATE_PROFILE') {
    try {
      const { updateSyncProfile } = await import('./lib/sync-profile.js');
      const profile = await updateSyncProfile(msg.id, msg.patch);
      sendResponse({ ok: true, profile }); return;
    } catch (e) { sendResponse({ ok: false, error: e.message }); return; }
  }
  if (msg.type === 'SYNC_DELETE_PROFILE') {
    try {
      const { deleteSyncProfile } = await import('./lib/sync-profile.js');
      const data = await deleteSyncProfile(msg.id);
      sendResponse({ ok: true, data }); return;
    } catch (e) { sendResponse({ ok: false, error: e.message }); return; }
  }
  if (msg.type === 'SYNC_SET_ACTIVE') {
    try {
      const { setActiveProfile } = await import('./lib/sync-profile.js');
      await setActiveProfile(msg.id);
      sendResponse({ ok: true }); return;
    } catch (e) { sendResponse({ ok: false, error: e.message }); return; }
  }
  if (msg.type === 'SYNC_PUSH') {
    try {
      const { pushStateToCloud, getActiveProfile } = await import('./lib/sync-profile.js');
      const profile = msg.profileId
        ? (await import('./lib/sync-profile.js')).getSyncProfiles().then(d => d.profiles.find(p => p.id === msg.profileId))
        : await getActiveProfile();
      if (!profile) { sendResponse({ ok: false, error: 'No active profile' }); return; }
      const result = await pushStateToCloud(profile);
      sendResponse(result); return;
    } catch (e) { sendResponse({ ok: false, error: e.message }); return; }
  }
  if (msg.type === 'SYNC_PULL') {
    try {
      const { pullStateFromCloud, getActiveProfile } = await import('./lib/sync-profile.js');
      const profile = msg.profileId
        ? (await import('./lib/sync-profile.js')).getSyncProfiles().then(d => d.profiles.find(p => p.id === msg.profileId))
        : await getActiveProfile();
      if (!profile) { sendResponse({ ok: false, error: 'No active profile' }); return; }
      const result = await pullStateFromCloud(profile);
      if (result.ok) {
        // Notify semua tabs untuk refresh UI
        try {
          const tabs = await browser.tabs.query({});
          for (const t of tabs) {
            browser.tabs.sendMessage(t.id, { type: 'VAULT_UPDATED' }).catch(() => {});
          }
        } catch (e) {}
        browser.runtime.sendMessage({ type: 'VAULT_UPDATED' }).catch(() => {});
      }
      sendResponse(result); return;
    } catch (e) { sendResponse({ ok: false, error: e.message }); return; }
  }
  if (msg.type === 'SYNC_FULL') {
    try {
      const { fullSync, getActiveProfile } = await import('./lib/sync-profile.js');
      const profile = msg.profileId
        ? (await import('./lib/sync-profile.js')).getSyncProfiles().then(d => d.profiles.find(p => p.id === msg.profileId))
        : await getActiveProfile();
      if (!profile) { sendResponse({ ok: false, error: 'No active profile' }); return; }
      const result = await fullSync(profile);
      if (result.ok) {
        try {
          const tabs = await browser.tabs.query({});
          for (const t of tabs) {
            browser.tabs.sendMessage(t.id, { type: 'VAULT_UPDATED' }).catch(() => {});
          }
        } catch (e) {}
        browser.runtime.sendMessage({ type: 'VAULT_UPDATED' }).catch(() => {});
      }
      sendResponse(result); return;
    } catch (e) { sendResponse({ ok: false, error: e.message }); return; }
  }
  if (msg.type === 'SYNC_TEST_PROFILE') {
    try {
      const { testProfileConnection } = await import('./lib/sync-profile.js');
      const result = await testProfileConnection(msg.profile);
      sendResponse(result); return;
    } catch (e) { sendResponse({ ok: false, error: e.message }); return; }
  }
  if (msg.type === 'SYNC_STATUS') {
    try {
      const { getSyncStatus } = await import('./lib/sync-profile.js');
      sendResponse({ ok: true, status: await getSyncStatus() }); return;
    } catch (e) { sendResponse({ ok: false, error: e.message }); return; }
  }

  // Issue #4 fallback: GET_PAGE_CONTEXT_VIA_BG — kalau content script tidak ter-inject
  // (mis. tab about: atau halaman restricted), background inject script on-demand.
  // v3.11.11 (Sesi 10, Issue #2): FIX bug loading terus tanpa hasil.
  //   Root cause v3.11.10:
  //   (a) Di dalam browser.scripting.executeScript.func, code pakai `sendResponse(...)`
  //       — sendResponse TIDAK tersedia di context page inject (hanya di listener context).
  //       Function inject harus RETURN value, bukan call sendResponse.
  //   (b) Setelah executeScript, listener pakai `return results?.[0]?.result;` —
  //       return value dari async IIFE, BUKAN call sendResponse. Firefox expect
  //       sendResponse tapi tidak pernah dipanggil → popup loading terus.
  //   Fix:
  //   (a) Hapus sendResponse dari dalam executeScript.func — pakai return value.
  //   (b) Setelah executeScript, call sendResponse(results?.[0]?.result); return;
  if (msg.type === 'GET_PAGE_CONTEXT_VIA_BG') {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) { sendResponse({ ok: false, error: 'no_active_tab' }); return; }
      if (!tab.url || !/^https?:\/\//.test(tab.url)) {
        sendResponse({ ok: false, error: 'not_http_page', url: tab.url }); return;
      }
      const results = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: (maxLen) => {
          // v3.11.11: JANGAN pakai sendResponse di sini — return value saja.
          // Function ini di-inject ke page context, bukan listener context.
          // v3.16.0 K3: Ekstraksi halaman BERSIH — buang nav/aside/footer/script/dll.
          try {
            // Clone body, hapus elemen noise
            const bodyClone = document.body.cloneNode(true);
            const noiseSelectors = [
              'nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript',
              'iframe', 'svg', 'canvas', 'form', 'button', 'input', 'select', 'textarea',
              '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
              '[role="search"]', '[aria-hidden="true"]',
              '.nav', '.navbar', '.menu', '.sidebar', '.footer', '.header',
              '.cookie', '.banner', '.popup', '.modal', '.overlay',
              '.advertisement', '.ads', '.ad', '.sponsor',
              '.social', '.share', '.comment', '.comments',
              '.breadcrumb', '.pagination', '.related', '.recommended',
              '[class*="cookie" i]', '[class*="banner" i]', '[class*="popup" i]',
              '[class*="modal" i]', '[class*="overlay" i]', '[class*="advert" i]',
              '[id*="cookie" i]', '[id*="banner" i]', '[id*="popup" i]'
            ];
            for (const sel of noiseSelectors) {
              bodyClone.querySelectorAll(sel).forEach(el => el.remove());
            }
            const main = bodyClone.querySelector('main')
                      || bodyClone.querySelector('[role="main"]')
                      || bodyClone.querySelector('article')
                      || bodyClone;
            let text = (main?.innerText || '').trim();
            text = text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
            const metaDesc = document.querySelector('meta[name="description"]')?.content || '';
            const ogDesc = document.querySelector('meta[property="og:description"]')?.content || '';
            const desc = (metaDesc || ogDesc || '').trim();
            const sel = (window.getSelection()?.toString() || '').trim();
            if (text.length > maxLen) text = text.slice(0, maxLen) + '\n\n[... dipotong, total ' + text.length + ' char]';
            return {
              ok: true,
              text, title: document.title || '', url: location.href,
              description: desc, selection: sel,
              meta: { wordCount: text ? text.split(/\s+/).length : 0, charCount: text.length }
            };
          } catch (e) {
            return { ok: false, error: e.message };
          }
        },
        args: [msg.maxLen || 8000]
      });
      // v3.11.11: Pakai sendResponse (bukan return) supaya popup dapat response.
      const result = results?.[0]?.result || { ok: false, error: 'no_result' };
      sendResponse(result); return;
    } catch (e) {
      sendResponse({ ok: false, error: e.message }); return;
    }
  }
  // Issue #3: SAVE_UPLOADED_SCREENSHOT — simpan screenshot dari file upload/paste
  if (msg.type === 'SAVE_UPLOADED_SCREENSHOT') {
    try {
      let { title, dataUrl, source } = msg;
      if (!dataUrl) { sendResponse({ ok: false, error: 'NO_DATA_URL' }); return; }
      // Build screenshot item
      const match = dataUrl.match(/^data:(image\/[a-z]+);base64,/i);
      let fmt = match && match[1] === 'image/jpeg' ? 'jpeg' : 'png';
      // Decode untuk dapat width/height/bytes
      let width = 0, height = 0, bytes = 0;
      try {
        const base64 = dataUrl.split(',')[1];
        const binStr = atob(base64);
        bytes = binStr.length;
      } catch (e) {}

      // v3.11.7-fix (Issue #1 gap): Kompresi upload manual sesuai screenshotCompression.
      // Sebelumnya upload manual tidak dikompresi → file PNG 9MB tetap 9MB → GDrive sync gagal.
      // Sekarang kompres otomatis pakai setting yang sama dengan capture path.
      try {
        const settings = await getSettings();
        const compLevel = settings.screenshotCompression || 'high';
        let targetFormat = 'jpeg', targetQuality = 60;
        if (compLevel === 'lossless') { targetFormat = 'png'; targetQuality = 100; }
        else if (compLevel === 'low') { targetFormat = 'jpeg'; targetQuality = 90; }
        else if (compLevel === 'medium') { targetFormat = 'jpeg'; targetQuality = 75; }
        // 'high' default → jpeg q60

        // Kompres hanya kalau target lebih kecil dari source (atau format beda)
        const sourceIsPng = fmt === 'png';
        const needCompress = (targetFormat === 'jpeg') || (sourceIsPng && targetFormat === 'png' && compLevel !== 'lossless');
        // Skip kompresi kalau lossless ATAU sudah jpeg dengan quality sama/lebih rendah
        if (compLevel !== 'lossless' && needCompress) {
          const imgBlob = await (await fetch(dataUrl)).blob();
          const bitmap = await createImageBitmap(imgBlob);
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const ctx2 = canvas.getContext('2d');
          // Untuk JPEG, fill background putih dulu (JPEG tidak support transparansi)
          if (targetFormat === 'jpeg') {
            ctx2.fillStyle = '#ffffff';
            ctx2.fillRect(0, 0, canvas.width, canvas.height);
          }
          ctx2.drawImage(bitmap, 0, 0);
          const newBlob = await canvas.convertToBlob({
            type: `image/${targetFormat}`,
            quality: targetQuality / 100
          });
          // Hanya pakai hasil kompresi kalau ukurannya lebih kecil dari original
          if (newBlob.size < bytes) {
            dataUrl = await new Promise(resolve => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result);
              reader.readAsDataURL(newBlob);
            });
            fmt = targetFormat;
            bytes = newBlob.size;
            console.log(`[RecallFox] Upload manual dikompres: ${imgBlob.size} → ${newBlob.size} bytes (${compLevel})`);
          }
        }
      } catch (e) {
        console.warn('[RecallFox] Kompresi upload manual gagal (lanjut pakai original):', e.message);
      }

      // Generate thumbnail (200px) via OffscreenCanvas (background-compatible)
      let thumbnailDataUrl = '';
      try {
        const offscreen = new OffscreenCanvas(200, 200);
        const ctx = offscreen.getContext('2d');
        const imgBlob = await (await fetch(dataUrl)).blob();
        const bitmap = await createImageBitmap(imgBlob);
        // Aspect ratio preserve
        const ratio = bitmap.width / bitmap.height;
        let tw = 200, th = 200;
        if (ratio > 1) th = 200 / ratio; else tw = 200 * ratio;
        offscreen.width = Math.round(tw);
        offscreen.height = Math.round(th);
        ctx.drawImage(bitmap, 0, 0, offscreen.width, offscreen.height);
        width = bitmap.width;
        height = bitmap.height;
        const thumbBlob = await offscreen.convertToBlob({ type: 'image/png', quality: 0.85 });
        thumbnailDataUrl = await new Promise(resolve => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(thumbBlob);
        });
      } catch (e) {
        console.warn('[RecallFox] Thumbnail generation failed:', e.message);
      }
      const newItem = await addItem({
        type: 'screenshot',
        title: title || 'Screenshot Upload',
        screenshotDataUrl: dataUrl,
        screenshotMode: 'upload',
        screenshotWidth: width,
        screenshotHeight: height,
        screenshotFormat: fmt,
        screenshotBytes: bytes,
        thumbnailDataUrl,
        source: source || { kind: 'upload', url: '', title: title || 'Screenshot Upload' }
      });
      sendResponse({ ok: true, item: newItem }); return;
    } catch (e) {
      console.error('[RecallFox] SAVE_UPLOADED_SCREENSHOT error:', e);
      sendResponse({ ok: false, error: e.message }); return;
    }
  }
  if (msg.type === 'CAPTURE_VISIBLE_TAB') {
    sendResponse(await handleCaptureVisible(msg.format, msg.quality)); return;
  }
  if (msg.type === 'CLEAR_CACHE') {
    // Sent from popup/sidebar "Clear Cache" button
    // v3.20.2: Prefer msg.dataTypes + msg.timePeriod (sent by popup.js v3.20.2+).
    // Fallback ke settings (untuk backward compat dengan popup lama / shortcut keyboard).
    const settings = await getSettings();
    const { clearBrowsingData } = await import('./lib/clearcache.js');
    const dataTypes = (Array.isArray(msg.dataTypes) && msg.dataTypes.length > 0)
      ? msg.dataTypes
      : (settings.clearCacheDataTypes || ['cache']);
    const timePeriod = msg.timePeriod || settings.clearCacheTimePeriod || 'all';
    const res = await clearBrowsingData({
      dataTypes,
      timePeriod,
      currentTabOnly: settings.clearCacheCurrentTabOnly,
      reload: settings.clearCacheReload,
      notify: settings.clearCacheNotify
    });
    sendResponse(res); return;
  }
  if (msg.type === 'VOLUME_SET') {
    // Set volume for current tab's domain
    const { normalizeDb, setSiteVolume, extractDomain, isRestrictedUrl } = await import('./lib/volume.js');
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) { sendResponse({ ok: false, error: 'no_tab' }); return; }
    const domain = extractDomain(tab.url);
    const dB = normalizeDb(msg.dB);
    await setSiteVolume(domain, dB);
    try {
      await browser.tabs.sendMessage(tab.id, { command: 'setVolume', dB: dB });
    } catch (e) { /* volume-cs.js might not be loaded */ }
    sendResponse({ ok: true, dB }); return;
  }
  if (msg.type === 'VOLUME_GET') {
    // Get volume for current tab's domain
    const { getSiteVolume, extractDomain, isRestrictedUrl } = await import('./lib/volume.js');
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) { sendResponse({ ok: false, error: 'no_tab' }); return; }
    const domain = extractDomain(tab.url);
    const dB = await getSiteVolume(domain);
    sendResponse({ ok: true, dB, domain }); return;
  }
  if (msg.type === 'VOLUME_GET_STATE') {
    // Get current audio state from the active tab
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) { sendResponse({ ok: false, error: 'no_tab' }); return; }
    try {
      const res = await browser.tabs.sendMessage(tab.id, { command: 'getAudioControlState' });
      sendResponse({ ok: true, state: res?.response || { volume: 0, muted: false, mono: false } }); return;
    } catch (e) {
      sendResponse({ ok: false, error: e.message }); return;
    }
  }
  if (msg.type === 'VOLUME_MUTE') {
    // Toggle mute on active tab
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) { sendResponse({ ok: false, error: 'no_tab' }); return; }
    try {
      await browser.tabs.sendMessage(tab.id, { command: 'setMute', muted: msg.muted });
      sendResponse({ ok: true, muted: msg.muted }); return;
    } catch (e) {
      sendResponse({ ok: false, error: e.message }); return;
    }
  }
  if (msg.type === 'RESTART_BACKUP_TIMER') {
    // User changed backup interval in Settings — restart timer
    try {
      const { startBackupInterval } = await import('./lib/autobackup.js');
      await startBackupInterval();
      sendResponse({ ok: true }); return;
    } catch (e) {
      sendResponse({ ok: false, error: e.message }); return;
    }
  }
  if (msg.type === 'TOGGLE_OVERLAY') {
    // Toggle overlay button on/off + broadcast to all tabs for live update
    const settings = await getSettings();
    const newEnabled = msg.enabled !== undefined ? msg.enabled : !settings.overlayButtonEnabled;
    await saveSettings({ overlayButtonEnabled: newEnabled });
    // Broadcast to all tabs so overlay.js picks up the change live
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
      try { await browser.tabs.sendMessage(tab.id, { type: 'OVERLAY_TOGGLED' }); } catch (e) {}
    }
    console.log('[RecallFox] Overlay toggled:', newEnabled);
    sendResponse({ ok: true, enabled: newEnabled }); return;
  }

  // v3.21.0: TOGGLE_KID_MODE — OBSOLETE. Sekarang hanya thin-shim: aktifkan profil
  // Anak (strictWatch=true) sebagai profil aktif. Popup lama yang masih panggil pesan ini
  // tetap berfungsi ( Profil Anak ON, profil lain OFF ). Mode Fokus (radio) menggantikan
  // toggle ini di UI baru — lihat popup renderKontrolSitusPage & settings.js.
  if (msg.type === 'TOGGLE_KID_MODE') {
    const s = await getSettings();
    const newOn = msg.enabled !== undefined ? !!msg.enabled : !(s.contentGuardKidModeFilter === true);
    const topicProfiles = s.contentGuardTopicProfiles || seedDefaultTopicProfiles(null);
    // Cari profil dengan strictWatch=true (Profil Anak bawaan) — fallback ke profil kedua.
    const kidProfile = topicProfiles.profiles.find(p => p.strictWatch === true)
                   || topicProfiles.profiles[1]
                   || topicProfiles.profiles[0]
                   || null;
    const patch = {
      // Pertahankan kunci lama (migrasi) — value-nya now meaningless untuk filter.
      contentGuardKidModeFilter: newOn,
      contentGuardBlockShorts: newOn,
      contentGuardKidModeArmUntil: 0,
      contentGuardEnabled: newOn ? true : (s.contentGuardEnabled !== false)
    };
    if (newOn && kidProfile) {
      patch.contentGuardTopicProfiles = {
        profiles: topicProfiles.profiles,
        activeProfileId: kidProfile.id
      };
    } else if (!newOn) {
      // OFF → set profil aktif ke null (semua profil OFF) jika profil aktif saat ini
      // adalah profil anak; biarkan kalau user sedang memakai profil lain.
      const currentActiveId = topicProfiles.activeProfileId;
      if (currentActiveId && kidProfile && currentActiveId === kidProfile.id) {
        patch.contentGuardTopicProfiles = {
          profiles: topicProfiles.profiles,
          activeProfileId: null
        };
      }
    }
    await saveSettings(patch);
    console.log('[RecallFox] TOGGLE_KID_MODE (legacy shim) → activeProfileId:', newOn ? (kidProfile?.id || null) : 'unchanged');
    // Broadcast ke semua tab YouTube/X supaya re-scan
    browser.tabs.query({}).then(tabs => {
      for (const t of tabs) {
        if (t.url && /youtube\.com|youtu\.be|x\.com|twitter\.com/.test(t.url)) {
          browser.tabs.sendMessage(t.id, { type: 'CG_SETTINGS_UPDATED' }).catch(() => {});
        }
      }
    }).catch(() => {});
    sendResponse({ ok: true, enabled: newOn }); return;
  }

  // v3.7.2 (Issue 6): Toggle Block Shorts saja (tanpa YouTube Kids redirect).
  if (msg.type === 'TOGGLE_BLOCK_SHORTS') {
    const s = await getSettings();
    const newOn = msg.enabled !== undefined ? !!msg.enabled : !(s.contentGuardBlockShorts === true);
    await saveSettings({ contentGuardBlockShorts: newOn });
    console.log('[RecallFox] Block Shorts toggled:', newOn);
    sendResponse({ ok: true, enabled: newOn }); return;
  }

  if (msg.type === 'PRAYER_FETCH') {
    // Fetch prayer times for today (used by popup/sidebar Prayer tab)
    const s = await getSettings();
    if (!s.prayerEnabled) {
      sendResponse({ ok: false, error: 'not_enabled' }); return;
    }
    if (typeof s.prayerLatitude !== 'number' || typeof s.prayerLongitude !== 'number') {
      sendResponse({ ok: false, error: 'no_location' }); return;
    }

    // Check cache: refresh if missing or stale (>24h or different date)
    const cached = s.prayerCachedTimes;
    const today = new Date().toISOString().slice(0, 10);
    if (cached && cached.date === today) {
      sendResponse({ ok: true, times: cached, fromCache: true }); return;
    }

    try {
      const { fetchPrayerTimes } = await import('./lib/salahtime.js');
      const times = await fetchPrayerTimes(s.prayerLatitude, s.prayerLongitude, {
        school: s.prayerAsrSchool || 0
      });
      await saveSettings({
        prayerCachedTimes: times,
        prayerLastFetch: new Date().toISOString()
      });
      sendResponse({ ok: true, times, fromCache: false }); return;
    } catch (e) {
      sendResponse({ ok: false, error: e.message }); return;
    }
  }
  if (msg.type === 'PRAYER_GEOLOCATE') {
    // Use browser geolocation API to get device coordinates
    // Note: this needs to be triggered from a user gesture in the popup/sidebar
    // because Firefox requires user activation for geolocation prompts.
    // We do the actual getCurrentPosition in popup/sidebar; this handler is
    // only used if popup delegates to background (not recommended).
    sendResponse({ ok: false, error: 'use_popup_geolocation' }); return;
  }
  if (msg.type === 'PRAYER_REVERSE_GEOCODE') {
    // Reverse geocode coordinates to a human-readable location
    const { reverseGeocode } = await import('./lib/salahtime.js');
    try {
      const location = await reverseGeocode(msg.lat, msg.lng);
      sendResponse({ ok: true, location }); return;
    } catch (e) {
      sendResponse({ ok: false, error: e.message }); return;
    }
  }
  if (msg.type === 'PRAYER_GEOCODE') {
    // Geocode an address string to coordinates
    const { geocode } = await import('./lib/salahtime.js');
    try {
      const result = await geocode(msg.address);
      sendResponse({ ok: true, ...result }); return;
    } catch (e) {
      sendResponse({ ok: false, error: e.message }); return;
    }
  }
  if (msg.type === 'REVERSE_GEOCODE_LOCATION') {
    // v3.20.24: Reverse geocode lat/lng → address, then patch vault item's
    // source.location.address supaya badge "📍 alamat" muncul (bukan koordinat).
    // Dipanggil dari popup.js renderItemHtml kalau item punya source.location
    // dengan lat/lng tapi address kosong (mis. PWA gagal reverse geocode saat
    // capture karena Nominatim timeout, atau item lama sebelum fitur ini).
    // Fire-and-forget — popup re-render vault setelah patch sukses.
    try {
      const { reverseGeocode } = await import('./lib/salahtime.js');
      const address = await reverseGeocode(msg.lat, msg.lng);
      if (address && msg.itemId) {
        // Patch vault item: set source.location.address + source.location.capturedAt (kalau belum)
        const vault = await getVault();
        const idx = vault.items.findIndex(i => i.id === msg.itemId);
        if (idx >= 0 && vault.items[idx].source?.location) {
          vault.items[idx].source.location.address = address;
          if (!vault.items[idx].source.location.capturedAt) {
            vault.items[idx].source.location.capturedAt = new Date().toISOString();
          }
          vault.items[idx].updatedAt = new Date().toISOString();
          await saveVault(vault);
          console.log('[RecallFox] REVERSE_GEOCODE_LOCATION: patched item', msg.itemId, '→', address.slice(0, 60));
          // Notify UI untuk re-render
          browser.runtime.sendMessage({ type: 'VAULT_UPDATED' }).catch(() => {});
        }
      }
      sendResponse({ ok: true, address }); return;
    } catch (e) {
      sendResponse({ ok: false, error: e.message }); return;
    }
  }
  if (msg.type === 'CAPTURE_FOR_PREVIEW') {
// v3.20.14: Optimasi hide/restore — hanya ke tab aktif (bukan broadcast).
    // v3.20.13: hide/restore di-drive dari sini dengan try/finally.
    // Sebelumnya (v3.20.12): RF_RESTORE_AFTER_CAPTURE hanya dikirim di
    // SAVE_CAPTURE_AS / SAVE_CAPTURE_TO_VAULT. Kalau user batal di
    // mode-picker atau close result modal tanpa save → restore tidak
    // pernah dikirim → sidebar tetap hidden sampai fallback timer 30s
    // (di sidebar-cs.js v3.20.12).
    //
    // Fix: pindahkan restore ke finally block di sini. Restore SELALU
    // dikirim tidak peduli outcome capture (sukses / gagal / cancel).
    // Hapus juga timer 30s fallback di sidebar-cs.js (sudah dilakukan).
    //
    // v3.20.14: Broadcast ke semua tabs → lambat kalau user punya banyak
    // tab. Fix: hide/restore hanya ke tab aktif. Sidebar di tab lain
    // tidak ikut tercapture anyway.
    // Delay 200ms → 100ms (cukup untuk DOM update display:none).
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) { sendResponse({ ok: false, error: 'no_active_tab' }); return; }

    // v3.20.13: Hide sidebar + floater di tab aktif sebelum capture
    browser.tabs.sendMessage(tab.id, { type: 'RF_HIDE_FOR_CAPTURE' }).catch(() => {});

    // Delay supaya DOM update (display:none) ter-render sebelum capture
    await new Promise(r => setTimeout(r, 100));

    try {
      const result = await captureFullPage(tab, { mode: msg.mode || 'entire' });
      sendResponse(result);
    } finally {
      // v3.20.13/14: Restore SELALU — sukses, gagal, atau cancel.
      // v3.20.14: Hanya ke tab aktif (bukan broadcast) supaya cepat.
      // sidebar-cs.js punya fallback timer 5s kalau message ini gagal sampai.
      browser.tabs.sendMessage(tab.id, { type: 'RF_RESTORE_AFTER_CAPTURE' }).catch(() => {});
    }
    return;
  }
  if (msg.type === 'SAVE_CAPTURE_AS') {
    // v3.20.13: Restore dipindah ke finally block di CAPTURE_FOR_PREVIEW.
    // Tidak perlu kirim RF_RESTORE_AFTER_CAPTURE di sini lagi.
    sendResponse(await saveCaptureAs(msg)); return;
  }
  if (msg.type === 'SAVE_CAPTURE_TO_VAULT') {
    // v3.20.13: Restore dipindah ke finally block di CAPTURE_FOR_PREVIEW.
    // Tidak perlu kirim RF_RESTORE_AFTER_CAPTURE di sini lagi.
    sendResponse(await saveCaptureToVault(msg)); return;
  }
  if (msg.type === 'CAPTURE_SCREENSHOT') {
    // Legacy: sent from popup/sidebar quick-action button — now triggers the modal flow
    // via overlay.js in the active tab. msg.mode can be 'entire' | 'visible' | 'selection'
    // or undefined (which shows the mode-picker dialog).
    // Guard: only forward string modes; ignore accidental event objects.
    const mode = (typeof msg.mode === 'string') ? msg.mode : undefined;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) { sendResponse({ ok: false, error: 'no_active_tab' }); return; }
    try {
      await browser.tabs.sendMessage(tab.id, {
        type: 'TRIGGER_CAPTURE_FROM_POPUP',
        mode: mode  // forwarded to overlay.js -> triggerCapture(mode)
      });
      sendResponse({ ok: true, deferred: true }); return;
    } catch (e) {
      // Fallback to direct save (skips modal)
      sendResponse(await triggerScreenshot(tab, mode || 'entire')); return;
    }
  }
  if (msg.type === 'GET_SCREENSHOT_BLOB') {
    // v3.11.35: Lazy-load screenshot blob — local-first, cloud fallback.
    // Sebelumnya: hanya cari di storage.local → return null kalau tidak ada.
    //   → device B (setelah pull sync) tidak punya blob → copy/paste gagal.
    // Sekarang: kalau local null, fetch dari Supabase Storage URL (gdriveFileUrl)
    //   → cache ke storage.local → return dataUrl.
    // User audit: "Pull sync hanya transfer metadata, bukan blob gambar.
    //   Saat device lain coba copy/paste, blob lokal tidak ada → error 'no_blob'."
    try {
      const { getOrDownloadScreenshotBlob } = await import('./lib/supabase-sync.js');
      const res = await getOrDownloadScreenshotBlob(msg.id);
      sendResponse({ ok: res.ok, dataUrl: res.dataUrl, source: res.source, error: res.error });
      return;
    } catch (e) {
      console.warn('[RecallFox] GET_SCREENSHOT_BLOB failed:', e.message);
      // Fallback ke cara lama (local-only) kalau supabase-sync gagal import
      try {
        const { getScreenshotBlob } = await import('./lib/storage.js');
        const dataUrl = await getScreenshotBlob(msg.id);
        sendResponse({ ok: true, dataUrl }); return;
      } catch (e2) {
        sendResponse({ ok: false, dataUrl: null, error: e2.message }); return;
      }
    }
  }
  // v3.12.1: GET_DOCUMENT_PAGES — return metadata document (page URLs, title, dll)
  // Dipakai oleh popup/viewer.js untuk multi-page viewer.
  if (msg.type === 'GET_DOCUMENT_PAGES') {
    try {
      const { getVault } = await import('./lib/storage.js');
      const vault = await getVault();
      const item = (vault.items || []).find(i => i.id === msg.id);
      if (!item) {
        sendResponse({ ok: false, error: 'item_not_found' }); return;
      }
      if (item.type !== 'document') {
        sendResponse({ ok: false, error: 'not_a_document' }); return;
      }
      const pages = item.source?.pages || [];
      // Jika pages[0].url null tapi gdriveFileUrl ada, isi dari sana
      const pagesWithUrls = pages.map((p, i) => {
        if (p?.url) return p;
        if (i === 0 && item.gdriveFileUrl) {
          return { ...p, url: item.gdriveFileUrl };
        }
        return p;
      });
      sendResponse({
        ok: true,
        id: item.id,
        title: item.title || 'Dokumen',
        pages: pagesWithUrls,
        totalPages: pagesWithUrls.length,
        annotationNote: item.annotationNote || item.source?.annotationNote || ''
      }); return;
    } catch (e) {
      console.warn('[RecallFox] GET_DOCUMENT_PAGES failed:', e.message);
      sendResponse({ ok: false, error: e.message }); return;
    }
  }
  // v3.12.1: DOWNLOAD_URL — download arbitrary URL via browser.downloads
  // Dipakai oleh viewer.js untuk download halaman dokumen.
  if (msg.type === 'DOWNLOAD_URL') {
    try {
      const downloadId = await browser.downloads.download({
        url: msg.url,
        filename: msg.filename || 'download.bin',
        saveAs: false
      });
      sendResponse({ ok: true, downloadId }); return;
    } catch (e) {
      console.warn('[RecallFox] DOWNLOAD_URL failed:', e.message);
      sendResponse({ ok: false, error: e.message }); return;
    }
  }
  if (msg.type === 'INJECT_ANNOTATE_SCRIPT') {
    // v3.11.4: Inject content/annotate.js into the active tab on-demand.
    // Called by overlay.js when user clicks "Anotasi" in capture preview modal.
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) { sendResponse({ ok: false, error: 'no_active_tab' }); return; }
      await browser.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        files: ['content/annotate.js']
      });
      sendResponse({ ok: true }); return;
    } catch (e) {
      console.warn('[RecallFox] inject annotate.js failed:', e);
      sendResponse({ ok: false, error: e.message }); return;
    }
  }
  if (msg.type === 'DOWNLOAD_SCREENSHOT') {
    // Save full image to user's Downloads folder via browser.downloads API
    // v3.13.4: Pakai getOrDownloadScreenshotBlob (cloud fallback) bukan getScreenshotBlob (local-only).
    // v3.14.9 FIX: Konversi dataUrl → Blob → objectURL sebelum browser.downloads.download.
    //   Sebelumnya: url: dataUrl (data:image/png;base64,...) — Firefox MV3 sering
    //   render dataUrl sebagai teks di tab (full screen base64 string) alih-alih
    //   download. User report: "layar penuh teks acak yang tampak seperti encoded
    //   string (Base64)". Pattern ini sudah dipakai 4x di file ini (clipboard
    //   fallback) — sekarang konsisten.
    try {
      const { getOrDownloadScreenshotBlob } = await import('./lib/supabase-sync.js');
      const res = await getOrDownloadScreenshotBlob(msg.id);
      const dataUrl = res?.ok ? res.dataUrl : null;
      if (!dataUrl) { sendResponse({ ok: false, error: res?.error || 'no_blob' }); return; }
      const safeName = (msg.title || 'screenshot').replace(/[^a-z0-9\-_]+/gi, '_').slice(0, 60);
      const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
      const ext = msg.format === 'jpeg' ? 'jpg' : 'png';
      const mimeType = msg.format === 'jpeg' ? 'image/jpeg' : 'image/png';
      try {
        // v3.14.9: Konversi dataUrl → Blob → objectURL (pattern dari clipboard fallback line ~2361)
        const blob = new Blob([await (await fetch(dataUrl)).blob()], { type: mimeType });
        const objectUrl = URL.createObjectURL(blob);
        const id = await browser.downloads.download({
          url: objectUrl,
          filename: `RecallFox/${safeName}_${ts}.${ext}`,
          saveAs: false,
          conflictAction: 'uniquify'
        });
        // Revoke objectURL setelah 30s (cukup untuk download dimulai)
        setTimeout(() => { try { URL.revokeObjectURL(objectUrl); } catch (e) {} }, 30000);
        sendResponse({ ok: true, downloadId: id }); return;
      } catch (e) {
        console.warn('[RecallFox] DOWNLOAD_SCREENSHOT download failed:', e.message);
        sendResponse({ ok: false, error: e.message }); return;
      }
    } catch (e) {
      console.warn('[RecallFox] DOWNLOAD_SCREENSHOT exception:', e.message);
      sendResponse({ ok: false, error: e.message }); return;
    }
  }
  if (msg.type === 'COPY_SCREENSHOT_TO_CLIPBOARD') {
    // v3.11.6 (Issue 1 dari Google Doc): Salin screenshot dari Vault ke clipboard.
    // Popup/sidebar tidak bisa akses navigator.clipboard.write dengan image di Firefox
    // karena perlu user gesture di page context. Solusi: inject content script ke
    // tab aktif yang eksekusi clipboard write di context page.
    //
    // v3.11.21 FIX: Sebelumnya fungsi executeScript.func pakai sendResponse() di dalam
    // func body — tapi sendResponse adalah background context function, TIDAK BISA
    // diakses dari content script context. Akibatnya throw ReferenceError, ditangkap
    // catch, lalu diteruskan sebagai 'clipboard_write_failed'.
    // Fix: ganti sendResponse(...) ke return { ... } pattern (sama seperti
    // COPY_SCREENSHOTS_BATCH yang sudah benar di v3.11.12).
    //
    // msg: { id, withCaption: bool }
    // Returns: { ok: bool, message?: string, error?: string }
    try {
      // v3.11.35: Pakai lazy download — kalau blob lokal null, fetch dari cloud.
      const { getOrDownloadScreenshotBlob } = await import('./lib/supabase-sync.js');
      const { getVault } = await import('./lib/storage.js');
      const blobRes = await getOrDownloadScreenshotBlob(msg.id);
      const dataUrl = blobRes.dataUrl;
      if (!dataUrl) { sendResponse({ ok: false, error: blobRes.error || 'no_blob' }); return; }

      const vault = await getVault();
      const item = vault.items.find(i => i.id === msg.id);
      if (!item) { sendResponse({ ok: false, error: 'item_not_found' }); return; }

      // Build caption (URL, title, time, mode, dims) — v3.11.28: disamakan dengan format preview modal (overlay.js)
      // User feedback: "tapi kalau pakai sidebar itu jelek jelek jelek banget. banyak yang ga muncul ya kan?
      // nah standarkan dong, disamakan format kopi paste nya yang sidebar ke menjadi selengkap
      // tekan tombol gambar + keterangan di preview modal"
      const pageTitle = item.source?.title || item.title || 'screenshot';
      const pageUrl = item.source?.url || '';
      const capturedAt = item.source?.capturedAt || new Date().toISOString();
      const modeLabel = item.screenshotMode === 'visible' ? 'Viewport' : (item.screenshotMode === 'selection' ? 'Area' : 'Seluruh halaman');
      const dims = (item.screenshotWidth || 0) + '×' + (item.screenshotHeight || 0) + ' px';
      // v3.11.28: Sertakan catatan anotasi kalau ada (sama seperti overlay.js)
      const annotationNote = item.annotationNote || item.source?.annotationNote || '';
      const capturedDateStr = new Date(capturedAt).toLocaleString('id-ID', { dateStyle: 'full', timeStyle: 'short' });

      const textPlain = '📸 Screenshot — ' + pageTitle + '\n'
        + (pageUrl ? 'Sumber: ' + pageUrl + '\n' : '')
        + 'Waktu: ' + capturedDateStr + '\n'
        + 'Mode: ' + modeLabel + ' · ' + dims + '\n'
        + (annotationNote ? '📝 Catatan: ' + annotationNote + '\n' : '')
        + 'Ditangkap oleh RecallFox';

      const textHtml = '<div style="font-family:-apple-system,system-ui,sans-serif;font-size:13px;color:#1c1917">'
        + '<p style="margin:0 0 6px"><img src="' + dataUrl + '" alt="screenshot" style="max-width:100%;border-radius:8px;border:1px solid #e7e5e4"/></p>'
        + '<p style="margin:8px 0 2px"><strong>📸 ' + _escapeHtml(pageTitle) + '</strong></p>'
        + (pageUrl ? '<p style="margin:0 0 2px;color:#57534e">🔗 <a href="' + _escapeHtml(pageUrl) + '">' + _escapeHtml(pageUrl) + '</a></p>' : '')
        + '<p style="margin:0 0 2px;color:#57534e">🕒 ' + _escapeHtml(capturedDateStr) + '</p>'
        + (annotationNote ? '<p style="margin:0 0 2px;color:#92400e;background:#fef3c7;padding:4px 8px;border-radius:4px">📝 ' + _escapeHtml(annotationNote) + '</p>' : '')
        + '<p style="margin:0;color:#78716c">🔧 ' + _escapeHtml(modeLabel) + ' · ' + dims + ' · RecallFox</p>'
        + '</div>';

      // Inject clipboard writer ke tab aktif
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) { sendResponse({ ok: false, error: 'no_active_tab' }); return; }
      // Skip jika tab adalah about: atau file:// (tidak bisa inject)
      if (!tab.url || /^(about|moz-extension|chrome-extension|file):/i.test(tab.url)) {
        sendResponse({ ok: false, error: 'cannot_inject_this_page' }); return;
      }

      const results = await browser.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        func: async (dataUrl, withCaption, textPlain, textHtml) => {
          // v3.11.21 FIX: PAKAI RETURN, bukan sendResponse.
          // executeScript.func berjalan di content script context, tidak punya
          // akses ke sendResponse (background-only). Pakai return value, akan
          // diterima via results[0].result di background.
          try {
            // Konversi dataUrl → Blob
            const resp = await fetch(dataUrl);
            const blob = await resp.blob();
            // Normalisasi ke PNG supaya clipboard API support (Firefox hanya image/png)
            let pngBlob;
            if (blob.type === 'image/png') {
              pngBlob = blob;
            } else {
              // Convert JPEG/other ke PNG via canvas
              const img = await createImageBitmap(blob);
              const canvas = document.createElement('canvas');
              canvas.width = img.width;
              canvas.height = img.height;
              const ctx = canvas.getContext('2d');
              ctx.drawImage(img, 0, 0);
              pngBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            }
            if (!pngBlob) {
              return { ok: false, error: 'blob_conversion_failed' };
            }

            if (withCaption && typeof ClipboardItem !== 'undefined') {
              // Multi-mime: image/png + text/html + text/plain
              const item = new ClipboardItem({
                'image/png': pngBlob,
                'text/html': new Blob([textHtml], { type: 'text/html' }),
                'text/plain': new Blob([textPlain], { type: 'text/plain' })
              });
              await navigator.clipboard.write([item]);
              return { ok: true, message: '✓ Gambar + keterangan tersalin ke clipboard' };
            } else if (typeof ClipboardItem !== 'undefined') {
              // Image only
              const item = new ClipboardItem({ 'image/png': pngBlob });
              await navigator.clipboard.write([item]);
              return { ok: true, message: '✓ Gambar tersalin ke clipboard' };
            } else {
              // Fallback: browser.clipboard.setImageData (Firefox < 127) — ini harus
              // dilakukan di background context, bukan content script. Tapi karena
              // kita sudah di content script, return signal supaya background handle.
              return { ok: false, error: 'clipboard_item_unsupported', needsFallback: true, pngSize: pngBlob.size };
            }
          } catch (e) {
            return { ok: false, error: e.message || 'clipboard_write_failed' };
          }
        },
        args: [dataUrl, !!msg.withCaption, textPlain, textHtml]
      });

      const result = results?.[0]?.result;
      if (result && typeof result.then === 'function') {
        // Function return Promise — await di listener
        const awaited = await result;
        // v3.11.22 (Issue #1 fix): HAPUS fallback browser.clipboard.setImageData.
        // Background script di Firefox MV3 TIDAK punya browser.clipboard API.
        // Error user: "can't access property 'setImageData', browser clipboard is undefined".
        // Solusi: kalau ClipboardItem tidak support (Firefox < 127), pakai download file
        // sebagai fallback (lebih reliable daripada clipboard.setImageData).
        if (awaited?.needsFallback) {
          // v3.11.22: Download screenshot sebagai file PNG (fallback kalau clipboard tidak support)
          try {
            const blob = new Blob([await (await fetch(dataUrl)).blob()], { type: 'image/png' });
            const objectUrl = URL.createObjectURL(blob);
            const filename = 'screenshot-' + new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '') + '.png';
            await browser.downloads.download({
              url: objectUrl,
              filename: filename,
              saveAs: false
            });
            // Revoke URL after delay
            setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
            if (msg.withCaption) {
              // Copy caption ke clipboard sebagai text fallback
              try { await navigator.clipboard.writeText(textPlain); } catch (e) {}
            }
            sendResponse({ ok: true, message: '✓ Screenshot disimpan ke Downloads (clipboard tidak support di browser ini). Caption disalin ke clipboard.' }); return;
          } catch (e) {
            sendResponse({ ok: false, error: 'fallback_failed: ' + e.message }); return;
          }
        }
        sendResponse(awaited); return;
      }
      if (result && result.ok) { sendResponse(result); return; }
      // v3.11.22: Kalau clipboard write gagal tapi kita punya dataUrl, download sebagai file
      if (result && result.error && result.error.includes('clipboard')) {
        try {
          const blob = new Blob([await (await fetch(dataUrl)).blob()], { type: 'image/png' });
          const objectUrl = URL.createObjectURL(blob);
          const filename = 'screenshot-' + new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '') + '.png';
          await browser.downloads.download({
            url: objectUrl,
            filename: filename,
            saveAs: false
          });
          setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
          if (msg.withCaption) {
            try { await navigator.clipboard.writeText(textPlain); } catch (e) {}
          }
          sendResponse({ ok: true, message: '✓ Screenshot disimpan ke Downloads (clipboard write gagal, pakai file). Caption disalin.' }); return;
        } catch (e) {
          sendResponse({ ok: false, error: 'download_fallback_failed: ' + e.message }); return;
        }
      }
      sendResponse({ ok: false, error: result?.error || 'clipboard_write_failed' }); return;
    } catch (e) {
      console.warn('[RecallFox] COPY_SCREENSHOT_TO_CLIPBOARD failed:', e);
      sendResponse({ ok: false, error: e.message }); return;
    }
  }
  // v3.11.23 (Issue #1 fix): COPY_DATAURL_TO_CLIPBOARD — copy screenshot dari preview modal
  // (overlay.js) yang belum disimpan ke vault. Terima dataUrl langsung, bukan item ID.
  // Inject clipboard write ke tab aktif (page context punya user gesture + clipboard access).
  if (msg.type === 'COPY_DATAURL_TO_CLIPBOARD') {
    try {
      const { dataUrl, withCaption, textPlain, textHtml } = msg;
      if (!dataUrl) { sendResponse({ ok: false, error: 'no_dataurl' }); return; }

      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) { sendResponse({ ok: false, error: 'no_active_tab' }); return; }
      if (!tab.url || /^(about|moz-extension|chrome-extension|file):/i.test(tab.url)) {
        sendResponse({ ok: false, error: 'cannot_inject_this_page' }); return;
      }

      const results = await browser.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        func: async (dataUrl, withCaption, textPlain, textHtml) => {
          try {
            const resp = await fetch(dataUrl);
            const blob = await resp.blob();
            let pngBlob;
            if (blob.type === 'image/png') {
              pngBlob = blob;
            } else {
              const img = await createImageBitmap(blob);
              const canvas = document.createElement('canvas');
              canvas.width = img.width;
              canvas.height = img.height;
              canvas.getContext('2d').drawImage(img, 0, 0);
              pngBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            }
            if (!pngBlob) return { ok: false, error: 'blob_conversion_failed' };

            if (withCaption && typeof ClipboardItem !== 'undefined' && textPlain && textHtml) {
              const item = new ClipboardItem({
                'image/png': pngBlob,
                'text/html': new Blob([textHtml], { type: 'text/html' }),
                'text/plain': new Blob([textPlain], { type: 'text/plain' })
              });
              await navigator.clipboard.write([item]);
              return { ok: true, message: '✓ Gambar + keterangan tersalin ke clipboard' };
            } else if (typeof ClipboardItem !== 'undefined') {
              const item = new ClipboardItem({ 'image/png': pngBlob });
              await navigator.clipboard.write([item]);
              return { ok: true, message: '✓ Gambar tersalin ke clipboard' };
            } else {
              return { ok: false, error: 'ClipboardItem tidak support' };
            }
          } catch (e) {
            return { ok: false, error: e.message || 'clipboard_write_failed' };
          }
        },
        args: [dataUrl, !!withCaption, textPlain || '', textHtml || '']
      });

      const result = results?.[0]?.result;
      if (result && typeof result.then === 'function') {
        const awaited = await result;
        if (awaited?.ok) {
          sendResponse(awaited); return;
        }
        // Fallback: download file
        try {
          const blob = new Blob([await (await fetch(dataUrl)).blob()], { type: 'image/png' });
          const objectUrl = URL.createObjectURL(blob);
          const filename = 'screenshot-' + new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '') + '.png';
          await browser.downloads.download({ url: objectUrl, filename, saveAs: false });
          setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
          if (withCaption && textPlain) {
            try { await navigator.clipboard.writeText(textPlain); } catch (e) {}
          }
          sendResponse({ ok: true, message: '✓ Screenshot disimpan ke Downloads + keterangan disalin' }); return;
        } catch (e) {
          sendResponse({ ok: false, error: 'download_fallback_failed: ' + e.message }); return;
        }
      }
      if (result && result.ok) { sendResponse(result); return; }
      // Fallback: download file
      try {
        const blob = new Blob([await (await fetch(dataUrl)).blob()], { type: 'image/png' });
        const objectUrl = URL.createObjectURL(blob);
        const filename = 'screenshot-' + new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '') + '.png';
        await browser.downloads.download({ url: objectUrl, filename, saveAs: false });
        setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
        if (withCaption && textPlain) {
          try { await navigator.clipboard.writeText(textPlain); } catch (e) {}
        }
        sendResponse({ ok: true, message: '✓ Screenshot disimpan ke Downloads + keterangan disalin' }); return;
      } catch (e) {
        sendResponse({ ok: false, error: result?.error || 'clipboard_write_failed' }); return;
      }
    } catch (e) {
      console.warn('[RecallFox] COPY_DATAURL_TO_CLIPBOARD failed:', e);
      sendResponse({ ok: false, error: e.message }); return;
    }
  }
  // v3.11.11 (Issue #1): COPY_SCREENSHOTS_BATCH — copy multiple screenshot + keterangan
  // User feedback: "apakah bisa dipilih beberapa di menu ini dan kopinya sekalian baik
  // gambar maupun keterangannya sekaligus? tapi kamu pikirkan formatnya yang sangat rapih
  // sehingga ketika dipaste tu orang atau ai bacanya ngerti."
  //
  // Strategi: inject content script ke tab aktif, kirim semua dataUrl + metadata,
  // content script tulis clipboard dengan format:
  //   - text/plain: markdown rapi dengan section per screenshot
  //   - text/html: HTML dengan <img> + <h3> + <p> per screenshot
  //   - Image gambar tetap di-clipboard sebagai blob (kalau Firefox support)
  //
  // Format markdown (text/plain):
  //   # Screenshot Bundle — RecallFox
  //   Tanggal: 21 Jul 2026, 14:30 · Total: 3 screenshot
  //
  //   ## 1. Judul Screenshot 1
  //   **Sumber:** https://example.com/page1
  //   **Waktu:** Selasa, 21 Jul 2026 06:31
  //   **Mode:** Area · 648×268 px
  //   **Tag:** bug, ui
  //
  //   [Gambar 1 — lihat di clipboard gambar]
  //
  //   ---
  //
  //   ## 2. Judul Screenshot 2
  //   ...
  if (msg.type === 'COPY_SCREENSHOTS_BATCH') {
    try {
      const { ids, withCaption } = msg;
      if (!Array.isArray(ids) || ids.length === 0) {
        sendResponse({ ok: false, error: 'no_ids' }); return;
      }
      const { getScreenshotBlob, getVault } = await import('./lib/storage.js');
      const vault = await getVault();
      const screenshots = [];
      for (const id of ids) {
        const item = vault.items.find(i => i.id === id);
        if (!item || item.type !== 'screenshot') continue;
        const dataUrl = await getScreenshotBlob(id);
        if (!dataUrl) continue;
        screenshots.push({ item, dataUrl });
      }
      if (screenshots.length === 0) {
        sendResponse({ ok: false, error: 'no_valid_screenshots' }); return;
      }

      // Build markdown + HTML
      // v3.11.28: Format disamakan dengan preview modal (overlay.js) — lengkap dengan
      // 📝 Catatan anotasi, footer "Ditangkap oleh RecallFox", styling konsisten.
      // User feedback: "berlaku juga untuk batch harus sama formatnya dengan selengkap
      // tekan tombol gambar + keterangan di preview modal"
      const now = new Date();
      const dateStr = now.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
      let mdParts = [
        '# 📷 Screenshot Bundle — RecallFox',
        'Tanggal: ' + dateStr + ' · Total: ' + screenshots.length + ' screenshot',
        ''
      ];
      // v3.11.28: HTML header disamakan dengan overlay.js style
      let htmlParts = [
        '<div style="font-family:-apple-system,system-ui,sans-serif;font-size:13px;color:#1c1917">',
        '<h1 style="margin:0 0 6px">📷 Screenshot Bundle — RecallFox</h1>',
        '<p style="margin:0 0 10px;color:#57534e"><em>Tanggal: ' + escHtml(dateStr) + ' · Total: ' + screenshots.length + ' screenshot</em></p>'
      ];
      const dataUrls = []; // untuk kirim ke content script (image/png blobs)
      for (let i = 0; i < screenshots.length; i++) {
        const { item, dataUrl } = screenshots[i];
        const pageTitle = item.source?.title || item.title || 'screenshot';
        const pageUrl = item.source?.url || '';
        const capturedAt = item.source?.capturedAt || item.createdAt || now.toISOString();
        const modeLabel = item.screenshotMode === 'visible' ? 'Viewport' : (item.screenshotMode === 'selection' ? 'Area' : (item.screenshotMode === 'entire' ? 'Seluruh halaman' : '-'));
        const dims = (item.screenshotWidth || 0) + '×' + (item.screenshotHeight || 0) + ' px';
        const tags = Array.isArray(item.tags) ? item.tags.join(', ') : (item.tags || '');
        const annotationNote = item.annotationNote || item.source?.annotationNote || '';
        const capturedDate = new Date(capturedAt).toLocaleString('id-ID', { dateStyle: 'full', timeStyle: 'short' });
        const num = i + 1;
        dataUrls.push(dataUrl);

        // v3.11.28: Markdown lengkap — sama format dengan preview modal
        mdParts.push('## ' + num + '. 📸 ' + pageTitle);
        if (pageUrl) mdParts.push('Sumber: ' + pageUrl);
        mdParts.push('Waktu: ' + capturedDate);
        mdParts.push('Mode: ' + modeLabel + ' · ' + dims);
        if (tags) mdParts.push('Tag: ' + tags);
        if (annotationNote) mdParts.push('📝 Catatan: ' + annotationNote);
        mdParts.push('Ditangkap oleh RecallFox');
        mdParts.push('');
        // Placeholder saja — gambar asli ada di HTML clipboard / image/png blob
        mdParts.push('[📸 Gambar ' + num + ' — ' + dims + ']');
        mdParts.push('');
        if (i < screenshots.length - 1) mdParts.push('---');

        // v3.11.28: HTML disamakan dengan overlay.js — styling konsisten per screenshot
        if (i > 0) htmlParts.push('<hr style="border:none;border-top:1px solid #e7e5e4;margin:16px 0">');
        htmlParts.push('<p style="margin:0 0 6px"><img src="' + dataUrl + '" alt="Screenshot ' + num + '" style="max-width:100%;border-radius:8px;border:1px solid #e7e5e4"/></p>');
        htmlParts.push('<p style="margin:8px 0 2px"><strong>📸 ' + num + '. ' + escHtml(pageTitle) + '</strong></p>');
        if (pageUrl) htmlParts.push('<p style="margin:0 0 2px;color:#57534e">🔗 <a href="' + escHtml(pageUrl) + '">' + escHtml(pageUrl) + '</a></p>');
        htmlParts.push('<p style="margin:0 0 2px;color:#57534e">🕒 ' + escHtml(capturedDate) + '</p>');
        if (annotationNote) htmlParts.push('<p style="margin:0 0 2px;color:#92400e;background:#fef3c7;padding:4px 8px;border-radius:4px">📝 ' + escHtml(annotationNote) + '</p>');
        let footerLine = '🔧 ' + escHtml(modeLabel) + ' · ' + escHtml(dims);
        if (tags) footerLine += ' · ' + escHtml(tags);
        footerLine += ' · RecallFox';
        htmlParts.push('<p style="margin:0;color:#78716c">' + footerLine + '</p>');
      }
      htmlParts.push('</div>');

      const mdText = mdParts.join('\n');
      const htmlText = htmlParts.join('\n');

      // Inject content script ke tab aktif untuk write clipboard
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) { sendResponse({ ok: false, error: 'no_active_tab' }); return; }
      if (!tab.url || !/^https?:\/\//.test(tab.url)) {
        sendResponse({ ok: false, error: 'not_http_page' }); return;
      }
      // v3.11.12: Kirim dataUrls juga supaya content script bisa fetch blob untuk image/png
      const results = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: async (mdText, htmlText, withCaption, screenshotCount, dataUrls) => {
          try {
            // v3.11.12: Strategy clipboard yang lebih robust
            // 1. ClipboardItem utama: text/plain (markdown) + text/html (HTML dengan <img>)
            // 2. Kalau hanya 1 screenshot: tambah image/png blob supaya paste ke Paint jalan
            // 3. Kalau multiple: tetap cuma 1 ClipboardItem (browser limit image/png per write)

            const blobData = {
              'text/plain': new Blob([mdText], { type: 'text/plain' })
            };
            if (withCaption) {
              blobData['text/html'] = new Blob([htmlText], { type: 'text/html' });
            }

            // v3.11.12: Tambah image/png untuk screenshot pertama (supaya paste ke image editor jalan)
            // Firefox support image/png di ClipboardItem
            let imageAdded = false;
            if (dataUrls && dataUrls.length > 0) {
              try {
                // Fetch data URL jadi blob
                const response = await fetch(dataUrls[0]);
                const blob = await response.blob();
                if (blob.type.startsWith('image/')) {
                  // Convert ke PNG kalau perlu (clipboard API hanya support image/png)
                  if (blob.type === 'image/png') {
                    blobData['image/png'] = blob;
                    imageAdded = true;
                  } else {
                    // Convert JPEG/other ke PNG via canvas
                    const img = await createImageBitmap(blob);
                    const canvas = document.createElement('canvas');
                    canvas.width = img.width;
                    canvas.height = img.height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    const pngBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                    if (pngBlob) {
                      blobData['image/png'] = pngBlob;
                      imageAdded = true;
                    }
                  }
                }
              } catch (e) {
                console.warn('[RecallFox] image/png blob conversion failed:', e.message);
              }
            }

            const item = new ClipboardItem(blobData);
            await navigator.clipboard.write([item]);
            const msg = '✓ ' + screenshotCount + ' screenshot tersalin (' +
              (withCaption ? 'markdown + HTML' : 'markdown') +
              (imageAdded ? ' + gambar pertama sebagai PNG' : '') + ')';
            return { ok: true, message: msg, imageAdded };
          } catch (e) {
            return { ok: false, error: 'clipboard_write_failed: ' + e.message };
          }
        },
        args: [mdText, htmlText, withCaption, screenshots.length, dataUrls]
      });
      const result = await results?.[0]?.result;
      if (result && typeof result.then === 'function') {
        // Function return Promise — await di listener
        const awaited = await result;
        sendResponse(awaited); return;
      }
      sendResponse(result || { ok: false, error: 'no_result' }); return;
    } catch (e) {
      console.warn('[RecallFox] COPY_SCREENSHOTS_BATCH failed:', e);
      sendResponse({ ok: false, error: e.message }); return;
    }
  }
  // v3.11.13 (Sesi 12): DELETE_ITEMS_BATCH — hapus multiple item dari vault sekaligus.
  // User feedback: "sudah bagus fitur batch nya harusnya ada batch delete juga, jadi
  // bersih bersihnya gampang. apakah bisa ditambahkan?"
  // v3.11.14: Generalisasi — handle JUGA bundle (sebelumnya hanya item).
  // Pakai deleteItem/deleteBundle yang sudah ada (handle screenshot blob + bundle cleanup + GDrive sync).
  if (msg.type === 'DELETE_ITEMS_BATCH') {
    try {
      const { ids } = msg;
      if (!Array.isArray(ids) || ids.length === 0) {
        sendResponse({ ok: false, error: 'no_ids' }); return;
      }
      const { deleteItem, deleteBundle, getVault } = await import('./lib/storage.js');
      // Ambil vault sekali untuk cek apakah id adalah item atau bundle
      const vault = await getVault();
      const itemIdSet = new Set((vault.items || []).map(i => i.id));
      const bundleIdSet = new Set((vault.bundles || []).map(b => b.id));
      let deleted = 0;
      let errors = [];
      for (const id of ids) {
        try {
          if (itemIdSet.has(id)) {
            await deleteItem(id);
            deleted++;
          } else if (bundleIdSet.has(id)) {
            await deleteBundle(id);
            deleted++;
          } else {
            // Sudah tidak ada (mungkin sudah dihapus di iterasi sebelumnya)
            errors.push({ id, error: 'not_found' });
          }
        } catch (e) {
          console.warn('[RecallFox] delete failed for', id, e.message);
          errors.push({ id, error: e.message });
        }
      }
      // Trigger sync sekali setelah semua hapus (lebih efisien daripada sync per item)
      try {
        const { pushToSync } = await import('./lib/storage.js');
        await pushToSync();
      } catch (e) { /* silent — sync opsional */ }
      sendResponse({
        ok: true,
        deleted,
        failed: errors.length,
        errors: errors.length > 0 ? errors : undefined,
        message: '✓ ' + deleted + ' item dihapus' + (errors.length > 0 ? ' (' + errors.length + ' gagal)' : '')
      }); return;
    } catch (e) {
      console.warn('[RecallFox] DELETE_ITEMS_BATCH failed:', e);
      sendResponse({ ok: false, error: e.message }); return;
    }
  }
  if (msg.type === 'CAPTURE_SNAPSHOT') {
    // sent from snapshot modal in content script — save directly
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    // v3.11.10 fix: pakai sendResponse (bukan return await) supaya tidak
    // "Promised response from onMessage listener went out of scope"
    // v3.15.0 P0-S1: pass snapshotDomain + snapshotMessageCount ke addItem.
    //   Sebelumnya tidak diteruskan → storage.js addItem() tidak simpan →
    //   DB columns snapshot_domain/snapshot_message_count selalu NULL/0.
    const result = await addItem({
      type: 'snapshot',
      title: msg.title || 'Untitled snapshot',
      body: msg.body,
      tags: msg.tags || [],
      source: {
        url: msg.url || tab?.url,
        title: msg.pageTitle || tab?.title,
        capturedAt: new Date().toISOString()
      },
      snapshotDomain: msg.snapshotDomain || (msg.url ? new URL(msg.url).hostname : (tab?.url ? new URL(tab.url).hostname : '')),
      snapshotMessageCount: msg.snapshotMessageCount || msg.messageCount || 0
    });
    sendResponse(result);

    // v3.20.16: Relay Point — generate resume context via OmniRouter (silent, async).
    // Strategi AMAN: fire-and-forget setelah snapshot tersimpan. Tidak block save.
    // Body >= 100 char → trigger background generate. Kalau gagal/belum configured,
    // resumeContext = null — snapshot tetap berfungsi normal seperti sebelumnya.
    // Resume context hanya disimpan di LOCAL storage (tidak sync ke Supabase —
    // supaya TIDAK merusak cloud sync yang sudah jalan untuk schema lama).
    if (result?.ok !== false && result?.id && msg.body && msg.body.trim().length >= 100) {
      generateResumeContext(result.id, msg.body, msg.title || 'Snapshot').catch(err => {
        console.warn('[RecallFox/RelayPoint] generateResumeContext failed:', err.message);
      });
    }
    return;
  }
  if (msg.type === 'GENERATE_RESUME_CONTEXT') {
    // v3.20.16: Manual trigger dari popup — user klik "Generate Resume Context"
    // di action sheet snapshot. Berguna kalau auto-generate saat capture gagal
    // (mis. OmniRouter belum dikonfigurasi saat itu), atau user mau retry.
    const itemId = msg.itemId;
    if (!itemId) { sendResponse({ ok: false, error: 'no_item_id' }); return; }
    const vault = await getVault();
    const item = vault.items.find(i => i.id === itemId);
    if (!item || item.type !== 'snapshot') {
      sendResponse({ ok: false, error: 'item_not_found_or_not_snapshot' });
      return;
    }
    if (!item.body || item.body.trim().length < 100) {
      sendResponse({ ok: false, error: 'snapshot_body_too_short' });
      return;
    }
    try {
      const resumeContext = await generateResumeContextSync(item.body, item.title || 'Snapshot');
      if (resumeContext) {
        await updateItem(itemId, {
          resumeContext,
          resumeContextAt: new Date().toISOString()
        });
        sendResponse({ ok: true, resumeContext });
      } else {
        sendResponse({ ok: false, error: 'generate_failed' });
      }
    } catch (e) {
      console.error('[RecallFox/RelayPoint] manual generate failed:', e);
      sendResponse({ ok: false, error: e.message });
    }
    return;
  }
  if (msg.type === 'AI_ASK_QUERY') {
    // From selection-ai.js floating button. Delegate to shared orchestrator.
    const text = (msg.text || '').trim();
    if (!text) { sendResponse({ ok: false, error: 'no_text' }); return; }
    await routeAiQuery(text, {
      sourceUrl: msg.sourceUrl || '',
      sourceTitle: msg.sourceTitle || ''
    });
    sendResponse({ ok: true }); return;
  }

  // v0.9.7: Discard handlers — dipindahkan ke listener 1 karena async listener
  // intercept semua message. Kalau di listener 2, response undefined.
  if (msg.type === 'AD_DISCARD_NOW') {
    console.log('[RecallFox/AD] Manual discard triggered');
    const result = await checkAutoDiscard();
    console.log('[RecallFox/AD] Manual result:', JSON.stringify(result));
    sendResponse(result); return;
  }

  if (msg.type === 'AD_FORCE_DISCARD_ALL') {
    console.log('[RecallFox/AD] FORCE discard ALL inactive tabs');
    const result = { ok: true, discarded: 0, skipped: 0, total: 0, error: null };
    try {
      const settings = await getSettings();
      const tabs = await browser.tabs.query({});
      result.total = tabs.length;
      const activeTabs = new Set();
      const activeTabPerWindow = await browser.tabs.query({ active: true });
      activeTabPerWindow.forEach(t => activeTabs.add(t.id));

      for (const tab of tabs) {
        if (tab.discarded) { result.skipped++; continue; }
        if (activeTabs.has(tab.id)) { result.skipped++; continue; }
        if (settings.autoDiscardExcludePinned !== false && tab.pinned) { result.skipped++; continue; }
        if (settings.autoDiscardExcludeMedia !== false && tab.audible) { result.skipped++; continue; }
        try {
          console.log('[RecallFox/AD] >>> FORCE Discarding tab', tab.id, '-', (tab.title || '').slice(0, 50));
          await browser.tabs.discard(tab.id);
          result.discarded++;
        } catch (e) {
          console.warn('[RecallFox/AD] Force discard failed:', tab.id, e.message);
          result.skipped++;
        }
      }
      console.log('[RecallFox/AD] FORCE Done: discarded=' + result.discarded + ', skipped=' + result.skipped);
    } catch (e) {
      result.ok = false;
      result.error = e.message;
      console.error('[RecallFox/AD] FORCE error:', e);
    }
    sendResponse(result); return;
  }

  // v0.9.7: CG_SAVE_SETTING — juga pindahkan ke sini
  if (msg.type === 'CG_SAVE_SETTING') {
    console.log('[RecallFox/CG] Save setting:', msg.key, '=', msg.value);
    await saveSettings({ [msg.key]: msg.value });
    browser.tabs.query({}).then(tabs => {
      for (const t of tabs) {
        browser.tabs.sendMessage(t.id, { type: 'CG_SETTINGS_UPDATED' }).catch(() => {});
        browser.tabs.sendMessage(t.id, { type: 'EB_RULES_UPDATED' }).catch(() => {});
      }
    }).catch(() => {});
    sendResponse({ ok: true }); return;
  }

  // ========================================================================
  // v3.11.21: SUPABASE INTEGRATION — Auth + Sync
  // User feedback: "buatkan databasenya menggunakan suppabase untuk menyimpan
  // seluruh data yang dihasilkan di dalam addon seperti desain apps sync nya
  // aja namun versi otomatis karena ini kan pake suppabase"
  // ========================================================================

  // SUPABASE_LOGIN — login email/password
  if (msg.type === 'SUPABASE_LOGIN') {
    try {
      const { signInWithEmail } = await import('./lib/supabase-client.js');
      const res = await signInWithEmail(msg.email, msg.password);
      // v3.11.29: Start realtime sync setelah login sukses
      // v3.11.33: Also subscribe to Realtime WebSocket channel
      if (res.ok) {
        try {
          const { startRealtimeSync, subscribeRealtimeVault } = await import('./lib/supabase-sync.js');
          await startRealtimeSync();
          await subscribeRealtimeVault();
        } catch (e) { console.warn('[RecallFox] Realtime sync start failed:', e.message); }
      }
      sendResponse(res); return;
    } catch (e) {
      sendResponse({ ok: false, error: e.message }); return;
    }
  }

  // SUPABASE_SIGNUP — signup email/password baru
  if (msg.type === 'SUPABASE_SIGNUP') {
    try {
      const { signUpWithEmail } = await import('./lib/supabase-client.js');
      const res = await signUpWithEmail(msg.email, msg.password);
      // v3.11.29: Start realtime sync setelah signup sukses
      // v3.11.33: Also subscribe to Realtime WebSocket channel
      if (res.ok) {
        try {
          const { startRealtimeSync, subscribeRealtimeVault } = await import('./lib/supabase-sync.js');
          await startRealtimeSync();
          await subscribeRealtimeVault();
        } catch (e) { console.warn('[RecallFox] Realtime sync start failed:', e.message); }
      }
      sendResponse(res); return;
    } catch (e) {
      sendResponse({ ok: false, error: e.message }); return;
    }
  }

  // SUPABASE_GMAIL — login via Gmail OAuth (redirect)
  if (msg.type === 'SUPABASE_GMAIL') {
    try {
      const { signInWithGmail } = await import('./lib/supabase-client.js');
      const res = await signInWithGmail();
      sendResponse(res); return;
    } catch (e) {
      sendResponse({ ok: false, error: e.message }); return;
    }
  }

  // SUPABASE_LOGOUT
  if (msg.type === 'SUPABASE_LOGOUT') {
    try {
      // v3.11.29: Stop realtime sync sebelum logout
      try {
        const { stopRealtimeSync } = await import('./lib/supabase-sync.js');
        await stopRealtimeSync();
      } catch (e) {}
      const { signOut } = await import('./lib/supabase-client.js');
      await signOut();
      sendResponse({ ok: true }); return;
    } catch (e) {
      sendResponse({ ok: false, error: e.message }); return;
    }
  }

  // SUPABASE_STATUS — cek login status + user info
  if (msg.type === 'SUPABASE_STATUS') {
    try {
      const { getSupabaseStatus } = await import('./lib/supabase-sync.js');
      const status = await getSupabaseStatus();
      sendResponse({ ok: true, status }); return;
    } catch (e) {
      sendResponse({ ok: false, error: e.message }); return;
    }
  }

  // SUPABASE_PUSH — upload local state ke cloud
  if (msg.type === 'SUPABASE_PUSH') {
    try {
      const { pushToSupabase } = await import('./lib/supabase-sync.js');
      const res = await pushToSupabase();
      sendResponse(res); return;
    } catch (e) {
      sendResponse({ ok: false, error: e.message }); return;
    }
  }

  // SUPABASE_PULL — download cloud state ke local
  if (msg.type === 'SUPABASE_PULL') {
    try {
      // v3.13.3 (A2 fix): Pakai pullFromSupabaseV33 — variant yang filter
      // deleted_at IS NULL server-side + hapus item lokal yang sudah di-hard-delete
      // di device lain. Variant lama (pullFromSupabase) tidak ada reconciliation.
      const { pullFromSupabaseV33 } = await import('./lib/supabase-sync.js');
      const res = await pullFromSupabaseV33();
      sendResponse(res); return;
    } catch (e) {
      sendResponse({ ok: false, error: e.message }); return;
    }
  }

  // SUPABASE_FULL_SYNC — push + pull
  if (msg.type === 'SUPABASE_FULL_SYNC') {
    try {
      const { fullSync } = await import('./lib/supabase-sync.js');
      const res = await fullSync();
      sendResponse(res); return;
    } catch (e) {
      sendResponse({ ok: false, error: e.message }); return;
    }
  }

  // SUPABASE_TEST_CONNECTION — test koneksi ke project (tanpa login)
  if (msg.type === 'SUPABASE_TEST_CONNECTION') {
    try {
      const { testConnection } = await import('./lib/supabase-client.js');
      const res = await testConnection();
      sendResponse(res); return;
    } catch (e) {
      sendResponse({ ok: false, error: e.message }); return;
    }
  }

  // SUPABASE_DELETE_ITEM — hapus item dari cloud saat item lokal dihapus
  // v3.11.29: Fix — gunakan msg.itemId (bukan msg.id) supaya cocok dengan storage.js
  if (msg.type === 'SUPABASE_DELETE_ITEM') {
    try {
      const { deleteItemFromCloud } = await import('./lib/supabase-sync.js');
      const res = await deleteItemFromCloud(msg.itemId || msg.id);
      // v3.11.29: Setelah delete di cloud, trigger pull supaya device lain dapat update
      // (realtime subscription akan handle ini, tapi pull sebagai fallback)
      console.log('[RecallFox] SUPABASE_DELETE_ITEM:', msg.itemId || msg.id, '→', res.ok ? 'OK' : res.error);
      sendResponse(res); return;
    } catch (e) {
      sendResponse({ ok: false, error: e.message }); return;
    }
  }

  // SUPABASE_DELETE_NOTE — hapus note dari cloud
  // v3.11.29: Fix — gunakan msg.noteId (bukan msg.id)
  if (msg.type === 'SUPABASE_DELETE_NOTE') {
    try {
      const { deleteNoteFromCloud } = await import('./lib/supabase-sync.js');
      const res = await deleteNoteFromCloud(msg.noteId || msg.id);
      console.log('[RecallFox] SUPABASE_DELETE_NOTE:', msg.noteId || msg.id, '→', res.ok ? 'OK' : res.error);
      sendResponse(res); return;
    } catch (e) {
      sendResponse({ ok: false, error: e.message }); return;
    }
  }

  // SUPABASE_AUTO_SYNC — trigger push debounced (dipanggil otomatis saat vault berubah)
  // v3.11.29: Sekaligus trigger pull setelah push (untuk realtime sync)
  if (msg.type === 'SUPABASE_AUTO_SYNC') {
    try {
      const { triggerAutoSync } = await import('./lib/supabase-sync.js');
      triggerAutoSync();
      sendResponse({ ok: true }); return;
    } catch (e) {
      sendResponse({ ok: false, error: e.message }); return;
    }
  }

  // SUPABASE_OAUTH_CALLBACK — handle redirect dari Gmail OAuth (parse token dari URL hash)
  if (msg.type === 'SUPABASE_OAUTH_CALLBACK') {
    try {
      const { handleOAuthCallback } = await import('./lib/supabase-client.js');
      const res = await handleOAuthCallback();
      sendResponse(res || { ok: false, error: 'no_callback_data' }); return;
    } catch (e) {
      sendResponse({ ok: false, error: e.message }); return;
    }
  }

  })();
  return true;
});

// ===== Listen to sync changes (from other devices) =====

onSyncChange(async () => {
  console.log('[RecallFox] Sync change detected, merging...');
  try {
    await mergeSyncIntoLocal();
    // notify any open popups/sidebars to refresh
    browser.runtime.sendMessage({ type: 'VAULT_UPDATED' }).catch(() => {});
  } catch (e) {
    console.warn('[RecallFox] Merge failed:', e);
  }
});

// Also listen to local changes (so popup & sidebar stay in sync)
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.recallfox_vault) {
    browser.runtime.sendMessage({ type: 'VAULT_UPDATED' }).catch(() => {});
  }
});

console.log('[RecallFox] background script loaded');

// ===== Prayer reminder checker =====
//
// Runs every 60 seconds. Checks if next prayer is within
// settings.prayerReminderMinutes (default 10). If yes, AND we haven't
// notified for this prayer yet today, send a browser notification.
//
// Tracking key: `<date>-<prayerName>` stored in settings.prayerLastReminderKey.
// Resets daily (key includes date).

let prayerReminderTimer = null;

function startPrayerReminderChecker() {
  if (prayerReminderTimer) clearInterval(prayerReminderTimer);
  // Run every 60 seconds
  prayerReminderTimer = setInterval(checkPrayerReminder, 60000);
  // Also run once shortly after startup
  setTimeout(checkPrayerReminder, 5000);
// Start badge updater too (same interval is fine)
  setTimeout(updatePrayerBadge, 8000);
  // Start exercise reminder checker
  setTimeout(checkExerciseReminder, 10000);
  setInterval(checkExerciseReminder, 60000);
  console.log('[RecallFox] Prayer reminder checker started');
}

async function checkPrayerReminder() {
  try {
    const settings = await getSettings();
    if (!settings.prayerEnabled || !settings.prayerReminderEnabled) {
      updatePrayerBadge();
      return;
    }
    if (typeof settings.prayerLatitude !== 'number') return;

    let times = settings.prayerCachedTimes;
    const today = new Date().toISOString().slice(0, 10);
    if (!times || times.date !== today) {
      try {
        const { fetchPrayerTimes } = await import('./lib/salahtime.js');
        times = await fetchPrayerTimes(settings.prayerLatitude, settings.prayerLongitude, {
          school: settings.prayerAsrSchool || 0
        });
        await saveSettings({
          prayerCachedTimes: times,
          prayerLastFetch: new Date().toISOString()
        });
      } catch (e) {
        console.warn('[RecallFox] Reminder: failed to fetch prayer times:', e.message);
        return;
      }
    }

    const { getNextPrayer, formatCountdown } = await import('./lib/salahtime.js');
    const next = getNextPrayer(times.timings);
    if (!next) return;

    // === Puasa sunnah H-1 notification ===
    try {
      const { getSunnahFastTomorrow, parseHijriString } = await import('./lib/islamicCalendar.js');
      // Use robust parser (handles diacritics + English month name aliases)
      const hijriObj = times.hijri ? parseHijriString(times.hijri) : null;
      if (hijriObj) {
        const tomorrowFast = getSunnahFastTomorrow(hijriObj);
        if (tomorrowFast) {
          const fastKey = `${times.date}-fast-${tomorrowFast.name}`;
          if (settings.prayerLastReminderKey !== fastKey) {
            // Only send once per day (check if key starts with today's date)
            const lastKey = settings.prayerLastReminderKey || '';
            if (!lastKey.startsWith(times.date + '-fast-')) {
              try {
                await browser.notifications.create({
                  type: 'basic',
                  title: `${tomorrowFast.emoji} Besok Puasa ${tomorrowFast.name}`,
                  message: tomorrowFast.desc,
                  iconUrl: browser.runtime.getURL('icons/icon-96.svg'),
                  priority: 2
                });
                console.log('[RecallFox] Fast reminder sent:', tomorrowFast.name);
                await saveSettings({ prayerLastReminderKey: fastKey });
              } catch (e) {}
            }
          }
        }
      }
    } catch (e) {
      console.warn('[RecallFox] Fast reminder check failed:', e.message);
    }

    // === Prayer reminder (existing) ===
    const reminderMinutes = settings.prayerReminderMinutes || 10;
    if (next.minutesUntil > reminderMinutes) {
      updatePrayerBadge();
      return;
    }

    const reminderKey = `${times.date}-${next.name}`;
    if (settings.prayerLastReminderKey === reminderKey) {
      updatePrayerBadge();
      return;
    }

    const remaining = formatCountdown(next.minutesUntil);
    const dayLabel = next.isToday ? 'hari ini' : 'besok';
    const message = `${next.name} ${dayLabel} ${next.time} — masuk dalam ${remaining}`;

    try {
      await browser.notifications.create({
        type: 'basic',
        title: `🕌 ${next.name} segera masuk`,
        message,
        iconUrl: browser.runtime.getURL('icons/icon-96.svg'),
        priority: 2
      });
      console.log('[RecallFox] Prayer reminder sent:', message);
    } catch (e) {
      console.warn('[RecallFox] Reminder notification failed:', e.message);
    }

    // v3.11.7-fix (Issue #6): Adzan sound saat masuk waktu sholat (0-1 menit sisa).
    // Cek terpisah dari reminder notification — adzan bisa ON walau reminder OFF.
    try {
      const adzanEnabled = settings.prayerAdzanEnabled === true;
      if (adzanEnabled && next.minutesUntil <= 1 && next.minutesUntil >= 0) {
        const adzanKey = `${times.date}-${next.name}-adzan`;
        const adzanLastKey = settings.prayerAdzanLastPlayedKey || '';
        // Cek apakah prayer ini termasuk yang harus bunyi adzan
        const adzanPrayers = Array.isArray(settings.prayerAdzanPrayers) && settings.prayerAdzanPrayers.length > 0
          ? settings.prayerAdzanPrayers
          : ['Fajr','Dhuhr','Asr','Maghrib','Isha'];
        // next.name sudah dalam format Indonesia: Subuh/Dzuhur/Ashar/Magrib/Isya
        // Map ke key Fajr/Dhuhr/Asr/Maghrib/Isha
        const prayerKeyMap = { 'Subuh':'Fajr', 'Dzuhur':'Dhuhr', 'Ashar':'Asr', 'Magrib':'Maghrib', 'Isya':'Isha' };
        const prayerKey = prayerKeyMap[next.name] || next.name;
        if (adzanPrayers.includes(prayerKey) && adzanLastKey !== adzanKey) {
          // v3.11.7-fix2 (Sesi 7, Issue #5): Adzan tidak berfungsi karena sendMessage
          // ke popup hanya sampai kalau popup terbuka. Fix: kirim ke CONTENT SCRIPT
          // tab aktif (yang selalu ada kalau user browsing) + kirim ke popup juga
          // sebagai fallback. Content script mainkan audio di context page.
          try {
            const adzanPayload = {
              type: 'PLAY_ADZAN',
              prayer: next.name,
              prayerKey: prayerKey,
              volume: settings.prayerAdzanVolume ?? 0.7,
              sound: settings.prayerAdzanSound || 'default',
              customUrl: settings.prayerAdzanCustomUrl || ''
            };
            // Strategy 1: kirim ke content script tab aktif (paling reliable)
            let played = false;
            try {
              const activeTabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
              for (const at of activeTabs) {
                if (!at.url || !/^https?:\/\//.test(at.url)) continue;
                if (/^(about:|moz-extension:|chrome:|file:)/.test(at.url)) continue;
                try {
                  const r = await browser.tabs.sendMessage(at.id, adzanPayload);
                  if (r?.ok) { played = true; break; }
                } catch (e) { /* tab mungkin tidak punya content script — skip */ }
              }
            } catch (e) {
              console.warn('[RecallFox] Adzan ke active tab failed:', e.message);
            }
            // Strategy 2: fallback — kirim ke popup/sidebar (kalau terbuka)
            if (!played) {
              try {
                await browser.runtime.sendMessage(adzanPayload).catch(() => {});
              } catch (e) { /* popup mungkin tidak aktif — silent */ }
            }
            // Strategy 3: tampilkan notifikasi browser sebagai fallback terakhir
            // supaya user tahu adzan masuk walau audio tidak bunyi
            if (!played) {
              try {
                await browser.notifications.create({
                  type: 'basic',
                  title: '🕌 ' + next.name + ' telah masuk',
                  message: 'Adzan tidak bisa diputar otomatis (popup tertutup & tab aktif tidak kompatibel). Buka RecallFox untuk test adzan manual.',
                  iconUrl: browser.runtime.getURL('icons/icon-96.svg'),
                  priority: 2
                });
              } catch (e) {}
            }
            console.log('[RecallFox] Adzan broadcasted for', next.name, '(played=' + played + ')');
            await saveSettings({ prayerAdzanLastPlayedKey: adzanKey });
          } catch (e) {
            console.warn('[RecallFox] Adzan broadcast failed:', e.message);
          }
        }
      }
    } catch (e) {
      console.warn('[RecallFox] Adzan trigger failed:', e.message);
    }

    await saveSettings({ prayerLastReminderKey: reminderKey });
    updatePrayerBadge();
  } catch (e) {
    console.warn('[RecallFox] Prayer reminder check failed:', e.message);
  }
}

// ===== Prayer badge updater (toolbar icon) =====
//
// Updates:
//   - browser.action.setBadgeText: countdown singkat (maks 4 char)
//       "15m"  — sisa menit (jika <60 menit)
//       "2j"   — sisa jam (jika >=60 menit)
//       "NOW"  — sedang masuk waktu shalat (0-2 menit)
//       ""     — kosong (tidak ada data / fitur mati)
//   - browser.action.setBadgeBackgroundColor:
//       hijau  — countdown normal
//       merah  — NOW (waktu shalat masuk)
//       abu-abu — tidak ada data
//   - browser.action.setTitle: "🕌 {name} {time} (-{countdown}) | RecallFox Vault"

async function updatePrayerBadge() {
  try {
    const settings = await getSettings();

    // If prayer feature or badge is disabled → clear badge
    if (!settings.prayerEnabled || !settings.prayerShowBadge) {
      try {
        browser.action?.setBadgeText({ text: '' });
        browser.browserAction?.setBadgeText({ text: '' });
      } catch (e) {}
      return;
    }

    if (typeof settings.prayerLatitude !== 'number') {
      try {
        browser.action?.setBadgeText({ text: '' });
        browser.browserAction?.setBadgeText({ text: '' });
      } catch (e) {}
      return;
    }

    // Get cached prayer times (don't fetch here — that's reminder checker's job)
    const times = settings.prayerCachedTimes;
    if (!times || !times.timings) {
      try {
        browser.action?.setBadgeText({ text: '' });
        browser.browserAction?.setBadgeText({ text: '' });
      } catch (e) {}
      return;
    }

    const { getNextPrayer, formatCountdown } = await import('./lib/salahtime.js');
    const next = getNextPrayer(times.timings);
    if (!next) {
      try {
        browser.action?.setBadgeText({ text: '' });
        browser.browserAction?.setBadgeText({ text: '' });
      } catch (e) {}
      return;
    }

    // Format badge text (max 4 chars)
    let badgeText = '';
    let badgeColor = '#10b981';

    if (next.minutesUntil <= 2) {
      badgeText = 'NOW';
      badgeColor = '#dc2626';
    } else if (next.minutesUntil < 60) {
      badgeText = `${next.minutesUntil}m`;
      badgeColor = next.minutesUntil < 10 ? '#f59e0b' : '#10b981';
    } else {
      const hours = Math.floor(next.minutesUntil / 60);
      badgeText = `${hours}j`;
      badgeColor = '#6b7280';
    }

    const countdown = formatCountdown(next.minutesUntil);
    const dayLabel = next.isToday ? 'hari ini' : 'besok';
    const title = `🕌 ${next.name} ${next.time} (-${countdown}, ${dayLabel}) | RecallFox Vault`;

    try {
      if (browser.action) {
        browser.action.setBadgeText({ text: badgeText });
        browser.action.setBadgeBackgroundColor({ color: badgeColor });
        browser.action.setTitle({ title });
      } else if (browser.browserAction) {
        browser.browserAction.setBadgeText({ text: badgeText });
        browser.browserAction.setBadgeBackgroundColor({ color: badgeColor });
        browser.browserAction.setTitle({ title });
      }
    } catch (e) {
      console.warn('[RecallFox] Badge update failed:', e.message);
    }
  } catch (e) {
    console.warn('[RecallFox] updatePrayerBadge failed:', e.message);
  }
}

// ===== Exercise / Movement reminder checker =====

async function checkExerciseReminder() {
  try {
    const settings = await getSettings();
    if (!settings.exerciseEnabled) return;

    // v0.8.41: Cek hari olahraga — kalau hari ini bukan hari treadmill, skip
    const today = new Date().getDay();  // 0=Minggu, 1=Senin, ... 6=Sabtu
    const exerciseDays = Array.isArray(settings.exerciseDays) ? settings.exerciseDays : [1,3,5];
    if (!exerciseDays.includes(today)) return;

    // v0.8.42: Mode waktu spesifik — kalau exerciseReminderTime diisi, cek jam
    if (settings.exerciseReminderTime) {
      const reminderTime = settings.exerciseReminderTime;
      const now = new Date();
      const [targetH, targetM] = reminderTime.split(':').map(n => parseInt(n, 10));
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const targetMin = targetH * 60 + targetM;
      // Hanya fire kalau sekarang sudah lewat waktu target (dalam window 30 menit)
      if (nowMin < targetMin || nowMin > targetMin + 30) return;
      // Cek apakah sudah pernah reminder hari ini
      const todayStr = now.toISOString().slice(0, 10);
      const reminderKey = `${todayStr}-exercise-time`;
      if (settings.exerciseLastReminderKey === reminderKey) return;
      // Set reminder key supaya tidak double-fire
      await saveSettings({ exerciseLastReminderKey: reminderKey });
    } else {
      // Mode interval (lama)
      const { isExerciseTime } = await import('./lib/habits.js');
      if (!isExerciseTime(settings)) return;
    }

    // === Smart context check: don't interrupt meetings/calls ===
    // If user is on Zoom, Google Meet, Microsoft Teams, or Webex tab,
    // auto-snooze exercise reminder for 15 minutes (meeting assumed ongoing).
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const activeUrl = tabs?.[0]?.url || '';
      const meetingPatterns = [
        'meet.google.com', 'zoom.us', 'teams.microsoft.com',
        'webex.com', 'whereby.com', 'jitsi.org', 'meet.jit.si',
        'discord.com/channels/',  // voice/video call channel
        'slack.com/call/'
      ];
      const isOnMeeting = meetingPatterns.some(p => activeUrl.includes(p));
      if (isOnMeeting) {
        // Auto-snooze 15 minutes — don't interrupt the meeting
        const snoozeUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        await saveSettings({
          exerciseSnoozeUntil: snoozeUntil,
          exerciseLastReminderAt: new Date().toISOString()  // reset timer so it doesn't immediately refire
        });
        console.log('[RecallFox] Exercise reminder auto-snoozed (meeting detected):', activeUrl);
        return;
      }
    } catch (e) {
      // If we can't check tabs, fire the reminder anyway
      console.warn('[RecallFox] Could not check active tab for meeting detection:', e.message);
    }

    // === Smart context: skip if user is on AI tool with active session ===
    // Don't interrupt while user is mid-conversation with AI (chat.z.ai, ChatGPT, etc.)
    // Detection: if there's a textarea with content, assume active session
    // (We can't read page content from background, so this is best-effort via URL heuristics)
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const activeUrl = tabs?.[0]?.url || '';
      // v3.16.2: Cek AI page via isAIPageFromOrigin (dynamic dari storage.aiSites)
      let isOnAI = false;
      try {
        const { isAIPageFromOrigin } = await import('./lib/ai-detect.js');
        isOnAI = await isAIPageFromOrigin(activeUrl);
      } catch (e) {
        // Fallback: kalau ai-detect.js gagal load, anggap bukan AI
        isOnAI = false;
      }
      // Don't fully skip on AI tool (user might benefit from stretch break),
      // but lower priority notification (priority 0 instead of 1) so it's less intrusive
      const priority = isOnAI ? 0 : 1;

      // Fire notification
      const interval = settings.exerciseIntervalMinutes || 45;
      try {
        await browser.notifications.create({
          type: 'basic',
          title: '🏃 Waktunya Berdiri & Gerak!',
          message: isOnAI
            ? `Sudah ${interval} menit. Sambil nunggu AI jawab, berdiri 5 menit + regangkan badan. Baik untuk punggung & mata.`
            : `Sudah ${interval} menit duduk. Berdiri 5 menit, regangkan badan, lihat jauh ke depan. Baik untuk punggung & mata.`,
          iconUrl: browser.runtime.getURL('icons/icon-96.svg'),
          priority
        });
        console.log('[RecallFox] Exercise reminder sent (smart mode, AI tab:', isOnAI, ')');
      } catch (e) {
        console.warn('[RecallFox] Exercise notification failed:', e.message);
      }
    } catch (e) {
      console.warn('[RecallFox] Smart exercise check failed:', e.message);
    }

    // Update lastReminderAt (but don't set snooze — let it fire again if user doesn't act)
    await saveSettings({ exerciseLastReminderAt: new Date().toISOString() });
  } catch (e) {
    console.warn('[RecallFox] Exercise check failed:', e.message);
  }
}

// ===== v0.8.44: Auto Tab Discard — hemat memory dengan discard tab inactive =====
// v0.9.1: FIX BUGS — check interval lebih cepat, fallback lastAccessed, minTabs default 1, log verbose

// Track last active time per tab
const tabLastActiveMap = new Map();  // tabId → timestamp

// Update last active saat tab diaktifkan
browser.tabs.onActivated.addListener((activeInfo) => {
  tabLastActiveMap.set(activeInfo.tabId, Date.now());
  console.log('[RecallFox/AD] Tab activated:', activeInfo.tabId, 'at', new Date().toLocaleTimeString());
});

// v0.9.1: Juga track saat tab di-update (navigasi)
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    tabLastActiveMap.set(tabId, Date.now());
  }
});

// Cek & discard tab yang sudah idle terlalu lama
// v0.9.3: Return result object { ok, discarded, skipped, total, error }
async function checkAutoDiscard() {
  const result = { ok: true, discarded: 0, skipped: 0, total: 0, error: null };
  try {
    const settings = await getSettings();
    if (settings.autoDiscardEnabled === false) {
      console.log('[RecallFox/AD] Disabled, skip');
      result.error = 'Disabled';
      return result;
    }

    // v0.9.1: Parse interval ke number (select value bisa string)
    const intervalMin = parseInt(settings.autoDiscardInterval, 10) || 30;
    const intervalMs = intervalMin * 60 * 1000;
    const now = Date.now();
    const minTabs = parseInt(settings.autoDiscardMinTabs, 10) || 1;

    // Get all tabs
    const tabs = await browser.tabs.query({});
    result.total = tabs.length;
    console.log('[RecallFox/AD] Check: tabs=' + tabs.length + ', minTabs=' + minTabs + ', interval=' + intervalMin + 'min');

    if (tabs.length < minTabs) {
      console.log('[RecallFox/AD] Too few tabs (' + tabs.length + '<' + minTabs + '), skip');
      result.error = 'Too few tabs (' + tabs.length + ' < ' + minTabs + ')';
      return result;
    }

    // Get active tab IDs (per window)
    const activeTabs = new Set();
    const activeTabPerWindow = await browser.tabs.query({ active: true });
    activeTabPerWindow.forEach(t => activeTabs.add(t.id));

    for (const tab of tabs) {
      // Skip already discarded
      if (tab.discarded) { result.skipped++; continue; }

      // Skip active tab
      if (settings.autoDiscardExcludeActive !== false && activeTabs.has(tab.id)) {
        result.skipped++;
        continue;
      }

      // Skip pinned
      if (settings.autoDiscardExcludePinned !== false && tab.pinned) {
        result.skipped++;
        continue;
      }

      // Skip tabs playing audio/video
      if (settings.autoDiscardExcludeMedia !== false && tab.audible) {
        result.skipped++;
        continue;
      }

      // Check last active time
      const lastActive = tabLastActiveMap.get(tab.id) || tab.lastAccessed || 0;
      const idleTime = now - lastActive;
      const idleMin = Math.round(idleTime / 60000);
      console.log('[RecallFox/AD] Tab', tab.id, '- idle:', idleMin, 'min (need:', intervalMin, 'min) -', (tab.title || '').slice(0, 40));

      if (idleTime < intervalMs) {
        result.skipped++;
        continue;
      }

      // Check excluded domains
      if (settings.autoDiscardExcludedDomains && settings.autoDiscardExcludedDomains.length > 0) {
        try {
          const host = new URL(tab.url || '').hostname.toLowerCase();
          const isExcluded = settings.autoDiscardExcludedDomains.some(d => {
            const dd = d.toLowerCase().trim();
            return host === dd || host.endsWith('.' + dd);
          });
          if (isExcluded) {
            result.skipped++;
            continue;
          }
        } catch (e) {}
      }

      // Discard the tab
      try {
        console.log('[RecallFox/AD] >>> Discarding tab', tab.id, '-', (tab.title || '').slice(0, 50));
        await browser.tabs.discard(tab.id);
        result.discarded++;
        console.log('[RecallFox/AD] >>> Discarded OK:', tab.id);
      } catch (e) {
        console.warn('[RecallFox/AD] Discard failed for tab', tab.id, ':', e.message);
        result.skipped++;
      }
    }

    console.log('[RecallFox/AD] Done: discarded=' + result.discarded + ', skipped=' + result.skipped + ', total=' + result.total);
  } catch (e) {
    console.warn('[RecallFox/AD] Check failed:', e.message, e.stack);
    result.ok = false;
    result.error = e.message;
  }
  return result;
}

// v0.9.2: Start auto discard checker — pakai browser.alarms (reliable di module background)
// v0.9.1 bug: setInterval tidak reliable di module background, alarms API lebih tepat
function startAutoDiscardChecker() {
  console.log('[RecallFox/AD] Starting checker via browser.alarms (every 30s)');
  // Buat alarm yang fire setiap 1 menit (minimum period di Firefox)
  try {
    browser.alarms.create('rf-auto-discard', { periodInMinutes: 1 });
  } catch (e) {
    console.warn('[RecallFox/AD] Failed to create alarm, fallback to setInterval:', e.message);
    // Fallback: setInterval (kurang reliable tapi better than nothing)
    setInterval(() => {
      checkAutoDiscard().catch(e => console.warn('[RecallFox/AD] Error:', e.message));
    }, 30 * 1000);
  }
  // Initial check setelah 5 detik
  setTimeout(() => {
    console.log('[RecallFox/AD] Initial check after 5s');
    checkAutoDiscard().catch(() => {});
  }, 5000);
}

// v0.9.2: Alarm listener — ini yang benar-benar trigger checkAutoDiscard
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'rf-auto-discard') {
    checkAutoDiscard().catch(e => {
      console.warn('[RecallFox/AD] Alarm check error:', e.message);
    });
  }
  // v3.11.30: Realtime sync alarm — pull dari Supabase kalau ada perubahan
  if (alarm.name === 'rf-supabase-realtime') {
    console.log('[RecallFox] Realtime alarm fired');
    import('./lib/supabase-sync.js').then(({ handleRealtimeAlarm }) => {
      handleRealtimeAlarm().catch(e => {
        console.warn('[RecallFox/Supabase] Realtime alarm handler error:', e.message);
      });
    }).catch(() => {});
  }
  // v3.20.27: Proactive token refresh — keep session alive
  if (alarm.name === 'rf-supabase-refresh') {
    console.log('[RecallFox/Supabase] Proactive refresh alarm fired');
    import('./lib/supabase-client.js').then(({ proactiveRefresh }) => {
      proactiveRefresh().catch(e => {
        console.warn('[RecallFox/Supabase] Proactive refresh error:', e.message);
      });
    }).catch(() => {});
  }
});

// v0.9.2: PANGGIL DI TOP LEVEL — supaya jalan setiap kali background script load,
// bukan hanya saat onInstalled/onStartup fire
startAutoDiscardChecker();

// v3.20.27: Proactive Supabase token refresh — keep session alive indefinitely.
// Industry standard: refresh access_token BEFORE it expires (1 hour lifetime),
// so refresh_token gets rotated and its expiry gets extended. Without this,
// user gets logged out after ~1 day of inactivity (refresh_token expires).
//
// Alarm fires every 45 minutes. getSession() inside proactiveRefresh() will
// check if token is within 5-min window of expiry and refresh if needed.
// If user isn't logged in, proactiveRefresh returns false (no-op).
function startProactiveTokenRefresh() {
  console.log('[RecallFox/Supabase] Starting proactive token refresh alarm (every 45 min)');
  try {
    browser.alarms.create('rf-supabase-refresh', { periodInMinutes: 45 });
  } catch (e) {
    console.warn('[RecallFox/Supabase] Failed to create refresh alarm:', e.message);
  }
}
startProactiveTokenRefresh();

// ===== Ngaji / Quran reminder =====

async function checkQuranReminder() {
  try {
    const settings = await getSettings();
    if (!settings.quranEnabled) return;

    // v0.8.41: Cek hari ngaji — kalau hari ini bukan hari ngaji, skip
    const todayDay = new Date().getDay();  // 0=Minggu, 1=Senin, ... 6=Sabtu
    const quranDays = Array.isArray(settings.quranDays) ? settings.quranDays : [0,1,2,3,4,5,6];
    if (!quranDays.includes(todayDay)) return;

    const today = new Date().toISOString().slice(0, 10);
    const reminderKey = `${today}-quran`;
    if (settings.quranLastReminderKey === reminderKey) return; // already notified today

    // Check if user already completed ngaji today
    const { getQuranStatus } = await import('./lib/habits.js');
    const status = await getQuranStatus(settings);
    if (status.isComplete) return; // already done, no need to remind

    // Check if current time matches reminder time
    const reminderTime = settings.quranReminderTime || '07:00';
    const now = new Date();
    const [targetH, targetM] = reminderTime.split(':').map(n => parseInt(n, 10));
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const targetMin = targetH * 60 + targetM;

    // Fire if current time is at or past reminder time (within same hour)
    if (nowMin < targetMin) return; // too early

    try {
      await browser.notifications.create({
        type: 'basic',
        title: `📖 Pengingat Ngaji Quran`,
        message: `Belum ngaji hari ini. Target: ${settings.quranTargetPages || 1} halaman. ${status.streak > 0 ? `Streak: ${status.streak} hari! Jangan putus! 🔥` : 'Mulai streak hari ini!'}`,
        iconUrl: browser.runtime.getURL('icons/icon-96.svg'),
        priority: 2
      });
      console.log('[RecallFox] Quran reminder sent');
      await saveSettings({ quranLastReminderKey: reminderKey });
    } catch (e) {
      console.warn('[RecallFox] Quran notification failed:', e.message);
    }
  } catch (e) {
    console.warn('[RecallFox] Quran reminder check failed:', e.message);
  }
}

// ============================================================
// ===== Content Guardian (v0.8.20) =====
// ============================================================
// Filter berita negatif Indonesia & arahkan paksa ke konten positif
// Tiongkok (kehidupan, teknologi, dll.) saat user buka YouTube/X home
// atau saat user navigasi ke domain berita Indonesia yang diblokir.
//
// Mekanisme:
//   1. tabs.onUpdated → deteksi navigasi ke YouTube/X home atau domain
//      berita Indonesia → redirect ke halaman takeover/blocked ekstensi
//   2. Content script (contentguard-cs.js) hide video/tweet negatif di feed
//   3. Bypass 60 detik setelah user klik "Lewati" — supaya tidak loop

// Inisialisasi default settings Content Guardian jika belum diisi
async function initContentGuardDefaults() {
  const s = await getSettings();
  const patch = {};
  if (!s.contentGuardNegativeKeywords) {
    patch.contentGuardNegativeKeywords = DEFAULT_NEGATIVE_KEYWORDS;
  }
  if (!s.contentGuardIdNewsDomains) {
    patch.contentGuardIdNewsDomains = DEFAULT_ID_NEWS_DOMAINS;
  }
  if (!s.contentGuardBlockedYtChannels) {
    patch.contentGuardBlockedYtChannels = DEFAULT_BLOCKED_YT_CHANNELS;
  }
  if (!s.contentGuardBlockedXAccounts) {
    patch.contentGuardBlockedXAccounts = DEFAULT_BLOCKED_X_ACCOUNTS;
  }
  if (!s.contentGuardBlockedSearchQueries) {
    patch.contentGuardBlockedSearchQueries = DEFAULT_BLOCKED_SEARCH_QUERIES;
  }
  if (!s.contentGuardChinaSearches) {
    patch.contentGuardChinaSearches = DEFAULT_CHINA_YOUTUBE_SEARCHES;
  }
  if (!s.contentGuardChinaXAccounts) {
    patch.contentGuardChinaXAccounts = DEFAULT_CHINA_X_ACCOUNTS;
  }
  if (!s.contentGuardChinaXSearches) {
    patch.contentGuardChinaXSearches = DEFAULT_CHINA_X_SEARCHES;
  }
  // v3.21.0: Mode Fokus (Allowlist) — seed 2 profil bawaan jika belum ada.
  // Skema: { profiles: [{id, emoji, name, topics[], channels[], strictWatch}], activeProfileId }
  // Lihat lib/contentguard.js DEFAULT_TOPIC_PROFILES & seedDefaultTopicProfiles.
  if (!s.contentGuardTopicProfiles || !Array.isArray(s.contentGuardTopicProfiles.profiles)) {
    patch.contentGuardTopicProfiles = seedDefaultTopicProfiles(s.contentGuardTopicProfiles || null);
  }
  if (!Array.isArray(s.contentGuardUserBlocklist)) {
    patch.contentGuardUserBlocklist = [];
  }
  // v0.8.28: Master switch default ON. Mode Fokus sendiri dikendalikan oleh
  // contentGuardTopicProfiles.activeProfileId (null = semua profil OFF = YouTube normal).
  if (s.contentGuardEnabled === undefined) {
    patch.contentGuardEnabled = true;
  }
  // v3.21.0: Toggle FilterFeeds/ScanDescription/NuclearMode/BlockSearchQueries TIDAK lagi
  // di-seed default — fitur-fitur tersebut sudah dibongkar. Kunci settings lama tetap
  // dibaca untuk migrasi (lihat §5.6 instruksi), tapi tidak dipakai kode baru.
  if (s.contentGuardBlockYtChannels === undefined) {
    patch.contentGuardBlockYtChannels = true;
  }
  if (s.contentGuardBlockXAccounts === undefined) {
    patch.contentGuardBlockXAccounts = true;
  }
  if (Object.keys(patch).length > 0) {
    await saveSettings(patch);
    console.log('[RecallFox/CG] Default settings initialized:', Object.keys(patch));
  }
}

// v0.8.42: Element Blocker — init default rules
async function initElementBlockerDefaults() {
  const s = await getSettings();
  if (!s.elementBlockerRules || !Array.isArray(s.elementBlockerRules) || s.elementBlockerRules.length === 0) {
    await saveSettings({ elementBlockerRules: DEFAULT_ELEMENT_BLOCKER_RULES });
    console.log('[RecallFox/EB] Default rules initialized:', DEFAULT_ELEMENT_BLOCKER_RULES.length, 'presets');
  }
}

// v3.21.0: checkContentGuard — Pelindung Konten (Mode Fokus Allowlist)
// ====================================================================
// Prilaku (lihat instruksi §4):
//   - Master OFF (contentGuardEnabled === false) → tidak ada redirect apapun.
//   - Block Shorts: navigasi ke /shorts/<id> → redirect ke home (tetap dipertahankan).
//   - Search Lock: bila Mode Fokus AKTIF (master ON + activeProfileId valid + profil
//     punya ≥1 topik), navigasi ke halaman search YouTube/X yang query-nya TIDAK
//     mengandung topik profil → redirect ke contentguard/searchlock.html
//     (guard max 1×/menit/tab).
//   - Watch strict: profil aktif strictWatch=true → request redirect watch→home
//     datang dari content script (lihat handler CG_WATCH_STRICT_REDIRECT),
//     di-guard max 1×/5menit/tab di sini.
// DIBONGKAR v3.21.0: redirect home→takeover, blokir search query Tiongkok,
//   blokir domain berita Indonesia, redirect youtubekids.com (Mode Anak lama).
// ====================================================================
// v3.21.2 FIX: Cooldown anti-loop pindah ke browser.storage.session.
// Sebelumnya: in-memory Map (lastSearchLockMap, lastWatchStrictMap) yang HILANG
// saat Firefox MV3 event page di-suspend/restart → cooldown reset → redirect
// loop terlihat seperti "reload terus".
// Sekarang: timestamp disimpan di storage.session (volatile per-session, cocok
// untuk cooldown). Fallback ke storage.local kalau storage.session tidak ada.
const SEARCH_LOCK_COOLDOWN_MS = 60 * 1000;        // 1 menit
const WATCH_STRICT_COOLDOWN_MS = 5 * 60 * 1000;   // 5 menit

// Cache in-memory per event page lifetime (supaya tidak baca storage tiap pesan)
const _cooldownCache = new Map();  // key → timestamp

async function _getCooldown(key) {
  // Cek cache dulu
  if (_cooldownCache.has(key)) return _cooldownCache.get(key);
  // Baca dari storage.session (fallback storage.local)
  const storageArea = browser.storage.session || browser.storage.local;
  try {
    const data = await storageArea.get(key);
    const ts = data[key] || 0;
    _cooldownCache.set(key, ts);
    return ts;
  } catch (e) {
    return 0;
  }
}

async function _setCooldown(key, timestamp) {
  _cooldownCache.set(key, timestamp);
  const storageArea = browser.storage.session || browser.storage.local;
  try {
    await storageArea.set({ [key]: timestamp });
  } catch (e) {}
}

// v3.21.2 FIX: Helper untuk normalisasi URL — bandingkan tanpa trailing slash.
// Dipakai Fix 2 (guard URL sama = jangan redirect).
function _normalizeYoutubeHomeUrl(url) {
  if (!url) return '';
  // Hilangkan trailing slash, normalize www
  return url.replace(/\/+$/, '').replace('https://www.youtube.com', 'https://youtube.com').replace('https://youtube.com', 'https://www.youtube.com');
}

// v3.21.2 FIX: Cek apakah tab sudah berada di URL target.
// Kalau sudah sama → jangan tabs.update (di Firefox, update URL sama = reload).
async function _isAlreadyAtUrl(tabId, targetUrl) {
  try {
    const tab = await browser.tabs.get(tabId);
    if (!tab || !tab.url) return false;
    // Normalisasi kedua URL: hilangkan trailing slash
    const normCurrent = tab.url.replace(/\/+$/, '');
    const normTarget = targetUrl.replace(/\/+$/, '');
    return normCurrent === normTarget;
  } catch (e) {
    return false;
  }
}

async function checkContentGuard(tabId, url, tab) {
  if (!url || !/^https?:\/\//.test(url)) return;
  // Jangan proses URL extension sendiri (takeover/blocked/searchlock).
  // Loop-safe: Search Lock redirect target = searchlock.html (extension URL) → di-skip di sini.
  if (url.startsWith(browser.runtime.getURL(''))) return;

  const s = await getSettings();
  if (s.contentGuardEnabled === false) return;

  // ===== Block YouTube Shorts navigation (dipertahankan dari versi lama) =====
  // Loop-safe: target = youtube.com/ (home), home tidak di-redirect lagi.
  if (s.contentGuardBlockShorts === true) {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      const isYoutube = host === 'youtube.com' ||
                        host === 'www.youtube.com' ||
                        host === 'm.youtube.com' ||
                        host.endsWith('.youtube.com') ||
                        host.endsWith('.youtube-nocookie.com');
      if (isYoutube && u.pathname.startsWith('/shorts/')) {
        const homeUrl = 'https://www.youtube.com/';
        // v3.21.2 FIX 2: Guard URL sama — jangan redirect kalau tab sudah di home.
        if (await _isAlreadyAtUrl(tabId, homeUrl)) {
          console.log('[RecallFox/CG] BlockShorts: tab already at home — skip redirect');
          return;
        }
        console.log('[RecallFox/CG] BlockShorts: /shorts/ → home');
        try { await browser.tabs.update(tabId, { url: homeUrl }); }
        catch (e) { console.warn('[RecallFox/CG] BlockShorts tab update failed:', e.message); return; }
        if (s.contentGuardNotifyOnBlock !== false) {
          try {
            await browser.notifications.create({
              type: 'basic',
              title: '🚫 YouTube Shorts Diblokir',
              message: 'Navigasi ke Shorts dicegah. Kembali ke beranda YouTube.',
              iconUrl: browser.runtime.getURL('icons/icon-96.svg'),
              priority: 1
            });
          } catch (e) {}
        }
        return;
      }
    } catch (e) { /* URL parse error — skip */ }
  }

  // ===== Mode Fokus (Allowlist) — cek profil aktif =====
  const topicProfiles = s.contentGuardTopicProfiles;
  const activeProfile = getActiveProfile(topicProfiles);
  // Mode Fokus AKTIF hanya jika: master ON + ada activeProfileId + profil valid + profil punya topik/channel.
  // Profil kosong (tidak punya topik maupun channel) → tidak filter + Search Lock nonaktif (§4.2).
  const focusModeActive = !!(activeProfile && isProfileFiltering(activeProfile));

  // ===== Search Lock (§4.6) — berlaku untuk SEMUA profil dengan ≥1 topik =====
  // Hanya jalan saat Mode Fokus AKTIF. Query search yang TIDAK mengandung topik profil
  // → redirect ke searchlock.html (guard max 1×/menit/tab, loop-safe via extension URL skip).
  if (focusModeActive) {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      const isYoutubeHost = host === 'youtube.com' || host === 'www.youtube.com' ||
                            host === 'm.youtube.com' || host.endsWith('.youtube.com') ||
                            host.endsWith('.youtube-nocookie.com');
      const isXHost = host === 'x.com' || host === 'www.x.com' ||
                      host === 'twitter.com' || host === 'www.twitter.com' ||
                      host.endsWith('.x.com') || host.endsWith('.twitter.com');

      let searchQuery = '';
      let platform = '';
      if (isYoutubeHost && u.pathname === '/results') {
        searchQuery = u.searchParams.get('search_query') || '';
        platform = 'youtube';
      } else if (isXHost && u.pathname === '/search') {
        searchQuery = u.searchParams.get('q') || '';
        platform = 'x';
      }

      if (searchQuery && platform) {
        const matches = matchesProfileSearchQuery(searchQuery, activeProfile);
        if (!matches) {
          // v3.21.2 FIX 1: Cooldown via storage.session (bukan in-memory Map).
          // Event page Firefox bisa di-suspend → Map hilang → cooldown reset → loop.
          const now = Date.now();
          const cooldownKey = 'cg_lock_search_' + tabId;
          const last = await _getCooldown(cooldownKey);
          if (now - last < SEARCH_LOCK_COOLDOWN_MS) {
            console.log('[RecallFox/CG] Search Lock cooldown — skip (tab', tabId, ')');
            return;
          }
          // v3.21.2 FIX 2: Guard URL sama — jangan redirect kalau tab sudah di lockUrl.
          const lockUrl = browser.runtime.getURL('contentguard/searchlock.html')
            + '?platform=' + encodeURIComponent(platform)
            + '&profileId=' + encodeURIComponent(activeProfile.id);
          if (await _isAlreadyAtUrl(tabId, lockUrl)) {
            console.log('[RecallFox/CG] Search Lock: tab already at lockUrl — skip redirect');
            return;
          }
          await _setCooldown(cooldownKey, now);
          console.log('[RecallFox/CG] Search Lock redirect:', platform, 'query=', searchQuery.slice(0, 60));
          try { await browser.tabs.update(tabId, { url: lockUrl }); }
          catch (e) { console.warn('[RecallFox/CG] Search Lock tab update failed:', e.message); return; }
          if (s.contentGuardNotifyOnBlock !== false) {
            try {
              await browser.notifications.create({
                type: 'basic',
                title: '🔒 Pencarian Dikunci',
                message: 'Pencarian di luar topik aktif diblokir. Pilih topik dari halaman Kunci Pencarian.',
                iconUrl: browser.runtime.getURL('icons/icon-96.svg'),
                priority: 1
              });
            } catch (e) {}
          }
          return;
        }
      }
    } catch (e) { /* URL parse error — skip */ }
  }

  // v0.8.36: Watch intercept TIDAK dilakukan di background — content script
  // yang baca judul video dari DOM & kirim CG_WATCH_STRICT_REDIRECT bila perlu.
  // Lihat handler di bawah.
}

// Helper: redirect tab + notifikasi (jika diaktifkan)
// v0.8.35: Track redirect count per tab untuk anti-loop permanen
async function redirectWithNotify(tabId, newUrl, settings, title, message) {
  try {
    // v0.8.35: Catat timestamp + increment count
    lastRedirectMap.set(tabId, Date.now());
    const count = (redirectCountMap.get(tabId) || 0) + 1;
    redirectCountMap.set(tabId, count);
    console.log('[RecallFox/CG] Redirect tab', tabId, '- count:', count);
    await browser.tabs.update(tabId, { url: newUrl });
  } catch (e) {
    console.warn('[RecallFox/CG] Tab update failed:', e.message);
    lastRedirectMap.delete(tabId);
    return;
  }
  if (settings.contentGuardNotifyOnBlock !== false) {
    try {
      await browser.notifications.create({
        type: 'basic',
        title: `🛡️ ${title}`,
        message,
        iconUrl: browser.runtime.getURL('icons/icon-96.svg'),
        priority: 1
      });
    } catch (e) { /* notif gagal bukan masalah */ }
  }
}

// Pasang listener — dipakai untuk navigasi top-level
// v0.8.36: HANYA jalankan checkContentGuard. JANGAN forceInject di sini —
// itu bikin infinite loop (inject → init → hideYouTubeNegative → DOM change →
// MutationObserver → scan → modify DOM → ... → tabs.onUpdated → inject lagi)
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Hanya proses saat URL berubah (bukan loading progress)
  if (!changeInfo.url) return;
  // Skip kalau URL extension sendiri (takeover/blocked)
  const url = changeInfo.url;
  if (url.startsWith(browser.runtime.getURL(''))) return;
  checkContentGuard(tabId, url, tab).catch(e => {
    console.warn('[RecallFox/CG] checkContentGuard error:', e);
  });
  // v0.8.36: HAPUS forceInjectContentScript dari sini — bikin loop
});



// ===== Message handler untuk Content Guardian =====
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'CG_GET_SETTINGS') {
    getSettings().then(s => {
      // Isi default kalau belum ada (defensive)
      if (!s.contentGuardNegativeKeywords) s.contentGuardNegativeKeywords = DEFAULT_NEGATIVE_KEYWORDS;
      if (!s.contentGuardIdNewsDomains) s.contentGuardIdNewsDomains = DEFAULT_ID_NEWS_DOMAINS;
      if (!s.contentGuardBlockedYtChannels) s.contentGuardBlockedYtChannels = DEFAULT_BLOCKED_YT_CHANNELS;
      if (!s.contentGuardBlockedXAccounts) s.contentGuardBlockedXAccounts = DEFAULT_BLOCKED_X_ACCOUNTS;
      if (!s.contentGuardBlockedSearchQueries) s.contentGuardBlockedSearchQueries = DEFAULT_BLOCKED_SEARCH_QUERIES;
      if (!s.contentGuardChinaSearches) s.contentGuardChinaSearches = DEFAULT_CHINA_YOUTUBE_SEARCHES;
      if (!s.contentGuardChinaXAccounts) s.contentGuardChinaXAccounts = DEFAULT_CHINA_X_ACCOUNTS;
      if (!s.contentGuardChinaXSearches) s.contentGuardChinaXSearches = DEFAULT_CHINA_X_SEARCHES;
      if (!Array.isArray(s.contentGuardUserBlocklist)) s.contentGuardUserBlocklist = [];
      // v3.21.0: Seed topic profiles kalau belum ada (Mode Fokus).
      if (!s.contentGuardTopicProfiles || !Array.isArray(s.contentGuardTopicProfiles.profiles)) {
        s.contentGuardTopicProfiles = seedDefaultTopicProfiles(s.contentGuardTopicProfiles || null);
      }
      sendResponse({ settings: s });
    });
    return true;  // async
  }

  if (msg.type === 'CG_GET_VAULT') {
    getVault().then(v => sendResponse(v)).catch(() => sendResponse(null));
    return true;
  }

  if (msg.type === 'CG_MARK_BYPASS') {
    markBypass(msg.url).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'CG_ADD_BLOCKLIST') {
    addUserBlocklistEntry(msg.entry || {}).then(res => sendResponse(res)).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'CG_REMOVE_BLOCKLIST') {
    removeUserBlocklistEntry(msg.id).then(res => sendResponse(res)).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'CG_CLEAR_BLOCKLIST') {
    clearUserBlocklist().then(res => sendResponse(res)).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'CG_GET_BLOCKLIST') {
    getUserBlocklist().then(list => sendResponse({ ok: true, list })).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // ===== v3.21.0: Mode Fokus (Allowlist) — profil & topik =====
  // Skema: contentGuardTopicProfiles = { profiles: [...], activeProfileId: string|null }

  // CG_GET_TOPIC_PROFILES — kembalikan skema lengkap (seed default bila belum ada).
  if (msg.type === 'CG_GET_TOPIC_PROFILES') {
    getSettings().then(s => {
      let tp = s.contentGuardTopicProfiles;
      if (!tp || !Array.isArray(tp.profiles)) tp = seedDefaultTopicProfiles(tp || null);
      sendResponse({ ok: true, topicProfiles: tp });
    }).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // CG_SET_ACTIVE_PROFILE — set profil aktif (radio: null = semua OFF).
  // Payload: { profileId: string|null }
  // Broadcast CG_SETTINGS_UPDATED supaya content script re-scan.
  if (msg.type === 'CG_SET_ACTIVE_PROFILE') {
    getSettings().then(async s => {
      let tp = s.contentGuardTopicProfiles;
      if (!tp || !Array.isArray(tp.profiles)) tp = seedDefaultTopicProfiles(tp || null);
      const newId = msg.profileId || null;
      // Validasi: pastikan ID ada di daftar profil (atau null)
      if (newId && !tp.profiles.some(p => p.id === newId)) {
        sendResponse({ ok: false, error: 'Profil tidak ditemukan' });
        return;
      }
      tp.activeProfileId = newId;
      try {
        await saveSettings({ contentGuardTopicProfiles: tp });
        // Broadcast ke semua tab YouTube/X
        const tabs = await browser.tabs.query({});
        for (const t of tabs) {
          browser.tabs.sendMessage(t.id, { type: 'CG_SETTINGS_UPDATED' }).catch(() => {});
        }
        sendResponse({ ok: true, topicProfiles: tp });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    });
    return true;
  }

  // CG_ADD_TOPIC_PROFILE — tambah profil baru (nama default "Profil Baru N").
  // Payload: { profile: { name?, emoji?, topics?, channels?, strictWatch? } } (opsional)
  if (msg.type === 'CG_ADD_TOPIC_PROFILE') {
    getSettings().then(async s => {
      let tp = s.contentGuardTopicProfiles;
      if (!tp || !Array.isArray(tp.profiles)) tp = seedDefaultTopicProfiles(tp || null);
      const n = tp.profiles.length + 1;
      const newProfile = {
        id: generateProfileId(),
        emoji: (msg.profile && msg.profile.emoji) || '👤',
        name: (msg.profile && msg.profile.name) || ('Profil Baru ' + n),
        topics: Array.isArray(msg.profile?.topics) ? msg.profile.topics : [],
        channels: Array.isArray(msg.profile?.channels) ? msg.profile.channels : [],
        strictWatch: !!(msg.profile && msg.profile.strictWatch === true)
      };
      tp.profiles.push(newProfile);
      try {
        await saveSettings({ contentGuardTopicProfiles: tp });
        const tabs = await browser.tabs.query({});
        for (const t of tabs) browser.tabs.sendMessage(t.id, { type: 'CG_SETTINGS_UPDATED' }).catch(() => {});
        sendResponse({ ok: true, topicProfiles: tp, newProfileId: newProfile.id });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    });
    return true;
  }

  // CG_SAVE_TOPIC_PROFILE — simpan perubahan profil (nama/emoji/topik/channel/strictWatch).
  // Payload: { profileId: string, profile: { name, emoji, topics, channels, strictWatch } }
  if (msg.type === 'CG_SAVE_TOPIC_PROFILE') {
    getSettings().then(async s => {
      let tp = s.contentGuardTopicProfiles;
      if (!tp || !Array.isArray(tp.profiles)) tp = seedDefaultTopicProfiles(tp || null);
      const idx = tp.profiles.findIndex(p => p.id === msg.profileId);
      if (idx < 0) { sendResponse({ ok: false, error: 'Profil tidak ditemukan' }); return; }
      const incoming = msg.profile || {};
      tp.profiles[idx] = {
        id: tp.profiles[idx].id,
        emoji: typeof incoming.emoji === 'string' ? incoming.emoji : (tp.profiles[idx].emoji || '👤'),
        name: typeof incoming.name === 'string' && incoming.name.trim() ? incoming.name.trim() : (tp.profiles[idx].name || 'Profil'),
        topics: Array.isArray(incoming.topics) ? incoming.topics.map(t => String(t).trim()).filter(Boolean) : (tp.profiles[idx].topics || []),
        channels: Array.isArray(incoming.channels) ? incoming.channels.map(c => String(c).trim()).filter(Boolean) : (tp.profiles[idx].channels || []),
        strictWatch: !!incoming.strictWatch
      };
      try {
        await saveSettings({ contentGuardTopicProfiles: tp });
        const tabs = await browser.tabs.query({});
        for (const t of tabs) browser.tabs.sendMessage(t.id, { type: 'CG_SETTINGS_UPDATED' }).catch(() => {});
        sendResponse({ ok: true, topicProfiles: tp });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    });
    return true;
  }

  // CG_DELETE_TOPIC_PROFILE — hapus profil. Aturan: minimal 1 profil tersisa;
  // profil aktif tidak bisa dihapus tanpa pindah dulu.
  // Payload: { profileId: string }
  if (msg.type === 'CG_DELETE_TOPIC_PROFILE') {
    getSettings().then(async s => {
      let tp = s.contentGuardTopicProfiles;
      if (!tp || !Array.isArray(tp.profiles)) tp = seedDefaultTopicProfiles(tp || null);
      if (tp.profiles.length <= 1) {
        sendResponse({ ok: false, error: 'Minimal 1 profil harus tersisa' });
        return;
      }
      if (tp.activeProfileId === msg.profileId) {
        sendResponse({ ok: false, error: 'Profil sedang aktif — pindah ke profil lain dulu' });
        return;
      }
      tp.profiles = tp.profiles.filter(p => p.id !== msg.profileId);
      try {
        await saveSettings({ contentGuardTopicProfiles: tp });
        const tabs = await browser.tabs.query({});
        for (const t of tabs) browser.tabs.sendMessage(t.id, { type: 'CG_SETTINGS_UPDATED' }).catch(() => {});
        sendResponse({ ok: true, topicProfiles: tp });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    });
    return true;
  }

  // CG_WATCH_STRICT_REDIRECT — dipanggil content script (lihat contentguard-cs.js)
  // ketika watch page video TIDAK cocok profil aktif + strictWatch=true.
  // Background menerapkan guard max 1×/5menit/tab, lalu redirect ke home.
  // Loop-safe: home tidak di-redirect lagi (Case 1 sudah dihapus).
  if (msg.type === 'CG_WATCH_STRICT_REDIRECT') {
    const tabId = sender.tab && sender.tab.id;
    if (typeof tabId !== 'number') { sendResponse({ ok: false, redirected: false }); return false; }
    // v3.21.2 FIX 1+2: Async IIFE karena listener synchronous, tapi butuh await untuk storage.session
    (async () => {
      const now = Date.now();
      const cooldownKey = 'cg_lock_watch_' + tabId;
      const last = await _getCooldown(cooldownKey);
      if (now - last < WATCH_STRICT_COOLDOWN_MS) {
        sendResponse({ ok: true, redirected: false, reason: 'cooldown' });
        return;
      }
      const homeUrl = 'https://www.youtube.com/';
      // v3.21.2 FIX 2: Guard URL sama — jangan redirect kalau tab sudah di home.
      if (await _isAlreadyAtUrl(tabId, homeUrl)) {
        console.log('[RecallFox/CG] Watch Strict: tab already at home — skip redirect (prevent loop)');
        await _setCooldown(cooldownKey, now);
        sendResponse({ ok: true, redirected: false, reason: 'already_at_home' });
        return;
      }
      await _setCooldown(cooldownKey, now);
      try {
        await browser.tabs.update(tabId, { url: homeUrl });
        sendResponse({ ok: true, redirected: true });
      } catch (e) {
        sendResponse({ ok: false, redirected: false, error: e.message });
      }
    })();
    return true;  // keep channel open for async sendResponse
  }

  // v0.8.29: CG_SAVE_SETTING — sudah dipindahkan ke listener 1 (v0.9.7)

  if (msg.type === 'CG_SETTINGS_UPDATED') {
    // Broadcast ke semua tab supaya content script reload settings
    browser.tabs.query({}).then(tabs => {
      for (const t of tabs) {
        browser.tabs.sendMessage(t.id, { type: 'CG_SETTINGS_UPDATED' }).catch(() => {});
        browser.tabs.sendMessage(t.id, { type: 'EB_RULES_UPDATED' }).catch(() => {});
      }
    }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  // v0.8.42: Element Blocker message handlers
  if (msg.type === 'EB_GET_RULES') {
    getSettings().then(s => {
      const enabled = s.elementBlockerEnabled !== false;
      const rules = s.elementBlockerRules || [];
      sendResponse({ enabled, rules });
    }).catch(() => sendResponse({ enabled: true, rules: [] }));
    return true;
  }

  if (msg.type === 'EB_SAVE_RULES') {
    saveSettings({ elementBlockerRules: msg.rules || [] }).then(() => {
      // Broadcast ke semua tab
      browser.tabs.query({}).then(tabs => {
        for (const t of tabs) {
          browser.tabs.sendMessage(t.id, { type: 'EB_RULES_UPDATED' }).catch(() => {});
        }
      }).catch(() => {});
      sendResponse({ ok: true });
    }).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // v3.4: Element picker — user clicked an element in the page, save its selector
  // Payload: { selector, altSelectors, tagName, id, className, text, domain, url }
  if (msg.type === 'EB_BLOCK_CLICKED_ELEMENT') {
    (async () => {
      try {
        const selector = (msg.selector || '').trim();
        if (!selector) {
          sendResponse({ ok: false, error: 'empty_selector' });
          return;
        }
        // Determine the domain — prefer the one sent by content script, fall back to URL parsing
        let domain = msg.domain || '';
        if (!domain && msg.url) {
          try { domain = new URL(msg.url).hostname; } catch (e) {}
        }
        if (!domain) { domain = 'unknown'; }

        // Combine primary selector with alt selectors (dedupe, cap to 4 total)
        const allSelectors = [selector];
        if (Array.isArray(msg.altSelectors)) {
          for (const alt of msg.altSelectors) {
            if (alt && alt.trim() && !allSelectors.includes(alt.trim())) {
              allSelectors.push(alt.trim());
            }
            if (allSelectors.length >= 4) break;
          }
        }

        // Load existing rules
        const s = await getSettings();
        let rules = Array.isArray(s.elementBlockerRules) ? s.elementBlockerRules.slice() : [];

        // Find or create a rule for this domain
        let rule = rules.find(r => r.domain === domain);
        let addedCount = 0;
        if (rule) {
          for (const sel of allSelectors) {
            if (!rule.selectors.includes(sel)) {
              rule.selectors.push(sel);
              addedCount++;
            }
          }
        } else {
          rule = {
            id: 'picker_' + Date.now().toString(36),
            name: '🎨 Picked: ' + domain,
            domain: domain,
            enabled: true,
            isPreset: false,
            selectors: allSelectors.slice(),
            blockDomains: [],
            blockPopups: false
          };
          rules.push(rule);
          addedCount = allSelectors.length;
        }

        // Save back
        await saveSettings({ elementBlockerRules: rules });

        // Broadcast update to all tabs so the rule applies immediately
        browser.tabs.query({}).then(tabs => {
          for (const t of tabs) {
            browser.tabs.sendMessage(t.id, { type: 'EB_RULES_UPDATED' }).catch(() => {});
          }
        }).catch(() => {});

        // Notification (non-blocking)
        try {
          await browser.notifications.create({
            type: 'basic',
            title: '🎯 Elemen diblokir',
            message: 'Selector "' + selector.slice(0, 60) + (selector.length > 60 ? '…' : '') + '" ditambahkan ke aturan untuk ' + domain + '.'
          });
        } catch (e) {}

        console.log('[RecallFox/EB] Saved picker selector for', domain, ':', allSelectors);
        sendResponse({ ok: true, selector: selector, domain: domain, addedCount: addedCount });
      } catch (err) {
        console.error('[RecallFox/EB] EB_BLOCK_CLICKED_ELEMENT failed:', err);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;  // async response
  }

  // v3.14.3: SAVE_TAPE_TO_VAULT — simpan tape calculation ke vault sebagai note
  if (msg.type === 'SAVE_TAPE_TO_VAULT') {
    (async () => {
      try {
        const { markdown, text, grandTotal } = msg;
        const { addNote } = await import('./lib/storage.js');
        const note = await addNote(markdown || text, {
          title: '🧮 RecallTape — Total: ' + (grandTotal || 0).toLocaleString('id-ID'),
          group: 'RecallTape'
        });
        sendResponse({ ok: true, noteId: note.id });
      } catch (e) {
        console.error('[RecallFox] SAVE_TAPE_TO_VAULT failed:', e);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  // v3.21.15: UPDATE_VAULT_NOTE — autosave dari floating note (vaultNoteId)
  if (msg.type === 'UPDATE_VAULT_NOTE') {
    (async () => {
      try {
        const { noteId, text } = msg;
        if (!noteId || typeof text !== 'string') { sendResponse({ ok: false, error: 'invalid' }); return; }
        const { getVault, saveVault } = await import('./lib/storage.js');
        const vault = await getVault();
        const note = (vault.notes || []).find(n => n.id === noteId);
        if (!note) { sendResponse({ ok: false, error: 'not_found' }); return; }
        note.body = text;
        note.updatedAt = Date.now();
        await saveVault(vault);
        sendResponse({ ok: true });
      } catch (e) {
        console.error('[RecallFox] UPDATE_VAULT_NOTE failed:', e);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  // v3.21.16: Floater pill 4 tombol — RF_OPEN_NOTE/TAPE dari sidebar-cs.js floater
  if (msg.type === 'RF_OPEN_NOTE') {
    (async()=>{
      try{
        const tabs = await browser.tabs.query({active:true, currentWindow:true});
        const tab = tabs[0];
        if(tab && tab.id){
          try{ await browser.tabs.sendMessage(tab.id, {type:'OPEN_NOTE'}); }
          catch(e){ await browser.scripting.executeScript({target:{tabId:tab.id}, files:['content/notes-cs.js']}); await browser.tabs.sendMessage(tab.id, {type:'OPEN_NOTE'}); }
        }
        sendResponse({ok:true});
      }catch(e){ sendResponse({ok:false, error:e.message}); }
    })();
    return true;
  }
  if (msg.type === 'RF_OPEN_TAPE') {
    (async()=>{
      try{
        const tabs = await browser.tabs.query({active:true, currentWindow:true});
        const tab = tabs[0];
        if(tab && tab.id){
          try{ await browser.tabs.sendMessage(tab.id, {type:'OPEN_TAPE'}); }
          catch(e){ await browser.scripting.executeScript({target:{tabId:tab.id}, files:['content/tape-cs.js']}); await browser.tabs.sendMessage(tab.id, {type:'OPEN_TAPE'}); }
        }
        sendResponse({ok:true});
      }catch(e){ sendResponse({ok:false, error:e.message}); }
    })();
    return true;
  }
  if (msg.type === 'RF_FORWARD_TO_ACTIVE_TAB') {
    (async()=>{
      try{
        const tabs = await browser.tabs.query({active:true, currentWindow:true});
        const tab = tabs[0];
        if(tab && tab.id && msg.msgType){
          try{ await browser.tabs.sendMessage(tab.id, {type: msg.msgType}); }
          catch(e){
            const file = msg.msgType==='OPEN_NOTE'?'content/notes-cs.js': msg.msgType==='OPEN_TAPE'?'content/tape-cs.js':'content/sidebar-cs.js';
            await browser.scripting.executeScript({target:{tabId:tab.id}, files:[file]});
            await browser.tabs.sendMessage(tab.id, {type: msg.msgType});
          }
        }
        sendResponse({ok:true});
      }catch(e){ sendResponse({ok:false, error:e.message}); }
    })();
    return true;
  }

  // v3.20.34-dev: RF_ASSISTANT_FETCH — relay fetch API call dari iframe popout sidebar.
  // Root cause "NetworkError when attempting to fetch resource" di popout sidebar
  // (iframe cross-origin): browser block fetch external API dari iframe extension page.
  // Background Service Worker punya akses penuh ke network tanpa iframe restriction.
  // chat() di lib/assistant.js auto-detect iframe context + relay via background.
  if (msg.type === 'RF_ASSISTANT_FETCH') {
    (async () => {
      try {
        const { url, method, headers, body, stream } = msg;
        if (!url) { sendResponse({ ok: false, error: 'no_url' }); return; }

        // Background fetch — punya akses penuh ke network (host_permissions <all_urls>)
        const res = await fetch(url, {
          method: method || 'POST',
          headers: headers || { 'Content-Type': 'application/json' },
          body: body || undefined
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          let errMsg = `HTTP ${res.status}`;
          try {
            const err = JSON.parse(errText);
            errMsg = err.error?.message || err.message || errMsg;
          } catch (e) {
            errMsg = errText.slice(0, 200) || errMsg;
          }
          sendResponse({ ok: false, error: errMsg, status: res.status });
          return;
        }

        // Non-streaming: return JSON
        if (!stream) {
          const data = await res.json();
          sendResponse({ ok: true, data });
          return;
        }

        // Streaming: collect full text (relay tidak support real-time SSE ke iframe)
        // Trade-off: user tidak lihat token-by-token streaming, tapi response lengkap tetap sampai.
        const text = await res.text();
        sendResponse({ ok: true, text });
      } catch (e) {
        console.error('[RecallFox/bg] RF_ASSISTANT_FETCH failed:', e.message);
        const errMsg = e.message || '';
        const isNetworkErr = errMsg.toLowerCase().includes('network') ||
                             errMsg.toLowerCase().includes('failed to fetch') ||
                             e.name === 'TypeError';
        sendResponse({
          ok: false,
          error: isNetworkErr ? `NETWORK_ERROR: ${errMsg}` : errMsg,
          isNetworkError: isNetworkErr
        });
      }
    })();
    return true;  // async response
  }

  // v3.20.10: RF_FORWARD_TO_ACTIVE_TAB — forward message from content script
  // to active tab's content script. Used by sidebar-cs.js (popout) to send
  // OPEN_TAPE to tape-cs.js. Content scripts don't have browser.tabs access.
  // v3.20.21: Forward extra fields (text, mode, dst.) supaya bisa dipakai untuk
  // COPY_TEXT (clipboard fallback di popout sidebar).
  if (msg.type === 'RF_FORWARD_TO_ACTIVE_TAB') {
    (async () => {
      try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) { sendResponse({ ok: false, error: 'no_active_tab' }); return; }
        // v3.20.21: Build message payload dengan forward extra fields
        const payload = { type: msg.msgType };
        if (msg.text !== undefined) payload.text = msg.text;
        if (msg.mode !== undefined) payload.mode = msg.mode;
        if (msg.data !== undefined) payload.data = msg.data;
        try {
          const res = await browser.tabs.sendMessage(tab.id, payload);
          sendResponse(res || { ok: true });
        } catch (e) {
          // Content script not loaded — inject then retry (hanya untuk OPEN_TAPE)
          if (msg.msgType === 'OPEN_TAPE') {
            await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/tape-cs.js'] });
            setTimeout(() => browser.tabs.sendMessage(tab.id, { type: 'OPEN_TAPE' }).catch(() => {}), 200);
            sendResponse({ ok: true, injected: true });
          } else {
            sendResponse({ ok: false, error: e.message });
          }
        }
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // v3.20.23: RF_OPEN_SETTINGS_VIA_BG — last resort fallback untuk buka settings.
  // Dipanggil dari popup/sidebar kalau tabs.create() DAN openOptionsPage() keduanya
  // no-op (bug Firefox terkenal di sidebar/iframe context).
  // Background SW punya akses penuh ke browser.tabs — panggil langsung dari sini.
  if (msg.type === 'RF_OPEN_SETTINGS_VIA_BG') {
    (async () => {
      try {
        const settingsUrl = browser.runtime.getURL('settings/settings.html');
        // Cek apakah tab settings sudah terbuka — fokus ke sana kalau ya
        const existing = await browser.tabs.query({ url: settingsUrl });
        if (existing.length > 0) {
          await browser.tabs.update(existing[0].id, { active: true });
          await browser.windows.update(existing[0].windowId, { focused: true });
          sendResponse({ ok: true, reused: true });
          return;
        }
        // Buat tab baru
        const tab = await browser.tabs.create({ url: settingsUrl });
        if (tab && tab.id) {
          sendResponse({ ok: true, tabId: tab.id });
        } else {
          sendResponse({ ok: false, error: 'tab_create_returned_no_id' });
        }
      } catch (e) {
        console.error('[RecallFox/bg] RF_OPEN_SETTINGS_VIA_BG failed:', e);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // AD_DISCARD_NOW & AD_FORCE_DISCARD_ALL — sudah dipindahkan ke listener 1 (v0.9.7)
});

// ===== Notifikasi selamat datang saat Content Guardian pertama aktif =====
browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== 'install' && details.reason !== 'update') return;
  // Hanya tampilkan untuk update
  try {
    const s = await getSettings();
    if (s.contentGuardEnabled !== false && details.reason === 'update') {
      await browser.notifications.create({
        type: 'basic',
        title: '🛡️ Content Guardian v0.8.21 — Klik Kanan untuk Blokir',
        message: 'Sekarang Anda bisa klik kanan pada video/tweet di YouTube/X → "🚫 Blokir Konten Ini" untuk blokir permanen. Daftar kata kunci politik & korupsi juga diperluas.',
        iconUrl: browser.runtime.getURL('icons/icon-96.svg'),
        priority: 2
      });
    }
  } catch (e) { /* ignore */ }
});

// ============================================================================
// v3.20.16: Relay Point — generate resume context via OmniRouter (silent, async)
// ============================================================================
// Tujuan: Saat Snapshot diambil di domain AI, generate "resume context" —
// ringkasan status kerja terakhir yang bisa di-paste ke akun AI baru untuk
// melanjutkan pekerjaan. Disimpan menyatu di metadata snapshot (bukan item baru).
//
// Deteksi AI domain: snapshotDomain sudah di-set oleh content.js extractConversation()
// (hanya di-set kalau isAIPage() true). Jadi tidak perlu cek ulang di sini —
// kalau msg.body ada dan cukup panjang, asumsikan ini snapshot dari AI domain.
//
// STRATEGI AMAN (pelajaran dari v3.20.16 broken sebelumnya):
//   - Resume context HANYA disimpan di local storage (lib/storage.js addItem).
//   - TIDAK sync ke Supabase (lib/supabase-sync.js TIDAK diubah) → cloud sync
//     tetap pakai schema lama, tidak akan PGRST204 error.
//   - Auto-generate: fire-and-forget setelah CAPTURE_SNAPSHOT save.
//     Non-blocking — snapshot sudah tersimpan, resume context update via updateItem().
//   - Manual-generate: user klik "Generate Resume Context" di action sheet.
//     Sync lewat GENERATE_RESUME_CONTEXT message.
//   - Kalau OmniRouter belum dikonfigurasi atau gagal, resumeContext = null.
//     Snapshot tetap berfungsi normal seperti sebelumnya.
// ============================================================================

const RESUME_CONTEXT_SYSTEM_PROMPT = `Anda adalah "Si Pandai Relay Agent" — pakar serah terima konteks kerja (HANDOVER BRIEF) berbasis standar Kombinasi Repo GitHub Teratas (ayghri/i-have-adhd ⭐22.48k & wilbeibi/catchup ⭐65).

Tugas Anda: Menyadur snapshot percakapan user dengan AI menjadi Laporan Serah Terima Kerja (HANDOVER BRIEF) yang SANGAT TERSTRUKTUR, ZERO FLUFF, DIRECT ACTION, dan HIGHLY SKIMMABLE.

## ATURAN EMAS KELUARAN (WAJIB DIPATUHI 100%)

1. **LEAD WITH ACTION / SUMMARY FIRST:** DILARANG BUKA DENGAN BASA-BASI. Jangan pernah tulis "Tentu", "Berikut laporannya", "Berdasarkan percakapan", atau "Halo". Teks WAJIB langsung dimulai dengan "# 📦 HANDOVER BRIEF: [Topik Utama]".
2. **ZERO FLUFF & NO HEDGING:** Hapus semua kata pengisi, idiom, atau kalimat ketidakpastian ("mungkin", "sepertinya"). Gunakan kalimat lugas dan faktual.
3. **NO PREAMBLE, NO RECAP, NO CLOSING PLEASANTRIES:** Dilarang memberi penutup "Semoga membantu", "Ada yang bisa dibantu lagi", atau "Terima kasih".
4. **HIGH VISUAL HIERARCHY:** Gunakan tebal (**bold**) pada nama variabel, path file, fungsi, dan keyword penting agar dapat dibaca dalam 3 detik.
5. **CHECKLIST PROGRESS & NEXT ACTION:** Gunakan \`[✓]\` untuk tugas yang selesai, dan tempatkan \`👉 **Tindakan Pertama:**\` di posisi paling atas pada seksi langkah selanjutnya.
6. **RELEVANT HISTORY ENRICHMENT:** Jika pesan/jawaban chat sebelumnya masih berkaitan dengan topik di chat terakhir (Anchor), SERTAKAN poin-poin penting dari percakapan sebelumnya tersebut untuk memperkaya konteks.
7. **NO EMPTY PLACEHOLDERS:** Jika suatu seksi kosong, HILANGKAN SEKSI TERSBUT SEPENUHNYA. Dilarang menulis "Tidak Ada", "N/A", atau "None".

## STRUKTUR OUTPUT (HANDOVER BRIEF)

# 📦 HANDOVER BRIEF: [Nama Topik Utama]

## 1. Current Task & Executive Summary
(1-2 kalimat lugas menyatakan tujuan aktif dan status eksekusi terakhir).

## 2. Progress So Far (Work Completed)
- [✓] **[Fitur/Fungsi]**: [Deskripsi ringkas + **path file/variabel**]
- [✓] **[Fix/Refactor]**: [Deskripsi ringkas]

## 3. Where We Stopped & Next Steps
- 👉 **Tindakan Pertama:** [1 instruksi paling mendesak yang harus dikerjakan pertama kali saat resume].
- 1. **[Langkah 1]**: [Tindakan konkret berikutnya]
- 2. **[Langkah 2]**: [Tindakan konkret berikutnya]

## 4. Key Decisions & Technical References
- **Files Modified:** [Path file yang diubah]
- **Crucial Context:** [Variabel, fungsi, endpoint, atau logika penting]

## 5. Blockers, Risks, & Gotchas
- ⚠️ **[Risiko/Gotcha]**: [Penjelasan masalah dan mitigasinya]

## 6. Actionable Instruction for Next Agent
\`To continue, please open [PATH FILE] and implement [FUNGSI/LOGIKA].\`

## LANGKAH EKSTRAKSI KONTEKS

1. Cari **ANCHOR** (jawaban AI terakhir + pertanyaan user pemicu di posisi paling bawah snapshot).
2. Lakukan backward chaining: Cek 3-6 pasang percakapan ke belakang. Jika percakapan/jawaban AI sebelumnya masih berkaitan dan memperkuat topik di Anchor, SERTAKAN poin-poin pentingnya untuk memperkaya konteks Handover Brief.
3. Ekstrak nama file, fungsi, variabel, dan perintah spesifik dari seluruh percakapan yang relevan.
4. Susun Handover Brief mengikuti format kombinasi di atas.

## ATURAN TAMBAHAN

1. **SKIP SEKSI KOSONG.** Hilangkan section yang tidak ada isinya. Jangan tulis "Tidak Ada" atau "N/A".
2. **Minimal output: Executive Summary saja** kalau snapshot terlalu pendek.
3. **WAJIB include nama file** kalau AI di percakapan menyebut nama file.
4. **Maksimal 800 kata.**
5. **Bahasa Indonesia**, kecuali nama file/path/kode.
6. Kalau percakapan terlalu pendek, jawab: "Percakapan terlalu pendek untuk resume context."`;

const RESUME_CONTEXT_MAX_BODY_CHARS = 8000; // Truncate body sebelum kirim ke AI (hemat token)

/**
 * v3.20.18: Parse body snapshot untuk ambil maksimal N pairs terakhir (user + AI).
 *
 * v3.20.17 fixed ambil 3 pairs — terlalu kaku. User bilang:
 *   "utamakan chat terakhir untuk memeriksa chat pertama dan kedua nyambung tidak.
 *    jika chat kedua nyambung dengan yang ketiga berarti saling menguatkan untuk
 *    bahkan ngambil lebih dari 3 chat di atasnya misalkan masih ada yang nyambung."
 *
 * v3.20.18: Kirim full body snapshot (truncated ke 8000 char) ke AI. AI yang
 * decide mana yang nyambung (chained relevance backward dari pair terakhir).
 * Bisa ambil 3, 4, 5, atau 6 pairs terakhir tergantung kontinuitas topik.
 *
 * Body snapshot format (dari content.js extractConversation):
 *   "👤 User:\n<text>\n\n🤖 AI:\n<text>\n\n👤 User:\n<text>\n\n🤖 AI:\n<text>\n\n..."
 *
 * Fungsi ini sekarang cuma truncate ke max chars (tidak potong pairs lagi —
 * AI yang pilih mana yang relevan via prompt chained relevance).
 *
 * @param {string} body — snapshot body (full)
 * @returns {string} — body yang sudah di-truncate ke RESUME_CONTEXT_MAX_BODY_CHARS
 */
function truncateBodyForResume(body) {
  if (!body || typeof body !== 'string') return '';
  if (body.length <= RESUME_CONTEXT_MAX_BODY_CHARS) return body;
  // Truncate dari akhir supaya pertahankan pesan-pesan terakhir (yang paling relevan)
  // untuk chained relevance. Tapi AI tetap butuh konteks awal untuk deteksi
  // "apakah nyambung dari awal atau tidak". Jadi truncate dari TENGAH —
  // keep awal (sebagian) + akhir (full).
  //
  // Strategi: keep 2000 char pertama (preview konteks awal) + "...[truncated, X chars middle]..." + 6000 char terakhir.
  const headLen = 2000;
  const tailLen = RESUME_CONTEXT_MAX_BODY_CHARS - headLen - 200; // 200 char untuk truncation marker
  const head = body.slice(0, headLen);
  const tail = body.slice(body.length - tailLen);
  return head + '\n\n...[truncated, ' + (body.length - headLen - tailLen) + ' chars middle omitted — pesan terakhir tetap full di bawah]...\n\n' + tail;
}

/**
 * Generate resume context async (fire-and-forget).
 * Dipanggil setelah CAPTURE_SNAPSHOT save. Non-blocking.
 * Update item via updateItem() kalau berhasil.
 *
 * v3.20.18: Kirim full body snapshot (truncated) ke AI. AI deteksi rantai
 * relevansi backward dari pair terakhir — bisa ambil 3-6 pairs terakhir
 * tergantung kontinuitas topik. Word limit 800 kata (sebelumnya 300).
 *
 * @param {string} itemId — ID snapshot item
 * @param {string} body — snapshot body (percakapan AI, full 50 msgs)
 * @param {string} title — snapshot title (untuk konteks)
 */
async function generateResumeContext(itemId, body, title) {
  try {
    // Cek apakah AI assistant dikonfigurasi
    const configured = await isAssistantConfigured();
    if (!configured) {
      console.log('[RecallFox/RelayPoint] AI not configured — skip resume context generation');
      return;
    }

    const resumeContext = await generateResumeContextSync(body, title);
    if (!resumeContext) {
      console.log('[RecallFox/RelayPoint] Resume context empty — skip save');
      return;
    }

    // Update item dengan resume context (LOKAL saja — tidak sync ke cloud)
    await updateItem(itemId, {
      resumeContext,
      resumeContextAt: new Date().toISOString()
    });
    console.log('[RecallFox/RelayPoint] Resume context saved for item', itemId, '(' + resumeContext.length + ' chars)');
  } catch (err) {
    console.warn('[RecallFox/RelayPoint] generateResumeContext error:', err.message);
    // Jangan throw — ini fire-and-forget. Snapshot tetap tersimpan tanpa resume context.
  }
}

/**
 * Generate resume context sync (untuk manual trigger).
 * Dipanggil oleh GENERATE_RESUME_CONTEXT message handler.
 *
 * v3.20.18: Kirim full body snapshot (truncated 8000 char) ke AI. AI deteksi
 * rantai relevansi backward — ambil 3-6 pairs terakhir yang nyambung topik.
 * Word limit 800 kata (sebelumnya 300 — user bilang terlalu terbatas).
 *
 * @param {string} body — snapshot body (full 50 msgs)
 * @param {string} title — snapshot title
 * @returns {Promise<string|null>} — resume context text, atau null kalau gagal
 */
async function generateResumeContextSync(body, title) {
  // v3.20.18: Kirim full body (truncated). AI yang decide mana yang nyambung
  // via chained relevance backward logic di system prompt.
  const truncatedBody = truncateBodyForResume(body);
  if (!truncatedBody) {
    console.log('[RecallFox/RelayPoint] Body kosong — skip');
    return null;
  }

  const messages = [
    { role: 'system', content: RESUME_CONTEXT_SYSTEM_PROMPT },
    { role: 'user', content: 'Judul snapshot: ' + title + '\n\nSnapshot percakapan user dengan AI (urut dari tertua ke terbaru):\n\n' + truncatedBody }
  ];

  const result = await chatWithFallback(messages);
  const content = result?.content?.trim();
  if (!content || content.length < 20) {
    return null;
  }
  // Filter: kalau AI bilang "terlalu pendek", return null
  if (content.toLowerCase().includes('terlalu pendek untuk resume context')) {
    return null;
  }
  return content;
}

// v3.21.16: Cross-tab floating sync — broadcast show to new tab + all tabs on change
try {
  browser.tabs.onActivated.addListener(async (info) => {
    try {
      const r = await browser.storage.local.get(['floatNoteState','floatTapeState']);
      for (const key of ['floatNoteState','floatTapeState']) {
        const float = r[key];
        if (float && float.isOpen) {
          const tab = await browser.tabs.get(info.tabId);
          if (tab && tab.url && /^(https?|file):/i.test(tab.url)) {
            const type = key==='floatNoteState' ? 'SHOW_NOTE' : 'SHOW_TAPE';
            browser.tabs.sendMessage(info.tabId, {type}).catch(()=>{});
          }
        }
      }
    } catch(e){}
  });
  browser.storage.onChanged.addListener((changes, area)=>{
    if (area!=='local') return;
    for (const key of ['floatNoteState','floatTapeState']) {
      if (changes[key]) {
        const float = changes[key].newValue;
        if (float && float.isOpen) {
          browser.tabs.query({}).then(tabs=>{
            tabs.forEach(t=>{
              if (t.id && t.url && /^(https?:|file):/i.test(t.url)) {
                const type = key==='floatNoteState' ? 'SHOW_NOTE' : 'SHOW_TAPE';
                browser.tabs.sendMessage(t.id, {type}).catch(()=>{});
              }
            });
          });
        }
      }
    }
  });
} catch(e){}
