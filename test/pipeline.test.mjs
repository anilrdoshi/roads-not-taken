// Offline checks of the whole pipeline with a mock model. No API key or network needed.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {FIELDS, FIELD_IDS} from '../src/config.js';
import {Llm, BudgetExceeded} from '../src/llm.js';
import {Corpus, tokenize} from '../src/corpus.js';
import {cleanAbstract, embeddingText} from '../src/embeddings.js';
import {DISTANCE, computeDistance, percentile, spearman} from '../src/distance.js';
import {averageScores, fitNoise} from '../src/scores.js';
import {abstractFromPdfText, originalAbstractFile} from '../src/original-abstract.js';
import {mkdir} from 'node:fs/promises';
import {extract, planTest, runTest, readJsonl} from '../src/pipeline.js';
import {buildReport} from '../src/report.js';
import {buildExplorerData} from '../src/explorer.js';
import {GENERATION_SYSTEM, generationContent, evidencePacket, targetInstruction, evidenceFitContent, originalAsPaper} from '../src/prompts.js';
import {findLeaks, numbersPreserved} from '../src/leaks.js';

const ORIGINAL_THEORY = 'Followers as external resources: stocks give prominence, flows give referrals (resource-based view).';

function fakeFraming(title, year) {
  return {
    identity: {title, authors: ['A. Author', 'B. Author'], journal: 'Journal of Management Studies', year, versionNote: 'test'},
    abstract: 'We study how social media followers relate to weekly television ratings for new shows.',
    framing: {
      phenomenon: 'Passive social media following as a source of value.',
      researchQuestion: 'How do social media followers create value for product-level operating units?',
      conversation: 'External resources and the resource-based view.',
      theory: ORIGINAL_THEORY,
      mechanism: 'Prominence and referral.',
      hypotheses: ['H1 stock positive', 'H2 flow positive'],
      interpretation: 'Followers act as an external resource.',
      contribution: 'Value from passive affiliations.',
      audience: 'General management'
    },
    constructs: [{term: 'follower stock', meaning: 'total followers'}, {term: 'intensity of interest', meaning: 'how strongly a genre engages viewers'}],
    codes: {primaryTheory: 'rbv', theories: ['rbv'], topics: ['T001'], methods: ['M004']},
    sources: [{id: 'S1', page: '58', note: 'Table 3'}]
  };
}

// The first draft of the evidence deliberately leaks a construct and a hypothesis label.
function fakeEvidence({leaky = true} = {}) {
  return {
    unitOfAnalysis: 'television show-week',
    sample: 'New US network television shows, Fall 2013, 26 shows and 186 show-weeks.',
    dataSources: ['Twitter API: follower counts', 'Nielsen ratings via tvbythenumbers.com'],
    variables: [
      {id: 'V1', name: 'log Nielsen rating', role: 'outcome', measurement: 'log Nielsen rating of the episode aired in week t'},
      {id: 'V2', name: leaky ? 'follower stock' : 'total followers', role: 'predictor', measurement: 'followers of the show account the day before airing'},
      {id: 'V3', name: 'new followers', role: 'predictor', measurement: 'net new followers in the six days before airing'}
    ],
    design: 'Dynamic panel estimated with Arellano-Bond GMM; show fixed effects; standard errors clustered by show.',
    results: [
      {id: 'R1', specification: leaky ? 'H1 model, Table 3 col 4' : 'Main model, Table 3 col 4', term: 'total followers', termIds: ['V2'], outcomeId: 'V1', estimate: '0.107', standardError: '0.05', significance: 'p<0.05', observations: '186', location: 'Table 3, col 4, p. 58'},
      {id: 'R2', specification: 'Main model, Table 3 col 4', term: 'new followers', termIds: ['V3'], outcomeId: 'V1', estimate: '0.055', standardError: '0.02', significance: 'p<0.05', observations: '186', location: 'Table 3, col 4, p. 58'}
    ],
    qualitativeFindings: [],
    designFacts: ['No source of exogenous variation in followers.', 'One platform and one season.']
  };
}

function fakeExtraction(title, year) {
  return {...fakeFraming(title, year), evidence: fakeEvidence({leaky: false})};
}

