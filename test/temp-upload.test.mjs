// test/temp-upload.test.mjs — v3.24.12: Upload file sementara (dual destination)
// Uji: durasi map, expiry math, label countdown, isTempItem/isTempExpired,
// routing upload + LIVE upload ke litterbox (jaringan) + roundtrip isi file.
// Jalankan: node test/temp-upload.test.mjs

import {
  TEMP_DURATIONS,
  TEMP_UPLOAD_ENDPOINT,
  TEMP_HOST_MANUAL,
  MANUAL_TEMP_DURATION,
  MANUAL_SITES,
  MANUAL_SITES_MAX,
  sanitizeManualSites,
  manualSiteHost,
  tempDurationById,
  tempExpiresAt,
  isTempItem,
  isTempExpired,
  tempRemainingLabel,
  uploadToTempHost
} from '../lib/temp-upload.js';

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

console.log('— Durasi & expiry math —');
ok(TEMP_DURATIONS.length === 4, '4 durasi tersedia (1h/12h/24h/72h)');
ok(TEMP_DURATIONS.map(d => d.id).join(',') === '1h,12h,24h,72h', 'id durasi = 1h,12h,24h,72h');
ok(TEMP_DURATIONS.every(d => d.ms === { '1h': 3600e3, '12h': 43200e3, '24h': 86400e3, '72h': 259200e3 }[d.id]), 'ms durasi benar');
ok(tempDurationById('24h')?.time === '24h', 'tempDurationById 24h → time API 24h');
ok(tempDurationById('99x') === null, 'durasi invalid → null');
const t0 = 1757000000000;
ok(tempExpiresAt('1h', t0) === new Date(t0 + 3600e3).toISOString(), 'tempExpiresAt 1h = now+60m');
ok(tempExpiresAt('72h', t0) === new Date(t0 + 259200e3).toISOString(), 'tempExpiresAt 72h (3 hari) = now+72j');
ok(tempExpiresAt('bad', t0) === null, 'durasi invalid → expiresAt null');
ok(TEMP_UPLOAD_ENDPOINT.startsWith('https://litterbox.catbox.moe/'), 'endpoint litterbox HTTPS');

console.log('— isTempItem / isTempExpired —');
const mk = (src) => ({ id: 'x', type: 'file', source: src });
ok(!isTempItem(mk({ kind: 'zip' })), 'file biasa bukan temp item');
ok(!isTempItem(mk({ tempHost: 'litterbox' })), 'tempHost tanpa tempUrl → bukan temp item valid');
ok(isTempItem(mk({ tempHost: 'litterbox', tempUrl: 'https://litter.catbox.moe/a.zip' })), 'tempHost+tempUrl → temp item');
ok(isTempExpired(mk({ tempHost: 'litterbox', tempUrl: 'u', tempExpiresAt: new Date(Date.now() - 1000).toISOString() })), 'expiredAt lewat → expired');

