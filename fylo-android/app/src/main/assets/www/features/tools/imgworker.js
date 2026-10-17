/* FYLO — image recompression worker (used by pdfcompress.js).
 * Does the heavy per-image work OFF the main thread so the UI (and the Cancel button) stay responsive and several
 * images can be processed at the same time: inflate → undo PNG predictor → RGBA → resize → JPEG.
 * Message in : { id, kind:'dct'|'raw', bytes:ArrayBuffer, w, h, channels, predictor, columns, colors, maxDim, quality }
 * Message out: { id, ok:true, bytes:ArrayBuffer, w, h } | { id, ok:false, error }
 */
'use strict';

function targetSize(w, h, maxDim) {
  const longest = Math.max(w, h);
  if (longest <= maxDim) return { w, h };
  const k = maxDim / longest;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

async function inflate(buf) {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// PNG predictor reversal with the filter type resolved per ROW (not per byte) — several times faster than a switch in the inner loop.
function unpredict(data, columns, colors) {
  const bpp = Math.max(1, colors);
  const rowBytes = columns * colors;
  const rows = Math.floor(data.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  for (let r = 0; r < rows; r++) {
    const ft = data[r * (rowBytes + 1)];
    const src = r * (rowBytes + 1) + 1, dst = r * rowBytes, up = dst - rowBytes;
    switch (ft) {
      case 0: for (let i = 0; i < rowBytes; i++) out[dst + i] = data[src + i]; break;
      case 1:
        for (let i = 0; i < bpp && i < rowBytes; i++) out[dst + i] = data[src + i];
        for (let i = bpp; i < rowBytes; i++) out[dst + i] = (data[src + i] + out[dst + i - bpp]) & 255;
        break;
      case 2:
        if (r === 0) for (let i = 0; i < rowBytes; i++) out[dst + i] = data[src + i];
        else for (let i = 0; i < rowBytes; i++) out[dst + i] = (data[src + i] + out[up + i]) & 255;
        break;
      case 3:
        for (let i = 0; i < rowBytes; i++) {
          const a = i >= bpp ? out[dst + i - bpp] : 0, b = r > 0 ? out[up + i] : 0;
          out[dst + i] = (data[src + i] + ((a + b) >> 1)) & 255;
        }
        break;
      case 4:
        for (let i = 0; i < rowBytes; i++) {
          const a = i >= bpp ? out[dst + i - bpp] : 0, b = r > 0 ? out[up + i] : 0, c = (r > 0 && i >= bpp) ? out[up + i - bpp] : 0;
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          out[dst + i] = (data[src + i] + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c))) & 255;
        }
        break;
      default: throw new Error('Unknown PNG filter');
    }
  }
  return out;
}

async function toJpeg(canvas, quality) {
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return blob.arrayBuffer();
}

async function fromJpeg(msg) {
  const { w, h, maxDim, quality } = msg;
  const t = targetSize(w, h, maxDim);
  const src = new Blob([msg.bytes], { type: 'image/jpeg' });
  let bmp;
  try { bmp = await createImageBitmap(src, t.w !== w ? { resizeWidth: t.w, resizeHeight: t.h, resizeQuality: 'high' } : undefined); }
  catch { bmp = await createImageBitmap(src); }
  const canvas = new OffscreenCanvas(t.w, t.h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, t.w, t.h);
  ctx.drawImage(bmp, 0, 0, t.w, t.h);
  bmp.close && bmp.close();
  return { bytes: await toJpeg(canvas, quality), w: t.w, h: t.h };
}

async function fromRaw(msg) {
  const { w, h, channels, maxDim, quality } = msg;
  let raw = await inflate(msg.bytes);
  if (msg.predictor >= 10) raw = unpredict(raw, msg.columns || w, msg.colors || channels);
  if (raw.length < w * h * channels) throw new Error('Image data shorter than its dimensions');
  const rgba = new Uint32Array(w * h);
  if (channels === 3) {
    for (let i = 0, j = 0; i < rgba.length; i++, j += 3) rgba[i] = 0xff000000 | (raw[j + 2] << 16) | (raw[j + 1] << 8) | raw[j];
  } else {
    for (let i = 0; i < rgba.length; i++) { const g = raw[i]; rgba[i] = 0xff000000 | (g << 16) | (g << 8) | g; }
  }
  raw = null;
  const t = targetSize(w, h, maxDim);
  const img = new ImageData(new Uint8ClampedArray(rgba.buffer), w, h);
  let canvas;
  if (t.w !== w || t.h !== h) {
    // createImageBitmap does a high-quality resize without a full-size intermediate canvas.
    const bmp = await createImageBitmap(img, { resizeWidth: t.w, resizeHeight: t.h, resizeQuality: 'high' });
    canvas = new OffscreenCanvas(t.w, t.h);
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close && bmp.close();
  } else {
    canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').putImageData(img, 0, 0);
  }
  return { bytes: await toJpeg(canvas, quality), w: t.w, h: t.h };
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    const r = msg.kind === 'dct' ? await fromJpeg(msg) : await fromRaw(msg);
    self.postMessage({ id: msg.id, ok: true, bytes: r.bytes, w: r.w, h: r.h }, [r.bytes]);
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: String((err && err.message) || err) });
  }
};
