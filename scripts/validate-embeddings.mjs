// Checks the corpus embeddings against signals that involve no model judgement, and compares them
// with BM25 (keyword retrieval, used for scoring before embeddings) and with chance:
// 1. Citations. For a sample of corpus articles, where do the corpus articles they cite (from
//    OpenAlex reference lists) rank among all earlier corpus articles?
// 2. Labels. Do an article's 10 nearest neighbours come from its journal, field and OpenAlex subfield?
// Writes corpus/embedding-validation.json and .md. Fetches reference lists from OpenAlex once
// (cached in corpus/cache/; --fetch-only stops after that). Usage: npm run validate-embeddings [-- --citing 600 --labels 2000]
import {parseArgs} from 'node:util';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {ROOT, fieldsConfig} from '../src/config.js';
import {Corpus} from '../src/corpus.js';
import {dot, embeddingText, hasAbstract} from '../src/embeddings.js';

const {values} = parseArgs({options: {citing: {type: 'string', default: '600'}, labels: {type: 'string', default: '2000'}, 'fetch-only': {type: 'boolean', default: false}}});
const corpus = Corpus.load();
if (!corpus.vectors && !values['fetch-only']) throw new Error('The corpus embeddings are missing. Run `npm run build-embeddings` first.');
const {records, dims} = corpus;
const pool = records.map((r, i) => i).filter(i => hasAbstract(records[i]));
const row = i => corpus.vectors.subarray(i * dims, (i + 1) * dims);
const seeded = (indices, seed) => indices.map(i => ({i, key: createHash('sha256').update(seed + records[i].id).digest('hex')})).sort((a, b) => a.key.localeCompare(b.key)).map(x => x.i);
// The BM25 query is the same cleaned text the embeddings see: raw abstracts carry publisher
// boilerplate that would match other articles from the same journal, which scoring queries
// (generated outlines) never do.
const queryText = embeddingText;
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

// BM25 over the candidates: keywordSearch returns records; map them back to indices once.
const indexOf = new Map(records.map((r, i) => [r.id, i]));
function bm25Ranking(q, candidateSet) {
  const ranked = corpus.keywordSearch(queryText(records[q])).map(hit => indexOf.get(hit.record.id)).filter(i => candidateSet.has(i));
  const seen = new Set(ranked);
  // Candidates sharing no terms with the query tie at the bottom, in corpus order.
  return {ranked, unranked: [...candidateSet].filter(i => !seen.has(i))};
}
function embeddingRanking(q, candidates) {
  const v = row(q);
  return candidates.map(i => [i, dot(v, corpus.vectors, i * dims)]).sort((a, b) => b[1] - a[1]).map(x => x[0]);
}
// Reciprocal rank fusion of the two full rankings, as in Corpus.search (K = 60).
function hybridRanking(embedding, bm25) {
  const score = new Map();
  embedding.forEach((i, r) => score.set(i, 1 / (61 + r)));
  bm25.ranked.forEach((i, r) => score.set(i, (score.get(i) || 0) + 1 / (61 + r)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]);
}
// Rank (1-based) of each target; BM25's unranked tail shares the average of its ranks.
function ranksOf(targets, ranked, unrankedCount = 0) {
  const position = new Map(ranked.map((i, r) => [i, r + 1]));
  const tail = ranked.length + (unrankedCount + 1) / 2;
  return targets.map(t => position.get(t) ?? tail);
}

// ---------- 1. Citations ----------
const citingPool = pool.filter(i => records[i].year >= 2019 && records[i].openalexId);
const citing = seeded(citingPool, 'validate-citing-v1').slice(0, Number(values.citing));
const cacheFile = path.join(ROOT, 'corpus/cache/openalex-references.json');
const references = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
const shortId = url => url.replace('https://openalex.org/', '');
const missing = citing.map(i => shortId(records[i].openalexId)).filter(id => !references[id]);
const keyParam = process.env.OPENALEX_API_KEY ? `&api_key=${encodeURIComponent(process.env.OPENALEX_API_KEY)}` : '';
for (let start = 0; start < missing.length; start += 50) {
  const batch = missing.slice(start, start + 50);
  const url = `https://api.openalex.org/works?filter=openalex:${batch.join('|')}&select=id,referenced_works&per-page=50${keyParam}`;
  const response = await fetch(url, {headers: {'User-Agent': 'RoadsNotTaken/3.0 (embedding validation)'}, signal: AbortSignal.timeout(60000)});
  if (!response.ok) throw new Error(`HTTP ${response.status} from OpenAlex`);
  for (const work of (await response.json()).results) references[shortId(work.id)] = work.referenced_works.map(shortId);
  for (const id of batch) references[id] ||= [];
  console.log(`references: ${Math.min(start + 50, missing.length)} / ${missing.length} fetched`);
}
writeFileSync(cacheFile, JSON.stringify(references));
if (values['fetch-only']) process.exit(0);

