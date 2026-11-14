// Works out every write the Website Hub needs from this repo's data, so the Claude task that
// imports it only copies ready-made batches into the hub. Same inputs, same writes, every time.
//
//   node scripts/hub-import.mjs --hub <dir> --run <runId> [--sync-sites] [--out <file>]
//
// <dir> holds what the hub's database returned, saved as returned, one file per collection:
//   config.txt   db_list config
//   sites.txt    db_list sites
//   issues.txt   db_list issues (limit 1000)
//   uptime.txt   db_list uptime
//   results.txt  db_query results, orderBy -checkedAt, limit 50
// Every line that is a JSON object with "id" and "data" counts as a document; other lines are skipped.
//
// --sync-sites rewrites sites.json from the hub's sites when they differ (commit and push it after).
// Output: { summary, summaryText, sitesChanged, batches }. Each batch is one db_write call.
// Results come first, oldest first, so an import that stops halfway carries on cleanly next time.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, RUN_ID } from './lib.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i];
  if (!k.startsWith('--')) continue;
  const v = process.argv[i + 1];
  args[k.slice(2)] = v && !v.startsWith('--') ? (i++, v) : true;
}
const fail = (msg) => { console.error(msg); process.exit(2); };
const now = new Date();
const nowIso = now.toISOString();
const runId = String(args.run || '');
if (!RUN_ID.test(runId)) fail('Give the run id with --run (letters, digits, - or _)');
if (!args.hub) fail('Give the folder of saved hub collections with --hub');

// ---------- what the hub holds ----------
function readDocs(file) {
  if (!fs.existsSync(file)) return null;
  const docs = [];
  let more = false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; }
    const isDoc = (x) => x && typeof x.id === 'string' && x.data && typeof x.data === 'object';
    if (isDoc(o)) docs.push(o);
    if (o && Array.isArray(o.docs)) docs.push(...o.docs.filter(isDoc)); // an empty collection comes back as {"docs": []}
    if (o && typeof o.nextCursor === 'string' && o.nextCursor) more = true;
  }
  return { docs, more };
}
const hub = {};
for (const name of ['config', 'sites', 'issues', 'uptime', 'results']) {
  const got = readDocs(path.join(args.hub, `${name}.txt`));
  if (!got) fail(`${name}.txt is missing from ${args.hub}`);
  if (got.more && name !== 'results') fail(`${name}.txt has more pages: list the collection with limit 1000`);
  hub[name] = got.docs;
}
const config = (hub.config.find((d) => d.id === 'app') || { data: {} }).data;
const numOr = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
const targets = {
  speed: numOr(config.speedTarget, 90),
  seo: numOr(config.seoTarget, 90),
  drop: numOr(config.dropAlert, 5),
  lcp: numOr(config.lcpTarget, 2.5),
};
const hubSites = hub.sites.map((d) => ({ id: d.id, ...d.data })).sort((a, b) => (a.order || 0) - (b.order || 0));
const siteOf = (id) => hubSites.find((s) => s.id === id);
const nameOf = (id) => (siteOf(id) || {}).name || id;
const urlOf = (id) => (siteOf(id) || {}).url || '';

