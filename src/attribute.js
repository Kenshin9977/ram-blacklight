// Raw run -> attribution rows. Pure function, so methodology can evolve without re-crawling.
//
// Page memory = sum of private footprints of the renderer processes hosting the page's frames.
//  - out-of-process iframe (OOPIF) renderer: whole footprint -> entity of the frame's site
//  - main renderer:
//      JS heap (live, post-GC)  -> split by allocation-site script URL (sampling heap profiler)
//      JS heap rest (garbage, fragmentation, code) -> "unattributed: JS engine"
//      everything else (DOM, style/layout, images, caches, malloc) -> "unattributed: main process, non-JS"
//  - browser / GPU / utility processes: shared, reported separately, never in the page total.
const { makeClassifier } = require('./classify');

const MB = 1048576;

function attributeRun(raw, aliases = []) {
  if (raw.error || !raw.trace || !raw.trace.dumpBefore) return { error: raw.error || 'no dump' };
  const pageUrl = raw.finalUrl || raw.url;
  const classify = makeClassifier(pageUrl, aliases);
  const { procType, frames, dumpBefore, dumpAfterGC } = raw.trace;
  const main = frames.find(f => !f.parent) || frames[0];
  if (!main) return { error: 'no frames' };
  const mainPid = String(main.pid);

  const framesByPid = {};
  for (const f of frames) (framesByPid[f.pid] = framesByPid[f.pid] || []).push(f);

  const rows = [];
  const add = (r, bytes, bytesGC, kind, extra = {}) => rows.push({ entity: r.entity, category: r.category, party: r.party, domain: r.domain, kind, bytes, bytesGC, ...extra });
  const U = label => ({ entity: label, category: 'non attribué', party: 'unattributed', domain: '' });

  let pageTotal = 0, pageTotalGC = 0, shared = 0, oopifProcesses = 0, unmapped = 0;
  const processes = [];
  for (const [pid, d] of Object.entries(dumpBefore)) {
    const type = procType[pid] || 'Utility';
    const fp = d.footprint || 0;
    const fpGC = (dumpAfterGC && dumpAfterGC[pid] && dumpAfterGC[pid].footprint) || fp;
    const fr = framesByPid[pid] || [];
    processes.push({ pid, type, footprint: fp, frames: fr.length, site: fr.length ? (fr.find(f => f.url && f.url !== 'about:blank') || fr[0]).url : null });
    if (type !== 'Renderer') { shared += fp; continue; }
    pageTotal += fp; pageTotalGC += fpGC;
    if (pid === mainPid) continue;
    if (!fr.length) { unmapped++; add(U('renderer non relié à une frame'), fp, fpGC, 'process'); continue; }
    oopifProcesses++;
    const site = (fr.find(f => f.url && f.url !== 'about:blank') || fr[0]).url;
    add(classify(site), fp, fpGC, 'iframe-process', { frames: fr.length });
  }

  // main renderer split
  const md = dumpBefore[mainPid] || { footprint: 0, allocators: {} };
  const mdGC = (dumpAfterGC && dumpAfterGC[mainPid]) || md;
  const fp = md.footprint || 0, fpGC = mdGC.footprint || fp;
  const v8 = md.allocators['v8/main/heap'] || md.allocators.v8 || 0;
  const v8GC = mdGC.allocators['v8/main/heap'] || mdGC.allocators.v8 || v8;
  const workers = md.allocators['v8/workers'] || 0;
  const t = (raw.targets || []).find(x => x.kind === 'main') || {};
  const used = (t.postGC && t.postGC.used) || 0;
  const sampled = t.sampled || { total: 0, byUrl: {} };
  const scale = sampled.total ? used / sampled.total : 0;
  let jsAttributed = 0;
  const perUrl = [];
  for (const [url, b] of Object.entries(sampled.byUrl)) {
    const bytes = b * scale;
    jsAttributed += bytes;
    const c = classify(url);
    perUrl.push({ url, bytes, ...c });
    add(c.party === 'unknown' ? U(c.entity === '(interne navigateur)' ? 'JS interne navigateur' : 'JS sans script (natif, parseur)') : c, bytes, bytes, 'main-js');
  }
  add(U('JS : moteur, déchets, fragmentation'), Math.max(0, v8 - jsAttributed), Math.max(0, v8GC - jsAttributed), 'main-js-rest');
  if (workers) add(U('JS : workers'), workers, workers, 'main-workers');
  add(U('Processus principal hors JS (DOM, rendu, images)'), Math.max(0, fp - v8 - workers), Math.max(0, fpGC - v8GC - workers), 'main-native');

  // aggregate by entity
  const byEntity = {};
  for (const r of rows) {
    const k = r.entity;
    const e = (byEntity[k] = byEntity[k] || { entity: k, category: r.category, party: r.party, bytes: 0, bytesGC: 0, js: 0, iframes: 0, domains: new Set() });
    e.bytes += r.bytes; e.bytesGC += r.bytesGC;
    if (r.kind === 'main-js') e.js += r.bytes;
    if (r.kind === 'iframe-process') e.iframes++;
    if (r.domain) e.domains.add(r.domain);
  }
  const entities = Object.values(byEntity).map(e => ({ ...e, domains: [...e.domains] })).sort((a, b) => b.bytes - a.bytes);
  const sumParty = p => entities.filter(e => e.party === p).reduce((a, e) => a + e.bytes, 0);
  const byCategory = {};
  for (const e of entities) byCategory[e.category] = (byCategory[e.category] || 0) + e.bytes;

  const net = raw.network || {};
  const netByParty = { first: 0, third: 0 };
  let thirdDomains = 0;
  for (const [dom, n] of Object.entries(net)) {
    const c = classify('https://' + dom + '/');
    if (c.party === 'first') netByParty.first += n.bytes; else { netByParty.third += n.bytes; thirdDomains++; }
  }

  // "proportional" variant: JS engine overhead (garbage, headroom, fragmentation) spread pro rata of live JS bytes.
  const jsRest = Math.max(0, v8 - jsAttributed);
  const liveByParty = { first: 0, third: 0 };
  for (const r of rows) if (r.kind === 'main-js' && liveByParty[r.party] !== undefined) liveByParty[r.party] += r.bytes;
  const liveTot = jsAttributed || 1;
  const thirdProp = sumParty('third') + jsRest * liveByParty.third / liveTot;
  const firstProp = sumParty('first') + jsRest * liveByParty.first / liveTot;

  return {
    pageTotal, pageTotalGC, shared,
    proportional: { first: firstProp, third: thirdProp, thirdShare: pageTotal ? thirdProp / pageTotal : 0 },
    first: sumParty('first'), third: sumParty('third'), unattributed: sumParty('unattributed'),
    thirdShare: pageTotal ? sumParty('third') / pageTotal : 0,
    main: { footprint: fp, v8, used, sampledTotal: sampled.total, coverage: used ? sampled.total / used : 0, workers },
    processes: { total: processes.length, renderers: oopifProcesses + 1 + unmapped, oopif: oopifProcesses, unmapped },
    frames: frames.length,
    entities, byCategory,
    // no query string or fragment: sites put their (public) API keys and session ids there, aggregates are published
    topScripts: perUrl.sort((a, b) => b.bytes - a.bytes).slice(0, 15).map(s => ({ url: s.url.replace(/[?#].*$/, '').slice(0, 160), entity: s.entity, mb: +(s.bytes / MB).toFixed(2) })),
    network: { ...netByParty, thirdDomains },
    consent: raw.consent && raw.consent.outcome,
    blocked: raw.blocked || (raw.consent && raw.consent.blocked) || null,
  };
}

module.exports = { attributeRun, MB };
