// Campaign runner: resumable (state = files on disk), adaptive runs, consent cached per site x mode,
// memory-gated starts, optional nightly --stop-at. Options and rationale: see README.md "Campagnes".
const fs = require('fs');
const os = require('os');
const path = require('path');
const { measure, obtainConsent, withBrowserScope, USER_AGENT } = require('./measure');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const outDir = path.resolve(arg('out', 'results/latest'));
const modes = arg('modes', 'accept,refuse').split(',');
const minRuns = +arg('min-runs', 3), maxRuns = +arg('max-runs', 5), cvMax = +arg('cv', 0.05);
const idleMs = +arg('idle', 60) * 1000;
const conc = +arg('concurrency', 2);
const minFreeGB = +arg('min-free-gb', 3), staggerMs = +arg('stagger', 20) * 1000;
const consentTries = +arg('consent-tries', 3);
const baselineRuns = +arg('baseline', 3);
const stopAt = arg('stop-at', null);
const only = arg('only', null);
let sites = JSON.parse(fs.readFileSync(path.resolve(arg('sites', 'sites.json')), 'utf8'));
if (only) sites = sites.filter(s => only.split(',').includes(s.id));

for (const d of ['raw', 'shots', 'consent']) fs.mkdirSync(path.join(outDir, d), { recursive: true });
const rawFile = (id, mode, r) => path.join(outDir, 'raw', `${id}__${mode}__r${r}.json`);
const consentFile = (id, mode) => path.join(outDir, 'consent', `${id}__${mode}.json`);
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

let deadline = Infinity;
if (stopAt) {
  const [h, m] = stopAt.split(':').map(Number);
  const d = new Date(); d.setHours(h, m || 0, 0, 0);
  if (d <= new Date()) d.setDate(d.getDate() + 1);
  deadline = d.getTime();
}

// min(host MemAvailable, cgroup v2 limit - usage), in GiB
function freeGB() {
  let avail = os.freemem();
  try {
    const m = /MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (m) avail = +m[1] * 1024;
  } catch {}
  try {
    const max = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    if (max !== 'max') avail = Math.min(avail, +max - +fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8'));
  } catch {}
  return avail / 2 ** 30;
}

// page total of a raw run = sum of renderer footprints
function pageTotal(raw) {
  if (!raw || raw.error || raw.blocked || !raw.trace || !raw.trace.dumpBefore) return null;
  let t = 0;
  for (const [pid, d] of Object.entries(raw.trace.dumpBefore)) if (raw.trace.procType[pid] === 'Renderer') t += d.footprint || 0;
  return t || null;
}
const cv = a => { const m = a.reduce((s, v) => s + v, 0) / a.length; return m ? Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1)) / m : 0; };

// Consent visit retried until the expected outcome (autoconsent sometimes misses the CMP).
const EXPECTED = { accept: ['accepted'], refuse: ['refused'] };
const ACCEPTABLE = { accept: [], refuse: ['hidden-no-choice', 'failed'] }; // cosmetic hide, pay-or-accept wall
async function getConsent(site, mode) {
  let best = null;
  for (let k = 1; k <= consentTries; k++) {
    const c = await obtainConsent(site.url, mode);
    c.consent.attempt = k;
    if (c.consent.blocked) return c;
    if (EXPECTED[mode].includes(c.consent.outcome)) return c;
    if (!best || (ACCEPTABLE[mode].includes(c.consent.outcome) && !ACCEPTABLE[mode].includes(best.consent.outcome))
      || (best.consent.outcome === 'no-cmp' && c.consent.outcome !== 'no-cmp')) best = c;
  }
  return best;
}

const inflight = new Set();
const keyOf = t => `${t.kind}:${t.site.id}:${t.mode}:${t.run || ''}`;
const BASE = { id: '_baseline', url: 'about:blank', category: 'baseline' };

