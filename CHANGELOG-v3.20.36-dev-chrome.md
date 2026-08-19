# CHANGELOG v3.20.36-dev-chrome — Port fitur Firefox v3.20.40-dev ke Chrome

**Tanggal:** 2026-08-06
**Baseline:** v3.20.35-dev-chrome (`76c2bd8`)
**Tipe:** Feature port — **DEV RELEASE (bukan stable)**

## TL;DR

Port semua fitur Firefox v3.20.40-dev ke Chrome MV3. Chrome sekarang punya
**parity penuh** dengan Firefox untuk: upload file, copy URL, popout sidebar,
defense-in-depth duplicate check, SQL schema, dan semua fix v3.20.36-v3.20.40.

## Fitur yang di-port dari Firefox

### 1. Upload File teks (md/txt/json/html/csv/yaml)
- `handleDocFileUpload()` — upload multiple file, validasi format + size (maks 2MB)
- `detectFileKind()` — deteksi ekstensi + MIME type
- `FILE_UPLOAD_WHITELIST` — 9 format: .md/.markdown/.txt/.json/.html/.htm/.csv/.yaml/.yml
- `MAX_FILE_UPLOAD_BYTES = 2MB`
- Menu "+ Baru" → "📄 Upload File teks" di popup/sidebar
- `docFileInput` hidden input di popup.html
- Toast loading + sukses dengan info URL cloud status

### 2. Copy File Content + URL + Download
- `copyFileContentToClipboard(id)` — salin isi file teks ke clipboard (1 klik)
- `copyFileUrlToClipboard(id)` — salin URL cloud dengan 4 lapis retry:
  - A. currentVault (fast path)
  - B. getVault() refresh dari storage.local
  - C. retry 2x jeda 1.5s
  - D. trigger SUPABASE_PUSH + retry 3x
- `downloadFileItem(id)` — download file via Blob + anchor click
- `resolveImageUrl(item)` — resolve URL dari gdriveFileUrl/gdrive_file_url/source

### 3. Supabase Storage upload file document
- `DOCUMENTS_BUCKET = 'documents'` constant
- `_uploadFileDocument(item, userId)` — upload ke `documents` bucket:
  - Path: `user-<uuid>/<item-id>.<ext>`
  - PATCH `gdrive_file_url` di vault_items table
  - Update lokal vault via getVault/saveVault
  - Error tracking ke storage.local (`recallfox_last_sync_error`)
- Delete file document saat `directDeleteVaultItem` untuk type='file'

### 4. addItem() — type='file' support + defense-in-depth
- Prefix `f` untuk type='file' (genId)
- Defense-in-depth duplicate check (port dari Firefox v3.20.39):
  - Cek existing ID sebelum push
  - Kalau ada, update (last-write-wins by updatedAt) bukan push duplikat

### 5. SUPABASE_GET_ITEM_URL handler
- Query `gdrive_file_url` + `gdrive_file_id` dari `vault_items` table
- Dipakai `copyFileUrlToClipboard` sebagai fallback terakhir

### 6. Popout sidebar v3.20.14 (update dari v3.20.12)
- Event-driven hide/restore (tidak pakai setTimeout 30s fallback)
- Hapus `.catch()` fallback yang kirim RF_FORWARD_TO_ACTIVE_TAB (bug modal 2x)
- `captureHideTimer` untuk fallback restore 5s

### 7. SQL schema files
- `supabase-schema.sql` — full schema dengan:
  - Bucket `documents` + 4 RLS policies
  - Fix `cleanup_old_tombstones` function (GET DIAGNOSTICS temp variable)
- `supabase-schema-v3.11.33.sql` — schema versi lama
- `supabase-migration-housekeeping.sql` — migration scripts
- `sql-cleanup-v3.20.39.sql` — cleanup duplicates + fix NULL gdrive_file_url

## MV3 adaptasi

- `content/sidebar-cs.js` identik dengan Firefox (browser.* polyfill handle diff)
- `lib/storage.js` pakai static imports (Chrome MV3 SW larang dynamic import)
- `lib/supabase-sync.js` `_uploadFileDocument` pakai `uploadFile` yang sudah di-import
- `background.js` `SUPABASE_GET_ITEM_URL` pakai dynamic import (OK di Chrome SW)

## Files changed

```
content/sidebar-cs.js    | 61 changes (update ke v3.20.14)
lib/storage.js           | +19 lines (type='file' + defense-in-depth)
lib/supabase-sync.js     | +108 lines (_uploadFileDocument + DOCUMENTS_BUCKET + delete)
popup/popup.js           | +236 lines (file upload + copy + download + menu)
popup/popup.html         | +1 line (docFileInput)
background.js            | +26 lines (SUPABASE_GET_ITEM_URL handler)
manifest.json            | version bump 3.20.35 → 3.20.36
supabase-schema.sql      | NEW (full schema + documents bucket + RLS + cleanup fix)
supabase-schema-v3.11.33.sql | NEW
supabase-migration-housekeeping.sql | NEW
sql-cleanup-v3.20.39.sql | NEW
```

## Verification (Chrome 150 headless, ALL TESTS PASSED)

```
✓ docFileInput exists (accept .md/.txt/.json/.html/.csv/.yaml)
✓ sidebarInPageBtn exists
✓ Menu "+ Baru" has "📄 Upload File teks"
✓ Floater pair rf+sc mounted (2 buttons)
✓ Click rf → popout appears (width 280px, iframe sidebar.html)
✓ Pin button exists (📍)
✓ Iframe load sidebar.html with all native selectors:
  #popup, .brand-t "RecallFox", #sidebarInPageBtn,
  #stripPrayer "🕌 🌟 Dhuha 07:25 −49m", body.rf-sidebar-body
✓ SUPABASE_GET_ITEM_URL handler in background.js
✓ Zero console errors
```

## Parity dengan Firefox v3.20.40-dev

| Fitur | Firefox | Chrome |
|---|---|---|
| Upload file teks | ✅ | ✅ |
| Copy file content | ✅ | ✅ |
| Copy file URL (4-layer retry) | ✅ | ✅ |
| Download file | ✅ | ✅ |
| Popout sidebar (rf+sc) | ✅ | ✅ |
| Auto-close 15s + pin | ✅ | ✅ |
| Screenshot hide popout | ✅ | ✅ |
| RecallTape from popout | ✅ | ✅ |
| Defense-in-depth duplicate check | ✅ | ✅ |
| SUPABASE_GET_ITEM_URL | ✅ | ✅ |
| SQL schema (documents bucket + RLS) | ✅ | ✅ |
| Cleanup function fix | ✅ | ✅ |

## Manual testing checklist

1. Download ZIP, load unpacked di Chrome.
2. Buka popup → "+ Baru" → "📄 Upload File teks" → pilih file .md/.txt
3. Toast: `📤 filename terupload — URL cloud siap`
4. Buka chip "📄 File" → klik baris item → itemSheet → "🔗 Kopi Link"
5. Toast: `✓ URL file tersalin — paste ke AI chat`
6. Klik "Salin ↵" → isi file tersalin
7. Klik "Download" → file ter-download
8. Buka halaman web → klik rf → popout sidebar muncul (280px)
9. Klik pin → tidak auto-close
10. Biarkan 15s → auto-close

**Penting:** Jalankan SQL `recallfox-v3.20.38-documents-bucket.sql` di Supabase Dashboard sebelum test upload (untuk create bucket `documents` + RLS policies).
