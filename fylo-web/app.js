/**
 * FYLO — Application Bootstrap (app.js)
 *
 * Responsibility: wire everything together. No business logic here.
 *
 * Sequence:
 *   1. initStorage()
 *   2. Libs.init()         — PDF.js + PDF-Lib (non-blocking)
 *   3. SettingsModule.load()
 *   4. Load persisted files
 *   5. Register routes
 *   6. Each module wires its own toolbar
 *   7. Wire global events (nav, search, drag-drop, keyboard, resize)
 *   8. Init gesture engine
 *   9. Router.init()
 *  10. Render initial UI
 *  11. Hide splash
 *
 * Cross-module events use bus.emit(EVENTS.*).
 * Features never import each other — only core/* and their own files.
 */

import { bus, EVENTS }    from './core/eventBus.js';
import { State, Actions } from './core/state.js';
import { initStorage, FileStorage, SettingsStorage } from './core/storage.js';
import { Libs }           from './core/libs.js';
import { Router }         from './core/router.js';
import { PAGES }          from './core/constants.js';
import { toast, openModal, closeModal, ripple } from './core/ui.js';
import { createLogger }   from './core/logger.js';

// Feature entry points (each module owns its own internals)
import { ReaderModule, wireReaderToolbar, initGestureEngine }
  from './features/reader/index.js';
import { EditorModule, wireEditorToolbar }
  from './features/editor/index.js';
import { CameraModule }  from './features/camera/index.js';
import { ToolsModule }   from './features/tools/index.js';
import { FilesModule }   from './features/files/index.js';
import { SettingsModule } from './features/settings/index.js';

// FORENSIC: This line runs only after ALL 14 ES module imports resolve.
// If BOOT-04 never appears in the overlay, the crash happens during module loading.
window._D && window._D('BOOT-04: app.js executing — all imports resolved');

const log = createLogger('App');

// ── Extended EVENTS (app-level, not in core eventBus) ────────────────────────
// These are declared here to avoid circular imports.
const APP_EVENTS = {
  READER_OPEN_REQUEST: 'reader:openRequest',
  EDITOR_OPEN_REQUEST: 'editor:openRequest',
};

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function bootstrap() {
  log.info(`FYLO starting`);
  window._D && window._D('BOOT-05: bootstrap() entered');

  // 1. Storage
  try {
    window._D && window._D('BOOT-06: initStorage starting');
    await initStorage();
    log.info('Storage ready');
    window._D && window._D('BOOT-07: Storage ready');
  } catch (e) {
    window._D && window._D('BOOT-07F: Storage FAILED: '+e.message);
    log.error('Storage init failed:', e);
    toast('Storage unavailable — files will not persist');
  }

  // 2. Libraries — load in background, features await internally
  window._D && window._D('BOOT-08: Libs.init() starting (fire-and-forget)');
  Libs.init();

  // 3. Settings
  window._D && window._D('BOOT-09: SettingsModule.load starting');
  await SettingsModule.load();
  window._D && window._D('BOOT-10: SettingsModule.load done');

  // 4. Persisted files
  window._D && window._D('BOOT-11: _loadPersistedFiles starting');
  await _loadPersistedFiles();
  window._D && window._D('BOOT-12: _loadPersistedFiles done');

  // 5. Register routes
  window._D && window._D('BOOT-13: sync steps starting');
  _registerRoutes();

  // 6. Each module wires its own toolbar (no app.js DOM refs for features)
  wireReaderToolbar();
  wireEditorToolbar();
  SettingsModule.init();

  // 7. Global events
  _wireGlobalEvents();

  // 8. Gesture engine (reader touch/mouse/wheel)
  initGestureEngine(ReaderModule);

  // 9. Router
  Router.init();

  // 10. Initial render
  FilesModule.wireFileTabs();
  FilesModule.renderFiles();
  FilesModule.updateStorage();
  FilesModule.renderRecent();
  ToolsModule.renderCategories();
  ToolsModule.wireInputs();

  // 11. Splash
  window._D && window._D('BOOT-14: _hideSplash() calling');
  _hideSplash();

  // 12. Android bridge — only active when window.AndroidBridge is injected by WebView
  if (typeof window.AndroidBridge !== 'undefined') {
    // Expose the event bus so MainActivity can deliver files via intent
    window.fyloEventBus = bus;
    // Install the back button handler
    import('./core/android-bridge.js').then(({ installBackHandler }) => {
      installBackHandler();
    }).catch(e => log.warn('Android bridge setup failed:', e));
    // Wire camera close request (back button closes camera)
    bus.on('camera:closeRequest', () => {
      import('./features/camera/index.js').then(({ CameraModule }) => CameraModule.close());
    });
    log.info('Android bridge active');
  }

  bus.emit(EVENTS.APP_READY, {});
  log.info('Bootstrap complete');
}

