/**
 * ============================================================================
 * Uji PDFSortEngine v1.1.0 (v3.24.13) — FIX URUT ABJAD PENUH SELURUH HURUF
 * ----------------------------------------------------------------------------
 * Latar (laporan user): "fitur pengurutan pdf sepertinya hanya membaca abjad
 * a,b,c di bagian depan namanya saja, tapi tidak memperhatikan huruf
 * berikutnya — adi, andi > d lebih dulu dari n."
 *
 * Suite ini mengunci perilaku yang diminta user:
 *   1. Pasangan adi/andi → ADI selalu lebih dulu (huruf ke-2: d < n), apapun
 *      urutan masuknya.
 *   2. SEMUA pasangan nama pada dokumen asli user (9s056t.pdf, 14 pasien)
 *      terurut abjad penuh.
 *   3. Kasus sulit: besar-kecil huruf, spasi, angka alami, multi-klaim (nama
 *      sama → urut no. klaim), nama tak terbaca paling akhir.
 *   4. Uji shuffle: 200 acakan daftar nama → hasil selalu == urutan referensi
 *      Collator('id') — pembuktian sort memperhatikan SELURUH huruf.
 *
 * Jalankan: node test/pdfsort.test.mjs
 * ============================================================================
 */
'use strict';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

globalThis.pdfjsLib = require(path.join(ROOT, 'vendor/pdf.min.js'));
globalThis.pdfLib = require(path.join(ROOT, 'vendor/pdf-lib.min.js'));
try {
  globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc =
    path.join(ROOT, 'vendor/pdf.worker.min.js');
} catch (_) { /* Node: fake worker */ }

const E = require(path.join(ROOT, 'pdftool/engine.js'));

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

// ---------------------------------------------------------------- util uji
function sortNames(names) {
  // tiruan PageMeta minimal: {index, name, claim:null}
  const metas = names.map((n, i) => ({ index: i, name: n, claim: null }));
  return E.sortPageMetas(metas).map((m) => m.name);
}

function expectOrder(input, expected, label) {
  const out = sortNames(input);
  const got = out.join(' | ');
  const want = expected.join(' | ');
  ok(got === want, label + '\n          masuk : [' + input.join(', ') + ']\n          hasil : [' + got + ']' + (got === want ? '' : '\n          harus : [' + want + ']'));
}

// ============================================================ 1. KASUS USER
section('1. Kasus eksplisit user: adi vs andi (huruf ke-2 d < n)');
expectOrder(['ADI', 'ANDI'], ['ADI', 'ANDI'], 'ADI < ANDI (masuk urut)');
expectOrder(['ANDI', 'ADI'], ['ADI', 'ANDI'], 'ANDI, ADI → tetap ADI dulu (input terbalik)');
expectOrder(['adi', 'andi'], ['adi', 'andi'], 'huruf kecil: adi < andi');
expectOrder(['andi', 'adi'], ['adi', 'andi'], 'huruf kecil terbalik: tetap adi dulu');
expectOrder(['ADI SUCIPTO', 'ANDRI SUCIPTO'], ['ADI SUCIPTO', 'ANDRI SUCIPTO'], 'dgn nama belakang: ADI SUCIPTO < ANDRI SUCIPTO');
expectOrder(['ANDRI SUCIPTO', 'ADI SUCIPTO'], ['ADI SUCIPTO', 'ANDRI SUCIPTO'], 'versi terbalik: tetap ADI SUCIPTO dulu');

