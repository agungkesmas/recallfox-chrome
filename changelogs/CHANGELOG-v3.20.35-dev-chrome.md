# CHANGELOG v3.20.35-dev-chrome — Fix DnD Drop Zone "Lepaskan di sini untuk mengeluarkan dari Folder"

**Tanggal:** 2026-08-05
**Baseline:** v3.20.34-dev-chrome (`9f3bc73`)
**Tipe:** Bug fix (DnD) — **DEV RELEASE (bukan stable)**

---

## ⚠️ Status: DEV (Bukan Stable)

Release ini untuk **testing saja**. Tag: `v3.20.35-dev-chrome` (bukan `-stable`). Tandai stable setelah user confirm fix-nya jalan.

---

## Ringkasan

Fix bug: **drop event gagal fire di Chrome** saat user drag item keluar dari folder ke drop zone "Lepaskan di sini untuk mengeluarkan dari Folder". Di Firefox berjalan lancar, tapi di Chrome drop zone tidak responsif (drop tidak trigger unparent action).

---

## Root Cause

Saya audit `wireVaultEvents()` di `popup/popup.js` (line 1710-1801) dan nemuin **4 bug** yang menyebabkan drop gagal di Chrome:

### Bug #1: Tidak ada `dragenter` handler di dropzone

```js
// v3.20.34 — kode lama
dropzoneEl.addEventListener('dragover', (e) => { ... });
dropzoneEl.addEventListener('drop', (e) => { ... });
// ← TIDAK ADA dragenter!
```

**Chrome BUTUH `dragenter` handler yang `preventDefault()`** untuk "register" element sebagai valid drop target. Firefox cukup `dragover` saja. Tanpa `dragenter`, Chrome tidak akan fire `drop` event.

### Bug #2: Dropzone di-show saat dragstart (display:none → display:'')

```js
// v3.20.34 — kode lama
if (item && getParentId(item)) {
  dropzoneEl.style.display = '';  // langsung show
}
```

Chrome kadang "lose track" drop target kalau `display` berubah during dragstart. Browser perlu layout settle dulu sebelum bisa register drop target baru.

### Bug #3: Race condition — `draggedItemId` bisa null

```js
// v3.20.34 — kode lama
dropzoneEl.addEventListener('drop', (e) => {
  if (!draggedItemId) return;  // ← kalau null, drop diabaikan!
  ...
});
```

`draggedItemId` bisa null kalau:
- Drag dimulai dari luar extension context (cross-frame)
- State hilang karena re-render
- Race condition antara dragstart dan drop

Tidak ada fallback untuk baca `dataTransfer.getData('text/plain')` yang sudah di-set di dragstart.

### Bug #4: Visual feedback `.drag-over` class tidak pernah di-add

CSS sudah punya class `.drag-over` (line 188 popup.css) untuk highlight dropzone saat drag over, TAPI kode JS tidak pernah add/remove class ini. User tidak dapat feedback visual bahwa dropzone aktif.

---

## Perbaikan

### Fix #1: Tambah `dragenter` handler

```js
// v3.20.35-dev-chrome — kode baru
dropzoneEl.addEventListener('dragenter', (e) => {
  let itemId = draggedItemId;
  if (!itemId) {
    try { itemId = e.dataTransfer?.getData('text/plain') || null; } catch (_) {}
  }
  if (!itemId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  dropzoneEl.classList.add('drag-over');
});
```

### Fix #2: Show dropzone dengan `requestAnimationFrame`

```js
// v3.20.35-dev-chrome — kode baru
requestAnimationFrame(() => {
  if (draggedItemId) {  // cek lagi — user mungkin sudah batal drag
    dropzoneEl.style.display = '';
  }
});
```

`requestAnimationFrame` memastikan layout settle di frame berikutnya, sebelum Chrome coba register dropzone sebagai drop target.

### Fix #3: Fallback baca `dataTransfer` di semua handler

Di `dragenter`, `dragover`, dan `drop` — kalau `draggedItemId` null, coba baca dari `e.dataTransfer.getData('text/plain')`:

```js
let itemId = draggedItemId;
if (!itemId) {
  try { itemId = e.dataTransfer?.getData('text/plain') || null; } catch (_) {}
}
if (!itemId) return;
```

### Fix #4: Visual feedback `.drag-over` class

- `dragenter` → `dropzoneEl.classList.add('drag-over')`
- `dragover` → pertahankan class (fire berulang)
- `dragleave` → `dropzoneEl.classList.remove('drag-over')` (dengan cek `relatedTarget` supaya tidak flicker saat masuk child element)
- `drop` → remove class
- `dragend` → remove class + hide dropzone

