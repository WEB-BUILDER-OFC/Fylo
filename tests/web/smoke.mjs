import { chromium, open, rec, sleep } from './lib.mjs';
const b = await chromium.launch({ args: ['--no-sandbox'] });
for (const mode of ['web', 'android']) {
  const s = await open(b, mode);
  await s.page.goto(s.url); await sleep(2500);
  console.log(mode, 'title', await s.page.title(), 'errors', s.logs.errors, s.logs.console.slice(0, 5));
  console.log('menu-btn', await s.page.locator('#menu-btn').count(), 'sw', await s.page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map(r => r.active?.scriptURL)));
  await s.close();
}
await b.close();
