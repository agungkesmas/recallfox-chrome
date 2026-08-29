# Changelog — RecallFox v3.22.3-chrome (Fix klik floater + basmi floater berlebih)

> **Base:** v3.22.2-chrome (14a6e08) · **Branch:** main
> **Tanggal:** 2026-08-29

## 🎯 Ringkasan

Versi perbaikan fokus pada **floating buttons (pill floater)**: klik 1x 🦊 sekarang
langsung buka/tutup **popout DOM sidebar**, floater screenshot duplikat dibasmi,
dan seluruh jalur klik di-hardening supaya tidak ada tombol mati.

## 🐞 Fix 1 — Klik 🦊 1x buka popout DOM sidebar (single-click)

**Root cause (v3.21.26):** single click 🦊 menunggu 250ms lalu me-relay
`RF_OPEN_REAL_SIDEBAR` ke background → `chrome.sidePanel.open({tabId})`.
Dua masalah:
1. `sidePanel.open()` butuh *user gesture* — saat dipanggil dari handler pesan
   background (relay dari content script), Chrome sering menolaknya
   ("may only be called in response to a user gesture").
2. Saat gagal, background `sendResponse({ok:false})` membuat promise
   `sendMessage` **resolve** (bukan reject) → `.catch()` fallback `toggle()`
   di sidebar-cs.js tidak pernah jalan → klik pertama terasa mati.

**Fix:** klik 1x 🦊 = `toggle()` **langsung** di content script — buka/tutup
popout DOM sidebar (in-page iframe) tanpa menyentuh background sama sekali.
Sidebar asli browser tetap bisa dibuka via klik icon toolbar
(`openPanelOnActionClick` tetap aktif). Timer 250ms single/double click dihapus.

## 🧹 Fix 2 — Basmi floating button ke-5 (dock "sc" overlay)

`overlay.js` menyuntik `#recallfox-dock` + `#recallfox-fab` (tombol bulat "sc",
default ON) → di halaman muncul **5** tombol melayang padahal yang benar **4**:
🦊 sidebar/popout · 📸 screenshot · 📝 recallnote · 🧾 recalltape.

**Fix:** `maybeInjectOverlay()` diubah jadi cleanup-only — menghapus sisa dock
lama, tidak pernah menyuntik lagi. Screenshot cukup via 📸 di pill floater /
shortcut Alt+Shift+5/6/7.

## 🧯 Fix 3 — Hardening klik (anti tombol mati)

- **Native click fallback**: semua 4 tombol sekarang punya listener `click`
  sebagai jaring pengaman kalau jalur `pointerup` hilang/retarget.
- **Dedupe 400ms**: aksi terpusat `performAction()` mencegah eksekusi ganda
  (pointerup + click berurutan) sekaligus anti-flicker double-click.
- **note/tape berbasis respons**: kirim `RF_OPEN_NOTE`/`RF_OPEN_TAPE` sebagai
  message primer; fallback `RF_FORWARD_TO_ACTIVE_TAB` + CustomEvent hanya jalan
  kalau respons tidak `ok`.
- **Background**: handler `RF_FORWARD_TO_ACTIVE_TAB` yang terdaftar dobel
  (v3.21.16 + v3.20.10) digabung jadi satu (forward extra fields + inject/retry).

## ⚙️ Settings

Baris setting mati dihapus dari UI: "Tombol mengambang di halaman AI"
(`rf-set-floating`) dan "Tombol overlay screenshot di semua halaman"
(`rf-set-overlay`) — tombol yang dulu dikontrolnya sudah tidak ada, jadi
toggle-nya jadi mati. Blok broadcast `TOGGLE_OVERLAY` di settings.js ikut
dibersihkan. Key storage dibiarkan (tidak berbahaya, tetap tersinkron).

## ✅ Verifikasi

- Audit statis 80/80 PASS (struktur 4 tombol, jalur klik, handler background,
  manifest, parity file antar repo) — `scripts/audit_recallfox.py`.
- Simulasi DOM 14/14 PASS: 1x klik buka popout, klik lagi tutup, double-click
  anti-flicker, 📸/📝/🧾 terkirim, drag ≠ klik, native click fallback jalan —
  `scripts/simulate_floater.js`.

## 📁 File berubah

| File | Perubahan |
|---|---|
| `content/sidebar-cs.js` | Klik 1x 🦊 = toggle popout; performAction + dedupe; native click fallback; openNote/openTape berbasis respons; hapus timer 250ms |
| `content/overlay.js` | maybeInjectOverlay → cleanup-only (dock FAB dibasmi) |
| `background.js` | Gabung handler RF_FORWARD_TO_ACTIVE_TAB dobel (forward fields + inject/retry) |
| `settings/settings.html` | Hapus 2 baris setting mati (rf-set-floating, rf-set-overlay) |
| `settings/settings.js` | Hapus mapping + blok overlayToggle yang mengacu ke row yang dihapus |
| `manifest.json` | 3.22.2 → 3.22.3 |
