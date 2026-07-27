// content/overlay.js — Floating screenshot FAB + capture modal
// RecallFox v3.2.0 — task-based, industry-standard screenshot UX
//
// Loaded on every http(s) page via manifest.json content_scripts.
// Responsibilities:
//   1. Inject a draggable purple FAB (floating action button) on the right side
//   2. Click FAB → show mode picker dialog (Bagian terlihat / Seleksi area / Seluruh halaman)
//   3. Drag FAB → reposition; position persisted per-device via localStorage
//   4. After capture → modal with preview + Save PDF/JPG/PNG/Copy/Vault
//
// Design language: purple gradient (#6d3df5 → #8a54ff), white cards, soft shadows.
// Inspired by Linear / Notion / Vercel modal patterns.

(function () {
  if (window.__RecallFoxOverlayLoaded__) return;
  window.__RecallFoxOverlayLoaded__ = true;

  // Don't run inside iframes (we only want the overlay on the top page)
  if (window !== window.top) return;

  // Don't run on about: / moz-extension: pages
  if (!/^https?:/.test(location.protocol)) return;

  // ===== Stylesheet =====
  function ensureStyles() {
    if (document.getElementById('recallfox-overlay-style')) return;
    const link = document.createElement('link');
    link.id = 'recallfox-overlay-style';
    link.rel = 'stylesheet';
    link.href = browser.runtime.getURL('content/overlay.css');
    document.head.appendChild(link);
  }

  // ===== State =====
  let dockEl = null;       // The dock container (FAB + hint label)
  let fabBtn = null;       // The actual round purple button
  let miniInfoEl = null;   // The small info card with reset button
  let modalEl = null;      // Any active modal (picker / preview / error)
  let lastCapture = null;  // { dataUrl, width, height, bytes, mode }
  let dragState = null;    // Drag tracking state

  // Position storage key (per-device, per-domain)
  const POS_KEY = 'recallfox_fab_pos';

  // ===== Helpers =====
  function getSetting(key, defaultVal) {
    return browser.runtime.sendMessage({ type: 'GET_VAULT' }).then(vault => {
      return vault?.settings?.[key] ?? defaultVal;
    }).catch(() => defaultVal);
  }

  function fmtBytes(b) {
    if (!b && b !== 0) return '';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(2) + ' MB';
  }

  // v3.11.4: Inject content/annotate.js on-demand.
  // annotate.js is too heavy to load on every page; we only inject when user
  // clicks "Anotasi" in the preview modal.
  async function _injectAnnotateScript() {
    if (typeof window.__RecallFoxAnnotate__ === 'function') return;
    try {
      await browser.runtime.sendMessage({ type: 'INJECT_ANNOTATE_SCRIPT' });
      // Wait for global to be available (max 5s)
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && typeof window.__RecallFoxAnnotate__ !== 'function') {
        await new Promise(r => setTimeout(r, 50));
      }
      if (typeof window.__RecallFoxAnnotate__ !== 'function') {
        throw new Error('annotate.js failed to load');
      }
    } catch (e) {
      console.warn('[RecallFox/Overlay] Failed to inject annotate.js:', e);
      throw e;
    }
  }

  function loadPos() {
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (typeof p.left === 'number' && typeof p.top === 'number') return p;
      return null;
    } catch (e) { return null; }
  }

  function savePos(left, top) {
    try {
      // Clamp to viewport so position survives window resize
      const w = dockEl?.offsetWidth || 60;
      const h = dockEl?.offsetHeight || 60;
      const clampedLeft = Math.max(8, Math.min(window.innerWidth - w - 8, left));
      const clampedTop = Math.max(8, Math.min(window.innerHeight - h - 8, top));
      localStorage.setItem(POS_KEY, JSON.stringify({ left: clampedLeft, top: clampedTop }));
    } catch (e) {}
  }

  function resetPos() {
    try { localStorage.removeItem(POS_KEY); } catch (e) {}
    if (dockEl) dockEl.removeAttribute('style');
    showCaptureToast('Posisi tombol dikembalikan ke kanan atas');
  }

  // ===== Floating dock (FAB + hint label) =====
  async function maybeInjectOverlay() {
    const enabled = await getSetting('overlayButtonEnabled', true);
    if (!enabled) {
      if (dockEl) { dockEl.remove(); dockEl = null; fabBtn = null; miniInfoEl = null; }
      return;
    }
    if (dockEl) return; // already injected
    ensureStyles();

    // Build the dock container (FAB + hint label above)
    dockEl = document.createElement('div');
    dockEl.id = 'recallfox-dock';
    dockEl.className = 'recallfox-dock';

    // Hint label above FAB
    const hint = document.createElement('div');
    hint.className = 'recallfox-dock-hint';
    hint.innerHTML = 'Screenshot <b>·</b> seret untuk pindah';

    // FAB button (purple gradient, rounded square)
    fabBtn = document.createElement('button');
    fabBtn.id = 'recallfox-fab';
    fabBtn.className = 'recallfox-fab';
    fabBtn.type = 'button';
    fabBtn.title = 'Ambil screenshot (Alt+Shift+5)';
    fabBtn.setAttribute('aria-label', 'Ambil screenshot');
    fabBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 7h3l1.5-2h7L17 7h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z"/>
        <circle cx="12" cy="13" r="3.2"/>
      </svg>
    `;

    dockEl.appendChild(hint);
    dockEl.appendChild(fabBtn);
    document.body.appendChild(dockEl);

    // Restore saved position (per-device)
    const savedPos = loadPos();
    if (savedPos) {
      dockEl.style.right = 'auto';
      dockEl.style.top = savedPos.top + 'px';
      dockEl.style.left = savedPos.left + 'px';
    }

    // === Click handler: distinguish click vs drag ===
    // Click = open mode picker; Drag = reposition FAB.
    fabBtn.addEventListener('click', (e) => {
      if (dragState && dragState.moved) {
        // Was a drag, not a click — suppress
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      triggerCapture();
    });

    // === Drag with setPointerCapture (industry-standard) ===
    // Pointer capture ensures we keep getting pointermove events even if the
    // cursor leaves the button. Much more reliable than window.addEventListener.
    fabBtn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const rect = dockEl.getBoundingClientRect();
      dragState = {
        startX: e.clientX,
        startY: e.clientY,
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
        moved: false,
        pointerId: e.pointerId
      };
      // Capture pointer so move events keep flowing to this element
      try { fabBtn.setPointerCapture(e.pointerId); } catch (err) {}
    });

    fabBtn.addEventListener('pointermove', (e) => {
      if (!dragState) return;
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 5) {
        dragState.moved = true;
        dockEl.classList.add('recallfox-dock-dragging');
        dockEl.style.right = 'auto';
        // Clamp to viewport so FAB doesn't go offscreen
        const w = dockEl.offsetWidth;
        const h = dockEl.offsetHeight;
        const left = Math.max(8, Math.min(window.innerWidth - w - 8, e.clientX - dragState.offsetX));
        const top = Math.max(8, Math.min(window.innerHeight - h - 8, e.clientY - dragState.offsetY));
        dockEl.style.left = left + 'px';
        dockEl.style.top = top + 'px';
      }
    });

    fabBtn.addEventListener('pointerup', (e) => {
      if (!dragState) return;
      try { fabBtn.releasePointerCapture(dragState.pointerId); } catch (err) {}
      dockEl.classList.remove('recallfox-dock-dragging');
      if (dragState.moved) {
        // Persist new position
        const rect = dockEl.getBoundingClientRect();
        savePos(rect.left, rect.top);
        // Show confirmation toast briefly
        showCaptureToast('Posisi tombol disimpan');
      }
      // Reset after a tick so click handler can see dragState.moved
      setTimeout(() => { dragState = null; }, 10);
    });

    fabBtn.addEventListener('pointercancel', () => {
      if (dragState) {
        try { fabBtn.releasePointerCapture(dragState.pointerId); } catch (err) {}
        dockEl.classList.remove('recallfox-dock-dragging');
        dragState = null;
      }
    });

    // === Right-click context menu ===
    // Right-click on FAB → show mini info popup with reset option
    fabBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showMiniInfo();
    });

    // Long-press (700ms) → show mini info popup with reset option
    let pressTimer = null;
    fabBtn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      pressTimer = setTimeout(() => {
        showMiniInfo();
      }, 700);
    });
    fabBtn.addEventListener('pointerup', () => { if (pressTimer) clearTimeout(pressTimer); });
    fabBtn.addEventListener('pointerleave', () => { if (pressTimer) clearTimeout(pressTimer); });
    fabBtn.addEventListener('pointercancel', () => { if (pressTimer) clearTimeout(pressTimer); });

    // Pulse on inject
    fabBtn.classList.add('recallfox-fab-pulse');
    setTimeout(() => fabBtn.classList.remove('recallfox-fab-pulse'), 1500);
  }

  // ===== Mini info popup (shows reset button) =====
  function showMiniInfo() {
    // Remove existing
    if (miniInfoEl) { miniInfoEl.remove(); miniInfoEl = null; }
    ensureStyles();

    miniInfoEl = document.createElement('div');
    miniInfoEl.className = 'recallfox-mini-info';
    miniInfoEl.innerHTML = `
      <b>Posisi tombol</b>
      Tekan-tahan lalu seret tombol kamera ke lokasi yang nyaman. Posisi disimpan per perangkat.
      <button class="recallfox-mini-reset" id="recallfox-mini-reset">↺ Kembalikan ke kanan atas</button>
    `;

    // Position next to dock
    if (dockEl) {
      const rect = dockEl.getBoundingClientRect();
      // Place to the left of dock (or below if no room)
      const miniW = 220;
      let left = rect.left - miniW - 10;
      let top = rect.top;
      if (left < 10) {
        // Not enough room on left — place below
        left = rect.left;
        top = rect.bottom + 10;
      }
      miniInfoEl.style.left = left + 'px';
      miniInfoEl.style.top = top + 'px';
    }
    document.body.appendChild(miniInfoEl);

    // Bind reset
    miniInfoEl.querySelector('#recallfox-mini-reset').addEventListener('click', () => {
      resetPos();
      miniInfoEl.remove();
      miniInfoEl = null;
    });

    // Auto-dismiss on outside click or Escape
    const dismiss = (e) => {
      if (miniInfoEl && (e.type === 'click' && miniInfoEl.contains(e.target))) return;
      if (miniInfoEl) { miniInfoEl.remove(); miniInfoEl = null; }
      document.removeEventListener('click', dismiss, true);
      document.removeEventListener('keydown', escDismiss, true);
    };
    const escDismiss = (e) => { if (e.key === 'Escape') dismiss(e); };
    setTimeout(() => {
      document.addEventListener('click', dismiss, true);
      document.addEventListener('keydown', escDismiss, true);
    }, 50);

    // Auto-hide after 8 seconds
    setTimeout(() => {
      if (miniInfoEl) { miniInfoEl.remove(); miniInfoEl = null; }
    }, 8000);
  }

  // ===== Capture flow =====
  async function triggerCapture(forceMode) {
    // If no mode forced, show the mode-picker dialog first
    let mode = forceMode;
    if (!mode || typeof mode !== 'string') {
      mode = await showModePicker();
      if (!mode) return; // User cancelled the picker
    }

    // Visual feedback on the FAB
    if (fabBtn) {
      fabBtn.classList.add('recallfox-fab-busy');
      fabBtn.innerHTML = '<span class="recallfox-fab-spinner"></span>';
    }

    // For selection mode, show a different hint
    if (mode === 'selection') {
      showCaptureToast('Seret kotak di area yang ingin di-capture · Esc batal', false, 4000);
    }

    // Tell background to do the capture
    let res;
    try {
      res = await browser.runtime.sendMessage({
        type: 'CAPTURE_FOR_PREVIEW',
        mode: mode  // 'entire' | 'visible' | 'selection'
      });
    } catch (e) {
      showError('Tidak bisa menangkap halaman: ' + e.message);
      restoreButton();
      return;
    }

    if (!res || !res.ok) {
      const err = res?.error || 'unknown';

      // === Handle dynamic page error with helpful modal ===
      if (err === 'dynamic_page') {
        restoreButton();
        showDynamicPageModal(res.dynamicMessage || 'Halaman ini terlalu dinamis untuk full-page capture.', res.dynamicReason);
        return;
      }

      let msg = 'Gagal menangkap.';
      if (err === 'no_tab') msg = 'Tidak ada tab aktif.';
      else if (err === 'not_http_page') msg = 'Bukan halaman web (http/https).';
      else if (err === 'cancelled') msg = 'Dibatalkan.';
      else msg = 'Error: ' + String(err).slice(0, 80);
      showError(msg);
      restoreButton();
      return;
    }

    lastCapture = {
      dataUrl: res.dataUrl,
      width: res.width,
      height: res.height,
      bytes: res.bytes,
      mode: res.mode || 'entire'
    };
    restoreButton();
    showModal();
  }

  function restoreButton() {
    if (!fabBtn) return;
    fabBtn.classList.remove('recallfox-fab-busy');
    fabBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 7h3l1.5-2h7L17 7h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z"/>
        <circle cx="12" cy="13" r="3.2"/>
      </svg>
    `;
  }

  function showError(msg) {
    ensureStyles();
    let t = document.getElementById('recallfox-overlay-error');
    if (!t) {
      t = document.createElement('div');
      t.id = 'recallfox-overlay-error';
      t.className = 'recallfox-overlay-error';
      document.body.appendChild(t);
    }
    t.textContent = '⚠ ' + msg;
    t.classList.add('show');
    clearTimeout(t._hideTimer);
    t._hideTimer = setTimeout(() => t.classList.remove('show'), 3500);
  }

  // ===== Mode picker dialog (industry-standard) =====
  // Centered modal with 3 options: Bagian terlihat (recommended) / Seleksi area / Seluruh halaman
  function showModePicker() {
    return new Promise((resolve) => {
      ensureStyles();
      if (modalEl) { modalEl.remove(); modalEl = null; }

      modalEl = document.createElement('div');
      modalEl.id = 'recallfox-capture-modal';
      modalEl.className = 'rf-capture-modal-overlay';

      modalEl.innerHTML = `
        <div class="rf-cap-dialog" role="dialog" aria-modal="true" aria-labelledby="rf-cap-title">
          <header class="rf-cap-dialog-head">
            <div>
              <h2 id="rf-cap-title">Ambil screenshot</h2>
              <p>Pilih bagian yang ingin Anda tangkap.</p>
            </div>
            <button class="rf-cap-dialog-close" title="Tutup" aria-label="Tutup">×</button>
          </header>
          <div class="rf-cap-choices">
            <button class="rf-cap-choice rf-cap-choice-recommended" data-mode="visible">
              <div class="rf-cap-choice-ic">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="5" width="18" height="14" rx="2"/>
                  <path d="M8 3v4m8-4v4M8 17v4m8-4v4"/>
                </svg>
              </div>
              <div class="rf-cap-choice-text">
                <strong>Bagian terlihat</strong>
                <span>Ambil layar yang sedang terlihat. Cepat dan paling andal.</span>
              </div>
              <div class="rf-cap-choice-tag">Disarankan</div>
              <div class="rf-cap-choice-key">Alt ⇧ 7</div>
            </button>
            <button class="rf-cap-choice" data-mode="selection">
              <div class="rf-cap-choice-ic">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M4 7V4h3m10 0h3v3M4 17v3h3m13-3v3h-3"/>
                  <path d="M8 8h8v8H8z"/>
                </svg>
              </div>
              <div class="rf-cap-choice-text">
                <strong>Seleksi area</strong>
                <span>Seret kotak pada area tertentu. Tekan Esc untuk membatalkan.</span>
              </div>
              <div class="rf-cap-choice-key">Alt ⇧ 6</div>
            </button>
            <button class="rf-cap-choice" data-mode="entire">
              <div class="rf-cap-choice-ic">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M7 3h10v18H7z"/>
                  <path d="M10 7h4m-4 4h4m-4 4h3"/>
                </svg>
              </div>
              <div class="rf-cap-choice-text">
                <strong>Seluruh halaman</strong>
                <span>Gabungkan halaman dari atas hingga bawah. Cocok untuk artikel statis.</span>
              </div>
              <div class="rf-cap-choice-key">Alt ⇧ 5</div>
            </button>
          </div>
          <footer class="rf-cap-dialog-foot">
            <span>Untuk halaman chat/dinamis, gunakan Bagian terlihat atau Seleksi area.</span>
            <button class="rf-cap-settings-link" id="rf-cap-default-mode">Atur default mode</button>
          </footer>
        </div>
      `;
      document.body.appendChild(modalEl);

      const close = (result) => {
        if (modalEl) { modalEl.remove(); modalEl = null; }
        document.removeEventListener('keydown', escHandler, true);
        resolve(result);
      };

      const escHandler = (e) => {
        if (e.key === 'Escape') close(null);
      };

      modalEl.querySelector('.rf-cap-dialog-close').addEventListener('click', () => close(null));
      modalEl.addEventListener('click', (e) => { if (e.target === modalEl) close(null); });
      document.addEventListener('keydown', escHandler, true);

      modalEl.querySelectorAll('.rf-cap-choice').forEach(btn => {
        btn.addEventListener('click', () => close(btn.dataset.mode));
      });

      // "Atur default mode" link — opens settings
      modalEl.querySelector('#rf-cap-default-mode').addEventListener('click', () => {
        browser.runtime.openOptionsPage?.();
        close(null);
      });

      // Auto-focus first choice (recommended) for keyboard navigation
      setTimeout(() => modalEl.querySelector('.rf-cap-choice')?.focus(), 50);
    });
  }

  // ===== Dynamic page error modal (chat apps, infinite scroll, etc.) =====
  function showDynamicPageModal(message, reason) {
    ensureStyles();
    if (modalEl) modalEl.remove();

    modalEl = document.createElement('div');
    modalEl.id = 'recallfox-capture-modal';
    modalEl.className = 'rf-capture-modal-overlay';

    const isChatApp = reason === 'chat_app';
    const alternatives = isChatApp
      ? `
        <div class="rf-cap-alt-list">
          <div class="rf-cap-alt-item">
            <span class="rf-cap-alt-icon">📸</span>
            <div>
              <div class="rf-cap-alt-title">Snapshot Percakapan (teks)</div>
              <div class="rf-cap-alt-desc">Tekan <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>3</kbd> atau klik tombol mengambang di halaman ini. Ambil teks semua pesan user+AI, lebih reliable untuk chat.</div>
            </div>
          </div>
          <div class="rf-cap-alt-item">
            <span class="rf-cap-alt-icon">📱</span>
            <div>
              <div class="rf-cap-alt-title">Bagian Terlihat</div>
              <div class="rf-cap-alt-desc">Scroll manual ke bagian yang mau disimpan, lalu klik tombol Screenshot → pilih "Bagian terlihat". Capture cuma viewport saat itu.</div>
            </div>
          </div>
          <div class="rf-cap-alt-item">
            <span class="rf-cap-alt-icon">✂️</span>
            <div>
              <div class="rf-cap-alt-title">Seleksi Area</div>
              <div class="rf-cap-alt-desc">Klik tombol Screenshot → pilih "Seleksi area", seret kotak di bagian yang ingin di-capture. Bisa diulang untuk beberapa bagian.</div>
            </div>
          </div>
          <div class="rf-cap-alt-item">
            <span class="rf-cap-alt-icon">🖨️</span>
            <div>
              <div class="rf-cap-alt-title">Firefox Print → Save as PDF</div>
              <div class="rf-cap-alt-desc">Tekan <kbd>Ctrl</kbd>+<kbd>P</kbd> (atau <kbd>⌘</kbd>+<kbd>P</kbd>) → pilih "Save to PDF". Browser handle rendering penuh.</div>
            </div>
          </div>
        </div>
      `
      : `
        <div class="rf-cap-alt-list">
          <div class="rf-cap-alt-item">
            <span class="rf-cap-alt-icon">📱</span>
            <div>
              <div class="rf-cap-alt-title">Bagian Terlihat</div>
              <div class="rf-cap-alt-desc">Capture cuma viewport saat ini — paling cepat dan reliable.</div>
            </div>
          </div>
          <div class="rf-cap-alt-item">
            <span class="rf-cap-alt-icon">✂️</span>
            <div>
              <div class="rf-cap-alt-title">Seleksi Area</div>
              <div class="rf-cap-alt-desc">Seret kotak di bagian yang ingin di-capture. Bisa diulang beberapa kali.</div>
            </div>
          </div>
          <div class="rf-cap-alt-item">
            <span class="rf-cap-alt-icon">🖨️</span>
            <div>
              <div class="rf-cap-alt-title">Firefox Print → Save as PDF</div>
              <div class="rf-cap-alt-desc">Tekan <kbd>Ctrl</kbd>+<kbd>P</kbd> → pilih "Save to PDF".</div>
            </div>
          </div>
        </div>
      `;

    modalEl.innerHTML = `
      <div class="rf-capture-modal rf-capture-modal-error">
        <div class="rf-capture-modal-header">
          <span class="rf-capture-modal-icon">⚠️</span>
          <h3>Tidak bisa full-page capture</h3>
          <button class="rf-capture-modal-close" title="Tutup">×</button>
        </div>
        <div class="rf-capture-modal-body">
          <div class="rf-cap-error-message">${escapeHtml(message)}</div>
          <div class="rf-cap-error-divider"></div>
          <div class="rf-cap-error-suggestion">
            <strong>Alternatif yang bisa dipakai:</strong>
            ${alternatives}
          </div>
        </div>
        <div class="rf-capture-modal-footer">
          <button class="rf-cap-btn rf-cap-btn-primary" data-action="close-error">Mengerti, tutup</button>
        </div>
      </div>
    `;
    document.body.appendChild(modalEl);

    const close = () => {
      if (modalEl) { modalEl.remove(); modalEl = null; }
    };
    modalEl.querySelector('.rf-capture-modal-close').addEventListener('click', close);
    modalEl.addEventListener('click', (e) => { if (e.target === modalEl) close(); });
    modalEl.querySelector('[data-action="close-error"]').addEventListener('click', close);

    const escHandler = (e) => {
      if (e.key === 'Escape') {
        close();
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
  }

  // ===== Preview modal (after capture) =====
  function showModal() {
    if (!lastCapture) return;
    ensureStyles();

    if (modalEl) modalEl.remove();

    modalEl = document.createElement('div');
    modalEl.id = 'recallfox-capture-modal';
    modalEl.className = 'rf-capture-modal-overlay';

    const { dataUrl, width, height, bytes, mode } = lastCapture;
    const dimsText = `${width} × ${height} px`;
    const sizeText = fmtBytes(bytes);
    const modeLabel = mode === 'visible' ? 'Bagian terlihat' : mode === 'selection' ? 'Seleksi area' : 'Seluruh halaman';

    modalEl.innerHTML = `
      <div class="rf-capture-modal">
        <div class="rf-capture-modal-header">
          <span class="rf-capture-modal-icon">📸</span>
          <h3>Screenshot diambil</h3>
          <button class="rf-capture-modal-close" title="Tutup">×</button>
        </div>
        <div class="rf-capture-modal-body">
          <div class="rf-capture-modal-preview">
            <img src="${dataUrl}" alt="Screenshot preview" />
          </div>
          <div class="rf-capture-modal-info">
            <span class="rf-capture-modal-info-dims">📐 ${dimsText}</span>
            <span class="rf-capture-modal-info-size">💾 ${sizeText}</span>
            <span class="rf-capture-modal-info-mode">🔧 ${escapeHtml(modeLabel)}</span>
          </div>
          <!-- v3.11.26 (Issue #2): Catatan anotasi — muncul setelah anotasi dibuat -->
          <div class="rf-capture-modal-note" style="display:none;margin-top:6px;padding:6px 10px;background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;font-size:12px;color:#92400e">
            <strong>📝 Catatan:</strong> <span class="rf-capture-modal-note-text"></span>
          </div>
        </div>
        <div class="rf-capture-modal-footer">
          <div class="rf-capture-modal-actions-primary">
            <button class="rf-cap-btn rf-cap-btn-primary" data-action="save-pdf">
              <span class="rf-cap-btn-icon">📄</span>
              <span>Simpan PDF</span>
            </button>
            <button class="rf-cap-btn rf-cap-btn-primary" data-action="save-jpg">
              <span class="rf-cap-btn-icon">🖼️</span>
              <span>Simpan JPG</span>
            </button>
            <button class="rf-cap-btn rf-cap-btn-primary" data-action="save-png">
              <span class="rf-cap-btn-icon">🖼️</span>
              <span>Simpan PNG</span>
            </button>
          </div>
          <div class="rf-capture-modal-actions-secondary">
            <button class="rf-cap-btn rf-cap-btn-ghost" data-action="annotate">
              <span class="rf-cap-btn-icon">✏️</span>
              <span>Anotasi</span>
            </button>
            <button class="rf-cap-btn rf-cap-btn-ghost" data-action="copy" title="Salin gambar saja ke clipboard">
              <span class="rf-cap-btn-icon">📋</span>
              <span>Salin Gambar</span>
            </button>
            <button class="rf-cap-btn rf-cap-btn-ghost" data-action="copy-bundle" title="Salin gambar + keterangan (URL, judul, waktu) ke clipboard">
              <span class="rf-cap-btn-icon">📦</span>
              <span>Salin + Keterangan</span>
            </button>
            <button class="rf-cap-btn rf-cap-btn-ghost" data-action="save-vault">
              <span class="rf-cap-btn-icon">🦊</span>
              <span>Simpan ke Vault</span>
            </button>
            <button class="rf-cap-btn rf-cap-btn-ghost" data-action="cancel">Batal</button>
          </div>
        </div>
        <div class="rf-capture-modal-status" id="rf-capture-modal-status" hidden></div>
      </div>
    `;
    document.body.appendChild(modalEl);

    const close = () => {
      if (modalEl) {
        modalEl.remove();
        modalEl = null;
      }
    };
    modalEl.querySelector('.rf-capture-modal-close').addEventListener('click', close);
    modalEl.addEventListener('click', (e) => { if (e.target === modalEl) close(); });

    const escHandler = (e) => {
      if (e.key === 'Escape') {
        close();
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);

    modalEl.querySelectorAll('.rf-cap-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        if (action === 'cancel') { close(); return; }
        await handleAction(action, btn);
      });
    });
  }

  function showStatus(msg, isError = false) {
    const s = document.getElementById('rf-capture-modal-status');
    if (!s) return;
    s.textContent = msg;
    s.classList.toggle('rf-capture-modal-status-error', !!isError);
    s.hidden = false;
    clearTimeout(s._hideTimer);
    s._hideTimer = setTimeout(() => { s.hidden = true; }, 3500);
  }

  async function handleAction(action, btn) {
    if (!lastCapture) return;
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="rf-cap-btn-icon"><span class="rf-cap-mini-spinner"></span></span><span>Memproses…</span>';

    try {
      const pageTitle = document.title || 'screenshot';
      const safeName = pageTitle.replace(/[^a-z0-9\-_]+/gi, '_').slice(0, 60);
      const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');

      if (action === 'save-pdf') {
        showStatus('Membuat PDF…');
        const res = await browser.runtime.sendMessage({
          type: 'SAVE_CAPTURE_AS', format: 'pdf',
          dataUrl: lastCapture.dataUrl, title: pageTitle,
          filename: `${safeName}_${ts}.pdf`
        });
        if (res?.ok) showStatus('✓ PDF tersimpan ke folder Downloads');
        else showStatus('✗ Gagal: ' + (res?.error || 'unknown'), true);

      } else if (action === 'save-jpg' || action === 'save-png') {
        const ext = action === 'save-jpg' ? 'jpg' : 'png';
        showStatus(`Menyimpan ${ext.toUpperCase()}…`);
        const res = await browser.runtime.sendMessage({
          type: 'SAVE_CAPTURE_AS', format: ext,
          dataUrl: lastCapture.dataUrl, title: pageTitle,
          filename: `${safeName}_${ts}.${ext}`
        });
        if (res?.ok) showStatus(`✓ ${ext.toUpperCase()} tersimpan ke folder Downloads`);
        else showStatus('✗ Gagal: ' + (res?.error || 'unknown'), true);

      } else if (action === 'annotate') {
        // v3.11.4: Buka editor anotasi (canvas-based).
        // Inject annotate.js on-demand, lalu panggil __RecallFoxAnnotate__.
        showStatus('Membuka editor anotasi…');
        try {
          // Inject annotate.js if not yet loaded
          if (typeof window.__RecallFoxAnnotate__ !== 'function') {
            await _injectAnnotateScript();
          }
          // Hide preview modal while editor is open (but don't close it)
          modalEl.style.display = 'none';
          const result = await window.__RecallFoxAnnotate__(lastCapture.dataUrl);
          if (result && !result.cancelled && result.dataUrl) {
            // Replace lastCapture.dataUrl dengan versi annotated
            lastCapture.dataUrl = result.dataUrl;
            // v3.11.26 (Issue #2): Simpan catatan anotasi
            if (result.note) {
              lastCapture.note = result.note;
              // Tampilkan catatan di preview modal
              const noteEl = modalEl.querySelector('.rf-capture-modal-note');
              if (noteEl) {
                noteEl.style.display = '';
                noteEl.querySelector('.rf-capture-modal-note-text').textContent = result.note;
              }
            }
            // Recompute bytes (PNG size approx)
            try {
              const blob = await (await fetch(result.dataUrl)).blob();
              lastCapture.bytes = blob.size;
            } catch (e) {}
            // Update preview image
            const previewImg = modalEl.querySelector('.rf-capture-modal-preview img');
            if (previewImg) previewImg.src = result.dataUrl;
            // Update size display
            const sizeEl = modalEl.querySelector('.rf-capture-modal-info-size');
            if (sizeEl) sizeEl.textContent = '💾 ' + fmtBytes(lastCapture.bytes);
            showStatus('✓ Anotasi diterapkan — siap disimpan');
          } else {
            showStatus('Anotasi dibatalkan');
          }
          modalEl.style.display = '';
        } catch (e) {
          showStatus('✗ Anotasi error: ' + e.message, true);
          modalEl.style.display = '';
        }
      } else if (action === 'copy') {
        // v3.11.23 (Issue #1 fix): Salin gambar saja ke clipboard (tanpa keterangan)
        // FIX: Sebelumnya fallback pakai browser.clipboard.setImageData yang TIDAK ADA
        // di content script → error "browser clipboard is undefined".
        // Sekarang: coba navigator.clipboard.write (works di Firefox 127+ dengan user gesture),
        // kalau gagal → delegate ke background (inject clipboard write ke page context),
        // kalau masih gagal → download file sebagai fallback.
        showStatus('Menyalin gambar ke clipboard…');
        let copyOk = false;
        try {
          const blob = await (await fetch(lastCapture.dataUrl)).blob();
          // Normalisasi ke PNG (Firefox clipboard hanya support image/png)
          let pngBlob = blob;
          if (blob.type !== 'image/png') {
            const img = await createImageBitmap(blob);
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            canvas.getContext('2d').drawImage(img, 0, 0);
            pngBlob = await new Promise(r => canvas.toBlob(r, 'image/png'));
          }
          if (typeof ClipboardItem !== 'undefined') {
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
            showStatus('✓ Gambar tersalin ke clipboard');
            copyOk = true;
          }
        } catch (e) {
          console.warn('[RecallFox] clipboard.write failed in overlay:', e.message);
        }
        if (!copyOk) {
          // Fallback: delegate ke background (inject clipboard write ke page context)
          try {
            const res = await browser.runtime.sendMessage({
              type: 'COPY_DATAURL_TO_CLIPBOARD',
              dataUrl: lastCapture.dataUrl,
              withCaption: false
            });
            if (res?.ok) {
              showStatus(res.message || '✓ Gambar tersalin ke clipboard');
              copyOk = true;
            }
          } catch (e) {
            console.warn('[RecallFox] Background clipboard delegate failed:', e.message);
          }
        }
        if (!copyOk) {
          // Last resort: download file
          try {
            const a = document.createElement('a');
            a.href = lastCapture.dataUrl;
            a.download = 'screenshot-' + Date.now() + '.png';
            document.body.appendChild(a);
            a.click();
            a.remove();
            showStatus('✓ Gambar disimpan ke Downloads (clipboard tidak support)');
          } catch (e) {
            showStatus('✗ Gagal salin: ' + e.message, true);
          }
        }

      } else if (action === 'copy-bundle') {
        // v3.11.23 (Issue #1 fix): Salin gambar + keterangan lengkap
        // FIX: Sama seperti 'copy' — hapus browser.clipboard.setImageData fallback.
        showStatus('Menyalin gambar + keterangan…');
        const pageTitle = document.title || 'screenshot';
        const pageUrl = location.href;
        const capturedAt = new Date().toISOString();
        const modeLabel = lastCapture.mode === 'visible' ? 'Viewport' : (lastCapture.mode === 'selection' ? 'Area' : 'Seluruh halaman');
        const dims = lastCapture.width + '×' + lastCapture.height + ' px';

        // v3.11.26 (Issue #2): Sertakan catatan anotasi di keterangan kalau ada
        const noteText = lastCapture.note ? '\n📝 Catatan: ' + lastCapture.note : '';
        const noteHtml = lastCapture.note
          ? '<p style="margin:0 0 2px;color:#92400e;background:#fef3c7;padding:4px 8px;border-radius:4px">📝 ' + escapeHtml(lastCapture.note) + '</p>'
          : '';

        const textPlain = '📸 Screenshot — ' + pageTitle + '\n'
          + 'Sumber: ' + pageUrl + '\n'
          + 'Waktu: ' + new Date().toLocaleString('id-ID', { dateStyle: 'full', timeStyle: 'short' }) + '\n'
          + 'Mode: ' + modeLabel + ' · ' + dims + '\n'
          + (lastCapture.note ? '📝 Catatan: ' + lastCapture.note + '\n' : '')
          + 'Ditangkap oleh RecallFox';

        const textHtml = '<div style="font-family:-apple-system,system-ui,sans-serif;font-size:13px;color:#1c1917">'
          + '<p style="margin:0 0 6px"><img src="' + lastCapture.dataUrl + '" alt="screenshot" style="max-width:100%;border-radius:8px;border:1px solid #e7e5e4"/></p>'
          + '<p style="margin:8px 0 2px"><strong>📸 ' + escapeHtml(pageTitle) + '</strong></p>'
          + '<p style="margin:0 0 2px;color:#57534e">🔗 <a href="' + escapeHtml(pageUrl) + '">' + escapeHtml(pageUrl) + '</a></p>'
          + '<p style="margin:0 0 2px;color:#57534e">🕒 ' + escapeHtml(new Date().toLocaleString('id-ID', { dateStyle: 'full', timeStyle: 'short' })) + '</p>'
          + (lastCapture.note ? '<p style="margin:0 0 2px;color:#92400e;background:#fef3c7;padding:4px 8px;border-radius:4px">📝 ' + escapeHtml(lastCapture.note) + '</p>' : '')
          + '<p style="margin:0;color:#78716c">🔧 ' + escapeHtml(modeLabel) + ' · ' + dims + ' · RecallFox</p>'
          + '</div>';

        let copyOk = false;
        try {
          const blob = await (await fetch(lastCapture.dataUrl)).blob();
          let pngBlob = new Blob([await blob.arrayBuffer()], { type: 'image/png' });
          if (blob.type !== 'image/png') {
            const img = await createImageBitmap(blob);
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            canvas.getContext('2d').drawImage(img, 0, 0);
            pngBlob = await new Promise(r => canvas.toBlob(r, 'image/png'));
          }
          if (typeof ClipboardItem !== 'undefined') {
            const clipboardItem = new ClipboardItem({
              'image/png': pngBlob,
              'text/html': new Blob([textHtml], { type: 'text/html' }),
              'text/plain': new Blob([textPlain], { type: 'text/plain' })
            });
            await navigator.clipboard.write([clipboardItem]);
            showStatus('✓ Gambar + keterangan tersalin ke clipboard');
            copyOk = true;
          }
        } catch (e) {
          console.warn('[RecallFox] clipboard.write bundle failed:', e.message);
        }
        if (!copyOk) {
          // Fallback: delegate ke background
          try {
            const res = await browser.runtime.sendMessage({
              type: 'COPY_DATAURL_TO_CLIPBOARD',
              dataUrl: lastCapture.dataUrl,
              withCaption: true,
              textPlain: textPlain,
              textHtml: textHtml
            });
            if (res?.ok) {
              showStatus(res.message || '✓ Gambar + keterangan tersalin');
              copyOk = true;
            }
          } catch (e) {
            console.warn('[RecallFox] Background clipboard delegate failed:', e.message);
          }
        }
        if (!copyOk) {
          // Last resort: copy text + download image
          try {
            await navigator.clipboard.writeText(textPlain);
            const a = document.createElement('a');
            a.href = lastCapture.dataUrl;
            a.download = 'screenshot-' + Date.now() + '.png';
            document.body.appendChild(a);
            a.click();
            a.remove();
            showStatus('✓ Keterangan disalin + gambar di-download (clipboard image tidak support)');
          } catch (e) {
            showStatus('✗ Gagal salin: ' + e.message, true);
          }
        }

      } else if (action === 'save-vault') {
        showStatus('Menyimpan ke vault…');
        const res = await browser.runtime.sendMessage({
          type: 'SAVE_CAPTURE_TO_VAULT',
          dataUrl: lastCapture.dataUrl, width: lastCapture.width,
          height: lastCapture.height, bytes: lastCapture.bytes, mode: lastCapture.mode,
          url: location.href, pageTitle: document.title,
          annotationNote: lastCapture.note || ''  // v3.11.26 (Issue #2): catatan anotasi
        });
        if (res?.ok) showStatus('✓ Tersimpan ke vault');
        else showStatus('✗ Gagal: ' + (res?.error || 'unknown'), true);
      }
    } catch (e) {
      showStatus('✗ Error: ' + e.message, true);
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  }

  // ===== Capture toast (bottom-center pill) =====
  function showCaptureToast(msg, isError, duration) {
    ensureStyles();
    let t = document.getElementById('recallfox-capture-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'recallfox-capture-toast';
      t.className = 'recallfox-capture-toast';
      document.body.appendChild(t);
    }
    t.textContent = (isError ? '⚠ ' : '') + msg;
    t.classList.add('show');
    clearTimeout(t._hideTimer);
    t._hideTimer = setTimeout(() => t.classList.remove('show'), duration || 2500);
  }

  function escapeHtml(s) {
    return (s || '').toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ===== Init =====
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(maybeInjectOverlay, 800);
  } else {
    document.addEventListener('DOMContentLoaded', () => setTimeout(maybeInjectOverlay, 800));
  }

  // Re-inject on SPA navigation
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(maybeInjectOverlay, 1000);
    }
  }).observe(document.body, { childList: true, subtree: true });

  // Listen for setting changes & capture triggers from background
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'OVERLAY_TOGGLED') {
      maybeInjectOverlay();
    }
    if (msg.type === 'TRIGGER_CAPTURE_FROM_POPUP') {
      // msg.mode can be 'entire' | 'visible' | 'selection' | undefined (show picker)
      triggerCapture(msg.mode);
    }
    // v3.11.7-fix2 (Sesi 7, Issue #5): Adzan playback dari content script.
    // Audio tidak bisa di-play dari background service worker (MV3 restriction).
    // Background kirim PLAY_ADZAN ke content script tab aktif, di sini kita mainkan.
    if (msg.type === 'PLAY_ADZAN') {
      try {
        _playAdzanInPage(msg);
        sendResponse({ ok: true });
      } catch (e) {
        console.warn('[RecallFox] Adzan playback failed in content script:', e.message);
        sendResponse({ ok: false, error: e.message });
      }
      return true; // async response
    }
    if (msg.type === 'STOP_ADZAN') {
      try {
        _stopAdzanInPage();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
      return true;
    }
  });

  // ===== Adzan audio player (in-page) =====
  // v3.11.10: Rewrite untuk pakai Web Audio API tone (sama seperti popup.js).
  // V3.11.7-fix2 pakai URL IslamicFinder (azan1.mp3) → v3.11.9 ketahui 404.
  // V3.11.10: pakai Web Audio API tone 30+ detik dengan chord + vibrato + reverb,
  // lebih mirip suara adzan asli (bukan bel). Tetap allow custom URL ke file MP3 asli.
  let _adzanAudioEl = null;
  let _adzanToneCtx = null;
  let _adzanBannerEl = null;

  function _stopAdzanInPage() {
    // Stop Audio element (untuk custom URL)
    if (_adzanAudioEl) {
      try { _adzanAudioEl.pause(); _adzanAudioEl.currentTime = 0; } catch (e) {}
      _adzanAudioEl = null;
    }
    // Stop Web Audio API context (untuk default/short tone)
    if (_adzanToneCtx) {
      try { _adzanToneCtx.close(); } catch (e) {}
      _adzanToneCtx = null;
    }
    if (_adzanBannerEl) {
      try { _adzanBannerEl.remove(); } catch (e) {}
      _adzanBannerEl = null;
    }
  }

  // v3.11.10: Generate adzan tone dengan Web Audio API (chord + vibrato + reverb).
  // Lihat popup/popup.js _playAdzanTone untuk dokumentasi lengkap.
  function _playAdzanToneInPage(vol, isShort) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) {
        console.warn('[RecallFox] Web Audio API tidak support di page context');
        return;
      }
      const ctx = new AudioCtx();
      _adzanToneCtx = ctx;
      const now = ctx.currentTime;

      // Reverb
      const reverbDelay = ctx.createDelay(2.0);
      reverbDelay.delayTime.value = 0.18;
      const reverbFeedback = ctx.createGain();
      reverbFeedback.gain.value = 0.35;
      const reverbWet = ctx.createGain();
      reverbWet.gain.value = 0.25;
      reverbDelay.connect(reverbFeedback);
      reverbFeedback.connect(reverbDelay);
      reverbDelay.connect(reverbWet);

      // Master + lowpass
      const masterGain = ctx.createGain();
      masterGain.gain.value = vol;
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 2400;
      lowpass.Q.value = 0.7;
      masterGain.connect(lowpass);
      lowpass.connect(ctx.destination);
      lowpass.connect(reverbDelay);
      reverbWet.connect(ctx.destination);

      const syllables = [
        { freq: 440, start: 0.0, dur: 0.6, gain: 0.9 },
        { freq: 392, start: 0.6, dur: 0.5, gain: 0.85 },
        { freq: 440, start: 1.1, dur: 0.7, gain: 0.9 },
        { freq: 329.63, start: 1.8, dur: 0.5, gain: 0.8 },
        { freq: 440, start: 2.3, dur: 1.5, gain: 1.0 },
        { freq: 0, start: 3.8, dur: 0.4, gain: 0 },
        { freq: 466.16, start: 4.2, dur: 0.6, gain: 0.9 },
        { freq: 415.30, start: 4.8, dur: 0.5, gain: 0.85 },
        { freq: 466.16, start: 5.3, dur: 0.7, gain: 0.9 },
        { freq: 349.23, start: 6.0, dur: 0.5, gain: 0.8 },
        { freq: 466.16, start: 6.5, dur: 1.5, gain: 1.0 },
        { freq: 0, start: 8.0, dur: 0.4, gain: 0 },
      ];
      const phrases = isShort ? syllables.slice(0, 6) : syllables;

      for (const syl of phrases) {
        if (syl.freq === 0) continue;
        const start = now + syl.start;
        const end = start + syl.dur;
        const harmonics = [
          { ratio: 1.0, gain: 0.6 },
          { ratio: 2.0, gain: 0.2 },
          { ratio: 1.5, gain: 0.15 },
        ];
        for (const h of harmonics) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = syl.freq * h.ratio;
          const vibrato = ctx.createOscillator();
          const vibratoGain = ctx.createGain();
          vibrato.frequency.value = 5;
          vibratoGain.gain.value = syl.freq * 0.015;
          vibrato.connect(vibratoGain);
          vibratoGain.connect(osc.frequency);
          const peakGain = vol * syl.gain * h.gain;
          gain.gain.setValueAtTime(0, start);
          gain.gain.linearRampToValueAtTime(peakGain, start + 0.08);
          gain.gain.linearRampToValueAtTime(peakGain * 0.75, start + syl.dur * 0.5);
          gain.gain.linearRampToValueAtTime(0, end);
          osc.connect(gain);
          gain.connect(masterGain);
          osc.start(start);
          osc.stop(end + 0.1);
          vibrato.start(start);
          vibrato.stop(end + 0.1);
        }
      }

      const totalDur = isShort ? 10 : 28;
      setTimeout(() => {
        try { if (ctx.state !== 'closed') ctx.close(); } catch (e) {}
      }, totalDur * 1000 + 500);
    } catch (e) {
      console.warn('[RecallFox] Adzan tone in-page failed:', e.message);
    }
  }

  function _playAdzanInPage(msg) {
    _stopAdzanInPage();

    // v3.11.10: Sound logic
    // - 'custom' + customUrl → pakai Audio element dengan URL custom
    // - 'short' → pakai Web Audio API tone (short version, 2 phrase)
    // - 'default' atau lainnya → pakai Web Audio API tone (default, 2 phrase + 2 phrase)
    const sound = msg.sound || 'default';
    const vol = Math.max(0, Math.min(1, Number(msg.volume) || 0.7));

    if (sound === 'custom' && msg.customUrl) {
      // Pakai Audio element dengan URL custom (file MP3 user)
      try {
        _adzanAudioEl = new Audio(msg.customUrl);
        _adzanAudioEl.volume = vol;
        _adzanAudioEl.crossOrigin = 'anonymous';
        _adzanAudioEl.play().catch(e => {
          console.warn('[RecallFox] Adzan custom URL play failed:', e.message);
          // Fallback ke tone
          _playAdzanToneInPage(vol, false);
        });
      } catch (e) {
        console.warn('[RecallFox] Adzan Audio init failed:', e.message);
        _playAdzanToneInPage(vol, false);
      }
    } else {
      // Pakai Web Audio API tone
      _playAdzanToneInPage(vol, sound === 'short');
    }

    // Banner Stop (fixed di pojok kanan bawah halaman, tidak nutupin konten utama)
    _adzanBannerEl = document.createElement('div');
    _adzanBannerEl.id = 'rf-adzan-banner';
    _adzanBannerEl.style.cssText = [
      'position:fixed',
      'bottom:16px',
      'right:16px',
      'background:linear-gradient(135deg,#10b981,#059669)',
      'color:#fff',
      'padding:10px 14px',
      'border-radius:10px',
      'display:flex',
      'align-items:center',
      'gap:10px',
      'z-index:2147483647',
      'font-size:13px',
      'box-shadow:0 4px 12px rgba(0,0,0,0.2)',
      'font-family:inherit',
      'max-width:calc(100vw - 32px)'
    ].join(';');
    _adzanBannerEl.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px">'
      + '<span style="font-size:18px">🕌</span>'
      + '<div>'
      +   '<div style="font-weight:600">Adzan — ' + (msg.prayer || 'waktu sholat') + ' telah masuk</div>'
      +   '<div style="font-size:11px;opacity:0.85">Klik ⏹ Stop untuk menghentikan</div>'
      + '</div>'
      + '</div>'
      + '<button id="rf-adzan-stop" style="background:rgba(255,255,255,0.2);color:#fff;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;white-space:nowrap">⏹ Stop</button>';
    document.body.appendChild(_adzanBannerEl);

    // Bind tombol Stop
    const stopBtn = _adzanBannerEl.querySelector('#rf-adzan-stop');
    if (stopBtn) {
      stopBtn.addEventListener('click', _stopAdzanInPage);
    }

    // Auto-cleanup saat audio selesai (hanya untuk Audio element custom URL)
    if (_adzanAudioEl) {
      _adzanAudioEl.onended = () => _stopAdzanInPage();
      _adzanAudioEl.onerror = () => {
        console.warn('[RecallFox] Adzan audio error — fallback ke tone');
        _adzanAudioEl = null;
        _playAdzanToneInPage(vol, false);
      };
    }

    // Auto-stop setelah 5 menit (safety, kalau audio tidak pernah ended)
    setTimeout(() => {
      if (_adzanAudioEl || _adzanToneCtx || _adzanBannerEl) {
        console.log('[RecallFox] Adzan auto-stop after 5 minutes');
        _stopAdzanInPage();
      }
    }, 5 * 60 * 1000);
  }

  // Reposition FAB on window resize (keep it on-screen)
  window.addEventListener('resize', () => {
    if (!dockEl) return;
    const rect = dockEl.getBoundingClientRect();
    const w = dockEl.offsetWidth;
    const h = dockEl.offsetHeight;
    // If FAB is now offscreen, clamp it back
    if (rect.right > window.innerWidth || rect.bottom > window.innerHeight || rect.left < 0 || rect.top < 0) {
      const left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.left));
      const top = Math.max(8, Math.min(window.innerHeight - h - 8, rect.top));
      dockEl.style.left = left + 'px';
      dockEl.style.top = top + 'px';
      savePos(left, top);
    }
  });

  console.log('[RecallFox] overlay.js v3.2.0 loaded on', location.href.slice(0, 80));
})();
