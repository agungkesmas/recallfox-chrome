// settings/settings.js — Settings page logic
// RecallFox v0.1.0
// Chrome MV3: Import polyfill + sidebar compat.
import '../lib/browser-polyfill.min.js';
import { openSidebar } from '../lib/sidebar-compat.js';

import {
  getVault,
  saveSettings,
  getSettings,
  exportAllScreenshotBlobs,
  importScreenshotBlobs
} from '../lib/storage.js';
import { encryptBackup, decryptBackup, isEncryptedBackup } from '../lib/crypto.js';
import { getAllTags } from '../lib/search.js';
import { AI_TOOLS, REGION_LABELS } from '../lib/ai-tools.js';
import { getProviderInfo } from '../lib/assistant.js';
import { getAllToppings, BUILTIN_TOPPINGS } from '../lib/toppings.js';
// v3.20.25: Import Paket Link
import { readLinkPackFile, hasImportedPack, importLinkPack, getTypeLabel, getTypeIcon } from '../lib/link-pack.js';

let currentVault = null;

// ===== Theme =====
function applyTheme(theme) {
  let actual = theme;
  if (theme === 'auto') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    actual = prefersDark ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', actual);
}

async function initTheme() {
  const vault = await getVault();
  applyTheme(vault.settings.theme || 'auto');
}

async function init() {
  // Each section wrapped in try-catch so one missing element doesn't break others.
  // Pattern matches sidebar.js / popup.js init() hardening.
  try { currentVault = await getVault(); }
  catch (e) { console.warn('[RecallFox] settings: getVault failed:', e); currentVault = { settings: {} }; }
  try { await initTheme(); }
  catch (e) { console.warn('[RecallFox] settings: initTheme failed:', e); }

  const s = currentVault.settings || {};

  // Helper: safely set element value/checked
  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  const setChk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };

  // === General ===
  try {
    setVal('rf-set-theme', s.theme || 'auto');
    setVal('rf-set-locale', s.locale || 'auto');
    setVal('rf-set-display', s.displayMode || 'popup');
    setVal('rf-set-inject', s.injectMode || 'append');
    setChk('rf-set-floating', s.floatingButtonEnabled !== false);
    setChk('rf-set-overlay', s.overlayButtonEnabled !== false);
    setChk('rf-set-sync', !!s.syncEnabled);
  } catch (e) { console.warn('[RecallFox] settings: general section failed:', e); }

  // === Prayer settings ===
  try {
    setChk('rf-set-prayer-enabled', !!s.prayerEnabled);
    setVal('rf-set-prayer-lat', (typeof s.prayerLatitude === 'number') ? s.prayerLatitude : '');
    setVal('rf-set-prayer-lng', (typeof s.prayerLongitude === 'number') ? s.prayerLongitude : '');
    setVal('rf-set-prayer-loc', s.prayerLocation || '');
    setVal('rf-set-prayer-asr', String(s.prayerAsrSchool || 0));
    setVal('rf-set-prayer-format', s.prayerTimeFormat || '24h');
    setChk('rf-set-prayer-reminder', s.prayerReminderEnabled !== false);
    setVal('rf-set-prayer-reminder-min', String(s.prayerReminderMinutes || 10));
    setChk('rf-set-prayer-sunnah', s.prayerShowSunnah !== false);
    setChk('rf-set-prayer-elapsed', s.prayerShowElapsed !== false);
    setChk('rf-set-prayer-badge', s.prayerShowBadge !== false);
    // v3.11.7-fix (Issue #6): Adzan settings
    setChk('rf-set-prayer-adzan-enabled', s.prayerAdzanEnabled === true);
    const adzanVol = document.getElementById('rf-set-prayer-adzan-volume');
    if (adzanVol) {
      adzanVol.value = s.prayerAdzanVolume ?? 0.7;
      const volLabel = document.getElementById('rf-adzan-vol-label');
      if (volLabel) volLabel.textContent = adzanVol.value;
    }
    setVal('rf-set-prayer-adzan-sound', s.prayerAdzanSound || 'default');
    setVal('rf-set-prayer-adzan-custom-url', s.prayerAdzanCustomUrl || '');
    // Set prayer checkboxes
    const adzanPrayers = Array.isArray(s.prayerAdzanPrayers) && s.prayerAdzanPrayers.length > 0
      ? s.prayerAdzanPrayers
      : ['Fajr','Dhuhr','Asr','Maghrib','Isha'];
    document.querySelectorAll('.rf-adzan-prayer').forEach(cb => {
      cb.checked = adzanPrayers.includes(cb.value);
    });
    // Show/hide adzan options based on enabled state
    _updateAdzanVisibility(s.prayerAdzanEnabled === true, s.prayerAdzanSound || 'default');
  } catch (e) { console.warn('[RecallFox] settings: prayer section failed:', e); }

  // === Habit tracker ===
  try {
    setChk('rf-set-quran-enabled', s.quranEnabled !== false);
    setVal('rf-set-quran-target', s.quranTargetPages || 1);
    setVal('rf-set-quran-time', s.quranReminderTime || '07:00');
    setChk('rf-set-exercise-enabled', s.exerciseEnabled !== false);
    setVal('rf-set-exercise-interval', String(s.exerciseIntervalMinutes || 45));
    setVal('rf-set-exercise-time', s.exerciseReminderTime || '18:30');
    // v0.8.41: Hari ngaji & treadmill
    const quranDays = Array.isArray(s.quranDays) ? s.quranDays : [0,1,2,3,4,5,6];
    document.querySelectorAll('.rf-quran-day').forEach(cb => {
      cb.checked = quranDays.includes(parseInt(cb.value, 10));
    });
    const exerciseDays = Array.isArray(s.exerciseDays) ? s.exerciseDays : [1,3,5];
    document.querySelectorAll('.rf-exercise-day').forEach(cb => {
      cb.checked = exerciseDays.includes(parseInt(cb.value, 10));
    });
    // v3.11.6: Render pintasan web ngaji & olahraga
    renderShortcutEditor('rf-set-quran-shortcuts', s.quranShortcuts, '📖');
    renderShortcutEditor('rf-set-exercise-shortcuts', s.exerciseShortcuts, '🏃');
  } catch (e) { console.warn('[RecallFox] settings: habit tracker section failed:', e); }

  // === Element Blocker (v0.8.42) ===
  try {
    setChk('rf-set-eb-enabled', s.elementBlockerEnabled !== false);
    await renderElementBlockerRules();
  } catch (e) { console.warn('[RecallFox] settings: element blocker section failed:', e); }

  // === Auto Tab Discard (v0.8.44) ===
  try {
    setChk('rf-set-ad-enabled', s.autoDiscardEnabled !== false);
    setVal('rf-set-ad-interval', String(s.autoDiscardInterval || 30));
    setVal('rf-set-ad-min-tabs', String(s.autoDiscardMinTabs || 5));
    setChk('rf-set-ad-exclude-pinned', s.autoDiscardExcludePinned !== false);
    setChk('rf-set-ad-exclude-active', s.autoDiscardExcludeActive !== false);
    setChk('rf-set-ad-exclude-media', s.autoDiscardExcludeMedia !== false);
    const domEl = document.getElementById('rf-set-ad-excluded-domains');
    if (domEl) {
      const doms = s.autoDiscardExcludedDomains || [];
      domEl.value = Array.isArray(doms) ? doms.join('\n') : '';
    }
  } catch (e) { console.warn('[RecallFox] settings: auto discard section failed:', e); }

  // === Persistence ===
  try {
    setChk('rf-set-sidebar-auto', !!s.sidebarAutoOpen);
    setVal('rf-set-sidebar-autoclose', String(s.sidebarAutoCloseMinutes || 0));  // v3.9.0 (Issue 5)
    setChk('rf-set-remember-tab', s.rememberLastTab !== false);
    setVal('rf-set-backup-interval', String(s.backupIntervalHours || 6));
  } catch (e) { console.warn('[RecallFox] settings: persistence section failed:', e); }

  // === Clear Cache settings ===
  try {
    const ccTypes = s.clearCacheDataTypes || ['cache'];
    document.querySelectorAll('#rf-set-cc-types input[type="checkbox"]').forEach(cb => {
      cb.checked = ccTypes.includes(cb.value);
    });
    setVal('rf-set-cc-period', s.clearCacheTimePeriod || 'all');
    setChk('rf-set-cc-tabonly', !!s.clearCacheCurrentTabOnly);
    setChk('rf-set-cc-reload', s.clearCacheReload !== false);
    setChk('rf-set-cc-notify', s.clearCacheNotify !== false);
  } catch (e) { console.warn('[RecallFox] settings: clear cache section failed:', e); }

  // === Screenshot settings ===
  try {
    // v3.11.7-fix (Issue #1): Ganti format/quality → tingkat kompresi tunggal
    setVal('rf-set-shot-compression', s.screenshotCompression || 'high');
    setVal('rf-set-shot-default-mode', s.screenshotDefaultMode || 'visible');
    setVal('rf-set-shot-max-height', s.screenshotMaxFullHeight || 16384);
    setChk('rf-set-shot-sync-full', !!s.screenshotSyncFullImage);
  } catch (e) { console.warn('[RecallFox] settings: screenshot section failed:', e); }

  // === Content Guardian settings (v0.8.20 → 0.8.21) ===
  try {
    setChk('rf-set-cg-enabled', s.contentGuardEnabled !== false);
    setChk('rf-set-cg-block-idnews', s.contentGuardBlockIdNews !== false);
    setChk('rf-set-cg-force-redirect', s.contentGuardForceRedirect !== false);
    setChk('rf-set-cg-filter-feeds', s.contentGuardFilterFeeds !== false);
    setChk('rf-set-cg-block-yt', s.contentGuardBlockYtChannels !== false);
    setChk('rf-set-cg-block-x', s.contentGuardBlockXAccounts !== false);
    setChk('rf-set-cg-strict', s.contentGuardStrictMode !== false);
    setChk('rf-set-cg-notify', s.contentGuardNotifyOnBlock !== false);
    setChk('rf-set-cg-debug', !!s.contentGuardDebugMode);
    setChk('rf-set-cg-nuclear', s.contentGuardNuclearMode !== false);
    setChk('rf-set-cg-block-search', s.contentGuardBlockSearchQueries !== false);
    setChk('rf-set-cg-scan-desc', s.contentGuardScanDescription !== false);

    // Textareas: keywords & domains
    const kwEl = document.getElementById('rf-set-cg-keywords');
    if (kwEl) {
      const kws = s.contentGuardNegativeKeywords || [];
      kwEl.value = Array.isArray(kws) ? kws.join(', ') : '';
    }
    const domEl = document.getElementById('rf-set-cg-domains');
    if (domEl) {
      const doms = s.contentGuardIdNewsDomains || [];
      domEl.value = Array.isArray(doms) ? doms.join('\n') : '';
    }
  } catch (e) { console.warn('[RecallFox] settings: contentguard section failed:', e); }

  // === Render User Blocklist ===
  try { await renderUserBlocklist(); }
  catch (e) { console.warn('[RecallFox] settings: renderUserBlocklist failed:', e); }

  // === Assistant fields ===
  try {
    setVal('rf-set-assistant-provider', s.assistantProvider || 'groq');
    setVal('rf-set-assistant-apikey', s.assistantApiKey || '');
    setVal('rf-set-assistant-model', s.assistantModel || 'llama-3.3-70b-versatile');
    setVal('rf-set-assistant-baseurl', s.assistantBaseUrl || '');
    updateAssistantBaseUrlVisibility();
    updateAssistantModelHint();
  } catch (e) { console.warn('[RecallFox] settings: assistant section failed:', e); }

  // === Fallback fields ===
  try {
    setChk('rf-set-assistant-fallback-enabled', s.assistantFallbackEnabled !== false);
    setVal('rf-set-assistant-fallback-provider', s.assistantFallbackProvider || 'gemini');
    setVal('rf-set-assistant-fallback-apikey', s.assistantFallbackApiKey || '');
    setVal('rf-set-assistant-fallback-model', s.assistantFallbackModel || 'gemini-2.0-flash');
    setVal('rf-set-assistant-fallback-baseurl', s.assistantFallbackBaseUrl || '');
    updateAssistantFallbackBaseUrlVisibility();
    updateAssistantFallbackModelHint();
  } catch (e) { console.warn('[RecallFox] settings: fallback section failed:', e); }

  // === Last sync / backup timestamps ===
  try {
    const ls = s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString() : 'Belum pernah';
    const lsEl = document.getElementById('rf-set-lastsync'); if (lsEl) lsEl.textContent = ls;
    const lb = s.lastBackupAt ? new Date(s.lastBackupAt).toLocaleString() : 'Belum pernah';
    const lbEl = document.getElementById('rf-set-lastbackup'); if (lbEl) lbEl.textContent = lb;
  } catch (e) { console.warn('[RecallFox] settings: timestamps section failed:', e); }

  // === Bind events + render sections (each independent) ===
  try { bindEvents(); }
  catch (e) { console.warn('[RecallFox] settings: bindEvents failed:', e); }
  try { renderStats(); }
  catch (e) { console.warn('[RecallFox] settings: renderStats failed:', e); }
  try { renderAITools(); }
  catch (e) { console.warn('[RecallFox] settings: renderAITools failed:', e); }
  try { renderToppingsList(); }
  catch (e) { console.warn('[RecallFox] settings: renderToppingsList failed:', e); }
}

