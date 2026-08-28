# CHANGELOG — v3.21.0 (Firefox)

## Ringkasan

Rombak total fitur **Content Guardian** menjadi **Pelindung Konten — Mode Fokus (Allowlist)**.
Filter berganti dari mekanisme *blacklist* 650 keyword negatif (boros CPU, banyak false positive)
menjadi *allowlist* profil topik yang dipilih user. Pencarian di luar topik dikunci otomatis
(Kunci Pencarian), dan halaman watch dapat diblokir total atau diberi peringatan tergantung profil.

## Fitur baru

### 🛡️ Mode Fokus (Allowlist) — §4 instruksi
- **Profil topik dinamis**: 2 profil bawaan (👤 Fokus Belajar + 🧒 Fokus Anak) + bisa
  tambah/hapus. Skema: `contentGuardTopicProfiles = { profiles: [...], activeProfileId }`.
- **Model "satu saklar"**: hanya satu profil ON pada satu waktu (`activeProfileId`).
  Semua OFF → YouTube normal 100% (master tetap boleh ON).
- **Match literal**: video tampil jika judul/channel mengandung topik profil ATAU channel
  ada di whitelist profil. Normalisasi anti-leet (`F3bri3` → `febrie`).
- **Profil kosong** (tidak punya topik maupun channel) → semua tampil + peringatan UI +
  Search Lock nonaktif.

### 🔒 Kunci Pencarian (Search Lock) — §4.6
- Saat Mode Fokus aktif dengan profil punya ≥1 topik, navigasi ke
  `youtube.com/results?search_query=*` atau `x.com/search?q=*` diperiksa.
- Query TIDAK mengandung topik profil → redirect ke `contentguard/searchlock.html`
  (halaman extension, loop-safe).
- Query COCOK → halaman search tampil normal + di-filter allowlist feed.
- Berlaku untuk SEMUA profil (Anak & dewasa).
- Anti-loop: max 1× Search Lock redirect per menit per tab (`lastSearchLockMap`).
- Tanpa bypass — satu-satunya cara membuka kunci: matikan master atau OFF-kan semua profil.

### 🎬 Perilaku halaman watch — §4.5
- **Profil Anak (`strictWatch: true`)** → `youtube.com/watch?v=<non-topik>` redirect ke home.
  Content script baca judul dari DOM, kirim `CG_WATCH_STRICT_REDIRECT` ke background.
  Background guard max 1×/5menit/tab (`lastWatchStrictMap`).
- **Profil Saya (`strictWatch: false`)** → overlay non-blocking W4: "⚠️ DI LUAR TOPIK AKTIF"
  dengan tombol "🏠 Kembali ke beranda" / "▶ Tetap tonton" (pilihan 30 detik).

### ⚡ Optimasi performa — §5
- Cache `normalizeText()` semua topik/channel/keyword SEKALI saat load settings
  (`rebuildCaches()` di `contentguard-cs.js`).
- Satu pass scan dengan deduplikasi node via `Set`; batas 500 node per scan.
- **Throttle ≥1500 ms** (sebelumnya 500 ms); **debounce MutationObserver ≥250 ms**
  (sebelumnya 150 ms).
- **Skip scan saat `document.hidden === true`**.
- Selector X dipangkas: hanya `article[data-testid="tweet"]` + `div[data-testid="tweetText"]`
  + fallback `article`. Hapus `div[data-testid="tweetText"] *`, `[lang]`, `div[dir="auto"]`,
  `span[dir="auto"]` yang boros.
- Selector YouTube didedup (`ytd-rich-item-renderer` tidak lagi muncul 2×).

## Dibongkar (dihapus total)

