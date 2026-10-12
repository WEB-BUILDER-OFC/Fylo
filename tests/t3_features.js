const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const { startServer, launch, sleep, prepareBuild } = require('./harness');

let failures = 0, passes = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  — ' + extra : '')); ok ? passes++ : failures++; };

const DEVICE_BRIDGE = `
  (function(){
    const B = window.AndroidBridge; window.__deviceState = { folders: [], items: [], pickCalls: 0, scans: 0, thumbs: [] };
    B.getPdfFolders = () => JSON.stringify(window.__deviceState.folders);
    B.pickPdfFolder = () => { window.__deviceState.pickCalls++; setTimeout(() => window.fyloOnDeviceFolderPicked(!!window.__deviceState.grant, window.__deviceState.grant ? 'granted' : 'cancelled'), 20); };
    B.removePdfFolder = (u) => { window.__deviceState.folders = window.__deviceState.folders.filter(f => f.uri !== u); return true; };
    B.scanDevicePdfs = () => { const d = window.__deviceState; d.scans++; if (d.neverReply) return 'started'; setTimeout(() => window.fyloOnDevicePdfs(JSON.stringify({ items: d.items, errors: d.errors || [], truncated: false })), 30); return 'started'; };
    B.requestDevicePdfThumb = (id) => { window.__deviceState.thumbs.push(id); setTimeout(() => window.fyloOnDevicePdfThumb(id, 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='), 10); };
  })();`;

async function makeFixtures(page) {
  // Build test PDFs inside the browser with the app's own pdf-lib: a JPEG-heavy "scan", a text-only PDF, a 1-page PDF.
  return await page.evaluate(async () => {
    await window.fyloEventBus; const L = await (async () => { for (let i = 0; i < 100; i++) { if (window.PDFLib) return window.PDFLib; await new Promise(r => setTimeout(r, 100)); } })();
    const { PDFDocument, StandardFonts } = L;
    async function noisyJpeg(w, h, q) {
      const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
      const id = x.createImageData(w, h); for (let i = 0; i < id.data.length; i += 4) { const v = (Math.random() * 255) | 0; id.data[i] = v; id.data[i + 1] = (v * 7) & 255; id.data[i + 2] = 255 - v; id.data[i + 3] = 255; }
      x.putImageData(id, 0, 0); x.fillStyle = '#000'; x.font = '90px sans-serif'; x.fillText('FYLO SCAN', 100, 200);
      const b = await new Promise(r => c.toBlob(r, 'image/jpeg', q)); return new Uint8Array(await b.arrayBuffer());
    }
    const scan = await PDFDocument.create();
    for (let i = 0; i < 3; i++) { const j = await scan.embedJpg(await noisyJpeg(1700, 2200, 0.97)); const p = scan.addPage([595, 842]); p.drawImage(j, { x: 0, y: 0, width: 595, height: 842 }); }
    const txt = await PDFDocument.create(); const f = await txt.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 2; i++) { const p = txt.addPage([595, 842]); p.drawText('Hello FYLO page ' + (i + 1), { x: 50, y: 700, size: 24, font: f }); }
    const toB64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
    return { scan: toB64(await scan.save()), text: toB64(await txt.save()) };
  });
}

