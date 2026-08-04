// lib/link-pack.js — v3.20.25: Import Paket Link
//
// Fitur: import file JSON manifest (.recallfox-pack.json) yang berisi
// definisi 1 folder + N item link. Setelah import, folder + link muncul
// di Vault RecallFox dengan struktur yang sama.
//
// BATASAN (sesuai spec user):
// - Hanya import folder + item type 'link'
// - Tidak ada workflow/OCR/AI/bundle/case system baru
// - Tidak ada perubahan schema Supabase
// - Pakai mekanisme Vault/folder/sync yang sudah ada
// - Hanya import file JSON lokal (tidak support URL)
// - Generic untuk semua paket (tidak hardcode paket tertentu)
//
// Format manifest (link-pack v1):
// {
//   "schemaVersion": 1,
//   "type": "recallfox-link-pack",
//   "packId": "paket-ai-kegiatan-dinas",
//   "version": "1.0.0",
//   "name": "Paket AI Kegiatan Dinas",
//   "description": "Shortcut link untuk README, memo, task plan, dan laporan dinas.",
//   "updatedAt": "2026-08-04T00:00:00+07:00",
//   "folder": { "name": "Paket AI Kegiatan Dinas", "color": "#2563EB" },
//   "items": [
//     { "id": "readme", "type": "link", "title": "01 — README", "url": "https://...", "description": "...", "order": 1, "tags": ["..."] }
//   ]
// }

import { getVault, saveVault, addItem } from './storage.js';
import { createGroup, setParentId, setOrder } from './vault-tree.js';

const MAX_ITEMS_PER_PACK = 100;
const PACK_TAG_PREFIX = 'import-pack:';

// ===== validateLinkPack: validasi manifest object =====
// Return: { ok: true, pack: normalizedPack } | { ok: false, errors: string[] }
export function validateLinkPack(raw) {
  const errors = [];

  // 1. Root harus object
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['Root manifest harus berupa object JSON.'] };
  }

  // 2. schemaVersion harus 1
  if (raw.schemaVersion !== 1) {
    errors.push('Field "schemaVersion" harus bernilai 1 (ditemukan: ' + JSON.stringify(raw.schemaVersion) + ').');
  }

  // 3. type harus 'recallfox-link-pack'
  if (raw.type !== 'recallfox-link-pack') {
    errors.push('Field "type" harus bernilai "recallfox-link-pack" (ditemukan: ' + JSON.stringify(raw.type) + ').');
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
    // folder.color opsional, kalau ada harus string hex/rgb valid
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
      // type harus tepat 'link'
      if (it.type !== 'link') {
        errors.push(ctx + '.type: harus "link" (ditemukan: ' + JSON.stringify(it.type) + ').');
      }
      // title wajib
      if (typeof it.title !== 'string' || it.title.trim() === '') {
        errors.push(ctx + '.title: wajib berupa string tidak kosong.');
      }
      // url wajib valid http/https
      if (typeof it.url !== 'string' || it.url.trim() === '') {
        errors.push(ctx + '.url: wajib berupa string URL.');
      } else {
        const urlErr = validateUrl(it.url);
        if (urlErr) errors.push(ctx + '.url: ' + urlErr);
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
      // description opsional, kalau ada harus string
      if (it.description !== undefined && it.description !== null && typeof it.description !== 'string') {
        errors.push(ctx + '.description: opsional — kalau diisi harus string.');
      }
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Normalize pack (cleanup whitespace, hapus field tidak dikenal untuk konsistensi)
  const pack = {
    schemaVersion: 1,
    type: 'recallfox-link-pack',
    packId: raw.packId.trim(),
    version: raw.version.trim(),
    name: raw.name.trim(),
    description: typeof raw.description === 'string' ? raw.description.trim() : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    folder: {
      name: raw.folder.name.trim(),
      color: typeof raw.folder.color === 'string' ? raw.folder.color : null
    },
    items: raw.items.map(it => ({
      id: it.id.trim(),
      type: 'link',
      title: it.title.trim(),
      url: it.url.trim(),
      description: typeof it.description === 'string' ? it.description.trim() : '',
      order: typeof it.order === 'number' ? it.order : 0,
      tags: Array.isArray(it.tags) ? it.tags.filter(t => typeof t === 'string') : []
    }))
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
  // Tolak URL yang cuma protocol tanpa host
  if (!u.hostname || u.hostname.length < 3) {
    return 'URL tidak punya hostname yang valid.';
  }
  return null;
}

// ===== readLinkPackFile: baca File → object =====
// Return: { ok: true, pack } | { ok: false, errors }
export async function readLinkPackFile(file) {
  if (!file) return { ok: false, errors: ['File tidak diberikan.'] };

  // Cek ekstensi
  const name = (file.name || '').toLowerCase();
  if (!name.endsWith('.json') && !name.endsWith('.recallfox-pack.json')) {
    return { ok: false, errors: ['File harus berekstensi .json atau .recallfox-pack.json.'] };
  }

  // Cek ukuran — maks 5MB (cukup untuk 100 link + metadata)
  if (file.size > 5 * 1024 * 1024) {
    return { ok: false, errors: ['File terlalu besar (maks 5MB).'] };
  }

  // Baca sebagai text
  let text;
  try {
    text = await file.text();
  } catch (e) {
    return { ok: false, errors: ['File tidak dapat dibaca. Pilih file paket JSON yang valid.'] };
  }

  if (!text || text.trim() === '') {
    return { ok: false, errors: ['File kosong.'] };
  }

  // Parse JSON
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: ['JSON rusak: ' + (e.message || 'parse error') + '. Pastikan file JSON valid.'] };
  }

  // Validasi manifest
  return validateLinkPack(raw);
}

