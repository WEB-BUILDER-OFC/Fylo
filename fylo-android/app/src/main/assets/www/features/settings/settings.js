/**
 * FYLO Feature — Settings
 *
 * Owns: settings UI rendering, reading/writing user preferences,
 *       theme switching, reduce-motion, PWA install prompt.
 *
 * Public API:
 *   SettingsModule.init()   — wire events, init PWA (call once at startup)
 *   SettingsModule.load()   — load persisted settings and apply
 *   SettingsModule.render() — sync UI toggles to current State
 */

import { bus, EVENTS } from '../../core/eventBus.js';
import { State, Actions } from '../../core/state.js';
import { SettingsStorage, storage } from '../../core/storage.js';
import { toast, downloadBlob, openModal, closeModal, formatFileSize } from '../../core/ui.js';
import { Router } from '../../core/router.js';
import { PAGES, APP_VERSION, DB_STORES } from '../../core/constants.js';
import { buildZip } from '../../core/zip.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger('Settings');

// ── Load saved settings ───────────────────────────────────────────────────────
export async function loadSettings() {
  try {
    const dark   = await SettingsStorage.load('darkMode');
    const motion = await SettingsStorage.load('reduceMotion');
    Actions.updateSettings({
      darkMode:     dark   ?? true,
      reduceMotion: motion ?? false,
    });
    _applyTheme(State.settings.darkMode);
    _applyReduceMotion(State.settings.reduceMotion);
  } catch(e) { log.warn('Failed to load settings:', e); }
}

// ── Theme ─────────────────────────────────────────────────────────────────────
function _applyTheme(dark) {
  document.documentElement.classList.toggle('light-mode', !dark);
}

// ── Reduce Motion ─────────────────────────────────────────────────────────────
function _applyReduceMotion(enabled) {
  document.documentElement.classList.toggle('reduce-motion', enabled);
}

// ── Render settings page ──────────────────────────────────────────────────────
export function renderSettings() {
  const s = State.settings;
  const darkToggle   = document.getElementById('dark-mode-toggle');
  const motionToggle = document.getElementById('reduce-motion-toggle');
  if (darkToggle)   darkToggle.checked   = s.darkMode;
  if (motionToggle) motionToggle.checked = s.reduceMotion;

  _renderVersion();

  // Sync storage meter
  bus.emit('files:updateStorage');
}

// Shows what is really installed: the web layer version, plus the APK's own version when running in the app.
function _renderVersion() {
  const el = document.getElementById('app-version');
  if (!el) return;
  let text = `FYLO ${APP_VERSION}`;
  try {
    if (window.AndroidBridge && typeof window.AndroidBridge.getAppVersion === 'function') {
      const v = JSON.parse(window.AndroidBridge.getAppVersion() || '{}');
      if (v.versionName) text += ` · app ${v.versionName} (build ${v.versionCode})`;
    }
  } catch (_) { /* version info is cosmetic */ }
  el.textContent = text;
}

// ── PWA install ───────────────────────────────────────────────────────────────
export function initPWA() {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    Actions.setInstallPrompt(e);
    const prompt = document.getElementById('install-prompt');
    if (prompt) prompt.classList.remove('hidden');
  });
  window.addEventListener('appinstalled', () => {
    const prompt = document.getElementById('install-prompt');
    if (prompt) prompt.classList.add('hidden');
    Actions.setInstallPrompt(null);
    toast('FYLO installed — open from your home screen!');
  });
}

