// Instructions and inputs for each model step. The evidence rule used throughout: an outline
// fails only if it contradicts the reported results; untested mechanisms, causal language beyond
// the design, and needs for re-analysis or new data are recorded as flags.
import {FIELDS, HOME_FIELD, THEORIES, TAXONOMY, journalsForField} from './config.js';

const fieldById = Object.fromEntries(FIELDS.map(field => [field.id, field]));

// ---------- Extraction ----------

// Both extraction passes send the whole PDF. Prompt caching does not help here: the two passes
// use different output schemas, which changes the cached prefix, so a cache write would only add cost.
export const EXTRACTION_SYSTEM = `You read empirical management research papers and extract structured information from them for a research tool. Follow the task given after the document. Use only what the document says. Paraphrase rather than quote; never quote more than a short phrase. Give page numbers as printed, or say when you use PDF page numbers instead.`;

export function extractionContent(documents, task) {
  return [
    ...documents.map(doc => ({type: 'document', title: doc.title, source: {type: 'base64', media_type: 'application/pdf', data: doc.base64}})),
    {type: 'text', text: task}
  ];
}

export function framingTask(versionNote) {
  return `TASK: FRAMING PASS. This document is the ${versionNote} of the paper.

Record how the authors frame the study, in their own terms:
- identity: title, authors, journal if stated, and the year of this version; and a 120-180 word paraphrase of the abstract.
- framing: the phenomenon, research question, scholarly conversation, theory, mechanism, hypotheses, interpretation of the results, contribution and intended audience.
- constructs: every named concept the authors use to label, theorize or interpret their variables and results. Include the names they give to measures, mechanisms, effects, and product or organizational characteristics, and distinctive terms from the research question, each with a one-line meaning. Do not list plain names of observed things such as ratings or tweets.
- codes: one primary theory id, secondary theory ids, topic ids and method ids, chosen only from the lists below.
- sources: where each part of the paper is (S1, S2 ... with page and a short note).

${codeLists()}`;
}

export function evidenceTask(bannedTerms) {
  return `TASK: EVIDENCE PASS. Record only the study's data and results, so that other researchers can build different theoretical framings on the same evidence. Work from the data, measures, methods and results sections and from the tables, including appendix tables. Ignore the introduction, theory, hypotheses and discussion, except to look up how a variable was measured.

Describe everything in measurement terms:
- Name each variable by what was counted, measured or coded, and how and when (for example "total followers of the show's Twitter account the day before airing"), never by the concept the authors attach to it.
- Do not use these terms from the paper's framing: ${bannedTerms.map(term => `"${term}"`).join(', ') || '(none listed)'}. Do not use hypothesis labels (H1, H2 ...), theory names, or the words hypothesis, mechanism or construct. Do not report the authors' interpretations; report only what was estimated or observed.
- results: for each model in the main results table and in each robustness table, record every estimate on a non-control variable or interaction: the specification (model, sample and column), the term in plain words, the estimate, standard error, significance as printed (use "not reported" when the table prints no stars or p-values and the text gives none), observations, and location (table, column, page). Record control-variable estimates only for the main specification.
- unitOfAnalysis and sample: what one observation is; the setting, population, period and sample sizes.
- dataSources: each source and what it provided.
- design: the estimation approach in plain terms (fixed effects, instruments, clustering, lags), without interpretation.
- designFacts: short factual constraints a reader needs, such as whether there is a source of exogenous variation, the sample size, and the number of platforms or periods.
- qualitativeFindings: only for qualitative evidence, described as observed; otherwise an empty list.
Use short stable ids: V1, V2 ... for variables and R1, R2 ... for results.`;
}

export const EVIDENCE_REPAIR_SYSTEM = `You edit the evidence section of a research paper extraction so that it describes only data and results, in measurement terms. You receive the evidence as JSON, a list of flagged phrases that carry the paper's framing, and the meaning of each framing term. Rewrite only the wording around each flagged phrase: replace a framing term with a plain description of what was measured or estimated, delete hypothesis labels, and delete interpretive statements. Do not change any number, identifier, variable role, significance level or result. Return the complete evidence object.`;

