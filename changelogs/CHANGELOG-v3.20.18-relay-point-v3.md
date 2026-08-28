# RecallFox Firefox — v3.20.18 (Relay Point v3 — Chained relevance backward + 800 kata)

> Relay Point v3: AI deteksi rantai relevansi backward dari pair terakhir.
> Bisa ambil 3-6 pairs terakhir yang nyambung topik. Word limit 800 kata
> (sebelumnya 300 — user bilang terlalu terbatas).

Tanggal: 2026-08-02
Base: `v3.20.17` (Relay Point v2)

## Ringkasan

User feedback setelah v3.20.17:
1. **"maksimal katanya terlalu terbatas api nya banyak kok"** — 300 kata terlalu sedikit, takut kehilangan konteks.
2. **"utamakan chat terakhir untuk memeriksa chat pertama dan kedua nyambung tidak. jika chat kedua nyambung dengan yang ketiga berarti saling menguatkan untuk bahkan ngambil lebih dari 3 chat di atasnya misalkan masih ada yang nyambung."** — logika backward yang lebih dinamis dari fixed 3 pairs.

v3.20.17 fixed 3 pairs terakhir. v3.20.18 ganti dengan **chained relevance backward**:
- AI baca full snapshot body (50 msgs, truncated ke 8000 char)
- AI mulai dari pair terakhir, cek ke belakang: masih nyambung topik?
- Kalau YA → include, lanjut cek ke belakang
- Kalau TIDAK → berhenti
- Maksimal ambil 6 pairs (12 pesan) — cukup untuk konteks tanpa overload token

Hasil: AI bisa ambil 3, 4, 5, atau 6 pairs terakhir tergantung kontinuitas topik. Lebih adaptif dari v3.20.17 yang fixed 3.

## Perubahan

### 1. background.js — Hapus `extractLastNPairs()`, ganti `truncateBodyForResume()`

v3.20.17 punya helper `extractLastNPairs(body, 3)` yang potong 3 pairs terakhir. v3.20.18 hapus helper itu (tidak dipakai lagi) — ganti dengan `truncateBodyForResume(body)` yang cuma truncate ke 8000 char tanpa potong pairs.

Strategi truncate: **keep head (2000 char pertama) + tail (6000 char terakhir)**, skip middle.
- Head: supaya AI bisa lihat konteks awal untuk deteksi "apakah nyambung dari awal atau tidak"
- Tail: supaya pesan-pesan terakhir (yang paling relevan untuk chained relevance) tetap full
- Middle di-omit dengan marker `[truncated, X chars middle omitted — pesan terakhir tetap full di bawah]`

Kenapa tidak truncate dari awal saja? Karena AI butuh lihat sedikit konteks awal untuk deteksi "percakapan 1 tentang topik A, lalu topik berubah ke B di percakapan 2". Kalau cuma tail, AI tidak bisa tau kapan topik berubah.

### 2. background.js — Prompt system baru (chained relevance backward)

v3.20.17 prompt:
```
Anda akan diberikan 3 percakapan terakhir...
1. Deteksi relevansi antar 3 percakapan.
2. Kalau pertama tidak berkaitan, rangkum 2 terakhir.
3. Kalau semua berkaitan, rangkum ketiganya.
Maksimal 300 kata.
```

v3.20.18 prompt baru:
```
Anda akan diberikan snapshot percakapan user dengan AI (urut dari tertua ke
terbaru, label "👤 User:" dan "🤖 AI:").

## Langkah 1 — Identifikasi topik utama
Baca 3 percakapan TERAKHIR. Identifikasi topik/sesi kerja utama yang sedang
aktif di situ.

## Langkah 2 — Deteksi rantai relevansi backward
Mulai dari percakapan terakhir, cek ke belakang (ke arah pesan lebih lama):
- Apakah percakapan sebelumnya masih nyambung / memperkuat topik yang sama?
- Kalau YA → include, lanjut cek ke belakang lagi.
- Kalau TIDAK → berhenti. Jangan include percakapan itu atau yang lebih lama.

Contoh:
- Percakapan 1-5 semua tentang setup React → ambil semua 5.
- Percakapan 1-2 tentang resep masakan, 3-5 tentang React → ambil 3-5 saja (3 terakhir).
- Percakapan 1 tentang React, 2-5 tentang debugging database → ambil 2-5 saja (4 terakhir).

Maksimal ambil 6 percakapan (12 pesan) untuk hindari overload konteks.

## Langkah 3 — Generate resume context
Dari rantai percakapan yang relevan (hasil langkah 2), buat resume context...

Maksimal 800 kata. Tulis dalam bahasa Indonesia. Lebih baik panjang tapi
lengkap daripada pendek tapi kehilangan konteks.
```

