# RecallFox v3.11.31

Firefox addon untuk simpan prompt & konteks AI dengan satu klik.
Local-first, sync opsional, backup terenkripsi.

> **v3.11.31 — Fix sync hapus tidak konsisten (item muncul lagi)**
> - 🔄 **Issue #1 (Delete sync)**: Item yang sudah dihapus muncul lagi setelah sync. **Root cause:** device B push item X (yang sudah dihapus di device A) → upsert tanpa `deleted_at` → menimpa tombstone cloud → device A pull → item X muncul lagi. **4 fix:**
>   - **Delete registry lokal** — daftar ID yang sudah dihapus, supaya push SKIP item itu (tidak timpa tombstone)
>   - **Fix `pushToSupabase`** — skip item/note yang ada di delete registry
>   - **Fix `pullFromSupabase`** — saat item cloud punya `deleted_at`, tambah ke delete registry lokal
>   - **Fix `fullSync` urutan** — PULL dulu, lalu PUSH (bukan push dulu) supaya device tahu item yang sudah dihapus sebelum push
>   - **Update `deleteItem`/`deleteBundle`/`deleteNote`** — tambah ke delete registry lokal saat hapus
>
> **Baseline:** v3.11.30 · **Lihat:** [CHANGELOG-v3.11.31.md](./CHANGELOG-v3.11.31.md)

## ⚠️ WAJIB: Run ulang SQL schema (untuk v3.11.31)

User **WAJIB** run ulang `supabase-schema.sql` di Supabase SQL Editor supaya index baru + cleanup function tersedia.

### Cara update:
1. Buka https://supabase.com/dashboard/project/qmwofsfpxjptpyvncylp/sql/new
2. Login dengan akun Supabase Anda
3. Paste isi [`supabase-schema.sql`](./supabase-schema.sql), klik **Run**
4. Verifikasi:
   ```sql
   -- Cek index baru
   SELECT indexname FROM pg_indexes
   WHERE schemaname = 'public' AND tablename IN ('vault_items', 'notes')
   AND indexname LIKE 'idx_%deleted_at' OR indexname LIKE 'idx_%updated_at';
   -- Expected: idx_vault_items_deleted_at, idx_notes_deleted_at,
   --           idx_vault_items_updated_at, idx_notes_updated_at

   -- Cek cleanup function
   SELECT proname FROM pg_proc WHERE proname = 'cleanup_old_tombstones';
   -- Expected: cleanup_old_tombstones

   -- Test cleanup (opsional, hapus tombstone >30 hari)
   SELECT public.cleanup_old_tombstones(30);
   ```

### Cara pakai cleanup function (opsional):
```sql
-- Hapus tombstone >30 hari (default)
SELECT public.cleanup_old_tombstones(30);

-- Hapus tombstone >7 hari (agresif)
SELECT public.cleanup_old_tombstones(7);
```

## 🗄️ Setup Supabase (first time)

1. Buka https://supabase.com/dashboard/project/qmwofsfpxjptpyvncylp/sql/new
2. Login dengan akun Supabase Anda
3. Paste seluruh isi file [`supabase-schema.sql`](./supabase-schema.sql), klik **Run**
4. Cek output — harus "Success. No rows returned."
5. Cek di Table Editor — harus muncul 6 tables: `profiles`, `vault_items`, `notes`, `settings`, `screenshots`, `sync_log`
6. Buka addon → Alat → Sync Cloud → section "🔐 Login Supabase" → klik **Login**
7. Klik **Push ke Cloud** untuk upload state lokal ke Supabase

## Install di Firefox

### Cara 1 — Load sebagai temporary addon (untuk dev)
1. Buka Firefox → ketik `about:debugging` di address bar
2. Klik **"This Firefox"** di sidebar kiri
3. Klik tombol **"Load Temporary Add-on..."**
4. Pilih file `manifest.json` di folder `recallfox/`
5. Addon aktif sampai Firefox ditutup

### Cara 2 — Install permanen (perlu signing)
Karena ini addon unsigned, untuk instalasi permanen ada 2 opsi:
- **Pakai Firefox Developer Edition / Nightly / ESR** — bisa set `xpinstall.signatures.required = false` di `about:config`
- **Submit ke AMO** (addons.mozilla.org) untuk di-sign — butuh akun developer

## Pemakaian

