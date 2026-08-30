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

  function num(fn, d) {
    try { var v = fn(); return (typeof v === 'number' && v > 0) ? v : d; } catch (e) { return d; }
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
      var col = 0, y = TOP, colMaxW = 0;
      for (var i = 0; i < items.length; i++) {
        var h = items[i];
        var w = num(h.width, 320);
        var hh = num(h.height, 260);
        // wrap ke kolom baru hanya kalau kolom ini sudah berisi (y > TOP)
        // — floater setinggi layar tetap mendapat tempat di kolom pertama.
        if (y > TOP && y + hh > vh - FLOOR) { col += 1; y = TOP; colMaxW = 0; }
        var xRight = vw - RIGHT - sidebarW - col * COLSTEP;
        var x = Math.max(MINX, xRight - w); // rapat kanan per kolom
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
      reg.set(h.key, h);
      layout();
    },
    unregister: function (key) { if (reg.delete(key)) layout(); },
    layout: layout,
    setSidebar: setSidebar,
    isolateKeys: isolateKeys,
    sidebarW: function () { return sidebarW; },
    has: function (key) { return reg.has(key); },
  };
  try { if (typeof window.addEventListener === 'function') window.addEventListener('resize', function () { layout(); }); } catch (e) {}
  window.__RFDock = dock;
})();
