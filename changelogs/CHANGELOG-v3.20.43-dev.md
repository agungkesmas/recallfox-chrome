# RecallFox v3.20.43-dev — Batch Mass Actions + Magic Command Multi-Step + Standarisasi Folder

> **DEV RELEASE** — untuk testing. Bukan stable.
>
> **Tanggal:** 2026-08-06
> **Base:** v3.20.42-dev (Firefox) / v3.20.42-dev-chrome (Chrome)
> **Scope:** Batch mode + Magic Command + UI standarisasi. Tidak ada schema change.

## TL;DR

Fix 2 masalah kritikal:

1. **Batch Mode tidak ada "Pindah Folder"** — batch mode hanya punya opsi Copy + Hapus. Sekarang punya 3 opsi baru: Pindah ke Folder, Arsipkan masal, Tambah ke Bundle.

2. **Perintah (Magic Command) tidak bisa multi-step** — hanya bisa 1 perintah sederhana. Sekarang support 2-5 langkah berurutan, mis. "buat folder AI dan pindahkan semua link AI ke folder AI kemudian arsipkan folder Lama".

Plus: standarisasi semua "Grup" → "Folder" di UI.

## Fitur 1: Batch Mass Actions

### Tombol baru di batch bar

| Tombol | Fungsi | Kapan tampil |
|---|---|---|
| 📂 **Pindah ke Folder** | Pindahkan semua item terpilih ke folder tujuan | Saat ada item (bukan bundle) terpilih, tidak di chip Arsip |
| 📦 **Arsipkan** | Arsipkan semua item terpilih | Saat tidak di chip Arsip |
| 📦 **Tambah ke Bundle** | Tambahkan semua item terpilih ke 1+ bundle | Saat ada item (bukan bundle) terpilih, tidak di chip Arsip |

### Cara kerja

- **Pindah ke Folder**: Klik → buka sheet pilih folder (tree view, sama seperti single-item move) → pilih folder → semua item terpilih dipindahkan sekuensial via `moveItemToGroup()`.
- **Arsipkan**: Konfirmasi → set `archived: true` untuk semua item/bundle terpilih via `updateItem()`/`updateBundle()`.
- **Tambah ke Bundle**: Buka sheet pilih bundle (checkbox list) → pilih 1+ bundle → semua item terpilih ditambahkan ke semua bundle terpilih via `reassignToBundle()`.

### Yang TIDAK berubah

- Semua tombol Copy existing tetap (Copy + Keterangan, Copy Gambar, Copy Teks, Copy URL, Copy Bundle, Copy Teks Saja)
- Download Semua tetap
- Unarsip tetap (di chip Arsip)
- Hapus tetap (selalu tampil)
- Batal tetap

## Fitur 2: Magic Command Multi-Step

### Perubahan di `lib/magic-command.js`

**Fungsi baru: `parseMultiStepCommand(items, chatFn, command)`**
- AI sekarang diminta return `{ "steps": [plan1, plan2, ...] }` (array, bahkan kalau cuma 1 step)
- AI bisa mendeteksi multi-step dari connector: "kemudian", "lalu", "setelah itu", ",", ";"
- Maksimal 5 steps (cap untuk safety)
- Setiap step divalidasi independen — step yang invalid di-skip, bukan reject semua
- 2 action baru: `archive-items` (arsipkan item loose tertentu), `delete-items` (hapus item loose tertentu)

**Fungsi baru: `applyMultiStepMagicCommand(items, steps, groupType, refreshFn)`**
- Eksekusi setiap step secara berurutan
- Antar step, refresh vault supaya step 2 bisa lihat folder yang dibuat step 1
- Kalau step adalah "move" tapi folderId tidak ditemukan, coba resolve by folderName (mungkin folder dibuat di step sebelumnya)
- Return `{ ok, results: [...], allOk }` — `allOk` false kalau ada step yang gagal

**Backward compat:**
- `parseMagicCommand()` masih ada — sekarang delegate ke `parseMultiStepCommand()`. Kalau single step, return `{ ok, plan }`. Kalau multi-step, return `{ ok, multiStep: true, steps, plan: steps[0] }`.
- `applyMagicCommand()` tidak berubah — tetap handle single plan.

### Perubahan di `popup/popup.js`

- `executeMagicCommand()` sekarang pakai `parseMultiStepCommand()` → return array of steps
- `showMagicCommandConfirmModal(steps, allItems)` — sekarang accept array of steps. Render setiap step sebagai card terpisah dengan label "Langkah 1 dari 3", "Langkah 2 dari 3", dst.
- Tombol apply: "✓ Jalankan" (single) atau "✓ Jalankan Semua" (multi)
- Toast feedback: "✓ Semua 3 langkah berhasil" atau "⚠ Sebagian langkah gagal: ..."
- 2 contoh perintah multi-step baru ditambahkan di modal

### Contoh perintah multi-step

1. **"Buat folder AI dan pindahkan semua link tentang AI ke folder AI kemudian arsipkan folder Lama"**
   - Step 1: `create-and-move` — buat folder "AI", pindahkan link AI
   - Step 2: `archive-folder` — arsipkan folder "Lama"

2. **"Pindahkan semua screenshot ke folder Media, lalu tambahkan tag favorit"**
   - Step 1: `move` atau `create-and-move` — pindahkan screenshot ke folder "Media"
   - Step 2: `add-tag` — tambahkan tag "favorit" ke screenshot yang sama