### Shortcut keyboard
| Shortcut | Fungsi |
|---|---|
| `Option+Shift+4` | Buka / tutup sidebar (toggle) |
| `Option+Shift+2` | Simpan teks terseleksi ke vault |
| `Option+Shift+3` | Ambil snapshot percakapan AI |
| `Option+Shift+5` | Tangkap halaman → popout PDF/JPG/PNG/Copy/Vault (mode: Seluruh Halaman) |
| `Option+Shift+6` | Tangkap area terpilih (seret kotak) → popout PDF/JPG/PNG/Copy/Vault |
| `Option+Shift+7` | Tangkap bagian terlihat (viewport saja) → popout PDF/JPG/PNG/Copy/Vault |
| `Option+Shift+C` | Clear cache (data browser) |

> ✅ Pakai **Option + Shift + angka** (tidak pakai Cmd). Jalan di halaman AI via content script.
> Alternatif: `Ctrl+Option+1/2/3` atau `Ctrl+Shift+1/2/3` (2 modifier dari Ctrl/Option/Shift + angka).
> Screenshot bisa juga di-trigger dari **tombol overlay mengambang** 📸 di pojok kanan atas setiap halaman http(s).


### Quick capture
1. Blok teks di halaman web mana saja
2. Klik kanan → "Simpan sebagai Prompt" / "Simpan sebagai Konteks"
3. Toast konfirmasi muncul di pojok kanan bawah

### Simpan halaman / link
1. **Halaman yang sedang dibuka**: klik kanan di mana saja → "Simpan Halaman Ini"
2. **Link di halaman**: klik kanan pada link → "Simpan Link Ini"
3. Buka vault → tab **Link** → klik item untuk buka di tab baru
4. Atau gabungkan beberapa link jadi **Bundle** (project session) — klik bundle = buka semua link sekaligus

### Pakai prompt
1. Buka tab AI tool yang didukung (z.ai, ChatGPT, Claude, Gemini, DeepSeek, Qwen, Kimi)
2. Klik ikon RecallFox di toolbar (atau buka sidebar)
3. Klik item di vault → otomatis disisipkan ke textarea AI

### Snapshot percakapan
- Saat di halaman AI, tekan `Option+Shift+3` atau klik tombol mengambang 📸 di pojok
- Modal muncul dengan ringkasan otomatis
- Edit judul + tag, lalu simpan

### Screenshot (FireShot-style + Area Selection)

Flow seperti FireShot, sekarang dengan **3 mode capture**: pilih mode dulu → capture → popout modal → pilih format simpan.

#### 3 Mode Capture

| Mode | Cocok untuk | Cara |
|---|---|---|
| 📄 **Seluruh Halaman** | Artikel, dokumentasi, laporan panjang | Scroll-stitch dari atas ke bawah |
| 📱 **Bagian Terlihat** | Cuplikan cepat viewport saat ini | Capture tunggal, tanpa scroll |
| ✂️ **Seleksi Area** | Cuplikan UI spesifik (tombol, form, card, error message) untuk troubleshooting atau dokumentasi | Seret kotak di area yang mau di-capture — bisa diulang untuk beberapa contoh |

#### Cara trigger (4 cara, semua equivalent)

1. **Tombol overlay mengambang** 📸 — paling gampang
   - Tombol bulat oranye di **pojok kanan atas** setiap halaman http(s)
   - Bisa di-drag pindah posisi kalau menghalangi konten
   - Klik sekali → **mode picker** muncul (pilih: Seluruh / Terlihat / Area)

2. **Shortcut keyboard** (langsung tanpa picker):
   - `Alt+Shift+5` — Seluruh Halaman
   - `Alt+Shift+6` — Seleksi Area (langsung seret kotak)
   - `Alt+Shift+7` — Bagian Terlihat

3. **Popup toolbar** → klik tombol **Shot** → mode picker muncul

4. **Command palette** di popup → ketik `>shot-area`, `>shot-visible`, atau `>shot-full`

#### Yang terjadi setelah trigger

1. **Mode "Seluruh Halaman"**: RecallFox scroll otomatis dari atas ke bawah, capture setiap viewport, lalu jahit (stitch) di canvas jadi satu gambar panjang. Banner progress muncul di atas.
2. **Mode "Seleksi Area"**: overlay crosshair muncul. User seret kotak di area yang ingin di-capture. Esc batal. Setelah seleksi → capture area tersebut saja.
3. **Mode "Bagian Terlihat"**: capture tunggal viewport saat ini, tanpa scroll.
4. Setelah capture selesai → **popout modal** muncul di tengah halaman dengan:
   - **Preview gambar** yang baru di-capture
   - **Info dimensi** (mis. 1440 × 8230 px · 1.2 MB)
   - **Mode** (entire / visible / selection)

