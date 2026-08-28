# RecallFox v3.17.0 — Feedback Visual Tombol Copy (Button Flash + In-Modal Toast)

**Tanggal:** 25 Jul 2026
**Tag sebelumnya:** v3.16.9
**Tipe:** UX improvement (Sesi 1 follow-up #4)

## Ringkasan

User feedback (Google Doc Sesi 1):

> "Fungsi pada tombol aksi di panel RecallFox Vault (seperti tombol 'Salin Gambar', 'Salin + Keterangan', 'Salin Teks Metadata') sebenarnya BERJALAN secara fungsional. Buktinya: gambar berhasil tersalin dan di-paste ke input chat. Namun, TIDAK ADA konfirmasi visual bahwa tombol tersebut telah berhasil diklik.
>
> Ekspektasi: Muncul Notifikasi Toast ATAU Ubah state/teks tombol sementara (tombol berubah warna/icon centang dan teks berubah menjadi 'Tersalin!' selama 1.5 - 2 detik).
>
> Tugas: 1. Periksa event handler. 2. Cek promise/response sukses. 3. Tambah UI feedback (Toast atau button state). 4. Tampilkan toast error juga kalau gagal. 5. Standarisasi ke semua tombol di RecallFox."

### Diagnosis

Investigasi menemukan 2 akar masalah:

1. **Toast global z-index terlalu rendah**: `.toasts` CSS punya `z-index:60`, sedangkan modal viewer `openImageModalViewer` set `overlay.style.zIndex = '200'`. **Z-index 200 > 60 → toast tersembunyi di belakang modal viewer**. User tidak lihat konfirmasi.

2. **Tidak ada button state feedback**: tombol copy tetap di state default bahkan setelah operasi sukses/gagal. User tidak punya konfirmasi visual langsung di tombol itu sendiri.

### Fix v3.17.0

**1. Helper baru `flashButtonFeedback(btn, message, ok, duration)` di `popup/popup.js`**

Utility reusable yang:
- Simpan state tombol asli (textContent, backgroundColor, color, borderColor, disabled) ke `dataset`.
- Set tombol → `message` (e.g. "✓ Tersalin!" atau "✗ Gagal"), background hijau `#10b981` untuk ok / merah `#dc2626` untuk error, `disabled=true` (anti double-click).
- Tambah class `btn-flash-ok` atau `btn-flash-err` untuk styling CSS.
- Setelah `duration` (default 1800ms), restore semua state asli + hapus class.
- Anti-overlap: kalau dipanggil lagi saat masih flashing, timer di-clear dan restart.

**2. Helper baru `showViewerToast(msg, ok, duration)` di `popup/popup.js`**

Toast khusus untuk modal viewer:
- Cari `#rfImageViewerOverlay` (modal viewer aktif).
- Buat toast container `.rf-viewer-toasts` di dalam overlay dengan `z-index:250` (di atas modal z-index 200).
- Toast style sama dengan global toast (rounded pill, icon, animasi `tin`).
- Fallback: kalau tidak ada modal viewer aktif, panggil `toast()` global.

**3. Update `makeCopyBtn` di `openImageModalViewer`**

Signature onClick berubah dari `() => {}` → `(btn) => {}` supaya handler bisa panggil `flashButtonFeedback(btn, ...)`. Event listener: `btn.addEventListener('click', () => onClick(btn))`.

**4. Update 3 tombol copy**

Setiap tombol ("🖼️ Salin Gambar", "📋 Salin + Keterangan", "📝 Salin Teks Metadata") sekarang punya 3 state feedback:

| State | Toast | Button Flash |
|-------|-------|--------------|
| Loading (saat operasi berjalan) | "📋 Menyalin gambar..." | "⏳ Menyalin..." (hijau, 60s timeout) |
| Success | "✓ Gambar tersalin — paste ke WA/Telegram/Docs" | "✓ Tersalin!" (hijau, 1.8s) |
| Error | "Gagal salin gambar: ..." | "✗ Gagal" / "✗ Error" (merah, 1.8s) |
| Empty dataUrl | "Halaman belum termuat — tunggu sebentar" | "✗ Belum termuat" (merah, 1.8s) |

**5. CSS baru di `popup/popup.css`**

```css
.btn-flash-ok, .btn-flash-err {
  transition: background .15s, color .15s, border-color .15s !important;
  font-weight: 700 !important;
}
.btn-flash-ok { background:#10b981 !important; color:#fff !important; border-color:#059669 !important; }
.btn-flash-err { background:#dc2626 !important; color:#fff !important; border-color:#991b1b !important; }
.btn-flash-ok:disabled, .btn-flash-err:disabled { cursor:wait; opacity:1; }
```

## Standarisasi ke tombol lain (persiapan iterasi berikutnya)

Helper `flashButtonFeedback` didesain reusable dengan signature generik:
```js
flashButtonFeedback(btn, message, ok=true, duration=1800)
```

Bisa dipakai untuk tombol lain di iterasi berikutnya:
- Tombol "💾 Simpan" di editor anotasi
- Tombol "⬇️ Download" di viewer
- Tombol "↗ Tab baru" di viewer
- Tombol "📋 Copy" di batch vault
- Tombol "💾 Save to Vault" di RecallTape

Tinggal panggil `flashButtonFeedback(btn, '✓ Tersimpan!', true)` setelah operasi async selesai.

## File yang diubah

### `popup/popup.js`
- Tambah function `flashButtonFeedback(btn, message, ok, duration)` — ~50 baris.
- Tambah function `showViewerToast(msg, ok, duration)` — ~30 baris.
- Update `makeCopyBtn` signature: `onClick` sekarang terima `btn` param.
- Update 3 tombol copy: ganti `toast()` → `showViewerToast()`, tambah `flashButtonFeedback()` di setiap branch (loading/success/error/empty).

### `popup/popup.css`
- Tambah class `.btn-flash-ok`, `.btn-flash-err`, dan `:disabled` variant.

### `manifest.json`
- Version `3.16.9` → `3.17.0`.

## Test plan

- [x] `node --check popup/popup.js` — OK
- [x] `JSON.parse(manifest.json)` — OK
- [x] `web-ext lint`: 0 errors, 125 warnings (baseline +5 dari 120 karena 5 string baru dengan emoji)
- [x] Sanity test 7 check PASS:
  - `flashButtonFeedback` defined dengan signature benar
  - `showViewerToast` defined dengan signature benar
  - 4 `async (btn) =>` handlers (3 tombol copy + 1 lain)
  - 5 success flash calls
  - 11 error flash calls
  - 19 showViewerToast calls
  - 3 properly closed handlers (}` + `));`)
  - makeCopyBtn passes btn to onClick
- [ ] Manual test: buka screenshot → klik "🖼️ Salin Gambar" → tombol berubah jadi "⏳ Menyalin..." (hijau) → setelah selesai jadi "✓ Tersalin!" (hijau 1.8s) → kembali ke state asli
- [ ] Manual test: buka dokumen multi-page → klik "📋 Salin + Keterangan" → toast muncul DI DALAM modal viewer (tidak tertutup)
- [ ] Manual test: simulated error (disable clipboard permission di about:config) → tombol berubah jadi "✗ Gagal" (merah) + toast error
