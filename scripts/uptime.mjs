// Runs every 5 minutes. Fetches each site's main page, adds the result to today's tally,
// and keeps each site's current state. When a site fails twice in a row it opens a GitHub
// issue (GitHub emails and pushes it like any other), and closes it when the site answers again.
import { UA, readJson, writeJson, loadConfig, today, gh } from './lib.mjs';

const TIMEOUT_MS = 20000;
const FAILS_BEFORE_DOWN = 2;
const now = new Date();
const iso = now.toISOString();
const { sites, notify = [] } = loadConfig();
const statePath = 'data/uptime/state.json';
const dayPath = `data/uptime/days/${today(now)}.json`;
const state = readJson(statePath, { sites: {} });
const day = readJson(dayPath, { date: today(now), sites: {} });
const mention = notify.map((n) => '@' + n).join(' ');

async function probe(url) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': UA, 'cache-control': 'no-cache' },
    });
    const ms = Math.round(performance.now() - t0); // time until the response headers arrived
    await res.body?.cancel().catch(() => {});
    return { status: res.status, ms, error: res.status >= 400 ? `HTTP ${res.status}` : '' };
  } catch (e) {
    const reason = e.name === 'TimeoutError'
      ? `No answer within ${TIMEOUT_MS / 1000} s`
      : (e.cause && (e.cause.code || e.cause.message)) || e.message;
    return { status: 0, ms: Math.round(performance.now() - t0), error: String(reason) };
  }
}

const results = await Promise.all(sites.map(async (site) => [site, await probe(site.url)]));
let labelReady = false;

for (const [site, r] of results) {
  const ok = !r.error;
  const d = (day.sites[site.id] ||= { checks: 0, up: 0, ms: [], fails: [] });
  d.checks += 1;
  if (ok) {
    d.up += 1;
    d.ms.push(r.ms);
  } else {
    d.fails.push({ at: iso, status: r.status, error: r.error });
  }

  const s = (state.sites[site.id] ||= { status: 'up', since: iso, fails: 0, incidents: [] });
  s.name = site.name;
  s.url = site.url;
  s.lastCheck = iso;
  s.lastStatus = r.status;
  s.lastMs = ok ? r.ms : null;
  s.lastError = r.error;

  if (ok) {
    if (s.status === 'down') {
      const inc = s.incidents.find((i) => !i.end);
      if (inc) {
        inc.end = iso;
        inc.minutes = Math.max(1, Math.round((now - new Date(inc.start)) / 60000));
      }
      s.status = 'up';
      s.since = iso;
      if (s.issue && gh.ok()) {
        try {
          gh.closeIssue(s.issue, `${site.name} is back up after about ${inc ? inc.minutes : '?'} minutes. It answered with HTTP ${r.status} in ${r.ms} ms.`);
        } catch (e) {
          console.warn('close issue:', e.message);
        }
      }
      s.issue = null;
    }
    s.fails = 0;
    s.firstFailAt = null;
  } else {
    s.fails += 1;
    if (s.fails === 1) s.firstFailAt = iso;
    if (s.status === 'up' && s.fails >= FAILS_BEFORE_DOWN) {
      s.status = 'down';
      s.since = s.firstFailAt || iso;
      s.incidents.unshift({ start: s.since, end: null, minutes: null, reason: r.error });
      s.incidents = s.incidents.slice(0, 20);
      if (gh.ok()) {
        try {
          if (!labelReady) {
            gh.ensureLabel('site-down', 'B60205', 'Opened automatically when a site stops answering');
            labelReady = true;
          }
          const body = [
            `${site.url} stopped answering at ${s.since} (UTC).`,
            '',
            `Reason: ${r.error}.`,
            '',
            'This issue closes itself when the site answers again.',
            mention,
          ].join('\n').trim();
          s.issue = gh.openIssue(`${site.name} is down`, body, 'site-down');
        } catch (e) {
          console.warn('open issue:', e.message);
        }
      }
    }
  }
  console.log(`${site.id}: ${ok ? 'up' : 'FAIL'} ${r.status} ${r.ms} ms ${r.error}`);
}

// A site taken out of sites.json drops out of the state too.
for (const id of Object.keys(state.sites)) if (!sites.some((s) => s.id === id)) delete state.sites[id];
state.updatedAt = iso;
writeJson(statePath, state);
writeJson(dayPath, day);
