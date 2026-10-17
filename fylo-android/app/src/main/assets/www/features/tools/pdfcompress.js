/**
 * FYLO Feature — PDF compression engine
 *
 * What "compress" really does here (and what it does NOT do):
 *   1. Recompresses embedded raster images (the thing that actually makes PDFs big) — JPEG (DCTDecode) and
 *      8-bit RGB/Gray Flate images — at a lower JPEG quality and, if oversized, a lower resolution.
 *      Only an image that becomes clearly smaller is replaced; otherwise the original stays untouched.
 *   2. Deflates streams that were stored uncompressed (some generators do this) and re-saves with object streams.
 *   3. Text, fonts and vector drawings are NOT rasterised — the document stays selectable/searchable.
 *   4. VERIFIES the result: structure re-parsed, page count equal, and (when pdf.js is available) first / middle /
 *      last page rendered and compared with the original. A result that fails verification is discarded.
 *
 * Not recompressed (counted and reported): CCITT/JBIG2/JPX images, CMYK / ICC / indexed colour spaces,
 * images with masks or Decode arrays, image masks, soft-mask images. A PDF made mostly of those, or of plain
 * text/vector content, usually cannot get meaningfully smaller — the caller is told so instead of being shown
 * a fake success.
 *
 * Pure functions: no DOM beyond canvas, no toasts. The caller owns UI, saving and cancellation (AbortSignal).
 */

import { Libs } from '../../core/libs.js';

export const LEVELS = {
  low:    { label: 'Light — best quality',  maxDim: 2600, quality: 0.82 },
  medium: { label: 'Balanced (recommended)', maxDim: 1800, quality: 0.68 },
  high:   { label: 'Maximum — smallest',    maxDim: 1200, quality: 0.50 },
};

export const MAX_INPUT_BYTES   = 200 * 1024 * 1024;   // refuse beyond this: pdf-lib holds the whole file in memory
export const MIN_SAVING_RATIO  = 0.01;                // < 1 % smaller is reported as "no meaningful reduction"
export const MIN_SAVING_BYTES  = 1024;
const MIN_IMAGE_PIXELS = 10_000;                      // ignore icons / tiny images
const MAX_IMAGE_PIXELS = 60_000_000;                  // avoid decoding images that could exhaust memory
const IMAGE_ACCEPT_RATIO = 0.92;                      // replace an image only if it shrinks by at least 8 %
const MIN_STREAM_BYTES = 256;
const VISUAL_CHECK_MAX_BYTES = 120 * 1024 * 1024;
const VISUAL_TOLERANCE = 14;                          // mean abs. luminance difference (0-255) allowed

const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });
const checkAbort = (signal) => { if (signal?.aborted) throw abortError(); };
const tick = () => new Promise(r => setTimeout(r, 0));

// ── Compression-stream helpers (zlib "deflate") ──────────────────────────────
export const hasStreams = () => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

async function pipe(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const inflate = (bytes) => pipe(bytes, new DecompressionStream('deflate'));
const deflate = (bytes) => pipe(bytes, new CompressionStream('deflate'));

// ── PNG predictor reversal (PDF Predictor 10-15) ─────────────────────────────
function unpredictPng(data, columns, colors, bpc) {
  const bpp = Math.max(1, (colors * bpc) >> 3);
  const rowBytes = (columns * colors * bpc + 7) >> 3;
  const rows = Math.floor(data.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  for (let r = 0; r < rows; r++) {
    const ft = data[r * (rowBytes + 1)];
    const src = r * (rowBytes + 1) + 1;
    const dst = r * rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const x = data[src + i];
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const b = r > 0 ? out[dst - rowBytes + i] : 0;
      const c = (r > 0 && i >= bpp) ? out[dst - rowBytes + i - bpp] : 0;
      let v;
      switch (ft) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = x + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c));
          break;
        }
        default: throw new Error('Unknown PNG filter');
      }
      out[dst + i] = v & 0xFF;
    }
  }
  return out;
}

