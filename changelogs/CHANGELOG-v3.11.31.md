# Changelog v3.11.31 — Fix sync hapus tidak konsisten (item muncul lagi)

> **Versi:** 3.11.31
> **Baseline:** v3.11.30 (commit 6d8ca19)
> **Sumber catatan:** Log Troubleshooting — Aplikasi Web & Addon (Sesi terakhir, 1 issue)

---

## 🐛 Fix dari Log Troubleshooting Sesi terakhir

### Issue #1 — Item yang sudah dihapus muncul lagi setelah sync

**User feedback:**
> "harus ada logika device mana duluan yang dipake dan ada perubahan di data / pergerakan data di addon nya maka itu yang dipake sebagai acuan terakhir untuk disingkronkan di seluruh device, jangan mengulang ulang menampilkan yang pernah dihapus. harus ada batasan interaksi perubahan data terakhir yang dipake. terserah caramu gimana, ini kan addon ni bukan web."

**Root cause analysis:**

Skenario bug:
1. Device A hapus item X → `deleteItem()` kirim soft-delete (`deleted_at = NOW()`) ke cloud
2. Device B belum sync pull → masih punya item X di lokal
3. Device B trigger auto-sync **push** → item X di-upsert ke cloud **TANPA `deleted_at`**
4. Upsert ini **menimpa tombstone** cloud → cloud kembali ke state "tidak dihapus"
5. Device A pull → item X muncul lagi (karena `deleted_at` sudah ditimpa jadi NULL)

**3 bug kritis:**

#### Bug A: `pushToSupabase` tidak tahu item mana yang sudah dihapus
Saat push, semua item lokal di-upsert. Tidak ada mekanisme untuk skip item yang sudah dihapus di device lain.

#### Bug B: `fullSync` urutan salah (push dulu, pull kemudian)
```
fullSync() {
  pushToSupabase();  // ← BUG: push dulu, item X di-upsert tanpa deleted_at
  pullFromSupabase(); // ← baru pull, tapi tombstone sudah ditimpa
}
```

#### Bug C: `pullFromSupabase` tidak track item yang sudah dihapus
Saat pull menemukan item dengan `deleted_at`, item dihapus dari lokal — tapi tidak ada tracking. Next push, item bisa muncul lagi kalau ada di cache lokal atau device lain belum sync.

---

## 🔧 Fix: Tombstone + Delete Registry + Last-Write-Wins

### Fix A: Delete registry lokal (`lib/supabase-sync.js`)

Tambah module baru di `lib/supabase-sync.js`:

```javascript
// Storage key: recallfox_supabase_delete_registry
// Format: { items: { id: deletedAtIso }, notes: { id: deletedAtIso } }

const DELETE_REGISTRY_KEY = 'recallfox_supabase_delete_registry';
const DELETE_REGISTRY_MAX_AGE_DAYS = 30;

async function _getDeleteRegistry() { ... }
async function _saveDeleteRegistry(reg) { ... }
export async function addToDeleteRegistry(itemId, deletedAtIso) { ... }
export async function addNoteToDeleteRegistry(noteId, deletedAtIso) { ... }
export async function isInDeleteRegistry(itemId) { ... }
export async function isNoteInDeleteRegistry(noteId) { ... }
async function _cleanupDeleteRegistry() { ... }  // hapus entry >30 hari
```

**Cara kerja:**
- Saat user hapus item → tambah ke delete registry lokal
- Saat pull menemukan tombstone (deleted_at di cloud) → tambah ke delete registry lokal
- Saat push → skip item yang ada di delete registry (jangan timpa tombstone)
- Cleanup otomatis: entry >30 hari dihapus dari registry

### Fix B: `pushToSupabase` skip item di delete registry

```javascript
// v3.11.31: Load delete registry
const deleteReg = await _getDeleteRegistry();
const deletedItemIds = new Set(Object.keys(deleteReg.items));
const deletedNoteIds = new Set(Object.keys(deleteReg.notes));

for (const item of items) {
  // Skip item yang ada di delete registry
  if (deletedItemIds.has(item.id)) {
    skippedDeleted++;
    continue;
  }
  // ... upsert item
}
```

### Fix C: `pullFromSupabase` tambah ke delete registry saat menemukan tombstone

```javascript
for (const row of itemsRes.data) {
  if (row.deleted_at) {
    // Hapus dari lokal
    const idx = localItems.findIndex(i => i.id === row.id);
    if (idx >= 0) localItems.splice(idx, 1);

    // v3.11.31: Tambah ke delete registry lokal
    await addToDeleteRegistry(row.id, row.deleted_at);
    continue;
  }
  // ... normal merge
}
```

