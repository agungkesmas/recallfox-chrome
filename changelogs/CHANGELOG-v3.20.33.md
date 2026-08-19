# CHANGELOG v3.20.33 — Fix Magic Command di Sidebar + Multi-Action Support

**Tanggal:** 2026-08-05
**Baseline:** v3.20.32
**Tipe:** Bug fix + feature extension

---

## Ringkasan

2 perbaikan utama:

1. **Bug fix:** Tombol "💬 Perintah" (Magic Command) tidak muncul di sidebar/popout
   - Root cause: tombol `magicCommandBtn` ada di `popup.html` tapi **HILANG di `sidebar/sidebar.html`**
   - User yang pakai sidebar native atau popout sidebar tidak bisa akses fitur
   - Fix: tambah tombol yang sama ke `sidebar.html`

2. **Feature extension:** Magic Command sekarang support **6 jenis action** (sebelumnya hanya 2)
   - `move` — pindahkan item ke folder existing (existing)
   - `create-and-move` — buat folder baru + pindahkan item (existing)
   - `archive-folder` — **BARU** — arsip folder + semua isinya recursive
   - `restore-folder` — **BARU** — restore folder dari arsip + semua isinya
   - `add-tag` — **BARU** — tambahkan tag ke multiple item sekaligus
   - `remove-tag` — **BARU** — hapus tag dari multiple item

---

## Bug #1: Tombol Magic Command Tidak Muncul di Sidebar

### Root Cause

Di v3.20.32, tombol `magicCommandBtn` hanya ditambahkan ke `popup/popup.html` (line 89):

```html
<!-- popup.html -->
<button class="addbtn" id="magicCommandBtn" title="...">💬<span class="btn-text"> Perintah</span></button>
```

TAPI **tidak ditambahkan ke `sidebar/sidebar.html`**. Padahal sidebar.html memakai UI yang sama dengan popup (via `import '../popup/popup.js'`). Handler di popup.js:

```js
const magicCommandBtnEl = $('#magicCommandBtn');
if (magicCommandBtnEl) magicCommandBtnEl.addEventListener('click', handleMagicCommand);
```

Karena `$('#magicCommandBtn')` return `null` di sidebar context, handler tidak attach → user tidak bisa klik tombol yang tidak ada.

### Fix

Tambah tombol yang sama ke `sidebar/sidebar.html` (line 89-91), di posisi yang sama dengan popup.html — antara `aiGroupBtn` dan `addGroupBtn`:

```html
<!-- sidebar.html -->
<button class="addbtn" id="aiGroupBtn" title="Auto Group AI">🪄<span class="btn-text"> Auto</span></button>
<button class="addbtn" id="magicCommandBtn" title="Ketik perintah — mis. 'pindahkan link MDN ke folder Referensi'">💬<span class="btn-text"> Perintah</span></button>
<button class="addbtn" id="addGroupBtn" title="Buat Folder/Grup Baru">📁+<span class="btn-text"> Grup</span></button>
```

---

## Feature #2: Magic Command Multi-Action

### Sebelumnya (v3.20.32)

Magic Command hanya support 2 action:
- `move` — pindahkan item ke folder existing
- `create-and-move` — buat folder baru + pindahkan item

User feedback: "sebenarnya fitur magic command ini bisa banyak fungsi ya mengorganisasi dan mengisi parameter di vault dsb kan ya"

### Sekarang (v3.20.33)

Tambah 4 action baru:

#### `archive-folder`
- **Trigger:** "Arsipkan folder Lama", "Sembunyikan folder X"
- **Effect:** Set `archived: true` ke folder + SEMUA item di dalamnya (recursive, termasuk sub-folder)
- **Confirm modal:** Tampilkan nama folder + jumlah descendant
- **Toast:** `📦 Folder di-arsipkan (N item disembunyikan)`

#### `restore-folder`
- **Trigger:** "Restore folder Lama dari arsip", "Keluarkan folder X dari arsip"
- **Effect:** Set `archived: false` ke folder + SEMUA descendant
- **AI context:** Archived folders di-include di prompt supaya AI bisa pilih
- **Confirm modal:** Tampilkan nama folder + jumlah descendant
- **Toast:** `♻️ Folder di-restore (N item kembali)`

