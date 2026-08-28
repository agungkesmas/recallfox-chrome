# v3.20.1 — Modal rename auto-select (screenshot + semua rename)

> **Tanggal:** 2026-07-29
> **Tipe:** Fix UX
> **Tag:** `v3.20.1`, `v3.20.1-stable`

## Ringkasan

Semua modal yang berhubungan dengan rename / nama file sekarang **auto-select teks
saat modal dibuka** — user langsung bisa ketik untuk menimpa nama default, tanpa
perlu blok manual + delete.

## Perubahan

### 1. Screenshot capture modal (`content/overlay.js`)
- **SEBELUM:** Modal capture tidak punya input filename. Nama file auto-generated
  dari page title + timestamp (`${safeName}_${ts}.pdf`), user tidak bisa edit.
- **SESUDAH:** Tambah input **"Nama file"** di atas preview. Default value =
  `${safeName}_${ts}` (sama seperti dulu), tapi langsung ter-**focus + select-all**
  saat modal muncul → user bisa langsung ketik untuk timpa.
- Ekstensi (`.pdf` / `.jpg` / `.png`) ditambahkan otomatis sesuai tombol simpan
  yang dipilih.
- Enter pada input = trigger save PNG (paling umum dipakai).
- Tombol **"Simpan ke Vault"** sekarang pakai filename dari input sebagai title
  vault item (lebih meaningful daripada "pageTitle — modeLabel").
- Helper baru: `escapeHtmlAttr()`, `sanitizeFileName()`.

### 2. Background handler `saveCaptureToVault` (`background.js`)
- Tambah dukungan `payload.title` (opsional). Kalau ada, dipakai sebagai vault
  item title. Fallback ke default lama (`pageTitle — modeLabel`).

### 3. Snapshot modal (`content/content.js`)
- **SEBELUM:** Title input hanya `.focus()` saat modal dibuka — teks tidak
  terblok.
- **SESUDAH:** `.focus()` + `.select()` — nama default (judul halaman) langsung
  terblok, bisa langsung ditimpa.

### 4. Vault item edit sheet (`popup/popup.js` line ~4084)
- **SEBELUM:** Title input `#fTitle` hanya `.focus()`.
- **SESUDAH:** Kalau lagi **edit existing item** (bukan create new), tambah
  `.select()` supaya judul lama langsung terblok.

### 5. Vault item viewer in-place edit (`popup/popup.js` line ~2481)
- Tidak berubah — sudah benar dari v3.14.5 (sudah pakai `focus() + select()`).

## Modal yang sekarang sudah auto-select

| Lokasi | File | Behavior |
|---|---|---|
| Screenshot capture modal | `content/overlay.js` | ✅ focus + select on open |
| Snapshot AI modal | `content/content.js` | ✅ focus + select on open |
| Vault item edit sheet | `popup/popup.js` | ✅ focus + select on open (existing item) |
| Vault item viewer inline edit | `popup/popup.js` | ✅ (sudah benar sebelumnya) |

## Catatan teknis

- `prompt()` native browser (folder rename, group name, passphrase) sengaja
  **tidak diubah** karena `prompt()` di Firefox & Chrome sudah auto-select teks
  default-nya saat dibuka — behavior-nya sudah memenuhi requirement user.
- Auto-select dijalankan via `setTimeout(..., 80–120ms)` supaya DOM sudah
  ter-render & animasi modal selesai sebelum `focus()` dipanggil (kalau tidak
  di-delay, `focus()` bisa di-cancel oleh animasi CSS).

## Test plan

- [ ] Buka halaman apapun → Alt+Shift+5 (capture-page) → modal muncul → nama
      default terblok → ketik "laporan-test" → klik "Simpan PDF" → file
      tersimpan sebagai `laporan-test.pdf` di folder Downloads.
- [ ] Buka halaman AI → klik Snapshot → modal muncul → judul halaman terblok →
      ketik judul baru → Simpan.
- [ ] Buka popup → klik vault item → klik ✏️ → judul lama terblok → ketik
      judul baru → Simpan.
