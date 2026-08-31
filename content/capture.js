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
    // v3.11.9 (Issue #1 fix): HAPUS showBanner — showSelectionOverlay sudah punya
    // tip sendiri (recallfox-sel-tip "Drag untuk pilih area · Esc untuk batal")
    // di tengah layar. Sebelumnya showBanner + sel-tip bertumpuk → user bingung.
    const rect = await showSelectionOverlay();
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

  // ===== Entire page (scroll-stitch, REWRITE v3.24.4) =====
  //
  // Standar baru (laporan user: "capture patah-patah mengulang-ulang halaman
  // pertama"). Tiga akar bug versi lama yang dibunuh di sini:
  //
  //   AKAR #1 — DUPLIKASI 40px DI TIAP SAMBUNGAN: scroll sengaja tumpang-
  //      tindih 40px (STICKY_PROTECTION ala FireShot), tapi stitch lama
  //      MENUMPUK frame PENUH tanpa membuang 40px pengulangan di puncak
  //      frame berikutnya → hasil "patah-patah" + potongan halaman berulang
  //      di tiap sambungan. Sekarang: tiap frame menggambar HANYA baris
  //      konten yang BELUM tercakup frame sebelumnya (bookkeeping `covered`).
  //
  //   AKAR #2 — SMOOTH SCROLL: penugasan `scroller.scrollTop = N` TETAP
  //      dianimasikan kalau halaman memasang CSS scroll-behavior:smooth,
  //      dan style lama hanya di-unset di <html> (bukan di nested scroller)
  //      → frame tercapture di posisi lama = "mengulang halaman pertama".
  //      Sekarang: scroll-behavior:'auto' dipasang di <html> DAN scroller,
  //      plus scrollToY() menunggu scroll BENAR-BENAR tuntas (polling)
  //      sebelum frame diambil.
  //
  //   AKAR #3 — overflow:hidden pada <body> + metrik keliru utk nested
  //      scroller: body overflow bisa mematikan scroll dokumen (propagasi
  //      overflow viewport), dan bottom-check pakai window.innerHeight +
  //      tinggi dokumen walau yang digulung elemen dalam → loop menumpuk
  //      frame identik di posisi maxScroll. Sekarang: scrollbar disembunyi-
  //      kan via <style> (tanpa menyentuh overflow), visH/pageH dihitung
  //      sesuai jenis scroller, dan frame yang tidak membawa konten baru
  //      dibuang + loop berhenti mulus.
  //
  // Bonus kecepatan: check stabilitas 600ms+300ms per frame dihapus — pace
  // per frame kini ~120-350ms sehingga proses capture terasa mulus.

  const MAX_FRAMES = 30;
  const STICKY_PROTECTION = 40;

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

    // === Metrik sesuai jenis scroller (AKAR #3) ===
    // Doc scroller: area terlihat = window.innerHeight, tinggi halaman =
    // max(scrollHeight semua kandidat). Nested scroller: area terlihat =
    // clientHeight elemen, tinggi halaman = scrollHeight elemen itu sendiri
    // (JANGAN campur dengan tinggi dokumen — dulu bikin loop menumpuk frame
    // identik di dasar nested scroller).
    const isDocScroller = (scroller === document.scrollingElement) ||
                          scroller === document.documentElement ||
                          scroller === document.body;
    const visH = () => isDocScroller
      ? window.innerHeight
      : Math.max(120, (scroller.clientHeight || window.innerHeight));
    const pageH = () => {
      let h = scroller.scrollHeight;
      if (isDocScroller) {
        h = Math.max(h,
          document.documentElement.scrollHeight,
          document.body ? document.body.scrollHeight : 0);
      }
      return Math.min(h, maxHeight);
    };

    const viewportW = window.innerWidth || 1024;

    // === Step 2: save original state ===
    const origScrollTop = scroller.scrollTop;
    const origScrollLeft = scroller.scrollLeft;
    const origHtmlScrollBehavior = document.documentElement.style.scrollBehavior;
    let origScrollerScrollBehavior = null;
    try { origScrollerScrollBehavior = scroller.style.scrollBehavior; } catch (e) {}

    // === Step 3: prep (v3.24.4) ===
    // AKAR #2: matikan smooth-scroll di <html> DAN di scroller — penugasan
    // scrollTop pun ikut animasi bila CSS scroll-behavior:smooth aktif.
    document.documentElement.style.scrollBehavior = 'auto';
    try { scroller.style.scrollBehavior = 'auto'; } catch (e) {}
    // AKAR #3: scrollbar disembunyikan via <style>, TANPA overflow:hidden di
    // body (propagasi overflow ke viewport bisa mematikan scroll dokumen).
    let barStyle = document.getElementById('recallfox-capture-noscrollbar');
    if (!barStyle) {
      barStyle = document.createElement('style');
      barStyle.id = 'recallfox-capture-noscrollbar';
      barStyle.textContent =
        '*{scrollbar-width:none!important}' +
        '*::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}';
      document.head.appendChild(barStyle);
    }

    // Tunggu scroll benar-benar sampai target (anti smooth-scroll & anti
    // scroll-jack): poll sampai posisi stabil di target / sampai berhenti
    // sendiri (mentok maxScroll) / timeout lunas. Selalu balikkan POSISI
    // AKTUAL — frame dihitung dari posisi nyata, bukan yang diminta.
    async function scrollToY(target) {
      try { scroller.scrollTop = target; } catch (e) {}
      const t0 = Date.now();
      let prev = -1, same = 0;
      while (Date.now() - t0 < 900) {
        await sleep(60);
        const cur = scroller.scrollTop;
        if (Math.abs(cur - target) <= 1) return cur;      // sampai & stabil
        if (cur === prev) { same++; if (same >= 3) return cur; } // mentok
        else same = 0;
        prev = cur;
      }
      return scroller.scrollTop;
    }

    const chunks = [];
    try {
      // === Step 4: jump to top + beri waktu layout/lazy-image settle ===
      await scrollToY(0);
      await sleep(350);

      // === Step 5: capture loop ===
      // `covered` = baris konten (css px) yang sudah tergambar di kanvas:
      // kanvas memegang [0, covered). Tiap frame menggambar HANYA baris
      // baru — dulu semua frame ditumpuk penuh → duplikat 40px per sambungan
      // (AKAR #1).
      let covered = 0;
      let frameIdx = 0;
      let targetY = 0;

      while (frameIdx < MAX_FRAMES) {
        const actualY = (frameIdx === 0) ? scroller.scrollTop : await scrollToY(targetY);
        const pH = pageH();
        const vH = visH();

        // Halaman sudah tuntas sebelum frame ini? selesai.
        if (covered >= pH - 2) break;

        if (frameIdx === 0) await sleep(300);   // lazy-image settle frame pertama
        else await sleep(90);                   // settle paint antar frame

        const pct = Math.round((covered / Math.max(1, pH)) * 100);
        banner.textContent = `Menangkap frame ${frameIdx + 1}/${MAX_FRAMES}… (${Math.min(100, pct)}%)`;

        // === Capture posisi AKTUAL via background ===
        const dataUrl = await grabVisible(format, quality);
        await sleep(120);  // Firefox rate-limit safety

        const { img, width, height } = await loadImage(dataUrl);

        // === Hitung kontribusi BARIS BARU frame ini (AKAR #1) ===
        // skip = bagian puncak frame yang sudah tercakup frame sebelumnya
        // (termasuk pita 40px anti-sticky). scroll kurung (smooth belum
        // selesai) → skip membesar sendiri, tetap tanpa gap & tanpa duplikat.
        const skipCss = frameIdx === 0 ? 0 : Math.max(0, covered - actualY);
        let newHCss = Math.max(0, vH - skipCss);
        if (actualY + skipCss + newHCss > pH) {
          newHCss = Math.max(0, pH - (actualY + skipCss));
        }
        if (newHCss <= 0) {
          // Tidak membawa konten baru (scroll mentok / halaman lebih pendek
          // dari perkiraan) — buang frame, selesai tanpa duplikat.
          console.log('[RecallFox] Frame ' + frameIdx + ' tanpa konten baru — berhenti mulus');
          break;
        }

        chunks.push({ img, width, height, srcYCss: skipCss, drawHCss: newHCss });
        covered = actualY + skipCss + newHCss;
        frameIdx++;

        console.log('[RecallFox] Frame ' + frameIdx +
                    ': scrollTop=' + actualY +
                    ' skip=' + skipCss +
                    ' newH=' + newHCss +
                    ' covered=' + covered + '/' + pH +
                    ' imgSize=' + width + 'x' + height);

        // === Sudah sampai dasar halaman? ===
        if (actualY + vH >= pH - 2) {
          console.log('[RecallFox] Reached bottom (scrollTop=' + actualY + ', total=' + pH + ')');
          break;
        }

        // === Scroll ke posisi frame berikutnya (overlap 40px anti-sticky) ===
        targetY = actualY + Math.max(100, vH - STICKY_PROTECTION);
        const reached = await scrollToY(targetY);
        if (reached <= actualY + 4) {
          // Mentok: coba fallback sesuai jenis scroller, sekali saja.
          console.warn('[RecallFox] Scroll stuck di ' + reached + ', fallback…');
          if (isDocScroller) {
            try { window.scrollTo(0, targetY); } catch (e) {}
          } else {
            try { scroller.scrollBy(0, targetY - reached); } catch (e) {}
          }
          await sleep(180);
          const r2 = await scrollToY(targetY);
          if (r2 <= actualY + 4) {
            console.warn('[RecallFox] Scroll tetap tidak maju — berhenti dengan frame yang sudah ada');
            break;
          }
        }
      }

      if (chunks.length === 0) {
        throw new Error('No frames captured');
      }

      console.log('[RecallFox] Captured ' + chunks.length + ' frames, stitching…');
      banner.textContent = `Menjahit ${chunks.length} frame…`;

      // === Step 6: stitch — tiap frame hanya baris barunya (AKAR #1) ===
      const stitchW = chunks[0].width;
      let stitchH = 0;
      const drawSpecs = chunks.map((c) => {
        const cdpr = viewportW > 0 ? (c.width / viewportW) : 1;
        const srcY = Math.max(0, Math.min(c.height - 1, Math.round(c.srcYCss * cdpr)));
        let drawH = Math.round(c.drawHCss * cdpr);
        drawH = Math.max(1, Math.min(drawH, c.height - srcY));
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
        document.documentElement.style.scrollBehavior = origHtmlScrollBehavior;
        if (origScrollerScrollBehavior !== null) {
          try { scroller.style.scrollBehavior = origScrollerScrollBehavior; } catch (e) {}
        }
        try { scroller.scrollTop = origScrollTop; } catch (e) {}
        try { scroller.scrollLeft = origScrollLeft; } catch (e) {}
        try { const bs = document.getElementById('recallfox-capture-noscrollbar'); if (bs) bs.remove(); } catch (e) {}
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

    // v3.20.5: Hide RecallFox floating elements during screenshot capture
    // v3.20.14: Use display:none (bukan visibility:hidden) — visibility:hidden
    //   masih tercapture di Firefox captureVisibleTab. display:none remove dari render tree.
    const HIDE_SELECTORS = ['#recallfox-notes-host', '#recallfox-tape-host', '#recallfox-ai-popup', '#recallfox-sidebar-host', '#recallfox-sidebar-floater', '#recallfox-sidebar-floater-pair', '#recallfox-popout-pin', '#recallfox-fab', '.recallfox-dock'];
    const hiddenEls = [];
    for (const sel of HIDE_SELECTORS) {
      document.querySelectorAll(sel).forEach(el => {
        hiddenEls.push({ el, prev: el.style.display });
        el.style.display = 'none';
      });
    }
    if (hiddenEls.length > 0) await new Promise(r => setTimeout(r, 100));

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
      // v3.11.7-fix2 (Sesi 7): Kalau capture gagal dengan JPEG, coba ulang dengan PNG lossless.
      // User report: "gambar hanya bisa ditangkap di lossless, jika dengan kompresi error".
      // Root cause: canvas.toDataURL('image/jpeg', q) bisa melempar error di canvas yang tainted
      // (cross-origin image tanpa CORS) atau browser yang tidak support JPEG encoding.
      if (format === 'jpeg' && !String(e.message || '').includes('cancelled')) {
        console.warn('[RecallFox] Capture JPEG gagal (' + e.message + '), coba PNG lossless...');
        try {
          if (mode === 'visible') return await captureVisible('png', 100);
          else if (mode === 'selection') return await captureSelection('png', 100);
          else if (mode === 'entire') return await captureEntire('png', 100, maxHeight);
        } catch (e2) {
          console.error('[RecallFox] PNG fallback juga gagal:', e2.message);
          return { dataUrl: null, cancelled: false, error: 'JPEG: ' + e.message + ' | PNG: ' + e2.message };
        }
      }
      return { dataUrl: null, cancelled: false, error: e.message };
    } finally {
      // v3.20.14: DO NOT restore here — let sidebar-cs.js handle restore via
      // RF_RESTORE_AFTER_CAPTURE (sent by background after captureFullPage returns).
      // Sebelumnya: finally restore langsung → untuk selection mode, popout muncul
      // kembali saat user masih menggambar area → mengganggu.
      // Sekarang: background.js always sends RF_RESTORE_AFTER_CAPTURE after
      // captureFullPage returns (success OR cancel OR error).
      // capture.js's own hide is also restored by background's restore broadcast
      // (sidebar-cs.js receives RF_RESTORE_AFTER_CAPTURE → restore display).
      // BUT: capture.js elements might NOT be the same as sidebar-cs.js elements
      // (capture.js hides via HIDE_SELECTORS, sidebar-cs.js hides via its own state).
      // So we still need to restore capture.js's hides here — BUT only for elements
      // that sidebar-cs.js doesn't manage (like .recallfox-dock, #recallfox-fab).
      // Actually: sidebar-cs.js manages #recallfox-sidebar-host + #recallfox-sidebar-floater-pair.
      // capture.js hides those PLUS #recallfox-fab + .recallfox-dock (managed by overlay.js).
      // So: restore ALL here (it's safe — sidebar-cs.js will also restore via RF_RESTORE).
      hiddenEls.forEach(({ el, prev }) => { el.style.display = prev; });
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
