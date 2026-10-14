// Shared harness: static server, route shims, result recording.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire('/opt/npm-tools/node_modules/');
export const { chromium } = require('playwright');
const __dir = path.dirname(new URL(import.meta.url).pathname);
export const ROOT = path.resolve(__dir, '../..');
export const WEB = path.join(ROOT, 'fylo-web');
export const WWW = path.join(ROOT, 'fylo-android/app/src/main/assets/www');
export const FIX = path.join(__dir, 'fixtures');
export const OUT = path.join(__dir, 'out');
const PDFJS = '/opt/npm-tools/node_modules/pdfjs-dist/build';
const PDFLIB = '/opt/npm-tools/node_modules/pdf-lib/dist/pdf-lib.min.js';
const MIME = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.webmanifest':'application/manifest+json' };
export const POLY = `for (const C of [Map, WeakMap]) { const P = C.prototype;
  if (!P.getOrInsertComputed) Object.defineProperty(P, 'getOrInsertComputed', { value(k, f) { if (this.has(k)) return this.get(k); const v = f(k); this.set(k, v); return v; }, writable: true, configurable: true });
  if (!P.getOrInsert) Object.defineProperty(P, 'getOrInsert', { value(k, v) { if (this.has(k)) return this.get(k); this.set(k, v); return v; }, writable: true, configurable: true }); }
`;
/** pdf.js v6 needs newer JS built-ins than this test Chromium ships; prepend a polyfill (test environment only). */
export const pdfjsFile = n => { const f = path.join(PDFJS, n); return fs.existsSync(f) ? POLY + fs.readFileSync(f, 'utf8') : null; };
const mime = f => MIME[path.extname(f)] || 'application/octet-stream';

export function serve(dir) {
  return new Promise(res => {
    const s = http.createServer((q, r) => {
      let p = decodeURIComponent(q.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
      if (p.startsWith('/__pdfjs/')) { const body = pdfjsFile(p.slice(9)); if (body) { r.writeHead(200, { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' }); return r.end(body); } }
      const f = path.join(dir, p);
      if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('nf'); }
      r.writeHead(200, { 'content-type': mime(f), 'cache-control': 'no-store' }); fs.createReadStream(f).pipe(r);
    }).listen(0, '127.0.0.1', () => res({ url: `http://localhost:${s.address().port}/`, close: () => s.close() }));
  });
}

export const results = [];
export function rec(group, name, ok, detail = '') {
  results.push({ group, name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${group}] ${name}${detail ? '  — ' + detail : ''}`);
}
export const saveResults = f => fs.writeFileSync(path.join(OUT, f), JSON.stringify(results, null, 2));

/** mode 'web' → plain http origin; 'android' → simulated WebViewAssetLoader origin + fake bridge. */
export async function open(browser, mode, cfg = {}) {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 420, height: 860 }, serviceWorkers: 'allow' });
  const page = await ctx.newPage();
  const logs = { errors: [], console: [] };
  page.on('pageerror', e => logs.errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') logs.console.push(m.text()); });
  const shim = fs.readFileSync(path.join(__dir, 'pdfjs-shim.js'));
  const bridge = fs.readFileSync(path.join(__dir, 'fake-bridge.js'));
  await ctx.addInitScript({ content: `window.__toasts=[];document.addEventListener('DOMContentLoaded',()=>{const c=document.getElementById('toast-container');if(c)new MutationObserver(ms=>ms.forEach(m=>m.addedNodes.forEach(n=>window.__toasts.push(n.textContent)))).observe(c,{childList:true});});` });
  let server = null;
  await ctx.route(/fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr|unpkg|cdnjs/, r => r.abort());
  await ctx.route(/\/__pdfjs\//, r => { const n = r.request().url().split('/__pdfjs/')[1].split('?')[0]; const f = path.join(PDFJS, n);
    const body = pdfjsFile(n); body ? r.fulfill({ body, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } }) : r.fulfill({ status: 404 }); });
  await ctx.route(/pdf\.min\.js(\?|$)/, r => r.fulfill({ body: shim, contentType: 'text/javascript' }));
  await ctx.route(/pdf\.worker\.min\.js(\?|$)/, r => r.fulfill({ body: '/* shim */', contentType: 'text/javascript' }));
  await ctx.route(/pdf-lib(@[^/]+)?\/dist\/pdf-lib\.min\.js|\/libs\/pdf-lib\.min\.js/, r => r.fulfill({ body: fs.readFileSync(PDFLIB), contentType: 'text/javascript' }));
  let url;
  if (mode === 'android') {
    await ctx.addInitScript({ content: `window.__cfg=${JSON.stringify(cfg)};` });
    await ctx.addInitScript({ content: bridge.toString() });
    url = 'https://appassets.androidplatform.net/assets/www/index.html';
    await ctx.route(/appassets\.androidplatform\.net\/assets\/www\//, r => {
      const u = new URL(r.request().url()); const rel = u.pathname.replace('/assets/www/', '');
      const f = path.join(WWW, rel);
      if (rel.startsWith('assets/libs/pdf.min.js')) return r.fulfill({ body: shim, contentType: 'text/javascript' });
      if (rel.startsWith('assets/libs/pdf.worker')) return r.fulfill({ body: '/**/', contentType: 'text/javascript' });
      fs.existsSync(f) && fs.statSync(f).isFile() ? r.fulfill({ body: fs.readFileSync(f), contentType: mime(f), headers: { 'cache-control': 'no-store' } }) : r.fulfill({ status: 404, body: 'nf' });
    });
    await ctx.route(/appassets\.androidplatform\.net\/__pdfjs\//, r => { const n = r.request().url().split('/__pdfjs/')[1].split('?')[0]; r.fulfill({ body: pdfjsFile(n), contentType: 'text/javascript' }); });
  } else {
    server = await serve(WEB); url = server.url;
  }
  return { ctx, page, logs, url, server, async close() { await ctx.close(); server?.close(); } };
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function waitFor(page, fn, arg, timeout = 60000) { await page.waitForFunction(fn, arg, { timeout }); }
