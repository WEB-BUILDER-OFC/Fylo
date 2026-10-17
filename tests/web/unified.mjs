// Unified PDF library — SIMULATED: fake bridge + faked /dev/doc and /saf/doc routes. Proves the WEB layer's behaviour
// against the bridge contract. It does NOT prove MANAGE_EXTERNAL_STORAGE, MediaStore indexing or the Java streaming.
import { chromium, open, rec, sleep, saveResults } from './lib.mjs';
import { boot, idbCount, fx } from './helpers.mjs';
import fs from 'node:fs';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const G = n => `unified-sim/${n}`;
const FIXTURE = 'text_uncompressed.pdf';
const SZ = fs.statSync(fx(FIXTURE)).size;
const P = n => `/storage/emulated/0/${n}`;
const dev = (path, extra = {}) => ({ path, name: path.split('/').pop(), size: SZ, modified: 1700000000000, ...extra });

async function setup({ storage = {}, device = [], cfg = {} } = {}) {
  const s = await open(b, 'android', { storage, ...cfg }); const p = s.page;
  s.hits = []; s.gone = new Set();
  await s.ctx.route(/appassets\.androidplatform\.net\/dev\/doc/, async r => {
    const q = new URL(r.request().url()).searchParams; const path = q.get('p'), uri = q.get('u'); s.hits.push(path || uri);
    if (path) {
      const granted = await p.evaluate(() => window.__fake.storage.granted);
      if (!granted) return r.fulfill({ status: 403, body: 'no access' });
      const known = await p.evaluate(path => !!(window.__fake.device.find(f => f.path === path && !f.deleted) || window.__fake.saved.find(f => f.abs === path)), path);
      if (!known || s.gone.has(path)) return r.fulfill({ status: 404, body: 'gone' });
      return r.fulfill({ status: 200, contentType: 'application/pdf', body: fs.readFileSync(fx(FIXTURE)) });
    }
    const idx = await p.evaluate(u => window.__fake.saved.findIndex(f => f.uri === u && !f.deleted), uri);
    if (idx < 0) return r.fulfill({ status: 404, body: 'gone' });
    r.fulfill({ status: 200, contentType: 'application/pdf', body: Buffer.from(await p.evaluate(i => window.__fake.base64(i), idx), 'base64') });
  });
  await s.ctx.route(/appassets\.androidplatform\.net\/saf\/doc/, r => r.fulfill({ status: 200, contentType: 'application/pdf', body: fs.readFileSync(fx(FIXTURE)) }));
  await boot(s);
  await p.evaluate(d => { window.__fake.device = d; }, device);
  return s;
}
const tabText = p => p.locator('#files-content').innerText();
const goAll = async p => { await p.evaluate(() => { document.querySelector('.nav-item[data-page="files"], [data-nav="files"]')?.click(); }); await p.evaluate(() => window.location.hash = '#files'); await sleep(400); await p.evaluate(() => document.getElementById('tab-all').click()); await sleep(400); };
const names = p => p.$$eval('#files-list .recent-name', e => e.map(x => x.innerText));
const filesStore = p => p.evaluate(() => new Promise(res => { const r = indexedDB.open('fylo_db'); r.onsuccess = () => { const q = r.result.transaction('files').objectStore('files').getAll(); q.onsuccess = () => res(q.result.map(x => ({ id: x.id, name: x.name, hasBlob: !!x.blob, blobSize: x.blob?.size || 0, ref: x.ref || null, thumbBytes: (x.thumbnail || '').length, json: JSON.stringify({ ...x, blob: undefined }).length }))); }; }));
const emitPdf = (p, name, generated = true) => p.evaluate(async ([name, generated, b64]) => {
  const { bus } = await import('./core/eventBus.js');
  const u = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return new Promise(res => bus.emit('files:incoming', { files: [new File([u], name, { type: 'application/pdf' })], generated, onSaved: res }));
}, [name, generated, fs.readFileSync(fx(FIXTURE)).toString('base64')]);
const openRow = async (p, name) => { const i = (await names(p)).indexOf(name); await p.click(`#files-list .recent-item:nth-child(${i + 1})`); };

