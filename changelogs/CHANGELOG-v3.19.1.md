# RecallFox v3.19.1 — Display GPS Location + Voice Player (PWA sync)

**Tanggal:** 26 Jul 2026
**Tag sebelumnya:** v3.19.0
**Tipe:** Display compatibility — sinkronisasi dengan PWA v1.8.0

## Ringkasan

Addon update untuk menampilkan data yang di-capture di PWA v1.8.0:
- GPS location di vault item card (screenshot/document dengan `source.location`)
- Voice player di note card (notes dengan `source.kind='voice'` + `source.audioUrl`)

Tidak menambah fitur capture di addon (desktop tidak punya GPS/mic yang relevan) — hanya display kompatibel.

## Perubahan

### File: `popup/popup.js`

#### 1. Vault item card — GPS location badge

Di function `renderVaultItem()` (line ~1645), tambah:
- Baca `it.source.location` (schema: `{lat, lng, accuracy, address, capturedAt}`)
- Render badge "📍 alamat" (atau "📍 lat, lng" jika no address) di `item-meta` div
- Truncate ke 30 chars, dengan tooltip full address
- Color: `var(--green)` untuk highlight

```js
const loc = it.source?.location;
const locationBadge = loc ? ' \u00B7 <span title="..." style="font-size:10px;color:var(--green)">\uD83D\uDCCD ' + esc(...) + '</span>' : '';
```

Juga tambah voice badge untuk vault items dengan `source.kind='voice'` (defense in depth — meskipun voice notes ada di notes table, bukan vault).

#### 2. Note card — Voice player + GPS location

Di function `renderNotes()` (line ~5285), tambah:
- Deteksi voice note: `n.source?.kind === 'voice' || n.color === 'voice'`
- Render `<audio controls preload="metadata" src="audioUrl">` jika voice note
- Display duration: "🎙️ 65s"
- GPS location badge jika note punya `source.location`
- Voice badge di note-meta: "🎙️ Voice"

### File: `lib/supabase-sync.js`

#### `_parseNoteRow(row)` — tambah field `source`

Sebelumnya note row parser hanya ambil kolom standar (id, title, body, color, group, pinned, archived, createdAt, updatedAt). Sekarang tambah `source: row.source || null` untuk membaca JSONB `source` yang berisi voice metadata.

Kompatibel dengan PWA v1.8.0 yang simpan:
- `note.source.kind = 'voice'`
- `note.source.audioUrl = 'https://...supabase.co/storage/v1/object/public/voice-notes/...'`
- `note.source.duration = 65` (seconds)
- `note.source.location = {lat, lng, address, ...}` (jika GPS saat rekam)

### File: `manifest.json`

Version `3.19.0` → `3.19.1`.

## Kompatibilitas

| Data | PWA v1.8.0 simpan | Addon v3.19.1 baca + display |
|------|-------------------|------------------------------|
| GPS location | `item.source.location.{lat,lng,accuracy,address,capturedAt}` | ✅ "📍 alamat" di item-meta |
| Voice audio URL | `note.source.audioUrl` | ✅ `<audio controls>` di note card |
| Voice duration | `note.source.duration` | ✅ "🎙️ 65s" di note card |
| Voice discriminator | `note.color='voice'` + `note.source.kind='voice'` | ✅ "🎙️ Voice" badge di note-meta |
| Folder tree | `item.source.parentId` + `source.isGroup` | ✅ Sudah ada sejak v3.18.4 |

## Test plan

- [x] `node --check popup/popup.js` — OK
- [x] `node --check lib/supabase-sync.js` — OK
- [x] `web-ext lint`: 0 errors, 131 warnings (baseline +11 dari 120 karena new strings dengan emoji)
- [ ] Manual test: capture foto di PWA (with GPS) → sync → buka addon vault → item card tampil "📍 alamat"
- [ ] Manual test: rekam voice note di PWA → sync → buka addon Catatan tab → note card tampil `<audio controls>` + "🎙️ Voice" badge
- [ ] Manual test: pastikan note biasa (tanpa source) tetap render normal (tidak break)

## Yang TIDAK diubah

- Addon DnD, folder tree, sort, tag filter — tetap utuh (v3.19.0)
- Addon capture flow (screenshot, document scan) — tetap utuh
- Addon RecallTape, viewer, copy buttons — tetap utuh
- Supabase schema vault_items — tidak diubah (source JSONB pass-through)
- PWA v1.8.0 — tidak diubah (sudah deploy ke Vercel)
