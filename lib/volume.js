// lib/volume.js — Volume control utilities (dB ↔ percentage conversion)
// RecallFox v0.5.0
//
// Volume is stored in dB (decibels), range -32 to +32.
//   0 dB  = 100% volume (normal)
//  +20 dB = 1000% volume (10x boost)
//  -32 dB = ~2.5% volume (almost silent)
//
// Gain = 10^(dB/20)

export const MIN_DB = -32;
export const MAX_DB = 32;
export const DEFAULT_DB = 0;

export function normalizeDb(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(MIN_DB, Math.min(MAX_DB, Math.round(n)));
}

export function getGainValue(dB) {
  return Math.pow(10, normalizeDb(dB) / 20);
}

export function dbToPercent(dB) {
  const gain = getGainValue(dB);
  return Math.round(gain * 100);
}

export function percentToDb(percent) {
  const gain = Math.max(0.001, percent / 100);
  const dB = 20 * Math.log10(gain);
  return normalizeDb(dB);
}

export function formatDb(value) {
  const n = normalizeDb(value);
  return `${n >= 0 ? '+' : ''}${n} dB`;
}

export function formatPercent(dB) {
  const pct = dbToPercent(dB);
  if (pct === 100) return '100%';
  if (pct > 100) return `${pct}% (boost)`;
  return `${pct}%`;
}

export function formatBadgeText(dB) {
  const n = normalizeDb(dB);
  return n > 0 ? `+${n}` : String(n);
}

// Check if URL is restricted (can't inject content scripts)
const RESTRICTED_PROTOCOLS = ['chrome', 'edge', 'about', 'extension', 'chrome-extension', 'moz-extension', 'view-source'];

export function isRestrictedUrl(url) {
  if (!url) return true;
  const protocol = url.split(':')[0];
  return RESTRICTED_PROTOCOLS.includes(protocol);
}

export function extractDomain(url) {
  if (!url) return '';
  if (isRestrictedUrl(url)) return '';
  try {
    const u = new URL(url);
    return u.hostname;
  } catch (e) {
    return '';
  }
}

// Per-site volume storage
const VOLUME_KEY = 'recallfox_volume_settings';

export async function getVolumeSettings() {
  const data = await browser.storage.local.get(VOLUME_KEY);
  return data[VOLUME_KEY] || { sites: {}, global: 0 };
}

export async function saveVolumeSettings(settings) {
  await browser.storage.local.set({ [VOLUME_KEY]: settings });
}

export async function getSiteVolume(domain) {
  const settings = await getVolumeSettings();
  if (!domain) return settings.global || 0;
  return settings.sites?.[domain] ?? settings.global ?? 0;
}

export async function setSiteVolume(domain, dB) {
  const settings = await getVolumeSettings();
  if (!domain) {
    settings.global = normalizeDb(dB);
  } else {
    if (!settings.sites) settings.sites = {};
    settings.sites[domain] = normalizeDb(dB);
  }
  await saveVolumeSettings(settings);
  return settings;
}
