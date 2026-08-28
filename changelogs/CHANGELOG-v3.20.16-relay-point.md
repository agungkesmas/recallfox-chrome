# RecallFox Firefox — v3.20.16 (Relay Point)

> Upgrade Snapshot sebagai 'Relay Point' (checkpoint migrasi akun AI). Snapshot
> di AI domain otomatis generate resume context via OmniRouter — user bisa
> paste ke akun AI baru untuk melanjutkan pekerjaan.

Tanggal: 2026-08-02
Base: `recallfox-3.20.15-stable`

## Ringkasan

Fitur baru: **Relay Point**. Saat user ambil Snapshot di situs AI (ChatGPT,
Claude, Z.AI, dll) dan situsnya lemot/penuh, user bisa pindah ke akun AI lain
dengan konteks yang sama. Snapshot otomatis generate "resume context"
(ringkasan status kerja terakhir) via OmniRouter — user tinggal copy dan paste
ke akun AI baru.

**Tanpa tombol/shortcut baru** — fitur ini manfaatkan Snapshot yang sudah ada.
Resume context disimpan menyatu di metadata snapshot (bukan item baru).

## Perubahan

### 1. background.js — Generate resume context via OmniRouter (silent, async)

Import baru: `updateItem` dari `lib/storage.js`, `chatWithFallback` +
`isAssistantConfigured` dari `lib/assistant.js`.

Saat `CAPTURE_SNAPSHOT` diterima dan snapshot body ≥ 100 char, background
otomatis trigger `generateResumeContext(itemId, body, title)` — fire-and-forget,
non-blocking. Snapshot tetap tersimpan instan, resume context di-generate di
background (~3-5 detik) lalu update item via `updateItem()`.

Fungsi baru:
- `generateResumeContext(itemId, body, title)` — async fire-and-forget. Cek
  `isAssistantConfigured()` dulu, skip kalau belum. Kalau gagal, log warning
  + resumeContext = null. Tidak throw.
- `generateResumeContextSync(body, title)` — generate sync (untuk manual
  trigger). Truncate body ke 8000 char sebelum kirim ke AI. Filter: kalau AI
  bilang "terlalu pendek", return null.
- `GENERATE_RESUME_CONTEXT` message handler — untuk manual trigger dari popup
  (user klik "Generate Resume Context" di action sheet).

**Graceful degradation**:
- OmniRouter belum dikonfigurasi → log "AI not configured", skip generate.
  Snapshot tetap tersimpan normal.
- Generate gagal (network/auth) → log warning, resumeContext = null. User bisa
  retry manual via tombol di action sheet.
- Body < 100 char → tidak trigger auto-generate (terlalu pendek untuk resume).

### 2. lib/storage.js — Field baru `resumeContext` + `resumeContextAt` (LOKAL)

Di `addItem()` untuk `type === 'snapshot'`, tambah 2 field opsional:
- `resumeContext` (string | null) — ringkasan status kerja terakhir
- `resumeContextAt` (ISO timestamp | null) — kapan di-generate

**PENTING — STRATEGI AMAN (pelajaran dari v3.20.16 broken sebelumnya):**
Field ini HANYA disimpan di local storage (`browser.storage.local`). TIDAK
sync ke Supabase. Alasan: kolom `resume_context` belum ada di `vault_items`
table. Kalau dipaksakan kirim, Supabase akan reject dengan PGRST204 → SEMUA
snapshot sync gagal → fitur cloud sync rusak total.

`lib/supabase-sync.js` **TIDAK diubah** sama sekali. `_buildVaultItemRow()`
tetap pakai schema lama (tidak kirim `resume_context`). Cloud sync tetap jalan
normal seperti v3.20.15.

Trade-off: resume context tidak sync antar device. Tapi user biasanya generate
resume context di device yang sama tempat dia ambil snapshot, jadi OK.

Backward compat: snapshot lama (sebelum v3.20.16) punya `resumeContext = null`
— tidak crash, tetap berfungsi. User bisa generate manual via tombol di action
sheet.

### 3. popup/popup.js — Tombol Copy + Generate di action sheet snapshot

Di `itemSheet()` (action sheet item), untuk `type === 'snapshot'`:
- Kalau `it.resumeContext` ada → tampilkan tombol "📋 Copy Resume Context"
- Kalau `it.resumeContext` tidak ada → tampilkan tombol "🔄 Generate Resume
  Context" (manual trigger / retry)

