# Changelog v3.11.14 — 2 fix dari Log Troubleshooting Sesi terakhir

> **Versi:** 3.11.14
> **Baseline:** v3.11.13 (commit 8804e32)
> **Sumber catatan:** Log Troubleshooting — Aplikasi Web & Addon (Sesi terakhir, 2 issues)

---

## 🐛 2 Fix dari Log Troubleshooting Sesi terakhir

### Issue #1 — Toggle Batch Diselaraskan ke Semua Tipe Item

**Sebelumnya (v3.11.11–v3.11.13):** Mode batch hanya aktif untuk chip `screenshot`. User harus
select screenshot satu-satu untuk copy, tapi tidak bisa batch copy/delete di Prompt, Link,
Bundle, atau Arsip.

**User feedback:**
> "di catatan ini, kan banyak area mubazir ya, harusnya dikasih mode toggle batch aja di bagian yang saya kotaki ijo. toggle batch itu sudah ada di batch select media. tinggal tiru aja. selarasin di menu lainnya juga misal prompt, link, bundle dan arsip"

**Sekarang (v3.11.14):** Mode batch aktif untuk SEMUA chip yang punya item:
- `prompt` — Copy Teks, Hapus
- `context` — Copy Teks, Hapus
- `link` — Copy Teks, Hapus
- `snapshot` — Copy Teks, Hapus
- `screenshot` — Copy + Keterangan, Copy Gambar Saja, Hapus (sudah ada sebelumnya)
- `bundle` — Copy Bundle, Hapus
- `archive` — Unarsip, Hapus permanen

**Implementasi:**
- `popup/popup.js`:
  - Tambah `BATCH_SUPPORTED_CHIPS = new Set(['prompt', 'context', 'link', 'bundle', 'snapshot', 'screenshot', 'archive'])`.
  - Update `updateBatchModeBtnVisibility()` agar tombol batch tampil untuk semua chip yang support.
  - Tambah `updateVaultBatchBarButtons()` — tampilkan/sembunyikan tombol di batch bar sesuai chip aktif.
  - Update `toggleVaultBatchMode()` — toast message dinamis sesuai chip.
  - Tambah `vaultBatchCopyTextAction()` — copy multiple prompt/context/link/snapshot dengan format rapi `## Judul [Tipe]\nIsi`, dipisah `---`.
  - Tambah `vaultBatchCopyBundleAction()` — copy multiple bundle, gabungkan semua anggota + catatan + inline prompt.
  - Tambah `vaultBatchUnarchiveAction()` — keluarkan multiple item/bundle dari arsip.
  - Update `vaultBatchDeleteAction()` — pesan konfirmasi dinamis (khusus archive: "permanen").
  - Update `renderList()` — checkbox batch muncul untuk SEMUA tipe (bukan hanya screenshot).
  - Tambah binding untuk 3 tombol baru: `vaultBatchCopyText`, `vaultBatchCopyBundle`, `vaultBatchUnarchive`.
- `popup/popup.html` + `sidebar/sidebar.html`:
  - Tambah 3 tombol baru di `vaultBatchBar`: `📋 Copy Teks`, `📋 Copy Bundle`, `📦 Unarsip`.
  - Tambah `flex-wrap: wrap` di `vaultBatchBar` & `notesBatchBar`.
  - Update title tombol batch menjadi generik ("pilih multiple item untuk aksi sekaligus").
- `background.js`:
  - Update handler `DELETE_ITEMS_BATCH` — handle JUGA bundle (sebelumnya hanya item).
  - Import `deleteBundle` & `getVault`, cek apakah id adalah item atau bundle, panggil fungsi hapus yang sesuai.
  - Tambah field `failed` di response (jumlah yang gagal).

---

### Issue #2 — Tombol Hapus/Batal/Konfirmasi Tidak Ketutupan di Sidebar Sempit

**Sebelumnya (v3.11.13):** Saat sidebar dikecilkan (≤360px), tombol di berbagai tempat ketutupan:
- `vaultBatchBar` & `notesBatchBar` — tombol Hapus/Batal terpotong, tidak bisa diklik.
- `confirmstrip` (konfirmasi hapus) — tombol Batal/Hapus terdorong ke kanan, terpotong.
- `page-foot` (catatan editor) — 5 tombol (Hapus, Arsip, Pin, Salin, Selesai) tidak muat 1 baris.
- `sheet-form .btn-row` (Buat/Edit Bundle) — tombol Batal/Simpan terpotong.

**User feedback:**
> "tombol hapusnya ketutupan, harusnya ada logika mengikuti sidebar ketika dikecilin tu tetap keliatan tombol hapus dan batalnya. di menu lain juga sama untuk edit, tambah dsb itu tombolnya sering ketutupan begini. harusnya ada logika mengikuti lebar sidebar."

**Sekarang (v3.11.14):** Tambah responsive CSS rules di `sidebar/sidebar.css` untuk 3 breakpoint:

#### w-sm (≤360px) — sidebar sempit normal
- `vaultBatchBar` & `notesBatchBar`: padding 5px 8px, gap 4px, tombol padding 3px 6px, font-size 10px.
- `confirmstrip`: flex-wrap, teks full width di atas, tombol Batal/Hapus flex:1 di bawah.
- `page-foot`: 2 tombol per baris (`flex: 1 1 calc(50% - 5px)`), padding 6px 4px, font-size 10.5px.
- `sheet-form .btn-row`: flex-wrap, tombol 50/50 atau full width.

