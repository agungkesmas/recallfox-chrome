/**
 * ============================================================================
 * Uji RFMergeEngine v1.0.0 (v3.24.20) — GABUNG PDF dgn pemilihan halaman
 * + halaman pemisah antar berkas.
 * ----------------------------------------------------------------------------
 * Suite ini mengunci perilaku yang diminta user:
 *   1. Dari 2 berkas PDF 10 halaman, hanya 3 halaman per berkas dicentang →
 *      hasil 3 + PEMISAH + 3 = 7 halaman, urutan & isi benar.
 *   2. Halaman pemisah HANYA antar berkas penyumbang (bukan di awal/akhir),
 *      berisi "BAGIAN n" + nama berkas; ukurannya = ukuran berkas berikutnya.
 *   3. Berkas dgn 0 halaman terpilih dilewati seluruhnya (tanpa pemisah).
 *   4. Indeks tak valid (negatif / di luar jangkauan / duplikat) di-clamp.
 *   5. Karakter non-WinAnsi (emoji dll) tidak pernah melempar error pdf-lib.
 *   6. separator:false → gabungan murni tanpa halaman pemisah.
 *
 * Jalankan: node test/merge-engine.test.mjs
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

const E = require(path.join(ROOT, 'pdftool/merge-engine.js'));
const PDFDocument = globalThis.pdfLib.PDFDocument;
const StandardFonts = globalThis.pdfLib.StandardFonts;
const rgb = globalThis.pdfLib.rgb;

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

// ---------------------------------------------------------------- util uji
async function buildNumberedPdf(prefix, pages, size) {
  // Buat PDF uji: tiap halaman berisi teks unik "<prefix>-HAL<i>" agar bisa
  // diverifikasi urutannya via ekstraksi teks pdfjs.
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= pages; i++) {
    const pg = doc.addPage(size || [595.28, 841.89]); // A4 portrait default
    pg.drawText(prefix + '-HAL' + i, { x: 48, y: 760, size: 24, font, color: rgb(0.1, 0.1, 0.1) });
    pg.drawText('RINCIAN KWITANSI ' + prefix, { x: 48, y: 700, size: 12, font, color: rgb(0.3, 0.3, 0.3) });
  }
  const bytes = await doc.save();
  return new Uint8Array(bytes);
}

async function pageTexts(bytes) {
  const doc = await globalThis.pdfjsLib.getDocument({
    data: new Uint8Array(bytes).slice(),
    isEvalSupported: false,
    disableFontFace: true,
    useWorkerFetch: false,
  }).promise;
  const out = [];
  try {
    for (let i = 0; i < doc.numPages; i++) {
      const tc = await doc.getPage(i + 1).then((p) => p.getTextContent());
      out.push(tc.items.map((it) => (it.str || '')).join(' ').replace(/\s+/g, ' ').trim());
    }
  } finally { try { await doc.destroy(); } catch (_) {} }
  return out;
}

// ---------------------------------------------------------------- sanitasi
section('sanitizeWinAnsi');
ok(E.sanitizeWinAnsi('Rincian Kwitansi #12') === 'Rincian Kwitansi #12', 'teks ASCII biasa tidak diubah');
ok(E.sanitizeWinAnsi('\u201Ckutip\u201D \u2013 garis') === '"kutip" - garis', 'kutip/typografi dipetakan ke ASCII');
ok(E.sanitizeWinAnsi('RS \uD83C\uDFE5 ok') === 'RS ? ok', 'emoji → ? (tidak throw WinAnsi)');
ok(E.sanitizeWinAnsi(null) === '' && E.sanitizeWinAnsi(undefined) === '' && E.sanitizeWinAnsi(123) === '123', 'null/undefined/number aman');
ok(!/[\u2018\u2019\u201C\u201D\u2013\u2014\u2026]/.test(E.sanitizeWinAnsi('‘’“”–—…')), 'semua tanda tipografi terpetakan');

// ---------------------------------------------------------------- wrapLabel
section('wrapLabel');
{
  const lines = E.wrapLabel('TAGIHAN RAWAT INAP RUANG ANGGREK KELAS 1 RS UDARA WISATA AGUNG 2026', 24, 3);
  ok(lines.length <= 3, 'maks 3 baris (' + lines.length + ')');
  ok(lines.every((l) => l.length <= 24), 'tiap baris <= maxChars');
  const long = E.wrapLabel('a'.repeat(120), 20, 3);
  ok(long.length <= 3 && long.every((l) => l.length <= 20) && long.join('').includes('...'), 'nama sangat panjang terpotong + ellipsis (' + long.length + ' baris)');
  const multi = E.wrapLabel('tagihan rawat inap kelas satu ruang anggrek lantai tujuh gedung utama sebelah timur', 22, 3);
  ok(multi.length === 3 && multi[2].endsWith('...'), 'nama multi-kata terisi 3 baris + ellipsis');
  ok(E.wrapLabel('', 20, 3).length === 1, 'nama kosong → 1 baris placeholder');
}

// ---------------------------------------------------------------- clampIndices
section('clampIndices');
{
  const r = E.clampIndices([-3, 0, 2, 2, '3', 4.5, 99], 5);
  ok(JSON.stringify(r) === '[0,2,3]', 'clamp/dedupe/sort: [-3,0,2,2,"3",4.5,99] → [0,2,3] (hasil: ' + JSON.stringify(r) + ')');
  ok(E.clampIndices([], 5).length === 0, 'kosong → kosong');
  ok(E.clampIndices(null, 5).length === 0, 'null → kosong');
  ok(E.clampIndices([0, 1, 2], 0).length === 0, 'dokumen 0 halaman → kosong');
}

// ---------------------------------------------------------------- analyzeDocument
section('analyzeDocument');
{
  const bytes = await buildNumberedPdf('DOK', 3);
  const a = await E.analyzeDocument(bytes);
  ok(a.numPages === 3, 'numPages = 3');
  ok(a.snippets.length === 3, 'snippets = 3 entri');
  ok(/DOK-HAL2/.test(a.snippets[1]) && /RINCIAN/.test(a.snippets[1]), 'cuplikan hlm-2 berisi penanda teks');
  let threw = false;
  try { await E.analyzeDocument(new Uint8Array([1, 2, 3])); } catch (e) { threw = true; }
  ok(threw, 'PDF sampah → error jelas (tidak menggantung)');
}

// ---------------------------------------------------------------- merge inti
section('merge — 2 berkas x 10 hlm, pilih 3 masing-masing + pemisah (kasus user)');
{
  const A = await buildNumberedPdf('BERKASA', 10);
  const B = await buildNumberedPdf('BERKASB', 10);
  const r = await E.merge({
    files: [
      { name: 'kwitansi-pasien-a.pdf', bytes: A, selected: [1, 4, 6] },   // HAL2, HAL5, HAL7
      { name: 'kwitansi-pasien-b.pdf', bytes: B, selected: [0, 2, 8] }    // HAL1, HAL3, HAL9
    ],
    separator: true
  });
  ok(r.pages === 7, 'total 7 halaman (3 + pemisah + 3) — hasil: ' + r.pages);
  ok(r.parts === 2 && r.separators === 1, '2 bagian, 1 pemisah');
  const texts = await pageTexts(r.bytes);
  ok(/BERKASA-HAL2/.test(texts[0]), 'hlm-1 = BERKASA HAL2');
  ok(/BERKASA-HAL5/.test(texts[1]), 'hlm-2 = BERKASA HAL5');
  ok(/BERKASA-HAL7/.test(texts[2]), 'hlm-3 = BERKASA HAL7');
  ok(/BAGIAN\s*2/.test(texts[3].replace(/\s+/g, '')) || /B\s*A\s*G\s*I\s*A\s*N/.test(texts[3]), 'hlm-4 = halaman pemisah BAGIAN 2');
  ok(/kwitansi-pasien-b/.test(texts[3].toLowerCase().replace(/\s+/g, ' ')), 'pemisah menyebut nama berkas B');
  ok(/3 dari 10 halaman/.test(texts[3]), 'pemisah menyebut ringkasan 3 dari 10');
  ok(/BERKASB-HAL1/.test(texts[4]), 'hlm-5 = BERKASB HAL1');
  ok(/BERKASB-HAL3/.test(texts[5]), 'hlm-6 = BERKASB HAL3');
  ok(/BERKASB-HAL9/.test(texts[6]), 'hlm-7 = BERKASB HAL9');
  ok(!/BAGIAN/.test(texts[0]) && !/BAGIAN/.test(texts[6]), 'tidak ada pemisah di awal/akhir');
}

section('merge — separator:false');
{
  const A = await buildNumberedPdf('XA', 5);
  const B = await buildNumberedPdf('XB', 5);
  const r = await E.merge({
    files: [
      { name: 'a.pdf', bytes: A, selected: [0, 1] },
      { name: 'b.pdf', bytes: B, selected: [4] }
    ],
    separator: false
  });
  ok(r.pages === 3 && r.separators === 0, '3 halaman tanpa pemisah');
  const texts = await pageTexts(r.bytes);
  ok(/XA-HAL1/.test(texts[0]) && /XA-HAL2/.test(texts[1]) && /XB-HAL5/.test(texts[2]), 'urutan A1,A2,B5');
}

section('merge — berkas 0 halaman terpilih dilewati');
{
  const A = await buildNumberedPdf('MA', 10);
  const B = await buildNumberedPdf('MB', 10);
  const C = await buildNumberedPdf('MC', 10);
  const r = await E.merge({
    files: [
      { name: 'a.pdf', bytes: A, selected: [0, 1, 2] },
      { name: 'b.pdf', bytes: B, selected: [] },            // dilewati
      { name: 'c.pdf', bytes: C, selected: [0, 1] }
    ],
    separator: true
  });
  ok(r.pages === 6 && r.separators === 1, '3 + 1 pemisah + 2 = 6 (berkas B seluruhnya dilewati)');
  const texts = await pageTexts(r.bytes);
  ok(/MC-HAL1/.test(texts[4]), 'setelah pemisah langsung berkas C');
  ok(!/MB-HAL/.test(texts.join(' ')), 'tidak ada halaman dari berkas B');
}

section('merge — indeks acak di-clamp');
{
  const A = await buildNumberedPdf('KA', 5);
  const r = await E.merge({
    files: [{ name: 'a.pdf', bytes: A, selected: [99, -1, 2, 2, 0] }],
    separator: true
  });
  ok(r.pages === 2, 'clamp → 2 halaman (0,2)');
  const texts = await pageTexts(r.bytes);
  ok(/KA-HAL1/.test(texts[0]) && /KA-HAL3/.test(texts[1]), 'isi HAL1 lalu HAL3, tanpa pemisah utk 1 bagian');
}

section('merge — ukuran pemisah mengikuti berkas berikutnya (Letter vs A4)');
{
  const A = await buildNumberedPdf('SA', 3);                                     // A4 595.28 x 841.89
  const B = await buildNumberedPdf('SB', 3, [612, 792]);                          // US Letter
  const r = await E.merge({
    files: [
      { name: 'a.pdf', bytes: A, selected: [0] },
      { name: 'b.pdf', bytes: B, selected: [0] }
    ],
    separator: true
  });
  const out = await PDFDocument.load(new Uint8Array(r.bytes).slice());
  const sep = out.getPage(1);
  const w = Math.round(sep.getWidth()), h = Math.round(sep.getHeight());
  ok(w === 612 && h === 792, 'pemisah berukuran Letter (612x792) — hasil: ' + w + 'x' + h);
  ok(Math.round(out.getPage(0).getWidth()) === 595, 'hlm-1 tetap A4');
}

section('merge — nama berkas emoji/panjang tidak throw');
{
  const A = await buildNumberedPdf('EM', 2);
  const B = await buildNumberedPdf('EN', 2);
  const r = await E.merge({
    files: [
      { name: '🏥 TAGIHAN RS “UDARA” — AGUNG 🏥 ' + 'x'.repeat(120) + '.pdf', bytes: A, selected: [0] },
      { name: 'rincian ✨ kwitansi.pdf', bytes: B, selected: [1] }
    ],
    separator: true
  });
  ok(r.pages === 3, 'gabung sukses dgn nama ekstrem (3 hlm)');
}

section('merge — penolakan wajar');
{
  let err = null;
  try { await E.merge({ files: [] }); } catch (e) { err = e; }
  ok(err && err.code === 'nofiles', 'tanpa berkas → nofiles');
  const A = await buildNumberedPdf('ZZ', 2);
  err = null;
  try { await E.merge({ files: [{ name: 'a.pdf', bytes: A, selected: [] }] }); } catch (e) { err = e; }
  ok(err && err.code === 'noselection', 'semua berkas 0 centang → noselection');
  err = null;
  try { await E.merge({ files: [{ name: 'a.pdf', bytes: new Uint8Array([9, 9, 9]), selected: [0] }] }); } catch (e) { err = e; }
  ok(!!err, 'PDF sampah → error (tidak crash)');
}

// ---------------------------------------------------------------- hasil
console.log('\n========================================');
console.log('TOTAL: ' + pass + ' PASS, ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
