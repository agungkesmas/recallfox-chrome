# RecallFox v3.11.37 — Hotfix: Tombol "Copy Teks Saja" tidak muncul di Sidebar

**Tanggal**: 22 Juli 2026
**Sesi**: 2 (hotfix)
**Pencatat**: Agung Wahyudi
**Total issues**: 1

---

## Ringkasan

Hotfix untuk bug di v3.11.36: tombol batch "📝 Copy Teks Saja" tidak muncul di **sidebar mode**. Penyebab: saat v3.11.36 ditambahkan, tombol `vaultBatchCopyMeta` hanya ditambahkan ke `popup/popup.html`, **lupa di-sync ke `sidebar/sidebar.html`**.

---

## Issue — Tombol "Copy Teks Saja" Tidak Muncul di Sidebar

### User Feedback

> "tombol salin batch metadata belum muncul"
> "iya di fix saja."

### Symptom

Setelah v3.11.36:
- ✅ Versi addon sudah 3.11.36 (sidebar mode)
- ✅ Tombol single "📝 Salin Teks Metadata" di menu screenshot (⋯) — **muncul**
- ✅ Tombol "📋 Copy + Keterangan" di batch bar — **muncul**
- ✅ Tombol "🖼️ Copy Gambar Saja" di batch bar — **muncul**
- ❌ Tombol "📝 Copy Teks Saja" di batch bar — **TIDAK muncul**

### Root Cause

RecallFox punya **2 entry HTML**:
1. `popup/popup.html` — dipakai saat user klik ikon RecallFox di toolbar (mode popup kecil)
2. `sidebar/sidebar.html` — dipakai saat user buka RecallFox sebagai sidebar (mode lebar penuh)

Keduanya hampir identik, hanya beda:
- `<body class="rf-sidebar-body">` (sidebar) vs `<body>` (popup)
- `<link href="sidebar.css">` tambahan di sidebar
- `<script src="sidebar.js">` (sidebar) vs `<script src="popup.js">` (popup)
- Beberapa layout tweak (cmd bar, shortcuts row, notes-bar flat, tools header)

`sidebar/sidebar.js` hanya `import '../popup/popup.js'` — jadi **semua logic JS shared**. Tapi **HTML statis** (seperti tombol di `vaultBatchBar`) harus di-sync manual ke kedua file.

Saat v3.11.36, saya tambah tombol `vaultBatchCopyMeta` ke `popup/popup.html` line 89, tapi **lupa tambah ke `sidebar/sidebar.html`**. Akibatnya:
- Tombol single (JS-generated di `itemSheet()`) muncul di kedua mode — karena JS shared
- Tombol batch (HTML statis) hanya muncul di popup mode — karena sidebar.html tidak punya elemen itu

### Bukti

Diff `popup/popup.html` vs `sidebar/sidebar.html` (sebelum fix):

```diff
<       <button class="btn btn-g" id="vaultBatchCopyMeta" title="..." style="display:none;...">📝 Copy Teks Saja</button>
---
>       (tidak ada baris ini di sidebar.html)
```

Di `sidebar/sidebar.html` line 84-85 (sebelum fix), tombol `vaultBatchCopyImg` langsung diikuti `vaultBatchCopyText` — tidak ada `vaultBatchCopyMeta` di antaranya.

### Fix

Tambah 1 baris ke `sidebar/sidebar.html` — sisipkan tombol `vaultBatchCopyMeta` di antara `vaultBatchCopyImg` (line 84) dan `vaultBatchCopyText` (line 85), **sama persis** seperti di `popup/popup.html`:

```html
<button class="btn btn-g" id="vaultBatchCopyMeta" title="Copy teks metadata saja (URL, judul, waktu) — paste ke WA/Gemini/AI" style="display:none;padding:4px 8px;font-size:11px">📝 Copy Teks Saja</button>
```

Tidak perlu ubah JS — `sidebar.js` import `popup.js`, dan `popup.js` sudah punya logic `$('#vaultBatchCopyMeta')` (line 574, 611, 705, 5873-5874) yang otomatis akan nemu tombol di sidebar.html setelah ditambahkan.

---

## Pencegahan ke Depan

**Issue struktural**: `sidebar/sidebar.html` adalah duplikat `popup/popup.html` yang harus di-sync manual. Ini rentang bug serupa di masa depan kalau ada perubahan HTML statis (tombol, elemen, dll).

**Opsi pencegahan** (belum diimplementasi di v3.11.37, untuk pertimbangan versi depan):

1. **Build script**: script sederhana yang diff kedua file dan warning kalau ada perbedaan selain yang expected (body class, link css, script src, layout tweaks).
2. **Refactor**: gabungkan ke satu HTML — sidebar pakai popup.html + query param `?mode=sidebar` yang trigger `body.classList.add('rf-sidebar-body')`. Lebih bersih tapi butuh test ekstensif.
3. **Konvensi**: setiap PR yang ubah `popup/popup.html` WAJIB juga ubah `sidebar/sidebar.html`. Tambahkan checklist di CHANGELOG.

Untuk sekarang, fix manual cukup. Issue struktural dicatat untuk versi depan.

---

## Files Changed

| File | Perubahan |
|------|-----------|
| `manifest.json` | Bump versi 3.11.36 → 3.11.37 |
| `sidebar/sidebar.html` | +1 baris: tombol `#vaultBatchCopyMeta` di `vaultBatchBar` (line 85) |
| `popup/popup.html` | **Tidak diubah** — sudah benar sejak v3.11.36 |
| `popup/popup.js` | **Tidak diubah** — logic sudah benar sejak v3.11.36 |
| `sidebar/sidebar.js` | **Tidak diubah** — hanya import popup.js |

---

## Testing Checklist

### Sidebar mode (yang bermasalah)
- [ ] Pull v3.11.37 di Firefox
- [ ] Reload addon via `about:debugging`
- [ ] Buka RecallFox sebagai **sidebar** (View → Sidebar → RecallFox, atau klik ikon di toolbar lalu pilih sidebar)
- [ ] Buka chip "Media" (screenshot)
- [ ] Klik tombol "☑️ Batch" di header vault
- [ ] Pilih minimal 1 screenshot
- [ ] **Verifikasi**: tombol "📝 Copy Teks Saja" muncul di batch bar (antara "🖼️ Copy Gambar Saja" dan "📋 Copy Teks")
- [ ] Klik "📝 Copy Teks Saja" → toast "✓ Teks metadata N screenshot tersalin"
- [ ] Paste ke WhatsApp/Gemini/Notepad → teks metadata lengkap muncul

### Popup mode (regression check)
- [ ] Buka RecallFox sebagai **popup** (klik ikon di toolbar)
- [ ] Ulangi langkah di atas
- [ ] **Verifikasi**: tombol "📝 Copy Teks Saja" tetap muncul (tidak rusak)

### Prayer time (regression check dari v3.11.36)
- [ ] Buka catatan (klik catatan di tab Catatan)
- [ ] Strip jadwal shalat tetap terlihat di atas editor catatan
- [ ] Countdown shalat tetap update tiap menit

---

## Versi

| Versi | Tanggal | Perubahan |
|-------|---------|-----------|
| v3.11.36 | 22 Jul 2026 | +Tombol Salin Teks Metadata, +Prayer time tetap visible saat catatan/alat terbuka (bug: tombol batch tidak muncul di sidebar) |
| **v3.11.37** | 22 Jul 2026 | **Hotfix: tambah tombol `vaultBatchCopyMeta` ke `sidebar/sidebar.html`** |
