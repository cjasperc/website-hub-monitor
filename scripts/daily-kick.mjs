// Runs after each uptime check. GitHub's own morning timer for the speed workflow is best effort and
// sometimes never fires, so if any site still has no speed results for today (UTC), this starts the
// speed workflow in daily mode, which tests only those sites. It does nothing when a speed run is
// already queued or running, or when one was started in the last hour, so a failing run isn't
// started over and over.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadConfig, today } from './lib.mjs';

const cfg = loadConfig();
const day = today();
const devices = cfg.devices || ['mobile', 'desktop'];
const missing = cfg.sites.filter((s) => devices.some((d) => !fs.existsSync(`data/speed/${day}/${s.id}_home_${d}.json`)));
if (!missing.length) {
  console.log(`Every site has speed results for ${day}.`);
  process.exit(0);
}
const names = missing.map((s) => s.id).join(', ');
const repo = process.env.GITHUB_REPOSITORY;
if (!process.env.GITHUB_ACTIONS || !process.env.GH_TOKEN || !repo) {
  console.log(`Would start today's speed check for ${names}.`);
  process.exit(0);
}
const recent = JSON.parse(execFileSync('gh', ['run', 'list', '--repo', repo, '--workflow', 'daily.yml', '--limit', '5', '--json', 'status,createdAt'], { encoding: 'utf8' }));
const hourAgo = Date.now() - 3600e3;
if (recent.some((r) => r.status !== 'completed' || new Date(r.createdAt).getTime() > hourAgo)) {
  console.log(`A speed run is running or started in the last hour; leaving ${names} for later.`);
  process.exit(0);
}
execFileSync('gh', ['workflow', 'run', 'daily.yml', '--repo', repo, '--ref', 'main', '-f', 'daily=true'], { stdio: 'inherit' });
console.log(`Started today's speed check for ${names}.`);
