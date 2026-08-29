// lib/file-kinds.js — Klasifikasi tipe file untuk fitur Upload File
// RecallFox v3.22.0 (Fase 2: dukungan binary Office + gambar)
//
// PURE MODULE — tidak menyentuh `browser`/DOM, supaya bisa di-test pakai Node
// (lihat test/file-kinds.test.mjs).
//
// Dua keluarga file:
//   TEXT   → dibaca dengan file.text(), isi disimpan di item.body (perilaku v3.21.x)
//   BINARY → dibaca dengan arrayBuffer(), blob disimpan di key storage.local
//            terpisah `rf_file_{id}` (pola `rf_shot_{id}` milik screenshot).
//            item.body dibiarkan KOSONG supaya:
//            - vault JSON tetap ringan (fix bug v3.11.33: vault JSON membengkak
//              dengan data binary → storage.local lambat/crash)
//            - sync PostgREST (vault_items.body) tidak kena payload raksasa
//
// Fase 1 (bonus, disertakan sekalian): semua ekstensi teks programming/web dev.
// Fase 2: binary Office (PDF/DOCX/XLSX/PPTX + format lama + OpenDocument)
//         dan gambar (PNG/JPG/GIF/WebP/AVIF/BMP).

// Batas ukuran upload (keputusan user 2026-08-29):
export const MAX_TEXT_UPLOAD_BYTES = 2 * 1024 * 1024;     // 2MB  — sama seperti sebelumnya
export const MAX_BINARY_UPLOAD_BYTES = 10 * 1024 * 1024;  // 10MB — aman untuk kuota Supabase free (1GB)

