// Runs daily. Records each site's certificate expiry, security headers, the http to https
// redirect, and whether robots.txt and sitemap.xml answer.
import tls from 'node:tls';
import { UA, writeJson, loadConfig, today } from './lib.mjs';

const now = new Date();
const { sites } = loadConfig();

function certificate(host) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port: 443, servername: host, timeout: 15000 }, () => {
      const c = socket.getPeerCertificate();
      socket.end();
      if (!c || !c.valid_to) return resolve({ error: 'No certificate' });
      const validTo = new Date(c.valid_to);
      resolve({
        validTo: validTo.toISOString(),
        daysLeft: Math.floor((validTo - now) / 86400000),
        issuer: (c.issuer && (c.issuer.O || c.issuer.CN)) || '',
      });
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ error: 'Timed out' });
    });
    socket.on('error', (e) => resolve({ error: e.code || e.message }));
  });
}

async function get(url, redirect = 'follow') {
  try {
    const r = await fetch(url, { redirect, signal: AbortSignal.timeout(20000), headers: { 'user-agent': UA } });
    await r.body?.cancel().catch(() => {});
    return r;
  } catch (e) {
    return { status: 0, headers: new Headers(), error: e.message };
  }
}

const out = { date: today(now), checkedAt: now.toISOString(), sites: {} };
for (const site of sites) {
  const u = new URL(site.url);
  const [ssl, page, plain, robots, sitemap] = await Promise.all([
    certificate(u.hostname),
    get(site.url),
    get(`http://${u.host}/`, 'manual'),
    get(`${u.origin}/robots.txt`),
    get(`${u.origin}/sitemap.xml`),
  ]);
  const h = page.headers;
  const csp = h.get('content-security-policy') || '';
  const location = plain.headers.get('location') || '';
  out.sites[site.id] = {
    ssl,
    status: page.status,
    headers: {
      hsts: !!h.get('strict-transport-security'),
      csp: !!csp,
      nosniff: (h.get('x-content-type-options') || '').toLowerCase() === 'nosniff',
      frame: !!h.get('x-frame-options') || /frame-ancestors/i.test(csp),
      referrer: !!h.get('referrer-policy'),
    },
    server: h.get('server') || '',
    httpsRedirect: plain.status >= 300 && plain.status < 400 && location.startsWith('https://'),
    robots: robots.status,
    sitemap: sitemap.status,
    xRobots: h.get('x-robots-tag') || '',
  };
  console.log(site.id, JSON.stringify(out.sites[site.id]));
}
writeJson(`data/health/${out.date}.json`, out);
writeJson('data/health/latest.json', out);
