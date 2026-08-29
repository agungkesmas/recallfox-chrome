# AI-CONTEXT.md — RecallFox Chrome — WAJIB BACA SEBELUM KERJA

> **Aturan #1 Arena:** Di new chat, clone dulu `github.com/agungkesmas/recallfox-chrome` lalu baca file ini. Tanpa ini konteks putus.

## 0. Ritual Sesi (Wajib)

```
Awal sesi: git pull origin <branch> + baca AI-CONTEXT.md + baca docs/ai-memory/RINGKASAN-*.md (di repo Firefox, master)
Akhir sesi: update RINGKASAN + commit + push (atau bundle jika di Arena)
```

Arena tidak punya kredensial push — kerja via bundle. OpenCode lokal bisa push langsung.

## 1. Git Adalah Otak Pusat

Sama dengan repo Firefox: memori di git, bukan workspace. Master memori ada di **repo Firefox** (`docs/ai-memory/`), Chrome mirror `AI-CONTEXT.md` ini untuk parity.

Repo public → clone/read tanpa token, push butuh token.

## 2. Branch & Tag (Chrome)

- `main` — stabil (`500bb2e` v3.21.26-chrome di origin, lokal `feat/upload-all-files` = `v3.22.0`)
- Tag: `v3.22.0-chrome` + `v3.22.0-stable` (di-push 29 Aug 2026 ke `9f89572`)
- `feat/upload-all-files` Chrome = `9f89572` (rebase di atas `500bb2e`, bukan `b6e64bc` lagi)

## 3. Arsitektur v3.22.0 Chrome (Port dari Firefox)

Port Fase 2 dari Firefox `7541df1`:
- `lib/file-kinds.js`, `lib/storage.js` (`rf_file_{id}` blob), `lib/supabase-sync.js` (`_resolveFileBlob`), `popup/*`, `sidebar.html`, `docs/fix-documents-rls.sql` — **identik logika**, beda `manifest.json` + `background.js`
- `manifest.json` Chrome: `version 3.22.0`, `service_worker: background.js type:module`, `permissions: contextMenus+sidePanel`, `icons png` (bukan svg)
- `background.js` Chrome: `import './lib/browser-polyfill.min.js'` + `import {openSidebar} from './lib/sidebar-compat.js'` (baseline bagus `6c90b3c`/`b421ed9`). Jangan overwrite dengan Firefox (`browser.sidebarAction` native).

**Fitur v3.21.26 Chrome (jangan hilang saat rebase):**
`RF_OPEN_REAL_SIDEBAR` — single click rfBtn floater → `chrome.sidePanel.open({tabId})` via `sidebar-compat.js`, double click → `toggle()` popout DOM, timer 250ms, fallback ke popout jika `sidePanel` gagal. `content/sidebar-cs.js` byte-identik Firefox (MD5 `7b9de276`).

## 4. Aturan Chrome Kritis

- Jangan `cp recallfox/* recallfox-chrome/*` mentah
- Chrome butuh adaptasi: manifest (`service_worker`), background polyfill, semua `content_scripts` yang pakai `browser.*` harus sertakan `lib/browser-polyfill.min.js`, icons SVG→PNG
- Sebelum push Chrome cek: `manifest.json` ada `service_worker`, `background.js` import polyfill, semua content_scripts ada polyfill, pill 3 tombol hidup di Chrome

## 5. Batasan Sandbox & Push

Sama dengan Firefox: Arena via bundle (`~/Downloads/recallfox-chrome-*.bundle`), user `git fetch ~/Downloads/recallfox-chrome-v3.22.0.bundle feat/upload-all-files && git push origin feat/upload-all-files v3.22.0-chrome v3.22.0-stable` (sekarang sudah include rebase `500bb2e`, jadi fast-forward).

## 6. Status Terkini (29 Aug 2026)

- Lokal `feat/upload-all-files` = `9f89572` (2 commit `a5ef6b7` + `9f89572` di atas `500bb2e`), sudah push
- `v3.21.25` `b6e64bc` → `v3.21.26` `500bb2e` Floater fix → `v3.22.0` `a5ef6b7/9f89572`
- Firefox master di `8b120cd`, Chrome port byte-identik untuk file-kinds/storage

## 7. Cara Lanjut di New Chat

```bash
git clone https://github.com/agungkesmas/recallfox-chrome.git
cat AI-CONTEXT.md
# Untuk memori lengkap, clone juga recallfox dan baca docs/ai-memory/
```

---
*Last update: 29 Aug 2026 — v3.22.0 chrome rebase 500bb2e. Mirror dari Firefox AI-CONTEXT.*
