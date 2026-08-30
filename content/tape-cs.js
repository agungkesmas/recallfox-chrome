// content/tape-cs.js — RecallTape floating calculator (MULTI-INSTANCE, v3.23.0)
//
// FILOSOFI (warisan v3.14.x, tetap utuh): free typing seperti Word, Enter =
// hitung otomatis, tanpa tombol "=", format rapi right-aligned.
//
// v3.23.0 (permintaan user): tombol 🧾 (pill 4 tombol / header) berarti LEMBAR
// BARU — bisa membuka 2-3+ RecallTape sekaligus. Setiap floater punya:
//   [▾ gulung] [📌 pin] [＋ lembar baru] [🖨 cetak] [⧉ salin] [💾 simpan] [🗑 kosongkan] [✕ tutup]
// Ukuran ringkas default, resize bisa, bisa digulung (collapse), dan AUTO
// MERAPIHKAN DIRI (auto-arrange bertumpuk dari tepi KIRI — notes menumpuk di
// kanan, jadi tidak saling tabrak). State global: `tapeInstances`
// (lihat lib/tape.js) — sinkron real-time antar tab via storage.onChanged.
//
// Warisan yang dipertahankan: guard SHOW_* basi 5s, sendResponse wajib
// (Firefox BUG-3), CustomEvent 'rf-open-tape', mirror tapeSession (kompat).

