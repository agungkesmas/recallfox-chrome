// content/notes-cs.js — RecallNote floating note (MULTI-INSTANCE, v3.23.0; dock v3.23.2)
//
// v3.23.0 (permintaan user): tombol 📝 (pill 4 tombol / header) berarti LEMBAR
// BARU — bisa membuka 2-3+ RecallNote sekaligus. Setiap floater punya:
//   [▾ gulung] [📌 pin] [＋ lembar baru] [🖨 cetak] [⧉ salin] [🗑 kosongkan] [✕ tutup]
// Ukuran ringkas default, bisa di-resize, bisa digulung (collapse), dan AUTO
// MERAPIHKAN DIRI (auto-arrange bertumpuk rapi, tanpa tumpang tindih).
// State global: `noteInstances` (lihat lib/notes.js) — sinkron real-time antar
// tab via storage.onChanged. Link vault note per-instance (autosave tetap jalan).
//
// Warisan v3.22.x yang dipertahankan: mirror vault→notesSession, guard SHOW_*
// basi 5s, sendResponse wajib (Firefox BUG-3), CustomEvent 'rf-open-note'.
(async function () {
  if (window.__recallfoxNotesLoaded) return;
  window.__recallfoxNotesLoaded = true;
  // Chrome: dynamic import() tersedia — langsung import lib ESM.
  let notesLib;
  try { notesLib = await import(browser.runtime.getURL('lib/notes.js')); } catch (e) { console.warn('[RecallFox/Notes] Failed', e); return; }
  const RFN_SAVE_SESSION = notesLib.saveSession;
  const RFN_SAVE_PIN = notesLib.savePinState;
  const RFN_LOAD_INSTANCES = notesLib.loadInstances;
  const RFN_SAVE_INSTANCES = notesLib.saveInstances;
  if (!notesLib || !RFN_LOAD_INSTANCES || !RFN_SAVE_INSTANCES) { console.warn('[RecallFox/Notes] lib notes tidak tersedia — skip'); return; }

  // ===== v3.23.0 MULTI-INSTANCE CORE =====
  let userHiddenAt = 0;      // guard SHOW_* basi — broadcast terlambat pasca-hide diabaikan
  let lastFocusedId = null;  // target ADD_TO_NOTE
  let hostSeq = 0;           // host id unik: recallfox-notes-host, -2, -3, ...
  let reconcileChain = Promise.resolve();
  const ctrls = new Map();          // id → controller
  const saveTimers = new Map();     // id → debounce timer
  const pendingExternal = new Map();// id → teks eksternal saat textarea fokus

  async function loadTheme(){ try{ const r=await browser.storage.local.get(['settings']); let s=r.settings||{}; let t=s.theme||'auto'; if(t==='auto') t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'; return t;}catch(e){return 'dark';} }

  // ===== v3.23.1 WARNA — palet warna lembar (pilih sendiri via 🎨 + otomatis) =====
  const RF_PALETTE = ['green', 'blue', 'amber', 'rose', 'violet', 'cyan', 'orange', 'lime'];
  const RF_DEF_COLOR = 'green';
  const RF_SWATCH = { green:'#10B981', blue:'#3B82F6', amber:'#F59E0B', rose:'#F43F5E', violet:'#8B5CF6', cyan:'#06B6D4', orange:'#F97316', lime:'#84CC16' };
  function normColor(c){ return (typeof c === 'string' && RF_SWATCH[c]) ? c : null; }
  // Warna otomatis: lembar baru dapat warna yang paling jarang dipakai lembar
  // terbuka lain — buka 2-3 lembar = warna selalu berbeda (urutan mulai dari
  // warna default agar lembar pertama tetap tampilan klasik hijau).
  function pickAutoColor(list){
    const used = {};
    for (const it of (Array.isArray(list) ? list : [])) { if (!it || !it.open) continue; const c = normColor(it.color) || RF_DEF_COLOR; used[c] = (used[c] || 0) + 1; }
    const order = [RF_DEF_COLOR].concat(RF_PALETTE.filter(c => c !== RF_DEF_COLOR));
    let best = RF_DEF_COLOR, bestN = Infinity;
    for (const c of order) { const n = used[c] || 0; if (n < bestN) { bestN = n; best = c; } }
    return best;
  }

  function newData(extra){
    return Object.assign({
      id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      text: '', open: true, collapsed: false,
      x: null, y: null, w: null, h: null,
      vaultNoteId: null, color: null, createdAt: Date.now()
    }, extra || {});
  }
  async function getList(){ try{ const l = await RFN_LOAD_INSTANCES(); return Array.isArray(l) ? l : []; }catch(e){ return []; } }
  async function putList(list){ try{ await RFN_SAVE_INSTANCES(list); }catch(e){} return list; }
  async function patchLocal(id, patch){
    const list = await getList();
    const it = list.find(i => i.id === id);
    if (it) { Object.assign(it, patch); await putList(list); }
    return list;
  }

  // ===== Controller per instance =====
  function buildCtrl(data){
    const host = document.createElement('div');
    hostSeq += 1;
    host.id = 'recallfox-notes-host' + (hostSeq > 1 ? '-' + hostSeq : '');
    host.style.cssText = 'all:initial;position:fixed;top:0;right:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    document.documentElement.appendChild(host);
    // v3.23.5: anti bocor keyboard — shortcut situs tidak ikut terpicu
    // saat mengetik/mencet tombol di dalam floater ini.
    try { if (window.__RFDock && window.__RFDock.isolateKeys) window.__RFDock.isolateKeys(host); } catch (e) {}
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = TEMPLATE;
    const popover = shadow.querySelector('.rfn-popover');
    const textarea = shadow.querySelector('.rfn-editor');
    // v3.24.0 TASK ENGINE: editor kini contenteditable berbasis baris.
    // Fasad `.value` 1:1 (baca = serialisasi, tulis = bangun ulang) — semua
    // kode lama (autosave, vault, sinkron antar-tab, salin/cetak, status)
    // tetap berjalan tanpa diubah. Hanya hidup di dalam RecallNote.
    try { installNoteTaskEngine(shadow, textarea, { save: scheduleSave, status: updateStatus, active: setActive }); } catch (e) {}
    const statusAutosave = shadow.querySelector('.rfn-autosave');
    const pinBtn = shadow.querySelector('.rfn-pin');
    const st = { isVisible: false, pinned: true, prevH: '' };
    let roTimer = null;

    function updateStatus(){ if(statusAutosave){ const len=textarea.value.length; const words=textarea.value.trim()?textarea.value.trim().split(/\s+/).length:0; statusAutosave.textContent=len?`✓ Tersimpan otomatis · ${words} kata`:'✓ Tersimpan otomatis'; } }
    function setActive(){ try{ if(popover) popover.classList.remove('rfn-idle'); }catch(e){} }
    function setIdle(){ try{ if(!st.isVisible) return; if(popover) popover.classList.add('rfn-idle'); }catch(e){} }
    // v3.23.1: warna lembar — data-color di popover + tandai swatch aktif
    function applyColor(){
      const c = normColor(data.color) || RF_DEF_COLOR;
      try{ popover.dataset.color = c; }catch(e){}
      try{ popover.setAttribute('data-color', c); }catch(e){}
      try{
        const pal = shadow.querySelector('.rfn-palette');
        const sw = pal ? pal.querySelectorAll('.rfn-swatch') : [];
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
        popover.classList.toggle('rfn-min', !!data.collapsed);
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
    // reconcile → salin field dari storage ke instance ini (tanpa menulis)
    function applyFrom(d){
      try{
        if (typeof d.text === 'string') applyText(d.text, false);
        if (typeof d.vaultNoteId !== 'undefined') data.vaultNoteId = d.vaultNoteId || null;
        if (typeof d.color === 'string' && d.color !== data.color) { const nc = normColor(d.color); if (nc) { data.color = nc; applyColor(); } }
        if (typeof d.w === 'number') data.w = d.w;
        if (typeof d.h === 'number') data.h = d.h;
        // v3.23.2 DOCK: x/y tidak lagi direkonsiliasi (dock yang menata posisi)
        const colChanged = (!!d.collapsed !== !!data.collapsed);
        if (typeof d.collapsed === 'boolean') data.collapsed = d.collapsed;
        if (colChanged) applyGeometry();
      }catch(e){}
    }
    async function show(){
      try{ const theme = await loadTheme(); shadow.host.setAttribute('data-theme', theme); }catch(e){}
      try{ host.style.display = ''; }catch(e){}
      applyColor();
      applyGeometry();
      // v3.23.0: instance baru dengan teks awal (mis. dari OPEN_NOTE_VAULT /
      // reconcile) harus memuat data.text ke textarea saat pertama tampil.
      if (typeof data.text === 'string' && data.text && !textarea.value) { textarea.value = data.text; updateStatus(); }
      popover.classList.add('rfn-show');
      st.isVisible = true;
      lastFocusedId = data.id;
      try{ popover.classList.add('rfn-idle'); }catch(e){}
      setTimeout(()=>{ try{ textarea.focus(); }catch(e){} }, 50);
    }
    function hideDom(){ if(popover) { popover.classList.remove('rfn-show'); popover.classList.remove('rfn-idle'); } st.isVisible = false; }
    function destroy(){ try{ if (window.__RFDock) window.__RFDock.unregister('note:' + data.id); }catch(e){} try{ host.remove(); }catch(e){} }
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
    function focusSoon(){ setTimeout(()=>{ try{ textarea.focus(); }catch(e){} }, 60); }
    function append(t){ textarea.value += (textarea.value ? '\n' : '') + String(t == null ? '' : t); updateStatus(); scheduleSave(); setActive(); }
    function applyTextForce(t){ if (typeof t === 'string') { textarea.value = t; updateStatus(); } }

    function scheduleSave(){
      if (saveTimers.has(data.id)) clearTimeout(saveTimers.get(data.id));
      if(statusAutosave){statusAutosave.textContent='⏳ Menyimpan…'; statusAutosave.style.color='#F0B64A';}
      saveTimers.set(data.id, setTimeout(async()=>{
        try{
          data.text = textarea.value;
          const list = await getList();
          const it = list.find(i => i.id === data.id);
          if (it) { it.text = textarea.value; if (data.vaultNoteId) it.vaultNoteId = data.vaultNoteId; }
          else list.push(JSON.parse(JSON.stringify(data)));
          await putList(list);
          // autosave ke vault note bila instance terhubung (paritas v3.22.8)
          if (data.vaultNoteId) { try{ await browser.runtime.sendMessage({ type:'UPDATE_VAULT_NOTE', noteId: data.vaultNoteId, text: textarea.value }); }catch(e){} }
          // mirror instance pertama → notesSession (kompat pembaca lama)
          if (list.length && list[0].id === data.id) { try{ await RFN_SAVE_SESSION(textarea.value); }catch(e){} }
        }catch(e){}
        updateStatus(); if(statusAutosave) statusAutosave.style.color='';
      },500));
    }
    async function doCopy(){ const t=textarea.value; if(!t.trim()){toast('Catatan kosong');return;} try{await navigator.clipboard.writeText(t); flashBtn('.rfn-copy'); toast('📋 Tersalin');}catch(e){ const ta=document.createElement('textarea'); ta.value=t; document.body.appendChild(ta); ta.select(); try{document.execCommand('copy'); flashBtn('.rfn-copy'); toast('📋 Tersalin');}catch(e2){} ta.remove();}}
    function doPrint(){ const t=textarea.value; if(!t.trim()){toast('Catatan kosong');return;} const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); const html='<!DOCTYPE html><html><head><meta charset="utf-8"><title>RecallNote</title><style>@page{size:80mm auto;margin:2mm}*{box-sizing:border-box;margin:0;padding:0}html,body{background:#fff;color:#000;font-family:Menlo,monospace;font-size:10px;line-height:1.6}body{padding:4mm;max-width:72mm;margin:0 auto;white-space:pre-wrap}</style></head><body><div style="text-align:center;border-bottom:1px dashed #000;padding-bottom:3mm;margin-bottom:3mm"><h1>📝 RecallNote</h1><div style="font-size:9px;color:#666">'+new Date().toLocaleString('id-ID')+'</div></div><div>'+esc(t)+'</div></body></html>'; const iframe=document.createElement('iframe'); iframe.style.cssText='position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0'; document.body.appendChild(iframe); try{ const doc=iframe.contentWindow.document; doc.open(); doc.write(html); doc.close();}catch(e){toast('Gagal cetak'); iframe.remove(); return;} setTimeout(()=>{try{iframe.contentWindow.focus(); iframe.contentWindow.print();}catch(e){} setTimeout(()=>{try{iframe.remove()}catch(e){}},2000);},300); flashBtn('.rfn-print');}
    async function doSave(){ const t=textarea.value; if(!t.trim()){toast('Catatan kosong');return;} try{ await browser.runtime.sendMessage({type:'SAVE_NOTE_TO_VAULT', text:t, markdown:t}); toast('✓ Tersimpan ke Catatan'); flashBtn('.rfn-save');}catch(e){ if(shadow.querySelector('.rfn-save')) flashBtn('.rfn-save'); toast('Gagal simpan: '+(e.message||e)); }}
    function doClear(){ if(!textarea.value.trim()) return; if(!confirm('Kosongkan catatan?')) return; textarea.value=''; updateStatus(); scheduleSave(); textarea.focus(); flashBtn('.rfn-clear');}
    function flashBtn(s){ const b=shadow.querySelector(s); if(!b) return; b.classList.add('rfn-flash'); setTimeout(()=>b.classList.remove('rfn-flash'),600);}
    function toast(m){ const t=shadow.querySelector('.rfn-toast'); if(!t) return; t.textContent=m; t.classList.add('rfn-show'); setTimeout(()=>t.classList.remove('rfn-show'),2000);}

    // ===== v3.24.0 TASK ENGINE — RecallNote sebagai daftar tugas ringan =====
    // v3.24.2 REWRITE "TYPING NATURAL + DELETE SELALU JALAN": akar dua bug user
    // (ngetik vertikal & teks tak bisa dihapus) adalah ELEMEN radio
    // contenteditable=false di dalam alur teks + baris yang KEHILANGAN span
    // (mis. setelah Ctrl+A+Backspace Chrome meninggalkan div+br tanpa span;
    // ketikan berikutnya jadi text node liar, konversi '>' membunuh caret,
    // dan Backspace menabrak objek non-editable sehingga Chrome MENOLAK
    // menghapus). Desain baru:
    //   1. RADIO = PSEUDO-ELEMENT ::before pada .rfn-task — NOL elemen
    //      non-editable di alur teks; Backspace/Delete selalu native.
    //      Toggle = klik gutter kiri (<=25px) baris task.
    //   2. rfNormalize() tiap input: baris TANPA span disembuhkan (konten
    //      dipindah ke span baru, caret dipulihkan), text node liar di root
    //      digabung ke baris tetangga, <br> sisa dibuang, editor SELALU
    //      >= 1 baris, caret selalu dipulihkan bila mati.
    //   3. Ketikan biasa = NOL mutasi DOM (browser native 100%); bedah hanya
    //      pada aksi struktural (Enter/Backspace tepi/Delete tepi/paste/
    //      konversi '>'/klik gutter) dan tiap bedah memulihkan caret.
    //   4. Fasad .value 1:1 (get = serialisasi murni, set = rebuild) — semua
    //      kode lama (autosave/vault/sinkron antar-tab/salin/cetak) utuh.
    // Baris berawalan '>' = subtask aktif (radio + indent), '>x ' = selesai
    // (tercoret + turun ke dasar deret sesuai urutan selesai). Klik radio =
    // toggle. Hanya aktif di dalam RecallNote.
    // RF_TASK_MODEL_START (fungsi murni — diuji langsung oleh task_sim)
    function parseTaskLine(raw){
      const s = String(raw == null ? '' : raw);
      const t = s.replace(/^\s+/, '');
      if (t === '>') return { kind: 'task', text: '' };
      if (t === '>x') return { kind: 'done', text: '' };
      if (t.indexOf('>x ') === 0) return { kind: 'done', text: t.slice(3) };
      if (t.indexOf('> ') === 0) return { kind: 'task', text: t.slice(2) };
      return { kind: 'plain', text: s };
    }
    function serializeTaskLine(kind, text){
      const t = String(text == null ? '' : text);
      if (kind === 'done') return '>x ' + t;
      if (kind === 'task') return '> ' + t;
      return t;
    }
    // RF_TASK_MODEL_END
    // v3.24.2: baris yang BARU saja dikonversi '>' — spasi pertama ketikan
    // user setelahnya ditelan agar serialisasi tetap '> teks' (satu spasi).
    const rfJustConv = (typeof Set !== 'undefined') ? new Set() : [];
    function rfKids(el){ try { return Array.prototype.slice.call(el.children || []); } catch (e) { return []; } }
    function rfSpanOf(ln){
      for (const c of rfKids(ln)) { try { if (c.classList && c.classList.contains('rfn-line-txt')) return c; } catch (e) {} }
      return null;
    }
    function rfLineText(ln){
      const sp = rfSpanOf(ln);
      if (sp) { try { return String(sp.textContent == null ? '' : sp.textContent); } catch (e) { return ''; } }
      try { return String(ln.textContent == null ? '' : ln.textContent); } catch (e) { return ''; }
    }
    function rfSetLineText(ln, v){
      const sp = rfSpanOf(ln);
      if (sp) { try { sp.textContent = String(v == null ? '' : v); return; } catch (e) {} }
      try { ln.textContent = String(v == null ? '' : v); } catch (e) {}
    }
    function rfFirstText(n){
      // text node pertama (telusur ringan) di dalam sebuah elemen
      try {
        if (!n || n.nodeType !== 1 || !n.childNodes) return null;
        for (const c of n.childNodes) {
          if (!c) continue;
          if (c.nodeType === 3) return c;
          const d = rfFirstText(c);
          if (d) return d;
        }
      } catch (e) {}
      return null;
    }
    function rfEnsureTextHost(sp){
      // pastikan span punya minimal satu text node (rumah caret) —
      // textContent='' TIDAK meninggalkan node; buat eksplisit.
      try {
        if (!sp || sp.nodeType !== 1) return null;
        for (const c of (sp.childNodes || [])) { try { if (c && c.nodeType === 3) return c; } catch (e) {} }
        if (typeof document !== 'undefined' && document.createTextNode) {
          const tn = document.createTextNode('');
          try { sp.appendChild(tn); return tn; } catch (e) { return null; }
        }
      } catch (e) {}
      return null;
    }
    function rfMakeLine(m){
      // v3.24.2: TANPA elemen radio — radio murni CSS ::before (caret & delete
      // tidak pernah tersangkut objek non-editable lagi).
      const ln = document.createElement('div');
      try {
        ln.classList.add('rfn-line');
        if (m.kind !== 'plain') ln.classList.add('rfn-task');
        if (m.kind === 'done') ln.classList.add('rfn-done');
      } catch (e) {}
      const tx = document.createElement('span');
      try { tx.classList.add('rfn-line-txt'); } catch (e) {}
      // span SELALU lahir dengan text node sungguhan — rumah caret sejak
      // detik pertama (teks kosong pun tetap punya node).
      try {
        tx.appendChild(document.createTextNode(String(m.text == null ? '' : m.text)));
      } catch (e) { try { tx.textContent = String(m.text == null ? '' : m.text); } catch (e2) {} }
      ln.appendChild(tx);
      return ln;
    }
    // ---- seleksi & caret (semua di-guard; stub tanpa seleksi = no-op aman) ----
    function rfGetSel(){
      let sel = null;
      try { if (shadow.getSelection) sel = shadow.getSelection(); } catch (e) {}
      if ((!sel || !sel.rangeCount) && typeof window !== 'undefined' && window.getSelection) {
        try { sel = window.getSelection(); } catch (e) {}
      }
      try { if (!sel || !sel.rangeCount) return null; } catch (e) { return null; }
      return sel;
    }
    function rfLineOfNode(node){
      let cur = node, guard = 0;
      while (cur && guard++ < 30) {
        try {
          if (cur.classList && cur.classList.contains('rfn-line') && cur.parentNode === textarea) return cur;
        } catch (e) {}
        try { cur = cur.parentNode; } catch (e) { return null; }
      }
      return null;
    }
    function rfFocusedLine(){
      const sel = rfGetSel(); if (!sel) return null;
      let node = null;
      try { node = sel.getRangeAt(0).startContainer; } catch (e) { return null; }
      return rfLineOfNode(node);
    }
    function rfCaretInTextNode(n){
      // offset caret BILA caret sedang berada di dalam text node n, else -1
      try {
        const sel = rfGetSel(); if (!sel) return -1;
        const r = sel.getRangeAt(0);
        if (r && r.startContainer === n && typeof r.startOffset === 'number') return r.startOffset;
      } catch (e) {}
      return -1;
    }
    function rfCaretOffsetIn(root, preferSpan){
      // offset karakter caret di dalam teks `root` (span atau line).
      // Manual-walk (bukan Range.toString) — kompatibel stub sim & browser.
      try {
        const sel = rfGetSel(); if (!sel || !sel.rangeCount) return -1;
        const r = sel.getRangeAt(0);
        const n = r.startContainer, off = r.startOffset;
        if (n === root) return off <= 0 ? 0 : String(root.textContent || '').length;
        if (n && n.nodeType === 3) {
          try { if (n.parentNode === root) return typeof off === 'number' ? off : 0; } catch (e) {}
          // bersarang di elemen inline di dalam root
          let acc = 0, found = false;
          (function walk(x) {
            if (!x || found) return;
            const cs = x.childNodes || [];
            for (let i = 0; i < cs.length; i++) {
              if (found) return;
              const c = cs[i];
              if (c === n) { found = true; return; }
              if (c.nodeType === 3) acc += String(c.textContent || '').length;
              else walk(c);
            }
          })(root);
          if (found) return acc + (typeof off === 'number' ? off : 0);
          return -1;
        }
      } catch (e) {}
      return -1;
    }
    function rfCaretInLine(ln){
      // offset karakter caret di dalam span baris; -1 bila caret di luar ln
      try {
        const sp = rfSpanOf(ln);
        if (!sp) return -1;
        const o = rfCaretOffsetIn(sp, true);
        if (o >= 0) return o;
        // caret di level elemen ln (bukan di span) — map ke 0/panjang
        try {
          const sel = rfGetSel();
          if (sel && sel.rangeCount && sel.getRangeAt(0).startContainer === ln) {
            const off = sel.getRangeAt(0).startOffset;
            return off <= 0 ? 0 : String(sp.textContent || '').length;
          }
        } catch (e) {}
        return -1;
      } catch (e) { return -1; }
    }
    function rfPlaceCaret(ln, charOff){
      try {
        const sp = rfSpanOf(ln);
        if (!sp || typeof document === 'undefined' || !document.createRange) return;
        const target = Math.max(0, Math.floor(charOff || 0));
        const tns = [];
        (function collect(x) {
          if (!x) return;
          const cs = x.childNodes || [];
          for (let i = 0; i < cs.length; i++) {
            const c = cs[i];
            if (c.nodeType === 3) tns.push(c);
            else collect(c);
          }
        })(sp);
        if (!tns.length) { const tn = rfEnsureTextHost(sp); if (tn) tns.push(tn); }
        let node = tns[0], off = 0, acc = 0;
        for (let i = 0; i < tns.length; i++) {
          const len = String(tns[i].textContent || '').length;
          if (target <= acc + len) { node = tns[i]; off = target - acc; break; }
          acc += len; node = tns[i]; off = len;
        }
        const rg = document.createRange();
        rg.setStart(node, off); rg.collapse(true);
        const sel = rfGetSel(); if (!sel) return;
        if (sel.removeAllRanges) sel.removeAllRanges();
        if (sel.addRange) sel.addRange(rg);
      } catch (e) {}
    }
    function rfSelCollapsed(){
      try { const sel = rfGetSel(); if (sel && sel.isCollapsed === false) return false; } catch (e) {}
      return true;
    }
    function rfEditorFocused(){ try { return shadow.activeElement === textarea; } catch (e) { return false; } }
    function rfCaretAlive(){
      try {
        const sel = rfGetSel(); if (!sel || !sel.rangeCount) return false;
        const n = sel.getRangeAt(0).startContainer;
        return !!(n && n.nodeType === 3 && rfLineOfNode(n));
      } catch (e) { return false; }
    }
    function rfRescueCaret(){
      // caret mati (di root / di luar editor) → pulihkan ke akhir baris
      // terakhir. HANYA saat editor memang sedang fokus (tak mencuri fokus).
      try {
        if (!rfEditorFocused() || rfCaretAlive()) return;
        const ks = rfKids(textarea);
        if (ks.length) { const last = ks[ks.length - 1]; rfPlaceCaret(last, rfLineText(last).length); }
      } catch (e) {}
    }
    // ---- NORMALISATOR (inti anti-rusak: invarian DOM dijaga tiap input) ----
    function rfHealLine(ln){
      // Pastikan baris selalu: span.rfn-line-txt sebagai satu-satunya rumah
      // teks. Baris tanpa span (sisa Ctrl+A+Backspace / operasi Chrome)
      // dikasih span baru; node liar di dalam baris dipindah ke dalam span;
      // <br> sisa dibuang. Caret dipulihkan bila ikut terdampak.
      try {
        if (!ln || !ln.classList || !ln.classList.contains('rfn-line')) return;
        let sp = rfSpanOf(ln);
        if (!sp) {
          const cin = rfCaretOffsetIn(ln, false);
          sp = document.createElement('span');
          try { sp.classList.add('rfn-line-txt'); } catch (e) {}
          const kids = Array.prototype.slice.call(ln.childNodes || []);
          for (const c of kids) {
            try {
              if (c.nodeType === 1 && c.tagName === 'BR') { try { ln.removeChild(c); } catch (e2) {} continue; }
              try { sp.appendChild(c); } catch (e2) {}
            } catch (e2) {}
          }
          if (!sp.childNodes.length) { try { sp.appendChild(document.createTextNode('')); } catch (e2) {} }
          try { ln.insertBefore(sp, ln.firstChild); } catch (e) { ln.appendChild(sp); }
          if (cin >= 0) rfPlaceCaret(ln, cin);
          return;
        }
        // span ada — cari node liar (bukan span itu sendiri)
        let strays = null;
        for (const c of (ln.childNodes || [])) {
          try { if (c !== sp && !(c.nodeType === 1 && c.classList && c.classList.contains('rfn-line-txt'))) { strays = strays || []; strays.push(c); } } catch (e) {}
        }
        if (!strays) return;
        let caretNode = null;
        try { const sel = rfGetSel(); if (sel && sel.rangeCount) caretNode = sel.getRangeAt(0).startContainer; } catch (e) {}
        const caretInStray = !!(caretNode && strays.some(s => s === caretNode || (s.contains && s.contains(caretNode))));
        const cin = caretInStray ? rfCaretOffsetIn(ln, false) : -1;
        for (const c of strays) {
          try {
            if (c.nodeType === 1 && c.tagName === 'BR') { try { ln.removeChild(c); } catch (e2) {} continue; }
            const t = String(c.textContent || '');
            try { ln.removeChild(c); } catch (e2) { continue; }
            if (!t) continue;
            // gabung ke text node TERAKHIR span (urutan visual terjaga)
            let tn = null;
            for (const x of sp.childNodes) { try { if (x.nodeType === 3) tn = x; } catch (e2) {} }
            if (!tn) tn = rfEnsureTextHost(sp);
            if (tn && tn.appendData) { try { tn.appendData(t); } catch (e2) { rfSetLineText(ln, rfLineText(ln) + t); } }
            else rfSetLineText(ln, rfLineText(ln) + t);
          } catch (e2) {}
        }
        if (caretInStray && cin >= 0) rfPlaceCaret(ln, Math.min(cin, String(sp.textContent || '').length));
      } catch (e) {}
    }
    function rfNormalize(){
      // root editor: node liar TEKS digabung ke baris tetangga (bukan baris
      // baru — sumber bug "ngetik vertikal"), <br> root dibuang, elemen liar
      // (artefak paste) jadi baris di tempat, semua baris di-heal, editor
      // SELALU berakhir >= 1 baris.
      try {
        const kids = Array.prototype.slice.call(textarea.childNodes || []);
        let lastLine = null;
        for (const n of kids) {
          try {
            const isText = !!(n && n.nodeType === 3);
            const isLine = !!(n && n.classList && n.classList.contains('rfn-line'));
            if (isLine) { lastLine = n; rfHealLine(n); continue; }
            if (n && n.nodeType === 1 && n.tagName === 'BR') { try { textarea.removeChild(n); } catch (e2) {} continue; }
            if (isText) {
              const t = String(n.textContent || '');
              const caretIn = rfCaretInTextNode(n);
              try { textarea.removeChild(n); } catch (e2) {}
              if (!t) continue;
              let target = lastLine;
              if (!target) {
                const ks = rfKids(textarea);
                target = ks.length ? ks[0] : null;
              }
              if (!target) {
                target = rfMakeLine({ kind: 'plain', text: '' });
                try { textarea.insertBefore(target, n); } catch (e2) { textarea.appendChild(target); }
              }
              const sp = rfSpanOf(target);
              const baseLen = sp ? String(sp.textContent || '').length : 0;
              let merged = false;
              if (sp) {
                let tn = null;
                for (const x of sp.childNodes) { try { if (x.nodeType === 3) tn = x; } catch (e2) {} }
                if (!tn) tn = rfEnsureTextHost(sp);
                if (tn && tn.appendData) { try { tn.appendData(t); merged = true; } catch (e2) {} }
              }
              if (!merged) rfSetLineText(target, rfLineText(target) + t);
              if (caretIn >= 0) rfPlaceCaret(target, baseLen + caretIn);
              rfHealLine(target);
              lastLine = target;
              continue;
            }
            const t2 = String((n && n.textContent) || '');
            const next = n.nextSibling || null;
            try { textarea.removeChild(n); } catch (e2) { continue; }
            if (!t2.trim()) continue;
            const nl = rfMakeLine(parseTaskLine(t2));
            try { textarea.insertBefore(nl, next); } catch (e2) { textarea.appendChild(nl); }
            lastLine = nl;
          } catch (e2) {}
        }
        if (!rfKids(textarea).length) textarea.appendChild(rfMakeLine({ kind: 'plain', text: '' }));
      } catch (e) {}
    }
    function rfRederive(){
      // konversi live: plain line yang mulai diketik '>' menjadi task/radio.
      // Marker dibuang lewat deleteData pada text node yang SAMA (node
      // penumpu caret tidak dibunuh) + caret baris fokus dipulihkan.
      // v3.24.2: telan SATU spasi ketikan user tepat setelah konversi agar
      // serialisasi tetap '> teks' (bukan '>  teks' dobel spasi).
      try {
        for (const ln of Array.from(rfJustConv)) {
          try {
            rfJustConv.delete(ln);
            const sp = rfSpanOf(ln);
            if (!sp) continue;
            const t = String(sp.textContent || '');
            if (t.indexOf(' ') === 0) {
              const caretOff = rfCaretInLine(ln);
              const tn = rfFirstText(sp);
              let k = false;
              if (tn && tn.deleteData && String(tn.textContent || '').length >= 1) { try { tn.deleteData(0, 1); k = true; } catch (e2) {} }
              if (k && caretOff >= 0) rfPlaceCaret(ln, Math.max(0, caretOff - 1));
            }
          } catch (e2) {}
        }
      } catch (e2) {}
      for (const ln of rfKids(textarea)) {
        try {
          if (!ln.classList || !ln.classList.contains('rfn-line')) continue;
          if (ln.classList.contains('rfn-task') || ln.classList.contains('rfn-done')) continue;
          const before = rfLineText(ln);
          const m = parseTaskLine(before);
          if (m.kind === 'plain') continue;
          const isFocused = (ln === rfFocusedLine());
          const caretOff = isFocused ? rfCaretInLine(ln) : -1;
          ln.classList.add('rfn-task');
          if (m.kind === 'done') ln.classList.add('rfn-done');
          const sp = rfSpanOf(ln);
          const markerLen = before.length - m.text.length;
          let done = false;
          if (sp && markerLen > 0) {
            const tn = rfFirstText(sp);
            if (tn && tn.deleteData && String(tn.textContent || '').length >= markerLen) {
              try { tn.deleteData(0, markerLen); done = true; } catch (e2) {}
            }
          }
          if (!done) rfSetLineText(ln, m.text);
          if (isFocused && caretOff >= 0) rfPlaceCaret(ln, Math.max(0, caretOff - markerLen));
          try { rfJustConv.add(ln); } catch (e2) {}
        } catch (e2) {}
      }
    }
    function rfGetText(){
      // MURNI — membaca .value (autosave/status/salin) tidak boleh memutasi
      // DOM / merusak caret.
      const out = [];
      for (const ln of rfKids(textarea)) {
        try {
          if (!ln.classList || !ln.classList.contains('rfn-line')) continue;
          const txt = rfLineText(ln);
          out.push(ln.classList.contains('rfn-done') ? serializeTaskLine('done', txt)
                 : ln.classList.contains('rfn-task') ? serializeTaskLine('task', txt)
                 : txt);
        } catch (e) {}
      }
      return out.join('\n');
    }
    function rfSyncEmptyClass(){
      // placeholder pindah dari CSS :empty ke class rfn-empty (editor selalu
      // berisi >= 1 baris, jadi :empty tak pernah cocok lagi)
      try {
        let any = false;
        for (const ln of rfKids(textarea)) {
          if (ln.classList && ln.classList.contains('rfn-line') && String(rfLineText(ln) || '').length) { any = true; break; }
        }
        textarea.classList.toggle('rfn-empty', !any);
      } catch (e) {}
    }
    function rfRebuild(text){
      const s = String(text == null ? '' : text);
      const parts = s.split('\n');
      try { while (textarea.children && textarea.children.length) textarea.removeChild(textarea.children[textarea.children.length - 1]); } catch (e) {}
      // SELALU >= 1 baris — editor tak pernah benar-benar kosong (caret selalu
      // punya rumah). Teks kosong = SATU baris kosong + placeholder via class.
      if (s === '') { textarea.appendChild(rfMakeLine({ kind: 'plain', text: '' })); rfSyncEmptyClass(); return; }
      for (const p of parts) { try { textarea.appendChild(rfMakeLine(parseTaskLine(p))); } catch (e) {} }
      if (!rfKids(textarea).length) textarea.appendChild(rfMakeLine({ kind: 'plain', text: '' }));
      rfSyncEmptyClass();
    }
    // Fasad `.value` — kontrak lama textarea dipertahankan penuh.
    try {
      Object.defineProperty(textarea, 'value', {
        configurable: true,
        get() { try { return rfGetText(); } catch (e) { return ''; } },
        set(v) { try { rfRebuild(typeof v === 'string' ? v : String(v == null ? '' : v)); } catch (e) {} }
      });
    } catch (e) {}
    function rfAfterStructural(){
      try { rfNormalize(); } catch (e) {}
      try { rfRederive(); } catch (e) {}
      try { rfSyncEmptyClass(); } catch (e) {}
      try { updateStatus(); } catch (e) {}
      try { scheduleSave(); } catch (e) {}
      try { setActive(); } catch (e) {}
      try { rfRescueCaret(); } catch (e) {}
    }
    function rfSplitAtCaret(){
      const kids = rfKids(textarea);
      if (!kids.length) { textarea.appendChild(rfMakeLine({ kind: 'plain', text: '' })); return; }
      let ln = rfFocusedLine();
      if (!ln || kids.indexOf(ln) < 0) ln = kids[kids.length - 1];
      const off = rfCaretInLine(ln);
      const cur = rfLineText(ln);
      const hasCaret = off >= 0;
      const before = hasCaret ? cur.slice(0, off) : cur;
      const after = hasCaret ? cur.slice(off) : '';
      rfSetLineText(ln, before);
      const nl = rfMakeLine({ kind: 'plain', text: after });
      try { textarea.insertBefore(nl, ln.nextSibling || null); } catch (e) { textarea.appendChild(nl); }
      rfPlaceCaret(nl, 0);
      rfSyncEmptyClass();
    }
    function rfMergeWithPrev(ln){
      const kids = rfKids(textarea);
      const i = kids.indexOf(ln);
      if (i <= 0) return false;
      const prev = kids[i - 1];
      const pt = rfLineText(prev);
      rfSetLineText(prev, pt + rfLineText(ln));
      try { textarea.removeChild(ln); } catch (e) { return false; }
      rfPlaceCaret(prev, pt.length);
      rfSyncEmptyClass();
      return true;
    }
    function rfMergeNext(ln){
      const kids = rfKids(textarea);
      const i = kids.indexOf(ln);
      if (i < 0 || i >= kids.length - 1) return false;
      const nxt = kids[i + 1];
      const ct = rfLineText(ln);
      rfSetLineText(ln, ct + rfLineText(nxt));
      try { textarea.removeChild(nxt); } catch (e) { return false; }
      rfPlaceCaret(ln, ct.length);
      rfSyncEmptyClass();
      return true;
    }
    function rfToggleDone(ln){
      const wasDone = ln.classList.contains('rfn-done');
      const wasFocused = (rfFocusedLine() === ln);
      const saveOff = rfCaretInLine(ln);
      try { ln.classList.toggle('rfn-done', !wasDone); ln.classList.add('rfn-task'); } catch (e) {}
      try { textarea.removeChild(ln); } catch (e) {}
      if (!wasDone) {
        // selesai → turun ke dasar deret (urutan waktu selesai)
        try { textarea.appendChild(ln); } catch (e) {}
      } else {
        // aktif lagi → tepat sebelum blok done pertama
        let ref = null;
        for (const c of rfKids(textarea)) {
          try { if (c !== ln && c.classList && c.classList.contains('rfn-done')) { ref = c; break; } } catch (e2) {}
        }
        try { if (ref) textarea.insertBefore(ln, ref); else textarea.appendChild(ln); } catch (e) {}
      }
      rfAfterStructural();
      if (wasFocused) rfPlaceCaret(ln, saveOff >= 0 ? saveOff : rfLineText(ln).length);
    }
    function rfInsertText(txt){
      const parts = String(txt == null ? '' : txt).replace(/\r\n?/g, '\n').split('\n');
      let ln = rfFocusedLine();
      let kids = rfKids(textarea);
      if (!ln || kids.indexOf(ln) < 0) {
        if (!kids.length) { textarea.appendChild(rfMakeLine({ kind: 'plain', text: '' })); kids = rfKids(textarea); ln = kids[0]; }
        else ln = kids[kids.length - 1];
      }
      const off = rfCaretInLine(ln);
      const cur = rfLineText(ln);
      const before = off >= 0 ? cur.slice(0, off) : cur;
      const after = off >= 0 ? cur.slice(off) : '';
      rfSetLineText(ln, before + parts[0]);
      let anchor = ln;
      for (let i = 1; i < parts.length; i++) {
        const nl = rfMakeLine({ kind: 'plain', text: parts[i] });
        try { textarea.insertBefore(nl, anchor.nextSibling || null); } catch (e) { textarea.appendChild(nl); }
        anchor = nl;
      }
      if (after) rfSetLineText(anchor, rfLineText(anchor) + after);
      if (parts.length === 1) rfPlaceCaret(ln, (before + parts[0]).length);
      else rfPlaceCaret(anchor, rfLineText(anchor).length);
      rfSyncEmptyClass();
    }
    function installNoteTaskEngine(){
      let composing = false;
      const onInput = () => {
        // Ketikan biasa = keempat langkah NO-OP total (tidak ada node liar /
        // tidak ada awalan '>' / span sehat) — DOM tak disentuh, caret hidup.
        // Hanya ketikan yang MENGUBAH struktur yang memicu bedah.
        try { if (composing) return; rfNormalize(); rfRederive(); rfSyncEmptyClass(); rfRescueCaret(); } catch (e) {}
      };
      try {
        textarea.addEventListener('input', onInput);
        textarea.addEventListener('compositionstart', () => { try { composing = true; } catch (e) {} });
        textarea.addEventListener('compositionend', () => { try { composing = false; onInput(); } catch (e) {} });
        // Enter jalur non-keyboard (IME/mobile) menyisipkan <br>/<div> liar —
        // sanggut di beforeinput sebelum browser melakukannya.
        textarea.addEventListener('beforeinput', (e) => {
          try {
            const it = e && e.inputType;
            if (it === 'insertLineBreak' || it === 'insertParagraph') {
              if (e.preventDefault) e.preventDefault();
              rfSplitAtCaret();
              rfAfterStructural();
            }
          } catch (ee) {}
        });
        textarea.addEventListener('keydown', (e) => {
          try {
            if (composing) return;
            const k = e && e.key;
            if (k === 'Enter') { e.preventDefault(); rfSplitAtCaret(); rfAfterStructural(); return; }
            if (k === 'Backspace') {
              // seleksi rentang → biarkan native menghapus seleksi
              if (!rfSelCollapsed()) return;
              const ln = rfFocusedLine();
              if (ln && rfCaretInLine(ln) === 0 && rfMergeWithPrev(ln)) { e.preventDefault(); rfAfterStructural(); }
              return;
            }
            if (k === 'Delete') {
              if (!rfSelCollapsed()) return;
              const ln = rfFocusedLine();
              if (ln && rfCaretInLine(ln) === rfLineText(ln).length && rfMergeNext(ln)) { e.preventDefault(); rfAfterStructural(); }
              return;
            }
          } catch (ee) {}
        });
        textarea.addEventListener('paste', (e) => {
          try {
            if (composing) return;
            const cd = e && e.clipboardData;
            const t = cd && cd.getData ? cd.getData('text/plain') : null;
            if (t == null) return;
            e.preventDefault();
            rfInsertText(t);
            rfAfterStructural();
          } catch (ee) {}
        });
        textarea.addEventListener('click', (e) => {
          try {
            const t = e && e.target;
            if (!t) return;
            // v3.24.2: klik GUTER kiri (<=25px) baris task = toggle radio.
            // Radio kini pseudo-element ::before — bukan target event — jadi
            // hit-test manual; NOL elemen non-editable di alur teks.
            if (t.classList && t.classList.contains('rfn-line') && t.classList.contains('rfn-task') && t.parentNode === textarea) {
              let left = -1;
              try {
                if (typeof e.clientX === 'number' && t.getBoundingClientRect) {
                  left = e.clientX - t.getBoundingClientRect().left;
                }
              } catch (ee) { left = -1; }
              if (left >= 0 && left <= 25) {
                if (e.preventDefault) e.preventDefault();
                if (e.stopPropagation) e.stopPropagation();
                rfToggleDone(t);
                return;
              }
            }
            // klik area kosong editor → caret ke akhir baris terakhir
            // (mencegah caret "jatuh ke root").
            if (t === textarea) {
              const kids = rfKids(textarea);
              if (kids.length) { const last = kids[kids.length - 1]; rfPlaceCaret(last, rfLineText(last).length); }
            }
          } catch (ee) {}
        });
      } catch (e) {}
    }

    function makeDraggable(){
      const hd=shadow.querySelector('.rfn-hd');
      let d=false,dx=0,dy=0,moved=false;
      hd.addEventListener('mousedown',e=>{ if(e.target.closest('button'))return; d=true;moved=false; const rect=popover.getBoundingClientRect(); dx=e.clientX-rect.left; dy=e.clientY-rect.top; popover.style.transition='none'; e.preventDefault();});
      document.addEventListener('mousemove',e=>{ if(!d)return; moved=true; popover.style.left=(e.clientX-dx)+'px'; popover.style.top=(e.clientY-dy)+'px'; popover.style.right='auto';});
      document.addEventListener('mouseup',()=>{ if(d){ d=false; popover.style.transition=''; tidy(); } }); // v3.23.3 DOCK: lepas drag → kembali rapat ke deretan
    }

    function wireEvents(){
      try { textarea.addEventListener('input',()=>{ updateStatus(); scheduleSave(); setActive(); }); } catch(e){}
      try { textarea.addEventListener('keydown',e=>{ if(e.key==='Escape'&&!st.pinned){e.preventDefault(); closeLocal(); return;} try{ setActive(); }catch(ee){} }); } catch(e){}
      try { textarea.addEventListener('focus',()=>{ lastFocusedId=data.id; setActive(); }); } catch(e){}
      try { textarea.addEventListener('blur',()=>{ const p=pendingExternal.get(data.id); if(p!=null&&p!==textarea.value){ textarea.value=p; updateStatus(); } pendingExternal.delete(data.id); }); } catch(e){}
      try { popover.addEventListener('mouseenter',()=>{ setActive(); }); } catch(e){}
      try { popover.addEventListener('mouseleave',()=>{ setIdle(); }); } catch(e){}
      try { pinBtn.addEventListener('click',()=>{ st.pinned=!st.pinned; pinBtn.classList.toggle('rfn-active',st.pinned); try{ RFN_SAVE_PIN(st.pinned); }catch(e){} }); } catch(e){}
      try { shadow.querySelector('.rfn-collapse').addEventListener('click',()=>setCollapsed(!data.collapsed)); } catch(e){}
      try { shadow.querySelector('.rfn-color').addEventListener('click',()=>{ try{ popover.classList.toggle('rfn-pal-open'); }catch(e){} }); } catch(e){}
      try { const pal=shadow.querySelector('.rfn-palette'); if(pal) pal.addEventListener('click',(e)=>{ try{ const b=e && e.target && e.target.closest && e.target.closest('.rfn-swatch'); if(!b || !b.dataset) return; setColor(b.dataset.c); try{ popover.classList.remove('rfn-pal-open'); }catch(ee){} }catch(e){} }); } catch(e){}
      try { document.addEventListener('mousedown',(e)=>{ try{ if(!popover || !popover.classList.contains('rfn-pal-open')) return; const p=e.composedPath?e.composedPath():[e.target]; if(p.includes(host)||p.includes(popover)) return; popover.classList.remove('rfn-pal-open'); }catch(e){} },true); } catch(e){}
      try { shadow.querySelector('.rfn-new').addEventListener('click',()=>{ createInstance({}); }); } catch(e){}
      try { shadow.querySelector('.rfn-close').addEventListener('click',()=>closeLocal()); } catch(e){}
      try { shadow.querySelector('.rfn-print').addEventListener('click',doPrint); } catch(e){}
      try { shadow.querySelector('.rfn-copy').addEventListener('click',doCopy); } catch(e){}
      try { shadow.querySelector('.rfn-clear').addEventListener('click',doClear); } catch(e){}
      // klik di luar → tutup (hanya saat tidak dipin) — perilaku warisan
      try { document.addEventListener('mousedown',e=>{ if(!st.isVisible||st.pinned)return; const p=e.composedPath?e.composedPath():[e.target]; if(p.includes(host))return; closeLocal(); },true); } catch(e){}
      try { makeDraggable(); } catch(e){}
      // persist ukuran hasil resize user (guarded — ResizeObserver tak selalu ada)
      try {
        if (typeof ResizeObserver !== 'undefined') {
          const ro = new ResizeObserver(()=> {
            if (!st.isVisible || data.collapsed) return;
            if (roTimer) clearTimeout(roTimer);
            roTimer = setTimeout(()=>{ try{ const w=popover.offsetWidth, h=popover.offsetHeight; if(w>0&&h>0&&(w!==data.w||h!==data.h)){ data.w=w; data.h=h; patchLocal(data.id,{w,h}); } }catch(e){} }, 500);
          });
          ro.observe(popover);
        }
      } catch(e){}
    }
    wireEvents();
    // v3.23.4: visual pin sinkron sejak build — default TERPIN tampil tebal
    // (paritas pomodoro). Sebelumnya class rfn-active baru dipasang setelah
    // klik pertama, sehingga tombol terlihat "tidak terpin" padahal terpin.
    try { pinBtn.classList.toggle('rfn-active', st.pinned); } catch (e) {}
    // v3.23.2 DOCK: daftarkan floater ke dock global — satu deretan rapi
    // kanan-atas bersama RecallTape & RecallPomodoro (content/float-dock.js).
    try { if (window.__RFDock) window.__RFDock.register({ key: 'note:' + data.id, kind: 'note', t: data.createdAt || 0, visible: () => st.isVisible, width: () => data.collapsed ? 320 : Math.max(280, (typeof data.w === 'number' && data.w) || 320), height: () => data.collapsed ? 44 : Math.max(220, (typeof data.h === 'number' && data.h) || 300), place: (x, y) => setPos(x, y) }); } catch (e) {}

    const ctrl = { id: data.id, show, hideDom, closeLocal, destroy, setCollapsed, setPos, setTheme, append, applyFrom, applyTextForce, focusSoon, get isVisible(){ return st.isVisible; } };
    return ctrl;
  }

  // ===== Dock (v3.23.2): auto merapihkan diri via float-dock.js =====
  // Semua floater terbuka (note + tape + pomodoro) disusun SATU deretan rapi
  // di tepi kanan-atas. Setiap gulung (\u25be) / buka (>) / buka-tutup lembar
  // memicu restack penuh sehingga tampilan tidak pernah misah-misah lagi.
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
  async function createInstance(extra){
    // v3.23.1 WARNA: lembar baru otomatis dapat warna belum terpakai
    // (buka 2-3 lembar = warna berbeda); extra.color pilihan user menang.
    const preList = await getList();
    if (!extra || !normColor(extra.color)) { extra = extra || {}; extra.color = pickAutoColor(preList); }
    const d = newData(extra);
    // PENTING: daftarkan ctrl SEBELUM putList — storage.onChanged halaman ini
    // ikut berbunyi saat putList; reconcile harus menemukan instance sudah
    // terdaftar agar tidak membangun host dobel.
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
  // ⧉ vault note → pakai instance yang sudah ter-link (fokus), kalau belum ada
  // buka instance baru ter-link (autosave vault tetap nyambung).
  async function ensureVault(noteId, text){
    try{
      const list = await getList();
      const it = noteId ? list.find(i => i.vaultNoteId && i.vaultNoteId === noteId) : null;
      if (it) {
        it.open = true;
        if (typeof text === 'string' && text) it.text = text;
        await putList(list);
        let c = ctrls.get(it.id);
        if (!c) { c = buildCtrl(it); ctrls.set(it.id, c); }
        await c.show();
        if (typeof text === 'string' && text) c.applyTextForce(text);
        tidy();
        return;
      }
      await createInstance({ vaultNoteId: noteId || null, text: (typeof text === 'string') ? text : '' });
    }catch(e){
      try{ await createInstance({ vaultNoteId: noteId || null, text: (typeof text === 'string') ? text : '' }); }catch(ee){}
    }
  }
  async function addToLast(text){
    const t = String(text == null ? '' : text);
    let c = (lastFocusedId && ctrls.get(lastFocusedId)) || null;
    if (!c) {
      const list = await getList();
      const opens = list.filter(i => i.open);
      for (let k = opens.length - 1; k >= 0; k--) { const cc = ctrls.get(opens[k].id); if (cc) { c = cc; break; } }
    }
    if (!c) { await createInstance({ text: t }); return; }
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
  function captureHide(){ try{ document.querySelectorAll('[id^="recallfox-notes-host"]').forEach(h=>{ h.style.display='none'; }); }catch(e){} }
  function captureRestore(){ try{ document.querySelectorAll('[id^="recallfox-notes-host"]').forEach(h=>{ h.style.display=''; }); ctrls.forEach(c=>{ if(c.isVisible) c.show(); }); }catch(e){} }

  // ===== Message listener =====
  browser.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
    try{
      if (msg.type === 'OPEN_NOTE') createInstance({});
      else if (msg.type === 'OPEN_NOTE_VAULT') ensureVault(msg.noteId, typeof msg.text === 'string' ? msg.text : '');
      else if (msg.type === 'ADD_TO_NOTE') addToLast(msg.text);
      else if (msg.type === 'SHOW_NOTE') { if (Date.now() - userHiddenAt >= 5000) getList().then(reconcile); }
      else if (msg.type === 'HIDE_NOTE') hideAllLocal();
      else if (msg.type === 'THEME_CHANGED') { ctrls.forEach(c=>c.setTheme(msg.theme)); }
      else if (msg.type === 'RF_HIDE_FOR_CAPTURE') captureHide();
      else if (msg.type === 'RF_RESTORE_AFTER_CAPTURE') captureRestore();
    }catch(e){}
    // v3.22.4 FIX BUG-3 (Firefox): wajib balas — Firefox me-reject sendMessage
    // "Message channel closed" bila listener tidak merespons.
    if (typeof sendResponse === 'function') { try { sendResponse({ ok: true }); } catch (e) {} }
  });
  // v3.22.4 FIX BUG-5: fallback CustomEvent 'rf-open-note' dari sidebar-cs.js
  try { window.addEventListener('rf-open-note', () => { try{ createInstance({}); }catch(e){} }); } catch (e) {}

  // Boot: pulihkan semua instance open:true (auto-show, incl. file://)
  (async function boot(){ try{ const list = await getList(); await reconcile(list); }catch(e){} })();

  // Cross-tab real-time: setiap perubahan noteInstances direkonsiliasi (DOM saja,
  // tidak pernah menulis — mencegah loop). Ini penerus live-sync v3.22.8.
  try{
    browser.storage.onChanged.addListener((changes, area)=>{
      if (area !== 'local' || !changes || !changes.noteInstances) return;
      const nv = changes.noteInstances.newValue;
      if (!Array.isArray(nv)) return;
      reconcile(nv);
    });
  }catch(e){}

  // ===== Template (HTML + CSS inlined in Shadow DOM) =====
  const TEMPLATE=`<style>:host{all:initial}.rfn-popover{--p-bd:rgba(16,185,129,.25);--p-idle:rgba(19,78,74,.55);--p-idle-bd:rgba(110,231,183,.35);--p-idle-l:rgba(204,251,241,.85);--p-idle-bd-l:rgba(16,185,129,.3);--p-hd:#0F2E2A;--p-hd-bd:rgba(16,185,129,.2);--p-hd-l:#ECFDF5;--p-tt:#6EE7B7;--p-tt-l:#047857;--p-act:#134E4A;--p-act-c:#6EE7B7;--p-act-bd:rgba(110,231,183,.3);--p-flash:#10B981}.rfn-popover[data-color="blue"]{--p-bd:rgba(59,130,246,.25);--p-idle:rgba(30,58,138,.5);--p-idle-bd:rgba(147,197,253,.35);--p-idle-l:rgba(219,234,254,.85);--p-idle-bd-l:rgba(59,130,246,.3);--p-hd:#0F2440;--p-hd-bd:rgba(59,130,246,.2);--p-hd-l:#EFF6FF;--p-tt:#93C5FD;--p-tt-l:#1D4ED8;--p-act:#1E3A8A;--p-act-c:#93C5FD;--p-act-bd:rgba(147,197,253,.3);--p-flash:#3B82F6}.rfn-popover[data-color="amber"]{--p-bd:rgba(245,158,11,.25);--p-idle:rgba(120,53,15,.55);--p-idle-bd:rgba(251,191,36,.35);--p-idle-l:rgba(254,243,199,.85);--p-idle-bd-l:rgba(245,158,11,.3);--p-hd:#3A1F00;--p-hd-bd:rgba(245,158,11,.2);--p-hd-l:#FFFBEB;--p-tt:#FCD34D;--p-tt-l:#92400E;--p-act:#78350F;--p-act-c:#FCD34D;--p-act-bd:rgba(251,191,36,.3);--p-flash:#F59E0B}.rfn-popover[data-color="rose"]{--p-bd:rgba(244,63,94,.25);--p-idle:rgba(159,18,57,.45);--p-idle-bd:rgba(253,164,175,.35);--p-idle-l:rgba(255,228,230,.85);--p-idle-bd-l:rgba(244,63,94,.3);--p-hd:#3F0A17;--p-hd-bd:rgba(244,63,94,.2);--p-hd-l:#FFF1F2;--p-tt:#FDA4AF;--p-tt-l:#BE123C;--p-act:#881337;--p-act-c:#FDA4AF;--p-act-bd:rgba(253,164,175,.3);--p-flash:#F43F5E}.rfn-popover[data-color="violet"]{--p-bd:rgba(139,92,246,.25);--p-idle:rgba(76,29,149,.5);--p-idle-bd:rgba(196,181,253,.35);--p-idle-l:rgba(237,233,254,.85);--p-idle-bd-l:rgba(139,92,246,.3);--p-hd:#221040;--p-hd-bd:rgba(139,92,246,.2);--p-hd-l:#F5F3FF;--p-tt:#C4B5FD;--p-tt-l:#6D28D9;--p-act:#4C1D95;--p-act-c:#C4B5FD;--p-act-bd:rgba(196,181,253,.3);--p-flash:#8B5CF6}.rfn-popover[data-color="cyan"]{--p-bd:rgba(6,182,212,.25);--p-idle:rgba(21,94,117,.5);--p-idle-bd:rgba(103,232,249,.35);--p-idle-l:rgba(207,250,254,.85);--p-idle-bd-l:rgba(6,182,212,.3);--p-hd:#083344;--p-hd-bd:rgba(6,182,212,.2);--p-hd-l:#ECFEFF;--p-tt:#67E8F9;--p-tt-l:#0E7490;--p-act:#164E63;--p-act-c:#67E8F9;--p-act-bd:rgba(103,232,249,.3);--p-flash:#06B6D4}.rfn-popover[data-color="orange"]{--p-bd:rgba(249,115,22,.25);--p-idle:rgba(154,52,18,.5);--p-idle-bd:rgba(253,186,116,.35);--p-idle-l:rgba(255,237,213,.85);--p-idle-bd-l:rgba(249,115,22,.3);--p-hd:#3B1400;--p-hd-bd:rgba(249,115,22,.2);--p-hd-l:#FFF7ED;--p-tt:#FDBA74;--p-tt-l:#C2410C;--p-act:#7C2D12;--p-act-c:#FDBA74;--p-act-bd:rgba(253,186,116,.3);--p-flash:#F97316}.rfn-popover[data-color="lime"]{--p-bd:rgba(132,204,22,.25);--p-idle:rgba(63,98,18,.5);--p-idle-bd:rgba(190,242,100,.35);--p-idle-l:rgba(236,252,203,.85);--p-idle-bd-l:rgba(132,204,22,.3);--p-hd:#1A2E05;--p-hd-bd:rgba(132,204,22,.2);--p-hd-l:#F7FEE7;--p-tt:#BEF264;--p-tt-l:#4D7C0F;--p-act:#365314;--p-act-c:#BEF264;--p-act-bd:rgba(190,242,100,.3);--p-flash:#84CC16}.rfn-palette{position:absolute;top:40px;left:10px;z-index:6;display:none;flex-wrap:wrap;gap:7px;max-width:210px;background:#0E182A;border:1px solid #22375A;border-radius:10px;padding:9px;box-shadow:0 12px 34px rgba(0,0,0,.5)}:host([data-theme="light"]) .rfn-palette{background:#FFF;border-color:#E2E8F0}.rfn-popover.rfn-pal-open .rfn-palette{display:flex}.rfn-swatch{width:19px;height:19px;border-radius:50%;border:2px solid rgba(255,255,255,.25);cursor:pointer;padding:0;transition:transform .12s}.rfn-swatch:hover{transform:scale(1.18)}.rfn-swatch.on{border-color:#fff;box-shadow:0 0 0 2px rgba(255,255,255,.35)}:host([data-theme="light"]) .rfn-swatch{border-color:rgba(0,0,0,.2)}*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}.rfn-popover{position:fixed;top:60px;right:14px;width:320px;max-height:560px;background:#0E182A;color:#E8EEF7;border:1px solid var(--p-bd);border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.55);display:flex;flex-direction:column;overflow:hidden;font-family:Menlo,monospace;font-size:13px;opacity:0;transform:translateY(-6px) scale(.98);pointer-events:none;transition:.15s;resize:both;min-width:280px;min-height:220px}.rfn-popover.rfn-show{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}.rfn-popover.rfn-idle{opacity:0.35;background:var(--p-idle);backdrop-filter:blur(2px);border-color:var(--p-idle-bd)}:host([data-theme="light"]) .rfn-popover.rfn-idle{background:var(--p-idle-l);border-color:var(--p-idle-bd-l)}:host([data-theme="light"]) .rfn-popover{background:#F8FAFC;color:#1E293B;border-color:#E2E8F0}.rfn-popover.rfn-min{min-height:0;height:auto;resize:none;width:320px!important}.rfn-popover.rfn-pal-open{overflow:visible}.rfn-popover.rfn-min .rfn-editor,.rfn-popover.rfn-min .rfn-status{display:none}.rfn-hd{display:flex;align-items:center;gap:6px;padding:7px 10px;cursor:move;background:var(--p-hd);border-bottom:1px solid var(--p-hd-bd)}:host([data-theme="light"]) .rfn-hd{background:var(--p-hd-l);border-bottom:1px solid var(--p-hd-bd)}.rfn-title{font-size:11px;font-weight:700;flex:1;display:flex;gap:5px;font-family:-apple-system,sans-serif;color:var(--p-tt);white-space:nowrap;overflow:hidden}:host([data-theme="light"]) .rfn-title{color:var(--p-tt-l)}.rfn-actions{display:flex;gap:2px}.rfn-btn{width:24px;height:24px;border-radius:5px;border:none;background:none;color:#A3B0C2;display:grid;place-items:center;cursor:pointer}.rfn-btn:hover{background:rgba(255,255,255,.08)}:host([data-theme="light"]) .rfn-btn:hover{background:rgba(0,0,0,.06)}.rfn-btn.rfn-active{background:var(--p-act);color:var(--p-act-c);border:1px solid var(--p-act-bd)}.rfn-btn.rfn-flash{background:var(--p-flash);color:#fff}.rfn-btn svg{width:13px;height:13px}.rfn-collapse svg{transition:transform .15s}.rfn-popover.rfn-min .rfn-collapse svg{transform:rotate(-90deg)}.rfn-editor{flex:1;overflow-y:auto;min-height:190px;max-height:480px;background:#273953;color:#E8EEF7;font-size:13px;line-height:20px;padding:10px 14px;border:none;outline:none;resize:none;width:100%;white-space:pre-wrap;overflow-wrap:break-word}:host([data-theme="light"]) .rfn-editor{background:#FFF;color:#1E293B}.rfn-status{padding:6px 12px;background:#1A293D;border-top:1px solid #0F1E33;display:flex;font-size:11px;color:#A3B0C2;font-family:-apple-system,sans-serif}:host([data-theme="light"]) .rfn-status{background:#FFF;border-top:1px solid #E2E8F0}.rfn-autosave{margin-left:auto}.rfn-toast{position:absolute;bottom:8px;left:50%;transform:translateX(-50%) translateY(8px);background:#E8EEF7;color:#0E182A;padding:5px 12px;border-radius:6px;font-size:11px;font-weight:600;opacity:0;pointer-events:none;transition:.2s;white-space:nowrap;max-width:90%}.rfn-toast.rfn-show{opacity:1;transform:translateX(-50%) translateY(0)}/*TASK CSS v3.24.2 — radio = ::before pseudo (NOL elemen non-editable di alur teks)*/.rfn-line{position:relative;min-height:20px;line-height:20px}.rfn-line-txt{outline:none}.rfn-line.rfn-task{padding-left:25px}.rfn-line.rfn-task::before{content:'';position:absolute;left:4px;top:3px;width:13px;height:13px;border:2px solid #7C8DA6;border-radius:50%;box-sizing:border-box;transition:transform .12s}.rfn-line.rfn-task:hover::before{transform:scale(1.15)}.rfn-line.rfn-done::before{background:#6EE7B7;border-color:#6EE7B7;box-shadow:inset 0 0 0 2px #273953}:host([data-theme="light"]) .rfn-line.rfn-task::before{border-color:#64748B}:host([data-theme="light"]) .rfn-line.rfn-done::before{background:#10B981;border-color:#10B981;box-shadow:inset 0 0 0 2px #FFF}.rfn-line.rfn-done .rfn-line-txt{text-decoration:line-through;opacity:.55}.rfn-editor.rfn-empty::before{content:attr(data-placeholder);color:#8A99B0;pointer-events:none;display:block;white-space:pre-wrap}:host([data-theme="light"]) .rfn-editor.rfn-empty::before{color:#94A3B8}</style><div class="rfn-popover" role="dialog"><div class="rfn-palette" role="menu"><button class="rfn-swatch" data-c="green" title="Hijau" style="background:#10B981"></button><button class="rfn-swatch" data-c="blue" title="Biru" style="background:#3B82F6"></button><button class="rfn-swatch" data-c="amber" title="Kuning" style="background:#F59E0B"></button><button class="rfn-swatch" data-c="rose" title="Merah Muda" style="background:#F43F5E"></button><button class="rfn-swatch" data-c="violet" title="Ungu" style="background:#8B5CF6"></button><button class="rfn-swatch" data-c="cyan" title="Cyan" style="background:#06B6D4"></button><button class="rfn-swatch" data-c="orange" title="Oranye" style="background:#F97316"></button><button class="rfn-swatch" data-c="lime" title="Hijau Limau" style="background:#84CC16"></button></div><div class="rfn-hd"><div class="rfn-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg> RecallNote</div><div class="rfn-actions"><button class="rfn-btn rfn-collapse" title="Gulung / buka lagi"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="6 9 12 15 18 9"/></svg></button><button class="rfn-btn rfn-color" title="Warna lembar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22a10 10 0 1 1 10-10c0 2.2-1.8 4-4 4h-2.2a1.8 1.8 0 0 0-1.3 3.1c.3.3.5.7.5 1.1 0 .9-.7 1.8-1.8 1.8z"/><circle cx="7.5" cy="11.5" r="1" fill="currentColor"/><circle cx="10.5" cy="7.5" r="1" fill="currentColor"/><circle cx="15" cy="8" r="1" fill="currentColor"/></svg></button><button class="rfn-btn rfn-pin rfn-active" title="Pin (terpin — klik untuk lepas)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 17v5"/><path d="M9 10.5V4h6v6.5l2 3.5H7l2-3.5z"/></svg></button><button class="rfn-btn rfn-new" title="Lembar baru (RecallNote baru)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button><button class="rfn-btn rfn-print" title="Cetak"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg></button><button class="rfn-btn rfn-copy" title="Salin"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button><button class="rfn-btn rfn-clear" title="Kosongkan"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button><button class="rfn-btn rfn-close" title="Tutup lembar ini"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div></div><div class="rfn-editor" contenteditable="true" spellcheck="false" role="textbox" aria-multiline="true" data-placeholder="Catatan mengambang — ketik bebas, autosave otomatis.&#10;Ketik > di awal baris = subtask (radio) · klik radio = selesai (coret &amp; turun)"></div><div class="rfn-status"><span class="rfn-autosave">✓ Tersimpan otomatis</span></div><div class="rfn-toast"></div></div>`;
})();