### 3. background.js — `generateResumeContextSync()` pakai `truncateBodyForResume`

Sebelumnya (v3.20.17):
```js
const lastThreePairs = extractLastNPairs(body, 3);
const messages = [
  { role: 'system', content: RESUME_CONTEXT_SYSTEM_PROMPT },
  { role: 'user', content: 'Judul: ' + title + '\n\n3 percakapan terakhir...:\n\n' + lastThreePairs }
];
```

Sekarang (v3.20.18):
```js
const truncatedBody = truncateBodyForResume(body);
const messages = [
  { role: 'system', content: RESUME_CONTEXT_SYSTEM_PROMPT },
  { role: 'user', content: 'Judul: ' + title + '\n\nSnapshot percakapan user dengan AI (urut dari tertua ke terbaru):\n\n' + truncatedBody }
];
```

### 4. manifest.json — version bump 3.20.17 → 3.20.18

Tidak ada perubahan lain di manifest. Tidak ada shortcut/command baru.
Tidak ada permission baru. Tidak ada host_permission baru.

## Yang TIDAK berubah (AMAN)

| File | Status | Alasan |
|---|---|---|
| `content/content.js` | UNCHANGED | `extractConversation()` tetap ambil 50 msgs untuk snapshot biasa (preview, inject ke AI lain, dll). |
| `lib/storage.js` | UNCHANGED | Field schema sama (resumeContext + resumeContextAt lokal) |
| `lib/supabase-sync.js` | UNCHANGED | Cloud sync tetap pakai schema lama (tidak ada PGRST204) |
| `popup/popup.js` | UNCHANGED | UI action sheet sama (tombol Copy + Generate tetap) |
| `lib/assistant.js` | UNCHANGED | OmniRouter provider tetap jalan |
| `settings/settings.html` | UNCHANGED | |
| `settings/settings.js` | UNCHANGED | |
| `manifest.json commands` | UNCHANGED | 4 command (sidebar + 3 capture), tidak ada shortcut baru |

## Token cost comparison

| Version | Body input ke AI | Word limit output | Estimasi token total |
|---|---|---|---|
| v3.20.16 | 50 msgs (~3000-5000 token) | 300 kata (~400 token) | ~3500-5400 token |
| v3.20.17 | 3 pairs (~800-1500 token) | 300 kata (~400 token) | ~1200-1900 token |
| v3.20.18 | Full body truncated 8000 char (~2000-3000 token) | 800 kata (~1100 token) | ~3100-4100 token |

v3.20.18 lebih mahal dari v3.20.17 (karena kirim full body + word limit 2.6x lipat), tapi user bilang "api nya banyak kok" — tidak masalah. Yang penting konteks lengkap dan tidak kehilangan informasi penting.

## Contoh skenario

### Skenario A: 5 percakapan semua nyambung
```
P1: User minta setup React project → AI jawab (React setup)
P2: User tanya routing → AI jawab (React Router)
P3: User tanya state management → AI jawab (Zustand)
P4: User tanya form validation → AI jawab (react-hook-form)
P5: User tanya testing → AI jawab (Vitest)
```
AI detect: semua tentang React project → ambil semua 5 pairs → generate resume context 800 kata mencakup setup + routing + state + form + testing.

### Skenario B: Topik berubah di tengah
```
P1: User tanya resep nasi goreng → AI jawab (resep)
P2: User ganti topik: "setup React project" → AI jawab (React setup)
P3: User tanya routing → AI jawab (React Router)
P4: User tanya state management → AI jawab (Zustand)
P5: User tanya testing → AI jawab (Vitest)
```
AI detect: P1 (resep) tidak nyambung dengan P2-P5 (React) → ambil 4 pairs terakhir (P2-P5) → generate resume context 800 kata tentang React setup + routing + state + testing.

### Skenario C: Topik berubah 2 kali
```
P1: User tanya resep nasi goreng → AI jawab (resep)
P2: User ganti: "bikin landing page" → AI jawab (Tailwind)
P3: User ganti lagi: "setup React project" → AI jawab (React setup)
P4: User tanya routing → AI jawab (React Router)
P5: User tanya state → AI jawab (Zustand)
```
AI detect: P3-P5 nyambung (React), P2 (landing page) tidak nyambung → ambil 3 pairs terakhir (P3-P5) → resume context fokus ke React setup + routing + state.

## Alur kerja user (tidak berubah dari v3.20.16/v3.20.17)