async function renderToppingsList() {
  const container = document.getElementById('rf-toppings-list-display');
  if (!container) return;
  const all = await getAllToppings();
  const html = all.map(t => {
    const isBuiltin = t.builtIn !== false;
    return `
      <div style="display:flex;gap:10px;padding:10px 0;border-top:1px solid var(--border);">
        <div style="font-size:20px;flex-shrink:0;">${escapeHtml(t.emoji)}</div>
        <div style="flex:1;">
          <div style="font-size:13px;font-weight:600;color:var(--text);">
            ${escapeHtml(t.name)}
            ${isBuiltin ? '<span style="font-size:9px;background:var(--accent-amber-soft);color:#92400e;padding:1px 5px;border-radius:3px;margin-left:6px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;">built-in</span>' : '<span style="font-size:9px;background:var(--accent-green-soft);color:#065f46;padding:1px 5px;border-radius:3px;margin-left:6px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;">custom</span>'}
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${escapeHtml(t.description || '')}</div>
          <details style="margin-top:4px;">
            <summary style="font-size:10px;cursor:pointer;color:var(--text-muted);">Lihat body</summary>
            <pre style="margin-top:4px;padding:8px;background:var(--surface-hover);border-radius:4px;font-size:10px;white-space:pre-wrap;color:var(--text-secondary);border-left:3px solid var(--primary-soft-strong);">${escapeHtml(t.body)}</pre>
          </details>
        </div>
      </div>
    `;
  }).join('');
  container.innerHTML = html;
}

function updateAssistantBaseUrlVisibility() {
  const provider = document.getElementById('rf-set-assistant-provider').value;
  const row = document.getElementById('rf-row-assistant-baseurl');
  const info = getProviderInfo(provider);
  // v3.20.15: Tampilkan Base URL field untuk 'custom' (tidak punya default)
  // dan untuk provider dengan alwaysShowBaseUrl=true (mis. omnirouter — karena
  // URL bisa local atau cloud tergantung install mode user).
  const showRow = (provider === 'custom') || (info && info.alwaysShowBaseUrl);
  row.style.display = showRow ? 'flex' : 'none';
  // v3.20.15: Update placeholder + hint sesuai provider aktif supaya user
  // tahu default URL yang dipakai kalau field dikosongkan.
  const baseUrlInput = document.getElementById('rf-set-assistant-baseurl');
  if (baseUrlInput && info && info.defaultBaseUrl) {
    baseUrlInput.placeholder = info.defaultBaseUrl;
  }
}

// v3.11.7-fix (Issue #6): Helper untuk show/hide adzan options berdasarkan state
function _updateAdzanVisibility(enabled, sound) {
  const show = (id, show) => {
    const el = document.getElementById(id);
    if (el) el.style.display = show ? 'flex' : 'none';
  };
  show('rf-adzan-opts', enabled);
  show('rf-adzan-sound-opts', enabled);
  show('rf-adzan-custom-opts', enabled && sound === 'custom');
  show('rf-adzan-prayers-opts', enabled);
  show('rf-adzan-test-opts', enabled);
}

function updateAssistantModelHint() {
  const provider = document.getElementById('rf-set-assistant-provider').value;
  const info = getProviderInfo(provider);
  const hint = document.getElementById('rf-assistant-model-hint');
  if (hint) {
    hint.textContent = info.defaultModel ? `Default: ${info.defaultModel}` : 'Contoh: llama-3.3-70b-versatile, gemini-2.0-flash';
  }
  // Also update placeholder
  const modelField = document.getElementById('rf-set-assistant-model');
  if (modelField && !modelField.value) {
    modelField.placeholder = info.defaultModel || 'model-name';
  }
}

function updateAssistantFallbackBaseUrlVisibility() {
  const provider = document.getElementById('rf-set-assistant-fallback-provider').value;
  const row = document.getElementById('rf-row-assistant-fallback-baseurl');
  const info = getProviderInfo(provider);
  // v3.20.15: Sama dengan primary — tampilkan juga untuk omnirouter.
  const showRow = (provider === 'custom') || (info && info.alwaysShowBaseUrl);
  row.style.display = showRow ? 'flex' : 'none';
  const baseUrlInput = document.getElementById('rf-set-assistant-fallback-baseurl');
  if (baseUrlInput && info && info.defaultBaseUrl) {
    baseUrlInput.placeholder = info.defaultBaseUrl;
  }
}

function updateAssistantFallbackModelHint() {
  const provider = document.getElementById('rf-set-assistant-fallback-provider').value;
  const info = getProviderInfo(provider);
  const hint = document.getElementById('rf-assistant-fallback-model-hint');
  if (hint) {
    hint.textContent = info.defaultModel ? `Default: ${info.defaultModel}` : 'Contoh: gemini-2.0-flash';
  }
  const modelField = document.getElementById('rf-set-assistant-fallback-model');
  if (modelField && !modelField.value) {
    modelField.placeholder = info.defaultModel || 'model-name';
  }
}


// AI tools yang didukung inject (Tier 1 dari domains.js)
const INJECT_SUPPORTED = new Set([
  'zai', 'chatgpt', 'claude', 'gemini', 'deepseek', 'qwen', 'kimi'
]);

function renderAITools() {
  const grid = document.getElementById('rf-ai-tools-grid');
  if (!grid) return;
  const regions = { local: [], west: [], china: [] };
  for (const t of AI_TOOLS) {
    if (!regions[t.region]) regions[t.region] = [];
    regions[t.region].push(t);
  }
  let html = '';
  for (const region of ['local', 'west', 'china']) {
    for (const t of regions[region]) {
      const supported = INJECT_SUPPORTED.has(t.id);
      const regionClass = region === 'local' ? 'rf-region-local' : region === 'west' ? 'rf-region-west' : 'rf-region-cn';
      html += `
        <div class="rf-domain-card">
          <span class="rf-region ${regionClass}">${REGION_LABELS[region]}</span>
          <span style="font-weight:600;color:#1c1917;">${escapeHtml(t.name)}</span>
          ${supported ? '<span style="color:#059669;font-size:11px;font-weight:600;">✅ inject</span>' : '<span style="color:#9ca3af;font-size:11px;">bookmark</span>'}
        </div>
      `;
    }
  }
  grid.innerHTML = html;
}

