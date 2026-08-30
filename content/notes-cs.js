// content/notes-cs.js — RecallNote floating note (MULTI-INSTANCE, v3.23.0)
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

  function newData(extra){
    return Object.assign({
      id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      text: '', open: true, collapsed: false,
      x: null, y: null, w: null, h: null,
      vaultNoteId: null, createdAt: Date.now()
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

    function applyGeometry(){
      try{
        if (typeof data.w === 'number' && data.w > 0) popover.style.width = data.w + 'px';
        if (!data.collapsed && typeof data.h === 'number' && data.h > 0) popover.style.height = data.h + 'px';
        if (typeof data.x === 'number' && typeof data.y === 'number') { popover.style.left = data.x + 'px'; popover.style.top = data.y + 'px'; popover.style.right = 'auto'; }
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
        if (typeof d.w === 'number') data.w = d.w;
        if (typeof d.h === 'number') data.h = d.h;
        if (typeof d.x === 'number') data.x = d.x;
        if (typeof d.y === 'number') data.y = d.y;
        const colChanged = (!!d.collapsed !== !!data.collapsed);
        if (typeof d.collapsed === 'boolean') data.collapsed = d.collapsed;
        if (colChanged) applyGeometry();
      }catch(e){}
    }
    async function show(){
      try{ const theme = await loadTheme(); shadow.host.setAttribute('data-theme', theme); }catch(e){}
      try{ host.style.display = ''; }catch(e){}
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
    function destroy(){ try{ host.remove(); }catch(e){} }
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
      document.addEventListener('mouseup',()=>{ if(d){ d=false; popover.style.transition=''; if(moved){ try{ data.x=parseInt(popover.style.left,10)||0; data.y=parseInt(popover.style.top,10)||0; patchLocal(data.id,{x:data.x,y:data.y}); }catch(e){} } }});
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

    const ctrl = { id: data.id, show, hideDom, closeLocal, destroy, setCollapsed, setPos, setTheme, append, applyFrom, applyTextForce, focusSoon, get isVisible(){ return st.isVisible; } };
    return ctrl;
  }

  // ===== Auto-arrange (auto merapihkan diri) =====
  // Instance TANPA posisi pilihan user (x/y null) ditata bertumpuk rapi dari
  // tepi kanan; kalau melebihi tinggi layar, wrap ke kolom baru. Instance yang
  // pernah digeser user (x/y tersimpan) tidak diganggu gugat.
  function tidy(){
    try{
      getList().then(list=>{
        let x=null, y=60;
        for (const d of list){
          if (!d.open) continue;
          const c = ctrls.get(d.id); if (!c) continue;
          const W = Math.max(260, (typeof d.w==='number'&&d.w) || 300);
          const H = d.collapsed ? 44 : Math.max(120, (typeof d.h==='number'&&d.h) || 300);
          if (x === null) x = window.innerWidth - W - 14;
          if (y + H > window.innerHeight - 8) { x = x - (W + 12); y = 60; if (x < 8) x = 8; }
          if (typeof d.x !== 'number' || typeof d.y !== 'number') c.setPos(x, y);
          y += H + 10;
        }
      });
    }catch(e){}
  }

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
  const TEMPLATE=`<style>:host{all:initial}*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}.rfn-popover{position:fixed;top:60px;right:14px;width:300px;max-height:560px;background:#0E182A;color:#E8EEF7;border:1px solid rgba(16,185,129,0.25);border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.55);display:flex;flex-direction:column;overflow:hidden;font-family:Menlo,monospace;font-size:13px;opacity:0;transform:translateY(-6px) scale(.98);pointer-events:none;transition:.15s;resize:both;min-width:280px;min-height:220px}.rfn-popover.rfn-show{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}.rfn-popover.rfn-idle{opacity:0.35;background:rgba(19,78,74,0.55);backdrop-filter:blur(2px);border-color:rgba(110,231,183,0.35)}:host([data-theme="light"]) .rfn-popover.rfn-idle{background:rgba(204,251,241,0.85);border-color:rgba(16,185,129,0.3)}:host([data-theme="light"]) .rfn-popover{background:#F8FAFC;color:#1E293B;border-color:#E2E8F0}.rfn-popover.rfn-min{min-height:0;height:auto;resize:none}.rfn-popover.rfn-min .rfn-editor,.rfn-popover.rfn-min .rfn-status{display:none}.rfn-hd{display:flex;align-items:center;gap:6px;padding:7px 10px;cursor:move;background:#0F2E2A;border-bottom:1px solid rgba(16,185,129,0.2)}:host([data-theme="light"]) .rfn-hd{background:#ECFDF5;border-bottom:1px solid rgba(16,185,129,0.2)}.rfn-title{font-size:11px;font-weight:700;flex:1;display:flex;gap:5px;font-family:-apple-system,sans-serif;color:#6EE7B7;white-space:nowrap;overflow:hidden}:host([data-theme="light"]) .rfn-title{color:#047857}.rfn-actions{display:flex;gap:2px}.rfn-btn{width:24px;height:24px;border-radius:5px;border:none;background:none;color:#A3B0C2;display:grid;place-items:center;cursor:pointer}.rfn-btn:hover{background:rgba(255,255,255,.08)}:host([data-theme="light"]) .rfn-btn:hover{background:rgba(0,0,0,.06)}.rfn-btn.rfn-active{background:#134E4A;color:#6EE7B7;border:1px solid rgba(110,231,183,0.3)}.rfn-btn.rfn-flash{background:#10B981;color:#fff}.rfn-btn svg{width:13px;height:13px}.rfn-collapse svg{transition:transform .15s}.rfn-popover.rfn-min .rfn-collapse svg{transform:rotate(-90deg)}.rfn-editor{flex:1;overflow-y:auto;min-height:190px;max-height:480px;background:#273953;color:#E8EEF7;font-size:13px;line-height:20px;padding:10px 14px;border:none;outline:none;resize:none;width:100%;white-space:pre-wrap;overflow-wrap:break-word}:host([data-theme="light"]) .rfn-editor{background:#FFF;color:#1E293B}.rfn-status{padding:6px 12px;background:#1A293D;border-top:1px solid #0F1E33;display:flex;font-size:11px;color:#A3B0C2;font-family:-apple-system,sans-serif}:host([data-theme="light"]) .rfn-status{background:#FFF;border-top:1px solid #E2E8F0}.rfn-autosave{margin-left:auto}.rfn-toast{position:absolute;bottom:8px;left:50%;transform:translateX(-50%) translateY(8px);background:#E8EEF7;color:#0E182A;padding:5px 12px;border-radius:6px;font-size:11px;font-weight:600;opacity:0;pointer-events:none;transition:.2s;white-space:nowrap;max-width:90%}.rfn-toast.rfn-show{opacity:1;transform:translateX(-50%) translateY(0)}</style><div class="rfn-popover" role="dialog"><div class="rfn-hd"><div class="rfn-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg> RecallNote</div><div class="rfn-actions"><button class="rfn-btn rfn-collapse" title="Gulung / buka lagi"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="6 9 12 15 18 9"/></svg></button><button class="rfn-btn rfn-pin" title="Pin"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 17v5"/><path d="M9 10.5V4h6v6.5l2 3.5H7l2-3.5z"/></svg></button><button class="rfn-btn rfn-new" title="Lembar baru (RecallNote baru)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button><button class="rfn-btn rfn-print" title="Cetak"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg></button><button class="rfn-btn rfn-copy" title="Salin"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button><button class="rfn-btn rfn-clear" title="Kosongkan"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button><button class="rfn-btn rfn-close" title="Tutup lembar ini"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div></div><textarea class="rfn-editor" spellcheck="false" placeholder="Catatan mengambang — ketik bebas, autosave otomatis.&#10;&#10;＋ = lembar baru · ▾ = gulung · ✕ = tutup"></textarea><div class="rfn-status"><span class="rfn-autosave">✓ Tersimpan otomatis</span></div><div class="rfn-toast"></div></div>`;
})();