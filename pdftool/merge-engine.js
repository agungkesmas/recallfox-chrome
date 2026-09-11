/**
 * ============================================================================
 * RecallFox v3.24.22 — GABUNG PDF (offline-first)
 * pdftool/merge-engine.js — Mesin gabung PDF dengan pemilihan halaman
 *        per-berkas + halaman pembuka (daftar bagian) + halaman pemisah
 *        + kompresi hasil (rasterize).
 * ----------------------------------------------------------------------------
 * Kebutuhan user (v3.24.20): menyatukan beberapa berkas PDF tetapi HANYA
 * halaman yang dicentang dari tiap berkas (mis. dari berkas tagihan RS 10
 * halaman, ambil 3 halaman "rincian kwitansi" saja), dengan halaman pemisah
 * (section) di antara berkas yang menyumbang halaman.
 *
 * Revisi v3.24.21 (permintaan user): opsional HALAMAN PEMBUKA di halaman
 * pertama hasil gabungan — berisi judul, tanggal, dan daftar "BAGIAN n —
 * nama berkas (k hlm)" supaya verifikasi isi gabungan lebih mudah.
 *
 * Revisi v3.24.22 (permintaan user): preset KOMPRESI hasil ala iLovePDF —
 *   Ekstrem (96 DPI, JPEG 45%) / Sedang (150 DPI, JPEG 62%, default,
 *   setara "Recommended" iLovePDF) / Tanpa kompres (vektor utuh, lama).
 *   Halaman ISI di-rasterize (pdf.js → canvas → JPEG → embed pdf-lib)
 *   dgn FALLBACK VEKTOR per halaman (halaman gagal raster disalin utuh);
 *   halaman pembuka & pemisah TETAP vektor. Tersedia pula estimasi ukuran
 *   hasil (sampel halaman terpilih pertama tiap berkas) + deteksi teks
 *   asli (born-digital) untuk peringatan UI "teks jadi gambar".
 *
 *   berkas A (10 hlm) → centang [1,4,6]  ┐
 *                                        ├─ hasil: A2 A5 A7 │ PEMISAH │ B1 B3
 *   berkas B (10 hlm) → centang [0,2]    ┘
 *
 * 100% OFFLINE: tidak ada fetch/jaringan. Bergantung pada 2 pustaka vendor
 * yang dibundel di vendor/ (dimuat sebagai <script> sebelum file ini):
 *   - window.pdfjsLib (pdfjs-dist 3.11.174 legacy UMD) — baca jumlah halaman
 *     + cuplikan teks per halaman (identifikasi isi, mis. "RINCIAN KWITANSI")
 *   - window.pdfLib / window.PDFLib (pdf-lib 1.17.1 UMD) — susun PDF keluaran
 * Di Node (uji): set global.pdfjsLib & global.pdfLib via require() lalu
 * require file ini — modul mengekspor API di module.exports.
 *
 * PENTING (keamanan/CSP — sama dgn engine.js):
 *   - pdfjs HARUS dijalankan dengan isEvalSupported:false (CSP MV3 tanpa
 *     unsafe-eval), dan buffer yang diberikan ke pdfjs SELALU salinan
 *     (pdfjs me-detach buffer asli).
 *   - pdf-lib StandardFonts (WinAnsi) MELEMPAR error utk karakter di luar
 *     WinAnsi — SEMUA teks yang digambar melewati sanitizeWinAnsi().
 * ============================================================================
 */
