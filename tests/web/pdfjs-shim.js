/* Test-only stand-in for the pinned pdf.js 3.11.174 classic build (not obtainable offline here): exposes the same
 * `pdfjsLib.getDocument(...).promise` surface backed by the locally installed pdfjs-dist (ESM, v6). The base is
 * taken from the page, because this script is served from a (faked) CDN origin. */
(() => {
  let mod;
  const base = location.origin;
  const load = () => mod || (mod = import(base + '/__pdfjs/pdf.mjs').then(m => { m.GlobalWorkerOptions.workerSrc = base + '/__pdfjs/pdf.worker.mjs'; return m; }));
  window.pdfjsLib = { GlobalWorkerOptions: {}, getDocument: args => ({ promise: load().then(m => m.getDocument(args).promise) }) };
})();
