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

  // v3.20.46: Universal editor selectors — fallback kalau domain config tidak ada
  // atau selector outdated. Cover ProseMirror/TipTap, contenteditable, textarea.
  const UNIVERSAL_EDITOR_SELECTORS = [
    '.ProseMirror[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][data-testid*="input"]',
    'div[contenteditable="true"]#chat-input',
    'div[contenteditable="true"]',
    'textarea:not([readonly]):not([disabled])',
    'input[type="text"]:not([readonly]):not([disabled])'
  ];

  function getEditor() {
    // Strategy 1: domain config selector
    if (window.__RecallFoxDomainConfig__) {
      const editor = resolveFirst(window.__RecallFoxDomainConfig__.selectors.textarea);
      if (editor) return editor;
    }
    // Strategy 2: universal fallback selectors
    console.log('[RecallFox] getEditor: domain config tidak match, coba universal selectors');
    for (const sel of UNIVERSAL_EDITOR_SELECTORS) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          console.log('[RecallFox] getEditor: found via universal:', sel);
          return el;
        }
      } catch (_) {}
    }
    console.warn('[RecallFox] getEditor: no editor found');
    return null;
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
    let editor = getEditor();

    // v3.20.46: Retry 3x dengan jeda 300ms kalau editor belum ketemu (lazy-load)
    if (!editor) {
      console.log('[RecallFox] injectText: editor belum ada, retry 3x...');
      for (let i = 0; i < 3; i++) {
        await new Promise(r => setTimeout(r, 300));
        editor = getEditor();
        if (editor) break;
      }
    }

    if (!editor) {
      console.warn('[RecallFox] injectText: no editor, fallback to clipboard');
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
        // contenteditable (ProseMirror/TipTap/React)
        // v3.20.46: Focus DULU + small delay supaya ProseMirror siap
        editor.focus();
        await new Promise(r => setTimeout(r, 50));
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
    if (!config) return { body: '', url: location.href, pageTitle: document.title, messageCount: 0, snapshotDomain: location.hostname, snapshotMessageCount: 0, debug: 'No domain config' };

    // v3.16.1 S3: Ekstraksi v2 — dedup ancestor/descendant, preserve code fence, role detection lebih baik
    let allEls = [];
    let matchedSelector = '';
    const userSelectors = config.selectors.userMessage || [];
    const aiSelectors = config.selectors.aiMessage || [];

    // Helper: cek apakah elemA adalah ancestor dari elemB
    function isAncestorOf(elemA, elemB) {
      try { return elemA.contains(elemB); } catch (e) { return false; }
    }

    // Helper: deteksi role dari elemen (lebih akurat dari sebelumnya)
    function detectRole(el) {
      // 1. data-message-author-role (ChatGPT)
      const authorRole = el.getAttribute('data-message-author-role');
      if (authorRole) return authorRole === 'user' ? 'user' : 'ai';
      // 2. data-role
      const dataRole = el.getAttribute('data-role');
      if (dataRole) {
        if (['user', 'human', 'you'].includes(dataRole.toLowerCase())) return 'user';
        if (['assistant', 'ai', 'bot', 'model'].includes(dataRole.toLowerCase())) return 'ai';
      }
      // 3. data-testid
      const testid = (el.getAttribute('data-testid') || '').toLowerCase();
      if (testid.includes('user') || testid.includes('human')) return 'user';
      if (testid.includes('assistant') || testid.includes('ai')) return 'ai';
      // 4. class name
      const cls = (el.className || '').toString().toLowerCase();
      if (cls.includes('user') || cls.includes('human')) return 'user';
      if (cls.includes('assistant') || cls.includes('ai') || cls.includes('bot') || cls.includes('model')) return 'ai';
      // 5. aria-label
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      if (aria.includes('you') || aria.includes('user')) return 'user';
      if (aria.includes('assistant') || aria.includes('ai')) return 'ai';
      return 'unknown';
    }

    // Helper: extract text dengan preserve code fence
    function extractTextWithCode(el) {
      // Clone, hapus script/style
      const clone = el.cloneNode(true);
      clone.querySelectorAll('script, style, button, [aria-hidden="true"]').forEach(e => e.remove());
      // Ganti <pre>/<code> dengan code fence
      const codeBlocks = clone.querySelectorAll('pre');
      let text = clone.innerText || '';
      // Code fence sudah ada di innerText (pre punya newline), tidak perlu transform khusus
      // Tapi tandai kalau ada code block
      return text.trim();
    }

    // Try domain-specific selectors first
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
        '[data-message-author-role]',
        '[data-role="user"]', '[data-role="assistant"]',
        '[data-role="human"]', '[data-role="ai"]',
        '.message-user', '.message-assistant',
        '.user-message', '.assistant-message',
        '.human-message', '.ai-message',
        '.msg-user', '.msg-assistant',
        '[class*="user-message"]', '[class*="assistant-message"]',
        '[class*="UserMessage"]', '[class*="AssistantMessage"]',
        '.chat-message', '.conversation-message',
        '.markdown-body', '.markdown-content',
        '[class*="prose"]',
        '[aria-label*="user" i]', '[aria-label*="assistant" i]',
        '[aria-label*="You" i]', '[aria-label*="AI" i]'
      ];
      for (const sel of genericSelectors) {
        try {
          const els = document.querySelectorAll(sel);
          if (els.length > 0) {
            els.forEach(el => {
              const role = detectRole(el);
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
          if (el.children.length === 0 && el.innerText && el.innerText.trim().length > 20) {
            allEls.push({ el, role: 'unknown' });
            count++;
          }
        });
        matchedSelector += `fallback: text blocks (${count})\n`;
      }
    }

    // v3.16.1 S3: Dedup ancestor/descendant — kalau elemA ancestor dari elemB, hapus ancestor (ambil descendant = lebih spesifik)
    // Sebelumnya: parent + child ikut ter-capture → teks duplikat
    const dedupedEls = [];
    for (let i = 0; i < allEls.length; i++) {
      const a = allEls[i];
      let isAncestor = false;
      for (let j = 0; j < allEls.length; j++) {
        if (i === j) continue;
        const b = allEls[j];
        // Kalau a ancestor dari b, dan b lebih spesifik (innerText lebih pendek) → skip a
        if (isAncestorOf(a.el, b.el) && (b.el.innerText || '').length < (a.el.innerText || '').length) {
          isAncestor = true;
          break;
        }
      }
      if (!isAncestor) dedupedEls.push(a);
    }
    allEls = dedupedEls;

    // sort by DOM order
    allEls.sort((a, b) => {
      if (a.el === b.el) return 0;
      const rel = a.el.compareDocumentPosition(b.el);
      if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    // take last 50
    const MAX_MSGS = 50;
    const totalMsgs = allEls.length;
    const sliced = allEls.slice(-MAX_MSGS);

    let body = '';
    for (const item of sliced) {
      const roleLabel = item.role === 'user' ? '👤 User' : item.role === 'ai' ? '🤖 AI' : '💬';
      // v3.16.1 S3: pakai extractTextWithCode untuk preserve code fence
      const text = extractTextWithCode(item.el);
      if (!text || text.length < 2) continue;
      const truncated = text.length > 2000 ? text.slice(0, 2000) + '...[truncated]' : text;
      body += `${roleLabel}:\n${truncated}\n\n`;
    }
    body = body.trim();

    return {
      body,
      url: location.href,
      pageTitle: document.title,
      messageCount: sliced.length,
      // v3.15.0 P0-S1: tambah snapshotDomain + snapshotMessageCount (key benar)
      // Sebelumnya hanya return messageCount (key salah — harusnya snapshotMessageCount).
      // background.js CAPTURE_SNAPSHOT sekarang baca snapshotMessageCount + snapshotDomain.
      snapshotDomain: location.hostname,
      snapshotMessageCount: sliced.length,
      debug: matchedSelector || 'No selectors matched'
    };
  }

  // ===== Snapshot Modal =====
  async function openSnapshotModal() {
    // v3.16.2: Pakai async isAIPage() dari storage.aiSites (single source of truth)
    const isAI = window.__recallfoxIsAIPage__ ? await window.__recallfoxIsAIPage__() : !!window.__RecallFoxIsAIDomain__;
    if (!isAI) {
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
    // v3.20.1: select-all supaya nama default langsung terblok — user bisa langsung
    //   ketik untuk timpa tanpa perlu blok manual + delete.
    //   User: "nama file ketika di pencet itu dalam kondisi terblok, sehingga bisa
    //   langsung di rename/ ditimpa untuk diberi nama baru."
    setTimeout(() => {
      const titleInput = modal.querySelector('#rf-snap-title');
      if (titleInput) {
        titleInput.focus();
        titleInput.select();
      }
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

  // ===== Floating button — DIHAPUS v3.16.1 =====
  // User feedback: "jangan pernah bikin tombol floating snapshot maupun konteks, karena ganggu"
  // Snapshot sekarang hanya via quick action tile di popup/sidebar (snapshotFlow).
  // Fungsi ini di-keep sebagai no-op supaya call sites tidak error, tapi tidak inject apa-apa.
  async function maybeInjectFloatingButton() {
    return; // no-op — floating button disabled permanently
  }


  // v3.20.21: Helper to copy text to clipboard in content script context.
  // Port dari Chrome v3.21.6 (commit 7b8eef1) supaya parity antara Firefox & Chrome.
  // Uses a hidden textarea + execCommand('copy') as fallback to navigator.clipboard.
  // Penting untuk popout sidebar (iframe ke sidebar.html) — navigator.clipboard
  // bisa gagal di iframe yang tidak focused atau cross-origin.
  async function copyTextToClipboard(text) {
    if (!text) return;
    try {
      // Try modern clipboard API first
      await navigator.clipboard.writeText(text);
    } catch (e) {
      // Fallback: textarea + execCommand('copy')
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';  // Avoid scrolling to bottom
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
      } catch (e2) {
        throw new Error('Gagal salin: ' + e2.message);
      } finally {
        document.body.removeChild(textarea);
      }
    }
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
    } else if (msg.type === 'EXTRACT_SNAPSHOT') {
      // v3.16.1: Extract conversation data tanpa buka modal di tab.
      // Popup yang handle modal preview (lebih reliable — user pasti lihat di sidebar).
      // Sebelumnya: QUICK_SNAPSHOT → OPEN_SNAPSHOT_MODAL di tab, tapi popup close terlalu cepat
      // → user tidak lihat modal → kira snapshot gagal.
      // v3.16.2: Pakai async isAIPage() dari storage.aiSites (single source of truth)
      (async () => {
        try {
          const isAI = window.__recallfoxIsAIPage__ ? await window.__recallfoxIsAIPage__() : !!window.__RecallFoxIsAIDomain__;
          if (!isAI) {
            sendResponse({ ok: false, error: 'not_ai_domain' });
            return;
          }
          const conv = extractConversation();
          sendResponse({
            ok: true,
            body: conv?.body || '',
            pageTitle: conv?.pageTitle || document.title || '',
            url: conv?.url || location.href,
            snapshotDomain: conv?.snapshotDomain || location.hostname,
            snapshotMessageCount: conv?.snapshotMessageCount || conv?.messageCount || 0,
            debug: conv?.debug || ''
          });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;  // async response
    } else if (msg.type === 'PING') {
      sendResponse({
        ok: true,
        isAIDomain: window.__RecallFoxIsAIDomain__,
        domainId: window.__RecallFoxDomainConfig__?.id
      });
    } else if (msg.type === 'COPY_TEXT') {
      // v3.20.21: Fallback copy to clipboard via content script (document has focus)
      // Port dari Chrome v3.21.6. Used when popup/sidebar (iframe) clipboard APIs fail.
      // Root cause: navigator.clipboard.writeText di iframe popout sidebar bisa gagal
      // karena iframe tidak focused atau Permissions Policy clipboard-write disallow.
      // Content script di top-level page selalu punya focus → lebih reliable.
      (async () => {
        try {
          await copyTextToClipboard(msg.text || '');
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;  // async
    } else if (msg.type === 'GET_PAGE_CONTEXT') {
      // v3.8.1 (Issue #4): Handler untuk "Ambil dari halaman aktif" di popup Konteks.
      // v3.16.0 K3: Ekstraksi halaman BERSIH — buang nav/aside/footer/script/style/
      //   form/button/iframe/svg. Skoring paragraf (prioritas <p> dan <article>).
      //   Sebelumnya: pakai main.innerText mentah → nav, sidebar, footer, banner ikut masuk.
      try {
        // v3.16.0 K3: Clone body, hapus elemen noise, lalu extract text
        const bodyClone = document.body.cloneNode(true);
        // Hapus elemen yang tidak relevan untuk konteks AI
        const noiseSelectors = [
          'nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript',
          'iframe', 'svg', 'canvas', 'form', 'button', 'input', 'select', 'textarea',
          '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
          '[role="search"]', '[aria-hidden="true"]',
          '.nav', '.navbar', '.menu', '.sidebar', '.footer', '.header',
          '.cookie', '.banner', '.popup', '.modal', '.overlay',
          '.advertisement', '.ads', '.ad', '.sponsor',
          '.social', '.share', '.comment', '.comments',
          '.breadcrumb', '.pagination', '.related', '.recommended',
          '[class*="cookie" i]', '[class*="banner" i]', '[class*="popup" i]',
          '[class*="modal" i]', '[class*="overlay" i]', '[class*="advert" i]',
          '[id*="cookie" i]', '[id*="banner" i]', '[id*="popup" i]'
        ];
        for (const sel of noiseSelectors) {
          bodyClone.querySelectorAll(sel).forEach(el => el.remove());
        }
        // Skoring paragraf: prioritas <p>, <article>, <section>, <main>, <div role="main">
        let main = bodyClone.querySelector('main')
                || bodyClone.querySelector('[role="main"]')
                || bodyClone.querySelector('article')
                || bodyClone.querySelector('article[class]')
                || bodyClone;
        // v3.16.0 K4: Dedup by URL — cek apakah URL ini sudah pernah di-ambil.
        // Cek localStorage key 'recallfox_page_context_urls' (array of {url, ts}).
        // Kalau URL sama diambil <60 detik lalu, beri warning (tapi tetap return text).
        const urlKey = 'recallfox_page_context_urls';
        let urlHistory = [];
        try { urlHistory = JSON.parse(localStorage.getItem(urlKey) || '[]'); } catch (e) {}
        const now = Date.now();
        const recent = urlHistory.filter(h => h.url === location.href && (now - h.ts) < 60000);
        const isDuplicate = recent.length > 0;
        // Update history (keep last 20)
        urlHistory = urlHistory.filter(h => (now - h.ts) < 7 * 24 * 60 * 60 * 1000); // 7 hari
        urlHistory.push({ url: location.href, ts: now, title: document.title || '' });
        urlHistory = urlHistory.slice(-20);
        try { localStorage.setItem(urlKey, JSON.stringify(urlHistory)); } catch (e) {}

        let text = (main?.innerText || '').trim();
        // Bersihkan whitespace berlebih
        text = text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
        // Ambil meta description untuk konteks tambahan
        const metaDesc = document.querySelector('meta[name="description"]')?.content || '';
        const ogDesc = document.querySelector('meta[property="og:description"]')?.content || '';
        const desc = (metaDesc || ogDesc || '').trim();
        // Ambil selection text (kalau user blok teks tertentu)
        const sel = (window.getSelection()?.toString() || '').trim();
        // Batasi panjang (8000 char ~ 1500 kata)
        const maxLen = msg.maxLen || 8000;
        if (text.length > maxLen) text = text.slice(0, maxLen) + '\n\n[... dipotong, total ' + text.length + ' char]';
        sendResponse({
          ok: true,
          text: text,
          title: document.title || '',
          url: location.href,
          description: desc,
          selection: sel,
          isDuplicate: isDuplicate, // v3.16.0 K4: flag untuk UI warning
          meta: {
            wordCount: text ? text.split(/\s+/).length : 0,
            charCount: text.length,
            hasMain: !!document.querySelector('main'),
            hasArticle: !!document.querySelector('article')
          }
        });
      } catch (e) {
        console.warn('[RecallFox] GET_PAGE_CONTEXT error:', e);
        sendResponse({ ok: false, error: e.message, text: '', title: document.title || '', url: location.href });
      }
      return true; // async-safe
    }
  });

  // Keyboard shortcuts removed — 0 shortcut, all via click (FAB/pill/popup)
  // Previous Digit2/3 handlers deleted for click-only UX.

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
