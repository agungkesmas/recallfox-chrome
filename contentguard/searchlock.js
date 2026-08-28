// contentguard/searchlock.js — Halaman Kunci Pencarian (W3)
// RecallFox v3.21.0 — Pelindung Konten / Mode Fokus
//
// Dibuka oleh background.checkContentGuard saat user melakukan pencarian di
// luar topik profil aktif (YouTube atau X). URL params:
//   ?platform=youtube|x&profileId=<id>
//
// Memuat profil dari background (CG_GET_TOPIC_PROFILES), menampilkan kartu
// untuk tiap topik profil. Klik kartu → navigasi ke search topik di tab yang
// sama (youtube.com/results?search_query=<topic> atau x.com/search?q=<topic>).
// Query ini lolos pemeriksaan Search Lock (karena persis = topik profil).

(async function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const platform = params.get('platform') === 'x' ? 'x' : 'youtube';
  const profileId = params.get('profileId') || '';
  const isYouTube = platform === 'youtube';
  const isX = platform === 'x';

  const platformLabel = isYouTube ? 'YouTube' : (isX ? 'X (Twitter)' : 'platform');
  document.getElementById('sl-platform-label').textContent = platformLabel;
  document.getElementById('sl-platform-label-2').textContent = platformLabel;
  document.getElementById('sl-section-icon').textContent = isYouTube ? '📺' : '🔍';

  // ===== Ambil topic profiles dari background =====
  let topicProfiles = null;
  try {
    const resp = await browser.runtime.sendMessage({ type: 'CG_GET_TOPIC_PROFILES' });
    if (resp && resp.ok && resp.topicProfiles) topicProfiles = resp.topicProfiles;
  } catch (e) {
    console.warn('[RecallFox/SL] Gagal ambil topic profiles:', e);
  }
  if (!topicProfiles || !Array.isArray(topicProfiles.profiles)) {
    topicProfiles = { profiles: [], activeProfileId: null };
  }

  // Cari profil aktif: prioritas profileId dari URL, fallback ke activeProfileId.
  let profile = null;
  if (profileId) {
    profile = topicProfiles.profiles.find(p => p.id === profileId) || null;
  }
  if (!profile && topicProfiles.activeProfileId) {
    profile = topicProfiles.profiles.find(p => p.id === topicProfiles.activeProfileId) || null;
  }
  if (!profile && topicProfiles.profiles.length > 0) {
    profile = topicProfiles.profiles[0];
  }

  // ===== Render profil name =====
  const profileNameEl = document.getElementById('sl-profile-name');
  if (profileNameEl) {
    profileNameEl.textContent = profile
      ? ((profile.emoji || '👤') + ' ' + (profile.name || 'Profil'))
      : '— profil tidak ditemukan —';
  }

  // ===== Render grid topik =====
  const grid = document.getElementById('sl-grid');
  const topics = (profile && Array.isArray(profile.topics)) ? profile.topics : [];

  if (topics.length === 0) {
    grid.innerHTML = '<div class="sl-empty">Profil aktif tidak punya topik. ' +
      'Buka Pengaturan Pelindung Konten untuk menambah topik, atau matikan Mode Fokus ' +
      'untuk membuka kunci pencarian bebas.</div>';
  } else {
    grid.innerHTML = topics.map(t => {
      const url = isYouTube
        ? 'https://www.youtube.com/results?search_query=' + encodeURIComponent(t)
        : 'https://x.com/search?q=' + encodeURIComponent(t) + '&src=typed_query&f=top';
      return '<a class="sl-card" href="' + url + '">' +
        '<div class="sl-card-icon">🔎</div>' +
        '<div class="sl-card-body">' +
          '<div class="sl-card-label">' + escapeHtml(t) + '</div>' +
          '<div class="sl-card-meta">Telusuri topik ini →</div>' +
        '</div>' +
        '<div class="sl-card-arrow">→</div>' +
      '</a>';
    }).join('');
  }

  // ===== Tombol buka pengaturan =====
  const settingsBtn = document.getElementById('sl-open-settings');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      try { browser.runtime.openOptionsPage(); }
      catch (e) {
        // Fallback: buka tab settings langsung
        const url = browser.runtime.getURL('settings/settings.html');
        browser.tabs.create({ url });
      }
    });
  }

  // ===== Helper escape =====
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
})();