### Fix D: `fullSync` urutan diperbaiki — PULL dulu, lalu PUSH

```javascript
// v3.11.31: PULL DULU, lalu PUSH
// Sebelumnya: push dulu → item X di-upsert tanpa deleted_at → menimpa tombstone
// Fix: pull dulu → device tahu item X sudah dihapus → tambah ke delete registry
// → saat push, item X di-skip (tidak menimpa tombstone)
console.log('[RecallFox/Supabase] FullSync: PULL first, then PUSH (v3.11.31 fix)');
const pullRes = await pullFromSupabase();
const pushRes = await pushToSupabase();
```

### Fix E: `deleteItem`/`deleteBundle`/`deleteNote` di `lib/storage.js`

Tambah ke delete registry lokal saat user hapus:

```javascript
// v3.11.31: Tambah ke delete registry (via dynamic import supaya tidak import cycle)
import('./supabase-sync.js').then(mod => {
  if (mod.addToDeleteRegistry) {
    mod.addToDeleteRegistry(id, new Date().toISOString()).catch(() => {});
  }
}).catch(() => {});
```

---

## 📊 Alur sync baru (v3.11.31)

### Skenario: Device A hapus item X, Device B belum sync

```
Device A:
1. User hapus item X
2. deleteItem() →
   - Hapus dari vault lokal
   - addToDeleteRegistry(X) → registry lokal: { items: { X: "2026-07-22T..." } }
   - Kirim SUPABASE_DELETE_ITEM → cloud: vault_items X set deleted_at = NOW()
   - triggerAutoSync() → pushToSupabase()
     - Skip item X (ada di delete registry) → tidak menimpa tombstone

Device B (belum sync):
1. Auto-sync trigger → fullSync()
2. PULL DULU:
   - Fetch vault_items dari cloud
   - Item X punya deleted_at → hapus dari lokal + addToDeleteRegistry(X)
3. PUSH:
   - Item X tidak ada di lokal (sudah dihapus di pull) → tidak di-push
   - Item lain di-push normal
4. Hasil: Device B tidak punya item X, tidak akan push ulang item X
```

### Skenario: Device B edit item Y, Device A juga edit item Y

```
Device A edit Y (updated_at = 10:00)
Device B edit Y (updated_at = 10:05)

Device A fullSync:
1. PULL: fetch Y dari cloud (updated_at = 10:05 di cloud, kalau B sudah push)
   - 10:05 > 10:00 (lokal) → update lokal Y dengan versi B
2. PUSH: push Y lokal (updated_at = 10:05, sama dengan cloud) → no-op

Hasil: Y versi terbaru (B) menang. Last-write-wins by updated_at.
```

---

## 🗄️ Perubahan SQL Schema (v3.11.31)

**Tidak ada perubahan struktur table** (deleted_at + device_id sudah ada dari v3.11.29). Yang ditambahkan:

1. **Index baru** untuk query cepat:
   - `idx_vault_items_deleted_at` — filter `deleted_at IS NOT NULL` (saat pull cek tombstone)
   - `idx_notes_deleted_at` — sama untuk notes
   - `idx_vault_items_updated_at` — query by `updated_at DESC` (last-write-wins comparison)
   - `idx_notes_updated_at` — sama untuk notes

2. **Cleanup function** `cleanup_old_tombstones(days_old INTEGER DEFAULT 30)`:
   - Hapus tombstone >30 hari dari `vault_items` + `notes`
   - Bisa dijalankan manual atau via pg_cron
   - Cara pakai: `SELECT public.cleanup_old_tombstones(30);`

### Cara update SQL:
1. Buka https://supabase.com/dashboard/project/qmwofsfpxjptpyvncylp/sql/new
2. Paste isi `supabase-schema.sql`, klik **Run**
3. Verifikasi:
   ```sql
   SELECT indexname FROM pg_indexes
   WHERE schemaname = 'public' AND tablename IN ('vault_items', 'notes')
   AND (indexname LIKE 'idx_%deleted_at' OR indexname LIKE 'idx_%updated_at');
   -- Expected: 4 index baru

   SELECT proname FROM pg_proc WHERE proname = 'cleanup_old_tombstones';
   -- Expected: cleanup_old_tombstones
   ```

---

## File yang Diubah (v3.11.31)

