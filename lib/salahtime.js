// lib/salahtime.js — Prayer time fetcher (Aladhan API, Muhammadiyah method)
// RecallFox v0.4.0
//
// Inspired by github.com/najmulhuda/salah_time (ISC) — adapted to RecallFox
// architecture and using Muhammadiyah (Indonesia) calculation method.
//
// Muhammadiyah method (post-Munas Tarjih 2020):
//   - Fajr angle:  -18°  (changed from -20° in 2020)
//   - Isha angle:  -18°
//   - Asr:          Shafi'i (shadow length = object length + noon shadow)
//   - Dhuhr:        Sun transit (culmination)
//   - Maghrib:      Sunset
//
// Aladhan API: We use method=3 (Muslim World League, Fajr 18° Isha 17°) as base
// and override via methodSettings=18,18,0 to match Muhammadiyah exactly.
//
// API docs: https://aladhan.com/prayer-times-api
// Endpoint: GET https://api.aladhan.com/v1/timings/{DD-MM-YYYY}
//   ?latitude=...&longitude=...
//   &method=3
//   &methodSettings=18,18,0   (fajr, isha, maghrib angles)
//   &school=0                  (0 = Shafi, 1 = Hanafi for Asr)
//
// Public API:
//   fetchPrayerTimes(lat, lng, opts) → Promise<PrayerTimes>
//   reverseGeocode(lat, lng) → Promise<string>  (city/region name)
//   geocode(address) → Promise<{lat, lng, display}>
//
// PrayerTimes shape:
//   {
//     date:           ISO date string (YYYY-MM-DD),
//     hijri:          string (e.g. "15 Rajab 1446"),
//     timings: {
//       Fajr:    "HH:MM",
//       Sunrise: "HH:MM",
//       Dhuhr:   "HH:MM",
//       Asr:     "HH:MM",
//       Maghrib: "HH:MM",
//       Isha:    "HH:MM",
//       Imsak:   "HH:MM"
//     },
//     timezone:       string (e.g. "Asia/Jakarta"),
//     location:       string (geocoded display name, optional)
//   }

const ALADHAN_BASE = 'https://api.aladhan.com/v1/timings';
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';

// All HTTP requests must be done from background script (content scripts may
// hit CORS issues on some pages). This module is imported by background.js.

export async function fetchPrayerTimes(lat, lng, opts = {}) {
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    throw new Error('fetchPrayerTimes: lat/lng must be numbers');
  }
  // school: 0 = Shafi (default for Muhammadiyah/Indonesia), 1 = Hanafi
  const school = opts.school === 1 ? 1 : 0;
  // method=3 (MWL base) + methodSettings=18,18,0 = Muhammadiyah angles
  // (Fajr angle, Isha angle, Maghrib angle = 0 means use astronomical sunset)
  const method = 3;
  const methodSettings = '18,18,0';

  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  const datePath = `${dd}-${mm}-${yyyy}`;

  const url = `${ALADHAN_BASE}/${datePath}?latitude=${lat}&longitude=${lng}` +
              `&method=${method}&methodSettings=${methodSettings}&school=${school}`;

  console.log('[RecallFox] fetchPrayerTimes:', url);

  // 8-second timeout — prevents the sticky bar from hanging forever if
  // aladhan.com is slow or unreachable. AbortController cancels the fetch
  // and we throw a clear error that the caller can display to the user.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      throw new Error('Timeout: Aladhan API tidak merespons dalam 8 detik. Cek koneksi internet.');
    }
    throw new Error('Network error: ' + e.message);
  }
  clearTimeout(timeoutId);

  if (!res.ok) {
    throw new Error(`Aladhan API error: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  if (json.code !== 200 || !json.data) {
    throw new Error('Aladhan API: invalid response');
  }

  const data = json.data;
  const timings = data.timings || {};
  // Times come as "HH:MM (TZ)" — strip the timezone parens
  function cleanTime(t) {
    if (!t) return '--:--';
    return String(t).split(' ')[0].trim();
  }

  const hijri = data.date?.hijri;
  const hijriStr = hijri
    ? `${hijri.day} ${hijri.month?.en} ${hijri.year} AH`
    : '';

  return {
    date: now.toISOString().slice(0, 10),
    hijri: hijriStr,
    timings: {
      Fajr:    cleanTime(timings.Fajr),
      Sunrise: cleanTime(timings.Sunrise),
      Dhuhr:   cleanTime(timings.Dhuhr),
      Asr:     cleanTime(timings.Asr),
      Maghrib: cleanTime(timings.Maghrib),
      Isha:    cleanTime(timings.Isha),
      Imsak:   cleanTime(timings.Imsak),
      // Additional timings for sunnah prayers:
      Firstthird: cleanTime(timings.Firstthird),
      Lastthird:  cleanTime(timings.Lastthird),
      Midnight:   cleanTime(timings.Midnight)
    },
    timezone: data.meta?.timezone || '',
    method: 'Muhammadiyah (Fajr 18°, Isha 18°)'
  };
}

export async function reverseGeocode(lat, lng) {
  const url = `${NOMINATIM_BASE}/reverse?lat=${lat}&lon=${lng}&format=json&zoom=10&addressdetails=1`;
  try {
    const res = await fetch(url, {
      headers: { 'Accept-Language': 'id,en' }
    });
    if (!res.ok) throw new Error('reverseGeocode: ' + res.status);
    const data = await res.json();
    if (data.error) return '';
    // Prefer a concise name: city, state, country
    const addr = data.address || {};
    const city = addr.city || addr.town || addr.village || addr.county || addr.state_district || '';
    const state = addr.state || '';
    const country = addr.country || '';
    const parts = [city, state, country].filter(Boolean);
    return parts.join(', ') || data.display_name || '';
  } catch (e) {
    console.warn('[RecallFox] reverseGeocode failed:', e.message);
    return '';
  }
}

export async function geocode(address) {
  if (!address || address.trim().length < 3) {
    throw new Error('geocode: address too short');
  }
  const url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent(address)}&format=jsonv2&limit=1`;
  const res = await fetch(url, {
    headers: { 'Accept-Language': 'id,en' }
  });
  if (!res.ok) throw new Error('geocode: ' + res.status);
  const arr = await res.json();
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error('geocode: no results');
  }
  const top = arr[0];
  return {
    lat: parseFloat(top.lat),
    lng: parseFloat(top.lon),
    display: top.display_name
  };
}