export function repairContent(evidence, flags, constructs) {
  return [{type: 'text', text: [
    `EVIDENCE\n${JSON.stringify(evidence, null, 2)}`,
    `FLAGGED PHRASES\n${flags.map(flag => `- "${flag.phrase}" in ${flag.path} (${flag.kind})`).join('\n')}`,
    `MEANINGS OF THE PAPER'S FRAMING TERMS\n${constructs.map(c => `- ${c.term}: ${c.meaning}`).join('\n') || '(none)'}`
  ].join('\n\n')}];
}

// ---------- Shared renderings ----------

export function codeLists() {
  const theories = THEORIES.map(theory => `${theory.id}: ${theory.name}`).join('\n');
  const topics = TAXONOMY.topics.map(topic => `${topic.id}: ${topic.label}`).join('\n');
  const methods = TAXONOMY.methods.map(method => `${method.id}: ${method.label}`).join('\n');
  return `THEORY CODES\n${theories}\n\nTOPIC CODES\n${topics}\n\nMETHOD CODES\n${methods}`;
}

// The blinded evidence packet: everything a generator may see. Title, authors, journal and the
// whole framing section are withheld. It comes in two presentations of the same content in the
// same order: "sections" (headed sections, results in compact notation; reviewers always get this
// one) and "list" (one flat list, a detail per bullet, results written out in words). Open runs
// use both, so convergence can be checked against the presentation of the evidence.
export const EVIDENCE_FORMATS = ['sections', 'list'];

export function evidencePacket(extraction, format = 'sections') {
  if (format === 'list') return evidenceList(extraction);
  if (format !== 'sections') throw new Error(`Unknown evidence format: ${format}`);
  const evidence = extraction.evidence;
  const nameOf = Object.fromEntries(evidence.variables.map(v => [v.id, v.name]));
  const variables = evidence.variables.map(v => `- ${v.id} (${v.role}): ${v.name}. Measured as: ${v.measurement}`).join('\n');
  const results = evidence.results.map(r =>
    `- ${r.id} [${r.specification}] ${r.term} -> ${nameOf[r.outcomeId] || r.outcomeId}: estimate ${r.estimate}${r.standardError ? ` (SE ${r.standardError})` : ''}, ${r.significance}${r.observations ? `, N = ${r.observations}` : ''}; ${r.location}`
  ).join('\n');
  const list = items => items.map(item => `- ${item}`).join('\n');
  return [
    `UNIT OF ANALYSIS: ${evidence.unitOfAnalysis}`,
    `SAMPLE: ${evidence.sample}`,
    `DATA SOURCES:\n${list(evidence.dataSources)}`,
    `VARIABLES:\n${variables}`,
    `DESIGN: ${evidence.design}`,
    `RESULTS (estimate, standard error, significance as reported):\n${results}`,
    evidence.qualitativeFindings.length ? `QUALITATIVE FINDINGS:\n${evidence.qualitativeFindings.map(f => `- ${f.id}: ${f.statement} (${f.location})`).join('\n')}` : '',
    evidence.designFacts.length ? `DESIGN FACTS:\n${list(evidence.designFacts)}` : ''
  ].filter(Boolean).join('\n\n');
}

