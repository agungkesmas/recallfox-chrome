// lib/islamicCalendar.js — Islamic calendar + sunnah fasting schedule
// RecallFox v0.6.0
//
// Sumber:
//   - Puasa Senin-Kamis: HR Tirmidzi (setiap Senin & Kamis)
//   - Ayyamul Bidh (13-14-15): HR Abu Daud (3 hari tiap bulan Qamariyah)
//   - Asyura (10 Muharram): HR Bukhari
//   - Tasua (9 Muharram): HR Muslim (untuk beda dengan Yahudi)
//   - Arafah (9 Dzulhijjah): HR Muslim (kecuali yang sedang wukuf)
//   - 6 hari Syawal: HR Muslim (1-6 Syawal)
//   - Puasa Daud: HR Bukhari (sehari puasa, sehari tidak)
//   - Puasa di bulan Muharram (paling utama setelah Ramadhan)
//   - Puasa di bulan Sya'ban
//
// API:
//   getSunnahFastToday(hijriDate) → { name, desc, isFastingDay } | null
//   getSunnahFastTomorrow(hijriDate) → { name, desc, isFastingDay } | null
//   getUpcomingFasts(hijriDate, days=7) → [{ date, name, desc }]
//   formatHijriDate(hijriDate) → string

// Hijri month names (Indonesian)
export const HIJRI_MONTHS = [
  'Muharram', 'Safar', 'Rabiul Awwal', 'Rabiul Akhir',
  'Jumadil Awwal', 'Jumadil Akhir', 'Rajab', 'Sya\'ban',
  'Ramadhan', 'Syawal', 'Dzulqa\'dah', 'Dzulhijjah'
];

// Format Hijri date to readable string
export function formatHijriDate(hijri) {
  if (!hijri) return '';
  const day = parseInt(hijri.day, 10);
  const month = hijri.month?.en || HIJRI_MONTHS[parseInt(hijri.month?.number || 0, 10) - 1] || '';
  const year = hijri.year || '';
  return `${day} ${month} ${year} AH`;
}

// Get day of week in Indonesian (0=Min, 1=Sen, 2=Sel, 3=Rab, 4=Kam, 5=Jum, 6=Sab)
function getDayName(date) {
  const days = ['Ahad', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  return days[date.getDay()];
}

// ============================================================
// Robust Hijri string parser
// Aladhan returns strings like "25 Muḥarram 1448 AH" where the
// month name may have diacritics (Muḥarram, Ṣafar, Rabīʿ al-Awwal)
// or use English transliteration that doesn't match our Indonesian
// HIJRI_MONTHS array. We use a mapping table for the 12 months.
// ============================================================
// Keys AND values are aggressive-normalized (lowercase, no spaces,
// no apostrophes, no hyphens, no diacritics).
const HIJRI_MONTH_ALIASES = {
  'muharram':    ['muharram', 'muharran'],
  'safar':       ['safar', 'saphar'],
  'rabiulawwal': ['rabialawwal', 'rabiawwal', 'rabii'],  // Aladhan: "Rabīʿ al-Awwal"
  'rabiulakhir': ['rabialthani', 'rabithani', 'rabiialthani', 'rabii'],  // Aladhan: "Rabīʿ al-Thānī"
  'jumadilawwal':['jumadaalawwal', 'jumadaawwal', 'jumadai'],
  'jumadilakhir':['jumadaalthani', 'jumadathani', 'jumadaii'],
  'rajab':       ['rajab'],
  'syaban':      ['shaban', 'shaaban', 'syabban'],  // Aladhan: "Shaʿbān"
  'ramadhan':    ['ramadan', 'ramzaan'],
  'syawal':      ['shawwal', 'shavval'],
  'dzulqadah':   ['dhualqadah', 'dhualqidah', 'dhuqidah', 'dzulqaidah'],  // Aladhan: "Dhū al-Qaʿdah"
  'dzulhijjah':  ['dhualhijjah', 'dhualhijja', 'dhuhijjah', 'zulhijjah']  // Aladhan: "Dhū al-Ḥijjah"
};

// Parse hijri string → hijriObj { day, month: {number, en}, year }
// Returns null on failure.
export function parseHijriString(hijriStr) {
  if (!hijriStr || typeof hijriStr !== 'string') return null;
  const tokens = hijriStr.trim().split(/\s+/);
  if (tokens.length < 3) return null;

  const day = tokens[0];
  const year = tokens[2];
  // Month name might span multiple tokens (e.g. "Rabīʿ al-Awwal" → tokens [1] + [2] + [3])
  // But year is always the last numeric token before "AH". Find year index.
  let yearIdx = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (/^\d+$/.test(tokens[i])) { yearIdx = i; break; }
  }
  if (yearIdx < 2) return null;  // need at least day + month + year
  const monthRaw = tokens.slice(1, yearIdx).join(' ');

  // Aggressively normalize: strip diacritics + lowercase + remove all
  // non-alphanumeric chars (apostrophes, hyphens, spaces). This makes
  // "Shaʿbān" / "sha'ban" / "syaban" all normalize to "shaban".
  const aggressiveNormalize = (s) =>
    s.normalize('NFD').replace(/[\u0300-\u036f\u02bc\u02bf\u2019]/g, '')  // strip diacritics + special apostrophes
     .toLowerCase()
     .replace(/[^a-z0-9]/g, '');  // remove spaces, hyphens, regular apostrophes, etc.
  const monthNorm = aggressiveNormalize(monthRaw);

  // Find matching Indonesian month index — exact match only (after aggressive
  // normalization) to avoid false positives like "Rabīʿ al-Thānī" matching
  // "Rabiul Awwal" via fuzzy prefix.
  let monthIdx = -1;
  for (let i = 0; i < HIJRI_MONTHS.length; i++) {
    const indoNorm = aggressiveNormalize(HIJRI_MONTHS[i]);
    const aliases = HIJRI_MONTH_ALIASES[indoNorm] || [];
    const allVariants = [indoNorm, ...aliases];
    if (allVariants.includes(monthNorm)) {
      monthIdx = i;
      break;
    }
  }
  if (monthIdx === -1) monthIdx = 0;  // fallback to Muharram

  return {
    day,
    month: { number: String(monthIdx + 1), en: HIJRI_MONTHS[monthIdx] },
    year: tokens[yearIdx]
  };
}

