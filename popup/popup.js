// popup/popup.js — RecallFox v3 task-based UI
// Wired to the new DOM structure but reuses the same backend lib functions.

import {
  getVault,
  addItem,
  updateItem,
  deleteItem,
  incrementUseCount,
  addBundle,
  updateBundle,
  reassignToBundle,
  deleteBundle,
  saveSettings,
  getNotes,
  addNote,
  updateNote,
  deleteNote,
  toggleNotePin,
  getNoteGroups
} from '../lib/storage.js';
import { searchItems, extractVariables, fillVariables } from '../lib/search.js';
import { AI_TOOLS, groupByRegion, matchCurrentTool } from '../lib/ai-tools.js';
import { getAllToppings, buildFinalPrompt } from '../lib/toppings.js';
import { getNextPrayerIncludingSunnah, getLastPassedPrayer, getSunnahPrayers, formatCountdown, to12Hour } from '../lib/salahtime.js';
import { dbToPercent, percentToDb, formatPercent, MIN_DB, MAX_DB } from '../lib/volume.js';
import { getUpcomingFasts, formatHijriDate, parseHijriString, HIJRI_MONTHS, getSunnahFast } from '../lib/islamicCalendar.js';
import { getQuranStatus, getExerciseStatus, logQuranPages, logExerciseDone, snoozeExercise, getHabits } from '../lib/habits.js';
import { getUserBlocklist, addUserBlocklistEntry, removeUserBlocklistEntry } from '../lib/storage.js';
// v3.7: Import untuk halaman Backup & Tanya AI yang lebih kaya
import { getProviderList, getProviderInfo, chatWithFallback, isAssistantConfigured, buildSystemPrompt } from '../lib/assistant.js';
import { manualBackupWithTimestamp, getBackupMetadata, restoreFromFile } from '../lib/autobackup.js';
// v3.4: Helper untuk hapus selector dari elementBlockerRules (per-domain picker list)
async function removeElementBlockerSelector(domain, selector) {
  try {
    const vault = await getVault();
    const rules = Array.isArray(vault.settings.elementBlockerRules) ? vault.settings.elementBlockerRules : [];
    const rule = rules.find(r => r.domain === domain);
    if (!rule) return { ok: false, error: 'rule_not_found' };
    rule.selectors = rule.selectors.filter(s => s !== selector);
    // Kalau selectors kosong dan rule ini bukan preset, hapus rule-nya
    if (rule.selectors.length === 0 && !rule.isPreset) {
      const idx = rules.indexOf(rule);
      if (idx >= 0) rules.splice(idx, 1);
    }
    await saveSettings({ elementBlockerRules: rules });
    // Broadcast update ke semua tab
    try {
      const tabs = await browser.tabs.query({});
      for (const t of tabs) {
        browser.tabs.sendMessage(t.id, { type: 'EB_RULES_UPDATED' }).catch(() => {});
      }
    } catch (e) {}
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
// v3.4: Toggle floating Guardian panel
async function setGuardianFloatingEnabled(enabled) {
  await saveSettings({ contentGuardShowFloating: !!enabled });
  // Broadcast ke semua tab supaya panel langsung update
  try {
    const tabs = await browser.tabs.query({});
    for (const t of tabs) {
      browser.tabs.sendMessage(t.id, { type: 'CG_SETTINGS_UPDATED' }).catch(() => {});
    }
  } catch (e) {}
}

// ============ State ============
let currentVault = null;
let currentNotes = [];
let currentChip = 'all';
let currentQuery = '';
let currentView = 'home';
let editingId = null;
let editingNoteId = null;
let pendingInjectItem = null;
let editorToppings = [];
let allToppingsCache = [];
let prayerPendingLocation = null;
let prayerGeocodeTimer = null;
let prayerTimesCache = null;
let noteSaveTimer = null;
let attachSelected = new Set();
// v3.7.2 (Issue 5): filter grup catatan aktif ('' = semua, atau nama grup spesifik)
let currentNoteGroup = '';

// ============ Helpers ============
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
function escAttr(s) { return esc(s); }
function timeAgo(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'Baru saja';
  if (diff < 3600) return Math.floor(diff / 60) + ' menit lalu';
  if (diff < 86400) return Math.floor(diff / 3600) + ' jam lalu';
  if (diff < 86400 * 2) return 'Kemarin';
  return Math.floor(diff / 86400) + ' hari lalu';
}

// ============ Icons ============
const ICONS = {
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82A1.65 1.65 0 0 0 4.6 12H4a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 5.4 6.6l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H10a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  dots: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
  zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  clipA: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.2-9.19a4 4 0 0 1 5.65 5.66l-9.2 9.19a2 2 0 0 1-2.82-2.83l8.49-8.48"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l-1 7 4 3v2H6v-2l4-3z"/><path d="M12 16v5"/></svg>',
  mosque: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2c.6 1.8 2 3 3.5 3.6C17 6.2 18 7.4 18 9H6c0-1.6 1-2.8 2.5-3.4C10 5 11.4 3.8 12 2z"/><path d="M4 21v-8h16v8"/><path d="M2 21h20M10 21v-4a2 2 0 0 1 4 0v4"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>',
  moonstar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13A8 8 0 1 1 11 4a6.5 6.5 0 0 0 9 9z"/><path d="M18 2l.7 1.8L20.5 4.5l-1.8.7L18 7l-.7-1.8-1.8-.7 1.8-.7z"/></svg>',
  vol: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  eyeoff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="2" y1="2" x2="22" y2="22"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/><path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>',
  archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5" rx="1"/><line x1="10" y1="12" x2="14" y2="12"/></svg>',
  kb: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>'
};

const TYPE = {
  prompt: { label: 'Prompt', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-3.5-.7L4 20l1-4.1A8.4 8.4 0 1 1 21 11.5z"/></svg>' },
  context: { label: 'Konteks', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>' },
  snapshot: { label: 'Snapshot', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-3.5-.7L4 20l1-4.1A8.4 8.4 0 1 1 21 11.5z"/><circle cx="12" cy="11.5" r="1"/><circle cx="16" cy="11.5" r="1"/><circle cx="8" cy="11.5" r="1"/></svg>' },
  screenshot: { label: 'Media', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>' },
  link: { label: 'Link', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>' },
  bundle: { label: 'Bundle', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3.3 8.3 12 13l8.7-4.7M12 22V13"/></svg>' }
};

// ============ Toast ============
function toast(msg, ok) {
  if (ok === undefined) ok = true;
  const t = document.createElement('div');
  t.className = 'toast' + (ok ? ' ok' : ' err');
  t.innerHTML = '<span class="tk">' + (ok ? ICONS.check : ICONS.trash) + '</span>' + esc(msg);
  $('#toasts').appendChild(t);
  setTimeout(function () { t.classList.add('out'); setTimeout(function () { t.remove(); }, 280); }, 1900);
}

// ============ Sheet / Page helpers ============
function openSheet(title, sub, build) {
  $('#sheetHd').innerHTML = '<div><div>' + title + '</div>' + (sub ? '<div class="sh-sub">' + sub + '</div>' : '') + '</div>';
  const b = $('#sheetBody'); b.innerHTML = ''; build(b);
  $('#scrim').classList.add('show'); $('#sheet').classList.add('show');
}
function closeSheet() { $('#scrim').classList.remove('show'); $('#sheet').classList.remove('show'); }
function openPage(title, foot) {
  $('#pageTitle').textContent = title;
  $('#pageSaveState').textContent = '';
  $('#pageFoot').style.display = foot ? 'flex' : 'none';
  $('#pageFoot').innerHTML = foot || '';
  $('#page').classList.add('in');
}
function closePage() { $('#page').classList.remove('in'); }

// ============ Theme ============
function applyTheme(theme) {
  let actual = theme;
  if (theme === 'auto') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    actual = prefersDark ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', actual);
  document.body.setAttribute('data-theme', actual);
  $('#themeBtn').innerHTML = actual === 'dark' ? ICONS.sun : ICONS.moon;
}
async function initTheme() {
  const vault = await getVault();
  applyTheme(vault.settings.theme || 'auto');
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async () => {
      const v = await getVault();
      if (v.settings.theme === 'auto' || !v.settings.theme) applyTheme('auto');
    });
  } catch (e) {}
}
async function toggleTheme() {
  const vault = await getVault();
  const currentActual = document.documentElement.getAttribute('data-theme') || 'light';
  const next = currentActual === 'dark' ? 'light' : 'dark';
  await saveSettings({ theme: next });
  applyTheme(next);
}

// ============ AI context detection ============
let currentAiDomain = null;
async function detectAiContext() {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || !tab.url) return;
    const matched = matchCurrentTool(tab.url);
    if (matched) {
      currentAiDomain = matched;
      $('#ctxBadge').innerHTML = '<span class="dot"></span>' + matched.name + ' · siap sisip';
    } else {
      currentAiDomain = null;
      const count = currentVault?.items?.length || 0;
      $('#ctxBadge').innerHTML = '<span class="dot"></span>Vault · ' + count + ' item';
    }
  } catch (e) {}
}

// ============ Status strip ============
async function updatePrayerStrip() {
  const s = currentVault?.settings || {};
  const stripPrayer = $('#stripPrayer');
  const stripLoc = $('#stripLoc');

  if (!s.prayerEnabled || typeof s.prayerLatitude !== 'number') {
    stripPrayer.innerHTML = '🕌 <b>Setup shalat</b>';
    if (stripLoc) stripLoc.textContent = 'Waktu Shalat — belum diaktifkan';
    renderPrayerGrid(null);
    return;
  }

  let times = s.prayerCachedTimes;
  const today = new Date().toISOString().slice(0, 10);
  if (times && times.date && times.date !== today) times = null;

  if (!times || !times.timings) {
    stripPrayer.innerHTML = '🕌 <b>Memuat…</b>';
    try {
      const res = await browser.runtime.sendMessage({ type: 'PRAYER_FETCH' });
      if (res?.ok && res.times) {
        currentVault.settings.prayerCachedTimes = res.times;
        times = res.times;
      } else {
        stripPrayer.innerHTML = '🕌 <b>Gagal muat</b>';
        return;
      }
    } catch (e) {
      stripPrayer.innerHTML = '🕌 <b>Gagal muat</b>';
      return;
    }
  }

  prayerTimesCache = times;
  const next = getNextPrayerIncludingSunnah(times.timings);
  if (!next) { stripPrayer.innerHTML = '🕌 <b>—</b>'; return; }

  const fmt = s.prayerTimeFormat === '12h' ? to12Hour : (t) => t;
  const countdown = formatCountdown(next.minutesUntil);
  const dayLabel = next.isToday ? '' : ' (besok)';
  const sunnahBadge = next.isSunnah ? '🌟 ' : '';
  const color = next.minutesUntil <= 2 ? 'var(--danger)' : (next.minutesUntil < 10 ? 'var(--amber)' : 'var(--green)');

  stripPrayer.innerHTML = '🕌 <b>' + sunnahBadge + next.name + ' ' + fmt(next.time) + '</b> <span style="color:' + color + ';font-weight:600">−' + countdown + dayLabel + '</span>';
  if (stripLoc) stripLoc.textContent = 'Waktu Shalat · ' + (s.prayerLocation || 'Lokasi');

  renderPrayerGrid(times);
}

function renderPrayerGrid(times) {
  const grid = $('#prayGrid');
  if (!grid) return;
  if (!times || !times.timings) { grid.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:8px 0">Aktifkan dari tab Alat → Waktu Shalat</div>'; return; }
  const s = currentVault?.settings || {};
  const fmt = s.prayerTimeFormat === '12h' ? to12Hour : (t) => t;
  const next = getNextPrayerIncludingSunnah(times.timings);
  const rows = [
    ['Subuh', times.timings.Fajr, 'Fajr'],
    ['Terbit', times.timings.Sunrise, 'Sunrise'],
    ['Dzuhur', times.timings.Dhuhr, 'Dhuhr'],
    ['Ashar', times.timings.Asr, 'Asr'],
    ['Magrib', times.timings.Maghrib, 'Maghrib'],
    ['Isya', times.timings.Isha, 'Isha']
  ];
  grid.innerHTML = rows.map(function (r) {
    const isNext = next && next.key === r[2];
    return '<div class="pray-cell' + (isNext ? ' next' : '') + '"><div class="n">' + r[0] + '</div><div class="t">' + fmt(r[1]) + '</div></div>';
  }).join('');
}

async function updateHabitsStrip() {
  const s = currentVault?.settings || {};
  const quranEl = $('#habitQuran');
  const gymEl = $('#habitGym');
  const stripQuran = $('#stripQuran');

  let qDone = false, eDone = false;
  let qCount = 0, eCount = 0;

  if (s.quranEnabled !== false) {
    try {
      const q = await getQuranStatus(s);
      qDone = q.isComplete; qCount = q.todayPages || 0;
    } catch (e) {}
  }
  if (s.exerciseEnabled !== false) {
    try {
      const ex = await getExerciseStatus(s);
      eDone = ex.todayCount > 0 && !ex.isDue; eCount = ex.todayCount || 0;
    } catch (e) {}
  }

  if (quranEl) {
    quranEl.classList.toggle('done', qDone);
    quranEl.innerHTML = '📖 Ngaji ' + (qDone ? '<span>✓ ' + qCount + ' hal</span>' : '<span>' + qCount + ' hal</span>');
  }
  if (gymEl) {
    gymEl.classList.toggle('done', eDone);
    gymEl.innerHTML = '🏃 Olahraga' + (eDone ? ' ✓' : '');
  }
  if (stripQuran) {
    const done = (qDone ? 1 : 0) + (eDone ? 1 : 0);
    const total = (s.quranEnabled !== false ? 1 : 0) + (s.exerciseEnabled !== false ? 1 : 0);
    stripQuran.textContent = done + '/' + (total || 2);
  }
}

async function updateFastStrip() {
  const fastEl = $('#stripFast');
  const fastNote = $('#fastNote');
  try {
    const cachedHijri = currentVault?.settings?.prayerCachedTimes?.hijri;
    const hijriToday = cachedHijri ? parseHijriString(cachedHijri) : null;
    if (!hijriToday) {
      if (fastEl) fastEl.innerHTML = '🌙 <b>—</b>';
      if (fastNote) fastNote.textContent = '🌙 Aktifkan Waktu Shalat untuk lihat jadwal puasa.';
      return;
    }
    const fasts = getUpcomingFasts(hijriToday, new Date(), 14);
    if (fasts && fasts.length > 0) {
      const f = fasts[0];
      const label = f.name || 'Puasa sunnah';
      const days = f.daysAhead;
      const dayStr = days === 0 ? 'hari ini' : (days === 1 ? 'besok' : days + ' hari lagi');
      if (fastEl) fastEl.innerHTML = '🌙 <b>' + label + '</b>';
      if (fastNote) fastNote.innerHTML = '🌙 Puasa sunnah berikutnya: <b>' + esc(label) + '</b> (' + dayStr + ')';
    } else {
      if (fastEl) fastEl.innerHTML = '🌙 <b>—</b>';
      if (fastNote) fastNote.textContent = '🌙 Tidak ada puasa sunnah dalam 14 hari ke depan.';
    }
  } catch (e) {
    if (fastEl) fastEl.innerHTML = '🌙 <b>—</b>';
    if (fastNote) fastNote.textContent = '🌙 Memuat jadwal puasa…';
  }
}

// ============ Vault rendering ============
function getVaultItems() {
  if (!currentVault) return [];
  const items = currentVault.items || [];
  const bundles = (currentVault.bundles || []).map(b => ({
    id: b.id, type: 'bundle', title: b.name || 'Bundle', tags: ['bundle'],
    uses: b.useCount || 0, _bundle: b
  }));
  return [...items, ...bundles];
}

// v3.7.2 (Issue 1): tambah chip "Arsip" untuk lihat item yang diarsipkan.
const CHIPS = [['all', 'Semua'], ['prompt', 'Prompt'], ['context', 'Konteks'], ['snapshot', 'Snapshot'], ['screenshot', 'Media'], ['link', 'Link'], ['bundle', 'Bundle'], ['archive', 'Arsip']];
function chipCount(c) {
  const items = getVaultItems();
  if (c === 'all') {
    // Hitung item non-archived + bundle non-archived
    return items.filter(i => !i.archived && !(i._bundle && i._bundle.archived)).length;
  }
  if (c === 'archive') {
    return items.filter(i => i.archived || (i._bundle && i._bundle.archived)).length;
  }
  return items.filter(i => i.type === c && !i.archived).length;
}
function renderChips() {
  const items = getVaultItems();
  $('#chips').innerHTML = CHIPS.map(function (c) {
    const n = chipCount(c[0]);
    if (c[0] !== 'all' && c[0] !== 'archive' && n === 0) return '';
    return '<button class="chip' + (currentChip === c[0] ? ' on' : '') + '" data-chip="' + c[0] + '">' + c[1] + '<span class="n">' + n + '</span></button>';
  }).join('');
  $$('#chips .chip').forEach(ch => ch.addEventListener('click', () => { currentChip = ch.dataset.chip; renderVault(); }));
  const visibleItemsForMeta = items.filter(i => !i.archived && !(i._bundle && i._bundle.archived));
  const favs = visibleItemsForMeta.filter(i => i.favorite).length;
  const uses = visibleItemsForMeta.reduce((a, b) => a + (b.useCount || b.uses || 0), 0);
  $('#vaultMeta').textContent = visibleItemsForMeta.length + ' item · ★ ' + favs + ' · ↑ ' + uses;
  if (!currentAiDomain) $('#ctxBadge').innerHTML = '<span class="dot"></span>Vault · ' + visibleItemsForMeta.length + ' item';
}

// v3.7.2 (Issue 4): Searchable text untuk satu item — gabungan field yang relevan.
// Termasuk screenshot source.url, source.title, linkUrl, dan bundle item titles.
function searchableTextFor(it) {
  if (!it) return '';
  const parts = [it.title || '', it.type || ''];
  if (Array.isArray(it.tags)) parts.push(it.tags.join(' '));
  if (it.body) parts.push(it.body);
  if (it.linkUrl) parts.push(it.linkUrl);
  if (it.linkTitle) parts.push(it.linkTitle);
  if (it.category) parts.push(it.category);
  // v3.7.2 (Issue 4): screenshot metadata
  if (it.source) {
    if (it.source.url) parts.push(it.source.url);
    if (it.source.title) parts.push(it.source.title);
  }
  // v3.7.2 (Issue 4): bundle — sertakan judul semua item anggota
  if (it._bundle) {
    const memberTitles = (it._bundle.injectOrder || it._bundle.itemIds || [])
      .map(iid => currentVault.items.find(i => i.id === iid))
      .filter(Boolean)
      .map(i => i.title || '');
    parts.push(memberTitles.join(' '));
  }
  return parts.join(' ').toLowerCase();
}

function visibleItems() {
  const items = getVaultItems();
  // v3.7.2 (Issue 1): chip 'archive' menampilkan hanya item yang diarsipkan.
  // Chip 'all' dan tipe lain menyembunyikan item yang diarsipkan.
  let vi;
  if (currentChip === 'archive') {
    vi = items.filter(i => i.archived || (i._bundle && i._bundle.archived));
  } else if (currentChip === 'all') {
    vi = items.filter(i => !i.archived && !(i._bundle && i._bundle.archived));
  } else {
    vi = items.filter(i => i.type === currentChip && !i.archived);
  }
  if (currentQuery && !currentQuery.startsWith('>')) {
    const q = currentQuery.toLowerCase();
    vi = vi.filter(i => searchableTextFor(i).indexOf(q) >= 0);
  }
  return vi;
}
function renderList() {
  const list = $('#list');
  if (currentQuery && !currentQuery.startsWith('>')) {
    list.style.display = 'none';
    return;
  }
  list.style.display = '';
  const vi = visibleItems();
  if (!vi.length) {
    list.innerHTML = '<div class="empty"><div class="big">🦊</div>Tidak ada item di filter ini.<br><span style="font-size:11px">Blok teks di halaman → klik kanan → Simpan ke RecallFox.</span></div>';
    return;
  }
  list.innerHTML = vi.map(function (it) {
    const T = TYPE[it.type] || { label: it.type, icon: '' };
    const tagsStr = Array.isArray(it.tags) ? it.tags.join(', ') : (it.tags || '');
    const vars = it.body ? extractVariables(it.body).length : 0;
    const fav = it.favorite ? '<span class="fav">★</span>' : '';
    // v3.7.2 (Issue 1): indikator arsip
    const arch = it.archived ? '<span class="fav" title="Diarsipkan" style="color:var(--muted)">📦</span>' : '';
    const uses = it.useCount || it.uses || 0;
    // v3.7.1-FIX: Untuk Link: 3 tombol (Salin, Buka, Sisipkan).
    // Untuk Bundle: 2 tombol (Salin, Sisipkan jika AI).
    // Untuk Screenshot: 2 tombol (Lihat, Download).
    // Untuk tipe lain: CTA pill tunggal.
    let ctaHtml = '';
    if (it.type === 'link') {
      ctaHtml =
        '<span class="cta-pill" data-link-action="copy">' + ICONS.copy + 'Salin ↵</span>'
        + '<button class="link-mini-btn" data-link-action="open" title="Buka link di tab baru">' + ICONS.spark + '</button>'
        + (currentAiDomain ? '<button class="link-mini-btn" data-link-action="inject" title="Sisipkan URL ke chat AI">' + ICONS.zap + '</button>' : '');
    } else if (it.type === 'bundle') {
      ctaHtml =
        '<span class="cta-pill" data-bundle-action="copy">' + ICONS.copy + 'Salin ↵</span>'
        + (currentAiDomain ? '<button class="link-mini-btn" data-bundle-action="inject" title="Sisipkan semua item ke chat AI">' + ICONS.zap + '</button>' : '');
    } else if (it.type === 'screenshot') {
      ctaHtml =
        '<span class="cta-pill" data-shot-action="view">' + ICONS.image + 'Lihat ↵</span>'
        + '<button class="link-mini-btn" data-shot-action="download" title="Download gambar">' + ICONS.download + '</button>';
    } else {
      const cta = currentAiDomain ? ICONS.zap + 'Sisipkan ↵' : ICONS.copy + 'Salin ↵';
      ctaHtml = '<span class="cta-pill">' + cta + '</span>';
    }
    return '<div class="item" data-id="' + it.id + '" tabindex="0">'
      + '<div class="item-ic t-' + it.type + '">' + T.icon + '</div>'
      + '<div class="item-main">'
      + '<div class="item-title">' + fav + arch + esc(it.title) + (vars ? ' <span title="' + vars + ' variabel" style="font-size:10px">⚙️</span>' : '') + '</div>'
      + '<div class="item-meta">' + T.label + ' · ' + esc(tagsStr) + (uses ? ' · <span class="uses">' + uses + '× dipakai</span>' : '') + '</div>'
      + '</div>'
      + '<div class="item-cta">'
      + ctaHtml
      + '<button class="morebtn" data-more="' + it.id + '" title="Aksi lainnya">' + ICONS.dots + '</button>'
      + '</div></div>';
  }).join('');
  bindItemClicks();
}
function bindItemClicks() {
  $$('#list .item').forEach(el => {
    el.addEventListener('click', e => {
      // v3.6: Cek apakah user klik tombol aksi Link khusus (data-link-action)
      const linkBtn = e.target.closest('[data-link-action]');
      if (linkBtn) {
        e.stopPropagation();
        const action = linkBtn.dataset.linkAction;
        const it = findItem(el.dataset.id);
        if (!it) return;
        if (action === 'copy') copyLinkToClipboard(it);
        else if (action === 'open') openLinkInNewTab(it);
        else if (action === 'inject') injectLinkToChat(it);
        return;
      }
      // v3.7.1-FIX: Tombol aksi Bundle (data-bundle-action)
      const bundleBtn = e.target.closest('[data-bundle-action]');
      if (bundleBtn) {
        e.stopPropagation();
        const action = bundleBtn.dataset.bundleAction;
        const it = findItem(el.dataset.id);
        if (!it) return;
        if (action === 'copy') { injectBundle(it.id); return; }
        else if (action === 'inject') {
          // Sisipkan semua teks item bundle ke chat AI
          const bundle = currentVault.bundles.find(b => b.id === it.id);
          if (bundle) {
            const items = (bundle.injectOrder || bundle.itemIds || []).map(iid => currentVault.items.find(i => i.id === iid)).filter(Boolean);
            const textItems = items.filter(i => i.type !== 'link');
            if (textItems.length > 0) {
              const text = textItems.map(i => '## ' + (i.title || i.type) + '\n' + (i.body || '')).join('\n\n---\n\n');
              doInject(text, it.id);
            } else { toast('Bundle tidak punya item teks', false); }
          }
          return;
        }
      }
      // v3.7.1-FIX: Tombol aksi Screenshot (data-shot-action)
      const shotBtn = e.target.closest('[data-shot-action]');
      if (shotBtn) {
        e.stopPropagation();
        const action = shotBtn.dataset.shotAction;
        const it = findItem(el.dataset.id);
        if (!it) return;
        if (action === 'view') openScreenshotViewer(it.id);
        else if (action === 'download') downloadScreenshot(it.id);
        return;
      }
      if (e.target.closest('.morebtn')) return;
      primaryAction(el.dataset.id);
    });
    el.addEventListener('keydown', e => { if (e.key === 'Enter') primaryAction(el.dataset.id); });
  });
  $$('#list .morebtn').forEach(b => {
    b.addEventListener('click', e => { e.stopPropagation(); itemSheet(b.dataset.more); });
  });
}
function findItem(id) {
  const items = getVaultItems();
  return items.find(i => String(i.id) === String(id));
}
async function primaryAction(id) {
  const it = findItem(id);
  if (!it) return;
  if (it.type === 'link') {
    // v3.6: Tombol "Salin" untuk Link harus SALIN URL, bukan buka link.
    // Untuk buka link, sediakan tombol terpisah "Buka" (openLinkInNewTab).
    await copyLinkToClipboard(it);
    return;
  }
  if (it.type === 'bundle') {
    await injectBundle(it.id);
    return;
  }
  if (it.type === 'screenshot') {
    openScreenshotViewer(it.id);
    return;
  }
  // prompt / context / snapshot
  const vars = extractVariables(it.body || '');
  const finalBody = await buildFinalPrompt(it.body || '', it.toppings || []);
  if (vars.length > 0) {
    pendingInjectItem = { ...it, body: finalBody };
    openVarsModal(vars);
  } else {
    await doInject(finalBody, it.id);
  }
}

// v3.6: Helper untuk salin URL Link ke clipboard (bukan buka link)
async function copyLinkToClipboard(it) {
  if (!it) return;
  const url = it.linkUrl || it.body || '';
  if (!url) { toast('Link ini tidak punya URL', false); return; }
  try {
    await navigator.clipboard.writeText(url);
    await incrementUseCount(it.id);
    toast('📋 URL disalin: ' + url.slice(0, 40) + (url.length > 40 ? '…' : ''));
  } catch (e) {
    // Fallback: pakai background script
    try {
      await browser.runtime.sendMessage({ type: 'COPY_TO_CLIPBOARD', text: url });
      await incrementUseCount(it.id);
      toast('📋 URL disalin');
    } catch (e2) {
      toast('⚠ Gagal salin: ' + e2.message, false);
    }
  }
}

// v3.6: Helper untuk buka link di tab baru
async function openLinkInNewTab(it) {
  if (!it) return;
  const url = it.linkUrl || it.body || '';
  if (!url) { toast('Link ini tidak punya URL', false); return; }
  try {
    await browser.tabs.create({ url });
    await incrementUseCount(it.id);
    toast('🔗 Membuka ' + (it.title || url).slice(0, 30) + '…');
  } catch (e) {
    toast('⚠ Gagal buka: ' + e.message, false);
  }
}

// v3.6: Helper untuk inject URL Link ke chat AI aktif
async function injectLinkToChat(it) {
  if (!it) return;
  const url = it.linkUrl || it.body || '';
  if (!url) { toast('Link ini tidak punya URL', false); return; }
  // Bangun teks yang akan di-inject: judul + URL
  const title = it.title || '';
  const injectText = title ? (title + '\n' + url) : url;
  // Pakai doInject yang sudah ada — sama seperti prompt/context
  await doInject(injectText, it.id);
}
async function doInject(body, itemId) {
  const settings = currentVault?.settings || {};
  const mode = settings.injectMode || 'append';
  try {
    const res = await browser.runtime.sendMessage({ type: 'INJECT_TO_ACTIVE_TAB', text: body, mode });
    if (itemId) await incrementUseCount(itemId);
    if (res?.ok) {
      toast('⚡ Disisipkan' + (currentAiDomain ? ' ke ' + currentAiDomain.name : ''));
      if (!document.body.classList.contains('rf-sidebar-body')) setTimeout(() => window.close(), 700);
    } else {
      // v3.7.1-FIX: Benar-benar salin ke clipboard, bukan cuma pesan toast
      try {
        await navigator.clipboard.writeText(body);
        toast('📋 Disalin ke clipboard');
      } catch (clipErr) {
        try {
          await browser.runtime.sendMessage({ type: 'COPY_TO_CLIPBOARD', text: body });
          toast('📋 Disalin ke clipboard');
        } catch (e2) {
          toast('⚠ Gagal menyisipkan dan menyalin', false);
        }
      }
      if (!document.body.classList.contains('rf-sidebar-body')) setTimeout(() => window.close(), 900);
    }
  } catch (e) {
    // v3.7.1-FIX: Saat inject gagal total, fallback ke clipboard
    try {
      await navigator.clipboard.writeText(body);
      if (itemId) await incrementUseCount(itemId);
      toast('📋 Disalin ke clipboard');
    } catch (clipErr) {
      try {
        await browser.runtime.sendMessage({ type: 'COPY_TO_CLIPBOARD', text: body });
        if (itemId) await incrementUseCount(itemId);
        toast('📋 Disalin ke clipboard');
      } catch (e2) {
        if (itemId) await incrementUseCount(itemId);
        toast('⚠ Gagal: ' + e.message, false);
      }
    }
  }
  await refreshVault();
}
async function injectBundle(id) {
  const bundle = currentVault.bundles.find(b => b.id === id);
  if (!bundle) return;
  const items = (bundle.injectOrder || bundle.itemIds || []).map(iid => currentVault.items.find(i => i.id === iid)).filter(Boolean);
  if (items.length === 0) { toast('Bundle kosong', false); return; }
  // v3.7.1-FIX: Bundle sekarang salin semua konten ke clipboard, bukan buka link di tab baru
  const allParts = items.map(i => {
    const header = '## ' + (i.title || i.type) + ' [' + (TYPE[i.type]?.label || i.type) + ']';
    if (i.type === 'link') return header + '\n' + (i.linkUrl || i.body || '');
    return header + '\n' + (i.body || '');
  });
  const fullText = allParts.join('\n\n---\n\n');
  try {
    await navigator.clipboard.writeText(fullText);
    for (const i of items) await incrementUseCount(i.id);
    toast('📋 Bundle disalin ke clipboard (' + items.length + ' item)');
  } catch (e) {
    try {
      await browser.runtime.sendMessage({ type: 'COPY_TO_CLIPBOARD', text: fullText });
      for (const i of items) await incrementUseCount(i.id);
      toast('📋 Bundle disalin ke clipboard (' + items.length + ' item)');
    } catch (e2) {
      toast('⚠ Gagal menyalin bundle', false);
    }
  }
  if (!document.body.classList.contains('rf-sidebar-body')) setTimeout(() => window.close(), 700);
}
function openScreenshotViewer(id) {
  browser.runtime.sendMessage({ type: 'GET_SCREENSHOT_BLOB', id }).then(res => {
    if (res?.ok && res.dataUrl) {
      const w = window.open('');
      if (w) {
        const item = currentVault.items.find(i => i.id === id);
        w.document.write('<!DOCTYPE html><title>' + esc(item?.title || 'Screenshot') + '</title><body style="margin:0;background:#0c0a09;display:flex;align-items:center;justify-content:center;min-height:100vh;"><img src="' + res.dataUrl + '" style="max-width:100%;max-height:100vh;" /></body>');
      }
    } else {
      toast('Gagal memuat gambar', false);
    }
  });
}
function renderVault() { renderChips(); renderList(); }

// ============ Item sheet (⋯ menu) ============
function itemSheet(id) {
  const it = findItem(id);
  if (!it) return;
  const T = TYPE[it.type] || { label: it.type };
  const vars = it.body ? extractVariables(it.body).length : 0;
  openSheet(esc(it.title), T.label + (vars ? ' · ' + vars + ' variabel' : ''), b => {
    const isAi = !!currentAiDomain;
    const primaryLabel = it.type === 'link' ? 'Buka link di tab baru' : (it.type === 'bundle' ? 'Salin bundle ke clipboard' : (it.type === 'screenshot' ? 'Lihat screenshot' : (isAi ? 'Sisipkan ke chat' : 'Salin ke clipboard')));
    const primaryIcon = it.type === 'link' ? ICONS.spark : (it.type === 'bundle' ? ICONS.archive : (isAi ? ICONS.zap : ICONS.copy));
    b.innerHTML =
      '<button class="act" data-a="primary">' + primaryIcon + '<div>' + primaryLabel + '<div class="ad">Sama dengan klik baris — 1 klik</div></div></button>'
      + (it.type === 'prompt' || it.type === 'context' ? '<button class="act" data-a="attach">' + ICONS.clipA + '<div>Sisipkan dengan lampiran<div class="ad">Prompt + link referensi sekaligus</div></div></button>' : '')
      + '<button class="act" data-a="edit">' + ICONS.edit + '<div>Edit judul, isi, tag…</div></button>'
      + '<button class="act" data-a="fav">' + ICONS.star + '<div>' + (it.favorite ? 'Hapus dari favorit' : 'Jadikan favorit') + '</div></button>'
      // v3.7.2 (Issue 1): Arsipkan / Unarsipkan — item tetap tersimpan, hanya disembunyikan dari list default.
      + (it.type !== 'bundle' ? '<button class="act" data-a="archive">' + ICONS.archive + '<div>' + (it.archived ? 'Keluarkan dari arsip' : 'Arsipkan item') + '<div class="ad">Disembunyikan dari list utama tanpa dihapus</div></div></button>' : '')
      // v3.7.2 (Issue 1): Tambah/Pindah ke Bundle — assign ulang screenshot/prompt/dll ke bundle lain.
      + (it.type !== 'bundle' ? '<button class="act" data-a="bundle">' + ICONS.clipA + '<div>Tambah / pindah ke Bundle<div class="ad">Reassign item ke sesi troubleshooting lain</div></div></button>' : '<button class="act" data-a="editbundle">' + ICONS.edit + '<div>Edit bundle<div class="ad">Ubah nama, tambah / hapus anggota</div></div></button>')
      + (it.type === 'screenshot' ? '<button class="act" data-a="dl">' + ICONS.download + '<div>Download gambar</div></button>' : '')
      + '<button class="act danger" data-a="del">' + ICONS.trash + '<div>Hapus item</div></button>';
    b.querySelectorAll('.act').forEach(a => a.addEventListener('click', () => {
      const k = a.dataset.a;
      if (k === 'primary') { closeSheet(); primaryAction(it.id); }
      else if (k === 'attach') { closeSheet(); openAttachModal(it.id); }
      else if (k === 'edit') { closeSheet(); openEditorSheet(it.id); }
      else if (k === 'editbundle') { closeSheet(); openBundleEditorSheet(it.id); }
      else if (k === 'fav') { toggleFav(it.id).then(() => { closeSheet(); toast(it.favorite ? '★ Dihapus dari favorit' : '★ Jadikan favorit'); }); }
      else if (k === 'archive') { toggleArchive(it.id).then(() => { closeSheet(); toast(it.archived ? '📦 Dikeluarkan dari arsip' : '📦 Diarsipkan'); }); }
      else if (k === 'bundle') { closeSheet(); openReassignBundleSheet(it.id); }
      else if (k === 'dl') { closeSheet(); downloadScreenshot(it.id); }
      else if (k === 'del') {
        b.innerHTML = '<div class="confirmstrip"><span style="flex:1">Hapus <b>' + esc((it.title || '').slice(0, 24)) + '</b>?</span>'
          + '<button class="btn btn-g" data-c="0">Batal</button><button class="btn btn-d" data-c="1">Hapus</button></div>';
        b.querySelector('[data-c="0"]').addEventListener('click', closeSheet);
        b.querySelector('[data-c="1"]').addEventListener('click', async () => {
          if (it._bundle) await deleteBundle(it.id); else await deleteItem(it.id);
          closeSheet(); await refreshVault(); toast('Item dihapus');
        });
      }
    }));
  });
}
async function toggleFav(id) {
  const it = currentVault.items.find(i => i.id === id);
  if (!it) return;
  await updateItem(id, { favorite: !it.favorite });
  await refreshVault();
}
// v3.7.2 (Issue 1): Toggle arsip — item tetap tersimpan, hanya disembunyikan dari list default.
async function toggleArchive(id) {
  const it = currentVault.items.find(i => i.id === id);
  if (!it) return;
  await updateItem(id, { archived: !it.archived });
  await refreshVault();
}
// v3.7.2 (Issue 1): Sheet untuk reassign item ke bundle lain (atau lepas dari bundle).
function openReassignBundleSheet(itemId) {
  const it = currentVault.items.find(i => i.id === itemId);
  if (!it) { toast('Item tidak ditemukan', false); return; }
  const bundles = currentVault.bundles || [];
  openSheet('📦 Tambah / pindah ke Bundle', 'Pilih bundle tujuan — item akan ditambahkan. Bundel lain tidak terpengaruh.', b => {
    if (!bundles.length) {
      b.innerHTML = '<div class="empty"><div class="big">📦</div>Belum ada bundle.<br><button class="btn btn-p" id="rbNew" style="margin-top:8px">Buat bundle pertama</button></div>';
      $('#rbNew')?.addEventListener('click', () => { closeSheet(); saveBundleSheet(); });
      return;
    }
    b.innerHTML = '<div class="sheet-form">'
      + '<div class="hintbox" style="margin-bottom:8px">Item: <b>' + esc((it.title || '').slice(0, 50)) + '</b></div>'
      + '<div class="picklist">' + bundles.map(bd => {
          const isMember = (bd.itemIds || []).includes(itemId);
          return '<label class="pickrow"><input type="checkbox" value="' + bd.id + '"' + (isMember ? ' checked' : '') + '><span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(bd.name || 'Bundle') + '</span><span class="pt-type">' + (bd.itemIds || []).length + ' item</span></label>';
        }).join('') + '</div>'
      + '<div class="btn-row"><button class="btn btn-g" id="rbCancel">Batal</button><button class="btn btn-p" id="rbSave">' + ICONS.check + 'Simpan perubahan</button></div></div>';
    const boxes = [...b.querySelectorAll('input[type=checkbox]')];
    $('#rbCancel').addEventListener('click', closeSheet);
    $('#rbSave').addEventListener('click', async () => {
      for (const box of boxes) {
        const bid = box.value;
        const wasMember = (currentVault.bundles.find(x => x.id === bid)?.itemIds || []).includes(itemId);
        if (box.checked && !wasMember) {
          await reassignToBundle(bid, itemId, 'add');
        } else if (!box.checked && wasMember) {
          await reassignToBundle(bid, itemId, 'remove');
        }
      }
      closeSheet();
      await refreshVault();
      toast('📦 Keanggotaan bundle diperbarui ✓');
    });
  });
}
// v3.7.2 (Issue 1): Bundle editor — ubah nama, tambah / hapus anggota, arsipkan bundle.
function openBundleEditorSheet(bundleId) {
  const bd = currentVault.bundles.find(b => b.id === bundleId);
  if (!bd) { toast('Bundle tidak ditemukan', false); return; }
  const candidates = (currentVault?.items || []).filter(i => ['prompt', 'context', 'link', 'screenshot', 'snapshot'].includes(i.type));
  openSheet('📦 Edit Bundle', 'Ubah nama, tambah / hapus anggota, atau arsipkan bundle', b => {
    b.innerHTML = '<div class="sheet-form">'
      + '<div><label>Nama Bundle</label><input class="f" id="ebName" value="' + esc(bd.name || '') + '" placeholder="mis. Riset kompetitor…"></div>'
      + '<div><label>Anggota <span class="field-hint" id="ebCount">' + (bd.itemIds || []).length + ' dipilih</span></label>'
      + '<div class="picklist">' + candidates.map(it => {
          const T = TYPE[it.type] || { label: it.type };
          const checked = (bd.itemIds || []).includes(it.id) ? ' checked' : '';
          return '<label class="pickrow"><input type="checkbox" value="' + it.id + '"' + checked + '><span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(it.title) + '</span><span class="pt-type">' + T.label + '</span></label>';
        }).join('') + '</div></div>'
      + '<div class="btn-row"><button class="btn btn-g" id="ebArchive">' + ICONS.archive + (bd.archived ? 'Keluarkan dari arsip' : 'Arsipkan') + '</button>'
      + '<span style="flex:1"></span>'
      + '<button class="btn btn-g" id="ebCancel">Batal</button><button class="btn btn-p" id="ebSave">' + ICONS.check + 'Simpan</button></div></div>';
    const boxes = [...b.querySelectorAll('input[type=checkbox]')];
    boxes.forEach(x => x.addEventListener('change', () => { b.querySelector('#ebCount').textContent = boxes.filter(c => c.checked).length + ' dipilih'; }));
    $('#ebCancel').addEventListener('click', closeSheet);
    $('#ebSave').addEventListener('click', async () => {
      const name = ($('#ebName').value || '').trim() || 'Bundle tanpa nama';
      const ids = boxes.filter(c => c.checked).map(c => c.value);
      await updateBundle(bd.id, { name, itemIds: ids, injectOrder: ids });
      closeSheet();
      await refreshVault();
      toast('Bundle diperbarui ✓ · ' + ids.length + ' item');
    });
    $('#ebArchive').addEventListener('click', async () => {
      await updateBundle(bd.id, { archived: !bd.archived });
      closeSheet();
      await refreshVault();
      toast(bd.archived ? '📦 Dikeluarkan dari arsip' : '📦 Bundle diarsipkan');
    });
  });
}
async function downloadScreenshot(id) {
  const item = currentVault.items.find(i => i.id === id);
  if (!item) return;
  const res = await browser.runtime.sendMessage({ type: 'DOWNLOAD_SCREENSHOT', id, title: item.title, format: item.screenshotFormat || 'png' });
  if (res?.ok) toast('🖼️ Download dimulai'); else toast('Gagal download: ' + (res?.error || ''), false);
}

// ============ Editor sheet (add / edit item) ============
async function openEditorSheet(id) {
  editingId = id || null;
  const it = id ? findItem(id) : null;
  const title = it ? 'Edit item' : 'Item baru';
  const sub = it ? (TYPE[it.type]?.label || it.type) : 'Pilih tipe di bawah';
  openSheet(title, sub, b => {
    const type = it?.type || 'prompt';
    const isLink = type === 'link';
    const isShot = type === 'screenshot';
    b.innerHTML = '<div class="sheet-form">'
      + '<div><label>Tipe</label><select class="f" id="fType">' + [
        ['prompt', '💬 Prompt'], ['context', '📋 Konteks'], ['snapshot', '📸 Snapshot'],
        ['screenshot', '🖼️ Screenshot'], ['link', '🔗 Link']
      ].map(o => '<option value="' + o[0] + '"' + (o[0] === type ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></div>'
      + '<div><label>Judul</label><input class="f" id="fTitle" value="' + esc(it?.title || '') + '" placeholder="Judul singkat…"></div>'
      + (isLink ? '<div><label>URL</label><input class="f" id="fUrl" value="' + esc(it?.linkUrl || it?.body || '') + '" placeholder="https://..."></div>' : '')
      + (isShot ? '' : '<div><label>Isi <span class="field-hint">— pakai {{nama}} untuk variabel</span></label><textarea class="f" id="fBody" rows="4" placeholder="Isi prompt / konteks…">' + esc(it?.body || '') + '</textarea><div class="varchips" id="fVars"></div></div>')
      + '<div><label>Tag <span class="field-hint">(pisah koma)</span></label><input class="f" id="fTags" value="' + esc(it ? (Array.isArray(it.tags) ? it.tags.join(', ') : (it.tags || '')) : '') + '" placeholder="coding, review"></div>'
      + (type === 'prompt' ? '<div><button class="toppick-btn" id="fTopBtn">' + ICONS.plus + 'Pilih topping <span class="field-hint" style="display:inline">(opsional)</span></button><div class="topchips" id="fTops"></div></div>' : '')
      + '<div class="btn-row"><button class="btn btn-g" id="fCancel">Batal</button><button class="btn btn-p" id="fSave">' + ICONS.check + 'Simpan</button></div></div>';

    // Variable detection
    const body = b.querySelector('#fBody');
    const varsEl = b.querySelector('#fVars');
    if (body) body.addEventListener('input', () => {
      const found = []; let m; const re = /\{\{(\w+)\}\}/g;
      while ((m = re.exec(body.value))) { if (found.indexOf(m[1]) < 0) found.push(m[1]); }
      if (varsEl) varsEl.innerHTML = found.length ? '<span style="font-size:10px;color:var(--muted);align-self:center">Variabel:</span>' + found.map(v => '<span class="varchip">{{' + v + '}}</span>').join('') : '';
    });
    if (body) body.dispatchEvent(new Event('input'));

    // Toppings
    if (type === 'prompt') {
      getAllToppings().then(tops => {
        editorToppings = [...(it?.toppings || [])];
        const topsEl = b.querySelector('#fTops');
        topsEl.innerHTML = tops.map(t => '<button class="topchip' + (editorToppings.includes(t.id) ? ' on' : '') + '" data-t="' + esc(t.id) + '">' + esc(t.emoji || '') + ' ' + esc(t.name) + '</button>').join('');
        b.querySelector('#fTopBtn').addEventListener('click', () => topsEl.classList.toggle('show'));
        topsEl.querySelectorAll('.topchip').forEach(ch => ch.addEventListener('click', () => {
          ch.classList.toggle('on');
          const tid = ch.dataset.t;
          if (editorToppings.includes(tid)) editorToppings = editorToppings.filter(x => x !== tid);
          else editorToppings.push(tid);
        }));
      });
    }

    b.querySelector('#fCancel').addEventListener('click', closeSheet);
    b.querySelector('#fSave').addEventListener('click', () => saveEditorSheet(it));
    setTimeout(() => b.querySelector('#fTitle')?.focus(), 120);
  });
}
async function saveEditorSheet(existing) {
  const type = $('#fType').value;
  const title = ($('#fTitle').value || '').trim();
  const tagsRaw = ($('#fTags').value || '').trim();
  const tags = tagsRaw ? tagsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const bodyEl = $('#fBody'); const body = bodyEl ? bodyEl.value : '';
  const urlEl = $('#fUrl'); const url = urlEl ? urlEl.value.trim() : '';

  if (type === 'link') {
    if (!url) { toast('URL wajib untuk Link', false); return; }
    const linkTitle = title || url;
    if (existing) await updateItem(existing.id, { type, title: linkTitle, tags, body: url, linkUrl: url, linkTitle });
    else await addItem({ type, title: linkTitle, tags, body: url, linkUrl: url, linkTitle });
  } else if (type === 'screenshot') {
    if (!existing) { toast('Screenshot baru pakai tombol Shot', false); return; }
    await updateItem(existing.id, { type, title: title || existing.title, tags, body: existing.body || '' });
  } else {
    if (!title && !body) { closeSheet(); return; }
    const patch = { type, title: title || body.slice(0, 60), tags, body };
    if (type === 'prompt') patch.toppings = [...editorToppings];
    if (existing) await updateItem(existing.id, patch);
    else await addItem(patch);
  }
  closeSheet();
  await refreshVault();
  toast(existing ? 'Perubahan disimpan ✓' : 'Item ditambahkan ✓');
}

// ============ Type-specific save sheets (hero triggers) ============
function savePromptSheet() {
  openSheet('💬 Simpan Prompt', 'Field Prompt saja — toppings & variabel muncul saat relevan', b => {
    b.innerHTML = '<div class="sheet-form">'
      + '<div><label>Judul</label><input class="f" id="pT" placeholder="mis. Review kode Go idiomatic…"></div>'
      + '<div><label>Tag <span class="field-hint">(pisah koma)</span></label><input class="f" id="pTag" placeholder="golang, review"></div>'
      + '<div><label>Isi Prompt <span class="field-hint">— pakai {{nama}} untuk variabel</span></label>'
      + '<textarea class="f" id="pBody" rows="4" placeholder="Kamu adalah reviewer senior. Tinjau kode {{bahasa}} berikut…"></textarea>'
      + '<div class="varchips" id="pVars"></div></div>'
      + '<div><button class="toppick-btn" id="pTopBtn">' + ICONS.plus + 'Pilih topping <span class="field-hint" style="display:inline">(opsional)</span></button>'
      + '<div class="topchips" id="pTops"></div></div>'
      + '<div class="btn-row"><button class="btn btn-g" id="pCancel">Batal</button><button class="btn btn-p" id="pSave">' + ICONS.check + 'Simpan Prompt</button></div></div>';
    const body = b.querySelector('#pBody'); const varsEl = b.querySelector('#pVars');
    body.addEventListener('input', () => {
      const found = []; let m; const re = /\{\{(\w+)\}\}/g;
      while ((m = re.exec(body.value))) { if (found.indexOf(m[1]) < 0) found.push(m[1]); }
      varsEl.innerHTML = found.length ? '<span style="font-size:10px;color:var(--muted);align-self:center">Variabel:</span>' + found.map(v => '<span class="varchip">{{' + v + '}}</span>').join('') : '';
    });
    getAllToppings().then(tops => {
      const topsEl = b.querySelector('#pTops');
      topsEl.innerHTML = tops.map(t => '<button class="topchip" data-t="' + esc(t.id) + '">' + esc(t.emoji || '') + ' ' + esc(t.name) + '</button>').join('');
      b.querySelector('#pTopBtn').addEventListener('click', () => topsEl.classList.toggle('show'));
      const selected = [];
      topsEl.querySelectorAll('.topchip').forEach(ch => ch.addEventListener('click', () => {
        ch.classList.toggle('on');
        const tid = ch.dataset.t;
        if (selected.includes(tid)) selected.splice(selected.indexOf(tid), 1); else selected.push(tid);
      }));
      b.querySelector('#pSave').addEventListener('click', async () => {
        const found = []; let m; const re = /\{\{(\w+)\}\}/g;
        while ((m = re.exec(body.value))) { if (found.indexOf(m[1]) < 0) found.push(m[1]); }
        const t = ($('#pT').value || '').trim() || 'Prompt tanpa judul';
        const tg = ($('#pTag').value || '').trim() || 'baru';
        await addItem({ type: 'prompt', title: t, tags: tg.split(',').map(s => s.trim()).filter(Boolean), body: body.value, toppings: selected, useCount: 0 });
        closeSheet(); await refreshVault(); toast('Prompt disimpan ✓' + (found.length ? ' · ' + found.length + ' variabel' : '') + (selected.length ? ' · ' + selected.length + ' topping' : ''));
      });
    });
    b.querySelector('#pCancel').addEventListener('click', closeSheet);
    setTimeout(() => b.querySelector('#pT').focus(), 120);
  });
}
function saveKonteksSheet() {
  // v3.7.1-FIX: Form konteks diperkaya — tujuan, auto-grab halaman, template
  const TUJUAN_OPTIONS = [
    ['system', 'Instruksi Sistem (system prompt)'],
    ['project', 'Konteks Proyek (stack, arsitektur)'],
    ['domain', 'Pengetahuan Domain (konsep, istilah)'],
    ['reference', 'Referensi (dokumen, spesifikasi)'],
    ['instruction', 'Instruksi Kerja (SOP, checklist)'],
    ['custom', 'Lainnya (bebas)']
  ];
  const tujuanOpts = TUJUAN_OPTIONS.map(o => '<option value="' + o[0] + '">' + o[1] + '</option>').join('');

  openSheet('📋 Simpan Konteks', 'Konteks adalah informasi dasar yang dibutuhkan AI', b => {
    b.innerHTML = '<div class="sheet-form">'
      + '<div><label>Tujuan <span class="field-hint">membantu AI memahami peran konteks ini</span></label><select class="f" id="cTujuan">' + tujuanOpts + '</select></div>'
      + '<div><label>Judul</label><input class="f" id="cT" placeholder="mis. Konteks proyek POS kasir…"></div>'
      + '<div><label>Tag <span class="field-hint">(pisah koma)</span></label><input class="f" id="cTag" placeholder="pos, arsitektur"></div>'
      + '<div style="display:flex;gap:6px;margin-bottom:4px">'
      +   '<button class="btn btn-g" id="cGrabPage" style="flex:1;padding:6px 8px;font-size:11px">' + ICONS.spark + ' Ambil dari halaman aktif</button>'
      +   '<button class="btn btn-g" id="cFromTemplate" style="flex:1;padding:6px 8px;font-size:11px">📄 Dari template</button>'
      + '</div>'
      + '<div><label>Konteks</label><textarea class="f" id="cBody" rows="6" placeholder="Proyek ini pakai React + TypeScript, state Zustand…\n\nTujuan: ...\nStack: ...\nKonvensi: ..."></textarea></div>'
      + '<div class="btn-row"><button class="btn btn-g" id="cCancel">Batal</button><button class="btn btn-p" id="cSave">' + ICONS.check + 'Simpan Konteks</button></div></div>';

    // v3.7.1-FIX: Ambil info dari halaman aktif (judul + URL + meta)
    b.querySelector('#cGrabPage').addEventListener('click', async () => {
      try {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]) {
          const title = tabs[0].title || '';
          const url = tabs[0].url || '';
          // Jika judul kosong, coba grab dari konten halaman
          let pageContent = '';
          try {
            const res = await browser.tabs.sendMessage(tabs[0].id, { type: 'GET_PAGE_CONTEXT' });
            if (res?.ok) pageContent = res.text || '';
          } catch (e) {}
          const body = $('#cBody');
          if (body && !body.value.trim()) {
            body.value = '[Halaman: ' + title + ']\n[URL: ' + url + ']' + (pageContent ? '\n\n' + pageContent.slice(0, 2000) : '');
            if (!$('#cT').value.trim()) $('#cT').value = title.slice(0, 60) || 'Konteks dari halaman';
          }
          toast('📋 Info halaman diambil');
        }
      } catch (e) { toast('Gagal mengambil info halaman', false); }
    });

    // v3.7.1-FIX: Template konteks
    b.querySelector('#cFromTemplate').addEventListener('click', () => {
      const templates = [
        { label: 'Konteks Proyek', text: '## Proyek: [NAMA]\n\n### Stack\n- Frontend: \n- Backend: \n- Database: \n\n### Arsitektur\n\n### Konvensi\n- Naming: \n- Struktur folder: \n' },
        { label: 'Instruksi Sistem', text: 'Kamu adalah asisten ahli dalam bidang [DOMAIN].\n\n### Aturan\n1. Selalu jawab dalam Bahasa Indonesia.\n2. Gunakan format yang terstruktur.\n3. Berikan contoh ketika menjelaskan konsep.\n\n### Batasan\n- Jangan membuat informasi yang tidak diminta.\n' },
        { label: 'Referensi Dokumen', text: '## Dokumen Referensi\n\n### Sumber\n- Judul: \n- URL: \n- Tanggal: \n\n### Ringkasan\n\n### Poin Penting\n1. \n2. \n3. \n' },
        { label: 'SOP / Checklist', text: '## SOP: [NAMA PROSES]\n\n### Tujuan\n\n### Langkah-langkah\n1. [ ] \n2. [ ] \n3. [ ] \n\n### Catatan\n\n' }
      ];
      let html = '<div style="padding:8px 0">' + templates.map((t, i) => '<button class="act" data-tpl="' + i + '" style="margin-bottom:4px"><div>' + t.label + '</div></button>').join('') + '</div>';
      const existing = b.querySelector('.tpl-picker');
      if (existing) existing.remove();
      const div = document.createElement('div');
      div.className = 'tpl-picker';
      div.innerHTML = html;
      b.querySelector('.sheet-form').insertBefore(div, b.querySelector('#cBody').parentElement);
      div.querySelectorAll('[data-tpl]').forEach(btn => btn.addEventListener('click', () => {
        const tpl = templates[parseInt(btn.dataset.tpl)];
        if (tpl && $('#cBody')) {
          $('#cBody').value = tpl.text;
          div.remove();
          toast('Template "' + tpl.label + '" dimuat');
        }
      }));
    });

    b.querySelector('#cCancel').addEventListener('click', closeSheet);
    b.querySelector('#cSave').addEventListener('click', async () => {
      const t = ($('#cT').value || '').trim() || 'Konteks tanpa judul';
      const tg = ($('#cTag').value || '').trim() || 'baru';
      const tujuan = ($('#cTujuan')?.value || 'custom');
      const bodyVal = $('#cBody').value;
      // Jika tujuan dipilih, prepends header ke body
      const tujuanLabel = TUJUAN_OPTIONS.find(o => o[0] === tujuan);
      const finalBody = tujuan !== 'custom' ? '[Tujuan: ' + (tujuanLabel ? tujuanLabel[1] : tujuan) + ']\n\n' + bodyVal : bodyVal;
      await addItem({ type: 'context', title: t, tags: tg.split(',').map(s => s.trim()).filter(Boolean), body: finalBody, contextPurpose: tujuan, useCount: 0 });
      closeSheet(); await refreshVault(); toast('Konteks disimpan ✓' + (tujuan !== 'custom' ? ' · ' + tujuanLabel[1] : ''));
    });
    setTimeout(() => b.querySelector('#cT').focus(), 120);
  });
}
async function saveLinkSheet() {
  let autoUrl = '', autoTitle = '';
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) { autoUrl = tabs[0].url || ''; autoTitle = tabs[0].title || ''; }
  } catch (e) {}
  openSheet('🔗 Simpan Link', 'URL & judul terisi otomatis dari tab aktif', b => {
    b.innerHTML = '<div class="sheet-form">'
      + '<div><label>URL <span class="field-hint">⚡ auto-fill dari tab aktif</span></label><input class="f" id="lUrl" value="' + esc(autoUrl) + '"></div>'
      + '<div><label>Judul <span class="field-hint">⚡ auto-fill dari title halaman</span></label><input class="f" id="lT" value="' + esc(autoTitle) + '"></div>'
      + '<div><label>Tag <span class="field-hint">(pisah koma)</span></label><input class="f" id="lTag" placeholder="referensi, riset"></div>'
      + '<div class="btn-row"><button class="btn btn-g" id="lCancel">Batal</button><button class="btn btn-p" id="lSave">' + ICONS.check + 'Simpan Link</button></div></div>';
    b.querySelector('#lCancel').addEventListener('click', closeSheet);
    b.querySelector('#lSave').addEventListener('click', async () => {
      const url = ($('#lUrl').value || '').trim();
      if (!url) { toast('URL wajib', false); return; }
      const t = ($('#lT').value || '').trim() || url;
      const tg = ($('#lTag').value || '').trim() || 'link';
      await addItem({ type: 'link', title: t, tags: tg.split(',').map(s => s.trim()).filter(Boolean), body: url, linkUrl: url, linkTitle: t, useCount: 0 });
      closeSheet(); await refreshVault(); toast('Link disimpan ✓');
    });
  });
}
function saveBundleSheet() {
  openSheet('📦 Buat Bundle', 'Pilih ≥2 item untuk digabung jadi project session', b => {
    // v3.7.2 (Issue 1): Sertakan juga screenshot & snapshot sebagai kandidat (sebelumnya hanya prompt/context/link).
    const candidates = (currentVault?.items || []).filter(i => ['prompt', 'context', 'link', 'screenshot', 'snapshot'].includes(i.type) && !i.archived);
    b.innerHTML = '<div class="sheet-form">'
      + '<div><label>Nama Bundle</label><input class="f" id="bT" placeholder="mis. Riset kompetitor…"></div>'
      + '<div><label>Pilih item <span class="field-hint" id="bCount">0 dipilih</span></label>'
      + '<div class="picklist">' + candidates.map(it => {
        const T = TYPE[it.type] || { icon: '' };
        return '<label class="pickrow"><input type="checkbox" value="' + it.id + '"><span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(it.title) + '</span><span class="pt-type">' + T.label + '</span></label>';
      }).join('') + '</div></div>'
      + '<div class="btn-row"><button class="btn btn-g" id="bCancel">Batal</button><button class="btn btn-p" id="bSave">' + ICONS.check + 'Buat Bundle</button></div></div>';
    const boxes = [...b.querySelectorAll('input[type=checkbox]')];
    boxes.forEach(x => x.addEventListener('change', () => { b.querySelector('#bCount').textContent = boxes.filter(c => c.checked).length + ' dipilih'; }));
    b.querySelector('#bCancel').addEventListener('click', closeSheet);
    b.querySelector('#bSave').addEventListener('click', async () => {
      const n = boxes.filter(c => c.checked).length;
      if (n < 2) { toast('Pilih minimal 2 item', false); return; }
      const name = ($('#bT').value || '').trim() || 'Bundle tanpa nama';
      const ids = boxes.filter(c => c.checked).map(c => c.value);
      await addBundle(name, ids);
      closeSheet(); await refreshVault(); toast('Bundle "' + name + '" dibuat ✓ · ' + n + ' item');
    });
  });
}
async function snapshotFlow() {
  if (!currentAiDomain) { toast('📸 Snapshot hanya aktif di halaman AI', false); return; }
  toast('Menganalisis percakapan…');
  try {
    const res = await browser.runtime.sendMessage({ type: 'QUICK_SNAPSHOT' });
    if (res?.ok) {
      await refreshVault();
      toast('📸 Snapshot tersimpan ✓');
      if (!document.body.classList.contains('rf-sidebar-body')) setTimeout(() => window.close(), 800);
    } else {
      const err = res?.error || 'gagal';
      let msg = 'Gagal';
      if (err === 'no_active_tab') msg = 'Tidak ada tab aktif';
      else if (err.includes('Could not establish connection')) msg = 'Bukan halaman AI';
      else msg = 'Error: ' + String(err).slice(0, 40);
      toast(msg, false);
    }
  } catch (e) { toast('Error: ' + e.message, false); }
}
async function doShot(mode) {
  // mode: 'entire' | 'visible' | 'selection' | undefined (shows picker)
  // Guard against accidental event-object args (defensive: doShot must never
  // receive a PointerEvent — if it does, treat as undefined to show picker)
  if (mode && typeof mode !== 'string') mode = undefined;
  const modeLabel = mode === 'selection' ? 'area' : mode === 'visible' ? 'viewport' : mode === 'entire' ? 'full page' : 'picker';
  toast('🖼️ Menangkap (' + modeLabel + ')…');
  try {
    const res = await browser.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT', mode });
    if (res?.ok) {
      toast('Tersimpan — siap PDF/JPG ✓');
      if (!document.body.classList.contains('rf-sidebar-body')) setTimeout(() => window.close(), 700);
    } else {
      const err = res?.error || 'gagal';
      let msg = 'Gagal';
      if (err === 'no_active_tab') msg = 'Tidak ada tab aktif';
      else if (err === 'not_http_page') msg = 'Bukan halaman web';
      else msg = 'Error: ' + String(err).slice(0, 40);
      toast(msg, false);
    }
  } catch (e) { toast('Error: ' + e.message, false); }
}

// ============ AI Tools launcher ============
function aiToolsSheet() {
  openSheet('Alat AI', 'Pilih alat AI — buka di tab baru', b => {
    const pinned = AI_TOOLS.filter(t => t.pinned);
    const others = AI_TOOLS.filter(t => !t.pinned);
    const row = (t) => '<button class="act" data-url="' + esc(t.url) + '" data-name="' + esc(t.name) + '">' + ICONS.spark + '<div style="flex:1">' + esc(t.name) + '<div class="ad">' + esc(t.url) + '</div></div><span class="ad">Buka</span></button>';
    let html = '';
    if (pinned.length) html += '<div class="sec-label" style="padding:4px 10px">⭐ Sering dipakai</div>' + pinned.map(row).join('');
    const groups = groupByRegion(others);
    for (const [region, tools] of Object.entries(groups)) {
      html += '<div class="sec-label" style="padding:8px 10px 4px">' + esc(region) + '</div>' + tools.map(row).join('');
    }
    b.innerHTML = html;
    b.querySelectorAll('.act').forEach(a => a.addEventListener('click', async () => {
      closeSheet();
      await browser.tabs.create({ url: a.dataset.url });
      toast('⚡ ' + a.dataset.name + ' dibuka');
    }));
  });
}

// ============ Add item menu ============
function addItemMenu() {
  openSheet('Tambah Item Baru', 'Pilih tipe — form selalu spesifik', b => {
    const opts = [
      ['💬 Prompt', savePromptSheet], ['📋 Konteks', saveKonteksSheet], ['🔗 Link', saveLinkSheet],
      ['📦 Bundle', saveBundleSheet], ['📸 Snapshot', snapshotFlow],
      ['🖼️ Screenshot (pilih mode)', () => doShot()],
      ['✂️ Screenshot area', () => doShot('selection')],
      ['📱 Screenshot viewport', () => doShot('visible')],
      ['📄 Screenshot seluruh halaman', () => doShot('entire')],
      ['📝 Catatan', () => { setView('notes'); newNote(); }]
    ];
    b.innerHTML = opts.map((o, i) => '<button class="act" data-i="' + i + '">' + o[0] + '</button>').join('');
    b.querySelectorAll('.act').forEach(a => a.addEventListener('click', () => { closeSheet(); setTimeout(opts[a.dataset.i][1], 80); }));
    b.insertAdjacentHTML('beforeend', '<div class="sheet-note">💡 Screenshot punya 3 mode: <b>area</b> (seret kotak), <b>viewport</b> (bagian terlihat), <b>seluruh halaman</b> (scroll-stitch).</div>');
  });
}

// ============ Command palette ============
const COMMANDS = [
  { k: 'prompt', t: 'Simpan Prompt baru', s: 'Form khusus: judul, isi, toppings, variabel', run: savePromptSheet },
  { k: 'konteks', t: 'Simpan Konteks baru', s: 'Form khusus: judul, tag, konteks', run: saveKonteksSheet },
  { k: 'link', t: 'Simpan Link tab aktif', s: 'URL & judul auto-fill', run: saveLinkSheet },
  { k: 'bundle', t: 'Buat Bundle', s: 'Gabungkan beberapa item', run: saveBundleSheet },
  { k: 'catatan', t: 'Catatan Baru', s: 'Scratchpad auto-save · tab Catatan', run: () => { setView('notes'); newNote(); } },
  { k: 'snap', t: 'Snapshot percakapan AI', s: 'Simpan chat sebagai item', run: snapshotFlow },
  { k: 'shot', t: 'Screenshot halaman', s: 'Tangkap → PDF/JPG/PNG', run: () => doShot() },
  { k: 'shot-area', t: 'Screenshot area (seret kotak)', s: 'Seleksi area spesifik — ideal cuplikan UI', run: () => doShot('selection') },
  { k: 'shot-visible', t: 'Screenshot viewport', s: 'Hanya bagian terlihat', run: () => doShot('visible') },
  { k: 'shot-full', t: 'Screenshot seluruh halaman', s: 'Scroll-stitch penuh', run: () => doShot('entire') },
  { k: 'cache', t: 'Clear Cache', s: 'Bersihkan data (dengan konfirmasi)', run: () => toolPage('cache') },
  { k: 'shalat', t: 'Buka Waktu Shalat', s: 'Jadwal + countdown', run: () => toolPage('shalat') },
  { k: 'volume', t: 'Volume Booster', s: 'Perbesar volume hingga 600%', run: () => toolPage('volume') },
  { k: 'tema', t: 'Ganti tema', s: 'Terang / gelap', run: toggleTheme },
  { k: 'ai', t: 'Pindah AI Tool', s: 'Buka AI tool lain', run: aiToolsSheet },
  { k: 'alat', t: 'Buka tab Alat', s: 'Semua alat dalam satu tempat', run: () => setView('tools') }
];
function renderSearch() {
  const q = currentQuery.trim(); const has = q.length > 0;
  $('#list').style.display = has ? 'none' : '';
  const cr = $('#cmdres'); cr.style.display = has ? '' : 'none';
  if (!has) { renderList(); return; }
  const cmdMode = q.startsWith('>');
  if (cmdMode) {
    const cq = q.slice(1).toLowerCase();
    const cs = COMMANDS.filter(c => c.k.indexOf(cq) >= 0 || c.t.toLowerCase().indexOf(cq) >= 0);
    cr.innerHTML = cs.length
      ? '<div class="sec-label">Perintah</div>' + cs.map(c => '<div class="cmd-item" data-cmd="' + c.k + '"><div class="ci">' + ICONS.zap + '</div><div><div class="ct">' + esc(c.t) + '</div><div class="cs">' + esc(c.s) + '</div></div><kbd>↵</kbd></div>').join('')
      : '<div class="empty"><div class="big">😶</div>Perintah tidak ditemukan.</div>';
    cr.querySelectorAll('.cmd-item').forEach(el => el.addEventListener('click', () => { const c = COMMANDS.find(x => x.k === el.dataset.cmd); c.run(); clearSearch(); }));
  } else {
    const nq = q.toLowerCase();
    const cs2 = COMMANDS.filter(c => c.k.indexOf(nq) >= 0 || c.t.toLowerCase().indexOf(nq) >= 0).slice(0, 3);
    // v3.7.2 (Issue 4): Cari di SEMUA tipe item (prompt, konteks, link, bundle, snapshot, screenshot)
    // termasuk body, tags, linkUrl, source.url, source.title, dan bundle member titles.
    const its = getVaultItems().filter(i => searchableTextFor(i).indexOf(nq) >= 0);
    // v3.7.2 (Issue 4): Cari juga di catatan (title + body + group).
    const noteHits = (currentNotes || []).filter(n => {
      const text = ((n.title || '') + ' ' + (n.body || '') + ' ' + (n.group || '') + ' note catatan').toLowerCase();
      return text.indexOf(nq) >= 0;
    }).slice(0, 5);
    let h = '';
    if (cs2.length) h += '<div class="sec-label">Perintah</div>' + cs2.map(c => '<div class="cmd-item" data-cmd="' + c.k + '"><div class="ci">' + ICONS.zap + '</div><div><div class="ct">' + esc(c.t) + '</div><div class="cs">' + esc(c.s) + '</div></div></div>').join('');
    if (its.length) h += '<div class="sec-label">Item · ' + its.length + '</div>' + its.map(it => {
      const T = TYPE[it.type] || { label: it.type, icon: '' };
      const tagsStr = Array.isArray(it.tags) ? it.tags.join(', ') : (it.tags || '');
      return '<div class="cmd-item" data-item="' + it.id + '"><div class="item-ic t-' + it.type + '" style="width:28px;height:28px">' + T.icon + '</div><div><div class="ct" style="font-size:12.5px">' + esc(it.title) + '</div><div class="cs">' + T.label + ' · ' + esc(tagsStr) + '</div></div></div>';
    }).join('');
    if (noteHits.length) h += '<div class="sec-label">Catatan · ' + noteHits.length + '</div>' + noteHits.map(n => {
      const title = n.title || (n.body || '').slice(0, 60) || '(kosong)';
      const group = n.group ? ' · 📁 ' + esc(n.group) : '';
      return '<div class="cmd-item" data-note="' + n.id + '"><div class="item-ic t-context" style="width:28px;height:28px">📝</div><div><div class="ct" style="font-size:12.5px">' + esc(title) + '</div><div class="cs">Catatan' + group + ' · ' + timeAgo(n.updatedAt || n.createdAt) + '</div></div></div>';
    }).join('');
    if (!its.length && !cs2.length && !noteHits.length) h = '<div class="empty"><div class="big">🔍</div>Tidak ada hasil untuk "' + esc(q) + '".</div>';
    cr.innerHTML = h;
    cr.querySelectorAll('[data-cmd]').forEach(el => el.addEventListener('click', () => { COMMANDS.find(c => c.k === el.dataset.cmd).run(); clearSearch(); }));
    cr.querySelectorAll('[data-item]').forEach(el => el.addEventListener('click', () => { primaryAction(el.dataset.item); clearSearch(); }));
    cr.querySelectorAll('[data-note]').forEach(el => el.addEventListener('click', () => { setView('notes'); setTimeout(() => openNoteEditor(el.dataset.note), 60); clearSearch(); }));
  }
}
function clearSearch() { $('#search').value = ''; currentQuery = ''; renderSearch(); }

// ============ View switcher ============
function setView(v) {
  currentView = v;
  $('#tabHome').classList.toggle('on', v === 'home');
  $('#tabNotes').classList.toggle('on', v === 'notes');
  $('#tabTools').classList.toggle('on', v === 'tools');
  $('#vaultView').classList.toggle('hide', v !== 'home');
  $('#notesView').classList.toggle('hide', v !== 'notes');
  $('#toolsView').classList.toggle('hide', v !== 'tools');
  const homeOnly = (v === 'home');
  $('#cmdWrap').style.display = homeOnly ? 'flex' : 'none';
  document.querySelector('.tiles').style.display = homeOnly ? 'grid' : 'none';
  document.querySelector('.strip').style.display = homeOnly ? '' : 'none';
  $('#page').classList.remove('in');
  if (v === 'notes') renderNotes();
}

// ============ Notes ============
// v3.7.2 (Issue 5): 12 warna (sebelumnya 6) — tambah orange, red, teal, indigo, slate, rose.
const NCOLORS = ['default', 'yellow', 'green', 'blue', 'pink', 'purple', 'orange', 'red', 'teal', 'indigo', 'slate', 'rose'];
function notesSorted() {
  // v3.7.2 (Issue 5): Saring berdasarkan currentNoteGroup kalau dipilih.
  let arr = currentNotes.filter(n => !n.archived);
  if (currentNoteGroup) {
    arr = arr.filter(n => (n.group || '') === currentNoteGroup);
  }
  return arr.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
}
async function renderNotes() {
  currentNotes = await getNotes();
  const list = $('#notesList');
  const badge = $('#notesBadge');
  if (badge) { badge.style.display = currentNotes.length ? 'grid' : 'none'; badge.textContent = currentNotes.length; }
  // v3.7.2 (Issue 5): Group filter chips
  const groups = await getNoteGroups();
  let groupChipsHtml = '';
  if (groups.length > 0) {
    groupChipsHtml = '<div class="ngroups" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;overflow-x:auto;padding-bottom:2px">'
      + '<button class="ngroup-chip' + (currentNoteGroup === '' ? ' on' : '') + '" data-ngroup="" style="padding:4px 10px;border:1px solid var(--border);border-radius:999px;font-size:11px;background:' + (currentNoteGroup === '' ? 'var(--primary-soft)' : 'transparent') + ';color:' + (currentNoteGroup === '' ? 'var(--primary)' : 'var(--text-2)') + ';cursor:pointer;white-space:nowrap">Semua (' + currentNotes.filter(n => !n.archived).length + ')</button>'
      + groups.map(g => {
          const on = currentNoteGroup === g.name;
          return '<button class="ngroup-chip' + (on ? ' on' : '') + '" data-ngroup="' + esc(g.name) + '" style="padding:4px 10px;border:1px solid var(--border);border-radius:999px;font-size:11px;background:' + (on ? 'var(--primary-soft)' : 'transparent') + ';color:' + (on ? 'var(--primary)' : 'var(--text-2)') + ';cursor:pointer;white-space:nowrap">' + esc(g.name) + ' (' + g.count + ')</button>';
        }).join('')
      + '</div>';
  }
  if (!currentNotes.length) {
    list.innerHTML = groupChipsHtml + '<div class="notes-empty"><div class="big">📝</div>Belum ada catatan.<br><span style="font-size:11px">Klik <b>Catatan Baru</b> — tersimpan otomatis.</span></div>';
    bindGroupChips();
    return;
  }
  const sorted = notesSorted();
  if (!sorted.length) {
    list.innerHTML = groupChipsHtml + '<div class="notes-empty"><div class="big">📭</div>Tidak ada catatan di grup "' + esc(currentNoteGroup) + '".<br><span style="font-size:11px">Pilih grup lain atau buat catatan baru di grup ini.</span></div>';
    bindGroupChips();
    return;
  }
  list.innerHTML = groupChipsHtml + sorted.map(n => {
    const titleHtml = n.title ? '<div class="note-title">' + esc(n.title) + '</div>' : '';
    const preview = (n.body || '').slice(0, 200).replace(/\n+/g, ' ');
    const previewHtml = preview ? esc(preview) : '<em style="color:var(--muted)">(kosong)</em>';
    const groupTag = n.group ? '<span class="ngroup-tag">📁 ' + esc(n.group) + '</span>' : '';
    return '<div class="note-card nc-' + (n.color || 'default') + '" data-nid="' + n.id + '">'
      + titleHtml
      + '<div class="note-body-txt">' + previewHtml + '</div>'
      + '<div class="note-meta">' + (n.pinned ? '<span class="pin">📌</span>' : '') + groupTag + '<span class="cdot"></span><span>' + timeAgo(n.updatedAt || n.createdAt) + '</span></div>'
      + '</div>';
  }).join('');
  list.querySelectorAll('.note-card').forEach(c => c.addEventListener('click', () => openNoteEditor(c.dataset.nid)));
  bindGroupChips();
}
function bindGroupChips() {
  $$('.ngroup-chip').forEach(ch => ch.addEventListener('click', () => {
    currentNoteGroup = ch.dataset.ngroup || '';
    renderNotes();
  }));
}
async function newNote() {
  // v3.7.2 (Issue 5): Catatan baru otomatis masuk grup yang sedang difilter.
  const n = await addNote('', { color: 'yellow', pinned: false, group: currentNoteGroup || '' });
  await renderNotes();
  openNoteEditor(n.id);
}
function openNoteEditor(noteId) {
  editingNoteId = noteId;
  const n = currentNotes.find(x => x.id === noteId);
  if (!n) return;
  openPage('📝 Catatan');
  $('#pageBody').innerHTML =
    '<div class="card" style="margin-bottom:10px">'
    + '<input class="f" id="nTitle" value="' + esc(n.title || '') + '" placeholder="Judul (opsional) — dikosongkan pakai preview isi" style="margin-bottom:8px;font-weight:600">'
    + '<textarea class="f" id="nBody" rows="9" placeholder="Tulis catatan sementara di sini… (auto-save)" style="font-family:ui-monospace,Menlo,monospace;font-size:12.5px;line-height:1.55">' + esc(n.body || '') + '</textarea>'
    + '</div>'
    + '<div class="card"><h3>Grup / Proyek</h3>'
    + '<input class="f" id="nGroup" value="' + esc(n.group || '') + '" placeholder="mis. Proyek A, Riset B (opsional)" style="margin-bottom:8px">'
    + '<div class="hintbox" style="font-size:11px">Catatan dengan nama grup yang sama akan terkumpul di filter grup di atas daftar.</div>'
    + '</div>'
    + '<div class="card"><h3>Warna</h3><div class="ndots">' + NCOLORS.map(c => '<button class="d-' + c + (n.color === c ? ' on' : '') + '" data-c="' + c + '" title="' + c + '"></button>').join('') + '</div></div>'
    + '<div class="hintbox">🕑 Terakhir disimpan: <b id="nMeta">' + timeAgo(n.updatedAt || n.createdAt) + '</b> · Catatan tersimpan lokal & ikut backup otomatis.</div>';
  $('#pageFoot').innerHTML =
    '<button class="btn btn-d" id="nDel" style="flex:none">Hapus</button><span style="flex:1"></span>'
    + '<button class="btn btn-g" id="nArchive" style="flex:none">' + (n.archived ? '📤 Unarsip' : '📦 Arsipkan') + '</button>'
    + '<button class="btn btn-g" id="nPin" style="flex:none">' + (n.pinned ? '📌 Lepas pin' : '📌 Pin') + '</button>'
    + '<button class="btn btn-g" id="nCopy" style="flex:none">Salin</button>'
    + '<button class="btn btn-p" id="nDone" style="flex:none">Selesai</button>';
  const ta = $('#nBody');
  const titleInput = $('#nTitle');
  const groupInput = $('#nGroup');
  function markSaved() {
    const st = $('#pageSaveState'); st.textContent = 'Tersimpan ✓'; st.classList.add('ok');
    renderNotes();
  }
  // v3.7.2 (Issue 5): Auto-save title + body + group dengan debounce yang sama.
  function scheduleSave() {
    const st = $('#pageSaveState'); st.textContent = 'Menyimpan…'; st.classList.remove('ok');
    clearTimeout(noteSaveTimer);
    noteSaveTimer = setTimeout(async () => {
      await updateNote(n.id, {
        title: titleInput.value.trim(),
        body: ta.value,
        group: groupInput.value.trim(),
        updatedAt: new Date().toISOString()
      });
      markSaved();
    }, 800);
  }
  ta.addEventListener('input', scheduleSave);
  titleInput.addEventListener('input', scheduleSave);
  groupInput.addEventListener('input', scheduleSave);
  $('#pageBody').querySelectorAll('.ndots button').forEach(d => {
    d.addEventListener('click', async () => {
      $('#pageBody').querySelectorAll('.ndots button').forEach(x => x.classList.remove('on'));
      d.classList.add('on');
      await updateNote(n.id, { color: d.dataset.c });
      markSaved();
    });
  });
  $('#nPin').addEventListener('click', async () => {
    await toggleNotePin(n.id);
    const updated = currentNotes.find(x => x.id === n.id);
    if (updated) updated.pinned = !updated.pinned;
    $('#nPin').textContent = updated.pinned ? '📌 Lepas pin' : '📌 Pin';
    markSaved();
    toast(updated.pinned ? '📌 Disematkan' : 'Pin dilepas');
  });
  // v3.7.2 (Issue 5): Arsipkan catatan tanpa hapus (paralel dengan item vault).
  $('#nArchive').addEventListener('click', async () => {
    const updated = currentNotes.find(x => x.id === n.id);
    const newVal = !(updated?.archived);
    await updateNote(n.id, { archived: newVal });
    if (updated) updated.archived = newVal;
    $('#nArchive').textContent = newVal ? '📤 Unarsip' : '📦 Arsipkan';
    markSaved();
    toast(newVal ? '📦 Catatan diarsipkan' : '📤 Dikeluarkan dari arsip');
  });
  $('#nCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(n.body || ''); toast('📋 Catatan disalin'); }
    catch (e) { toast('Gagal salin', false); }
  });
  $('#nDone').addEventListener('click', async () => {
    const cur = currentNotes.find(x => x.id === n.id);
    if (cur && !cur.body?.trim() && !cur.title?.trim()) { await deleteNote(n.id); }
    await renderNotes();
    closePage();
  });
  $('#nDel').addEventListener('click', () => {
    openSheet('Hapus catatan?', 'Tidak bisa dibatalkan', b => {
      b.innerHTML = '<div class="confirmstrip"><span style="flex:1">Hapus catatan ini permanen?</span>'
        + '<button class="btn btn-g" data-c="0">Batal</button><button class="btn btn-d" data-c="1">Hapus</button></div>';
      b.querySelector('[data-c="0"]').addEventListener('click', closeSheet);
      b.querySelector('[data-c="1"]').addEventListener('click', async () => {
        await deleteNote(n.id);
        closeSheet(); await renderNotes(); closePage(); toast('Catatan dihapus');
      });
    });
  });
  setTimeout(() => ta.focus(), 200);
}

// ============ Tools drawer ============
const TOOLS = [
  ['shalat', 'Waktu Shalat', 'Muhammadiyah · countdown', ICONS.mosque],
  ['habits', 'Habits', 'Ngaji & olahraga harian', ICONS.heart],
  ['puasa', 'Puasa Sunnah', 'Kalender Islam & jadwal', ICONS.moonstar],
  ['volume', 'Penguat Volume', 'Hingga 600% per tab', ICONS.vol],
  ['kontrol', 'Kontrol Situs', 'Blocker + filter konten', ICONS.shield],
  ['cache', 'Bersihkan Cache', '9 tipe data · konfirmasi', ICONS.trash, 'warn'],
  ['askai', 'Tanya AI', 'Tanya soal teks terseleksi', ICONS.spark],
  ['backup', 'Backup', 'Ekspor terenkripsi AES', ICONS.archive],
  ['keys', 'Pintasan', 'Semua shortcut', ICONS.kb]
];
function renderTools() {
  $('#toolgrid').innerHTML = TOOLS.map(t => '<button class="tool' + (t[4] ? ' ' + t[4] : '') + '" data-tool="' + t[0] + '"><div class="tool-ic">' + t[3] + '</div><div><div class="tool-n">' + t[1] + '</div><div class="tool-d">' + t[2] + '</div></div></button>').join('');
  $$('#toolgrid .tool').forEach(t => t.addEventListener('click', () => toolPage(t.dataset.tool)));
}
function toolPage(k) {
  closeSheet();
  const names = { shalat: '🕌 Waktu Shalat', habits: '❤️ Kebiasaan', puasa: '🌙 Puasa Sunnah', volume: '🔊 Penguat Volume', kontrol: '🛡 Kontrol Situs', cache: '🗑 Bersihkan Cache', askai: '✨ Tanya AI', backup: '📦 Cadangkan & Pulihkan', keys: '⌨️ Pintasan Keyboard' };
  openPage(names[k] || 'Alat');
  const B = $('#pageBody');
  if (k === 'shalat') renderShalatPage(B);
  else if (k === 'habits') renderHabitsPage(B);
  else if (k === 'puasa') renderPuasaPage(B);
  else if (k === 'volume') renderVolumePage(B);
  else if (k === 'cache') renderCachePage(B);
  else if (k === 'keys') renderKeysPage(B);
  else if (k === 'kontrol') renderKontrolSitusPage(B);
  else renderToolStubPage(B, k, names[k]);
}
function renderShalatPage(B) {
  const s = currentVault?.settings || {};
  if (!s.prayerEnabled || typeof s.prayerLatitude !== 'number') {
    B.innerHTML = '<div class="card" style="text-align:center;padding:26px 16px"><div style="font-size:30px;margin-bottom:8px">🕌</div>'
      + '<div style="font-size:12.5px;color:var(--text-2);line-height:1.55;max-width:250px;margin:0 auto 14px">Aktifkan jadwal shalat harian dengan metode Muhammadiyah (Subuh -18°, Isya -18°).</div>'
      + '<button class="btn btn-p" id="shSetup">Setup Sekarang</button></div>';
    $('#shSetup').addEventListener('click', openPrayerSetup);
    return;
  }
  const times = prayerTimesCache || s.prayerCachedTimes;
  const next = times ? getNextPrayerIncludingSunnah(times.timings) : null;
  const fmt = s.prayerTimeFormat === '12h' ? to12Hour : (t) => t;
  const countdown = next ? formatCountdown(next.minutesUntil) : '—';
  // v3.4: Ambil daftar sholat sunnah dari library
  const sunnahs = times ? (getSunnahPrayers(times.timings) || []) : [];
  // Bangun kartu sholat sunnah
  const sunnahCard = sunnahs.length > 0
    ? '<div class="card"><h3>🌟 Sholat Sunnah (' + sunnahs.length + ')</h3>'
      + '<div class="hintbox" style="margin-bottom:8px;font-size:10.5px;line-height:1.5">Waktu mustahab — dianjurkan, bukan wajib. Pahala berlipat bila diamalkan secara konsisten.</div>'
      + sunnahs.map(function (sn) {
          // Highlight kalau sunnah ini adalah next prayer
          const isNextSunnah = next && next.isSunnah && next.name === sn.name;
          return '<div class="rf-sunnah-row' + (isNextSunnah ? ' next' : '') + '">'
            + '<div class="rf-sunnah-main">'
            +   '<span class="rf-sunnah-icon">' + sn.icon + '</span>'
            +   '<div>'
            +     '<div class="rf-sunnah-name">' + esc(sn.name) + (isNextSunnah ? ' · berikutnya' : '') + '</div>'
            +     '<div class="rf-sunnah-desc">' + esc(sn.desc) + '</div>'
            +   '</div>'
            + '</div>'
            + '<div class="rf-sunnah-time">' + fmt(sn.time) + '</div>'
          + '</div>';
        }).join('')
      + '</div>'
    : '';
  B.innerHTML = '<div class="card" style="background:linear-gradient(135deg,#065f46,#047857);color:#ecfdf5;border:none">'
    + '<div style="font-size:11px;opacity:.85">' + esc(s.prayerLocation || 'Lokasi') + ' · ' + (times?.date || '') + '</div>'
    + '<div style="font-size:26px;font-weight:750;margin:6px 0 2px;letter-spacing:-.02em">' + (next ? (next.isSunnah ? '🌟 ' : '') + next.name + ' ' + fmt(next.time) : '—') + '</div>'
    + '<div style="font-size:12px;opacity:.9">' + (next ? '−' + countdown + (next.isToday ? '' : ' (besok)') : '') + '</div></div>'
    + '<div class="card"><h3>6 waktu · metode Muhammadiyah (−18°/−18°)</h3>'
    + (times ? [['Subuh', times.timings.Fajr, 'Fajr'], ['Terbit', times.timings.Sunrise, 'Sunrise'], ['Dzuhur', times.timings.Dhuhr, 'Dhuhr'], ['Ashar', times.timings.Asr, 'Asr'], ['Magrib', times.timings.Maghrib, 'Maghrib'], ['Isya', times.timings.Isha, 'Isha']].map(p => {
      const isNext = next && next.key === p[2];
      return '<div class="krow" style="padding:5px 0' + (isNext ? ';color:var(--green);font-weight:700' : '') + '"><span>' + p[0] + '</span><span>' + fmt(p[1]) + '</span></div>';
    }).join('') : '<div style="color:var(--muted);font-size:11px">Memuat…</div>') + '</div>'
    + sunnahCard
    + '<div class="btn-row"><button class="btn btn-g" id="shRefresh">Refresh</button><button class="btn btn-p" id="shSetup">Ubah Lokasi</button></div>';
  $('#shRefresh').addEventListener('click', async () => {
    await saveSettings({ prayerCachedTimes: null });
    await refreshVault();
    await updatePrayerStrip();
    toolPage('shalat');
    toast('Jadwal diperbarui ✓');
  });
  $('#shSetup').addEventListener('click', openPrayerSetup);
}
async function renderHabitsPage(B) {
  const s = currentVault?.settings || {};
  let qStatus = null, eStatus = null, habits = null;
  try { if (s.quranEnabled !== false) qStatus = await getQuranStatus(s); } catch (e) {}
  try { if (s.exerciseEnabled !== false) eStatus = await getExerciseStatus(s); } catch (e) {}
  try { habits = await getHabits(); } catch (e) {}

  // Today's date + hijri
  const today = new Date();
  const dayNames = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  const monthNames = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const todayStr = dayNames[today.getDay()] + ', ' + today.getDate() + ' ' + monthNames[today.getMonth()];
  const cachedHijri = currentVault?.settings?.prayerCachedTimes?.hijri;
  const hijriStr = cachedHijri ? (parseHijriString(cachedHijri) ? (parseInt(parseHijriString(cachedHijri).day,10) + ' ' + HIJRI_MONTHS[parseInt(parseHijriString(cachedHijri).month.number,10)-1] + ' ' + parseHijriString(cachedHijri).year + ' H') : cachedHijri) : '';

  const qTarget = s.quranTargetPages || 1;
  const qToday = qStatus?.todayPages || 0;
  const qProgress = Math.min(100, Math.round((qToday / qTarget) * 100));
  const qStreak = qStatus?.streak || 0;

  const eTarget = 30; // minutes (default)
  const eToday = (eStatus?.todayCount || 0) * 5; // each count = 5 min
  const eProgress = Math.min(100, Math.round((eToday / eTarget) * 100));
  const eWeekCount = (() => {
    if (!habits?.exerciseLog) return 0;
    const now = new Date();
    let count = 0;
    for (let i = 0; i < 7; i++) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0,10);
      if (habits.exerciseLog[key] && habits.exerciseLog[key] > 0) count++;
    }
    return count;
  })();

  // Build weekly schedule grid
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay()); // Sunday start
  let weekHtml = '';
  const dayShort = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart); d.setDate(weekStart.getDate() + i);
    const dStr = d.toISOString().slice(0,10);
    const isToday = dStr === today.toISOString().slice(0,10);
    const qDone = habits?.quranLog?.[dStr] >= qTarget;
    const eDone = (habits?.exerciseLog?.[dStr] || 0) > 0;
    const icons = (qDone ? '📖' : '') + (eDone ? '🏃' : '');
    const lbl = isToday ? 'Hari ini' : (icons || '—');
    weekHtml += '<div class="habit-day' + (isToday ? ' today' : '') + (qDone || eDone ? ' done' : '') + '">'
      + '<b>' + dayShort[i] + ' ' + d.getDate() + '</b>'
      + '<i>' + (icons || '·') + '</i>'
      + '<span>' + lbl + '</span></div>';
  }

  B.innerHTML =
    '<div class="habits-date"><b>Hari ini · ' + esc(todayStr) + '</b>' + (hijriStr ? '<span>' + esc(hijriStr) + '</span>' : '') + '</div>'

    // Quran habit card
    + '<section class="habit-card">'
    +   '<div class="habit-card-top">'
    +     '<div class="habit-ic quran">📖</div>'
    +     '<div class="habit-title"><b>Ngaji</b><span>Target ' + qTarget + ' halaman · setelah Maghrib</span></div>'
    +     '<span class="habit-status' + (qStatus?.isComplete ? ' done' : '') + '" id="quranStatus">' + (qStatus?.isComplete ? 'SELESAI' : 'BELUM') + '</span>'
    +   '</div>'
    +   '<div class="habit-details">'
    +     '<div class="habit-plan"><div><b>Rencana hari ini</b><br><span>' + qTarget + ' halaman · ±' + (qTarget * 10) + ' menit</span></div><span id="quranProgress">' + qToday + ' / ' + qTarget + ' hal</span></div>'
    +     '<div class="habit-progress"><i id="quranBar" style="width:' + qProgress + '%"></i></div>'
    +     '<div class="habit-actions">'
    +       '<button class="habit-action" id="quranMinus">− 1 hal</button>'
    +       '<button class="habit-action main" id="quranPlus">+ 1 halaman</button>'
    +       '<span class="counter" id="quranCounter">' + qToday + ' hal dicatat</span>'
    +     '</div>'
    +   '</div>'
    + '</section>'

    // Sport habit card
    + '<section class="habit-card sport">'
    +   '<div class="habit-card-top">'
    +     '<div class="habit-ic sport">🏃</div>'
    +     '<div class="habit-title"><b>Olahraga</b><span>Jalan cepat · ' + eTarget + ' menit · setelah Asar</span></div>'
    +     '<span class="habit-status' + (eToday >= eTarget ? ' done' : '') + '" id="sportStatus">' + (eToday >= eTarget ? 'SELESAI' : 'BELUM') + '</span>'
    +   '</div>'
    +   '<div class="habit-details">'
    +     '<div class="habit-plan"><div><b>Rencana hari ini</b><br><span>Jalan cepat · ' + eTarget + ' menit · 16.30</span></div><span id="sportProgress">' + eToday + ' / ' + eTarget + ' mnt</span></div>'
    +     '<div class="habit-progress"><i id="sportBar" style="width:' + eProgress + '%"></i></div>'
    +     '<div class="habit-actions">'
    +       '<button class="habit-action" id="sportMinus">− 5 mnt</button>'
    +       '<button class="habit-action main" id="sportPlus">+ 5 menit</button>'
    +       '<span class="counter" id="sportCounter">' + eToday + ' mnt dicatat</span>'
    +     '</div>'
    +   '</div>'
    + '</section>'

    // Weekly schedule
    + '<section class="habit-week">'
    +   '<div class="habit-week-h"><div><b>Rencana minggu ini</b><span>Streak dihitung per kebiasaan, bukan dicampur</span></div><span>' + (weekStart.getDate()) + '–' + (today.getDate()) + ' ' + monthNames[weekStart.getMonth()].slice(0,3) + '</span></div>'
    +   '<div class="habit-week-grid">' + weekHtml + '</div>'
    + '</section>'

    // Insights
    + '<section class="habit-insight">'
    +   '<div class="habit-metric"><span>Streak ngaji</span><b>' + qStreak + ' hari</b><small>Target: setiap hari</small></div>'
    +   '<div class="habit-metric"><span>Olahraga minggu ini</span><b>' + eWeekCount + ' / 3</b><small>Target: 3 sesi × ' + eTarget + ' menit</small></div>'
    + '</section>'

    // Settings drawer
    + '<details class="habit-setting"><summary>⚙ Atur kebiasaan dan jadwal</summary><div class="habit-config">'
    +   '<div class="habit-row"><div><b>Target ngaji</b><span>Ukuran paling sederhana: halaman</span></div><select id="quranTargetSel">'
    +     [1,2,4].map(n => '<option value="' + n + '"' + (n === qTarget ? ' selected' : '') + '>' + n + ' halaman / hari</option>').join('')
    +   '</select></div>'
    +   '<div class="habit-row"><div><b>Waktu ngaji</b><span>Hanya sebagai pengingat, bukan batas</span></div><input id="quranTimeInput" type="time" value="' + esc(s.quranReminderTime || '18:15') + '"></div>'
    +   '<div class="habit-row"><div><b>Jenis olahraga</b><span>Pilih aktivitas favorit</span></div><select id="sportTypeSel">'
    +     ['Jalan cepat', 'Lari', 'Bersepeda', 'Latihan kekuatan', 'Peregangan / yoga'].map(n => '<option>' + n + '</option>').join('')
    +   '</select></div>'
    +   '<div class="habit-row"><div><b>Target olahraga</b><span>Durasi per sesi</span></div><select id="sportTargetSel">'
    +     [20,30,45,60].map(n => '<option value="' + n + '"' + (n === eTarget ? ' selected' : '') + '>' + n + ' menit</option>').join('')
    +   '</select></div>'
    +   '<div class="habit-save"><button class="habit-action main" id="saveHabitPlan">Simpan rencana</button></div>'
    + '</div></details>'

    + '<p class="hintbox" style="margin:15px 3px"><b>Prinsip desain:</b> target ngaji diukur dengan halaman; olahraga diukur dengan jenis aktivitas dan menit. Keduanya punya progres dan streak sendiri agar pengguna tahu mana yang konsisten tanpa memberi tekanan dari target yang terlalu rumit.</p>';

  // Bind actions
  $('#quranPlus').addEventListener('click', async () => {
    await logQuranPages(1, s);
    await refreshVault();
    await updateHabitsStrip();
    renderHabitsPage(B);
    toast('📖 1 halaman ngaji dicatat');
  });
  $('#quranMinus').addEventListener('click', async () => {
    await logQuranPages(-1, s);
    await refreshVault();
    await updateHabitsStrip();
    renderHabitsPage(B);
  });
  $('#sportPlus').addEventListener('click', async () => {
    await logExerciseDone(s);
    await refreshVault();
    await updateHabitsStrip();
    renderHabitsPage(B);
    toast('🏃 5 menit olahraga dicatat');
  });
  $('#sportMinus').addEventListener('click', async () => {
    // Decrement exercise count (need custom logic — logExerciseDone only increments)
    // For now: noop if 0, else decrement via direct storage
    try {
      const today = new Date().toISOString().slice(0,10);
      const h = await getHabits();
      if (h.exerciseLog?.[today] > 0) {
        h.exerciseLog[today]--;
        const { saveHabits } = await import('../lib/habits.js');
        await saveHabits(h);
        await refreshVault();
        await updateHabitsStrip();
        renderHabitsPage(B);
      }
    } catch (e) {}
  });
  $('#saveHabitPlan').addEventListener('click', async () => {
    const newTarget = parseInt($('#quranTargetSel').value, 10) || 1;
    const newTime = $('#quranTimeInput').value || '18:15';
    await saveSettings({ quranTargetPages: newTarget, quranReminderTime: newTime });
    await refreshVault();
    renderHabitsPage(B);
    toast('✓ Rencana habit disimpan');
  });
}
async function renderPuasaPage(B) {
  // Get hijri date from cached prayer times, or fall back to approximating
  const cachedHijri = currentVault?.settings?.prayerCachedTimes?.hijri;
  let hijriToday = cachedHijri ? parseHijriString(cachedHijri) : null;
  // If no prayer data, we can't reliably compute hijri dates — show notice
  if (!hijriToday) {
    B.innerHTML = '<div class="card" style="text-align:center;padding:26px 16px"><div style="font-size:30px;margin-bottom:8px">🌙</div>'
      + '<div style="font-size:12.5px;color:var(--text-2);line-height:1.55;max-width:280px;margin:0 auto 14px">Aktifkan <b>Waktu Shalat</b> dulu untuk mendapat tanggal Hijriah akurat dari Aladhan API. Kalender puasa butuh data Hijriah untuk menandai hari Ayyamul Bidh, Asyura, Arafah, dll.</div>'
      + '<button class="btn btn-p" id="puasaGoShalat">Aktifkan Waktu Shalat</button></div>';
    $('#puasaGoShalat').addEventListener('click', () => {
      $('#tabTools').click();
      setTimeout(() => document.querySelector('[data-tool="shalat"]')?.click(), 100);
    });
    return;
  }

  // Calendar state — start from current month
  let viewYear = new Date().getFullYear();
  let viewMonth = new Date().getMonth();
  let selectedDate = new Date();
  selectedDate.setHours(0,0,0,0);

  function renderCalendar() {
    const today = new Date();
    today.setHours(0,0,0,0);
    const monthNames = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

    // Compute first day of month + days in month
    const firstDay = new Date(viewYear, viewMonth, 1);
    const lastDay = new Date(viewYear, viewMonth + 1, 0);
    const daysInMonth = lastDay.getDate();
    const startWeekday = firstDay.getDay(); // 0=Sun

    // Build hijri lookup for each day of this month (increment from today's hijri)
    const hijriDayToday = parseInt(hijriToday.day, 10);
    const hijriMonthToday = parseInt(hijriToday.month?.number || 0, 10);
    const hijriYearToday = parseInt(hijriToday.year || 0, 10);
    const todayDate = today.getDate();
    const todayMonthIdx = today.getMonth();
    const todayYear = today.getFullYear();

    function getHijriForDate(d) {
      // Calculate days diff from today
      const dateObj = new Date(d);
      const diffDays = Math.round((dateObj - today) / (24*60*60*1000));
      let hDay = hijriDayToday + diffDays;
      let hMonth = hijriMonthToday;
      let hYear = hijriYearToday;
      while (hDay > 30) { hDay -= 30; hMonth++; if (hMonth > 12) { hMonth = 1; hYear++; } }
      while (hDay < 1) { hMonth--; if (hMonth < 1) { hMonth = 12; hYear--; } hDay += 30; }
      return { day: String(hDay), month: { number: String(hMonth), en: HIJRI_MONTHS[hMonth-1] }, year: String(hYear) };
    }

    // Build day cells
    let daysHtml = '';
    // Leading blanks
    for (let i = 0; i < startWeekday; i++) daysHtml += '<div class="puasa-day blank"></div>';
    for (let d = 1; d <= daysInMonth; d++) {
      const dateObj = new Date(viewYear, viewMonth, d);
      dateObj.setHours(0,0,0,0);
      const isToday = dateObj.getTime() === today.getTime();
      const isSelected = dateObj.getTime() === selectedDate.getTime();
      const weekday = dateObj.getDay();
      const isMonday = weekday === 1;
      const isThursday = weekday === 4;
      const hijri = getHijriForDate(dateObj);
      const hijriDay = parseInt(hijri.day, 10);
      const isBidh = hijriDay === 13 || hijriDay === 14 || hijriDay === 15;
      const isSpecial = (parseInt(hijri.month.number,10) === 1 && (hijriDay === 9 || hijriDay === 10))
                     || (parseInt(hijri.month.number,10) === 12 && hijriDay === 9)
                     || (parseInt(hijri.month.number,10) === 10 && hijriDay >= 1 && hijriDay <= 6);

      let classes = 'puasa-day';
      if (isMonday || isThursday) classes += ' monday';
      if (isThursday) classes += ' thursday';
      if (isBidh) classes += ' bidh-day';
      if (isSelected) classes += ' selected';
      if (isToday) classes += ' today';

      let dots = '';
      if (isMonday || isThursday) dots += '<div class="dot"></div>';
      if (isBidh) dots += '<div class="dot bidh"></div>';
      if (isSpecial) dots += '<div class="dot special"></div>';

      daysHtml += '<div class="' + classes + '" data-date="' + viewYear + '-' + String(viewMonth+1).padStart(2,'0') + '-' + String(d).padStart(2,'0') + '">'
        + '<span class="date">' + d + '</span>'
        + '<span class="hijri">' + hijriDay + '</span>'
        + '<div class="dots">' + dots + '</div>'
        + '</div>';
    }

    // Get today's fast info
    const todayFast = getSunnahFast(hijriToday, today);

    // Selected day info
    const selHijri = getHijriForDate(selectedDate);
    const selFast = getSunnahFast(selHijri, selectedDate);
    const selDayName = ['Ahad', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'][selectedDate.getDay()];
    const selDateStr = selectedDate.getDate() + ' ' + monthNames[selectedDate.getMonth()] + ' ' + selectedDate.getFullYear();
    const selHijriStr = parseInt(selHijri.day,10) + ' ' + HIJRI_MONTHS[parseInt(selHijri.month.number,10)-1] + ' ' + selHijri.year + ' H';
    const selInfoHtml = selFast
      ? '<b>' + selDateStr + ' · ' + selHijriStr + '</b><span>' + esc(selDayName) + ' · ' + esc(selFast.name) + ' — ' + esc(selFast.desc || '') + '</span>'
      : '<b>' + selDateStr + ' · ' + selHijriStr + '</b><span>' + esc(selDayName) + ' · Tidak ada jadwal puasa sunnah khusus.</span>';

    // Compute hijri month range for header
    const firstHijri = getHijriForDate(firstDay);
    const lastHijri = getHijriForDate(lastDay);
    const hijriRange = parseInt(firstHijri.day,10) + ' ' + HIJRI_MONTHS[parseInt(firstHijri.month.number,10)-1] + ' – ' + parseInt(lastHijri.day,10) + ' ' + HIJRI_MONTHS[parseInt(lastHijri.month.number,10)-1] + ' ' + lastHijri.year + ' H';

    // Upcoming fasts (14 days)
    const fasts = getUpcomingFasts(hijriToday, today, 14);

    B.innerHTML =
      // Today card
      '<div class="puasa-today"><div class="moon">☾</div><div><b>Hari ini · ' + ['Ahad','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'][today.getDay()] + ', ' + today.getDate() + ' ' + monthNames[today.getMonth()] + ' ' + today.getFullYear() + '</b>'
      + '<span>' + parseInt(hijriToday.day,10) + ' ' + HIJRI_MONTHS[parseInt(hijriToday.month.number,10)-1] + ' ' + hijriToday.year + ' H · '
      + (todayFast ? esc(todayFast.name) + ' — ' + esc(todayFast.desc || '') : 'Tidak ada puasa sunnah khusus hari ini')
      + '</span></div></div>'

      // Upcoming fasts card
      + '<section class="puasa-card"><div class="puasa-card-title">Jadwal 14 hari ke depan</div>'
      + (fasts && fasts.length ? fasts.slice(0, 5).map(f => {
          const dayLabel = f.isToday ? 'Hari ini' : (f.isTomorrow ? 'Besok' : f.daysAhead + ' hari lagi');
          const cls = f.daysAhead <= 2 ? 'puasa-pill soon' : 'puasa-pill';
          const fDate = f.date instanceof Date ? f.date : new Date(f.date);
          return '<div class="puasa-next"><div><div class="puasa-next-name">' + esc(f.name) + '</div>'
            + '<div class="puasa-next-detail">' + ['Ahad','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'][fDate.getDay()] + ', ' + fDate.getDate() + ' ' + monthNames[fDate.getMonth()].slice(0,3) + ' · ' + esc(f.hijriDate || '') + '</div></div>'
            + '<span class="' + cls + '">' + dayLabel + '</span></div>';
        }).join('') : '<div style="color:var(--muted);font-size:11px;padding:8px 0">Tidak ada puasa sunnah dalam 14 hari.</div>')
      + '</section>'

      // Calendar card
      + '<section class="puasa-card puasa-cal-card">'
      +   '<div class="puasa-cal-head"><div><b>' + monthNames[viewMonth] + ' ' + viewYear + '</b><span>' + hijriRange + '</span></div>'
      +     '<div class="puasa-nav"><button id="puasaPrev" aria-label="Bulan sebelumnya">‹</button><button id="puasaNext" aria-label="Bulan berikutnya">›</button></div>'
      +   '</div>'
      +   '<div class="puasa-weekrow"><span>Min</span><span>Sen</span><span>Sel</span><span>Rab</span><span>Kam</span><span>Jum</span><span>Sab</span></div>'
      +   '<div class="puasa-days">' + daysHtml + '</div>'
      +   '<div class="puasa-legend">'
      +     '<span><i style="background:var(--green)"></i>Senin / Kamis</span>'
      +     '<span><i style="background:var(--amber)"></i>Ayyamul Bidh</span>'
      +     '<span><i style="background:var(--violet)"></i>Puasa khusus</span>'
      +   '</div>'
      +   '<div class="puasa-selected-info">' + selInfoHtml + '</div>'
      + '</section>'

      // Year summary
      + '<section><div class="puasa-card-title" style="margin:2px 0 10px">Penanda khusus tahun ' + viewYear + '</div>'
      +   '<div class="puasa-year-summary">'
      +     '<div class="puasa-event"><b>9–10 Muharram · Tasu\'a & Asyura</b><span>Puasa penghapusan dosa setahun (HR Muslim) — ditandai ungu</span></div>'
      +     '<div class="puasa-event"><b>13–15 setiap bulan Hijriah</b><span>Ayyamul Bidh — ditandai kuning</span></div>'
      +     '<div class="puasa-event"><b>Setiap Senin & Kamis</b><span>Puasa sunnah mingguan — ditandai hijau</span></div>'
      +     '<div class="puasa-event"><b>6 hari Syawal & 9 Zulhijah</b><span>Tampil saat bulan terkait dipilih</span></div>'
      +   '</div>'
      + '</section>'

      + '<p class="hintbox" style="margin:15px 3px"><b>Catatan kalender:</b> penanggalan Hijriah dapat berbeda ±1 hari sesuai rukyat/isbat resmi Indonesia. Rancangan ini memakai acuan dari Aladhan API; cek keputusan Kemenag untuk penetapan ibadah yang bergantung pada tanggal.</p>';

    // Bind nav
    $('#puasaPrev').addEventListener('click', () => {
      viewMonth--;
      if (viewMonth < 0) { viewMonth = 11; viewYear--; }
      renderCalendar();
    });
    $('#puasaNext').addEventListener('click', () => {
      viewMonth++;
      if (viewMonth > 11) { viewMonth = 0; viewYear++; }
      renderCalendar();
    });

    // Bind day clicks
    $$('.puasa-day[data-date]').forEach(el => {
      el.addEventListener('click', () => {
        const [y, m, d] = el.dataset.date.split('-').map(n => parseInt(n, 10));
        selectedDate = new Date(y, m - 1, d);
        selectedDate.setHours(0,0,0,0);
        renderCalendar();
      });
    });
  }

  renderCalendar();
}
async function renderVolumePage(B) {
  let res;
  try { res = await browser.runtime.sendMessage({ type: 'VOLUME_GET' }); } catch (e) { res = { ok: false }; }
  if (!res?.ok) {
    B.innerHTML = '<div class="card" style="text-align:center;padding:20px"><div style="font-size:26px;margin-bottom:6px">🔊</div><div style="font-size:12px;color:var(--muted)">Buka halaman web (http/https) untuk kontrol volume.</div></div>';
    return;
  }
  const dB = res.dB || 0;
  const pct = dbToPercent(dB);
  B.innerHTML = '<div class="card"><div class="vol-pct" id="vPct">' + Math.round(pct) + '%</div><div class="vol-sub">Volume tab aktif · ' + esc(res.domain || 'global') + '</div>'
    + '<input type="range" id="vRange" min="' + MIN_DB + '" max="' + MAX_DB + '" step="1" value="' + dB + '">'
    + '<div class="btn-row" style="margin-top:10px"><button class="btn btn-g" id="vMute">🔇 Mute</button><button class="btn btn-g" id="vReset">↺ Reset 100%</button></div></div>'
    + '<div class="hintbox">⚡ Shortcut: <kbd>Alt+Shift+↑</kbd> <kbd>Alt+Shift+↓</kbd> <kbd>Alt+Shift+0</kbd> — tanpa buka popup.</div>';
  const r = $('#vRange');
  let t = null;
  r.addEventListener('input', () => {
    const newDb = parseInt(r.value, 10);
    $('#vPct').textContent = Math.round(dbToPercent(newDb)) + '%';
    clearTimeout(t);
    t = setTimeout(() => browser.runtime.sendMessage({ type: 'VOLUME_SET', dB: newDb }), 300);
  });
  $('#vMute').addEventListener('click', async () => {
    r.value = -40;
    $('#vPct').textContent = '0%';
    await browser.runtime.sendMessage({ type: 'VOLUME_SET', dB: -40 });
    toast('Tab di-mute');
  });
  $('#vReset').addEventListener('click', async () => {
    r.value = 0;
    $('#vPct').textContent = '100%';
    await browser.runtime.sendMessage({ type: 'VOLUME_SET', dB: 0 });
    toast('Volume direset ke 100%');
  });
}
function renderCachePage(B) {
  const s = currentVault?.settings || {};
  const types = ['Cache', 'Cookies', 'Riwayat', 'Local Storage', 'Downloads'];
  B.innerHTML = '<div class="card"><h3>Tipe data</h3>'
    + types.map((x, i) => '<label class="checkrow"><input type="checkbox" data-cache="' + x.toLowerCase().replace(' ', '_') + '"' + (i === 0 ? ' checked' : '') + '>' + x + '</label>').join('')
    + '<label class="checkrow" style="color:var(--danger)"><input type="checkbox" data-cache="passwords">Passwords ⚠️</label></div>'
    + '<div class="card"><h3>Periode</h3><select class="f" id="cachePeriod"><option value="all">Semua waktu</option><option value="15m">15 menit terakhir</option><option value="1h">1 jam terakhir</option><option value="24h">24 jam terakhir</option><option value="1w">1 minggu terakhir</option></select></div>'
    + '<button class="btn btn-d" style="width:100%" id="cacheGo">' + ICONS.trash + 'Bersihkan Sekarang</button>';
  $('#cacheGo').addEventListener('click', () => {
    openSheet('Konfirmasi', 'Aksi ini tidak bisa dibatalkan', b => {
      b.innerHTML = '<div class="confirmstrip"><span style="flex:1">Hapus data browsing terpilih?</span>'
        + '<button class="btn btn-g" data-c="0">Batal</button><button class="btn btn-d" data-c="1">Ya, bersihkan</button></div>';
      b.querySelector('[data-c="0"]').addEventListener('click', closeSheet);
      b.querySelector('[data-c="1"]').addEventListener('click', async () => {
        closeSheet();
        try {
          const res = await browser.runtime.sendMessage({ type: 'CLEAR_CACHE' });
          if (res?.ok) toast('🗑 Cache dibersihkan ✓ · tab dimuat ulang');
          else toast('Gagal: ' + (res?.error || ''), false);
        } catch (e) { toast('Error: ' + e.message, false); }
      });
    });
  });
}
function renderKeysPage(B) {
  B.innerHTML = '<div class="card"><h3>Shortcut global</h3><div class="klist">'
    + [['Buka / tutup sidebar', ['Alt', 'Shift', '4']], ['Simpan teks terseleksi', ['Alt', 'Shift', '2']], ['Snapshot chat AI', ['Alt', 'Shift', '3']], ['Screenshot (pilih mode)', ['Alt', 'Shift', '5']], ['Screenshot area (seret kotak)', ['Alt', 'Shift', '6']], ['Screenshot viewport', ['Alt', 'Shift', '7']], ['Clear cache', ['Alt', 'Shift', 'C']], ['Volume naik', ['Alt', 'Shift', '↑']], ['Volume turun', ['Alt', 'Shift', '↓']], ['Volume reset', ['Alt', 'Shift', '0']], ['Fokus pencarian', ['/']]].map(r => '<div class="krow"><span class="kl">' + r[0] + '</span><span>' + r[1].map(x => '<kbd>' + x + '</kbd>').join(' ') + '</span></div>').join('')
    + '</div></div>'
    + '<div class="hintbox">💡 <b>Screenshot area</b> paling berguna untuk ambil cuplikan UI saat troubleshooting atau membuat dokumentasi. Bisa diulang beberapa kali untuk beberapa contoh berbeda.</div>';
}
function renderToolStubPage(B, k, name) {
  // v3.7: Halaman stub sekarang punya UI yang lebih kaya untuk Backup & Tanya AI
  if (k === 'backup') {
    renderBackupPage(B);
    return;
  }
  if (k === 'askai') {
    renderAskAiPage(B);
    return;
  }
  // Untuk tipe lain (kalau ada), pakai stub lama
  const desc = {};
  B.innerHTML = '<div class="card" style="text-align:center;padding:26px 16px"><div style="font-size:30px;margin-bottom:8px">' + (name || '🛠').split(' ')[0] + '</div>'
    + '<div style="font-size:12.5px;color:var(--text-2);line-height:1.55;max-width:250px;margin:0 auto 14px">' + (desc[k] || '') + '</div>'
    + '<button class="btn btn-p" id="goSettings">Buka di Pengaturan</button></div>';
  $('#goSettings').addEventListener('click', () => browser.runtime.openOptionsPage());
}

// v3.7: Halaman Backup — UI lengkap dengan export/import/info langsung
async function renderBackupPage(B) {
  const s = currentVault?.settings || {};
  const vault = currentVault || { items: [], bundles: [] };
  const itemCount = (vault.items || []).length;
  const bundleCount = (vault.bundles || []).length;

  // Cek info backup terakhir
  let lastBackupInfo = 'Belum pernah';
  let lastBackupSize = '—';
  try {
    const meta = await getBackupMetadata();
    if (meta && meta.lastBackupAt) {
      const d = new Date(meta.lastBackupAt);
      lastBackupInfo = d.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
    }
    if (meta && meta.lastBackupSize) {
      lastBackupSize = Math.round(meta.lastBackupSize / 1024) + ' KB';
    }
  } catch (e) {}

  const autoBackupOn = s.autoBackupEnabled !== false;

  B.innerHTML =
    '<div class="card" style="background:linear-gradient(135deg,#1e3a8a,#1e40af);color:#eff6ff;border:none">'
    + '<div style="font-size:11px;opacity:.85">Status vault</div>'
    + '<div style="font-size:24px;font-weight:750;margin:4px 0">' + itemCount + ' item · ' + bundleCount + ' bundle</div>'
    + '<div style="font-size:11px;opacity:.85">Backup terakhir: ' + esc(lastBackupInfo) + ' · ' + esc(lastBackupSize) + '</div>'
    + '</div>'

    + '<div class="card"><h3>📦 Ekspor vault</h3>'
    + '<div class="hintbox" style="margin-bottom:10px">Simpan vault Anda ke file. File <b>.rfvault</b> terenkripsi AES-GCM (butuh passphrase untuk restore). File <b>.json</b> plain text (tidak dienkripsi).</div>'
    + '<div class="btn-row" style="flex-direction:column;gap:6px">'
    +   '<button class="btn btn-p" id="rfExpEnc" style="width:100%">🔒 Export .rfvault terenkripsi</button>'
    +   '<button class="btn btn-g" id="rfExpJson" style="width:100%">📄 Export .json (tanpa enkripsi)</button>'
    + '</div></div>'

    + '<div class="card"><h3>📥 Import vault</h3>'
    + '<div class="hintbox" style="margin-bottom:10px">Restore dari file backup (.rfvault atau .json). Item yang ada akan <b>digabung</b> (bukan ditimpa) — item dengan ID sama akan di-skip.</div>'
    + '<label class="btn btn-g" style="display:block;text-align:center;cursor:pointer">'
    +   '📁 Pilih file backup...'
    +   '<input type="file" id="rfImportFile" accept=".json,.rfvault" style="display:none">'
    + '</label>'
    + '<div id="rfImportResult" style="margin-top:8px;font-size:11px"></div></div>'

    + '<div class="card"><h3>⚙️ Auto-backup</h3>'
    + '<div class="krow" style="padding:8px 0">'
    +   '<div><b>Backup otomatis harian</b><div style="font-size:11px;color:var(--muted);margin-top:2px">Simpan ke Downloads/RecallFox/ setiap hari saat addon aktif.</div></div>'
    +   '<button class="ks-toggle' + (autoBackupOn ? ' on' : '') + '" id="rfAutoBackupToggle" aria-label="Toggle auto-backup"><i></i></button>'
    + '</div>'
    + '<button class="btn btn-g" id="rfBackupNow" style="width:100%;margin-top:6px">⚡ Backup sekarang</button></div>'

    + '<div class="card"><h3>🔧 Pengaturan lanjutan</h3>'
    + '<div class="hintbox" style="margin-bottom:10px">Atur jadwal auto-backup, lokasi folder, enkripsi default, dll di halaman pengaturan.</div>'
    + '<button class="btn btn-g" id="rfGoSettings" style="width:100%">Buka pengaturan RecallFox</button></div>'

    + '<p class="hintbox" style="margin:10px 3px">💡 <b>Tip:</b> Backup .rfvault terenkripsi aman untuk disimpan di cloud (Google Drive, Dropbox). Passphrase tidak bisa dikembalikan jika lupa — simpan baik-baik.</p>';

  // === Bind events ===
  // Export terenkripsi
  $('#rfExpEnc').addEventListener('click', async () => {
    try {
      const passphrase = prompt('Masukkan passphrase untuk enkripsi backup (min. 8 karakter):');
      if (!passphrase) return;
      if (passphrase.length < 8) {
        if (!confirm('Passphrase kurang dari 8 karakter. Lanjut? (Tidak disarankan)')) return;
      }
      toast('🔒 Membuat backup terenkripsi...');
      // Pakai background untuk export (lebih reliable)
      const res = await browser.runtime.sendMessage({ type: 'EXPORT_BACKUP', encrypted: true, passphrase });
      if (res?.ok) {
        toast('✓ Backup tersimpan ke Downloads');
      } else {
        toast('⚠ Gagal: ' + (res?.error || 'unknown'), false);
      }
    } catch (e) {
      toast('⚠ Gagal export: ' + e.message, false);
    }
  });

  // Export plain JSON
  $('#rfExpJson').addEventListener('click', async () => {
    try {
      toast('📄 Membuat backup JSON...');
      const res = await browser.runtime.sendMessage({ type: 'EXPORT_BACKUP', encrypted: false });
      if (res?.ok) {
        toast('✓ Backup JSON tersimpan ke Downloads');
      } else {
        toast('⚠ Gagal: ' + (res?.error || 'unknown'), false);
      }
    } catch (e) {
      toast('⚠ Gagal export: ' + e.message, false);
    }
  });

  // Import file
  $('#rfImportFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const resultEl = $('#rfImportResult');
    resultEl.innerHTML = '⏳ Mengimpor...';
    try {
      // Baca file sebagai text
      const text = await file.text();
      let passphrase = null;
      if (file.name.endsWith('.rfvault')) {
        passphrase = prompt('Masukkan passphrase untuk dekripsi:');
        if (!passphrase) {
          resultEl.innerHTML = '<span style="color:var(--red)">✕ Dibatalkan</span>';
          e.target.value = '';
          return;
        }
      }
      // Kirim ke background untuk proses
      const res = await browser.runtime.sendMessage({
        type: 'IMPORT_BACKUP',
        text,
        passphrase,
        filename: file.name
      });
      if (res?.ok) {
        resultEl.innerHTML = '<span style="color:var(--green)">✓ Berhasil: ' + (res.added || 0) + ' item baru, ' + (res.skipped || 0) + ' di-skip</span>';
        toast('✓ Import selesai');
        await refreshVault();
      } else {
        resultEl.innerHTML = '<span style="color:var(--red)">✕ ' + esc(res?.error || 'Gagal') + '</span>';
        toast('⚠ Gagal import: ' + (res?.error || ''), false);
      }
    } catch (e) {
      resultEl.innerHTML = '<span style="color:var(--red)">✕ ' + esc(e.message) + '</span>';
      toast('⚠ Gagal: ' + e.message, false);
    }
    e.target.value = '';
  });

  // Auto-backup toggle
  $('#rfAutoBackupToggle').addEventListener('click', async () => {
    const newOn = s.autoBackupEnabled === false;
    await saveSettings({ autoBackupEnabled: newOn });
    s.autoBackupEnabled = newOn;
    await refreshVault();
    renderBackupPage(B);
    toast(newOn ? '✓ Auto-backup aktif' : 'Auto-backup dimatikan');
  });

  // Backup now
  $('#rfBackupNow').addEventListener('click', async () => {
    try {
      toast('⏳ Backup berjalan...');
      const res = await browser.runtime.sendMessage({ type: 'MANUAL_BACKUP_NOW' });
      if (res?.ok) {
        toast('✓ Backup tersimpan ke Downloads/RecallFox/');
        renderBackupPage(B);  // refresh untuk update info
      } else {
        toast('⚠ Gagal: ' + (res?.error || ''), false);
      }
    } catch (e) {
      toast('⚠ Gagal: ' + e.message, false);
    }
  });

  // Buka settings
  $('#rfGoSettings').addEventListener('click', () => browser.runtime.openOptionsPage());
}