// Compute the next prayer from current time
// Returns: { name, time: "HH:MM", minutesUntil: number, isToday: boolean }
// Order: Imsak (preview only), Fajr, Sunrise (skip), Dhuhr, Asr, Maghrib, Isha
const PRAYER_ORDER = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

export function getNextPrayer(timings, now = new Date()) {
  if (!timings) return null;
  const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;

  for (const name of PRAYER_ORDER) {
    const time = timings[name];
    if (!time || time === '--:--') continue;
    const [h, m] = time.split(':').map(n => parseInt(n, 10));
    if (isNaN(h) || isNaN(m)) continue;
    const prayerMin = h * 60 + m;
    if (prayerMin > nowMin) {
      return {
        name,
        time,
        minutesUntil: Math.round(prayerMin - nowMin),
        isToday: true
      };
    }
  }

  // All prayers passed → next is tomorrow's Fajr
  const fajrTime = timings.Fajr;
  if (fajrTime && fajrTime !== '--:--') {
    const [h, m] = fajrTime.split(':').map(n => parseInt(n, 10));
    if (!isNaN(h) && !isNaN(m)) {
      const prayerMin = h * 60 + m;
      const minutesUntil = Math.round(24 * 60 - nowMin + prayerMin);
      return {
        name: 'Fajr',
        time: fajrTime,
        minutesUntil,
        isToday: false
      };
    }
  }
  return null;
}

// Compute the next prayer INCLUDING sunnah prayers.
// This is used by the sticky bar — so if Dhuha is sooner than Dhuhr,
// the sticky bar shows Dhuha countdown.
// Returns: { name, time: "HH:MM", minutesUntil: number, isToday: boolean, isSunnah: boolean }
const PRAYER_ORDER_WITH_SUNNAH = [
  { name: 'Subuh',  key: 'Fajr',    isSunnah: false },
  { name: 'Ishraq', key: '_ishraq', isSunnah: true },
  { name: 'Dhuha',  key: '_dhuha',  isSunnah: true },
  { name: 'Dzuhur', key: 'Dhuhr',   isSunnah: false },
  { name: 'Ashar',  key: 'Asr',     isSunnah: false },
  { name: 'Magrib', key: 'Maghrib', isSunnah: false },
  { name: 'Awwabin', key: '_awwabin', isSunnah: true },
  { name: 'Isya',   key: 'Isha',    isSunnah: false },
  { name: 'Tahajud', key: '_tahajud', isSunnah: true }
];

export function getNextPrayerIncludingSunnah(timings, now = new Date()) {
  if (!timings) return null;
  const nowMin = now.getHours() * 60 + now.getMinutes();

  // Build a combined list of all prayer times (wajib + sunnah)
  const sunnahs = getSunnahPrayers(timings);
  const sunnahMap = {};
  for (const s of sunnahs) {
    sunnahMap['_' + s.name.toLowerCase()] = s.time;
  }

  for (const p of PRAYER_ORDER_WITH_SUNNAH) {
    let time;
    if (p.isSunnah) {
      time = sunnahMap[p.key];
    } else {
      time = timings[p.key];
    }
    if (!time || time === '--:--') continue;

    const [h, m] = time.split(':').map(n => parseInt(n, 10));
    if (isNaN(h) || isNaN(m)) continue;
    const prayerMin = h * 60 + m;

    if (prayerMin > nowMin) {
      return {
        name: p.name,
        key: p.key,
        time,
        minutesUntil: Math.round(prayerMin - nowMin),
        isToday: true,
        isSunnah: p.isSunnah
      };
    }
  }

  // All passed → next is tomorrow's Subuh
  const fajrTime = timings.Fajr;
  if (fajrTime && fajrTime !== '--:--') {
    const [h, m] = fajrTime.split(':').map(n => parseInt(n, 10));
    if (!isNaN(h) && !isNaN(m)) {
      const prayerMin = h * 60 + m;
      const minutesUntil = Math.round(24 * 60 - nowMin + prayerMin);
      return {
        name: 'Subuh',
        key: 'Fajr',
        time: fajrTime,
        minutesUntil,
        isToday: false,
        isSunnah: false
      };
    }
  }
  return null;
}

