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
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = TEMPLATE;
    const popover = shadow.querySelector('.rfn-popover');
    const textarea = shadow.querySelector('.rfn-editor');
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
  const TEMPLATE=`<style>:host{all:initial}.rfn-popover{--p-bd:rgba(16,185,129,.25);--p-idle:rgba(19,78,74,.55);--p-idle-bd:rgba(110,231,183,.35);--p-idle-l:rgba(204,251,241,.85);--p-idle-bd-l:rgba(16,185,129,.3);--p-hd:#0F2E2A;--p-hd-bd:rgba(16,185,129,.2);--p-hd-l:#ECFDF5;--p-tt:#6EE7B7;--p-tt-l:#047857;--p-act:#134E4A;--p-act-c:#6EE7B7;--p-act-bd:rgba(110,231,183,.3);--p-flash:#10B981}.rfn-popover[data-color="blue"]{--p-bd:rgba(59,130,246,.25);--p-idle:rgba(30,58,138,.5);--p-idle-bd:rgba(147,197,253,.35);--p-idle-l:rgba(219,234,254,.85);--p-idle-bd-l:rgba(59,130,246,.3);--p-hd:#0F2440;--p-hd-bd:rgba(59,130,246,.2);--p-hd-l:#EFF6FF;--p-tt:#93C5FD;--p-tt-l:#1D4ED8;--p-act:#1E3A8A;--p-act-c:#93C5FD;--p-act-bd:rgba(147,197,253,.3);--p-flash:#3B82F6}.rfn-popover[data-color="amber"]{--p-bd:rgba(245,158,11,.25);--p-idle:rgba(120,53,15,.55);--p-idle-bd:rgba(251,191,36,.35);--p-idle-l:rgba(254,243,199,.85);--p-idle-bd-l:rgba(245,158,11,.3);--p-hd:#3A1F00;--p-hd-bd:rgba(245,158,11,.2);--p-hd-l:#FFFBEB;--p-tt:#FCD34D;--p-tt-l:#92400E;--p-act:#78350F;--p-act-c:#FCD34D;--p-act-bd:rgba(251,191,36,.3);--p-flash:#F59E0B}.rfn-popover[data-color="rose"]{--p-bd:rgba(244,63,94,.25);--p-idle:rgba(159,18,57,.45);--p-idle-bd:rgba(253,164,175,.35);--p-idle-l:rgba(255,228,230,.85);--p-idle-bd-l:rgba(244,63,94,.3);--p-hd:#3F0A17;--p-hd-bd:rgba(244,63,94,.2);--p-hd-l:#FFF1F2;--p-tt:#FDA4AF;--p-tt-l:#BE123C;--p-act:#881337;--p-act-c:#FDA4AF;--p-act-bd:rgba(253,164,175,.3);--p-flash:#F43F5E}.rfn-popover[data-color="violet"]{--p-bd:rgba(139,92,246,.25);--p-idle:rgba(76,29,149,.5);--p-idle-bd:rgba(196,181,253,.35);--p-idle-l:rgba(237,233,254,.85);--p-idle-bd-l:rgba(139,92,246,.3);--p-hd:#221040;--p-hd-bd:rgba(139,92,246,.2);--p-hd-l:#F5F3FF;--p-tt:#C4B5FD;--p-tt-l:#6D28D9;--p-act:#4C1D95;--p-act-c:#C4B5FD;--p-act-bd:rgba(196,181,253,.3);--p-flash:#8B5CF6}.rfn-popover[data-color="cyan"]{--p-bd:rgba(6,182,212,.25);--p-idle:rgba(21,94,117,.5);--p-idle-bd:rgba(103,232,249,.35);--p-idle-l:rgba(207,250,254,.85);--p-idle-bd-l:rgba(6,182,212,.3);--p-hd:#083344;--p-hd-bd:rgba(6,182,212,.2);--p-hd-l:#ECFEFF;--p-tt:#67E8F9;--p-tt-l:#0E7490;--p-act:#164E63;--p-act-c:#67E8F9;--p-act-bd:rgba(103,232,249,.3);--p-flash:#06B6D4}.rfn-popover[data-color="orange"]{--p-bd:rgba(249,115,22,.25);--p-idle:rgba(154,52,18,.5);--p-idle-bd:rgba(253,186,116,.35);--p-idle-l:rgba(255,237,213,.85);--p-idle-bd-l:rgba(249,115,22,.3);--p-hd:#3B1400;--p-hd-bd:rgba(249,115,22,.2);--p-hd-l:#FFF7ED;--p-tt:#FDBA74;--p-tt-l:#C2410C;--p-act:#7C2D12;--p-act-c:#FDBA74;--p-act-bd:rgba(253,186,116,.3);--p-flash:#F97316}.rfn-popover[data-color="lime"]{--p-bd:rgba(132,204,22,.25);--p-idle:rgba(63,98,18,.5);--p-idle-bd:rgba(190,242,100,.35);--p-idle-l:rgba(236,252,203,.85);--p-idle-bd-l:rgba(132,204,22,.3);--p-hd:#1A2E05;--p-hd-bd:rgba(132,204,22,.2);--p-hd-l:#F7FEE7;--p-tt:#BEF264;--p-tt-l:#4D7C0F;--p-act:#365314;--p-act-c:#BEF264;--p-act-bd:rgba(190,242,100,.3);--p-flash:#84CC16}.rfn-palette{position:absolute;top:40px;left:10px;z-index:6;display:none;flex-wrap:wrap;gap:7px;max-width:210px;background:#0E182A;border:1px solid #22375A;border-radius:10px;padding:9px;box-shadow:0 12px 34px rgba(0,0,0,.5)}:host([data-theme="light"]) .rfn-palette{background:#FFF;border-color:#E2E8F0}.rfn-popover.rfn-pal-open .rfn-palette{display:flex}.rfn-swatch{width:19px;height:19px;border-radius:50%;border:2px solid rgba(255,255,255,.25);cursor:pointer;padding:0;transition:transform .12s}.rfn-swatch:hover{transform:scale(1.18)}.rfn-swatch.on{border-color:#fff;box-shadow:0 0 0 2px rgba(255,255,255,.35)}:host([data-theme="light"]) .rfn-swatch{border-color:rgba(0,0,0,.2)}*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}.rfn-popover{position:fixed;top:60px;right:14px;width:320px;max-height:560px;background:#0E182A;color:#E8EEF7;border:1px solid var(--p-bd);border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.55);display:flex;flex-direction:column;overflow:hidden;font-family:Menlo,monospace;font-size:13px;opacity:0;transform:translateY(-6px) scale(.98);pointer-events:none;transition:.15s;resize:both;min-width:280px;min-height:220px}.rfn-popover.rfn-show{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}.rfn-popover.rfn-idle{opacity:0.35;background:var(--p-idle);backdrop-filter:blur(2px);border-color:var(--p-idle-bd)}:host([data-theme="light"]) .rfn-popover.rfn-idle{background:var(--p-idle-l);border-color:var(--p-idle-bd-l)}:host([data-theme="light"]) .rfn-popover{background:#F8FAFC;color:#1E293B;border-color:#E2E8F0}.rfn-popover.rfn-min{min-height:0;height:auto;resize:none;width:320px!important}.rfn-popover.rfn-pal-open{overflow:visible}.rfn-popover.rfn-min .rfn-editor,.rfn-popover.rfn-min .rfn-status{display:none}.rfn-hd{display:flex;align-items:center;gap:6px;padding:7px 10px;cursor:move;background:var(--p-hd);border-bottom:1px solid var(--p-hd-bd)}:host([data-theme="light"]) .rfn-hd{background:var(--p-hd-l);border-bottom:1px solid var(--p-hd-bd)}.rfn-title{font-size:11px;font-weight:700;flex:1;display:flex;gap:5px;font-family:-apple-system,sans-serif;color:var(--p-tt);white-space:nowrap;overflow:hidden}:host([data-theme="light"]) .rfn-title{color:var(--p-tt-l)}.rfn-actions{display:flex;gap:2px}.rfn-btn{width:24px;height:24px;border-radius:5px;border:none;background:none;color:#A3B0C2;display:grid;place-items:center;cursor:pointer}.rfn-btn:hover{background:rgba(255,255,255,.08)}:host([data-theme="light"]) .rfn-btn:hover{background:rgba(0,0,0,.06)}.rfn-btn.rfn-active{background:var(--p-act);color:var(--p-act-c);border:1px solid var(--p-act-bd)}.rfn-btn.rfn-flash{background:var(--p-flash);color:#fff}.rfn-btn svg{width:13px;height:13px}.rfn-collapse svg{transition:transform .15s}.rfn-popover.rfn-min .rfn-collapse svg{transform:rotate(-90deg)}.rfn-editor{flex:1;overflow-y:auto;min-height:190px;max-height:480px;background:#273953;color:#E8EEF7;font-size:13px;line-height:20px;padding:10px 14px;border:none;outline:none;resize:none;width:100%;white-space:pre-wrap;overflow-wrap:break-word}:host([data-theme="light"]) .rfn-editor{background:#FFF;color:#1E293B}.rfn-status{padding:6px 12px;background:#1A293D;border-top:1px solid #0F1E33;display:flex;font-size:11px;color:#A3B0C2;font-family:-apple-system,sans-serif}:host([data-theme="light"]) .rfn-status{background:#FFF;border-top:1px solid #E2E8F0}.rfn-autosave{margin-left:auto}.rfn-toast{position:absolute;bottom:8px;left:50%;transform:translateX(-50%) translateY(8px);background:#E8EEF7;color:#0E182A;padding:5px 12px;border-radius:6px;font-size:11px;font-weight:600;opacity:0;pointer-events:none;transition:.2s;white-space:nowrap;max-width:90%}.rfn-toast.rfn-show{opacity:1;transform:translateX(-50%) translateY(0)}</style><div class="rfn-popover" role="dialog"><div class="rfn-palette" role="menu"><button class="rfn-swatch" data-c="green" title="Hijau" style="background:#10B981"></button><button class="rfn-swatch" data-c="blue" title="Biru" style="background:#3B82F6"></button><button class="rfn-swatch" data-c="amber" title="Kuning" style="background:#F59E0B"></button><button class="rfn-swatch" data-c="rose" title="Merah Muda" style="background:#F43F5E"></button><button class="rfn-swatch" data-c="violet" title="Ungu" style="background:#8B5CF6"></button><button class="rfn-swatch" data-c="cyan" title="Cyan" style="background:#06B6D4"></button><button class="rfn-swatch" data-c="orange" title="Oranye" style="background:#F97316"></button><button class="rfn-swatch" data-c="lime" title="Hijau Limau" style="background:#84CC16"></button></div><div class="rfn-hd"><div class="rfn-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg> RecallNote</div><div class="rfn-actions"><button class="rfn-btn rfn-collapse" title="Gulung / buka lagi"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="6 9 12 15 18 9"/></svg></button><button class="rfn-btn rfn-color" title="Warna lembar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22a10 10 0 1 1 10-10c0 2.2-1.8 4-4 4h-2.2a1.8 1.8 0 0 0-1.3 3.1c.3.3.5.7.5 1.1 0 .9-.7 1.8-1.8 1.8z"/><circle cx="7.5" cy="11.5" r="1" fill="currentColor"/><circle cx="10.5" cy="7.5" r="1" fill="currentColor"/><circle cx="15" cy="8" r="1" fill="currentColor"/></svg></button><button class="rfn-btn rfn-pin rfn-active" title="Pin (terpin — klik untuk lepas)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 17v5"/><path d="M9 10.5V4h6v6.5l2 3.5H7l2-3.5z"/></svg></button><button class="rfn-btn rfn-new" title="Lembar baru (RecallNote baru)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button><button class="rfn-btn rfn-print" title="Cetak"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg></button><button class="rfn-btn rfn-copy" title="Salin"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button><button class="rfn-btn rfn-clear" title="Kosongkan"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button><button class="rfn-btn rfn-close" title="Tutup lembar ini"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div></div><textarea class="rfn-editor" spellcheck="false" placeholder="Catatan mengambang — ketik bebas, autosave otomatis.&#10;&#10;＋ = lembar baru · ▾ = gulung · ✕ = tutup"></textarea><div class="rfn-status"><span class="rfn-autosave">✓ Tersimpan otomatis</span></div><div class="rfn-toast"></div></div>`;
})();