// Writes the explorer as one self-contained HTML file for the focal papers named, with its styles,
// code and data inline, so it opens straight from disk with no server, or can be hosted as a single
// file. It reads the bundles in ui/data/ (npm run build-explorer makes them).
// --anonymize shows each focal paper under its label instead of its title, leaves out its authors
// and journal, and renames its case after the label. It then searches the page for the title, the
// journal, the authors' surnames and the old case name, and writes nothing if any is still there.
// Usage: npm run export-explorer -- --case my-paper[=Label] [--case another[=Label]] [--anonymize] --out explorer.html
import {parseArgs} from 'node:util';
import {readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {ROOT} from '../src/config.js';

const UI = path.join(ROOT, 'ui');
const {values} = parseArgs({options: {
  case: {type: 'string', multiple: true},
  anonymize: {type: 'boolean', default: false},
  out: {type: 'string'}
}});
const fail = message => { console.error(message); process.exit(1); };
if (!values.case?.length || !values.out) fail('Usage: npm run export-explorer -- --case <case>[=<label>] [--case ...] [--anonymize] --out <file.html>');

const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const yearOnly = year => String(year ?? '').match(/\b(?:19|20)\d{2}\b/)?.[0] || null;
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Extractions record what a document does not state as "Not stated (...)"; there is nothing to hide.
const stated = value => typeof value === 'string' && value.trim().length >= 3 && !/^not stated|anonymi[sz]ed/i.test(value.trim());

// Replaces the focal paper's identity with its label and returns any identifying text left in it.
function anonymize(bundle, label) {
  const {identity} = bundle.paper;
  // The title, and its main part when it has a subtitle.
  const mainTitle = identity.title?.includes(':') ? identity.title.slice(0, identity.title.indexOf(':')) : null;
  const hidden = [identity.title, mainTitle, identity.journal, ...(identity.authors || []).filter(stated).map(name => name.split(/\s+/).pop().replace(/[^\p{L}'-]/gu, '')), bundle.caseId]
    .filter(stated);
  bundle.caseId = slug(label);
  bundle.paper.identity = {title: label, authors: [], year: yearOnly(identity.year)};
  const text = JSON.stringify(bundle);
  return hidden.flatMap(term => {
    const matches = [...text.matchAll(new RegExp(`(?<![\\p{L}\\d])${escapeRegex(term)}(?![\\p{L}\\d])`, 'giu'))];
    return matches.length ? [{label, term, count: matches.length, context: text.slice(Math.max(0, matches[0].index - 60), matches[0].index + term.length + 60)}] : [];
  });
}

const data = {}, cases = [], leftovers = [];
for (const spec of values.case) {
  const [caseId, label] = spec.includes('=') ? [spec.slice(0, spec.indexOf('=')), spec.slice(spec.indexOf('=') + 1).trim()] : [spec, null];
  const file = path.join(UI, 'data', `${caseId}.json`);
  if (!existsSync(file)) fail(`No explorer data for ${caseId}. Run npm run build-explorer first.`);
  const bundle = JSON.parse(await readFile(file, 'utf8'));
  if (values.anonymize) {
    if (!label) fail('--anonymize needs a label for every case: --case <case>=<label>.');
    leftovers.push(...anonymize(bundle, label));
  } else if (label) bundle.paper.identity = {...bundle.paper.identity, title: label};
  if (data[`${bundle.caseId}.json`]) fail(`Two cases would both be called ${bundle.caseId}.`);
  data[`${bundle.caseId}.json`] = bundle;
  const {title, authors, year} = bundle.paper.identity;
  cases.push({id: bundle.caseId, title, authors, year, versionNote: bundle.paper.versionNote, pilot: bundle.pilot, alternatives: bundle.alternatives.length});
}
if (leftovers.length) {
  for (const {label, term, count, context} of leftovers) console.error(`${label}: "${term}" still appears ${count} time(s), e.g. …${context}…`);
  fail('Nothing written. These come from the extraction or the AI alternatives; remove them from the run before exporting.');
}
data['cases.json'] = {cases};

// The explorer's modules (dom.js, charts.js, app.js), each in its own scope, in one inline script.
async function inlineModules() {
  const parts = [];
  for (const name of ['dom', 'charts', 'app']) {
    let code = await readFile(path.join(UI, `${name}.js`), 'utf8');
    const imports = [];
    code = code.replace(/^import\s*\{([^}]*)\}\s*from\s*'\.\/(\w+)\.js';[ \t]*$/gm, (_, names, from) => { imports.push(`const {${names.trim()}} = module_${from};`); return ''; });
    const exported = [...code.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)].map(match => match[1]);
    code = code.replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|class)\b)/gm, '');
    if (/^\s*(?:import|export)\b/m.test(code)) throw new Error(`ui/${name}.js has an import or export this command cannot inline.`);
    parts.push(`const module_${name} = (() => {\n${imports.join('\n')}\n${code}\nreturn {${exported.join(', ')}};\n})();`);
  }
  return parts.join('\n');
}

let html = await readFile(path.join(UI, 'index.html'), 'utf8');
const replaceOnce = (from, to) => {
  if (!html.includes(from)) throw new Error(`ui/index.html no longer contains ${from}; update scripts/export-explorer.mjs.`);
  html = html.replace(from, () => to);
};
replaceOnce('<link rel="stylesheet" href="styles.css">', `<style>\n${await readFile(path.join(UI, 'styles.css'), 'utf8')}</style>`);
replaceOnce('href="favicon.svg"', `href="data:image/svg+xml;base64,${(await readFile(path.join(UI, 'favicon.svg'))).toString('base64')}"`);
// Escaping "<" keeps the data from ending its script element early.
const json = JSON.stringify(data).replace(/</g, '\\u003c');
const code = (await inlineModules()).replace(/<\/script/gi, '<\\/script');
replaceOnce('<script type="module" src="app.js"></script>', `<script type="application/json" id="explorer-data">${json}</script>\n<script type="module">\n${code}\n</script>`);
await writeFile(values.out, html);
console.log(`Wrote ${values.out} (${(Buffer.byteLength(html) / 1e6).toFixed(1)} MB): ${cases.map(c => `${c.title} (${c.id})`).join(', ')}.`);
