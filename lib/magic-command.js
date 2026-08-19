// lib/magic-command.js — v3.20.32: AI-powered natural language command untuk vault
//
// Fitur: User ketik perintah natural language seperti:
//   - "Masukkan link MDN, GitHub Docs, dan React docs ke folder Referensi"
//   - "Pindahkan semua prompt React ke folder Frontend"
//   - "Bikin folder Coding, masukkan prompt Express + Vue ke situ"
//
// AI akan:
//   1. Parse intent (move items to folder / create folder + move)
//   2. Find matching items di vault (by title, URL, tags, body)
//   3. Find or create target folder
//   4. Return action plan: { folderName, folderId?, itemIds, createFolder }
//
// User preview → confirm → apply (move items via setParentId).

import { isGroupItem, getParentId, setParentId, createGroup } from './vault-tree.js';

const MAX_ITEMS_CONTEXT = 100;  // batasi supaya payload tidak terlalu besar
const MAX_BODY_PREVIEW = 150;

// ===== parseMagicCommand: kirim command ke AI, return action plan =====
// items: full vault items (loose + in-folder + folders)
// chatFn: chatWithFallback
// command: string perintah user
// Return: { ok: true, plan } | { ok: false, error }
//   plan: {
//     action: 'move' | 'create-and-move',
//     folderName: string,           // target folder name
//     folderId: string | null,      // ID kalau folder existing, null kalau perlu create
//     itemIds: string[],            // item yang akan dipindahkan
//     reasoning: string,            // kenapa AI pilih item ini
//     unmatched: string[]           // query yang tidak match (opsional)
//   }
export async function parseMagicCommand(items, chatFn, command) {
  // v3.20.43: Delegate ke parseMultiStepCommand untuk backward compat.
  // parseMultiStepCommand selalu return array of plans ( bahkan kalau cuma 1 step).
  // Untuk backward compat, kalau hanya 1 step, return plan langsung.
  const result = await parseMultiStepCommand(items, chatFn, command);
  if (!result.ok) return result;
  if (result.steps.length === 0) return { ok: false, error: 'no_steps_parsed' };
  if (result.steps.length === 1) return { ok: true, plan: result.steps[0] };
  // Multi-step: return array supaya caller bisa handle
  return { ok: true, multiStep: true, steps: result.steps, plan: result.steps[0] };
}

