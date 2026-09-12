# CHANGELOG v3.24.25 (13 Sep 2026)

## Fitur blockir X (Twitter) DIHAPUS total dari addon

Permintaan user: *"saya ingin kamu cek dan audit fitur di addon terkait blockir x atau twitter. hilangkan saja ya."*

### Hasil audit (sebelum dihapus)
Addon menyentuh x.com/twitter.com di 8 tempat:
1. Content script di-inject ke x.com/twitter.com (manifest content_scripts).
2. **hideXNegative** — sembunyikan tweet di timeline X berdasarkan: ~650 keyword negatif, **~40 akun X diblokir** (@detikcom, @kompascom, dll.), user blocklist, dan URL post X.
3. **Search Lock di X** — pencarian x.com yang di luar topik profil di-redirect ke halaman kunci pencarian.
4. Context menu "🚫 Blokir Konten Ini" + submenu **"🔗 Blokir URL post X ini"** (tipe blocklist `x_post_url` / `account`) di x.com.
5. Toggle settings "Blokir akun X (Twitter) berita Indonesia".
6. Popup "Kontrol Situs": tipe filter "Akun X (handle)", cakupan "Hanya X", tip blokir post X.
7. Data settings X: `contentGuardBlockedXAccounts`, `contentGuardBlockXAccounts`, `contentGuardChinaXAccounts`, `contentGuardChinaXSearches`.
8. Halaman takeover/blocked lama (mesin redirect X/konten Tiongkok) — sudah matang sejak v3.21.0 tapi filenya masih ada.

### Perubahan (dihapus)
- `manifest.json` — x.com/twitter.com dikeluarkan dari matches contentguard-cs.js; file takeover/blocked dikeluarkan dari web_accessible_resources.
- `content/contentguard-cs.js` — selector tweet, `getXTweetText`/`getXTweetAuthor`, `hideXNegative`, cache keyword-X & blocklist-akun, deteksi `isX`, semua cabang `if (isX)` (scan, polling, message handler, context-menu context) dihapus. Addon kini hanya inject di youtube.com.
- `lib/contentguard.js` + `lib/classic/contentguard.classic.js` — `DEFAULT_BLOCKED_X_ACCOUNTS`, `DEFAULT_CHINA_X_ACCOUNTS`, `DEFAULT_CHINA_X_SEARCHES`, `isXHome`, `matchesBlockedXPostUrl`, cabang X di `detectSearchQuery`, tipe `account`/`x_post_url` di `matchesUserBlocklist`, kunci settings X — semuanya dihapus.
- `background.js` — menu konten X (3 blok documentUrlPatterns + menu "Blokir URL post X" + handler-nya), Search Lock khusus X (isXHost), seed default settings X, broadcast ke tab X — dihapus.
- `settings/settings.html` + `settings.js` — baris toggle "Blokir akun X (Twitter)" dihapus; rescan hanya YouTube.
- `popup/popup.js` — tipe filter "Akun X", cakupan "Hanya X", tip URL post X, ikon situs 𝕏, `contentGuardBlockXAccounts` di "Tutup otomatis" — dihapus.
- `contentguard/searchlock.js` — dukungan `platform=x` dihapus (Kunci Pencarian hanya YouTube).
- `lib/storage.js` — support `altValue` khusus x_post_url dihapus.
- **File dihapus**: `contentguard/takeover.{html,css,js}`, `contentguard/blocked.{html,css,js}` (dead code sejak v3.21.0).
- Entri blocklist lama milik user bertipe `account`/`x_post_url` tidak dihapus dari storage — diperlakukan sebagai keyword biasa (tidak crash).

### Tidak berubah
- Seluruh fitur Pelindung Konten **YouTube**: Mode Fokus (allowlist topik), Kunci Pencarian YouTube, Blokir Shorts, blokir channel YT, watch strict/overlay, Element Blocker di semua situs.
- Alur blocklist manual YouTube (klik kanan → Blokir Konten Ini di YouTube tetap berfungsi).

### Verifikasi
- `node --check` / ESM check LOLOS untuk semua file yang diedit (kedua repo).
- Residual scan `twitter|x.com|twimg` di file runtime: 0 sisa (hanya komentar catatan penghapusan).
- Unit test: merge-engine 86/86 PASS, file-kinds 56/56, storage-binary 10/10 (kedua repo). Dua kegagalan lingkungan yang sudah ada sebelumnya (fixture pdfsort §6 tidak ada di workspace; 1 upload live temp-upload kena HTTP 500 dari host) tidak berkaitan dengan perubahan ini.
- Paritas 1:1: contentguard-cs.js, contentguard.js, searchlock.js, popup.js, settings.js, storage.js md5-identik antar repo Firefox & Chrome.
