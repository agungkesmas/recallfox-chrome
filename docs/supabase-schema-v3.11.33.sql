-- ============================================================================
-- RecallFox Supabase Migration — v3.11.33
-- ----------------------------------------------------------------------------
-- Tujuan:
--   1. FIX error: "relation vault_items is already member of publication
--      supabase_realtime" (error 42710) — pakai exception handling, bukan
--      pre-check pg_publication_tables (yang kadang gagal di Supabase).
--   2. Pastikan kolom deleted_at + device_id ada (untuk backward compat).
--   3. Enable Realtime publication untuk vault_items, notes, settings.
--   4. Tambah index untuk performa pull (filter user_id + deleted_at IS NULL).
--   5. Trigger auto-update updated_at.
--
-- Cara jalankan:
--   1. Buka https://supabase.com/dashboard/project/qmwofsfpxjptpyvncylp/sql/new
--   2. Paste seluruh isi file ini
--   3. Klik Run
--   4. Harusnya muncul NOTICE: "vault_items already in publication — skip"
--      (atau "Added vault_items to publication") tanpa ERROR.
--
-- Safe to run multiple times (idempotent).
-- ============================================================================

-- ============== 1. ENSURE COLUMNS EXIST ==============
-- v3.11.29+: deleted_at (tombstone) + device_id (last writer)
ALTER TABLE public.vault_items ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE public.vault_items ADD COLUMN IF NOT EXISTS device_id   TEXT;
ALTER TABLE public.notes       ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE public.notes       ADD COLUMN IF NOT EXISTS device_id   TEXT;

-- ============== 2. FIX PUBLICATION ERROR (v3.11.33) ==============
-- Root cause error 42710 "relation is already member of publication":
--   Pre-check pg_publication_tables kadang tidak return expected row di
--   Supabase managed Postgres (cache invalidation issue). Solusinya:
--   langsung ALTER PUBLICATION, tangani exception duplicate_object.
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['vault_items', 'notes', 'settings'] LOOP
    BEGIN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', tbl);
      RAISE NOTICE 'Added % to supabase_realtime publication', tbl;
    EXCEPTION
      WHEN duplicate_object THEN
        RAISE NOTICE '% already in supabase_realtime publication — skip', tbl;
      WHEN OTHERS THEN
        RAISE NOTICE 'Skip % (reason: %)', tbl, SQLERRM;
    END;
  END LOOP;
END $$;

-- ============== 3. INDEXES ==============
CREATE INDEX IF NOT EXISTS idx_vault_items_user_not_deleted
  ON public.vault_items(user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_vault_items_deleted_at
  ON public.vault_items(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vault_items_updated_at
  ON public.vault_items(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_notes_user_not_deleted
  ON public.notes(user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notes_deleted_at
  ON public.notes(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notes_updated_at
  ON public.notes(updated_at DESC);

-- ============== 4. AUTO-UPDATE updated_at TRIGGER ==============
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vault_items_updated_at ON public.vault_items;
CREATE TRIGGER vault_items_updated_at
  BEFORE UPDATE ON public.vault_items
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS notes_updated_at ON public.notes;
CREATE TRIGGER notes_updated_at
  BEFORE UPDATE ON public.notes
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ============== 5. CLEANUP OLD TOMBSTONES (opsional) ==============
CREATE OR REPLACE FUNCTION public.cleanup_old_tombstones(days_old INTEGER DEFAULT 30)
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public.vault_items
  WHERE deleted_at IS NOT NULL
    AND deleted_at < NOW() - (days_old || ' days')::INTERVAL;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  DELETE FROM public.notes
  WHERE deleted_at IS NOT NULL
    AND deleted_at < NOW() - (days_old || ' days')::INTERVAL;
  GET DIAGNOSTICS deleted_count = deleted_count + ROW_COUNT;

  RAISE NOTICE 'Cleanup: removed % tombstones older than % days', deleted_count, days_old;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- ============== 6. VERIFY REALTIME ENABLED ==============
-- Cek tables yang sudah terdaftar di supabase_realtime publication.
-- Expected output: vault_items, notes, settings (plus tables default Supabase).
SELECT tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
  AND schemaname = 'public'
ORDER BY tablename;

-- ============== DONE ==============
-- Setelah Run, cek output:
--   - Tidak ada "ERROR: 42710"
--   - Ada NOTICE: "vault_items already in supabase_realtime publication — skip"
--     (atau "Added vault_items to supabase_realtime publication")
--   - Query terakhir return list tables yang terdaftar di publication,
--     pastikan vault_items, notes, settings ada di list.
