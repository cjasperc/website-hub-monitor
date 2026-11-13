// Waits for the GitHub run that a request started: pulls every 30 seconds and reads
// data/requests/<runId>.json. Prints each change of step.
// Exit 0 when done, 1 when the run failed, 3 when the time is up (call it again to keep waiting).
//   node scripts/wait.mjs --run <runId> [--minutes 9]
import { execFileSync } from 'node:child_process';
import { readJson, RUN_ID } from './lib.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const runId = args.run || '';
if (!RUN_ID.test(runId)) { console.error(`Bad run id "${runId}"`); process.exit(2); }
const until = Date.now() + Math.min(Number(args.minutes) || 9, 9.5) * 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pull() {
  try {
    execFileSync('git', ['pull', '-q', '--ff-only'], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch {
    execFileSync('git', ['pull', '-q', '--rebase'], { stdio: ['ignore', 'ignore', 'pipe'] });
  }
}

let last = '';
for (;;) {
  try { pull(); } catch (e) { console.log(`pull failed, retrying: ${e.message.split('\n')[0]}`); }
  const r = readJson(`data/requests/${runId}.json`, null);
  const line = r ? `${r.status}: ${r.step || ''}` : 'waiting for GitHub to start';
  if (line !== last) { console.log(`${new Date().toISOString().slice(11, 19)} ${line}`); last = line; }
  if (r && r.status === 'done') process.exit(0);
  if (r && r.status === 'failed') process.exit(1);
  if (Date.now() + 30000 > until) { console.log('Still running. Call wait.mjs again to keep waiting.'); process.exit(3); }
  await sleep(30000);
}
