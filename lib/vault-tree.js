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
// v3.20.29: Deep AI reasoning + subfolder (nested) support + per-folder reasoning.
//
// v3.20.28 fix: payload array (bug "messages: expected array, received string").
// v3.20.29 enhancement:
//   - AI diminta berpikir teliti: baca konteks tiap item, cluster, sub-cluster
//   - AI bebas usulkan subfolder (nested) — tidak cuma flat 1 level
//   - Setiap folder punya field "reasoning" (kenapa folder ini dibuat)
//   - Body preview diperpanjang 150→300 char supaya AI lebih teliti
//   - AI diminta hindari "cari aman" — kalau item tidak cocok, kelompokkan
//     dengan justifikasi, bukan asal masukkan ke "Lainnya"
//
// Response format v2 (nested):
// [
//   {
//     "name": "Top Folder",
//     "reasoning": "Kenapa folder ini dibuat",
//     "itemIds": ["id1"],            // item langsung di folder ini (opsional)
//     "children": [                   // subfolder (opsional)
//       {
//         "name": "Sub Folder",
//         "reasoning": "...",
//         "itemIds": ["id2", "id3"]
//       }
//     ]
//   }
// ]
//
// Backward compat: response v1 (flat, tanpa children) tetap didukung.

export async function aiAutoGroup(items, chatFn) {
  if (!items || items.length < 2) return { ok: false, error: 'too_few_items' };
  if (!chatFn) return { ok: false, error: 'no_chat_fn' };

  const candidates = items.filter(it => !isGroupItem(it));
  if (candidates.length < 2) return { ok: false, error: 'too_few_items' };

  // v3.20.29: Body preview diperpanjang ke 300 char supaya AI lebih teliti.
  // Sebelumnya 150 char — AI sering "cari aman" karena konteks tidak cukup.
  const itemsContext = candidates.map(it => {
    const bodyPreview = (it.body || '').slice(0, 300).replace(/\s+/g, ' ').trim();
    const tags = Array.isArray(it.tags) ? it.tags.filter(t => !t.startsWith('import-pack:')).slice(0, 8) : [];
    const parts = [`- ${it.id} | ${it.type} | ${it.title || 'Untitled'}`];
    if (tags.length > 0) parts.push(`  tags: ${tags.join(', ')}`);
    if (bodyPreview) parts.push(`  preview: ${bodyPreview}`);
    if (it.type === 'link' && it.linkUrl) parts.push(`  url: ${it.linkUrl.slice(0, 150)}`);
    if (it.type === 'context' && it.contextPurpose) parts.push(`  purpose: ${it.contextPurpose}`);
    if (it.type === 'snapshot' && it.snapshotDomain) parts.push(`  domain: ${it.snapshotDomain}`);
    return parts.join('\n');
  }).join('\n');

  // v3.20.29: System prompt — deep reasoning + nested folder support.
  // AI diminta berpikir bertahap: analisis → cluster → sub-cluster → justifikasi.
  const systemPrompt = `Anda adalah asisten organisasi Vault RecallFox yang sangat teliti.

Tugas: Analisis mendalam kumpulan item Vault, lalu usulkan struktur folder OPTIMAL dengan DUKUNGAN SUBFOLDER (nested).

PROSES BERPIKIR WAJIB (lakukan sebelum output):
1. Baca setiap item satu per satu — pahami konteksnya dari title + body + tags + type
2. Identifikasi pola/kategori yang muncul dari konteks item (bukan asal kategori umum)
3. Cluster item berdasarkan pola yang paling kuat — kalau pola lemah, cari pola alternatif
4. Untuk cluster yang item-nya banyak (>5) atau heterogen, pertimbangkan sub-cluster (subfolder)
5. Hindari "cari aman" — kalau item benar-benar unik, masukkan ke "Lainnya" dengan justifikasi, bukan asal kelompokkan
6. Validasi: setiap item harus masuk tepat 1 folder/subfolder, tidak ada yang hilang

ANDA BEBAS MENENTUKAN:
- Jumlah top-level folder (2-8)
- Apakah perlu subfolder (tidak wajib — hanya kalau memang memperjelas struktur)
- Kriteria grouping (by topik, by type, by workflow stage, by domain, by urgency, by project, atau kombinasi — yang paling masuk akal setelah analisis)
- Nama folder (deskriptif, spesifik, profesional — maksimal 35 char, hindari nama generik seperti "Lain-lain" kecuali benar-benar perlu)

PERTIMBANGAN STRUKTUR:
- Top-level folder: kategori utama (mis. "Coding", "Marketing", "Referensi")
- Subfolder: sub-kategori yang lebih spesifik (mis. di dalam "Coding" → "Frontend", "Backend", "DevOps")
- Setiap folder (top atau sub) minimal 2 item — kecuali "Lainnya" boleh 1 item
- Hindari folder dengan 1 item — gabungkan ke parent atau "Lainnya"
- Nama subfolder tidak perlu repeat nama parent (mis. "Frontend" bukan "Coding/Frontend")

OUTPUT FORMAT (JSON STRICT, tanpa markdown, tanpa penjelasan):
[
  {
    "name": "Nama Top Folder",
    "reasoning": "1 kalimat kenapa folder ini dibuat dan kriteria item yang masuk",
    "itemIds": ["id1"],
    "children": [
      {
        "name": "Nama Subfolder",
        "reasoning": "1 kalimat kenapa subfolder ini dibuat",
        "itemIds": ["id2", "id3"]
      }
    ]
  }
]

Aturan output:
- "itemIds" di top-level folder = item yang langsung di folder itu (bukan di subfolder)
- "children" = array subfolder (opsional — kalau folder tidak perlu subfolder, hilangkan field "children")
- Setiap itemId harus ada di daftar item yang diberikan
- Setiap item harus masuk tepat 1 tempat (top-level itemIds ATAU subfolder itemIds)
- Total item di output = total item yang diberikan
- Output PURE JSON array, tidak ada text sebelum/sesudah [ ]
- Field "reasoning" wajib di setiap folder (top dan sub)`;

  const userPrompt = `Berikut daftar item Vault yang perlu diorganisir ke struktur folder optimal (dengan subfolder kalau perlu).

Total item: ${candidates.length}

Item list:
${itemsContext}

Analisis mendalam setiap item, cluster berdasarkan pola konteks yang paling kuat, lalu usulkan struktur folder (boleh dengan subfolder kalau memperjelas). Setiap folder wajib ada field "reasoning". Return JSON array sesuai format di system prompt.`;

  // v3.20.28 Step 1: pass ARRAY of {role, content} — bukan string.
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];

  try {
    // v3.20.29: maxTokens dinaikkan 1200→2000 supaya AI bisa reasoning + nested.
    const result = await chatFn(messages, { maxTokens: 2000 });
    const text = typeof result === 'string' ? result : (result.text || result.content || '');

    // v3.20.29: Parse JSON (array atau object {folders:[...]}).
    let groups = null;
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try { groups = JSON.parse(arrayMatch[0]); } catch (e) {}
    }
    if (!groups) {
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

    // v3.20.29: Validate + normalize nested groups.
    // Item ID set untuk validasi.
    const itemIdSet = new Set(candidates.map(it => it.id));
    const assignedItems = new Set();

    function normalizeFolder(f, depth) {
      if (!f || typeof f !== 'object') return null;
      if (typeof f.name !== 'string' || f.name.trim() === '') return null;
      const name = f.name.trim().slice(0, 60);
      const reasoning = typeof f.reasoning === 'string' ? f.reasoning.trim().slice(0, 200) : '';
      // Normalize itemIds — filter yang valid + belum di-assign
      const rawIds = Array.isArray(f.itemIds) ? f.itemIds : [];
      const validIds = [];
      for (const id of rawIds) {
        if (typeof id !== 'string') continue;
        if (!itemIdSet.has(id)) continue;
        if (assignedItems.has(id)) continue;
        validIds.push(id);
        assignedItems.add(id);
      }
      // Normalize children (subfolder) — recursive, max depth 2 (top + 1 level sub)
      let children = [];
      if (depth < 2 && Array.isArray(f.children)) {
        children = f.children
          .map(child => normalizeFolder(child, depth + 1))
          .filter(Boolean);
      }
      return { name, reasoning, itemIds: validIds, children };
    }

    const validGroups = groups
      .map(g => normalizeFolder(g, 1))
      .filter(Boolean);

    // v3.20.29: Filter folder kosong (tidak ada itemIds DAN tidak ada children dengan item).
    function folderHasContent(f) {
      if (f.itemIds.length > 0) return true;
      if (f.children && f.children.some(folderHasContent)) return true;
      return false;
    }
    const nonEmptyGroups = validGroups.filter(folderHasContent);

    // v3.20.29: Item yang belum di-assign → masukkan ke "Lainnya" (top-level).
    const unassigned = candidates.filter(it => !assignedItems.has(it.id)).map(it => it.id);
    if (unassigned.length > 0) {
      let lainnya = nonEmptyGroups.find(f => /lainnya|other|uncategorized|tidak terkategori/i.test(f.name));
      if (!lainnya) {
        lainnya = {
          name: 'Lainnya',
          reasoning: 'Item yang tidak cocok folder lain setelah analisis',
          itemIds: [],
          children: []
        };
        nonEmptyGroups.push(lainnya);
      }
      lainnya.itemIds.push(...unassigned);
    }

    if (nonEmptyGroups.length === 0) {
      return { ok: false, error: 'no_valid_groups_in_response' };
    }

    // v3.20.29: Stats untuk UI — total folder (top + sub), total item, max depth.
    function countFolders(fs) {
      let n = 0;
      for (const f of fs) {
        n++;
        if (f.children) n += countFolders(f.children);
      }
      return n;
    }
    function countItems(fs) {
      let n = 0;
      for (const f of fs) {
        n += f.itemIds.length;
        if (f.children) n += countItems(f.children);
      }
      return n;
    }
    const stats = {
      totalTopLevel: nonEmptyGroups.length,
      totalFolders: countFolders(nonEmptyGroups),
      totalItems: countItems(nonEmptyGroups),
      hasSubfolders: nonEmptyGroups.some(f => f.children && f.children.length > 0)
    };

    return { ok: true, groups: nonEmptyGroups, stats };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
