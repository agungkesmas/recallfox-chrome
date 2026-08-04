// lib/link-pack.js — v3.20.26: Import Paket (multi-type)
//
// Fitur: import file JSON manifest (.recallfox-pack.json) yang berisi
// definisi 1 folder + N item. Setelah import, folder + item muncul
// di Vault RecallFox dengan struktur yang sama.
//
// v3.20.25 (Phase 1): Hanya support type 'link' (link-pack v1)
// v3.20.26 (Phase 2): Extend ke multi-type — link + prompt + context + note
//   - schemaVersion: 2 → type: "recallfox-pack" (multi-type)
//   - schemaVersion: 1 → type: "recallfox-link-pack" (link-only, backward compat)
//
// BATASAN (sesuai audit):
// - Type yang didukung: link, prompt, context, note
// - Type yang DITOLAK: screenshot, document (butuh Storage upload, kompleks)
// - Type yang DITOLAK: bundle (referential integrity ke item_ids)
// - Type snapshot: DIDUKUNG tapi field resumeContext di-skip (local-only)
//   Note: snapshot tetap di-support karena schema DB-nya ada dan tidak butuh
//   upload gambar. Resume context di-skip karena local-only.
// - Tidak ada perubahan schema Supabase
// - Pakai mekanisme Vault/folder/sync yang sudah ada
// - Generic untuk semua paket (tidak hardcode paket tertentu)
//
// Format manifest v2 (multi-type):
// {
//   "schemaVersion": 2,
//   "type": "recallfox-pack",
//   "packId": "paket-ai-workflow",
//   "version": "1.0.0",
//   "name": "Paket AI Workflow Lengkap",
//   "description": "Link + prompt + konteks untuk workflow AI",
//   "updatedAt": "2026-08-04T00:00:00+07:00",
//   "folder": { "name": "AI Workflow", "color": "#10B981" },
//   "items": [
//     { "id": "ctx-proyek", "type": "context", "title": "Konteks Proyek A", "body": "...", "contextPurpose": "project", "tags": ["proyek-a"] },
//     { "id": "prompt-analisis", "type": "prompt", "title": "Analisis Data", "body": "Tolong analisis: {{data}}", "tags": ["analisis"] },
//     { "id": "link-docs", "type": "link", "title": "Google Docs", "url": "https://...", "tags": ["referensi"] },
//     { "id": "note-meeting", "type": "note", "title": "Template Meeting", "body": "## Agenda\n1. ...", "color": "yellow", "tags": ["template"] }
//   ]
// }
//
// Format manifest v1 (link-only, backward compat):
// {
//   "schemaVersion": 1,
//   "type": "recallfox-link-pack",
//   ...
//   "items": [{ "type": "link", "url": "...", ... }]
// }

import { getVault, saveVault, addItem, addNote, getNotes } from './storage.js';
import { createGroup, setParentId, setOrder } from './vault-tree.js';
import { extractVariables } from './search.js';

const MAX_ITEMS_PER_PACK = 100;
const PACK_TAG_PREFIX = 'import-pack:';

// v3.20.26: Type yang didukung di schema v2
const SUPPORTED_TYPES_V2 = ['link', 'prompt', 'context', 'note', 'snapshot'];
// Type yang DITOLAK dengan pesan error jelas
const REJECTED_TYPES = ['screenshot', 'document', 'bundle'];

// v3.20.26: Whitelist contextPurpose (sesuai enum di popup.js)
const VALID_CONTEXT_PURPOSES = ['system', 'project', 'domain', 'reference', 'instruction', 'custom'];

// v3.20.26: Whitelist note color (sesuai addNote di storage.js)
const VALID_NOTE_COLORS = ['default', 'yellow', 'green', 'blue', 'pink', 'purple'];

