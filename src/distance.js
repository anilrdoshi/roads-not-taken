// Distance: measures from text embeddings (cosine distance), with no model judgement. They are
// kept apart from Claude's Novelty and Fit and named so they cannot be mistaken for them:
// 1. distance from the original: how far each alternative's text moved from the original's;
// 2. distance from published work: a paper's mean distance to its nearest published articles in
//    each field, and that distance as a percentile of published articles' own distances to their
//    nearest neighbours in the field;
// 3. neighbour fields: which of the five fields a paper's nearest published articles come from.
// Writes distance.json next to the run's other outputs. Makes no model calls.
import {readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {FIELD_IDS} from './config.js';
import {comparisonYear, loadExtraction, readJsonl} from './pipeline.js';
import {originalAsPaper} from './prompts.js';
import {embeddingText} from './embeddings.js';
import {loadOriginalAbstract} from './original-abstract.js';

// The seed keeps its original name so the reference sample, and so every percentile, is unchanged.
export const DISTANCE = {neighbours: 10, fieldNeighbours: 20, referenceSample: 1000, seed: 'similarity-reference-v1'};
const GROUPS = [...FIELD_IDS, 'all'];
const round = (value, places = 4) => Math.round(value * 10 ** places) / 10 ** places;
const meanDistance = hits => hits.reduce((sum, hit) => sum + (1 - hit.similarity), 0) / hits.length;

// Share of the sorted reference values below the value (ties count half), as a percentile.
export function percentile(sorted, value) {
  let below = 0, equal = 0;
  for (const v of sorted) { if (v < value) below++; else if (v === value) equal++; }
  return round(100 * (below + equal / 2) / sorted.length, 1);
}

export async function computeDistance({caseDir, testDir, corpus, embedder, settings = DISTANCE, log = console.log}) {
  if (!corpus.vectors) throw new Error('The corpus embeddings are missing. Run `npm run build-embeddings` first.');
  if (embedder.model !== corpus.embedding.model) throw new Error(`The corpus was embedded with ${corpus.embedding.model}, not ${embedder.model}.`);
  const record = await loadExtraction(caseDir);
  if (!record) throw new Error('Extract the focal paper first (npm run extract).');
  const alternatives = await readJsonl(path.join(testDir, 'alternatives.jsonl'));
  // The original is embedded from its own abstract when one is saved, otherwise from the
  // extraction's third-person paraphrase.
  const ownAbstract = await loadOriginalAbstract(caseDir);
  const original = {...originalAsPaper(record.extraction), ...(ownAbstract ? {abstract: ownAbstract} : {})};
  const papers = [{id: 'original', paper: original}, ...alternatives.map(alt => ({id: alt.id, paper: alt.outline}))];
  const maxYear = comparisonYear(record.extraction);
  const {neighbours, fieldNeighbours} = settings;

  // Published articles with abstracts, up to the original paper's year.
  const pool = corpus.records.map((r, index) => index).filter(index => corpus.embedded[index] && (!maxYear || corpus.records[index].year <= maxYear));
  const fieldOf = index => corpus.records[index].field;
  const baseShares = Object.fromEntries(FIELD_IDS.map(group => [group, round(pool.filter(index => fieldOf(index) === group).length / pool.length)]));
  const row = index => corpus.vectors.subarray(index * corpus.dims, (index + 1) * corpus.dims);
  const within = group => group === 'all' ? undefined : group;

  // Reference distribution per field: each sampled article's mean distance to its nearest other articles in the field.
  const reference = {};
  for (const group of GROUPS) {
    const members = pool.filter(index => group === 'all' || corpus.records[index].field === group);
    const sample = members
      .map(index => ({index, key: createHash('sha256').update(settings.seed + corpus.records[index].id).digest('hex')}))
      .sort((a, b) => a.key.localeCompare(b.key)).slice(0, settings.referenceSample);
    reference[group] = sample.map(({index}) => meanDistance(corpus.nearest(row(index), {field: within(group), maxYear, limit: neighbours, exclude: index}))).sort((a, b) => a - b);
    log(`distance: reference for ${group} from ${sample.length} of ${members.length} articles`);
  }

  const vectors = await embedder.embed(papers.map(p => embeddingText(p.paper)));
  const originalVector = vectors[0];
  const measures = {};
  papers.forEach(({id}, i) => {
    const vector = vectors[i];
    const toPublished = {}, toPublishedPercentile = {};
    for (const group of GROUPS) {
      const mean = meanDistance(corpus.nearest(vector, {field: within(group), maxYear, limit: neighbours}));
      toPublished[group] = round(mean);
      toPublishedPercentile[group] = percentile(reference[group], mean);
    }
    const closest = corpus.nearest(vector, {maxYear, limit: fieldNeighbours});
    const neighbourFields = Object.fromEntries(FIELD_IDS.map(group => [group, round(closest.filter(hit => fieldOf(hit.index) === group).length / closest.length)]));
    // The field most over-represented among the nearest articles, relative to its share of the corpus.
    const lift = field => neighbourFields[field] / baseShares[field];
    const topNeighbourField = FIELD_IDS.reduce((best, field) => lift(field) > lift(best) ? field : best);
    let cosine = 0;
    for (let d = 0; d < vector.length; d++) cosine += vector[d] * originalVector[d];
    measures[id] = {
      fromOriginal: id === 'original' ? 0 : round(1 - cosine),
      toPublished, toPublishedPercentile, neighbourFields, topNeighbourField,
      nearest: closest.slice(0, 5).map(hit => ({id: hit.record.id, field: hit.record.field, distance: round(1 - hit.similarity)}))
    };
  });

  const result = {
    builtAt: new Date().toISOString(),
    model: corpus.embedding.model, dtype: corpus.embedding.dtype,
    corpusMaxYear: maxYear || null, corpusArticles: pool.length,
    originalAbstract: ownAbstract ? 'own' : 'paraphrase',
    settings, baseShares,
    referenceMedian: Object.fromEntries(GROUPS.map(group => [group, round(reference[group][Math.floor(reference[group].length / 2)])])),
    papers: measures
  };
  await writeFile(path.join(testDir, 'distance.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

export async function loadDistance(testDir) {
  const file = path.join(testDir, 'distance.json');
  return existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : null;
}

// Spearman rank correlation (ties get average ranks).
export function spearman(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const ranks = values => {
    const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(n);
    for (let i = 0; i < n;) {
      let j = i;
      while (j + 1 < n && order[j + 1][0] === order[i][0]) j++;
      for (let k = i; k <= j; k++) r[order[k][1]] = (i + j) / 2 + 1;
      i = j + 1;
    }
    return r;
  };
  const a = ranks(xs), b = ranks(ys), mean = (n + 1) / 2;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - mean) * (b[i] - mean); da += (a[i] - mean) ** 2; db += (b[i] - mean) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : null;
}
