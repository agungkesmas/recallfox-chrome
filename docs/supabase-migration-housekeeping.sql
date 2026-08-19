-- ============================================================================
-- RecallFox Supabase Schema — Housekeeping Migration v3.16.9
-- ----------------------------------------------------------------------------
-- Cleanup kolom mati yang tidak dipakai di kode addon maupun PWA.
-- Kolom yang di-drop:
--   - client_id         (tidak pernah di-set/di-read di kode mana pun)
--   - is_deleted        (tidak dipakai — sistem pakai deleted_at untuk soft-delete)
--   - deleted_by_device (tidak pernah di-set/di-read di kode mana pun)
--
-- Cara eksekusi:
--   1. Buka https://supabase.com/dashboard/project/qmwofsfpxjptpyvncylp/sql/new
--   2. Paste seluruh isi file ini, klik Run
--   3. Cek output — harus "Success. No rows returned."
--
-- Safe to run multiple times (semua pakai IF EXISTS).
-- ============================================================================

-- ============== DROP DEAD COLUMNS FROM vault_items ==============

DO $$
BEGIN
  -- client_id
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'vault_items' AND table_schema = 'public' AND column_name = 'client_id'
  ) THEN
    ALTER TABLE public.vault_items DROP COLUMN client_id;
    RAISE NOTICE 'Dropped column: vault_items.client_id';
  ELSE
    RAISE NOTICE 'Column vault_items.client_id already gone — skip';
  END IF;

  -- is_deleted
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'vault_items' AND table_schema = 'public' AND column_name = 'is_deleted'
  ) THEN
    ALTER TABLE public.vault_items DROP COLUMN is_deleted;
    RAISE NOTICE 'Dropped column: vault_items.is_deleted';
  ELSE
    RAISE NOTICE 'Column vault_items.is_deleted already gone — skip';
  END IF;

  -- deleted_by_device
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'vault_items' AND table_schema = 'public' AND column_name = 'deleted_by_device'
  ) THEN
    ALTER TABLE public.vault_items DROP COLUMN deleted_by_device;
    RAISE NOTICE 'Dropped column: vault_items.deleted_by_device';
  ELSE
    RAISE NOTICE 'Column vault_items.deleted_by_device already gone — skip';
  END IF;
END $$;

-- ============== DROP DEAD COLUMNS FROM notes (jika ada) ==============

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'notes' AND table_schema = 'public' AND column_name = 'client_id'
  ) THEN
    ALTER TABLE public.notes DROP COLUMN client_id;
    RAISE NOTICE 'Dropped column: notes.client_id';
  ELSE
    RAISE NOTICE 'Column notes.client_id already gone or not exists — skip';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'notes' AND table_schema = 'public' AND column_name = 'is_deleted'
  ) THEN
    ALTER TABLE public.notes DROP COLUMN is_deleted;
    RAISE NOTICE 'Dropped column: notes.is_deleted';
  ELSE
    RAISE NOTICE 'Column notes.is_deleted already gone or not exists — skip';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'notes' AND table_schema = 'public' AND column_name = 'deleted_by_device'
  ) THEN
    ALTER TABLE public.notes DROP COLUMN deleted_by_device;
    RAISE NOTICE 'Dropped column: notes.deleted_by_device';
  ELSE
    RAISE NOTICE 'Column notes.deleted_by_device already gone or not exists — skip';
  END IF;
END $$;

-- ============== VERIFIKASI ==============
-- Jalankan query ini untuk cek kolom yang tersisa:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'vault_items' AND table_schema = 'public'
--   ORDER BY ordinal_position;
--
-- Expected: 41 kolom (sebelumnya 44, sekarang 44 - 3 = 41)
-- Tidak ada client_id, is_deleted, deleted_by_device di hasil.
