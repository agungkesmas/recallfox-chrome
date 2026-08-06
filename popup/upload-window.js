// popup/upload-window.js — v3.20.40: Detached window untuk file upload di Chrome MV3.
//
// Root cause: Chrome MV3 popup CLOSES when native file picker opens (popup loses
// focus → Chrome destroys popup → JS context gone → change event never fires).
// Firefox popup stays alive — that's why Firefox works but Chrome doesn't.
//
// Fix: open file picker in a DETACHED WINDOW (chrome.windows.create) that stays
// alive when file picker opens. This window reads file content, sends it to
// background via runtime.sendMessage, then closes itself.

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB

// Detect file kind dari extension + mime
function detectFileKind(file) {
  const name = (file.name || '').toLowerCase();
  const ext = name.split('.').pop();
  const mime = file.type || '';
  if (['md', 'markdown'].includes(ext)) return { kind: 'markdown', mime: mime || 'text/markdown' };
  if (ext === 'txt') return { kind: 'text', mime: mime || 'text/plain' };
  if (ext === 'json') return { kind: 'json', mime: mime || 'application/json' };
  if (['html', 'htm'].includes(ext)) return { kind: 'html', mime: mime || 'text/html' };
  if (ext === 'csv') return { kind: 'csv', mime: mime || 'text/csv' };
  if (['yaml', 'yml'].includes(ext)) return { kind: 'yaml', mime: mime || 'text/yaml' };
  return null;
}

function showStatus(msg, type) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status show ' + type;
}

function showFileList(files) {
  const el = document.getElementById('fileList');
  if (!files || files.length === 0) { el.innerHTML = ''; return; }
  el.innerHTML = files.map(f => {
    const sizeKB = (f.size / 1024).toFixed(1);
    return `<div class="file-list-item">📄 ${f.name} (${sizeKB} KB)</div>`;
  }).join('');
}

async function processFiles(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) {
    showStatus('Tidak ada file dipilih.', 'err');
    return;
  }

  showStatus(`Memproses ${files.length} file...`, 'info');
  showFileList(files);

  let ok = 0;
  let fail = 0;
  const errors = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const progress = files.length > 1 ? ` (${i + 1}/${files.length})` : '';

    try {
      const info = detectFileKind(file);
      if (!info) {
        errors.push(`${file.name}: format tidak didukung${progress}`);
        fail++;
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        errors.push(`${file.name}: terlalu besar (maks 2MB)${progress}`);
        fail++;
        continue;
      }

      const text = await file.text();
      if (!text || text.length === 0) {
        errors.push(`${file.name}: file kosong${progress}`);
        fail++;
        continue;
      }

      // Kirim ke background untuk disimpan ke vault
      const result = await chrome.runtime.sendMessage({
        type: 'DOC_FILE_UPLOADED',
        file: {
          name: file.name,
          body: text,
          kind: info.kind,
          mime: info.mime,
          size: file.size
        }
      });

      if (result?.ok) {
        ok++;
      } else {
        errors.push(`${file.name}: ${result?.error || 'gagal'}${progress}`);
        fail++;
      }
    } catch (e) {
      errors.push(`${file.name}: ${e.message}${progress}`);
      fail++;
    }
  }

  if (fail === 0) {
    showStatus(`✓ ${ok} file berhasil diupload ke Vault. Window akan tutup otomatis...`, 'ok');
    setTimeout(() => window.close(), 2000);
  } else if (ok > 0) {
    showStatus(`⚠ ${ok} berhasil, ${fail} gagal. ${errors.join('; ')}`, 'err');
  } else {
    showStatus(`✗ Semua gagal. ${errors.join('; ')}`, 'err');
  }
}

// Wire dropzone click → file input click
document.getElementById('dropzone').addEventListener('click', () => {
  console.log('[RecallFox/UploadWindow] Dropzone clicked → triggering file picker');
  const input = document.getElementById('fileInput');
  input.value = '';
  input.click();
});

// Wire file input change
document.getElementById('fileInput').addEventListener('change', async (e) => {
  console.log('[RecallFox/UploadWindow] File input change fired. Files:', e.target.files?.length);
  if (e.target.files && e.target.files.length > 0) {
    await processFiles(e.target.files);
  }
});

// Wire drag & drop
const dropzone = document.getElementById('dropzone');
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.style.borderColor = '#6366f1';
  dropzone.style.background = '#f5f3ff';
});
dropzone.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dropzone.style.borderColor = '#c0c0c0';
  dropzone.style.background = '#fff';
});
dropzone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropzone.style.borderColor = '#c0c0c0';
  dropzone.style.background = '#fff';
  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    await processFiles(e.dataTransfer.files);
  }
});

// Wire close button
document.getElementById('closeBtn').addEventListener('click', () => window.close());

// Auto-trigger file picker on load (user already clicked "Upload File teks" in popup)
// Small delay supaya window fully rendered sebelum file picker buka
setTimeout(() => {
  console.log('[RecallFox/UploadWindow] Auto-triggering file picker');
  const input = document.getElementById('fileInput');
  input.value = '';
  input.click();
}, 300);

console.log('[RecallFox/UploadWindow] Upload window loaded');