// ── Clear cache ───────────────────────────────────────────────────────────────
// Removes ONLY disposable data: browser/service-worker caches, and (Android) temporary share/export files and the
// WebView HTTP cache. Saved PDFs, bookmarks, favorites and settings live in IndexedDB and are never touched.
let _clearing = false;
async function _clearCache() {
  if (_clearing) return;
  _clearing = true;
  try {
    let caches_removed = 0, tempFiles = 0, tempBytes = 0;
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      caches_removed = keys.length;
    }
    if (window.AndroidBridge && typeof window.AndroidBridge.clearTempFiles === 'function') {
      try {
        const r = JSON.parse(window.AndroidBridge.clearTempFiles() || '{}');
        tempFiles = r.count || 0; tempBytes = r.freedBytes || 0;
      } catch (e) { log.warn('clearTempFiles failed:', e); }
    }
    if (tempFiles > 0)            toast(`Cache cleared — ${tempFiles} temporary file${tempFiles === 1 ? '' : 's'} removed (${formatFileSize(tempBytes)} freed). Your PDFs and settings are untouched.`, 5000);
    else if (caches_removed > 0)  toast('Cache cleared. Your PDFs and settings are untouched.', 4000);
    else                          toast('Nothing to clear — no temporary data was stored.', 4000);
  } catch (e) {
    log.error('Clear cache failed:', e);
    toast('Could not clear the cache');
  } finally { _clearing = false; }
}

// ── Export data ───────────────────────────────────────────────────────────────
// Produces ONE real backup file: fylo-backup-YYYY-MM-DD.zip containing
//   fylo-backup.json   settings, favorites, bookmarks and the list of files (with whether each PDF is included)
//   files/<name>.pdf   the saved PDFs themselves, up to a total size limit (bridge transfers are held in memory)
// Anything left out is listed in the JSON and in the message — never silently dropped.
const EXPORT_PDF_BYTES_LIMIT = 48 * 1024 * 1024;
let _exporting = false;

function _safeEntryName(name, used) {
  let base = String(name || 'document.pdf').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'document.pdf';
  if (!/\.pdf$/i.test(base)) base += '.pdf';
  let candidate = base, n = 1;
  while (used.has(candidate.toLowerCase())) { n++; candidate = base.replace(/\.pdf$/i, '') + ` (${n}).pdf`; }
  used.add(candidate.toLowerCase());
  return candidate;
}

async function _collectBackup() {
  const favorites = (await SettingsStorage.load('favorites')) || [];
  const bookmarks = ((await storage.getAll(DB_STORES.BOOKMARKS)) || []).map(b => ({ fileId: b.id, pages: b.pages || [] }));
  const settings  = { darkMode: State.settings.darkMode, reduceMotion: State.settings.reduceMotion };
  return { favorites, bookmarks, settings };
}

