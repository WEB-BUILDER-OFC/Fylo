/**
 * FYLO Core — Logger
 * Structured logging with levels. Prefix every log with [FYLO:module].
 * Set LOG_LEVEL in constants or localStorage to control verbosity.
 */

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, NONE: 4 };

// Read from localStorage so devs can toggle at runtime:
// localStorage.setItem('FYLO_LOG', 'DEBUG')
function _getLevel() {
  const stored = typeof localStorage !== 'undefined'
    ? localStorage.getItem('FYLO_LOG') : null;
  return LEVELS[stored] ?? LEVELS.INFO;
}

function _fmt(module, ...args) {
  return [`[FYLO:${module}]`, ...args];
}

export function createLogger(module) {
  return {
    debug: (...a) => { if (_getLevel() <= LEVELS.DEBUG) console.debug(..._fmt(module, ...a)); },
    info:  (...a) => { if (_getLevel() <= LEVELS.INFO)  console.log(..._fmt(module, ...a)); },
    warn:  (...a) => { if (_getLevel() <= LEVELS.WARN)  console.warn(..._fmt(module, ...a)); },
    error: (...a) => { if (_getLevel() <= LEVELS.ERROR) console.error(..._fmt(module, ...a)); },
  };
}

// Global app logger
export const logger = createLogger('App');
