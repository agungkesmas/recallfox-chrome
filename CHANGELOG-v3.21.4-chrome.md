# RecallFox Chrome — v3.21.4 (FASE 2: Port Bundle Menu + 1-Click Side Panel)

> Port FASE 1 dari Firefox v3.21.4 ke Chrome + fitur khusus Chrome: 1-click
> open side panel dari toolbar icon.

Tanggal: 2026-08-19
Base: `v3.20.51-dev-chrome` (recallfox-chrome)
Paritas dengan: `v3.21.4-firefox` (FASE 1)

## Yang dikerjakan (FASE 2 — Chrome)

### 1. Port `buildBundleMediaReport` ke `lib/copy-format.js`

Salin persis fungsi formatter dari Firefox v3.21.4. Menghasilkan teks Markdown
terstruktur untuk AI Agent:

```markdown
# 📦 Bundle [Nama Bundle]
📅 Tanggal Bundle: [date] | Total Item: N Media

---

### 📷 Media 1: [Judul]
- 🔗 Link Gambar: [cloud URL]
- 📝 Keterangan / Catatan: [annotationNote]
- 🕒 Waktu Tangkap: [timestamp]
- 📍 Lokasi: [GPS coords]

---

— Dihasilkan oleh RecallFox untuk AI Agent —
```

**Null-safety:** Optional chaining (`item?.title || 'Tanpa judul'`), fallback
untuk cloud URL (`gdriveFileUrl || gdrive_file_url || linkUrl ||
source.pages[0].url || source.url`), fallback untuk annotation note
(`annotationNote || source.annotationNote || body.slice(0,200)`).

Helper `stripHtmlForPreview(html)` juga di-port (untuk notes yang body-nya
HTML).

### 2. Port `copyBundleLinkCaption` + opsi menu di `popup/popup.js`

- **Import:** `buildBundleMediaReport` ditambah ke import dari `copy-format.js`
- **Function:** `async function copyBundleLinkCaption(bundleId)` dengan
  `try-catch` (anti-freeze), null-safety, `_copyTextWithFallback` untuk
  clipboard
- **Menu opsi:** Tambah button `data-a="copy-link-caption"` di `itemSheet()`
  untuk `it.type === 'bundle'` — label "📋 Salin Link + Keterangan"
- **Handler:** `else if (k === 'copy-link-caption') { closeSheet();
  copyBundleLinkCaption(it.id); }`

### 3. Fitur khusus Chrome: 1-Click Open Side Panel dari toolbar icon

User request: "untuk versi chrome, jadi ketika icon di-pin di pojok kanan atas,
ketika tombolnya diklik langsung keluar sidebarnya, ga usah repot klik kanan
terus tampilkan sidebar."

**Perubahan:**
- `lib/sidebar-compat.js`: `setupSidebarBehavior()` — ubah
  `openPanelOnActionClick: false` → `openPanelOnActionClick: true`
- `manifest.json`: hapus `"default_popup": "popup/popup.html"` dari objek
  `"action"`

**Hasil:** Klik icon RecallFox yang dipin di toolbar Chrome → langsung buka
Chrome Side Panel (`sidebar/sidebar.html`) — 1-click, tanpa perlu klik kanan
atau pilih menu.

## Anti-freeze protocol (semua dipatuhi)

1. ✅ `async function` — handler pakai `async` dengan `await`
2. ✅ `try { ... } catch (err) { toast }` — seluruh logic dibungkus try-catch
3. ✅ Null-safety — `bundle.find()` bisa return undefined → toast + return
4. ✅ Tidak ganggu `e.stopPropagation()`
5. ✅ Syntax verified — `node --check` PASS (exit 0) untuk semua file

## Regression (tidak ada perubahan)

- Opsi lama "Salin Bundle" (primary action: `injectBundle`/`copyBundle`) tetap
  dipertahankan 100%
- Tidak ada perubahan pada tipe lain (prompt/context/link/screenshot/file/dll)
- Tidak ada perubahan pada Batch Bar, Form Edit, atau CTA pill
- Tidak ada perubahan pada `popup.html`, `popup.css`, sidebar, settings, dll.
- Hanya 4 file berubah: `lib/copy-format.js`, `popup/popup.js`,
  `lib/sidebar-compat.js`, `manifest.json`

## File yang berubah

| File | Perubahan |
|---|---|
| `lib/copy-format.js` | +132 lines (`buildBundleMediaReport` + `stripHtmlForPreview`) |
| `popup/popup.js` | +40 lines (import + `copyBundleLinkCaption` function + menu opsi + handler) |
| `lib/sidebar-compat.js` | 1 line (`openPanelOnActionClick: false` → `true`) |
| `manifest.json` | version bump `3.20.51` → `3.21.4` + hapus `default_popup` |

## Verifikasi

- ✅ `node --check popup/popup.js` PASS
- ✅ `node --check lib/copy-format.js` PASS
- ✅ `node --check lib/sidebar-compat.js` PASS
- ✅ `manifest.json` valid JSON, version `3.21.4`
- ✅ `default_popup` dihapus dari `action`
- ✅ `side_panel.default_path` tetap `sidebar/sidebar.html`
- ✅ `commands` count = 9 (tidak ada shortcut baru)
- ✅ `buildBundleMediaReport` ada (2 refs di copy-format.js, 3 refs di popup.js)
- ✅ `copyBundleLinkCaption` ada (4 refs di popup.js)
- ✅ `copy-link-caption` handler ada (2 refs di popup.js)
- ✅ `openPanelOnActionClick: true` (2 refs di sidebar-compat.js)

## Saran test manual (Chrome)

### Test 1: Bundle Menu "📋 Salin Link + Keterangan"
1. `chrome://extensions` → Load unpacked → pilih folder
2. Buka side panel (klik icon toolbar)
3. Buat bundle dengan beberapa item (screenshot + file + link)
4. Klik tombol `⋯` pada bundle
5. Menu harus muncul dengan opsi baru **"📋 Salin Link + Keterangan"**
6. Klik opsi tersebut → toast "📋 Link + Keterangan tersalin — paste ke AI chat"
7. Paste di AI chat (ChatGPT/Claude/Gemini) → verify format Markdown terstruktur
8. Verify opsi lama "Salin Bundle" / "Sisip" tetap jalan
9. Verify menu untuk tipe lain (prompt/screenshot/file) tidak berubah

### Test 2: 1-Click Side Panel dari toolbar
1. Pin icon RecallFox di toolbar Chrome (klik puzzle piece → pin)
2. Klik icon RecallFox yang dipin
3. **Side Panel langsung terbuka** (sidebar/sidebar.html) — 1 click, tanpa
   perlu klik kanan atau pilih menu
4. Verify side panel berfungsi normal (vault, notes, AI, dll.)

### Test 3: Regression
1. Verify semua fitur lain tetap jalan: capture (Alt+Shift+5), AI chat,
   snapshot, volume booster, content guardian, element blocker, sync cloud
2. Tidak ada error di `chrome://extensions` → Inspect background
3. Tidak ada error di side panel console (F12 saat side panel terbuka)

## Catatan

- **Base**: `v3.20.51-dev-chrome` (recallfox-chrome)
- **Paritas**: `v3.21.4-firefox` (FASE 1 — Bundle Menu)
- **Tidak ditandai sebagai stable** — sesuai instruksi
- **FASE 3 (PWA)**: belum dikerjakan — port `buildBundleMediaReport` ke
  `src/copy-format.js` + tambah opsi di `openItemMenuSheet` (vault.js)