function makeMock({refuse = new Set(), corruptRepair = false} = {}) {
  let n = 0;
  const calls = [];
  const mock = async ({role, itemId, request}) => {
    calls.push({role, itemId});
    n++;
    const text = request.messages[0].content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    let value;
    if (role === 'extract-framing') value = fakeFraming('External Resources Revisited', '2026');
    else if (role === 'extract-evidence') value = fakeEvidence({leaky: true});
    else if (role === 'repair-evidence') {
      value = fakeEvidence({leaky: false});
      if (corruptRepair) value.results[0].estimate = '0.200';
    }
    else if (role === 'generate') value = {
      title: `Alternative paper ${n}`, abstract: 'An alternative paper.', field: 'marketing', targetJournals: ['Journal of Marketing'],
      researchQuestion: 'When do follower signals predict demand?', conversation: 'Word of mouth', theory: {primary: 'Signaling theory', secondary: []},
      mechanism: 'Followers signal quality.', hypotheses: [{statement: 'H1', resultIds: ['R1'], status: 'reported'}],
      interpretation: 'Signals.', contribution: 'New account.', scope: 'TV shows', changesNeeded: [], extensions: ['Test with a second season.']
    };
    else if (role === 'review') {
      const refs = [...text.matchAll(/REFERENCE VERSION "(\w+)"/g)].map(m => m[1]);
      const components = {question: 'reframed', conversation: 'replaced', theory: 'replaced', mechanism: 'replaced', interpretation: 'reframed', contribution: 'replaced', audience: 'replaced'};
      value = {
        evidence: {verdict: 'consistent', contradictions: [], flags: {untestedMechanism: true, causalOverreach: false, needsReanalysis: false, needsNewData: false}, flagNotes: ''},
        codes: {primaryTheory: 'signaling', theories: ['signaling'], topics: ['T001'], methods: ['M004']},
        comparisons: refs.map(reference => ({reference, components, family: 'different-paper', summary: 'Different theory.'}))
      };
    } else if (role.startsWith('score')) {
      const ids = [...text.matchAll(/\[(doi:[^\]]+)\]/g)].map(m => m[1]);
      // Scorings of the same paper differ: field fit rises by 0.03 a scoring; novelty is 1.4 (clamped to 1), 0.4, 0.7.
      const replicate = Number(String(itemId).split('#')[1] || 1);
      value = {fit: FIELD_IDS.map((field, i) => ({field, score: 0.2 + i * 0.15 + (replicate - 1) * 0.03, reason: 'r', closest: ids.slice(0, 1)})), bestField: 'operations', novelty: {score: [1.4, 0.4, 0.7][(replicate - 1) % 3], reason: 'n', closest: ids.slice(0, 1).map(id => ({id, relation: 'similar'}))}};
    } else if (role === 'evidence-fit') {
      // Evidence fit: the original 0.6 on average; alternatives 0.3, 0.6 or 0.65 by their number;
      // scorings of the same paper differ by 0.02 either side.
      const replicate = Number(String(itemId).split('#')[1] || 1);
      const number = Number(text.match(/TITLE: Alternative paper (\d+)/)?.[1]);
      const base = text.includes('TITLE: External Resources Revisited') ? 0.6 : [0.3, 0.6, 0.65][number % 3];
      value = {centralResults: [{resultIds: ['R1'], result: 'Total followers predict ratings.', relation: 'consistent', rivalPredictsEqually: true, note: 'n'}],
        rivals: ['Popularity'], fittedHypotheses: [], unmeasured: ['The mechanism'], score: base + [-0.02, 0, 0.02][(replicate - 1) % 3], reason: 'e'};
    } else if (role === 'version-diff') value = {components: {question: 'refined', conversation: 'reframed', theory: 'refined', mechanism: 'unchanged', interpretation: 'refined', contribution: 'reframed', audience: 'reframed'}, evidenceChanges: 'More robustness checks.', framingChanges: 'Reframed toward general management.', summary: 'Repositioned.'};
    if (refuse.has(itemId)) return {id: `mock-${n}`, model: 'claude-opus-5-5', stop_reason: 'refusal', stop_details: {category: null}, usage: {input_tokens: 10, output_tokens: 0}, content: []};
    return {
      id: `mock-${n}`, model: 'claude-opus-5-5', stop_reason: 'end_turn',
      usage: {input_tokens: 2000, output_tokens: 800, cache_read_input_tokens: 0, cache_creation_input_tokens: 0},
      content: [{type: 'thinking', thinking: 'summary of reasoning'}, {type: 'text', text: JSON.stringify(value)}]
    };
  };
  return {mock, calls};
}

function fakeCorpus() {
  const records = [];
  for (const field of FIELD_IDS) for (let i = 0; i < 8; i++) {
    records.push({id: `doi:10.1/${field}.${i}`, title: `Followers ratings television ${field} ${i}`, abstract: `SECRET-ABSTRACT-TEXT-${field}-${i} social media followers demand for ${field} products, with evidence from ${8 - i} markets observed over several years.`, year: 2016 + i, journal: `${field} journal`, journalId: field, field});
  }
  return new Corpus(records);
}

// Deterministic stand-in for the embedding model: a hashed bag of words, scaled to unit length.
function fakeEmbedder(dims = 64) {
  return {model: 'fake-embedder', dims, embed: async texts => texts.map(text => {
    const v = new Float32Array(dims);
    for (const token of tokenize(text)) v[createHash('md5').update(token).digest()[0] % dims] += 1;
    const norm = Math.hypot(...v) || 1;
    return v.map(x => x / norm);
  })};
}

async function embeddedCorpus(embedder) {
  const corpus = fakeCorpus();
  const vectors = await embedder.embed(corpus.records.map(embeddingText));
  const matrix = new Float32Array(vectors.length * embedder.dims);
  vectors.forEach((v, i) => matrix.set(v, i * embedder.dims));
  return corpus.attachVectors({meta: {model: embedder.model, dtype: 'fp32'}, dims: embedder.dims, matrix});
}

async function setup(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'branching-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const pdf = path.join(dir, 'paper.pdf');
  await writeFile(pdf, Buffer.from('%PDF-1.4 FAKE-PDF-BYTES-FOR-TEST'));
  return {dir, pdf, caseDir: path.join(dir, 'case'), testDir: path.join(dir, 'case', 'test')};
}

async function extractPaper({caseDir, pdf, mock}) {
  const llm = await new Llm({mock, budgetFile: path.join(caseDir, 'budget.json'), budgetUsd: 80, logDir: path.join(caseDir, 'paper')}).init();
  return extract({caseDir, versionNote: 'working paper', pdfPaths: [pdf], llm});
}