function evidenceList(extraction) {
  const evidence = extraction.evidence;
  const nameOf = Object.fromEntries(evidence.variables.map(v => [v.id, v.name]));
  const role = v => v.role.charAt(0).toUpperCase() + v.role.slice(1);
  const details = r => [
    r.standardError ? `standard error: ${r.standardError}` : '',
    `significance: ${r.significance}`,
    r.observations ? `observations: ${r.observations}` : '',
    `location: ${r.location}`
  ].filter(Boolean).join('; ');
  return [
    `Unit of analysis: ${evidence.unitOfAnalysis}`,
    `Sample: ${evidence.sample}`,
    ...evidence.dataSources.map(source => `Data source: ${source}`),
    ...evidence.variables.map(v => `${role(v)} variable ${v.id}: ${v.name}. Measured as: ${v.measurement}`),
    `Design: ${evidence.design}`,
    ...evidence.results.map(r => `Result ${r.id}: in ${r.specification}, ${r.term} has an estimate of ${r.estimate} on ${nameOf[r.outcomeId] || r.outcomeId} (${details(r)}).`),
    ...evidence.qualitativeFindings.map(f => `Qualitative finding ${f.id}: ${f.statement} (${f.location})`),
    ...evidence.designFacts.map(fact => `Design fact: ${fact}`)
  ].map(line => `- ${line}`).join('\n');
}

// Any paper version (an original or an alternative) in one common format, so scorers and
// reviewers cannot tell originals from alternatives by their shape.
export function paperCard(paper) {
  const theory = typeof paper.theory === 'string' ? paper.theory : [paper.theory.primary, ...(paper.theory.secondary || [])].filter(Boolean).join('; ');
  return [
    `TITLE: ${paper.title}`,
    `ABSTRACT: ${paper.abstract}`,
    `RESEARCH QUESTION: ${paper.researchQuestion}`,
    `SCHOLARLY CONVERSATION: ${paper.conversation}`,
    `THEORY: ${theory}`,
    `MECHANISM: ${paper.mechanism}`,
    `INTERPRETATION OF THE RESULTS: ${paper.interpretation}`,
    `CONTRIBUTION: ${paper.contribution}`
  ].join('\n');
}

export function originalAsPaper(extraction) {
  const {identity, abstract, framing} = extraction;
  return {
    title: identity.title,
    abstract,
    researchQuestion: framing.researchQuestion,
    conversation: framing.conversation,
    theory: framing.theory,
    mechanism: framing.mechanism,
    hypotheses: framing.hypotheses,
    interpretation: framing.interpretation,
    contribution: framing.contribution
  };
}

// The hypotheses as plain statements: the original's are strings; an alternative's carry result
// ids and a status, which are left out so the Evidence-fit judge maps them to results itself.
export const hypothesisStatements = paper => (paper.hypotheses || []).map(h => typeof h === 'string' ? h : h.statement);

// ---------- Generation ----------

// Kept neutral about novelty and names no field: open runs measure how often the model returns to
// the original paper, so nothing here should push it toward or away from the obvious framing.
// Field and theory runs get their target from targetInstruction.
export const GENERATION_SYSTEM = `You are an experienced management scholar who has published in leading business-school research journals.

You will receive the evidence from a completed empirical study: its unit of analysis, setting, data, measures, design and reported results. The original paper's title, question, theory, framing and contribution are withheld. Write a complete outline for one paper built on this evidence.

Rules for the evidence:
- Keep every reported result as reported: the same outcome, predictors, sign and significance. Never invent results or reverse which variable is the outcome.
- You may propose any theory and mechanism that could plausibly explain the reported results, even if the mechanism was not measured directly. That is normal in management research; say in the outline that the mechanism is theorized rather than tested.
- Match causal language to the design. For an observational design, claim associations or patterns consistent with your mechanism.
- If a hypothesis can only be tested with a re-analysis of the data or with new data, you may still propose it: mark that hypothesis needs-reanalysis or needs-new-data, and list exactly what it requires under changesNeeded. changesNeeded is only for what your hypotheses require; leave it empty if every hypothesis rests on reported results. Put optional improvements, robustness checks and follow-up studies under extensions.

Write the way a strong author in the target field would: a clear question, a real theoretical argument with named constructs, and a specific contribution to a named conversation. Do not write a hedged summary of the results. The abstract should be 120-180 words. Link each hypothesis to the result ids it rests on.`;

export function generationContent(extraction, target) {
  return [
    {type: 'text', text: `EVIDENCE FROM THE STUDY\n\n${evidencePacket(extraction, target.format)}`, cache_control: {type: 'ephemeral'}},
    {type: 'text', text: targetInstruction(target)}
  ];
}

