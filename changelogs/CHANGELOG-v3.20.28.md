# RecallFox v3.20.28 — Fix Magic Folder: Payload Array + AI Reasoning + Preview Modal + Rollback

**Release date:** 2026-08-05
**Tag:** `v3.20.28` (bug fix + feature enhancement)
**Manifest version bump:** `3.20.27` → `3.20.28`

## TL;DR

Fix bug `messages: Invalid input: expected array, received string` di fitur Magic Folder (tombol "🪄 Auto" di sidebar). Plus: AI reasoning ditingkatkan supaya bebas menentukan struktur folder optimal, preview modal sebelum apply, dan strict rollback guardrail.

## Root cause bug

Fitur "Magic Folder" = tombol `#aiGroupBtn` "🪄 Auto" → `handleAiAutoGroup()` → `aiAutoGroup()` di `lib/vault-tree.js`.

Di `aiAutoGroup()` lama (line 174):
```javascript
const result = await chatFn(prompt, { maxTokens: 800 });
```

`chatFn` adalah `chatWithFallback` yang expect **array** of `{role, content}` objects. Tapi `prompt` adalah **string**. OpenAI-compatible API reject dengan HTTP 422:
```
{"error":{"message":"messages: Invalid input: expected array, received string"}}
```

User see toast "Gagal: ..." tapi tidak tahu root cause-nya.

## Yang diubah

### Step 1: Fix payload type (lib/assistant.js + lib/vault-tree.js)

**lib/assistant.js — `chat()` defensive payload:**
```javascript
// Coerce string → array
if (typeof messages === 'string') {
  messages = [{ role: 'user', content: messages }];
}
// Coerce single object → array
else if (!Array.isArray(messages)) {
  if (messages?.role && messages?.content) {
    messages = [messages];
  } else {
    throw new Error('Parameter messages harus array of {role, content} atau string');
  }
}
// Validate setiap message: pastikan role + content (string)
messages = messages.map(m => ({
  role: m.role || 'user',
  content: typeof m.content === 'string' ? m.content : String(m.content || '')
})).filter(Boolean);
if (messages.length === 0) throw new Error('Parameter messages tidak boleh kosong');
```

**lib/vault-tree.js — `aiAutoGroup()` pass proper array:**
```javascript
// Sebelumnya (BUG): chatFn(prompt, ...)
// Sekarang (FIX):
const messages = [
  { role: 'system', content: systemPrompt },
  { role: 'user', content: userPrompt }
];
const result = await chatFn(messages, { maxTokens: 1200 });
```

### Step 2: AI reasoning untuk optimal folder structure

System prompt lama sangat basic:
```
You are an assistant that groups items into folders.
Given these items (title + type), create 2-5 logical groups.
Return ONLY valid JSON: [{"name":"Group Name","itemIds":["id1","id2"]}]
```

System prompt baru memberi AI freedom untuk reasoning:
- Bebas menentukan jumlah folder (2-8)
- Bebas menentukan nama folder (deskriptif, profesional)
- Bebas menentukan kriteria grouping (by topik, type, workflow, domain, urgency, atau kombinasi)
- Pertimbangan: minimal 2 item per folder, item tidak jelas → "Lainnya", hindari overlap

Plus: item context diperkaya dengan body preview (150 char) + tags + URL (untuk link), supaya AI bisa reasoning lebih akurat.

### Step 3: Preview modal sebelum apply (popup.js)

Sebelumnya: AI return struktur → langsung apply tanpa preview. User tidak bisa reject kalau struktur tidak bagus.

Sekarang:
1. **Progress modal** — tampilkan saat AI sedang menganalisis (spinner + "Magic Folder sedang berpikir...")
2. **Preview modal** — tampilkan struktur folder yang diusulkan AI:
   - Summary: "AI mengusulkan X folder untuk Y item"
   - Setiap folder: icon 📁 + nama + jumlah item + preview 5 item pertama
   - Warning kalau ada item yang tidak ke-assign
   - Tombol "Batal" / "✓ Terapkan Struktur"

