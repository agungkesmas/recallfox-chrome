// background.js — Service worker / background script
// RecallFox v3.7.2 (Chrome MV3)
// Tanggung jawab:
//   1. Context menu (save selection as prompt / context / snapshot + screenshot)
//   2. Commands (keyboard shortcuts) — incl. screenshot capture
//   3. Screenshot capture pipeline (visible / entire / selection)
//   4. Sync trigger (debounced)
//   5. Sync listener (merge changes from other devices)
//   6. Side panel toggle (Chrome sidePanel API)

// ===== Chrome/Firefox compatibility polyfill =====
// Firefox pakai browser.*, Chrome pakai chrome.*
// chrome.* callbacks → promises (Chrome MV3 sudah promise-based sebagian besar)
// Untuk API yang masih callback di Chrome (chrome.contextMenus, chrome.tabs.onUpdated),
// kita wrap manual. Sebagian besar API sudah promise-based di MV3.
if (typeof browser === 'undefined' && typeof chrome !== 'undefined') {
  globalThis.browser = chrome;
  // chrome.runtime, chrome.storage, chrome.tabs, dll sudah promise-based di MV3
  // tapi beberapa API legacy masih callback — tambah polyfill jika perlu
}

import {
  pushToSync,
  mergeSyncIntoLocal,
  onSyncChange,
  getSettings,
  saveSettings,
  addItem,
  getVault,
  markBypass,
  isBypassed,
  getUserBlocklist,
  addUserBlocklistEntry,
  removeUserBlocklistEntry,
  clearUserBlocklist,
  exportAllScreenshotBlobs
} from './lib/storage.js';
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
  DEFAULT_CHINA_X_SEARCHES
} from './lib/contentguard.js';
import { DEFAULT_ELEMENT_BLOCKER_RULES } from './lib/elementblocker.js';

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

  // v0.8.36: HAPUS force-inject di onInstalled — bikin duplikat panel + loop.
  // Content script dari manifest.json akan auto-load saat tab di-refresh.
  // User cukup refresh tab YouTube/X manual setelah install.
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

  // v0.8.42: Element Blocker init
  try { await initElementBlockerDefaults(); }
  catch (e) { console.warn('[RecallFox] onStartup: initElementBlockerDefaults failed:', e); }

  // v0.8.44: Auto Tab Discard checker
  try { startAutoDiscardChecker(); }
  catch (e) { console.warn('[RecallFox] onStartup: startAutoDiscardChecker failed:', e); }

  // v0.8.36: HAPUS force-inject di onStartup juga — bikin duplikat + loop
});

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
    contexts: ['page'],
    documentUrlPatterns: [
      'https://chat.z.ai/*',
      'https://chatgpt.com/*',
      'https://claude.ai/*',
      'https://gemini.google.com/*',
      'https://chat.deepseek.com/*',
      'https://tongyi.aliyun.com/*',
      'https://chat.qwen.ai/*',
      'https://kimi.moonshot.cn/*',
      'https://kimi.com/*'
    ]
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
    try {
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
          iconUrl: browser.runtime.getURL('icons/icon-96.png')
        });
      } catch (e) {}
    } else {
      try {
        await browser.notifications.create({
          type: 'basic',
          title: '⚠️ Tidak bisa block element',
          message: 'Arahkan kursor ke elemen yang mau di-block, lalu klik kanan → Block Element Ini. Refresh halaman kalau belum jalan.',
          iconUrl: browser.runtime.getURL('icons/icon-96.png')
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
          iconUrl: browser.runtime.getURL('icons/icon-96.png')
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
            iconUrl: browser.runtime.getURL('icons/icon-96.png')
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
        iconUrl: browser.runtime.getURL('icons/icon-96.png')
      });
    } else if (res?.error === 'duplicate') {
      await browser.notifications.create({
        type: 'basic',
        title: 'ℹ️ Sudah diblokir',
        message: `${label} ini sudah ada di blocklist.`,
        iconUrl: browser.runtime.getURL('icons/icon-96.png')
      });
    } else {
      await browser.notifications.create({
        type: 'basic',
        title: '⚠️ Gagal blokir',
        message: `Error: ${res?.error || 'unknown'}`,
        iconUrl: browser.runtime.getURL('icons/icon-96.png')
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
  const format = settings.screenshotFormat === 'jpeg' ? 'jpeg' : 'png';
  const quality = Math.max(50, Math.min(100, settings.screenshotJpegQuality || 90));
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
  // payload: { dataUrl, width, height, bytes, mode, url, pageTitle }
  let thumbnailDataUrl = '';
  try {
    thumbnailDataUrl = await generateThumbnail(payload.dataUrl, 200);
  } catch (e) {
    console.warn('[RecallFox] thumbnail generation failed:', e);
  }

  const titleGuess = (payload.pageTitle || 'Screenshot').slice(0, 80);
  const modeLabel = payload.mode === 'visible' ? 'Visible' : payload.mode === 'entire' ? 'Full page' : 'Selection';
  const format = payload.dataUrl.startsWith('data:image/jpeg') ? 'jpeg' : 'png';

  const newItem = await addItem({
    type: 'screenshot',
    title: `${titleGuess} — ${modeLabel}`,
    body: `[Screenshot captured ${new Date().toISOString()} from ${payload.url}]`,
    tags: ['screenshot', payload.mode],
    source: {
      url: payload.url,
      title: payload.pageTitle,
      capturedAt: new Date().toISOString()
    },
    screenshotMode: payload.mode,
    screenshotWidth: payload.width,
    screenshotHeight: payload.height,
    screenshotFormat: format,
    screenshotBytes: payload.bytes,
    thumbnailDataUrl,
    screenshotDataUrl: payload.dataUrl
  });

  browser.runtime.sendMessage({ type: 'VAULT_UPDATED' }).catch(() => {});
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
  try {
    const opts = { format: format || 'png' };
    if (format === 'jpeg') opts.quality = (quality || 90) / 100;
    const dataUrl = await browser.tabs.captureVisibleTab(undefined, opts);
    return { ok: true, dataUrl };
  } catch (e) {
    console.error('[RecallFox] captureVisibleTab failed:', e.message);
    // Firefox rate-limit error: "An unexpected error occurred" — wait and retry once
    if (e.message && (e.message.includes('unexpected') || e.message.includes('rate'))) {
      console.log('[RecallFox] Retrying captureVisibleTab after rate-limit delay…');
      await new Promise(r => setTimeout(r, 500));
      try {
        const opts = { format: format || 'png' };
        if (format === 'jpeg') opts.quality = (quality || 90) / 100;
        const dataUrl = await browser.tabs.captureVisibleTab(undefined, opts);
        return { ok: true, dataUrl };
      } catch (e2) {
        console.error('[RecallFox] captureVisibleTab retry failed:', e2.message);
        return { ok: false, error: e2.message };
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
  // Chrome: toggle side panel via keyboard shortcut (replaces Firefox _execute_sidebar_action)
  if (cmd === 'toggle-side-panel') {
    try {
      // Chrome sidePanel API — toggle panel for current window
      await chrome.sidePanel.open({ windowId: (await chrome.windows.getCurrent()).id });
    } catch (e) {
      console.warn('[RecallFox] sidePanel toggle failed:', e);
    }
    return;
  }

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

browser.runtime.onMessage.addListener(async (msg, sender) => {
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
    return false;
  }
  if (msg.type === 'SYNC_NOW') {
    try {
      const ok = await pushToSync();
      return { ok };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  if (msg.type === 'PULL_SYNC') {
    try {
      const ok = await mergeSyncIntoLocal();
      return { ok };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  if (msg.type === 'GET_VAULT') {
    return await getVault();
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
        return { ok: true, action: 'closed' };
      } else {
        await browser.sidebarAction.open();
        console.log('[RecallFox] Sidebar opened');
        return { ok: true, action: 'opened' };
      }
    } catch (e) {
      console.error('[RecallFox] Sidebar toggle failed:', e);
      return { ok: false, error: e.message };
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
      return { ok: true };
    } catch (e) {
      console.error('[RecallFox] SAVE_SELECTION_FROM_CS failed:', e);
      return { ok: false, error: e.message };
    }
  }
  if (msg.type === 'QUICK_SNAPSHOT') {
    // Sent from popup quick-action button — open snapshot modal on active tab
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { ok: false, error: 'no_active_tab' };
    try {
      await browser.tabs.sendMessage(tab.id, { type: 'OPEN_SNAPSHOT_MODAL' });
      return { ok: true };
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
        await browser.tabs.sendMessage(tab.id, { type: 'OPEN_SNAPSHOT_MODAL' });
        return { ok: true };
      } catch (e2) {
        return { ok: false, error: e2.message };
      }
    }
  }
  if (msg.type === 'QUICK_SAVE_SELECTION') {
    // Sent from popup quick-action button — get selection from active tab via scripting API
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { ok: false, error: 'no_active_tab' };
    if (!tab.url || !/^https?:\/\//.test(tab.url)) {
      return { ok: false, error: 'not_http_page' };
    }
    try {
      const results = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.getSelection().toString()
      });
      const text = results?.[0]?.result || '';
      if (!text.trim()) {
        return { ok: false, error: 'no_selection' };
      }
      await addItem({
        type: 'prompt',
        title: text.slice(0, 60).replace(/\s+/g, ' '),
        body: text,
        source: { url: tab.url, title: tab.title, capturedAt: new Date().toISOString() }
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  if (msg.type === 'INJECT_TO_ACTIVE_TAB') {
    // Used by popup/sidebar when on AI domain
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { ok: false, error: 'no_active_tab' };
    try {
      const res = await browser.tabs.sendMessage(tab.id, {
        type: 'INJECT_TEXT',
        text: msg.text,
        mode: msg.mode
      });
      return res;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // v3.6: COPY_TO_CLIPBOARD — fallback untuk popup yang tidak punya akses clipboard
  // (mis. di window popup kecil yang navigator.clipboard undefined)
  if (msg.type === 'COPY_TO_CLIPBOARD') {
    try {
      await navigator.clipboard.writeText(msg.text || '');
      return { ok: true };
    } catch (e) {
      // Fallback: pakai content script di active tab
      try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          await browser.tabs.sendMessage(tab.id, { type: 'COPY_TEXT', text: msg.text });
          return { ok: true };
        }
      } catch (e2) {}
      return { ok: false, error: e.message };
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
          return { ok: false, error: 'passphrase_required' };
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
      return { ok: true, filename, size: content.length };
    } catch (e) {
      console.error('[RecallFox] EXPORT_BACKUP error:', e);
      return { ok: false, error: e.message };
    }
  }

  // v3.7: IMPORT_BACKUP — import vault dari file backup
  if (msg.type === 'IMPORT_BACKUP') {
    try {
      const text = msg.text || '';
      if (!text) return { ok: false, error: 'empty_text' };
      let jsonStr;
      if (isEncryptedBackup(text)) {
        if (!msg.passphrase) return { ok: false, error: 'passphrase_required' };
        try {
          jsonStr = await decryptBackup(text, msg.passphrase);
        } catch (err) {
          return { ok: false, error: err.message === 'WRONG_PASSPHRASE' ? 'Passphrase salah atau file rusak' : 'Gagal decrypt: ' + err.message };
        }
      } else {
        try {
          JSON.parse(text);  // validate
          jsonStr = text;
        } catch (err) {
          return { ok: false, error: 'File backup tidak valid' };
        }
      }
      const parsed = JSON.parse(jsonStr);
      const importedVault = parsed.vault || parsed;
      if (!importedVault || !Array.isArray(importedVault.items)) {
        return { ok: false, error: 'Format backup tidak dikenal' };
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
      return { ok: true, added, skipped };
    } catch (e) {
      console.error('[RecallFox] IMPORT_BACKUP error:', e);
      return { ok: false, error: e.message };
    }
  }

  // v3.7: MANUAL_BACKUP_NOW — trigger backup manual ke Downloads/RecallFox/
  if (msg.type === 'MANUAL_BACKUP_NOW') {
    try {
      const { manualBackupWithTimestamp } = await import('./lib/autobackup.js');
      const result = await manualBackupWithTimestamp();
      return result || { ok: true };
    } catch (e) {
      console.error('[RecallFox] MANUAL_BACKUP_NOW error:', e);
      return { ok: false, error: e.message };
    }
  }
  if (msg.type === 'CAPTURE_VISIBLE_TAB') {
    return await handleCaptureVisible(msg.format, msg.quality);
  }
  if (msg.type === 'CLEAR_CACHE') {
    // Sent from popup/sidebar "Clear Cache" button
    const settings = await getSettings();
    const { clearBrowsingData } = await import('./lib/clearcache.js');
    const res = await clearBrowsingData({
      dataTypes: settings.clearCacheDataTypes,
      timePeriod: settings.clearCacheTimePeriod,
      currentTabOnly: settings.clearCacheCurrentTabOnly,
      reload: settings.clearCacheReload,
      notify: settings.clearCacheNotify
    });
    return res;
  }
  if (msg.type === 'VOLUME_SET') {
    // Set volume for current tab's domain
    const { normalizeDb, setSiteVolume, extractDomain, isRestrictedUrl } = await import('./lib/volume.js');
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { ok: false, error: 'no_tab' };
    const domain = extractDomain(tab.url);
    const dB = normalizeDb(msg.dB);
    await setSiteVolume(domain, dB);
    try {
      await browser.tabs.sendMessage(tab.id, { command: 'setVolume', dB: dB });
    } catch (e) { /* volume-cs.js might not be loaded */ }
    return { ok: true, dB };
  }
  if (msg.type === 'VOLUME_GET') {
    // Get volume for current tab's domain
    const { getSiteVolume, extractDomain, isRestrictedUrl } = await import('./lib/volume.js');
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { ok: false, error: 'no_tab' };
    const domain = extractDomain(tab.url);
    const dB = await getSiteVolume(domain);
    return { ok: true, dB, domain };
  }
  if (msg.type === 'VOLUME_GET_STATE') {
    // Get current audio state from the active tab
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { ok: false, error: 'no_tab' };
    try {
      const res = await browser.tabs.sendMessage(tab.id, { command: 'getAudioControlState' });
      return { ok: true, state: res?.response || { volume: 0, muted: false, mono: false } };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  if (msg.type === 'VOLUME_MUTE') {
    // Toggle mute on active tab
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { ok: false, error: 'no_tab' };
    try {
      await browser.tabs.sendMessage(tab.id, { command: 'setMute', muted: msg.muted });
      return { ok: true, muted: msg.muted };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  if (msg.type === 'RESTART_BACKUP_TIMER') {
    // User changed backup interval in Settings — restart timer
    try {
      const { startBackupInterval } = await import('./lib/autobackup.js');
      await startBackupInterval();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
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
    return { ok: true, enabled: newEnabled };
  }

  // v3.7.2 (Issue 6): Toggle Mode Anak — 1 klik aktif/nonaktifkan YouTube Kids Only + Block Shorts.
  // Saat aktif: semua youtube.com → youtubekids.com, dan /shorts/ diblokir.
  // Saat nonaktif: keduanya mati. Popup bisa panggil ini untuk tombol "Mode Anak".
  if (msg.type === 'TOGGLE_KID_MODE') {
    const s = await getSettings();
    const newOn = msg.enabled !== undefined ? !!msg.enabled : !(s.contentGuardYoutubeKidsOnly === true);
    await saveSettings({
      contentGuardYoutubeKidsOnly: newOn,
      contentGuardBlockShorts: newOn,
      contentGuardKidModeArmUntil: 0
    });
    console.log('[RecallFox] Kid Mode toggled:', newOn);
    return { ok: true, enabled: newOn };
  }

  // v3.7.2 (Issue 6): Toggle Block Shorts saja (tanpa YouTube Kids redirect).
  if (msg.type === 'TOGGLE_BLOCK_SHORTS') {
    const s = await getSettings();
    const newOn = msg.enabled !== undefined ? !!msg.enabled : !(s.contentGuardBlockShorts === true);
    await saveSettings({ contentGuardBlockShorts: newOn });
    console.log('[RecallFox] Block Shorts toggled:', newOn);
    return { ok: true, enabled: newOn };
  }

  if (msg.type === 'PRAYER_FETCH') {
    // Fetch prayer times for today (used by popup/sidebar Prayer tab)
    const s = await getSettings();
    if (!s.prayerEnabled) {
      return { ok: false, error: 'not_enabled' };
    }
    if (typeof s.prayerLatitude !== 'number' || typeof s.prayerLongitude !== 'number') {
      return { ok: false, error: 'no_location' };
    }

    // Check cache: refresh if missing or stale (>24h or different date)
    const cached = s.prayerCachedTimes;
    const today = new Date().toISOString().slice(0, 10);
    if (cached && cached.date === today) {
      return { ok: true, times: cached, fromCache: true };
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
      return { ok: true, times, fromCache: false };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  if (msg.type === 'PRAYER_GEOLOCATE') {
    // Use browser geolocation API to get device coordinates
    // Note: this needs to be triggered from a user gesture in the popup/sidebar
    // because Firefox requires user activation for geolocation prompts.
    // We do the actual getCurrentPosition in popup/sidebar; this handler is
    // only used if popup delegates to background (not recommended).
    return { ok: false, error: 'use_popup_geolocation' };
  }
  if (msg.type === 'PRAYER_REVERSE_GEOCODE') {
    // Reverse geocode coordinates to a human-readable location
    const { reverseGeocode } = await import('./lib/salahtime.js');
    try {
      const location = await reverseGeocode(msg.lat, msg.lng);
      return { ok: true, location };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  if (msg.type === 'PRAYER_GEOCODE') {
    // Geocode an address string to coordinates
    const { geocode } = await import('./lib/salahtime.js');
    try {
      const result = await geocode(msg.address);
      return { ok: true, ...result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  if (msg.type === 'CAPTURE_FOR_PREVIEW') {
    // FireShot-style: capture full page, return dataUrl to caller (overlay.js)
    // Caller then shows modal with PDF/JPG/PNG/Copy/Vault save options.
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { ok: false, error: 'no_active_tab' };
    return await captureFullPage(tab, { mode: msg.mode || 'entire' });
  }
  if (msg.type === 'SAVE_CAPTURE_AS') {
    // Save captured image to Downloads folder as PDF / JPG / PNG
    return await saveCaptureAs(msg);
  }
  if (msg.type === 'SAVE_CAPTURE_TO_VAULT') {
    // Save captured image to vault as screenshot item
    return await saveCaptureToVault(msg);
  }
  if (msg.type === 'CAPTURE_SCREENSHOT') {
    // Legacy: sent from popup/sidebar quick-action button — now triggers the modal flow
    // via overlay.js in the active tab. msg.mode can be 'entire' | 'visible' | 'selection'
    // or undefined (which shows the mode-picker dialog).
    // Guard: only forward string modes; ignore accidental event objects.
    const mode = (typeof msg.mode === 'string') ? msg.mode : undefined;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { ok: false, error: 'no_active_tab' };
    try {
      await browser.tabs.sendMessage(tab.id, {
        type: 'TRIGGER_CAPTURE_FROM_POPUP',
        mode: mode  // forwarded to overlay.js -> triggerCapture(mode)
      });
      return { ok: true, deferred: true };
    } catch (e) {
      // Fallback to direct save (skips modal)
      return await triggerScreenshot(tab, mode || 'entire');
    }
  }
  if (msg.type === 'GET_SCREENSHOT_BLOB') {
    // Lazy-load full image for popup/sidebar preview
    const { getScreenshotBlob } = await import('./lib/storage.js');
    const dataUrl = await getScreenshotBlob(msg.id);
    return { ok: true, dataUrl };
  }
  if (msg.type === 'DOWNLOAD_SCREENSHOT') {
    // Save full image to user's Downloads folder via browser.downloads API
    const { getScreenshotBlob } = await import('./lib/storage.js');
    const dataUrl = await getScreenshotBlob(msg.id);
    if (!dataUrl) return { ok: false, error: 'no_blob' };
    const safeName = (msg.title || 'screenshot').replace(/[^a-z0-9\-_]+/gi, '_').slice(0, 60);
    const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    const ext = msg.format === 'jpeg' ? 'jpg' : 'png';
    try {
      const id = await browser.downloads.download({
        url: dataUrl,
        filename: `RecallFox/${safeName}_${ts}.${ext}`,
        saveAs: false
      });
      return { ok: true, downloadId: id };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  if (msg.type === 'CAPTURE_SNAPSHOT') {
    // sent from snapshot modal in content script — save directly
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    return await addItem({
      type: 'snapshot',
      title: msg.title || 'Untitled snapshot',
      body: msg.body,
      tags: msg.tags || [],
      source: {
        url: msg.url || tab?.url,
        title: msg.pageTitle || tab?.title,
        capturedAt: new Date().toISOString()
      }
    });
  }
  if (msg.type === 'AI_ASK_QUERY') {
    // From selection-ai.js floating button. Delegate to shared orchestrator.
    const text = (msg.text || '').trim();
    if (!text) return { ok: false, error: 'no_text' };
    await routeAiQuery(text, {
      sourceUrl: msg.sourceUrl || '',
      sourceTitle: msg.sourceTitle || ''
    });
    return { ok: true };
  }

  // v0.9.7: Discard handlers — dipindahkan ke listener 1 karena async listener
  // intercept semua message. Kalau di listener 2, response undefined.
  if (msg.type === 'AD_DISCARD_NOW') {
    console.log('[RecallFox/AD] Manual discard triggered');
    const result = await checkAutoDiscard();
    console.log('[RecallFox/AD] Manual result:', JSON.stringify(result));
    return result;
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
    return result;
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
    return { ok: true };
  }

  return false;
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
                  iconUrl: browser.runtime.getURL('icons/icon-96.png'),
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
        iconUrl: browser.runtime.getURL('icons/icon-96.png'),
        priority: 2
      });
      console.log('[RecallFox] Prayer reminder sent:', message);
    } catch (e) {
      console.warn('[RecallFox] Reminder notification failed:', e.message);
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
      const aiPatterns = ['chat.z.ai', 'chatgpt.com', 'claude.ai', 'gemini.google.com'];
      const isOnAI = aiPatterns.some(p => activeUrl.includes(p));
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
          iconUrl: browser.runtime.getURL('icons/icon-96.png'),
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
});

// v0.9.2: PANGGIL DI TOP LEVEL — supaya jalan setiap kali background script load,
// bukan hanya saat onInstalled/onStartup fire
startAutoDiscardChecker();

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
        iconUrl: browser.runtime.getURL('icons/icon-96.png'),
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
  if (!Array.isArray(s.contentGuardUserBlocklist)) {
    patch.contentGuardUserBlocklist = [];
  }
  // v0.8.28: Force-enable master switch & filter feeds — ini SETTING KRITIS
  // yang kalau off, content script tidak akan scan apapun (status panel MATI).
  // Karena user sering tidak sengaja turn off, kita force ON kalau belum pernah
  // diset explicit (undefined). Kalau user explicit set false, hargai.
  if (s.contentGuardEnabled === undefined) {
    patch.contentGuardEnabled = true;
  }
  if (s.contentGuardFilterFeeds === undefined) {
    patch.contentGuardFilterFeeds = true;
  }
  if (s.contentGuardNuclearMode === undefined) {
    patch.contentGuardNuclearMode = true;
  }
  if (s.contentGuardBlockYtChannels === undefined) {
    patch.contentGuardBlockYtChannels = true;
  }
  if (s.contentGuardBlockXAccounts === undefined) {
    patch.contentGuardBlockXAccounts = true;
  }
  if (s.contentGuardScanDescription === undefined) {
    patch.contentGuardScanDescription = true;
  }
  if (s.contentGuardBlockSearchQueries === undefined) {
    patch.contentGuardBlockSearchQueries = true;
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

// Cek apakah URL harus di-redirect ke takeover/blocked
// v0.8.35: Anti-loop guard KUAT — max 1 redirect per tab per 1 JAM (bukan 10 detik)
const lastRedirectMap = new Map();  // tabId → timestamp
const redirectCountMap = new Map(); // tabId → count (kalau > 3 → disable redirect permanen)
async function checkContentGuard(tabId, url, tab) {
  if (!url || !/^https?:\/\//.test(url)) return;
  // Jangan proses URL extension sendiri
  if (url.startsWith(browser.runtime.getURL(''))) return;

  const s = await getSettings();
  if (s.contentGuardEnabled === false) return;

  // ===== v3.7.2 (Issue 6): Mode Anak — YouTube Kids Only =====
  // DIPASANG SEBELUM anti-loop guard karena loop-safe:
  // target redirect (youtubekids.com) dicek via isAlreadyKids, tidak akan redirect ulang.
  if (s.contentGuardYoutubeKidsOnly === true) {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      const isYoutubeMain = host === 'youtube.com' ||
                            host === 'www.youtube.com' ||
                            host === 'm.youtube.com' ||
                            host.endsWith('.youtube.com') ||
                            host === 'youtube-nocookie.com' ||
                            host.endsWith('.youtube-nocookie.com');
      const isAlreadyKids = host === 'youtubekids.com' || host.endsWith('.youtubekids.com');
      if (isYoutubeMain && !isAlreadyKids) {
        const kidsUrl = 'https://www.youtubekids.com';
        console.log('[RecallFox/CG] Kid Mode: redirect youtube.com → youtubekids.com');
        // Tidak pakai redirectWithNotify anti-loop counter — pakai direct update + optional notif
        try { await browser.tabs.update(tabId, { url: kidsUrl }); }
        catch (e) { console.warn('[RecallFox/CG] Kid Mode tab update failed:', e.message); return; }
        if (s.contentGuardNotifyOnBlock !== false) {
          try {
            await browser.notifications.create({
              type: 'basic',
              title: '👶 Mode Anak Aktif',
              message: 'Navigasi YouTube dialihkan ke YouTube Kids.',
              iconUrl: browser.runtime.getURL('icons/icon-96.png'),
              priority: 1
            });
          } catch (e) {}
        }
        return;
      }
    } catch (e) { /* URL parse error — skip */ }
  }

  // ===== v3.7.2 (Issue 6): Block YouTube Shorts navigation =====
  // Loop-safe: target redirect adalah youtube.com/ (home), dan isYouTubeHome() di Case 1
  // hanya aktif saat contentGuardForceRedirect !== false (default false → tidak akan re-redirect).
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
        console.log('[RecallFox/CG] BlockShorts: /shorts/ → home');
        try { await browser.tabs.update(tabId, { url: homeUrl }); }
        catch (e) { console.warn('[RecallFox/CG] BlockShorts tab update failed:', e.message); return; }
        if (s.contentGuardNotifyOnBlock !== false) {
          try {
            await browser.notifications.create({
              type: 'basic',
              title: '🚫 YouTube Shorts Diblokir',
              message: 'Navigasi ke Shorts dicegah. Kembali ke beranda YouTube.',
              iconUrl: browser.runtime.getURL('icons/icon-96.png'),
              priority: 1
            });
          } catch (e) {}
        }
        return;
      }
    } catch (e) { /* URL parse error — skip */ }
  }

  // v0.8.35: ANTI-LOOP KUAT
  // - Max 1 redirect per tab per 1 JAM (3600000 ms)
  // - Kalau sudah redirect 3x dalam 1 jam → disable redirect permanen untuk tab itu
  const now = Date.now();
  const lastRedirect = lastRedirectMap.get(tabId) || 0;
  const redirectCount = redirectCountMap.get(tabId) || 0;

  // Kalau sudah redirect 3x+ → tab ini bermasalah, disable redirect permanen
  if (redirectCount >= 3) {
    return;
  }
  // Kalau redirect < 1 jam yang lalu → skip
  if (now - lastRedirect < 3600000) {
    return;
  }

  // Cek bypass (user sudah klik "Lewati" dalam 60 detik terakhir)
  if (await isBypassed(url)) return;

  // ===== Case 1: YouTube / X home → redirect ke takeover =====
  if (s.contentGuardForceRedirect !== false) {
    if (isYouTubeHome(url)) {
      const takeoverUrl = browser.runtime.getURL('contentguard/takeover.html')
        + '?platform=youtube&url=' + encodeURIComponent(url);
      console.log('[RecallFox/CG] YouTube home → takeover');
      await redirectWithNotify(tabId, takeoverUrl, s,
        'YouTube → Konten Positif Tiongkok',
        'Feed YouTube diganti dengan kurasi konten positif Tiongkok.');
      return;
    }
    if (isXHome(url)) {
      const takeoverUrl = browser.runtime.getURL('contentguard/takeover.html')
        + '?platform=x&url=' + encodeURIComponent(url);
      console.log('[RecallFox/CG] X home → takeover');
      await redirectWithNotify(tabId, takeoverUrl, s,
        'X (Twitter) → Konten Positif Tiongkok',
        'Timeline X diganti dengan kurasi konten positif Tiongkok.');
      return;
    }
  }

  // ===== v0.8.24 Case 1.5: Search query politik → redirect ke search Tiongkok =====
  if (s.contentGuardBlockSearchQueries !== false) {
    const searchInfo = detectSearchQuery(url);
    if (searchInfo && searchInfo.isSearch) {
      const blockedQueries = s.contentGuardBlockedSearchQueries || DEFAULT_BLOCKED_SEARCH_QUERIES;
      const matched = matchesBlockedSearchQuery(searchInfo.query, blockedQueries);
      if (matched) {
        console.log('[RecallFox/CG] Search query blocked:', searchInfo.query, '→ matched:', matched);
        // Redirect ke search positif Tiongkok
        const newSearch = searchInfo.platform === 'youtube'
          ? 'kehidupan di tiongkok vlog'
          : 'china technology';
        const newUrl = searchInfo.platform === 'youtube'
          ? `https://www.youtube.com/results?search_query=${encodeURIComponent(newSearch)}`
          : `https://x.com/search?q=${encodeURIComponent(newSearch)}&src=typed_query&f=top`;
        await redirectWithNotify(tabId, newUrl, s,
          'Pencarian Diblokir',
          `Pencarian "${searchInfo.query.slice(0, 40)}" diarahkan ke konten positif Tiongkok.`);
        return;
      }
    }
  }

  // ===== Case 2: Domain berita Indonesia → redirect ke blocked =====
  if (s.contentGuardBlockIdNews !== false) {
    const matchedDomain = matchesIdNewsDomain(url, s.contentGuardIdNewsDomains);
    if (matchedDomain) {
      const blockedUrl = browser.runtime.getURL('contentguard/blocked.html')
        + '?domain=' + encodeURIComponent(matchedDomain)
        + '&url=' + encodeURIComponent(url);
      console.log('[RecallFox/CG] ID news domain blocked:', matchedDomain);
      await redirectWithNotify(tabId, blockedUrl, s,
        'Berita Negatif Diblokir',
        `Situs ${matchedDomain} diblokir. Arahkan ke konten positif Tiongkok?`);
      return;
    }
  }

  // v0.8.36: HAPUS Case 3 (watch intercept) — kirim CG_RESCAN_NOW setiap watch page
  // bikin loop di content script (scan → modify DOM → MutationObserver → scan → ...)
  // Content script sudah punya interval scan sendiri, tidak perlu paksa dari background.
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
        iconUrl: browser.runtime.getURL('icons/icon-96.png'),
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
        iconUrl: browser.runtime.getURL('icons/icon-96.png'),
        priority: 2
      });
    }
  } catch (e) { /* ignore */ }

  // ===== Chrome: configure side panel behavior =====
  // Set side panel to open when user clicks the action icon's side panel button,
  // OR via Alt+Shift+4 keyboard shortcut.
  try {
    if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
      console.log('[RecallFox] Side panel behavior configured');
    }
  } catch (e) {
    console.warn('[RecallFox] sidePanel.setPanelBehavior failed:', e);
  }
});

// ===== Chrome: handle action click to toggle side panel =====
// In Firefox, sidebar_action auto-toggles. In Chrome, we need to manually open sidePanel.
chrome.action.onClicked.addListener(async (tab) => {
  // Only fires if no popup is set. Since we have a popup, this won't fire.
  // But if user removes popup, this becomes the toggle handler.
  try {
    if (chrome.sidePanel && chrome.sidePanel.open) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch (e) {
    console.warn('[RecallFox] sidePanel.open failed:', e);
  }
});
