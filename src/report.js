// Turns saved test outputs into summary.json and summary.md. Makes no model calls, so anyone
// can rebuild the report from a shared run folder.
import {readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {FIELDS, FIELD_IDS, HOME_FIELD, THEORIES, fieldsConfig} from './config.js';
import {readJsonl, loadExtraction, scoreKey} from './pipeline.js';
import {OPEN_AMBITIONS, EVIDENCE_FORMATS, OPEN_VARIANT_LABELS} from './prompts.js';
import {loadDistance, spearman} from './distance.js';
import {loadScores, scoreStability, fitNoise} from './scores.js';

const CHANGED = new Set(['refined', 'reframed', 'replaced']);
const fieldLabel = Object.fromEntries(FIELDS.map(field => [field.id, field.label]));
const theoryName = id => THEORIES.find(theory => theory.id === id)?.name || id;
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const stats = values => ({n: values.length, mean: mean(values), min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null});
const FAMILIES = ['same-paper', 'close-variant', 'different-paper'];
const fmt = value => value == null ? '–' : value.toFixed(2);
const count = (items, key) => items.reduce((acc, item) => { const k = key(item); acc[k] = (acc[k] || 0) + 1; return acc; }, {});

export async function buildReport({caseDir, testDir}) {
  const file = name => path.join(testDir, name);
  const record = await loadExtraction(caseDir);
  const alternatives = await readJsonl(file('alternatives.jsonl'));
  const reviews = new Map((await readJsonl(file('reviews.jsonl'))).map(row => [row.id, row.review]));
  // Claude's overall fit (field fit and evidence fit) and novelty, averaged over each paper's scorings.
  const scores = await loadScores(testDir);
  const repeats = await readJsonl(file('scores-repeat.jsonl'));
  // Failures that later succeeded on a rerun are not counted.
  const doneByStage = {generate: new Set(alternatives.map(a => a.id)), review: new Set((await readJsonl(file('reviews.jsonl'))).map(r => r.id)), score: new Set((await readJsonl(file('scores.jsonl'))).map(scoreKey)), 'evidence-fit': new Set((await readJsonl(file('evidence-fit.jsonl'))).map(scoreKey)), 'score-repeat': new Set((await readJsonl(file('scores-repeat.jsonl'))).map(r => r.id))};
  // Score and evidence-fit failures are keyed by paper and scoring (older runs: by paper, which is scoring 1).
  const failures = (await readJsonl(file('failures.jsonl'))).filter(f => !doneByStage[f.stage]?.has(['score', 'evidence-fit'].includes(f.stage) ? f.key || `${f.id}#1` : f.id));
  const unresolvedFailures = [...new Map(failures.map(f => [`${f.stage}:${f.id}`, f])).values()];
  const budget = existsSync(path.join(caseDir, 'budget.json')) ? JSON.parse(await readFile(path.join(caseDir, 'budget.json'), 'utf8')) : null;
  // Cost and tokens by stage, from this run's call log.
  const byStage = {};
  for (const call of await readJsonl(file('calls.jsonl'))) {
    const stage = byStage[call.role] ||= {calls: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0, seconds: 0};
    stage.calls++;
    stage.inputTokens += call.usage?.input_tokens || 0;
    stage.cacheReadTokens += call.usage?.cache_read_input_tokens || 0;
    stage.cacheWriteTokens += call.usage?.cache_creation_input_tokens || 0;
    stage.outputTokens += call.usage?.output_tokens || 0;
    stage.costUsd += call.costUsd || 0;
    stage.seconds += (call.durationMs || 0) / 1000;
  }
  const fallbackCalls = (await readJsonl(file('calls.jsonl'))).filter(call => call.servedByFallback).length;
  // Distance (src/distance.js, embeddings), when it has been computed for this run.
  const distance = await loadDistance(testDir);
  const dist = id => distance?.papers[id] || null;

  const rows = alternatives.map(alt => {
    const review = reviews.get(alt.id), score = scores.get(alt.id);
    const vsOriginal = review?.comparisons.find(c => c.reference === 'original') || review?.comparisons[0];
    const bestFit = score?.fit[score.bestField]?.score ?? null;
    return {
      id: alt.id, kind: alt.target.mode, target: alt.target, title: alt.outline.title, abstract: alt.outline.abstract,
      declaredField: alt.outline.field, theory: alt.outline.theory.primary,
      primaryTheoryCode: review?.codes.primaryTheory || null,
      verdict: review?.evidence.verdict || null, flags: review?.evidence.flags || null,
      familyVsOriginal: vsOriginal?.family || null,
      componentsChanged: vsOriginal ? Object.values(vsOriginal.components).filter(c => CHANGED.has(c)).length : null,
      componentsReplaced: vsOriginal ? Object.values(vsOriginal.components).filter(c => c === 'replaced').length : null,
      differenceSummary: vsOriginal?.summary || '',
      // Overall fit (the geometric mean of field fit and evidence fit) and its two parts.
      fit: score ? Object.fromEntries(FIELD_IDS.map(id => [id, score.fit[id]?.score ?? null])) : null,
      fieldFit: score ? Object.fromEntries(FIELD_IDS.map(id => [id, score.fieldFit[id]?.score ?? null])) : null,
      evidenceFit: score?.evidenceFit?.score ?? null,
      bestField: score?.bestField || null, bestFit, bestFieldFit: score?.fieldFit[score.bestField]?.score ?? null, novelty: score?.novelty.score ?? null,
      scorings: score?.replicates ?? 0,
      distanceFromOriginal: dist(alt.id)?.fromOriginal ?? null,
      distanceFromPublishedPercentile: score && dist(alt.id) ? dist(alt.id).toPublishedPercentile[score.bestField] ?? null : null,
      distanceFromPublishedPercentileAll: dist(alt.id)?.toPublishedPercentile.all ?? null,
      topNeighbourField: dist(alt.id)?.topNeighbourField || null,
      neighbourFields: dist(alt.id)?.neighbourFields || null,
      changesNeeded: alt.outline.changesNeeded,
      // Evidence burden from the outline's own hypotheses: can its argument be made with the reported results?
      burden: alt.outline.hypotheses.some(h => h.status === 'needs-new-data') ? 'new data'
        : alt.outline.hypotheses.some(h => h.status === 'needs-reanalysis') ? 're-analysis' : 'reported results'
    };
  });
  const byKind = kind => rows.filter(row => row.kind === kind);
  const original = scores.get('original');

  // Convergence: how often free runs land back on the original paper.
  const convergence = count(byKind('open'), row => row.familyVsOriginal || 'not reviewed');
  // The same by request and by evidence format, for runs that recorded them (earlier runs all
  // used one request and have none). Each run had one of each, so the two groups overlap.
  const openByVariant = byKind('open').some(row => row.target.ambition)
    ? [['ambition', Object.keys(OPEN_AMBITIONS)], ['format', EVIDENCE_FORMATS]].flatMap(([factor, levels]) => levels.map(level => {
      const runs = byKind('open').filter(row => row.target[factor] === level);
      return {
        factor, level, runs: runs.length,
        convergence: count(runs, row => row.familyVsOriginal || 'not reviewed'),
        primaryTheories: new Set(runs.map(row => row.primaryTheoryCode).filter(Boolean)).size,
        bestFields: count(runs, row => row.bestField || 'not scored')
      };
    }))
    : null;

  // Field reach: for each field, the original's overall fit and the best overall fit reached by runs
  // aimed there.
  const fieldReach = FIELD_IDS.map(fieldId => {
    const aimed = rows.filter(row => row.kind === 'field' && row.target.fieldId === fieldId && row.fit?.[fieldId] != null);
    const best = aimed.sort((a, b) => b.fit[fieldId] - a.fit[fieldId])[0];
    const anyBest = rows.filter(row => row.fit?.[fieldId] != null).sort((a, b) => b.fit[fieldId] - a.fit[fieldId])[0];
    return {
      fieldId, label: fieldLabel[fieldId],
      originalFit: original?.fit[fieldId]?.score ?? null,
      originalFieldFit: original?.fieldFit[fieldId]?.score ?? null,
      aimedRuns: rows.filter(row => row.kind === 'field' && row.target.fieldId === fieldId).length,
      meanAimedFit: mean(aimed.map(row => row.fit[fieldId])),
      bestAimed: best ? {id: best.id, title: best.title, fit: best.fit[fieldId], fieldFit: best.fieldFit[fieldId], evidenceFit: best.evidenceFit, novelty: best.novelty, componentsReplaced: best.componentsReplaced, burden: best.burden, changesNeeded: best.changesNeeded} : null,
      bestAnyRun: anyBest ? {id: anyBest.id, fit: anyBest.fit[fieldId]} : null
    };
  });

  // Distinct AI alternatives: a different paper from the original whose overall fit in its best field
  // is at least the original's overall fit (in its best field) less scoring noise. The headline count also asks for
  // consistency with the evidence; the count with contradicting ones included is kept beside it.
  const originalFit = original?.fit[original.bestField]?.score ?? null;
  const noise = fitNoise(scores);
  const distinctPapers = originalFit == null
    ? {available: false, originalFit: null, margin: noise?.margin ?? null}
    : (() => {
      const bar = originalFit - (noise?.margin ?? 0);
      const different = rows.filter(row => row.familyVsOriginal === 'different-paper' && row.bestFit != null && row.bestFit >= bar - 1e-9);
      const consistent = different.filter(row => row.verdict === 'consistent');
      return {available: true, originalFit, margin: noise?.margin ?? 0, bar, count: consistent.length, ids: consistent.map(row => row.id),
        countWithContradicting: different.length, idsWithContradicting: different.map(row => row.id),
        unscored: rows.filter(row => row.familyVsOriginal === 'different-paper' && row.bestFit == null).length};
    })();
  const theoryRows = byKind('theory').map(row => ({...row, theoryName: theoryName(row.target.theoryId), homeFit: row.fit?.[HOME_FIELD] ?? null, homeFieldFit: row.fieldFit?.[HOME_FIELD] ?? null}));

  // Stability: how much separate scorings of the same paper differ (all pairs of a paper's
  // scorings; for runs before replicates, the repeat sample).
  const stability = scoreStability(scores, repeats);

  const summary = {
    generatedAt: new Date().toISOString(),
    paper: {...record?.extraction.identity, versionNote: record?.versionNote},
    counts: {alternatives: rows.length, byKind: count(rows, row => row.kind), failures: unresolvedFailures.length},
    evidence: {
      verdicts: count(rows, row => row.verdict || 'not reviewed'),
      flags: Object.fromEntries(['untestedMechanism', 'causalOverreach', 'needsReanalysis', 'needsNewData'].map(flag => [flag, rows.filter(row => row.flags?.[flag]).length])),
      burden: count(rows, row => row.burden)
    },
    convergence,
    openBestFields: count(byKind('open'), row => row.bestField || 'not scored'),
    openDeclaredFields: count(byKind('open'), row => row.declaredField),
    openByVariant,
    original: original ? {
      fit: Object.fromEntries(FIELD_IDS.map(id => [id, original.fit[id]?.score ?? null])),
      fieldFit: Object.fromEntries(FIELD_IDS.map(id => [id, original.fieldFit[id]?.score ?? null])),
      evidenceFit: original.evidenceFit?.score ?? null,
      bestField: original.bestField, novelty: original.novelty.score, scorings: original.replicates, corpusMaxYear: original.corpusMaxYear
    } : null,
    scorings: scores.size ? {perPaper: Math.max(...[...scores.values()].map(p => p.replicates)), fewer: [...scores.values()].filter(p => p.replicates < Math.max(...[...scores.values()].map(q => q.replicates))).map(p => p.id)} : null,
    evidenceFitScorings: evidenceFitCoverage(scores),
    fitNoise: noise,
    fieldReach,
    distinctPapers,
    primaryTheories: count(rows, row => row.primaryTheoryCode || 'not coded'),
    stability,
    distance: distance && distanceSummary({distance, rows, scores}),
    cost: budget,
    costByStage: byStage,
    fallbackCalls,
    rows
  };
  await writeFile(file('summary.json'), JSON.stringify(summary, null, 2) + '\n');
  await writeFile(file('summary.md'), summaryMarkdown(summary, theoryRows));
  return summary;
}

// Distance (embeddings), and how it lines up with Claude's review and with Claude's novelty and field fit.
function distanceSummary({distance, rows, scores}) {
  const dist = id => distance.papers[id];
  const measured = rows.filter(row => dist(row.id));
  const scored = ['original', ...rows.map(row => row.id)].map(id => ({id, score: scores.get(id)})).filter(p => p.score && dist(p.id));
  const pairs = list => ({n: list.length, spearman: spearman(list.map(p => p[0]), list.map(p => p[1]))});
  const groups = [...FIELD_IDS, 'all'];
  const original = dist('original');
  return {
    model: distance.model, corpusMaxYear: distance.corpusMaxYear, corpusArticles: distance.corpusArticles,
    originalAbstract: distance.originalAbstract || 'paraphrase',
    settings: distance.settings, baseShares: distance.baseShares, referenceMedian: distance.referenceMedian,
    measuredAlternatives: measured.length, unmeasured: rows.length - measured.length,
    original: original ? {toPublishedPercentile: original.toPublishedPercentile, toPublished: original.toPublished, neighbourFields: original.neighbourFields, topNeighbourField: original.topNeighbourField} : null,
    alternativesMedianPercentile: Object.fromEntries(groups.map(g => [g, median(measured.map(row => dist(row.id).toPublishedPercentile[g]))])),
    alternativesMeanNeighbourFields: Object.fromEntries(Object.keys(distance.baseShares).map(g => [g, mean(measured.map(row => dist(row.id).neighbourFields[g]))])),
    fromOriginal: {
      byFamily: Object.fromEntries(FAMILIES.map(f => [f, stats(measured.filter(row => row.familyVsOriginal === f).map(row => row.distanceFromOriginal))])),
      byKind: Object.fromEntries(['open', 'theory', 'field'].map(k => [k, stats(measured.filter(row => row.kind === k).map(row => row.distanceFromOriginal))]))
    },
    relation: {
      // Claude's novelty and the distance-from-published-work percentile, both in Claude's best-fit field.
      noveltyAndDistance: pairs(scored.map(p => [p.score.novelty.score, dist(p.id).toPublishedPercentile[p.score.bestField]])),
      // Claude's field fit to each field and the share of the nearest published articles from that field.
      fitAndNeighbourShare: pairs(scored.flatMap(p => FIELD_IDS.filter(f => p.score.fieldFit[f]).map(f => [p.score.fieldFit[f].score, dist(p.id).neighbourFields[f]]))),
      bestFieldAndTopNeighbourField: {n: scored.length, matches: scored.filter(p => dist(p.id).topNeighbourField === p.score.bestField).length}
    }
  };
}

function distanceMarkdown(d) {
  const heading = '## Distance (embeddings; no model judgement)';
  if (!d) return `${heading}\nNot computed for this run. Build the corpus embeddings once (\`npm run build-embeddings\`), then run \`npm run distance -- --case <name>\`.\n`;
  const pct = value => value == null ? '–' : String(Math.round(value));
  const share = value => value == null ? '–' : `${Math.round(value * 100)}%`;
  const statRow = (label, st) => `| ${label} | ${st.n} | ${fmt(st.mean)} | ${st.n ? `${fmt(st.min)}–${fmt(st.max)}` : '–'} |`;
  const rho = a => a.spearman == null ? '–' : a.spearman.toFixed(2);
  const groups = Object.keys(d.baseShares);
  const {neighbours, fieldNeighbours, referenceSample} = d.settings;
  return `${heading}
Distance is the cosine distance between text embeddings (${d.model}) of the title and abstract of the focal paper and of each AI alternative, compared with the ${d.corpusArticles.toLocaleString()} published papers in the corpus up to ${d.corpusMaxYear}. It is a separate measure from Claude's novelty and fit scores: Claude plays no part in it, and it measures how far apart texts are, not whether an idea is new or belongs in a field.${d.unmeasured ? ` ${d.unmeasured} AI alternatives were added after it was computed; run \`npm run distance\` again to include them.` : ''}

${d.originalAbstract === 'own'
  ? 'The focal paper is represented by its own abstract (kept locally in the case\'s private folder, not in the repository), so it compares directly with the abstracts of published papers.'
  : 'The focal paper is represented by its abstract as paraphrased at extraction, which is written in the third person ("The authors argue…"); the AI alternatives\' abstracts and those of published papers are in the first person. That makes the focal paper look further from both than its own abstract would, so its distances are overstated; comparisons among AI alternatives are not affected. Save its own abstract with `npm run original-abstract` to fix this.'} The AI alternatives' abstracts are written by Claude and those of published papers by their authors, so compare the AI alternatives with each other rather than reading the percentiles as absolute.

### Distance from the focal paper
Cosine distance between each AI alternative's title and abstract and the focal paper's (0 = same meaning). For scale, a published paper in the corpus is on average ${fmt(d.referenceMedian?.all)} from its ${neighbours} nearest published papers in the corpus (median published paper).

| Claude's comparison with the focal paper | AI alternatives | Mean distance | Range |
|---|---|---|---|
${FAMILIES.map(f => statRow(f.replace('-', ' '), d.fromOriginal.byFamily[f])).join('\n')}

| Run type | AI alternatives | Mean distance | Range |
|---|---|---|---|
${['open', 'theory', 'field'].map(k => statRow(k, d.fromOriginal.byKind[k])).join('\n')}

### Distance from the published corpus
For each field, the mean distance of the focal paper, or of an AI alternative, to its ${neighbours} nearest published papers in that field, as a percentile of the same distance for the published papers in that field (up to ${referenceSample.toLocaleString()} sampled per field). 50 means as far from its nearest published papers as the typical published paper in that field; higher means further from that field's published papers.

| | ${FIELDS.map(f => f.label).join(' | ')} | All fields |
|---|${FIELDS.map(() => '---').join('|')}|---|
| Focal paper | ${FIELD_IDS.map(id => pct(d.original?.toPublishedPercentile[id])).join(' | ')} | ${pct(d.original?.toPublishedPercentile.all)} |
| AI alternatives (median) | ${FIELD_IDS.map(id => pct(d.alternativesMedianPercentile[id])).join(' | ')} | ${pct(d.alternativesMedianPercentile.all)} |

### Fields of the ${fieldNeighbours} nearest published papers
| | ${groups.map(g => fieldLabel[g]).join(' | ')} |
|---|${groups.map(() => '---').join('|')}|
| Focal paper | ${groups.map(g => share(d.original?.neighbourFields[g])).join(' | ')} |
| AI alternatives (mean) | ${groups.map(g => share(d.alternativesMeanNeighbourFields[g])).join(' | ')} |
| Share of the corpus | ${groups.map(g => share(d.baseShares[g])).join(' | ')} |

The focal paper's top neighbour field (the field most over-represented among these published papers, relative to its share of the corpus): ${fieldLabel[d.original?.topNeighbourField] || '–'}.

### How distance relates to Claude's novelty and field fit
- **Novelty and distance from the published corpus:** Spearman ρ = ${rho(d.relation.noveltyAndDistance)} between Claude's novelty and the distance percentile in Claude's best-fit field (the focal paper and ${d.relation.noveltyAndDistance.n - 1} AI alternatives).
- **Field fit and neighbour fields:** ρ = ${rho(d.relation.fitAndNeighbourShare)} between Claude's field fit to a field and the share of nearest published papers from that field (${d.relation.fitAndNeighbourShare.n} pairs of a field with the focal paper or an AI alternative).
- **Best field:** the top neighbour field matches Claude's best-fit field for ${d.relation.bestFieldAndTopNeighbourField.matches} of ${d.relation.bestFieldAndTopNeighbourField.n} (the focal paper and the AI alternatives).
`;
}

// How many papers have evidence fit, and from how many scorings.
function evidenceFitCoverage(scores) {
  const papers = [...scores.values()];
  const scored = papers.filter(paper => paper.evidenceFit);
  return {papers: scored.length, of: papers.length, perPaper: scored.length ? Math.max(...scored.map(paper => paper.evidenceReplicates)) : 0};
}

function scoringsNote(scorings, evidence) {
  if (!scorings) return 'Not scored yet.';
  const base = scorings.perPaper > 1
    ? `Field fit and novelty are Claude's scores, each the mean of ${scorings.perPaper} scorings in separate calls, for the focal paper and for each AI alternative.`
    : 'Field fit and novelty are Claude\'s scores, from one scoring of the focal paper and of each AI alternative (this run predates scoring each three times).';
  const withFewer = scorings.fewer.length ? `${base} ${scorings.fewer.length} have fewer scorings so far: ${scorings.fewer.join(', ')}.` : base;
  const evidenceNote = !evidence?.papers
    ? 'Evidence fit has not been scored for this run, so overall fit is not available; rerun `npm run test-run` for this case to add it (only the evidence-fit calls are made).'
    : `Evidence fit is Claude's judgement of how well a paper's theory predicts the evidence, the mean of ${evidence.perPaper} scoring${evidence.perPaper > 1 ? 's' : ''} in separate calls that see the evidence${evidence.papers < evidence.of ? `, so far for ${evidence.papers} of ${evidence.of}` : ''}. Overall fit in a field is the geometric mean of field fit and evidence fit, so a paper needs both. The 0-1 scales in the prompts guide Claude; the scores are not assumed to come back on them, so read field fit, evidence fit, overall fit and novelty against the focal paper's and the other AI alternatives', not as absolute levels.`;
  return `${withFewer} ${evidenceNote}`;
}