// Open runs differ only in how ambitious a paper they ask for (and in the evidence format). None
// names a field or theory, so each wording is as neutral about the paper's direction as the others.
export const OPEN_AMBITIONS = {
  best: 'Write the best possible paper from this evidence.',
  good: 'Write a good paper from this evidence.',
  publishable: 'Write a publishable paper from this evidence.',
  'top-journal': 'Write a paper from this evidence that is publishable in a top journal.'
};
export const OPEN_VARIANT_LABELS = {
  best: 'Best possible paper', good: 'Good paper', publishable: 'Publishable paper', 'top-journal': 'Publishable in a top journal',
  sections: 'Evidence in headed sections', list: 'Evidence as one list'
};

export function targetInstruction(target) {
  if (target.mode === 'open') {
    const ask = OPEN_AMBITIONS[target.ambition || 'best'];
    if (!ask) throw new Error(`Unknown open-run ambition: ${target.ambition}`);
    return `TASK: ${ask} Choose whatever field, scholarly conversation and theory you think suit it.`;
  }
  if (target.mode === 'theory') {
    const theory = THEORIES.find(item => item.id === target.theoryId);
    const home = fieldById[HOME_FIELD];
    return [
      `TASK: Write the strongest paper that explains these results using ${theory.name}.`,
      `${theory.name}: ${theory.core} ${theory.mechanism || ''}`,
      theory.constructs ? `Key constructs: ${theory.constructs.join(', ')}.` : '',
      theory.references ? `Canonical references: ${theory.references.join('; ')}.` : '',
      `Write it for a ${home.label.toLowerCase()} audience (journals such as ${journalsForField(HOME_FIELD).slice(0, 3).join(', ')}). If this theory fits the evidence poorly, still write the best version you can; the outline will be assessed for fit separately.`
    ].filter(Boolean).join('\n');
  }
  const field = fieldById[target.fieldId];
  return [
    `TASK: Write the strongest paper for ${field.label}: ${field.description}`,
    `Aim it at journals such as ${journalsForField(target.fieldId).join(', ')}.`,
    'Use the question, conversation and theory that would make it most convincing to editors and reviewers in that field. If the evidence makes this field a stretch, still write the best version you can and list what would need to change.'
  ].join('\n');
}

// ---------- Review: evidence check, codes, comparison with reference versions ----------

export const REVIEW_SYSTEM = `You review alternative outlines built on the evidence of a completed empirical study. For each outline you do three things.

1. Check its use of the evidence. An outline CONTRADICTS the evidence only if it misstates a reported result: the wrong outcome or predictor, the wrong direction, a result that was not reported presented as found, or significance stronger than reported. Everything else is a flag, not a contradiction: a mechanism that was theorized but not directly measured (untestedMechanism), causal language the design cannot support (causalOverreach), a central hypothesis that can only be tested by re-analyzing the existing data (needsReanalysis), or a central hypothesis that can only be tested with new data (needsNewData). Optional improvements or extensions do not count toward needsReanalysis or needsNewData.

2. Tag it with codes from the lists provided: one primary theory id (or "other"), secondary theory ids, topic ids and method ids.

3. Compare it with each reference version of the paper. For each component use this scale: unchanged (same substance, perhaps reworded); refined (same idea, narrowed or sharpened); reframed (the same core idea told through a different lens or emphasis); replaced (a different idea). Then judge the family: same-paper (question, theory and contribution are substantively the same), close-variant (shares the core question or theory but differs in one major respect), different-paper (differs in two or more of question, theory and contribution). Shared data and vocabulary alone do not make the same paper. Give a one-sentence summary of how the outline differs from the reference.`;

