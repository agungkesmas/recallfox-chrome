// lib/pomodoro.js — Pomodoro timer pure logic (zero deps)
// Presets: 25/5, 50/10, 52/17, 90/20, custom
// State: storage.local pomodoroState {preset, customWork, customBreak, remaining, mode, running, cycles, soundOn}

export const PRESETS = {
  '25/5':  { work: 25, break: 5,  label: '25/5',  desc: 'Klasik — admin, anti-prokrastinasi' },
  '50/10': { work: 50, break: 10, label: '50/10', desc: 'Knowledge work — sweet spot' },
  '52/17': { work: 52, break: 17, label: '52/17', desc: 'Top 10% DeskTime' },
  '90/20': { work: 90, break: 20, label: '90/20', desc: 'Deep work — BRAC 90m' },
};

export const DEFAULT_PRESET = '25/5';
export const STORAGE_KEY = 'pomodoroState';
export const LONG_BREAK_MIN = 15; // after 4 pomodoros

export function getPreset(preset, customWork, customBreak) {
  if (preset === 'custom') {
    const w = Math.max(1, Math.min(120, parseInt(customWork) || 25));
    const b = Math.max(1, Math.min(30, parseInt(customBreak) || 5));
    return { work: w, break: b, label: `Custom ${w}/${b}`, desc: 'Custom' };
  }
  return PRESETS[preset] || PRESETS[DEFAULT_PRESET];
}

export function formatMMSS(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
}

export async function loadState() {
  try {
    const r = await browser.storage.local.get([STORAGE_KEY]);
    const s = r[STORAGE_KEY];
    if (!s) return null;
    return s;
  } catch (e) { return null; }
}

export async function saveState(state) {
  try { await browser.storage.local.set({ [STORAGE_KEY]: state }); } catch (e) {}
}

export function createInitialState(preset = DEFAULT_PRESET, customWork = 25, customBreak = 5) {
  const p = getPreset(preset, customWork, customBreak);
  return {
    preset,
    customWork,
    customBreak,
    mode: 'focus', // focus | break | longBreak
    remaining: p.work * 60,
    running: false,
    cycles: 0, // completed focus sessions in current set
    soundOn: true,
    soundFile: 'bell-soft.mp3',
    updatedAt: Date.now(),
  };
}

export function nextState(state) {
  const p = getPreset(state.preset, state.customWork, state.customBreak);
  let mode = state.mode;
  let cycles = state.cycles;
  let remaining;
  if (mode === 'focus') {
    cycles += 1;
    if (cycles % 4 === 0) {
      mode = 'longBreak';
      remaining = LONG_BREAK_MIN * 60;
    } else {
      mode = 'break';
      remaining = p.break * 60;
    }
  } else {
    mode = 'focus';
    remaining = p.work * 60;
  }
  return { ...state, mode, remaining, cycles, running: false, updatedAt: Date.now() };
}