test('full pilot run produces alternatives, reviews, scores and a report', async t => {
  const {caseDir, testDir, pdf} = await setup(t);
  const {mock} = makeMock();
  await extractPaper({caseDir, pdf, mock});
  assert.ok(existsSync(path.join(caseDir, 'paper', 'extraction.md')));
  const tasks = planTest({pilot: true});
  const llm = await new Llm({mock, budgetFile: path.join(caseDir, 'budget.json'), budgetUsd: 80, logDir: testDir}).init();
  const result = await runTest({caseDir, testDir, llm, corpus: fakeCorpus(), tasks, log: () => {}});
  assert.equal(result.stoppedAt, null);
  assert.equal((await readJsonl(path.join(testDir, 'alternatives.jsonl'))).length, tasks.length);
  assert.equal((await readJsonl(path.join(testDir, 'reviews.jsonl'))).length, tasks.length);
  const scores = await readJsonl(path.join(testDir, 'scores.jsonl'));
  assert.equal(scores.length, 3 * (tasks.length + 1), 'every alternative plus the original is scored three times');
  const evidenceFits = await readJsonl(path.join(testDir, 'evidence-fit.jsonl'));
  assert.equal(evidenceFits.length, 3 * (tasks.length + 1), 'and judged three times for evidence fit');
  assert.ok(evidenceFits.every(row => row.score >= 0 && row.score <= 1 && row.centralResults.length), 'with the judge\'s classification kept');
  assert.ok(['original', ...tasks.map(task => task.id)].every(id => [1, 2, 3].every(r => scores.some(s => s.id === id && s.replicate === r))));
  assert.ok(scores.every(s => s.novelty.score <= 1 && FIELD_IDS.every(f => s.fit[f].score >= 0 && s.fit[f].score <= 1)), 'scores are clamped to 0-1');
  const originalScore = scores.find(s => s.id === 'original');
  assert.equal(originalScore.corpusMaxYear, 2026, 'papers are compared with literature up to the original paper\'s year');
  const review = (await readJsonl(path.join(testDir, 'reviews.jsonl'))).find(r => r.id === 'open-01');
  assert.deepEqual(review.review.comparisons.map(c => c.reference), ['original']);

  const summary = await buildReport({caseDir, testDir});
  assert.equal(summary.counts.alternatives, tasks.length);
  assert.equal(summary.convergence['different-paper'], 2);
  assert.equal(summary.original.novelty, 0.7, 'Novelty is the mean of the three scorings (1, 0.4, 0.7)');
  assert.equal(summary.original.fieldFit.strategy, 0.23, 'Field fit is the mean of the three scorings (0.20, 0.23, 0.26)');
  assert.equal(summary.original.evidenceFit, 0.6, 'Evidence fit is the mean of the three scorings (0.58, 0.60, 0.62)');
  assert.equal(summary.original.fit.strategy, Math.round(Math.sqrt(0.23 * 0.6) * 1000) / 1000, 'Overall fit is the geometric mean of the two');
  assert.equal(summary.stability.method, 'replicates');
  assert.equal(summary.stability.items, tasks.length + 1);
  assert.equal(summary.stability.pairs, 3 * (tasks.length + 1));
  assert.ok(Math.abs(summary.stability.meanAbsNoveltyDifference - 0.4) < 1e-9, 'pairs differ by 0.6, 0.3 and 0.3 in novelty');
  const markdown = await readFile(path.join(testDir, 'summary.md'), 'utf8');
  assert.ok(markdown.includes('Does it come back to the focal paper?'));
  assert.ok(markdown.includes('each the mean of 3 scorings'));
  const bundle = await buildExplorerData({caseId: 'demo', caseDir, testDir, corpus: fakeCorpus(), outDir: path.join(path.dirname(testDir), 'ui-data')});
  const altScore = bundle.alternatives[0].score;
  assert.deepEqual(altScore.novelty.scores, [1, 0.4, 0.7], 'the dashboard gets each scoring');
  assert.equal(altScore.novelty.variance, 0.09, 'and their sample variance');
  assert.equal(altScore.fit.strategy.scores.length, 3);
  assert.equal(altScore.fieldFit.strategy.scores.length, 3);
  assert.deepEqual(altScore.evidenceFit.scores.length, 3);
  assert.ok(altScore.evidenceFit.centralResults.length && altScore.fieldFit.strategy.reason, 'the judges\' reasons travel with the bundle');
  assert.equal(altScore.scorings, 3);
  assert.deepEqual(summary.openByVariant.filter(g => g.runs).map(g => [g.level, g.runs]), [['best', 2], ['sections', 1], ['list', 1]], 'open runs are broken down by request and by evidence format');
  assert.ok(markdown.includes('Open runs by request and by evidence format'));
});

test('generator input is blinded to the original framing', () => {
  const extraction = fakeExtraction('External Resources Revisited', '2026');
  const text = generationContent(extraction, {mode: 'open'}).map(b => b.text).join('\n');
  assert.ok(text.includes('total followers -> log Nielsen rating: estimate 0.107 (SE 0.05), p<0.05'));
  for (const hidden of ['External Resources Revisited', ORIGINAL_THEORY, extraction.framing.researchQuestion, extraction.framing.contribution, 'follower stock', 'intensity of interest']) {
    assert.ok(!text.includes(hidden), `generator input must not contain: ${hidden}`);
  }
  assert.ok(!evidencePacket(extraction).includes('A. Author'));
});