// Check if today is Monday or Thursday (puasa Senin-Kamis)
function isMondayOrThursday(date) {
  const day = date.getDay();
  return day === 1 || day === 4; // 1=Monday, 4=Thursday
}

// Check if Hijri day is 13, 14, or 15 (Ayyamul Bidh)
function isAyyamulBidh(hijriDay) {
  return hijriDay === 13 || hijriDay === 14 || hijriDay === 15;
}

// Check if specific sunnah fast day
// Returns: { name, desc, emoji } | null
export function getSunnahFast(hijriDate, date) {
  if (!hijriDate || !date) return null;

  const hijriDay = parseInt(hijriDate.day, 10);
  const hijriMonthNum = parseInt(hijriDate.month?.number || 0, 10);
  const hijriMonthName = hijriDate.month?.en || HIJRI_MONTHS[hijriMonthNum - 1] || '';
  const dayName = getDayName(date);

  // 1. Puasa Senin-Kamis (setiap Senin & Kamis)
  if (isMondayOrThursday(date)) {
    // Don't double-report if it's also a special day
    const special = checkSpecialFast(hijriDay, hijriMonthNum);
    if (!special) {
      return {
        name: 'Puasa Senin-Kamis',
        desc: `${dayName} — puasa sunnah rutin Nabi ﷺ`,
        emoji: '🌙',
        priority: 1
      };
    }
  }

  // 2. Check special fasts (Ayyamul Bidh, Asyura, Arafah, etc.)
  return checkSpecialFast(hijriDay, hijriMonthNum);
}

