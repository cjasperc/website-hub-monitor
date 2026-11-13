// Writes requests/<runId>.json. Committing and pushing it starts the speed workflow for just
// these sites, and for a review it also takes screenshots. Used by the hub's Claude tasks.
//   node scripts/ask.mjs --run <runId> --kind check|review --sites id1,id2 [--devices mobile,desktop]
import fs from 'node:fs';
import { writeJson, loadConfig, RUN_ID } from './lib.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const fail = (msg) => { console.error(msg); process.exit(2); };

const runId = args.run || '';
const kind = args.kind || 'check';
if (!RUN_ID.test(runId)) fail(`Run id "${runId}" must be 1 to 80 letters, digits, - or _`);
if (!['check', 'review'].includes(kind)) fail(`Kind "${kind}" must be check or review`);
const cfg = loadConfig();
const known = cfg.sites.map((s) => s.id);
const siteIds = String(args.sites || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!siteIds.length) fail('Give at least one site id with --sites');
const unknown = siteIds.filter((id) => !known.includes(id));
if (unknown.length) fail(`Not in sites.json (or paused): ${unknown.join(', ')}. Known: ${known.join(', ')}`);
if (kind === 'review' && siteIds.length !== 1) fail('A review covers one site');
const devices = String(args.devices || (cfg.devices || ['mobile', 'desktop']).join(',')).split(',').map((d) => d.trim())
  .filter((d) => d === 'mobile' || d === 'desktop');
if (!devices.length) fail('Devices must be mobile, desktop or both');

const file = `requests/${runId}.json`;
if (fs.existsSync(file)) fail(`${file} already exists: this run was requested before`);
writeJson(file, { runId, kind, siteIds, devices, requestedAt: new Date().toISOString() });
console.log(file);