#### `add-tag`
- **Trigger:** "Tambahkan tag favorit ke semua link", "Tag 'penting' ke prompt React"
- **Effect:** Tambahkan tag ke item-item yang cocok (skip kalau tag sudah ada)
- **Confirm modal:** Tampilkan nama tag + list item yang akan di-tag
- **Toast:** `🏷️ Tag "favorit" ditambahkan ke N item`

#### `remove-tag`
- **Trigger:** "Hapus tag lama dari semua prompt", "Buang tag 'test' dari item"
- **Effect:** Hapus tag dari item-item yang cocok (skip kalau tag tidak ada)
- **Confirm modal:** Tampilkan nama tag + list item
- **Toast:** `🏷️ Tag "lama" dihapus dari N item`

### Contoh Perintah di Modal

Update contoh perintah di Magic Command modal supaya cover semua 6 action:

```
💡 Contoh perintah (klik untuk pakai):
📁 Pindahkan semua link ke folder Link
📁+ Bikin folder Coding + semua prompt programming
📦 Arsipkan folder Lama
♻️ Restore folder Lama dari arsip
🏷️ Tambahkan tag favorit ke semua link
🏷️ Hapus tag lama dari semua prompt
```

---

## File yang Diubah

| File | Perubahan |
|---|---|
| `manifest.json` | Bump version 3.20.32 → 3.20.33 |
| `sidebar/sidebar.html` | **+ tombol `magicCommandBtn`** (bug fix utama) |
| `lib/magic-command.js` | Extend `parseMagicCommand` system prompt + validasi 6 action; extend `applyMagicCommand` dengan handler untuk archive-folder, restore-folder, add-tag, remove-tag; tambah archived folders ke AI context |
| `popup/popup.js` | Update `showMagicCommandModal` contoh perintah; rewrite `showMagicCommandConfirmModal` supaya render berdasarkan action type; update `executeMagicCommand` error map + pass all items (termasuk archived); tambah `countFolderDescendants` helper; update toast feedback per action |
| `CHANGELOG-v3.20.33.md` | BARU — dokumentasi ini |

---

## Tidak Ada Perubahan Schema Supabase

**Konfirmasi:** Tidak ada perubahan pada:
- Struktur tabel Supabase (`vault_items`, `notes`, `settings`, dll)
- Kolom database
- RLS policy
- Migration SQL

Semua action pakai field yang sudah ada:
- `move`/`create-and-move` → `source.parentId` (JSONB, sudah ada)
- `archive-folder`/`restore-folder` → `archived` (boolean, sudah ada)
- `add-tag`/`remove-tag` → `tags` (TEXT[], sudah ada)

---

## Test Plan

### Test 1: Bug fix — tombol Magic Command muncul di sidebar
1. Buka sidebar RecallFox (Alt+Shift+4 di Firefox, atau klik tombol "rf" floater di Chrome)
2. Lihat vault-actions bar (baris tombol di header vault)
3. **Expected:** Tombol "💬 Perintah" muncul antara "🪄 Auto" dan "📁+ Grup"
4. Klik tombol → Magic Command modal muncul

### Test 2: Action move (existing, regression test)
1. Klik "💬 Perintah"
2. Ketik: "Pindahkan semua link ke folder Link"
3. Klik "🪄 Eksekusi Perintah"
4. **Expected:** Confirm modal muncul dengan action "Pindahkan item ke folder existing"
5. Klik "✓ Jalankan" → toast "✓ N item dipindahkan ke 'Link'"

### Test 3: Action create-and-move (existing, regression test)
1. Klik "💬 Perintah"
2. Ketik: "Bikin folder Coding, masukkan semua prompt tentang programming"
3. Eksekusi
4. **Expected:** Confirm modal muncul dengan action "Buat folder baru + pindahkan item"
5. Klik "✓ Jalankan" → toast "✓ N item dipindahkan ke 'Coding'"

### Test 4: Action archive-folder (BARU)
1. Pastikan ada folder "Lama" dengan beberapa item di dalamnya
2. Klik "💬 Perintah"
3. Ketik: "Arsipkan folder Lama"
4. Eksekusi
5. **Expected:** Confirm modal muncul dengan action "Arsipkan folder + semua isinya"
6. Modal menampilkan: `📦 Folder Lama · N item` + `📦 Folder + semua isi + N item di dalamnya`
7. Klik "✓ Jalankan" → toast "📦 Folder di-arsipkan (N item disembunyikan)"
8. Buka chip "Arsip" → folder + isinya muncul di sana

