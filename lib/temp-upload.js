// ===================================================================
// RecallFox — lib/temp-upload.js
// v3.24.12: UPLOAD FILE SEMENTARA (dual destination, Fase 1)
// ===================================================================
// Permintaan user: "fitur upload file bisa dua, 1. masuk ke
// database/supabase, 2. masuk ke situs upload file sementara seperti
// temp.sh atau lainnya ... untuk nomor 2 akan hilang sendiri di vault
// sesuai dengan batas waktu di situs upload sementaranya."
//
// Host yang dipakai: litterbox.catbox.moe (bukan temp.sh).
// Hasil audit 8 Sep 2026:
//   - temp.sh: endpoint upload OK (POST /upload → URL), TAPI URL-nya
//     TIDAK PERNAH serve file mentah — selalu HTML download page.
//     Akibatnya: fetch URL → HTML (zip/gambar corrupt), AI chat tidak
//     bisa membaca isi URL, pratinjau rusak. GAGAL syarat pakai.
//   - litterbox.catbox.moe: POST multipart (reqtype=fileupload,
//     time=1h|12h|24h|72h, fileToUpload) → URL teks polos
//     https://litter.catbox.moe/<id>.<ext> yang serve FILE MENTAH
//     (md5 roundtrip identik), Access-Control-Allow-Origin: * (PWA
//     bisa upload langsung), expiry server-side sesuai `time`.
//
// Model data item temp (disimpan di item.source — JSONB, sinkron
// otomatis ke cloud tanpa perubahan schema):
//   source.tempHost      : 'litterbox'
//   source.tempUrl       : URL publik file
//   source.tempExpiresAt : ISO timestamp kedaluwarsa (upload + durasi)
//   source.tempDuration  : '1h' | '12h' | '24h' | '72h'
//
// v3.24.19: catatan gofile.io → temp.sh — alur MANUAL berbeda dengan upload
// otomatis: di alur MANUAL user yang mengunggah lewat browsernya dan menempel
// URL halaman unduh, jadi "URL = halaman HTML" bukan masalah (item vault
// manual TIDAK pernah fetch isi file — body kosong, size 0).
//
// Modul PURE + testable di Node (fetch/FormData/Blob global Node 18+).
// ===================================================================

export const TEMP_HOST_ID = 'litterbox';
export const TEMP_HOST_LABEL = 'litterbox (catbox.moe)';
export const TEMP_UPLOAD_ENDPOINT =
  'https://litterbox.catbox.moe/resources/internals/api.php';

// v3.24.18: tujuan ketiga — MANUAL. User upload sendiri di situs luar (klik,
// tab baru), lalu tempel URL. Tidak ada upload otomatis, tidak ada retry.
// Vault manual selalu TTL 72 jam (3 hari) terlepas dari masa simpan situs —
// dihapus otomatis dari vault oleh cleanupExpiredTempItems yang sama.
// (Paritas 1:1 dengan PWA v1.21.0 yang sudah E2E 7/7.)
// v3.24.19: gofile.io KELUAR dari daftar (laporan user: sudah tidak bisa
// dipakai), diganti temp.sh. Catatan penting: temp.sh hanya untuk alur
// MANUAL (user buka situs, upload sendiri, tempel URL yang buka halaman
// unduh) — TETAP tidak dipakai uploadToTempHost otomatis karena URL-nya
// halaman HTML, bukan file mentah (lihat audit di atas).
export const TEMP_HOST_MANUAL = 'manual';
export const MANUAL_TEMP_DURATION = '72h';
// v3.24.19: daftar situs default terverifikasi via curl 2026-09-11:
// litterbox (raw, 1GB, 1–72 jam), catbox (raw, permanen, 200MB),
// temp.sh (POST /upload → halaman unduh, file hilang 3 hari — sinkron dgn
// TTL vault manual), tmpfiles (100MB, 7 hari).
// DAFTAR INI HANYA DEFAULT — user bisa mengelola sendiri (tambah/ubah/hapus)
// lewat tombol ✏️ Kelola di panel Manual; daftar pilihan user disimpan di
// storage lokal key 'recallfox_manual_sites' (addon: browser.storage.local,
// PWA: localStorage) dan divalidasi oleh sanitizeManualSites() di bawah.
export const MANUAL_SITES = [
  { label: 'litterbox.catbox.moe', url: 'https://litterbox.catbox.moe/', note: '1GB · 1–72 jam · link langsung' },
  { label: 'catbox.moe', url: 'https://catbox.moe/', note: '200MB · permanen · link langsung' },
  { label: 'temp.sh', url: 'https://temp.sh/', note: 'besar · file hilang 3 hari · unduh via tombol di halaman' },
  { label: 'tmpfiles.org', url: 'https://tmpfiles.org/', note: '100MB · 7 hari' }
];

