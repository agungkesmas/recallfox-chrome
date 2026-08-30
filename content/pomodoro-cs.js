// content/pomodoro-cs.js — RecallPomodoro floating timer (v3.23.1; dock v3.23.2)
//
// Permintaan user (v3.23.1): tombol floating untuk Pomodoro dengan perilaku
// TRANSparan seperti RecallNote/RecallTape (idle = transparan, hover = penuh,
// bisa digeser, bisa digulung), DEFAULT TERPIN (pin aktik sejak awal), dan
// bentuknya MIRIP strip Pomodoro yang sudah ada di sidebar (🍅 timer + mode +
// ▶/⏸ + ↺ + preset + 🔊 + chips 25/5 50/10 52/17 90/20 Custom + siklus + bell).
//
// Arsitektur:
// - State TUNGGAL global: storage.local `pomodoroFloatState` — semua tab
//   merender dari state yang sama (sinkron antar tab via storage.onChanged,
//   DOM saja tidak pernah menulis → anti-loop, pola persis notes/tape).
// - Model detik TURUNAN (derived): state menyimpan {remaining, running,
//   updatedAt}; setiap klien menghitung sisa detik dari Date.now() -
//   updatedAt. TIDAK ADA tulisan per-detik → aman dari drift multi-tab.
//   Tulisan hanya terjadi saat aksi user (start/pause/reset/preset/sound)
//   dan saat transisi mode (fokus→istirahat dst) — transisi dijaga guard
//   (re-read fresh + hanya tab visible) supaya tidak dobel.
// - Logika preset/transisi = mirror lib/pomodoro.js (25/5, 50/10, 52/17,
//   90/20, custom; long break 15 menit setelah 4 siklus; auto-lanjut).
//   Di-inline agar content script ini mandiri (aman untuk Firefox yang
//   tidak bisa dynamic import dari content script — Bugzilla 1536094).
//
// Pesan yang ditangani: OPEN_POMODORO (dari background/pill), THEME_CHANGED,
// RF_HIDE_FOR_CAPTURE / RF_RESTORE_AFTER_CAPTURE, CustomEvent
// 'rf-open-pomodoro' (fallback sidebar-cs.js). Notifikasi lewat background:
// POMODORO_NOTIFY (content script tidak punya akses browser.notifications).

