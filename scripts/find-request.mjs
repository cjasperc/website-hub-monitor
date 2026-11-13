// First step of the speed workflow: notes which request (if any) started this run, in
// .request.json, before the workflow moves on to the newest commit. The other scripts read it.
import fs from 'node:fs';
import { requestFromPush } from './lib.mjs';

const req = requestFromPush();
fs.writeFileSync('.request.json', JSON.stringify(req || {}) + '\n');
console.log(req ? `request ${req.runId} (${req.kind || 'check'}): ${(req.siteIds || []).join(', ')}` : 'no request: checking every site');
