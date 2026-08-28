# RecallFox Chrome v3.20.41 — Fix Definitif: Tombol Upload Tidak Bereaksi

**Release date:** 2026-08-06
**Tag:** `v3.20.41-dev` (critical bug fix — 4x attempt, now definitively fixed)
**Manifest version bump:** `3.20.38` → `3.20.39`

## TL;DR

Fix definitif untuk bug "Tombol Upload File teks & Upload gambar (manual) tidak bereaksi" di menu "+ Baru". Setelah 3x perbaikan gagal, root cause akhirnya ditemukan: `closeSheet()` dipanggil setelah `openSheet()`, menutup sheet yang baru dibuka.

## Root Cause Analysis

### Bug 1: "Upload gambar (manual)" — sheet flash then disappear

**Flow:**
1. User klik "📤 Upload gambar (manual)" di menu
2. `opt[1]()` → `doShot('upload')` → `saveScreenshotManualSheet()` → `openSheet()` membuka sheet upload
3. `closeSheet()` **langsung menutup sheet yang baru dibuka** ← BUG

**User experience:** Sheet upload muncul sepersekian detik lalu hilang. User pikir tombol tidak bereaksi.

**Kode lama (v3.20.40):**
```javascript
if (opt[0].includes('Upload File') || opt[0].includes('Upload gambar')) {
  opt[1](); // ← saveScreenshotManualSheet() → openSheet() buka sheet
  closeSheet(); // ← BUG: langsung tutup sheet yang baru dibuka!
}
```

### Bug 2: "Upload File teks" — file picker tidak buka

**Flow:**
1. User klik "📄 Upload File teks"
2. `opt[1]()` → `docFileInput.click()` pada element `display:none`
3. Firefox popup kadang menolak buka file picker untuk `display:none` input

**Kode lama:** `<input type="file" id="docFileInput" style="display:none" />`

Firefox popup punya policy ketat tentang user gesture + file input. `display:none` element dianggap "not rendered" → `.click()` tidak buka picker.

### Kenapa 3x perbaikan sebelumnya gagal?

1. **v3.20.36:** Pakai `setTimeout(callback, 80)` setelah `closeSheet()`. Breaks user gesture chain → file picker tidak buka.
2. **v3.20.37:** Coba `opt[1]()` synchronous + `closeSheet()` setelah. Tapi `closeSheet()` menutup sheet upload yang baru dibuka (Bug 1).
3. **v3.20.40:** Sama seperti v3.20.37, tidak sadar bahwa `saveScreenshotManualSheet()` membuka sheet sendiri.

**Root cause yang tidak disadari:** `saveScreenshotManualSheet()` memanggil `openSheet()` yang **menggantikan** sheet menu dengan sheet upload. Jadi `closeSheet()` setelahnya menutup sheet upload, bukan sheet menu.

## Kode Perbaikan

### 1. `popup/popup.js` — `addItemMenu()` event handler

```javascript
b.querySelectorAll('.act').forEach(a => a.addEventListener('click', (ev) => {
  const opt = opts[a.dataset.i];
  const label = opt[0];

  if (label.includes('Upload gambar')) {
    // Upload gambar: saveScreenshotManualSheet() opens its own sheet.
    // JANGAN closeSheet() — akan menutup sheet yang baru dibuka.
    console.log('[RecallFox/addItemMenu] Upload gambar clicked → opening manual upload sheet');
    opt[1](); // synchronous — saveScreenshotManualSheet() replaces menu sheet
  } else if (label.includes('Upload File')) {
    // Upload File teks: trigger native file picker.
    // Close menu first (sync CSS toggle), then .click() preserves user gesture.
    console.log('[RecallFox/addItemMenu] Upload File teks clicked → triggering file picker');
    closeSheet();
    opt[1](); // synchronous — docFileInput.click()
  } else {
    // Opsi lain: tutup sheet dulu, lalu jalankan callback setelah 80ms.
    closeSheet();
    setTimeout(opt[1], 80);
  }
}));
```

### 2. `popup/popup.html` — file input CSS

```html
<!-- SEBELUMNYA (display:none — Firefox popup kadang tolak .click()) -->
<input type="file" id="docFileInput" style="display:none" />

<!-- SEKARANG (offscreen positioning — element tetap "rendered" di DOM) -->
<input type="file" id="docFileInput"
  style="position:absolute;top:-9999px;left:-9999px;opacity:0;width:1px;height:1px;pointer-events:none;" />
```

### 3. `popup/popup.js` — console.log untuk debugging

```javascript
const _docFileInput = $('#docFileInput');
if (_docFileInput) {
  console.log('[RecallFox] docFileInput found, wiring change handler. Element:', _docFileInput);
  _docFileInput.addEventListener('change', async (e) => {
    console.log('[RecallFox] docFileInput change event fired. Files:', e.target.files?.length);
    if (e.target.files && e.target.files.length > 0) {
      await handleDocFileUpload(e.target.files);
    }
  });
}
```

