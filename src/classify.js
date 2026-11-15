// URL -> { domain, entity, category, party } attribution.
// Entity/category database: third-party-web (MIT, used by Lighthouse).
const { getDomain, getHostname } = require('tldts');
const tpw = require('third-party-web');

// third-party-web categories -> categories used in reports.
const CATEGORY_MAP = {
  ad: 'pub',
  analytics: 'analytics',
  social: 'social',
  video: 'video',
  cdn: 'cdn',
  hosting: 'cdn',
  'tag-manager': 'tag-manager',
  'consent-provider': 'consentement',
  'customer-success': 'widget',
  content: 'contenu',
  utility: 'utilitaire',
  marketing: 'marketing',
  other: 'autre',
};

function makeClassifier(pageUrl, firstPartyAliases = []) {
  const pageDomain = getDomain(pageUrl) || getHostname(pageUrl);
  const pageEntity = tpw.getEntity(pageUrl);
  const fpDomains = new Set([pageDomain, ...firstPartyAliases]);
  const cache = new Map();

  return function classify(url) {
    if (url && url.startsWith('blob:')) url = url.slice(5);
    if (!url) return { domain: '(aucun)', entity: '(sans script)', category: 'inconnu', party: 'unknown' };
    // browser-internal scripts (v8/LoadTimes, extensions::, about:blank...) are not the site's or a third party's
    if (!/^(https?|wss?):/.test(url)) return { domain: '(interne)', entity: '(interne navigateur)', category: 'inconnu', party: 'unknown' };
    const host = getHostname(url) || '';
    const domain = getDomain(url) || host || '(inconnu)';
    if (cache.has(domain)) return cache.get(domain);
    let res;
    const ent = tpw.getEntity(url);
    if (fpDomains.has(domain) || (pageEntity && ent && ent.name === pageEntity.name)) {
      res = { domain, entity: '1re partie', category: 'first-party', party: 'first' };
    } else if (ent) {
      const cat = (ent.categories && ent.categories[0]) || 'other';
      res = { domain, entity: ent.name, category: CATEGORY_MAP[cat] || cat, party: 'third' };
    } else {
      res = { domain, entity: domain, category: 'inconnu', party: 'third' };
    }
    cache.set(domain, res);
    return res;
  };
}

module.exports = { makeClassifier };