function bindEvents() {
  const fields = [
    ['rf-set-theme', 'theme', 'value'],
    ['rf-set-locale', 'locale', 'value'],
    ['rf-set-display', 'displayMode', 'value'],
    ['rf-set-inject', 'injectMode', 'value'],
    ['rf-set-floating', 'floatingButtonEnabled', 'checked'],
    ['rf-set-overlay', 'overlayButtonEnabled', 'checked'],
    ['rf-set-sync', 'syncEnabled', 'checked'],
    // Prayer
    ['rf-set-prayer-enabled', 'prayerEnabled', 'checked'],
    ['rf-set-prayer-asr', 'prayerAsrSchool', 'value'],
    ['rf-set-prayer-format', 'prayerTimeFormat', 'value'],
    ['rf-set-prayer-reminder', 'prayerReminderEnabled', 'checked'],
    ['rf-set-prayer-reminder-min', 'prayerReminderMinutes', 'value'],
    ['rf-set-prayer-sunnah', 'prayerShowSunnah', 'checked'],
    ['rf-set-prayer-elapsed', 'prayerShowElapsed', 'checked'],
    ['rf-set-prayer-badge', 'prayerShowBadge', 'checked'],
    // v3.11.7-fix (Issue #6): Adzan settings
    ['rf-set-prayer-adzan-enabled', 'prayerAdzanEnabled', 'checked'],
    ['rf-set-prayer-adzan-volume', 'prayerAdzanVolume', 'value'],
    ['rf-set-prayer-adzan-sound', 'prayerAdzanSound', 'value'],
    ['rf-set-prayer-adzan-custom-url', 'prayerAdzanCustomUrl', 'value'],
    // Habit tracker
    ['rf-set-quran-enabled', 'quranEnabled', 'checked'],
    ['rf-set-quran-target', 'quranTargetPages', 'value'],
    ['rf-set-quran-time', 'quranReminderTime', 'value'],
    ['rf-set-exercise-enabled', 'exerciseEnabled', 'checked'],
    ['rf-set-exercise-interval', 'exerciseIntervalMinutes', 'value'],
    ['rf-set-exercise-time', 'exerciseReminderTime', 'value'],
    ['rf-set-eb-enabled', 'elementBlockerEnabled', 'checked'],
    // Auto Tab Discard
    ['rf-set-ad-enabled', 'autoDiscardEnabled', 'checked'],
    ['rf-set-ad-interval', 'autoDiscardInterval', 'value'],
    ['rf-set-ad-min-tabs', 'autoDiscardMinTabs', 'value'],
    ['rf-set-ad-exclude-pinned', 'autoDiscardExcludePinned', 'checked'],
    ['rf-set-ad-exclude-active', 'autoDiscardExcludeActive', 'checked'],
    ['rf-set-ad-exclude-media', 'autoDiscardExcludeMedia', 'checked'],
    // Persistence
    ['rf-set-sidebar-auto', 'sidebarAutoOpen', 'checked'],
    ['rf-set-sidebar-autoclose', 'sidebarAutoCloseMinutes', 'value'],  // v3.9.0 (Issue 5)
    ['rf-set-remember-tab', 'rememberLastTab', 'checked'],
    ['rf-set-backup-interval', 'backupIntervalHours', 'value'],
    // Clear Cache
    ['rf-set-cc-period', 'clearCacheTimePeriod', 'value'],
    ['rf-set-cc-tabonly', 'clearCacheCurrentTabOnly', 'checked'],
    ['rf-set-cc-reload', 'clearCacheReload', 'checked'],
    ['rf-set-cc-notify', 'clearCacheNotify', 'checked'],
    // Screenshot (v3.11.7-fix Issue #1: format+quality → compression single dropdown)
    ['rf-set-shot-compression', 'screenshotCompression', 'value'],
    ['rf-set-shot-default-mode', 'screenshotDefaultMode', 'value'],
    ['rf-set-shot-max-height', 'screenshotMaxFullHeight', 'value'],
    ['rf-set-shot-sync-full', 'screenshotSyncFullImage', 'checked'],
    // Content Guardian
    ['rf-set-cg-enabled', 'contentGuardEnabled', 'checked'],
    ['rf-set-cg-block-idnews', 'contentGuardBlockIdNews', 'checked'],
    ['rf-set-cg-force-redirect', 'contentGuardForceRedirect', 'checked'],
    ['rf-set-cg-filter-feeds', 'contentGuardFilterFeeds', 'checked'],
    ['rf-set-cg-block-yt', 'contentGuardBlockYtChannels', 'checked'],
    ['rf-set-cg-block-x', 'contentGuardBlockXAccounts', 'checked'],
    ['rf-set-cg-strict', 'contentGuardStrictMode', 'checked'],
    ['rf-set-cg-notify', 'contentGuardNotifyOnBlock', 'checked'],
    ['rf-set-cg-debug', 'contentGuardDebugMode', 'checked'],
    ['rf-set-cg-nuclear', 'contentGuardNuclearMode', 'checked'],
    ['rf-set-cg-block-search', 'contentGuardBlockSearchQueries', 'checked'],
    ['rf-set-cg-scan-desc', 'contentGuardScanDescription', 'checked'],
    // Primary assistant
    ['rf-set-assistant-provider', 'assistantProvider', 'value'],
    ['rf-set-assistant-apikey', 'assistantApiKey', 'value'],
    ['rf-set-assistant-model', 'assistantModel', 'value'],
    ['rf-set-assistant-baseurl', 'assistantBaseUrl', 'value'],
    // Fallback assistant
    ['rf-set-assistant-fallback-enabled', 'assistantFallbackEnabled', 'checked'],
    ['rf-set-assistant-fallback-provider', 'assistantFallbackProvider', 'value'],
    ['rf-set-assistant-fallback-apikey', 'assistantFallbackApiKey', 'value'],
    ['rf-set-assistant-fallback-model', 'assistantFallbackModel', 'value'],
    ['rf-set-assistant-fallback-baseurl', 'assistantFallbackBaseUrl', 'value']
  ];

  const textFields = new Set([
    'assistantApiKey', 'assistantModel', 'assistantBaseUrl',
    'assistantFallbackApiKey', 'assistantFallbackModel', 'assistantFallbackBaseUrl'
  ]);

  fields.forEach(([id, key, prop]) => {
    const el = document.getElementById(id);
    if (!el) return;
    const isText = textFields.has(key);
    const ev = isText ? 'input' : 'change';
    el.addEventListener(ev, async (e) => {
      const val = e.target[prop];
      console.log('[RecallFox/Settings] Saving:', { id, key, value: val });
      try {
        await saveSettings({ [key]: val });
        console.log('[RecallFox/Settings] Saved OK:', key, '=', val);
      } catch (err) {
        console.error('[RecallFox/Settings] Save FAILED:', key, err);
        toast('Gagal simpan: ' + err.message);
        return;
      }
      if (key === 'theme') {
        applyTheme(val);
      }
      if (key === 'assistantProvider') {
        updateAssistantBaseUrlVisibility();
        updateAssistantModelHint();
      }
      if (key === 'assistantFallbackProvider') {
        updateAssistantFallbackBaseUrlVisibility();
        updateAssistantFallbackModelHint();
      }
      if (!isText) {
        toast('✓ Tersimpan: ' + key.replace('contentGuard', ''));
      }
      // trigger initial sync push if sync just enabled
      if (key === 'syncEnabled' && val === true) {
        await browser.runtime.sendMessage({ type: 'SYNC_NOW' });
      }
      // Broadcast ke content scripts kalau setting Content Guardian berubah
      if (key.startsWith('contentGuard')) {
        console.log('[RecallFox/Settings] Broadcasting CG_SETTINGS_UPDATED...');
        try {
          await browser.runtime.sendMessage({ type: 'CG_SETTINGS_UPDATED' });
          console.log('[RecallFox/Settings] Broadcast OK');
        } catch (e) {
          console.warn('[RecallFox/Settings] Broadcast failed:', e);
        }
        // v0.8.26: Juga kirim CG_FORCE_RESCAN ke semua tabs YouTube/X
        try {
          const tabs = await browser.tabs.query({ url: ['*://*.youtube.com/*', '*://*.x.com/*', '*://*.twitter.com/*'] });
          console.log('[RecallFox/Settings] Force-rescanning', tabs.length, 'YouTube/X tabs');
          for (const t of tabs) {
            browser.tabs.sendMessage(t.id, { type: 'CG_RESCAN_NOW' }).catch(() => {});
          }
        } catch (e) {}
      }
      // v0.8.43: Broadcast EB_RULES_UPDATED kalau setting Element Blocker berubah
      if (key.startsWith('elementBlocker')) {
        console.log('[RecallFox/Settings] Broadcasting EB_RULES_UPDATED...');
        try {
          await browser.runtime.sendMessage({ type: 'EB_RULES_UPDATED' });
        } catch (e) {}
        // Juga broadcast langsung ke semua tabs (bukan hanya via background)
        try {
          const tabs = await browser.tabs.query({ url: ['http://*/*', 'https://*/*'] });
          for (const t of tabs) {
            browser.tabs.sendMessage(t.id, { type: 'EB_RULES_UPDATED' }).catch(() => {});
          }
        } catch (e) {}
      }
      // v3.11.7-fix (Issue #6): Update visibility adzan options saat toggle/sound berubah
      if (key === 'prayerAdzanEnabled') {
        const soundEl = document.getElementById('rf-set-prayer-adzan-sound');
        _updateAdzanVisibility(val === true, soundEl ? soundEl.value : 'default');
      }
      if (key === 'prayerAdzanSound') {
        const enabledEl = document.getElementById('rf-set-prayer-adzan-enabled');
        _updateAdzanVisibility(enabledEl ? enabledEl.checked : false, val);
      }
      // v3.11.7-fix (Issue #6): Save prayer checkboxes (array) — handler terpisah di bawah
    });
  });

  // v3.11.7-fix (Issue #6): Adzan — event listeners khusus
  // Volume slider — update label real-time
  const adzanVolSlider = document.getElementById('rf-set-prayer-adzan-volume');
  if (adzanVolSlider) {
    const volLabel = document.getElementById('rf-adzan-vol-label');
    adzanVolSlider.addEventListener('input', () => {
      if (volLabel) volLabel.textContent = adzanVolSlider.value;
    });
  }
  // Prayer checkboxes — save sebagai array
  document.querySelectorAll('.rf-adzan-prayer').forEach(cb => {
    cb.addEventListener('change', async () => {
      const selected = [...document.querySelectorAll('.rf-adzan-prayer:checked')].map(c => c.value);
      await saveSettings({ prayerAdzanPrayers: selected });
      toast('✓ Tersimpan: waktu adzan');
    });
  });
  // Test Adzan button — v3.11.9 (Issue #3 fix): mainkan tone LANGSUNG di settings page.
  // Sebelumnya: pakai URL IslamicFinder yang 404 → error terus.
  // Sekarang: pakai Web Audio API generate tone (pasti jalan, no CORS, no 404).
  // Kalau user set custom URL, pakai Audio element dengan URL custom.
  const testAdzanBtn = document.getElementById('rf-set-prayer-adzan-test');
  if (testAdzanBtn) {
    let _settingsAdzanAudio = null;
    let _settingsAdzanCtx = null;
    testAdzanBtn.addEventListener('click', async () => {
      try {
        const s = await getSettings();
        // Stop adzan sebelumnya kalau ada
        if (_settingsAdzanAudio) {
          try { _settingsAdzanAudio.pause(); } catch (e) {}
          _settingsAdzanAudio = null;
        }
        if (_settingsAdzanCtx) {
          try { _settingsAdzanCtx.close(); } catch (e) {}
          _settingsAdzanCtx = null;
        }

        const vol = Math.max(0, Math.min(1, Number(s.prayerAdzanVolume) || 0.7));
        const sound = s.prayerAdzanSound || 'default';
        const customUrl = s.prayerAdzanCustomUrl || '';

        // Update button text supaya user tahu sedang play
        const origText = testAdzanBtn.textContent;
        testAdzanBtn.textContent = '⏹ Stop Adzan';
        testAdzanBtn.style.background = '#fee2e2';
        testAdzanBtn.style.color = '#991b1b';

        const resetBtn = () => {
          testAdzanBtn.textContent = origText;
          testAdzanBtn.style.background = '';
          testAdzanBtn.style.color = '';
          _settingsAdzanAudio = null;
          _settingsAdzanCtx = null;
        };

        if (sound === 'custom' && customUrl) {
          // Custom URL — pakai Audio element
          _settingsAdzanAudio = new Audio(customUrl);
          _settingsAdzanAudio.volume = vol;
          _settingsAdzanAudio.crossOrigin = 'anonymous';
          _settingsAdzanAudio.onended = resetBtn;
          _settingsAdzanAudio.onerror = () => {
            toast('Custom URL gagal — fallback ke tone', false);
            resetBtn();
            _playSettingsAdzanTone(vol, false, resetBtn, ctx => _settingsAdzanCtx = ctx);
          };
          _settingsAdzanAudio.play().catch(e => {
            toast('Custom URL gagal: ' + e.message + ' — fallback ke tone', false);
            resetBtn();
            _playSettingsAdzanTone(vol, false, resetBtn, ctx => _settingsAdzanCtx = ctx);
          });
        } else {
          // Default/short — pakai Web Audio API tone
          _playSettingsAdzanTone(vol, sound === 'short', resetBtn, ctx => _settingsAdzanCtx = ctx);
        }

        // Click lagi untuk stop (pakai flag)
        if (!testAdzanBtn._stopBound) {
          testAdzanBtn.addEventListener('click', (e) => {
            // Kalau button text = "Stop Adzan", berarti sedang play → stop
            if (testAdzanBtn.textContent.includes('Stop')) {
              if (_settingsAdzanAudio) {
                try { _settingsAdzanAudio.pause(); } catch (err) {}
              }
              if (_settingsAdzanCtx) {
                try { _settingsAdzanCtx.close(); } catch (err) {}
              }
              testAdzanBtn.textContent = '🔔 Test Adzan';
              testAdzanBtn.style.background = '';
              testAdzanBtn.style.color = '';
            }
          }, true);
          testAdzanBtn._stopBound = true;
        }
        toast('🔔 Adzan diputar — klik tombol lagi untuk stop');
      } catch (e) {
        toast('Gagal test adzan: ' + e.message, false);
      }
    });

    // v3.11.9: Helper untuk play adzan tone di settings page
    function _playSettingsAdzanTone(vol, isShort, onEnd, saveCtx) {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) {
          toast('Browser tidak support Web Audio API', false);
          return;
        }
        const ctx = new AudioCtx();
        saveCtx(ctx);
        const now = ctx.currentTime;
        const notes = isShort
          ? [
            { freq: 440, start: 0, dur: 1.5 },
            { freq: 392, start: 1.5, dur: 1.0 },
            { freq: 440, start: 2.5, dur: 1.5 },
            { freq: 349, start: 4.0, dur: 2.0 },
          ]
          : [
            { freq: 440, start: 0, dur: 1.5 },
            { freq: 392, start: 1.5, dur: 1.0 },
            { freq: 440, start: 2.5, dur: 1.5 },
            { freq: 392, start: 4.0, dur: 1.0 },
            { freq: 349, start: 5.0, dur: 1.5 },
            { freq: 392, start: 6.5, dur: 1.0 },
            { freq: 440, start: 7.5, dur: 3.0 },
          ];
        const masterGain = ctx.createGain();
        masterGain.gain.value = vol;
        masterGain.connect(ctx.destination);
        for (const note of notes) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = note.freq;
          const start = now + note.start;
          const end = start + note.dur;
          gain.gain.setValueAtTime(0, start);
          gain.gain.linearRampToValueAtTime(vol, start + 0.05);
          gain.gain.linearRampToValueAtTime(vol * 0.7, start + note.dur * 0.7);
          gain.gain.linearRampToValueAtTime(0, end);
          osc.connect(gain);
          gain.connect(masterGain);
          osc.start(start);
          osc.stop(end + 0.1);
        }
        // Auto-reset setelah selesai
        const totalDur = notes[notes.length - 1].start + notes[notes.length - 1].dur + 0.5;
        setTimeout(() => {
          try { ctx.close(); } catch (e) {}
          onEnd();
        }, totalDur * 1000);
      } catch (e) {
        toast('Adzan tone failed: ' + e.message, false);
      }
    }
  }

  // ===== Content Guardian: textarea bindings (keywords & domains) =====
  const cgKeywordsEl = document.getElementById('rf-set-cg-keywords');
  if (cgKeywordsEl) {
    let kwTimer = null;
    cgKeywordsEl.addEventListener('input', () => {
      clearTimeout(kwTimer);
      kwTimer = setTimeout(async () => {
        const arr = cgKeywordsEl.value
          .split(',')
          .map(s => s.trim())
          .filter(s => s.length > 0);
        await saveSettings({ contentGuardNegativeKeywords: arr });
        try { await browser.runtime.sendMessage({ type: 'CG_SETTINGS_UPDATED' }); } catch (e) {}
      }, 700);
    });
    cgKeywordsEl.addEventListener('blur', () => toast('Tersimpan'));
  }

  const cgDomainsEl = document.getElementById('rf-set-cg-domains');
  if (cgDomainsEl) {
    let domTimer = null;
    cgDomainsEl.addEventListener('input', () => {
      clearTimeout(domTimer);
      domTimer = setTimeout(async () => {
        const arr = cgDomainsEl.value
          .split('\n')
          .map(s => s.trim())
          .filter(s => s.length > 0);
        await saveSettings({ contentGuardIdNewsDomains: arr });
        try { await browser.runtime.sendMessage({ type: 'CG_SETTINGS_UPDATED' }); } catch (e) {}
      }, 700);
    });
    cgDomainsEl.addEventListener('blur', () => toast('Tersimpan'));
  }

  // v0.8.44: Auto Tab Discard — textarea excluded domains
  const adDomainsEl = document.getElementById('rf-set-ad-excluded-domains');

  // v0.9.2: Discard Now button
  const discardNowBtn = document.getElementById('rf-set-ad-discard-now');
  if (discardNowBtn) {
    discardNowBtn.addEventListener('click', async () => {
      const orig = discardNowBtn.textContent;
      discardNowBtn.disabled = true;
      discardNowBtn.textContent = '🗑️ Discarding...';
      try {
        const res = await browser.runtime.sendMessage({ type: 'AD_DISCARD_NOW' });
        console.log('[RecallFox/AD] Discard response:', res);
        if (res && res.ok) {
          discardNowBtn.textContent = '✓ ' + res.discarded + ' discarded';
          if (res.discarded > 0) {
            toast('✓ ' + res.discarded + ' tab di-discard! Cek tab bar — ' + res.discarded + ' tab berubah abu-abu.');
          } else {
            toast('Tidak ada tab yang di-discard. ' + res.skipped + ' tab di-skip (aktif/pinned/idle belum cukup). Total: ' + res.total + ' tab.');
          }
        } else if (res && res.error) {
          discardNowBtn.textContent = '⚠️ ' + res.error;
          toast('Info: ' + res.error + ' (discarded=' + res.discarded + ', skipped=' + res.skipped + ', total=' + res.total + ')');
        } else {
          discardNowBtn.textContent = '⚠️ No response';
          toast('Tidak ada response dari background. Cek about:debugging → RecallFox → Inspect → Console.');
        }
      } catch (e) {
        discardNowBtn.textContent = '⚠️ Error';
        toast('Error: ' + e.message);
        console.error('[RecallFox/AD] Discard button error:', e);
      } finally {
        setTimeout(() => {
          discardNowBtn.disabled = false;
          discardNowBtn.textContent = orig;
        }, 5000);
      }
    });
  }

  // v0.9.4: Force Discard ALL button
  const forceDiscardBtn = document.getElementById('rf-set-ad-force-discard');
  if (forceDiscardBtn) {
    forceDiscardBtn.addEventListener('click', async () => {
      if (!confirm('FORCE discard SEMUA tab non-aktif sekarang? Tab yang sedang aktif/pinned/playing media tidak akan di-discard.')) return;
      const orig = forceDiscardBtn.textContent;
      forceDiscardBtn.disabled = true;
      forceDiscardBtn.textContent = '💥 Force discarding...';
      try {
        const res = await browser.runtime.sendMessage({ type: 'AD_FORCE_DISCARD_ALL' });
        console.log('[RecallFox/AD] Force discard response:', res);
        if (res && res.ok) {
          forceDiscardBtn.textContent = '✓ ' + res.discarded + ' discarded!';
          if (res.discarded > 0) {
            toast('💥 ' + res.discarded + ' tab di-FORCE discard! Cek tab bar — ' + res.discarded + ' tab berubah abu-abu.');
          } else {
            toast('0 tab di-discard. ' + res.skipped + ' tab di-skip (aktif/pinned/media). Mungkin semua tab sudah discarded atau aktif.');
          }
        } else {
          forceDiscardBtn.textContent = '⚠️ Gagal';
          toast('Gagal: ' + (res?.error || 'unknown'));
        }
      } catch (e) {
        forceDiscardBtn.textContent = '⚠️ Error';
        toast('Error: ' + e.message);
      } finally {
        setTimeout(() => {
          forceDiscardBtn.disabled = false;
          forceDiscardBtn.textContent = orig;
        }, 5000);
      }
    });
  }

  // v0.9.0: Element Blocker — Tambah Domain Custom
  const ebPresetSel = document.getElementById('rf-set-eb-new-preset');
  const ebCustomWrap = document.getElementById('rf-set-eb-custom-selectors-wrap');
  if (ebPresetSel && ebCustomWrap) {
    ebPresetSel.addEventListener('change', () => {
      ebCustomWrap.style.display = ebPresetSel.value === 'custom' ? 'block' : 'none';
    });
  }

  const ebAddBtn = document.getElementById('rf-set-eb-add-rule');
  if (ebAddBtn) {
    ebAddBtn.addEventListener('click', async () => {
      const domainInput = document.getElementById('rf-set-eb-new-domain');
      const presetSel = document.getElementById('rf-set-eb-new-preset');
      const customTA = document.getElementById('rf-set-eb-custom-selectors');
      const domain = (domainInput?.value || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (!domain) { toast('Isi domain dulu'); return; }
      const preset = presetSel?.value || 'generic';

      // Get existing rules
      let rules = [];
      try {
        const resp = await browser.runtime.sendMessage({ type: 'EB_GET_RULES' });
        if (resp && resp.rules) rules = resp.rules;
      } catch (e) {}

      // Cek duplikat
      if (rules.some(r => r.domain === domain)) {
        toast('Domain sudah ada di daftar');
        return;
      }

      // Build new rule
      let newRule;
      if (preset === 'custom') {
        const selectors = (customTA?.value || '').split(',').map(s => s.trim()).filter(s => s.length > 0);
        if (selectors.length === 0) { toast('Isi minimal 1 selector'); return; }
        newRule = {
          id: 'custom_' + Date.now().toString(36),
          name: 'Custom: ' + domain,
          domain, enabled: true, isPreset: false,
          selectors, blockDomains: [], blockPopups: true
        };
      } else {
        try {
          const eb = await import('../lib/elementblocker.js');
          const template = eb.PRESET_TEMPLATES[preset];
          newRule = {
            id: 'custom_' + Date.now().toString(36),
            name: template.name + ': ' + domain,
            domain, enabled: true, isPreset: false,
            selectors: template.selectors,
            blockDomains: template.blockDomains,
            blockPopups: template.blockPopups
          };
        } catch (e) { toast('Gagal load preset: ' + e.message); return; }
      }

      // Save
      rules.push(newRule);
      try {
        await browser.runtime.sendMessage({ type: 'EB_SAVE_RULES', rules });
        toast('Rule ditambahkan untuk ' + domain);
        if (domainInput) domainInput.value = '';
        if (customTA) customTA.value = '';
        await renderElementBlockerRules();
      } catch (e) { toast('Gagal: ' + e.message); }
    });
  }
  if (adDomainsEl) {
    let adDomTimer = null;
    adDomainsEl.addEventListener('input', () => {
      clearTimeout(adDomTimer);
      adDomTimer = setTimeout(async () => {
        const arr = adDomainsEl.value
          .split('\n')
          .map(s => s.trim())
          .filter(s => s.length > 0);
        await saveSettings({ autoDiscardExcludedDomains: arr });
      }, 700);
    });
    adDomainsEl.addEventListener('blur', () => toast('Tersimpan'));
  }

  // ===== Content Guardian: test buttons =====
  const testYtBtn = document.getElementById('rf-set-cg-test-takeover-yt');
  if (testYtBtn) {
    testYtBtn.addEventListener('click', () => {
      const url = browser.runtime.getURL('contentguard/takeover.html')
        + '?platform=youtube&url=' + encodeURIComponent('https://www.youtube.com/');
      browser.tabs.create({ url });
    });
  }
  const testXBtn = document.getElementById('rf-set-cg-test-takeover-x');
  if (testXBtn) {
    testXBtn.addEventListener('click', () => {
      const url = browser.runtime.getURL('contentguard/takeover.html')
        + '?platform=x&url=' + encodeURIComponent('https://x.com/home');
      browser.tabs.create({ url });
    });
  }
  const testBlockedBtn = document.getElementById('rf-set-cg-test-blocked');
  if (testBlockedBtn) {
    testBlockedBtn.addEventListener('click', () => {
      const url = browser.runtime.getURL('contentguard/blocked.html')
        + '?domain=detik.com&url=' + encodeURIComponent('https://www.detik.com/');
      browser.tabs.create({ url });
    });
  }
  const resetCgBtn = document.getElementById('rf-set-cg-reset');
  if (resetCgBtn) {
    resetCgBtn.addEventListener('click', async () => {
      if (!confirm('Reset kata kunci & domain berita ke default? Custom list Anda akan hilang.')) return;
      try {
        const resp = await browser.runtime.sendMessage({ type: 'CG_GET_SETTINGS' });
        const defaults = {
          contentGuardNegativeKeywords: resp?.settings?.contentGuardNegativeKeywords || [],
          contentGuardIdNewsDomains: resp?.settings?.contentGuardIdNewsDomains || []
        };
        // Reload defaults dari lib/contentguard.js via dynamic import
        const cg = await import('../lib/contentguard.js');
        await saveSettings({
          contentGuardNegativeKeywords: cg.DEFAULT_NEGATIVE_KEYWORDS,
          contentGuardIdNewsDomains: cg.DEFAULT_ID_NEWS_DOMAINS,
          contentGuardChinaSearches: cg.DEFAULT_CHINA_YOUTUBE_SEARCHES,
          contentGuardChinaXAccounts: cg.DEFAULT_CHINA_X_ACCOUNTS,
          contentGuardChinaXSearches: cg.DEFAULT_CHINA_X_SEARCHES
        });
        // Re-render textareas
        const kwEl = document.getElementById('rf-set-cg-keywords');
        if (kwEl) kwEl.value = cg.DEFAULT_NEGATIVE_KEYWORDS.join(', ');
        const domEl = document.getElementById('rf-set-cg-domains');
        if (domEl) domEl.value = cg.DEFAULT_ID_NEWS_DOMAINS.join('\n');
        try { await browser.runtime.sendMessage({ type: 'CG_SETTINGS_UPDATED' }); } catch (e) {}
        toast('Reset ke default');
      } catch (e) {
        toast('Gagal reset: ' + e.message);
      }
    });
  }

  // v0.8.28: FORCE ENABLE ALL — nyalakan SEMUA Content Guardian settings critical
  const forceEnableBtn = document.getElementById('rf-set-cg-force-enable');
  if (forceEnableBtn) {
    forceEnableBtn.addEventListener('click', async () => {
      if (!confirm('🚨 FORCE ENABLE ALL akan menyalakan SEMUA setting Content Guardian:\n\n' +
                   '✓ Master switch ON\n' +
                   '✓ Filter feed ON\n' +
                   '✓ Block berita Indonesia ON\n' +
                   '✓ Force redirect YouTube/X ON\n' +
                   '✓ Block channel YT berita ON\n' +
                   '✓ Block akun X berita ON\n' +
                   '✓ Nuclear Mode ON\n' +
                   '✓ Block pencarian politik ON\n' +
                   '✓ Scan deskripsi video ON\n' +
                   '✓ Mode paksa (2x klik) ON\n' +
                   '✓ Notifikasi ON\n\n' +
                   'Lanjutkan?')) return;
      const orig = forceEnableBtn.textContent;
      forceEnableBtn.disabled = true;
      forceEnableBtn.textContent = '🚨 Menyalakan semua...';
      try {
        // Force-enable SEMUA settings critical
        await saveSettings({
          contentGuardEnabled: true,
          contentGuardBlockIdNews: true,
          contentGuardForceRedirect: true,
          contentGuardFilterFeeds: true,
          contentGuardBlockYtChannels: true,
          contentGuardBlockXAccounts: true,
          contentGuardStrictMode: true,
          contentGuardNotifyOnBlock: true,
          contentGuardDebugMode: false,
          contentGuardNuclearMode: true,
          contentGuardBlockSearchQueries: true,
          contentGuardInterceptWatch: true,
          contentGuardScanDescription: true
        });
        console.log('[RecallFox/Settings] FORCE ENABLE ALL — settings saved');

        // Update UI toggles
        const setChk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };
        setChk('rf-set-cg-enabled', true);
        setChk('rf-set-cg-block-idnews', true);
        setChk('rf-set-cg-force-redirect', true);
        setChk('rf-set-cg-filter-feeds', true);
        setChk('rf-set-cg-block-yt', true);
        setChk('rf-set-cg-block-x', true);
        setChk('rf-set-cg-strict', true);
        setChk('rf-set-cg-notify', true);
        setChk('rf-set-cg-debug', false);
        setChk('rf-set-cg-nuclear', true);
        setChk('rf-set-cg-block-search', true);
        setChk('rf-set-cg-scan-desc', true);

        // Broadcast
        await browser.runtime.sendMessage({ type: 'CG_SETTINGS_UPDATED' });

        // Force re-scan semua tab YouTube/X
        const tabs = await browser.tabs.query({ url: [
          '*://*.youtube.com/*', '*://*.youtube-nocookie.com/*',
          '*://*.x.com/*', '*://*.twitter.com/*'
        ] });
        for (const t of tabs) {
          browser.tabs.sendMessage(t.id, { type: 'CG_RESCAN_NOW' }).catch(() => {});
        }

        forceEnableBtn.textContent = '✓ SEMUA DINYALAKAN!';
        toast(`✓ Force Enable All berhasil! ${tabs.length} tab di-rescan. Refresh tab YouTube/X (Ctrl+Shift+R).`);
        setTimeout(() => {
          forceEnableBtn.disabled = false;
          forceEnableBtn.textContent = orig;
        }, 5000);
      } catch (e) {
        forceEnableBtn.textContent = '⚠ Error';
        toast('Error: ' + e.message);
        setTimeout(() => {
          forceEnableBtn.disabled = false;
          forceEnableBtn.textContent = orig;
        }, 2000);
      }
    });
  }

  // v0.8.26: Force Re-scan All Tabs
  const forceRescanBtn = document.getElementById('rf-set-cg-force-rescan');
  if (forceRescanBtn) {
    forceRescanBtn.addEventListener('click', async () => {
      const orig = forceRescanBtn.textContent;
      forceRescanBtn.disabled = true;
      forceRescanBtn.textContent = '🔄 Re-scanning...';
      try {
        // 1. Reload settings dari lib/contentguard.js defaults
        const cg = await import('../lib/contentguard.js');
        const s = await getSettings();
        // Pastikan settings terbaru tersimpan
        await saveSettings({
          contentGuardNegativeKeywords: s.contentGuardNegativeKeywords || cg.DEFAULT_NEGATIVE_KEYWORDS,
          contentGuardBlockedYtChannels: s.contentGuardBlockedYtChannels || cg.DEFAULT_BLOCKED_YT_CHANNELS,
          contentGuardBlockedXAccounts: s.contentGuardBlockedXAccounts || cg.DEFAULT_BLOCKED_X_ACCOUNTS,
          contentGuardBlockedSearchQueries: s.contentGuardBlockedSearchQueries || cg.DEFAULT_BLOCKED_SEARCH_QUERIES
        });

        // 2. Broadcast CG_SETTINGS_UPDATED
        await browser.runtime.sendMessage({ type: 'CG_SETTINGS_UPDATED' });

        // 3. Cari semua tab YouTube/X dan kirim CG_RESCAN_NOW
        const tabs = await browser.tabs.query({ url: [
          '*://*.youtube.com/*',
          '*://*.youtube-nocookie.com/*',
          '*://*.x.com/*',
          '*://*.twitter.com/*'
        ] });
        let successCount = 0;
        for (const t of tabs) {
          try {
            await browser.tabs.sendMessage(t.id, { type: 'CG_RESCAN_NOW' });
            successCount++;
          } catch (e) {
            // Tab mungkin tidak memiliki content script (e.g., tab sudah terbuka sebelum addon install)
            console.warn('[RecallFox] Cannot reach tab', t.id, t.url, '— refresh tab manually');
          }
        }
        forceRescanBtn.textContent = '✓ Re-scan selesai';
        toast(`Re-scan: ${successCount}/${tabs.length} tab terjangkau. Refresh tab manually jika 0.`);
        setTimeout(() => {
          forceRescanBtn.disabled = false;
          forceRescanBtn.textContent = orig;
        }, 3000);
      } catch (e) {
        forceRescanBtn.textContent = '⚠ Error';
        toast('Error: ' + e.message);
        setTimeout(() => {
          forceRescanBtn.disabled = false;
          forceRescanBtn.textContent = orig;
        }, 2000);
      }
    });
  }

  // ===== Content Guardian: User Blocklist (add manual + list + clear) =====
  const blAddBtn = document.getElementById('rf-set-cg-bl-add');
  if (blAddBtn) {
    blAddBtn.addEventListener('click', async () => {
      const typeSel = document.getElementById('rf-set-cg-bl-type');
      const valInput = document.getElementById('rf-set-cg-bl-value');
      if (!typeSel || !valInput) return;
      const type = typeSel.value || 'keyword';
      const value = valInput.value.trim();
      if (!value) {
        toast('Isi nilai dulu');
        return;
      }
      try {
        const res = await browser.runtime.sendMessage({
          type: 'CG_ADD_BLOCKLIST',
          entry: { type, value, source: { url: 'manual', title: 'Added via Settings' } }
        });
        if (res?.ok) {
          valInput.value = '';
          await renderUserBlocklist();
          try { await browser.runtime.sendMessage({ type: 'CG_SETTINGS_UPDATED' }); } catch (e) {}
          toast('Ditambahkan ke blocklist');
        } else if (res?.error === 'duplicate') {
          toast('Sudah ada di blocklist');
        } else {
          toast('Gagal: ' + (res?.error || 'unknown'));
        }
      } catch (e) {
        toast('Error: ' + e.message);
      }
    });
  }

  const blClearBtn = document.getElementById('rf-set-cg-bl-clear');
  if (blClearBtn) {
    blClearBtn.addEventListener('click', async () => {
      if (!confirm('Kosongkan SEMUA entri blocklist? Konten yang sudah diblokir akan muncul lagi.')) return;
      try {
        const res = await browser.runtime.sendMessage({ type: 'CG_CLEAR_BLOCKLIST' });
        if (res?.ok) {
          await renderUserBlocklist();
          try { await browser.runtime.sendMessage({ type: 'CG_SETTINGS_UPDATED' }); } catch (e) {}
          toast('Blocklist dikosongkan');
        } else {
          toast('Gagal: ' + (res?.error || 'unknown'));
        }
      } catch (e) {
        toast('Error: ' + e.message);
      }
    });
  }

  // Enter key di input blocklist → trigger add
  const blValueInput = document.getElementById('rf-set-cg-bl-value');
  if (blValueInput) {
    blValueInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const btn = document.getElementById('rf-set-cg-bl-add');
        if (btn) btn.click();
      }
    });
  }

  // Overlay toggle — broadcast to all tabs for live update
  const overlayToggle = document.getElementById('rf-set-overlay');
  if (overlayToggle) {
    overlayToggle.addEventListener('change', async () => {
      const enabled = overlayToggle.checked;
      try {
        await browser.runtime.sendMessage({ type: 'TOGGLE_OVERLAY', enabled });
        toast(enabled ? 'Overlay diaktifkan' : 'Overlay dimatikan');
      } catch (e) {}
    });
  }

  // Text fields: toast on blur
  [
    'rf-set-assistant-apikey', 'rf-set-assistant-model', 'rf-set-assistant-baseurl',
    'rf-set-assistant-fallback-apikey', 'rf-set-assistant-fallback-model', 'rf-set-assistant-fallback-baseurl'
  ].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('blur', () => toast('Tersimpan'));
    }
  });

  // Clear Cache: dataTypes (multi-checkbox array)
  const ccTypesContainer = document.getElementById('rf-set-cc-types');
  if (ccTypesContainer) {
    ccTypesContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', async () => {
        const selected = Array.from(ccTypesContainer.querySelectorAll('input[type="checkbox"]:checked'))
                              .map(c => c.value);
        await saveSettings({ clearCacheDataTypes: selected });
        toast('Tersimpan');
      });
    });
  }

  // Clear Cache: clear now button
  const ccNowBtn = document.getElementById('rf-set-cc-now');
  if (ccNowBtn) {
    ccNowBtn.addEventListener('click', async () => {
      const original = ccNowBtn.textContent;
      ccNowBtn.disabled = true;
      ccNowBtn.textContent = '🧹 Membersihkan...';
      try {
        const res = await browser.runtime.sendMessage({ type: 'CLEAR_CACHE' });
        if (res?.ok) {
          ccNowBtn.textContent = '✓ Selesai';
          toast(res.message || 'Cache dibersihkan');
        } else {
          ccNowBtn.textContent = '⚠ Gagal';
          toast('Gagal: ' + (res?.message || res?.error || 'unknown'));
        }
      } catch (e) {
        ccNowBtn.textContent = '⚠ Error';
        toast('Error: ' + e.message);
      } finally {
        setTimeout(() => {
          ccNowBtn.disabled = false;
          ccNowBtn.textContent = original;
        }, 2000);
      }
    });
  }

  // v0.8.41: Binding checkbox hari ngaji & treadmill
  const quranDaysContainer = document.getElementById('rf-set-quran-days');
  if (quranDaysContainer) {
    quranDaysContainer.querySelectorAll('.rf-quran-day').forEach(cb => {
      cb.addEventListener('change', async () => {
        const selected = Array.from(quranDaysContainer.querySelectorAll('.rf-quran-day:checked'))
                              .map(c => parseInt(c.value, 10));
        await saveSettings({ quranDays: selected });
        toast('Tersimpan');
      });
    });
  }
  const exerciseDaysContainer = document.getElementById('rf-set-exercise-days');
  if (exerciseDaysContainer) {
    exerciseDaysContainer.querySelectorAll('.rf-exercise-day').forEach(cb => {
      cb.addEventListener('change', async () => {
        const selected = Array.from(exerciseDaysContainer.querySelectorAll('.rf-exercise-day:checked'))
                              .map(c => parseInt(c.value, 10));
        await saveSettings({ exerciseDays: selected });
        toast('Tersimpan');
      });
    });
  }

  // v3.11.6: Binding tombol "Tambah pintasan" untuk ngaji & olahraga
  const quranScAddBtn = document.getElementById('rf-set-quran-shortcut-add');
  if (quranScAddBtn) {
    quranScAddBtn.addEventListener('click', async () => {
      const vault = await getVault();
      const list = Array.isArray(vault.settings.quranShortcuts) ? vault.settings.quranShortcuts : [];
      if (list.length >= 6) { toast('Maksimal 6 pintasan'); return; }
      list.push({ name: 'Web baru', url: 'https://', emoji: '📖' });
      await saveSettings({ quranShortcuts: list });
      renderShortcutEditor('rf-set-quran-shortcuts', list, '📖');
      toast('Pintasan ditambahkan — edit lalu tekan Simpan');
    });
  }
  const exerciseScAddBtn = document.getElementById('rf-set-exercise-shortcut-add');
  if (exerciseScAddBtn) {
    exerciseScAddBtn.addEventListener('click', async () => {
      const vault = await getVault();
      const list = Array.isArray(vault.settings.exerciseShortcuts) ? vault.settings.exerciseShortcuts : [];
      if (list.length >= 6) { toast('Maksimal 6 pintasan'); return; }
      list.push({ name: 'Web baru', url: 'https://', emoji: '🏃' });
      await saveSettings({ exerciseShortcuts: list });
      renderShortcutEditor('rf-set-exercise-shortcuts', list, '🏃');
      toast('Pintasan ditambahkan — edit lalu tekan Simpan');
    });
  }

  // Prayer: lat/lng/loc inputs (number/text)
  ['rf-set-prayer-lat', 'rf-set-prayer-lng', 'rf-set-prayer-loc'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', async () => {
      const lat = parseFloat(document.getElementById('rf-set-prayer-lat').value);
      const lng = parseFloat(document.getElementById('rf-set-prayer-lng').value);
      const loc = document.getElementById('rf-set-prayer-loc').value.trim();
      const patch = { prayerLocation: loc };
      if (!isNaN(lat)) patch.prayerLatitude = lat;
      if (!isNaN(lng)) patch.prayerLongitude = lng;
      // Clear cache when location changes
      patch.prayerCachedTimes = null;
      await saveSettings(patch);
    });
    el.addEventListener('blur', () => toast('Tersimpan'));
  });

  // Prayer: reset cache button
  const prayerResetBtn = document.getElementById('rf-set-prayer-reset');
  if (prayerResetBtn) {
    prayerResetBtn.addEventListener('click', async () => {
      await saveSettings({ prayerCachedTimes: null });
      toast('Cache direset — akan fetch ulang');
    });
  }

  // Show welcome modal again (re-enable flag, prompt user to open popup/sidebar)
  const showWelcomeBtn = document.getElementById('rf-set-show-welcome');
  if (showWelcomeBtn) {
    showWelcomeBtn.addEventListener('click', async () => {
      await saveSettings({ showWelcomeOnFirstUse: true });
      toast('Welcome diaktifkan — buka popup/sidebar RecallFox');
      // Try opening popup/sidebar to show welcome
      try {
        await browser.runtime.sendMessage({ type: 'OPEN_SIDEBAR' });
      } catch (e) {}
    });
  }

  // Auto-backup: Backup now button (manual backup with timestamp)
  const backupNowBtn = document.getElementById('rf-set-backup-now');
  if (backupNowBtn) {
    backupNowBtn.addEventListener('click', async () => {
      const orig = backupNowBtn.textContent;
      backupNowBtn.disabled = true;
      backupNowBtn.textContent = '💾 Menyimpan...';
      try {
        const { manualBackupWithTimestamp } = await import('../lib/autobackup.js');
        const res = await manualBackupWithTimestamp();
        if (res?.ok) {
          backupNowBtn.textContent = '✓ Tersimpan';
          toast('Backup manual tersimpan di Downloads/RecallFox/');
          await refreshLastBackupDisplay();
        } else {
          backupNowBtn.textContent = '⚠ Gagal';
          toast('Gagal: ' + (res?.error || 'unknown'));
        }
      } catch (e) {
        backupNowBtn.textContent = '⚠ Error';
        toast('Error: ' + e.message);
      } finally {
        setTimeout(() => { backupNowBtn.disabled = false; backupNowBtn.textContent = orig; }, 2000);
      }
    });
  }

  // Auto-backup: Restore from file button
  const restorePickBtn = document.getElementById('rf-set-restore-pick');
  const restoreInput = document.getElementById('rf-set-restore-input');
  if (restorePickBtn && restoreInput) {
    restorePickBtn.addEventListener('click', () => restoreInput.click());
    restoreInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const { restoreFromFile } = await import('../lib/autobackup.js');
        const res = await restoreFromFile(file);
        if (res?.ok) {
          toast(`Restore berhasil: ${res.restored.vaultItems} items, ${res.restored.notes} catatan`);
          currentVault = await getVault();
          renderStats();
          await refreshLastBackupDisplay();
        } else if (!res?.cancelled) {
          toast('Gagal restore: ' + (res?.error || 'unknown'));
        }
      } catch (e) {
        toast('Error: ' + e.message);
      }
      e.target.value = '';
    });
  }

  // Show last backup time on init
  refreshLastBackupDisplay();

  // Backup interval: restart timer when user changes interval
  const backupIntervalSel = document.getElementById('rf-set-backup-interval');
  if (backupIntervalSel) {
    backupIntervalSel.addEventListener('change', async () => {
      // Setting already saved by generic fields handler above
      // Restart the backup timer in background with new interval
      try {
        await browser.runtime.sendMessage({ type: 'RESTART_BACKUP_TIMER' });
      } catch (e) {}
      toast('Timer backup di-restart');
    });
  }

  document.getElementById('rf-set-sync-now').addEventListener('click', async () => {
    const btn = document.getElementById('rf-set-sync-now');
    btn.textContent = 'Memproses...';
    btn.disabled = true;
    const res = await browser.runtime.sendMessage({ type: 'SYNC_NOW' });
    btn.textContent = 'Sinkron sekarang';
    btn.disabled = false;
    if (res?.ok) {
      toast('Tersinkron');
      currentVault = await getVault();
      document.getElementById('rf-set-lastsync').textContent =
        new Date(currentVault.settings.lastSyncAt).toLocaleString();
    } else {
      toast('Gagal: ' + (res?.error || 'unknown'));
    }
  });

  // Export
  document.getElementById('rf-set-export-plain').addEventListener('click', () => {
    exportBackup(false);
  });
  document.getElementById('rf-set-export-enc').addEventListener('click', () => {
    exportBackup(true);
  });

  // Import
  document.getElementById('rf-set-import').addEventListener('click', () => {
    document.getElementById('rf-set-import-file').click();
  });
  document.getElementById('rf-set-import-file').addEventListener('change', handleImportFile);

  // v3.20.25: Import Paket Link
  const linkpackBtn = document.getElementById('rf-set-import-linkpack');
  const linkpackFile = document.getElementById('rf-linkpack-file');
  if (linkpackBtn) {
    linkpackBtn.addEventListener('click', () => {
      if (linkpackFile) {
        linkpackFile.value = ''; // reset supaya bisa re-pick file yang sama
        linkpackFile.click();
      }
    });
  }
  if (linkpackFile) {
    linkpackFile.addEventListener('change', handleLinkPackFile);
  }
}

