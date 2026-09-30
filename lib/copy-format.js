// lib/copy-format.js — Shared clipboard format builder for screenshot copy
// RecallFox v3.11.38
//
// User feedback (Sesi 1, 18 Jul 2026):
//   "format paste ketika saya memencet tombol kopi gambar + keterangan di preview
//    modal sangat sangat sangat bagus. tapi kalau pakai sidebar itu jelek jelek
//    jelek banget. banyak yang ga muncul. standarkan dong, disamakan format kopi
//    paste nya yang sidebar ke menjadi selengkap tekan tombol gambar + keterangan
//    di preview modal. berlaku juga untuk batch harus sama formatnya."
//
// Modul ini berisi SATU fungsi `buildScreenshotCaption(item, dataUrl)` yang
// dipakai oleh:
//   - content/overlay.js (preview modal copy)
//   - popup/popup.js (single item + batch copy via direct clipboard.write)
//   - background.js (COPY_SCREENSHOT_TO_CLIPBOARD + COPY_SCREENSHOTS_BATCH handlers)
//
// Format output (text/plain):
//   📸 Screenshot — {pageTitle}
//   Sumber: {pageUrl}
//   🔗 Link gambar: {imageUrl}        (kalau ada URL cloud, v3.24.27)
//   Waktu: {capturedDateStr}
//   Mode: {modeLabel} · {dims}
//   📝 Catatan: {annotationNote}      (kalau ada)
//   Ditangkap oleh RecallFox
//
// Format output (text/html):
//   <div style="font-family:-apple-system,system-ui,sans-serif;font-size:13px;color:#1c1917">
//     <p style="margin:0 0 6px"><img src="{dataUrl}" alt="screenshot" style="max-width:100%;border-radius:8px;border:1px solid #e7e5e4"/></p>
//     <p style="margin:8px 0 2px"><strong>📸 {pageTitle}</strong></p>
//     <p style="margin:0 0 2px;color:#57534e">🔗 <a href="{pageUrl}">{pageUrl}</a></p>
//     <p style="margin:0 0 2px;color:#57534e">🕒 {capturedDateStr}</p>
//     <p style="margin:0 0 2px;color:#92400e;background:#fef3c7;padding:4px 8px;border-radius:4px">📝 {annotationNote}</p>   (kalau ada)
//     <p style="margin:0;color:#78716c">🔧 {modeLabel} · {dims} · RecallFox</p>
//   </div>
//
// Untuk batch (multiple screenshots), format dibungkus dalam heading bundle.

/**
 * Escape HTML special characters untuk mencegah XSS / broken HTML di clipboard.
 * @param {string} s
 * @returns {string}
 */
export function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// v3.24.27: resolveMediaCloudUrl — resolver SATU PINTU untuk URL cloud media.
// Dipakai buildScreenshotCaption / buildDocumentCaption / _mediaReportEntry agar
// SEMUA output copy (caption gambar, laporan link+keterangan, bundle) selalu
// menyertakan link yang sama (laporan user: hasil copy Bundle tidak ada linknya).
// Prioritas (sama dengan resolveImageUrl di popup.js):
//   1. item.gdriveFileUrl / item.gdrive_file_url (URL cloud Supabase/Drive)
//   2. item.linkUrl (item tipe link — URL tujuan adalah kontennya)
//   3. item.source.pages[0].url (dokumen multi-halaman)
//   4. item.source.tempUrl (file sementara host temp, v3.24.12)
//   5. item.source.url (screenshot legacy / fallback terakhir)
// @returns {string} — '' kalau tidak ada URL (gambar lokal-only)
export function resolveMediaCloudUrl(item) {
  if (!item) return '';
  if (item.gdriveFileUrl) return item.gdriveFileUrl;
  if (item.gdrive_file_url) return item.gdrive_file_url;
  if (item.linkUrl) return item.linkUrl;
  const src = item.source || {};
  if (Array.isArray(src.pages) && src.pages[0] && src.pages[0].url) return src.pages[0].url;
  if (src.tempUrl) return src.tempUrl;
  if (src.url) return src.url;
  return '';
}

/**
 * Build caption (text/plain + text/html) untuk satu screenshot.
 *
 * @param {Object} item - vault item dengan type='screenshot'
 * @param {string} [dataUrl] - data URL gambar (untuk embed di HTML). Kalau tidak
 *                             ada, HTML tidak akan menyertakan <img>.
 * @param {number} [index] - nomor urut (untuk batch). Default: tidak ada nomor.
 * @returns {{textPlain: string, textHtml: string, pageTitle: string, pageUrl: string,
 *           capturedDate: string, modeLabel: string, dims: string, annotationNote: string}}
 */