// v3.7: Halaman Tanya AI — UI lengkap dengan quick prompts + chat
async function renderAskAiPage(B) {
  const s = currentVault?.settings || {};

  // Cek apakah AI sudah dikonfigurasi
  let aiConfigured = false;
  let providerInfo = null;
  try {
    aiConfigured = await isAssistantConfigured();
    providerInfo = getProviderInfo(s.assistantProvider || 'groq');
  } catch (e) {}

  // Quick prompt templates
  const quickPrompts = [
    { icon: '📝', label: 'Rangkum teks ini', prompt: 'Tolong rangkum teks berikut dalam 3 poin utama:\n\n' },
    { icon: '🌐', label: 'Terjemahkan ke Indonesia', prompt: 'Terjemahkan teks berikut ke Bahasa Indonesia:\n\n' },
    { icon: '🔍', label: 'Jelaskan maknanya', prompt: 'Jelaskan makna dan konteks teks berikut dengan bahasa sederhana:\n\n' },
    { icon: '✅', label: 'Cek fakta', prompt: 'Cek faktualitas klaim dalam teks berikut. Sebutkan yang benar dan yang salah:\n\n' },
    { icon: '💡', label: 'Beri ide terkait', prompt: 'Beri 5 ide menarik yang terkait dengan topik teks berikut:\n\n' },
    { icon: '🎯', label: 'Kritisi argumen', prompt: 'Kritisi argumen dalam teks berikut. Sebutkan kekuatan dan kelemahannya:\n\n' }
  ];

  // Info card: status AI
  let statusCard;
  if (aiConfigured) {
    statusCard = '<div class="card" style="background:linear-gradient(135deg,#065f46,#047857);color:#ecfdf5;border:none">'
      + '<div style="font-size:11px;opacity:.85">AI Assistant</div>'
      + '<div style="font-size:18px;font-weight:750;margin:4px 0">' + esc(providerInfo?.name || 'AI') + ' siap</div>'
      + '<div style="font-size:11px;opacity:.85">Model: ' + esc(s.assistantModel || providerInfo?.defaultModel || 'default') + '</div></div>';
  } else {
    statusCard = '<div class="card" style="background:linear-gradient(135deg,#7c2d12,#9a3412);color:#fff7ed;border:none">'
      + '<div style="font-size:11px;opacity:.85">⚠️ AI belum dikonfigurasi</div>'
      + '<div style="font-size:14px;font-weight:700;margin:4px 0">Atur API key dulu</div>'
      + '<div style="font-size:11px;opacity:.85">Buka pengaturan untuk masukkan API key Groq (gratis) / Gemini / OpenAI.</div>'
      + '<button class="btn btn-p" id="askAiSetup" style="width:100%;margin-top:8px">Buka Pengaturan</button></div>';
  }

  B.innerHTML =
    statusCard

    + '<div class="card"><h3>⚡ Quick prompts</h3>'
    + '<div class="hintbox" style="margin-bottom:10px">Pilih template, lalu blok teks di halaman mana pun → klik kanan → "Tanya Si Pandai". Atau ketik pertanyaan langsung di bawah.</div>'
    + '<div class="rf-quick-grid">'
    + quickPrompts.map(function (p, i) {
        return '<button class="rf-quick-btn" data-prompt-idx="' + i + '" title="' + esc(p.prompt.slice(0, 80)) + '">'
          + '<span class="rf-quick-icon">' + p.icon + '</span>'
          + '<span class="rf-quick-label">' + esc(p.label) + '</span></button>';
      }).join('')
    + '</div></div>'

    + '<div class="card"><h3>💬 Tanya langsung</h3>'
    + '<div class="hintbox" style="margin-bottom:10px">Ketik pertanyaan Anda. Jawaban akan muncul di sini.</div>'
    + '<textarea id="askAiInput" class="rf-textarea" placeholder="Ketik pertanyaan... (mis. Jelaskan apa itu Recurrent Neural Network)" rows="3"></textarea>'
    + '<div class="btn-row" style="margin-top:8px">'
    +   '<button class="btn btn-g" id="askAiClear" style="flex:none">Bersihkan</button>'
    +   '<button class="btn btn-p" id="askAiSend" style="flex:1">' + (aiConfigured ? 'Kirim ke AI' : 'Setup dulu') + '</button>'
    + '</div>'
    + '<div id="askAiResult" style="margin-top:10px;font-size:12px;max-height:300px;overflow-y:auto"></div></div>'

    + '<div class="card"><h3>ℹ️ Cara pakai lain</h3>'
    + '<div style="font-size:11.5px;color:var(--text-2);line-height:1.6">'
    +   '<div style="margin-bottom:6px"><b>1. Seleksi teks → klik kanan:</b> Blok teks di halaman mana pun → klik kanan → <b>"Tanya Si Pandai"</b>. Jawaban muncul sebagai overlay di halaman.</div>'
    +   '<div style="margin-bottom:6px"><b>2. Tanya tentang tab aktif:</b> Buka tab AI tool (chat.z.ai, chatgpt.com, dll), lalu pakai tombol di bawah untuk kirim judul + URL tab ke chat AI.</div>'
    +   '<div><b>3. Pintasan keyboard:</b> Alt+Shift+A (kalau di-set di pengaturan).</div>'
    + '</div>'
    + '<button class="btn btn-g" id="askAiSendTab" style="width:100%;margin-top:10px">🔗 Tanya AI tentang tab aktif</button></div>'

    + '<p class="hintbox" style="margin:10px 3px">💡 <b>Tip:</b> Groq (gratis) paling cepat untuk teks pendek. Gemini Flash (gratis) bagus untuk multi-bahasa. Buka pengaturan untuk pindah provider.</p>';

  // === Bind events ===
  if (!aiConfigured) {
    $('#askAiSetup').addEventListener('click', () => browser.runtime.openOptionsPage());
  }

  // Quick prompt click → isi textarea
  $$('.rf-quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.promptIdx, 10);
      const p = quickPrompts[idx];
      const ta = $('#askAiInput');
      ta.value = p.prompt;
      ta.focus();
      // Pindahkan cursor ke akhir
      ta.setSelectionRange(ta.value.length, ta.value.length);
      toast('💡 Template "' + p.label + '" dimuat. Ketik teks lalu Kirim.');
    });
  });

  // Send question
  $('#askAiSend').addEventListener('click', async () => {
    if (!aiConfigured) {
      browser.runtime.openOptionsPage();
      return;
    }
    const q = $('#askAiInput').value.trim();
    if (!q) { toast('Ketik pertanyaan dulu', false); return; }
    const resultEl = $('#askAiResult');
    const sendBtn = $('#askAiSend');
    sendBtn.disabled = true;
    sendBtn.textContent = '⏳ Menjawab...';
    resultEl.innerHTML = '<div style="color:var(--muted);font-style:italic">⏳ Menunggu jawaban dari ' + esc(providerInfo?.name || 'AI') + '...</div>';
    try {
      const messages = [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: q }
      ];
      let acc = '';
      const resp = await chatWithFallback(messages, {
        onToken: (token) => {
          acc += token;
          resultEl.innerHTML = '<div class="rf-ai-answer">' + esc(acc).replace(/\n/g, '<br>') + '</div>';
          resultEl.scrollTop = resultEl.scrollHeight;
        }
      });
      if (!acc && resp?.content) {
        resultEl.innerHTML = '<div class="rf-ai-answer">' + esc(resp.content).replace(/\n/g, '<br>') + '</div>';
      }
      if (!resultEl.innerHTML.trim()) {
        resultEl.innerHTML = '<div style="color:var(--red)">⚠ Tidak ada jawaban. Coba lagi atau cek API key di pengaturan.</div>';
      } else {
        // Tambah tombol copy di akhir
        const copyWrap = document.createElement('div');
        copyWrap.style.marginTop = '8px';
        copyWrap.innerHTML = '<button class="btn btn-g" id="askAiCopy" style="width:100%">📋 Salin jawaban</button>';
        resultEl.appendChild(copyWrap);
        $('#askAiCopy').addEventListener('click', () => {
          const text = resultEl.querySelector('.rf-ai-answer')?.innerText || '';
          navigator.clipboard.writeText(text).then(() => toast('📋 Jawaban disalin'));
        });
      }
    } catch (e) {
      resultEl.innerHTML = '<div style="color:var(--red)">⚠ Error: ' + esc(e.message) + '</div>';
    }
    sendBtn.disabled = false;
    sendBtn.textContent = 'Kirim ke AI';
  });

  // Clear
  $('#askAiClear').addEventListener('click', () => {
    $('#askAiInput').value = '';
    $('#askAiResult').innerHTML = '';
    $('#askAiInput').focus();
  });

  // Tanya tentang tab aktif
  $('#askAiSendTab').addEventListener('click', async () => {
    if (!aiConfigured) {
      browser.runtime.openOptionsPage();
      return;
    }
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]) { toast('Tidak ada tab aktif', false); return; }
      const tab = tabs[0];
      const prompt = 'Jelaskan secara singkat situs/web ini apa dan untuk apa:\n\nJudul: ' + (tab.title || '(tanpa judul)') + '\nURL: ' + tab.url;
      $('#askAiInput').value = prompt;
      toast('💡 Prompt dimuat. Klik "Kirim ke AI" untuk kirim.');
      $('#askAiInput').focus();
    } catch (e) {
      toast('⚠ Gagal: ' + e.message, false);
    }
  });
}

