// Runs the quality test: generate alternatives with the evidence locked, review and score them,
// then build the report. Re-running resumes from where it stopped.
// Every paper is scored three times and the reports use the mean (--replicates changes the count).
// Usage: npm run test-run -- --case <name> [--pilot] [--budget 80] [--concurrency 4] [--replicates 3]
import {parseArgs} from 'node:util';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {caseDirFor} from '../src/config.js';
import {Llm} from '../src/llm.js';
import {Corpus} from '../src/corpus.js';
import {Embedder} from '../src/embeddings.js';
import {computeDistance} from '../src/distance.js';
import {planTest, runTest} from '../src/pipeline.js';
import {buildReport} from '../src/report.js';
import {buildExplorerData} from '../src/explorer.js';

const {values} = parseArgs({options: {
  case: {type: 'string'},
  pilot: {type: 'boolean', default: false},
  budget: {type: 'string', default: '80'},
  concurrency: {type: 'string', default: '4'},
  open: {type: 'string', default: '24'},
  'per-field': {type: 'string', default: '4'},
  replicates: {type: 'string', default: '3'}
}});
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('No API key found. Create .env containing ANTHROPIC_API_KEY=your-key (see .env.example), or set ANTHROPIC_API_KEY in the environment.');
  process.exit(1);
}
if (!values.case) {
  console.error('Usage: npm run test-run -- --case <name> [--pilot] [--budget 80] [--concurrency 4]');
  process.exit(1);
}
const caseDir = caseDirFor(values.case);
const testDir = path.join(caseDir, values.pilot ? 'pilot' : 'test');
const tasks = planTest({pilot: values.pilot, openRuns: Number(values.open), perField: Number(values['per-field'])});
const llm = await new Llm({budgetFile: path.join(caseDir, 'budget.json'), budgetUsd: Number(values.budget), logDir: testDir, concurrency: Number(values.concurrency)}).init();
const startSpend = llm.spentUsd;
console.log(`${tasks.length} AI alternatives planned for ${values.case}. Spent so far on this case: $${startSpend.toFixed(2)} of $${llm.budgetUsd}.`);
const corpus = Corpus.load();
// With the corpus embeddings built, scoring uses hybrid retrieval and the run gets the distance measures.
const embedder = corpus.vectors ? await new Embedder().init() : null;
if (!embedder) console.log('No corpus embeddings: scoring retrieves by BM25 only. Run `npm run build-embeddings` to add embedding retrieval and distance.');
const result = await runTest({caseDir, testDir, llm, corpus, embedder, tasks, scoreReplicates: Number(values.replicates)});
if (embedder && !result.stoppedAt) await computeDistance({caseDir, testDir, corpus, embedder});
await buildReport({caseDir, testDir});
// A pilot shows in the explorer until the full test replaces it.
const hasTest = values.pilot && existsSync(path.join(caseDir, 'test', 'alternatives.jsonl'));
if (!hasTest) await buildExplorerData({caseId: values.case, caseDir, testDir, corpus, pilot: values.pilot});
console.log(`\nThis run: ${llm.calls} calls, $${(llm.spentUsd - startSpend).toFixed(2)}. Total for this case: $${llm.spentUsd.toFixed(2)} of $${llm.budgetUsd}.`);
console.log(result.stoppedAt ? `Stopped at the ${result.stoppedAt} stage when the spending cap was reached. Raise --budget to continue.` : 'Complete.');
console.log(`Report: ${path.relative(process.cwd(), path.join(testDir, 'summary.md'))}`);
console.log(hasTest ? 'The explorer keeps showing the full test, not this pilot.' : 'Explore it: npm run app');
