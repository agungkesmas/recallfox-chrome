-- ============================================================================
-- RecallFox v3.20.39 — Cleanup duplicates + fix NULL gdrive_file_url
-- ============================================================================
-- Jalankan di Supabase Dashboard → SQL Editor.
-- Backup database SEBELUM run (Dashboard → Database → Backups → Create backup).
--
-- 3 QUERIES:
--   1. Find duplicates (preview — tidak hapus apa-apa)
--   2. Delete duplicates (keep yang updated_at paling baru per ID)
--   3. Find files with NULL gdrive_file_url (untuk debug "Kopi Link" bug)
-- ============================================================================

-- ============================================================================
-- QUERY 1: PREVIEW DUPLICATES (safe — read-only)
-- ============================================================================
-- Tampilkan ID yang punya lebih dari 1 row (duplikat).
-- Run this FIRST untuk lihat seberapa parah duplikat-nya sebelum hapus.
SELECT
  id,
  COUNT(*) as duplicate_count,
  ARRAY_AGG(title ORDER BY updated_at DESC) as titles,
  ARRAY_AGG(updated_at ORDER BY updated_at DESC) as updated_ats,
  ARRAY_AGG(deleted_at ORDER BY updated_at DESC) as deleted_ats
FROM vault_items
GROUP BY id
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC, MAX(updated_at) DESC;

-- Expected output: kalau ada duplikat, akan muncul di sini.
--   Contoh: id='f_abc123', duplicate_count=3, titles=['SPEC-recallfox...', 'SPEC-recallfox...', 'SPEC-recallfox...']
-- Kalau kosong → tidak ada duplikat di cloud, masalah hanya di local vault.

-- ============================================================================
-- QUERY 2: DELETE DUPLICATES (DESTRUCTIVE — backup dulu!)
-- ============================================================================
-- Hapus row duplikat, keep hanya 1 (yang updated_at paling baru, non-deleted).
-- Idempotent: aman dijalankan berulang (kalau tidak ada duplikat, tidak hapus apa2).
--
-- ⚠️ UNCOMMENT baris DELETE di bawah untuk jalankan. Default commented untuk safety.

-- DELETE FROM vault_items
-- WHERE id IN (
--   SELECT id FROM (
--     SELECT
--       id,
--       ROW_NUMBER() OVER (PARTITION BY id ORDER BY updated_at DESC NULLS LAST, deleted_at NULLS FIRST) as rn
--     FROM vault_items
--   ) t
--   WHERE rn > 1  -- keep rn=1 (newest), delete sisanya
-- )
-- RETURNING id, title, updated_at, deleted_at;

-- Expected: return N rows deleted. Kalau 0 → tidak ada duplikat.

-- ============================================================================
-- QUERY 3: FIND FILES WITH NULL gdrive_file_url (debug "Kopi Link" bug)
-- ============================================================================
-- Tampilkan semua file-type items yang gdrive_file_url-nya NULL.
-- Ini yang bikin "Kopi Link" tombol tidak menghasilkan URL.
SELECT
  id,
  title,
  type,
  gdrive_file_url,
  gdrive_file_id,
  updated_at,
  device_id,
  LEFT(body, 80) as body_preview
FROM vault_items
WHERE type = 'file'
  AND gdrive_file_url IS NULL
  AND deleted_at IS NULL
ORDER BY updated_at DESC;

-- Expected: list file items yang perlu re-upload.
--   Setelah RecallFox v3.20.39 di-install + user trigger SUPABASE_PUSH,
--   file-file ini akan ke-upload otomatis ke Storage + gdrive_file_url terisi.

-- ============================================================================
-- QUERY 4 (optional): RE-UPLOAD TRIGGER
-- ============================================================================
-- Set status file yang NULL ke 'pending_reupload' supaya pushToSupabase
-- prioritaskan upload ulang. Uncomment untuk jalankan.
--
-- UPDATE vault_items
-- SET updated_at = NOW()
-- WHERE type = 'file'
--   AND gdrive_file_url IS NULL
--   AND deleted_at IS NULL;

-- ============================================================================
-- NOTES
-- ============================================================================
-- Setelah run queries di atas:
-- 1. Install RecallFox v3.20.39 di kedua device (MAC + Windows)
-- 2. Di MAC: klik "Sync Full (push + pull)" → upload file + set gdrive_file_url
-- 3. Di Windows: klik "Pull dari Cloud" → download file (sekarang cuma 1, bukan 3)
-- 4. Test "Kopi Link" → harus return URL https://qmwofsfpxjptpyvncylp.supabase.co/storage/v1/object/public/documents/...
--
-- Kalau masih ada masalah, cek console logs:
-- - [RecallFox/Supabase] File uploaded: <id> → <url>  (success)
-- - [RecallFox/Supabase] File upload failed: <id> <error>  (failure)
-- - [RecallFox/Supabase] pullV33: deduped localItems: N → M  (dedup active)
-- - [RecallFox/popup] getVaultItems: skipped duplicate ID: <id>  (render dedup)
