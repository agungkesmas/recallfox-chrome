// content/capture.js — Page-side screenshot capture helper
// RecallFox v0.2.0 — FireShot-inspired minimal port
//
// This module is loaded on-demand via browser.scripting.executeScript()
// (NOT a content_scripts entry) so it only runs when the user actually
// triggers a screenshot. It exposes a single global function:
//
//   window.__RecallFoxCapture__(mode, opts) -> Promise<{
//     dataUrl:        string,   // PNG/JPEG data URL of the captured region
//     width:          number,
//     height:         number,
//     bytes:          number,
//     pageTitle:      string,
//     url:            string,
//     selectionRect:  {left, top, width, height} | null,
//     cancelled:      boolean   // true if user pressed Esc during selection
//   }>
//
// Modes:
//   'visible'    — single captureVisibleTab, no scroll
//   'entire'     — scroll-and-stitch, builds an offscreen canvas from
//                  multiple captureVisibleTab chunks
//   'selection'  — show drag-to-select overlay, return only the selected
//                  rect cropped from a single captureVisibleTab
//
// Important: captureVisibleTab can ONLY be called from the background
// script context, so we use a port-based protocol with the background.
// The content script orchestrates scrolling + selection UI, and asks
// the background to grab each visible frame.

(function () {
  if (window.__RecallFoxCaptureLoaded__) return;
  window.__RecallFoxCaptureLoaded__ = true;

  // ===== Utilities =====

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Inject the capture stylesheet (declares overlay + banner styles
  // so they don't pollute content/content.css which is only loaded
  // on AI domains).
  function ensureStyles() {
    if (document.getElementById('recallfox-capture-style')) return;
    const link = document.createElement('link');
    link.id = 'recallfox-capture-style';
    link.rel = 'stylesheet';
    link.href = browser.runtime.getURL('content/capture.css');
    document.head.appendChild(link);
  }

  // ===== Progress banner =====
  function showBanner(text) {
    let b = document.getElementById('recallfox-capture-banner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'recallfox-capture-banner';
      b.className = 'recallfox-capture-banner';
      document.body.appendChild(b);
    }
    b.textContent = text;
    b.classList.add('show');
    return b;
  }
  function hideBanner() {
    const b = document.getElementById('recallfox-capture-banner');
    if (b) b.classList.remove('show');
  }

  // ===== Selection overlay (FireShot FSSelector port, minimal) =====
  //
  // Creates a fixed-position overlay with 4 dimmed regions outside the
  // selection rectangle. The user drags to draw a rectangle; Esc cancels.
  // Returns a Promise that resolves to {left, top, width, height} in
  // CSS pixels relative to the viewport, or null if cancelled.

  function showSelectionOverlay() {
    return new Promise((resolve) => {
      ensureStyles();

      const overlay = document.createElement('div');
      overlay.className = 'recallfox-sel-overlay';
      overlay.innerHTML = `
        <div class="recallfox-sel-mask recallfox-sel-mask-top"></div>
        <div class="recallfox-sel-mask recallfox-sel-mask-left"></div>
        <div class="recallfox-sel-mask recallfox-sel-mask-right"></div>
        <div class="recallfox-sel-mask recallfox-sel-mask-bottom"></div>
        <div class="recallfox-sel-border" hidden></div>
        <div class="recallfox-sel-hint" hidden></div>
        <div class="recallfox-sel-tip">Drag untuk pilih area · Esc untuk batal</div>
      `;
      document.body.appendChild(overlay);

      const border = overlay.querySelector('.recallfox-sel-border');
      const hint = overlay.querySelector('.recallfox-sel-hint');
      const masks = {
        top: overlay.querySelector('.recallfox-sel-mask-top'),
        left: overlay.querySelector('.recallfox-sel-mask-left'),
        right: overlay.querySelector('.recallfox-sel-mask-right'),
        bottom: overlay.querySelector('.recallfox-sel-mask-bottom')
      };

      let startX = 0, startY = 0, endX = 0, endY = 0;
      let dragging = false;

      function updateMasks(rect) {
        // Top: from 0,0 to viewportWidth × rect.top
        masks.top.style.cssText =
          `position:fixed;left:0;top:0;width:100vw;height:${rect.top}px;` +
          `background:rgba(15,23,42,0.45);pointer-events:none;`;
        // Left: from 0,rect.top to rect.left × rect.height
        masks.left.style.cssText =
          `position:fixed;left:0;top:${rect.top}px;width:${rect.left}px;height:${rect.height}px;` +
          `background:rgba(15,23,42,0.45);pointer-events:none;`;
        // Right: from rect.right,rect.top to viewportWidth-rect.right × rect.height
        masks.right.style.cssText =
          `position:fixed;left:${rect.right}px;top:${rect.top}px;` +
          `width:${window.innerWidth - rect.right}px;height:${rect.height}px;` +
          `background:rgba(15,23,42,0.45);pointer-events:none;`;
        // Bottom: from 0,rect.bottom to viewportWidth × viewportHeight-rect.bottom
        masks.bottom.style.cssText =
          `position:fixed;left:0;top:${rect.bottom}px;` +
          `width:100vw;height:${window.innerHeight - rect.bottom}px;` +
          `background:rgba(15,23,42,0.45);pointer-events:none;`;
      }

      function clearMasks() {
        Object.values(masks).forEach(m => m.style.cssText = '');
      }

      function onMove(e) {
        if (!dragging) return;
        endX = e.clientX;
        endY = e.clientY;
        const left = Math.min(startX, endX);
        const top = Math.min(startY, endY);
        const width = Math.abs(endX - startX);
        const height = Math.abs(endY - startY);
        const rect = { left, top, width, height, right: left + width, bottom: top + height };
        border.style.left = left + 'px';
        border.style.top = top + 'px';
        border.style.width = width + 'px';
        border.style.height = height + 'px';
        border.hidden = false;
        hint.textContent = `${Math.round(width)} × ${Math.round(height)} px`;
        hint.style.left = (left + width + 8) + 'px';
        hint.style.top = (top + height + 8) + 'px';
        hint.hidden = false;
        updateMasks(rect);
      }

      function onUp(e) {
        if (!dragging) return;
        dragging = false;
        const left = Math.min(startX, endX);
        const top = Math.min(startY, endY);
        const width = Math.abs(endX - startX);
        const height = Math.abs(endY - startY);
        cleanup();
        if (width < 5 || height < 5) {
          resolve(null); // treat as cancel
        } else {
          resolve({ left, top, width, height });
        }
      }

      function onKey(e) {
        if (e.key === 'Escape') {
          cleanup();
          resolve(null);
        }
      }

      function cleanup() {
        overlay.remove();
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
        document.removeEventListener('keydown', onKey, true);
      }

      overlay.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        endX = startX;
        endY = startY;
        // hide tip once drag starts
        const tip = overlay.querySelector('.recallfox-sel-tip');
        if (tip) tip.style.display = 'none';
        e.preventDefault();
      });

      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
      document.addEventListener('keydown', onKey, true);
    });
  }

  // ===== Background grabber (port-based) =====
  //
  // captureVisibleTab can only be called from the background. We use
  // browser.runtime.sendMessage to ask the background to capture the
  // current window and return the dataUrl.

  async function grabVisible(format, quality) {
    const res = await browser.runtime.sendMessage({
      type: 'CAPTURE_VISIBLE_TAB',
      format,
      quality
    });
    if (!res?.ok) throw new Error(res?.error || 'capture_failed');
    return res.dataUrl;
  }

  // Load an image from a dataUrl, return { img, width, height }
  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ img, width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = (e) => reject(new Error('image_load_failed'));
      img.src = dataUrl;
    });
  }

  // ===== Visible mode (single capture) =====
  async function captureVisible(format, quality) {
    const dataUrl = await grabVisible(format, quality);
    const { width, height } = await loadImage(dataUrl);
    return {
      dataUrl, width, height,
      bytes: dataUrl.length,
      selectionRect: null,
      cancelled: false
    };
  }

  // ===== Selection mode (overlay + crop) =====
  async function captureSelection(format, quality) {
    ensureStyles();
    showBanner('Seret untuk pilih area · Esc batal');
    const rect = await showSelectionOverlay();
    hideBanner();
    if (!rect) {
      return { dataUrl: null, cancelled: true, width: 0, height: 0, bytes: 0, selectionRect: null };
    }
    // capture visible tab, then crop on canvas
    const raw = await grabVisible(format, quality);
    const { img, width: iw, height: ih } = await loadImage(raw);
    // device pixel ratio: captureVisibleTab returns actual device pixels
    const dpr = iw / window.innerWidth;
    const sx = rect.left * dpr;
    const sy = rect.top * dpr;
    const sw = rect.width * dpr;
    const sh = rect.height * dpr;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(sw);
    canvas.height = Math.round(sh);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const out = canvas.toDataURL(`image/${format}`, quality / 100);
    return {
      dataUrl: out,
      width: canvas.width,
      height: canvas.height,
      bytes: out.length,
      selectionRect: rect,
      cancelled: false
    };
  }

  // ===== Entire page (scroll-stitch, ported from FireShot + hard caps) =====
  //
  // Standards (after studying FireShot + GoFullPage + browser built-in):
  //
  //   1. Hard cap: MAX_FRAMES = 30 (FireShot default)
  //   2. Dynamic page detection: kalau scrollHeight berubah > 3x berturut-turut
  //      setelah scroll → abort, suruh user pakai Seleksi Area/Visible
  //   3. Step: viewportH - 40px (FireShot sticky-header protection)
  //   4. Direct property assignment: scroller.scrollTop = N (bukan scrollTo)
  //   5. Force scroll-behavior: unset di <html> (disable smooth scroll)
  //   6. Hide body overflow (bukan scroller) — supaya scrollbar tidak muncul
  //   7. Per-frame wait 300ms (lazy image), post-capture wait 150ms (rate limit)
  //   8. Verify scroll berhasil — kalau stuck 2x → fallback window.scrollTo
  //      kalau masih stuck → abort

  const MAX_FRAMES = 30;
  const STICKY_PROTECTION = 40;
  const STABILITY_RETRIES = 3;  // kalau scrollHeight berubah 3x berturut-turut → abort
  const STABILITY_WAIT = 600;   // ms untuk nunggu stabilitas

  // Deteksi halaman dinamis (chat / SPA dengan virtual scroll)
  function detectDynamicPage() {
    // Known chat app domains
    const chatHosts = [
      'chat.z.ai', 'chatgpt.com', 'claude.ai', 'gemini.google.com',
      'chat.deepseek.com', 'tongyi.aliyun.com', 'chat.qwen.ai',
      'kimi.moonshot.cn', 'kimi.com', 'web.whatsapp.com', 'web.telegram.org',
      'discord.com', 'slack.com', 'teams.microsoft.com'
    ];
    try {
      const host = location.hostname;
      const matched = chatHosts.find(h => host === h || host.endsWith('.' + h));
      if (matched) {
        return {
          dynamic: true,
          reason: 'chat_app',
          message: `Halaman ini (${matched}) adalah aplikasi chat dengan lazy-render. Pesan lama tidak ada di DOM sampai di-scroll. Full-page capture bisa gagal atau menghasilkan screenshot tidak lengkap.`
        };
      }
    } catch (e) {}

    // Heuristic: cek apakah scrollHeight berubah dengan cepat
    // (akan di-test lebih lanjut di loop capture)
    return { dynamic: false };
  }

  async function captureEntire(format, quality, maxHeight) {
    ensureStyles();
    const banner = showBanner('Menangkap halaman penuh… 0%');

    // === Pre-check: deteksi halaman dinamis ===
    const dynCheck = detectDynamicPage();
    if (dynCheck.dynamic) {
      hideBanner();
      console.warn('[RecallFox] Dynamic page detected:', dynCheck.message);
      return {
        dataUrl: null,
        cancelled: false,
        error: 'dynamic_page',
        dynamicReason: dynCheck.reason,
        dynamicMessage: dynCheck.message
      };
    }

    // === Step 1: find the real scrolling element ===
    function findRealScroller() {
      const docScroller = document.scrollingElement || document.body || document.documentElement;
      const viewportH = window.innerHeight;
      if (docScroller && docScroller.scrollHeight > viewportH + 50) {
        console.log('[RecallFox] Using document scroller:', docScroller.tagName,
                    'scrollHeight=' + docScroller.scrollHeight,
                    'clientHeight=' + docScroller.clientHeight);
        return docScroller;
      }

      console.log('[RecallFox] Document scroller has no overflow (scrollHeight=' +
                  (docScroller ? docScroller.scrollHeight : 'null') +
                  ', viewport=' + viewportH + '), scanning for nested scroller…');

      const all = document.querySelectorAll('div, main, section, article, [role="main"]');
      let best = null;
      let bestArea = 0;
      for (const el of all) {
        if (el.clientHeight < 200 || el.clientWidth < 200) continue;
        const style = getComputedStyle(el);
        const ov = style.overflowY;
        if (ov !== 'auto' && ov !== 'scroll') continue;
        if (el.scrollHeight <= el.clientHeight + 50) continue;
        const area = el.clientWidth * el.clientHeight;
        if (area > bestArea) {
          bestArea = area;
          best = el;
        }
      }

      if (best) {
        console.log('[RecallFox] Found nested scroller:', best.tagName +
                    (best.id ? '#' + best.id : '') +
                    (best.className ? '.' + (typeof best.className === 'string' ? best.className.split(/\s+/)[0] : '') : ''),
                    'scrollHeight=' + best.scrollHeight,
                    'clientHeight=' + best.clientHeight);
        return best;
      }

      console.log('[RecallFox] No nested scroller found, using document scroller');
      return docScroller;
    }

    const scroller = findRealScroller();
    if (!scroller) {
      throw new Error('No scrolling element found');
    }

    // === Step 2: read initial total dimensions ===
    let totalHeight = Math.max(
      scroller.scrollHeight,
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    );
    if (totalHeight > maxHeight) totalHeight = maxHeight;

    const totalWidth = scroller.scrollWidth || document.documentElement.scrollWidth || window.innerWidth;
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;

    console.log('[RecallFox] captureEntire START', {
      scroller: scroller.tagName + (scroller.id ? '#' + scroller.id : ''),
      total: totalWidth + 'x' + totalHeight,
      viewport: viewportW + 'x' + viewportH,
      maxFrames: MAX_FRAMES,
      url: location.href.slice(0, 80)
    });

    // === Step 3: save original state ===
    const origScrollTop = scroller.scrollTop;
    const origScrollLeft = scroller.scrollLeft;
    const origBodyOverflowX = document.body ? document.body.style.overflowX : '';
    const origBodyOverflowY = document.body ? document.body.style.overflowY : '';
    const origHtmlScrollBehavior = document.documentElement.style.scrollBehavior;

    // === Step 4: prep (FireShot-style) ===
    if (document.body) {
      document.body.style.overflowX = 'hidden';
      document.body.style.overflowY = 'hidden';
    }
    document.documentElement.style.scrollBehavior = 'unset';

    const chunks = [];
    try {
      // === Step 5: jump to top ===
      scroller.scrollTop = 0;
      scroller.scrollLeft = 0;
      await sleep(400);

      // === Step 6: capture loop ===
      const stepH = Math.max(100, viewportH - STICKY_PROTECTION);
      let frameIdx = 0;
      let noProgressCount = 0;
      let instabilityCount = 0;
      let lastTotalHeight = totalHeight;

      while (true) {
        // === Hard cap: MAX_FRAMES ===
        if (frameIdx >= MAX_FRAMES) {
          console.warn('[RecallFox] Reached MAX_FRAMES (' + MAX_FRAMES + '), stopping.');
          banner.textContent = `Cap ${MAX_FRAMES} frame tercapai — menyimpan…`;
          break;
        }

        const pct = Math.round((scroller.scrollTop / totalHeight) * 100);
        banner.textContent = `Menangkap frame ${frameIdx + 1}/${MAX_FRAMES}… (${Math.min(100, pct)}%)`;

        // === Stability check: cek apakah scrollHeight berubah ===
        // (deteksi lazy-render / virtual scroll / chat apps)
        const beforeStabCheck = scroller.scrollHeight;
        await sleep(STABILITY_WAIT);
        const afterStabCheck = scroller.scrollHeight;
        if (Math.abs(afterStabCheck - beforeStabCheck) > 100) {
          instabilityCount++;
          console.warn('[RecallFox] scrollHeight unstable: ' + beforeStabCheck +
                       ' → ' + afterStabCheck + ' (instability=' + instabilityCount + ')');
          if (instabilityCount >= STABILITY_RETRIES) {
            console.warn('[RecallFox] Page is too dynamic, aborting full-page capture');
            hideBanner();
            return {
              dataUrl: null,
              cancelled: false,
              error: 'dynamic_page',
              dynamicReason: 'unstable_scrollHeight',
              dynamicMessage: 'Halaman ini terlalu dinamis (konten dimuat saat scroll — kemungkinan aplikasi chat atau infinite scroll). Full-page capture tidak bisa diandalkan. Coba pakai mode Seleksi Area atau Bagian Terlihat.'
            };
          }
          // Update totalHeight kalau naik (jangan turunkan — mungkin ada collapse)
          if (afterStabCheck > totalHeight && afterStabCheck <= maxHeight) {
            totalHeight = afterStabCheck;
            console.log('[RecallFox] Updated totalHeight → ' + totalHeight);
          }
          // Wait again
          await sleep(300);
        } else {
          instabilityCount = 0;
        }

        // Wait for layout/paint to settle
        await sleep(300);

        // === Capture current viewport via background ===
        const dataUrl = await grabVisible(format, quality);
        await sleep(150);  // Firefox rate-limit safety

        const { img, width, height } = await loadImage(dataUrl);
        chunks.push({
          img,
          width,
          height,
          scrollY: scroller.scrollTop
        });

        console.log('[RecallFox] Frame ' + frameIdx +
                    ': scrollTop=' + scroller.scrollTop +
                    ' imgSize=' + width + 'x' + height +
                    ' totalHeight=' + totalHeight);

        frameIdx++;

        // === Check if we've reached the bottom ===
        if (scroller.scrollTop + viewportH >= totalHeight - 5) {
          console.log('[RecallFox] Reached bottom (scrollTop=' + scroller.scrollTop +
                      ', total=' + totalHeight + ')');
          break;
        }

        // === Try to scroll down by stepH ===
        const before = scroller.scrollTop;
        scroller.scrollTop = before + stepH;
        await sleep(50);

        if (scroller.scrollTop === before) {
          noProgressCount++;
          console.warn('[RecallFox] Scroll stuck at ' + before +
                       ' (noProgress=' + noProgressCount + ')');
          if (noProgressCount >= 2) {
            console.warn('[RecallFox] Aborting: scroll not progressing');
            break;
          }
          window.scrollTo(0, before + stepH);
          await sleep(200);
          if (scroller.scrollTop === before) {
            console.warn('[RecallFox] window.scrollTo fallback also failed');
            break;
          }
        } else {
          noProgressCount = 0;
        }
      }

      if (chunks.length === 0) {
        throw new Error('No frames captured');
      }

      console.log('[RecallFox] Captured ' + chunks.length + ' frames, stitching…');
      banner.textContent = `Menjahit ${chunks.length} frame…`;

      // === Step 7: stitch frames ===
      const stitchW = chunks[0].width;
      let stitchH = 0;
      const drawSpecs = chunks.map((c, i) => {
        let srcY = 0;
        let drawH = c.height;
        if (i === chunks.length - 1) {
          const visibleContentH = Math.max(50, totalHeight - c.scrollY);
          const dpr = c.width / viewportW;
          drawH = Math.min(c.height, Math.round(visibleContentH * dpr));
        }
        stitchH += drawH;
        return { srcY, drawH };
      });

      console.log('[RecallFox] Stitching ' + chunks.length + ' frames → ' +
                  stitchW + 'x' + stitchH);

      const canvas = document.createElement('canvas');
      canvas.width = stitchW;
      canvas.height = stitchH;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, stitchW, stitchH);

      let drawnY = 0;
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        const spec = drawSpecs[i];
        ctx.drawImage(c.img, 0, spec.srcY, c.width, spec.drawH,
                      0, drawnY, c.width, spec.drawH);
        drawnY += spec.drawH;
      }

      const out = canvas.toDataURL(`image/${format}`, quality / 100);
      console.log('[RecallFox] Final image: ' + stitchW + 'x' + stitchH +
                  ', ' + Math.round(out.length / 1024) + ' KB');

      return {
        dataUrl: out,
        width: canvas.width,
        height: canvas.height,
        bytes: out.length,
        selectionRect: null,
        cancelled: false,
        frameCount: chunks.length
      };
    } finally {
      try {
        if (document.body) {
          document.body.style.overflowX = origBodyOverflowX;
          document.body.style.overflowY = origBodyOverflowY;
        }
        document.documentElement.style.scrollBehavior = origHtmlScrollBehavior;
        scroller.scrollTop = origScrollTop;
        scroller.scrollLeft = origScrollLeft;
      } catch (e) {
        console.warn('[RecallFox] Restore failed:', e.message);
      }
      hideBanner();
    }
  }

  // ===== Main entry =====
  window.__RecallFoxCapture__ = async function (mode, opts = {}) {
    const format = opts.format === 'jpeg' ? 'jpeg' : 'png';
    const quality = typeof opts.quality === 'number' ? opts.quality : 90;
    const maxHeight = opts.maxHeight || 16384;

    try {
      if (mode === 'visible') {
        return await captureVisible(format, quality);
      } else if (mode === 'selection') {
        return await captureSelection(format, quality);
      } else if (mode === 'entire') {
        return await captureEntire(format, quality, maxHeight);
      } else {
        return { dataUrl: null, cancelled: true, error: 'unknown_mode: ' + mode };
      }
    } catch (e) {
      hideBanner();
      return { dataUrl: null, cancelled: false, error: e.message };
    }
  };

  console.log('[RecallFox] capture.js loaded — modes: visible, entire, selection');

  // ===== Lightweight toast (independent of content/content.js) =====
  // Used when capture.js is injected on non-AI pages where the main
  // content script isn't loaded. Shows a brief confirmation pill at
  // the bottom-right corner.
  function showCaptureToast(messageKey, isError = false) {
    const msg = browser.i18n?.getMessage?.(messageKey) || messageKey;
    let toast = document.getElementById('recallfox-capture-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'recallfox-capture-toast';
      toast.className = 'recallfox-capture-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = (isError ? '⚠ ' : '✓ ') + msg;
    toast.style.background = isError
      ? 'linear-gradient(135deg, #b91c1c 0%, #7f1d1d 100%)'
      : 'linear-gradient(135deg, #1c1917 0%, #292524 100%)';
    toast.classList.add('show');
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => toast.classList.remove('show'), 3200);
  }

  // Expose so background-triggered SHOW_TOAST can reach this even without
  // the main content script loaded. The background sends SHOW_TOAST, the
  // main content script handles it on AI domains; on non-AI pages, this
  // listener catches it.
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'SHOW_TOAST') {
      // If the main content script (content/content.js) is loaded, defer to it
      // — its toast styling is richer. We only show our fallback toast on
      // pages where content.js is NOT loaded (non-AI domains).
      if (window.__RecallFoxContentLoaded__) {
        sendResponse({ ok: true, deferred: true });
        return;
      }
      const isError = msg.message && (msg.message.startsWith('err') || msg.message.startsWith('screenshotErr'));
      showCaptureToast(msg.message || 'screenshotSavedToast', isError);
      sendResponse({ ok: true });
    }
  });
})();