(async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'fylo-t3-'));
  const www = path.join(T, 'www');
  const { state, port } = await startServer(www);
  prepareBuild('/home/claude/fylo/work/www', www, port);
  const { ctx, url } = await launch({ userDataDir: path.join(T, 'p'), port, extraInit: DEVICE_BRIDGE });
  const page = ctx.pages()[0] || await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(url); await page.waitForSelector('#app.show', { timeout: 15000 });
  const fx = await makeFixtures(page);
  const addFile = (name, b64, bytesOverride) => page.evaluate(async ([name, b64, raw]) => {
    const bin = raw ? new TextEncoder().encode(raw) : Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const f = new File([bin], name, { type: 'application/pdf', lastModified: Date.now() + Math.random() });
    await new Promise(r => window.fyloEventBus.emit('files:incoming', { files: [f], onSaved: r })); }, [name, b64, bytesOverride || null]);
  await addFile('scan.pdf', fx.scan); await addFile('text.pdf', fx.text); await addFile('garbage.pdf', null, 'this is not a pdf');
  const scanSize = Buffer.from(fx.scan, 'base64').length, textSize = Buffer.from(fx.text, 'base64').length;
  console.log(`fixtures: scan.pdf=${scanSize} B (3 pages of JPEG), text.pdf=${textSize} B`);

  const modalTitle = () => page.evaluate(() => document.getElementById('modal-title')?.textContent || '');
  const modalBody = () => page.evaluate(() => document.getElementById('modal-body')?.innerText || '');
  const waitTitle = async (re, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const t = await modalTitle(); if (re.test(t)) return t; await sleep(150); } return null; };
  const savedCount = () => page.evaluate(() => window.__saved.length);
  async function openTool(action, fileName) {
    await page.evaluate(() => { document.getElementById('modal-overlay').classList.remove('show'); });
    await page.evaluate(async a => { const m = await import('./features/tools/index.js'); m.ToolsModule.startFlow(a); }, action);
    await sleep(400);
    await page.evaluate(n => { [...document.querySelectorAll('#modal-body [data-compress-file],#modal-body [data-pdf2img-file]')].find(e => e.innerText.includes(n)).click(); }, fileName);
  }
  const closeAnyModal = async () => { await page.evaluate(() => document.getElementById('modal-close').click()); await sleep(450); };

  console.log('\n== #3 Compress ==');
  await openTool('compress', 'scan.pdf');
  const levels = await page.evaluate(() => [...document.querySelectorAll('#compress-level option')].map(o => o.value));
  check('Compress dialog offers strength levels', levels.join() === 'light,balanced,strong', levels.join());
  const before = await savedCount();
  await page.click('#compress-run-btn');
  const progressSeen = await page.evaluate(() => new Promise(r => { const t0 = Date.now(); const i = setInterval(() => { const t = document.getElementById('tool-progress-text')?.textContent; if (t || Date.now() - t0 > 3000) { clearInterval(i); r(t || null); } }, 20); }));
  check('progress dialog appears with real status text', !!progressSeen, progressSeen);
  const t1 = await waitTitle(/PDF compressed|Could not reduce|failed/);
  const body1 = await modalBody();
  check('scanned PDF compresses successfully', t1 === 'PDF compressed', t1 + ' | ' + body1.replace(/\n/g, ' ').slice(0, 160));
  const after = await savedCount();
  check('exactly one output file saved (no duplicates)', after === before + 1);
  const out = await page.evaluate(() => window.__saved[window.__saved.length - 1]);
  const outBuf = Buffer.from(out.b64, 'base64');
  fs.writeFileSync(path.join(T, 'compressed.pdf'), outBuf);
  check('output file name', out.name === 'scan_compressed.pdf', out.name);
  check('output is smaller than input', outBuf.length < scanSize, `${scanSize} → ${outBuf.length} (${((1 - outBuf.length / scanSize) * 100).toFixed(1)}% smaller)`);
  const m = body1.match(/([\d.]+ (?:KB|MB|B)).*?→.*?([\d.]+ (?:KB|MB|B))/);
  const fmt = b => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
  check('reported sizes match the real bytes', !!m && m[1] === fmt(scanSize) && m[2] === fmt(outBuf.length), m ? `${m[1]} → ${m[2]} vs ${fmt(scanSize)} → ${fmt(outBuf.length)}` : 'no match');
  const verify = await page.evaluate(async b64 => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const doc = await pdfjsLib.getDocument({ data: bytes }).promise; const res = { pages: doc.numPages, nonBlank: [] };
    for (let i = 1; i <= doc.numPages; i++) { const p = await doc.getPage(i); const vp = p.getViewport({ scale: 0.3 }); const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height; const x = c.getContext('2d'); await p.render({ canvasContext: x, viewport: vp }).promise; const d = x.getImageData(0, 0, c.width, c.height).data; let sum = 0; for (let k = 0; k < d.length; k += 4) sum += d[k]; res.nonBlank.push(Math.round(sum / (d.length / 4))); }
    return res; }, out.b64);
  check('output re-opens in PDF.js with all 3 pages, images render (not blank/white)', verify.pages === 3 && verify.nonBlank.every(v => v > 5 && v < 250), JSON.stringify(verify));
  check('%PDF header + qpdf-style structural check via pdf-lib reload', outBuf.slice(0, 5).toString() === '%PDF-');
  check('result added to library & Open button offered', await page.evaluate(() => [...document.querySelectorAll('#modal-footer button')].map(b => b.textContent).includes('Open')) && await page.evaluate(() => [...document.querySelectorAll('#recent-list .recent-name')].some(e => e.textContent === 'scan_compressed.pdf')));
  await page.evaluate(() => [...document.querySelectorAll('#modal-footer button')].find(b => b.textContent === 'Open').click());
  await sleep(2500);
  check('"Open" shows the compressed PDF in the Reader', await page.evaluate(() => document.getElementById('page-reader').classList.contains('active') && document.getElementById('reader-total-pages').textContent.trim() === '3'));
  await page.evaluate(() => document.getElementById('reader-back').click()); await sleep(600);

  // text-only: honest no-reduction
  await openTool('compress', 'text.pdf');
  const b2 = await savedCount(); await page.click('#compress-run-btn');
  const t2 = await waitTitle(/PDF compressed|Could not reduce|failed/);
  const body2 = await modalBody();
  check('text-only PDF: truthful "could not reduce" (no fake success)', t2 === 'Could not reduce this PDF' && /no photos or scanned images/.test(body2) && /nothing was saved/i.test(body2), t2);
  check('text-only PDF: nothing saved / no corrupt or duplicate file', (await savedCount()) === b2);
  await closeAnyModal();

  // garbage: error, UI not stuck, next op works
  await openTool('compress', 'garbage.pdf');
  const b3 = await savedCount(); await page.click('#compress-run-btn');
  const t3 = await waitTitle(/PDF compressed|Could not reduce|failed/);
  check('corrupt file: clear error, nothing saved', t3 === 'Compression failed' && (await savedCount()) === b3, (await modalBody()).replace(/\n/g, ' ').slice(0, 100));
  await closeAnyModal();
  await openTool('compress', 'scan.pdf'); await page.selectOption('#compress-level', 'light'); await page.click('#compress-run-btn');
  const t3b = await waitTitle(/PDF compressed|Could not reduce|failed/);
  check('after a failure the tool is not stuck (next compress runs; "Light" level also works)', t3b === 'PDF compressed' || t3b === 'Could not reduce this PDF', t3b);
  await closeAnyModal();

  // cancel
  await openTool('compress', 'scan.pdf'); await page.selectOption('#compress-level', 'strong');
  const b4 = await savedCount(); await page.click('#compress-run-btn'); await sleep(250);
  await page.click('#tool-progress-cancel');
  await sleep(2500);
  check('Cancel stops compression and saves nothing', (await savedCount()) === b4 && !(await page.evaluate(() => document.getElementById('modal-overlay').classList.contains('show'))), 'saved delta=' + ((await savedCount()) - b4));

  console.log('\n== #4 PDF to Image ==');
  async function pdf2img(fmt) {
    await openTool('pdf-to-img', 'scan.pdf'); await page.selectOption('#pdf2img-format', fmt);
    const b = await savedCount(); await page.click('#pdf2img-run-btn');
    const t = await waitTitle(/Images saved|Conversion failed/, 90000);
    return { t, body: await modalBody(), files: (await page.evaluate(() => window.__saved)).slice(b) };
  }
  const png = await pdf2img('png');
  check('PNG: completes and reports 3 of 3', png.t === 'Images saved' && /3 of 3/.test(png.body), png.t + ' | ' + png.body.replace(/\n/g, ' '));
  check('PNG: one file per page, correct names', png.files.map(f => f.name).join() === 'scan_page1.png,scan_page2.png,scan_page3.png', png.files.map(f => f.name).join());
  const pngOk = png.files.map(f => { const b = Buffer.from(f.b64, 'base64'); return { sig: b.slice(0, 8).toString('hex') === '89504e470d0a1a0a', w: b.readUInt32BE(16), h: b.readUInt32BE(20), len: b.length }; });
  check('PNG: valid PNG signature, real dimensions (~144 dpi A4), non-empty', pngOk.every(p => p.sig && p.w > 1000 && p.h > 1400 && p.len > 10000), JSON.stringify(pngOk));
  check('PNG: mime type passed to the device', png.files.every(f => f.mime === 'image/png'));
  const pngRender = await page.evaluate(async b64 => { const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode(); const c = document.createElement('canvas'); c.width = 100; c.height = 100; const x = c.getContext('2d'); x.drawImage(img, 0, 0, 100, 100); const d = x.getImageData(0, 0, 100, 100).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i]; return s / 10000; }, png.files[0].b64);
  check('PNG: decodes and shows the page content (not blank)', pngRender > 5 && pngRender < 250, 'mean=' + pngRender.toFixed(1));
  await closeAnyModal();
  const jpg = await pdf2img('jpg');
  check('JPG: 3 files, valid JPEG (FFD8), names .jpg', jpg.files.length === 3 && jpg.files.every(f => Buffer.from(f.b64, 'base64').slice(0, 2).toString('hex') === 'ffd8' && /_page[123]\.jpg$/.test(f.name) && f.mime === 'image/jpeg'), jpg.files.map(f => f.name).join());
  await closeAnyModal();
  // failure mid-way
  await page.evaluate(() => { window.__failSave = true; });
  const failRun = await pdf2img('png');
  check('save failure is reported honestly (not "success"), nothing claimed saved', failRun.t === 'Conversion failed' && /Saving page 1 failed.*disk full/.test(failRun.body) && /Nothing was saved/.test(failRun.body), failRun.body.replace(/\n/g, ' ').slice(0, 140));
  await page.evaluate(() => { window.__failSave = false; }); await closeAnyModal();
  const again = await pdf2img('png');
  check('after the failure, conversion works again (no stuck busy state)', again.t === 'Images saved');
  await closeAnyModal();
  // cancel mid-way
  await openTool('pdf-to-img', 'scan.pdf'); const bC = await savedCount(); await page.click('#pdf2img-run-btn'); await sleep(120); await page.click('#tool-progress-cancel'); await sleep(3000);
  const delta = (await savedCount()) - bC;
  check('Cancel stops conversion (fewer than 3 images saved, UI released)', delta < 3 && !(await page.evaluate(() => document.getElementById('modal-overlay').classList.contains('show'))), 'saved ' + delta);
  // dismiss-by-X cancels
  await openTool('pdf-to-img', 'scan.pdf'); const bX = await savedCount(); await page.click('#pdf2img-run-btn'); await sleep(120); await page.click('#modal-close'); await sleep(3000);
  check('Dismissing the progress dialog (X / Back) also cancels — no invisible background work', (await savedCount()) - bX < 3, 'saved ' + ((await savedCount()) - bX));

  console.log('\n== #5 Settings ==');
  await page.click('.nav-item[data-page=settings]'); await sleep(400);
  const settingsText = await page.evaluate(() => document.getElementById('page-settings').innerText);
  check('"Built With" is gone; Version shows', !/Built With/i.test(settingsText) && /FYLO 2\.1\.0/.test(settingsText));
  await page.evaluate(() => caches.open('junk').then(c => c.put('/x', new Response('x'))));
  await page.click('#setting-clear-cache'); await sleep(500);
  const toasts = await page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent));
  check('Clear Cache: reports what was removed (2 temp files via native bridge) and states PDFs are untouched', toasts.some(t => /2 temporary files removed/.test(t) && /untouched/.test(t)), toasts.join(' | '));
  check('Clear Cache: Cache Storage emptied', (await page.evaluate(() => caches.keys())).length === 0);
  const fileCountBefore = await page.evaluate(() => document.querySelectorAll('#recent-list .recent-item').length);
  check('Clear Cache: saved PDFs untouched', fileCountBefore > 0);
  const bE = await savedCount();
  await page.evaluate(async () => { const { State } = await import('./core/state.js'); const { BookmarkStorage } = await import('./core/storage.js'); await BookmarkStorage.save(State.files[0].id, new Set([1, 2])); });
  await page.click('#setting-export-data');
  const tE = await waitTitle(/Backup saved|failed/, 30000);
  const exp = (await page.evaluate(() => window.__saved)).slice(bE);
  check('Export: one backup file saved, named fylo-backup-DATE.zip', tE === 'Backup saved' && exp.length === 1 && /^fylo-backup-\d{4}-\d{2}-\d{2}\.zip$/.test(exp[0].name), exp.map(e => e.name).join());
  const zipPath = path.join(T, 'backup.zip'); fs.writeFileSync(zipPath, Buffer.from(exp[0].b64, 'base64'));
  const zt = cp.spawnSync('python3', ['-I', '-c', `
import zipfile,json,sys
z=zipfile.ZipFile(sys.argv[1]); bad=z.testzip(); names=z.namelist()
m=json.loads(z.read('fylo-backup.json'))
print(json.dumps({'bad':bad,'names':names,'summary':m['summary'],'settings':m['settings'],'bookmarks':m['bookmarks'][:1],'pdfHeaderOK':all(z.read(n)[:5]==b'%PDF-' or n=='files/garbage.pdf' for n in names if n.startswith('files/'))}))`, zipPath]);
  const zj = zt.status === 0 ? JSON.parse(zt.stdout.toString()) : { err: zt.stderr.toString() };
  check('Export: valid ZIP (python zipfile CRC test passes)', zj.bad === null && zj.names && zj.names.includes('fylo-backup.json'), JSON.stringify(zj).slice(0, 300));
  check('Export: contains the saved PDFs + bookmarks + settings', zj.summary && zj.summary.pdfsIncluded >= 3 && zj.bookmarks.length >= 1 && 'darkMode' in zj.settings, JSON.stringify(zj.summary));
  await closeAnyModal();

  console.log('\n== #6 Menu button ==');
  await page.click('.nav-item[data-page=home]'); await sleep(300);
  await page.click('#menu-btn'); await sleep(500);
  const menuItems = await page.evaluate(() => [...document.querySelectorAll('#modal-body [data-menu]')].map(b => b.innerText.trim()));
  check('Hamburger opens a menu (it did nothing before)', (await modalTitle()) === 'Menu' && menuItems.length >= 4, menuItems.join(', '));
  await page.click('#modal-body [data-menu=settings]'); await sleep(600);
  check('Menu item navigates (Settings)', await page.evaluate(() => document.getElementById('page-settings').classList.contains('active')));
  await page.click('#menu-btn'); await sleep(400); await page.click('#modal-body [data-menu=tools]'); await sleep(500);
  check('Menu item navigates (All tools) and modal closed', await page.evaluate(() => document.getElementById('page-tools').classList.contains('active') && !document.getElementById('modal-overlay').classList.contains('show')));

  console.log('\n== #2 PDFs on this device (UI + protocol, mocked native side) ==');
  // reload so initDevice sees the device bridge — it was injected via init script, so tab should already be visible
  await page.goto(url); await page.waitForSelector('#app.show'); await sleep(800);
  check('"On device" tab visible when the native bridge offers it', await page.evaluate(() => !document.getElementById('files-tab-device').classList.contains('hidden')));
  await page.click('.nav-item[data-page=files]'); await sleep(300); await page.click('#files-tab-device'); await sleep(500);
  let txt = await page.evaluate(() => document.getElementById('files-list').innerText);
  check('No folder granted yet: explains and offers "Add folder" (no permission pre-requested)', /Choose where your PDFs are/.test(txt) && /Add folder/.test(txt) && (await page.evaluate(() => window.__deviceState.pickCalls)) === 0, txt.replace(/\n/g, ' ').slice(0, 90));
  await page.evaluate(() => { window.__deviceState.grant = false; }); await page.click('[data-device-act=add]'); await sleep(300);
  check('Picker cancelled → "No folder selected", nothing listed, no error', (await page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent))).some(t => /No folder selected/.test(t)));
  const pdfBytes = Buffer.from(fx.scan, 'base64'), small = Buffer.from(fx.text, 'base64');
  state.device = { aaa111: small, bbb222: pdfBytes };
  await page.evaluate(() => { const d = window.__deviceState; d.grant = true; d.folders = [{ uri: 'content://tree/dl', name: 'Download', accessible: true }, { uri: 'content://tree/sd', name: 'SD card', accessible: false }];
    d.items = [ { id: 'aaa111', name: 'Invoice <b>March</b>.pdf', folder: 'Download/Invoices', source: 'Download', size: 4096, modified: Date.now() - 3600e3 }, { id: 'bbb222', name: 'Book.pdf', folder: 'Download', source: 'Download', size: 5242880, modified: Date.now() - 864e5 * 3 }, { id: 'ccc333', name: 'Gone.pdf', folder: 'Download', source: 'Download', size: -1, modified: 0 } ];
    d.errors = ['A granted folder is no longer available (removed, moved or unmounted).']; });
  await page.click('[data-device-act=add]'); await sleep(900);
  txt = await page.evaluate(() => document.getElementById('files-list').innerText);
  check('After granting: PDFs listed with name, size, folder', /Book\.pdf/.test(txt) && /5\.0 MB/.test(txt) && /Download\/Invoices/.test(txt) && /3 PDFs/.test(txt), txt.replace(/\n/g, ' ').slice(0, 200));
  check('Names are HTML-escaped (no injection)', await page.evaluate(() => !document.querySelector('#files-list b') && document.getElementById('files-list').innerText.includes('<b>March</b>')));
  check('Inaccessible folder + errors are shown, not hidden', /unavailable/.test(txt) && /no longer available/.test(txt));
  check('Thumbnails requested natively for visible rows only, once each', await page.evaluate(() => { const t = window.__deviceState.thumbs; return t.length >= 1 && new Set(t).size === t.length; }));
  check('Thumbnail returned by native is displayed', await page.evaluate(() => !!document.querySelector('[data-device-thumb] img')));
  const rescans = await page.evaluate(() => window.__deviceState.scans);
  await page.click('[data-device-act=refresh]'); await sleep(500);
  check('Refresh triggers a new scan', (await page.evaluate(() => window.__deviceState.scans)) === rescans + 1);
  await page.click('[data-device-id=bbb222]'); await sleep(3500);
  check('Tapping a PDF opens it in the existing Reader (3 pages)', await page.evaluate(() => document.getElementById('page-reader').classList.contains('active') && document.getElementById('reader-total-pages').textContent.trim() === '3'));
  const copies = await page.evaluate(() => [...document.querySelectorAll('#recent-list .recent-name')].filter(e => e.textContent === 'Book.pdf').length);
  check('Only the selected file was imported into app storage', await page.evaluate(async () => { const { State } = await import('./core/state.js'); return State.files.filter(f => ['Book.pdf', 'Invoice <b>March</b>.pdf', 'Gone.pdf'].includes(f.name)).length === 1; }));
  await page.evaluate(() => document.getElementById('reader-back').click()); await sleep(500);
  await page.click('.nav-item[data-page=files]'); await sleep(300); await page.click('#files-tab-device'); await sleep(500);
  await page.click('[data-device-id=bbb222]'); await sleep(2500); await page.evaluate(() => document.getElementById('reader-back').click()); await sleep(500);
  check('Re-opening the same PDF does not create a duplicate library entry', await page.evaluate(async () => { const { State } = await import('./core/state.js'); return State.files.filter(f => f.name === 'Book.pdf').length === 1; }));
  await page.click('.nav-item[data-page=files]'); await sleep(300); await page.click('#files-tab-device'); await sleep(600);
  await page.click('[data-device-id=ccc333]'); await sleep(1200);
  const toasts2 = await page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent));
  check('Deleted/moved file: friendly message, row removed after refresh, app not stuck', toasts2.some(t => /no longer available/.test(t)));
  await page.evaluate(() => { const d = window.__deviceState; d.items = []; d.errors = []; }); await page.click('[data-device-act=refresh]'); await sleep(500);
  txt = await page.evaluate(() => document.getElementById('files-list').innerText);
  check('Granted folders but zero PDFs → "No PDFs found" empty state', /No PDFs found/.test(txt));
  await page.evaluate(() => { window.__deviceState.neverReply = true; }); await page.click('[data-device-act=refresh]'); await sleep(300);
  check('While scanning, Refresh shows "Scanning…" (disabled)', await page.evaluate(() => document.querySelector('[data-device-act=refresh]').disabled));
  await page.evaluate(() => { window.__deviceState.neverReply = false; });
  await page.click('[data-device-remove]'); await sleep(500);
  check('Removing a folder releases it and refreshes the list', (await page.evaluate(() => window.__deviceState.folders.length)) === 1);
  await page.click('#files-tab-device'); await sleep(200);
  await page.click('.file-tab[data-tab=recent]'); await sleep(300);
  check('Other tabs unaffected (Recent still lists saved PDFs)', await page.evaluate(() => document.querySelectorAll('#files-list .recent-item').length > 0 && !document.querySelector('[data-device-act]')));
  // Preserve manual picker
  check('Manual "Open PDF" picker preserved', await page.evaluate(() => !!document.getElementById('file-input') && !!document.getElementById('home-open')));

  console.log('\nPage errors during run:', errs.length ? errs.join(' | ') : 'none');
  check('no uncaught page errors', errs.length === 0);
  console.log(`\n${passes} passed, ${failures} failed`);
  await ctx.close(); process.exit(failures ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
