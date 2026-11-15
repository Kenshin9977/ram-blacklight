// A task that hangs after launching a browser: withBrowserScope's closeAll must close it.
// node test/timeout-closes-browser.js
const assert = require('assert');
const { withBrowserScope, launchBrowser } = require('../src/measure');

(async () => {
  let launched;
  const { promise, closeAll } = withBrowserScope(async () => {
    launched = await launchBrowser(true);
    await new Promise(() => {}); // hang forever, like a stuck page.waitFor...
  });
  promise.catch(() => {});
  while (!launched) await new Promise(r => setTimeout(r, 100));
  assert.ok(launched.isConnected(), 'browser should be up');
  await closeAll();
  assert.ok(!launched.isConnected(), 'browser should be closed after closeAll');
  console.log('ok: hung task browser closed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
