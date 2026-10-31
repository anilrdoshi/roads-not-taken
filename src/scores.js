// Claude's overall fit and novelty for each paper, averaged over its scorings. Every paper is scored
// several times in separate calls (three by default); a score row records which scoring it is
// (`replicate`). Rows from runs made before replicates count as scoring 1, and those runs'
// stability comes from their separate repeat sample (scores-repeat.jsonl) instead.
// Overall fit has two parts, each judged in its own calls: field fit to each field (scores.jsonl,
// scored with novelty) and evidence fit, how well the paper's theory predicts the evidence
// (evidence-fit.jsonl). Overall fit in a field is their geometric mean, so a paper needs both; it is
// null until evidence fit is scored.
import path from 'node:path';
import {FIELD_IDS} from './config.js';
import {readJsonl, replicateOf} from './pipeline.js';

const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
const round3 = value => Math.round(value * 1000) / 1000;
// Sample variance (n - 1) across a paper's scorings; none for a paper scored once.
export const variance = values => values.length < 2 ? null : Math.round(values.reduce((a, v) => a + (v - mean(values)) ** 2, 0) / (values.length - 1) * 1e6) / 1e6;
export const compositeFit = (fieldFit, evidenceFit) => Math.sqrt(fieldFit * evidenceFit);

// One paper's scorings -> mean field fit per field, mean evidence fit, overall fit per field and mean
// novelty. The best field is the one with the highest mean field fit (ties go to the field the
// scorings named most often); a paper scored once keeps the field Claude named. Evidence fit is the
// same in every field, so the best field is also the one with the highest overall fit. Each scoring
// judges novelty within the best field it named, so the report also says how often the scorings agreed on
// that field. Reasons and cited articles shown with the mean come from the first scoring; `rows` and
// `evidenceRows` keep every scoring.
export function averageScores(rows, evidenceRows = []) {
  const sorted = [...rows].sort((a, b) => replicateOf(a) - replicateOf(b));
  const first = sorted[0];
  const fieldFit = Object.fromEntries(FIELD_IDS.map(field => {
    const scored = sorted.filter(row => row.fit[field]);
    if (!scored.length) return [field, null];
    const scores = scored.map(row => row.fit[field].score);
    return [field, {score: round3(mean(scores)), scores, variance: variance(scores), reason: scored[0].fit[field].reason, closest: scored[0].fit[field].closest}];
  }));
  const bestFieldVotes = sorted.reduce((votes, row) => ({...votes, [row.bestField]: (votes[row.bestField] || 0) + 1}), {});
  const rank = field => [fieldFit[field]?.score ?? -1, bestFieldVotes[field] || 0];
  const bestField = sorted.length === 1 ? first.bestField
    : FIELD_IDS.reduce((best, field) => { const [a, b] = rank(field), [c, d] = rank(best); return a > c || (a === c && b > d) ? field : best; });
  const noveltyScores = sorted.map(row => row.novelty.score);

  const evidence = [...evidenceRows].sort((a, b) => replicateOf(a) - replicateOf(b));
  const evidenceScores = evidence.map(row => row.score);
  const evidenceFit = evidence.length ? {
    score: round3(mean(evidenceScores)), scores: evidenceScores, variance: variance(evidenceScores),
    reason: evidence[0].reason, centralResults: evidence[0].centralResults, rivals: evidence[0].rivals,
    fittedHypotheses: evidence[0].fittedHypotheses, unmeasured: evidence[0].unmeasured
  } : null;
  // Overall fit from the means; `scores` pairs the nth field-fit scoring with the nth evidence-fit
  // scoring, which is how scoring noise in overall fit is measured.
  const fit = Object.fromEntries(FIELD_IDS.map(field => {
    if (!fieldFit[field] || !evidenceFit) return [field, null];
    const paired = fieldFit[field].scores.slice(0, evidenceScores.length).map((score, i) => round3(compositeFit(score, evidenceScores[i])));
    return [field, {score: round3(compositeFit(fieldFit[field].score, evidenceFit.score)), scores: paired, variance: variance(paired)}];
  }));
  return {
    id: first.id, kind: first.kind, corpusMaxYear: first.corpusMaxYear, retrieval: first.retrieval,
    replicates: sorted.length, evidenceReplicates: evidence.length,
    fit, fieldFit, evidenceFit, bestField, bestFieldVotes,
    novelty: {score: round3(mean(noveltyScores)), scores: noveltyScores, variance: variance(noveltyScores), reason: first.novelty.reason, closest: first.novelty.closest},
    rows: sorted, evidenceRows: evidence
  };
}