// ---------- keep sites.json in step with the hub ----------
let sitesChanged = false;
if (args['sync-sites']) {
  if (!hubSites.length) fail('The hub returned no sites, so sites.json was left alone');
  const current = readJson('sites.json', {});
  const devices = Array.isArray(config.devices) && config.devices.length ? config.devices.filter((d) => d === 'mobile' || d === 'desktop') : current.devices;
  const next = {
    notify: current.notify || [],
    devices: devices && devices.length ? devices : ['mobile', 'desktop'],
    sites: hubSites.filter((s) => /^https?:\/\/[^/]+\.[^/]+/.test(String(s.url || ''))).map((s) => ({
      id: s.id,
      name: s.name || s.id,
      url: s.url,
      page: s.page || 'Home',
      pages: (s.pages || []).filter((p) => p && /^https?:\/\//.test(String(p.url || ''))).map((p) => ({ label: p.label || '', url: p.url })),
      active: s.active !== false,
    })),
  };
  if (JSON.stringify(next) !== JSON.stringify(current)) {
    writeJson('sites.json', next);
    sitesChanged = true;
  }
}

// ---------- speed results ----------
const all = [];
const speedRoot = 'data/speed';
for (const d of fs.existsSync(speedRoot) ? fs.readdirSync(speedRoot).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort() : []) {
  for (const f of fs.readdirSync(path.join(speedRoot, d)).filter((x) => x.endsWith('.json')).sort()) {
    const doc = readJson(path.join(speedRoot, d, f), null);
    if (doc && doc.siteId && doc.device && doc.checkedAt) all.push({ ...doc, file: `${speedRoot}/${d}/${f}` });
  }
}
all.sort((a, b) => String(a.checkedAt).localeCompare(String(b.checkedAt)));
const known = new Set(hub.results.map((d) => d.id));
const newest = hub.results.reduce((m, d) => (String(d.data.checkedAt || '') > m ? String(d.data.checkedAt) : m), '');
const since = newest ? new Date(newest) : new Date(0);
const resultId = (r) => `${String(r.checkedAt).slice(0, 16).replace(/:/g, '')}_${r.device}_${r.siteId}_${r.pageKey || 'home'}`;
const fresh = all.filter((r) => new Date(r.checkedAt) > since && !known.has(resultId(r)));

const titles = (list, n) => (list || []).slice(0, n).map((x) => x.title);
const results = fresh.map((r) => ({
  op: 'set',
  path: `results/${resultId(r)}`,
  data: {
    siteId: r.siteId, site: r.site || nameOf(r.siteId), page: r.page || 'Home', pageKey: r.pageKey || 'home', url: r.url, device: r.device,
    checked: String(r.checkedAt).slice(0, 10), checkedAt: r.checkedAt, runId: r.request || runId, status: r.status,
    speed: r.speed ?? null, seo: r.seo ?? null, accessibility: r.accessibility ?? null, best_practices: r.best_practices ?? null,
    fcp_s: r.fcp_s ?? null, lcp_s: r.lcp_s ?? null, si_s: r.si_s ?? null, tbt_ms: r.tbt_ms ?? null, cls: r.cls ?? null,
    payload_kib: r.payload_kib ?? null, requests: r.requests ?? null,
    fix_first: r.fix_first || '', fix_saving: r.fix_saving || '', seo_issues: r.seo_issues || '',
    opportunities: (r.opportunities || []).slice(0, 4),
    failing: r.failing ? {
      performance: titles(r.failing.performance, 6), accessibility: titles(r.failing.accessibility, 6),
      best_practices: titles(r.failing['best-practices'], 6), seo: titles(r.failing.seo, 6),
    } : null,
    lcp_element: r.lcp_element || '', runs: r.runs || [], lighthouse: r.lighthouse || '',
    source: 'github', file: r.file,
    report: `https://pagespeed.web.dev/analysis?url=${encodeURIComponent(r.url)}&form_factor=${r.device}`,
    note: r.note || '',
  },
}));

// ---------- uptime and site health ----------
const state = readJson('data/uptime/state.json', { sites: {} });
const health = readJson('data/health/latest.json', { sites: {} });
const dayDir = 'data/uptime/days';
const days = (fs.existsSync(dayDir) ? fs.readdirSync(dayDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-30) : [])
  .map((f) => readJson(path.join(dayDir, f), { sites: {} }));
function share(list, id) {
  let checks = 0, up = 0;
  for (const d of list) { const s = d.sites && d.sites[id]; if (s) { checks += s.checks; up += s.up; } }
  return checks ? Math.round((up / checks) * 10000) / 100 : null;
}
function squeeze(ms, points = 48) {
  if (ms.length <= points) return ms.slice();
  const out = [];
  for (let i = 0; i < points; i++) {
    const part = ms.slice(Math.floor((i * ms.length) / points), Math.floor(((i + 1) * ms.length) / points));
    out.push(Math.round(part.reduce((a, b) => a + b, 0) / part.length));
  }
  return out;
}
const p95 = (ms) => (ms.length ? [...ms].sort((a, b) => a - b)[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))] : null);

