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
// v3.20.30: Sharper naming + exclude items-in-folder + include existing folders as movable + regenerate.
//
// v3.20.29: subfolder + reasoning field
// v3.20.30 enhancement (user request):
//   1. "vault yang sudah ada di dalam folder itu tidak menjadi pertimbangan untuk
//      dimasukkan ke folder usulan" → item yang SUDAH punya parentId (sudah di
//      folder) DI-EXCLUDE dari kandidat grouping. Hanya item loose (belum di
//      folder) yang diusulkan ke folder baru.
//   2. "folder yang sudah ada dan berisi vault bisa dipindahkan ke folder yang
//      diusulkan fitur magic" → folder existing (yang berisi item) diberikan ke
//      AI sebagai UNIT yang bisa dipindahkan ke folder baru via field "folderIds".
//   3. "logika harus bisa membaca konteks isi dari vault yang tersimpannya itu
//      tentang apa" → AI diminta baca konteks lebih dalam (title + body + tags +
//      type + purpose + domain) untuk menemukan TEMA utama, lalu kasih nama
//      folder yang SPESIFIK dan MENGAMBARKAN ISI — bukan generik.
//   4. "di modalnya ada refresh — kalau dipencet nama folder yang diusulkan bisa
//      berubah" → tambah parameter `regenerate` (0, 1, 2, ...). Setiap regenerate
//      menambah hint di prompt supaya AI kasih struktur alternatif yang berbeda.
//
// Response format v3:
// [
//   {
//     "name": "Top Folder",
//     "reasoning": "Kenapa folder ini dibuat",
//     "itemIds": ["id1"],            // loose items yang masuk sini
//     "folderIds": ["grp_abc"],      // folder existing yang dipindahkan ke sini (NEW)
//     "children": [                   // subfolder (opsional)
//       {
//         "name": "Sub Folder",
//         "reasoning": "...",
//         "itemIds": ["id2"],
//         "folderIds": ["grp_def"]
//       }
//     ]
//   }
// ]
//
// Backward compat: response v1/v2 (tanpa folderIds) tetap didukung.

