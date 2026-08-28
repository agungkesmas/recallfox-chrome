# RecallFox v3.20.20 — HANDOVER REPORT format + Adaptive skip empty sections

**Release date:** 2026-08-02
**Base:** v3.20.19 (Anchor AI Answer)
**Scope:** Prompt system only — tidak ada code logic yang diubah. Aman dari regression bug.

## TL;DR

v3.20.19 sudah benar menetapkan **jawaban AI terakhir** sebagai anchor utama untuk deteksi relevansi. Tapi format output masih 4-section sederhana (Tujuan/Sudah Dikerjakan/Belum Selesai/Konteks Penting).

v3.20.20 mengganti format output menjadi **HANDOVER REPORT** 6-section yang lebih professional dan actionable, plus 2 improvement penting:

1. **Dual anchor** — anchor utama sekarang **jawaban AI terakhir + pertanyaan terakhir yang memicu**. Bukan cuma jawaban AI. Pertanyaan user memberi intent, jawaban AI memberi execution context.
2. **Adaptive skip empty sections** — AI **SKIP** section yang tidak relevan (mis. kalau tidak ada blocker → hilangkan section 5 sepenuhnya). Tidak ada lagi placeholder "Tidak ada" / "N/A" / "None" yang buang token.

## Perubahan

### 1. Format output: HANDOVER REPORT 6-section

**Sebelumnya (v3.20.19):**
```
## 🎯 Tujuan Utama
## ✅ Yang Sudah Dikerjakan
## ⏳ Yang Belum Selesai
## 📌 Konteks Penting
```

**Sekarang (v3.20.20):**
```
# HANDOVER REPORT: [Nama Proyek / Topik Utama]
**Session ID:** [ID Sesi/Akun Asal]
**Date:** [Timestamp snapshot]
**Agent ID:** [Nama AI yang dipakai]

## 1. Executive Summary
## 2. Work Completed                    (checklist format)
## 3. Work In-Progress & Next Steps     (Target / Immediate Task / Dependencies)
## 4. Technical References              (Files Modified + Crucial Context)
## 5. Blockers, Risks, & Known Issues
## 6. Actionable Instruction for New Agent
```

Format ini cocok untuk use case utama Relay Point: **pindah akun AI untuk lanjut coding/dev work**. Agent AI baru langsung dapat context yang terstruktur seperti handover report developer ke developer lain.

### 2. Dual anchor — jawaban AI terakhir + pertanyaan terakhir yang memicu

**Sebelumnya (v3.20.19):**
> "ANCHOR = jawaban AI terakhir (bukan pertanyaan user)"

Ini terlalu ekstrem — pertanyaan user tetap penting sebagai intent/context.

**Sekarang (v3.20.20):**
> "ANCHOR = pasangan terakhir: pertanyaan user terakhir + jawaban AI terakhir.
> Pertanyaan user → intent (apa yang user mau kerjakan).
> Jawaban AI → execution context (apa yang sudah dikerjakan + langkah selanjutnya)."

Percakapan di atasnya tetap dipertimbangkan kalau nyambung dengan anchor (chained relevance backward).

### 3. Adaptive skip empty sections

AI sekarang punya logika explicit di prompt:

> "HANYA INCLUDE SECTION YANG RELEVAN — kalau sebuah section tidak ada isinya (mis. tidak ada blocker, tidak ada file yang dimodifikasi), SKIP section tersebut sepenuhnya. Jangan tulis 'Tidak ada', 'N/A', atau 'None' — cukup hilangkan section-nya."

**Contoh adaptive output:**

