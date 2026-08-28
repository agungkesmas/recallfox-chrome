# v3.21.2 — Fix YouTube Home "Reload Terus" saat Pelindung Konten aktif

## Bug
User report: halaman `youtube.com/` (home) reload/muat ulang terus-menerus setelah Pelindung Konten (Mode Fokus) diaktifkan. Terjadi pada semua profil (Fokus Belajar, Fokus Anak, profil baru).

## Root Causes (4 issues)

### 1. Cooldown anti-loop hilang saat event page suspend
- **Sebelumnya**: cooldown anti-loop pakai `Map` in-memory (`lastSearchLockMap`, `lastWatchStrictMap`) di background.js
- **Masalah**: Firefox MV3 event page bisa di-suspend saat idle → semua Map hilang → cooldown reset → redirect beruntun terlihat seperti "reload terus"
- **Fix**: Pindahkan timestamp cooldown ke `browser.storage.session` (Firefox 115+ mendukungnya; volatile per-session — cocok untuk cooldown). Fallback ke `storage.local` jika tidak tersedia. Cache in-memory per event page lifetime supaya tidak baca storage tiap pesan.

### 2. `tabs.update` dengan URL sama = reload
- **Sebelumnya**: handler `CG_WATCH_STRICT_REDIRECT`, `BlockShorts`, `SearchLock` langsung call `browser.tabs.update(tabId, { url: target })` tanpa cek URL saat ini
- **Masalah**: Di Firefox, `tabs.update` dengan URL yang sama persis dengan URL saat ini = **me-reload halaman**. Kalau tab sudah di home → redirect ke home lagi = reload loop.
- **Fix**: Tambah guard `_isAlreadyAtUrl(tabId, targetUrl)` sebelum semua `tabs.update` di jalur CG. Kalau tab sudah di URL target → skip redirect, hanya log.

### 3. Watch detection premature
- **Sebelumnya**: `checkWatchPage` baca `document.title` yang bisa belum berisi judul video (masih "YouTube" / judul lama) saat transisi SPA → video yang sebenarnya cocok dinilai "tidak cocok" → redirect → kembali ke home → loop persepsi "reload"
- **Fix**: WAJIB ada elemen `ytd-watch-metadata h1` dengan teks non-kosong DAN `document.title` bukan placeholder (`'YouTube'`, `''`, atau `- YouTube`) sebelum menilai. Jika belum siap → return (tunggu scan berikutnya), jangan redirect.

### 4. Feed flicker saat 0 video cocok
- **Masalah**: Kalau profil aktif punya topik yang tidak cocok dengan satu pun video di home → `hideYouTubeByFocus` menyembunyikan SEMUA video → YouTube me-render ulang (infinite scroll/reflow) → observer trigger hide lagi → halaman tampak "memuat ulang terus" walau sebenarnya bukan reload
- **Fix**: Jika satu scan penuh menghasilkan 0 video cocok (allowedThisScan === 0) → set jeda 15 detik (`emptyFeedUntil`), tampilkan banner sekali ("⚠️ Tidak ada video yang cocok dengan topik aktif"), dan skip proses hide selama masa jeda. Reset jeda saat: user scroll signifikan (>500px), settings berubah, profil diganti, atau `CG_RESCAN_NOW`.

## Files changed
| File | Fix | Description |
|---|---|---|
| `background.js` | Fix 1, 2 | Cooldown ke `storage.session` + guard URL sama sebelum `tabs.update` di BlockShorts, SearchLock, CG_WATCH_STRICT_REDIRECT |
| `content/contentguard-cs.js` | Fix 3, 4 | Anti-premature watch detection + anti-flicker feed kosong dengan banner |

## Scope
Hanya fitur Pelindung Konten (Content Guardian) yang diubah. Semua fitur lain (Volume booster, AI, Element Blocker, Sidebar, Tape, Capture, Sync, Shalat, dll.) **tidak tersentuh**.
