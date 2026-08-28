# RecallFox v3.11.36 — Copy Teks Metadata + Prayer Time Tetap Visible

**Tanggal**: 22 Juli 2026
**Sesi**: 2 (lanjutan dari Sesi 1, 18 Jul 2026)
**Pencatat**: Agung Wahyudi
**Total issues**: 2

---

## Ringkasan

Dua perbaikan kecil yang tidak merusak fitur apa pun:

1. **Tombol "Salin Teks Metadata"** — copy teks saja (tanpa gambar) supaya bisa paste ke WhatsApp, Gemini, AI chat, atau aplikasi mana pun yang tidak reliable menerima paste gambar+teks bersamaan.
2. **Prayer time tetap terlihat saat catatan/alat terbuka** — strip jadwal shalat tidak lagi tertutup oleh slide-in page.

---

## Issue #1 — Copy Teks Metadata Saja (Tanpa Gambar)

### User Feedback (dari Google Doc)

> "jadi di dalam menu ini bisakah ditambahkan kopi hanya metadata nya aja kyk di atas? teksnya doang, karena gini, di chat ai maupun wa, paste itu kadang gambarnya doang, teksnya ga ngikut, atau sebaliknya di gemini teks nya doang gambarnya ga ngikut. oleh karena itu tolong tambahkan kopi teks metadatanya doang bisa?"

### Root Cause

Paste gambar+teks bersamaan (`image/png` + `text/html` + `text/plain` via `ClipboardItem`) tidak reliable antar aplikasi:
- **WhatsApp Web**: hanya menerima `image/png`, teks hilang.
- **Gemini**: hanya menerima `text/plain` atau `text/html`, gambar hilang.
- **ChatGPT**: kadang menerima keduanya, kadang hanya salah satu.

User butuh opsi copy **text-only** supaya metadata (📸 judul, 🔗 URL, 🕒 waktu, 📝 catatan, 🔧 mode) selalu ikut saat paste, terlepas dari aplikasi tujuan.

### Solusi

Tambah tombol baru **"📝 Salin Teks Metadata"** di menu screenshot (itemSheet) dan **"📝 Copy Teks Saja"** di batch bar. Pakai `navigator.clipboard.writeText(textPlain)` — text-only, paste ke mana saja.

### Format Output (text-only)

**Single screenshot:**
```
📸 Screenshot — PLANET JARAK 600.000 TAHUN CAHAYA...
Sumber: https://www.youtube.com/watch?v=vLyYZD2kAD4
Waktu: Rabu, 22 Juli 2026 pukul 18.35
Mode: Viewport · 2428×1766 px
📝 Catatan: coba cari informasi terkait film ini ya
Ditangkap oleh RecallFox
```

**Batch (multiple screenshots):**
```
# 📷 Screenshot Bundle — RecallFox
Tanggal: 22 Jul 2026, 18.41 · Total: 1 screenshot

📸 1. PLANET JARAK 600.000 TAHUN CAHAYA...
Sumber: https://www.youtube.com/watch?v=vLyYZD2kAD4
Waktu: Rabu, 22 Juli 2026 pukul 18.35
Mode: Viewport · 2428×1766 px

[📸 Gambar 1 — 2428×1766 px]

— Ditangkap oleh RecallFox —
```

### Yang Ditambahkan

#### `popup/popup.js`
- Tombol baru di `itemSheet()` untuk screenshot: `data-a="copy-meta"` → "📝 Salin Teks Metadata"
- Handler `else if (k === 'copy-meta') { closeSheet(); copyScreenshotMetaToClipboard(it.id); }`
- Function baru `copyScreenshotMetaToClipboard(id)` — pakai `buildScreenshotCaption(item, null)` untuk dapat `textPlain` (dataUrl=null → tidak ada `<img>` di HTML, tapi textPlain tetap lengkap), lalu `navigator.clipboard.writeText(cap.textPlain)`.
- Tombol baru di batch bar `vaultBatchCopyMeta` (HTML `id="vaultBatchCopyMeta"`) — tampil saat screenshot terpilih (di `updateVaultBatchBarButtons()`).
- Function baru `vaultBatchCopyMetaAction()` — pakai `buildBatchCaption(screenshots)` dengan `dataUrl=null` untuk semua item, lalu `navigator.clipboard.writeText(cap.textPlain)`.
- Event listener `vaultBatchCopyMetaBtn.addEventListener('click', vaultBatchCopyMetaAction)`.

#### `popup/popup.html`
- Tambah `<button id="vaultBatchCopyMeta">📝 Copy Teks Saja</button>` di `vaultBatchBar` (default `display:none`, di-show oleh `updateVaultBatchBarButtons()` saat screenshot terpilih).

