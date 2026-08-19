// content/selection-ai.js — Floating "Ask AI" button on text selection
// RecallFox v0.8.7
//
// When user selects text on any page, a small floating button appears
// near the selection. One click = send to Si Pandai AI.
// This eliminates the need for right-click → scroll → find menu → click.
//
// CRITICAL LESSON (v0.8.6 → v0.8.7):
//   On SPA apps with contenteditable (WhatsApp Web, Telegram, Discord,
//   Notion, etc.), clicking the floating button used to CLEAR the selection
//   before the click handler ran — because the browser tried to place the
//   caret at the click target. So `window.getSelection().toString()` returned
//   empty string and sendToAI was never called.
//
//   Fix: cache the selection text on mouseup, and call preventDefault on
//   the button's mousedown so the browser doesn't touch the selection.

(function () {
  if (window.__RecallFoxSelectionAI__) return;
  window.__RecallFoxSelectionAI__ = true;

  let popupBtn = null;
  let hideTimer = null;

  // === Cached selection (set on mouseup, used as fallback in click) ===
  // Without this, clicking the button on WhatsApp/Telegram clears the
  // selection before the click handler can read it.
  let cachedSelection = { text: '', rect: null, ts: 0 };

  function updateCachedSelection() {
    try {
      const sel = window.getSelection();
      const text = (sel?.toString() || '').trim();
      if (text.length < 3) return false;
      let rect = null;
      if (sel.rangeCount > 0) {
        try {
          rect = sel.getRangeAt(0).getBoundingClientRect();
        } catch (e) {}
      }
      cachedSelection = { text, rect, ts: Date.now() };
      return true;
    } catch (e) {
      return false;
    }
  }

  // Create the floating button
  function createButton() {
    if (popupBtn) return popupBtn;
    popupBtn = document.createElement('div');
    popupBtn.id = 'recallfox-ai-popup';
    popupBtn.style.cssText = `
      position: fixed;
      z-index: 2147483647;
      display: none;
      align-items: center;
      gap: 4px;
      padding: 6px 12px;
      background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
      color: #fff;
      border: none;
      border-radius: 20px;
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(79, 70, 229, 0.4), 0 2px 6px rgba(0,0,0,0.15);
      transition: transform 150ms ease, opacity 150ms ease;
      user-select: none;
      white-space: nowrap;
      pointer-events: auto;
      -webkit-user-select: none;
    `;
    popupBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
      <span>Tanya Si Pandai</span>
    `;
    document.body.appendChild(popupBtn);

    // ====== mousedown: CRITICAL — preserve the selection ======
    // Without preventDefault, clicking the button on contenteditable
    // surfaces (WhatsApp/Telegram/Discord/Notion) clears the selection
    // before click fires. This is the fix for the v0.8.6 bug where the
    // button visually appeared but the click did nothing.
    popupBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    }, true);

    popupBtn.addEventListener('mouseup', (e) => {
      // Also prevent, in case mousedown alone isn't enough on some platforms
      e.preventDefault();
      e.stopPropagation();
    }, true);

    popupBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleButtonClick();
    });

    // Don't hide when hovering the button
    popupBtn.addEventListener('mouseenter', () => {
      if (hideTimer) clearTimeout(hideTimer);
    });
    popupBtn.addEventListener('mouseleave', () => {
      hideTimer = setTimeout(hideButton, 1500);
    });

    return popupBtn;
  }

  // ====== Click handler — uses cached selection as fallback ======
  // Why fallback: even with preventDefault on mousedown, some sites
  // (especially React-based SPAs with synthetic event systems) may still
  // clear the selection between mousedown and click. The cached text is
  // our safety net.
  function handleButtonClick() {
    let text = '';
    // Try live selection first
    try {
      const live = window.getSelection().toString().trim();
      if (live.length >= 3) text = live;
    } catch (e) {}

    // Fallback to cached selection (set on mouseup)
    if (!text && cachedSelection.text && cachedSelection.ts) {
      // Use cache only if it's recent (< 30s old)
      if (Date.now() - cachedSelection.ts < 30000) {
        text = cachedSelection.text;
        console.log('[RecallFox] Using cached selection (live selection was cleared by click)');
      }
    }

    if (text) {
      console.log('[RecallFox] Button clicked → sending to AI:', text.slice(0, 80) + '...');
      sendToAI(text);
    } else {
      console.warn('[RecallFox] Button clicked but no text available (neither live nor cached)');
      // Flash a brief visual cue so user knows the click registered
      flashEmptyButton();
    }
    hideButton();
  }

  function flashEmptyButton() {
    if (!popupBtn) return;
    const orig = popupBtn.innerHTML;
    popupBtn.innerHTML = `<span>⚠️ Tidak ada teks terseleksi</span>`;
    setTimeout(() => {
      if (popupBtn) popupBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
        <span>Tanya Si Pandai</span>
      `;
    }, 1500);
  }

  function showButton(rect) {
    const btn = createButton();
    // Position above the selection, centered horizontally
    const btnWidth = 140; // estimated
    let left = rect.left + (rect.width / 2) - (btnWidth / 2);
    let top = rect.top - 38;

    // Keep within viewport
    if (left < 8) left = 8;
    if (left + btnWidth > window.innerWidth - 8) left = window.innerWidth - btnWidth - 8;
    if (top < 8) top = rect.bottom + 8; // show below if no room above

    btn.style.left = left + 'px';
    btn.style.top = top + 'px';
    btn.style.display = 'flex';
    btn.style.opacity = '0';
    btn.style.transform = 'translateY(4px)';

    requestAnimationFrame(() => {
      btn.style.opacity = '1';
      btn.style.transform = 'translateY(0)';
    });
  }

  function hideButton() {
    if (popupBtn) {
      popupBtn.style.opacity = '0';
      popupBtn.style.transform = 'translateY(4px)';
      setTimeout(() => {
        if (popupBtn) popupBtn.style.display = 'none';
      }, 150);
    }
  }

  function sendToAI(text) {
    // Send to background — background opens sidebar if closed, then routes
    // the query to the sidebar panel via runtime message + storage pending.
    showSendingFeedback();
    try {
      browser.runtime.sendMessage({
        type: 'AI_ASK_QUERY',
        text,
        sourceUrl: location.href,
        sourceTitle: document.title
      }).then((resp) => {
        console.log('[RecallFox] AI_ASK_QUERY response:', resp);
      }).catch((e) => {
        console.warn('[RecallFox] sendToAI failed:', e);
        hideSendingFeedback();
      });
    } catch (e) {
      // browser.runtime might not be available in some edge cases
      console.error('[RecallFox] runtime.sendMessage threw:', e);
      hideSendingFeedback();
    }
  }

  // Tiny "sending..." pill that replaces the button briefly so user sees feedback
  function showSendingFeedback() {
    if (!popupBtn) return;
    popupBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="animation: rfspin 0.8s linear infinite;"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
      <span>Mengirim...</span>
    `;
    if (!document.getElementById('rf-selection-ai-spinkey')) {
      const s = document.createElement('style');
      s.id = 'rf-selection-ai-spinkey';
      s.textContent = '@keyframes rfspin { to { transform: rotate(360deg); } }';
      document.head.appendChild(s);
    }
  }
  function hideSendingFeedback() {
    if (!popupBtn) return;
    popupBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
      <span>Tanya Si Pandai</span>
    `;
  }

  // ====== Listen for text selection ======
  document.addEventListener('mouseup', () => {
    // Small delay to let selection finalize (some SPAs update selection async)
    setTimeout(() => {
      const selection = window.getSelection();
      const text = selection.toString().trim();
      if (text.length < 3) {
        hideButton();
        return;
      }

      // Get selection position
      let rect = null;
      try {
        if (selection.rangeCount > 0) {
          rect = selection.getRangeAt(0).getBoundingClientRect();
        }
      } catch (e) {
        hideButton();
        return;
      }
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        hideButton();
        return;
      }

      // CACHE the selection NOW — this is the key fix.
      // Click on the button may clear the live selection, but the cached
      // text survives and is used as fallback in handleButtonClick().
      cachedSelection = { text, rect, ts: Date.now() };
      console.log('[RecallFox] Selection cached:', text.slice(0, 60) + '...');

      showButton(rect);
    }, 50);
  });

  // Also listen for selectionchange as an additional cache source.
  // Some apps (Google Docs-like) fire selectionchange but not mouseup.
  document.addEventListener('selectionchange', () => {
    // Throttle — only update cache, don't show button (mouseup does that)
    try {
      const sel = window.getSelection();
      const text = (sel?.toString() || '').trim();
      if (text.length >= 3) {
        let rect = null;
        if (sel.rangeCount > 0) {
          try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch (e) {}
        }
        cachedSelection = { text, rect, ts: Date.now() };
      }
    } catch (e) {}
  });

  // Hide on scroll, click elsewhere, or Escape
  document.addEventListener('mousedown', (e) => {
    if (popupBtn && popupBtn.style.display !== 'none' && !popupBtn.contains(e.target)) {
      hideButton();
    }
  });

  document.addEventListener('scroll', () => {
    hideButton();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideButton();
    }
    // Alt+Shift+A = send selected text to AI (keyboard fallback)
    if (e.altKey && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
      e.preventDefault();
      e.stopPropagation();
      // Try live selection first, then cached
      let text = '';
      try {
        const live = window.getSelection().toString().trim();
        if (live.length >= 3) text = live;
      } catch (e) {}
      if (!text && cachedSelection.text && Date.now() - cachedSelection.ts < 30000) {
        text = cachedSelection.text;
      }
      if (text) {
        console.log('[RecallFox] Alt+Shift+A → sending to AI:', text.slice(0, 80));
        sendToAI(text);
      }
    }
  });

  console.log('[RecallFox] selection-ai.js v0.8.7 loaded');
})();