async function exportBackup(encrypted) {
  const vault = await getVault();
  // Also export screenshot blobs (stored separately in storage.local under rf_shot_<id>)
  const shotBlobs = await exportAllScreenshotBlobs();
  const payload = { vault, screenshotBlobs: shotBlobs };
  const json = JSON.stringify(payload, null, 2);
  let content = json;
  let ext = 'json';

  if (encrypted) {
    const passphrase = prompt('Masukkan passphrase untuk enkripsi backup:');
    if (!passphrase) return;
    if (passphrase.length < 8) {
      if (!confirm('Passphrase kurang dari 8 karakter. Lanjut? (Tidak disarankan)')) return;
    }
    content = await encryptBackup(json, passphrase);
    ext = 'rfvault';
  }

  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const filename = `recallfox-backup-${ts}.${ext}`;

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  await saveSettings({ lastBackupAt: new Date().toISOString() });
  currentVault = await getVault();
  document.getElementById('rf-set-lastbackup').textContent =
    new Date(currentVault.settings.lastBackupAt).toLocaleString();
  toast(encrypted ? 'Backup terenkripsi diekspor' : 'Backup diekspor');
}

async function handleImportFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();

  // Detect if encrypted
  let jsonStr;
  if (isEncryptedBackup(text)) {
    const passphrase = prompt('Masukkan passphrase untuk dekripsi:');
    if (!passphrase) {
      e.target.value = '';
      return;
    }
    try {
      jsonStr = await decryptBackup(text, passphrase);
    } catch (err) {
      toast(err.message === 'WRONG_PASSPHRASE'
        ? 'Passphrase salah atau file rusak'
        : 'Gagal decrypt: ' + err.message);
      e.target.value = '';
      return;
    }
  } else {
    // try plain
    try {
      JSON.parse(text); // validate
      jsonStr = text;
    } catch (err) {
      toast('File backup tidak valid');
      e.target.value = '';
      return;
    }
  }

  if (!confirm('Import akan menggabungkan dengan vault yang ada. Lanjut?')) {
    e.target.value = '';
    return;
  }

  // Merge: keep local syncEnabled, but take items + bundles from imported
  // (item-level merge by id, last-write-wins by updatedAt)
  // Support both new format {vault, screenshotBlobs} and legacy format (vault directly)
  const parsed = JSON.parse(jsonStr);
  const imported = parsed.vault || parsed; // backward-compat with v0.1.0 backups
  const importedShotBlobs = parsed.screenshotBlobs || null;

  const local = await getVault();

  const itemMap = new Map();
  for (const it of local.items) itemMap.set(it.id, it);
  for (const it of (imported.items || [])) {
    const ex = itemMap.get(it.id);
    if (!ex || new Date(it.updatedAt || 0) > new Date(ex.updatedAt || 0)) {
      itemMap.set(it.id, it);
    }
  }
  local.items = [...itemMap.values()];

  const bundleMap = new Map();
  for (const b of local.bundles) bundleMap.set(b.id, b);
  for (const b of (imported.bundles || [])) bundleMap.set(b.id, b);
  local.bundles = [...bundleMap.values()];

  await browser.storage.local.set({ recallfox_vault: local });
  currentVault = local;

  // Restore screenshot blobs (only for IDs that don't already have a blob)
  if (importedShotBlobs && typeof importedShotBlobs === 'object') {
    await importScreenshotBlobs(importedShotBlobs);
  }

  renderStats();
  toast('Backup diimpor');
  e.target.value = '';
}