test('open runs cover every request and evidence format evenly and name no field', () => {
  const open = planTest().filter(task => task.target.mode === 'open');
  const cell = task => `${task.target.ambition}/${task.target.format}`;
  assert.equal(open.length, 24);
  const cells = open.reduce((acc, task) => ({...acc, [cell(task)]: (acc[cell(task)] || 0) + 1}), {});
  assert.equal(Object.keys(cells).length, 8);
  assert.ok(Object.values(cells).every(n => n === 3), 'three runs of each combination');
  assert.equal(new Set(open.slice(0, 8).map(cell)).size, 8, 'the first eight runs cover every combination, so a run cut short stays balanced');
  for (const task of open.slice(0, 8)) {
    const prompt = `${GENERATION_SYSTEM}\n${targetInstruction(task.target)}`.toLowerCase();
    for (const field of FIELDS) assert.ok(!prompt.includes(field.label.toLowerCase()), `an open run's prompt must not name ${field.label}`);
  }
});

test('the list format carries the same evidence, in the same order, as the headed sections', () => {
  const extraction = fakeExtraction('External Resources Revisited', '2026');
  const {evidence} = extraction;
  const values = [evidence.unitOfAnalysis, evidence.sample, ...evidence.dataSources,
    ...evidence.variables.flatMap(v => [v.id, v.name, v.measurement]), evidence.design,
    ...evidence.results.flatMap(r => [r.id, r.specification, r.term, r.estimate, r.standardError, r.significance, r.observations, r.location].filter(Boolean)),
    ...evidence.qualitativeFindings.flatMap(f => [f.id, f.statement, f.location]), ...evidence.designFacts].map(String);
  for (const format of ['sections', 'list']) {
    const text = evidencePacket(extraction, format);
    let from = 0;
    for (const value of values) {
      const at = text.indexOf(value, from);
      assert.ok(at >= 0, `the ${format} format carries "${value}" in order`);
      from = at;
    }
  }
  const list = evidencePacket(extraction, 'list');
  assert.ok(list.split('\n').every(line => line.startsWith('- ')), 'the list format is one flat list');
  assert.ok(!list.includes(' -> '), 'results are written out, not in arrow shorthand');
  assert.ok(generationContent(extraction, {mode: 'open', ambition: 'good', format: 'list'})[0].text.includes(list));
  assert.ok(generationContent(extraction, {mode: 'open', ambition: 'good', format: 'list'})[1].text.includes('Write a good paper from this evidence.'));
});

test('logs never contain PDF bytes, and only the private log contains corpus abstracts', async t => {
  const {caseDir, testDir, pdf} = await setup(t);
  const {mock} = makeMock();
  await extractPaper({caseDir, pdf, mock});
  const llm = await new Llm({mock, budgetFile: path.join(caseDir, 'budget.json'), budgetUsd: 80, logDir: testDir}).init();
  await runTest({caseDir, testDir, llm, corpus: fakeCorpus(), tasks: planTest({pilot: true}), scoreReplicates: 1, log: () => {}});
  const pdfBase64 = Buffer.from('%PDF-1.4 FAKE-PDF-BYTES-FOR-TEST').toString('base64');
  for (const file of [path.join(caseDir, 'paper', 'calls.jsonl'), path.join(caseDir, 'paper', 'private', 'calls.jsonl')]) {
    assert.ok(!(await readFile(file, 'utf8')).includes(pdfBase64), `${file} must not contain PDF bytes`);
  }
  assert.ok(!(await readFile(path.join(testDir, 'calls.jsonl'), 'utf8')).includes('SECRET-ABSTRACT-TEXT'));
  assert.ok((await readFile(path.join(testDir, 'private', 'calls.jsonl'), 'utf8')).includes('SECRET-ABSTRACT-TEXT'));
});

test('a rerun resumes without repeating completed calls', async t => {
  const {caseDir, testDir, pdf} = await setup(t);
  const {mock, calls} = makeMock();
  await extractPaper({caseDir, pdf, mock});
  const tasks = planTest({pilot: true});
  const make = () => new Llm({mock, budgetFile: path.join(caseDir, 'budget.json'), budgetUsd: 80, logDir: testDir}).init();
  await runTest({caseDir, testDir, llm: await make(), corpus: fakeCorpus(), tasks, log: () => {}});
  const before = calls.length;
  await runTest({caseDir, testDir, llm: await make(), corpus: fakeCorpus(), tasks, log: () => {}});
  assert.equal(calls.length, before);
});

test('the spending cap stops the run and is shared across runs', async t => {
  const {caseDir, testDir, pdf} = await setup(t);
  const {mock} = makeMock();
  await extractPaper({caseDir, pdf, mock});
  const spent = JSON.parse(await readFile(path.join(caseDir, 'budget.json'), 'utf8')).spentUsd;
  assert.ok(spent > 0, 'extraction spend is recorded');
  const llm = await new Llm({mock, budgetFile: path.join(caseDir, 'budget.json'), budgetUsd: spent + 0.5, logDir: testDir, concurrency: 1}).init();
  const result = await runTest({caseDir, testDir, llm, corpus: fakeCorpus(), tasks: planTest({pilot: true}), log: () => {}});
  assert.equal(result.stoppedAt, 'generate');
  const failures = await readJsonl(path.join(testDir, 'failures.jsonl'));
  assert.ok(failures.length > 0 && failures.every(f => /Spending cap/.test(f.error)));
  await assert.rejects(llm.call({role: 'generate', itemId: 'x', system: 's', content: [{type: 'text', text: 't'}], schema: {type: 'object', properties: {}, required: [], additionalProperties: false}}), BudgetExceeded);
});

