// Build the public site (site/) from a campaign's summary.json: one static page + the per-site data.
// node scripts/build-site.js results/<campaign>/summary.json [--this-page-mb 12] [--campaign 2026-11]
const fs = require('fs');
const path = require('path');
const { siteStats, CATEGORY_LABELS } = require('./site-stats');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const root = path.resolve(__dirname, '..');
const summary = JSON.parse(fs.readFileSync(argv[0], 'utf8'));
const list = JSON.parse(fs.readFileSync(path.join(root, 'sites-1000.json'), 'utf8'));
const s = siteStats(summary, list);
const REPO = 'https://github.com/Kenshin9977/ram-blacklight';

const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = m => m >= 1000 ? (m / 1024).toFixed(1).replace('.', ',') + ' Go' : Math.round(m) + ' Mo';
const pct = (v, max) => (Math.max(v / max, 0.004) * 100).toFixed(1);
const bar = (cls, v, max, label) => `<div class="b ${cls}"><i style="width:${(pct(v, max) * 0.8).toFixed(1)}%"></i>${label ? label + ' : ' : ''}${fmt(v)}</div>`;
const site = id => s.sites.find(x => x.id === id);

const thisPage = +arg('this-page-mb', 0) || null;
const campaign = arg('campaign', summary.generatedAt.slice(0, 7));
const media = s.categories.find(c => c.key === 'media');

// scale: from this page to the heaviest page
const heaviest = s.sites[0];
const scale = [
  thisPage && ['Cette page', thisPage, 'me'],
  ['Onglet vide', s.baseline, 'k'],
  site('wikipedia.org') && ['wikipedia.org', site('wikipedia.org').a, 'k'],
  ['Page médiane du top', s.accept.median, 'k'],
  ['Média médian, cookies refusés', media.pairRefuse, 'r'],
  ['Média médian, cookies acceptés', media.pairAccept, ''],
  [`${heaviest.id} (la plus lourde)`, heaviest.a, ''],
].filter(Boolean);
const scaleMax = Math.max(...scale.map(x => x[1]));
const scaleBars = scale.map(([n, v, c]) => `<li><span class="n">${esc(n)}</span>${bar(c, v, scaleMax)}</li>`).join('');

const cats = s.categories.filter(c => c.pairs >= 5).sort((a, b) => b.pairAccept - a.pairAccept);
const catMax = Math.max(...cats.map(c => c.pairAccept));
const categoryBars = cats.map(c => `<li><span class="n">${esc(c.label)}<small>${c.pairs} sites, ×${(c.pairAccept / c.pairRefuse).toFixed(1).replace('.', ',')}</small></span><span>${bar('', c.pairAccept, catMax)}${bar('r', c.pairRefuse, catMax)}</span></li>`).join('');
const categoryRows = s.categories.map(c => `<tr><td>${esc(c.label)}</td><td>${c.measured} / ${c.sites}</td><td>${fmt(c.acceptMedian)}</td><td>${fmt(c.acceptP90)}</td><td>${Math.round(c.thirdShare * 100)} %</td></tr>`).join('');

const ents = s.entities.slice(0, 10);
const entMax = ents[0].mb;
const entityBars = ents.map(e => `<li><span class="n">${esc(e.entity)}<small>${e.sites} sites</small></span>${bar('', e.mb, entMax)}</li>`).join('');
const adCount = ents.filter(e => e.category === 'pub').length;

const tabsData = [['médias en acceptant', media.pairAccept], ['médias en refusant', media.pairRefuse], ['pages médianes', s.accept.median]];
const tabsDefault = tabsData.map(t => `<b>${Math.floor(4 * 1024 / t[1])}</b> ${t[0]}`).join(' · ');

const blockedTop = Object.entries(s.blockedReasons).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${v} ${{ 'http-403': 'refus d\'accès', captcha: 'captcha', challenge: 'vérification anti-robot', 'blocked-page': 'page de blocage', 'http-429': 'trop de requêtes', 'http-503': 'service indisponible' }[k] || k}`).join(', ');

// per-site data for the game and the search: [id, category, accept MB, refuse MB, third %, consent states, max CV %, top third parties]
const data = s.sites.map(x => [x.id, x.c, x.a, x.r, x.t, x.k, x.v, x.top]);
const dataJson = JSON.stringify(data);

const months = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const d = new Date(summary.generatedAt);
const vars = {
  campaign, campaignDate: `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`,
  listed: s.listed, measured: s.measured, notMeasured: s.notMeasured, pairs: s.pairs.n,
  acceptMedian: fmt(s.accept.median), over1g: s.accept.over1g,
  mediaRatio: Math.round(media.pairAccept / media.pairRefuse), mediaAccept: fmt(media.pairAccept), mediaRefuse: fmt(media.pairRefuse),
  mediaThird: Math.round(media.thirdShare * 100), thirdShareMedian: Math.round(s.thirdShareMedian * 100),
  thisPage: thisPage ? fmt(thisPage) : 'à mesurer',
  scaleBars, categoryBars, categoryRows, entityBars, entityCount: ents.length, adCount,
  tabsDefault, tabsData: JSON.stringify(tabsData), catLabels: JSON.stringify(CATEGORY_LABELS),
  chrome: (summary.chrome || '134'), blockedTop, cvMedian: Math.round(s.variability.cvMedian * 100) || 2, over20: s.variability.over20,
  dataKb: Math.round(Buffer.byteLength(dataJson) / 1024), repo: REPO, repoShort: REPO.replace('https://', ''),
};

let html = fs.readFileSync(path.join(root, 'site-src', 'index.html'), 'utf8');
html = html.replace(/\{\{(\w+)\}\}/g, (m, k) => { if (!(k in vars)) throw new Error('missing ' + k); return vars[k]; });
const out = path.join(root, 'site');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.writeFileSync(path.join(out, 'sites.json'), dataJson);
// long cache for nothing: the page is tiny, but say so explicitly; no other headers needed
fs.writeFileSync(path.join(out, '_headers'), '/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  Content-Security-Policy: default-src \'self\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; img-src data:\n');
console.log(`site/: index.html ${(Buffer.byteLength(html) / 1024).toFixed(1)} kB, sites.json ${vars.dataKb} kB`);
