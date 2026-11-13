// Shared helpers for the monitor scripts. Plain Node, no packages.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const UA = 'WebsiteHubMonitor/1.0 (+https://github.com/cjasperc/website-hub-monitor)';

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 1) + '\n');
}

// sites.json, keeping only active sites that have an id and a url.
export function loadConfig(file = process.env.SITES_FILE || 'sites.json') {
  const cfg = readJson(file, null);
  if (!cfg || !Array.isArray(cfg.sites)) throw new Error(`${file} is missing or has no "sites" list`);
  return { ...cfg, sites: cfg.sites.filter((s) => s && s.active !== false && s.id && s.url) };
}

export const today = (d = new Date()) => d.toISOString().slice(0, 10);

export const RUN_ID = /^[\w-]{1,80}$/;

// The request this run is answering, as find-request.mjs noted it at the start of the run.
// Scheduled and manual runs have none, so this returns null for them.
export function currentRequest() {
  const saved = readJson('.request.json', null);
  if (saved) return typeof saved.runId === 'string' && RUN_ID.test(saved.runId) ? saved : null;
  return requestFromPush();
}

// The file under requests/ that the triggering push added. Only true before the run moves to a
// newer commit, which is why find-request.mjs saves it first.
export function requestFromPush() {
  if (process.env.EVENT !== 'push') return null;
  try {
    const added = execFileSync('git', ['diff', '--name-only', '--diff-filter=A', 'HEAD~1', 'HEAD', '--', 'requests/'], { encoding: 'utf8' })
      .split('\n').filter((f) => f.endsWith('.json'));
    if (!added.length) return null;
    const req = readJson(added[added.length - 1], null);
    if (!req || typeof req.runId !== 'string' || !RUN_ID.test(req.runId)) return null;
    return { ...req, file: added[added.length - 1] };
  } catch (e) {
    console.warn('request:', e.message);
    return null;
  }
}

// Updates data/requests/<runId>.json, which the Claude task watches to know when the run is done.
export function markRequest(req, fields) {
  if (!req) return;
  const file = `data/requests/${req.runId}.json`;
  writeJson(file, { ...readJson(file, { runId: req.runId, kind: req.kind || 'check' }), ...fields, updatedAt: new Date().toISOString() });
}

// The gh CLI is preinstalled on GitHub's runners and reads GH_TOKEN from the workflow.
// It only runs there (GITHUB_REPOSITORY is set by Actions), and always names the repo.
export const gh = {
  ok: () => !!process.env.GH_TOKEN && !!process.env.GITHUB_ACTIONS && !!process.env.GITHUB_REPOSITORY,
  run(args) {
    return execFileSync('gh', [...args, '--repo', process.env.GITHUB_REPOSITORY], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  },
  ensureLabel(name, color, description) {
    try {
      this.run(['label', 'create', name, '--color', color, '--description', description, '--force']);
    } catch (e) {
      console.warn('label:', e.message);
    }
  },
  openIssue(title, body, label) {
    const url = this.run(['issue', 'create', '--title', title, '--body', body, '--label', label]);
    const n = Number(url.split('/').pop());
    return Number.isFinite(n) ? n : null;
  },
  closeIssue(number, comment) {
    this.run(['issue', 'close', String(number), '--comment', comment]);
  },
};
