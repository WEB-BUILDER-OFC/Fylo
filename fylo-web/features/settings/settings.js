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
import { toast } from '../../core/ui.js';
import { Router } from '../../core/router.js';
import { PAGES } from '../../core/constants.js';
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

  // Sync storage meter
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
async function _clearCache() {
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    toast('Cache cleared — reload to fetch fresh resources');
  } catch(e) { toast('Could not clear cache'); }
}

// ── Export data (list of file names) ─────────────────────────────────────────
function _exportData() {
  const data = {
    exportedAt: new Date().toISOString(),
    files: State.files.map(f => ({ name: f.name, size: f.size, date: f.date })),
    fileCount: State.files.length,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'fylo-data-export.json';
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('Data exported');
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
    toast('Update available — tap to reload', 6000);
    setTimeout(() => window.location.reload(), 6000);
  });
}

export const SettingsModule = {
  init:   () => { initPWA(); wireSettingsEvents(); },
  load:   () => loadSettings(),
  render: () => renderSettings(),
};
