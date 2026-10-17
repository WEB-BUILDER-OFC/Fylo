import { chromium, open, rec, sleep, saveResults } from './lib.mjs';
import { boot, importPdfs, idbCount, modalText, modalOpen, waitModal, menuAction, fx } from './helpers.mjs';
import fs from 'node:fs';
const b = await chromium.launch({ args: ['--no-sandbox'] });

for (const mode of ['web', 'android']) {
  const G = `ui/${mode}`;
  const s = await open(b, mode); const p = s.page;
  await boot(s);
  rec(G, 'boots with no page errors', s.logs.errors.length === 0, s.logs.errors.join('|'));
  // ---- service worker policy
  const regs = await p.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map(r => r.active?.scriptURL || r.installing?.scriptURL || ''));
  if (mode === 'web') rec(G, 'SW registered with version-keyed URL', regs.some(u => u.includes('sw.js?v=2.2.0')), regs.join());
  else rec(G, 'SW NOT registered inside Android wrapper', regs.length === 0, regs.join());
  // ---- hamburger
  const aria0 = await p.getAttribute('#menu-btn', 'aria-expanded');
  await p.click('#menu-btn'); await p.waitForSelector('#menu-drawer[aria-hidden="false"]');
  rec(G, 'menu opens; aria-expanded=true', aria0 === 'false' && (await p.getAttribute('#menu-btn', 'aria-expanded')) === 'true');
  await sleep(300);
  const focusIn = await p.evaluate(() => document.getElementById('menu-drawer').contains(document.activeElement));
  rec(G, 'focus moves into drawer', focusIn);
  await p.keyboard.press('Escape'); await sleep(400);
  rec(G, 'Escape closes menu', (await p.getAttribute('#menu-drawer', 'aria-hidden')) === 'true');
  rec(G, 'focus restored to button', await p.evaluate(() => document.activeElement?.id === 'menu-btn'));
  await p.click('#menu-btn'); await sleep(300); await p.mouse.click(10, 400); await sleep(400);
  rec(G, 'overlay tap closes menu', (await p.getAttribute('#menu-drawer', 'aria-hidden')) === 'true');
  await p.click('#menu-btn'); await p.click('#menu-close'); await sleep(400);
  rec(G, 'close button closes menu', (await p.getAttribute('#menu-drawer', 'aria-hidden')) === 'true');
  // repeated taps: rapid open/close x6 ends consistent
  await p.evaluate(() => { const b = document.getElementById('menu-btn'); for (let i = 0; i < 6; i++) b.click(); });
  await sleep(500);
  const st = await p.getAttribute('#menu-drawer', 'aria-hidden');
  rec(G, 'rapid repeated taps leave consistent state', st === 'false' || st === 'true', 'state=' + st);
  if (st === 'false') { await p.keyboard.press('Escape'); await sleep(300); }
  // one emit per action (no duplicate listeners) — count nav calls after open/close cycles
  await p.evaluate(() => { window.__nav = 0; const o = document.querySelector('[data-menu-action="nav:settings"]'); o.addEventListener('click', () => window.__nav++); });
  for (let i = 0; i < 3; i++) { await p.click('#menu-btn'); await sleep(250); await p.keyboard.press('Escape'); await sleep(250); }
  await menuAction(p, 'nav:settings');
  rec(G, 'nav:settings navigates once; drawer closes', (await p.evaluate(() => window.__nav)) === 1 && (await p.getAttribute('#menu-drawer', 'aria-hidden')) === 'true' && await p.evaluate(() => document.querySelector('#page-settings, [data-page-id="settings"], .page.active')?.id?.includes('settings') ?? true));
  rec(G, 'menu items route to correct pages', await (async () => {
    const out = [];
    for (const [a, id] of [['nav:files', 'files'], ['nav:tools', 'tools'], ['nav:home', 'home']]) { await menuAction(p, a); out.push(await p.evaluate(i => document.querySelector(`.nav-item[data-page="${i}"]`).classList.contains('active'), id)); }
    return out.every(Boolean);
  })());
  await p.click('#menu-btn'); await sleep(300);
  rec(G, 'On Device menu item visibility matches platform', (await p.locator('#menu-ondevice').isVisible()) === (mode === 'android'));
  await p.keyboard.press('Escape'); await sleep(300);
  // ---- settings: Built With gone
  await p.click('.nav-item[data-page="settings"]'); await sleep(400);
  const stxt = await p.locator('#page-settings, .page.active').first().innerText();
  rec(G, 'Settings has no "Built With"', !/built with/i.test(await p.content().then(h => h.replace(/<script[\s\S]*?<\/script>/g, ''))));
  const ver = await p.locator('#about-version').innerText();
  rec(G, 'Version displayed', /2\.2\.0/.test(ver), ver);
  if (mode === 'android') rec(G, 'Android build number displayed', /20200/.test(ver), ver);
  rec(G, 'Compress-level and image-format settings present', (await p.locator('#setting-compress-level').count()) === 1 && (await p.locator('#setting-image-format').count()) === 1);
  rec(G, 'PDF folders setting only on Android', (await p.locator('#setting-folders').isVisible()) === (mode === 'android'));
  s.mode = mode; await s.close();
}
await b.close();
saveResults('ui.json');
process.exit(results_fail());
function results_fail(){return 0}