export function buildScreenshotCaption(item, dataUrl, opts = {}) {
  if (!item) return { textPlain: '', textHtml: '' };

  // v3.19.3: Item title (user-given name) = judul utama, source title = sumber
  // Sebelumnya: pageTitle = source.title → "HP Capture" jadi judul, item.title tidak muncul
  // Sekarang: "📸 Sajadah Cila — Screenshot (HP Capture)"
  const itemTitle = item.title || 'Untitled';
  const sourceTitle = item.source?.title || '';  // e.g., "HP Capture", page title
  const pageUrl = item.source?.url || '';
  const capturedAt = item.source?.capturedAt || item.createdAt || new Date().toISOString();
  const modeRaw = item.screenshotMode || 'visible';
  const modeLabel = modeRaw === 'visible' ? 'Viewport'
    : modeRaw === 'selection' ? 'Area'
    : modeRaw === 'entire' ? 'Seluruh halaman'
    : modeRaw;
  const dims = (item.screenshotWidth || 0) + '×' + (item.screenshotHeight || 0) + ' px';
  const annotationNote = item.annotationNote || item.source?.annotationNote || '';
  const capturedDateStr = new Date(capturedAt).toLocaleString('id-ID', {
    dateStyle: 'full',
    timeStyle: 'short'
  });
  const loc = item.source?.location;
  const locStr = loc ? (loc.address || ((loc.lat?.toFixed(4) || '?') + ', ' + (loc.lng?.toFixed(4) || '?'))) : '';

  // v3.24.27: Link cloud gambar — WAJIB ikut di hasil copy (laporan user:
  // "lihat hasil kopinya kyk di atas tidak ada linknya").
  const imageUrl = resolveMediaCloudUrl(item);

  const index = opts.index;
  // v3.19.3: Format judul = "📸 {itemTitle} — Screenshot" + optional " ({sourceTitle})"
  // Batch: "📸 {index}. {itemTitle} — Screenshot" + optional " ({sourceTitle})"
  const sourceSuffix = sourceTitle ? ' (' + sourceTitle + ')' : '';
  const titlePrefixPlain = (typeof index === 'number' && index > 0)
    ? '📸 ' + index + '. '
    : '📸 ';
  const titleLine = itemTitle + ' — Screenshot' + sourceSuffix;

  // === text/plain ===
  let textPlain = titlePrefixPlain + titleLine + '\n'
    + (pageUrl ? 'Sumber: ' + pageUrl + '\n' : '')
    + (imageUrl ? '🔗 Link gambar: ' + imageUrl + '\n' : '')
    + 'Waktu: ' + capturedDateStr + '\n'
    + (locStr ? '📍 Lokasi: ' + locStr + '\n' : '')
    + 'Mode: ' + modeLabel + ' · ' + dims + '\n'
    + (annotationNote ? '📝 Catatan: ' + annotationNote + '\n' : '')
    + 'Ditangkap oleh RecallFox';

  // === text/html ===
  let html = '<div style="font-family:-apple-system,system-ui,sans-serif;font-size:13px;color:#1c1917">';
  if (dataUrl) {
    html += '<p style="margin:0 0 6px"><img src="' + dataUrl + '" alt="screenshot" style="max-width:100%;border-radius:8px;border:1px solid #e7e5e4"/></p>';
  }
  html += '<p style="margin:8px 0 2px"><strong>' + titlePrefixPlain + escapeHtml(titleLine) + '</strong></p>';
  if (pageUrl) {
    html += '<p style="margin:0 0 2px;color:#57534e">🔗 <a href="' + escapeHtml(pageUrl) + '">' + escapeHtml(pageUrl) + '</a></p>';
  }
  // v3.24.27: Link cloud gambar di HTML juga
  if (imageUrl) {
    html += '<p style="margin:0 0 2px;color:#2563eb">🖼️ <a href="' + escapeHtml(imageUrl) + '" style="color:#2563eb">Link gambar (cloud)</a></p>';
  }
  html += '<p style="margin:0 0 2px;color:#57534e">🕒 ' + escapeHtml(capturedDateStr) + '</p>';
  if (locStr) {
    html += '<p style="margin:0 0 2px;color:#059669">📍 ' + escapeHtml(locStr) + '</p>';
  }
  if (annotationNote) {
    html += '<p style="margin:0 0 2px;color:#92400e;background:#fef3c7;padding:4px 8px;border-radius:4px">📝 ' + escapeHtml(annotationNote) + '</p>';
  }
  html += '<p style="margin:0;color:#78716c">🔧 ' + escapeHtml(modeLabel) + ' · ' + escapeHtml(dims) + ' · RecallFox</p>';
  html += '</div>';

  return {
    textPlain,
    textHtml: html,
    pageTitle: itemTitle,
    pageUrl,
    imageUrl,
    capturedDate: capturedDateStr,
    modeLabel,
    dims,
    annotationNote,
    location: locStr
  };
}

/**
 * Build caption untuk multiple screenshots (batch copy).
 *
 * @param {Array<{item: Object, dataUrl: string}>} screenshots
 * @returns {{textPlain: string, textHtml: string, count: number}}
 */