// In-memory view of the on-disk state (scanning 1000s of JSON files per decision is too slow).
const consentCache = new Map(); // "id__mode" -> { skipped, consent: { blocked, outcome } } | null
const rawCache = new Map(); // "id__mode__rN" -> page total (0 = invalid run)
const summarise = c => c && { skipped: c.skipped, consent: c.consent && { blocked: c.consent.blocked, outcome: c.consent.outcome } };
for (const f of fs.readdirSync(path.join(outDir, 'consent'))) consentCache.set(f.replace(/\.json$/, ''), summarise(readJson(path.join(outDir, 'consent', f))));
const blockedSites = new Set(); // sites that blocked a measured visit: never revisited (IP reputation)
for (const f of fs.readdirSync(path.join(outDir, 'raw'))) {
  const raw = readJson(path.join(outDir, 'raw', f));
  rawCache.set(f.replace(/\.json$/, ''), pageTotal(raw) || 0);
  if (raw && raw.blocked) blockedSites.add(f.split('__')[0]);
}
const getConsentState = (id, mode) => consentCache.get(`${id}__${mode}`) || null;
function saveConsent(id, mode, c) { fs.writeFileSync(consentFile(id, mode), JSON.stringify(c)); consentCache.set(`${id}__${mode}`, summarise(c)); }
const hasRaw = (id, mode, r) => rawCache.has(`${id}__${mode}__r${r}`);

// A mode may carry a content blocker: "accept+ubol" = consent of "accept", measured with uBlock Origin Lite.
const baseMode = m => m.split('+')[0];
const blockerOf = m => m.split('+')[1] || null;
const baselineModes = ['none', ...new Set(modes.map(blockerOf).filter(Boolean).map(b => 'none+' + b))];

function status(site, variant) {
  const mode = baseMode(variant);
  const c = getConsentState(site.id, mode);
  if (blockedSites.has(site.id)) return 'blocked';
  if (c && c.skipped) return 'skip';
  if (c && c.consent && c.consent.blocked) return 'blocked';
  if (mode !== 'accept' && modes.some(m => baseMode(m) === 'accept')) {
    const a = getConsentState(site.id, 'accept');
    if (!a) return 'wait-accept';
    if (a.consent && a.consent.blocked) return 'blocked';
    if (a.consent && a.consent.outcome === 'no-cmp') return 'skip-no-cmp'; // no CMP: refuse = same page
  }
  return c ? 'ready' : 'pending-consent';
}

// Run-major order, so repeated runs of a site are spread in time.
function nextTask() {
  for (let r = 1; r <= baselineRuns; r++) for (const mode of baselineModes) {
    const t = { kind: 'run', site: BASE, mode, run: r };
    if (!hasRaw(BASE.id, mode, r) && !inflight.has(keyOf(t))) return t;
  }
  for (let r = 1; r <= maxRuns; r++) {
    for (const site of sites) for (const mode of modes) {
      const st = status(site, mode);
      if (st === 'skip-no-cmp') {
        saveConsent(site.id, baseMode(mode), { skipped: 'no-cmp in accept mode' });
        continue;
      }
      if (st === 'blocked' || st === 'skip' || st === 'wait-accept') continue;
      if (st === 'pending-consent') {
        const t = { kind: 'consent', site, mode: baseMode(mode) };
        if (!inflight.has(keyOf(t))) return t;
        continue;
      }
      if (hasRaw(site.id, mode, r)) continue;
      const t = { kind: 'run', site, mode, run: r };
      if (inflight.has(keyOf(t))) continue;
      if (r > minRuns) {
        // extra runs only while unstable; decided once all earlier runs are on disk
        const prev = Array.from({ length: r - 1 }, (_, k) => rawCache.get(`${site.id}__${mode}__r${k + 1}`));
        if (prev.some(p => p === undefined)) continue;
        const vals = prev.filter(Boolean);
        if (vals.length >= minRuns && cv(vals) <= cvMax) continue;
      }
      return t;
    }
  }
  return null;
}

