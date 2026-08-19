// contentguard/blocked.js — Halaman "berita negatif diblokir"
// RecallFox v0.8.20

(async function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const blockedDomain = params.get('domain') || '(situs)';
  const originalUrl = params.get('url') || '';

  document.getElementById('cg-blocked-domain').textContent = blockedDomain;
  document.getElementById('cg-blocked-domain-btn').textContent = blockedDomain;

  // ===== Bypass 2-klik =====
  const bypassBtn = document.getElementById('cg-bypass');
  let confirming = false;
  let confirmTimer = null;

  // Load settings untuk cek strict mode
  let strictMode = true;
  try {
    const vault = await browser.runtime.sendMessage({ type: 'CG_GET_VAULT' });
    if (vault?.settings?.contentGuardStrictMode === false) strictMode = false;
  } catch (e) {}

  bypassBtn.addEventListener('click', async () => {
    if (strictMode) {
      if (!confirming) {
        confirming = true;
        bypassBtn.classList.add('confirming');
        bypassBtn.innerHTML = `⚠️ Klik lagi untuk konfirmasi lanjut ke ${blockedDomain}`;
        confirmTimer = setTimeout(() => {
          confirming = false;
          bypassBtn.classList.remove('confirming');
          bypassBtn.innerHTML = `Tetap lanjut ke <span id="cg-blocked-domain-btn">${blockedDomain}</span> →`;
        }, 3000);
        return;
      }
    }
    clearTimeout(confirmTimer);
    if (originalUrl) {
      try { await browser.runtime.sendMessage({ type: 'CG_MARK_BYPASS', url: originalUrl }); }
      catch (e) {}
      location.href = originalUrl;
    }
  });

  document.getElementById('cg-open-settings').addEventListener('click', () => {
    browser.runtime.openOptionsPage();
  });
})();
