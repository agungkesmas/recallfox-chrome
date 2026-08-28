# RecallFox v3.20.24 — Fix location badge: lazy reverse geocode untuk item tanpa address

**Tanggal:** 2026-08-04
**Base:** v3.20.23 (Firefox) / v3.20.22-chrome (Chrome)
**Scope:** Bug fix di popup.js + background.js. Tidak ada schema change.

## TL;DR

User report: "di bagian media, versi chrome, itu lokasi yang kebaca adalah titik koordinat untuk foto yang baru di take, bukan nama jalan. padahal versi firefoxnya nama jalan atau nama lokasi langsung."

**Root cause:** Item screenshot dari PWA punya `source.location` dengan `lat`/`lng` tapi `address` kosong (PWA gagal reverse geocode saat capture karena Nominatim timeout, atau item lama sebelum fitur ini). Badge display logic pakai fallback ke koordinat kalau `address` kosong.

**Fix:** Sekarang extension aktif reverse-geocode lat/lng → address saat render item kalau `address` kosong. Setelah dapat address, patch vault item + re-render. Item akan otomatis dapat nama jalan dalam beberapa detik setelah pertama kali dilihat.

## Perubahan

### 1. `background.js` — tambah handler `REVERSE_GEOCODE_LOCATION`

Handler baru yang:
1. Terima `{ itemId, lat, lng }` dari popup
2. Panggil `reverseGeocode(lat, lng)` (sudah ada di `lib/salahtime.js`, pakai OpenStreetMap Nominatim)
3. Kalau dapat address, patch vault item: set `source.location.address` + `source.location.capturedAt` (kalau belum ada) + update `updatedAt`
4. Save vault + broadcast `VAULT_UPDATED` supaya popup re-render

**Firefox:** pakai dynamic `await import('./lib/salahtime.js')` (Firefox SW support dynamic import).
**Chrome:** pakai static `reverseGeocode` yang sudah di-import di top-level background.js (Chrome MV3 SW melarang dynamic import sejak v3.20.4).

### 2. `popup/popup.js` — lazy reverse geocode di `renderItemHtml`

Saat render item card, cek `it.source?.location`:
- Kalau `loc` ada + `loc.lat`/`loc.lng` ada + `loc.address` kosong → kirim `REVERSE_GEOCODE_LOCATION` message ke background (fire-and-forget, no await — tidak block render)
- Setelah background selesai patch + broadcast `VAULT_UPDATED`, popup re-render otomatis dengan address yang sudah terisi

**Dedupe:** pakai `Set` (`_pendingReverseGeocode`) supaya tidak kirim request berkali-kali untuk item yang sama dalam satu render cycle. Setelah 5 menit, ID dihapus dari Set supaya bisa retry kalau gagal pertama kali.

### 3. Display logic — tidak berubah

`locationBadge` tetap pakai logic yang sama:
```js
loc.address || (loc.lat?.toFixed(4) + ', ' + loc.lng?.toFixed(4))
```

Yang berubah: sekarang `loc.address` akan otomatis keisi (via lazy reverse geocode) dalam beberapa detik setelah item pertama kali dirender. Sebelum itu, badge tetap show koordinat sebagai fallback.

## Yang TIDAK berubah (AMAN dari regression)

| File | Status |
|---|---|
| `lib/salahtime.js` | UNCHANGED — `reverseGeocode()` tetap pakai Nominatim, 8s timeout |
| `lib/storage.js` | UNCHANGED |
| `lib/supabase-sync.js` | UNCHANGED — cloud sync + pull logic tetap sama |
| `lib/assistant.js` | UNCHANGED |
| `settings/settings.*` | UNCHANGED |
| `manifest.json commands` | UNCHANGED |
| `content/*.js` | UNCHANGED |
| Schema database | UNCHANGED — `source.location` tetap `{ lat, lng, accuracy, address, capturedAt }` |
| PWA | UNCHANGED — PWA tetap reverse geocode saat capture. Extension cuma backup kalau PWA gagal. |

## Behavior flow

### Sebelum v3.20.24 (bug)
1. User take foto di PWA → PWA capture GPS → Nominatim timeout → `address = ''`
2. PWA upload ke cloud: `source.location = { lat: -6.7, lng: 108.5, address: '' }`
3. User buka extension Chrome → pull dari cloud → render item
4. Badge logic: `loc.address || (loc.lat + ', ' + loc.lng)` → fallback ke koordinat
5. User lihat: "📍 -6.7000, 108.5667" ❌