### Step 4: Strict rollback guardrail (popup.js — applyMagicFolderGroups)

```javascript
// Snapshot vault sebelum apply
const vaultBefore = await getVault();
const vaultBeforeJson = JSON.stringify(vaultBefore);

try {
  // ... apply groups ...
  return { ok: true, groupsCreated, itemsMoved };
} catch (e) {
  // Rollback — restore vault ke state sebelum
  console.error('[RecallFox/MagicFolder] Apply gagal, rollback...', e);
  try {
    const restored = JSON.parse(vaultBeforeJson);
    await saveVault(restored);
    console.log('[RecallFox/MagicFolder] Rollback berhasil — vault restored');
  } catch (rollbackErr) {
    console.error('[RecallFox/MagicFolder] Rollback GAGAL:', rollbackErr);
  }
  return { ok: false, error: e.message };
}
```

### DOM sync (Step 3 dari user request)

Setelah apply berhasil, panggil:
- `await refreshVault()` — reload vault dari storage
- `renderChips()` — update chip counts
- `renderList()` — re-render vault list dengan folder baru

Ini bekerja di **popup, sidebar native, DAN popout sidebar (iframe)** karena `popup.js` berjalan di semua context tersebut (sidebar.html meng-import popup.js).

## Test results

10 test scenarios passed:
1. ✅ chat() dengan array messages (normal) — accepted
2. ✅ chat() dengan STRING messages — coerced to array
3. ✅ chat() dengan single object {role, content} — coerced to array
4. ✅ chat() dengan empty array — correctly rejected
5. ✅ chat() dengan null — correctly rejected
6. ✅ chat() dengan non-string content — coerced to string
7. ✅ aiAutoGroup passes proper array to chatFn (messages is array, length 2, has role+content)
8. ✅ aiAutoGroup dengan AI return invalid JSON — correctly rejected
9. ✅ aiAutoGroup dengan AI return {folders: [...]} format — correctly parsed (fallback)
10. ✅ aiAutoGroup dengan too few items — correctly rejected

## File yang berubah

- `manifest.json` — version bump `3.20.27` → `3.20.28`
- `lib/assistant.js` — `chat()` defensive payload (coerce string/object → array)
- `lib/vault-tree.js` — `aiAutoGroup()` pass array + AI reasoning system prompt + response validation
- `popup/popup.js` — `handleAiAutoGroup()` rewrite: progress modal + preview modal + rollback guardrail
- `popup/popup.css` — CSS untuk `.rf-magicfolder-*` modal styles

## Regression check (Step 4 strict rollback guardrail)

- ✅ Tidak ada caller lain `aiAutoGroup()` selain `handleAiAutoGroup()` — perubahan isolated
- ✅ `chat()` defensive payload backward compatible — caller yang sudah pass array tetap jalan
- ✅ Tidak touch item yang sudah di-folder lain — hanya move item ungrouped
- ✅ Tidak hapus item apa pun — hanya pindahkan + buat folder baru
- ✅ Rollback restore vault ke state sebelum kalau gagal di tengah apply
- ✅ Filter/pencarian tidak terpengaruh — `renderChips()` + `renderList()` dipanggil setelah apply
- ✅ Popout sidebar (iframe) tetap works — popup.js berjalan di iframe context

## Skenario test manual

1. Buka sidebar/popout → pastikan ada minimal 4 item di Vault
2. Klik tombol "🪄 Auto" → progress modal muncul ("Magic Folder sedang berpikir...")
3. Tunggu ~3-5 detik → preview modal muncul dengan struktur folder yang diusulkan AI
4. Klik "Batal" → modal tutup, tidak ada perubahan
5. Klik lagi "🪄 Auto" → tunggu preview → klik "✓ Terapkan Struktur"
6. Modal tutup, toast "✓ X folder dibuat, Y item dipindahkan"
7. Vault list refresh → folder-folder baru muncul + item-item sudah nested di dalamnya
8. Test di popout sidebar (klik "rf" di floater) → flow sama harusnya jalan
9. Test kalau AI gagal (matikan internet) → toast error, tidak ada perubahan ke vault
