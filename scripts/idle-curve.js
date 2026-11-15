// Stabilisation study: how long must the page idle before memory is stable?
// For each site: load + consent + scroll, then a light memory dump every 5 s for 120 s.
// node scripts/idle-curve.js [--runs 2] [--concurrency 3] [--mode accept]   (resumable)
// node scripts/idle-curve.js --analyse
const fs = require('fs');
const path = require('path');
const { measure } = require('../src/measure');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const OUT = path.resolve(__dirname, '..', 'results', 'idle-curve');
const IDS = ['20minutes', 'lefigaro', 'leparisien', 'lemonde', 'marmiton', 'ouest-france', 'francetvinfo',
  'amazon', 'conforama', 'ikea', 'cdiscount', 'service-public'];
const IDLE = 120000, STEP = 5000;
const MB = 1048576;

async function collect() {
  fs.mkdirSync(OUT, { recursive: true });
  const sites = require('../sites.json').filter(s => IDS.includes(s.id));
  const runs = +arg('runs', 2), conc = +arg('concurrency', 3), mode = arg('mode', 'accept');
  const tasks = [];
  for (let r = 1; r <= runs; r++) for (const s of sites) tasks.push({ s, r, file: path.join(OUT, `${s.id}__${mode}__r${r}.json`) });
  const todo = tasks.filter(t => !fs.existsSync(t.file));
  let i = 0, n = 0;
  const worker = async () => {
    while (i < todo.length) {
      const t = todo[i++];
      const t0 = Date.now();
      try {
        const res = await measure({ url: t.s.url, mode, idleMs: IDLE, curveStepMs: STEP, sampling: false, debuggerUrls: false });
        fs.writeFileSync(t.file, JSON.stringify({ site: t.s.id, category: t.s.category, mode, run: t.r,
          consent: res.consent && res.consent.outcome, blocked: res.blocked, curve: res.curve }));
        console.log(`[${++n}/${todo.length}] ${t.s.id} r${t.r} ${res.consent && res.consent.outcome} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      } catch (e) { console.log(`[${++n}/${todo.length}] ${t.s.id} r${t.r} ERROR ${e.message.split('\n')[0]}`); }
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
}

function analyse() {
  const runs = fs.readdirSync(OUT).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')))
    .filter(r => r.curve && r.curve.length && !r.blocked);
  const ts = [0, 5, 10, 15, 20, 30, 45, 60, 90, 120];
  const at = (c, s) => c.reduce((best, p) => (Math.abs(p.t - s * 1000) < Math.abs(best.t - s * 1000) ? p : best));
  const med = a => { a = [...a].sort((x, y) => x - y); return a.length ? (a[(a.length - 1) >> 1] + a[a.length >> 1]) / 2 : NaN; };
  console.log('Total renderers en % de la valeur à 60 s (et à 120 s), par run');
  console.log('run'.padEnd(22), ts.map(s => String(s).padStart(5)).join(''), '  MB@60  proc@0->120');
  const rel60 = {}, rel120 = {};
  for (const r of runs.sort((a, b) => a.site.localeCompare(b.site) || a.run - b.run)) {
    const v60 = at(r.curve, 60).total, v120 = at(r.curve, 120).total;
    const row = ts.map(s => { const v = at(r.curve, s).total; (rel60[s] = rel60[s] || []).push(v / v60); (rel120[s] = rel120[s] || []).push(v / v120); return (v / v60 * 100).toFixed(0).padStart(5); });
    console.log(`${r.site} r${r.run}`.padEnd(22), row.join(''), String((v60 / MB).toFixed(0)).padStart(7), `  ${r.curve[0].renderers}->${r.curve[r.curve.length - 1].renderers}`);
  }
  console.log('médiane vs 60s'.padEnd(22), ts.map(s => (med(rel60[s]) * 100).toFixed(0).padStart(5)).join(''));
  console.log('médiane vs 120s'.padEnd(22), ts.map(s => (med(rel120[s]) * 100).toFixed(0).padStart(5)).join(''));
  // shortest idle within ±5 % of the 60 s value, per run
  const within = s => runs.filter(r => { const v60 = at(r.curve, 60).total; return Math.abs(at(r.curve, s).total / v60 - 1) <= 0.05; }).length;
  console.log('runs à ±5 % de t=60s :', ts.filter(s => s <= 60).map(s => `${s}s:${within(s)}/${runs.length}`).join('  '));
}

if (argv.includes('--analyse')) analyse();
else collect().then(analyse);