3. **"Cari semua link dengan tag penting dan arsipkan"**
   - Step 1: `archive-items` — arsipkan link dengan tag "penting"

4. **"Pindahkan item dengan tag lama ke folder Arsip lalu hapus tag lama"**
   - Step 1: `move` atau `create-and-move` — pindahkan ke folder "Arsip"
   - Step 2: `remove-tag` — hapus tag "lama" dari item yang sama

## Fitur 3: Standarisasi "Grup" → "Folder"

Semua teks UI yang bilang "Grup" sekarang bilang "Folder":

| Sebelum | Sesudah |
|---|---|
| Tombol "📁+ Grup" | Tombol "📁+ Folder" |
| Title "Buat Folder/Grup Baru" | Title "Buat Folder Baru" |
| Toast "📁 Grup dibuat di kategori Prompt" | Toast "📁 Folder dibuat di kategori Prompt" |
| Prompt "Nama grup baru:" | Prompt "Nama folder baru:" |
| Toast "📁 Grup 'X' dibuat" | Toast "📁 Folder 'X' dibuat" |
| Toast "Gagal buat grup" | Toast "Gagal buat folder" |
| Toast "Dipindahkan ke 'grup'" | Toast "Dipindahkan ke 'folder'" |

Catatan: `lib/vault-tree.js` masih punya `createGroup()` function (internal) — tidak diubah karena bukan user-facing. Hanya label UI yang distandarisasi.

## Yang TIDAK berubah (AMAN dari regression)

| File | Status |
|---|---|
| `lib/storage.js` | UNCHANGED |
| `lib/supabase-client.js` | UNCHANGED |
| `lib/supabase-sync.js` | UNCHANGED |
| `lib/assistant.js` | UNCHANGED |
| `lib/vault-tree.js` | UNCHANGED — `createGroup()` tetap nama internal |
| `lib/copy-format.js` | UNCHANGED |
| `background.js` | UNCHANGED |
| `content/*.js` | UNCHANGED |
| `settings/*` | UNCHANGED |
| Schema database | UNCHANGED |
| Semua fitur existing | UNCHANGED — copy, download, unarsip, delete, magic command single-step tetap jalan |

## Files changed

```
popup/popup.html            | +3 batch buttons (Move Folder, Archive, Bundle) + "Grup" → "Folder"
sidebar/sidebar.html        | same as popup.html
popup/popup.js              | +3 batch action functions + multi-step magic command + "Grup" → "Folder"
lib/magic-command.js        | +parseMultiStepCommand + applyMultiStepMagicCommand + archive-items/delete-items actions
manifest.json               | version bump → 3.20.43
CHANGELOG-v3.20.43-dev.md   | new (this file)
```

## Cara Test

### Test 1: Batch Move to Folder
1. Buka vault → klik tombol "☑️ Batch"
2. Pilih 3+ item (klik checkbox)
3. Klik "📂 Pindah ke Folder"
4. Pilih folder tujuan dari sheet
5. Verify: semua item terpilih dipindahkan ke folder tersebut
6. Verify: batch mode otomatis exit setelah selesai

### Test 2: Batch Archive
1. Batch mode → pilih 3+ item
2. Klik "📦 Arsipkan"
3. Konfirmasi dialog
4. Verify: item hilang dari list utama, muncul di chip Arsip

### Test 3: Batch Add to Bundle
1. Pastikan ada minimal 1 bundle + 3+ item
2. Batch mode → pilih 3+ item
3. Klik "📦 Tambah ke Bundle"
4. Pilih 1+ bundle dari checkbox list
5. Verify: semua item terpilih ditambahkan ke bundle terpilih

### Test 4: Magic Command Single-Step (regression)
1. Klik tombol "💬 Perintah"
2. Ketik: "Pindahkan semua link ke folder Link"
3. Verify: confirm modal muncul dengan 1 step
4. Klik "✓ Jalankan"
5. Verify: item dipindahkan

### Test 5: Magic Command Multi-Step
1. Klik tombol "💬 Perintah"
2. Ketik: "Buat folder AI dan pindahkan semua link tentang AI ke folder AI kemudian arsipkan folder Lama"
3. Verify: confirm modal muncul dengan 2 steps ("Langkah 1 dari 2" + "Langkah 2 dari 2")
4. Klik "✓ Jalankan Semua"
5. Verify: step 1 jalan (folder dibuat + item dipindahkan), step 2 jalan (folder Lama di-arsipkan)
6. Toast: "✓ Semua 2 langkah berhasil"

### Test 6: Standarisasi "Folder"
1. Cek tombol di vault toolbar → harus "📁+ Folder" (bukan "Grup")
2. Klik tombol → prompt harus "Nama folder baru:"
3. Buat folder → toast harus "📁 Folder 'X' dibuat"

### Test 7: Regression — fitur lama tetap jalan
1. Prayer strip tetap show countdown
2. Supabase login + sync tetap jalan
3. RecallTape, Volume, Clear Cache tetap jalan
4. Screenshot capture (Alt+Shift+5) tetap jalan
5. Popout sidebar tetap jalan
6. Semua tombol Copy existing tetap muncul di batch mode

## Compatibility

- **Firefox**: tag `v3.20.43-dev` (DEV — belum stable)
- **Chrome**: tag `v3.20.43-dev-chrome` (DEV — belum stable)
- Code 100% identical antara Firefox dan Chrome (4 file copied verbatim).
- Promote ke stable setelah user test semua 7 skenario di atas.

— *Implemented by Super Z on 2026-08-06.*