// ============ Kontrol Situs (unified Element Blocker + Content Guard) ============
async function renderKontrolSitusPage(B) {
  const s = currentVault?.settings || {};
  // Get user blocklist (content filter rules)
  let userBlocklist = [];
  try { userBlocklist = await getUserBlocklist(); } catch (e) {}

  // Get current active tab domain (for site bar)
  let currentDomain = '—';
  let currentSiteIcon = '🌐';
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.url) {
      const url = new URL(tabs[0].url);
      currentDomain = url.hostname.replace(/^www\./, '');
      // Pick icon based on domain
      if (currentDomain.includes('youtube')) { currentSiteIcon = '▶'; }
      else if (currentDomain.includes('twitter') || currentDomain.endsWith('x.com')) { currentSiteIcon = '𝕏'; }
      else if (currentDomain.includes('facebook')) { currentSiteIcon = 'f'; }
      else if (currentDomain.includes('instagram')) { currentSiteIcon = '📷'; }
      else { currentSiteIcon = currentDomain.charAt(0).toUpperCase(); }
    }
  } catch (e) {}

  // Compute rules count
  const rulesCount = (s.elementBlockerRules?.length || 0) + userBlocklist.length;
  const blockerOn = s.elementBlockerEnabled !== false;
  const guardOn = s.contentGuardEnabled !== false;
  const siteActive = blockerOn || guardOn;

  // v3.4: Kumpulkan daftar selector yang sudah di-block untuk domain aktif
  // (dari elementBlockerRules yang domain-nya cocok dengan currentDomain)
  // v3.7: FIX — domain matching 2-arah + strip www. dari rule.domain juga
  // (sebelumnya rule disimpan sebagai "www.youtube.com" tapi currentDomain = "youtube.com"
  //  sehingga rule tidak match dan daftar Diblokir tampil (0))
  const ebRules = Array.isArray(s.elementBlockerRules) ? s.elementBlockerRules : [];
  const currentDomainRules = ebRules.filter(function (r) {
    if (!r || !r.domain) return false;
    // Normalisasi: strip www. dari kedua sisi
    const d = String(r.domain).toLowerCase().replace(/^www\./, '');
    const cd = (currentDomain || '').toLowerCase().replace(/^www\./, '');
    if (!d || !cd) return false;
    // Match kalau: exact, atau salah satu adalah subdomain dari yang lain, atau rule = 'all'
    return cd === d || cd.endsWith('.' + d) || d.endsWith('.' + cd) || d === 'all';
  });
  // Flat list of { domain, selector, isPreset, ruleName } for the current domain
  const blockedForCurrent = [];
  currentDomainRules.forEach(function (r) {
    (r.selectors || []).forEach(function (sel) {
      blockedForCurrent.push({
        domain: r.domain,
        selector: sel,
        isPreset: !!r.isPreset,
        ruleName: r.name || r.domain,
        kind: 'eb_selector'
      });
    });
  });

  // v3.6: Tambahkan juga filter konten (keyword/channel/account/x_post_url) yang aktif
  // untuk domain ini — supaya counter "Diblokir" akurat mencerminkan semua aturan.
  // Cakupan: 'all' (semua situs), 'youtube.com' (hanya YT), 'x.com' (hanya X), atau domain spesifik.
  const cgFiltersForCurrent = [];
  (userBlocklist || []).forEach(function (b) {
    if (!b || !b.value) return;
    const bDomain = (b.domain || '').toLowerCase();
    const cd = (currentDomain || '').toLowerCase();
    // Match kalau: domain kosong (all), atau domain cocok / suffix cocok
    const matches = !bDomain || bDomain === 'all' ||
      cd === bDomain || cd.endsWith('.' + bDomain) ||
      (bDomain === 'youtube.com' && (cd.endsWith('youtube.com') || cd.endsWith('youtube-nocookie.com'))) ||
      (bDomain === 'x.com' && (cd.endsWith('x.com') || cd.endsWith('twitter.com')));
    if (matches) {
      cgFiltersForCurrent.push({
        domain: b.domain || 'all',
        selector: '[' + (b.type || 'keyword') + '] ' + b.value,
        isPreset: false,
        ruleName: 'Filter konten' + (b.domain ? ' · ' + b.domain : ''),
        kind: 'cg_filter',
        rawType: b.type || 'keyword',
        rawValue: b.value,
        rawId: b.id
      });
    }
  });

  // Gabungkan: EB selectors + CG filters untuk domain aktif
  const allBlockedForCurrent = blockedForCurrent.concat(cgFiltersForCurrent);

  // Build rule list (mix of element blocker presets + user blocklist)
  // v3.6: Tambah toggle ON/OFF per-feature (ganti tombol ⋮ yang tidak berfungsi)
  const rules = [];
  if (s.elementBlockerEnabled !== false) {
    rules.push({
      type: 'UI', name: 'Element Blocker aktif',
      desc: 'Sembunyikan elemen mengganggu sesuai preset domain',
      toggleKey: 'elementBlockerEnabled',
      toggleOn: s.elementBlockerEnabled !== false
    });
  } else {
    rules.push({
      type: 'UI', name: 'Element Blocker (mati)',
      desc: 'Klik toggle untuk aktifkan kembali',
      toggleKey: 'elementBlockerEnabled',
      toggleOn: false
    });
  }
  if (s.contentGuardEnabled !== false) {
    rules.push({
      type: 'KONTEN', name: 'Content Guard aktif',
      desc: 'Filter konten negatif di YouTube & X',
      toggleKey: 'contentGuardEnabled',
      toggleOn: s.contentGuardEnabled !== false
    });
  } else {
    rules.push({
      type: 'KONTEN', name: 'Content Guard (mati)',
      desc: 'Klik toggle untuk aktifkan kembali',
      toggleKey: 'contentGuardEnabled',
      toggleOn: false
    });
  }
  userBlocklist.slice(0, 4).forEach(b => {
    rules.push({
      type: 'KONTEN',
      name: b.value?.slice(0, 40) || b.text?.slice(0, 40) || 'Aturan user',
      desc: 'Diblokir user' + (b.domain ? ' · ' + b.domain : ''),
      delId: b.id  // v3.6: tombol ✕ untuk hapus filter user
    });
  });

  let activeTab = 'home';
  function render() {
    B.innerHTML =
      // Site bar
      '<div class="ks-sitebar">'
      +   '<div class="ks-site-icon">' + esc(currentSiteIcon) + '</div>'
      +   '<div><b>' + esc(currentDomain) + '</b><span>Kontrol ' + (siteActive ? 'aktif' : 'nonaktif') + ' · ' + rulesCount + ' aturan diterapkan</span></div>'
      +   '<div class="right"><small>' + (siteActive ? 'Aktif' : 'Nonaktif') + '</small><button class="ks-toggle' + (siteActive ? ' on' : '') + '" id="ksMasterToggle" aria-label="Toggle kontrol"><i></i></button></div>'
      + '</div>'

      // Tabs — v3.4: tambah tab "Diblokir" (daftar selector domain aktif) + "Pengaturan" (floating Guardian toggle)
      // v3.6: Counter "Diblokir" sekarang juga include filter konten (keyword/channel/account/x_post_url)
      + '<nav class="ks-tabs">'
      +   '<button class="ks-tab' + (activeTab === 'home' ? ' active' : '') + '" data-tab="home">Ringkasan</button>'
      +   '<button class="ks-tab' + (activeTab === 'blocked' ? ' active' : '') + '" data-tab="blocked">Diblokir (' + allBlockedForCurrent.length + ')</button>'
      +   '<button class="ks-tab' + (activeTab === 'content' ? ' active' : '') + '" data-tab="content">Filter konten</button>'
      +   '<button class="ks-tab' + (activeTab === 'settings' ? ' active' : '') + '" data-tab="settings">Pengaturan</button>'
      + '</nav>'

      // Home view
      + '<div class="ks-view' + (activeTab === 'home' ? ' active' : '') + '" id="ksViewHome">'
      // v3.7.2 (Issue 6): Kartu Mode Anak — 1 klik untuk amankan laptop saat dipinjam anak.
      // Mengaktifkan: contentGuardYoutubeKidsOnly + contentGuardBlockShorts.
      +   '<div class="card" style="background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff;border:none;margin-bottom:12px">'
      +     '<div style="display:flex;align-items:center;gap:12px">'
      +       '<div style="font-size:32px">👶</div>'
      +       '<div style="flex:1">'
      +         '<div style="font-size:14px;font-weight:700">Mode Anak</div>'
      +         '<div style="font-size:11px;opacity:.9;line-height:1.45;margin-top:2px">Arahkan semua YouTube ke YouTube Kids & blokir YouTube Shorts. Aktifkan saat laptop dipinjam anak — 1 klik.</div>'
      +       '</div>'
      +       '<button class="ks-toggle' + (s.contentGuardYoutubeKidsOnly === true ? ' on' : '') + '" id="ksKidModeToggle" aria-label="Toggle Mode Anak" style="flex:none"><i></i></button>'
      +     '</div>'
      +   '</div>'
      +   '<div class="ks-intro">'
      +     '<div><h2>Hapus elemen yang mengganggu</h2><p>Tutup komentar, iklan, rekomendasi, dan elemen UI yang tidak perlu di situs mana pun.</p></div>'
      +     '<button class="ks-primary" id="ksAddRule">+ Aturan baru</button>'
      +   '</div>'
      +   '<div class="ks-cards">'
      +     '<button class="ks-action-card" id="ksPickElement"><div class="symbol">⊕</div><b>Pilih elemen di halaman</b><span>Klik elemen apa pun di tab aktif untuk sembunyikan. Bisa diulang untuk beberapa elemen. Esc atau tombol Batal untuk urung.</span></button>'
      +     '<button class="ks-action-card" id="ksAutoHide"><div class="symbol">⊗</div><b>Tutup otomatis</b><span>Preset untuk komentar, iklan, rekomendasi YouTube/X. Aktifkan sekali, berjalan pasif.</span></button>'
      +   '</div>'
      +   '<div class="ks-rule-summary">'
      +     '<div class="ks-rs-head"><span>Aturan aktif (' + rules.length + ')</span></div>'
      +     (rules.length ? rules.map(function (r) {
          // v3.6: Tombol aksi berbeda per jenis rule
          let actionBtn;
          if (r.toggleKey) {
            // Toggle ON/OFF untuk Element Blocker & Content Guard
            actionBtn = '<button class="ks-toggle' + (r.toggleOn ? ' on' : '') + '" data-toggle-key="' + esc(r.toggleKey) + '" aria-label="Toggle ' + esc(r.name) + '"><i></i></button>';
          } else if (r.delId) {
            // Tombol ✕ untuk hapus filter user
            actionBtn = '<button class="ks-dots" data-del-rule="' + esc(r.delId) + '" title="Hapus aturan">✕</button>';
          } else {
            actionBtn = '<button class="ks-dots">⋮</button>';
          }
          return '<div class="ks-rule"><span class="ks-tag' + (r.type === 'KONTEN' ? ' content' : '') + '">' + r.type + '</span>'
            + '<div class="ks-rule-main"><b>' + esc(r.name) + '</b><span>' + esc(r.desc) + '</span></div>'
            + actionBtn + '</div>';
        }).join('') : '<div class="ks-empty"><span class="big">🛡</span>Belum ada aturan. Klik "Aturan baru" untuk memulai.</div>')
      +   '</div>'
      + '</div>'

      // v3.4: Blocked view — daftar semua selector yang di-block di domain aktif
      // v3.6: Sekarang juga tampilkan filter konten (keyword/channel/account/x_post_url)
      + '<div class="ks-view' + (activeTab === 'blocked' ? ' active' : '') + '" id="ksViewBlocked">'
      +   '<div class="ks-intro"><div><h2>Diblokir di ' + esc(currentDomain) + '</h2><p>Daftar semua aturan aktif untuk situs ini. Centang item lalu klik "Hapus terpilih", atau klik ✕ untuk hapus satu-satu.</p></div></div>'
      +   '<div class="ks-batch-bar" id="ksBatchBar" style="display:none;margin-bottom:8px;padding:6px 10px;background:var(--primary-soft);border-radius:var(--r-md);align-items:center;gap:8px;font-size:12px"><label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="ksSelectAll"><span>Pilih semua</span></label><span style="flex:1"></span><span id="ksSelCount">0 dipilih</span><button class="btn btn-d" id="ksBatchDelete" style="padding:4px 12px;font-size:11px">Hapus terpilih</button></div>'
      +   '<div class="ks-rule-summary" style="margin-top:0">'
      +   '<style>.ks-rule .ks-pick{width:16px;height:16px;accent-color:var(--primary);cursor:pointer;flex:none;margin-right:4px}</style>'
      +     (allBlockedForCurrent.length
            ? allBlockedForCurrent.map(function (item) {
                // v3.6: Badge berbeda untuk EB selector vs CG filter
                let badge, delBtn;
                if (item.kind === 'cg_filter') {
                  const typeLabel = (item.rawType || 'keyword').toUpperCase().slice(0, 10);
                  badge = '<span class="ks-tag content">' + esc(typeLabel) + '</span>';
                  delBtn = '<button class="ks-dots" data-del-cg="' + esc(item.rawId || '') + '" title="Hapus filter">✕</button>';
                } else if (item.isPreset) {
                  badge = '<span class="ks-tag">PRESET</span>';
                  delBtn = '<span style="font-size:10px;color:var(--muted);padding:0 8px">preset</span>';
                } else {
                  badge = '<span class="ks-tag content">PICKED</span>';
                  delBtn = '<button class="ks-dots" data-del-sel="' + esc(item.domain) + '" data-sel="' + esc(item.selector) + '" title="Hapus">✕</button>';
                }
                // v3.7.1-FIX: Checkbox untuk multi-select delete
                var pickCheck = '';
                if (item.kind === 'cg_filter') {
                  pickCheck = '<input type="checkbox" class="ks-pick" data-pick-cg-id="' + esc(item.rawId || '') + '">';
                } else if (!item.isPreset) {
                  pickCheck = '<input type="checkbox" class="ks-pick" data-pick-domain="' + esc(item.domain) + '" data-pick-sel="' + esc(item.selector) + '">';
                }
                return '<div class="ks-rule">' + pickCheck + badge
                  + '<div class="ks-rule-main"><b>' + esc(item.selector.slice(0, 70)) + (item.selector.length > 70 ? '…' : '') + '</b>'
                  + '<span>dari: ' + esc(item.ruleName) + '</span></div>'
                  + delBtn + '</div>';
              }).join('')
            : '<div class="ks-empty"><span class="big">⊘</span>Belum ada aturan aktif untuk situs ini. Klik "Pilih elemen di halaman" untuk sembunyikan elemen UI, atau buka tab "Filter konten" untuk tambah kata kunci/channel.</div>')
      +   '</div>'
      + '</div>'

      // Content filter view — v3.4: form lebih lengkap dengan custom keyword + scope + tipe lebih jelas
      + '<div class="ks-view' + (activeTab === 'content' ? ' active' : '') + '" id="ksViewContent">'
      +   '<div class="ks-intro"><div><h2>Filter konten</h2><p>Blokir video/postingan berdasarkan kata kunci (mis. "anjir", "bokep"), kanal YouTube, akun X, atau URL post X.</p></div></div>'
      +   '<div class="ks-content-form">'
      +     '<div class="ks-form-row"><div><b>Jenis filter</b><span>Pilih jenis aturan filter</span></div><select id="ksFilterType"><option value="keyword">Kata kunci (judul/teks/caption)</option><option value="channel">Channel YouTube (nama)</option><option value="account">Akun X (handle)</option><option value="exact_title">Judul persis</option><option value="domain">Domain</option></select></div>'
      +     '<div class="ks-form-row"><div><b>Nilai</b><span>Teks yang akan dicocokkan (case-insensitive)</span></div><input id="ksFilterValue" type="text" placeholder="mis. anjir, bocil, @username, atau URL post X"></div>'
      +     '<div class="ks-form-row"><div><b>Tindakan</b><span>Apa yang dilakukan saat cocok</span></div><select id="ksFilterAction"><option value="hide">Sembunyikan</option><option value="blur">Blur</option><option value="warn">Tampilkan peringatan</option></select></div>'
      +     '<div class="ks-form-row"><div><b>Cakupan</b><span>Di mana aturan berlaku</span></div><select id="ksFilterScope"><option value="all">Semua situs</option><option value="youtube">Hanya YouTube</option><option value="x">Hanya X</option><option value="current">Hanya ' + esc(currentDomain) + '</option></select></div>'
      +     '<div class="ks-save-row"><button class="btn btn-g" id="ksFilterCancel">Batal</button><button class="btn btn-p" id="ksFilterSave">Simpan filter</button></div>'
      +   '</div>'
      // Tips untuk blokir URL post X
      +   '<div class="hintbox" style="margin:10px 3px 0">💡 <b>Tip blokir post X:</b> Klik kanan pada postingan di X → "🚫 Blokir Konten Ini" → pilih "Blokir URL post ini". Postingan dengan URL yang sama akan otomatis disembunyikan di timeline X.</div>'
      +   (userBlocklist.length ? '<div class="ks-rule-summary"><div class="ks-rs-head">Filter tersimpan (' + userBlocklist.length + ')</div>' + userBlocklist.slice(0, 20).map(b => '<div class="ks-rule"><span class="ks-tag content">' + esc((b.type || 'keyword').toUpperCase().slice(0, 8)) + '</span><div class="ks-rule-main"><b>' + esc((b.value || b.text || '').slice(0, 60)) + '</b><span>' + esc(b.type || 'keyword') + (b.domain ? ' · ' + b.domain : '') + '</span></div><button class="ks-dots" data-del="' + esc(b.id) + '">✕</button></div>').join('') + '</div>' : '')
      + '</div>'

      // v3.4: Settings view — toggle floating Guardian + info
      + '<div class="ks-view' + (activeTab === 'settings' ? ' active' : '') + '" id="ksViewSettings">'
      +   '<div class="ks-intro"><div><h2>Pengaturan Guardian</h2><p>Konfigurasi tampilan & perilaku RecallFox Guardian di YouTube & X.</p></div></div>'
      +   '<div class="card">'
      +     '<div class="krow" style="padding:10px 0">'
      +       '<div><b>Panel mengambang Guardian</b><div style="font-size:11px;color:var(--muted);margin-top:2px">Tampilkan panel kontrol mengambang di pojok halaman YouTube/X. Anak-anak bisa melihat dan mematikannya — lebih aman dimatikan.</div></div>'
      +       '<button class="ks-toggle' + (s.contentGuardShowFloating === true ? ' on' : '') + '" id="ksFloatingToggle" aria-label="Toggle floating panel"><i></i></button>'
      +     '</div>'
      +     '<div class="krow" style="padding:10px 0;border-top:1px solid var(--border)">'
      +       '<div><b>Nuclear mode</b><div style="font-size:11px;color:var(--muted);margin-top:2px">Blokir semua konten yang menyebut politisi/partai/lembaga politik Indonesia.</div></div>'
      +       '<button class="ks-toggle' + (s.contentGuardNuclearMode !== false ? ' on' : '') + '" id="ksNuclearToggle" aria-label="Toggle nuclear mode"><i></i></button>'
      +     '</div>'
      +     '<div class="krow" style="padding:10px 0;border-top:1px solid var(--border)">'
      +       '<div><b>Filter feed</b><div style="font-size:11px;color:var(--muted);margin-top:2px">Sembunyikan video/postingan negatif di feed YouTube/X.</div></div>'
      +       '<button class="ks-toggle' + (s.contentGuardFilterFeeds !== false ? ' on' : '') + '" id="ksFilterFeedsToggle" aria-label="Toggle filter feeds"><i></i></button>'
      +     '</div>'
      // v3.7.2 (Issue 6): Toggle individu — YouTube Shorts Block
      +     '<div class="krow" style="padding:10px 0;border-top:1px solid var(--border)">'
      +       '<div><b>🚫 Blokir YouTube Shorts</b><div style="font-size:11px;color:var(--muted);margin-top:2px">Sembunyikan semua Short dari feed YouTube & cegah navigasi ke /shorts/. Tidak mengubah jenis konten lain.</div></div>'
      +       '<button class="ks-toggle' + (s.contentGuardBlockShorts === true ? ' on' : '') + '" id="ksBlockShortsToggle" aria-label="Toggle Block Shorts"><i></i></button>'
      +     '</div>'
      // v3.7.2 (Issue 6): Toggle individu — YouTube Kids Only
      +     '<div class="krow" style="padding:10px 0;border-top:1px solid var(--border)">'
      +       '<div><b>👶 YouTube Kids Only</b><div style="font-size:11px;color:var(--muted);margin-top:2px">Redirect semua youtube.com ke youtubekids.com. Konten hanya yang sudah tervalidasi aman untuk anak.</div></div>'
      +       '<button class="ks-toggle' + (s.contentGuardYoutubeKidsOnly === true ? ' on' : '') + '" id="ksKidsOnlyToggle" aria-label="Toggle YouTube Kids Only"><i></i></button>'
      +     '</div>'
      +   '</div>'
      +   '<p class="hintbox" style="margin:10px 3px">🔒 <b>Mode aman anak:</b> Matikan panel mengambang supaya anak tidak bisa toggle-off Guardian dari halaman. Kontrol tetap bisa diakses lewat popup RecallFox (hanya Anda yang tahu).</p>'
      + '</div>'

      + '<p class="hintbox" style="margin:15px 3px">💡 <b>Kontrol Situs</b> menggabungkan Element Blocker (sembunyikan elemen UI) dan Content Guard (filter konten negatif). Kedua fitur tetap berjalan di background — halaman ini hanya untuk konfigurasi.</p>';

    // Bind tab clicks
    $$('.ks-tab').forEach(t => t.addEventListener('click', () => {
      activeTab = t.dataset.tab;
      render();
    }));

    // Master toggle
    const masterToggle = $('#ksMasterToggle');
    if (masterToggle) masterToggle.addEventListener('click', async () => {
      const newOn = !siteActive;
      await saveSettings({
        elementBlockerEnabled: newOn,
        contentGuardEnabled: newOn
      });
      await refreshVault();
      renderKontrolSitusPage(B);
      toast(newOn ? '🛡 Kontrol Situs diaktifkan' : 'Kontrol Situs dimatikan');
    });

    // v3.7.2 (Issue 6): Mode Anak — 1 klik toggle (YouTube Kids + Block Shorts sekaligus)
    const kidModeBtn = $('#ksKidModeToggle');
    if (kidModeBtn) kidModeBtn.addEventListener('click', async () => {
      const newOn = !(s.contentGuardYoutubeKidsOnly === true);
      // Pastikan contentGuardEnabled tetap on agar redirect jalan
      await saveSettings({
        contentGuardEnabled: true,
        contentGuardYoutubeKidsOnly: newOn,
        contentGuardBlockShorts: newOn
      });
      await refreshVault();
      renderKontrolSitusPage(B);
      toast(newOn ? '👶 Mode Anak AKTIF — YouTube → Kids, Shorts diblokir' : 'Mode Anak dimatikan');
    });

    // v3.7.2 (Issue 6): Toggle individu — Block Shorts saja
    const blockShortsBtn = $('#ksBlockShortsToggle');
    if (blockShortsBtn) blockShortsBtn.addEventListener('click', async () => {
      const newOn = !(s.contentGuardBlockShorts === true);
      await saveSettings({
        contentGuardEnabled: true,
        contentGuardBlockShorts: newOn
      });
      await refreshVault();
      renderKontrolSitusPage(B);
      toast(newOn ? '🚫 YouTube Shorts diblokir' : 'YouTube Shorts diizinkan');
    });

    // v3.7.2 (Issue 6): Toggle individu — YouTube Kids Only
    const kidsOnlyBtn = $('#ksKidsOnlyToggle');
    if (kidsOnlyBtn) kidsOnlyBtn.addEventListener('click', async () => {
      const newOn = !(s.contentGuardYoutubeKidsOnly === true);
      await saveSettings({
        contentGuardEnabled: true,
        contentGuardYoutubeKidsOnly: newOn
      });
      await refreshVault();
      renderKontrolSitusPage(B);
      toast(newOn ? '👶 YouTube → Kids redirect aktif' : 'YouTube Kids redirect dimatikan');
    });

    // Add rule buttons (open same sheet)
    ['ksAddRule'].forEach(id => {
      const el = $('#' + id);
      if (el) el.addEventListener('click', () => {
        // Switch to content filter view
        activeTab = 'content';
        render();
        setTimeout(() => $('#ksFilterValue')?.focus(), 100);
      });
    });

    // v3.4: Delete selector buttons (di tab "Diblokir")
    $$('[data-del-sel]').forEach(btn => btn.addEventListener('click', async () => {
      const domain = btn.dataset.delSel;
      const sel = btn.dataset.sel;
      if (!domain || !sel) return;
      await removeElementBlockerSelector(domain, sel);
      await refreshVault();
      renderKontrolSitusPage(B);
      toast('✕ Elemen dihapus dari daftar blok');
    }));

    // v3.7.1-FIX: Batch select & delete untuk Element Blocker
    const batchBar = $('#ksBatchBar');
    const selectAllBox = $('#ksSelectAll');
    const selCountEl = $('#ksSelCount');
    const allPickBoxes = () => [...$$('.ks-pick')];
    const updateBatchUI = () => {
      const checked = allPickBoxes().filter(c => c.checked).length;
      if (selCountEl) selCountEl.textContent = checked + ' dipilih';
      if (batchBar) batchBar.style.display = checked > 0 ? 'flex' : 'none';
      if (selectAllBox) selectAllBox.checked = allPickBoxes().length > 0 && checked === allPickBoxes().length;
    };
    if (selectAllBox) selectAllBox.addEventListener('change', () => {
      const on = selectAllBox.checked;
      allPickBoxes().forEach(c => { c.checked = on; });
      updateBatchUI();
    });
    allPickBoxes().forEach(c => c.addEventListener('change', updateBatchUI));
    const batchDelBtn = $('#ksBatchDelete');
    if (batchDelBtn) batchDelBtn.addEventListener('click', async () => {
      const checked = allPickBoxes().filter(c => c.checked);
      if (!checked.length) { toast('Tidak ada item dipilih', false); return; }
      let deleted = 0;
      for (const c of checked) {
        if (c.dataset.pickCgId) {
          await removeUserBlocklistEntry(c.dataset.pickCgId);
          deleted++;
        } else if (c.dataset.pickDomain && c.dataset.pickSel) {
          await removeElementBlockerSelector(c.dataset.pickDomain, c.dataset.pickSel);
          deleted++;
        }
      }
      await refreshVault();
      renderKontrolSitusPage(B);
      toast('✓ ' + deleted + ' item dihapus dari daftar blok');
    });

    // v3.6: Delete CG filter buttons (di tab "Diblokir")
    $$('[data-del-cg]').forEach(btn => btn.addEventListener('click', async () => {
      const id = btn.dataset.delCg;
      if (!id) return;
      await removeUserBlocklistEntry(id);
      await refreshVault();
      renderKontrolSitusPage(B);
      toast('✕ Filter konten dihapus');
    }));

    // v3.6: Toggle per-feature (Element Blocker / Content Guard) di "Aturan aktif"
    $$('[data-toggle-key]').forEach(btn => btn.addEventListener('click', async () => {
      const key = btn.dataset.toggleKey;
      if (!key) return;
      // Baca current value, lalu toggle
      const v = await getVault();
      const currentOn = v.settings[key] !== false;
      const newOn = !currentOn;
      const update = {};
      update[key] = newOn;
      await saveSettings(update);
      // Broadcast update
      try {
        const tabs = await browser.tabs.query({});
        for (const t of tabs) {
          browser.tabs.sendMessage(t.id, { type: 'EB_RULES_UPDATED' }).catch(() => {});
          browser.tabs.sendMessage(t.id, { type: 'CG_SETTINGS_UPDATED' }).catch(() => {});
        }
      } catch (e) {}
      await refreshVault();
      renderKontrolSitusPage(B);
      toast((newOn ? '✓ ' : '✕ ') + (key === 'elementBlockerEnabled' ? 'Element Blocker' : 'Content Guard') + (newOn ? ' aktif' : ' dimatikan'));
    }));

    // v3.6: Delete rule buttons (di "Aturan aktif" - untuk filter user)
    $$('[data-del-rule]').forEach(btn => btn.addEventListener('click', async () => {
      const id = btn.dataset.delRule;
      if (!id) return;
      await removeUserBlocklistEntry(id);
      await refreshVault();
      renderKontrolSitusPage(B);
      toast('✕ Aturan dihapus');
    }));

    // v3.4: Floating panel toggle
    const floatingToggle = $('#ksFloatingToggle');
    if (floatingToggle) floatingToggle.addEventListener('click', async () => {
      const newOn = s.contentGuardShowFloating !== true;
      await setGuardianFloatingEnabled(newOn);
      // Re-read settings
      const v = await getVault();
      s.contentGuardShowFloating = v.settings.contentGuardShowFloating;
      render();
      toast(newOn ? '🛡 Panel mengambang diaktifkan' : '🔒 Panel mengambang dimatikan (lebih aman untuk anak)');
    });

    // v3.4: Nuclear mode toggle
    const nuclearToggle = $('#ksNuclearToggle');
    if (nuclearToggle) nuclearToggle.addEventListener('click', async () => {
      const newOn = s.contentGuardNuclearMode === false;
      await saveSettings({ contentGuardNuclearMode: newOn });
      s.contentGuardNuclearMode = newOn;
      // Broadcast
      try {
        const tabs = await browser.tabs.query({});
        for (const t of tabs) browser.tabs.sendMessage(t.id, { type: 'CG_SETTINGS_UPDATED' }).catch(() => {});
      } catch (e) {}
      render();
      toast(newOn ? '☢️ Nuclear mode aktif' : 'Nuclear mode dimatikan');
    });

    // v3.4: Filter feeds toggle
    const filterFeedsToggle = $('#ksFilterFeedsToggle');
    if (filterFeedsToggle) filterFeedsToggle.addEventListener('click', async () => {
      const newOn = s.contentGuardFilterFeeds === false;
      await saveSettings({ contentGuardFilterFeeds: newOn });
      s.contentGuardFilterFeeds = newOn;
      try {
        const tabs = await browser.tabs.query({});
        for (const t of tabs) browser.tabs.sendMessage(t.id, { type: 'CG_SETTINGS_UPDATED' }).catch(() => {});
      } catch (e) {}
      render();
      toast(newOn ? '🛡 Filter feed aktif' : 'Filter feed dimatikan');
    });

    // Pick element button (triggers element picker in active tab)
    const pickBtn = $('#ksPickElement');
    if (pickBtn) pickBtn.addEventListener('click', async () => {
      try {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        if (!tabs[0]?.id) { toast('Tidak ada tab aktif', false); return; }
        const tabUrl = tabs[0].url || '';
        // Cek apakah URL bisa di-inject (http/https saja — bukan about:, moz-extension:, dll)
        if (!/^https?:\/\//i.test(tabUrl)) {
          toast('Picker tidak bisa aktif di halaman ini (hanya http/https)', false);
          return;
        }
        // Kirim pesan activate ke content script
        try {
          await browser.tabs.sendMessage(tabs[0].id, { type: 'START_ELEMENT_PICKER' });
        } catch (sendErr) {
          // Fallback: coba inject via scripting API kalau content script belum loaded
          try {
            await browser.scripting.executeScript({
              target: { tabId: tabs[0].id },
              files: ['content/elementblocker-cs.js']
            });
            // Tunggu sebentar lalu coba kirim pesan lagi
            await new Promise(r => setTimeout(r, 200));
            await browser.tabs.sendMessage(tabs[0].id, { type: 'START_ELEMENT_PICKER' });
          } catch (injErr) {
            toast('Tidak bisa mulai picker di tab ini', false);
            return;
          }
        }
        toast('🎯 Klik elemen apa pun untuk sembunyikan · Esc untuk batal');
        // Tutup popup agar user bisa berinteraksi dengan halaman
        if (!document.body.classList.contains('rf-sidebar-body')) setTimeout(() => window.close(), 1200);
      } catch (e) {
        toast('Tidak bisa mulai picker: ' + (e.message || 'error'), false);
      }
    });

    // Auto-hide preset button (toggle content guard + element blocker presets)
    const autoBtn = $('#ksAutoHide');
    if (autoBtn) autoBtn.addEventListener('click', async () => {
      await saveSettings({
        elementBlockerEnabled: true,
        contentGuardEnabled: true,
        contentGuardBlockYtChannels: true,
        contentGuardBlockXAccounts: true,
        contentGuardFilterFeeds: true
      });
      await refreshVault();
      renderKontrolSitusPage(B);
      toast('✓ Preset otomatis aktif (komentar, iklan, rekomendasi)');
    });

    // Save filter button
    const saveFilterBtn = $('#ksFilterSave');
    if (saveFilterBtn) saveFilterBtn.addEventListener('click', async () => {
      const type = $('#ksFilterType').value;
      const value = $('#ksFilterValue').value.trim();
      const action = $('#ksFilterAction').value;
      const scope = $('#ksFilterScope').value;
      if (!value) { toast('Isi nilai filter dulu', false); return; }
      const domain = scope === 'current' ? currentDomain : (scope === 'youtube' ? 'youtube.com' : scope === 'x' ? 'x.com' : null);
      // v3.4: Pakai field `value` (bukan `text`) supaya konsisten dengan helper matchesUserBlocklist
      // dan addUserBlocklistEntry. `text` hanya untuk display fallback di UI lama.
      const entry = {
        value: value,
        type,
        action,
        domain,
        createdAt: new Date().toISOString(),
        text: value  // untuk backward compat dengan UI lama yang baca .text
      };
      // v3.4: Untuk tipe 'account' (akun X), normalisasi handle — strip @ prefix
      if (type === 'account' && entry.value.startsWith('@')) {
        entry.value = entry.value.slice(1);
      }
      await addUserBlocklistEntry(entry);
      await refreshVault();
      renderKontrolSitusPage(B);
      toast('✓ Filter "' + value.slice(0, 30) + '" disimpan');
    });

    // Cancel filter
    const cancelBtn = $('#ksFilterCancel');
    if (cancelBtn) cancelBtn.addEventListener('click', () => {
      $('#ksFilterValue').value = '';
    });

    // Delete user blocklist entries
    $$('[data-del]').forEach(btn => btn.addEventListener('click', async () => {
      const id = btn.dataset.del;
      await removeUserBlocklistEntry(id);
      await refreshVault();
      renderKontrolSitusPage(B);
      toast('Aturan dihapus');
    }));
  }

  render();
}

