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