Handler baru (di event listener click yang sekarang jadi `async`):
- `copy-resume` — `navigator.clipboard.writeText(it.resumeContext)`. Fallback:
  delegate ke background via `COPY_TO_CLIPBOARD` message kalau clipboard API
  gagal (cross-origin context).
- `gen-resume` — kirim `GENERATE_RESUME_CONTEXT` ke background. Toast "🔄
  Membuat resume context via OmniRouter..." saat mulai, toast "✓ Resume context
  siap" kalau sukses. Refresh vault setelah sukses supaya tombol berubah jadi
  "Copy".

Error handling untuk `gen-resume`:
- `generate_failed` → "Gagal generate — cek API key OmniRouter di Pengaturan"
- `snapshot_body_too_short` → "Snapshot terlalu pendek untuk resume context"
- `item_not_found_or_not_snapshot` → "Item tidak ditemukan atau bukan snapshot"

### 4. manifest.json — version bump 3.20.15 → 3.20.16

Tidak ada perubahan lain di manifest. Tidak ada shortcut/command baru.
Tidak ada permission baru. Tidak ada host_permission baru.

## Yang TIDAK berubah

- **Tombol/shortcut Snapshot**: Alt+Shift+5 (capture page), Alt+Shift+6
  (capture area), Alt+Shift+7 (capture visible). Tidak ada shortcut baru.
- **UI modal preview snapshot**: tetap sama. Hanya action sheet yang tambah
  1-2 tombol Relay Point.
- **Format storage snapshot**: field `resumeContext` opsional, backward
  compatible. Snapshot lama tetap berfungsi.
- **Cloud sync Supabase**: `lib/supabase-sync.js` TIDAK diubah. Schema lama
  tetap dipakai. Snapshot sync ke cloud tetap jalan normal.
- **Snapshot di non-AI domain**: tetap berfungsi normal. `snapshotDomain` hanya
  di-set kalau `isAIPage()` true (sudah ada sejak v3.16.2). Resume context
  tidak di-generate untuk snapshot non-AI.
- **OmniRouter**: tetap pakai provider yang dikonfigurasi di Settings → AI
  Assistant. Bisa OmniRouter (recommended), Groq, Gemini, OpenAI, atau lainnya.
- **GDrive Sync**: tetap pakai hook yang sudah ada di `updateItem()`.

## Alur kerja user

### Auto-generate (silent)

1. User buka situs AI (ChatGPT/Claude/Z.AI/dll) → kerja sampai situs lemot.
2. User tekan Alt+Shift+5 (shortcut yang sudah ada) → Snapshot diambil →
   tersimpan instan (toast "📸 Snapshot tersimpan ✓").
3. Background otomatis generate resume context via OmniRouter (silent, ~3-5
   detik). Tidak ada UI blocking.
4. User buka sidebar/popup → klik snapshot → action sheet muncul → ada tombol
   "📋 Copy Resume Context".
5. User klik tombol → resume context tersalin ke clipboard.
6. User buka akun AI baru → paste resume context → lanjut kerja.

### Manual generate (retry)

4b. Kalau auto-generate gagal (mis. OmniRouter belum dikonfigurasi saat
    capture), buka snapshot → action sheet → klik "🔄 Generate Resume Context".
5b. Toast "🔄 Membuat resume context via OmniRouter..." → tunggu ~5 detik →
    toast "✓ Resume context siap".
6b. Klik item lagi → tombol sekarang "📋 Copy Resume Context".

## Keamanan

- Resume context di-generate via API call ke OmniRouter (atau provider yang
  dikonfigurasi). Body snapshot dikirim ke API. Sama seperti fitur "Ringkas
  dengan AI" yang sudah ada — tidak ada perubahan kebijakan privasi.
- API key disimpan di `browser.storage.local` (sudah ada sejak v3.20.15).

## Token cost

Setiap generate resume context ≈ 1000-2000 token input + 300 token output.
Gratis kalau pakai OmniRouter local mode atau Groq free tier.

## File yang berubah

