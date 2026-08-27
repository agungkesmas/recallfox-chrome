// lib/float-sync.js — Cross-tab sync for floating note/tape (v3.21.16)
export const NOTE_FLOAT_KEY = 'floatNoteState';
export const TAPE_FLOAT_KEY = 'floatTapeState';

export async function saveFloatState(kind, state) {
  const key = kind === 'tape' ? TAPE_FLOAT_KEY : NOTE_FLOAT_KEY;
  try { await browser.storage.local.set({ [key]: { ...state, kind, updatedAt: Date.now() } }); } catch(e){}
}
export async function loadFloatState(kind) {
  const key = kind === 'tape' ? TAPE_FLOAT_KEY : NOTE_FLOAT_KEY;
  try { const r = await browser.storage.local.get([key]); return r[key] || null; } catch(e){ return null; }
}
export async function clearFloatState(kind) {
  const key = kind === 'tape' ? TAPE_FLOAT_KEY : NOTE_FLOAT_KEY;
  try { await browser.storage.local.remove([key]); } catch(e){}
}
// legacy compat
export const FLOAT_KEY = NOTE_FLOAT_KEY;