function distinctText(d) {
  if (!d.available) return '**Distinct AI alternatives:** not available until the focal paper has evidence fit (and so overall fit).';
  return `**Distinct AI alternatives:** ${d.count} AI alternatives are a different paper from the focal paper, consistent with the evidence, and have an overall fit in their best field of at least ${fmt(d.bar)}: the focal paper's overall fit (${fmt(d.originalFit)}) less scoring noise (${d.margin.toFixed(3)}, two standard errors of the difference between two papers' mean overall fit). With AI alternatives that contradict a reported result included: ${d.countWithContradicting}.${d.unscored ? ` ${d.unscored} different-paper AI alternatives have no overall fit yet.` : ''}`;
}

function stabilityText(st) {
  if (!st) return 'Not yet measured.';
  const evidence = st.meanAbsEvidenceFitDifference == null ? '' : ` ${fmt(st.meanAbsEvidenceFitDifference)} in evidence fit, ${fmt(st.meanAbsFitDifference)} in overall fit (best field),`;
  const differences = `Mean absolute difference between two scorings of the same one: ${fmt(st.meanAbsFieldFitDifference)} in field fit (each field),${evidence} ${fmt(st.meanAbsNoveltyDifference)} in novelty. Best field matched in ${Math.round(st.bestFieldAgreement * 100)}% of pairs.`;
  return st.method === 'replicates'
    ? `The focal paper and every AI alternative were scored ${st.replicates} times in separate calls (the focal paper and ${st.items - 1} AI alternatives, ${st.pairs} pairs of scorings). ${differences} For ${st.bestFieldSplit}, the scorings did not all name the same best field.`
    : `A sample of ${st.items} was scored a second time in separate calls (in runs before the focal paper and every AI alternative were scored three times). ${differences}`;
}

