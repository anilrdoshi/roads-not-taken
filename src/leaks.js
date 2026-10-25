// Deterministic check that the evidence section does not carry the paper's framing: the
// constructs the authors name, hypothesis labels, theory names, or interpretive language.
import {THEORIES} from './config.js';

// Short forms of theory names that would give a framing away; plain words such as "network"
// are left out because they also describe data (e.g. a TV network).
const THEORY_ALIASES = ['resource-based', 'RBV', 'transaction cost', 'knowledge-based view', 'attention-based', 'resource dependence',
  'dynamic capabilities', 'upper echelons', 'signaling theory', 'signalling theory', 'institutional theory', 'agency theory',
  'stakeholder theory', 'population ecology', 'real options', 'behavioral theory of the firm', 'social capital', 'absorptive capacity'];
const HYPOTHESIS_LABEL = /\b(?:BH|H\d{1,2}[a-z]?)\b/g;
const INTERPRETIVE = /\b(?:hypothes[ie]s|hypothesi[sz]ed|mechanisms?|constructs?|theori[sz]ed?|the authors (?:argue|interpret|read|suggest|conclude|take|attribute)\w*)\b/gi;

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function strings(value, path, out) {
  if (typeof value === 'string') out.push({path, text: value});
  else if (Array.isArray(value)) value.forEach((item, index) => strings(item, `${path}[${index}]`, out));
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) strings(child, path ? `${path}.${key}` : key, out);
  return out;
}

export function findLeaks(evidence, framing) {
  const patterns = [
    ...framing.constructs.map(c => c.term.trim()).filter(term => term.length >= 4).map(term => ({kind: 'construct', regex: new RegExp(`\\b${escape(term)}\\b`, 'gi')})),
    ...[...THEORIES.map(theory => theory.name), ...THEORY_ALIASES].map(name => ({kind: 'theory name', regex: new RegExp(`\\b${escape(name)}\\b`, 'gi')})),
    {kind: 'hypothesis label', regex: HYPOTHESIS_LABEL},
    {kind: 'interpretation', regex: INTERPRETIVE}
  ];
  const flags = [], seen = new Set();
  // Ids and table locations are not prose and are not checked.
  for (const {path, text} of strings(evidence, '', [])) {
    if (/\.(id|termIds\[\d+\]|outcomeId)$/.test(path) || /^(id|termIds|outcomeId)$/.test(path)) continue;
    for (const {kind, regex} of patterns) {
      for (const match of text.matchAll(regex)) {
        const key = `${path}|${match[0].toLowerCase()}`;
        if (!seen.has(key)) { seen.add(key); flags.push({path, phrase: match[0], kind}); }
      }
    }
  }
  return flags;
}

// A repair may only change wording: result and variable fields must be identical, and the prose
// must contain the same numbers (ignoring digits inside hypothesis labels).
export function numbersPreserved(before, after) {
  const resultKey = r => JSON.stringify([r.id, r.termIds, r.outcomeId, r.estimate, r.standardError, r.significance, r.observations]);
  const variableKey = v => JSON.stringify([v.id, v.role]);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(before.results.map(resultKey), after.results.map(resultKey))) return false;
  if (!same(before.variables.map(variableKey), after.variables.map(variableKey))) return false;
  const numbers = evidence => strings(evidence, '', []).map(({text}) => text.replace(HYPOTHESIS_LABEL, ''))
    .join(' ').match(/(?<![A-Za-z])-?\d+(?:[.,]\d+)*/g)?.sort() || [];
  return same(numbers(before), numbers(after));
}