// ================================================ 2. PASANGAN DOKUMEN ASLI
section('2. Semua pasangan bersebelahan dokumen asli user (14 pasien BPJS)');
const DOC_NAMES = [
  'ANDRI SUCIPTO', 'DEDE YUSUF QOIR', 'DEVI FITRIA DAMAYANTI', 'IDA UBAIDAH',
  'IIN INSAROH', 'NOORA MARSYA YUNITA', 'NOVA CHELIA DAMAYANTI', 'RISKA AGUSTINA',
  'RIVELGA', 'ROHIMAN', 'SUCI DWI WULANDARI', 'SUDARMA', 'TALIASARI', 'YOHAN RIYANTO PUTRA',
];
for (let i = 1; i < DOC_NAMES.length; i++) {
  const a = DOC_NAMES[i - 1], b = DOC_NAMES[i];
  expectOrder([b, a], [a, b], a + '  <  ' + b + ' (input terbalik)');
}

// ========================================================== 3. KASUS SULIT
section('3. Kasus sulit: kapitalisasi, spasi, angka alami');
expectOrder(['sudarma', 'SUCI DWI'], ['SUCI DWI', 'sudarma'], 'campuran kapital: SUCI DWI < sudarma');
expectOrder(['  ADI', 'ADI '], ['  ADI', 'ADI '], 'spasi tepi di-trim — setara sbg kunci sort, urutan asli dipertahankan (stabil)');
expectOrder(['ADI  KUSNADI', 'ADI YUSUF'], ['ADI  KUSNADI', 'ADI YUSUF'], 'spasi ganda dirapatkan di kunci: ADI KUSNADI < ADI YUSUF');
expectOrder(['SUCI 10', 'SUCI 2'], ['SUCI 2', 'SUCI 10'], 'angka alami: SUCI 2 < SUCI 10 (bukan 10 dulu)');
expectOrder(['ANDI', 'ADI1', 'ADI10', 'ADI2'], ['ADI1', 'ADI2', 'ADI10', 'ANDI'], 'gabung: keluarga ADI urut alami, lalu ANDI');
// Urutan kamus ICU: spasi < tanda hubung → "DIAN OCTA" < "DIAN PUSPA" < "DIAN-OCTA"
expectOrder(['DIAN-OCTA', 'DIAN OCTA', 'DIAN PUSPA'], ['DIAN OCTA', 'DIAN PUSPA', 'DIAN-OCTA'], 'tanda hubung vs spasi vs huruf — urutan kamus ICU deterministik');

// ==================================== 4. NAMA SAMA (MULTI-KLAIM) & TAK TERBACA
section('4. Multi-klaim (nama sama → urut no. klaim) & tak-terbaca paling akhir');
{
  const metas = [
    { index: 0, name: 'SUDARMA', claim: 'KL26082807125229' },
    { index: 1, name: 'SUDARMA', claim: 'KL26081806952697' },
    { index: 2, name: 'SUDARMA', claim: 'KL26080206596018' },
  ];
  const out = E.sortPageMetas(metas).map((m) => m.claim);
  ok(out[0] === 'KL26080206596018' && out[2] === 'KL26082807125229',
    'nama sama SUDARMA x3 → klaim menaik: ' + out.join(' < '));
}
{
  const metas = [
    { index: 0, name: '', claim: null },                    // tak terbaca
    { index: 1, name: 'YOHAN RIYANTO PUTRA', claim: null },
    { index: 2, name: '', claim: null },                    // tak terbaca
    { index: 3, name: 'ADI', claim: null },
  ];
  const out = E.sortPageMetas(metas).map((m) => (m.name || '(tak terbaca)') + '#' + m.index);
  ok(out[0] === 'ADI#3' && out[1] === 'YOHAN RIYANTO PUTRA#1' && out[2] === '(tak terbaca)#0' && out[3] === '(tak terbaca)#2',
    'terbaca A-Z dulu, tak-terbaca di akhir (urutan asli dipertahankan): ' + out.join(', '));
}

