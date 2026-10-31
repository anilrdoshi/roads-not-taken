// Computes the distance measures (embeddings) for a saved run (no model calls, no API key), then
// rebuilds its report and, for a full test, its explorer bundle. Needs the corpus embeddings.
// Usage: npm run distance -- --case <name> [--dir test]
import {parseArgs} from 'node:util';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {caseDirFor} from '../src/config.js';
import {Corpus} from '../src/corpus.js';
import {Embedder} from '../src/embeddings.js';
import {computeDistance} from '../src/distance.js';
import {buildReport} from '../src/report.js';
import {buildExplorerData} from '../src/explorer.js';

const {values} = parseArgs({options: {case: {type: 'string'}, dir: {type: 'string', default: 'test'}}});
if (!values.case) {
  console.error('Usage: npm run distance -- --case <name> [--dir test]');
  process.exit(1);
}
const caseDir = caseDirFor(values.case);
const testDir = path.join(caseDir, values.dir);
if (!existsSync(path.join(testDir, 'alternatives.jsonl'))) {
  console.error(`No saved AI alternatives in ${path.relative(process.cwd(), testDir)}.`);
  process.exit(1);
}
const corpus = Corpus.load();
if (!corpus.vectors) {
  console.error('The corpus embeddings are missing. Run `npm run build-embeddings` first.');
  process.exit(1);
}
const embedder = await new Embedder().init();
const result = await computeDistance({caseDir, testDir, corpus, embedder});
await buildReport({caseDir, testDir});
if (values.dir === 'test') await buildExplorerData({caseId: values.case, caseDir, testDir, corpus});
console.log(`Focal paper and ${Object.keys(result.papers).length - 1} AI alternatives measured. Report: ${path.relative(process.cwd(), path.join(testDir, 'summary.md'))}`);
