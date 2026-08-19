// content/annotate.js — Full-screen screenshot annotation editor
// RecallFox v3.11.4 — Annotation tools (arrow, line, rect, ellipse, text, highlight, blur)
//
// Loaded on-demand via browser.scripting.executeScript() when user clicks
// "✏️ Anotasi" in the capture preview modal (overlay.js).
//
// Exposes a single global function:
//   window.__RecallFoxAnnotate__(dataUrl, opts) -> Promise<{
//     dataUrl: string,    // annotated PNG data URL (same dimensions as input)
//     cancelled: boolean  // true if user pressed Esc / Cancel
//   }>
//
// Architecture:
//   - Background image rendered on a <canvas> (offscreen, original)
//   - Annotations drawn on a 2nd <canvas> overlay (live preview)
//   - On "Done": composite annotations onto background canvas → export PNG
//   - Tools: arrow, line, rect, ellipse, text, highlight, blur, pen (freehand)
//   - State: undo/redo stack, current color, stroke width, font size
//
// All UI is injected into a #rf-annotate-overlay div appended to document.body.
// Styles live in content/overlay.css (section "Annotation editor").

(function () {
  if (window.__RecallFoxAnnotateLoaded__) return;
  window.__RecallFoxAnnotateLoaded__ = true;

  // ===== State =====
  let overlayEl = null;
  let bgCanvas = null;       // offscreen, holds original image
  let drawCanvas = null;     // visible, holds live annotations
  let drawCtx = null;
  let previewCanvas = null;  // for current in-progress shape
  let previewCtx = null;
  let imgWidth = 0;
  let imgHeight = 0;
  let displayScale = 1;      // displayScale = displayWidth / imgWidth

  let currentTool = 'arrow';
  let currentColor = '#ef4444';   // red-500 default (most visible)
  let currentStroke = 4;
  let currentFontSize = 18;
  let currentFill = false;         // for rect/ellipse: filled vs outlined

  let drawing = false;
  let startX = 0, startY = 0;
  let lastX = 0, lastY = 0;
  let freehandPath = [];
  let textInputEl = null;

  // Undo/redo stacks of annotation ops
  // Each op = { tool, color, stroke, fontSize, fill, points: [{x,y}], text, x, y, w, h }
  let undoStack = [];
  let redoStack = [];

  // Color palette (matches screenshot annotation standards)
  const COLORS = [
    '#ef4444',  // red
    '#f97316',  // orange
    '#eab308',  // yellow
    '#22c55e',  // green
    '#06b6d4',  // cyan
    '#3b82f6',  // blue
    '#8b5cf6',  // violet
    '#ec4899',  // pink
    '#000000',  // black
    '#ffffff'   // white
  ];

  // ===== Main entry point =====
  window.__RecallFoxAnnotate__ = function (dataUrl, opts = {}) {
    return new Promise((resolve) => {
      _loadImage(dataUrl).then((img) => {
        imgWidth = img.naturalWidth;
        imgHeight = img.naturalHeight;
        _buildUI(img, dataUrl, resolve);
      }).catch((e) => {
        console.warn('[RecallFox/Annotate] Failed to load image:', e);
        resolve({ cancelled: true });
      });
    });
  };

  function _loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  // ===== UI Construction =====
  function _buildUI(img, originalDataUrl, resolve) {
    // Remove any existing overlay
    if (overlayEl) overlayEl.remove();

    overlayEl = document.createElement('div');
    overlayEl.id = 'rf-annotate-overlay';
    overlayEl.className = 'rf-annotate-overlay';

    // Compute display dimensions (fit to viewport, max 90% w/h)
    const maxW = window.innerWidth * 0.92;
    const maxH = window.innerHeight * 0.75;  // leave room for toolbar
    displayScale = Math.min(maxW / imgWidth, maxH / imgHeight, 1);
    const dispW = Math.round(imgWidth * displayScale);
    const dispH = Math.round(imgHeight * displayScale);

    overlayEl.innerHTML = `
      <div class="rf-annotate-modal">
        <div class="rf-annotate-header">
          <span class="rf-annotate-title">✏️ Anotasi Screenshot</span>
          <div class="rf-annotate-tools-group">
            <button class="rf-ann-tool${currentTool === 'arrow' ? ' on' : ''}" data-tool="arrow" title="Panah">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="19" x2="19" y2="5"/><polyline points="9 5 19 5 19 15"/></svg>
            </button>
            <button class="rf-ann-tool${currentTool === 'line' ? ' on' : ''}" data-tool="line" title="Garis">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="19" x2="19" y2="5"/></svg>
            </button>
            <button class="rf-ann-tool${currentTool === 'rect' ? ' on' : ''}" data-tool="rect" title="Kotak">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="6" width="16" height="12" rx="1"/></svg>
            </button>
            <button class="rf-ann-tool${currentTool === 'ellipse' ? ' on' : ''}" data-tool="ellipse" title="Lingkaran">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="12" rx="8" ry="6"/></svg>
            </button>
            <button class="rf-ann-tool${currentTool === 'text' ? ' on' : ''}" data-tool="text" title="Teks">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>
            </button>
            <button class="rf-ann-tool${currentTool === 'highlight' ? ' on' : ''}" data-tool="highlight" title="Highlighter">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>
            </button>
            <button class="rf-ann-tool${currentTool === 'pen' ? ' on' : ''}" data-tool="pen" title="Pena bebas">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg>
            </button>
            <button class="rf-ann-tool${currentTool === 'blur' ? ' on' : ''}" data-tool="blur" title="Blur area">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/></svg>
            </button>
          </div>

          <div class="rf-annotate-colors">
            ${COLORS.map((c, i) => `<button class="rf-ann-color${c === currentColor ? ' on' : ''}" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('')}
            <input type="color" class="rf-ann-color-picker" id="rfAnnColorPicker" value="${currentColor}" title="Warna kustom">
          </div>

          <div class="rf-annotate-stroke">
            <label>Stroke</label>
            <input type="range" id="rfAnnStroke" min="1" max="20" value="${currentStroke}">
            <span id="rfAnnStrokeVal">${currentStroke}px</span>
          </div>

          <div class="rf-annotate-fontsize" id="rfAnnFontRow" style="${currentTool === 'text' ? '' : 'display:none'}">
            <label>Font</label>
            <input type="range" id="rfAnnFont" min="10" max="48" value="${currentFontSize}">
            <span id="rfAnnFontVal">${currentFontSize}px</span>
          </div>

          <div class="rf-annotate-spacer"></div>

          <!-- v3.11.26 (Issue #2): Catatan anotasi — teks penjelas yang ikut saat copy/simpan -->
          <div class="rf-annotate-note" style="display:flex;align-items:center;gap:6px;margin-right:8px">
            <label style="font-size:11px;color:#57534e;white-space:nowrap">📝 Catatan:</label>
            <input type="text" id="rfAnnNote" placeholder="Jelaskan anotasi ini..." style="width:200px;padding:4px 8px;font-size:12px;border:1px solid #d6d3d1;border-radius:6px;background:#fff;color:#1c1917" title="Catatan akan ikut saat copy/simpan">
          </div>

          <div class="rf-annotate-actions">
            <button class="rf-ann-btn rf-ann-btn-ghost" id="rfAnnUndo" title="Undo (Ctrl+Z)" disabled>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
            </button>
            <button class="rf-ann-btn rf-ann-btn-ghost" id="rfAnnRedo" title="Redo (Ctrl+Y)" disabled>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            </button>
            <button class="rf-ann-btn rf-ann-btn-ghost" id="rfAnnClear" title="Hapus semua">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>
            </button>
            <button class="rf-ann-btn rf-ann-btn-ghost" id="rfAnnCancel">Batal</button>
            <button class="rf-ann-btn rf-ann-btn-primary" id="rfAnnDone">✓ Selesai</button>
          </div>
        </div>

        <div class="rf-annotate-canvas-wrap" id="rfAnnCanvasWrap">
          <div class="rf-annotate-canvas-stage" style="width:${dispW}px;height:${dispH}px;">
            <canvas id="rfAnnBgCanvas" width="${imgWidth}" height="${imgHeight}" style="width:${dispW}px;height:${dispH}px;"></canvas>
            <canvas id="rfAnnDrawCanvas" width="${imgWidth}" height="${imgHeight}" style="width:${dispW}px;height:${dispH}px;"></canvas>
            <canvas id="rfAnnPreviewCanvas" width="${imgWidth}" height="${imgHeight}" style="width:${dispW}px;height:${dispH}px;"></canvas>
          </div>
        </div>

        <div class="rf-annotate-hint">
          <kbd>Esc</kbd> batal · <kbd>Ctrl+Z</kbd> undo · <kbd>Ctrl+Y</kbd> redo · <kbd>Enter</kbd> selesai teks
        </div>
      </div>
    `;
    document.body.appendChild(overlayEl);

    // ===== Setup canvases =====
    bgCanvas = document.getElementById('rfAnnBgCanvas');
    const bgCtx = bgCanvas.getContext('2d');
    bgCtx.drawImage(img, 0, 0);

    drawCanvas = document.getElementById('rfAnnDrawCanvas');
    drawCtx = drawCanvas.getContext('2d');

    previewCanvas = document.getElementById('rfAnnPreviewCanvas');
    previewCtx = previewCanvas.getContext('2d');

    // ===== Bind tool buttons =====
    overlayEl.querySelectorAll('.rf-ann-tool').forEach(btn => {
      btn.addEventListener('click', () => {
        currentTool = btn.dataset.tool;
        overlayEl.querySelectorAll('.rf-ann-tool').forEach(b => b.classList.toggle('on', b === btn));
        // Show font size row only for text tool
        document.getElementById('rfAnnFontRow').style.display = currentTool === 'text' ? '' : 'none';
        // Cursor per tool
        previewCanvas.style.cursor = currentTool === 'text' ? 'text' : 'crosshair';
        _commitTextInput(); // commit pending text if any
      });
    });

    // ===== Bind color buttons =====
    overlayEl.querySelectorAll('.rf-ann-color').forEach(btn => {
      btn.addEventListener('click', () => {
        currentColor = btn.dataset.color;
        overlayEl.querySelectorAll('.rf-ann-color').forEach(b => b.classList.toggle('on', b === btn));
        document.getElementById('rfAnnColorPicker').value = currentColor;
      });
    });
    document.getElementById('rfAnnColorPicker').addEventListener('input', (e) => {
      currentColor = e.target.value;
      overlayEl.querySelectorAll('.rf-ann-color').forEach(b => b.classList.remove('on'));
    });

    // ===== Bind stroke slider =====
    const strokeSlider = document.getElementById('rfAnnStroke');
    const strokeVal = document.getElementById('rfAnnStrokeVal');
    strokeSlider.addEventListener('input', (e) => {
      currentStroke = parseInt(e.target.value, 10);
      strokeVal.textContent = currentStroke + 'px';
    });

    // ===== Bind font slider =====
    const fontSlider = document.getElementById('rfAnnFont');
    const fontVal = document.getElementById('rfAnnFontVal');
    fontSlider.addEventListener('input', (e) => {
      currentFontSize = parseInt(e.target.value, 10);
      fontVal.textContent = currentFontSize + 'px';
    });

    // ===== Bind action buttons =====
    document.getElementById('rfAnnUndo').addEventListener('click', _undo);
    document.getElementById('rfAnnRedo').addEventListener('click', _redo);
    document.getElementById('rfAnnClear').addEventListener('click', _clearAll);
    document.getElementById('rfAnnCancel').addEventListener('click', () => _close(resolve, true));
    document.getElementById('rfAnnDone').addEventListener('click', () => _finish(resolve));

    // ===== Canvas pointer events =====
    previewCanvas.addEventListener('pointerdown', (e) => _onPointerDown(e));
    previewCanvas.addEventListener('pointermove', (e) => _onPointerMove(e));
    previewCanvas.addEventListener('pointerup', (e) => _onPointerUp(e));
    previewCanvas.addEventListener('pointercancel', (e) => _onPointerUp(e));
    previewCanvas.style.cursor = 'crosshair';

    // ===== Keyboard shortcuts =====
    const keyHandler = (e) => {
      if (e.key === 'Escape') {
        if (textInputEl) {
          _commitTextInput();
        } else {
          _close(resolve, true);
        }
        e.preventDefault();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        _undo();
        e.preventDefault();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) {
        _redo();
        e.preventDefault();
      } else if (e.key === 'Enter' && textInputEl) {
        _commitTextInput();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', keyHandler, true);
    overlayEl._keyHandler = keyHandler;

    _updateUndoRedoButtons();
  }

  // ===== Pointer handlers =====
  function _getPos(e) {
    const rect = previewCanvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / displayScale;
    const y = (e.clientY - rect.top) / displayScale;
    return { x: Math.round(x), y: Math.round(y) };
  }

  function _onPointerDown(e) {
    if (drawing) return;
    e.preventDefault();
    try { previewCanvas.setPointerCapture(e.pointerId); } catch (err) {}

    const pos = _getPos(e);
    startX = pos.x; startY = pos.y;
    lastX = pos.x; lastY = pos.y;

    if (currentTool === 'text') {
      _startTextInput(pos.x, pos.y);
      return;
    }

    drawing = true;
    freehandPath = [pos];

    if (currentTool === 'pen' || currentTool === 'highlight') {
      // Start drawing immediately on pen/highlight
      _drawOp({
        tool: currentTool,
        color: currentColor,
        stroke: currentStroke,
        points: [pos]
      }, drawCtx);
    }
  }

  function _onPointerMove(e) {
    if (!drawing) return;
    e.preventDefault();
    const pos = _getPos(e);

    if (currentTool === 'pen' || currentTool === 'highlight') {
      // Freehand: draw segment directly on drawCtx
      freehandPath.push(pos);
      _drawOp({
        tool: currentTool,
        color: currentColor,
        stroke: currentStroke,
        points: freehandPath.slice(-2)
      }, drawCtx);
      lastX = pos.x; lastY = pos.y;
    } else {
      // Shape preview: clear preview canvas, draw current shape
      _clearCanvas(previewCtx);
      const op = {
        tool: currentTool,
        color: currentColor,
        stroke: currentStroke,
        fontSize: currentFontSize,
        x: startX, y: startY,
        x2: pos.x, y2: pos.y
      };
      _drawOp(op, previewCtx);
    }
  }

  function _onPointerUp(e) {
    if (!drawing) return;
    drawing = false;
    try { previewCanvas.releasePointerCapture(e.pointerId); } catch (err) {}

    const pos = _getPos(e);

    if (currentTool === 'pen' || currentTool === 'highlight') {
      // Commit freehand path
      if (freehandPath.length > 1) {
        const op = {
          tool: currentTool,
          color: currentColor,
          stroke: currentStroke,
          points: [...freehandPath]
        };
        undoStack.push(op);
        redoStack = [];
        _updateUndoRedoButtons();
      }
      freehandPath = [];
    } else {
      // Commit shape from preview
      _clearCanvas(previewCtx);
      const dx = Math.abs(pos.x - startX);
      const dy = Math.abs(pos.y - startY);
      if (dx > 2 || dy > 2) {
        const op = {
          tool: currentTool,
          color: currentColor,
          stroke: currentStroke,
          fontSize: currentFontSize,
          x: startX, y: startY,
          x2: pos.x, y2: pos.y
        };
        undoStack.push(op);
        redoStack = [];
        _redrawAll();
        _updateUndoRedoButtons();
      }
    }
  }

  // ===== Text input overlay =====
  function _startTextInput(x, y) {
    _commitTextInput(); // commit any pending
    const dispX = x * displayScale;
    const dispY = y * displayScale;
    const wrap = overlayEl.querySelector('.rf-annotate-canvas-stage');
    const stageRect = wrap.getBoundingClientRect();

    textInputEl = document.createElement('textarea');
    textInputEl.className = 'rf-ann-text-input';
    textInputEl.style.left = (stageRect.left + dispX) + 'px';
    textInputEl.style.top = (stageRect.top + dispY) + 'px';
    textInputEl.style.color = currentColor;
    textInputEl.style.fontSize = (currentFontSize * displayScale) + 'px';
    textInputEl.style.fontFamily = 'Inter, -apple-system, system-ui, sans-serif';
    textInputEl.style.fontWeight = '600';
    textInputEl.placeholder = 'Ketik teks… (Enter untuk simpan)';
    textInputEl.rows = 1;
    document.body.appendChild(textInputEl);
    setTimeout(() => textInputEl.focus(), 10);

    // Auto-resize
    textInputEl.addEventListener('input', () => {
      textInputEl.style.height = 'auto';
      textInputEl.style.height = textInputEl.scrollHeight + 'px';
      textInputEl.style.width = 'auto';
      // Approximate width: char count × font size × 0.6
      const minW = 80;
      const estW = Math.max(minW, textInputEl.value.length * currentFontSize * displayScale * 0.6);
      textInputEl.style.width = estW + 'px';
    });

    // Enter commits (Shift+Enter for newline)
    textInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        _commitTextInput();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        textInputEl.remove();
        textInputEl = null;
      }
    });
  }

  function _commitTextInput() {
    if (!textInputEl) return;
    const text = textInputEl.value;
    const stageRect = overlayEl.querySelector('.rf-annotate-canvas-stage').getBoundingClientRect();
    const left = parseFloat(textInputEl.style.left);
    const top = parseFloat(textInputEl.style.top);
    const x = Math.round((left - stageRect.left) / displayScale);
    const y = Math.round((top - stageRect.top) / displayScale);

    textInputEl.remove();
    textInputEl = null;

    if (text.trim()) {
      undoStack.push({
        tool: 'text',
        color: currentColor,
        fontSize: currentFontSize,
        text: text,
        x: x,
        y: y + currentFontSize  // baseline align
      });
      redoStack = [];
      _redrawAll();
      _updateUndoRedoButtons();
    }
  }

  // ===== Drawing operations =====
  function _drawOp(op, ctx) {
    ctx.save();
    ctx.strokeStyle = op.color;
    ctx.fillStyle = op.color;
    ctx.lineWidth = op.stroke || 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (op.tool === 'arrow') {
      _drawArrow(ctx, op.x, op.y, op.x2, op.y2, op.stroke || 4);
    } else if (op.tool === 'line') {
      ctx.beginPath();
      ctx.moveTo(op.x, op.y);
      ctx.lineTo(op.x2, op.y2);
      ctx.stroke();
    } else if (op.tool === 'rect') {
      const x = Math.min(op.x, op.x2);
      const y = Math.min(op.y, op.y2);
      const w = Math.abs(op.x2 - op.x);
      const h = Math.abs(op.y2 - op.y);
      ctx.strokeRect(x, y, w, h);
    } else if (op.tool === 'ellipse') {
      const cx = (op.x + op.x2) / 2;
      const cy = (op.y + op.y2) / 2;
      const rx = Math.max(1, Math.abs(op.x2 - op.x) / 2);
      const ry = Math.max(1, Math.abs(op.y2 - op.y) / 2);
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, 2 * Math.PI);
      ctx.stroke();
    } else if (op.tool === 'text') {
      ctx.font = '600 ' + (op.fontSize || 18) + 'px Inter, -apple-system, system-ui, sans-serif';
      ctx.textBaseline = 'alphabetic';
      const lines = op.text.split('\n');
      lines.forEach((line, i) => {
        ctx.fillText(line, op.x, op.y + i * (op.fontSize || 18) * 1.2);
      });
    } else if (op.tool === 'highlight') {
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = (op.stroke || 4) * 3;
      if (op.points && op.points.length > 1) {
        ctx.beginPath();
        ctx.moveTo(op.points[0].x, op.points[0].y);
        for (let i = 1; i < op.points.length; i++) {
          ctx.lineTo(op.points[i].x, op.points[i].y);
        }
        ctx.stroke();
      }
    } else if (op.tool === 'pen') {
      if (op.points && op.points.length > 1) {
        ctx.beginPath();
        ctx.moveTo(op.points[0].x, op.points[0].y);
        for (let i = 1; i < op.points.length; i++) {
          ctx.lineTo(op.points[i].x, op.points[i].y);
        }
        ctx.stroke();
      } else if (op.points && op.points.length === 1) {
        // dot
        ctx.beginPath();
        ctx.arc(op.points[0].x, op.points[0].y, (op.stroke || 4) / 2, 0, 2 * Math.PI);
        ctx.fill();
      }
    } else if (op.tool === 'blur') {
      _drawBlur(ctx, op.x, op.y, op.x2, op.y2);
    }
    ctx.restore();
  }

  function _drawArrow(ctx, x1, y1, x2, y2, strokeWidth) {
    const headLen = Math.max(12, strokeWidth * 3);
    const angle = Math.atan2(y2 - y1, x2 - x1);
    // Line
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    // Arrowhead (filled triangle)
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(
      x2 - headLen * Math.cos(angle - Math.PI / 6),
      y2 - headLen * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
      x2 - headLen * Math.cos(angle + Math.PI / 6),
      y2 - headLen * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();
  }

  function _drawBlur(ctx, x1, y1, x2, y2) {
    // Blur: sample background canvas region, downscale + upscale + paste
    const sx = Math.min(x1, x2);
    const sy = Math.min(y1, y2);
    const sw = Math.max(1, Math.abs(x2 - x1));
    const sh = Math.max(1, Math.abs(y2 - y1));

    // Get image data from background canvas
    const bgCtx = bgCanvas.getContext('2d');
    const sourceData = bgCtx.getImageData(sx, sy, sw, sh);

    // Downscale to ~10% then back up (poor man's blur, no external libs)
    const tmp = document.createElement('canvas');
    tmp.width = Math.max(1, Math.round(sw / 10));
    tmp.height = Math.max(1, Math.round(sh / 10));
    const tmpCtx = tmp.getContext('2d');
    tmpCtx.putImageData(sourceData, 0, 0);
    // ImageData doesn't interpolate on putImageData; use drawImage instead
    const tmp2 = document.createElement('canvas');
    tmp2.width = sw;
    tmp2.height = sh;
    const tmp2Ctx = tmp2.getContext('2d');
    tmp2Ctx.imageSmoothingEnabled = true;
    tmp2Ctx.imageSmoothingQuality = 'low';
    // First, copy source to tmp via drawImage (use bgCanvas directly)
    tmpCtx.clearRect(0, 0, tmp.width, tmp.height);
    tmpCtx.drawImage(bgCanvas, sx, sy, sw, sh, 0, 0, tmp.width, tmp.height);
    tmp2Ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, 0, 0, sw, sh);

    // Apply slight pixelation effect (optional: stack blur via CSS filter)
    ctx.filter = 'blur(2px)';
    ctx.drawImage(tmp2, sx, sy);
    ctx.filter = 'none';
  }

  // ===== Redraw all ops =====
  function _clearCanvas(ctx) {
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }

  function _redrawAll() {
    _clearCanvas(drawCtx);
    _clearCanvas(previewCtx);
    for (const op of undoStack) {
      _drawOp(op, drawCtx);
    }
  }

  // ===== Undo / Redo =====
  function _undo() {
    if (!undoStack.length) return;
    _commitTextInput();
    redoStack.push(undoStack.pop());
    _redrawAll();
    _updateUndoRedoButtons();
  }

  function _redo() {
    if (!redoStack.length) return;
    undoStack.push(redoStack.pop());
    _redrawAll();
    _updateUndoRedoButtons();
  }

  function _clearAll() {
    if (!undoStack.length) return;
    if (!confirm('Hapus semua anotasi?')) return;
    redoStack = undoStack.slice();
    undoStack = [];
    _redrawAll();
    _updateUndoRedoButtons();
  }

  function _updateUndoRedoButtons() {
    const undoBtn = document.getElementById('rfAnnUndo');
    const redoBtn = document.getElementById('rfAnnRedo');
    if (undoBtn) undoBtn.disabled = undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = redoStack.length === 0;
  }

  // ===== Finish / Close =====
  function _finish(resolve) {
    _commitTextInput();
    // Composite: bgCanvas + drawCanvas → merged canvas → export PNG
    const merged = document.createElement('canvas');
    merged.width = imgWidth;
    merged.height = imgHeight;
    const mctx = merged.getContext('2d');
    mctx.drawImage(bgCanvas, 0, 0);
    mctx.drawImage(drawCanvas, 0, 0);
    const dataUrl = merged.toDataURL('image/png');
    // v3.11.26 (Issue #2): Ambil catatan dari input field
    const noteEl = document.getElementById('rfAnnNote');
    const note = noteEl ? noteEl.value.trim() : '';
    _close(resolve, false, dataUrl, note);
  }

  function _close(resolve, cancelled, dataUrl, note) {
    // Cleanup
    if (overlayEl._keyHandler) {
      document.removeEventListener('keydown', overlayEl._keyHandler, true);
    }
    if (textInputEl) { textInputEl.remove(); textInputEl = null; }
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
    bgCanvas = null;
    drawCanvas = null;
    previewCanvas = null;
    drawCtx = null;
    previewCtx = null;
    undoStack = [];
    redoStack = [];
    resolve({ cancelled: !!cancelled, dataUrl: dataUrl || null, note: note || '' });
  }
})();
