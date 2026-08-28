# RecallFox Firefox — v3.20.17 (Relay Point v2 — 3 percakapan terakhir + deteksi relevansi)

> Relay Point sekarang ambil 3 percakapan terakhir (bukan dari awal), dan AI
> deteksi relevansi antar 3 percakapan — kalau yang pertama tidak berkaitan
> dengan 2 terakhir, hanya rangkum 2 terakhir.

Tanggal: 2026-08-02
Base: `v3.20.16` (Relay Point v1)

## Ringkasan

User feedback setelah v3.20.16: "kurang cocok hasilnya, harusnya snapshot itu
ngambil percakapan dan jawaban maksimal 3 kali dari chat dan jawaban di atasnya,
bukan ngambil dari awal. karena chatnya sudah melebar biasanya kalau dari awal
tu."

v3.20.16 kirim **body snapshot utuh** (50 pesan terakhir) ke OmniRouter untuk
di-resume. Masalahnya:
- 50 pesan terlalu panjang → burn token
- Percakapan awal biasanya sudah melebar dan tidak relevan dengan status kerja
  terakhir
- Resume context jadi campur aduk antara topik awal dan topik akhir

v3.20.17 fix dengan:
1. Ambil **3 pairs (user+AI) terakhir** dari body snapshot, bukan body utuh
2. AI **deteksi relevansi** antar 3 percakapan: kalau yang pertama tidak
   berkaitan dengan 2 terakhir, hanya rangkum 2 terakhir
3. Token cost turun drastis (3 pairs ≈ 1500-3000 char vs 50 msgs ≈ 10000+ char)

## Perubahan

### 1. background.js — Helper baru `extractLastNPairs(body, numPairs)`

Fungsi parser yang ambil N pairs (user+AI) terakhir dari body snapshot.

Body snapshot format (dari `content.js extractConversation`):
```
👤 User:
<text>

🤖 AI:
<text>

👤 User:
<text>
...
```

Pair = 1 user message + 1 AI response. Fungsi ambil N pairs terakhir, urut
dari tertua ke terbaru (supaya AI bisa baca kronologis).

**Edge cases yang dihandle:**
- Body dengan < N pairs → return semua pair yang ada
- Body kosong → return empty string
- Body tidak ter-parse (format aneh, no labels) → fallback return body utuh
  (truncated ke 8000 char kalau perlu)
- User tanpa AI di akhir (incomplete pair) → tetap di-include
- AI tanpa user sebelumnya (orphan) → skip
- Code blocks multi-line → parser handle dengan benar

**Diverifikasi dengan 6 unit test** (`/home/z/my-project/scripts/test-extract-last-n-pairs.js`):
1. 5 pairs → ambil 3 terakhir ✓
2. 2 pairs → ambil semua 2 ✓
3. Empty body → empty string ✓
4. Malformed body → fallback return body utuh ✓
5. Incomplete pair di akhir → tetap di-include ✓
6. Code blocks multi-line → parser handle ✓

### 2. background.js — Prompt system baru (deteksi relevansi)

Prompt lama (v3.20.16):
```
Anda adalah asisten yang merangkum percakapan AI menjadi "resume context"...
Format output: ## 🎯 Tujuan Utama / ## ✅ Yang Sudah Dikerjakan / dst.
```

Prompt baru (v3.20.17):
```
Anda adalah asisten yang merangkum percakapan AI menjadi "resume context"...

Anda akan diberikan 3 percakapan terakhir user dengan AI (dari tertua ke
terbaru). Tugas Anda:

1. **Deteksi relevansi**: Periksa apakah ketiga percakapan ini saling
   berkaitan (satu topik / satu sesi kerja yang berkelanjutan).
2. **Filter kalau perlu**: Kalau percakapan PERTAMA (tertua) tidak berkaitan
   dengan 2 percakapan terakhir, abaikan percakapan pertama dan hanya rangkum
   2 percakapan terakhir. Kalau semua berkaitan, rangkum ketiganya.
3. **Generate resume context** dari percakapan yang relevan dengan format:
   ## 🎯 Tujuan Utama / ## ✅ Yang Sudah Dikerjakan / dst.
```

AI handle deteksi relevansi + filtering + resume dalam 1 prompt (hemat API call
vs 2-step approach).

