// lib/ai-detect.js — AI page detection (single source of truth: storage.aiSites)
// v3.16.2: Refactor sesuai Google Doc troubleshooting
//
// aiSites format di browser.storage.local:
//   aiSites: [
//     { id: string, name: string, origin: string, active: boolean }
//   ]
//
// Migration dari AI_TOOLS + aiToolsCustomizations:
//   - Built-in AI_TOOLS (lib/ai-tools.js) → aiSites dengan active=true
//   - Custom user-added tools → aiSites dengan active=true
//   - Tools yang di-hidden → aiSites dengan active=false

const DEBUG_AI = true;

export function logAI(...args) {
  if (!DEBUG_AI) return;
  console.log('[RecallFox AI]', ...args);
}

/**
 * matchDomain: case insensitive, support subdomain, anti-gagal
 * currentOrigin: "https://chat.z.ai"
 * configuredOrigin: "https://chat.z.ai" atau "https://z.ai"
 */
export function matchDomain(currentOrigin, configuredOrigin) {
  try {
    if (!currentOrigin || !configuredOrigin) return false;
    const current = new URL(currentOrigin);
    const config = new URL(configuredOrigin);
    const currentHost = current.hostname.toLowerCase();
    const configHost = config.hostname.toLowerCase();
    return (
      currentHost === configHost ||
      currentHost.endsWith('.' + configHost)
    );
  } catch {
    return false;
  }
}

/**
 * getAiSites: baca dari storage.aiSites.
 * Kalau belum ada (migration), build dari AI_TOOLS + customizations.
 */
export async function getAiSites() {
  try {
    const r = await browser.storage.local.get(['aiSites', 'settings']);
    if (r.aiSites && Array.isArray(r.aiSites) && r.aiSites.length > 0) {
      logAI('aiSites loaded from storage:', r.aiSites.length, 'sites');
      return r.aiSites;
    }
    // Migration: kalau aiSites belum ada, build dari AI_TOOLS + customizations
    logAI('aiSites empty, migrating from AI_TOOLS + customizations...');
    const migrated = await migrateFromAiTools(r.settings || {});
    if (migrated.length > 0) {
      await browser.storage.local.set({ aiSites: migrated });
      logAI('Migration done:', migrated.length, 'sites saved');
    }
    return migrated;
  } catch (err) {
    console.error('[AI DETECT ERROR] getAiSites:', err);
    return [];
  }
}

/**
 * migrateFromAiTools: build aiSites dari AI_TOOLS + customizations
 * Dipakai sekali saat migration. Setelah itu, aiSites jadi source of truth.
 */
export async function migrateFromAiTools(settings) {
  try {
    const mod = await import('./ai-tools.js');
    const getEffectiveTools = mod.getEffectiveTools;
    const customizations = settings.aiToolsCustomizations || {};
    const effective = getEffectiveTools(customizations);
    return effective.map(t => ({
      id: t.id,
      name: t.name,
      origin: t.url,
      active: !t.hidden
    }));
  } catch (e) {
    console.error('[AI DETECT] Migration failed:', e);
    return [];
  }
}

/**
 * isAIPage: cek apakah current page (content script context) adalah AI page.
 * Pakai window.location.origin.
 */
export async function isAIPage() {
  try {
    const aiSites = await getAiSites();
    const currentOrigin = window.location.origin;
    if (!aiSites.length) {
      logAI('No aiSites configured');
      return false;
    }
    for (const site of aiSites) {
      if (!site.active) continue;
      if (matchDomain(currentOrigin, site.origin)) {
        logAI('MATCH:', site.name, '→', currentOrigin);
        return true;
      }
    }
    logAI('NO MATCH:', currentOrigin);
    return false;
  } catch (err) {
    console.error('[AI DETECT ERROR] isAIPage:', err);
    return false;
  }
}

/**
 * isAIPageFromOrigin: versi isAIPage untuk background script (pakai tab URL).
 * origin: "https://chat.z.ai"
 */
export async function isAIPageFromOrigin(origin) {
  try {
    if (!origin) return false;
    const aiSites = await getAiSites();
    if (!aiSites.length) {
      logAI('No aiSites configured');
      return false;
    }
    for (const site of aiSites) {
      if (!site.active) continue;
      if (matchDomain(origin, site.origin)) {
        logAI('MATCH:', site.name, '→', origin);
        return true;
      }
    }
    logAI('NO MATCH:', origin);
    return false;
  } catch (err) {
    console.error('[AI DETECT ERROR] isAIPageFromOrigin:', err);
    return false;
  }
}

/**
 * getMatchedSite: return site yang match (untuk dapatkan name/id)
 */
export async function getMatchedSite(origin) {
  try {
    const aiSites = await getAiSites();
    for (const site of aiSites) {
      if (!site.active) continue;
      if (matchDomain(origin, site.origin)) {
        return site;
      }
    }
    return null;
  } catch (err) {
    console.error('[AI DETECT ERROR] getMatchedSite:', err);
    return null;
  }
}

/**
 * addAiSite: tambah site baru ke aiSites
 */
export async function addAiSite(site) {
  try {
    const aiSites = await getAiSites();
    const newSite = {
      id: site.id || 'site_' + Date.now(),
      name: site.name || 'Untitled',
      origin: site.origin,
      active: site.active !== false
    };
    // Cek duplikat by origin
    const exists = aiSites.some(s => matchDomain(newSite.origin, s.origin) || matchDomain(s.origin, newSite.origin));
    if (exists) {
      logAI('Site already exists:', newSite.origin);
      return null;
    }
    aiSites.push(newSite);
    await browser.storage.local.set({ aiSites });
    logAI('Added:', newSite);
    return newSite;
  } catch (err) {
    console.error('[AI DETECT ERROR] addAiSite:', err);
    return null;
  }
}

/**
 * removeAiSite: hapus site dari aiSites by id
 */
export async function removeAiSite(id) {
  try {
    const aiSites = await getAiSites();
    const filtered = aiSites.filter(s => s.id !== id);
    await browser.storage.local.set({ aiSites: filtered });
    logAI('Removed:', id);
    return true;
  } catch (err) {
    console.error('[AI DETECT ERROR] removeAiSite:', err);
    return false;
  }
}

/**
 * toggleAiSite: aktifkan/nonaktifkan site by id
 */
export async function toggleAiSite(id, active) {
  try {
    const aiSites = await getAiSites();
    const site = aiSites.find(s => s.id === id);
    if (site) {
      site.active = !!active;
      await browser.storage.local.set({ aiSites });
      logAI('Toggled:', id, '→', site.active);
      return true;
    }
    return false;
  } catch (err) {
    console.error('[AI DETECT ERROR] toggleAiSite:', err);
    return false;
  }
}

/**
 * updateAiSite: update site by id (name, origin, active)
 */
export async function updateAiSite(id, patch) {
  try {
    const aiSites = await getAiSites();
    const site = aiSites.find(s => s.id === id);
    if (site) {
      if (patch.name !== undefined) site.name = patch.name;
      if (patch.origin !== undefined) site.origin = patch.origin;
      if (patch.active !== undefined) site.active = !!patch.active;
      await browser.storage.local.set({ aiSites });
      logAI('Updated:', id, '→', site);
      return true;
    }
    return false;
  } catch (err) {
    console.error('[AI DETECT ERROR] updateAiSite:', err);
    return false;
  }
}
