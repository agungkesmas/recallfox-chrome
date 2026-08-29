// lib/dataurl.js — Helper Blob/bytes → data: URL untuk lingkungan ServiceWorker
// RecallFox v3.22.6
//
// Chrome MV3 background = ServiceWorkerGlobalScope: URL.createObjectURL() TIDAK
// tersedia (blob: URL butuh konteks dokumen). Semua alur download yang semula
// memakai blob URL kini memakai data: URL — didukung chrome.downloads.download
// di Chrome maupun Firefox, tanpa perlu revoke.

/**
 * Blob → data: URL (base64) tanpa FileReader (tidak ada di SW).
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export async function blobToDataUrl(blob) {
  const buf = await blob.arrayBuffer();
  return `data:${blob.type || 'application/octet-stream'};base64,${bytesToBase64(new Uint8Array(buf))}`;
}

/**
 * Uint8Array → base64 (chunked, aman untuk argumen apply).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
