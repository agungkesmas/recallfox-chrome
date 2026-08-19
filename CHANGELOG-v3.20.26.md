# RecallFox v3.20.26 — Import Paket Multi-Type (Phase 2)

**Release date:** 2026-08-04
**Tag:** `v3.20.26` (feature extension — backward compatible)
**Manifest version bump:** `3.20.25` → `3.20.26`

## TL;DR

Fitur Import Paket (sebelumnya "Import Paket Link") sekarang support
**multi-type**: link + prompt + context + note + snapshot. Sebelumnya
(v3.20.25) hanya support type `link`.

Schema v2 (`recallfox-pack`) diperkenalkan untuk multi-type. Schema v1
(`recallfox-link-pack`) tetap didukung — backward compatible 100%.

## Yang ditambahkan

### 1. Schema v2 — Multi-type pack

Format manifest v2:

```json
{
  "schemaVersion": 2,
  "type": "recallfox-pack",
  "packId": "paket-ai-workflow",
  "version": "1.0.0",
  "name": "Paket AI Workflow Lengkap",
  "description": "Link + prompt + konteks untuk workflow AI",
  "updatedAt": "2026-08-04T00:00:00+07:00",
  "folder": { "name": "AI Workflow", "color": "#10B981" },
  "items": [
    { "id": "ctx-proyek", "type": "context", "title": "Konteks Proyek A", "body": "Proyek A adalah...", "contextPurpose": "project", "tags": ["proyek-a"] },
    { "id": "prompt-analisis", "type": "prompt", "title": "Analisis Data", "body": "Tolong analisis: {{data}}", "tags": ["analisis"] },
    { "id": "link-docs", "type": "link", "title": "Google Docs", "url": "https://...", "tags": ["referensi"] },
    { "id": "note-meeting", "type": "note", "title": "Template Meeting", "body": "## Agenda\n1. ...", "color": "yellow", "tags": ["template"] },
    { "id": "snap-ai", "type": "snapshot", "title": "Snapshot AI", "body": "User: halo\nAI: halo", "snapshotDomain": "chat.z.ai", "snapshotMessageCount": 2, "tags": ["chat"] }
  ]
}
```

### 2. Type yang didukung

| Type | Field wajib | Field opsional | Disimpan ke |
|------|-------------|----------------|-------------|
| `link` | `url` | `description`, `tags`, `order` | vault_items |
| `prompt` | `body` | `variables` (auto-extract), `toppings`, `tags`, `order` | vault_items |
| `context` | `body` | `contextPurpose` (whitelist), `toppings`, `tags`, `order` | vault_items |
| `note` | `body` | `color` (whitelist), `title`, `tags`, `order` | notes (tabel terpisah) |
| `snapshot` | `body` | `snapshotDomain`, `snapshotMessageCount`, `tags`, `order` | vault_items |

### 3. Type yang DITOLAK (dengan pesan error jelas)

| Type | Alasan |
|------|--------|
| `screenshot` | Butuh upload ke Supabase Storage, kompleks, bisa crash quota |
| `document` | Sama seperti screenshot — butuh Storage upload |
| `bundle` | Referential integrity ke `item_ids`, bisa rusak kalau item dihapus |

### 4. Validasi per-type

- `link`: `url` wajib valid http/https (tolak javascript:/data:/file:)
- `prompt`/`context`/`note`/`snapshot`: `body` wajib string tidak kosong
- `context`: `contextPurpose` opsional, kalau ada harus di whitelist: `system`, `project`, `domain`, `reference`, `instruction`, `custom`
- `note`: `color` opsional, kalau ada harus di whitelist: `default`, `yellow`, `green`, `blue`, `pink`, `purple`
- `snapshot`: `snapshotDomain` opsional string, `snapshotMessageCount` opsional number
- `resumeContext` di-skip (local-only field, tidak sync ke Supabase)

### 5. Auto-extract variables untuk prompt

Type `prompt` otomatis extract variables dari pattern `{{var}}` di body
menggunakan `extractVariables()` dari `lib/search.js`. User tidak perlu
set manual.

Contoh: body `"Analisis data: {{data}}"` → variables: `["data"]`

