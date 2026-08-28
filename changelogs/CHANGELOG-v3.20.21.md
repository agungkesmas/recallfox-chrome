# RecallFox v3.20.21 — Fix: Tombol "Salin" Tidak Berfungsi di Popout Sidebar

**Release date:** 2026-08-03
**Tag:** `v3.20.21` (bug fix — parity dengan Chrome v3.21.6 / commit 7b8eef1)
**Manifest version bump:** `3.20.20` → `3.20.21`

## TL;DR

Bug: tombol "Salin" di popout sidebar (item vault Link/Note/Bundle) tidak
berfungsi atau gagal diam-diam (no toast, no clipboard update). User report
via handover report dari agent sebelumnya:

> "Perbaiki fungsi salin pada tombol 'Salin' di dalam popout sidebar...
> Terapkan perbaikan kode dan lakukan live testing dengan mengeklik tombol
> 'Salin' baik pada daftar vault langsung maupun setelah melalui hasil filter
> pencarian."

Root cause: `navigator.clipboard.writeText` di iframe `sidebar.html` (popout
sidebar) bisa gagal karena:
- iframe tidak focused saat tombol diklik
- Permissions Policy `clipboard-write` disallow di iframe cross-origin
- Firefox security policy yang lebih ketat untuk clipboard API di iframe

Fix: tambah **4-level fallback chain** untuk clipboard operation, port dari
Chrome v3.21.6 (commit `7b8eef1`) + tambah level 3 (forward ke content script
top-level page).

## Yang diubah

### 1. `content/content.js` — Helper `copyTextToClipboard` + handler `COPY_TEXT`

Tambah helper async yang pakai `navigator.clipboard.writeText` dulu, kalau gagal
fallback ke `textarea + execCommand('copy')`. Plus handler message `COPY_TEXT`
supaya bisa dipanggil dari popup/sidebar via background.

```javascript
async function copyTextToClipboard(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    // Fallback: textarea + execCommand('copy')
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
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

// Handler message
} else if (msg.type === 'COPY_TEXT') {
  (async () => {
    try {
      await copyTextToClipboard(msg.text || '');
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
}
```

### 2. `popup/popup.js` — Helper `_copyTextWithFallback` (4-level chain)

Refactor `copyLinkToClipboard` jadi clean pakai helper baru. Helper ini bisa
dipakai semua fungsi copy di popup.js.

```javascript
async function _copyTextWithFallback(text) {
  if (!text) return false;

  // Level 1: navigator.clipboard.writeText (modern API)
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e1) { console.warn('[RecallFox] Clipboard L1 fail:', e1.message); }

  // Level 2: background COPY_TO_CLIPBOARD
  try {
    const res = await browser.runtime.sendMessage({ type: 'COPY_TO_CLIPBOARD', text });
    if (res?.ok) return true;
  } catch (e2) { console.warn('[RecallFox] Clipboard L2 exception:', e2.message); }

  // Level 3: RF_FORWARD_TO_ACTIVE_TAB COPY_TEXT (content script di top-level page)
  // Penting untuk popout sidebar iframe — content script top-level selalu focused
  try {
    const res = await browser.runtime.sendMessage({
      type: 'RF_FORWARD_TO_ACTIVE_TAB', msgType: 'COPY_TEXT', text
    });
    if (res?.ok) return true;
  } catch (e3) { console.warn('[RecallFox] Clipboard L3 exception:', e3.message); }

  // Level 4: textarea + execCommand('copy') di popup context (last resort)
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    return true;
  } catch (e4) {
    toast('⚠ Gagal salin: ' + (e4.message || 'clipboard tidak tersedia'), false);
    return false;
  }
}
```

### 3. `popup/popup.js` — Apply helper ke fungsi copy yang sering dipakai

- `copyLinkToClipboard()` — tombol "Salin" di vault item Link
- `$('#nCopy').addEventListener('click', ...)` — tombol "Salin" di Note editor

### 4. `background.js` — `RF_FORWARD_TO_ACTIVE_TAB` forward extra fields

Sebelumnya handler ini hanya forward `{ type: msg.msgType }` — tidak bisa
dipakai untuk COPY_TEXT yang butuh `text` field. Sekarang forward `text`,
`mode`, `data` juga.

```javascript
if (msg.type === 'RF_FORWARD_TO_ACTIVE_TAB') {
  (async () => {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) { sendResponse({ ok: false, error: 'no_active_tab' }); return; }
      // v3.20.21: Build message payload dengan forward extra fields
      const payload = { type: msg.msgType };
      if (msg.text !== undefined) payload.text = msg.text;
      if (msg.mode !== undefined) payload.mode = msg.mode;
      if (msg.data !== undefined) payload.data = msg.data;
      try {
        const res = await browser.tabs.sendMessage(tab.id, payload);
        sendResponse(res || { ok: true });
      } catch (e) { /* ... */ }
    } catch (e) { /* ... */ }
  })();
  return true;
}
```

### 5. Bonus: Merge fix v3.20.13/v3.20.14 screenshot sidebar (sudah ada di GitHub)

Local repo saya sebelumnya ketinggalan v3.20.13/v3.20.14 (screenshot hide/
restore). Sudah di-merge dari origin/main. Conflict di-resolve dengan keep
versi stash (lebih optimal — hide/restore hanya ke tab aktif + try/finally).

## Skenario test

1. **Buka popout sidebar** → klik tombol "rf" di floater → sidebar muncul
2. **Salin Link item**: klik vault item Link → klik tombol "Salin" → toast "📋 URL disalin" muncul + URL di clipboard
3. **Salin Note body**: klik vault item Note → klik tombol "Salin" di editor toolbar → toast "📋 Catatan disalin" + body di clipboard
4. **Salin setelah search**: ketik di search box → filter list → klik "Salin" di item hasil filter → tetap works (data-id tidak hilang)
5. **Salin saat iframe tidak focused**: klik area page di luar sidebar dulu, lalu klik tombol "Salin" → tetap works (fallback ke level 2/3/4)

## File yang berubah

- `manifest.json` — version bump `3.20.20` → `3.20.21`
- `content/content.js` — tambah `copyTextToClipboard()` helper + `COPY_TEXT` handler
- `popup/popup.js` — tambah `_copyTextWithFallback()` 4-level helper + apply ke `copyLinkToClipboard()` + Note copy
- `background.js` — `RF_FORWARD_TO_ACTIVE_TAB` forward `text`/`mode`/`data` fields + merge v3.20.13/v3.20.14 screenshot fix

## Catatan

- **Tidak ada breaking change**. Fungsi copy lain (bulk copy, copy bundle, copy screenshot metadata) masih pakai `navigator.clipboard.writeText` lama — akan di-migrate ke `_copyTextWithFallback` di iterasi berikutnya kalau ada report masalah.
- **Fallback chain tidak spam log**. Setiap level hanya `console.warn` sekali kalau gagal, bukan exception yang crash flow.
- **Parity dengan Chrome**. Chrome v3.21.6 (commit `7b8eef1`) sudah punya 2-level fallback (background + textarea). Firefox v3.20.21 sekarang punya 4-level (modern API + background + content script top-level + textarea). Firefox lebih robust karena ada level 3 (content script di top-level page selalu focused).
