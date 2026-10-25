import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Loads .env (git-ignored) so ANTHROPIC_API_KEY never has to be typed on the command line.
const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

// Each focal paper is a case, with its own folder in runs/ (git-ignored). RUNS_DIR in .env keeps
// them somewhere else instead, relative to this folder (for example RUNS_DIR=../my-study).
export const RUNS_DIR = path.resolve(ROOT, process.env.RUNS_DIR || 'runs');
export const caseDirFor = name => path.join(RUNS_DIR, name);

const readJson = relative => JSON.parse(readFileSync(path.join(ROOT, relative), 'utf8'));

export const fieldsConfig = readJson('config/fields.json');
export const FIELDS = fieldsConfig.fields;
export const FIELD_IDS = FIELDS.map(field => field.id);
export const HOME_FIELD = fieldsConfig.homeField;
export const THEORIES = readJson('config/theories.json').theories;
export const DEFAULT_THEORIES = THEORIES.filter(theory => theory.default);
export const TAXONOMY = readJson('config/taxonomy.json');

// The journals the generation prompts name for a field's audience (config/fields.json
// audienceJournals). This is separate from how the corpus assigns published papers to fields.
export const journalsForField = fieldId =>
  FIELDS.find(field => field.id === fieldId).audienceJournals.map(id => fieldsConfig.journals.find(journal => journal.id === id).label);

// Model and pricing (USD per million tokens) for Claude Opus 5.5, from Anthropic's published rates.
// Cache writes use the 5-minute TTL rate (1.25x input).
export const MODEL = process.env.BRANCHING_MODEL || 'claude-opus-5-5';
export const PRICING = {input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20};