| File | Perubahan |
|---|---|
| `manifest.json` | version bump 3.20.15 → 3.20.16 |
| `background.js` | + import `updateItem` + `chatWithFallback` + `isAssistantConfigured`; + `generateResumeContext()` async fire-and-forget; + `generateResumeContextSync()` untuk manual; + `GENERATE_RESUME_CONTEXT` message handler; + trigger auto-generate di `CAPTURE_SNAPSHOT` |
| `lib/storage.js` | + field `resumeContext` + `resumeContextAt` di addItem schema snapshot (LOKAL saja, tidak sync ke cloud) |
| `popup/popup.js` | + tombol "📋 Copy Resume Context" + "🔄 Generate Resume Context" di action sheet snapshot; + handler `copy-resume` + `gen-resume`; event listener click jadi `async` |
| `CHANGELOG-v3.20.16-relay-point.md` | NEW — file ini |

## File yang TIDAK berubah (penting!)

| File | Status |
|---|---|
| `lib/supabase-sync.js` | UNCHANGED — `_buildVaultItemRow` + `_parseVaultItemRow` tetap pakai schema lama. Cloud sync tetap aman. |
| `lib/assistant.js` | UNCHANGED — OmniRouter provider sudah di-add di v3.20.15 |
| `settings/settings.html` | UNCHANGED |
| `settings/settings.js` | UNCHANGED |
| `content/content.js` | UNCHANGED — deteksi AI domain sudah ada sejak v3.16.2 |
| `manifest.json commands` | UNCHANGED — tidak ada shortcut baru |

## Testing checklist (manual, di Firefox)

### Setup
- [ ] Load addon dari `about:debugging` → "Load Temporary Add-on" → pilih
      `manifest.json`.
- [ ] Buka Settings → AI Assistant → pilih provider OmniRouter (atau Groq/
      Gemini) → isi API key → Simpan.

### Auto-generate (silent)
- [ ] Buka ChatGPT/Claude/Z.AI → mulai chat (≥ 3 pesan) → tekan Alt+Shift+5.
- [ ] Snapshot tersimpan instan (toast "📸 Snapshot tersimpan ✓").
- [ ] Tunggu ~5 detik (background generate resume context).
- [ ] Buka sidebar → klik snapshot → action sheet → harus ada tombol
      "📋 Copy Resume Context".
- [ ] Klik tombol → toast "📋 Resume context tersalin" → paste di notepad →
      harus terstruktur (Tujuan / Sudah Dikerjakan / Belum Selesai / Konteks
      Penting).

### Manual generate (retry)
- [ ] Kalau auto-generate gagal (mis. OmniRouter belum dikonfigurasi saat
      capture), buka snapshot → action sheet → klik "🔄 Generate Resume
      Context".
- [ ] Toast "🔄 Membuat resume context via OmniRouter..." → tunggu → toast
      "✓ Resume context siap".
- [ ] Klik item lagi → tombol sekarang "📋 Copy Resume Context".

### Graceful degradation
- [ ] Hapus API key OmniRouter dari Settings → ambil snapshot baru → tidak
      ada error di console.
- [ ] Snapshot tersimpan normal, tapi `resumeContext = null` (tombol "🔄
      Generate Resume Context" muncul, bukan "📋 Copy").
- [ ] Klik "🔄 Generate Resume Context" → toast error "Gagal generate — cek
      API key OmniRouter di Pengaturan".

### Non-AI domain
- [ ] Buka halaman non-AI (mis. Wikipedia) → tekan Alt+Shift+5 → toast
      "Bukan halaman AI".
- [ ] Snapshot tidak tersimpan (tidak ada body untuk di-resume).

### Cloud sync tetap jalan (KRITIS)
- [ ] Setelah ambil snapshot di AI domain, tunggu 10 detik, cek Supabase
      dashboard → table `vault_items` → snapshot baru harus muncul dengan
      field `snapshot_domain` terisi.
- [ ] TIDAK ada error PGRST204 "column not found" di console.
- [ ] Snapshot lama (sebelum v3.20.16) tetap muncul di list, tetap bisa
      di-open, tetap bisa di-inject.

## Catatan

- **Base version**: `recallfox-3.20.15-stable` (OmniRouter integration).
  v3.20.16 menambah Relay Point di atasnya.
- **Tidak ditandai sebagai stable** — sesuai instruksi user, tag `v3.20.16`
  saja (no `-stable` suffix).
- **Pelajaran dari v3.20.16 broken sebelumnya**: jangan tambah field ke
  Supabase sync tanpa ALTER TABLE migration yang sudah dijalankan. Versi ini
  menghindari masalah itu dengan menyimpan `resumeContext` hanya di local
  storage.