#### Tombol aksi di modal

| Tombol | Fungsi |
|---|---|
| 📄 **Simpan PDF** | Generate PDF (single/multi-page, A4) → download ke folder `Downloads/RecallFox/` |
| 🖼️ **Simpan JPG** | Re-encode sebagai JPEG → download |
| 🖼️ **Simpan PNG** | Re-encode sebagai PNG → download |
| 📋 **Salin** | Copy gambar ke clipboard (bisa paste ke editor gambar/chat) |
| 🦊 **Simpan ke Vault** | Simpan sebagai item screenshot di vault |
| **Batal** | Tutup modal, gambar tidak disimpan |

> PDF generation murni JS (lihat `lib/pdf.js`) — tidak butuh jsPDF atau library eksternal. Multi-page otomatis kalau gambar lebih tinggi dari satu halaman A4.

#### Use case Seleksi Area

Saat membangun aplikasi atau troubleshooting, sering perlu ambil contoh UI dari berbagai web:
- Cuplikan tombol/form tertentu dari kompetitor untuk referensi desain
- Bagian error/pesan dari console atau halaman web untuk dokumentasi bug
- Komponen UI spesifik (navbar, card, modal) tanpa capture seluruh halaman
- Bisa diulang beberapa kali — tiap capture jadi item terpisah di vault

#### Catatan teknis

- Capture pakai `browser.tabs.captureVisibleTab` di background + content-script scroll-stitch (mode "entire") atau canvas crop (mode "selection")
- Maks 60 frame per capture (safety); tinggi maks 16384px (dapat diubah di Settings)
- Mode "selection" menggunakan overlay crosshair dengan 4 mask div untuk dimming, lalu crop di canvas dengan offset DPR
- Tombol overlay bisa dimatikan di **Settings → Umum → "Tombol overlay screenshot di semua halaman"**
- Halaman `about:`, `chrome:`, `moz-extension:` tidak bisa di-capture (dilindungi browser)

### Catatan Sementara (Notepad)
Notepad cepat untuk catatan sementara (scratchpad) — auto-save, 6 warna, pin ke atas.

#### Cara pakai
1. Buka popup/sidebar → klik tab **📝** (paling kanan)
2. Klik tombol **Catatan Baru** → editor muncul
3. Ketik catatan — auto-save 800ms setelah berhenti mengetik
4. Pilih warna (default/kuning/hijau/biru/pink/ungu)
5. Klik **📌 Pin** untuk pin ke atas, **Salin** untuk copy ke clipboard, **Selesai** untuk tutup
6. Klik catatan di list untuk edit lagi
7. **Esc** untuk tutup editor

#### Penyimpanan
- Disimpan di `storage.local` (`recallfox_notes` key)
- **Tidak ikut Firefox Sync** (catatan sementara, lokal saja)
- Tidak ikut backup JSON export (bisa dihapus kapan saja tanpa risiko)
- Tidak ada limit jumlah catatan (tapi disarankan <100 untuk performance)

