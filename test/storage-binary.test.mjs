// test/storage-binary.test.mjs — Integrasi: addItem binary via lib/storage.js
// dengan stub browser.storage in-memory.
// Jalankan: node test/storage-binary.test.mjs
import { mkdtempSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Salin storage.js ke lokasi sementara sebagai .mjs (storage.js tanpa import
// statis; dynamic import gdrive-sync akan gagal & di-catch di kode aslinya).
const tmpDir = mkdtempSync(join(tmpdir(), 'rf-test-'));
const modPath = join(tmpDir, 'storage.mjs');
copyFileSync(join(__dirname, '..', 'lib', 'storage.js'), modPath);

// ---- Stub browser (in-memory) ----
const store = {};
const storageLocal = {
  async get(keys) {
    if (keys === null) return { ...store };
    if (Array.isArray(keys)) { const out = {}; for (const k of keys) if (k in store) out[k] = store[k]; return out; }
    if (typeof keys === 'string') return { [keys]: store[keys] };
    return { ...keys, ...Object.fromEntries(Object.keys(keys).filter(k => k in store).map(k => [k, store[k]])) };
  },
  async set(obj) { Object.assign(store, obj); },
  async remove(keys) {
    const arr = Array.isArray(keys) ? keys : [keys];
    for (const k of arr) delete store[k];
  }
};
globalThis.browser = {
  storage: {
    local: storageLocal,
    sync: { async get() { return {}; }, async set() {}, async remove() {} }
  },
  runtime: { async sendMessage() { return undefined; } }
};

const storage = await import('file://' + modPath);

// ---- Setup vault awal ----
await storage.saveVault({
  items: [], notes: [], bundles: [], folders: [], settings: { syncEnabled: false }
});

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  ✔', label); }
  else { failed++; console.error('  ✘ GAGAL:', label); }
}

console.log('== addItem teks (regresi) ==');
const textItem = await storage.addItem({
  type: 'file', title: 'catatan.md', body: '# halo dunia',
  tags: ['file', 'md'], source: { kind: 'md', mime: 'text/markdown', fileName: 'catatan.md', size: 11 }
});
assert(textItem && textItem.id.startsWith('f'), 'id prefix f');
assert(textItem.body === '# halo dunia', 'body teks tersimpan');

console.log('== addItem binary (Fase 2) ==');
const fakePdfBytes = new Uint8Array(256 * 1024).fill(65); // 256KB 'A'
const pdfBlob = new Blob([fakePdfBytes], { type: 'application/pdf' });
const binItem = await storage.addItem({
  type: 'file', title: 'laporan.pdf', body: 'JANGAN TERPAKAI',
  tags: ['file', 'pdf'],
  source: { kind: 'pdf', mime: 'application/pdf', fileName: 'laporan.pdf', size: 262144, isBinary: true }
}, { fileBlob: pdfBlob });

assert(binItem && binItem.id.startsWith('f'), 'id prefix f (binary)');
assert(binItem.body === '', 'body dipaksa kosong (tidak ada data binary di vault JSON)');
assert(binItem.source.isBinary === true, 'source.isBinary true');

const vaultJson = JSON.stringify(await storage.getVault());
assert(vaultJson.length < 50 * 1024, 'vault JSON tetap ringan (' + vaultJson.length + ' byte) — binary TIDAK masuk vault');

const dataUrl = await storage.getFileDataUrl(binItem.id);
assert(!!dataUrl && dataUrl.startsWith('data:application/pdf;base64,'), 'blob tersimpan di rf_file_{id} sebagai data URL');

console.log('== blob round-trip ==');
if (!dataUrl) {
  console.error('  ✘ dataUrl null — round-trip dilewati');
  failed++;
} else {
  const blobBack = await (await fetch(dataUrl)).blob();
  assert(blobBack.size === 262144 && blobBack.type === 'application/pdf', 'blob utuh (ukuran & mime sama) — tidak ada korupsi teks');
}

console.log('== deleteItem membersihkan blob ==');
await storage.deleteItem(binItem.id);
const v2 = await storage.getVault();
assert(!v2.items.some(i => i.id === binItem.id), 'item terhapus dari vault');
assert(await storage.getFileDataUrl(binItem.id) === null, 'rf_file_{id} ikut terhapus');

console.log('\nHasil: ' + passed + ' lolos, ' + failed + ' gagal');
process.exit(failed > 0 ? 1 : 0);
