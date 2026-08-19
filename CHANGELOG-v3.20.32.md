# RecallFox v3.20.32 — Magic Command + Folder Archive Recursive

**Release date:** 2026-08-05
**Tag:** `v3.20.32` (feature enhancement)
**Manifest version bump:** `3.20.31` → `3.20.32`

## TL;DR

2 fitur baru:
1. **Magic Command** — ketik perintah natural language untuk pindahkan item ke folder. AI cari item yang cocok + folder tujuan, lalu pindahkan otomatis.
2. **Folder Archive Recursive** — arsipkan folder + semua isinya sekaligus. Restore nanti balik ke parent folder asalnya.

User report:
> "ketika saya meminta daftar link untuk dimasukkan ke folder tertentu, ai dapat memasukkannya ke folder tertentu nanti akan terbentuk otomatis, atau ketika saya ingin meminta beberapa prompt tertentu yang sudah ada di dalam vault untuk dimasukkan ke folder tertentu maka fitur magic grouping akan menurut. terus group/folder bagus nya ada fitur arsip nya jadi arsipnya satu grup/folder gitu ketika di restore nanti ada nya di parent folder."

## Fitur 1: Magic Command (💬 Perintah)

### `lib/magic-command.js` — new file

**`parseMagicCommand(items, chatFn, command)`** — AI parse perintah natural language:
- Input: full vault items + user command string
- AI dapat: loose items context + existing folders context
- AI return action plan:
  ```json
  {
    "action": "move" | "create-and-move",
    "folderName": "Folder Tujuan",
    "folderId": "grp_xxx" | null,
    "itemIds": ["id1", "id2"],
    "reasoning": "kenapa AI pilih item ini",
    "unmatched": []
  }
  ```

**`applyMagicCommand(items, plan, groupType)`** — apply action plan:
- Kalau `action='create-and-move'` → buat folder baru dulu
- Move items via `setParentId`
- Return `{ ok, folderId, itemsMoved }`

### UI: tombol "💬 Perintah" di vault header

Di sebelah tombol "🪄 Auto". Klik → modal dengan:
- Textarea untuk ketik perintah
- 3 contoh perintah (clickable untuk isi textarea)
- Tombol "🪄 Eksekusi Perintah"

### Confirmation modal

Setelah AI parse, tampilkan confirmation modal:
- Folder tujuan (existing atau baru)
- Item yang akan dipindahkan (pills dengan type icon)
- Reasoning AI
- Warning kalau ada query yang tidak match
- Tombol "✓ Jalankan"

### Contoh perintah yang bisa dipakai

- "Pindahkan link MDN dan GitHub Docs ke folder Referensi"
- "Bikin folder Coding, masukkan prompt Express + Vue ke situ"
- "Masukkan semua snapshot AI ke folder Snapshot AI"
- "Pindahkan semua link ke folder Link"

## Fitur 2: Folder Archive Recursive

### `lib/magic-command.js` — archiveFolderRecursive + unarchiveFolderRecursive

**`archiveFolderRecursive(items, folderId)`**:
- Collect semua descendant (recursive — folder + subfolder + items)
- Set `archived=true` pada semua
- Return `{ ok, archivedCount }`

**`unarchiveFolderRecursive(items, folderId)`**:
- Collect semua descendant (recursive)
- Set `archived=false` pada semua
- ParentId tetap sama — jadi folder balik ke parent folder asalnya
- Return `{ ok, restoredCount }`

### UI: menu folder

Di folder sheet (klik ⋯ di folder), tambah 2 opsi:
- **"📦 Arsipkan Folder"** — arsipkan folder + semua isinya. Confirm modal sebelum apply.
- **"📤 Restore Folder"** — kalau folder sudah archived, tampilkan opsi restore.

### Behavior

- Archive folder = folder + semua item + semua subfolder + item di subfolder → semua `archived=true`
- Restore = semua `archived=false`, parentId tetap sama
- Folder yang diarsipkan muncul di chip "Arsip"
- Restore tidak ubah parentId — folder balik ke parent folder asalnya

## Test results

7 test scenarios passed:
1. ✅ parseMagicCommand — move to existing folder
2. ✅ parseMagicCommand — create-and-move (folder baru)
3. ✅ parseMagicCommand — command too short rejected
4. ✅ parseMagicCommand — invalid JSON rejected
5. ✅ archiveFolderRecursive — folder + 2 children archived (count=3)
6. ✅ unarchiveFolderRecursive — folder + 2 children restored (count=3)
7. ✅ Nested folder archive — parent + child + subfolder + grandchild (count=4)

## File yang berubah

- `manifest.json` — version bump `3.20.31` → `3.20.32`
- `lib/magic-command.js` — **new file**: parseMagicCommand + applyMagicCommand + archiveFolderRecursive + unarchiveFolderRecursive
- `popup/popup.js` — import magic-command + handleMagicCommand + showMagicCommandModal + executeMagicCommand + showMagicCommandConfirmModal + archive-folder/restore-folder handlers + wire magicCommandBtn
- `popup/popup.html` — tambah tombol "💬 Perintah" di vault-actions
- `popup/popup.css` — CSS untuk Magic Command modal (examples, unmatched warning)

## Skenario test manual

### Magic Command
1. Pastikan ada beberapa item loose di Vault
2. Klik tombol "💬 Perintah" di vault header
3. Ketik: "Pindahkan semua link ke folder Link" (atau klik contoh)
4. Klik "🪄 Eksekusi Perintah"
5. Confirmation modal muncul: folder tujuan + item yang akan dipindah
6. Klik "✓ Jalankan"
7. Item berpindah ke folder, toast konfirmasi muncul

### Folder Archive
1. Bikin folder dengan beberapa item di dalamnya
2. Klik ⋯ di folder → "📦 Arsipkan Folder"
3. Confirm modal → klik "📦 Arsipkan"
4. Folder + isinya hilang dari list utama
5. Buka chip "Arsip" → folder + isinya muncul di sana
6. Klik ⋯ di folder (di Arsip) → "📤 Restore Folder"
7. Folder + isinya kembali ke lokasi asal (parent folder tetap sama)

## Regression check

- ✅ Magic Folder (Auto Group) tetap jalan — tidak ada perubahan ke aiAutoGroup
- ✅ Import Paket tetap jalan
- ✅ Archive per-item tetap jalan (tidak dihapus, hanya tambah folder archive)
- ✅ Strict rollback guardrail tetap ada di Magic Folder
- ✅ DOM sync tetap jalan — refreshVault + renderChips + renderList
- ✅ Popout sidebar (iframe) tetap works
