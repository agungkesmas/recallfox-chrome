// lib/notes.js — RecallNote: floating note helpers (zero dependencies)
// Safe pure module — mirip lib/tape.js tapi untuk catatan bebas (markdown/plain)
export function toPlainText(text) { return String(text || ''); }
export function toMarkdown(text) { const s = String(text || '').trim(); if (!s) return ''; return s; }
const SESSION_KEY = 'notesSession';
const PIN_KEY = 'notesPin';
export async function loadSession() {
  try { const r = await browser.storage.local.get([SESSION_KEY, PIN_KEY]); return { text: r[SESSION_KEY] || '', pinned: !!r[PIN_KEY] }; } catch (e) { return { text: '', pinned: false }; }
}
export async function saveSession(text) { try { await browser.storage.local.set({ [SESSION_KEY]: text }); } catch (e) {} }
export async function savePinState(pinned) { try { await browser.storage.local.set({ [PIN_KEY]: !!pinned }); } catch (e) {} }
export function selfTest() { return { ok: true }; }

// v3.23.0: MULTI-INSTANCE — beberapa floating note sekaligus (lembar baru per
// tekan tombol). `noteInstances` = array of {id,text,open,collapsed,x,y,w,h,
// vaultNoteId,createdAt}. Migrasi otomatis dari notesSession+floatNoteState
// (v3.22.x) saat key belum ada. Mirror instance#1 → notesSession demi kompat
// pembaca lama (AI context, dsb).
const INSTANCES_KEY = 'noteInstances';
export async function loadInstances() {
  try {
    const r = await browser.storage.local.get([INSTANCES_KEY, 'notesSession', 'floatNoteState']);
    let list = r[INSTANCES_KEY];
    if (!Array.isArray(list)) {
      list = [];
      const legacyText = (typeof r.notesSession === 'string' && r.notesSession) || '';
      const fs = r.floatNoteState || null;
      if (legacyText || (fs && fs.isOpen)) {
        list.push({
          id: 'nlegacy' + Date.now().toString(36),
          text: legacyText || (fs && typeof fs.text === 'string' ? fs.text : '') || '',
          open: !!(fs && fs.isOpen),
          collapsed: false, x: null, y: null, w: null, h: null,
          vaultNoteId: (fs && fs.vaultNoteId) || null,
          createdAt: Date.now()
        });
      }
      const seed = {}; seed[INSTANCES_KEY] = list; seed['floatNoteState'] = null;
      try { await browser.storage.local.set(seed); } catch (e) {}
      try { await browser.storage.local.remove(['floatNoteState']); } catch (e) {}
    }
    return list.filter(i => i && typeof i.id === 'string');
  } catch (e) { return []; }
}
export async function saveInstances(list) {
  try {
    let arr = Array.isArray(list) ? list.filter(i => i && typeof i.id === 'string') : [];
    // Prune: instance tertutup (open:false) disimpan hanya bila berisi teks /
    // terhubung vault; batasi jumlah instance tertutup agar storage bersih.
    const open = arr.filter(i => i.open);
    let closed = arr.filter(i => !i.open && (String(i.text || '').trim() || i.vaultNoteId));
    if (closed.length > 12) closed = closed.slice(-12);
    arr = open.concat(closed).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const first = arr[0] || null;
    const payload = {}; payload[INSTANCES_KEY] = arr;
    payload['notesSession'] = first ? String(first.text || '') : '';
    await browser.storage.local.set(payload);
    return arr;
  } catch (e) { return Array.isArray(list) ? list : []; }
}
