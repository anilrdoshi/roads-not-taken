// Retrieval over the comparison corpus, filtered by field and year: BM25 on titles and abstracts,
// fused with embedding similarity when the corpus embeddings have been built (hybrid retrieval).
import {readFileSync, existsSync} from 'node:fs';
import path from 'node:path';
import {ROOT} from './config.js';
import {dot, hasAbstract, loadCorpusVectors} from './embeddings.js';

// Reciprocal rank fusion: each list adds 1 / (K + rank); K = 60 is the usual constant. Each list
// contributes its top POOL candidates.
const RRF_K = 60, POOL = 50;

const STOP = new Set(('a an and are as at be been between both but by can could do does for from had has have how however if in into is it its may more most not of on or our over such than that the their them then there these they this those through to under use used using was we were what when where whether which while who why will with within would ' +
  'study studies paper research findings results show shows find suggest article analysis effect effects evidence data based').split(' '));

export function tokenize(text) {
  return (String(text || '').toLowerCase().match(/[a-z][a-z0-9-]+/g) || []).filter(token => token.length > 2 && !STOP.has(token));
}

export class Corpus {
  constructor(records) {
    this.records = records;
    this.docs = records.map(record => {
      const tokens = tokenize(`${record.title} ${record.title} ${record.abstract}`);
      const tf = new Map();
      for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
      return {record, tf, length: tokens.length || 1};
    });
    this.df = new Map();
    for (const doc of this.docs) for (const token of doc.tf.keys()) this.df.set(token, (this.df.get(token) || 0) + 1);
    this.avgLength = this.docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(this.docs.length, 1);
  }

  static load(file = path.join(ROOT, 'corpus/records.jsonl'), {vectors = true} = {}) {
    if (!existsSync(file)) throw new Error('The comparison corpus is missing. Run `npm run build-corpus` first.');
    const records = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    const corpus = new Corpus(records);
    return vectors ? corpus.attachVectors(loadCorpusVectors(records)) : corpus;
  }

  // Adds the corpus embeddings ({meta, dims, matrix}, rows in record order). Only records with an
  // abstract take part in embedding retrieval and nearest().
  attachVectors(store) {
    if (!store) return this;
    this.vectors = store.matrix;
    this.dims = store.dims;
    this.embedding = store.meta;
    this.embedded = this.records.map(hasAbstract);
    return this;
  }

  get retrieval() {
    return this.vectors ? 'hybrid' : 'bm25';
  }

  // The records most similar to a unit-length vector (cosine similarity), best first.
  nearest(vector, {field, maxYear, limit = 10, exclude = -1} = {}) {
    if (!this.vectors) throw new Error('The corpus embeddings are missing. Run `npm run build-embeddings` first.');
    const top = [];
    for (let index = 0; index < this.records.length; index++) {
      const record = this.records[index];
      if (!this.embedded[index] || index === exclude) continue;
      if (field && record.field !== field) continue;
      if (maxYear && record.year > maxYear) continue;
      const similarity = dot(vector, this.vectors, index * this.dims);
      if (top.length === limit && similarity <= top[limit - 1].similarity) continue;
      let at = top.length;
      while (at > 0 && top[at - 1].similarity < similarity) at--;
      top.splice(at, 0, {index, record, similarity});
      if (top.length > limit) top.pop();
    }
    return top;
  }

  get(id) {
    return this.records.find(record => record.id === id);
  }

  // With a query vector and corpus embeddings, keyword and embedding rankings are fused;
  // otherwise this is plain BM25.
  search(query, {field, maxYear, limit = 6, vector} = {}) {
    const keyword = this.keywordSearch(query, {field, maxYear});
    if (!vector || !this.vectors) return keyword.slice(0, limit);
    const fused = new Map();
    const add = (record, rank, key) => {
      const hit = fused.get(record.id) || {record, score: 0, keywordRank: null, embeddingRank: null};
      hit.score += 1 / (RRF_K + rank);
      hit[key] = rank;
      fused.set(record.id, hit);
    };
    keyword.slice(0, POOL).forEach((hit, i) => add(hit.record, i + 1, 'keywordRank'));
    this.nearest(vector, {field, maxYear, limit: POOL}).forEach((hit, i) => add(hit.record, i + 1, 'embeddingRank'));
    return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  keywordSearch(query, {field, maxYear} = {}) {
    const terms = [...new Set(tokenize(query))];
    const total = this.docs.length;
    const k1 = 1.2, b = 0.75;
    const scored = [];
    for (const doc of this.docs) {
      if (field && doc.record.field !== field) continue;
      if (maxYear && doc.record.year > maxYear) continue;
      let score = 0;
      for (const term of terms) {
        const freq = doc.tf.get(term);
        if (!freq) continue;
        const df = this.df.get(term) || 0;
        const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
        score += idf * (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * doc.length / this.avgLength));
      }
      if (score > 0) scored.push({record: doc.record, score});
    }
    return scored.sort((a, b) => b.score - a.score);
  }
}
