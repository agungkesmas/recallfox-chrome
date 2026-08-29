// content/sidebar-cs.js — RecallFox Popout Sidebar (iframe approach)
//
// v3.22.3 — fix klik floater:
// 1. 1x klik rfBtn (🦊) = toggle popout DOM sidebar LANGSUNG (tanpa relay
//    background). Root cause bug: single click dulu kirim RF_OPEN_REAL_SIDEBAR,
//    chrome.sidePanel.open() sering ditolak (butuh user gesture) dan gagal-nya
//    resolve sehingga fallback toggle() tidak pernah jalan → klik terasa mati.
// 2. Native click listener sebagai fallback jalur pointerup (Firefox safety net)
//    + dedupe 400ms supaya tidak eksekusi ganda.
// 3. note/tape: 1 message primer (RF_OPEN_NOTE/TAPE) + fallback berbasis respons.
//
// v3.20.7 (Firefox) — rewrite berdasarkan user feedback:
// 1. "rf" dan "sc" berdampingan sebagai pair container
// 2. Close pakai tombol sidebarInPageBtn di header iframe (postMessage, bukan tabs.sendMessage)
// 3. Auto-close 15s: activity dari iframe juga dihitung (postMessage RF_ACTIVITY)
// 4. Pin button: pindah ke bawah, tidak numpuk
// 5. Default width 280px
// 6. Hide during screenshot