| Fitur lama | Nasib |
|---|---|
| 650 keyword negatif sebagai inti filter feed | Dibongkar — tetap di-cache untuk filter X saja |
| Redirect home YouTube/X → `takeover.html` | Dihapus dari `checkContentGuard` |
| Blokir query search → search Tiongkok | Diganti Search Lock berbasis profil topik |
| Blokir domain berita Indonesia → `blocked.html` | Dihapus dari `checkContentGuard` |
| Mode Anak lama (`contentGuardKidModeFilter`, whitelist hardcoded) | Diganti Profil Anak editable |
| Redirect `contentGuardYoutubeKidsOnly` → youtubekids.com | Dihapus |
| **Panel mengambang Guardian** (`ensureControlPanel`, `buildToggles`, drag/collapse, dll.) | Dihapus total dari `contentguard-cs.js` |
| Debug overlay (`toggleDebugOverlay`, `#rf-cg-debug`, `escapeHtml` versi lama) | Dihapus |
| Toggle "Nuclear Mode" (`contentGuardNuclearMode`) — tidak pernah berfungsi | Dihapus dari semua UI |
| Toggle `contentGuardFilterFeeds`, `contentGuardScanDescription`, `contentGuardBlockSearchQueries`, `contentGuardStrictMode`, `contentGuardForceRedirect`, `contentGuardBlockIdNews` | Dihapus dari UI (setting tetap disimpan untuk migrasi) |
| Textarea "Kata kunci negatif" (`rf-set-cg-keywords`) & "Domain berita" (`rf-set-cg-domains`) | Dihapus |
| Tombol "Aksi cepat" (FORCE ENABLE ALL, Re-scan, Tes Takeover YT/X, Tes Blocked, Reset) | Dihapus |
| Toggle floating panel (`ksFloatingToggle`) & Nuclear mode (`ksNuclearToggle`) di popup | Dihapus |
| `CG_TOGGLE_DEBUG` message handler | Dihapus (tidak ada pengirim setelah panel dihapus) |

## Dipertahankan

- Master switch `contentGuardEnabled` (master OFF → YouTube normal 100%).
- Blokir Shorts (`contentGuardBlockShorts`) — feed + navigasi `/shorts/`.
- User blocklist manual ("🚫 Blokir Konten Ini" via context menu, `contentGuardUserBlocklist`).
- Blocklist channel YT & akun X (`contentGuardBlockedYtChannels`, `contentGuardBlockedXAccounts`).
- Filter X (keyword/akun blacklist) — refactor performa saja, tetap blacklist.
- Context menu "Blokir Konten Ini" (`browser.menus`, `hoveredElement` + `mouseover` listener
  + `CG_GET_CONTEXT_FOR_BLOCK` handler).
- Guard anti-duplikat inject (`document.documentElement.dataset.rfCgInjected`).
- 3-tier load settings (sendMessage → storage.local → default).
- Hide via CSS `!important` + dataset attribute (flicker fix YouTube recycle DOM).
- `browser.*` native (Promise) — tanpa polyfill.
- Counter internal `hiddenCount`/`panelStats` untuk debug `CG_PING`.

## File yang berubah