// ── Load persisted files ──────────────────────────────────────────────────────
async function _loadPersistedFiles() {
  try {
    const files = await FileStorage.loadAll();
    if (files?.length) {
      Actions.setFiles(files.reverse());
      log.info(`Loaded ${files.length} persisted files`);
    }
  } catch (e) { log.warn('Could not load persisted files:', e); }

  // Load persisted favorites
  try {
    const favIds = await SettingsStorage.load('favorites');
    if (Array.isArray(favIds)) {
      favIds.forEach(id => {
        if (State.files.find(f => f.id === id)) Actions.toggleFavorite(id);
      });
      log.info(`Loaded ${favIds.length} favorites`);
    }
  } catch(e) { log.warn('Could not load favorites:', e); }
}

// ── Route registration ────────────────────────────────────────────────────────
function _registerRoutes() {
  Router.register(PAGES.HOME, {
    el: document.getElementById('page-home'),
  });
  Router.register(PAGES.FILES, {
    el:      document.getElementById('page-files'),
    onEnter: () => { FilesModule.renderFiles(); FilesModule.updateStorage(); },
  });
  Router.register(PAGES.TOOLS, {
    el:      document.getElementById('page-tools'),
    onEnter: () => ToolsModule.renderCategories(),
  });
  Router.register(PAGES.SETTINGS, {
    el:      document.getElementById('page-settings'),
    onEnter: () => SettingsModule.render(),
  });
  Router.register(PAGES.READER, {
    el: document.getElementById('page-reader'),
    onLeave: () => ReaderModule.close(),
  });
  Router.register(PAGES.EDITOR, {
    el: document.getElementById('page-editor'),
  });
  // Camera is a fullscreen modal overlay, not a routed page — no registration needed.
}

// ── Global event wiring ───────────────────────────────────────────────────────
function _wireGlobalEvents() {

  // ── Navigation bar ──────────────────────────────────────────────────────
  document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    item.addEventListener('click', e => { ripple(e, item); Router.go(item.dataset.page); });
  });
  document.getElementById('back-btn')?.addEventListener('click',
    () => Router.go(State.prevPage || PAGES.HOME));

  // ── Cross-module open requests ──────────────────────────────────────────
  bus.on(APP_EVENTS.READER_OPEN_REQUEST, ({ fileId })       => ReaderModule.open(fileId));
  bus.on(APP_EVENTS.EDITOR_OPEN_REQUEST, ({ fileId, tool }) => EditorModule.open(fileId, tool));

  // ── File input / drag-drop ──────────────────────────────────────────────
  const fileInput = document.getElementById('file-input');
  fileInput?.addEventListener('change', e => {
    const files = [...e.target.files];
    if (files.length) FilesModule.handleFiles(files);
    e.target.value = '';
  });
  document.getElementById('fab')?.addEventListener('click',
    () => fileInput?.click());

  // Drag-drop on the files page and home page
  const dropTargets = [
    document.getElementById('page-files'),
    document.getElementById('page-home'),
  ].filter(Boolean);
  dropTargets.forEach(zone => {
    zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', e => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over'); });
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('drag-over');
      const files = [...e.dataTransfer.files].filter(f =>
        f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
      );
      if (files.length) FilesModule.handleFiles(files);
    });
  });

  // ── Global search ───────────────────────────────────────────────────────
  const searchBtn   = document.getElementById('search-btn');
  const searchBar   = document.getElementById('search-overlay');
  const searchInput = document.getElementById('search-input');
  const searchClose = document.getElementById('search-close');

  searchBtn?.addEventListener('click',  () => {
    searchBar?.classList.remove('hidden');
    searchBar?.classList.add('show');
    searchInput?.focus();
  });
  searchClose?.addEventListener('click', () => {
    searchBar?.classList.remove('show');
    searchBar?.classList.add('hidden');
    if (searchInput) searchInput.value = '';
    const resultsEl = document.getElementById('search-results');
    if (resultsEl) resultsEl.innerHTML = '';
    if (State.page === PAGES.FILES) FilesModule.renderFiles();
  });
  searchInput?.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) {
      const resultsEl = document.getElementById('search-results');
      if (resultsEl) resultsEl.innerHTML = '';
      return;
    }
    const filtered = State.files.filter(f => f.name.toLowerCase().includes(q));
    // Show results in search-results panel
    const resultsEl = document.getElementById('search-results');
    if (resultsEl) {
      if (!filtered.length) {
        resultsEl.innerHTML = '<p style="padding:12px;color:var(--text-tertiary);font-size:13px">No PDFs found</p>';
      } else {
        resultsEl.innerHTML = filtered.map(f => `
          <div class="search-result-item" data-file-id="${f.id}" style="padding:10px 16px;display:flex;align-items:center;gap:10px;cursor:pointer;border-bottom:1px solid var(--border)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <span style="font-size:13px;color:var(--text-primary);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${f.name.replace(/</g,'&lt;')}</span>
          </div>`).join('');
        resultsEl.querySelectorAll('[data-file-id]').forEach(el => {
          el.addEventListener('click', () => {
            searchBar?.classList.remove('show');
            searchBar?.classList.add('hidden');
            if (searchInput) searchInput.value = '';
            resultsEl.innerHTML = '';
            bus.emit('reader:openRequest', { fileId: el.dataset.fileId });
          });
        });
      }
    }
    // Also filter Files page if we're on it
    if (State.page === PAGES.FILES) {
      bus.emit('files:renderFiltered', { files: filtered });
    }
  });

  // ── Modal ────────────────────────────────────────────────────────────────
  document.getElementById('modal-close')?.addEventListener('click', closeModal);
  document.getElementById('modal-overlay')?.addEventListener('click', e => {
    if (e.target.id === 'modal-overlay') closeModal();
  });

  // ── Menu button — toggles reader sidebar when in reader ──────────────────
  document.getElementById('menu-btn')?.addEventListener('click', () => {
    if (State.page === PAGES.READER) {
      document.getElementById('reader-sidebar')?.classList.toggle('open');
    }
  });

  // ── Nav: aria-current for screen readers ─────────────────────────────────
  document.querySelectorAll('[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-page]').forEach(b => b.removeAttribute('aria-current'));
      btn.setAttribute('aria-current', 'page');
    });
  });

  // Camera is opened via the home quick-action 'scan' button (data-home-action="scan")
  // and via bus.emit('camera:openRequest')
  bus.on('camera:openRequest', () => CameraModule.open());

  // ── Keyboard shortcuts ───────────────────────────────────────────────────
  document.addEventListener('keydown', e => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    const mod    = e.ctrlKey || e.metaKey;

    if (State.page === PAGES.READER && !typing) {
      if (e.key === '+' || e.key === '=') { e.preventDefault(); ReaderModule.zoomIn(); }
      if (e.key === '-')                  { e.preventDefault(); ReaderModule.zoomOut(); }
      if (e.key === 'Escape')             { e.preventDefault(); Router.go(PAGES.FILES); }
      if (e.key === 'ArrowLeft')          { e.preventDefault(); ReaderModule.goToPage(ReaderModule.currentPage - 1); }
      if (e.key === 'ArrowRight')         { e.preventDefault(); ReaderModule.goToPage(ReaderModule.currentPage + 1); }
    }

    if (State.page === PAGES.EDITOR) {
      if (mod && e.key === 'z')                        { e.preventDefault(); EditorModule.undo(); }
      if (mod && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); EditorModule.redo(); }
      if (!typing && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault(); EditorModule.deleteSelected();
      }
    }

    if (e.key === 'Escape') {
      const overlay = document.getElementById('modal-overlay');
      if (overlay?.classList.contains('show')) closeModal();
    }
  });

  // ── Window resize ────────────────────────────────────────────────────────
  let _resizeTimer, _lastW = 0, _lastH = 0;
  window.addEventListener('resize', () => {
    if (State.page !== PAGES.READER) return;
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      const ww = window.innerWidth, wh = window.innerHeight;
      const major = Math.abs(ww - _lastW) > 80 || Math.abs(wh - _lastH) > 80;
      _lastW = ww; _lastH = wh;
      const rs = ReaderModule._rs;
      if (!rs?.canvasWidth) return;
      if (major) {
        // Recalculate fit scale on orientation change
        const wrap = document.getElementById('reader-canvas-wrap');
        const fit  = Math.max(0.4, Math.min(3, Math.min(
          (wrap.clientWidth  - 16) / rs.canvasWidth,
          (wrap.clientHeight - 16) / rs.canvasHeight,
        )));
        rs.scale = fit; rs._scale = 1;
        ReaderModule.renderPage(rs.currentPage, true);
      } else {
        ReaderModule._clampTransform?.();
        ReaderModule._applyTransform?.();
      }
    }, 200);
  });

  // ── Bus: APP_NAV (modules use bus.emit instead of Router.go) ────────────
  bus.on(EVENTS.APP_NAV, ({ page, push }) => Router.go(page, push ?? true));

  log.info('Global events wired');
}

