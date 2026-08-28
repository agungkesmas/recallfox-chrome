# CHANGELOG v3.20.25 — Import Paket Link

**Tanggal:** 2026-08-04
**Baseline:** v3.20.24
**Tipe:** Feature addition (non-breaking)

---

## Ringkasan

Tambah fitur **Import Paket Link** untuk mengimpor file JSON manifest
(`.recallfox-pack.json` atau `.json`) yang berisi 1 folder + N item link ke Vault.

Lokasi UI: **Settings → Vault / Data → Paket Link** (section baru setelah "Backup Lokal").

---

## Format Manifest Didukung

```json
{
  "schemaVersion": 1,
  "type": "recallfox-link-pack",
  "packId": "paket-ai-kegiatan-dinas",
  "version": "1.0.0",
  "name": "Paket AI Kegiatan Dinas",
  "description": "Shortcut link untuk README, memo, task plan, dan laporan dinas.",
  "updatedAt": "2026-08-04T00:00:00+07:00",
  "folder": { "name": "Paket AI Kegiatan Dinas", "color": "#2563EB" },
  "items": [
    {
      "id": "readme",
      "type": "link",
      "title": "01 — README Cara Menggunakan",
      "url": "https://drive.google.com/file/d/FILE_ID/view",
      "description": "Panduan penggunaan.",
      "order": 1,
      "tags": ["paket-ai-kegiatan-dinas", "panduan"]
    }
  ]
}
```

---

## Aturan Validasi

1. Root harus object JSON
2. `schemaVersion` harus `1`
3. `type` harus `recallfox-link-pack`
4. `packId`, `version`, `name`, `folder.name` wajib string tidak kosong
5. `items` wajib array minimal 1, maksimal 100 item
6. Setiap item wajib: `id`, `type: "link"`, `title`, `url` valid http/https
7. Tolak URL `javascript:`, `data:`, `file:`, protocol selain HTTP/HTTPS
8. `folder.color` opsional (hex `#RRGGBB` atau `rgb()`)
9. `description`, `order`, `tags` opsional

---

## File yang Ditambah/Diubah

| File | Status | Deskripsi |
|---|---|---|
| `lib/link-pack.js` | **BARU** | Modul importer: `validateLinkPack`, `readLinkPackFile`, `hasImportedPack`, `importLinkPack` |
| `settings/settings.html` | Modified | Tambah section "📦 Paket Link" dengan tombol Import + container preview |
| `settings/settings.js` | Modified | Import modul link-pack, tambah `handleLinkPackFile` + 3 modal UI (preview, duplicate, error) |
| `settings/settings.css` | Modified | Tambah CSS untuk modal link-pack (`.rf-linkpack-*`) |
| `manifest.json` | Modified | Bump version `3.20.24` → `3.20.25` |
| `CHANGELOG-v3.20.25.md` | **BARU** | Dokumentasi ini |

---

## Arsitektur

### `lib/link-pack.js`

4 fungsi publik:

#### `validateLinkPack(raw)` → `{ ok, pack?, errors? }`
Validasi manifest object. Return pack yang sudah di-normalize kalau valid.

#### `readLinkPackFile(file)` → `{ ok, pack?, errors? }`
Baca File (dari `<input type="file">`), parse JSON, validasi manifest.
- Cek ekstensi (`.json` / `.recallfox-pack.json`)
- Cek ukuran (maks 5MB)
- Parse + validate

#### `hasImportedPack(packId)` → `boolean`
Cek apakah packId sudah pernah diimpor dengan tag internal `import-pack:<packId>`.

#### `importLinkPack(pack, options)` → `{ ok, folderId?, itemCount?, error? }`
Eksekusi import:
1. Buat folder (group) dengan `createGroup(name, 'link')` dari `lib/vault-tree.js`
2. Set `source.folderColor` kalau ada
3. Tambah tag internal `import-pack:<packId>` ke folder
4. Untuk setiap item: buat link item, set `linkUrl`, `linkTitle`, `tags`, `source.parentId = folderId`, `source.order`
5. Pakai `addItem()` dari `lib/storage.js` (sudah handle sync Supabase + GDrive)
6. **Rollback** kalau gagal di tengah: hapus folder + semua item yang baru dibuat

`options.asCopy` (boolean) — kalau true, folder name diberi suffix ` (Salinan)`.

### Settings UI

Section baru di `settings.html` (setelah "Backup Lokal"):

```
📦 Paket Link
Import folder dan shortcut link ke Vault RecallFox...

[ Import Paket Link ]   ← tombol trigger file picker
                        ← hidden file input
[preview container]     ← diisi dinamis saat file dipilih
```

3 modal (diisi dinamis di `#rf-linkpack-preview`):
- **Preview Modal** — tampilkan nama paket, versi, deskripsi, folder, list link + tombol Batal/Import Paket
- **Duplicate Modal** — muncul kalau packId sudah pernah diimpor, pilih Batal / Import sebagai Salinan
- **Error Modal** — daftar error validasi manifest

---

## Sinkronisasi