| File | Tindakan |
|---|---|
| `lib/contentguard.js` | Fondasi Mode Fokus (pre-existing, sudah ditulis sebelum rombak): `DEFAULT_TOPIC_PROFILES`, `generateProfileId()`, `buildProfileMatchCache()`, `matchesActiveProfile()`, `matchesProfileSearchQuery()`, `getActiveProfile()`, `isProfileFiltering()`, `seedDefaultTopicProfiles()`. Tidak diubah dalam sesi ini. |
| `background.js` | `checkContentGuard` disederhanakan (hapus home→takeover, search→Tiongkok, ID news→blocked; tambah Search Lock + watch strict guard). `initContentGuardDefaults` seed `contentGuardTopicProfiles`. Handler baru: `CG_GET_TOPIC_PROFILES`, `CG_SET_ACTIVE_PROFILE`, `CG_ADD_TOPIC_PROFILE`, `CG_SAVE_TOPIC_PROFILE`, `CG_DELETE_TOPIC_PROFILE`, `CG_WATCH_STRICT_REDIRECT`. `TOGGLE_KID_MODE` jadi thin-shim (set `activeProfileId` ke Profil Anak). |
| `content/contentguard-cs.js` | Rombak total: Mode Fokus Allowlist (`hideYouTubeByFocus`), watch overlay W4, request watch strict redirect, hapus panel mengambang + debug overlay + `hideNonKidContent` + `getYouTubeDescription`. Performa: cache profile + keyword, throttle 1500ms, debounce 250ms, skip `document.hidden`, deduplikasi `Set`, max 500 node/scan. Pertahankan: `hoveredElement` + `mouseover` + `CG_GET_CONTEXT_FOR_BLOCK` + `hiddenCount`/`panelStats` untuk `CG_PING`. |
| `settings/settings.html` | Section Content Guardian → "🛡️ Pelindung Konten — Mode Fokus". Hapus semua toggle/textarea/tombol lama (lihat tabel di atas). Tambah: ① master, ② kartu profil radio, ③ editor profil (nama/emoji/topik/channel/strictWatch), ④ lapisan tambahan (Shorts/Block YT/Block X/Notify/Debug), user blocklist. |
| `settings/settings.js` | Hapus binding toggle/textarea/test button lama. Tambah `renderPelindungKontenProfiles()` + `loadProfileIntoEditor()` + `bindProfileEditorEvents()` (UI editor W1). Toggle binding dikurangi: hanya `rf-set-cg-enabled`, `rf-set-cg-block-yt`, `rf-set-cg-block-x`, `rf-set-cg-block-shorts`, `rf-set-cg-notify`, `rf-set-cg-debug`. |
| `popup/popup.js` | `renderKontrolSitusPage()`: kartu "Mode Anak" ungu → kartu "🛡️ Pelindung Konten" (W2) dengan master toggle + radio profil 1-klik + link "Kelola". Tab "Pengaturan" → editor ringkas W2b (dropdown profil, nama, topik, channel, strictWatch, simpan/hapus/aktifkan/tambah). Hapus binding `ksKidModeToggle`/`ksFloatingToggle`/`ksNuclearToggle`/`ksFilterFeedsToggle`/`ksKidsOnlyToggle`. Perbaiki "Tutup otomatis" (tidak nyalakan setting CG yang dibongkar). `setGuardianFloatingEnabled()` jadi no-op. Rename label "Content Guard aktif" → "Pelindung Konten aktif". |
| `manifest.json` | Version `3.20.51` → `3.21.0`. Tambah `contentguard/searchlock.html`, `.css`, `.js` ke `web_accessible_resources`. |
| `contentguard/searchlock.html` (NEW) | Halaman Kunci Pencarian W3 — header 🔒, banner profil aktif, grid kartu topik, footer. |
| `contentguard/searchlock.css` (NEW) | Gaya mengikuti `takeover.css` (dark gradient, amber accent). |
| `contentguard/searchlock.js` (NEW) | Baca `?platform=youtube|x&profileId=...`, ambil profil via `CG_GET_TOPIC_PROFILES`, render kartu topik, klik → search topik di tab yang sama. |

## File yang TIDAK diubah (semua fitur lain tetap berfungsi 100%)

- `lib/storage.js`, `lib/elementblocker.js`, `content/elementblocker-cs.js`
- `lib/tape.js`, `content/tape-cs.js`, `content/annotate.js`, `content/capture.js`,
  `content/selection-ai.js`, `content/ai-resolvers.js`, `content/volume-*`, `content/sidebar-cs.js`
- `lib/supabase-*.js`, `lib/gdrive-sync.js`, `lib/vault-tree.js`, `lib/habits.js`, `lib/salahtime.js`
- `content/content.js`, `content/overlay.js`, `sidebar/*`
- `popup/popup.html` (tidak ada markup CG — semua di-render JS)

## Kompatibilitas storage

- Key lama (`contentGuardNegativeKeywords`, `contentGuardKidModeFilter`,
  `contentGuardYoutubeKidsOnly`, `contentGuardNuclearMode`, `contentGuardFilterFeeds`,
  `contentGuardScanDescription`, `contentGuardBlockSearchQueries`, `contentGuardForceRedirect`,
  `contentGuardBlockIdNews`, `contentGuardShowFloating`, dll.) tetap dibaca untuk migrasi
  tapi tidak diandalkan kode baru.
- Key baru `contentGuardTopicProfiles` di-seed sekali di `initContentGuardDefaults`
  (jangan menimpa data user).
- `CG_GET_SETTINGS` & `CG_GET_TOPIC_PROFILES` seed default bila belum ada (defensive).

## Catatan risiko & saran testing

### Risiko
1. **DOM YouTube berubah** → selector tidak match. Mitigasi: multi-selector fallback
   (sudah ada) + polling 5 detik.