async function _exportData() {
  if (_exporting) return;
  _exporting = true;
  toast('Preparing backup…');
  try {
    const { favorites, bookmarks, settings } = await _collectBackup();
    const used = new Set(['fylo-backup.json']);
    const entries = [];
    const fileIndex = [];
    let total = 0, included = 0, skippedTooBig = 0, skippedMissing = 0;

    for (const f of State.files) {
      const rec = { id: f.id, name: f.name, size: f.size, lastModified: f.lastModified ?? null, addedAt: f.date ?? null, favorite: favorites.includes(f.id), included: false };
      const blob = f.blob;
      if (!blob || !blob.size) { skippedMissing++; rec.reason = 'file data not available'; }
      else if (total + blob.size > EXPORT_PDF_BYTES_LIMIT) { skippedTooBig++; rec.reason = 'over the backup size limit'; }
      else {
        const entryName = 'files/' + _safeEntryName(f.name, used);
        entries.push({ name: entryName, data: new Uint8Array(await blob.arrayBuffer()) });
        total += blob.size; included++;
        rec.included = true; rec.path = entryName;
      }
      fileIndex.push(rec);
    }

    const manifest = {
      app: 'FYLO', appVersion: APP_VERSION, exportedAt: new Date().toISOString(),
      settings, favorites, bookmarks,
      files: fileIndex,
      summary: { filesTotal: State.files.length, pdfsIncluded: included, pdfsNotIncluded: skippedTooBig + skippedMissing, bookmarkedDocuments: bookmarks.length },
    };
    entries.unshift({ name: 'fylo-backup.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });

    const zip  = buildZip(entries);
    const date = new Date().toISOString().slice(0, 10);
    const name = `fylo-backup-${date}.zip`;
    const r = await downloadBlob(zip, name);
    if (!r.ok) return;                                       // downloadBlob already told the user why

    const left = skippedTooBig + skippedMissing;
    const html = `<p>Backup <strong>${name}</strong> (${formatFileSize(zip.size)}) saved${r.path ? ' to <strong>' + r.path.replace(/</g, '&lt;') + '</strong>' : ''}.</p>
      <p style="color:var(--text-secondary);font-size:13px">${included} PDF${included === 1 ? '' : 's'}, ${bookmarks.length} bookmarked document${bookmarks.length === 1 ? '' : 's'}, ${favorites.length} favorite${favorites.length === 1 ? '' : 's'} and your settings.${
        left ? ` <strong>${left} PDF${left === 1 ? ' was' : 's were'} not included</strong> (${skippedTooBig ? skippedTooBig + ' over the ' + formatFileSize(EXPORT_PDF_BYTES_LIMIT) + ' limit' : ''}${skippedTooBig && skippedMissing ? ', ' : ''}${skippedMissing ? skippedMissing + ' without stored data' : ''}); they are listed in fylo-backup.json.` : ''}</p>`;
    const canShare = !!(window.AndroidBridge && typeof window.AndroidBridge.shareFile === 'function');
    openModal('Backup saved', html,
      `${canShare ? '<button type="button" class="btn btn-secondary" id="export-share">Share</button>' : ''}<button type="button" class="btn btn-primary" id="export-done">Done</button>`);
    document.getElementById('export-done')?.addEventListener('click', closeModal);
    document.getElementById('export-share')?.addEventListener('click', async () => {
      try { const { androidShareBlob } = await import('../../core/android-bridge.js'); androidShareBlob(zip, name); }
      catch (e) { toast('Could not open the share sheet'); }
    });
  } catch (e) {
    log.error('Export failed:', e);
    toast('Export failed: ' + (e.message || e), 5000);
  } finally { _exporting = false; }
}

// ── Event wiring (called once at startup) ─────────────────────────────────────
export function wireSettingsEvents() {
  // Theme toggle — HTML id: dark-mode-toggle
  const darkToggle = document.getElementById('dark-mode-toggle');
  darkToggle?.removeAttribute('disabled');
  darkToggle?.addEventListener('change', async () => {
    Actions.updateSettings({ darkMode: darkToggle.checked });
    _applyTheme(darkToggle.checked);
    try { await SettingsStorage.save('darkMode', darkToggle.checked); } catch(e) {}
  });

  // Reduce motion toggle — HTML id: reduce-motion-toggle
  const motionToggle = document.getElementById('reduce-motion-toggle');
  // Remove the 'disabled' attribute the HTML has by default
  motionToggle?.removeAttribute('disabled');
  motionToggle?.addEventListener('change', async () => {
    Actions.updateSettings({ reduceMotion: motionToggle.checked });
    _applyReduceMotion(motionToggle.checked);
    try { await SettingsStorage.save('reduceMotion', motionToggle.checked); } catch(e) {}
  });

  // Install prompt — HTML id: install-btn, install-close
  document.getElementById('install-btn')?.addEventListener('click', async () => {
    const prompt = State.installPrompt;
    if (!prompt) return;
    prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === 'accepted') {
      Actions.setInstallPrompt(null);
      document.getElementById('install-prompt')?.classList.add('hidden');
    }
  });
  document.getElementById('install-close')?.addEventListener('click', () => {
    document.getElementById('install-prompt')?.classList.add('hidden');
  });

  // Clear cache
  document.getElementById('setting-clear-cache')?.addEventListener('click', _clearCache);

  // Export data
  document.getElementById('setting-export-data')?.addEventListener('click', _exportData);

  // Service Worker update notification
  bus.on('sw:updateAvailable', () => {
    // Inside the Android app the web assets ship with the APK, so a service-worker "update"
    // carries nothing the user needs — and a forced reload would interrupt camera/permission
    // dialogs and open screens. Only the browser/PWA build self-reloads.
    if (typeof window.AndroidBridge !== 'undefined') return;
    toast('Update available — reloading shortly', 6000);
    setTimeout(() => window.location.reload(), 6000);
  });
}

export const SettingsModule = {
  init:   () => { initPWA(); wireSettingsEvents(); },
  load:   () => loadSettings(),
  render: () => renderSettings(),
};
