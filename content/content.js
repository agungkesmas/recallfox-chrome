// content/content.js — Inject text ke AI textarea + toast + snapshot modal trigger
// RecallFox v0.1.0

(function () {
  // Avoid double-inject
  if (window.__RecallFoxContentLoaded__) return;
  window.__RecallFoxContentLoaded__ = true;

  // ===== Toast =====
  function showToast(messageKey, actionLabel, onAction) {
    const msg = browser.i18n.getMessage(messageKey) || messageKey;
    let toast = document.getElementById('recallfox-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'recallfox-toast';
      toast.className = 'recallfox-toast';
      document.body.appendChild(toast);
    }
    toast.innerHTML = '';
    const check = document.createElement('span');
    check.className = 'recallfox-toast-check';
    check.textContent = '✓';
    const text = document.createElement('span');
    text.textContent = msg;
    toast.appendChild(check);
    toast.appendChild(text);
    if (actionLabel && onAction) {
      const btn = document.createElement('button');
      btn.className = 'recallfox-toast-btn';
      btn.textContent = actionLabel;
      btn.addEventListener('click', () => {
        onAction();
        hideToast();
      });
      toast.appendChild(btn);
    }
    toast.classList.add('recallfox-toast-show');
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(hideToast, 3500);
  }
  function hideToast() {
    const toast = document.getElementById('recallfox-toast');
    if (toast) toast.classList.remove('recallfox-toast-show');
  }

  // ===== Resolve textarea/send button using domain config =====
  function resolveFirst(selectorList) {
    for (const sel of selectorList) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function getEditor() {
    if (!window.__RecallFoxDomainConfig__) return null;
    return resolveFirst(window.__RecallFoxDomainConfig__.selectors.textarea);
  }

  function getSendButton() {
    if (!window.__RecallFoxDomainConfig__) return null;
    return resolveFirst(window.__RecallFoxDomainConfig__.selectors.sendButton);
  }

  // ===== Inject text =====
  // Tries multiple strategies:
  //   1. textarea: set value + dispatch input event
  //   2. contenteditable: execCommand('insertText') via InputEvent
  //   3. fallback: clipboard
  async function injectText(text, mode = 'append') {
    const editor = getEditor();
    if (!editor) {
      await copyToClipboard(text);
      showToast('toastInjectFailed');
      return { ok: false, fallback: 'clipboard' };
    }

    const isTextarea = editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT';

    try {
      if (isTextarea) {
        const cur = editor.value || '';
        let next;
        if (mode === 'replace') {
          next = text;
        } else if (mode === 'prepend') {
          next = text + (cur ? '\n\n---\n\n' + cur : '');
        } else {
          next = cur ? cur + '\n\n---\n\n' + text : text;
        }
        // use native setter to bypass React
        const proto = editor.tagName === 'TEXTAREA'
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(editor, next);
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // contenteditable
        editor.focus();
        if (mode === 'replace') {
          // select all then replace
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(editor);
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('delete');
        } else {
          // move cursor to end (append) or beginning (prepend)
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(editor);
          if (mode === 'prepend') {
            range.collapse(true); // start
          } else {
            range.collapse(false); // end
          }
          sel.removeAllRanges();
          sel.addRange(range);
          if (mode === 'append') {
            document.execCommand('insertText', false, '\n\n---\n\n');
          }
        }
        // insert text via execCommand (works with React/ProseMirror)
        document.execCommand('insertText', false, text);
        if (mode === 'prepend') {
          document.execCommand('insertText', false, '\n\n---\n\n');
        }
      }
      showToast('toastInjected');
      return { ok: true };
    } catch (e) {
      console.warn('[RecallFox] inject failed, fallback to clipboard:', e);
      await copyToClipboard(text);
      showToast('toastInjectFailed');
      return { ok: false, fallback: 'clipboard', error: e.message };
    }
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // fallback: hidden textarea
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e2) {}
      ta.remove();
      return true;
    }
  }

  // ===== Snapshot extraction =====
  function extractConversation() {
    const config = window.__RecallFoxDomainConfig__;
    if (!config) return { body: '', url: location.href, pageTitle: document.title, messageCount: 0, debug: 'No domain config' };

    // Try domain-specific selectors first
    let allEls = [];
    let matchedSelector = '';
    const userSelectors = config.selectors.userMessage || [];
    const aiSelectors = config.selectors.aiMessage || [];

    for (const sel of userSelectors) {
      try {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          els.forEach(el => allEls.push({ el, role: 'user' }));
          matchedSelector += `user: ${sel} (${els.length})\n`;
          break;
        }
      } catch (e) {}
    }
    const seen = new Set(allEls.map(x => x.el));
    for (const sel of aiSelectors) {
      try {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          els.forEach(el => {
            if (!seen.has(el)) {
              allEls.push({ el, role: 'ai' });
              seen.add(el);
            }
          });
          matchedSelector += `ai: ${sel} (${els.length})\n`;
          break;
        }
      } catch (e) {}
    }

    // Fallback: if no messages found, try generic selectors
    if (allEls.length === 0) {
      const genericSelectors = [
        // ChatGPT-like patterns
        '[data-message-author-role]',
        '[data-role="user"]', '[data-role="assistant"]',
        '[data-role="human"]', '[data-role="ai"]',
        '.message-user', '.message-assistant',
        '.user-message', '.assistant-message',
        '.human-message', '.ai-message',
        '.msg-user', '.msg-assistant',
        '[class*="user-message"]', '[class*="assistant-message"]',
        '[class*="UserMessage"]', '[class*="AssistantMessage"]',
        // z.ai / ChatGLM patterns
        '.chat-message', '.conversation-message',
        // Generic markdown content (often AI responses)
        '.markdown-body', '.markdown-content',
        '[class*="prose"]',
        // Role-based
        '[aria-label*="user" i]', '[aria-label*="assistant" i]',
        '[aria-label*="You" i]', '[aria-label*="AI" i]'
      ];
      for (const sel of genericSelectors) {
        try {
          const els = document.querySelectorAll(sel);
          if (els.length > 0) {
            // Try to infer role from class/attributes
            els.forEach(el => {
              const cls = (el.className || '').toString().toLowerCase();
              const aria = (el.getAttribute('aria-label') || '').toLowerCase();
              const role = (cls.includes('user') || cls.includes('human') || aria.includes('you') || aria.includes('user')) ? 'user' : 'ai';
              if (!seen.has(el)) {
                allEls.push({ el, role });
                seen.add(el);
              }
            });
            matchedSelector += `generic: ${sel} (${els.length})\n`;
            if (allEls.length >= 2) break;
          }
        } catch (e) {}
      }
    }

    // Last resort: if still nothing, grab all paragraph/div text in main content area
    if (allEls.length === 0) {
      const mainContent = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
      if (mainContent) {
        const textBlocks = mainContent.querySelectorAll('p, div, article');
        let count = 0;
        textBlocks.forEach(el => {
          // Only leaf-like elements with substantial text
          if (el.children.length === 0 && el.innerText && el.innerText.trim().length > 20) {
            allEls.push({ el, role: 'unknown' });
            count++;
          }
        });
        matchedSelector += `fallback: text blocks (${count})\n`;
      }
    }

    // sort by DOM order
    allEls.sort((a, b) => {
      if (a.el === b.el) return 0;
      const rel = a.el.compareDocumentPosition(b.el);
      if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    // take last 50
    const sliced = allEls.slice(-50);

    let body = '';
    for (const item of sliced) {
      const roleLabel = item.role === 'user' ? '👤 User' : item.role === 'ai' ? '🤖 AI' : '💬';
      const text = (item.el.innerText || '').trim();
      if (!text || text.length < 2) continue;
      // Skip if text is too long (likely a container, not a message)
      const truncated = text.length > 2000 ? text.slice(0, 2000) + '...[truncated]' : text;
      body += `${roleLabel}:\n${truncated}\n\n`;
    }
    body = body.trim();

    return {
      body,
      url: location.href,
      pageTitle: document.title,
      messageCount: sliced.length,
      debug: matchedSelector || 'No selectors matched'
    };
  }

  // ===== Snapshot Modal =====
  function openSnapshotModal() {
    if (!window.__RecallFoxIsAIDomain__) {
      showToast('errNotAIDomain');
      return;
    }
    const conv = extractConversation();

    let modal = document.getElementById('recallfox-snapshot-modal');
    if (modal) modal.remove();

    modal = document.createElement('div');
    modal.id = 'recallfox-snapshot-modal';
    modal.className = 'recallfox-modal-overlay';

    const hasContent = conv && conv.body && conv.body.length > 0;
    const summary = hasContent
      ? (conv.body.slice(0, 400) + (conv.body.length > 400 ? '...' : ''))
      : '(Tidak ada percakapan terdeteksi. Coba pastikan ada pesan di halaman, atau halaman ini mungkin tidak didukung snapshot.)';
    const titleGuess = (conv?.pageTitle || document.title || 'Snapshot ' + new Date().toLocaleString()).slice(0, 80);
    const msgCount = conv?.messageCount || 0;

    modal.innerHTML = `
      <div class="recallfox-modal recallfx-modal-wide">
        <div class="recallfox-modal-header">
          <span class="recallfox-modal-icon">📸</span>
          <h2>${escapeHtml(browser.i18n.getMessage('snapshotTitle'))}</h2>
          <button class="recallfox-modal-close" title="${escapeHtml(browser.i18n.getMessage('cancel'))}">×</button>
        </div>
        <div class="recallfox-modal-body">
          <div class="recallfox-field">
            <label>${escapeHtml(browser.i18n.getMessage('snapshotSource'))}</label>
            <div class="recallfox-snapshot-source">${escapeHtml(conv?.pageTitle || document.title)} <span class="recallfox-meta">${msgCount} pesan</span></div>
          </div>
          <div class="recallfox-field">
            <label>${escapeHtml(browser.i18n.getMessage('fieldTitle'))}</label>
            <input type="text" id="rf-snap-title" value="${escapeHtmlAttr(titleGuess)}" />
          </div>
          <div class="recallfox-field">
            <label>${escapeHtml(browser.i18n.getMessage('fieldTags'))}</label>
            <input type="text" id="rf-snap-tags" placeholder="tag1, tag2" />
          </div>
          <div class="recallfox-field">
            <label>${escapeHtml(browser.i18n.getMessage('snapshotAutoSummary'))}</label>
            <div class="recallfox-snapshot-preview">${escapeHtml(summary)}</div>
          </div>
          <div class="recallfox-field">
            <label>${escapeHtml(browser.i18n.getMessage('snapshotNote'))}</label>
            <textarea id="rf-snap-note" rows="2"></textarea>
          </div>
          <details style="margin-top:8px;font-size:11px;color:#9ca3af;">
            <summary style="cursor:pointer;color:#6b7280;">Debug info</summary>
            <pre style="margin-top:6px;padding:8px;background:#f5f5f4;border-radius:4px;font-size:10px;white-space:pre-wrap;">${escapeHtml(conv?.debug || 'No debug info')}</pre>
          </details>
        </div>
        <div class="recallfox-modal-footer">
          <button class="recallfox-btn recallfox-btn-ghost" id="rf-snap-cancel">${escapeHtml(browser.i18n.getMessage('cancel'))}</button>
          <button class="recallfox-btn recallfox-btn-primary" id="rf-snap-save" ${hasContent ? '' : 'disabled style="opacity:0.5;cursor:not-allowed;"'}>${escapeHtml(browser.i18n.getMessage('snapshotSaveBtn'))}</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector('.recallfox-modal-close').addEventListener('click', close);
    modal.querySelector('#rf-snap-cancel').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    // Close on Escape
    const escHandler = (e) => {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); }
    };
    document.addEventListener('keydown', escHandler);

    if (hasContent) {
      modal.querySelector('#rf-snap-save').addEventListener('click', async () => {
        const title = modal.querySelector('#rf-snap-title').value.trim() || titleGuess;
        const tagsRaw = modal.querySelector('#rf-snap-tags').value.trim();
        const tags = tagsRaw ? tagsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
        const note = modal.querySelector('#rf-snap-note').value.trim();
        const finalBody = note ? `Catatan: ${note}\n\n${conv.body}` : conv.body;

        await browser.runtime.sendMessage({
          type: 'CAPTURE_SNAPSHOT',
          title,
          body: finalBody,
          tags,
          url: conv.url,
          pageTitle: conv.pageTitle
        });
        close();
        showToast('toastSaved');
      });
    }

    // Focus title input for quick editing
    setTimeout(() => {
      const titleInput = modal.querySelector('#rf-snap-title');
      if (titleInput) titleInput.focus();
    }, 50);
  }

  function escapeHtml(s) {
    return (s || '').toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function escapeHtmlAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
  }

  // ===== Floating button (only on AI domains) =====
  async function maybeInjectFloatingButton() {
    if (!window.__RecallFoxIsAIDomain__) return;
    // check setting via runtime message
    let floatingEnabled = true;
    try {
      const vault = await browser.runtime.sendMessage({ type: 'GET_VAULT' });
      floatingEnabled = vault?.settings?.floatingButtonEnabled !== false;
    } catch (e) { /* default true */ }

    if (!floatingEnabled) return;
    if (document.getElementById('recallfox-floating-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'recallfox-floating-btn';
    btn.className = 'recallfox-floating-btn';
    btn.title = browser.i18n.getMessage('snapshotTitle');
    btn.textContent = '📸';
    btn.type = 'button';
    document.body.appendChild(btn);

    // Click handler — opens snapshot modal (unless this was a drag)
    btn.addEventListener('click', (e) => {
      // If we just dragged, suppress
      if (btn._suppressClick) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      // Visual feedback: pulse
      btn.style.transform = 'scale(0.9)';
      setTimeout(() => { btn.style.transform = ''; }, 120);
      // Open snapshot modal
      openSnapshotModal();
    });

    // Draggable using setPointerCapture (industry-standard, reliable drag)
    // Pointer capture ensures move events keep flowing to this button even
    // when the cursor leaves it. Much more reliable than window.addEventListener.
    let dragState = null;

    // Position persistence (per-device, per-domain)
    const SNAP_POS_KEY = 'recallfox_snap_btn_pos';
    try {
      const saved = localStorage.getItem(SNAP_POS_KEY);
      if (saved) {
        const p = JSON.parse(saved);
        if (typeof p.left === 'number' && typeof p.top === 'number') {
          btn.style.right = 'auto';
          btn.style.bottom = 'auto';
          btn.style.left = p.left + 'px';
          btn.style.top = p.top + 'px';
        }
      }
    } catch (e) {}

    function saveSnapPos(left, top) {
      try {
        const w = btn.offsetWidth || 44;
        const h = btn.offsetHeight || 44;
        const clampedLeft = Math.max(8, Math.min(window.innerWidth - w - 8, left));
        const clampedTop = Math.max(8, Math.min(window.innerHeight - h - 8, top));
        localStorage.setItem(SNAP_POS_KEY, JSON.stringify({ left: clampedLeft, top: clampedTop }));
      } catch (e) {}
    }

    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; // only left click
      const rect = btn.getBoundingClientRect();
      dragState = {
        startX: e.clientX,
        startY: e.clientY,
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
        moved: false,
        pointerId: e.pointerId
      };
      // Capture pointer so move events keep flowing to this button
      try { btn.setPointerCapture(e.pointerId); } catch (err) {}
    });
    btn.addEventListener('pointermove', (e) => {
      if (!dragState) return;
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 5) {
        dragState.moved = true;
        btn.classList.add('recallfox-floating-btn-dragging');
        btn.style.right = 'auto';
        btn.style.bottom = 'auto';
        // Clamp to viewport so button stays accessible
        const w = btn.offsetWidth;
        const h = btn.offsetHeight;
        const left = Math.max(8, Math.min(window.innerWidth - w - 8, e.clientX - dragState.offsetX));
        const top = Math.max(8, Math.min(window.innerHeight - h - 8, e.clientY - dragState.offsetY));
        btn.style.left = left + 'px';
        btn.style.top = top + 'px';
        btn.style.cursor = 'grabbing';
      }
    });
    btn.addEventListener('pointerup', (e) => {
      if (!dragState) return;
      try { btn.releasePointerCapture(dragState.pointerId); } catch (err) {}
      btn.classList.remove('recallfox-floating-btn-dragging');
      btn.style.cursor = '';
      // If we dragged, suppress the upcoming click event + persist position
      if (dragState.moved) {
        btn._suppressClick = true;
        setTimeout(() => { btn._suppressClick = false; }, 50);
        const rect = btn.getBoundingClientRect();
        saveSnapPos(rect.left, rect.top);
        // Brief visual confirmation
        btn.style.transform = 'scale(1.1)';
        setTimeout(() => { btn.style.transform = ''; }, 200);
      }
      setTimeout(() => { dragState = null; }, 10);
    });
    btn.addEventListener('pointercancel', () => {
      if (dragState) {
        btn.classList.remove('recallfox-floating-btn-dragging');
        btn.style.cursor = '';
        dragState = null;
      }
    });
  }

  // ===== Message handlers =====
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'SHOW_TOAST') {
      showToast(msg.message || 'toastSaved');
      sendResponse({ ok: true });
    } else if (msg.type === 'INJECT_TEXT') {
      injectText(msg.text, msg.mode).then(res => sendResponse(res));
      return true; // async
    } else if (msg.type === 'OPEN_SNAPSHOT_MODAL') {
      openSnapshotModal();
      sendResponse({ ok: true });
    } else if (msg.type === 'PING') {
      sendResponse({
        ok: true,
        isAIDomain: window.__RecallFoxIsAIDomain__,
        domainId: window.__RecallFoxDomainConfig__?.id
      });
    }
  });

  // ===== Content-script keyboard shortcuts (NO native commands API, NO Cmd) =====
  // Pattern: 2 modifiers from {Control, Option/Alt, Shift} + number 1/2/3
  // Works on Mac (Firefox) and Windows/Linux.
  // NO Cmd/metaKey — only Control, Option, Shift.

  function showBigFlash(message, color) {
    let flash = document.getElementById('recallfox-flash');
    if (!flash) {
      flash = document.createElement('div');
      flash.style.cssText = `
        position: fixed; top: 50%; left: 50%;
        transform: translate(-50%, -50%) scale(0.9);
        background: ${color || '#1a1a1a'};
        color: #fff; padding: 20px 32px;
        border-radius: 14px; font-size: 18px; font-weight: 700;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        box-shadow: 0 12px 40px rgba(0,0,0,0.4);
        z-index: 2147483647; pointer-events: none;
        opacity: 0; transition: opacity 200ms ease, transform 200ms ease;
        text-align: center; max-width: 360px; white-space: pre-line;
      `;
      flash.id = 'recallfox-flash';
      document.body.appendChild(flash);
    }
    flash.textContent = message;
    flash.style.background = color || '#1a1a1a';
    requestAnimationFrame(() => {
      flash.style.opacity = '1';
      flash.style.transform = 'translate(-50%, -50%) scale(1)';
    });
    clearTimeout(flash._hideTimer);
    flash._hideTimer = setTimeout(() => {
      flash.style.opacity = '0';
      flash.style.transform = 'translate(-50%, -50%) scale(0.9)';
    }, 1500);
  }

  function triggerSidebar() {
    showBigFlash('🦊 Sidebar toggle...', '#4f46e5');
    // Try to toggle sidebar directly from content script context
    // (preserves user gesture from keydown event)
    // Firefox doesn't allow sidebarAction from runtime.sendMessage context,
    // but content script keydown handler counts as user input handler.
    try {
      if (browser.sidebarAction && browser.sidebarAction.toggle) {
        // Firefox 124+: toggle() method
        browser.sidebarAction.toggle();
        showBigFlash('🦊 Sidebar ditoggle', '#4f46e5');
        console.log('[RecallFox] Sidebar toggled via sidebarAction.toggle()');
        return;
      }
    } catch (e) {
      console.log('[RecallFox] sidebarAction.toggle() failed:', e.message);
    }
    
    // Fallback: try open/close via background message
    // (may fail with "only called from user input handler")
    browser.runtime.sendMessage({ type: 'OPEN_SIDEBAR' }).then((res) => {
      console.log('[RecallFox] Sidebar response:', res);
      if (res && res.ok) {
        showBigFlash(res.action === 'closed' ? '🦊 Sidebar ditutup' : '🦊 Sidebar dibuka', '#4f46e5');
      } else {
        const err = (res && res.error) || 'unknown error';
        console.error('[RecallFox] Sidebar error:', err);
        // Last resort: tell user to click toolbar icon
        showBigFlash('⚠️ Tekan tombol RecallFox (🦊) di toolbar Firefox untuk buka sidebar', '#dc2626');
      }
    }).catch((e) => {
      console.error('[RecallFox] Sidebar message failed:', e);
      showBigFlash('⚠️ Tekan tombol RecallFox (🦊) di toolbar Firefox untuk buka sidebar', '#dc2626');
    });
  }

  function triggerSaveSelection() {
    const text = window.getSelection().toString().trim();
    if (text) {
      showBigFlash('💾 Menyimpan teks...', '#059669');
      browser.runtime.sendMessage({
        type: 'SAVE_SELECTION_FROM_CS',
        text: text,
        url: location.href,
        title: document.title
      }).then(() => {
        setTimeout(() => showBigFlash('✓ Tersimpan ke vault', '#059669'), 200);
      }).catch(() => {
        showBigFlash('⚠️ Gagal simpan', '#dc2626');
      });
    } else {
      showBigFlash('⚠️ Tidak ada teks terseleksi', '#dc2626');
    }
  }

  function triggerSnapshot() {
    showBigFlash('📸 Membuka snapshot...', '#7c3aed');
    openSnapshotModal();
  }

  function handleRecallFoxShortcut(e) {
    // Only use Control, Option/Alt, Shift — NO Cmd/metaKey
    const ctrlKey = e.ctrlKey;
    const optKey = e.altKey;   // Option on Mac = Alt
    const shiftKey = e.shiftKey;

    const activeMods = (ctrlKey ? 1 : 0) + (optKey ? 1 : 0) + (shiftKey ? 1 : 0);

    // DEBUG log — shows what Firefox actually sees
    if (activeMods >= 1) {
      const modNames = [];
      if (ctrlKey) modNames.push('Ctrl');
      if (optKey) modNames.push('Option');
      if (shiftKey) modNames.push('Shift');
      console.log('[RecallFox] key:', e.key, '| code:', e.code, '| mods:', modNames.join('+'), '| count:', activeMods);
    }

    // Must be EXACTLY 2 modifiers
    if (activeMods !== 2) return;

    // CRITICAL FIX: On Mac, Option key changes the character produced.
    // So we use e.code (physical key) instead of e.key (character produced)
    const code = e.code;
    let action = null;
    // NOTE: Digit1 (sidebar) is handled by native Firefox _execute_sidebar_action command.
    // Content script only handles 2 (save) and 3 (snapshot).
    if (code === 'Digit2' || code === 'Numpad2') action = 'save';
    else if (code === 'Digit3' || code === 'Numpad3') action = 'snapshot';
    
    if (!action) return;

    e.preventDefault();
    e.stopPropagation();
    console.log('[RecallFox] → Action:', action);

    if (action === 'sidebar') {
      triggerSidebar();
    } else if (action === 'save') {
      triggerSaveSelection();
    } else if (action === 'snapshot') {
      triggerSnapshot();
    }
  }

  window.addEventListener('keydown', handleRecallFoxShortcut, true);
  document.addEventListener('keydown', handleRecallFoxShortcut, true);
  if (document.documentElement) {
    document.documentElement.addEventListener('keydown', handleRecallFoxShortcut, true);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      document.documentElement.addEventListener('keydown', handleRecallFoxShortcut, true);
    });
  }

  // v3.4: Welcome flash dihapus — pintasan keyboard sudah ada di menu
  // "Alat → Pintasan Keyboard" yang bisa dibuka kapan saja. Toast welcome
  // mengganggu dan hanya berisi info yang bisa diakses lewat menu.

  // Init floating button after DOM ready
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(maybeInjectFloatingButton, 500);
  } else {
    document.addEventListener('DOMContentLoaded', () => setTimeout(maybeInjectFloatingButton, 500));
  }

  // Re-inject floating button if SPA navigates
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(maybeInjectFloatingButton, 800);
    }
  }).observe(document.body, { childList: true, subtree: true });

  console.log('[RecallFox] content script loaded on', window.__RecallFoxDomainConfig__?.name || 'unsupported domain');
})();
