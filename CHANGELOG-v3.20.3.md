# RecallFox Chrome — v3.20.3 (Stable)

> Parity release dengan Firefox addon v3.20.1 — port fitur screenshot capture modal filename input + auto-select rename modal ke Chrome MV3.

Tanggal: 2026-07-30

## Ringkasan

Chrome v3.20.2 (tag stabil sebelumnya) ketinggalan fitur v3.20.1 yang sudah ada di Firefox addon. Rilis ini menutup gap itu: semua perbaikan screenshot & rename modal dari Firefox v3.20.1 sekarang jalan di Chrome, plus satu latent bug Firefox (variabel `existing` tidak terdefinisi di scope `openEditorSheet`) ikut diperbaiki supaya fitur auto-select benar-benar berfungsi.

## Perubahan

### 1. Screenshot capture modal — input nama file (PORT dari Firefox v3.20.1)

**File**: `content/overlay.js`

- Tambah input `#rf-capture-modal-filename` di bagian atas modal preview screenshot. Nilai default di-pre-fill dari `pageTitle + timestamp` (sama seperti pola filename lama), supaya user bisa langsung ketik untuk menimpa.
- Auto-focus + select-all nama file saat modal dibuka (delay 80ms supaya animasi modal selesai). User instruction: _"nama file ketika di pencet itu dalam kondisi terblok, sehingga bisa langsung di rename/ ditimpa untuk diberi nama baru."_
- Re-select on focus (kalau user klik keluar lalu klik balik ke input, text di-select lagi otomatis).
- Enter pada input filename = trigger tombol **Simpan PNG** (paling umum dipakai).
- Filename hasil input user dipakai untuk save PDF / JPG / PNG (sebelumnya selalu pakai `pageTitle_timestamp`).
- Filename hasil input user juga dikirim sebagai `title` vault item (lebih meaningful daripada `"pageTitle — modeLabel"`).
- Fallback ke pattern lama kalau modal sudah ditutup / input tidak ditemukan (mis. action dipanggil dari jalur lain).
- Tambah 2 helper: `escapeHtmlAttr(s)` (escape single + double quote untuk attribute value) dan `sanitizeFileName(s)` (buang karakter ilegal `\ / : * ? " < > |` + control chars → underscore, trim, max 120 char, fallback `'screenshot'`).

### 2. Background script — finalTitle logic (PORT dari Firefox v3.20.1)

**File**: `background.js`

- `saveCaptureToVault(payload)` sekarang membaca `payload.title` (opsional, dikirim dari overlay.js capture modal). Kalau ada → dipakai sebagai title vault item (max 120 char). Kalau tidak ada → fallback ke pattern lama `${pageTitle} — ${modeLabel}`.
- Update comment payload spec supaya mendokumentasikan field baru `title?` dan `annotationNote?`.

### 3. Snapshot modal — auto-select title (PORT dari Firefox v3.20.1)

**File**: `content/content.js`

- Pada snapshot modal (snapshot text selection yang di-trigger dari konteks menu / shortcut), input `#rf-snap-title` sekarang di-`focus()` + `select()` saat modal muncul, supaya user bisa langsung ketik untuk menimpa nama default. Sebelumnya hanya `focus()` tanpa `select()`.

### 4. Vault item rename modal — auto-select title (PORT dari Firefox v3.20.1 + BUG FIX)

**File**: `popup/popup.js`

- Pada `openEditorSheet(id)` (modal edit vault item), input `#fTitle` sekarang di-`focus()` + `select()` **hanya kalau lagi edit existing item** (`if (it) t.select()`), bukan saat create new (karena input-nya kosong, select-all tidak ada efeknya).
- **Bug fix**: Firefox v3.20.1 pakai variabel `existing` di scope `openEditorSheet`, padahal `existing` tidak terdefinisi di scope itu (yang ada adalah `it`, deklarasi lokal di line 3988). Akibatnya di Firefox, `t.select()` tidak pernah jalan — hanya `t.focus()` yang efektif. Chrome v3.20.3 memakai `it` (in-scope), sehingga fitur auto-select benar-benar berfungsi. **NB**: ini stealth bug fix, bukan regression — Chrome sekarang lebih benar daripada Firefox.

### 5. Settings alert — hapus mention "Firefox" yang irrelevant

**File**: `settings/settings.js`

- Pada catch-block `initSidebarSyncRedirect`, alert text sebelumnya bilang "Buka sidebar RecallFox manual dari toolbar **Firefox**" — tidak akurat untuk Chrome. Sekarang dibikin browser-agnostic: "Buka sidebar RecallFox manual dari toolbar". (Bagian success-path sudah benar sejak v3.20.2, hanya catch-block yang tertinggal.)