// ---------- TEXT (dibaca sebagai teks, masuk item.body) ----------
const TEXT_FILE_KINDS = {
  // --- sudah didukung sejak v3.20.35 ---
  '.md':       { kind: 'md',   mime: 'text/markdown' },
  '.markdown': { kind: 'md',   mime: 'text/markdown' },
  '.txt':      { kind: 'txt',  mime: 'text/plain' },
  '.json':     { kind: 'json', mime: 'application/json' },
  '.html':     { kind: 'html', mime: 'text/html' },
  '.htm':      { kind: 'html', mime: 'text/html' },
  '.csv':      { kind: 'csv',  mime: 'text/csv' },
  '.yaml':     { kind: 'yaml', mime: 'text/yaml' },
  '.yml':      { kind: 'yaml', mime: 'text/yaml' },
  // --- Fase 1: programming & web dev ---
  '.js':   { kind: 'js',   mime: 'text/javascript' },
  '.mjs':  { kind: 'js',   mime: 'text/javascript' },
  '.cjs':  { kind: 'js',   mime: 'text/javascript' },
  '.jsx':  { kind: 'jsx',  mime: 'text/jsx' },
  '.ts':   { kind: 'ts',   mime: 'text/typescript' },
  '.tsx':  { kind: 'tsx',  mime: 'text/tsx' },
  '.vue':  { kind: 'vue',  mime: 'text/plain' },
  '.svelte': { kind: 'svelte', mime: 'text/plain' },
  '.astro':  { kind: 'astro',  mime: 'text/plain' },
  '.css':  { kind: 'css',  mime: 'text/css' },
  '.scss': { kind: 'scss', mime: 'text/x-scss' },
  '.sass': { kind: 'sass', mime: 'text/x-sass' },
  '.less': { kind: 'less', mime: 'text/plain' },
  '.py':   { kind: 'py',   mime: 'text/x-python' },
  '.java': { kind: 'java', mime: 'text/x-java-source' },
  '.go':   { kind: 'go',   mime: 'text/plain' },
  '.php':  { kind: 'php',  mime: 'text/x-php' },
  '.rb':   { kind: 'rb',   mime: 'text/x-ruby' },
  '.cs':   { kind: 'cs',   mime: 'text/plain' },
  '.rs':   { kind: 'rs',   mime: 'text/plain' },
  '.c':    { kind: 'c',    mime: 'text/x-c' },
  '.h':    { kind: 'h',    mime: 'text/x-c' },
  '.cpp':  { kind: 'cpp',  mime: 'text/x-c++src' },
  '.cc':   { kind: 'cpp',  mime: 'text/x-c++src' },
  '.hpp':  { kind: 'cpp',  mime: 'text/x-c++src' },
  '.kt':   { kind: 'kt',   mime: 'text/plain' },
  '.kts':  { kind: 'kt',   mime: 'text/plain' },
  '.swift':{ kind: 'swift',mime: 'text/plain' },
  '.dart': { kind: 'dart', mime: 'text/plain' },
  '.lua':  { kind: 'lua',  mime: 'text/x-lua' },
  '.r':    { kind: 'r',    mime: 'text/plain' },
  '.pl':   { kind: 'pl',   mime: 'text/x-perl' },
  '.ex':   { kind: 'ex',   mime: 'text/plain' },
  '.exs':  { kind: 'exs',  mime: 'text/plain' },
  '.sh':   { kind: 'sh',   mime: 'text/x-sh' },
  '.bash': { kind: 'sh',   mime: 'text/x-sh' },
  '.zsh':  { kind: 'sh',   mime: 'text/x-sh' },
  '.bat':  { kind: 'bat',  mime: 'text/plain' },
  '.cmd':  { kind: 'bat',  mime: 'text/plain' },
  '.ps1':  { kind: 'ps1',  mime: 'text/plain' },
  '.sql':  { kind: 'sql',  mime: 'text/x-sql' },
  '.prisma': { kind: 'prisma', mime: 'text/plain' },
  '.graphql': { kind: 'graphql', mime: 'application/graphql' },
  '.gql':  { kind: 'graphql', mime: 'application/graphql' },
  '.proto':{ kind: 'proto', mime: 'text/plain' },
  '.toml': { kind: 'toml', mime: 'text/plain' },
  '.xml':  { kind: 'xml',  mime: 'text/xml' },
  '.svg':  { kind: 'svg',  mime: 'image/svg+xml' },  // SVG = teks XML, aman di body
  '.ini':  { kind: 'ini',  mime: 'text/plain' },
  '.env':  { kind: 'env',  mime: 'text/plain' },
  '.conf': { kind: 'conf', mime: 'text/plain' },
  '.cfg':  { kind: 'conf', mime: 'text/plain' },
  '.log':  { kind: 'log',  mime: 'text/plain' },
  '.rtf':  { kind: 'rtf',  mime: 'application/rtf' },  // RTF = teks ber-markup
  '.tsv':  { kind: 'tsv',  mime: 'text/tab-separated-values' },
  '.tex':  { kind: 'tex',  mime: 'text/x-tex' },
  '.lock': { kind: 'lock', mime: 'text/plain' },
  '.gitignore': { kind: 'gitignore', mime: 'text/plain' },
  '.dockerignore': { kind: 'gitignore', mime: 'text/plain' },
  '.dockerfile': { kind: 'dockerfile', mime: 'text/plain' },
  '.editorconfig': { kind: 'conf', mime: 'text/plain' },
};