console.log('— v3.24.18: tujuan MANUAL (paritas PWA v1.21.0) —');
ok(TEMP_HOST_MANUAL === 'manual', "TEMP_HOST_MANUAL === 'manual'");
ok(MANUAL_TEMP_DURATION === '72h', "MANUAL_TEMP_DURATION === '72h' (default 3 hari vault)");
ok(Array.isArray(MANUAL_SITES) && MANUAL_SITES.length === 10, 'MANUAL_SITES: 10 situs default (v3.24.24, riset live 2026-09-12)');
ok(MANUAL_SITES.every(s => typeof s.label === 'string' && s.label.length > 0), 'setiap situs punya label');
ok(MANUAL_SITES.every(s => /^https:\/\//.test(s.url)), 'setiap situs URL https (bisa diklik buka tab baru)');
// v3.24.24: riset ulang (uji curl live 18 kandidat) — gofile KEMBALI (permintaan
// user; multi-node check 200; alur manual aman), plus 5 situs baru: filebin,
// uguu, x0.at, pixeldrain, storage.to. Mati & tetap ditolak: transfer.sh /
// bashupload.com (DNS mati), 0x0.st (flaky), file.io (sekali unduh).
ok(MANUAL_SITES[0].url.includes('gofile.io'), 'gofile.io KEMBALI di urutan pertama daftar default (v3.24.24)');
ok(MANUAL_SITES.every(s => typeof s.note === 'string' && s.note.length > 0 && s.note.length <= 100), 'setiap situs punya note ≤100 char (lolos sanitasi)');
for (const h of ['litterbox.catbox.moe', 'tmpfiles.org', 'filebin.net', 'temp.sh', 'uguu.se', 'x0.at', 'pixeldrain.com', 'storage.to', 'catbox.moe']) {
  ok(MANUAL_SITES.some(s => { try { return new URL(s.url).hostname === h; } catch (e) { return false; } }), h + ' ada dalam daftar default');
}
ok(MANUAL_SITES.every(s => { try { return !['0x0.st', 'file.io', 'www.file.io', 'transfer.sh', 'bashupload.com', 'fileconvoy.com'].includes(new URL(s.url).hostname); } catch (e) { return false; } }), 'situs mati/ditolak (transfer.sh/bashupload/0x0.st/file.io) tidak ada dalam daftar');
ok(new Set(MANUAL_SITES.map(s => s.url.replace(/\/+$/, '').toLowerCase())).size === MANUAL_SITES.length, 'tidak ada URL duplikat di default');
ok(typeof MANUAL_SITES_MAX === 'number' && MANUAL_SITES_MAX === 12, 'MANUAL_SITES_MAX = 12');

console.log('— v3.24.19: daftar situs dikelola user (sanitizeManualSites) —');
ok(Array.isArray(sanitizeManualSites(null)) && sanitizeManualSites(null).length === 0, 'null → array kosong');
ok(Array.isArray(sanitizeManualSites('x')) && sanitizeManualSites('x').length === 0, 'bukan array → array kosong');
ok(sanitizeManualSites([{ label: 'A', url: 'https://a.example.com/' }]).length === 1, 'entri valid diterima');
ok(sanitizeManualSites([{ label: '  Spasi  ', url: '  https://b.example.com  ' }])[0].label === 'Spasi', 'label di-trim');
ok(sanitizeManualSites([{ label: 'A', url: 'http://a.example.com/' }]).length === 0, 'url http:// DITOLAK');
ok(sanitizeManualSites([{ label: '', url: 'https://a.example.com/' }]).length === 0, 'label kosong DITOLAK');
ok(sanitizeManualSites([{ url: 'https://a.example.com/' }]).length === 0, 'tanpa label DITOLAK');
ok(sanitizeManualSites([{ label: 'A', url: 'https://a.example.com/' }, { label: 'B', url: 'https://a.example.com' }]).length === 1, 'dedupe URL (beda garis miring ekor)');
ok(sanitizeManualSites([{ label: 'A', url: 'https://A.example.COM/x' }, { label: 'B', url: 'https://a.example.com/x' }]).length === 1, 'dedupe URL case-insensitive');
ok(sanitizeManualSites([{ label: 'A', url: 'https://a.example.com/' }, null, 'x', 42, { label: 'B', url: 'ftp://b.example.com/' }, {}]).length === 1, 'entri sampah/bukan objek dilewati tanpa error');
const many = Array.from({ length: 20 }, (_, i) => ({ label: 'S' + i, url: 'https://s' + i + '.example.com/' }));
ok(sanitizeManualSites(many).length === MANUAL_SITES_MAX, 'cap maks ' + MANUAL_SITES_MAX + ' situs (input 20 → ' + MANUAL_SITES_MAX + ')');
ok(sanitizeManualSites(many)[0].label === 'S0', 'cap mengambil entri PERTAMA (urutan stabil)');
const longLbl = 'x'.repeat(50);
ok(sanitizeManualSites([{ label: longLbl, url: 'https://c.example.com/' }])[0].label.length === 40, 'label dipotong 40 char');
ok(sanitizeManualSites([{ label: 'A', url: 'https://c.example.com/', note: '  n  ' }])[0].note === 'n', 'note di-trim');
ok(sanitizeManualSites([{ label: 'A', url: 'https://c.example.com/', note: 123 }])[0].note === '', 'note bukan string → kosong (defensive)');
ok(manualSiteHost('https://temp.sh/AbCd/file.txt') === 'temp.sh', 'manualSiteHost: hostname benar');
ok(manualSiteHost('bukan url') === '', 'manualSiteHost: URL invalid → string kosong (tanpa throw)');
const mExp = tempExpiresAt(MANUAL_TEMP_DURATION, t0);
ok(mExp === new Date(t0 + 259200e3).toISOString(), 'tempExpiresAt(MANUAL_TEMP_DURATION) = +72 jam (3 hari vault)');
const manualItem = mk({ tempHost: TEMP_HOST_MANUAL, tempUrl: 'https://litter.catbox.moe/manual.zip', tempExpiresAt: mExp, tempDuration: MANUAL_TEMP_DURATION });
ok(isTempItem(manualItem), 'item manual → isTempItem TRUE (badge + cleanup + sync jalan tanpa perubahan sisi baca)');
ok(isTempExpired(manualItem, t0 + 259200e3 + 1) === true, 'item manual expired tepat 72 jam setelah masuk vault');
ok(isTempExpired(manualItem, t0 + 259199e3) === false, 'item manual BELUM expired sebelum 72 jam');
ok(!isTempExpired(mk({ tempHost: 'litterbox', tempUrl: 'u', tempExpiresAt: new Date(Date.now() + 3600e3).toISOString() })), 'expiredAt masa depan → tidak expired');
ok(!isTempExpired(mk({ kind: 'pdf' })), 'file biasa tidak pernah expired');
ok(!isTempExpired(mk({ tempHost: 'litterbox', tempUrl: 'u', tempExpiresAt: 'not-a-date' })), 'expiredAt invalid → tidak dianggap expired (defensive)');

console.log('— Label countdown —');
const now = Date.now();
ok(tempRemainingLabel(new Date(now - 60e3).toISOString(), now) === 'kedaluwarsa', 'lewat → "kedaluwarsa"');
ok(tempRemainingLabel(new Date(now + 45 * 60e3).toISOString(), now) === '45m', '45 menit → "45m"');
ok(tempRemainingLabel(new Date(now + 2 * 3600e3 + 15 * 60e3).toISOString(), now) === '2j 15m', '2j15m → "2j 15m"');
ok(tempRemainingLabel(new Date(now + 3 * 86400e3).toISOString(), now) === '3h', '3 hari → "3h"');
ok(tempRemainingLabel(new Date(now + 3 * 86400e3 + 5 * 3600e3).toISOString(), now) === '3h 5j', '3h5j → "3h 5j"');
ok(tempRemainingLabel(null, now) === '', 'null → string kosong');
ok(tempRemainingLabel('abc', now) === '', 'invalid → string kosong');
ok(tempRemainingLabel(new Date(now + 59e3).toISOString(), now) === '1m', '59 detik → minimum "1m"');

console.log('— uploadToTempHost (mock fetch) —');
{
  const fake = { ok: true, text: async () => 'https://litter.catbox.moe/abc123.zip' };
  const r = await uploadToTempHost(new Blob(["x"]), 'a.zip', '24h', { fetchImpl: async () => fake });
  ok(r.ok === true && r.url === 'https://litter.catbox.moe/abc123.zip', 'mock sukses → ok+url');
  ok(r.host === 'litterbox' && r.duration === '24h', 'host+duration terisi');
  ok(typeof r.expiresAt === 'string' && !Number.isNaN(new Date(r.expiresAt).getTime()), 'expiresAt ISO valid');
}
{
  // v3.24.16: 500 di-retry 3x (sleep instan di test) — tetap gagal → http_500
  let calls = 0;
  const r = await uploadToTempHost(new Blob(["x"]), 'a.zip', '24h', {
    sleepImpl: async () => {},
    fetchImpl: async () => { calls++; return { ok: false, status: 500, text: async () => '' }; }
  });
  ok(r.ok === false && r.error === 'http_500', 'HTTP 500 tanpa body → error http_500');
  ok(calls === 3 && r.attempts === 3, 'HTTP 500 di-retry 3x');
}
{
  // v3.24.17: body error server ditangkap (diagnosis kasus user)
  const r = await uploadToTempHost(new Blob(["x"]), 'a.zip', '24h', {
    sleepImpl: async () => {},
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'rate limited, slow down' })
  });
  ok(r.ok === false && r.error === 'http_500: rate limited, slow down', 'body error server ikut di error');
}
{
  const r = await uploadToTempHost(new Blob(["x"]), 'a.zip', '24h', { sleepImpl: async () => {}, fetchImpl: async () => { throw new Error('offline'); } });
  ok(r.ok === false && r.error.startsWith('network:'), 'fetch throw → error network');
}
{
  // v3.24.16: 500, 500, lalu 200 → sukses (inilah kasus laporan user)
  let calls = 0;
  const r = await uploadToTempHost(new Blob(["x"]), 'a.zip', '24h', {
    sleepImpl: async () => {},
    fetchImpl: async () => { calls++; return calls < 3 ? { ok: false, status: 500, text: async () => 'x' } : { ok: true, text: async () => 'https://litter.catbox.moe/ok.zip' }; }
  });
  ok(r.ok === true && r.url === 'https://litter.catbox.moe/ok.zip' && calls === 3, 'flaky 500,500,200 → sukses di percobaan 3');
}
{
  // v3.24.16: 400 TIDAK di-retry (kesalahan request, bukan server)
  let calls = 0;
  const r = await uploadToTempHost(new Blob(["x"]), 'a.zip', '24h', {
    sleepImpl: async () => {},
    fetchImpl: async () => { calls++; return { ok: false, status: 400, text: async () => 'bad' }; }
  });
  ok(r.ok === false && r.error.startsWith('http_400') && calls === 1, 'HTTP 400 → 1x percobaan, tanpa retry');
}
{
  // v3.24.16: jeda backoff 1s/2s/4s dipakai berurutan
  const waits = [];
  let calls = 0;
  await uploadToTempHost(new Blob(["x"]), 'a.zip', '24h', {
    sleepImpl: async (ms) => { waits.push(ms); },
    fetchImpl: async () => { calls++; return { ok: false, status: 503, text: async () => 'x' }; }
  });
  ok(calls === 3 && JSON.stringify(waits) === '[1000,2000]', 'backoff 1s lalu 2s (tanpa tunggu ke-3)');
}
{
  const r = await uploadToTempHost(new Blob(["x"]), 'a.zip', '24h', { fetchImpl: async () => ({ ok: true, text: async () => '<html>oops</html>' }) });
  ok(r.ok === false && r.error.startsWith('unexpected_response'), 'respons bukan URL litterbox → ditolak');
}
{
  const r = await uploadToTempHost(new Blob(["x"]), 'a.zip', '1x', {});
  ok(r.ok === false && r.error === 'invalid_duration', 'durasi invalid ditolak sebelum fetch');
}
{
  const r = await uploadToTempHost({ size: 0 }, 'a.zip', '1h', {});
  ok(r.ok === false && r.error === 'empty_blob', 'blob kosong ditolak sebelum fetch');
}
{
  // Verifikasi FormData yang dikirim: reqtype, time, filename
  let captured = null;
  class FakeFD {
    constructor() { this.entries = []; }
    append(k, v, name) { this.entries.push([k, v, name]); }
  }
  await uploadToTempHost(new Blob(["xy"]), 'laporan final.zip', '12h', {
    formDataImpl: FakeFD,
    fetchImpl: async (_url, opts) => { captured = opts.body; return { ok: true, text: async () => 'https://litter.catbox.moe/x.zip' }; }
  });
  const get = (k) => captured.entries.find(e => e[0] === k);
  ok(get('reqtype')[1] === 'fileupload', 'FormData reqtype=fileupload');
  ok(get('time')[1] === '12h', 'FormData time=12h');
  ok(get('fileToUpload')[2] === 'laporan final.zip', 'filename fileToUpload dipertahankan');
}

