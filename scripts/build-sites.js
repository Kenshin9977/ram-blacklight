// Build the campaign site list from the CrUX France top list.
// node scripts/build-sites.js [--n 1000] [--crux data/crux-fr-202610.csv.gz] [--out sites-1000.json]
//  - one origin per registrable domain (eTLD+1), www/apex preferred
//  - drops technical / logged-in origins (auth, idp, mail, payment, app, api...)
//  - drops adult and malware domains via Cloudflare's family resolver (1.1.1.3, answers 0.0.0.0)
//  - keeps the 20 hand-curated sites (sites.json) with their categories and aliases
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { parse } = require('tldts');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const N = +arg('n', 1000);
const root = path.resolve(__dirname, '..');
const cruxFile = path.resolve(root, arg('crux', 'data/crux-fr-202610.csv.gz'));
const outFile = path.resolve(root, arg('out', 'sites-1000.json'));

const TECH = /^(auth|login|connect|sso|idp|cas|oauth|signin|id|account|accounts|moncompte|mon-compte|compte|monespace|espace-?client|espace-?perso|client|clients|secure|payment|paiement|pay|checkout|mail\d*|webmail|messagerie|app|apps|portail|portal|extranet|intranet|admin|api|cdn|static|dashboard|my|mon|espace|identite|monidentifiant|wallet|backoffice|pro-.*|.*-idp|.*idp.*|.*auth.*)$/i;
const ADMIN = /(^|\.)gouv\.fr$|^(ameli|caf|urssaf|francetravail|service-public|ants|cnav|lassuranceretraite|info-retraite|msa|education|interieur|justice)\./i;

function readCrux() {
  const rows = zlib.gunzipSync(fs.readFileSync(cruxFile)).toString().trim().split('\n').slice(1);
  return rows.map(l => { const [origin, rank] = l.split(','); return { origin, rank: +rank }; });
}

async function familyBlocked(domains) {
  const out = new Map();
  let i = 0;
  const worker = async () => {
    while (i < domains.length) {
      const d = domains[i++];
      try {
        const r = await fetch(`https://family.cloudflare-dns.com/dns-query?name=${encodeURIComponent(d)}&type=A`, { headers: { accept: 'application/dns-json' } });
        const j = await r.json();
        out.set(d, (j.Answer || []).some(a => a.data === '0.0.0.0'));
      } catch { out.set(d, null); }
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  return out;
}

(async () => {
  const curated = JSON.parse(fs.readFileSync(path.join(root, 'sites.json'), 'utf8'));
  const curatedDomains = new Set(curated.map(s => parse(s.url).domain));
  // known blockers are never revisited (protects the IP's reputation); listed in the report as not measurable
  const knownBlocked = new Set(JSON.parse(fs.readFileSync(path.join(root, 'data', 'known-blocked.json'), 'utf8')).domains);
  const stats = { origins: 0, tech: 0, dup: 0, adult: 0, curated: curated.length };

  // candidates per registrable domain, in rank order (rank buckets 1000, 5000, ...; file order inside a bucket)
  const byDomain = new Map();
  for (const { origin, rank } of readCrux().sort((a, b) => a.rank - b.rank)) {
    stats.origins++;
    const p = parse(origin);
    if (!p.domain || p.isIp) continue;
    const sub = p.subdomain || '';
    if (sub && sub.split('.').some(l => TECH.test(l))) { stats.tech++; continue; }
    const cand = { origin, rank, sub };
    const prev = byDomain.get(p.domain);
    const score = c => (c.sub === 'www' || c.sub === '' ? 0 : 1) * 10 + c.sub.split('.').length;
    if (!prev) byDomain.set(p.domain, cand);
    else { stats.dup++; if (cand.rank <= prev.rank && score(cand) < score(prev)) byDomain.set(p.domain, cand); }
  }

  // take enough candidates to reach N after filtering, then check them against the family resolver
  const ordered = [...byDomain.entries()].filter(([d]) => !curatedDomains.has(d) && !knownBlocked.has(d));
  const pool = ordered.slice(0, Math.ceil((N - curated.length) * 1.4));
  const blocked = await familyBlocked(pool.map(([d]) => d));
  const sites = curated.map(s => ({ ...s, source: 'curated' }));
  const excludedAdult = [];
  for (const [domain, c] of pool) {
    if (sites.length >= N) break;
    if (blocked.get(domain)) { excludedAdult.push(domain); stats.adult++; continue; }
    sites.push({
      id: domain.replace(/[^a-z0-9.-]/gi, '_'),
      url: c.origin.replace(/\/?$/, '/'),
      category: ADMIN.test(new URL(c.origin).hostname) ? 'administration' : 'non classé',
      aliases: [],
      source: `crux-fr-${path.basename(cruxFile).match(/\d{6}/)[0]}`, cruxRank: c.rank,
    });
  }
  fs.writeFileSync(outFile, JSON.stringify(sites, null, 1));
  fs.writeFileSync(outFile.replace(/\.json$/, '.excluded-adult.json'), JSON.stringify(excludedAdult, null, 1));
  const ranks = sites.reduce((m, s) => { m[s.cruxRank || 'curated'] = (m[s.cruxRank || 'curated'] || 0) + 1; return m; }, {});
  console.log(JSON.stringify({ ...stats, kept: sites.length, byRankBucket: ranks, admin: sites.filter(s => s.category === 'administration').length }));
})();