// v3.24.19: pengelolaan daftar situs oleh user.
// MANUAL_SITES_MAX — batas jumlah situs (popup terbatas ruang; cegah overflow).
// sanitizeManualSites(raw) — fungsi MURNI (tanpa akses storage) yang membersihkan
// daftar apa pun dari storage jadi daftar valid: label 1–40 char, url wajib
// https:// maks 300 char, note maks 100 char, dedupe by URL (normalisasi:
// lowercase + tanpa garis miring ekor), maks MANUAL_SITES_MAX entri.
// Dipakai addon (popup.js) dan PWA (main.js) — paritas 1:1.
export const MANUAL_SITES_MAX = 12;

export function sanitizeManualSites(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const label = typeof r.label === 'string' ? r.label.trim().slice(0, 40) : '';
    const url = typeof r.url === 'string' ? r.url.trim().slice(0, 300) : '';
    const note = typeof r.note === 'string' ? r.note.trim().slice(0, 100) : '';
    if (!label || !/^https:\/\//i.test(url)) continue;
    const key = url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, url, note });
    if (out.length >= MANUAL_SITES_MAX) break;
  }
  return out;
}

// hostname dari URL (untuk tooltip/catatan situs kustom) — URL invalid → ''.
export function manualSiteHost(url) {
  try { return new URL(url).hostname || ''; } catch (e) { return ''; }
}

// Durasi yang tersedia di UI. `time` = parameter API litterbox.
// Litterbox hanya menerima 1h/12h/24h/72h — jangan tambah nilai lain.
export const TEMP_DURATIONS = [
  { id: '1h', label: '1 jam', time: '1h', ms: 1 * 3600 * 1000 },
  { id: '12h', label: '12 jam', time: '12h', ms: 12 * 3600 * 1000 },
  { id: '24h', label: '1 hari', time: '24h', ms: 24 * 3600 * 1000 },
  { id: '72h', label: '3 hari', time: '72h', ms: 72 * 3600 * 1000 }
];

export function tempDurationById(id) {
  return TEMP_DURATIONS.find(d => d.id === id) || null;
}

// ISO timestamp kedaluwarsa = saat upload + durasi.
export function tempExpiresAt(durationId, nowMs = Date.now()) {
  const d = tempDurationById(durationId);
  if (!d) return null;
  return new Date(nowMs + d.ms).toISOString();
}

// Item = file sementara? (punya tempHost + tempUrl di source)
export function isTempItem(item) {
  const src = item && item.source;
  return !!(src && src.tempHost && src.tempUrl);
}

// Item temp sudah kedaluwarsa? (non-temp selalu false)
export function isTempExpired(item, nowMs = Date.now()) {
  if (!isTempItem(item)) return false;
  const exp = item.source.tempExpiresAt;
  if (!exp) return false;
  const t = new Date(exp).getTime();
  if (!Number.isFinite(t)) return false;
  return t <= nowMs;
}