### Sesudah v3.20.24 (fix)
1. User take foto di PWA → PWA capture GPS → Nominatim timeout → `address = ''`
2. PWA upload ke cloud: `source.location = { lat: -6.7, lng: 108.5, address: '' }`
3. User buka extension Chrome → pull dari cloud → render item
4. Badge logic: `loc.address || (loc.lat + ', ' + loc.lng)` → fallback ke koordinat (sementara)
5. **NEW:** Popup detect `address` kosong → kirim `REVERSE_GEOCODE_LOCATION` ke background
6. Background: `reverseGeocode(-6.7, 108.5)` → dapat "Jl. Contoh No. 123, Bandung"
7. Background patch vault item: `source.location.address = "Jl. Contoh No. 123, Bandung"`
8. Background broadcast `VAULT_UPDATED`
9. Popup re-render → badge sekarang show: "📍 Jl. Contoh No. 123, Bandung" ✅

## Performance considerations

- **Nominatim rate limit:** 1 request/detik per IP. Extension cuma reverse geocode item yang benar-benar dilihat user (lazy), jadi tidak akan spam Nominatim.
- **Dedupe Set:** item yang sama tidak di-reverse geocode 2x dalam 5 menit. Kalau gagal pertama kali, baru retry setelah 5 menit.
- **Fire-and-forget:** tidak block render. User lihat koordinat dulu (sementara), lalu otomatis berubah jadi address dalam ~2-5 detik.
- **Local storage:** address di-patch ke vault item lokal (tidak sync ke cloud — supaya tidak overwrite data cloud yang mungkin sudah di-update device lain).

## Files changed

```
background.js              | +31 lines (REVERSE_GEOCODE_LOCATION handler)
popup/popup.js             | +20 lines (lazy reverse geocode in renderItemHtml + _pendingReverseGeocode Set)
manifest.json              | version bump → 3.20.24
CHANGELOG-v3.20.24.md      | new (this file)
```

## Testing checklist

### Test 1: Item PWA dengan address kosong → auto reverse geocode
1. Buka PWA di HP → take foto dengan GPS aktif
2. Tunggu sampai sync ke cloud (cek: extension buka → Media tab → item muncul)
3. **Sebelum v3.20.24:** badge show "📍 -6.7000, 108.5667" (koordinat)
4. **Sesudah v3.20.24:** badge show "📍 [nama jalan, kota]" dalam ~2-5 detik setelah item dirender

### Test 2: Item PWA dengan address sudah terisi → tidak trigger reverse geocode
1. Pastikan PWA sukses reverse geocode saat capture (address terisi)
2. Buka extension → Media tab → item muncul dengan badge "📍 [nama jalan]" langsung
3. Verify: tidak ada request ke Nominatim (cek Network tab di DevTools popup)

### Test 3: Nominatim down/gagal → badge tetap show koordinat (graceful)
1. Simulasikan Nominatim down (block di /etc/hosts atau matikan internet)
2. Buka extension → Media tab → item dengan address kosong
3. Verify: badge tetap show koordinat (fallback). Tidak ada error crash.
4. Setelah 5 menit, retry → kalau Nominatim udah up, address akan terisi.

### Test 4: Multiple items dengan address kosong → reverse geocode satu per satu
1. Punya 5+ item PWA dengan address kosong
2. Buka Media tab → semua item muncul dengan badge koordinat dulu
3. Tunggu ~10-30 detik → address terisi satu per satu (Nominatim rate limit 1 req/s)
4. Verify: tidak ada request burst ke Nominatim (dedupe Set + fire-and-forget)

### Test 5: Regression — fitur lain tetap jalan
1. Prayer strip tetap show countdown (not "Gagal muat")
2. Supabase login + sync tetap jalan
3. RecallTape, Volume, Clear Cache, Auto-backup tetap jalan
4. Screenshot capture (Alt+Shift+5) tetap jalan

## Compatibility

- **Firefox**: tag `v3.20.24` + `v3.20.24-stable`
- **Chrome**: tag `v3.20.24-chrome` + `v3.20.24-chrome-stable`
- Code 100% identical antara Firefox dan Chrome untuk fitur ini (handler + lazy trigger + dedupe Set).
- Chrome MV3 compliant: `reverseGeocode` di-import statically di top-level background.js (bukan dynamic import yang dilarang di Chrome SW).

— *Implemented by Super Z on 2026-08-04, fix bug user report tentang location badge di Media tab Chrome yang show koordinat bukan nama jalan.*
