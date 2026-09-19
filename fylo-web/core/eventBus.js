/**
 * FYLO Core — Event Bus
 * Decoupled pub/sub so modules never import each other directly.
 *
 * Usage:
 *   import { bus } from '../core/eventBus.js';
 *   bus.on('reader:pageChanged', ({ page }) => ...);
 *   bus.emit('reader:pageChanged', { page: 3 });
 *   bus.off('reader:pageChanged', handler);
 *
 * Event naming convention:  module:action
 * Examples:
 *   reader:opened, reader:closed, reader:pageChanged, reader:zoomed
 *   editor:saved, editor:annotationAdded, editor:undone
 *   files:added, files:deleted
 *   storage:error
 *   app:navTo, app:toast, app:themeChanged
 */

class EventBus {
  constructor() {
    this._handlers = new Map(); // event → Set<handler>
  }

  on(event, handler) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(handler);
    // Return unsubscribe fn for easy cleanup
    return () => this.off(event, handler);
  }

  once(event, handler) {
    const wrapper = (data) => { handler(data); this.off(event, wrapper); };
    return this.on(event, wrapper);
  }

  off(event, handler) {
    this._handlers.get(event)?.delete(handler);
  }

  emit(event, data) {
    this._handlers.get(event)?.forEach(h => {
      try { h(data); }
      catch (e) { console.error(`[EventBus] Handler error on "${event}":`, e); }
    });
  }

  clear(event) {
    if (event) this._handlers.delete(event);
    else this._handlers.clear();
  }
}

export const bus = new EventBus();

// ── Typed event name constants (prevents typos) ───────────────────────────────
export const EVENTS = {
  // App
  APP_NAV:           'app:nav',
  APP_TOAST:         'app:toast',
  APP_THEME_CHANGED: 'app:themeChanged',
  APP_READY:         'app:ready',

  // Files
  FILES_ADDED:       'files:added',
  FILES_DELETED:     'files:deleted',
  FILES_UPDATED:     'files:updated',

  // Reader
  READER_OPENED:       'reader:opened',
  READER_CLOSED:       'reader:closed',
  READER_PAGE_CHANGED: 'reader:pageChanged',
  READER_ZOOMED:       'reader:zoomed',
  READER_SEARCH_DONE:  'reader:searchDone',

  // Editor
  EDITOR_OPENED:          'editor:opened',
  EDITOR_CLOSED:          'editor:closed',
  EDITOR_SAVED:           'editor:saved',
  EDITOR_ANNOTATION_ADD:  'editor:annotationAdded',
  EDITOR_ANNOTATION_DEL:  'editor:annotationDeleted',
  EDITOR_UNDONE:          'editor:undone',
  EDITOR_REDONE:          'editor:redone',

  // Storage
  STORAGE_QUOTA_WARNING: 'storage:quotaWarning',
  STORAGE_ERROR:         'storage:error',

  // Camera
  CAMERA_OPENED:  'camera:opened',
  CAMERA_CLOSED:  'camera:closed',
  CAMERA_CAPTURE: 'camera:capture',

  // Settings
  SETTINGS_CHANGED: 'settings:changed',
};
