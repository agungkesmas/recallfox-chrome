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
// Modul PURE + testable di Node (fetch/FormData/Blob global Node 18+).
// ===================================================================

export const TEMP_HOST_ID = 'litterbox';
export const TEMP_HOST_LABEL = 'litterbox (catbox.moe)';
export const TEMP_UPLOAD_ENDPOINT =
  'https://litterbox.catbox.moe/resources/internals/api.php';

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
 *   { ok: true,  url, host, expiresAt, duration } | { ok: false, error }
 *
 * deps: injeksi untuk test (default: globalThis) — { fetchImpl, formDataImpl }
 */
export async function uploadToTempHost(blob, fileName, durationId, deps = {}) {
  const dur = tempDurationById(durationId);
  if (!dur) return { ok: false, error: 'invalid_duration' };
  if (!blob || !blob.size) return { ok: false, error: 'empty_blob' };
  const _fetch = deps.fetchImpl || globalThis.fetch;
  const _FormData = deps.formDataImpl || globalThis.FormData;
  if (!_fetch || !_FormData) return { ok: false, error: 'no_fetch_or_formdata' };

  const safeName = (fileName || 'file.bin').replace(/[\r\n"\\]/g, '_').slice(0, 180);
  const fd = new _FormData();
  fd.append('reqtype', 'fileupload');
  fd.append('time', dur.time);
  fd.append('fileToUpload', blob, safeName);

  let res;
  try {
    res = await _fetch(TEMP_UPLOAD_ENDPOINT, { method: 'POST', body: fd });
  } catch (e) {
    return { ok: false, error: 'network: ' + (e && e.message ? e.message : 'unknown') };
  }
  if (!res || !res.ok) {
    return { ok: false, error: 'http_' + (res ? res.status : 'no_response') };
  }
  let text = '';
  try { text = (await res.text() || '').trim(); } catch (e) {
    return { ok: false, error: 'read_response_failed' };
  }
  // Respons litterbox = URL teks polos. Validasi ketat: harus URL host
  // litter/catbox — kalau server balas error/HTML, jangan pakai.
  if (!/^https:\/\/(litter\.)?catbox\.moe\//.test(text) || /\s/.test(text)) {
    return { ok: false, error: 'unexpected_response: ' + text.slice(0, 120) };
  }
  return {
    ok: true,
    url: text,
    host: TEMP_HOST_ID,
    duration: dur.id,
    expiresAt: tempExpiresAt(dur.id)
  };
}
