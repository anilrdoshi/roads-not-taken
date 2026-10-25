// Saves the focal paper's own abstract to runs/<case>/paper/private/abstract.txt (git-ignored),
// read from the PDF (macOS, or pdftotext elsewhere). Check the printed text against the PDF; if the
// abstract is not found, paste it into that file by hand. Then run npm run distance.
// Usage: npm run original-abstract -- --case <name> --pdf papers/paper.pdf
import {parseArgs} from 'node:util';
import {mkdirSync, writeFileSync, existsSync} from 'node:fs';
import path from 'node:path';
import {caseDirFor} from '../src/config.js';
import {abstractFromPdfText, originalAbstractFile, readPdfText} from '../src/original-abstract.js';

const {values} = parseArgs({options: {case: {type: 'string'}, pdf: {type: 'string'}}});
if (!values.case || !values.pdf) {
  console.error('Usage: npm run original-abstract -- --case <name> --pdf papers/paper.pdf');
  process.exit(1);
}
const caseDir = caseDirFor(values.case);
if (!existsSync(path.join(caseDir, 'paper', 'extraction.json'))) {
  console.error(`No extraction for ${values.case}. Run npm run extract first.`);
  process.exit(1);
}
const file = originalAbstractFile(caseDir);
// The folder exists even when the abstract has to be pasted in by hand.
mkdirSync(path.dirname(file), {recursive: true});
let text;
try {
  text = readPdfText(values.pdf);
} catch (error) {
  console.error(`${error.message}\nThe file is ${path.relative(process.cwd(), file)}.`);
  process.exit(1);
}
const abstract = abstractFromPdfText(text);
if (!abstract) {
  console.error(`No "Abstract" heading found in the first pages of ${values.pdf}. Paste the abstract into ${path.relative(process.cwd(), file)} by hand.`);
  process.exit(1);
}
writeFileSync(file, abstract + '\n');
const odd = [...new Set(abstract.match(/[^\x20-\x7e‘’“”–— -ÿ]/g) || [])];
console.log(`Saved ${abstract.split(' ').length} words to ${path.relative(process.cwd(), file)} (git-ignored). Check it against the PDF:\n\n${abstract}\n`);
if (odd.length) console.warn(`Unusual characters to check: ${odd.join(' ')}`);