**Tidak ada perubahan schema Supabase.** Import pakai:
- `addItem()` dari `lib/storage.js` — sudah handle:
  - Local storage (`browser.storage.local`)
  - Supabase direct upsert (`directUpsertVaultItem`)
  - GDrive sync (`_notifyGDrive('save_link', ...)`)
  - Firefox sync (kalau aktif)

Item link hasil import akan otomatis tersinkron ke semua device seperti item link biasa yang dibuat manual.

### Field yang di-set di item link hasil import

```js
{
  type: 'link',
  title: '<from manifest>',
  body: '<description + url>',  // untuk search + preview
  linkUrl: '<from manifest>',
  linkTitle: '<from manifest>',
  tags: [...manifest.tags, 'import-pack:<packId>'],
  source: {
    capturedAt: '<now>',
    packId: '<from manifest>',
    packItemId: '<from manifest item.id>',
    packOrder: <order>,
    parentId: '<folderId>',  // nested di folder
    order: <order>
  }
}
```

Folder (group) item:
```js
{
  type: 'link',
  title: '<folder.name>',
  tags: ['group', 'import-pack:<packId>'],
  source: {
    isGroup: true,
    groupType: 'link',
    folderColor: '<optional>',
    packId, packVersion, packName
  }
}
```

---

## Deteksi Duplikasi

Setiap item link hasil import diberi tag internal: `import-pack:<packId>`

Saat user import paket yang sama (sama `packId`) kedua kalinya:
1. `hasImportedPack(packId)` return `true` (cek tag di semua item link)
2. Tampilkan modal duplicate dengan 2 opsi:
   - **Batal** — batal import
   - **Import sebagai Salinan** — buat folder baru dengan nama `[folder.name] (Salinan)`, items tetap dibuat (tidak overwrite)

Tidak ada fitur update paket atau overwrite item di versi ini.

---

## Penanganan Error

| Skenario | Pesan User |
|---|---|
| File bukan `.json` / `.recallfox-pack.json` | "File harus berekstensi .json atau .recallfox-pack.json." |
| File > 5MB | "File terlalu besar (maks 5MB)." |
| File kosong | "File kosong." |
| JSON rusak | "JSON rusak: <parse error>. Pastikan file JSON valid." |
| `schemaVersion` != 1 | "Field 'schemaVersion' harus bernilai 1 (ditemukan: ...)." |
| `type` != `recallfox-link-pack` | "Field 'type' harus bernilai 'recallfox-link-pack'." |
| Field wajib kosong | "Field '<name>' wajib berupa string tidak kosong." |
| URL `javascript:` | "items[N].url: Protocol harus http: atau https: (ditemukan: javascript:)." |
| Item type != `link` | "items[N].type: harus 'link' (ditemukan: ...)." |
| Items > 100 | "Field 'items' maksimal 100 item per paket (ditemukan: ...)." |
| Gagal buat folder/item | "⚠ Gagal import: <error>" + **rollback** semua item yang baru dibuat |

---

## Tidak Ada Migration/Schema Change Supabase

**Konfirmasi:** Tidak ada perubahan pada:
- Struktur tabel Supabase (`vault_items`, `notes`, `settings`, dll)
- Kolom database
- RLS policy
- Migration SQL

Import pakai API `addItem()` yang sudah ada — field `tags`, `source` (JSONB) sudah support struktur yang dipakai.

---

## Cara Pakai

1. Siapkan file `.recallfox-pack.json` dengan format manifest di atas
2. Buka RecallFox → klik ikon gerigi (Settings)
3. Scroll ke section **📦 Paket Link** (setelah "Backup Lokal")
4. Klik **Import Paket Link** → pilih file
5. Preview muncul: cek nama paket, folder, list link
6. Klik **Import Paket** → folder + link dibuat di Vault
7. Buka Vault → tab **Link** → folder baru muncul dengan link di dalamnya

---

## Test Plan

1. ✅ Import JSON valid dengan 4 item link → folder + 4 link tampil di Vault
2. ✅ Klik setiap link → membuka URL yang benar
3. ✅ Import paket sama kedua kali → muncul deteksi duplikasi
4. ✅ Pilih "Import sebagai Salinan" → folder `[nama] (Salinan)` + link dibuat tanpa ubah folder pertama
5. ✅ JSON rusak → error ramah pengguna
6. ✅ Item dengan URL `javascript:alert(1)` → ditolak
7. ✅ Item type `prompt` (bukan `link`) → ditolak
8. ✅ Setelah import, reload extension → folder dan link tetap ada
9. ✅ Sync RecallFox aktif → item link hasil import mengikuti alur sync yang sudah ada
10. ✅ Tidak ada perubahan schema Supabase, tidak ada regression fitur Vault lain

---

## Limitasi

1. Hanya import file JSON lokal (tidak support URL di versi ini)
2. Maksimal 100 item per paket
3. Maksimal ukuran file 5MB
4. Hanya type `link` yang didukung (tidak import prompt/context/snapshot)
5. Tidak ada fitur update paket (overwrite item existing) — hanya import baru atau import sebagai salinan