| File | Jenis | Ringkasan |
|---|---|---|
| `manifest.json` | Modify | Bump 3.11.30 → 3.11.31 |
| `lib/supabase-sync.js` | Modify | Tambah delete registry module (6 fungsi). Fix `pushToSupabase` skip item di registry. Fix `pullFromSupabase` tambah ke registry saat menemukan tombstone. Fix `fullSync` urutan PULL dulu lalu PUSH |
| `lib/storage.js` | Modify | `deleteItem`/`deleteBundle`/`deleteNote` tambah ke delete registry lokal via dynamic import |
| `supabase-schema.sql` | Modify | Tambah 4 index baru + cleanup function `cleanup_old_tombstones()`. Migration script v3.11.31 |
| `README.md` | Modify | Update header ke v3.11.31 + section WAJIB run ulang SQL |
| `CHANGELOG-v3.11.31.md` | **NEW** | File ini |

---

## Testing Checklist

### Issue #1 — Sync hapus tidak konsisten
- [ ] **WAJIB: Run ulang `supabase-schema.sql`** (untuk dapat index + cleanup function)
- [ ] Verifikasi 4 index baru + cleanup function ada
- [ ] Load addon di Firefox di 2 device (atau 2 profile Firefox)
- [ ] Login Supabase di kedua device
- [ ] **Test hapus di device A, sync di device B:**
  - Device A: tambah item "Test hapus" → tunggu auto-sync (5s)
  - Device B: klik Pull → item "Test hapus" muncul di device B
  - Device A: hapus item "Test hapus" → tunggu auto-sync
  - Device B: klik Pull → item "Test hapus" harus HILANG dari device B
  - Device B: tunggu auto-sync push → item "Test hapus" TIDAK boleh muncul lagi di cloud
  - Cek Supabase Table Editor → item "Test hapus" punya `deleted_at` terisi
- [ ] **Test hapus di device B, sync di device A:**
  - Device B: hapus item yang ada → tunggu auto-sync
  - Device A: klik Pull → item harus HILANG dari device A
  - Device A: tunggu auto-sync push → item TIDAK boleh muncul lagi
- [ ] **Test fullSync:**
  - Device A: hapus item X
  - Device B: edit item Y (jangan sync dulu)
  - Device B: klik "Sync Full" → harus PULL dulu (item X hilang), lalu PUSH (item Y ter-upload)
  - Cek cloud: item X punya deleted_at, item Y updated
- [ ] **Cek Browser Console:**
  - Log "[RecallFox/Supabase] Delete registry: X items, Y notes"
  - Log "[RecallFox/Supabase] Skipped N deleted items/notes (in delete registry)"
  - Log "[RecallFox/Supabase] FullSync: PULL first, then PUSH (v3.11.31 fix)"
- [ ] **Test cleanup function:**
  - Run `SELECT public.cleanup_old_tombstones(0);` di Supabase SQL Editor
  - Harus hapus semua tombstone (deleted_at IS NOT NULL)
  - Cek Table Editor → row dengan deleted_at sudah hilang

---

## Architecture: Delete Registry + Tombstone + Last-Write-Wins

```
┌─────────────────────────────────────────────────────────────────────┐
│  Sync Strategy v3.11.31                                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  DELETE (user hapus item):                                          │
│  1. deleteItem() → hapus dari vault lokal                           │
│  2. addToDeleteRegistry(id) → registry lokal: { items: { id: ts } } │
│  3. SUPABASE_DELETE_ITEM → cloud: vault_items.deleted_at = NOW()    │
│  4. triggerAutoSync() → pushToSupabase()                            │
│     - Skip item di delete registry → tidak timpa tombstone          │
│                                                                     │
│  PUSH (upload lokal → cloud):                                       │
│  1. Load delete registry                                            │
│  2. For each item in vault:                                         │
│     - if id in deleteRegistry → SKIP (jangan upsert)                │
│     - else → upsert ke cloud                                        │
│                                                                     │
│  PULL (download cloud → lokal):                                     │
│  1. Fetch vault_items dari cloud (termasuk yang deleted_at)         │
│  2. For each row:                                                   │
│     - if row.deleted_at → hapus dari lokal + addToDeleteRegistry    │
│     - else → merge by updated_at (last-write-wins)                  │
│                                                                     │
│  FULLSYNC (push + pull):                                            │
│  1. PULL DULU (dapat tombstone + perubahan device lain)             │
│  2. PUSH (upload lokal, skip delete registry)                       │
│                                                                     │
│  CLEANUP:                                                           │
│  - Delete registry lokal: entry >30 hari dihapus                    │
│  - Cloud tombstone: SELECT cleanup_old_tombstones(30) manual/cron   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

**Status:** Fix selesai ✓ · **Baseline:** v3.11.30 · **Validasi:** node --check (0 error semua file)
