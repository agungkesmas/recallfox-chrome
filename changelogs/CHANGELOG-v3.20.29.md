# RecallFox v3.20.29 — Magic Folder: Subfolder + Deep Reasoning + Checkbox per Folder

**Release date:** 2026-08-05
**Tag:** `v3.20.29` (feature enhancement)
**Manifest version bump:** `3.20.28` → `3.20.29`

## TL;DR

Perbaikan 3 masalah di Magic Folder v3.20.28:
1. **Belum support subfolder** — AI hanya bisa usulkan flat 1 level
2. **AI "cari aman"** — konteks body preview terlalu pendek (150 char), AI tidak cukup info untuk reasoning mendalam
3. **Tidak bisa pilih folder** — user harus terima semua atau batal semua, tidak bisa centang per folder

User report:
> "logika membuat magic folder nya belum menyentuh subfolder, kemudian belum teliti ya, masih global dan cari aman begitu. coba perbaiki logika bikin foldernya dan bisa ada centang untuk terima usulan pembuatan foldernya di modal yang muncul."

## Yang diubah

### 1. Subfolder support (nested, max depth 2)

**Response format v2 (nested):**
```json
[
  {
    "name": "Coding",
    "reasoning": "Semua item coding dikelompokkan di sini",
    "itemIds": ["c1", "c2"],
    "children": [
      {
        "name": "Frontend",
        "reasoning": "React + Vue spesifik",
        "itemIds": ["p1", "p2"]
      },
      {
        "name": "Backend",
        "reasoning": "Server-side + deployment",
        "itemIds": ["p3", "p4"]
      }
    ]
  }
]
```

**Backward compat:** Response v1 (flat, tanpa `children`) tetap didukung.

**Max depth 2** (top + 1 level sub) — kalau AI return lebih dalam, di-truncate. Ini supaya struktur tidak terlalu kompleks untuk user.

### 2. Deep AI reasoning

**Body preview diperpanjang 150 → 300 char** supaya AI punya konteks lebih untuk reasoning teliti.

**System prompt ditingkatkan** dengan proses berpikir wajib:
1. Baca setiap item satu per satu — pahami konteks dari title + body + tags + type
2. Identifikasi pola/kategori yang muncul dari konteks item (bukan asal kategori umum)
3. Cluster item berdasarkan pola yang paling kuat — kalau pola lemah, cari pola alternatif
4. Untuk cluster yang item-nya banyak (>5) atau heterogen, pertimbangkan sub-cluster
5. Hindari "cari aman" — kalau item benar-benar unik, masukkan ke "Lainnya" dengan justifikasi
6. Validasi: setiap item harus masuk tepat 1 folder/subfolder

**Field reasoning wajib** di setiap folder (top dan sub) — AI harus justifikasi kenapa folder dibuat.

**Konteks item diperkaya:**
- Body preview 300 char (sebelumnya 150)
- Tags sampai 8 (sebelumnya 5)
- URL untuk link (150 char)
- `contextPurpose` untuk context
- `snapshotDomain` untuk snapshot

**maxTokens dinaikkan 1200 → 2000** supaya AI bisa reasoning + nested structure.

### 3. Checkbox per folder di preview modal

Setiap folder (top-level + subfolder) punya checkbox:
- ✅ Default: semua tercentang
- ✅ User bisa uncheck folder yang tidak mau dibuat
- ✅ "Pilih semua" checkbox untuk check/uncheck semua sekaligus
- ✅ Kalau parent di-uncheck → semua subfolder otomatis di-uncheck
- ✅ Kalau subfolder di-check → parent otomatis di-check
- ✅ Folder yang di-uncheck tidak dibuat, item-nya tetap di tempat asal

**Tombol confirm berubah:** "✓ Terapkan Struktur" → "✓ Buat Folder Terpilih" (lebih akurat dengan behavior checkbox).

### 4. UI preview modal ditingkatkan

- **Reasoning display** — setiap folder menampilkan `💡 {reasoning}` di bawah nama folder
- **Indentasi subfolder** — subfolder di-indent 20px per level + border left untuk visual hierarchy
- **Subfolder hint** — folder yang punya subfolder menampilkan badge "X subfolder"
- **Summary diperkaya** — "AI mengusulkan X top-level folder · Y folder total (X top-level + subfolder) untuk Z item"

### 5. Apply logic recursive

`applyMagicFolderGroups()` sekarang recursive:
1. Buat top-level folder → dapat ID
2. Pindahkan item langsung ke folder tersebut
3. Recursive: buat subfolder dengan `parentId = parent folder ID`
4. Pindahkan item ke subfolder

**Strict rollback guardrail tetap ada** — snapshot vault sebelum, rollback kalau gagal di tengah.

## Test results

9 test scenarios passed:
1. ✅ Nested subfolder response — parsed correctly, children preserved
2. ✅ All items assigned — no item lost (9 input = 9 assigned)
3. ✅ Stats has subfolder info — `hasSubfolders: true`, `totalFolders: 5` (3 top + 2 sub)
4. ✅ Flat response backward compat — v1 format tetap works, "Lainnya" auto-created for unassigned
5. ✅ Reasoning field preserved — subfolder has reasoning text
6. ✅ Invalid JSON rejected
7. ✅ Too few items rejected
8. ✅ Duplicate itemId handled (dedup — first occurrence wins)
9. ✅ Max depth 2 enforced — depth 3 children di-truncate

## File yang berubah

- `manifest.json` — version bump `3.20.28` → `3.20.29`
- `lib/vault-tree.js` — `aiAutoGroup()` rewrite: nested support + deep reasoning + reasoning field + stats
- `popup/popup.js` — preview modal: checkbox per folder + nested display + reasoning + recursive apply
- `popup/popup.css` — CSS untuk checkbox, subfolder indent, reasoning display, select-all row

## Skenario test manual

1. Buka sidebar/popout → pastikan ada minimal 4 item di Vault (campur prompt/context/link)
2. Klik tombol "🪄 Auto" → progress modal muncul ("AI sedang berpikir...")
3. Tunggu ~5-10 detik → preview modal muncul dengan struktur folder
4. Cek: setiap folder punya checkbox + reasoning `💡 ...`
5. Cek: kalau AI usulkan subfolder, tampil dengan indent + border left
6. Uncheck 1 folder → tombol confirm berubah tetap "Buat Folder Terpilih"
7. Klik "✓ Buat Folder Terpilih" → hanya folder yang diceklis yang dibuat
8. Vault list refresh → folder + subfolder muncul dengan nested structure
9. Test "Pilih semua" checkbox → check/uncheck semua sekaligus
10. Test uncheck parent → subfolder otomatis uncheck

## Regression check

- ✅ Tidak ada caller lain `aiAutoGroup()` selain `handleAiAutoGroup()` — perubahan isolated
- ✅ Flat response v1 tetap didukung — backward compat 100%
- ✅ Strict rollback guardrail tetap ada — snapshot vault sebelum apply
- ✅ DOM sync tetap jalan — `refreshVault()` + `renderChips()` + `renderList()`
- ✅ Filter/pencarian tidak terpengaruh
- ✅ Popout sidebar (iframe) tetap works — popup.js berjalan di semua context
