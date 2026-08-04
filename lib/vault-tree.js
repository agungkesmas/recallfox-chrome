// lib/vault-tree.js — v3.18.4: Recursive nested folder support
// Storage: parentId/isGroup/order di item.source (JSONB) — no ALTER TABLE needed.
// Folder bisa berisi folder lagi (nested) — seperti file manager.

// ===== Schema helpers =====

export function getParentId(item) {
  return item?.source?.parentId || null;
}

export function setParentId(item, parentId) {
  if (!item.source) item.source = {};
  item.source.parentId = parentId || null;
}

export function isGroupItem(item) {
  return !!(item?.source?.isGroup);
}

export function getGroupType(item) {
  return item?.source?.groupType || item?.type || null;
}

export function getOrder(item) {
  return item?.source?.order || 0;
}

export function setOrder(item, order) {
  if (!item.source) item.source = {};
  item.source.order = order;
}

// ===== Create group =====

export function createGroup(name, type) {
  const id = 'grp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  return {
    id,
    type: type || 'prompt',
    title: name || 'Grup Baru',
    body: '',
    tags: ['group'],
    category: 'group',
    source: {
      isGroup: true,
      groupType: type || 'prompt',
      capturedAt: new Date().toISOString(),
      device: 'addon'
    },
    favorite: false,
    archived: false,
    useCount: 0,
    lastUsedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

// ===== Build tree dari flat items — RECURSIVE (nested folders) =====
// v3.18.4: Folder bisa berisi folder lagi. buildTree sekarang recursive.
//
// @param items - flat array of all vault items
// @param expandedIds - array of group IDs yang sedang di-expand
// @param categoryFilter - 'prompt' | 'link' | 'screenshot' | null (null = "Semua")
// @param showGroups - bool (ignored, selalu true sejak v3.18.2)
// @returns array of nodes: { kind: 'group'|'item', item, isExpanded, children: [node...] }

export function buildTree(items, expandedIds, categoryFilter, showGroups, sortMode) {
  // v3.19.0: sortMode — 'recent'|'name'|'oldest'|'uses'|'fav' (default: 'recent')
  const sm = sortMode || 'recent';
  // v3.18.4: Build index
  const allByParent = new Map();
  const topLevel = [];

  // v3.19.9 FIX: Build set of all item IDs untuk cek orphan children.
  // Item dengan parentId ke folder yang TIDAK ADA di items array = orphan.
  // Orphan children harus tampil sebagai top-level (jangan hilangkan).
  const allIds = new Set(items.map(it => it.id));

  for (const it of items) {
    const pid = getParentId(it);
    if (pid && allIds.has(pid)) {
      // Parent exists — item masuk ke parent map
      if (!allByParent.has(pid)) allByParent.set(pid, []);
      allByParent.get(pid).push(it);
    } else {
      // No parent OR parent doesn't exist (orphan) → top-level
      topLevel.push(it);
    }
  }

  // v3.19.0: Sort function berdasarkan sortMode
  function sortByMode(a, b) {
    // Groups always first
    const ag = isGroupItem(a) ? 0 : 1;
    const bg = isGroupItem(b) ? 0 : 1;
    if (ag !== bg) return ag - bg;
    // Both groups or both items — sort by mode
    if (sm === 'name') return (a.title || '').localeCompare(b.title || '');
    if (sm === 'oldest') return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
    if (sm === 'uses') return (b.useCount || 0) - (a.useCount || 0);
    if (sm === 'fav') return ((b.favorite ? 1 : 0) - (a.favorite ? 1 : 0)) || (new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    // default: recent (newest first)
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  }

  // Filter top-level by category
  const filteredTopLevel = topLevel.filter(it => {
    if (!categoryFilter) return true;
    if (isGroupItem(it)) return getGroupType(it) === categoryFilter;
    return it.type === categoryFilter ||
      (categoryFilter === 'screenshot' && it.type === 'document');
  });

  // Sort by mode
  filteredTopLevel.sort(sortByMode);

  // Recursive build
  function buildNode(it) {
    if (isGroupItem(it)) {
      // Group: cek apakah match categoryFilter
      if (categoryFilter && getGroupType(it) !== categoryFilter) return null;

      // Get all children (items + sub-groups) — sort by mode
      let children = (allByParent.get(it.id) || []).sort(sortByMode);

      // Filter children by category (hanya item biasa, bukan sub-group)
      if (categoryFilter) {
        children = children.filter(c =>
          isGroupItem(c) ||  // sub-groups selalu tampil
          c.type === categoryFilter ||
          (categoryFilter === 'screenshot' && c.type === 'document')
        );
      }

      // v3.18.2: Jangan skip empty groups di "Semua" (categoryFilter=null)
      if (categoryFilter && children.length === 0) return null;

      return {
        kind: 'group',
        item: it,
        isExpanded: expandedIds.includes(it.id),
        children: children.map(buildNode).filter(Boolean)
      };
    } else {
      // Regular item
      if (categoryFilter &&
          it.type !== categoryFilter &&
          !(categoryFilter === 'screenshot' && it.type === 'document')) return null;
      return { kind: 'item', item: it };
    }
  }

  return filteredTopLevel.map(buildNode).filter(Boolean);
}

// ===== AI Auto Group (Magic Folder) =====
// v3.20.28: Fix bug "messages: Invalid input: expected array, received string" +
// enhance AI reasoning untuk optimal folder structure.
//
// Bug sebelumnya: aiAutoGroup pass string prompt ke chatFn (chatWithFallback),
// padahal chatWithFallback expect array of {role, content}. OpenAI-compatible
// API reject dengan 422 → user see error toast.
//
// Fix Step 1: pass proper array [{role:'system', content}, {role:'user', content}]
// Fix Step 2: system prompt dirubah supaya AI bebas reasoning tentang struktur
//   folder optimal (jumlah folder, nama, kriteria grouping) — tidak di-hardcode.

export async function aiAutoGroup(items, chatFn) {
  if (!items || items.length < 2) return { ok: false, error: 'too_few_items' };
  if (!chatFn) return { ok: false, error: 'no_chat_fn' };

  const candidates = items.filter(it => !isGroupItem(it));
  if (candidates.length < 2) return { ok: false, error: 'too_few_items' };

  // v3.20.28: Build rich item context supaya AI bisa reasoning lebih baik.
  // Sebelumnya: hanya id + title + type. Sekarang: + body preview (150 char) + tags.
  const itemsContext = candidates.map(it => {
    const bodyPreview = (it.body || '').slice(0, 150).replace(/\s+/g, ' ').trim();
    const tags = Array.isArray(it.tags) ? it.tags.filter(t => !t.startsWith('import-pack:')).slice(0, 5) : [];
    const parts = [`- ${it.id} | ${it.type} | ${it.title || 'Untitled'}`];
    if (tags.length > 0) parts.push(`  tags: ${tags.join(', ')}`);
    if (bodyPreview) parts.push(`  preview: ${bodyPreview}`);
    if (it.type === 'link' && it.linkUrl) parts.push(`  url: ${it.linkUrl.slice(0, 100)}`);
    return parts.join('\n');
  }).join('\n');

  // v3.20.28: System prompt — AI reasoning untuk optimal folder structure.
  // AI bebas menentukan: jumlah folder (2-8), nama, kriteria grouping.
  const systemPrompt = `Anda adalah asisten organisasi Vault RecallFox.

Tugas: Analisis kumpulan item Vault (prompt, konteks, link, snapshot, catatan) lalu usulkan struktur folder OPTIMAL untuk mengelompokkannya.

Anda BEBAS menentukan:
- Jumlah folder (antara 2-8 folder)
- Nama folder (deskriptif, singkat, profesional — maksimal 30 char)
- Kriteria pengelompokan (by topik, by type, by workflow, by domain, by urgency, atau kombinasi — yang paling masuk akal untuk item yang diberikan)

Pertimbangan untuk struktur terbaik:
1. Setiap folder minimal 2 item (jangan buat folder dengan 1 item — gabungkan ke "Lainnya")
2. Item yang tidak jelas → masukkan ke folder "Lainnya"
3. Nama folder self-explanatory
4. Hindari overlap — setiap item hanya masuk 1 folder
5. Pertimbangkan tags sebagai sinyal grouping

Output: JSON STRICT (tanpa markdown, tanpa penjelasan) dengan format:
[{"name":"Nama Folder","itemIds":["id1","id2"]}]

WAJIB:
- Setiap itemId harus ada di daftar item yang diberikan
- Setiap item harus masuk tepat 1 folder
- Output PURE JSON array, tidak ada text sebelum/sesudah [ ]`;

  const userPrompt = `Berikut daftar item Vault yang perlu diorganisir ke folder optimal.

Total item: ${candidates.length}

Item list:
${itemsContext}

Analisis konteks setiap item (title, body preview, tags, type) lalu usulkan struktur folder terbaik. Return JSON array sesuai format di system prompt.`;

  // v3.20.28 Step 1: pass ARRAY of {role, content} — bukan string.
  // Ini fix bug "messages: Invalid input: expected array, received string".
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];

  try {
    const result = await chatFn(messages, { maxTokens: 1200 });
    const text = typeof result === 'string' ? result : (result.text || result.content || '');
    // v3.20.28: Cari JSON array — fallback ke JSON object {folders: [...]}
    let jsonStr = null;
    let groups = null;
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        groups = JSON.parse(arrayMatch[0]);
      } catch (e) {}
    }
    if (!groups) {
      // Coba format object {folders: [...]}
      const objMatch = text.match(/\{[\s\S]*\}/);
      if (objMatch) {
        try {
          const obj = JSON.parse(objMatch[0]);
          if (obj && Array.isArray(obj.folders)) groups = obj.folders;
          else if (obj && Array.isArray(obj.groups)) groups = obj.groups;
        } catch (e) {}
      }
    }
    if (!groups || !Array.isArray(groups)) {
      return { ok: false, error: 'no_valid_json_in_response' };
    }
    // Validate: setiap group punya name + itemIds array
    const validGroups = groups.filter(g =>
      g && typeof g.name === 'string' && g.name.trim() &&
      Array.isArray(g.itemIds) && g.itemIds.length > 0
    ).map(g => ({
      name: g.name.trim().slice(0, 60),
      itemIds: g.itemIds.filter(id => typeof id === 'string')
    }));
    if (validGroups.length === 0) {
      return { ok: false, error: 'no_valid_groups_in_response' };
    }
    return { ok: true, groups: validGroups };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
