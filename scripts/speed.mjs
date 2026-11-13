// Runs Lighthouse three times per page and device, keeps the median run, and saves one
// summary per page. Runs daily, and on request from the hub (a file pushed to requests/).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readJson, writeJson, loadConfig, today } from './lib.mjs';
import { summarize } from './summarize.mjs';

const RUNS = Math.max(1, Number(process.env.RUNS || 3));
const cfg = loadConfig();
const now = new Date();
const date = today(now);

// What to check: the request file this push added, the manual input, or every site.
function request() {
  if (process.env.EVENT === 'push') {
    try {
      const added = execFileSync('git', ['diff', '--name-only', '--diff-filter=A', 'HEAD~1', 'HEAD', '--', 'requests/'], { encoding: 'utf8' })
        .split('\n').filter(Boolean);
      if (added.length) return { file: added[added.length - 1], ...readJson(added[added.length - 1], {}) };
    } catch (e) {
      console.warn('request:', e.message);
    }
  }
  if (process.env.INPUT_SITES) return { siteIds: process.env.INPUT_SITES.split(',').map((s) => s.trim()).filter(Boolean) };
  return {};
}

const req = request();
const runId = typeof req.runId === 'string' && /^[\w-]{1,80}$/.test(req.runId) ? req.runId : null;
const wanted = Array.isArray(req.siteIds) && req.siteIds.length ? req.siteIds : null;
const devices = (Array.isArray(req.devices) && req.devices.length ? req.devices : cfg.devices || ['mobile', 'desktop'])
  .filter((d) => d === 'mobile' || d === 'desktop');
const sites = cfg.sites.filter((s) => !wanted || wanted.includes(s.id));
const lighthouse = path.resolve(process.env.LIGHTHOUSE_BIN || 'node_modules/.bin/lighthouse');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-'));

function pageKey(url, main) {
  if (main) return 'home';
  const p = new URL(url).pathname.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return p || 'home';
}

function runOnce(url, device, i) {
  const out = path.join(tmp, `${Date.now()}-${i}.json`);
  const args = [url, '--output=json', `--output-path=${out}`, '--quiet',
    '--only-categories=performance,accessibility,best-practices,seo',
    '--chrome-flags=--headless=new --no-sandbox --disable-gpu'];
  if (device === 'desktop') args.push('--preset=desktop');
  execFileSync(lighthouse, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 240000 });
  const lhr = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.rmSync(out, { force: true });
  if (lhr.runtimeError) throw new Error(lhr.runtimeError.message || lhr.runtimeError.code);
  return lhr;
}

if (runId) writeJson(`data/requests/${runId}.json`, { runId, status: 'running', startedAt: now.toISOString(), siteIds: sites.map((s) => s.id), devices });

const written = [];
for (const site of sites) {
  const pages = [{ label: site.page || 'Home', url: site.url, main: true },
    ...(site.pages || []).filter((p) => p && p.url).map((p) => ({ label: p.label || p.url, url: p.url, main: false }))];
  for (const page of pages) {
    for (const device of devices) {
      const runs = [];
      let lastError = '';
      for (let i = 0; i < RUNS; i++) {
        try {
          runs.push(summarize(runOnce(page.url, device, i)));
        } catch (e) {
          lastError = (e.stderr && e.stderr.toString().split('\n').filter(Boolean).pop()) || e.message;
          console.warn(`${site.id} ${device} run ${i + 1} failed: ${lastError}`);
        }
      }
      runs.sort((x, y) => (x.speed ?? -1) - (y.speed ?? -1));
      const median = runs[Math.floor(runs.length / 2)] || null;
      const key = pageKey(page.url, page.main);
      const base = { siteId: site.id, site: site.name, page: page.label, pageKey: key, url: page.url, device, request: runId };
      const doc = median
        ? { ...median, ...base, status: 'ok', runs: runs.map((r) => r.speed), note: runs.length < RUNS ? `${RUNS - runs.length} of ${RUNS} runs failed: ${lastError}` : '' }
        : { ...base, status: 'error', checkedAt: new Date().toISOString(), note: lastError || 'Lighthouse failed' };
      const file = `data/speed/${date}/${site.id}_${key}_${device}.json`;
      writeJson(file, doc);
      written.push(file);
      console.log(`${site.id} ${key} ${device}: ${doc.status}, speed ${doc.speed ?? '-'}, SEO ${doc.seo ?? '-'}, runs ${doc.runs ? doc.runs.join('/') : '-'}`);
    }
  }
}

const finishedAt = new Date().toISOString();
writeJson('data/speed/latest.json', { date, startedAt: now.toISOString(), finishedAt, request: runId, files: written });
if (runId) writeJson(`data/requests/${runId}.json`, { runId, status: 'done', startedAt: now.toISOString(), finishedAt, files: written });
