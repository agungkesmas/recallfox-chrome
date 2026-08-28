# RecallFox Firefox — v3.21.3 (Fix whitelist Mode Fokus bocor)

> Fix 5 bug penyebab Mode Fokus (allowlist) tidak menyempitkan feed YouTube
> untuk profil niche seperti Fokus Anak. Base: v3.21.2-firefox.

Tanggal: 2026-08-14
Base: `v3.21.2-firefox`

## Gejala

User: profil Fokus Anak aktif (topik: cerita nabi, lagu anak, dongeng; channel:
Nussa Official, Cocomelon), tapi feed YouTube tidak menyempit — video di luar
topik tetap tampil.

## Akar penyebab (5 bug)

### Bug 1 (utama): `emptyFeedUntil` jeda 15 detik MELUMPUHKAN filter

v3.21.2 Fix 4 menambah early-return jeda 15 detik saat 0 video cocok per scan
(anti-flicker). Untuk profil niche seperti Fokus Anak, home feed hampir selalu
0 video cocok → jeda 15 detik → semua kartu baru (scroll/infinite scroll)
lolos 15 detik tanpa hide → feed terlihat tanpa filter. "0 match" adalah
kondisi NORMAL untuk profil topik sempit, bukan error.

### Bug 2: `MAX_NODES = 500` terlalu kecil

Node ke-501+ tidak pernah dievaluasi. Di feed panjang (home + shelf Shorts),
kartu di bawah batas 500 tetap tampil.

### Bug 3: `ytd-rich-shelf-renderer` di-match sebagai kartu

Shelf ikut di-match sebagai kartu: judul shelf = judul video PERTAMA di
dalamnya. Kalau video pertama shelf kebetulan cocok topik, seluruh shelf
tampil termasuk video non-topik di dalamnya (dan sebaliknya).

### Bug 4: Cakupan selector hanya 12 hardcoded

Kartu dari renderer layout baru (lockup view model) yang tidak ada di daftar
tidak pernah di-hide. YouTube sedang rollout layout baru — kalau home user
sudah pakai layout itu, mayoritas kartu bocor.

### Bug 5: MutationObserver tidak scan inkremental dari addedNodes

Scan hanya bergantung pada interval 1.5s + debounce 250ms. Kartu baru dari
infinite scroll bisa delay 1.5 detik sebelum di-hide.

## Fix (semua di `content/contentguard-cs.js`; background TIDAK disentuh)

### Fix 1 — Hapus early-return jeda, ganti batch hide bertahap

```js
// HAPUS: if (focusModeActive() && Date.now() < emptyFeedUntil) return;

// Ganti dengan batch hide bertahap:
const MAX_HIDE_PER_SCAN = 40;
let hiddenThisScan = 0;
...
if (userBlk || hideByFocus) {
  if (hiddenThisScan >= MAX_HIDE_PER_SCAN) continue;  // tunda ke scan berikutnya
  ...hide...; hiddenThisScan++;
}
```

Banner "feed kosong" ditampilkan sekali per 60 detik (throttle), bukan setiap
0 match. `emptyFeedUntil` dihapus seluruhnya — hide tetap jalan terus.

### Fix 2 — MutationObserver scan inkremental dari addedNodes

```js
observer = new MutationObserver((muts) => {
  let hasNewCard = false;
  for (const m of muts) {
    for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.querySelector?.('#video-title, #video-title-link')) { hasNewCard = true; break; }
      if (n.matches?.(YT_CARD_ANCESTORS)) { hasNewCard = true; break; }
    }
    if (hasNewCard) break;
  }
  scheduleScan();
});
```

Kartu baru dari infinite scroll langsung trigger scan (debounce 250ms), tidak
menunggu interval 1.5s.

### Fix 3 — Naikkan MAX_NODES 500 → 2000

500 terlalu kecil untuk home + shelf Shorts. 2000 cukup untuk feed panjang.

### Fix 4 — Keluarkan `ytd-rich-shelf-renderer` dari `YT_VIDEO_SELECTORS`

