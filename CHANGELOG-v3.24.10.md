# RecallFox v3.24.10 — Olah File Tagihan: Rekonsiliasi (fitur baru, 100% offline)

## Permintaan user
> "saya ada file ini. sering melakukan email/ wa ke petugas rumah sakit untuk
> rekonsiliasi tagihan. nah dari file tersebut saya mengurutkan dulu per nama
> rekening dengan mengurutkan nama/nomor rekening baru kemudian memecah file
> menjadi beberapa file sesuai dengan nama rekening tersebut. apakah di dalam
> 'urutkan pdf' ini diberi seperti tab saja jadi di bilah alat diganti namanya
> jadi 'olah file tagihan' > kemudian dalamnya ada tab yang bisa dipencet
> 'urutkan pdf' dan 'fitur baru' … apakah ini bisa dibuat dengan pola yang
> sama mengutamakan offline? dan menghasilkan beberapa file excel dalam bentuk
> .zip?" — plus: "diberikan fitur mengingat daftar rekening favorit yang sering
> dicentang atau di flag tandai sehingga kedepannya tidak capek dipecah semua
> file karena nyortirnya lumayan juga."

Data uji = berkas asli user `LAPORAN PEMBAYARAN JAMINAN (3).xls` (BIFF/PHPExcel
BPJS, 1.222 baris × 23 kolom, total Rp 3.692.067.670, 71 penerima).

## Restrukturisasi alat (tile diganti nama, tanpa mengubah alur lama)
- Tile grid Alat posisi 2 kini **"🧾 Olah File Tagihan"** — *Urutkan PDF &
  Rekonsiliasi · offline* (id internal `pdfsort` tetap — nol perubahan wiring).
- Halaman alat kini **shell 2 tab**: **📄 Urutkan PDF** | **🧮 Rekonsiliasi**;
  tab terakhir diingat (localStorage) untuk pembukaan berikutnya.
- Alur Urutkan PDF v3.24.9 **tidak diubah sama sekali** (konten pindah utuh ke
  tab 1); peningkatan: mesin PDF kini dimuat **malas** (saat berkas dipilih),
  pembukaan halaman lebih ringan.

## Fitur baru: tab "Rekonsiliasi" (offline-first)
- **Pilih berkas** `.xls / .xlsx / .csv` → analisa otomatis (SheetJS lokal):
  header dideteksi per baris via kolom wajib "Nama Rek. Penerima", baris
  kosong hantu & kolom kosong ekstra khas berkas PHPExcel BPJS dibuang.
- **4 chip ringkasan**: Tagihan · Penerima · Total Rp · Periode tanggal bayar.
- **Daftar penerima A-Z** (71 pada berkas uji): centang per penerima, kotak
  pencarian, tombol **Semua / Nihil / ★ Favorit**; bar aktif menampilkan
  `Dipilih: n penerima · m tagihan · Rp X`.
- **Rekening favorit persisten** (permintaan user): beri ★ pada penerima —
  tersimpan di `storage.local` per perangkat (offline). Berkas berikutnya yang
  memuat rekening favorit otomatis tercentang hanya favoritnya; tekan "Semua"
  bila ingin memecah semua.
- **Unduh ZIP**: `<nama berkas> - REKONSILIASI.zip` berisi
  `NN <Nama Rekening>.xlsx` — **semua 23 kolom asli + baris TOTAL** (numerik),
  baris diurut **Tgl Bayar → Kode Klaim** (nama berkas disanitasi dari karakter
  ilegal, duplikat diberi suffix (2)) — plus **REKAP.xlsx** (No, Nama Rekening,
  Bank, No. Rekening, Jml Tagihan, Total Bayar (Rp), Nama File + baris TOTAL).

## Mesin & vendor (lokal, tanpa jaringan)
- `pdftool/xlsx-engine.js` (baru): `parseWorkbook` → `analyze` → `buildZip`;
  `writeXlsxU8` menormalisasi output SheetJS (Uint8Array/ArrayBuffer/base64)
  + sanity-check signature `PK` — output rusak mustahil lolos tanpa terdeteksi;
  tanggal `dd-mm-yyyy`/`yyyy-mm-dd`/serial Excel dinormalkan untuk sortir.
- `vendor/xlsx.full.min.js` (SheetJS 0.18.5) + `vendor/fflate.min.js`
  (fflate 0.8.3, ZIP) — md5-identik di repo Chrome & Firefox.
- SheetJS terbukti membaca BIFF PHPExcel BPJS yang justru ditolak parser lain;
  **tanpa permission baru** (downloads & storage sudah ada sejak lama).

## Validasi
- **Uji Node 65/65 PASS** (`scripts/test_xlsx_engine_32410.js`) pada berkas
  asli: 1222 baris / 71 grup / total Rp 3.692.067.670 persis baseline Python;
  ZIP 72 entri terbaca balik (baris TOTAL, REKAP, subset favorit, kasus
  sintetis: nama kosong, nama ilegal, duplikat nama berkas, CSV, berkas acak,
  workbook tanpa kolom kunci, fallback penulisan).
- **E2E Playwright extension Chrome 36/36 PASS** (`scripts/test_e2e_32410.js`):
  13 tile posisi 2 berlabel baru; 2 tab + mesin malas; analisa XLS otomatis
  (chips 1222/71/Rp 3.692.067.670/periode, daftar 71); pencarian MEDIMAS → 1;
  ★ tersimpan di storage + tombol Favorit → 1 terpilih; unduh ZIP 481 KB
  filename `<nama> - REKONSILIASI.zip`, 72 entri, REKAP total sama dgn engine
  Node; tab Urutkan PDF tetap menganalisa PDF asli (13 pasien); halaman
  Pintasan & grid 13 alat tak terganggu; **0 pageerror**.
- `node --check` seluruh berkas tersentuh; **paritas penuh Chrome ↔ Firefox**
  (popup.js, xlsx-engine.js, 2 vendor — md5 identik).

## Berkas berubah
- `popup/popup.js` — 4 titik: tile, judul halaman, shell 2 tab, blok
  Rekonsiliasi di ekor (additif murni, tidak menyentuh alat lain).
- `pdftool/xlsx-engine.js` (baru) · `vendor/xlsx.full.min.js` (baru) ·
  `vendor/fflate.min.js` (baru) · `manifest.json` (versi) · berkas ini.