// ============ Prayer Setup modal ============
function openPrayerSetup() {
  const s = currentVault?.settings || {};
  $('#prayerAddr').value = '';
  $('#prayerSugg').innerHTML = '';
  $('#prayerAsr').value = String(s.prayerAsrSchool || 0);
  $('#prayerFormat').value = s.prayerTimeFormat || '24h';
  const currentEl = $('#prayerCurrent');
  if (typeof s.prayerLatitude === 'number') {
    currentEl.textContent = s.prayerLocation || (s.prayerLatitude.toFixed(4) + ', ' + s.prayerLongitude.toFixed(4));
  } else {
    currentEl.textContent = '— belum diset —';
  }
  prayerPendingLocation = (typeof s.prayerLatitude === 'number')
    ? { lat: s.prayerLatitude, lng: s.prayerLongitude, display: s.prayerLocation || '' }
    : null;
  $('#prayerSetupOverlay').style.display = 'flex';
}
function closePrayerSetup() { $('#prayerSetupOverlay').style.display = 'none'; }
async function savePrayerSetup() {
  const asr = parseInt($('#prayerAsr').value, 10) || 0;
  const fmt = $('#prayerFormat').value;
  if (!prayerPendingLocation) { toast('Set lokasi dulu', false); return; }
  await saveSettings({
    prayerEnabled: true,
    prayerLatitude: prayerPendingLocation.lat,
    prayerLongitude: prayerPendingLocation.lng,
    prayerLocation: prayerPendingLocation.display || '',
    prayerAsrSchool: asr,
    prayerTimeFormat: fmt,
    prayerCachedTimes: null
  });
  await refreshVault();
  closePrayerSetup();
  await updatePrayerStrip();
  toast('🕌 Shalat diaktifkan ✓');
}
async function prayerGeolocate() {
  const btn = $('#prayerGeo');
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = '📍 Mendeteksi…';
  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
    });
    const lat = pos.coords.latitude, lng = pos.coords.longitude;
    btn.textContent = '🗺️ Mencari nama lokasi…';
    const res = await browser.runtime.sendMessage({ type: 'PRAYER_REVERSE_GEOCODE', lat, lng });
    const display = res?.ok ? (res.location || (lat.toFixed(4) + ', ' + lng.toFixed(4))) : (lat.toFixed(4) + ', ' + lng.toFixed(4));
    prayerPendingLocation = { lat, lng, display };
    $('#prayerCurrent').textContent = display;
    btn.textContent = '✓ Lokasi terdeteksi';
  } catch (e) {
    let msg = 'Gagal: ' + e.message;
    if (e.code === 1) msg = 'Izin lokasi ditolak. Cari alamat manual di atas.';
    else if (e.code === 3) msg = 'Timeout. Coba lagi.';
    btn.textContent = '⚠ ' + msg;
  } finally {
    setTimeout(() => { btn.disabled = false; btn.textContent = orig; }, 2500);
  }
}
function prayerAddrInputHandler() {
  const addr = $('#prayerAddr').value;
  const sugg = $('#prayerSugg');
  if (addr.trim().length < 3) { sugg.innerHTML = ''; return; }
  clearTimeout(prayerGeocodeTimer);
  prayerGeocodeTimer = setTimeout(async () => {
    try {
      const res = await browser.runtime.sendMessage({ type: 'PRAYER_GEOCODE', address: addr });
      if (!res?.ok || !res.results) { sugg.innerHTML = ''; return; }
      sugg.innerHTML = res.results.slice(0, 5).map(r => '<div class="sugg-item" data-lat="' + r.lat + '" data-lng="' + r.lng + '" data-display="' + escAttr(r.display) + '">' + esc(r.display) + '</div>').join('');
      sugg.querySelectorAll('.sugg-item').forEach(el => el.addEventListener('click', () => {
        prayerPendingLocation = { lat: parseFloat(el.dataset.lat), lng: parseFloat(el.dataset.lng), display: el.dataset.display };
        $('#prayerCurrent').textContent = el.dataset.display;
        sugg.innerHTML = '';
        $('#prayerAddr').value = el.dataset.display;
      }));
    } catch (e) { sugg.innerHTML = ''; }
  }, 400);
}