export function buildBatchCaption(screenshots) {
  if (!Array.isArray(screenshots) || screenshots.length === 0) {
    return { textPlain: '', textHtml: '', count: 0 };
  }

  const now = new Date();
  const dateStr = now.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
  const count = screenshots.length;

  // === text/plain (markdown-ish) ===
  let textPlain = '# 📷 Screenshot Bundle — RecallFox\n'
    + 'Tanggal: ' + dateStr + ' · Total: ' + count + ' screenshot\n\n';

  // === text/html ===
  let textHtml = '<div style="font-family:-apple-system,system-ui,sans-serif;font-size:13px;color:#1c1917">'
    + '<h1 style="margin:0 0 6px">📷 Screenshot Bundle — RecallFox</h1>'
    + '<p style="margin:0 0 10px;color:#57534e"><em>Tanggal: ' + escapeHtml(dateStr) + ' · Total: ' + count + ' screenshot</em></p>';

  for (let i = 0; i < screenshots.length; i++) {
    const { item, dataUrl } = screenshots[i];
    const idx = i + 1;
    const cap = buildScreenshotCaption(item, dataUrl, { index: idx });

    if (i > 0) {
      textPlain += '\n---\n\n';
      textHtml += '<hr style="border:none;border-top:1px solid #e7e5e4;margin:16px 0">';
    }

    // text/plain — gunakan caption + placeholder gambar
    textPlain += cap.textPlain + '\n\n';
    textPlain += '[📸 Gambar ' + idx + ' — ' + cap.dims + ']\n';

    // text/html — langsung pakai cap.textHtml (sudah lengkap dengan <img>)
    textHtml += cap.textHtml;
  }

  textPlain += '\n— Ditangkap oleh RecallFox —';
  textHtml += '</div>';

  return { textPlain, textHtml, count };
}

/**
 * v3.11.34: Tulis clipboard langsung dari popup/sidebar context.
 *
 * Keunggulan vs background-inject-into-active-tab:
 *   - Popup punya `clipboardWrite` permission → navigator.clipboard.write jalan
 *   - Gak perlu inject ke active tab (yang bisa gagal kalau tab adalah about:/moz-extension:)
 *   - User gesture dari klik tombol popup langsung tersedia
 *
 * Strategi:
 *   1. Coba navigator.clipboard.write dengan ClipboardItem multi-mime
 *      (image/png + text/html + text/plain) — best case, paste ke mana saja
 *   2. Kalau ClipboardItem undefined atau write throw, fallback ke
 *      navigator.clipboard.writeText(textPlain) — text-only, gambar hilang
 *      tapi metadata lengkap (📸, 🔗, 🕒, 📝, 🔧)
 *   3. Kalau writeText juga gagal, return error (biar caller decide fallback)
 *
 * @param {string} dataUrl - data URL gambar (e.g. 'data:image/png;base64,...')
 * @param {string} textPlain
 * @param {string} textHtml
 * @returns {Promise<{ok: boolean, message?: string, error?: string, fallback?: string}>}
 */
// v3.24.26: Strategi 1.5 — execCommand('copy') + event copy: set text/html +
// text/plain SINKRON (dalam user gesture yang masih hangat), tanpa API async
// clipboard. Kebal Permissions-Policy & tidak butuh ClipboardItem.
function rfRichCopyViaExecCommand(textHtml, textPlain) {
  if (!document.execCommand) return false;
  let ok = false;
  const handler = (e) => {
    try {
      if (e.clipboardData) {
        if (textHtml) e.clipboardData.setData('text/html', textHtml);
        if (textPlain) e.clipboardData.setData('text/plain', textPlain);
        e.preventDefault();
        ok = true;
      }
    } catch (err) { ok = false; }
  };
  document.addEventListener('copy', handler, { once: true, capture: true });
  try { document.execCommand('copy'); } catch (e) {}
  try { document.removeEventListener('copy', handler, { capture: true }); } catch (e) { document.removeEventListener('copy', handler); }
  return ok;
}

export async function writeScreenshotToClipboard(dataUrl, textPlain, textHtml) {
  // Strategy 1: ClipboardItem multi-mime
  if (typeof ClipboardItem !== 'undefined' && dataUrl) {
    try {
      const resp = await fetch(dataUrl);
      const blob = await resp.blob();
      // Convert ke PNG kalau perlu (clipboard API hanya support image/png)
      let pngBlob;
      if (blob.type === 'image/png') {
        pngBlob = blob;
      } else {
        const img = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        canvas.getContext('2d').drawImage(img, 0, 0);
        pngBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      }
      if (!pngBlob) {
        throw new Error('blob_conversion_failed');
      }

      const clipboardData = {
        'image/png': pngBlob,
        'text/html': new Blob([textHtml], { type: 'text/html' }),
        'text/plain': new Blob([textPlain], { type: 'text/plain' })
      };
      const item = new ClipboardItem(clipboardData);
      await navigator.clipboard.write([item]);
      return { ok: true, message: '✓ Gambar + keterangan tersalin ke clipboard' };
    } catch (e) {
      console.warn('[RecallFox] clipboard.write ClipboardItem failed:', e.message);
      // fall through to strategy 2
    }
  }

  // Strategy 1.5 (v3.24.26): execCommand('copy') + event copy — sinkron,
  // multi-mime text/html + text/plain (gambar ter-embed di HTML via <img src>).
  if ((textHtml || textPlain) && rfRichCopyViaExecCommand(textHtml, textPlain)) {
    return { ok: true, message: '✓ Keterangan + gambar (embedded) tersalin ke clipboard', fallback: 'exec_command_html' };
  }

  // Strategy 2: text/html + text/plain (tanpa image/png blob)
  // — text/html tetap berisi <img src="dataUrl"> jadi paste ke Google Docs /
  //   rich text editor masih menampilkan gambar.
  if (typeof ClipboardItem !== 'undefined' && textHtml) {
    try {
      const item = new ClipboardItem({
        'text/html': new Blob([textHtml], { type: 'text/html' }),
        'text/plain': new Blob([textPlain], { type: 'text/plain' })
      });
      await navigator.clipboard.write([item]);
      return { ok: true, message: '✓ Keterangan + gambar (embedded) tersalin ke clipboard' };
    } catch (e) {
      console.warn('[RecallFox] clipboard.write text/html+plain failed:', e.message);
      // fall through to strategy 3
    }
  }

  // Strategy 3: text-only fallback (writeText)
  if (textPlain && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(textPlain);
      return {
        ok: true,
        message: '✓ Keterangan tersalin (text-only — gambar tidak ikut karena browser tidak support clipboard image)',
        fallback: 'text_only'
      };
    } catch (e) {
      console.warn('[RecallFox] clipboard.writeText failed:', e.message);
    }
  }

  return { ok: false, error: 'clipboard_write_failed' };
}