// v3.20.43: parseMultiStepCommand — support perintah multi-step (2-3 langkah)
// User bisa ketik: "buat folder X dan pindahkan semua foto ke folder X kemudian arsipkan"
// AI akan parse menjadi array of action plans.
//
// Return: { ok: true, steps: [plan1, plan2, ...] } | { ok: false, error }
export async function parseMultiStepCommand(items, chatFn, command) {
  if (!items || items.length < 1) return { ok: false, error: 'too_few_items' };
  if (!chatFn) return { ok: false, error: 'no_chat_fn' };
  if (!command || typeof command !== 'string' || command.trim().length < 3) {
    return { ok: false, error: 'command_too_short' };
  }

  const cmd = command.trim().slice(0, 500);

  // Build item context — hanya item loose + existing folders.
  // Item yang sudah di folder tidak bisa dipindah (user bisa pindah folder-nya langsung).
  const looseItems = items.filter(it => !isGroupItem(it) && !it.archived);
  const existingFolders = items.filter(it => isGroupItem(it) && !it.archived);
  // v3.20.33: archived folders juga di-include supaya AI bisa pilih untuk action "restore-folder"
  const archivedFolders = items.filter(it => isGroupItem(it) && it.archived);

  const itemContext = looseItems.slice(0, MAX_ITEMS_CONTEXT).map(it => {
    const bodyPreview = (it.body || '').slice(0, MAX_BODY_PREVIEW).replace(/\s+/g, ' ').trim();
    const tags = Array.isArray(it.tags) ? it.tags.filter(t => !t.startsWith('import-pack:')).slice(0, 5) : [];
    const parts = [`- ${it.id} | ${it.type} | ${it.title || 'Untitled'}`];
    if (tags.length > 0) parts.push(`  tags: ${tags.join(', ')}`);
    if (bodyPreview) parts.push(`  preview: ${bodyPreview}`);
    if (it.type === 'link' && it.linkUrl) parts.push(`  url: ${it.linkUrl.slice(0, 100)}`);
    return parts.join('\n');
  }).join('\n');

  const folderContext = existingFolders.length > 0
    ? existingFolders.map(f => `- FOLDER ${f.id} | "${f.title || 'Untitled'}"`).join('\n')
    : '(tidak ada folder existing)';

  // v3.20.33: Archived folder context — untuk action restore-folder
  const archivedFolderContext = archivedFolders.length > 0
    ? archivedFolders.map(f => `- ARCHIVED_FOLDER ${f.id} | "${f.title || 'Untitled'}"`).join('\n')
    : '(tidak ada folder yang ter-arsip)';

  const systemPrompt = `Anda adalah asisten RecallFox yang membantu user mengorganisir item Vault via perintah natural language.

Tugas: Parse perintah user, identifikasi intent + item/folder yang terlibat, lalu return array of action plans.

INPUT:
1. "Loose items" — item yang belum di folder (bisa dipindahkan)
2. "Existing folders" — folder yang sudah ada (bisa jadi tujuan, atau user minta buat folder baru)
3. "Command" — perintah user dalam bahasa natural

INTENT YANG DIDUKUNG (pilih untuk setiap step):
- "move" — pindahkan item ke folder yang sudah ada (folderId di-set)
- "create-and-move" — buat folder baru + pindahkan item (folderId null)
- "archive-folder" — arsipkan folder + semua isinya (butuh folderId)
- "restore-folder" — restore folder yang sudah di-arsip (butuh folderId, cari di archived folders)
- "add-tag" — tambahkan tag ke beberapa item (butuh tagName + itemIds)
- "remove-tag" — hapus tag dari beberapa item (butuh tagName + itemIds)
- "archive-items" — arsipkan item-item tertentu (bukan folder, tapi item loose). itemIds di-set, folderId null.
- "delete-items" — hapus item-item tertentu. itemIds di-set, folderId null.

MULTI-STEP SUPPORT (v3.20.43):
Perintah user BISA mengandung beberapa langkah yang dihubungkan dengan kata:
  "kemudian", "lalu", "setelah itu", "lalu", ", kemudian", ";"
Contoh multi-step:
  - "buat folder Coding dan pindahkan semua prompt programming ke folder Coding kemudian arsipkan folder Lama"
    → Step 1: create-and-move (folder Coding, items = prompt programming)
    → Step 2: archive-folder (folder Lama)
  - "cari semua link dengan tag penting dan arsipkan"
    → Step 1: archive-items (items = link dengan tag penting)
  - "pindahkan semua screenshot ke folder Media, lalu tambahkan tag favorit"
    → Step 1: move/create-and-move (folder Media, items = screenshots)
    → Step 2: add-tag (tagName = favorit, items = screenshots yang sama)

PENTING UNTUK MULTI-STEP:
- Setiap step HARUS independen — bisa dieksekusi berurutan tanpa dependency pada step sebelumnya.
- Kalau step 2 butuh folder yang dibuat di step 1, step 2 bisa reference folderName (bukan folderId, karena folder belum ada saat parse). AI tetap return folderName untuk step 2, dan executor akan cari folder by name setelah step 1 selesai.
- Kalau step 2 butuh items yang dipindahkan di step 1, step 2 bisa reference itemIds yang sama.
- Maksimal 5 steps.

PROSES:
1. Pahami intent utama dari perintah user:
   - "pindahkan/masukkan ke folder X" → move atau create-and-move
   - "arsipkan folder X" → archive-folder
   - "arsipkan item-item X" → archive-items
   - "hapus item-item X" → delete-items
   - "restore/keluarkan folder X dari arsip" → restore-folder
   - "tambahkan tag Y ke semua link" → add-tag
   - "hapus tag Y dari ..." → remove-tag
2. Cari item yang cocok dengan deskripsi user (match by title, URL, tags, type, body preview). Bisa multiple items.
3. Kalau user sebut nama folder yang sudah ada → pakai folder itu (set folderId)
4. Kalau user sebut nama folder yang belum ada → set createFolder=true, folderId=null
5. Kalau ada item yang tidak match deskripsi user → masukkan ke "unmatched" (jangan asal pilih)

MATCHING RULES:
- Match berdasarkan kemiripan makna, bukan exact string. Mis. user bilang "link dokumentasi" → match item link yang URL-nya docs/MDN/dll.
- Bisa match multiple item sekaligus. Mis. "semua prompt React" → match semua prompt yang tags/body mengandung React.
- Kalau user sebut spesifik (mis. "MDN"), match exact. Kalau umum (mis. "link"), match semua link.
- Jangan masukkan item yang user tidak sebut, kecuali kalau user minta "semua" + kategori.

OUTPUT FORMAT (JSON STRICT):
{
  "steps": [
    {
      "action": "move" | "create-and-move" | "archive-folder" | "restore-folder" | "add-tag" | "remove-tag" | "archive-items" | "delete-items",
      "folderName": "Nama Folder Tujuan" | null,
      "folderId": "grp_xxx" | null,
      "itemIds": ["id1", "id2"],
      "tagName": "namatag" | null,
      "reasoning": "1 kalimat penjelasan kenapa AI pilih action + item ini",
      "unmatched": []
    }
  ]
}

Aturan per action:
- "move": folderId wajib di-set (folder existing). folderName = nama folder existing.
- "create-and-move": folderId null, folderName = nama folder baru yang user sebut.
- "archive-folder": folderId wajib (folder existing yang akan di-arsip). itemIds kosong [].
- "restore-folder": folderId wajib (folder yang sudah archived). itemIds kosong [].
- "add-tag": tagName wajib. itemIds = item yang akan di-tag. folderName/folderId null.
- "remove-tag": tagName wajib. itemIds = item yang akan di-untag. folderName/folderId null.
- "archive-items": itemIds wajib (item loose yang akan di-arsip). folderName/folderId null.
- "delete-items": itemIds wajib (item loose yang akan dihapus). folderName/folderId null.

- "unmatched": array string query user yang tidak match (opsional, kosong kalau semua match).
- "steps": array berisi 1 atau lebih action plans. Selalu array, bahkan kalau cuma 1 step.
- Output PURE JSON, tidak ada text sebelum/sesudah { }`;

  const userPrompt = `Perintah user:
"""
${cmd}
"""

LOOSE ITEMS (bisa dipindahkan / di-tag / di-arsip / dihapus):
${itemContext}

EXISTING FOLDERS (bisa jadi tujuan / di-arsip):
${folderContext}

ARCHIVED FOLDERS (bisa di-restore):
${archivedFolderContext}

Parse perintah user. Kalau perintah mengandung multiple langkah (dihubungkan "kemudian", "lalu", "setelah itu", ",", ";"), pecah menjadi multiple steps. Return JSON dengan format { "steps": [...] } sesuai system prompt.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];

  try {
    const result = await chatFn(messages, { maxTokens: 2000 });
    const text = typeof result === 'string' ? result : (result.text || result.content || '');

    // Parse JSON object.
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (!objMatch) {
      return { ok: false, error: 'no_valid_json_in_response' };
    }
    let parsed;
    try {
      parsed = JSON.parse(objMatch[0]);
    } catch (e) {
      return { ok: false, error: 'json_parse_failed: ' + e.message };
    }

    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, error: 'invalid_response_format' };
    }

    // v3.20.43: Support both { steps: [...] } and single plan (backward compat)
    let rawSteps = [];
    if (Array.isArray(parsed.steps)) {
      rawSteps = parsed.steps;
    } else if (parsed.action) {
      // Single plan (old format) — wrap in array
      rawSteps = [parsed];
    } else {
      return { ok: false, error: 'no_steps_or_action_in_response' };
    }

    if (rawSteps.length === 0) {
      return { ok: false, error: 'empty_steps' };
    }
    if (rawSteps.length > 5) {
      // Cap at 5 steps for safety
      rawSteps = rawSteps.slice(0, 5);
    }

    // Validate each step
    const validActions = ['move', 'create-and-move', 'archive-folder', 'restore-folder', 'add-tag', 'remove-tag', 'archive-items', 'delete-items'];
    const existingFolderIdSet = new Set(existingFolders.map(f => f.id));
    const archivedFolderIdSet = new Set(archivedFolders.map(f => f.id));
    const looseIdSet = new Set(looseItems.map(it => it.id));

    const validatedSteps = [];
    for (let i = 0; i < rawSteps.length; i++) {
      const step = rawSteps[i];
      if (!step || typeof step !== 'object') continue;
      if (!validActions.includes(step.action)) {
        console.warn('[RecallFox/MagicCmd] Step', i, 'invalid action:', step.action, '— skipping');
        continue;
      }

      let folderId = null;
      let folderName = step.folderName;
      let tagName = step.tagName;

      if (step.action === 'move') {
        if (typeof step.folderId !== 'string' || !existingFolderIdSet.has(step.folderId)) {
          step.action = 'create-and-move';
        } else {
          folderId = step.folderId;
        }
      } else if (step.action === 'archive-folder') {
        if (typeof step.folderId !== 'string' || !existingFolderIdSet.has(step.folderId)) {
          console.warn('[RecallFox/MagicCmd] Step', i, 'archive-folder: invalid folderId — skipping');
          continue;
        }
        folderId = step.folderId;
      } else if (step.action === 'restore-folder') {
        if (typeof step.folderId !== 'string' || !archivedFolderIdSet.has(step.folderId)) {
          console.warn('[RecallFox/MagicCmd] Step', i, 'restore-folder: invalid folderId — skipping');
          continue;
        }
        folderId = step.folderId;
      } else if (step.action === 'add-tag' || step.action === 'remove-tag') {
        if (typeof tagName !== 'string' || tagName.trim() === '') {
          console.warn('[RecallFox/MagicCmd] Step', i, step.action, 'missing tagName — skipping');
          continue;
        }
        tagName = tagName.trim().slice(0, 50);
      }

      if ((step.action === 'move' || step.action === 'create-and-move') &&
          (typeof folderName !== 'string' || folderName.trim() === '')) {
        console.warn('[RecallFox/MagicCmd] Step', i, step.action, 'missing folderName — skipping');
        continue;
      }
      if (typeof folderName === 'string') {
        folderName = folderName.trim().slice(0, 60);
      }

      const needsItems = ['move', 'create-and-move', 'add-tag', 'remove-tag', 'archive-items', 'delete-items'].includes(step.action);
      let validItemIds = [];
      if (needsItems) {
        if (!Array.isArray(step.itemIds) || step.itemIds.length === 0) {
          console.warn('[RecallFox/MagicCmd] Step', i, step.action, 'no itemIds — skipping');
          continue;
        }
        validItemIds = step.itemIds.filter(id => typeof id === 'string' && looseIdSet.has(id));
        if (validItemIds.length === 0) {
          console.warn('[RecallFox/MagicCmd] Step', i, step.action, 'no valid itemIds — skipping');
          continue;
        }
      }

      validatedSteps.push({
        action: step.action,
        folderName: folderName || null,
        folderId,
        itemIds: validItemIds,
        tagName: tagName || null,
        reasoning: typeof step.reasoning === 'string' ? step.reasoning.trim().slice(0, 250) : '',
        unmatched: Array.isArray(step.unmatched) ? step.unmatched.filter(s => typeof s === 'string').slice(0, 10) : []
      });
    }

    if (validatedSteps.length === 0) {
      return { ok: false, error: 'no_valid_steps' };
    }

    return { ok: true, steps: validatedSteps };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ===== applyMagicCommand: apply action plan ke vault =====
// items: full vault items
// plan: dari parseMagicCommand
// groupType: type folder baru (default 'prompt')
// Return: { ok: true, folderId?, itemsMoved?, itemsTagged?, archivedCount? } | { ok: false, error }
//
// v3.20.33: Extend untuk handle 6 action:
//   - move: pindahkan item ke folder existing
//   - create-and-move: buat folder baru + pindahkan item
//   - archive-folder: arsip folder + semua isinya
//   - restore-folder: unarchive folder + semua isinya
//   - add-tag: tambah tag ke item-item
//   - remove-tag: hapus tag dari item-item
export async function applyMagicCommand(items, plan, groupType = 'prompt') {
  if (!plan || !plan.action) {
    return { ok: false, error: 'plan_invalid' };
  }

  const { addItem, updateItem } = await import('./storage.js');

  // ===== Action: move atau create-and-move =====
  if (plan.action === 'move' || plan.action === 'create-and-move') {
    if (!plan.itemIds || plan.itemIds.length === 0) {
      return { ok: false, error: 'no_items_to_move' };
    }

    let folderId = plan.folderId;

    // Kalau action='create-and-move', buat folder baru dulu.
    if (plan.action === 'create-and-move' && !folderId) {
      if (!plan.folderName) {
        return { ok: false, error: 'no_folder_name' };
      }
      const folder = createGroup(plan.folderName, groupType);
      if (!folder.source) folder.source = {};
      folder.source.magicCommand = true;
      folder.source.magicCommandReasoning = plan.reasoning;
      await addItem(folder);
      folderId = folder.id;
    }

    if (!folderId) {
      return { ok: false, error: 'no_target_folder' };
    }

    // Move items via setParentId.
    let itemsMoved = 0;
    for (const itemId of plan.itemIds) {
      const updates = { source: {} };
      // Ambil source existing kalau ada
      const existing = items.find(it => it.id === itemId);
      if (existing?.source) {
        updates.source = { ...existing.source };
      }
      setParentId(updates, folderId);
      await updateItem(itemId, updates);
      itemsMoved++;
    }

    return { ok: true, folderId, itemsMoved, action: plan.action };
  }

  // ===== Action: archive-folder =====
  if (plan.action === 'archive-folder') {
    if (!plan.folderId) {
      return { ok: false, error: 'no_folder_id' };
    }
    const result = await archiveFolderRecursive(items, plan.folderId);
    return { ok: result.ok, archivedCount: result.archivedCount, error: result.error, action: plan.action };
  }

  // ===== Action: restore-folder =====
  if (plan.action === 'restore-folder') {
    if (!plan.folderId) {
      return { ok: false, error: 'no_folder_id' };
    }
    const result = await unarchiveFolderRecursive(items, plan.folderId);
    return { ok: result.ok, restoredCount: result.restoredCount, error: result.error, action: plan.action };
  }

  // ===== Action: add-tag =====
  if (plan.action === 'add-tag') {
    if (!plan.tagName || !plan.itemIds || plan.itemIds.length === 0) {
      return { ok: false, error: 'no_tag_or_items' };
    }
    let itemsTagged = 0;
    for (const itemId of plan.itemIds) {
      const existing = items.find(it => it.id === itemId);
      if (!existing) continue;
      const currentTags = Array.isArray(existing.tags) ? [...existing.tags] : [];
      if (!currentTags.includes(plan.tagName)) {
        currentTags.push(plan.tagName);
        await updateItem(itemId, { tags: currentTags });
        itemsTagged++;
      }
    }
    return { ok: true, itemsTagged, tagName: plan.tagName, action: plan.action };
  }

  // ===== Action: remove-tag =====
  if (plan.action === 'remove-tag') {
    if (!plan.tagName || !plan.itemIds || plan.itemIds.length === 0) {
      return { ok: false, error: 'no_tag_or_items' };
    }
    let itemsUntagged = 0;
    for (const itemId of plan.itemIds) {
      const existing = items.find(it => it.id === itemId);
      if (!existing || !Array.isArray(existing.tags)) continue;
      if (existing.tags.includes(plan.tagName)) {
        const newTags = existing.tags.filter(t => t !== plan.tagName);
        await updateItem(itemId, { tags: newTags });
        itemsUntagged++;
      }
    }
    return { ok: true, itemsUntagged, tagName: plan.tagName, action: plan.action };
  }

  // v3.20.43: Action: archive-items — arsipkan item-item loose tertentu
  if (plan.action === 'archive-items') {
    if (!plan.itemIds || plan.itemIds.length === 0) {
      return { ok: false, error: 'no_items_to_archive' };
    }
    let itemsArchived = 0;
    for (const itemId of plan.itemIds) {
      await updateItem(itemId, { archived: true });
      itemsArchived++;
    }
    return { ok: true, itemsArchived, action: plan.action };
  }

  // v3.20.43: Action: delete-items — hapus item-item loose tertentu
  if (plan.action === 'delete-items') {
    if (!plan.itemIds || plan.itemIds.length === 0) {
      return { ok: false, error: 'no_items_to_delete' };
    }
    const { deleteItem } = await import('./storage.js');
    let itemsDeleted = 0;
    for (const itemId of plan.itemIds) {
      try {
        await deleteItem(itemId);
        itemsDeleted++;
      } catch (e) {
        console.warn('[RecallFox/MagicCmd] delete-items: failed to delete', itemId, e.message);
      }
    }
    return { ok: true, itemsDeleted, action: plan.action };
  }

  return { ok: false, error: 'unknown_action: ' + plan.action };
}

// v3.20.43: applyMultiStepMagicCommand — eksekusi multiple plans secara berurutan
// items: full vault items (akan di-refresh antar step supaya step 2 bisa lihat folder yang dibuat step 1)
// steps: array of plans dari parseMultiStepCommand
// groupType: type folder baru (default 'prompt')
// refreshFn: async function untuk refresh vault items antar step (opsional, default: re-read from storage)
// Return: { ok: true, results: [...], allOk: boolean } | { ok: false, error }
export async function applyMultiStepMagicCommand(items, steps, groupType = 'prompt', refreshFn = null) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: false, error: 'no_steps' };
  }

  const results = [];
  let currentItems = items;
  let allOk = true;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    console.log('[RecallFox/MagicCmd] Multi-step: executing step', i + 1, '/', steps.length, '—', step.action);

    // v3.20.43: Kalau step adalah "move" tapi folderId tidak ditemukan di current items,
    // coba cari by folderName (mungkin folder dibuat di step sebelumnya)
    if (step.action === 'move' && !step.folderId && step.folderName) {
      const found = currentItems.find(it =>
        isGroupItem(it) && !it.archived &&
        it.title?.toLowerCase() === step.folderName.toLowerCase()
      );
      if (found) {
        step.folderId = found.id;
        console.log('[RecallFox/MagicCmd] Multi-step: resolved folderId by name:', step.folderName, '→', step.folderId);
      } else {
        // Folder tidak ditemukan — ubah jadi create-and-move
        step.action = 'create-and-move';
        console.log('[RecallFox/MagicCmd] Multi-step: folder not found, fallback to create-and-move:', step.folderName);
      }
    }

    try {
      const result = await applyMagicCommand(currentItems, step, groupType);
      results.push({ stepIndex: i, action: step.action, result });
      if (!result.ok) {
        allOk = false;
        console.warn('[RecallFox/MagicCmd] Multi-step: step', i + 1, 'failed:', result.error);
      }
    } catch (e) {
      results.push({ stepIndex: i, action: step.action, result: { ok: false, error: e.message } });
      allOk = false;
      console.warn('[RecallFox/MagicCmd] Multi-step: step', i + 1, 'exception:', e.message);
    }

    // Refresh items antar step supaya step berikutnya bisa lihat perubahan
    // (folder baru yang dibuat, item yang sudah dipindah, dll)
    if (refreshFn && typeof refreshFn === 'function') {
      try {
        await refreshFn();
        // Re-read items dari currentVault (yang sudah di-refresh oleh refreshFn)
        // Caller (popup.js) akan pass refreshFn yang juga update currentVault
      } catch (e) {
        console.warn('[RecallFox/MagicCmd] Multi-step: refreshFn error:', e.message);
      }
    }
  }

  return { ok: true, results, allOk };
}

// ===== archiveFolderRecursive: arsipkan folder + semua descendant =====
// items: full vault items
// folderId: ID folder yang akan diarsipkan
// Return: { ok: true, archivedCount } | { ok: false, error }
export async function archiveFolderRecursive(items, folderId) {
  if (!folderId) return { ok: false, error: 'no_folder_id' };

  // Collect semua descendant (recursive).
  const toArchive = new Set([folderId]);
  function collectDesc(id) {
    for (const it of items) {
      if (getParentId(it) === id) {
        toArchive.add(it.id);
        if (isGroupItem(it)) collectDesc(it.id);
      }
    }
  }
  collectDesc(folderId);

  // Archive semua — set archived=true.
  const { updateItem } = await import('./storage.js');
  let archivedCount = 0;
  for (const id of toArchive) {
    await updateItem(id, { archived: true });
    archivedCount++;
  }

  return { ok: true, archivedCount };
}

// ===== unarchiveFolderRecursive: restore folder + semua descendant =====
// items: full vault items
// folderId: ID folder yang akan di-restore
// parentId tetap sama — jadi folder balik ke parent folder asalnya.
// Return: { ok: true, restoredCount } | { ok: false, error }
export async function unarchiveFolderRecursive(items, folderId) {
  if (!folderId) return { ok: false, error: 'no_folder_id' };

  // Collect semua descendant (recursive).
  const toRestore = new Set([folderId]);
  function collectDesc(id) {
    for (const it of items) {
      if (getParentId(it) === id) {
        toRestore.add(it.id);
        if (isGroupItem(it)) collectDesc(it.id);
      }
    }
  }
  collectDesc(folderId);

  // Unarchive semua — set archived=false.
  const { updateItem } = await import('./storage.js');
  let restoredCount = 0;
  for (const id of toRestore) {
    await updateItem(id, { archived: false });
    restoredCount++;
  }

  return { ok: true, restoredCount };
}
