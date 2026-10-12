// Upgrade scenarios against the FIXED build, on one persistent profile (= same WebView data dir across APK updates).
const fs = require('fs'), path = require('path'), os = require('os');
const { startServer, launch, sleep, prepareBuild } = require('./harness');

(async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'fylo-t2-'));
  const orig = path.join(T, 'orig'), fixA = path.join(T, 'fixA'), fixB = path.join(T, 'fixB');
  const { state, port } = await startServer(orig);
  prepareBuild('/home/claude/fylo/orig/www', orig, port);
  prepareBuild('/home/claude/fylo/work/www', fixA, port);  fs.appendFileSync(path.join(fixA, 'app.js'), "\nwindow.__BUILD='FIX-A';\n");
  prepareBuild('/home/claude/fylo/work/www', fixB, port);  fs.appendFileSync(path.join(fixB, 'app.js'), "\nwindow.__BUILD='FIX-B';\n");
  const udd = path.join(T, 'profile');
  let failures = 0;
  const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) failures++; };

  async function session(root, label, waitMs, seed) {
    state.root = root;
    const { ctx, url } = await launch({ userDataDir: udd, port });
    const page = ctx.pages()[0] || await ctx.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(url, { waitUntil: 'load' });
    await sleep(1500);
    if (seed) await page.evaluate(seed);
    await sleep(waitMs);
    await page.click('.nav-item[data-page=settings]'); await sleep(400);
    const info = await page.evaluate(async () => ({
      build: window.__BUILD || null,
      regs: (await navigator.serviceWorker.getRegistrations()).length,
      caches: await caches.keys(),
      version: document.getElementById('app-version')?.textContent || null,
      deviceTab: !!document.getElementById('files-tab-device') && !document.getElementById('files-tab-device').classList.contains('hidden'),
      builtWith: /Built With/i.test(document.body.innerText),
      recent: [...document.querySelectorAll('#recent-list .recent-name')].map(e => e.textContent),
      light: document.documentElement.classList.contains('light-mode'),
    }));
    console.log('  ·', label, JSON.stringify(info), errors.length ? 'PAGEERRORS ' + errors.join('|') : '');
    await ctx.close();
    return info;
  }

  // Seed user data through IndexedDB exactly where the app keeps it (files store + settings_kv + bookmarks)
  const seed = async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('fylo_db', 3); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const pdf = new Blob(['%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF'], { type: 'application/pdf' });
    await new Promise((res, rej) => { const tx = db.transaction(['files', 'settings_kv', 'bookmarks'], 'readwrite');
      tx.objectStore('files').put({ id: 'seed1', name: 'precious.pdf', size: pdf.size, type: 'application/pdf', lastModified: 1, date: new Date().toISOString(), blob: pdf, thumbnail: null, offline: true });
      tx.objectStore('settings_kv').put({ key: 'darkMode', value: false });
      tx.objectStore('bookmarks').put({ id: 'seed1', pages: [1] });
      tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
  };

  console.log('== Install ORIGINAL build (old cache-first SW) and create user data ==');
  await session(orig, 'orig first launch (seeds data)', 2500, seed);
  const o2 = await session(orig, 'orig relaunch', 1500);
  check('setup: original build registered its cache-first service worker', o2.regs === 1 && o2.caches.includes('fylo-v6'));

  console.log('== UPGRADE to fixed build A (first launch after the update) ==');
  const a1 = await session(fixA, 'fix-A launch #1', 4000);
  check('upgrade shows the NEW version on the FIRST launch (original build needed a 2nd launch)', a1.build === 'FIX-A', 'build=' + a1.build);
  check('old service worker removed', a1.regs === 0, 'registrations=' + a1.regs);
  check('old Cache Storage removed', a1.caches.length === 0, JSON.stringify(a1.caches));
  check('user data survived: saved PDF still listed', a1.recent.includes('precious.pdf'), JSON.stringify(a1.recent));
  check('user data survived: saved setting (light theme) still applied', a1.light === true);
  check('Settings → version shows the new version string', /FYLO 2\.1\.0/.test(a1.version || ''), a1.version);
  check('"Built With" removed from Settings', a1.builtWith === false);
  check('"On device" tab available with the Android bridge', a1.deviceTab === false /* mock bridge has no scanDevicePdfs */, '(mock bridge without device APIs => hidden is correct)');

  console.log('== UPGRADE again to fixed build B (the case that used to stay stale forever) ==');
  const b1 = await session(fixB, 'fix-B launch #1', 2500);
  check('next update applies immediately (no service worker to go stale)', b1.build === 'FIX-B', 'build=' + b1.build);
  check('still no service worker / cache', b1.regs === 0 && b1.caches.length === 0);
  check('user data still present after the second upgrade', b1.recent.includes('precious.pdf'));

  console.log('== FRESH install of fixed build on an empty profile ==');
  fs.rmSync(udd, { recursive: true, force: true });
  const f1 = await session(fixA, 'fresh install', 2500);
  check('fresh install works, no service worker, correct version', f1.build === 'FIX-A' && f1.regs === 0 && /2\.1\.0/.test(f1.version));
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})();
