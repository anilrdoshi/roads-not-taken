// The original paper's own abstract, used only to embed the original (for Distance
// and for its retrieval query) so that it compares directly with published abstracts. The
// extraction keeps a third-person paraphrase instead, which is what Claude sees. The abstract is
// kept in the case's git-ignored paper/private/ folder and never written to logs, reports or the
// explorer bundle.
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';

export const originalAbstractFile = caseDir => path.join(caseDir, 'paper', 'private', 'abstract.txt');

export async function loadOriginalAbstract(caseDir) {
  const file = originalAbstractFile(caseDir);
  const text = existsSync(file) ? (await readFile(file, 'utf8')).trim() : '';
  return text || null;
}

// Text of a PDF's first pages: via macOS PDFKit (no extra software), or elsewhere via pdftotext
// (poppler-utils, installed in the Codespaces setup). Without either, paste the abstract into the
// file by hand.
export function readPdfText(pdfPath, pages = 3) {
  if (process.platform !== 'darwin') {
    try {
      return execFileSync('pdftotext', ['-l', String(pages), '-enc', 'UTF-8', path.resolve(pdfPath), '-'], {encoding: 'utf8', maxBuffer: 1 << 24});
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('Reading PDF text needs macOS or pdftotext (poppler-utils). Paste the abstract into the file by hand instead.');
      throw error;
    }
  }
  const script = `function run(argv) {
    ObjC.import('PDFKit');
    const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
    if (!doc || doc.isNil()) throw new Error('Cannot open ' + argv[0]);
    let text = '';
    for (let i = 0; i < Math.min(Number(argv[1]), doc.pageCount); i++) text += doc.pageAtIndex(i).string.js + '\\n';
    return text;
  }`;
  return execFileSync('osascript', ['-l', 'JavaScript', '-e', script, path.resolve(pdfPath), String(pages)], {encoding: 'utf8', maxBuffer: 1 << 24});
}

// TeX fonts often come through PDFKit with ligatures as private or stray characters.
const LIGATURES = {'↵': 'ff', 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl'};

// The text between an "Abstract" heading and the keywords, short title or introduction.
export function abstractFromPdfText(text) {
  const start = text.match(/(?:^|\n)[ \t]*abstract\b[ \t]*[:.]?[ \t]*(?:\n|(?=\S))/i);
  if (!start) return null;
  const rest = text.slice(start.index + start[0].length);
  const end = rest.search(/\n[ \t]*(?:key ?words|short title|jel(?: classification)?|running head)\b|\n[ \t]*(?:1\.?[ \t]+)?introduction[ \t]*\n/i);
  const body = end < 0 ? rest.slice(0, 3000) : rest.slice(0, end);
  return body
    .replace(/[↵ﬀ-ﬄ]/g, char => LIGATURES[char])
    .replace(/([a-z])-\n([a-z])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim() || null;
}