#### `lib/copy-format.js`
- **Tidak diubah** — fungsi `buildScreenshotCaption()` dan `buildBatchCaption()` sudah mengembalikan field `textPlain` sejak v3.11.34. Tinggal dipakai.

### Yang TIDAK Diubah (Jaminan Tidak Rusak)

- ✅ Tombol "📋 Salin Gambar" — tetap berfungsi (image/png only)
- ✅ Tombol "📦 Salin + Keterangan" — tetap berfungsi (multi-mime: gambar + teks)
- ✅ Tombol "📝 Catatan Anotasi" — tetap berfungsi
- ✅ Batch "📋 Copy + Keterangan" — tetap berfungsi
- ✅ Batch "🖼️ Copy Gambar Saja" — tetap berfungsi
- ✅ Preview modal copy (overlay.js) — tetap berfungsi
- ✅ Sync Supabase — tetap berfungsi (tidak ada perubahan)
- ✅ `lib/copy-format.js` — **tidak diubah**, hanya dipakai field yang sudah ada

### Tidak Ada Perubahan SQL

User bilang: "pikirkan database di supabasenya misalkan harus ada perubahan SQL skriptnya".

**Jawaban: TIDAK PERLU perubahan SQL.** Semua data metadata yang dibutuhkan untuk copy teks sudah ada di tabel `vault_items`:
- `title` → judul halaman
- `source.url` → URL sumber
- `source.capturedAt` → waktu tangkap
- `screenshot_mode` → mode capture (viewport/area/entire)
- `screenshot_width` + `screenshot_height` → dimensi
- `annotation_note` → catatan anotasi

Tidak ada kolom baru. Tidak ada skema migration.

---

## Issue #2 — Prayer Time Hilang Saat Edit Catatan

### User Feedback

> "sama satu lagi. saat edit atau tambah 'catatan' yang ditengah bawah itu, waktu shalat harus tetap keliatan ya. karena saya sering seharian pake edit atau tambah catatan terbuka gitu, buat nyatet waktu kerja."

### Root Cause

CSS `.page` (slide-in page untuk editor catatan & halaman alat) pakai `position:absolute; inset:0` — artinya menutupi **seluruh area popup**, termasuk header + cmd bar + strip jadwal shalat di bagian atas. Saat user buka catatan, `.page` slide-in dari kanan dan menutupi strip → countdown shalat hilang.