function renderStats() {
  const items = currentVault.items || [];
  const total = items.length;
  const byType = {
    prompt: items.filter(i => i.type === 'prompt').length,
    context: items.filter(i => i.type === 'context').length,
    snapshot: items.filter(i => i.type === 'snapshot').length,
    screenshot: items.filter(i => i.type === 'screenshot').length,
    link: items.filter(i => i.type === 'link').length
  };
  const totalUses = items.reduce((s, i) => s + (i.useCount || 0), 0);
  const favorites = items.filter(i => i.favorite).length;
  const bundles = (currentVault.bundles || []).length;

  const grid = document.getElementById('rf-stats-grid');
  grid.innerHTML = `
    <div class="rf-stat-card">
      <div class="rf-stat-card-label">Total Items</div>
      <div class="rf-stat-card-value">${total}</div>
    </div>
    <div class="rf-stat-card">
      <div class="rf-stat-card-label">Prompts</div>
      <div class="rf-stat-card-value">${byType.prompt}</div>
    </div>
    <div class="rf-stat-card">
      <div class="rf-stat-card-label">Context</div>
      <div class="rf-stat-card-value">${byType.context}</div>
    </div>
    <div class="rf-stat-card">
      <div class="rf-stat-card-label">Snapshots</div>
      <div class="rf-stat-card-value">${byType.snapshot}</div>
    </div>
    <div class="rf-stat-card">
      <div class="rf-stat-card-label">Screenshots</div>
      <div class="rf-stat-card-value">${byType.screenshot}</div>
    </div>
    <div class="rf-stat-card">
      <div class="rf-stat-card-label">Links</div>
      <div class="rf-stat-card-value">${byType.link}</div>
    </div>
    <div class="rf-stat-card">
      <div class="rf-stat-card-label">Bundles</div>
      <div class="rf-stat-card-value">${bundles}</div>
    </div>
    <div class="rf-stat-card">
      <div class="rf-stat-card-label">Total Dipakai</div>
      <div class="rf-stat-card-value">${totalUses}</div>
    </div>
    <div class="rf-stat-card">
      <div class="rf-stat-card-label">Favorit</div>
      <div class="rf-stat-card-value">${favorites}</div>
    </div>
  `;

  // Top 5 most used
  const top = [...items]
    .filter(i => (i.useCount || 0) > 0)
    .sort((a, b) => (b.useCount || 0) - (a.useCount || 0))
    .slice(0, 5);
  const topWrap = document.getElementById('rf-stats-top');
  if (top.length === 0) {
    topWrap.innerHTML = '<div class="rf-stats-list-title">Paling sering dipakai</div><div style="color:#9ca3af;font-size:12px;">Belum ada item yang pernah dipakai.</div>';
  } else {
    topWrap.innerHTML = '<div class="rf-stats-list-title">Paling sering dipakai (Top 5)</div>' +
      top.map(i => `
        <div class="rf-stat-top-item">
          <span class="rf-stat-top-name">${escapeHtml(i.title)}</span>
          <span class="rf-stat-top-count">${i.useCount}×</span>
        </div>
      `).join('');
  }

  // Top tags
  const tags = getAllTags(items).slice(0, 10);
  const tagWrap = document.getElementById('rf-stats-tags');
  if (tags.length === 0) {
    tagWrap.innerHTML = '';
  } else {
    tagWrap.innerHTML = '<div class="rf-stats-list-title" style="width:100%;">Tag paling aktif</div>' +
      tags.map(t => `<span class="rf-stats-tag">#${escapeHtml(t.tag)} (${t.count})</span>`).join('');
  }
}

