// Builds the explorer data bundle for each case with a completed test or pilot (or the cases named).
// A case with a full test shows the test; one with only a pilot shows the pilot.
// Usage: npm run build-explorer [-- --case my-paper]
import {parseArgs} from 'node:util';
import {readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {ROOT, RUNS_DIR, caseDirFor} from '../src/config.js';
import {Corpus} from '../src/corpus.js';
import {buildExplorerData} from '../src/explorer.js';

const {values} = parseArgs({options: {case: {type: 'string', multiple: true}}});
const runOf = caseDir => ['test', 'pilot'].find(run => existsSync(path.join(caseDir, run, 'alternatives.jsonl')));
// runs/ may not exist in a fresh clone.
const caseIds = values.case || (existsSync(RUNS_DIR) ? (await readdir(RUNS_DIR, {withFileTypes: true}))
  .filter(entry => entry.isDirectory() && runOf(path.join(RUNS_DIR, entry.name)))
  .map(entry => entry.name) : []);
if (!caseIds.length) console.log(`No completed runs in ${path.relative(process.cwd(), RUNS_DIR) || '.'}. Run a focal paper first (see the README).`);
const corpus = existsSync(path.join(ROOT, 'corpus', 'records.jsonl')) ? Corpus.load(undefined, {vectors: false}) : null;
if (!corpus && caseIds.length) console.warn('Corpus not built: cited published papers will appear without titles. Run npm run build-corpus first.');
for (const caseId of caseIds) {
  const caseDir = caseDirFor(caseId), run = runOf(caseDir);
  if (!run) throw new Error(`No completed test or pilot for ${caseId}.`);
  const bundle = await buildExplorerData({caseId, caseDir, testDir: path.join(caseDir, run), corpus, pilot: run === 'pilot'});
  console.log(`${caseId}${run === 'pilot' ? ' (pilot)' : ''}: ${bundle.alternatives.length} AI alternatives, ${Object.keys(bundle.records).length} cited published papers -> ui/data/${caseId}.json`);
}
