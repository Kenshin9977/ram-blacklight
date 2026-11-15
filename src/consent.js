// Consent handling delegated to DuckDuckGo autoconsent (MPL-2.0, 300+ CMP rules, opt-in / opt-out).
// https://github.com/duckduckgo/autoconsent
//
// Two-phase protocol: the consent visit runs autoconsent and saves the resulting storage state
// (cookies + localStorage). The measured visit then starts from that state in a fresh browser,
// with no consent tooling injected, so autoconsent's own memory never pollutes the measurement.
const fs = require('fs');
const path = require('path');

// package root = parent of dist/ (the package does not export package.json)
const acDir = path.resolve(path.dirname(require.resolve('@duckduckgo/autoconsent')), '..');
// Rules (1.2 MB) are embedded in the injected script, so each frame reads them locally instead of
// Node serializing them to every one of the dozens of ad iframes (that exhausted Node's heap).
// Our own rules (same format), for CMPs autoconsent does not cover; listed first so they win over heuristics.
const RULES = JSON.parse(fs.readFileSync(path.join(acDir, 'rules', 'rules.json'), 'utf8'));
const CUSTOM = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rules', 'custom-rules.json'), 'utf8'));
RULES.autoconsent = CUSTOM.concat(RULES.autoconsent);
const SCRIPT = 'window.__autoconsentRules = ' + JSON.stringify(RULES) + ';\n'
  + fs.readFileSync(path.join(acDir, 'dist', 'autoconsent.playwright.js'), 'utf8');
const VERSION = require(path.join(acDir, 'package.json')).version;

function config(mode) {
  return {
    enabled: true,
    autoAction: mode === 'accept' ? 'optIn' : 'optOut',
    disabledCmps: [],
    enablePrehide: false,
    enableCosmeticRules: true, // banner without a usable reject: hidden, i.e. no consent given
    enableGeneratedRules: true,
    enableHeuristicDetection: true,
    heuristicMode: 'tier2',
    detectRetries: 100, // some sites (marmiton, leparisien) show the Didomi notice late: 20 retries gave up too early
    isMainWorld: false,
    prehideTimeout: 2000,
    logs: { lifecycle: false, rulesteps: false, detectionsteps: false, evals: false, errors: false, messages: false, waits: false },
  };
}

// Visit url in ctx with autoconsent, wait for a decision, return a summary.
async function runAutoconsent(ctx, page, url, mode, { timeoutMs = 25000 } = {}) {
  const events = [];
  let firstDetectUrl = null; // main-frame URL when the CMP was first seen (redirect check baseline)
  let resolveDone;
  const done = new Promise(r => { resolveDone = r; });
  const reply = (frame, msg) => frame.evaluate(m => window.autoconsentReceiveMessage && window.autoconsentReceiveMessage(m), msg).catch(() => {});

  await ctx.exposeBinding('autoconsentSendMessage', async ({ frame }, msg) => {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'init':
        return frame.evaluate(cfg => window.autoconsentReceiveMessage
          && window.autoconsentReceiveMessage({ type: 'initResp', config: cfg, rules: window.__autoconsentRules }), config(mode)).catch(() => {});
      case 'eval': {
        const result = await frame.evaluate(msg.code).catch(() => false);
        return reply(frame, { type: 'evalResp', id: msg.id, result });
      }
      case 'cmpDetected': case 'popupFound': case 'optInResult': case 'optOutResult': case 'autoconsentError':
        if ((msg.type === 'cmpDetected' || msg.type === 'popupFound') && !firstDetectUrl && frame === page.mainFrame()) firstDetectUrl = frame.url();
        events.push({ type: msg.type, cmp: msg.cmp, result: msg.result, url: (msg.url || '').slice(0, 120) });
        if ((msg.type === 'optInResult' || msg.type === 'optOutResult') && !msg.result) resolveDone();
        break;
      case 'autoconsentDone':
        events.push({ type: msg.type, cmp: msg.cmp, isCosmetic: msg.isCosmetic, clicks: msg.totalClicks, url: (msg.url || '').slice(0, 120) });
        resolveDone();
        break;
    }
  });
  await ctx.addInitScript({ content: SCRIPT });

  const t0 = Date.now();
  let status = null;
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    status = resp ? resp.status() : null;
  } catch (e) { events.push({ type: 'gotoError', error: e.message.split('\n')[0] }); }
  await Promise.race([done, page.waitForTimeout(timeoutMs)]);
  await page.waitForTimeout(3000); // let the CMP persist its choice and reloads settle

  const last = [...events].reverse();
  const doneEv = last.find(e => e.type === 'autoconsentDone');
  const resultEv = last.find(e => e.type === 'optInResult' || e.type === 'optOutResult');
  const detected = last.find(e => e.type === 'cmpDetected' || e.type === 'popupFound');
  let outcome;
  if (doneEv) outcome = doneEv.isCosmetic ? 'hidden-no-choice' : (mode === 'accept' ? 'accepted' : 'refused');
  else if (resultEv && !resultEv.result) outcome = 'failed';
  else if (detected) outcome = 'detected-no-action';
  else outcome = 'no-cmp';
  return { mode, outcome, cmp: (doneEv || resultEv || detected || {}).cmp || null, ms: Date.now() - t0, status, events, autoconsent: VERSION,
    urlAtDetection: firstDetectUrl || (status ? page.url() : null) };
}

// TCF snapshot from the page (used in the measured visit to check the stored choice was applied).
async function tcfSnapshot(page) {
  return page.evaluate(() => new Promise(res => {
    if (typeof window.__tcfapi !== 'function') return res(null);
    const to = setTimeout(() => res({ timeout: true }), 2000);
    try {
      window.__tcfapi('getTCData', 2, (d, ok) => {
        clearTimeout(to);
        if (!ok || !d) return res({ ok: false });
        const n = o => (o ? Object.values(o).filter(Boolean).length : null);
        res({ ok: true, cmpId: d.cmpId, eventStatus: d.eventStatus, purposeConsents: n(d.purpose && d.purpose.consents), vendorConsents: n(d.vendor && d.vendor.consents) });
      });
    } catch (e) { clearTimeout(to); res({ error: String(e) }); }
  })).catch(() => null);
}

module.exports = { runAutoconsent, tcfSnapshot, AUTOCONSENT_VERSION: VERSION };