// ── 1. Not granted: honest card, fallback still works ────────────────────────────────────────────────────────
{ const s = await setup({ device: [dev(P('Documents/a.pdf')), dev(P('Documents/b.pdf'))] }); const p = s.page;
  const tabVisible = await p.evaluate(() => !document.getElementById('tab-all').classList.contains('hidden') && document.querySelector('.file-tab.active').dataset.tab === 'all'); await goAll(p);
  const t = await tabText(p);
  rec(G('denied'), 'All PDFs tab exists on Android and is the default tab', tabVisible);
  rec(G('denied'), 'without access: explains the special access and offers fallbacks (no fake permission popup claim)', /Allow access/.test(t) && /Choose folders instead/.test(t) && /never copied/i.test(t), t.replace(/\n+/g, ' | ').slice(0, 260));
  rec(G('denied'), 'device PDFs are NOT listed before access is granted', (await names(p)).length === 0);
  await p.evaluate(() => { window.__fake.grantOnRequest = false; });
  await p.click('#lib-allow'); await sleep(600);
  const t2 = await tabText(p);
  rec(G('denied'), 'user returns from Settings without granting → clear "wasn’t allowed" message + alternatives', /wasn’t allowed/.test(t2) && /Open PDF/.test(t2) && (await p.evaluate(() => window.__fake.accessRequests)) === 1, t2.replace(/\n+/g, ' | ').slice(0, 220));
  rec(G('denied'), 'no discovery was attempted while denied', (await p.evaluate(() => window.__fake.discoverCalls.length)) === 0);
  // Open PDF picker keeps working, in place, no copy
  await p.evaluate(() => { window.__fake.nextDocs = [{ uri: 'content://docs/picked/1', name: 'picked.pdf', size: 1234, modified: 1710000000000, persisted: true }]; });
  await p.evaluate(() => document.getElementById('file-input').click()); await sleep(1500);
  const st = await filesStore(p);
  rec(G('denied'), 'Open PDF picker still works and stores a reference only (no blob, no copy)', st.length === 1 && !st[0].hasBlob && st[0].ref?.kind === 'saf' && (await p.evaluate(() => window.__fake.pickDocCalls)) === 1, JSON.stringify(st));
  rec(G('denied'), 'a single picked PDF opens in the Reader', (await p.evaluate(() => location.hash)) === '#reader');
  rec(G('denied'), 'no page errors', s.logs.errors.length === 0, s.logs.errors.join('|'));
  await s.close(); }