Snapshot pendek (cuma 2 Q&A tentang setup Vitest):
```
# HANDOVER REPORT: React Testing Setup
**Date:** 2026-08-02T14:30:00Z
**Agent ID:** ChatGPT

## 1. Executive Summary
User menanyakan cara setup testing React. AI merekomendasikan Vitest dan sudah setup file `src/test/setup.ts`.

## 2. Work Completed
- [ ] Identified Vitest sebagai testing framework yang dipilih
- [ ] Created `src/test/setup.ts` dengan konfigurasi dasar

## 3. Work In-Progress & Next Steps
- **Target:** Run first test suite
- **Immediate Task:** Buat file `App.test.tsx` dengan test case pertama
- **Dependencies:** `@testing-library/react` (perlu install)
```
*(section 4, 5, 6 di-skip karena tidak ada file lain yang dimodifikasi, tidak ada blocker, tidak ada instruksi eksplisit)*

Snapshot lengkap (chat 5+ pesan coding session):
```
# HANDOVER REPORT: E-commerce Cart Refactor
**Session ID:** chat_abc123
**Date:** 2026-08-02T14:30:00Z
**Agent ID:** Claude

## 1. Executive Summary
Refactor cart logic dari class component ke hooks. Selesai: extract `useCart` hook, migrate `Cart.tsx`, update tests. Belum selesai: integrate dengan checkout flow.

## 2. Work Completed
- [ ] Extract cart logic ke `src/hooks/useCart.ts`
- [ ] Migrate `src/components/Cart.tsx` dari class ke function component
- [ ] Update `src/components/Cart.test.tsx` dengan 3 test case baru (all pass)

## 3. Work In-Progress & Next Steps
- **Target:** Integrate useCart dengan checkout flow
- **Immediate Task:** Update `src/pages/Checkout.tsx` untuk pakai `useCart` hook
- **Dependencies:** `useCheckout` hook (sudah ada di `src/hooks/useCheckout.ts`)

## 4. Technical References
- **Files Modified:** `src/hooks/useCart.ts`, `src/components/Cart.tsx`, `src/components/Cart.test.tsx`
- **Crucial Context:** State shape: `{ items: CartItem[], total: number, isOpen: boolean }`. Reducer ada di `useCart.ts` line 45-78. Action types: `ADD_ITEM`, `REMOVE_ITEM`, `CLEAR_CART`.

## 5. Blockers, Risks, & Known Issues
- Test coverage untuk edge case `REMOVE_ITEM` saat cart kosong belum ada — perlu ditambahkan
- `useCart` belum handle race condition kalau 2 item di-add bersamaan

## 6. Actionable Instruction for New Agent
To continue, please open `src/pages/Checkout.tsx` and replace the local state management with `useCart` hook. Import dari `../hooks/useCart`. Hapus `useState` untuk `cart` dan `cartTotal` — pakai `const { items, total, addItem, removeItem } = useCart()` instead.
```

### 4. WAJIB include nama file kalau AI menyebutnya

Prompt sekarang explicit:
> "WAJIB include nama file di section 'Files Modified' kalau AI di percakapan menyebut nama file (mis. `src/test/setup.ts`, `package.json`, `vite.config.ts`). Jangan skip dengan alasan 'terlalu teknis'."

Sebelumnya AI kadang merangkum terlalu agresif dan skip nama file dengan alasan "terlalu teknis" — padahal nama file adalah info paling penting untuk handover.

## Yang TIDAK berubah (AMAN dari regression)

| File | Status |
|---|---|
| `content/content.js` | UNCHANGED — `extractConversation()` tetap ambil 50 msgs (user + AI) |
| `lib/storage.js` | UNCHANGED |
| `lib/supabase-sync.js` | UNCHANGED — cloud sync aman |
| `popup/popup.js` | UNCHANGED — UI action sheet sama (tombol Copy/Generate Resume Context) |
| `lib/assistant.js` | UNCHANGED |
| `settings/settings.html` | UNCHANGED |
| `settings/settings.js` | UNCHANGED |
| `manifest.json commands` | UNCHANGED — 4 command, tidak ada shortcut baru |
| `truncateBodyForResume()` | UNCHANGED — logic truncate tetap sama (head 2000 + tail 6000) |
| `generateResumeContext()` | UNCHANGED — fire-and-forget logic tetap sama |
| `generateResumeContextSync()` | UNCHANGED — chatWithFallback call tetap sama |
| `CAPTURE_SNAPSHOT` handler | UNCHANGED — auto-trigger logic tetap sama |
| `GENERATE_RESUME_CONTEXT` handler | UNCHANGED — manual trigger logic tetap sama |

