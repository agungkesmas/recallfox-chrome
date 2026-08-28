# Changelog v3.11.7 — Multi-PC Bidirectional Sync + Multi-Profile

## Fitur Baru Utama

### 🔄 Multi-PC Bidirectional Sync

**Sebelumnya**: RecallFox hanya bisa sync vault items via Firefox Sync (tidak lengkap — catatan, settings, habits, customizations TIDAK ikut). GDrive Sync hanya one-way push (tidak bisa restore ke device baru).

**Sekarang v3.11.7**: Sinkronisasi penuh antar device via Google Spreadsheet (Apps Script).

**Yang tersinkron**:
- ✅ Vault items (prompt, konteks, link, bundle, snapshot, screenshot metadata)
- ✅ Catatan (notes)
- ✅ Settings (lokasi shalat, habits config, prayer method, dll.)
- ✅ Habits log (ngaji + olahraga)
- ✅ Pomodoro state + music playlists
- ✅ Kid-safe sites customizations
- ✅ Tool order + tab order (drag-drop reorder)
- ✅ AI chat history (opsional)

**Yang TIDAK tersinkron** (security):
- ❌ API keys (Groq, Gemini, OpenAI, dll.)
- ❌ Apps Script URL + Token
- ❌ Sync profiles itu sendiri (anti-circular)

### 👥 Multi-Profile Support

- **1 user, multi-PC**: Deploy 1 Apps Script → share URL+Token ke semua PC → semua PC sync ke spreadsheet yang sama
- **Multi-user (istri/teman)**: Setiap user deploy Apps Script sendiri → profile sendiri → data terpisah
- Switch profile dengan 1 klik di Settings → Multi-PC Sync → Kelola Profile

### 🎯 Minimal-Click Setup

**Setup PC pertama** (3 langkah):
1. Settings → Multi-PC Sync → "Kelola Profile" → isi nama + URL + token → "Tambah"
2. Klik "Sync Sekarang" (upload state ke cloud)
3. Selesai

**Setup PC kedua** (3 langkah):
1. Install RecallFox di PC-2
2. Settings → Multi-PC Sync → "Kelola Profile" → isi nama + URL + token sama → "Tambah"
3. Klik "Pull" (download state dari cloud) → semua data ter-restore

**Ongoing sync**:
- Auto-sync (debounced 30s) — aktifkan toggle di Settings
- Manual: 1 klik "Sync Sekarang" (push + pull)

---

## Cara Setup Multi-PC (Panduan Lengkap)

### Langkah 1: Deploy Apps Script (sekali saja)

