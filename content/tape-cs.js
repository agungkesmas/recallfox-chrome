// content/tape-cs.js — RecallTape floating calculator (v3.14.12)
//
// FILOSOFI BARU (per request user 2026-07-25):
//   "hilangkan kolom kaku, hilangkan grand total. free kita kyk ngetik biasa
//    aja di word tapi pas enter itu auto ngitung sesuai operator yang lagi
//    diperintahkan tambah kurang bagi kali dsb operasi matematika.
//    sama dengan = juga ga da fungsinya bodoh. enter tu udah mewakili sama
//    dengan, ketika di entri tu udah ngitung bodoh."
//
// BEHAVIOR:
//   1. Free typing seperti Word — textarea biasa, user ngetik bebas apa saja
//   2. Operator inline rapat: "+1300", "/2", "*3", "-500" (TIDAK 2 kolom)
//   3. Saat tekan Enter:
//      - Hitung otomatis semua baris sampai baris itu
//      - Sisipkan garis pemisah tipis "─────"
//      - Sisipkan baris hasil (subtotal) dengan format "1.250,00  📋"
//      - Baris baru kosong untuk lanjut ngetik
//   4. Tidak ada footer BLOCK / GRAND TOTAL
//   5. Tidak ada tombol "=" (Enter sudah = hitung)
//   6. Format angka konsisten: "1.250,00" (titik ribuan, koma desimal)
//   7. Setiap baris hasil ada 📋 untuk copy nilai
//
// CARA KERJA EVALUASI:
//   - Setiap baris di-parse: cari operator awal (+ - * /) lalu angka
//   - Running total di-maintain, diupdate per baris op
//   - Baris "─────" + hasil = marker " subtotal" yang ditampilkan tapi TIDAK
//     ikut dihitung ulang (skip saat re-eval)
//   - Baris hasil (diawali "→") = display only, skip saat re-eval
//
// DESIGN:
//   - Single <textarea> free-form
//   - Dark/light theme adaptive
//   - Draggable header, resizable
//   - 4 buttons: Pin / Print / Copy / Save / Clear (tetap dipertahankan)
//   - Tidak ada result bar footer (dihapus per spec)

