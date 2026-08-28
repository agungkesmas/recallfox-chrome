# RecallFox v3.14.5 — Viewer Navigasi Konsisten + In-Place Edit Judul & Anotasi

**Tanggal:** 25 Jul 2026
**Tag sebelumnya:** v3.14.4
**Tipe:** Bug fix + UI/UX improvement (sesuai Google Doc "Log_Troubleshooting_RECALFOX.docx" Sesi 1)

## Ringkasan

Memperbaiki 2 issue dari log troubleshooting user:

1. **Bug #1: Navigasi halaman hilang saat switch dokumen via dropdown item (kotak hijau).**
   Saat user pilih dokumen lain via dropdown navigator bar di bagian bawah viewer, dan dokumen baru tersebut single-page (screenshot), footer navigasi halaman internal (tombol Prev/Hal X/Y/Next — kotak merah) **hilang total**. Penyebab: kode lama menyembunyikan footer nav saat `isMulti=false` (hanya tampilkan hint text). Layout berubah secara dramatis dan user kehilangan konteks.

2. **Improvement #2: In-place edit judul & anotasi.**
   Ikon pensil ✏️ sebelumnya membuka `prompt()` popup native browser — mengganggu alur kerja. Selain itu, edit anotasi harus lewat sheet terpisah (`openAnnotationNoteSheet`). User minta:
   - In-place edit judul (langsung jadi text input di header viewer)
   - Field anotasi inline di area viewer (bukan modal/pop-out terpisah)
   - Tombol "Simpan" / "Selesai" di header untuk konfirmasi perubahan judul + anotasi sekaligus

## Perubahan

### File: `popup/popup.js` — function `openImageModalViewer()`

#### A. Bug #1 Fix — Footer nav halaman selalu tampil

**Sebelumnya:**
```js
let prevBtn = null, nextBtn = null, ind = null;
if (isMulti) {
  prevBtn = document.createElement('button'); ...
  ind = document.createElement('span'); ...
  nextBtn = document.createElement('button'); ...
  footer.appendChild(prevBtn); footer.appendChild(ind); footer.appendChild(nextBtn);
} else {
  const hint = document.createElement('span');
  hint.textContent = 'Esc tutup · "↗ Tab baru" untuk layar besar';
  footer.appendChild(hint);
}
```

**Sekarang:** prevBtn / ind / nextBtn **selalu** dirender. Saat single-page, tombol disabled + ind menampilkan "Hal 1/1".

```js
const prevBtn = document.createElement('button');
prevBtn.textContent = '◀ Prev';
prevBtn.disabled = true; // page 0 or single-page
prevBtn.addEventListener('click', () => { if (cur > 0) render(cur - 1); });

const ind = document.createElement('span');
const nextBtn = document.createElement('button');
nextBtn.textContent = 'Next ▶';
nextBtn.disabled = (totalPages <= 1);

footer.appendChild(prevBtn);
footer.appendChild(ind);
footer.appendChild(nextBtn);
```

Function `render(i)` juga diupdate untuk **selalu** update nav state (sebelumnya dibungkus `if (isMulti)`):
```js
if (ind) ind.textContent = 'Hal ' + (i + 1) + '/' + totalPages;
if (prevBtn) prevBtn.disabled = (i === 0);
if (nextBtn) nextBtn.disabled = (i === totalPages - 1);
```

**Hasil:** Layout footer nav halaman konsisten, baik untuk single-page screenshot maupun multi-page document. Saat user switch dokumen via dropdown, layout tidak berubah — hanya state tombol (enabled/disabled) dan label indicator yang update.

#### B. Fitur #2a — In-place edit judul

**Sebelumnya:** `editTitleBtn.addEventListener('click', async () => { const newTitle = prompt('Edit judul:', ...) ... })` — popup native browser.

**Sekarang:** `editTitleBtn.addEventListener('click', enterEditMode)` — toggle mode edit:

- `titleSpan` (display) → hidden
- `titleInput` (`<input type="text">`) → visible + auto-focus + auto-select-all
- Tombol lain (`newTabBtn`, `editTitleBtn`) → hidden
- Tombol `💾 Simpan` + `Batal` → muncul di header
- `annotationArea` → border highlight + label visible

Keyboard:
- **Enter** di titleInput → `commitEdit()` (simpan)
- **Esc** di titleInput → `cancelEdit()` (rollback ke nilai sebelum edit)

#### C. Fitur #2b — Field anotasi inline

**Sebelumnya:** Anotasi harus diedit via sheet terpisah (`openAnnotationNoteSheet` di line 2079). Modal viewer tidak punya field anotasi sama sekali.

**Sekarang:** `<textarea>` inline selalu visible di antara body (image area) dan dots/footer nav:

```js
const annotationArea = document.createElement('div');
annotationArea.style.cssText = 'flex:none;background:#1c1917;border-top:1px solid #292524;padding:8px 14px;display:flex;flex-direction:column;gap:4px;max-height:120px';

const annotationTextarea = document.createElement('textarea');
annotationTextarea.value = item.annotationNote || item.source?.annotationNote || '';
annotationTextarea.placeholder = 'Klik untuk tambah anotasi / catatan untuk gambar ini… (auto-save saat blur)';
annotationTextarea.rows = 2;
```