// ── Image decoding / encoding via canvas ─────────────────────────────────────
function newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
const canvasToJpeg = (canvas, quality) =>
  new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('JPEG encode failed')), 'image/jpeg', quality));

function targetSize(w, h, maxDim) {
  const longest = Math.max(w, h);
  if (longest <= maxDim) return { w, h };
  const k = maxDim / longest;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

async function jpegFromJpeg(bytes, w, h, level) {
  const t = targetSize(w, h, level.maxDim);
  const src = new Blob([bytes], { type: 'image/jpeg' });
  let bmp;
  try {
    bmp = await createImageBitmap(src, t.w !== w ? { resizeWidth: t.w, resizeHeight: t.h, resizeQuality: 'high' } : undefined);
  } catch {
    bmp = await createImageBitmap(src);
  }
  const canvas = newCanvas(t.w, t.h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, t.w, t.h);
  ctx.drawImage(bmp, 0, 0, t.w, t.h);
  bmp.close?.();
  const blob = await canvasToJpeg(canvas, level.quality);
  canvas.width = 0; canvas.height = 0;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), w: t.w, h: t.h };
}

async function jpegFromRaw(raw, w, h, channels, level) {
  if (raw.length < w * h * channels) throw new Error('Image data shorter than its dimensions');
  const full = newCanvas(w, h);
  const fctx = full.getContext('2d');
  const img = fctx.createImageData(w, h);
  const px = img.data;
  if (channels === 3) {
    for (let i = 0, j = 0; i < w * h; i++, j += 3) { px[i * 4] = raw[j]; px[i * 4 + 1] = raw[j + 1]; px[i * 4 + 2] = raw[j + 2]; px[i * 4 + 3] = 255; }
  } else {
    for (let i = 0; i < w * h; i++) { const g = raw[i]; px[i * 4] = g; px[i * 4 + 1] = g; px[i * 4 + 2] = g; px[i * 4 + 3] = 255; }
  }
  fctx.putImageData(img, 0, 0);
  const t = targetSize(w, h, level.maxDim);
  let canvas = full;
  if (t.w !== w) {
    canvas = newCanvas(t.w, t.h);
    const c2 = canvas.getContext('2d');
    c2.imageSmoothingQuality = 'high';
    c2.drawImage(full, 0, 0, t.w, t.h);
    full.width = 0; full.height = 0;
  }
  const blob = await canvasToJpeg(canvas, level.quality);
  canvas.width = 0; canvas.height = 0;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), w: t.w, h: t.h };
}

// ── Worker pool: heavy per-image work runs off the main thread, several images at once ──────────────────────────
const WORKER_URL = new URL('./imgworker.js', import.meta.url);
const workersSupported = () => typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined'
  && typeof createImageBitmap !== 'undefined';

class ImagePool {
  constructor(size) { this.size = size; this.idle = []; this.all = []; this.queue = []; this.pending = new Map(); this.seq = 0; this.dead = false; }
  _spawn() {
    const w = new Worker(WORKER_URL);
    w.onmessage = (e) => {
      const p = this.pending.get(e.data.id); if (!p) return;
      this.pending.delete(e.data.id);
      this.idle.push(p.worker); this._pump();
      e.data.ok ? p.res(e.data) : p.rej(Object.assign(new Error(e.data.error), { decode: true }));
    };
    w.onerror = (ev) => {                       // infrastructure failure (blocked script, crash) → caller falls back to main thread
      ev.preventDefault?.();
      this.dead = true;
      for (const [id, p] of this.pending) if (p.worker === w) { this.pending.delete(id); p.rej(Object.assign(new Error('worker failed'), { infra: true })); }
    };
    this.all.push(w); return w;
  }
  _pump() {
    while (this.queue.length) {
      let w = this.idle.pop();
      if (!w && this.all.length < this.size) w = this._spawn();
      if (!w) return;
      const job = this.queue.shift();
      this.pending.set(job.id, { res: job.res, rej: job.rej, worker: w });
      w.postMessage(job.msg, job.transfer);
    }
  }
  run(msg, transfer) {
    if (this.dead) return Promise.reject(Object.assign(new Error('worker unavailable'), { infra: true }));
    return new Promise((res, rej) => { const id = ++this.seq; this.queue.push({ id, msg: { ...msg, id }, transfer, res, rej }); this._pump(); });
  }
  close() { for (const w of this.all) try { w.terminate(); } catch { /* ignore */ } this.all = []; this.idle = []; this.queue = []; }
}

