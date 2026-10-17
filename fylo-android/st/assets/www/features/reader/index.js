/**
 * FYLO Feature — Reader (entry point)
 *
 * Import from here, not from reader.js or gestures.js directly.
 * This file defines the public surface of the reader feature.
 *
 * Usage:
 *   import { ReaderModule, wireReaderToolbar, initGestureEngine }
 *     from './features/reader/index.js';
 */

export { ReaderModule, wireReaderToolbar } from './reader.js';
export { initGestureEngine }              from './gestures.js';
