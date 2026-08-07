// popup/popup.js — RecallFox v3 task-based UI
// Wired to the new DOM structure but reuses the same backend lib functions.

import {
  getVault,
  saveVault,
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
import { AI_TOOLS, groupByRegion, matchCurrentTool, getEffectiveTools, getVisibleTools } from '../lib/ai-tools.js';
import { getAllToppings, buildFinalPrompt } from '../lib/toppings.js';
import { getNextPrayerIncludingSunnah, getLastPassedPrayer, getSunnahPrayers, formatCountdown, to12Hour } from '../lib/salahtime.js';
import { buildTree, createGroup, isGroupItem, getParentId, setParentId, aiAutoGroup } from '../lib/vault-tree.js';
// v3.20.32: Magic Command — natural language move items to folder + folder archive
import { parseMagicCommand, parseMultiStepCommand, applyMagicCommand, applyMultiStepMagicCommand, archiveFolderRecursive, unarchiveFolderRecursive } from '../lib/magic-command.js';
import { dbToPercent, percentToDb, formatPercent, MIN_DB, MAX_DB } from '../lib/volume.js';
import { getUpcomingFasts, formatHijriDate, parseHijriString, HIJRI_MONTHS, getSunnahFast } from '../lib/islamicCalendar.js';
import { getQuranStatus, getExerciseStatus, logQuranPages, logExerciseDone, snoozeExercise, getHabits } from '../lib/habits.js';
import { getUserBlocklist, addUserBlocklistEntry, removeUserBlocklistEntry } from '../lib/storage.js';
// v3.7: Import untuk halaman Backup & Tanya AI yang lebih kaya
import { getProviderList, getProviderInfo, chatWithFallback, isAssistantConfigured, buildSystemPrompt } from '../lib/assistant.js';
import { manualBackupWithTimestamp, getBackupMetadata, restoreFromFile } from '../lib/autobackup.js';
// v3.11.34: Shared clipboard format helper — supaya sidebar/batch/preview-modal
// semua pakai format yang sama persis.
import { buildScreenshotCaption, buildBatchCaption, buildDocumentCaption, writeScreenshotToClipboard, writeImageOnlyToClipboard, buildCompositeImage } from '../lib/copy-format.js';
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
// v3.16.7 #5: Bundle scope — filter vault by bundle (workspace proyek)
// Kalau set, visibleItems() hanya tampilkan item yang jadi anggota bundle ini.
// User bisa klik "👁 Lihat anggota" di bundle card untuk set scope.
let currentBundleScope = null;  // bundle id atau null
let currentQuery = '';
let currentView = 'home';
let editingId = null;
let editingNoteId = null;
let pendingInjectItem = null;
let editorToppings = [];
// v3.17.1: Tree/grouping state
let expandedGroupIds = [];  // v3.18.0: group IDs yang expanded (persisted ke vault.settings)
let draggedItemId = null;   // v3.18.0: item ID yang sedang di-drag
// v3.20.24: Dedupe Set untuk lazy reverse geocode — track item ID yang sedang
// di-reverse geocode di background, supaya tidak kirim request berkali-kali
// untuk item yang sama dalam satu render cycle.
const _pendingReverseGeocode = new Set();
// v3.19.0: File manager features
let vaultSortMode = localStorage.getItem('rf_vault_sort') || 'recent';
let activeTagFilter = null;
let showRecentOnly = false;
let allToppingsCache = [];
let prayerPendingLocation = null;
let prayerGeocodeTimer = null;
let prayerTimesCache = null;
let noteSaveTimer = null;
let attachSelected = new Set();
// v3.7.2 (Issue 5): filter grup catatan aktif ('' = semua, atau nama grup spesifik)
let currentNoteGroup = '';
// v3.13.0 (Issue #3 — Any.do-inspired): state untuk search/sort/view mode di notes.
// Persist ke vault.settings.notesPrefs via saveVault() supaya tahan reload + cross-device.
let notesSortMode = 'recent';        // 'recent' | 'title' | 'created'
let notesViewMode = 'list';          // 'list' | 'grid'
let notesSearchQuery = '';           // string, case-insensitive

// ============ Helpers ============
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
function escAttr(s) { return esc(s); }

// v3.13.0 (Issue #4): Rich text helpers — paste sanitization + body load + preview strip.
// Whitelist approach: hanya tag & atribut yang aman yang dipertahankan, sisanya dibuang.
// Tidak ada library WYSIWYG pihak ketiga — Vanilla JS murni.
const NOTE_HTML_WHITELIST_TAGS = new Set([
  'P','BR','B','STRONG','I','EM','U','S','STRIKE','SPAN','DIV',
  'UL','OL','LI','DL','DT','DD',
  'H1','H2','H3','H4','H5','H6',
  'TABLE','THEAD','TBODY','TFOOT','TR','TD','TH','CAPTION','COLGROUP','COL',
  'BLOCKQUOTE','PRE','CODE','HR','A','IMG','SUB','SUP','MARK','SMALL'
]);
const NOTE_HTML_WHITELIST_ATTRS = new Set([
  'href','title','alt','src','colspan','rowspan','target','rel','width','height',
  'align','valign','bgcolor','color','data-color'
]);

/**
 * Sanitize HTML untuk contenteditable — hapus tag/atribut berbahaya.
 * @param {string} html - HTML mentah dari clipboard
 * @returns {string} HTML aman untuk innerHTML
 */
function sanitizeNoteHtml(html) {
  if (!html) return '';
  try {
    const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
    const root = doc.body.firstChild;
    if (!root) return '';
    cleanNode(root);
    return root.innerHTML;
  } catch (e) {
    // Fallback: escape semua + convert newline
    return esc(html).replace(/\n/g, '<br>');
  }
}

function cleanNode(node) {
  // Iterasi child dari belakang supaya removal aman
  const children = Array.from(node.childNodes);
  for (const child of children) {
    if (child.nodeType === Node.TEXT_NODE) continue;
    if (child.nodeType === Node.COMMENT_NODE) {
      node.removeChild(child);
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) {
      node.removeChild(child);
      continue;
    }
    const tag = child.tagName;
    // Hapus tag berbahaya beserta isinya (script, style, iframe, object, embed, meta, link)
    if (['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','META','LINK','NOSCRIPT','TEMPLATE','FORM','INPUT','BUTTON','TEXTAREA','SELECT','OPTION'].includes(tag)) {
      node.removeChild(child);
      continue;
    }
    // Unwrap tag yang tidak ada di whitelist (ganti dengan children-nya)
    if (!NOTE_HTML_WHITELIST_TAGS.has(tag)) {
      const parent = node;
      const frag = document.createDocumentFragment();
      while (child.firstChild) frag.appendChild(child.firstChild);
      parent.insertBefore(frag, child);
      parent.removeChild(child);
      // Jangan recurse ke child yang sudah di-unwrap; tapi children-nya sudah di parent
      continue;
    }
    // Bersihkan atribut
    const attrs = Array.from(child.attributes);
    for (const attr of attrs) {
      const name = attr.name.toLowerCase();
      const value = attr.value;
      // Hapus semua on* event handler
      if (name.startsWith('on')) { child.removeAttribute(attr.name); continue; }
      // Hapus atribut di luar whitelist
      if (!NOTE_HTML_WHITELIST_ATTRS.has(name)) { child.removeAttribute(attr.name); continue; }
      // Hapus javascript: URLs
      if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(value)) {
        child.removeAttribute(attr.name); continue;
      }
      // Hapus data: URLs di src (kecuali data:image)
      if (name === 'src' && value.startsWith('data:') && !value.startsWith('data:image/')) {
        child.removeAttribute(attr.name); continue;
      }
      // Force target=_blank + rel=noopener untuk <a>
      if (tag === 'A' && name === 'href') {
        child.setAttribute('target', '_blank');
        child.setAttribute('rel', 'noopener noreferrer');
      }
    }
    // Recurse ke child
    cleanNode(child);
  }
}

/**
 * Load note body untuk ditampilkan di contenteditable editor.
 * - Catatan lama (plain text) → escape + newline → <br>
 * - Catatan baru (HTML) → sanitize untuk jaga-jaga XSS
 * @param {string} body - body dari storage (plain text lama atau HTML baru)
 * @returns {string} HTML aman untuk innerHTML
 */
function loadNoteBody(body) {
  if (!body) return '';
  // Deteksi: kalau body mengandung tag HTML yang umum → anggap HTML
  if (/<(p|br|b|strong|i|em|u|s|strike|span|div|ul|ol|li|table|thead|tbody|tr|td|th|h[1-6]|blockquote|pre|code|hr|a|img)\b/i.test(body)) {
    return sanitizeNoteHtml(body);
  }
  // Plain text lama — escape + convert newline ke <br>
  return esc(body).replace(/\n/g, '<br>');
}

/**
 * Strip HTML → plain text untuk preview di note-card list.
 * @param {string} html - body (HTML atau plain text)
 * @returns {string} plain text
 */
function stripHtmlForPreview(html) {
  if (!html) return '';
  // Kalau tidak ada tag HTML, kembalikan apa adanya
  if (!/<[a-z][\s\S]*>/i.test(html)) return html;
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  // Ambil textContent, replace nbsp, collapse whitespace
  let txt = (tmp.textContent || '').replace(/\u00a0/g, ' ');
  return txt;
}
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
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>',
  // v3.11.7-fix (code quality): Tambah icon cloud untuk tool Sync Cloud (sebelumnya pakai fallback emoji)
  cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>'
};

const TYPE = {
  prompt: { label: 'Prompt', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-3.5-.7L4 20l1-4.1A8.4 8.4 0 1 1 21 11.5z"/></svg>' },
  context: { label: 'Konteks', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>' },
  snapshot: { label: 'Snapshot', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-3.5-.7L4 20l1-4.1A8.4 8.4 0 1 1 21 11.5z"/><circle cx="12" cy="11.5" r="1"/><circle cx="16" cy="11.5" r="1"/><circle cx="8" cy="11.5" r="1"/></svg>' },
  screenshot: { label: 'Media', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>' },
  link: { label: 'Link', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>' },
  bundle: { label: 'Bundle', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3.3 8.3 12 13l8.7-4.7M12 22V13"/></svg>' },
  // v3.12.0 (Fase 7): Tipe dokumen multi-halaman (CamScanner-like, dibuat di PWA v1.4.0+).
  // Tampil di chip "Media" bersama screenshot (dimerge via visibleItems/chipCount).
  document: { label: 'Dokumen', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6"/><path d="M9 17h6"/></svg>' },
  file: { label: 'File', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>' }
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

// v3.17.0: Flash button feedback — utility reusable untuk semua tombol aksi.
// User feedback (Google Doc Sesi 1): "TIDAK ADA konfirmasi visual bahwa tombol
// tersebut telah berhasil diklik." Solusi: tombol berubah teks + warna sementara
// 1.8 detik, lalu restore ke state asli.
//
// Spec:
//   - ok=true  → background hijau (#10b981), text "✓ Tersalin!" (atau msg kustom)
//   - ok=false → background merah (#dc2626), text "✗ Gagal" (atau msg kustom)
//   - disabled=true selama flash (anti double-click)
//   - Setelah 1.8s, restore textContent + style + disabled ke state asli
//
// @param {HTMLButtonElement} btn - tombol yang di-flash
// @param {string} [message] - pesan kustom (default: ok?'✓ Tersalin!':'✗ Gagal')
// @param {boolean} [ok=true] - true=sukses (hijau), false=error (merah)
// @param {number} [duration=1800] - durasi flash dalam ms
function flashButtonFeedback(btn, message, ok = true, duration = 1800) {
  if (!btn) return;
  // Simpan state asli (hanya jika belum sedang di-flash)
  if (!btn.dataset.flashOriginal) {
    btn.dataset.flashOriginal = '1';
    btn.dataset.flashOrigText = btn.textContent || '';
    btn.dataset.flashOrigBg = btn.style.background || '';
    btn.dataset.flashOrigColor = btn.style.color || '';
    btn.dataset.flashOrigBorder = btn.style.borderColor || '';
    btn.dataset.flashOrigDisabled = btn.disabled ? '1' : '';
  } else {
    // Sudah di-flash — jangan overlap, tapi update message
  }
  // Apply flash state
  btn.textContent = message || (ok ? '✓ Tersalin!' : '✗ Gagal');
  btn.style.background = ok ? '#10b981' : '#dc2626';
  btn.style.color = '#ffffff';
  btn.style.borderColor = ok ? '#059669' : '#991b1b';
  btn.disabled = true;
  btn.classList.add(ok ? 'btn-flash-ok' : 'btn-flash-err');
  // Schedule restore
  clearTimeout(btn._flashTimer);
  btn._flashTimer = setTimeout(() => {
    btn.textContent = btn.dataset.flashOrigText;
    btn.style.background = btn.dataset.flashOrigBg;
    btn.style.color = btn.dataset.flashOrigColor;
    btn.style.borderColor = btn.dataset.flashOrigBorder;
    btn.disabled = btn.dataset.flashOrigDisabled === '1';
    btn.classList.remove('btn-flash-ok', 'btn-flash-err');
    delete btn.dataset.flashOriginal;
    delete btn.dataset.flashOrigText;
    delete btn.dataset.flashOrigBg;
    delete btn.dataset.flashOrigColor;
    delete btn.dataset.flashOrigBorder;
    delete btn.dataset.flashOrigDisabled;
  }, duration);
}

// v3.17.0: Toast khusus untuk modal viewer — tampil DI DALAM modal (z-index 250)
// supaya tidak tertutup overlay modal (z-index 200).
// User feedback: "TIDAK ADA konfirmasi visual" — root cause: toast global
// z-index 60 < modal z-index 200 → toast tersembunyi di belakang modal.
function showViewerToast(msg, ok = true, duration = 2200) {
  // Cari modal viewer yang aktif
  const overlay = document.getElementById('rfImageViewerOverlay');
  if (!overlay) {
    // Fallback ke global toast
    toast(msg, ok);
    return;
  }
  // Cari atau buat toast container di dalam modal
  let toastBox = overlay.querySelector('.rf-viewer-toasts');
  if (!toastBox) {
    toastBox = document.createElement('div');
    toastBox.className = 'rf-viewer-toasts';
    toastBox.style.cssText = 'position:absolute;left:0;right:0;bottom:14px;display:flex;flex-direction:column;align-items:center;gap:6px;z-index:250;pointer-events:none';
    overlay.appendChild(toastBox);
  }
  const t = document.createElement('div');
  t.className = 'toast' + (ok ? ' ok' : ' err');
  t.style.cssText = 'display:flex;align-items:center;gap:8px;background:#fafaf9;color:#1c1917;font-size:12px;font-weight:600;padding:9px 15px;border-radius:999px;box-shadow:0 4px 16px rgba(0,0,0,0.3);max-width:90%;animation:tin .22s cubic-bezier(.2,.8,.2,1)';
  t.innerHTML = '<span class="tk">' + (ok ? ICONS.check : ICONS.trash) + '</span>' + esc(msg);
  toastBox.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateY(8px)';
    t.style.transition = 'opacity .25s, transform .25s';
    setTimeout(() => t.remove(), 280);
  }, duration);
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
  // v3.11.36 (Sesi 2, Issue dari Google Doc): Set .page.top dinamis = bottom of strip,
  // supaya jadwal shalat (strip) tetap terlihat saat user di editor catatan / halaman alat.
  // User feedback: "saat edit atau tambah catatan... waktu shalat harus tetap keliatan ya.
  // karena saya sering seharian pake edit atau tambah catatan terbuka... buat nyatet waktu kerja."
  // Sebelumnya: .page top:0 (menutupi header+cmd+strip) → countdown shalat hilang.
  // Sekarang: .page top = posisi bottom strip relatif ke popup. Hitung via getBoundingClientRect
  // supaya adaptif terhadap tinggi header/cmd/strip yang bervariasi (cmd hanya di home view).
  try {
    const strip = document.querySelector('.strip');
    const popup = document.getElementById('popup');
    const page = document.getElementById('page');
    if (strip && popup && page) {
      const stripRect = strip.getBoundingClientRect();
      const popupRect = popup.getBoundingClientRect();
      const offset = Math.round(stripRect.bottom - popupRect.top);
      // Sanity check: offset harus masuk akal (50-200px). Kalau 0/negatif, fallback ke 95px.
      page.style.top = (offset > 0 && offset < 250) ? offset + 'px' : '95px';
    }
  } catch (e) {
    // Fallback: biarkan CSS default (95px)
    console.warn('[RecallFox] openPage: gagal hitung offset strip, pakai 95px', e.message);
  }
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
    // v3.16.3: Pakai isAIPageFromOrigin + getMatchedSite dari lib/ai-detect.js
    // (storage.aiSites sebagai single source of truth — bukan hardcoded AI_TOOLS).
    // Sebelumnya pakai matchCurrentTool(tab.url) dari lib/ai-tools.js yang masih
    // hardcoded list — akibatnya domain yang baru ditambahkan via "Kelola Situs AI"
    // tidak terdeteksi → tombol Snapshot quick action tidak jalan.
    const { isAIPageFromOrigin, getMatchedSite } = await import('../lib/ai-detect.js');
    const isAI = await isAIPageFromOrigin(tab.url);
    if (isAI) {
      const matched = await getMatchedSite(tab.url);
      // Preserve selectors dari matchCurrentTool kalau ada (untuk extraction DOM spesifik)
      // Fallback: pakai matched site dari aiSites (tanpa selectors, pakai generic fallback)
      const legacyMatched = matchCurrentTool(tab.url);
      currentAiDomain = legacyMatched || (matched ? {
        id: matched.id,
        name: matched.name,
        url: matched.origin,
        region: 'generic',
        color: '#6366f1',
        emoji: '🤖',
        alt: [],
        _fromAiSites: true
      } : null);
      $('#ctxBadge').innerHTML = '<span class="dot"></span>' + (currentAiDomain?.name || 'AI') + ' · siap sisip';
    } else {
      currentAiDomain = null;
      const count = currentVault?.items?.length || 0;
      $('#ctxBadge').innerHTML = '<span class="dot"></span>Vault · ' + count + ' item';
    }
  } catch (e) {
    console.warn('[RecallFox] detectAiContext error:', e.message);
    // Fallback ke matchCurrentTool kalau ai-detect.js gagal load
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (tab && tab.url) {
        const matched = matchCurrentTool(tab.url);
        if (matched) {
          currentAiDomain = matched;
          $('#ctxBadge').innerHTML = '<span class="dot"></span>' + matched.name + ' · siap sisip';
          return;
        }
      }
    } catch (e2) {}
    currentAiDomain = null;
  }
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

  // v3.11.5 (Issue 2): Render pintasan web ngaji & olahraga
  renderShortcuts('quranShortcutsRow', s.quranShortcuts, '📖');
  renderShortcuts('exerciseShortcutsRow', s.exerciseShortcuts, '🏃');
}

// v3.11.5 (Issue 2): Render pintasan web di strip-detail
// Container: #quranShortcutsRow or #exerciseShortcutsRow
// Shortcuts: array of { name, url, emoji } — maksimal 6
function renderShortcuts(containerId, shortcuts, defaultEmoji) {
  const container = $('#' + containerId);
  if (!container) return;
  if (!Array.isArray(shortcuts) || shortcuts.length === 0) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }
  container.style.display = '';
  const list = shortcuts.slice(0, 6);  // maksimal 6 pintasan
  container.innerHTML = list.map((sc, i) => {
    const emoji = sc.emoji || defaultEmoji;
    const name = esc(sc.name || 'Web');
    const url = esc(sc.url || '#');
    return '<button class="shortcut-btn" data-url="' + url + '" title="' + esc(sc.name || '') + ' — ' + url + '">'
      + '<span class="shortcut-ic">' + emoji + '</span>'
      + '<span class="shortcut-name">' + name + '</span>'
      + '</button>';
  }).join('');
  container.querySelectorAll('.shortcut-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const url = btn.dataset.url;
      if (!url || url === '#') return;
      try {
        await browser.tabs.create({ url });
        toast('🌐 Membuka ' + (btn.querySelector('.shortcut-name')?.textContent || 'web'));
      } catch (err) {
        toast('Gagal buka: ' + err.message, false);
      }
    });
  });
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
  // v3.20.39: Dedup by ID — defense-in-depth supaya list view tidak tampilkan
  //   duplikat meskipun storage layer masih punya (e.g. data lama sebelum fix).
  //   Kalau ada ID sama, keep yang pertama (sudah di-sort by recency di caller).
  const seen = new Set();
  const merged = [...items, ...bundles];
  const deduped = merged.filter(it => {
    if (!it.id || seen.has(it.id)) {
      console.warn('[RecallFox/popup] getVaultItems: skipped duplicate ID:', it.id, it.title);
      return false;
    }
    seen.add(it.id);
    return true;
  });
  return deduped;
}

// v3.7.2 (Issue 1): tambah chip "Arsip" untuk lihat item yang diarsipkan.
const CHIPS = [['all', 'Semua'], ['recent', '🕑 Terbaru'], ['prompt', 'Prompt'], ['context', 'Konteks'], ['snapshot', 'Snapshot'], ['screenshot', 'Media'], ['file', '📄 File'], ['link', 'Link'], ['bundle', 'Bundle'], ['archive', 'Arsip']];
function chipCount(c) {
  const items = getVaultItems();
  if (c === 'all') {
    return items.filter(i => !i.archived && !(i._bundle && i._bundle.archived)).length;
  }
  if (c === 'recent') {
    // v3.19.0: Chip "Terbaru" — tampilkan angka 15 (max recent items)
    return Math.min(15, items.filter(i => !i.archived && !isGroupItem(i)).length);
  }
  if (c === 'archive') {
    return items.filter(i => i.archived || (i._bundle && i._bundle.archived)).length;
  }
  if (c === 'screenshot') {
    return items.filter(i => (i.type === 'screenshot' || i.type === 'document') && !i.archived).length;
  }
  return items.filter(i => i.type === c && !i.archived).length;
}
function renderChips() {
  const items = getVaultItems();
  // v3.9.0 (Issue 6): tambah data-cat untuk styling ribbon warna per kategori
  $('#chips').innerHTML = CHIPS.map(function (c) {
    const n = chipCount(c[0]);
    if (c[0] !== 'all' && c[0] !== 'archive' && n === 0) return '';
    return '<button class="chip' + (currentChip === c[0] ? ' on' : '') + '" data-chip="' + c[0] + '" data-cat="' + c[0] + '">' + c[1] + '<span class="n">' + n + '</span></button>';
  }).join('');
  $$('#chips .chip').forEach(ch => ch.addEventListener('click', () => { currentChip = ch.dataset.chip; updateBatchModeBtnVisibility(); renderVault(); }));
  const visibleItemsForMeta = items.filter(i => !i.archived && !(i._bundle && i._bundle.archived));
  const favs = visibleItemsForMeta.filter(i => i.favorite).length;
  const uses = visibleItemsForMeta.reduce((a, b) => a + (b.useCount || b.uses || 0), 0);
  $('#vaultMeta').textContent = visibleItemsForMeta.length + ' item · ★ ' + favs + ' · ↑ ' + uses;
  if (!currentAiDomain) $('#ctxBadge').innerHTML = '<span class="dot"></span>Vault · ' + visibleItemsForMeta.length + ' item';
}

// v3.7.2 (Issue 4): Searchable text untuk satu item — gabungan field yang relevan.
// Termasuk screenshot source.url, source.title, linkUrl, dan bundle item titles.
// v3.10.2 (Issue 4 fix): Lebih komprehensif — tambah screenshotMode, fileName,
//   gdriveFileUrl, bundle note titles/bodies (noteIds), inlinePrompt, nama bundle,
//   dll. Memastikan user bisa cari "github" di link apapun, cari teks di catatan
//   bundle, cari nama bundle, dst. Sesuai catatan Issue #4: harus bisa cari teks
//   di Prompt, Konteks, Link, Bundle, Snapshot, Shot, sampai arsip.
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
    if (it.source.domain) parts.push(it.source.domain);
    // v3.19.6: Folder/group metadata — supaya search bisa temukan folder by name
    if (it.source.isGroup) parts.push('folder grup group');
    if (it.source.folderColor) parts.push(it.source.folderColor);
    // v3.19.6: GPS location — supaya search bisa temukan item by lokasi
    if (it.source.location) {
      if (it.source.location.address) parts.push(it.source.location.address);
      if (it.source.location.lat) parts.push(String(it.source.location.lat));
      if (it.source.location.lng) parts.push(String(it.source.location.lng));
    }
  }
  // v3.19.6: Cari nama folder induk (parent) — supaya search "youtube favorit" bisa
  // temukan item yang ada di dalam folder bernama "youtube favorit"
  if (it.source?.parentId && currentVault?.items) {
    const parent = currentVault.items.find(i => i.id === it.source.parentId);
    if (parent) parts.push(parent.title || '');
  }
  // v3.10.2 (Issue 4 fix): Field tambahan untuk screenshot — mode, gdrive link
  if (it.screenshotMode) parts.push(it.screenshotMode);
  if (it.gdriveFileUrl) parts.push(it.gdriveFileUrl);
  if (it.gdriveFileId) parts.push(it.gdriveFileId);
  // v3.12.0 (Fase 7): Dokumen multi-halaman — info jumlah halaman + note di source
  if (Array.isArray(it.source?.pages)) parts.push(it.source.pages.length + ' halaman');
  if (it.type === 'document' && (it.annotationNote || it.source?.annotationNote)) {
    parts.push(it.annotationNote || it.source.annotationNote);
  }
  // v3.10.2 (Issue 4 fix): Snapshot metadata
  if (it.snapshotDomain) parts.push(it.snapshotDomain);
  if (it.snapshotMessageCount) parts.push(String(it.snapshotMessageCount));
  // v3.7.2 (Issue 4): bundle — sertakan judul semua item anggota
  if (it._bundle) {
    const bd = it._bundle;
    if (bd.name) parts.push(bd.name);
    if (bd.note) parts.push(bd.note);
    if (bd.inlinePrompt) parts.push(bd.inlinePrompt);
    const memberTitles = (bd.injectOrder || bd.itemIds || [])
      .map(iid => currentVault.items.find(i => i.id === iid))
      .filter(Boolean)
      .map(i => i.title || '');
    parts.push(memberTitles.join(' '));
    // v3.10.2 (Issue 4 fix): Sertakan juga body item anggota (bukan cuma title)
    // sehingga user bisa cari teks di dalam item bundle.
    const memberBodies = (bd.injectOrder || bd.itemIds || [])
      .map(iid => currentVault.items.find(i => i.id === iid))
      .filter(Boolean)
      .map(i => (i.body || '') + ' ' + (i.linkUrl || '') + ' ' + (i.linkTitle || ''));
    parts.push(memberBodies.join(' '));
    // v3.10.2 (Issue 4 fix): Sertakan juga title + body catatan bundle (noteIds)
    const noteIds = Array.isArray(bd.noteIds) ? bd.noteIds : [];
    const noteTexts = noteIds
      .map(nid => currentNotes.find(n => n.id === nid))
      .filter(Boolean)
      // v3.13.0 (Issue #4): Strip HTML dari note body supaya search index pakai plain text.
      .map(n => (n.title || '') + ' ' + stripHtmlForPreview(n.body || ''));
    parts.push(noteTexts.join(' '));
  }
  return parts.join(' ').toLowerCase();
}

// ============================================================================
// v3.11.11 (Issue #1): Batch mode untuk screenshot — select multiple + copy sekaligus
// User feedback: "saya kan sedang sering melakukan beberapa kali screnshot dan paste
// dalam keseharian bekerja. apakah bisa dipilih beberapa di menu ini dan kopinya sekalian
// baik gambar maupun keterangannya sekaligus? tapi kamu pikirkan formatnya yang sangat
// rapih sehingga ketika dipaste tu orang atau ai bacanya ngerti."
// ============================================================================
// v3.11.14 (Sesi terakhir): Generalisasi batch mode — support SEMUA tipe item
// (prompt, context, link, bundle, snapshot, screenshot, archive).
// User feedback: "toggle batch itu sudah ada di batch select media. tinggal tiru aja.
// selarasin di menu lainnya juga misal prompt, link, bundle dan arsip"
// ============================================================================
let vaultBatchMode = false;
const vaultBatchSelected = new Set();

// v3.11.14: Chip yang support batch mode (semua chip kecuali 'all')
// v3.11.15: Sekarang chip 'all' JUGA support batch — user bisa pilih multiple item
// dari berbagai tipe sekaligus. Tombol yang tampil disesuaikan dengan tipe item terpilih.
const BATCH_SUPPORTED_CHIPS = new Set(['all', 'prompt', 'context', 'link', 'bundle', 'snapshot', 'screenshot', 'file', 'archive']);

function updateBatchModeBtnVisibility() {
  // v3.11.14: Tombol batch tampil untuk SEMUA chip yang support batch (bukan hanya screenshot)
  // v3.11.15: Sekarang juga tampil di chip 'all'
  const btn = $('#batchModeBtn');
  if (!btn) return;
  const supported = BATCH_SUPPORTED_CHIPS.has(currentChip);
  btn.style.display = supported ? '' : 'none';
  // Update title sesuai chip aktif
  const chipLabel = CHIPS.find(c => c[0] === currentChip)?.[1] || 'item';
  btn.title = 'Mode batch: pilih multiple ' + chipLabel.toLowerCase() + ' untuk aksi sekaligus';
  // Kalau keluar dari chip yang support batch saat batch mode aktif, exit otomatis
  if (!supported && vaultBatchMode) {
    exitVaultBatchMode();
  }
  // v3.11.14: Update tombol-tombol di batch bar sesuai chip aktif
  updateVaultBatchBarButtons();
}

// v3.11.14: Tampilkan/sembunyikan tombol di vaultBatchBar sesuai chip aktif.
// - Screenshot: Copy + Keterangan, Copy Gambar Saja, Hapus
// - Prompt/Context/Link/Snapshot: Copy Teks, Hapus
// - Bundle: Copy Bundle, Hapus
// - Archive: Unarsip, Hapus permanen
// v3.11.15: Di chip 'all', tampilkan tombol berdasarkan TIPE ITEM yang terpilih.
// Jika multiple tipe terpilih, tampilkan semua tombol yang relevant.
function updateVaultBatchBarButtons() {
  const bar = $('#vaultBatchBar');
  if (!bar) return;
  const copyCaptionBtn = $('#vaultBatchCopy');        // Copy + Keterangan (screenshot only)
  const copyImgBtn = $('#vaultBatchCopyImg');         // Copy Gambar Saja (screenshot only)
  const downloadBtn = $('#vaultBatchDownload');       // v3.14.9: Download Semua (screenshot/doc only)
  const copyUrlsBtn = $('#vaultBatchCopyUrls');       // v3.14.9: Copy URL gambar (screenshot/doc only)
  const copyMetaBtn = $('#vaultBatchCopyMeta');       // Copy Teks Saja (screenshot only, text-only)
  const copyTextBtn = $('#vaultBatchCopyText');       // Copy Teks (prompt/context/link/snapshot)
  const copyBundleBtn = $('#vaultBatchCopyBundle');   // Copy Bundle (bundle only)
  const unarchiveBtn = $('#vaultBatchUnarchive');     // Unarsip (archive only)
  const deleteBtn = $('#vaultBatchDelete');           // Hapus (semua)
  // v3.20.43: Batch mass actions — Move to Folder, Archive, Add to Bundle
  const moveFolderBtn = $('#vaultBatchMoveFolder');   // Pindah ke Folder (semua item, bukan bundle)
  const archiveBtn = $('#vaultBatchArchive');         // Arsipkan (semua, kecuali sudah archived)
  const bundleBtn = $('#vaultBatchBundle');           // Tambah ke Bundle (item only, bukan bundle)

  // Reset semua
  [copyCaptionBtn, copyImgBtn, downloadBtn, copyUrlsBtn, copyMetaBtn, copyTextBtn, copyBundleBtn, unarchiveBtn, deleteBtn, moveFolderBtn, archiveBtn, bundleBtn].forEach(b => {
    if (b) b.style.display = 'none';
  });

  // v3.11.15: Di chip 'all', tentukan tipe item yang terpilih
  let selectedTypes = new Set();
  let hasActualItems = false;  // v3.20.43: track apakah ada item (bukan bundle) di selection
  if (currentChip === 'all' && vaultBatchSelected.size > 0) {
    for (const id of vaultBatchSelected) {
      const item = currentVault?.items?.find(i => i.id === id);
      if (item) {
        selectedTypes.add(item.type);
        hasActualItems = true;
      }
      // Cek juga bundle
      const bundle = currentVault?.bundles?.find(b => b.id === id);
      if (bundle) selectedTypes.add('bundle');
    }
  } else {
    selectedTypes.add(currentChip === 'archive' ? 'archive' : currentChip);
    // v3.20.43: Untuk chip selain 'archive', cek apakah ada item (bukan bundle) terpilih
    if (currentChip !== 'archive') hasActualItems = true;
  }

  // Tentukan tombol yang tampil berdasarkan tipe terpilih
  const hasScreenshot = selectedTypes.has('screenshot');
  const hasDocument = selectedTypes.has('document'); // v3.12.0 (Fase 7)
  const hasBundle = selectedTypes.has('bundle');
  const hasArchive = selectedTypes.has('archive');
  const hasText = ['prompt', 'context', 'link', 'snapshot', 'file'].some(t => selectedTypes.has(t));

  if (currentChip === 'archive' || hasArchive) {
    if (unarchiveBtn) unarchiveBtn.style.display = '';
  }
  // v3.12.0: Tombol screenshot juga tampil untuk dokumen (copy halaman pertama + caption).
  // v3.14.9: Tambah Download Semua + Copy URL untuk AI sites.
  if (hasScreenshot || hasDocument) {
    if (copyCaptionBtn) copyCaptionBtn.style.display = '';
    if (copyImgBtn) copyImgBtn.style.display = '';
    if (downloadBtn) downloadBtn.style.display = '';
    if (copyUrlsBtn) copyUrlsBtn.style.display = '';
    if (copyMetaBtn) copyMetaBtn.style.display = '';
  }
  if (hasBundle) {
    if (copyBundleBtn) copyBundleBtn.style.display = '';
  }
  if (hasText) {
    if (copyTextBtn) copyTextBtn.style.display = '';
  }
  // v3.20.43: Mass actions — tampil kalau ada item (bukan bundle) terpilih
  // Move to Folder: item only (bukan bundle), tidak di chip 'archive'
  if (hasActualItems && currentChip !== 'archive') {
    if (moveFolderBtn) moveFolderBtn.style.display = '';
    if (bundleBtn) bundleBtn.style.display = '';
  }
  // Arsipkan: tampil kalau BUKAN di chip 'archive' (di archive, pakai Unarsip)
  if (currentChip !== 'archive') {
    if (archiveBtn) archiveBtn.style.display = '';
  }
  // Hapus selalu tampil (untuk semua tipe)
  if (deleteBtn) deleteBtn.style.display = '';

  // Update tombol delete label untuk archive
  if (deleteBtn) {
    if (currentChip === 'archive') {
      deleteBtn.textContent = '🗑️ Hapus Permanen';
      deleteBtn.title = 'Hapus permanen item terpilih dari vault';
    } else {
      deleteBtn.textContent = '🗑️ Hapus';
      deleteBtn.title = 'Hapus item terpilih dari vault';
    }
  }
}

function toggleVaultBatchMode() {
  vaultBatchMode = !vaultBatchMode;
  vaultBatchSelected.clear();
  const bar = $('#vaultBatchBar');
  if (bar) bar.style.display = vaultBatchMode ? 'flex' : 'none';
  if (!vaultBatchMode) {
    document.querySelectorAll('.vault-batch-check').forEach(c => c.checked = false);
  }
  renderList();
  updateVaultBatchCount();
  const chipLabel = CHIPS.find(c => c[0] === currentChip)?.[1] || 'item';
  toast(vaultBatchMode ? '☑️ Mode batch aktif — klik ' + chipLabel.toLowerCase() + ' untuk pilih' : 'Mode batch dimatikan');
}

function exitVaultBatchMode() {
  if (!vaultBatchMode) return;
  toggleVaultBatchMode();
}

function updateVaultBatchCount() {
  const countEl = $('#vaultBatchCount');
  if (countEl) countEl.textContent = vaultBatchSelected.size + ' dipilih';
  // v3.11.15: Update tombol batch bar setelah count berubah — penting untuk chip 'all'
  // dimana tombol yang tampil tergantung tipe item terpilih.
  try { updateVaultBatchBarButtons(); } catch (e) {}
}

// v3.11.14: Helper — dapatkan label tipe untuk pesan toast/dialog
function _batchItemTypeLabel() {
  const chipLabel = CHIPS.find(c => c[0] === currentChip)?.[1] || 'item';
  return chipLabel.toLowerCase();
}

// v3.11.14: Copy text untuk prompt/context/link/snapshot — format rapi
// Sama seperti injectBundle tapi untuk multiple item, dipisah ---
async function vaultBatchCopyTextAction() {
  if (vaultBatchSelected.size === 0) {
    toast('Pilih minimal 1 item dulu');
    return;
  }
  const ids = Array.from(vaultBatchSelected);
  const items = ids.map(id => currentVault.items.find(i => i.id === id)).filter(Boolean);
  if (items.length === 0) {
    toast('Tidak ada item valid terpilih', false);
    return;
  }
  toast('📋 Menyalin ' + items.length + ' item...');
  const parts = items.map(it => {
    const T = TYPE[it.type] || { label: it.type };
    const header = '## ' + (it.title || it.type) + ' [' + T.label + ']';
    if (it.type === 'link') return header + '\n' + (it.linkUrl || it.body || '');
    return header + '\n' + (it.body || '');
  });
  const fullText = parts.join('\n\n---\n\n');
  try {
    await navigator.clipboard.writeText(fullText);
    toast('✓ ' + items.length + ' item tersalin ke clipboard');
  } catch (e) {
    try {
      await browser.runtime.sendMessage({ type: 'COPY_TO_CLIPBOARD', text: fullText });
      toast('✓ ' + items.length + ' item tersalin ke clipboard');
    } catch (e2) {
      toast('⚠ Gagal menyalin: ' + e2.message, false);
    }
  }
}

// v3.14.9: Batch download semua gambar terpilih sebagai file terpisah.
// User request: "buatkan yang mudah dikopi terus bisa batch download hanya gambar".
// Loop sequential (bukan Promise.all) supaya Firefox download manager tidak
// batch jadi 1 prompt. Progress toast per item. No 9-item cap (beda dari copy
// yang composite — di sini tiap file independent).
async function vaultBatchDownloadAction() {
  if (vaultBatchSelected.size === 0) {
    toast('Pilih minimal 1 gambar dulu');
    return;
  }
  const ids = Array.from(vaultBatchSelected);
  // Filter hanya screenshot/document
  const imageItems = ids.map(id => currentVault.items.find(i => i.id === id))
    .filter(i => i && (i.type === 'screenshot' || i.type === 'document'));
  if (imageItems.length === 0) {
    toast('Tidak ada gambar valid terpilih', false);
    return;
  }
  const skipped = ids.length - imageItems.length;
  toast('⬇️ Mengunduh ' + imageItems.length + ' file' + (skipped > 0 ? ' (' + skipped + ' non-gambar diabaikan)' : '') + '...');
  let ok = 0, fail = 0;
  for (let i = 0; i < imageItems.length; i++) {
    const item = imageItems[i];
    try {
      const fmt = item.type === 'document' ? 'jpeg' : (item.screenshotFormat || 'png');
      const res = await browser.runtime.sendMessage({
        type: 'DOWNLOAD_SCREENSHOT', id: item.id, title: item.title, format: fmt
      });
      if (res?.ok) ok++; else fail++;
    } catch (e) {
      fail++;
    }
    // Update progress setiap 3 item atau item terakhir
    if ((i + 1) % 3 === 0 || i === imageItems.length - 1) {
      toast('⬇️ ' + (ok + fail) + '/' + imageItems.length + ' diproses...');
    }
    // Small delay antar download supaya Firefox tidak batch
    if (i < imageItems.length - 1) {
      await new Promise(r => setTimeout(r, 300));
    }
  }
  if (fail === 0) {
    toast('✓ ' + ok + ' file terunduh ke folder RecallFox/');
  } else {
    toast('✓ ' + ok + ' file terunduh, ' + fail + ' gagal', false);
  }
}

// v3.14.9: Batch copy URL gambar (public Supabase Storage URL) — untuk AI sites
// yang tidak support paste gambar langsung. User paste URL ke AI chat, AI fetch
// gambar dari URL. Salin 1 URL per baris.
async function vaultBatchCopyUrlsAction() {
  if (vaultBatchSelected.size === 0) {
    toast('Pilih minimal 1 gambar dulu');
    return;
  }
  const ids = Array.from(vaultBatchSelected);
  const imageItems = ids.map(id => currentVault.items.find(i => i.id === id))
    .filter(i => i && (i.type === 'screenshot' || i.type === 'document'));
  if (imageItems.length === 0) {
    toast('Tidak ada gambar valid terpilih', false);
    return;
  }
  toast('🔗 Mengumpulkan URL gambar...');
  const urls = [];
  let skipped = 0;
  for (const item of imageItems) {
    const url = resolveImageUrl(item);
    if (url) {
      urls.push(url);
    } else {
      skipped++;
    }
  }
  if (urls.length === 0) {
    toast('Tidak ada URL gambar valid (gambar lokal-only)', false);
    return;
  }
  const text = urls.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast('✓ ' + urls.length + ' URL gambar tersalin' + (skipped > 0 ? ' (' + skipped + ' lokal-only diabaikan)' : '') + ' — paste ke AI chat');
  } catch (e) {
    try {
      await browser.runtime.sendMessage({ type: 'COPY_TO_CLIPBOARD', text });
      toast('✓ ' + urls.length + ' URL gambar tersalin');
    } catch (e2) {
      toast('Gagal salin URL: ' + e2.message, false);
    }
  }
}

// v3.14.9: Resolve image cloud URL dari item. Prioritas:
// 1. item.gdriveFileUrl / item.gdrive_file_url (langsung dari row)
// 2. item.source.pages[0].url (document multi-page)
// 3. item.source.url (legacy screenshot)
// Return null kalau tidak ada URL (gambar lokal-only).
function resolveImageUrl(item) {
  if (!item) return null;
  if (item.gdriveFileUrl) return item.gdriveFileUrl;
  if (item.gdrive_file_url) return item.gdrive_file_url;
  const src = item.source || {};
  if (Array.isArray(src.pages) && src.pages[0]?.url) return src.pages[0].url;
  if (src.url) return src.url;
  return null;
}

// v3.14.9: Copy URL gambar single item (untuk item sheet "🔗 Salin URL Gambar").
async function copyImageUrlToClipboard(id) {
  const item = currentVault.items.find(i => i.id === id);
  if (!item) { toast('Item tidak ditemukan', false); return; }
  const url = resolveImageUrl(item);
  if (!url) {
    toast('Gambar ini tidak punya URL cloud (lokal-only). Gunakan Download atau Salin Gambar.', false);
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('✓ URL gambar tersalin — paste ke AI chat');
  } catch (e) {
    try {
      await browser.runtime.sendMessage({ type: 'COPY_TO_CLIPBOARD', text: url });
      toast('✓ URL gambar tersalin');
    } catch (e2) {
      toast('Gagal salin URL: ' + e2.message, false);
    }
  }
}

// v3.20.35-dev: File upload handlers — pakai addItem yang sudah di-import di top-level
// (TIDAK pakai dynamic import supaya tidak ada masalah circular dependency)
const FILE_UPLOAD_WHITELIST = {
  '.md':       { kind: 'md',   mime: 'text/markdown' },
  '.markdown': { kind: 'md',   mime: 'text/markdown' },
  '.txt':      { kind: 'txt',  mime: 'text/plain' },
  '.json':     { kind: 'json', mime: 'application/json' },
  '.html':     { kind: 'html', mime: 'text/html' },
  '.htm':      { kind: 'html', mime: 'text/html' },
  '.csv':      { kind: 'csv',  mime: 'text/csv' },
  '.yaml':     { kind: 'yaml', mime: 'text/yaml' },
  '.yml':      { kind: 'yaml', mime: 'text/yaml' }
};
const MAX_FILE_UPLOAD_BYTES = 2 * 1024 * 1024;

function detectFileKind(file) {
  if (!file || !file.name) return null;
  const dotIdx = file.name.lastIndexOf('.');
  if (dotIdx < 0) return null;
  const ext = file.name.slice(dotIdx).toLowerCase();
  return FILE_UPLOAD_WHITELIST[ext] || null;
}

async function handleDocFileUpload(fileList) {
  if (!fileList || fileList.length === 0) return;
  const files = Array.from(fileList);
  let ok = 0, fail = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const progress = files.length > 1 ? ' (' + (i + 1) + '/' + files.length + ')' : '';
    try {
      const info = detectFileKind(file);
      if (!info) {
        toast('⚠ ' + file.name + ': format tidak didukung' + progress, false);
        fail++;
        continue;
      }
      if (file.size > MAX_FILE_UPLOAD_BYTES) {
        toast('⚠ ' + file.name + ': terlalu besar (maks 2MB)' + progress, false);
        fail++;
        continue;
      }
      const text = await file.text();
      if (!text || text.length === 0) {
        toast('⚠ ' + file.name + ': file kosong' + progress, false);
        fail++;
        continue;
      }
      // addItem sudah di-import di top-level popup.js
      // v3.20.36-dev: addItem() otomatis trigger directUpsertVaultItem ke Supabase.
      // Kalau Supabase error (auth/RLS/network), error di-catch di sini + toast jelas.
      try {
        await addItem({
          type: 'file',
          title: file.name,
          body: text,
          tags: ['file', info.kind],
          source: {
            kind: info.kind,
            mime: info.mime,
            fileName: file.name,
            size: file.size,
            uploadedFrom: 'addon-upload',
            capturedAt: new Date().toISOString()
          }
        });
      } catch (addItemErr) {
        // addItem gagal — kemungkinan storage.local penuh atau sync error
        console.error('[RecallFox] File upload: addItem gagal:', file.name, addItemErr);
        toast('⚠ ' + file.name + ': gagal simpan — ' + (addItemErr.message || 'unknown error'), false);
        fail++;
        continue;
      }
      // v3.20.38-dev: Cek apakah cloud upload error tercatat di storage.local.
      // Kalau ada error, tampilkan toast yang JELAS ke user dengan hint.
      let cloudOk = true;
      try {
        const errData = await browser.storage.local.get('recallfox_last_sync_error');
        if (errData['recallfox_last_sync_error']) {
          const syncErr = JSON.parse(errData['recallfox_last_sync_error']);
          // Cek apakah error ini untuk upload file yang baru saja (dalam 5 detik)
          if (syncErr.source === '_uploadFileDocument' && Date.now() - new Date(syncErr.ts).getTime() < 5000) {
            cloudOk = false;
            const hint = syncErr.hint || syncErr.error || 'unknown error';
            console.warn('[RecallFox] File upload: cloud GAGAL untuk', file.name, ':', syncErr.error);
            toast('📤 ' + file.name + ' tersimpan lokal — URL cloud gagal: ' + hint, false);
          }
        }
      } catch (_) {}
      if (cloudOk) {
        toast('📤 ' + file.name + ' terupload — URL cloud siap' + progress);
      }
      ok++;
      if (i < files.length - 1) await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.error('[RecallFox] File upload error:', file.name, e);
      toast('⚠ ' + file.name + ': gagal upload — ' + (e.message || 'unknown error'), false);
      fail++;
    }
  }
  await refreshVault();
  if (files.length > 1) {
    toast('📤 Upload selesai: ' + ok + ' sukses' + (fail > 0 ? ', ' + fail + ' gagal' : ''));
  }
}

async function copyFileContentToClipboard(id) {
  const item = currentVault.items.find(i => i.id === id);
  if (!item || item.type !== 'file') { toast('Item file tidak ditemukan', false); return; }
  if (!item.body) { toast('File kosong', false); return; }
  // _copyTextWithFallback di-defined di bawah (hoisted), aman dipanggil di sini
  const ok = await _copyTextWithFallback(item.body);
  if (ok) {
    toast('📋 Isi file "' + item.title + '" tersalin (' + item.body.length + ' karakter)');
  } else {
    toast('Gagal salin isi file (clipboard diblokir)', false);
  }
}

// v3.20.37-dev: Copy URL dengan retry mechanism.
// Root cause "belum punya URL cloud": upload Storage adalah async — butuh beberapa detik
// setelah addItem() sampai _uploadFileDocument selesai + update gdriveFileUrl di vault.
// Fix: refresh vault dari storage.local + retry 2x dengan jeda 1.5 detik.
// getVault sudah di-import di top-level popup.js (bukan dynamic import).
async function copyFileUrlToClipboard(id) {
  const item = currentVault.items.find(i => i.id === id);
  if (!item || item.type !== 'file') { toast('Item file tidak ditemukan', false); return; }

  // Cek URL dari currentVault (fast path)
  let url = resolveImageUrl(item);

  // Kalau belum ada, refresh vault dari storage.local (mungkin _uploadFileDocument sudah update)
  if (!url) {
    try {
      const freshVault = await getVault();
      const freshItem = freshVault.items.find(i => i.id === id);
      if (freshItem) url = resolveImageUrl(freshItem);
    } catch (_) {}
  }

  // Kalau masih belum ada, retry dengan delay (upload mungkin masih berjalan)
  if (!url) {
    toast('⏳ URL cloud belum siap — menunggu upload selesai...');
    for (let attempt = 0; attempt < 2; attempt++) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        const freshVault = await getVault();
        const freshItem = freshVault.items.find(i => i.id === id);
        if (freshItem) {
          url = resolveImageUrl(freshItem);
          if (url) break;
        }
      } catch (_) {}
    }
  }

  // v3.20.39: Kalau masih belum ada URL, trigger push sync ke background.
  //   Sebelumnya: kalau upload belum jalan (e.g. pushToSupabase belum ke-trigger
  //   untuk file type), URL tidak akan pernah ada. Sekarang: kirim SUPABASE_PUSH
  //   supaya background jalankan pushToSupabase (yang sekarang upload file ke
  //   Storage + PATCH gdrive_file_url). Setelah push, retry baca URL.
  if (!url) {
    try {
      console.log('[RecallFox] copyFileUrl: URL not found, triggering SUPABASE_PUSH...');
      await browser.runtime.sendMessage({ type: 'SUPABASE_PUSH' });
      // Tunggu push selesai (max 5 detik), lalu retry baca URL
      for (let attempt = 0; attempt < 3; attempt++) {
        await new Promise(r => setTimeout(r, 1500));
        try {
          const freshVault = await getVault();
          const freshItem = freshVault.items.find(i => i.id === id);
          if (freshItem) {
            url = resolveImageUrl(freshItem);
            if (url) {
              console.log('[RecallFox] copyFileUrl: URL found after push, attempt', attempt + 1);
              break;
            }
          }
        } catch (_) {}
      }
    } catch (pushErr) {
      console.warn('[RecallFox] copyFileUrl: SUPABASE_PUSH failed:', pushErr.message);
    }
  }

  if (!url) {
    toast('⚠ URL cloud belum tersedia. Gunakan "Kopi File" untuk salin isi teks, atau "Download" untuk unduh file.', false);
    return;
  }

  const ok = await _copyTextWithFallback(url);
  if (ok) toast('✓ URL file tersalin — paste ke AI chat');
  else toast('Gagal salin URL file (clipboard diblokir)', false);
}

async function downloadFileItem(id) {
  const item = currentVault.items.find(i => i.id === id);
  if (!item || item.type !== 'file') { toast('Item file tidak ditemukan', false); return; }
  if (!item.body) { toast('File kosong', false); return; }
  try {
    const mime = (item.source && item.source.mime) || 'text/plain';
    const blob = new Blob([item.body], { type: mime });
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = (item.source && item.source.fileName) || item.title || 'file.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
    toast('⬇️ ' + a.download + ' di-download');
  } catch (e) {
    toast('Gagal download: ' + e.message, false);
  }
}

// v3.11.36 (Sesi 2, Issue dari Google Doc): Batch copy TEKS METADATA saja (tanpa gambar)
// untuk multiple screenshot. Format = buildBatchCaption.textPlain (sudah ada di copy-format.js).
// User feedback: paste gambar+teks bersamaan tidak reliable → text-only lebih universal.
// Tidak fetch blob gambar → cepat, bisa untuk ratusan screenshot.
async function vaultBatchCopyMetaAction() {
  if (vaultBatchSelected.size === 0) {
    toast('Pilih minimal 1 item dulu');
    return;
  }
  const ids = Array.from(vaultBatchSelected);
  // v3.12.0 (Fase 7): Termasuk dokumen — text metadata untuk dokumen pakai buildDocumentCaption.
  const items = ids.map(id => currentVault.items.find(i => i.id === id))
    .filter(i => i && (i.type === 'screenshot' || i.type === 'document'));
  if (items.length === 0) {
    toast('Tidak ada screenshot/dokumen valid terpilih', false);
    return;
  }
  toast('📝 Menyalin teks metadata ' + items.length + ' item...');
  // v3.12.0: Mix screenshot + dokumen — build text per-tipe, gabungkan dengan separator.
  const parts = [];
  for (const item of items) {
    const cap = item.type === 'document'
      ? buildDocumentCaption(item, null, { index: items.indexOf(item) + 1 })
      : buildScreenshotCaption(item, null, { index: items.indexOf(item) + 1 });
    if (cap.textPlain) parts.push(cap.textPlain);
  }
  const textPlain = parts.join('\n\n---\n\n') + (parts.length > 0 ? '\n\n— Ditangkap oleh RecallFox —' : '');
  // Fallback kalau buildBatchCaption lebih sesuai (screenshot-only case)
  let finalText = textPlain;
  if (items.every(i => i.type === 'screenshot')) {
    const screenshots = items.map(item => ({ item, dataUrl: null }));
    const cap = buildBatchCaption(screenshots);
    if (cap.textPlain) finalText = cap.textPlain;
  }
  if (!finalText) { toast('Tidak ada metadata untuk disalin', false); return; }
  try {
    await navigator.clipboard.writeText(finalText);
    toast('✓ Teks metadata ' + items.length + ' item tersalin (paste ke WA/Gemini/AI chat)');
  } catch (e) {
    console.warn('[RecallFox] vaultBatchCopyMetaAction failed:', e.message);
    try {
      // Fallback: delegate ke background (utk konteks tanpa clipboard permission)
      await browser.runtime.sendMessage({ type: 'COPY_TO_CLIPBOARD', text: finalText });
      toast('✓ Teks metadata ' + items.length + ' item tersalin');
    } catch (e2) {
      toast('⚠ Gagal menyalin: ' + e2.message, false);
    }
  }
}

// v3.11.14: Copy bundle — gabungkan semua bundle terpilih jadi 1 teks
async function vaultBatchCopyBundleAction() {
  if (vaultBatchSelected.size === 0) {
    toast('Pilih minimal 1 bundle dulu');
    return;
  }
  const ids = Array.from(vaultBatchSelected);
  const bundles = ids.map(id => currentVault.bundles.find(b => b.id === id)).filter(Boolean);
  if (bundles.length === 0) {
    toast('Tidak ada bundle valid terpilih', false);
    return;
  }
  toast('📋 Menyalin ' + bundles.length + ' bundle...');
  const parts = bundles.map(bundle => {
    const items = (bundle.injectOrder || bundle.itemIds || [])
      .map(iid => currentVault.items.find(i => i.id === iid))
      .filter(Boolean);
    const noteIds = Array.isArray(bundle.noteIds) ? bundle.noteIds : [];
    const notes = noteIds.map(nid => currentNotes.find(n => n.id === nid)).filter(Boolean);
    const sections = [];
    sections.push('# 📦 Bundle: ' + (bundle.name || 'Bundle tanpa nama'));
    if (bundle.inlinePrompt && bundle.inlinePrompt.trim()) {
      sections.push('## Prompt Cepat [Prompt]\n' + bundle.inlinePrompt.trim());
    }
    for (const i of items) {
      const T = TYPE[i.type] || { label: i.type };
      const header = '## ' + (i.title || i.type) + ' [' + T.label + ']';
      // v3.20.45: Pakai getBundleContent(i, 'copy') — standarisasi logic.
      //   Sebelumnya: inline logic yang tidak handle file/media dengan benar.
      //   Sekarang: prompt/file→teks, link/media→URL.
      const content = getBundleContent(i, 'copy');
      sections.push(header + '\n' + content);
    }
    for (const n of notes) {
      // v3.13.0 (Issue #4): Strip HTML untuk Markdown output supaya AI tidak bingung.
      sections.push('## ' + (n.title || 'Catatan') + ' [Catatan]\n' + stripHtmlForPreview(n.body || ''));
    }
    return sections.join('\n\n');
  });
  const fullText = parts.join('\n\n---\n\n');
  try {
    await navigator.clipboard.writeText(fullText);
    toast('✓ ' + bundles.length + ' bundle tersalin ke clipboard');
  } catch (e) {
    try {
      await browser.runtime.sendMessage({ type: 'COPY_TO_CLIPBOARD', text: fullText });
      toast('✓ ' + bundles.length + ' bundle tersalin ke clipboard');
    } catch (e2) {
      toast('⚠ Gagal menyalin: ' + e2.message, false);
    }
  }
}

// v3.11.14: Unarsip — keluarkan item dari arsip (untuk chip 'archive')
async function vaultBatchUnarchiveAction() {
  if (vaultBatchSelected.size === 0) {
    toast('Pilih minimal 1 item dulu');
    return;
  }
  const ids = Array.from(vaultBatchSelected);
  const typeLabel = _batchItemTypeLabel();
  if (!confirm('Keluarkan ' + ids.length + ' ' + typeLabel + ' dari arsip?')) return;
  toast('📦 Mengeluarkan ' + ids.length + ' ' + typeLabel + ' dari arsip...');
  let ok = 0, fail = 0;
  for (const id of ids) {
    try {
      // Cek apakah id adalah item atau bundle
      const item = currentVault.items.find(i => i.id === id);
      const bundle = currentVault.bundles.find(b => b.id === id);
      if (item) {
        await updateItem(id, { archived: false });
        ok++;
      } else if (bundle) {
        await updateBundle(id, { archived: false });
        ok++;
      } else {
        fail++;
      }
    } catch (e) {
      console.warn('Unarsip failed for', id, e.message);
      fail++;
    }
  }
  vaultBatchSelected.clear();
  vaultBatchMode = false;
  const bar = $('#vaultBatchBar');
  if (bar) bar.style.display = 'none';
  await refreshVault();
  renderList();
  toast('✓ ' + ok + ' item dikeluarkan dari arsip' + (fail > 0 ? ' (' + fail + ' gagal)' : ''));
}

// v3.20.43: Batch Move to Folder — pindahkan semua item terpilih ke folder tujuan
async function vaultBatchMoveFolderAction() {
  if (vaultBatchSelected.size === 0) {
    toast('Pilih minimal 1 item dulu');
    return;
  }
  const ids = Array.from(vaultBatchSelected);
  // Hanya item (bukan bundle) yang bisa dipindah ke folder
  const itemIds = ids.filter(id => currentVault.items.find(i => i.id === id) && !isGroupItem(currentVault.items.find(i => i.id === id)));
  if (itemIds.length === 0) {
    toast('Tidak ada item yang bisa dipindah (bundle tidak bisa dipindah ke folder)', false);
    return;
  }
  // Cari semua folder yang ada (exclude archived + exclude item yang sedang dipilih)
  const allFolders = currentVault.items.filter(i => isGroupItem(i) && !i.archived && !itemIds.includes(i.id));
  if (allFolders.length === 0) {
    toast('Belum ada folder. Buat folder dulu lewat tombol 📁+ Folder.', false);
    return;
  }
  // Buka sheet pilih folder — mirror openMoveToFolderSheet tapi untuk batch
  openSheet('Pindahkan ' + itemIds.length + ' item ke folder', 'Pilih folder tujuan', b => {
    let html = '<button class="act" data-fid=""><div>📤 Top-level (keluarkan dari folder)</div></button>';
    const nodes = buildTree(allFolders, [], null, true);
    function renderFolderOption(node, depth) {
      if (node.kind === 'group') {
        const indent = '\u00A0\u00A0'.repeat(depth);
        html += '<button class="act" data-fid="' + node.item.id + '"><div>' + indent + '📁 ' + esc(node.item.title) + '</div></button>';
        if (node.children) node.children.forEach(c => renderFolderOption(c, depth + 1));
      }
    }
    nodes.forEach(n => renderFolderOption(n, 0));
    b.innerHTML = html;
    b.querySelectorAll('[data-fid]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const fid = btn.dataset.fid || null;
        closeSheet();
        toast('📂 Memindahkan ' + itemIds.length + ' item...');
        let ok = 0, fail = 0;
        for (const itemId of itemIds) {
          try {
            await moveItemToGroup(itemId, fid);
            ok++;
          } catch (e) {
            console.warn('Batch move failed for', itemId, e.message);
            fail++;
          }
        }
        vaultBatchSelected.clear();
        vaultBatchMode = false;
        const bar = $('#vaultBatchBar');
        if (bar) bar.style.display = 'none';
        await refreshVault();
        renderList();
        const folderName = fid ? (currentVault.items.find(i => i.id === fid)?.title || 'folder') : 'top-level';
        toast('✓ ' + ok + ' item dipindahkan ke "' + folderName + '"' + (fail > 0 ? ' (' + fail + ' gagal)' : ''));
      });
    });
  });
}

// v3.20.43: Batch Archive — arsipkan semua item terpilih
async function vaultBatchArchiveAction() {
  if (vaultBatchSelected.size === 0) {
    toast('Pilih minimal 1 item dulu');
    return;
  }
  const ids = Array.from(vaultBatchSelected);
  const typeLabel = _batchItemTypeLabel();
  if (!confirm('Arsipkan ' + ids.length + ' ' + typeLabel + '?\n\nItem akan disembunyikan dari list utama. Bisa di-restore dari chip Arsip.')) return;
  toast('📦 Mengarsipkan ' + ids.length + ' ' + typeLabel + '...');
  let ok = 0, fail = 0;
  for (const id of ids) {
    try {
      const item = currentVault.items.find(i => i.id === id);
      const bundle = currentVault.bundles.find(b => b.id === id);
      if (item) {
        await updateItem(id, { archived: true });
        ok++;
      } else if (bundle) {
        await updateBundle(id, { archived: true });
        ok++;
      } else {
        fail++;
      }
    } catch (e) {
      console.warn('Batch archive failed for', id, e.message);
      fail++;
    }
  }
  vaultBatchSelected.clear();
  vaultBatchMode = false;
  const bar = $('#vaultBatchBar');
  if (bar) bar.style.display = 'none';
  await refreshVault();
  renderList();
  toast('✓ ' + ok + ' item diarsipkan' + (fail > 0 ? ' (' + fail + ' gagal)' : ''));
}

// v3.20.43: Batch Add to Bundle — tambahkan semua item terpilih ke bundle
async function vaultBatchBundleAction() {
  if (vaultBatchSelected.size === 0) {
    toast('Pilih minimal 1 item dulu');
    return;
  }
  const ids = Array.from(vaultBatchSelected);
  // Hanya item (bukan bundle) yang bisa ditambah ke bundle
  const itemIds = ids.filter(id => currentVault.items.find(i => i.id === id));
  if (itemIds.length === 0) {
    toast('Tidak ada item yang bisa ditambah ke bundle', false);
    return;
  }
  const bundles = currentVault.bundles || [];
  if (bundles.length === 0) {
    toast('Belum ada bundle. Buat bundle dulu.', false);
    return;
  }
  // Buka sheet pilih bundle — mirror openReassignBundleSheet tapi untuk batch
  openSheet('Tambah ' + itemIds.length + ' item ke Bundle', 'Pilih bundle tujuan — semua item terpilih akan ditambahkan.', b => {
    b.innerHTML = '<div class="sheet-form">'
      + '<div class="picklist">' + bundles.map(bd => {
          return '<label class="pickrow"><input type="checkbox" value="' + bd.id + '"><span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(bd.name || 'Bundle') + '</span><span class="pt-type">' + (bd.itemIds || []).length + ' item</span></label>';
        }).join('') + '</div>'
      + '<div class="btn-row"><button class="btn btn-g" id="rbBatchCancel">Batal</button><button class="btn btn-p" id="rbBatchSave">' + ICONS.check + 'Tambah ke Bundle</button></div></div>';
    const boxes = [...b.querySelectorAll('input[type=checkbox]')];
    $('#rbBatchCancel').addEventListener('click', closeSheet);
    $('#rbBatchSave').addEventListener('click', async () => {
      const selectedBundles = boxes.filter(bx => bx.checked).map(bx => bx.value);
      if (selectedBundles.length === 0) {
        toast('Pilih minimal 1 bundle', false);
        return;
      }
      closeSheet();
      toast('📦 Menambahkan ' + itemIds.length + ' item ke ' + selectedBundles.length + ' bundle...');
      let ok = 0, fail = 0;
      for (const bundleId of selectedBundles) {
        for (const itemId of itemIds) {
          try {
            await reassignToBundle(bundleId, itemId, 'add');
            ok++;
          } catch (e) {
            console.warn('Batch bundle add failed:', bundleId, itemId, e.message);
            fail++;
          }
        }
      }
      vaultBatchSelected.clear();
      vaultBatchMode = false;
      const bar = $('#vaultBatchBar');
      if (bar) bar.style.display = 'none';
      await refreshVault();
      renderList();
      toast('✓ ' + ok + ' penambahan ke bundle' + (fail > 0 ? ' (' + fail + ' gagal)' : ''));
    });
  });
}

async function vaultBatchCopyAction(withCaption) {
  if (vaultBatchSelected.size === 0) {
    toast('Pilih minimal 1 screenshot dulu');
    return;
  }
  const ids = Array.from(vaultBatchSelected);
  toast(withCaption ? '📋 Menyalin ' + ids.length + ' item + keterangan...' : '🖼️ Menyalin ' + ids.length + ' gambar...');

  // v3.11.34: Lakukan clipboard.write LANGSUNG di popup context (bukan delegate
  // ke background → inject ke active tab yang sering gagal).
  // Format SAMA PERSIS dengan preview modal — via lib/copy-format.js.
  // v3.12.0 (Fase 7): Termasuk dokumen — di-batch sebagai "gambar" pakai halaman pertama.
  try {
    // Kumpulkan screenshot/dokumen + dataUrl
    const screenshots = [];
    for (const id of ids) {
      const item = currentVault.items.find(i => i.id === id);
      // v3.12.0: Hanya skip kalau BUKAN screenshot DAN BUKAN document.
      if (!item || (item.type !== 'screenshot' && item.type !== 'document')) continue;
      let dataUrl = null;
      try {
        const res = await browser.runtime.sendMessage({ type: 'GET_SCREENSHOT_BLOB', id });
        if (res?.ok && res.dataUrl) dataUrl = res.dataUrl;
      } catch (e) {}
      screenshots.push({ item, dataUrl });
    }
    if (screenshots.length === 0) {
      toast('Tidak ada screenshot/dokumen valid terpilih', false);
      return;
    }

    // v3.11.38: Limit max 9 gambar per batch (3x3 grid)
    if (screenshots.length > 9) {
      toast('Maksimal 9 gambar per batch. Pilih ≤ 9 screenshot.', false);
      return;
    }

    // v3.11.38: Build composite image (grid + numbering) untuk batch
    // 1 gambar = original (tanpa label), 2+ gambar = composite grid + nomor
    let compositeBlob = null;
    let compositeDataUrl = null;
    if (screenshots.length === 1) {
      // Single screenshot — pakai original dataUrl (tanpa label)
      compositeDataUrl = screenshots[0]?.dataUrl || null;
    } else {
      // Multiple screenshots — build composite grid image
      toast('🔨 Membuat gambar gabungan ' + screenshots.length + ' screenshot...');
      const compositeResult = await buildCompositeImage(screenshots);
      if (compositeResult.blob) {
        compositeBlob = compositeResult.blob;
        // Convert blob ke dataUrl untuk writeScreenshotToClipboard
        compositeDataUrl = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(compositeResult.blob);
        });
      }
    }

    if (withCaption) {
      // v3.12.0 (Fase 7): Build caption — kalau semua screenshot, pakai buildBatchCaption (lama).
      // Kalau ada dokumen, build per-item dengan tipe yang sesuai, gabungkan manual.
      let cap;
      const hasDoc = screenshots.some(s => s.item.type === 'document');
      if (!hasDoc) {
        // Pure screenshot batch — pakai buildBatchCaption (composite grid + numbering)
        cap = buildBatchCaption(screenshots);
      } else {
        // Mixed batch — build per-item dengan caption yang sesuai tipe
        const parts = [];
        const htmlParts = [];
        for (let i = 0; i < screenshots.length; i++) {
          const { item, dataUrl } = screenshots[i];
          const idx = i + 1;
          const c = item.type === 'document'
            ? buildDocumentCaption(item, dataUrl, { index: idx })
            : buildScreenshotCaption(item, dataUrl, { index: idx });
          parts.push(c.textPlain + '\n\n[' + (item.type === 'document' ? '📄 Gambar' : '📸 Gambar') + ' ' + idx + ']');
          htmlParts.push(c.textHtml);
        }
        const now = new Date();
        const dateStr = now.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
        cap = {
          textPlain: '# 📷 Bundle Media — RecallFox\nTanggal: ' + dateStr + ' · Total: ' + screenshots.length + ' item\n\n' + parts.join('\n\n---\n\n') + '\n\n— Ditangkap oleh RecallFox —',
          textHtml: '<div style="font-family:-apple-system,system-ui,sans-serif;font-size:13px;color:#1c1917"><h1 style="margin:0 0 6px">📷 Bundle Media — RecallFox</h1><p style="margin:0 0 10px;color:#57534e"><em>Tanggal: ' + dateStr + ' · Total: ' + screenshots.length + ' item</em></p>' + htmlParts.join('<hr style="border:none;border-top:1px solid #e7e5e4;margin:16px 0">') + '</div>',
          count: screenshots.length
        };
      }
      // v3.11.38: Pakai composite image (bukan screenshots[0] saja)
      const result = await writeScreenshotToClipboard(
        compositeDataUrl,
        cap.textPlain,
        cap.textHtml
      );
      if (result.ok) {
        const label = screenshots.length > 1
          ? '✓ ' + screenshots.length + ' gambar digabung jadi 1 — paste ke Google Docs/Gmail/WhatsApp'
          : (result.message || ('✓ 1 screenshot tersalin'));
        toast(label);
      } else {
        // Fallback: text-only
        try {
          await navigator.clipboard.writeText(cap.textPlain);
          toast('✓ ' + screenshots.length + ' screenshot tersalin (text-only — gambar tidak ikut)');
        } catch (e2) {
          toast('Gagal copy: ' + e2.message, false);
        }
      }
    } else {
      // Image only — v3.11.38: pakai composite image (bukan screenshot pertama saja)
      // v3.12.0 (Fase 7): Untuk dokumen, composite image tetap jalan — pakai halaman pertama.
      if (!compositeDataUrl) {
        toast('Gambar tidak ditemukan', false);
        return;
      }
      if (screenshots.length === 1) {
        // Single — copy original tanpa label
        const result = await writeScreenshotToClipboard(compositeDataUrl, '', '');
        if (result.ok) {
          toast(result.message || '✓ Gambar tersalin');
        } else {
          toast('Gagal copy gambar: ' + (result.error || ''), false);
        }
      } else {
        // Multiple — copy composite PNG blob langsung
        if (compositeBlob && typeof ClipboardItem !== 'undefined') {
          try {
            const item = new ClipboardItem({ 'image/png': compositeBlob });
            await navigator.clipboard.write([item]);
            toast('✓ ' + screenshots.length + ' gambar digabung jadi 1 — paste ke Google Docs/Gmail/WhatsApp');
          } catch (e) {
            console.warn('[RecallFox] Composite clipboard write failed:', e.message);
            // Fallback: pakai compositeDataUrl via writeScreenshotToClipboard
            const result = await writeScreenshotToClipboard(compositeDataUrl, '', '');
            if (result.ok) {
              toast('✓ ' + screenshots.length + ' gambar gabungan tersalin');
            } else {
              toast('Gagal copy gambar: ' + (result.error || ''), false);
            }
          }
        } else {
          // Fallback: pakai writeScreenshotToClipboard
          const result = await writeScreenshotToClipboard(compositeDataUrl, '', '');
          if (result.ok) {
            toast('✓ ' + screenshots.length + ' gambar gabungan tersalin');
          } else {
            toast('Gagal copy gambar: ' + (result.error || ''), false);
          }
        }
      }
    }
  } catch (e) {
    console.warn('[RecallFox] Batch copy exception:', e.message);
    toast('Error: ' + e.message, false);
  }
}

// v3.11.25 (Sesi 15): Fallback copy text-only di popup context (tidak butuh tab aktif).
// Copy markdown rapi dengan metadata screenshot. Tidak ada gambar (hanya teks).
// User feedback: "kenapa fungsi batch kopi ini jadi tidak aktif? tolong perbaiki
// tanpa merusak yang sudah ada."
async function _vaultBatchCopyTextFallback(ids, withCaption) {
  const items = ids.map(id => currentVault.items.find(i => i.id === id)).filter(i => i && i.type === 'screenshot');
  if (items.length === 0) {
    toast('Tidak ada screenshot valid terpilih', false);
    return;
  }
  const now = new Date();
  const dateStr = now.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
  const parts = [
    '# Screenshot Bundle — RecallFox',
    'Tanggal: ' + dateStr + ' · Total: ' + items.length + ' screenshot',
    ''
  ];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const pageTitle = item.source?.title || item.title || 'screenshot';
    const pageUrl = item.source?.url || '';
    const capturedAt = item.source?.capturedAt || item.createdAt || now.toISOString();
    const modeLabel = item.screenshotMode === 'visible' ? 'Viewport' : (item.screenshotMode === 'selection' ? 'Area' : (item.screenshotMode === 'entire' ? 'Seluruh halaman' : '-'));
    const dims = (item.screenshotWidth || 0) + '×' + (item.screenshotHeight || 0) + ' px';
    const tags = Array.isArray(item.tags) ? item.tags.join(', ') : (item.tags || '');
    const capturedDate = new Date(capturedAt).toLocaleString('id-ID', { dateStyle: 'full', timeStyle: 'short' });
    const num = i + 1;
    parts.push('## ' + num + '. ' + pageTitle);
    if (pageUrl) parts.push('**Sumber:** ' + pageUrl);
    parts.push('**Waktu:** ' + capturedDate);
    parts.push('**Mode:** ' + modeLabel + ' · ' + dims);
    if (tags) parts.push('**Tag:** ' + tags);
    // v3.11.25 (Sesi 15, Issue #3): Tampilkan annotation note kalau ada
    if (item.annotationNote) parts.push('**Catatan Anotasi:** ' + item.annotationNote);
    parts.push('');
    parts.push('[📸 Gambar ' + num + ' — ' + dims + ']');
    parts.push('');
    if (i < items.length - 1) parts.push('---');
  }
  const fullText = parts.join('\n');
  try {
    await navigator.clipboard.writeText(fullText);
    toast('✓ ' + items.length + ' screenshot tersalin (text-only fallback — gambar tidak ikut)');
  } catch (e) {
    toast('⚠ Gagal copy: ' + e.message + '. Coba buka halaman web http(s) dulu, lalu klik copy lagi.', false);
  }
}

// v3.11.13 (Sesi 12): Batch delete screenshot — bersih-bersih vault gampang.
// v3.11.14: Generalisasi untuk SEMUA tipe item (prompt, link, bundle, archive, dll).
// User feedback Sesi 12: "sudah bagus fitur batch nya harusnya ada batch delete juga,
// jadi bersih bersihnya gampang. apakah bisa ditambahkan?"
async function vaultBatchDeleteAction() {
  if (vaultBatchSelected.size === 0) {
    toast('Pilih minimal 1 item dulu');
    return;
  }
  const ids = Array.from(vaultBatchSelected);
  const typeLabel = _batchItemTypeLabel();
  // Konfirmasi supaya tidak salah hapus
  const isArchive = currentChip === 'archive';
  const confirmMsg = isArchive
    ? 'Hapus ' + ids.length + ' ' + typeLabel + ' permanen dari vault?\n\nItem di arsip akan dihapus permanen. Tidak bisa di-undo.'
    : 'Hapus ' + ids.length + ' ' + typeLabel + ' dari vault?\n\nItem akan dihapus permanen. Tidak bisa di-undo.';
  if (!confirm(confirmMsg)) {
    return;
  }
  toast('🗑️ Menghapus ' + ids.length + ' ' + typeLabel + '...');
  try {
    const res = await browser.runtime.sendMessage({
      type: 'DELETE_ITEMS_BATCH',
      ids
    });
    if (res?.ok) {
      toast('✓ ' + (res.deleted || ids.length) + ' ' + typeLabel + ' dihapus' + (res.failed ? ' (' + res.failed + ' gagal)' : ''));
      vaultBatchSelected.clear();
      vaultBatchMode = false;
      const bar = $('#vaultBatchBar');
      if (bar) bar.style.display = 'none';
      await refreshVault();
      // Re-render supaya checkbox hilang
      renderList();
    } else {
      toast('Gagal: ' + (res?.error || 'unknown'), false);
    }
  } catch (e) {
    toast('Error: ' + e.message, false);
  }
}

function visibleItems() {
  const items = getVaultItems();
  let vi;
  if (currentChip === 'archive') {
    vi = items.filter(i => i.archived || (i._bundle && i._bundle.archived));
  } else if (currentChip === 'all') {
    vi = items.filter(i => !i.archived && !(i._bundle && i._bundle.archived));
  } else if (currentChip === 'recent') {
    // v3.19.0: Chip "Terbaru" — 15 item terbaru by createdAt, cross-folder, cross-type
    vi = items.filter(i => !i.archived && !(i._bundle && i._bundle.archived) && !isGroupItem(i));
    vi.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    vi = vi.slice(0, 15);
    return vi;
  } else if (currentChip === 'screenshot') {
    vi = items.filter(i => (i.type === 'screenshot' || i.type === 'document') && !i.archived);
  } else {
    vi = items.filter(i => i.type === currentChip && !i.archived);
  }
  if (currentBundleScope) {
    const bundle = currentVault?.bundles?.find(b => b.id === currentBundleScope);
    if (bundle) {
      const memberIds = new Set(bundle.itemIds || []);
      vi = vi.filter(i => memberIds.has(i.id));
    } else {
      currentBundleScope = null;
    }
  }
  // v3.19.0: Tag filter — filter item by active tag
  if (activeTagFilter) {
    vi = vi.filter(i => Array.isArray(i.tags) && i.tags.includes(activeTagFilter));
  }
  if (currentQuery && !currentQuery.startsWith('>')) {
    const q = currentQuery.toLowerCase();
    vi = vi.filter(i => searchableTextFor(i).indexOf(q) >= 0);
  }
  return vi;
}

// v3.18.0: Tree/grouping — START FRESH. Simple, clean, follows wireframe.
// Folder tree HANYA di kategori spesifik (Prompt, Link, Media, dll). "Semua" = flat.

// ===== renderFlatList: generate HTML untuk vault list =====
// "Semua"/"Arsip" → flat, group items SKIP
// Kategori spesifik → tree dengan groups + connectors
function renderFlatList(items) {
  const isSpecificCategory = currentChip !== 'all' && currentChip !== 'archive' && currentChip !== 'recent';
  const categoryFilter = isSpecificCategory ? (currentChip === 'screenshot' ? 'screenshot' : currentChip) : null;
  const nodes = buildTree(items, expandedGroupIds, categoryFilter, true, vaultSortMode);
  return renderNodes(nodes, 0);
}

// v3.18.4: Recursive render — folder bisa berisi folder lagi
function renderNodes(nodes, depth) {
  let html = '';
  for (const node of nodes) {
    if (node.kind === 'group') {
      html += renderGroupHtml(node, depth);
      if (node.isExpanded && node.children.length > 0) {
        html += renderNodes(node.children, depth + 1);
      }
    } else {
      const connector = depth > 0 ? (depth === 1 ? '\u251c\u2500\u2500 ' : '\u2502  \u251c\u2500\u2500 ') : '';
      html += renderItemHtml(node.item, depth, connector);
    }
  }
  return html;
}

// ===== renderGroupHtml: group header dengan chevron + count =====
// v3.18.4: Tambah parameter depth untuk nested folder indent
function renderGroupHtml(node, depth) {
  const g = node.item;
  const chevron = node.isExpanded ? '\u25BC' : '\u25B6';
  const count = node.children.length;
  const padLeft = depth > 0 ? ';padding-left:' + (10 + depth * 16) + 'px' : '';
  // v3.19.0: Folder color — border-left berwarna kalau source.folderColor diset
  const folderColor = g.source?.folderColor;
  const borderLeft = folderColor ? ';border-left:3px solid ' + folderColor : '';
  return '<div class="item vault-group-header" data-group-id="' + g.id + '" data-id="' + g.id + '" data-is-group="1" tabindex="0" draggable="true" style="cursor:pointer;background:var(--surface-2);border-radius:6px;margin:2px 0' + padLeft + borderLeft + '">'
    + '<span style="font-size:12px;margin-right:4px;flex-shrink:0">' + chevron + '</span>'
    + '<span style="font-size:16px;margin-right:6px">' + (folderColor ? '\uD83D\uDCC1' : '\uD83D\uDCC1') + '</span>'
    + '<span style="flex:1;font-weight:600;font-size:13px">' + esc(g.title) + '</span>'
    + '<span style="font-size:10px;color:var(--muted);background:var(--surface);padding:1px 6px;border-radius:8px;margin-right:4px">' + count + '</span>'
    + '<button class="morebtn" data-more="' + g.id + '" title="Kelola folder" style="flex-shrink:0">' + ICONS.dots + '</button>'
    + '</div>';
}

// ===== renderItemHtml: generate HTML untuk satu item (dengan indent + connector) =====
function renderItemHtml(it, indent, connector) {
  const T = TYPE[it.type] || { label: it.type, icon: '' };
  const tagsStr = Array.isArray(it.tags) ? it.tags.join(', ') : (it.tags || '');
  const vars = it.body ? extractVariables(it.body).length : 0;
  const fav = it.favorite ? '<span class="fav">\u2605</span>' : '';
  const arch = it.archived ? '<span class="fav" title="Diarsipkan" style="color:var(--muted)">\uD83D\uDCE6</span>' : '';
  const uses = it.useCount || it.uses || 0;
  let ctaHtml = '';
  // v3.20.47: Standarisasi — SEMUA type item punya Sisip + Salin.
  // Sisip = inject ke AI/active tab (zap icon). Salin = copy ke clipboard (copy icon).
  // Plus tombol type-specific yang sudah ada (Lihat, Download, Buka, Scope).
  if (it.type === 'link') {
    ctaHtml = '<span class="cta-pill" data-link-action="inject" title="Sisipkan URL ke chat AI">' + ICONS.zap + 'Sisip \u21B5</span>'
      + '<button class="link-mini-btn" data-link-action="copy" title="Salin URL ke clipboard">' + ICONS.copy + '</button>'
      + '<button class="link-mini-btn" data-link-action="open" title="Buka link di tab baru">' + ICONS.spark + '</button>';
  } else if (it.type === 'bundle') {
    const memberCount = (it._bundle?.itemIds || []).length;
    ctaHtml = '<span class="cta-pill" data-bundle-action="inject">' + ICONS.zap + 'Sisip \u21B5</span>'
      + '<button class="link-mini-btn" data-bundle-action="copy" title="Salin bundle ke clipboard">' + ICONS.copy + '</button>'
      + (memberCount > 0 ? '<button class="link-mini-btn" data-bundle-action="scope" title="Lihat anggota bundle">\uD83D\uDC41</button>' : '');
  } else if (it.type === 'screenshot') {
    ctaHtml = '<span class="cta-pill" data-shot-action="view">' + ICONS.image + 'Lihat \u21B5</span>'
      + '<button class="link-mini-btn" data-shot-action="inject" title="Sisipkan URL gambar ke chat AI">' + ICONS.zap + '</button>'
      + '<button class="link-mini-btn" data-shot-action="download" title="Download gambar">' + ICONS.download + '</button>';
  } else if (it.type === 'document') {
    ctaHtml = '<span class="cta-pill" data-shot-action="view">\uD83D\uDCC4 Lihat \u21B5</span>'
      + '<button class="link-mini-btn" data-shot-action="inject" title="Sisipkan URL dokumen ke chat AI">' + ICONS.zap + '</button>'
      + '<button class="link-mini-btn" data-shot-action="download" title="Download halaman pertama">' + ICONS.download + '</button>';
  } else if (it.type === 'file') {
    ctaHtml = '<span class="cta-pill" data-file-action="inject" title="Sisipkan isi file ke chat AI">' + ICONS.zap + 'Sisip \u21B5</span>'
      + '<button class="link-mini-btn" data-file-action="copy" title="Salin isi file ke clipboard">' + ICONS.copy + '</button>'
      + '<button class="link-mini-btn" data-file-action="download" title="Download file">' + ICONS.download + '</button>';
  } else {
    // v3.20.47: Standarisasi — prompt/context/snapshot dapat DUA tombol eksplisit:
    //   - Sisip ⤴ (data-prompt-action="inject"): doInject → coba sisip ke active tab editor
    //   - Salin ⤴ (data-prompt-action="copy"): _copyTextWithFallback → clipboard only
    // Sebelumnya: cta-pill tunggal tanpa data-action, klik fallthrough ke primaryAction
    //   yang panggil doInject (coba sisip, fallback clipboard). Label "Salin" menyesatkan
    //   karena sebenarnya inject. User complain: "Sisip tidak jalan, Salin juga tidak."
    // Fix: dua tombol terpisah supaya user bisa pilih injeksi ATAU salin.
    ctaHtml = '<span class="cta-pill" data-prompt-action="inject" title="Sisipkan ke chat AI">' + ICONS.zap + 'Sisip \u21B5</span>'
      + '<button class="link-mini-btn" data-prompt-action="copy" title="Salin ke clipboard">' + ICONS.copy + '</button>';
  }
  let batchCheckboxHtml = '';
  if (vaultBatchMode) {
    const checked = vaultBatchSelected.has(it.id) ? ' checked' : '';
    batchCheckboxHtml = '<input type="checkbox" class="vault-batch-check" data-id="' + it.id + '"' + checked + ' style="width:16px;height:16px;cursor:pointer;accent-color:var(--primary);flex-shrink:0;margin-right:4px">';
  }
  const docPageCount = (it.type === 'document' && Array.isArray(it.source?.pages)) ? it.source.pages.length : 0;
  const docBadge = docPageCount > 1
    ? ' <span title="' + docPageCount + ' halaman" style="font-size:10px;background:var(--surface-2);padding:1px 5px;border-radius:6px;color:var(--muted)">\uD83D\uDCC4 ' + docPageCount + ' hal</span>'
    : (it.type === 'document' ? ' <span title="1 halaman" style="font-size:10px;background:var(--surface-2);padding:1px 5px;border-radius:6px;color:var(--muted)">\uD83D\uDCC4 1 hal</span>' : '');
  let snapshotBadge = '';
  if (it.type === 'snapshot') {
    const parts = [];
    if (it.snapshotDomain) parts.push(esc(it.snapshotDomain));
    if (it.snapshotMessageCount) parts.push(it.snapshotMessageCount + ' pesan');
    if (parts.length > 0) snapshotBadge = '<span title="Snapshot dari ' + esc(it.snapshotDomain || '?') + '" style="font-size:10px;color:var(--muted)">\uD83D\uDCF8 ' + parts.join(' \u00B7 ') + '</span>';
  }
  let contextPurposeBadge = '';
  if (it.type === 'context' && it.contextPurpose && it.contextPurpose !== 'custom') {
    const purposeLabels = { system: 'Sistem', project: 'Proyek', domain: 'Domain', reference: 'Referensi', instruction: 'SOP' };
    const label = purposeLabels[it.contextPurpose] || it.contextPurpose;
    contextPurposeBadge = '<span title="Tujuan: ' + esc(label) + '" style="font-size:10px;color:var(--muted)">\uD83D\uDCCB ' + esc(label) + '</span>';
  }
  let activeContextBadge = '';
  if (it.type === 'context') {
    const activeIds = (currentVault?.settings?.activeContextIds) || [];
    if (activeIds.includes(it.id)) activeContextBadge = ' <span title="Konteks aktif" style="font-size:10px;color:#10b981">\uD83D\uDFE2</span>';
  }
  const indentStyle = indent > 0 ? ' style="padding-left:' + (10 + indent * 16) + 'px"' : '';
  const connectorSpan = connector ? '<span style="font-size:10px;color:var(--muted);flex-shrink:0;width:24px">' + connector + '</span>' : '';
  // v3.19.1: Display GPS location dari PWA capture (source.location).
  // Schema: { lat, lng, accuracy, address, capturedAt } — kompatibel dengan PWA v1.8.0.
  // v3.20.24: Kalau loc ada + lat/lng ada TAPI address kosong, trigger reverse
  // geocode async di background. Setelah selesai, patch vault item + re-render.
  // Fix issue: "di bagian media, lokasi yang kebaca adalah titik koordinat untuk
  // foto yang baru di take, bukan nama jalan" — terjadi kalau PWA gagal reverse
  // geocode saat capture (Nominatim timeout) atau item lama sebelum fitur ini.
  const loc = it.source?.location;
  const locationBadge = loc ? ' \u00B7 <span title="' + esc(loc.address || (loc.lat + ', ' + loc.lng)) + '" style="font-size:10px;color:var(--green)">\uD83D\uDCCD ' + esc((loc.address || (loc.lat?.toFixed(4) + ', ' + loc.lng?.toFixed(4))).slice(0, 30)) + '</span>' : '';
  // v3.20.24: Lazy reverse geocode — fire-and-forget, no await (tidak block render)
  if (loc && loc.lat != null && loc.lng != null && !loc.address) {
    // Dedupe: jangan reverse geocode item yang sama berkali-kali dalam satu render cycle
    if (!_pendingReverseGeocode.has(it.id)) {
      _pendingReverseGeocode.add(it.id);
      browser.runtime.sendMessage({
        type: 'REVERSE_GEOCODE_LOCATION',
        itemId: it.id,
        lat: loc.lat,
        lng: loc.lng
      }).catch(() => {}).finally(() => {
        // Allow retry setelah 5 menit (kalau gagal, bisa coba lagi nanti)
        setTimeout(() => _pendingReverseGeocode.delete(it.id), 300000);
      });
    }
  }
  // v1.8.1: Voice notes DIHAPUS — user bilang "batasan mb, tidak terpakai".
  return '<div class="item" data-id="' + it.id + '" tabindex="0" draggable="true"' + indentStyle + '>'
    + batchCheckboxHtml
    + connectorSpan
    + '<div class="item-ic t-' + it.type + '">' + T.icon + '</div>'
    + '<div class="item-main">'
    + '<div class="item-title">' + fav + arch + esc(it.title) + docBadge + activeContextBadge + (vars ? ' <span title="' + vars + ' variabel" style="font-size:10px">\u2699\uFE0F</span>' : '') + '</div>'
    + '<div class="item-meta">' + T.label
    + (snapshotBadge ? ' \u00B7 ' + snapshotBadge : '')
    + (contextPurposeBadge ? ' \u00B7 ' + contextPurposeBadge : '')
    + locationBadge
    + ' \u00B7 ' + esc(tagsStr) + (uses ? ' \u00B7 <span class="uses">' + uses + '\u00D7 dipakai</span>' : '') + '</div>'
    + '</div>'
    + '<div class="item-cta">'
    + ctaHtml
    + '<button class="morebtn" data-more="' + it.id + '" title="Aksi lainnya">' + ICONS.dots + '</button>'
    + '</div></div>';
}

// ===== wireVaultEvents: DnD + expand/collapse. Bind SEKALI dengan guard. =====
function wireVaultEvents() {
  const listEl = $('#list');
  if (!listEl) return;
  if (listEl.dataset.vaultEventsBound === '1') return;
  listEl.dataset.vaultEventsBound = '1';

  const dropzoneEl = $('#vaultRootDropzone');

  // Expand/collapse group header
  listEl.addEventListener('click', (e) => {
    const groupEl = e.target.closest('[data-is-group="1"]');
    if (!groupEl) return;
    e.stopPropagation();
    const gid = groupEl.dataset.groupId;
    if (expandedGroupIds.includes(gid)) {
      expandedGroupIds = expandedGroupIds.filter(id => id !== gid);
    } else {
      expandedGroupIds.push(gid);
    }
    renderList();
  });

  // Drag start — v3.18.4: group items JUGA bisa di-drag (untuk nested folder)
  listEl.addEventListener('dragstart', (e) => {
    const itemEl = e.target.closest('.item');
    if (!itemEl) return;
    draggedItemId = itemEl.dataset.id;
    if (!draggedItemId) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', draggedItemId);
    itemEl.style.opacity = '0.4';
    // Show dropzone kalau item punya parent (bisa unparent)
    if (dropzoneEl) {
      const item = currentVault?.items?.find(i => i.id === draggedItemId);
      if (item && getParentId(item)) {
        dropzoneEl.style.display = '';
      }
    }
  });

  // Drag end
  listEl.addEventListener('dragend', (e) => {
    const itemEl = e.target.closest('.item');
    if (itemEl) itemEl.style.opacity = '';
    draggedItemId = null;
    if (dropzoneEl) dropzoneEl.style.display = 'none';
  });

  // Drag over group — highlight
  listEl.addEventListener('dragover', (e) => {
    if (!draggedItemId) return;
    const groupEl = e.target.closest('[data-is-group="1"]');
    if (groupEl && groupEl.dataset.groupId !== draggedItemId) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      groupEl.style.background = 'var(--primary-soft, rgba(99,102,241,.15))';
    }
  });

  // Drag leave group — remove highlight
  listEl.addEventListener('dragleave', (e) => {
    const groupEl = e.target.closest('[data-is-group="1"]');
    if (groupEl) groupEl.style.background = '';
  });

  // Drop on group
  listEl.addEventListener('drop', (e) => {
    if (!draggedItemId) return;
    const groupEl = e.target.closest('[data-is-group="1"]');
    if (groupEl && groupEl.dataset.groupId !== draggedItemId) {
      e.preventDefault();
      e.stopPropagation();
      groupEl.style.background = '';
      moveItemToGroup(draggedItemId, groupEl.dataset.groupId);
    }
  });

  // Dropzone (unparent)
  if (dropzoneEl) {
    dropzoneEl.addEventListener('dragover', (e) => {
      if (!draggedItemId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    dropzoneEl.addEventListener('drop', (e) => {
      if (!draggedItemId) return;
      e.preventDefault();
      moveItemToGroup(draggedItemId, null);
    });
  }
}

// ===== moveItemToGroup: set parentId + save + sync =====
async function moveItemToGroup(itemId, groupId) {
  if (!currentVault) return;
  const item = currentVault.items.find(i => i.id === itemId);
  if (!item) return;
  const oldParent = getParentId(item);
  if (oldParent === groupId) return; // tidak berubah

  // v3.18.4: Cek circular reference — kalau item adalah group, pastikan
  // groupId bukan descendant dari item (tidak bisa pindah folder ke dalam dirinya sendiri)
  if (groupId && isGroupItem(item)) {
    let current = groupId;
    while (current) {
      if (current === itemId) {
        toast('\u26A0 Tidak bisa pindah folder ke dalam dirinya sendiri', false);
        return;
      }
      const parent = currentVault.items.find(i => i.id === current);
      current = parent ? getParentId(parent) : null;
    }
  }

  setParentId(item, groupId);
  item.updatedAt = new Date().toISOString();
  try {
    await updateItem(itemId, { source: item.source, updatedAt: item.updatedAt });
    // v3.18.4: Auto-expand target folder supaya user langsung lihat item yang dipindah
    if (groupId && !expandedGroupIds.includes(groupId)) {
      expandedGroupIds.push(groupId);
    }
    await refreshVault();
    if (groupId) {
      const grp = currentVault.items.find(i => i.id === groupId);
      toast('\uD83D\uDCC1 Dipindahkan ke \u201C' + (grp?.title || 'folder') + '\u201D');
    } else {
      toast('\uD83D\uDCE5 Dikeluarkan dari folder');
    }
  } catch (e) {
    toast('Gagal pindah: ' + e.message, false);
  }
}

// ===== handleAddGroup: buat folder baru =====
// v3.20.48: Ganti window.prompt() dengan modal standar (openSheet).
// Modal punya: nama folder (wajib) + pilihan warna (opsional).
// TIDAK tambah tag (per instruksi user — nanti sebagai enhancement terpisah).
async function handleAddGroup() {
  let groupType = currentChip;
  if (currentChip === 'all' || currentChip === 'archive') {
    groupType = 'prompt';
  }
  const colors = [
    { id: '', label: 'Default', color: 'var(--muted)' },
    { id: '#ef4444', label: 'Merah', color: '#ef4444' },
    { id: '#f59e0b', label: 'Oranye', color: '#f59e0b' },
    { id: '#10b981', label: 'Hijau', color: '#10b981' },
    { id: '#3b82f6', label: 'Biru', color: '#3b82f6' },
    { id: '#8b5cf6', label: 'Ungu', color: '#8b5cf6' },
    { id: '#ec4899', label: 'Pink', color: '#ec4899' }
  ];
  let selectedColor = '';
  openSheet('📁 Buat Folder Baru', 'Masukkan nama folder + pilih warna (opsional)', b => {
    b.innerHTML =
      '<div style="padding:4px 0">'
      + '<label style="font-size:11px;font-weight:600;color:var(--text-2);display:block;margin-bottom:4px">Nama Folder <span style="color:var(--danger)">*</span></label>'
      + '<input id="rfNewFolderName" type="text" placeholder="mis. Referensi, Coding, Proyek A..." style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:var(--r-md);font-size:13px;background:var(--surface);color:var(--text);outline:none" />'
      + '</div>'
      + '<div style="padding:8px 0 4px">'
      + '<label style="font-size:11px;font-weight:600;color:var(--text-2);display:block;margin-bottom:6px">Warna (opsional)</label>'
      + '<div id="rfNewFolderColors" style="display:flex;gap:6px;flex-wrap:wrap">'
      + colors.map(c =>
        '<button type="button" class="rf-color-pick" data-color="' + c.id + '" title="' + c.label + '" style="width:28px;height:28px;border-radius:6px;border:2px solid ' + (c.id === '' ? 'var(--border)' : 'transparent') + ';background:' + c.color + ';cursor:pointer;padding:0"></button>'
      ).join('')
      + '</div>'
      + '</div>'
      + '<div style="display:flex;gap:8px;padding:12px 0 0;justify-content:flex-end">'
      + '<button class="btn btn-g" id="rfNewFolderCancel">Batal</button>'
      + '<button class="btn btn-p" id="rfNewFolderSave">📁 Simpan</button>'
      + '</div>';
    // Focus input
    const nameInput = b.querySelector('#rfNewFolderName');
    if (nameInput) nameInput.focus();
    // Color picker
    b.querySelectorAll('.rf-color-pick').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedColor = btn.dataset.color;
        b.querySelectorAll('.rf-color-pick').forEach(b2 => b2.style.borderColor = 'transparent');
        btn.style.borderColor = 'var(--primary)';
      });
    });
    // Cancel
    b.querySelector('#rfNewFolderCancel').addEventListener('click', closeSheet);
    // Save
    b.querySelector('#rfNewFolderSave').addEventListener('click', async () => {
      const name = (nameInput?.value || '').trim();
      if (!name) {
        nameInput.style.borderColor = 'var(--danger)';
        nameInput.focus();
        toast('⚠ Nama folder wajib diisi', false);
        return;
      }
      closeSheet();
      const group = createGroup(name, groupType);
      if (selectedColor) {
        if (!group.source) group.source = {};
        group.source.folderColor = selectedColor;
      }
      try {
        await addItem(group);
        expandedGroupIds.push(group.id);
        if (currentChip === 'all' || currentChip === 'archive') {
          currentChip = groupType;
        }
        await refreshVault();
        renderChips();
        toast('📁 Folder "' + name + '" dibuat');
      } catch (e) {
        toast('Gagal buat folder: ' + e.message, false);
      }
    });
    // Enter key = save
    nameInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        b.querySelector('#rfNewFolderSave').click();
      }
    });
  });
}

// ===== handleAiAutoGroup: AI grouping otomatis (Magic Folder) =====
// v3.20.30: Regenerate button + exclude items-in-folder + move existing folders.
//
// v3.20.29: subfolder + reasoning + checkbox
// v3.20.30 enhancement (user request):
//   - Pass FULL vault items (including folders) supaya aiAutoGroup bisa detect
//     existing folders sebagai movable units
//   - Track regenerate count supaya bisa re-call dengan variation hint
//   - Preview modal tampilkan existing folders yang akan dipindah
//   - Apply logic: move existing folders via setParentId (bukan cuma items)

let _magicFolderRegenerateCount = 0;  // v3.20.30: state untuk regenerate
let _magicFolderUserInstruction = '';  // v3.20.31: state untuk user instruction

// v3.20.32: Magic Command — ketik perintah natural language untuk pindahkan item ke folder.
// User bisa bilang: "pindahkan link MDN ke folder Referensi" atau "bikin folder Coding,
// masukkan prompt Express + Vue ke situ".
async function handleMagicCommand() {
  if (!currentVault?.items?.length) { toast('Vault kosong', false); return; }
  const looseItems = currentVault.items.filter(i => !isGroupItem(i) && !i.archived);
  if (looseItems.length < 1) {
    toast('Tidak ada item loose untuk dipindahkan', false);
    return;
  }
  const { isAssistantConfigured } = await import('../lib/assistant.js');
  if (!(await isAssistantConfigured())) {
    toast('⚠ Setup AI Assistant dulu di Pengaturan → AI Assistant', false);
    return;
  }
  showMagicCommandModal();
}

function showMagicCommandModal() {
  closeMagicFolderModal();
  const modal = document.createElement('div');
  modal.id = 'rf-magicfolder-modal';
  modal.className = 'rf-magicfolder-overlay';
  modal.innerHTML = `
    <div class="rf-magicfolder-dialog">
      <div class="rf-magicfolder-hd">
        <h3>💬 Magic Command</h3>
        <button class="rf-magicfolder-close" id="rfMagicCmdCancel" title="Batal">×</button>
      </div>
      <div class="rf-magicfolder-body">
        <p class="rf-magicfolder-summary">
          Ketik perintah natural language. AI akan cari item yang cocok + folder tujuan, lalu pindahkan otomatis.
        </p>
        <div class="rf-magicfolder-cmd-section">
          <textarea
            id="rfMagicCmdInput"
            class="rf-magicfolder-instr-textarea"
            rows="4"
            placeholder="Contoh: Pindahkan link MDN dan GitHub Docs ke folder Referensi. Atau: Bikin folder Coding, masukkan prompt Express + Vue ke situ."
          ></textarea>
          <div class="rf-magicfolder-cmd-examples">
            <div class="rf-magicfolder-cmd-examples-title">💡 Contoh perintah (klik untuk pakai):</div>
            <button class="rf-magicfolder-cmd-example" data-cmd="Pindahkan semua link ke folder Link">📁 Pindahkan semua link ke folder Link</button>
            <button class="rf-magicfolder-cmd-example" data-cmd="Bikin folder Coding, masukkan semua prompt tentang programming">📁+ Bikin folder Coding + semua prompt programming</button>
            <button class="rf-magicfolder-cmd-example" data-cmd="Arsipkan folder Lama">📦 Arsipkan folder Lama</button>
            <button class="rf-magicfolder-cmd-example" data-cmd="Restore folder Lama dari arsip">♻️ Restore folder Lama dari arsip</button>
            <button class="rf-magicfolder-cmd-example" data-cmd="Tambahkan tag favorit ke semua link">🏷️ Tambahkan tag favorit ke semua link</button>
            <button class="rf-magicfolder-cmd-example" data-cmd="Hapus tag lama dari semua prompt">🏷️ Hapus tag lama dari semua prompt</button>
            <button class="rf-magicfolder-cmd-example" data-cmd="Buat folder AI dan pindahkan semua link tentang AI ke folder AI kemudian arsipkan folder Lama">🔗 Multi-step: Buat folder AI + pindahkan link AI + arsipkan folder Lama</button>
            <button class="rf-magicfolder-cmd-example" data-cmd="Pindahkan semua screenshot ke folder Media, lalu tambahkan tag favorit">🔗 Multi-step: Pindahkan screenshot ke Media + tambah tag favorit</button>
          </div>
        </div>
      </div>
      <div class="rf-magicfolder-ft">
        <button class="btn btn-g" id="rfMagicCmdCancelBtn">Batal</button>
        <button class="btn btn-p" id="rfMagicCmdExecute">🪄 Eksekusi Perintah</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const cancel = () => closeMagicFolderModal();
  document.getElementById('rfMagicCmdCancel').addEventListener('click', cancel);
  document.getElementById('rfMagicCmdCancelBtn').addEventListener('click', cancel);

  document.querySelectorAll('.rf-magicfolder-cmd-example').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById('rfMagicCmdInput');
      if (input) input.value = btn.dataset.cmd || '';
      input?.focus();
    });
  });

  document.getElementById('rfMagicCmdExecute').addEventListener('click', async () => {
    const input = document.getElementById('rfMagicCmdInput');
    const cmd = (input?.value || '').trim();
    if (cmd.length < 3) {
      toast('⚠ Ketik perintah minimal 3 karakter', false);
      return;
    }
    await executeMagicCommand(cmd);
  });
}

async function executeMagicCommand(command) {
  const execBtn = document.getElementById('rfMagicCmdExecute');
  const cancelBtn = document.getElementById('rfMagicCmdCancelBtn');
  if (execBtn) { execBtn.disabled = true; execBtn.textContent = '⏳ AI mencari...'; }
  if (cancelBtn) cancelBtn.disabled = true;

  try {
    const { chatWithFallback } = await import('../lib/assistant.js');
    // v3.20.33: Pass SEMUA items (termasuk archived) supaya AI bisa pilih archived folder
    // untuk action "restore-folder". Filter !i.archived hanya dilakukan di parser untuk
    // loose items + existing folders — archived folders tetap di-include sebagai context.
    const allItems = currentVault.items || [];
    // v3.20.43: Pakai parseMultiStepCommand — support multi-step commands
    const result = await parseMultiStepCommand(allItems, chatWithFallback, command);
    if (!result.ok) {
      const errMap = {
        'command_too_short': 'Perintah terlalu pendek',
        'no_items_to_move': 'AI tidak menemukan item yang cocok dengan perintah',
        'no_valid_item_ids': 'Item yang AI pilih tidak valid',
        'no_valid_json_in_response': 'AI tidak return JSON valid. Coba lagi.',
        'missing_folder_name': 'AI tidak menentukan folder tujuan',
        'missing_tag_name': 'AI tidak menentukan nama tag',
        'no_valid_folder_to_archive': 'Folder yang mau di-arsip tidak ditemukan',
        'no_valid_archived_folder_to_restore': 'Folder archived tidak ditemukan',
        'too_few_items': 'Vault kosong',
        'no_steps_or_action_in_response': 'AI tidak return format yang valid. Coba lagi.',
        'empty_steps': 'AI tidak menemukan langkah yang valid',
        'no_valid_steps': 'Semua langkah tidak valid — coba perintah yang lebih spesifik'
      };
      toast('⚠ ' + (errMap[result.error] || result.error), false);
      if (execBtn) { execBtn.disabled = false; execBtn.textContent = '🪄 Eksekusi Perintah'; }
      if (cancelBtn) cancelBtn.disabled = false;
      return;
    }
    closeMagicFolderModal();
    // v3.20.43: Pass array of steps ke confirm modal
    showMagicCommandConfirmModal(result.steps, allItems);
  } catch (e) {
    toast('⚠ Gagal: ' + e.message, false);
    console.error('[RecallFox/MagicCmd] executeMagicCommand failed:', e);
    if (execBtn) { execBtn.disabled = false; execBtn.textContent = '🪄 Eksekusi Perintah'; }
    if (cancelBtn) cancelBtn.disabled = false;
  }
}

// v3.20.33: Confirm modal yang render berdasarkan action type (6 jenis)
// v3.20.43: Updated untuk support multi-step (array of plans)
function showMagicCommandConfirmModal(steps, allItems) {
  closeMagicFolderModal();

  // v3.20.43: steps adalah array of plans. Kalau bukan array, wrap jadi array.
  if (!Array.isArray(steps)) steps = [steps];

  const itemLookup = new Map();
  allItems.forEach(it => itemLookup.set(it.id, it));

  const actionLabels = {
    'move': 'Pindahkan item ke folder',
    'create-and-move': 'Buat folder baru + pindahkan item',
    'archive-folder': 'Arsipkan folder + semua isinya',
    'restore-folder': 'Restore folder dari arsip',
    'add-tag': 'Tambahkan tag ke item',
    'remove-tag': 'Hapus tag dari item',
    'archive-items': 'Arsipkan item-item',
    'delete-items': 'Hapus item-item'
  };

  // v3.20.43: Render setiap step sebagai card terpisah
  function renderStepCard(plan, stepNum) {
    // Render item pills (untuk move/create-and-move/add-tag/remove-tag/archive-items/delete-items)
    const itemPills = (plan.itemIds || []).slice(0, 8).map(id => {
      const it = itemLookup.get(id);
      if (!it) return '';
      const typeIcon = it.type === 'link' ? '🔗' : it.type === 'prompt' ? '✨' : it.type === 'context' ? '📦' : it.type === 'snapshot' ? '📸' : it.type === 'file' ? '📄' : it.type === 'screenshot' ? '🖼️' : '📄';
      return `<span class="rf-magicfolder-item-pill">${typeIcon} ${esc((it.title || 'Untitled').slice(0, 25))}</span>`;
    }).join('');
    const morePill = (plan.itemIds || []).length > 8 ? `<span class="rf-magicfolder-item-pill rf-magicfolder-more">+${plan.itemIds.length - 8} lainnya</span>` : '';

    let stepContent = '';
    if (plan.action === 'move' || plan.action === 'create-and-move') {
      const folderIcon = plan.action === 'create-and-move' ? '📁+' : '📁';
      const targetFolder = itemLookup.get(plan.folderId);
      const folderDisplay = plan.folderName || targetFolder?.title || 'Folder';
      stepContent = `
        <div class="rf-magicfolder-group">
          <div class="rf-magicfolder-group-hd">
            <span class="rf-magicfolder-folder-icon">${folderIcon}</span>
            <span class="rf-magicfolder-folder-name">${esc(folderDisplay)}</span>
            <span class="rf-magicfolder-folder-count">${plan.itemIds.length} item</span>
          </div>
          ${plan.reasoning ? `<div class="rf-magicfolder-reasoning">💡 ${esc(plan.reasoning)}</div>` : ''}
          <div class="rf-magicfolder-folder-items">${itemPills}${morePill}</div>
        </div>`;
    } else if (plan.action === 'archive-folder' || plan.action === 'restore-folder') {
      const targetFolder = itemLookup.get(plan.folderId);
      const folderDisplay = targetFolder?.title || plan.folderName || 'Folder';
      const icon = plan.action === 'archive-folder' ? '📦' : '♻️';
      const childCount = countFolderDescendants(allItems, plan.folderId);
      const childLabel = childCount > 0 ? ` + ${childCount} item di dalamnya` : '';
      stepContent = `
        <div class="rf-magicfolder-group">
          <div class="rf-magicfolder-group-hd">
            <span class="rf-magicfolder-folder-icon">${icon}</span>
            <span class="rf-magicfolder-folder-name">${esc(folderDisplay)}</span>
            <span class="rf-magicfolder-folder-count">${childCount === 0 ? 'kosong' : childCount + ' item'}</span>
          </div>
          ${plan.reasoning ? `<div class="rf-magicfolder-reasoning">💡 ${esc(plan.reasoning)}</div>` : ''}
          <div class="rf-magicfolder-folder-items">
            <span class="rf-magicfolder-item-pill">${icon} Folder + semua isi${childLabel}</span>
          </div>
        </div>`;
    } else if (plan.action === 'add-tag' || plan.action === 'remove-tag') {
      const icon = plan.action === 'add-tag' ? '🏷️+' : '🏷️−';
      stepContent = `
        <div class="rf-magicfolder-group">
          <div class="rf-magicfolder-group-hd">
            <span class="rf-magicfolder-folder-icon">${icon}</span>
            <span class="rf-magicfolder-folder-name">Tag: ${esc(plan.tagName)}</span>
            <span class="rf-magicfolder-folder-count">${plan.itemIds.length} item</span>
          </div>
          ${plan.reasoning ? `<div class="rf-magicfolder-reasoning">💡 ${esc(plan.reasoning)}</div>` : ''}
          <div class="rf-magicfolder-folder-items">${itemPills}${morePill}</div>
        </div>`;
    } else if (plan.action === 'archive-items' || plan.action === 'delete-items') {
      const icon = plan.action === 'archive-items' ? '📦' : '🗑️';
      stepContent = `
        <div class="rf-magicfolder-group">
          <div class="rf-magicfolder-group-hd">
            <span class="rf-magicfolder-folder-icon">${icon}</span>
            <span class="rf-magicfolder-folder-name">${plan.action === 'archive-items' ? 'Arsipkan' : 'Hapus'} ${plan.itemIds.length} item</span>
            <span class="rf-magicfolder-folder-count">${plan.itemIds.length} item</span>
          </div>
          ${plan.reasoning ? `<div class="rf-magicfolder-reasoning">💡 ${esc(plan.reasoning)}</div>` : ''}
          <div class="rf-magicfolder-folder-items">${itemPills}${morePill}</div>
        </div>`;
    }

    const unmatchedHtml = plan.unmatched && plan.unmatched.length > 0
      ? `<div class="rf-magicfolder-unmatched">⚠ Query tidak match: ${plan.unmatched.map(u => esc(u)).join(', ')}</div>`
      : '';

    const stepLabel = steps.length > 1 ? `<div class="rf-magicfolder-step-label">Langkah ${stepNum} dari ${steps.length}</div>` : '';
    return `<div class="rf-magicfolder-step">${stepLabel}<div class="rf-magicfolder-groups">${stepContent}</div>${unmatchedHtml}</div>`;
  }

  // Build all step cards
  const allStepsHtml = steps.map((plan, i) => renderStepCard(plan, i + 1)).join('');
  const isMultiStep = steps.length > 1;
  const summaryText = isMultiStep
    ? `AI akan menjalankan <b>${steps.length} langkah</b> secara berurutan:`
    : `AI akan <b>${actionLabels[steps[0].action] || steps[0].action}</b>:`;

  const modal = document.createElement('div');
  modal.id = 'rf-magicfolder-modal';
  modal.className = 'rf-magicfolder-overlay';
  modal.innerHTML = `
    <div class="rf-magicfolder-dialog">
      <div class="rf-magicfolder-hd">
        <h3>💬 Konfirmasi Perintah${isMultiStep ? ' (' + steps.length + ' langkah)' : ''}</h3>
        <button class="rf-magicfolder-close" id="rfMagicCmdConfirmCancel" title="Batal">×</button>
      </div>
      <div class="rf-magicfolder-body">
        <p class="rf-magicfolder-summary">${summaryText}</p>
        ${allStepsHtml}
      </div>
      <div class="rf-magicfolder-ft">
        <button class="btn btn-g" id="rfMagicCmdConfirmCancelBtn">Batal</button>
        <button class="btn btn-p" id="rfMagicCmdConfirmApply">${isMultiStep ? '✓ Jalankan Semua' : '✓ Jalankan'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const cancel = () => closeMagicFolderModal();
  document.getElementById('rfMagicCmdConfirmCancel').addEventListener('click', cancel);
  document.getElementById('rfMagicCmdConfirmCancelBtn').addEventListener('click', cancel);

  document.getElementById('rfMagicCmdConfirmApply').addEventListener('click', async () => {
    const applyBtn = document.getElementById('rfMagicCmdConfirmApply');
    if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = isMultiStep ? '⏳ Menjalankan...' : '⏳ Menjalankan...'; }
    try {
      const groupType = (currentChip === 'all' || currentChip === 'archive') ? 'prompt' : currentChip;
      // v3.20.43: Use applyMultiStepMagicCommand untuk multi-step, applyMagicCommand untuk single
      let result;
      if (isMultiStep) {
        // refreshFn: refresh vault antar step supaya step 2 bisa lihat folder yang dibuat step 1
        const refreshFn = async () => { await refreshVault(); };
        result = await applyMultiStepMagicCommand(currentVault.items, steps, groupType, refreshFn);
      } else {
        result = await applyMagicCommand(currentVault.items, steps[0], groupType);
        // Wrap single result to match multi-step shape
        result = { ok: result.ok, results: [{ stepIndex: 0, action: steps[0].action, result }], allOk: result.ok };
      }

      if (result.ok) {
        closeMagicFolderModal();
        // v3.20.43: Build toast message dari results
        let toastParts = [];
        let allOk = true;
        for (const r of (result.results || [])) {
          const stepNum = r.stepIndex + 1;
          const res = r.result;
          if (!res.ok) {
            allOk = false;
            toastParts.push(`Langkah ${stepNum}: gagal (${res.error || 'unknown'})`);
            continue;
          }
          if (r.action === 'move' || r.action === 'create-and-move') {
            toastParts.push(`Langkah ${stepNum}: ${res.itemsMoved} item dipindahkan`);
          } else if (r.action === 'archive-folder') {
            toastParts.push(`Langkah ${stepNum}: folder di-arsipkan (${res.archivedCount} item)`);
          } else if (r.action === 'restore-folder') {
            toastParts.push(`Langkah ${stepNum}: folder di-restore (${res.restoredCount} item)`);
          } else if (r.action === 'add-tag') {
            toastParts.push(`Langkah ${stepNum}: tag "${res.tagName}" +${res.itemsTagged} item`);
          } else if (r.action === 'remove-tag') {
            toastParts.push(`Langkah ${stepNum}: tag "${res.tagName}" −${res.itemsUntagged} item`);
          } else if (r.action === 'archive-items') {
            toastParts.push(`Langkah ${stepNum}: ${res.itemsArchived} item diarsipkan`);
          } else if (r.action === 'delete-items') {
            toastParts.push(`Langkah ${stepNum}: ${res.itemsDeleted} item dihapus`);
          }
        }
        // Single step: simpler toast
        if (!isMultiStep && toastParts.length === 1) {
          toast('✓ ' + toastParts[0].replace(/^Langkah \d+: /, ''));
        } else if (allOk) {
          toast('✓ Semua ' + steps.length + ' langkah berhasil');
        } else {
          toast('⚠ Sebagian langkah gagal: ' + toastParts.join('; '), false);
        }
        await refreshVault();
        renderChips();
        renderList();
      } else {
        toast('⚠ Gagal: ' + (result.error || 'unknown'), false);
        if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = isMultiStep ? '✓ Jalankan Semua' : '✓ Jalankan'; }
      }
    } catch (e) {
      toast('⚠ Gagal: ' + e.message, false);
      console.error('[RecallFox/MagicCmd] apply failed:', e);
      if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = isMultiStep ? '✓ Jalankan Semua' : '✓ Jalankan'; }
    }
  });
}

// v3.20.33: Helper — hitung berapa descendant (recursive) di sebuah folder
function countFolderDescendants(items, folderId) {
  if (!folderId) return 0;
  let count = 0;
  const visited = new Set();
  function collect(id) {
    if (visited.has(id)) return;
    visited.add(id);
    for (const it of items) {
      if (it?.source?.parentId === id) {
        count++;
        // Kalau ini sub-folder, recurse
        if (it.source.isGroup) collect(it.id);
      }
    }
  }
  collect(folderId);
  return count;
}

async function handleAiAutoGroup() {
  if (!currentVault?.items?.length) { toast('Vault kosong', false); return; }

  // v3.20.30: Reset regenerate count saat mulai dari tombol Auto.
  // v3.20.31: Reset user instruction juga — mulai fresh.
  _magicFolderRegenerateCount = 0;
  _magicFolderUserInstruction = '';
  await _runMagicFolderProposal();
}

// v3.20.30: Internal — run proposal dengan regenerate count saat ini.
// v3.20.31: Juga pass userInstruction ke aiAutoGroup.
async function _runMagicFolderProposal() {
  // v3.20.30: Pass FULL items (loose + in-folder + folders) supaya aiAutoGroup
  // bisa detect existing folders. aiAutoGroup sendiri yang filter loose items.
  const allItems = currentVault.items.filter(i => !i.archived);
  // Cek loose items minimal 2 (folder/group tidak dihitung)
  const looseCount = allItems.filter(i => !isGroupItem(i) && !getParentId(i)).length;
  if (looseCount < 2) {
    toast('Butuh minimal 2 item loose (belum di folder) untuk grouping', false);
    return;
  }

  // Cek AI configured
  const { isAssistantConfigured } = await import('../lib/assistant.js');
  if (!(await isAssistantConfigured())) {
    toast('⚠ Setup AI Assistant dulu di Pengaturan → AI Assistant', false);
    return;
  }

  showMagicFolderProgressModal(looseCount, _magicFolderRegenerateCount);

  try {
    const { chatWithFallback } = await import('../lib/assistant.js');
    // v3.20.30: Pass options.regenerate supaya AI kasih struktur alternatif.
    // v3.20.31: Pass options.userInstruction supaya AI ikuti ide user.
    const result = await aiAutoGroup(allItems, chatWithFallback, {
      regenerate: _magicFolderRegenerateCount,
      userInstruction: _magicFolderUserInstruction
    });
    if (!result.ok) {
      closeMagicFolderModal();
      const errMap = {
        'too_few_items': 'Item loose terlalu sedikit untuk dikelompokkan',
        'no_chat_fn': 'AI function tidak tersedia',
        'no_valid_json_in_response': 'AI tidak return JSON valid. Coba lagi.',
        'no_valid_groups_in_response': 'AI tidak mengusulkan folder valid. Coba lagi.'
      };
      toast('⚠ ' + (errMap[result.error] || result.error), false);
      return;
    }

    closeMagicFolderModal();
    // v3.20.30: Pass allItems + result.unmovedFolderIds untuk info "tidak dipindah".
    showMagicFolderPreviewModal(result.groups, allItems, result.stats, result.unmovedFolderIds);
  } catch (e) {
    closeMagicFolderModal();
    toast('⚠ Gagal: ' + e.message, false);
    console.error('[RecallFox/MagicFolder] handleAiAutoGroup failed:', e);
  }
}

// v3.20.28: Progress modal — tampilkan saat AI sedang menganalisis
// v3.20.31: Tampilkan badge kalau user instruction aktif.
function showMagicFolderProgressModal(itemCount, regenerateCount) {
  closeMagicFolderModal();  // pastikan tidak ada modal sebelumnya
  const hasInstruction = _magicFolderUserInstruction.trim().length > 0;
  const regenLabel = (regenerateCount > 0 && !hasInstruction)
    ? `<p class="rf-magicfolder-regen-label">🔄 Percobaan ke-${regenerateCount + 1} — AI mencari struktur alternatif</p>`
    : '';
  const instrLabel = hasInstruction
    ? `<p class="rf-magicfolder-instr-active-label">📌 AI mengikuti instruksi struktur yang kamu ketik</p>`
    : '';
  const modal = document.createElement('div');
  modal.id = 'rf-magicfolder-modal';
  modal.className = 'rf-magicfolder-overlay';
  modal.innerHTML = `
    <div class="rf-magicfolder-dialog">
      <div class="rf-magicfolder-progress">
        <div class="rf-magicfolder-spinner"></div>
        <h3>🪄 Magic Folder sedang berpikir...</h3>
        <p>AI membaca konteks ${itemCount} item loose untuk menemukan tema utama dan menyusun struktur folder spesifik.</p>
        <p class="rf-magicfolder-hint">AI bebas menentukan nama folder yang spesifik menggambarkan isi, boleh dengan subfolder, dan bisa pindahkan folder existing.</p>
        ${regenLabel}
        ${instrLabel}
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

// v3.20.31: Render collapsible "Ketik ide struktur sendiri" section.
// Default: collapsed (hidden textarea). Buka kalau user klik header.
// Kalau _magicFolderUserInstruction ada isinya, section auto-expand + tampilkan badge "aktif".
function _renderUserInstructionSection() {
  const hasInstruction = _magicFolderUserInstruction.trim().length > 0;
  const expandedAttr = hasInstruction ? 'open' : '';
  const activeBadge = hasInstruction
    ? '<span class="rf-magicfolder-instr-badge">📌 Instruksi aktif</span>'
    : '';
  return `
    <details class="rf-magicfolder-instr-details" ${expandedAttr}>
      <summary class="rf-magicfolder-instr-summary">
        <span class="rf-magicfolder-instr-chev">▸</span>
        <span>💡 Ketik ide struktur folder sendiri</span>
        ${activeBadge}
      </summary>
      <div class="rf-magicfolder-instr-body">
        <p class="rf-magicfolder-instr-hint">
          Ketik ide struktur folder yang kamu bayangkan. AI akan ikuti kerangka kamu
          tapi tetap baca konteks item untuk nama folder yang pas.
        </p>
        <textarea
          id="rfMagicFolderInstrText"
          class="rf-magicfolder-instr-textarea"
          rows="4"
          placeholder="Contoh: Bikin folder: Frontend (React, Vue), Backend (Node, Express), Lainnya. Atau: Kelompokkan berdasarkan workflow — Planning, Development, Testing."
        >${esc(_magicFolderUserInstruction)}</textarea>
        <div class="rf-magicfolder-instr-actions">
          <button class="btn btn-g rf-magicfolder-instr-clear" id="rfMagicFolderInstrClear" title="Hapus instruksi">🗑️ Hapus</button>
          <button class="btn btn-p rf-magicfolder-instr-apply" id="rfMagicFolderInstrApply" title="Perbarui usulan dengan ide kamu">🪄 Perbarui Usulan</button>
        </div>
      </div>
    </details>
  `;
}

// v3.20.30: Preview modal — checkbox + subfolder + reasoning + existing folders + regenerate button.
function showMagicFolderPreviewModal(groups, allItems, stats, unmovedFolderIds) {
  closeMagicFolderModal();

  // Build folder lookup untuk display existing folder names.
  const folderLookup = new Map();
  allItems.forEach(it => {
    if (isGroupItem(it)) folderLookup.set(it.id, it);
  });

  // Flatten groups untuk display.
  const flatFolders = [];
  function flatten(fs, parentPath) {
    fs.forEach((f, i) => {
      const path = parentPath ? `${parentPath}.${i}` : `${i}`;
      flatFolders.push({
        path,
        name: f.name,
        reasoning: f.reasoning || '',
        itemIds: f.itemIds,
        folderIds: f.folderIds || [],
        children: f.children || [],
        depth: parentPath ? parentPath.split('.').length : 0,
        parentPath: parentPath || null
      });
      if (f.children && f.children.length > 0) {
        flatten(f.children, path);
      }
    });
  }
  flatten(groups, null);

  // Item yang tidak ke-assign.
  const assignedIds = new Set();
  flatFolders.forEach(f => f.itemIds.forEach(id => assignedIds.add(id)));
  const unassignedCount = allItems.filter(it => !isGroupItem(it) && !getParentId(it) && !assignedIds.has(it.id)).length;

  // Render folder row.
  function renderFolderRow(f) {
    const isSub = f.depth > 0;
    const indent = isSub ? 'margin-left:' + (f.depth * 20) + 'px;' : '';
    const icon = isSub ? '📂' : '📁';
    const itemCount = f.itemIds.length;
    const folderCount = f.folderIds.length;

    // Item pills.
    const itemPills = f.itemIds.slice(0, 5).map(id => {
      const it = allItems.find(x => x.id === id);
      return it ? `<span class="rf-magicfolder-item-pill">${esc((it.title || 'Untitled').slice(0, 25))}</span>` : '';
    }).join('');
    const morePill = itemCount > 5 ? `<span class="rf-magicfolder-item-pill rf-magicfolder-more">+${itemCount - 5} item</span>` : '';

    // v3.20.30: Existing folder pills (folder yang akan dipindahkan ke sini).
    const folderPills = f.folderIds.slice(0, 3).map(id => {
      const folder = folderLookup.get(id);
      const name = folder ? (folder.title || 'Untitled').slice(0, 25) : id;
      return `<span class="rf-magicfolder-item-pill rf-magicfolder-folder-pill">📁 ${esc(name)}</span>`;
    }).join('');
    const moreFolderPill = folderCount > 3 ? `<span class="rf-magicfolder-item-pill rf-magicfolder-more">+${folderCount - 3} folder</span>` : '';

    const reasoningHtml = f.reasoning ? `<div class="rf-magicfolder-reasoning">💡 ${esc(f.reasoning)}</div>` : '';
    const subfolderHint = f.children.length > 0 ? `<span class="rf-magicfolder-sub-hint">${f.children.length} subfolder</span>` : '';
    const folderHint = folderCount > 0 ? `<span class="rf-magicfolder-sub-hint">${folderCount} folder existing</span>` : '';

    const itemsSection = (itemPills || morePill || folderPills || moreFolderPill)
      ? `<div class="rf-magicfolder-folder-items">${itemPills}${morePill}${folderPills}${moreFolderPill}</div>`
      : '';

    return `
      <div class="rf-magicfolder-group ${isSub ? 'rf-magicfolder-sub' : ''}" data-folder-path="${f.path}" style="${indent}">
        <div class="rf-magicfolder-group-hd">
          <label class="rf-magicfolder-check-wrap">
            <input type="checkbox" class="rf-magicfolder-check" data-folder-path="${f.path}" checked />
            <span class="rf-magicfolder-check-mark"></span>
          </label>
          <span class="rf-magicfolder-folder-icon">${icon}</span>
          <span class="rf-magicfolder-folder-name">${esc(f.name)}</span>
          ${itemCount > 0 ? `<span class="rf-magicfolder-folder-count">${itemCount} item</span>` : ''}
          ${subfolderHint}
          ${folderHint}
        </div>
        ${reasoningHtml}
        ${itemsSection}
      </div>
    `;
  }

  const foldersHtml = flatFolders.map(renderFolderRow).join('');

  // v3.20.30: Summary dengan info existing folders.
  const subfolderInfo = stats?.hasSubfolders ? ` · ${stats.totalFolders} folder total` : '';
  const movedFoldersInfo = stats?.totalExistingFoldersMoved > 0
    ? ` · ${stats.totalExistingFoldersMoved} folder existing dipindah`
    : '';
  const unmovedInfo = (unmovedFolderIds && unmovedFolderIds.length > 0)
    ? ` · ${unmovedFolderIds.length} folder existing tidak diubah`
    : '';
  const summaryText = `AI mengusulkan <b>${stats?.totalTopLevel || groups.length} top-level folder</b>${subfolderInfo}${movedFoldersInfo}${unmovedInfo} untuk <b>${assignedIds.size} item loose</b>` +
    (unassignedCount > 0 ? `<span class="rf-magicfolder-unassigned">(${unassignedCount} item tidak masuk folder mana pun)</span>` : '');

  const modal = document.createElement('div');
  modal.id = 'rf-magicfolder-modal';
  modal.className = 'rf-magicfolder-overlay';
  modal.innerHTML = `
    <div class="rf-magicfolder-dialog">
      <div class="rf-magicfolder-hd">
        <h3>🪄 Struktur Folder Diusulkan AI</h3>
        <button class="rf-magicfolder-close" id="rfMagicFolderCancel" title="Batal">×</button>
      </div>
      <div class="rf-magicfolder-body">
        <p class="rf-magicfolder-summary">${summaryText}</p>
        <div class="rf-magicfolder-select-all-row">
          <label class="rf-magicfolder-check-wrap rf-magicfolder-select-all">
            <input type="checkbox" id="rfMagicFolderSelectAll" checked />
            <span class="rf-magicfolder-check-mark"></span>
            <span>Pilih semua</span>
          </label>
          <span class="rf-magicfolder-hint-inline">Centang folder yang ingin dibuat.</span>
          <button class="rf-magicfolder-regenerate-btn" id="rfMagicFolderRegenerate" title="Minta AI usulkan struktur lain">
            🔄 Usulan Lain
          </button>
        </div>
        ${_renderUserInstructionSection()}
        <div class="rf-magicfolder-groups">${foldersHtml}</div>
      </div>
      <div class="rf-magicfolder-ft">
        <button class="btn btn-g" id="rfMagicFolderCancelBtn">Batal</button>
        <button class="btn btn-p" id="rfMagicFolderConfirm">✓ Buat Folder Terpilih</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // Wire "Select all" checkbox.
  const selectAll = document.getElementById('rfMagicFolderSelectAll');
  selectAll.addEventListener('change', (e) => {
    document.querySelectorAll('.rf-magicfolder-check').forEach(cb => {
      cb.checked = e.target.checked;
    });
  });

  // Wire individual checkbox.
  document.querySelectorAll('.rf-magicfolder-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const allCbs = document.querySelectorAll('.rf-magicfolder-check');
      const allChecked = Array.from(allCbs).every(c => c.checked);
      selectAll.checked = allChecked;
      const path = cb.dataset.folderPath;
      if (!cb.checked) {
        document.querySelectorAll('.rf-magicfolder-check').forEach(otherCb => {
          if (otherCb.dataset.folderPath.startsWith(path + '.')) {
            otherCb.checked = false;
          }
        });
      } else {
        const parts = path.split('.');
        for (let i = parts.length - 1; i > 0; i--) {
          const parentPath = parts.slice(0, i).join('.');
          const parentCb = document.querySelector(`.rf-magicfolder-check[data-folder-path="${parentPath}"]`);
          if (parentCb && !parentCb.checked) {
            parentCb.checked = true;
          }
        }
      }
    });
  });

  // v3.20.30: Wire regenerate button — minta AI usulan lain.
  document.getElementById('rfMagicFolderRegenerate').addEventListener('click', async () => {
    const regenBtn = document.getElementById('rfMagicFolderRegenerate');
    if (regenBtn) { regenBtn.disabled = true; regenBtn.textContent = '⏳ Mencari...'; }
    _magicFolderRegenerateCount++;
    await _runMagicFolderProposal();
  });

  // v3.20.31: Wire "Perbarui Usulan" button — baca textarea, set userInstruction, re-call.
  const instrApplyBtn = document.getElementById('rfMagicFolderInstrApply');
  if (instrApplyBtn) {
    instrApplyBtn.addEventListener('click', async () => {
      const textarea = document.getElementById('rfMagicFolderInstrText');
      const text = (textarea?.value || '').trim();
      if (!text) {
        toast('⚠ Ketik ide struktur folder dulu', false);
        return;
      }
      if (text.length < 3) {
        toast('⚠ Ide terlalu pendek — ketik minimal 3 karakter', false);
        return;
      }
      _magicFolderUserInstruction = text;
      // Reset regenerate count — ini proposal baru dengan instruksi user.
      _magicFolderRegenerateCount = 0;
      if (instrApplyBtn) { instrApplyBtn.disabled = true; instrApplyBtn.textContent = '⏳ Memperbarui...'; }
      await _runMagicFolderProposal();
    });
  }

  // v3.20.31: Wire "Hapus" button — clear userInstruction, re-call proposal fresh.
  const instrClearBtn = document.getElementById('rfMagicFolderInstrClear');
  if (instrClearBtn) {
    instrClearBtn.addEventListener('click', async () => {
      _magicFolderUserInstruction = '';
      _magicFolderRegenerateCount = 0;
      const textarea = document.getElementById('rfMagicFolderInstrText');
      if (textarea) textarea.value = '';
      if (instrClearBtn) { instrClearBtn.disabled = true; instrClearBtn.textContent = '⏳...'; }
      await _runMagicFolderProposal();
    });
  }

  // v3.20.31: Update chevron rotation saat details toggle.
  const instrDetails = document.querySelector('.rf-magicfolder-instr-details');
  if (instrDetails) {
    const chev = instrDetails.querySelector('.rf-magicfolder-instr-chev');
    const updateChev = () => {
      if (chev) chev.textContent = instrDetails.open ? '▾' : '▸';
    };
    updateChev();  // initial
    instrDetails.addEventListener('toggle', updateChev);
  }

  // Wire cancel buttons
  const cancel = () => closeMagicFolderModal();
  document.getElementById('rfMagicFolderCancel').addEventListener('click', cancel);
  document.getElementById('rfMagicFolderCancelBtn').addEventListener('click', cancel);

  // Wire confirm button
  document.getElementById('rfMagicFolderConfirm').addEventListener('click', async () => {
    const confirmBtn = document.getElementById('rfMagicFolderConfirm');
    const cancelBtn = document.getElementById('rfMagicFolderCancelBtn');
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = '⏳ Menerapkan...'; }
    if (cancelBtn) cancelBtn.disabled = true;

    // Kumpulkan folder yang di-check (path set).
    const checkedPaths = new Set();
    document.querySelectorAll('.rf-magicfolder-check:checked').forEach(cb => {
      checkedPaths.add(cb.dataset.folderPath);
    });

    // Filter groups — hanya folder yang di-check (recursive).
    function filterChecked(fs, parentPath) {
      const result = [];
      fs.forEach((f, i) => {
        const path = parentPath ? `${parentPath}.${i}` : `${i}`;
        if (!checkedPaths.has(path)) return;
        const filtered = { ...f };
        if (f.children && f.children.length > 0) {
          filtered.children = filterChecked(f.children, path);
        } else {
          delete filtered.children;
        }
        result.push(filtered);
      });
      return result;
    }
    const selectedGroups = filterChecked(groups, null);

    if (selectedGroups.length === 0) {
      toast('⚠ Pilih minimal 1 folder untuk dibuat', false);
      if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = '✓ Buat Folder Terpilih'; }
      if (cancelBtn) cancelBtn.disabled = false;
      return;
    }

    const applyResult = await applyMagicFolderGroups(selectedGroups);
    if (applyResult.ok) {
      closeMagicFolderModal();
      const parts = [`${applyResult.groupsCreated} folder dibuat`, `${applyResult.itemsMoved} item dipindah`];
      if (applyResult.foldersMoved > 0) parts.push(`${applyResult.foldersMoved} folder existing dipindah`);
      toast(`✓ ${parts.join(', ')}`);
      await refreshVault();
      renderChips();
      renderList();
    } else {
      toast('⚠ Gagal menerapkan: ' + (applyResult.error || 'unknown'), false);
      if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = '✓ Buat Folder Terpilih'; }
      if (cancelBtn) cancelBtn.disabled = false;
    }
  });
}

// v3.20.30: Apply groups — recursive + handle folderIds (move existing folders).
async function applyMagicFolderGroups(groups) {
  if (!Array.isArray(groups) || groups.length === 0) {
    return { ok: false, error: 'Groups tidak valid' };
  }

  // Snapshot vault sebelum — untuk rollback.
  const vaultBefore = await getVault();
  const vaultBeforeJson = JSON.stringify(vaultBefore);

  let groupsCreated = 0;
  let itemsMoved = 0;
  let foldersMoved = 0;

  try {
    const groupType = (currentChip === 'all' || currentChip === 'archive') ? 'prompt' : currentChip;
    const expandedIds = [];

    // Recursive apply — parent dulu, lalu children dengan parentId.
    async function applyFolder(folder, parentFolderId) {
      const group = createGroup(folder.name, groupType);
      if (parentFolderId) {
        setParentId(group, parentFolderId);
      }
      if (folder.reasoning) {
        if (!group.source) group.source = {};
        group.source.magicFolderReasoning = folder.reasoning;
        group.source.magicFolder = true;
      }
      await addItem(group);
      expandedIds.push(group.id);
      groupsCreated++;

      // Pindahkan loose items ke folder ini.
      for (const itemId of folder.itemIds) {
        const item = vaultBefore.items.find(i => i.id === itemId);
        if (item) {
          const updates = {};
          setParentId(updates, group.id);
          await updateItem(itemId, updates);
          itemsMoved++;
        }
      }

      // v3.20.30: Pindahkan existing folders ke folder ini (via setParentId on folder item).
      if (Array.isArray(folder.folderIds)) {
        for (const folderId of folder.folderIds) {
          const updates = {};
          setParentId(updates, group.id);
          await updateItem(folderId, updates);
          foldersMoved++;
        }
      }

      // Recursive — apply subfolder.
      if (folder.children && folder.children.length > 0) {
        for (const child of folder.children) {
          await applyFolder(child, group.id);
        }
      }
    }

    for (const g of groups) {
      await applyFolder(g, null);
    }

    expandedGroupIds.push(...expandedIds);

    return { ok: true, groupsCreated, itemsMoved, foldersMoved };
  } catch (e) {
    console.error('[RecallFox/MagicFolder] Apply gagal, rollback...', e);
    try {
      const restored = JSON.parse(vaultBeforeJson);
      await saveVault(restored);
      console.log('[RecallFox/MagicFolder] Rollback berhasil — vault restored');
    } catch (rollbackErr) {
      console.error('[RecallFox/MagicFolder] Rollback GAGAL:', rollbackErr);
    }
    return { ok: false, error: e.message || 'Gagal apply structure folder' };
  }
}

// v3.20.28: Close modal helper
function closeMagicFolderModal() {
  const modal = document.getElementById('rf-magicfolder-modal');
  if (modal) modal.remove();
}

function renderList() {
  const list = $('#list');
  if (currentQuery && !currentQuery.startsWith('>')) {
    list.style.display = 'none';
    return;
  }
  list.style.display = '';
  // v3.16.7 #5: Scope banner — tampilkan kalau lagi scoped ke bundle
  let scopeBanner = '';
  if (currentBundleScope) {
    const bundle = currentVault?.bundles?.find(b => b.id === currentBundleScope);
    if (bundle) {
      const memberCount = (bundle.itemIds || []).length;
      scopeBanner = '<div class="scope-banner" style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--primary-soft,rgba(99,102,241,.1));border:1px solid var(--primary,rgba(99,102,241,.3));border-radius:8px;margin-bottom:8px;font-size:11px;color:var(--text-2)">' +
        '<span style="font-size:14px">👁</span>' +
        '<span style="flex:1">Scope: <b style="color:var(--text)">' + esc(bundle.name || 'Bundle') + '</b> · ' + memberCount + ' anggota</span>' +
        '<button id="exitScopeBtn" style="background:none;border:none;color:var(--primary);cursor:pointer;font-size:11px;font-weight:600;padding:4px 8px;border-radius:4px">✕ Exit scope</button>' +
        '</div>';
    }
  }
  const vi = visibleItems();
  if (!vi.length) {
    list.innerHTML = scopeBanner + '<div class="empty"><div class="big">🦊</div>' + (currentBundleScope ? 'Bundle ini kosong atau anggotanya diarsipkan.' : 'Tidak ada item di filter ini.') + '<br><span style="font-size:11px">' + (currentBundleScope ? 'Tambah item ke bundle ini dari halaman utama.' : 'Blok teks di halaman → klik kanan → Simpan ke RecallFox.') + '</span></div>';
    wireExitScope();
    return;
  }
  list.innerHTML = scopeBanner + renderFlatList(vi);
  bindItemClicks();
  // v3.17.1: Wire tree events (expand/collapse + DnD)
  wireVaultEvents();
  // v3.16.7 #5: Wire exit scope button (kalau scope banner ada)
  wireExitScope();
  // v3.11.11 (Issue #1) + v3.11.12 (Sesi 11, Issue #2): Bind batch checkbox handlers.
  // V3.11.12: HANYA bind change handler untuk checkbox itself.
  // Click handler untuk toggle via item body dipindah ke bindItemClicks (return early
  // kalau batch mode aktif) — supaya tidak double-trigger dengan primaryAction (buka viewer).
  if (vaultBatchMode) {
    document.querySelectorAll('.vault-batch-check').forEach(cb => {
      cb.addEventListener('change', (e) => {
        e.stopPropagation();
        const id = cb.dataset.id;
        if (cb.checked) vaultBatchSelected.add(id);
        else vaultBatchSelected.delete(id);
        updateVaultBatchCount();
      });
      // Click di checkbox jangan propagate ke item (supaya tidak trigger primaryAction)
      cb.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    });
  }
}
function bindItemClicks() {
  $$('#list .item').forEach(el => {
    el.addEventListener('click', e => {
      // v3.17.1: Kalau klik group header, jangan trigger primaryAction (expand/collapse sudah di-handle wireTreeEvents)
      // v3.11.12 (Sesi 11, Issue #2): Fix klik checkbox malah buka gambar viewer.
      // User feedback: "ketika klik centang untuk memilih daftar gambar, eh malah
      // buka gambarnya jg jadinya kebanyakan tab."
      // Root cause: bindItemClicks punya click handler yang buka screenshot viewer.
      // Saya tambah click handler untuk toggle checkbox. Karena kedua handler di elemen
      // yang sama, klik item = toggle checkbox DAN buka viewer.
      // Fix: kalau batch mode aktif, return early — biar handler checkbox (di renderList)
      // yang handle. Click di luar checkbox saat batch mode = tidak buka viewer.
      if (vaultBatchMode) {
        // Cek apakah yang diklik adalah checkbox atau tombol aksi (data-* action)
        // Kalau ya, biar handler masing-masing yang handle (stopPropagation sudah ada)
        // Kalau bukan, return early — tidak buka viewer saat batch mode aktif
        const isActionBtn = e.target.closest('[data-link-action],[data-bundle-action],[data-shot-action],[data-file-action],[data-prompt-action],.morebtn,.vault-batch-check');
        if (!isActionBtn) {
          // Klik di area item (bukan tombol aksi) — toggle checkbox kalau ada
          const cb = el.querySelector('.vault-batch-check');
          if (cb) {
            cb.checked = !cb.checked;
            if (cb.checked) vaultBatchSelected.add(cb.dataset.id);
            else vaultBatchSelected.delete(cb.dataset.id);
            updateVaultBatchCount();
          }
          return; // JANGAN buka viewer
        }
        // Kalau klik tombol aksi, biar handler di bawah yang handle
      }
      // v3.19.4 FIX: Kalau klik group/folder header, JANGAN trigger primaryAction.
      // wireVaultEvents sudah handle expand/collapse. Sebelumnya: tidak ada guard
      // → klik folder juga trigger primaryAction → openScreenshotViewer →
      // "Gagal memuat gambar: file_not_found_in_cloud" (folder tidak punya image file).
      if (el.dataset.isGroup === '1') {
        return;
      }
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
        if (action === 'copy') { copyBundle(it.id); return; }
        else if (action === 'scope') {
          // v3.16.7 #5: Scope vault ke bundle ini (workspace proyek)
          currentBundleScope = it.id;
          currentChip = 'all';  // reset chip supaya semua tipe tampil
          currentQuery = '';
          $('#search').value = '';
          renderVault();
          toast('👁 Scope: ' + (it.title || 'Bundle') + ' · ' + (it._bundle?.itemIds?.length || 0) + ' anggota');
          return;
        }
        else if (action === 'inject') {
          // v3.20.46: Sisip bundle — pakai injectBundle (mode insert).
          //   Sebelumnya: logic lama yang filter(i => i.type !== 'link') →
          //   link TIDAK di-sisip. User complain: "Sisip hanya membaca prompt
          //   dan isi file, link TIDAK terbaca".
          //   Sekarang: panggil injectBundle yang pakai getBundleContent(insert)
          //   → prompt→teks, file/link/media→URL. Semua anggota disisipkan.
          injectBundle(it.id);
          return;
        }
      }
      // v3.7.1-FIX: Tombol aksi Screenshot (data-shot-action)
      // v3.12.0 (Fase 7): Document juga pakai data-shot-action="view" — route ke
      // openDocumentViewer (multi-page) kalau type='document'.
      const shotBtn = e.target.closest('[data-shot-action]');
      if (shotBtn) {
        e.stopPropagation();
        const action = shotBtn.dataset.shotAction;
        const it = findItem(el.dataset.id);
        if (!it) return;
        if (action === 'view') {
          if (it.type === 'document') openDocumentViewer(it.id);
          else openScreenshotViewer(it.id);
        } else if (action === 'download') {
          downloadScreenshot(it.id);
        } else if (action === 'inject') {
          // v3.20.47: Sisipkan URL gambar/dokumen ke chat AI
          const url = resolveImageUrl(it);
          if (url) {
            await doInject(url, it.id);
          } else {
            toast('URL cloud belum tersedia. Buka item sheet untuk download.', false);
          }
        }
        return;
      }
      // v3.20.47: Tombol aksi Prompt/Context/Snapshot (data-prompt-action)
      // Standarisasi: Sisip (inject ke active tab) + Salin (clipboard only)
      const promptBtn = e.target.closest('[data-prompt-action]');
      if (promptBtn) {
        e.stopPropagation();
        const action = promptBtn.dataset.promptAction;
        const it = findItem(el.dataset.id);
        if (!it) return;
        if (action === 'inject') {
          // Sisip ke active tab editor — pakai primaryAction yang handle vars + doInject
          console.log('[RecallFox] Sisip clicked for item:', it.id, 'type:', it.type);
          primaryAction(it.id);
        } else if (action === 'copy') {
          // Salin body ke clipboard — TIDAK coba inject
          console.log('[RecallFox] Salin clicked for item:', it.id, 'type:', it.type);
          copyItemBody(it.id);
        }
        return;
      }
      // v3.20.35-dev: Tombol aksi File (data-file-action)
      // v3.20.37-dev: 'copy' langsung kopi isi file (bukan buka sheet)
      const fileBtn = e.target.closest('[data-file-action]');
      if (fileBtn) {
        e.stopPropagation();
        const action = fileBtn.dataset.fileAction;
        const it = findItem(el.dataset.id);
        if (!it) return;
        if (action === 'copy') {
          copyFileContentToClipboard(it.id);
        } else if (action === 'inject') {
          // v3.20.47: Sisipkan isi file ke chat AI
          if (it.body) {
            await doInject(it.body, it.id);
          } else {
            toast('File kosong', false);
          }
        } else if (action === 'sheet') {
          itemSheet(it.id);
        } else if (action === 'download') {
          downloadFileItem(it.id);
        }
        return;
      }
      // v3.20.47: Tombol aksi Prompt/Context/Snapshot (data-prompt-action)
      const promptBtn = e.target.closest('[data-prompt-action]');
      if (promptBtn) {
        e.stopPropagation();
        const action = promptBtn.dataset.promptAction;
        const it = findItem(el.dataset.id);
        if (!it) return;
        if (action === 'inject') {
          // Sisipkan ke AI — pakai primaryAction logic (handles variables, toppings, context)
          await primaryAction(it.id);
        } else if (action === 'copy') {
          // Salin body ke clipboard
          const body = it.body || '';
          if (body) {
            const ok = await _copyTextWithFallback(body);
            if (ok) toast('📋 Disalin ke clipboard (' + body.length + ' karakter)');
            else toast('Gagal salin (clipboard diblokir)', false);
          } else {
            toast('Item ini tidak punya teks untuk disalin', false);
          }
        }
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
  // v3.12.0 (Fase 7): Dokumen multi-halaman → buka multi-page viewer
  if (it.type === 'document') {
    openDocumentViewer(it.id);
    return;
  }
  // v3.20.35-dev: File → buka item sheet (Kopi File, Kopi Link, Download)
  if (it.type === 'file') {
    itemSheet(it.id);
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
// v3.20.21: Port multi-level fallback dari Chrome v3.21.6 (commit 7b8eef1) +
// tambah fallback COPY_TEXT ke content script tab aktif.
// Root cause popout sidebar: navigator.clipboard.writeText di iframe sidebar.html
// bisa gagal karena iframe tidak focused atau Permissions Policy clipboard-write
// disallow. Fallback chain:
//   1. navigator.clipboard.writeText (modern API, paling cepat)
//   2. background COPY_TO_CLIPBOARD (background service worker)
//   3. RF_FORWARD_TO_ACTIVE_TAB COPY_TEXT (content script di top-level page)
//   4. textarea + execCommand('copy') di popup context (last resort)
async function copyLinkToClipboard(it) {
  if (!it) return;
  const url = it.linkUrl || it.body || '';
  if (!url) { toast('Link ini tidak punya URL', false); return; }
  const ok = await _copyTextWithFallback(url);
  if (ok) {
    await incrementUseCount(it.id);
    toast('📋 URL disalin: ' + url.slice(0, 40) + (url.length > 40 ? '…' : ''));
  }
}

// v3.20.47: Salin body prompt/context/snapshot ke clipboard — TIDAK coba inject.
// Dipanggil dari tombol "Salin" (data-prompt-action="copy") di item card.
// Sebelumnya: tombol "Salin" sebenarnya panggil doInject (coba sisip, fallback clipboard).
// User complain: "Salin tidak konsisten — kadang sisip, kadang salin."
// Fix: tombol Salin sekarang HANYA salin ke clipboard, tidak coba inject.
async function copyItemBody(id) {
  const it = findItem(id);
  if (!it) { toast('Item tidak ditemukan', false); return; }
  // Build final body dengan toppings (sama seperti doInject)
  const finalBody = await buildFinalPrompt(it.body || '', it.toppings || []);
  if (!finalBody || finalBody.trim() === '') {
    toast('Item ini tidak punya isi untuk disalin', false);
    return;
  }
  console.log('[RecallFox] copyItemBody: copying', finalBody.length, 'chars to clipboard');
  const ok = await _copyTextWithFallback(finalBody);
  if (ok) {
    await incrementUseCount(it.id);
    const preview = finalBody.slice(0, 40).replace(/\n/g, ' ');
    toast('📋 Disalin: ' + preview + (finalBody.length > 40 ? '…' : ''));
  }
}

// v3.20.21: Helper internal untuk copy text dengan 4-level fallback chain.
// Dipakai oleh copyLinkToClipboard (dan bisa dipakai fungsi copy lain juga).
// Return true kalau berhasil, false kalau gagal semua.
async function _copyTextWithFallback(text) {
  if (!text) return false;

  // Level 1: navigator.clipboard.writeText (modern API)
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e1) {
    console.warn('[RecallFox] Clipboard L1 fail:', e1.message);
  }

  // Level 2: background COPY_TO_CLIPBOARD
  try {
    const res = await browser.runtime.sendMessage({ type: 'COPY_TO_CLIPBOARD', text });
    if (res?.ok) return true;
    console.warn('[RecallFox] Clipboard L2 fail:', res?.error || 'unknown');
  } catch (e2) {
    console.warn('[RecallFox] Clipboard L2 exception:', e2.message);
  }

  // Level 3: RF_FORWARD_TO_ACTIVE_TAB COPY_TEXT (content script di top-level page)
  // Content script di top-level document selalu punya focus → clipboard API reliable.
  // Penting untuk popout sidebar yang jalan di iframe (cross-origin ke parent page).
  try {
    const res = await browser.runtime.sendMessage({
      type: 'RF_FORWARD_TO_ACTIVE_TAB',
      msgType: 'COPY_TEXT',
      text
    });
    if (res?.ok) return true;
    console.warn('[RecallFox] Clipboard L3 fail:', res?.error || 'unknown');
  } catch (e3) {
    console.warn('[RecallFox] Clipboard L3 exception:', e3.message);
  }

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
    console.warn('[RecallFox] Clipboard L4 fail:', e4.message);
    toast('⚠ Gagal salin: ' + (e4.message || 'clipboard tidak tersedia'), false);
    return false;
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

  // v3.16.0 K5: Auto-prepend konteks aktif saat inject prompt.
  // Hanya untuk item type 'prompt' (bukan context/snapshot/link/bundle).
  // Sebelumnya: user harus ingat klik konteks manual tiap chat baru.
  // Sekarang: konteks aktif (maks 3) otomatis di-prepend ke body sebelum inject.
  if (itemId) {
    const item = currentVault.items.find(i => i.id === itemId);
    if (item && item.type === 'prompt') {
      const activeIds = settings.activeContextIds || [];
      if (activeIds.length > 0) {
        const activeContexts = activeIds
          .map(id => currentVault.items.find(i => i.id === id))
          .filter(it => it && it.type === 'context' && it.body);
        if (activeContexts.length > 0) {
          const contextBlock = activeContexts.map(c => {
            const purposeLabel = {
              system: 'Instruksi Sistem', project: 'Konteks Proyek',
              domain: 'Pengetahuan Domain', reference: 'Referensi',
              instruction: 'Instruksi Kerja'
            }[c.contextPurpose] || 'Konteks';
            return '=== ' + purposeLabel + ': ' + (c.title || 'Konteks') + ' ===\n' + c.body;
          }).join('\n\n');
          body = contextBlock + '\n\n=== Prompt ===\n' + body;
          console.log('[RecallFox] doInject: auto-prepended', activeContexts.length, 'active context(s)');
        }
      }
    }
  }

  // v3.16.4: Framing instruction — wrap inject text dengan instruksi singkat
  // supaya AI tahu ini konteks/instruksi, bukan pertanyaan langsung.
  // User feedback (audit kompetitor): "serap konteks ini dulu" — AI jawab
  // lebih akurat kalau tahu bahwa teks yang di-inject adalah konteks/referensi.
  // Hanya untuk context/snapshot/link, dan prompt+context (K5 auto-prepend).
  // Prompt murni (tanpa konteks) tidak di-frame — prompt IS the instruction.
  if (settings.framingEnabled !== false && itemId) {
    const item = currentVault.items.find(i => i.id === itemId);
    if (item) {
      const hasContext = body.startsWith('=== '); // K5 auto-prepend marker
      let prefix = null;
      if (item.type === 'context') prefix = 'Berikut adalah konteks yang perlu Anda pahami sebelum menjawab:\n\n';
      else if (item.type === 'snapshot') prefix = 'Berikut adalah snapshot percakapan AI sebelumnya sebagai referensi:\n\n';
      else if (item.type === 'link') prefix = 'Berikut adalah link referensi yang relevan:\n\n';
      else if (item.type === 'prompt' && hasContext) prefix = 'Berikut adalah konteks yang perlu Anda pahami sebelum menjawab:\n\n';
      if (prefix && !body.startsWith(prefix)) body = prefix + body;
    }
  }

  // v3.16.6: Estimasi token sebelum inject — user tahu berapa token yang dikirim
  const estTokens = Math.ceil(body.length / 4);
  if (estTokens > 500) {
    console.log('[RecallFox] Inject ~' + estTokens + ' tokens (' + body.length + ' chars)');
  }

  try {
    const res = await browser.runtime.sendMessage({ type: 'INJECT_TO_ACTIVE_TAB', text: body, mode });
    if (itemId) await incrementUseCount(itemId);
    if (res?.ok) {
      toast('⚡ Disisipkan' + (currentAiDomain ? ' ke ' + currentAiDomain.name : '') + (estTokens > 500 ? ' (~' + estTokens + ' token)' : ''));
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

// v3.16.8 #7: Lanjutkan snapshot di AI lain — copy snapshot body + buka AI lain di tab baru
// User bisa pindah percakapan dari satu AI ke AI lain dengan konteks yang sama.
async function continueInOtherAI(itemId) {
  const it = currentVault.items.find(i => i.id === itemId);
  if (!it) { toast('Item tidak ditemukan', false); return; }
  if (!it.body || it.body.trim().length === 0) { toast('Snapshot kosong', false); return; }

  // Tentukan AI lain yang bisa dipilih (exclude AI yang sedang aktif di tab saat ini)
  const currentOrigin = currentAiDomain?.url ? new URL(currentAiDomain.url).hostname : '';
  const otherAIs = AI_TOOLS.filter(t => {
    if (!t.url) return false;
    try {
      const toolHost = new URL(t.url).hostname;
      return toolHost !== currentOrigin;
    } catch { return false; }
  });

  if (otherAIs.length === 0) { toast('Tidak ada AI lain tersedia', false); return; }

  // Tampilkan sheet pilih AI
  const sheet = document.createElement('div');
  sheet.className = 'sheet show';
  sheet.innerHTML = `
    <div class="scrim" data-close></div>
    <div class="sheet-card">
      <div class="sheet-h">
        <h3>🔄 Lanjutkan di AI Lain</h3>
        <button class="x" data-close>✕</button>
      </div>
      <div style="padding:8px 16px 4px;font-size:11px;color:var(--text-2);line-height:1.5">
        Snapshot akan disalin ke clipboard, lalu AI yang dipilih akan dibuka di tab baru.
        Paste (Ctrl+V) snapshot ke chat AI tersebut.
      </div>
      <div class="sheet-body" style="max-height:50vh;overflow-y:auto">
        ${otherAIs.map(ai => `
          <button class="act" data-url="${ai.url}" style="display:flex;align-items:center;gap:10px;width:100%;text-align:left">
            <span style="font-size:20px">${ai.emoji || '🤖'}</span>
            <div style="flex:1">
              <div style="font-weight:600;font-size:13px">${ai.name}</div>
              <div style="font-size:11px;color:var(--text-2)">${ai.url}</div>
            </div>
            <span style="font-size:14px;color:var(--primary)">↗</span>
          </button>
        `).join('')}
      </div>
    </div>
  `;
  document.body.appendChild(sheet);

  // Wire close
  sheet.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => sheet.remove()));

  // Wire AI selection
  sheet.querySelectorAll('.act[data-url]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const url = btn.dataset.url;
      try {
        // Copy snapshot body to clipboard
        await navigator.clipboard.writeText(it.body);
        toast('📋 Snapshot disalin. Tab AI akan dibuka — paste (Ctrl+V) ke chat.');
        // Open AI in new tab
        await browser.tabs.create({ url: url });
        sheet.remove();
        // Close popup (sidebar tetap terbuka)
        if (!document.body.classList.contains('rf-sidebar-body')) {
          setTimeout(() => window.close(), 600);
        }
      } catch (e) {
        toast('Gagal: ' + e.message, false);
      }
    });
  });
}

// v3.16.5: Ringkas snapshot dengan AI sebelum inject — hemat token
async function summarizeAndInject(itemId) {
  const it = currentVault.items.find(i => i.id === itemId);
  if (!it) { toast('Item tidak ditemukan', false); return; }
  if (!it.body || it.body.trim().length < 50) { toast('Snapshot terlalu pendek untuk diringkas', false); return; }
  if (!(await isAssistantConfigured())) {
    toast('⚠ Setup AI Assistant dulu di Pengaturan → AI Assistant', false);
    return;
  }
  toast('🤖 Meringkas snapshot dengan AI...');
  try {
    const messages = [
      { role: 'system', content: 'Ringkas percakapan AI berikut dalam poin-poin penting. Sertakan: topik utama, kesimpulan, dan actionable items. Maksimal 200 kata. Tulis dalam bahasa Indonesia.' },
      { role: 'user', content: it.body }
    ];
    const result = await chatWithFallback(messages);
    if (!result?.content) { toast('AI tidak mengembalikan hasil', false); return; }
    const summary = '=== Ringkasan Snapshot: ' + (it.title || 'Snapshot') + ' ===\n' + result.content;
    toast('✓ Ringkasan siap. Menyisipkan...');
    await doInject(summary, itemId);
  } catch (e) {
    console.error('[RecallFox] summarizeAndInject failed:', e);
    toast('Gagal meringkas: ' + e.message, false);
  }
}

async function injectBundle(id) {
  const bundle = currentVault.bundles.find(b => b.id === id);
  if (!bundle) return;
  const items = (bundle.injectOrder || bundle.itemIds || []).map(iid => currentVault.items.find(i => i.id === iid)).filter(Boolean);
  // v3.10.2 (Issue 3 + 5 fix): Sertakan catatan yang tercentang (bundle.noteIds)
  // ke teks bundle saat disalin/disisipkan — sebelumnya noteIds diabaikan.
  const noteIds = Array.isArray(bundle.noteIds) ? bundle.noteIds : [];
  const notes = noteIds.map(nid => currentNotes.find(n => n.id === nid)).filter(Boolean);
  if (items.length === 0 && notes.length === 0) { toast('Bundle kosong', false); return; }
  // v3.20.45: Pakai getBundleContent(item, 'insert') — standarisasi logic.
  //   Sebelumnya: inline logic di injectBundle + vaultBatchCopyBundleAction
  //   yang berbeda-beda → perilaku tidak konsisten.
  //   Sekarang: satu fungsi dengan mode 'insert' | 'copy'.
  //   - insert: prompt→teks, file/link/media→URL
  //   - copy: prompt/file→teks, link/media→URL
  const allParts = items.map(i => {
    const header = '## ' + (i.title || i.type) + ' [' + (TYPE[i.type]?.label || i.type) + ']';
    const content = getBundleContent(i, 'insert');
    return header + '\n' + content;
  });
  // v3.10.2 (Issue 3 + 5 fix): Tambahkan catatan sebagai section terpisah
  for (const n of notes) {
    const noteTitle = n.title || 'Catatan';
    allParts.push('## ' + noteTitle + ' [Catatan]\n' + stripHtmlForPreview(n.body || ''));
  }
  // v3.10.2 (Issue 3 + 5 fix): Tambahkan inline prompt kalau ada
  if (bundle.inlinePrompt && bundle.inlinePrompt.trim()) {
    allParts.unshift('## ' + (bundle.inlinePromptItemId ? (bundle.name || 'Prompt Inline') : 'Prompt Cepat') + ' [Prompt]\n' + bundle.inlinePrompt.trim());
  }
  const fullText = allParts.join('\n\n---\n\n');
  try {
    await navigator.clipboard.writeText(fullText);
    for (const i of items) await incrementUseCount(i.id);
    toast('📋 Bundle disalin ke clipboard (' + (items.length + notes.length) + ' anggota)');
  } catch (e) {
    try {
      await browser.runtime.sendMessage({ type: 'COPY_TO_CLIPBOARD', text: fullText });
      for (const i of items) await incrementUseCount(i.id);
      toast('📋 Bundle disalin ke clipboard (' + (items.length + notes.length) + ' anggota)');
    } catch (e2) {
      toast('⚠ Gagal menyalin bundle', false);
    }
  }
  if (!document.body.classList.contains('rf-sidebar-body')) setTimeout(() => window.close(), 700);
}

// v3.20.45: copyBundle — Salin bundle dengan mode 'copy'.
//   Sama struktur dengan injectBundle, tapi pakai getBundleContent(item, 'copy').
//   Aturan copy: prompt/file→teks (isi), link/media→URL.
//   Dipanggil dari bundle card tombol "Salin ⤴" (data-bundle-action="copy").
async function copyBundle(id) {
  const bundle = currentVault.bundles.find(b => b.id === id);
  if (!bundle) return;
  const items = (bundle.injectOrder || bundle.itemIds || []).map(iid => currentVault.items.find(i => i.id === iid)).filter(Boolean);
  const noteIds = Array.isArray(bundle.noteIds) ? bundle.noteIds : [];
  const notes = noteIds.map(nid => currentNotes.find(n => n.id === nid)).filter(Boolean);
  if (items.length === 0 && notes.length === 0) { toast('Bundle kosong', false); return; }
  const allParts = items.map(i => {
    const header = '## ' + (i.title || i.type) + ' [' + (TYPE[i.type]?.label || i.type) + ']';
    const content = getBundleContent(i, 'copy');
    return header + '\n' + content;
  });
  for (const n of notes) {
    const noteTitle = n.title || 'Catatan';
    allParts.push('## ' + noteTitle + ' [Catatan]\n' + stripHtmlForPreview(n.body || ''));
  }
  if (bundle.inlinePrompt && bundle.inlinePrompt.trim()) {
    allParts.unshift('## ' + (bundle.inlinePromptItemId ? (bundle.name || 'Prompt Inline') : 'Prompt Cepat') + ' [Prompt]\n' + bundle.inlinePrompt.trim());
  }
  const fullText = allParts.join('\n\n---\n\n');
  try {
    await navigator.clipboard.writeText(fullText);
    for (const i of items) await incrementUseCount(i.id);
    toast('📋 Bundle disalin ke clipboard (' + (items.length + notes.length) + ' anggota)');
  } catch (e) {
    try {
      await browser.runtime.sendMessage({ type: 'COPY_TO_CLIPBOARD', text: fullText });
      for (const i of items) await incrementUseCount(i.id);
      toast('📋 Bundle disalin ke clipboard (' + (items.length + notes.length) + ' anggota)');
    } catch (e2) {
      toast('⚠ Gagal menyalin bundle', false);
    }
  }
}

// v3.20.45: getBundleContent — standarisasi logic sisip vs salin bundle.
//   Dipakai oleh injectBundle (mode='insert') + vaultBatchCopyBundleAction (mode='copy').
//
// Aturan (sesuai spec user):
//   - insert (Sisip): prompt→teks, file/link/media→URL
//       AI bisa fetch konten dari URL, hemat token prompt.
//   - copy (Salin): prompt/file→teks (isi), link/media→URL
//       User paste langsung ke chat/AI, konten teks langsung visible.
//
// Field name convention (camelCase lokal, snake_case dari cloud):
//   - prompt/context: item.body (teks prompt)
//   - file: item.gdriveFileUrl || item.gdrive_file_url (URL cloud Storage)
//           fallback: item.body (isi teks, kalau URL belum tersedia)
//   - link: item.linkUrl || item.body (URL)
//   - screenshot/media: item.gdriveFileUrl || item.gdrive_file_url (URL cloud Storage)
//                       fallback: item.source.url (legacy)
//   - snapshot: item.body (teks percakapan)
//   - document: item.gdriveFileUrl || item.gdrive_file_url (URL multi-page)
//   - note: item.body (teks catatan, dipakai di vaultBatchCopyBundleAction)
function getBundleContent(item, mode) {
  if (!item) return '';
  const t = item.type;
  console.log('[RecallFox/Bundle] getBundleContent:', t, 'mode=' + mode, 'id=' + item.id);

  // Helper: resolve cloud URL (file / screenshot / document)
  const cloudUrl = item.gdriveFileUrl || item.gdrive_file_url || (item.source && item.source.url) || '';

  if (mode === 'insert') {
    // SISIP: prompt→teks, file/link/media→URL
    if (t === 'prompt' || t === 'context' || t === 'snapshot') {
      return item.body || '';
    }
    if (t === 'file') {
      if (cloudUrl) return cloudUrl + '\n(File URL — AI bisa fetch isi dari link ini)';
      return '(URL cloud belum tersedia — gunakan Salin untuk isi file)';
    }
    if (t === 'link') {
      return item.linkUrl || item.body || '';
    }
    if (t === 'screenshot' || t === 'media' || t === 'document') {
      if (cloudUrl) return cloudUrl + '\n(Media URL — AI bisa fetch gambar/dokumen dari link ini)';
      return '(URL cloud belum tersedia)';
    }
    // note + unknown → teks
    return item.body || '';
  }

  if (mode === 'copy') {
    // SALIN: prompt/file→teks (isi), link/media→URL
    if (t === 'prompt' || t === 'context' || t === 'snapshot') {
      return item.body || '';
    }
    if (t === 'file') {
      // Salin: isi teks file (bukan URL) — user bisa paste langsung ke chat
      return item.body || '';
    }
    if (t === 'link') {
      return item.linkUrl || item.body || '';
    }
    if (t === 'screenshot' || t === 'media' || t === 'document') {
      // Salin: URL gambar (bukan base64 — terlalu besar untuk clipboard text)
      if (cloudUrl) return cloudUrl;
      return '(URL cloud belum tersedia)';
    }
    // note + unknown → teks
    return item.body || '';
  }

  // Fallback (mode tidak dikenal) → teks
  console.warn('[RecallFox/Bundle] getBundleContent: unknown mode', mode);
  return item.body || '';
}
// v3.12.2: Image modal viewer — in-sidebar overlay (bukan window/tab baru).
// Dipakai untuk screenshot (1 page) DAN dokumen multi-page.
//
// User feedback v3.12.1: "ketika buka multi page viewer itu, addonnya ketutup
// jadi misal mau buka dokumen lain tu saya harus klik terlalu banyak".
// v3.12.1 (versi user) buka viewer.html sebagai tab baru — sidebar Firefox
// persist across tabs jadi sidebar tetap buka, TAPI tetap perlu switch tab.
// v3.12.2: default render modal overlay di document.body sidebar/popup context,
// jadi close modal = list vault tetap visible → klik item lain = 1 klik.
//
// Escape hatch: tombol '↗ Tab baru' di header modal:
//   - Dokumen: tabs.create('popup/viewer.html?id=...') — reuse viewer user v3.12.1
//   - Screenshot: window.open + document.write single image (sederhana)
//
// @param {Object} item - vault item (type='screenshot' atau 'document')
// @param {Array<{dataUrl: string|null}>} pages - array halaman
//   (screenshot: 1 elemen; dokumen: N elemen)
function openImageModalViewer(item, pages) {
  if (!item || !Array.isArray(pages) || pages.length === 0) {
    toast('Tidak ada gambar untuk ditampilkan', false);
    return;
  }
  const validPages = pages.filter(p => p && p.dataUrl);
  if (validPages.length === 0) {
    toast('Gagal memuat semua gambar', false);
    return;
  }

  const title = item.title || (item.type === 'document' ? 'Dokumen' : 'Screenshot');
  const totalPages = validPages.length;
  const isMulti = totalPages > 1;
  const isDoc = item.type === 'document';
  let cur = 0;

  // Hapus modal sebelumnya kalau ada (jangan tumpuk)
  const existing = document.getElementById('rfImageViewerOverlay');
  if (existing) existing.remove();

  // Build modal overlay — pakai class .modal-overlay yang sudah ada di popup.css
  const overlay = document.createElement('div');
  overlay.id = 'rfImageViewerOverlay';
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.style.zIndex = '200'; // di atas modal-overlay biasa (z-index 100)
  overlay.style.padding = '0';

  // Card container — fullscreen dark theme
  const card = document.createElement('div');
  card.className = 'modal';
  card.style.cssText = 'max-width:none;max-height:none;width:100%;height:100%;border-radius:0;background:#0c0a09;color:#fafaf9;display:flex;flex-direction:column';

  // Header
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 14px;background:#1c1917;border-bottom:1px solid #292524;flex:none';

  const iconSpan = document.createElement('span');
  iconSpan.textContent = isDoc ? '📄' : '📸';
  iconSpan.style.fontSize = '16px';

  // v3.14.5 (Sesi 1, Issue #2): In-place edit judul.
  // Sebelumnya: tombol ✏️ → prompt() popup native browser (mengganggu alur kerja).
  // Sekarang: titleSpan (display) + titleInput (edit, hidden by default).
  // Tombol ✏️ toggle mode edit. Saat edit aktif: titleSpan hidden, titleInput visible + focus + select-all.
  // Tombol Simpan / Batal muncul menggantikan tombol lain (newTabBtn, editTitleBtn).
  const titleSpan = document.createElement('span');
  titleSpan.textContent = title;
  titleSpan.style.cssText = 'flex:1;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#fafaf9';

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.value = title;
  titleInput.style.cssText = 'flex:1;font-size:13px;font-weight:600;color:#fafaf9;background:#0c0a09;border:1px solid #6d3df5;border-radius:6px;padding:5px 9px;outline:none;display:none;min-width:0';
  titleInput.setAttribute('aria-label', 'Edit judul');
  // Enter = save, Esc = cancel
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
  });
  // Auto-grow tidak perlu — input text single line cukup.

  // Edit mode state
  let isEditing = false;
  // Cached values for cancel
  let originalTitle = title;
  let originalAnnotation = '';

  // Tombol Simpan (muncul saat edit mode)
  const saveEditBtn = document.createElement('button');
  saveEditBtn.title = 'Simpan judul & anotasi (Enter)';
  saveEditBtn.style.cssText = 'background:#10b981;color:#fff;border:none;padding:5px 12px;border-radius:6px;cursor:pointer;font-size:12px;flex-shrink:0;display:none;font-weight:600';
  saveEditBtn.textContent = '💾 Simpan';
  saveEditBtn.addEventListener('click', commitEdit);

  // Tombol Batal (muncul saat edit mode)
  const cancelEditBtn = document.createElement('button');
  cancelEditBtn.title = 'Batal edit (Esc)';
  cancelEditBtn.style.cssText = 'background:transparent;color:#a8a29e;border:1px solid #44403c;padding:5px 10px;border-radius:6px;cursor:pointer;font-size:12px;flex-shrink:0;display:none';
  cancelEditBtn.textContent = 'Batal';
  cancelEditBtn.addEventListener('click', cancelEdit);

  function enterEditMode() {
    if (isEditing) return;
    isEditing = true;
    originalTitle = titleInput.value;
    originalAnnotation = annotationTextarea.value;
    titleSpan.style.display = 'none';
    titleInput.style.display = '';
    titleInput.focus();
    titleInput.select();
    // Sembunyikan tombol lain, tampilkan Simpan/Batal
    newTabBtn.style.display = 'none';
    editTitleBtn.style.display = 'none';
    saveEditBtn.style.display = '';
    cancelEditBtn.style.display = '';
    // Focus annotation supaya mudah tab
    annotationArea.style.borderTopColor = '#6d3df5';
    annotationTextarea.readOnly = false;
    annotationTextarea.style.background = '#0c0a09';
    annotationTextarea.style.color = '#fafaf9';
    annotationLabel.style.display = '';
  }

  function exitEditMode() {
    isEditing = false;
    titleSpan.style.display = '';
    titleInput.style.display = 'none';
    newTabBtn.style.display = '';
    editTitleBtn.style.display = '';
    saveEditBtn.style.display = 'none';
    cancelEditBtn.style.display = 'none';
    annotationArea.style.borderTopColor = '#292524';
    // Annotation tetap bisa di-edit inline (auto-save on blur) — tidak perlu lock
    annotationTextarea.readOnly = false;
    annotationTextarea.style.background = 'transparent';
    annotationTextarea.style.color = '#d6d3d1';
  }

  async function commitEdit() {
    const newTitle = titleInput.value.trim();
    const newAnnot = annotationTextarea.value.trim();
    if (!newTitle) {
      toast('Judul tidak boleh kosong', false);
      titleInput.focus();
      return;
    }
    // Build patch
    const patch = {};
    if (newTitle !== item.title) patch.title = newTitle;
    // Annotation: dokumen → source.annotationNote; screenshot → top-level annotationNote
    const currentAnnot = item.annotationNote || item.source?.annotationNote || '';
    if (newAnnot !== currentAnnot) {
      if (isDoc) {
        const newSource = { ...(item.source || {}), annotationNote: newAnnot };
        patch.source = newSource;
        patch.annotationNote = newAnnot; // mirror for backward compat
      } else {
        patch.annotationNote = newAnnot;
      }
    }
    if (Object.keys(patch).length === 0) {
      // Tidak ada perubahan
      exitEditMode();
      return;
    }
    try {
      await updateItem(item.id, patch);
      // Update local state
      if (patch.title) {
        item.title = patch.title;
        titleSpan.textContent = patch.title;
        titleInput.value = patch.title;
        // Update option di navigator select
        const opt = selectEl.querySelector('option[value="' + item.id + '"]');
        if (opt) opt.textContent = patch.title.slice(0, 35);
      }
      if (isDoc && patch.source) item.source = patch.source;
      if (patch.annotationNote !== undefined) item.annotationNote = patch.annotationNote;
      toast('✓ Judul & anotasi tersimpan');
      exitEditMode();
    } catch (e) {
      toast('Gagal simpan: ' + e.message, false);
    }
  }

  function cancelEdit() {
    titleInput.value = originalTitle;
    annotationTextarea.value = originalAnnotation;
    exitEditMode();
  }

  // Escape hatch button — buka di tab/viewer besar
  const newTabBtn = document.createElement('button');
  newTabBtn.title = isDoc ? 'Buka viewer halaman penuh di tab baru (sidebar tetap buka)' : 'Buka gambar di tab baru (layar besar)';
  newTabBtn.style.cssText = 'background:#292524;color:#fafaf9;border:1px solid #44403c;padding:5px 9px;border-radius:6px;cursor:pointer;font-size:12px;flex-shrink:0';
  newTabBtn.innerHTML = '↗ Tab baru';
  newTabBtn.addEventListener('click', () => {
    if (isDoc) {
      // Reuse viewer.html user v3.12.1 — handle multi-page + download + open original
      const viewerUrl = browser.runtime.getURL('popup/viewer.html') + '?id=' + encodeURIComponent(item.id);
      browser.tabs.create({ url: viewerUrl }).catch(e => {
        toast('Gagal buka tab: ' + e.message, false);
      });
    } else {
      // Screenshot: buka single image di tab baru (sederhana, tidak butuh viewer.html)
      const w = window.open('');
      if (w) {
        w.document.write('<!DOCTYPE html><title>' + esc(title) + '</title><body style="margin:0;background:#0c0a09;display:flex;align-items:center;justify-content:center;min-height:100vh;"><img src="' + validPages[0].dataUrl + '" style="max-width:100%;max-height:100vh;" /></body>');
        w.document.close();
      }
    }
    closeViewer();
  });

  const closeBtn = document.createElement('button');
  closeBtn.title = 'Tutup (Esc)';
  closeBtn.style.cssText = 'background:transparent;color:#a8a29e;border:none;width:28px;height:28px;border-radius:6px;cursor:pointer;display:grid;place-items:center;flex-shrink:0';
  closeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  closeBtn.addEventListener('click', closeViewer);

  header.appendChild(iconSpan);
  header.appendChild(titleSpan);
  header.appendChild(titleInput);
  if (isMulti) {
    const countSpan = document.createElement('span');
    countSpan.textContent = totalPages + ' halaman';
    countSpan.style.cssText = 'font-size:11px;color:#a8a29e;flex-shrink:0';
    header.appendChild(countSpan);
  }
  header.appendChild(saveEditBtn);
  header.appendChild(cancelEditBtn);
  header.appendChild(newTabBtn);
  header.appendChild(closeBtn);

  // Body — image area
  const body = document.createElement('div');
  body.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center;padding:14px;overflow:auto;min-height:0';

  const img = document.createElement('img');
  img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;border-radius:6px;box-shadow:0 4px 24px rgba(0,0,0,0.6)';
  img.alt = title;
  body.appendChild(img);

  // v3.14.5 (Sesi 1, Issue #2b): Field anotasi inline di area viewer.
  // Sebelumnya: anotasi harus diedit via sheet terpisah (openAnnotationNoteSheet).
  // Sekarang: textarea collapsible di antara body dan footer nav.
  // Auto-save on blur (debounced) + tombol Simpan eksplisit di header (saat edit mode aktif).
  const annotationArea = document.createElement('div');
  annotationArea.style.cssText = 'flex:none;background:#1c1917;border-top:1px solid #292524;padding:8px 14px;display:flex;flex-direction:column;gap:4px;max-height:120px';

  const annotationLabel = document.createElement('label');
  annotationLabel.textContent = '📝 Anotasi / Catatan';
  annotationLabel.style.cssText = 'font-size:10.5px;color:#a8a29e;font-weight:600;letter-spacing:.02em;display:none'; // show only in edit mode
  annotationArea.appendChild(annotationLabel);

  const annotationTextarea = document.createElement('textarea');
  const existingAnnot = item.annotationNote || item.source?.annotationNote || '';
  annotationTextarea.value = existingAnnot;
  annotationTextarea.placeholder = 'Klik untuk tambah anotasi / catatan untuk gambar ini… (auto-save saat blur)';
  annotationTextarea.rows = 2;
  annotationTextarea.style.cssText = 'width:100%;resize:vertical;min-height:36px;max-height:100px;background:transparent;color:#d6d3d1;border:1px solid #44403c;border-radius:6px;padding:6px 9px;font-family:inherit;font-size:11.5px;line-height:1.5;outline:none;flex:1';
  annotationTextarea.setAttribute('aria-label', 'Anotasi / catatan untuk gambar ini');
  annotationTextarea.readOnly = false; // always editable (auto-save on blur)
  // Auto-save on blur
  annotationTextarea.addEventListener('blur', async () => {
    const newAnnot = annotationTextarea.value.trim();
    const currentAnnot = item.annotationNote || item.source?.annotationNote || '';
    if (newAnnot === currentAnnot) return; // no change
    try {
      if (isDoc) {
        const newSource = { ...(item.source || {}), annotationNote: newAnnot };
        await updateItem(item.id, { source: newSource, annotationNote: newAnnot });
        item.source = newSource;
      } else {
        await updateItem(item.id, { annotationNote: newAnnot });
      }
      item.annotationNote = newAnnot;
      toast('✓ Anotasi tersimpan');
    } catch (e) {
      toast('Gagal simpan anotasi: ' + e.message, false);
    }
  });
  annotationArea.appendChild(annotationTextarea);


  // Dots (only if multi-page)
  let dotsWrap = null;
  if (isMulti) {
    dotsWrap = document.createElement('div');
    dotsWrap.style.cssText = 'display:flex;gap:6px;justify-content:center;padding:6px 0;flex-wrap:wrap;max-width:100%;background:#1c1917';
    validPages.forEach((_, i) => {
      const dot = document.createElement('span');
      dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#44403c;cursor:pointer;transition:background 0.15s';
      if (i === 0) dot.style.background = '#fafaf9';
      dot.title = 'Halaman ' + (i + 1);
      dot.addEventListener('click', () => render(i));
      dotsWrap.appendChild(dot);
    });
  }

  // Footer — nav buttons + indicator
  // v3.14.5 FIX (Sesi 1, Issue #1 dari Google Doc): Selalu tampilkan footer nav halaman,
  // bahkan saat single-page. Sebelumnya: isMulti=false → footer hanya tampilkan hint text
  // → layout berubah saat user switch dokumen via dropdown item (kotak hijau).
  // Sekarang: prev/next/ind selalu dirender, hanya disabled saat 1 halaman.
  // Konteks: "SaAT USER PILIH DOKUMEN LAIN VIA DROPDOWN, NAV HALAMAN INTERNAL HILANG".
  // Penyebab: dokumen baru mungkin single-page (screenshot) → footer nav halaman disembunyikan.
  // Solusi: konsistensi layout — footer nav selalu ada, state disabled mengikuti jumlah halaman.
  const footer = document.createElement('div');
  footer.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:12px;padding:8px 14px;background:#1c1917;border-top:1px solid #292524;flex:none';

  const prevBtn = document.createElement('button');
  prevBtn.textContent = '◀ Prev';
  prevBtn.style.cssText = 'background:#292524;color:#fafaf9;border:1px solid #44403c;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px';
  prevBtn.disabled = true; // disabled at page 0 (or single-page)
  prevBtn.addEventListener('click', () => { if (cur > 0) render(cur - 1); });

  const ind = document.createElement('span');
  ind.style.cssText = 'font-size:12px;min-width:70px;text-align:center;color:#d6d3d1';

  const nextBtn = document.createElement('button');
  nextBtn.textContent = 'Next ▶';
  nextBtn.style.cssText = 'background:#292524;color:#fafaf9;border:1px solid #44403c;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px';
  nextBtn.disabled = (totalPages <= 1);
  nextBtn.addEventListener('click', () => { if (cur < totalPages - 1) render(cur + 1); });

  footer.appendChild(prevBtn);
  footer.appendChild(ind);
  footer.appendChild(nextBtn);


  // Assemble
  card.appendChild(header);
  card.appendChild(body);
  card.appendChild(annotationArea); // v3.14.5: anotasi inline antara body & dots
  if (dotsWrap) card.appendChild(dotsWrap);
  card.appendChild(footer);

  // v3.14.7: REWRITE tombol copy sesuai spec user (Sesi 1 follow-up #2).
  // Spec:
  //   1. Salin Gambar       — Salin gambar saja ke clipboard
  //                          (multi-page: composite grid bernomor via buildCompositeImage)
  //   2. Salin + Keterangan — Gambar + URL, judul, waktu, mode
  //                          (multi-page: composite grid + caption gabungan via buildBatchCaption-style)
  //   3. Salin Teks Metadata — Teks saja (judul, waktu, URL) - paste ke WA/Gemini/AI chat
  //                          (multi-page: gabungan caption semua halaman, tanpa gambar)
  //
  // Sebelumnya (v3.13.7–v3.14.6): 3 tombol "📋 Hal Ini / 📚 Semua / 📋 + Keterangan" yang
  // membingungkan karena "Hal Ini" hanya copy page aktif, "Semua" hanya muncul untuk multi-page,
  // dan "Keterangan" redundant dengan "Hal Ini". User bilang masih tidak berfungsi.
  //
  // Logika baru:
  //   - Single-page (screenshot atau dokumen 1 hal): 3 tombol tetap, masing-masing copy
  //     (gambar saja / gambar+caption / teks saja).
  //   - Multi-page (dokumen 2+ halaman): 3 tombol sama, tapi "Salin Gambar" dan "Salin + Keterangan"
  //     otomatis composite semua halaman jadi 1 gambar grid bernomor (pattern sama dengan batch
  //     copy di vault — pakai buildCompositeImage). "Salin Teks Metadata" gabungkan caption
  //     semua halaman jadi 1 teks.
  //   - Tidak ada lagi tombol "Hal Ini" yang hanya copy 1 page — semua tombol selalu operasi
  //     seluruh dokumen (lebih intuitif).
  const copyFooter = document.createElement('div');
  copyFooter.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:8px;padding:8px 14px;background:#1c1917;border-top:1px solid #292524;flex:none;flex-wrap:wrap';

  // v3.17.0: makeCopyBtn sekarang kirim reference tombol ke onClick supaya
  // handler bisa panggil flashButtonFeedback(btn, msg, ok) untuk feedback visual.
  // onClick signature: async (btn) => { ...; flashButtonFeedback(btn, '✓ Tersalin!', true); }
  const makeCopyBtn = (label, title, onClick) => {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.title = title;
    btn.style.cssText = 'background:#292524;color:#fafaf9;border:1px solid #44403c;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:11px;transition:background .15s, border-color .15s';
    btn.addEventListener('click', () => onClick(btn));
    return btn;
  };

  // Helper: blob → dataURL (untuk composite image dari buildCompositeImage)
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('filereader_failed'));
      reader.readAsDataURL(blob);
    });
  }

  // Helper: validasi semua page punya dataUrl (komposit butuh semua termuat)
  function getAllPageDataUrls() {
    return validPages.map(p => p?.dataUrl).filter(Boolean);
  }

  // Helper: build screenshots array untuk buildCompositeImage / buildBatchCaption
  function buildScreenshotsArray() {
    return validPages.map((p, i) => ({ item, dataUrl: p?.dataUrl, pageIdx: i }));
  }

  // ===== Tombol 1: Salin Gambar (image only) =====
  // Single-page: copy page tersebut langsung.
  // Multi-page: composite grid bernomor via buildCompositeImage (pattern vault batch copy).
  //
  // v3.14.8: Pakai helper baru writeImageOnlyToClipboard (bukan writeScreenshotToClipboard
  // dengan textHtml=''). Sebelumnya, textHtml='' menyebabkan strategi 2 di writeScreenshotToClipboard
  // SKIP (falsy check), sehingga kalau strategi 1 gagal (gesture expired untuk multi-page,
  // atau empty text/html Blob ditolak), hanya fallback ke strategi 3 (writeText label pendek).
  // User lihat cuma teks "Laporan Bulanan (3 halaman)" → dianggap "tidak berfungsi".
  // Helper baru punya 3 strategi yang fokus image-only: A) ClipboardItem image/png only,
  // B) text/html dengan <img src="dataUrl"> embedded, C) writeText dataUrl (last resort).
  copyFooter.appendChild(makeCopyBtn(
    '🖼️ Salin Gambar',
    isMulti ? 'Salin semua halaman jadi 1 gambar (grid bernomor)' : 'Salin gambar saja ke clipboard',
    async (btn) => {
      const dataUrls = getAllPageDataUrls();
      if (dataUrls.length === 0) {
        showViewerToast('Halaman belum termuat — tunggu sebentar lalu coba lagi', false);
        flashButtonFeedback(btn, '✗ Belum termuat', false);
        return;
      }
      flashButtonFeedback(btn, '⏳ Menyalin...', true, 60000);
      showViewerToast(isMulti ? '🖼️ Menggabungkan ' + dataUrls.length + ' halaman jadi 1 gambar...' : '📋 Menyalin gambar...');
      try {
        let targetDataUrl;
        if (isMulti && dataUrls.length > 1) {
          // Composite grid bernomor — pattern sama dengan vault batch copy
          const screenshots = buildScreenshotsArray();
          const compositeResult = await buildCompositeImage(screenshots);
          if (!compositeResult.blob) {
            showViewerToast('Gagal membuat gambar gabungan: ' + (compositeResult.error || 'unknown'), false);
            flashButtonFeedback(btn, '✗ Gagal', false);
            return;
          }
          targetDataUrl = await blobToDataUrl(compositeResult.blob);
        } else {
          // Single-page — pakai page aktif (atau page 0 kalau validPages hanya 1)
          targetDataUrl = validPages[cur]?.dataUrl || dataUrls[0];
        }
        // v3.14.8: Pakai writeImageOnlyToClipboard (image-only, 3 strategi robust).
        const result = await writeImageOnlyToClipboard(targetDataUrl);
        if (result.ok) {
          let msg;
          if (result.fallback === 'html_embedded') {
            msg = '✓ Gambar tersalin — paste ke Google Docs/Gmail';
          } else if (result.fallback === 'data_url_text') {
            msg = '✓ Data URL tersalin (text-only)';
          } else {
            msg = isMulti
              ? '✓ ' + dataUrls.length + ' halaman tersalin (1 gambar gabungan) — paste ke WA/Telegram/Docs'
              : '✓ Gambar tersalin — paste ke WA/Telegram/Docs';
          }
          showViewerToast(msg, true);
          flashButtonFeedback(btn, '✓ Tersalin!', true);
        } else {
          console.error('[RecallFox] Salin Gambar failed:', result);
          showViewerToast('Gagal salin gambar: ' + (result.error || 'unknown'), false);
          flashButtonFeedback(btn, '✗ Gagal', false);
        }
      } catch (e) {
        console.error('[RecallFox] Salin Gambar exception:', e);
        showViewerToast('Gagal salin: ' + e.message, false);
        flashButtonFeedback(btn, '✗ Error', false);
      }
    }
  ));

  // ===== Tombol 2: Salin + Keterangan (image + caption) =====
  // Single-page: page aktif + caption (buildScreenshotCaption / buildDocumentCaption).
  // Multi-page: composite grid bernomor + caption gabungan (buildBatchCaption-style untuk
  // document multi-page — iterate setiap halaman dengan index).
  copyFooter.appendChild(makeCopyBtn(
    '📋 Salin + Keterangan',
    isMulti ? 'Gambar gabungan + keterangan semua halaman (URL, judul, waktu)' : 'Gambar + URL, judul, waktu, mode',
    async (btn) => {
      const dataUrls = getAllPageDataUrls();
      if (dataUrls.length === 0) {
        showViewerToast('Halaman belum termuat — tunggu sebentar lalu coba lagi', false);
        flashButtonFeedback(btn, '✗ Belum termuat', false);
        return;
      }
      flashButtonFeedback(btn, '⏳ Menyalin...', true, 60000);
      showViewerToast(isMulti ? '📋 Menggabungkan ' + dataUrls.length + ' halaman + keterangan...' : '📋 Menyalin gambar + keterangan...');
      try {
        let targetDataUrl, cap;
        if (isMulti && dataUrls.length > 1) {
          // Composite grid bernomor
          const screenshots = buildScreenshotsArray();
          const compositeResult = await buildCompositeImage(screenshots);
          if (!compositeResult.blob) {
            showViewerToast('Gagal membuat gambar gabungan: ' + (compositeResult.error || 'unknown'), false);
            flashButtonFeedback(btn, '✗ Gagal', false);
            return;
          }
          targetDataUrl = await blobToDataUrl(compositeResult.blob);
          // Caption gabungan: iterate setiap halaman sebagai "page" dengan index.
          // Pattern sama dengan buildBatchCaption (screenshots) tapi untuk pages dalam 1 dokumen.
          // Untuk dokumen multi-page: pakai buildDocumentCaption per halaman dengan currentPage.
          // Untuk screenshot multi-page (jarang tapi mungkin): pakai buildScreenshotCaption.
          const parts = [];
          const htmlParts = [];
          for (let i = 0; i < validPages.length; i++) {
            const pageDataUrl = validPages[i]?.dataUrl;
            const pageIdx = i + 1;
            const c = isDoc
              ? buildDocumentCaption(item, pageDataUrl, { currentPage: pageIdx, index: pageIdx })
              : buildScreenshotCaption(item, pageDataUrl, { index: pageIdx });
            parts.push(c.textPlain + '\n\n[' + (isDoc ? '📄' : '📸') + ' Halaman ' + pageIdx + ']');
            htmlParts.push(c.textHtml);
          }
          const now = new Date();
          const dateStr = now.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
          const headerTitle = isDoc ? '📄 Dokumen — ' + (item.title || 'Untitled') : '📷 Screenshot Bundle — RecallFox';
          cap = {
            textPlain: '# ' + headerTitle + '\nTanggal: ' + dateStr + ' · Total: ' + validPages.length + ' halaman\n\n'
              + parts.join('\n\n---\n\n') + '\n\n— Ditangkap oleh RecallFox —',
            textHtml: '<div style="font-family:-apple-system,system-ui,sans-serif;font-size:13px;color:#1c1917">'
              + '<h1 style="margin:0 0 6px">' + esc(headerTitle) + '</h1>'
              + '<p style="margin:0 0 10px;color:#57534e"><em>Tanggal: ' + esc(dateStr) + ' · Total: ' + validPages.length + ' halaman</em></p>'
              + htmlParts.join('<hr style="border:none;border-top:1px solid #e7e5e4;margin:16px 0">')
              + '</div>'
          };
        } else {
          // Single-page
          targetDataUrl = validPages[cur]?.dataUrl || dataUrls[0];
          cap = isDoc
            ? buildDocumentCaption(item, targetDataUrl, { currentPage: cur + 1 })
            : buildScreenshotCaption(item, targetDataUrl);
        }
        const result = await writeScreenshotToClipboard(targetDataUrl, cap.textPlain, cap.textHtml);
        if (result.ok) {
          const msg = result.fallback === 'text_only'
            ? '✓ Keterangan tersalin (text-only — gambar tidak ikut)'
            : (isMulti ? '✓ ' + dataUrls.length + ' halaman + keterangan tersalin' : '✓ Gambar + keterangan tersalin');
          showViewerToast(msg, true);
          flashButtonFeedback(btn, '✓ Tersalin!', true);
        } else {
          console.error('[RecallFox] Salin + Keterangan failed:', result);
          showViewerToast('Gagal salin: ' + (result.error || 'unknown'), false);
          flashButtonFeedback(btn, '✗ Gagal', false);
        }
      } catch (e) {
        console.error('[RecallFox] Salin + Keterangan exception:', e);
        showViewerToast('Gagal salin: ' + e.message, false);
        flashButtonFeedback(btn, '✗ Error', false);
      }
    }
  ));

  // ===== Tombol 3: Salin Teks Metadata (text only, no image) =====
  // Single-page: caption textPlain saja.
  // Multi-page: gabungan caption semua halaman.
  // Pattern sama dengan vaultBatchCopyMetaAction — navigator.clipboard.writeText(textPlain).
  copyFooter.appendChild(makeCopyBtn(
    '📝 Salin Teks Metadata',
    isMulti ? 'Teks saja (judul, waktu, semua halaman) - paste ke WA/Gemini/AI chat' : 'Teks saja (judul, waktu, URL) - paste ke WA/Gemini/AI chat',
    async (btn) => {
      const dataUrls = getAllPageDataUrls();
      if (dataUrls.length === 0) {
        showViewerToast('Halaman belum termuat — tunggu sebentar lalu coba lagi', false);
        flashButtonFeedback(btn, '✗ Belum termuat', false);
        return;
      }
      flashButtonFeedback(btn, '⏳ Menyalin...', true, 60000);
      showViewerToast('📝 Menyalin teks metadata...');
      try {
        let textPlain;
        if (isMulti && dataUrls.length > 1) {
          // Gabungan caption semua halaman — tanpa gambar (dataUrl=null)
          const parts = [];
          for (let i = 0; i < validPages.length; i++) {
            const pageIdx = i + 1;
            const c = isDoc
              ? buildDocumentCaption(item, null, { currentPage: pageIdx, index: pageIdx })
              : buildScreenshotCaption(item, null, { index: pageIdx });
            if (c.textPlain) parts.push(c.textPlain);
          }
          const now = new Date();
          const dateStr = now.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
          const headerTitle = isDoc ? '📄 Dokumen — ' + (item.title || 'Untitled') : '📷 Screenshot Bundle — RecallFox';
          textPlain = '# ' + headerTitle + '\nTanggal: ' + dateStr + ' · Total: ' + validPages.length + ' halaman\n\n'
            + parts.join('\n\n---\n\n') + '\n\n— Ditangkap oleh RecallFox —';
        } else {
          // Single-page
          const c = isDoc
            ? buildDocumentCaption(item, null, { currentPage: cur + 1 })
            : buildScreenshotCaption(item, null);
          textPlain = c.textPlain;
        }
        if (!textPlain) {
          showViewerToast('Tidak ada metadata untuk disalin', false);
          flashButtonFeedback(btn, '✗ Kosong', false);
          return;
        }
        // Text-only: langsung navigator.clipboard.writeText (tidak pakai writeScreenshotToClipboard
        // karena tidak ada image yang perlu di-clip).
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(textPlain);
          showViewerToast('✓ Teks metadata tersalin (paste ke WA/Gemini/AI chat)', true);
          flashButtonFeedback(btn, '✓ Tersalin!', true);
        } else {
          // Fallback: delegate ke background
          await browser.runtime.sendMessage({ type: 'COPY_TO_CLIPBOARD', text: textPlain });
          showViewerToast('✓ Teks metadata tersalin', true);
          flashButtonFeedback(btn, '✓ Tersalin!', true);
        }
      } catch (e) {
        console.error('[RecallFox] Salin Teks Metadata exception:', e);
        showViewerToast('Gagal salin teks: ' + e.message, false);
        flashButtonFeedback(btn, '✗ Error', false);
      }
    }
  ));

  card.appendChild(copyFooter);

  // v3.14.4: Navigator bar — prev/next/select untuk pindah antar vault item
  const navBar = document.createElement('div');
  navBar.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 10px;background:#1c1917;border-top:1px solid #292524;flex:none';

  // Get all screenshot+document items for navigator
  const navItems = (currentVault.items || []).filter(i => (i.type === 'screenshot' || i.type === 'document') && !i.archived);
  const currentNavIdx = navItems.findIndex(i => i.id === item.id);

  const prevItemBtn = document.createElement('button');
  prevItemBtn.textContent = '◀';
  prevItemBtn.style.cssText = 'background:#292524;color:#fafaf9;border:1px solid #44403c;padding:5px 10px;border-radius:6px;cursor:pointer;font-size:12px;flex:none';
  prevItemBtn.disabled = (currentNavIdx <= 0);
  if (prevItemBtn.disabled) prevItemBtn.style.opacity = '0.4';
  prevItemBtn.addEventListener('click', () => {
    // v3.14.6: Pakai openViewerById (dispatcher) — bukan openScreenshotViewer.
    // Sebelumnya: dokumen multi-page dipanggil sebagai screenshot → hanya page 0 dimuat.
    if (currentNavIdx > 0) { closeViewer(); openViewerById(navItems[currentNavIdx - 1].id); }
  });

  const selectEl = document.createElement('select');
  selectEl.style.cssText = 'flex:1;padding:5px 6px;background:#0E182A;color:#E8EEF7;border:1px solid #44403c;border-radius:6px;font-size:11px;min-width:0';
  navItems.forEach((it, i) => {
    const opt = document.createElement('option');
    opt.value = it.id;
    opt.textContent = (it.title || 'Untitled').slice(0, 35);
    if (i === currentNavIdx) opt.selected = true;
    selectEl.appendChild(opt);
  });
  selectEl.addEventListener('change', () => {
    // v3.14.6: Pakai openViewerById (dispatcher) — bukan openScreenshotViewer.
    // Bug A fix: dokumen multi-page harus lewat openDocumentViewer untuk fetch semua pages.
    closeViewer(); openViewerById(selectEl.value);
  });

  const nextItemBtn = document.createElement('button');
  nextItemBtn.textContent = '▶';
  nextItemBtn.style.cssText = 'background:#292524;color:#fafaf9;border:1px solid #44403c;padding:5px 10px;border-radius:6px;cursor:pointer;font-size:12px;flex:none';
  nextItemBtn.disabled = (currentNavIdx >= navItems.length - 1);
  if (nextItemBtn.disabled) nextItemBtn.style.opacity = '0.4';
  nextItemBtn.addEventListener('click', () => {
    // v3.14.6: Pakai openViewerById (dispatcher) — bukan openScreenshotViewer.
    if (currentNavIdx < navItems.length - 1) { closeViewer(); openViewerById(navItems[currentNavIdx + 1].id); }
  });

  navBar.appendChild(prevItemBtn);
  navBar.appendChild(selectEl);
  navBar.appendChild(nextItemBtn);
  card.appendChild(navBar);

  // v3.14.5: Edit title button in header — sekarang toggle in-place edit mode (bukan prompt popup).
  // Sebelumnya (v3.14.4): pakai prompt('Edit judul:', ...) yang mengganggu alur kerja.
  // Sekarang: panggil enterEditMode() yang menampilkan titleInput inline + tombol Simpan/Batal.
  const editTitleBtn = document.createElement('button');
  editTitleBtn.title = 'Edit judul & anotasi (in-place)';
  editTitleBtn.style.cssText = 'background:#292524;color:#a8a29e;border:1px solid #44403c;padding:4px 8px;border-radius:6px;cursor:pointer;font-size:12px;flex-shrink:0';
  editTitleBtn.textContent = '✏️';
  editTitleBtn.addEventListener('click', enterEditMode);
  header.appendChild(editTitleBtn);
  // Re-append newTabBtn + closeBtn after editTitleBtn
  header.appendChild(newTabBtn);
  header.appendChild(closeBtn);

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  // Prevent body scroll saat modal buka
  document.body.style.overflow = 'hidden';

  function render(i) {
    cur = i;
    const p = validPages[i];
    if (p && p.dataUrl) {
      img.src = p.dataUrl;
      img.style.display = '';
    } else {
      img.style.display = 'none';
    }
    // v3.14.5: Selalu update nav state — single-page → "Hal 1/1" dengan tombol disabled.
    // Sebelumnya hanya update jika isMulti, jadi saat switch ke single-page, ind tetap kosong.
    if (ind) ind.textContent = 'Hal ' + (i + 1) + '/' + totalPages;
    if (prevBtn) prevBtn.disabled = (i === 0);
    if (nextBtn) nextBtn.disabled = (i === totalPages - 1);
    if (dotsWrap) {
      Array.from(dotsWrap.children).forEach((d, k) => {
        d.style.background = (k === i) ? '#fafaf9' : '#44403c';
      });
    }
  }

  function closeViewer() {
    if (overlay.parentNode) overlay.remove();
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeViewer(); }
    else if (isMulti && e.key === 'ArrowLeft' && cur > 0) { e.preventDefault(); render(cur - 1); }
    else if (isMulti && e.key === 'ArrowRight' && cur < totalPages - 1) { e.preventDefault(); render(cur + 1); }
  }

  // Click overlay (di luar card) = close
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeViewer();
  });

  document.addEventListener('keydown', onKey);

  // Initial render
  render(0);
}

// v3.13.7: Helper untuk load image di composite copy (semua halaman)
function loadImageForComposite(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// v3.12.2: openScreenshotViewer sekarang pakai modal in-sidebar (bukan window baru).
// Sebelumnya (v3.11+): window.open + document.write single image → sidebar ketutup.
// Sekarang: prefetch dataUrl via GET_SCREENSHOT_BLOB → openImageModalViewer 1 page.
// API publik tetap sama (dipanggil dari bindItemClicks & primaryAction).
function openScreenshotViewer(id) {
  const item = currentVault.items.find(i => i.id === id);
  if (!item) { toast('Item tidak ditemukan', false); return; }
  // v3.19.4: Guard — jangan buka viewer untuk group/folder items.
  // Folder items punya type=screenshot tapi source.isGroup=true — mereka
  // container virtual, bukan image. Buka viewer → "file_not_found_in_cloud".
  if (isGroupItem(item)) {
    console.warn('[RecallFox] openScreenshotViewer: skip group item:', id);
    return;
  }
  toast('📸 Memuat gambar...');
  browser.runtime.sendMessage({ type: 'GET_SCREENSHOT_BLOB', id }).then(res => {
    if (res?.ok && res.dataUrl) {
      openImageModalViewer(item, [{ dataUrl: res.dataUrl }]);
    } else {
      // v3.13.4: Tampilkan error teknis supaya user/dev bisa diagnose.
      // Sebelumnya hanya "Gagal memuat gambar" — tidak jelas apakah no_cloud_url,
      // http_404, filereader_failed, dll.
      const errMsg = res?.error || 'unknown';
      console.error('[RecallFox] openScreenshotViewer failed:', id, errMsg);
      toast('Gagal memuat gambar: ' + errMsg, false);
    }
  }).catch(e => {
    console.error('[RecallFox] openScreenshotViewer sendMessage exception:', e.message);
    toast('Gagal memuat gambar: ' + e.message, false);
  });
}

// v3.12.0 (Fase 7): Multi-page document viewer.
// v3.12.1 FIX (user): Viewer lama pakai window.open + document.write + inline script
// dengan base64 JSON besar → image tidak tampil. Solusi: Buka static HTML viewer
// (popup/viewer.html) sebagai tab baru via browser.tabs.create(). Image di-render
// via <img src="cloudUrl"> langsung.
//
// v3.12.2: Default pakai modal in-sidebar (openImageModalViewer) supaya sidebar
// tidak ketutup saat user browse dokumen. Escape hatch: tombol '↗ Tab baru' di
// modal → tabs.create viewer.html?id=... (reuse v3.12.1 code, masih bekerja).
//
// Strategi prefetch (sama dengan v3.12.0):
//   - Halaman 1: coba cache lokal (rf_shot_<id> via GET_SCREENSHOT_BLOB)
//   - Halaman 2+ dan fallback halaman 1: fetch langsung dari source.pages[i].url
//
// @param {string} id - vault item id dengan type='document'
async function openDocumentViewer(id) {
  const item = currentVault.items.find(i => i.id === id);
  if (!item) { toast('Item tidak ditemukan', false); return; }
  // v3.19.4: Guard — jangan buka viewer untuk group/folder items.
  if (isGroupItem(item)) {
    console.warn('[RecallFox] openDocumentViewer: skip group item:', id);
    return;
  }
  if (item.type !== 'document') { toast('Item ini bukan dokumen', false); return; }
  const pages = item.source?.pages || [];
  if (pages.length === 0) { toast('Dokumen tidak punya halaman', false); return; }

  const totalPages = pages.length;
  toast('📄 Memuat ' + totalPages + ' halaman...');

  // Prefetch semua halaman sebagai dataUrl
  const pageDataUrls = new Array(totalPages).fill(null);

  // Halaman 1: coba cache lokal dulu (lebih cepat — sudah di-download saat pull)
  try {
    const res = await browser.runtime.sendMessage({ type: 'GET_SCREENSHOT_BLOB', id });
    if (res?.ok && res.dataUrl) pageDataUrls[0] = res.dataUrl;
  } catch (e) {
    console.warn('[RecallFox] GET_SCREENSHOT_BLOB for document failed:', e.message);
  }

  // Fetch semua halaman yang belum ada (parallel — limit 4 concurrent)
  const CONCURRENCY = 4;
  const queue = pages.map((p, i) => ({ idx: i, url: p?.url || null })).filter(x => x.url && !pageDataUrls[x.idx]);
  for (let i = 0; i < queue.length; i += CONCURRENCY) {
    const batch = queue.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ({ idx, url }) => {
      try {
        const r = await fetch(url);
        if (!r.ok) return;
        const blob = await r.blob();
        if (!blob || blob.size === 0) return;
        const du = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('filereader_failed'));
          reader.readAsDataURL(blob);
        });
        pageDataUrls[idx] = du;
      } catch (e) {
        console.warn('[RecallFox] Document page ' + (idx + 1) + ' fetch failed:', e.message);
      }
    }));
  }

  const validCount = pageDataUrls.filter(Boolean).length;
  if (validCount === 0) { toast('Gagal memuat semua halaman dokumen', false); return; }

  // Render modal in-sidebar (escape hatch ke viewer.html?id=... tetap tersedia)
  openImageModalViewer(item, pageDataUrls.map(du => ({ dataUrl: du })));
}

// v3.14.6 (Sesi 1 follow-up): Dispatcher viewer — pilih openScreenshotViewer atau
// openDocumentViewer berdasarkan item.type.
//
// Bug A dari Google Doc Sesi 1 (feedback lanjutan setelah v3.14.5):
//   "jika pindah list media, itu tombol navigasi prev dan next tidak mendeteksi
//    isinya ada 2 halaman"
//
// Akar masalah: di navigator bar (prev item / next item / dropdown selectEl.change),
// call site selalu panggil `openScreenshotViewer(id)` — yang hanya fetch 1 page via
// GET_SCREENSHOT_BLOB. Jika item adalah dokumen multi-page (type='document'), hanya
// page 0 yang dimuat → validPages.length === 1 → isMulti=false → footer nav tampil
// "Hal 1/1" dengan tombol disabled. Seharusnya panggil openDocumentViewer yang fetch
// semua pages dari item.source.pages[].url.
//
// Fix: dispatcher ini dipakai semua call site navigator bar.
function openViewerById(id) {
  const item = currentVault.items.find(i => i.id === id);
  if (!item) { toast('Item tidak ditemukan', false); return; }
  if (item.type === 'document') {
    openDocumentViewer(id);
  } else {
    openScreenshotViewer(id);
  }
}

// v3.11.25 (Sesi 15, Issue #3): Sheet untuk edit catatan anotasi screenshot.
// User feedback: "tolong di bagian kotak merah itu ditambahkan catatan untuk
// menjelaskan anotasi yang sudah dibuatnya. jadi ketika dipaste tu hasilnya
// sudah ada kterangannya apa yang di anotasi."
function openAnnotationNoteSheet(id) {
  const it = currentVault.items.find(i => i.id === id);
  if (!it) { toast('Item tidak ditemukan', false); return; }
  // v3.12.0 (Fase 7): Untuk dokumen, catatan disimpan di source.annotationNote (lihat PWA sync.js).
  // Screenshot pakai top-level annotationNote. Kita baca kedua-duanya (fallback) supaya
  // sheet tetap menampilkan catatan yang sudah ada untuk kedua tipe.
  const isDoc = it.type === 'document';
  const existingNote = it.annotationNote || it.source?.annotationNote || '';
  openSheet('📝 Catatan Anotasi', isDoc ? 'Catatan dokumen — ikut saat copy dokumen' : 'Tulis penjelasan anotasi — ikut saat copy screenshot', b => {
    b.innerHTML = '<div class="sheet-form">'
      + '<div class="hintbox" style="font-size:11px;line-height:1.55">Catatan ini akan ikut saat Anda copy ' + (isDoc ? 'dokumen' : 'screenshot') + ' (tunggal maupun batch). Format: <b>**Catatan Anotasi:**</b> teks Anda. Cocok untuk menjelaskan panah, kotak, atau text yang sudah Anda tambahkan di anotasi.</div>'
      + '<div><label>Judul ' + (isDoc ? 'Dokumen' : 'Screenshot') + '</label><input class="f" value="' + esc(it.title || '') + '" readonly style="background:var(--surface-2)"></div>'
      + '<div><label>Catatan Anotasi <span class="field-hint">(opsional — kosongkan untuk hapus)</span></label>'
      +   '<textarea class="f" id="annotNote" rows="5" placeholder="mis. Panah merah menunjukkan tombol login yang error. Kotak kuning menunjukkan pesan error 500.">'
      + esc(existingNote)
      + '</textarea></div>'
      + '<div class="btn-row"><button class="btn btn-g" id="annotCancel">Batal</button>'
      +   '<button class="btn btn-p" id="annotSave">' + ICONS.check + 'Simpan</button></div></div>';
    b.querySelector('#annotCancel').addEventListener('click', closeSheet);
    b.querySelector('#annotSave').addEventListener('click', async () => {
      const note = b.querySelector('#annotNote').value.trim();
      if (isDoc) {
        // v3.12.0: Untuk dokumen, simpan ke source.annotationNote (supaya PWA juga lihat).
        // Sekaligus set top-level annotationNote supaya fallback buildDocumentCaption konsisten.
        const newSource = { ...(it.source || {}), annotationNote: note || '' };
        await updateItem(id, { source: newSource, annotationNote: note || undefined });
      } else {
        await updateItem(id, { annotationNote: note || undefined });
      }
      closeSheet();
      await refreshVault();
      toast(note ? '✓ Catatan anotasi disimpan' : '✓ Catatan anotasi dihapus');
    });
  });
}
function renderVault() { renderChips(); updateBreadcrumb(); updateTagFilterBar(); renderList(); }

// v3.19.0: Breadcrumb — tampilkan path folder yang sedang expanded
function updateBreadcrumb() {
  const bc = $('#vaultBreadcrumb');
  if (!bc) return;
  if (expandedGroupIds.length === 0) {
    bc.style.display = 'none';
    return;
  }
  // Cari folder yang paling dalam (deepest expanded)
  const allItems = getVaultItems();
  let path = [];
  for (const gid of expandedGroupIds) {
    const g = allItems.find(i => i.id === gid);
    if (g && isGroupItem(g)) {
      // Build chain dari root ke gid
      const chain = [];
      let cur = g;
      while (cur) {
        chain.unshift(cur);
        const pid = getParentId(cur);
        cur = pid ? allItems.find(i => i.id === pid) : null;
      }
      if (chain.length > path.length) path = chain;
    }
  }
  if (path.length === 0) { bc.style.display = 'none'; return; }
  let html = '<span style="cursor:pointer" data-bc="">🏠</span>';
  for (const g of path) {
    html += ' <span style="opacity:.5">›</span> <span style="cursor:pointer;color:var(--primary)" data-bc="' + g.id + '">📁 ' + esc(g.title) + '</span>';
  }
  bc.innerHTML = html;
  bc.style.display = '';
  // Wire click — collapse folders deeper than clicked level
  bc.querySelectorAll('[data-bc]').forEach(el => {
    el.addEventListener('click', () => {
      const targetId = el.dataset.bc;
      if (!targetId) {
        // Click 🏠 → collapse all
        expandedGroupIds = [];
      } else {
        // Collapse everything deeper than targetId
        const allItems2 = getVaultItems();
        // Find all descendants of targetId
        const descendants = new Set();
        function collectDesc(id) {
          for (const it of allItems2) {
            if (getParentId(it) === id) {
              descendants.add(it.id);
              if (isGroupItem(it)) collectDesc(it.id);
            }
          }
        }
        collectDesc(targetId);
        expandedGroupIds = expandedGroupIds.filter(id => !descendants.has(id));
      }
      renderVault();
    });
  });
}

// v3.19.0: Tag filter bar — tampilkan tags sebagai chip, klik untuk filter
function updateTagFilterBar() {
  const bar = $('#tagFilterBar');
  if (!bar) return;
  const allTags = new Set();
  for (const it of getVaultItems()) {
    if (it.archived || isGroupItem(it)) continue;
    if (Array.isArray(it.tags)) it.tags.forEach(t => { if (t && t !== 'group') allTags.add(t); });
  }
  if (allTags.size === 0) { bar.style.display = 'none'; return; }
  let html = '<span style="color:var(--muted)">Tag:</span> ';
  for (const tag of [...allTags].sort()) {
    const isActive = activeTagFilter === tag;
    html += '<button class="chip" style="font-size:10px;padding:2px 8px;' + (isActive ? 'background:var(--primary);color:#fff;border-color:var(--primary)' : '') + '" data-tag="' + esc(tag) + '">' + esc(tag) + '</button> ';
  }
  if (activeTagFilter) {
    html += '<button class="chip" style="font-size:10px;padding:2px 8px;color:var(--danger)" data-tag="">✕ Clear</button>';
  }
  bar.innerHTML = html;
  bar.style.display = activeTagFilter ? 'flex' : 'none';
  bar.querySelectorAll('[data-tag]').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.tag;
      activeTagFilter = t || null;
      renderVault();
    });
  });
}

// v3.19.0: Toggle tag filter bar visibility
function toggleTagFilter() {
  const bar = $('#tagFilterBar');
  if (!bar) return;
  if (bar.style.display === 'none' || bar.style.display === '') {
    updateTagFilterBar();
    bar.style.display = 'flex';
  } else {
    activeTagFilter = null;
    bar.style.display = 'none';
    renderVault();
  }
}

// v3.19.0: Collapse/Expand all folders
function toggleCollapseAll() {
  if (expandedGroupIds.length > 0) {
    expandedGroupIds = [];
    toast('📂 Semua folder ditutup');
  } else {
    // Expand all
    const allItems = getVaultItems();
    expandedGroupIds = allItems.filter(i => isGroupItem(i) && !i.archived).map(i => i.id);
    toast('📂 Semua folder dibuka');
  }
  renderVault();
}

// v3.19.0: Move to folder via menu (alternatif DnD)
function openMoveToFolderSheet(itemId) {
  const it = findItem(itemId);
  if (!it) return;
  const allFolders = getVaultItems().filter(i => isGroupItem(i) && !i.archived && i.id !== itemId);
  if (allFolders.length === 0) { toast('Belum ada folder. Buat folder dulu.', false); return; }
  openSheet('Pindahkan ke folder', esc(it.title || 'Item'), b => {
    let html = '<button class="act" data-fid=""><div>📤 Top-level (keluarkan dari folder)</div></button>';
    // Build folder tree untuk display
    const nodes = buildTree(allFolders, [], null, true);
    function renderFolderOption(node, depth) {
      if (node.kind === 'group') {
        const indent = '\u00A0\u00A0'.repeat(depth);
        const isCurrent = getParentId(it) === node.item.id;
        html += '<button class="act' + (isCurrent ? ' on' : '') + '" data-fid="' + node.item.id + '"><div>' + indent + '📁 ' + esc(node.item.title) + (isCurrent ? ' ✓' : '') + '</div></button>';
        if (node.children) node.children.forEach(c => renderFolderOption(c, depth + 1));
      }
    }
    nodes.forEach(n => renderFolderOption(n, 0));
    b.innerHTML = html;
    b.querySelectorAll('[data-fid]').forEach(btn => {
      btn.addEventListener('click', () => {
        const fid = btn.dataset.fid || null;
        closeSheet();
        moveItemToGroup(itemId, fid);
      });
    });
  });
}

// v3.19.0: Folder color — pilih warna untuk folder
function openFolderColorSheet(groupId) {
  const it = findItem(groupId);
  if (!it) return;
  const colors = [
    { id: '', label: 'Default', color: 'var(--muted)' },
    { id: '#ef4444', label: 'Merah', color: '#ef4444' },
    { id: '#f59e0b', label: 'Oranye', color: '#f59e0b' },
    { id: '#10b981', label: 'Hijau', color: '#10b981' },
    { id: '#3b82f6', label: 'Biru', color: '#3b82f6' },
    { id: '#8b5cf6', label: 'Ungu', color: '#8b5cf6' },
    { id: '#ec4899', label: 'Pink', color: '#ec4899' }
  ];
  const currentColor = it.source?.folderColor || '';
  openSheet('Warna Folder', esc(it.title || 'Folder'), b => {
    b.innerHTML = colors.map(c =>
      '<button class="act' + (currentColor === c.id ? ' on' : '') + '" data-color="' + c.id + '"><div style="display:flex;align-items:center;gap:8px"><span style="width:16px;height:16px;border-radius:4px;background:' + c.color + ';display:inline-block"></span>' + c.label + (currentColor === c.id ? ' ✓' : '') + '</div></button>'
    ).join('');
    b.querySelectorAll('[data-color]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const color = btn.dataset.color;
        closeSheet();
        if (!it.source) it.source = {};
        it.source.folderColor = color || undefined;
        await updateItem(groupId, { source: it.source });
        await refreshVault();
        toast('🎨 Warna folder diubah');
      });
    });
  });
}

// v3.16.7 #5: Wire exit scope button — clear bundle scope + re-render
function wireExitScope() {
  const btn = $('#exitScopeBtn');
  if (btn) {
    btn.addEventListener('click', () => {
      currentBundleScope = null;
      renderVault();
      toast('✕ Scope direset — tampilkan semua item');
    });
  }
}

// ============ Item sheet (⋯ menu) ============
function itemSheet(id) {
  const it = findItem(id);
  if (!it) return;

  // v3.18.3: Group item — tampilkan menu khusus folder (rename, hapus folder, unparent all)
  if (isGroupItem(it)) {
    const childCount = currentVault.items.filter(i => getParentId(i) === it.id).length;
    openSheet(esc(it.title), '📁 Folder' + (childCount > 0 ? ' · ' + childCount + ' item' : ''), b => {
      b.innerHTML =
        '<button class="act" data-a="rename-group">' + ICONS.edit + '<div>✏️ Rename Folder<div class="ad">Ubah nama folder</div></div></button>'
        + '<button class="act" data-a="folder-color">' + ICONS.dots + '<div>🎨 Warna Folder<div class="ad">Pilih warna untuk folder</div></div></button>'
        + '<button class="act" data-a="move-folder">' + ICONS.clipA + '<div>📂 Pindahkan Folder ke...<div class="ad">Pindahkan folder ini ke folder lain</div></div></button>'
        + '<button class="act" data-a="expand-all">' + ICONS.dots + '<div>📂 Buka semua child<div class="ad">Tampilkan semua item di dalam folder</div></div></button>'
        // v3.20.32: Archive/Restore folder — recursive (folder + semua descendant)
        + (it.archived
          ? '<button class="act" data-a="restore-folder">' + ICONS.archive + '<div>📤 Restore Folder<div class="ad">Keluarkan folder + isinya dari arsip. Parent folder tetap sama.</div></div></button>'
          : '<button class="act" data-a="archive-folder">' + ICONS.archive + '<div>📦 Arsipkan Folder<div class="ad">Folder + ' + childCount + ' item disembunyikan. Bisa di-restore nanti, parent folder tetap sama.</div></div></button>')
        + (childCount > 0 ? '<button class="act" data-a="unparent-all">' + ICONS.clipA + '<div>📤 Keluarkan semua item<div class="ad">' + childCount + ' item jadi top-level, folder tetap ada</div></div></button>' : '')
        + '<button class="act danger" data-a="del-group">' + ICONS.trash + '<div>🗑️ Hapus Folder<div class="ad">' + (childCount > 0 ? childCount + ' item di dalamnya akan jadi top-level' : 'Folder kosong akan dihapus') + '</div></div></button>';
      b.querySelectorAll('.act').forEach(a => a.addEventListener('click', () => {
        const k = a.dataset.a;
        if (k === 'rename-group') {
          closeSheet();
          // v3.20.48: Ganti prompt dengan modal standar
          openSheet('✏️ Rename Folder', esc(it.title || 'Folder'), b => {
            b.innerHTML =
              '<div style="padding:4px 0">'
              + '<label style="font-size:11px;font-weight:600;color:var(--text-2);display:block;margin-bottom:4px">Nama Folder <span style="color:var(--danger)">*</span></label>'
              + '<input id="rfRenameFolderName" type="text" value="' + esc(it.title || '') + '" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:var(--r-md);font-size:13px;background:var(--surface);color:var(--text);outline:none" />'
              + '</div>'
              + '<div style="display:flex;gap:8px;padding:12px 0 0;justify-content:flex-end">'
              + '<button class="btn btn-g" id="rfRenameFolderCancel">Batal</button>'
              + '<button class="btn btn-p" id="rfRenameFolderSave">✏️ Simpan</button>'
              + '</div>';
            const nameInput = b.querySelector('#rfRenameFolderName');
            if (nameInput) { nameInput.focus(); nameInput.select(); }
            b.querySelector('#rfRenameFolderCancel').addEventListener('click', closeSheet);
            b.querySelector('#rfRenameFolderSave').addEventListener('click', async () => {
              const newName = (nameInput?.value || '').trim();
              if (!newName) { nameInput.style.borderColor = 'var(--danger)'; nameInput.focus(); toast('⚠ Nama folder wajib diisi', false); return; }
              closeSheet();
              await updateItem(it.id, { title: newName });
              await refreshVault();
              toast('✏️ Folder di-rename: ' + newName);
            });
            nameInput?.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') { e.preventDefault(); b.querySelector('#rfRenameFolderSave').click(); }
            });
          });
        }
        else if (k === 'folder-color') { closeSheet(); openFolderColorSheet(it.id); }
        else if (k === 'move-folder') { closeSheet(); openMoveToFolderSheet(it.id); }
        else if (k === 'expand-all') {
          closeSheet();
          if (!expandedGroupIds.includes(it.id)) expandedGroupIds.push(it.id);
          renderList();
          toast('📂 Folder dibuka');
        }
        else if (k === 'unparent-all') {
          closeSheet();
          if (!confirm('Keluarkan semua ' + childCount + ' item dari folder "' + it.title + '"?')) return;
          (async () => {
            const children = currentVault.items.filter(i => getParentId(i) === it.id);
            for (const child of children) {
              setParentId(child, null);
              await updateItem(child.id, { source: child.source });
            }
            await refreshVault();
            toast('📤 ' + childCount + ' item dikeluarkan ke top-level');
          })();
        }
        else if (k === 'del-group') {
          b.innerHTML = '<div class="confirmstrip"><span style="flex:1">Hapus folder <b>' + esc((it.title || '').slice(0, 24)) + '</b>?</span>'
            + '<button class="btn btn-g" data-c="0">Batal</button><button class="btn btn-d" data-c="1">Hapus</button></div>';
          b.querySelector('[data-c="0"]').addEventListener('click', closeSheet);
          b.querySelector('[data-c="1"]').addEventListener('click', async () => {
            // Unparent all children first
            const children = currentVault.items.filter(i => getParentId(i) === it.id);
            for (const child of children) {
              setParentId(child, null);
              await updateItem(child.id, { source: child.source });
            }
            // Delete the group item itself
            await deleteItem(it.id);
            closeSheet();
            await refreshVault();
            toast('🗑️ Folder dihapus' + (children.length > 0 ? ' · ' + children.length + ' item jadi top-level' : ''));
          });
        }
        // v3.20.32: Archive folder recursive (folder + semua descendant)
        else if (k === 'archive-folder') {
          b.innerHTML = '<div class="confirmstrip"><span style="flex:1">Arsipkan folder <b>' + esc((it.title || '').slice(0, 24)) + '</b> + semua isinya?</span>'
            + '<button class="btn btn-g" data-c="0">Batal</button><button class="btn btn-p" data-c="1">📦 Arsipkan</button></div>';
          b.querySelector('[data-c="0"]').addEventListener('click', closeSheet);
          b.querySelector('[data-c="1"]').addEventListener('click', async () => {
            try {
              const result = await archiveFolderRecursive(currentVault.items, it.id);
              closeSheet();
              await refreshVault();
              if (currentChip !== 'archive') currentChip = 'all';
              renderChips();
              toast('📦 Folder diarsipkan · ' + result.archivedCount + ' item disembunyikan');
            } catch (e) {
              toast('⚠ Gagal arsip folder: ' + e.message, false);
            }
          });
        }
        // v3.20.32: Restore folder recursive
        else if (k === 'restore-folder') {
          closeSheet();
          (async () => {
            try {
              const result = await unarchiveFolderRecursive(currentVault.items, it.id);
              await refreshVault();
              toast('📤 Folder di-restore · ' + result.restoredCount + ' item kembali. Parent folder tetap sama.');
            } catch (e) {
              toast('⚠ Gagal restore folder: ' + e.message, false);
            }
          })();
        }
      }));
    });
    return;
  }

  const T = TYPE[it.type] || { label: it.type };
  const vars = it.body ? extractVariables(it.body).length : 0;
  openSheet(esc(it.title), T.label + (vars ? ' · ' + vars + ' variabel' : ''), b => {
    const isAi = !!currentAiDomain;
    // v3.12.0 (Fase 7): Tambah label utama untuk dokumen.
    // v3.20.36-dev: Label spesifik untuk file — "Kopi isi file" (bukan generic "Salin ke clipboard")
    const primaryLabel = it.type === 'link' ? 'Buka link di tab baru'
      : (it.type === 'bundle' ? 'Salin bundle ke clipboard'
      : (it.type === 'screenshot' ? 'Lihat screenshot'
      : (it.type === 'document' ? 'Lihat dokumen (multi-halaman)'
      : (it.type === 'file' ? '📋 Kopi isi file ke clipboard'
      : (isAi ? 'Sisipkan ke chat' : 'Salin ke clipboard')))));
    const primaryIcon = it.type === 'link' ? ICONS.spark : (it.type === 'bundle' ? ICONS.archive : (it.type === 'file' ? ICONS.copy : (isAi ? ICONS.zap : ICONS.copy)));
    b.innerHTML =
      '<button class="act" data-a="primary">' + primaryIcon + '<div>' + primaryLabel + '<div class="ad">Sama dengan klik baris — 1 klik</div></div></button>'
      + (it.type === 'prompt' || it.type === 'context' ? '<button class="act" data-a="attach">' + ICONS.clipA + '<div>Sisipkan dengan lampiran<div class="ad">Prompt + link referensi sekaligus</div></div></button>' : '')
      // v3.16.0 K5: Konteks Aktif — toggle flag untuk auto-prepend saat inject prompt.
      // Maks 3 konteks aktif. Saat user inject prompt, semua konteks aktif di-prepend.
      + (it.type === 'context' ? (function() {
          const activeIds = (currentVault?.settings?.activeContextIds) || [];
          const isActive = activeIds.includes(it.id);
          return '<button class="act" data-a="toggle-active">' + ICONS.zap + '<div>' + (isActive ? '🔴 Nonaktifkan Konteks' : '🟢 Aktifkan Konteks') + '<div class="ad">' + (isActive ? 'Tidak auto-prepend saat inject prompt' : 'Auto-prepend saat inject prompt (maks 3)') + '</div></div></button>';
        })() : '')
      + '<button class="act" data-a="edit">' + ICONS.edit + '<div>Edit judul, isi, tag…</div></button>'
      // v3.16.5: Ringkas snapshot dengan AI — hemat token saat inject ke AI chat
      + (it.type === 'snapshot' ? '<button class="act" data-a="summarize">' + ICONS.spark + '<div>🤖 Ringkas dengan AI<div class="ad">Ringkas snapshot sebelum sisipkan — hemat token</div></div></button>' : '')
      // v3.16.8 #7: Lanjutkan snapshot di AI lain — copy snapshot body + buka AI lain di tab baru
      // User bisa pindah percakapan dari satu AI ke AI lain dengan konteks yang sama.
      + (it.type === 'snapshot' ? '<button class="act" data-a="continue-ai">' + ICONS.spark + '<div>🔄 Lanjutkan di AI Lain<div class="ad">Salin snapshot + buka AI lain (Claude/Gemini/dll) di tab baru</div></div></button>' : '')
      // v3.20.16: Relay Point — Copy Resume Context (jika sudah di-generate).
      // Resume context = ringkasan status kerja terakhir, di-generate via OmniRouter
      // saat snapshot diambil di AI domain. User paste ke akun AI baru untuk melanjutkan.
      // Hanya muncul kalau it.resumeContext sudah ada — kalau belum, tampilkan tombol Generate.
      + (it.type === 'snapshot' && it.resumeContext ? '<button class="act" data-a="copy-resume">' + ICONS.copy + '<div>📋 Copy Resume Context<div class="ad">Paste ke akun AI baru untuk melanjutkan pekerjaan</div></div></button>' : '')
      // v3.20.16: Relay Point — Generate Resume Context (jika belum ada, atau retry).
      // Manual trigger — berguna kalau auto-generate saat capture gagal (mis. OmniRouter
      // belum dikonfigurasi saat itu, atau generate pertama gagal).
      + (it.type === 'snapshot' && !it.resumeContext ? '<button class="act" data-a="gen-resume">' + ICONS.spark + '<div>🔄 Generate Resume Context<div class="ad">Buat ringkasan status kerja via OmniRouter — untuk pindah akun AI</div></div></button>' : '')
      + '<button class="act" data-a="fav">' + ICONS.star + '<div>' + (it.favorite ? 'Hapus dari favorit' : 'Jadikan favorit') + '</div></button>'
      // v3.7.2 (Issue 1): Arsipkan / Unarsipkan — item tetap tersimpan, hanya disembunyikan dari list default.
      + (it.type !== 'bundle' ? '<button class="act" data-a="archive">' + ICONS.archive + '<div>' + (it.archived ? 'Keluarkan dari arsip' : 'Arsipkan item') + '<div class="ad">Disembunyikan dari list utama tanpa dihapus</div></div></button>' : '')
      // v3.7.2 (Issue 1): Tambah/Pindah ke Bundle — assign ulang screenshot/prompt/dll ke bundle lain.
      + (it.type !== 'bundle' ? '<button class="act" data-a="bundle">' + ICONS.clipA + '<div>Tambah / pindah ke Bundle<div class="ad">Reassign item ke sesi troubleshooting lain</div></div></button>' : '<button class="act" data-a="editbundle">' + ICONS.edit + '<div>Edit bundle<div class="ad">Ubah nama, tambah / hapus anggota</div></div></button>')
      // v3.19.0: Pindahkan ke Folder (alternatif DnD untuk sidebar sempit)
      + (it.type !== 'bundle' ? '<button class="act" data-a="move-folder">' + ICONS.clipA + '<div>📂 Pindahkan ke Folder...<div class="ad">Pilih folder tujuan dari daftar</div></div></button>' : '')
      + (it.type === 'screenshot' || it.type === 'document' ? '<button class="act" data-a="dl">' + ICONS.download + '<div>Download ' + (it.type === 'document' ? 'halaman pertama' : 'gambar') + '</div></button>' : '')
      // v3.11.6 (Issue 1 dari Google Doc): Tombol Salin Gambar & Salin + Keterangan
      // untuk item screenshot di Vault. Sebelumnya cuma ada "Lihat" dan "Download".
      // User bilang: "masih lihat dan download bukan seperti ini baik ikon maupun fungsinya"
      // v3.12.0 (Fase 7): Tombol yang sama juga tampil untuk dokumen (copy halaman pertama).
      + (it.type === 'screenshot' || it.type === 'document' ? '<button class="act" data-a="copy-img">' + ICONS.copy + '<div>📋 Salin ' + (it.type === 'document' ? 'Halaman Pertama' : 'Gambar') + '<div class="ad">Salin gambar saja ke clipboard</div></div></button>' : '')
      + (it.type === 'screenshot' || it.type === 'document' ? '<button class="act" data-a="copy-bundle">' + ICONS.clipA + '<div>📦 Salin + Keterangan<div class="ad">' + (it.type === 'document' ? 'Halaman pertama + judul, waktu, jumlah halaman' : 'Gambar + URL, judul, waktu, mode') + '</div></div></button>' : '')
      // v3.11.36 (Sesi 2, Issue dari Google Doc): Tombol Salin Teks Metadata (text-only)
      // User feedback: "di chat ai maupun wa, paste itu kadang gambarnya doang, teksnya ga
      // ngikut, atau sebaliknya di gemini teks nya doang gambarnya ga ngikut. oleh karena
      // itu tolong tambahkan kopi teks metadatanya doang bisa?"
      // Solusi: navigator.clipboard.writeText(textPlain) — text-only, paste ke mana saja.
      // v3.12.0: Juga tampil untuk dokumen — pakai buildDocumentCaption (text-only).
      + (it.type === 'screenshot' || it.type === 'document' ? '<button class="act" data-a="copy-meta">' + ICONS.copy + '<div>📝 Salin Teks Metadata<div class="ad">Teks saja (judul, waktu' + (it.type === 'document' ? ', halaman' : ', URL') + ') — paste ke WA/Gemini/AI chat</div></div></button>' : '')
      // v3.14.9: Salin URL gambar (public Supabase Storage URL) — untuk AI sites
      // yang tidak support paste gambar langsung. User paste URL ke AI chat,
      // AI fetch gambar dari URL.
      + (it.type === 'screenshot' || it.type === 'document' ? '<button class="act" data-a="copy-url">' + ICONS.copy + '<div>🔗 Salin Tautan<div class="ad">URL public gambar — paste ke AI chat yang tidak support paste gambar</div></div></button>' : '')
      // v3.20.42: Tombol untuk type='file' — standarisasi label (sama seperti tipe lain)
      + (it.type === 'file' ? '<button class="act" data-a="copy-file-content">' + ICONS.copy + '<div>📋 Salin Konten<div class="ad">Salin isi file (teks) ke clipboard — paste ke AI chat</div></div></button>' : '')
      + (it.type === 'file' ? '<button class="act" data-a="copy-file-url">' + ICONS.copy + '<div>🔗 Salin Tautan<div class="ad">URL public file — paste ke AI chat, AI bisa fetch isi dari URL</div></div></button>' : '')
      + (it.type === 'file' ? '<button class="act" data-a="download-file">' + ICONS.download + '<div>⬇️ Unduh<div class="ad">Download file ke komputer</div></div></button>' : '')
      // v3.11.25 (Sesi 15, Issue #3): Tambah catatan anotasi untuk screenshot
      // v3.12.0 (Fase 7): Juga tampil untuk dokumen — catatan disimpan di source.annotationNote.
      + (it.type === 'screenshot' || it.type === 'document' ? '<button class="act" data-a="annot-note">' + ICONS.edit + '<div>📝 Catatan Anotasi<div class="ad">Tulis penjelasan — ikut saat copy</div></div></button>' : '')
      + '<button class="act danger" data-a="del">' + ICONS.trash + '<div>Hapus item</div></button>';
    b.querySelectorAll('.act').forEach(a => a.addEventListener('click', async () => {
      const k = a.dataset.a;
      if (k === 'primary') {
        closeSheet();
        // v3.20.36-dev: Untuk type='file', primary action = kopi isi file (bukan buka itemSheet lagi)
        if (it.type === 'file') { copyFileContentToClipboard(it.id); return; }
        primaryAction(it.id);
      }
      else if (k === 'attach') { closeSheet(); openAttachModal(it.id); }
      else if (k === 'edit') { closeSheet(); openEditorSheet(it.id); }
      // v3.16.5: Ringkas snapshot dengan AI
      else if (k === 'summarize') { closeSheet(); summarizeAndInject(it.id); }
      // v3.16.8 #7: Lanjutkan snapshot di AI lain
      else if (k === 'continue-ai') { closeSheet(); continueInOtherAI(it.id); }
      // v3.20.16: Relay Point — Copy resume context ke clipboard
      else if (k === 'copy-resume') {
        closeSheet();
        if (!it.resumeContext) { toast('Resume context belum ada', false); }
        else {
          try {
            await navigator.clipboard.writeText(it.resumeContext);
            toast('📋 Resume context tersalin — paste ke akun AI baru');
          } catch (e) {
            // Fallback: delegate ke background (clipboard di content script context)
            try {
              await browser.runtime.sendMessage({ type: 'COPY_TO_CLIPBOARD', text: it.resumeContext });
              toast('📋 Resume context tersalin — paste ke akun AI baru');
            } catch (e2) { toast('⚠ Gagal menyalin resume context', false); }
          }
        }
      }
      // v3.20.16: Relay Point — Generate resume context manual (via OmniRouter)
      else if (k === 'gen-resume') {
        closeSheet();
        toast('🔄 Membuat resume context via OmniRouter...');
        try {
          const res = await browser.runtime.sendMessage({ type: 'GENERATE_RESUME_CONTEXT', itemId: it.id });
          if (res?.ok) {
            await refreshVault();
            toast('✓ Resume context siap — klik item lagi untuk copy');
          } else {
            const err = res?.error || 'unknown';
            let msg = 'Gagal: ' + err;
            if (err === 'generate_failed') msg = 'Gagal generate — cek API key OmniRouter di Pengaturan';
            else if (err === 'snapshot_body_too_short') msg = 'Snapshot terlalu pendek untuk resume context';
            else if (err === 'item_not_found_or_not_snapshot') msg = 'Item tidak ditemukan atau bukan snapshot';
            toast(msg, false);
          }
        } catch (e) {
          toast('Gagal: ' + e.message, false);
        }
      }
      else if (k === 'editbundle') { closeSheet(); openBundleEditorSheet(it.id); }
      else if (k === 'fav') { toggleFav(it.id).then(() => { closeSheet(); toast(it.favorite ? '★ Dihapus dari favorit' : '★ Jadikan favorit'); }); }
      // v3.16.0 K5: Toggle konteks aktif (auto-prepend saat inject prompt)
      else if (k === 'toggle-active') { closeSheet(); toggleActiveContext(it.id); }
      else if (k === 'archive') { toggleArchive(it.id).then(() => { closeSheet(); toast(it.archived ? '📦 Dikeluarkan dari arsip' : '📦 Diarsipkan'); }); }
      else if (k === 'bundle') { closeSheet(); openReassignBundleSheet(it.id); }
      // v3.19.0: Pindahkan ke Folder via menu
      else if (k === 'move-folder') { closeSheet(); openMoveToFolderSheet(it.id); }
      else if (k === 'dl') { closeSheet(); downloadScreenshot(it.id); }
      // v3.11.6: Handler Salin Gambar & Salin + Keterangan untuk item screenshot
      // v3.12.0 (Fase 7): Dipakai juga untuk dokumen — copyScreenshotToClipboard/Meta
      // sudah handle type='document' (pakai buildDocumentCaption).
      else if (k === 'copy-img') { closeSheet(); copyScreenshotToClipboard(it.id, false); }
      else if (k === 'copy-bundle') { closeSheet(); copyScreenshotToClipboard(it.id, true); }
      // v3.11.36: Handler Salin Teks Metadata (text-only, no image)
      else if (k === 'copy-meta') { closeSheet(); copyScreenshotMetaToClipboard(it.id); }
      // v3.14.9: Handler Salin URL Gambar (untuk AI sites yang tidak support paste gambar)
      else if (k === 'copy-url') { closeSheet(); copyImageUrlToClipboard(it.id); }
      // v3.20.35-dev: Handler untuk type='file' — kopi isi, kopi URL, download
      else if (k === 'copy-file-content') { closeSheet(); copyFileContentToClipboard(it.id); }
      else if (k === 'copy-file-url') { closeSheet(); copyFileUrlToClipboard(it.id); }
      else if (k === 'download-file') { closeSheet(); downloadFileItem(it.id); }
      // v3.11.25 (Sesi 15, Issue #3): Handler untuk catatan anotasi
      else if (k === 'annot-note') { closeSheet(); openAnnotationNoteSheet(it.id); }
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

// v3.16.0 K5: Toggle konteks aktif — tandai context untuk auto-prepend saat inject prompt.
// Maks 3 konteks aktif. Disimpan di vault.settings.activeContextIds (array of id).
// Saat user inject prompt, semua konteks aktif di-prepend ke body (lihat doInject).
async function toggleActiveContext(id) {
  const it = currentVault.items.find(i => i.id === id);
  if (!it || it.type !== 'context') {
    toast('Hanya konteks yang bisa diaktifkan', false);
    return;
  }
  const settings = currentVault?.settings || {};
  const activeIds = settings.activeContextIds || [];
  const MAX_ACTIVE = 3;
  if (activeIds.includes(id)) {
    // Nonaktifkan
    const newActiveIds = activeIds.filter(aid => aid !== id);
    await saveSettings({ ...settings, activeContextIds: newActiveIds });
    await refreshVault();
    toast('🔴 Konteks dinonaktifkan');
  } else {
    // Aktifkan — cek maks 3
    if (activeIds.length >= MAX_ACTIVE) {
      toast('Maksimal ' + MAX_ACTIVE + ' konteks aktif. Nonaktifkan salah satu dulu.', false);
      return;
    }
    const newActiveIds = [...activeIds, id];
    await saveSettings({ ...settings, activeContextIds: newActiveIds });
    await refreshVault();
    toast('🟢 Konteks aktif — akan auto-prepend saat inject prompt');
  }
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
// v3.10.2 (Issue 5 fix): Selaraskan dengan Buat Bundle — tambah section Catatan,
//   filter "Catatan", field Warna, field Prompt cepat inline, checkbox "Simpan
//   sebagai item Prompt". Catatan yang tercentang sekarang diteruskan ke
//   updateBundle({ noteIds }) sehingga konsisten dengan addBundle.
function openBundleEditorSheet(bundleId) {
  const bd = currentVault.bundles.find(b => b.id === bundleId);
  if (!bd) { toast('Bundle tidak ditemukan', false); return; }
  // v3.9.0 (Issue 2): Sort by type + add filter chips + color badges
  const TYPE_ORDER = { prompt: 1, context: 2, link: 3, screenshot: 4, snapshot: 5, file: 6 };
  const allCandidates = (currentVault?.items || []).filter(i =>
    ['prompt', 'context', 'link', 'screenshot', 'snapshot', 'file'].includes(i.type) && !i.archived
  ).sort((a, c) => (TYPE_ORDER[a.type] || 99) - (TYPE_ORDER[c.type] || 99) ||
                    (a.title || '').localeCompare(c.title || ''));
  // v3.10.2 (Issue 5 fix): Catatan candidates — selaras dengan Buat Bundle
  const noteCandidates = (currentNotes || []).filter(n => !n.archived);

  openSheet('📦 Edit Bundle', 'Filter per tipe, centang anggota + catatan, simpan', b => {
    b.innerHTML = '<div class="sheet-form">'
      + '<div><label>Nama Bundle</label><input class="f" id="ebName" value="' + esc(bd.name || '') + '" placeholder="mis. Riset kompetitor…"></div>'
      // v3.10.2 (Issue 5 fix): Tambah field Warna label (sebelumnya hanya di Buat Bundle)
      + '<div><label>Warna label <span class="field-hint">(opsional, untuk sort visual)</span></label>'
      +   '<select class="f" id="ebColor">'
      +     '<option value=""' + ((bd.color || '') === '' ? ' selected' : '') + '>— Tanpa warna —</option>'
      +     '<option value="orange"' + (bd.color === 'orange' ? ' selected' : '') + '>🟠 Oranye</option>'
      +     '<option value="green"' + (bd.color === 'green' ? ' selected' : '') + '>🟢 Hijau</option>'
      +     '<option value="blue"' + (bd.color === 'blue' ? ' selected' : '') + '>🔵 Biru</option>'
      +     '<option value="purple"' + (bd.color === 'purple' ? ' selected' : '') + '>🟣 Ungu</option>'
      +     '<option value="pink"' + (bd.color === 'pink' ? ' selected' : '') + '>🩷 Merah Muda</option>'
      +     '<option value="red"' + (bd.color === 'red' ? ' selected' : '') + '>🔴 Merah</option>'
      +   '</select></div>'
      // v3.10.2 (Issue 5 fix): Tambah Prompt cepat inline (sebelumnya hanya di Buat Bundle)
      + '<div><label>Prompt cepat <span class="field-hint">(opsional — tulis prompt langsung tanpa bikin item dulu)</span></label>'
      +   '<input class="f" id="ebInlineTitle" placeholder="Judul prompt (opsional)" style="margin-bottom:4px" value="' + esc(bd.inlinePromptItemId ? (bd.name || '') + ' — inline' : '') + '">'
      +   '<textarea class="f" id="ebInlinePrompt" rows="3" placeholder="Tulis prompt cepat — akan di-inject sebagai prompt tambahan saat bundle dipakai...">' + esc(bd.inlinePrompt || '') + '</textarea>'
      +   '<label class="checkrow" style="display:flex;align-items:center;gap:6px;font-size:11px;margin-top:4px">'
      +     '<input type="checkbox" id="ebSaveAsPrompt"' + (bd.inlinePromptItemId ? ' checked' : '') + '> Simpan juga sebagai item Prompt tersendiri'
      +   '</label></div>'
      // v3.20.44: Tambah search bar + File filter chip
      + '<div><label>Cari item <span class="field-hint">(judul, tag, konten)</span></label>'
      +   '<input class="f" id="ebSearch" placeholder="🔍 Cari item..." style="margin-bottom:8px"></div>'
      + '<div><label>Filter per tipe <span class="field-hint">(klik untuk filter)</span></label>'
      +   '<div class="eb-filters" style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">'
      +     '<button class="chip eb-filter on" data-cat="all" style="font-size:10.5px;padding:3px 9px">Semua</button>'
      +     '<button class="chip eb-filter" data-cat="prompt" style="font-size:10.5px;padding:3px 9px;border-left:3px solid var(--primary)">💬 Prompt</button>'
      +     '<button class="chip eb-filter" data-cat="context" style="font-size:10.5px;padding:3px 9px;border-left:3px solid var(--violet)">📋 Konteks</button>'
      +     '<button class="chip eb-filter" data-cat="link" style="font-size:10.5px;padding:3px 9px;border-left:3px solid #0891b2">🔗 Link</button>'
      +     '<button class="chip eb-filter" data-cat="screenshot" style="font-size:10.5px;padding:3px 9px;border-left:3px solid var(--green)">🖼️ Media</button>'
      +     '<button class="chip eb-filter" data-cat="snapshot" style="font-size:10.5px;padding:3px 9px;border-left:3px solid var(--amber)">📸 Snapshot</button>'
      +     '<button class="chip eb-filter" data-cat="file" style="font-size:10.5px;padding:3px 9px;border-left:3px solid #6366f1">📄 File</button>'
      +     '<button class="chip eb-filter" data-cat="note" style="font-size:10.5px;padding:3px 9px;border-left:3px solid #ca8a04">📝 Catatan</button>'
      +   '</div></div>'
      + '<div><label>Anggota <span class="field-hint" id="ebCount">' + ((bd.itemIds || []).length + (bd.noteIds || []).length) + ' dipilih</span></label>'
      +   '<div class="picklist" id="ebList"></div></div>'
      // v3.11.7-fix (Issue #2): btn-row pakai 3 tombol flex:1 yang merata — HAPUS spacer
      // style="flex:1" yang bikin tombol Simpan terdorong ke kanan ekstrim di sidebar lebar.
      // Layout: [Arsipkan] [Batal] [Simpan] — semua flex:1, gap konsisten.
      + '<div class="btn-row"><button class="btn btn-g" id="ebArchive">' + ICONS.archive + (bd.archived ? 'Keluarkan' : 'Arsipkan') + '</button>'
      +   '<button class="btn btn-g" id="ebCancel">Batal</button><button class="btn btn-p" id="ebSave">' + ICONS.check + 'Simpan</button></div></div>';

    // v3.9.0 (Issue 2): Render list with filter + track checked items in a Set
    // v3.10.2 (Issue 5 fix): + track checked notes in a Set
    const listBox = b.querySelector('#ebList');
    let activeFilter = 'all';
    let searchQuery = '';
    b._checkedSet = new Set(bd.itemIds || []);
    b._checkedNotes = new Set(bd.noteIds || []);

    function renderList() {
      let html = '';
      // v3.20.44: Apply search filter + type filter
      const filtered = (activeFilter === 'all' || activeFilter === 'note'
        ? allCandidates
        : allCandidates.filter(it => it.type === activeFilter)
      ).filter(it => {
        if (!searchQuery) return true;
        const q = searchQuery.toLowerCase();
        return (it.title || '').toLowerCase().includes(q)
          || (it.body || '').toLowerCase().includes(q)
          || (it.tags || []).some(t => t.toLowerCase().includes(q));
      });
      for (const it of filtered) {
        const T = TYPE[it.type] || { icon: '', label: it.type };
        const checked = b._checkedSet.has(it.id) ? ' checked' : '';
        html += '<label class="pickrow"><input type="checkbox" value="' + it.id + '" data-kind="item"' + checked + '>'
          + '<span class="item-ic t-' + it.type + '" style="width:18px;height:18px;font-size:11px;flex-shrink:0">' + T.icon + '</span>'
          + '<span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(it.title) + '</span>'
          + '<span class="pt-type" style="font-size:10px;color:#888">' + T.label + '</span></label>';
      }
      // v3.10.2 (Issue 5 fix): Notes section — IDENTIK dengan Buat Bundle
      if ((activeFilter === 'all' || activeFilter === 'note') && noteCandidates.length > 0) {
        html += '<div style="margin-top:8px;padding-top:6px;border-top:1px dashed #ccc;font-size:11px;color:#666">— Catatan (Notepad) —</div>';
        for (const n of noteCandidates) {
          const noteTitle = n.title || stripHtmlForPreview(n.body || '').slice(0, 50) || 'Catatan';
          const checked = b._checkedNotes.has(n.id) ? ' checked' : '';
          html += '<label class="pickrow"><input type="checkbox" value="' + n.id + '" data-kind="note"' + checked + '>'
            + '<span class="item-ic t-note" style="width:18px;height:18px;font-size:11px;flex-shrink:0">📝</span>'
            + '<span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(noteTitle) + '</span>'
            + '<span class="pt-type" style="font-size:10px;color:#888">catatan</span></label>';
        }
      }
      listBox.innerHTML = html;
      // Bind change handlers
      listBox.querySelectorAll('input[type=checkbox]').forEach(cb => {
        cb.addEventListener('change', () => {
          if (cb.dataset.kind === 'note') {
            if (cb.checked) b._checkedNotes.add(cb.value);
            else b._checkedNotes.delete(cb.value);
          } else {
            if (cb.checked) b._checkedSet.add(cb.value);
            else b._checkedSet.delete(cb.value);
          }
          b.querySelector('#ebCount').textContent = (b._checkedSet.size + b._checkedNotes.size) + ' dipilih';
        });
      });
    }
    renderList();

    // Filter chip handlers
    b.querySelectorAll('.eb-filter').forEach(btn => {
      btn.addEventListener('click', () => {
        b.querySelectorAll('.eb-filter').forEach(c => c.classList.remove('on'));
        btn.classList.add('on');
        activeFilter = btn.dataset.cat;
        renderList();
      });
    });

    // v3.20.44: Search bar handler with debounce
    let _ebSearchTimer = null;
    const _ebSearchInput = b.querySelector('#ebSearch');
    if (_ebSearchInput) {
      _ebSearchInput.addEventListener('input', () => {
        clearTimeout(_ebSearchTimer);
        _ebSearchTimer = setTimeout(() => {
          searchQuery = (_ebSearchInput.value || '').trim();
          renderList();
        }, 200);
      });
    }

    $('#ebCancel').addEventListener('click', closeSheet);
    $('#ebSave').addEventListener('click', async () => {
      const name = ($('#ebName').value || '').trim() || 'Bundle tanpa nama';
      const ids = Array.from(b._checkedSet || []);
      const noteIds = Array.from(b._checkedNotes || []);
      // v3.10.2 (Issue 5 fix): Ambil juga warna, inline prompt, saveAsPrompt
      const color = $('#ebColor')?.value || '';
      const inlinePrompt = ($('#ebInlinePrompt')?.value || '').trim();
      const inlineTitle = ($('#ebInlineTitle')?.value || '').trim();
      const saveAsPrompt = $('#ebSaveAsPrompt')?.checked || false;
      if (ids.length + noteIds.length < 1 && !inlinePrompt) { toast('Pilih minimal 1 item/catatan ATAU tulis prompt cepat inline', false); return; }
      // v3.10.2 (Issue 5 fix): Pass noteIds, color, inlinePrompt, saveAsPrompt ke updateBundle
      await updateBundle(bd.id, {
        name,
        itemIds: ids,
        injectOrder: ids,
        noteIds,
        color,
        inlinePrompt,
        inlineTitle,
        saveAsPrompt
      });
      closeSheet();
      await refreshVault();
      toast('Bundle diperbarui ✓ · ' + (ids.length + noteIds.length) + ' anggota'
            + (inlinePrompt ? ' + 1 prompt inline' : ''));
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
  // v3.12.0 (Fase 7): Untuk dokumen, pakai format jpeg (PWA simpan sebagai JPEG).
  const fmt = item.type === 'document' ? 'jpeg' : (item.screenshotFormat || 'png');
  const res = await browser.runtime.sendMessage({ type: 'DOWNLOAD_SCREENSHOT', id, title: item.title, format: fmt });
  if (res?.ok) toast(item.type === 'document' ? '📄 Download halaman pertama dimulai' : '🖼️ Download dimulai'); else toast('Gagal download: ' + (res?.error || ''), false);
}

// v3.11.6 (Issue 1 dari Google Doc): Salin screenshot dari Vault ke clipboard.
// withCaption=false → salin gambar saja (image/png)
// withCaption=true  → salin gambar + keterangan (image/png + text/html + text/plain)
// Karena popup/sidebar tidak bisa akses navigator.clipboard.write dengan image
// langsung di Firefox (perlu user gesture & secure context yang berbeda),
// v3.11.34: Direct clipboard.write dari popup context.
// SEBELUMNYA (v3.11.32-): delegate ke background → inject content script ke
// active tab → clipboard.write di active tab. Ini sering gagal karena:
//   1. User gesture dari klik popup hilang saat message ke background
//   2. Active tab bisa about:blank / moz-extension: / restricted URL
//   3. Content script clipboard permission berbeda dari popup context
//   → fallback ke download file → user lihat "malah di download"
//
// FIX v3.11.34: lakukan clipboard.write langsung di popup context. Popup punya
// `clipboardWrite` permission (lihat manifest.json), jadi navigator.clipboard.write
// jalan tanpa perlu inject ke active tab.
//
// Format text/html + text/plain di-build via lib/copy-format.js — SAMA PERSIS
// dengan yang dipakai preview modal (overlay.js) dan batch copy.
async function copyScreenshotToClipboard(id, withCaption) {
  const item = currentVault.items.find(i => i.id === id);
  if (!item) { toast('Item tidak ditemukan', false); return; }
  // v3.12.0 (Fase 7): Untuk dokumen, caption pakai buildDocumentCaption (📄 + halaman + note).
  const isDoc = item.type === 'document';
  try {
    toast(withCaption ? (isDoc ? '📦 Menyalin halaman + keterangan…' : '📦 Menyalin gambar + keterangan…') : (isDoc ? '📋 Menyalin halaman pertama…' : '📋 Menyalin gambar…'));

    // Ambil screenshot blob (data URL) dari storage.local
    // (untuk dokumen, GET_SCREENSHOT_BLOB mengembalikan halaman pertama — lihat supabase-sync.js)
    let dataUrl = null;
    try {
      const res = await browser.runtime.sendMessage({ type: 'GET_SCREENSHOT_BLOB', id });
      if (res?.ok && res.dataUrl) dataUrl = res.dataUrl;
    } catch (e) {
      console.warn('[RecallFox] GET_SCREENSHOT_BLOB failed:', e.message);
    }

    if (withCaption) {
      // Build caption — screenshot pakai buildScreenshotCaption, dokumen pakai buildDocumentCaption
      const cap = isDoc ? buildDocumentCaption(item, dataUrl) : buildScreenshotCaption(item, dataUrl);
      const result = await writeScreenshotToClipboard(dataUrl, cap.textPlain, cap.textHtml);
      if (result.ok) {
        toast(result.message || '✓ Gambar + keterangan tersalin');
      } else {
        // Fallback terakhir: download file (jarang terjadi)
        if (dataUrl) {
          try {
            const a = document.createElement('a');
            a.href = dataUrl;
            a.download = 'screenshot-' + Date.now() + '.png';
            document.body.appendChild(a);
            a.click();
            a.remove();
            toast('✓ Gambar di-download + keterangan disalin (clipboard tidak support)');
            // Tetap copy text
            try { await navigator.clipboard.writeText(cap.textPlain); } catch (e) {}
          } catch (e) {
            toast('Gagal salin: ' + (result.error || e.message), false);
          }
        } else {
          toast('Gagal salin: ' + (result.error || 'no_dataurl'), false);
        }
      }
    } else {
      // Image only — tanpa caption
      if (!dataUrl) { toast('Gambar tidak ditemukan di storage', false); return; }
      const result = await writeScreenshotToClipboard(dataUrl, '', '');
      if (result.ok) {
        toast(result.message || '✓ Gambar tersalin');
      } else {
        // Fallback: download
        try {
          const a = document.createElement('a');
          a.href = dataUrl;
          a.download = 'screenshot-' + Date.now() + '.png';
          document.body.appendChild(a);
          a.click();
          a.remove();
          toast('✓ Gambar di-download (clipboard tidak support)');
        } catch (e) {
          toast('Gagal salin: ' + (result.error || e.message), false);
        }
      }
    }
  } catch (e) {
    toast('Error: ' + e.message, false);
  }
}

// v3.11.36 (Sesi 2, Issue dari Google Doc): Salin Teks Metadata saja (tanpa gambar).
// User feedback: paste gambar+teks bersamaan tidak reliable antar aplikasi (AI chat,
// WhatsApp, Gemini). Solusi: copy text-only via navigator.clipboard.writeText.
// Format sama persis dengan textPlain dari buildScreenshotCaption (field yang sudah
// ada di lib/copy-format.js, tidak perlu fungsi baru). Cepat karena tidak fetch blob.
async function copyScreenshotMetaToClipboard(id) {
  const item = currentVault.items.find(i => i.id === id);
  if (!item) { toast('Item tidak ditemukan', false); return; }
  // v3.12.0 (Fase 7): Untuk dokumen, pakai buildDocumentCaption (text-only).
  const isDoc = item.type === 'document';
  try {
    toast('📝 Menyalin teks metadata…');
    // dataUrl = null → textPlain tetap lengkap (📸/📄, Sumber, Waktu, Mode, 📝 Catatan)
    const cap = isDoc ? buildDocumentCaption(item, null) : buildScreenshotCaption(item, null);
    if (!cap.textPlain) { toast('Tidak ada metadata untuk disalin', false); return; }
    await navigator.clipboard.writeText(cap.textPlain);
    toast('✓ Teks metadata tersalin (paste ke WA/Gemini/AI chat)');
  } catch (e) {
    console.warn('[RecallFox] copyScreenshotMetaToClipboard failed:', e.message);
    toast('Gagal salin teks: ' + e.message, false);
  }
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
      + (isShot ? '' : '<div><label>Isi <span class="field-hint">— pakai {{nama}} untuk variabel</span></label><textarea class="f" id="fBody" rows="4" placeholder="Isi prompt / konteks…">' + esc(it?.body || '') + '</textarea><div class="varchips" id="fVars"></div>'
        // v3.10.0 (Issue 5): Compose + Parafrase — tersedia di semua edit item (kecuali screenshot)
        + '<div style="display:flex;gap:6px;margin-top:6px">'
        +   '<button class="btn btn-g" id="fCompose" title="AI generate body dari judul — bisa diulang" style="flex:1;padding:6px 8px;font-size:11px">✨ Compose dengan AI</button>'
        +   '<button class="btn btn-g" id="fParafrase" title="AI parafrase body yang sudah ada — bisa diulang" style="flex:1;padding:6px 8px;font-size:11px">🔄 Parafrase</button>'
        + '</div></div>')
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

    // v3.10.0 (Issue 5): Compose + Parafrase untuk semua edit item
    const composeBtn = b.querySelector('#fCompose');
    const parafraseBtn = b.querySelector('#fParafrase');
    if (composeBtn) composeBtn.addEventListener('click', async () => {
      const titleVal = ($('#fTitle').value || '').trim();
      if (!titleVal) { toast('Isi judul dulu, lalu klik Compose'); return; }
      const orig = composeBtn.textContent;
      composeBtn.textContent = '⏳ Composing...';
      composeBtn.disabled = true;
      try {
        const { isAssistantConfigured, chatWithFallback } = await import('../lib/assistant.js');
        if (!(await isAssistantConfigured())) { toast('Setup AI Assistant dulu di Pengaturan'); return; }
        const sys = 'Anda adalah asisten yang menulis konten efektif. Berdasarkan judul dari user, tulis isi yang lengkap dan siap pakai. Maksimal 300 kata. Jawab HANYA isinya saja, tanpa penjelasan tambahan.';
        let acc = '';
        const resp = await chatWithFallback(
          [{ role: 'system', content: sys }, { role: 'user', content: 'Judul: "' + titleVal + '"\n\nTulis isi lengkap berdasarkan judul ini.' }],
          { onToken: (t) => { acc += t; if (body) { body.value = acc; body.dispatchEvent(new Event('input')); } } }
        );
        if (!acc && resp?.content && body) { body.value = resp.content; body.dispatchEvent(new Event('input')); }
        toast('✨ Isi di-generate. Klik lagi untuk varian lain.');
      } catch (e) { toast('Gagal compose: ' + e.message); }
      finally { composeBtn.textContent = orig; composeBtn.disabled = false; }
    });
    if (parafraseBtn) parafraseBtn.addEventListener('click', async () => {
      if (!body || !body.value.trim()) { toast('Isi body dulu, lalu klik Parafrase'); return; }
      const orig = parafraseBtn.textContent;
      parafraseBtn.textContent = '⏳ Parafrase...';
      parafraseBtn.disabled = true;
      try {
        const { isAssistantConfigured, chatWithFallback } = await import('../lib/assistant.js');
        if (!(await isAssistantConfigured())) { toast('Setup AI Assistant dulu di Pengaturan'); return; }
        const sys = 'Anda adalah asisten yang memparafrase teks agar lebih efektif, jelas, dan rapi. Pertahankan semua informasi penting. Bisa lebih panjang atau lebih pendek sesuai kebutuhan. Jawab HANYA teks hasil parafrase, tanpa penjelasan.';
        let acc = '';
        const resp = await chatWithFallback(
          [{ role: 'system', content: sys }, { role: 'user', content: 'Teks asli:\n\n' + body.value + '\n\nParafrase agar lebih efektif.' }],
          { onToken: (t) => { acc += t; body.value = acc; body.dispatchEvent(new Event('input')); } }
        );
        if (!acc && resp?.content) { body.value = resp.content; body.dispatchEvent(new Event('input')); }
        toast('🔄 Parafrase selesai. Klik lagi untuk varian lain.');
      } catch (e) { toast('Gagal parafrase: ' + e.message); }
      finally { parafraseBtn.textContent = orig; parafraseBtn.disabled = false; }
    });

    // v3.20.1: Auto-select judul saat modal edit dibuka (hanya kalau lagi edit existing
    //   item — bukan create new, karena create new input-nya kosong).
    //   User: "nama file ketika di pencet itu dalam kondisi terblok, sehingga bisa
    //   langsung di rename/ ditimpa untuk diberi nama baru."
    setTimeout(() => {
      const t = b.querySelector('#fTitle');
      if (!t) return;
      t.focus();
      if (existing) t.select();  // select-all supaya user bisa langsung timpa judul lama
    }, 120);
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
      + '<div><label>Judul</label><input class="f" id="pT" placeholder="mis. Review kode Go idiomatic…" autofocus></div>'
      // v3.9.0 (Issue 4): Tombol Compose dengan AI — judul singkat → body panjang
      + '<div style="display:flex;gap:6px;margin-bottom:6px">'
      +   '<button class="btn btn-g" id="pCompose" title="AI generate body lengkap dari judul — bisa diulang sampai pas" style="flex:1;padding:6px 8px;font-size:11px">✨ Compose dengan AI</button>'
      +   '<button class="btn btn-g" id="pParafrase" title="AI parafrase body yang sudah ada — bisa diulang" style="flex:1;padding:6px 8px;font-size:11px">🔄 Parafrase</button>'
      + '</div>'
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

    // v3.9.0 (Issue 4): Compose dengan AI — judul singkat → body lengkap. Bisa diulang.
    b.querySelector('#pCompose').addEventListener('click', async () => {
      const btn = b.querySelector('#pCompose');
      const title = ($('#pT').value || '').trim();
      if (!title) { toast('Isi judul dulu, lalu klik Compose'); return; }
      const orig = btn.textContent;
      btn.textContent = '⏳ AI composing...';
      btn.disabled = true;
      try {
        const { isAssistantConfigured, chatWithFallback, buildSystemPrompt } = await import('../lib/assistant.js');
        if (!(await isAssistantConfigured())) {
          toast('Setup AI Assistant dulu di Pengaturan (Groq gratis)');
          return;
        }
        const sys = 'Anda adalah asisten yang menulis prompt AI yang efektif. Berdasarkan judul singkat dari user, tulis body prompt lengkap yang siap pakai. Body harus: (1) jelas peran AI, (2) instruksi spesifik, (3) format output yang diharapkan. Gunakan {{variabel}} untuk parameter yang bisa diganti. Maksimal 200 kata. Jawab HANYA body prompt-nya saja, tanpa penjelasan tambahan.';
        const userMsg = 'Judul: "' + title + '"\n\nTulis body prompt lengkap berdasarkan judul ini.';
        let acc = '';
        const resp = await chatWithFallback(
          [{ role: 'system', content: sys }, { role: 'user', content: userMsg }],
          { onToken: (t) => { acc += t; body.value = acc; body.dispatchEvent(new Event('input')); } }
        );
        if (!acc && resp?.content) body.value = resp.content;
        body.dispatchEvent(new Event('input'));
        toast('✨ Body di-generate. Klik lagi untuk varian lain, atau edit manual.');
      } catch (e) {
        toast('Gagal compose: ' + e.message);
      } finally {
        btn.textContent = orig;
        btn.disabled = false;
      }
    });
    // v3.9.0 (Issue 4): Parafrase body yang sudah ada — bisa diulang sampai pas
    b.querySelector('#pParafrase').addEventListener('click', async () => {
      const btn = b.querySelector('#pParafrase');
      const currentBody = body.value.trim();
      if (!currentBody) { toast('Isi body dulu, lalu klik Parafrase'); return; }
      const orig = btn.textContent;
      btn.textContent = '⏳ AI parafrase...';
      btn.disabled = true;
      try {
        const { isAssistantConfigured, chatWithFallback } = await import('../lib/assistant.js');
        if (!(await isAssistantConfigured())) {
          toast('Setup AI Assistant dulu di Pengaturan (Groq gratis)');
          return;
        }
        const sys = 'Anda adalah asisten yang memparafrase prompt AI agar lebih efektif. Pertahankan semua instruksi penting, tetapi perbaiki: kejelasan, struktur, dan efektivitas. Bisa lebih panjang atau lebih pendek sesuai kebutuhan. Jawab HANYA prompt hasil parafrase, tanpa penjelasan.';
        const userMsg = 'Prompt asli:\n\n' + currentBody + '\n\nParafrase agar lebih efektif.';
        let acc = '';
        const resp = await chatWithFallback(
          [{ role: 'system', content: sys }, { role: 'user', content: userMsg }],
          { onToken: (t) => { acc += t; body.value = acc; body.dispatchEvent(new Event('input')); } }
        );
        if (!acc && resp?.content) body.value = resp.content;
        body.dispatchEvent(new Event('input'));
        toast('🔄 Parafrase selesai. Klik lagi untuk varian lain.');
      } catch (e) {
        toast('Gagal parafrase: ' + e.message);
      } finally {
        btn.textContent = orig;
        btn.disabled = false;
      }
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
      // v3.11.11 (Issue #2): Perjelas UX "Ambil dari halaman aktif".
      // User bingung: "fitur ambil konten ini kyknya eror karena loading terus tanpa
      // menghasilkan apa apa. kamu cek logika awal bangun 'simpan konteks' dan apa sih
      // ambil konten tu? baru perbaiki alogaritma nya dan caranya berinteraksi dengan
      // pengguna."
      // Fix: tambah hintbox penjelasan apa itu "Ambil Konten" + expected behavior.
      + '<div class="hintbox" style="margin:0 0 6px;font-size:11px;line-height:1.5">'
      +   '<b>💡 Ambil dari halaman aktif</b> = ekstrak teks utama dari tab yang sedang dibuka (mis. artikel Wikipedia, dokumentasi, blog). Hasilnya otomatis dimasukkan ke field Konteks di bawah. Bisa diklik berkali-kali untuk gabungkan beberapa halaman.'
      + '</div>'
      + '<div style="display:flex;gap:6px;margin-bottom:4px">'
      +   '<button class="btn btn-g" id="cGrabPage" style="flex:1;padding:6px 8px;font-size:11px" title="Ekstrak teks utama dari tab aktif → masukkan ke field Konteks">' + ICONS.spark + ' Ambil dari halaman aktif</button>'
      +   '<button class="btn btn-g" id="cAiSummarize" style="flex:1;padding:6px 8px;font-size:11px" title="AI meringkas halaman aktif jadi 200-300 kata">🤖 Ringkas dengan AI</button>'
      +   '<button class="btn btn-g" id="cFromTemplate" style="flex:1;padding:6px 8px;font-size:11px" title="Pilih template konteks siap pakai">📄 Dari template</button>'
      + '</div>'
      + '<div><label>Konteks</label><textarea class="f" id="cBody" rows="6" placeholder="Proyek ini pakai React + TypeScript, state Zustand…\n\nTujuan: ...\nStack: ...\nKonvensi: ..."></textarea>'
      // v3.10.0 (Issue 5): Compose + Parafrase untuk konteks
      + '<div style="display:flex;gap:6px;margin-top:6px">'
      +   '<button class="btn btn-g" id="cCompose" title="AI generate konteks dari judul — bisa diulang" style="flex:1;padding:6px 8px;font-size:11px">✨ Compose dengan AI</button>'
      +   '<button class="btn btn-g" id="cParafrase" title="AI parafrase konteks — bisa diulang" style="flex:1;padding:6px 8px;font-size:11px">🔄 Parafrase</button>'
      + '</div></div>'
      + '<div class="btn-row"><button class="btn btn-g" id="cCancel">Batal</button><button class="btn btn-p" id="cSave">' + ICONS.check + 'Simpan Konteks</button></div></div>';

    // v3.8.1 (Issue #4): "Ambil dari halaman aktif" — sekarang ROBUST.
    // Sebelumnya handler GET_PAGE_CONTEXT tidak ada di content script → tombol gagal diam-diam.
    // Sekarang: coba kirim ke content script dulu, kalau gagal fallback ke background
    // via browser.scripting.executeScript on-demand. Plus dapat body text halaman (bukan hanya metadata).
    let _lastPageContext = null; // cache untuk tombol AI summarize
    b.querySelector('#cGrabPage').addEventListener('click', async () => {
      const btn = b.querySelector('#cGrabPage');
      const orig = btn.textContent;
      btn.textContent = '⏳ Mengambil...';
      btn.disabled = true;
      try {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        if (!tabs[0]) { toast('Tidak ada tab aktif', false); return; }
        const tab = tabs[0];
        const title = tab.title || '';
        const url = tab.url || '';

        // Cek apakah URL http(s) — bukan about:, moz-extension:, dll
        if (!url || !/^https?:\/\//.test(url)) {
          toast('Halaman ini tidak bisa diambil kontennya (URL: ' + (url || 'kosong') + ')', false);
          return;
        }

        // v3.9.0 (Issue 3): Isi metadata (title, URL, tag) SEGERA — UX instant
        const bodyEl = $('#cBody');
        const titleEl = $('#cT');
        const tagEl = $('#cTag');
        if (titleEl && !titleEl.value.trim()) titleEl.value = title.slice(0, 60) || 'Konteks dari halaman';
        if (tagEl && !tagEl.value.trim() && url) {
          try { tagEl.value = new URL(url).hostname.replace(/^www\./, '').split('.')[0]; } catch (e) {}
        }
        // Update tombol: tahap 2 — ambil konten
        btn.textContent = '⏳ Ambil konten...';

        // Strategi 1: kirim ke content script (jika ter-inject) — cepat
        let pageContent = '';
        let ctxMeta = null;
        try {
          const res = await browser.tabs.sendMessage(tab.id, { type: 'GET_PAGE_CONTEXT', maxLen: 8000 });
          if (res?.ok && res.text) {
            pageContent = res.text;
            ctxMeta = res.meta || null;
          }
        } catch (e) {
          // Content script belum ter-inject — fallback via background
        }

        // Strategi 2: fallback via background (inject on-demand)
        if (!pageContent) {
          try {
            const res = await browser.runtime.sendMessage({ type: 'GET_PAGE_CONTEXT_VIA_BG', maxLen: 8000 });
            if (res?.ok && res.text) {
              pageContent = res.text;
              ctxMeta = res.meta || null;
            }
          } catch (e) {}
        }

        // Cache untuk tombol AI summarize
        _lastPageContext = { title, url, text: pageContent, meta: ctxMeta };

        // v3.9.0 (Issue 3): Isi body — metadata (title/tag) sudah diisi di tahap 1
        if (bodyEl) {
          // Append mode (bukan replace) — biar user bisa pakai tombol berkali-kali
          const existing = bodyEl.value.trim();
          const newBlock = '[Halaman: ' + title + ']\n[URL: ' + url + ']'
            + (pageContent ? '\n\n' + pageContent : '');
          bodyEl.value = existing ? (existing + '\n\n---\n\n' + newBlock) : newBlock;
        }

        // Toast jujur — kasih tahu kalau konten kosong
        if (pageContent) {
          const wc = ctxMeta?.wordCount || pageContent.split(/\s+/).length;
          toast('📋 Halaman diambil (' + wc + ' kata, ' + pageContent.length + ' char)');
        } else {
          toast('⚠️ Hanya metadata (konten halaman tidak bisa diakses)', false);
        }
      } catch (e) {
        toast('Gagal mengambil info halaman: ' + e.message, false);
      } finally {
        btn.textContent = orig;
        btn.disabled = false;
      }
    });

    // v3.8.1 (Issue #4): Tombol "Ringkas dengan AI" — pakai AI Assistant yang sudah ada
    // untuk meringkas halaman aktif jadi konteks ringkas (200-300 kata).
    // v3.9.0 (Issue 3): Smooth-kan — pakai async wait yang benar (bukan setTimeout fixed).
    b.querySelector('#cAiSummarize').addEventListener('click', async () => {
      const btn = b.querySelector('#cAiSummarize');
      const orig = btn.textContent;
      btn.textContent = '⏳ AI meringkas...';
      btn.disabled = true;
      try {
        // v3.9.0 (Issue 3): Kalau belum ada context ter-cache, ambil dulu (await proper)
        if (!_lastPageContext || !_lastPageContext.text) {
          // Trigger tombol Ambil dari halaman aktif secara programatik dan tunggu selesai
          const grabBtn = b.querySelector('#cGrabPage');
          // Click tombol grab dan tunggu handler async-nya selesai dengan polling state
          grabBtn.click();
          // Polling _lastPageContext sampai terisi atau timeout 10s
          const startTime = Date.now();
          while ((!_lastPageContext || !_lastPageContext.text) && Date.now() - startTime < 10000) {
            await new Promise(r => setTimeout(r, 100));
          }
        }
        if (!_lastPageContext || !_lastPageContext.text) {
          toast('Ambil konten halaman dulu sebelum AI meringkas', false);
          return;
        }

        // Cek AI Assistant terkonfigurasi
        const { isAssistantConfigured } = await import('../lib/assistant.js');
        const configured = await isAssistantConfigured();
        if (!configured) {
          toast('AI Assistant belum dikonfigurasi. Set API key di Settings dulu.', false);
          return;
        }

        const { chatWithFallback } = await import('../lib/assistant.js');
        const sysPrompt = 'Anda adalah asisten yang ahli meringkas halaman web menjadi konteks padat untuk AI lain. ' +
                          'Ringkas halaman berikut menjadi 200-300 kata, fokus pada: ' +
                          '(1) topik utama, (2) poin-poin penting, (3) data/angka kunci, (4) kesimpulan. ' +
                          'Gunakan Bahasa Indonesia. Format markdown ringkas. Jangan tambahkan komentar meta.';
        const userPrompt = 'Halaman: ' + _lastPageContext.title + '\nURL: ' + _lastPageContext.url +
                          '\n\nKonten halaman:\n' + _lastPageContext.text.slice(0, 6000);

        const result = await chatWithFallback([
          { role: 'system', content: sysPrompt },
          { role: 'user', content: userPrompt }
        ]);

        if (result?.content) {
          const bodyEl = $('#cBody');
          const existing = bodyEl.value.trim();
          const summaryBlock = '## 📋 Ringkasan AI: ' + _lastPageContext.title + '\n\n' + result.content +
                              '\n\n---\n[Sumber: ' + _lastPageContext.url + ']';
          bodyEl.value = existing ? (existing + '\n\n---\n\n' + summaryBlock) : summaryBlock;
          toast('✨ AI selesai meringkas (' + result.content.length + ' char)');
        } else {
          toast('AI tidak memberikan respons', false);
        }
      } catch (e) {
        toast('Gagal AI summarize: ' + e.message, false);
        console.warn('[RecallFox] AI summarize error:', e);
      } finally {
        btn.textContent = orig;
        btn.disabled = false;
      }
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

    // v3.10.0 (Issue 5): Compose + Parafrase untuk konteks
    const cComposeBtn = b.querySelector('#cCompose');
    const cParafraseBtn = b.querySelector('#cParafrase');
    if (cComposeBtn) cComposeBtn.addEventListener('click', async () => {
      const titleVal = ($('#cT').value || '').trim();
      if (!titleVal) { toast('Isi judul dulu, lalu klik Compose'); return; }
      const orig = cComposeBtn.textContent;
      cComposeBtn.textContent = '⏳ Composing...';
      cComposeBtn.disabled = true;
      try {
        const { isAssistantConfigured, chatWithFallback } = await import('../lib/assistant.js');
        if (!(await isAssistantConfigured())) { toast('Setup AI Assistant dulu di Pengaturan'); return; }
        const sys = 'Anda adalah asisten yang menulis konteks proyek yang efektif untuk AI. Berdasarkan judul, tulis konteks lengkap dengan: Tujuan, Stack/Teknologi, Konvensi, Catatan penting. Maksimal 300 kata. Jawab HANYA konteksnya.';
        let acc = '';
        const cBodyEl = $('#cBody');
        const resp = await chatWithFallback(
          [{ role: 'system', content: sys }, { role: 'user', content: 'Judul: "' + titleVal + '"\n\nTulis konteks lengkap.' }],
          { onToken: (t) => { acc += t; if (cBodyEl) cBodyEl.value = acc; } }
        );
        if (!acc && resp?.content && cBodyEl) cBodyEl.value = resp.content;
        toast('✨ Konteks di-generate. Klik lagi untuk varian lain.');
      } catch (e) { toast('Gagal compose: ' + e.message); }
      finally { cComposeBtn.textContent = orig; cComposeBtn.disabled = false; }
    });
    if (cParafraseBtn) cParafraseBtn.addEventListener('click', async () => {
      const cBodyEl = $('#cBody');
      if (!cBodyEl || !cBodyEl.value.trim()) { toast('Isi konteks dulu, lalu klik Parafrase'); return; }
      const orig = cParafraseBtn.textContent;
      cParafraseBtn.textContent = '⏳ Parafrase...';
      cParafraseBtn.disabled = true;
      try {
        const { isAssistantConfigured, chatWithFallback } = await import('../lib/assistant.js');
        if (!(await isAssistantConfigured())) { toast('Setup AI Assistant dulu di Pengaturan'); return; }
        const sys = 'Parafrase teks berikut agar lebih jelas, rapi, dan efektif. Pertahankan semua informasi penting. Jawab HANYA teks hasil parafrase.';
        let acc = '';
        const resp = await chatWithFallback(
          [{ role: 'system', content: sys }, { role: 'user', content: 'Teks asli:\n\n' + cBodyEl.value + '\n\nParafrase.' }],
          { onToken: (t) => { acc += t; cBodyEl.value = acc; } }
        );
        if (!acc && resp?.content) cBodyEl.value = resp.content;
        toast('🔄 Parafrase selesai. Klik lagi untuk varian lain.');
      } catch (e) { toast('Gagal parafrase: ' + e.message); }
      finally { cParafraseBtn.textContent = orig; cParafraseBtn.disabled = false; }
    });

    b.querySelector('#cSave').addEventListener('click', async () => {
      const t = ($('#cT').value || '').trim() || 'Konteks tanpa judul';
      const tg = ($('#cTag').value || '').trim() || 'baru';
      const tujuan = ($('#cTujuan')?.value || 'custom');
      const bodyVal = $('#cBody').value;
      // Jika tujuan dipilih, prepends header ke body
      const tujuanLabel = TUJUAN_OPTIONS.find(o => o[0] === tujuan);
      // v3.15.0 P0-K2: STOP prepend [Tujuan: ...] ke body.
      // Sebelumnya: tujuan ditempel jadi teks di awal body sebagai kompensasi karena
      // contextPurpose tidak di-persist. Sekarang contextPurpose di-persist sebagai
      // field terpisah (context_purpose column di DB) + tampil sebagai badge di vault list.
      // Body tetap bersih — tidak ikut ter-inject ke chat AI sebagai teks sampah.
      const finalBody = bodyVal;
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
  openSheet('📦 Buat Bundle', 'Pilih item + catatan, tambah prompt cepat inline (opsional)', b => {
    // v3.8.1 (Issue #5a): Bundle sekarang dukung CATATAN sebagai anggota.
    // v3.8.1 (Issue #5d): Item di-sort per tipe + badge warna (bukan cuma teks).
    // Sertakan juga screenshot & snapshot (v3.7.2 Issue 1).
    // v3.10.2 (Issue 3 fix): Tambah filter per tipe — selaras dengan Edit Bundle.
    const TYPE_ORDER = { prompt: 1, context: 2, link: 3, screenshot: 4, snapshot: 5, file: 6 };
    const itemCandidates = (currentVault?.items || []).filter(i =>
      ['prompt', 'context', 'link', 'screenshot', 'snapshot', 'file'].includes(i.type) && !i.archived
    ).sort((a, c) => (TYPE_ORDER[a.type] || 99) - (TYPE_ORDER[c.type] || 99) ||
                       (a.title || '').localeCompare(c.title || ''));
    const noteCandidates = (currentNotes || []).filter(n => !n.archived);

    b.innerHTML = '<div class="sheet-form">'
      + '<div><label>Nama Bundle</label><input class="f" id="bT" placeholder="mis. Riset kompetitor…"></div>'
      + '<div><label>Warna label <span class="field-hint">(opsional, untuk sort visual)</span></label>'
      +   '<select class="f" id="bColor">'
      +     '<option value="">— Tanpa warna —</option>'
      +     '<option value="orange">🟠 Oranye</option>'
      +     '<option value="green">🟢 Hijau</option>'
      +     '<option value="blue">🔵 Biru</option>'
      +     '<option value="purple">🟣 Ungu</option>'
      +     '<option value="pink">🩷 Merah Muda</option>'
      +     '<option value="red">🔴 Merah</option>'
      +   '</select></div>'
      + '<div><label>Prompt cepat <span class="field-hint">(opsional — tulis prompt langsung tanpa bikin item dulu)</span></label>'
      +   '<input class="f" id="bInlineTitle" placeholder="Judul prompt (opsional)" style="margin-bottom:4px">'
      +   '<textarea class="f" id="bInlinePrompt" rows="3" placeholder="Tulis prompt cepat — akan di-inject sebagai prompt tambahan saat bundle dipakai..."></textarea>'
      +   '<label class="checkrow" style="display:flex;align-items:center;gap:6px;font-size:11px;margin-top:4px">'
      +     '<input type="checkbox" id="bSaveAsPrompt"> Simpan juga sebagai item Prompt tersendiri (default: mati)'
      +   '</label></div>'
      // v3.20.44: Tambah search bar + File filter chip
      + '<div><label>Cari item <span class="field-hint">(judul, tag, konten)</span></label>'
      +   '<input class="f" id="bSearch" placeholder="🔍 Cari item..." style="margin-bottom:8px"></div>'
      + '<div><label>Filter per tipe <span class="field-hint">(klik untuk filter)</span></label>'
      +   '<div class="eb-filters" style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">'
      +     '<button class="chip eb-filter on" data-cat="all" style="font-size:10.5px;padding:3px 9px">Semua</button>'
      +     '<button class="chip eb-filter" data-cat="prompt" style="font-size:10.5px;padding:3px 9px;border-left:3px solid var(--primary)">💬 Prompt</button>'
      +     '<button class="chip eb-filter" data-cat="context" style="font-size:10.5px;padding:3px 9px;border-left:3px solid var(--violet)">📋 Konteks</button>'
      +     '<button class="chip eb-filter" data-cat="link" style="font-size:10.5px;padding:3px 9px;border-left:3px solid #0891b2">🔗 Link</button>'
      +     '<button class="chip eb-filter" data-cat="screenshot" style="font-size:10.5px;padding:3px 9px;border-left:3px solid var(--green)">🖼️ Media</button>'
      +     '<button class="chip eb-filter" data-cat="snapshot" style="font-size:10.5px;padding:3px 9px;border-left:3px solid var(--amber)">📸 Snapshot</button>'
      +     '<button class="chip eb-filter" data-cat="file" style="font-size:10.5px;padding:3px 9px;border-left:3px solid #6366f1">📄 File</button>'
      +     '<button class="chip eb-filter" data-cat="note" style="font-size:10.5px;padding:3px 9px;border-left:3px solid #ca8a04">📝 Catatan</button>'
      +   '</div></div>'
      + '<div><label>Pilih item <span class="field-hint" id="bCount">0 dipilih</span></label>'
      +   '<div class="picklist" id="bList"></div></div>'
      + '<div class="btn-row"><button class="btn btn-g" id="bCancel">Batal</button><button class="btn btn-p" id="bSave">' + ICONS.check + 'Buat Bundle</button></div></div>';

    // v3.10.2 (Issue 3 fix): Render list dengan filter, tracking checked via Set
    const listBox = b.querySelector('#bList');
    let activeFilter = 'all';
    let searchQuery = '';
    // Set untuk track item + note yang tercentang (id unik jadi tidak tabrakan)
    b._checkedItems = new Set();
    b._checkedNotes = new Set();

    function renderList() {
      let html = '';
      // v3.20.44: Apply search filter + type filter
      const filteredItems = (activeFilter === 'all' || activeFilter === 'note'
        ? itemCandidates
        : itemCandidates.filter(it => it.type === activeFilter)
      ).filter(it => {
        if (!searchQuery) return true;
        const q = searchQuery.toLowerCase();
        return (it.title || '').toLowerCase().includes(q)
          || (it.body || '').toLowerCase().includes(q)
          || (it.tags || []).some(t => t.toLowerCase().includes(q));
      });
      for (const it of filteredItems) {
        const T = TYPE[it.type] || { icon: '', label: it.type };
        const checked = b._checkedItems.has(it.id) ? ' checked' : '';
        html += '<label class="pickrow"><input type="checkbox" value="' + it.id + '" data-kind="item"' + checked + '>'
          + '<span class="item-ic t-' + it.type + '" style="width:18px;height:18px;font-size:11px;flex-shrink:0">' + T.icon + '</span>'
          + '<span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(it.title) + '</span>'
          + '<span class="pt-type" style="font-size:10px;color:#888">' + T.label + '</span></label>';
      }
      // Notes (tampil kalau filter = all atau note)
      if ((activeFilter === 'all' || activeFilter === 'note') && noteCandidates.length > 0) {
        html += '<div style="margin-top:8px;padding-top:6px;border-top:1px dashed #ccc;font-size:11px;color:#666">— Catatan (Notepad) —</div>';
        for (const n of noteCandidates) {
          const noteTitle = n.title || stripHtmlForPreview(n.body || '').slice(0, 50) || 'Catatan';
          const checked = b._checkedNotes.has(n.id) ? ' checked' : '';
          html += '<label class="pickrow"><input type="checkbox" value="' + n.id + '" data-kind="note"' + checked + '>'
            + '<span class="item-ic t-note" style="width:18px;height:18px;font-size:11px;flex-shrink:0">📝</span>'
            + '<span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(noteTitle) + '</span>'
            + '<span class="pt-type" style="font-size:10px;color:#888">catatan</span></label>';
        }
      }
      listBox.innerHTML = html;
      // Bind change handlers
      listBox.querySelectorAll('input[type=checkbox]').forEach(cb => {
        cb.addEventListener('change', () => {
          if (cb.dataset.kind === 'note') {
            if (cb.checked) b._checkedNotes.add(cb.value);
            else b._checkedNotes.delete(cb.value);
          } else {
            if (cb.checked) b._checkedItems.add(cb.value);
            else b._checkedItems.delete(cb.value);
          }
          b.querySelector('#bCount').textContent = (b._checkedItems.size + b._checkedNotes.size) + ' dipilih';
        });
      });
    }
    renderList();

    // Filter chip handlers
    b.querySelectorAll('.eb-filter').forEach(btn => {
      btn.addEventListener('click', () => {
        b.querySelectorAll('.eb-filter').forEach(c => c.classList.remove('on'));
        btn.classList.add('on');
        activeFilter = btn.dataset.cat;
        renderList();
      });
    });

    // v3.20.44: Search bar handler with debounce
    let _searchTimer = null;
    const _searchInput = b.querySelector('#bSearch');
    if (_searchInput) {
      _searchInput.addEventListener('input', () => {
        clearTimeout(_searchTimer);
        _searchTimer = setTimeout(() => {
          searchQuery = (_searchInput.value || '').trim();
          renderList();
        }, 200);
      });
    }

    b.querySelector('#bCancel').addEventListener('click', closeSheet);
    b.querySelector('#bSave').addEventListener('click', async () => {
      const totalChecked = b._checkedItems.size + b._checkedNotes.size;
      const inlinePrompt = (b.querySelector('#bInlinePrompt')?.value || '').trim();
      const saveAsPrompt = b.querySelector('#bSaveAsPrompt')?.checked || false;
      // Validasi: minimal 2 item ATAU ada inlinePrompt
      if (totalChecked < 2 && !inlinePrompt) {
        toast('Pilih minimal 2 item ATAU tulis prompt cepat inline', false);
        return;
      }
      const name = (b.querySelector('#bT')?.value || '').trim() || 'Bundle tanpa nama';
      const color = b.querySelector('#bColor')?.value || '';
      const itemIds = Array.from(b._checkedItems);
      const noteIds = Array.from(b._checkedNotes);
      const inlineTitle = (b.querySelector('#bInlineTitle')?.value || '').trim();
      // v3.8.1: addBundle sekarang terima opts { color, noteIds, inlinePrompt, inlineTitle, saveAsPrompt }
      await addBundle(name, itemIds, {
        color,
        noteIds,
        inlinePrompt,
        inlineTitle,
        saveAsPrompt
      });
      closeSheet(); await refreshVault();
      toast('Bundle "' + name + '" dibuat ✓ · ' + (itemIds.length + noteIds.length) + ' anggota'
            + (inlinePrompt ? ' + 1 prompt inline' : '')
            + (saveAsPrompt ? ' (prompt disimpan juga)' : ''));
    });
  });
}
async function snapshotFlow() {
  if (!currentAiDomain) { toast('📸 Snapshot hanya aktif di halaman AI', false); return; }
  toast('Menganalisis percakapan…');
  try {
    const res = await browser.runtime.sendMessage({ type: 'QUICK_SNAPSHOT' });
    if (res?.ok && res.body) {
      // v3.16.1: Tampilkan modal preview di popup context (bukan di tab).
      // Sebelumnya: QUICK_SNAPSHOT buka modal di tab, popup close terlalu cepat → user tidak lihat.
      // Sekarang: popup handle modal + save → user pasti lihat di sidebar.
      openSnapshotPreviewSheet(res);
    } else if (res?.ok && !res.body) {
      toast('Tidak ada percakapan terdeteksi di halaman ini', false);
    } else {
      const err = res?.error || 'gagal';
      let msg = 'Gagal';
      if (err === 'no_active_tab') msg = 'Tidak ada tab aktif';
      else if (err === 'not_ai_domain') msg = 'Bukan halaman AI (buka ChatGPT/Claude/Gemini/dll)';
      else if (err.includes('Could not establish connection')) msg = 'Bukan halaman AI';
      else msg = 'Error: ' + String(err).slice(0, 40);
      toast(msg, false);
    }
  } catch (e) { toast('Error: ' + e.message, false); }
}

// v3.16.1: Modal preview snapshot di popup context — user isi title/tags, klik save.
// S5: Tampilkan notifikasi "N pesan · dipotong?" kalau ada pesan yang ter-truncate.
// S6: Debug info dipindah ke console.debug (tidak ditampilkan ke user).
function openSnapshotPreviewSheet(data) {
  const body = data.body || '';
  const msgCount = data.snapshotMessageCount || 0;
  const domain = data.snapshotDomain || '';
  const pageTitle = data.pageTitle || '';
  const url = data.url || '';
  const hasContent = body.length > 0;
  const summary = hasContent
    ? (body.slice(0, 400) + (body.length > 400 ? '...' : ''))
    : '(Tidak ada percakapan terdeteksi)';
  // v3.16.1 S5: Notifikasi potong — kalau body mendekati 50 pesan atau ada truncation
  const MAX_MSGS = 50;
  const isTruncated = msgCount >= MAX_MSGS || body.includes('...[truncated]');
  const truncNote = isTruncated
    ? '<div class="hintbox" style="font-size:11px;color:#92400e;background:#fef3c7;padding:6px 8px;border-radius:4px;margin-top:6px">⚠️ ' + (msgCount >= MAX_MSGS ? 'Hanya ' + MAX_MSGS + ' pesan terakhir diambil' : 'Beberapa pesan dipotong') + ' — percakapan panjang mungkin tidak lengkap</div>'
    : '';
  // v3.16.1 S6: Debug info ke console, bukan UI
  if (data.debug) console.debug('[RecallFox] Snapshot debug:', data.debug);

  const titleGuess = (pageTitle || 'Snapshot ' + new Date().toLocaleString('id-ID')).slice(0, 80);
  openSheet('📸 Snapshot Percakapan', domain + (msgCount ? ' · ' + msgCount + ' pesan' : ''), b => {
    b.innerHTML = '<div class="sheet-form">'
      + '<div class="hintbox" style="font-size:11px;line-height:1.55">Sumber: <b>' + esc(pageTitle) + '</b><br>Domain: ' + esc(domain) + ' · ' + msgCount + ' pesan</div>'
      + truncNote
      + '<div><label>Judul</label><input class="f" id="snapTitle" value="' + esc(titleGuess) + '"></div>'
      + '<div><label>Tag <span class="field-hint">(pisah koma)</span></label><input class="f" id="snapTags" placeholder="debug, chatgpt, ..." value="snapshot, ' + esc(domain) + '"></div>'
      + '<div><label>Preview (400 char pertama)</label><div class="hintbox" style="font-size:11px;max-height:120px;overflow-y:auto;white-space:pre-wrap">' + esc(summary) + '</div></div>'
      + '<div><label>Catatan <span class="field-hint">(opsional)</span></label><textarea class="f" id="snapNote" rows="2" placeholder="Catatan tambahan..."></textarea></div>'
      + '<div class="btn-row"><button class="btn btn-g" id="snapCancel">Batal</button>'
      + '<button class="btn btn-p" id="snapSave">' + ICONS.check + 'Simpan Snapshot</button></div></div>';
    b.querySelector('#snapCancel').addEventListener('click', closeSheet);
    b.querySelector('#snapSave').addEventListener('click', async () => {
      const title = b.querySelector('#snapTitle').value.trim() || 'Snapshot';
      const tags = b.querySelector('#snapTags').value.split(',').map(s => s.trim()).filter(Boolean);
      const note = b.querySelector('#snapNote').value.trim();
      closeSheet();
      toast('📸 Menyimpan snapshot...');
      try {
        const res = await browser.runtime.sendMessage({
          type: 'CAPTURE_SNAPSHOT',
          title, body, tags,
          url, pageTitle,
          snapshotDomain: domain,
          snapshotMessageCount: msgCount,
          note
        });
        if (res?.ok) {
          await refreshVault();
          toast('📸 Snapshot tersimpan ✓ · ' + msgCount + ' pesan');
        } else {
          toast('Gagal simpan: ' + (res?.error || 'unknown'), false);
        }
      } catch (e) {
        toast('Gagal simpan: ' + e.message, false);
      }
    });
  });
}
async function doShot(mode) {
  // mode: 'entire' | 'visible' | 'selection' | 'upload' | undefined (shows picker)
  // Guard against accidental event-object args (defensive: doShot must never
  // receive a PointerEvent — if it does, treat as undefined to show picker)
  if (mode && typeof mode !== 'string') mode = undefined;

  // v3.8.1 (Issue #3): Mode 'upload' → buka form upload manual
  if (mode === 'upload') {
    saveScreenshotManualSheet();
    return;
  }

  // v3.11.7-fix (Issue #1): Kalau tidak ada mode spesifik, tampilkan picker
  // dengan pilihan mode + tingkat kompresi (sedikit/sedang/tinggi/lossless).
  // Default kompresi = "high" (JPEG q60) supaya upload GDrive berhasil.
  if (!mode) {
    openShotPickerSheet();
    return;
  }

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

// v3.11.7-fix2 (Sesi 7, Issue #2): Shot picker sheet — SIMPLIFIED jadi 2 klik saja.
// User feedback: "harusnya tidak jauh dari dua kali klik saja misal mau ganti kualitas,
// terus langsung saja pilih salah satu dari Bagian Seluruh, Seleksi Terlihat, Halaman Area.
// Tombol Batal dan Tangkap hilangkan saja, misal tidak jadi screenshot tinggal klik area
// lain. atau ketika sudah mau selection area yang mau di screenshot tinggal pencet esc."
//
// Flow sekarang (2 klik):
//   1. Klik tombol Shot (di hero tiles atau alat)
//   2. Klik salah satu mode (Visible/Entire/Selection) → LANGSUNG capture pakai
//      kompresi yang sedang dipilih di dropdown
//
// Untuk ganti kompresi: tinggal ubah dropdown dulu, lalu klik mode. Tidak perlu tombol
// "Tangkap" terpisah. Tidak ada tombol "Batal" — ESC di sheet bawah bisa tutup sheet,
// atau klik di luar sheet (di scrim).
function openShotPickerSheet() {
  const s = currentVault?.settings || {};
  const currentComp = s.screenshotCompression || 'lossless';
  openSheet('🖼️ Tangkap Layar', 'Pilih mode tangkap · ESC atau klik luar untuk batal', b => {
    b.innerHTML = '<div class="sheet-form">'
      + '<div><label>Mode tangkap <span class="field-hint">(klik untuk langsung capture)</span></label>'
      +   '<div class="shot-mode-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:4px">'
      +     '<button class="btn btn-g shot-mode-btn" data-mode="visible" style="padding:10px 4px;font-size:11px;line-height:1.3">📱<br>Bagian Terlihat</button>'
      +     '<button class="btn btn-g shot-mode-btn" data-mode="entire" style="padding:10px 4px;font-size:11px;line-height:1.3">📄<br>Seluruh Halaman</button>'
      +     '<button class="btn btn-g shot-mode-btn" data-mode="selection" style="padding:10px 4px;font-size:11px;line-height:1.3">✂️<br>Seleksi Area</button>'
      +   '</div></div>'
      + '<div><label>Tingkat kompresi <span class="field-hint">(ubah dulu sebelum pilih mode)</span></label>'
      +   '<select class="f" id="shotComp" style="margin-top:4px">'
      +     '<option value="high"' + (currentComp === 'high' ? ' selected' : '') + '>Tinggi (JPEG q60) — recommended, ~200-800KB</option>'
      +     '<option value="medium"' + (currentComp === 'medium' ? ' selected' : '') + '>Sedang (JPEG q75) — ~500KB-1.5MB</option>'
      +     '<option value="low"' + (currentComp === 'low' ? ' selected' : '') + '>Sedikit (JPEG q90) — ~1-3MB</option>'
      +     '<option value="lossless"' + (currentComp === 'lossless' ? ' selected' : '') + '>Lossless (PNG) — besar, kualitas terbaik</option>'
      +   '</select></div>'
      + '<div class="hintbox" style="font-size:10.5px">💡 <b>Tinggi</b> = upload GDrive selalu berhasil (di bawah limit Apps Script ~10MB). <b>Lossless</b> = kualitas terbaik tapi ukuran besar. Klik mode di atas untuk langsung capture — tidak perlu tombol lain.</div>'
      + '</div>';

    // v3.11.7-fix2: HAPUS tombol "Batal" dan "Tangkap". Klik mode = langsung capture.
    // User bisa batal dengan: (1) ESC keyboard (closeSheet sudah handle), (2) klik di
    // scrim (area di luar sheet, closeSheet sudah handle via scrim click handler).
    // Untuk selection mode, ESC selama selection overlay juga batal capture (sudah ada).

    b.querySelectorAll('.shot-mode-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const selectedMode = btn.dataset.mode;
        const comp = b.querySelector('#shotComp').value;
        // Save compression ke settings supaya captureFullPage pakai compression baru
        if (comp !== currentComp) {
          await saveSettings({ screenshotCompression: comp });
        }
        closeSheet();
        // Trigger shot dengan mode terpilih — langsung capture, tanpa konfirmasi tambahan
        doShot(selectedMode);
      });
    });
  });
}

// v3.8.1 (Issue #3): Upload manual screenshot — untuk screenshot dari luar web
// (desktop, aplikasi lain, file PNG/JPG existing). User bisa:
//   - Klik "Pilih file" → file picker
//   - Paste dari clipboard (Ctrl+V)
//   - Drag & drop file ke area dropzone
// Setelah simpan, item masuk ke vault + sync ke GDrive (jika aktif).
function saveScreenshotManualSheet() {
  openSheet('🖼️ Upload Screenshot Manual', 'Pilih file gambar, paste dari clipboard, atau drag & drop', b => {
    b.innerHTML = '<div class="sheet-form">'
      + '<div><label>Judul <span class="field-hint">(opsional — kosongkan untuk pakai filename)</span></label>'
      +   '<input class="f" id="shT" placeholder="mis. Bukti transfer bank..."></div>'
      + '<div><label>Tag <span class="field-hint">(pisah koma)</span></label>'
      +   '<input class="f" id="shTag" placeholder="bukti, keuangan"></div>'
      // Dropzone
      + '<div id="shDropzone" style="border:2px dashed #c0c0c0;border-radius:8px;padding:24px;text-align:center;color:#666;cursor:pointer;margin:8px 0;transition:all 0.2s">'
      +   '<div style="font-size:32px;margin-bottom:8px">📷</div>'
      +   '<div style="font-weight:600;color:#333">Klik untuk pilih file</div>'
      +   '<div style="font-size:11px;margin-top:4px">atau drag & drop, atau paste (Ctrl+V)</div>'
      +   '<div style="font-size:10px;margin-top:4px;color:#999">Format: PNG, JPG, JPEG, GIF, WEBP (max 10MB)</div>'
      + '</div>'
      + '<input type="file" id="shFileInput" accept="image/*" style="display:none">'
      // Preview
      + '<div id="shPreview" style="display:none;margin:8px 0">'
      +   '<img id="shPreviewImg" style="max-width:100%;max-height:200px;border-radius:6px;border:1px solid #ddd">'
      +   '<div style="font-size:11px;color:#666;margin-top:4px" id="shPreviewMeta"></div>'
      + '</div>'
      + '<div class="btn-row"><button class="btn btn-g" id="shCancel">Batal</button>'
      +   '<button class="btn btn-p" id="shSave" disabled>' + ICONS.check + 'Simpan Screenshot</button></div></div>';

    let _dataUrl = null;
    let _filename = '';

    const dropzone = b.querySelector('#shDropzone');
    const fileInput = b.querySelector('#shFileInput');

    // Klik dropzone → trigger file picker
    dropzone.addEventListener('click', () => fileInput.click());

    // File picker change
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file) await _handleFile(file);
    });

    // Drag & drop
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.style.borderColor = '#FF7139';
      dropzone.style.background = '#FFF4E6';
    });
    dropzone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dropzone.style.borderColor = '#c0c0c0';
      dropzone.style.background = '';
    });
    dropzone.addEventListener('drop', async (e) => {
      e.preventDefault();
      dropzone.style.borderColor = '#c0c0c0';
      dropzone.style.background = '';
      const file = e.dataTransfer.files[0];
      if (file) await _handleFile(file);
    });

    // Paste from clipboard
    async function _pasteHandler(e) {
      const items = e.clipboardData?.items || [];
      for (const it of items) {
        if (it.type.startsWith('image/')) {
          const file = it.getAsFile();
          if (file) {
            await _handleFile(file);
            e.preventDefault();
            break;
          }
        }
      }
    }
    document.addEventListener('paste', _pasteHandler);

    // Cleanup paste handler saat sheet ditutup — pakai MutationObserver pada scrim
    // (jangan override closeSheet global, itu bisa break flow lain)
    const _cleanupPaste = () => {
      document.removeEventListener('paste', _pasteHandler);
    };
    // Pasang observer ke tombol Cancel & Save (yang panggil closeSheet)
    b.querySelector('#shCancel').addEventListener('click', _cleanupPaste);
    // Save button cleanup setelah sukses (closeSheet dipanggil di handler save)
    // Plus observer pada scrim class change sebagai fallback
    const scrim = $('#scrim');
    if (scrim) {
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.attributeName === 'class' && !scrim.classList.contains('show')) {
            _cleanupPaste();
            observer.disconnect();
            break;
          }
        }
      });
      observer.observe(scrim, { attributes: true, attributeFilter: ['class'] });
    }

    async function _handleFile(file) {
      if (!file.type.startsWith('image/')) {
        toast('File bukan gambar: ' + file.type, false);
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        toast('File terlalu besar (max 10MB)', false);
        return;
      }
      try {
        // Baca sebagai data URL
        const reader = new FileReader();
        const dataUrl = await new Promise((resolve, reject) => {
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        _dataUrl = dataUrl;
        _filename = file.name;
        // Preview
        const previewImg = b.querySelector('#shPreviewImg');
        const previewMeta = b.querySelector('#shPreviewMeta');
        const previewBox = b.querySelector('#shPreview');
        previewImg.src = dataUrl;
        const sizeKb = (file.size / 1024).toFixed(1);
        previewMeta.textContent = '📎 ' + file.name + ' · ' + sizeKb + ' KB · ' + file.type;
        previewBox.style.display = '';
        // Enable save button
        b.querySelector('#shSave').disabled = false;
        // Auto-fill title kalau kosong
        const titleEl = b.querySelector('#shT');
        if (!titleEl.value.trim()) {
          titleEl.value = file.name.replace(/\.[^.]+$/, '').slice(0, 60);
        }
        toast('📋 Gambar dimuat — klik Simpan untuk menyimpan');
      } catch (e) {
        toast('Gagal membaca file: ' + e.message, false);
      }
    }

    b.querySelector('#shCancel').addEventListener('click', closeSheet);
    b.querySelector('#shSave').addEventListener('click', async () => {
      if (!_dataUrl) { toast('Pilih file dulu', false); return; }
      const title = (b.querySelector('#shT').value || '').trim() || _filename || 'Screenshot Upload';
      const tags = (b.querySelector('#shTag').value || '').trim();
      const tagList = tags ? tags.split(',').map(s => s.trim()).filter(Boolean) : ['upload'];

      const btn = b.querySelector('#shSave');
      const orig = btn.textContent;
      btn.textContent = '⏳ Menyimpan...';
      btn.disabled = true;
      try {
        const result = await browser.runtime.sendMessage({
          type: 'SAVE_UPLOADED_SCREENSHOT',
          title,
          dataUrl: _dataUrl,
          source: {
            kind: 'upload',
            url: '',
            title: _filename || title,
            filename: _filename,
            uploadedAt: new Date().toISOString()
          }
        });
        if (result?.ok) {
          closeSheet(); await refreshVault();
          toast('🖼️ Screenshot upload disimpan ✓');
        } else {
          toast('Gagal simpan: ' + (result?.error || 'unknown'), false);
          btn.textContent = orig;
          btn.disabled = false;
        }
      } catch (e) {
        toast('Error: ' + e.message, false);
        btn.textContent = orig;
        btn.disabled = false;
      }
    });
  });
}

// ============ AI Tools launcher ============
function aiToolsSheet() {
  openSheet('Alat AI', 'Pilih alat AI — buka di tab baru', b => {
    // v3.11.1 (Issue 4): Pakai effective tools (built-in + custom + pinned/hidden flags)
    const customizations = (currentVault?.settings?.aiToolsCustomizations) || {};
    const effectiveTools = getEffectiveTools(customizations);
    const visible = effectiveTools.filter(t => !t.hidden);
    const pinned = visible.filter(t => t.pinned);
    const others = visible.filter(t => !t.pinned);
    const row = (t) => '<button class="act" data-url="' + esc(t.url) + '" data-name="' + esc(t.name) + '">'
      + '<span style="font-size:18px;flex:none;width:24px;text-align:center">' + (t.emoji || '🤖') + '</span>'
      + '<div style="flex:1"><div>' + esc(t.name) + (t.custom ? ' <span style="font-size:9px;background:var(--violet-soft);color:var(--violet);padding:1px 5px;border-radius:4px;font-weight:700;margin-left:4px">CUSTOM</span>' : '') + (t.pinned ? ' <span style="color:var(--amber)">⭐</span>' : '') + '</div>'
      + '<div class="ad">' + esc(t.url) + '</div></div>'
      + '<span class="ad">Buka →</span></button>';
    let html = '';
    // v3.11.1: Tombol "Kelola Situs AI" di paling atas
    html += '<button class="act" id="aiManageBtn" style="background:var(--primary-soft);border:1px dashed var(--primary);margin-bottom:8px">'
      + '<span style="font-size:18px;flex:none;width:24px;text-align:center">⚙️</span>'
      + '<div style="flex:1"><div style="color:var(--primary);font-weight:700">Kelola Situs AI</div>'
      + '<div class="ad">Pin / sembunyikan / tambah situs custom</div></div>'
      + '<span class="ad">' + visible.length + ' aktif →</span></button>';
    if (pinned.length) html += '<div class="sec-label" style="padding:4px 10px">⭐ Sering dipakai (' + pinned.length + ')</div>' + pinned.map(row).join('');
    const groups = groupByRegion(others);
    for (const [region, tools] of Object.entries(groups)) {
      if (!tools.length) continue;
      const regionLabel = { local: '🇮🇩 LOKAL', west: '🌍 BARAT', china: '🇨🇳 CHINA' }[region] || region.toUpperCase();
      html += '<div class="sec-label" style="padding:8px 10px 4px">' + regionLabel + ' (' + tools.length + ')</div>' + tools.map(row).join('');
    }
    b.innerHTML = html;
    // Bind "Kelola Situs AI" button
    const manageBtn = b.querySelector('#aiManageBtn');
    if (manageBtn) manageBtn.addEventListener('click', () => {
      closeSheet();
      setTimeout(() => toolPage('aimanage'), 80);
    });
    // Bind AI tool rows
    b.querySelectorAll('.act[data-url]').forEach(a => a.addEventListener('click', async () => {
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
      ['📤 Upload gambar (manual)', () => doShot('upload')],   // v3.8.1 Issue #3
      // v3.20.42: Upload file teks pakai modal standar (sama seperti screenshot manual)
      ['📄 Upload File teks', saveFileUploadSheet],
      ['📝 Catatan', () => { setView('notes'); newNote(); }]
    ];
    b.innerHTML = opts.map((o, i) => '<button class="act" data-i="' + i + '">' + o[0] + '</button>').join('');
    b.querySelectorAll('.act').forEach(a => a.addEventListener('click', (ev) => {
      const opt = opts[a.dataset.i];
      const label = opt[0];
      // v3.20.42: Upload gambar + Upload File teks buka sheet sendiri — JANGAN closeSheet()
      if (label.includes('Upload gambar') || label.includes('Upload File')) {
        opt[1]();
      } else {
        closeSheet();
        setTimeout(opt[1], 80);
      }
    }));
    b.insertAdjacentHTML('beforeend', '<div class="sheet-note">💡 Screenshot punya 4 mode: <b>area</b> (seret kotak), <b>viewport</b> (bagian terlihat), <b>seluruh halaman</b> (scroll-stitch), <b>upload manual</b> (file dari disk / paste clipboard). Upload File teks support .md/.txt/.json/.html/.csv/.yaml (maks 2MB).</div>');
  });
}

// v3.20.42: Upload File Teks — modal standar (mirror saveScreenshotManualSheet)
// Punya: Judul (opsional), Tag (opsional), area upload (klik/drag&drop), Batal, Simpan
// Format: .md/.txt/.json/.html/.csv/.yaml (max 2MB)
function saveFileUploadSheet() {
  openSheet('📄 Upload File Teks', 'Pilih file teks, atau drag & drop', b => {
    b.innerHTML = '<div class="sheet-form">'
      + '<div><label>Judul <span class="field-hint">(opsional — kosongkan untuk pakai filename)</span></label>'
      +   '<input class="f" id="docT" placeholder="mis. Catatan rapet..."></div>'
      + '<div><label>Tag <span class="field-hint">(pisah koma)</span></label>'
      +   '<input class="f" id="docTag" placeholder="catatan, rapat"></div>'
      + '<div id="docDropzone" style="border:2px dashed #c0c0c0;border-radius:8px;padding:24px;text-align:center;color:#666;cursor:pointer;margin:8px 0;transition:all 0.2s">'
      +   '<div style="font-size:32px;margin-bottom:8px">📄</div>'
      +   '<div style="font-weight:600;color:#333">Klik untuk pilih file</div>'
      +   '<div style="font-size:11px;margin-top:4px">atau drag & drop</div>'
      +   '<div style="font-size:10px;margin-top:4px;color:#999">Format: .md, .txt, .json, .html, .csv, .yaml (max 2MB)</div>'
      + '</div>'
      + '<input type="file" id="docFileInputSheet" accept=".md,.markdown,.txt,.json,.html,.htm,.csv,.yaml,.yml" style="display:none">'
      + '<div id="docPreview" style="display:none;margin:8px 0">'
      +   '<div style="font-size:11px;color:#666;margin-top:4px" id="docPreviewMeta"></div>'
      +   '<div id="docPreviewText" style="font-size:11px;background:var(--surface-2);padding:8px;border-radius:6px;margin-top:4px;max-height:120px;overflow-y:auto;white-space:pre-wrap;font-family:monospace"></div>'
      + '</div>'
      + '<div class="btn-row"><button class="btn btn-g" id="docCancel">Batal</button>'
      +   '<button class="btn btn-p" id="docSave" disabled>' + ICONS.check + 'Simpan File</button></div></div>';

    let _fileContent = null, _fileName = '', _fileKind = null, _fileMime = 'text/plain';
    const dropzone = b.querySelector('#docDropzone');
    const fileInput = b.querySelector('#docFileInputSheet');
    dropzone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (e) => { if (e.target.files[0]) await _handleFile(e.target.files[0]); });
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.style.borderColor = '#FF7139'; dropzone.style.background = '#FFF4E6'; });
    dropzone.addEventListener('dragleave', (e) => { e.preventDefault(); dropzone.style.borderColor = '#c0c0c0'; dropzone.style.background = ''; });
    dropzone.addEventListener('drop', async (e) => { e.preventDefault(); dropzone.style.borderColor = '#c0c0c0'; dropzone.style.background = ''; if (e.dataTransfer.files[0]) await _handleFile(e.dataTransfer.files[0]); });

    async function _handleFile(file) {
      const info = detectFileKind(file);
      if (!info) { toast('⚠ Format tidak didukung: ' + file.name, false); return; }
      if (file.size > MAX_FILE_UPLOAD_BYTES) { toast('⚠ File terlalu besar (max 2MB)', false); return; }
      const text = await file.text();
      if (!text || text.length === 0) { toast('⚠ File kosong', false); return; }
      _fileContent = text; _fileName = file.name; _fileKind = info.kind; _fileMime = info.mime;
      const previewMeta = b.querySelector('#docPreviewMeta');
      const previewText = b.querySelector('#docPreviewText');
      const previewBox = b.querySelector('#docPreview');
      const sizeKb = (file.size / 1024).toFixed(1);
      previewMeta.textContent = '📎 ' + file.name + ' · ' + sizeKb + ' KB · ' + info.kind;
      previewText.textContent = text.slice(0, 500) + (text.length > 500 ? '\n... (' + text.length + ' chars total)' : '');
      previewBox.style.display = '';
      b.querySelector('#docSave').disabled = false;
      const titleEl = b.querySelector('#docT');
      if (!titleEl.value.trim()) titleEl.value = file.name.replace(/\.[^.]+$/, '').slice(0, 60);
      toast('📋 File dimuat — klik Simpan untuk menyimpan');
    }

    b.querySelector('#docCancel').addEventListener('click', closeSheet);
    b.querySelector('#docSave').addEventListener('click', async () => {
      if (!_fileContent) { toast('Pilih file dulu', false); return; }
      const title = (b.querySelector('#docT').value || '').trim() || _fileName;
      const tags = (b.querySelector('#docTag').value || '').trim();
      const tagList = tags ? tags.split(',').map(s => s.trim()).filter(Boolean) : ['file', _fileKind];
      const btn = b.querySelector('#docSave');
      btn.textContent = '⏳ Menyimpan...'; btn.disabled = true;
      try {
        await addItem({ type: 'file', title, body: _fileContent, tags: tagList, source: { kind: _fileKind, mime: _fileMime, fileName: _fileName, size: _fileContent.length, uploadedFrom: 'addon-upload', capturedAt: new Date().toISOString() } });
        let cloudOk = true;
        try {
          const errData = await browser.storage.local.get('recallfox_last_sync_error');
          if (errData['recallfox_last_sync_error']) {
            const syncErr = JSON.parse(errData['recallfox_last_sync_error']);
            if (syncErr.source === '_uploadFileDocument' && Date.now() - new Date(syncErr.ts).getTime() < 5000) {
              cloudOk = false;
              toast('📤 ' + _fileName + ' tersimpan lokal — URL cloud gagal: ' + (syncErr.hint || syncErr.error), false);
            }
          }
        } catch (_) {}
        if (cloudOk) toast('📤 ' + _fileName + ' terupload — URL cloud siap');
        closeSheet();
        await refreshVault();
      } catch (e) { toast('⚠ Gagal simpan: ' + e.message, false); btn.textContent = ICONS.check + 'Simpan File'; btn.disabled = false; }
    });
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
  // v3.11.1: Defensive — kalau search bar tidak ada (sidebar mode), skip
  const searchEl = $('#search');
  if (!searchEl) return;
  const q = currentQuery.trim(); const has = q.length > 0;
  // v3.19.6: Debug log — track search query + data source
  if (has) {
    const allItems = getVaultItems();
    console.log('[RecallFox/Search] query:', JSON.stringify(q), '| total items:', allItems.length, '| currentChip:', currentChip);
  }
  $('#list').style.display = has ? 'none' : '';
  // v3.19.7 FIX BUG KRITIS: cmdres CSS default = display:none. Sebelumnya:
  // has ? '' : 'none' → saat has=true, display='' menghapus inline style →
  // fallback ke CSS default (display:none) → hasil search TIDAK TAMPIL!
  // User report: "fitur search vault addon nya masih belum menemukan apapun"
  // Fix: pakai 'block' explicit (bukan '') supaya override CSS default.
  const cr = $('#cmdres'); cr.style.display = has ? 'block' : 'none';
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
    // v3.19.6: Search TIDAK terhalang chip filter — getVaultItems() returns SEMUA item
    const its = getVaultItems().filter(i => searchableTextFor(i).indexOf(nq) >= 0);
    // v3.19.6: Debug log — track search results
    console.log('[RecallFox/Search] results:', its.length, 'items found for "' + nq + '"');
    if (its.length === 0) {
      // Debug: log first 3 items' searchable text untuk troubleshooting
      const sample = getVaultItems().slice(0, 3).map(i => ({ id: i.id, title: i.title, searchText: searchableTextFor(i).slice(0, 100) }));
      console.log('[RecallFox/Search] sample items (no match):', sample);
    }
    // v3.7.2 (Issue 4): Cari juga di catatan (title + body + group).
    // v3.13.0 (Issue #4): Body sekarang HTML — strip ke plain text dulu supaya search
    // tidak ketemu tag HTML seperti "table" atau "div".
    const noteHits = (currentNotes || []).filter(n => {
      const bodyPlain = stripHtmlForPreview(n.body || '');
      const text = ((n.title || '') + ' ' + bodyPlain + ' ' + (n.group || '') + ' note catatan').toLowerCase();
      return text.indexOf(nq) >= 0;
    }).slice(0, 5);
    let h = '';
    if (cs2.length) h += '<div class="sec-label">Perintah</div>' + cs2.map(c => '<div class="cmd-item" data-cmd="' + c.k + '"><div class="ci">' + ICONS.zap + '</div><div><div class="ct">' + esc(c.t) + '</div><div class="cs">' + esc(c.s) + '</div></div></div>').join('');
    if (its.length) h += '<div class="sec-label">Item · ' + its.length + ' (semua tipe + arsip)</div>' + its.map(it => {
      const T = TYPE[it.type] || { label: it.type, icon: '' };
      const tagsStr = Array.isArray(it.tags) ? it.tags.join(', ') : (it.tags || '');
      // v3.10.0 (Issue 4): Tampilkan badge Arsip jika item di-arsipkan
      const archiveBadge = it.archived ? ' <span style="font-size:9px;background:#fef3c7;color:#92400e;padding:1px 5px;border-radius:3px;margin-left:4px;font-weight:700">ARSIP</span>' : '';
      return '<div class="cmd-item" data-item="' + it.id + '"><div class="item-ic t-' + it.type + '" style="width:28px;height:28px">' + T.icon + '</div><div><div class="ct" style="font-size:12.5px">' + esc(it.title) + archiveBadge + '</div><div class="cs">' + T.label + ' · ' + esc(tagsStr) + '</div></div></div>';
    }).join('');
    if (noteHits.length) h += '<div class="sec-label">Catatan · ' + noteHits.length + '</div>' + noteHits.map(n => {
      // v3.13.0: title fallback pakai plain text strip, bukan HTML mentah
      const title = n.title || stripHtmlForPreview(n.body || '').slice(0, 60) || '(kosong)';
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
function clearSearch() {
  // v3.11.1: Defensive — kalau search input tidak ada, just reset state
  const searchEl = $('#search');
  if (searchEl) searchEl.value = '';
  currentQuery = '';
  // v3.10.2 (Issue 4 fix): Sembunyikan tombol clear (X) setelah input dikosongkan
  const clearBtn = $('#searchClear');
  if (clearBtn) clearBtn.style.display = 'none';
  renderSearch();
}

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
  // v3.11.1: cmdWrap (search bar) sudah dihapus — ganti dengan quickActions
  // v3.11.3: quickActions juga sudah dihapus — biar lega (user request).
  // Sekarang cuma tiles + strip yang toggle di home view.
  const cmdWrap = $('#cmdWrap');
  if (cmdWrap) cmdWrap.style.display = homeOnly ? 'flex' : 'none';
  document.querySelector('.tiles').style.display = homeOnly ? 'grid' : 'none';
  // v3.12.3: renderTiles() ulang saat ke home view (jaga-jaga kalau activeTiles berubah)
  if (homeOnly) renderTiles();
  // v3.11.7-fix (Issue #6): Strip jadwal sholat SELALU terlihat di semua view
  // (home, notes, tools) supaya countdown sholat tidak hilang saat user di menu lain.
  // Sebelumnya: homeOnly ? '' : 'none' → ketutup saat di notes/tools.
  document.querySelector('.strip').style.display = '';
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
  // v3.13.0 (Issue #3): Filter berdasarkan search query (judul + body, case-insensitive).
  // Body di-strip dulu ke plain text supaya tag HTML tidak ikut dicocok.
  if (notesSearchQuery) {
    const q = notesSearchQuery.toLowerCase();
    arr = arr.filter(n => {
      const title = (n.title || '').toLowerCase();
      const body = stripHtmlForPreview(n.body || '').toLowerCase();
      return title.includes(q) || body.includes(q);
    });
  }
  // v3.13.0 (Issue #3): Apply sort mode (pinned selalu di atas kecuali sort by title).
  const pinnedFirst = (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
  if (notesSortMode === 'title') {
    // Sort by title A-Z (pinned tetap di atas)
    return arr.slice().sort((a, b) => {
      const p = pinnedFirst(a, b);
      if (p !== 0) return p;
      return (a.title || '').localeCompare(b.title || '', 'id', { sensitivity: 'base' });
    });
  } else if (notesSortMode === 'created') {
    // Sort by createdAt desc (newest first), pinned di atas
    return arr.slice().sort((a, b) => {
      const p = pinnedFirst(a, b);
      if (p !== 0) return p;
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });
  }
  // Default: 'recent' — by updatedAt desc (pinned di atas)
  return arr.slice().sort((a, b) => {
    const p = pinnedFirst(a, b);
    if (p !== 0) return p;
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });
}
async function renderNotes() {
  currentNotes = await getNotes();
  const list = $('#notesList');
  const badge = $('#notesBadge');
  if (badge) { badge.style.display = currentNotes.length ? 'grid' : 'none'; badge.textContent = currentNotes.length; }
  // v3.11.1 (Issue 3 fix): Update count meta di notes-bar compact
  const countMeta = $('#notesCountMeta');
  if (countMeta) {
    const activeCount = currentNotes.filter(n => !n.archived).length;
    countMeta.textContent = activeCount + ' catatan';
  }
  // v3.13.0 (Issue #3): Render search + sort + view toolbar (di atas group chips)
  // v3.13.1: Search trigger saat Enter (bukan real-time debounce) + tombol X untuk clear.
  const hasQuery = notesSearchQuery.length > 0;
  const toolbarHtml = '<div class="notes-toolbar">'
    + '<div class="notes-search-wrap">'
    +   '<input type="text" class="notes-search" id="notesSearch" placeholder="🔍 Cari catatan... (Enter)" value="' + esc(notesSearchQuery) + '">'
    +   (hasQuery ? '<button class="notes-search-clear" id="notesSearchClear" title="Hapus pencarian" aria-label="Hapus pencarian">✕</button>' : '')
    + '</div>'
    + '<select class="notes-sort" id="notesSort" title="Urutkan">'
    +   '<option value="recent"' + (notesSortMode === 'recent' ? ' selected' : '') + '>Terbaru</option>'
    +   '<option value="created"' + (notesSortMode === 'created' ? ' selected' : '') + '>Dibuat</option>'
    +   '<option value="title"' + (notesSortMode === 'title' ? ' selected' : '') + '>Judul A-Z</option>'
    + '</select>'
    + '<button class="notes-view-toggle" id="notesViewToggle" title="' + (notesViewMode === 'list' ? 'Mode grid' : 'Mode list') + '">' + (notesViewMode === 'list' ? '▦' : '☰') + '</button>'
    + '</div>';

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
    list.innerHTML = toolbarHtml + groupChipsHtml + '<div class="notes-empty"><div class="big">📝</div>Belum ada catatan.<br><span style="font-size:11px">Klik <b>Catatan Baru</b> — tersimpan otomatis.</span></div>';
    bindNotesToolbar();
    bindGroupChips();
    return;
  }
  const sorted = notesSorted();
  if (!sorted.length) {
    // v3.13.0: Empty state bisa karena grup kosong ATAU search tidak ketemu
    let emptyMsg;
    if (notesSearchQuery) {
      emptyMsg = '<div class="notes-empty"><div class="big">🔍</div>Tidak ada catatan cocok dengan "<b>' + esc(notesSearchQuery) + '</b>".<br><span style="font-size:11px">Coba kata kunci lain atau hapus filter pencarian.</span></div>';
    } else {
      emptyMsg = '<div class="notes-empty"><div class="big">📭</div>Tidak ada catatan di grup "' + esc(currentNoteGroup) + '".<br><span style="font-size:11px">Pilih grup lain atau buat catatan baru di grup ini.</span></div>';
    }
    list.innerHTML = toolbarHtml + groupChipsHtml + emptyMsg;
    bindNotesToolbar();
    bindGroupChips();
    return;
  }
  // v3.13.0: Tambah class 'notes-grid-mode' ke list kalau viewMode = 'grid'
  list.className = 'notes-list' + (notesViewMode === 'grid' ? ' notes-grid-mode' : '');
  list.innerHTML = toolbarHtml + groupChipsHtml + sorted.map(n => {
    const titleHtml = n.title ? '<div class="note-title">' + esc(n.title) + '</div>' : '';
    // v3.13.0 (Issue #4): Strip HTML untuk preview — catatan body sekarang bisa berisi HTML
    // (paste tabel, bold, list, dll). Preview di list harus plain text.
    // v3.11.15: Limit 400 karakter, collapse whitespace.
    const plainBody = stripHtmlForPreview(n.body || '').slice(0, 400).replace(/\s+/g, ' ').trim();
    const previewHtml = plainBody ? esc(plainBody) : '<em style="color:var(--muted)">(kosong)</em>';
    const groupTag = n.group ? '<span class="ngroup-tag">📁 ' + esc(n.group) + '</span>' : '';
    let batchHtml = '';
    if (notesBatchMode) {
      const checked = notesBatchSelected.has(n.id) ? ' checked' : '';
      batchHtml = '<div class="note-batch-wrap" style="flex-shrink:0;display:flex;align-items:center;padding-right:4px"><input type="checkbox" class="note-batch-check" data-nid="' + n.id + '"' + checked + ' style="width:16px;height:16px;cursor:pointer"></div>';
    }
    // v1.8.1: Voice note player DIHAPUS — user bilang "batasan mb, tidak terpakai".
    // v3.19.1: GPS location display di note card (jika note punya source.location).
    const noteLoc = n.source?.location;
    const noteLocHtml = noteLoc
      ? '<div style="font-size:10px;color:var(--green);margin-top:2px">\uD83D\uDCCD ' + esc((noteLoc.address || (noteLoc.lat?.toFixed(4) + ', ' + noteLoc.lng?.toFixed(4))).slice(0, 40)) + '</div>'
      : '';
    return '<div class="note-card nc-' + (n.color || 'default') + '" data-nid="' + n.id + '"' + (notesBatchSelected.has(n.id) ? ' style="background:var(--primary-soft);border-color:var(--primary)"' : '') + '>'
      + batchHtml
      + '<div class="note-card-main">'
      + titleHtml
      + '<div class="note-body-txt">' + previewHtml + '</div>'
      + noteLocHtml
      + '<div class="note-meta">' + (n.pinned ? '<span class="pin">📌</span>' : '') + groupTag + '<span class="cdot"></span><span>' + timeAgo(n.updatedAt || n.createdAt) + '</span></div>'
      + '</div>'
      + '</div>';
  }).join('');
  list.querySelectorAll('.note-card').forEach(c => c.addEventListener('click', (e) => {
    // v3.9.0 (Issue 7): In batch mode, toggle selection instead of opening editor
    if (notesBatchMode) {
      const nid = c.dataset.nid;
      if (notesBatchSelected.has(nid)) notesBatchSelected.delete(nid);
      else notesBatchSelected.add(nid);
      updateNotesBatchCount();
      renderNotes();
      return;
    }
    // v3.11.16: note-act buttons sudah dihapus — klik note-card langsung buka editor.
    // Aksi Hapus/Arsip/Pin ada di footer editor. Aksi massal pakai toggle batch.
    openNoteEditor(c.dataset.nid);
  }));
  bindNotesToolbar();
  bindGroupChips();
}

// v3.13.0 (Issue #3): Bind search/sort/view toolbar events.
// v3.13.1: Search trigger saat Enter (bukan real-time debounce) supaya user
//   bisa ngetik tenang tanpa re-render di setiap keystroke. Escape juga clear.
//   Tambahan tombol X untuk clear search.
function bindNotesToolbar() {
  const searchInput = $('#notesSearch');
  const searchClearBtn = $('#notesSearchClear');
  const sortSelect = $('#notesSort');
  const viewToggle = $('#notesViewToggle');
  if (searchInput) {
    // v3.13.1: Enter → apply search. Escape → clear search.
    // Tidak ada debounce real-time — user boleh ngetik panjang tanpa ganggu.
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        notesSearchQuery = searchInput.value.trim();
        renderNotes();
        // Re-focus + pindah cursor ke akhir setelah re-render
        const newInput = $('#notesSearch');
        if (newInput) {
          newInput.focus();
          const len = newInput.value.length;
          newInput.setSelectionRange(len, len);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (notesSearchQuery || searchInput.value) {
          notesSearchQuery = '';
          renderNotes();
          const newInput = $('#notesSearch');
          if (newInput) newInput.focus();
        }
      }
    });
  }
  if (searchClearBtn) {
    searchClearBtn.addEventListener('click', () => {
      notesSearchQuery = '';
      renderNotes();
      const newInput = $('#notesSearch');
      if (newInput) newInput.focus();
    });
  }
  if (sortSelect) {
    sortSelect.addEventListener('change', async () => {
      notesSortMode = sortSelect.value;
      await saveNotesPrefs();
      renderNotes();
    });
  }
  if (viewToggle) {
    viewToggle.addEventListener('click', async () => {
      notesViewMode = notesViewMode === 'list' ? 'grid' : 'list';
      await saveNotesPrefs();
      renderNotes();
    });
  }
}

// v3.9.0 (Issue 7): Quick action handler untuk note (dari list, tanpa buka editor)
// v3.11.16: DEPRECATED — note-card-actions sudah dihapus. Fungsi tetap dipertahankan
// untuk backward-compat (kalau ada kode lain yang panggil), tapi tidak digunakan lagi.
async function handleNoteQuickAction(action, noteId) {
  const n = currentNotes.find(x => x.id === noteId);
  if (!n) return;
  if (action === 'edit') {
    openNoteEditor(noteId);
  } else if (action === 'archive') {
    await updateNote(noteId, { archived: !n.archived, updatedAt: new Date().toISOString() });
    toast(n.archived ? '📤 Dikeluarkan dari arsip' : '📦 Catatan diarsipkan');
    await renderNotes();
  } else if (action === 'delete') {
    if (!confirm('Hapus catatan ini?')) return;
    await deleteNote(noteId);
    toast('🗑️ Catatan dihapus');
    await renderNotes();
  }
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
  // v3.13.0 (Issue #4): Ganti <textarea> → <div contenteditable> supaya bisa
  // paste tabel + format dasar (bold, italic, list, heading). Body disimpan sebagai HTML.
  // Backward-compat: catatan lama (plain text) di-load via loadNoteBody() yang escape +
  // convert newline ke <br>. Catatan baru (HTML) di-sanitize ulang untuk jaga-jaga XSS.
  $('#pageBody').innerHTML =
    '<div class="card" style="margin-bottom:10px">'
    + '<input class="f" id="nTitle" value="' + esc(n.title || '') + '" placeholder="Judul (opsional) — dikosongkan pakai preview isi" style="margin-bottom:8px;font-weight:600">'
    + '<div class="f nbody-edit" id="nBody" contenteditable="true" data-placeholder="Tulis catatan sementara di sini… (auto-save). Paste tabel atau teks berformat akan dipertahankan.">' + loadNoteBody(n.body || '') + '</div>'
    // v3.10.0 (Issue 5): Compose + Parafrase untuk catatan
    + '<div style="display:flex;gap:6px;margin-top:8px">'
    +   '<button class="btn btn-g" id="nCompose" title="AI generate catatan dari judul — bisa diulang" style="flex:1;padding:6px 8px;font-size:11px">✨ Compose dengan AI</button>'
    +   '<button class="btn btn-g" id="nParafrase" title="AI parafrase catatan — bisa diulang" style="flex:1;padding:6px 8px;font-size:11px">🔄 Parafrase</button>'
    + '</div>'
    + '</div>'
    + '<div class="card"><h3>Grup / Proyek</h3>'
    + '<input class="f" id="nGroup" value="' + esc(n.group || '') + '" placeholder="mis. Proyek A, Riset B (opsional)" style="margin-bottom:8px">'
    + '<div class="hintbox" style="font-size:11px">Catatan dengan nama grup yang sama akan terkumpul di filter grup di atas daftar.</div>'
    + '</div>'
    + '<div class="card"><h3>Warna</h3><div class="ndots">' + NCOLORS.map(c => '<button class="d-' + c + (n.color === c ? ' on' : '') + '" data-c="' + c + '" title="' + c + '"></button>').join('') + '</div></div>'
    + '<div class="hintbox">🕑 Terakhir disimpan: <b id="nMeta">' + timeAgo(n.updatedAt || n.createdAt) + '</b> · Catatan tersimpan lokal & ikut backup otomatis.</div>';
  // v3.11.7-fix (Issue #2 gap): Note editor footer konsisten dengan editor lain.
  // Sebelumnya: 5 tombol flex:none + spacer span flex:1 → di sidebar sempit, tombol
  // "Selesai" terdorong ke kanan ekstrim / wrap ke baris baru tidak rapi.
  // Sekarang: semua tombol flex:1 (rata konsisten), label dipendekkan supaya muat sidebar.
  $('#pageFoot').innerHTML =
    '<button class="btn btn-d" id="nDel">Hapus</button>'
    + '<button class="btn btn-g" id="nArchive">' + (n.archived ? '📤 Unarsip' : '📦 Arsip') + '</button>'
    + '<button class="btn btn-g" id="nPin">' + (n.pinned ? '📌 Lepas' : '📌 Pin') + '</button>'
    + '<button class="btn btn-g" id="nCopy">Salin</button>'
    + '<button class="btn btn-p" id="nDone">Selesai</button>';
  const ta = $('#nBody');
  const titleInput = $('#nTitle');
  const groupInput = $('#nGroup');
  function markSaved() {
    const st = $('#pageSaveState'); st.textContent = 'Tersimpan ✓'; st.classList.add('ok');
    renderNotes();
  }
  // v3.7.2 (Issue 5): Auto-save title + body + group dengan debounce yang sama.
  // v3.13.0 (Issue #4): Body sekarang HTML (dari contenteditable), bukan plain text.
  function scheduleSave() {
    const st = $('#pageSaveState'); st.textContent = 'Menyimpan…'; st.classList.remove('ok');
    clearTimeout(noteSaveTimer);
    noteSaveTimer = setTimeout(async () => {
      await updateNote(n.id, {
        title: titleInput.value.trim(),
        body: ta.innerHTML,
        group: groupInput.value.trim(),
        updatedAt: new Date().toISOString()
      });
      markSaved();
    }, 800);
  }
  ta.addEventListener('input', scheduleSave);
  titleInput.addEventListener('input', scheduleSave);
  groupInput.addEventListener('input', scheduleSave);
  // v3.13.0 (Issue #4): Paste handler — sanitize HTML dari clipboard.
  // Whitelist tag + atribut aman, buang script/style/iframe/on* handler/javascript: URLs.
  // Kalau clipboard hanya punya plain text (mis. dari Notepad), escape + convert newline → <br>.
  ta.addEventListener('paste', (e) => {
    e.preventDefault();
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    let insertHtml;
    if (html && html.trim()) {
      insertHtml = sanitizeNoteHtml(html);
    } else if (text) {
      insertHtml = esc(text).replace(/\n/g, '<br>');
    } else {
      return; // nothing to paste
    }
    // execCommand deprecated tapi masih best option untuk contenteditable insertHTML
    // dengan undo/redo support. Alternatif: Selection API + Range.insertNode — lebih
    // kompleks, dan undo stack manual. Pakai execCommand dulu, kalau nanti browser
    // drop support, ganti ke Selection API.
    try {
      document.execCommand('insertHTML', false, insertHtml);
    } catch (err) {
      // Fallback: append ke akhir
      ta.innerHTML += insertHtml;
    }
    // Trigger input event supaya auto-save jalan
    ta.dispatchEvent(new Event('input'));
  });
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

  // v3.10.0 (Issue 5): Compose + Parafrase untuk catatan
  // v3.13.0 (Issue #4): Adaptasi ke contenteditable — pakai innerHTML (bukan .value),
  // dan input AI (plain text dengan newline) di-escape + newline → <br> sebelum insert.
  $('#nCompose').addEventListener('click', async () => {
    const titleVal = ($('#nTitle').value || '').trim();
    if (!titleVal) { toast('Isi judul dulu, lalu klik Compose'); return; }
    const btn = $('#nCompose');
    const orig = btn.textContent;
    btn.textContent = '⏳ Composing...';
    btn.disabled = true;
    try {
      const { isAssistantConfigured, chatWithFallback } = await import('../lib/assistant.js');
      if (!(await isAssistantConfigured())) { toast('Setup AI Assistant dulu di Pengaturan'); return; }
      const sys = 'Anda adalah asisten yang menulis catatan yang rapi dan berguna. Berdasarkan judul, tulis catatan singkat (50-150 kata) dengan poin-poin penting. Jawab HANYA isinya.';
      let acc = '';
      const taEl = $('#nBody');
      const resp = await chatWithFallback(
        [{ role: 'system', content: sys }, { role: 'user', content: 'Judul: "' + titleVal + '"\n\nTulis catatan.' }],
        { onToken: (t) => {
            acc += t;
            // AI output plain text — escape + newline → <br> sebelum set innerHTML
            taEl.innerHTML = esc(acc).replace(/\n/g, '<br>');
            taEl.dispatchEvent(new Event('input'));
          } }
      );
      if (!acc && resp?.content) {
        taEl.innerHTML = esc(resp.content).replace(/\n/g, '<br>');
        taEl.dispatchEvent(new Event('input'));
      }
      toast('✨ Catatan di-generate. Klik lagi untuk varian lain.');
    } catch (e) { toast('Gagal compose: ' + e.message); }
    finally { btn.textContent = orig; btn.disabled = false; }
  });
  $('#nParafrase').addEventListener('click', async () => {
    const taEl = $('#nBody');
    // v3.13.0: Ambil innerText (bukan textContent) supaya format dirender sebagai newline.
    const currentText = taEl ? taEl.innerText.trim() : '';
    if (!currentText) { toast('Isi catatan dulu, lalu klik Parafrase'); return; }
    const btn = $('#nParafrase');
    const orig = btn.textContent;
    btn.textContent = '⏳ Parafrase...';
    btn.disabled = true;
    try {
      const { isAssistantConfigured, chatWithFallback } = await import('../lib/assistant.js');
      if (!(await isAssistantConfigured())) { toast('Setup AI Assistant dulu di Pengaturan'); return; }
      const sys = 'Parafrase teks berikut agar lebih jelas, rapi, dan mudah dibaca. Pertahankan semua informasi penting. Jawab HANYA teks hasil parafrase.';
      let acc = '';
      const resp = await chatWithFallback(
        [{ role: 'system', content: sys }, { role: 'user', content: 'Teks asli:\n\n' + currentText + '\n\nParafrase.' }],
        { onToken: (t) => {
            acc += t;
            taEl.innerHTML = esc(acc).replace(/\n/g, '<br>');
            taEl.dispatchEvent(new Event('input'));
          } }
      );
      if (!acc && resp?.content) {
        taEl.innerHTML = esc(resp.content).replace(/\n/g, '<br>');
        taEl.dispatchEvent(new Event('input'));
      }
      toast('🔄 Parafrase selesai. Klik lagi untuk varian lain.');
    } catch (e) { toast('Gagal parafrase: ' + e.message); }
    finally { btn.textContent = orig; btn.disabled = false; }
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
    // v3.13.0 (Issue #4): Salin innerText dari contenteditable — preserve format
    // (bold/list/heading → newline + bullet di plain text). Sebelumnya: n.body (HTML mentah).
    // v3.20.21: Pakai _copyTextWithFallback supaya copy jalan di popout sidebar iframe
    // (navigator.clipboard.writeText bisa gagal di iframe yang tidak focused).
    try {
      const textToCopy = ta.innerText || stripHtmlForPreview(n.body || '');
      const ok = await _copyTextWithFallback(textToCopy);
      if (ok) toast('📋 Catatan disalin');
    } catch (e) { toast('Gagal salin', false); }
  });
  $('#nDone').addEventListener('click', async () => {
    const cur = currentNotes.find(x => x.id === n.id);
    // v3.13.0: Cek body via innerText (bukan .trim() langsung pada HTML string).
    const bodyText = ta.innerText.trim();
    if (cur && !bodyText && !cur.title?.trim()) { await deleteNote(n.id); }
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
  ['tape', 'RecallTape', 'Kalkulator pita · keyboard-first', '🧾'],
  ['shalat', 'Waktu Shalat', 'Muhammadiyah · countdown', ICONS.mosque],
  ['habits', 'Habits', 'Ngaji & olahraga harian', ICONS.heart],
  ['puasa', 'Puasa Sunnah', 'Kalender Islam & jadwal', ICONS.moonstar],
  ['volume', 'Penguat Volume', 'Hingga 600% per tab', ICONS.vol],
  ['kontrol', 'Kontrol Situs', 'Blocker + filter konten', ICONS.shield],
  ['aimanage', 'Kelola Situs AI', 'Pin/hide/tambah situs', ICONS.spark],  // v3.11.1 (Issue 4)
  ['cache', 'Bersihkan Cache', '9 tipe data · konfirmasi', ICONS.trash, 'warn'],
  ['askai', 'Tanya AI', 'Tanya soal teks terseleksi', ICONS.spark],
  ['gdrive', 'Sync Cloud', 'GDrive + Multi-PC sync', ICONS.cloud || '☁️'],   // v3.11.7-fix Issue #5: gabung GDrive + Multi-PC
  ['backup', 'Backup', 'Ekspor terenkripsi AES + GDrive', ICONS.archive],
  ['keys', 'Pintasan', 'Semua shortcut', ICONS.kb]
];
function renderTools() {
  $('#toolgrid').innerHTML = TOOLS.map(t => '<button class="tool' + (t[4] ? ' ' + t[4] : '') + '" data-tool="' + t[0] + '"><div class="tool-ic">' + t[3] + '</div><div><div class="tool-n">' + t[1] + '</div><div class="tool-d">' + t[2] + '</div></div></button>').join('');
  $$('#toolgrid .tool').forEach(t => t.addEventListener('click', () => toolPage(t.dataset.tool)));
}

// ============================================================================
// v3.12.3 (Issue #2 dari Google Doc): Customizable quick-action tiles
// User feedback: "Dapat Dikustomisasi: Pengguna bisa menambah atau menghapus
//   tombol fitur... Batas Maksimal: 6... Tinggi Dinamis (Auto-fit Row)."
//
// Arsitektur:
//   - TILE_DEFS: pool 17 fitur available (6 quick-actions + 11 tools)
//   - activeTiles: array ID yang aktif (max 6), disimpan di vault.settings.activeTiles
//   - Default: 6 quick-actions lama (backward compatible)
//   - renderTiles(): render dinamis ke #tilesContainer + tombol "+" jika <6
//   - Event delegation: 1 click handler di container, dispatch by data-tile
//   - removeTile(id): hapus dari active list + re-render
//   - openTilePicker(): bottom sheet dengan fitur yang belum aktif
// ============================================================================

const TILE_DEFS = [
  // Quick actions (6) — ID tetap qaPrompt/qaKonteks/dll supaya backward compat
  { id: 'qaPrompt',  label: 'Prompt',   icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-3.5-.7L4 20l1-4.1A8.4 8.4 0 1 1 21 11.5z"/></svg>', type: 'qa', action: 'savePromptSheet' },
  { id: 'qaKonteks', label: 'Konteks',  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>', type: 'qa', action: 'saveKonteksSheet' },
  { id: 'qaLink',    label: 'Link',     icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>', type: 'qa', action: 'saveLinkSheet' },
  { id: 'qaBundle',  label: 'Bundle',   icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3.3 8.3 12 13l8.7-4.7M12 22V13"/></svg>', type: 'qa', action: 'saveBundleSheet' },
  { id: 'qaSnap',    label: 'Snapshot', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-3.5-.7L4 20l1-4.1A8.4 8.4 0 1 1 21 11.5z"/><path d="M8.5 10.5h7M8.5 13.5h4"/></svg>', type: 'qa', action: 'snapshotFlow' },
  { id: 'qaShot',    label: 'Shot',     icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="12" cy="12" r="3.2"/><path d="M7 3v2M17 21v-2"/></svg>', type: 'qa', action: 'doShot' },
  // Tools (11) — klik → toolPage(tool_id)
  { id: 'shalat',    label: 'Shalat',   icon: ICONS.mosque,   type: 'tool', action: 'toolPage', arg: 'shalat' },
  { id: 'habits',    label: 'Habits',   icon: ICONS.heart,    type: 'tool', action: 'toolPage', arg: 'habits' },
  { id: 'puasa',     label: 'Puasa',    icon: ICONS.moonstar, type: 'tool', action: 'toolPage', arg: 'puasa' },
  { id: 'volume',    label: 'Volume',   icon: ICONS.vol,      type: 'tool', action: 'toolPage', arg: 'volume' },
  { id: 'kontrol',   label: 'Kontrol',  icon: ICONS.shield,   type: 'tool', action: 'toolPage', arg: 'kontrol' },
  { id: 'aimanage',  label: 'AI Sites', icon: ICONS.spark,    type: 'tool', action: 'toolPage', arg: 'aimanage' },
  { id: 'cache',     label: 'Cache',    icon: ICONS.trash,    type: 'tool', action: 'toolPage', arg: 'cache' },
  { id: 'askai',     label: 'Tanya AI', icon: ICONS.spark,    type: 'tool', action: 'toolPage', arg: 'askai' },
  { id: 'gdrive',    label: 'Sync',     icon: ICONS.cloud,    type: 'tool', action: 'toolPage', arg: 'gdrive' },
  { id: 'backup',    label: 'Backup',   icon: ICONS.archive,  type: 'tool', action: 'toolPage', arg: 'backup' },
  { id: 'keys',      label: 'Pintasan', icon: ICONS.kb,       type: 'tool', action: 'toolPage', arg: 'keys' }
];

const DEFAULT_ACTIVE_TILES = ['qaPrompt', 'qaKonteks', 'qaLink', 'qaBundle', 'qaSnap', 'qaShot'];
const MAX_ACTIVE_TILES = 6;

/**
 * Get active tile IDs from vault.settings, fallback to default.
 */
function getActiveTiles() {
  const s = currentVault?.settings || {};
  let active = s.activeTiles || DEFAULT_ACTIVE_TILES;
  // Validasi: filter ID yang tidak ada di TILE_DEFS (mis. fitur dihapus di versi baru)
  active = active.filter(id => TILE_DEFS.some(t => t.id === id));
  // Pastikan tidak melebihi MAX
  if (active.length > MAX_ACTIVE_TILES) active = active.slice(0, MAX_ACTIVE_TILES);
  return active;
}

/**
 * Save active tile IDs to vault.settings.
 */
async function saveActiveTiles(ids) {
  const vault = await getVault();
  if (!vault.settings) vault.settings = {};
  vault.settings.activeTiles = ids.slice(0, MAX_ACTIVE_TILES);
  await saveVault(vault);
  currentVault = vault;
}

// v3.13.0 (Issue #3): Load/save notes prefs (sort mode + view mode) ke vault.settings.notesPrefs.
// searchQuery TIDAK di-persist (temporal — reset setiap sesi biar tidak menyaring terus).
function loadNotesPrefs() {
  const prefs = currentVault?.settings?.notesPrefs || {};
  if (prefs.sortMode && ['recent', 'title', 'created'].includes(prefs.sortMode)) {
    notesSortMode = prefs.sortMode;
  }
  if (prefs.viewMode && ['list', 'grid'].includes(prefs.viewMode)) {
    notesViewMode = prefs.viewMode;
  }
  // notesSearchQuery sengaja tidak di-load — biar tidak nyangkut filter saat user buka app
}
async function saveNotesPrefs() {
  const vault = await getVault();
  if (!vault.settings) vault.settings = {};
  vault.settings.notesPrefs = {
    sortMode: notesSortMode,
    viewMode: notesViewMode
  };
  await saveVault(vault);
  currentVault = vault;
}

/**
 * Render quick-action tiles ke #tilesContainer.
 * - Active tiles: button dengan icon + label + tombol "×" (hover) untuk remove
 * - Tombol "+": muncul kalau active < MAX (untuk add fitur baru)
 */
function renderTiles() {
  const container = $('#tilesContainer');
  if (!container) return;
  const active = getActiveTiles();
  let html = active.map(id => {
    const def = TILE_DEFS.find(t => t.id === id);
    if (!def) return '';
    return `<button class="tile" data-tile="${def.id}" title="${def.label}">
      ${def.icon}${def.label}
      <span class="tile-remove" data-remove="${def.id}" title="Hapus dari quick actions">×</span>
    </button>`;
  }).join('');
  // Tombol "+" kalau masih ada slot
  if (active.length < MAX_ACTIVE_TILES) {
    html += `<button class="tile tile-add" data-action="add-tile" title="Tambah fitur ke quick actions">+ Tambah</button>`;
  }
  container.innerHTML = html;
}

/**
 * Remove tile dari active list.
 * v3.12.4: Tambah try-catch + console.log untuk debug (user report klik × tidak responsif).
 */
async function removeTile(id) {
  console.log('[RecallFox] removeTile START, id:', id);
  try {
    if (!id) { console.warn('[RecallFox] removeTile: no id'); return; }
    const active = getActiveTiles();
    console.log('[RecallFox] removeTile: active before:', active);
    const newActive = active.filter(t => t !== id);
    console.log('[RecallFox] removeTile: active after:', newActive);
    await saveActiveTiles(newActive);
    renderTiles();
    toast('✓ Dihapus dari quick actions');
    console.log('[RecallFox] removeTile DONE, re-rendered');
  } catch (e) {
    console.error('[RecallFox] removeTile FAILED:', e.message, e.stack);
    toast('Gagal hapus: ' + e.message, false);
  }
}

/**
 * Add tile ke active list.
 * v3.12.4: Tambah try-catch + console.log.
 */
async function addTile(id) {
  console.log('[RecallFox] addTile START, id:', id);
  try {
    if (!id) { console.warn('[RecallFox] addTile: no id'); return; }
    const active = getActiveTiles();
    console.log('[RecallFox] addTile: active before:', active);
    if (active.length >= MAX_ACTIVE_TILES) {
      toast('Maksimal ' + MAX_ACTIVE_TILES + ' tombol. Hapus salah satu dulu.', false);
      return;
    }
    if (active.includes(id)) {
      toast('Sudah ada di quick actions', false);
      return;
    }
    active.push(id);
    console.log('[RecallFox] addTile: active after:', active);
    await saveActiveTiles(active);
    renderTiles();
    closeSheet();
    toast('✓ Ditambahkan ke quick actions');
    console.log('[RecallFox] addTile DONE, re-rendered');
  } catch (e) {
    console.error('[RecallFox] addTile FAILED:', e.message, e.stack);
    toast('Gagal tambah: ' + e.message, false);
  }
}

/**
 * Open tile picker — bottom sheet dengan fitur yang belum aktif.
 */
function openTilePicker() {
  const active = getActiveTiles();
  const available = TILE_DEFS.filter(t => !active.includes(t.id));
  if (available.length === 0) {
    toast('Semua fitur sudah ditambahkan', false);
    return;
  }
  const body = available.map(t => `<button class="tool" data-add-tile="${t.id}" style="padding:10px"><div class="tool-ic">${t.icon}</div><div><div class="tool-n">${t.label}</div></div></button>`).join('');
  openSheet('Tambah Quick Action', `Pilih fitur (${available.length} tersedia)`, b => {
    b.innerHTML = `<div class="toolgrid">${body}</div>`;
    b.querySelectorAll('[data-add-tile]').forEach(btn => {
      btn.addEventListener('click', () => addTile(btn.dataset.addTile));
    });
  });
}

function toolPage(k) {
  closeSheet();
  const names = { tape: '🧾 RecallTape — Kalkulator Pita', shalat: '🕌 Waktu Shalat', habits: '❤️ Kebiasaan', puasa: '🌙 Puasa Sunnah', volume: '🔊 Penguat Volume', kontrol: '🛡 Kontrol Situs', cache: '🗑 Bersihkan Cache', askai: '✨ Tanya AI', gdrive: '☁️ Sync Cloud (GDrive + Multi-PC)', backup: '📦 Cadangkan & Pulihkan', keys: '⌨️ Pintasan Keyboard', aimanage: '⚙️ Kelola Situs AI' };
  // v3.14.0: RecallTape — bukan halaman dalam popup, tapi popover di halaman aktif.
  // Kirim message ke content script di tab aktif untuk toggle popover.
  if (k === 'tape') {
    openTapePopover();
    return;
  }
  openPage(names[k] || 'Alat');
  const B = $('#pageBody');
  if (k === 'shalat') renderShalatPage(B);
  else if (k === 'habits') renderHabitsPage(B);
  else if (k === 'puasa') renderPuasaPage(B);
  else if (k === 'volume') renderVolumePage(B);
  else if (k === 'cache') renderCachePage(B);
  else if (k === 'gdrive') renderGDrivePage(B);   // v3.8.1 Issue #1+#2+#6
  else if (k === 'keys') renderKeysPage(B);
  else if (k === 'kontrol') renderKontrolSitusPage(B);
  else if (k === 'aimanage') renderAiManagePage(B);  // v3.11.1 (Issue 4)
  else renderToolStubPage(B, k, names[k]);
}

// v3.14.0: RecallTape — trigger popover di tab aktif via content script.
// Untuk sidebar: kirim ke tab aktif di window utama.
// Untuk popup: kirim ke tab aktif lalu tutup popup (default behavior).
// v3.20.23: Helper untuk buka halaman pengaturan dengan fallback berlapis.
//
// Root cause yang diperbaiki (lanjutan dari v3.20.22 yang masih gagal di lapangan):
//
// 1. browser.runtime.openOptionsPage() di Firefox bisa resolve tanpa error TAPI
//    no-op (tab tidak terbuka) di context tertentu:
//      - Iframe extension page (popout sidebar via sidebar-cs.js)
//      - Native sidebar (sidebar_action di manifest Firefox)
//      - Popup yang akan close dalam ms setelah call
//
// 2. v3.20.22 cuma pakai try/catch — padahal bug Firefox ini tidak throw error,
//    promise resolve OK tapi tidak ada efek. User bilang "tombol mati" karena
//    tidak ada feedback apa-apa.
//
// 3. Deteksi `window !== window.top` untuk iframe kurang lengkap — native sidebar
//    Firefox punya `window === window.top` TAPI openOptionsPage() tetap no-op.
//
// Strategi baru (3 lapis + verifikasi):
//   A. Coba tabs.create() duluan (paling reliable di semua context — buka tab
//      baru dengan URL eksplisit settings/settings.html)
//   B. Verifikasi tab baru benar-benar terbuka dengan query tabs sebelum/sesudah
//   C. Kalau tabs.create throw atau tab tidak muncul dalam 2 detik, fallback ke
//      openOptionsPage() (kadang works di top-level popup context)
//   D. Kalau semua gagal, toast error jelas ke user (bukan diam-diam)
//
// Feedback jelas: toast "⚙️ Membuka pengaturan…" muncul saat klik, lalu toast
// sukses "✓ Pengaturan terbuka di tab baru" setelah verifikasi.
async function openSettings() {
  const settingsUrl = browser.runtime.getURL('settings/settings.html');
  const inIframe = (window !== window.top);
  const inSidebar = document.body?.classList.contains('rf-sidebar-body') === true;

  // Toast loading — supaya user tahu klik terdaftar
  toast('⚙️ Membuka pengaturan…');

  // A. Snapshot tabs sebelum untuk verifikasi
  let tabsBefore = [];
  try {
    tabsBefore = await browser.tabs.query({ url: settingsUrl });
  } catch (e) {
    // Query dengan URL filter kadang gagal di permission ketat — ignore
  }

  // B. Strategi 1: tabs.create (paling reliable di iframe + native sidebar)
  try {
    const tab = await browser.tabs.create({ url: settingsUrl });
    if (tab && tab.id) {
      // Verifikasi: cek tab baru muncul dalam 1.5 detik
      const verified = await new Promise(resolve => {
        const start = Date.now();
        const check = async () => {
          try {
            const tabsNow = await browser.tabs.query({ url: settingsUrl });
            // Tab baru = tab yang id-nya belum ada di tabsBefore
            const isNew = tabsNow.some(t => !tabsBefore.some(b => b.id === t.id));
            if (isNew) return resolve(true);
          } catch (e) {}
          if (Date.now() - start > 1500) return resolve(false);
          setTimeout(check, 150);
        };
        setTimeout(check, 150);
      });

      if (verified) {
        toast('✓ Pengaturan terbuka di tab baru');
        return;
      }
      // Tidak terverifikasi tapi tab object ada — anggap sukses
      console.warn('[RecallFox] openSettings: tab created but verification timeout — assuming success');
      return;
    }
  } catch (e) {
    console.warn('[RecallFox] openSettings: tabs.create failed:', e.message);
  }

  // C. Strategi 2 (fallback): openOptionsPage — kadang works di top-level popup
  if (!inIframe) {
    try {
      await browser.runtime.openOptionsPage();
      // Verifikasi sama
      const verified = await new Promise(resolve => {
        const start = Date.now();
        const check = async () => {
          try {
            const tabsNow = await browser.tabs.query({ url: settingsUrl });
            const isNew = tabsNow.some(t => !tabsBefore.some(b => b.id === t.id));
            if (isNew) return resolve(true);
          } catch (e) {}
          if (Date.now() - start > 1500) return resolve(false);
          setTimeout(check, 150);
        };
        setTimeout(check, 150);
      });
      if (verified) {
        toast('✓ Pengaturan terbuka di tab baru');
        return;
      }
    } catch (e2) {
      console.warn('[RecallFox] openSettings: openOptionsPage also failed:', e2.message);
    }
  }

  // D. Strategi 3 (last resort): kirim ke background untuk inject via content script
  //    di tab aktif — content script bisa window.open() dari halaman web context
  try {
    const res = await browser.runtime.sendMessage({ type: 'RF_OPEN_SETTINGS_VIA_BG' });
    if (res?.ok) {
      toast('✓ Pengaturan terbuka di tab baru');
      return;
    }
  } catch (e3) {
    console.warn('[RecallFox] openSettings: background fallback failed:', e3.message);
  }

  // Semua gagal — kasih user tahu
  console.error('[RecallFox] openSettings: ALL STRATEGIES FAILED');
  toast('⚠️ Tidak bisa buka pengaturan. Coba: klik kanan ikon RecallFox → Options, atau buka langsung moz-extension://<id>/settings/settings.html', false);
}

async function openTapePopover() {
  // v3.20.8: Jika di iframe (popout), kirim postMessage ke parent
  // → parent kirim message ke content script di tab aktif
  if (window !== window.top) {
    window.parent.postMessage({ type: 'RF_OPEN_TAPE' }, '*');
    toast('🧾 RecallTape dibuka di halaman');
    return;
  }
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs[0]) {
      const tab = tabs[0];
      // Hanya kirim ke http(s)/file — bukan about:*, moz-extension:*
      if (/^(https?|file):/i.test(tab.url || '')) {
        try {
          await browser.tabs.sendMessage(tab.id, { type: 'OPEN_TAPE' });
          toast('🧾 RecallTape dibuka di tab aktif');
          // Tutup popup (sidebar tidak terpengaruh — body.rf-sidebar-body)
          if (!document.body.classList.contains('rf-sidebar-body')) {
            setTimeout(() => window.close(), 600);
          }
          return;
        } catch (e) {
          console.warn('[RecallFox/Tape] Cannot reach content script on tab:', e.message);
          // Fallback: inject script lalu coba lagi
          try {
            await browser.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content/tape-cs.js']
            });
            await browser.tabs.sendMessage(tab.id, { type: 'OPEN_TAPE' });
            toast('🧾 RecallTape dibuka di tab aktif');
            if (!document.body.classList.contains('rf-sidebar-body')) {
              setTimeout(() => window.close(), 600);
            }
            return;
          } catch (e2) {
            console.warn('[RecallFox/Tape] Fallback inject failed:', e2.message);
          }
        }
      }
    }
    // Fallback: tampilkan halaman info di dalam popup/sidebar
    openPage('🧾 RecallTape');
    const B = $('#pageBody');
    B.innerHTML = `
      <div class="card" style="text-align:center;padding:20px 16px">
        <div style="font-size:36px;margin-bottom:8px">🧾</div>
        <h3 style="font-size:14px;margin-bottom:6px">RecallTape — Kalkulator Pita</h3>
        <p style="font-size:11.5px;color:var(--text-2);line-height:1.6;margin-bottom:14px">
          Buka halaman web mana saja (http/https), lalu klik tombol 🧾 di header RecallFox untuk memunculkan popover kalkulator pita.
        </p>
        <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;text-align:left;font-size:11px;line-height:1.6;color:var(--text-2)">
          <b style="color:var(--text)">Format input:</b><br>
          <code style="font-family:var(--mono);font-size:10.5px;background:var(--surface);padding:1px 4px;border-radius:3px">250000 Gaji Utama</code><br>
          <code style="font-family:var(--mono);font-size:10.5px;background:var(--surface);padding:1px 4px;border-radius:3px">+ 50k Bonus projek</code><br>
          <code style="font-family:var(--mono);font-size:10.5px;background:var(--surface);padding:1px 4px;border-radius:3px">- 20rb Makan siang</code><br>
          <code style="font-family:var(--mono);font-size:10.5px;background:var(--surface);padding:1px 4px;border-radius:3px">= Subtotal</code><br><br>
          <b style="color:var(--text)">Suffix didukung:</b> <code>k</code>, <code>rb</code>, <code>jt</code>/<code>juta</code>, <code>m</code>, <code>b</code>/<code>bn</code><br>
          <b style="color:var(--text)">Separator:</b> <code>1.250.000</code> (ID) atau <code>1,250,000</code> (EN)<br>
          <b style="color:var(--text)">Operator:</b> <code>+</code> <code>-</code> <code>*</code> <code>/</code> <code>=</code> (subtotal)
        </div>
      </div>`;
    return;
  } catch (e) {
    console.error('[RecallFox/Tape] openTapePopover failed:', e);
    toast('Gagal membuka RecallTape: ' + e.message, false);
  }
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
    +   '<div class="habit-config-row"><div><b>Target ngaji</b><span>Ukuran paling sederhana: halaman</span></div><select id="quranTargetSel">'
    +     [1,2,4].map(n => '<option value="' + n + '"' + (n === qTarget ? ' selected' : '') + '>' + n + ' halaman / hari</option>').join('')
    +   '</select></div>'
    +   '<div class="habit-config-row"><div><b>Waktu ngaji</b><span>Hanya sebagai pengingat, bukan batas</span></div><input id="quranTimeInput" type="time" value="' + esc(s.quranReminderTime || '18:15') + '"></div>'
    +   '<div class="habit-config-row"><div><b>Jenis olahraga</b><span>Pilih aktivitas favorit</span></div><select id="sportTypeSel">'
    +     ['Jalan cepat', 'Lari', 'Bersepeda', 'Latihan kekuatan', 'Peregangan / yoga'].map(n => '<option>' + n + '</option>').join('')
    +   '</select></div>'
    +   '<div class="habit-config-row"><div><b>Target olahraga</b><span>Durasi per sesi</span></div><select id="sportTargetSel">'
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
  // v3.20.2: Pre-populate checkboxes from settings (sebelumnya selalu default 'cache' checked).
  const savedTypes = Array.isArray(s.clearCacheDataTypes) ? s.clearCacheDataTypes : ['cache'];
  const types = ['Cache', 'Cookies', 'Riwayat', 'Local Storage', 'Downloads'];
  const typeKey = x => x.toLowerCase().replace(' ', '_');
  B.innerHTML = '<div class="card"><h3>Tipe data</h3>'
    + types.map((x) => {
      const k = typeKey(x);
      const checked = savedTypes.includes(k) ? ' checked' : '';
      return '<label class="checkrow"><input type="checkbox" data-cache="' + k + '"' + checked + '>' + x + '</label>';
    }).join('')
    + '<label class="checkrow" style="color:var(--danger)"><input type="checkbox" data-cache="passwords"' + (savedTypes.includes('passwords') ? ' checked' : '') + '>Passwords ⚠️</label></div>'
    + '<div class="card"><h3>Periode</h3><select class="f" id="cachePeriod">'
    + [['all','Semua waktu'],['15m','15 menit terakhir'],['1h','1 jam terakhir'],['24h','24 jam terakhir'],['1w','1 minggu terakhir']]
        .map(([v,l]) => '<option value="' + v + '"' + (s.clearCacheTimePeriod === v ? ' selected' : '') + '>' + l + '</option>').join('')
    + '</select></div>'
    + '<button class="btn btn-d" style="width:100%" id="cacheGo">' + ICONS.trash + 'Bersihkan Sekarang</button>';
  $('#cacheGo').addEventListener('click', async () => {
    // v3.20.2: Collect selected checkboxes + period → pass directly in CLEAR_CACHE message.
    // Sebelumnya: kirim CLEAR_CACHE tanpa payload, background baca settings lama (default hanya 'cache'),
    // pilihan user diabaikan. Sekarang: kirim dataTypes + timePeriod di message, background pakai
    // nilai dari message (fallback ke settings kalau tidak ada).
    const selectedTypes = Array.from(B.querySelectorAll('input[data-cache]:checked'))
      .map(el => el.dataset.cache)
      .filter(Boolean);
    if (selectedTypes.length === 0) {
      toast('Pilih minimal 1 tipe data untuk dibersihkan', false);
      return;
    }
    const periodSel = $('#cachePeriod');
    const selectedPeriod = periodSel ? periodSel.value : 'all';

    openSheet('Konfirmasi', 'Aksi ini tidak bisa dibatalkan', b => {
      b.innerHTML = '<div class="confirmstrip"><span style="flex:1">Hapus data browsing terpilih?</span>'
        + '<button class="btn btn-g" data-c="0">Batal</button><button class="btn btn-d" data-c="1">Ya, bersihkan</button></div>';
      b.querySelector('[data-c="0"]').addEventListener('click', closeSheet);
      b.querySelector('[data-c="1"]').addEventListener('click', async () => {
        closeSheet();
        try {
          const res = await browser.runtime.sendMessage({
            type: 'CLEAR_CACHE',
            dataTypes: selectedTypes,
            timePeriod: selectedPeriod
          });
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
  // v3.20.22: Pakai openSettings() helper dengan fallback (iframe-safe)
  $('#goSettings').addEventListener('click', () => openSettings());
}

// v3.11.1 (Issue 4): Halaman "Kelola Situs AI"
// User bisa: pin/unpin, hide/unhide, add custom site, delete custom site.
// Set perubahan disimpan di settings.aiToolsCustomizations.
async function renderAiManagePage(B) {
  const s = currentVault?.settings || {};
  const customizations = s.aiToolsCustomizations || {};
  const allTools = getEffectiveTools(customizations);

  const render = () => {
    const currentCust = (currentVault?.settings?.aiToolsCustomizations) || {};
    const tools = getEffectiveTools(currentCust);
    const pinned = tools.filter(t => t.pinned && !t.hidden);
    const visible = tools.filter(t => !t.pinned && !t.hidden);
    const hidden = tools.filter(t => t.hidden);
    const custom = tools.filter(t => t.custom);

    const row = (t) => {
      const pinnedBtn = t.pinned
        ? '<button class="btn btn-g ai-action-btn ai-unpin" data-id="' + esc(t.id) + '" data-act="unpin" title="Lepas pin" style="background:var(--amber-soft);color:var(--amber);border-color:transparent">⭐ Unpin</button>'
        : '<button class="btn btn-g ai-action-btn ai-pin" data-id="' + esc(t.id) + '" data-act="pin" title="Pin ke atas">☆ Pin</button>';
      const hideBtn = '<button class="btn btn-g ai-action-btn ai-hide" data-id="' + esc(t.id) + '" data-act="hide" title="Sembunyikan dari daftar">👁️ Hide</button>';
      const deleteBtn = t.custom
        ? '<button class="btn btn-d ai-action-btn ai-delete" data-id="' + esc(t.id) + '" data-act="delete" title="Hapus permanen">🗑️</button>'
        : '';
      const customBadge = t.custom ? ' <span style="font-size:9px;background:var(--violet-soft);color:var(--violet);padding:1px 5px;border-radius:4px;font-weight:700;margin-left:4px">CUSTOM</span>' : '';
      const pinnedBadge = t.pinned ? ' <span style="color:var(--amber)">⭐</span>' : '';
      return '<div class="ai-mgmt-row" data-id="' + esc(t.id) + '">'
        + '<div class="ai-mgmt-ic">' + (t.emoji || '🤖') + '</div>'
        + '<div class="ai-mgmt-main">'
        + '<div class="ai-mgmt-name">' + esc(t.name) + customBadge + pinnedBadge + '</div>'
        + '<div class="ai-mgmt-url">' + esc(t.url) + '</div>'
        + '</div>'
        + '<div class="ai-mgmt-actions">'
        + pinnedBtn + hideBtn + deleteBtn
        + '</div>'
        + '</div>';
    };

    let html = '';
    // Intro
    html += '<div class="card" style="background:linear-gradient(135deg,var(--primary-soft),var(--surface-2));border:1px solid var(--primary)">'
      + '<div style="display:flex;align-items:center;gap:10px">'
      + '<div style="font-size:24px">⚙️</div>'
      + '<div style="flex:1">'
      + '<div style="font-size:13px;font-weight:700;color:var(--primary)">Kelola Situs AI</div>'
      + '<div style="font-size:11px;color:var(--text-2);margin-top:2px;line-height:1.5">Pin situs yang sering dipakai ke atas, sembunyikan yang tidak pernah dipakai, atau tambah situs AI baru yang custom.</div>'
      + '</div></div></div>';

    // Stats summary
    html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px">'
      + '<div style="text-align:center;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 8px">'
      + '<div style="font-size:18px;font-weight:750;color:var(--primary)">' + pinned.length + '</div>'
      + '<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-top:2px">Dipin</div></div>'
      + '<div style="text-align:center;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 8px">'
      + '<div style="font-size:18px;font-weight:750;color:var(--text)">' + (pinned.length + visible.length) + '</div>'
      + '<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-top:2px">Aktif</div></div>'
      + '<div style="text-align:center;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 8px">'
      + '<div style="font-size:18px;font-weight:750;color:var(--muted)">' + hidden.length + '</div>'
      + '<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-top:2px">Disembunyikan</div></div>'
      + '</div>';

    html += '</div>';

    // Add custom site form
    html += '<div class="card">'
      + '<h3>➕ Tambah Situs AI Custom</h3>'
      + '<div class="ai-add-form">'
      + '<div class="ai-add-row"><label>Nama</label><input id="aiAddName" type="text" placeholder="mis. MyAI" /></div>'
      + '<div class="ai-add-row"><label>URL</label><input id="aiAddUrl" type="text" placeholder="https://myai.example.com/" /></div>'
      + '<div class="ai-add-row"><label>Emoji (opsional)</label><input id="aiAddEmoji" type="text" placeholder="🤖" maxlength="4" style="max-width:80px" /></div>'
      + '<div class="ai-add-row"><label>Region</label>'
      + '<select id="aiAddRegion">'
      + '<option value="west">🌍 Barat</option>'
      + '<option value="china">🇨🇳 China</option>'
      + '<option value="local">🇮🇩 Lokal</option>'
      + '</select></div>'
      + '</div>'
      + '<button class="btn btn-p" id="aiAddBtn" style="margin-top:10px;width:100%">➕ Tambah Situs</button>'
      + '</div>';

    // Pinned section
    if (pinned.length) {
      html += '<div class="card"><h3>⭐ Dipin (' + pinned.length + ')</h3>'
        + '<div class="ai-mgmt-list">' + pinned.map(row).join('') + '</div></div>';
    }
    // Active (non-pinned, visible)
    if (visible.length) {
      html += '<div class="card"><h3>📋 Aktif (' + visible.length + ')</h3>'
        + '<div class="ai-mgmt-list">' + visible.map(row).join('') + '</div></div>';
    }
    // Hidden section
    if (hidden.length) {
      html += '<div class="card"><h3>🚫 Disembunyikan (' + hidden.length + ')</h3>'
        + '<div class="ai-mgmt-list">' + hidden.map(row).join('') + '</div></div>';
    }
    // Custom sites info
    if (custom.length) {
      html += '<div class="hintbox" style="margin-top:10px">💡 <b>' + custom.length + ' situs custom</b> — ditandai badge "CUSTOM". Bisa dihapus permanen dengan tombol 🗑️.</div>';
    }

    B.innerHTML = html;

    // Bind action buttons (pin/unpin/hide/unhide/delete)
    B.querySelectorAll('.ai-action-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const act = btn.dataset.act;
        const cust = { ...((currentVault?.settings?.aiToolsCustomizations) || {}) };
        if (!cust[id]) cust[id] = {};
        if (act === 'pin') { cust[id].pinned = true; toast('⭐ Dipin ke atas'); }
        else if (act === 'unpin') { cust[id].pinned = false; toast('☆ Pin dilepas'); }
        else if (act === 'hide') { cust[id].hidden = true; toast('👁️ Disembunyikan'); }
        else if (act === 'unhide') { cust[id].hidden = false; toast('👁️ Ditampilkan kembali'); }
        else if (act === 'delete') {
          // Confirm before delete
          if (!confirm('Hapus situs custom ini permanen? Tidak bisa dibatalkan.')) return;
          delete cust[id];
          toast('🗑️ Situs custom dihapus');
        }
        await saveSettings({ aiToolsCustomizations: cust });
        await refreshVault();
        render();
      });
    });

    // Also update unhide buttons in hidden section — they use act="hide" with already-hidden tool
    // Re-bind: untuk tool yang sudah hidden, tombol "Hide" jadi "Unhide"
    B.querySelectorAll('.ai-mgmt-row').forEach(r => {
      const id = r.dataset.id;
      const cust = (currentVault?.settings?.aiToolsCustomizations) || {};
      const isHidden = cust[id]?.hidden === true;
      const hideBtn = r.querySelector('.ai-hide');
      if (hideBtn && isHidden) {
        hideBtn.textContent = '👁️ Unhide';
        hideBtn.dataset.act = 'unhide';
        hideBtn.style.background = 'var(--green-soft)';
        hideBtn.style.color = 'var(--green)';
        hideBtn.style.borderColor = 'transparent';
      }
    });

    // Bind add button
    const addBtn = B.querySelector('#aiAddBtn');
    if (addBtn) addBtn.addEventListener('click', async () => {
      const name = B.querySelector('#aiAddName').value.trim();
      const url = B.querySelector('#aiAddUrl').value.trim();
      const emoji = B.querySelector('#aiAddEmoji').value.trim() || '🤖';
      const region = B.querySelector('#aiAddRegion').value;
      if (!name) { toast('⚠️ Nama wajib diisi', 'err'); return; }
      if (!url || !/^https?:\/\//.test(url)) { toast('⚠️ URL tidak valid (harus http/https)', 'err'); return; }
      // Generate unique id
      const customId = 'custom_' + Date.now().toString(36);
      const cust = { ...((currentVault?.settings?.aiToolsCustomizations) || {}) };
      cust[customId] = { custom: true, name, url, region, emoji, alt: [], pinned: false, hidden: false };
      await saveSettings({ aiToolsCustomizations: cust });
      await refreshVault();
      toast('✅ ' + name + ' ditambahkan');
      render();
    });
  };

  render();
}

// v3.7: Halaman Backup — UI lengkap dengan export/import/info langsung
// v3.8.1 (Issue #1, #2, #6): Halaman Sync Google Drive — bilah Alat
// User set URL Web App + token di sini, lalu test koneksi / sync now / full backup.
async function renderGDrivePage(B) {
  const s = currentVault?.settings || {};

  // Ambil status sync terbaru dari background (GDrive Sync)
  let syncStatus = { meta: { lastSyncAt: null, lastError: null, totalSynced: 0, totalFailed: 0 }, queueLength: 0 };
  try {
    const r = await browser.runtime.sendMessage({ type: 'GDRIVE_STATUS' });
    if (r?.ok) syncStatus = { meta: r.meta, queueLength: r.queueLength };
  } catch (e) {}

  // v3.11.7-fix (Issue #5): Ambil juga status Multi-PC Sync
  let multiPcStatus = { hasActive: false, activeProfile: null, profiles: [] };
  try {
    const r = await browser.runtime.sendMessage({ type: 'SYNC_STATUS' });
    if (r?.ok && r.status) multiPcStatus = r.status;
  } catch (e) {}

  const enabled = !!s.gdriveSyncEnabled;
  const configured = !!(s.gdriveWebAppUrl && s.gdriveAuthToken);
  // v3.11.7-fix (Issue #3): Lock token — read-only by default, butuh klik "Unlock" untuk edit
  const tokenLocked = s.gdriveTokenLocked !== false; // default locked

  let statusBadge = '⛔ Nonaktif';
  let statusColor = '#6b7280';
  if (enabled && !configured) {
    statusBadge = '⚠️ URL/Token belum diisi';
    statusColor = '#d97706';
  } else if (enabled && configured && syncStatus.meta?.lastError) {
    statusBadge = '❌ Error: ' + (syncStatus.meta.lastError || '').slice(0, 60);
    statusColor = '#dc2626';
  } else if (enabled && configured && syncStatus.meta?.lastSyncAt) {
    const d = new Date(syncStatus.meta.lastSyncAt);
    statusBadge = '✅ Sync terakhir: ' + d.toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })
                + ' (' + (syncStatus.meta.totalSynced || 0) + ' total)';
    statusColor = '#059669';
  } else if (enabled && configured) {
    statusBadge = '⏳ Belum pernah sync';
    statusColor = '#6b7280';
  }

  // v3.11.7-fix (Issue #5): Status Multi-PC Sync
  let multiPcBadge = '⛔ Belum ada profile aktif';
  let multiPcColor = '#6b7280';
  if (multiPcStatus.hasActive && multiPcStatus.activeProfile) {
    const p = multiPcStatus.activeProfile;
    const lastSync = p.lastSyncAt ? new Date(p.lastSyncAt).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' }) : 'belum pernah';
    multiPcBadge = '✅ Profile: ' + (p.name || '?') + ' · Last: ' + lastSync + ' · ' + (p.lastSyncDirection || '-');
    multiPcColor = '#059669';
  }

  // v3.11.21: Ambil status Supabase
  let supabaseStatus = { loggedIn: false };
  try {
    const r = await browser.runtime.sendMessage({ type: 'SUPABASE_STATUS' });
    if (r?.ok && r.status) supabaseStatus = r.status;
  } catch (e) {}

  B.innerHTML =
    // ===== SECTION 0: Supabase Login (v3.11.21) — Auto-sync, lebih mudah dari Apps Script =====
    // User feedback: "saya frustasi dengan apps script yang tidak berhasil sudah dua hari
    // untuk save gambar screenshot di drive. oleh karena itu buatkan databasenya menggunakan
    // suppabase untuk menyimpan seluruh data yang dihasilkan di dalam addon"
    '<div class="card" style="background:linear-gradient(135deg,#15803d,#166534);color:#f0fdf4;border:none">'
    + '<div style="font-size:11px;opacity:.85">🟢 Supabase Cloud Sync (NEW — otomatis, lebih mudah)</div>'
    + '<div style="font-size:13px;font-weight:600;margin:4px 0;color:#fff">'
    + (supabaseStatus.loggedIn
        ? '✅ Login: ' + esc(supabaseStatus.user?.email || 'user')
        : '⛔ Belum login')
    + '</div>'
    + (supabaseStatus.loggedIn && supabaseStatus.lastSync
        ? '<div style="font-size:11px;opacity:.85">Last sync: ' + esc(supabaseStatus.lastSync.direction || '-') + ' · ' + (supabaseStatus.lastSync.at ? new Date(supabaseStatus.lastSync.at).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' }) : 'belum') + '</div>'
        : '<div style="font-size:11px;opacity:.85">Login sekali → semua data otomatis sync ke cloud</div>')
    + '</div>'

    // Supabase Login Form / User Info
    + '<div class="card"><h3>🔐 Login Supabase</h3>'
    + '<div class="hintbox" style="margin:0 0 10px;font-size:11px;line-height:1.55;background:#f0fdf4;border:1px solid #bbf7d0;color:#14532d">'
    + '<b>Kenapa Supabase?</b> Apps Script ribet (URL + Token + deploy). Supabase cukup <b>login email/password</b> sekali → semua data (vault, catatan, screenshot, settings) <b>otomatis sync</b> ke cloud. Screenshot full image disimpan di Supabase Storage (tidak ke-limit Apps Script 10MB).<br>'
    + '<b>Setup:</b> 1) Login email/password di bawah (atau klik "Buat akun baru" untuk signup). 2) Klik "Push ke Cloud" untuk upload state lokal. 3) Di PC lain: login sama → klik "Pull dari Cloud".'
    + '</div>';

  if (supabaseStatus.loggedIn) {
    // User sudah login — tampilkan info + tombol sync
    B.innerHTML += '<div style="margin:8px 0;padding:10px;background:var(--surface-2);border-radius:8px">'
      + '<div style="font-size:12px"><b>Email:</b> ' + esc(supabaseStatus.user?.email || '-') + '</div>'
      + '<div style="font-size:11px;color:var(--muted);margin-top:2px"><b>User ID:</b> ' + esc(supabaseStatus.userId || '-') + '</div>'
      + '</div>'
      + '<div class="btn-row" style="flex-direction:column;gap:6px">'
      +   '<button class="btn btn-p" id="rfSupaFullSync" style="width:100%;background:linear-gradient(135deg,#15803d,#166534)">🔄 Sync Full (push + pull)</button>'
      +   '<div class="btn-row" style="gap:6px">'
      +     '<button class="btn btn-g" id="rfSupaPush" style="flex:1">📤 Push ke Cloud</button>'
      +     '<button class="btn btn-g" id="rfSupaPull" style="flex:1">📥 Pull dari Cloud</button>'
      +   '</div>'
      +   '<button class="btn btn-g" id="rfSupaLogout" style="width:100%;background:#fee2e2;color:#991b1b">🚪 Logout</button>'
      + '</div>';
  } else {
    // Form login
    B.innerHTML += '<div style="display:flex;flex-direction:column;gap:6px">'
      +   '<input class="f" id="rfSupaEmail" type="email" placeholder="Email" style="font-size:12px">'
      +   '<input class="f" id="rfSupaPass" type="password" placeholder="Password" style="font-size:12px">'
      +   '<button class="btn btn-p" id="rfSupaLogin" style="width:100%;background:linear-gradient(135deg,#15803d,#166534)">🔐 Login</button>'
      +   '<div style="text-align:center;font-size:10px;color:var(--muted);margin:4px 0">— atau —</div>'
      +   '<button class="btn btn-g" id="rfSupaGmail" style="width:100%;background:#fff;color:#1f2937;border:1px solid #d1d5db">'
      +     '<span style="display:inline-flex;align-items:center;gap:6px">'
      +       '<svg width="16" height="16" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>'
      +       'Login dengan Gmail'
      +     '</span>'
      +   '</button>'
      +   '<button class="btn btn-g" id="rfSupaSignup" style="width:100%;font-size:11px">📝 Buat akun baru</button>'
      +   '<button class="btn btn-g" id="rfSupaTestConn" style="width:100%;font-size:11px">🔌 Test Koneksi Supabase</button>'
      + '</div>';
  }

  B.innerHTML += '<div id="rfSupaResult" style="margin-top:8px;font-size:11px;display:none"></div>'
    + '</div>'

    // ===== HEADER: Status gabungan GDrive + Multi-PC =====
    + '<div class="card" style="background:linear-gradient(135deg,#1e3a8a,#1e40af);color:#eff6ff;border:none">'
    + '<div style="font-size:11px;opacity:.85">Status GDrive Sync (one-way push)</div>'
    + '<div style="font-size:13px;font-weight:600;margin:4px 0;color:#fff">' + esc(statusBadge) + '</div>'
    + '<div style="font-size:11px;opacity:.85">Queue: ' + (syncStatus.queueLength || 0) + ' item · Gagal: ' + (syncStatus.meta?.totalFailed || 0) + '</div>'
    + '<hr style="border:none;border-top:1px solid rgba(255,255,255,.2);margin:8px 0">'
    + '<div style="font-size:11px;opacity:.85">Status Multi-PC Sync (bidirectional)</div>'
    + '<div style="font-size:13px;font-weight:600;margin:4px 0;color:' + multiPcColor + ';color:#fff">' + esc(multiPcBadge) + '</div>'
    + '</div>'

    // ===== SECTION 1: Hubungkan ke Google Drive (URL + Token + Copy URL + Lock Token) =====
    // v3.11.8 (Issue #4): Simplify labeling — ganti "Konfigurasi" jadi "Hubungkan ke Google Drive".
    // User report: "ini tu masuk ke logika buat akun baru untuk konfigurasi dan multi pc sync
    // ini untuk login? karena terasa tidak familiar penyebutannya."
    // Fix: Pakai istilah yang familiar — "Hubungkan" (bukan "Konfigurasi"), "Kunci" (bukan "Lock"),
    // "Sandi" (bukan "Token"). Tambah penjelasan singkat di atas: Bukan login, ini jembatan.
    + '<div class="card"><h3>🔗 Hubungkan ke Google Drive</h3>'
    + '<div class="hintbox" style="margin:0 0 10px;font-size:11px;line-height:1.55;background:#f0f9ff;border:1px solid #bae6fd;color:#0c4a6e">'
    +   '<b>💡 Ini BUKAN login akun.</b> RecallFox tidak punya server, tidak punya akun. '
    +   'Anda hanya perlu menghubungkan addon ini ke <b>Apps Script milik Anda sendiri</b> '
    +   '(yang Anda buat dari Spreadsheet Anda). Seperti menghubungkan Bluetooth — perlu kode '
    +   'pasangan supaya aman.'
    +   '<br><br>'
    +   '<b>Cara pakai:</b><br>'
    +   '1. Deploy Apps Script Web App (lihat panduan di bawah) → dapat <b>URL Web App</b><br>'
    +   '2. Klik <b>🎲 Generate</b> di bawah untuk buat sandi acak<br>'
    +   '3. Copy sandi, paste ke <code>AUTH_TOKEN</code> di Code.gs Apps Script Anda<br>'
    +   '4. Tempel <b>URL Web App</b> + <b>sandi</b> di bawah → klik <b>Simpan</b><br>'
    +   '5. Klik <b>Test Koneksi</b> → harus "✅ Terhubung!"<br>'
    +   '6. Untuk pakai di PC lain: copy URL+sandi, paste di PC lain (tidak perlu deploy ulang)'
    + '</div>'
    + '<div style="margin:8px 0">'
    +   '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">'
    +     '<label style="font-size:11px;color:var(--muted)"><b>Aktifkan sinkronisasi</b> (master switch)</label>'
    +     '<label class="ks-toggle' + (enabled ? ' on' : '') + '" id="rfGdToggle" aria-label="Toggle GDrive sync"><i></i></label>'
    +   '</div>'
    + '</div>'
    // v3.11.7-fix (Issue #3): Web App URL + tombol Copy URL
    + '<div style="margin:10px 0">'
    +   '<label style="font-size:11px;color:var(--muted)"><b>URL Web App</b> (alamat Apps Script Anda)</label>'
    +   '<div style="display:flex;gap:6px;margin-top:4px">'
    +     '<input class="f" id="rfGdUrl" value="' + esc(s.gdriveWebAppUrl || '') + '" placeholder="https://script.google.com/macros/s/AKfyc.../exec" style="flex:1;font-size:11px">'
    +     '<button class="btn btn-g" id="rfGdCopyUrl" title="Salin URL — paste di PC lain untuk multi-PC sync" style="flex:none;padding:6px 10px;font-size:11px">📋 Copy URL</button>'
    +   '</div>'
    +   '<div style="font-size:10px;color:var(--muted);margin-top:3px">Klik <b>📋 Copy URL</b> untuk salin ke clipboard. Paste di PC lain di field yang sama.</div>'
    + '</div>'
    // v3.11.7-fix (Issue #3): Sandi rahasia dengan LOCK protection
    + '<div style="margin:10px 0">'
    +   '<label style="font-size:11px;color:var(--muted)"><b>Sandi rahasia</b> (HARUS sama dengan <code>AUTH_TOKEN</code> di Code.gs Anda)</label>'
    +   '<div style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap">'
    +     '<input type="' + (tokenLocked ? 'password' : 'text') + '" class="f" id="rfGdToken" value="' + esc(s.gdriveAuthToken || '') + '" placeholder="32 karakter acak" style="flex:1;min-width:120px;font-size:11px"' + (tokenLocked ? ' readonly' : '') + '>'
    +     '<button class="btn btn-g" id="rfGdLockToken" title="' + (tokenLocked ? 'Buka kunci untuk edit sandi' : 'Kunci sandi agar tidak terketik tidak sengaja') + '" style="flex:none;padding:6px 10px;font-size:11px">' + (tokenLocked ? '🔓 Buka' : '🔒 Kunci') + '</button>'
    +     '<button class="btn btn-g" id="rfGdGenToken" title="Buat sandi acak (butuh konfirmasi kalau sudah ada)" style="flex:none;padding:6px 10px;font-size:11px">🎲 Generate</button>'
    +     '<button class="btn btn-g" id="rfGdCopyToken" title="Salin sandi ke clipboard" style="flex:none;padding:6px 10px;font-size:11px">📋 Copy</button>'
    +   '</div>'
    +   '<div style="font-size:10px;color:var(--muted);margin-top:3px">'
    +     (tokenLocked ? '🔒 Sandi <b>terkunci</b> (read-only) — klik 🔓 Buka untuk edit. Mencegah ketimpa tidak sengaja.' : '⚠️ Sandi <b>terbuka</b> — bisa diedit. Klik 🔒 Kunci setelah selesai.')
    +     '<br>Klik 🎲 Generate untuk buat sandi acak, lalu 📋 Copy dan paste ke <code>AUTH_TOKEN</code> di Code.gs Apps Script Anda.'
    +   '</div>'
    + '</div>'
    + '<button class="btn btn-g" id="rfGdSave" style="width:100%;margin-top:6px">💾 Simpan & Hubungkan</button></div>'

    // ===== SECTION 2: Aksi Cepat (gabungan GDrive + Multi-PC) =====
    + '<div class="card"><h3>🚀 Aksi Cepat (1 klik)</h3>'
    + '<div class="hintbox" style="margin-bottom:8px;font-size:11px">'
    +   '<b>Test Koneksi</b>: cek URL+Token valid.<br>'
    +   '<b>🔄 Sync Sekarang</b>: flush queue GDrive Sync (push perubahan tertunda ke spreadsheet).<br>'
    +   '<b>💾 Full Backup</b>: kirim SEMUA item existing ke GDrive Spreadsheet (one-time, untuk first setup).<br>'
    +   '<b>📤 Push (Multi-PC)</b>: upload state vault saat ini ke cloud (untuk PC lain ambil).<br>'
    +   '<b>📥 Pull (Multi-PC)</b>: download state dari cloud ke PC ini (merge, tidak overwrite).<br>'
    +   '<b>🔄 Sync Full (Multi-PC)</b>: push + pull sekaligus (bidirectional).<br>'
    +   '<b>🗑 Reset Queue</b>: bersihkan queue GDrive yang tertunda (item belum terkirim akan dibuang).'
    + '</div>'
    + '<div class="btn-row" style="flex-direction:column;gap:6px">'
    +   '<button class="btn btn-g" id="rfGdTest" style="width:100%">🔗 Test Koneksi</button>'
    +   '<button class="btn btn-p" id="rfGdSyncNow" style="width:100%">🔄 Sync Sekarang (GDrive queue)</button>'
    +   '<button class="btn btn-p" id="rfGdFullBackup" style="width:100%">💾 Full Backup ke GDrive (one-time)</button>'
    +   '<div style="border-top:1px dashed var(--border);margin:4px 0;padding-top:6px"></div>'
    +   '<button class="btn btn-p" id="rfSyncFull" style="width:100%;background:linear-gradient(135deg,#7c3aed,#5b21b6)">🔄 Sync Full Multi-PC (push+pull)</button>'
    +   '<div class="btn-row" style="gap:6px">'
    +     '<button class="btn btn-g" id="rfSyncPush" style="flex:1">📤 Push</button>'
    +     '<button class="btn btn-g" id="rfSyncPull" style="flex:1">📥 Pull</button>'
    +   '</div>'
    +   '<button class="btn btn-g" id="rfGdClearQueue" style="width:100%;background:#fee2e2;color:#991b1b">🗑 Reset Queue GDrive (' + (syncStatus.queueLength || 0) + ' item)</button>'
    + '</div></div>'

    // ===== SECTION 3: Multi-PC Profile Manager (inline, bukan modal) =====
    + '<div class="card"><h3>👥 Multi-PC Profile Manager</h3>'
    + '<div class="hintbox" style="margin-bottom:8px;font-size:11px">'
    +   '<b>Apa itu Profile?</b> Profile = pasangan URL+Token untuk satu Apps Script deployment. '
    +   'Pakai 1 profile untuk multi-PC (Anda punya data sama di beberapa PC), atau multi-profile untuk multi-user (Anda, istri, teman — data terpisah).'
    + '</div>'
    + '<div id="rfSyncProfileList" style="margin-bottom:10px"></div>'
    + '<div style="border-top:1px dashed var(--border);padding-top:10px">'
    +   '<h4 style="font-size:11px;font-weight:700;margin-bottom:6px">➕ Tambah Profile Baru</h4>'
    +   '<div style="display:flex;flex-direction:column;gap:6px">'
    +     '<input class="f" id="rfSyncProfName" type="text" placeholder="Nama profile (mis. Kantor, Rumah, Istri)" style="font-size:11px">'
    +     '<input class="f" id="rfSyncProfUrl" type="url" placeholder="URL Apps Script (https://script.google.com/macros/s/.../exec)" style="font-size:11px">'
    +     '<input class="f" id="rfSyncProfToken" type="password" placeholder="Token (sama dengan CONFIG.AUTH_TOKEN di Apps Script)" style="font-size:11px">'
    +     '<div class="btn-row" style="gap:6px">'
    +       '<button class="btn btn-g" id="rfSyncProfTest" style="flex:1">🔌 Test Koneksi</button>'
    +       '<button class="btn btn-p" id="rfSyncProfAdd" style="flex:1">➕ Tambah & Aktifkan</button>'
    +     '</div>'
    +   '</div>'
    +   '<div id="rfSyncProfResult" style="margin-top:6px;font-size:11px;display:none"></div>'
    + '</div></div>'

    // ===== SECTION 4: Opsi Sync =====
    + '<div class="card"><h3>🔧 Opsi Sync</h3>'
    + '<div class="krow" style="padding:6px 0">'
    +   '<div><b>GDrive: sync real-time saat save</b><div style="font-size:11px;color:var(--muted)">Setiap tambah/edit/hapus item langsung dikirim ke spreadsheet (debounced 2s)</div></div>'
    +   '<button class="ks-toggle' + (s.gdriveSyncOnSave !== false ? ' on' : '') + '" id="rfGdOnSave" aria-label="Toggle sync-on-save"><i></i></button>'
    + '</div>'
    + '<div class="krow" style="padding:6px 0">'
    +   '<div><b>GDrive: upload screenshot ke Drive</b><div style="font-size:11px;color:var(--muted)">Full image screenshot disimpan sebagai file PNG/JPEG di folder Drive. Pakai kompresi <b>Tinggi (JPEG q60)</b> supaya < 10MB.</div></div>'
    +   '<button class="ks-toggle' + (s.gdriveSyncScreenshots !== false ? ' on' : '') + '" id="rfGdShots" aria-label="Toggle screenshot upload"><i></i></button>'
    + '</div>'
    + '<div class="krow" style="padding:6px 0">'
    +   '<div><b>Multi-PC: auto-sync (debounced 30s)</b><div style="font-size:11px;color:var(--muted)">Setiap vault berubah, otomatis push+pull ke cloud (butuh profile aktif)</div></div>'
    +   '<button class="ks-toggle' + (s.syncAutoEnabled ? ' on' : '') + '" id="rfSyncAuto" aria-label="Toggle auto-sync"><i></i></button>'
    + '</div>'
    + '<div class="krow" style="padding:6px 0">'
    +   '<div><b>Auto-sync ke GDrive saat backup lokal</b><div style="font-size:11px;color:var(--muted)">Tombol "Backup sekarang" lokal juga kirim ke GDrive</div></div>'
    +   '<button class="ks-toggle' + (s.gdriveAutoBackupOnLocalBackup !== false ? ' on' : '') + '" id="rfGdAutoBak" aria-label="Toggle auto-backup-on-local-backup"><i></i></button>'
    + '</div>'
    + '<div style="margin:8px 0">'
    +   '<label style="font-size:11px;color:var(--muted)">Interval flush periodik GDrive (menit, min 1)</label>'
    +   '<input type="number" class="f" id="rfGdInterval" value="' + (s.gdriveSyncIntervalMinutes || 5) + '" min="1" max="60" style="width:80px;margin-top:4px">'
    + '</div></div>'

    // ===== SECTION 5: Panduan Setup Detil =====
    + '<div class="card"><h3>📖 Panduan Setup Detil (Step-by-Step)</h3>'
    + '<div style="font-size:11.5px;line-height:1.6;color:var(--text-2)">'
    +   '<div style="margin-bottom:8px;padding:6px 8px;background:var(--surface-2);border-radius:6px">'
    +     '<b>❓ Apakah GDrive Sync sama dengan Multi-PC Sync?</b><br>'
    +     '<span style="color:var(--muted)">TEKNOLOGI SAMA (Apps Script Web App + Spreadsheet), tapi FUNGSI BERBEDA:<br>'
    +     '• <b>GDrive Sync</b> = <i>one-way push</i> real-time. Setiap save/hapus item langsung dikirim ke sheet terpisah (02_Prompts, 03_Konteks, dst.). Cocok untuk backup otomatis.<br>'
    +     '• <b>Multi-PC Sync</b> = <i>bidirectional</i> seluruh state. Pakai sheet "SyncState" terpisah. Cocok untuk punya data sama di beberapa PC (push dari PC-1, pull di PC-2).<br>'
    +     'Keduanya pakai URL+Token yang sama. Bisa dipakai bersamaan.</span>'
    +   '</div>'
    +   '<div style="margin-bottom:8px;padding:6px 8px;background:var(--surface-2);border-radius:6px">'
    +     '<b>🆕 Setup PC pertama (3 langkah):</b><br>'
    +     '<span style="color:var(--muted)">1. Deploy Apps Script Web App (lihat langkah A–H di bawah).<br>'
    +     '2. Isi <b>Web App URL</b> + <b>Auth Token</b> di Konfigurasi atas → klik <b>Simpan</b>.<br>'
    +     '3. Klik <b>💾 Full Backup ke GDrive</b> (kirim semua item existing ke spreadsheet).</span>'
    +   '</div>'
    +   '<div style="margin-bottom:8px;padding:6px 8px;background:var(--surface-2);border-radius:6px">'
    +     '<b>💻 Setup PC kedua (3 langkah):</b><br>'
    +     '<span style="color:var(--muted)">1. Install RecallFox di PC-2.<br>'
    +     '2. Buka <b>Sync Cloud</b> di sidebar → klik <b>📋 Copy URL</b> dari PC-1 (atau ketik manual) → isi URL+Token sama.<br>'
    +     '3. Klik <b>📥 Pull</b> (Multi-PC Sync) → semua data ter-restore ke PC-2.</span>'
    +   '</div>'
    +   '<ol style="padding-left:18px;margin:0">'
    +     '<li style="margin-bottom:6px"><b>Buat Spreadsheet baru</b> di <a href="https://sheets.google.com" target="_blank">sheets.google.com</a> (atau pakai yang sudah ada).</li>'
    +     '<li style="margin-bottom:6px"><b>Buka Apps Script</b>: dari Spreadsheet, klik <code>Extensions → Apps Script</code>.</li>'
    +     '<li style="margin-bottom:6px"><b>Hapus kode default</b>, lalu <b>paste isi file <code>Code.gs</code></b> dari folder <code>appscript/</code> RecallFox.</li>'
    +     '<li style="margin-bottom:6px"><b>Ganti <code>SPREADSHEET_ID</code></b> di Code.gs dengan ID Spreadsheet Anda (dari URL sheet: <code>docs.google.com/spreadsheets/d/<b>[INI_ID_ANDA]</b>/edit</code>).</li>'
    +     '<li style="margin-bottom:6px"><b>Klik tombol 🎲 Generate di atas</b> (Unlock dulu kalau token sudah ada) untuk buat token acak, lalu klik 📋 Copy.</li>'
    +     '<li style="margin-bottom:6px"><b>Paste token ke <code>AUTH_TOKEN</code></b> di Code.gs Apps Script (ganti placeholder).</li>'
    +     '<li style="margin-bottom:6px"><b>Run fungsi <code>setup</code></b> sekali (tombol Run di editor Apps Script, accept permissions).</li>'
    +     '<li style="margin-bottom:6px"><b>Deploy → New deployment → Web app</b>. Set: Execute as = Me, Who has access = Anyone. Klik Deploy.</li>'
    +     '<li style="margin-bottom:6px"><b>Copy URL Web App</b> (ends with <code>/exec</code>), paste ke kolom "Web App URL" di atas.</li>'
    +     '<li style="margin-bottom:6px"><b>Klik Simpan Konfigurasi</b>, lalu <b>Test Koneksi</b>. Harus muncul "✅ Terhubung!".</li>'
    +     '<li><b>Klik Full Backup</b> untuk kirim seluruh data existing Anda ke Spreadsheet.</li>'
    +   '</ol>'
    +   '<div style="margin-top:8px;padding:6px 8px;background:#fef3c7;border-left:3px solid #d97706;border-radius:4px;font-size:11px">'
    +     '<b>💡 Tips:</b> Kalau Test Koneksi gagal dengan "Unauthorized", periksa: (1) token sama persis di addon & Code.gs, (2) deploy pakai <code>/exec</code> bukan <code>/dev</code>, (3) "Who has access" = Anyone.'
    +   '</div>'
    + '</div></div>'

    // ===== SECTION 6: Hasil operasi terakhir =====
    + '<div class="card" id="rfGdResultCard" style="display:none"><h3>📋 Hasil operasi terakhir</h3>'
    + '<div id="rfGdResult" style="font-size:12px;line-height:1.5"></div></div>'

    + '<p class="hintbox" style="margin:10px 3px">💡 <b>Setup:</b> 1) Deploy Apps Script Web App (lihat panduan di atas). 2) Generate token via 🎲 Generate. 3) Tempel URL + token di Konfigurasi. 4) Klik Test Koneksi. 5) Klik Full Backup untuk kirim seluruh data existing. 6) Untuk multi-PC: di PC-2 pakai URL+Token sama, klik 📥 Pull.</p>';

  // ===== Bind events =====

  // Save config
  $('#rfGdSave').addEventListener('click', async () => {
    const url = ($('#rfGdUrl').value || '').trim();
    const token = ($('#rfGdToken').value || '').trim();
    await saveSettings({ gdriveWebAppUrl: url, gdriveAuthToken: token });
    toast('✓ Konfigurasi disimpan');
    renderGDrivePage(B);
  });

  // Master toggle
  $('#rfGdToggle').addEventListener('click', async () => {
    await saveSettings({ gdriveSyncEnabled: !enabled });
    toast(!enabled ? '✓ GDrive sync AKTIF' : 'GDrive sync dimatikan');
    renderGDrivePage(B);
  });

  // v3.11.7-fix (Issue #3): Copy URL ke clipboard
  $('#rfGdCopyUrl').addEventListener('click', async () => {
    const url = ($('#rfGdUrl').value || '').trim();
    if (!url) { toast('URL masih kosong. Isi dulu, lalu Copy.', false); return; }
    try {
      await navigator.clipboard.writeText(url);
      toast('📋 URL disalin. Paste di PC lain di field URL yang sama.');
    } catch (e) {
      toast('Gagal copy URL: ' + e.message, false);
    }
  });

  // v3.11.7-fix (Issue #3): Lock/Unlock token
  $('#rfGdLockToken').addEventListener('click', async () => {
    const newLockState = !tokenLocked;
    await saveSettings({ gdriveTokenLocked: newLockState });
    toast(newLockState ? '🔒 Token dikunci (read-only)' : '🔓 Token dibuka — bisa diedit. Jangan lupa kunci lagi setelah selesai.');
    renderGDrivePage(B);
  });

  // Toggles opsi
  $('#rfGdOnSave').addEventListener('click', async () => {
    await saveSettings({ gdriveSyncOnSave: s.gdriveSyncOnSave === false ? true : false });
    renderGDrivePage(B);
  });
  $('#rfGdShots').addEventListener('click', async () => {
    await saveSettings({ gdriveSyncScreenshots: s.gdriveSyncScreenshots === false ? true : false });
    renderGDrivePage(B);
  });
  $('#rfSyncAuto').addEventListener('click', async () => {
    await saveSettings({ syncAutoEnabled: !s.syncAutoEnabled });
    toast(!s.syncAutoEnabled ? '✓ Multi-PC auto-sync aktif (30s debounce)' : 'Multi-PC auto-sync dimatikan');
    renderGDrivePage(B);
  });
  $('#rfGdAutoBak').addEventListener('click', async () => {
    await saveSettings({ gdriveAutoBackupOnLocalBackup: s.gdriveAutoBackupOnLocalBackup === false ? true : false });
    renderGDrivePage(B);
  });
  $('#rfGdInterval').addEventListener('change', async (e) => {
    const v = Math.max(1, Math.min(60, parseInt(e.target.value, 10) || 5));
    await saveSettings({ gdriveSyncIntervalMinutes: v });
    toast('✓ Interval sync: ' + v + ' menit');
  });

  // Generate token — dengan konfirmasi kalau sudah ada
  $('#rfGdGenToken').addEventListener('click', async () => {
    const existing = $('#rfGdToken').value || '';
    if (existing && !confirm('Token sudah ada. Yakin generate token baru?\n\nToken lama: ' + existing.slice(0, 8) + '...\n\nToken baru akan MENGUBAH token di addon. Pastikan Anda juga update AUTH_TOKEN di Code.gs Apps Script dan deploy ulang.')) {
      return;
    }
    // Auto-unlock sebelum generate
    if (tokenLocked) {
      await saveSettings({ gdriveTokenLocked: false });
    }
    const arr = new Uint8Array(24);
    crypto.getRandomValues(arr);
    const token = 'rf-' + Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
    const tokenInput = $('#rfGdToken');
    if (tokenInput) {
      tokenInput.value = token;
      tokenInput.removeAttribute('readonly');
      tokenInput.type = 'text';
      toast('🎲 Token di-generate. Klik 📋 Copy lalu paste ke Code.gs!');
    }
  });
  // Copy token
  $('#rfGdCopyToken').addEventListener('click', async () => {
    const tokenInput = $('#rfGdToken');
    const token = tokenInput?.value || '';
    if (!token) { toast('Token masih kosong. Klik 🎲 Generate dulu.', false); return; }
    try {
      await navigator.clipboard.writeText(token);
      toast('📋 Token disalin. Paste ke AUTH_TOKEN di Code.gs.');
    } catch (e) {
      toast('Gagal copy: ' + e.message, false);
    }
  });

  // Test koneksi
  $('#rfGdTest').addEventListener('click', async () => {
    const btn = $('#rfGdTest');
    const orig = btn.textContent;
    btn.textContent = '⏳ Testing...';
    btn.disabled = true;
    try {
      const r = await browser.runtime.sendMessage({ type: 'GDRIVE_TEST' });
      _showGDriveResult(B, r?.ok, r?.ok
        ? '✅ Terhubung! Service: ' + (r.service || '?') + ' · waktu server: ' + (r.time || '?')
        : '❌ Gagal: ' + (r?.error || 'unknown'));
    } catch (e) {
      _showGDriveResult(B, false, '❌ Error: ' + e.message);
    } finally {
      btn.textContent = orig;
      btn.disabled = false;
    }
  });

  // GDrive Sync now (flush queue)
  $('#rfGdSyncNow').addEventListener('click', async () => {
    const btn = $('#rfGdSyncNow');
    const orig = btn.textContent;
    btn.textContent = '⏳ Syncing...';
    btn.disabled = true;
    try {
      const s2 = currentVault?.settings || {};
      if (s2.gdriveWebAppUrl && s2.gdriveAuthToken && !s2.gdriveSyncEnabled) {
        await saveSettings({ gdriveSyncEnabled: true });
        toast('💡 Sync otomatis diaktifkan (URL+token sudah diisi)');
      }
      const r = await browser.runtime.sendMessage({ type: 'GDRIVE_SYNC_NOW' });
      if (r?.ok) {
        const res = r.result || {};
        if ((res.synced || 0) === 0 && (res.remaining || 0) === 0) {
          _showGDriveResult(B, true,
            '✅ Sync selesai — queue kosong (tidak ada perubahan tertunda).<br>'
            + '<span style="font-size:11px;color:var(--muted)">Item yang sudah ada sebelum sync diaktifkan TIDAK otomatis terkirim. '
            + 'Klik <b>"Full Backup ke GDrive"</b> untuk kirim semua item existing sekaligus.</span>');
        } else {
          _showGDriveResult(B, true,
            '✅ Sync selesai: <b>' + (res.synced || 0) + ' item terkirim</b>, '
            + (res.failed || 0) + ' gagal, ' + (res.remaining || 0) + ' tersisa di queue.');
        }
      } else {
        let errMsg = '❌ ' + (r?.error || 'Gagal');
        if (r?.reason === 'disabled' || (r?.result?.reason === 'disabled')) {
          errMsg = '⚠️ Sync belum diaktifkan. Isi URL + Token dulu, lalu klik toggle "Aktifkan sync".';
        } else if (r?.error === 'NETWORK_ERROR') {
          errMsg = '❌ Network error. Cek: URL benar, Apps Script sudah di-deploy, koneksi internet aktif.';
        }
        _showGDriveResult(B, false, errMsg);
      }
      renderGDrivePage(B);
    } catch (e) {
      _showGDriveResult(B, false, '❌ Error: ' + e.message);
    } finally {
      btn.textContent = orig;
      btn.disabled = false;
    }
  });

  // GDrive Full backup
  $('#rfGdFullBackup').addEventListener('click', async () => {
    const btn = $('#rfGdFullBackup');
    const orig = btn.textContent;
    btn.textContent = '⏳ Mengupload...';
    btn.disabled = true;
    _showGDriveResult(B, true, '⏳ Memulai full backup... mohon tunggu, proses ini bisa 30-60 detik tergantung jumlah item.');
    try {
      const s2 = currentVault?.settings || {};
      if (s2.gdriveWebAppUrl && s2.gdriveAuthToken && !s2.gdriveSyncEnabled) {
        await saveSettings({ gdriveSyncEnabled: true });
        toast('💡 Sync otomatis diaktifkan (URL+token sudah diisi)');
      }
      const r = await browser.runtime.sendMessage({ type: 'GDRIVE_FULL_BACKUP' });
      if (r?.ok) {
        const st = r.stats || {};
        _showGDriveResult(B, true,
          '✅ Full backup sukses! Items: ' + (st.items || 0) + ', Bundles: ' + (st.bundles || 0) + ', '
          + 'Notes: ' + (st.notes || 0) + ', Toppings: ' + (st.toppings || 0) + ', '
          + 'Habits: ' + (st.habits || 0) + ', Settings: ' + (st.settings || 0));
      } else {
        let errMsg = '❌ ' + (r?.error || 'Gagal');
        if (r?.reason === 'disabled') {
          errMsg = '⚠️ Sync belum diaktifkan. Klik toggle "Aktifkan sync" di atas dulu, atau isi URL + Token.';
        } else if (r?.error === 'NO_URL' || r?.error === 'NO_TOKEN') {
          errMsg = '⚠️ URL Web App atau Token belum diisi. Scroll ke section "Konfigurasi" di atas.';
        } else if (r?.error === 'HTTP_401' || r?.error === 'UNAUTHORIZED') {
          errMsg = '❌ Token tidak cocok.<br><span style="font-size:11px">💡 Pastikan token di addon SAMA PERSIS dengan <code>AUTH_TOKEN</code> di Code.gs Apps Script Anda. Periksa juga apakah Code.gs sudah di-deploy ulang setelah token diubah.</span>';
        } else if (r?.error === 'HTTP_404') {
          errMsg = '❌ URL Web App tidak ditemukan (404).<br><span style="font-size:11px">💡 Periksa: (1) URL diakhiri <code>/exec</code> bukan <code>/dev</code>, (2) Apps Script sudah di-deploy sebagai Web app.</span>';
        } else if (r?.error === 'HTTP_500') {
          errMsg = '❌ Server error (500).<br><span style="font-size:11px">💡 Cek Execution log di Apps Script editor (View → Execution log). Kemungkinan: SPREADSHEET_ID salah, atau sheet belum dibuat (Run <code>setup</code> di Apps Script).</span>';
        } else if (r?.error === 'PAYLOAD_TOO_LARGE') {
          errMsg = '❌ Data terlalu besar.<br><span style="font-size:11px">' + esc(r?.detail || '') + '</span>';
        } else if (r?.error === 'TIMEOUT') {
          errMsg = '❌ Timeout (90 detik).<br><span style="font-size:11px">💡 Server Apps Script lambat. Coba lagi, atau kurangi jumlah item.</span>';
        } else if (r?.error === 'NETWORK_ERROR') {
          errMsg = '❌ Network error.<br><span style="font-size:11px">💡 Cek koneksi internet. Kalau persisten, mungkin URL Web App salah atau Apps Script belum di-deploy.</span>';
        } else if (r?.detail) {
          errMsg += '<br><span style="font-size:11px;color:var(--muted)">' + esc(r.detail) + '</span>';
        }
        _showGDriveResult(B, false, errMsg);
      }
      renderGDrivePage(B);
    } catch (e) {
      _showGDriveResult(B, false, '❌ Error: ' + e.message + '<br><span style="font-size:11px">Buka console (F12 → Console) untuk detail. Kemungkinan: background script crash, atau pesan tidak terkirim.</span>');
    } finally {
      btn.textContent = orig;
      btn.disabled = false;
    }
  });

  // Clear queue
  $('#rfGdClearQueue').addEventListener('click', async () => {
    if (!confirm('Yakin reset queue sync? Item yang belum terkirim akan dibuang.')) return;
    try {
      await browser.runtime.sendMessage({ type: 'GDRIVE_CLEAR_QUEUE' });
      toast('🗑 Queue direset');
      renderGDrivePage(B);
    } catch (e) { toast('Error: ' + e.message, false); }
  });

  // v3.11.7-fix (Issue #5): Multi-PC Sync actions
  $('#rfSyncFull')?.addEventListener('click', () => _doMultiPcSync(B, 'full'));
  $('#rfSyncPush')?.addEventListener('click', () => _doMultiPcSync(B, 'push'));
  $('#rfSyncPull')?.addEventListener('click', () => _doMultiPcSync(B, 'pull'));

  // v3.11.7-fix (Issue #5): Render profile list inline
  _renderSyncProfileListInline(B);
  $('#rfSyncProfAdd')?.addEventListener('click', () => _addSyncProfileInline(B));
  $('#rfSyncProfTest')?.addEventListener('click', () => _testSyncProfileInline(B));

  // v3.11.21: Supabase event bindings
  $('#rfSupaLogin')?.addEventListener('click', async () => {
    const email = ($('#rfSupaEmail')?.value || '').trim();
    const password = $('#rfSupaPass')?.value || '';
    if (!email || !password) { _showSupaResult(B, false, 'Email dan password wajib diisi'); return; }
    _showSupaResult(B, true, '⏳ Login ke Supabase...');
    try {
      const res = await browser.runtime.sendMessage({ type: 'SUPABASE_LOGIN', email, password });
      if (res?.ok) {
        _showSupaResult(B, true, '✅ Login berhasil! Email: ' + (res.user?.email || email));
        toast('✅ Login Supabase berhasil');
        renderGDrivePage(B);
      } else {
        _showSupaResult(B, false, '❌ Login gagal: ' + (res?.error || 'unknown'));
      }
    } catch (e) {
      _showSupaResult(B, false, '❌ Error: ' + e.message);
    }
  });

  $('#rfSupaSignup')?.addEventListener('click', async () => {
    const email = ($('#rfSupaEmail')?.value || '').trim();
    const password = $('#rfSupaPass')?.value || '';
    if (!email || !password) { _showSupaResult(B, false, 'Email dan password wajib diisi'); return; }
    if (!confirm('Buat akun Supabase baru?\n\nEmail: ' + email + '\n\nAkun akan dibuat di project RecallFox Supabase.')) return;
    _showSupaResult(B, true, '⏳ Mendaftarkan akun...');
    try {
      const res = await browser.runtime.sendMessage({ type: 'SUPABASE_SIGNUP', email, password });
      if (res?.ok) {
        if (res.needsConfirmation) {
          _showSupaResult(B, true, '📧 Akun dibuat! Cek email untuk konfirmasi, lalu login.');
        } else {
          _showSupaResult(B, true, '✅ Akun dibuat & login otomatis!');
          renderGDrivePage(B);
        }
      } else {
        _showSupaResult(B, false, '❌ Signup gagal: ' + (res?.error || 'unknown'));
      }
    } catch (e) {
      _showSupaResult(B, false, '❌ Error: ' + e.message);
    }
  });

  $('#rfSupaGmail')?.addEventListener('click', async () => {
    _showSupaResult(B, true, '⏳ Membuka Gmail login di tab baru...');
    try {
      const res = await browser.runtime.sendMessage({ type: 'SUPABASE_GMAIL' });
      _showSupaResult(B, true, '🔗 Tab baru dibuka. Login Gmail di sana, lalu kembali ke addon.');
    } catch (e) {
      _showSupaResult(B, false, '❌ Error: ' + e.message);
    }
  });

  $('#rfSupaLogout')?.addEventListener('click', async () => {
    if (!confirm('Logout dari Supabase? Data lokal tetap ada, tapi sync cloud berhenti.')) return;
    try {
      await browser.runtime.sendMessage({ type: 'SUPABASE_LOGOUT' });
      toast('🚪 Logout Supabase berhasil');
      renderGDrivePage(B);
    } catch (e) {
      toast('Error: ' + e.message, false);
    }
  });

  $('#rfSupaPush')?.addEventListener('click', () => _doSupabaseSync(B, 'push'));
  $('#rfSupaPull')?.addEventListener('click', () => _doSupabaseSync(B, 'pull'));
  $('#rfSupaFullSync')?.addEventListener('click', () => _doSupabaseSync(B, 'full'));

  $('#rfSupaTestConn')?.addEventListener('click', async () => {
    _showSupaResult(B, true, '⏳ Test koneksi Supabase...');
    try {
      const res = await browser.runtime.sendMessage({ type: 'SUPABASE_TEST_CONNECTION' });
      if (res?.ok) {
        _showSupaResult(B, true, '✅ Supabase accessible: ' + (res.url || ''));
      } else {
        _showSupaResult(B, false, '❌ Gagal: ' + (res?.error || 'unknown'));
      }
    } catch (e) {
      _showSupaResult(B, false, '❌ Error: ' + e.message);
    }
  });
}

// v3.11.21: Helper — jalankan Supabase sync (push/pull/full)
// v3.11.24: Tampilkan errors dengan detail supaya user tahu kenapa 0 item
async function _doSupabaseSync(B, action) {
  const btnMap = { full: 'rfSupaFullSync', push: 'rfSupaPush', pull: 'rfSupaPull' };
  const btn = $('#' + btnMap[action]);
  const orig = btn?.textContent || '';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Memproses...'; }
  _showSupaResult(B, true, '⏳ Supabase ' + action + ' sedang berjalan... mohon tunggu.');
  try {
    const msgType = action === 'full' ? 'SUPABASE_FULL_SYNC' : action === 'push' ? 'SUPABASE_PUSH' : 'SUPABASE_PULL';
    const res = await browser.runtime.sendMessage({ type: msgType });
    if (res?.ok) {
      let msg = '';
      if (action === 'push') {
        const s = res.stats || {};
        msg = '✓ Push berhasil · ' + (s.items || 0) + ' items, ' + (s.notes || 0) + ' catatan, ' + (s.screenshots || 0) + ' screenshot, ' + (s.settings || 0) + ' settings';
        // v3.11.24: Tampilkan detail kalau 0 item padahal vault tidak kosong
        if ((s.items || 0) === 0 && (s.notes || 0) === 0) {
          const debug = res.debug || {};
          msg += '\n\n⚠️ 0 item ter-push! Debug info:';
          msg += '\n· Vault items: ' + (debug.vaultItems ?? 'unknown');
          msg += '\n· Bundles: ' + (debug.bundles ?? 'unknown');
          msg += '\n· Notes: ' + (debug.notes ?? 'unknown');
          msg += '\n· Settings: ' + (debug.settingsKeys ?? 'unknown');
          msg += '\n· User ID: ' + (debug.userId || 'null');
          msg += '\n· Duration: ' + (debug.duration ?? 'unknown') + 'ms';
          msg += '\n\nKemungkinan: (1) belum login Supabase, (2) RLS policy reject insert, (3) table belum dibuat di Supabase. Cek console background (about:debugging → Inspect) untuk log detail.';
        }
        if (s.errors && s.errors.length > 0) {
          msg += '\n\n❌ ' + s.errors.length + ' error:';
          // Tampilkan 5 error pertama
          const shown = s.errors.slice(0, 5);
          for (const e of shown) {
            msg += '\n· ' + (e.type || e.id || e.key || '?') + ': ' + e.error;
          }
          if (s.errors.length > 5) msg += '\n· ... dan ' + (s.errors.length - 5) + ' lainnya';
        }
      } else if (action === 'pull') {
        const s = res.stats || {};
        msg = '✓ Pull berhasil · +' + (s.itemsAdded || 0) + ' items baru, ~' + (s.itemsUpdated || 0) + ' updated, +' + (s.notesAdded || 0) + ' catatan baru';
      } else {
        const p = res.push?.stats || {}, l = res.pull?.stats || {};
        msg = '✓ Sync lengkap · push: ' + (p.items || 0) + ' items, pull: +' + (l.itemsAdded || 0) + ' baru';
      }
      _showSupaResult(B, true, msg);
      toast(action === 'push' ? '✓ Push: ' + (res.stats?.items || 0) + ' items' : msg);
      if (action !== 'push') {
        // Refresh vault kalau ada pull
        await refreshVault();
      }
    } else {
      let msg = '⚠ Gagal: ' + (res?.error || 'unknown');
      // v3.11.24: Tambah hint untuk error umum
      if (res?.error === 'not_logged_in') {
        msg += '\n\n💡 Anda belum login Supabase. Klik "Login Email/Password" di section Supabase di atas.';
      } else if (res?.error === 'no_user_id') {
        msg += '\n\n💡 Session tidak valid. Logout lalu login ulang.';
      } else if (res?.error?.includes('http_40')) {
        msg += '\n\n💡 HTTP error — kemungkinan RLS policy atau table belum dibuat. Jalankan supabase-schema.sql di Supabase SQL Editor.';
      }
      _showSupaResult(B, false, msg);
      toast(msg, false);
    }
  } catch (e) {
    _showSupaResult(B, false, '⚠ Error: ' + e.message);
    toast('⚠ Error: ' + e.message, false);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = orig; }
  }
}

function _showSupaResult(B, ok, msg) {
  const el = $('#rfSupaResult');
  if (!el) return;
  el.style.display = '';
  el.innerHTML = (ok ? '✓ ' : '✕ ') + msg;
  el.style.color = ok ? 'var(--green)' : 'var(--red)';
}

// v3.11.7-fix (Issue #5): Helper — jalankan aksi Multi-PC Sync (push/pull/full)
async function _doMultiPcSync(B, action) {
  const btnMap = { full: 'rfSyncFull', push: 'rfSyncPush', pull: 'rfSyncPull' };
  const btn = $('#' + btnMap[action]);
  const orig = btn?.textContent || '';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Memproses...'; }
  _showGDriveResult(B, true, '⏳ Multi-PC ' + action + ' sedang berjalan... mohon tunggu.');
  try {
    const msgType = action === 'full' ? 'SYNC_FULL' : action === 'push' ? 'SYNC_PUSH' : 'SYNC_PULL';
    const res = await browser.runtime.sendMessage({ type: msgType });
    if (res?.ok) {
      let msg = '';
      if (action === 'push') {
        msg = '✓ Push berhasil · ' + (res.itemsCount || 0) + ' items + ' + (res.notesCount || 0) + ' catatan';
      } else if (action === 'pull') {
        msg = '✓ Pull berhasil · +' + (res.itemsAdded || 0) + ' items baru, ~' + (res.itemsUpdated || 0) + ' updated, +' + (res.notesAdded || 0) + ' catatan baru';
      } else {
        msg = '✓ Sync lengkap · push: ' + (res.itemsCount || 0) + ' items, pull: +' + (res.itemsAdded || 0) + ' baru';
      }
      _showGDriveResult(B, true, msg);
      toast(msg);
    } else {
      const msg = '⚠ Gagal: ' + (res?.error || 'unknown') + (res?.detail ? ' · ' + res.detail : '');
      _showGDriveResult(B, false, msg);
      toast(msg, false);
    }
  } catch (e) {
    _showGDriveResult(B, false, '⚠ Error: ' + e.message);
    toast('⚠ Error: ' + e.message, false);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = orig; }
  }
}

// v3.11.7-fix (Issue #5): Render profile list inline (bukan modal)
async function _renderSyncProfileListInline(B) {
  const listEl = $('#rfSyncProfileList');
  if (!listEl) return;
  let res;
  try {
    res = await browser.runtime.sendMessage({ type: 'SYNC_GET_PROFILES' });
  } catch (e) {
    listEl.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:6px">Gagal memuat profiles: ' + e.message + '</div>';
    return;
  }
  if (!res?.ok) {
    listEl.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:6px">Belum ada profile. Tambah di form bawah.</div>';
    return;
  }
  const data = res.data;
  if (!data.profiles || data.profiles.length === 0) {
    listEl.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:6px">📋 Belum ada profile. Tambah di form bawah.</div>';
    return;
  }
  listEl.innerHTML = data.profiles.map(p => {
    const isActive = p.id === data.activeProfileId;
    const lastSync = p.lastSyncAt ? new Date(p.lastSyncAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'belum';
    return '<div style="display:flex;align-items:center;gap:8px;padding:8px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;background:' + (isActive ? 'var(--primary-soft)' : 'var(--surface)') + '">'
      + '<div style="font-size:14px">' + (isActive ? '🟢' : '⚪') + '</div>'
      + '<div style="flex:1;min-width:0">'
      +   '<div style="font-size:12px;font-weight:600">' + esc(p.name) + (isActive ? ' <span style="font-size:9px;background:var(--primary);color:#fff;padding:1px 5px;border-radius:999px;font-weight:700">AKTIF</span>' : '') + '</div>'
      +   '<div style="font-size:10px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Last: ' + lastSync + ' · ' + (p.lastSyncDirection || '-') + ' · ' + esc((p.url || '').slice(0, 40)) + '…</div>'
      + '</div>'
      + '<div style="display:flex;gap:4px">'
      +   (isActive ? '' : '<button class="btn btn-g" data-act="activate" data-id="' + p.id + '" style="padding:4px 8px;font-size:10px">Aktifkan</button>')
      +   '<button class="btn btn-g" data-act="delete" data-id="' + p.id + '" style="padding:4px 8px;font-size:10px;background:#fee2e2;color:#991b1b">🗑</button>'
      + '</div></div>';
  }).join('');
  listEl.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const act = btn.dataset.act;
      const id = btn.dataset.id;
      if (act === 'activate') {
        await browser.runtime.sendMessage({ type: 'SYNC_SET_ACTIVE', id });
        toast('✓ Profile diaktifkan');
        renderGDrivePage(B);
      } else if (act === 'delete') {
        if (!confirm('Hapus profile ini?')) return;
        await browser.runtime.sendMessage({ type: 'SYNC_DELETE_PROFILE', id });
        toast('Profile dihapus');
        renderGDrivePage(B);
      }
    });
  });
}

// v3.11.7-fix (Issue #5): Add profile inline
async function _addSyncProfileInline(B) {
  const name = ($('#rfSyncProfName').value || '').trim();
  const url = ($('#rfSyncProfUrl').value || '').trim();
  const token = ($('#rfSyncProfToken').value || '').trim();
  const resultEl = $('#rfSyncProfResult');
  if (!name || !url || !token) {
    if (resultEl) { resultEl.style.display = ''; resultEl.textContent = '⚠ Semua field wajib diisi'; resultEl.style.color = 'var(--red)'; }
    return;
  }
  const res = await browser.runtime.sendMessage({ type: 'SYNC_ADD_PROFILE', profile: { name, url, token } });
  if (res?.ok) {
    $('#rfSyncProfName').value = '';
    $('#rfSyncProfUrl').value = '';
    $('#rfSyncProfToken').value = '';
    if (resultEl) { resultEl.style.display = ''; resultEl.textContent = '✓ Profile ditambahkan & diaktifkan'; resultEl.style.color = 'var(--green)'; }
    toast('✓ Profile "' + name + '" ditambahkan');
    renderGDrivePage(B);
  } else {
    if (resultEl) { resultEl.style.display = ''; resultEl.textContent = '⚠ Gagal: ' + (res?.error || 'unknown'); resultEl.style.color = 'var(--red)'; }
  }
}

// v3.11.7-fix (Issue #5): Test profile inline
async function _testSyncProfileInline(B) {
  const url = ($('#rfSyncProfUrl').value || '').trim();
  const token = ($('#rfSyncProfToken').value || '').trim();
  const resultEl = $('#rfSyncProfResult');
  if (!url || !token) {
    if (resultEl) { resultEl.style.display = ''; resultEl.textContent = '⚠ Isi URL dan token dulu'; resultEl.style.color = 'var(--red)'; }
    return;
  }
  const btn = $('#rfSyncProfTest');
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = '🔌 Menguji...';
  try {
    const res = await browser.runtime.sendMessage({ type: 'SYNC_TEST_PROFILE', profile: { url, token } });
    if (res?.ok) {
      if (resultEl) { resultEl.style.display = ''; resultEl.textContent = '✓ Koneksi OK · ' + (res.spreadsheetUrl || 'spreadsheet accessible'); resultEl.style.color = 'var(--green)'; }
      toast('✓ Koneksi OK');
    } else {
      if (resultEl) { resultEl.style.display = ''; resultEl.textContent = '⚠ ' + (res?.error || 'gagal'); resultEl.style.color = 'var(--red)'; }
    }
  } catch (e) {
    if (resultEl) { resultEl.style.display = ''; resultEl.textContent = '⚠ ' + e.message; resultEl.style.color = 'var(--red)'; }
  } finally {
    btn.disabled = false; btn.textContent = orig;
  }
}

function _showGDriveResult(B, ok, msg) {
  const card = $('#rfGdResultCard');
  const el = $('#rfGdResult');
  if (!card || !el) return;
  card.style.display = '';
  el.innerHTML = (ok ? '✓ ' : '✕ ') + msg;
  el.style.color = ok ? 'var(--green)' : 'var(--red)';
}

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
  // v3.8.1 (Issue #6): Cek apakah GDrive sync aktif — jika ya, tampilkan shortcut di backup page
  const gdriveOn = !!(s.gdriveSyncEnabled && s.gdriveWebAppUrl && s.gdriveAuthToken);

  B.innerHTML =
    '<div class="card" style="background:linear-gradient(135deg,#1e3a8a,#1e40af);color:#eff6ff;border:none">'
    + '<div style="font-size:11px;opacity:.85">Status vault</div>'
    + '<div style="font-size:24px;font-weight:750;margin:4px 0">' + itemCount + ' item · ' + bundleCount + ' bundle</div>'
    + '<div style="font-size:11px;opacity:.85">Backup terakhir: ' + esc(lastBackupInfo) + ' · ' + esc(lastBackupSize) + '</div>'
    + '</div>'

    // v3.8.1 (Issue #7): SATU card "Buat Backup" — gabung Export JSON + Backup Sekarang (sebelumnya 2 tombol mubazir)
    + '<div class="card"><h3>💾 Buat Backup</h3>'
    + '<div class="hintbox" style="margin-bottom:10px">Backup lokal otomatis tersimpan ke <code>Downloads/RecallFox/</code>. File <b>.rfvault</b> terenkripsi AES-GCM (butuh passphrase untuk restore).</div>'
    + '<div class="btn-row" style="flex-direction:column;gap:6px">'
    +   '<button class="btn btn-p" id="rfBackupNow" style="width:100%">⚡ Backup sekarang (plain JSON)</button>'
    +   '<button class="btn btn-g" id="rfExpEnc" style="width:100%">🔒 Export .rfvault terenkripsi</button>'
    + (gdriveOn
        ?   '<button class="btn btn-g" id="rfBackupGDrive" style="width:100%;background:linear-gradient(135deg,#1e3a8a,#1e40af);color:#fff">☁️ Full Backup ke Google Drive</button>'
        :   '<button class="btn btn-g" id="rfGoGDrive" style="width:100%;opacity:0.7">☁️ Setup GDrive Sync dulu →</button>')
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
    + '</div></div>'

    + '<div class="card"><h3>🔧 Pengaturan lanjutan</h3>'
    + '<div class="hintbox" style="margin-bottom:10px">Atur jadwal auto-backup, lokasi folder, enkripsi default, dll di halaman pengaturan.</div>'
    + '<button class="btn btn-g" id="rfGoSettings" style="width:100%">Buka pengaturan RecallFox</button></div>'

    + '<p class="hintbox" style="margin:10px 3px">💡 <b>Tip:</b> Backup .rfvault terenkripsi aman untuk disimpan di cloud (Google Drive, Dropbox). Passphrase tidak bisa dikembalikan jika lupa — simpan baik-baik.</p>';

  // === Bind events ===
  // v3.8.1 (Issue #7): Hapus tombol "Export .json (plain)" yang redundant dengan "Backup sekarang"
  // — keduanya sama-sama plain JSON, beda folder tujuan saja. Sekarang hanya "Backup sekarang"
  // yang pakai folder RecallFox/ + tombol "Export .rfvault terenkripsi" untuk file terenkripsi.

  // Backup now (plain JSON ke Downloads/RecallFox/)
  $('#rfBackupNow').addEventListener('click', async () => {
    try {
      toast('⏳ Backup berjalan...');
      const res = await browser.runtime.sendMessage({ type: 'MANUAL_BACKUP_NOW' });
      if (res?.ok) {
        toast('✓ Backup tersimpan ke Downloads/RecallFox/'
              + (gdriveOn && s.gdriveAutoBackupOnLocalBackup ? ' + terkirim ke GDrive' : ''));
        renderBackupPage(B);
      } else {
        toast('⚠ Gagal: ' + (res?.error || ''), false);
      }
    } catch (e) {
      toast('⚠ Gagal: ' + e.message, false);
    }
  });

  // Export terenkripsi (.rfvault)
  $('#rfExpEnc').addEventListener('click', async () => {
    try {
      const passphrase = prompt('Masukkan passphrase untuk enkripsi backup (min. 8 karakter):');
      if (!passphrase) return;
      if (passphrase.length < 8) {
        if (!confirm('Passphrase kurang dari 8 karakter. Lanjut? (Tidak disarankan)')) return;
      }
      toast('🔒 Membuat backup terenkripsi...');
      const res = await browser.runtime.sendMessage({ type: 'EXPORT_BACKUP', encrypted: true, passphrase });
      if (res?.ok) {
        toast('✓ Backup .rfvault tersimpan ke Downloads');
      } else {
        toast('⚠ Gagal: ' + (res?.error || 'unknown'), false);
      }
    } catch (e) {
      toast('⚠ Gagal export: ' + e.message, false);
    }
  });

  // v3.8.1 (Issue #6): Tombol Full Backup ke GDrive (jika GDrive aktif)
  if (gdriveOn) {
    $('#rfBackupGDrive')?.addEventListener('click', async () => {
      try {
        toast('⏳ Mengirim full backup ke Google Drive...');
        const res = await browser.runtime.sendMessage({ type: 'GDRIVE_FULL_BACKUP' });
        if (res?.ok) {
          const s = res.stats || {};
          toast('✓ GDrive backup sukses · ' + (s.items || 0) + ' item, ' + (s.notes || 0) + ' catatan, ' + (s.settings || 0) + ' settings');
        } else {
          toast('⚠ Gagal GDrive: ' + (res?.error || ''), false);
        }
      } catch (e) {
        toast('⚠ Error: ' + e.message, false);
      }
    });
  } else {
    // Tombol "Setup GDrive Sync dulu →" pindah ke tool gdrive
    $('#rfGoGDrive')?.addEventListener('click', () => toolPage('gdrive'));
  }

  // Import file
  $('#rfImportFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const resultEl = $('#rfImportResult');
    resultEl.innerHTML = '⏳ Mengimpor...';
    try {
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

  // Buka settings
  // v3.20.22: Pakai openSettings() helper dengan fallback (iframe-safe)
  $('#rfGoSettings').addEventListener('click', () => openSettings());
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
  // v3.20.22: Pakai openSettings() helper dengan fallback (iframe-safe)
  $('#askAiSetup').addEventListener('click', () => openSettings());
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
      // v3.20.22: Pakai openSettings() helper dengan fallback (iframe-safe)
      openSettings();
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
      // v3.20.22: Pakai openSettings() helper dengan fallback (iframe-safe)
      openSettings();
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
      // v3.7.2 (Issue 6): Toggle individu — Mode Anak (filter, no redirect)
      // v3.10.0 (Issue 2): Ubah dari redirect youtubekids.com → filter di youtube.com biasa
      +     '<div class="krow" style="padding:10px 0;border-top:1px solid var(--border)">'
      +       '<div><b>👶 Mode Anak (Filter Konten)</b><div style="font-size:11px;color:var(--muted);margin-top:2px">Tetap di youtube.com, tapi sembunyikan video non-ramah-anak. Hanya video edukasi/kartun/lagu anak yang tampil. Shorts juga di-hide.</div></div>'
      +       '<button class="ks-toggle' + (s.contentGuardKidModeFilter === true ? ' on' : '') + '" id="ksKidsOnlyToggle" aria-label="Toggle Mode Anak"><i></i></button>'
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
      // v3.10.0 (Issue 2): Mode Anak pakai contentGuardKidModeFilter (no redirect)
      const newOn = !(s.contentGuardKidModeFilter === true);
      const r = await browser.runtime.sendMessage({ type: 'TOGGLE_KID_MODE', enabled: newOn });
      const finalOn = r?.enabled ?? newOn;
      await refreshVault();
      renderKontrolSitusPage(B);
      toast(finalOn ? '👶 Mode Anak AKTIF — feed YouTube hanya konten ramah anak' : 'Mode Anak dimatikan');
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
  // v3.11.15: Update visibility tombol batch setelah refresh vault — sebelumnya
  // tidak dipanggil, sehingga tombol batch bisa inconsistent setelah hapus/edit item.
  try { updateBatchModeBtnVisibility(); } catch (e) {}
}
async function init() {
  try { await initTheme(); } catch (e) { console.warn('initTheme failed:', e); }
  try { await refreshVault(); } catch (e) { console.warn('refreshVault failed:', e); }
  // v3.13.0 (Issue #3): Load notes prefs (sort/view mode) dari vault.settings
  try { loadNotesPrefs(); } catch (e) { console.warn('loadNotesPrefs failed:', e); }
  try { await detectAiContext(); } catch (e) {}

  // Sticky bars
  await Promise.allSettled([updatePrayerStrip(), updateHabitsStrip(), updateFastStrip()]);
  setInterval(() => Promise.allSettled([updatePrayerStrip(), updateHabitsStrip(), updateFastStrip()]), 60000);

  // Render tools + notes (lazy)
  renderTools();
  await renderNotes();

  bindEvents();
  renderVault();
  // v3.9.0 (Issue 5): Sidebar auto-close after idle (only in sidebar mode)
  try { initSidebarAutoClose(); } catch (e) { console.warn('initSidebarAutoClose failed:', e); }

  // Width responsive for sidebar
  // v3.11.1 (Issue 2 fix): Tambah w-xs (≤280px) dan w-xxs (≤220px) untuk collapse lebih sempit.
  // Sebelumnya cuma w-sm (≤310px) — tidak cukup untuk sidebar super narrow.
  if (document.body.classList.contains('rf-sidebar-body')) {
    const setW = () => {
      const w = window.innerWidth;
      const popup = $('#popup');
      if (!popup) return;
      popup.classList.toggle('w-sm', w <= 360);
      popup.classList.toggle('w-xs', w <= 280);
      popup.classList.toggle('w-xxs', w <= 220);
    };
    setW();
    window.addEventListener('resize', setW);
  }

  // v3.11.1: Focus search — di-skip karena search bar sudah dihapus.
  // Quick-actions bar tidak perlu auto-focus (user pilih tombol yang mau).
}

function bindEvents() {
  // v3.20.7: Jika di iframe (popout), kirim activity ke parent untuk reset idle timer
  if (window !== window.top) {
    const activityEvents = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart', 'input'];
    let lastActivitySent = 0;
    activityEvents.forEach(ev => {
      document.addEventListener(ev, () => {
        const now = Date.now();
        // Throttle — kirim max 1x per 2 detik
        if (now - lastActivitySent > 2000) {
          lastActivitySent = now;
          window.parent.postMessage({ type: 'RF_ACTIVITY' }, '*');
        }
      }, { passive: true });
    });
  }
  // Theme + header
  // v3.7.1-FIX: Set ikon untuk tombol header (sebelumnya kosong/tidak terlihat)
  $('#aiBtn').innerHTML = ICONS.spark;
  $('#settingsBtn').innerHTML = ICONS.gear;
  $('#themeBtn').addEventListener('click', toggleTheme);
  // v3.20.22: Pakai openSettings() helper dengan fallback (iframe-safe)
  $('#settingsBtn').addEventListener('click', () => openSettings());
  $('#aiBtn').addEventListener('click', aiToolsSheet);
  // v3.20.7: Popout sidebar toggle — pakai postMessage ke parent (bukan tabs.sendMessage)
  // Root cause: browser.tabs.sendMessage dari iframe gagal di Firefox (cross-origin context).
  // Fix: window.parent.postMessage({ type: 'RF_TOGGLE_POPOUT' }) → sidebar-cs.js listen → toggle()
  const inPageBtn = $('#sidebarInPageBtn');
  if (inPageBtn) {
    inPageBtn.addEventListener('click', () => {
      // Cek apakah kita di iframe (popout) atau native sidebar/popup
      if (window !== window.top) {
        // Di iframe popout — kirim postMessage ke parent
        window.parent.postMessage({ type: 'RF_TOGGLE_POPOUT' }, '*');
      } else {
        // Di native sidebar/popup — kirim message ke content script di tab aktif
        browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
          const tab = tabs[0];
          if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) {
            toast('⚠️ Popout sidebar hanya bisa di halaman http/https');
            return;
          }
          browser.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR_IN_PAGE' }).catch(() => {
            // Fallback: inject content script
            browser.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content/sidebar-cs.js']
            }).then(() => {
              setTimeout(() => {
                browser.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR_IN_PAGE' }).catch(() => {
                  toast('⚠️ Tidak bisa buka popout di halaman ini');
                });
              }, 300);
            }).catch(() => {
              toast('⚠️ Tidak bisa buka popout di halaman ini');
            });
          });
        });
      }
    });
  }
  // v3.14.0: RecallTape — tombol 🧾 di header → toggle popover di tab aktif
  const tapeBtn = $('#tapeBtn');
  if (tapeBtn) tapeBtn.addEventListener('click', openTapePopover);
  $('#scrim').addEventListener('click', closeSheet);
  $('#pageBack').addEventListener('click', closePage);

  // Status strip
  $('#stripBar').addEventListener('click', () => {
    $('#strip').classList.toggle('open');
    // v3.11.36: Recompute .page.top kalau page sedang terbuka, supaya strip-detail
    // (grid 6 waktu shalat) tidak tertutup page saat user expand strip.
    const page = $('#page');
    if (page && page.classList.contains('in')) {
      try {
        const strip = document.querySelector('.strip');
        const popup = document.getElementById('popup');
        if (strip && popup) {
          const stripRect = strip.getBoundingClientRect();
          const popupRect = popup.getBoundingClientRect();
          const offset = Math.round(stripRect.bottom - popupRect.top);
          page.style.top = (offset > 0 && offset < 400) ? offset + 'px' : '95px';
        }
      } catch (e) {}
    }
  });
  $('#habitQuran').addEventListener('click', async () => {
    const s = currentVault?.settings || {};
    if (s.quranEnabled !== false) { await logQuranPages(1, s); await refreshVault(); await updateHabitsStrip(); toast('📖 Ngaji +1 hal'); }
  });
  $('#habitGym').addEventListener('click', async () => {
    const s = currentVault?.settings || {};
    if (s.exerciseEnabled !== false) { await logExerciseDone(s); await refreshVault(); await updateHabitsStrip(); toast('🏃 Olahraga tercatat'); }
  });

  // v3.12.3 (Issue #2): Hero tiles — customizable. Render dinamis + event delegation.
  // v3.12.5 fix: Hapus handler mousedown ganda (v3.12.4) yang menyebabkan removeTile
  //   dipanggil 2x per klik (1x dari mousedown, 1x dari click fallback) → toast dobel.
  //   Penyebab: e.preventDefault() di mousedown TIDAK men-stop event click berikutnya.
  //   Solusi: kembali ke single click handler dengan urutan cek yang benar:
  //   1. [data-remove] (× tombol) — cek PERTAMA supaya klik × tidak trigger tile action
  //   2. [data-action="add-tile"] (+ tombol)
  //   3. [data-tile] (tile biasa)
  renderTiles();
  const tilesContainer = $('#tilesContainer');
  if (tilesContainer) {
    tilesContainer.addEventListener('click', (e) => {
      // Cek tombol × remove — PERTAMA supaya tidak trigger tile action
      const removeBtn = e.target.closest('[data-remove]');
      if (removeBtn) {
        e.preventDefault();
        e.stopPropagation();
        removeTile(removeBtn.dataset.remove);
        return;
      }
      // Cek tombol + add
      const addBtn = e.target.closest('[data-action="add-tile"]');
      if (addBtn) {
        openTilePicker();
        return;
      }
      // Tile click — dispatch by data-tile
      const tile = e.target.closest('[data-tile]');
      if (!tile) return;
      const id = tile.dataset.tile;
      const def = TILE_DEFS.find(t => t.id === id);
      if (!def) return;
      // Dispatch ke function yang sesuai
      if (def.type === 'qa') {
        if (def.action === 'savePromptSheet') savePromptSheet();
        else if (def.action === 'saveKonteksSheet') saveKonteksSheet();
        else if (def.action === 'saveLinkSheet') saveLinkSheet();
        else if (def.action === 'saveBundleSheet') saveBundleSheet();
        else if (def.action === 'snapshotFlow') snapshotFlow();
        else if (def.action === 'doShot') doShot();
      } else if (def.type === 'tool') {
        toolPage(def.arg);
      }
    });
  }

  // Add item button
  $('#addItemBtn').addEventListener('click', addItemMenu);
  $('#noteAddBtn').addEventListener('click', newNote);
  // v3.20.36-dev: File upload via menu "+ Baru" — tombol header dihapus, input hidden tetap.
  // docFileInput di-trigger dari addItemMenu() opsi "📄 Upload File teks".
  // v3.20.41: Tambah console.log untuk debugging.
  const _docFileInput = $('#docFileInput');
  if (_docFileInput) {
    console.log('[RecallFox] docFileInput found, wiring change handler. Element:', _docFileInput);
    _docFileInput.addEventListener('change', async (e) => {
      console.log('[RecallFox] docFileInput change event fired. Files:', e.target.files?.length);
      if (e.target.files && e.target.files.length > 0) {
        await handleDocFileUpload(e.target.files);
      }
    });
  }
  // v3.18.0: Tombol Buat Grup + Auto-Grup AI — bind event listeners
  const addGroupBtnEl = $('#addGroupBtn');
  const aiGroupBtnEl = $('#aiGroupBtn');
  if (addGroupBtnEl) addGroupBtnEl.addEventListener('click', handleAddGroup);
  if (aiGroupBtnEl) aiGroupBtnEl.addEventListener('click', handleAiAutoGroup);
  // v3.20.32: Magic Command button — ketik perintah natural language
  const magicCommandBtnEl = $('#magicCommandBtn');
  if (magicCommandBtnEl) magicCommandBtnEl.addEventListener('click', handleMagicCommand);
  // v3.19.0: Sort dropdown + Collapse All + Tag Filter
  const vaultSortSelect = $('#vaultSortSelect');
  if (vaultSortSelect) {
    vaultSortSelect.value = vaultSortMode;
    vaultSortSelect.addEventListener('change', (e) => {
      vaultSortMode = e.target.value;
      localStorage.setItem('rf_vault_sort', vaultSortMode);
      renderVault();
    });
  }
  const collapseAllBtn = $('#collapseAllBtn');
  if (collapseAllBtn) collapseAllBtn.addEventListener('click', toggleCollapseAll);
  const tagFilterBtn = $('#tagFilterBtn');
  if (tagFilterBtn) tagFilterBtn.addEventListener('click', toggleTagFilter);
  // v3.11.11 (Issue #1): Batch mode untuk screenshot di vault
  // v3.11.14: Generalisasi — batch mode untuk SEMUA tipe (prompt, link, bundle, archive, dll)
  const vaultBatchModeBtnEl = $('#batchModeBtn');
  if (vaultBatchModeBtnEl) vaultBatchModeBtnEl.addEventListener('click', toggleVaultBatchMode);
  const vaultBatchCopyBtn = $('#vaultBatchCopy');
  if (vaultBatchCopyBtn) vaultBatchCopyBtn.addEventListener('click', () => vaultBatchCopyAction(true));
  const vaultBatchCopyImgBtn = $('#vaultBatchCopyImg');
  if (vaultBatchCopyImgBtn) vaultBatchCopyImgBtn.addEventListener('click', () => vaultBatchCopyAction(false));
  // v3.14.9: Batch download semua gambar terpilih sebagai file terpisah
  const vaultBatchDownloadBtn = $('#vaultBatchDownload');
  if (vaultBatchDownloadBtn) vaultBatchDownloadBtn.addEventListener('click', vaultBatchDownloadAction);
  // v3.14.9: Batch copy URL gambar (untuk AI sites yang tidak support paste gambar)
  const vaultBatchCopyUrlsBtn = $('#vaultBatchCopyUrls');
  if (vaultBatchCopyUrlsBtn) vaultBatchCopyUrlsBtn.addEventListener('click', vaultBatchCopyUrlsAction);
  // v3.11.36: Batch copy teks metadata saja (tanpa gambar)
  const vaultBatchCopyMetaBtn = $('#vaultBatchCopyMeta');
  if (vaultBatchCopyMetaBtn) vaultBatchCopyMetaBtn.addEventListener('click', vaultBatchCopyMetaAction);
  // v3.11.14: Tombol batch baru untuk tipe lain
  const vaultBatchCopyTextBtn = $('#vaultBatchCopyText');
  if (vaultBatchCopyTextBtn) vaultBatchCopyTextBtn.addEventListener('click', vaultBatchCopyTextAction);
  const vaultBatchCopyBundleBtn = $('#vaultBatchCopyBundle');
  if (vaultBatchCopyBundleBtn) vaultBatchCopyBundleBtn.addEventListener('click', vaultBatchCopyBundleAction);
  const vaultBatchUnarchiveBtn = $('#vaultBatchUnarchive');
  if (vaultBatchUnarchiveBtn) vaultBatchUnarchiveBtn.addEventListener('click', vaultBatchUnarchiveAction);
  // v3.20.43: Batch mass actions — Move to Folder, Archive, Add to Bundle
  const vaultBatchMoveFolderBtn = $('#vaultBatchMoveFolder');
  if (vaultBatchMoveFolderBtn) vaultBatchMoveFolderBtn.addEventListener('click', vaultBatchMoveFolderAction);
  const vaultBatchArchiveBtn = $('#vaultBatchArchive');
  if (vaultBatchArchiveBtn) vaultBatchArchiveBtn.addEventListener('click', vaultBatchArchiveAction);
  const vaultBatchBundleBtn = $('#vaultBatchBundle');
  if (vaultBatchBundleBtn) vaultBatchBundleBtn.addEventListener('click', vaultBatchBundleAction);
  // v3.11.13 (Sesi 12): Batch delete button
  const vaultBatchDeleteBtn = $('#vaultBatchDelete');
  if (vaultBatchDeleteBtn) vaultBatchDeleteBtn.addEventListener('click', vaultBatchDeleteAction);
  const vaultBatchCancelBtn = $('#vaultBatchCancel');
  if (vaultBatchCancelBtn) vaultBatchCancelBtn.addEventListener('click', exitVaultBatchMode);
  // v3.9.0 (Issue 7): Batch mode untuk notes
  $('#noteBatchBtn').addEventListener('click', toggleNotesBatchMode);
  const batchArchiveBtn = $('#notesBatchArchive');
  const batchDeleteBtn = $('#notesBatchDelete');
  const batchCancelBtn = $('#notesBatchCancel');
  if (batchArchiveBtn) batchArchiveBtn.addEventListener('click', () => notesBatchAction('archive'));
  if (batchDeleteBtn) batchDeleteBtn.addEventListener('click', () => notesBatchAction('delete'));
  if (batchCancelBtn) batchCancelBtn.addEventListener('click', exitNotesBatchMode);

  // Tab bar
  $('#tabHome').addEventListener('click', () => setView('home'));
  $('#tabNotes').addEventListener('click', () => setView('notes'));
  $('#tabTools').addEventListener('click', () => setView('tools'));

  // Search / command bar
  // v3.11.1: Search bar sudah dihapus dari sidebar (ganti quick-actions).
  // Pertahankan binding untuk popup mode (yang masih punya search bar).
  // v3.10.2 (Issue 4 fix): Update tombol clear (X) visibility saat user mengetik
  const searchInput = $('#search');
  const searchClearBtn = $('#searchClear');
  function updateClearBtnVisibility() {
    if (!searchClearBtn) return;
    searchClearBtn.style.display = (searchInput && searchInput.value && searchInput.value.length > 0) ? 'flex' : 'none';
  }
  if (searchInput) {
    searchInput.addEventListener('input', e => {
      currentQuery = e.target.value;
      updateClearBtnVisibility();
      renderSearch();
    });
    searchInput.addEventListener('keydown', e => {
      // v3.13.2 (Issue #2 dari Google Doc): Enter trigger search eksplisit.
      // User feedback: "harusnya pencarian bisa eksekusi dengan menekan Tombol
      // dengan ikon panah masuk ke bawah/kanan (→|) tersebut dinamakan tombol
      // Aksi (Action Key) atau sering juga disebut tombol Next / Seterusnya / Lanjut."
      // type=search + enterkeyhint="search" sudah set keyboard HP show tombol
      // "Search/Go" (ikon panah/kaca pembesar). Enter handler ini trigger
      // renderSearch() eksplisit + scroll ke hasil pertama.
      if (e.key === 'Enter') {
        e.preventDefault();
        renderSearch();
        // Scroll ke hasil pertama (kalau ada)
        const firstResult = document.querySelector('#cmdres .cmd-item, #cmdres .item, #cmdres .note-card');
        if (firstResult) {
          firstResult.scrollIntoView({ behavior: 'smooth', block: 'center' });
          firstResult.classList.add('kb'); // highlight seperti keyboard-nav
          setTimeout(() => firstResult.classList.remove('kb'), 1200);
        }
        return;
      }
      if (e.key === 'Escape') { clearSearch(); updateClearBtnVisibility(); e.target.blur(); }
    });
    // v3.10.2 (Issue 4 fix): Click tombol clear (X) → hapus semua teks sekaligus
    if (searchClearBtn) {
      searchClearBtn.addEventListener('click', () => {
        clearSearch();
        updateClearBtnVisibility();
        searchInput.focus();
      });
    }
  }
  // v3.11.1: Quick-actions bar (pengganti search bar di sidebar)
  // v3.11.2: Tombol "Menu" (qaMoreBtn) dihapus — redundan dengan tombol "Baru" di vault view.
  // v3.11.3: Seluruh quick-actions bar dihapus — user bilang "mubazir yang 4 tombol
  //          di atas jadwal sholat". Tiles row sudah cover semua aksi yang sama.
  // Binding di-comment out (tidak dihapus) untuk dokumentasi sejarah.
  // const qaPrompt = $('#qaNewPrompt');
  // if (qaPrompt) qaPrompt.addEventListener('click', savePromptSheet);
  // const qaNote = $('#qaNewNote');
  // if (qaNote) qaNote.addEventListener('click', () => { setView('notes'); newNote(); });
  // const qaLink = $('#qaNewLink');
  // if (qaLink) qaLink.addEventListener('click', saveLinkSheet);
  // const qaShot = $('#qaQuickShot');
  // if (qaShot) qaShot.addEventListener('click', () => doShot());

  document.addEventListener('keydown', e => {
    const inField = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    // v3.11.1: Shortcuts search hanya aktif kalau search bar ada (popup mode)
    if (searchInput && ((e.key === '/' || (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey))) && !inField)) {
      e.preventDefault();
      setView('home');
      searchInput.focus();
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

// ============================================================================
// v3.9.0 (Issue 7): Batch mode untuk notes — select multiple + bulk delete/archive
// ============================================================================
let notesBatchMode = false;
const notesBatchSelected = new Set();

function toggleNotesBatchMode() {
  notesBatchMode = !notesBatchMode;
  notesBatchSelected.clear();
  const bar = $('#notesBatchBar');
  if (bar) bar.style.display = notesBatchMode ? 'flex' : 'none';
  if (!notesBatchMode) {
    // Exit mode — uncheck all
    document.querySelectorAll('.note-batch-check').forEach(c => c.checked = false);
  }
  renderNotes();
  toast(notesBatchMode ? '☑️ Mode batch aktif — klik note untuk pilih' : 'Mode batch dimatikan');
}

function exitNotesBatchMode() {
  if (!notesBatchMode) return;
  toggleNotesBatchMode();
}

function updateNotesBatchCount() {
  const countEl = $('#notesBatchCount');
  if (countEl) countEl.textContent = notesBatchSelected.size + ' dipilih';
}

async function notesBatchAction(action) {
  if (notesBatchSelected.size === 0) {
    toast('Pilih minimal 1 note dulu');
    return;
  }
  const ids = Array.from(notesBatchSelected);
  const verb = action === 'delete' ? 'hapus' : 'arsipkan';
  if (!confirm(`${verb.charAt(0).toUpperCase() + verb.slice(1)} ${ids.length} catatan?`)) return;

  for (const id of ids) {
    try {
      if (action === 'delete') {
        await deleteNote(id);
      } else if (action === 'archive') {
        const n = currentNotes.find(x => x.id === id);
        if (n) await updateNote(id, { archived: !n.archived, updatedAt: new Date().toISOString() });
      }
    } catch (e) {
      console.warn('Batch action failed for note', id, e.message);
    }
  }
  toast(`✓ ${ids.length} catatan di${action === 'delete' ? 'hapus' : 'arsipkan'}`);
  notesBatchSelected.clear();
  notesBatchMode = false;
  const bar = $('#notesBatchBar');
  if (bar) bar.style.display = 'none';
  await renderNotes();
}

// ============================================================================
// v3.9.0 (Issue 5): Sidebar auto-close after N minutes of idle
// ============================================================================
// Only active in sidebar mode (body.rf-sidebar-body). Tracks user activity
// (mousemove, keydown, click, scroll, touchstart, input). After N minutes idle,
// closes sidebar via browser.sidebarAction.close() or window.close() fallback.
function initSidebarAutoClose() {
  if (!document.body.classList.contains('rf-sidebar-body')) return;  // popup mode: skip
  let idleTimer = null;
  let lastActivity = Date.now();
  const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart', 'input'];

  async function checkAndSchedule() {
    try {
      const s = await getVault().then(v => v.settings || {});
      const minutes = Number(s.sidebarAutoCloseMinutes) || 0;
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      if (minutes <= 0) return;
      const idleMs = minutes * 60 * 1000;
      const elapsed = Date.now() - lastActivity;
      const remaining = Math.max(0, idleMs - elapsed);
      idleTimer = setTimeout(async () => {
        const idle = Date.now() - lastActivity;
        if (idle >= idleMs - 5000) {  // allow 5s slack
          console.log(`[RecallFox] Sidebar auto-close after ${minutes}min idle`);
          try {
            if (browser.sidebarAction && browser.sidebarAction.close) {
              await browser.sidebarAction.close();
            } else {
              window.close();
            }
          } catch (e) {
            console.warn('[RecallFox] Sidebar close failed:', e.message);
          }
        } else {
          checkAndSchedule();
        }
      }, remaining);
    } catch (e) {
      console.warn('[RecallFox] Sidebar auto-close check failed:', e.message);
    }
  }

  function onActivity() {
    lastActivity = Date.now();
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
      checkAndSchedule();
    }
  }

  ACTIVITY_EVENTS.forEach(ev => {
    document.addEventListener(ev, onActivity, { passive: true, capture: true });
  });

  setTimeout(checkAndSchedule, 2000);

  if (browser.storage && browser.storage.onChanged) {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.recallfox_vault) {
        const newVault = changes.recallfox_vault.newValue;
        if (newVault?.settings?.sidebarAutoCloseMinutes !== undefined) {
          checkAndSchedule();
        }
      }
    });
  }
}

init().catch(e => console.error('[RecallFox] init failed:', e));

// ============================================================================
// v3.11.7-fix (Issue #6): Adzan sound handler — mainkan suara adzan saat masuk waktu sholat
// Dipicu oleh background.js via browser.runtime.sendMessage({ type: 'PLAY_ADZAN' })
// Audio hanya bisa di-play dari context page (popup/sidebar), bukan background.
// ============================================================================

let _adzanAudio = null;
let _adzanBanner = null;

// URL adzan default — pakai CDN publik (no API key needed).
// File adzan pendek (~30 detik) dari IslamicFinder CDN (gratis, sering dipakai aplikasi adzan).
const ADZAN_URLS = {
  default: 'https://www.islamicfinder.org/cms/audio/azan1/azan1.mp3',
  short: 'https://www.islamicfinder.org/cms/audio/azan2/azan2.mp3'
};

function _stopAdzan() {
  if (_adzanAudio) {
    // v3.11.9: Handle 2 jenis — Audio element ATAU Web Audio API context
    if (_adzanAudio._toneCtx) {
      // Web Audio API tone
      try { _adzanAudio._toneCtx.close(); } catch (e) {}
    } else {
      // Audio element
      try { _adzanAudio.pause(); _adzanAudio.currentTime = 0; } catch (e) {}
    }
    _adzanAudio = null;
  }
  if (_adzanBanner) {
    try { _adzanBanner.remove(); } catch (e) {}
    _adzanBanner = null;
  }
  // v3.11.7-fix2 (Sesi 7, Issue #5): Hide tombol Stop global di header
  const stopBtn = document.getElementById('adzanStopBtn');
  if (stopBtn) stopBtn.style.display = 'none';
  // v3.11.8 (Issue #5): Hide tombol Stop di strip jadwal sholat juga
  const stripStopBtn = document.getElementById('stripAdzanStop');
  if (stripStopBtn) stripStopBtn.style.display = 'none';
  // v3.11.7-fix2: Juga broadcast STOP_ADZAN ke content script tab aktif (kalau adzan
  // di-play di tab aktif, bukan di popup)
  try {
    browser.runtime.sendMessage({ type: 'STOP_ADZAN' }).catch(() => {});
  } catch (e) {}
}

// v3.11.7-fix2 (Sesi 7, Issue #5): Toggle tombol Stop global di header saat adzan aktif.
// Dipanggil dari _playAdzan (popup context) dan dari handler PLAY_ADZAN (saat background
// kirim ke popup). Tombol muncul sebagai icon ⏹ hijau di header — mudah diakses tanpa
// masuk settings.
function _showAdzanStopButton() {
  const stopBtn = document.getElementById('adzanStopBtn');
  if (stopBtn) {
    stopBtn.style.display = '';
    // Bind click handler (sekali saja, tapi idempotent)
    if (!stopBtn.dataset.bound) {
      stopBtn.addEventListener('click', _stopAdzan);
      stopBtn.dataset.bound = '1';
    }
  }
  // v3.11.8 (Issue #5): Show tombol Stop di strip jadwal sholat juga (selalu visible)
  const stripStopBtn = document.getElementById('stripAdzanStop');
  if (stripStopBtn) {
    stripStopBtn.style.display = '';
    if (!stripStopBtn.dataset.bound) {
      stripStopBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _stopAdzan();
      });
      stripStopBtn.dataset.bound = '1';
    }
  }
}

function _playAdzan(prayer, prayerKey, volume, sound, customUrl) {
  // Stop adzan sebelumnya kalau ada
  _stopAdzan();

  const vol = Math.max(0, Math.min(1, Number(volume) || 0.7));

  // v3.11.9 (Issue #3 fix): Adzan pakai 2 strategi:
  // 1. Jika sound='custom' + customUrl → pakai Audio element dengan URL custom
  // 2. Jika sound='default'/'short' → pakai Web Audio API generate tone (PASTI JALAN, no CORS, no 404)
  //    Sebelumnya pakai URL IslamicFinder yang 404 → error terus.
  //    Tone ini bukan adzan asli, tapi cukup sebagai pengingat waktu sholat.
  //    User yang mau adzan asli bisa set custom URL ke file MP3 sendiri.

  let _adzanTimeout = null;

  if (sound === 'custom' && customUrl) {
    // Strategy 1: Custom URL — pakai Audio element
    try {
      _adzanAudio = new Audio(customUrl);
      _adzanAudio.volume = vol;
      _adzanAudio.crossOrigin = 'anonymous';
      _adzanAudio.play().catch(e => {
        console.warn('[RecallFox] Custom adzan play failed:', e.message);
        // Fallback ke tone
        _playAdzanTone(vol);
      });
    } catch (e) {
      console.warn('[RecallFox] Custom adzan init failed:', e.message);
      _playAdzanTone(vol);
    }
  } else {
    // Strategy 2: Web Audio API tone (default + short)
    _playAdzanTone(vol, sound === 'short');
  }

  // Tampilkan banner Stop (fixed di bawah, tidak nutupin konten)
  _adzanBanner = document.createElement('div');
  _adzanBanner.id = 'rfAdzanBanner';
  _adzanBanner.style.cssText = [
    'position:fixed',
    'bottom:0',
    'left:0',
    'right:0',
    'background:linear-gradient(135deg,#10b981,#059669)',
    'color:#fff',
    'padding:10px 16px',
    'display:flex',
    'align-items:center',
    'justify-content:space-between',
    'gap:10px',
    'z-index:99999',
    'font-size:13px',
    'box-shadow:0 -2px 12px rgba(0,0,0,0.15)',
    'font-family:inherit'
  ].join(';');
  _adzanBanner.innerHTML =
    '<div style="display:flex;align-items:center;gap:8px">'
    + '<span style="font-size:18px">🕌</span>'
    + '<div>'
    +   '<div style="font-weight:600">Adzan — ' + prayer + ' telah masuk</div>'
    +   '<div style="font-size:11px;opacity:0.85">Klik ⏹ Stop untuk menghentikan suara</div>'
    + '</div>'
    + '</div>'
    + '<button id="rfAdzanStop" style="background:rgba(255,255,255,0.2);color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600">⏹ Stop</button>';
  document.body.appendChild(_adzanBanner);

  // Bind tombol Stop
  const stopBtn = _adzanBanner.querySelector('#rfAdzanStop');
  if (stopBtn) {
    stopBtn.addEventListener('click', _stopAdzan);
  }

  // Auto-cleanup saat audio selesai (hanya untuk custom URL)
  if (_adzanAudio) {
    _adzanAudio.onended = () => _stopAdzan();
    _adzanAudio.onerror = () => {
      console.warn('[RecallFox] Adzan audio error — fallback ke tone');
      _stopAdzan();
      _playAdzanTone(vol);
    };
  }

  // Auto-stop setelah 2 menit (safety)
  _adzanTimeout = setTimeout(() => {
    if (_adzanAudio || _adzanBanner) {
      console.log('[RecallFox] Adzan auto-stop after 2 minutes');
      _stopAdzan();
    }
  }, 2 * 60 * 1000);

  // v3.11.7-fix2 (Sesi 7, Issue #5): Tampilkan tombol Stop global di header
  _showAdzanStopButton();
}

// v3.11.10 (Issue #3 fix): REWRITE adzan tone jadi lebih mirip suara adzan asli.
// V3.11.9 pakai 7 nada sine wave pendek → user dengar seperti "bel", bukan adzan.
// V3.11.10: 4 phrase "Allahu Akbar" (30+ detik) dengan:
//   - Multiple oscillators (chord) supaya kaya suara manusia
//   - Frequency modulation (vibrato) supaya tidak monoton
//   - Reverb effect (delay + feedback) supaya sound like mosque
//   - Durasi lebih panjang (4 phrase × ~7 detik = ~28 detik)
//   - Singkat kata per phrase: "Al-la-hu Ak-bar" (4 syllable)
//
// Plus: tetap allow custom URL ke file MP3 adzan asli (di settings).
function _playAdzanTone(vol, isShort) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      console.warn('[RecallFox] Web Audio API tidak support');
      return;
    }
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    // ===== Reverb effect (delay + feedback) supaya sound like mosque =====
    const reverbDelay = ctx.createDelay(2.0);
    reverbDelay.delayTime.value = 0.18; // 180ms delay
    const reverbFeedback = ctx.createGain();
    reverbFeedback.gain.value = 0.35; // 35% feedback
    const reverbWet = ctx.createGain();
    reverbWet.gain.value = 0.25; // 25% wet mix
    reverbDelay.connect(reverbFeedback);
    reverbFeedback.connect(reverbDelay);
    reverbDelay.connect(reverbWet);

    // ===== Master gain + low-pass filter (supaya tidak terlalu bright/harsh) =====
    const masterGain = ctx.createGain();
    masterGain.gain.value = vol;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 2400; // cut frequencies above 2400Hz
    lowpass.Q.value = 0.7;

    masterGain.connect(lowpass);
    lowpass.connect(ctx.destination);
    lowpass.connect(reverbDelay); // send to reverb
    reverbWet.connect(ctx.destination);

    // ===== Phrase: "Allahu Akbar" motif =====
    // Setiap phrase = 4 syllable: "Al-la-hu Ak-bar"
    // Syllable mapping (Hz):
    //   "Al"  = A4 (440) — singkat
    //   "la"  = G4 (392) — singkat
    //   "hu"  = A4 (440) — sedang
    //   "Ak"  = E4 (329.63) — singkat, lower
    //   "bar" = A4 (440) — panjang (sustain)
    //
    // Phrase 1 (Allahu Akbar) — base
    // Phrase 2 (Allahu Akbar) — repeat, slightly higher
    // Phrase 3 (Allahu Akbar) — repeat, modulasi
    // Phrase 4 (Allahu Akbar) — final, panjang
    const syllables = [
      // [freq, startOffset, dur, gain]
      // Phrase 1 (0-7s)
      { freq: 440, start: 0.0, dur: 0.6, gain: 0.9 },  // Al
      { freq: 392, start: 0.6, dur: 0.5, gain: 0.85 }, // la
      { freq: 440, start: 1.1, dur: 0.7, gain: 0.9 },  // hu
      { freq: 329.63, start: 1.8, dur: 0.5, gain: 0.8 }, // Ak
      { freq: 440, start: 2.3, dur: 1.5, gain: 1.0 },  // bar (panjang)
      // Pause
      { freq: 0, start: 3.8, dur: 0.4, gain: 0 }, // pause
      // Phrase 2 (4.2-11s) — slightly higher
      { freq: 466.16, start: 4.2, dur: 0.6, gain: 0.9 },  // Al (Bb4)
      { freq: 415.30, start: 4.8, dur: 0.5, gain: 0.85 }, // la (Ab4)
      { freq: 466.16, start: 5.3, dur: 0.7, gain: 0.9 },  // hu (Bb4)
      { freq: 349.23, start: 6.0, dur: 0.5, gain: 0.8 },  // Ak (F4)
      { freq: 466.16, start: 6.5, dur: 1.5, gain: 1.0 },  // bar (panjang)
      // Pause
      { freq: 0, start: 8.0, dur: 0.4, gain: 0 },
    ];

    // Untuk short version, hanya 2 phrase
    const phrases = isShort ? syllables.slice(0, 6) : syllables;

    // ===== Mainkan setiap syllable dengan chord + vibrato =====
    for (const syl of phrases) {
      if (syl.freq === 0) continue; // skip pause
      const start = now + syl.start;
      const end = start + syl.dur;

      // Chord: fundamental + 2 harmonics (octave + fifth) supaya kaya voice
      const harmonics = [
        { ratio: 1.0, gain: 0.6 },     // fundamental
        { ratio: 2.0, gain: 0.2 },     // octave
        { ratio: 1.5, gain: 0.15 },    // fifth
      ];

      for (const h of harmonics) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine'; // sine = smooth, less harsh
        osc.frequency.value = syl.freq * h.ratio;

        // Vibrato: frequency modulation supaya tidak monoton
        const vibrato = ctx.createOscillator();
        const vibratoGain = ctx.createGain();
        vibrato.frequency.value = 5; // 5Hz vibrato
        vibratoGain.gain.value = syl.freq * 0.015; // 1.5% pitch modulation
        vibrato.connect(vibratoGain);
        vibratoGain.connect(osc.frequency);

        // Envelope: attack-decay-sustain-release
        const peakGain = vol * syl.gain * h.gain;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(peakGain, start + 0.08); // attack 80ms
        gain.gain.linearRampToValueAtTime(peakGain * 0.75, start + syl.dur * 0.5); // sustain
        gain.gain.linearRampToValueAtTime(0, end); // release

        osc.connect(gain);
        gain.connect(masterGain);
        osc.start(start);
        osc.stop(end + 0.1);
        vibrato.start(start);
        vibrato.stop(end + 0.1);
      }
    }

    // Simpan context supaya bisa di-stop
    _adzanAudio = { _toneCtx: ctx, _toneGain: masterGain };

    // Auto-stop context setelah selesai (30s untuk default, 10s untuk short)
    const totalDur = isShort ? 10 : 28;
    setTimeout(() => {
      try {
        if (ctx.state !== 'closed') ctx.close();
      } catch (e) {}
    }, totalDur * 1000 + 500);

    console.log('[RecallFox] Adzan tone diputar (' + (isShort ? 'short' : 'default') + ', ' + phrases.length + ' syllables, ~' + totalDur + 's)');
  } catch (e) {
    console.warn('[RecallFox] Adzan tone failed:', e.message);
  }
}

// Listener untuk message PLAY_ADZAN dari background
// v3.11.9 (Issue #2 fix): return `true` untuk async response supaya tidak
// "Promised response from onMessage listener went out of scope"
if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.onMessage) {
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PLAY_ADZAN') {
      try {
        _playAdzan(msg.prayer, msg.prayerKey, msg.volume, msg.sound, msg.customUrl);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
      return true; // v3.11.9: return true supaya sendResponse tidak out of scope
    }
    if (msg.type === 'STOP_ADZAN') {
      try {
        _stopAdzan();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
      return true;
    }
    return false;
  });
}
