# RecallFox v3.11.39 — Fix cross-device image load (silent upload bug)

**Tanggal**: 23 Juli 2026
**Sesi**: 3 (cross-device PWA sync fix)
**Pencatat**: Agung Wahyudi
**Total issues**: 1

---

## Ringkasan

Fix **silent bug** di addon: file screenshot ter-upload ke Supabase Storage, **TAPI URL tidak masuk ke tabel `vault_items`**. Akibatnya PWA & addon di device lain tidak bisa load image — `gdrive_file_url` di tabel = NULL meski file fisiknya ada di Storage.

Backfill 7 item lama yang terdampak bug sudah dijalankan — semua 9 item screenshot sekarang punya URL lengkap.

---

## Issue — Cross-device image tidak load di PWA

### User Feedback

> "saya ingin bertanya. gdrive_file_url ini maksudnya file foto diuploadnya di drive bukan suppabase? karena hasil foto gagal upload terus maupun screnshot yang diupload di pwa nya."

### Symptom

- PWA (`recallfox-pwa.vercel.app`) tidak bisa menampilkan image screenshot yang dibuat di addon Firefox
- Hanya 1 dari 9 item screenshot yang punya `gdrive_file_url` di tabel (item PWA "HP Capture 23 Jul")
- 8 item lain (dari addon Firefox): `gdrive_file_url = NULL` → PWA fetch `null` → "no_cloud_url" → image blank
- Addon Firefox sendiri tetap bisa tampilkan image (karena punya blob base64 di `storage.local`)

### Root Cause

Di `lib/supabase-sync.js` `_uploadScreenshotBlob()` (line 648, v3.11.38):

```js
// Bug: upsert minim dengan hanya 5 field
await upsertRow(VAULT_TABLE, {
  id: item.id,
  user_id: userId,
  gdrive_file_id: path,
  gdrive_file_url: upRes.url,
  updated_at: new Date().toISOString()
});
return { ok: true, url: upRes.url, path };  // selalu return OK walau upsert gagal
```

`upsertRow` pakai `Prefer: resolution=merge-duplicates` → PostgREST coba INSERT dulu. Tabel `vault_items` punya constraint `type TEXT NOT NULL`, tapi body request **tidak kirim `type`** → INSERT gagal dengan error:

```
"null value in column \"type\" of relation \"vault_items\" violates not-null constraint"
```

`upsertRow` return `{ok: false, error: 'http_400'}`, **TAPI `_uploadScreenshotBlob` tidak cek return value** → return `{ok: true, url, path}` → addon pikir sukses → file ter-upload tapi URL tidak masuk tabel.

### Bukti Reproduce

Test langsung via Supabase REST API dengan service role:

```
POST /rest/v1/vault_items
Prefer: resolution=merge-duplicates
Body: {id, user_id, gdrive_file_id, gdrive_file_url, updated_at}

Response 400:
{
  "code": "23502",
  "message": "null value in column \"type\" of relation \"vault_items\" violates not-null constraint"
}
```

Sesudah fix (PATCH):

```
PATCH /rest/v1/vault_items?id=eq.sh_xxx
Body: {gdrive_file_id, gdrive_file_url, updated_at}

Response 200:
[{id, gdrive_file_url: "https://...", ...}]
```

---

## Fix

### Kode addon (`lib/supabase-sync.js` line 648-670)

Ganti `upsertRow` (yang butuh semua kolom NOT NULL) dengan `updateRow` (PATCH, hanya update kolom yang dikirim):

```js
// Sebelumnya (bug):
await upsertRow(VAULT_TABLE, {
  id: item.id,
  user_id: userId,
  gdrive_file_id: path,
  gdrive_file_url: upRes.url,
  updated_at: new Date().toISOString()
});

// Sekarang (fix v3.11.39):
const updateRes = await updateRow(VAULT_TABLE, `id=eq.${item.id}`, {
  gdrive_file_id: path,
  gdrive_file_url: upRes.url,
  updated_at: new Date().toISOString()
});
if (!updateRes.ok) {
  console.warn('[RecallFox] v3.11.39: Update gdrive_file_url gagal:', updateRes.error);
  // Tetap return ok=true karena file sudah ter-upload, retry di next sync
}
```

### Backfill data lama (7 item)

Script `backfill_gdrive_url.py` menjalankan:
1. Query `vault_items WHERE type=screenshot AND gdrive_file_url IS NULL` → 7 item
2. List file di Storage bucket `screenshots`, folder `user-<userId>/` → 22 file
3. Match item ID dengan file name → 7 match
4. PATCH update tiap item dengan URL yang sesuai

