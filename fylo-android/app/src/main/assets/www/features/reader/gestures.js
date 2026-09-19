/**
 * FYLO Feature — Reader Gesture Engine
 *
 * Handles all touch, mouse and wheel interactions for the PDF reader.
 * Completely separated from render logic for testability.
 *
 * Behaviors:
 *   - Pinch-to-zoom: anchored to finger midpoint (focal-point math)
 *   - Two-finger pan during pinch
 *   - Single-finger pan: instant 1:1 follow, no dead zones
 *   - Pan inertia/momentum after finger lift
 *   - Page swipe (at fit view only, detected at touchend)
 *   - Double-tap zoom into tapped point
 *   - Mouse drag with inertia
 *   - Ctrl+Wheel / trackpad pinch zoom
 */

import { createLogger } from '../../core/logger.js';
import {
  SWIPE_THRESHOLD_PX, DOUBLE_TAP_DELAY_MS,
  INERTIA_DECAY, MOUSE_INERTIA_DECAY,
} from '../../core/constants.js';

const log = createLogger('Reader.Gestures');

export function initGestureEngine(ReaderModule) {
  const { _rs: rs, _dom: dom } = ReaderModule;
  const {
    _applyTransform, _clampTransform, _zoomAt,
    _animateToVisual, updateZoomDisplay,
    prevPage, nextPage, handleDoubleTap, renderPage,
  } = ReaderModule;

  let _g        = null;
  let _lastTap  = { t: 0, x: 0, y: 0 };
  let _ivx = 0, _ivy = 0, _iRaf = null;

  // ── Helpers ──────────────────────────────────────────────────────────────
  function _wrapPt(cx, cy) {
    const rc = dom.wrap.getBoundingClientRect();
    return { x: cx - rc.left, y: cy - rc.top };
  }
  function _tdist(a, b) { return Math.hypot(a.clientX-b.clientX, a.clientY-b.clientY); }
  function _tmid(a, b)  { return { x:(a.clientX+b.clientX)/2, y:(a.clientY+b.clientY)/2 }; }

  // ── Inertia ───────────────────────────────────────────────────────────────
  function _stopInertia() {
    if (_iRaf) { cancelAnimationFrame(_iRaf); _iRaf = null; }
    _ivx = _ivy = 0;
  }
  function _startInertia() {
    _stopInertia();
    const decay = INERTIA_DECAY;
    (function tick() {
      if (Math.abs(_ivx) < 0.3 && Math.abs(_ivy) < 0.3) { _iRaf = null; return; }
      rs._tx += _ivx; rs._ty += _ivy; _ivx *= decay; _ivy *= decay;
      _clampTransform(); _applyTransform();
      _iRaf = requestAnimationFrame(tick);
    })();
  }

  const wrap = dom.wrap;

  // ── Touch ─────────────────────────────────────────────────────────────────
  wrap.addEventListener('touchstart', e => {
    if (!rs.pdf) return;
    _stopInertia();
    if (rs._zoomRaf) { cancelAnimationFrame(rs._zoomRaf); rs._zoomRaf = null; }
    e.preventDefault();

    if (e.touches.length >= 2) {
      const t1 = e.touches[0], t2 = e.touches[1];
      const m = _tmid(t1, t2); const fp = _wrapPt(m.x, m.y);
      _g = { mode:'pinch', d0:_tdist(t1,t2), s0:rs._scale,
             tx0:rs._tx, ty0:rs._ty, fx:fp.x, fy:fp.y, lmx:m.x, lmy:m.y };
    } else {
      const t = e.touches[0]; _ivx = _ivy = 0;
      _g = { mode:'pan', lx:t.clientX, ly:t.clientY,
             sx:t.clientX, sy:t.clientY, st:Date.now(), moved:false };
    }
  }, { passive: false });

  wrap.addEventListener('touchmove', e => {
    if (!_g || !rs.pdf) return;
    e.preventDefault();

    if (_g.mode === 'pinch' && e.touches.length >= 2) {
      const t1 = e.touches[0], t2 = e.touches[1];
      const d = _tdist(t1, t2); const m = _tmid(t1, t2);
      let ns = _g.s0 * (d / _g.d0);
      const vis = rs.scale * ns;
      if (vis > 5) ns = 5 / rs.scale;
      if (vis < 0.2) ns = 0.2 / rs.scale;
      // Focal-point zoom
      const r = ns / _g.s0;
      rs._tx = _g.fx - (_g.fx - _g.tx0) * r;
      rs._ty = _g.fy - (_g.fy - _g.ty0) * r;
      rs._scale = ns;
      // Two-finger pan
      rs._tx += m.x - _g.lmx; rs._ty += m.y - _g.lmy;
      _g.lmx = m.x; _g.lmy = m.y;
      _clampTransform(); _applyTransform(); updateZoomDisplay();

    } else if (_g.mode === 'pan' && e.touches.length === 1) {
      const t = e.touches[0];
      const dx = t.clientX - _g.lx, dy = t.clientY - _g.ly;
      _g.lx = t.clientX; _g.ly = t.clientY;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) _g.moved = true;
      _ivx = dx * 0.5 + _ivx * 0.5; _ivy = dy * 0.5 + _ivy * 0.5;
      rs._tx += dx; rs._ty += dy;
      _clampTransform(); _applyTransform();
    }
  }, { passive: false });

  wrap.addEventListener('touchend', e => {
    if (!_g) return;

    if (_g.mode === 'pinch') {
      _clampTransform(); _applyTransform(); updateZoomDisplay();
      if (e.touches.length === 1) {
        const t = e.touches[0]; _ivx = _ivy = 0;
        _g = { mode:'pan', lx:t.clientX, ly:t.clientY,
               sx:t.clientX, sy:t.clientY, st:Date.now(), moved:false };
        return;
      }
      _g = null;
      clearTimeout(rs._renderTimer);
      rs._renderTimer = setTimeout(() => {
        if (!rs.pdf) return;
        const ns = Math.max(0.3, Math.min(5, rs.scale * rs._scale));
        rs.scale = ns; rs._scale = 1;
        renderPage(rs.currentPage, true);
      }, 180);
      return;
    }

    const t         = e.changedTouches[0];
    const totalDx   = t.clientX - _g.sx, totalDy = t.clientY - _g.sy;
    const dt        = Date.now() - _g.st;
    const vis       = rs.scale * rs._scale;

    // Page swipe
    if (vis <= 1.08 && dt < 400 && Math.abs(totalDx) > SWIPE_THRESHOLD_PX
        && Math.abs(totalDx) > Math.abs(totalDy) * 2.5) {
      _ivx = _ivy = 0; _g = null;
      if (totalDx > 0) prevPage(); else nextPage();
      return;
    }

    if (vis > 1.08) _startInertia(); else { _ivx = _ivy = 0; }

    // Double-tap
    if (!_g.moved && e.changedTouches.length === 1) {
      const now = Date.now(), dtap = now - _lastTap.t;
      const ddx = Math.abs(t.clientX - _lastTap.x), ddy = Math.abs(t.clientY - _lastTap.y);
      if (dtap > 30 && dtap < DOUBLE_TAP_DELAY_MS && ddx < 40 && ddy < 40) {
        const fp = _wrapPt(t.clientX, t.clientY);
        handleDoubleTap(fp.x, fp.y); _lastTap.t = 0; _g = null; return;
      }
      _lastTap = { t: now, x: t.clientX, y: t.clientY };
    }
    _g = null;
  }, { passive: false });

  wrap.addEventListener('touchcancel', () => { _stopInertia(); _g = null; }, { passive: true });

  // ── Mouse ─────────────────────────────────────────────────────────────────
  let _mp = null, _mvx = 0, _mvy = 0, _mRaf = null;
  function _stopMI() { if (_mRaf) { cancelAnimationFrame(_mRaf); _mRaf = null; } _mvx = _mvy = 0; }
  function _startMI() {
    _stopMI(); const d = MOUSE_INERTIA_DECAY;
    (function tick() {
      if (Math.abs(_mvx) < 0.3 && Math.abs(_mvy) < 0.3) { _mRaf = null; return; }
      rs._tx += _mvx; rs._ty += _mvy; _mvx *= d; _mvy *= d;
      _clampTransform(); _applyTransform(); _mRaf = requestAnimationFrame(tick);
    })();
  }

  wrap.addEventListener('mousedown', e => {
    if (!rs.pdf || e.button !== 0) return;
    _stopMI();
    if (rs._zoomRaf) { cancelAnimationFrame(rs._zoomRaf); rs._zoomRaf = null; }
    e.preventDefault();
    _mp = { lx: e.clientX, ly: e.clientY }; _mvx = _mvy = 0;
    wrap.classList.add('grabbing');
  });

  window.addEventListener('mousemove', e => {
    if (!_mp) return;
    const dx = e.clientX - _mp.lx, dy = e.clientY - _mp.ly;
    _mp.lx = e.clientX; _mp.ly = e.clientY;
    _mvx = dx*0.5 + _mvx*0.5; _mvy = dy*0.5 + _mvy*0.5;
    rs._tx += dx; rs._ty += dy;
    _clampTransform(); _applyTransform();
  });

  window.addEventListener('mouseup', () => {
    if (!_mp) return; _mp = null;
    wrap.classList.remove('grabbing'); _startMI();
  });

  // ── Wheel / trackpad pinch ────────────────────────────────────────────────
  wrap.addEventListener('wheel', e => {
    if (!rs.pdf) return;
    e.preventDefault(); _stopInertia(); _stopMI();
    const fp = _wrapPt(e.clientX, e.clientY);
    const factor = Math.pow(0.998, -e.deltaY * (e.deltaMode === 1 ? 15 : 1));
    const ns = Math.max(0.2/rs.scale, Math.min(5/rs.scale, rs._scale * factor));
    _zoomAt(ns, fp.x, fp.y); _applyTransform(); updateZoomDisplay();
    clearTimeout(rs._renderTimer);
    rs._renderTimer = setTimeout(() => {
      if (!rs.pdf) return;
      const ns2 = Math.max(0.3, Math.min(5, rs.scale * rs._scale));
      rs.scale = ns2; rs._scale = 1;
      renderPage(rs.currentPage, true);
    }, 250);
  }, { passive: false });

  // ── Zoom chip ─────────────────────────────────────────────────────────────
  const chip = document.getElementById('reader-zoom-level');
  if (chip) {
    chip.style.cursor = 'pointer';
    chip.title = 'Click to reset zoom';
    chip.addEventListener('click', () => { if (rs.pdf) _animateToVisual(rs.scale); });
  }

  log.info('Gesture engine initialised');
}