**Auto-save on blur** (tidak perlu klik Simpan):
```js
annotationTextarea.addEventListener('blur', async () => {
  const newAnnot = annotationTextarea.value.trim();
  const currentAnnot = item.annotationNote || item.source?.annotationNote || '';
  if (newAnnot === currentAnnot) return;
  // Patch: dokumen → source.annotationNote + mirror top-level; screenshot → top-level only
  if (isDoc) {
    const newSource = { ...(item.source || {}), annotationNote: newAnnot };
    await updateItem(item.id, { source: newSource, annotationNote: newAnnot });
  } else {
    await updateItem(item.id, { annotationNote: newAnnot });
  }
  toast('✓ Anotasi tersimpan');
});
```

#### D. Fitur #2c — Tombol Simpan / Selesai di header

Tombol `💾 Simpan` (background hijau `#10b981`) + `Batal` muncul menggantikan tombol lain saat mode edit aktif.

`commitEdit()` menyimpan **judul + anotasi sekaligus** lewat satu panggilan `updateItem()`:
- Validasi: judul tidak boleh kosong
- Skip jika tidak ada perubahan
- Update local state (`item.title`, `item.source`, `item.annotationNote`)
- Update option di navigator select (`selectEl`)
- Toast konfirmasi: "✓ Judul & anotasi tersimpan"
- Auto-exit edit mode setelah simpan sukses

#### E. Backward compatibility

- Field anotasi menggunakan schema yang sama dengan `openAnnotationNoteSheet`:
  - Screenshot: top-level `item.annotationNote`
  - Dokumen: `item.source.annotationNote` + mirror top-level `item.annotationNote` (supaya `buildDocumentCaption` konsisten)
- `openAnnotationNoteSheet` (sheet lama) tetap tersedia sebagai escape hatch dari menu kontekstual item (`'annot-note'` action di line 2172).
- Tidak ada perubahan schema vault — annotation sync ke Supabase/PWA tidak terpengaruh.

## Wireframe Mode Edit

```
┌─────────────────────────────────────────────────────────────┐
│ 📄  [____judul di sini____]   3 halaman  [💾 Simpan][Batal][×]│  ← titleInput + Simpan/Batal
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                                                             │
│                  [ Halaman gambar ]                         │
│                                                             │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│ 📝 Anotasi / Catatan                                       │  ← label (edit mode only)
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ catatan teks interaktif yang bisa langsung diket…       │ │  ← textarea (highlighted)
│ └─────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────┤
│                  ● ● ●                                      │  ← dots (multi-page)
├─────────────────────────────────────────────────────────────┤
│              [◀ Prev]  Hal 2/5  [Next ▶]                   │  ← footer nav (selalu tampil)
├─────────────────────────────────────────────────────────────┤
│        [📋 Hal Ini] [📚 Semua] [📋 + Keterangan]           │  ← copy footer
├─────────────────────────────────────────────────────────────┤
│   [◀]  [Dropdown: dokumen lain ▾]  [▶]                     │  ← navigator item (kotak hijau)
└─────────────────────────────────────────────────────────────┘
```

Mode display (default, edit inactive):
```
┌─────────────────────────────────────────────────────────────┐
│ 📄  Judul dokumen di sini          3 halaman  [✏️][↗ Tab baru][×]│
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                  [ Halaman gambar ]                         │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ catatan anotasi (auto-save on blur)…                    │ │  ← textarea (low-key)
│ └─────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────┤
│              [◀ Prev]  Hal 2/5  [Next ▶]                   │
└─────────────────────────────────────────────────────────────┘
```

## Test plan

- [x] JS syntax check via `node --check popup/popup.js` — OK
- [x] JSON manifest valid — OK
- [x] web-ext lint: 0 errors, 120 warnings (baseline sama v3.14.4)
- [ ] Manual test: buka screenshot (1 halaman) → footer nav tampil "Hal 1/1" + tombol disabled
- [ ] Manual test: buka dokumen multi-page → footer nav tampil "Hal 1/N" + tombol enabled
- [ ] Manual test: switch dokumen via dropdown → layout footer nav **tidak berubah**, hanya state tombol + ind yang update
- [ ] Manual test: klik ✏️ → titleSpan hilang, titleInput muncul + auto-select + tombol Simpan/Batal
- [ ] Manual test: ketik judul baru → Enter → toast "✓ Judul & anotasi tersimpan" → option dropdown ter-update
- [ ] Manual test: klik ✏️ → Esc → rollback ke judul asli
- [ ] Manual test: klik textarea anotasi → ketik → klik luar → toast "✓ Anotasi tersimpan" (auto-save on blur)
- [ ] Manual test: buka PWA → anotasi yang di-edit di addon muncul di PWA (cross-device sync via existing schema)
