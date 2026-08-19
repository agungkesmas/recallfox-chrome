// lib/pdf.js — Minimal pure-JS PDF generator for single-image PDFs
// RecallFox v0.2.0
//
// Generates a PDF with one or more pages containing the supplied image.
// Pattern inspired by FireShot's fsPDF.js but simplified:
//   - Single image per PDF
//   - Multi-page split if image taller than one page
//   - JPEG-encoded XObject (DCTDecode filter)
//   - No annotations, no link hotspots, no headers/footers
//
// Public API:
//   buildPdf(imageDataUrl, opts) → Promise<Uint8Array>
//   opts:
//     quality:   number  (default 0.85)  — JPEG quality 0..1
//     title:     string  (default 'RecallFox Screenshot') — PDF metadata
//     pageWidth: number  (default 595)   — A4 width in points
//     pageHeight:number  (default 842)   — A4 height in points
//     margin:    number  (default 20)    — page margin in points

const PDF_PAGE_WIDTH = 595;  // A4 width in points (72 dpi)
const PDF_PAGE_HEIGHT = 842; // A4 height in points
const PDF_MARGIN = 20;

async function loadImageSize(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close?.();
  return size;
}

// Convert any image dataUrl to JPEG bytes.
// PDF uses DCTDecode filter which expects JPEG.
async function imageToJpegBytes(dataUrl, quality = 0.85) {
  const blob = await (await fetch(dataUrl)).blob();
  if (blob.type === 'image/jpeg' || blob.type === 'image/jpg') {
    return new Uint8Array(await blob.arrayBuffer());
  }
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  // White background — for transparent PNGs (PDF doesn't keep alpha for DCTDecode)
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const jpegBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Uint8Array(await jpegBlob.arrayBuffer());
}

export async function buildPdf(imageDataUrl, opts = {}) {
  const quality = typeof opts.quality === 'number' ? opts.quality : 0.85;
  const title = opts.title || 'RecallFox Screenshot';
  const pageWidth = opts.pageWidth || PDF_PAGE_WIDTH;
  const pageHeight = opts.pageHeight || PDF_PAGE_HEIGHT;
  const margin = opts.margin !== undefined ? opts.margin : PDF_MARGIN;

  const { width: imgW, height: imgH } = await loadImageSize(imageDataUrl);
  if (!imgW || !imgH) throw new Error('pdf: invalid image dimensions');

  const jpegBytes = await imageToJpegBytes(imageDataUrl, quality);
  if (!jpegBytes || jpegBytes.length === 0) {
    throw new Error('pdf: failed to encode JPEG');
  }

  // Scaled image dimensions on page (fit width)
  const availW = Math.max(50, pageWidth - 2 * margin);
  const availH = Math.max(50, pageHeight - 2 * margin);
  const scale = availW / imgW;
  const scaledW = imgW * scale;
  const scaledH = imgH * scale;

  // How many pages needed?
  const pagesNeeded = Math.max(1, Math.ceil(scaledH / availH));
  const sliceScaledH = scaledH / pagesNeeded;

  // Object numbering:
  //   1: Catalog
  //   2: Pages
  //   3: Image XObject
  //   4..(3+N): Page objects
  //   (4+N)..(3+2N): Content stream objects
  const imageObjNum = 3;
  const firstPageObjNum = 4;
  const firstContentObjNum = 4 + pagesNeeded;
  const totalObjects = 3 + 2 * pagesNeeded;

  const enc = new TextEncoder();
  const parts = [];
  const offsets = new Array(totalObjects + 1).fill(0);

  function push(bytes) { parts.push(bytes); }
  function pushStr(s) { push(enc.encode(s)); }
  function currentOffset() {
    let sum = 0;
    for (const p of parts) sum += p.length;
    return sum;
  }
  function startObj(num) {
    offsets[num] = currentOffset();
    pushStr(`${num} 0 obj\n`);
  }
  function endObj() {
    pushStr('\nendobj\n');
  }

  // Header
  pushStr('%PDF-1.4\n');
  // Binary marker comment — ensures PDF readers treat file as binary
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  // 1: Catalog
  startObj(1);
  pushStr(`<< /Type /Catalog /Pages 2 0 R /Metadata << /Title (${escapePdfString(title)}) >> >>`);
  endObj();

  // 2: Pages
  startObj(2);
  const kids = [];
  for (let i = 0; i < pagesNeeded; i++) kids.push(`${firstPageObjNum + i} 0 R`);
  pushStr(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pagesNeeded} >>`);
  endObj();

  // 3: Image XObject (binary)
  startObj(3);
  pushStr(`<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`);
  push(jpegBytes);
  pushStr('\nendstream');
  endObj();

  // Page + Content objects
  for (let i = 0; i < pagesNeeded; i++) {
    // Page object
    startObj(firstPageObjNum + i);
    pushStr(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im1 ${imageObjNum} 0 R >> >> /Contents ${firstContentObjNum + i} 0 R >>`);
    endObj();

    // Content stream
    // PDF y-axis is bottom-up. We position image so that page i shows slice i.
    // For page i:
    //   - Slice top (in PDF coords from top of page): margin + i*sliceScaledH
    //   - Image bottom-left x: margin
    //   - Image bottom-left y: pageHeight - margin - scaledH + i*sliceScaledH
    //
    // The image extends beyond the page (above for slices > i, below for slices < i)
    // but is clipped by the MediaBox.
    //
    // To add a margin clip, we use the re (rectangle) + W (clip) + n (no-fill) operators.
    const x = margin;
    const y = pageHeight - margin - scaledH + i * sliceScaledH;
    const clipX = margin;
    const clipY = margin;
    const clipW = pageWidth - 2 * margin;
    const clipH = pageHeight - 2 * margin;
    // Format numbers nicely (avoid scientific notation, limit precision)
    const f = (n) => Number(n.toFixed(3)).toString();
    const content = `q ${f(clipX)} ${f(clipY)} ${f(clipW)} ${f(clipH)} re W n ${f(scaledW)} 0 0 ${f(scaledH)} ${f(x)} ${f(y)} cm /Im1 Do Q`;

    startObj(firstContentObjNum + i);
    pushStr(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    endObj();
  }

  // xref table
  const xrefOffset = currentOffset();
  pushStr('xref\n');
  pushStr(`0 ${totalObjects + 1}\n`);
  pushStr('0000000000 65535 f \n');
  for (let i = 1; i <= totalObjects; i++) {
    pushStr(String(offsets[i]).padStart(10, '0') + ' 00000 n \n');
  }

  // trailer
  pushStr('trailer\n');
  pushStr(`<< /Size ${totalObjects + 1} /Root 1 0 R >>\n`);
  pushStr('startxref\n');
  pushStr(`${xrefOffset}\n`);
  pushStr('%%EOF');

  // Combine all parts
  const total = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(total);
  let cursor = 0;
  for (const p of parts) {
    result.set(p, cursor);
    cursor += p.length;
  }
  return result;
}

// Escape a string for inclusion in a PDF literal string (...).
// Per PDF spec, characters ( ) \ must be escaped.
function escapePdfString(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// Convenience: build a PDF Blob directly (useful for downloads)
export async function buildPdfBlob(imageDataUrl, opts = {}) {
  const bytes = await buildPdf(imageDataUrl, opts);
  return new Blob([bytes], { type: 'application/pdf' });
}
