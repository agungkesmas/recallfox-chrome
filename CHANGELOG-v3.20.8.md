# RecallFox Chrome — v3.20.8 (Stable)

> Sidebar width fix — tambah collapse level `w-min` (≤320px) supaya sidebar tidak terasa "terlalu lebar" saat dikecilkan sampai mentok.

Tanggal: 2026-07-31

## Ringkasan

User melaporkan sidebar RecallFox Chrome "kalau diperkecil sampe mentok masih lebar" dan minta disamakan dengan Firefox addon. Setelah audit:

**Akar masalah:** Chrome Side Panel punya **minimum width ~300px** yang TIDAK bisa di-set oleh extension (browser-controlled, lihat [crbug 41148932](https://crbug.com/41148932)). Firefox sidebar bisa dikecilkan sampai ~200px+ sehingga rule `w-xs` (≤280px) dan `w-xxs` (≤220px) aktif dan layout collapse jadi sangat kompak.

Tapi di Chrome, sidebar tidak akan pernah menyempit di bawah ~300px. Pada width itu, rule `w-sm` (≤360px) sudah aktif, tapi padding/font masih terlalu besar — terasa "terlalu lebar" karena ada banyak whitespace.

**Fix:** Tambah collapse level baru `w-min` (≤320px) yang trigger additional padding/font reduction. Level ini aktif di range 280-320px yang di Chrome adalah "minimum territory" — memberikan layout kompak yang similar dengan `w-xs` di Firefox, tanpa harus menunggu width turun sampai 280px (yang tidak akan pernah tercapai di Chrome).

## Perubahan

### 1. HIGH — Tambah `w-min` CSS collapse level (≤320px)

**File**: `sidebar/sidebar.css` (baru: 35 rules)

35 rules baru untuk class `.popup.w-min` yang mengurangi padding, font-size, dan gap di seluruh komponen sidebar:

- **Header**: logo 27px (dari 30px), brand-t 11.5px (dari 13.5px), iconbtn 27px (dari 30px)
- **Command bar**: height 34px (dari 38px), font 12px (dari 13px)
- **Strip bar**: padding 6px 9px (dari 7px 10px), font 10px (dari 11px)
- **Tiles**: font 9.5px (dari 10px), padding 7px 1px (dari 8px 1px)
- **Notes bar**: padding 6px 9px, font 10px, action btn padding 5px 7px
- **Tab bar**: padding 5px 5px 6px, font 9.5px, gap 1px
- **Notes cards**: padding 7px 8px, title 11.5px, body 11px
- **Items vault**: padding 7px 8px, item-ic 29px, title 11.5px
- **Page header/body**: padding 9px 9px, title 12px
- **Tools grid**: gap 6px, tool padding 9px 9px, tool-ic 29px

Values dipilih sebagai **intermediate** antara `w-sm` (default) dan `w-xs` (≤280px) — kompak tapi tidak ekstrem seperti `w-xs` yang sudah icon-only.

### 2. MEDIUM — Update popup.js width-class trigger

**File**: `popup/popup.js:8592-8595`

Tambah trigger untuk `w-min` class:

```js
// Sebelum v3.20.8:
popup.classList.toggle('w-sm', w <= 360);
popup.classList.toggle('w-xs', w <= 280);
popup.classList.toggle('w-xxs', w <= 220);

// v3.20.8:
popup.classList.toggle('w-sm', w <= 360);
popup.classList.toggle('w-min', w <= 320);  // NEW: Chrome Side Panel minimum
popup.classList.toggle('w-xs', w <= 280);
popup.classList.toggle('w-xxs', w <= 220);
```

`w-min` aktif di range 281-320px. Pada Chrome minimum width (~300px), `w-min` akan aktif (karena 300 ≤ 320), tetapi `w-xs` tidak (karena 300 > 280). Pada Firefox, jika user drag sidebar sampai ≤280px, `w-xs` akan aktif dan override `w-min` (CSS cascade: `w-xs` rules lebih specific atau dideklarasikan setelah `w-min` di file).

## Verifikasi

### CSS structure check:
- Brace balance: 181 open / 181 close ✓
- 35 new `.popup.w-min` rules ditambahkan
- Rules dideklarasikan SETELAH `w-sm` dan SEBELUM `w-xs` (urutan cascade correct)

### Behavior matrix:

| Width | Firefox sidebar | Chrome Side Panel | Class aktif |
|-------|----------------|-------------------|-------------|
| >360px | normal | normal | (none) |
| 321-360px | w-sm | w-sm | w-sm |
| 281-320px | w-sm + w-min | w-sm + w-min (Chrome min ~300px) | w-sm, w-min |
| 221-280px | w-sm + w-min + w-xs | (tidak tercapai di Chrome) | w-sm, w-min, w-xs |
| ≤220px | w-sm + w-min + w-xs + w-xxs | (tidak tercapai di Chrome) | w-sm, w-min, w-xs, w-xxs |

**Catatan:** Di Chrome, sidebar tidak akan pernah menyempit di bawah ~300px, jadi `w-xs` dan `w-xxs` tidak akan pernah aktif di Chrome. Tapi rules tetap dipertahankan untuk kompatibilitasFirefox (dan jika Chrome di masa depan mengizinkan narrower sidebar).

## File yang berubah

| File | Perubahan |
|---|---|
| `manifest.json` | version bump 3.20.7 → 3.20.8 |
| `sidebar/sidebar.css` | + 35 rules baru untuk `.popup.w-min` (≤320px collapse level) |
| `popup/popup.js` | + 1 line: `popup.classList.toggle('w-min', w <= 320);` |

## Kompatibilitas

- **Chrome MV3**: ✓ (tidak ada API baru yang dipakai — pure CSS + classList)
- **Firefox MV3**: ✓ (`w-min` rules juga aktif di Firefox jika sidebar dikecilkan ke 281-320px, memberikan collapse intermediate sebelum `w-xs` aktif)
- **CSS cascade**: `w-min` dideklarasikan setelah `w-sm` (lebih specific) dan sebelum `w-xs` (less specific). Saat `w-xs` aktif, rules-nya override `w-min` jika ada konflik.

## Testing checklist (manual, di Chrome)

- [ ] Load unpacked dari `chrome://extensions` → extension jalan tanpa error.
- [ ] Buka sidebar RecallFox (klik toolbar icon atau via popup tombol sidebar).
- [ ] Drag sidebar ke kanan sampai mentok (minimum width ~300px).
- [ ] **Visual check**: Pada minimum width, sidebar harus terlihat kompak (tidak "terlalu lebar"):
  - Header: logo 27px, brand text 11.5px, icon buttons 27px
  - Tab bar: padding kecil, text "Catatan / Vault / Alat" terlihat (tidak icon-only)
  - Notes list: cards padding 7px 8px, title 11.5px
  - Command bar: height 34px, font 12px
- [ ] Buka DevTools → Elements → inspect `#popup` → pastikan class `w-sm w-min` ada (bukan `w-xs`).
- [ ] Drag sidebar lebih lebar (>320px) → class `w-min` hilang, hanya `w-sm` (atau none) yang tersisa.
- [ ] Verify tidak ada layout breakage: tiles, notes, vault items, page-header semua masih rapi.

## Catatan untuk Firefox addon

Perubahan ini **kompatibel** dengan Firefox — `w-min` rules akan aktif di Firefox juga jika sidebar dikecilkan ke 281-320px, memberikan intermediate collapse level. Tidak ada konflik dengan `w-xs`/`w-xxs` rules yang sudah ada.

Firefox sudah bisa dikecilkan sampai ~200px+ sehingga `w-xs`/`w-xxs` aktif, tapi `w-min` memberikan transition yang lebih halus antara `w-sm` (default) dan `w-xs` (sangat sempit).

Saran: port `w-min` rules ke Firefox `sidebar/sidebar.css` juga untuk konsistensi. Tidak urgent karena Firefox sudah punya `w-xs` yang aktif di ≤280px.
