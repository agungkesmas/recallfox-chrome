// lib/clearcache.js — Clear browsing data (clearcache-style)
// RecallFox v0.3.0
//
// Inspired by github.com/TenSoja/clear-cache (MIT)
// Adapted to RecallFox architecture (uses RecallFox's storage.js settings).
//
// Public API:
//   clearBrowsingData(opts) → Promise<{ok, clearedTypes[], scope, message}>
//   opts:
//     dataTypes:       string[]  (from settings.clearCacheDataTypes)
//     timePeriod:      string    (from settings.clearCacheTimePeriod)
//     currentTabOnly:  boolean   (from settings.clearCacheCurrentTabOnly)
//     reload:          boolean   (from settings.clearCacheReload)
//     notify:          boolean   (from settings.clearCacheNotify)
//
// Data types supported by browser.browsingData.remove():
//   cache, cookies, downloads, formData, history, indexedDB,
//   localStorage, passwords, serviceWorkers
//
// Of these, only these support per-hostname clearing (currentTabOnly=true):
//   cookies, indexedDB, localStorage, serviceWorkers

const HOSTNAME_SUPPORTED_TYPES = new Set([
  'cookies', 'indexedDB', 'localStorage', 'serviceWorkers'
]);

const UNSUPPORTED_PROTOCOLS = [
  'about:', 'file:', 'data:', 'blob:', 'moz-extension:', 'chrome:', 'javascript:'
];

function isUnsupportedUrl(url) {
  if (!url) return true;
  return UNSUPPORTED_PROTOCOLS.some(p => url.startsWith(p));
}

function getSinceTimestamp(period) {
  const now = Date.now();
  switch (period) {
    case '15min':   return now - 15 * 60 * 1000;
    case '1hour':   return now - 60 * 60 * 1000;
    case '24hours': return now - 24 * 60 * 60 * 1000;
    case '1week':   return now - 7 * 24 * 60 * 60 * 1000;
    case 'all':
    default:        return 0;
  }
}

function typesArrayToObj(arr) {
  const obj = {};
  for (const t of arr || []) obj[t] = true;
  return obj;
}

// Filter types to only those permitted by browser settings
async function filterPermittedTypes(typesObj) {
  if (!browser.browsingData || !browser.browsingData.settings) {
    return typesObj;
  }
  try {
    const settings = await browser.browsingData.settings();
    const permitted = settings.dataRemovalPermitted || settings.dataToRemove || {};
    const filtered = {};
    for (const type of Object.keys(typesObj)) {
      if (permitted[type] !== false) filtered[type] = true;
    }
    return filtered;
  } catch (e) {
    return typesObj;
  }
}

// Show a Firefox notification (basic type)
async function showNotification(title, message) {
  if (!browser.notifications || !browser.notifications.create) return;
  try {
    await browser.notifications.create({
      type: 'basic',
      title,
      message,
      iconUrl: browser.runtime.getURL('icons/icon-96.svg')
    });
  } catch (e) {
    console.warn('[RecallFox] notification failed:', e.message);
  }
}

export async function clearBrowsingData(opts = {}) {
  const dataTypes = opts.dataTypes || ['cache'];
  const timePeriod = opts.timePeriod || 'all';
  const currentTabOnly = !!opts.currentTabOnly;
  const reload = !!opts.reload;
  const notify = opts.notify !== false;

  const since = getSinceTimestamp(timePeriod);
  let typesObj = typesArrayToObj(dataTypes);
  typesObj = await filterPermittedTypes(typesObj);

  if (Object.keys(typesObj).length === 0) {
    return {
      ok: false,
      error: 'no_types',
      message: 'Tidak ada tipe data yang dipilih untuk dibersihkan.'
    };
  }

  // === Current tab only mode ===
  if (currentTabOnly) {
    // Split into compatible (per-hostname) and incompatible types
    const compatibleTypes = {};
    const incompatibleTypes = {};
    for (const t of Object.keys(typesObj)) {
      if (HOSTNAME_SUPPORTED_TYPES.has(t)) compatibleTypes[t] = true;
      else incompatibleTypes[t] = true;
    }

    if (Object.keys(compatibleTypes).length === 0) {
      return {
        ok: false,
        error: 'incompatible_types',
        message: 'Tipe data yang dipilih (cache, history, dll) tidak bisa dibersihkan per-site. Matikan "Hanya tab aktif" atau pilih cookies/localStorage.'
      };
    }

    // Get active tab hostname
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = tabs?.[0];
    if (!tab || isUnsupportedUrl(tab.url)) {
      return {
        ok: false,
        error: 'unsupported_url',
        message: 'URL tab aktif tidak didukung untuk clear per-site.'
      };
    }

    let hostname;
    try {
      hostname = new URL(tab.url).hostname;
    } catch (e) {
      return { ok: false, error: 'invalid_url', message: 'URL tab aktif tidak valid.' };
    }
    if (!hostname) {
      return { ok: false, error: 'no_hostname', message: 'Tidak ada hostname di URL tab aktif.' };
    }

    console.log('[RecallFox] Clearing per-site:', hostname, 'types:', Object.keys(compatibleTypes));
    try {
      await browser.browsingData.remove(
        { hostnames: [hostname], since },
        compatibleTypes
      );
    } catch (e) {
      return { ok: false, error: e.message };
    }

    if (reload) {
      try { await browser.tabs.reload(); } catch (e) {}
    }

    const clearedTypes = Object.keys(compatibleTypes);
    const skippedTypes = Object.keys(incompatibleTypes);
    const message = `Dibersihkan untuk ${hostname}: ${clearedTypes.join(', ')}` +
                    (skippedTypes.length ? `\nDilewati (tidak support per-site): ${skippedTypes.join(', ')}` : '');

    if (notify) {
      await showNotification('RecallFox — Cache Dibersihkan', message);
    }

    return {
      ok: true,
      clearedTypes,
      skippedTypes,
      scope: 'site:' + hostname,
      message
    };
  }

  // === Global clear ===
  console.log('[RecallFox] Clearing globally, types:', Object.keys(typesObj), 'since:', since);
  try {
    await browser.browsingData.remove({ since }, typesObj);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  if (reload) {
    try { await browser.tabs.reload(); } catch (e) {}
  }

  const clearedTypes = Object.keys(typesObj);
  const periodLabel = {
    '15min': '15 menit terakhir',
    '1hour': '1 jam terakhir',
    '24hours': '24 jam terakhir',
    '1week': '1 minggu terakhir',
    'all': 'semua waktu'
  }[timePeriod] || timePeriod;

  const message = `Dibersihkan: ${clearedTypes.join(', ')} (${periodLabel})`;
  if (notify) {
    await showNotification('RecallFox — Cache Dibersihkan', message);
  }

  return {
    ok: true,
    clearedTypes,
    scope: 'global',
    message
  };
}
