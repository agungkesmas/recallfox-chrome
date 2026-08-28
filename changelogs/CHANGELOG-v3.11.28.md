# Changelog v3.11.28 — Fix format copy sidebar + Screenshot upload Supabase

> **Versi:** 3.11.28
> **Baseline:** v3.11.27 (commit cfefa60)
> **Sumber catatan:** Log Troubleshooting — Aplikasi Web & Addon (Sesi terakhir, 2 issues)

---

## 🐛 2 Fix dari Log Troubleshooting Sesi terakhir

### Issue #1 — Standardisasi format copy sidebar = format preview modal

**User feedback:**
> "format paste ketika saya memencet tombol kopi gambar + keterangan di preview modal sangat sangat sangat bagus bentuknya... tapi kalau pakai sidebar itu jelek jelek jelek banget... banyak yang ga muncul ya kan? nah standarkan dong, disamakan format kopi paste nya yang sidebar ke menjadi selengkap tekan tombol gambar + keterangan di preview modal. berlaku juga untuk batch harus sama formatnya"

**Root cause:**
Format copy dari sidebar (background.js handler `COPY_SCREENSHOT_TO_CLIPBOARD` dan `COPY_SCREENSHOTS_BATCH`) berbeda dengan format dari preview modal (overlay.js). Perbedaan:

| Aspect | Sidebar (lama) | Preview Modal (bagus) |
|--------|---------------|----------------------|
| 📝 Catatan anotasi | TIDAK ada | Ada (kalau ada `annotationNote`) |
| Footer | "Disimpan di RecallFox Vault" | "Ditangkap oleh RecallFox" |
| HTML styling | Basic | Konsisten dengan overlay (rounded img, color-coded) |
| Batch HTML | `<h2>` + `<hr>` basic | `<div>` wrapper + `<hr style="...">` + color-coded |

**Fix:**

#### A. Single copy (`COPY_SCREENSHOT_TO_CLIPBOARD`)
- Tambah `annotationNote` field (dari `item.annotationNote` atau `item.source.annotationNote`)
- Tambah baris `📝 Catatan: <note>` di textPlain (kalau ada)
- Tambah `<p style="...background:#fef3c7...">📝 <note></p>` di textHtml (kalau ada)
- Ganti footer "Disimpan di RecallFox Vault" → "Ditangkap oleh RecallFox"
- Ganti footer HTML "RecallFox Vault" → "RecallFox"

#### B. Batch copy (`COPY_SCREENSHOTS_BATCH`)
- Markdown: tambah `📝 Catatan:` line + `Ditangkap oleh RecallFox` footer per screenshot
- HTML: ganti ke format overlay.js style:
  - Wrapper `<div style="font-family:...">` di luar
  - `<h1>📷 Screenshot Bundle</h1>` (bukan `<h1>` tanpa emoji)
  - Per screenshot: `<p><img style="border-radius:8px;border:1px solid #e7e5e4"></p>` (bukan `<h2>` + `<p>`)
  - `<strong>📸 N. Title</strong>` (dengan emoji + nomor)
  - `🔗 <a>`, `🕒 <date>`, `📝 <note>` (kalau ada), `🔧 <mode> · <dims> · RecallFox`
  - `<hr style="border:none;border-top:1px solid #e7e5e4;margin:16px 0">` (bukan `<hr>` biasa)

**Format sekarang (single & batch) sama persis dengan preview modal:**

```
📸 Screenshot — <pageTitle>
Sumber: <pageUrl>
Waktu: <tanggal full>
Mode: <modeLabel> · <dims>
📝 Catatan: <note>  (kalau ada)
Ditangkap oleh RecallFox
```

```html
<div style="font-family:-apple-system,system-ui,sans-serif;font-size:13px;color:#1c1917">
  <p style="margin:0 0 6px"><img src="..." style="max-width:100%;border-radius:8px;border:1px solid #e7e5e4"/></p>
  <p style="margin:8px 0 2px"><strong>📸 <pageTitle></strong></p>
  <p style="margin:0 0 2px;color:#57534e">🔗 <a href="<url>"><url></a></p>
  <p style="margin:0 0 2px;color:#57534e">🕒 <tanggal></p>
  <p style="margin:0 0 2px;color:#92400e;background:#fef3c7;padding:4px 8px;border-radius:4px">📝 <note></p>  (kalau ada)
  <p style="margin:0;color:#78716c">🔧 <modeLabel> · <dims> · RecallFox</p>
</div>
```

---

### Issue #2 — Fix screenshot tidak masuk Supabase Storage