async function mainThreadEncode(task, data, level) {
  if (task.kind === 'dct') return jpegFromJpeg(data, task.w, task.h, level);
  let raw = await inflate(data);
  if (task.predictor >= 10) raw = unpredictPng(raw, task.columns, task.colors, 8);
  return jpegFromRaw(raw, task.w, task.h, task.channels, level);
}

// ── pdf-lib object helpers ───────────────────────────────────────────────────
function lib() {
  const L = Libs.pdflib;
  if (!L) throw Object.assign(new Error('PDF-Lib is not available'), { code: 'NO_LIB' });
  return L;
}
const nameOf = (o) => (o && typeof o.toString === 'function' && String(o).startsWith('/')) ? String(o).slice(1) : null;

function filterList(dict, L) {
  const f = dict.lookup(L.PDFName.of('Filter'));
  if (!f) return [];
  if (f instanceof L.PDFArray) return f.asArray().map(x => nameOf(dict.context.lookup(x)));
  return [nameOf(f)];
}

/** ASCII85Decode (PDF flavour: optional "<~", "z" shortcut, terminated by "~>"). Throws on malformed input. */
function ascii85Decode(bytes) {
  const out = []; let tuple = [], i = 0;
  const n = bytes.length;
  if (bytes[0] === 0x3c && bytes[1] === 0x7e) i = 2;
  for (; i < n; i++) {
    const c = bytes[i];
    if (c === 0x7e) break;                                  // "~>"
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00) continue;
    if (c === 0x7a && tuple.length === 0) { out.push(0, 0, 0, 0); continue; }   // "z"
    if (c < 0x21 || c > 0x75) throw new Error('bad ASCII85');
    tuple.push(c - 33);
    if (tuple.length === 5) {
      let v = 0; for (const t of tuple) v = v * 85 + t;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); tuple = [];
    }
  }
  if (tuple.length === 1) throw new Error('bad ASCII85');
  if (tuple.length > 1) {
    const k = tuple.length; while (tuple.length < 5) tuple.push(84);
    let v = 0; for (const t of tuple) v = v * 85 + t;
    const b = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...b.slice(0, k - 1));
  }
  return Uint8Array.from(out);
}

function asciiHexDecode(bytes) {
  const out = []; let hi = -1;
  for (const c of bytes) {
    if (c === 0x3e) break;                                  // ">"
    let v;
    if (c >= 0x30 && c <= 0x39) v = c - 0x30; else if (c >= 0x41 && c <= 0x46) v = c - 0x37; else if (c >= 0x61 && c <= 0x66) v = c - 0x57;
    else if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00) continue; else throw new Error('bad ASCIIHex');
    if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; }
  }
  if (hi >= 0) out.push(hi * 16);
  return Uint8Array.from(out);
}

/** Why an image can't be recompressed, or null if it can. */
function imageSkipReason(dict, L) {
  const { PDFName } = L;
  const get = (k) => dict.lookup(PDFName.of(k));
  if (nameOf(get('Subtype')) !== 'Image') return 'not-image';
  if (get('ImageMask')?.toString() === 'true') return 'image mask';
  if (get('Mask')) return 'masked image';
  if (get('Decode')) return 'decode array';
  const w = get('Width')?.asNumber?.(), h = get('Height')?.asNumber?.();
  if (!w || !h) return 'unknown size';
  if (w * h < MIN_IMAGE_PIXELS) return 'tiny';
  if (w * h > MAX_IMAGE_PIXELS) return 'too large';
  const cs = nameOf(get('ColorSpace'));
  if (cs !== 'DeviceRGB' && cs !== 'DeviceGray') return 'colour space ' + (cs || 'complex');
  return null;
}