## File yang berubah

| File | Perubahan |
|---|---|
| `manifest.json` | version bump 3.20.2 → 3.20.3 |
| `background.js` | + finalTitle logic di `saveCaptureToVault` |
| `content/content.js` | + `.select()` di snapshot modal title |
| `content/overlay.js` | + 6 PORT items (helpers, default filename, input HTML, autofocus+Enter, use filename, send title) |
| `popup/popup.js` | + auto-select rename modal (dengan bug fix `it` vs `existing`) |
| `settings/settings.js` | fix alert text "toolbar Firefox" → "toolbar" |

## Kompatibilitas

- **Chrome MV3**: ✓ (semua perubahan menggunakan API yang sudah ada di Chrome MV3 — `chrome.sidePanel`, `chrome.contextMenus`, `chrome.commands`, dst., di-wrap via `browser-polyfill.min.js` menjadi `browser.*` namespace).
- **Polyfill**: tidak ada perubahan pada `lib/browser-polyfill.min.js` (masih webextension-polyfill standard).
- **Sidebar**: tidak ada perubahan pada `lib/sidebar-compat.js` (masih handle Firefox `sidebarAction` + Chrome `sidePanel`).
- **Shortcut**: tidak ada perubahan pada mekanisme fallback `RF_COMMAND_FALLBACK` (masih 4 commands dengan `suggested_key` + 4 commands via keydown listener di `overlay.js`).
- **Storage / Supabase / Vault**: tidak ada perubahan schema atau API.

## Testing checklist (manual, di Chrome)

- [ ] Load unpacked dari `chrome://extensions` → extension jalan tanpa error di service worker.
- [ ] Buka halaman web apapun → tekan `Alt+Shift+5` (capture-page) → modal screenshot muncul dengan input nama file ter-focus & ter-select semua.
- [ ] Ketik nama baru → tekan Enter → file PNG tersimpan dengan nama yang diketik.
- [ ] Klik tombol "Simpan PDF" / "Simpan JPG" → file tersimpan dengan nama yang diketik + ekstensi sesuai.
- [ ] Klik tombol "Simpan ke Vault" → vault item baru muncul di sidebar dengan title = nama yang diketik (bukan "pageTitle — modeLabel").
- [ ] Tekan `Alt+Shift+6` (capture-area) → drag kotak di halaman → modal muncul dengan input nama file.
- [ ] Tekan `Alt+Shift+7` (capture-visible) → modal muncul dengan input nama file.
- [ ] Buka sidebar → klik item screenshot existing → klik tombol edit → input title ter-focus & ter-select semua (bisa langsung ketik untuk timpa).
- [ ] Buka sidebar → klik tombol "Item baru" → input title ter-focus tapi **tidak** ter-select (karena kosong).
- [ ] Buka settings → tab Sync Cloud → klik tombol buka sidebar → tidak ada kata "Firefox" di alert (kalau gagal).

## Diff vs Firefox addon v3.20.1-stable

Sisa perbedaan Chrome vs Firefox setelah rilis ini (semua intentional Chrome MV3 adaptations, bukan missing feature):

1. `manifest.json`: `contextMenus` (bukan `menus`), `sidePanel` (bukan `sidebar_action`), `_execute_action` (bukan `_execute_sidebar_action`), PNG icons (bukan SVG), 4 commands dengan `suggested_key` + 4 commands tanpa (Chrome MV3 limit).
2. `background.js`: import `browser-polyfill.min.js` + `sidebar-compat.js`, semua `browser.menus.*` → `browser.contextMenus.*`, semua `browser.sidebarAction.*` → `openSidebar/closeSidebar/isSidebarOpen/toggleSidebar`, `RF_COMMAND_FALLBACK` message handler untuk shortcut fallback.
3. `content/overlay.js`: keydown listener fallback untuk Alt+Shift+6/7/0 (karena 4 commands tanpa `suggested_key` tidak dapat shortcut default di Chrome MV3).
4. `settings/settings.js`: import polyfill + `openSidebar`, delegasi sidebar open ke `sidebar-compat.js`.
5. `popup/popup.html`, `popup/viewer.html`, `settings/settings.html`, `sidebar/sidebar.html`: tambah `<script src="../lib/browser-polyfill.min.js">` sebelum module scripts.
6. `popup/popup.js`: bug fix `it` vs `existing` (Chrome benar, Firefox latent bug — akan di-fix di Firefox v3.20.2).
