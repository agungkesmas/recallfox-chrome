// sidebar/sidebar.js — Sidebar entry point
// The sidebar shares the exact same UI logic as the popup (task-based redesign).
// popup.js auto-runs init() on import. The body class `rf-sidebar-body`
// (set in sidebar.html) tells popup.js to NOT auto-close after inject,
// so the sidebar stays open while the user keeps working.

import '../popup/popup.js';

// Hover transparan untuk host — kirim ke parent (sidebar-cs.js) agar host opacity 0.35/1.0
try {
  document.addEventListener('mouseenter', ()=>{ try{ window.parent.postMessage({type:'RF_SIDEBAR_HOVER_ENTER'}, '*'); }catch(e){} });
  document.addEventListener('mouseleave', ()=>{ try{ window.parent.postMessage({type:'RF_SIDEBAR_HOVER_LEAVE'}, '*'); }catch(e){} });
} catch(e){}