### Test 5: Action restore-folder (BARU)
1. Dari Test 4, folder "Lama" sudah ter-arsip
2. Klik "💬 Perintah"
3. Ketik: "Restore folder Lama dari arsip"
4. Eksekusi
5. **Expected:** Confirm modal muncul dengan action "Restore folder dari arsip"
6. Klik "✓ Jalankan" → toast "♻️ Folder di-restore (N item kembali)"
7. Folder + isinya kembali ke lokasi asal (parentId tetap sama)

### Test 6: Action add-tag (BARU)
1. Klik "💬 Perintah"
2. Ketik: "Tambahkan tag favorit ke semua link"
3. Eksekusi
4. **Expected:** Confirm modal muncul dengan action "Tambahkan tag ke item"
5. Modal menampilkan: `🏷️+ Tag: favorit · N item` + list item pills
6. Klik "✓ Jalankan" → toast "🏷️ Tag 'favorit' ditambahkan ke N item"
7. Cek item link → tag "favorit" muncul

### Test 7: Action remove-tag (BARU)
1. Dari Test 6, item link punya tag "favorit"
2. Klik "💬 Perintah"
3. Ketik: "Hapus tag favorit dari semua link"
4. Eksekusi
5. **Expected:** Confirm modal muncul dengan action "Hapus tag dari item"
6. Klik "✓ Jalankan" → toast "🏷️ Tag 'favorit' dihapus dari N item"
7. Cek item link → tag "favorit" hilang

### Test 8: Error handling — folder tidak ditemukan
1. Klik "💬 Perintah"
2. Ketik: "Arsipkan folder TidakAda"
3. Eksekusi
4. **Expected:** Toast "⚠ Folder yang mau di-arsip tidak ditemukan"

### Test 9: Error handling — tag tanpa item
1. Klik "💬 Perintah"
2. Ketik: "Tambahkan tag test"
3. Eksekusi
4. **Expected:** Toast error (AI tidak menemukan item yang cocok, atau missing tag name)

### Test 10: Regression — fitur lain tetap jalan
1. Magic Folder (Auto Group AI) — klik "🪄 Auto" → modal muncul, AI analisa, preview folder
2. Add Folder manual — klik "📁+ Grup" → prompt nama → folder dibuat
3. Sort dropdown, tag filter, collapse all — semua tetap jalan
4. Batch mode — tetap jalan

---

## Cara Update dari v3.20.32

1. Backup vault: Settings → Backup Lokal → Export (.json atau .rfvault)
2. Update addon ke v3.20.33
3. Test: buka sidebar → klik "💬 Perintah" → modal muncul
4. Test 6 jenis action dengan contoh perintah di atas

---

## Catatan Teknis

### Kenapa archived folders harus di-include di AI context?

Untuk action `restore-folder`, AI harus bisa pilih folder yang sudah archived. Kalau context hanya berisi folder yang `!archived`, AI tidak akan bisa referensi folder yang sudah di-arsip → action restore-folder selalu gagal dengan "no_valid_archived_folder_to_restore".

Solusi: tambah section `ARCHIVED FOLDERS (bisa di-restore)` di user prompt, berisi list folder yang `archived: true`.

### Kenapa `setParentId` perlu preserve source existing?

Di v3.20.32, `applyMagicCommand` untuk move/create-and-move pakai:

```js
const updates = {};
setParentId(updates, folderId);  // set source.parentId
await updateItem(itemId, updates);
```

Ini **overwrite** field `source` — semua metadata lain di `source` (seperti `isGroup`, `folderColor`, `packId`, `capturedAt`) hilang!

Fix v3.20.33:

```js
const existing = items.find(it => it.id === itemId);
const updates = { source: existing?.source ? { ...existing.source } : {} };
setParentId(updates, folderId);  // set source.parentId di copy existing
await updateItem(itemId, updates);
```

Sekarang `source` existing dipreserve, hanya `parentId` yang di-update.

### Kenapa perlu `countFolderDescendants`?

Untuk confirm modal archive/restore folder, user perlu tahu berapa item yang akan ter-arsip. Kalau folder punya sub-folder dengan item, recursive count diperlukan.

Fungsi `countFolderDescendants(items, folderId)` recursive walk tree untuk hitung semua descendant (item + sub-folder + sub-sub-folder + ...).