// ===== hasImportedPack: cek apakah packId sudah pernah diimpor =====
// Cek dengan tag internal `import-pack:<packId>` di semua item link.
export async function hasImportedPack(packId) {
  if (!packId) return false;
  const tag = PACK_TAG_PREFIX + packId;
  const vault = await getVault();
  return (vault.items || []).some(it =>
    it.type === 'link' && Array.isArray(it.tags) && it.tags.includes(tag)
  );
}

// ===== importLinkPack: import pack → buat folder + N link =====
// options: { asCopy: boolean } — kalau true, folder name diberi suffix " (Salinan)"
// Return: { ok: true, folderId, itemCount } | { ok: false, error }
export async function importLinkPack(pack, options = {}) {
  if (!pack || !pack.folder || !pack.items) {
    return { ok: false, error: 'Pack tidak valid.' };
  }

  const asCopy = !!options.asCopy;
  const packTag = PACK_TAG_PREFIX + pack.packId;

  // 1. Buat folder (group) — type 'link' supaya muncul di chip "Link"
  const folderName = asCopy
    ? pack.folder.name + ' (Salinan)'
    : pack.folder.name;
  const folder = createGroup(folderName, 'link');
  if (pack.folder.color) {
    if (!folder.source) folder.source = {};
    folder.source.folderColor = pack.folder.color;
  }
  // Tag folder juga supaya mudah deteksi
  folder.tags = ['group', packTag];
  if (!folder.source) folder.source = {};
  folder.source.capturedAt = new Date().toISOString();
  folder.source.packId = pack.packId;
  folder.source.packVersion = pack.version;
  folder.source.packName = pack.name;

  // Snapshot vault sebelum — untuk rollback kalau gagal di tengah
  const vaultBefore = await getVault();
  const itemsBeforeCount = (vaultBefore.items || []).length;

  try {
    // 2. Tambah folder ke vault
    await addItem(folder);
    const folderId = folder.id;

    // 3. Tambah setiap item link dengan parentId = folderId
    let imported = 0;
    for (let i = 0; i < pack.items.length; i++) {
      const it = pack.items[i];
      const linkItem = {
        type: 'link',
        title: it.title,
        body: it.url, // body untuk backward compat (search)
        linkUrl: it.url,
        linkTitle: it.title,
        tags: Array.isArray(it.tags) ? [...it.tags, packTag] : [packTag],
        source: {
          capturedAt: new Date().toISOString(),
          packId: pack.packId,
          packItemId: it.id,
          packOrder: typeof it.order === 'number' ? it.order : (i + 1)
        }
      };
      // Set parentId supaya nested di folder
      setParentId(linkItem, folderId);
      // Set order
      if (typeof it.order === 'number') {
        setOrder(linkItem, it.order);
      } else {
        setOrder(linkItem, i + 1);
      }
      // Description → masuk ke body kalau ada (sebagai prefix untuk preview)
      if (it.description) {
        linkItem.body = it.description + '\n\n' + it.url;
      }
      await addItem(linkItem);
      imported++;
    }

    return {
      ok: true,
      folderId,
      folderName,
      itemCount: imported
    };
  } catch (e) {
    // Rollback — hapus folder + semua item yang baru dibuat
    console.error('[RecallFox/link-pack] Import gagal, rollback...', e);
    try {
      const vaultNow = await getVault();
      const newItems = (vaultNow.items || []).slice(itemsBeforeCount);
      const idsToRemove = new Set([folder.id, ...newItems.map(it => it.id).filter(id => id)]);
      vaultNow.items = (vaultNow.items || []).filter(it => !idsToRemove.has(it.id));
      await saveVault(vaultNow);
      console.log('[RecallFox/link-pack] Rollback berhasil, ' + idsToRemove.size + ' item dihapus.');
    } catch (rollbackErr) {
      console.error('[RecallFox/link-pack] Rollback gagal:', rollbackErr);
    }
    return { ok: false, error: e.message || 'Import gagal.' };
  }
}