function escapeHtml(s) {
  return (s || '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let toastTimer = null;
function toast(msg) {
  const t = document.getElementById('rf-toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

async function refreshLastBackupDisplay() {
  try {
    const { getBackupMetadata } = await import('../lib/autobackup.js');
    const meta = await getBackupMetadata();
    const row = document.getElementById('rf-set-last-backup-row');
    const desc = document.getElementById('rf-set-last-backup');
    if (!row || !desc) return;
    if (meta && meta.lastBackupAt) {
      const date = new Date(meta.lastBackupAt).toLocaleString();
      desc.textContent = `${date} · ${meta.vaultItemsCount} items · ${meta.notesCount} catatan`;
      row.style.display = 'flex';
    } else {
      row.style.display = 'none';
    }
  } catch (e) {}
}

// ===== Content Guardian: Render User Blocklist =====
async function renderUserBlocklist() {
  const listEl = document.getElementById('rf-cg-bl-list');
  const countEl = document.getElementById('rf-cg-bl-count');
  if (!listEl) return;
  let list = [];
  try {
    const res = await browser.runtime.sendMessage({ type: 'CG_GET_BLOCKLIST' });
    if (res?.ok && Array.isArray(res.list)) list = res.list;
  } catch (e) {
    console.warn('[RecallFox] renderUserBlocklist: get failed:', e);
  }
  if (countEl) countEl.textContent = `${list.length} entri`;

  if (list.length === 0) {
    listEl.innerHTML = `
      <div style="padding:24px 16px;text-align:center;color:var(--text-muted);font-size:12px;">
        Belum ada entri. Klik kanan pada video/tweet di YouTube / X lalu pilih
        <strong>🚫 Blokir Konten Ini</strong>, atau tambah manual di atas.
      </div>`;
    return;
  }

  const typeLabel = {
    keyword: '🔑 Kata kunci',
    title: '📝 Judul',
    exact_title: '🎯 Judul persis',
    channel: '👥 Channel/akun'
  };
  const typeColor = {
    keyword: '#f59e0b',
    title: '#3b82f6',
    exact_title: '#8b5cf6',
    channel: '#ec4899'
  };

  listEl.innerHTML = list.map(entry => {
    const label = typeLabel[entry.type] || entry.type;
    const color = typeColor[entry.type] || '#6b7280';
    const addedAt = entry.addedAt ? new Date(entry.addedAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    const valueDisplay = escapeHtml(entry.value || '');
    const sourceChannel = entry.source?.channel ? ` · dari: ${escapeHtml(entry.source.channel)}` : '';
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--border);font-size:12px;">
        <span style="background:${color}22;color:${color};padding:2px 6px;border-radius:4px;font-size:10px;font-weight:600;flex-shrink:0;white-space:nowrap;">${label}</span>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:500;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${valueDisplay}">${valueDisplay}</div>
          <div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${addedAt}${sourceChannel}</div>
        </div>
        <button class="rf-cg-bl-del" data-id="${entry.id}" style="background:none;border:1px solid var(--border);color:#dc2626;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:11px;flex-shrink:0;">🗑️ Hapus</button>
      </div>
    `;
  }).join('');

  // Bind tombol hapus
  listEl.querySelectorAll('.rf-cg-bl-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      try {
        const res = await browser.runtime.sendMessage({ type: 'CG_REMOVE_BLOCKLIST', id });
        if (res?.ok) {
          await renderUserBlocklist();
          try { await browser.runtime.sendMessage({ type: 'CG_SETTINGS_UPDATED' }); } catch (e) {}
          toast('Dihapus dari blocklist');
        } else {
          toast('Gagal: ' + (res?.error || 'unknown'));
        }
      } catch (e) {
        toast('Error: ' + e.message);
      }
    });
  });
}

// v0.8.42: Render Element Blocker rules list
// v0.9.0: Support custom rules + delete button + preset display
async function renderElementBlockerRules() {
  const listEl = document.getElementById('rf-eb-rules-list');
  if (!listEl) return;
  let rules = [];
  try {
    const resp = await browser.runtime.sendMessage({ type: 'EB_GET_RULES' });
    if (resp && resp.rules) rules = resp.rules;
  } catch (e) {
    try {
      const eb = await import('../lib/elementblocker.js');
      rules = eb.DEFAULT_ELEMENT_BLOCKER_RULES;
    } catch (e2) {}
  }
  if (rules.length === 0) {
    listEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px;">Belum ada rules. Tambah situs baru di bawah.</div>';
    return;
  }
  listEl.innerHTML = rules.map(rule => {
    const isPreset = rule.isPreset !== false;
    const badge = isPreset
      ? '<span style="font-size:9px;background:var(--accent-amber-soft);color:#92400e;padding:1px 5px;border-radius:3px;font-weight:600;text-transform:uppercase;">preset</span>'
      : '<span style="font-size:9px;background:var(--accent-green-soft);color:#065f46;padding:1px 5px;border-radius:3px;font-weight:600;text-transform:uppercase;">custom</span>';
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--border);border-radius:6px;margin-bottom:8px;background:var(--surface);">
        <label class="rf-switch" style="flex-shrink:0;">
          <input type="checkbox" class="rf-eb-rule-toggle" data-id="${rule.id}" ${rule.enabled !== false ? 'checked' : ''} />
          <span class="rf-slider"></span>
        </label>
        <div style="flex:1;">
          <div style="font-weight:600;font-size:13px;color:var(--text);">${escapeHtml(rule.name)} ${badge}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
            🌐 ${escapeHtml(rule.domain)} · 🎯 ${rule.selectors?.length || 0} selector · 🚫 ${rule.blockDomains?.length || 0} domain ${rule.blockPopups ? '· 🔒 popup' : ''}
          </div>
        </div>
        ${!isPreset ? `<button class="rf-eb-rule-del" data-id="${rule.id}" style="background:none;border:1px solid var(--border);color:#dc2626;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:11px;flex-shrink:0;">🗑️ Hapus</button>` : ''}
      </div>
    `;
  }).join('');
  // Bind toggle
  listEl.querySelectorAll('.rf-eb-rule-toggle').forEach(cb => {
    cb.addEventListener('change', async () => {
      const id = cb.dataset.id;
      const enabled = cb.checked;
      const updated = rules.map(r => r.id === id ? { ...r, enabled } : r);
      try {
        await browser.runtime.sendMessage({ type: 'EB_SAVE_RULES', rules: updated });
        toast(enabled ? 'Rule diaktifkan' : 'Rule dimatikan');
      } catch (e) { toast('Gagal: ' + e.message); }
    });
  });
  // Bind delete (custom rules only)
  listEl.querySelectorAll('.rf-eb-rule-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      if (!confirm('Hapus rule ini?')) return;
      const updated = rules.filter(r => r.id !== id);
      try {
        await browser.runtime.sendMessage({ type: 'EB_SAVE_RULES', rules: updated });
        toast('Rule dihapus');
        await renderElementBlockerRules();
      } catch (e) { toast('Gagal: ' + e.message); }
    });
  });
}

init().catch(e => console.error('[RecallFox] settings init() unhandled rejection:', e));

// Re-render stats when vault changes (e.g., from sync)
browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'VAULT_UPDATED') {
    getVault().then(v => {
      currentVault = v;
      renderStats();
    });
  }
});

