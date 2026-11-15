// Debug: print the sampling heap profile tree of a single fixture run (nodes >= 100 KB cumulative).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const dir = path.join(__dirname, '..', 'test', 'fixture');
const PORT = 8766;
const server = http.createServer((req, res) => {
  const f = path.join(dir, path.basename(req.url.split('?')[0]) || 'index.html');
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': (f.endsWith('.html') ? 'text/html' : 'application/javascript') + '; charset=utf-8' });
  res.end(fs.readFileSync(f, 'utf8').replaceAll('PORT', String(PORT)));
});
(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch({ channel: 'chromium', args: ['--site-per-process'] });
  const page = await browser.newPage();
  const s = await page.context().newCDPSession(page);
  const scripts = {}; s.on('Debugger.scriptParsed', e => { scripts[e.scriptId] = e.url; });
  if (process.argv[2] === 'dbg') await s.send('Debugger.enable');
  await s.send('HeapProfiler.enable');
  await s.send('HeapProfiler.startSampling', { samplingInterval: 16384 });
  if (process.argv[2] === 'warm') await page.goto(`http://localhost:${PORT}/nothing`).catch(() => {});
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(1500);
  await s.send('HeapProfiler.collectGarbage');
  const { profile } = await s.send('HeapProfiler.stopSampling');
  const cum = n => (n.cum = n.selfSize + (n.children || []).reduce((a, c) => a + cum(c), 0));
  cum(profile.head);
  const pr = (n, d) => {
    if (n.cum < 100000) return;
    console.log('  '.repeat(d) + `[sid=${n.callFrame.scriptId} col=${n.callFrame.columnNumber}] ${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.replace(/^http:\/\//, '')}:${n.callFrame.lineNumber} self=${(n.selfSize / 1048576).toFixed(2)} cum=${(n.cum / 1048576).toFixed(2)}`);
    for (const c of n.children || []) pr(c, d + 1);
  };
  pr(profile.head, 0);
  console.log('scripts', JSON.stringify(scripts));
  await browser.close(); server.close();
})();