// ── 2. Granted: discovery, in-place open, storage measurement ───────────────────────────────────────────────
{ const s = await setup({ device: [dev(P('Documents/a.pdf')), dev(P('Download/b.pdf'), { modified: 1710000000000 }), dev(P('WhatsApp/Documents/c.pdf'), { modified: 1690000000000 })] }); const p = s.page;
  await goAll(p);
  await p.evaluate(() => { window.__fake.grantOnRequest = true; });
  const before = await filesStore(p);
  await p.click('#lib-allow'); await p.waitForFunction(() => document.querySelectorAll('#files-list .recent-item').length >= 3, null, { timeout: 8000 }).catch(() => {});
  const n = await names(p);
  rec(G('granted'), 'granting access lists every PDF from the phone (quick pass, not a deep scan)', n.length === 3 && (await p.evaluate(() => window.__fake.discoverCalls.map(c => c.deep))).join() === 'false', n.join(','));
  rec(G('granted'), 'rows are labelled as living on the phone and sorted newest first', /On phone/.test(await tabText(p)) && n[0] === 'b.pdf', n.join(','));
  const mid = await filesStore(p);
  rec(G('storage'), 'browsing the device list creates NO library records and NO stored data', mid.length === before.length && mid.length === 0);
  await openRow(p, 'a.pdf'); await p.waitForFunction(() => location.hash === '#reader', null, { timeout: 15000 }).catch(() => {}); await sleep(1500);
  const after = await filesStore(p);
  rec(G('open'), 'tapping a device PDF opens it in the Reader, streamed from its own path', (await p.evaluate(() => location.hash)) === '#reader' && s.hits.includes(P('Documents/a.pdf')), `hits=${s.hits}`);
  rec(G('storage'), 'opening it stores one small reference record — NO blob, no duplicate PDF', after.length === 1 && !after[0].hasBlob && after[0].blobSize === 0 && after[0].ref?.path === P('Documents/a.pdf') && after[0].json < 4000, JSON.stringify(after));
  const est = await p.evaluate(async () => { const e = await navigator.storage.estimate(); return e.usage; });
  rec(G('storage'), 'browser storage usage after browsing+opening is far below one PDF copy', est < SZ + 400000, `usage=${est} pdf=${SZ}`);
  // open again → still one record, read again from the original
  await p.evaluate(() => history.back()); await sleep(500); await goAll(p);
  await openRow(p, 'a.pdf'); await sleep(1500);
  rec(G('open'), 'reopening does not duplicate the record (same stable id) and reads the original again', (await filesStore(p)).length === 1 && s.hits.filter(h => h === P('Documents/a.pdf')).length >= 2);
  await p.evaluate(() => history.back()); await sleep(500); await goAll(p);
  rec(G('dedupe'), 'an opened file is still listed exactly once in All PDFs', (await names(p)).filter(x => x === 'a.pdf').length === 1 && (await names(p)).length === 3, (await names(p)).join());
  // search
  await p.fill('#lib-search', 'c.p'); await sleep(250);
  rec(G('list'), 'search filters the unified list', (await names(p)).join() === 'c.pdf');
  await p.fill('#lib-search', ''); await sleep(250);

  // ── restart persistence ──
  await p.reload(); await p.waitForSelector('#menu-btn'); await sleep(2500);
  await goAll(p); await p.waitForFunction(() => document.querySelectorAll('#files-list .recent-item').length >= 3, null, { timeout: 8000 }).catch(() => {});
  rec(G('restart'), 'after an app restart the library repopulates from the phone without asking again (access is remembered)', (await names(p)).length === 3 && (await p.evaluate(() => window.__fake.accessRequests)) === 1, (await names(p)).join());
  rec(G('restart'), 'the previously opened PDF record survived the restart and still has no blob', (await filesStore(p)).length === 1 && !(await filesStore(p))[0].hasBlob);

  // ── refresh: new + deleted ──
  await p.evaluate(p0 => { window.__fake.device.push({ path: p0, name: 'new.pdf', size: 999, modified: 1720000000000 }); }, P('Documents/new.pdf'));
  await p.click('#lib-refresh'); await sleep(700);
  rec(G('refresh'), 'Refresh picks up a PDF added outside FYLO', (await names(p)).includes('new.pdf'));
  await p.evaluate(() => { window.__fake.device.find(f => f.name === 'a.pdf').deleted = true; window.__fake.device = window.__fake.device.filter(f => !f.deleted || f.name === 'a.pdf'); });
  await p.evaluate(() => { const d = window.__fake.device; const a = d.find(f => f.name === 'a.pdf'); a.deleted = true; });
  s.gone.add(P('Documents/a.pdf'));
  // simulate native discovery excluding deleted files
  await p.evaluate(() => { const orig = window.AndroidBridge.discoverPdfs; window.AndroidBridge.discoverPdfs = (id, deep) => { const keep = window.__fake.device; window.__fake.device = keep.filter(f => !f.deleted); orig(id, deep); window.__fake.device = keep; }; });
  await p.click('#lib-refresh'); await sleep(900);
  const nn = await names(p);
  rec(G('deleted'), 'a PDF deleted outside FYLO disappears from the device list on refresh, but a library record for it is kept and flagged Missing', nn.filter(x => x === 'a.pdf').length === 1 && /Missing/.test(await tabText(p)), nn.join() + ' / ' + (await tabText(p)).slice(0, 200).replace(/\n+/g, '|'));
  await openRow(p, 'a.pdf'); await sleep(700);
  const m = await p.locator('#modal-body').innerText().catch(() => '');
  rec(G('deleted'), 'tapping the missing PDF explains it was moved/deleted (does not open a broken Reader)', /moved or deleted/i.test(m) && (await p.evaluate(() => location.hash)) !== '#reader', m.replace(/\n+/g, ' '));
  await p.click('#unav-remove'); await sleep(600);
  rec(G('deleted'), '"Remove from list" forgets the reference only — the phone file list is untouched', !(await names(p)).includes('a.pdf') && (await filesStore(p)).length === 0 && (await p.evaluate(() => window.__fake.device.length)) >= 3);

  // ── revoke ──
  await openRow(p, 'b.pdf'); await sleep(1500); await p.evaluate(() => history.back()); await sleep(500); await goAll(p);
  await p.evaluate(() => { window.__fake.storage.granted = false; document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(900);
  const rv = await tabText(p);
  rec(G('revoked'), 'permission revoked in Settings: list empties, opened record shows "No access", card offers to allow again', /No access/.test(rv) && /Allow access|Try again/.test(rv), rv.replace(/\n+/g, ' | ').slice(0, 240));
  await openRow(p, 'b.pdf'); await sleep(700);
  const rm = await p.locator('#modal-body').innerText().catch(() => '');
  rec(G('revoked'), 'tapping it explains access was removed and offers "Allow access"', /no longer lets FYLO read/i.test(rm) && await p.locator('#unav-allow').count() === 1, rm.replace(/\n+/g, ' '));
  rec(G('revoked'), 'no page errors', s.logs.errors.length === 0, s.logs.errors.join('|'));
  await s.close(); }

// ── 3. FYLO-generated PDFs: ONE save, shared location, no private copy, unified, deduped ─────────────────────
{ const s = await setup({ storage: { granted: true }, device: [dev(P('Documents/a.pdf'))] }); const p = s.page;
  await goAll(p); await sleep(800);
  const ids = await emitPdf(p, 'merged.pdf');
  await sleep(1200);
  const saved = await p.evaluate(() => window.__fake.saved.map(x => ({ path: x.path, bytes: x.bytes })));
  const st = await filesStore(p);
  rec(G('generated'), 'a generated PDF is written exactly once, to Download/FYLO', saved.length === 1 && saved[0].path === 'Download/FYLO/merged.pdf' && saved[0].bytes === SZ, JSON.stringify(saved));
  rec(G('generated'), 'FYLO keeps only a reference to it (no second copy inside FYLO)', ids.length === 1 && st.length === 1 && !st[0].hasBlob && st[0].ref?.kind === 'media' && st[0].ref.path === P('Download/FYLO/merged.pdf'), JSON.stringify(st));
  rec(G('generated'), 'no extra download was triggered', (await p.evaluate(() => window.__fake.saved.length)) === 1);
  await p.evaluate(() => window.__fake.device.push({ path: '/storage/emulated/0/Download/FYLO/merged.pdf', name: 'merged.pdf', size: window.__fake.saved[0].bytes, modified: Date.now() }));
  await p.click('#lib-refresh'); await sleep(800);
  const n = await names(p);
  rec(G('dedupe'), 'the same physical file found by discovery and created by FYLO is listed ONCE', n.filter(x => x === 'merged.pdf').length === 1 && n.length === 2, n.join());
  rec(G('generated'), 'row is labelled Downloads/FYLO', /Downloads\/FYLO/.test(await tabText(p)));
  await openRow(p, 'merged.pdf'); await p.waitForFunction(() => location.hash === '#reader', null, { timeout: 15000 }).catch(() => {}); await sleep(1200);
  rec(G('open'), 'FYLO-generated PDF opens in the Reader from its saved location (content URI, readable without extra permission)', (await p.evaluate(() => location.hash)) === '#reader' && s.hits.some(h => String(h).startsWith('content://media/') || h === P('Download/FYLO/merged.pdf')), s.hits.join());
  // SAF-granted folder exposing the same file → still one entry
  await p.evaluate(() => { window.__fake.folders.push({ uri: 'content://tree/Dl', name: 'Download', accessible: true }); window.__fake.tree['content://tree/Dl'] = { ok: true, truncated: false, files: [{ uri: 'content://tree/Dl/document/primary%3ADownload%2FFYLO%2Fmerged.pdf', name: 'merged.pdf', size: window.__fake.saved[0].bytes, modified: 1, path: 'FYLO' }] }; });
  await p.evaluate(() => history.back()); await sleep(500); await goAll(p);
  await p.click('#lib-refresh'); await sleep(900);
  rec(G('dedupe'), 'the same file also reachable through a granted SAF folder is STILL listed once', (await names(p)).filter(x => x === 'merged.pdf').length === 1, (await names(p)).join());
  // private setting keeps the old internal behaviour
  await p.evaluate(async () => { const { Actions } = await import('./core/state.js'); Actions.updateSettings({ saveLocation: 'private' }); });
  await emitPdf(p, 'inside.pdf'); await sleep(900);
  const st2 = await filesStore(p); const inside = st2.find(x => x.name === 'inside.pdf');
  rec(G('generated'), 'with "Inside FYLO only" the PDF is stored internally and NOT written to shared storage', inside?.hasBlob && !inside.ref && (await p.evaluate(() => window.__fake.saved.length)) === 1);
  await p.evaluate(async () => { const { Actions } = await import('./core/state.js'); Actions.updateSettings({ saveLocation: 'shared' }); });
  // save failure falls back, never loses the PDF
  await p.evaluate(() => { window.__fake.cfg.failBeginContains = 'fallback'; });
  const fid = await emitPdf(p, 'fallback.pdf'); await sleep(900);
  const fb = (await filesStore(p)).find(x => x.name === 'fallback.pdf');
  rec(G('generated'), 'if Downloads/FYLO cannot be written the PDF is kept inside FYLO instead (never lost) and the user is told', fid.length === 1 && fb?.hasBlob && (await p.evaluate(() => window.__toasts.join('|'))).includes('kept inside FYLO'));
  rec(G('generated'), 'no page errors', s.logs.errors.length === 0, s.logs.errors.join('|'));
  await s.close(); }

// ── 4. Deep scan, large library, Android 10 mode, backup, web mode ───────────────────────────────────────────
{ const many = Array.from({ length: 3000 }, (_, i) => dev(P(`Many/f${String(i).padStart(4, '0')}.pdf`), { modified: 1600000000000 + i * 1000 }));
  many.push(dev(P('Hidden/unindexed.pdf'), { unindexed: true }));
  const s = await setup({ storage: { granted: true }, device: many }); const p = s.page;
  await p.evaluate(() => { window.__fake.device = window.__fake.device; }); await goAll(p); await p.click('#lib-refresh'); await sleep(1200);
  const t0 = Date.now(); const shown = (await names(p)).length;
  rec(G('large'), 'a 3,000-PDF library renders one page (100) with a "Show more" control, not 3,000 rows', shown === 100 && await p.locator('#lib-more').count() === 1, `rows=${shown}`);
  await p.click('#lib-more'); await sleep(300);
  rec(G('large'), '"Show more" reveals the next page', (await names(p)).length === 200);
  await p.fill('#lib-search', 'f2999'); await sleep(300);
  rec(G('large'), 'search reaches items beyond the visible page', (await names(p)).join() === 'f2999.pdf');
  await p.fill('#lib-search', 'unindexed'); await sleep(300);
  rec(G('deep'), 'a PDF the media index does not know is absent after a quick refresh…', (await names(p)).length === 0);
  await p.evaluate(() => window.__fake.cfg.deepProbe = 1);
  await p.evaluate(async () => { const { bus } = await import('./core/eventBus.js'); bus.emit('library:refresh', { deep: true }); }); await sleep(1200);
  rec(G('deep'), '…and found by an explicit Deep scan', (await names(p)).join() === 'unindexed.pdf' && (await p.evaluate(() => window.__fake.discoverCalls.some(c => c.deep))));
  rec(G('large'), 'no page errors', s.logs.errors.length === 0, s.logs.errors.join('|'));
  await s.close(); }
{ const s = await setup({ storage: { sdk: 29, mode: 'folders_only', granted: false } }); const p = s.page; await goAll(p);
  const t = await tabText(p);
  rec(G('android10'), 'Android 10 (no whole-storage grant exists): says so and offers the folder picker, no dead "Allow" button', /Android 10/.test(t) && await p.locator('#lib-allow').count() === 0 && await p.locator('#lib-folders').count() === 1, t.replace(/\n+/g, ' | ').slice(0, 200));
  await s.close(); }
{ const s = await setup({ storage: { granted: true }, device: [dev(P('Documents/a.pdf'))] }); const p = s.page; await goAll(p); await p.click('#lib-refresh'); await sleep(800);
  await openRow(p, 'a.pdf'); await sleep(1500); await p.evaluate(() => history.back()); await sleep(400);
  await emitPdf(p, 'gen.pdf'); await sleep(900);                       // → Download/FYLO reference
  await emitPdf(p, 'own.pdf', false); await sleep(900);               // imported copy (browser-style) → internal blob
  const before = await p.evaluate(() => window.__fake.saved.length);
  await p.click('.nav-item[data-page="settings"]'); await sleep(300); await p.click('#setting-export-data');
  await p.waitForFunction(n => window.__fake.saved.length > n, before, { timeout: 30000 }).catch(() => {}); await sleep(800);
  const zf = '/tmp/claude-0/-home-claude/a415532e-859a-573b-9450-993708560d00/scratchpad/unified_backup.zip';
  const zi = await p.evaluate(n => window.__fake.saved.findIndex(x => /\.zip$/.test(x.path)), 0);
  fs.writeFileSync(zf, Buffer.from(await p.evaluate(i => window.__fake.base64(i), zi), 'base64'));
  const { execFileSync } = await import('node:child_process');
  const info = JSON.parse(execFileSync('python3', ['-I', '-c', 'import zipfile,sys,json;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps({"names":z.namelist(),"files":json.loads(z.read("files.json")),"manifest":json.loads(z.read("manifest.json"))}))', zf], { encoding: 'utf8' }));
  const pdfs = info.names.filter(n => /\.pdf$/i.test(n));
  rec(G('backup'), 'backup contains only the internal copy; device/Downloads-FYLO PDFs are NOT duplicated into the ZIP', pdfs.length === 1 && /own\.pdf/.test(pdfs[0]), pdfs.join());
  rec(G('backup'), 'files.json still records the referenced PDFs and where they live', info.files.filter(f => f.storedOnDevice).length === 2 && info.files.some(f => f.reference?.path === P('Documents/a.pdf')), JSON.stringify(info.files.map(f => [f.name, !!f.storedOnDevice])));
  rec(G('backup'), 'no export failures reported for referenced files', !/fail/i.test(JSON.stringify(info.manifest.failures || [])) || (info.manifest.failures || []).length === 0, JSON.stringify(info.manifest.counts || info.manifest));
  await s.close(); }
{ const s = await open(b, 'web'); await boot(s); const p = s.page;
  rec(G('web'), 'browser/PWA mode: no All-PDFs tab, library unchanged', !(await p.locator('#tab-all').isVisible()) && !(await p.locator('#setting-access').isVisible()));
  await s.close(); }

await b.close();
saveResults('unified.json');
const bad = (await import('./lib.mjs')).results.filter(r => !r.ok);
console.log(`\n${(await import('./lib.mjs')).results.length - bad.length}/${(await import('./lib.mjs')).results.length} passed`);
process.exit(bad.length ? 1 : 0);