// Compute the LAST prayer that has already passed today (wajib only).
// Useful for "+Nm sejak {name}" indicator.
// Returns: { name, time: "HH:MM", minutesAgo: number } | null
export function getLastPassedPrayer(timings, now = new Date()) {
  if (!timings) return null;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  let lastPassed = null;
  for (const name of PRAYER_ORDER) {
    const time = timings[name];
    if (!time || time === '--:--') continue;
    const [h, m] = time.split(':').map(n => parseInt(n, 10));
    if (isNaN(h) || isNaN(m)) continue;
    const prayerMin = h * 60 + m;
    if (prayerMin <= nowMin) {
      lastPassed = { name, time, minutesAgo: Math.round(nowMin - prayerMin) };
    } else {
      break; // list is in order, stop at first future prayer
    }
  }
  return lastPassed;
}

// Helper: parse "HH:MM" → minutes since midnight
function timeToMin(t) {
  if (!t || t === '--:--') return null;
  const [h, m] = t.split(':').map(n => parseInt(n, 10));
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

// Helper: minutes since midnight → "HH:MM"
function minToTime(min) {
  if (min == null || isNaN(min)) return '--:--';
  // Wrap around 24h
  let m = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// Compute sunnah prayer times from the Aladhan API timings.
// Aladhan returns: Fajr, Sunrise, Dhuhr, Asr, Sunset, Maghrib, Isha,
// Imsak, Midnight, Firstthird, Lastthird
//
// Sunnah we display:
//   - Ishraq  : Sunrise + 10 min (2 rakaat, "setelah matahari naik")
//   - Dhuha    : Sunrise + 1/4 of (Dhuhr - Sunrise) — rumus klasik
//                Atau lebih sederhana: Sunrise + 20 min (yang umum di Indonesia)
//                Kita pakai rumus 1/4 karena lebih akurat
//   - Tahajud  : Lastthird (sepertiga malam terakhir) — waktu utama tahajud
//   - Awwabin  : Maghrib + 20 min (6 rakaat setelah Maghrib)
//
// Returns: [{ name, time, icon, desc }] atau [] kalau data tidak cukup
export function getSunnahPrayers(timings) {
  if (!timings) return [];
  const result = [];
  const sunrise = timeToMin(timings.Sunrise);
  const dhuhr = timeToMin(timings.Dhuhr);
  const maghrib = timeToMin(timings.Maghrib);
  const lastthird = timeToMin(timings.Lastthird);
  const firstthird = timeToMin(timings.Firstthird);

  // Ishraq: Sunrise + 10 min
  if (sunrise != null) {
    result.push({
      name: 'Ishraq',
      time: minToTime(sunrise + 10),
      icon: '🌅',
      desc: '2 rakaat setelah matahari naik'
    });
  }

  // Dhuha: Sunrise + 1/4 of (Dhuhr - Sunrise)
  if (sunrise != null && dhuhr != null) {
    const quarter = Math.round((dhuhr - sunrise) / 4);
    result.push({
      name: 'Dhuha',
      time: minToTime(sunrise + quarter),
      icon: '☀️',
      desc: `${quarter}m setelah Terbit (1/4 menuju Dzuhur)`
    });
  }

  // Awwabin: Maghrib + 20 min
  if (maghrib != null) {
    result.push({
      name: 'Awwabin',
      time: minToTime(maghrib + 20),
      icon: '🌆',
      desc: '6 rakaat setelah Maghrib'
    });
  }

  // Tahajud: Lastthird (sepertiga malam terakhir)
  if (lastthird != null) {
    result.push({
      name: 'Tahajud',
      time: minToTime(lastthird),
      icon: '🌙',
      desc: 'Sepertiga malam terakhir (waktu utama)'
    });
  }

  // Witir: bisa setelah Isya atau sebelum Fajr. Kita tampilkan sebagai info.
  if (firstthird != null) {
    result.push({
      name: 'Witir',
      time: minToTime(firstthird),
      icon: '🌟',
      desc: 'Sepertiga malam pertama (alternatif Witir)'
    });
  }

  return result;
}

// Format minutesUntil → "2h 15m" or "45m" or "just now"
export function formatCountdown(minutes) {
  if (minutes < 1) return 'sekarang';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}j` : `${h}j ${m}m`;
}

// Convert "HH:MM" → "HH:MM AM/PM" (12-hour)
export function to12Hour(time) {
  if (!time || time === '--:--') return '--:--';
  const [h, m] = time.split(':').map(n => parseInt(n, 10));
  if (isNaN(h) || isNaN(m)) return time;
  const period = h >= 12 ? 'PM' : 'AM';
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${period}`;
}