// ── Main entry ───────────────────────────────────────────────────────────────
/**
 * @param {ArrayBuffer} input
 * @param {{level?:string, signal?:AbortSignal, onProgress?:(p:{stage:string,message:string,fraction:number})=>void}} opts
 * @returns {Promise<object>} { ok, bytes?, originalSize, newSize, reduced, pageCount, images:{…}, checks:[…], notes:[…],
 *                             code?, message? }   ok:false + code for hard failures (ENCRYPTED, MALFORMED, TOO_LARGE, …)
 */
export async function compressPdf(input, opts = {}) {
  const { level: levelKey = 'medium', signal, onProgress = () => {} } = opts;
  const level = LEVELS[levelKey] || LEVELS.medium;
  const originalSize = input.byteLength;
  const notes = [];
  const progress = (stage, message, fraction) => onProgress({ stage, message, fraction });

  if (originalSize > MAX_INPUT_BYTES) {
    return { ok: false, code: 'TOO_LARGE', originalSize, message: `This file is ${(originalSize / 1048576).toFixed(0)} MB — too large to compress safely on this device (limit ${MAX_INPUT_BYTES / 1048576} MB).` };
  }
  if (!await Libs.waitForPdfLib()) return { ok: false, code: 'NO_LIB', originalSize, message: 'The PDF library could not be loaded.' };
  const L = lib();
  const { PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef } = L;

  // 1 ── parse ────────────────────────────────────────────────────────────────
  progress('open', 'Reading the PDF…', 0.02);
  checkAbort(signal);
  let pdf;
  try {
    pdf = await PDFDocument.load(input, { updateMetadata: false });
  } catch (e) {
    const encrypted = e?.name === 'EncryptedPDFError' || /encrypted/i.test(e?.message || '');
    return {
      ok: false, originalSize, code: encrypted ? 'ENCRYPTED' : 'MALFORMED',
      message: encrypted ? 'This PDF is password-protected. Unlock it first, then compress it.'
                         : 'This file could not be read as a valid PDF, so it was left untouched.',
    };
  }
  const pageCount = pdf.getPageCount();
  if (pageCount === 0) return { ok: false, originalSize, code: 'MALFORMED', message: 'The PDF has no pages.' };

  // 2 ── collect candidates ───────────────────────────────────────────────────
  const objects = pdf.context.enumerateIndirectObjects();
  const maskRefs = new Set();               // images used as soft masks must stay DeviceGray
  for (const [, obj] of objects) {
    if (obj instanceof PDFRawStream) {
      const sm = obj.dict.get(PDFName.of('SMask'));
      if (sm instanceof PDFRef) maskRefs.add(sm.toString());
    }
  }

  const stats = { found: 0, recompressed: 0, kept: 0, skipped: {}, bytesBefore: 0, bytesAfter: 0 };
  const skip = (why) => { stats.skipped[why] = (stats.skipped[why] || 0) + 1; };
  const canInflate = hasStreams();
  if (!canInflate) notes.push('This device cannot inflate PDF streams, so only JPEG images were recompressed.');

  const images = [];
  const plainStreams = [];
  for (const [ref, obj] of objects) {
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    const type = nameOf(dict.lookup(PDFName.of('Type')));
    if (nameOf(dict.lookup(PDFName.of('Subtype'))) === 'Image') {
      stats.found++;
      if (maskRefs.has(ref.toString())) { skip('soft mask'); continue; }
      const why = imageSkipReason(dict, L);
      if (why) { skip(why); continue; }
      const filters = filterList(dict, L);
      // A leading ASCII85/ASCIIHex wrapper (older generators, e.g. ReportLab) is just text armour: undo it, then treat the
      // remaining single filter normally.
      let lead = 0;
      while (lead < filters.length - 1 && (filters[lead] === 'ASCII85Decode' || filters[lead] === 'ASCIIHexDecode')) lead++;
      const rest = filters.slice(lead);
      if (rest.length !== 1) { skip(filters.length ? 'filter chain' : 'uncompressed image'); continue; }
      const f = rest[0];
      if (f === 'DCTDecode' || (f === 'FlateDecode' && canInflate)) images.push({ ref, obj, filter: f, lead: filters.slice(0, lead) });
      else skip(f ? `${f.replace('Decode', '')} images` : 'unknown filter');
    } else if (!dict.has(PDFName.of('Filter')) && type !== 'Metadata' && type !== 'XRef' && type !== 'ObjStm'
               && obj.getContentsSize() >= MIN_STREAM_BYTES && canInflate) {
      plainStreams.push({ ref, obj });
    }
  }

  // 3 ── recompress images (worker pool, several at once) ─────────────────────────────────────────────────────────
  let pool = null;
  if (images.length && workersSupported()) {
    try { pool = new ImagePool(Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1))); } catch { pool = null; }
  }
  const onAbort = () => pool?.close();
  signal?.addEventListener('abort', onAbort);
  let doneImages = 0;
  const t0 = Date.now();

  const handleImage = async ({ ref, obj, filter, lead }) => {
    checkAbort(signal);
    const dict = obj.dict;
    const w = dict.lookup(PDFName.of('Width')).asNumber();
    const h = dict.lookup(PDFName.of('Height')).asNumber();
    const cs = nameOf(dict.lookup(PDFName.of('ColorSpace')));
    const channels = cs === 'DeviceRGB' ? 3 : 1;
    const oldBytes = obj.getContents();
    stats.bytesBefore += oldBytes.length;
    try {
      let data = oldBytes;
      for (const l of lead) data = l === 'ASCII85Decode' ? ascii85Decode(data) : asciiHexDecode(data);
      let task, predictor = 1, columns = 1, colors = 1;
      if (filter === 'DCTDecode') {
        // Already-compact JPEG that doesn't need shrinking: re-encoding would only add generation loss.
        if (Math.max(w, h) <= level.maxDim && data.length / (w * h) < 0.2) {
          skip('already compact'); stats.kept++; stats.bytesAfter += oldBytes.length; return;
        }
        task = { kind: 'dct' };
      } else {
        const bpc = dict.lookup(PDFName.of('BitsPerComponent'))?.asNumber?.();
        if (bpc !== 8) { skip(`${bpc || '?'}-bit images`); stats.bytesBefore -= oldBytes.length; return; }
        let parms = dict.lookup(PDFName.of('DecodeParms'));
        if (parms instanceof L.PDFArray) parms = parms.lookup(lead.length);   // chain: one entry per filter
        predictor = parms?.lookup?.(PDFName.of('Predictor'))?.asNumber?.() ?? 1;
        if (predictor >= 10) {
          columns = parms.lookup(PDFName.of('Columns'))?.asNumber?.() ?? 1;
          colors  = parms.lookup(PDFName.of('Colors'))?.asNumber?.() ?? 1;
        } else if (predictor !== 1) {
          skip('TIFF predictor'); stats.bytesBefore -= oldBytes.length; return;
        }
        task = { kind: 'raw' };
      }
      Object.assign(task, { w, h, channels, predictor, columns, colors, maxDim: level.maxDim, quality: level.quality });
      let enc = null;
      if (pool && !pool.dead) {
        try {
          const copy = data.slice().buffer;     // copy: transferring a view would detach the whole PDF buffer
          const r = await pool.run({ ...task, bytes: copy }, [copy]);
          enc = { bytes: new Uint8Array(r.bytes), w: r.w, h: r.h };
        } catch (e) {
          checkAbort(signal);
          if (!e?.infra) throw e;               // genuine decode failure for this image
        }
      }
      if (!enc) enc = await mainThreadEncode(task, data, level);
      if (enc.bytes.length < oldBytes.length * IMAGE_ACCEPT_RATIO) {
        const nd = dict.clone();
        nd.set(PDFName.of('Width'), PDFNumber.of(enc.w));
        nd.set(PDFName.of('Height'), PDFNumber.of(enc.h));
        nd.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));   // canvas always writes a 3-component JPEG
        nd.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
        nd.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
        nd.set(PDFName.of('Length'), PDFNumber.of(enc.bytes.length));
        nd.delete(PDFName.of('DecodeParms'));
        pdf.context.assign(ref, PDFRawStream.of(nd, enc.bytes));
        stats.recompressed++;
        stats.bytesAfter += enc.bytes.length;
      } else {
        stats.kept++;
        stats.bytesAfter += oldBytes.length;
      }
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      skip('could not be decoded');
      stats.bytesAfter += oldBytes.length;
    } finally {
      doneImages++;
      const secs = Math.round((Date.now() - t0) / 1000);
      progress('images', `Recompressing images (${doneImages} of ${images.length})…${secs >= 3 ? ` ${secs}s` : ''}`,
        0.05 + 0.65 * (doneImages / Math.max(1, images.length)));
    }
  };

  try {
    progress('images', `Recompressing images (0 of ${images.length})…`, 0.05);
    const lanes = pool ? pool.size + 1 : 1;     // keep the workers fed; main-thread fallback runs one at a time
    let next = 0;
    const lane = async () => {
      while (next < images.length) {
        checkAbort(signal);
        const item = images[next++];
        await handleImage(item);
        if (!pool) await tick();
      }
    };
    await Promise.all(Array.from({ length: Math.min(lanes, images.length) }, lane));
  } finally {
    signal?.removeEventListener('abort', onAbort);
    pool?.close();
  }

  // 4 ── deflate streams stored uncompressed ──────────────────────────────────
  let deflated = 0;
  for (let i = 0; i < plainStreams.length; i++) {
    checkAbort(signal);
    if (i % 25 === 0) { progress('streams', `Optimising page data (${i + 1} of ${plainStreams.length})…`, 0.7 + 0.1 * (i / plainStreams.length)); await tick(); }
    const { ref, obj } = plainStreams[i];
    try {
      const raw = obj.getContents();
      const z = await deflate(raw);
      if (z.length < raw.length * 0.95) {
        const nd = obj.dict.clone();
        nd.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
        nd.set(PDFName.of('Length'), PDFNumber.of(z.length));
        pdf.context.assign(ref, PDFRawStream.of(nd, z));
        deflated++;
      }
    } catch { /* leave this stream as it was */ }
  }

  // 5 ── save ─────────────────────────────────────────────────────────────────
  progress('save', 'Writing the compressed PDF…', 0.82);
  checkAbort(signal);
  let out;
  try {
    out = await pdf.save({ useObjectStreams: true });
  } catch (e) {
    return { ok: false, originalSize, code: 'SAVE_FAILED', message: 'The compressed PDF could not be written: ' + (e?.message || e) };
  }

  const result = {
    ok: true, originalSize, newSize: out.length, pageCount, bytes: out, notes,
    images: stats, streamsDeflated: deflated, checks: [], level: levelKey,
    reduced: false,
  };
  result.reduced = (originalSize - out.length) >= Math.max(MIN_SAVING_BYTES, originalSize * MIN_SAVING_RATIO);

  // Nothing smaller to offer → no need to spend time verifying something that will be discarded.
  if (!result.reduced) { progress('done', 'Finished', 1); return result; }

  // 6 ── verify ───────────────────────────────────────────────────────────────
  progress('verify', 'Checking the result…', 0.88);
  const v = await verifyOutput(input, out, pageCount, signal);
  result.checks = v.checks;
  if (!v.ok) {
    result.ok = false; result.code = 'VERIFY_FAILED'; result.bytes = null;
    result.message = 'The compressed copy failed verification (' + v.reason + '), so it was discarded. Your original is unchanged.';
  }
  progress('done', 'Finished', 1);
  return result;
}