### 3. background.js — `generateResumeContextSync()` pakai `extractLastNPairs`

Sebelumnya (v3.20.16):
```js
const truncatedBody = body.length > 8000 ? body.slice(0, 8000) + '...' : body;
const messages = [
  { role: 'system', content: RESUME_CONTEXT_SYSTEM_PROMPT },
  { role: 'user', content: 'Judul: ' + title + '\n\nPercakapan AI:\n\n' + truncatedBody }
];
```

Sekarang (v3.20.17):
```js
const lastThreePairs = extractLastNPairs(body, 3);
if (!lastThreePairs) return null;
const messages = [
  { role: 'system', content: RESUME_CONTEXT_SYSTEM_PROMPT },
  { role: 'user', content: 'Judul: ' + title + '\n\n3 percakapan terakhir user dengan AI (dari tertua ke terbaru):\n\n' + lastThreePairs }
];
```

### 4. manifest.json — version bump 3.20.16 → 3.20.17

Tidak ada perubahan lain di manifest. Tidak ada shortcut/command baru.
Tidak ada permission baru. Tidak ada host_permission baru.

## Yang TIDAK berubah (AMAN)

| File | Status | Alasan |
|---|---|---|
| `content/content.js` | UNCHANGED | `extractConversation()` tetap ambil 50 msgs untuk snapshot biasa (preview, inject ke AI lain, dll). Relay Point hanya potong 3 pairs terakhir dari body yang sudah di-save. |
| `lib/storage.js` | UNCHANGED | Field schema sama (resumeContext + resumeContextAt lokal) |
| `lib/supabase-sync.js` | UNCHANGED | Cloud sync tetap pakai schema lama (tidak ada PGRST204) |
| `popup/popup.js` | UNCHANGED | UI action sheet sama (tombol Copy + Generate tetap) |
| `lib/assistant.js` | UNCHANGED | OmniRouter provider tetap jalan |
| `settings/settings.html` | UNCHANGED | |
| `settings/settings.js` | UNCHANGED | |
| `manifest.json commands` | UNCHANGED | 4 command (sidebar + 3 capture), tidak ada shortcut baru |

## Kenapa tidak ubah `extractConversation()` di content.js?

Pertimbangan: user mau snapshot ambil 3 pairs terakhir. Tapi `extractConversation()`
dipakai untuk:
1. Preview modal snapshot (di content.js `openSnapshotModal`)
2. EXTRACT_SNAPSHOT message handler (kirim ke popup)
3. Body snapshot yang di-save ke vault (untuk inject ke AI lain, copy, dll)

Kalau saya ubah default `extractConversation()` jadi 3 pairs:
- ✅ Resume context jadi 3 pairs terakhir (yang user mau)
- ❌ Snapshot biasa juga jadi 3 pairs (user mungkin mau full conversation untuk
  di-inject ke AI lain)
- ❌ Break backward compat — snapshot lama tidak konsisten dengan snapshot baru

**Strategi yang dipilih**: TIDAK ubah `extractConversation()`. Snapshot body
tetap 50 msgs (fitur snapshot biasa tidak berubah). Relay Point only potong 3
pairs terakhir dari body yang sudah ada — tidak perlu re-extract dari DOM.

**Keuntungan:**
- Fitur snapshot biasa 100% backward compatible
- Hanya resume context yang pakai 3 pairs terakhir
- Tidak perlu modify content.js (yang dipakai banyak tempat)
- Tidak perlu re-extract dari DOM (cukup potong body yang sudah ada)

## Token cost comparison

| Version | Body yang dikirim ke AI | Estimasi token input |
|---|---|---|
| v3.20.16 | 50 msgs (full snapshot body) | 3000-5000 token |
| v3.20.17 | 3 pairs (6 msgs terakhir) | 800-1500 token |

Hemat ~70% token per generate. Gratis kalau pakai OmniRouter local mode atau
Groq free tier.

## Alur kerja user (tidak berubah dari v3.20.16)

1. User buka situs AI → tekan Alt+Shift+5 → Snapshot tersimpan instan (50 msgs)
2. Background ambil 3 pairs terakhir dari body → kirim ke OmniRouter
3. AI deteksi relevansi antar 3 percakapan → filter kalau perlu → generate resume
4. Buka snapshot → action sheet → "📋 Copy Resume Context"
5. Paste ke akun AI baru → lanjut kerja

