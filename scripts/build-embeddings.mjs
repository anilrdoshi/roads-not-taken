// Embeds every corpus record once (title and cleaned abstract) with a local open-weights model.
// Writes corpus/embeddings.bin (float32, one row per record in records.jsonl order) and
// corpus/embeddings.json (model and checks). About 40 minutes on a laptop CPU; the first run
// also downloads the model (about 420 MB) into .models/. Re-running resumes where it stopped.
// Usage: npm run build-embeddings [-- --fresh]
import {parseArgs} from 'node:util';
import {existsSync, statSync, truncateSync, appendFileSync, renameSync, writeFileSync, rmSync} from 'node:fs';
import path from 'node:path';
import {Corpus} from '../src/corpus.js';
import {EMBEDDING, Embedder, VECTORS_FILE, VECTORS_META, embeddingText, hasAbstract, idsHash} from '../src/embeddings.js';

const {values} = parseArgs({options: {fresh: {type: 'boolean', default: false}}});
const {records} = Corpus.load(undefined, {vectors: false});
const partial = `${VECTORS_FILE}.partial`;
const rowBytes = EMBEDDING.dims * 4;
if (values.fresh) rmSync(partial, {force: true});

// Resume from the last whole row written.
let done = existsSync(partial) ? Math.floor(statSync(partial).size / rowBytes) : 0;
if (existsSync(partial)) truncateSync(partial, done * rowBytes);
console.log(`${records.length} records; ${done} already embedded. Loading ${EMBEDDING.model} (${EMBEDDING.dtype})...`);
const embedder = await new Embedder().init();

const started = Date.now(), resumedAt = done, chunk = 512;
for (let start = done; start < records.length; start += chunk) {
  const slice = records.slice(start, start + chunk);
  const vectors = await embedder.embed(slice.map(embeddingText));
  if (vectors.some(v => v.length !== EMBEDDING.dims)) throw new Error(`Expected ${EMBEDDING.dims}-dimensional vectors.`);
  const block = new Float32Array(slice.length * EMBEDDING.dims);
  vectors.forEach((v, i) => block.set(v, i * EMBEDDING.dims));
  appendFileSync(partial, Buffer.from(block.buffer));
  done = start + slice.length;
  const perSecond = (done - resumedAt) / ((Date.now() - started) / 1000);
  console.log(`${done} / ${records.length} (${perSecond.toFixed(1)} per second, about ${Math.ceil((records.length - done) / perSecond / 60)} min left)`);
}

renameSync(partial, VECTORS_FILE);
const meta = {
  ...EMBEDDING,
  text: 'title + ". " + abstract, with publisher boilerplate removed (src/embeddings.js cleanAbstract)',
  count: records.length,
  withAbstract: records.filter(hasAbstract).length,
  idsSha256: idsHash(records),
  builtAt: new Date().toISOString()
};
writeFileSync(VECTORS_META, JSON.stringify(meta, null, 2) + '\n');
console.log(`Done: ${path.relative(process.cwd(), VECTORS_FILE)} (${records.length} x ${EMBEDDING.dims}).`);