export function reviewContent(extraction, references, alternative) {
  return [
    {type: 'text', text: `${codeLists()}\n\nEVIDENCE FROM THE STUDY\n\n${evidencePacket(extraction)}`, cache_control: {type: 'ephemeral'}},
    {type: 'text', text: [
      ...references.map(ref => `REFERENCE VERSION "${ref.id}"\n${paperCard(ref.paper)}`),
      `OUTLINE TO REVIEW\n${paperCard(alternative)}\nHYPOTHESES:\n${alternative.hypotheses.map(h => `- ${h.statement} [rests on ${h.resultIds.join(', ') || 'no reported result'}; ${h.status}]`).join('\n')}\nCHANGES NEEDED: ${alternative.changesNeeded.join('; ') || 'none listed'}`,
      `Return one comparison per reference version, using the reference ids ${references.map(ref => `"${ref.id}"`).join(' and ')}.`
    ].join('\n\n')}
  ];
}

// ---------- Scoring: fit to each field and novelty within the best-fit field ----------

// The first paragraph says how the comparison articles were retrieved: by word overlap alone (BM25,
// the wording used for the runs scored so far) or by word overlap fused with embedding similarity.
const RETRIEVED_BY = {
  bm25: 'These are retrieved by word overlap, so some may be only superficially similar; judge them on substance.',
  hybrid: 'These are retrieved automatically, by word overlap and by similarity of meaning, so some may be only superficially similar; judge them on substance.'
};

export const scoreSystem = (retrieval = 'bm25') => `You assess where a paper idea fits across five business-school research fields and how novel it is within the field where it fits best. For each field you get a description and the most similar articles published in that field's leading journals. ${RETRIEVED_BY[retrieval]}

Fit (0 to 1): would editors and reviewers in this field see this as a paper for their field, given its question, unit of analysis, theory, outcomes and evidence?
0.90-1.00 a natural paper for the field; 0.70-0.89 clearly positionable with some adjustment; 0.40-0.69 could be positioned, but reviewers would ask why it belongs or what it adds for the field; 0.10-0.39 a poor fit; 0.00-0.09 does not belong.

Novelty (0 to 1), within the best-fit field only, against the closest published work and your knowledge of that field:
0.90-1.00 a clearly new question or explanation; 0.70-0.89 a meaningful extension; 0.40-0.69 incremental; 0.10-0.39 largely done before; 0.00-0.09 duplicates existing work.

Use the whole scale and two decimals. Give one or two sentences of justification per score. Cite only article ids from the lists provided.`;
export const SCORE_SYSTEM = scoreSystem('bm25');

export function scoreContent(paper, retrieved) {
  const fieldBlocks = FIELDS.map(field => {
    const records = retrieved[field.id].map(({record}) => `[${record.id}] ${record.title} (${record.journal}, ${record.year}). ${truncateWords(record.abstract, 110)}`);
    return `FIELD "${field.id}": ${field.label}. ${field.description}\nMost similar published articles:\n${records.join('\n') || '(none retrieved)'}`;
  });
  const publicBlocks = FIELDS.map(field => {
    const records = retrieved[field.id].map(({record}) => `[${record.id}] (title and abstract withheld from the shareable log; rebuild the corpus to view)`);
    return `FIELD "${field.id}": ${field.label}. ${field.description}\nMost similar published articles:\n${records.join('\n') || '(none retrieved)'}`;
  });
  const head = `PAPER IDEA\n${paperCard(paper)}`;
  const tail = 'Score fit for all five fields, name the best-fit field, and score novelty within it.';
  return {
    content: [{type: 'text', text: `${head}\n\n${fieldBlocks.join('\n\n')}\n\n${tail}`}],
    publicContent: [{type: 'text', text: `${head}\n\n${publicBlocks.join('\n\n')}\n\n${tail}`}]
  };
}

// ---------- Evidence fit: how well the theory predicts the evidence ----------