**Hanya `RESUME_CONTEXT_SYSTEM_PROMPT` constant yang berubah.** Tidak ada code logic yang diubah.

## Token budget

- **Input**: tetap `RESUME_CONTEXT_MAX_BODY_CHARS = 8000` (truncate body sebelum kirim ke AI)
- **Output**: tetap 800 kata max (sesuai aturan #4 di prompt baru)

800 kata cukup karena AI sekarang **adaptive skip empty sections** — tidak ada pemborosan token untuk placeholder "Tidak ada" / "N/A". Token hanya dipakai untuk section yang benar-benar punya konten.

## Testing checklist

### Test 1: Snapshot panjang (coding session) → full 6 section
- [ ] Buka ChatGPT → chat 5+ pesan tentang refactor coding project
- [ ] Pastikan AI menyebut nama file (mis. `src/components/Cart.tsx`)
- [ ] Alt+Shift+5 → snapshot → copy resume context
- [ ] Verify output format: HANDOVER REPORT + 6 section lengkap
- [ ] Verify "Files Modified" berisi nama file yang AI sebut
- [ ] Verify "Actionable Instruction" berisi instruksi eksplisit (open FILE + implement FUNCTION)

### Test 2: Snapshot pendek → adaptive skip section
- [ ] Chat singkat: "gimana setup Vitest?" → AI jawab setupnya
- [ ] Snapshot → copy resume context
- [ ] Verify output: HANDOVER REPORT + hanya section yang relevan (mis. 1, 2, 3 saja)
- [ ] Verify TIDAK ada "Blockers: N/A" atau "Files Modified: Tidak ada" — section yang kosong dihilangkan

### Test 3: Snapshot terlalu pendek → return null
- [ ] Chat 1 Q&A singkat tanpa konteks kerja: "halo" → "halo juga"
- [ ] Snapshot → verify tombol "Generate Resume Context" tetap muncul (tidak auto-generate)
- [ ] Klik manual → verify toast "Gagal: generate_failed" atau "snapshot_body_too_short"

### Test 4: Dual anchor — pertanyaan user + jawaban AI
- [ ] Chat dengan AI:
  - User: "gimana test React?"
  - AI: "Pakai Vitest, setup di `src/test/setup.ts`"
  - User: "gimana state management?"
  - AI: "Pakai Zustand, install di `package.json`"
- [ ] Snapshot → verify "Executive Summary" mention BOTH intent (testing + state management)
- [ ] Verify "Work Completed" berisi poin dari jawaban AI (Vitest setup + Zustand install), bukan dari pertanyaan user

### Test 5: Chained relevance backward
- [ ] Chat topik A (resep masakan, 2 kali) → ganti topik B (React, 3 kali)
- [ ] Pastikan jawaban AI terakhir tentang React
- [ ] Snapshot → verify HANDOVER REPORT hanya rangkum topik B (React), TIDAK include topik A

## Files changed

```
background.js              | RESUME_CONTEXT_SYSTEM_PROMPT constant (3.5KB → 5.1KB)
manifest.json              | version bump 3.20.19 → 3.20.20
CHANGELOG-v3.20.20.md      | new (this file)
```

## Compatibility

- **Firefox**: tag `v3.20.20` + `v3.20.20-stable`
- **Chrome**: tag `v3.20.20-chrome` + `v3.20.20-chrome-stable`
- Code 100% identical antara Firefox dan Chrome untuk fitur Relay Point (prompt + handlers + UI).
- Tidak ada perubahan schema database. Resume context tetap disimpan di `vault_items.resumeContext` (lokal saja, tidak sync cloud).

— *Implemented by Super Z on 2026-08-02, sesuai instruksi user untuk format HANDOVER REPORT + adaptive skip empty sections.*
