# RecallFox Chrome v3.20.40 — Fix DEFINITIF: Upload File Teks via Detached Window

**Release date:** 2026-08-06
**Tag:** `v3.20.40-dev-chrome` (critical bug fix — 5x attempt, root cause akhirnya ketemu)
**Manifest version bump:** `3.20.39` → `3.20.40`

## TL;DR

Fix **DEFINITIF** untuk bug "Upload File teks tidak bereaksi" di Chrome. Setelah 4x perbaikan gagal, root cause sebenarnya akhirnya ditemukan: **Chrome MV3 popup menutup diri sendiri saat file picker terbuka** (popup kehilangan fokus → Chrome menghancurkan popup → konteks JavaScript hilang → event `change` tidak pernah dipicu).

Firefox tidak memiliki masalah ini — popup Firefox tetap hidup saat file picker terbuka. Itulah alasan Firefox berfungsi tetapi Chrome tidak.

## Root Cause (akar masalah sebenarnya)

### Kenapa 4x perbaikan sebelumnya gagal?

| Versi | Fix | Kenapa gagal |
|-------|-----|-------------|
| v3.20.36 | `setTimeout(callback, 80)` setelah closeSheet | Rantai gesture pengguna terputus → file picker tidak terbuka |
| v3.20.37 | `opt[1]()` sinkron + closeSheet() setelah | closeSheet() menutup sheet upload (Bug 1) |
| v3.20.38 | Sama dengan v3.20.37 | Tidak sadar saveScreenshotManualSheet() membuka sheet sendiri |
| v3.20.39 | 3-cabang logika + offscreen positioning | **Popup tetap menutup saat file picker terbuka** ← root cause sebenarnya |

### Kenapa Firefox berfungsi tetapi Chrome tidak?

**Firefox:** Popup Firefox tetap hidup saat file picker native terbuka. File picker terbuka → user memilih file → event `change` dipicu → file terbaca → upload berhasil.

**Chrome MV3:** Popup Chrome **menutup diri sendiri** saat kehilangan fokus. File picker native terbuka → popup kehilangan fokus → Chrome **menghancurkan popup** → konteks JavaScript hilang → event `change` tidak pernah dipicu → tidak ada yang terjadi.

Ini adalah **limitasi arsitektur Chrome MV3 popup** yang diketahui. Bukan bug di kode kita — semua ekstensi Chrome MV3 memiliki masalah ini.

## Solusi: Detached Window

Alih-alih membuka file picker di popup (yang menutup), buka di **detached window** via `chrome.windows.create()`. Detached window adalah jendela terpisah yang **tetap hidup** saat file picker terbuka.

### Alur kerja baru:

1. User klik "📄 Upload File teks" di popup
2. Popup tutup + `chrome.windows.create({ url: 'upload-window.html', type: 'popup' })` buka jendela terpisah
3. Jendela terpisah auto-trigger file picker (setelah 300ms delay untuk render)
4. File picker terbuka → **jendela tetap hidup** (tidak seperti popup)
5. User pilih file → event `change` dipicu di jendela terpisah
6. Jendela baca file content → kirim ke background via `chrome.runtime.sendMessage({ type: 'DOC_FILE_UPLOADED', file })`
7. Background simpan ke vault via `addItem()`
8. Background kirim response `{ ok: true, id }`
9. Jendela tampilkan status sukses → auto-close setelah 2 detik

## Kode Perbaikan

### 1. `popup/upload-window.html` — file baru

Jendela terpisah dengan:
- Dropzone (klik untuk pilih file / drag & drop)
- Hidden file input
- Status area (sukses/error)
- File list preview
- Tombol tutup

### 2. `popup/upload-window.js` — file baru

- Baca file content via `file.text()`
- Validasi: format (.md/.txt/.json/.html/.csv/.yaml), size (maks 2MB)
- Kirim ke background: `chrome.runtime.sendMessage({ type: 'DOC_FILE_UPLOADED', file })`
- Auto-trigger file picker on load (user sudah klik "Upload" di popup)
- Auto-close setelah sukses

