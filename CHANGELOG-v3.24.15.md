# CHANGELOG v3.24.15 — Chrome

Tanggal: 2026-09-10

## 1. Upload ⏳ Sementara: 100MB → 1GB (batas maksimal litterbox)

Permintaan user: "maksimalkan saja litterbox sampe ke batas maksimal uploadnya."

- Host sementara (litterbox.catbox.moe) menerima s.d. **1GB** per file di sisi server.
- `lib/file-kinds.js`: `MAX_TEMP_UPLOAD_BYTES = 1024*1024*1024` (1GB).
  Database tetap 10MB, teks tetap 2MB.
- `popup/popup.js`: validasi dua lapis + copy UI → "1GB".
- `test/file-kinds.test.mjs`: 56/56 lolos.
- `manifest.json` → 3.24.15.
