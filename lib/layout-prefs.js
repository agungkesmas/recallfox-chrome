// lib/layout-prefs.js — RecallFox v3.24.28
// "Susun Sesuai Selera" — penyimpanan preferensi urutan elemen UI.
//
// Laporan user (screenshot vault, 30 Sep): "apakah tombol-tombol yang saya
// kotaki itu bisa di klik lama kemudian diubah ubah urutannya, biar saya
// melakukan pengurutan sendiri sesuai preferensi. termasuk kalau bisa semua
// elemen di situ bisa di ubah ubah tata letaknya."
//
// Modul ini MURNI (tanpa DOM) supaya bisa di-uji unit di Node
// (scripts/test_layout_32428.mjs). Bagian DOM (engine drag) ada di popup.js
// dengan nama rfSortable*.
//
// Kontrak:
//   - loadUiOrder(storage, key)  → array<string> | null (JSON valid, buang sampah)
//   - saveUiOrder(storage, key, ids) → boolean (best-effort, tak pernah throw)
//   - mergeUiOrder(saved, current)   → current tersusun mengikuti saved;
//     id lama yang hilang dibuang, id baru (tidak dikenal) tetap di posisi
//     relatif aslinya di belakang. Aman terhadap chip/fitur baru di versi
//     mendatang maupun id yang sudah tidak ada.
//
// Storage yang dipakai: localStorage ekstensi (per perangkat — preferensi
// tata letak memang sifatnya per-layar, tidak ikut sync vault).

export const RF_LAYOUT_KEYS = Object.freeze({
  chips: 'rf-ui-chipOrder',          // chip filter vault (Semua/Terbaru/…)
  batch: 'rf-ui-batchOrder',         // tombol baris utama batch bar
  batchMore: 'rf-ui-batchMoreOrder', // tombol di menu ⋯ batch
  vaultActions: 'rf-ui-vaultActionOrder', // tombol baris aksi vault (Batch/Auto/…)
  home: 'rf-ui-homeOrder'            // urutan seksi Beranda (strip/pomodoro/tiles)
});

// Semua kunci sekaligus — untuk fitur "Atur ulang" di halaman Settings.
export const RF_LAYOUT_ALL_KEYS = Object.freeze(Object.values(RF_LAYOUT_KEYS));

/**
 * Baca urutan tersimpan. Mengembalikan null bila belum ada / rusak /
 * isinya kosong, sehingga pemanggil lanjut ke urutan bawaan.
 * @param {Storage-like} storage objek dengan getItem (localStorage / stub uji)
 * @param {string} key
 * @returns {string[]|null}
 */
export function loadUiOrder(storage, key) {
  try {
    const raw = storage && typeof storage.getItem === 'function' ? storage.getItem(key) : null;
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    const out = arr.filter(function (id) { return typeof id === 'string' && id.length > 0; });
    if (!out.length) return null;
    return Array.from(new Set(out)); // buang duplikat, jaga urutan pertama
  } catch (e) {
    return null;
  }
}

/**
 * Simpan urutan. Best-effort: kegagalan quota/privacy-mode dianggap non-fatal.
 * @param {Storage-like} storage
 * @param {string} key
 * @param {string[]} ids urutan id
 * @returns {boolean} true bila tersimpan
 */
export function saveUiOrder(storage, key, ids) {
  try {
    if (!storage || typeof storage.setItem !== 'function') return false;
    // ids bukan array → tolak (jangan timpa urutan tersimpan dengan sampah)
    if (!Array.isArray(ids)) return false;
    const arr = ids.filter(function (id) { return typeof id === 'string' && id.length > 0; });
    storage.setItem(key, JSON.stringify(arr));
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Susun `current` mengikuti urutan `saved`.
 * - id di saved yang masih ada di current → di depan, sesuai urutan saved.
 * - id current yang tidak ada di saved (chip/fitur baru) → di belakang,
 *   mempertahankan urutan relatif aslinya.
 * - id saved yang sudah tiada → diabaikan.
 * @param {string[]|null} saved
 * @param {string[]} current urutan bawaan saat ini
 * @returns {string[]}
 */
export function mergeUiOrder(saved, current) {
  const cur = Array.isArray(current)
    ? current.filter(function (x) { return typeof x === 'string' && x.length > 0; })
    : [];
  if (!Array.isArray(saved) || !saved.length) return cur.slice();
  const known = new Set(cur);
  const head = [];
  const seen = new Set();
  for (let i = 0; i < saved.length; i++) {
    const id = saved[i];
    if (typeof id !== 'string' || !id.length || seen.has(id) || !known.has(id)) continue;
    head.push(id);
    seen.add(id);
  }
  const tail = cur.filter(function (id) { return !seen.has(id); });
  return head.concat(tail);
}