(async function () {
  if (window.__recallfoxSidebarLoaded) return;
  window.__recallfoxSidebarLoaded = true;

  const HOST_ID = 'recallfox-sidebar-host';
  const FLOATER_ID = 'recallfox-sidebar-floater-pair';
  const STORAGE_KEY = 'recallfox_sidebar_in_page_state';
  const FLOATER_POS_KEY = 'recallfox_popout_floater_pos';
  const FLOATER_EDGE = 48;  // v3.21.24: threshold mentok pinggir viewport (kiri/kanan/atas/bawah)
  const DEFAULT_WIDTH = 280;
  const MIN_WIDTH = 280;
  const MAX_WIDTH = 600;
  const AUTO_CLOSE_MS = 15000;
  const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart', 'input', 'wheel'];

  let host = null;
  let iframe = null;
  let resizeHandle = null;
  let floaterPair = null;  // container untuk 4 tombol: rf + sc + note + tape
  let rfBtn = null;
  let scBtn = null;
  let noteBtn = null;
  let tapeBtn = null;
  let pinBtn = null;
  let isVisible = false;
  let currentWidth = DEFAULT_WIDTH;
  let isPinned = false;
  let idleTimer = null;
  let userResized = false;  // v3.20.8: track apakah user pernah resize
  let captureHideTimer = null;  // v3.20.14: fallback restore 5s kalau RF_RESTORE_AFTER_CAPTURE lost

  // ===== Storage =====
  async function loadState() {
    try {
      const r = await browser.storage.local.get([STORAGE_KEY]);
      const s = r[STORAGE_KEY] || {};
      return {
        visible: !!s.visible,
        width: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, s.width || DEFAULT_WIDTH)),
        pinned: s.pinned !== false,
        userResized: !!s.userResized
      };
    } catch (e) { return { visible: false, width: DEFAULT_WIDTH, pinned: true, userResized: false }; }
  }
  async function saveState(state) {
    try { await browser.storage.local.set({ [STORAGE_KEY]: state }); } catch (e) {}
  }

  // ===== Idle timer =====
  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    if (isPinned || !isVisible) return;
    idleTimer = setTimeout(() => {
      console.log('[RecallFox] Popout auto-close after 15s idle');
      hide();
    }, AUTO_CLOSE_MS);
  }
  function onActivity() {
    if (isVisible && !isPinned) resetIdleTimer();
  }
  // Activity di parent page
  ACTIVITY_EVENTS.forEach(ev => document.addEventListener(ev, onActivity, { passive: true, capture: true }));
  // Klik sembarang di luar sidebar/floater langsung hide kalau unpin (jangan tunggu 15s)
  document.addEventListener('mousedown', (e) => {
    try {
      if (!isVisible || isPinned) return;
      const path = e.composedPath ? e.composedPath() : [e.target];
      if (host && path.includes(host)) return;
      if (floaterPair && path.includes(floaterPair)) return;
      // Juga cek iframe host via composedPath, kalau klik di page content (bukan di host) → hide
      hide();
    } catch(err){}
  }, true);

  // ===== Floater position =====
  function loadFloaterPos() {
    try {
      const pos = JSON.parse(localStorage.getItem(FLOATER_POS_KEY) || 'null');
      if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') return pos;
    } catch (e) {}
    return null;
  }
  function saveFloaterPos(x, y, orient) {
    try {
      // v3.21.24: persist orient supaya reload tetap orient terakhir.
      // orient opsional — kalau undefined, baca dari current state floaterPair.
      const o = orient || (floaterPair && floaterPair.dataset.orient) || 'horizontal';
      localStorage.setItem(FLOATER_POS_KEY, JSON.stringify({ x, y, orient: o }));
    } catch (e) {}
  }

  // v3.21.24: computeOrientation — tentukan orientasi berdasarkan posisi floater
  // relatif ke viewport. Dipanggil saat drop (pointerup), bukan live saat drag,
  // supaya tidak berkedip di pojok.
  //
  // Aturan (konfirmasi user):
  // - x < FLOATER_EDGE atau x > vw - FLOATER_EDGE - pw  → vertical (kiri/kanan mentok)
  // - y < FLOATER_EDGE atau y > vh - FLOATER_EDGE - ph  → horizontal (atas/bawah mentok)
  // - Tengah (tidak mentok mana pun) → horizontal (default)
  // - Pojok (kiri/kanan + atas/bawah bareng) → vertikal menang (biar tidak berkedip)
  //
  // Parameter:
  //   x, y — posisi floater (left, top dalam pixel)
  //   vw, vh — viewport width/height
  //   pw, ph — floater width/height (tergantung orient saat ini, approx)
  // Return: 'horizontal' atau 'vertical'
  function computeOrientation(x, y, vw, vh, pw, ph) {
    const edge = FLOATER_EDGE;
    const atLeft   = x < edge;
    const atRight  = x > vw - edge - pw;
    const atTop    = y < edge;
    const atBottom = y > vh - edge - ph;
    const horizontalEdge = atTop || atBottom;  // mentok atas/bawah
    const verticalEdge   = atLeft || atRight;  // mentok kiri/kanan
    // Pojok (kedua sumbu mentok) → vertikal menang
    if (verticalEdge && horizontalEdge) return 'vertical';
    // Hanya kiri/kanan yang mentok → vertikal
    if (verticalEdge) return 'vertical';
    // Hanya atas/bawah yang mentok, ATAU tengah → horizontal (default)
    return 'horizontal';
  }

  // v3.21.24: applyOrientation — set flex-direction + adjust ukuran container.
  // Horizontal: row, lebar 4*36+gap = ~170px, tinggi 36px.
  // Vertical:   column, lebar 36px, tinggi 4*36+gap = ~170px.
  function applyOrientation(orient) {
    if (!floaterPair) return;
    const o = (orient === 'vertical') ? 'vertical' : 'horizontal';
    floaterPair.dataset.orient = o;
    if (o === 'vertical') {
      floaterPair.style.flexDirection = 'column';
    } else {
      floaterPair.style.flexDirection = 'row';
    }
  }

  // ===== Mount host + iframe + resize + pin =====
  function mount() {
    if (host) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = [
      'all:initial', 'position:fixed', 'top:0', 'right:0',
      'height:100vh', 'width:' + currentWidth + 'px',
      'z-index:2147483646', 'pointer-events:none',
      'opacity:0.35', 'transition:opacity .2s ease'
    ].join(';');
    document.documentElement.appendChild(host);
    // Hover transparan — default 0.35, hover 1.0 (pin tetap, tidak auto-hide)
    host.addEventListener('mouseenter', ()=>{ host.style.opacity='1'; });
    host.addEventListener('mouseleave', ()=>{ host.style.opacity='0.35'; });
    // Iframe hover via postMessage dari sidebar.html
    window.addEventListener('message', (e)=>{
      if (e.data?.type==='RF_SIDEBAR_HOVER_ENTER') host.style.opacity='1';
      if (e.data?.type==='RF_SIDEBAR_HOVER_LEAVE') host.style.opacity='0.35';
    });

    // Resize handle
    resizeHandle = document.createElement('div');
    resizeHandle.title = 'Seret untuk ubah lebar';
    resizeHandle.style.cssText = [
      'all:initial', 'position:absolute', 'top:0', 'left:0',
      'width:6px', 'height:100%', 'cursor:ew-resize', 'pointer-events:auto',
      'background:transparent', 'z-index:2', 'transition:background .15s ease'
    ].join(';');
    host.appendChild(resizeHandle);

    // Iframe
    iframe = document.createElement('iframe');
    iframe.setAttribute('title', 'RecallFox Sidebar');
    iframe.src = browser.runtime.getURL('sidebar/sidebar.html');
    iframe.style.cssText = [
      'all:initial', 'position:absolute', 'top:0', 'left:6px',
      'width:calc(100% - 6px)', 'height:100%', 'border:0',
      'background:#ffffff', 'pointer-events:auto',
      'box-shadow:-8px 0 32px rgba(0,0,0,.12)'
    ].join(';');
    host.appendChild(iframe);

    // Pin button — di bawah kiri host, tidak numpuk dengan header iframe
    pinBtn = document.createElement('div');
    pinBtn.id = 'recallfox-popout-pin';
    pinBtn.setAttribute('role', 'button');
    pinBtn.title = isPinned ? 'Lepas pin (auto-close aktif)' : 'Pin (anti auto-close)';
    pinBtn.textContent = isPinned ? '📌' : '📍';
    pinBtn.style.cssText = [
      'all:initial', 'position:absolute', 'bottom:8px', 'left:10px',
      'width:28px', 'height:28px', 'z-index:3', 'cursor:pointer',
      'pointer-events:auto', 'display:grid', 'place-items:center',
      'font-size:16px', 'line-height:1', 'background:rgba(255,255,255,.9)',
      'border-radius:6px', 'user-select:none',
      'font-family:-apple-system,sans-serif',
      'box-shadow:0 2px 6px rgba(0,0,0,.15)'
    ].join(';');
    pinBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      isPinned = !isPinned;
      pinBtn.textContent = isPinned ? '📌' : '📍';
      pinBtn.title = isPinned ? 'Lepas pin (auto-close aktif)' : 'Pin (anti auto-close)';
      if (isPinned) { if (idleTimer) clearTimeout(idleTimer); }
      else resetIdleTimer();
      saveState({ visible: isVisible, width: currentWidth, pinned: isPinned, userResized });
    });
    host.appendChild(pinBtn);

    host.style.display = 'none';
    wireResize();
  }

  // ===== Floating pair: "rf" + "sc" berdampingan, draggable =====
  function mountFloater() {
    if (floaterPair) return;

    // Container untuk 4 tombol: rf + sc + note + tape (pill transparan hover)
    floaterPair = document.createElement('div');
    floaterPair.id = FLOATER_ID;
    floaterPair.style.cssText = [
      'all:initial', 'position:fixed',
      'display:flex', 'gap:4px',
      'z-index:2147483645', 'pointer-events:auto',
      'user-select:none',
      'opacity:0.35', 'transition:opacity .2s ease',
      'padding:4px', 'border-radius:12px',
      'background:rgba(255,255,255,0.55)', 'backdrop-filter:blur(8px)',
      'border:1px solid rgba(109,61,245,0.15)',
      'box-shadow:0 4px 16px rgba(0,0,0,.12)'
    ].join(';');
    floaterPair.addEventListener('mouseenter', ()=>{ floaterPair.style.opacity='1'; });
    floaterPair.addEventListener('mouseleave', ()=>{ floaterPair.style.opacity='0.35'; });

    // "rf" button — toggle popout sidebar
    rfBtn = document.createElement('div');
    rfBtn.setAttribute('role', 'button');
    rfBtn.setAttribute('tabindex', '0');
    rfBtn.innerHTML = '🦊';
    rfBtn.title = '1x klik: buka/tutup popout sidebar';
    rfBtn.style.cssText = [
      'all:initial', 'width:36px', 'height:36px', 'border-radius:8px',
      'background:#6d3df5', 'color:#fff', 'cursor:pointer',
      'display:grid', 'place-items:center',
      'font-size:16px', 'line-height:1',
      'box-shadow:0 2px 8px rgba(109,61,245,.3)',
      'transition:transform .1s ease, opacity .2s ease', 'user-select:none'
    ].join(';');

    // "sc" button — trigger screenshot
    scBtn = document.createElement('div');
    scBtn.setAttribute('role', 'button');
    scBtn.setAttribute('tabindex', '0');
    scBtn.innerHTML = '📸';
    scBtn.title = 'Ambil screenshot';
    scBtn.style.cssText = [
      'all:initial', 'width:36px', 'height:36px', 'border-radius:8px',
      'background:#8a54ff', 'color:#fff', 'cursor:pointer',
      'display:grid', 'place-items:center',
      'font-size:16px', 'line-height:1',
      'box-shadow:0 2px 8px rgba(138,84,255,.3)',
      'transition:transform .1s ease', 'user-select:none'
    ].join(';');

    // "note" button — buka catatan mengambang
    noteBtn = document.createElement('div');
    noteBtn.setAttribute('role', 'button');
    noteBtn.setAttribute('tabindex', '0');
    noteBtn.innerHTML = '📝';
    noteBtn.title = 'Buka Catatan Mengambang';
    noteBtn.style.cssText = [
      'all:initial', 'width:36px', 'height:36px', 'border-radius:8px',
      'background:#0F2E2A', 'color:#6EE7B7', 'border:1px solid rgba(16,185,129,0.25)',
      'cursor:pointer', 'display:grid', 'place-items:center',
      'font-size:16px', 'line-height:1',
      'box-shadow:0 2px 8px rgba(16,185,129,.2)',
      'transition:transform .1s ease', 'user-select:none'
    ].join(';');

    // "tape" button — buka kalkulator pita
    tapeBtn = document.createElement('div');
    tapeBtn.setAttribute('role', 'button');
    tapeBtn.setAttribute('tabindex', '0');
    tapeBtn.innerHTML = '🧾';
    tapeBtn.title = 'Buka Kalkulator Pita';
    tapeBtn.style.cssText = [
      'all:initial', 'width:36px', 'height:36px', 'border-radius:8px',
      'background:#3A1F00', 'color:#FCD34D', 'border:1px solid rgba(245,158,11,0.25)',
      'cursor:pointer', 'display:grid', 'place-items:center',
      'font-size:16px', 'line-height:1',
      'box-shadow:0 2px 8px rgba(245,158,11,.2)',
      'transition:transform .1s ease', 'user-select:none'
    ].join(';');

    floaterPair.appendChild(rfBtn);
    floaterPair.appendChild(scBtn);
    floaterPair.appendChild(noteBtn);
    floaterPair.appendChild(tapeBtn);

    // Restore position — 4 buttons need ~170px width (horizontal) / 170px height (vertical)
    const savedPos = loadFloaterPos();
    if (savedPos) {
      // v3.21.24: Apply orient yang di-save dulu sebelum set posisi,
      // supaya getBoundingClientRect() di onUp baca ukuran yang benar.
      const initialOrient = savedPos.orient === 'vertical' ? 'vertical' : 'horizontal';
      applyOrientation(initialOrient);
      // Clamp posisi supaya tidak keluar viewport — pakai ukuran sesuai orient
      const isV = initialOrient === 'vertical';
      const pw = isV ? 44 : 170;  // 36 + 8 padding
      const ph = isV ? 170 : 44;
      floaterPair.style.left = Math.max(0, Math.min(window.innerWidth - pw, savedPos.x)) + 'px';
      floaterPair.style.top  = Math.max(0, Math.min(window.innerHeight - ph, savedPos.y)) + 'px';
    } else {
      floaterPair.style.bottom = '24px';
      floaterPair.style.right = '24px';
      applyOrientation('horizontal');  // default
    }

    // ===== Drag logic (pair container, bukan per-button) =====
    let dragState = { dragging: false, startX: 0, startY: 0, origX: 0, origY: 0, moved: false, target: null };

    // v3.22.3: Aksi klik terpusat + dedupe 400ms.
    // ROOT CAUSE bug klik 🦊 (v3.21.26): single click me-relay RF_OPEN_REAL_SIDEBAR
    // ke background → chrome.sidePanel.open() butuh user gesture dan sering ditolak
    // saat dipanggil dari handler pesan; kegagalannya RESOLVE (bukan reject) sehingga
    // .catch() fallback toggle() tidak pernah jalan → 1x klik terasa mati.
    // FIX: 1x klik rfBtn = toggle popout DOM sidebar LANGSUNG di sini, tanpa
    // background sama sekali. Sidebar asli browser tetap bisa dibuka via icon toolbar.
    //
    // Dedupe: aksi bisa datang dari 2 jalur (pointerup path + native click fallback
    // untuk Firefox). Guard 400ms mencegah eksekusi ganda & anti-flicker double-click.
    let lastAction = { name: null, ts: 0 };
    function performAction(name) {
      const now = Date.now();
      if (lastAction.name === name && now - lastAction.ts < 400) return;
      lastAction = { name, ts: now };
      if (name === 'rf') toggle();
      else if (name === 'sc') triggerScreenshot();
      else if (name === 'note') openNote();
      else if (name === 'tape') openTape();
    }

    // v3.22.3: Buka RecallNote — 1 message primer + fallback berbasis respons.
    // Background RF_OPEN_NOTE sudah handle inject + retry notes-cs.js.
    // Kalau respons tidak jelas (channel tanpa Promise di Firefox / ok:false /
    // gagal kirim), barulah fallback RF_FORWARD_TO_ACTIVE_TAB + CustomEvent.
    function openNote() {
      browser.runtime.sendMessage({ type: 'RF_OPEN_NOTE' }).then((res) => {
        if (res && res.ok) return;
        browser.runtime.sendMessage({ type: 'RF_FORWARD_TO_ACTIVE_TAB', msgType: 'OPEN_NOTE' }).catch(()=>{});
        try{ window.dispatchEvent(new CustomEvent('rf-open-note')); }catch(e){}
      }).catch(() => {
        browser.runtime.sendMessage({ type: 'RF_FORWARD_TO_ACTIVE_TAB', msgType: 'OPEN_NOTE' }).catch(()=>{});
        try{ window.dispatchEvent(new CustomEvent('rf-open-note')); }catch(e){}
      });
    }
    function openTape() {
      browser.runtime.sendMessage({ type: 'RF_OPEN_TAPE' }).then((res) => {
        if (res && res.ok) return;
        browser.runtime.sendMessage({ type: 'RF_FORWARD_TO_ACTIVE_TAB', msgType: 'OPEN_TAPE' }).catch(()=>{});
        try{ window.dispatchEvent(new CustomEvent('rf-open-tape')); }catch(e){}
      }).catch(() => {
        browser.runtime.sendMessage({ type: 'RF_FORWARD_TO_ACTIVE_TAB', msgType: 'OPEN_TAPE' }).catch(()=>{});
        try{ window.dispatchEvent(new CustomEvent('rf-open-tape')); }catch(e){}
      });
    }

    function onDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      // Hanya drag kalau mulai dari container (bukan dari button)
      // Tapi kita allow drag dari button juga — click vs drag disambiguasi di onUp
      const cx = e.clientX !== undefined ? e.clientX : (e.touches?.[0]?.clientX || 0);
      const cy = e.clientY !== undefined ? e.clientY : (e.touches?.[0]?.clientY || 0);
      dragState.dragging = true;
      dragState.startX = cx;
      dragState.startY = cy;
      const rect = floaterPair.getBoundingClientRect();
      dragState.origX = rect.left;
      dragState.origY = rect.top;
      dragState.moved = false;
      dragState.target = e.target;
      if (e.pointerId !== undefined) {
        try { floaterPair.setPointerCapture(e.pointerId); } catch (err) {}
      }
      e.preventDefault();
    }

    function onMove(e) {
      if (!dragState.dragging) return;
      const cx = e.clientX !== undefined ? e.clientX : (e.touches?.[0]?.clientX || 0);
      const cy = e.clientY !== undefined ? e.clientY : (e.touches?.[0]?.clientY || 0);
      const dx = cx - dragState.startX;
      const dy = cy - dragState.startY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) dragState.moved = true;
      if (!dragState.moved) return;
      let newX = Math.max(0, Math.min(window.innerWidth - 170, dragState.origX + dx));
      let newY = Math.max(0, Math.min(window.innerHeight - 36, dragState.origY + dy));
      floaterPair.style.left = newX + 'px';
      floaterPair.style.top = newY + 'px';
      floaterPair.style.bottom = 'auto';
      floaterPair.style.right = 'auto';
    }

    function onUp(e) {
      if (!dragState.dragging) return;
      dragState.dragging = false;
      if (e.pointerId !== undefined) {
        try { floaterPair.releasePointerCapture(e.pointerId); } catch (err) {}
      }
      if (dragState.moved) {
        // v3.21.24: Drag selesai — compute orient baru dari posisi drop, apply, persist.
        // Compute dilakukan SETELAH drag (bukan live saat drag) supaya tidak berkedip.
        const rect = floaterPair.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const newOrient = computeOrientation(rect.left, rect.top, vw, vh, rect.width, rect.height);
        applyOrientation(newOrient);
        // Setelah applyOrientation, rect mungkin berubah (horizontal↔vertical).
        // Re-clamp posisi supaya tidak keluar viewport dengan ukuran baru.
        const newRect = floaterPair.getBoundingClientRect();
        let clampedLeft = Math.max(0, Math.min(vw - newRect.width, rect.left));
        let clampedTop  = Math.max(0, Math.min(vh - newRect.height, rect.top));
        floaterPair.style.left = clampedLeft + 'px';
        floaterPair.style.top  = clampedTop + 'px';
        saveFloaterPos(clampedLeft, clampedTop, newOrient);
      } else {
        // Click — determine which button was clicked (4 buttons)
        // v3.22.3: 1x klik rfBtn = toggle popout DOM sidebar langsung (performAction).
        if (dragState.target === rfBtn || rfBtn.contains(dragState.target)) {
          e.preventDefault();
          e.stopPropagation();
          performAction('rf');
        } else if (dragState.target === scBtn || scBtn.contains(dragState.target)) {
          e.preventDefault();
          e.stopPropagation();
          performAction('sc');
        } else if (dragState.target === noteBtn || noteBtn.contains(dragState.target)) {
          e.preventDefault();
          e.stopPropagation();
          performAction('note');
        } else if (dragState.target === tapeBtn || tapeBtn.contains(dragState.target)) {
          e.preventDefault();
          e.stopPropagation();
          performAction('tape');
        }
      }
    }

    // Pointer events
    floaterPair.addEventListener('pointerdown', onDown);
    floaterPair.addEventListener('pointermove', onMove);
    floaterPair.addEventListener('pointerup', onUp);
    floaterPair.addEventListener('pointercancel', onUp);

    // Mouse events fallback (Firefox)
    floaterPair.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);

    // Touch events
    floaterPair.addEventListener('touchstart', onDown, { passive: false });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);

    // Keyboard — v3.22.3: Enter/Space = aksi sama dengan 1x klik mouse.
    rfBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); performAction('rf'); }
    });
    scBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); performAction('sc'); }
    });
    noteBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); performAction('note'); }
    });
    tapeBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); performAction('tape'); }
    });

    // v3.22.3: Native click fallback (Firefox safety net).
    // Kalau jalur pointerup hilang/retarget (quirk pointer capture di Firefox),
    // native click tetap fire di tombol → aksi tetap jalan. Dedupe 400ms di
    // performAction mencegah eksekusi ganda saat kedua jalur fire berurutan.
    rfBtn.addEventListener('click', (e) => { e.stopPropagation(); performAction('rf'); });
    scBtn.addEventListener('click', (e) => { e.stopPropagation(); performAction('sc'); });
    noteBtn.addEventListener('click', (e) => { e.stopPropagation(); performAction('note'); });
    tapeBtn.addEventListener('click', (e) => { e.stopPropagation(); performAction('tape'); });

    document.documentElement.appendChild(floaterPair);
  }

  // ===== Trigger screenshot — kirim message ke background =====
  function triggerScreenshot() {
    // v3.20.13: Event-driven hide/restore — sidebar tetap visible saat
    // mode-picker (picker z-index tinggi nutupin sidebar, tidak masalah).
    // Hide hanya terjadi saat background akan captureVisibleTab, lewat
    // broadcast RF_HIDE_FOR_CAPTURE. Restore SELALU dikirim di finally block
    // background (sukses / gagal / cancel) — tidak ada timer fallback 30s.
    //
    // Bug sebelumnya (v3.20.12): hide langsung di sini pakai display:none
    // + jadwal setTimeout 30s restore. Kalau user batal picker (Esc / klik
    // luar), background tidak pernah panggil captureVisibleTab → sidebar
    // tetap hidden sampai 30s timer selesai. User report:
    // "kalau batal screenshot berarti popout tidak kembali otomatis?
    // misal pencet esc atau halaman kosong lainnya diluar modal screnshoot?"
    // Plus typo bug: line 307 set host.style.display (harusnya floaterPair).
    browser.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT', mode: undefined }).catch(() => {
      // Fallback: kirim TRIGGER_CAPTURE_FROM_POPUP ke overlay.js via background
      browser.runtime.sendMessage({ type: 'RF_FORWARD_TO_ACTIVE_TAB', msgType: 'TRIGGER_CAPTURE_FROM_POPUP' }).catch(() => {});
    });
  }

  // ===== Show / Hide / Toggle =====
  function show() {
    mount();
    // v3.20.8: Reset ke MIN_WIDTH setiap kali show() kalau user belum pernah resize
    // User: "ukuran popout sidebar belum ke versi terkecil seperti sidebar aslinya"
    if (!userResized) {
      currentWidth = MIN_WIDTH;
    }
    host.style.width = currentWidth + 'px';
    host.style.display = 'block';
    isVisible = true;
    resetIdleTimer();
    saveState({ visible: true, width: currentWidth, pinned: isPinned, userResized });
  }
  function hide() {
    if (!host) return;
    host.style.display = 'none';
    isVisible = false;
    if (idleTimer) clearTimeout(idleTimer);
    saveState({ visible: false, width: currentWidth, pinned: isPinned, userResized });
  }
  function toggle() {
    if (isVisible) hide();
    else show();
  }

  // ===== Resize handle =====
  // v3.20.8: Fix resize nempel — pakai window-level mouseup + guard flag
  // Root cause: document.addEventListener('mouseup') tidak fire kalau mouse
  // dilepas di luar document (di atas iframe cross-origin). Fix: pakai
  // window.addEventListener + pointer events di resizeHandle sendiri.
  function wireResize() {
    if (host.dataset.resizeWired === '1') return;
    host.dataset.resizeWired = '1';

    let dragController = null;

    function onResizeStart(e) {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = host.offsetWidth;
      resizeHandle.style.background = 'rgba(79,70,229,.3)';
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
      // v3.20.10 FIX: Disable iframe pointer-events during drag.
      // Root cause: iframe has pointer-events:auto → steals mousemove/mouseup
      // → window listeners don't fire → drag stuck ("nempel").
      // Fix: Set iframe pointer-events:none during drag, restore on end.
      if (iframe) iframe.style.pointerEvents = 'none';

      dragController = new AbortController();
      const sig = dragController.signal;

      const onMove = (ev) => {
        const delta = startX - ev.clientX;
        currentWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + delta));
        host.style.width = currentWidth + 'px';
      };

      const onEnd = () => {
        userResized = true;
        resizeHandle.style.background = 'transparent';
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.documentElement.style.cursor = '';
        if (iframe) iframe.style.pointerEvents = 'auto';  // v3.20.10: restore iframe
        if (dragController) { dragController.abort(); dragController = null; }
        saveState({ visible: isVisible, width: currentWidth, pinned: isPinned, userResized });
      };

      window.addEventListener('mousemove', onMove, { signal: sig });
      window.addEventListener('mouseup', onEnd, { signal: sig });
      window.addEventListener('pointermove', onMove, { signal: sig });
      window.addEventListener('pointerup', onEnd, { signal: sig });
      window.addEventListener('pointercancel', onEnd, { signal: sig });
      window.addEventListener('blur', onEnd, { signal: sig });
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') onEnd();
      }, { signal: sig });
    }

    resizeHandle.addEventListener('mousedown', onResizeStart);
    resizeHandle.addEventListener('pointerdown', onResizeStart);

    resizeHandle.addEventListener('mouseenter', () => {
      if (!dragController) resizeHandle.style.background = 'rgba(79,70,229,.2)';
    });
    resizeHandle.addEventListener('mouseleave', () => {
      if (!dragController) resizeHandle.style.background = 'transparent';
    });
  }

  // ===== Message listener (from background + from iframe via postMessage) =====
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'OPEN_SIDEBAR_IN_PAGE') show();
    else if (msg.type === 'CLOSE_SIDEBAR_IN_PAGE') hide();
    else if (msg.type === 'TOGGLE_SIDEBAR_IN_PAGE') toggle();
    else if (msg.type === 'RF_HIDE_FOR_CAPTURE') {
      // v3.20.12: Background broadcasts this before captureVisibleTab
      if (host) host.style.display = 'none';
      if (floaterPair) floaterPair.style.display = 'none';

      // v3.20.14: Fallback restore 5 detik.
      // User report: "akhirnya muncul tapi itu terlalu lama... kadang ga
      // muncul lagi juga." Root cause: kalau RF_RESTORE_AFTER_CAPTURE
      // gagal sampai (tab navigate, content script reload, message lost),
      // sidebar + floater tetap hidden selamanya.
      // Fix: jadwalkan auto-restore 5 detik. Kalau RF_RESTORE_AFTER_CAPTURE
      // datang lebih cepat, timer di-clear (lihat handler di bawah).
      if (captureHideTimer) clearTimeout(captureHideTimer);
      captureHideTimer = setTimeout(() => {
        if (host && isVisible) host.style.display = 'block';
        if (floaterPair) floaterPair.style.display = 'flex';
        captureHideTimer = null;
      }, 5000);
    }
    else if (msg.type === 'RF_RESTORE_AFTER_CAPTURE') {
      // v3.20.14: Clear fallback timer karena restore sudah datang dari background
      if (captureHideTimer) { clearTimeout(captureHideTimer); captureHideTimer = null; }
      // v3.20.12: Always restore — even if isVisible changed during capture
      if (host && isVisible) host.style.display = 'block';
      if (floaterPair) floaterPair.style.display = 'flex';
    }
  });

  // v3.20.7: Listen for postMessage from iframe (sidebarInPageBtn close + activity)
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'RF_TOGGLE_POPOUT') {
      toggle();
    }
    else if (e.data?.type === 'RF_ACTIVITY') {
      // Activity dari inside iframe — reset idle timer
      onActivity();
    }
    else if (e.data?.type === 'RF_OPEN_TAPE') {
      // v3.20.10 FIX: Content scripts don't have browser.tabs access in Firefox.
      // Send message to background.js to forward OPEN_TAPE to active tab.
      browser.runtime.sendMessage({ type: 'RF_FORWARD_TO_ACTIVE_TAB', msgType: 'OPEN_TAPE' }).catch(() => {});
    }
  });

  // ===== Init =====
  (async function init() {
    // Allow http/https/file + PDF viewer (resource:// with .pdf in URL) — jangan return untuk PDF
    const isPdf = /\.pdf(\?|#|$)/i.test(location.href);
    if (!/^(https?|file|resource|chrome-extension):/i.test(location.protocol) && !isPdf) return;
    if (/^(about|moz-extension):/i.test(location.protocol) && !isPdf) return;
    if (document.readyState === 'loading') {
      await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));
    }
    const state = await loadState();
    currentWidth = state.width;
    isPinned = state.pinned;
    userResized = state.userResized;  // v3.20.9: persist userResized across page reloads
    mountFloater();
    if (state.visible) {
      setTimeout(() => show(), 500);
    }
  })();

  // ===== Agent API =====
  if (!window.__recallfox) {
    window.__recallfox = {
      toggle, show, hide,
      get visible() { return isVisible; },
      get iframe() { return iframe; },
      get width() { return currentWidth; },
      setWidth(w) {
        currentWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w));
        if (host) host.style.width = currentWidth + 'px';
        saveState({ visible: isVisible, width: currentWidth, pinned: isPinned, userResized });
      },
      version: '3.20.7-iframe'
    };
  }
})();
