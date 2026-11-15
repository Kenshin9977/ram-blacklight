// A stratified sample of sites measured in a campaign (same share of each site type), for side studies
// such as the content-blocker comparison. Deterministic: same inputs, same sample.
// node scripts/sample-sites.js results/2026-11/summary.json 100 > sites-blockers.json
const fs = require('fs');
const path = require('path');

const [summaryFile, nArg = '100'] = process.argv.slice(2);
const n = +nArg;
const root = path.resolve(__dirname, '..');
const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
const list = JSON.parse(fs.readFileSync(path.join(root, 'sites-1000.json'), 'utf8'));

// measured = at least one valid mode; blocked sites are left out (they would block again)
const measured = new Set(summary.sites.filter(x => x.valid > 0 && x.pageTotal).map(x => x.site));
const pool = list.filter(s => measured.has(s.id));

// seeded shuffle (mulberry32), so the sample can be reproduced
let seed = 20261115;
const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const shuffled = pool.map(s => [rnd(), s]).sort((a, b) => a[0] - b[0]).map(x => x[1]);

const byCat = {};
for (const s of shuffled) (byCat[s.category] ||= []).push(s);
// largest remainder allocation of n across types
const quotas = Object.entries(byCat).map(([c, a]) => ({ c, exact: n * a.length / pool.length }));
for (const q of quotas) q.k = Math.floor(q.exact);
let left = n - quotas.reduce((s, q) => s + q.k, 0);
for (const q of [...quotas].sort((a, b) => (b.exact - b.k) - (a.exact - a.k))) { if (left-- <= 0) break; q.k++; }
const sample = quotas.flatMap(q => byCat[q.c].slice(0, q.k));
process.stdout.write(JSON.stringify(sample, null, 1) + '\n');
console.error(quotas.map(q => `${q.c}: ${q.k}`).join(', '));