## HTML Structure yang Direkomendasikan

**Pattern untuk hidden file input di Firefox extension popup:**

```html
<!-- ✅ BENAR: offscreen positioning — element tetap rendered -->
<input type="file" id="myFileInput"
  style="position:absolute;top:-9999px;left:-9999px;opacity:0;width:1px;height:1px;pointer-events:none;" />

<!-- ❌ SALAH: display:none — Firefox popup kadang tolak .click() -->
<input type="file" id="myFileInput" style="display:none" />
```

**Kenapa offscreen better?**
- Element tetap "rendered" di DOM tree → browser anggap valid untuk `.click()`
- Tidak mengambil space visual (offscreen)
- `pointer-events:none` mencegah accidental click
- Standard pattern untuk accessible file upload

## Langkah Pengujian

### Test 1: Upload gambar (manual)
1. Buka popup RecallFox (klik toolbar icon)
2. Klik tombol "+ Baru"
3. Klik "📤 Upload gambar (manual)"
4. **Expected:** Sheet "Upload Screenshot Manual" muncul dengan dropzone + form
5. Klik dropzone → file picker terbuka
6. Pilih gambar → preview muncul
7. Klik "Simpan Screenshot" → item tersimpan

### Test 2: Upload File teks
1. Buka popup RecallFox
2. Klik tombol "+ Baru"
3. Klik "📄 Upload File teks"
4. **Expected:** Menu tutup, file picker terbuka (native dialog)
5. Pilih file .md/.txt/.json → toast "✓ Tersimpan"
6. Item muncul di Vault dengan type 'file'

### Test 3: Reload extension
1. Buka `chrome://extensions`
2. Klik "Reload" di RecallFox
3. Buka popup → klik "+ Baru" → klik upload buttons
4. **Expected:** Tetap berfungsi setelah reload

### Test 4: Popup lifecycle (buka-tutup-buka)
1. Buka popup → tutup (klik luar)
2. Buka popup lagi → klik "+ Baru" → klik upload buttons
3. **Expected:** Tetap berfungsi setelah multiple open/close cycles

### Test 5: Console log verification
1. Buka popup → klik kanan → "Inspect"
2. Buka Console tab
3. Klik "+ Baru" → klik "📄 Upload File teks"
4. **Expected:** Console shows:
   - `[RecallFox/addItemMenu] Upload File teks clicked → triggering file picker`
   - `[RecallFox] docFileInput change event fired. Files: 1` (setelah pilih file)

## Debugging Checklist

### Cek event listener terpasang
```javascript
// Di popup console:
getEventListeners(document.querySelector('#docFileInput'))
// Should show: { change: [EventListener] }
```

### Cek element yang dipilih
```javascript
document.querySelector('#docFileInput')
// Should return: <input type="file" id="docFileInput" ...>

document.querySelector('#docFileInput').style.display
// Should return: "" (not "none") — element is offscreen, not display:none
```

### Cek file input di DOM
```javascript
document.querySelectorAll('input[type="file"]')
// Should return: NodeList dengan docFileInput, screenshotFileInput, restoreInput
```

### Cek sheet state
```javascript
document.querySelector('#sheet').classList.contains('show')
// true = sheet terbuka, false = sheet tertutup
```

## File yang berubah

- `manifest.json` — version bump `3.20.38` → `3.20.39`
- `popup/popup.js` — `addItemMenu()` event handler: 3-branch logic (upload gambar / upload file / other) + console.log di docFileInput change handler
- `popup/popup.html` — `docFileInput` + `screenshotFileInput`: `display:none` → offscreen positioning

## Kesimpulan & Rekomendasi

**Kenapa 3x perbaikan sebelumnya gagal:**
1. Tidak menyadari bahwa `saveScreenshotManualSheet()` memanggil `openSheet()` yang menggantikan sheet menu
2. `closeSheet()` setelah `openSheet()` menutup sheet yang baru dibuka
3. `display:none` pada file input menyulitkan Firefox popup untuk trigger `.click()`

**Best practice untuk file upload di Firefox extension popup:**
1. Gunakan offscreen positioning, BUKAN `display:none`
2. Trigger `.click()` secara synchronous dalam user gesture handler
3. JANGAN panggil `closeSheet()` setelah `openSheet()` — sheet baru akan tertutup
4. Tambahkan console.log di setiap step kritis untuk debugging
5. Test dengan popup lifecycle (buka-tutup-buka) untuk verify event listener tetap terpasang

**Pattern yang robust:**
```javascript
if (callbackOpensItsOwnSheet) {
  callback(); // jangan closeSheet()
} else if (callbackTriggersFilePicker) {
  closeSheet(); // tutup menu dulu
  callback();  // trigger picker (gesture preserved)
} else {
  closeSheet();
  setTimeout(callback, 80); // default pattern
}
```
