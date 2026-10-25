// JSON schemas for each model step. Structured outputs require additionalProperties:false on
// every object and do not support numeric bounds, so 0-1 scores are clamped after parsing.
import {FIELD_IDS} from './config.js';

const str = {type: 'string'};
const num = {type: 'number'};
const bool = {type: 'boolean'};
const en = (...values) => ({type: 'string', enum: values});
const arr = items => ({type: 'array', items});
const obj = properties => ({type: 'object', properties, required: Object.keys(properties), additionalProperties: false});

const fieldOrOther = en(...FIELD_IDS, 'other');
const change = en('unchanged', 'refined', 'reframed', 'replaced');

// Extraction runs as two passes over the same PDF. The framing pass records how the authors
// tell the story, including the constructs they name. The evidence pass records only data and
// results, in measurement terms, with those constructs banned.
export const framingSchema = obj({
  identity: obj({title: str, authors: arr(str), journal: str, year: str, versionNote: str}),
  abstract: str,
  framing: obj({
    phenomenon: str,
    researchQuestion: str,
    conversation: str,
    theory: str,
    mechanism: str,
    hypotheses: arr(str),
    interpretation: str,
    contribution: str,
    audience: str
  }),
  constructs: arr(obj({term: str, meaning: str})),
  codes: obj({primaryTheory: str, theories: arr(str), topics: arr(str), methods: arr(str)}),
  sources: arr(obj({id: str, page: str, note: str}))
});

export const significance = en('p<0.001', 'p<0.01', 'p<0.05', 'p<0.10', 'not significant', 'not reported');

export const evidenceSchema = obj({
  unitOfAnalysis: str,
  sample: str,
  dataSources: arr(str),
  variables: arr(obj({id: str, name: str, role: en('outcome', 'predictor', 'moderator', 'mediator', 'control'), measurement: str})),
  design: str,
  results: arr(obj({
    id: str,
    specification: str,
    term: str,
    termIds: arr(str),
    outcomeId: str,
    estimate: str,
    standardError: str,
    significance,
    observations: str,
    location: str
  })),
  qualitativeFindings: arr(obj({id: str, statement: str, location: str})),
  designFacts: arr(str)
});

export const alternativeSchema = obj({
  title: str,
  abstract: str,
  field: fieldOrOther,
  targetJournals: arr(str),
  researchQuestion: str,
  conversation: str,
  theory: obj({primary: str, secondary: arr(str)}),
  mechanism: str,
  hypotheses: arr(obj({statement: str, resultIds: arr(str), status: en('reported', 'needs-reanalysis', 'needs-new-data')})),
  interpretation: str,
  contribution: str,
  scope: str,
  changesNeeded: arr(str),
  extensions: arr(str)
});

export const reviewSchema = obj({
  evidence: obj({
    verdict: en('consistent', 'contradicts'),
    contradictions: arr(str),
    flags: obj({untestedMechanism: bool, causalOverreach: bool, needsReanalysis: bool, needsNewData: bool}),
    flagNotes: str
  }),
  codes: obj({primaryTheory: str, theories: arr(str), topics: arr(str), methods: arr(str)}),
  comparisons: arr(obj({
    reference: str,
    components: obj({question: change, conversation: change, theory: change, mechanism: change, interpretation: change, contribution: change, audience: change}),
    family: en('same-paper', 'close-variant', 'different-paper'),
    summary: str
  }))
});

export const scoreSchema = obj({
  fit: arr(obj({field: en(...FIELD_IDS), score: num, reason: str, closest: arr(str)})),
  bestField: en(...FIELD_IDS),
  novelty: obj({score: num, reason: str, closest: arr(obj({id: str, relation: str}))})
});

// Minimal validator for the subset of JSON Schema used above.
export function validate(value, schema, at = 'output') {
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${at} must be one of ${schema.enum.join(', ')}`);
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${at} must be an object`);
    for (const key of schema.required) if (!(key in value)) throw new Error(`${at}.${key} is missing`);
    for (const [key, child] of Object.entries(schema.properties)) validate(value[key], child, `${at}.${key}`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${at} must be an array`);
    value.forEach((item, index) => validate(item, schema.items, `${at}[${index}]`));
  } else if (schema.type === 'number') {
    if (typeof value !== 'number' || Number.isNaN(value)) throw new Error(`${at} must be a number`);
  } else if (typeof value !== schema.type) {
    throw new Error(`${at} must be a ${schema.type}`);
  }
  return value;
}
