# RecallFox v3.20.30 — Magic Folder: Sharper Naming + Existing Folder Move + Regenerate Button

**Release date:** 2026-08-05
**Tag:** `v3.20.30` (feature enhancement)
**Manifest version bump:** `3.20.29` → `3.20.30`

## TL;DR

4 perbaikan dari feedback user:
1. **AI baca konteks lebih dalam** — body preview 300→400 char + AI diminta temukan TEMA UTAMA, bukan asal kategori
2. **Nama folder lebih spesifik** — AI diberi naming guidance dengan contoh baik/buruk, hindari nama generik
3. **Item di folder TIDAK dipertimbangkan** — hanya item loose (belum di folder) yang diusulkan ke folder baru
4. **Folder existing BISA DIPINDAHKAN** ke folder baru via field `folderIds` — AI bisa naruh folder lama ke dalam folder baru
5. **Tombol "🔄 Usulan Lain"** — klik untuk minta AI usulkan struktur alternatif yang berbeda

User report:
> "logikanya harus dipertajam lagi untuk membuat nama folder yang pas dengan menambahkan di logika itu harus bisa membaca konteks isi dari vault yang tersimpannya itu tentang apa. dan di modalnya ada semacam refresh atau apa ya jadi kalau dipencet itu nama folder yang diusulkan bisa berubah gitu. dan dikasih logika begini, vault yang sudah ada di dalam folder itu tidak menjadi pertimbangan untuk dimasukkan ke folder usulan, tetapi folder yang sudah ada dan berisi vault bisa dipindahkan ke folder yang diusulkan fitur magic."

## Yang diubah

### 1. AI baca konteks lebih dalam (vault-tree.js)

**Body preview 300 → 400 char** — AI punya konteks lebih untuk menemukan tema utama.

**System prompt ditingkatkan** dengan proses berpikir wajib:
1. Baca setiap loose item satu per satu — pahami konteksnya dari title + body + tags + type
2. Identifikasi **TEMA UTAMA** yang muncul dari konteks item (bukan asal kategori umum)
3. Cluster item berdasarkan tema yang paling kuat
4. Pertimbangkan existing folders — apakah cocok dipindahkan ke folder baru?
5. Hindari "cari aman" — kalau item unik, masukkan "Lainnya" dengan justifikasi

### 2. Nama folder lebih spesifik (vault-tree.js)

**Naming guidance** ditambahkan ke system prompt:
```
NAMA FOLDER — WAJIB SPESIFIK DAN MENGGAMBARKAN ISI:
- Baca konteks item → temukan TEMA UTAMA → jadikan nama folder
- HINDARI nama generik: "Lain-lain", "Item", "Folder 1", "Misc"
- HINDARI nama terlalu umum: "Coding", "Notes" (terlalu luas)
- GUNAKAN nama SPESIFIK: "React Hooks", "API Design Patterns", "Docker Deployment"
- Contoh BAIK: "Vue Composition API", "Express Middleware", "Meeting Notes Q4 2026"
- Contoh BURUK: "Folder A", "Items", "Stuff", "Things"
```

### 3. Item di folder TIDAK dipertimbangkan (vault-tree.js)

**Filter candidate berubah:**
```javascript
// Sebelumnya (v3.20.29):
const candidates = items.filter(it => !isGroupItem(it));

// Sekarang (v3.20.30):
const candidates = items.filter(it => !isGroupItem(it) && !getParentId(it));
```

Item yang sudah punya `parentId` (sudah di folder) **di-exclude** dari kandidat grouping. Hanya item loose yang diusulkan ke folder baru.

### 4. Folder existing BISA DIPINDAHKAN (vault-tree.js + popup.js)

**Existing folders** (group items yang berisi item) diberikan ke AI sebagai unit movable:
```
EXISTING FOLDERS (bisa dipindahkan ke folder baru via "folderIds"):
- FOLDER grp_abc | "My React Notes" | 3 item: "useEffect cleanup", "useState basics", "Context API"
```

**Response format v3** dengan field `folderIds`:
```json
[
  {
    "name": "Frontend Frameworks",
    "reasoning": "React + Vue prompts",
    "itemIds": ["p1", "p2"],
    "folderIds": ["grp_abc"]
  }
]
```

