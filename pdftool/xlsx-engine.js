/**
 * RecallFox — pdftool/xlsx-engine.js (v3.24.10)
 * ============================================================================
 * Mesin REKONSILIASI TAGIHAN (offline-first) — tab ke-2 alat "Olah File Tagihan".
 *
 * Tugas:
 *   1) parseWorkbook : baca .xls/.xlsx (SheetJS) → { header, rows } yang bersih
 *                      (baris kosong hantu & kolom kosong ekstra dibuang).
 *   2) analyze       : kelompokkan baris per "Nama Rek. Penerima" (dinormalisasi)
 *                      + statistik (jumlah tagihan, total Rp, rentang tanggal).
 *   3) buildZip      : susun 1 berkas .xlsx per penerima terpilih (semua kolom
 *                      asli + baris TOTAL, urut Tgl Bayar → Kode Klaim) +
 *                      REKAP.xlsx (1 baris per penerima) → satu ZIP (fflate).
 *
 * Desain anti-gagal:
 *   - Header dideteksi per baris (bukan asumsi baris 1) via tanda kolom wajib
 *     "Nama Rek. Penerima"; sheet tanpa tanda itu dilewati.
 *   - Nilai "Jumlah Bayar" bisa number/string dengan pemisah ribuan apa pun.
 *   - Tanggal dd-mm-yyyy / dd/mm/yyyy / yyyy-mm-dd / serial Excel → sort key ISO.
 *   - XLSX.write dibungkus writeXlsxU8(): menerima Uint8Array/ArrayBuffer/
 *     base64 + sanity-check signature 'PK' (ZIP) → tidak mungkin output rusak
 *     lolos tanpa terdeteksi.
 *   - Nama berkas disanitasi (karakter ilegal, panjang, duplikat).
 *   - TANPA server, TANPA jaringan — semuanya memori lokal.
 *
 * Vendor : vendor/xlsx.full.min.js (SheetJS 0.18.5, global XLSX)
 *          vendor/fflate.min.js    (fflate 0.8.3,   global fflate)
 * Uji    : scripts/test_xlsx_engine_32410.js (Node) + Playwright E2E.
 * ============================================================================
 */