(function () {
  if (window.__recallfoxPomodoroLoaded) return;
  window.__recallfoxPomodoroLoaded = true;

  const KEY = 'pomodoroFloatState';
  const LEGACY_KEY = 'pomodoroState'; // strip Pomodoro sidebar/popup (v3.21.14)
  const HOST_ID = 'recallfox-pomodoro-host';
  const LONG_BREAK_MIN = 15;

  // ===== Logika murni (mirror lib/pomodoro.js — zero deps) =====
  const PRESETS = {
    '25/5': { work: 25, break: 5, label: '25/5' },
    '50/10': { work: 50, break: 10, label: '50/10' },
    '52/17': { work: 52, break: 17, label: '52/17' },
    '90/20': { work: 90, break: 20, label: '90/20' },
  };
  function getPreset(preset, customWork, customBreak) {
    if (preset === 'custom') {
      const w = Math.max(1, Math.min(120, parseInt(customWork) || 25));
      const b = Math.max(1, Math.min(30, parseInt(customBreak) || 5));
      return { work: w, break: b, label: 'Custom ' + w + '/' + b };
    }
    return PRESETS[preset] || PRESETS['25/5'];
  }
  function formatMMSS(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  function modeLabel(mode) { return mode === 'focus' ? 'Fokus' : mode === 'break' ? 'Istirahat' : 'Long Break'; }
  function nextState(s) {
    const p = getPreset(s.preset, s.customWork, s.customBreak);
    let mode = s.mode; let cycles = s.cycles; let remaining;
    if (mode === 'focus') {
      cycles += 1;
      if (cycles % 4 === 0) { mode = 'longBreak'; remaining = LONG_BREAK_MIN * 60; }
      else { mode = 'break'; remaining = p.break * 60; }
    } else {
      mode = 'focus';
      remaining = p.work * 60;
    }
    return Object.assign({}, s, { mode, remaining, cycles, running: false, updatedAt: Date.now() });
  }
  // Sisa detik turunan — tanpa tulisan per-detik (lihat header).
  function derivedRemaining(s) {
    if (!s || !s.running) return Math.max(0, (s && s.remaining) || 0);
    const elapsed = Math.floor((Date.now() - (s.updatedAt || Date.now())) / 1000);
    return Math.max(0, (s.remaining || 0) - elapsed);
  }
  function createInitial(preset, customWork, customBreak) {
    const p = getPreset(preset, customWork, customBreak);
    return {
      // v3.23.2: default TERTUTUP (collapsed) + TERPIN — bar ramping di dock;
      // dv:2 penanda default baru sudah diterapkan (pilihan user dihormati).
      open: false, collapsed: true, pinned: true, x: null, y: null, dv: 2,
      preset: (preset === 'custom' || PRESETS[preset]) ? preset : '25/5',
      customWork: parseInt(customWork) || 25,
      customBreak: parseInt(customBreak) || 5,
      mode: 'focus', remaining: p.work * 60, running: false, cycles: 0,
      soundOn: true, soundFile: 'bell-soft.mp3',
      updatedAt: Date.now(), createdAt: Date.now()
    };
  }

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

  // ===== State =====
  let cache = null;
  async function load() {
    try { const r = await browser.storage.local.get([KEY]); cache = r[KEY] || null; } catch (e) { /* keep cache */ }
    // v3.23.2 migrasi sekali: default baru "tertutup & terpin di dock". State
    // lama v3.23.1 dilipat sekali saat upgrade; dv:2 menandai migrasi selesai
    // sehingga pilihan user sesudahnya dihormati.
    if (cache && cache.dv !== 2) {
      cache.dv = 2; cache.collapsed = true;
      try { await browser.storage.local.set({ [KEY]: cache }); } catch (e) {}
    }
    return cache;
  }
  async function save(s) {
    cache = s;
    try { await browser.storage.local.set({ [KEY]: s }); } catch (e) {}
  }
  // Init pertama: warisi preset/custom/sound dari strip Pomodoro sidebar
  // (pomodoroState) supaya floater terasa nyambung dengan yang sudah ada.
  async function initState() {
    let s = createInitial('25/5');
    try {
      const r = await browser.storage.local.get([LEGACY_KEY]);
      const l = r[LEGACY_KEY];
      if (l && l.preset) {
        const p = getPreset(l.preset, l.customWork, l.customBreak);
        s.preset = l.preset === 'custom' ? 'custom' : (PRESETS[l.preset] ? l.preset : '25/5');
        s.customWork = parseInt(l.customWork) || 25;
        s.customBreak = parseInt(l.customBreak) || 5;
        s.remaining = p.work * 60;
      }
      if (l && typeof l.soundOn === 'boolean') s.soundOn = l.soundOn;
      if (l && l.soundFile) s.soundFile = String(l.soundFile);
    } catch (e) {}
    s.updatedAt = Date.now();
    return s;
  }

  // ===== Bell + notifikasi + tick (LEVEL MODUL — dipakai interval global) =====
  function playBell(test) {
    const file = (cache && cache.soundFile) || 'bell-soft.mp3';
    try {
      const url = browser.runtime.getURL('assets/sounds/' + file);
      const audio = new Audio(url); audio.volume = 0.7;
      const pr = audio.play(); if (pr && pr.catch) pr.catch(() => {});
      return;
    } catch (e) {}
    try { // fallback beep
      const Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return;
      const ctx = new Ctx(); const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.3, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
      o.start(); o.stop(ctx.currentTime + 0.5);
    } catch (e) {}
  }
  function notifyBg(title, message) {
    try { browser.runtime.sendMessage({ type: 'POMODORO_NOTIFY', title, message }).catch(() => {}); } catch (e) {}
  }

  // Transisi saat mencapai 0 — guard anti-dobel: re-read fresh + hanya tab
  // yang visible yang menulis (bila tidak ada tab visible, transisi tetap
  // benar saat tab kembali visible karena sisa detik turunan).
  async function tickAttempt() {
    try {
      const s = cache || (await load());
      if (!s || !s.open || !s.running) return;
      if (derivedRemaining(s) > 0) { renderCtrl(); return; }
      if (typeof document.visibilityState === 'string' && document.visibilityState !== 'visible') return;
      const fresh = await load();
      if (!fresh || !fresh.running) return;
      if (derivedRemaining(fresh) > 0) { cache = fresh; renderCtrl(); return; }
      const wasFocus = fresh.mode === 'focus';
      const ns = nextState(fresh);
      ns.running = true; // auto lanjut — paritas strip sidebar
      ns.updatedAt = Date.now();
      await save(ns); renderCtrl();
      if (fresh.soundOn) { try { playBell(); } catch (e) {} }
      notifyBg(wasFocus ? 'Selesai Fokus' : (fresh.mode === 'longBreak' ? 'Selesai Long Break' : 'Selesai Istirahat'),
               wasFocus ? 'Waktunya istirahat' : 'Waktunya fokus lagi');
    } catch (e) {}
  }

  // ===== Dock (v3.23.2) =====
  // Pemicu layout dock global (content/float-dock.js) — pomodoro kini bagian
  // dari deretan yang sama dengan RecallNote/Tape (satu deretan, kanan-atas).
  function rfLayout() { try { if (window.__RFDock) window.__RFDock.layout(); } catch (e) {} }

  // ===== Controller (single instance) =====
  let ctrl = null;
  function buildCtrl(st) {
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial;position:fixed;top:0;right:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    document.documentElement.appendChild(host);
    // v3.23.5: anti bocor keyboard — shortcut situs tidak ikut terpicu
    // saat mengetik/mencet tombol di dalam floater ini.
    try { if (window.__RFDock && window.__RFDock.isolateKeys) window.__RFDock.isolateKeys(host); } catch (e) {}
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = TEMPLATE;
    const popover = shadow.querySelector('.rfp-popover');
    const timerEl = shadow.querySelector('.rfp-timer');
    const miniEl = shadow.querySelector('.rfp-mini');
    const modeEl = shadow.querySelector('.rfp-mode');
    const presetEl = shadow.querySelector('.rfp-preset-label');
    const cyclesEl = shadow.querySelector('.rfp-cycles');
    const startBtn = shadow.querySelector('.rfp-start');
    const pauseBtn = shadow.querySelector('.rfp-pause');
    const resetBtn = shadow.querySelector('.rfp-reset');
    const soundBtn = shadow.querySelector('.rfp-sound');
    const msoundBtn = shadow.querySelector('.rfp-msound');
    const mstartBtn = shadow.querySelector('.rfp-mstart');
    const mresetBtn = shadow.querySelector('.rfp-mreset');
    const soundToggle = shadow.querySelector('.rfp-sound-toggle');
    const soundSel = shadow.querySelector('.rfp-sound-sel');
    const testBtn = shadow.querySelector('.rfp-test');
    const pinBtn = shadow.querySelector('.rfp-pin');
    const chipsWrap = shadow.querySelector('.rfp-chips');
    const customBox = shadow.querySelector('.rfp-custom');
    const wInput = shadow.querySelector('.rfp-w');
    const bInput = shadow.querySelector('.rfp-b');
    const applyBtn = shadow.querySelector('.rfp-apply');
    const stv = { isVisible: false, prevH: '' };

    function setActive() { try { popover.classList.remove('rfp-idle'); } catch (e) {} }
    function setIdle() { try { if (!stv.isVisible) return; popover.classList.add('rfp-idle'); } catch (e) {} }

    function applyGeometry() {
      try {
        // v3.23.2 DOCK: posisi dari dock global (bukan st.x/st.y)
        popover.classList.toggle('rfp-min', !!st.collapsed);
      } catch (e) {}
    }
    // Render dari state (dipanggil interval + onChanged + setelah aksi).
    function render(s) {
      try {
        if (!s || !popover) return;
        // sync field lokal dari state terbaru (perubahan bisa datang dari tab lain)
        st.collapsed = !!s.collapsed;
        st.pinned = s.pinned !== false;
        const r = derivedRemaining(s);
        const mm = formatMMSS(r);
        if (timerEl) timerEl.textContent = '🍅 ' + mm;
        if (miniEl) miniEl.textContent = '🍅 ' + mm;
        if (modeEl) modeEl.textContent = modeLabel(s.mode);
        if (presetEl) presetEl.textContent = s.preset === 'custom' ? ('Custom ' + (parseInt(s.customWork) || 25) + '/' + (parseInt(s.customBreak) || 5)) : (PRESETS[s.preset] ? s.preset : '25/5');
        if (cyclesEl) cyclesEl.textContent = ((s.cycles || 0) % 4) + '/4';
        if (startBtn) startBtn.style.display = s.running ? 'none' : '';
        if (pauseBtn) pauseBtn.style.display = s.running ? '' : 'none';
        if (soundBtn) soundBtn.textContent = s.soundOn ? '🔊' : '🔇';
        if (msoundBtn) msoundBtn.textContent = s.soundOn ? '🔊' : '🔇';
        if (mstartBtn) mstartBtn.textContent = s.running ? '⏸' : '▶';
        if (soundToggle) soundToggle.textContent = s.soundOn ? 'On' : 'Off';
        if (soundSel && s.soundFile) soundSel.value = s.soundFile;
        if (pinBtn) { try { pinBtn.classList.toggle('rfp-active', !!st.pinned); } catch (e) {} }
        // chips aktif
        try {
          const chips = chipsWrap ? chipsWrap.querySelectorAll('[data-preset]') : [];
          for (const b of chips) b.classList.toggle('on', b.dataset.preset === s.preset);
        } catch (e) {}
        if (customBox) customBox.style.display = s.preset === 'custom' ? 'flex' : 'none';
        if (wInput) wInput.value = parseInt(s.customWork) || 25;
        if (bInput) bInput.value = parseInt(s.customBreak) || 5;
        applyGeometry();
        // v3.23.2 DOCK: gulung/buka dari tab lain → restack deretan di tab ini
        if (stv.lastCollapsed !== st.collapsed) { stv.lastCollapsed = st.collapsed; rfLayout(); }
      } catch (e) {}
    }
    async function show() {
      try { const theme = await loadTheme(); shadow.host.setAttribute('data-theme', theme); } catch (e) {}
      try { host.style.display = ''; } catch (e) {}
      applyGeometry();
      popover.classList.add('rfp-show');
      stv.isVisible = true;
      try { popover.classList.add('rfp-idle'); } catch (e) {}
      render(cache || st);
    }
    function hideDom() { try { popover.classList.remove('rfp-show'); popover.classList.remove('rfp-idle'); } catch (e) {} stv.isVisible = false; }
    function destroy() { try { if (window.__RFDock) window.__RFDock.unregister('pomo:main'); } catch (e) {} try { host.remove(); } catch (e) {} }
    async function close() {
      hideDom(); destroy(); ctrl = null;
      const s = await load();
      if (s && s.open) { s.open = false; await save(s); }
    }
    function setTheme(t) { try { shadow.host.setAttribute('data-theme', t); } catch (e) {} }
    function setPos(x, y) { try { popover.style.left = x + 'px'; popover.style.top = y + 'px'; popover.style.right = 'auto'; } catch (e) {} }

    // ===== Aksi timer (tulis hanya saat aksi — model turunan) =====
    async function doStart() {
      const s = await load(); if (!s) return;
      let r = derivedRemaining(s);
      if (r <= 0) { // habis saat pause — mulai dari penuh mode ini
        const p = getPreset(s.preset, s.customWork, s.customBreak);
        r = s.mode === 'focus' ? p.work * 60 : s.mode === 'longBreak' ? LONG_BREAK_MIN * 60 : p.break * 60;
      }
      s.remaining = r; s.running = true; s.updatedAt = Date.now();
      await save(s); render(s);
    }
    async function doPause() {
      const s = await load(); if (!s) return;
      s.remaining = derivedRemaining(s); s.running = false; s.updatedAt = Date.now();
      await save(s); render(s);
    }
    async function doReset() {
      const s = await load(); if (!s) return;
      const p = getPreset(s.preset, s.customWork, s.customBreak);
      s.remaining = s.mode === 'focus' ? p.work * 60 : s.mode === 'longBreak' ? LONG_BREAK_MIN * 60 : p.break * 60;
      s.running = false; s.updatedAt = Date.now();
      await save(s); render(s);
    }
    async function doPreset(preset) {
      const s = await load(); if (!s) return;
      // paritas strip sidebar: ganti preset = reset penuh (siklus kembali 0)
      const keep = { pinned: s.pinned, open: s.open, collapsed: s.collapsed, soundOn: s.soundOn, soundFile: s.soundFile }; // v3.23.2: x/y tidak lagi bagian state
      const ns = createInitial(preset, s.customWork, s.customBreak);
      Object.assign(ns, keep, { updatedAt: Date.now() });
      await save(ns); render(ns);
    }
    async function doCustom() {
      const s = await load(); if (!s) return;
      const keep = { pinned: s.pinned, open: s.open, collapsed: s.collapsed, soundOn: s.soundOn, soundFile: s.soundFile }; // v3.23.2: x/y tidak lagi bagian state
      const ns = createInitial('custom', wInput && wInput.value, bInput && bInput.value);
      Object.assign(ns, keep, { updatedAt: Date.now() });
      await save(ns); render(ns);
    }
    async function doSoundToggle() {
      const s = await load(); if (!s) return;
      s.soundOn = !s.soundOn; s.updatedAt = Date.now();
      await save(s); render(s);
    }
    async function doSoundFile(f) {
      const s = await load(); if (!s) return;
      s.soundFile = String(f || 'bell-soft.mp3'); s.updatedAt = Date.now();
      await save(s); render(s);
      try { playBell(true); } catch (e) {}
    }

    // ===== Bell: memakai playBell level modul (test = preview manual) =====

    // ===== Drag (header) — pola notes-cs.js =====
    function makeDraggable() {
      const hd = shadow.querySelector('.rfp-hd');
      let d = false, dx = 0, dy = 0, moved = false;
      hd.addEventListener('mousedown', e => { if (e.target.closest && e.target.closest('button,select,input')) return; d = true; moved = false; const rect = popover.getBoundingClientRect(); dx = e.clientX - rect.left; dy = e.clientY - rect.top; popover.style.transition = 'none'; e.preventDefault(); });
      document.addEventListener('mousemove', e => { if (!d) return; moved = true; popover.style.left = (e.clientX - dx) + 'px'; popover.style.top = (e.clientY - dy) + 'px'; popover.style.right = 'auto'; });
      document.addEventListener('mouseup', () => { if (d) { d = false; popover.style.transition = ''; rfLayout(); } }); // v3.23.3 DOCK: lepas drag → kembali rapat ke deretan
    }

    function wireEvents() {
      try { startBtn.addEventListener('click', () => { doStart(); setActive(); }); } catch (e) {}
      try { pauseBtn.addEventListener('click', () => { doPause(); setActive(); }); } catch (e) {}
      try { resetBtn.addEventListener('click', () => { doReset(); setActive(); }); } catch (e) {}
      try { soundBtn.addEventListener('click', () => { doSoundToggle(); }); } catch (e) {}
      try { msoundBtn.addEventListener('click', () => { doSoundToggle(); }); } catch (e) {}
      try { mstartBtn.addEventListener('click', () => { (cache && cache.running) ? doPause() : doStart(); setActive(); }); } catch (e) {}
      try { mresetBtn.addEventListener('click', () => { doReset(); setActive(); }); } catch (e) {}
      try { soundToggle.addEventListener('click', () => { doSoundToggle(); }); } catch (e) {}
      try { testBtn.addEventListener('click', () => { playBell(true); }); } catch (e) {}
      try { soundSel.addEventListener('change', () => { doSoundFile(soundSel.value); }); } catch (e) {}
      try { applyBtn.addEventListener('click', () => { doCustom(); }); } catch (e) {}
      try {
        chipsWrap.addEventListener('click', (e) => {
          try {
            const b = e && e.target && e.target.closest && e.target.closest('[data-preset]');
            if (!b || !b.dataset) return;
            if (b.dataset.preset === 'custom') { if (customBox) customBox.style.display = 'flex'; return; }
            doPreset(b.dataset.preset);
          } catch (ee) {}
        });
      } catch (e) {}
      try { shadow.querySelector('.rfp-collapse').addEventListener('click', async () => { const s = await load(); if (!s) return; s.collapsed = !s.collapsed; await save(s); render(s); }); } catch (e) {}
      try { pinBtn.addEventListener('click', async () => { const s = await load(); if (!s) return; s.pinned = !s.pinned; await save(s); render(s); }); } catch (e) {}
      try { shadow.querySelector('.rfp-close').addEventListener('click', () => close()); } catch (e) {}
      try { popover.addEventListener('mouseenter', () => setActive()); } catch (e) {}
      try { popover.addEventListener('mouseleave', () => setIdle()); } catch (e) {}
      try { document.addEventListener('mousedown', (e) => { if (!stv.isVisible || st.pinned) return; const p = e.composedPath ? e.composedPath() : [e.target]; if (p.includes(host)) return; close(); }, true); } catch (e) {}
      try { makeDraggable(); } catch (e) {}
    }
    wireEvents();
    // v3.23.2 DOCK: daftarkan pomodoro ke dock global — satu deretan dengan
    // RecallNote/Tape; lebar 320 (senada tape), tergulung = bar 44px.
    try { if (window.__RFDock) window.__RFDock.register({ key: 'pomo:main', kind: 'pomo', t: st.createdAt || 0, visible: () => stv.isVisible, width: () => 320, height: () => st.collapsed ? 44 : 300, place: (x, y) => setPos(x, y) }); } catch (e) {}

    return { show, hideDom, destroy, close, setTheme, render, setPos, get isVisible() { return stv.isVisible; } };
  }

  // ===== Open / reconcile =====
  async function ensureOpen() {
    let s = await load();
    if (!s) s = await initState();
    // v3.23.2: default TERTUTUP (collapsed) + TERPIN — tampil sebagai bar
    // ramping di deretan dock (kanan-atas) bersama RecallNote/Tape; klik ▾
    // untuk membuka panel penuh. Posisi diatur dock global (float-dock.js).
    if (!s.open) { s.open = true; await save(s); }
    if (!ctrl) ctrl = buildCtrl(s);
    cache = s;
    await ctrl.show();
    renderCtrl();
    rfLayout();
  }
  function renderCtrl() { try { if (ctrl && cache) ctrl.render(cache); } catch (e) {} }
  async function reconcileFromStorage() {
    const s = await load();
    if (!s || !s.open) { if (ctrl) { ctrl.hideDom(); ctrl.destroy(); ctrl = null; } return; }
    if (!ctrl) { ctrl = buildCtrl(s); await ctrl.show(); rfLayout(); }
    else renderCtrl();
  }

  // ===== Messages =====
  try {
    browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      try {
        if (msg.type === 'OPEN_POMODORO' || msg.type === 'SHOW_POMODORO') ensureOpen();
        else if (msg.type === 'HIDE_POMODORO') { (async () => { const s = await load(); if (s && s.open) { s.open = false; await save(s); } if (ctrl) { ctrl.hideDom(); ctrl.destroy(); ctrl = null; } })(); }
        else if (msg.type === 'THEME_CHANGED') { try { if (ctrl) ctrl.setTheme(msg.theme); } catch (e) {} }
        else if (msg.type === 'RF_HIDE_FOR_CAPTURE') { try { const h = document.getElementById(HOST_ID); if (h) h.style.display = 'none'; } catch (e) {} }
        else if (msg.type === 'RF_RESTORE_AFTER_CAPTURE') { try { const h = document.getElementById(HOST_ID); if (h) h.style.display = ''; } catch (e) {} }
      } catch (e) {}
      // v3.22.4 FIX BUG-3 (Firefox): wajib balas — channel tidak boleh menggantung.
      if (typeof sendResponse === 'function') { try { sendResponse({ ok: true }); } catch (e) {} }
    });
  } catch (e) {}
  // Fallback CustomEvent 'rf-open-pomodoro' dari sidebar-cs.js
  try { window.addEventListener('rf-open-pomodoro', () => { try { ensureOpen(); } catch (e) {} }); } catch (e) {}

  // Cross-tab: setiap perubahan pomodoroFloatState direkonsiliasi (DOM saja).
  try {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes || !changes[KEY]) return;
      const nv = changes[KEY].newValue;
      if (nv) cache = nv;
      reconcileFromStorage();
    });
  } catch (e) {}

  // Tick: render + transisi (tanpa tulisan per-detik).
  try { setInterval(() => { try { tickAttempt(); } catch (e) {} }, 500); } catch (e) {}

  // Boot: pulihkan bila state open:true (incl. file://).
  (async function boot() { try { const s = await load(); if (s && s.open) { if (!ctrl) ctrl = buildCtrl(s); await ctrl.show(); rfLayout(); } } catch (e) {} })();

  // ===== Template (HTML + CSS inlined in Shadow DOM) =====
  const TEMPLATE = `<style>
:host{all:initial}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
.rfp-popover{
  position:fixed; top:60px; left:14px; width:320px;
  background:#0E182A; color:#E8EEF7;
  border:1px solid rgba(239,68,68,0.3); border-radius:12px;
  box-shadow:0 18px 50px rgba(0,0,0,.55);
  display:flex; flex-direction:column; overflow:hidden;
  font-family:-apple-system,system-ui,"Segoe UI",sans-serif; font-size:12px;
  opacity:0; transform:translateY(-6px) scale(.98); pointer-events:none;
  transition:opacity .15s ease, transform .15s ease;
}
.rfp-popover.rfp-show{ opacity:1; transform:translateY(0) scale(1); pointer-events:auto }
.rfp-popover.rfp-idle{ opacity:0.35; background:rgba(69,10,10,0.55); backdrop-filter:blur(2px); border-color:rgba(252,165,165,0.35); }
:host([data-theme="light"]) .rfp-popover.rfp-idle{ background:rgba(254,226,226,0.85); border-color:rgba(239,68,68,0.3); }
:host([data-theme="light"]) .rfp-popover{ background:#F8FAFC; color:#1E293B; border-color:#FECACA; box-shadow:0 18px 50px rgba(0,0,0,.12); }
.rfp-popover.rfp-min{ height:auto; }
.rfp-popover.rfp-min .rfp-body{ display:none; }
.rfp-hd{ display:flex; align-items:center; gap:6px; padding:7px 10px; cursor:move; background:#3F1212; border-bottom:1px solid rgba(239,68,68,0.2); }
:host([data-theme="light"]) .rfp-hd{ background:#FEF2F2; border-bottom:1px solid rgba(239,68,68,0.25); }
.rfp-title{ font-size:11px; font-weight:700; flex:1; display:flex; align-items:center; gap:6px; white-space:nowrap; overflow:hidden; color:#FCA5A5; }
:host([data-theme="light"]) .rfp-title{ color:#B91C1C; }
.rfp-mini{ display:none; font-variant-numeric:tabular-nums; font-size:13px; font-weight:800; letter-spacing:.02em; }
.rfp-popover.rfp-min .rfp-mini{ display:inline; }.rfp-title-text{ white-space:nowrap; }.rfp-popover.rfp-min .rfp-title-text{ display:none; }.rfp-mini-actions{ display:none; gap:2px; }.rfp-popover.rfp-min .rfp-mini-actions{ display:flex; }
.rfp-actions{ display:flex; gap:2px; }
.rfp-btn{ width:24px; height:24px; border-radius:5px; border:none; background:none; color:#A3B0C2; display:grid; place-items:center; cursor:pointer; }
:host([data-theme="light"]) .rfp-btn{ color:#64748B; }
.rfp-btn:hover{ background:rgba(255,255,255,.08); }
:host([data-theme="light"]) .rfp-btn:hover{ background:rgba(0,0,0,.06); }
.rfp-btn.rfp-active{ background:#7F1D1D; color:#FCA5A5; border:1px solid rgba(252,165,165,0.3); }
:host([data-theme="light"]) .rfp-btn.rfp-active{ background:#FEE2E2; color:#B91C1C; }
.rfp-btn svg{ width:13px; height:13px; }
.rfp-collapse svg{ transition:transform .15s; }
.rfp-popover.rfp-min .rfp-collapse svg{ transform:rotate(-90deg); }
.rfp-body{ padding:10px 12px 12px; display:flex; flex-direction:column; gap:9px; }
.rfp-row{ display:flex; align-items:center; gap:7px; flex-wrap:wrap; }
.rfp-timer{ font-family:Menlo,Consolas,"Courier New",monospace; font-size:25px; font-weight:700; letter-spacing:.02em; color:#FCA5A5; font-variant-numeric:tabular-nums; }
:host([data-theme="light"]) .rfp-timer{ color:#DC2626; }
.rfp-mode{ font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; padding:3px 8px; border-radius:999px; background:rgba(248,113,113,.15); color:#FCA5A5; }
:host([data-theme="light"]) .rfp-mode{ background:#FEE2E2; color:#B91C1C; }
.rfp-ctrl{ display:flex; align-items:center; gap:6px; }
.rfp-btn2{ padding:5px 10px; border-radius:7px; border:none; cursor:pointer; font-size:11px; font-weight:700; background:#7F1D1D; color:#FECACA; }
.rfp-btn2:hover{ background:#991B1B; }
:host([data-theme="light"]) .rfp-btn2{ background:#DC2626; color:#fff; }
:host([data-theme="light"]) .rfp-btn2:hover{ background:#B91C1C; }
.rfp-btn2.ghost{ background:rgba(255,255,255,.08); color:#CBD5E1; }
:host([data-theme="light"]) .rfp-btn2.ghost{ background:rgba(0,0,0,.06); color:#334155; }
.rfp-preset-label{ margin-left:auto; font-size:11px; font-weight:700; color:#A3B0C2; font-variant-numeric:tabular-nums; }
:host([data-theme="light"]) .rfp-preset-label{ color:#64748B; }
.rfp-detail{ background:rgba(255,255,255,.03); border:1px solid rgba(239,68,68,.14); border-radius:10px; padding:8px 10px; display:flex; flex-direction:column; gap:7px; }
:host([data-theme="light"]) .rfp-detail{ background:#FFF; border-color:#FECACA; }
.rfp-chips{ display:flex; gap:5px; flex-wrap:wrap; }
.rfp-chip{ padding:3px 9px; border-radius:999px; border:1px solid rgba(148,163,184,.3); background:rgba(255,255,255,.05); color:#CBD5E1; font-size:10.5px; font-weight:700; cursor:pointer; }
:host([data-theme="light"]) .rfp-chip{ background:#F8FAFC; color:#475569; }
.rfp-chip.on{ background:#EF4444; border-color:#EF4444; color:#fff; }
.rfp-custom{ display:none; gap:6px; align-items:center; font-size:11px; }
.rfp-custom input{ width:52px; padding:3px 6px; border:1px solid rgba(148,163,184,.35); border-radius:6px; background:rgba(255,255,255,.06); color:inherit; font-size:11px; }
:host([data-theme="light"]) .rfp-custom input{ background:#FFF; border-color:#CBD5E1; color:#1E293B; }
.rfp-meta{ display:flex; align-items:center; gap:7px; font-size:10.5px; color:#A3B0C2; flex-wrap:wrap; }
:host([data-theme="light"]) .rfp-meta{ color:#64748B; }
.rfp-meta b{ color:inherit; }
.rfp-sound-sel{ padding:3px 5px; border-radius:6px; border:1px solid rgba(148,163,184,.35); background:rgba(255,255,255,.06); color:inherit; font-size:10.5px; max-width:86px; }
:host([data-theme="light"]) .rfp-sound-sel{ background:#FFF; border-color:#CBD5E1; color:#1E293B; }
.rfp-mini-btn{ padding:3px 8px; border-radius:6px; border:none; background:rgba(255,255,255,.08); color:#CBD5E1; font-size:10.5px; font-weight:700; cursor:pointer; }
:host([data-theme="light"]) .rfp-mini-btn{ background:rgba(0,0,0,.06); color:#334155; }
.rfp-toast{ position:absolute; bottom:8px; left:50%; transform:translateX(-50%) translateY(8px); background:#E8EEF7; color:#0E182A; padding:5px 12px; border-radius:6px; font-size:11px; font-weight:600; opacity:0; pointer-events:none; transition:.2s; white-space:nowrap; max-width:90%; }
.rfp-toast.rfp-show{ opacity:1; transform:translateX(-50%) translateY(0); }
</style>
<div class="rfp-popover" role="dialog" aria-label="RecallPomodoro">
  <div class="rfp-hd">
    <div class="rfp-title"><span class="rfp-title-text">🍅 RecallPomodoro</span> <span class="rfp-mini">🍅 25:00</span></div>
    <div class="rfp-actions rfp-mini-actions"><button class="rfp-btn rfp-mctl rfp-mstart" title="Mulai / Pause">▶</button><button class="rfp-btn rfp-mctl rfp-mreset" title="Reset">↺</button><button class="rfp-btn rfp-mctl rfp-msound" title="Suara bell on/off">🔊</button></div>
    <div class="rfp-actions">
      <button class="rfp-btn rfp-collapse" title="Gulung / buka lagi"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="6 9 12 15 18 9"/></svg></button>
      <button class="rfp-btn rfp-pin rfp-active" title="Pin (default terpin — klik untuk lepas)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 17v5"/><path d="M9 10.5V4h6v6.5l2 3.5H7l2-3.5z"/></svg></button>
      <button class="rfp-btn rfp-close" title="Tutup"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
  </div>
  <div class="rfp-body">
    <div class="rfp-row"><span class="rfp-timer">🍅 25:00</span><span class="rfp-mode">Fokus</span></div>
    <div class="rfp-ctrl">
      <button class="rfp-btn2 rfp-start" title="Mulai">▶ Mulai</button>
      <button class="rfp-btn2 rfp-pause" title="Pause" style="display:none">⏸ Pause</button>
      <button class="rfp-btn2 ghost rfp-reset" title="Reset">↺ Reset</button>
      <button class="rfp-btn rfp-sound" title="Suara bell on/off">🔊</button>
      <span class="rfp-preset-label">25/5</span>
    </div>
    <div class="rfp-detail">
      <div class="rfp-chips">
        <button class="rfp-chip" data-preset="25/5">25/5</button>
        <button class="rfp-chip" data-preset="50/10">50/10</button>
        <button class="rfp-chip" data-preset="52/17">52/17</button>
        <button class="rfp-chip" data-preset="90/20">90/20</button>
        <button class="rfp-chip" data-preset="custom">Custom</button>
      </div>
      <div class="rfp-custom"><input class="rfp-w" type="number" min="1" max="120" value="25"><span>/</span><input class="rfp-b" type="number" min="1" max="30" value="5"><span>menit</span><button class="rfp-mini-btn rfp-apply">Terapkan</button></div>
      <div class="rfp-meta"><span>Siklus: <b class="rfp-cycles">0/4</b></span><span>Bell: <button class="rfp-mini-btn rfp-sound-toggle">On</button></span><select class="rfp-sound-sel"><option value="bell-soft.mp3">Soft</option><option value="bell-classic.mp3">Classic</option><option value="bell-digital.mp3">Digital</option></select><button class="rfp-mini-btn rfp-test">▶ Test</button></div>
    </div>
  </div>
</div>`;
})();
