// Aggregate raw runs -> per site x mode statistics (median, IQR, min/max, CV) + per-entity medians.
// node src/aggregate.js results/<campaign>
const fs = require('fs');
const path = require('path');
const { attributeRun, MB } = require('./attribute');
const { MAINTENANCE } = require('./measure');

const dir = path.resolve(process.argv[2] || 'results/latest');
// site categories (data/site-categories.json, reviewed by hand) override the one stored in the runs
let CATEGORIES = {};
try { CATEGORIES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'site-categories.json'), 'utf8')); } catch {}
const rawDir = path.join(dir, 'raw');

const q = (arr, p) => {
  const a = [...arr].sort((x, y) => x - y);
  if (!a.length) return null;
  const i = (a.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
};
const stats = arr => {
  const a = arr.filter(v => Number.isFinite(v));
  if (!a.length) return null;
  const mean = a.reduce((s, v) => s + v, 0) / a.length;
  const sd = Math.sqrt(a.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, a.length - 1));
  return { n: a.length, median: q(a, 0.5), p25: q(a, 0.25), p75: q(a, 0.75), min: Math.min(...a), max: Math.max(...a), cv: mean ? sd / mean : 0 };
};
const mb = s => s && Object.fromEntries(Object.entries(s).map(([k, v]) => [k, k === 'n' || k === 'cv' ? +v.toFixed(k === 'cv' ? 3 : 0) : +(v / MB).toFixed(1)]));

// Cross-check autoconsent's claimed outcome against the TCF state read in the measured visit.
// (autoconsent's heuristic opt-out once clicked "accept" on lemonde while reporting a refusal.)
function consentCheck(mode, tcf) {
  if (mode === 'none') return 'n/a';
  if (!tcf || !tcf.ok) return 'no-tcf';
  if (tcf.eventStatus === 'cmpuishown') return 'no-stored-choice';
  const v = tcf.vendorConsents || 0;
  if (mode === 'refuse') return v > 0 ? `MISMATCH:${v}-vendors-consented` : 'ok';
  return v > 0 ? 'ok' : 'MISMATCH:0-vendors';
}

const groups = {};
let baseline = [];
for (const f of fs.readdirSync(rawDir).filter(f => f.endsWith('.json'))) {
  const raw = JSON.parse(fs.readFileSync(path.join(rawDir, f), 'utf8'));
  if (raw.site && raw.site.id === '_baseline') {
    const a = attributeRun(raw);
    if (!a.error) baseline.push(a);
    continue;
  }
  const key = `${raw.site.id}__${raw.mode}`;
  const g = (groups[key] = groups[key] || { site: raw.site, mode: raw.mode, runs: [] });
  const a = attributeRun(raw, raw.site.aliases || []);
  a.run = raw.run;
  a.blocked = raw.blocked || (raw.consent && raw.consent.blocked) || (MAINTENANCE.test(raw.title || '') ? 'maintenance' : null);
  a.consentDetail = raw.consent ? { outcome: raw.consent.outcome, cmp: raw.consent.cmp, redirected: raw.consent.redirected } : null;
  a.tcf = raw.tcf || null;
  a.consentCheck = consentCheck(raw.mode, raw.tcf);
  a.error = a.error || raw.error || null;
  g.runs.push(a);
}

