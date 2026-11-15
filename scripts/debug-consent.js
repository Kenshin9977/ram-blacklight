// Debug: list consent-like clickable elements in all frames of a page.
// node scripts/debug-consent.js URL
const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  const ctx = await browser.newContext({ userAgent: require('../src/measure').USER_AGENT, locale: 'fr-FR', timezoneId: 'Europe/Paris', viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  const resp = await page.goto(process.argv[2], { waitUntil: 'load', timeout: 45000 }).catch(e => console.log('goto', e.message.split('\n')[0]));
  console.log('status', resp && resp.status(), 'title', await page.title());
  await page.waitForTimeout(8000);
  for (const f of page.frames()) {
    const items = await f.evaluate(() => {
      const out = [];
      const visit = root => {
        for (const el of root.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')) {
          const txt = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
          if (/accep|refus|cookie|compris|continuer|consent|autoris|param/i.test(txt) && txt.length < 80) {
            const r = el.getBoundingClientRect();
            out.push(`${el.tagName}#${el.id}.${String(el.className).slice(0, 40)} [${Math.round(r.width)}x${Math.round(r.height)}] "${txt}"`);
          }
        }
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) visit(el.shadowRoot);
      };
      visit(document);
      return out;
    }).catch(e => ['ERR ' + e.message.split('\n')[0]]);
    if (items.length) console.log('FRAME', f.url().slice(0, 80), '\n  ' + items.join('\n  '));
  }
  await browser.close();
})();