const uptimeOps = [];
const watched = new Set();
for (const site of hubSites) {
  const s = state.sites[site.id];
  const h = health.sites[site.id];
  if (!s && !h) continue;
  const tracked = days.filter((d) => d.sites && d.sites[site.id]);
  const recent = tracked.slice(-2).flatMap((d) => d.sites[site.id].ms || []).slice(-288); // about a day at one check per 5 minutes
  const today = tracked.length ? tracked[tracked.length - 1] : null;
  if (s) watched.add(site.id);
  if (h) watched.add(site.id);
  const data = {
    siteId: site.id, site: site.name, url: site.url,
    status: s ? s.status : 'unknown', since: s ? s.since || null : null,
    lastCheck: s ? s.lastCheck || null : null, lastMs: s ? s.lastMs ?? null : null, lastStatus: s ? s.lastStatus ?? null : null,
    lastError: s ? s.lastError || '' : '', alertIssue: s ? s.issue || null : null,
    uptimeToday: share(today ? [today] : [], site.id), uptime7d: share(tracked.slice(-7), site.id), uptime30d: share(tracked, site.id),
    daysTracked: tracked.length, firstDay: tracked.length ? tracked[0].date : null,
    checksToday: today ? today.sites[site.id].checks : 0,
    avgMs: recent.length ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length) : null,
    p95Ms: p95(recent), series: squeeze(recent), seriesChecks: recent.length,
    incidents: s ? (s.incidents || []).slice(0, 10) : [],
    health: h ? { checkedAt: health.checkedAt, status: h.status, ssl: h.ssl, headers: h.headers, httpsRedirect: h.httpsRedirect, robots: h.robots, sitemap: h.sitemap, xRobots: h.xRobots, server: h.server } : null,
    importedAt: nowIso, runId,
  };
  const ex = hub.uptime.find((d) => d.id === site.id);
  uptimeOps.push(ex ? { op: 'set', path: `uptime/${site.id}`, data, ifVersion: ex.version } : { op: 'set', path: `uptime/${site.id}`, data });
}
for (const ex of hub.uptime) {
  if (!siteOf(ex.id)) uptimeOps.push({ op: 'delete', path: `uptime/${ex.id}`, ifVersion: ex.version });
}