1. Buka https://script.google.com → New Project
2. Copy-paste isi `appscript/Code.gs` dari repo
3. Set `CONFIG.SPREADSHEET_ID` dan `CONFIG.SCREENSHOT_FOLDER_ID` (ikuti petunjuk di file)
4. Set `CONFIG.AUTH_TOKEN` dengan string random (mis. `openssl rand -hex 16`)
5. Deploy → New deployment → Type: Web app → Execute as: Me → Who has access: Anyone
6. Copy URL deployment (https://script.google.com/macros/s/.../exec)

### Langkah 2: Setup di PC-1

1. Install RecallFox v3.11.7
2. Buka Settings (klik kanan icon RecallFox → Options)
3. Scroll ke section "🔄 Multi-PC Sync (Beta)"
4. Klik "⚙ Kelola Profile"
5. Isi form:
   - **Nama profile**: mis. "Kantor"
   - **URL Apps Script**: paste URL dari Langkah 1
   - **Token**: paste AUTH_TOKEN yang Anda set di Code.gs
6. Klik "🔌 Test Koneksi" — harus muncul "✓ Koneksi OK"
7. Klik "➕ Tambah"
8. Klik "Selesai" untuk tutup modal
9. Klik "🔄 Sync Sekarang" — state Anda sekarang ter-upload ke cloud

### Langkah 3: Setup di PC-2 (sinkronisasi)

1. Install RecallFox v3.11.7 di PC-2
2. Buka Settings → "🔄 Multi-PC Sync (Beta)" → "⚙ Kelola Profile"
3. Isi form dengan **URL + Token yang SAMA** dengan PC-1:
   - **Nama profile**: mis. "Rumah" (nama bebas, untuk identifikasi)
   - **URL Apps Script**: sama dengan PC-1
   - **Token**: sama dengan PC-1
4. Klik "➕ Tambah"
5. Klik "📥 Pull" — download state dari cloud ke PC-2
6. Selesai! Semua prompt, catatan, settings, habits sekarang sama di kedua PC

### Langkah 4: Aktifkan Auto-Sync (opsional)

1. Di Settings → "🔄 Multi-PC Sync" → enable toggle "Auto-sync (debounced 30s)"
2. Setiap kali Anda mengubah vault (tambah/edit/hapus item), RecallFox otomatis push ke cloud dalam 30 detik
3. Di PC lain, klik "Pull" atau "Sync Sekarang" untuk ambil perubahan terbaru

---

## Cara Setup Multi-User (Istri/Teman)

### Skenario: Anda dan istri punya vault masing-masing

1. **Anda**: Deploy Apps Script sendiri (URL-A + Token-A) → profile "Anda"
2. **Istri**: Deploy Apps Script sendiri (URL-B + Token-B) → profile "Istri"
3. Data Anda dan istri **terpisah** — masing-masing punya spreadsheet sendiri

### Skenario: Share vault dengan teman

1. **Anda**: Deploy Apps Script → profile "Anda" → Sync Sekarang
2. **Teman**: Install RecallFox → tambah profile dengan URL+Token Anda → Pull
3. Teman sekarang punya copy vault Anda (read-only mode — kalau teman edit, last-write-wins akan overwrite)

> **Catatan**: Untuk kolaborasi real-time (both read+write), gunakan profile yang sama di kedua device. Tapi hati-hati: konflik bisa terjadi kalau kedua device edit item yang sama bersamaan. Last-write-wins by `updatedAt` timestamp akan menang.

---

## File yang Diubah (v3.11.7)

| File | Jenis | Ringkasan |
|---|---|---|
| `manifest.json` | Modify | Bump 3.11.6 → 3.11.7 |
| `lib/sync-profile.js` | **NEW** | Modul multi-PC sync: profile management, buildSyncPayload, pushStateToCloud, pullStateFromCloud, mergeRemoteState, fullSync, auto-sync scheduler, testProfileConnection (~400 baris) |
| `lib/storage.js` | Modify | Tambah `syncAutoEnabled: false` setting |
| `appscript/Code.gs` | Modify | Tambah `_handleSyncState()` + `_handleGetState()` + handler doGet untuk `get_state` + sheet "SyncState" auto-create |
| `background.js` | Modify | Tambah 9 message handlers: SYNC_GET_PROFILES, SYNC_ADD_PROFILE, SYNC_UPDATE_PROFILE, SYNC_DELETE_PROFILE, SYNC_SET_ACTIVE, SYNC_PUSH, SYNC_PULL, SYNC_FULL, SYNC_TEST_PROFILE, SYNC_STATUS. Auto-sync trigger di TRIGGER_SYNC |
| `settings/settings.html` | Modify | Tambah section "🔄 Multi-PC Sync (Beta)" + modal "Kelola Sync Profile" |
| `settings/settings.css` | Modify | Tambah CSS untuk `.rf-modal-overlay`, `.rf-modal`, `.sync-profile-row`, dll. |
| `settings/settings.js` | Modify | Tambah initMultiPCSync(), refreshSyncStatus(), doSyncAction(), openSyncProfileManager(), renderSyncProfileList(), addProfileFromForm(), testProfileFromForm() |
| `README.md` | Modify | Bump version 3.10.2 → 3.11.7 |
| `CHANGELOG-v3.11.7.md` | **NEW** | File ini |

---

## Testing Checklist

- [ ] Buka Firefox → `about:debugging` → Load Temporary Add-on → pilih `manifest.json`
- [ ] Cek tidak ada error di Browser Console (Ctrl+Shift+J)
- [ ] **Setup profile**: Settings → Multi-PC Sync → Kelola Profile → isi form → Test Koneksi → Tambah
- [ ] **Push**: Klik "Sync Sekarang" → cek toast "✓ Sync lengkap"
- [ ] **Cek spreadsheet**: Buka spreadsheet Google → cek sheet "SyncState" ada → row dengan profile name + payload JSON
- [ ] **Pull**: Klik "Pull" → cek toast "✓ Pull berhasil"
- [ ] **Auto-sync**: Enable toggle → tambah item baru → tunggu 30s → cek Browser Console log "Auto-sync triggered"
- [ ] **Multi-PC**: Install di PC-2 → tambah profile (URL+token sama) → Pull → cek semua data ter-restore
- [ ] **Multi-profile**: Tambah 2nd profile → switch active → cek status berubah

---

**Versi:** 3.11.7 · **Status:** Semua selesai ✓ · **Baseline:** v3.11.6 (remote GitHub)