// v3.11.6 (Issue 2 dari Google Doc): Editor pintasan web ngaji & olahraga
// Render list of {name, url, emoji} dengan input fields + tombol hapus + tombol simpan per-row.
// containerId: 'rf-set-quran-shortcuts' or 'rf-set-exercise-shortcuts'
// shortcuts: array of { name, url, emoji }
// defaultEmoji: emoji fallback kalau field emoji kosong
function renderShortcutEditor(containerId, shortcuts, defaultEmoji) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const list = Array.isArray(shortcuts) ? shortcuts.slice(0, 6) : [];
  if (list.length === 0) {
    container.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:8px;background:var(--surface);border-radius:6px;">Belum ada pintasan. Klik tombol di bawah untuk menambah.</div>';
    return;
  }
  const settingKey = containerId.includes('quran') ? 'quranShortcuts' : 'exerciseShortcuts';
  container.innerHTML = list.map((sc, i) => {
    const emoji = sc.emoji || defaultEmoji;
    const name = (sc.name || '').replace(/"/g, '&quot;');
    const url = (sc.url || '').replace(/"/g, '&quot;');
    return '<div class="rf-shortcut-row" data-idx="' + i + '" style="display:grid;grid-template-columns:50px 1fr 2fr auto;gap:6px;align-items:center;padding:6px;background:var(--surface);border-radius:6px;border:1px solid var(--border);">'
      + '<input type="text" class="rf-sc-emoji" value="' + emoji + '" maxlength="4" style="width:40px;text-align:center;padding:4px;border:1px solid var(--border);border-radius:4px;font-size:14px;" title="Emoji (maks 4 karakter)">'
      + '<input type="text" class="rf-sc-name" value="' + name + '" placeholder="Nama" style="padding:4px 8px;border:1px solid var(--border);border-radius:4px;font-size:12px;" title="Nama pintasan">'
      + '<input type="url" class="rf-sc-url" value="' + url + '" placeholder="https://..." style="padding:4px 8px;border:1px solid var(--border);border-radius:4px;font-size:12px;" title="URL lengkap">'
      + '<button type="button" class="rf-sc-del" title="Hapus pintasan ini" style="padding:4px 8px;background:var(--danger-soft);color:var(--danger);border:none;border-radius:4px;cursor:pointer;font-size:14px;">🗑</button>'
      + '</div>';
  }).join('');

  // Bind input changes (auto-save dengan debounce)
  container.querySelectorAll('.rf-shortcut-row').forEach(row => {
    const idx = parseInt(row.dataset.idx, 10);
    let saveTimer = null;
    const scheduleSave = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        const vault = await getVault();
        const arr = Array.isArray(vault.settings[settingKey]) ? vault.settings[settingKey] : [];
        if (idx >= arr.length) return;
        arr[idx] = {
          emoji: row.querySelector('.rf-sc-emoji').value.trim() || defaultEmoji,
          name: row.querySelector('.rf-sc-name').value.trim() || 'Web',
          url: row.querySelector('.rf-sc-url').value.trim() || 'https://'
        };
        await saveSettings({ [settingKey]: arr });
        toast('Tersimpan', false);
      }, 800);
    };
    row.querySelector('.rf-sc-emoji').addEventListener('input', scheduleSave);
    row.querySelector('.rf-sc-name').addEventListener('input', scheduleSave);
    row.querySelector('.rf-sc-url').addEventListener('input', scheduleSave);

    // Bind delete button
    row.querySelector('.rf-sc-del').addEventListener('click', async () => {
      if (!confirm('Hapus pintasan ini?')) return;
      const vault = await getVault();
      const arr = Array.isArray(vault.settings[settingKey]) ? vault.settings[settingKey] : [];
      arr.splice(idx, 1);
      await saveSettings({ [settingKey]: arr });
      renderShortcutEditor(containerId, arr, defaultEmoji);
      toast('Pintasan dihapus');
    });
  });
}

