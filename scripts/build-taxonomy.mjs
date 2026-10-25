// Builds config/taxonomy.json (topic and method codes used to tag papers) from the AMJ
// submission keyword list in config/source/amj_keywords_cleaned.txt. Theories live in
// config/theories.json, which covers all 46 AMJ theoretical perspectives.
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceFile = path.join(root, 'config/source/amj_keywords_cleaned.txt');
const outFile = path.join(root, 'config/taxonomy.json');

// The scraped list promotes "Organizational culture & climate", one subtopic of
// Organization and Management Theory, to a topic area and files the remaining OMT
// subtopics under it. Put them back under OMT.
const MISFILED = 'Organizational culture & climate';
const OMT = 'Organization and Management Theory';

const lines = (await readFile(sourceFile, 'utf8')).split('\n').map(line => line.trim()).filter(Boolean);
const topics = [], methods = [], seen = new Set();
let culturePlaced = false;
for (const line of lines) {
  const [block, ...rest] = line.split('||').map(part => part.trim()).filter(Boolean);
  let pathParts = rest;
  if (block === 'Topic Areas' && pathParts[0] === MISFILED) {
    if (!culturePlaced) { add(topics, [OMT, MISFILED]); culturePlaced = true; }
    pathParts = [OMT, ...pathParts.slice(1)];
  }
  if (block === 'Topic Areas') add(topics, pathParts);
  else if (block === 'Research Methods') add(methods, pathParts);
}

function add(list, parts) {
  const label = parts.join(' > ');
  if (!parts.length || seen.has(label)) return;
  seen.add(label);
  const prefix = list === topics ? 'T' : 'M';
  list.push({id: `${prefix}${String(list.length + 1).padStart(3, '0')}`, label});
}

const taxonomy = {
  version: 'amj-keywords-v1',
  source: 'Academy of Management Journal submission keywords (Topic Areas and Research Methods), config/source/amj_keywords_cleaned.txt',
  corrections: [`"${MISFILED}" and the subtopics listed after it are filed under "${OMT}".`, 'Exact duplicate entries are removed.'],
  topics,
  methods
};
await writeFile(outFile, JSON.stringify(taxonomy, null, 2) + '\n');
console.log(`taxonomy.json: ${topics.length} topic codes, ${methods.length} method codes`);