test('a refusal is recorded as a failure, not as an alternative', async t => {
  const {caseDir, testDir, pdf} = await setup(t);
  const {mock} = makeMock({refuse: new Set(['open-01'])});
  await extractPaper({caseDir, pdf, mock});
  const llm = await new Llm({mock, budgetFile: path.join(caseDir, 'budget.json'), budgetUsd: 80, logDir: testDir}).init();
  await runTest({caseDir, testDir, llm, corpus: fakeCorpus(), tasks: planTest({pilot: true}), scoreReplicates: 1, log: () => {}});
  const alternatives = await readJsonl(path.join(testDir, 'alternatives.jsonl'));
  assert.ok(!alternatives.some(a => a.id === 'open-01'));
  const failures = await readJsonl(path.join(testDir, 'failures.jsonl'));
  assert.ok(failures.some(f => f.id === 'open-01' && /Refused/.test(f.error)));
});

test('extraction flags leaked framing and repairs only the wording', async t => {
  const {caseDir, pdf} = await setup(t);
  const {mock, calls} = makeMock();
  const record = await extractPaper({caseDir, pdf, mock});
  assert.deepEqual(calls.map(c => c.role), ['extract-framing', 'extract-evidence', 'repair-evidence']);
  const kinds = record.leakCheck.flagsBefore.map(f => `${f.kind}:${f.phrase}`);
  assert.ok(kinds.includes('construct:follower stock'));
  assert.ok(kinds.includes('hypothesis label:H1'));
  assert.equal(record.leakCheck.repair.accepted, true);
  assert.deepEqual(record.leakCheck.flagsAfter, []);
  assert.equal(record.extraction.evidence.variables[1].name, 'total followers');
  assert.equal(record.leakCheck.repair.evidenceBeforeRepair.variables[1].name, 'follower stock', 'the unrepaired draft is kept for audit');
  assert.ok((await readFile(path.join(caseDir, 'paper', 'extraction.md'), 'utf8')).includes('Automatic leak check'));
});

test('a repair that changes a number is rejected and the flags stay visible', async t => {
  const {caseDir, pdf} = await setup(t);
  const {mock} = makeMock({corruptRepair: true});
  const record = await extractPaper({caseDir, pdf, mock});
  assert.equal(record.leakCheck.repair.accepted, false);
  assert.equal(record.extraction.evidence.results[0].estimate, '0.107');
  assert.ok(record.leakCheck.flagsAfter.length > 0);
});

test('the leak check catches theory names but not ordinary data words', () => {
  const framing = {constructs: []};
  const evidence = fakeEvidence({leaky: false});
  evidence.design = 'Shows aired on six TV networks; consistent with the resource-based view.';
  const flags = findLeaks(evidence, framing);
  assert.deepEqual(flags.map(f => f.phrase.toLowerCase()), ['resource-based view', 'resource-based']);
  assert.ok(numbersPreserved(fakeEvidence({leaky: true}), fakeEvidence({leaky: false})), 'removing a hypothesis label is not a number change');
});

test('the explorer bundle is complete and carries no corpus abstracts', async t => {
  const {dir, caseDir, testDir, pdf} = await setup(t);
  const {mock} = makeMock();
  await extractPaper({caseDir, pdf, mock});
  const llm = await new Llm({mock, budgetFile: path.join(caseDir, 'budget.json'), budgetUsd: 80, logDir: testDir}).init();
  const corpus = fakeCorpus();
  await runTest({caseDir, testDir, llm, corpus, tasks: planTest({pilot: true}), scoreReplicates: 1, log: () => {}});
  const outDir = path.join(dir, 'ui-data');
  const bundle = await buildExplorerData({caseId: 'demo', caseDir, testDir, corpus, outDir});
  assert.equal(bundle.alternatives.length, planTest({pilot: true}).length);
  assert.ok(bundle.alternatives.every(a => a.score && a.review && a.partsReplaced !== null && a.burden));
  assert.ok(Object.keys(bundle.records).length > 0 && Object.values(bundle.records).every(r => r.title && !('abstract' in r)));
  const written = await readFile(path.join(outDir, 'demo.json'), 'utf8');
  assert.ok(!written.includes('SECRET-ABSTRACT-TEXT'), 'no corpus abstract is written to the shareable bundle');
  const index = JSON.parse(await readFile(path.join(outDir, 'cases.json'), 'utf8'));
  assert.deepEqual(index.cases.map(c => c.id), ['demo']);
});

