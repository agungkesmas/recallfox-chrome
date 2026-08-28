// content/notes-cs.js — RecallNote floating note (safe clone)
(async function () {
  if (window.__recallfoxNotesLoaded) return;
  window.__recallfoxNotesLoaded = true;
  let notesLib;
  try { notesLib = await import(browser.runtime.getURL('lib/notes.js')); } catch (e) { console.warn('[RecallFox/Notes] Failed', e); return; }
  const { loadSession, saveSession, savePinState } = notesLib;
  let floatSync=null;
  try{ floatSync = await import(browser.runtime.getURL('lib/float-sync.js')); }catch(e){}
  let host=null,shadow=null,popover=null,textarea=null,statusAutosave=null,pinBtn=null,isVisible=false,pinned=true,saveTimer=null,idleTimer=null,vaultNoteId=null;
  async function loadTheme(){ try{ const r=await browser.storage.local.get(['settings']); let s=r.settings||{}; let t=s.theme||'auto'; if(t==='auto') t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'; return t;}catch(e){return 'dark';}}
  function mount(){ if(host) return; host=document.createElement('div'); host.id='recallfox-notes-host'; host.style.cssText='all:initial;position:fixed;top:0;right:0;width:0;height:0;z-index:2147483647;pointer-events:none;'; document.documentElement.appendChild(host); shadow=host.attachShadow({mode:'open'}); shadow.innerHTML=TEMPLATE; popover=shadow.querySelector('.rfn-popover'); textarea=shadow.querySelector('.rfn-editor'); statusAutosave=shadow.querySelector('.rfn-autosave'); pinBtn=shadow.querySelector('.rfn-pin'); wireEvents(); }
  function setActive(){ try{ if(popover) popover.classList.remove('rfn-idle'); }catch(e){} }
  function setIdle(){ try{ if(!isVisible) return; // hover-only: pinned tetap bisa transparan, hanya hover yang bedakan
    if(popover) popover.classList.add('rfn-idle'); }catch(e){} }
  function scheduleIdle(){ try{ if(!isVisible) return; setIdle(); }catch(e){} }
  async function show(){ mount(); const theme=await loadTheme(); shadow.host.setAttribute('data-theme', theme); popover.classList.add('rfn-show'); isVisible=true;
    // default nempel: pinned true, pinBtn active
    pinned = true; if(pinBtn) pinBtn.classList.add('rfn-active'); try{ await savePinState(true); }catch(e){}
    // load: jika vaultNoteId ada, sudah diisi via message; else load session
    if(!vaultNoteId){
      const s=await loadSession(); if(s.text) textarea.value=s.text;
      // respect stored pinned if any, but default tetap nempel
      if(s.pinned===false){ pinned=false; if(pinBtn) pinBtn.classList.remove('rfn-active'); }
    }
    // awal transparan (hover-only) — akan opaque saat hover/focus
    try{ popover.classList.add('rfn-idle'); }catch(e){}
    setTimeout(()=>{ textarea.focus(); },50);
    // cross-tab sync: save isOpen
    try{ if(floatSync) await floatSync.saveFloatState('note', {isOpen:true, text: textarea.value, vaultNoteId}); }catch(e){}
  }
  function hide(){ if(popover) { popover.classList.remove('rfn-show'); popover.classList.remove('rfn-idle'); } isVisible=false; if(idleTimer) clearTimeout(idleTimer);
    try{ if(floatSync) floatSync.saveFloatState('note', {isOpen:false}); }catch(e){} }
  function updateStatus(){ if(statusAutosave){ const len=textarea.value.length; const words=textarea.value.trim()?textarea.value.trim().split(/\s+/).length:0; statusAutosave.textContent=len?`✓ Tersimpan otomatis · ${words} kata`:'✓ Tersimpan otomatis';}}
  function scheduleSave(){ if(saveTimer) clearTimeout(saveTimer); if(statusAutosave){statusAutosave.textContent='⏳ Menyimpan…'; statusAutosave.style.color='#F0B64A';} saveTimer=setTimeout(async()=>{
    try{
      if(vaultNoteId){
        await browser.runtime.sendMessage({type:'UPDATE_VAULT_NOTE', noteId: vaultNoteId, text: textarea.value});
      } else {
        await saveSession(textarea.value);
      }
      // cross-tab sync: keep float state text updated
      try{ if(floatSync && isVisible) await floatSync.saveFloatState('note', {isOpen:true, text: textarea.value, vaultNoteId}); }catch(e){}
    }catch(e){}
    updateStatus(); if(statusAutosave) statusAutosave.style.color='';
  },500);}
  async function doCopy(){ const t=textarea.value; if(!t.trim()){toast('Catatan kosong');return;} try{await navigator.clipboard.writeText(t); flashBtn('.rfn-copy'); toast('📋 Tersalin');}catch(e){ const ta=document.createElement('textarea'); ta.value=t; document.body.appendChild(ta); ta.select(); try{document.execCommand('copy'); flashBtn('.rfn-copy'); toast('📋 Tersalin');}catch(e2){} ta.remove();}}
  function doPrint(){ const t=textarea.value; if(!t.trim()){toast('Catatan kosong');return;} const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); const html='<!DOCTYPE html><html><head><meta charset="utf-8"><title>RecallNote</title><style>@page{size:80mm auto;margin:2mm}*{box-sizing:border-box;margin:0;padding:0}html,body{background:#fff;color:#000;font-family:Menlo,monospace;font-size:10px;line-height:1.6}body{padding:4mm;max-width:72mm;margin:0 auto;white-space:pre-wrap}</style></head><body><div style="text-align:center;border-bottom:1px dashed #000;padding-bottom:3mm;margin-bottom:3mm"><h1>📝 RecallNote</h1><div style="font-size:9px;color:#666">'+new Date().toLocaleString('id-ID')+'</div></div><div>'+esc(t)+'</div></body></html>'; const iframe=document.createElement('iframe'); iframe.style.cssText='position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0'; document.body.appendChild(iframe); try{ const doc=iframe.contentWindow.document; doc.open(); doc.write(html); doc.close();}catch(e){toast('Gagal cetak'); iframe.remove(); return;} setTimeout(()=>{try{iframe.contentWindow.focus(); iframe.contentWindow.print();}catch(e){} setTimeout(()=>{try{iframe.remove()}catch(e){}},2000);},300); flashBtn('.rfn-print');}
  async function doSave(){ const t=textarea.value; if(!t.trim()){toast('Catatan kosong');return;} try{ await browser.runtime.sendMessage({type:'SAVE_NOTE_TO_VAULT', text:t, markdown:t}); toast('✓ Tersimpan ke Catatan'); flashBtn('.rfn-save');}catch(e){toast('Gagal simpan: '+(e.message||e));}}
  function doClear(){ if(!textarea.value.trim()) return; if(!confirm('Kosongkan catatan?')) return; textarea.value=''; updateStatus(); scheduleSave(); textarea.focus(); flashBtn('.rfn-clear');}
  function flashBtn(s){ const b=shadow.querySelector(s); if(!b) return; b.classList.add('rfn-flash'); setTimeout(()=>b.classList.remove('rfn-flash'),600);}
  function toast(m){ const t=shadow.querySelector('.rfn-toast'); if(!t) return; t.textContent=m; t.classList.add('rfn-show'); setTimeout(()=>t.classList.remove('rfn-show'),2000);}
  function makeDraggable(){ const hd=shadow.querySelector('.rfn-hd'); let d=false,dx=0,dy=0; hd.addEventListener('mousedown',e=>{if(e.target.closest('button'))return; d=true; const rect=popover.getBoundingClientRect(); dx=e.clientX-rect.left; dy=e.clientY-rect.top; popover.style.transition='none'; e.preventDefault();}); document.addEventListener('mousemove',e=>{if(!d)return; popover.style.left=(e.clientX-dx)+'px'; popover.style.top=(e.clientY-dy)+'px'; popover.style.right='auto';}); document.addEventListener('mouseup',()=>{if(d){d=false; popover.style.transition='';}});}
  function wireEvents(){
    // Safe idle wiring — semua handler wrapped agar tidak crash tombol lain
    try { textarea.addEventListener('input',()=>{ updateStatus(); scheduleSave(); setActive(); }); } catch(e){}
    try { textarea.addEventListener('keydown',e=>{ if(e.key==='Escape'&&!pinned){e.preventDefault(); hide(); return;} try{ setActive(); }catch(ee){} }); } catch(e){}
    try { textarea.addEventListener('focus',()=>{ try{ setActive(); }catch(ee){} }); } catch(e){}
    try { popover.addEventListener('mouseenter',()=>{ try{ setActive(); }catch(ee){} }); } catch(e){}
    try { popover.addEventListener('mouseleave',()=>{ try{ scheduleIdle(); }catch(ee){} }); } catch(e){}
    try { pinBtn.addEventListener('click',async()=>{ pinned=!pinned; pinBtn.classList.toggle('rfn-active',pinned); await savePinState(pinned); }); } catch(e){}
    try { shadow.querySelector('.rfn-print').addEventListener('click',doPrint); } catch(e){}
    try { shadow.querySelector('.rfn-copy').addEventListener('click',doCopy); } catch(e){}
    try { shadow.querySelector('.rfn-clear').addEventListener('click',doClear); } catch(e){}
    try { document.addEventListener('mousedown',e=>{if(!isVisible||pinned)return; const p=e.composedPath?e.composedPath():[e.target]; if(p.includes(host))return; hide();},true); } catch(e){}
    try { browser.runtime.onMessage.addListener(msg=>{if(msg.type==='THEME_CHANGED'&&shadow) shadow.host.setAttribute('data-theme',msg.theme);}); } catch(e){}
    try { makeDraggable(); } catch(e){}
  }
  browser.runtime.onMessage.addListener(msg=>{
    if(msg.type==='OPEN_NOTE_VAULT'){
      vaultNoteId = msg.noteId || null;
      show().then(()=>{ if(typeof msg.text==='string') textarea.value = msg.text; updateStatus(); });
    } else if(msg.type==='OPEN_NOTE'){ vaultNoteId=null; show(); }
    else if(msg.type==='ADD_TO_NOTE'){ vaultNoteId=null; show(); textarea.value+=(textarea.value?'\n':'')+(msg.text||''); updateStatus(); scheduleSave();}
    else if(msg.type==='SHOW_NOTE') show();
    else if(msg.type==='HIDE_NOTE') hide();
    else if(msg.type==='RF_HIDE_FOR_CAPTURE'){ if(host) host.style.display='none'; }
    else if(msg.type==='RF_RESTORE_AFTER_CAPTURE'){ if(host) host.style.display=''; if(isVisible && popover) popover.classList.add('rfn-show'); }
  });
  loadSession().then(s=>{ if(s && typeof s.pinned==='boolean') pinned=s.pinned; });
  // cross-tab auto-show if was open in other tab
  try{
    if(floatSync) floatSync.loadFloatState('note').then(st=>{
      if(st && st.isOpen){
        vaultNoteId = st.vaultNoteId || null;
        show().then(()=>{
          if(typeof st.text==='string' && st.text) { textarea.value = st.text; updateStatus(); }
          if(st.vaultNoteId) vaultNoteId = st.vaultNoteId;
        });
      }
    });
  }catch(e){}
  const TEMPLATE=`<style>:host{all:initial}*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}.rfn-popover{position:fixed;top:60px;right:14px;width:360px;max-height:560px;background:#0E182A;color:#E8EEF7;border:1px solid rgba(16,185,129,0.25);border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.55);display:flex;flex-direction:column;overflow:hidden;font-family:Menlo,monospace;font-size:13px;opacity:0;transform:translateY(-6px) scale(.98);pointer-events:none;transition:.15s;resize:both;min-width:300px;min-height:340px}.rfn-popover.rfn-show{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}.rfn-popover.rfn-idle{opacity:0.35;background:rgba(19,78,74,0.55);backdrop-filter:blur(2px);border-color:rgba(110,231,183,0.35)}:host([data-theme="light"]) .rfn-popover.rfn-idle{background:rgba(204,251,241,0.85);border-color:rgba(16,185,129,0.3)}:host([data-theme="light"]) .rfn-popover{background:#F8FAFC;color:#1E293B;border-color:#E2E8F0}.rfn-hd{display:flex;align-items:center;gap:6px;padding:7px 10px;cursor:move;background:#0F2E2A;border-bottom:1px solid rgba(16,185,129,0.2)}:host([data-theme="light"]) .rfn-hd{background:#ECFDF5;border-bottom:1px solid rgba(16,185,129,0.2)}.rfn-title{font-size:11px;font-weight:700;flex:1;display:flex;gap:5px;font-family:-apple-system,sans-serif;color:#6EE7B7}:host([data-theme="light"]) .rfn-title{color:#047857}.rfn-actions{display:flex;gap:2px}.rfn-btn{width:24px;height:24px;border-radius:5px;border:none;background:none;color:#A3B0C2;display:grid;place-items:center;cursor:pointer}.rfn-btn.rfn-active{background:#134E4A;color:#6EE7B7;border:1px solid rgba(110,231,183,0.3)}.rfn-btn.rfn-flash{background:#10B981;color:#fff}.rfn-btn svg{width:13px;height:13px}.rfn-editor{flex:1;overflow-y:auto;min-height:240px;max-height:480px;background:#273953;color:#E8EEF7;font-size:13px;line-height:20px;padding:10px 14px;border:none;outline:none;resize:none;width:100%;white-space:pre-wrap;overflow-wrap:break-word}:host([data-theme="light"]) .rfn-editor{background:#FFF;color:#1E293B}.rfn-status{padding:6px 12px;background:#1A293D;border-top:1px solid #0F1E33;display:flex;font-size:11px;color:#A3B0C2;font-family:-apple-system,sans-serif}:host([data-theme="light"]) .rfn-status{background:#FFF;border-top:1px solid #E2E8F0}.rfn-autosave{margin-left:auto}.rfn-toast{position:absolute;bottom:8px;left:50%;transform:translateX(-50%) translateY(8px);background:#E8EEF7;color:#0E182A;padding:5px 12px;border-radius:6px;font-size:11px;font-weight:600;opacity:0;pointer-events:none;transition:.2s;white-space:nowrap;max-width:90%}.rfn-toast.rfn-show{opacity:1;transform:translateX(-50%) translateY(0)}</style><div class="rfn-popover" role="dialog"><div class="rfn-hd"><div class="rfn-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg> RecallNote</div><div class="rfn-actions"><button class="rfn-btn rfn-pin" title="Pin"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 17v5"/><path d="M9 10.5V4h6v6.5l2 3.5H7l2-3.5z"/></svg></button><button class="rfn-btn rfn-print" title="Cetak"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg></button><button class="rfn-btn rfn-copy" title="Salin"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button><button class="rfn-btn rfn-clear" title="Kosongkan"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></div></div><textarea class="rfn-editor" spellcheck="false" placeholder="Catatan mengambang — ketik bebas, autosave otomatis.&#10;&#10;Esc = tutup (pin untuk tetap)"></textarea><div class="rfn-status"><span class="rfn-autosave">✓ Tersimpan otomatis</span></div><div class="rfn-toast"></div></div>`;
})();
