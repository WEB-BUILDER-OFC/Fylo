/**
 * FYLO Core — Constants
 * Single source of truth for all configuration values.
 * Never import business logic here.
 */

export const APP_NAME    = 'FYLO';
export const APP_VERSION = '2.0.0';

// PDF library versions
export const PDFJS_VERSION  = '3.11.174';
export const PDFLIB_VERSION = '1.17.1';

// IndexedDB
export const DB_NAME    = 'fylo_db';
export const DB_VERSION = 3;
export const DB_STORES  = {
  FILES:     'files',
  BOOKMARKS: 'bookmarks',
  SETTINGS:  'settings',
  THUMBS:    'thumbs',
};

// Reader defaults
export const READER_DEFAULT_SCALE    = 1.2;
export const READER_MIN_SCALE        = 0.2;
export const READER_MAX_SCALE        = 5.0;
export const READER_QUALITY_DELAY_MS = 200;
export const READER_UNDO_LIMIT       = 50;

// Editor defaults
export const EDITOR_DEFAULT_COLOR       = '#FFB300';
export const EDITOR_DEFAULT_STROKE      = 4;
export const EDITOR_HIGHLIGHT_COLORS    = [
  'rgba(255,179,0,1)',
  'rgba(255,82,82,0.8)',
  'rgba(79,140,255,0.8)',
  'rgba(0,200,83,0.8)',
  'rgba(123,97,255,0.8)',
  'rgba(0,188,212,0.8)',
];
export const EDITOR_PALETTE = [
  '#FFB300','#FF5252','#4F8CFF','#00C853','#7B61FF','#FF6D00',
  '#00B0FF','#FF4081','#69F0AE','#EEFF41','#111111','#FFFFFF',
];

// Storage limits
export const STORAGE_LIMIT_BYTES = 500 * 1024 * 1024; // 500 MB

// Toast durations
export const TOAST_DURATION_MS = 3000;

// Gesture thresholds
export const SWIPE_THRESHOLD_PX    = 60;
export const DOUBLE_TAP_DELAY_MS   = 280;
export const INERTIA_DECAY         = 0.90;
export const MOUSE_INERTIA_DECAY   = 0.88;

// Pages
export const PAGES = {
  HOME:     'home',
  FILES:    'files',
  TOOLS:    'tools',
  SETTINGS: 'settings',
  READER:   'reader',
  EDITOR:   'editor',
  CAMERA:   'camera',
};

// Tool IDs
export const TOOL_IDS = {
  MERGE:     'merge',
  COMPRESS:  'compress',
  ROTATE:    'rotate',
  SPLIT:     'split',
  WATERMARK: 'watermark',
  UNLOCK:    'unlock',
  PROTECT:   'protect',
  CONVERT:   'convert',
  SIGN:      'esign',
  REDACT:    'redact',
  EXTRACT:   'extract',
  REPAIR:    'repair',
};
