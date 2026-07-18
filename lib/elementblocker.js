// lib/elementblocker.js — Element Blocker: hide elemen + block script per-domain
// RecallFox v0.8.42
//
// Cara kerja:
//   1. Content script (elementblocker-cs.js) inject di semua halaman http(s)
//   2. Cek apakah domain halaman cocok dengan rules
//   3. Inject CSS untuk hide selectors
//   4. Remove iframe dari domain tracker
//   5. Override window.open di MAIN world untuk block popup

// ===== Preset rules untuk situs tertentu =====
export const DEFAULT_ELEMENT_BLOCKER_RULES = [
  {
    id: 'ninospositano',
    isPreset: true,
    name: 'NinosPositano / IDLIX21 (streaming + iklan judol)',
    domain: 'ninospositano.com',
    enabled: true,
    // CSS selectors untuk hide — comprehensive!
    selectors: [
      // Popup overlay
      '#idmuvi-popup',
      '.gmr-bannerpopup',
      '.gmr-bannerpopup-inner',
      '.banner-content',
      '#idmuvi-popup .close',
      '.gmr-popup-close',
      // Banner containers
      '.idmuvi-topbanner',
      '.idmuvi-topbanner-aftermenu',
      // Download popup palsu
      'a.popup-download',
      '.textdownload',
      // Trailer popup buttons
      '.gmr-popup-button-widget',
      'a.gmr-trailer-popup',
      // v0.8.45: Block SEMUA gambar dari domain iklan judol/gambling
      'img[src*="kilathoki"]',
      'img[src*="bandar36"]',
      'img[src*="klikhoki"]',
      'img[src*="banner-iklan"]',
      'img[src*="vip.idlix21.pro"]',
      'img[src*="hoki"]',
      'img[src*="casino"]',
      'img[src*="slot"]',
      'img[src*="poker"]',
      'img[src*="dewa"]',
      'img[src*="togel"]',
      'img[src*="sbobet"]',
      'img[src*="maxbet"]',
      // v0.8.45: Block link ke domain iklan/gambling
      'a[href*="kilathoki"]',
      'a[href*="bandar36"]',
      'a[href*="klikhoki"]',
      'a[href*="cek.to/idlix"]',
      'a[href*="morencius"]',
      'a[href*="hoki"]',
      'a[href*="casino"]',
      'a[href*="slot"]',
      'a[href*="poker"]',
      'a[href*="dewa"]',
      'a[href*="togel"]',
      'a[href*="sbobet"]',
      'a[href*="maxbet"]',
      // v0.8.45: Block generic ad containers
      'ins.adsbygoogle',
      '[id*="adsense"]',
      '[class*="ad-banner"]',
      '[class*="advertisement"]',
      '[id*="google_ads"]',
      // v0.8.47: Block konten dewasa (JAV, bokep, semi)
      // Block link ke kategori dewasa
      'a[href*="/category/jav-sub-indo"]',
      'a[href*="/category/bokep-indo"]',
      'a[href*="/category/vivamax"]',
      // Block video card yang URL-nya mengandung "jav-sub-indo"
      'a[href*="/jav-sub-indo-"]'
      // v0.8.48: HAPUS :has() selectors — bisa hide parent container yang berisi player
      // Adult card hiding sekarang dilakukan via JS (hideAdultContentCards) yang lebih precise
    ],
    // Domain tracker/ad yang iframe/script/img-nya di-remove
    blockDomains: [
      'dtscout.com',
      'dtscdn.com',
      'histats.com',
      'mrktmtrcs.net',
      'crwdcntrl.net',
      'doubleclick.net',
      'googlesyndication.com',
      'googletagservices.com',
      'amazon-adsystem.com',
      'taboola.com',
      'outbrain.com',
      'popads.net',
      'propellerads.com',
      'adsterra.com',
      // v0.8.45: Judol/gambling ad domains
      'kilathoki.info',
      'vip.idlix21.pro',
      'cek.to',
      'bandar36',
      'klikhoki'
      // v0.8.46: morencius.com DIHAPUS dari blockDomains — itu server video player!
      // Hanya a[href*="morencius"] di selectors yang di-hide (link download palsu),
      // tapi iframe morencius.com/embed/ TIDAK di-remove (itu video player-nya)
    ],
    // Block window.open (popup new tab)
    blockPopups: true
  },
  {
    id: 'idlix21-generic',
    isPreset: true,
    name: 'IDLIX21 mirror sites (semua domain idlix)',
    domain: 'idlix',
    enabled: true,
    selectors: [
      '#idmuvi-popup',
      '.gmr-bannerpopup',
      '.gmr-bannerpopup-inner',
      '.banner-content',
      '.idmuvi-topbanner',
      '.idmuvi-topbanner-aftermenu',
      'a.popup-download',
      '.textdownload',
      '.gmr-popup-button-widget',
      'a.gmr-trailer-popup',
      'img[src*="kilathoki"]',
      'img[src*="bandar36"]',
      'img[src*="klikhoki"]',
      'img[src*="banner-iklan"]',
      'img[src*="hoki"]',
      'a[href*="kilathoki"]',
      'a[href*="bandar36"]',
      'a[href*="klikhoki"]',
      'a[href*="cek.to/idlix"]',
      'a[href*="morencius"]'
    ],
    blockDomains: [
      'kilathoki.info',
      'vip.idlix21.pro',
      'cek.to',
      'dtscout.com',
      'histats.com',
      'popads.net',
      'propellerads.com'
      // v0.8.46: morencius.com DIHAPUS — itu server video player
    ],
    blockPopups: true
  }
];