### 3. `popup/popup.js` — `addItemMenu()` update

```javascript
['📄 Upload File teks', () => {
  console.log('[RecallFox/addItemMenu] Upload File teks → opening detached window');
  closeSheet();
  browser.windows.create({
    url: browser.runtime.getURL('popup/upload-window.html'),
    type: 'popup',
    width: 420,
    height: 480
  }).catch(e => {
    console.error('[RecallFox] Failed to open upload window:', e);
    toast('⚠ Gagal buka upload window: ' + e.message, false);
  });
  // Tutup popup supaya user fokus ke jendela unggah
  if (!document.body.classList.contains('rf-sidebar-body')) {
    setTimeout(() => window.close(), 200);
  }
}],
```

### 4. `background.js` — handler `DOC_FILE_UPLOADED`

```javascript
if (msg.type === 'DOC_FILE_UPLOADED') {
  try {
    const { addItem } = await import('./lib/storage.js');
    const file = msg.file;
    const newItem = await addItem({
      type: 'file',
      title: file.name,
      body: file.body,
      tags: ['file', file.kind],
      source: { kind: file.kind, mime: file.mime, fileName: file.name, size: file.size, uploadedFrom: 'upload-window' }
    });
    browser.runtime.sendMessage({ type: 'VAULT_UPDATED' }).catch(() => {});
    sendResponse({ ok: true, id: newItem.id });
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
  return;
}
```

### 5. `manifest.json` — web_accessible_resources

Tambah `popup/upload-window.html` + `popup/upload-window.js` supaya bisa diakses via `browser.runtime.getURL()`.

## Kenapa ini fix definitif?

1. **Detached window tetap hidup** saat file picker terbuka — tidak seperti popup yang menutup
2. **User gesture preserved** — file picker di-trigger dari event handler di detached window
3. **File dibaca di detached window** (bukan popup) — konteks JavaScript tetap ada
4. **Background simpan ke vault** — tidak bergantung pada popup/sidebar yang masih buka
5. **Auto-close setelah sukses** — UX clean, user tidak perlu tutup manual

## File yang berubah

- `manifest.json` — version bump `3.20.39` → `3.20.40` + tambah upload-window ke web_accessible_resources
- `popup/popup.js` — `addItemMenu()`: Upload File teks sekarang buka detached window
- `popup/upload-window.html` — **file baru**: UI detached window
- `popup/upload-window.js` — **file baru**: logika baca file + kirim ke background
- `background.js` — handler `DOC_FILE_UPLOADED` message

## Langkah Pengujian

### Test 1: Upload File teks
1. Buka popup RecallFox
2. Klik "+ Baru"
3. Klik "📄 Upload File teks"
4. **Expected:** Popup tutup, jendela terpisah "Upload File" muncul
5. Jendela auto-trigger file picker → pilih file .md/.txt
6. **Expected:** Status "✓ 1 file berhasil diupload" → jendela auto-close
7. Buka popup lagi → item muncul di Vault dengan type 'file'

### Test 2: Multiple files
1. Klik "+ Baru" → "Upload File teks"
2. Pilih multiple files di file picker
3. **Expected:** Semua file diproses, status "✓ N file berhasil"

### Test 3: Invalid file
1. Klik "+ Baru" → "Upload File teks"
2. Pilih file .pdf (tidak didukung)
3. **Expected:** Status error "format tidak didukung"

### Test 4: Drag & drop
1. Klik "+ Baru" → "Upload File teks"
2. Drag file dari file explorer → drop ke dropzone
3. **Expected:** File terbaca + diupload

### Test 5: Reload extension
1. Reload extension di chrome://extensions
2. Test upload lagi
3. **Expected:** Tetap berfungsi

## Kenapa Firefox tidak butuh fix ini?

Firefox popup **tetap hidup** saat file picker terbuka. Event `change` dipicu normal di popup. Jadi Firefox tetap pakai pattern lama (`docFileInput.click()` di popup) — tidak perlu detached window.

Chrome MV3 popup **menutup saat kehilangan fokus**. File picker = kehilangan fokus = popup mati. Maka butuh detached window.