test('with corpus embeddings, scoring uses hybrid retrieval and the report gains the embedding measures', async t => {
  const {caseDir, testDir, pdf} = await setup(t);
  const {mock} = makeMock();
  await extractPaper({caseDir, pdf, mock});
  const embedder = fakeEmbedder(), corpus = await embeddedCorpus(embedder);
  const llm = await new Llm({mock, budgetFile: path.join(caseDir, 'budget.json'), budgetUsd: 80, logDir: testDir}).init();
  await runTest({caseDir, testDir, llm, corpus, embedder, tasks: planTest({pilot: true}), scoreReplicates: 1, log: () => {}});
  const scores = await readJsonl(path.join(testDir, 'scores.jsonl'));
  assert.ok(scores.every(score => score.retrieval === 'hybrid'), 'each score row records its retrieval method');
  const scoreCalls = (await readJsonl(path.join(testDir, 'calls.jsonl'))).filter(call => call.role === 'score');
  assert.ok(scoreCalls.every(call => call.system.includes('similarity of meaning')), 'the scorer is told how articles were retrieved');

  const query = 'followers demand marketing products';
  const hits = corpus.search(query, {field: 'marketing', maxYear: 2020, limit: 3, vector: (await embedder.embed([query]))[0]});
  assert.equal(hits.length, 3);
  assert.ok(hits.every(hit => hit.record.field === 'marketing' && hit.record.year <= 2020));
  assert.ok(hits.every(hit => hit.keywordRank != null || hit.embeddingRank != null));

  let summary = await buildReport({caseDir, testDir});
  assert.equal(summary.distance, null);
  assert.ok((await readFile(path.join(testDir, 'summary.md'), 'utf8')).includes('Not computed for this run'));

  const settings = {...DISTANCE, neighbours: 3, fieldNeighbours: 5, referenceSample: 5};
  const result = await computeDistance({caseDir, testDir, corpus, embedder, settings, log: () => {}});
  assert.equal(result.papers.original.fromOriginal, 0);
  for (const measures of Object.values(result.papers)) {
    assert.ok([...FIELD_IDS, 'all'].every(group => measures.toPublishedPercentile[group] >= 0 && measures.toPublishedPercentile[group] <= 100));
    assert.ok(Math.abs(Object.values(measures.neighbourFields).reduce((a, b) => a + b, 0) - 1) < 1e-3, 'neighbour field shares sum to 1');
    assert.ok(measures.fromOriginal >= 0 && measures.fromOriginal <= 2);
    assert.ok(FIELD_IDS.includes(measures.topNeighbourField));
  }
  summary = await buildReport({caseDir, testDir});
  assert.equal(summary.distance.measuredAlternatives, summary.counts.alternatives);
  assert.ok(summary.rows.every(row => row.distanceFromOriginal > 0));
  assert.equal(summary.distance.relation.bestFieldAndTopNeighbourField.n, summary.counts.alternatives + 1);
  const markdown = await readFile(path.join(testDir, 'summary.md'), 'utf8');
  for (const heading of ['## Distance (embeddings; no model judgement)', '### Distance from the focal paper', '### Distance from the published corpus', '### Fields of the 5 nearest published papers', '### How distance relates to Claude\'s novelty and field fit']) {
    assert.ok(markdown.includes(heading), heading);
  }
  const distanceSection = markdown.slice(markdown.indexOf('## Distance'), markdown.indexOf('## Ten AI alternatives'));
  assert.ok(!/embedding novelty|novelty percentile|field mix/i.test(distanceSection), 'Distance is never called novelty or fit');
  assert.ok(!markdown.includes('SECRET-ABSTRACT-TEXT'));
});

test('publisher boilerplate is removed before embedding', () => {
  assert.equal(cleanAbstract('Abstract Research Summary : We study X. Managerial Summary : X matters.'), 'We study X. X matters.');
  assert.equal(cleanAbstract('We study Y. (PsycINFO Database Record (c) 2018 APA, all rights reserved).'), 'We study Y.');
  assert.equal(cleanAbstract('Problem definition: We study Z. Methodology/results: It works. This paper was accepted by A. Editor, operations. Funding: Grant 1. Supplemental Material: https://doi.org/x .'), 'We study Z. It works.');
  assert.equal(cleanAbstract('Results from a survey show W. Copyright © 2016 John Wiley & Sons, Ltd.'), 'Results from a survey show W.');
});

test('percentiles and rank correlations', () => {
  assert.equal(percentile([1, 2, 3, 4], 2.5), 50);
  assert.equal(percentile([1, 2, 3, 4], 2), 37.5);
  assert.equal(percentile([1, 2, 3], 0), 0);
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  assert.equal(spearman([1, 2], [1, 2]), null);
});

test('the original\'s own abstract is used for embedding and retrieval but never leaves the private folder', async t => {
  const {dir, caseDir, testDir, pdf} = await setup(t);
  const {mock} = makeMock();
  await extractPaper({caseDir, pdf, mock});
  const own = 'OWN-ABSTRACT-TEXT We argue that followers of television shows on social media raise weekly ratings for new shows.';
  await mkdir(path.dirname(originalAbstractFile(caseDir)), {recursive: true});
  await writeFile(originalAbstractFile(caseDir), own + '\n');
  const embedder = fakeEmbedder(), corpus = await embeddedCorpus(embedder);
  const llm = await new Llm({mock, budgetFile: path.join(caseDir, 'budget.json'), budgetUsd: 80, logDir: testDir}).init();
  await runTest({caseDir, testDir, llm, corpus, embedder, tasks: planTest({pilot: true}), scoreReplicates: 1, log: () => {}});
  const original = (await readJsonl(path.join(testDir, 'scores.jsonl'))).find(row => row.id === 'original');
  assert.equal(original.retrievalAbstract, 'own');
  const settings = {...DISTANCE, neighbours: 3, fieldNeighbours: 5, referenceSample: 5};
  const result = await computeDistance({caseDir, testDir, corpus, embedder, settings, log: () => {}});
  assert.equal(result.originalAbstract, 'own');
  await buildReport({caseDir, testDir});
  await buildExplorerData({caseId: 'demo', caseDir, testDir, corpus, outDir: path.join(dir, 'ui-data')});
  assert.ok((await readFile(path.join(testDir, 'summary.md'), 'utf8')).includes('represented by its own abstract'));
  for (const file of [path.join(testDir, 'distance.json'), path.join(testDir, 'summary.md'), path.join(testDir, 'summary.json'), path.join(testDir, 'calls.jsonl'), path.join(testDir, 'private', 'calls.jsonl'), path.join(dir, 'ui-data', 'demo.json')]) {
    assert.ok(!(await readFile(file, 'utf8')).includes('OWN-ABSTRACT-TEXT'), `the original's own abstract must not appear in ${path.basename(file)}`);
  }
});