(function (global) {
  'use strict';

  const CAP_SNIPPET_PAGES = 120;  // batas ekstraksi teks per berkas (kinerja)
  const CAP_SNIPPET_CHARS = 90;   // panjang cuplikan teks per halaman
  const MAX_NAME_LINES = 3;       // baris maks nama berkas di halaman pemisah
  const FOOTER_TEXT = 'RecallFox - Gabung PDF (offline)';

  function EngineError(message, code) {
    const e = new Error(message);
    e.code = code || 'engine';
    return e;
  }

  // --------------------------------------------------------------------------
  // Util dasar
  // --------------------------------------------------------------------------

  function copyBytes(bytes) {
    return new Uint8Array(bytes).slice();
  }

  // Peta karakter tipografis umum → ASCII WinAnsi yang aman utk pdf-lib.
  const CHAR_MAP = {
    '\u2018': "'", '\u2019': "'", '\u201A': ',', '\u201B': "'",
    '\u201C': '"', '\u201D': '"', '\u201E': ',',
    '\u2013': '-', '\u2014': '-', '\u2212': '-', '\u2010': '-', '\u2011': '-',
    '\u2026': '...', '\u00A0': ' ', '\u2022': '-', '\u00B7': '-',
    '\u2192': '->', '\u2190': '<-', '\u2264': '<=', '\u2265': '>=',
    '\t': ' ', '\n': ' ', '\r': ' '
  };

  /**
   * Amankan teks utk drawText pdf-lib (font WinAnsi). Panjang output TIDAK
   * dijamin sama dgn input (peta '...' dsb. bisa memanjang) — ini ok, caller
   * memakai hasil utk word-wrap. Karakter di luar WinAnsi → '?'.
   */
  function sanitizeWinAnsi(s) {
    let out = '';
    const str = String(s == null ? '' : s);
    for (const ch of str) {
      if (Object.prototype.hasOwnProperty.call(CHAR_MAP, ch)) { out += CHAR_MAP[ch]; continue; }
      const c = ch.codePointAt(0);
      // WinAnsi mendekati Latin-1: terima 0x20-0x7E dan 0xA0-0xFF.
      if ((c >= 0x20 && c <= 0x7E) || (c >= 0xA0 && c <= 0xFF)) out += ch;
      else out += '?';
    }
    return out;
  }

  /**
   * Word-wrap naif berbasis lebar karakter rata-rata (tanpa mengukur font) —
   * cukup utk halaman pemisah. Selalu kembali <= maxLines baris; baris terakhir
   * diberi "..." bila terpotong.
   */
  function wrapLabel(s, maxCharsPerLine, maxLines) {
    const sanitized = sanitizeWinAnsi(s).trim().replace(/\s+/g, ' ');
    if (!sanitized) return ['(tanpa nama)'];
    const words = sanitized.split(' ');
    const lines = [];
    let wi = 0;
    while (wi < words.length && lines.length < maxLines) {
      let line = words[wi++];
      while (wi < words.length && (line + ' ' + words[wi]).length <= maxCharsPerLine) {
        line += ' ' + words[wi++];
      }
      lines.push(line);
    }
    // Sisa kata / baris terpotong (kata super panjang) → tandai dgn '...'
    let cut = wi < words.length;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > maxCharsPerLine) {
        lines[i] = lines[i].slice(0, maxCharsPerLine);
        if (i === lines.length - 1) cut = true;
      }
    }
    if (cut && lines.length) {
      const last = lines[lines.length - 1];
      const trimmed = last.length > maxCharsPerLine - 3 ? last.slice(0, maxCharsPerLine - 3) : last;
      lines[lines.length - 1] = trimmed + '...';
    }
    return lines.length ? lines : [sanitized.slice(0, maxCharsPerLine)];
  }

  /**
   * Rapikan indeks halaman terpilih: hanya bilangan bulat dalam [0, numPages),
   * buang duplikat, urut naik. Indeks 0-based.
   */
  function clampIndices(selected, numPages) {
    if (!Array.isArray(selected)) return [];
    const seen = new Set();
    const out = [];
    for (const raw of selected) {
      const i = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isInteger(i) || i < 0 || i >= numPages) continue;
      if (seen.has(i)) continue;
      seen.add(i);
      out.push(i);
    }
    out.sort((a, b) => a - b);
    return out;
  }

  function requirePdfjs() {
    const lib = global.pdfjsLib;
    if (!lib || typeof lib.getDocument !== 'function') {
      throw EngineError('Pustaka pembaca PDF (pdf.js) belum termuat.', 'no-pdfjs');
    }
    return lib;
  }

  function requirePdfLib() {
    // UMD pdf-lib mengekspor global "PDFLib" di browser; alias "pdfLib"
    // diterima juga (kompatibilitas Node test / bundler).
    const lib = global.pdfLib || global.PDFLib;
    if (!lib || typeof lib.PDFDocument !== 'function') {
      throw EngineError('Pustaka penulis PDF (pdf-lib) belum termuat.', 'no-pdflib');
    }
    return lib;
  }

  // ------------------------------------------------------------------------
  // v3.24.22 — KOMPRESI HASIL (ala iLovePDF: Ekstrem / Sedang / Tanpa)
  // ------------------------------------------------------------------------

  /**
   * Preset kompresi hasil gabungan. Halaman isi di-RASTERIZE (pdf.js render
   * → canvas → JPEG → embed pdf-lib); halaman pembuka & pemisah TETAP
   * vektor. Mapping mengikuti iLovePDF: extreme=paling kecil, sedang=default
   * setara "Recommended", none=perilaku lama (salin vektor utuh).
   * Catatan: raster membuang teks asli halaman isi (jadi gambar) — UI
   * memberi peringatan via pageHasText()/estimateCompressed().hasText.
   */
  const COMP_PRESETS = {
    extreme: { dpi: 96,  q: 0.45, label: 'Ekstrem',        desc: 'paling kecil — buat kirim WA/email' },
    sedang:  { dpi: 150, q: 0.62, label: 'Sedang',         desc: 'seimbang — direkomendasikan' },
    none:    { dpi: 0,   q: 1,    label: 'Tanpa kompres',  desc: 'kualitas & teks asli utuh' }
  };
  const RASTER_MAX_PX = 4096; // pengaman kanvas utk halaman format besar

  /**
   * Buka dokumen pdf.js utk raster (flag aman CSP MV3 — tanpa eval).
   * Mengembalikan null bila gagal (caller fallback ke salin vektor).
   * Buffer TIDAK diubah (diberikan sbg salinan).
   */
  async function openRasterDoc(bytes) {
    const pdfjs = requirePdfjs();
    try {
      return await pdfjs.getDocument({
        data: copyBytes(bytes),
        isEvalSupported: false,   // wajib: tanpa eval (aman CSP MV3)
        disableFontFace: true,
        useWorkerFetch: false,
      }).promise;
    } catch (e) { return null; }
  }

  /**
   * Render 1 halaman (1-based) → JPEG blob via canvas. w/h yang dikembalikan
   * = ukuran TITIK asli halaman (72 dpi) supaya dimensi fisik halaman
   * keluaran tetap sama. Melempar bila canvas tak tersedia (Node) atau
   * render gagal — caller WAJIB punya fallback vektor per halaman.
   */
  async function rasterPageJpeg(pdfjsDoc, pageNo, dpi, q) {
    if (typeof document === 'undefined' || !document.createElement) {
      throw EngineError('Canvas tidak tersedia (lingkungan non-browser).', 'no-canvas');
    }
    const page = await pdfjsDoc.getPage(pageNo);
    const vp0 = page.getViewport({ scale: 1 });
    let scale = dpi / 72;
    if (Math.max(vp0.width, vp0.height) * scale > RASTER_MAX_PX) {
      scale = RASTER_MAX_PX / Math.max(vp0.width, vp0.height);
    }
    const vp = page.getViewport({ scale });
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(vp.width));
    cv.height = Math.max(1, Math.round(vp.height));
    try {
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cv.width, cv.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const blob = await new Promise((res, rej) =>
        cv.toBlob((b) => (b ? res(b) : rej(new Error('toBlob gagal'))), 'image/jpeg', q));
      return { blob, w: vp0.width, h: vp0.height };
    } finally {
      try { cv.width = 0; cv.height = 0; } catch (e) { /* abaikan */ }
      try { page.cleanup(); } catch (e) { /* abaikan */ }
    }
  }

  /**
   * Halaman mengandung teks asli (born-digital)? Ambang >40 karakter
   * non-spasi — sama dgn PWA desktop. Gagal baca → false (tidak menghalangi).
   */
  async function pageHasText(pdfjsDoc, pageNo) {
    try {
      const page = await pdfjsDoc.getPage(pageNo);
      const tc = await page.getTextContent();
      const chars = (tc.items || []).reduce((a, it) => a + String(it.str || '').replace(/\s+/g, '').length, 0);
      return chars > 40;
    } catch (e) { return false; }
  }

  /**
   * Estimasi ukuran hasil kompres utk UI (dipanggil SEBELUM merge).
   * files: [{bytes, selected:number[] (0-based), numPages}] — sampel halaman
   * terpilih PERTAMA tiap berkas × jumlah halaman terpilih (heuristik sama
   * dgn PWA desktop). Juga mendeteksi teks asli utk peringatan UI.
   * Aman di Node (tanpa canvas): sampled=0, est=0 — TIDAK pernah melempar.
   * @returns {Promise<{est:number, estRaw:number, sampled:number,
   *                    hasText:boolean, preset:string}>}
   */
  async function estimateCompressed(files, presetKey) {
    const preset = COMP_PRESETS[presetKey] || COMP_PRESETS.none;
    const out = { est: 0, estRaw: 0, sampled: 0, hasText: false, preset: preset.key || presetKey };
    const list = Array.isArray(files) ? files : [];
    const rawOf = (f) => (f && f.bytes && f.bytes.byteLength)
      ? f.bytes.byteLength * ((f.selected || []).length) / Math.max(1, f.numPages || (f.selected || []).length)
      : 0;
    if (preset === COMP_PRESETS.none || !list.length) {
      out.estRaw = list.reduce((a, f) => a + rawOf(f), 0);
      out.est = out.estRaw;
      return out;
    }
    for (const f of list) {
      if (!f || !f.bytes || !f.bytes.length) continue;
      const sel = Array.isArray(f.selected) ? f.selected.slice().sort((a, b) => a - b) : [];
      if (!sel.length) continue;
      out.estRaw += rawOf(f);
      let doc = null;
      try {
        doc = await openRasterDoc(f.bytes);
        if (!doc) continue;
        const first = Math.min(sel[0], f.numPages || sel.length) + 1; // 0-based → 1-based
        // Deteksi teks asli DULU (murah, selalu jalan — juga di Node tanpa canvas)
        if (!out.hasText) out.hasText = await pageHasText(doc, first);
        try {
          const r = await rasterPageJpeg(doc, first, preset.dpi, preset.q);
          out.est += r.blob.size * sel.length;
          out.sampled++;
        } catch (e) { /* sampel raster gagal (mis. Node tanpa canvas) → lewati */ }
      } catch (e) { /* berkas ini gagal → lewati */ }
      finally { try { if (doc) await doc.destroy(); } catch (e2) { /* abaikan */ } }
    }
    return out;
  }

  // --------------------------------------------------------------------------
  // Analisa berkas: jumlah halaman + cuplikan teks per halaman
  // --------------------------------------------------------------------------

  /**
   * Baca berkas PDF: jumlah halaman + cuplikan teks awal per halaman.
   * Cuplikan membantu user mengenali halaman (mis. mengandung
   * "RINCIAN KWITANSI") tanpa harus membuka PDF satu per satu.
   * TIDAK mengubah buffer yang diberikan (memakai salinan).
   * @returns {Promise<{numPages:number, snippets:string[]}>}
   */
  async function analyzeDocument(bytes) {
    const pdfjs = requirePdfjs();
    if (!bytes || !bytes.length) throw EngineError('Berkas PDF kosong.', 'empty');
    let doc = null;
    try {
      doc = await pdfjs.getDocument({
        data: copyBytes(bytes),
        isEvalSupported: false,   // wajib: tanpa eval (aman CSP MV3)
        disableFontFace: true,    // cukup teks, bukan render glyph
        useWorkerFetch: false,
      }).promise;
    } catch (e) {
      throw EngineError('PDF tidak dapat dibaca / terproteksi.', 'unreadable');
    }
    const numPages = doc.numPages;
    const snippets = new Array(numPages).fill('');
    try {
      const cap = Math.min(numPages, CAP_SNIPPET_PAGES);
      for (let i = 0; i < cap; i++) {
        let text = '';
        try {
          const tc = await doc.getPage(i + 1).then((p) => p.getTextContent());
          text = tc.items.map((it) => (typeof it.str === 'string' ? it.str : '')).join(' ');
        } catch (e) { text = ''; }
        text = String(text).replace(/\s+/g, ' ').trim();
        snippets[i] = text.slice(0, CAP_SNIPPET_CHARS);
      }
    } finally {
      try { await doc.destroy(); } catch (e) { /* abaikan */ }
    }
    if (!numPages) throw EngineError('Tidak ada halaman yang terbaca dari PDF ini.', 'nopages');
    return { numPages, snippets };
  }

  // --------------------------------------------------------------------------
  // Halaman pemisah (section) antar berkas
  // --------------------------------------------------------------------------

  /**
   * Gambar satu halaman pemisah ke dokumen keluaran.
   * Ukuran halaman = ukuran halaman PERTAMA berkas yang akan mengikuti
   * (supaya pemisah menyatu rapi dgn berkas setelahnya).
   * Semua teks lewat sanitizeWinAnsi (anti-throw WinAnsi).
   */
  async function drawSeparatorPage(out, fonts, opts) {
    const { partNo, name, pagesPicked, pagesTotal, dateLabel, size } = opts;
    const W = Math.max(72, size.width);
    const H = Math.max(72, size.height);
    const page = out.addPage([W, H]);
    const M = Math.min(64, W * 0.12);          // margin samping
    const C = {
      border: pdfLibRgb(0.78, 0.80, 0.85),
      soft: pdfLibRgb(0.90, 0.91, 0.95),
      dark: pdfLibRgb(0.13, 0.16, 0.23),
      mid: pdfLibRgb(0.42, 0.45, 0.52),
      light: pdfLibRgb(0.62, 0.65, 0.72)
    };

    // Bingkai tipis (transparan, tanpa blok — tinta hemat saat dicetak).
    const pad = Math.min(28, W * 0.055);
    page.drawRectangle({
      x: pad, y: pad, width: W - pad * 2, height: H - pad * 2,
      borderColor: C.border, borderWidth: 1
    });

    const cy = H * 0.62; // pusat vertikal konten
    // Label bagian
    const label = 'B A G I A N   ' + partNo;
    page.drawText(label, {
      x: M, y: cy + 72, size: 11, font: fonts.bold, color: C.mid
    });

    // Nama berkas (word-wrap, maks 3 baris)
    const nameLines = wrapLabel(name, Math.max(18, Math.floor((W - M * 2) / (7.2))), MAX_NAME_LINES);
    let ny = cy + 34;
    for (const ln of nameLines) {
      page.drawText(ln, { x: M, y: ny, size: 19, font: fonts.bold, color: C.dark });
      ny -= 24;
    }

    // Garis pemisah tipis
    page.drawLine({
      start: { x: M, y: cy + 10 }, end: { x: W - M, y: cy + 10 },
      thickness: 0.8, color: C.soft
    });

    // Ringkasan
    page.drawText(sanitizeWinAnsi(
      pagesPicked + ' dari ' + pagesTotal + ' halaman diambil dari berkas ini'
    ), { x: M, y: cy - 16, size: 10.5, font: fonts.reg, color: C.mid });
    page.drawText(sanitizeWinAnsi(dateLabel), {
      x: M, y: cy - 34, size: 10.5, font: fonts.reg, color: C.mid
    });

    // Footer
    page.drawText(sanitizeWinAnsi(FOOTER_TEXT), {
      x: M, y: pad + 12, size: 8, font: fonts.reg, color: C.light
    });
    return page;
  }

  // pdf-lib rgb dipanggil lewat lib global (tersedia saat runtime penuh).
  function pdfLibRgb(r, g, b) {
    const lib = global.pdfLib || global.PDFLib;
    return lib.rgb(r, g, b);
  }

  // --------------------------------------------------------------------------
  // Halaman pembuka (cover) — daftar bagian di halaman pertama hasil gabung
  // --------------------------------------------------------------------------

  /**
   * Gambar HALAMAN PEMBUKA hasil gabungan (permintaan v3.24.21): judul,
   * tanggal, dan daftar "BAGIAN n — nama berkas (k hlm)" — memudahkan
   * verifikasi. Ukuran halaman = ukuran halaman terpilih pertama dari
   * bagian pertama (menyatu rapi dgn isi setelahnya).
   * Satu baris per bagian (nama dibungkus 1 baris + ellipsis); bila daftar
   * melebihi tinggi halaman, sisanya diringkas "… +N bagian lainnya".
   * Semua teks lewat sanitizeWinAnsi (anti-throw WinAnsi).
   */
  async function drawCoverPage(out, fonts, opts) {
    const { parts, dateLabel, size } = opts;
    const W = Math.max(72, size.width);
    const H = Math.max(72, size.height);
    const page = out.addPage([W, H]);
    const M = Math.min(64, W * 0.12);
    const C = {
      border: pdfLibRgb(0.78, 0.80, 0.85),
      soft: pdfLibRgb(0.90, 0.91, 0.95),
      dark: pdfLibRgb(0.13, 0.16, 0.23),
      mid: pdfLibRgb(0.42, 0.45, 0.52),
      light: pdfLibRgb(0.62, 0.65, 0.72)
    };

    // Bingkai tipis (sama dgn halaman pemisah — tinta hemat saat dicetak).
    const pad = Math.min(28, W * 0.055);
    page.drawRectangle({
      x: pad, y: pad, width: W - pad * 2, height: H - pad * 2,
      borderColor: C.border, borderWidth: 1
    });

    const totalSel = parts.reduce((a, p) => a + p.idx.length, 0);
    let y = H - pad - 56;
    page.drawText('G A B U N G A N   P D F', {
      x: M, y, size: 18, font: fonts.bold, color: C.dark
    });
    y -= 18;
    page.drawText(sanitizeWinAnsi(dateLabel), {
      x: M, y, size: 10.5, font: fonts.reg, color: C.mid
    });
    y -= 10;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: C.soft });
    y -= 22;
    page.drawText(sanitizeWinAnsi(
      'DAFTAR BAGIAN — ' + parts.length + ' berkas, ' + totalSel + ' halaman'
    ), { x: M, y, size: 11, font: fonts.bold, color: C.mid });
    y -= 18;

    const bottomLimit = pad + 40;
    let shown = 0;
    for (const p of parts) {
      if (y < bottomLimit) break;
      const label = 'BAGIAN ' + (shown + 1);
      const count = '(' + p.idx.length + ' hlm)';
      let labelW = 0, countW = 0;
      try {
        labelW = fonts.bold.widthOfTextAtSize(label, 9.5) + 8;
        countW = fonts.reg.widthOfTextAtSize('  ' + count, 10) + 8;
      } catch (e) { labelW = 52; countW = 40; }
      const maxChars = Math.max(12, Math.floor((W - M * 2 - labelW - countW) / 5.6));
      const nameLines = wrapLabel(p.name, maxChars, 1);
      page.drawText(label, { x: M, y, size: 9.5, font: fonts.bold, color: C.mid });
      page.drawText(sanitizeWinAnsi(nameLines[0]), {
        x: M + labelW, y, size: 10.5, font: fonts.reg, color: C.dark
      });
      if (W - M - countW > M + labelW) {
        page.drawText(sanitizeWinAnsi(count), {
          x: W - M - countW + 8, y, size: 10, font: fonts.reg, color: C.mid
        });
      }
      y -= 17;
      shown++;
    }
    if (shown < parts.length && y >= bottomLimit - 17) {
      page.drawText(sanitizeWinAnsi('... +' + (parts.length - shown) + ' bagian lainnya'), {
        x: M, y, size: 9.5, font: fonts.reg, color: C.mid
      });
    }
    page.drawText(sanitizeWinAnsi(FOOTER_TEXT), {
      x: M, y: pad + 12, size: 8, font: fonts.reg, color: C.light
    });
    return page;
  }

  // --------------------------------------------------------------------------
  // Gabung: susun PDF keluaran
  // --------------------------------------------------------------------------

  /**
   * Gabungkan berkas-berkas: hanya halaman terpilih, opsional halaman
   * pembuka (daftar bagian) di awal + pemisah antar berkas penyumbang.
   * @param {Object} opts
   * @param {Array<{name:string, bytes:Uint8Array, selected:number[]}>} opts.files
   * @param {boolean} [opts.separator=true] sisipkan halaman pemisah antar berkas
   * @param {boolean} [opts.cover=false] sisipkan halaman pembuka daftar bagian
   * @param {string}  [opts.compress='none'] preset kompresi: 'extreme'|'sedang'|'none'
   * @param {Function} [opts.onProgress] callback({part,parts,page,pages,label})
   * @returns {Promise<{bytes:Uint8Array, pages:number, parts:number,
   *                    separators:number, cover:number, comp:string,
   *                    compIn:number, rasterized:number, vectorFallback:number}>}
   */
  async function merge(opts) {
    const pdfLib = requirePdfLib();
    const files = (opts && Array.isArray(opts.files)) ? opts.files : [];
    const separator = !(opts && opts.separator === false);
    const withCover = !!(opts && opts.cover);
    // v3.24.22: preset kompresi — 'none' default (perilaku lama UTUH).
    const compKey = (opts && typeof opts.compress === 'string' && COMP_PRESETS[opts.compress]) ? opts.compress : 'none';
    const comp = COMP_PRESETS[compKey];
    const useRaster = comp !== COMP_PRESETS.none;
    const onProgress = (opts && typeof opts.onProgress === 'function') ? opts.onProgress : null;
    if (!files.length) throw EngineError('Tidak ada berkas untuk digabung.', 'nofiles');

    // Siapkan bagian yang benar-benar menyumbang halaman.
    const parts = [];
    for (const f of files) {
      if (!f || !f.bytes || !f.bytes.length) continue;
      const src = await pdfLib.PDFDocument.load(copyBytes(f.bytes), { ignoreEncryption: true });
      const idx = clampIndices(f.selected, src.getPageCount());
      if (!idx.length) continue; // berkas tanpa halaman terpilih → dilewati
      parts.push({ name: String(f.name || '(tanpa nama)'), src, idx, bytes: f.bytes });
    }
    if (!parts.length) throw EngineError('Tidak ada halaman yang dicentang. Centang minimal satu halaman.', 'noselection');

    const out = await pdfLib.PDFDocument.create();
    const reg = await out.embedFont(pdfLib.StandardFonts.Helvetica);
    const bold = await out.embedFont(pdfLib.StandardFonts.HelveticaBold);
    const fonts = { reg, bold };
    const dateLabel = new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    let separators = 0;
    let coverAdded = 0;
    // v3.24.22: penghitung raster/fallback + dokumen pdf.js per bagian
    let rasterized = 0;
    let vectorFallback = 0;
    const rasterDocs = useRaster ? new Map() : null; // indeks bagian → pdf.js doc|null
    const closeRasterDocs = async () => {
      if (!rasterDocs) return;
      for (const d of rasterDocs.values()) { try { if (d) await d.destroy(); } catch (e) { /* abaikan */ } }
      rasterDocs.clear();
    };
    try {
      // Halaman pembuka (daftar bagian) — SEBELUM bagian pertama (v3.24.21).
      if (withCover) {
        const firstSel = parts[0].src.getPage(parts[0].idx[0]);
        await drawCoverPage(out, fonts, {
          parts,
          dateLabel,
          size: firstSel.getSize()
        });
        coverAdded = 1;
      }
      for (let p = 0; p < parts.length; p++) {
        const part = parts[p];
        if (separator && p > 0) {
          const firstSel = part.src.getPage(part.idx[0]);
          const size = firstSel.getSize();
          await drawSeparatorPage(out, fonts, {
            partNo: p + 1,
            name: part.name,
            pagesPicked: part.idx.length,
            pagesTotal: part.src.getPageCount(),
            dateLabel,
            size
          });
          separators++;
        }
        // v3.24.22: siapkan dokumen pdf.js bagian ini bila raster menyala
        let pdoc = null;
        if (useRaster) {
          if (!rasterDocs.has(p)) rasterDocs.set(p, await openRasterDoc(part.bytes));
          pdoc = rasterDocs.get(p);
        }
        if (useRaster && pdoc) {
          // RASTER: halaman terpilih → JPEG → embed (fallback vektor per halaman)
          for (let k = 0; k < part.idx.length; k++) {
            if (onProgress) {
              try { onProgress({ part: p + 1, parts: parts.length, page: k + 1, pages: part.idx.length, label: comp.label }); } catch (e) { /* abaikan */ }
            }
            try {
              const r = await rasterPageJpeg(pdoc, part.idx[k] + 1, comp.dpi, comp.q);
              const img = await out.embedJpg(new Uint8Array(await r.blob.arrayBuffer()));
              const pp = out.addPage([r.w, r.h]);
              pp.drawImage(img, { x: 0, y: 0, width: r.w, height: r.h });
              rasterized++;
            } catch (e) {
              // Fallback vektor utk halaman ini — hasil tetap benar.
              const pv = await out.copyPages(part.src, [part.idx[k]]);
              for (const pg2 of pv) out.addPage(pg2);
              vectorFallback++;
            }
          }
        } else {
          if (useRaster && !pdoc) vectorFallback += part.idx.length; // pdf.js gagal → seluruh bagian vektor
          const copied = await out.copyPages(part.src, part.idx);
          for (const pg of copied) out.addPage(pg);
        }
      }
    } finally {
      await closeRasterDocs();
    }

    // v3.24.22: perkiraan ukuran "sebelum" (proporsi byte × rasio halaman)
    const compIn = Math.round(parts.reduce((a, pt) =>
      a + (pt.bytes && pt.bytes.byteLength ? pt.bytes.byteLength * pt.idx.length / Math.max(1, pt.src.getPageCount()) : 0), 0));
    const bytes = await out.save({ useObjectStreams: false });
    return {
      bytes: new Uint8Array(bytes),
      pages: out.getPageCount(),
      parts: parts.length,
      separators,
      cover: coverAdded,
      comp: compKey,
      compIn,
      rasterized,
      vectorFallback
    };
  }

  // --------------------------------------------------------------------------
  // API
  // --------------------------------------------------------------------------
  const API = {
    // util
    copyBytes, sanitizeWinAnsi, wrapLabel, clampIndices,
    // tingkat tinggi
    analyzeDocument, merge,
    // v3.24.22: kompresi hasil
    COMP_PRESETS, openRasterDoc, rasterPageJpeg, pageHasText, estimateCompressed,
    // konstanta (untuk UI/tests)
    CAP_SNIPPET_PAGES, FOOTER_TEXT, RASTER_MAX_PX,
    // versi mesin
    ENGINE_VERSION: '1.2.0 (v3.24.22)',
  };

  global.RFMergeEngine = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
