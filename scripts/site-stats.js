// Headline figures of a campaign, from its summary.json (used by REPORT.md and the public site).
// node scripts/site-stats.js results/<campaign>/summary.json  -> prints JSON
const fs = require('fs');

const CATEGORY_LABELS = {
  media: 'Médias', ecommerce: 'E-commerce', administration: 'Administration', 'banque-assurance': 'Banque, assurance',
  services: 'Services (télécom, énergie, mail)', 'voyage-transport': 'Voyage, transport', 'annonces-emploi-immo': 'Annonces, emploi, immobilier',
  divertissement: 'Divertissement', sport: 'Sport, paris', 'social-forums': 'Réseaux sociaux, forums', 'tech-outils': 'Outils, tech',
  'education-sante': 'Éducation, santé', 'loisirs-pratique': 'Loisirs, pratique', autre: 'Autre',
};

const q = (arr, p) => {
  const a = [...arr].sort((x, y) => x - y);
  if (!a.length) return null;
  const i = (a.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
};
const r0 = v => v == null ? null : Math.round(v);
// A refusal that lands on a subscription, payment or sign-in page: the site offers "accept, or pay / sign in"
// (CNIL: a cookie wall is judged case by case, see the site). Its "refuse" measurement is the wall, not the site.
const WALL_URL = /abonn|subscri|paywall|passprisma|checkout\.stripe|cookiewall|inscription|login|signup|\/offre\/|services\/solutions|\/\/connect\./i;
const wallOf = rows => {
  for (const x of rows) {
    if (x.mode !== 'refuse') continue;
    const l = (x.consentLanding || []).find(u => WALL_URL.test(u));
    if (l) return l.replace(/^https:\/\//, '');
    if ((x.consent || []).some(c => c && /pay-or-accept/.test(c))) return 'mur « accepter ou s\'abonner »';
  }
  return null;
};
const ok = (x, word) => (x.consent || []).some(c => c && c.startsWith(word));

function siteStats(summary, sitesList) {
  const valid = summary.sites.filter(x => x.valid > 0 && x.pageTotal);
  const by = {};
  for (const x of valid) (by[x.site] ||= { cat: x.siteCategory, url: x.url })[x.mode] = x;
  const listIds = sitesList.map(s => s.id);
  const measured = Object.keys(by);
  // a mode measured with the opposite consent state (TCF says so) is not shown as that mode
  const trusted = x => x && !(x.consentCheck || []).some(c => c.startsWith('MISMATCH'));
  const walls = {};
  for (const id of new Set(summary.sites.map(x => x.site))) { const w = wallOf(summary.sites.filter(x => x.site === id)); if (w) walls[id] = w; }
  for (const [id, p] of Object.entries(by)) p.id = id;
  const refusedOk = p => p.refuse && trusted(p.refuse) && ok(p.refuse, 'refused') && !walls[p.id];
  const clean = Object.values(by).filter(p => !walls[p.id] && trusted(p.accept) && trusted(p.refuse) && ok(p.accept, 'accepted') && ok(p.refuse, 'refused'));
  const ratios = clean.map(p => p.accept.pageTotal.median / p.refuse.pageTotal.median);
  const acceptAll = valid.filter(x => x.mode === 'accept').map(x => x.pageTotal.median);
  const cvs = valid.map(x => x.pageTotal.cv);

  const categories = Object.entries(CATEGORY_LABELS).map(([key, label]) => {
    const inCat = Object.values(by).filter(p => p.cat === key);
    const cl = clean.filter(p => p.cat === key);
    const acc = inCat.filter(p => p.accept).map(p => p.accept.pageTotal.median);
    return {
      key, label, sites: listIds.filter(id => (sitesList.find(s => s.id === id).category) === key).length, measured: inCat.length,
      acceptMedian: r0(q(acc, 0.5)), acceptP90: r0(q(acc, 0.9)),
      pairs: cl.length, pairAccept: r0(q(cl.map(p => p.accept.pageTotal.median), 0.5)), pairRefuse: r0(q(cl.map(p => p.refuse.pageTotal.median), 0.5)),
      thirdShare: +(q(inCat.filter(p => p.accept).map(p => p.accept.thirdShare.median), 0.5) || 0).toFixed(2),
    };
  }).filter(c => c.measured).sort((a, b) => b.acceptMedian - a.acceptMedian);

  const ent = {};
  for (const x of valid.filter(x => x.mode === 'accept')) for (const e of x.entities || []) {
    if (e.party !== 'third') continue;
    const o = ent[e.entity] ||= { entity: e.entity, category: e.category, mb: 0, sites: 0 };
    o.mb += e.median; o.sites++;
  }
  const entities = Object.values(ent).sort((a, b) => b.mb - a.mb).slice(0, 15).map(e => ({ ...e, mb: r0(e.mb) }));

  const blockedReasons = {};
  for (const id of listIds.filter(id => !by[id])) {
    const rows = summary.sites.filter(x => x.site === id);
    const nm = (summary.notMeasured || []).find(n => n.site === id);
    const reason = (rows.find(x => x.blocked) || {}).blocked || (nm && nm.reason.replace(/^blocked: /, '')) || 'autre';
    blockedReasons[reason] = (blockedReasons[reason] || 0) + 1;
  }

  const host = p => new URL(p.url).hostname.replace(/^www\./, '');
  const adMb = x => r0((x.byCategory || {}).pub || 0);
  // ad code still running after a refusal the site recorded: a fact, not a verdict (non-targeted ads need no consent)
  const adAfterRefusal = Object.values(by).filter(refusedOk).map(p => ({ id: host(p), c: p.cat, mb: adMb(p.refuse),
    acceptMb: p.accept && trusted(p.accept) && ok(p.accept, 'accepted') ? adMb(p.accept) : null, // null: the accept click did not happen
    ents: (p.refuse.entities || []).filter(e => e.category === 'pub').map(e => e.entity) })).filter(x => x.mb >= 20).sort((a, b) => b.mb - a.mb);
  const wallList = Object.entries(walls).map(([id, landing]) => {
    const p = by[id], row = summary.sites.find(x => x.site === id);
    return { id: host(p || row), c: (p && p.cat) || row.siteCategory, landing, a: p && p.accept ? r0(p.accept.pageTotal.median) : null };
  }).sort((a, b) => (b.a || 0) - (a.a || 0));

  const sites = Object.entries(by).map(([id, p]) => ({
    // shown and searched by host name (hand-picked sites have short ids such as "impots")
    id: new URL(p.url).hostname.replace(/^www\./, ''), c: p.cat,
    a: p.accept ? r0(p.accept.pageTotal.median) : null, r: p.refuse ? r0(p.refuse.pageTotal.median) : null,
    t: p.accept ? r0(p.accept.thirdShare.median * 100) : null,
    // consent states the mode really had: a = accepted, r = refused, n = no banner, p = refusal leads to a wall, ? = not sure
    k: [p.accept, p.refuse].map((x, i) => !x ? '' : i && walls[id] ? 'p' : !trusted(x) ? '?' : ok(x, i ? 'refused' : 'accepted') ? 'ar'[i] : ok(x, 'no-cmp') ? 'n' : '?').join(''),
    w: walls[id] || null, ad: refusedOk(p) ? adMb(p.refuse) : null,
    v: r0(Math.max(...[p.accept, p.refuse].filter(Boolean).map(x => x.pageTotal.cv)) * 100),
    top: p.accept ? (p.accept.entities || []).filter(e => e.party === 'third').slice(0, 3).map(e => [e.entity, r0(e.median)]) : [],
  })).sort((a, b) => (b.a || b.r) - (a.a || a.r));

  return {
    generatedAt: summary.generatedAt,
    listed: listIds.length, measured: measured.length, notMeasured: listIds.length - measured.length, blockedReasons,
    baseline: summary.baseline.pageTotal.median,
    accept: { n: acceptAll.length, median: r0(q(acceptAll, 0.5)), p90: r0(q(acceptAll, 0.9)), max: r0(Math.max(...acceptAll)),
      over500: acceptAll.filter(v => v > 500).length, over1g: acceptAll.filter(v => v > 1024).length },
    pairs: { n: clean.length, acceptMedian: r0(q(clean.map(p => p.accept.pageTotal.median), 0.5)), refuseMedian: r0(q(clean.map(p => p.refuse.pageTotal.median), 0.5)),
      ratioMedian: +q(ratios, 0.5).toFixed(2), ratioP75: +q(ratios, 0.75).toFixed(1), ratioP90: +q(ratios, 0.9).toFixed(1),
      over2x: ratios.filter(r => r > 2).length, over4x: ratios.filter(r => r > 4).length },
    thirdShareMedian: +q(valid.filter(x => x.mode === 'accept').map(x => x.thirdShare.median), 0.5).toFixed(2),
    variability: { cvMedian: +q(cvs, 0.5).toFixed(3), over5: cvs.filter(c => c > 0.05).length, over20: cvs.filter(c => c > 0.2).length, n: cvs.length },
    categories, entities, sites, walls: wallList, adAfterRefusal, refusedOkCount: Object.values(by).filter(refusedOk).length,
  };
}

module.exports = { siteStats, CATEGORY_LABELS };
if (require.main === module) {
  const summary = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const list = JSON.parse(fs.readFileSync(process.argv[3] || 'sites-1000.json', 'utf8'));
  const s = siteStats(summary, list);
  console.log(JSON.stringify({ ...s, sites: s.sites.length, adAfterRefusal: s.adAfterRefusal.length }, null, 1));
}
