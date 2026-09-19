/**
 * FYLO Core — Global State
 * Single source of truth for app-level state.
 * Module-specific state lives inside each feature module.
 *
 * Rules:
 * - Only app-global state goes here (current page, files list, settings)
 * - Reader/Editor/Camera internal state lives in their own modules
 * - State is read via getters, written via explicit setters/actions
 */

import { bus, EVENTS } from './eventBus.js';
import { PAGES, STORAGE_LIMIT_BYTES } from './constants.js';

// ── Internal state (not exported directly) ────────────────────────────────────
const _state = {
  page:     PAGES.HOME,
  prevPage: PAGES.HOME,
  files:    [],           // { id, name, size, type, blob, date, favorite }
  favorites: new Set(),
  bookmarks: {},          // { fileId: Set<pageNumber> }
  settings: {
    darkMode:      true,
    reduceMotion:  false,
    storageLimit:  STORAGE_LIMIT_BYTES,
    defaultTool:   'select',
    language:      'en',
  },
  db:           null,
  installPrompt: null,
};

// ── Public read API ────────────────────────────────────────────────────────────
export const State = {
  get page()        { return _state.page; },
  get prevPage()    { return _state.prevPage; },
  get files()       { return _state.files; },
  get settings()    { return { ..._state.settings }; },
  get db()          { return _state.db; },
  get installPrompt(){ return _state.installPrompt; },

  getBookmarks(fileId)  { return _state.bookmarks[fileId] ?? new Set(); },
  isFavorite(fileId)    { return _state.favorites.has(fileId); },
  getFile(fileId)       { return _state.files.find(f => f.id === fileId) ?? null; },
  getAllFiles()          { return [..._state.files]; },
};

// ── Public write API ───────────────────────────────────────────────────────────
export const Actions = {
  setPage(page, prevPage) {
    _state.prevPage = prevPage ?? _state.page;
    _state.page = page;
  },

  setDB(db) { _state.db = db; },

  setInstallPrompt(prompt) { _state.installPrompt = prompt; },

  // Files
  addFile(file) {
    _state.files.unshift(file);
    bus.emit(EVENTS.FILES_ADDED, { file });
  },
  removeFile(fileId) {
    _state.files = _state.files.filter(f => f.id !== fileId);
    delete _state.bookmarks[fileId];
    _state.favorites.delete(fileId);
    bus.emit(EVENTS.FILES_DELETED, { fileId });
  },
  setFiles(files) { _state.files = files; },
  updateFile(fileId, patch) {
    const idx = _state.files.findIndex(f => f.id === fileId);
    if (idx !== -1) {
      _state.files[idx] = { ..._state.files[idx], ...patch };
      bus.emit(EVENTS.FILES_UPDATED, { file: _state.files[idx] });
    }
  },

  // Favorites
  toggleFavorite(fileId) {
    if (_state.favorites.has(fileId)) _state.favorites.delete(fileId);
    else _state.favorites.add(fileId);
  },

  // Bookmarks
  setBookmarks(fileId, pages) {
    _state.bookmarks[fileId] = new Set(pages);
  },
  toggleBookmark(fileId, page) {
    if (!_state.bookmarks[fileId]) _state.bookmarks[fileId] = new Set();
    const set = _state.bookmarks[fileId];
    if (set.has(page)) set.delete(page);
    else set.add(page);
    return set.has(page);
  },

  // Settings
  updateSettings(patch) {
    Object.assign(_state.settings, patch);
    bus.emit(EVENTS.SETTINGS_CHANGED, { settings: _state.settings });
  },
};
