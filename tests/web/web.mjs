import { chromium, open, rec, sleep, saveResults, OUT, ROOT } from './lib.mjs';
import { boot, importPdfs, idbCount, menuAction, fx } from './helpers.mjs';
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const G = n => `web/${n}`;
const waitTitle = (p, re, t = 120000) => p.waitForFunction(r => { const o = document.getElementById('modal-overlay'); return o && !o.classList.contains('hidden') && new RegExp(r, 'i').test(document.getElementById('modal-title').innerText); }, re.source, { timeout: t });

// Export in a plain browser → real download of a valid ZIP, honestly "unverified"
{ const s = await open(b, 'web'); await boot(s); const p = s.page; await importPdfs(p, ['text_uncompressed.pdf', 'photos.pdf'], 2);
  await p.click('.nav-item[data-page="settings"]'); await sleep(300);
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 60000 }), p.click('#setting-export-data')]);
  const f = path.join(OUT, 'web_backup.zip'); await dl.saveAs(f); await waitTitle(p, /^Backup saved/);
  const z = JSON.parse(execFileSync('python3', ['-I', '-c', 'import zipfile,json,sys;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps({"bad":z.testzip(),"n":[n for n in z.namelist() if n.startswith("pdfs/")]}))', f], { encoding: 'utf8' }));
  const body = await p.locator('#modal-body').innerText();
  rec(G('export'), 'browser export downloads a ZIP that passes CRC test with both PDFs', z.bad === null && z.n.length === 2, JSON.stringify(z));
  rec(G('export'), 'browser export does NOT claim a verified save location', /Download started/.test(body) && !/Saved and checked/.test(body), body.replace(/\n+/g, ' | ').slice(0, 160));
  await s.close(); }

// PDF → Image in browser: downloads happen
{ const s = await open(b, 'web'); await boot(s); const p = s.page; await importPdfs(p, ['photos.pdf'], 1);
  await menuAction(p, 'pdf-to-img'); await sleep(300); await p.click('[data-pdf2img-file]'); await p.fill('#pdf2img-pages', '1-2'); 
  const dls = []; p.on('download', d => dls.push(d.suggestedFilename()));
  await p.click('#pdf2img-run-btn'); await waitTitle(p, /^Saved/); await sleep(500);
  rec(G('pdf→img'), 'browser: 2 downloads with correct names; honest "check your downloads" text', dls.length === 2 && dls.every(n => /^photos_page[12]\.png$/.test(n)) && /downloads folder/.test(await p.locator('#modal-body').innerText()), dls.join());
  await s.close(); }

// Clear cache in browser: SW caches only
{ const s = await open(b, 'web'); await boot(s); const p = s.page; await importPdfs(p, ['photos.pdf'], 1);
  await p.evaluate(async () => { await caches.open('fylo-stale'); await caches.open('foreign'); });
  await p.click('.nav-item[data-page="settings"]'); await sleep(300); await p.click('#setting-clear-cache'); await sleep(1500);
  const keys = await p.evaluate(() => caches.keys());
  rec(G('clear-cache'), 'fylo caches cleared, foreign kept, library intact', !keys.some(k => k.startsWith('fylo-')) && keys.includes('foreign') && (await idbCount(p, 'files')) === 1, keys.join());
  await s.close(); }

// Upgrade cleanup script, extracted verbatim from MainActivity.java, run against a page that has an old SW + caches
{ const java = fs.readFileSync(path.join(ROOT, 'fylo-android/app/src/main/java/com/fylo/app/MainActivity.java'), 'utf8');
  const i = java.indexOf('view.evaluateJavascript(') + 'view.evaluateJavascript('.length; const j = java.indexOf(', null);', i);
  const script = new Function('return (' + java.slice(i, j) + ')')();
  const s = await open(b, 'web'); await boot(s); const p = s.page; await importPdfs(p, ['photos.pdf'], 1);
  await p.evaluate(async () => { await caches.open('fylo-v2.0.0'); await caches.open('keepme'); localStorage.setItem('k', 'v'); });
  const regsBefore = await p.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
  const res = await p.evaluate(s => new Promise(r => { window.AndroidBridge = { onWebCleanupDone: c => r({ done: c }), onWebCleanupFailed: m => r({ failed: m }) }; (0, eval)(s); setTimeout(() => r({ timeout: true }), 8000); }), script);
  const regsAfter = await p.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
  const keys = await p.evaluate(() => caches.keys());
  rec(G('upgrade-cleanup'), 'injected cleanup: SW unregistered, fylo-* caches deleted, others kept, callback(true)', regsBefore >= 1 && regsAfter === 0 && res.done === true && !keys.some(k => k.startsWith('fylo-')) && keys.includes('keepme'), JSON.stringify({ regsBefore, regsAfter, res, keys }));
  rec(G('upgrade-cleanup'), 'cleanup preserves IndexedDB PDFs and localStorage', (await idbCount(p, 'files')) === 1 && await p.evaluate(() => localStorage.getItem('k') === 'v'));
  await s.close(); }

// SW cache naming: bumping version changes cache key
{ const sw = fs.readFileSync(path.join(ROOT, 'fylo-web/sw.js'), 'utf8');
  rec(G('sw'), 'SW cache name derives from ?v= (changes per release)', /CACHE_NAME\s*=\s*'fylo-v'\s*\+\s*SW_VERSION/.test(sw) && /searchParams|\?v=|location/.test(sw)); }
await b.close(); saveResults('web.json'); process.exit(0);