export async function aiAutoGroup(items, chatFn, options = {}) {
  if (!items || items.length < 2) return { ok: false, error: 'too_few_items' };
  if (!chatFn) return { ok: false, error: 'no_chat_fn' };

  const regenerate = Math.max(0, parseInt(options.regenerate) || 0);

  // v3.20.30: Candidate = item LOOSE (bukan group, TIDAK punya parentId).
  // Item yang sudah di folder lain TIDAK menjadi pertimbangan — sesuai request user.
  const candidates = items.filter(it => !isGroupItem(it) && !getParentId(it));
  if (candidates.length < 2) return { ok: false, error: 'too_few_items' };

  // v3.20.30: Existing folders yang BERISI item — bisa dipindahkan ke folder baru.
  // Folder kosong tidak masuk pertimbangan (tidak ada kontennya).
  const allFolders = items.filter(it => isGroupItem(it));
  const existingFolders = allFolders.filter(folder => {
    // Hanya folder yang punya minimal 1 child (item atau subfolder)
    return items.some(it => getParentId(it) === folder.id);
  });

  // v3.20.30: Build rich item context — baca konten untuk tema.
  const itemsContext = candidates.map(it => {
    const bodyPreview = (it.body || '').slice(0, 400).replace(/\s+/g, ' ').trim();
    const tags = Array.isArray(it.tags) ? it.tags.filter(t => !t.startsWith('import-pack:')).slice(0, 8) : [];
    const parts = [`- ${it.id} | ${it.type} | ${it.title || 'Untitled'}`];
    if (tags.length > 0) parts.push(`  tags: ${tags.join(', ')}`);
    if (bodyPreview) parts.push(`  preview: ${bodyPreview}`);
    if (it.type === 'link' && it.linkUrl) parts.push(`  url: ${it.linkUrl.slice(0, 150)}`);
    if (it.type === 'context' && it.contextPurpose) parts.push(`  purpose: ${it.contextPurpose}`);
    if (it.type === 'snapshot' && it.snapshotDomain) parts.push(`  domain: ${it.snapshotDomain}`);
    return parts.join('\n');
  }).join('\n');

  // v3.20.30: Build existing folders context — agar AI bisa pindahkan ke folder baru.
  const foldersContext = existingFolders.length > 0
    ? existingFolders.map(folder => {
        // Ambil child items untuk konteks
        const childItems = items.filter(it => getParentId(it) === folder.id);
        const childTitles = childItems.slice(0, 5).map(c => `"${(c.title || 'Untitled').slice(0, 30)}"`).join(', ');
        const childCount = childItems.length;
        return `- FOLDER ${folder.id} | "${folder.title || 'Untitled'}" | ${childCount} item: ${childTitles}${childCount > 5 ? ', ...' : ''}`;
      }).join('\n')
    : '(tidak ada folder existing)';

  // v3.20.30: Naming guidance — sharpen nama folder berdasarkan konteks.
  const namingGuidance = `NAMA FOLDER — WAJIB SPESIFIK DAN MENGGAMBARKAN ISI:
- Baca konteks item (title + body + tags) → temukan TEMA UTAMA → jadikan nama folder
- HINDARI nama generik: "Lain-lain", "Item", "Folder 1", "Misc", "Various"
- HINDARI nama yang terlalu umum: "Coding", "Notes" (terlalu luas — gunakan subkategori)
- GUNAKAN nama yang SPESIFIK dan MENGGAMBARKAN: "React Hooks", "API Design Patterns", "Docker Deployment", "Marketing Copy Templates"
- Nama harus langsung memberi tahu user apa isinya tanpa harus buka folder
- Contoh BAIK: "Vue Composition API", "Express Middleware", "Meeting Notes Q4 2026"
- Contoh BURUK: "Folder A", "Items", "Stuff", "Things"`;

  // v3.20.30: Regenerate hint — supaya AI kasih struktur alternatif yang berbeda.
  const regenerateHint = regenerate > 0
    ? `\n\nPERHATIAN: Ini adalah percobaan ke-${regenerate + 1}. User sudah melihat usulan sebelumnya dan mau alternatif yang BERBEDA. WAJIB:
- Coba kriteria pengelompokan yang BERBEDA dari sebelumnya (mis. kalau sebelumnya by type, sekarang coba by workflow atau by project)
- Berikan nama folder yang BERBEDA — jangan ulang nama yang sama
- Bisa juga ubah jumlah folder (lebih banyak atau lebih sedikit)
- Jika tetap sama, user akan kecewa. Berpikir dari sudut pandang baru.`
    : '';

  const systemPrompt = `Anda adalah asisten organisasi Vault RecallFox yang sangat teliti.

Tugas: Analisis mendalam kumpulan item Vault, lalu usulkan struktur folder OPTIMAL dengan DUKUNGAN SUBFOLDER (nested).

INPUT YANG ANDA TERIMA:
1. "Loose items" — item yang belum di folder mana pun. Ini harus dikelompokkan ke folder baru.
2. "Existing folders" — folder yang sudah ada dan berisi item. Folder-folder ini BISA DIPINDAHKAN ke dalam folder baru yang Anda usulkan (via field "folderIds"). Item di dalam existing folder TIDAK perlu direorganisasi — biarkan tetap di foldernya.

PROSES BERPIKIR WAJIB (lakukan sebelum output):
1. Baca setiap loose item satu per satu — pahami konteksnya dari title + body + tags + type
2. Identifikasi TEMA UTAMA yang muncul dari konteks item (bukan asal kategori umum)
3. Cluster item berdasarkan tema yang paling kuat — kalau tema lemah, cari tema alternatif
4. Pertimbangkan existing folders — apakah cocok dipindahkan ke dalam salah satu folder yang Anda usulkan? Kalau ya, sertakan di "folderIds"
5. Untuk cluster yang item-nya banyak (>5) atau heterogen, pertimbangkan sub-cluster (subfolder)
6. Hindari "cari aman" — kalau item benar-benar unik, masukkan ke "Lainnya" dengan justifikasi
7. Validasi: setiap loose item harus masuk tepat 1 folder/subfolder

${namingGuidance}

ANDA BEBAS MENENTUKAN:
- Jumlah top-level folder (2-8)
- Apakah perlu subfolder (tidak wajib — hanya kalau memang memperjelas struktur)
- Kriteria grouping (by topik, by workflow stage, by domain, by project, by urgency, atau kombinasi)
- Folder existing mana yang mau dipindahkan ke folder baru (bisa semua, sebagian, atau tidak sama sekali)

PERTIMBANGAN STRUKTUR:
- Top-level folder: kategori utama
- Subfolder: sub-kategori yang lebih spesifik
- Setiap folder (top atau sub) minimal 2 unit (item atau folder) — kecuali "Lainnya" boleh 1
- Nama subfolder tidak perlu repeat nama parent

OUTPUT FORMAT (JSON STRICT, tanpa markdown, tanpa penjelasan):
[
  {
    "name": "Nama Top Folder Spesifik",
    "reasoning": "1 kalimat kenapa folder ini dibuat dan kriteria item yang masuk",
    "itemIds": ["id1"],
    "folderIds": ["grp_abc"],
    "children": [
      {
        "name": "Nama Subfolder Spesifik",
        "reasoning": "...",
        "itemIds": ["id2"],
        "folderIds": ["grp_def"]
      }
    ]
  }
]

Aturan output:
- "itemIds" = loose item yang masuk langsung ke folder ini
- "folderIds" = ID folder existing yang DIPINDAHKAN ke folder ini (opsional — kalau tidak ada, hilangkan field)
- "children" = array subfolder (opsional)
- Setiap itemId harus ada di daftar loose items
- Setiap folderId harus ada di daftar existing folders
- Setiap loose item harus masuk tepat 1 tempat
- Setiap existing folder paling banyak masuk 1 tempat (bisa juga tidak dipindahkan)
- Field "reasoning" wajib di setiap folder (top dan sub)
- Output PURE JSON array${regenerateHint}`;

  const userPrompt = `Berikut daftar loose item Vault yang perlu diorganisir, plus existing folders yang bisa dipindahkan.

Total loose item: ${candidates.length}
Total existing folder: ${existingFolders.length}

LOOSE ITEMS (perlu dikelompokkan ke folder baru):
${itemsContext}

EXISTING FOLDERS (bisa dipindahkan ke folder baru via "folderIds"):
${foldersContext}

Analisis mendalam setiap item, temukan tema utama, lalu usulkan struktur folder dengan nama SPESIFIK. Pertimbangkan apakah existing folder cocok dipindahkan ke folder baru. Setiap folder wajib ada field "reasoning". Return JSON array sesuai format di system prompt.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];

  try {
    const result = await chatFn(messages, { maxTokens: 2500 });
    const text = typeof result === 'string' ? result : (result.text || result.content || '');

    // Parse JSON (array atau object {folders:[...]}).
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

    // v3.20.30: Validate + normalize. Item + folder ID sets untuk validasi.
    const itemIdSet = new Set(candidates.map(it => it.id));
    const folderIdSet = new Set(existingFolders.map(it => it.id));
    const assignedItems = new Set();
    const assignedFolders = new Set();

    function normalizeFolder(f, depth) {
      if (!f || typeof f !== 'object') return null;
      if (typeof f.name !== 'string' || f.name.trim() === '') return null;
      const name = f.name.trim().slice(0, 60);
      const reasoning = typeof f.reasoning === 'string' ? f.reasoning.trim().slice(0, 250) : '';
      // Normalize itemIds
      const rawIds = Array.isArray(f.itemIds) ? f.itemIds : [];
      const validIds = [];
      for (const id of rawIds) {
        if (typeof id !== 'string') continue;
        if (!itemIdSet.has(id)) continue;
        if (assignedItems.has(id)) continue;
        validIds.push(id);
        assignedItems.add(id);
      }
      // v3.20.30: Normalize folderIds (existing folders yang dipindahkan ke sini)
      const rawFolderIds = Array.isArray(f.folderIds) ? f.folderIds : [];
      const validFolderIds = [];
      for (const id of rawFolderIds) {
        if (typeof id !== 'string') continue;
        if (!folderIdSet.has(id)) continue;
        if (assignedFolders.has(id)) continue;
        validFolderIds.push(id);
        assignedFolders.add(id);
      }
      // Normalize children (subfolder) — recursive, max depth 2
      let children = [];
      if (depth < 2 && Array.isArray(f.children)) {
        children = f.children
          .map(child => normalizeFolder(child, depth + 1))
          .filter(Boolean);
      }
      return { name, reasoning, itemIds: validIds, folderIds: validFolderIds, children };
    }

    const validGroups = groups
      .map(g => normalizeFolder(g, 1))
      .filter(Boolean);

    // Filter folder kosong (tidak ada itemIds, folderIds, DAN children dengan content).
    function folderHasContent(f) {
      if (f.itemIds.length > 0) return true;
      if (f.folderIds && f.folderIds.length > 0) return true;
      if (f.children && f.children.some(folderHasContent)) return true;
      return false;
    }
    const nonEmptyGroups = validGroups.filter(folderHasContent);

    // Item yang belum di-assign → "Lainnya" (top-level).
    const unassigned = candidates.filter(it => !assignedItems.has(it.id)).map(it => it.id);
    if (unassigned.length > 0) {
      let lainnya = nonEmptyGroups.find(f => /lainnya|other|uncategorized|tidak terkategori/i.test(f.name));
      if (!lainnya) {
        lainnya = {
          name: 'Lainnya',
          reasoning: 'Item yang tidak cocok folder lain setelah analisis',
          itemIds: [],
          folderIds: [],
          children: []
        };
        nonEmptyGroups.push(lainnya);
      }
      lainnya.itemIds.push(...unassigned);
    }

    if (nonEmptyGroups.length === 0) {
      return { ok: false, error: 'no_valid_groups_in_response' };
    }

    // Stats untuk UI.
    function countFolders(fs) {
      let n = 0;
      for (const f of fs) {
        n++;
        if (f.children) n += countFolders(f.children);
      }
      return n;
    }
    function countUnits(fs) {
      let n = 0;
      for (const f of fs) {
        n += f.itemIds.length;
        n += (f.folderIds || []).length;
        if (f.children) n += countUnits(f.children);
      }
      return n;
    }
    const stats = {
      totalTopLevel: nonEmptyGroups.length,
      totalFolders: countFolders(nonEmptyGroups),
      totalUnits: countUnits(nonEmptyGroups),
      totalItems: candidates.length,
      totalExistingFoldersMoved: assignedFolders.size,
      totalExistingFoldersAvailable: existingFolders.length,
      hasSubfolders: nonEmptyGroups.some(f => f.children && f.children.length > 0)
    };

    // v3.20.30: Sertakan info existing folders yang TIDAK dipindahkan — untuk UI.
    const unmovedFolderIds = existingFolders.map(f => f.id).filter(id => !assignedFolders.has(id));

    return {
      ok: true,
      groups: nonEmptyGroups,
      stats,
      unmovedFolderIds,
      regenerate: regenerate
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