### Fix #5: `dragleave` dengan cek `relatedTarget`

```js
dropzoneEl.addEventListener('dragleave', (e) => {
  // Hanya remove class kalau benar-benar keluar dari dropzone
  // (dragleave fire saat child element exit — cek relatedTarget)
  if (e.relatedTarget && dropzoneEl.contains(e.relatedTarget)) return;
  dropzoneEl.classList.remove('drag-over');
});
```

Tanpa cek ini, `dragleave` fire saat pointer masuk child element (mis. text "📥 Lepaskan di sini..."), menyebabkan visual feedback flicker.

---

## File yang Diubah

| File | Perubahan |
|---|---|
| `manifest.json` | Bump version 3.20.34 → 3.20.35 |
| `popup/popup.js` | Rewrite DnD dropzone handler (line 1733-1844): + `dragenter` handler, + `requestAnimationFrame` di dragstart, + fallback `dataTransfer.getData`, + `.drag-over` class add/remove, + `relatedTarget` check di dragleave |
| `CHANGELOG-v3.20.35-dev-chrome.md` | BARU — dokumentasi ini |

---

## Anti-Regression Safeguard (Strict)

Sesuai permintaan user: *"Pastikan perbaikan ini terisolasi hanya pada fungsionalitas Drag and Drop pengeluaran item dari folder. Jangan mengubah atau merusak fitur manajemen folder lainnya, pencarian, atau navigasi yang sudah berjalan normal."*

**TIDAK ada perubahan di:**
- ❌ Drop on group folder (line 1777-1786) — logic tetap sama, masih jalan
- ❌ Drag over group highlight (line 1771-1776) — tetap sama
- ❌ `moveItemToGroup()` function — tetap sama
- ❌ Expand/collapse folder (line 1720-1731) — tetap sama
- ❌ Search, filter, sort, batch mode — tetap sama
- ❌ Magic Command, Magic Folder (Auto Group AI) — tetap sama
- ❌ Import Paket Link — tetap sama
- ❌ Clipboard fallback — tetap sama
- ❌ Schema Supabase — tidak ada perubahan
- ❌ `lib/magic-command.js`, `lib/assistant.js`, `lib/vault-tree.js`, `lib/storage.js` — tetap sama

**Perubahan HANYA di DnD dropzone unparent** (`wireVaultEvents` bagian dropzone, line 1788-1844).

**Firefox tidak terpengaruh** karena:
- `dragenter` handler baru juga jalan di Firefox (redundant tapi tidak break)
- `requestAnimationFrame` jalan di Firefox (behavior sama)
- Fallback `dataTransfer.getData` jalan di Firefox (fallback tidak pernah trigger kalau `draggedItemId` sudah ter-set)
- `.drag-over` class add/remove jalan di Firefox (visual feedback baru — improvement, bukan breaking change)

---

## Test Plan

### Test 1: Drop zone unparent di Chrome popup toolbar
1. Load extension di Chrome (`chrome://extensions` → Load unpacked)
2. Pastikan ada folder dengan item di dalamnya
3. Drag item dari dalam folder ke area drop zone "📥 Lepaskan di sini untuk mengeluarkan dari Folder"
4. **Expected (v3.20.34):** Drop tidak trigger — item tetap di folder
5. **Expected (v3.20.35-dev-chrome):** 
   - Drop zone highlight (background berubah via `.drag-over` class)
   - Drop trigger `moveItemToGroup(itemId, null)`
   - Item keluar dari folder, jadi top-level
   - Toast konfirmasi (jika ada)

### Test 2: Drop zone unparent di Chrome popout sidebar (iframe)
1. Buka halaman web http(s)
2. Klik tombol "rf" floater → popout sidebar muncul (iframe)
3. Drag item dari dalam folder ke drop zone
4. **Expected:** Sama seperti Test 1 — drop trigger, item keluar dari folder

### Test 3: Drop zone unparent di Firefox (regression test)
1. Load extension di Firefox (`about:debugging` → Load Temporary Add-on)
2. Drag item dari dalam folder ke drop zone
3. **Expected:** Masih jalan seperti v3.20.34 (tidak ada regression)
4. Bonus: visual feedback `.drag-over` sekarang muncul di Firefox juga (improvement)

### Test 4: Drop on group folder (regression test)
1. Drag item loose ke folder lain
2. **Expected:** Item pindah ke folder tujuan (tidak terpengaruh fix ini)

