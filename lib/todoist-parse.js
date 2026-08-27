// lib/todoist-parse.js — Parse natural language untuk due dates, priority, labels (Indonesia)
// Contoh: "Bayar listrik besok jam 7 !1 #rumah" -> {body: "Bayar listrik", dueAt: ISO, priority:1, labels:["rumah"]}

const MONTHS_ID = {
  januari:0, februari:1, maret:2, april:3, mei:4, juni:5,
  juli:6, agustus:7, september:8, oktober:9, november:10, desember:11,
  jan:0, feb:1, mar:2, apr:3, jun:5, jul:6, agu:7, sep:8, okt:9, nov:10, des:11
};

export function parseTodoInput(text) {
  let body = String(text||'');
  let priority = 4;
  let labels = [];
  let dueAt = null;

  // Priority !1-!4 atau p1-p4 (case-insensitive, !1 dan p1 equivalent)
  const prioRe = /(?:^|\s)(?:!|p)([1-4])\b/i;
  const mPrio = body.match(prioRe);
  if (mPrio) {
    priority = parseInt(mPrio[1]);
    body = body.replace(mPrio[0], ' ');
  }
  // Labels #tag
  const labelRe = /#([a-z0-9_\/-]+)/gi;
  let m;
  while ((m = labelRe.exec(body)) !== null) {
    labels.push(m[1].toLowerCase());
  }
  body = body.replace(labelRe, ' ');

  // Due dates
  const now = new Date();
  let due = null;
  const lower = body.toLowerCase();

  // Helper: set jam
  let hour = 9, minute = 0, hasTime = false;
  const timeMatch = lower.match(/(?:jam|pukul)\s*(\d{1,2})(?::(\d{2}))?\s*(?:pagi|siang|sore|malam)?/);
  if (timeMatch) {
    hour = parseInt(timeMatch[1]);
    minute = parseInt(timeMatch[2]||0);
    if (hour < 24 && minute < 60) hasTime = true;
    // simple: if sore/malam and hour <12, +12
    if (lower.includes('sore') || lower.includes('malam')) {
      if (hour < 12) hour += 12;
    }
    body = body.replace(timeMatch[0], ' ');
  }

  // besok, lusa, hari ini, minggu depan, bulan depan
  if (lower.includes('lusa')) {
    due = new Date(now); due.setDate(now.getDate()+2);
  } else if (lower.includes('besok')) {
    due = new Date(now); due.setDate(now.getDate()+1);
  } else if (lower.includes('hari ini')) {
    due = new Date(now);
  } else if (lower.includes('minggu depan')) {
    due = new Date(now); due.setDate(now.getDate()+7);
  } else if (lower.includes('bulan depan')) {
    due = new Date(now); due.setMonth(now.getMonth()+1);
  } else {
    // tanggal 27 Agustus atau 27/08
    const dateMatch1 = lower.match(/(\d{1,2})\s+(januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|jan|feb|mar|apr|mei|jun|jul|agu|sep|okt|nov|des)\b/);
    if (dateMatch1) {
      const day = parseInt(dateMatch1[1]);
      const mon = MONTHS_ID[dateMatch1[2]];
      due = new Date(now.getFullYear(), mon, day);
      if (due < now) due.setFullYear(now.getFullYear()+1);
      body = body.replace(dateMatch1[0], ' ');
    } else {
      const dateMatch2 = lower.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
      if (dateMatch2) {
        const day = parseInt(dateMatch2[1]); const mon = parseInt(dateMatch2[2])-1;
        let year = dateMatch2[3] ? parseInt(dateMatch2[3]) : now.getFullYear();
        if (year < 100) year += 2000;
        due = new Date(year, mon, day);
        if (due < now) due.setFullYear(year+1);
        body = body.replace(dateMatch2[0], ' ');
      }
    }
    // hapus kata besok/lusa dll yang sudah dipakai
    body = body.replace(/\b(besok|lusa|hari ini|minggu depan|bulan depan)\b/gi, ' ');
  }

  if (due) {
    if (hasTime) {
      due.setHours(hour, minute, 0, 0);
    } else {
      due.setHours(9,0,0,0);
    }
    dueAt = due.toISOString();
  }

  body = body.replace(/\s+/g, ' ').trim();
  return { body: body||text, priority, labels, dueAt };
}

export function formatDueAt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diffMs = d - now;
  const diffDays = Math.floor(diffMs / (1000*60*60*24));
  const opts = { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' };
  const str = d.toLocaleDateString('id-ID', opts);
  if (diffDays < 0) return `Terlambat ${Math.abs(diffDays)} hari • ${str}`;
  if (diffDays === 0) return `Hari ini ${d.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})}`;
  if (diffDays === 1) return `Besok ${d.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})}`;
  return `📅 ${str}`;
}
