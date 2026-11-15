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
const site = host => s.sites.find(x => x.id === host);

const thisPage = +arg('this-page-mb', 0) || null;
const campaign = arg('campaign', summary.generatedAt.slice(0, 7));
const media = s.categories.find(c => c.key === 'media');

// scale: from this page to the heaviest page
const heaviest = s.sites[0];
const scale = [
  thisPage && ['Cette page', thisPage, 'me'],
  ['Onglet vide', s.baseline, 'k'],
  ...s.sites.filter(x => /(^|\.)wikipedia\.org$/.test(x.id) && x.a).slice(0, 1).map(x => [x.id, x.a, 'k']),
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
const adEntityCount = ents.filter(e => e.category === 'pub').length;

const catName = c => esc(CATEGORY_LABELS[c] || c);
const wallRows = s.walls.map(w => `<tr><td><b>${esc(w.id)}</b><small>${catName(w.c)}</small></td><td class="num">${w.a ? fmt(w.a) : '–'}</td><td><small>${esc(w.landing)}</small></td></tr>`).join('');
const adRows = s.adAfterRefusal.slice(0, 15).map(x => `<tr><td><b>${esc(x.id)}</b><small>${esc(x.ents.slice(0, 4).join(', '))}${x.ents.length > 4 ? '…' : ''}</small></td><td class="num">${fmt(x.mb)}</td><td class="num">${x.acceptMb == null ? '–' : fmt(x.acceptMb)}</td></tr>`).join('');
const catOptions = Object.entries(CATEGORY_LABELS).filter(([k]) => s.sites.some(x => x.c === k)).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('');
const csv = `ram-blacklight-${arg('campaign', summary.generatedAt.slice(0, 7))}.csv`;

const tabsData = [['médias en acceptant', media.pairAccept], ['médias en refusant', media.pairRefuse], ['pages médianes', s.accept.median]];
const tabsDefault = tabsData.map(t => `<b>${Math.floor(4 * 1024 / t[1])}</b> ${t[0]}`).join(' · ');

const blockedTop = Object.entries(s.blockedReasons).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${v} ${{ 'http-403': 'refus d\'accès', captcha: 'captcha', challenge: 'vérification anti-robot', 'blocked-page': 'page de blocage', 'http-429': 'trop de requêtes', 'http-503': 'service indisponible' }[k] || k}`).join(', ');

// per-site data for the table: [host, category, accept MB, refuse MB, third %, consent states, max CV %, top third parties, wall landing, ad MB after refusal]
const data = s.sites.map(x => [x.id, x.c, x.a, x.r, x.t, x.k, x.v, x.top, x.w, x.ad]);
const dataJson = JSON.stringify(data);
const KSTATE = { a: 'accepté', r: 'refusé', n: 'pas de bannière', p: 'mur (refuser = s\'abonner ou se connecter)', '?': 'non vérifié', '': '' };
const cell = v => v == null ? '' : /[",\n;]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
const csvText = [['site', 'type', 'ram_accepte_mo', 'ram_refuse_mo', 'part_tiers_pct', 'choix_accepter', 'choix_refuser', 'page_apres_refus', 'pub_apres_refus_mo', 'variabilite_max_pct', 'principaux_tiers'],
  ...s.sites.map(x => [x.id, CATEGORY_LABELS[x.c] || x.c, x.a, x.k[1] === 'p' ? null : x.r, x.t, KSTATE[x.k[0]], KSTATE[x.k[1] || ''], x.w, x.ad, x.v, x.top.map(t => `${t[0]} (${t[1]} Mo)`).join(' | ')])]
  .map(r => r.map(cell).join(',')).join('\n') + '\n';

const months = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const d = new Date(summary.generatedAt);
const vars = {
  campaign, campaignDate: `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`,
  listed: s.listed, measured: s.measured, notMeasured: s.notMeasured, pairs: s.pairs.n,
  acceptMedian: fmt(s.accept.median), over1g: s.accept.over1g,
  mediaRatio: Math.round(media.pairAccept / media.pairRefuse), mediaAccept: fmt(media.pairAccept), mediaRefuse: fmt(media.pairRefuse),
  mediaThird: Math.round(media.thirdShare * 100), thirdShareMedian: Math.round(s.thirdShareMedian * 100),
  thisPage: thisPage ? fmt(thisPage) : 'à mesurer', baseline: fmt(s.baseline),
  scaleBars, categoryBars, categoryRows, entityBars, entityCount: ents.length, adEntityCount,
  wallCount: s.walls.length, wallRows, adCount: s.adAfterRefusal.length, adRows, refusedOkCount: s.refusedOkCount,
  unsure: s.sites.filter(x => x.k.includes('?')).length, catOptions, csv,
  ratioMedian: String(s.pairs.ratioMedian.toFixed(1)).replace('.', ','), ratioP75: String(s.pairs.ratioP75).replace('.', ','),
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
for (const f of fs.readdirSync(out).filter(f => /^ram-blacklight-.*\.csv$/.test(f))) fs.unlinkSync(path.join(out, f));
fs.writeFileSync(path.join(out, csv), '﻿' + csvText); // BOM so spreadsheet apps read the accents
// long cache for nothing: the page is tiny, but say so explicitly; no other headers needed
fs.writeFileSync(path.join(out, '_headers'), '/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  Content-Security-Policy: default-src \'self\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; img-src data:\n');
console.log(`site/: index.html ${(Buffer.byteLength(html) / 1024).toFixed(1)} kB, sites.json ${vars.dataKb} kB`);