// Label countdown untuk badge — "2h 15m", "45m", "kedaluwarsa".
// Format pendek supaya muat di baris meta kartu vault.
export function tempRemainingLabel(expiresAtIso, nowMs = Date.now()) {
  if (!expiresAtIso) return '';
  const t = new Date(expiresAtIso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = t - nowMs;
  if (diff <= 0) return 'kedaluwarsa';
  const totalMin = Math.floor(diff / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return hours > 0 ? (days + 'h ' + hours + 'j') : (days + 'h');
  if (hours > 0) return mins > 0 ? (hours + 'j ' + mins + 'm') : (hours + 'j');
  return (totalMin > 0 ? totalMin : 1) + 'm';
}

/**
 * Upload satu file ke host sementara. Return:
 *   { ok: true,  url, host, expiresAt, duration, attempts } | { ok: false, error, attempts }
 *
 * deps: injeksi untuk test (default: globalThis) — { fetchImpl, formDataImpl, sleepImpl, maxAttempts, retryDelays }
 *
 * v3.24.16: RETRY otomatis — server litterbox terkenal HTTP 500 intermiten
 * (tercatat di status page pihak ketiga + 1x kena saat verifikasi v3.24.14;
 * laporan user: upload 137KB gagal http_500 padahal file & parameter valid —
 * reproduksi 8x via curl semuanya 200). Di-retry: network throw + HTTP 5xx
 * (maks 3x, jeda 1s/2s/4s). TIDAK di-retry: 4xx & respons non-URL (validasi —
 * retry tidak membantu). Sebelumnya: 1x percobaan, sekali 500 langsung gagal.
 */
export async function uploadToTempHost(blob, fileName, durationId, deps = {}) {
  const dur = tempDurationById(durationId);
  if (!dur) return { ok: false, error: 'invalid_duration', attempts: 0 };
  if (!blob || !blob.size) return { ok: false, error: 'empty_blob', attempts: 0 };
  const _fetch = deps.fetchImpl || globalThis.fetch;
  const _FormData = deps.formDataImpl || globalThis.FormData;
  const _sleep = deps.sleepImpl || ((ms) => new Promise((r) => setTimeout(r, ms)));
  if (!_fetch || !_FormData) return { ok: false, error: 'no_fetch_or_formdata', attempts: 0 };
  const maxAttempts = Number.isFinite(deps.maxAttempts) ? Math.max(1, deps.maxAttempts) : 3;
  const delays = Array.isArray(deps.retryDelays) ? deps.retryDelays : [1000, 2000, 4000];

  const safeName = (fileName || 'file.bin').replace(/[\r\n"\\]/g, '_').slice(0, 180);
  let lastError = 'unknown', attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    // FormData dirakit ulang tiap percobaan (body fetch tidak dipakai ulang).
    const fd = new _FormData();
    fd.append('reqtype', 'fileupload');
    fd.append('time', dur.time);
    fd.append('fileToUpload', blob, safeName);

    let res;
    try {
      res = await _fetch(TEMP_UPLOAD_ENDPOINT, { method: 'POST', body: fd });
    } catch (e) {
      lastError = 'network: ' + (e && e.message ? e.message : 'unknown');
      if (attempt < maxAttempts) await _sleep(delays[Math.min(attempt - 1, delays.length - 1)] || 0);
      continue;
    }
    if (!res || !res.ok) {
      const status = res ? res.status : 'no_response';
      // v3.24.17: baca body error server (best-effort) — litterbox kadang
      // menyertakan alasan ("file too large", dsb). Tanpa ini kita buta:
      // kasus user (zip 45KB, 500 3x) tak bisa direproduksi via curl.
      let note = '';
      try {
        const t = await res.text();
        if (t && t.trim()) note = t.trim().slice(0, 160);
      } catch (e) {}
      lastError = 'http_' + status + (note ? ': ' + note : '');
      const retryable = !res || (res.status >= 500 && res.status <= 599);
      if (retryable && attempt < maxAttempts) {
        await _sleep(delays[Math.min(attempt - 1, delays.length - 1)] || 0);
        continue;
      }
      return { ok: false, error: lastError, attempts };
    }
    let text = '';
    try { text = (await res.text() || '').trim(); } catch (e) {
      return { ok: false, error: 'read_response_failed', attempts };
    }
    // Respons litterbox = URL teks polos. Validasi ketat: harus URL host
    // litter/catbox — kalau server balas error/HTML, jangan pakai.
    if (!/^https:\/\/(litter\.)?catbox\.moe\//.test(text) || /\s/.test(text)) {
      return { ok: false, error: 'unexpected_response: ' + text.slice(0, 120), attempts };
    }
    return {
      ok: true,
      url: text,
      host: TEMP_HOST_ID,
      duration: dur.id,
      expiresAt: tempExpiresAt(dur.id),
      attempts
    };
  }
  return { ok: false, error: lastError, attempts };
}