// Runs fn with a time limit; on timeout, the browsers fn launched are closed (no orphan left behind).
async function withTimeout(fn, ms) {
  const { promise, closeAll } = withBrowserScope(fn);
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), ms); })]);
  } catch (e) {
    await closeAll();
    throw e;
  } finally { clearTimeout(timer); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toLocaleTimeString('fr-FR', { timeZone: process.env.TZ || undefined });
let lastStart = 0, done = 0;

async function execute(t) {
  const label = `${t.kind === 'consent' ? 'consent ' : ''}${t.site.id}/${t.mode}${t.run ? '/r' + t.run : ''}`;
  const t0 = Date.now();
  if (t.kind === 'consent') {
    let c;
    try { c = await withTimeout(() => getConsent(t.site, t.mode), consentTries * 120000); } catch (e) { c = { consent: { outcome: 'error', error: String(e.message || e) } }; }
    saveConsent(t.site.id, t.mode, c);
    const k = c.consent || {};
    console.log(`[${now()}] ${label} -> ${k.outcome}${k.cmp ? ':' + k.cmp : ''} (try ${k.attempt || '-'})${k.blocked ? ' BLOCKED=' + k.blocked : ''} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    return;
  }
  const mode = baseMode(t.mode), blocker = blockerOf(t.mode);
  const consentState = mode === 'none' ? null : readJson(consentFile(t.site.id, mode));
  let res;
  try {
    res = await withTimeout(() => measure({
      url: t.site.url, mode, blocker, idleMs: t.site.id === BASE.id ? 5000 : idleMs, consentState,
      shotPath: path.join(outDir, 'shots', `${t.site.id}__${t.mode}__r${t.run}.jpg`),
    }), idleMs + 240000);
  } catch (e) { res = { url: t.site.url, mode, blocker: blocker && { id: blocker }, error: String(e && e.message || e).split('\n')[0] }; }
  res.site = t.site; res.run = t.run; res.host = os.hostname();
  fs.writeFileSync(rawFile(t.site.id, t.mode, t.run), JSON.stringify(res));
  const pt = pageTotal(res);
  rawCache.set(`${t.site.id}__${t.mode}__r${t.run}`, pt || 0);
  if (res.blocked) blockedSites.add(t.site.id);
  console.log(`[${now()}] #${++done} ${label} ${res.error ? 'ERROR ' + res.error : pt ? (pt / 1048576).toFixed(0) + ' MB' : 'no total'}${res.blocked ? ' BLOCKED=' + res.blocked : ''} ${((Date.now() - t0) / 1000).toFixed(0)}s free=${freeGB().toFixed(1)}G`);
}

async function worker() {
  for (;;) {
    if (Date.now() >= deadline) return;
    const t = nextTask();
    if (!t) { if (!inflight.size) return; await sleep(5000); continue; }
    // memory gate + stagger: never two page loads at once, never without headroom
    if (Date.now() - lastStart < staggerMs || freeGB() < minFreeGB) { await sleep(3000); continue; }
    lastStart = Date.now();
    inflight.add(keyOf(t));
    try { await execute(t); } finally { inflight.delete(keyOf(t)); }
  }
}

(async () => {
  const meta = {
    startedAt: new Date().toISOString(), host: os.hostname(), platform: `${os.platform()} ${os.release()}`, cpus: os.cpus().length,
    memGB: +(os.totalmem() / 2 ** 30).toFixed(1), node: process.version,
    playwright: require('playwright-core/package.json').version, userAgent: USER_AGENT,
    params: { modes, minRuns, maxRuns, cvMax, idleMs, conc, minFreeGB, staggerMs, consentTries, sites: sites.length },
  };
  const metaFile = path.join(outDir, 'campaign.json');
  const prev = readJson(metaFile);
  fs.writeFileSync(metaFile, JSON.stringify({ ...meta, sessions: [...((prev && prev.sessions) || []), meta.startedAt] }, null, 1));
  console.log(`campaign ${outDir}: ${sites.length} sites, modes ${modes}, runs ${minRuns}-${maxRuns} (cv>${cvMax}), concurrency ${conc}, min free ${minFreeGB} GB${stopAt ? ', stop at ' + stopAt : ''}`);
  await Promise.all(Array.from({ length: conc }, worker));
  console.log(nextTask() ? 'stopped (deadline), rerun to resume' : 'campaign done');
  process.exit(0); // browsers orphaned by timed-out tasks would keep the process (and campaign.sh) alive
})();
