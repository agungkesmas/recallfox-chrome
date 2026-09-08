# v3.24.13 — URUTKAN PDF: FIX URUT ABJAD PENUH SELURUH HURUF

## Permintaan user

> "perhatikan file berikut dan fitur pengurutan pdf pada addon. itu sepertinya
> hanya membaca abjad a,b,c di bagian depan namanya saja, tapi tidak
> memperhatikan huruf berikutnya adi, andi > d lebih dulu dari n. coba perbaiki."

## Perbaikan

Perbandingan nama pada mesin sort (`pdftool/engine.js`) diperkuat menjadi
**urut abjad penuh seluruh huruf** — bukan sekadar urutan kode-unit:

- **`Intl.Collator('id', {sensitivity:'base', numeric:true})`** membandingkan
  nama huruf-demi-huruf sesuai kamus abjad Indonesia: `ADI` < `ANDI` (huruf
  ke-2 `d` < `n`), `DEDE` < `DEVI` (`d` < `v`), `IDA` < `IIN` (`d` < `i`),
  `NOORA` < `NOVA` (`o` < `v`), `RISKA` < `RIVELGA` < `ROHIMAN`, `SUCI` <
  `SUDARMA` (`c` < `d`) — semuanya kini dijamin memperhatikan huruf KEDUA dan
  seterusnya.
- **Tak peka besar-kecil huruf** dan **angka alami**: `SUCI 2` < `SUCI 10`
  (sebelumnya kode-unit menaruh `10` sebelum `2`).
- Kunci sort dinormalisasi (`normSortName`): NFKC → rapatkan spasi ganda →
  trim → uppercase, sehingga varian penulisan (`  ADI`, `ADI  KUSNADI`) tidak
  mengganggu urutan.
- Urutan lama yang sudah benar dipertahankan: nama terbaca A-Z dulu →
  **multi-klaim satu pasien dirapatkan (urut no. klaim menaik)** → halaman
  **nama tak terbaca selalu paling akhir** (urutan asli sebagai penentu
  terakhir, deterministik).
- Fallback aman bila `Intl` tidak tersedia: perbandingan kode-unit pada nama
  yang sudah dinormalisasi + di-uppercase (tetap seluruh huruf).

## Root-cause catatan

Analisis pada berkas contoh user (14 halaman penetapan JKK BPJS, nama pasien
ANDRI SUCIPTO s.d. YOHAN RIYANTO PUTRA) menunjukkan keluaran A-Z sudah benar
di level perbandingan string; perbaikan ini membuat jaminan urut-abjad penuh
**eksplisit, teruji, dan kebal kasus tepi** (kapitalisasi, spasi, angka,
tanda baca, locale) — plus satu regresi grup "tak terbaca" yang tertangkap
dan dikunci oleh suite uji baru.

## Validasi

- **Suite uji baru `test/pdfsort.test.mjs` — 32/32 PASS** (kedua repo):
  - Kasus eksplisit user: `ANDI, ADI` → `ADI, ANDI` (input apapun, hasil sama);
  - Semua 13 pasangan bersebelahan dari dokumen asli user terurut benar;
  - Kasus sulit: kapitalisasi campur, spasi tepi/ganda, angka alami
    (`SUCI 2` < `SUCI 10`), tanda hubung, keluarga `ADI1/ADI2/ADI10/ANDI`;
  - Multi-klaim: `SUDARMA` ×3 → urut no. klaim menaik;
  - Tak-terbaca: selalu paling akhir (regresi grup terkunci);
  - **200× shuffle** 14 nama → hasil selalu identik referensi `Collator('id')`;
  - **E2E dokumen asli user**: 14 halaman disusun ulang ke urutan asli BPJS
    (dari marker "Halaman: x/14") → analisa → nama ter-ekstrak lengkap 14/14
    → hasil sort == abjad penuh → `buildSortedPdf` (15 hal + DAFTAR ISI) →
    halaman keluaran terverifikasi A-Z penuh.
- Regresi fitur lain tetap hijau: `file-kinds` 54/54, `temp-upload` 39/39.
- `node --check pdftool/engine.js` OK (kedua repo).
- Paritas md5 `pdftool/engine.js` Firefox ↔ Chrome terjaga.
