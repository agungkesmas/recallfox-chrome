# RecallFox Chrome — v3.21.11 (Restorasi Baseline v3.21.6 + Port Fitur Firefox v3.21.11)

> Restorasi baseline stabil Chrome v3.21.6 (navigasi tab Beranda/Catatan/Alat
> 100% responsif) lalu port seluruh pembaruan Firefox v3.21.11 secara aman.
> Zero version gap: manifest Chrome `3.21.11` = manifest Firefox `3.21.11`.

Tanggal: 2026-08-22
Base: `v3.21.6-chrome` (recallfox-chrome — baseline stabil)
Paritas dengan: `v3.21.11-firefox` (recallfox)

## Latar Belakang

Versi Chrome setelah v3.21.6 (`v3.21.7` – `v3.21.14`) terbukti **rusak** di
Chrome asli: tombol navigasi tab macet / white screen. Root cause umum:
`TypeError` saat elemen `null` dipanggil `.addEventListener` dan kegagalan
sintaks module. Restorasi ini membuang versi rusak dan membangun ulang dari
baseline v3.21.6 yang terbukti responsif, dengan port fitur Firefox terbaru.

## Yang dikerjakan

### 1. Penyelarasan Versi Manifest (Zero Version Gap)

- `manifest.json`: `3.21.6` → **`3.21.11`** — sama persis dengan Firefox.

### 2. Navigasi Anti-Freeze (`?.addEventListener`)

Semua binding navigasi tab di `bindEvents()` memakai optional chaining:

```js
$('#tabHome')?.addEventListener('click', () => setView('home'));
$('#tabNotes')?.addEventListener('click', () => setView('notes'));
$('#tabTools')?.addEventListener('click', () => setView('tools'));
```

Jika elemen `null`, tidak pernah melempar `TypeError` yang memacetkan UI.

### 3. `📋 Salin Link + Keterangan` pada Menu `⋯` Bundle

Opsi `data-a="copy-link-caption"` → `copyBundleLinkCaption()` memakai helper
`buildBundleMediaReport` (sudah ada dari v3.21.4) untuk format Markdown
berurutan `Link Cloud Gambar N + Keterangan N`.

### 4. Kandidat Bundle Dokumen & Pembersihan Menu `⋯` Dokumen

- `type = 'document'` sudah masuk kandidat bundle di `saveBundleSheet` &
  `openBundleEditorSheet` (filter chip + TYPE_ORDER).
- Label menu dokumen: `⬇️ Download Dokumen` & `📋 Salin Gambar`.

### 5. System Prompt Resume Context Berbasis ADHD Skill

`RESUME_CONTEXT_SYSTEM_PROMPT` di `background.js` diganti ke versi
**HANDOVER BRIEF** (kombinasi repo GitHub top stars `ayghri/i-have-adhd` &
`wilbeibi/catchup`) — output skimmable, zero fluff, direct action.

### 6. On-Demand Copy Priority (`it.resumeContext`)

- `copyItemBody()`: jika `it.resumeContext` sudah ada → salin Handover Brief.
- `doInject()`: snapshot dengan `resumeContext` → inject Handover Brief.
- Menu snapshot baru: **📋 Salin Handover Brief (AI)** (`copySnapshotAdhd`,
  on-demand via OmniRouter) & **📄 Salin Teks Percakapan (Asli)** (`copySnapshotRaw`).
- Hapus 4 tombol lama: summarize, continue-ai, copy-resume, gen-resume.

### 7. Collapsed Card Google Drive & 1-Click Open SidePanel

- Hintbox "🔗 HUBUNGKAN KE GOOGLE DRIVE" & "🔐 Login Supabase" dibungkus
  `<details>` terlipat default di sidebar.
- `openPanelOnActionClick: true` aktif di `lib/sidebar-compat.js` → klik icon
  toolbar langsung buka Side Panel.

## Verifikasi Sintaks

```bash
cat popup/popup.js | node --input-type=module --check   # OK
cat background.js | node --input-type=module --check     # OK
cat lib/copy-format.js | node --input-type=module --check # OK
cat lib/sidebar-compat.js | node --input-type=module --check # OK
```

Semua lulus. Browser API Chrome (`chrome.sidePanel`, polyfill `browser.*`)
dipertahankan dari baseline v3.21.6.