### Test 5: Drag cancel (regression test)
1. Drag item, lalu lepas di area kosong (bukan drop zone, bukan folder)
2. **Expected:** Item tetap di tempat asal, dropzone hilang, tidak ada error

### Test 6: Drag folder ke folder lain (nested folder, regression test)
1. Drag folder ke folder lain
2. **Expected:** Folder pindah jadi sub-folder (tidak terpengaruh fix ini)

### Test 7: Visual feedback `.drag-over`
1. Drag item dari folder
2. Hover atas drop zone
3. **Expected:** Drop zone highlight (background berubah warna, sedikit scale up)
4. Keluar dari drop zone
5. **Expected:** Highlight hilang

---

## Cara Test Lengkap

### Chrome
1. Download `recallfox-chrome-v3.20.35-dev.zip` di bawah
2. Extract → `chrome://extensions` → enable Developer mode → Load unpacked → pilih folder
3. Buka popup toolbar RecallFox ATAU popout sidebar
4. Drag item dari folder → drop ke "📥 Lepaskan di sini untuk mengeluarkan dari Folder"
5. Verify: item keluar dari folder, drop zone highlight saat drag over

### Firefox (regression test)
1. Download `recallfox-firefox-v3.20.35-dev.zip` (akan di-release terpisah setelah Firefox fix)
2. ATAU: gunakan Firefox v3.20.34-dev yang sudah ada — fix ini belum di-apply ke Firefox
3. Test: drag item dari folder → drop ke drop zone → masih jalan (tidak ada regression)

---

## Limitasi

1. **Cross-frame drag** — kalau user drag item dari popup toolbar ke popout sidebar (atau sebaliknya), drop tidak akan jalan karena `draggedItemId` di popup berbeda context dengan sidebar. Ini limitation browser (cross-frame DnD butuh dataTransfer, bukan shared state). Fallback `dataTransfer.getData` sudah di-add, tapi cross-frame DnD antar extension page masih unreliable.

2. **Drag dari luar extension** — kalau user drag file/text dari halaman web ke drop zone, tidak akan trigger unparent karena `dataTransfer.getData('text/plain')` berisi data external, bukan item ID. Ini by design (drop zone hanya untuk unparent vault item).

---

## Next Steps

Kalau fix ini jalan dengan baik di testing Chrome:
- Tandai stable: `v3.20.35-stable-chrome`
- Apply fix yang sama ke Firefox: `v3.20.35-dev` (Firefox) → test → `v3.20.35-stable`

Kalau masih ada bug:
- Iterasi fix → bump ke `v3.20.36-dev-chrome`
- Ulangi testing

---

## Catatan Teknis

### Kenapa Chrome butuh `dragenter` tapi Firefox tidak?

Spesifikasi HTML5 Drag and Drop:
- `dragenter` — fire saat pointer masuk element yang valid drop target
- `dragover` — fire berulang saat pointer di atas element
- `drop` — fire saat user lepas mouse di element

Untuk `drop` fire, `dragover` MUST call `preventDefault()`. TAPI Chrome juga butuh `dragenter` preventDefault untuk **register element sebagai drop target** di awal. Firefox lebih permissive — cukup `dragover` saja.

Reference: https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API/Drag_operations#droptargets

### Kenapa `requestAnimationFrame` penting?

Saat `dragstart` fire, browser mulai "drag session". Kalau kita ubah DOM (mis. show dropzone yang tadinya `display:none`) selama dragstart handler, browser perlu reflow layout. Chrome kadang tidak sempat register dropzone baru sebagai drop target sebelum drag event pertama (`dragenter`/`dragover`) fire.

`requestAnimationFrame` menunda show dropzone ke frame berikutnya — layout sudah settle, drag session sudah aktif, dropzone bisa di-register sebagai drop target dengan benar.

### Kenapa `relatedTarget` check di `dragleave`?

`dragleave` fire setiap kali pointer keluar dari element ATAU child element-nya. Tanpa cek `relatedTarget`:
- Pointer masuk drop zone → `dragenter` fire → add `.drag-over`
- Pointer masuk text "📥 Lepaskan di sini..." (child element) → `dragleave` fire (keluar dari parent) → remove `.drag-over`
- Visual feedback flicker

Dengan cek `relatedTarget`:
- `dragleave` hanya remove class kalau `relatedTarget` (element tujuan) TIDAK ada di dalam dropzone
- Kalau relatedTarget masih di dalam dropzone (mis. pindah ke child element), jangan remove class
