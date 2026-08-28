# RecallFox Firefox — v3.20.19 (Relay Point v3.1 — Anchor: jawaban AI terakhir)

> Fix prompt AI: anchor utama sekarang JAWABAN AI terakhir (bukan "3 percakapan
> terakhir" sebagai group). AI harus bandingkan jawaban AI terakhir dengan
> jawaban AI sebelumnya — bukan pertanyaan user.

Tanggal: 2026-08-02
Base: `v3.20.18` (Relay Point v3)

## Ringkasan

User feedback setelah v3.20.18:
> "kayaknya fitur snapshotnya hanya menangkap apa yang saya tanyakan saja ya
> tidak mempertimbangkan jawaban ai di 3 percakapan terakhirnya. maksud saya
> gini, pertanyaan dan terutama dan sangat utama jawaban ai terakhir yang
> diambil oleh snapshot adalah acuan untuk menentukan nyambung atau tidak dua
> percakapan di atasnya atau bahkan lebih."

Investigasi:
- `extractConversation()` di `content/content.js` **sudah benar** menangkap
  jawaban AI (label `🤖 AI:`). Body snapshot memang berisi user question + AI
  answer.
- **Masalah sebenarnya di prompt AI v3.20.18**: prompt bilang "3 percakapan
  terakhir" — AI interpretasikan sebagai group, dan cenderung fokus ke user
  questions (lebih pendek, lebih "punchy"). Jawaban AI (yang panjang dan berisi
  konteks kerja sebenarnya) tidak dijadikan acuan utama.

v3.20.19 fix dengan restructure prompt:
- **ANCHOR = jawaban AI terakhir** (🤖 AI paling bawah), bukan "3 percakapan
  terakhir" sebagai group
- AI harus bandingkan **jawaban AI terakhir** dengan **jawaban AI sebelumnya**
  (bukan pertanyaan user)
- Contoh benar vs contoh salah explicit di prompt

## Perubahan

### 1. background.js — Prompt system baru (anchor = jawaban AI terakhir)

v3.20.18 prompt (masalah):
```
## Langkah 1 — Identifikasi topik utama
Baca 3 percakapan TERAKHIR. Identifikasi topik/sesi kerja utama.

## Langkah 2 — Deteksi rantai relevansi backward
Mulai dari percakapan terakhir, cek ke belakang:
- Apakah percakapan sebelumnya masih nyambung / memperkuat topik yang sama?
```

v3.20.19 prompt (fix):
```
## Langkah 1 — Identifikasi ANCHOR: jawaban AI terakhir
Cari pesan "🤖 AI:" yang PALING BAWAH (paling baru). Itu adalah ANCHOR — status
kerja terakhir yang user mau lanjutkan.

Baca DENGAN TELITI seluruh isi jawaban AI terakhir tersebut. Bukan cuma user
question di atasnya, tapi JAWABAN AI-nya yang menjadi acuan utama. Jawaban AI
berisi: apa yang sudah dikerjakan, kode yang sudah ditulis, solusi yang sudah
diberikan, langkah selanjutnya yang disarankan.

## Langkah 2 — Deteksi rantai relevansi backward dari ANCHOR
Mulai dari jawaban AI terakhir (anchor), cek ke belakang:
- Apakah PERCAKAPAN sebelumnya (user question + AI answer) nyambung / memperkuat
  konteks di jawaban AI terakhir?

PENTING — ACUAN UTAMA ADALAH JAWABAN AI, BUKAN PERTANYAAN USER:
- Pertanyaan user cuma trigger/pemicu — biasanya pendek dan tidak berisi konteks kerja.
- Jawaban AI berisi konteks kerja sebenarnya: kode, solusi, penjelasan, langkah selanjutnya.
- Saat cek "nyambung atau tidak", bandingkan konteks di JAWABAN AI terakhir
  dengan konteks di JAWABAN AI sebelumnya. Jangan bandingkan pertanyaan user saja.

Contoh benar:
- Jawaban AI terakhir: "Untuk testing React, pakai Vitest. Sudah setup di src/test/setup.ts..."
  - Percakapan sebelumnya: user tanya state management, AI jawab "Pakai Zustand,
    sudah install di package.json" → NYAMBUNG (sama-sama React dev)
  - Percakapan sebelum itu: user tanya resep nasi goreng → TIDAK NYAMBUNG → berhenti

Contoh salah (HINDARI):
- ❌ Bandingkan pertanyaan user terakhir ("gimana test React?") dengan pertanyaan
  user sebelumnya ("gimana routing?") → terlihat tidak nyambung padahal sebenarnya
  nyambung (sama-sama React).
- ✅ Bandingkan jawaban AI terakhir dengan jawaban AI sebelumnya → kedua jawaban
  tentang React dev → nyambung.
```

### 2. background.js — Resume context format emphasis

Section "Yang Sudah Dikerjakan" sekarang explicit:
> Ambil dari JAWABAN AI, bukan pertanyaan user.

Section "Konteks Penting" sekarang explicit:
> Include code snippets penting dari JAWABAN AI, nama file, konfigurasi, dll.

### 3. manifest.json — version bump 3.20.18 → 3.20.19

Tidak ada perubahan lain di manifest. Tidak ada shortcut/command baru.

## Yang TIDAK berubah (AMAN)

| File | Status |
|---|---|
| `content/content.js` | UNCHANGED — `extractConversation()` tetap ambil 50 msgs (user + AI) |
| `lib/storage.js` | UNCHANGED |
| `lib/supabase-sync.js` | UNCHANGED — cloud sync aman |
| `popup/popup.js` | UNCHANGED — UI action sheet sama |
| `lib/assistant.js` | UNCHANGED |
| `settings/settings.html` | UNCHANGED |
| `settings/settings.js` | UNCHANGED |
| `manifest.json commands` | UNCHANGED — 4 command, tidak ada shortcut baru |
| `truncateBodyForResume()` | UNCHANGED — logic truncate tetap sama |
| `generateResumeContextSync()` | UNCHANGED — logic kirim body tetap sama |

Hanya **prompt system** yang berubah. Tidak ada code logic yang diubah.

## Kenapa tidak ubah `extractConversation()`?

Investigasi: `extractConversation()` di `content/content.js` SUDAH benar
menangkap jawaban AI:
```js
const roleLabel = item.role === 'user' ? '👤 User' : item.role === 'ai' ? '🤖 AI' : '💬';
body += `${roleLabel}:\n${truncated}\n\n`;
```

Body snapshot format:
```
👤 User:
<pertanyaan user>

🤖 AI:
<jawaban AI lengkap>

👤 User:
<pertanyaan user>
...
```

Jadi data sudah lengkap di body. Masalahnya AI yang salah interpretasi prompt
"fokus ke 3 percakapan terakhir" → AI ambil shortcut dengan fokus ke pertanyaan
user (lebih pendek). v3.20.19 fix dengan explicit: ANCHOR = jawaban AI terakhir.

## Testing checklist

### Test 1: Anchor = jawaban AI terakhir
- [ ] Buka ChatGPT → chat 5+ pesan tentang React project
- [ ] Pastikan jawaban AI terakhir berisi kode/solusi konkret (mis. "Pakai Vitest,
      sudah setup di `src/test/setup.ts`...")
- [ ] Alt+Shift+5 → snapshot → copy resume context
- [ ] Cek: "Yang Sudah Dikerjakan" harus berisi poin dari JAWABAN AI (kode,
      solusi, file), BUKAN dari pertanyaan user

### Test 2: Deteksi nyambung berdasarkan jawaban AI
- [ ] Chat topik A (resep masakan, 2 kali) → ganti topik B (React, 3 kali)
- [ ] Pastikan jawaban AI terakhir tentang React
- [ ] Snapshot → resume context harus HANYA rangkum topik B (React)
- [ ] AI harus detect: jawaban AI topik A (resep) tidak nyambung dengan jawaban
      AI topik B (React) → skip percakapan resep

### Test 3: Pertanyaan user berbeda tapi jawaban AI nyambung
- [ ] Chat: "gimana routing?" → AI jawab React Router
- [ ] Chat: "gimana state?" → AI jawab Zustand
- [ ] Chat: "gimana test?" → AI jawab Vitest
- [ ] Snapshot → resume context harus rangkum ketiganya (sama-sama React dev)
- [ ] AI TIDAK boleh skip karena pertanyaan user berbeda — harus lihat jawaban AI

## Catatan

- **Base version**: `v3.20.18` (Relay Point v3). v3.20.19 refine prompt saja.
- **Tidak ditandai sebagai stable** — sesuai instruksi user.
- **Tidak ada code logic yang diubah** — hanya prompt system. Aman dari
  regression bug.