/**
 * v3.14.8: Tulis HANYA gambar ke clipboard (image-only, tanpa text/plain atau text/html).
 *
 * Kenapa helper baru (bukan pakai writeScreenshotToClipboard dengan textHtml='')?
 *   - writeScreenshotToClipboard dengan textHtml='' (empty string):
 *     - Strategi 1 (ClipboardItem image/png + text/html + text/plain): sering gagal
 *       karena empty text/html Blob kadang ditolak browser, ATAU user gesture expired
 *       untuk multi-page setelah await buildCompositeImage.
 *     - Strategi 2 (if textHtml): SKIP karena '' falsy.
 *     - Strategi 3 (writeText): fallback ke text-only, hanya salin label pendek.
 *     - Hasil: user lihat cuma teks "Laporan Bulanan (3 halaman)" → dianggap "tidak berfungsi".
 *
 * Strategi helper baru:
 *   A. ClipboardItem({ 'image/png': pngBlob }) — single mime, paling robust.
 *      Paste ke WA/Telegram/Google Docs akan menampilkan gambar.
 *      Firefox 121+ dan Chrome 76+ support ClipboardItem dengan single image/png.
 *   B. (fallback) ClipboardItem({ 'text/html': '<img src="dataUrl">' }) — embed gambar
 *      di HTML supaya paste ke rich text editor (Google Docs, Gmail) tetap menampilkan gambar.
 *      WA/Telegram chat box tidak render HTML → hanya tampil textPlain fallback.
 *   C. (last resort) navigator.clipboard.writeText(dataUrl) — salin dataUrl sebagai teks
 *      (untuk debug — user paste ke editor bisa lihat data URL).
 *
 * @param {string} dataUrl - data URL gambar (e.g. 'data:image/png;base64,...')
 * @returns {Promise<{ok: boolean, message?: string, error?: string, fallback?: string}>}
 */
// v3.24.26: Strategi A2 — execCommand('copy') dgn SELEKSI <img>: browser
// menaruh image/png ke clipboard (perilaku sama dgn "Copy Image" klik kanan).
// Sinkron dalam user gesture, kebal Permissions-Policy async clipboard.
async function rfImageCopyViaSelection(dataUrl) {
  if (!document.execCommand) return false;
  const img = document.createElement('img');
  img.src = dataUrl;
  img.style.cssText = 'position:fixed;left:-10000px;top:0;width:auto;height:auto;max-width:none;max-height:none;z-index:-1;opacity:0.01;pointer-events:none';
  document.body.appendChild(img);
  try {
    try {
      if (img.decode) await img.decode();
      else await new Promise((res, rej) => { img.onload = res; img.onerror = rej; setTimeout(res, 3000); });
    } catch (e) { /* tetap coba copy walau decode throws */ }
    const range = document.createRange();
    range.selectNode(img);
    const sel = window.getSelection();
    const oldRanges = [];
    for (let i = 0; i < sel.rangeCount; i++) oldRanges.push(sel.getRangeAt(i).cloneRange());
    sel.removeAllRanges();
    sel.addRange(range);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    sel.removeAllRanges();
    for (const r of oldRanges) { try { sel.addRange(r); } catch (e) {} }
    return !!ok;
  } finally {
    try { img.remove(); } catch (e) {}
  }
}