test('the abstract is found in PDF text and its ligatures and line-end hyphens are repaired', () => {
  const text = 'A Title\nAuthors\nAbstract\nWe study the e\u21b5ect of fol-\nlowers on tele-\nvision ratings.\nKeywords: social media\n1 Introduction\n';
  assert.equal(abstractFromPdfText(text), 'We study the effect of followers on television ratings.');
  assert.equal(abstractFromPdfText('Abstract: Short one.\nShort title: X'), 'Short one.');
  assert.equal(abstractFromPdfText('Abstracts of the meeting\nnothing here'), null);
});

test('a run from before replicates reports exactly as before: one scoring each, stability from the repeat sample', async t => {
  const {caseDir, testDir, pdf} = await setup(t);
  const {mock} = makeMock();
  await extractPaper({caseDir, pdf, mock});
  const llm = await new Llm({mock, budgetFile: path.join(caseDir, 'budget.json'), budgetUsd: 80, logDir: testDir}).init();
  await runTest({caseDir, testDir, llm, corpus: fakeCorpus(), tasks: planTest({pilot: true}), scoreReplicates: 1, log: () => {}});
  // Rewrite the outputs the way older runs stored them: no replicate field, plus a repeat sample.
  const rows = (await readJsonl(path.join(testDir, 'scores.jsonl'))).map(({replicate, ...row}) => row);
  await writeFile(path.join(testDir, 'scores.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const repeat = {...rows[0], novelty: {...rows[0].novelty, score: rows[0].novelty.score - 0.2}};
  await writeFile(path.join(testDir, 'scores-repeat.jsonl'), JSON.stringify(repeat) + '\n');
  const summary = await buildReport({caseDir, testDir});
  assert.equal(summary.original.novelty, rows.find(row => row.id === 'original').novelty.score, 'a single scoring is reported as is');
  assert.equal(summary.stability.method, 'repeat-sample');
  assert.equal(summary.stability.items, 1);
  assert.ok(Math.abs(summary.stability.meanAbsNoveltyDifference - 0.2) < 1e-9);
  assert.ok((await readFile(path.join(testDir, 'summary.md'), 'utf8')).includes('from one scoring of the focal paper and of each AI alternative'));
});

test('averaged scores take the best field from mean field fit, breaking ties by how often it was named', () => {
  const row = (replicate, fits, bestField, novelty) => ({id: 'p', kind: 'alternative', replicate, bestField, novelty: {score: novelty, reason: 'n', closest: []},
    fit: Object.fromEntries(FIELD_IDS.map((field, i) => [field, {score: fits[i], reason: `r${replicate}`, closest: []}]))});
  const tie = averageScores([
    row(1, [0.8, 0.1, 0.1, 0.7, 0.1], 'strategy', 0.5),
    row(2, [0.7, 0.1, 0.1, 0.8, 0.1], 'marketing', 0.6),
    row(3, [0.6, 0.1, 0.1, 0.6, 0.1], 'marketing', 0.7)
  ]);
  assert.equal(tie.fieldFit.strategy.score, tie.fieldFit.marketing.score);
  assert.equal(tie.bestField, 'marketing', 'a tie in mean field fit goes to the field named most often');
  assert.equal(tie.novelty.score, 0.6);
  assert.deepEqual(tie.bestFieldVotes, {strategy: 1, marketing: 2});
  assert.equal(tie.fieldFit.strategy.reason, 'r1', 'reasons shown with the mean come from the first scoring');
  assert.equal(tie.fit.strategy, null, 'without evidence fit there is no overall fit');
  const single = averageScores([row(1, [0.5, 0.9, 0.1, 0.1, 0.1], 'strategy', 0.4)]);
  assert.equal(single.bestField, 'strategy', 'a paper scored once keeps the field Claude named');
});

test('the evidence-fit judge sees the evidence and the hypotheses, not result links, statuses or which paper is the focal one', () => {
  const extraction = fakeExtraction('External Resources Revisited', '2026');
  const original = evidenceFitContent(extraction, originalAsPaper(extraction)).map(b => b.text).join('\n');
  assert.ok(original.includes('total followers -> log Nielsen rating: estimate 0.107 (SE 0.05), p<0.05'), 'the reported results');
  assert.ok(original.includes('- H1 stock positive'), 'the focal paper\'s hypotheses');
  const alternative = {title: 'Alt', abstract: 'a', researchQuestion: 'q', conversation: 'c', theory: {primary: 'Signaling theory', secondary: []}, mechanism: 'm',
    hypotheses: [{statement: 'Followers signal quality.', resultIds: ['R1', 'R2'], status: 'needs-new-data'}], interpretation: 'i', contribution: 'k'};
  const text = evidenceFitContent(extraction, alternative).map(b => b.text).join('\n');
  assert.ok(text.includes('- Followers signal quality.'));
  assert.ok(!text.includes('needs-new-data') && !text.includes('[rests on') && !text.includes('R1, R2'), 'the generator\'s own labels are left out');
  for (const word of [/focal/i, /original/i, /reference version/i]) assert.ok(!word.test(text), `nothing says which paper is the focal one (${word})`);
});

test('Overall fit is the geometric mean of field fit and evidence fit', () => {
  const row = (replicate, fit) => ({id: 'p', kind: 'alternative', replicate, bestField: 'strategy', novelty: {score: 0.5, reason: 'n', closest: []},
    fit: Object.fromEntries(FIELD_IDS.map((field, i) => [field, {score: i ? 0.2 : fit, reason: 'r', closest: []}]))});
  const evidence = (replicate, score) => ({id: 'p', replicate, score, reason: 'e', centralResults: [], rivals: [], fittedHypotheses: [], unmeasured: []});
  const paper = averageScores([row(1, 0.9), row(2, 0.9), row(3, 0.9)], [evidence(1, 0.3), evidence(2, 0.4), evidence(3, 0.5)]);
  assert.equal(paper.fieldFit.strategy.score, 0.9);
  assert.equal(paper.evidenceFit.score, 0.4);
  assert.equal(paper.fit.strategy.score, 0.6, '√(0.9 × 0.4)');
  assert.deepEqual(paper.fit.strategy.scores, [0.52, 0.6, 0.671], 'each scoring of overall fit pairs the nth scoring of each part');
  assert.equal(paper.bestField, 'strategy', 'the best field comes from field fit, which is also where overall fit is highest');
});

test('scoring noise in overall fit is two standard errors of the difference between two papers\' means', () => {
  const paper = (id, scores) => ({id, bestField: 'strategy', fit: {strategy: {scores, variance: scores.reduce((a, v) => a + (v - scores.reduce((s, x) => s + x, 0) / scores.length) ** 2, 0) / (scores.length - 1)}}});
  const noise = fitNoise(new Map([['a', paper('a', [0.5, 0.52, 0.54])], ['b', paper('b', [0.6, 0.6, 0.6])]]));
  // Pooled variance (0.0004 + 0) / 2 = 0.0002, so SD 0.01414; margin 2 × √2 × 0.01414 / √3.
  assert.equal(noise.margin, Math.round(2 * Math.sqrt(2) * Math.sqrt(0.0002) / Math.sqrt(3) * 1000) / 1000);
  assert.equal(noise.papers, 2);
  assert.equal(fitNoise(new Map([['a', paper('a', [0.5])]])), null, 'no noise estimate from single scorings');
});

test('Distinct AI alternatives: a different paper with overall fit at least the focal paper\'s less scoring noise', async t => {
  const {caseDir, testDir, pdf} = await setup(t);
  const {mock} = makeMock();
  await extractPaper({caseDir, pdf, mock});
  const llm = await new Llm({mock, budgetFile: path.join(caseDir, 'budget.json'), budgetUsd: 80, logDir: testDir}).init();
  await runTest({caseDir, testDir, llm, corpus: fakeCorpus(), tasks: planTest({pilot: true}), log: () => {}});
  const summary = await buildReport({caseDir, testDir});
  const d = summary.distinctPapers;
  assert.ok(d.available && d.margin > 0);
  assert.equal(d.originalFit, summary.original.fit[summary.original.bestField]);
  assert.ok(Math.abs(d.bar - (d.originalFit - d.margin)) < 1e-9);
  const expected = summary.rows.filter(row => row.familyVsOriginal === 'different-paper' && row.verdict === 'consistent' && row.bestFit >= d.bar - 1e-9).map(row => row.id);
  assert.deepEqual(d.ids, expected);
  assert.ok(d.count > 0 && d.count < summary.rows.length, 'the mock\'s evidence fits put some AI alternatives below the bar and some above');
  assert.ok((await readFile(path.join(testDir, 'summary.md'), 'utf8')).includes('less scoring noise'));
});

test('a run scored before evidence fit existed reports without overall fit, and a rerun adds only the evidence-fit calls', async t => {
  const {caseDir, testDir, pdf} = await setup(t);
  const {mock, calls} = makeMock();
  await extractPaper({caseDir, pdf, mock});
  const tasks = planTest({pilot: true});
  const make = () => new Llm({mock, budgetFile: path.join(caseDir, 'budget.json'), budgetUsd: 80, logDir: testDir}).init();
  await runTest({caseDir, testDir, llm: await make(), corpus: fakeCorpus(), tasks, log: () => {}});
  await rm(path.join(testDir, 'evidence-fit.jsonl'));
  const before = await buildReport({caseDir, testDir});
  assert.equal(before.original.fit.strategy, null, 'no overall fit without evidence fit');
  assert.equal(before.original.fieldFit.strategy, 0.23, 'Field fit is still reported');
  assert.equal(before.distinctPapers.available, false);
  assert.ok((await readFile(path.join(testDir, 'summary.md'), 'utf8')).includes('Evidence fit has not been scored for this run'));
  const n = calls.length;
  await runTest({caseDir, testDir, llm: await make(), corpus: fakeCorpus(), tasks, log: () => {}});
  const added = calls.slice(n);
  assert.equal(added.length, 3 * (tasks.length + 1));
  assert.ok(added.every(call => call.role === 'evidence-fit'));
  assert.ok((await buildReport({caseDir, testDir})).distinctPapers.available);
});