(async function () {
  if (window.__recallfoxTapeLoaded) return;
  window.__recallfoxTapeLoaded = true;

  // Chrome: dynamic import() tersedia — langsung import lib ESM.
  let tape = null;
  try { tape = await import(browser.runtime.getURL('lib/tape.js')); } catch (e) { console.warn('[RecallFox/Tape] Failed', e); return; }
  const RFT_EVALUATE = tape.evaluate;
  const RFT_FMT_NUM = tape.formatNumber;
  const RFT_FMT_CUR = tape.formatCurrency;
  const RFT_PARSE_LINE = tape.parseLine;
  const RFT_PARSE_AMT = tape.parseAmount;
  const RFT_SAVE_SESSION = tape.saveSession;
  const RFT_LOAD_INSTANCES = tape.loadTapeInstances;
  const RFT_SAVE_INSTANCES = tape.saveTapeInstances;
  if (!RFT_EVALUATE || !RFT_LOAD_INSTANCES || !RFT_SAVE_INSTANCES) { console.warn('[RecallFox/Tape] lib tape tidak tersedia — skip'); return; }

  // ===== v3.23.0 MULTI-INSTANCE CORE =====
  let userHiddenAt = 0;      // guard SHOW_* basi
  let lastFocusedId = null;  // target ADD_TO_TAPE
  let hostSeq = 0;           // recallfox-tape-host, -2, -3, ...
  let reconcileChain = Promise.resolve();
  const ctrls = new Map();          // id → controller
  const saveTimers = new Map();
  const pendingExternal = new Map();

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

  // ===== v3.23.1 WARNA — palet warna lembar (pilih sendiri via 🎨 + otomatis) =====
  const RF_PALETTE = ['green', 'blue', 'amber', 'rose', 'violet', 'cyan', 'orange', 'lime'];
  const RF_DEF_COLOR = 'amber';
  const RF_SWATCH = { green:'#10B981', blue:'#3B82F6', amber:'#F59E0B', rose:'#F43F5E', violet:'#8B5CF6', cyan:'#06B6D4', orange:'#F97316', lime:'#84CC16' };
  function normColor(c){ return (typeof c === 'string' && RF_SWATCH[c]) ? c : null; }
  // Warna otomatis: lembar baru dapat warna yang paling jarang dipakai lembar
  // terbuka lain — buka 2-3 tape = warna selalu berbeda (urutan mulai dari
  // warna default agar tape pertama tetap tampilan klasik amber).
  function pickAutoColor(list){
    const used = {};
    for (const it of (Array.isArray(list) ? list : [])) { if (!it || !it.open) continue; const c = normColor(it.color) || RF_DEF_COLOR; used[c] = (used[c] || 0) + 1; }
    const order = [RF_DEF_COLOR].concat(RF_PALETTE.filter(c => c !== RF_DEF_COLOR));
    let best = RF_DEF_COLOR, bestN = Infinity;
    for (const c of order) { const n = used[c] || 0; if (n < bestN) { bestN = n; best = c; } }
    return best;
  }

  function newData(extra) {
    return Object.assign({
      id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      text: '', open: true, collapsed: false,
      x: null, y: null, w: null, h: null,
      color: null, createdAt: Date.now()
    }, extra || {});
  }
  async function getList(){ try{ const l = await RFT_LOAD_INSTANCES(); return Array.isArray(l) ? l : []; }catch(e){ return []; } }
  async function putList(list){ try{ await RFT_SAVE_INSTANCES(list); }catch(e){} return list; }
  async function patchLocal(id, patch){
    const list = await getList();
    const it = list.find(i => i.id === id);
    if (it) { Object.assign(it, patch); await putList(list); }
    return list;
  }

  // ============================================================================
  // FORMAT RAPI (warisan v3.14.14) — operator rata kiri, angka right-aligned
  // ============================================================================
  const OP_GAP = '   ';      // 3 spasi — jarak operator ↔ angka
  const AMT_WIDTH = 12;      // lebar tetap untuk angka (right-aligned)
  const NOTE_GAP = '  ';     // 2 spasi — jarak angka ↔ keterangan

  // ===== Controller per instance =====
  function buildCtrl(data){
    const host = document.createElement('div');
    hostSeq += 1;
    host.id = 'recallfox-tape-host' + (hostSeq > 1 ? '-' + hostSeq : '');
    host.style.cssText = 'all:initial;position:fixed;top:0;right:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = TEMPLATE;
    const popover = shadow.querySelector('.rft-popover');
    const textarea = shadow.querySelector('.rft-editor');
    const statusAutosave = shadow.querySelector('.rft-autosave');
    const pinBtn = shadow.querySelector('.rft-pin');
    const st = { isVisible: false, pinned: true, prevH: '' };
    let roTimer = null;

    function setActive(){ try{ if(popover) popover.classList.remove('rft-idle'); }catch(e){} }
    function setIdle(){ try{ if(!st.isVisible) return; if(popover) popover.classList.add('rft-idle'); }catch(e){} }
    // v3.23.1: warna lembar — data-color di popover + tandai swatch aktif
    function applyColor(){
      const c = normColor(data.color) || RF_DEF_COLOR;
      try{ popover.dataset.color = c; }catch(e){}
      try{ popover.setAttribute('data-color', c); }catch(e){}
      try{
        const pal = shadow.querySelector('.rft-palette');
        const sw = pal ? pal.querySelectorAll('.rft-swatch') : [];
        for (const b of sw) { try { b.classList.toggle('on', !!(b.dataset && b.dataset.c === c)); } catch(e){} }
      }catch(e){}
    }
    async function setColor(c){
      if (!normColor(c)) return;
      data.color = c; applyColor();
      await patchLocal(data.id, { color: c });
    }

    function applyGeometry(){
      try{
        if (typeof data.w === 'number' && data.w > 0) popover.style.width = data.w + 'px';
        if (!data.collapsed && typeof data.h === 'number' && data.h > 0) popover.style.height = data.h + 'px';
        // v3.23.2 DOCK: posisi tidak lagi dari data.x/y — dock global yang menata.
        popover.classList.toggle('rft-min', !!data.collapsed);
        if (data.collapsed) { if (!st.prevH) st.prevH = popover.style.height || ''; popover.style.height = 'auto'; }
        else if (st.prevH) { popover.style.height = st.prevH; st.prevH = ''; }
      }catch(e){}
    }
    function applyText(t, force){
      if (typeof t !== 'string' || t === textarea.value) return;
      let focused = false; try{ focused = (shadow.activeElement === textarea); }catch(e){}
      if (focused && !force) { pendingExternal.set(data.id, t); return; }
      textarea.value = t; updateStatus();
    }
    function applyFrom(d){
      try{
        if (typeof d.text === 'string') applyText(d.text, false);
        const colChanged = (!!d.collapsed !== !!data.collapsed);
        if (typeof d.collapsed === 'boolean') data.collapsed = d.collapsed;
        if (typeof d.w === 'number') data.w = d.w;
        if (typeof d.h === 'number') data.h = d.h;
        // v3.23.2 DOCK: x/y tidak lagi direkonsiliasi (dock yang menata posisi)
        if (typeof d.color === 'string' && d.color !== data.color) { const nc = normColor(d.color); if (nc) { data.color = nc; applyColor(); } }
        if (colChanged) applyGeometry();
      }catch(e){}
    }
    async function show(){
      try{ const theme = await loadTheme(); shadow.host.setAttribute('data-theme', theme); }catch(e){}
      try{ host.style.display = ''; }catch(e){}
      applyColor();
      applyGeometry();
      // v3.23.0: muat teks awal instance (reconcile / ADD_TO_TAPE baru)
      if (typeof data.text === 'string' && data.text && !textarea.value) { textarea.value = data.text; updateStatus(); }
      popover.classList.add('rft-show');
      st.isVisible = true;
      lastFocusedId = data.id;
      try{ popover.classList.add('rft-idle'); }catch(e){}
      setTimeout(() => { try{ textarea.focus(); }catch(e){} }, 50);
    }
    function hideDom(){ if (popover) { popover.classList.remove('rft-show'); popover.classList.remove('rft-idle'); } st.isVisible = false; }
    function destroy(){ try{ if (window.__RFDock) window.__RFDock.unregister('tape:' + data.id); }catch(e){} try{ host.remove(); }catch(e){} }
    async function closeLocal(markClosed){
      hideDom();
      if (markClosed === false) { destroy(); return; }
      userHiddenAt = Date.now();
      if (ctrls.get(data.id) === ctrl) ctrls.delete(data.id);
      destroy();
      await patchLocal(data.id, { open: false });
      tidy();
    }
    function setCollapsed(v){
      data.collapsed = !!v;
      applyGeometry();
      patchLocal(data.id, { collapsed: data.collapsed });
      tidy();
    }
    function setPos(x, y){ try{ popover.style.left = x + 'px'; popover.style.top = y + 'px'; popover.style.right = 'auto'; }catch(e){} }
    function setTheme(t){ try{ shadow.host.setAttribute('data-theme', t); }catch(e){} }
    function focusSoon(){ setTimeout(() => { try{ textarea.focus(); }catch(e){} }, 60); }
    function append(t){ textarea.value += (textarea.value ? '\n' : '') + String(t == null ? '' : t); updateStatus(); scheduleSave(); setActive(); }
    function applyTextForce(t){ if (typeof t === 'string') { textarea.value = t; updateStatus(); } }

  // ============================================================================
  // v3.14.12/13/14: AUTO-FORMAT + ENTER = HITUNG OTOMATIS (logika utuh warisan)
  // ============================================================================

  // Format satu baris op menjadi format rapi
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
    const formatted = RFT_FMT_NUM(running);
    const amtPadded = formatted.padStart(AMT_WIDTH, ' ');
    return '→' + OP_GAP + amtPadded + NOTE_GAP + '📋';
  }

  // Re-format semua baris op di textarea (dipanggil saat Enter)
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

    // Ketik digit di baris kosong → auto-prefix "+   "
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

    // Ketik operator (+ - * /) di akhir baris berisi → auto-newline
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
  }

  function handleEnterKey(e) {
    // v3.20.2/3: let + try/catch oleh caller — warisan stabil
    let pos = textarea.selectionStart;
    let val = textarea.value;

    if (textarea.selectionStart !== textarea.selectionEnd) return;

    const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
    const lineEnd = pos;
    const currentLine = val.slice(lineStart, lineEnd).trim();

    if (!currentLine) return;

    const isOpLine = /^([+\-*/]?)\s*[\d.,]+\s*(k|rb|jt|juta|ribu|m|b|bn)?%?/i.test(currentLine);
    if (!isOpLine) return;

    const opMatch = currentLine.match(/^([+\-*/]?)\s*([\d.,]+(?:k|rb|jt|juta|ribu|m|b|bn)?%?)\s*(.*)$/i);
    if (!opMatch) return;

    // ===== ENTER = HITUNG =====
    e.preventDefault();

    const reformattedVal = reformatAllOpLines(val);
    if (reformattedVal !== val) {
      textarea.value = reformattedVal;
      const newLines = reformattedVal.split('\n');
      const currentLineIdxNew = val.slice(0, pos).split('\n').length - 1;
      let newPos = 0;
      for (let i = 0; i <= currentLineIdxNew; i++) {
        newPos += newLines[i].length + 1;
      }
      newPos = newPos - 1;
      textarea.setSelectionRange(newPos, newPos);
      val = textarea.value;
      pos = newPos;
    }

    const allLines = val.split('\n');
    const currentLineIdx = val.slice(0, pos).split('\n').length - 1;

    const opLinesForEval = [];
    for (let i = 0; i <= currentLineIdx; i++) {
      const ln = allLines[i];
      const trimmed = ln.trim();
      if (/^[─=─]{3,}$/.test(trimmed) || /^-{3,}$/.test(trimmed) || /^={3,}$/.test(trimmed)) continue;
      if (/^[→»•]/.test(trimmed)) continue;
      opLinesForEval.push(ln);
    }

    const result = RFT_EVALUATE(opLinesForEval);
    const running = result.grandTotal;

    const separator = '─────';
    const resultLine = formatResultLine(running);
    const insert = '\n' + separator + '\n' + resultLine + '\n';

    const before = val.slice(0, pos);
    const after = val.slice(pos);
    textarea.value = before + insert + after;

    const newCursorPos = pos + insert.length;
    textarea.setSelectionRange(newCursorPos, newCursorPos);

    textarea.scrollTop = textarea.scrollHeight;

    updateStatus();
    scheduleSave();
  }

  // Live status update (tidak menyisipkan baris)
  function updateStatus() {
    const text = textarea.value;
    const lines = text.split('\n');
    const opLines = [];
    for (const ln of lines) {
      const trimmed = ln.trim();
      if (/^[─=─]{3,}$/.test(trimmed) || /^-{3,}$/.test(trimmed) || /^={3,}$/.test(trimmed)) continue;
      if (/^[→»•]/.test(trimmed)) continue;
      opLines.push(ln);
    }
    const result = RFT_EVALUATE(opLines);
    if (statusAutosave) {
      if (result.error) {
        statusAutosave.textContent = '⚠ ' + result.error;
        statusAutosave.style.color = '#FB7185';
      } else {
        statusAutosave.textContent = '✓ Tersimpan otomatis · Total: ' + RFT_FMT_NUM(result.grandTotal);
        statusAutosave.style.color = '';
      }
    }
  }

  function scheduleSave() {
    if (saveTimers.has(data.id)) clearTimeout(saveTimers.get(data.id));
    if (statusAutosave) {
      statusAutosave.textContent = '⏳ Menyimpan…';
      statusAutosave.style.color = '#F0B64A';
    }
    saveTimers.set(data.id, setTimeout(async () => {
      try {
        data.text = textarea.value;
        const list = await getList();
        const it = list.find(i => i.id === data.id);
        if (it) { it.text = textarea.value; }
        else list.push(JSON.parse(JSON.stringify(data)));
        await putList(list);
        // mirror instance pertama → tapeSession (kompat pembaca lama)
        if (list.length && list[0].id === data.id) { try { await RFT_SAVE_SESSION(textarea.value); } catch (e) {} }
      } catch (e) {}
      updateStatus();
    }, 400));
  }

  // Double-click di baris hasil → copy nilai
  function handleResultLineDoubleClick() {
    const pos = textarea.selectionStart;
    const val = textarea.value;
    const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
    let lineEnd = val.indexOf('\n', pos);
    if (lineEnd === -1) lineEnd = val.length;
    const currentLine = val.slice(lineStart, lineEnd);

    if (currentLine.trim().startsWith('→')) {
      const match = currentLine.match(/→\s*([\d.,-]+)\s*📋?/);
      if (match) {
        const numStr = match[1];
        navigator.clipboard.writeText(numStr).then(() => {
          toast('📋 ' + numStr + ' tersalin');
        }).catch(() => {
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
    const lines = text.split('\n');
    const opLines = [];
    for (const ln of lines) {
      const trimmed = ln.trim();
      if (/^[─=─]{3,}$/.test(trimmed) || /^-{3,}$/.test(trimmed) || /^={3,}$/.test(trimmed)) continue;
      if (/^[→»•]/.test(trimmed)) continue;
      opLines.push(ln);
    }
    const result = RFT_EVALUATE(opLines);
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
    for (let i = 0; i < opLines.length; i++) {
      const ln = opLines[i];
      const trimmed = ln.trim();
      if (!trimmed) continue;
      out.push(trimmed);
    }
    out.push('─────');
    out.push('→  ' + RFT_FMT_NUM(result.grandTotal) + '  📋');
    return out.join('\n');
  }

  function doPrint() {
    const text = textarea.value;
    if (!text.trim()) { toast('Tape kosong'); return; }

    const allLines = text.split('\n');
    const lines = [];
    lines.push('<div class="rct-hd"><h1>🧮 RecallTape</h1><div class="rct-date">' + new Date().toLocaleString('id-ID') + '</div></div>');
    for (const ln of allLines) {
      const trimmed = ln.trim();
      if (!trimmed) continue;
      if (/^[─=─]{3,}$/.test(trimmed) || /^-{3,}$/.test(trimmed) || /^={3,}$/.test(trimmed)) {
        lines.push('<div class="rct-sep"></div>');
        continue;
      }
      if (/^[→»•]/.test(trimmed)) {
        const match = trimmed.match(/→\s*([\d.,-]+)\s*📋?/);
        if (match) {
          lines.push('<div class="rct-line rct-subtotal"><span class="rct-op">→</span><span class="rct-val">' + esc(match[1]) + '</span></div>');
        }
        continue;
      }
      const opMatch = trimmed.match(/^([+\-*/]?)\s*([\d.,]+(?:k|rb|jt|juta|ribu|m|b|bn)?%?)\s*(.*)$/i);
      if (opMatch) {
        const sym = opMatch[1] || '+';
        const amt = opMatch[2];
        const note = opMatch[3] || '';
        const noteHtml = note ? '<span class="rct-note">' + esc(note) + '</span>' : '';
        lines.push('<div class="rct-line"><span class="rct-op">' + sym + '</span><span class="rct-amt">' + esc(amt) + '</span>' + noteHtml + '</div>');
      } else {
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

  async function doSave() {
    const text = textarea.value;
    if (!text.trim()) { toast('Tape kosong'); return; }
    try {
      const lines = text.split('\n');
      const opLines = [];
      for (const ln of lines) {
        const trimmed = ln.trim();
        if (/^[─=─]{3,}$/.test(trimmed) || /^-{3,}$/.test(trimmed) || /^={3,}$/.test(trimmed)) continue;
        if (/^[→»•]/.test(trimmed)) continue;
        opLines.push(ln);
      }
      const result = RFT_EVALUATE(opLines);
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

  // ===== Drag (persist posisi pilihan user) =====
  function makeDraggable() {
    const hd = shadow.querySelector('.rft-hd');
    let dragging = false, dx = 0, dy = 0, moved = false;
    hd.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true; moved = false;
      const rect = popover.getBoundingClientRect();
      dx = e.clientX - rect.left;
      dy = e.clientY - rect.top;
      popover.style.transition = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      moved = true;
      popover.style.left = (e.clientX - dx) + 'px';
      popover.style.top = (e.clientY - dy) + 'px';
      popover.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => {
      if (dragging) {
        dragging = false; popover.style.transition = '';
        // v3.23.3 DOCK: lepas drag → kembali rapat ke deretan
        tidy();
      }
    });
  }

  // ===== Wire events =====
  function wireEvents() {
    textarea.addEventListener('input', () => { updateStatus(); scheduleSave(); try{ setActive(); }catch(e){} });
    try{ textarea.addEventListener('focus', ()=>{ lastFocusedId = data.id; try{ setActive(); }catch(e){} }); }catch(e){}
    try{ textarea.addEventListener('blur', ()=>{ const p=pendingExternal.get(data.id); if(p!=null&&p!==textarea.value){ textarea.value=p; updateStatus(); } pendingExternal.delete(data.id); }); }catch(e){}
    try{ popover.addEventListener('mouseenter', ()=>{ try{ setActive(); }catch(e){} }); }catch(e){}
    try{ popover.addEventListener('mouseleave', ()=>{ try{ setIdle(); }catch(e){} }); }catch(e){}

    // KEYDOWN — auto-format + Enter = hitung otomatis
    textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        doSave();
        return;
      }
      if (e.key === 'Escape' && !st.pinned) {
        e.preventDefault();
        closeLocal();
        return;
      }
      try{ setActive(); }catch(e){}
      try {
        handleAutoFormatKey(e);
        if (e.key === 'Enter' && !e.shiftKey) {
          handleEnterKey(e);
        }
      } catch (err) {
        console.error('[RecallFox/Tape] keydown handler error:', err);
      }
    });

    textarea.addEventListener('dblclick', () => {
      handleResultLineDoubleClick();
    });

    pinBtn.addEventListener('click', () => {
      try{
        st.pinned = !st.pinned;
        pinBtn.classList.toggle('rft-active', st.pinned);
      }catch(e){ console.error('[RecallFox/Tape] pin failed:', e); }
    });
    try{ shadow.querySelector('.rft-collapse').addEventListener('click', ()=>setCollapsed(!data.collapsed)); }catch(e){}
    try{ shadow.querySelector('.rft-color').addEventListener('click', ()=>{ try{ popover.classList.toggle('rft-pal-open'); }catch(e){} }); }catch(e){}
    try{ const pal=shadow.querySelector('.rft-palette'); if(pal) pal.addEventListener('click', (e)=>{ try{ const b=e && e.target && e.target.closest && e.target.closest('.rft-swatch'); if(!b || !b.dataset) return; setColor(b.dataset.c); try{ popover.classList.remove('rft-pal-open'); }catch(ee){} }catch(e){} }); }catch(e){}
    try{ document.addEventListener('mousedown', (e)=>{ try{ if(!popover || !popover.classList.contains('rft-pal-open')) return; const p=e.composedPath?e.composedPath():[e.target]; if(p.includes(host)||p.includes(popover)) return; popover.classList.remove('rft-pal-open'); }catch(e){} }, true); }catch(e){}
    try{ shadow.querySelector('.rft-new').addEventListener('click', ()=>{ createTapeInstance({}); }); }catch(e){}
    try{ shadow.querySelector('.rft-close').addEventListener('click', ()=>closeLocal()); }catch(e){}
    shadow.querySelector('.rft-print').addEventListener('click', doPrint);
    shadow.querySelector('.rft-copy').addEventListener('click', doCopy);
    shadow.querySelector('.rft-save').addEventListener('click', doSave);
    shadow.querySelector('.rft-clear').addEventListener('click', doClear);

    // klik di luar → tutup (hanya saat tidak dipin)
    document.addEventListener('mousedown', (e) => {
      if (!st.isVisible || st.pinned) return;
      const path = e.composedPath ? e.composedPath() : [e.target];
      if (path.includes(host)) return;
      closeLocal();
    }, true);

    makeDraggable();

    // persist ukuran hasil resize user (guarded)
    try {
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => {
          if (!st.isVisible || data.collapsed) return;
          if (roTimer) clearTimeout(roTimer);
          roTimer = setTimeout(() => { try{ const w=popover.offsetWidth, h=popover.offsetHeight; if(w>0&&h>0&&(w!==data.w||h!==data.h)){ data.w=w; data.h=h; patchLocal(data.id,{w,h}); } }catch(e){} }, 500);
        });
        ro.observe(popover);
      }
    } catch (e) {}
  }
    wireEvents();
    // v3.23.2 DOCK: daftarkan floater ke dock global — satu deretan rapi
    // kanan-atas bersama RecallNote & RecallPomodoro (content/float-dock.js).
    try { if (window.__RFDock) window.__RFDock.register({ key: 'tape:' + data.id, kind: 'tape', t: data.createdAt || 0, visible: () => st.isVisible, width: () => data.collapsed ? 320 : Math.max(280, (typeof data.w === 'number' && data.w) || 320), height: () => data.collapsed ? 44 : Math.max(260, (typeof data.h === 'number' && data.h) || 320), place: (x, y) => setPos(x, y) }); } catch (e) {}

    const ctrl = { id: data.id, show, hideDom, closeLocal, destroy, setCollapsed, setPos, setTheme, append, applyFrom, applyTextForce, focusSoon, get isVisible(){ return st.isVisible; } };
    return ctrl;
  }

  // ===== Dock (v3.23.2): auto merapihkan diri via float-dock.js =====
  // Tape kini ikut SATU deretan rapi yang sama dengan RecallNote & Pomodoro
  // di tepi kanan-atas (tidak lagi kolom kiri terpisah). Setiap gulung (\u25be) /
  // buka (>) / buka-tutup lembar memicu restack penuh — tidak misah-misah.
  // Algoritma lengkap: content/float-dock.js.
  function tidy(){ try{ if (window.__RFDock) window.__RFDock.layout(); }catch(e){} }

  // ===== Reconcile dari storage (cross-tab real-time + boot) — TIDAK menulis =====
  function reconcile(list){
    reconcileChain = reconcileChain.then(async()=>{
      const arr = Array.isArray(list) ? list.filter(i => i && typeof i.id === 'string') : [];
      const byId = new Map(arr.map(i => [i.id, i]));
      for (const [id, c] of Array.from(ctrls)) {
        const d = byId.get(id);
        if (!d || !d.open) { ctrls.delete(id); c.closeLocal(false); }
      }
      for (const d of arr) {
        if (!d.open) continue;
        let c = ctrls.get(d.id);
        if (!c) { c = buildCtrl(d); ctrls.set(d.id, c); await c.show(); }
        else c.applyFrom(d);
      }
      tidy();
    }).catch(()=>{});
    return reconcileChain;
  }

  // ===== Aksi =====
  async function createTapeInstance(extra){
    // v3.23.1 WARNA: lembar baru otomatis dapat warna belum terpakai
    // (buka 2-3 tape = warna berbeda); extra.color pilihan user menang.
    const preList = await getList();
    if (!extra || !normColor(extra.color)) { extra = extra || {}; extra.color = pickAutoColor(preList); }
    const d = newData(extra);
    // PENTING: daftarkan ctrl SEBELUM putList (anti host dobel — lihat notes).
    const c = buildCtrl(d);
    ctrls.set(d.id, c);
    const list = await getList();
    list.push(d);
    await putList(list);
    await c.show();
    tidy();
    c.focusSoon();
    return c;
  }
  async function addToLast(text){
    const t = String(text == null ? '' : text);
    let c = (lastFocusedId && ctrls.get(lastFocusedId)) || null;
    if (!c) {
      const list = await getList();
      const opens = list.filter(i => i.open);
      for (let k = opens.length - 1; k >= 0; k--) { const cc = ctrls.get(opens[k].id); if (cc) { c = cc; break; } }
    }
    if (!c) { await createTapeInstance({ text: t }); return; }
    c.append(t);
    await c.show();
    tidy();
  }
  async function hideAllLocal(){
    userHiddenAt = Date.now();
    for (const [id, c] of Array.from(ctrls)) { c.hideDom(); c.destroy(); ctrls.delete(id); }
    const list = await getList();
    let ch = false;
    for (const it of list) { if (it.open) { it.open = false; ch = true; } }
    if (ch) await putList(list);
  }
  function captureHide(){ try{ document.querySelectorAll('[id^="recallfox-tape-host"]').forEach(h=>{ h.style.display='none'; }); }catch(e){} }
  function captureRestore(){ try{ document.querySelectorAll('[id^="recallfox-tape-host"]').forEach(h=>{ h.style.display=''; }); ctrls.forEach(c=>{ if(c.isVisible) c.show(); }); }catch(e){} }

  // ===== Message listener =====
  // OPEN_TAPE = LEMBAR BARU (v3.23.0). Untuk menutup: ✕ / Esc (lepas pin) /
  // klik luar saat tidak dipin / HIDE_TAPE (tutup semua).
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try{
      if (msg.type === 'OPEN_TAPE') createTapeInstance({});
      else if (msg.type === 'ADD_TO_TAPE') addToLast(msg.text);
      else if (msg.type === 'SHOW_TAPE'){ if (Date.now() - userHiddenAt >= 5000) getList().then(reconcile); }
      else if (msg.type === 'HIDE_TAPE') hideAllLocal();
      else if (msg.type === 'THEME_CHANGED') { ctrls.forEach(c=>c.setTheme(msg.theme)); }
      else if (msg.type === 'RF_HIDE_FOR_CAPTURE') captureHide();
      else if (msg.type === 'RF_RESTORE_AFTER_CAPTURE') captureRestore();
    }catch(e){}
    // v3.22.4 FIX BUG-3 (Firefox): wajib balas agar background tidak salah putusan.
    if (typeof sendResponse === 'function') { try { sendResponse({ ok: true }); } catch (e) {} }
  });
  // v3.22.4 FIX BUG-5: fallback CustomEvent 'rf-open-tape' dari sidebar-cs.js
  try { window.addEventListener('rf-open-tape', () => { try{ createTapeInstance({}); }catch(e){} }); } catch (e) {}

  // Boot: pulihkan semua instance open:true (auto-show, incl. file://)
  (async function boot(){ try{ const list = await getList(); await reconcile(list); }catch(e){} })();

  // Cross-tab real-time: reconciliasi setiap perubahan tapeInstances (DOM saja)
  try{
    browser.storage.onChanged.addListener((changes, area)=>{
      if (area !== 'local' || !changes || !changes.tapeInstances) return;
      const nv = changes.tapeInstances.newValue;
      if (!Array.isArray(nv)) return;
      reconcile(nv);
    });
  }catch(e){}

  // ===== Template (HTML + CSS inlined in Shadow DOM) =====
  // Header: [▾ gulung][📌 pin][＋ lembar baru][🖨 cetak][⧉ salin][💾 simpan][🗑 kosongkan][✕ tutup]
  const TEMPLATE = `
<style>
:host{all:initial}.rft-popover{--p-bd:rgba(245,158,11,.25);--p-idle:rgba(120,53,15,.55);--p-idle-bd:rgba(251,191,36,.35);--p-idle-l:rgba(254,243,199,.85);--p-idle-bd-l:rgba(245,158,11,.3);--p-hd:#3A1F00;--p-hd-bd:rgba(245,158,11,.2);--p-hd-l:#FFFBEB;--p-tt:#FCD34D;--p-tt-l:#92400E;--p-act:#78350F;--p-act-c:#FCD34D;--p-act-bd:rgba(251,191,36,.3);--p-flash:#F59E0B}.rft-popover[data-color="green"]{--p-bd:rgba(16,185,129,.25);--p-idle:rgba(19,78,74,.55);--p-idle-bd:rgba(110,231,183,.35);--p-idle-l:rgba(204,251,241,.85);--p-idle-bd-l:rgba(16,185,129,.3);--p-hd:#0F2E2A;--p-hd-bd:rgba(16,185,129,.2);--p-hd-l:#ECFDF5;--p-tt:#6EE7B7;--p-tt-l:#047857;--p-act:#134E4A;--p-act-c:#6EE7B7;--p-act-bd:rgba(110,231,183,.3);--p-flash:#10B981}.rft-popover[data-color="blue"]{--p-bd:rgba(59,130,246,.25);--p-idle:rgba(30,58,138,.5);--p-idle-bd:rgba(147,197,253,.35);--p-idle-l:rgba(219,234,254,.85);--p-idle-bd-l:rgba(59,130,246,.3);--p-hd:#0F2440;--p-hd-bd:rgba(59,130,246,.2);--p-hd-l:#EFF6FF;--p-tt:#93C5FD;--p-tt-l:#1D4ED8;--p-act:#1E3A8A;--p-act-c:#93C5FD;--p-act-bd:rgba(147,197,253,.3);--p-flash:#3B82F6}.rft-popover[data-color="rose"]{--p-bd:rgba(244,63,94,.25);--p-idle:rgba(159,18,57,.45);--p-idle-bd:rgba(253,164,175,.35);--p-idle-l:rgba(255,228,230,.85);--p-idle-bd-l:rgba(244,63,94,.3);--p-hd:#3F0A17;--p-hd-bd:rgba(244,63,94,.2);--p-hd-l:#FFF1F2;--p-tt:#FDA4AF;--p-tt-l:#BE123C;--p-act:#881337;--p-act-c:#FDA4AF;--p-act-bd:rgba(253,164,175,.3);--p-flash:#F43F5E}.rft-popover[data-color="violet"]{--p-bd:rgba(139,92,246,.25);--p-idle:rgba(76,29,149,.5);--p-idle-bd:rgba(196,181,253,.35);--p-idle-l:rgba(237,233,254,.85);--p-idle-bd-l:rgba(139,92,246,.3);--p-hd:#221040;--p-hd-bd:rgba(139,92,246,.2);--p-hd-l:#F5F3FF;--p-tt:#C4B5FD;--p-tt-l:#6D28D9;--p-act:#4C1D95;--p-act-c:#C4B5FD;--p-act-bd:rgba(196,181,253,.3);--p-flash:#8B5CF6}.rft-popover[data-color="cyan"]{--p-bd:rgba(6,182,212,.25);--p-idle:rgba(21,94,117,.5);--p-idle-bd:rgba(103,232,249,.35);--p-idle-l:rgba(207,250,254,.85);--p-idle-bd-l:rgba(6,182,212,.3);--p-hd:#083344;--p-hd-bd:rgba(6,182,212,.2);--p-hd-l:#ECFEFF;--p-tt:#67E8F9;--p-tt-l:#0E7490;--p-act:#164E63;--p-act-c:#67E8F9;--p-act-bd:rgba(103,232,249,.3);--p-flash:#06B6D4}.rft-popover[data-color="orange"]{--p-bd:rgba(249,115,22,.25);--p-idle:rgba(154,52,18,.5);--p-idle-bd:rgba(253,186,116,.35);--p-idle-l:rgba(255,237,213,.85);--p-idle-bd-l:rgba(249,115,22,.3);--p-hd:#3B1400;--p-hd-bd:rgba(249,115,22,.2);--p-hd-l:#FFF7ED;--p-tt:#FDBA74;--p-tt-l:#C2410C;--p-act:#7C2D12;--p-act-c:#FDBA74;--p-act-bd:rgba(253,186,116,.3);--p-flash:#F97316}.rft-popover[data-color="lime"]{--p-bd:rgba(132,204,22,.25);--p-idle:rgba(63,98,18,.5);--p-idle-bd:rgba(190,242,100,.35);--p-idle-l:rgba(236,252,203,.85);--p-idle-bd-l:rgba(132,204,22,.3);--p-hd:#1A2E05;--p-hd-bd:rgba(132,204,22,.2);--p-hd-l:#F7FEE7;--p-tt:#BEF264;--p-tt-l:#4D7C0F;--p-act:#365314;--p-act-c:#BEF264;--p-act-bd:rgba(190,242,100,.3);--p-flash:#84CC16}.rft-palette{position:absolute;top:40px;left:10px;z-index:6;display:none;flex-wrap:wrap;gap:7px;max-width:210px;background:#0E182A;border:1px solid #22375A;border-radius:10px;padding:9px;box-shadow:0 12px 34px rgba(0,0,0,.5)}:host([data-theme="light"]) .rft-palette{background:#FFF;border-color:#E2E8F0}.rft-popover.rft-pal-open .rft-palette{display:flex}.rft-swatch{width:19px;height:19px;border-radius:50%;border:2px solid rgba(255,255,255,.25);cursor:pointer;padding:0;transition:transform .12s}.rft-swatch:hover{transform:scale(1.18)}.rft-swatch.on{border-color:#fff;box-shadow:0 0 0 2px rgba(255,255,255,.35)}:host([data-theme="light"]) .rft-swatch{border-color:rgba(0,0,0,.2)}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

.rft-popover{
  position:fixed; top:60px; left:14px;
  width:320px; max-height:520px;
  background:#0E182A; color:#E8EEF7;
  border:1px solid var(--p-bd); border-radius:12px;
  box-shadow:0 18px 50px rgba(0,0,0,.55), 0 2px 8px rgba(0,0,0,.4);
  display:flex; flex-direction:column; overflow:hidden;
  font-family:Menlo,Consolas,"Courier New",monospace; font-size:13px;
  opacity:0; transform:translateY(-6px) scale(.98); pointer-events:none;
  transition:opacity .15s ease, transform .15s ease;
  resize:both; min-width:280px; min-height:260px;
}
.rft-popover.rft-show{ opacity:1; transform:translateY(0) scale(1); pointer-events:auto }
.rft-popover.rft-idle{ opacity:0.35; background:var(--p-idle); backdrop-filter:blur(2px); border-color:var(--p-idle-bd); }
:host([data-theme="light"]) .rft-popover.rft-idle{ background:var(--p-idle-l); border-color:var(--p-idle-bd-l); }

:host([data-theme="light"]) .rft-popover{
  background:#F8FAFC; color:#1E293B; border-color:#E2E8F0;
  box-shadow:0 18px 50px rgba(0,0,0,.12), 0 2px 8px rgba(0,0,0,.08);
}

.rft-popover.rft-min{ min-height:0; height:auto; resize:none; width:320px!important; }.rft-popover.rft-pal-open{ overflow:visible; }
.rft-popover.rft-min .rft-editor, .rft-popover.rft-min .rft-status{ display:none; }

/* Header — draggable */
.rft-hd{
  display:flex; align-items:center; gap:6px;
  padding:7px 10px; flex:none; cursor:move;
  background:var(--p-hd); border-bottom:1px solid var(--p-hd-bd);
}
:host([data-theme="light"]) .rft-hd{ background:var(--p-hd-l); border-bottom:1px solid var(--p-hd-bd); }

.rft-title{
  font-size:11px; font-weight:700; letter-spacing:-.01em; flex:1;
  display:flex; align-items:center; gap:5px; white-space:nowrap; overflow:hidden;
  font-family:-apple-system,system-ui,"Segoe UI",sans-serif;
  color:var(--p-tt);
}
:host([data-theme="light"]) .rft-title{ color:var(--p-tt-l); }
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
.rft-btn.rft-active{ background:var(--p-act); color:var(--p-act-c); border:1px solid var(--p-act-bd); }
.rft-btn.rft-flash{ background:#42C6A0; color:#fff; }
.rft-btn svg{ width:13px; height:13px }
.rft-collapse svg{ transition:transform .15s; }
.rft-popover.rft-min .rft-collapse svg{ transform:rotate(-90deg); }

/* Textarea editor — free typing seperti Word */
.rft-editor{
  flex:1; overflow-y:auto; min-height:210px; max-height:440px;
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

/* Status bar (live total) */
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
  <div class="rft-palette" role="menu"><button class="rft-swatch" data-c="green" title="Hijau" style="background:#10B981"></button><button class="rft-swatch" data-c="blue" title="Biru" style="background:#3B82F6"></button><button class="rft-swatch" data-c="amber" title="Kuning" style="background:#F59E0B"></button><button class="rft-swatch" data-c="rose" title="Merah Muda" style="background:#F43F5E"></button><button class="rft-swatch" data-c="violet" title="Ungu" style="background:#8B5CF6"></button><button class="rft-swatch" data-c="cyan" title="Cyan" style="background:#06B6D4"></button><button class="rft-swatch" data-c="orange" title="Oranye" style="background:#F97316"></button><button class="rft-swatch" data-c="lime" title="Hijau Limau" style="background:#84CC16"></button></div>
  <div class="rft-hd">
    <div class="rft-title">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6"/><path d="M3 11h18"/><path d="M3 11v8a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-8"/><path d="M7 15h4"/></svg>
      RecallTape
    </div>
    <div class="rft-actions">
      <button class="rft-btn rft-collapse" title="Gulung / buka lagi">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <button class="rft-btn rft-color" title="Warna lembar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22a10 10 0 1 1 10-10c0 2.2-1.8 4-4 4h-2.2a1.8 1.8 0 0 0-1.3 3.1c.3.3.5.7.5 1.1 0 .9-.7 1.8-1.8 1.8z"/><circle cx="7.5" cy="11.5" r="1" fill="currentColor"/><circle cx="10.5" cy="7.5" r="1" fill="currentColor"/><circle cx="15" cy="8" r="1" fill="currentColor"/></svg>
      </button>
      <button class="rft-btn rft-pin" title="Pin (kunci agar tetap terbuka)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.5V4h6v6.5l2 3.5H7l2-3.5z"/></svg>
      </button>
      <button class="rft-btn rft-new" title="Lembar baru (RecallTape baru)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
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
      <button class="rft-btn rft-close" title="Tutup lembar ini">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  </div>
  <textarea class="rft-editor" spellcheck="false" placeholder="Ketik angka + operator, Enter = hitung otomatis.

+   1200
-    200  lalu Enter:
─────
→    1.000  📋

Percent: + 10% · Suffix: k/rb/jt
Keterangan: + 1200  Gaji
Double-click baris hasil (→) = copy nilai
＋ = lembar baru · ▾ = gulung · ✕ = tutup"></textarea>
  <div class="rft-status">
    <span class="rft-autosave">✓ Tersimpan otomatis</span>
  </div>
  <div class="rft-toast"></div>
</div>
`;
})();