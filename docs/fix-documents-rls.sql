-- fix-documents-rls.sql — RecallFox v3.22.0 (Fase 2: Upload File binary)
-- =====================================================================
-- File ini DULUNYA dirujuk oleh pesan error di lib/supabase-sync.js
-- ("jalankan SQL fix-documents-rls.sql") tapi belum ada di repo.
-- Sekarang dibuat lengkap: memastikan bucket 'documents' ADA, PUBLIC,
-- dan policy RLS per-user (folder user-{uid}/...).
--
-- Cara pakai:
--   1. Buka https://supabase.com/dashboard/project/<proyek>/sql/new
--   2. Paste seluruh isi file ini, klik Run
--   3. Output harus "Success. No rows returned."
--
-- Catatan: file_size_limit diset 25MB (upload addon maks 10MB, sisanya
-- ruang untuk thumbnail/metadata). Kalau mau batas lain, ubah angkanya.

-- 1) Pastikan bucket 'documents' ada dan PUBLIC
--    (URL publik dipakai untuk "Salin Tautan" / inject AI:
--     https://<proyek>.supabase.co/storage/v1/object/public/documents/...)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', true, 26214400, null)
on conflict (id) do update set public = true, file_size_limit = 26214400;

-- 2) Policy SELECT — user hanya bisa baca file di folder miliknya
drop policy if exists "recallfox documents select own" on storage.objects;
create policy "recallfox documents select own"
on storage.objects for select to authenticated
using (
  bucket_id = 'documents'
  and (storage.foldername(name))[1] = 'user-' || auth.uid()::text
);

-- 3) Policy INSERT — upload file baru ke folder miliknya
drop policy if exists "recallfox documents insert own" on storage.objects;
create policy "recallfox documents insert own"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'documents'
  and (storage.foldername(name))[1] = 'user-' || auth.uid()::text
);

-- 4) Policy UPDATE — overwrite (addon pakai header x-upsert: true)
drop policy if exists "recallfox documents update own" on storage.objects;
create policy "recallfox documents update own"
on storage.objects for update to authenticated
using (
  bucket_id = 'documents'
  and (storage.foldername(name))[1] = 'user-' || auth.uid()::text
)
with check (
  bucket_id = 'documents'
  and (storage.foldername(name))[1] = 'user-' || auth.uid()::text
);

-- 5) Policy DELETE — hapus file saat item vault dihapus
drop policy if exists "recallfox documents delete own" on storage.objects;
create policy "recallfox documents delete own"
on storage.objects for delete to authenticated
using (
  bucket_id = 'documents'
  and (storage.foldername(name))[1] = 'user-' || auth.uid()::text
);

-- Verifikasi (opsional):
-- select name, public, file_size_limit from storage.buckets where id = 'documents';
-- select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'recallfox documents%';