// ---------- issues ----------
const want = new Map();
const add = (siteId, source, key, fields) => want.set(`${siteId}_${source}_${key}`, { siteId, site: nameOf(siteId), source, url: urlOf(siteId), ...fields });
const oneDp = (n) => String(Math.round(n * 10) / 10);
const size = (k) => (k >= 1024 ? `${(k / 1024).toFixed(k >= 10240 ? 0 : 1)} MB` : `${Math.round(k)} KiB`);
const median = (list) => { const s = [...list].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
// "<p class=\"hx-sub is-revealed\" style=...>" becomes "p.hx-sub"; images and videos keep their file name.
function elementName(snippet) {
  const m = /^<([a-z][a-z0-9-]*)([^>]*)>/i.exec(String(snippet || ''));
  if (!m) return '';
  const attr = (name) => (new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(m[2]) || [])[1] || '';
  const classes = attr('class').split(/\s+/).filter((c) => c && !/^(is|has|js)-/.test(c)).slice(0, 2);
  const src = attr('src') || attr('poster');
  const file = src ? ` (${src.split('?')[0].split('/').pop().slice(0, 60)})` : '';
  return m[1].toLowerCase() + (attr('id') ? `#${attr('id')}` : '') + classes.map((c) => `.${c}`).join('') + file;
}

// Speed and SEO: for every site with new results, judged on the newest result of each device.
const mainPage = (r) => (r.pageKey || 'home') === 'home';
const speedSites = new Set(fresh.filter(mainPage).map((r) => r.siteId));
for (const siteId of speedSites) {
  const failed = [], seoLow = [], heavy = [];
  for (const device of ['mobile', 'desktop']) {
    const mine = all.filter((r) => r.siteId === siteId && r.device === device && mainPage(r));
    const latest = mine[mine.length - 1];
    if (!latest) continue;
    if (latest.status !== 'ok') { failed.push(latest); continue; }
    const fix = latest.fix_first ? `Fix first: ${latest.fix_first}${latest.fix_saving ? ` (saves ${latest.fix_saving})` : ''}.` : '';
    if (latest.speed != null && latest.speed < targets.speed) {
      add(siteId, 'pagespeed', `speed-${device}`, { device, severity: latest.speed < 50 ? 'high' : 'medium', title: `Speed ${latest.speed} on ${device}`, detail: `Target ${targets.speed}.${fix ? ' ' + fix : ''}` });
    }
    const before = mine.slice(0, -1).filter((r) => r.status === 'ok' && r.speed != null).slice(-7);
    if (before.length >= 2 && latest.speed != null) {
      const usual = median(before.map((r) => r.speed));
      if (usual - latest.speed >= targets.drop) {
        add(siteId, 'pagespeed', `drop-${device}`, { device, severity: 'medium', title: `Speed fell ${usual - latest.speed} points on ${device}`, detail: `It usually scores about ${usual} (last ${before.length} checks) and scored ${latest.speed} on ${String(latest.checkedAt).slice(0, 10)}.` });
      }
    }
    if (latest.lcp_s != null && latest.lcp_s > targets.lcp) {
      const element = elementName(latest.lcp_element) ? ` Largest element on screen: ${elementName(latest.lcp_element)}.` : '';
      add(siteId, 'pagespeed', `lcp-${device}`, { device, severity: latest.lcp_s > 4 ? 'high' : 'medium', title: `Main content shows late on ${device} (LCP ${oneDp(latest.lcp_s)} s)`, detail: `Target ${targets.lcp} s.${element}${fix ? ' ' + fix : ''}` });
    }
    if (latest.seo != null && latest.seo < targets.seo) seoLow.push(latest);
    if (latest.payload_kib != null && latest.payload_kib > 4000) heavy.push(latest);
  }
  if (failed.length) {
    add(siteId, 'pagespeed', 'failed', { severity: 'high', title: `Lighthouse could not test ${urlOf(siteId) || failed[0].url}`, detail: failed.map((r) => `${r.device}: ${r.note || 'the test failed'}`).join(' ') });
  }
  if (seoLow.length) {
    const worst = seoLow.reduce((a, b) => (b.seo < a.seo ? b : a));
    const blocked = /blocked from indexing/i.test(worst.seo_issues || '');
    const xr = (health.sites[siteId] || {}).xRobots || '';
    const detail = blocked && /noindex/i.test(xr)
      ? `The server sends "X-Robots-Tag: ${xr}", so search engines leave the page out. Fine for a staging site; remove it before launch.`
      : blocked ? 'A noindex tag keeps search engines away from this page. Remove it unless that is intended.' : `Target ${targets.seo}.`;
    add(siteId, 'pagespeed', 'seo', { severity: worst.seo < 70 ? 'high' : 'medium', title: `SEO ${worst.seo}: ${worst.seo_issues || 'see the report'}`, detail });
  }
  if (heavy.length) {
    const worst = heavy.reduce((a, b) => (b.payload_kib > a.payload_kib ? b : a));
    // Files that differ only by a number before the extension (frame_0116.webp) count as one group.
    const groups = new Map();
    for (const f of worst.heaviest || []) {
      const key = String(f.file).replace(/\d+(?=\.[a-z0-9]+$)/i, '*');
      const g = groups.get(key) || { n: 0, kib: 0, one: f.file };
      groups.set(key, { n: g.n + (f.count || 1), kib: g.kib + f.kib, one: g.one });
    }
    const biggest = [...groups].sort((a, b) => b[1].kib - a[1].kib).slice(0, 3)
      .map(([key, g]) => (g.n > 1 ? `${key} (${g.n} files, ${size(g.kib)})` : `${g.one} (${size(g.kib)})`));
    add(siteId, 'pagespeed', 'payload', {
      severity: worst.payload_kib > 20000 ? 'high' : 'medium',
      title: `Page downloads about ${Math.max(1, Math.round(worst.payload_kib / 1024))} MB`,
      detail: `Lighthouse measured ${heavy.map((r) => `${size(r.payload_kib)}${r.requests ? ` in ${r.requests} requests` : ''} on ${r.device}`).join(' and ')}.${biggest.length ? ` Biggest: ${biggest.join(', ')}.` : ''} Most pages stay under 2 MB.`,
    });
  }
}

// Uptime and site health: every site GitHub watches.
for (const siteId of watched) {
  const s = state.sites[siteId];
  const h = health.sites[siteId];
  if (s && s.status === 'down') {
    add(siteId, 'uptime', 'down', { severity: 'high', title: 'Site is down', detail: `It has not answered since ${String(s.since).slice(0, 16).replace('T', ' ')} UTC (${s.lastError || 'no answer'}). GitHub checks it every 5 minutes and emails you when it changes.` });
  }
  if (!h) continue;
  const host = (() => { try { return new URL(urlOf(siteId)).host; } catch { return ''; } })();
  if (h.ssl && h.ssl.error) {
    add(siteId, 'health', 'ssl', { severity: 'medium', title: 'The certificate could not be checked', detail: `The secure connection failed: ${h.ssl.error}.` });
  } else if (h.ssl && h.ssl.daysLeft <= 21) {
    add(siteId, 'health', 'ssl', { severity: h.ssl.daysLeft <= 7 ? 'high' : 'medium', title: `Certificate expires in ${h.ssl.daysLeft} days`, detail: `Valid until ${String(h.ssl.validTo).slice(0, 10)}. Check that auto renewal is on with the host.` });
  }
  if (h.httpsRedirect === false) {
    add(siteId, 'health', 'https', { severity: 'high', title: 'http does not redirect to https', detail: `http://${host}/ should send visitors to the https address.` });
  }
  if (h.headers && h.headers.hsts === false) {
    add(siteId, 'health', 'hsts', { severity: 'low', title: 'No HSTS header', detail: 'Add Strict-Transport-Security so browsers always use https for this site.' });
  }
  if (h.robots && h.robots !== 200) add(siteId, 'health', 'robots', { severity: 'low', title: `robots.txt answers ${h.robots}`, detail: 'Search engines read robots.txt first. It should answer 200.' });
  if (h.sitemap && h.sitemap !== 200) add(siteId, 'health', 'sitemap', { severity: 'low', title: `sitemap.xml answers ${h.sitemap}`, detail: 'A sitemap helps search engines find every page.' });
}

const issueOps = [];
const tally = { opened: 0, updated: 0, reopened: 0, fixed: 0 };
const byId = new Map(hub.issues.map((d) => [d.id, d]));
for (const [id, w] of want) {
  const ex = byId.get(id);
  if (!ex) {
    issueOps.push({ op: 'set', path: `issues/${id}`, data: { ...w, runId, firstSeen: nowIso, lastSeen: nowIso, status: 'new' } });
    tally.opened++;
    continue;
  }
  const d = ex.data;
  const changed = ['severity', 'title', 'detail', 'device'].some((k) => (d[k] ?? null) !== (w[k] ?? null));
  if (!changed && d.status !== 'fixed') continue;
  const patch = { severity: w.severity, title: w.title, detail: w.detail, runId, lastSeen: nowIso };
  if (w.device) patch.device = w.device;
  if (d.status === 'fixed') { patch.status = 'new'; patch.fixedAt = { __delete__: true }; tally.reopened++; } else tally.updated++;
  issueOps.push({ op: 'update', path: `issues/${id}`, data: patch, ifVersion: ex.version });
}
for (const ex of hub.issues) {
  const d = ex.data;
  if (want.has(ex.id) || d.status === 'fixed') continue;
  const judged = (d.source === 'pagespeed' && speedSites.has(d.siteId)) || ((d.source === 'uptime' || d.source === 'health') && watched.has(d.siteId));
  if (!judged) continue;
  issueOps.push({ op: 'update', path: `issues/${ex.id}`, data: { status: 'fixed', fixedAt: nowIso, runId }, ifVersion: ex.version });
  tally.fixed++;
}

// ---------- batches ----------
const ops = [...results, ...uptimeOps, ...issueOps];
const batches = [];
let cur = [], bytes = 0;
for (const op of ops) {
  const n = JSON.stringify(op).length;
  if (cur.length && (cur.length >= 25 || bytes + n > 24000)) { batches.push(cur); cur = []; bytes = 0; }
  cur.push(op);
  bytes += n;
}
if (cur.length) batches.push(cur);

// Sites the hub watches that have no speed results yet for today (UTC), for the run's log.
const day = nowIso.slice(0, 10);
const notToday = hubSites.filter((s) => s.active !== false && !all.some((r) => r.siteId === s.id && String(r.checkedAt).slice(0, 10) === day));

const names = (ids) => {
  const list = [...ids].map(nameOf);
  return list.length < 3 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
};
const down = uptimeOps.filter((o) => o.data && o.data.status === 'down').map((o) => o.data.site);
const resultSites = new Set(fresh.map((r) => r.siteId));
const summary = {
  runId, since: newest || null, newResults: results.length, resultSites: [...resultSites], uptimeSites: uptimeOps.filter((o) => o.op === 'set').length,
  notToday: notToday.map((s) => s.id),
  issues: tally, down, writes: ops.length, batches: batches.length, sitesChanged,
};
const parts = [
  results.length ? `${results.length} new result${results.length === 1 ? '' : 's'} for ${names(resultSites)}.` : 'No new speed results.',
  `Issues: ${tally.opened} new, ${tally.updated + tally.reopened} changed, ${tally.fixed} fixed.`,
  watched.size ? (down.length ? `Down now: ${down.join(', ')}.` : 'Every site is up.') : 'No uptime data yet.',
  notToday.length ? `No speed check yet today for ${names(notToday.map((s) => s.id))}.` : '',
].filter(Boolean);
const out = { summary, summaryText: parts.join(' '), sitesChanged, batches };
if (args.out) writeJson(args.out, out); else process.stdout.write(JSON.stringify(out, null, 1) + '\n');
console.error(JSON.stringify(summary));
