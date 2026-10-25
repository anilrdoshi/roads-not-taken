// Sentence embeddings for the comparison corpus and for each paper idea, computed locally with an
// open-weights model (no API key, nothing leaves the machine). The corpus is embedded once by
// scripts/build-embeddings.mjs; papers are embedded when a run is scored or measured.
import {readFileSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {ROOT} from './config.js';

// Changing any of these means re-embedding the corpus: corpus and paper vectors must come from the same model.
export const EMBEDDING = {model: 'Xenova/bge-base-en-v1.5', dtype: 'fp32', pooling: 'cls', dims: 768};
export const VECTORS_FILE = path.join(ROOT, 'corpus/embeddings.bin');
export const VECTORS_META = path.join(ROOT, 'corpus/embeddings.json');

// The corpus build leaves out records with shorter abstracts (most have none), so every published
// paper takes part in embedding retrieval and Distance, which compare abstract with abstract.
export const MIN_ABSTRACT_CHARS = 100;
export const hasAbstract = record => String(record.abstract || '').length >= MIN_ABSTRACT_CHARS;

// Publisher boilerplate (structured-abstract labels, funding and supplement notes, copyright lines)
// marks the journal rather than the idea, so it would pull papers together by publisher.
const LABELS = /\b(?:research summary|managerial summary|problem definition|academic\/practical relevance|methodology\/results|managerial implications)\b\s*:?|\b(?:methodology|results)\s*:/gi;
const TAIL = /\s(?:This paper was accepted by\s|(?:Funding|Funded|Conflict of Interest Statement|Supplemental Material|History|Data Ethics & Reproducibility Note)\s*:).*$/s;
const NOTES = /(?:The online appendix is available at|Data (?:and code )?(?:are|is) available at)[^]*?(?:\s\.|\.(?=\s|$))|\(PsycINFO.*$|This article is protected by copyright.*$|(?:Copyright )?©.*$/gis;

export function cleanAbstract(text) {
  return String(text || '').replace(/^\s*abstract\b\s*:?/i, '').replace(TAIL, '').replace(NOTES, '').replace(LABELS, ' ').replace(/\s+/g, ' ').trim();
}

// The same text for corpus records and paper ideas: title and abstract.
export const embeddingText = item => `${String(item.title || '').trim()}. ${cleanAbstract(item.abstract)}`.trim();

export const idsHash = records => createHash('sha256').update(records.map(record => record.id).join('\n')).digest('hex');

export class Embedder {
  constructor({model = EMBEDDING.model, dtype = EMBEDDING.dtype, pooling = EMBEDDING.pooling, batchSize = 16} = {}) {
    Object.assign(this, {model, dtype, pooling, batchSize});
  }

  async init() {
    // Loaded on demand so the explorer, reports and tests never need the model runtime.
    const {pipeline, env} = await import('@huggingface/transformers');
    env.cacheDir = path.join(ROOT, '.models');
    this.extractor = await pipeline('feature-extraction', this.model, {dtype: this.dtype, session_options: {intraOpNumThreads: os.availableParallelism()}});
    return this;
  }

  // Unit-length vectors in input order. Calls run one at a time (scoring calls arrive concurrently).
  embed(texts) {
    const run = (this.queue || Promise.resolve()).then(() => this.embedNow(texts));
    this.queue = run.catch(() => {});
    return run;
  }

  // Texts are batched by length so little time goes on padding.
  async embedNow(texts) {
    const order = texts.map((text, index) => index).sort((a, b) => texts[a].length - texts[b].length);
    const vectors = new Array(texts.length);
    for (let start = 0; start < order.length; start += this.batchSize) {
      const batch = order.slice(start, start + this.batchSize);
      const output = await this.extractor(batch.map(index => texts[index]), {pooling: this.pooling, normalize: true});
      const dims = output.dims[1];
      batch.forEach((index, row) => { vectors[index] = Float32Array.from(output.data.subarray(row * dims, (row + 1) * dims)); });
    }
    return vectors;
  }
}

// The corpus vectors, one row per record in records.jsonl order, or null if they have not been built.
export function loadCorpusVectors(records) {
  if (!existsSync(VECTORS_FILE) || !existsSync(VECTORS_META)) return null;
  const meta = JSON.parse(readFileSync(VECTORS_META, 'utf8'));
  if (meta.count !== records.length || meta.idsSha256 !== idsHash(records)) {
    throw new Error('The corpus embeddings were built from a different corpus. Run `npm run build-embeddings` again.');
  }
  const bytes = readFileSync(VECTORS_FILE);
  if (bytes.length !== meta.count * meta.dims * 4) throw new Error('corpus/embeddings.bin is incomplete. Run `npm run build-embeddings` again.');
  return {meta, dims: meta.dims, matrix: new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4)};
}

export function dot(a, b, offset = 0) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[offset + i];
  return sum;
}