const summary = [];
for (const g of Object.values(groups)) {
  const ok = g.runs.filter(r => !r.error && !r.blocked);
  const entityNames = new Set(ok.flatMap(r => r.entities.map(e => e.entity)));
  const entities = [...entityNames].map(name => {
    const per = ok.map(r => (r.entities.find(e => e.entity === name) || { bytes: 0 }).bytes);
    const any = ok.flatMap(r => r.entities).find(e => e.entity === name);
    return { entity: name, category: any.category, party: any.party, presentIn: per.filter(b => b > 0).length, ...mb(stats(per)) };
  }).sort((a, b) => b.median - a.median);
  const cats = {};
  for (const r of ok) for (const [c, b] of Object.entries(r.byCategory)) (cats[c] = cats[c] || []).push(b);
  summary.push({
    site: g.site.id, url: g.site.url, siteCategory: CATEGORIES[g.site.id] || g.site.category, mode: g.mode,
    runs: g.runs.length, valid: ok.length,
    blocked: g.runs.map(r => r.blocked).find(Boolean) || null,
    errors: g.runs.filter(r => r.error).map(r => r.error),
    consent: [...new Set(g.runs.map(r => r.consentDetail && `${r.consentDetail.outcome}${r.consentDetail.cmp ? ':' + r.consentDetail.cmp : ''}${r.consentDetail.redirected ? '+redirect' : ''}`))],
    tcfVendors: [...new Set(g.runs.map(r => r.tcf && r.tcf.vendorConsents))],
    consentCheck: [...new Set(g.runs.map(r => r.consentCheck))],
    pageTotal: mb(stats(ok.map(r => r.pageTotal))),
    pageTotalAfterGC: mb(stats(ok.map(r => r.pageTotalGC))),
    browserShared: mb(stats(ok.map(r => r.shared))),
    first: mb(stats(ok.map(r => r.first))),
    third: mb(stats(ok.map(r => r.third))),
    unattributed: mb(stats(ok.map(r => r.unattributed))),
    thirdShare: stats(ok.map(r => r.thirdShare)),
    thirdShareProportional: stats(ok.map(r => r.proportional.thirdShare)),
    renderers: stats(ok.map(r => r.processes.renderers)),
    frames: stats(ok.map(r => r.frames)),
    jsCoverage: stats(ok.map(r => r.main.coverage)),
    thirdPartyDomains: stats(ok.map(r => r.network.thirdDomains)),
    byCategory: Object.fromEntries(Object.entries(cats).map(([c, a]) => [c, +(q(a.concat(Array(ok.length - a.length).fill(0)), 0.5) / MB).toFixed(1)])),
    entities: entities.slice(0, 25),
    topScripts: (ok[0] && ok[0].topScripts) || [],
  });
}
summary.sort((a, b) => a.site.localeCompare(b.site) || a.mode.localeCompare(b.mode));
// sites x modes with no measurement: blocked at consent time, or skipped (no CMP -> one mode only)
const notMeasured = [];
const cDir = path.join(dir, 'consent');
if (fs.existsSync(cDir)) for (const f of fs.readdirSync(cDir)) {
  const c = JSON.parse(fs.readFileSync(path.join(cDir, f), 'utf8'));
  const [site, mode] = f.replace('.json', '').split('__');
  if (c.skipped) notMeasured.push({ site, mode, reason: c.skipped });
  else if (c.consent && c.consent.blocked) notMeasured.push({ site, mode, reason: 'blocked: ' + c.consent.blocked });
}
const base = { pageTotal: mb(stats(baseline.map(b => b.pageTotal))), browserShared: mb(stats(baseline.map(b => b.shared))) };
fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ generatedAt: new Date().toISOString(), baseline: base, sites: summary, notMeasured }, null, 1));
for (const n of notMeasured) console.log(`non mesuré: ${n.site}/${n.mode} (${n.reason})`);

// console table
const pct = s => (s ? (s.median * 100).toFixed(0) + '%' : '-');
console.log(`baseline about:blank: page ${base.pageTotal && base.pageTotal.median} MB, browser+GPU ${base.browserShared && base.browserShared.median} MB`);
console.log('site'.padEnd(15), 'mode'.padEnd(7), 'n', 'page MB (median [min-max])'.padEnd(27), 'CV'.padEnd(6), '3P', '3P+', 'proc', 'consent');
for (const s of summary) {
  if (!s.valid) { console.log(s.site.padEnd(15), s.mode.padEnd(7), s.valid, 'BLOCKED/ERROR', s.blocked || s.errors[0]); continue; }
  const p = s.pageTotal;
  console.log(s.site.padEnd(15), s.mode.padEnd(7), s.valid, `${p.median} [${p.min}-${p.max}]`.padEnd(27), String(p.cv).padEnd(6), pct(s.thirdShare).padEnd(3), pct(s.thirdShareProportional).padEnd(4), String(s.renderers.median).padEnd(4), s.consent.join(','), 'tcf:' + s.consentCheck.join(','));
}