### 6. UI preview multi-type

Modal preview sekarang menampilkan:
- Icon per type (🔗 link, ✨ prompt, 📦 context, 📝 note, 📸 snapshot)
- Body preview 80 char pertama untuk type text (prompt/context/note/snapshot)
- Badge untuk contextPurpose dan note color
- Summary count per type: "🔗 2 link · ✨ 3 prompt · 📦 1 konteks"
- Schema version badge: "schema v2"

### 7. Toast sukses yang informatif

Sebelumnya: `✓ Paket "X" berhasil diimpor (5 link).`
Sekarang: `✓ Paket "X" berhasil diimpor (2 link, 3 prompt, 1 konteks).`

### 8. Rollback yang lebih robust

`importLinkPack()` sekarang track type counts + rollback vault items
DAN notes kalau gagal di tengah import.

## Backward compatibility

| Schema | Type field | Behavior |
|--------|------------|----------|
| v1 (`recallfox-link-pack`) | Harus `link` | Tetap jalan seperti v3.20.25 — tidak ada perubahan |
| v2 (`recallfox-pack`) | `link`/`prompt`/`context`/`note`/`snapshot` | Multi-type, validasi ketat per type |

Paket v1 yang sudah dibuat user tetap bisa di-import tanpa perubahan apa pun.

## Test results

8 test scenarios passed:
1. ✅ v1 link-only pack — valid, backward compat
2. ✅ v2 multi-type pack (5 types) — valid
3. ✅ v2 dengan type `screenshot` — ditolak dengan pesan jelas
4. ✅ v2 dengan `contextPurpose` invalid — ditolak
5. ✅ v2 dengan note `color` invalid — ditolak
6. ✅ v1 dengan type `prompt` — ditolak (v1 hanya link)
7. ✅ Type labels/icons — semua type ada label
8. ✅ `schemaVersion` 3 — ditolak (hanya 1 atau 2)

## File yang berubah

- `manifest.json` — version bump `3.20.25` → `3.20.26`
- `lib/link-pack.js` — rewrite untuk support schema v2 multi-type
  - `validateLinkPack()` — validasi per-type
  - `importLinkPack()` — import per-type (link/prompt/context/snapshot → vault, note → notes)
  - `hasImportedPack()` — cek duplikasi di vault + notes
  - `getTypeLabel()`, `getTypeIcon()` — helper baru untuk UI
  - `readLinkPackFile()` — maks file size 5MB → 10MB (prompt/context body bisa panjang)
- `settings/settings.js` — `showLinkPackPreviewModal()` multi-type preview
- `settings/settings.html` — update label "Import Paket Link" → "Import Paket"
- `settings/settings.css` — tambah CSS untuk `.rf-linkpack-item-body`, `.rf-linkpack-item-badge`, `.rf-linkpack-schema`

## Impact ke database

**TIDAK ADA schema change.** Semua type yang didukung sudah punya kolom DB-nya sendiri:

| Type | Kolom DB | Sudah ada? |
|------|----------|------------|
| link | `link_url`, `link_title` | ✅ |
| prompt | `body`, `variables` (auto-extract), `toppings` | ✅ |
| context | `body`, `context_purpose` | ✅ |
| note | `body`, `title`, `color`, `pinned` (tabel `notes`) | ✅ |
| snapshot | `body`, `snapshot_domain`, `snapshot_message_count` | ✅ |

Tidak ada migration SQL. Tidak ada ALTER TABLE. Tidak ada tabel baru.

## Catatan

- **Tidak ada breaking change**. Paket v1 (link-only) tetap jalan tanpa modifikasi.
- **Type yang aman** (link, prompt, context, note, snapshot) sudah di-support.
- **Type yang berisiko** (screenshot, document, bundle) sengaja DITOLAK dengan pesan error jelas — sesuai audit.
- **Note disimpan terpisah** dari vault_items (tabel `notes` di Supabase). Importer handle ini dengan `addNote()` + manual tag update.
- **Folder type** otomatis dipilih berdasarkan type item pertama yang bukan note. Kalau semua item note, folder tidak dibuat (note tidak butuh folder).
