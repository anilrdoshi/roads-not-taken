// The quality-test pipeline for one paper: extract it, generate alternatives with its evidence
// locked, review them against the original, and score every paper for field fit and novelty.
// Each stage appends one JSON line per item, so an interrupted run resumes where it stopped.
import {appendFile, readFile, writeFile, mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {DEFAULT_THEORIES, FIELD_IDS} from './config.js';
import {alternativeSchema, evidenceSchema, framingSchema, reviewSchema, scoreSchema} from './schemas.js';
import {findLeaks, numbersPreserved} from './leaks.js';
import * as P from './prompts.js';
import {BudgetExceeded, runAll} from './llm.js';
import {embeddingText} from './embeddings.js';
import {loadOriginalAbstract} from './original-abstract.js';

export async function readJsonl(file) {
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
}

const appendJsonl = (file, value) => appendFile(file, JSON.stringify(value) + '\n');

// Every paper is scored this many times in separate calls; reports use the mean (src/scores.js).
export const SCORE_REPLICATES = 3;
export const replicateOf = row => row.replicate || 1;
export const scoreKey = row => `${row.id}#${replicateOf(row)}`;
const clamp01 = value => Math.max(0, Math.min(1, Math.round(value * 100) / 100));

// ---------- Extraction ----------

export async function extract({caseDir, versionNote, pdfPaths, llm}) {
  const version = 'paper';
  const documents = [];
  for (const pdfPath of pdfPaths) {
    const bytes = await readFile(pdfPath);
    documents.push({title: path.basename(pdfPath), base64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex')});
  }
  const ask = (role, content, schema, maxTokens = 64000) =>
    llm.call({role, itemId: version, system: role === 'repair-evidence' ? P.EVIDENCE_REPAIR_SYSTEM : P.EXTRACTION_SYSTEM, content, schema, effort: 'high', maxTokens});

  // Pass 1: how the authors frame the study, including the constructs they name.
  const framingCall = await ask('extract-framing', P.extractionContent(documents, P.framingTask(versionNote)), framingSchema);
  const framing = framingCall.value;
  // Pass 2: data and results only, with the framing's constructs banned.
  const evidenceCall = await ask('extract-evidence', P.extractionContent(documents, P.evidenceTask(framing.constructs.map(c => c.term))), evidenceSchema);
  let evidence = evidenceCall.value;
  // Automatic leak check, with at most one repair that may change wording but not numbers.
  const flagsBefore = findLeaks(evidence, framing);
  let repair = null;
  if (flagsBefore.length) {
    const repairCall = await ask('repair-evidence', P.repairContent(evidence, flagsBefore, framing.constructs), evidenceSchema, 32000);
    const accepted = numbersPreserved(evidence, repairCall.value);
    repair = {
      accepted,
      note: accepted ? 'Wording rewritten; every number, id and significance level is unchanged.' : 'Rejected because it changed a number or result field; the unrepaired evidence is kept.',
      evidenceBeforeRepair: evidence,
      costUsd: repairCall.costUsd
    };
    if (accepted) evidence = repairCall.value;
  }
  const flagsAfter = findLeaks(evidence, framing);

  const dir = path.join(caseDir, version);
  await mkdir(dir, {recursive: true});
  const record = {
    version,
    versionNote,
    extractedAt: new Date().toISOString(),
    modelServed: framingCall.modelServed,
    costUsd: framingCall.costUsd + evidenceCall.costUsd + (repair?.costUsd || 0),
    sources: documents.map(doc => ({file: doc.title, sha256: doc.sha256})),
    leakCheck: {flagsBefore, repair, flagsAfter},
    extraction: {...framing, evidence}
  };
  await writeFile(path.join(dir, 'extraction.json'), JSON.stringify(record, null, 2) + '\n');
  await writeFile(path.join(dir, 'extraction.md'), extractionMarkdown(record));
  return record;
}

export async function loadExtraction(caseDir) {
  const file = path.join(caseDir, 'paper', 'extraction.json');
  return existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : null;
}

export function extractionMarkdown(record) {
  const x = record.extraction, e = x.evidence, leaks = record.leakCheck;
  const list = items => items.map(item => `- ${item}`).join('\n') || '- (none)';
  const nameOf = Object.fromEntries(e.variables.map(v => [v.id, v.name]));
  const flagList = flags => flags.map(f => `- "${f.phrase}" (${f.kind}) in \`${f.path}\``).join('\n');
  const leakSummary = !leaks.flagsBefore.length
    ? 'No framing terms, hypothesis labels, theory names or interpretive phrases were found in the evidence.'
    : `${leaks.flagsBefore.length} phrase(s) were flagged in the first draft of the evidence. ${leaks.repair.note}${leaks.flagsAfter.length ? `\n\nStill flagged, please check:\n${flagList(leaks.flagsAfter)}` : ' Nothing remains flagged.'}\n\nFlagged in the first draft:\n${flagList(leaks.flagsBefore)}`;
  return `# Extraction: ${x.identity.title}

${x.identity.authors.join(', ')} · ${x.identity.journal || 'journal not stated'} · ${x.identity.year} · ${record.versionNote}
Extracted ${record.extractedAt.slice(0, 10)} by ${record.modelServed}. Sources: ${record.sources.map(s => s.file).join(', ')}.

Check this before any alternatives are generated. The **Evidence** section is everything the generator sees. It comes from the data, methods and results tables, written in measurement terms. The **Framing** section is withheld from the generator and used only for comparison.

## Evidence (locked; shown to the generator)
**Unit of analysis:** ${e.unitOfAnalysis}

**Sample:** ${e.sample}

**Data sources:**
${list(e.dataSources)}

**Design:** ${e.design}

### Variables
| id | role | variable | measured as |
|---|---|---|---|
${e.variables.map(v => `| ${v.id} | ${v.role} | ${v.name} | ${v.measurement} |`).join('\n')}

### Results
| id | specification | term | outcome | estimate (SE) | significance | N | where |
|---|---|---|---|---|---|---|---|
${e.results.map(r => `| ${r.id} | ${r.specification} | ${r.term} | ${nameOf[r.outcomeId] || r.outcomeId} | ${r.estimate}${r.standardError ? ` (${r.standardError})` : ''} | ${r.significance} | ${r.observations} | ${r.location} |`).join('\n')}
${e.qualitativeFindings.length ? `\n### Qualitative findings\n${e.qualitativeFindings.map(f => `- ${f.id}: ${f.statement} (${f.location})`).join('\n')}\n` : ''}
### Design facts
${list(e.designFacts)}

### Automatic leak check
${leakSummary}

## Framing (withheld from the generator)
**Abstract (paraphrased):** ${x.abstract}

**Phenomenon:** ${x.framing.phenomenon}

**Research question:** ${x.framing.researchQuestion}

**Scholarly conversation:** ${x.framing.conversation}

**Theory:** ${x.framing.theory}

**Mechanism:** ${x.framing.mechanism}

**Hypotheses:**
${list(x.framing.hypotheses)}

**Interpretation:** ${x.framing.interpretation}

**Contribution:** ${x.framing.contribution}

**Audience:** ${x.framing.audience}

### The paper's constructs (banned from the evidence)
${x.constructs.map(c => `- **${c.term}**: ${c.meaning}`).join('\n') || '- (none)'}

## Codes
Primary theory: ${x.codes.primaryTheory} · Theories: ${x.codes.theories.join(', ')} · Topics: ${x.codes.topics.join(', ')} · Methods: ${x.codes.methods.join(', ')}

## Source locations
${x.sources.map(s => `- ${s.id}, p. ${s.page}: ${s.note}`).join('\n')}
`;
}

// ---------- Planning ----------

// One case is one paper: open runs, one run per theory, and several runs aimed at each field.
// Open runs cycle through every combination of request (OPEN_AMBITIONS) and evidence format, so
// 24 runs give three of each, and a run cut short by the spending cap still covers them evenly.
export const OPEN_VARIANTS = Object.keys(P.OPEN_AMBITIONS).flatMap(ambition => P.EVIDENCE_FORMATS.map(format => ({ambition, format})));

export function planTest({openRuns = 24, perField = 4, pilot = false} = {}) {
  const pad = n => String(n).padStart(2, '0');
  const tasks = [];
  const open = pilot ? 2 : openRuns, fieldRuns = pilot ? 1 : perField, theories = pilot ? DEFAULT_THEORIES.slice(0, 2) : DEFAULT_THEORIES;
  for (let n = 1; n <= open; n++) tasks.push({id: `open-${pad(n)}`, target: {mode: 'open', ...OPEN_VARIANTS[(n - 1) % OPEN_VARIANTS.length]}});
  for (const theory of theories) tasks.push({id: `theory-${theory.id}`, target: {mode: 'theory', theoryId: theory.id}});
  for (const fieldId of FIELD_IDS) for (let n = 1; n <= fieldRuns; n++) tasks.push({id: `field-${fieldId}-${n}`, target: {mode: 'field', fieldId}});
  return tasks;
}

// ---------- Stages ----------

async function stage({name, file, items, worker, failuresFile, log, keyOf = item => item.id}) {
  const done = new Set((await readJsonl(file)).map(keyOf));
  const pending = items.filter(item => !done.has(keyOf(item)));
  log(`${name}: ${pending.length} to run (${done.size} already done)`);
  // The Llm refuses new calls once the spending cap is reached, so remaining items fail fast.
  const results = await runAll(pending, async item => {
    const row = await worker(item);
    await appendJsonl(file, row);
    return row;
  });
  for (const {item, error} of results.filter(result => result.error)) {
    await appendJsonl(failuresFile, {stage: name, id: item.id, key: keyOf(item), error: error.message, at: new Date().toISOString()});
  }
  const failed = results.filter(result => result.error).length;
  log(`${name}: ${pending.length - failed} completed, ${failed} failed`);
  return {budgetHit: results.some(result => result.error instanceof BudgetExceeded)};
}

// Every paper in a case is compared with literature published up to the original paper's year.
export const comparisonYear = extraction => Number.parseInt(String(extraction.identity.year || '').match(/\d{4}/)?.[0], 10) || undefined;

// With corpus embeddings and an embedder, scoring retrieves comparison articles by hybrid
// (keyword + embedding) search; otherwise by BM25 alone. Each score row records which.
export async function runTest({caseDir, testDir, llm, corpus, embedder, tasks, scoreReplicates = SCORE_REPLICATES, log = console.log}) {
  const record = await loadExtraction(caseDir);
  if (!record) throw new Error('Extract the focal paper first (npm run extract).');
  const paper = record.extraction;
  const files = name => path.join(testDir, name);
  await mkdir(testDir, {recursive: true});
  if (!existsSync(files('plan.json'))) await writeFile(files('plan.json'), JSON.stringify({createdAt: new Date().toISOString(), model: llm.model, tasks}, null, 2) + '\n');
  const failuresFile = files('failures.jsonl');

  // 1. Generate alternatives with the evidence locked.
  let result = await stage({name: 'generate', file: files('alternatives.jsonl'), failuresFile, log, items: tasks, worker: async task => {
    const {value, costUsd, modelServed, servedByFallback} = await llm.call({
      role: 'generate', itemId: task.id, system: P.GENERATION_SYSTEM,
      content: P.generationContent(paper, task.target),
      schema: alternativeSchema, effort: 'high'
    });
    return {...task, outline: value, modelServed, servedByFallback, costUsd, at: new Date().toISOString()};
  }});
  if (result.budgetHit) return {stoppedAt: 'generate'};
  const alternatives = await readJsonl(files('alternatives.jsonl'));

  // 2. Review each alternative: evidence check, codes, comparison with the original paper.
  const references = [{id: 'original', paper: P.originalAsPaper(paper)}];
  result = await stage({name: 'review', file: files('reviews.jsonl'), failuresFile, log, items: alternatives, worker: async alt => {
    const {value, costUsd, modelServed} = await llm.call({
      role: 'review', itemId: alt.id, system: P.REVIEW_SYSTEM,
      content: P.reviewContent(paper, references, alt.outline),
      schema: reviewSchema, effort: 'high'
    });
    return {id: alt.id, review: value, modelServed, costUsd, at: new Date().toISOString()};
  }});
  if (result.budgetHit) return {stoppedAt: 'review'};

  // 3. Score every paper, the original included, for Fit to each field and Novelty, scoreReplicates
  // times in separate calls; reports use the mean (src/scores.js). Every paper is compared with
  // literature published up to the original paper's year. Scorings run round by round, so a
  // spending cap stops between rounds rather than leaving papers scored once.
  const maxYear = comparisonYear(paper);
  const retrieval = corpus.vectors && embedder ? 'hybrid' : 'bm25';
  if (retrieval === 'hybrid' && embedder.model !== corpus.embedding.model) throw new Error(`The corpus was embedded with ${corpus.embedding.model}, not ${embedder.model}.`);
  if (corpus.vectors && !embedder) log('score: corpus embeddings found but no embedder given; retrieving by BM25 only');
  // Retrieval for the original uses its own abstract when one is saved (npm run original-abstract);
  // Claude is still shown the extraction's paraphrase.
  const ownAbstract = await loadOriginalAbstract(caseDir);
  const papers = [
    {id: 'original', kind: 'original', paper: P.originalAsPaper(paper), retrievalPaper: ownAbstract ? {...P.originalAsPaper(paper), abstract: ownAbstract} : null},
    ...alternatives.map(alt => ({id: alt.id, kind: 'alternative', paper: alt.outline}))
  ];
  const scoreItems = [];
  for (let replicate = 1; replicate <= scoreReplicates; replicate++) for (const item of papers) scoreItems.push({...item, replicate});
  // The comparison articles are the same for every scoring of a paper, so each paper retrieves once.
  const retrievals = new Map();
  const retrieve = item => {
    if (!retrievals.has(item.id)) retrievals.set(item.id, (async () => {
      const forRetrieval = item.retrievalPaper || item.paper;
      const vector = retrieval === 'hybrid' ? (await embedder.embed([embeddingText(forRetrieval)]))[0] : undefined;
      const query = P.scoringQuery(forRetrieval);
      return Object.fromEntries(FIELD_IDS.map(fieldId => [fieldId, corpus.search(query, {field: fieldId, maxYear, limit: 6, vector})]));
    })());
    return retrievals.get(item.id);
  };
  result = await stage({name: 'score', file: files('scores.jsonl'), failuresFile, log, items: scoreItems, keyOf: scoreKey, worker: async item => {
    const retrieved = await retrieve(item);
    const {content, publicContent} = P.scoreContent(item.paper, retrieved);
    const {value, costUsd, modelServed} = await llm.call({role: 'score', itemId: `${item.id}#${item.replicate}`, system: P.scoreSystem(retrieval), content, publicContent, schema: scoreSchema, effort: 'high'});
    const fit = Object.fromEntries(FIELD_IDS.map(fieldId => {
      const entry = value.fit.find(f => f.field === fieldId);
      return [fieldId, entry ? {...entry, score: clamp01(entry.score)} : null];
    }));
    return {
      id: item.id, replicate: item.replicate, kind: item.kind, corpusMaxYear: maxYear || null, retrieval,
      ...(item.kind === 'original' ? {retrievalAbstract: item.retrievalPaper ? 'own' : 'paraphrase'} : {}),
      retrieved: Object.fromEntries(Object.entries(retrieved).map(([fieldId, hits]) => [fieldId, hits.map(hit => hit.record.id)])),
      fit, bestField: value.bestField, novelty: {...value.novelty, score: clamp01(value.novelty.score)},
      modelServed, costUsd, at: new Date().toISOString()
    };
  }});
  return {stoppedAt: result.budgetHit ? 'score' : null};
}
