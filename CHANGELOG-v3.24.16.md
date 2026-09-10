# CHANGELOG v3.24.16 — Chrome

Tanggal: 2026-09-10

## Upload ⏳ Sementara gagal `http_500` intermiten — TAMBAH RETRY OTOMATIS (laporan user)

Sama persis dengan Firefox v3.24.16 (modul `lib/temp-upload.js` identik):
penyebab = HTTP 500 transien sisi litterbox + kode hanya 1x percobaan.
Retry maks 3x (network/5xx, backoff 1s/2s/4s); 4xx & respons non-URL tidak di-retry.
Test: 43/43.