// ── Splash hide ───────────────────────────────────────────────────────────────
function _hideSplash() {
  window._D && window._D('BOOT-15: _hideSplash() entered');
  const splash = document.getElementById('splash');
  const app    = document.getElementById('app');
  if (!splash) return;
  splash.classList.add('fade-out');
  splash.style.pointerEvents = 'none';
  setTimeout(() => {
    splash.classList.add('hidden');
    splash.style.display = 'none';
    app?.classList.remove('hidden');
    app?.classList.add('show');
  }, 500);
}

// ── Error safety net ──────────────────────────────────────────────────────────
window.onerror = () => _hideSplash();
window.addEventListener('unhandledrejection', () => _hideSplash());

// ── Service Worker registration ───────────────────────────────────────────────
// FORENSIC: SW registers unconditionally on Android WebView (no AndroidBridge guard)
// This means SW cache.addAll(27 files) runs concurrently with page bootstrap
window._D && window._D('BOOT-SW: serviceWorker check — in nav: '+ ('serviceWorker' in navigator));
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' })
      .then(reg => {
        log.info('Service Worker registered:', reg.scope);
        // Listen for SW update messages
        navigator.serviceWorker.addEventListener('message', e => {
          if (e.data?.type === 'SW_UPDATED') {
            bus.emit('sw:updateAvailable', {});
          }
        });
      })
      .catch(e => log.warn('Service Worker registration failed:', e));
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────
// type="module" scripts are deferred automatically — DOM is ready here.
bootstrap();
