// test/file-kinds.test.mjs — Smoke test lib/file-kinds.js (pure module)
// Jalankan: node test/file-kinds.test.mjs
import {
  detectFileKind, rejectHintFor, kindIcon, formatBytes, cloudExt,
  FILE_ACCEPT_ATTR, MAX_TEXT_UPLOAD_BYTES, MAX_BINARY_UPLOAD_BYTES
} from '../lib/file-kinds.js';

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  ✔', label); }
  else { failed++; console.error('  ✘ GAGAL:', label); }
}

console.log('== Teks lama (regresi) ==');
const md = detectFileKind({ name: 'catatan.md' });
assert(md && !md.binary && md.kind === 'md', '.md → teks md');
assert(detectFileKind({ name: 'data.JSON' }).kind === 'json', '.JSON (kapital) → json');
assert(detectFileKind({ name: 'x.yml' }).kind === 'yaml', '.yml → yaml');

console.log('== Teks baru (Fase 1: programming) ==');
assert(detectFileKind({ name: 'app.ts' }).kind === 'ts', '.ts → ts');
assert(detectFileKind({ name: 'App.tsx' })?.kind === 'tsx', '.tsx → tsx');
assert(detectFileKind({ name: 'main.py' })?.kind === 'py', '.py → py');
assert(detectFileKind({ name: 'go.mod' }) === null, '.mod tidak didukung → null');
assert(detectFileKind({ name: 'Dockerfile' })?.kind === 'dockerfile', 'Dockerfile (tanpa ekstensi) → dockerfile');
assert(detectFileKind({ name: 'README' })?.kind === 'md', 'README → md');

console.log('== Binary (Fase 2: Office + gambar) ==');
const pdf = detectFileKind({ name: 'laporan.pdf' });
assert(pdf && pdf.binary === true && pdf.family === 'office' && pdf.preview === 'embed', '.pdf → binary office, preview embed');
assert(detectFileKind({ name: 'x.docx' })?.kind === 'docx', '.docx → docx');
assert(detectFileKind({ name: 'x.xlsx' })?.kind === 'xlsx', '.xlsx → xlsx');
assert(detectFileKind({ name: 'x.pptx' })?.kind === 'pptx', '.pptx → pptx');
assert(detectFileKind({ name: 'x.doc' })?.binary === true, '.doc → binary');
assert(detectFileKind({ name: 'x.odt' })?.kind === 'odt', '.odt → odt');
const png = detectFileKind({ name: 'foto.png' });
assert(png && png.binary && png.family === 'image' && png.preview === 'img', '.png → binary image, preview img');
assert(detectFileKind({ name: 'foto.JPEG' })?.kind === 'jpg', '.JPEG → jpg');
assert(detectFileKind({ name: 'x.webp' })?.mime === 'image/webp', '.webp → mime image/webp');

console.log('== Penolakan binary di luar scope ==');
assert(detectFileKind({ name: 'x.zip' }) === null, '.zip ditolak');
assert(detectFileKind({ name: 'x.mp3' }) === null, '.mp3 ditolak');
assert(rejectHintFor({ name: 'x.zip' })?.includes('ZIP'), 'hint zip');
assert(rejectHintFor({ name: 'lagu.mp3' })?.includes('audio'), 'hint audio');
assert(rejectHintFor({ name: 'x.exe' })?.includes('executable'), 'hint exe');
assert(detectFileKind({ name: 'x.pdf.exe' }) === null, '.exe (ekstensi terakhir) ditolak');
assert(detectFileKind({ name: 'tanpaekstensi' }) === null, 'tanpa ekstensi & bukan nama khusus → null');
assert(detectFileKind({ name: '' }) === null, 'nama kosong → null');
assert(detectFileKind(null) === null, 'null → null');

console.log('== Helper ==');
assert(kindIcon('pdf') === '📕', 'ikon pdf');
assert(kindIcon('png') === '🖼️', 'ikon png');
assert(kindIcon('xlsx') === '📗', 'ikon xlsx');
assert(kindIcon('tidak-ada') === null, 'ikon tak dikenal → null');
assert(formatBytes(512) === '512 B', 'formatBytes 512 B');
assert(formatBytes(2048) === '2.0 KB', 'formatBytes 2.0 KB');
assert(formatBytes(10 * 1024 * 1024) === '10.0 MB', 'formatBytes 10.0 MB');
assert(cloudExt('pdf', true) === 'pdf', 'cloudExt pdf');
assert(cloudExt('tsx', false) === 'tsx', 'cloudExt tsx');
assert(cloudExt('xxx', true) === 'bin', 'cloudExt fallback bin');
assert(cloudExt('xxx', false) === 'txt', 'cloudExt fallback txt');

console.log('== Batas & accept ==');
assert(MAX_TEXT_UPLOAD_BYTES === 2 * 1024 * 1024, 'teks 2MB');
assert(MAX_BINARY_UPLOAD_BYTES === 10 * 1024 * 1024, 'binary 10MB');
assert(FILE_ACCEPT_ATTR.includes('.pdf') && FILE_ACCEPT_ATTR.includes('.ts') && FILE_ACCEPT_ATTR.includes('.png'), 'accept attr lengkap');

console.log('\nHasil: ' + passed + ' lolos, ' + failed + ' gagal');
process.exit(failed > 0 ? 1 : 0);