(async function () {
  if (window.__recallfoxTapeLoaded) return;
  window.__recallfoxTapeLoaded = true;

  let tape;
  try {
    tape = await import(browser.runtime.getURL('lib/tape.js'));
  } catch (e) {
    console.warn('[RecallFox/Tape] Failed to load lib/tape.js:', e);
    return;
  }
  const { evaluate, formatNumber, toPlainText, toMarkdown, loadSession, saveSession, savePinState } = tape;

  let host = null, shadow = null, popover = null, textarea = null;
  let statusAutosave = null;
  let pinBtn = null, isVisible = false, pinned = false;
  let saveTimer = null;

  // ===== Theme =====
  async function loadTheme() {
    try {
      const r = await browser.storage.local.get(['settings']);
      const s = r.settings || {};
      let theme = s.theme || 'auto';
      if (theme === 'auto') theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      return theme;
    } catch (e) { return 'dark'; }
  }

  // ===== Mount =====
  function mount() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'recallfox-tape-host';
    host.style.cssText = 'all:initial;position:fixed;top:0;right:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = TEMPLATE;
    popover = shadow.querySelector('.rft-popover');
    textarea = shadow.querySelector('.rft-editor');
    statusAutosave = shadow.querySelector('.rft-autosave');
    pinBtn = shadow.querySelector('.rft-pin');
    wireEvents();
  }

  // ===== Show / Hide =====
  async function show() {
    mount();
    const theme = await loadTheme();
    shadow.host.setAttribute('data-theme', theme);
    popover.classList.add('rft-show');
    isVisible = true;
    const s = await loadSession();
    if (s.text) textarea.value = s.text;
    if (s.pinned) { pinned = true; pinBtn.classList.add('rft-active'); }
    setTimeout(() => { textarea.focus(); }, 50);
  }
  function hide() { if (popover) { popover.classList.remove('rft-show'); isVisible = false; } }
  async function toggle() { if (isVisible) hide(); else await show(); }

  // ============================================================================
  // v3.14.12: ENTER = HITUNG OTOMATIS
  // ============================================================================
  // Saat user tekan Enter di akhir baris yang berisi operator + angka:
  //   1. Ambil semua baris input (skip baris hasil/separator yang sudah ada)
  //   2. Evaluasi semua baris op → dapat running total
  //   3. Sisipkan baris separator "─────" + baris hasil "→  1.250,00  📋"
  //   4. Baris baru kosong untuk lanjut ngetik
  //
  // Format baris hasil: "→  1.250,00  📋"
  //   - "→" prefix = marker "ini baris hasil, skip saat re-eval"
  //   - formatNumber(running) untuk konsistensi
  //   - 📋 icon untuk copy (click untuk copy nilai)
  //
  // Format baris separator: "─────" (5 em-dash)
  //   - Marker "ini garis pemisah subtotal"
  //   - Skip saat re-eval
  //
  // RE-EVAL LOGIC:
  //   - Saat user edit baris op (bukan Enter), re-eval semua op lines
  //   - Baris hasil lama yang sudah ada TIDAK ikut dihitung (skip "→" lines)
  //   - Tapi TIDAK auto-sisipkan baris hasil baru (hanya Enter yang trigger)
  //   - Live preview running total di status bar (kecil, tidak mengganggu)
  // ============================================================================

  // ============================================================================
  // v3.14.13: AUTO-FORMAT saat ketik
  // ============================================================================
  // Behavior baru (per request user 2026-07-25):
  //   1. Ketik digit di baris kosong → auto-prefix "+   " (operator + jarak tetap)
  //      User ketik "1" → jadi "+   1", lanjut "200" → "+   1200"
  //   2. Ketik operator (+ - * /) di akhir baris berisi → auto-newline + operator + jarak
  //      User di baris "+   1200", tekan "-" → baris baru "-   " (cursor di akhir)
  //   3. Enter → garis pemisah + hasil (sudah ada di v3.14.12)
  //   4. Format rapi: operator (1 char) + 3 spasi + angka + spasi + note opsional
  //
  // Jarak tetap: OP_GAP = '   ' (3 spasi) — supaya operator rata kiri, angka rata kanan
  // ============================================================================

  // ============================================================================
  // v3.14.14: FORMAT RAPI — operator rata kiri, angka rata kanan (right-aligned)
  // ============================================================================
  // Format baris op: "<op>   <angka right-aligned ke lebar AMT_WIDTH>  <note>"
  //   - op: 1 char (+, -, *, /)
  //   - OP_GAP: 3 spasi (jarak operator ↔ angka)
  //   - AMT_WIDTH: 12 char (lebar tetap untuk angka, right-aligned)
  //   - NOTE_GAP: 2 spasi (jarak angka ↔ keterangan)
  //   - note: keterangan opsional
  //
  // Contoh:
  //   +        1.200  Gaji
  //   -          200  Makan
  //   *            2  Pajak 2x
  //   /            4  Bagi 4 orang
  //   +           10%  PPN
  //
  // Baris hasil juga right-aligned:
  //   →        1.000  📋
  // ============================================================================

  const OP_GAP = '   ';      // 3 spasi — jarak operator ↔ angka
  const AMT_WIDTH = 12;      // lebar tetap untuk angka (right-aligned)
  const NOTE_GAP = '  ';     // 2 spasi — jarak angka ↔ keterangan

  // Format satu baris op menjadi format rapi
  // Input: raw line seperti "+   1200  Gaji" atau "1200" atau "+10% PPN"
  // Output: "+        1.200  Gaji" (operator + padding + angka right-aligned + note)
  function formatOpLine(rawLine) {
    const trimmed = rawLine.trim();
    if (!trimmed) return rawLine;  // baris kosong, biarkan

    // Skip separator + hasil
    if (/^[─=─]{3,}$/.test(trimmed) || /^-{3,}$/.test(trimmed) || /^={3,}$/.test(trimmed)) return rawLine;
    if (/^[→»•]/.test(trimmed)) return rawLine;

    // Parse: optional operator + angka (dengan suffix/percent) + optional note
    const m = trimmed.match(/^([+\-*/]?)\s*([\d.,]+(?:\s*(?:juta|jt|ribu|rb|bn|k|m|b)\b)?\s*%?)\s*(.*)$/i);
    if (!m) return rawLine;  // bukan op line (comment), biarkan apa adanya

    const op = m[1] || '+';
    const amtStr = m[2].trim().replace(/\s+/g, '');  // normalize spasi dalam amount
    const note = (m[3] || '').trim();

    // Right-align angka ke AMT_WIDTH
    const amtPadded = amtStr.padStart(AMT_WIDTH, ' ');

    // Build baris rapi
    let line = op + OP_GAP + amtPadded;
    if (note) line += NOTE_GAP + note;
    return line;
  }

  // Format baris hasil (subtotal) — right-aligned juga supaya sejajar dengan baris op
  function formatResultLine(running) {
    const formatted = formatNumber(running);
    const amtPadded = formatted.padStart(AMT_WIDTH, ' ');
    return '→' + OP_GAP + amtPadded + NOTE_GAP + '📋';
  }

  // Re-format semua baris op di textarea (dipanggil saat Enter)
  // supaya setelah user ketik manual, semua baris op jadi right-aligned rapi
  function reformatAllOpLines(val) {
    const lines = val.split('\n');
    const reformatted = lines.map(ln => formatOpLine(ln));
    return reformatted.join('\n');
  }

  function handleAutoFormatKey(e) {
    // Hanya intercept single character key tanpa modifier
    if (e.key.length !== 1) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const pos = textarea.selectionStart;
    const val = textarea.value;

    // Kalau ada selection, biarkan default (replace selection)
    if (textarea.selectionStart !== textarea.selectionEnd) return;

    // Cari baris saat ini
    const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
    const currentLine = val.slice(lineStart, pos);  // dari awal baris sampai cursor
    const trimmedCurrent = currentLine.trim();

    // Cek apakah cursor di akhir baris (atau end of text)
    const atEndOfLine = (pos === val.length) || (val[pos] === '\n');
    if (!atEndOfLine) return;  // hanya intercept di akhir baris

    // Skip baris separator dan hasil
    if (/^[─=─]{3,}$/.test(trimmedCurrent) || /^-{3,}$/.test(trimmedCurrent) || /^={3,}$/.test(trimmedCurrent)) return;
    if (/^[→»•]/.test(trimmedCurrent)) return;

    const key = e.key;

    // ===== v3.14.14: Ketik digit di baris kosong → auto-prefix "+   " =====
    // (angka pertama otomatis dianggap positif)
    // Format sementara "+   1" — akan di-reformat right-aligned saat Enter
    if (/^\d$/.test(key) && trimmedCurrent === '') {
      e.preventDefault();
      const insert = '+' + OP_GAP + key;
      const before = val.slice(0, pos);
      const after = val.slice(pos);
      textarea.value = before + insert + after;
      textarea.setSelectionRange(pos + insert.length, pos + insert.length);
      updateStatus();
      scheduleSave();
      return;
    }

    // ===== Ketik operator (+ - * /) di akhir baris berisi → auto-newline =====
    // Baris baru dengan operator + jarak, cursor di akhir siap ketik angka
    if (/[+\-*/]/.test(key) && trimmedCurrent !== '') {
      e.preventDefault();
      const op = key;
      const insert = '\n' + op + OP_GAP;
      const before = val.slice(0, pos);
      const after = val.slice(pos);
      textarea.value = before + insert + after;
      textarea.setSelectionRange(pos + insert.length, pos + insert.length);
      textarea.scrollTop = textarea.scrollHeight;
      updateStatus();
      scheduleSave();
      return;
    }

    // ===== v3.14.14: Ketik % di akhir angka → biarkan (percent support) =====
    // Tidak perlu intercept — % akan di-parse evaluator sebagai percent flag
  }

  function handleEnterKey(e) {
    // Cek apakah cursor di akhir baris (atau di akhir text)
    const pos = textarea.selectionStart;
    const val = textarea.value;

    // Kalau ada selection, biarkan default (Enter replace selection)
    if (textarea.selectionStart !== textarea.selectionEnd) return;

    // Cari baris saat ini
    const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
    const lineEnd = pos;  // cursor pos = end of current line (since user about to press Enter)
    const currentLine = val.slice(lineStart, lineEnd).trim();

    // Kalau baris kosong, biarkan default Enter (insert blank line)
    if (!currentLine) return;

    // Cek apakah baris saat ini adalah baris OP (punya operator + angka)
    // Pattern: optional operator (+ - * /) followed by number
    // Atau angka saja (implicit add)
    const isOpLine = /^([+\-*/]?)\s*[\d.,]+\s*(k|rb|jt|juta|ribu|m|b|bn)?%?/i.test(currentLine);

    // Kalau bukan op line (mis. comment), biarkan default Enter
    if (!isOpLine) return;

    // Cek apakah baris saat ini sudah diakhiri % (percent) atau ada note
    // Pattern op line: [+|-|*|/]<angka>[suffix][%][ note]
    // Kita hanya trigger auto-result kalau baris adalah op murni (atau op + note)
    const opMatch = currentLine.match(/^([+\-*/]?)\s*([\d.,]+(?:k|rb|jt|juta|ribu|m|b|bn)?%?)\s*(.*)$/i);
    if (!opMatch) return;

    // ===== ENTER = HITUNG =====
    e.preventDefault();

    // v3.14.14: Re-format semua baris op supaya right-aligned rapi
    // (user mungkin ketik manual dengan spasi acak, kita normalize)
    const reformattedVal = reformatAllOpLines(val);
    if (reformattedVal !== val) {
      textarea.value = reformattedVal;
      // Update posisi cursor supaya tetap di akhir baris saat ini
      // (karena reformat bisa ubah panjang baris, hitung ulang)
      const newLines = reformattedVal.split('\n');
      const currentLineIdxNew = val.slice(0, pos).split('\n').length - 1;
      let newPos = 0;
      for (let i = 0; i <= currentLineIdxNew; i++) {
        newPos += newLines[i].length + 1;  // +1 for \n
      }
      // newPos sekarang di awal baris baru (setelah \n baris saat ini)
      // Kita mau cursor di akhir baris saat ini (sebelum \n)
      newPos = newPos - 1;  // back up ke sebelum \n
      textarea.setSelectionRange(newPos, newPos);
      // Update val + pos untuk langkah berikutnya
      val = textarea.value;
      pos = newPos;
    }

    // Ambil semua baris dari awal sampai baris saat ini (INCLUSIVE)
    const allLines = val.split('\n');
    const currentLineIdx = val.slice(0, pos).split('\n').length - 1;

    // Ambil baris-baris op saja (skip separator "─────" dan hasil "→")
    const opLinesForEval = [];
    for (let i = 0; i <= currentLineIdx; i++) {
      const ln = allLines[i];
      const trimmed = ln.trim();
      // Skip baris separator (mulai dengan "──" atau "==" karakter berulang)
      if (/^[─=─]{3,}$/.test(trimmed) || /^-{3,}$/.test(trimmed) || /^={3,}$/.test(trimmed)) continue;
      // Skip baris hasil (mulai dengan "→" atau "»" atau "•")
      if (/^[→»•]/.test(trimmed)) continue;
      opLinesForEval.push(ln);
    }

    // Evaluasi untuk dapat running total
    const result = evaluate(opLinesForEval);
    const running = result.grandTotal;

    // v3.14.14: Sisipkan separator + baris hasil (right-aligned) + baris baru kosong
    const separator = '─────';
    const resultLine = formatResultLine(running);
    const insert = '\n' + separator + '\n' + resultLine + '\n';

    // Insert di posisi cursor (yang ada di akhir baris saat ini)
    const before = val.slice(0, pos);
    const after = val.slice(pos);
    textarea.value = before + insert + after;

    // Pindah cursor ke baris baru kosong (setelah result line)
    const newCursorPos = pos + insert.length;
    textarea.setSelectionRange(newCursorPos, newCursorPos);

    // Scroll ke bawah supaya cursor terlihat
    textarea.scrollTop = textarea.scrollHeight;

    // Update status + save
    updateStatus();
    scheduleSave();
  }

  // ============================================================================
  // Live status update (tidak menyisipkan baris, hanya update status bar)
  // ============================================================================
  function updateStatus() {
    const text = textarea.value;
    const lines = text.split('\n');
    // Ambil baris op saja (skip separator + hasil)
    const opLines = [];
    for (const ln of lines) {
      const trimmed = ln.trim();
      if (/^[─=─]{3,}$/.test(trimmed) || /^-{3,}$/.test(trimmed) || /^={3,}$/.test(trimmed)) continue;
      if (/^[→»•]/.test(trimmed)) continue;
      opLines.push(ln);
    }
    const result = evaluate(opLines);
    if (statusAutosave) {
      if (result.error) {
        statusAutosave.textContent = '⚠ ' + result.error;
        statusAutosave.style.color = '#FB7185';
      } else {
        statusAutosave.textContent = '✓ Tersimpan otomatis · Total: ' + formatNumber(result.grandTotal);
        statusAutosave.style.color = '';
      }
    }
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    if (statusAutosave) {
      statusAutosave.textContent = '⏳ Menyimpan…';
      statusAutosave.style.color = '#F0B64A';
    }
    saveTimer = setTimeout(async () => {
      try { await saveSession(textarea.value); } catch (e) {}
      updateStatus();
    }, 400);
  }

  // ===== Click handler untuk 📋 icon di baris hasil =====
  // Karena textarea tidak bisa punya clickable elements, kita handle via
  // double-click di baris hasil → copy nilai ke clipboard.
  function handleResultLineDoubleClick() {
    const pos = textarea.selectionStart;
    const val = textarea.value;
    const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
    let lineEnd = val.indexOf('\n', pos);
    if (lineEnd === -1) lineEnd = val.length;
    const currentLine = val.slice(lineStart, lineEnd);

    // Kalau baris hasil (mulai dengan "→")
    if (currentLine.trim().startsWith('→')) {
      // Extract angka setelah "→" dan sebelum "📋"
      const match = currentLine.match(/→\s*([\d.,-]+)\s*📋?/);
      if (match) {
        const numStr = match[1];
        // Convert "1.250,00" → "1250.00" untuk clipboard (atau biarkan format ID)
        // User minta format konsisten, jadi copy persis seperti tampilan
        navigator.clipboard.writeText(numStr).then(() => {
          toast('📋 ' + numStr + ' tersalin');
        }).catch(() => {
          // Fallback
          const ta = document.createElement('textarea');
          ta.value = numStr; document.body.appendChild(ta); ta.select();
          try { document.execCommand('copy'); toast('📋 ' + numStr + ' tersalin'); } catch (e2) {}
          ta.remove();
        });
      }
    }
  }

  // ===== Actions =====
  async function doCopy() {
    const text = textarea.value;
    // Ambil baris op saja untuk evaluasi (skip separator + hasil)
    const lines = text.split('\n');
    const opLines = [];
    for (const ln of lines) {
      const trimmed = ln.trim();
      if (/^[─=─]{3,}$/.test(trimmed) || /^-{3,}$/.test(trimmed) || /^={3,}$/.test(trimmed)) continue;
      if (/^[→»•]/.test(trimmed)) continue;
      opLines.push(ln);
    }
    const result = evaluate(opLines);
    // Build plain text: op lines + separator + hasil
    const plain = buildPlainTextForCopy(opLines, result);
    try {
      await navigator.clipboard.writeText(plain);
      flashBtn('.rft-copy');
      toast('📋 Tape tersalin');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = plain; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); flashBtn('.rft-copy'); toast('📋 Tape tersalin'); } catch (e2) {}
      ta.remove();
    }
  }

  function buildPlainTextForCopy(opLines, result) {
    const out = [];
    out.push('🧮 RecallTape');
    out.push(new Date().toLocaleString('id-ID'));
    out.push('');
    let running = 0;
    for (let i = 0; i < opLines.length; i++) {
      const ln = opLines[i];
      const trimmed = ln.trim();
      if (!trimmed) continue;
      out.push(trimmed);
    }
    out.push('─────');
    out.push('→  ' + formatNumber(result.grandTotal) + '  📋');
    return out.join('\n');
  }

  // v3.14.12: Print via hidden iframe + @page 80mm — sesuai format baru
  function doPrint() {
    const text = textarea.value;
    if (!text.trim()) { toast('Tape kosong'); return; }

    // Ambil semua baris (termasuk separator + hasil) untuk display
    const allLines = text.split('\n');

    // Build receipt HTML
    const lines = [];
    lines.push('<div class="rct-hd"><h1>🧮 RecallTape</h1><div class="rct-date">' + new Date().toLocaleString('id-ID') + '</div></div>');
    for (const ln of allLines) {
      const trimmed = ln.trim();
      if (!trimmed) continue;
      // Separator line
      if (/^[─=─]{3,}$/.test(trimmed) || /^-{3,}$/.test(trimmed) || /^={3,}$/.test(trimmed)) {
        lines.push('<div class="rct-sep"></div>');
        continue;
      }
      // Result line (mulai dengan "→")
      if (/^[→»•]/.test(trimmed)) {
        const match = trimmed.match(/→\s*([\d.,-]+)\s*📋?/);
        if (match) {
          lines.push('<div class="rct-line rct-subtotal"><span class="rct-op">→</span><span class="rct-val">' + esc(match[1]) + '</span></div>');
        }
        continue;
      }
      // Op line — parse untuk display rapi
      const opMatch = trimmed.match(/^([+\-*/]?)\s*([\d.,]+(?:k|rb|jt|juta|ribu|m|b|bn)?%?)\s*(.*)$/i);
      if (opMatch) {
        const sym = opMatch[1] || '+';
        const amt = opMatch[2];
        const note = opMatch[3] || '';
        const noteHtml = note ? '<span class="rct-note">' + esc(note) + '</span>' : '';
        lines.push('<div class="rct-line"><span class="rct-op">' + sym + '</span><span class="rct-amt">' + esc(amt) + '</span>' + noteHtml + '</div>');
      } else {
        // Comment / plain text
        lines.push('<div class="rct-line rct-comment">' + esc(trimmed) + '</div>');
      }
    }

    const html = '<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><title>RecallTape Resi</title>' +
      '<style>' +
      '@page { size: 80mm auto; margin: 2mm; }' +
      '* { box-sizing: border-box; margin: 0; padding: 0; }' +
      'html, body { background: #fff; color: #000; font-family: "Courier New", Menlo, Consolas, monospace; font-size: 10px; line-height: 1.55; }' +
      'body { padding: 4mm; max-width: 72mm; margin: 0 auto; }' +
      '.rct-hd { text-align: center; padding-bottom: 3mm; border-bottom: 1px dashed #000; margin-bottom: 3mm; }' +
      '.rct-hd h1 { font-size: 13px; font-weight: 700; }' +
      '.rct-date { font-size: 9px; color: #666; margin-top: 1px; }' +
      '.rct-line { padding: 1px 0; display: flex; align-items: baseline; }' +
      '.rct-line .rct-op { width: 12px; flex: none; font-weight: 700; }' +
      '.rct-line .rct-amt { flex: 1; padding-left: 4px; font-variant-numeric: tabular-nums; }' +
      '.rct-line .rct-note { flex: none; max-width: 50%; margin-left: 6px; color: #555; font-family: Arial, sans-serif; font-size: 9px; }' +
      '.rct-comment { color: #666; font-family: Arial, sans-serif; font-style: italic; padding-left: 14px; }' +
      '.rct-sep { border-top: 1px dashed #999; margin: 3px 0; }' +
      '.rct-subtotal { font-weight: 700; padding-top: 2px; }' +
      '.rct-subtotal .rct-val { font-variant-numeric: tabular-nums; }' +
      '.rct-foot { margin-top: 4mm; padding-top: 2mm; border-top: 1px dashed #000; text-align: center; font-size: 9px; color: #666; font-family: Arial, sans-serif; }' +
      '@media print { body { padding: 2mm; } }' +
      '</style></head><body>' +
      lines.join('\n') +
      '<div class="rct-foot">RecallFox · dicetak ' + new Date().toISOString().slice(0,10) + '</div>' +
      '</body></html>';

    // Hidden iframe di document.body (BUKAN shadow) supaya print dialog OK
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none;z-index:-1;';
    document.body.appendChild(iframe);
    try {
      const doc = iframe.contentWindow.document;
      doc.open(); doc.write(html); doc.close();
    } catch (e) {
      toast('Gagal mencetak: ' + e.message);
      iframe.remove();
      return;
    }
    setTimeout(() => {
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } catch (e) {
        toast('Gagal print: ' + e.message);
      }
      setTimeout(() => { try { iframe.remove(); } catch (e) {} }, 2000);
    }, 300);
    flashBtn('.rft-print');
  }

  // v3.14.12: Save ke vault sebagai "catatan" (note)
  async function doSave() {
    const text = textarea.value;
    if (!text.trim()) { toast('Tape kosong'); return; }
    try {
      // Ambil baris op saja untuk eval
      const lines = text.split('\n');
      const opLines = [];
      for (const ln of lines) {
        const trimmed = ln.trim();
        if (/^[─=─]{3,}$/.test(trimmed) || /^-{3,}$/.test(trimmed) || /^={3,}$/.test(trimmed)) continue;
        if (/^[→»•]/.test(trimmed)) continue;
        opLines.push(ln);
      }
      const result = evaluate(opLines);
      const md = buildPlainTextForCopy(opLines, result);
      await browser.runtime.sendMessage({
        type: 'SAVE_TAPE_TO_VAULT',
        markdown: md,
        text: text,
        grandTotal: result.grandTotal
      });
      toast('✓ Tersimpan ke Catatan');
      flashBtn('.rft-save');
    } catch (e) { toast('Gagal simpan: ' + e.message); }
  }

  function doClear() {
    if (!textarea.value.trim()) return;
    if (!confirm('Kosongkan tape?')) return;
    textarea.value = '';
    updateStatus();
    scheduleSave();
    textarea.focus();
    flashBtn('.rft-clear');
  }

  // ===== Helpers =====
  function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function flashBtn(sel) {
    const btn = shadow.querySelector(sel);
    if (!btn) return;
    btn.classList.add('rft-flash');
    setTimeout(() => btn.classList.remove('rft-flash'), 600);
  }
  function toast(msg) {
    const t = shadow.querySelector('.rft-toast');
    if (!t) return;
    t.textContent = msg; t.classList.add('rft-show');
    setTimeout(() => t.classList.remove('rft-show'), 2000);
  }

  // ===== Drag =====
  function makeDraggable() {
    const hd = shadow.querySelector('.rft-hd');
    let dragging = false, dx = 0, dy = 0;
    hd.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true;
      const rect = popover.getBoundingClientRect();
      dx = e.clientX - rect.left;
      dy = e.clientY - rect.top;
      popover.style.transition = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      popover.style.left = (e.clientX - dx) + 'px';
      popover.style.top = (e.clientY - dy) + 'px';
      popover.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => {
      if (dragging) { dragging = false; popover.style.transition = ''; }
    });
  }

  // ===== Wire events =====
  function wireEvents() {
    // Textarea input → live status update + debounced save
    // TIDAK auto-sisipkan baris hasil (hanya Enter yang trigger)
    textarea.addEventListener('input', () => { updateStatus(); scheduleSave(); });

    // KEYDOWN — auto-format + Enter = hitung otomatis
    textarea.addEventListener('keydown', (e) => {
      // Ctrl+Enter → save to vault
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        doSave();
        return;
      }
      // Esc → hide (unless pinned)
      if (e.key === 'Escape' && !pinned) {
        e.preventDefault();
        hide();
        return;
      }
      // v3.14.13: Auto-format saat ketik (digit → auto-prefix +, operator → auto-newline)
      handleAutoFormatKey(e);
      // v3.14.12: Enter = hitung otomatis (bukan =)
      if (e.key === 'Enter' && !e.shiftKey) {
        handleEnterKey(e);
        // Shift+Enter = baris baru biasa (multiline note) — biarkan default
      }
      // = TIDAK ada fungsinya — Enter sudah = hitung
      // (kalau user tekan =, biarkan default insert karakter "=" sebagai comment)
    });

    // Double-click di baris hasil → copy nilai
    textarea.addEventListener('dblclick', () => {
      handleResultLineDoubleClick();
    });

    // Buttons
    pinBtn.addEventListener('click', async () => {
      pinned = !pinned;
      pinBtn.classList.toggle('rft-active', pinned);
      await savePinState(pinned);
    });
    shadow.querySelector('.rft-print').addEventListener('click', doPrint);
    shadow.querySelector('.rft-copy').addEventListener('click', doCopy);
    shadow.querySelector('.rft-save').addEventListener('click', doSave);
    shadow.querySelector('.rft-clear').addEventListener('click', doClear);

    // Click outside → hide (unless pinned)
    document.addEventListener('mousedown', (e) => {
      if (!isVisible || pinned) return;
      if (host.contains(e.target)) return;
      hide();
    }, true);

    // Theme change listener
    browser.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'THEME_CHANGED') shadow.host.setAttribute('data-theme', msg.theme);
    });

    makeDraggable();
  }

  // ===== Message listener =====
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'OPEN_TAPE') toggle();
    else if (msg.type === 'ADD_TO_TAPE') {
      show();
      textarea.value += (textarea.value ? '\n' : '') + msg.text;
      updateStatus();
      scheduleSave();
    }
    else if (msg.type === 'SHOW_TAPE') show();
    else if (msg.type === 'HIDE_TAPE') hide();
  });

  loadSession().then((s) => { pinned = s.pinned; });

  // ===== Template (HTML + CSS inlined in Shadow DOM) =====
  // v3.14.12: HAPUS footer BLOCK + GRAND TOTAL.
  // Hanya: header (draggable) + textarea (free typing) + status bar (live total).
  // User tekan Enter → baris hasil otomatis muncul di textarea.
  const TEMPLATE = `
<style>
:host{all:initial}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

.rft-popover{
  position:fixed; top:60px; right:14px;
  width:340px; max-height:560px;
  background:#0E182A; color:#E8EEF7;
  border:1px solid #1A293D; border-radius:12px;
  box-shadow:0 18px 50px rgba(0,0,0,.55), 0 2px 8px rgba(0,0,0,.4);
  display:flex; flex-direction:column; overflow:hidden;
  font-family:Menlo,Consolas,"Courier New",monospace; font-size:13px;
  opacity:0; transform:translateY(-6px) scale(.98); pointer-events:none;
  transition:opacity .15s ease, transform .15s ease;
  resize:both; min-width:280px; min-height:340px;
}
.rft-popover.rft-show{ opacity:1; transform:translateY(0) scale(1); pointer-events:auto }

:host([data-theme="light"]) .rft-popover{
  background:#F8FAFC; color:#1E293B; border-color:#E2E8F0;
  box-shadow:0 18px 50px rgba(0,0,0,.12), 0 2px 8px rgba(0,0,0,.08);
}

/* Header — draggable */
.rft-hd{
  display:flex; align-items:center; gap:6px;
  padding:7px 10px; flex:none; cursor:move;
  background:#1A293D; border-bottom:1px solid #0F1E33;
}
:host([data-theme="light"]) .rft-hd{ background:#FFFFFF; border-bottom:1px solid #E2E8F0; }

.rft-title{
  font-size:11px; font-weight:700; letter-spacing:-.01em; flex:1;
  display:flex; align-items:center; gap:5px;
  font-family:-apple-system,system-ui,"Segoe UI",sans-serif;
}
.rft-actions{ display:flex; gap:2px; }

.rft-btn{
  width:24px; height:24px; border-radius:5px; border:none; background:none;
  color:#A3B0C2; cursor:pointer; line-height:1;
  display:grid; place-items:center; transition:.12s; padding:0;
}
:host([data-theme="light"]) .rft-btn{ color:#64748B; }
.rft-btn:hover{ background:rgba(255,255,255,.08); color:#E8EEF7; }
:host([data-theme="light"]) .rft-btn:hover{ background:rgba(0,0,0,.06); color:#1E293B; }
.rft-btn:active{ transform:scale(.92) }
.rft-btn.rft-active{ background:#1E3A8A; color:#60A5FA; }
.rft-btn.rft-flash{ background:#42C6A0; color:#fff; }
.rft-btn svg{ width:13px; height:13px }

/* Textarea editor — free typing seperti Word */
.rft-editor{
  flex:1; overflow-y:auto; min-height:240px; max-height:480px;
  background:#273953; color:#E8EEF7;
  font-family:Menlo,Consolas,"Courier New",monospace;
  font-size:14px; line-height:26px;
  padding:10px 14px; border:none; outline:none; resize:none;
  width:100%; font-variant-numeric:tabular-nums;
  white-space:pre; overflow-wrap:normal;
}
:host([data-theme="light"]) .rft-editor{ background:#FFFFFF; color:#1E293B; }
.rft-editor::-webkit-scrollbar{ width:6px }
.rft-editor::-webkit-scrollbar-thumb{ background:#364C6C; border-radius:3px }
:host([data-theme="light"]) .rft-editor::-webkit-scrollbar-thumb{ background:#CBD5E1; }
.rft-editor::placeholder{ color:#5B7090; white-space:pre-wrap; }
:host([data-theme="light"]) .rft-editor::placeholder{ color:#94A3B8; }

/* Status bar (live total — kecil, tidak mengganggu) */
.rft-status{
  flex:none; padding:6px 12px; background:#1A293D;
  border-top:1px solid #0F1E33;
  display:flex; align-items:center; gap:8px;
  font-family:-apple-system,system-ui,sans-serif;
  font-size:11px; color:#A3B0C2;
}
:host([data-theme="light"]) .rft-status{ background:#FFFFFF; border-top:1px solid #E2E8F0; color:#64748B; }
.rft-autosave{ margin-left:auto; }

/* Toast */
.rft-toast{
  position:absolute; bottom:8px; left:50%; transform:translateX(-50%) translateY(8px);
  background:#E8EEF7; color:#0E182A; padding:5px 12px; border-radius:6px;
  font-size:11px; font-weight:600; opacity:0; pointer-events:none; transition:.2s;
  white-space:nowrap; max-width:90%;
  font-family:-apple-system,system-ui,sans-serif;
}
.rft-toast.rft-show{ opacity:1; transform:translateX(-50%) translateY(0) }
</style>
<div class="rft-popover" role="dialog" aria-label="RecallTape calculator">
  <div class="rft-hd">
    <div class="rft-title">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6"/><path d="M3 11h18"/><path d="M3 11v8a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-8"/><path d="M7 15h4"/></svg>
      RecallTape
    </div>
    <div class="rft-actions">
      <button class="rft-btn rft-pin" title="Pin (kunci agar tetap terbuka)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.5V4h6v6.5l2 3.5H7l2-3.5z"/></svg>
      </button>
      <button class="rft-btn rft-print" title="Cetak resi (PDF)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
      </button>
      <button class="rft-btn rft-copy" title="Salin sebagai teks">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      </button>
      <button class="rft-btn rft-save" title="Simpan ke Catatan (Ctrl+Enter)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
      </button>
      <button class="rft-btn rft-clear" title="Kosongkan">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
    </div>
  </div>
  <textarea class="rft-editor" spellcheck="false" placeholder="Ketik angka, operator auto-format. Saat Enter, angka jadi right-aligned rapi.

Contoh:
1. Ketik 1200 → otomatis jadi:
+   1200

2. Ketik - (minus) → otomatis baris baru:
+   1200
-   

3. Ketik 200 → jadi:
+   1200
-   200

4. Tekan Enter → eksekusi + angka right-aligned rapi:
+        1.200
-          200
─────
→        1.000  📋

5. Lanjut ketik / (bagi) → baris baru:
/   

6. Ketik 2 → Enter:
+        1.200
-          200
─────
→        1.000  📋
/            2
─────
→          500  📋

PERCENT (semua operator support):
+   10%   ← tambah 10% dari running
-   10%   ← kurang 10% dari running
*   50%   ← kalikan dengan 50% (= 0.5)
/   25%   ← bagi dengan 25% (= 0.25)

KETERANGAN (spasi setelah angka):
+        1.200  Gaji
-          200  Makan

Suffix: k/rb/jt/juta
Enter = hitung otomatis
Double-click baris hasil (→) untuk copy nilai"></textarea>
  <div class="rft-status">
    <span class="rft-autosave">✓ Tersimpan otomatis</span>
  </div>
  <div class="rft-toast"></div>
</div>
`;
})();
