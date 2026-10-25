// One wrapper for every model call: structured JSON output, a hard spending cap shared across
// script runs, limited concurrency, and an audit log of every request and response.
import Anthropic from '@anthropic-ai/sdk';
import {appendFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {MODEL, PRICING} from './config.js';
import {validate} from './schemas.js';

export class BudgetExceeded extends Error {}
export class ModelRefusal extends Error {}

const sha256 = value => createHash('sha256').update(value).digest('hex');
// Reserved per in-flight call so concurrent calls cannot overshoot the cap.
const RESERVE_PER_CALL_USD = 0.75;

export function costOf(usage = {}) {
  return ((usage.input_tokens || 0) * PRICING.input
    + (usage.cache_creation_input_tokens || 0) * PRICING.cacheWrite
    + (usage.cache_read_input_tokens || 0) * PRICING.cacheRead
    + (usage.output_tokens || 0) * PRICING.output) / 1e6;
}

// PDF bytes are never written to logs; they are replaced by their hash and size.
function withoutDocuments(content) {
  return content.map(block => block.type !== 'document' ? block : {
    type: 'document',
    title: block.title,
    source: {type: 'base64', media_type: block.source.media_type, sha256: sha256(block.source.data), bytes: Buffer.byteLength(block.source.data, 'base64')}
  });
}

export class Llm {
  constructor({budgetFile, budgetUsd = 80, logDir, concurrency = 4, mock = null, model = MODEL} = {}) {
    this.budgetFile = budgetFile;
    this.budgetUsd = budgetUsd;
    this.logDir = logDir;
    this.limit = concurrency;
    this.mock = mock;
    this.model = model;
    this.active = 0;
    this.waiting = [];
    this.spentUsd = 0;
    this.calls = 0;
    this.client = mock ? null : new Anthropic({maxRetries: 4});
  }

  async init() {
    if (this.budgetFile) {
      try { this.spentUsd = JSON.parse(await readFile(this.budgetFile, 'utf8')).spentUsd || 0; } catch {}
    }
    await mkdir(path.join(this.logDir, 'private'), {recursive: true});
    return this;
  }

  async acquire() {
    if (this.active >= this.limit) await new Promise(resolve => this.waiting.push(resolve));
    this.active++;
  }

  release() {
    this.active--;
    this.waiting.shift()?.();
  }

  // content: user-message blocks sent to the model. publicContent: the same blocks with
  // licensed text (corpus abstracts) replaced by identifiers, for the shareable log.
  async call({role, itemId, system, content, publicContent = content, schema, effort = 'high', maxTokens = 32000}) {
    await this.acquire();
    try {
      if (this.spentUsd + this.active * RESERVE_PER_CALL_USD > this.budgetUsd) {
        throw new BudgetExceeded(`Spending cap of $${this.budgetUsd} reached ($${this.spentUsd.toFixed(2)} spent).`);
      }
      const request = {
        model: this.model,
        max_tokens: maxTokens,
        system,
        thinking: {type: 'adaptive', display: 'summarized'},
        output_config: {effort, format: {type: 'json_schema', schema}},
        messages: [{role: 'user', content}],
        // If a safety filter declines a request, Anthropic retries it on another Claude model;
        // modelServed in the log shows when that happened. BRANCHING_FALLBACKS=off disables it.
        ...(process.env.BRANCHING_FALLBACKS === 'off' ? {} : {betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default'})
      };
      const startedAt = new Date();
      const message = this.mock
        ? await this.mock({role, itemId, request})
        : await this.client.beta.messages.stream(request).finalMessage();
      const costUsd = costOf(message.usage);
      this.spentUsd += costUsd;
      this.calls++;
      if (this.budgetFile) await writeFile(this.budgetFile, JSON.stringify({capUsd: this.budgetUsd, spentUsd: this.spentUsd, updatedAt: new Date().toISOString()}, null, 2));

      const servedByFallback = (message.usage?.iterations || []).some(entry => entry.type === 'fallback_message')
        || message.content.some(block => block.type === 'fallback');
      const thinking = message.content.filter(block => block.type === 'thinking').map(block => block.thinking).join('\n').trim();
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('');
      let value = null, error = null;
      if (message.stop_reason === 'refusal') error = `Refused (${message.stop_details?.category || 'no category'})`;
      else if (message.stop_reason === 'max_tokens') error = `Output reached max_tokens (${maxTokens})`;
      else {
        try { value = validate(JSON.parse(text), schema); } catch (parseError) { error = `Invalid output: ${parseError.message}`; }
      }

      const base = {
        at: startedAt.toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        role,
        itemId,
        modelRequested: this.model,
        modelServed: message.model,
        servedByFallback,
        effort,
        maxTokens,
        requestSha256: sha256(JSON.stringify(request, (key, val) => key === 'data' && typeof val === 'string' ? sha256(val) : val)),
        responseId: message.id,
        stopReason: message.stop_reason,
        usage: message.usage,
        costUsd,
        thinkingSummary: thinking,
        output: value,
        error
      };
      await appendFile(path.join(this.logDir, 'calls.jsonl'), JSON.stringify({...base, system, content: withoutDocuments(publicContent)}) + '\n');
      await appendFile(path.join(this.logDir, 'private', 'calls.jsonl'), JSON.stringify({...base, system, content: withoutDocuments(content), rawText: text}) + '\n');

      if (message.stop_reason === 'refusal') throw new ModelRefusal(error);
      if (error) throw new Error(error);
      return {value, costUsd, usage: message.usage, modelServed: message.model, servedByFallback};
    } finally {
      this.release();
    }
  }
}

// Runs tasks with the Llm's concurrency, collecting results and errors per task.
export async function runAll(items, worker) {
  return Promise.all(items.map(async item => {
    try { return {item, result: await worker(item)}; } catch (error) { return {item, error}; }
  }));
}
