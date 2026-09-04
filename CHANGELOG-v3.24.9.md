# RecallFox v3.24.9 — Urutkan PDF (fitur baru, 100% offline)

## Permintaan user
> "pelajari file ini, apakah bisa diterapkan/disisipkan fiturnya menjadi bukan
> versi web dan bukan versi login juga tapi bisa dijalankan dengan fitur
> offline firstnya … jadi ketika berkas pdf diupload auto convert versi pdf
> yang sudah diurutkan a to z gitu, liat file .tar nya dulu."

Sumber: workspace web Next.js "Urutkan PDF A-Z" (file .tar) — mesin teks
berkoordinat + sort nama pasien + halaman DAFTAR ISI, sudah tervalidasi E2E
pada berkas asli user ("MITRA PLUMBON MAJALE 6.1.pdf": 20 halaman → 13 pasien
→ 21 halaman). Permintaan diporting ke dalam addon: **tanpa server, tanpa
login, tanpa permission baru** — semuanya jalan lokal di perangkat.

## Fitur baru: alat "Urutkan PDF" (offline-first)

### UI Kombinasi (sesuai mockup yang disetujui)
- **Entry**: tile ke-13 "📄 Urutkan PDF" di grid Alat — posisi 2, tepat
  sebelah RecallTape (label "13 alat tersedia" ikut dikoreksi dari "11").
- **Halaman sidebar** (slide-in `.page` standar — pola halaman alat lain):
  pilih berkas → **analisa otomatis** (tanpa tombol terpisah) → kartu hasil:
  4 stat (Halaman / Pasien / Multi-klaim / Tak terbaca) + daftar pasien A-Z
  dengan rentang halaman + tombol **"Buka pratinjau & unduh di tab"**.
- **Tab penuh** `pdftool/pdftool.html`: badge "🔒 100% offline", statistik,
  switch **DAFTAR ISI (default ON)**, daftar 20 baris **geser manual**
  (drag & drop + tombol ▲▼ per baris), tombol **↺ A-Z** (reset urutan),
  **⬇ Unduh PDF (SORT A-Z)**, "Pilih berkas lain", nama berkas hasil.
- Tanpa handoff (tab dibuka langsung): drop-zone "Tarik & letakkan berkas"
  + analisa lokal di tab.

### Mesin (port 1:1 dari web, tervalidasi)
- `pdftool/engine.js` — port vanilla JS dari `pdf-extract.ts`,
  `pdf-sort.ts`, dan `api/reorder/route.ts`:
  - Rekonstruksi baris dari item teks berkoordinat (LINE_TOLERANCE 3.5 pt,
    SPACE_GAP 1.2 pt, urut kiri→kanan) — mengatasi urutan content-stream
    rusak (mis. "DIKI BAHTIARNama Peserta :").
  - Sort: Nama Peserta A-Z → no. klaim menaik (multi-klaim dirapatkan) →
    halaman tak terbaca paling akhir.
  - Halaman DAFTAR ISI (Helvetica, MARGIN 54, ROW_H 20, TOP_PAD 150,
    garis titik-titik, rentang halaman untuk klaim ganda) — layout identik
    dengan versi web.
  - Output: `<nama berkas> - SORT A-Z.pdf` via blob + downloads API
    (fallback anchor), `conflictAction: uniquify`.
- Vendor dibundel lokal: `vendor/pdf.min.js` + `vendor/pdf.worker.min.js`
  (pdfjs-dist 3.11.174 **legacy UMD**) dan `vendor/pdf-lib.min.js`
  (1.17.1) — versi persis sama dengan mesin web.
- Handoff sidebar→tab via **IndexedDB origin extension** (bytes + metas +
  order), dihapus dari store begitu dibaca (sekali pakai, privasi). Tab
  melakukan re-analisa berkas yang sama dan memakai hasil segar — anti
  data basi.

### Keamanan & kepatuhan CSP (MV3)
- Semua skrip lokal (`script-src 'self'` aman): tanpa inline script,
  tanpa remote script.
- pdf.js dipakai dengan **`isEvalSupported: false`** — tidak pernah
  memakai eval/new Function; worker dari URL extension dengan fallback
  fake-worker (`pdfjsWorker.WorkerMessageHandler`) bila worker gagal.
- Buffer yang diberikan ke pdfjs selalu **salinan** (pdfjs me-detach
  ArrayBuffer); buffer asli user tidak pernah diubah.
- **Tanpa permission baru** — `tabs`, `downloads`, `unlimitedStorage`
  sudah ada sebelumnya.

### Anti gagal
- Validasi order harus permutasi 0..n-1 sebelum menyusun; metas wajib
  sinkron dengan jumlah halaman sumber.
- Pesan error berbahasa Indonesia untuk setiap mode gagal (PDF rusak/
  terproteksi, berkas bukan PDF, mesin gagal dimuat, urutan tidak valid).
- Idempoten: memilih berkas yang sama lagi tetap terpicu (input di-reset);
  loader skrip ber-tandakan `data-rfsrc` sekali-muat per sesi halaman.
- `node --check` semua JS baru; uji Node 24/24 PASS; uji Playwright
  extension Chrome asli (PDF asli user) 29/29 PASS — termasuk alur
  sidebar→tab→unduh, geser manual (▲▼ + HTML5 drag native), DAFTAR ISI
  ON/OFF, dan **paritas konten Node↔Browser** (hash teks output sama:
  `fdb4f92e…`); bug `$$(…) is not defined` tertangkap & diperbaiki lewat
  uji drag native; 7 berkas baru/berubah **md5-identik** antar repo
  Chrome↔Firefox.

## Berkas berubah
| Berkas | Perubahan |
|---|---|
| `vendor/pdf.min.js`, `vendor/pdf.worker.min.js`, `vendor/pdf-lib.min.js` | BARU — vendor lokal (pdfjs-dist 3.11.174 legacy UMD + pdf-lib 1.17.1) |
| `pdftool/engine.js` | BARU — mesin port 1:1 (ekstrak, sort, DAFTAR ISI, susun PDF) |
| `pdftool/pdftool.html` / `pdftool.css` / `pdftool.js` | BARU — halaman tab penuh |
| `popup/popup.js` | +1 tile TOOLS (`pdfsort`, posisi 2), +1 nama halaman, +1 cabang `toolPage`, +blok v3.24.9 (loader runtime, handoff IDB, halaman ringkasan) — tidak ada handler lama yang disentuh |
| `sidebar/sidebar.html` | label "11 alat tersedia" → "13 alat tersedia" |
| `manifest.json` | versi 3.24.9 |

## Catatan Firefox
Paritas penuh dengan Chrome — ketujuh berkas baru/berubah md5-identik di
kedua repo; tidak ada jalur khusus Firefox yang disentuh (classic preload,
shim edit, background scripts tidak berubah).