### Clear Cache (Pembersihan Data Browser)
Bersihkan data browsing dengan satu klik — terinspirasi dari [clear-cache](https://github.com/TenSoja/clear-cache) (MIT).

#### Cara trigger (4 cara)
1. **Tombol ikon trash** 🗑️ di header popup/sidebar
2. **Shortcut keyboard**: `Alt+Shift+C`
3. **Context menu**: klik kanan di halaman → "Clear Cache"
4. **Settings → Clear Cache → "Clear Sekarang"** (untuk test setting)

#### Tipe data yang bisa dibersihkan
- ✅ Cache, Cookies, History, Local Storage, IndexedDB, Service Workers, Downloads, Form Data, Passwords

#### Periode waktu
- 15 menit, 1 jam, 24 jam, 1 minggu, atau semua waktu

#### Mode "Hanya tab aktif" (per-site)
- Bersihkan cookies/localStorage/indexedDB/serviceWorkers hanya untuk hostname tab aktif
- ⚠️ Cache, History, Downloads, Form Data, Passwords **TIDAK support per-site** — akan dilewati
- Berguna untuk: clear cookies situs tertentu tanpa logout dari situs lain

#### Setting default
| Setting | Default |
|---|---|
| Tipe data | Cache only |
| Periode | Semua waktu |
| Hanya tab aktif | Off (global) |
| Auto-reload | On |
| Notifikasi | On |

#### API yang dipakai
- `browser.browsingData.remove({since, hostnames?}, types)` — Firefox native API
- `browser.notifications.create()` — untuk notifikasi
- `browser.tabs.reload()` — untuk auto-reload

### Waktu Shalat (Metode Muhammadiyah)
Jadwal shalat harian dengan **metode Muhammadiyah** — Subuh -18°, Isya -18° (per Munas Tarjih 2020), via Aladhan API.

#### Cara aktifkan
1. Buka popup/sidebar → klik tab **🕌** (paling kanan)
2. Klik **Setup Sekarang**
3. Pilih cara set lokasi:
   - **Cari alamat**: ketik kota (mis. "Yogyakarta") → pilih dari saran
   - **Deteksi otomatis**: klik "📍 Deteksi Lokasi Otomatis" (butuh izin geolocation)
4. Pilih mazhab Asr (Syafi'i = default Indonesia, atau Hanafi)
5. Pilih format jam (24-jam atau 12-jam AM/PM)
6. Klik **Simpan & Aktifkan**

#### Yang ditampilkan
- **Header hijau**: nama lokasi + tanggal Hijriah
- **Countdown box**: shalat berikutnya + waktu + sisa waktu (mis. "Subuh 04:32 -2j 15m (hari ini)")
- **6 baris waktu**: Subuh 🌄, Terbit 🌅, Dzuhur ☀️, Ashar 🌤️, Magrib 🌆, Isya 🌙
- Baris shalat berikutnya di-highlight hijau + badge "NEXT"
- **Footer**: refresh + setup ulang + info metode

#### Catatan teknis
- API: `https://api.aladhan.com/v1/timings/{DD-MM-YYYY}?latitude=...&longitude=...&method=3&methodSettings=18,18,0&school={0|1}`
- `method=3` (Muslim World League) sebagai base, override via `methodSettings=18,18,0` untuk match Muhammadiyah (Fajr 18°, Isha 18°)
- `school=0` = Syafi'i (default), `school=1` = Hanafi
- Cache per-hari di `storage.local` (`prayerCachedTimes` di vault settings)
- Auto-refresh tiap 30 detik untuk update countdown
- Geocoding: Nominatim OpenStreetMap API

#### Sumber metode Muhammadiyah
- [muhammadiyah.or.id — Waktu Subuh Muhammadiyah, Kriteria -18 Derajat](https://muhammadiyah.or.id/2021/03/waktu-subuh-muhammadiyah-kriteria-18-derajat)
- Munas Tarjih 2020: Subuh diubah dari -20° ke -18°
- Isya: -18° (sudut standar)

#### Kenapa bukan method=20 (KEMENAG)?
KEMENAG (Indonesian government) pakai Fajr 20°, Isha 18°. Muhammadiyah pakai Fajr 18°, Isha 18°. Selisih 2° di Fajr = ~8 menit lebih awal masuk Subuh versi KEMENAG. Untuk match persis Muhammadiyah, kita override dengan `methodSettings=18,18,0`.

### Sidebar Compact (untuk layar MacBook Air M4)
Sidebar RecallFox dioptimalkan untuk width **280-340px** (sekitar 20-25% layar MacBook Air M4 13").

#### Cara set width sidebar
1. Buka sidebar RecallFox (Alt+Shift+4)
2. Drag handle pembatas sidebar (di tepi kiri sidebar) ke kiri sampai sidebar menyempit
3. Target width: ~300px (cukup untuk lihat semua konten tanpa scroll horizontal)

#### Yang dioptimalkan di compact mode (otomatis saat width ≤480px)
- Font size lebih kecil (12px body, 11px meta)
- Tombol icon lebih kecil (26×26px)
- Tab lebih kecil dengan horizontal scroll
- Item padding lebih ramping
- Quick action button lebih compact
- Prayer widget lebih ramping
- Modal fit ke lebar sidebar (`max-width: calc(100vw - 16px)`)

#### Test
1. Drag sidebar sampai ~300px
2. Semua elemen harus terlihat tanpa scroll horizontal
3. Coba tab Notes, Prayer, Snapshot — semua harus muat

### Backup
- Buka Settings → "Backup Lokal"
- Export plain JSON atau terenkripsi (.rfvault)
- Passphrase minimal 8 karakter disarankan untuk enkripsi

## AI Tool yang Didukung

| Region | Tool | Domain |
|---|---|---|
| Lokal | z.ai | chat.z.ai |
| Barat | ChatGPT | chatgpt.com |
| Barat | Claude | claude.ai |
| Barat | Gemini | gemini.google.com |
| China | DeepSeek | chat.deepseek.com |
| China | Qwen | tongyi.aliyun.com, chat.qwen.ai |
| China | Kimi | kimi.moonshot.cn, kimi.com |

## Struktur File

```
recallfox/
├── manifest.json          # Manifest V3 Firefox (v0.2.1)
├── background.js          # Service worker: menu, shortcut, sync, capture pipeline, PDF/JPG/PNG save
├── content/
│   ├── ai-resolvers.js    # Config selector per-domain
│   ├── content.js         # Inject, toast, snapshot, floating btn (AI domains only)
│   ├── content.css        # Style toast & modal
│   ├── capture.js         # Page-side scroll-stitch helper (on-demand inject)
│   ├── capture.css        # Selection overlay + capture banner styles
│   ├── overlay.js         # FireShot-style floating button + capture modal (all http(s) pages)
│   └── overlay.css        # Floating button + modal styles
├── popup/                 # Vault UI (popup toolbar)
├── sidebar/               # Vault UI (sidebar persistent)
├── settings/              # Settings page (incl. Screenshot section + overlay toggle)
├── lib/
│   ├── storage.js         # storage.local + sync chunking + screenshot blob helpers
│   ├── crypto.js          # AES-GCM + PBKDF2 backup
│   ├── search.js          # Fuzzy search + variables
│   ├── pdf.js             # Minimal pure-JS PDF generator (single/multi-page, DCTDecode)
│   └── domains.js         # Domain config (mirror of content/ai-resolvers.js)
├── icons/                 # SVG icons
└── _locales/
    ├── en/messages.json
    └── id/messages.json
```

## Catatan Teknis

- **Manifest V3** untuk Firefox 115+
- **Storage**: 3 lapis — `storage.local` (working), `storage.sync` (multi-device, chunked 90KB), backup file (manual)
- **Screenshot storage**: gambar penuh di `storage.local` (`rf_shot_<id>` key), thumbnail + metadata di vault JSON
- **Enkripsi backup**: AES-GCM 256-bit + PBKDF2 100k iter via Web Crypto API (native browser)
- **Sync conflict**: item-level merge by `updatedAt` timestamp, last-write-wins
- **Inject strategy**: coba set value via native setter (untuk React) → execCommand insertText (untuk ProseMirror) → fallback clipboard
- **Selector AI tool**: pakai fallback bertingkat (array of selectors, dicoba berurutan). Bisa diupdate tanpa reload addon jika disimpan sebagai config terpisah di masa depan.
- **Screenshot capture**: `browser.tabs.captureVisibleTab` (background) + content-script scroll-stitch + OffscreenCanvas thumbnail. Tidak pakai native messaging.

## Limitasi yang Diketahui

- Selector AI tool bisa berubah saat situs update. Kalau inject gagal, fallback otomatis ke clipboard.
- Snapshot hanya teks (gambar, file attachment, kode block diformat diabaikan).
- Maks 50 pesan terakhir per snapshot, maks 10KB body.
- Firefox Sync punya limit 100KB/key (perlu chunking untuk vault besar).
- Tidak ada summary AI otomatis (heuristik saja — 40 kata pertama dari pesan user pertama).
- Screenshot "Seluruh Halaman" tidak menangkap posisi fixed/sticky dengan sempurna (heading yang menempel saat scroll bisa ter-duplikasi di frame akhir). Untuk halaman dengan banyak sticky header, mode "Seleksi Area" lebih akurat.
- Screenshot halaman yang butuh login mungkin gagal capture bagian yang belum di-render (lazy-load). Capture tunggu 220ms per frame; kalau gambar belum muncul, akan kosong.
- Capture tidak bisa dipanggil di halaman `about:`, `chrome:`, `moz-extension:` (dilindungi browser).

## Roadmap (Fase Berikutnya)

- [ ] Domain tier 2: Perplexity, Grok, Copilot, Mistral, Doubao, ChatGLM, Yiyan, Yuanbao
- [ ] Smart suggestions (saran context berdasarkan kata di textarea)
- [ ] Bundle editor visual (drag-drop urutan)
- [ ] Sidebar pindah posisi (kiri/kanan)
- [ ] Auto-update selector dari remote config (GitHub raw JSON)
- [ ] Opsi summary AI untuk snapshot (perlu API key user)

## Lisensi

MIT — bebas pakai, modifikasi, distribusi.
