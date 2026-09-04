/**
 * ============================================================================
 * RecallFox v3.24.9 — URUTKAN PDF (offline-first)
 * pdftool/engine.js — Mesin analisa, sort A-Z, & penyusunan ulang PDF klaim.
 * ----------------------------------------------------------------------------
 * Port 1:1 (vanilla JS) dari mesin web yang sudah tervalidasi E2E pada berkas
 * asli user ("MITRA PLUMBON MAJALE 6.1.pdf", 20 hal → 13 pasien → 21 hal):
 *   - src/lib/pdf-extract.ts        → itemsToText, extractPageTexts
 *   - src/lib/pdf-sort.ts           → extractMetaFromText, sortPageMetas,
 *                                     metasToOrder, buildIndexEntries,
 *                                     computeStats
 *   - src/app/api/reorder/route.ts  → drawIndexPage (DAFTAR ISI) + assembly
 * Semua konstanta, regex, urutan sort, & layout halaman DAFTAR ISI identik
 * dengan versi web — hasil output dibandingkan paritas byte saat uji.
 *
 * 100% OFFLINE: tidak ada fetch/jaringan. Bergantung pada 2 pustaka vendor
 * yang dibundel di vendor/ (dimuat sebagai <script> sebelum file ini):
 *   - window.pdfjsLib  (pdfjs-dist 3.11.174 legacy UMD) — ekstraksi teks
 *   - window.pdfLib    (pdf-lib 1.17.1 UMD)             — penyusunan PDF
 * Di Node (uji): set global.pdfjsLib & global.pdfLib via require() lalu
 * require file ini — modul mengekspor API di module.exports.
 *
 * PENTING (keamanan/CSP): pdfjs HARUS dijalankan dengan isEvalSupported:false
 * agar tidak pernah memakai eval/new Function (CSP MV3 tanpa unsafe-eval),
 * dan buffer yang diberikan ke pdfjs SELALU salinan (pdfjs me-detach buffer).
 * ============================================================================
 */