const byOpenalex = new Map(pool.map(i => [shortId(records[i].openalexId || ''), i]));
const methods = ['embedding', 'bm25', 'hybrid'];
const citationRows = [];
for (const q of citing) {
  const year = records[q].year;
  const targets = (references[shortId(records[q].openalexId)] || []).map(id => byOpenalex.get(id)).filter(i => i != null && i !== q && records[i].year <= year);
  if (!targets.length) continue;
  const candidates = pool.filter(i => i !== q && records[i].year <= year);
  const embedding = embeddingRanking(q, candidates);
  const bm25 = bm25Ranking(q, new Set(candidates));
  const hybrid = hybridRanking(embedding, bm25);
  const ranks = {
    embedding: ranksOf(targets, embedding),
    bm25: ranksOf(targets, bm25.ranked, bm25.unranked.length),
    hybrid: ranksOf(targets, hybrid)
  };
  citationRows.push({q, n: candidates.length, targets: targets.length, ranks});
}
const recallAt = (rows, method, k) => mean(rows.map(r => r.ranks[method].filter(rank => rank <= k).length / r.targets));
const citation = {
  citingSampled: citing.length, citingWithCorpusReferences: citationRows.length,
  citedPairs: citationRows.reduce((a, r) => a + r.targets, 0), meanCandidates: Math.round(mean(citationRows.map(r => r.n))),
  methods: Object.fromEntries(methods.map(m => [m, {
    recallAt10: recallAt(citationRows, m, 10),
    recallAt50: recallAt(citationRows, m, 50),
    mrr: mean(citationRows.map(r => 1 / Math.min(...r.ranks[m]))),
    medianPercentileRank: median(citationRows.flatMap(r => r.ranks[m].map(rank => 100 * rank / r.n)))
  }])),
  chance: {recallAt10: mean(citationRows.map(r => 10 / r.n)), recallAt50: mean(citationRows.map(r => 50 / r.n)), medianPercentileRank: 50}
};
console.log('citations done', JSON.stringify(citation.methods));

// ---------- 2. Labels ----------
const labelSample = seeded(pool, 'validate-labels-v1').slice(0, Number(values.labels));
const LABELS = ['journal', 'field', 'subfield'];
const splitJournals = fieldsConfig.journals.filter(journal => journal.field === 'split').length;
const share = (q, neighbours, label) => neighbours.filter(i => records[i][label] && records[i][label] === records[q][label]).length / neighbours.length;
const labelTotals = Object.fromEntries(['embedding', 'bm25'].map(m => [m, Object.fromEntries(LABELS.map(l => [l, []]))]));
const allPool = new Set(pool);
for (const q of labelSample) {
  const top = {
    embedding: corpus.nearest(row(q), {limit: 10, exclude: q}).map(hit => hit.index),
    bm25: bm25Ranking(q, allPool).ranked.filter(i => i !== q).slice(0, 10)
  };
  for (const m of ['embedding', 'bm25']) for (const l of LABELS) labelTotals[m][l].push(share(q, top[m], l));
}
// Chance: the probability that a random other article shares the label.
const chance = Object.fromEntries(LABELS.map(l => {
  const counts = {};
  for (const i of pool) if (records[i][l]) counts[records[i][l]] = (counts[records[i][l]] || 0) + 1;
  return [l, Object.values(counts).reduce((a, c) => a + c * c, 0) / pool.length ** 2];
}));
const labels = {
  sampled: labelSample.length,
  methods: Object.fromEntries(['embedding', 'bm25'].map(m => [m, Object.fromEntries(LABELS.map(l => [l, mean(labelTotals[m][l])]))])),
  chance
};

const result = {builtAt: new Date().toISOString(), model: corpus.embedding.model, articles: pool.length, citation, labels};
writeFileSync(path.join(ROOT, 'corpus/embedding-validation.json'), JSON.stringify(result, null, 2) + '\n');
const pct = x => `${(100 * x).toFixed(1)}%`;
const label = {embedding: `Embeddings (${corpus.embedding.model.split('/').pop()})`, bm25: 'BM25 (keywords)', hybrid: 'Hybrid (both, rank-fused)'};
writeFileSync(path.join(ROOT, 'corpus/embedding-validation.md'), `# Embedding validation

${result.model}, ${pool.length.toLocaleString()} corpus articles with abstracts. Built ${result.builtAt.slice(0, 10)} by \`npm run validate-embeddings\`. No model judgement is involved.

## 1. Do articles sit close to the articles they cite?
${citation.citingWithCorpusReferences} sampled articles (2019 on) cite at least one earlier corpus article; ${citation.citedPairs} citing-cited pairs in all, from OpenAlex reference lists. Each article's title and abstract (boilerplate removed) is the query for every method; candidates are all earlier corpus articles (about ${citation.meanCandidates.toLocaleString()} each). Recall@k is the share of an article's cited corpus articles that rank in the top k.

| Method | Recall@10 | Recall@50 | MRR | Median rank of a cited article (percentile, 0 = top) |
|---|---|---|---|---|
${methods.map(m => `| ${label[m]} | ${pct(citation.methods[m].recallAt10)} | ${pct(citation.methods[m].recallAt50)} | ${citation.methods[m].mrr.toFixed(3)} | ${citation.methods[m].medianPercentileRank.toFixed(2)} |`).join('\n')}
| Chance | ${pct(citation.chance.recallAt10)} | ${pct(citation.chance.recallAt50)} | – | 50 |

## 2. Do nearest neighbours share an article's journal, field and topic?
For ${labels.sampled.toLocaleString()} sampled articles, the share of its 10 nearest articles (whole corpus) with the same label. Fields are this project's assignment (whole journals, or OpenAlex topics for the ${splitJournals} split journals); subfields are OpenAlex's.

| Method | Same journal | Same field | Same OpenAlex subfield |
|---|---|---|---|
${['embedding', 'bm25'].map(m => `| ${label[m]} | ${LABELS.map(l => pct(labels.methods[m][l])).join(' | ')} |`).join('\n')}
| Chance | ${LABELS.map(l => pct(chance[l])).join(' | ')} |
`);
console.log('Wrote corpus/embedding-validation.md');
