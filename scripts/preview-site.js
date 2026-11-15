// Serve site/ locally and screenshot it (light, dark, phone width), exercising the game and the search.
// node scripts/preview-site.js [outDir]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const dir = path.resolve(__dirname, '..', 'site');
const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'tmp', 'preview'));
fs.mkdirSync(out, { recursive: true });
const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const f = path.join(dir, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!f.startsWith(dir) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(0, async () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ channel: 'chromium' });
  const errors = [];
  for (const [name, opts] of [['light', { colorScheme: 'light', viewport: { width: 1100, height: 900 } }], ['dark-phone', { colorScheme: 'dark', viewport: { width: 380, height: 800 } }]]) {
    const page = await browser.newPage(opts);
    page.on('pageerror', e => errors.push(name + ': ' + e.message));
    page.on('console', m => m.type() === 'error' && errors.push(name + ': ' + m.text()));
    await page.goto(url);
    await page.click('#game button[data-i="0"]');
    await page.waitForFunction(() => document.querySelector('#game button').textContent !== 'Jouer');
    await page.click('#game button[data-i="1"]');
    await page.fill('#q', 'lemonde');
    await page.dispatchEvent('#q', 'change');
    await page.waitForSelector('#res .card');
    // content-visibility:auto skips off-screen sections, which a full-page capture would show blank
    await page.addStyleTag({ content: 'section{content-visibility:visible!important}' });
    await page.screenshot({ path: path.join(out, name + '.png'), fullPage: true });
    await (await page.$('#categories')).screenshot({ path: path.join(out, name + '-categories.png') });
    const scroll =await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    if (scroll) errors.push(name + ': horizontal scroll');
    await page.close();
  }
  await browser.close(); server.close();
  console.log(errors.length ? errors.join('\n') : 'no errors', '->', out);
});
