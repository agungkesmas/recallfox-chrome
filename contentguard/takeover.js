// contentguard/takeover.js — Logika halaman takeover (force-redirect ke konten positif Tiongkok)
// RecallFox v0.8.20

(async function () {
  'use strict';

  // ===== Ambil params =====
  const params = new URLSearchParams(location.search);
  const platform = params.get('platform') || 'youtube';  // 'youtube' | 'x'
  const originalUrl = params.get('url') || '';
  const isYouTube = platform === 'youtube';
  const isX = platform === 'x';

  // ===== Load settings =====
  let settings = null;
  try {
    const vault = await browser.runtime.sendMessage({ type: 'CG_GET_VAULT' });
    if (vault && vault.settings) settings = vault.settings;
  } catch (e) {
    console.warn('[RecallFox/CG] Gagal ambil vault:', e);
  }
  if (!settings) settings = {};

  // ===== Render header dinamis =====
  const platformLabel = isYouTube ? 'YouTube' : (isX ? 'X (Twitter)' : 'platform');
  document.getElementById('cg-platform-label').textContent = platformLabel;
  document.getElementById('cg-bypass-platform').textContent = platformLabel;
  document.getElementById('cg-sub').textContent =
    `Mengarahkan Anda ke konten positif dari Tiongkok sebagai ganti feed ${platformLabel}`;
  document.getElementById('cg-section-icon').textContent = isYouTube ? '📺' : '🔍';
  document.getElementById('cg-section-heading').textContent =
    isYouTube ? 'Telusuri di YouTube' : 'Telusuri di X (Twitter)';

  // ===== Render grid pencarian =====
  const grid = document.getElementById('cg-grid');
  const searches = isYouTube
    ? (settings.contentGuardChinaSearches || [])
    : (settings.contentGuardChinaXSearches || []);

  grid.innerHTML = searches.map(s => {
    const url = isYouTube
      ? `https://www.youtube.com/results?search_query=${encodeURIComponent(s.q)}`
      : `https://x.com/search?q=${encodeURIComponent(s.q)}&src=typed_query&f=top`;
    return `
      <a class="cg-card" href="${url}" target="_blank" rel="noopener">
        <div class="cg-card-icon">${s.icon || (isYouTube ? '📺' : '🔍')}</div>
        <div class="cg-card-body">
          <div class="cg-card-label">${escapeHtml(s.label || s.q)}</div>
          <div class="cg-card-meta">${escapeHtml(s.q)}</div>
        </div>
        <div class="cg-card-arrow">→</div>
      </a>
    `;
  }).join('');

  // ===== Render akun X (khusus X) =====
  if (isX) {
    const accSection = document.getElementById('cg-accounts-section');
    const accList = document.getElementById('cg-accounts');
    const accounts = settings.contentGuardChinaXAccounts || [];
    if (accounts.length > 0) {
      accSection.style.display = 'block';
      accList.innerHTML = accounts.map(a => {
        const handle = a.handle.replace(/^@/, '');
        return `
          <a class="cg-account" href="https://x.com/${encodeURIComponent(handle)}" target="_blank" rel="noopener">
            <div class="cg-account-handle">${escapeHtml(a.handle)}</div>
            <div class="cg-account-name">${escapeHtml(a.name || '')}</div>
            <div class="cg-account-note">${escapeHtml(a.note || '')}</div>
          </a>
        `;
      }).join('');
    }
  }

  // ===== Bypass button (mode paksa: butuh 2 klik) =====
  const bypassBtn = document.getElementById('cg-bypass');
  let confirming = false;
  let confirmTimer = null;
  bypassBtn.addEventListener('click', async () => {
    if (settings.contentGuardStrictMode !== false) {
      if (!confirming) {
        confirming = true;
        bypassBtn.classList.add('confirming');
        bypassBtn.innerHTML = `⚠️ Klik lagi untuk konfirmasi lewati ke ${platformLabel}`;
        confirmTimer = setTimeout(() => {
          confirming = false;
          bypassBtn.classList.remove('confirming');
          bypassBtn.innerHTML = `Lanjut ke <span id="cg-bypass-platform">${platformLabel}</span> →`;
        }, 3000);
        return;
      }
    }
    // Lanjutkan — buka tab ke platform asli
    clearTimeout(confirmTimer);
    if (originalUrl) {
      // Tandai bahwa user sudah bypass agar tidak di-redirect lagi
      await markBypass(originalUrl);
      location.href = originalUrl;
    } else {
      // Fallback: buka home platform
      const home = isYouTube ? 'https://www.youtube.com/' : 'https://x.com/home';
      await markBypass(home);
      location.href = home;
    }
  });

  // ===== Tombol settings =====
  document.getElementById('cg-open-settings').addEventListener('click', () => {
    browser.runtime.openOptionsPage();
  });

  // ===== Helper: tandai bypass supaya tidak di-redirect ulang =====
  async function markBypass(url) {
    try {
      await browser.runtime.sendMessage({ type: 'CG_MARK_BYPASS', url });
    } catch (e) {}
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
