# CHANGELOG v3.24.26 — FIX "Salin Gambar" KEDOWNLOAD BUKAN KEKOPI + BATCH SALIN LINK + KETERANGAN TANPA BUNDLE

## Laporan user
1. > "cek fitur kopi gambarnya ini kalau di klik malah gambarnya kedownload bukan kekopi"
   (modal "Screenshot diambil" — tombol **Salin Gambar**)
2. > "di versi terbaru baik firefox maupun chrome apakah ada tombol yang tidak sesuai
   fungsinya juga, jika diketemukan kamu perbaiki"
3. > "ketika ada beberapa gambar … jangan dibuat bundle dulu baru bisa dikopi barengan …
   tapi bisa langsung mode batch terus kopi gambar (disertai link gambarnya) dan
   keterangannya langsung"

## FIX 1 — "Salin Gambar" kedownload bukan kekopi (modal screenshot, kedua addon)

**Akar masalah**: seluruh jalur clipboard bergantung pada `navigator.clipboard.write` di
konteks HALAMAN (content script overlay + delegate background yang meng-inject ke halaman).
Jalur itu gagal bersamaan bila: Permissions-Policy halaman melarang clipboard-write,
dokumen tidak fokus, atau transient activation klik sudah kedaluwarsa setelah alur capture.
Semua lapis gagal → fallback terakhir = **DOWNLOAD** — persis yang dialami user
(screenshot: github.com, halaman dengan policy ketat).

**Solusi — ladder 4 lapis (overlay.js, kedua addon):**
1. `navigator.clipboard.write` (async API — kualitas terbaik, jalur lama)
2. **BARU** `execCommand('copy')` dengan **seleksi `<img>`** — sinkron dalam user gesture,
   kebal Permissions-Policy async clipboard; perilaku sama dengan "Copy Image" klik kanan
3. Delegate background — kini **Firefox memakai `browser.clipboard.setImageData()`**
   (API khusus background FF, tanpa gesture, kebal policy halaman) sebagai lapis pertama
   untuk image-only, dan sebagai upaya terakhir sebelum download di semua jalur
4. Download — hanya kalau SEMUA lapis gagal; pesan status kini jujur
   ("Clipboard diblokir halaman ini — …")

**"Salin + Keterangan"** juga dapat lapis baru: `execCommand('copy')` + event `copy`
yang mem-set `text/html` (gambar ter-embed `<img src=dataUrl>`) + `text/plain` secara
sinkron → Google Docs/Gmail/Word menampilkan gambar + keterangan saat paste.

## FIX 2 — Audit tombol tidak sesuai fungsi (kedua addon)

- **Item sheet vault "📋 Salin Gambar"**: sebelumnya memanggil
  `writeScreenshotToClipboard(dataUrl, '', '')` — Blob teks kosong sering DITOLAK
  browser → strategy gagal → jatuh ke **download** (pola bug yang sama dengan yang
  diperbaiki v3.14.8 di viewer, tapi tersisa di sini). Kini pakai
  `writeImageOnlyToClipboard` (helper khusus image-only).
- Label dokumen "Salin Gambar" diperjelas → "Salin Gambar (hal. 1)" (dokumen = halaman
  pertama; sebelumnya ternary mati kedua cabang bertuliskan sama).
- `lib/copy-format.js` (dipakai popup + sidebar): ditambah strategi fallback
  `execCommand` — Strategi 1.5 (rich text/html+plain) di `writeScreenshotToClipboard`
  dan Strategi A2 (image-selection) di `writeImageOnlyToClipboard` — supaya semua
  tombol salin di ekstensi punya jalan pintas sinkron yang sama kuatnya.
- Audit hasil: tombol lain dicek simpan/salin/unduh (Simpan PDF/JPG/PNG, Anotasi,
  Simpan ke Vault, Batal, Download, Copy URL, Copy Teks, Copy Bundle, Arsip, Hapus,
  batch bar lengkap) — wiring label↔handler sesuai.

## FIX 3 — Batch "🔗 Salin Link + Ket." TANPA perlu Bundle (kedua addon)

Tombol batch-bar baru di vault: **🔗 Salin Link + Ket.** — muncul saat ada
screenshot/dokumen terpilih (chip Media atau all). Seleksi langsung → salin
**Link gambar (cloud) + keterangan per item** dalam satu markdown rapi untuk AI Agent:

```
# 📷 Media Terpilih — RecallFox
📅 Tanggal: 30 September 2026 | Total: 3 Media
---
### 📷 Media 1: Laporan RS Harapan Bunda
- 🔗 Link Gambar: https://drive.google.com/uc?id=...
- 📝 Keterangan / Catatan: Bagian tagihan rawat inap
- 🕒 Waktu Tangkap: 30/09/2026 08.59 WIB
---
— Dihasilkan oleh RecallFox untuk AI Agent —
```

Format per-media **identik** dengan "📋 Salin Link + Keterangan" milik Bundle
(kode per-entry diekstrak bersama `_mediaReportEntry` di lib/copy-format.js) —
yang berubah hanya header (bukan bundle). Tidak perlu lagi buat bundle dulu.

## Validasi
- `node --check` semua file tersentuh (overlay.js, background.js, copy-format.js,
  popup.js × 2 addon) — OK
- Uji unit baru `scripts/test_copy_format_32426.mjs` — **19/19 PASS**
  (format laporan, paritas seleksi↔bundle per-media, regresi buildBundleMediaReport
  & buildScreenshotCaption)
