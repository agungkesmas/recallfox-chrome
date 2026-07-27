// popup/viewer.js — Document multi-page viewer (v3.12.1)
// FIX BUG v3.12.0: Viewer lama pakai window.open + document.write + inline script
// dengan base64 JSON besar → image tidak tampil (kemungkinan pages[0] null saat
// render(0) dipanggil, atau CSP / inline script issue di Firefox MV3).
//
// Solusi: static HTML page yang dibuka sebagai tab via browser.tabs.create().
// Image di-render via <img src="cloudUrl"> langsung — Firefox yang load dari
// Supabase Storage public URL. Tidak ada inline script, tidak ada base64 JSON.
//
// Strategi load page:
//   1. Coba <img src="page.url"> (cloud URL public Supabase Storage)
//   2. Kalau gagal (onerror), fallback ke background GET_SCREENSHOT_BLOB
//      (untuk halaman 1, mungkin ada di cache lokal) atau fetch URL → blob URL
//   3. Kalau masih gagal, tampilkan error box dengan tombol "Coba lagi"

const $ = (sel) => document.querySelector(sel);

// ===== Parse ?id=... from URL =====
const params = new URLSearchParams(location.search);
const docId = params.get('id');

if (!docId) {
  showError('ID dokumen tidak ditemukan di URL');
} else {
  init();
}

