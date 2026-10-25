// Claude's Fit and Novelty for each paper, averaged over its scorings. Every paper is scored
// several times in separate calls (three by default); a score row records which scoring it is
// (`replicate`). Rows from runs made before replicates count as scoring 1, and those runs'
// stability comes from their separate repeat sample (scores-repeat.jsonl) instead.
import path from 'node:path';
import {FIELD_IDS} from './config.js';
import {readJsonl, replicateOf} from './pipeline.js';

const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
const round3 = value => Math.round(value * 1000) / 1000;
// Sample variance (n - 1) across a paper's scorings; none for a paper scored once.
export const variance = values => values.length < 2 ? null : Math.round(values.reduce((a, v) => a + (v - mean(values)) ** 2, 0) / (values.length - 1) * 1e6) / 1e6;

// One paper's scorings -> mean Fit per field and mean Novelty. The best field is the one with the
// highest mean Fit (ties go to the field the scorings named most often); a paper scored once keeps
// the field Claude named. Each scoring judges Novelty within the best field it named, so the
// report also says how often the scorings agreed on that field. Reasons and cited articles shown with the
// mean come from the first scoring; `rows` keeps every scoring.
export function averageScores(rows) {
  const sorted = [...rows].sort((a, b) => replicateOf(a) - replicateOf(b));
  const first = sorted[0];
  const fit = Object.fromEntries(FIELD_IDS.map(field => {
    const scored = sorted.filter(row => row.fit[field]);
    if (!scored.length) return [field, null];
    const scores = scored.map(row => row.fit[field].score);
    return [field, {score: round3(mean(scores)), scores, variance: variance(scores), reason: scored[0].fit[field].reason, closest: scored[0].fit[field].closest}];
  }));
  const bestFieldVotes = sorted.reduce((votes, row) => ({...votes, [row.bestField]: (votes[row.bestField] || 0) + 1}), {});
  const rank = field => [fit[field]?.score ?? -1, bestFieldVotes[field] || 0];
  const bestField = sorted.length === 1 ? first.bestField
    : FIELD_IDS.reduce((best, field) => { const [a, b] = rank(field), [c, d] = rank(best); return a > c || (a === c && b > d) ? field : best; });
  const noveltyScores = sorted.map(row => row.novelty.score);
  return {
    id: first.id, kind: first.kind, corpusMaxYear: first.corpusMaxYear, retrieval: first.retrieval,
    replicates: sorted.length,
    fit, bestField, bestFieldVotes,
    novelty: {score: round3(mean(noveltyScores)), scores: noveltyScores, variance: variance(noveltyScores), reason: first.novelty.reason, closest: first.novelty.closest},
    rows: sorted
  };
}

export async function loadScores(testDir) {
  const byId = new Map();
  for (const row of await readJsonl(path.join(testDir, 'scores.jsonl'))) {
    if (!byId.has(row.id)) byId.set(row.id, []);
    byId.get(row.id).push(row);
  }
  return new Map([...byId].map(([id, rows]) => [id, averageScores(rows)]));
}

// How much separate scorings of the same paper differ: mean absolute difference over every pair of
// scorings, in Fit (all fields) and Novelty, and how often a pair named the same best field. From
// the replicates when papers have more than one; otherwise from a legacy repeat sample.
export function scoreStability(scores, legacyRepeats = []) {
  const pairs = [];
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
  return {
    method,
    replicates: method === 'replicates' ? Math.max(...[...scores.values()].map(paper => paper.replicates)) : 2,
    items: papers.size,
    pairs: pairs.length,
    meanAbsFitDifference: mean(pairs.flatMap(([a, b]) => FIELD_IDS.map(field => Math.abs((a.fit[field]?.score ?? 0) - (b.fit[field]?.score ?? 0))))),
    meanAbsNoveltyDifference: mean(pairs.map(([a, b]) => Math.abs(a.novelty.score - b.novelty.score))),
    bestFieldAgreement: pairs.filter(([a, b]) => a.bestField === b.bestField).length / pairs.length,
    // Papers whose scorings did not all name the same best field (replicates only).
    bestFieldSplit: method === 'replicates' ? [...scores.values()].filter(paper => Object.keys(paper.bestFieldVotes).length > 1).length : null
  };
}