// ── Verification ─────────────────────────────────────────────────────────────
function sampleLuma(canvas) {
  const ctx = canvas.getContext('2d');
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const out = new Float32Array(canvas.width * canvas.height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) out[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  return out;
}

async function renderSmall(pdfDoc, pageNo) {
  const page = await pdfDoc.getPage(pageNo);
  const vp0 = page.getViewport({ scale: 1 });
  const scale = Math.min(1, 300 / Math.max(vp0.width, vp0.height));
  const vp = page.getViewport({ scale });
  const canvas = newCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  page.cleanup?.();
  return canvas;
}

export async function verifyOutput(originalBuf, outBytes, pageCount, signal) {
  const checks = [];
  const L = Libs.pdflib;

  // a) header / trailer
  const head = String.fromCharCode(...outBytes.subarray(0, 5));
  const tail = new TextDecoder('latin1').decode(outBytes.subarray(Math.max(0, outBytes.length - 1024)));
  if (head !== '%PDF-' || !tail.includes('%%EOF')) return { ok: false, reason: 'invalid PDF header/trailer', checks };
  checks.push('PDF structure valid');

  // b) re-parse + page count with pdf-lib
  try {
    const re = await L.PDFDocument.load(outBytes, { updateMetadata: false });
    if (re.getPageCount() !== pageCount) return { ok: false, reason: `page count ${re.getPageCount()} ≠ ${pageCount}`, checks };
    checks.push(`${pageCount} pages preserved`);
  } catch (e) { return { ok: false, reason: 're-opening failed: ' + (e?.message || e), checks }; }
  checkAbort(signal);

  // c) pdf.js: opens, same page count, sampled pages look like the original
  if (!await Libs.waitForPdfJs()) { checks.push('visual check skipped (PDF.js unavailable)'); return { ok: true, checks }; }
  if (originalBuf.byteLength > VISUAL_CHECK_MAX_BYTES) { checks.push('visual check skipped (very large file)'); return { ok: true, checks }; }
  let docA, docB;
  try {
    docA = await Libs.pdfjs.getDocument({ data: new Uint8Array(originalBuf.slice(0)) }).promise;
    docB = await Libs.pdfjs.getDocument({ data: new Uint8Array(outBytes.slice(0)) }).promise;
    if (docB.numPages !== docA.numPages) return { ok: false, reason: 'viewer reports a different page count', checks };
    const pages = [...new Set([1, Math.ceil(pageCount / 2), pageCount])];
    let worst = 0;
    for (const n of pages) {
      checkAbort(signal);
      const [ca, cb] = await Promise.all([renderSmall(docA, n), renderSmall(docB, n)]);
      if (ca.width !== cb.width || ca.height !== cb.height) return { ok: false, reason: `page ${n} size changed`, checks };
      const a = sampleLuma(ca), b = sampleLuma(cb);
      let sum = 0;
      for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
      worst = Math.max(worst, sum / a.length);
      ca.width = cb.width = 0;
    }
    if (worst > VISUAL_TOLERANCE) return { ok: false, reason: `pages look different from the original (diff ${worst.toFixed(1)})`, checks };
    checks.push(`${pages.length} sampled page${pages.length > 1 ? 's' : ''} match the original`);
    return { ok: true, checks };
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    return { ok: false, reason: 'viewer could not render it: ' + (e?.message || e), checks };
  } finally {
    try { docA?.destroy(); docB?.destroy(); } catch { /* ignore */ }
  }
}