// ============================================================
// v3.11.7: Multi-PC Sync — Profile Manager + Sync Actions
// ============================================================

// v3.11.7-fix (Issue #5): Multi-PC Sync UI dipindah ke sidebar (RecallFox Vault).
// Di settings page sekarang hanya ada tombol "Buka Sidebar" yang membuka sidebar
// RecallFox + arah ke tab Alat → Sync Cloud. Fungsi initMultiPCSync, doSyncAction,
// openSyncProfileManager, renderSyncProfileList, addProfileFromForm, testProfileFromForm
// DIPINDAH ke popup/popup.js supaya sidebar jadi satu pintu untuk semua sync.
async function initSidebarSyncRedirect() {
  try {
    const btn = document.getElementById('rf-open-sidebar-sync');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      try {
        // Chrome MV3: pakai openSidebar() dari sidebar-compat.js (handle Firefox + Chrome).
        const result = await openSidebar();
        if (!result.ok) {
          alert('Sidebar tidak didukung di browser ini. Buka sidebar RecallFox manual dari toolbar.');
          return;
        }
        // Tampilkan toast pengingat
        toast('🦊 Buka tab "Alat" → "Sync Cloud" di sidebar');
      } catch (e) {
        alert('Gagal membuka sidebar: ' + e.message + '\n\nBuka sidebar RecallFox manual dari toolbar, lalu pilih tab Alat → Sync Cloud.');
      }
    });
  } catch (e) {
    console.warn('[RecallFox] initSidebarSyncRedirect failed:', e);
  }
}

// Call init on DOMContentLoaded (append to existing init)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(initSidebarSyncRedirect, 200));
} else {
  setTimeout(initSidebarSyncRedirect, 200);
}

// ============================================================
// v3.20.25: Import Paket Link — handler + UI preview/modal
// ============================================================

async function handleLinkPackFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  // Baca + validasi manifest
  const result = await readLinkPackFile(file);
  if (!result.ok) {
    showLinkPackError('Manifest tidak valid:', result.errors);
    return;
  }

  const pack = result.pack;

  // Cek duplikasi
  const alreadyImported = await hasImportedPack(pack.packId);
  if (alreadyImported) {
    showLinkPackDuplicateModal(pack);
  } else {
    showLinkPackPreviewModal(pack, { asCopy: false });
  }
}

function showLinkPackError(title, errors) {
  const container = document.getElementById('rf-linkpack-preview');
  if (!container) {
    alert(title + '\n\n' + errors.join('\n'));
    return;
  }
  const errList = errors.map(er => '<li>' + escapeHtml(er) + '</li>').join('');
  container.innerHTML = `
    <div class="rf-linkpack-modal" role="dialog" aria-modal="true">
      <div class="rf-linkpack-modal-inner">
        <div class="rf-linkpack-modal-hd">
          <h3>⚠️ ${escapeHtml(title)}</h3>
        </div>
        <div class="rf-linkpack-modal-body">
          <p>File tidak bisa diimpor karena:</p>
          <ul class="rf-linkpack-errors">${errList}</ul>
        </div>
        <div class="rf-linkpack-modal-ft">
          <button class="rf-btn rf-btn-secondary" id="rf-linkpack-close-error">Tutup</button>
        </div>
      </div>
    </div>
  `;
  container.style.display = 'block';
  const closeBtn = document.getElementById('rf-linkpack-close-error');
  if (closeBtn) closeBtn.addEventListener('click', () => { container.style.display = 'none'; container.innerHTML = ''; });
}

function showLinkPackDuplicateModal(pack) {
  const container = document.getElementById('rf-linkpack-preview');
  if (!container) return;
  container.innerHTML = `
    <div class="rf-linkpack-modal" role="dialog" aria-modal="true">
      <div class="rf-linkpack-modal-inner">
        <div class="rf-linkpack-modal-hd">
          <h3>📦 Paket ini sudah pernah diimpor</h3>
        </div>
        <div class="rf-linkpack-modal-body">
          <p>Paket <b>${escapeHtml(pack.name)}</b> (packId: <code>${escapeHtml(pack.packId)}</code>) sudah ada di Vault Anda.</p>
          <p class="rf-linkpack-hint">Pilih <b>"Import sebagai Salinan"</b> untuk membuat folder baru dengan suffix <code>(Salinan)</code>.</p>
        </div>
        <div class="rf-linkpack-modal-ft">
          <button class="rf-btn rf-btn-secondary" id="rf-linkpack-dup-cancel">Batal</button>
          <button class="rf-btn rf-btn-primary" id="rf-linkpack-dup-copy">Import sebagai Salinan</button>
        </div>
      </div>
    </div>
  `;
  container.style.display = 'block';
  document.getElementById('rf-linkpack-dup-cancel').addEventListener('click', () => {
    container.style.display = 'none'; container.innerHTML = '';
  });
  document.getElementById('rf-linkpack-dup-copy').addEventListener('click', async () => {
    container.style.display = 'none'; container.innerHTML = '';
    showLinkPackPreviewModal(pack, { asCopy: true });
  });
}

function showLinkPackPreviewModal(pack, opts) {
  const container = document.getElementById('rf-linkpack-preview');
  if (!container) return;
  const asCopy = !!(opts && opts.asCopy);
  const folderNameDisplay = asCopy ? (pack.folder.name + ' (Salinan)') : pack.folder.name;
  const folderColorBadge = pack.folder.color
    ? `<span class="rf-linkpack-color" style="background:${escapeHtml(pack.folder.color)}"></span>`
    : '';

  // v3.20.26: Multi-type support — render item berdasarkan type
  const isMultiType = pack.schemaVersion === 2 || (pack.items || []).some(it => it.type !== 'link');

  // Hitung type counts untuk summary
  const typeCounts = {};
  (pack.items || []).forEach(it => {
    typeCounts[it.type] = (typeCounts[it.type] || 0) + 1;
  });
  const summaryParts = Object.entries(typeCounts).map(([t, c]) => `${getTypeIcon(t)} ${c} ${t}`);
  const summaryText = summaryParts.join(' · ');

  const itemsHtml = pack.items.map((it, i) => {
    const icon = getTypeIcon(it.type);
    const typeLabel = getTypeLabel(it.type);
    let detail = '';
    if (it.type === 'link') {
      detail = `<span class="rf-linkpack-item-url">${escapeHtml(it.url)}</span>`;
    } else if (it.type === 'prompt' || it.type === 'context' || it.type === 'note' || it.type === 'snapshot') {
      // Tampilkan preview body (80 char pertama)
      const bodyPreview = (it.body || '').slice(0, 80).replace(/\n/g, ' ');
      detail = `<span class="rf-linkpack-item-body">${escapeHtml(bodyPreview)}${(it.body || '').length > 80 ? '…' : ''}</span>`;
      // Tampilkan contextPurpose kalau ada
      if (it.contextPurpose) {
        detail += ` <span class="rf-linkpack-item-badge">${escapeHtml(it.contextPurpose)}</span>`;
      }
      // Tampilkan color kalau note
      if (it.color && it.color !== 'default') {
        detail += ` <span class="rf-linkpack-item-badge">${escapeHtml(it.color)}</span>`;
      }
    }
    return `
    <li class="rf-linkpack-item">
      <span class="rf-linkpack-item-idx">${i + 1}.</span>
      <span class="rf-linkpack-item-title">${icon} ${escapeHtml(it.title)}</span>
      ${detail}
    </li>
  `;
  }).join('');

  const importLabel = asCopy ? 'Import sebagai Salinan' : 'Import Paket';
  const modalTitle = isMultiType ? 'Import Paket' : 'Import Paket Link';
  const itemsTitle = isMultiType
    ? `Item yang akan ditambahkan (${pack.items.length}): ${summaryText}`
    : `Link yang akan ditambahkan (${pack.items.length}):`;

  container.innerHTML = `
    <div class="rf-linkpack-modal" role="dialog" aria-modal="true">
      <div class="rf-linkpack-modal-inner">
        <div class="rf-linkpack-modal-hd">
          <h3>📦 ${escapeHtml(modalTitle)}</h3>
        </div>
        <div class="rf-linkpack-modal-body">
          <div class="rf-linkpack-meta">
            <div><span class="rf-linkpack-label">Nama Paket:</span> <b>${escapeHtml(pack.name)}</b></div>
            <div><span class="rf-linkpack-label">Versi:</span> ${escapeHtml(pack.version)} <span class="rf-linkpack-schema">schema v${pack.schemaVersion}</span></div>
            ${pack.description ? `<div><span class="rf-linkpack-label">Deskripsi:</span> ${escapeHtml(pack.description)}</div>` : ''}
            <div><span class="rf-linkpack-label">Pack ID:</span> <code>${escapeHtml(pack.packId)}</code></div>
          </div>
          <div class="rf-linkpack-folder">
            <div class="rf-linkpack-section-title">Folder yang akan dibuat:</div>
            <div class="rf-linkpack-folder-name">${folderColorBadge}📁 ${escapeHtml(folderNameDisplay)}</div>
          </div>
          <div class="rf-linkpack-items">
            <div class="rf-linkpack-section-title">${escapeHtml(itemsTitle)}</div>
            <ul class="rf-linkpack-list">${itemsHtml}</ul>
          </div>
        </div>
        <div class="rf-linkpack-modal-ft">
          <button class="rf-btn rf-btn-secondary" id="rf-linkpack-cancel">Batal</button>
          <button class="rf-btn rf-btn-primary" id="rf-linkpack-confirm">${escapeHtml(importLabel)}</button>
        </div>
      </div>
    </div>
  `;
  container.style.display = 'block';

  document.getElementById('rf-linkpack-cancel').addEventListener('click', () => {
    container.style.display = 'none'; container.innerHTML = '';
  });

  document.getElementById('rf-linkpack-confirm').addEventListener('click', async () => {
    const confirmBtn = document.getElementById('rf-linkpack-confirm');
    const cancelBtn = document.getElementById('rf-linkpack-cancel');
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = '⏳ Mengimpor...'; }
    if (cancelBtn) cancelBtn.disabled = true;

    const result = await importLinkPack(pack, { asCopy });
    if (result.ok) {
      container.style.display = 'none'; container.innerHTML = '';
      // v3.20.26: Toast yang lebih informatif — tampilkan type counts
      const tc = result.typeCounts || {};
      const parts = [];
      if (tc.link) parts.push(`${tc.link} link`);
      if (tc.prompt) parts.push(`${tc.prompt} prompt`);
      if (tc.context) parts.push(`${tc.context} konteks`);
      if (tc.note) parts.push(`${tc.note} catatan`);
      if (tc.snapshot) parts.push(`${tc.snapshot} snapshot`);
      const summary = parts.join(', ') || result.itemCount + ' item';
      showToast('✓ Paket "' + pack.name + '" berhasil diimpor (' + summary + ').', true);
      // Reload vault data supaya statistik update
      try { currentVault = await getVault(); } catch (e) {}
    } else {
      showToast('⚠ Gagal import: ' + (result.error || 'unknown'), false);
      if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = importLabel; }
      if (cancelBtn) cancelBtn.disabled = false;
    }
  });
}

// Helper: escape HTML supaya safe render — reuse escapeHtml() yang sudah ada di file ini
// (defined at line ~1613). Tidak perlu redefine.

// Helper: toast notifikasi — pakai toast() yang sudah ada di settings.js (line ~1619).
// Wrapper showToast(msg, isOk) supaya bisa set warna berdasarkan success/error.
function showToast(msg, isOk) {
  // Pakai toast() bawaan kalau ada
  if (typeof toast === 'function') {
    toast(msg);
    return;
  }
  // Fallback: buat element toast temporary
  let t = document.getElementById('rf-linkpack-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'rf-linkpack-toast';
    t.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1c1917;color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;z-index:100000;box-shadow:0 4px 12px rgba(0,0,0,.2);max-width:90vw;';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.background = isOk === false ? '#b91c1c' : '#0f766e';
  t.style.display = 'block';
  clearTimeout(window._rfLinkPackToastTimer);
  window._rfLinkPackToastTimer = setTimeout(() => { t.style.display = 'none'; }, 4000);
}
