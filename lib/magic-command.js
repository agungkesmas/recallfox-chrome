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

  const systemPrompt = `Anda adalah asisten RecallFox yang membantu user mengorganisir item Vault via perintah natural language.

Tugas: Parse perintah user, identifikasi item mana yang ingin dipindahkan + folder tujuan, lalu return action plan.

INPUT:
1. "Loose items" — item yang belum di folder (bisa dipindahkan)
2. "Existing folders" — folder yang sudah ada (bisa jadi tujuan, atau user minta buat folder baru)
3. "Command" — perintah user dalam bahasa natural

PROSES:
1. Pahami intent user: apakah mau (a) pindahkan item ke folder existing, atau (b) buat folder baru + pindahkan item
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
  "action": "move" | "create-and-move",
  "folderName": "Nama Folder Tujuan",
  "folderId": "grp_xxx" | null,
  "itemIds": ["id1", "id2"],
  "reasoning": "1 kalimat penjelasan kenapa AI pilih item ini + folder ini",
  "unmatched": []
}

Aturan:
- "action": "move" kalau folderId di-set (folder existing). "create-and-move" kalau folderId null (perlu buat folder baru).
- "folderName": nama folder tujuan. Kalau folder existing, pakai nama existing. Kalau create baru, pakai nama yang user sebut.
- "folderId": ID folder existing, ATAU null kalau perlu create baru.
- "itemIds": array ID item yang akan dipindahkan. Harus dari daftar loose items.
- "unmatched": array string query user yang tidak match item apa pun (opsional, kosong kalau semua match).
- Output PURE JSON, tidak ada text sebelum/sesudah { }`;

  const userPrompt = `Perintah user:
"""
${cmd}
"""

LOOSE ITEMS (bisa dipindahkan):
${itemContext}

EXISTING FOLDERS (bisa jadi tujuan):
${folderContext}

Parse perintah user, cari item yang cocok, tentukan folder tujuan. Return JSON sesuai format di system prompt.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];

  try {
    const result = await chatFn(messages, { maxTokens: 1000 });
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

    // Validate.
    const validActions = ['move', 'create-and-move'];
    if (!validActions.includes(parsed.action)) {
      return { ok: false, error: 'invalid_action: ' + parsed.action };
    }
    if (typeof parsed.folderName !== 'string' || parsed.folderName.trim() === '') {
      return { ok: false, error: 'missing_folder_name' };
    }
    if (!Array.isArray(parsed.itemIds) || parsed.itemIds.length === 0) {
      return { ok: false, error: 'no_items_to_move' };
    }

    // Validate itemIds — filter yang valid (loose items).
    const looseIdSet = new Set(looseItems.map(it => it.id));
    const validItemIds = parsed.itemIds.filter(id => typeof id === 'string' && looseIdSet.has(id));
    if (validItemIds.length === 0) {
      return { ok: false, error: 'no_valid_item_ids' };
    }

    // Validate folderId — kalau action='move', harus ada folderId yang valid.
    const folderIdSet = new Set(existingFolders.map(f => f.id));
    let folderId = null;
    if (parsed.action === 'move') {
      if (typeof parsed.folderId !== 'string' || !folderIdSet.has(parsed.folderId)) {
        // Fallback: kalau folderId tidak valid, ubah action jadi create-and-move.
        parsed.action = 'create-and-move';
      } else {
        folderId = parsed.folderId;
      }
    }

    const plan = {
      action: parsed.action,
      folderName: parsed.folderName.trim().slice(0, 60),
      folderId,
      itemIds: validItemIds,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.trim().slice(0, 250) : '',
      unmatched: Array.isArray(parsed.unmatched) ? parsed.unmatched.filter(s => typeof s === 'string').slice(0, 10) : []
    };

    return { ok: true, plan };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ===== applyMagicCommand: apply action plan ke vault =====
// items: full vault items
// plan: dari parseMagicCommand
// groupType: type folder baru (default 'prompt')
// Return: { ok: true, folderId, itemsMoved } | { ok: false, error }
export async function applyMagicCommand(items, plan, groupType = 'prompt') {
  if (!plan || !plan.itemIds || plan.itemIds.length === 0) {
    return { ok: false, error: 'plan_invalid' };
  }

  let folderId = plan.folderId;

  // Kalau action='create-and-move', buat folder baru dulu.
  if (plan.action === 'create-and-move' && !folderId) {
    const folder = createGroup(plan.folderName, groupType);
    if (!folder.source) folder.source = {};
    folder.source.magicCommand = true;
    folder.source.magicCommandReasoning = plan.reasoning;
    // We need addItem — import dynamically to avoid circular dep.
    const { addItem } = await import('./storage.js');
    await addItem(folder);
    folderId = folder.id;
  }

  if (!folderId) {
    return { ok: false, error: 'no_target_folder' };
  }

  // Move items via setParentId.
  const { updateItem } = await import('./storage.js');
  let itemsMoved = 0;
  for (const itemId of plan.itemIds) {
    const updates = {};
    setParentId(updates, folderId);
    await updateItem(itemId, updates);
    itemsMoved++;
  }

  return { ok: true, folderId, itemsMoved };
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
