/**
 * FYLO Feature — Settings
 *
 * Owns: settings UI rendering, reading/writing user preferences, theme switching, reduce-motion,
 *       PWA install prompt, Clear Cache, Export Data (backup) and the About/version line.
 *
 * Public API:
 *   SettingsModule.init()   — wire events, init PWA (call once at startup)
 *   SettingsModule.load()   — load persisted settings and apply
 *   SettingsModule.render() — sync UI toggles to current State
 */

import { bus, EVENTS } from '../../core/eventBus.js';
import { State, Actions } from '../../core/state.js';
import { SettingsStorage } from '../../core/storage.js';
import { toast, openModal, closeModal, showProgress, formatFileSize } from '../../core/ui.js';
import { Device } from '../../core/device.js';
import { APP_VERSION, COMPRESS_LEVELS } from '../../core/constants.js';
import { exportBackup } from './backup.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger('Settings');

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── Load saved settings ───────────────────────────────────────────────────────
export async function loadSettings() {
  try {
    const dark   = await SettingsStorage.load('darkMode');
    const motion = await SettingsStorage.load('reduceMotion');
    const level  = await SettingsStorage.load('compressLevel');
    const imgFmt = await SettingsStorage.load('imageFormat');
    Actions.updateSettings({
      darkMode:      dark   ?? true,
      reduceMotion:  motion ?? false,
      compressLevel: COMPRESS_LEVELS.includes(level) ? level : 'medium',
      imageFormat:   imgFmt === 'jpg' ? 'jpg' : 'png',
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

// ── About / version ───────────────────────────────────────────────────────────
function _renderVersion() {
  const el = document.getElementById('about-version');
  if (!el) return;
  const info = Device.appInfo();
  if (!info) { el.textContent = `FYLO v${APP_VERSION}`; return; }
  // Native and web versions come from the same constant at build time. If they ever disagree, an old web
  // bundle is being served — say so instead of hiding it.
  const same = info.versionName === APP_VERSION;
  el.textContent = `FYLO v${info.versionName} (build ${info.versionCode})` + (same ? '' : ` — ⚠ showing web files v${APP_VERSION}; fully close and reopen FYLO`);
}

// ── Render settings page ──────────────────────────────────────────────────────
export function renderSettings() {
  const s = State.settings;
  const darkToggle   = document.getElementById('dark-mode-toggle');
  const motionToggle = document.getElementById('reduce-motion-toggle');
  if (darkToggle)   darkToggle.checked   = s.darkMode;
  if (motionToggle) motionToggle.checked = s.reduceMotion;
  const lvl = document.getElementById('setting-compress-level');
  const fmt = document.getElementById('setting-image-format');
  if (lvl) lvl.value = s.compressLevel || 'medium';
  if (fmt) fmt.value = s.imageFormat || 'png';
  document.getElementById('setting-folders')?.classList.toggle('hidden', !Device.canBrowseDevice);
  if (Device.canBrowseDevice) {
    const n = Device.folders().length;
    const d = document.getElementById('setting-folders-desc');
    if (d) d.textContent = n ? `${n} folder${n === 1 ? '' : 's'} chosen` : 'Choose folders FYLO may list PDFs from';
  }
  _renderVersion();
  bus.emit('files:updateStorage');
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
// DISPOSABLE data only: FYLO's own Cache Storage entries (offline copies of the app shell / CDN libraries) and,
// on Android, temporary share files + the WebView's HTTP cache. It never opens IndexedDB, so PDFs, bookmarks,
// favourites and settings cannot be touched, and it does not delete files you saved to Downloads/Pictures.
let _clearing = false;
async function _clearCache() {
  if (_clearing) return;
  _clearing = true;
  try {
    let cacheEntries = 0, cachesRemoved = 0;
    const problems = [];
    if ('caches' in window) {
      try {
        for (const key of await caches.keys()) {
          if (!key.startsWith('fylo-')) continue;
          try { cacheEntries += (await (await caches.open(key)).keys()).length; } catch { /* count is informational */ }
          if (await caches.delete(key)) cachesRemoved++;
        }
      } catch (e) { problems.push('browser cache: ' + (e?.message || e)); }
    }
    let freed = 0;
    if (Device.isAndroid) {
      const r = Device.clearNativeCache();
      if (r.ok) freed = r.freedBytes || 0; else problems.push('temporary files could not be cleared');
    }
    const parts = [];
    if (cachesRemoved) parts.push(`${cacheEntries} cached item${cacheEntries === 1 ? '' : 's'}`);
    if (freed) parts.push(`${formatFileSize(freed)} of temporary files`);
    if (problems.length) toast('Cache partly cleared — ' + problems.join('; '), 5000);
    else if (parts.length) toast(`Cleared ${parts.join(' and ')}. Your PDFs, bookmarks and settings were not touched.`, 4500);
    else toast('Nothing to clear — no temporary data was stored.', 3500);
  } finally { _clearing = false; }
}

// ── Export data (real backup) ─────────────────────────────────────────────────
let _exporting = false;
async function _exportData() {
  if (_exporting) return;           // ignore repeated taps while a backup is running
  _exporting = true;
  const prog = showProgress('Exporting your data', { text: 'Reading your library…' });
  let res;
  try {
    res = await exportBackup({
      signal: prog.signal,
      onProgress: ({ done, total, name }) =>
        prog.update(total ? `PDF ${Math.min(done + 1, total)} of ${total}: ${name}` : 'Preparing…', total ? done / total : null),
    });
  } catch (e) {
    res = { ok: false, error: e?.message || String(e) };
  }
  prog.done();
  _exporting = false;

  if (res.cancelled) { toast('Export cancelled — nothing was saved'); return; }
  if (!res.ok) { _showExportResult('Export failed', `<p>${esc(res.error)}</p><p style="margin-top:8px;color:var(--text-tertiary);font-size:13px">Nothing was saved and your data is unchanged.</p>`); return; }

  const c = res.counts, s = res.saved;
  let body = `<p>${s.verified
    ? `Saved and checked: <strong>${esc(s.path)}</strong> (${formatFileSize(s.bytes)}).`
    : `Download started: <strong>${esc(s.name)}</strong> (${formatFileSize(s.bytes)}). Browsers don’t confirm where the file ends up — check your downloads folder.`}</p>`;
  body += `<ul style="margin:10px 0 0 18px;color:var(--text-secondary);font-size:13px;line-height:1.6">
    <li>${c.pdfsExported} of ${c.pdfsInLibrary} PDFs</li>
    <li>${c.bookmarkedDocuments} document${c.bookmarkedDocuments === 1 ? '' : 's'} with bookmarks</li>
    <li>${c.settings} settings entr${c.settings === 1 ? 'y' : 'ies'} (including favourites)</li></ul>`;
  if (res.partial) {
    body += `<p style="margin-top:12px;color:var(--warning)">Some items could not be included:</p>
      <ul style="margin:6px 0 0 18px;color:var(--text-secondary);font-size:13px;line-height:1.6">${res.failures.slice(0, 8).map(f => `<li>${esc(f.item)} — ${esc(f.reason)}</li>`).join('')}${res.failures.length > 8 ? `<li>…and ${res.failures.length - 8} more (listed in manifest.json)</li>` : ''}</ul>`;
  }
  body += `<details style="margin-top:12px;font-size:12px;color:var(--text-tertiary)"><summary>Not part of a backup</summary><ul style="margin:6px 0 0 18px;line-height:1.6">${res.notIncluded.map(n => `<li>${esc(n)}</li>`).join('')}</ul></details>`;
  const actions = [];
  if (Device.isAndroid && s.uri) actions.push({ label: 'Share', fn: () => Device.share([s.uri], 'application/zip').then(ok => { if (!ok) toast('Could not open the share sheet'); }) });
  actions.push({ label: 'Done', primary: true });
  _showExportResult(res.partial ? 'Backup saved — with problems' : 'Backup saved', body, actions);
}

function _showExportResult(title, body, actions = [{ label: 'Done', primary: true }]) {
  openModal(title, body, actions.map((a, i) => `<button class="btn ${a.primary ? 'btn-primary' : 'btn-secondary'}" data-export-action="${i}">${esc(a.label)}</button>`).join(''));
  document.querySelectorAll('[data-export-action]').forEach(b => b.addEventListener('click', () => {
    const a = actions[Number(b.dataset.exportAction)];
    closeModal(); a?.fn?.();
  }));
}

// ── Event wiring (called once at startup) ─────────────────────────────────────
let _eventsWired = false;
export function wireSettingsEvents() {
  if (_eventsWired) return;
  _eventsWired = true;

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
  motionToggle?.removeAttribute('disabled');
  motionToggle?.addEventListener('change', async () => {
    Actions.updateSettings({ reduceMotion: motionToggle.checked });
    _applyReduceMotion(motionToggle.checked);
    try { await SettingsStorage.save('reduceMotion', motionToggle.checked); } catch(e) {}
  });

  // PDF tool defaults
  document.getElementById('setting-compress-level')?.addEventListener('change', async e => {
    const v = COMPRESS_LEVELS.includes(e.target.value) ? e.target.value : 'medium';
    Actions.updateSettings({ compressLevel: v });
    try { await SettingsStorage.save('compressLevel', v); } catch { toast('Could not save this setting'); }
  });
  document.getElementById('setting-image-format')?.addEventListener('change', async e => {
    const v = e.target.value === 'jpg' ? 'jpg' : 'png';
    Actions.updateSettings({ imageFormat: v });
    try { await SettingsStorage.save('imageFormat', v); } catch { toast('Could not save this setting'); }
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

  // Clickable rows are role=button: support Enter/Space as well as taps
  const rows = [
    ['setting-clear-cache', _clearCache],
    ['setting-export-data', _exportData],
    ['setting-folders',     () => bus.emit('ondevice:manageFolders', {})],
  ];
  for (const [id, fn] of rows) {
    const el = document.getElementById(id);
    el?.addEventListener('click', fn);
    el?.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } });
  }

  // Service Worker update notification (browser/PWA only — the Android app has no service worker)
  bus.on('sw:updateAvailable', () => {
    if (Device.isAndroid) return;
    toast('Update available — reloading shortly', 6000);
    setTimeout(() => window.location.reload(), 6000);
  });
}

export const SettingsModule = {
  init:   () => { initPWA(); wireSettingsEvents(); },
  load:   () => loadSettings(),
  render: () => renderSettings(),
};