(function (global) {
  'use strict';

  // ---------- Konstanta (identik pdf-extract.ts / pdf-sort.ts / route.ts) ----------
  const LINE_TOLERANCE = 3.5;   // pt — toleransi baseline satu baris
  const SPACE_GAP = 1.2;        // pt — jarak x minimum untuk menyisipkan spasi

  const SENTINEL_UNREAD = '(NAMA TIDAK TERBACA)';
  const DISPLAY_UNREAD = '(Nama tidak terbaca)';

  const NAME_RE = /Nama\s+Peserta\s*:?\s*(.+)/i;
  const CLAIM_RE = /KL\d{12,20}/;
  // fallback: nilai menempel SEBELUM label (urutan content stream pdfjs), mis. "DIKI BAHTIARNama Peserta :"
  const NAME_RE_GLUED = /([^\n:]{1,80}?)\s*Nama\s+Peserta\s*:/i;
  // batas akhir nama bila teks baris lanjut ke label lain
  const NAME_TERMINATOR =
    /\s+(?:Nomor\s+Identitas|Nomer\s+Identitas|NIK|Nomor\s+Klaim|No\.?\s*Klaim|KTP)\b/i;

  // Konstanta layout DAFTAR ISI (identik api/reorder/route.ts)
  const MARGIN = 54;
  const ROW_H = 20;
  const TOP_PAD = 150;

  // ---------- Error khusus dengan pesan Indonesia yang jelas ----------
  function EngineError(message, code) {
    const e = new Error(message);
    e.name = 'EngineError';
    e.code = code || 'engine';
    return e;
  }

  // --------------------------------------------------------------------------
  // BAGIAN 1 — Ekstraksi teks berbasis KOORDINAT (port pdf-extract.ts)
  // Masalah: pdfjs mengeluarkan text-item sesuai urutan content stream,
  // sehingga nilai bisa muncul sebelum labelnya (mis. "DIKI BAHTIARNama Peserta :").
  // Solusi: ambil transform (x, y) tiap item, kelompokkan per baris visual
  // (y berdekatan), lalu urutkan kiri→kanan (x) di dalam baris.
  // --------------------------------------------------------------------------

  /** Susun ulang item pdfjs menjadi teks per baris visual (dipisah "\n"). */
  function itemsToText(items) {
    const valid = (items || []).filter(
      (it) => typeof it.str === 'string' && it.str !== '' && Array.isArray(it.transform)
    );
    if (valid.length === 0) return '';

    const parsed = valid.map((it) => ({
      x: it.transform[4],
      y: it.transform[5],
      w: typeof it.width === 'number' ? it.width : 0,
      str: it.str,
    }));

    // urutkan atas→bawah (y menurun, koordinat PDF y-ke-atas)
    parsed.sort((a, b) => b.y - a.y || a.x - b.x);

    const lines = [];
    let current = [];
    let currentY = null;

    for (const item of parsed) {
      if (currentY === null || Math.abs(item.y - currentY) <= LINE_TOLERANCE) {
        current.push(item);
        // rapikan baseline referensi ke rata-rata berjalan
        currentY =
          currentY === null ? item.y : (currentY * (current.length - 1) + item.y) / current.length;
      } else {
        if (current.length) lines.push(current);
        current = [item];
        currentY = item.y;
      }
    }
    if (current.length) lines.push(current);

    // susun tiap baris kiri→kanan dengan penyisipan spasi
    const out = [];
    for (const line of lines) {
      line.sort((a, b) => a.x - b.x);
      let text = '';
      let prevEnd = null;
      for (const it of line) {
        const s = it.str;
        if (!s) continue;
        if (prevEnd !== null && it.x - prevEnd > SPACE_GAP && !/\s$/.test(text) && !/^\s/.test(s)) {
          text += ' ';
        }
        text += s;
        prevEnd = it.x + it.w;
      }
      const collapsed = text.replace(/\s+/g, ' ').trim();
      if (collapsed) out.push(collapsed);
    }
    return out.join('\n');
  }

  /** Ekstrak teks semua halaman dengan rekonstruksi koordinat. */
  async function extractPageTexts(pdf) {
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      pages.push(itemsToText(tc.items || []));
    }
    return pages;
  }

  // --------------------------------------------------------------------------
  // BAGIAN 2 — Logika sort pasien (port pdf-sort.ts, disamakan Python
  // urutkan_pdf.py: nama A-Z → no. klaim menaik → tak-terbaca di akhir)
  // --------------------------------------------------------------------------

  function extractMetaFromText(text, index) {
    let name = '';
    const src = text == null ? '' : text;
    const m = NAME_RE.exec(src);
    if (m) {
      name = m[1];
    } else {
      const m2 = NAME_RE_GLUED.exec(src);
      if (m2) name = m2[1];
    }
    if (name) {
      name = name
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .split('\n')[0];
      name = name.split(NAME_TERMINATOR)[0];
      name = name.trim().replace(/^[\s:;\-–]+|[\s:;\-–]+$/g, '');
    }
    // sanity: nama minimal 2 karakter & ada hurufnya
    if (!/[A-Za-z]{2,}/.test(name)) name = '';
    const c = CLAIM_RE.exec(src);
    return { index, name, claim: c ? c[0] : null };
  }

  function sortKey(info) {
    if (info.name) {
      // klaim tidak ada -> "~~~~~~~~" (setelah digit apa pun di ASCII)
      return [0, info.name.toUpperCase(), info.claim || '~~~~~~~~', info.index];
    }
    return [1, SENTINEL_UNREAD, '', info.index];
  }

  function cmpKey(a, b) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    return 0;
  }

  /** Kembalikan urutan halaman baru (array PageMeta terurut, list asli tidak diubah). */
  function sortPageMetas(pages) {
    return [...pages].sort((a, b) => cmpKey(sortKey(a), sortKey(b)));
  }

  /** Array index asli (0-based) sesuai urutan final. */
  function metasToOrder(sorted) {
    return sorted.map((p) => p.index);
  }

  /**
   * Entri daftar isi: satu baris per PASIEN (rentang halaman bila >1 klaim).
   * @param sorted  halaman terurut final
   * @param offset  jumlah halaman daftar isi di depan (penggeser nomor halaman)
   */
  function buildIndexEntries(sorted, offset) {
    const entries = [];
    let i = 0;
    while (i < sorted.length) {
      const key = sorted[i].name || SENTINEL_UNREAD;
      let j = i;
      while (j + 1 < sorted.length && (sorted[j + 1].name || SENTINEL_UNREAD) === key) j++;
      const start = offset + 1 + i;
      const end = offset + 1 + j;
      entries.push({
        label: key,
        unread: !sorted[i].name,
        pageLabel: start === end ? String(start) : start + ' – ' + end,
      });
      i = j + 1;
    }
    return entries;
  }

  function computeStats(metas) {
    const nameCount = new Map();
    let unread = 0;
    for (const p of metas) {
      if (!p.name) {
        unread++;
        continue;
      }
      nameCount.set(p.name, (nameCount.get(p.name) || 0) + 1);
    }
    let multiClaim = 0;
    for (const v of nameCount.values()) if (v > 1) multiClaim++;
    return { total: metas.length, uniquePatients: nameCount.size, multiClaim, unread };
  }

  // ---------- Util nama file (identik route.ts) ----------
  function sanitizeName(raw) {
    const base = String(raw || '').replace(/\.[Pp][Dd][Ff]$/, '').trim() || 'dokumen';
    // buang karakter berbahaya untuk nama file
    return base.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ');
  }

  // ---------- Util salinan buffer (pdfjs me-detach buffer yang diterima) ----------
  function copyBytes(bytes) {
    if (bytes instanceof Uint8Array) return bytes.slice();
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes.slice(0));
    return new Uint8Array(bytes).slice();
  }

  // --------------------------------------------------------------------------
  // BAGIAN 3 — Analisa dokumen (pdfjs) + penyusunan PDF (pdf-lib)
  // --------------------------------------------------------------------------

  function requirePdfjs() {
    const lib = global.pdfjsLib;
    if (!lib || typeof lib.getDocument !== 'function') {
      throw EngineError(
        'Pustaka pembaca PDF (pdf.js) belum termuat. Muat ulang halaman lalu coba lagi.',
        'no-pdfjs'
      );
    }
    return lib;
  }

  function requirePdfLib() {
    // UMD pdf-lib mengekspor global "PDFLib" di browser; alias "pdfLib"
    // diterima juga (kompatibilitas Node test / bundler).
    const lib = global.pdfLib || global.PDFLib;
    if (!lib || typeof lib.PDFDocument !== 'function') {
      throw EngineError(
        'Pustaka penulis PDF (pdf-lib) belum termuat. Muat ulang halaman lalu coba lagi.',
        'no-pdflib'
      );
    }
    return lib;
  }

  /**
   * Analisa PDF: ekstrak teks semua halaman → metas → urutan A-Z + statistik.
   * TIDAK mengubah buffer yang diberikan (dipakai salinan internal).
   * @returns {{metas:Array, sorted:Array, order:number[], stats:Object, numPages:number}}
   */
  async function analyzePdf(bytes) {
    const pdfjs = requirePdfjs();
    if (!bytes) throw EngineError('Berkas PDF kosong.', 'empty');
    let doc = null;
    try {
      // PENTING: pdfjs bisa me-detach ArrayBuffer-nya -> berikan SALINAN
      doc = await pdfjs.getDocument({
        data: copyBytes(bytes),
        isEvalSupported: false,   // wajib: tanpa eval (aman CSP MV3)
        disableFontFace: true,    // kita hanya butuh teks, bukan render glyph
        useWorkerFetch: false,
      }).promise;
    } catch (e) {
      throw EngineError('PDF tidak dapat dibaca / terproteksi.', 'unreadable');
    }
    let texts;
    try {
      texts = await extractPageTexts(doc);
    } catch (e) {
      throw EngineError('Gagal membaca teks PDF (halaman rusak atau tidak didukung).', 'extract');
    } finally {
      try { await doc.destroy(); } catch (e) { /* abaikan */ }
    }
    if (!Array.isArray(texts) || texts.length === 0) {
      throw EngineError('Tidak ada halaman yang terbaca dari PDF ini.', 'nopages');
    }
    const metas = texts.map((t, i) => extractMetaFromText(t || '', i));
    const sorted = sortPageMetas(metas);
    const order = metasToOrder(sorted);
    const stats = computeStats(metas);
    return { metas, sorted, order, stats, numPages: texts.length };
  }

  // ---------- Gambar satu halaman DAFTAR ISI (port drawIndexPage, route.ts) ----------
  function drawIndexPage(ctx, entries, pageNum, totalPages, titleLines) {
    const width = ctx.width, height = ctx.height;
    const page = ctx.doc.addPage([width, height]);
    const cx = width / 2;

    let y = height - 90;
    page.drawText('DAFTAR ISI', {
      x: cx - ctx.bold.widthOfTextAtSize('DAFTAR ISI', 20) / 2,
      y,
      size: 20,
      font: ctx.bold,
      color: ctx.DARK,
    });
    y -= 22;
    page.drawText(titleLines[0] || '', {
      x: cx - ctx.reg.widthOfTextAtSize(titleLines[0] || '', 10) / 2,
      y,
      size: 10,
      font: ctx.reg,
      color: ctx.DARK,
    });
    y -= 14;
    page.drawText(titleLines[1] || '', {
      x: cx - ctx.reg.widthOfTextAtSize(titleLines[1] || '', 10) / 2,
      y,
      size: 10,
      font: ctx.reg,
      color: ctx.DARK,
    });
    if (pageNum > 1) {
      y -= 14;
      const note = '(lanjutan — halaman ' + pageNum + ' dari ' + totalPages + ')';
      page.drawText(note, {
        x: cx - ctx.italic.widthOfTextAtSize(note, 10) / 2,
        y: y - 6,
        size: 10,
        font: ctx.italic,
        color: ctx.GRAY,
      });
    }

    // header kolom
    y = height - TOP_PAD;
    page.drawText('NAMA PASIEN', { x: MARGIN, y, size: 10, font: ctx.bold, color: ctx.DARK });
    const hdr = 'HALAMAN';
    page.drawText(hdr, {
      x: width - MARGIN - ctx.bold.widthOfTextAtSize(hdr, 10),
      y,
      size: 10,
      font: ctx.bold,
      color: ctx.DARK,
    });
    page.drawLine({
      start: { x: MARGIN, y: y - 6 },
      end: { x: width - MARGIN, y: y - 6 },
      thickness: 0.8,
      color: ctx.DARK,
    });

    y -= ROW_H;
    for (const e of entries) {
      const disp = e.unread ? DISPLAY_UNREAD : e.label;
      const maxW = width - 2 * MARGIN - 90;
      let text = disp;
      while (ctx.reg.widthOfTextAtSize(text, 11) > maxW && text.length > 4) {
        text = text.slice(0, -2);
      }
      page.drawText(text, { x: MARGIN, y, size: 11, font: ctx.reg, color: ctx.DARK });
      page.drawText(e.pageLabel, {
        x: width - MARGIN - ctx.reg.widthOfTextAtSize(e.pageLabel, 11),
        y,
        size: 11,
        font: ctx.reg,
        color: ctx.DARK,
      });
      // garis titik-titik
      const x1 = MARGIN + ctx.reg.widthOfTextAtSize(text, 11) + 6;
      const x2 = width - MARGIN - ctx.reg.widthOfTextAtSize(e.pageLabel, 11) - 6;
      if (x2 > x1) {
        page.drawLine({
          start: { x: x1, y: y + 3 },
          end: { x: x2, y: y + 3 },
          thickness: 0.6,
          color: ctx.GRAY,
          dashArray: [1, 3],
        });
      }
      y -= ROW_H;
    }
  }

  /**
   * Susun PDF baru: halaman DAFTAR ISI (opsional) + halaman sumber sesuai order.
   * @param {Uint8Array|ArrayBuffer} bytes  berkas PDF sumber
   * @param {number[]} order  permutasi 0-based halaman sumber (urutan final)
   * @param {Array} metas     metas hasil analyzePdf (urutan halaman ASLI)
   * @param {{includeIndex?:boolean, fileName?:string}} opts
   * @returns {{bytes:Uint8Array, fileName:string, numPages:number}}
   */
  async function buildSortedPdf(bytes, order, metas, opts) {
    const pdfLib = requirePdfLib();
    opts = opts || {};
    const includeIndex = opts.includeIndex !== false;
    const rawName = typeof opts.fileName === 'string' && opts.fileName ? opts.fileName : 'dokumen';

    if (!bytes) throw EngineError('Berkas PDF sumber hilang — pilih ulang berkasnya.', 'empty');

    // --- muat sumber & validasi order: harus permutasi 0..n-1 ---
    let src;
    try {
      src = await pdfLib.PDFDocument.load(copyBytes(bytes), { ignoreEncryption: true });
    } catch (e) {
      throw EngineError('PDF tidak dapat dibaca / terproteksi.', 'unreadable');
    }
    const n = src.getPageCount();
    const ok =
      Array.isArray(order) && order.length === n &&
      new Set(order).size === n &&
      order.every((v) => Number.isInteger(v) && v >= 0 && v < n);
    if (!ok) throw EngineError('Urutan halaman tidak sesuai.', 'bad-order');
    if (!Array.isArray(metas) || metas.length !== n) {
      throw EngineError('Data analisa tidak sinkron dengan berkas — analisa ulang berkasnya.', 'stale-metas');
    }

    // --- susun PDF baru (identik route.ts) ---
    const out = await pdfLib.PDFDocument.create();
    const first = src.getPage(0);
    const pw = first.getWidth(), ph = first.getHeight();

    let n_index = 0;
    if (includeIndex) {
      const reg = await out.embedFont(pdfLib.StandardFonts.Helvetica);
      const bold = await out.embedFont(pdfLib.StandardFonts.HelveticaBold);
      const italic = await out.embedFont(pdfLib.StandardFonts.HelveticaOblique);
      const ctx = {
        doc: out, width: pw, height: ph, reg, bold, italic,
        GRAY: pdfLib.rgb(0.55, 0.55, 0.55),
        DARK: pdfLib.rgb(0.13, 0.16, 0.23),
      };

      const rowsPerPage = Math.max(Math.floor((ph - TOP_PAD - MARGIN) / ROW_H), 1);
      // entri awal dengan offset sementara; jika index >1 halaman, offset disesuaikan
      let entries = buildIndexEntries(order.map((i) => metas[i]), 1);
      n_index = Math.max(Math.ceil(entries.length / rowsPerPage), 1);
      if (n_index > 1) {
        entries = buildIndexEntries(order.map((i) => metas[i]), n_index);
      }

      const safeName = sanitizeName(rawName);
      const titleLines = [
        'File: ' + safeName,
        'Diurutkan otomatis: Nama Pasien A-Z (klaim ganda dirapatkan, urut no. klaim)',
      ];
      for (let p = 0; p < n_index; p++) {
        const chunk = entries.slice(p * rowsPerPage, (p + 1) * rowsPerPage);
        drawIndexPage(ctx, chunk, p + 1, n_index, titleLines);
      }
    }

    const copied = await out.copyPages(src, order);
    for (const p of copied) out.addPage(p);

    let outBytes;
    try {
      outBytes = await out.save({ useObjectStreams: true });
    } catch (e) {
      throw EngineError('Gagal menyusun PDF. Silakan coba lagi.', 'save');
    }

    const displayName = sanitizeName(rawName) + ' - SORT A-Z.pdf';
    return { bytes: outBytes, fileName: displayName, numPages: out.getPageCount() };
  }

  // ---------- API publik ----------
  const API = {
    // konstanta (untuk UI/tests)
    SENTINEL_UNREAD, DISPLAY_UNREAD,
    // murni logika (port pdf-sort.ts)
    extractMetaFromText, sortPageMetas, metasToOrder, buildIndexEntries, computeStats,
    sanitizeName,
    // teks (port pdf-extract.ts)
    itemsToText, extractPageTexts,
    // tingkat tinggi
    analyzePdf, buildSortedPdf,
    // versi mesin
    ENGINE_VERSION: '1.0.0 (v3.24.9)',
  };

  global.PDFSortEngine = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