**User feedback:**
> "pikirkan database di supabasenya misalkan harus ada perubahan SQL skriptnya... terutama gambar tu kok ga bisa masuk masuk ke server suppabase ya ketika sync... HARUS BERHASIL KARENA SUDAH BERULANG ULANG GAGAL TERUS FUNGSI INI!!!! BUANG WAKTU"

**Root causes (3 bug):**

#### Bug A: Missing `x-upsert: true` header
Supabase Storage default-nya **reject upload kalau file sudah ada** (409 Conflict). Saat user sync ulang (file `user-<uuid>/<screenshot-id>.png` sudah ada dari sync sebelumnya), upload gagal.

**Fix:** Tambah header `x-upsert: true` di `uploadFile()` supaya upload overwrite file yang sudah ada.

#### Bug B: Storage policy hanya INSERT, tidak UPDATE
SQL schema hanya punya policy `screenshots_upload_own` (FOR INSERT). Saat `x-upsert: true` header dipakai, Supabase butuh policy FOR UPDATE juga. Tanpa policy UPDATE, upsert ditolak RLS.

**Fix:** Tambah policy `screenshots_update_own` (FOR UPDATE) di SQL schema. Plus migration script untuk user yang sudah run schema lama.

#### Bug C: Error reporting minim
Sebelumnya, kalau upload gagal, error hanya `http_409` atau `http_403` tanpa detail. User tidak bisa tahu penyebab sebenarnya.

**Fix:**
- Parse error body JSON untuk extract `message`/`error` field yang lebih jelas
- Log detail upload (id, path, size, type, bucket) sebelum dan sesudah upload
- Return error object dengan `detail`, `bucket`, `path`, `blobSize` supaya bisa debug
- Tambah validasi `empty_blob` sebelum upload
- `pushToSupabase` sekarang log error screenshot dengan detail lengkap

---

## 🔧 Perubahan SQL Schema (WAJIB RUN ULANG)

User **WAJIB** run ulang `supabase-schema.sql` di Supabase SQL Editor supaya storage policy UPDATE tersedia. Tanpa ini, upload screenshot akan tetap gagal.

### Cara update:
1. Buka https://supabase.com/dashboard/project/qmwofsfpxjptpyvncylp/sql/new
2. Login dengan akun Supabase Anda
3. Paste isi `supabase-schema.sql` (sudah include migration v3.11.28), klik **Run**
4. Verifikasi storage policies:
   ```sql
   SELECT policyname, cmd FROM pg_policies
   WHERE tablename = 'objects' AND schemaname = 'storage'
   AND policyname LIKE 'screenshots%';
   ```
   Expected output:
   - `screenshots_upload_own` | `INSERT`
   - `screenshots_update_own` | `UPDATE`  ← BARU v3.11.28
   - `screenshots_read_public` | `SELECT`
   - `screenshots_delete_own` | `DELETE`

### Atau run migration saja (kalau schema sudah ada):
```sql
-- Migration v3.11.28 — tambah storage policy UPDATE
DROP POLICY IF EXISTS "screenshots_update_own" ON storage.objects;
CREATE POLICY "screenshots_update_own" ON storage.objects
  FOR UPDATE USING (
    bucket_id = 'screenshots' AND
    (storage.foldername(name))[1] = 'user-' || auth.uid()::text
  );
```

---

## File yang Diubah (v3.11.28)

| File | Jenis | Ringkasan |
|---|---|---|
| `manifest.json` | Modify | Bump 3.11.27 → 3.11.28 |
| `background.js` | Modify | Format copy single (`COPY_SCREENSHOT_TO_CLIPBOARD`) + batch (`COPY_SCREENSHOTS_BATCH`) disamakan dengan overlay.js — tambah annotationNote, footer "Ditangkap oleh RecallFox", styling konsisten |
| `lib/supabase-client.js` | Modify | `uploadFile()` tambah `x-upsert: true` header + `cache: no-store` + validasi empty_blob + parse error body JSON + return detail error |
| `lib/supabase-sync.js` | Modify | `_uploadScreenshotBlob()` tambah logging detail + error reporting lengkap. `pushToSupabase()` log error screenshot dengan path + blobSize |
| `supabase-schema.sql` | Modify | Tambah storage policy `screenshots_update_own` (FOR UPDATE). Migration script v3.11.28 di akhir file |
| `README.md` | Modify | Update header ke v3.11.28 |
| `CHANGELOG-v3.11.28.md` | **NEW** | File ini |

---

## Testing Checklist

