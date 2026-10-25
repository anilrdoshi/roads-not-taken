// Checks that the API key works and can use the configured model, without spending anything.
// With --pdf, also counts the input tokens of each PDF to estimate what extracting it will cost.
// Usage: npm run check-key [-- --pdf papers/paper.pdf]
import {parseArgs} from 'node:util';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import {MODEL, PRICING} from '../src/config.js';
import {EXTRACTION_SYSTEM, extractionContent, framingTask} from '../src/prompts.js';

const {values} = parseArgs({options: {pdf: {type: 'string', multiple: true}}});
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('No API key found. Create .env containing ANTHROPIC_API_KEY=your-key (see .env.example), or set ANTHROPIC_API_KEY in the environment.');
  process.exit(1);
}
const client = new Anthropic();
try {
  const model = await client.models.retrieve(MODEL);
  console.log(`Key works. ${model.display_name || model.id} (${model.id}) is available` +
    (model.max_input_tokens ? `: ${model.max_input_tokens.toLocaleString()}-token context, ${model.max_tokens?.toLocaleString()} max output.` : '.'));
} catch (error) {
  if (error instanceof Anthropic.AuthenticationError) console.error('The key was rejected (authentication error). Check that .env (or ANTHROPIC_API_KEY in the environment) holds the full key.');
  else if (error instanceof Anthropic.NotFoundError) console.error(`The key works but cannot use ${MODEL}.`);
  else console.error(`Check failed: ${error.message}`);
  process.exit(1);
}
for (const pdfPath of values.pdf || []) {
  const base64 = (await readFile(pdfPath)).toString('base64');
  const {input_tokens} = await client.messages.countTokens({
    model: MODEL,
    system: EXTRACTION_SYSTEM,
    messages: [{role: 'user', content: extractionContent([{title: path.basename(pdfPath), base64}], framingTask('paper'))}]
  });
  // Extraction reads the PDF twice: a framing pass and an evidence pass.
  const inputUsd = 2 * input_tokens * PRICING.input / 1e6;
  console.log(`${path.basename(pdfPath)}: ${input_tokens.toLocaleString()} input tokens per pass, about $${inputUsd.toFixed(2)} of input for both passes (output adds roughly $0.60-0.80 per pass).`);
}