2. **Redirect loop** (Search Lock / strictWatch). Mitigasi: target redirect = halaman
   extension (di-skip `url.startsWith(browser.runtime.getURL(''))`) + guard
   `lastSearchLockMap` (1×/mnt) & `lastWatchStrictMap` (1×/5mnt).
3. **Topik terlalu pendek** (mis. "anak") → over-blocking. Mitigasi: peringatan UI
   profil kosong, saran pakai channel whitelist, matikan mode = normal.
4. **Migrasi storage merusak data user**. Mitigasi: seed hanya jika key baru belum ada;
   tidak menimpa; backup tetap berjalan.

### Saran testing manual (Firefox 115+)
1. **Muat add-on sementara**: `about:debugging` → "Load Temporary Add-on" → pilih `manifest.json`.
2. **Aktivasi pertama** (Flow A): Settings → Pelindung Konten → toggle master ON → klik kartu
   "👤 Fokus Belajar" → isi topik "python" → Simpan → buka youtube.com → feed terfilter.
3. **Ganti profil dari popup** (Flow B): popup → Kontrol Situs → klik kartu "🧒 Fokus Anak" →
   feed berubah instan tanpa reload.
4. **Search Lock YouTube** (Flow C): search "resep masakan" saat Profil Anak aktif → redirect
   ke `searchlock.html`. Klik kartu "cerita nabi" → hasil search topik tampil. Uji 5× berturut-turut
   (tidak ada loop).
5. **Search Lock X**: search "resep masakan" di x.com → Search Lock. Klik kartu topik → hasil
   search topik tampil.
6. **Watch strict Anak** (Flow D): buka `youtube.com/watch?v=<non-topik>` saat Profil Anak
   aktif → redirect ke home. Uji 3× berturut-turut.
7. **Watch overlay Saya** (Flow E): Profil Saya aktif → buka video non-topik → overlay W4
   muncul → "Tetap tonton" menghilangkan overlay 30 detik.
8. **Shorts**: Mode Fokus aktif → semua Shorts tersembunyi (feed + sidebar + /shorts/ URL).
9. **Master OFF**: YouTube normal 100% (semua video & search bebas); profil terpilih tersimpan.
10. **"Blokir Konten Ini"** (context menu): klik kanan video/tweet → "🚫 Blokir Konten Ini"
    tetap bekerja sebagai lapisan tambahan.
11. **Tambah/hapus profil**: buat "Fokus Kerja" (topik: javascript) → muncul di pilihan;
    aktifkan → feed terfilter topiknya; hapus profil lain (bukan yang aktif) → hilang;
    profil aktif tidak bisa dihapus (ada pesan); minimal 1 profil tersisa.
12. **Panel mengambang**: cek setelah scroll & di watch page — tidak ada elemen floating
    RecallFox yang muncul di halaman YouTube/X.
13. **Rename UI**: tidak ada teks "Content Guard"/"Guardian"/"RecallFox Guardian" yang
    terlihat user di popup & settings.
14. **Regresi fitur lain** (R1–R11 §9.2): buka popup, settings, tes AI, vault, sidebar,
    volume, element blocker, tape, sync, situs non-YouTube/X — semua tetap berfungsi.
15. **`node --check`** semua file JS yang diubah → lolos (sudah diverifikasi).

## Definisi selesai

- ✅ Semua file JS yang diubah lulus `node --check`.
- ✅ Tidak ada file di luar daftar §6 instruksi yang berubah (`git diff --stat 728074b`):
  `background.js`, `content/contentguard-cs.js`, `lib/contentguard.js` (pre-existing),
  `manifest.json`, `popup/popup.js`, `settings/settings.html`, `settings/settings.js` +
  3 file baru `contentguard/searchlock.{html,css,js}`.
- ✅ `manifest.json` version → `3.21.0`.
- ⏳ Test manual di Firefox 115+ (saran di atas) — belum dijalankan otomatis.

## Lihat juga

- Instruksi lengkap: `prompt-agent-rombak-firefox.md` (§0–§11)
- Fondasi Mode Fokus: `lib/contentguard.js` (baris 611+ — `DEFAULT_TOPIC_PROFILES`, helper)
- Skema settings baru: lihat §4.3 instruksi