export async function loadScores(testDir) {
  const group = rows => rows.reduce((byId, row) => byId.set(row.id, [...(byId.get(row.id) || []), row]), new Map());
  const byId = group(await readJsonl(path.join(testDir, 'scores.jsonl')));
  const evidenceById = group(await readJsonl(path.join(testDir, 'evidence-fit.jsonl')));
  return new Map([...byId].map(([id, rows]) => [id, averageScores(rows, evidenceById.get(id) || [])]));
}

// Scoring noise in overall fit: two standard errors of the difference between two papers' mean
// overall fit, from how much overall fit varies between scorings of the same paper (in its best
// field), pooled over every paper with at least two. The distinct AI alternatives count allows an AI
// alternative's overall fit to be this far below the focal paper's. Null when no paper has two scorings of both parts.
export function fitNoise(scores) {
  const scored = [...scores.values()].map(paper => paper.fit[paper.bestField]).filter(fit => fit?.scores.length > 1);
  if (!scored.length) return null;
  const sd = Math.sqrt(mean(scored.map(fit => fit.variance)));
  const perPaper = Math.round(mean(scored.map(fit => fit.scores.length)));
  return {sd: round3(sd), scoringsPerPaper: perPaper, papers: scored.length, margin: round3(2 * Math.sqrt(2) * sd / Math.sqrt(perPaper))};
}

// How much separate scorings of the same paper differ: mean absolute difference over every pair of
// scorings, in field fit (all fields), evidence fit, overall fit (best field) and novelty, and how
// often a pair named the same best field. From the replicates when papers have more than one;
// otherwise from a legacy repeat sample (field fit and novelty only).
export function scoreStability(scores, legacyRepeats = []) {
  const pairs = [];
  const pairsOf = values => values.flatMap((a, i) => values.slice(i + 1).map(b => Math.abs(a - b)));
  for (const paper of scores.values()) {
    const rows = paper.rows;
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) pairs.push([rows[i], rows[j]]);
  }
  let method = 'replicates';
  if (!pairs.length && legacyRepeats.length) {
    method = 'repeat-sample';
    for (const repeat of legacyRepeats) if (scores.get(repeat.id)) pairs.push([scores.get(repeat.id).rows[0], repeat]);
  }
  if (!pairs.length) return null;
  const papers = new Set(pairs.map(([a]) => a.id));
  const evidenceDiffs = [...scores.values()].flatMap(paper => pairsOf(paper.evidenceFit?.scores || []));
  const fitDiffs = [...scores.values()].flatMap(paper => pairsOf(paper.fit[paper.bestField]?.scores || []));
  return {
    method,
    replicates: method === 'replicates' ? Math.max(...[...scores.values()].map(paper => paper.replicates)) : 2,
    items: papers.size,
    pairs: pairs.length,
    meanAbsFieldFitDifference: mean(pairs.flatMap(([a, b]) => FIELD_IDS.map(field => Math.abs((a.fit[field]?.score ?? 0) - (b.fit[field]?.score ?? 0))))),
    meanAbsEvidenceFitDifference: evidenceDiffs.length ? mean(evidenceDiffs) : null,
    meanAbsFitDifference: fitDiffs.length ? mean(fitDiffs) : null,
    meanAbsNoveltyDifference: mean(pairs.map(([a, b]) => Math.abs(a.novelty.score - b.novelty.score))),
    bestFieldAgreement: pairs.filter(([a, b]) => a.bestField === b.bestField).length / pairs.length,
    // Papers whose scorings did not all name the same best field (replicates only).
    bestFieldSplit: method === 'replicates' ? [...scores.values()].filter(paper => Object.keys(paper.bestFieldVotes).length > 1).length : null
  };
}