// v0.9.0: Preset templates untuk "Tambah Situs Baru"
export const PRESET_TEMPLATES = {
  generic: {
    name: 'Generic Ad Blocker',
    selectors: [
      'ins.adsbygoogle', '[id*="adsense"]', '[class*="ad-banner"]',
      '[class*="advertisement"]', '[id*="google_ads"]', '[id*="ad-"]',
      '[class*="popup"]', '[id*="popup"]', '[class*="overlay-ad"]',
      '[class*="sponsor"]', '[id*="sponsor"]',
      'iframe[src*="doubleclick"]', 'iframe[src*="adsystem"]',
      'iframe[src*="googlesyndication"]', 'iframe[src*="taboola"]',
      'iframe[src*="outbrain"]', 'iframe[src*="popads"]'
    ],
    blockDomains: [
      'doubleclick.net', 'googlesyndication.com', 'googletagservices.com',
      'amazon-adsystem.com', 'taboola.com', 'outbrain.com',
      'popads.net', 'propellerads.com', 'adsterra.com'
    ],
    blockPopups: true
  },
  streaming: {
    name: 'Streaming Site Blocker',
    selectors: [
      '#idmuvi-popup', '.gmr-bannerpopup', '.gmr-bannerpopup-inner', '.banner-content',
      '.idmuvi-topbanner', '.idmuvi-topbanner-aftermenu',
      'a.popup-download', '.textdownload',
      '.gmr-popup-button-widget', 'a.gmr-trailer-popup',
      'img[src*="banner-iklan"]', 'img[src*="hoki"]', 'img[src*="casino"]',
      'img[src*="slot"]', 'img[src*="poker"]', 'img[src*="dewa"]', 'img[src*="togel"]',
      'a[href*="hoki"]', 'a[href*="casino"]', 'a[href*="slot"]', 'a[href*="poker"]',
      'a[href*="dewa"]', 'a[href*="togel"]', 'a[href*="sbobet"]', 'a[href*="maxbet"]',
      'ins.adsbygoogle', '[id*="adsense"]', '[class*="ad-banner"]',
      '[class*="advertisement"]', '[id*="google_ads"]',
      '[class*="popup"]', '[id*="popup"]', '[class*="sponsor"]'
    ],
    blockDomains: [
      'doubleclick.net', 'googlesyndication.com', 'amazon-adsystem.com',
      'taboola.com', 'outbrain.com', 'popads.net', 'propellerads.com',
      'adsterra.com', 'dtscout.com', 'histats.com'
    ],
    blockPopups: true
  }
};

// ===== Helper: cek apakah URL cocok dengan domain rule =====
// Support subdomain: 'ninospositano.com' match 'www.ninospositano.com' juga
export function matchesDomain(url, domain) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const d = domain.toLowerCase();
    return host === d || host.endsWith('.' + d);
  } catch (e) {
    return false;
  }
}

// ===== Helper: cari rule yang cocok untuk URL =====
export function findRulesForUrl(url, rules) {
  if (!rules || !Array.isArray(rules)) return [];
  return rules.filter(rule => rule.enabled !== false && matchesDomain(url, rule.domain));
}

// ===== Helper: cek apakah URL ada di blockDomains =====
export function isBlockedDomain(url, blockDomains) {
  if (!url || !blockDomains) return false;
  const lower = url.toLowerCase();
  for (const d of blockDomains) {
    if (lower.includes(d.toLowerCase())) return d;
  }
  return null;
}