function checkSpecialFast(hijriDay, hijriMonthNum) {
  // Ayyamul Bidh (13-14-15 setiap bulan Qamariyah)
  if (isAyyamulBidh(hijriDay)) {
    return {
      name: 'Puasa Ayyamul Bidh',
      desc: `Tanggal ${hijriDay} — puasa 3 hari tengah bulan Qamariyah`,
      emoji: '🌕',
      priority: 2
    };
  }

  // 9 Muharram (Tasua)
  if (hijriMonthNum === 1 && hijriDay === 9) {
    return {
      name: 'Puasa Tasua',
      desc: '9 Muharram — berpuasa sebelum Asyura untuk membedakan dengan Yahudi',
      emoji: '🕯️',
      priority: 3
    };
  }

  // 10 Muharram (Asyura)
  if (hijriMonthNum === 1 && hijriDay === 10) {
    return {
      name: 'Puasa Asyura',
      desc: '10 Muharram — penghapusan dosa setahun yang lalu (HR Muslim)',
      emoji: '🕯️',
      priority: 4
    };
  }

  // 9 Dzulhijjah (Arafah) — kecuali yang sedang wukuf
  if (hijriMonthNum === 12 && hijriDay === 9) {
    return {
      name: 'Puasa Arafah',
      desc: '9 Dzulhijjah — penghapusan dosa tahun lalu & tahun depan (HR Muslim)',
      emoji: '🕋',
      priority: 4
    };
  }

  // 1-6 Syawal (6 hari Syawal)
  if (hijriMonthNum === 10 && hijriDay >= 1 && hijriDay <= 6) {
    return {
      name: 'Puasa 6 Syawal',
      desc: `${hijriDay} Syawal — puasa 6 hari di Syawal = pahala puasa setahun (HR Muslim)`,
      emoji: '✨',
      priority: 3
    };
  }

  // Seluruh bulan Muharram (paling utama setelah Ramadhan)
  // Kita hanya tampilkan untuk hari yang BUKAN 9/10 (sudah dicover di atas)
  // dan BUKAN Senin-Kamis (sudah dicover)
  // Tidak perlu tampilkan setiap hari — cukup info di widget

  return null;
}

// Get today's sunnah fast info
export function getSunnahFastToday(hijriDate, date = new Date()) {
  return getSunnahFast(hijriDate, date);
}

// Get tomorrow's sunnah fast info (for H-1 notification)
export function getSunnahFastTomorrow(hijriDate, date = new Date()) {
  if (!hijriDate) return null;
  // We need tomorrow's Hijri date. Aladhan API returns today's.
  // We approximate: if today is day N, tomorrow is N+1 (unless end of month).
  // This is good enough for notification purposes.
  const tomorrow = new Date(date);
  tomorrow.setDate(tomorrow.getDate() + 1);

  // Approximate Hijri date for tomorrow
  const hijriDayToday = parseInt(hijriDate.day, 10);
  const hijriMonthNum = parseInt(hijriDate.month?.number || 0, 10);
  const hijriYear = parseInt(hijriDate.year || 0, 10);

  // Simple: increment day. If day > 30, wrap to 1 and increment month.
  let tomorrowDay = hijriDayToday + 1;
  let tomorrowMonth = hijriMonthNum;
  let tomorrowYear = hijriYear;
  if (tomorrowDay > 30) {
    tomorrowDay = 1;
    tomorrowMonth += 1;
    if (tomorrowMonth > 12) {
      tomorrowMonth = 1;
      tomorrowYear += 1;
    }
  }

  const tomorrowHijri = {
    day: String(tomorrowDay),
    month: { number: String(tomorrowMonth), en: HIJRI_MONTHS[tomorrowMonth - 1] },
    year: String(tomorrowYear)
  };

  return getSunnahFast(tomorrowHijri, tomorrow);
}

// Get upcoming fasts in next N days (for display in prayer widget)
export function getUpcomingFasts(hijriDate, date = new Date(), days = 7) {
  if (!hijriDate) return [];

  const fasts = [];
  const hijriDayToday = parseInt(hijriDate.day, 10);
  const hijriMonthNum = parseInt(hijriDate.month?.number || 0, 10);
  const hijriYear = parseInt(hijriDate.year || 0, 10);

  for (let i = 0; i <= days; i++) {
    const checkDate = new Date(date);
    checkDate.setDate(checkDate.getDate() + i);

    let checkDay = hijriDayToday + i;
    let checkMonth = hijriMonthNum;
    let checkYear = hijriYear;
    while (checkDay > 30) {
      checkDay -= 30;
      checkMonth += 1;
      if (checkMonth > 12) {
        checkMonth = 1;
        checkYear += 1;
      }
    }

    const checkHijri = {
      day: String(checkDay),
      month: { number: String(checkMonth), en: HIJRI_MONTHS[checkMonth - 1] },
      year: String(checkYear)
    };

    const fast = getSunnahFast(checkHijri, checkDate);
    if (fast) {
      fasts.push({
        ...fast,
        date: checkDate,
        hijriDate: formatHijriDate(checkHijri),
        dayName: getDayName(checkDate),
        isToday: i === 0,
        isTomorrow: i === 1,
        daysAhead: i
      });
    }
  }

  return fasts;
}
