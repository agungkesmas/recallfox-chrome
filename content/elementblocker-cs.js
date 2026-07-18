// content/elementblocker-cs.js — Element Blocker content script
// RecallFox v3.4 (integrated with Element Blocker addon's visual picker)
//
// Cara kerja:
//   1. Inject di semua halaman http(s) (document_start)
//   2. Load rules dari background
//   3. Inject CSS untuk hide selectors
//   4. Remove iframe/script dari domain tracker
//   5. Override window.open di MAIN world untuk block popup
//   6. v3.4: Visual element picker (overlay + hover indicator) ported dari
//      Element Blocker addon. Dipicu via message START_ELEMENT_PICKER dari popup.

(function () {
  'use strict';

  if (window.__recallfoxElementBlockerInjected) return;
  window.__recallfoxElementBlockerInjected = true;

  let rules = [];
  let hoveredElement = null;  // v0.9.0: track elemen yang di-hover untuk "Block Element Ini"

  // ============================================================
  // v3.4: VISUAL ELEMENT PICKER (ported from Element Blocker addon)
  // ============================================================
  // State
  let pickerActive = false;
  let pickerMouseX = 0;
  let pickerMouseY = 0;
  let pickerHoveredEl = null;

  // Build the hover + overlay elements lazily (only when picker activates)
  let pickerHoverDiv = null;
  let pickerOverlayDiv = null;
  let pickerStatusBar = null;

  function buildPickerElements() {
    if (pickerHoverDiv) return;  // already built

    // Hover indicator — dashed red outline that follows the mouse
    pickerHoverDiv = document.createElement('div');
    pickerHoverDiv.className = 'rf-eb-picker-hover';

    // Overlay — catches all clicks while picker is active (so the page's own
    // click handlers don't fire when user is in pick mode)
    pickerOverlayDiv = document.createElement('div');
    pickerOverlayDiv.className = 'rf-eb-picker-overlay';

    // Status bar — shows instructions + a visible Cancel button at top of viewport
    pickerStatusBar = document.createElement('div');
    pickerStatusBar.className = 'rf-eb-picker-status';
    pickerStatusBar.innerHTML =
      '<span class="rf-eb-picker-status-text"><b>🎯 Pilih Elemen</b> · Klik elemen untuk blok · <b>Esc</b> batal</span>'
      + '<button class="rf-eb-picker-cancel-btn" type="button" title="Batal (Esc)">✕ Batal</button>';

    // Inject picker CSS once
    if (!document.getElementById('rf-eb-picker-css')) {
      const style = document.createElement('style');
      style.id = 'rf-eb-picker-css';
      style.textContent = `
        .rf-eb-picker-overlay {
          position: fixed !important;
          top: 0 !important; left: 0 !important;
          right: 0 !important; bottom: 0 !important;
          z-index: 2147483646 !important;
          cursor: crosshair !important;
          background: rgba(15, 12, 10, 0.08) !important;
          box-sizing: border-box !important;
          display: none;
        }
        body.rf-eb-picker-active .rf-eb-picker-overlay { display: block !important; }

        .rf-eb-picker-hover {
          position: absolute !important;
          z-index: 2147483647 !important;
          display: none !important;
          border: 2px dashed #f8303a !important;
          cursor: crosshair !important;
          box-sizing: border-box !important;
          background: rgba(248, 48, 58, 0.12) !important;
          pointer-events: none !important;
          transition: top 0.05s, left 0.05s, width 0.05s, height 0.05s;
        }
        body.rf-eb-picker-active .rf-eb-picker-hover { display: block !important; }

        .rf-eb-picker-status {
          position: fixed !important;
          top: 12px !important;
          left: 50% !important;
          transform: translateX(-50%) !important;
          z-index: 2147483647 !important;
          background: #1a1614 !important;
          color: #fef3c7 !important;
          font-family: -apple-system, system-ui, sans-serif !important;
          font-size: 12.5px !important;
          font-weight: 500 !important;
          padding: 7px 7px 7px 16px !important;
          border-radius: 999px !important;
          box-shadow: 0 4px 14px rgba(0,0,0,0.35) !important;
          display: none;
          align-items: center !important;
          gap: 10px !important;
          pointer-events: auto !important;
          max-width: 94vw !important;
        }
        body.rf-eb-picker-active .rf-eb-picker-status { display: flex !important; }
        .rf-eb-picker-status-text {
          white-space: nowrap !important;
          overflow: hidden !important;
          text-overflow: ellipsis !important;
          pointer-events: none !important;
        }
        .rf-eb-picker-cancel-btn {
          background: #dc2626 !important;
          color: #fff !important;
          border: none !important;
          padding: 5px 12px !important;
          border-radius: 999px !important;
          font-size: 11.5px !important;
          font-weight: 700 !important;
          cursor: pointer !important;
          font-family: inherit !important;
          white-space: nowrap !important;
          flex: none !important;
        }
        .rf-eb-picker-cancel-btn:hover { background: #b91c1c !important; }
        .rf-eb-picker-cancel-btn:active { transform: scale(0.96); }

        /* Highlight the element currently being targeted — also add a glow */
        .rf-eb-picker-target {
          outline: 2px solid #f8303a !important;
          outline-offset: 1px !important;
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    }

    // Wire up the Cancel button (also Esc works, but this is more discoverable)
    // Use mousedown so it fires before the document-level click capture
    pickerStatusBar.querySelector('.rf-eb-picker-cancel-btn').addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      deactivatePicker();
    }, true);
  }

  function activatePicker() {
    if (pickerActive) return;
    buildPickerElements();
    pickerActive = true;
    document.body.classList.add('rf-eb-picker-active');
    // Append overlay first (it captures clicks), then hover indicator
    if (!pickerOverlayDiv.isConnected) document.body.appendChild(pickerOverlayDiv);
    if (!pickerHoverDiv.isConnected) document.body.appendChild(pickerHoverDiv);
    if (!pickerStatusBar.isConnected) document.body.appendChild(pickerStatusBar);
    // Disable text selection while picking
    document.body.style.userSelect = 'none';
    console.log('[RecallFox/EB] Picker activated');
  }

  function deactivatePicker() {
    if (!pickerActive) return;
    pickerActive = false;
    document.body.classList.remove('rf-eb-picker-active');
    if (pickerHoverDiv) pickerHoverDiv.remove();
    if (pickerOverlayDiv) pickerOverlayDiv.remove();
    if (pickerStatusBar) pickerStatusBar.remove();
    document.body.style.userSelect = '';
    pickerHoveredEl = null;
    console.log('[RecallFox/EB] Picker deactivated');
  }

  // Update hover indicator position to follow the element under the cursor
  function updatePickerHover() {
    if (!pickerActive) return;
    // Find the topmost element at the cursor — but skip our own picker elements
    const stack = document.elementsFromPoint(pickerMouseX, pickerMouseY);
    const target = stack.find(function (el) {
      return el !== pickerHoverDiv &&
             el !== pickerOverlayDiv &&
             el !== pickerStatusBar &&
             !el.classList?.contains('rf-eb-picker-target');
    });
    if (!target) return;
    pickerHoveredEl = target;
    // Update hover div position
    const rect = target.getBoundingClientRect();
    const scrollX = window.scrollX || document.documentElement.scrollLeft;
    const scrollY = window.scrollY || document.documentElement.scrollTop;
    pickerHoverDiv.style.top = (rect.top + scrollY) + 'px';
    pickerHoverDiv.style.left = (rect.left + scrollX) + 'px';
    pickerHoverDiv.style.width = rect.width + 'px';
    pickerHoverDiv.style.height = rect.height + 'px';
    // Update status bar with element info
    if (pickerStatusBar) {
      const tag = target.tagName.toLowerCase();
      const idStr = target.id ? '#' + target.id : '';
      const clsStr = target.className && typeof target.className === 'string'
        ? '.' + target.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '';
      const sizeStr = Math.round(rect.width) + '×' + Math.round(rect.height);
      pickerStatusBar.innerHTML = '<b>🎯 ' + tag + idStr + clsStr + '</b> · ' + sizeStr + 'px · Klik untuk blok · <b>Esc</b> batal';
    }
  }

  // Picker mousemove handler — track cursor position
  document.addEventListener('mousemove', function (e) {
    pickerMouseX = e.clientX;
    pickerMouseY = e.clientY;
    if (pickerActive) {
      updatePickerHover();
    }
  }, true);

  // Picker click handler — when active, capture click and block the element
  document.addEventListener('click', function (e) {
    if (!pickerActive) return;
    // Always prevent default picker behavior (don't trigger page's click handlers)
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (!pickerHoveredEl) return;
    // Generate robust selector for the clicked element
    const selectorInfo = generateRobustSelector(pickerHoveredEl);
    if (!selectorInfo || !selectorInfo.selector) {
      console.warn('[RecallFox/EB] Could not generate selector for clicked element');
      deactivatePicker();
      return;
    }
    // Save via background script
    // v3.7: Strip 'www.' prefix dari hostname supaya rule cocok dengan currentDomain di popup
    // (popup pakai url.hostname.replace(/^www\./, '') untuk currentDomain)
    var rawHost = location.hostname || '';
    var normalizedHost = rawHost.replace(/^www\./i, '');
    browser.runtime.sendMessage({
      type: 'EB_BLOCK_CLICKED_ELEMENT',
      selector: selectorInfo.selector,
      altSelectors: selectorInfo.altSelectors || [],
      tagName: selectorInfo.tagName,
      id: selectorInfo.id || '',
      className: selectorInfo.className || '',
      text: selectorInfo.text || '',
      domain: normalizedHost,
      url: location.href
    }).then(function (resp) {
      console.log('[RecallFox/EB] Block saved:', resp);
    }).catch(function (err) {
      console.warn('[RecallFox/EB] Block save failed:', err);
    });
    // Show visual feedback (flash the blocked element)
    flashBlockedElement(pickerHoveredEl);
    // Deactivate picker after one block (user can re-open for another)
    deactivatePicker();
  }, true);

  // Picker keydown handler — Esc cancels picker (attached to both window and document
  // in capture phase so it works even if focus is somewhere weird)
  function pickerKeyHandler(e) {
    if (!pickerActive) return;
    if (e.key === 'Escape' || e.keyCode === 27) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      deactivatePicker();
    }
  }
  window.addEventListener('keydown', pickerKeyHandler, true);
  document.addEventListener('keydown', pickerKeyHandler, true);
  // Also catch Esc via keyup as fallback (some sites swallow keydown)
  window.addEventListener('keyup', function (e) {
    if (pickerActive && (e.key === 'Escape' || e.keyCode === 27)) {
      e.preventDefault();
      deactivatePicker();
    }
  }, true);

  // Flash visual feedback when an element is blocked
  function flashBlockedElement(el) {
    if (!el) return;
    const orig = {
      outline: el.style.outline,
      outlineOffset: el.style.outlineOffset,
      background: el.style.background,
      transition: el.style.transition
    };
    el.style.transition = 'outline 0.2s, background 0.2s';
    el.style.outline = '3px solid #10b981';
    el.style.outlineOffset = '1px';
    el.style.background = 'rgba(16, 185, 129, 0.18)';
    setTimeout(function () {
      el.style.outline = orig.outline;
      el.style.outlineOffset = orig.outlineOffset;
      el.style.background = orig.background;
      setTimeout(function () {
        el.style.transition = orig.transition;
      }, 250);
    }, 600);
  }

  // ============================================================
  // v3.4: ROBUST CSS SELECTOR GENERATOR (ported from Element Blocker addon)
  // ============================================================
  // Generates a unique CSS selector path for the element using nth-of-type,
  // plus alt selectors (with/without class) for resilience.
  function generateRobustSelector(el) {
    if (!el || el.nodeType !== 1) return null;

    const path = [];
    let node = el;
    let nodeIterations = 0;

    while (node && node.nodeType === Node.ELEMENT_NODE) {
      let selector = node.nodeName.toLowerCase();
      let sib = node;
      let nth = 1;
      while ((sib = sib.previousElementSibling)) {
        if (sib.nodeName.toLowerCase() === selector) nth++;
      }
      selector += ':nth-of-type(' + nth + ')';

      // Add classes only for the clicked element itself (nodeIterations === 0)
      if (nodeIterations === 0) {
        if (node.classList && node.classList.length > 0) {
          for (let i = 0; i < node.classList.length; i++) {
            const cls = node.classList[i];
            // Skip invalid classnames (containing ":") and our own markers
            if (cls.indexOf(':') === -1 &&
                cls !== 'rf-eb-picker-hover' &&
                cls !== 'rf-eb-picker-target' &&
                cls !== 'rf-eb-picker-active') {
              selector += '.' + cls;
            }
          }
        }
      }

      path.unshift(selector);
      node = node.parentNode;
      nodeIterations++;
      // Safety limit
      if (nodeIterations > 15) break;
    }

    const fullPath = path.join(' > ');
    const altSelectors = [];

    // Also create a classless variant (some sites randomize classnames)
    const lastSelector = path[path.length - 1];
    if (lastSelector && lastSelector.indexOf('.') > -1) {
      const classlessPath = path.slice();
      classlessPath[classlessPath.length - 1] = lastSelector.split('.')[0];
      const classlessFullPath = classlessPath.join(' > ');
      if (classlessFullPath !== fullPath) altSelectors.push(classlessFullPath);
    }

    // Also try a simpler ID-based selector if element has an ID
    if (el.id) {
      altSelectors.unshift('#' + el.id);
    }

    return {
      selector: fullPath,
      altSelectors: altSelectors,
      tagName: el.tagName.toLowerCase(),
      id: el.id || '',
      className: (typeof el.className === 'string') ? el.className.slice(0, 100) : '',
      text: (el.textContent || '').trim().slice(0, 80)
    };
  }

  // Keep the old simple selector generator for the context-menu path (still used by background)
  function generateSelector(el) {
    if (!el || el.nodeType !== 1) return null;
    // Prioritas: ID > class > tag
    if (el.id) {
      return '#' + el.id;
    }
    if (el.className && typeof el.className === 'string') {
      var classes = el.className.trim().split(/\s+/).filter(c => c.length > 0);
      if (classes.length > 0) {
        var selector = '.' + classes.slice(0, 2).join('.');
        try {
          var matches = document.querySelectorAll(selector);
          if (matches.length <= 3) return selector;
        } catch (e) {}
      }
    }
    var tag = el.tagName.toLowerCase();
    var parent = el.parentElement;
    if (parent) {
      var siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
      var index = siblings.indexOf(el) + 1;
      if (siblings.length > 1) {
        return tag + ':nth-child(' + index + ')';
      }
    }
    return tag;
  }

  // ===== Load rules — baca storage.local DULU (lebih cepat), fallback ke sendMessage =====
  async function loadRules() {
    // Strategi 1: baca storage.local langsung (paling cepat, tidak perlu tunggu background)
    try {
      const data = await browser.storage.local.get('recallfox_vault');
      const vault = data.recallfox_vault;
      if (vault && vault.settings) {
        if (vault.settings.elementBlockerRules && Array.isArray(vault.settings.elementBlockerRules) && vault.settings.elementBlockerRules.length > 0) {
          rules = vault.settings.elementBlockerRules;
          return true;
        }
      }
    } catch (e) {}
    // Strategi 2: kirim message ke background
    try {
      const resp = await browser.runtime.sendMessage({ type: 'EB_GET_RULES' });
      if (resp && resp.rules && resp.rules.length > 0) {
        rules = resp.rules;
        return true;
      }
    } catch (e) {}
    // Strategi 3: hardcoded fallback rules (supaya pasti jalan walau storage kosong)
    rules = [
      {
        id: 'ninospositano',
        name: 'NinosPositano (fallback)',
        domain: 'ninospositano.com',
        enabled: true,
        selectors: [
          '#idmuvi-popup', '.gmr-bannerpopup', '.gmr-bannerpopup-inner', '.banner-content',
          '.idmuvi-topbanner', '.idmuvi-topbanner-aftermenu',
          'a.popup-download', '.textdownload',
          '.gmr-popup-button-widget', 'a.gmr-trailer-popup',
          'img[src*="kilathoki"]', 'img[src*="bandar36"]', 'img[src*="klikhoki"]',
          'img[src*="banner-iklan"]', 'img[src*="vip.idlix21.pro"]', 'img[src*="hoki"]',
          'a[href*="kilathoki"]', 'a[href*="bandar36"]', 'a[href*="klikhoki"]',
          'a[href*="cek.to/idlix"]', 'a[href*="morencius"]'
        ],
        blockDomains: ['kilathoki.info', 'vip.idlix21.pro', 'cek.to', 'dtscout.com', 'histats.com', 'popads.net'],
        blockPopups: true
      }
    ];
    console.log('[RecallFox/EB] Using hardcoded fallback rules');
    return true;
  }

  // ===== Cek apakah fitur aktif =====
  async function isEnabled() {
    try {
      const data = await browser.storage.local.get('recallfox_vault');
      const vault = data.recallfox_vault;
      if (vault && vault.settings) {
        return vault.settings.elementBlockerEnabled !== false;
      }
    } catch (e) {}
    return true;  // default enabled
  }

  // ===== Cari rule yang cocok untuk halaman ini =====
  // v3.7: FIX domain matching — strip www. + 2-arah match
  // (sebelumnya rule "youtube.com" tidak match dengan halaman "www.youtube.com"
  //  padahal seharusnya cocok)
  function getApplicableRules() {
    const url = location.href;
    const matching = [];
    for (const rule of rules) {
      if (rule.enabled === false) continue;
      try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase().replace(/^www\./, '');
        const d = (rule.domain || '').toLowerCase().replace(/^www\./, '');
        if (!d || !host) continue;
        // Match kalau: exact, atau salah satu subdomain dari yang lain, atau rule = 'all'
        if (host === d || host.endsWith('.' + d) || d.endsWith('.' + host) || d === 'all') {
          matching.push(rule);
        }
      } catch (e) {}
    }
    return matching;
  }

  // ===== Inject CSS untuk hide selectors =====
  function injectHideCSS(applicableRules) {
    const allSelectors = [];
    for (const rule of applicableRules) {
      if (rule.selectors && Array.isArray(rule.selectors)) {
        allSelectors.push(...rule.selectors);
      }
    }
    if (allSelectors.length === 0) return;

    const cssId = 'rf-eb-hide-css';
    let style = document.getElementById(cssId);
    if (!style) {
      style = document.createElement('style');
      style.id = cssId;
      document.documentElement.appendChild(style);
    }
    // CSS dengan !important supaya tidak di-override
    const css = allSelectors.map(s => `${s} { display: none !important; visibility: hidden !important; }`).join('\n');
    style.textContent = css;
    console.log('[RecallFox/EB] Injected CSS for', applicableRules.length, 'rules,', allSelectors.length, 'selectors');
  }

  // v0.8.43: Remove semua CSS & elemen yang sudah di-block (saat toggle OFF)
  function removeAllBlockerTraces() {
    // Hapus CSS style
    const css = document.getElementById('rf-eb-hide-css');
    if (css) css.remove();
    // Hapus popup blocker script
    const popupScript = document.getElementById('rf-eb-popup-blocker');
    if (popupScript) popupScript.remove();
    // v0.8.47: Restore card dewasa yang di-hide via JS
    document.querySelectorAll('[data-rf-eb-adult="1"]').forEach(el => {
      el.style.removeProperty('display');
      delete el.dataset.rfEbAdult;
    });
    console.log('[RecallFox/EB] Removed all blocker traces (toggle OFF)');
  }

  // ===== Remove iframe & script dari domain tracker =====
  // v0.8.46: SAFEGUARD — jangan remove iframe yang besar (>300x200) atau yang ada "embed" di URL
  // (itu kemungkinan video player, bukan iklan)
  function removeBlockedElements(applicableRules) {
    const blockDomains = [];
    for (const rule of applicableRules) {
      if (rule.blockDomains && Array.isArray(rule.blockDomains)) {
        blockDomains.push(...rule.blockDomains);
      }
    }
    if (blockDomains.length === 0) return;

    // Remove iframes — TAPI jangan yang ukurannya besar atau ada "embed"
    const iframes = document.querySelectorAll('iframe');
    let removedCount = 0;
    iframes.forEach(iframe => {
      const src = (iframe.src || '').toLowerCase();
      // v0.8.46: SAFEGUARD — skip iframe yang kemungkinan video player
      if (src.includes('/embed/') || src.includes('player') || src.includes('video')) {
        console.log('[RecallFox/EB] Skipping video player iframe:', src.slice(0, 80));
        return;
      }
      const r = iframe.getBoundingClientRect();
      if (r.width > 300 && r.height > 200) {
        console.log('[RecallFox/EB] Skipping large iframe (probably video):', src.slice(0, 80), r.width + 'x' + r.height);
        return;
      }
      for (const d of blockDomains) {
        if (src.includes(d.toLowerCase())) {
          iframe.remove();
          removedCount++;
          break;
        }
      }
    });

    // Remove scripts (yang sudah loaded — cegah eksekusi future via MutationObserver)
    const scripts = document.querySelectorAll('script[src]');
    scripts.forEach(script => {
      const src = (script.src || '').toLowerCase();
      for (const d of blockDomains) {
        if (src.includes(d.toLowerCase())) {
          script.remove();
          removedCount++;
          break;
        }
      }
    });

    if (removedCount > 0) {
      console.log('[RecallFox/EB] Removed', removedCount, 'blocked elements (iframe/script)');
    }
  }

  // ===== Override window.open di MAIN world untuk block popup =====
  function injectPopupBlocker(applicableRules) {
    const shouldBlock = applicableRules.some(r => r.blockPopups === true);
    if (!shouldBlock) return;

    const scriptId = 'rf-eb-popup-blocker';
    if (document.getElementById(scriptId)) return;

    const script = document.createElement('script');
    script.id = scriptId;
    script.textContent = `
      (function() {
        if (window.__rfPopupBlocked) return;
        window.__rfPopupBlocked = true;
        const origOpen = window.open;
        window.open = function(url, target, features) {
          console.log('[RecallFox/EB] Blocked window.open:', url);
          return null;
        };
        // Block onclick popups via event listener
        document.addEventListener('click', function(e) {
          // Cek apakah target atau ancestor punya onclick yang buka popup
          let el = e.target;
          while (el && el !== document.body) {
            if (el.tagName === 'A' && el.target === '_blank') {
              // Cek href — kalau external ad domain, block
              const href = (el.href || '').toLowerCase();
              const adDomains = ['dtscout', 'histats', 'popads', 'propellerads', 'adsterra', 'doubleclick', 'googlesyndication'];
              if (adDomains.some(d => href.includes(d))) {
                e.preventDefault();
                e.stopPropagation();
                console.log('[RecallFox/EB] Blocked ad click:', href);
                return false;
              }
            }
            el = el.parentElement;
          }
        }, true);
      })();
    `;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
    console.log('[RecallFox/EB] Popup blocker injected');
  }

  // v0.8.47: Hide card berdasarkan text content (JAV, bokep, semi)
  function hideAdultContentCards() {
    const adultKeywords = [
      'jav sub indo', 'jav-sub-indo',
      'bokep', 'bokep indo',
      'jul-', 'fjin-', 'fwtr-', 'fpre-', 'gvh-', 'psk-', 'nnp-', 'stars-',
      ' gangbang', 'cabul', 'pengasuh cabul',
      'montok', 'budak seks', ' PSK ',
      'semi jepang', 'semi indo'
    ];
    const cards = document.querySelectorAll('.item-infinite, .col-md-2');
    let hiddenCount = 0;
    cards.forEach(card => {
      if (card.dataset.rfEbAdult === '1') return;
      if (card.querySelector('iframe')) return;
      const rect = card.getBoundingClientRect();
      if (rect.height > 800) return;
      const text = (card.textContent || '').toLowerCase();
      const hasAdult = adultKeywords.some(kw => text.includes(kw));
      if (hasAdult) {
        card.style.setProperty('display', 'none', 'important');
        card.dataset.rfEbAdult = '1';
        hiddenCount++;
      }
    });
    const menuLinks = document.querySelectorAll('a[href*="/category/jav-sub-indo"], a[href*="/category/bokep-indo"], a[href*="/category/vivamax"]');
    menuLinks.forEach(link => {
      const menuItem = link.closest('.menu-item, li, .cat-item');
      if (menuItem && menuItem.dataset.rfEbAdult !== '1') {
        menuItem.style.setProperty('display', 'none', 'important');
        menuItem.dataset.rfEbAdult = '1';
        hiddenCount++;
      }
    });
    if (hiddenCount > 0) {
      console.log('[RecallFox/EB] Hidden', hiddenCount, 'adult content cards');
    }
  }

  // ===== Main apply function =====
  async function applyRules() {
    const enabled = await isEnabled();
    if (!enabled) {
      removeAllBlockerTraces();
      return;
    }
    const applicable = getApplicableRules();
    if (applicable.length === 0) {
      removeAllBlockerTraces();
      return;
    }

    console.log('[RecallFox/EB] Applying', applicable.length, 'rules for', location.hostname);
    injectHideCSS(applicable);
    removeBlockedElements(applicable);
    injectPopupBlocker(applicable);
    hideAdultContentCards();
  }

  // ===== Pasang MutationObserver untuk catch elemen baru (lazy-load ads) =====
  let observer = null;
  let scanTimer = null;
  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(() => {
      if (scanTimer) return;
      scanTimer = setTimeout(() => {
        scanTimer = null;
        applyRules();
      }, 200);
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
    setInterval(() => {
      applyRules();
    }, 2000);
  }

  // ===== Init =====
  async function init() {
    const enabled = await isEnabled();
    if (!enabled) {
      console.log('[RecallFox/EB] Element Blocker disabled');
      return;
    }
    const ok = await loadRules();
    if (!ok) {
      console.warn('[RecallFox/EB] Failed to load rules');
      return;
    }
    const applicable = getApplicableRules();
    if (applicable.length === 0) return;

    console.log('[RecallFox/EB] Element Blocker aktif untuk', location.hostname, '|', applicable.length, 'rules');
    applyRules();
    startObserver();
  }

  // Listen for messages from popup/background
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'EB_RULES_UPDATED') {
      loadRules().then(() => { applyRules(); });
    }
    if (msg?.type === 'EB_DISABLE') {
      removeAllBlockerTraces();
    }
    // v0.9.0: Handler untuk "Block Element Ini" (context menu — returns last hovered)
    if (msg?.type === 'EB_GET_ELEMENT_FOR_BLOCK') {
      var el = hoveredElement;
      if (!el) {
        var sel = window.getSelection();
        if (sel && sel.anchorNode) {
          el = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
        }
      }
      if (el) {
        var selector = generateSelector(el);
        sendResponse({
          selector: selector,
          tagName: el.tagName,
          id: el.id || '',
          className: (el.className || '').toString().slice(0, 100),
          text: (el.textContent || '').trim().slice(0, 80)
        });
      } else {
        sendResponse({ selector: null });
      }
      return true;  // async response
    }
    // v3.4: Activate visual element picker (from popup "Pilih elemen" button)
    if (msg?.type === 'START_ELEMENT_PICKER') {
      // Track hovered element via mouseover (also used by context menu path)
      activatePicker();
      sendResponse({ ok: true, message: 'Picker activated' });
      return false;
    }
    // v3.4: Cancel picker (e.g. user opened popup again and clicked cancel)
    if (msg?.type === 'CANCEL_ELEMENT_PICKER') {
      deactivatePicker();
      sendResponse({ ok: true });
      return false;
    }
  });

  // Also track hovered element for the legacy context-menu path
  document.addEventListener('mouseover', (e) => {
    hoveredElement = e.target;
  }, true);

  // Deactivate picker if user switches tab/window
  window.addEventListener('blur', function () {
    if (pickerActive) deactivatePicker();
  });

  // Run on DOM ready (atau langsung kalau sudah ready)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
