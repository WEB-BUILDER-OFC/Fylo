/**
 * FYLO Core — Router
 * Hash-based SPA router. Works on GitHub Pages, Netlify, any HTTP server.
 * Does NOT require file:// (ES6 modules don't work from file:// anyway).
 *
 * Usage:
 *   Router.register(PAGES.READER, { el, onEnter, onLeave })
 *   Router.go(PAGES.READER)
 *   import { Router } from '../../core/router.js'
 *
 * Feature modules call Router.go() directly — no _navTo() shim needed.
 */

import { bus, EVENTS } from './eventBus.js';
import { Actions, State } from './state.js';
import { PAGES } from './constants.js';
import { createLogger } from './logger.js';

const log = createLogger('Router');

const _routes  = new Map();  // name → { el, onEnter, onLeave }
let   _current = null;
let   _notifying = false;   // true only while APP_NAV is being delivered (synchronously)

export const Router = {
  register(name, opts) {
    if (!opts.el) log.warn(`Route "${name}" registered without el`);
    _routes.set(name, opts);
  },

  async go(page, pushHistory = true) {
    if (!_routes.has(page)) { log.warn(`Unknown route: "${page}"`); return; }
    // Re-entrancy guard: a handler of the APP_NAV notification must never bounce
    // straight back into go() for the page we are already on. Without this, any
    // listener that calls go() from APP_NAV creates an endless go() -> emit -> go()
    // microtask chain that starves the event loop (no paint, no timers) — the
    // permanent splash freeze. Navigating to a *different* page is still allowed.
    if (_notifying && page === _current) {
      log.warn(`Ignored re-entrant navigation to "${page}" from APP_NAV handler`);
      return;
    }
    const prev = _current;

    // Leave current page
    if (prev && _routes.has(prev)) {
      const { el, onLeave } = _routes.get(prev);
      try { await onLeave?.(); } catch (e) { log.error('onLeave:', e); }
      el?.classList.remove('active');
    }

    // Enter new page
    const { el, onEnter } = _routes.get(page);
    el?.classList.add('active');
    try { await onEnter?.(); } catch (e) { log.error('onEnter:', e); }

    // History (wrapped — fails silently in sandboxed iframes)
    if (pushHistory) {
      try { history.pushState({ page }, '', `#${page}`); } catch { /* ignore */ }
    }

    Actions.setPage(page, prev ?? page);
    _current = page;
    _notifying = true;
    try { bus.emit(EVENTS.APP_NAV, { page, prev }); }
    finally { _notifying = false; }
    log.debug(`→ ${page}`);
  },

  get current() { return _current; },

  /** Call once at app start */
  init() {
    window.addEventListener('popstate', e => {
      const page = e.state?.page ?? PAGES.HOME;
      Router.go(page, false);
    });
    const hash  = location.hash.slice(1);
    const start = Object.values(PAGES).includes(hash) ? hash : PAGES.HOME;
    Router.go(start, false);
  },
};
