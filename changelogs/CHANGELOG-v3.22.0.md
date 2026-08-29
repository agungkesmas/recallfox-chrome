# Changelog — RecallFox v3.22.0 (Fase 2: Upload File binary + Fase 1: kode program)

> **Base:** v3.21.25-stable · **Branch:** feat/upload-all-files
> **Tanggal:** 2026-08-29

## 🆕 Fitur utama: Upload File sekarang mendukung BINARY (PDF / Office / Gambar)

Sebelumnya upload file hanya untuk teks (.md/.txt/.json/.html/.csv/.yaml, maks 2MB)
dan dibaca dengan `file.text()` — kalau dipaksa untuk binary, bytes-nya rusak
permanen (mojibake) dan cloud sync bisa gagal (payload raksasa ke PostgREST).

Sekarang ada **dua keluarga file** dengan jalur terpisah:

| | TEKS | BINARY |
|---|---|---|
| Contoh | .md, .txt, .json, .html, .csv, .yaml, kode program | .pdf, .docx, .xlsx, .pptx (+.doc/.xls/.ppt/.odt/.ods/.odp), .png/.jpg/.gif/.webp/.avif/.bmp |
| Batas ukuran | 2 MB | **10 MB** |
| Cara baca | `file.text()` → masuk `item.body` | `arrayBuffer()` → blob utuh di key terpisah `rf_file_{id}` (pola `rf_shot_{id}`), `body` kosong |
| Vault JSON | berisi isi teks | HANYA metadata (tetap ringan — menghindari bug v3.11.33) |
| Cloud (Supabase) | body ikut row `vault_items` | body kosong; blob di-upload ke bucket `documents` dengan **ekstensi & MIME asli**, URL publik di `gdrive_file_url` |
| Unduh | dari body | dari blob lokal → fallback fetch URL cloud |
| Sisip ke AI | isi teks | URL publik + metadata (AI fetch sendiri) |
| Pratinjau | potongan teks | PDF & gambar **inline di sheet**; Office → ikon + ukuran (browser tidak bisa render, arahkan Unduh) |

### Perubahan kode
- **BARU `lib/file-kinds.js`** — pure module klasifikasi tipe file
  (`detectFileKind`, batas ukuran, ikon, ekstensi cloud, hint penolakan).
  Bisa di-test dengan Node tanpa browser.
- **`lib/storage.js`** — `addItem(item, opts)` terima `opts.fileBlob`;
  blob disimpan sebagai data URL di key `rf_file_{id}`; `body` binary dipaksa
  kosong; helper `getFileDataUrl`/`setFileDataUrl`/`deleteFileBlob`;
  `deleteItem` ikut membersihkan blob. `_blobToDataUrl` punya fallback
  non-FileReader (test Node).
- **`lib/supabase-sync.js`** — `_uploadFileDocument` resolve blob binary
  (in-memory `fileDataUrl` → key lokal), ekstensi cloud dari fileName asli
  (fallback map lengkap), push condition diperluas untuk binary.
- **`popup/popup.js`** — handler upload dua jalur; modal "Upload File"
  (bukan lagi "teks") dengan preview per tipe; tombol "Pratinjau" di item
  sheet; "Salin Konten" disembunyikan untuk binary; primary action binary =
  Unduh; inject binary = URL + metadata; ikon per jenis file; batch copy
  binary memakai URL; hint penolakan jelas (mis. ".zip — belum didukung").
- **`popup/popup.html` + `sidebar/sidebar.html`** — atribut `accept`
  diperluas ke semua format baru.

### Fase 1 (bonus, ikut sekalian): upload kode program & file teks lain
Whitelist teks diperluas: `.js .mjs .cjs .jsx .ts .tsx .vue .svelte .astro
.css .scss .sass .less .py .java .go .php .rb .cs .rs .c .h .cpp .cc .hpp
.kt .kts .swift .dart .lua .r .pl .ex .exs .sh .bash .zsh .bat .cmd .ps1
.sql .prisma .graphql .gql .proto .toml .xml .svg .ini .env .conf .cfg .log
.rtf .tsv .tex .lock .gitignore .dockerignore .dockerfile .editorconfig`,
plus nama tanpa ekstensi: `Dockerfile`, `Makefile`, `README`, `LICENSE`, dll.

## ⚠️ Yang BELUM didukung (ditolak dengan pesan jelas)
Arsip (.zip/.rar/.7z/.tar/.gz), audio (.mp3/.wav/.m4a), video (.mp4/.mkv/.mov),
e-book (.epub/.mobi), .exe/.dll/.apk/.iso, .psd/.ai, .db/.sqlite.
→ Kandidat Fase 3 kalau dibutuhkan.

## 🗄️ Supabase (LANGKAH MANUAL — sekali saja)
Bucket `documents` harus PUBLIC + policy RLS per-user. Jalankan
**[`docs/fix-documents-rls.sql`](../docs/fix-documents-rls.sql)** di Supabase
SQL Editor (file ini tadinya dirujuk pesan error tapi belum ada di repo).

Kuota: Supabase free = 1GB storage. Batas upload 10MB dipilih supaya aman.

## ⚠️ Catatan yang perlu diketahui
- **Backup/restore** saat ini hanya vault JSON — blob binary TIDAK ikut
  autobackup. (Kandidat Fase 3.)
- **Item binary antar versi**: item binary buatan v3.22.0 tidak bisa diunduh
  dari versi lama (body kosong). Arahkan update dulu di semua device.
- **Tidak ada permission manifest baru** — aman untuk review AMO/Web Store.

## 🧪 Testing
- `node test/file-kinds.test.mjs` — 41 assert klasifikasi/limit/helper (pure).
- `node test/storage-binary.test.mjs` — integrasi addItem binary dengan stub
  `browser`: vault JSON tetap kecil, blob utuh round-trip (ukuran & MIME),
  deleteItem membersihkan `rf_file_{id}`.
- Manual (belum otomatis): upload PDF 8MB + DOCX + PNG di Firefox & Chrome,
  cek unduh ulang (bandingkan ukuran file), cek sync antar browser
  (muncul di device lain + unduh via URL cloud), pratinjau PDF/gambar.
