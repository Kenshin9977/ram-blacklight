// One measurement run: fresh browser, load URL, consent, scroll, idle, then
//   - memory-infra dumps (per-process private footprint + allocators), before and after GC
//   - frame -> renderer pid mapping (TracingStartedInBrowser)
//   - sampled JS heap allocations (live after GC) per script URL, for main frame + OOPIFs
//   - per-target heap usage and DOM counters, per-domain network bytes
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { getDomain } = require('tldts');
const { runAutoconsent, tcfSnapshot } = require('./consent');

const pwDir = path.dirname(require.resolve('playwright-core/package.json'));
const { chromiumSwitches } = require(path.join(pwDir, 'lib/server/chromium/chromiumSwitches.js'));
const PW_DISABLE = chromiumSwitches.find(s => s.startsWith('--disable-features='));
// Keep Playwright's disabled features, but re-enable lazy iframe loading (real browsers lazy-load)
// and disable the spare renderer (an idle pre-spawned process that pollutes per-process totals).
const OUR_DISABLE = '--disable-features=' + PW_DISABLE.slice('--disable-features='.length).split(',')
  .filter(f => f !== 'LazyFrameLoading').concat(['SpareRendererForSitePerProcess']).join(',');

// Pinned build's version (from playwright-core's browsers.json), reduced like Chrome does (134.0.0.0).
const CHROME_MAJOR = require(path.join(pwDir, 'browsers.json')).browsers.find(b => b.name === 'chromium').browserVersion.split('.')[0];
const USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36 RAMBlacklight/0.1`;

// Browsers launched inside withBrowserScope(fn) are recorded, so a caller that gives up on fn
// (timeout) can close them: a hung measure() would otherwise never reach its finally.
const { AsyncLocalStorage } = require('async_hooks');
const scope = new AsyncLocalStorage();
async function launchBrowser(headless = true, blocker = null) {
  const browser = blocker ? await launchWithBlocker(headless, blocker) : await chromium.launch({
    channel: 'chromium', headless,
    ignoreDefaultArgs: [PW_DISABLE],
    args: ['--site-per-process', OUR_DISABLE, '--lang=fr-FR'],
  });
  const live = scope.getStore();
  if (live) {
    if (live.closed) { await browser.close(); throw new Error('scope closed'); }
    live.add(browser); browser.on('disconnected', () => live.delete(browser));
  }
  return browser;
}
// Content blockers (unpacked official releases, fetched by scripts/fetch-extensions.sh), default settings.
// Extensions need a persistent profile: one profile per blocker is warmed up once (filter lists compiled),
// then copied for every run, so each run starts like a browser the user has had for a while.
const ROOT = path.resolve(__dirname, '..');
// uBlock Origin (MV2) is not offered: Chrome dropped MV2 extensions in 2025, and in this Chromium it
// stops filtering as soon as the browser announces a regular Chrome user agent (tested 2026-11-15).
const BLOCKERS = {
  ubol: { name: 'uBlock Origin Lite', dir: path.join(ROOT, 'extensions', 'ubol') },
};
const os = require('os');
const warmed = {};
const persistentOpts = (headless, ext) => ({
  ...CTX_OPTS, channel: 'chromium', headless,
  ignoreDefaultArgs: [PW_DISABLE, '--disable-extensions'],
  args: ['--site-per-process', OUR_DISABLE, '--lang=fr-FR', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
function warmProfile(blocker, headless) {
  return warmed[blocker] ||= (async () => {
    const b = BLOCKERS[blocker];
    if (!b || !fs.existsSync(path.join(b.dir, 'manifest.json'))) throw new Error(`blocker ${blocker} not installed (scripts/fetch-extensions.sh)`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rb-${blocker}-warm-`));
    const ctx = await chromium.launchPersistentContext(dir, persistentOpts(headless, b.dir));
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://example.com/').catch(() => {});
    await page.waitForTimeout(45000); // first start: lists are compiled (and updated) in the background
    await ctx.close();
    return dir;
  })();
}
async function launchWithBlocker(headless, blocker) {
  const ext = BLOCKERS[blocker];
  const base = await warmProfile(blocker, headless);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rb-${blocker}-run-`));
  fs.cpSync(base, dir, { recursive: true, filter: s => !/Singleton(Lock|Socket|Cookie)$/.test(s) });
  const ctx = await chromium.launchPersistentContext(dir, persistentOpts(headless, ext.dir));
  const first = ctx.pages()[0] || await ctx.newPage();
  // A user's blocker is already running when they open a page: wait until ours blocks a script it
  // blocks outright (Google ad scripts are replaced by neutered stand-ins, so they "load" even when blocked).
  await first.goto('https://example.com/').catch(() => {});
  const probe = () => first.evaluate(() => new Promise(r => { const s = document.createElement('script'); s.src = 'https://static.criteo.net/js/ld/publishertag.js?r=' + Math.random(); s.onload = () => r(false); s.onerror = () => r(true); document.head.append(s); })).catch(() => false);
  const t0 = Date.now();
  while (!(await probe())) {
    if (Date.now() - t0 > 90000) { await ctx.close().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); throw new Error(`blocker ${blocker} not filtering after 90 s`); }
    await first.waitForTimeout(1000);
  }
  const readyMs = Date.now() - t0;
  await first.goto('about:blank').catch(() => {});
  const cdp = await ctx.newCDPSession(first);
  const { product } = await cdp.send('Browser.getVersion');
  await cdp.detach().catch(() => {});
  // the measured page must be the only tab: close the start tab once the measured one exists
  const newPage = async () => { const p = await ctx.newPage(); for (const o of ctx.pages()) if (o !== p) await o.close().catch(() => {}); return p; };
  const proxy = new Proxy(ctx, { get: (t, k) => k === 'newPage' ? newPage : typeof t[k] === 'function' ? t[k].bind(t) : t[k] });
  return {
    blocker: { id: blocker, name: ext.name, version: JSON.parse(fs.readFileSync(path.join(ext.dir, 'manifest.json'), 'utf8')).version, readyMs },
    version: () => product.replace(/^\w+\//, ''),
    // persistent contexts take their options at launch; only the stored consent is applied here
    newContext: async (opts = {}) => { if (opts.storageState) await applyStorageState(ctx, opts.storageState); return proxy; },
    on: (ev, fn) => ctx.on(ev === 'disconnected' ? 'close' : ev, fn),
    close: async () => { await ctx.close().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
// Same effect as newContext({ storageState }): cookies, plus localStorage set before any page script runs.
async function applyStorageState(ctx, state) {
  if (state.cookies && state.cookies.length) await ctx.addCookies(state.cookies);
  const origins = Object.fromEntries((state.origins || []).map(o => [o.origin, o.localStorage]));
  if (Object.keys(origins).length) await ctx.addInitScript(o => {
    const items = o[location.origin];
    if (items) try { for (const { name, value } of items) if (localStorage.getItem(name) === null) localStorage.setItem(name, value); } catch {}
  }, origins);
}
function withBrowserScope(fn) {
  const live = new Set();
  const closeAll = () => { live.closed = true; return Promise.all([...live].map(b => b.close().catch(() => {}))); };
  return { promise: scope.run(live, fn), closeAll };
}
const CTX_OPTS = {
  locale: 'fr-FR', timezoneId: 'Europe/Paris', viewport: { width: 1366, height: 768 },
  geolocation: { latitude: 48.8566, longitude: 2.3522 },
  userAgent: USER_AGENT,
};

const TRACE_CATS = ['disabled-by-default-memory-infra', 'disabled-by-default-devtools.timeline', 'devtools.timeline', '__metadata'];

async function readStream(cdp, handle) {
  const chunks = [];
  for (;;) {
    const r = await cdp.send('IO.read', { handle, size: 4 << 20 });
    chunks.push(r.base64Encoded ? Buffer.from(r.data, 'base64') : Buffer.from(r.data));
    if (r.eof) break;
  }
  await cdp.send('IO.close', { handle });
  return Buffer.concat(chunks).toString();
}

const hex = v => (v === undefined ? null : parseInt(v, 16));

function parseTrace(events) {
  const procType = {};
  const dumps = {}; // guid -> pid -> {footprint, allocators}
  let frames = [];
  const committed = [];
  const dumpTs = {};
  for (const e of events) {
    if (e.name === 'process_name' && e.ph === 'M') procType[e.pid] = e.args.name;
    else if (e.name === 'TracingStartedInBrowser') frames = (e.args.data && e.args.data.frames) || [];
    else if (e.name === 'FrameCommittedInBrowser') committed.push(e.args.data);
    else if (e.ph === 'v' && e.args && e.args.dumps) {
      const d = e.args.dumps;
      const alloc = {};
      for (const [k, v] of Object.entries(d.allocators || {})) {
        if (!k.includes('/') && v.attrs && v.attrs.size) alloc[k] = hex(v.attrs.size.value);
      }
      // v8 sub-heaps worth keeping
      for (const k of ['v8/main/heap', 'v8/workers', 'v8/main/malloc', 'partition_alloc/partitions', 'blink_gc/main/heap', 'cc/tile_memory']) {
        const v = (d.allocators || {})[k];
        if (v && v.attrs && v.attrs.size) alloc[k] = hex(v.attrs.size.value);
      }
      const gid = String(e.id);
      dumpTs[gid] = Math.min(dumpTs[gid] ?? Infinity, e.ts);
      // a process may emit several 'v' events per dump (totals, allocators): merge them
      const byPid = (dumps[gid] = dumps[gid] || {});
      const rec = (byPid[e.pid] = byPid[e.pid] || { footprint: null, allocators: {} });
      if (d.process_totals && d.process_totals.private_footprint_bytes) rec.footprint = hex(d.process_totals.private_footprint_bytes);
      Object.assign(rec.allocators, alloc);
    }
  }
  // requestMemoryDump's returned guid does not match trace ids: order dumps by time instead
  const ordered = Object.keys(dumps).sort((a, b) => dumpTs[a] - dumpTs[b]).map(k => dumps[k]);
  return { procType, dumps: ordered, frames, committed };
}

// Sampling heap profile -> bytes per script URL (allocation site = innermost frame with a URL).
// Top-level script frames come back with url '' but a valid scriptId: resolve via Debugger.scriptParsed.
function profileByUrl(profile, scriptUrls = {}) {
  const byUrl = {};
  let total = 0;
  const walk = (node, inherited) => {
    const cf = node.callFrame;
    const url = cf.url || scriptUrls[cf.scriptId] || inherited || '';
    if (node.selfSize) { byUrl[url] = (byUrl[url] || 0) + node.selfSize; total += node.selfSize; }
    for (const c of node.children || []) walk(c, url);
  };
  if (profile && profile.head) walk(profile.head, '');
  return { total, byUrl };
}

function navChanged(a, b) {
  const norm = p => p.replace(/\/$/, '');
  try { const x = new URL(a), y = new URL(b); return x.hostname !== y.hostname || norm(x.pathname) !== norm(y.pathname); } catch { return false; }
}

const MAINTENANCE = /maintenance|temporairement indisponible|service indisponible/i;
// Bot-protection / error page detection. We flag, we do not bypass.
async function detectBlock(page, status) {
  if (status === 403 || status === 429 || status === 503) return `http-${status}`;
  const frames = page.frames().map(f => f.url());
  if (frames.some(u => /captcha-delivery\.com|geo\.captcha|challenges\.cloudflare\.com|px-captcha/.test(u))) return 'captcha';
  const info = await page.evaluate(() => ({ t: document.title, txt: (document.body && document.body.innerText || '').slice(0, 3000), n: document.querySelectorAll('*').length })).catch(() => null);
  if (!info) return null;
  if (/^(Invalid URL|Access Denied|Just a moment|Attention Required|Request blocked|Pardon Our Interruption)/i.test(info.t)) return 'blocked-page';
  if (MAINTENANCE.test(info.t)) return 'maintenance'; // e.g. caf.fr at night: not the real page
  if (info.n < 150 && /robot|captcha|unusual traffic|access denied/i.test(info.txt)) return 'challenge';
  return null;
}

// Memory over time during idle: one light (non-GC) dump every stepMs, renderer totals per dump.
async function idleCurve(cdp, idleMs, stepMs) {
  const done = new Promise(res => cdp.once('Tracing.tracingComplete', res));
  await cdp.send('Tracing.start', {
    transferMode: 'ReturnAsStream',
    traceConfig: { includedCategories: ['disabled-by-default-memory-infra', '__metadata'], memoryDumpConfig: { triggers: [] } },
  });
  const t0 = Date.now(), at = [];
  for (let k = 0; k * stepMs <= idleMs; k++) {
    const wait = t0 + k * stepMs - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    at.push(Date.now() - t0);
    await cdp.send('Tracing.requestMemoryDump', { deterministic: false, levelOfDetail: 'light' }).catch(() => {});
  }
  await cdp.send('Tracing.end');
  const { stream } = await done;
  const parsed = parseTrace(JSON.parse(await readStream(cdp, stream)).traceEvents);
  return parsed.dumps.map((d, i) => {
    let renderers = 0, total = 0, shared = 0;
    for (const [pid, p] of Object.entries(d)) {
      if ((parsed.procType[pid] || '') === 'Renderer') { renderers++; total += p.footprint || 0; } else shared += p.footprint || 0;
    }
    return { t: at[i] ?? null, renderers, total, shared };
  });
}

async function measure(opts) {
  const {
    url, mode = 'accept', idleMs = 60000, samplingInterval = 16384,
    shotPath = null, headless = true, log = () => {},
    debuggerUrls = true, // enable Debugger from start to resolve scriptId -> URL (top-level scripts get GC'd)
    sampling = true,
    curveStepMs = 0, // >0: light memory dump every curveStepMs during idle (stabilisation study)
    blocker = null, // 'ubol': measured visit with that content blocker (consent visit stays without)
  } = opts;
  const t0 = Date.now();
  const out = { url, mode, startedAt: new Date().toISOString(), params: { idleMs, samplingInterval, debuggerUrls, sampling } };
  // UA policy (same as HTTP Archive): the desktop Chrome UA of the pinned build, so sites serve the
  // page real visitors get (HeadlessChrome gets degraded pages, e.g. no CMP notice), plus a declared
  // crawler token. No stealth patches, no fingerprint changes; captchas/blocks are flagged, never solved.
  const launch = () => launchBrowser(headless, blocker);
  const ctxOpts = CTX_OPTS;
  out.userAgent = USER_AGENT;

  // Phase 1: consent visit (autoconsent), keep only the resulting cookies/localStorage.
  let storageState;
  if (opts.consentState) {
    // consent obtained once per site x mode by the runner, reused for every run (saves a browser + visit)
    out.consent = { ...opts.consentState.consent, reused: true };
    storageState = opts.consentState.storageState;
  } else if (mode !== 'none') {
    log('consent');
    ({ consent: out.consent, storageState } = await obtainConsent(url, mode));
  } else out.consent = { mode, outcome: 'skipped' };

  // Phase 2: measured visit, fresh browser and cache, stored consent, nothing injected.
  const browser = await launch();
  try {
    const version = browser.version();
    out.browser = { version, flags: ['--site-per-process', 'headless=new', OUR_DISABLE] };
    if (browser.blocker) out.blocker = browser.blocker;
    const ctx = await browser.newContext({ ...ctxOpts, storageState });
    const page = await ctx.newPage();
    const main = await ctx.newCDPSession(page);
    const trackScripts = async (session, map) => {
      if (!debuggerUrls) return;
      session.on('Debugger.scriptParsed', e => { if (e.url) map[e.scriptId] = e.url; });
      // maxScriptsCacheSize 0: do not let the debugger retain sources of collected scripts
      await session.send('Debugger.enable', { maxScriptsCacheSize: 0 });
    };
    const mainScripts = {};
    await trackScripts(main, mainScripts);
    await main.send('HeapProfiler.enable');
    if (sampling) await main.send('HeapProfiler.startSampling', { samplingInterval });

    // OOPIF sessions, one sampler per site (frames of a site share one renderer / isolate)
    const oopifs = new Map(); // targetId -> rec
    const sampledSites = new Set();
    const onFrame = async frame => {
      if (frame === page.mainFrame() || frame.isDetached()) return;
      let s;
      try { s = await ctx.newCDPSession(frame); } catch { return; } // in-process frame
      try {
        const { targetInfo } = await s.send('Target.getTargetInfo');
        if (oopifs.has(targetInfo.targetId)) { await s.detach().catch(() => {}); return; }
        const site = getDomain(targetInfo.url) || targetInfo.url;
        const rec = { session: s, targetId: targetInfo.targetId, url: targetInfo.url, site, attachedAtMs: Date.now() - t0, sampling: false };
        oopifs.set(targetInfo.targetId, rec);
        rec.scripts = {};
        await trackScripts(s, rec.scripts);
        await s.send('HeapProfiler.enable');
        if (sampling && !sampledSites.has(site)) {
          sampledSites.add(site);
          await s.send('HeapProfiler.startSampling', { samplingInterval });
          rec.sampling = true;
        }
      } catch { /* target gone */ }
    };
    page.on('frameattached', onFrame);
    page.on('framenavigated', onFrame);

    // network bytes per domain
    const net = {};
    page.on('requestfinished', async req => {
      const d = getDomain(req.url()) || '(autre)';
      const n = (net[d] = net[d] || { requests: 0, bytes: 0, types: {} });
      n.requests++;
      n.types[req.resourceType()] = (n.types[req.resourceType()] || 0) + 1;
      try { const s = await req.sizes(); n.bytes += s.responseBodySize + s.responseHeadersSize; } catch {}
    });

    log('goto');
    let resp = null;
    try {
      resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (e) { out.gotoError = e.message.split('\n')[0]; }
    await page.waitForLoadState('load', { timeout: 30000 }).catch(() => { out.loadTimeout = true; });
    await page.waitForTimeout(3000);
    out.status = resp ? resp.status() : null;
    out.timings = { loadedMs: Date.now() - t0 };

    out.blocked = await detectBlock(page, out.status);
    out.tcf = await tcfSnapshot(page); // was the stored choice applied?

    log('scroll');
    let steps = 0;
    for (; steps < 25; steps++) {
      await page.mouse.wheel(0, 700).catch(() => {});
      await page.waitForTimeout(400);
      const atBottom = await page.evaluate(() => innerHeight + scrollY >= document.documentElement.scrollHeight - 5).catch(() => true);
      if (atBottom) break;
    }
    await page.evaluate(() => window.scrollTo({ top: 0 })).catch(() => {});
    out.scrollSteps = steps;
    out.timings.scrolledMs = Date.now() - t0;

    log('idle');
    if (curveStepMs) out.curve = await idleCurve(main, idleMs, curveStepMs);
    else await page.waitForTimeout(idleMs);
    out.timings.idleEndMs = Date.now() - t0;
    out.finalUrl = page.url();
    out.title = await page.title().catch(() => null);

    log('measure');
    const sessions = [{ kind: 'main', url: page.url(), session: main, sampling, scripts: mainScripts }, ...[...oopifs.values()].map(r => ({ kind: 'oopif', ...r }))];
    // pre-GC per-target counters
    for (const s of sessions) {
      try {
        await s.session.send('Performance.enable');
        const { metrics } = await s.session.send('Performance.getMetrics');
        const m = Object.fromEntries(metrics.map(x => [x.name, x.value]));
        s.pre = { jsHeapUsed: m.JSHeapUsedSize, jsHeapTotal: m.JSHeapTotalSize, nodes: m.Nodes, documents: m.Documents, frames: m.Frames, listeners: m.JSEventListeners };
        const { targetInfo } = await s.session.send('Target.getTargetInfo');
        s.url = targetInfo.url;
      } catch { s.dead = true; }
    }

    // memory-infra: dump A (as experienced), dump B (deterministic = forced GC)
    const done = new Promise(res => main.once('Tracing.tracingComplete', res));
    await main.send('Tracing.start', {
      transferMode: 'ReturnAsStream',
      traceConfig: { includedCategories: TRACE_CATS, memoryDumpConfig: { triggers: [] } },
    });
    await main.send('Tracing.requestMemoryDump', { deterministic: false, levelOfDetail: 'detailed' });
    await main.send('Tracing.requestMemoryDump', { deterministic: true, levelOfDetail: 'detailed' });
    await main.send('Tracing.end');
    const { stream } = await done;
    const raw = await readStream(main, stream);
    const parsed = parseTrace(JSON.parse(raw).traceEvents);
    out.trace = {
      procType: parsed.procType,
      frames: parsed.frames.map(f => ({ frame: f.frame, parent: f.parent || null, url: f.url, pid: f.processId })),
      dumpBefore: parsed.dumps[0] || null,
      dumpAfterGC: parsed.dumps[1] || null,
    };

    // post-GC: stop samplers, heap usage
    out.targets = [];
    for (const s of sessions) {
      const t = { kind: s.kind, url: s.url, sampling: s.sampling, attachedAtMs: s.attachedAtMs || 0, pre: s.pre || null };
      if (!s.dead) {
        try {
          const scriptUrls = s.scripts || {};
          if (debuggerUrls) await s.session.send('Debugger.disable').catch(() => {});
          await s.session.send('HeapProfiler.collectGarbage');
          const hu = await s.session.send('Runtime.getHeapUsage');
          t.postGC = { used: hu.usedSize, total: hu.totalSize, embedderHeapUsed: hu.embedderHeapUsedSize, backingStorage: hu.backingStorageSize };
          if (s.sampling) {
            const { profile } = await s.session.send('HeapProfiler.stopSampling');
            t.sampled = profileByUrl(profile, scriptUrls);
            t.scriptsKnown = Object.keys(scriptUrls).length;
          }
        } catch (e) { t.error = e.message.split('\n')[0]; }
      } else t.dead = true;
      out.targets.push(t);
    }
    out.network = net;
    out.pageFrames = page.frames().map(f => f.url()).filter(u => u && u !== 'about:blank');
    if (shotPath) await page.screenshot({ path: shotPath, type: 'jpeg', quality: 45 }).catch(() => {});
    out.timings.totalMs = Date.now() - t0;
    return out;
  } finally {
    await browser.close().catch(() => {});
  }
}

// Consent visit alone (phase 1), for the runner to cache: { consent, storageState }.
async function obtainConsent(url, mode) {
  const browser = await launchBrowser(true);
  try {
    const ctx = await browser.newContext(CTX_OPTS);
    const page = await ctx.newPage();
    const consent = await runAutoconsent(ctx, page, url, mode);
    consent.blocked = await detectBlock(page, consent.status);
    consent.finalUrl = page.url();
    // e.g. "continue without accepting" -> subscription page (pay-or-accept wall).
    // Compared with the URL where the CMP was detected, not the requested one (/ -> /accueil/ is normal).
    consent.redirected = consent.urlAtDetection ? navChanged(consent.urlAtDetection, page.url()) : false;
    const storageState = await ctx.storageState();
    consent.cookies = storageState.cookies.length;
    consent.obtainedAt = new Date().toISOString();
    return { consent, storageState };
  } finally { await browser.close().catch(() => {}); }
}

module.exports = { measure, obtainConsent, launchBrowser, withBrowserScope, USER_AGENT, MAINTENANCE };

// CLI for single test: node src/measure.js URL [accept|refuse] [idleSec]
if (require.main === module) {
  (async () => {
    const [url, mode = 'accept', idle = '10'] = process.argv.slice(2);
    const r = await measure({ url, mode, idleMs: +idle * 1000, log: s => console.error('[step]', s), shotPath: 'test-shot.jpg', blocker: process.env.BLOCKER || null });
    fs.writeFileSync('test-run.json', JSON.stringify(r, null, 1));
    const fmt = b => (b / 1048576).toFixed(1) + ' MB';
    console.log('consent', JSON.stringify(r.consent));
    const fA = r.trace.dumpBefore || {};
    for (const [pid, d] of Object.entries(fA)) {
      const frames = r.trace.frames.filter(f => String(f.pid) === pid).map(f => f.url.slice(0, 70));
      console.log(pid, r.trace.procType[pid], fmt(d.footprint), frames.length, frames.slice(0, 4).join(' | '));
    }
    for (const t of r.targets) console.log(t.kind, (t.url || '').slice(0, 70), t.postGC && fmt(t.postGC.used), t.sampled && fmt(t.sampled.total));
  })().catch(e => { console.error(e); process.exit(1); });
}