// ============ Variables modal ============
function openVarsModal(vars) {
  $('#varsFields').innerHTML = vars.map(v => '<div class="var-field"><label>{{' + esc(v) + '}}</label><input type="text" data-var="' + escAttr(v) + '" placeholder="' + escAttr(v) + '"></div>').join('');
  $('#varsOverlay').style.display = 'flex';
  const first = $('#varsFields input'); if (first) first.focus();
}
function closeVarsModal() { $('#varsOverlay').style.display = 'none'; pendingInjectItem = null; }
async function confirmInjectWithVars() {
  if (!pendingInjectItem) { closeVarsModal(); return; }
  const vals = {};
  $$('#varsFields input').forEach(i => { vals[i.dataset.var] = i.value; });
  const body = fillVariables(pendingInjectItem.body, vals);
  closeVarsModal();
  await doInject(body, pendingInjectItem.id);
  pendingInjectItem = null;
}

// ============ Attach modal ============
let attachItemId = null;
function openAttachModal(itemId) {
  attachItemId = itemId;
  attachSelected = new Set();
  $('#attachSearch').value = '';
  $('#attachOverlay').style.display = 'flex';
  renderAttachList();
}
function closeAttachModal() { $('#attachOverlay').style.display = 'none'; attachItemId = null; }
function renderAttachList() {
  const q = ($('#attachSearch').value || '').toLowerCase();
  const items = (currentVault?.items || []).filter(i => i.type === 'link');
  const filtered = q ? items.filter(i => (i.title + ' ' + (i.linkUrl || '') + ' ' + (i.tags || []).join(' ')).toLowerCase().indexOf(q) >= 0) : items;
  $('#attachList').innerHTML = filtered.length ? filtered.map(it => '<label class="attach-row"><input type="checkbox" value="' + it.id + '"' + (attachSelected.has(it.id) ? ' checked' : '') + '><span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(it.title) + '</span></label>').join('') : '<div style="padding:14px;font-size:11px;color:var(--muted);text-align:center">Tidak ada link di vault.</div>';
  $$('#attachList .attach-row input').forEach(c => c.addEventListener('change', () => {
    if (c.checked) attachSelected.add(c.value); else attachSelected.delete(c.value);
    renderAttachPreview();
  }));
}
async function renderAttachPreview() {
  const item = currentVault?.items.find(i => i.id === attachItemId);
  if (!item) { $('#attachPreview').textContent = ''; return; }
  const links = [...attachSelected].map(id => currentVault.items.find(i => i.id === id)).filter(Boolean);
  let text = item.body || '';
  const intro = $('#attachIntro').value || '';
  const position = $('#attachPosition').value;
  const linkText = links.map(l => '• ' + (l.title || '') + ' — ' + (l.linkUrl || l.body || '')).join('\n');
  const full = position === 'above' ? (intro + '\n' + linkText + '\n\n' + text) : (text + '\n\n' + intro + '\n' + linkText);
  $('#attachPreview').textContent = full;
}
async function confirmAttachInject() {
  const item = currentVault?.items.find(i => i.id === attachItemId);
  if (!item) { closeAttachModal(); return; }
  const links = [...attachSelected].map(id => currentVault.items.find(i => i.id === id)).filter(Boolean);
  let text = item.body || '';
  const intro = $('#attachIntro').value || '';
  const position = $('#attachPosition').value;
  const linkText = links.map(l => '• ' + (l.title || '') + ' — ' + (l.linkUrl || l.body || '')).join('\n');
  const full = position === 'above' ? (intro + '\n' + linkText + '\n\n' + text) : (text + '\n\n' + intro + '\n' + linkText);
  const finalBody = await buildFinalPrompt(full, item.toppings || []);
  closeAttachModal();
  await doInject(finalBody, item.id);
}

// ============ Refresh & init ============
async function refreshVault() {
  currentVault = await getVault();
  // v3.7.2 (Issue 4): Muat catatan juga supaya search bisa mencari di notes
  // tanpa user harus klik tab Catatan dulu.
  try { currentNotes = await getNotes(); } catch (e) { currentNotes = []; }
  renderVault();
}
async function init() {
  try { await initTheme(); } catch (e) { console.warn('initTheme failed:', e); }
  try { await refreshVault(); } catch (e) { console.warn('refreshVault failed:', e); }
  try { await detectAiContext(); } catch (e) {}

  // Sticky bars
  await Promise.allSettled([updatePrayerStrip(), updateHabitsStrip(), updateFastStrip()]);
  setInterval(() => Promise.allSettled([updatePrayerStrip(), updateHabitsStrip(), updateFastStrip()]), 60000);

  // Render tools + notes (lazy)
  renderTools();
  await renderNotes();

  bindEvents();
  renderVault();

  // Width responsive for sidebar
  if (document.body.classList.contains('rf-sidebar-body')) {
    const setW = () => {
      const w = window.innerWidth;
      $('#popup').classList.toggle('w-sm', w <= 310);
    };
    setW();
    window.addEventListener('resize', setW);
  }

  // Focus search
  try { setTimeout(() => $('#search')?.focus(), 300); } catch (e) {}
}

function bindEvents() {
  // Theme + header
  // v3.7.1-FIX: Set ikon untuk tombol header (sebelumnya kosong/tidak terlihat)
  $('#aiBtn').innerHTML = ICONS.spark;
  $('#settingsBtn').innerHTML = ICONS.gear;
  $('#themeBtn').addEventListener('click', toggleTheme);
  $('#settingsBtn').addEventListener('click', () => browser.runtime.openOptionsPage());
  $('#aiBtn').addEventListener('click', aiToolsSheet);
  $('#scrim').addEventListener('click', closeSheet);
  $('#pageBack').addEventListener('click', closePage);

  // Status strip
  $('#stripBar').addEventListener('click', () => $('#strip').classList.toggle('open'));
  $('#habitQuran').addEventListener('click', async () => {
    const s = currentVault?.settings || {};
    if (s.quranEnabled !== false) { await logQuranPages(1, s); await refreshVault(); await updateHabitsStrip(); toast('📖 Ngaji +1 hal'); }
  });
  $('#habitGym').addEventListener('click', async () => {
    const s = currentVault?.settings || {};
    if (s.exerciseEnabled !== false) { await logExerciseDone(s); await refreshVault(); await updateHabitsStrip(); toast('🏃 Olahraga tercatat'); }
  });

  // Hero tiles
  $('#qaPrompt').addEventListener('click', savePromptSheet);
  $('#qaKonteks').addEventListener('click', saveKonteksSheet);
  $('#qaLink').addEventListener('click', saveLinkSheet);
  $('#qaBundle').addEventListener('click', saveBundleSheet);
  $('#qaSnap').addEventListener('click', snapshotFlow);
  $('#qaShot').addEventListener('click', () => doShot());

  // Add item button
  $('#addItemBtn').addEventListener('click', addItemMenu);
  $('#noteAddBtn').addEventListener('click', newNote);

  // Tab bar
  $('#tabHome').addEventListener('click', () => setView('home'));
  $('#tabNotes').addEventListener('click', () => setView('notes'));
  $('#tabTools').addEventListener('click', () => setView('tools'));

  // Search / command bar
  $('#search').addEventListener('input', e => { currentQuery = e.target.value; renderSearch(); });
  $('#search').addEventListener('keydown', e => {
    if (e.key === 'Escape') { clearSearch(); e.target.blur(); }
  });
  document.addEventListener('keydown', e => {
    const inField = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if ((e.key === '/' || (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey))) && !inField) {
      e.preventDefault();
      setView('home');
      $('#search').focus();
    }
    if (e.key === 'Escape') {
      if ($('#prayerSetupOverlay').style.display !== 'none') closePrayerSetup();
      else if ($('#varsOverlay').style.display !== 'none') closeVarsModal();
      else if ($('#attachOverlay').style.display !== 'none') closeAttachModal();
      else if ($('#sheet').classList.contains('show')) closeSheet();
      else if ($('#page').classList.contains('in')) closePage();
    }
  });

  // Prayer setup
  $('#prayerSetupClose').addEventListener('click', closePrayerSetup);
  $('#prayerSetupCancel').addEventListener('click', closePrayerSetup);
  $('#prayerSetupSave').addEventListener('click', savePrayerSetup);
  $('#prayerGeo').addEventListener('click', prayerGeolocate);
  $('#prayerAddr').addEventListener('input', prayerAddrInputHandler);

  // Vars modal
  $('#varsClose').addEventListener('click', closeVarsModal);
  $('#varsCancel').addEventListener('click', closeVarsModal);
  $('#varsInject').addEventListener('click', confirmInjectWithVars);

  // Attach modal
  $('#attachClose').addEventListener('click', closeAttachModal);
  $('#attachCancel').addEventListener('click', closeAttachModal);
  $('#attachInject').addEventListener('click', confirmAttachInject);
  $('#attachSearch').addEventListener('input', renderAttachList);
  $('#attachIntro').addEventListener('input', renderAttachPreview);
  $('#attachPosition').addEventListener('change', renderAttachPreview);
}

// Listen for storage changes (sync) — guard for non-extension contexts
if (typeof browser !== 'undefined' && browser.storage && browser.storage.onChanged) {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.recallfox_vault || changes.recallfox_notes)) {
      refreshVault();
      renderNotes();
    }
  });
}

init().catch(e => console.error('[RecallFox] init failed:', e));
