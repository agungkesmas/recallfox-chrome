// content/float-dock.js — RecallFox FLOAT DOCK (v3.23.2)
//
// Permintaan user (v3.23.2): ketika RecallNote/Tape digulung (▾) atau dibuka
// lagi (>), tampilan harus OTOMATIS menyesuaikan diri sehingga tidak pernah
// "misah-misah" (header berserakan di posisi lama era ter-expand). Pomodoro
// juga harus NEMPEL di deretan yang sama dengan RecallNote/Tape (satu deretan).
//
// Solusi: SATU dock global untuk semua floater RecallFox di tab ini:
//   - RecallNote + RecallTape + RecallPomodoro disusun SATU KOLOM rapi di
//     tepi KANAN-ATAS (urutan stabil: pomodoro → note → tape, masing-masing
//     sesuai urutan lembar dibuat).
//   - Setiap peristiwa gulung/buka/buka-lembar/tutup-lembar/resize memicu
//     RESTACK penuh: semua floater terbuka ditata ulang dari atas — header
//     tergulung hanya setinggi bar (~44px) sehingga deretan selalu kompak.
//   - Kalau muatan melebihi tinggi layar, wrap ke kolom kedua di kirinya
//     (lebar kolom langganan 346px = 320 + jeda), dst.
//   - Drag manual tetap bisa; posisi hasil drag bertahan sampai restack
//     berikutnya (dock adalah satu-satunya sumber kebenaran posisi — x/y
//     per-instance tidak lagi dipakai).
//
// Cara pakai (notes-cs.js / tape-cs.js / pomodoro-cs.js):
//   RFDock.register({ key:'note:<id>', kind:'note', t:<createdAt>,
//     visible:()=>bool, width:()=>px, height:()=>px, place:(x,y)=>{} });
//   RFDock.unregister('note:<id>');  RFDock.layout();
//
// v3.23.4: SIDEBAR AWARE — RFDock.setSidebar(lebar) menggeser SELURUH
//   deretan ke kiri saat popout sidebar RecallFox terbuka (dipanggil
//   sidebar-cs.js), dan mengembalikannya mepet kanan saat sidebar tutup.
//
// v3.24.5: SLOT HASIL DRAG — laporan user: "floating note/tape pomodoro
//   engga bisa dipindah sama sekali" (v3.23.3 melepas drag = tidy() snap
//   balik ke deretan, jadi hasil drag selalu dibatalkan) dan "lengket ke
//   kursor ga mau lepas" (mouseup dipasang di document — mouseup di atas
//   iframe / di luar window tak pernah diterima → flag drag stuck).
//   Sekarang: hasil drop DIPERTAHANKAN sebagai slot khusus per widget
//   (RFDock.pinCustom) — widget lain tetap ditata rapi di deretan dengan
//   MENGHINDARI kotak slot khusus (anti tumpang-tindih). Slot tersimpan di
//   sessionStorage (per-tab, hilang saat tab ditutup) dan dipulihkan saat
//   register ulang. Klik ganda header = kembali ke deretan (clearCustom).
// File ini idempoten: dipasang sebagai content script pertama di tiap entry
// (manifest) — semua content script RecallFox berbagi isolated world yang
// sama, jadi window.__RFDock satu instance untuk semua.
(function () {
  if (typeof window === 'undefined') return;
  if (window.__RFDock) return;

  var GAP = 10;        // jeda vertikal antar floater dalam kolom
  var TOP = 14;        // jangkar atas kolom
  var RIGHT = 14;      // jangkar tepi kanan
  var FLOOR = 8;       // batas bawah viewport
  var COLSTEP = 346;   // lebar langkah kolom wrap (320 + jeda 26)
  var MINX = 8;        // posisi terkiri yang diizinkan
  var KIND_ORDER = { pomo: 0, note: 1, tape: 2 };
  var reg = new Map(); // key → handle
  var seq = 0;
  var sidebarW = 0;    // v3.23.4: offset geser-kiri saat sidebar buka (0 = tutup)
  var SLOT_PREFIX = '__rfDockSlot:'; // v3.24.5 sessionStorage per-tab

  // v3.24.7: PRINT CLEAN — laporan user: saat halaman di-print / Save as PDF
  // lewat browser, floating button + RecallNote/Tape/Pomodoro ikut kecetak.
  // Semua UI RecallFox = chrome addon (bukan isi halaman) → wajib hilang di
  // @media print. Di-inject sebagai satu <style> halaman dari float-dock
  // (titik tunggal yang dijamin jalan di http/https/file, dijalankan sekali
  // berkat guard __RFDock di atas). Elemen transient (modal, toast, banner,
  // overlay anotasi/pemilihan/element-blocker/guard/adzan) ikut disembunyikan.
  function ensurePrintHide() {
    try {
      if (document.getElementById('recallfox-print-hide')) return;
      var st = document.createElement('style');
      st.id = 'recallfox-print-hide';
      st.textContent = [
        '@media print {',
        '  #recallfox-sidebar-host, #recallfox-sidebar-floater-pair,',
        '  [id^="recallfox-notes-host"], [id^="recallfox-tape-host"], #recallfox-pomodoro-host,',
        '  .rf-capture-modal-overlay, .recallfox-mini-info, .recallfox-overlay-error,',
        '  .recallfox-capture-toast, .recallfox-capture-banner, .recallfox-sel-overlay,',
        '  #rf-annotate-overlay, .rf-ann-text-input, #recallfox-ai-popup,',
        '  .rf-eb-picker-overlay, .rf-eb-picker-hover, .rf-eb-picker-status,',
        '  #rf-cg-empty-banner, #rf-cg-watch-overlay, #rf-adzan-banner,',
        '  .recallfox-modal-overlay, .recallfox-toast {',
        '    display: none !important;',
        '  }',
        '}'
      ].join('\n');
      (document.head || document.documentElement).appendChild(st);
    } catch (e) {}
  }
  try { ensurePrintHide(); } catch (e) {}

  // v3.24.8: POPUP AWARE — laporan user: di jendela popout (popup kecil bukan
  // tab baru) floating button + floater note/tape/pomodoro ikut muncul dan
  // mengganggu karena jendelanya kecil. Deteksi DUA LAPIS:
  //   1) HEURISTIK SINKRON (instan, sebelum UI sempat berkedip):
  //      window.opener ada + jendela kecil (w<850 dan h<650) = popout klasik
  //      hasil window.open (OAuth, popup detail, dsb). Tab baru / jendela
  //      penuh TIDAK dianggap popup (aman — user: "bukan tab lain ya").
  //   2) VERDICT OTORITATIF via background (RF_GET_WINDOW_INFO →
  //      browser.windows.get(sender.tab.windowId).type): type !== 'normal'
  //      (popup/panel/devtools) = popup terkonfirmasi. Verdict menggantikan
  //      heuristik begitu tiba: popup BESAR tanpa opener pun tertangkap,
  //      dan salah-duga heuristik pada tab normal dikoreksi (floater
  //      dipasang ulang). Konsumen: isPopup() (nilai terkini) +
  //      whenPopupVerdict(cb) (dipanggil sekali saat verdict final datang).
  var popupVerdict = (function () {
    try {
      var op = null;
      try { op = window.opener; } catch (e) { op = null; }
      if (!op || op === window) return false;
      var w = window.outerWidth || window.innerWidth || 0;
      var h = window.outerHeight || window.innerHeight || 0;
      if (w <= 0 || h <= 0) return false; // ukuran tak terbaca → jangan menebak popup
      return (w < 850 && h < 650);
    } catch (e) { return false; }
  })();
  var popupKnown = false;
  var popupCbs = [];
  function firePopupCbs() {
    var cbs = popupCbs.splice(0);
    for (var pi = 0; pi < cbs.length; pi++) { try { cbs[pi](popupVerdict); } catch (e) {} }
  }
  function setPopupVerdict(v) { popupVerdict = !!v; popupKnown = true; firePopupCbs(); }
  try {
    var RFBR = (typeof browser !== 'undefined') ? browser : (typeof chrome !== 'undefined' ? chrome : null);
    if (RFBR && RFBR.runtime && RFBR.runtime.sendMessage && RFBR.runtime.onMessage) {
      RFBR.runtime.sendMessage({ type: 'RF_GET_WINDOW_INFO' }).then(function (r) {
        setPopupVerdict(!!(r && r.ok && r.wtype && r.wtype !== 'normal'));
      }).catch(function () { popupKnown = true; firePopupCbs(); });
    } else { popupKnown = true; firePopupCbs(); }
  } catch (e) { popupKnown = true; firePopupCbs(); }

  function num(fn, d) {
    try { var v = fn(); return (typeof v === 'number' && v > 0) ? v : d; } catch (e) { return d; }
  }

  // v3.24.5: slot khusus per-tab (sessionStorage — aman dipanggil di
  // http/https/file; gagal diam saja → slot hanya hidup selama sesi DOM).
  function slotLoad(key) {
    try {
      var raw = window.sessionStorage.getItem(SLOT_PREFIX + key);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (o && typeof o.x === 'number' && isFinite(o.x) && typeof o.y === 'number' && isFinite(o.y)) return o;
    } catch (e) {}
    return null;
  }
  function slotSave(key, o) {
    try { window.sessionStorage.setItem(SLOT_PREFIX + key, JSON.stringify(o)); } catch (e) {}
  }
  function slotClear(key) {
    try { window.sessionStorage.removeItem(SLOT_PREFIX + key); } catch (e) {}
  }

  function layout() {
    try {
      var items = [];
      reg.forEach(function (h) {
        try { if (h && typeof h.visible === 'function' && !h.visible()) return; } catch (e) { return; }
        if (h) items.push(h);
      });
      items.sort(function (a, b) {
        var ka = KIND_ORDER[a.kind] != null ? KIND_ORDER[a.kind] : 9;
        var kb = KIND_ORDER[b.kind] != null ? KIND_ORDER[b.kind] : 9;
        if (ka !== kb) return ka - kb;
        var ta = a.t || 0, tb = b.t || 0;
        if (ta !== tb) return ta - tb;
        return (a.seq || 0) - (b.seq || 0);
      });
      var vw = (typeof window.innerWidth === 'number' && window.innerWidth) || 1024;
      var vh = (typeof window.innerHeight === 'number' && window.innerHeight) || 768;

      // v3.24.5: pisahkan widget ber-slot khusus (hasil drag user) dari
      // widget deretan. Slot khusus dipasang duluan; deretan kemudian
      // mengalir seperti biasa tapi MENGHINDARI kotak slot (didorong ke
      // bawah slot, wrap kolom bila meluber) — hasil akhir tetap rapi.
      var customs = [];
      var flow = [];
      for (var s = 0; s < items.length; s++) {
        var hs = items[s];
        if (hs.custom) customs.push(hs); else flow.push(hs);
      }
      var cRects = [];
      for (var c = 0; c < customs.length; c++) {
        var hc = customs[c];
        var wc = num(hc.width, 320), hhc = num(hc.height, 260);
        var xc = Math.max(MINX, Math.min(vw - RIGHT - wc, hc.custom.x - sidebarW));
        var yc = Math.max(TOP, Math.min(Math.max(TOP, vh - FLOOR - hhc), hc.custom.y));
        try { if (typeof hc.place === 'function') hc.place(xc, yc); } catch (e) {}
        cRects.push({ x: xc, y: yc, w: wc, h: hhc });
      }
      function avoid(x, y, w, hh) {
        // dorong ke bawah selama masih menabrak slot khusus (batas loop anti infinite)
        for (var g = 0; g < 32; g++) {
          var hit = -1;
          for (var r = 0; r < cRects.length; r++) {
            var R = cRects[r];
            if (x < R.x + R.w + GAP && x + w > R.x - GAP && y < R.y + R.h + GAP && y + hh > R.y - GAP) { hit = r; break; }
          }
          if (hit < 0) break;
          y = cRects[hit].y + cRects[hit].h + GAP;
        }
        return y;
      }

      var col = 0, y = TOP, colMaxW = 0;
      for (var i = 0; i < flow.length; i++) {
        var h = flow[i];
        var w = num(h.width, 320);
        var hh = num(h.height, 260);
        // wrap ke kolom baru hanya kalau kolom ini sudah berisi (y > TOP)
        // — floater setinggi layar tetap mendapat tempat di kolom pertama.
        if (y > TOP && y + hh > vh - FLOOR) { col += 1; y = TOP; colMaxW = 0; }
        var xRight = vw - RIGHT - sidebarW - col * COLSTEP;
        var x = Math.max(MINX, xRight - w); // rapat kanan per kolom
        if (customs.length) y = avoid(x, y, w, hh); // v3.24.5: hindari slot drag
        if (w > colMaxW) colMaxW = w;
        try { if (typeof h.place === 'function') h.place(x, y); } catch (e) {}
        y += hh + GAP;
      }
    } catch (e) {}
  }

  // v3.23.4: geser deretan saat sidebar buka. w = lebar sidebar (+ jeda);
  // w <= 0 / bukan angka berarti sidebar tertutup → kembali mepet kanan.
  function setSidebar(w) {
    var v = (typeof w === 'number' && isFinite(w) && w > 0) ? Math.min(w, 4000) : 0;
    if (v === sidebarW) return;
    sidebarW = v;
    layout();
  }

  // v3.23.5: ISOLASI KEYBOARD — potong propagasi keyboard/input yang
  // berasal dari DI DALAM sebuah floater supaya tidak "bocor" ke handler
  // document/window milik halaman (spasi pause video, '/' buka pencarian
  // situs, dsb). Listener dipasang di HOST fase bubble: semua handler
  // internal RecallFox (di dalam shadow root, di bawah host) tetap jalan,
  // aksi bawaan browser tidak tersentuh (TIDAK ada preventDefault) — hanya
  // propagasi ke ATAS host yang dipotong. Idempoten per elemen.
  function isolateKeys(el) {
    if (!el || el.__rfKeyIso) return;
    el.__rfKeyIso = true;
    var isoTypes = ['keydown', 'keyup', 'keypress', 'input', 'beforeinput',
      'compositionstart', 'compositionupdate', 'compositionend'];
    for (var ii = 0; ii < isoTypes.length; ii++) {
      (function (type) {
        try {
          el.addEventListener(type, function (ev) {
            try { ev.stopPropagation(); } catch (e) {}
          }, false);
        } catch (e) {}
      })(isoTypes[ii]);
    }
  }

  var dock = {
    GAP: GAP, TOP: TOP, RIGHT: RIGHT, COLSTEP: COLSTEP,
    register: function (h) {
      if (!h || !h.key) return;
      if (h.seq == null) h.seq = ++seq;
      var slot = slotLoad(h.key);            // v3.24.5: pulihkan slot hasil drag
      if (slot) h.custom = slot;
      reg.set(h.key, h);
      layout();
    },
    unregister: function (key) { if (reg.delete(key)) { slotClear(key); layout(); } },
    // v3.24.5: simpan posisi hasil drop sebagai slot khusus widget ini.
    // x dinormalisasi (+sidebarW) supaya hubungan dengan deretan tetap benar
    // saat sidebar dibuka/ditutup (slot ikut bergeser seperti kolom).
    pinCustom: function (key, x, y) {
      var h = reg.get(key);
      if (!h) return;
      var px = (typeof x === 'number' && isFinite(x)) ? Math.round(x) : 0;
      var py = (typeof y === 'number' && isFinite(y)) ? Math.round(y) : 0;
      h.custom = { x: px + sidebarW, y: py };
      slotSave(key, h.custom);
      layout();
    },
    // v3.24.5: klik ganda header — lepas slot, kembali ke deretan.
    clearCustom: function (key) {
      var h = reg.get(key);
      if (h && h.custom) { delete h.custom; slotClear(key); }
      layout();
    },
    layout: layout,
    setSidebar: setSidebar,
    isolateKeys: isolateKeys,
    sidebarW: function () { return sidebarW; },
    has: function (key) { return reg.has(key); },
    // v3.24.8: POPUP AWARE — isPopup() = verdict terkini (heuristik dulu,
    // lalu digantikan verdict background); whenPopupVerdict(cb) = callback
    // sekali saat verdict final tiba (false = tab/jendela normal).
    isPopup: function () { return popupVerdict; },
    whenPopupVerdict: function (cb) {
      if (typeof cb !== 'function') return;
      if (popupKnown) { try { cb(popupVerdict); } catch (e) {} } else popupCbs.push(cb);
    },
  };
  try { if (typeof window.addEventListener === 'function') window.addEventListener('resize', function () { layout(); }); } catch (e) {}
  window.__RFDock = dock;
})();