#### w-xs (≤280px) — sidebar sangat sempit
- `vaultBatchBar` & `notesBatchBar`: count text full width di atas, tombol di bawah.
- `confirmstrip`: teks full width, tombol 50/50.
- `page-foot`: 2 tombol per baris, font-size 10px.
- `sheet-form .btn-row`: tombol 50/50.

#### w-xxs (≤220px) — sidebar minimal
- Semua tombol super kompak: padding 3px 4px, font-size 9px.
- `sheet-form .btn-row`: tombol full width (1 per baris).

#### General (semua lebar)
- `.btn-row` sekarang `flex-wrap: wrap` by default.
- `.confirmstrip` sekarang `flex-wrap: wrap` by default.
- `.btn-row .btn` & `.page-foot .btn` sekarang `min-width: 0` (anti overflow).

**Implementasi:**
- `sidebar/sidebar.css`: Tambah ~150 baris CSS rules untuk w-sm/w-xs/w-xxs + general flex-wrap.
- `popup/popup.html` + `sidebar/sidebar.html`: Tambah `flex-wrap: wrap` inline di `vaultBatchBar` & `notesBatchBar`.

---

## File yang Diubah (v3.11.14)

| File | Jenis | Ringkasan |
|---|---|---|
| `manifest.json` | Modify | Bump 3.11.13 → 3.11.14 |
| `popup/popup.js` | Modify | Generalisasi batch mode: BATCH_SUPPORTED_CHIPS, updateVaultBatchBarButtons, vaultBatchCopyTextAction, vaultBatchCopyBundleAction, vaultBatchUnarchiveAction. Update renderList agar checkbox muncul untuk semua tipe. Tambah binding 3 tombol baru. |
| `popup/popup.html` | Modify | Tambah 3 tombol baru di vaultBatchBar (Copy Teks, Copy Bundle, Unarsip). Tambah flex-wrap di vaultBatchBar & notesBatchBar. |
| `sidebar/sidebar.html` | Modify | Sama dengan popup.html — tambah 3 tombol baru + flex-wrap. |
| `sidebar/sidebar.css` | Modify | Tambah ~150 baris responsive CSS rules untuk w-sm/w-xs/w-xxs + general flex-wrap untuk btn-row, confirmstrip, page-foot, batch bar. |
| `background.js` | Modify | Update handler DELETE_ITEMS_BATCH agar handle juga bundle (import deleteBundle, cek id item vs bundle). |
| `README.md` | Modify | Update header ke v3.11.14 + 2 fix summary. |
| `CHANGELOG-v3.11.14.md` | **NEW** | File ini. |

---

## Testing Checklist

- [ ] Load addon di Firefox (`about:debugging` → Load Temporary Add-on → `manifest.json`)
- [ ] Cek versi: 3.11.14
- [ ] **Issue #1 — Toggle batch di semua tipe**:
  - [ ] Buka sidebar → chip "Prompt" → muncul tombol "☑️ Batch" di header vault
  - [ ] Klik Batch → muncul checkbox di setiap prompt item
  - [ ] Centang 2-3 prompt → tombol "📋 Copy Teks" dan "🗑️ Hapus" muncul di batch bar
  - [ ] Klik "Copy Teks" → paste di notepad → format rapi `## Judul [Prompt]\nIsi` dipisah `---`
  - [ ] Klik "Hapus" → konfirmasi → item terhapus
  - [ ] Ulangi untuk chip "Link", "Bundle", "Snapshot", "Konteks"
  - [ ] Chip "Bundle" → centang 2 bundle → "📋 Copy Bundle" → paste → format rapi dengan `# 📦 Bundle: Nama` + semua anggota
  - [ ] Chip "Arsip" → centang 2 item → "📦 Unarsip" → item keluar dari arsip
  - [ ] Chip "Arsip" → centang 2 item → "🗑️ Hapus" → konfirmasi "permanen" → item terhapus
  - [ ] Chip "Screenshot" → batch mode tetap jalan seperti sebelumnya (Copy + Keterangan, Copy Gambar Saja, Hapus)
  - [ ] Chip "Semua" → tombol Batch tidak muncul (tidak support batch)
- [ ] **Issue #2 — Tombol tidak ketutupan di sidebar sempit**:
  - [ ] Buka sidebar → kecilkan ke ~350px (w-sm)
  - [ ] Chip "Screenshot" → klik Batch → centang 2 item → tombol di batch bar terlihat semua (tidak ketutupan)
  - [ ] Klik tombol "⋮" item → "Hapus item" → konfirmasi → tombol Batal/Hapus terlihat rapi (tidak terpotong)
  - [ ] Buka catatan editor (klik catatan) → 5 tombol di footer (Hapus, Arsip, Pin, Salin, Selesai) wrap 2 per baris
  - [ ] Kecilkan sidebar ke ~270px (w-xs) → semua tombol tetap terlihat, lebih kompak
  - [ ] Kecilkan sidebar ke ~210px (w-xxs) → tombol super kompak, tetap bisa diklik
  - [ ] Buka "Buat Bundle" sheet → tombol Batal/Buat Bundle terlihat rapi di semua lebar sidebar
  - [ ] Buka "Edit Bundle" sheet → tombol Arsipkan/Batal/Simpan terlihat rapi di semua lebar

---

**Status:** Semua 2 fix selesai ✓ · **Baseline:** v3.11.13 · **Validasi:** node --check (0 error), web-ext lint (0 errors, 106 warnings non-fatal)