// Fit is the geometric mean of Field fit (scoreSystem) and Evidence fit. Field fit alone could not
// tell theories apart: an AI alternative built on firm-level evidence for a strategy audience is a
// strategy paper whatever its theory. Evidence fit judges prediction, not accommodation: every AI
// alternative is written with the results in view, so hypotheses fitted to them must not count as
// predictions. Doubts about the data or design are left out (they apply to every theory alike), and
// a rival that predicts a result as well is recorded, not held against the theory outright.
export const EVIDENCE_FIT_SYSTEM = `You assess how well a paper idea's theory predicts the evidence of a completed empirical study. You receive the study's evidence (unit of analysis, sample, data, measures, design and reported results) and a paper idea built on it: its question, theory, mechanism, hypotheses, interpretation and contribution.

The paper idea may have been written after its authors saw the results, so its hypotheses may have been fitted to them. Judge what the theory itself implies for this setting and design, not what the hypotheses say. Ask: would someone who held this theory, knowing the setting and the design but not the results, have expected these results? Judge the theory in its established form; where the paper idea adapts it, or adds assumptions to reach a result, those parts are additions, not predictions of the theory.

Take the evidence as given. Doubts about the data or design (measurement artifacts, selection, regression to the mean, confounding, weak identification) apply to every theory equally and are not part of this judgement. Judge against the evidence as reported: where the paper idea restates a result differently from the evidence, go by the evidence. A misstatement does not lower the score by itself; but if the theory depends on the misstated version, treat the actual result as one the theory does not explain or is in tension with.

First identify the central results, at most eight: the main estimates on the study's predictors, moderators and mediators in its principal specifications (not on control variables), and any further results the paper idea's argument turns on. Group estimates that make one point. Name the main substantive rivals: other theories or mechanisms that would explain these results, such as a simple cost, incentive or capability explanation. Classify each central result:
- predicted: the theory's own logic implies this result in this setting (its direction, and its pattern where that matters) without added assumptions;
- consistent: the theory can accommodate the result, but only through hypotheses or assumptions added for this setting, or it would equally have allowed a different result;
- unexplained: the theory says nothing about it;
- tension: the theory, as stated, leads one to expect something different.
For each, say whether a substantive rival predicts it as well. List the hypotheses that look fitted to the results rather than derived from the theory, and what the argument rests on that the study did not measure.

Evidence fit (0 to 1): how well does the theory predict the reported evidence?
0.90-1.00 the theory's own logic predicts the central results, and predicts some of them better than the substantive rivals do; the study is a natural test of it.
0.70-0.89 the theory predicts most central results without added assumptions, though rivals predict many of them as well.
0.40-0.69 the theory predicts some central results; others need hypotheses fitted to the results or added assumptions.
0.10-0.39 the theory is mostly a label on results it does not predict.
0.00-0.09 the theory predicts the opposite of the central results, or explains none of them.

Judge only how well the theory predicts the evidence: not the writing, the field, the novelty, how well known the theory is, or the quality of the data and design. Use the whole scale and two decimals.`;

// The judge sees the evidence (the same headed-sections format reviewers get) and the paper as a
// scorer does, plus its hypotheses as plain statements. It is not told which is the focal paper.
export function evidenceFitContent(extraction, paper) {
  return [
    {type: 'text', text: `EVIDENCE FROM THE STUDY\n\n${evidencePacket(extraction)}`, cache_control: {type: 'ephemeral'}},
    {type: 'text', text: [
      `PAPER IDEA\n${paperCard(paper)}`,
      `HYPOTHESES:\n${hypothesisStatements(paper).map(h => `- ${h}`).join('\n') || '(none stated)'}`,
      'Identify the central results and the substantive rivals, classify each result and say whether a rival predicts it as well, list the hypotheses that look fitted to the results and what the argument rests on that the study did not measure, and score Evidence fit.'
    ].join('\n\n')}
  ];
}

export function scoringQuery(paper) {
  const theory = typeof paper.theory === 'string' ? paper.theory : paper.theory.primary;
  return [paper.title, paper.abstract, paper.researchQuestion, theory, paper.contribution].join(' ');
}

function truncateWords(text, count) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  return words.length > count ? `${words.slice(0, count).join(' ')} ...` : words.join(' ');
}