## File yang berubah

| File | Perubahan |
|---|---|
| `manifest.json` | version bump 3.20.16 → 3.20.17 |
| `background.js` | + helper `extractLastNPairs()` (~50 lines); + prompt system baru dengan deteksi relevansi; update `generateResumeContextSync()` pakai `extractLastNPairs` |
| `CHANGELOG-v3.20.17-relay-point-v2.md` | NEW — file ini |

## Testing checklist (manual, di Firefox)

### Setup
- [ ] Load addon dari `about:debugging` → "Load Temporary Add-on" → pilih
      `manifest.json`.
- [ ] Buka Settings → AI Assistant → pilih provider OmniRouter (atau Groq/
      Gemini) → isi API key → Simpan.

### Test 1: 3 pairs terakhir, semua relevan
- [ ] Buka ChatGPT/Claude/Z.AI → chat 5+ pesan tentang SATU topik (mis. setup
      React project)
- [ ] Tekan Alt+Shift+5 → snapshot tersimpan
- [ ] Tunggu ~5 detik → buka snapshot → action sheet → "📋 Copy Resume Context"
- [ ] Paste di notepad → cek: resume context harus mencakup 3 percakapan
      terakhir, TIDAK include percakapan awal yang sudah melebar
- [ ] Token usage di OmniRouter dashboard harus ~800-1500 token input (bukan
      3000-5000)

### Test 2: 3 pairs terakhir, yang pertama tidak relevan
- [ ] Buka ChatGPT → chat tentang topik A (mis. resep masakan) → ganti topik
      ke B (mis. setup database) → chat 2 kali tentang B
- [ ] Tekan Alt+Shift+5 → snapshot tersimpan
- [ ] Buka snapshot → copy resume context
- [ ] Resume context harus HANYA rangkum topik B (database), TIDAK include
      topik A (resep masakan). AI harus detect bahwa percakapan pertama tidak
      berkaitan dan skip.

### Test 3: 2 pairs saja (kurang dari 3)
- [ ] Buka ChatGPT → chat cuma 2 kali (1 user + 1 AI, lalu user + AI lagi)
- [ ] Tekan Alt+Shift+5 → snapshot tersimpan
- [ ] Resume context harus rangkum kedua pairs (tidak crash walau < 3 pairs)

### Test 4: Graceful degradation
- [ ] Hapus API key OmniRouter → ambil snapshot → tidak ada error
- [ ] Snapshot tersimpan normal, resumeContext = null
- [ ] Klik "🔄 Generate Resume Context" → toast error "Gagal generate"

### Test 5: Snapshot biasa tetap ambil 50 msgs (TIDAK berubah)
- [ ] Buka ChatGPT → chat 10+ pesan
- [ ] Tekan Alt+Shift+5 → preview modal muncul → cek body: harus berisi SEMUA
      50 pesan terakhir (bukan 3 pairs)
- [ ] Save snapshot → buka snapshot → body tetap 50 msgs (fitur snapshot biasa
      tidak berubah)
- [ ] Klik "🔄 Lanjutkan di AI Lain" → snapshot body yang di-copy tetap 50 msgs

### Test 6: Cloud sync tetap jalan (KRITIS)
- [ ] Ambil snapshot → tunggu 10 detik → cek Supabase dashboard → snapshot
      baru muncul di `vault_items` dengan `snapshot_domain` terisi
- [ ] TIDAK ada error PGRST204 di console
- [ ] Snapshot lama (sebelum v3.20.17) tetap muncul, tetap bisa di-open

## Catatan

- **Base version**: `v3.20.16` (Relay Point v1). v3.20.17 refine Relay Point
  dengan 3 pairs terakhir + deteksi relevansi.
- **Tidak ditandai sebagai stable** — sesuai instruksi user, tag `v3.20.17`
  saja (no `-stable` suffix).
- **Pelajaran dari v3.20.16 broken sebelumnya**: jangan ubah `extractConversation()`
  di content.js karena dipakai banyak tempat. v3.20.17 hanya tambah helper parser
  di background.js — fitur snapshot biasa 100% backward compatible.
