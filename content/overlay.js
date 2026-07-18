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
            <button class="rf-cap-btn rf-cap-btn-ghost" data-action="copy">
              <span class="rf-cap-btn-icon">📋</span>
              <span>Salin</span>
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

      } else if (action === 'copy') {
        showStatus('Menyalin ke clipboard…');
        try {
          const blob = await (await fetch(lastCapture.dataUrl)).blob();
          await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
          showStatus('✓ Gambar tersalin ke clipboard');
        } catch (e) {
          try {
            const arr = await (await fetch(lastCapture.dataUrl)).arrayBuffer();
            await browser.clipboard.setImageData(arr, 'png');
            showStatus('✓ Gambar tersalin ke clipboard');
          } catch (e2) {
            showStatus('✗ Gagal salin: ' + e2.message, true);
          }
        }

      } else if (action === 'save-vault') {
        showStatus('Menyimpan ke vault…');
        const res = await browser.runtime.sendMessage({
          type: 'SAVE_CAPTURE_TO_VAULT',
          dataUrl: lastCapture.dataUrl, width: lastCapture.width,
          height: lastCapture.height, bytes: lastCapture.bytes, mode: lastCapture.mode,
          url: location.href, pageTitle: document.title
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
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'OVERLAY_TOGGLED') {
      maybeInjectOverlay();
    }
    if (msg.type === 'TRIGGER_CAPTURE_FROM_POPUP') {
      // msg.mode can be 'entire' | 'visible' | 'selection' | undefined (show picker)
      triggerCapture(msg.mode);
    }
  });

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
