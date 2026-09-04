/**
 * ============================================================================
 * RecallFox v3.24.9 — pdftool/pdftool.js
 * Logika halaman tab penuh "Urutkan PDF — Klaim BPJS/JKK" (offline-first).
 * ----------------------------------------------------------------------------
 * Dua cara masuk:
 *   A) HANDOFF dari sidebar/popup — job {bytes, name, metas, order, stats}
 *      sudah disimpan di IndexedDB (origin extension) → halaman langsung
 *      menampilkan kondisi "siap unduh" (alur auto), lalu job dihapus.
 *   B) LANGSUNG — buka pdftool.html tanpa job → drop-zone; analisa jalan di
 *      sini setelah berkas dipilih/ditarik.
 *
 * Aksi: geser manual per halaman (drag atau ▲▼), switch DAFTAR ISI (default
 * ON), tombol A-Z (reset urutan), UNDUH "<nama> - SORT A-Z.pdf" (blob →
 * downloads API; fallback anchor). Semua via PDFSortEngine (engine.js).
 * 100% offline — tidak ada permintaan jaringan sama sekali.
 * ============================================================================
 */
(() => {
  'use strict';

  // Shim lintas Chrome/Firefox (tanpa polyfill — file identik kedua repo)
  const RT = globalThis.browser || globalThis.chrome;
  const E = globalThis.PDFSortEngine;

  const DB = 'rf-pdftool', STORE = 'jobs', KEY = 'current';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const state = {
    name: '',
    bytes: null,   // Uint8Array sumber
    metas: null,   // [{index,name,claim}] urutan halaman ASLI
    order: null,   // [index asli] urutan final saat ini
    stats: null,
    busy: false,
    dragIdx: -1,
  };

  // ---------------------------------------------------------------- helpers
  function setWorkerSrc() {
    try {
      if (globalThis.pdfjsLib && RT && RT.runtime && RT.runtime.getURL) {
        globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc = RT.runtime.getURL('vendor/pdf.worker.min.js');
      }
    } catch (e) {
      console.warn('[RecallFox pdftool] workerSrc gagal diset — fallback fake worker', e);
    }
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB gagal dibuka'));
    });
  }

  /** Ambil job handoff lalu LANGSUNG dihapus (privasi; sekali pakai). */
  async function takeJob() {
    const db = await openDb();
    const get = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).get(KEY);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    if (get) {
      await new Promise((resolve) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(KEY);
        tx.oncomplete = resolve;
        tx.onerror = resolve; // hapus gagal pun lanjut (job masih valid)
      });
    }
    db.close();
    return get || null;
  }

  function toBytes(v) {
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (Array.isArray(v)) return new Uint8Array(v);
    return null;
  }

  function showErr(msg) {
    const el = $('#rfErr');
    el.innerHTML = '⚠ ' + esc(msg);
    el.classList.remove('hidden');
    $('#rfEmpty').classList.add('hidden');
    $('#rfReady').classList.add('hidden');
  }

  function clearErr() { $('#rfErr').classList.add('hidden'); }

  function note(elHtml, cls) {
    return '<div class="rf-note ' + (cls || '') + '">' + elHtml + '</div>';
  }

  // ---------------------------------------------------------------- render
  function renderEmpty(stateHtml, cls) {
    clearErr();
    $('#rfReady').classList.add('hidden');
    $('#rfEmpty').classList.remove('hidden');
    $('#rfEmptyState').innerHTML = stateHtml ? note(stateHtml, cls) : '';
  }

  function renderReady() {
    clearErr();
    $('#rfEmpty').classList.add('hidden');
    $('#rfReady').classList.remove('hidden');

    $('#rfFileName').textContent = state.name || 'dokumen.pdf';
    $('#rfOutName').textContent = E.sanitizeName(state.name) + ' - SORT A-Z.pdf';

    const st = state.stats || E.computeStats(state.metas);
    const chips = [
      ['Halaman', st.total, 'var(--text)'],
      ['Pasien', st.uniquePatients, 'var(--green)'],
      ['Multi-klaim', st.multiClaim, st.multiClaim > 0 ? 'var(--violet)' : 'var(--muted)'],
      ['Tak terbaca', st.unread, st.unread > 0 ? 'var(--amber)' : 'var(--muted)'],
    ];
    $('#rfStats').innerHTML = chips.map((c) =>
      '<div class="rf-stat"><div class="k">' + c[0] + '</div><div class="v" style="color:' + c[2] + '">' + c[1] + '</div></div>'
    ).join('');

    renderRows();
  }

  function renderRows() {
    const rowsEl = $('#rfRows');
    const n = state.order.length;
    $('#rfPageCount').textContent = n + ' halaman sumber';
    rowsEl.innerHTML = state.order.map((orig, i) => {
      const m = state.metas[orig] || { name: '', claim: null };
      const unread = !m.name;
      return '<div class="rf-row" draggable="true" data-i="' + i + '">' +
        '<span class="rf-grip" aria-hidden="true">⠿</span>' +
        '<span class="rf-idx">' + (i + 1) + '</span>' +
        '<span class="rf-rname' + (unread ? ' unread' : '') + '" title="' + esc(unread ? E.DISPLAY_UNREAD : m.name) + '">' + esc(unread ? E.DISPLAY_UNREAD : m.name) + '</span>' +
        '<span class="rf-rclaim">' + esc(m.claim || '—') + '</span>' +
        '<span class="rf-rpg" title="Halaman asli dalam berkas sumber">asli #' + (orig + 1) + '</span>' +
        '<span class="rf-mv">' +
          '<button data-mv="up" data-i="' + i + '" title="Naikkan satu posisi" ' + (i === 0 ? 'disabled' : '') + '>▲</button>' +
          '<button data-mv="down" data-i="' + i + '" title="Turunkan satu posisi" ' + (i === n - 1 ? 'disabled' : '') + '>▼</button>' +
        '</span>' +
        '</div>';
    }).join('');
  }

  function moveRow(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= state.order.length) return;
    const [x] = state.order.splice(i, 1);
    state.order.splice(j, 0, x);
    renderRows();
  }

  // ------------------------------------------------------------- analisa
  async function analyzeFile(file) {
    if (state.busy) return;
    if (!file) return;
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (!isPdf) { renderEmpty('Harus berkas PDF (.pdf).', 'err'); return; }

    state.busy = true;
    renderEmpty('⏳ Menganalisa <b>' + esc(file.name) + '</b>… mohon tunggu sebentar.');
    try {
      const buf = await file.arrayBuffer();
      const a = await E.analyzePdf(new Uint8Array(buf));
      state.name = file.name;
      state.bytes = new Uint8Array(buf);
      state.metas = a.metas;
      state.order = [...a.order];
      state.stats = a.stats;
      renderReady();
    } catch (e) {
      console.error('[RecallFox pdftool] analyze:', e);
      renderEmpty(esc(e.message || 'Gagal menganalisa PDF.'), 'err');
    } finally {
      state.busy = false;
    }
  }

  // ------------------------------------------------------------- unduh
  async function rfDownload(blob, fileName) {
    // Jalur utama: downloads API (menghormati folder unduhan + konflik nama)
    try {
      if (RT && RT.downloads && RT.downloads.download) {
        const url = URL.createObjectURL(blob);
        try {
          await RT.downloads.download({ url, filename: fileName, saveAs: false, conflictAction: 'uniquify' });
          return true;
        } finally {
          setTimeout(() => URL.revokeObjectURL(url), 60000);
        }
      }
    } catch (e) {
      console.warn('[RecallFox pdftool] downloads API gagal, fallback anchor:', e);
    }
    // Fallback: anchor download
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return true;
  }

  async function doDownload() {
    if (state.busy) return;
    const btn = $('#rfDownload');
    const box = $('#rfReadyState');
    state.busy = true;
    btn.disabled = true;
    btn.textContent = '⏳ Menyusun PDF…';
    box.innerHTML = '';
    try {
      const r = await E.buildSortedPdf(state.bytes, state.order, state.metas, {
        includeIndex: $('#rfIc').checked,
        fileName: state.name,
      });
      await rfDownload(new Blob([r.bytes], { type: 'application/pdf' }), r.fileName);
      btn.textContent = '✓ Terunduh — ' + r.numPages + ' halaman';
      btn.classList.add('rf-flash-ok');
      box.innerHTML = note('✓ <b>' + esc(r.fileName) + '</b> (' + r.numPages + ' halaman) tersimpan di folder unduhan.', 'ok');
      setTimeout(() => {
        btn.classList.remove('rf-flash-ok');
        btn.textContent = '⬇ Unduh PDF (SORT A-Z)';
        btn.disabled = false;
      }, 2600);
    } catch (e) {
      console.error('[RecallFox pdftool] download:', e);
      btn.textContent = '⬇ Unduh PDF (SORT A-Z)';
      btn.classList.add('rf-flash-err');
      box.innerHTML = note(esc(e.message || 'Gagal menyusun PDF.'), 'err');
      setTimeout(() => {
        btn.classList.remove('rf-flash-err');
        btn.disabled = false;
      }, 1800);
    } finally {
      state.busy = false;
    }
  }

  // ------------------------------------------------------------- drag&drop baris
  function clearDragMarks() {
    $$('#rfRows .rf-row').forEach((r) => r.classList.remove('dragover-top', 'dragover-bottom', 'dragging'));
  }

  function bindRowEvents() {
    const rowsEl = $('#rfRows');

    rowsEl.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-mv]');
      if (!b || b.disabled) return;
      moveRow(Number(b.dataset.i), b.dataset.mv === 'up' ? -1 : 1);
    });

    rowsEl.addEventListener('dragstart', (ev) => {
      const row = ev.target.closest('.rf-row');
      if (!row) return;
      state.dragIdx = Number(row.dataset.i);
      row.classList.add('dragging');
      try { ev.dataTransfer.setData('text/plain', String(state.dragIdx)); } catch (e) { /* abaikan */ }
      ev.dataTransfer.effectAllowed = 'move';
    });

    rowsEl.addEventListener('dragover', (ev) => {
      const row = ev.target.closest('.rf-row');
      if (!row || state.dragIdx < 0) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      const before = ev.clientY < rect.top + rect.height / 2;
      const overIdx = Number(row.dataset.i);
      if (overIdx === state.dragIdx) { clearDragMarks(); return; }
      clearDragMarks();
      row.classList.add(before ? 'dragover-top' : 'dragover-bottom');
      // auto-scroll dekat tepi
      const box = rowsEl.getBoundingClientRect();
      if (ev.clientY < box.top + 28) rowsEl.scrollTop -= 14;
      else if (ev.clientY > box.bottom - 28) rowsEl.scrollTop += 14;
    });

    rowsEl.addEventListener('dragleave', (ev) => {
      if (ev.target && ev.target.closest && ev.target.closest('.rf-row')) {
        ev.target.closest('.rf-row').classList.remove('dragover-top', 'dragover-bottom');
      }
    });

    rowsEl.addEventListener('drop', (ev) => {
      const row = ev.target.closest('.rf-row');
      if (!row || state.dragIdx < 0) return;
      ev.preventDefault();
      const rect = row.getBoundingClientRect();
      const before = ev.clientY < rect.top + rect.height / 2;
      let target = Number(row.dataset.i);
      const from = state.dragIdx;
      state.dragIdx = -1;
      clearDragMarks();
      if (!before && target < state.order.length - 1) target++;
      if (target === from) return;
      const [x] = state.order.splice(from, 1);
      state.order.splice(from < target ? target - 1 : target, 0, x);
      renderRows();
    });

    rowsEl.addEventListener('dragend', () => {
      state.dragIdx = -1;
      clearDragMarks();
    });
  }

  // ------------------------------------------------------------- init
  async function init() {
    setWorkerSrc();
    bindRowEvents();

    // Drop-zone & picker (dipakai kondisi awal maupun "pilih berkas lain")
    const input = $('#rfFile');
    $('#rfPick').addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      if (f) analyzeFile(f);
      input.value = '';
    });
    const drop = $('#rfEmpty');
    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (ev) => {
      ev.preventDefault(); ev.stopPropagation(); drop.classList.add('over');
    }));
    ['dragleave', 'dragend'].forEach((t) => drop.addEventListener(t, (ev) => {
      ev.preventDefault(); drop.classList.remove('over');
    }));
    drop.addEventListener('drop', (ev) => {
      ev.preventDefault(); ev.stopPropagation(); drop.classList.remove('over');
      const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (f) analyzeFile(f);
    });

    // Aksi utama
    $('#rfDownload').addEventListener('click', doDownload);
    $('#rfReset').addEventListener('click', () => {
      if (!state.metas) return;
      state.order = E.metasToOrder(E.sortPageMetas(state.metas));
      renderRows();
    });
    $('#rfAnother').addEventListener('click', () => {
      state.name = ''; state.bytes = null; state.metas = null; state.order = null; state.stats = null;
      renderEmpty('');
    });

    // Handoff dari sidebar/popup (alur auto siap-unduh)
    try {
      const job = await takeJob();
      if (job && toBytes(job.bytes) && Array.isArray(job.order) && Array.isArray(job.metas)) {
        const bytes = toBytes(job.bytes);
        if (bytes.length > 0 && job.order.length === job.metas.length) {
          state.name = job.name || 'dokumen.pdf';
          state.bytes = bytes;
          state.metas = job.metas;
          state.order = [...job.order];
          state.stats = job.stats || null;
          // Anti data-basi: analisa ulang berkas yang sama — hasil segar yang
          // dipakai (mesin sama + berkas sama = hasil identik dgn sidebar).
          try {
            const check = await E.analyzePdf(bytes);
            if (check.metas.length === job.metas.length) {
              state.metas = check.metas;
              state.stats = check.stats;
              state.order = [...check.order];
            }
          } catch (e) {
            // re-analisa gagal → tetap pakai data handoff (build tervalidasi lagi oleh engine)
            console.warn('[RecallFox pdftool] re-analisa handoff gagal — pakai data handoff', e);
          }
          renderReady();
          return;
        }
      }
    } catch (e) {
      console.warn('[RecallFox pdftool] handoff:', e);
    }

    renderEmpty('');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
