// Reproduce the "old version keeps appearing after an APK update" bug with the ORIGINAL build from the APK.
const fs = require('fs'), path = require('path'), os = require('os');
const { startServer, launch, sleep, prepareBuild } = require('./harness');

function cp(src, dst) { fs.rmSync(dst, { recursive: true, force: true }); fs.cpSync(src, dst, { recursive: true }); }
(async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'fylo-t1-'));
  const v1 = path.join(T, 'v1'), v2a = path.join(T, 'v2_sw_unchanged'), v2b = path.join(T, 'v2_sw_changed');
  const { state, port } = await startServer(v1);
  prepareBuild('/home/claude/fylo/orig/www', v1, port);
  // "New APK" variant A: app code changed, sw.js byte-identical (the developer did not bump CACHE_NAME)
  cp(v1, v2a); fs.appendFileSync(path.join(v2a, 'app.js'), "\nwindow.__BUILD='NEW';\n");
  // Variant B: app code changed AND sw.js bumped
  cp(v2a, v2b); fs.writeFileSync(path.join(v2b, 'sw.js'), fs.readFileSync(path.join(v2b, 'sw.js'), 'utf8').replace("'fylo-v6'", "'fylo-v7'"));

  const udd = path.join(T, 'profile');
  async function session(root, label, waitMs) {
    state.root = root;
    const { ctx, url } = await launch({ userDataDir: udd, port });
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(url, { waitUntil: 'load' });
    await sleep(waitMs);
    const info = await page.evaluate(async () => ({
      build: window.__BUILD || null,
      controlled: !!navigator.serviceWorker.controller,
      regs: (await navigator.serviceWorker.getRegistrations()).map(r => (r.active && r.active.scriptURL.split('/').pop()) + ':' + (r.waiting ? 'waiting' : 'noWaiting') + ':' + (r.installing ? 'installing' : '')),
      caches: await caches.keys(),
    }));
    console.log(label.padEnd(58), JSON.stringify(info));
    await ctx.close();
    return info;
  }
  console.log('--- ORIGINAL build, simulated upgrade on the same profile (same origin => same SW + Cache Storage, like an APK update) ---');
  await session(v1, '1) fresh install of v1 (first launch)', 3000);
  await session(v1, '2) relaunch v1 (SW now controls the page)', 2000);
  await session(v2a, '3) UPGRADE to v2, sw.js unchanged  -> expect NEW build', 3000);
  await session(v2a, '4) relaunch again                   -> expect NEW build', 3000);
  console.log('--- same, but the new APK ALSO changes sw.js ---');
  await session(v2b, '5) UPGRADE (sw.js changed), first launch', 3000);
  await session(v2b, '6) second launch', 3000);
  await session(v2b, '7) third launch', 3000);
  process.exit(0);
})();