Shelf harus mengikuti nasib anak-anaknya (`hideEmptyShelves`), bukan di-match
sebagai kartu. Sebelumnya: kalau video pertama di shelf kebetulan cocok topik,
seluruh shelf (termasuk video non-topik) tampil → kebocoran.

### Fix 5 — Safety net layout-agnostic (enumerate dari judul)

```js
const YT_CARD_ANCESTORS = 'ytd-rich-item-renderer, ytd-video-renderer, ...';

for (const titleEl of document.querySelectorAll('#video-title, #video-title-link')) {
  const card = titleEl.closest(YT_CARD_ANCESTORS);
  if (card) { allNodes.add(card); continue; }
  // Layout tak dikenal: naik max 8 level, ambil leluhur pertama yang
  // terlihat seperti kartu (punya link video)
  let p = titleEl;
  for (let i = 0; i < 8 && p.parentElement; i++) {
    p = p.parentElement;
    if (p.querySelector('a[href*="/watch"], a[href*="/shorts"], a[href*="/@"]')) {
      allNodes.add(p);
      break;
    }
  }
}
```

Enumerasi dari JUDUL (elemen paling stabil antar layout), lalu naik ke
container kartu. Daftar 12 selector jadi hanya optimalisasi, bukan satu-
satunya jalur. Layout YouTube apa pun setidaknya ter-hide pada level
kartu/judul.

## File yang berubah

| File | Perubahan |
|---|---|
| `content/contentguard-cs.js` | Fix 1-5 (semua di file ini) |
| `manifest.json` | version bump 3.21.2 → 3.21.3 |

## File yang TIDAK berubah

Semua file lain (background.js, lib/contentguard.js, settings, popup, searchlock,
lib/storage.js, content/elementblocker-cs.js, dll.) — TIDAK disentuh. Scope
perubahan hanya di `content/contentguard-cs.js` sesuai instruksi.

## Cara verifikasi (manual, Firefox 115+)

1. Aktifkan 🧒 Fokus Anak → buka YouTube home → **semua video di luar
   topik/channel whitelist harus hilang** (feed boleh jadi hampir kosong —
   itu PERILAKU BENAR untuk profil sempit, bukan bug).
2. Scroll berulang → konten baru yang tidak cocok ikut hilang dalam ≤2 detik,
   **tanpa banner yang muncul terus-menerus** dan tanpa reload.
3. Uji profil dengan topik umum (mis. "berita") → feed menyempit parsial,
   tidak ada flicker/reload (regression test fix v3.21.2).
4. Console: `[data-rf-cg-hidden]` bertambah saat scroll; tidak ada error.
5. Biarkan 5 menit → tidak ada siklus hide-tampil 15 detik.

### One-liner diagnostik (Console YouTube home, profil aktif)

```js
console.table({
  kartu_diketahui: document.querySelectorAll('ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-reel-item-renderer').length,
  judul_video:     document.querySelectorAll('#video-title, #video-title-link').length,
  dihide:          document.querySelectorAll('[data-rf-cg-hidden="1"]').length,
  bannerJeda:      !!document.getElementById('rf-cg-empty-banner')
});
```

- `judul_video` ≫ `kartu_diketahui` → layout baru (seharusnya tertangani Fix 5)
- `bannerJeda: true` terus-menerus → seharusnya tidak (banner throttled 60s)
- `dihide` kecil padahal banyak kartu → seharusnya tidak (Fix 1+3+5)

## Catatan

- **Base**: v3.21.2-firefox. v3.21.3 hanya fix whitelist bocor.
- **Tidak ditandai sebagai stable** — sesuai instruksi.
- **Hubungan dengan laporan pendamping** (`AUDIT-v3.21.2-whitelist-tidak-jalan.md`):
  laporan itu (bug un-hide + deferred judgement + handle matching) tetap berlaku
  sebagai pendamping. Begitu Fix 1-5 membuat hide agresif dan benar, bug "video
  whitelist ter-hide permanen" akan makin terasa kalau tidak sekalian diperbaiki.
  Urutan saran: Fix 1+3+4 (stop kebocoran utama) → Fix 5 (cover layout baru) →
  fix dari laporan pertama (un-hide + deferred judgement + handle).