function openVariantTable(groups) {
  if (!groups) return '';
  const landed = fields => Object.entries(fields).map(([k, v]) => `${fieldLabel[k] || k} ${v}`).join(', ') || '–';
  return `

Open runs by request and by evidence format (each run had one request and one format):

| | Runs | Same paper | Close variant | Different paper | Distinct primary theories | Where they landed |
|---|---|---|---|---|---|---|
${groups.map(g => `| ${OPEN_VARIANT_LABELS[g.level]} | ${g.runs} | ${g.convergence['same-paper'] || 0} | ${g.convergence['close-variant'] || 0} | ${g.convergence['different-paper'] || 0} | ${g.primaryTheories} | ${landed(g.bestFields)} |`).join('\n')}`;
}

function summaryMarkdown(s, theoryRows) {
  const conv = obj => ['same-paper', 'close-variant', 'different-paper'].map(k => `${obj[k] || 0} ${k.replace('-', ' ')}`).join(', ');
  const fitCells = fit => FIELD_IDS.map(id => fmt(fit?.[id])).join(' | ');
  const top = [...s.rows].filter(row => row.verdict === 'consistent' && row.bestFit != null && row.novelty != null)
    .sort((a, b) => (b.bestFit * b.novelty) - (a.bestFit * a.novelty)).slice(0, 10);
  return `# Quality test: ${s.paper?.title || 'focal paper'}

${s.paper?.authors?.join(', ') || ''} · ${s.paper?.year || ''} · ${s.paper?.versionNote || ''}

Generated ${s.generatedAt.slice(0, 16).replace('T', ' ')} UTC from saved outputs (no model calls). ${s.counts.alternatives} AI alternatives: ${Object.entries(s.counts.byKind).map(([k, v]) => `${v} ${k}`).join(', ')}. Failures: ${s.counts.failures}.${s.cost ? ` Spend so far: $${s.cost.spentUsd.toFixed(2)} of a $${s.cost.capUsd} cap.` : ''}

## Does it come back to the focal paper?
- **Open runs** (given only the evidence and asked for an AI alternative in any field, with any theory), compared with the focal paper: ${conv(s.convergence)}.
- Where open runs landed (best-fit field from scoring): ${Object.entries(s.openBestFields).map(([k, v]) => `${fieldLabel[k] || k} ${v}`).join(', ')}.${openVariantTable(s.openByVariant)}

## Where does the focal paper fit?
${scoringsNote(s.scorings, s.evidenceFitScorings)}

| | ${FIELDS.map(f => f.label).join(' | ')} | Evidence fit | Novelty |
|---|${FIELDS.map(() => '---').join('|')}|---|---|
| Field fit | ${fitCells(s.original?.fieldFit)} | ${fmt(s.original?.evidenceFit)} | ${fmt(s.original?.novelty)} |
| Overall fit | ${fitCells(s.original?.fit)} | | |

The focal paper and every AI alternative are compared with published papers in the corpus from ${fieldsConfig.corpusWindow.fromYear}–${Math.min(s.original?.corpusMaxYear || fieldsConfig.corpusWindow.toYear, fieldsConfig.corpusWindow.toYear)}, never later than the focal paper's year.
### Reaching each field
| Field | Focal paper's overall fit | Runs aimed here | Mean overall fit | Best overall fit | Its field fit / evidence fit | Parts replaced (of 7) | Evidence it needs |
|---|---|---|---|---|---|---|---|
${s.fieldReach.map(f => `| ${f.label} | ${fmt(f.originalFit)} | ${f.aimedRuns} | ${fmt(f.meanAimedFit)} | ${fmt(f.bestAimed?.fit)} | ${f.bestAimed ? `${fmt(f.bestAimed.fieldFit)} / ${fmt(f.bestAimed.evidenceFit)}` : '–'} | ${f.bestAimed?.componentsReplaced ?? '–'} | ${f.bestAimed?.burden || '–'} |`).join('\n')}

Parts are the question, conversation, theory, mechanism, interpretation, contribution and audience, compared with the focal paper; "replaced" means a different idea, not a rewording or a new emphasis.

${distinctText(s.distinctPapers)}

## Theory-targeted runs (home field: ${fieldLabel[HOME_FIELD]})
| Theory | Field fit (home) | Evidence fit | Overall fit (home) | Best field | Best overall fit | Novelty | vs focal paper | Parts replaced | Distance from focal paper | Evidence it needs | Check |
|---|---|---|---|---|---|---|---|---|---|---|---|
${theoryRows.map(r => `| ${r.theoryName} | ${fmt(r.homeFieldFit)} | ${fmt(r.evidenceFit)} | ${fmt(r.homeFit)} | ${fieldLabel[r.bestField] || '–'} | ${fmt(r.bestFit)} | ${fmt(r.novelty)} | ${r.familyVsOriginal || '–'} | ${r.componentsReplaced ?? '–'} | ${fmt(r.distanceFromOriginal)} | ${r.burden} | ${r.verdict || '–'} |`).join('\n')}

For comparison, the focal paper: field fit (home) ${fmt(s.original?.fieldFit?.[HOME_FIELD])}, evidence fit ${fmt(s.original?.evidenceFit)}, overall fit (home) ${fmt(s.original?.fit?.[HOME_FIELD])}.

## Evidence check
Verdicts: ${Object.entries(s.evidence.verdicts).map(([k, v]) => `${v} ${k}`).join(', ')}. Flags (not failures): ${Object.entries(s.evidence.flags).map(([k, v]) => `${k} ${v}`).join(', ')}.

Evidence each AI alternative's hypotheses need: ${Object.entries(s.evidence.burden).map(([k, v]) => `${v} ${k}`).join(', ')}.

## Score stability
${stabilityText(s.stability)}

${distanceMarkdown(s.distance)}
## Ten AI alternatives with the highest best-field overall fit × novelty
${top.map((r, i) => `${i + 1}. **${r.title}** (${r.id}). ${fieldLabel[r.bestField]}, overall fit ${fmt(r.bestFit)}, novelty ${fmt(r.novelty)}${r.distanceFromOriginal == null ? '' : `, distance from focal paper ${fmt(r.distanceFromOriginal)}`}; ${r.theory}; ${r.familyVsOriginal || 'not compared'}, ${r.componentsReplaced ?? '–'} of 7 parts replaced; needs ${r.burden}.\n   ${r.differenceSummary}`).join('\n')}

## Cost of this run
| Stage | Calls | Input tokens | Cache reads | Output tokens | Cost | Avg seconds |
|---|---|---|---|---|---|---|
${Object.entries(s.costByStage).map(([stage, c]) => `| ${stage} | ${c.calls} | ${c.inputTokens.toLocaleString()} | ${c.cacheReadTokens.toLocaleString()} | ${c.outputTokens.toLocaleString()} | $${c.costUsd.toFixed(2)} | ${Math.round(c.seconds / c.calls)} |`).join('\n')}
| **Total** | ${Object.values(s.costByStage).reduce((a, c) => a + c.calls, 0)} | | | | **$${Object.values(s.costByStage).reduce((a, c) => a + c.costUsd, 0).toFixed(2)}** | |

Calls answered by a fallback model: ${s.fallbackCalls}.

## Primary theories across all AI alternatives
${Object.entries(s.primaryTheories).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${theoryName(k)} ${v}`).join(' · ')}
`;
}
