# CHANGELOG v3.22.5-chrome

Tanggal: 2026-08-30

## Audit Orphan (bersih-bersih tanpa perubahan fungsi)

- HAPUS `ff.zip` (816 KB) — paket Firefox build lama yang tertinggal di root
  repo Chrome. Tidak dirujuk manifest/HTML/JS sama sekali; membengkakkan repo
  dan paket publikasi.
- HAPUS `icons/icon-16.svg`, `icon-32.svg`, `icon-48.svg`, `icon-96.svg`,
  `icon-128.svg` — ikon SVG tidak pernah dirujuk (manifest & kode memakai PNG).
- Manifest `version` dinaikkan ke `3.22.5` (penomoran sejajar dengan
  `v3.22.5-firefox`).
- TIDAK ada satu baris kode pun diubah — semua fitur identik dengan 3.22.3.

## Metode audit

- Graf referensi penuh: manifest (content_scripts, background, WAR, action,
  icons, options_ui, side_panel) + seluruh HTML/JS (getURL, import, path).
- Semua file runtime (content/, lib/, popup/, settings/, sidebar/,
  contentguard/, assets/, _locales/, icons/*.png) terverifikasi terpakai.
- `_locales/*/messages.json` dipertahankan (dipakai `__MSG_extName__` /
  `default_locale`).
- changelogs/, docs/, test/ adalah aset repo (dokumentasi/dev), tidak ikut
  memengaruhi runtime ekstensi; dipertahankan di repo.