// ===== validateLinkPack: validasi manifest object =====
// Support v1 (link-only) dan v2 (multi-type)
// Return: { ok: true, pack: normalizedPack } | { ok: false, errors: string[] }
export function validateLinkPack(raw) {
  const errors = [];

  // 1. Root harus object
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['Root manifest harus berupa object JSON.'] };
  }

  // 2. schemaVersion harus 1 atau 2
  const sv = raw.schemaVersion;
  if (sv !== 1 && sv !== 2) {
    errors.push('Field "schemaVersion" harus bernilai 1 atau 2 (ditemukan: ' + JSON.stringify(sv) + ').');
  }

  // 3. type harus sesuai schemaVersion
  if (sv === 1 && raw.type !== 'recallfox-link-pack') {
    errors.push('Field "type" untuk schemaVersion 1 harus "recallfox-link-pack" (ditemukan: ' + JSON.stringify(raw.type) + ').');
  }
  if (sv === 2 && raw.type !== 'recallfox-pack') {
    errors.push('Field "type" untuk schemaVersion 2 harus "recallfox-pack" (ditemukan: ' + JSON.stringify(raw.type) + ').');
  }

  // 4. String fields wajib tidak kosong
  const requiredStrings = ['packId', 'version', 'name'];
  for (const f of requiredStrings) {
    const v = raw[f];
    if (typeof v !== 'string' || v.trim() === '') {
      errors.push('Field "' + f + '" wajib berupa string tidak kosong.');
    }
  }

  // 5. folder.name wajib
  if (!raw.folder || typeof raw.folder !== 'object') {
    errors.push('Field "folder" wajib berupa object.');
  } else {
    if (typeof raw.folder.name !== 'string' || raw.folder.name.trim() === '') {
      errors.push('Field "folder.name" wajib berupa string tidak kosong.');
    }
    if (raw.folder.color !== undefined && raw.folder.color !== null) {
      if (typeof raw.folder.color !== 'string' || !/^#[0-9a-fA-F]{3,8}$|^rgb/i.test(raw.folder.color)) {
        errors.push('Field "folder.color" opsional — kalau diisi harus hex (#RRGGBB) atau rgb().');
      }
    }
  }

  // 6. items wajib array minimal 1
  if (!Array.isArray(raw.items)) {
    errors.push('Field "items" wajib berupa array.');
  } else if (raw.items.length === 0) {
    errors.push('Field "items" tidak boleh kosong — minimal 1 item.');
  } else if (raw.items.length > MAX_ITEMS_PER_PACK) {
    errors.push('Field "items" maksimal ' + MAX_ITEMS_PER_PACK + ' item per paket (ditemukan: ' + raw.items.length + ').');
  } else {
    // 7. Validasi setiap item
    raw.items.forEach((it, idx) => {
      const ctx = 'items[' + idx + ']';
      if (!it || typeof it !== 'object') {
        errors.push(ctx + ': wajib berupa object.');
        return;
      }
      // id wajib string tidak kosong
      if (typeof it.id !== 'string' || it.id.trim() === '') {
        errors.push(ctx + '.id: wajib berupa string tidak kosong.');
      }
      // title wajib
      if (typeof it.title !== 'string' || it.title.trim() === '') {
        errors.push(ctx + '.title: wajib berupa string tidak kosong.');
      }
      // type — v1: harus 'link'; v2: harus salah satu dari SUPPORTED_TYPES_V2
      if (sv === 1) {
        if (it.type !== 'link') {
          errors.push(ctx + '.type: untuk schemaVersion 1 harus "link" (ditemukan: ' + JSON.stringify(it.type) + ').');
        }
      } else {
        // sv === 2
        if (!SUPPORTED_TYPES_V2.includes(it.type)) {
          if (REJECTED_TYPES.includes(it.type)) {
            errors.push(ctx + '.type: "' + it.type + '" tidak didukung untuk import (risiko tinggi). Hanya link, prompt, context, note, snapshot yang didukung.');
          } else {
            errors.push(ctx + '.type: harus salah satu dari link, prompt, context, note, snapshot (ditemukan: ' + JSON.stringify(it.type) + ').');
          }
        }
      }
      // Validasi per-type (untuk v2, atau v1 dengan type=link)
      const itemType = it.type;
      if (itemType === 'link') {
        if (typeof it.url !== 'string' || it.url.trim() === '') {
          errors.push(ctx + '.url: wajib berupa string URL untuk type "link".');
        } else {
          const urlErr = validateUrl(it.url);
          if (urlErr) errors.push(ctx + '.url: ' + urlErr);
        }
        if (it.description !== undefined && it.description !== null && typeof it.description !== 'string') {
          errors.push(ctx + '.description: opsional — kalau diisi harus string.');
        }
      } else if (itemType === 'prompt' || itemType === 'context' || itemType === 'note' || itemType === 'snapshot') {
        // body wajib string tidak kosong
        if (typeof it.body !== 'string' || it.body.trim() === '') {
          errors.push(ctx + '.body: wajib berupa string tidak kosong untuk type "' + itemType + '".');
        }
        // context-specific: contextPurpose opsional, kalau ada harus di whitelist
        if (itemType === 'context' && it.contextPurpose !== undefined && it.contextPurpose !== null) {
          if (!VALID_CONTEXT_PURPOSES.includes(it.contextPurpose)) {
            errors.push(ctx + '.contextPurpose: opsional — kalau diisi harus salah satu dari: ' + VALID_CONTEXT_PURPOSES.join(', ') + ' (ditemukan: ' + JSON.stringify(it.contextPurpose) + ').');
          }
        }
        // note-specific: color opsional, kalau ada harus di whitelist
        if (itemType === 'note' && it.color !== undefined && it.color !== null) {
          if (!VALID_NOTE_COLORS.includes(it.color)) {
            errors.push(ctx + '.color: opsional — kalau diisi harus salah satu dari: ' + VALID_NOTE_COLORS.join(', ') + ' (ditemukan: ' + JSON.stringify(it.color) + ').');
          }
        }
        // snapshot-specific: snapshotDomain + snapshotMessageCount opsional
        if (itemType === 'snapshot') {
          if (it.snapshotDomain !== undefined && it.snapshotDomain !== null && typeof it.snapshotDomain !== 'string') {
            errors.push(ctx + '.snapshotDomain: opsional — kalau diisi harus string.');
          }
          if (it.snapshotMessageCount !== undefined && it.snapshotMessageCount !== null && typeof it.snapshotMessageCount !== 'number') {
            errors.push(ctx + '.snapshotMessageCount: opsional — kalau diisi harus number.');
          }
        }
      }
      // order opsional, kalau ada harus number
      if (it.order !== undefined && it.order !== null && typeof it.order !== 'number') {
        errors.push(ctx + '.order: opsional — kalau diisi harus number.');
      }
      // tags opsional, kalau ada harus array of string
      if (it.tags !== undefined && it.tags !== null) {
        if (!Array.isArray(it.tags) || !it.tags.every(t => typeof t === 'string')) {
          errors.push(ctx + '.tags: opsional — kalau diisi harus array of string.');
        }
      }
      // toppings opsional (untuk prompt/context), kalau ada harus array of string
      if (it.toppings !== undefined && it.toppings !== null) {
        if (!Array.isArray(it.toppings) || !it.toppings.every(t => typeof t === 'string')) {
          errors.push(ctx + '.toppings: opsional — kalau diisi harus array of string.');
        }
      }
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Normalize pack
  const pack = {
    schemaVersion: sv,
    type: sv === 1 ? 'recallfox-link-pack' : 'recallfox-pack',
    packId: raw.packId.trim(),
    version: raw.version.trim(),
    name: raw.name.trim(),
    description: typeof raw.description === 'string' ? raw.description.trim() : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    folder: {
      name: raw.folder.name.trim(),
      color: typeof raw.folder.color === 'string' ? raw.folder.color : null
    },
    items: raw.items.map(it => {
      const base = {
        id: it.id.trim(),
        type: it.type,
        title: it.title.trim(),
        order: typeof it.order === 'number' ? it.order : 0,
        tags: Array.isArray(it.tags) ? it.tags.filter(t => typeof t === 'string') : []
      };
      // Per-type normalize
      if (it.type === 'link') {
        base.url = (it.url || '').trim();
        base.description = typeof it.description === 'string' ? it.description.trim() : '';
      } else {
        // prompt, context, note, snapshot
        base.body = typeof it.body === 'string' ? it.body : '';
        if (it.type === 'context' && it.contextPurpose) {
          base.contextPurpose = it.contextPurpose;
        }
        if (it.type === 'note' && it.color) {
          base.color = it.color;
        }
        if (it.type === 'snapshot') {
          base.snapshotDomain = typeof it.snapshotDomain === 'string' ? it.snapshotDomain : '';
          base.snapshotMessageCount = typeof it.snapshotMessageCount === 'number' ? it.snapshotMessageCount : 0;
        }
        if ((it.type === 'prompt' || it.type === 'context') && Array.isArray(it.toppings)) {
          base.toppings = it.toppings.filter(t => typeof t === 'string');
        }
      }
      return base;
    })
  };

  return { ok: true, pack };
}

// Helper: validasi URL — hanya http/https, tolak javascript:/data:/file:
function validateUrl(url) {
  let u;
  try { u = new URL(url); } catch (e) {
    return 'URL tidak valid — tidak bisa diparse.';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return 'Protocol harus http: atau https: (ditemukan: ' + u.protocol + ').';
  }
  if (!u.hostname || u.hostname.length < 3) {
    return 'URL tidak punya hostname yang valid.';
  }
  return null;
}

// ===== readLinkPackFile: baca File → object =====
// Return: { ok: true, pack } | { ok: false, errors }
export async function readLinkPackFile(file) {
  if (!file) return { ok: false, errors: ['File tidak diberikan.'] };

  const name = (file.name || '').toLowerCase();
  if (!name.endsWith('.json') && !name.endsWith('.recallfox-pack.json')) {
    return { ok: false, errors: ['File harus berekstensi .json atau .recallfox-pack.json.'] };
  }

  // v3.20.26: Maks 10MB (naik dari 5MB) karena prompt/context body bisa panjang
  if (file.size > 10 * 1024 * 1024) {
    return { ok: false, errors: ['File terlalu besar (maks 10MB).'] };
  }

  let text;
  try {
    text = await file.text();
  } catch (e) {
    return { ok: false, errors: ['File tidak dapat dibaca. Pilih file paket JSON yang valid.'] };
  }

  if (!text || text.trim() === '') {
    return { ok: false, errors: ['File kosong.'] };
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: ['JSON rusak: ' + (e.message || 'parse error') + '. Pastikan file JSON valid.'] };
  }

  return validateLinkPack(raw);
}

// ===== hasImportedPack: cek apakah packId sudah pernah diimpor =====
// Cek dengan tag internal `import-pack:<packId>` di semua item.
// v3.20.26: Cek juga di notes (untuk type note yang disimpan di tabel terpisah)
export async function hasImportedPack(packId) {
  if (!packId) return false;
  const tag = PACK_TAG_PREFIX + packId;
  const vault = await getVault();
  const inVault = (vault.items || []).some(it =>
    Array.isArray(it.tags) && it.tags.includes(tag)
  );
  if (inVault) return true;
  // v3.20.26: Cek juga di notes
  try {
    const notes = await getNotes();
    return notes.some(n => Array.isArray(n.tags) && n.tags.includes(tag));
  } catch (e) {
    return false;
  }
}

// ===== importLinkPack: import pack → buat folder + N item =====
// v3.20.26: Support multi-type (link, prompt, context, note, snapshot)
// options: { asCopy: boolean } — kalau true, folder name diberi suffix " (Salinan)"
// Return: { ok: true, folderId, itemCount, typeCounts } | { ok: false, error }
export async function importLinkPack(pack, options = {}) {
  if (!pack || !pack.folder || !pack.items) {
    return { ok: false, error: 'Pack tidak valid.' };
  }

  const asCopy = !!options.asCopy;
  const packTag = PACK_TAG_PREFIX + pack.packId;

  // 1. Tentukan type folder — pakai type item pertama yang bukan note
  //    (note disimpan di tabel terpisah, tidak masuk folder vault)
  //    Default: 'link' kalau semua note, atau mix
  const firstNonNoteItem = pack.items.find(it => it.type !== 'note');
  const folderType = firstNonNoteItem ? firstNonNoteItem.type : 'link';

  const folderName = asCopy
    ? pack.folder.name + ' (Salinan)'
    : pack.folder.name;
  const folder = createGroup(folderName, folderType);
  if (pack.folder.color) {
    if (!folder.source) folder.source = {};
    folder.source.folderColor = pack.folder.color;
  }
  folder.tags = ['group', packTag];
  if (!folder.source) folder.source = {};
  folder.source.capturedAt = new Date().toISOString();
  folder.source.packId = pack.packId;
  folder.source.packVersion = pack.version;
  folder.source.packName = pack.name;
  folder.source.packSchemaVersion = pack.schemaVersion;

  // Snapshot vault + notes sebelum — untuk rollback kalau gagal di tengah
  const vaultBefore = await getVault();
  const itemsBeforeCount = (vaultBefore.items || []).length;
  let notesBefore = [];
  try { notesBefore = await getNotes(); } catch (e) {}
  const notesBeforeCount = notesBefore.length;

  // Track type counts untuk return
  const typeCounts = { link: 0, prompt: 0, context: 0, note: 0, snapshot: 0 };
  let imported = 0;
  let folderId = null;

  try {
    // 2. Tambah folder ke vault (kalau ada item non-note)
    if (firstNonNoteItem) {
      await addItem(folder);
      folderId = folder.id;
    }

    // 3. Tambah setiap item
    for (let i = 0; i < pack.items.length; i++) {
      const it = pack.items[i];
      const order = typeof it.order === 'number' ? it.order : (i + 1);

      if (it.type === 'note') {
        // Note → simpan ke tabel notes terpisah
        const noteOpts = {
          title: it.title,
          color: it.color || 'default',
          pinned: false
        };
        const note = await addNote(it.body, noteOpts);
        // Tambah tag pack ke note (addNote tidak terima tags, jadi update manual)
        try {
          const notesNow = await getNotes();
          const noteIdx = notesNow.findIndex(n => n.id === note.id);
          if (noteIdx >= 0) {
            notesNow[noteIdx].tags = Array.isArray(it.tags) ? [...it.tags, packTag] : [packTag];
            notesNow[noteIdx].source = {
              capturedAt: new Date().toISOString(),
              packId: pack.packId,
              packItemId: it.id,
              packOrder: order
            };
            // Save manual (bukan addNote, karena kita update existing)
            const { saveNotes } = await import('./storage.js');
            await saveNotes(notesNow);
          }
        } catch (e) {
          console.warn('[RecallFox/link-pack] Failed to tag note:', e.message);
        }
        typeCounts.note++;
      } else {
        // link, prompt, context, snapshot → simpan ke vault_items
        const itemObj = {
          type: it.type,
          title: it.title,
          tags: Array.isArray(it.tags) ? [...it.tags, packTag] : [packTag],
          source: {
            capturedAt: new Date().toISOString(),
            packId: pack.packId,
            packItemId: it.id,
            packOrder: order
          }
        };

        if (it.type === 'link') {
          itemObj.body = it.url; // backward compat untuk search
          itemObj.linkUrl = it.url;
          itemObj.linkTitle = it.title;
          if (it.description) {
            itemObj.body = it.description + '\n\n' + it.url;
          }
        } else if (it.type === 'prompt') {
          itemObj.body = it.body;
          // v3.20.26: Auto-extract variables dari {{var}} pattern
          itemObj.variables = extractVariables(it.body);
          if (Array.isArray(it.toppings)) {
            itemObj.toppings = it.toppings;
          }
        } else if (it.type === 'context') {
          itemObj.body = it.body;
          if (it.contextPurpose) {
            itemObj.contextPurpose = it.contextPurpose;
          }
          if (Array.isArray(it.toppings)) {
            itemObj.toppings = it.toppings;
          }
        } else if (it.type === 'snapshot') {
          itemObj.body = it.body;
          itemObj.snapshotDomain = it.snapshotDomain || '';
          itemObj.snapshotMessageCount = it.snapshotMessageCount || 0;
          // v3.20.26: resumeContext di-skip (local-only, tidak sync ke Supabase)
          // Tidak set resumeContext di sini — biarkan null
        }

        // Set parentId supaya nested di folder (kalau folder ada)
        if (folderId) {
          setParentId(itemObj, folderId);
        }
        setOrder(itemObj, order);
        await addItem(itemObj);
        typeCounts[it.type]++;
      }
      imported++;
    }

    return {
      ok: true,
      folderId,
      folderName,
      itemCount: imported,
      typeCounts
    };
  } catch (e) {
    // Rollback — hapus folder + semua item vault yang baru dibuat + notes yang baru dibuat
    console.error('[RecallFox/link-pack] Import gagal, rollback...', e);
    try {
      const vaultNow = await getVault();
      const newItems = (vaultNow.items || []).slice(itemsBeforeCount);
      const idsToRemove = new Set([folder.id, ...newItems.map(it => it.id).filter(id => id)]);
      vaultNow.items = (vaultNow.items || []).filter(it => !idsToRemove.has(it.id));
      await saveVault(vaultNow);
      console.log('[RecallFox/link-pack] Vault rollback berhasil, ' + idsToRemove.size + ' item dihapus.');
    } catch (rollbackErr) {
      console.error('[RecallFox/link-pack] Vault rollback gagal:', rollbackErr);
    }
    // Rollback notes
    try {
      const notesNow = await getNotes();
      if (notesNow.length > notesBeforeCount) {
        // Hapus notes yang baru ditambah (yang tidak ada di notesBefore)
        const beforeIds = new Set(notesBefore.map(n => n.id));
        const filteredNotes = notesNow.filter(n => beforeIds.has(n.id));
        const { saveNotes } = await import('./storage.js');
        await saveNotes(filteredNotes);
        console.log('[RecallFox/link-pack] Notes rollback berhasil, ' + (notesNow.length - filteredNotes.length) + ' note dihapus.');
      }
    } catch (rollbackErr) {
      console.error('[RecallFox/link-pack] Notes rollback gagal:', rollbackErr);
    }
    return { ok: false, error: e.message || 'Import gagal.' };
  }
}

// v3.20.26: Helper untuk dapatkan label type (dipakai di UI preview)
export function getTypeLabel(type) {
  const labels = {
    link: '🔗 Link',
    prompt: '✨ Prompt',
    context: '📦 Konteks',
    note: '📝 Catatan',
    snapshot: '📸 Snapshot'
  };
  return labels[type] || '❓ ' + type;
}

// v3.20.26: Helper untuk dapatkan icon type (dipakai di UI preview)
export function getTypeIcon(type) {
  const icons = {
    link: '🔗',
    prompt: '✨',
    context: '📦',
    note: '📝',
    snapshot: '📸'
  };
  return icons[type] || '❓';
}