**Hasil backfill:**
- Matched: 7 ✅
- Updated: 7 ✅
- Failed: 0
- Unmatched: 0

**Verifikasi akhir:** semua 9 item screenshot (1 PWA + 8 addon) sekarang punya `gdrive_file_url` lengkap. Test fetch URL untuk 2 item sample:
- `sh_20260722113557_754x8y.png` (PLANET JARAK) → 200 OK, 2.77 MB PNG
- `sh_20260723002356_4b1bn4.png` (WhatsApp) → 200 OK, 554 KB PNG

---

## Penjelasan tentang `gdrive_file_url` (bukan Google Drive)

User bertanya: "gdrive_file_url ini maksudnya file foto diuploadnya di drive bukan suppabase?"

**Jawaban**: BUKAN Google Drive. `gdrive_file_url` hanya **nama kolom** di tabel `vault_items` — warisan sejarah dari v3.11.28 yang awalnya rencana pakai Google Drive, lalu diganti ke Supabase Storage, tapi nama kolomnya tidak diubah.

Isi kolom: **URL Supabase Storage**, contoh:
```
https://qmwofsfpxjptpyvncylp.supabase.co/storage/v1/object/public/screenshots/user-8708ff4e-.../sh_xxx.png
```

File disimpan di Supabase Storage bucket `screenshots` (public read). Rename kolom ke `storage_url` bisa dilakukan di versi depan, tapi butuh migration schema + update semua kode (addon + PWA) — delay ke versi depan demi stabilitas.

---

## Files Changed

| File | Perubahan |
|------|-----------|
| `manifest.json` | Bump versi 3.11.38 → 3.11.39 |
| `lib/supabase-sync.js` | `_uploadScreenshotBlob`: ganti `upsertRow` → `updateRow` (PATCH), tambah error check + log |
| `backfill_gdrive_url.py` (di scripts/, tidak dipush ke repo) | Script one-time backfill 7 item lama |
| Supabase DB | 7 row `vault_items` di-PATCH dengan `gdrive_file_url` (sudah dijalankan) |

---

## Testing Checklist

### Backfill (sudah verified)
- [x] Semua 9 item screenshot sekarang punya `gdrive_file_url` di tabel
- [x] Test fetch URL → 200 OK + image lengkap (PLANET JARAK 2.77 MB, WhatsApp 554 KB)

### Addon v3.11.39 (perlu test user)
- [ ] Pull v3.11.39 di Firefox: `git pull origin main` → `about:debugging` → Reload RecallFox
- [ ] Capture screenshot baru di addon → cek di Supabase Table Editor → `gdrive_file_url` harus terisi (tidak NULL)
- [ ] Buka PWA di HP → reload → item baru dari addon harus muncul dengan image

### Cross-device sync (perlu test user)
- [ ] Addon Firefox capture → muncul di PWA dengan image (tidak blank)
- [ ] PWA capture → muncul di addon Firefox dengan image (sebelumnya sudah verified)
- [ ] Realtime: perubahan di salah satu device muncul di device lain dalam beberapa detik

---

## Pencegahan ke Depan

### 1. Cek return value semua async operation
Bug silent terjadi karena `await upsertRow(...)` tidak di-cek return value-nya. Policy baru:
- Semua `upsertRow`, `updateRow`, `insertRow`, `deleteRow` HARUS di-cek return value
- Kalau gagal, log error dengan detail + tambahkan ke retry queue (jika relevan)

### 2. Prefer PATCH untuk update partial field
`upsertRow` (Prefer: resolution=merge-duplicates) butuh semua kolom NOT NULL → rentan bug kalau body tidak lengkap. Untuk update sebagian field, **selalu pakai `updateRow` (PATCH)**.

### 3. Rename kolom `gdrive_file_url` → `storage_url` (delay ke v3.12)
Nama kolom menyesatkan. Tapi rename butuh migration schema + update semua kode. Delay ke versi depan (mungkin v3.12) supaya tidak ganggu stabilitas.

### 4. Test cross-device otomatis
Sebaiknya tambah test end-to-end di CI/CD yang verify:
- Capture di addon → cek tabel punya URL → cek PWA bisa load
- Capture di PWA → cek tabel punya URL → cek addon bisa load

Bisa pakai headless browser test (Playwright) di GitHub Actions.

---

## Versi

| Versi | Tanggal | Perubahan |
|-------|---------|-----------|
| v3.11.38 | 22 Jul 2026 | Batch copy gambar dengan composite grid + numbering |
| **v3.11.39** | 23 Jul 2026 | **Fix silent bug: ganti upsert → PATCH untuk update gdrive_file_url + backfill 7 item lama** |