export async function writeImageOnlyToClipboard(dataUrl) {
  if (!dataUrl) return { ok: false, error: 'no_data_url' };

  // ===== Convert ke PNG blob =====
  let pngBlob;
  try {
    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
    if (blob.type === 'image/png') {
      pngBlob = blob;
    } else {
      const img = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext('2d').drawImage(img, 0, 0);
      pngBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    }
    if (!pngBlob) return { ok: false, error: 'blob_conversion_failed' };
  } catch (e) {
    console.warn('[RecallFox] writeImageOnly: blob conversion failed:', e.message);
    return { ok: false, error: 'blob_fetch_failed: ' + e.message };
  }

  // ===== Strategi A: ClipboardItem image/png only (best case) =====
  // Single mime type — paling robust di Firefox 121+ dan Chrome 76+.
  // Paste ke WA/Telegram/Google Docs akan menampilkan gambar.
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      const item = new ClipboardItem({ 'image/png': pngBlob });
      await navigator.clipboard.write([item]);
      return { ok: true, message: '✓ Gambar tersalin ke clipboard' };
    } catch (e) {
      console.warn('[RecallFox] writeImageOnly strategi A (image/png) failed:', e.message);
      // fall through to strategi B
    }
  }

  // ===== Strategi A2 (v3.24.26): execCommand copy image-selection =====
  // Sinkron dalam user gesture — kebal policy async clipboard. Berhasil di
  // Chrome & Firefox modern; gagal → lanjut strategi B.
  try {
    if (await rfImageCopyViaSelection(dataUrl)) {
      return { ok: true, message: '✓ Gambar tersalin ke clipboard', fallback: 'exec_command_image' };
    }
  } catch (e) {
    console.warn('[RecallFox] writeImageOnly strategi A2 (execCommand) failed:', e.message);
  }

  // ===== Strategi B: text/html dengan <img src="dataUrl"> embedded =====
  // Fallback untuk browser yang reject ClipboardItem single-mime, atau untuk
  // konteks yang butuh rich text (Google Docs, Gmail, Slack).
  // WA/Telegram chat box tidak render HTML → user akan lihat textPlain fallback.
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      const html = '<img src="' + dataUrl + '" alt="gambar RecallFox" style="max-width:100%" />';
      const plain = '[Gambar RecallFox — paste ke rich text editor untuk menampilkan]';
      const item = new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' })
      });
      await navigator.clipboard.write([item]);
      return { ok: true, message: '✓ Gambar tersalin (embedded HTML)', fallback: 'html_embedded' };
    } catch (e) {
      console.warn('[RecallFox] writeImageOnly strategi B (text/html) failed:', e.message);
      // fall through to strategi C
    }
  }

  // ===== Strategi C: text-only fallback (writeText dengan dataUrl) =====
  // Last resort — salin dataUrl sebagai teks panjang. User bisa paste ke editor
  // untuk debug, atau paste ke markdown editor yang support data URL.
  // Tidak ideal tapi lebih baik daripada gagal total.
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(dataUrl);
      return {
        ok: true,
        message: '✓ Data URL gambar tersalin (text-only — browser tidak support clipboard image)',
        fallback: 'data_url_text'
      };
    } catch (e) {
      console.warn('[RecallFox] writeImageOnly strategi C (writeText) failed:', e.message);
    }
  }

  return { ok: false, error: 'clipboard_image_not_supported' };
}

/**
 * v3.12.0 (Fase 7): Build caption (text/plain + text/html) untuk satu dokumen
 * multi-halaman (type='document'). Format paralel dengan buildScreenshotCaption
 * tapi dengan header 📄 + info jumlah halaman + catatan dari source.annotationNote.
 *
 * Dipakai oleh:
 *   - popup/popup.js copyScreenshotToClipboard (dipakai juga utk document via itemSheet)
 *   - popup/popup.js copyScreenshotMetaToClipboard (text-only)
 *   - popup/popup.js vaultBatchCopyAction + vaultBatchCopyMetaAction (batch document)
 *
 * @param {Object} item - vault item dengan type='document'
 * @param {string} [dataUrl] - data URL gambar (untuk embed di HTML). Bisa null.
 * @param {Object} [opts]
 * @param {number} [opts.currentPage] - halaman ke berapa (1-based) — dipakai kalau
 *   user copy 1 halaman dari viewer. Default: tidak ada (dianggap semua halaman).
 * @param {number} [opts.index] - nomor urut (untuk batch). Default: tidak ada nomor.
 * @returns {{textPlain: string, textHtml: string, pageTitle: string, capturedDate: string,
 *           totalPages: number, annotationNote: string}}
 */
