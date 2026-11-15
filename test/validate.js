// Ground-truth validation: serve a fixture with known allocations from 1st/3rd-party origins
// (localhost vs 127.0.0.1 are distinct sites), measure it, compare attribution with expectations.
// node test/validate.js [runs]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { measure } = require('../src/measure');
const { attributeRun, MB } = require('../src/attribute');

const dir = path.join(__dirname, 'fixture');
const PORT = 8765;
const server = http.createServer((req, res) => {
  const name = path.basename(req.url.split('?')[0]) || 'index.html';
  const f = path.join(dir, name);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  const type = f.endsWith('.html') ? 'text/html' : 'application/javascript';
  res.writeHead(200, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(f, 'utf8').replaceAll('PORT', String(PORT)));
});

// JS bytes (scaled to used heap) per script, main frame
function groupJs(raw) {
  const t = raw.targets.find(x => x.kind === 'main');
  const scale = t.postGC.used / t.sampled.total;
  if (!t.sampled.total) return {};
  const out = {};
  for (const [url, b] of Object.entries(t.sampled.byUrl)) {
    let k = '(sans URL)';
    if (url) { try { const u = new URL(url); k = u.hostname + u.pathname; } catch { k = '(interne) ' + url; } }
    out[k] = (out[k] || 0) + b * scale;
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, +(v / MB).toFixed(1)]));
}

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const runs = +(process.argv[2] || 3);
  const config = process.argv[3] || 'full'; // full | nodbg (sampling only) | bare (no sampling, no debugger)
  const opts = { full: {}, nodbg: { debuggerUrls: false }, bare: { debuggerUrls: false, sampling: false } }[config];
  const all = [];
  for (let i = 0; i < runs; i++) {
    const raw = await measure({ url: `http://localhost:${PORT}/index.html`, mode: 'none', idleMs: 3000, ...opts });
    fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'out', `raw-${i}.json`), JSON.stringify(raw));
    const a = attributeRun(raw);
    const r = {
      config,
      pageTotalMB: +(a.pageTotal / MB).toFixed(1),
      mainJsByScript: config === 'bare' ? null : groupJs(raw),
      mainUsedMB: +(a.main.used / MB).toFixed(1),
      mainFootprintMB: +(a.main.footprint / MB).toFixed(1),
      mainNonJsMB: +(a.entities.find(e => e.entity.startsWith('Processus principal')).bytes / MB).toFixed(1),
      iframeProcesses: a.entities.filter(e => e.iframes).map(e => ({ entity: e.entity, MB: +(e.bytes / MB).toFixed(1) })),
      oopifTargets: raw.targets.filter(x => x.kind === 'oopif').map(x => ({ usedMB: x.postGC && +(x.postGC.used / MB).toFixed(1), sampledMB: x.sampled && +(x.sampled.total / MB).toFixed(1), attachedAtMs: x.attachedAtMs })),
      coverage: +a.main.coverage.toFixed(2),
      byParty: { first: +(a.first / MB).toFixed(1), third: +(a.third / MB).toFixed(1), unattributed: +(a.unattributed / MB).toFixed(1) },
    };
    all.push(r);
    console.log(JSON.stringify(r));
  }
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'out', `validation-${config}.json`), JSON.stringify(all, null, 1));
  server.close();
})().catch(e => { console.error(e); process.exit(1); });
