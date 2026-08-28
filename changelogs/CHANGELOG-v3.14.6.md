# RecallFox v3.14.6 — Viewer Dispatcher + Copy Button Robustness

**Tanggal:** 25 Jul 2026
**Tag sebelumnya:** v3.14.5
**Tipe:** Bug fix (Sesi 1 follow-up — feedback user setelah v3.14.5)

## Ringkasan

User test ulang v3.14.5 dan menemukan 2 bug lanjutan:

> "lihat di gambar ke dua, kyknya masih sama jadi jika pindah list media, itu tombol navigasi prev dan next tidak mendeteksi isinya ada 2 halaman. terus tombol 'hal ini' dan '+keterangan' tidak berfungsi. cek lagi."

Investigasi menemukan akar masalah yang sebenarnya berbeda dari hipotesis awal v3.14.5:

### Bug A — Nav prev/next tidak detect multi-page saat switch via dropdown

**Akar masalah (baru ditemukan di v3.14.6):** Di navigator bar (line 2046, 2058, 2066 di v3.14.5), tombol prev/next item dan `selectEl.change` **selalu** panggil `openScreenshotViewer(id)`. Fungsi `openScreenshotViewer` hanya fetch 1 page via `GET_SCREENSHOT_BLOB`. Jika item yang dipilih adalah dokumen multi-page (type='document'), hanya page 0 yang dimuat → `validPages.length === 1` → `isMulti=false` → footer nav tampil "Hal 1/1" dengan tombol disabled.

**Fix v3.14.5 tidak menyelesaikan ini** karena v3.14.5 hanya fix konsistensi layout (selalu tampil footer nav) — tidak fix root cause bahwa dokumen multi-page tidak difetch dengan benar saat dipilih via dropdown.

**Fix v3.14.6:** Buat helper `openViewerById(id)` yang dispatch ke `openScreenshotViewer` (untuk type='screenshot') atau `openDocumentViewer` (untuk type='document'). Ganti semua 3 call site di navigator bar (prevItemBtn, selectEl.change, nextItemBtn) supaya pakai helper ini.

### Bug B — Tombol "Hal Ini" dan "+ Keterangan" tidak berfungsi

**Akar masalah:** Bug B adalah **konsekuensi dari Bug A**. Untuk dokumen multi-page yang dirender sebagai single-page (page 0 saja), tombol copy mencoba copy page 0. Image dari Supabase Storage umumnya JPG. `writeScreenshotToClipboard` strategi 1 butuh `image/png` blob → konversi via canvas. Kalau konversi gagal dan `textHtml` kosong (kasus tombol "Hal Ini" yang tidak pass textHtml), strategi 2 skip, strategi 3 juga skip (textPlain kosong) → return `clipboard_write_failed`. User lihat tombol "tidak berfungsi".

**Fix v3.14.6:**
- Guard `dataUrl` null lebih informatif: toast "Halaman belum termuat — tunggu sebentar lalu coba lagi" (sebelumnya hanya "Halaman belum termuat").
- Tombol "Hal Ini" sekarang pass `textPlain` minimal (judul + halaman) supaya strategi 3 (text-only fallback) di `writeScreenshotToClipboard` bisa menulis sesuatu ke clipboard sebagai last resort — bukan gagal total dengan `clipboard_write_failed`.
- Toast feedback dibedakan: "✓ Gambar tersalin" vs "✓ Tersalin teks saja (browser blokir clipboard image)" supaya user tahu fallback terjadi.
- Konsol logging ditambahkan untuk debug: `console.warn` saat dataUrl null, `console.error` saat copy failed dengan detail result + cap.
- Setelah fix Bug A, dokumen multi-page akan punya `validPages` dengan multiple entries → `dataUrl` tersedia di semua index → tombol copy akan berfungsi normal.

## Perubahan

### File: `popup/popup.js`

#### A. Helper `openViewerById(id)` — dispatcher

```js
function openViewerById(id) {
  const item = currentVault.items.find(i => i.id === id);
  if (!item) { toast('Item tidak ditemukan', false); return; }
  if (item.type === 'document') {
    openDocumentViewer(id);
  } else {
    openScreenshotViewer(id);
  }
}
```

#### B. Navigator bar — ganti 3 call site

Sebelumnya:
```js
prevItemBtn.addEventListener('click', () => {
  if (currentNavIdx > 0) { closeViewer(); openScreenshotViewer(navItems[currentNavIdx - 1].id); }
});
selectEl.addEventListener('change', () => { closeViewer(); openScreenshotViewer(selectEl.value); });
nextItemBtn.addEventListener('click', () => {
  if (currentNavIdx < navItems.length - 1) { closeViewer(); openScreenshotViewer(navItems[currentNavIdx + 1].id); }
});
```

Sekarang: ketiga call site pakai `openViewerById(id)`.

#### C. Tombol "📋 Hal Ini" — robust copy

Sebelumnya:
```js
const dataUrl = validPages[cur]?.dataUrl;
if (!dataUrl) { toast('Halaman belum termuat', false); return; }
const result = await writeScreenshotToClipboard(dataUrl, '', '');
toast(result.ok ? '✓ Gambar tersalin' : 'Gagal: ' + result.error, result.ok);
```

Sekarang:
```js
const page = validPages[cur];
const dataUrl = page?.dataUrl;
if (!dataUrl) {
  console.warn('[RecallFox/Tape] Hal Ini: dataUrl null at cur=' + cur, { validPages: validPages.length, isMulti });
  toast('Halaman belum termuat — tunggu sebentar lalu coba lagi', false);
  return;
}
const label = (item.title || 'Gambar') + (isMulti ? ' (Hal ' + (cur + 1) + '/' + totalPages + ')' : '');
const result = await writeScreenshotToClipboard(dataUrl, label, '');
if (result.ok) {
  toast(result.fallback === 'text_only'
    ? '✓ Tersalin teks saja (browser blokir clipboard image)'
    : '✓ Gambar tersalin', true);
} else {
  console.error('[RecallFox] Hal Ini copy failed:', result);
  toast('Gagal salin: ' + (result.error || 'unknown'), false);
}
```

#### D. Tombol "📋 + Keterangan" — guard + logging

Sama pattern: guard `dataUrl` null lebih informatif + `console.error` saat failed + toast dibedakan (image vs text-only fallback).

### File: `manifest.json`

Version `3.14.5` → `3.14.6`.

## Test plan

- [x] `node --check popup/popup.js` — OK
- [x] `JSON.parse(manifest.json)` — OK
- [x] `web-ext lint`: 0 errors, 120 warnings (baseline sama v3.14.5)
- [x] 5 sanity test PASS (dispatcher untuk screenshot, document 2 pages, screenshot lain, not-found, Bug A scenario simulation)
- [ ] Manual test: buka dokumen multi-page → klik dropdown → pilih dokumen multi-page lain → footer nav harus tampil "Hal 1/N" dengan tombol enabled (sebelumnya tampil "Hal 1/1" disabled)
- [ ] Manual test: di dokumen multi-page, klik "📋 Hal Ini" → toast "✓ Gambar tersalin" + paste ke WhatsApp/Telegram harus menampilkan gambar
- [ ] Manual test: di dokumen multi-page, klik "📋 + Keterangan" → toast "✓ Gambar + keterangan tersalin" + paste ke rich text editor harus menampilkan gambar + keterangan
- [ ] Manual test: switch dari dokumen multi-page ke screenshot single-page → footer nav tampil "Hal 1/1" disabled (konsistensi layout dari v3.14.5 tetap berlaku)
