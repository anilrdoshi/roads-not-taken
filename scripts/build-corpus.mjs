// Builds the comparison corpus: titles and abstracts of research articles published in the
// journals listed in config/fields.json, from OpenAlex, with Crossref filling missing abstracts.
// A work is left out if its title marks it as non-research, if its DOI is missing or not the
// journal's (OpenAlex sometimes files preprints and same-named journals under ours), if it has
// no abstract (book reviews and front matter), or if it comes from a split journal and its topic
// maps to none of the five fields. The manifest counts what each rule left out.
// Abstracts are not redistributed: corpus/records.jsonl is git-ignored, and reviewers rebuild it
// with this script. corpus/manifest.json and corpus/ids.txt record what was built so a rebuild
// can be compared with ours.
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hasAbstract, MIN_ABSTRACT_CHARS} from '../src/embeddings.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(root, 'config/fields.json'), 'utf8'));
const {fromYear, toYear} = config.corpusWindow;
const mailto = process.env.CORPUS_MAILTO || '';
const userAgent = `RoadsNotTaken/3.0 (research corpus builder${mailto ? `; mailto:${mailto}` : ''})`;
const NON_RESEARCH = /^(editorial|editor'?s (note|introduction)|erratum|errata|corrigendum|correction|retraction|expression of concern|call for papers|thank you|reviewer|acknowledg|in memoriam|obituary|book review|introduction to the special (issue|section)|announcement)/i;
// Applied after abstracts are filled: book reviews (a book's publication details or 'by' and its
// authors in the title) and front matter (award notices, lists of reviewers, editors' comments).
const FRONT_MATTER = /(meritorious service award|service awards?$|paper competition: abstracts|guest (associate )?editors|ad hoc reviewers|outside reviewers|publications received|^editor['’]s (comments|note)|introduction to a virtual special issue|^special issue introduction)/i;
const BOOK_REVIEW = /(University Press|\b\d{2,4} pages\b|\((Eds?|eds?)\.\)|[a-z]By [A-Z]|\b[Bb]y [A-Z][a-z]+[A-Z][a-z]|\bby [A-Z][a-z]+ [A-Z]\. ?[A-Z][a-z]+|, [Bb]y [A-Z][a-z]+ [A-Z])/;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stripTags = value => String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await fetch(url, {headers: {'User-Agent': userAgent}, signal: AbortSignal.timeout(60000)});
    } catch (error) {
      if (attempt >= 5) throw new Error(`${error.message} for ${url}`);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (response.ok) return response.json();
    if (attempt >= 5 || ![429, 500, 502, 503, 504].includes(response.status)) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    await sleep(1000 * 2 ** attempt);
  }
}

// Raw API responses are cached under corpus/cache/ (git-ignored) so an interrupted build resumes.
async function cachedJson(name, url) {
  const file = path.join(root, 'corpus/cache', `${name}.json`);
  try { return JSON.parse(await readFile(file, 'utf8')); } catch {}
  const value = await getJson(url);
  await mkdir(path.dirname(file), {recursive: true});
  await writeFile(file, JSON.stringify(value));
  await sleep(120);
  return value;
}

function abstractFromInvertedIndex(index) {
  if (!index) return '';
  const words = [];
  for (const [word, positions] of Object.entries(index)) for (const position of positions) words[position] = word;
  return words.filter(Boolean).join(' ');
}

// A split journal's work whose subfield is not mapped gets no field and is left out.
function fieldFor(journal, work) {
  if (journal.field !== 'split') return journal.field;
  const subfield = work.primary_topic?.subfield?.display_name || '';
  return config.subfieldToField[subfield] || null;
}

// Page-based paging works without an OpenAlex API key (cursor paging needs one) but stops at
// 10,000 results per query, so each year is queried separately.
async function openAlexWorks(journal) {
  const select = 'id,doi,title,publication_year,abstract_inverted_index,primary_topic,cited_by_count,primary_location';
  const keyParam = process.env.OPENALEX_API_KEY ? `&api_key=${encodeURIComponent(process.env.OPENALEX_API_KEY)}` : '';
  const works = [];
  for (let year = fromYear; year <= toYear; year++) {
    const filter = `primary_location.source.issn:${journal.issn.join('|')},publication_year:${year},type:article`;
    for (let page = 1; ; page++) {
      const url = `https://api.openalex.org/works?filter=${encodeURIComponent(filter)}&select=${select}&per-page=200&page=${page}${keyParam}`;
      const result = await cachedJson(`openalex-${journal.id}-${year}-p${page}`, url);
      works.push(...result.results);
      if (result.results.length < 200 || page * 200 >= result.meta.count) break;
    }
  }
  return works;
}

// Fills abstracts OpenAlex lacks, looking up the missing DOIs in small Crossref batches.
async function crossrefAbstracts(journal, dois) {
  const abstracts = new Map();
  for (let start = 0; start < dois.length; start += 40) {
    const batch = dois.slice(start, start + 40);
    const filter = batch.map(doi => `doi:${doi}`).join(',');
    const url = `https://api.crossref.org/works?filter=${encodeURIComponent(filter)}&select=DOI,abstract&rows=40`;
    let page;
    try { page = await cachedJson(`crossref-${journal.id}-${start / 40}`, url); } catch (error) { console.warn(`  Crossref lookup skipped: ${error.message}`); continue; }
    for (const item of page.message?.items || []) {
      if (item.DOI && item.abstract) abstracts.set(item.DOI.toLowerCase(), stripTags(item.abstract).replace(/^abstract\s+/i, ''));
    }
  }
  return abstracts;
}

const records = [];
const journalReport = [];
for (const journal of config.journals) {
  process.stdout.write(`${journal.id}... `);
  const works = await openAlexWorks(journal);
  const sourceNames = new Set(works.map(work => work.primary_location?.source?.display_name).filter(Boolean));
  const titled = works.filter(work => stripTags(work.title));
  let kept = works
    .map(work => ({
      id: work.doi ? `doi:${work.doi.replace(/^https?:\/\/doi\.org\//i, '').toLowerCase()}` : work.id,
      doi: work.doi ? work.doi.replace(/^https?:\/\/doi\.org\//i, '').toLowerCase() : '',
      openalexId: work.id,
      title: stripTags(work.title),
      abstract: stripTags(abstractFromInvertedIndex(work.abstract_inverted_index)),
      abstractSource: work.abstract_inverted_index ? 'openalex' : '',
      year: work.publication_year,
      journalId: journal.id,
      journal: journal.label,
      field: fieldFor(journal, work),
      subfield: work.primary_topic?.subfield?.display_name || '',
      citedBy: work.cited_by_count || 0
    }))
    .filter(record => record.title && !NON_RESEARCH.test(record.title));
  const missing = kept.filter(record => !record.abstract && record.doi).map(record => record.doi);
  if (missing.length) {
    const fill = await crossrefAbstracts(journal, missing);
    for (const record of kept) {
      if (!record.abstract && fill.has(record.doi)) { record.abstract = fill.get(record.doi); record.abstractSource = 'crossref'; }
    }
  }
  const nonResearch = titled.length - kept.length;
  const unique = new Map(kept.map(record => [record.id, record]));
  const duplicates = kept.length - unique.size;
  kept = [...unique.values()];
  // The exclusion rules, applied in order; each count is of works still in the corpus at that step.
  const excluded = {noTitle: works.length - titled.length, nonResearch, duplicates};
  const exclude = (name, keep) => { const before = kept.length; kept = kept.filter(keep); excluded[name] = before - kept.length; };
  exclude('reviewsAndFrontMatter', record => !FRONT_MATTER.test(record.title) && !BOOK_REVIEW.test(record.title));
  exclude('otherSource', record => journal.doiPrefixes.some(prefix => record.doi.startsWith(`${prefix}/`)));
  exclude('noAbstract', hasAbstract);
  exclude('noField', record => record.field);
  records.push(...kept);
  const report = {
    id: journal.id,
    label: journal.label,
    field: journal.field,
    openalexSourceNames: [...sourceNames],
    openalexWorks: works.length,
    excluded,
    records: kept.length,
    byField: Object.fromEntries(config.fields.map(field => [field.id, kept.filter(record => record.field === field.id).length])),
    abstractsFromCrossref: kept.filter(record => record.abstractSource === 'crossref').length
  };
  journalReport.push(report);
  console.log(`${journal.id.padEnd(17)} ${String(report.records).padStart(5)} kept of ${String(works.length).padStart(5)}; left out ${JSON.stringify(excluded)}  [${[...sourceNames].join('; ')}]`);
}

const byId = new Map(records.map(record => [record.id, record]));
const finalRecords = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
const fieldCounts = Object.fromEntries(config.fields.map(field => [field.id, finalRecords.filter(record => record.field === field.id).length]));
const excludedTotals = {};
for (const journal of journalReport) for (const [rule, n] of Object.entries(journal.excluded)) excludedTotals[rule] = (excludedTotals[rule] || 0) + n;
const ids = finalRecords.map(record => record.id);

await mkdir(path.join(root, 'corpus'), {recursive: true});
await writeFile(path.join(root, 'corpus/records.jsonl'), finalRecords.map(record => JSON.stringify(record)).join('\n') + '\n');
await writeFile(path.join(root, 'corpus/ids.txt'), ids.join('\n') + '\n');
const manifest = {
  version: `corpus-${fromYear}-${toYear}-v2`,
  builtAt: new Date().toISOString(),
  window: {fromYear, toYear},
  sources: ['OpenAlex works API (titles, abstracts, primary topics)', 'Crossref REST API (abstracts missing from OpenAlex)'],
  openalexWorks: journalReport.reduce((sum, journal) => sum + journal.openalexWorks, 0),
  excluded: excludedTotals,
  records: finalRecords.length,
  fieldCounts,
  idsSha256: createHash('sha256').update(ids.join('\n')).digest('hex'),
  journals: journalReport,
  notes: [
    'Works are left out, in this order, if: the title is missing or marks a non-research item (editorials, errata, retractions, calls for papers); the work repeats one already kept; the title marks a book review or front matter (award notices, lists of reviewers, editors\' comments); its DOI is missing or not under the journal\'s publisher prefixes (config/fields.json doiPrefixes), which drops preprint copies and same-named journals that OpenAlex filed under ours; it has no abstract of at least ' + MIN_ABSTRACT_CHARS + ' characters, which drops book reviews and front matter; or it comes from a split journal and its topic maps to none of the five fields.',
    'Multi-field journals are split by OpenAlex primary-topic subfield (config/fields.json splitRule); these topic labels are automated and imperfect.',
    'OpenAlex and Crossref change over time, so a later rebuild can differ slightly; compare corpus/ids.txt and idsSha256.'
  ]
};
await writeFile(path.join(root, 'corpus/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`\n${manifest.records} records kept of ${manifest.openalexWorks}; left out ${JSON.stringify(excludedTotals)}. Fields: ${JSON.stringify(fieldCounts)}`);