export function buildDocumentCaption(item, dataUrl, opts = {}) {
  if (!item) return { textPlain: '', textHtml: '' };

  // v3.19.3: Item title = judul utama (sama seperti screenshot caption)
  const itemTitle = item.title || 'Dokumen';
  const sourceTitle = item.source?.title || '';
  const capturedAt = item.source?.capturedAt || item.createdAt || new Date().toISOString();
  const totalPages = Array.isArray(item.source?.pages) ? item.source.pages.length : 1;
  const annotationNote = item.annotationNote || item.source?.annotationNote || '';
  const capturedDateStr = new Date(capturedAt).toLocaleString('id-ID', {
    dateStyle: 'full',
    timeStyle: 'short'
  });
  const loc = item.source?.location;
  const locStr = loc ? (loc.address || ((loc.lat?.toFixed(4) || '?') + ', ' + (loc.lng?.toFixed(4) || '?'))) : '';

  const currentPage = opts.currentPage;
  const index = opts.index;

  // v3.24.27: Link cloud dokumen — konsisten dengan caption screenshot
  const imageUrl = resolveMediaCloudUrl(item);

  // v3.19.3: Format = "📄 {itemTitle} — Dokumen" + optional " ({sourceTitle})"
  const sourceSuffix = sourceTitle ? ' (' + sourceTitle + ')' : '';
  const titlePrefixPlain = (typeof index === 'number' && index > 0)
    ? '📄 ' + index + '. '
    : '📄 ';
  let titleLine = itemTitle + ' — Dokumen' + sourceSuffix;

  let pageSuffix = '';
  if (totalPages > 1) {
    if (typeof currentPage === 'number' && currentPage > 0) {
      pageSuffix = ' (hal ' + currentPage + '/' + totalPages + ')';
    } else {
      pageSuffix = ' (' + totalPages + ' halaman)';
    }
  }

  // === text/plain ===
  let textPlain = titlePrefixPlain + titleLine + pageSuffix + '\n'
    + (imageUrl ? '🔗 Link dokumen: ' + imageUrl + '\n' : '')
    + 'Waktu: ' + capturedDateStr + '\n'
    + (locStr ? '📍 Lokasi: ' + locStr + '\n' : '')
    + (totalPages > 1 ? 'Total halaman: ' + totalPages + '\n' : '')
    + (annotationNote ? '📝 Catatan: ' + annotationNote + '\n' : '')
    + 'Ditangkap oleh RecallFox';

  // === text/html ===
  let html = '<div style="font-family:-apple-system,system-ui,sans-serif;font-size:13px;color:#1c1917">';
  if (dataUrl) {
    html += '<p style="margin:0 0 6px"><img src="' + dataUrl + '" alt="dokumen" style="max-width:100%;border-radius:8px;border:1px solid #e7e5e4"/></p>';
  }
  html += '<p style="margin:8px 0 2px"><strong>' + titlePrefixPlain + escapeHtml(titleLine) + escapeHtml(pageSuffix) + '</strong></p>';
  // v3.24.27: Link cloud dokumen di HTML juga
  if (imageUrl) {
    html += '<p style="margin:0 0 2px;color:#2563eb">📄 <a href="' + escapeHtml(imageUrl) + '" style="color:#2563eb">Link dokumen (cloud)</a></p>';
  }
  html += '<p style="margin:0 0 2px;color:#57534e">🕒 ' + escapeHtml(capturedDateStr) + '</p>';
  if (locStr) {
    html += '<p style="margin:0 0 2px;color:#059669">📍 ' + escapeHtml(locStr) + '</p>';
  }
  if (totalPages > 1) {
    html += '<p style="margin:0 0 2px;color:#57534e">📚 ' + totalPages + ' halaman</p>';
  }
  if (annotationNote) {
    html += '<p style="margin:0 0 2px;color:#92400e;background:#fef3c7;padding:4px 8px;border-radius:4px">📝 ' + escapeHtml(annotationNote) + '</p>';
  }
  html += '<p style="margin:0;color:#78716c">🔧 RecallFox Dokumen</p>';
  html += '</div>';

  return {
    textPlain,
    textHtml: html,
    pageTitle: itemTitle,
    imageUrl,
    capturedDate: capturedDateStr,
    totalPages,
    annotationNote,
    location: locStr
  };
}

/**
 * v3.11.38: Build composite image dari multiple screenshots dengan numbering.
 * 
 * Layout otomatis:
 *   - 1 gambar: 1 kolom (tanpa label)
 *   - 2 gambar: 1 kolom (vertical)
 *   - 3-4 gambar: 2 kolom (2x2 grid)
 *   - 5-6 gambar: 2 kolom (3x2 grid)
 *   - 7-9 gambar: 3 kolom (3x3 grid)
 * 
 * Setiap gambar diberi badge nomor di pojok kiri atas (kecuali 1 gambar).
 * Background putih, padding 12px antar gambar.
 * 
 * @param {Array<{item: Object, dataUrl: string}>} screenshots
 * @param {Object} [opts] - Options
 * @param {number} [opts.maxCellWidth=800] - Max width per cell (default 800px)
 * @param {number} [opts.padding=12] - Padding antar gambar
 * @param {boolean} [opts.showLabels=true] - Show number labels (auto false for 1 image)
 * @returns {Promise<{blob: Blob|null, width: number, height: number, error?: string}>}
 */
