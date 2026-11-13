// For a review request only. Opens the site's main page at desktop and phone width, takes
// screenshots down the page, and records what a reviewer would look for in a browser: console
// errors, failed or broken requests, sideways scrolling, links in the header, nav and footer that
// fail, images without alt text or size, and the page's title, description and social tags.
// Saves data/reviews/<runId>/report.json and the screenshots next to it.
import fs from 'node:fs';
import { UA, writeJson, loadConfig, currentRequest, markRequest } from './lib.mjs';

const req = currentRequest();
if (!req || req.kind !== 'review') process.exit(0);
const site = loadConfig().sites.find((s) => s.id === (req.siteIds || [])[0]);
if (!site) {
  markRequest(req, { step: 'Screenshots skipped: the site is not in sites.json' });
  process.exit(0);
}

const dir = `data/reviews/${req.runId}`;
fs.mkdirSync(dir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s, n = 300) => String(s || '').replace(/\s+/g, ' ').slice(0, n);
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const VIEWS = [
  { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false, shots: 4 },
  { name: 'phone', width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true, shots: 4, ua: PHONE_UA },
];

markRequest(req, { step: `Taking screenshots of ${site.name}` });
const { default: puppeteer } = await import('puppeteer-core'); // installed with Lighthouse
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
  headless: true,
});

const report = { runId: req.runId, siteId: site.id, site: site.name, url: site.url, startedAt: new Date().toISOString(), views: {}, page: null, links: [] };

async function visit(view) {
  const page = await browser.newPage();
  const out = { width: view.width, height: view.height, shots: [], consoleErrors: [], pageErrors: [], failedRequests: [], badResponses: [] };
  page.on('console', (m) => { if (m.type() === 'error' && out.consoleErrors.length < 20) out.consoleErrors.push(short(m.text())); });
  page.on('pageerror', (e) => { if (out.pageErrors.length < 20) out.pageErrors.push(short(e.message)); });
  page.on('requestfailed', (r) => {
    const why = r.failure()?.errorText || '';
    if (out.failedRequests.length < 30 && why !== 'net::ERR_ABORTED') out.failedRequests.push({ url: short(r.url(), 200), error: why });
  });
  page.on('response', (r) => { if (r.status() >= 400 && out.badResponses.length < 30) out.badResponses.push({ url: short(r.url(), 200), status: r.status() }); });
  await page.setUserAgent(view.ua || UA.replace('WebsiteHubMonitor', 'Mozilla/5.0 WebsiteHubMonitor'));
  await page.setViewport({ width: view.width, height: view.height, deviceScaleFactor: view.deviceScaleFactor, isMobile: view.isMobile, hasTouch: view.hasTouch });
  try {
    await page.goto(site.url, { waitUntil: 'networkidle2', timeout: 60000 });
  } catch (e) {
    out.loadError = short(e.message);
  }
  await sleep(2500);
  const size = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    screenWidth: document.documentElement.clientWidth, // the layout width, even when a phone zooms out
    pageHeight: document.documentElement.scrollHeight,
  })).catch(() => ({}));
  out.pageHeight = size.pageHeight || null;
  out.sidewaysScroll = size.scrollWidth > size.screenWidth + 1 ? `The page is ${size.scrollWidth}px wide on a ${size.screenWidth}px screen` : '';
  // Screens down the page, the last one ending at the bottom, without repeating a screen.
  const bottom = Math.max(0, (size.pageHeight || view.height) - view.height);
  const stops = [];
  for (let y = 0; stops.length < view.shots && y < bottom; y += view.height) stops.push(y);
  if (stops.length < view.shots && !stops.includes(bottom)) stops.push(bottom);
  for (const [i, y] of stops.entries()) {
    await page.evaluate((top) => window.scrollTo(0, top), y).catch(() => {});
    await sleep(1200);
    const file = `${dir}/${view.name}-${i + 1}.jpg`;
    await page.screenshot({ path: file, type: 'jpeg', quality: 70 });
    out.shots.push({ file, label: `${view.name === 'desktop' ? 'Desktop' : 'Phone'}, ${y === 0 ? 'first screen' : y === bottom ? 'bottom of the page' : `${y}px down`}` });
  }
  if (view.name === 'desktop') {
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    report.page = await page.evaluate(() => {
      const meta = (sel, attr = 'content') => document.querySelector(sel)?.getAttribute(attr) || '';
      const imgs = [...document.images];
      const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => Number(h.tagName[1]));
      const skips = headings.filter((n, i) => i && n > headings[i - 1] + 1).length;
      const links = [...document.querySelectorAll('header a[href], nav a[href], footer a[href]')]
        .map((a) => { try { return new URL(a.getAttribute('href'), location.href); } catch { return null; } })
        .filter((u) => u && u.origin === location.origin)
        .map((u) => u.origin + u.pathname);
      return {
        title: document.title,
        description: meta('meta[name="description"]'),
        canonical: meta('link[rel="canonical"]', 'href'),
        ogTitle: meta('meta[property="og:title"]'),
        ogImage: meta('meta[property="og:image"]'),
        lang: document.documentElement.lang || '',
        h1: [...document.querySelectorAll('h1')].map((h) => h.textContent.trim().replace(/\s+/g, ' ').slice(0, 120)),
        headingSkips: skips,
        images: imgs.length,
        imagesWithoutAlt: imgs.filter((i) => !i.hasAttribute('alt')).map((i) => i.currentSrc || i.src).slice(0, 15),
        imagesWithoutSize: imgs.filter((i) => !i.getAttribute('width') || !i.getAttribute('height')).length,
        links: [...new Set(links)].slice(0, 25),
      };
    }).catch((e) => ({ error: e.message }));
  }
  await page.close();
  return out;
}

try {
  for (const view of VIEWS) {
    try {
      report.views[view.name] = await visit(view);
    } catch (e) {
      report.views[view.name] = { error: short(e.message) };
    }
  }
  for (const href of (report.page && report.page.links) || []) {
    try {
      const r = await fetch(href, { redirect: 'follow', signal: AbortSignal.timeout(20000), headers: { 'user-agent': UA } });
      await r.body?.cancel().catch(() => {});
      report.links.push({ url: href, status: r.status });
    } catch (e) {
      report.links.push({ url: href, status: 0, error: short(e.message, 120) });
    }
  }
} finally {
  await browser.close();
}
report.finishedAt = new Date().toISOString();
writeJson(`${dir}/report.json`, report);
const shots = Object.values(report.views).reduce((n, v) => n + ((v && v.shots) || []).length, 0);
markRequest(req, { step: `Screenshots done: ${shots} taken`, review: `${dir}/report.json` });
console.log(`${shots} screenshots in ${dir}`);
