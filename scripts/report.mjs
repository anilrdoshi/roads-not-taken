// Rebuilds the report from a saved run folder. Makes no model calls.
// Usage: npm run report -- --case <name> [--dir test]
import {parseArgs} from 'node:util';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {caseDirFor} from '../src/config.js';
import {buildReport} from '../src/report.js';

const {values} = parseArgs({options: {case: {type: 'string'}, dir: {type: 'string', default: 'test'}}});
if (!values.case) {
  console.error('Usage: npm run report -- --case <name> [--dir test]');
  process.exit(1);
}
const caseDir = caseDirFor(values.case);
const testDir = path.join(caseDir, values.dir);
if (!existsSync(path.join(caseDir, 'paper', 'extraction.json')) || !existsSync(path.join(testDir, 'alternatives.jsonl'))) {
  console.error(`No saved results in ${path.relative(process.cwd(), testDir)}. Run npm run extract and npm run test-run first.`);
  process.exit(1);
}
const summary = await buildReport({caseDir, testDir});
console.log(`${summary.counts.alternatives} AI alternatives summarized. Report: ${path.relative(process.cwd(), path.join(testDir, 'summary.md'))}`);