1. User buka situs AI → tekan Alt+Shift+5 → Snapshot tersimpan instan (50 msgs)
2. Background kirim full body (truncated 8000 char) ke OmniRouter
3. AI deteksi rantai relevansi backward → ambil 3-6 pairs yang nyambung → generate resume context 800 kata
4. Buka snapshot → action sheet → "📋 Copy Resume Context"
5. Paste ke akun AI baru → lanjut kerja dengan konteks lengkap

## File yang berubah

| File | Perubahan |
|---|---|
| `manifest.json` | version bump 3.20.17 → 3.20.18 |
| `background.js` | - hapus `extractLastNPairs()` (90 lines); + `truncateBodyForResume()` (15 lines); + prompt system baru dengan chained relevance backward + word limit 800; update `generateResumeContextSync()` |
| `CHANGELOG-v3.20.18-relay-point-v3.md` | NEW — file ini |

Net: -24 lines (lebih simple karena hapus parser `extractLastNPairs`).

## Testing checklist (manual, di Firefox)

### Setup
- [ ] Load addon dari `about:debugging` → "Load Temporary Add-on" → pilih
      `manifest.json`.
- [ ] Buka Settings → AI Assistant → pilih provider OmniRouter (atau Groq/
      Gemini) → isi API key → Simpan.

### Test 1: 5 pairs semua nyambung
- [ ] Buka ChatGPT → chat 5+ pesan tentang SATU topik (mis. setup React project,
      routing, state, form, testing)
- [ ] Tekan Alt+Shift+5 → snapshot tersimpan
- [ ] Tunggu ~5-10 detik (AI proses full body + generate 800 kata)
- [ ] Buka snapshot → copy resume context → paste di notepad
- [ ] Cek: resume context harus mencakup SEMUA 5 topik (setup + routing + state
      + form + testing), tidak ada yang hilang
- [ ] Word count harus 500-800 kata (bukan 300)

### Test 2: Topik berubah di tengah (chained relevance)
- [ ] Buka ChatGPT → chat 2 kali tentang topik A (mis. resep masakan) → ganti
      topik ke B (mis. React project) → chat 3 kali tentang B
- [ ] Tekan Alt+Shift+5 → snapshot tersimpan
- [ ] Copy resume context → cek: HANYA rangkum topik B (React), TIDAK include
      topik A (resep masakan)
- [ ] AI harus detect bahwa P1-P2 (resep) tidak nyambung dengan P3-P5 (React)

### Test 3: Topik berubah 2 kali (3 pairs terakhir)
- [ ] Chat topik A (2 kali) → topik B (2 kali) → topik C (3 kali)
- [ ] Snapshot → resume context harus HANYA rangkum topik C (3 pairs terakhir)

### Test 4: Graceful degradation
- [ ] Hapus API key OmniRouter → ambil snapshot → tidak ada error
- [ ] Snapshot tersimpan normal, resumeContext = null
- [ ] Klik "🔄 Generate Resume Context" → toast error "Gagal generate"

### Test 5: Snapshot biasa tetap ambil 50 msgs (TIDAK berubah)
- [ ] Buka ChatGPT → chat 10+ pesan
- [ ] Tekan Alt+Shift+5 → preview modal → cek body: harus berisi SEMUA 50 pesan
- [ ] Save snapshot → buka snapshot → body tetap 50 msgs
- [ ] Klik "🔄 Lanjutkan di AI Lain" → snapshot body yang di-copy tetap 50 msgs

### Test 6: Cloud sync tetap jalan (KRITIS)
- [ ] Ambil snapshot → tunggu 10 detik → cek Supabase dashboard → snapshot
      baru muncul di `vault_items` dengan `snapshot_domain` terisi
- [ ] TIDAK ada error PGRST204 di console
- [ ] Snapshot lama (sebelum v3.20.18) tetap muncul, tetap bisa di-open

### Test 7: Word limit 800 kata
- [ ] Ambil snapshot dari chat yang panjang (10+ pesan)
- [ ] Copy resume context → paste di word counter (mis. wordcounter.net)
- [ ] Word count harus 500-800 kata (bukan 300 seperti v3.20.17)

## Catatan

- **Base version**: `v3.20.17` (Relay Point v2). v3.20.18 refine dengan chained
  relevance backward + word limit 800.
- **Tidak ditandai sebagai stable** — sesuai instruksi user, tag `v3.20.18`
  saja (no `-stable` suffix).
- **Net code simpler**: hapus 90 lines `extractLastNPairs`, tambah 15 lines
  `truncateBodyForResume` + 40 lines prompt baru. Total lebih clean.
- **Token cost naik dari v3.20.17** (3100-4100 vs 1200-1900), tapi user bilang
  "api nya banyak kok" — trade-off worth it untuk konteks yang lebih lengkap.