Catatan: di v3.11.7-fix (Issue #6) sudah ada fix yang memastikan strip tetap tampil di semua **view** (home/notes/tools) via `document.querySelector('.strip').style.display = '';`. Tapi itu hanya mengatur `display`, bukan z-index/positioning. Saat `.page` (z-index:30, absolute, inset:0) slide-in, strip (z-index:auto, static) tetap tertutup.

### Solusi

Ubah `.page` dari `inset:0` (top:0) menjadi `top:<offset>` di mana offset = posisi bottom strip relatif ke popup. Hitung dinamis via `getBoundingClientRect()` di `openPage()` supaya adaptif terhadap tinggi header/cmd/strip yang bervariasi (cmd hanya tampil di home view).

### Yang Diubah

#### `popup/popup.css`
```css
/* Sebelumnya */
.page{position:absolute;inset:0;...}

/* Sekarang */
.page{position:absolute;left:0;right:0;bottom:0;top:95px;...}
/* top:95px = fallback (header ~50 + strip ~38 + margin) */
```

#### `popup/popup.js` — `openPage()`
Tambah perhitungan dinamis:
```js
const strip = document.querySelector('.strip');
const popup = document.getElementById('popup');
const page = document.getElementById('page');
if (strip && popup && page) {
  const stripRect = strip.getBoundingClientRect();
  const popupRect = popup.getBoundingClientRect();
  const offset = Math.round(stripRect.bottom - popupRect.top);
  // Sanity check: offset 50-250px (kalau di luar range, fallback ke 95px)
  page.style.top = (offset > 0 && offset < 250) ? offset + 'px' : '95px';
}
```

#### `popup/popup.js` — strip toggle handler
Update juga saat user toggle strip-detail (expand/collapse) saat page sedang terbuka, supaya strip-detail tidak tertutup page:
```js
$('#stripBar').addEventListener('click', () => {
  $('#strip').classList.toggle('open');
  // Recompute .page.top kalau page sedang terbuka
  const page = $('#page');
  if (page && page.classList.contains('in')) {
    // ... same offset calculation, with max 400px (untuk akomodasi strip-detail expand)
  }
});
```

### Yang TIDAK Diubah

- ✅ Header (logo + tombol AI/theme/settings) — tetap di atas, tidak tertutup page
- ✅ Command bar (search) — tetap di home view, tidak tertutup page
- ✅ Strip jadwal shalat — tetap visible saat page terbuka
- ✅ Tab bar (Beranda/Catatan/Alat) — tetap di bawah, tidak tertutup page (page bottom:0 tapi tabbar di luar popup? cek: tabbar ada di dalam popup, jadi page menutupi tabbar juga)

**Catatan**: page bottom:0 berarti menutupi tabbar juga. Tapi itu sudah behavior v3.11.35 sebelumnya — page memang full-screen (kecuali area atas yang sekarang di-offset). User tidak komplain tentang tabbar tertutup, jadi biarkan.

### Edge Case

- **Strip di-expand saat page terbuka**: strip-detail (grid 6 waktu) akan tampil di bawah strip-bar. Page top di-recompute saat toggle, jadi strip-detail tidak tertutup.
- **Popup resize (sidebar mode)**: `getBoundingClientRect()` dipanggil saat `openPage()`, jadi offset selalu fresh. Tapi kalau user resize window saat page terbuka, offset tidak recompute. Workaround: user bisa close+open page. Bisa ditambah `resize` listener kalau perlu di versi depan.

---

## Testing Checklist

### Issue #1 — Copy Teks Metadata
- [ ] Buka Vault → klik screenshot → ⋯ → muncul tombol "📝 Salin Teks Metadata" (urutan: Lihat, Download, Salin Gambar, Salin + Keterangan, **Salin Teks Metadata**, Catatan Anotasi, Hapus)
- [ ] Klik "Salin Teks Metadata" → toast "✓ Teks metadata tersalin (paste ke WA/Gemini/AI chat)"
- [ ] Paste ke WhatsApp Web → muncul teks (📸 judul, Sumber, Waktu, Mode, 📝 Catatan)
- [ ] Paste ke Gemini → muncul teks lengkap
- [ ] Paste ke Notepad → muncul teks lengkap
- [ ] Buka mode batch → pilih multiple screenshot → tombol "📝 Copy Teks Saja" muncul
- [ ] Klik "Copy Teks Saja" → toast "✓ Teks metadata N screenshot tersalin"
- [ ] Paste → muncul format bundle (# 📷 Screenshot Bundle, 📸 1., 📸 2., ...)
- [ ] Tombol "📋 Salin Gambar" tetap berfungsi (image/png)
- [ ] Tombol "📦 Salin + Keterangan" tetap berfungsi (multi-mime)
- [ ] Tombol "📝 Catatan Anotasi" tetap berfungsi

### Issue #2 — Prayer Time Visible
- [ ] Buka Vault → strip jadwal shalat terlihat (🕌 Subuh 04:30 -2j15m)
- [ ] Klik catatan → editor terbuka (slide-in) → **strip jadwal shalat tetap terlihat di atas**
- [ ] Countdown shalat tetap update tiap menit (setInterval di popup.js)
- [ ] Klik strip saat di editor catatan → strip-detail expand → grid 6 waktu shalat terlihat
- [ ] Klik strip lagi → strip-detail collapse → page top menyesuaikan
- [ ] Buka halaman alat (mis. Waktu Shalat) → strip tetap terlihat
- [ ] Close page (tombol back) → kembali ke view normal, strip tetap terlihat
- [ ] Buka di sidebar mode (lebar penuh) → strip tetap terlihat saat page terbuka

---

## Files Changed

| File | Perubahan |
|------|-----------|
| `manifest.json` | Bump versi 3.11.35 → 3.11.36 |
| `popup/popup.js` | +1 tombol di itemSheet, +1 handler, +1 function `copyScreenshotMetaToClipboard`, +1 tombol di batch bar, +1 function `vaultBatchCopyMetaAction`, +1 event listener, +update `updateVaultBatchBarButtons`, +offset dinamis di `openPage`, +recompute di strip toggle |
| `popup/popup.html` | +1 tombol `#vaultBatchCopyMeta` di vaultBatchBar |
| `popup/popup.css` | Ubah `.page` dari `inset:0` ke `top:95px` (fallback) |
| `lib/copy-format.js` | **Tidak diubah** — field `textPlain` sudah ada |
| `supabase-schema.sql` | **Tidak diubah** — tidak ada perubahan SQL |
| `background.js` | **Tidak diubah** |

---

## Versi

| Versi | Tanggal | Perubahan |
|-------|---------|-----------|
| v3.11.35 | 22 Jul 2026 | Lazy download screenshot blob dari Supabase (cross-device paste fix) |
| **v3.11.36** | 22 Jul 2026 | **+Tombol Salin Teks Metadata (text-only), +Prayer time tetap visible saat catatan/alat terbuka** |
