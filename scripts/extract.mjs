// Extracts a paper's framing and evidence from its PDF(s) with Claude. One case is one paper.
// Usage: npm run extract -- --case my-paper --pdf papers/paper.pdf [--pdf papers/appendix.pdf] [--note "working paper"]
// The case goes to runs/<case> (or RUNS_DIR/<case>, if .env sets RUNS_DIR).
import {parseArgs} from 'node:util';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {caseDirFor} from '../src/config.js';
import {Llm} from '../src/llm.js';
import {extract} from '../src/pipeline.js';

const {values} = parseArgs({options: {
  case: {type: 'string'},
  note: {type: 'string', default: 'paper'},
  pdf: {type: 'string', multiple: true},
  budget: {type: 'string', default: '80'}
}});
if (!values.case || !/^[a-z0-9-]+$/i.test(values.case) || !values.pdf?.length) {
  console.error('Usage: npm run extract -- --case <name> --pdf <file.pdf> [--pdf <appendix.pdf>] [--note "description of this version"]');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('No API key found. Create .env containing ANTHROPIC_API_KEY=your-key (see .env.example), or set ANTHROPIC_API_KEY in the environment.');
  process.exit(1);
}
const caseDir = caseDirFor(values.case);
await mkdir(caseDir, {recursive: true});
const llm = await new Llm({budgetFile: path.join(caseDir, 'budget.json'), budgetUsd: Number(values.budget), logDir: path.join(caseDir, 'paper')}).init();
console.log(`Extracting ${values.pdf.join(', ')} ...`);
const record = await extract({caseDir, versionNote: values.note, pdfPaths: values.pdf, llm});
const x = record.extraction;
console.log(`"${x.identity.title}": ${x.evidence.variables.length} variables, ${x.evidence.results.length} results, ${x.constructs.length} framing constructs banned from the evidence.`);
const leaks = record.leakCheck;
console.log(leaks.flagsBefore.length
  ? `Leak check: ${leaks.flagsBefore.length} phrase(s) flagged; repair ${leaks.repair.accepted ? 'accepted' : 'rejected'}; ${leaks.flagsAfter.length} still flagged.`
  : 'Leak check: no framing found in the evidence.');
console.log(`Cost $${record.costUsd.toFixed(2)}; total spent for this case $${llm.spentUsd.toFixed(2)} of $${llm.budgetUsd}.`);
console.log(`Review it in ${path.relative(process.cwd(), path.join(caseDir, 'paper', 'extraction.md'))}`);