### Issue #1 — Format copy sidebar = preview modal
- [ ] Load addon di Firefox (`about:debugging` → Load Temporary Add-on → `manifest.json`)
- [ ] Capture screenshot dengan annotation note (tulis catatan di editor anotasi)
- [ ] Buka vault → chip "Media" → klik screenshot → "📋 Salin + Keterangan"
- [ ] Paste di Google Docs rich text → harus muncul:
  - Gambar (rounded, border)
  - "📸 <pageTitle>" (bold)
  - "🔗 <url>" (link)
  - "🕒 <tanggal full>"
  - "📝 <catatan anotasi>" (kalau ada, background kuning)
  - "🔧 <mode> · <dims> · RecallFox"
- [ ] Paste di Notepad (plain text) → harus muncun format lengkap dengan "Ditangkap oleh RecallFox"
- [ ] Test batch: centang 2-3 screenshot → "📋 Copy + Keterangan" → paste di Google Docs
  - Semua screenshot muncul dengan format sama (gambar + title + url + waktu + note + footer)
  - Antara screenshot ada `<hr>` pemisah
- [ ] Bandingkan dengan format dari preview modal (capture screenshot → klik "Salin + Keterangan" di modal) → harus SAMA PERSIS

### Issue #2 — Screenshot masuk Supabase Storage
- [ ] **WAJIB: Run ulang `supabase-schema.sql`** di Supabase SQL Editor (untuk dapat policy UPDATE)
- [ ] Verifikasi storage policies (lihat query di atas) — `screenshots_update_own` harus ada
- [ ] Login Supabase di addon → klik "Push ke Cloud"
- [ ] Cek toast — harus "✓ Push berhasil · X items, Y catatan, Z screenshot"
- [ ] Buka Supabase Dashboard → Storage → bucket `screenshots` → folder `user-<uuid>/`
  - File `<screenshot-id>.png` harus muncul
- [ ] Buka Supabase Dashboard → Table Editor → `screenshots` table
  - Row dengan `storage_path` + `storage_url` harus muncul
- [ ] Buka Supabase Dashboard → Table Editor → `vault_items`
  - Row screenshot harus punya `gdrive_file_url` = storage_url Supabase
- [ ] Test sync ulang (push kedua kalinya) — harus TIDAK gagal 409 Conflict
  - Sebelumnya: gagal karena file sudah ada + tidak ada policy UPDATE
  - Sekarang: sukses karena `x-upsert: true` + policy UPDATE
- [ ] Buka Browser Console (F12) — harus ada log:
  - `[RecallFox/Supabase] Uploading screenshot: {id, path, size, type, bucket}`
  - `[RecallFox/Supabase] Screenshot upload OK: <url>`
- [ ] Kalau ada error, cek detail di console:
  - `[RecallFox/Supabase] Screenshot upload FAILED: {error, detail, path, bucket, blobSize}`

---

## Architecture: Format copy sekarang konsisten

```
┌─────────────────────────────────────────────────────────────┐
│  Format copy screenshot (single & batch) — v3.11.28         │
├─────────────────────────────────────────────────────────────┤
│  textPlain:                                                 │
│    📸 Screenshot — <title>                                  │
│    Sumber: <url>                                            │
│    Waktu: <tanggal full>                                    │
│    Mode: <mode> · <dims>                                    │
│    📝 Catatan: <note>  (kalau ada)                          │
│    Ditangkap oleh RecallFox                                 │
│                                                             │
│  textHtml:                                                  │
│    <div style="font-family:...">                            │
│      <p><img style="border-radius:8px;border:1px solid..."> │
│      <p><strong>📸 <title></strong></p>                     │
│      <p>🔗 <a href="<url>"><url></a></p>                    │
│      <p>🕒 <tanggal></p>                                    │
│      <p>📝 <note></p>  (kalau ada, bg kuning)               │
│      <p>🔧 <mode> · <dims> · RecallFox</p>                  │
│    </div>                                                   │
│                                                             │
│  image/png: blob gambar (untuk paste ke image editor)      │
└─────────────────────────────────────────────────────────────┘
```

Sumber format: `content/overlay.js` (preview modal) — dipakai konsisten di:
- `background.js` → `COPY_SCREENSHOT_TO_CLIPBOARD` (single, dari vault)
- `background.js` → `COPY_SCREENSHOTS_BATCH` (batch, dari vault)
- `background.js` → `COPY_DATAURL_TO_CLIPBOARD` (dari preview modal, sebelumnya sudah pakai format ini)

---

**Status:** Semua 2 fix selesai ✓ · **Baseline:** v3.11.27 · **Validasi:** node --check (0 error semua file)
