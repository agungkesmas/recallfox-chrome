-- ============================================================================
-- RecallFox Supabase Schema — v3.11.21
-- ----------------------------------------------------------------------------
-- Eksekusi di Supabase SQL Editor:
--   1. Buka https://supabase.com/dashboard/project/qmwofsfpxjptpyvncylp/sql/new
--   2. Login dengan akun Supabase Anda
--   3. Paste seluruh isi file ini, klik Run
--   4. Cek output — harus "Success. No rows returned."
--   5. Cek di Table Editor — harus muncul tables: profiles, vault_items,
--      notes, settings, screenshots, sync_log
-- ============================================================================

-- ============== ENABLE EXTENSIONS ==============
-- pgcrypto untuk gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============== TABLES ==============

-- 1. PROFILES — extend dari auth.users (1:1)
--    Menyimpan metadata tambahan per user (display_name, avatar_url, preferences)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  display_name TEXT,
  avatar_url TEXT,
  preferences JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. VAULT_ITEMS — simpan prompt, context, link, snapshot, screenshot metadata
--    Setiap user punya vault items sendiri (RLS enforced)
CREATE TABLE IF NOT EXISTS public.vault_items (
  id TEXT PRIMARY KEY,                    -- ID dari addon (e.g. 'p_1737500000_abc')
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                     -- 'prompt' | 'context' | 'link' | 'snapshot' | 'screenshot'
  title TEXT,
  body TEXT,
  tags TEXT[] DEFAULT '{}',
  category TEXT,
  source JSONB,                           -- { url, title, capturedAt, domain }
  -- Link-specific
  link_url TEXT,
  link_title TEXT,
  -- Screenshot-specific
  screenshot_mode TEXT,                   -- 'visible' | 'entire' | 'selection'
  screenshot_width INTEGER,
  screenshot_height INTEGER,
  screenshot_format TEXT,                 -- 'png' | 'jpeg'
  screenshot_bytes BIGINT,
  thumbnail_data_url TEXT,                -- small inline PNG for list view
  gdrive_file_id TEXT,
  gdrive_file_url TEXT,
  -- v3.11.25: Annotation note — catatan penjelasan untuk anotasi screenshot
  annotation_note TEXT,                   -- user's text description of annotations
  -- Snapshot-specific
  snapshot_domain TEXT,
  snapshot_message_count INTEGER,
  -- Bundle-specific
  item_ids TEXT[] DEFAULT '{}',
  inject_order TEXT[] DEFAULT '{}',
  note_ids TEXT[] DEFAULT '{}',
  color TEXT,
  inline_prompt TEXT,
  inline_prompt_item_id TEXT,
  -- Common metadata
  toppings TEXT[] DEFAULT '{}',
  variables TEXT[] DEFAULT '{}',
  favorite BOOLEAN DEFAULT FALSE,
  archived BOOLEAN DEFAULT FALSE,
  use_count INTEGER DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index untuk query cepat
CREATE INDEX IF NOT EXISTS idx_vault_items_user_id ON public.vault_items(user_id);
CREATE INDEX IF NOT EXISTS idx_vault_items_user_type ON public.vault_items(user_id, type);
CREATE INDEX IF NOT EXISTS idx_vault_items_user_archived ON public.vault_items(user_id, archived);
CREATE INDEX IF NOT EXISTS idx_vault_items_updated_at ON public.vault_items(updated_at DESC);

-- 3. NOTES — simpan catatan notepad
CREATE TABLE IF NOT EXISTS public.notes (
  id TEXT PRIMARY KEY,                    -- ID dari addon
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT,
  body TEXT,
  color TEXT DEFAULT 'default',
  "group" TEXT,                           -- 'group' adalah reserved word, pakai quote
  pinned BOOLEAN DEFAULT FALSE,
  archived BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notes_user_id ON public.notes(user_id);
CREATE INDEX IF NOT EXISTS idx_notes_user_archived ON public.notes(user_id, archived);
CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON public.notes(updated_at DESC);

-- 4. SETTINGS — simpan preferensi user (key-value pair)
CREATE TABLE IF NOT EXISTS public.settings (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  setting_key TEXT NOT NULL,
  setting_value JSONB,
  setting_type TEXT,                      -- 'BOOLEAN' | 'NUMBER' | 'STRING' | 'JSON'
  category TEXT,                          -- 'ui' | 'prayer' | 'assistant' | 'gdrive' | etc.
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, setting_key)
);

CREATE INDEX IF NOT EXISTS idx_settings_user_id ON public.settings(user_id);

-- 5. SCREENSHOTS — metadata screenshot + link ke Storage bucket
CREATE TABLE IF NOT EXISTS public.screenshots (
  id TEXT PRIMARY KEY,                    -- sama dengan vault_items.id untuk type=screenshot
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  vault_item_id TEXT REFERENCES public.vault_items(id) ON DELETE CASCADE,
  storage_path TEXT,                      -- path di bucket Storage (e.g. 'user-xxx/screenshot-123.png')
  storage_url TEXT,                       -- public URL supaya bisa diakses tanpa auth
  file_size BIGINT,
  width INTEGER,
  height INTEGER,
  format TEXT,
  annotation_note TEXT,                   -- v3.11.26 (Issue #2): catatan anotasi screenshot
  captured_at TIMESTAMPTZ,
  source_url TEXT,
  source_title TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_screenshots_user_id ON public.screenshots(user_id);
CREATE INDEX IF NOT EXISTS idx_screenshots_vault_item_id ON public.screenshots(vault_item_id);

-- 6. SYNC_LOG — audit trail semua operasi sync
CREATE TABLE IF NOT EXISTS public.sync_log (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,                   -- 'push' | 'pull' | 'sync_full' | 'login' | 'logout'
  direction TEXT,                         -- 'upload' | 'download'
  items_count INTEGER DEFAULT 0,
  notes_count INTEGER DEFAULT 0,
  screenshots_count INTEGER DEFAULT 0,
  duration_ms INTEGER,
  status TEXT,                            -- 'ok' | 'error'
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_log_user_id ON public.sync_log(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_log_created_at ON public.sync_log(created_at DESC);

-- ============== TRIGGERS ==============
-- Auto-create profile saat user signup baru
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1))
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Auto-update updated_at saat row di-update
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

DROP TRIGGER IF EXISTS settings_updated_at ON public.settings;
CREATE TRIGGER settings_updated_at
  BEFORE UPDATE ON public.settings
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS profiles_updated_at ON public.profiles;
CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ============== ROW LEVEL SECURITY (RLS) ==============
-- Wajib: pastikan user hanya bisa akses row miliknya sendiri

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vault_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.screenshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_log ENABLE ROW LEVEL SECURITY;

-- Profiles: user hanya bisa read/update profile sendiri
DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
CREATE POLICY "profiles_select_own" ON public.profiles
  FOR SELECT USING (auth.uid() = id);
DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE USING (auth.uid() = id);
DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
CREATE POLICY "profiles_insert_own" ON public.profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

-- Vault items: user hanya bisa CRUD row miliknya
DROP POLICY IF EXISTS "vault_items_select_own" ON public.vault_items;
CREATE POLICY "vault_items_select_own" ON public.vault_items
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "vault_items_insert_own" ON public.vault_items;
CREATE POLICY "vault_items_insert_own" ON public.vault_items
  FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "vault_items_update_own" ON public.vault_items;
CREATE POLICY "vault_items_update_own" ON public.vault_items
  FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "vault_items_delete_own" ON public.vault_items;
CREATE POLICY "vault_items_delete_own" ON public.vault_items
  FOR DELETE USING (auth.uid() = user_id);

-- Notes
DROP POLICY IF EXISTS "notes_select_own" ON public.notes;
CREATE POLICY "notes_select_own" ON public.notes
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "notes_insert_own" ON public.notes;
CREATE POLICY "notes_insert_own" ON public.notes
  FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "notes_update_own" ON public.notes;
CREATE POLICY "notes_update_own" ON public.notes
  FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "notes_delete_own" ON public.notes;
CREATE POLICY "notes_delete_own" ON public.notes
  FOR DELETE USING (auth.uid() = user_id);

-- Settings
DROP POLICY IF EXISTS "settings_select_own" ON public.settings;
CREATE POLICY "settings_select_own" ON public.settings
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "settings_insert_own" ON public.settings;
CREATE POLICY "settings_insert_own" ON public.settings
  FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "settings_update_own" ON public.settings;
CREATE POLICY "settings_update_own" ON public.settings
  FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "settings_delete_own" ON public.settings;
CREATE POLICY "settings_delete_own" ON public.settings
  FOR DELETE USING (auth.uid() = user_id);

-- Screenshots
DROP POLICY IF EXISTS "screenshots_select_own" ON public.screenshots;
CREATE POLICY "screenshots_select_own" ON public.screenshots
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "screenshots_insert_own" ON public.screenshots;
CREATE POLICY "screenshots_insert_own" ON public.screenshots
  FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "screenshots_update_own" ON public.screenshots;
CREATE POLICY "screenshots_update_own" ON public.screenshots
  FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "screenshots_delete_own" ON public.screenshots;
CREATE POLICY "screenshots_delete_own" ON public.screenshots
  FOR DELETE USING (auth.uid() = user_id);

-- Sync log
DROP POLICY IF EXISTS "sync_log_select_own" ON public.sync_log;
CREATE POLICY "sync_log_select_own" ON public.sync_log
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "sync_log_insert_own" ON public.sync_log;
CREATE POLICY "sync_log_insert_own" ON public.sync_log
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ============== STORAGE BUCKET ==============
-- Buat bucket 'screenshots' untuk simpan gambar screenshot full size
-- (kalau belum ada, jalankan di Supabase Dashboard → Storage → New bucket)
-- Bucket harus public-readable supaya storage_url bisa diakses tanpa auth.

-- Insert bucket via SQL (kalau storage extension tersedia)
INSERT INTO storage.buckets (id, name, public)
VALUES ('screenshots', 'screenshots', true)
ON CONFLICT (id) DO NOTHING;

-- Storage policies: user hanya bisa upload/delete file di folder sendiri
-- Path format: 'user-<uuid>/<filename>'
-- v3.11.28: Tambah policy UPDATE untuk upsert (x-upsert: true header).
--   Sebelumnya hanya INSERT — upload ulang (file sudah ada) gagal 409 Conflict.
-- v3.11.28: Fix foldername condition — pakai (storage.foldername(name))[1] yang
--   lebih reliable. Fallback: pakai string prefix matching kalau foldername NULL.
DROP POLICY IF EXISTS "screenshots_upload_own" ON storage.objects;
CREATE POLICY "screenshots_upload_own" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'screenshots' AND
    (storage.foldername(name))[1] = 'user-' || auth.uid()::text
  );

-- v3.11.28: Policy UPDATE untuk upsert (overwrite file yang sudah ada)
DROP POLICY IF EXISTS "screenshots_update_own" ON storage.objects;
CREATE POLICY "screenshots_update_own" ON storage.objects
  FOR UPDATE USING (
    bucket_id = 'screenshots' AND
    (storage.foldername(name))[1] = 'user-' || auth.uid()::text
  );

DROP POLICY IF EXISTS "screenshots_read_public" ON storage.objects;
CREATE POLICY "screenshots_read_public" ON storage.objects
  FOR SELECT USING (bucket_id = 'screenshots');

DROP POLICY IF EXISTS "screenshots_delete_own" ON storage.objects;
CREATE POLICY "screenshots_delete_own" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'screenshots' AND
    (storage.foldername(name))[1] = 'user-' || auth.uid()::text
  );

-- ============== SEED DATA (opsional) ==============
-- Insert default settings untuk user pemilik (agung.kesmas@gmail.com)
-- Run SETELAH user pertama kali login via addon, supaya auth.users ada entry.

-- ============== DONE ==============
-- Verifikasi:
--   SELECT tablename FROM pg_tables WHERE schemaname = 'public';
--   Expected: profiles, vault_items, notes, settings, screenshots, sync_log
--
--   SELECT policyname, tablename FROM pg_policies WHERE schemaname = 'public';
--   Expected: 24 policies (4 per table x 6 tables, sync_log 2)
--
-- Untuk test RLS:
--   SET request.jwt.claim.sub = '<user-uuid>';
--   SELECT * FROM public.vault_items;  -- harus hanya return row milik user tersebut

-- ============== MIGRATION v3.11.26 (Issue #2) ==============
-- Tambah kolom annotation_note ke tabel screenshots yang sudah ada.
-- Jalankan kalau tabel screenshots sudah dibuat sebelumnya (tanpa kolom ini).
-- Safe to run multiple times (IF NOT EXISTS).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'screenshots' AND table_schema = 'public' AND column_name = 'annotation_note'
  ) THEN
    RAISE NOTICE 'Kolom annotation_note sudah ada di tabel screenshots — skip.';
  ELSE
    ALTER TABLE public.screenshots ADD COLUMN annotation_note TEXT;
    RAISE NOTICE 'Kolom annotation_note ditambahkan ke tabel screenshots.';
  END IF;
END $$;

-- ============== MIGRATION v3.11.28 (Issue #2: screenshot upload gagal) ==============
-- Tambah storage policy UPDATE untuk screenshots bucket.
-- Sebelumnya hanya INSERT — upload ulang (file sudah ada) gagal 409 Conflict
-- karena tidak ada policy UPDATE. x-upsert: true header butuh policy UPDATE.
--
-- Jalankan kalau schema sudah dibuat sebelumnya (tanpa policy ini).
-- Safe to run multiple times (DROP IF EXISTS + CREATE).

DROP POLICY IF EXISTS "screenshots_update_own" ON storage.objects;
CREATE POLICY "screenshots_update_own" ON storage.objects
  FOR UPDATE USING (
    bucket_id = 'screenshots' AND
    (storage.foldername(name))[1] = 'user-' || auth.uid()::text
  );

-- v3.11.28: Re-create INSERT policy juga (untuk pastikan condition benar)
DROP POLICY IF EXISTS "screenshots_upload_own" ON storage.objects;
CREATE POLICY "screenshots_upload_own" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'screenshots' AND
    (storage.foldername(name))[1] = 'user-' || auth.uid()::text
  );

-- v3.11.28: Verifikasi storage policies
-- Jalankan query ini untuk cek:
--   SELECT policyname, cmd FROM pg_policies WHERE tablename = 'objects' AND schemaname = 'storage';
--   Expected: screenshots_upload_own (INSERT), screenshots_update_own (UPDATE),
--             screenshots_read_public (SELECT), screenshots_delete_own (DELETE)

-- ============== MIGRATION v3.11.29 (Issue #1: Realtime sync + delete tracking) ==============
-- 3 masalah yang diperbaiki:
--   1. Tambah kolom deleted_at untuk tombstone-based delete sync
--      (kalau item dihapus di PC-1, PC-2 tahu dan hapus juga)
--   2. Enable Realtime replication untuk vault_items + notes tables
--      (supaya perubahan di PC-1 langsung terlihat di PC-2 via WebSocket)
--   3. Tambah trigger updated_at supaya updated_at auto-update on row change
--
-- Jalankan di Supabase SQL Editor (Dashboard → SQL → New query → Run).
-- Safe to run multiple times (semua pakai IF NOT EXISTS / ALTER).

-- 1. Tambah kolom deleted_at ke vault_items (untuk track soft-delete)
ALTER TABLE public.vault_items ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- 2. Tambah kolom deleted_at ke notes
ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- 3. Tambah kolom device_id ke vault_items + notes (untuk track device mana yang terakhir ubah)
ALTER TABLE public.vault_items ADD COLUMN IF NOT EXISTS device_id TEXT;
ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS device_id TEXT;

-- 4. Enable Realtime untuk vault_items + notes + settings
--    Supabase Realtime via WebSocket — perubahan langsung ter-push ke semua device
--    yang subscribe ke channel.
--    v3.11.32 FIX: Pakai DO block + cek sebelum ADD, supaya tidak error
--    "relation is already member of publication" kalau schema di-run ulang.
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['vault_items', 'notes', 'settings'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND tablename = tbl
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', tbl);
      RAISE NOTICE 'Added % to supabase_realtime publication', tbl;
    ELSE
      RAISE NOTICE '% already in supabase_realtime publication — skip', tbl;
    END IF;
  END LOOP;
END $$;

-- 5. Index untuk query realtime cepat (filter by user_id + deleted_at IS NULL)
CREATE INDEX IF NOT EXISTS idx_vault_items_user_not_deleted
  ON public.vault_items(user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notes_user_not_deleted
  ON public.notes(user_id) WHERE deleted_at IS NULL;

-- 6. Trigger auto-update updated_at
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

-- 7. Cleanup: hapus row yang sudah soft-delete >30 hari (opsional, via cron/job)
--    Tidak dijalankan otomatis di sini — user bisa jalankan manual kalau perlu:
--    DELETE FROM public.vault_items WHERE deleted_at IS NOT NULL
--      AND deleted_at < NOW() - INTERVAL '30 days';
--    DELETE FROM public.notes WHERE deleted_at IS NOT NULL
--      AND deleted_at < NOW() - INTERVAL '30 days';

-- ============== MIGRATION v3.11.31 (Issue #1: Delete registry + last-write-wins) ==============
-- User feedback: "harus ada logika device mana duluan yang dipake dan ada perubahan
-- di data / pergerakan data di addon nya maka itu yang dipake sebagai acuan terakhir
-- untuk disingkronkan di seluruh device, jangan mengulang ulang menampilkan yang
-- pernah dihapus."
--
-- Strategi baru (tombstone + delete registry lokal):
-- 1. Saat user hapus item → set deleted_at = NOW() di cloud (soft-delete/tombstone)
-- 2. Saat pull → item dengan deleted_at → hapus dari lokal + tambah ke delete registry lokal
-- 3. Saat push → SKIP item yang ada di delete registry (jangan timpa tombstone cloud)
-- 4. fullSync: PULL DULU, lalu PUSH (bukan push dulu) — supaya device tahu item
--    yang sudah dihapus sebelum push
--
-- Tidak ada perubahan struktur table di v3.11.31 (deleted_at + device_id sudah ada
-- dari v3.11.29). Yang berubah hanya logika sync di addon (lib/supabase-sync.js +
-- lib/storage.js).

-- Verifikasi kolom deleted_at + device_id ada (sudah dari v3.11.29, tapi cek ulang):
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name IN ('vault_items', 'notes') AND table_schema = 'public'
--   AND column_name IN ('deleted_at', 'device_id');
-- Expected: 4 rows (deleted_at + device_id untuk vault_items + notes)

-- v3.11.31: Index untuk query cepat filter deleted_at IS NOT NULL (saat pull
-- mengecek tombstone). Sudah ada idx_vault_items_user_not_deleted, tapi tambah
-- index untuk query deleted_at IS NOT NULL supaya pull lebih cepat.
CREATE INDEX IF NOT EXISTS idx_vault_items_deleted_at
  ON public.vault_items(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notes_deleted_at
  ON public.notes(deleted_at) WHERE deleted_at IS NOT NULL;

-- v3.11.31: Index untuk query by updated_at (last-write-wins comparison)
CREATE INDEX IF NOT EXISTS idx_vault_items_updated_at
  ON public.vault_items(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_updated_at
  ON public.notes(updated_at DESC);

-- v3.11.31: Cleanup function untuk hapus tombstone >30 hari
-- Bisa dijalankan manual atau via pg_cron (kalau Supabase project support).
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

-- Cara pakai cleanup function:
--   SELECT public.cleanup_old_tombstones(30);  -- hapus tombstone >30 hari
--   SELECT public.cleanup_old_tombstones(7);   -- hapus tombstone >7 hari (agresif)

-- v3.11.31: Trigger supaya device_id auto-set dari JWT claim (opsional, kalau user
-- punya device_id di JWT). Untuk sekarang, device_id di-set manual oleh addon.
-- Tidak ada trigger otomatis — addon yang set device_id saat upsert.