async function init() {
  // ===== Request document metadata from background =====
  let meta;
  try {
    const res = await browser.runtime.sendMessage({ type: 'GET_DOCUMENT_PAGES', id: docId });
    if (!res?.ok) {
      showError(res?.error || 'Dokumen tidak ditemukan');
      return;
    }
    meta = res;
  } catch (e) {
    showError('Gagal terhubung ke background: ' + e.message);
    return;
  }

  const pages = meta.pages || [];
  const totalPages = pages.length;
  if (totalPages === 0) {
    showError('Dokumen tidak punya halaman');
    return;
  }

  // ===== Render header =====
  $('#docTitle').textContent = '📄 ' + (meta.title || 'Dokumen');
  $('#docCount').textContent = totalPages + ' halaman · RecallFox';

  // ===== Build dots =====
  const dotsEl = $('#dots');
  if (totalPages > 1) {
    dotsEl.classList.add('multi');
    dotsEl.innerHTML = pages.map((_, i) =>
      `<span class="dot${i === 0 ? ' active' : ''}" data-idx="${i}"></span>`
    ).join('');
    dotsEl.querySelectorAll('.dot').forEach(d => {
      d.addEventListener('click', () => renderPage(parseInt(d.dataset.idx, 10)));
    });
  }

  // ===== Nav buttons =====
  const prevBtn = $('#prevBtn');
  const nextBtn = $('#nextBtn');
  const ind = $('#ind');
  if (totalPages === 1) {
    prevBtn.style.display = 'none';
    nextBtn.style.display = 'none';
  }

  let cur = 0;

  prevBtn.addEventListener('click', () => { if (cur > 0) renderPage(cur - 1); });
  nextBtn.addEventListener('click', () => { if (cur < totalPages - 1) renderPage(cur + 1); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' && cur > 0) renderPage(cur - 1);
    else if (e.key === 'ArrowRight' && cur < totalPages - 1) renderPage(cur + 1);
  });

  // Close button
  $('#closeBtn').addEventListener('click', () => {
    browser.tabs.remove(browser.tabs.getCurrent().catch(() => null)).catch(() => window.close());
  });

  // ===== Render page function =====
  const img = $('#pageImg');
  const loadingEl = $('#loading');
  const errBox = $('#errBox');

  async function renderPage(idx) {
    cur = idx;
    const page = pages[idx];

    // Update UI state
    img.classList.remove('loaded');
    img.removeAttribute('src');
    img.onload = null;
    img.onerror = null;
    errBox.style.display = 'none';
    loadingEl.style.display = 'flex';

    // Update nav state
    ind.textContent = 'Hal ' + (idx + 1) + ' / ' + totalPages;
    prevBtn.disabled = (idx === 0);
    nextBtn.disabled = (idx === totalPages - 1);
    dotsEl.querySelectorAll('.dot').forEach((d, i) => {
      d.classList.toggle('active', i === idx);
    });

    if (!page) {
      loadingEl.style.display = 'none';
      showError('Halaman ' + (idx + 1) + ' tidak ada metadatanya');
      return;
    }

    // Try loading the image
    const loaded = await tryLoadImage(img, page, idx);
    loadingEl.style.display = 'none';

    if (loaded) {
      img.classList.add('loaded');
    } else {
      errBox.style.display = 'flex';
      $('#errMsg').textContent = 'Gagal memuat halaman ' + (idx + 1);
    }
  }

  // Retry button
  $('#retryBtn').addEventListener('click', () => renderPage(cur));

  // Download button
  $('#downloadBtn').addEventListener('click', async () => {
    const page = pages[cur];
    if (!page?.url) { alert('URL halaman tidak tersedia'); return; }
    try {
      // Use Firefox's built-in download via background
      await browser.runtime.sendMessage({
        type: 'DOWNLOAD_URL',
        url: page.url,
        filename: sanitizeFilename((meta.title || 'dokumen') + '_hal' + (cur + 1) + '.jpg')
      });
    } catch (e) {
      // Fallback: open in new tab so user can manually save
      window.open(page.url, '_blank');
    }
  });

  // Open in tab button (Firefox native image viewer)
  $('#openTabBtn').addEventListener('click', () => {
    const page = pages[cur];
    if (!page?.url) { alert('URL halaman tidak tersedia'); return; }
    browser.tabs.create({ url: page.url });
  });

  // ===== Image loading with fallbacks =====
  async function tryLoadImage(imgEl, page, idx) {
    // Strategy 1: cloud URL
    if (page.url) {
      const ok = await loadImage(imgEl, page.url);
      if (ok) return true;
    }

    // Strategy 2: GET_SCREENSHOT_BLOB (only works for page 0 — PWA sets gdrive_file_url to page 1)
    if (idx === 0) {
      try {
        const res = await browser.runtime.sendMessage({ type: 'GET_SCREENSHOT_BLOB', id: docId });
        if (res?.ok && res.dataUrl) {
          const ok = await loadImage(imgEl, res.dataUrl);
          if (ok) return true;
        }
      } catch (e) { /* ignore */ }
    }

    // Strategy 3: fetch URL → blob URL (handles CORS issues by routing through extension)
    if (page.url) {
      try {
        const r = await fetch(page.url);
        if (r.ok) {
          const blob = await r.blob();
          if (blob && blob.size > 0) {
            const blobUrl = URL.createObjectURL(blob);
            const ok = await loadImage(imgEl, blobUrl);
            // Note: blob URL persists for tab lifetime; no revoke needed here
            return ok;
          }
        }
      } catch (e) { /* ignore */ }
    }

    return false;
  }

  function loadImage(imgEl, src) {
    return new Promise((resolve) => {
      let settled = false;
      const cleanup = () => {
        imgEl.onload = null;
        imgEl.onerror = null;
      };
      imgEl.onload = () => { if (!settled) { settled = true; cleanup(); resolve(true); } };
      imgEl.onerror = () => { if (!settled) { settled = true; cleanup(); resolve(false); } };
      // Timeout 15s — if image hangs, treat as failure
      setTimeout(() => { if (!settled) { settled = true; cleanup(); resolve(false); } }, 15000);
      imgEl.src = src;
    });
  }

  // ===== Initial render =====
  renderPage(0);
}

function showError(msg) {
  $('#loading').style.display = 'none';
  $('#pageImg').classList.remove('loaded');
  const errBox = $('#errBox');
  errBox.style.display = 'flex';
  $('#errMsg').textContent = msg;
}

function sanitizeFilename(name) {
  return String(name).replace(/[^a-zA-Z0-9_\-\. ]/g, '_').slice(0, 80);
}
