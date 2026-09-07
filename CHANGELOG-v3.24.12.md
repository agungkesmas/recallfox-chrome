# v3.24.12 — UPLOAD FILE: DUAL DESTINATION (Database / Sementara + Auto-Expire)

## Permintaan user

> "aku ingin fitur upload file bisa dua, 1. masuk ke database/suppabase,
> 2. masuk ke situs upload file sementara seperti temp.sh atau lainnya.
> alur menambahkan filenya tapi tidak ada yang beda hanya saja untuk nomor 2
> akan hilang sendiri di vault sesuai dengan batas waktu di situs upload
> sementaranya. apakah ini bisa terwujud?"

**Terwujud.** Alur upload persis sama — sekarang dengan pilihan tujuan:

| Tujuan | Penyimpanan | Umur | Hilang otomatis |
|---|---|---|---|
| ☁️ **Database** (default) | Supabase Storage + vault_items | Permanen | Tidak (perilaku lama) |
| ⏳ **Sementara** (default: 3 hari) | litterbox.catbox.moe (URL publik) | 1 jam / 12 jam / 1 hari / 3 hari | **Ya** — item dihapus otomatis dari vault di semua device |

## Audit host sementara (8 Sep 2026) — kenapa BUKAN temp.sh

- **temp.sh** — upload OK (`POST https://temp.sh/upload` → URL teks), TAPI URL
  **tidak pernah serve file mentah**: GET selalu balik halaman HTML download
  page (dicek: curl biasa, browser UA, `?dl=1`, suffix `/download/`). Akibatnya
  fetch URL → HTML → zip/gambar **corrupt**, AI chat **tidak bisa membaca**
  isi URL, pratinjau rusak. Ditolak.
- **litterbox.catbox.moe** — `POST` multipart (`reqtype=fileupload`,
  `time=1h|12h|24h|72h`, `fileToUpload`) → URL teks polos
  `https://litter.catbox.moe/<id>.<ext>` yang serve **file mentah** (md5
  roundtrip zip identik), `Access-Control-Allow-Origin: *` (PWA bisa langsung
  upload tanpa proxy), ekstensi file dipertahankan. **Dipakai.**

## Perubahan

### Baru: `lib/temp-upload.js` (md5-identik repo Chrome)
Modul pure + testable (Node 18+): `TEMP_DURATIONS` (1h/12h/24h/72h),
`tempExpiresAt`, `isTempItem`, `isTempExpired`, `tempRemainingLabel`
(countdown "2j 15m" / "45m" / "kedaluwarsa"), `uploadToTempHost(blob, fileName,
durationId)` — POST multipart ke litterbox, validasi respons ketat (harus URL
litter/catbox, tolak HTML/error), return `{ok, url, host, expiresAt, duration}`.

### Model data item temp (zero schema change)
Disimpan di `item.source` (kolom JSONB yang sudah tersinkron):
`tempHost: 'litterbox'`, `tempUrl`, `tempExpiresAt: <ISO>`, `tempDuration:
'1h'|'12h'|'24h'|'72h'`. Pull/push/realtime antar device otomatis ikut.

### `popup/popup.js` (md5-identik repo Chrome)
- **Sheet Upload File**: segmented control tujuan `☁️ Database | ⏳ Sementara`
  + dropdown durasi (muncul saat Sementara) + catatan penjelas dinamis.
  Alur isi file (judul/tag/dropzone/preview) TIDAK berubah.
- **Simpan → Sementara**: upload ke litterbox dulu; gagal = item TIDAK dibuat
  (toast error, sheet tetap terbuka). Sukses → item `type:'file'` dengan
  source temp. Binary: TANPA blob lokal (file hidup di URL temp — hemat
  storage.local). Teks: body tetap diisi (Salin Konten/Sisip jalan).
  `uploadedFrom: 'addon-upload-temp'`.
- **resolveImageUrl**: kenali `source.tempUrl` → "Salin Tautan", "Unduh",
  "Pratinjau" (PDF/gambar), dan "Sisip" (URL) otomatis jalan untuk item temp.
- **Badge countdown** di kartu vault: `⏳ 2j 15m` (amber; merah saat < 1 jam /
  kedaluwarsa) dengan tooltip penjelas.
- **Banner info** di item sheet untuk file sementara: host, sisa waktu,
  penjelas auto-hapus di semua device.
- **Auto-cleanup**: `cleanupExpiredTempItems()` — scan vault, item temp yang
  `tempExpiresAt` lewat dihapus via `deleteItem()` (hapus lokal + hard-delete
  cloud + delete registry + realtime broadcast). Dipanggil saat popup dibuka
  + interval 60 detik selama popup terbuka, dengan toast notifikasi.

### `lib/supabase-sync.js` (kedua repo)
`directUpsertVaultItem`: item `type:'file'` dengan `source.tempHost` **skip**
`_uploadFileDocument` — file temp tidak di-upload ke Storage Supabase (yang
disinkron hanya metadata + URL temp). Metadata row tetap di-upsert normal.

### `manifest.json`
`3.24.11` → `3.24.12`. **Tanpa permission baru** (`<all_urls>` sudah mencakup
litterbox.catbox.moe).

## Validasi
- `node test/temp-upload.test.mjs` — **39/39 PASS** (kedua repo, termasuk
  LIVE upload ke litterbox + roundtrip isi file identik), sisa test lama
  `file-kinds.test.mjs` 54/54 PASS (regresi aman).
- `node --check` popup.js / temp-upload.js / supabase-sync.js OK.
- Paritas md5 antar repo: `popup.js`, `temp-upload.js`,
  `temp-upload.test.mjs` identik.