// ---------- BINARY (dibaca sebagai arrayBuffer, blob di key terpisah) ----------
// family dipakai untuk ikon & keterangan UI; preview dipakai untuk pratinjau.
const BINARY_FILE_KINDS = {
  // Office: PDF
  '.pdf':  { kind: 'pdf',  mime: 'application/pdf', family: 'office', preview: 'embed' },
  // Office: Word
  '.docx': { kind: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', family: 'office', preview: 'none' },
  '.doc':  { kind: 'doc',  mime: 'application/msword', family: 'office', preview: 'none' },
  // Office: Excel
  '.xlsx': { kind: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', family: 'office', preview: 'none' },
  '.xls':  { kind: 'xls',  mime: 'application/vnd.ms-excel', family: 'office', preview: 'none' },
  // Office: PowerPoint
  '.pptx': { kind: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', family: 'office', preview: 'none' },
  '.ppt':  { kind: 'ppt',  mime: 'application/vnd.ms-powerpoint', family: 'office', preview: 'none' },
  // Office: OpenDocument (LibreOffice)
  '.odt':  { kind: 'odt',  mime: 'application/vnd.oasis.opendocument.text', family: 'office', preview: 'none' },
  '.ods':  { kind: 'ods',  mime: 'application/vnd.oasis.opendocument.spreadsheet', family: 'office', preview: 'none' },
  '.odp':  { kind: 'odp',  mime: 'application/vnd.oasis.opendocument.presentation', family: 'office', preview: 'none' },
  // Gambar
  '.png':  { kind: 'png',  mime: 'image/png',  family: 'image', preview: 'img' },
  '.jpg':  { kind: 'jpg',  mime: 'image/jpeg', family: 'image', preview: 'img' },
  '.jpeg': { kind: 'jpg',  mime: 'image/jpeg', family: 'image', preview: 'img' },
  '.gif':  { kind: 'gif',  mime: 'image/gif',  family: 'image', preview: 'img' },
  '.webp': { kind: 'webp', mime: 'image/webp', family: 'image', preview: 'img' },
  '.avif': { kind: 'avif', mime: 'image/avif', family: 'image', preview: 'img' },
  '.bmp':  { kind: 'bmp',  mime: 'image/bmp',  family: 'image', preview: 'img' },
};

// Nama file tanpa ekstensi yang lazim berupa teks (mis. Dockerfile, Makefile)
const NO_EXT_TEXT_NAMES = {
  'dockerfile': { kind: 'dockerfile', mime: 'text/plain' },
  'makefile':   { kind: 'makefile',   mime: 'text/plain' },
  'license':    { kind: 'license',    mime: 'text/plain' },
  'readme':     { kind: 'md',         mime: 'text/markdown' },
  'changelog':  { kind: 'md',         mime: 'text/markdown' },
  'authors':    { kind: 'txt',        mime: 'text/plain' },
  'contributing': { kind: 'md',       mime: 'text/markdown' },
};

// Gabungan lengkap untuk deteksi
const ALL_KINDS = { ...TEXT_FILE_KINDS, ...BINARY_FILE_KINDS };

// String untuk atribut accept="" di <input type="file"> (text + binary)
export const FILE_ACCEPT_ATTR = [
  ...Object.keys(TEXT_FILE_KINDS),
  ...Object.keys(BINARY_FILE_KINDS)
].join(',');

// Daftar ekstensi yang DITOLAK dengan pesan khusus (binary di luar scope Fase 2)
export const REJECTED_BINARY_HINT = {
  '.zip': 'arsip ZIP belum didukung Fase 2',
  '.rar': 'arsip RAR belum didukung Fase 2',
  '.7z': 'arsip 7z belum didukung Fase 2',
  '.tar': 'arsip TAR belum didukung Fase 2',
  '.gz': 'arsip GZ belum didukung Fase 2',
  '.mp3': 'audio belum didukung Fase 2',
  '.wav': 'audio belum didukung Fase 2',
  '.m4a': 'audio belum didukung Fase 2',
  '.mp4': 'video belum didukung Fase 2',
  '.mkv': 'video belum didukung Fase 2',
  '.mov': 'video belum didukung Fase 2',
  '.webm': 'video belum didukung Fase 2',
  '.epub': 'e-book EPUB belum didukung Fase 2',
  '.mobi': 'e-book MOBI belum didukung Fase 2',
  '.exe': 'file executable tidak didukung',
  '.dll': 'file binary sistem tidak didukung',
  '.apk': 'file APK tidak didukung',
  '.iso': 'file ISO tidak didukung',
  '.bin': 'file binary tidak didukung',
  '.psd': 'file Photoshop belum didukung Fase 2',
  '.ai': 'file Illustrator belum didukung Fase 2',
  '.db': 'file database belum didukung Fase 2',
  '.sqlite': 'file database belum didukung Fase 2',
};

/**
 * Deteksi tipe file dari nama/ekstensi.
 * @param {File|{name:string}} file
 * @returns {{kind:string,mime:string,binary:boolean,family:string,preview:string}|null}
 */
export function detectFileKind(file) {
  if (!file || !file.name) return null;
  const name = file.name.toLowerCase();
  const dotIdx = name.lastIndexOf('.');
  if (dotIdx >= 0) {
    const ext = name.slice(dotIdx);
    const info = ALL_KINDS[ext];
    if (info) {
      const isBinary = !!BINARY_FILE_KINDS[ext];
      return {
        kind: info.kind,
        mime: info.mime,
        binary: isBinary,
        family: isBinary ? info.family : 'text',
        preview: isBinary ? info.preview : 'text'
      };
    }
    // Ekstensi tidak dikenal → tolak (bukan fallback ke teks: hindari korupsi binary)
    return null;
  }
  // Tanpa ekstensi → cek nama khusus (Dockerfile, Makefile, README...)
  const byName = NO_EXT_TEXT_NAMES[name];
  if (byName) {
    return { kind: byName.kind, mime: byName.mime, binary: false, family: 'text', preview: 'text' };
  }
  return null;
}

/** Hint penolakan untuk ekstensi binary di luar scope (kembali null kalau bukan kategori itu). */
export function rejectHintFor(file) {
  if (!file || !file.name) return null;
  const name = file.name.toLowerCase();
  const dotIdx = name.lastIndexOf('.');
  if (dotIdx < 0) return null;
  return REJECTED_BINARY_HINT[name.slice(dotIdx)] || null;
}

/** Emoji ikon per kind (untuk list vault & item sheet). */
export function kindIcon(kind) {
  const map = {
    pdf: '📕', docx: '📘', doc: '📘', xlsx: '📗', xls: '📗',
    pptx: '📙', ppt: '📙', odt: '📓', ods: '📓', odp: '📓',
    png: '🖼️', jpg: '🖼️', gif: '🖼️', webp: '🖼️', avif: '🖼️', bmp: '🖼️',
    md: '📝', txt: '📄', json: '🧾', html: '🌐', csv: '📊',
    yaml: '🧾', js: '🟨', ts: '🟦', py: '🐍', java: '☕', go: '🐹',
    php: '🐘', rb: '💎', c: '🔧', cpp: '🔧', cs: '🔧', rs: '🦀',
    sql: '🗄️', sh: '💻', css: '🎨', xml: '🧾', svg: '🎨',
  };
  return map[kind] || null;
}

/** Format ukuran byte → teks ringkas (KB/MB). */
export function formatBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

/** Ekstensi aman untuk nama file cloud (dipakai _uploadFileDocument sebagai fallback). */
export function cloudExt(kind, isBinary) {
  const map = {
    md: 'md', markdown: 'md', txt: 'txt', json: 'json', html: 'html', htm: 'html',
    csv: 'csv', yaml: 'yaml', yml: 'yaml', js: 'js', jsx: 'jsx', ts: 'ts', tsx: 'tsx',
    vue: 'vue', svelte: 'svelte', astro: 'astro', css: 'css', scss: 'scss', sass: 'sass',
    less: 'less', py: 'py', java: 'java', go: 'go', php: 'php', rb: 'rb', cs: 'cs',
    rs: 'rs', c: 'c', h: 'h', cpp: 'cpp', kt: 'kt', swift: 'swift', dart: 'dart',
    lua: 'lua', r: 'r', pl: 'pl', ex: 'ex', exs: 'exs', sh: 'sh', bat: 'bat', ps1: 'ps1',
    sql: 'sql', prisma: 'prisma', graphql: 'graphql', gql: 'graphql', proto: 'proto',
    toml: 'toml', xml: 'xml', svg: 'svg', ini: 'ini', env: 'env', conf: 'conf',
    log: 'log', rtf: 'rtf', tsv: 'tsv', tex: 'tex', lock: 'lock', gitignore: 'gitignore',
    dockerfile: 'dockerfile', makefile: 'makefile', license: 'license',
    // binary
    pdf: 'pdf', docx: 'docx', doc: 'doc', xlsx: 'xlsx', xls: 'xls',
    pptx: 'pptx', ppt: 'ppt', odt: 'odt', ods: 'ods', odp: 'odp',
    png: 'png', jpg: 'jpg', gif: 'gif', webp: 'webp', avif: 'avif', bmp: 'bmp'
  };
  return map[kind] || (isBinary ? 'bin' : 'txt');
}
