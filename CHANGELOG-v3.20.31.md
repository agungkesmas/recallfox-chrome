# RecallFox v3.20.31 — Magic Folder: Ketik Ide Struktur Sendiri (Collapsible)

**Release date:** 2026-08-05
**Tag:** `v3.20.31` (feature enhancement)
**Manifest version bump:** `3.20.30` → `3.20.31`

## TL;DR

User sekarang bisa **ketik ide struktur folder sendiri** di preview modal, lalu klik "🪄 Perbarui Usulan" untuk minta AI ikuti kerangka tersebut. Section ini **default collapse** — tidak mengganggu flow default, tapi bisa dibuka kalau user mau kontrol lebih.

User report:
> "membuat folder nya itu bisa juga dari ngetik apa yang dibayangkan kemudian klik suatu tombol untuk perbarui usulan di preview modalnya. nah ini tapi fitur ngetik ini defaultnya collapse, tapi bisa dibuka jika memang diperlukan."

## Yang diubah

### 1. `lib/vault-tree.js` — `aiAutoGroup` accept `userInstruction` parameter

**New parameter:** `options.userInstruction` (string, max 1000 char)

**Behavior:**
- Kalau `userInstruction` kosong/whitespace → tidak ada perubahan di prompt (backward compat)
- Kalau `userInstruction` terisi → di-inject ke user prompt sebagai "INSTRUKSI EKSPLISIT DARI USER":

```
🔧 INSTRUKSI EKSPLISIT DARI USER (IKUTI INI SEBAGAI KERANGKA UTAMA):
User sudah mengetik ide struktur folder sendiri. WAJIB ikuti instruksi ini sebagai
kerangka utama, tapi tetap baca konteks item untuk:
- Tentukan item mana yang masuk folder mana (sesuai instruksi user)
- Perbaiki nama folder kalau perlu (mis. user ketik "frontend" → AI bisa ubah jadi "Frontend Frameworks")
- Tambahkan subfolder kalau item di satu folder terlalu banyak
- Masukkan item yang tidak disebut user ke folder yang paling cocok, atau ke "Lainnya"

Instruksi user:
"""
{userInstruction}
"""
```

**Regenerate hint updated:** Kalau regenerate > 0 DAN userInstruction ada, hint berubah jadi hormati kerangka user (bukan minta struktur berbeda):
- Tanpa userInstruction: "Coba kriteria BERBEDA, nama BERBEDA"
- Dengan userInstruction: "Variasikan nama/subfolder selama masih sesuai kerangka user"

### 2. `popup/popup.js` — State `_magicFolderUserInstruction`

Track ide yang user ketik. Reset saat:
- Klik tombol "🪄 Auto" dari awal (fresh start)
- Klik "🗑️ Hapus" di section instruksi

### 3. `popup/popup.js` — Collapsible section di preview modal

**`_renderUserInstructionSection()` function:**
- Pakai `<details>` element native (HTML5 collapsible)
- Default: **collapsed** (tidak mengganggu flow default)
- Auto-expand kalau `_magicFolderUserInstruction` sudah ada isinya (mis. setelah klik "Perbarui Usulan")
- Header: "💡 Ketik ide struktur folder sendiri" + chevron ▸/▾
- Body: textarea (4 rows) + tombol "🗑️ Hapus" + "🪄 Perbarui Usulan"
- Badge "📌 Instruksi aktif" muncul di header kalau instruksi aktif

**Placeholder textarea:**
```
Contoh: Bikin folder: Frontend (React, Vue), Backend (Node, Express), Lainnya.
Atau: Kelompokkan berdasarkan workflow — Planning, Development, Testing.
```

### 4. `popup/popup.js` — Wiring "Perbarui Usulan" + "Hapus" buttons

**"🪄 Perbarui Usulan" button:**
- Validasi: minimal 3 karakter
- Set `_magicFolderUserInstruction` dari textarea value
- Reset `_magicFolderRegenerateCount` (proposal baru)
- Re-call `_runMagicFolderProposal()` → progress modal → preview baru

**"🗑️ Hapus" button:**
- Clear `_magicFolderUserInstruction`
- Reset `_magicFolderRegenerateCount`
- Clear textarea
- Re-call proposal (kembali ke AI-only)

### 5. Progress modal update

Saat user instruction aktif, progress modal tampilkan:
> 📌 AI mengikuti instruksi struktur yang kamu ketik

(Regenerate label disembunyikan saat user instruction aktif — tidak relevant)

## UX flow

1. User klik "🪄 Auto" → AI usulkan struktur (default, tanpa user instruction)
2. User buka section "💡 Ketik ide struktur folder sendiri" (collapsed by default)
3. User ketik: "Bikin folder: Frontend (React, Vue), Backend (Node), Lainnya"
4. User klik "🪄 Perbarui Usulan"
5. Progress modal: "📌 AI mengikuti instruksi struktur yang kamu ketik"
6. Preview baru: folder mengikuti kerangka user, nama dipoles AI
7. Section auto-expand + badge "📌 Instruksi aktif"
8. User bisa klik "🔄 Usulan Lain" untuk variasi (tetap hormati kerangka)
9. Atau klik "🗑️ Hapus" untuk kembali ke AI-only

## Test results

6 test scenarios passed:
1. ✅ Empty userInstruction — no instruction block added
2. ✅ userInstruction terisi — injected ke prompt
3. ✅ userInstruction truncated to 1000 char
4. ✅ userInstruction + regenerate — hint hormati kerangka user
5. ✅ Regenerate tanpa userInstruction — hint minta struktur berbeda
6. ✅ Whitespace-only userInstruction — dianggap kosong

## File yang berubah

- `manifest.json` — version bump `3.20.30` → `3.20.31`
- `lib/vault-tree.js` — `aiAutoGroup()` accept `userInstruction` parameter + inject ke prompt + regenerate hint adaptif
- `popup/popup.js` — state `_magicFolderUserInstruction` + `_renderUserInstructionSection()` + wiring "Perbarui Usulan" + "Hapus" buttons + progress modal badge
- `popup/popup.css` — CSS untuk collapsible section (details/summary, textarea, badge, actions)

## Skenario test manual

1. Klik "🪄 Auto" → preview muncul dengan struktur AI
2. Cek: section "💡 Ketik ide struktur folder sendiri" collapsed (chevron ▸)
3. Klik header section → expand (chevron ▾), textarea muncul
4. Ketik: "Bikin folder: Frontend, Backend, Lainnya"
5. Klik "🪄 Perbarui Usulan" → progress modal "📌 AI mengikuti instruksi"
6. Preview baru: folder sesuai kerangka user
7. Cek: section auto-expand + badge "📌 Instruksi aktif"
8. Klik "🔄 Usulan Lain" → variasi tetap hormati kerangka
9. Klik "🗑️ Hapus" → kembali ke AI-only
10. Cek: section collapse lagi (karena instruksi kosong)

## Regression check

- ✅ Backward compat — `aiAutoGroup` tanpa `userInstruction` tetap jalan
- ✅ Strict rollback guardrail tetap ada
- ✅ DOM sync tetap jalan
- ✅ Popout sidebar (iframe) tetap works
- ✅ Default flow tidak terganggu (section collapsed by default)
