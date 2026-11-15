// Feasibility probe: memory-infra dump + frame->pid mapping via CDP tracing.
const { chromium } = require('playwright-core');

async function readStream(cdp, handle) {
  let out = '';
  for (;;) {
    const r = await cdp.send('IO.read', { handle, size: 1 << 20 });
    out += r.base64Encoded ? Buffer.from(r.data, 'base64').toString() : r.data;
    if (r.eof) break;
  }
  await cdp.send('IO.close', { handle });
  return out;
}

(async () => {
  const url = process.argv[2] || 'https://www.lefigaro.fr/';
  const browser = await chromium.launch({ headless: true, args: ['--site-per-process'] });
  const ctx = await browser.newContext({ locale: 'fr-FR', timezoneId: 'Europe/Paris', viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'load', timeout: 60000 }).catch(e => console.log('goto', e.message));
  await page.waitForTimeout(8000);
  console.log('frames', page.frames().length);

  const cdp = process.env.PAGE ? await ctx.newCDPSession(page) : await browser.newBrowserCDPSession();
  const done = new Promise(res => cdp.on('Tracing.tracingComplete', res));
  await cdp.send('Tracing.start', {
    transferMode: 'ReturnAsStream',
    traceConfig: {
      includedCategories: ['disabled-by-default-memory-infra', 'devtools.timeline', 'disabled-by-default-devtools.timeline', '__metadata'],
      
      memoryDumpConfig: { triggers: [] },
    },
  });
  const d = await cdp.send('Tracing.requestMemoryDump', { deterministic: false, levelOfDetail: 'detailed' });
  console.log('dump', d);
  await cdp.send('Tracing.end');
  const { stream } = await done;
  const json = JSON.parse(await readStream(cdp, stream));
  const ev = json.traceEvents || json;
  const names = {};
  for (const e of ev) names[e.name] = (names[e.name] || 0) + 1;
  console.log(names);
  const tsib = ev.find(e => e.name === 'TracingStartedInBrowser');
  console.log('TSIB frames', JSON.stringify(tsib?.args?.data?.frames?.slice(0, 50).map(f => [f.processId, f.url?.slice(0, 80), !!f.parent])));
  const procNames = ev.filter(e => e.name === 'process_name' || e.name === 'process_labels').map(e => [e.pid, e.name, e.args]);
  console.log(JSON.stringify(procNames));
  for (const e of ev.filter(e => e.ph === 'v')) {
    const pt = e.args?.dumps?.process_totals;
    const a = e.args?.dumps?.allocators || {};
    const top = Object.keys(a).filter(k => !k.includes('/')).map(k => [k, a[k].attrs?.size?.value && parseInt(a[k].attrs.size.value, 16)]);
    console.log(e.pid, JSON.stringify(pt), JSON.stringify(top));
  }
  await browser.close();
})();