// ========================================================== 5. UJI SHUFFLE
section('5. 200x shuffle — hasil selalu == referensi Collator(id) penuh');
{
  const coll = new Intl.Collator('id', { sensitivity: 'base', numeric: true });
  const ref = [...DOC_NAMES].sort((a, b) => coll.compare(a, b));
  let allMatch = true;
  for (let t = 0; t < 200; t++) {
    const shuffled = [...DOC_NAMES];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const out = sortNames(shuffled);
    if (out.join('|') !== ref.join('|')) { allMatch = false; break; }
  }
  ok(allMatch, '200 acakan x 14 nama → urutan identik referensi abjad penuh');
}

// ============================================= 6. E2E DOKUMEN ASLI USER
section('6. E2E dokumen asli user: permutasi ke urutan asli BPJS → analisa → sort');
{
  const fs = require('node:fs');
  const srcBytes = new Uint8Array(fs.readFileSync('/home/z/my-project/assets/9s056t.pdf'));

  // Urutan halaman dalam berkas terlampir user = sudah A-Z (hasil sort).
  // Marker "Halaman : x/14" BPJS memberi tahu urutan ASLI sebelum diurut:
  // 1:NOORA 2:SUCI 3:DEVI 4:TALIASARI 5:RISKA 6:ROHIMAN 7:RIVELGA 8:ANDRI
  // 9:IDA 10:YOHAN 11:NOVA 12:IIN 13:DEDE 14:SUDARMA
  // Peta: halaman-asli ke indeks berkas terlampir (0-based):
  const ORIG_TO_ATTACHED = [5, 10, 2, 12, 7, 9, 8, 0, 3, 13, 6, 4, 1, 11];

  const lib = globalThis.pdfLib;
  (async () => {
    const src = await lib.PDFDocument.load(srcBytes.slice());
    const permuted = await lib.PDFDocument.create();
    const pages = await permuted.copyPages(src, ORIG_TO_ATTACHED);
    for (const p of pages) permuted.addPage(p);
    const permBytes = await permuted.save();

    const a = await E.analyzePdf(permBytes);
    const namesSorted = a.sorted.map((m) => m.name);
    const want = [...DOC_NAMES].sort(
      (x, y) => new Intl.Collator('id', { sensitivity: 'base', numeric: true }).compare(x, y)
    );
    ok(namesSorted.join('|') === want.join('|'),
      '14 halaman urutan-asli-BPJS → hasil sort == abjad penuh\n          ' + namesSorted.join(', '));

    // Nama ter-ekstrak harus lengkap (bukan terpotong di huruf depan)
    const uniq = new Set(a.metas.map((m) => m.name));
    ok(uniq.size === 14 && [...uniq].every((n) => n.length > 3),
      'ekstraksi nama lengkap 14/14 pasien (tidak ada nama terpotong)');

    // Susun PDF hasil + verifikasi halaman keluaran.
    // Catatan: output = 1 hal DAFTAR ISI + 14 hal sumber. Bila keluaran
    // dianalisa ulang, hal DAFTAR ISI tak punya "Nama Peserta" → terbaca
    // sbg tak-terbaca → sah bila diletakkan paling akhir oleh sort.
    const built = await E.buildSortedPdf(permBytes, a.order, a.metas, {
      includeIndex: true, fileName: 'LAPORAN BPJS 14 PASIEN.pdf',
    });
    const out = await E.analyzePdf(built.bytes);
    const outNames = out.metas.map((m) => m.name);   // urutan HALAMAN keluaran
    ok(outNames[0] === '' && outNames.slice(1).join('|') === want.join('|'),
      'PDF keluaran (' + built.numPages + ' hal) — hal 1 = DAFTAR ISI, hal sumber di belakangnya terurut A-Z penuh');

    ok(built.fileName === 'LAPORAN BPJS 14 PASIEN - SORT A-Z.pdf',
      'nama berkas keluaran: ' + built.fileName);

    console.log('\n==== HASIL: ' + pass + ' PASS, ' + fail + ' FAIL ====');
    process.exit(fail ? 1 : 0);
  })().catch((e) => { console.error('FATAL E2E:', e); process.exit(1); });
}