**Apply logic** (`applyMagicFolderGroups`) — recursive + handle `folderIds`:
```javascript
// Pindahkan existing folders ke folder ini (via setParentId on folder item)
if (Array.isArray(folder.folderIds)) {
  for (const folderId of folder.folderIds) {
    const updates = {};
    setParentId(updates, group.id);
    await updateItem(folderId, updates);
    foldersMoved++;
  }
}
```

### 5. Tombol "🔄 Usulan Lain" (popup.js)

**State variable** `_magicFolderRegenerateCount` track jumlah regenerate.

**Tombol di preview modal:**
- Label: "🔄 Usulan Lain"
- Klik → increment counter → re-call `aiAutoGroup` dengan `options.regenerate = count`
- Progress modal tampilkan "Percobaan ke-X — AI mencari struktur alternatif"

**Variation hint di system prompt** (saat regenerate > 0):
```
PERHATIAN: Ini adalah percobaan ke-2. User sudah melihat usulan sebelumnya dan
mau alternatif yang BERBEDA. WAJIB:
- Coba kriteria pengelompokan yang BERBEDA dari sebelumnya
- Berikan nama folder yang BERBEDA — jangan ulang nama yang sama
- Bisa juga ubah jumlah folder (lebih banyak atau lebih sedikit)
```

### 6. UI preview modal diperkaya

- **Existing folder pills** — folder yang akan dipindah tampil dengan icon 📁 + warna primary
- **Folder hint badge** — "X folder existing" di setiap folder yang nerima folder lama
- **Summary diperkaya** — "X top-level folder · Y folder total · Z folder existing dipindah · W folder existing tidak diubah"
- **Regenerate button** — di sebelah "Pilih semua", styling primary outline

## Test results

9 test scenarios passed:
1. ✅ Items in folder EXCLUDED from candidates — `p_in_folder` tidak muncul di prompt
2. ✅ Existing folders with content included as movable — `grp_old` muncul, `grp_empty` (kosong) tidak
3. ✅ folderIds in response — existing folder moved to proposed folder
4. ✅ Stats include existing folder info — `totalExistingFoldersMoved: 1`, `totalExistingFoldersAvailable: 1`
5. ✅ Unmoved folder IDs returned — untuk UI info
6. ✅ Regenerate parameter adds variation hint — "PERHATIAN: percobaan ke-2"
7. ✅ Naming guidance present — "SPESIFIK", contoh baik/buruk
8. ✅ Body preview 400 char — untuk reasoning lebih teliti
9. ✅ Backward compat — response tanpa folderIds tetap works

## File yang berubah

- `manifest.json` — version bump `3.20.29` → `3.20.30`
- `lib/vault-tree.js` — `aiAutoGroup()` rewrite: exclude items-in-folder + existing folders as movable + naming guidance + regenerate parameter
- `popup/popup.js` — handleAiAutoGroup + preview modal: regenerate button + existing folder display + apply folderIds
- `popup/popup.css` — CSS untuk regenerate button + folder pill + regen label

## Skenario test manual

1. Buka sidebar/popout → pastikan ada beberapa item loose + minimal 1 folder berisi item
2. Klik "🪄 Auto" → progress modal → preview modal
3. Cek: folder yang diusulkan punya nama SPESIFIK (mis. "React Hooks" bukan "Coding")
4. Cek: folder existing muncul sebagai pill 📁 di folder yang akan nerima
5. Klik "🔄 Usulan Lain" → progress modal "Percobaan ke-2" → preview baru dengan struktur berbeda
6. Centang/uncentang folder → klik "Buat Folder Terpilih"
7. Cek: folder existing yang dipindah sekarang nested di folder baru
8. Cek: item yang sudah di folder lain TIDAK ikut pindah (tetap di folder asalnya)

## Regression check

- ✅ Backward compat — response v1/v2 (tanpa folderIds) tetap didukung
- ✅ Strict rollback guardrail tetap ada
- ✅ DOM sync tetap jalan — refreshVault + renderChips + renderList
- ✅ Popout sidebar (iframe) tetap works
- ✅ Filter/pencarian tidak terpengaruh
