-- fix-documents-rls.sql — RecallFox v3.22.0 (Fase 2: Upload File binary)
-- =====================================================================
-- File ini DULUNYA dirujuk oleh pesan error di lib/supabase-sync.js
-- ("jalankan SQL fix-documents-rls.sql") tapi belum ada di repo.
-- Sekarang dibuat lengkap: memastikan bucket 'documents' ADA, PUBLIC,
-- policy BACA PUBLIK (supaya AI bisa fetch URL tanpa login), dan policy
-- TULIS RLS per-user (folder user-{uid}/...).
--
-- IDEMPOTENT — aman dijalankan ulang kapan pun (drop policy if exists +
-- on conflict do update). Tidak menyentuh bucket lain, tabel lain, atau
-- policy lain kecuali 6 policy bernama "recallfox documents ...".
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

-- 2) Policy BACA PUBLIK — file bisa di-fetch lewat URL tanpa login.
--    Dipakai saat AI mengakses URL dari "Salin Tautan" / inject.
--    Trade-off: siapa pun yang punya URL bisa membaca file. Ini memang
--    desain RecallFox (URL dikirim ke AI chat); path berisi UUID acak
--    (user id + item id) sehingga praktis tidak bisa ditebak.
--    Tulis/ubah/hapus TETAP dibatasi ke pemilik folder (policy 4-6).
drop policy if exists "recallfox documents public read" on storage.objects;
create policy "recallfox documents public read"
on storage.objects for select
using (bucket_id = 'documents');

-- 3) Policy SELECT own — fallback: kalau bucket di-set private nanti,
--    user tetap bisa membaca file di folder miliknya sendiri (via addon).
drop policy if exists "recallfox documents select own" on storage.objects;
create policy "recallfox documents select own"
on storage.objects for select to authenticated
using (
  bucket_id = 'documents'
  and (storage.foldername(name))[1] = 'user-' || auth.uid()::text
);

-- 4) Policy INSERT — upload file baru hanya ke folder miliknya
drop policy if exists "recallfox documents insert own" on storage.objects;
create policy "recallfox documents insert own"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'documents'
  and (storage.foldername(name))[1] = 'user-' || auth.uid()::text
);

-- 5) Policy UPDATE — overwrite hanya folder miliknya (addon pakai x-upsert: true)
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

-- 6) Policy DELETE — hapus file hanya di folder miliknya
drop policy if exists "recallfox documents delete own" on storage.objects;
create policy "recallfox documents delete own"
on storage.objects for delete to authenticated
using (
  bucket_id = 'documents'
  and (storage.foldername(name))[1] = 'user-' || auth.uid()::text
);

-- Verifikasi (opsional):
-- select name, public, file_size_limit from storage.buckets where id = 'documents';
-- select policyname, cmd from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'recallfox%' order by policyname;