export async function buildCompositeImage(screenshots, opts = {}) {
  if (!Array.isArray(screenshots) || screenshots.length === 0) {
    return { blob: null, width: 0, height: 0, error: 'no_screenshots' };
  }

  const count = screenshots.length;
  const maxCellWidth = opts.maxCellWidth || 800;
  const padding = opts.padding || 12;
  
  // Auto-detect layout
  let cols = 1;
  if (count === 1) cols = 1;
  else if (count === 2) cols = 1;
  else if (count <= 4) cols = 2;
  else if (count <= 6) cols = 2;
  else if (count <= 9) cols = 3;
  else cols = 3; // max 3 cols
  
  const rows = Math.ceil(count / cols);
  
  // Show labels only for 2+ images
  const showLabels = (opts.showLabels !== false) && count > 1;

  try {
    // Load semua gambar dulu untuk dapat width/height
    const images = [];
    for (const { dataUrl } of screenshots) {
      if (!dataUrl) {
        images.push(null);
        continue;
      }
      try {
        const resp = await fetch(dataUrl);
        const blob = await resp.blob();
        const bitmap = await createImageBitmap(blob);
        images.push(bitmap);
      } catch (e) {
        console.warn('[RecallFox] buildCompositeImage: failed to load image:', e.message);
        images.push(null);
      }
    }

    // Hitung cell size (aspect ratio preserve, fit ke maxCellWidth)
    const cellWidth = maxCellWidth;
    const cellHeights = [];
    for (let i = 0; i < count; i++) {
      const img = images[i];
      if (!img) {
        cellHeights.push(cellWidth * 0.5625); // fallback 16:9
        continue;
      }
      const aspect = img.height / img.width;
      cellHeights.push(Math.round(cellWidth * aspect));
    }

    // Hitung total canvas size
    // Untuk setiap row, tinggi = max height di row tersebut
    const rowHeights = [];
    for (let r = 0; r < rows; r++) {
      let maxH = 0;
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        if (idx < count) {
          maxH = Math.max(maxH, cellHeights[idx]);
        }
      }
      rowHeights.push(maxH);
    }

    const totalWidth = cols * cellWidth + (cols - 1) * padding;
    const totalHeight = rowHeights.reduce((a, b) => a + b, 0) + (rows - 1) * padding;

    // Buat canvas
    const canvas = document.createElement('canvas');
    canvas.width = totalWidth;
    canvas.height = totalHeight;
    const ctx = canvas.getContext('2d');

    // Fill background putih
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, totalWidth, totalHeight);

    // Draw setiap gambar
    let yOffset = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        if (idx >= count) break;

        const img = images[idx];
        const x = c * (cellWidth + padding);
        const y = yOffset;
        const targetH = cellHeights[idx];

        if (img) {
          // Draw gambar (fit ke cell, preserve aspect)
          ctx.drawImage(img, x, y, cellWidth, targetH);
          
          // Draw label nomor (kecuali 1 gambar)
          if (showLabels) {
            const num = idx + 1;
            const badgeSize = Math.round(cellWidth * 0.08); // 8% of cell width
            const badgeX = x + badgeSize * 0.5;
            const badgeY = y + badgeSize * 0.5;

            // Draw circle background
            ctx.fillStyle = '#1c1917'; // dark background
            ctx.beginPath();
            ctx.arc(badgeX, badgeY, badgeSize * 0.5, 0, Math.PI * 2);
            ctx.fill();

            // Draw number text
            ctx.fillStyle = '#ffffff';
            ctx.font = `bold ${Math.round(badgeSize * 0.6)}px -apple-system, system-ui, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(num), badgeX, badgeY);
          }
        }
      }
      yOffset += rowHeights[r] + padding;
    }

    // Export ke blob
    const blob = await new Promise(resolve => {
      canvas.toBlob(resolve, 'image/png');
    });

    return { blob, width: totalWidth, height: totalHeight };
  } catch (e) {
    console.error('[RecallFox] buildCompositeImage failed:', e);
    return { blob: null, width: 0, height: 0, error: e.message };
  }
}

// ============================================================================
// v3.24.26: _mediaReportEntry — SATU entri media (baris-baris markdown) untuk
// buildBundleMediaReport & buildMediaSelectionReport. Diekstrak agar format
// per-media KEDUANYA selalu identik (permintaan user: format batch tanpa
// bundle harus sama dengan yang di bundle).
// ============================================================================
function _mediaReportEntry(item, mediaIndex) {
  const title = item.title || `Media ${mediaIndex}`;
  const typeLabel = (item.type === 'screenshot' || item.type === 'document') ? '📷' : (item.type === 'file' ? '📄' : '🔗');

  // Resolve cloud URL — v3.24.27: pakai resolveMediaCloudUrl (SATU PINTU, plus
  // dukungan source.tempUrl yang tadinya cuma ada di resolveImageUrl popup.js)
  const cloudUrl = resolveMediaCloudUrl(item);

  // Resolve annotation note
  let annotationNote = '';
  if (item.annotationNote) annotationNote = item.annotationNote;
  else if (item.source?.annotationNote) annotationNote = item.source.annotationNote;
  else if (item.body && item.type === 'file') annotationNote = item.body.slice(0, 200);

  // Resolve capture time
  let captureTime = '';
  if (item.source?.capturedAt) {
    try { captureTime = new Date(item.source.capturedAt).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' }) + ' WIB'; } catch (e) {}
  } else if (item.createdAt) {
    try { captureTime = new Date(item.createdAt).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' }) + ' WIB'; } catch (e) {}
  }

  // Resolve location
  let location = '';
  if (item.source?.location?.lat && item.source?.location?.lng) {
    location = `${item.source.location.address || 'Lokasi'} (${item.source.location.lat}, ${item.source.location.lng})`;
  }

  let urlLabel = '';
  if (item.type === 'screenshot' || item.type === 'document') urlLabel = 'Link Gambar';
  else if (item.type === 'file') urlLabel = 'Link Dokumen';
  else if (item.type === 'link') urlLabel = 'Link';
  else urlLabel = 'Link Media';

  const lines = [''];
  lines.push(`### ${typeLabel} Media ${mediaIndex}: ${title}`);
  if (cloudUrl) {
    lines.push(`- 🔗 ${urlLabel}: ${cloudUrl}`);
  } else {
    lines.push(`- 🔗 ${urlLabel}: (URL cloud belum tersedia)`);
  }
  if (annotationNote) {
    lines.push(`- 📝 Keterangan / Catatan: ${annotationNote}`);
  }
  if (captureTime) {
    lines.push(`- 🕒 Waktu Tangkap: ${captureTime}`);
  }
  if (location) {
    lines.push(`- 📍 Lokasi: ${location}`);
  }
  lines.push('');
  lines.push('---');
  return lines;
}

// ============================================================================
// v3.24.26: buildMediaSelectionReport — Format teks "🔗 Salin Link + Keterangan"
// untuk SELEKSI LANGSUNG di vault (mode batch) — TANPA perlu membuat Bundle
// dulu. Permintaan user: "jangan dibuat bundle dulu baru bisa dikopi barengan
// … tapi bisa langsung mode batch terus kopi gambar (disertai link gambarnya)
// dan keterangannya langsung".
//
// Format per-media IDENTIK dengan buildBundleMediaReport (v3.21.4), hanya
// header-nya yang menyesuaikan (bukan bundle):
//   # 📷 Media Terpilih — RecallFox
//   📅 Tanggal: ... | Total: N Media
//   ---
//   ### 📷 Media 1: [Judul]
//   - 🔗 Link Gambar: [URL cloud]
//   - 📝 Keterangan / Catatan: [annotationNote]
//   - 🕒 Waktu Tangkap: ...
//   - 📍 Lokasi: ...
//   ---
//   — Dihasilkan oleh RecallFox untuk AI Agent —
//
// @param {Array} items — array of vault items terpilih (screenshot/document/
//                        file/link; item tipe lain diabaikan caller)
// @returns {string} — formatted markdown text ('' kalau tidak ada item)
// ============================================================================
export function buildMediaSelectionReport(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  const dateStr = new Date().toLocaleDateString('id-ID', { dateStyle: 'long' });

  let parts = [];
  parts.push('# 📷 Media Terpilih — RecallFox');
  parts.push(`📅 Tanggal: ${dateStr} | Total: ${items.length} Media`);
  parts.push('');
  parts.push('---');

  let mediaIndex = 0;
  for (const item of items) {
    if (!item) continue;
    mediaIndex++;
    parts = parts.concat(_mediaReportEntry(item, mediaIndex));
  }

  parts.push('');
  parts.push('— Dihasilkan oleh RecallFox untuk AI Agent —');
  return parts.join('\n');
}

// ============================================================================
// v3.21.4: buildBundleMediaReport — Format teks "Salin Link + Keterangan"
// untuk Bundle. Salin Link Cloud Gambar N + Keterangan/Catatan N berurutan
// per-media untuk AI Agent.
//
// Format output (Markdown terstruktur):
//   # 📦 Bundle Laporan Kunjungan: [Nama Bundle]
//   📅 Tanggal Bundle: [date] | Total Item: N Media
//
//   ---
//
//   ### 📷 Media 1: [Judul]
//   - 🔗 Link Gambar: [URL]
//   - 📝 Keterangan / Catatan: [annotationNote]
//   - 🕒 Waktu Tangkap: [date]
//   - 📍 Lokasi: [location]
//
//   ---
//
//   — Dihasilkan oleh RecallFox untuk AI Agent —
//
// @param {Object} bundle — bundle object dari vault
// @param {Array} items — array of vault items (anggota bundle)
// @param {Array} notes — array of notes (anggota bundle)
// @returns {string} — formatted markdown text
// ============================================================================
export function buildBundleMediaReport(bundle, items, notes) {
  if (!bundle) return '';
  const bundleName = bundle.name || 'Bundle tanpa nama';
  const totalItems = (items?.length || 0) + (notes?.length || 0);
  const dateStr = new Date().toLocaleDateString('id-ID', { dateStyle: 'long' });

  let parts = [];
  parts.push(`# 📦 Bundle ${bundleName}`);
  parts.push(`📅 Tanggal Bundle: ${dateStr} | Total Item: ${totalItems} Media`);
  parts.push('');
  parts.push('---');

  let mediaIndex = 0;

  // Process items (screenshot, document, file, link — anything with a cloud URL)
  if (items && Array.isArray(items)) {
    for (const item of items) {
      if (!item) continue;
      mediaIndex++;
      parts = parts.concat(_mediaReportEntry(item, mediaIndex));
    }
  }

  // Process notes as text sections
  if (notes && Array.isArray(notes)) {
    for (const note of notes) {
      if (!note) continue;
      mediaIndex++;
      const noteTitle = note.title || `Catatan ${mediaIndex}`;
      const noteBody = stripHtmlForPreview(note.body || '');
      parts.push('');
      parts.push(`### 📝 Media ${mediaIndex}: ${noteTitle}`);
      if (noteBody) {
        parts.push(`- 📝 Keterangan / Catatan: ${noteBody.slice(0, 500)}`);
      }
      parts.push('');
      parts.push('---');
    }
  }

  parts.push('');
  parts.push('— Dihasilkan oleh RecallFox untuk AI Agent —');

  return parts.join('\n');
}

// Helper: strip HTML for preview (inline, not imported from elsewhere)
function stripHtmlForPreview(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}