(function (global) {
  'use strict';

  const ENGINE_VERSION = '1.0.0 (v3.24.10)';

  // ------------------------------------------------------------ util dasar
  function normKey(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toUpperCase();
  }
  // kunci kolom tanpa tanda baca (toleran "Nama Rek. Penerima" / "NAMA REK PENERIMA")
  function colKey(s) {
    return normKey(s).replace(/[^A-Z0-9]/g, '');
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // Angka dari number / "1.234.567" / "1,234,567" / "Rp 12 345" dsb.
  function toNumber(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (v == null) return 0;
    let s = String(v).trim().replace(/^rp\s*/i, '').replace(/\s/g, '');
    if (!s) return 0;
    if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
    const n = parseFloat(s);
    return isFinite(n) ? n : 0;
  }

  // Format rupiah id-ID deterministik (tanpa Intl): 3692067670 → "3.692.067.670"
  function fmtNum(n) {
    n = Math.round(Number(n) * 100) / 100;
    if (!isFinite(n)) return '0';
    const neg = n < 0; n = Math.abs(n);
    let parts = String(n).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (neg ? '-' : '') + parts.join(',');
  }
  function fmtRp(n) { return 'Rp ' + fmtNum(n); }

  // Tanggal → 'YYYY-MM-DD' utk sortir/range; null bila tak dikenali.
  function dateKey(v) {
    if (v == null) return null;
    if (v instanceof Date && !isNaN(v)) {
      return v.getUTCFullYear() + '-' + pad2(v.getUTCMonth() + 1) + '-' + pad2(v.getUTCDate());
    }
    const s = String(v).trim();
    if (!s) return null;
    let m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);        // dd-mm-yyyy
    if (m) {
      const d = +m[1], mo = +m[2], y = +m[3];
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return y + '-' + pad2(mo) + '-' + pad2(d);
    }
    m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);            // yyyy-mm-dd
    if (m) {
      const y = +m[1], mo = +m[2], d = +m[3];
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return y + '-' + pad2(mo) + '-' + pad2(d);
    }
    const n = Number(s);
    if (isFinite(n) && n > 25569 && n < 80000) {                    // serial Excel (≥1970)
      const d = new Date(Math.round((n - 25569) * 86400000));
      return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
    }
    return null;
  }
  // 'YYYY-MM-DD' → 'DD-MM-YYYY' utk tampilan
  function fmtDate(iso) {
    if (!iso) return '-';
    const p = String(iso).split('-');
    return p.length === 3 ? p[2] + '-' + p[1] + '-' + p[0] : String(iso);
  }

  // Nama berkas aman lintas OS: buang karakter ilegal, rapatkan spasi, batasi 60.
  function safeFilename(s) {
    let out = String(s == null ? '' : s)
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[. ]+|[. ]+$/g, '')
      .trim();
    if (out.length > 60) out = out.slice(0, 60).replace(/[. ]+$/, '');
    return out || 'tanpa-nama';
  }

  // ------------------------------------------------------- deteksi kolom
  const COL_MATCHERS = [
    ['nama',  ['NAMAREKPENERIMA', 'NAMAREKENINGPENERIMA', 'NAMAPENERIMA']],
    ['bank',  ['BANKPENERIMA', 'NAMABANKPENERIMA']],
    ['norek', ['NOREKPENERIMA', 'NOMORREKPENERIMA', 'NOREKENINGPENERIMA', 'NOMORREKENINGPENERIMA']],
    ['bayar', ['JUMLAHBAYAR', 'NILAIBAYAR', 'JUMLAHBAYAR(RP)']],
    ['tgl',   ['TGLBAYAR', 'TANGGALBAYAR', 'TGLPEMBAYARAN', 'TANGGALPEMBAYARAN']],
    ['klaim', ['KODEKLAIM', 'NOKLAIM', 'NOKLAIMBPJS', 'NOMORKLAIM']]
  ];
  function mapColumns(header) {
    const idx = { nama: -1, bank: -1, norek: -1, bayar: -1, tgl: -1, klaim: -1 };
    for (let c = 0; c < header.length; c++) {
      const k = colKey(header[c]);
      if (!k) continue;
      for (const [slot, names] of COL_MATCHERS) {
        if (idx[slot] < 0 && names.indexOf(k) >= 0) idx[slot] = c;
      }
    }
    return idx;
  }
  // Baris header = baris yang memuat kolom wajib "Nama Rek. Penerima".
  function isHeaderRow(row) {
    for (let c = 0; c < row.length; c++) {
      const k = colKey(row[c]);
      if (k === 'NAMAREKPENERIMA' || k === 'NAMAREKENINGPENERIMA' || k === 'NAMAPENERIMA') return true;
    }
    return false;
  }

  // -------------------------------------------------------- parseWorkbook
  /**
   * @param {Uint8Array|ArrayBuffer} data — byte berkas (.xls/.xlsx/.csv)
   * @returns {{sheetName, header:string[], rows:Array<Array>, sheetCount:number, version}}
   */
  function parseWorkbook(data) {
    const XLSX = global.XLSX;
    if (!XLSX) throw new Error('Pustaka SheetJS belum termuat.');
    let wb;
    try {
      wb = XLSX.read(data instanceof Uint8Array ? data : new Uint8Array(data), { type: 'array', dense: false });
    } catch (e) {
      throw new Error('Berkas tidak dapat dibaca sebagai Excel/CSV: ' + (e && e.message ? e.message : e));
    }
    if (!wb.SheetNames || !wb.SheetNames.length) {
      throw new Error('Berkas tidak memuat sheet apa pun.');
    }
    // Cari sheet pertama yang punya baris header valid (maks 30 baris awal).
    let hit = null;
    for (let si = 0; si < wb.SheetNames.length; si++) {
      const sn = wb.SheetNames[si];
      let aoa;
      try {
        aoa = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: null, blankrows: true });
      } catch (e) { continue; }
      const scan = Math.min(aoa.length, 30);
      for (let r = 0; r < scan; r++) {
        const row = aoa[r] || [];
        if (isHeaderRow(row)) { hit = { sheetName: sn, aoa, headerRow: r }; break; }
      }
      if (hit) break;
    }
    if (!hit) {
      throw new Error('Kolom "Nama Rek. Penerima" tidak ditemukan. Pastikan ini laporan pembayaran tagihan (sheet: ' + wb.SheetNames.join(', ') + ').');
    }
    // Header: buang kolom kosong ekstra di ekor (berkas BPJS punya kolom hantu C24).
    const rawH = hit.aoa[hit.headerRow] || [];
    let H = [];
    for (let c = 0; c < rawH.length; c++) H.push(rawH[c] == null ? '' : String(rawH[c]).trim());
    while (H.length && !H[H.length - 1]) H.pop();
    if (!H.length) throw new Error('Baris header kosong.');
    const width = H.length;

    // Baris data: buang baris hantu kosong; nilai string di-trim, cell kosong ''.
    const rows = [];
    for (let r = hit.headerRow + 1; r < hit.aoa.length; r++) {
      const src = hit.aoa[r] || [];
      let has = false;
      const row = new Array(width);
      for (let c = 0; c < width; c++) {
        let v = src[c];
        if (v == null) v = '';
        else if (typeof v === 'string') v = v.replace(/\s+/g, ' ').trim();
        row[c] = v;
        if (v !== '') has = true;
      }
      if (has) rows.push(row);
    }
    if (!rows.length) throw new Error('Tidak ada baris data di bawah header.');
    return { sheetName: hit.sheetName, header: H, rows, sheetCount: wb.SheetNames.length, version: ENGINE_VERSION };
  }

  // -------------------------------------------------------------- analyze
  /**
   * @returns {{groups:Array, stats:{totalRows, groups, totalAmount, dateMin, dateMinIso, dateMax, dateMaxIso}}}
   * group: {key, name, indices[], count, total, banks[], noreks[], dateMinIso, dateMaxIso}
   */
  function analyze(parsed) {
    const idx = mapColumns(parsed.header);
    if (idx.nama < 0) throw new Error('Kolom "Nama Rek. Penerima" tidak dikenali pada header sheet.');
    const groups = new Map();
    for (let i = 0; i < parsed.rows.length; i++) {
      const row = parsed.rows[i];
      const rawName = row[idx.nama] == null ? '' : String(row[idx.nama]).trim();
      const key = normKey(rawName) || '(TANPA NAMA)';
      let g = groups.get(key);
      if (!g) {
        g = { key, name: rawName || '(Tanpa Nama Rekening)', indices: [], count: 0, total: 0, banks: new Set(), noreks: new Set(), dateMinIso: null, dateMaxIso: null };
        groups.set(key, g);
      }
      g.indices.push(i);
      g.count++;
      if (idx.bayar >= 0) g.total += toNumber(row[idx.bayar]);
      if (idx.bank >= 0) { const b = String(row[idx.bank] == null ? '' : row[idx.bank]).trim(); if (b) g.banks.add(b); }
      if (idx.norek >= 0) { const nr = String(row[idx.norek] == null ? '' : row[idx.norek]).trim(); if (nr) g.noreks.add(nr); }
      if (idx.tgl >= 0) {
        const dk = dateKey(row[idx.tgl]);
        if (dk) {
          if (!g.dateMinIso || dk < g.dateMinIso) g.dateMinIso = dk;
          if (!g.dateMaxIso || dk > g.dateMaxIso) g.dateMaxIso = dk;
        }
      }
    }
    const list = Array.from(groups.values()).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    let totalAmount = 0;
    let minIso = null, maxIso = null;
    for (const g of list) {
      totalAmount += g.total;
      if (g.dateMinIso && (!minIso || g.dateMinIso < minIso)) minIso = g.dateMinIso;
      if (g.dateMaxIso && (!maxIso || g.dateMaxIso > maxIso)) maxIso = g.dateMaxIso;
    }
    return {
      groups: list,
      stats: {
        totalRows: parsed.rows.length,
        groups: list.length,
        totalAmount: totalAmount,
        dateMinIso: minIso, dateMaxIso: maxIso
      }
    };
  }

  // ------------------------------------------------------------- tulis xlsx
  function base64ToU8(b64) {
    const bin = global.atob ? global.atob(b64) : Buffer.from(b64, 'base64').toString('binary');
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  /**
   * XLSX.write → Uint8Array deterministik lintas lingkungan (Node & browser).
   * 'array' hasilnya bisa Uint8Array ATAU ArrayBuffer tergantung build —
   * dinormalisasi di sini + fallback base64 + sanity 'PK'.
   */
  function writeXlsxU8(wb) {
    const XLSX = global.XLSX;
    let u8 = null;
    try {
      const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      if (out instanceof Uint8Array) u8 = out;
      else if (out instanceof ArrayBuffer) u8 = new Uint8Array(out);
      else if (out && out.buffer instanceof ArrayBuffer) u8 = new Uint8Array(out.buffer, out.byteOffset || 0, out.byteLength);
    } catch (e) { u8 = null; }
    if (!u8 || !u8.length) {
      u8 = base64ToU8(XLSX.write(wb, { bookType: 'xlsx', type: 'base64' }));
    }
    if (u8.length < 4 || u8[0] !== 0x50 || u8[1] !== 0x4B) {
      throw new Error('Output Excel tidak valid (signature ZIP salah).');
    }
    return u8;
  }

  // Lebar kolom dari panjang konten (sampel maks 80 baris), clamp 8..42.
  function colWidths(aoa) {
    const widths = [];
    const sample = Math.min(aoa.length, 80);
    for (let c = 0; c < aoa[0].length; c++) {
      let m = 10;
      for (let r = 0; r < sample; r++) {
        const row = aoa[r] || [];
        const v = row[c];
        if (v == null) continue;
        const L = String(typeof v === 'number' ? fmtNum(v) : v).length;
        if (L > m) m = L;
      }
      widths.push({ wch: Math.max(8, Math.min(42, m + 2)) });
    }
    return widths;
  }

  function buildSheet(parsed, rows, totalAmount) {
    const XLSX = global.XLSX;
    const aoa = [parsed.header.slice()];
    for (const r of rows) aoa.push(r);
    aoa.push([]);
    const totalRow = new Array(parsed.header.length).fill('');
    totalRow[0] = 'TOTAL';
    const idx = mapColumns(parsed.header);
    if (idx.bayar >= 0) totalRow[idx.bayar] = Math.round(totalAmount * 100) / 100;
    aoa.push(totalRow);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = colWidths(aoa);
    return ws;
  }

  // -------------------------------------------------------------- buildZip
  /**
   * Susun ZIP: 1 .xlsx per grup terpilih (+ REKAP.xlsx).
   * @param parsed   hasil parseWorkbook
   * @param analyzed hasil analyze
   * @param selected Set kunci grup terpilih (null/undefined = semua)
   * @returns Uint8Array (ZIP) + meta via out param opsional {onFile}
   */
  function buildZip(parsed, analyzed, selected, hooks) {
    const XLSX = global.XLSX;
    const fflate = global.fflate;
    if (!XLSX) throw new Error('Pustaka SheetJS belum termuat.');
    if (!fflate || typeof fflate.zipSync !== 'function') throw new Error('Pustaka fflate belum termuat.');
    const idx = mapColumns(parsed.header);
    const want = selected instanceof Set ? selected : (selected ? new Set(selected) : null);
    const files = Object.create(null);
    const rekapAoa = [['No', 'Nama Rekening', 'Bank', 'No. Rekening', 'Jml Tagihan', 'Total Bayar (Rp)', 'Nama File']];
    const used = new Set();
    let n = 0, grandTotal = 0, grandCount = 0;

    for (const g of analyzed.groups) {
      if (want && !want.has(g.key)) continue;
      n++;
      const base = safeFilename(g.name);
      let fname = base, k = 2;
      while (used.has(fname.toLowerCase())) fname = base + ' (' + (k++) + ')';
      used.add(fname.toLowerCase());
      const entryName = pad2(n) + ' ' + fname + '.xlsx';

      // baris grup diurut: Tgl Bayar → Kode Klaim → posisi asli (stabil)
      const rowsG = g.indices.map((i) => parsed.rows[i]);
      const sortCache = rowsG.map((row, j) => {
        const t = idx.tgl >= 0 ? (dateKey(row[idx.tgl]) || '9999-99-99') : '9999-99-99';
        const k2 = idx.klaim >= 0 ? String(row[idx.klaim] == null ? '' : row[idx.klaim]) : '';
        return { t, k2, j };
      });
      sortCache.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.k2 < b.k2 ? -1 : a.k2 > b.k2 ? 1 : a.j - b.j));
      const sortedRows = sortCache.map((sc) => rowsG[sc.j]);

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, buildSheet(parsed, sortedRows, g.total), 'Rekonsiliasi');
      const u8 = writeXlsxU8(wb);
      files[entryName] = u8;
      if (hooks && typeof hooks.onFile === 'function') { try { hooks.onFile(entryName, g, u8.length); } catch (_) {} }

      rekapAoa.push([
        n,
        g.name,
        Array.from(g.banks).join(', '),
        Array.from(g.noreks).join(', '),
        g.count,
        Math.round(g.total * 100) / 100,
        entryName
      ]);
      grandTotal += g.total;
      grandCount += g.count;
    }
    if (!n) throw new Error('Tidak ada penerima yang dipilih.');

    // TOTAL di REKAP
    rekapAoa.push([]);
    rekapAoa.push(['', 'TOTAL', '', '', grandCount, Math.round(grandTotal * 100) / 100, n + ' berkas']);
    const wbR = XLSX.utils.book_new();
    const wsR = XLSX.utils.aoa_to_sheet(rekapAoa);
    wsR['!cols'] = colWidths(rekapAoa);
    XLSX.utils.book_append_sheet(wbR, wsR, 'REKAP');
    files['REKAP.xlsx'] = writeXlsxU8(wbR);

    const zip = fflate.zipSync(files, { level: 6 });
    if (!(zip instanceof Uint8Array) || zip.length < 4 || zip[0] !== 0x50 || zip[1] !== 0x4B) {
      throw new Error('ZIP gagal dibangun (signature salah).');
    }
    return zip;
  }

  // ---------------------------------------------------------------- export
  const API = {
    // meta
    ENGINE_VERSION,
    // inti
    parseWorkbook, analyze, buildZip,
    // helper (dipakai UI + uji)
    mapColumns, toNumber, fmtNum, fmtRp, fmtDate, dateKey, normKey, safeFilename, writeXlsxU8
  };

  global.RFRekonEngine = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
