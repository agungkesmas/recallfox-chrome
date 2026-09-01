# v3.24.6 — Modal Screenshot: Tombol Unduh Pindah ke Atas

## Masalah
Di modal "Screenshot diambil", tombol **Simpan PDF / Simpan JPG / Simpan PNG** berada di
baris paling bawah (footer), di bawah preview gambar yang besar. Untuk mendownload, user
harus melewati/menscroll preview dulu — jauh dari field "Nama file" yang baru saja diisi.
Permintaan user: *"tombol yang saya kotaki merah ini pindah ke posisi atas di bawah rename
agar mudah menjangkaunya ketika mau mendownload"*.

## Solusi
- **Zona unduh naik ke puncak modal**: blok `.rf-capture-modal-actions-primary`
  (Simpan PDF / Simpan JPG / Simpan PNG) dipindah dari footer ke dalam body —
  **tepat di bawah field "📝 Nama file"**, sebelum preview gambar.
  Alur baru: rename → klik unduh, semua dalam satu pandangan tanpa scroll.
- **Grid 3 kolom + kartu violet lembut** (`#f5f3ff`, border `#ddd6fe`): tombol jadi
  besar, sejajar rapi, dan jelas terbaca sebagai aksi utama modal.
- **Aksi sekunder tetap di footer bawah**: Anotasi · Salin Gambar · Salin + Keterangan ·
  Simpan ke Vault · Batal. Footer kini hanya berisi ghost buttons (rata kiri).
- Semua `data-action` tidak berubah — handler simpan/anotasi/enter-on-filename
  (Enter di input nama = Simpan PNG) bekerja persis seperti sebelumnya.

## Paritas
- `content/overlay.css` **md5-identik** antar repo Chrome & Firefox.
- `content/overlay.js` hanya berbeda di komentar FF lama (v3.22.4 shim) — blok modal identik.
- PWA (recallfox-pwa v1.15.2) menerapkan desain yang sama: baris unduh **⬇️ Simpan JPG /
  ⬇️ Simpan PNG** di puncak modal viewer Media (di bawah header judul/rename, sebelum
  gambar). JPG/PNG yang relevan untuk PWA; PDF tetap fitur addon.

## Validasi
- `node --check content/overlay.js` lolos kedua repo.
- Uji visual headless (Playwright, replica markup+CSS asli, 744×813 = ukuran screenshot
  user): tombol unduh tampil di bawah field nama file, di atas preview, tanpa scroll;
  footer berisi aksi sekunder. (`scripts/modal_test_3246.js`)
- Regresi: tidak ada perubahan logika — murni pemindahan DOM + CSS.
