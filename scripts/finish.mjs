// Last step of the speed workflow: marks the request this run answered as done or failed,
// so the Claude task waiting on it knows it can import. Does nothing for scheduled runs.
//   node scripts/finish.mjs <job status: success, failure or cancelled>
import { currentRequest, markRequest } from './lib.mjs';

const req = currentRequest();
const ok = process.argv[2] === 'success';
markRequest(req, ok
  ? { status: 'done', finishedAt: new Date().toISOString(), step: 'Finished' }
  : { status: 'failed', finishedAt: new Date().toISOString(), step: `The GitHub run ended with "${process.argv[2] || 'unknown'}". See the Actions tab.` });
if (req) console.log(`request ${req.runId}: ${ok ? 'done' : 'failed'}`);
