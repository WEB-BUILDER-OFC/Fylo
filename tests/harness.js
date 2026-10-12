// Shared test harness: serves a www/ directory at an Android-like origin and drives real Chromium.
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('/opt/npm-tools/node_modules/playwright');

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.pdf':'application/pdf' };
const HOST = 'appassets.localhost';   // stand-in for appassets.androidplatform.net (a secure context in Chromium; the real host is unreachable in this sandbox)

function startServer(initialRoot) {
  const state = { root: initialRoot, hits: [] };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    state.hits.push(u.pathname);
    if (u.pathname.startsWith('/device/')) {
      const id = decodeURIComponent(u.pathname.slice(8)).replace(/\.pdf$/, '');
      const buf = state.device && state.device[id];
      if (!buf) { res.writeHead(410); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/pdf' }); return res.end(buf);
    }
    let p = u.pathname.replace(/^\/assets\/www\//, '/');
    if (p === '/' ) p = '/index.html';
    const f = path.join(state.root, decodeURIComponent(p));
    if (!f.startsWith(state.root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });   // no cache headers, like WebViewAssetLoader
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, state, port: server.address().port })));
}

const BRIDGE = `
  window.__saved = []; window.__toasts = [];
  window.AndroidBridge = {
    saveFile(b64, name, mime){ if (window.__failSave) return JSON.stringify({success:false,error:'disk full (simulated)'}); window.__saved.push({name, mime, b64}); return JSON.stringify({success:true, path:'Downloads/FYLO/'+name}); },
    shareFile(){}, hasCameraPermission(){return true}, requestCameraPermission(){}, openFilePicker(){}, showToast(){},
    getPlatform(){return 'android'}, getAndroidVersion(){return '34'},
    clearTempFiles(){ return JSON.stringify({success:true,freedBytes:2048,count:2}); },
    getAppVersion(){ return JSON.stringify({versionName:'1.0.0',versionCode:7,lastUpdate:0}); }
  };`;

async function launch({ userDataDir, port, bridge = true, extraInit = '' }) {
  const origin = `http://${HOST}:${port}`;
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    args: ['--no-proxy-server'],
    acceptDownloads: true, viewport: { width: 412, height: 860 }, serviceWorkers: 'allow',
  });
  if (bridge) await ctx.addInitScript(BRIDGE + extraInit);
  return { ctx, origin, url: `${origin}/assets/www/index.html` };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Copy a www/ tree for testing, swapping ONLY the Android host name for the stand-in origin.
function prepareBuild(src, dst, port) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const f = path.join(d, e.name);
    if (e.isDirectory()) return walk(f);
    if (!/\.(js|html|css|json)$/.test(f) || /\.min\.js$/.test(f)) return;
    let t = fs.readFileSync(f, 'utf8'), o = t;
    t = t.split('https://appassets.androidplatform.net').join(`http://${HOST}:${port}`).split('appassets.androidplatform.net').join(HOST);
    if (t !== o) fs.writeFileSync(f, t);
  });
  walk(dst);
}
module.exports = { prepareBuild, startServer, launch, sleep, HOST, BRIDGE };
