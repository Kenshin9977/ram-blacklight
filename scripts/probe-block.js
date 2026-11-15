// Quick reachability check with the campaign UA: status, title, element count, captcha frames.
// node scripts/probe-block.js URL...
const { chromium } = require('playwright-core');
const { USER_AGENT } = require('../src/measure');
(async () => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  for (const url of process.argv.slice(2)) {
    const ctx = await browser.newContext({ userAgent: USER_AGENT, locale: 'fr-FR', timezoneId: 'Europe/Paris', viewport: { width: 1366, height: 768 } });
    const page = await ctx.newPage();
    const resp = await page.goto(url, { waitUntil: 'load', timeout: 45000 }).catch(e => ({ status: () => e.message.split('\n')[0] }));
    await page.waitForTimeout(3000);
    const n = await page.evaluate(() => document.querySelectorAll('*').length).catch(() => -1);
    const captcha = page.frames().some(f => /captcha|challenges\.cloudflare/.test(f.url()));
    console.log(url, '|', resp && resp.status(), '|', (await page.title().catch(() => '')).slice(0, 60), '| nodes', n, captcha ? '| CAPTCHA' : '');
    await ctx.close();
  }
  await browser.close();
})();
