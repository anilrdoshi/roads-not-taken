// Builds the explorer's data bundle for one case: ui/data/<case>.json, plus the list of cases in
// ui/data/cases.json (git-ignored, so nobody's focal papers are committed by accident). The bundle holds the paper's extraction, every alternative with its review and
// scores, and the titles of the published articles the scorer cited. It holds no abstracts from the
// corpus and nothing from the PDFs, so it can be shared and hosted as a static site.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {FIELDS, HOME_FIELD, THEORIES, TAXONOMY, ROOT, fieldsConfig} from './config.js';
import {readJsonl, loadExtraction} from './pipeline.js';
import {buildReport} from './report.js';
import {OPEN_VARIANT_LABELS} from './prompts.js';
import {loadDistance} from './distance.js';
import {loadScores} from './scores.js';

const DATA_DIR = path.join(ROOT, 'ui', 'data');
const PARTS = ['question', 'conversation', 'theory', 'mechanism', 'interpretation', 'contribution', 'audience'];

export async function buildExplorerData({caseId, caseDir, testDir, corpus, pilot = false, outDir = DATA_DIR}) {
  const record = await loadExtraction(caseDir);
  if (!record) throw new Error(`No extraction for ${caseId}.`);
  const summary = await buildReport({caseDir, testDir});
  const alternatives = await readJsonl(path.join(testDir, 'alternatives.jsonl'));
  const reviews = new Map((await readJsonl(path.join(testDir, 'reviews.jsonl'))).map(row => [row.id, row.review]));
  // Claude's overall fit (field fit and evidence fit) and novelty, averaged over each paper's scorings.
  const scores = await loadScores(testDir);
  const rowById = new Map(summary.rows.map(row => [row.id, row]));
  const distance = await loadDistance(testDir);
  const dist = id => distance?.papers[id] || null;

  // Only the titles of articles the scorer actually cited travel with the bundle.
  const cited = new Set();
  const noteCited = score => {
    if (!score) return;
    for (const entry of Object.values(score.fit)) for (const id of entry?.closest || []) cited.add(id);
    for (const item of score.novelty.closest || []) cited.add(item.id);
  };
  for (const score of scores.values()) for (const row of score.rows) noteCited(row);
  // And of each paper's nearest published articles by distance.
  for (const measures of Object.values(distance?.papers || {})) for (const hit of measures.nearest) cited.add(hit.id);
  const records = {};
  for (const id of cited) {
    const r = corpus?.get(id);
    if (r) records[id] = {title: r.title, journal: r.journal, year: r.year, doi: r.doi};
  }

  const slimScore = score => score && {
    // The mean, each scoring, and the variance across scorings, for overall fit, field fit and
    // evidence fit in each field and for novelty. Overall fit is null until evidence fit is scored.
    fit: Object.fromEntries(Object.entries(score.fit).map(([field, entry]) => [field, entry && {score: entry.score, scores: entry.scores, variance: entry.variance}])),
    fieldFit: Object.fromEntries(Object.entries(score.fieldFit).map(([field, entry]) => [field, entry && {score: entry.score, scores: entry.scores, variance: entry.variance, reason: entry.reason, closest: entry.closest}])),
    evidenceFit: score.evidenceFit && {score: score.evidenceFit.score, scores: score.evidenceFit.scores, variance: score.evidenceFit.variance, reason: score.evidenceFit.reason,
      centralResults: score.evidenceFit.centralResults, rivals: score.evidenceFit.rivals, fittedHypotheses: score.evidenceFit.fittedHypotheses, unmeasured: score.evidenceFit.unmeasured},
    bestField: score.bestField,
    bestFieldVotes: score.bestFieldVotes,
    novelty: {score: score.novelty.score, scores: score.novelty.scores, variance: score.novelty.variance, reason: score.novelty.reason, closest: score.novelty.closest},
    scorings: score.replicates
  };
  const slimDistance = measures => measures && {
    fromOriginal: measures.fromOriginal,
    toPublishedPercentile: measures.toPublishedPercentile,
    neighbourFields: measures.neighbourFields,
    topNeighbourField: measures.topNeighbourField,
    nearest: measures.nearest.map(hit => hit.id)
  };
  const x = record.extraction;
  const codeLabel = id => TAXONOMY.topics.find(t => t.id === id)?.label || TAXONOMY.methods.find(m => m.id === id)?.label || THEORIES.find(t => t.id === id)?.name || id;

  const bundle = {
    schemaVersion: 1,
    caseId,
    pilot,
    builtAt: new Date().toISOString(),
    model: summary.rows.length ? alternatives[0].modelServed : null,
    fields: FIELDS.map(({id, label, description}) => ({id, label, description})),
    homeField: HOME_FIELD,
    corpusWindow: fieldsConfig.corpusWindow,
    parts: PARTS,
    paper: {
      identity: x.identity,
      versionNote: record.versionNote,
      abstract: x.abstract,
      framing: x.framing,
      constructs: x.constructs,
      codes: {
        primaryTheory: codeLabel(x.codes.primaryTheory),
        theories: x.codes.theories.map(codeLabel),
        topics: x.codes.topics.map(codeLabel),
        methods: x.codes.methods.map(codeLabel)
      },
      evidence: x.evidence,
      leakCheck: {flagged: record.leakCheck.flagsBefore.length, repaired: !!record.leakCheck.repair?.accepted, remaining: record.leakCheck.flagsAfter.length}
    },
    original: slimScore(scores.get('original')) && {...slimScore(scores.get('original')), distance: slimDistance(dist('original'))},
    alternatives: alternatives.map(alt => {
      const review = reviews.get(alt.id), row = rowById.get(alt.id);
      const vsOriginal = review?.comparisons.find(c => c.reference === 'original') || review?.comparisons[0];
      return {
        id: alt.id,
        kind: alt.target.mode,
        target: alt.target.mode === 'theory' ? THEORIES.find(t => t.id === alt.target.theoryId)?.name
          : alt.target.mode === 'field' ? FIELDS.find(f => f.id === alt.target.fieldId)?.label
          : alt.target.ambition ? `${OPEN_VARIANT_LABELS[alt.target.ambition]}, ${OPEN_VARIANT_LABELS[alt.target.format].toLowerCase()}` : null,
        targetId: alt.target.theoryId || alt.target.fieldId || null,
        outline: alt.outline,
        review: review && {
          verdict: review.evidence.verdict,
          contradictions: review.evidence.contradictions,
          flags: review.evidence.flags,
          flagNotes: review.evidence.flagNotes,
          primaryTheory: codeLabel(review.codes.primaryTheory),
          components: vsOriginal?.components || null,
          family: vsOriginal?.family || null,
          summary: vsOriginal?.summary || ''
        },
        score: slimScore(scores.get(alt.id)),
        distance: slimDistance(dist(alt.id)),
        burden: row?.burden,
        partsReplaced: row?.componentsReplaced ?? null
      };
    }),
    records,
    summary: {
      counts: summary.counts,
      convergence: summary.convergence,
      fieldReach: summary.fieldReach,
      distinctPapers: summary.distinctPapers,
      fitNoise: summary.fitNoise,
      evidenceFitScorings: summary.evidenceFitScorings,
      evidence: summary.evidence,
      stability: summary.stability,
      distance: summary.distance,
      costByStage: summary.costByStage,
      fallbackCalls: summary.fallbackCalls
    }
  };

  await mkdir(outDir, {recursive: true});
  await writeFile(path.join(outDir, `${caseId}.json`), JSON.stringify(bundle));
  const indexFile = path.join(outDir, 'cases.json');
  const index = existsSync(indexFile) ? JSON.parse(await readFile(indexFile, 'utf8')) : {cases: []};
  const entry = {id: caseId, title: x.identity.title, authors: x.identity.authors, year: x.identity.year, versionNote: record.versionNote, pilot, alternatives: alternatives.length};
  index.cases = [...index.cases.filter(c => c.id !== caseId), entry].sort((a, b) => a.id.localeCompare(b.id));
  await writeFile(indexFile, JSON.stringify(index, null, 2) + '\n');
  return bundle;
}