console.log('— LIVE: upload ke litterbox (jaringan) —');
if (process.env.RF_SKIP_LIVE === '1') {
  console.log('  (dilewati — RF_SKIP_LIVE=1)');
} else {
  try {
    const content = 'recallfox temp-upload live test ' + Date.now();
    const blob = new Blob([content], { type: 'text/plain' });
    const up = await uploadToTempHost(blob, 'rf-live-test.txt', '1h');
    ok(up.ok === true, 'upload live OK → ' + (up.url || up.error));
    if (up.ok) {
      ok(/^https:\/\/litter\.catbox\.moe\/\S+$/.test(up.url), 'URL live sesuai pola litter.catbox.moe');
      ok(up.url.endsWith('.txt'), 'URL live mempertahankan ekstensi file (litterbox: id acak + .ext)');
      // Roundtrip: unduh balik — harus file mentah dengan isi identik (bukan HTML ala temp.sh)
      const res = await fetch(up.url);
      const body = await res.text();
      ok(res.ok && body === content, 'roundtrip isi file identik (file mentah, bukan HTML)');
    }
  } catch (e) {
    fail++; console.error('  ✗ live upload exception: ' + e.message);
  }
}

console.log('\nHasil: ' + pass + ' PASS, ' + fail + ' FAIL');
process.exit(fail > 0 ? 1 : 0);
