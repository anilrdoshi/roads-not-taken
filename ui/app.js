// Roads Not Taken explorer: reads ui/data/cases.json and one bundle per case (or the same data
// embedded in an exported page), and renders the paper, the results, the alternatives and the
// method. Routes: #/<case>/<view>[/<alternative>].
import {h, s, fieldColor, fmt, dataTable, withTableToggle, hideTooltip} from './dom.js';
import {possibilityMap, convergenceStrip, fieldReach, aimLanding, theoryChart, measureTrio, MEASURES, rankCorrelation, distanceFromOriginal, distanceFromPublished, neighbourAgreement, bestFit, kindText, familyText, pct} from './charts.js';

const VIEWS = ['paper', 'results', 'alternatives', 'measures', 'method'];
const state = {cases: [], bundles: new Map(), caseId: null, view: 'results', kinds: new Set(['open', 'theory', 'field']), minFit: 0, dropMisstated: false};
const main = document.getElementById('main');
const drawer = document.getElementById('drawer');
const drawerBody = document.getElementById('drawer-body');
let lastFocus = null;

const CHANGE_STEPS = {unchanged: 0, refined: 1, reframed: 2, replaced: 3};
const PART_LABEL = {question: 'Question', conversation: 'Conversation', theory: 'Theory', mechanism: 'Mechanism', interpretation: 'Interpretation', contribution: 'Contribution', audience: 'Audience'};
const lockIcon = locked => s('svg', {viewBox: '0 0 20 20', 'aria-hidden': 'true'},
  s('rect', {x: 4, y: 9, width: 12, height: 9, rx: 2, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6}),
  s('path', {d: locked ? 'M7 9V6.5a3 3 0 0 1 6 0V9' : 'M7 9V6.5a3 3 0 0 1 5.8-1.1', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round'}));
const checkIcon = ok => s('svg', {viewBox: '0 0 20 20', 'aria-hidden': 'true'},
  s('circle', {cx: 10, cy: 10, r: 9, fill: ok ? 'var(--good)' : 'var(--critical)'}),
  s('path', {d: ok ? 'M6 10.5l2.6 2.6L14 7.6' : 'M7 7l6 6M13 7l-6 6', stroke: '#fff', 'stroke-width': 2, fill: 'none', 'stroke-linecap': 'round'}));

// ---------- Data and routing ----------

// A page made by npm run export-explorer carries its data inline; otherwise it is read from data/.
const embedded = document.getElementById('explorer-data');
const embeddedData = embedded && JSON.parse(embedded.textContent);
async function readData(file) {
  if (embeddedData) return embeddedData[file] ?? null;
  const response = await fetch(`data/${file}`);
  return response.ok ? response.json() : null;
}

async function loadCases() {
  state.cases = (await readData('cases.json'))?.cases || [];
}

async function bundle(caseId) {
  if (!state.bundles.has(caseId)) {
    const data = await readData(`${caseId}.json`);
    if (!data) throw new Error(`No results for ${caseId}. Run npm run build-explorer.`);
    state.bundles.set(caseId, data);
  }
  return state.bundles.get(caseId);
}

function parseHash() {
  const [caseId, view, altId] = location.hash.replace(/^#\/?/, '').split('/');
  return {caseId: state.cases.some(c => c.id === caseId) ? caseId : state.cases[0]?.id, view: VIEWS.includes(view) ? view : 'results', altId};
}

const go = (view, altId) => { location.hash = `#/${state.caseId}/${view}${altId ? `/${altId}` : ''}`; };

async function route() {
  if (!state.cases.length) return renderWelcome();
  const {caseId, view, altId} = parseHash();
  const data = await bundle(caseId);
  const changed = caseId !== state.caseId || view !== state.view || !main.hasChildNodes();
  state.caseId = caseId;
  state.view = view;
  if (changed) {
    renderHeader(data);
    main.replaceChildren(({paper: renderPaper, results: renderResults, alternatives: renderAlternatives, measures: renderMeasures, method: renderMethod})[view](data));
    window.scrollTo(0, 0);
  }
  // On the Measures tab the last part of the route names a measure to scroll to, not an alternative.
  if (view === 'measures') {
    if (altId) document.getElementById(`measure-${altId}`)?.scrollIntoView();
    return closeDrawer(false);
  }
  const alt = altId && data.alternatives.find(a => a.id === altId);
  if (alt) openDrawer(alt, data); else closeDrawer(false);
}

function renderHeader(data) {
  const select = document.getElementById('case-select');
  select.replaceChildren(...state.cases.map(c => h('option', {value: c.id, selected: c.id === state.caseId ? true : null}, `${c.title} (${[c.versionNote, yearOf(c.year), c.pilot && 'pilot'].filter(Boolean).join(', ')})`)));
  document.getElementById('paper-title').textContent = data.paper.identity.title;
  const note = data.paper.versionNote ? data.paper.versionNote[0].toUpperCase() + data.paper.versionNote.slice(1) : '';
  document.getElementById('paper-byline').textContent = [data.paper.identity.authors?.join(', '), [note, yearOf(data.paper.identity.year)].filter(Boolean).join(', '),
    data.pilot && `Pilot run: ${data.alternatives.length} AI alternatives. The full test replaces it`].filter(Boolean).map(part => `${part}.`).join(' ');
  document.querySelectorAll('.tabs a').forEach(link => {
    link.href = `#/${state.caseId}/${link.dataset.view}`;
    if (link.dataset.view === state.view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  document.title = `${data.paper.identity.title} · Roads Not Taken`;
}

// ---------- Shared helpers ----------

const fieldLabel = (data, id) => id === 'other' ? 'Another field' : data.fields.find(f => f.id === id)?.label || id;
// The extraction records the year as printed, which for an undated manuscript is a note
// ("Not stated; probably 2026 ..."). Show its first four-digit year, or the note if it has none.
const yearOf = year => String(year ?? '').match(/\b(19|20)\d{2}\b/)?.[0] || year;
// The minimum-fit slider and the misstated-result box remove AI alternatives from every Results panel;
// the run-type chips only fade dots on the map and the scatter plots.
const shownOnResults = alt => (bestFit(alt) ?? 0) >= state.minFit && !(state.dropMisstated && alt.review?.verdict === 'contradicts');
const passes = alt => state.kinds.has(alt.kind);
const isDistinct = alt => alt.review?.family === 'different-paper' && alt.review?.verdict === 'consistent';
const select = alt => go(state.view, alt.id);

function section(title, lede, ...body) {
  return h('section', {class: 'section'}, h('header', null, h('div', null, h('h2', null, title), lede ? h('p', {class: 'lede'}, lede) : null)), ...body);
}

// Tags after a panel title naming the measures its chart plots. Each links to that measure's
// entry on the Measures tab. Fit and Novelty are Claude's scores, Distance is the embedding
// measure, and Claude's comparison comes from the review call.
const MEASURE_TAGS = {
  fit: ['Fit', "Claude's score for how well the focal paper or an AI alternative fits a field"],
  novelty: ['Novelty', "Claude's score for how new the focal paper or an AI alternative is within its best field"],
  distance: ['Distance', 'Text-embedding measure, no model judgement'],
  comparison: ["Claude's comparison", "Claude's review of each AI alternative against the focal paper: same paper, close variant or different paper"]
};
const measureTags = keys => h('span', {class: 'measure-tags'}, h('span', {class: 'visually-hidden'}, ' – measures: '),
  keys.map((key, i) => h('a', {class: `measure-tag tag-${key}`, href: `#/${state.caseId}/measures/${key}`, title: `${MEASURE_TAGS[key][1]}. Select to see how it is measured.`}, MEASURE_TAGS[key][0], i < keys.length - 1 ? h('span', {class: 'visually-hidden'}, ', ') : null)));

// Field colors, then how the chart marks the paper (a dot unless the chart says otherwise).
function fieldLegend(data, ...marks) {
  const seen = new Set(data.alternatives.map(a => a.score?.bestField).filter(Boolean));
  return h('div', {class: 'legend', 'aria-label': 'Field colors'}, data.fields.filter(f => seen.has(f.id) || f.id === data.homeField).map(f =>
    h('span', null, h('i', {class: 'swatch', style: {background: fieldColor(f.id)}}), f.label)),
    marks.length ? marks : h('span', null, h('i', {class: 'swatch', style: {background: 'var(--ink)'}}), 'Focal paper'));
}

const LEGEND_SHAPES = {
  diamond: () => s('path', {d: 'M7 1L13 7L7 13L1 7Z', fill: 'var(--ink)'}),
  star: () => s('path', {d: 'M7 0.5L8.6 5.2L13.5 5.2L9.5 8.1L11 12.8L7 9.9L3 12.8L4.5 8.1L0.5 5.2L5.4 5.2Z', fill: 'var(--ink)'}),
  line: () => s('line', {x1: 7, x2: 7, y1: 0, y2: 14, stroke: 'var(--ink)', 'stroke-width': 3})
};
const legendMark = (shape, label) => h('span', null, s('svg', {width: 14, height: 14, viewBox: '0 0 14 14', style: 'margin-right:6px'}, LEGEND_SHAPES[shape]()), label);

// ---------- Results ----------

function renderResults(data) {
  const output = h('output', null, fmt(state.minFit));
  const range = h('input', {type: 'range', min: '0', max: '0.95', step: '0.05', value: String(state.minFit), 'aria-label': 'Minimum fit'});
  const body = h('div');
  let pending = false;
  const draw = () => {
    pending = false;
    const shown = {...data, alternatives: data.alternatives.filter(shownOnResults)};
    body.replaceChildren(shown.alternatives.length ? resultsBody(shown, data)
      : h('p', {class: 'lede'}, `No AI alternative has a fit of ${fmt(state.minFit)} or higher in its best field${state.dropMisstated ? ' without misstating a reported result' : ''}.`));
  };
  const redraw = () => { if (!pending) { pending = true; requestAnimationFrame(draw); } };
  range.addEventListener('input', () => {
    state.minFit = Number(range.value);
    output.textContent = fmt(state.minFit);
    redraw();
  });
  const misstated = data.alternatives.filter(alt => alt.review?.verdict === 'contradicts').length;
  const drop = h('input', {type: 'checkbox', checked: state.dropMisstated ? true : null});
  drop.addEventListener('change', () => { state.dropMisstated = drop.checked; redraw(); });
  draw();
  return h('div', null,
    h('div', {class: 'results-intro'}, h('p', null,
      `These results rely on three measures to understand how the focal paper compares to ${data.alternatives.length} AI alternatives: ${data.summary.distance ? 'fit, novelty and distance' : 'fit and novelty'}. Each is described in more detail on the `,
      h('a', {href: `#/${state.caseId}/measures`}, 'Measures'), ' tab. Note that these are not meant to show ', h('em', null, 'better'),
      ' AI alternatives: more novel does not mean better. They show one indication of the space of possibilities and where the focal paper is placed within that space.')),
    h('div', {class: 'filters min-fit', role: 'group', 'aria-label': 'Filters for every panel below'},
      h('div', {class: 'filter-line'},
        h('label', {class: 'group slider'}, h('span', {class: 'group-label'}, 'Minimum fit'), range, output),
        h('span', {class: 'small muted'}, 'Shows only AI alternatives whose fit in their best field is at least this value.')),
      h('div', {class: 'filter-line'},
        h('label', {class: 'group check'}, drop, h('span', {class: 'group-label'}, `Exclude AI alternatives that misstate a reported result (${misstated} of ${data.alternatives.length})`)),
        h('span', {class: 'small muted'}, 'Both filters apply to every panel and count below.'))),
    body);
}

// Every Results panel, drawn from the alternatives that pass the minimum-fit slider. `all` is the
// unfiltered bundle, for "n of N" counts.
function resultsBody(data, all) {
  const filters = h('div', {class: 'filters', role: 'group', 'aria-label': 'Run types shown on the map and the scatter plots'});
  const kinds = h('div', {class: 'group'}, h('span', {class: 'group-label'}, 'Show'),
    [['open', 'Open runs'], ['theory', 'Theory runs'], ['field', 'Field runs']].map(([kind, label]) => {
      const chip = h('button', {type: 'button', class: 'chip', 'aria-pressed': String(state.kinds.has(kind))}, label);
      chip.addEventListener('click', () => {
        if (state.kinds.has(kind) && state.kinds.size === 1) return;
        state.kinds.has(kind) ? state.kinds.delete(kind) : state.kinds.add(kind);
        chip.setAttribute('aria-pressed', String(state.kinds.has(kind)));
        refresh();
      });
      return chip;
    }));
  filters.append(kinds);

  const map = possibilityMap({alternatives: data.alternatives, fields: data.fields, homeField: data.homeField, passes, onSelect: select});
  // Bundles built before Distance was measured offer only Fit and Novelty.
  const pairs = [['fit', 'novelty'], ['fit', 'distance'], ['novelty', 'distance']].filter(pair => !pair.includes('distance') || data.summary.distance);
  const trio = measureTrio({alternatives: data.alternatives, fields: data.fields, original: data.original, passes, onSelect: select, pairs});
  const distinctAnswer = h('div', {class: 'answer'});
  const answers = h('div', {class: 'answers'}, h('h2', null, data.alternatives.length === all.alternatives.length ? `${all.alternatives.length} AI alternatives built on the focal paper's evidence` : `${data.alternatives.length} of ${all.alternatives.length} AI alternatives shown: ${[state.minFit > 0 ? `fit ${fmt(state.minFit)} or higher` : null, state.dropMisstated ? 'none misstating a reported result' : null].filter(Boolean).join(', ')}`), ...headlineAnswers(data), distinctAnswer);

  function refresh() {
    map.update();
    trio.update();
    const count = data.alternatives.filter(alt => passes(alt) && isDistinct(alt)).length;
    distinctAnswer.replaceChildren(
      h('span', {class: 'figure'}, String(count)),
      h('strong', null, 'distinct AI alternatives'),
      h('p', null, 'AI alternatives that Claude\'s comparison places as a different paper from the focal paper, and that are consistent with its reported results. The count follows the minimum-fit slider and the run types shown.'));
  }
  refresh();

  const table = () => dataTable([
    {key: 'title', label: 'AI alternative', className: 'title-cell'},
    {key: 'field', label: 'Fits best'},
    {key: 'fit', label: 'Fit', num: true},
    {key: 'novelty', label: 'Novelty', num: true},
    data.summary.distance ? {key: 'distance', label: 'Distance (percentile)', num: true, render: r => pct(r.distance)} : null,
    {key: 'parts', label: 'Parts replaced', num: true, render: r => String(r.parts ?? '–')}
  ].filter(Boolean), data.alternatives.filter(passes).map(alt => ({id: alt.id, title: alt.outline.title, field: fieldLabel(data, alt.score?.bestField), fit: bestFit(alt), novelty: alt.score?.novelty.score, fitScores: alt.score?.fit[alt.score.bestField]?.scores, noveltyScores: alt.score?.novelty.scores, distance: MEASURES.distance.get(alt), parts: alt.partsReplaced})), {onRow: row => go('results', row.id)});

  const runsOf = kind => data.alternatives.filter(a => a.kind === kind);
  const runCount = kind => { const total = kind ? all.alternatives.filter(a => a.kind === kind).length : all.alternatives.length, n = kind ? runsOf(kind).length : data.alternatives.length; return n === total ? `${n} runs` : `${n} of ${total} runs`; };
  const homeLabel = fieldLabel(data, data.homeField);
  const fieldRuns = runsOf('field').filter(a => a.score);
  const onTarget = fieldRuns.filter(a => a.score.bestField === a.targetId).length;
  const theoryRuns = runsOf('theory').filter(a => a.score);
  const theoryElsewhere = theoryRuns.filter(a => a.score.bestField !== data.homeField);

  return h('div', null,
    runGroup('All runs', runCount(), `Every AI alternative together: ${runsOf('open').length} open, ${runsOf('field').length} field and ${runsOf('theory').length} theory runs. The run-type buttons fade dots on the map and the scatter plots. Each panel is tagged with the measures it uses; select a tag to see how it is measured.`,
      filters,
      h('div', {class: 'hero'},
        h('div', null, h('h2', {class: 'panel-title'}, 'Where each AI alternative went', measureTags(['fit', 'comparison'])), withTableToggle(map.node, table),
          h('p', {class: 'map-caption'}, 'Each dot is an AI alternative. It sits in the sector of the field it fits best; the farther from the center, the more of the focal paper\'s parts it replaced. Select a dot to read it.'),
          fieldLegend(data)),
        answers),
      section([pairs.length > 1 ? 'Fit, Novelty and Distance' : 'Fit and Novelty', measureTags(pairs.length > 1 ? ['fit', 'novelty', 'distance'] : ['fit', 'novelty'])],
        `Every AI alternative, and the focal paper, each in the field where it fits best, with each pair of measures plotted against each other.${pairs.length > 1 ? " Distance here is distance from that field's published papers in the corpus." : ''} Point at a dot to find the same AI alternative in every plot. The rank correlation counts the run types shown and leaves out the focal paper.`,
        h('div', {class: 'panel'}, withTableToggle(trio.node, table), fieldLegend(data, legendMark('star', 'Focal paper')))),
      distanceSections(data)),
    runGroup('Open runs', runCount('open'), 'Each got only the evidence and was asked to write an AI alternative in any field, with any theory.',
      section(['Does it come back to the focal paper?', measureTags(['comparison', 'fit'])], 'Each open run compared with the focal paper. Dots are colored by the field the run fits best.',
        convergenceStrip({alternatives: data.alternatives, fields: data.fields, onSelect: select}))),
    runGroup('Field runs', runCount('field'), `Each was told to write for one field and its journals, ${all.alternatives.filter(a => a.kind === 'field').length / data.fields.length || 0} per field. The scorer was not told which field.`,
      section(['Where did it land?', measureTags(['fit'])], `${onTarget} of ${fieldRuns.length} field runs fit best in the field they were aimed at. Rows are the field each run was written for; columns are the field the scorer says it fits best. The shaded cells are runs that landed where they were aimed.`,
        h('div', {class: 'panel'}, withTableToggle(aimLanding({fields: data.fields, alternatives: data.alternatives, onSelect: select}), () => dataTable([
          {key: 'aim', label: 'Aimed at'}, ...data.fields.map(f => ({key: f.id, label: f.label, num: true})), {key: 'total', label: 'Runs', num: true}
        ], data.fields.map(aim => {
          const row = fieldRuns.filter(a => a.targetId === aim.id);
          return {aim: aim.label, total: row.length, ...Object.fromEntries(data.fields.map(f => [f.id, String(row.filter(a => a.score.bestField === f.id).length)]))};
        }))))),
      section(['Fit in each field', measureTags(['fit', 'comparison'])],'For each field: the focal paper\'s fit, and the fit of each run aimed at that field. The right-hand column shows how many parts the highest-fit run replaced and what evidence it needs.',
        h('div', {class: 'panel'}, withTableToggle(fieldReach({fields: data.fields, alternatives: data.alternatives, original: data.original, onSelect: select}), () => dataTable([
          {key: 'label', label: 'Field'}, {key: 'own', label: 'Focal paper', num: true}, {key: 'mean', label: 'Mean of runs aimed here', num: true}, {key: 'best', label: 'Highest-fit run aimed here', num: true},
          {key: 'parts', label: 'Parts replaced', num: true, render: r => String(r.parts ?? '–')}, {key: 'burden', label: 'Needs'}
        ], fieldReachRows(data).map(f => ({label: f.label, own: f.originalFit, mean: f.meanAimedFit, best: f.bestAimed?.fit, parts: f.bestAimed?.componentsReplaced, burden: f.bestAimed?.burden})))),
        h('div', {class: 'legend', style: {marginTop: '12px'}},
          h('span', null, s('svg', {width: 14, height: 14, viewBox: '0 0 14 14', style: 'margin-right:6px'}, s('path', {d: 'M7 1L13 7L7 13L1 7Z', fill: 'var(--ink)'})), 'Focal paper'),
          h('span', null, h('i', {class: 'swatch', style: {background: 'var(--ink-2)'}}), 'Highest-fit run aimed at the field'),
          h('span', null, h('i', {class: 'swatch', style: {background: 'var(--surface)', boxShadow: 'inset 0 0 0 2px var(--ink-2)'}}), 'Other runs aimed at it'))))),
    runGroup('Theory runs', runCount('theory'), `One run per theory, each told to build an AI alternative on that theory and write for ${homeLabel.toLowerCase()}.`,
      section(['Fit of each theory run', measureTags(['fit'])],`Each row is one AI alternative. The first dot is its fit in ${homeLabel.toLowerCase()}, the field it was written for. ${theoryElsewhere.length} of ${theoryRuns.length} have a higher fit in another field; for those, a second dot in that field's color shows the fit there, joined to the first by a line.`,
        h('div', {class: 'panel'}, withTableToggle(theoryChart({alternatives: data.alternatives, fields: data.fields, homeField: data.homeField, original: data.original, onSelect: select}), () => dataTable([
          {key: 'theory', label: 'Theory'}, {key: 'home', label: `Fit in ${homeLabel}`, num: true}, {key: 'bestField', label: 'Fits best'}, {key: 'best', label: 'Best fit', num: true}, {key: 'novelty', label: 'Novelty', num: true}
        ], runsOf('theory').map(alt => ({id: alt.id, theory: alt.target, home: alt.score?.fit[data.homeField]?.score, bestField: fieldLabel(data, alt.score?.bestField), best: bestFit(alt), novelty: alt.score?.novelty.score})), {onRow: row => go('results', row.id)})),
          theoryLegend(data, theoryElsewhere))))
  );
}

// The Distance panels for All runs. Distance is a model-free measure, so each panel says so and
// sets it beside Claude's judgements rather than merging it into them.
function distanceSections(data) {
  const dist = data.summary.distance;
  const measured = data.alternatives.filter(alt => alt.distance && alt.score);
  if (!dist || !measured.length) return null;
  const familyMeans = ['same-paper', 'close-variant', 'different-paper'].map(f => [f, measured.filter(alt => alt.review?.family === f).map(alt => alt.distance.fromOriginal)]).filter(([, values]) => values.length)
    .map(([f, values]) => `${fmt(values.reduce((a, b) => a + b, 0) / values.length)} for its ${values.length} ${familyText(f).toLowerCase()}${values.length === 1 ? '' : 's'}`).join(' and ');
  const median = values => { const v = values.filter(x => x !== null && x !== undefined).sort((a, b) => a - b); return v.length ? (v[Math.floor((v.length - 1) / 2)] + v[Math.ceil((v.length - 1) / 2)]) / 2 : null; };
  const scored = measured.filter(alt => alt.distance.toPublishedPercentile[alt.score.bestField] !== undefined);
  const rho = rankCorrelation(scored.map(alt => alt.score.novelty.score), scored.map(alt => alt.distance.toPublishedPercentile[alt.score.bestField]));
  const agree = measured.filter(alt => alt.distance.topNeighbourField === alt.score.bestField).length;
  const percentileRows = [...data.fields, {id: 'all', label: 'All fields'}];
  const neighbourColumns = data.fields.map(f => f.id);
  return [
    section(['How far did each move from the focal paper?', measureTags(['distance', 'comparison'])], `Each AI alternative's distance from the focal paper, grouped by Claude's comparison with it.${familyMeans ? ` The mean is ${familyMeans}.` : ''} Dots are colored by the field each fits best.`,
      h('div', {class: 'panel'}, withTableToggle(distanceFromOriginal({alternatives: data.alternatives, fields: data.fields, referenceMedian: dist.referenceMedian?.all, onSelect: select}), () => dataTable([
        {key: 'title', label: 'AI alternative', className: 'title-cell'}, {key: 'family', label: "Claude's comparison"}, {key: 'parts', label: 'Parts replaced', num: true, render: r => String(r.parts ?? '–')}, {key: 'distance', label: 'Distance from focal paper', num: true}
      ], measured.map(alt => ({id: alt.id, title: alt.outline.title, family: familyText(alt.review?.family), parts: alt.partsReplaced, distance: alt.distance.fromOriginal})), {onRow: row => go('results', row.id)})), fieldLegend(data, legendMark('line', 'Mean of the group')))),
    section(['How far is each from the published corpus?', measureTags(['distance'])], `The distance of the focal paper and of each AI alternative from the published papers in each field of the corpus, as a percentile: 50 is the typical published paper in that field, higher is further away. Each AI alternative appears once in every row.${rho === null ? '' : ` In each AI alternative's best field, this and Claude's Novelty ${rho <= -0.3 ? 'tend to disagree' : rho < 0.3 ? 'are largely unrelated' : rho < 0.6 ? 'agree only loosely' : 'mostly agree'} (rank correlation ${fmt(rho)}).`}`,
      h('div', {class: 'panel'}, withTableToggle(distanceFromPublished({alternatives: data.alternatives, fields: data.fields, original: data.original, onSelect: select}), () => dataTable([
        {key: 'label', label: 'Field'}, {key: 'own', label: 'Focal paper (percentile)', num: true, render: r => pct(r.own)}, {key: 'median', label: "AI alternatives' median", num: true, render: r => pct(r.median)}
      ], percentileRows.map(f => ({label: f.label, own: dist.original?.toPublishedPercentile?.[f.id], median: median(measured.map(alt => alt.distance.toPublishedPercentile?.[f.id]))})))), fieldLegend(data, legendMark('diamond', 'Focal paper'), legendMark('line', "AI alternatives' median")))),
    section(['Do its nearest published papers come from the field Claude picked?', measureTags(['fit', 'distance'])], `Each dot is an AI alternative. Its row is the field Claude says it fits best; its column is the field of its nearest published papers in the corpus. The two agree for ${agree} of ${measured.length} AI alternatives (shaded cells). Select a dot to read it.`,
      h('div', {class: 'panel'}, withTableToggle(neighbourAgreement({fields: data.fields, alternatives: data.alternatives, onSelect: select}), () => dataTable([
        {key: 'row', label: 'Claude: fits best'}, ...neighbourColumns.map(id => ({key: id, label: fieldLabel(data, id), num: true})), {key: 'total', label: 'AI alternatives', num: true}
      ], data.fields.map(row => {
        const inRow = measured.filter(alt => alt.score.bestField === row.id);
        return {row: row.label, total: inRow.length, ...Object.fromEntries(neighbourColumns.map(id => [id, String(inRow.filter(alt => alt.distance.topNeighbourField === id).length)]))};
      })))))
  ];
}

// A band that opens each group of results built from the same subset of runs.
function runGroup(title, count, lede, ...body) {
  return h('div', {class: 'run-group'},
    h('header', {class: 'run-group-head'}, h('h2', null, title, h('span', {class: 'run-count'}, count)), h('p', {class: 'lede'}, lede)),
    ...body);
}

function theoryLegend(data, elsewhere) {
  const homeLabel = fieldLabel(data, data.homeField);
  const others = data.fields.filter(f => f.id !== data.homeField && elsewhere.some(a => a.score.bestField === f.id));
  const pair = s('svg', {width: 40, height: 14, viewBox: '0 0 40 14', style: 'margin-right:6px'},
    s('line', {x1: 7, x2: 33, y1: 7, y2: 7, stroke: 'var(--axis)', 'stroke-width': 1.5}),
    s('circle', {cx: 7, cy: 7, r: 5, fill: fieldColor(data.homeField)}),
    s('circle', {cx: 33, cy: 7, r: 5, fill: 'var(--muted)'}));
  return h('div', {class: 'legend', style: {marginTop: '12px'}},
    h('span', null, h('i', {class: 'swatch', style: {background: fieldColor(data.homeField)}}), `Fit in ${homeLabel}`),
    h('span', null, pair, 'Higher fit in another field: fit there'),
    others.map(f => h('span', null, h('i', {class: 'swatch', style: {background: fieldColor(f.id)}}), f.label)),
    h('span', null, s('svg', {width: 10, height: 14, viewBox: '0 0 10 14', style: 'margin-right:6px'}, s('line', {x1: 5, x2: 5, y1: 0, y2: 14, stroke: 'var(--ink)', 'stroke-width': 1.5})), `The focal paper's fit in ${homeLabel}`));
}

// For each field: the paper's fit, and the mean and highest fit there among the shown runs aimed at
// it. The same rule as the report's field reach, applied to the alternatives the slider leaves.
function fieldReachRows(data) {
  return data.fields.map(field => {
    const fitIn = alt => alt.score?.fit[field.id]?.score ?? null;
    const aimed = data.alternatives.filter(alt => alt.kind === 'field' && alt.targetId === field.id && fitIn(alt) !== null);
    const best = [...aimed].sort((a, b) => fitIn(b) - fitIn(a))[0];
    return {fieldId: field.id, label: field.label, originalFit: data.original?.fit[field.id]?.score ?? null,
      meanAimedFit: aimed.length ? aimed.reduce((sum, alt) => sum + fitIn(alt), 0) / aimed.length : null,
      bestAimed: best ? {fit: fitIn(best), componentsReplaced: best.partsReplaced, burden: best.burden} : null};
  });
}

function headlineAnswers(data) {
  const {homeField} = data;
  const open = data.alternatives.filter(a => a.kind === 'open');
  const same = open.filter(a => a.review?.family === 'same-paper').length, close = open.filter(a => a.review?.family === 'close-variant').length;
  const reach = fieldReachRows(data);
  const home = reach.find(f => f.fieldId === homeField);
  const homeLabel = fieldLabel(data, homeField);
  const other = reach.filter(f => f.fieldId !== homeField && f.bestAimed).sort((a, b) => b.bestAimed.fit - a.bestAimed.fit)[0];
  const answer = (lead, text) => h('div', {class: 'answer'}, h('strong', null, lead), h('p', null, text));
  const list = [answer(`Open runs compared with the focal paper (${open.length})`,
    `Same paper: ${same}. Close variant: ${close}. Different paper: ${open.length - same - close}.`)];
  const homeAnswer = home && home.originalFit !== null && homeFieldAnswer(data, home, homeLabel);
  if (homeAnswer) list.push(answer(...homeAnswer));
  if (other) {
    list.push(answer(`Highest fit among runs aimed at another field`, `${other.label}: ${fmt(other.bestAimed.fit)} (the focal paper: ${fmt(other.originalFit)}). That run replaced ${other.bestAimed.componentsReplaced} of the focal paper's ${data.parts.length} parts and needs ${other.bestAimed.burden}.`));
  }
  return list;
}

// The paper's fit in its home field beside the highest fit there among alternatives consistent with the
// evidence, and among runs aimed at that field. Reports the numbers only.
function homeFieldAnswer(data, home, label) {
  const fitOf = alt => alt.score?.fit[data.homeField]?.score ?? null;
  const valid = data.alternatives.filter(alt => alt.review?.verdict === 'consistent' && fitOf(alt) !== null);
  if (!valid.length) return null;
  const top = Math.max(...valid.map(fitOf));
  const names = valid.filter(alt => fitOf(alt) === top).map(alt => alt.kind === 'theory' ? alt.target : alt.kind === 'open' ? 'an open run'
    : `a run aimed at ${alt.target}`).join(' and ');
  const aimed = home.bestAimed ? ` Highest among runs aimed at the field: ${fmt(home.bestAimed.fit)}.` : '';
  return [`Fit in ${label}`, `The focal paper: ${fmt(home.originalFit)}. Highest among AI alternatives: ${fmt(top)} (${names}).${aimed}`];
}

// ---------- The paper ----------

function renderPaper(data) {
  const {paper} = data, e = paper.evidence, f = paper.framing;
  const row = (title, ...content) => h('div', {class: 'field-row'}, h('h3', null, title), ...content);
  const varNames = Object.fromEntries(e.variables.map(v => [v.id, v.name]));
  const runs = data.alternatives;
  const theories = runs.filter(a => a.kind === 'theory').map(a => a.target);
  const fieldRuns = runs.filter(a => a.kind === 'field');
  return h('div', null,
    h('div', {class: 'anatomy'},
      h('div', {class: 'panel'},
        h('h2', null, lockIcon(true), 'Held fixed: the evidence'),
        h('p', {class: 'lede'}, 'Everything the generator sees. Written in measurement terms from the data, methods and results tables, with the focal paper\'s own constructs kept out.'),
        row('Unit of analysis', h('p', null, e.unitOfAnalysis)),
        row('Sample', h('p', null, e.sample)),
        row('Variables', dataTable([{key: 'id', label: 'Id'}, {key: 'role', label: 'Role'}, {key: 'name', label: 'Measured as'}], e.variables.map(v => ({id: v.id, role: v.role, name: `${v.name}. ${v.measurement}`})))),
        row(`Results (${e.results.length} estimates)`, resultsTable(e.results, varNames)),
        row('Design facts', h('ul', {class: 'notes'}, e.designFacts.map(fact => h('li', null, fact)))),
        row('Automatic leak check', h('p', null, paper.leakCheck.flagged === 0 ? 'No framing terms, hypothesis labels or theory names were found in the evidence.' : `${paper.leakCheck.flagged} phrases were flagged and ${paper.leakCheck.repaired ? 'reworded' : 'left for review'}; ${paper.leakCheck.remaining} remain.`))),
      h('div', {class: 'panel'},
        h('h2', null, lockIcon(false), 'Varied: the framing'),
        h('p', {class: 'lede'}, 'How the authors tell the story. Withheld from the generator and used only to compare each AI alternative with the focal paper.'),
        row('Research question', h('p', {class: 'serif'}, f.researchQuestion)),
        row('Scholarly conversation', h('p', {class: 'serif'}, f.conversation)),
        row('Theory', h('p', {class: 'serif'}, f.theory)),
        row('Mechanism', h('p', {class: 'serif'}, f.mechanism)),
        row('Contribution', h('p', {class: 'serif'}, f.contribution)),
        row('Terms kept out of the evidence', h('div', {class: 'construct-chips'}, paper.constructs.map(c => h('span', {title: c.meaning}, c.term)))),
        row('Coded as', h('p', null, `Primary theory: ${paper.codes.primaryTheory}. Topics: ${paper.codes.topics.map(t => t.split(' > ').slice(-1)[0]).join(', ')}.`)))),
    section('What was varied', 'Every run gets the same locked evidence and writes one AI alternative, as a complete outline, in a fresh call.',
      h('div', {class: 'runs-diagram'},
        h('div', {class: 'run-card'}, h('h3', null, 'Open runs'), h('span', {class: 'count'}, String(runs.filter(a => a.kind === 'open').length)), h('p', null, 'Free to choose any field, conversation and theory. They show where the evidence goes on its own, and how often it returns to the focal paper.')),
        h('div', {class: 'run-card'}, h('h3', null, 'Theory runs'), h('span', {class: 'count'}, String(theories.length)), h('p', null, `One per theory, written for ${fieldLabel(data, data.homeField).toLowerCase()}: the fine-grained perturbation.`), h('div', {class: 'tags'}, theories.map(t => h('span', null, t)))),
        h('div', {class: 'run-card'}, h('h3', null, 'Field runs'), h('span', {class: 'count'}, String(fieldRuns.length)), h('p', null, 'Several per field, each written for that field\'s journals: the coarse perturbation.'), h('div', {class: 'tags'}, data.fields.map(field => h('span', null, `${field.label} ×${fieldRuns.filter(a => a.targetId === field.id).length}`)))))),
    focalMeasures(data)
  );
}

// The measures the focal paper gets: everything from the scoring call and the text embeddings.
// The review call's measures and Distance from the focal paper compare an AI alternative with it.
function focalMeasures(data) {
  const sc = data.original, d = sc?.distance, dist = data.summary.distance;
  if (!sc) return null;
  const link = (id, text) => h('a', {href: `#/${state.caseId}/measures/${id}`}, text);
  const best = sc.bestField, top = d?.topNeighbourField;
  return section('The focal paper\'s measures',
    h('span', null, 'Scored and measured the same way as every AI alternative; the scoring call is not told which is the focal paper. ', link('comparison', 'Claude\'s comparison'), ', the ', link('part-ratings', 'part ratings'), ', the ', link('evidence', 'evidence check'), dist ? [' and ', link('distance', 'distance from the focal paper')] : null, ' compare an AI alternative with the focal paper, so it has none of them.'),
    h('div', {class: 'anatomy'},
      h('div', {class: 'panel'},
        h('h3', null, link('fit', 'Fit by field')),
        h('div', {class: 'fitbars with-scorings'}, data.fields.map(field => {
          const value = sc.fit[field.id]?.score ?? 0;
          return [h('span', null, field.id === best ? h('strong', null, field.label) : field.label),
            h('div', {class: 'track', title: sc.fit[field.id]?.reason || ''}, h('div', {class: 'bar', style: {width: `${value * 100}%`, background: fieldColor(field.id)}})),
            h('span', {class: 'val'}, scoreCell(value, sc.fit[field.id]?.scores))];
        })),
        h('p', {class: 'small muted'}, `Bold is the `, link('field', 'field it fits best'), `: the highest mean Fit.${(sc.scorings || 1) > 1 ? ` Each scoring is shown under the mean.` : ''}`),
        h('h3', null, link('novelty', 'Novelty'), ` in ${fieldLabel(data, best).toLowerCase()}: ${fmt(sc.novelty.score)}`),
        (sc.scorings || 1) > 1 ? h('p', {class: 'small muted'}, `Scorings: ${sc.novelty.scores.map(fmt).join(' · ')}.`) : null,
        h('p', {class: 'notes'}, sc.novelty.reason),
        sc.novelty.closest?.length ? citedList(data, sc.novelty.closest) : null),
      d && dist ? h('div', {class: 'panel'},
        h('h3', null, link('published', 'Distance from the published corpus')),
        h('table', {class: 'data-table scorings'},
          h('thead', null, h('tr', null, h('th', {scope: 'col'}, 'Field'), h('th', {class: 'num', scope: 'col'}, 'Percentile'))),
          h('tbody', null, [...data.fields, {id: 'all', label: 'All fields'}].map(field => h('tr', null,
            h('th', {scope: 'row'}, field.id === best ? h('strong', null, field.label) : field.label),
            h('td', {class: 'num'}, field.id === best ? h('strong', null, pct(d.toPublishedPercentile[field.id])) : pct(d.toPublishedPercentile[field.id])))))),
        h('p', {class: 'small muted'}, '50 is the typical published paper in that field; higher is further away. Bold is the field it fits best.'),
        h('h3', null, link('neighbours', 'Field of the nearest published papers'), `: ${top ? fieldLabel(data, top).toLowerCase() : 'none of the fields'}`),
        top ? h('p', {class: 'small muted'}, `${Math.round((d.neighbourFields?.[top] ?? 0) * 100)}% of its ${dist.settings.fieldNeighbours} nearest published papers in the corpus are in ${fieldLabel(data, top).toLowerCase()}, the field most over-represented relative to its share of the corpus.`) : null,
        d.nearest?.length ? [h('h3', null, 'Nearest published papers in the corpus'), citedList(data, d.nearest)] : null) : null));
}

// The first dozen estimates, with the rest behind a toggle.
function resultsTable(results, varNames) {
  const rows = results.map(r => ({id: r.id, term: `${r.term} on ${varNames[r.outcomeId] || r.outcomeId}`, est: `${r.estimate}${r.standardError ? ` (${r.standardError})` : ''}`, sig: r.significance, where: r.location}));
  const columns = [{key: 'id', label: 'Id'}, {key: 'term', label: 'Term'}, {key: 'est', label: 'Estimate (SE)'}, {key: 'sig', label: 'Significance'}, {key: 'where', label: 'Where', className: 'hide-sm'}];
  const holder = h('div', null, dataTable(columns, rows.slice(0, 12)));
  if (rows.length > 12) {
    const toggle = h('button', {type: 'button', class: 'link-button small table-toggle'}, `Show all ${rows.length} estimates`);
    let all = false;
    toggle.addEventListener('click', () => {
      all = !all;
      holder.replaceChildren(dataTable(columns, all ? rows : rows.slice(0, 12)));
      toggle.textContent = all ? 'Show the first 12' : `Show all ${rows.length} estimates`;
    });
    return h('div', null, holder, toggle);
  }
  return holder;
}

// ---------- Alternatives ----------

// The mean in the table's type, with each scoring beneath it in small muted figures.
const scoreCell = (mean, scores) => scores?.length > 1
  ? h('span', {class: 'score-cell'}, fmt(mean), h('span', {class: 'scorings', 'aria-label': `scorings ${scores.map(fmt).join(', ')}`}, scores.map(fmt).join(' · ')))
  : fmt(mean);

function renderAlternatives(data) {
  const stab = data.summary.stability, scorings = stab?.method === 'replicates' ? stab.replicates : 1;
  const filters = {kind: 'all', field: 'all', family: 'all', text: ''};
  const holder = h('div');
  const control = (label, key, options) => {
    const sel = h('select', {'aria-label': label}, options.map(([value, text]) => h('option', {value}, text)));
    sel.addEventListener('change', () => { filters[key] = sel.value; render(); });
    return h('label', {class: 'group'}, h('span', {class: 'group-label'}, label), sel);
  };
  const search = h('input', {type: 'search', placeholder: 'Search titles and theories', 'aria-label': 'Search AI alternatives', class: 'chip', style: {minWidth: '240px'}});
  search.addEventListener('input', () => { filters.text = search.value.toLowerCase(); render(); });
  const bar = h('div', {class: 'filters'},
    control('Run', 'kind', [['all', 'All runs'], ['open', 'Open'], ['theory', 'Theory'], ['field', 'Field']]),
    control('Fits best', 'field', [['all', 'Any field'], ...data.fields.map(f => [f.id, f.label])]),
    control('Compared with the focal paper', 'family', [['all', 'Any'], ['same-paper', 'Same paper'], ['close-variant', 'Close variant'], ['different-paper', 'Different paper']]),
    search);
  function render() {
    const rows = data.alternatives.filter(alt =>
      (filters.kind === 'all' || alt.kind === filters.kind) &&
      (filters.field === 'all' || alt.score?.bestField === filters.field) &&
      (filters.family === 'all' || alt.review?.family === filters.family) &&
      (!filters.text || `${alt.outline.title} ${alt.outline.theory.primary} ${alt.target || ''}`.toLowerCase().includes(filters.text)));
    holder.replaceChildren(
      h('p', {class: 'muted small'}, `${rows.length} of ${data.alternatives.length} AI alternatives. Select a row to read it.${scorings > 1 ? ` Fit and Novelty show the mean of ${scorings} scorings, with each scoring beneath it.` : ''} The Measures tab explains each column.`),
      dataTable([
        {key: 'title', label: 'AI alternative', className: 'title-cell'},
        {key: 'run', label: 'Run', className: 'hide-sm'},
        {key: 'field', label: 'Fits best', render: r => h('span', null, h('i', {class: 'swatch', style: {background: fieldColor(r.fieldId)}}), r.field)},
        {key: 'fit', label: 'Fit', num: true, render: r => scoreCell(r.fit, r.fitScores)},
        {key: 'novelty', label: 'Novelty', num: true, render: r => scoreCell(r.novelty, r.noveltyScores)},
        {key: 'fitVar', label: 'Fit variance', num: true, className: 'hide-md', render: r => fmtVariance(r.fitVar)},
        {key: 'noveltyVar', label: 'Novelty variance', num: true, className: 'hide-md', render: r => fmtVariance(r.noveltyVar)},
        {key: 'family', label: 'Compared with the focal paper', className: 'hide-sm'},
        {key: 'parts', label: 'Parts replaced', num: true, render: r => String(r.parts ?? '–')},
        {key: 'fromOriginal', label: 'Distance from focal paper', num: true, className: 'hide-sm'},
        {key: 'published', label: 'Distance from published corpus (percentile)', num: true, className: 'hide-sm', render: r => pct(r.published)},
        {key: 'burden', label: 'Needs', className: 'hide-sm'},
        {key: 'check', label: 'Evidence', render: r => h('span', {style: {display: 'inline-flex', gap: '6px', alignItems: 'center'}}, h('span', {style: {width: '16px', height: '16px', display: 'inline-block'}}, checkIcon(r.check === 'consistent')), r.check === 'consistent' ? 'Consistent' : 'Misstates a result')}
      ], rows.map(alt => ({id: alt.id, title: alt.outline.title, run: kindText(alt), fieldId: alt.score?.bestField, field: fieldLabel(data, alt.score?.bestField), fit: bestFit(alt), novelty: alt.score?.novelty.score, fitScores: alt.score?.fit[alt.score.bestField]?.scores, noveltyScores: alt.score?.novelty.scores, fitVar: alt.score?.fit[alt.score.bestField]?.variance ?? null, noveltyVar: alt.score?.novelty.variance ?? null, family: familyText(alt.review?.family), parts: alt.partsReplaced, fromOriginal: alt.distance?.fromOriginal ?? null, published: alt.distance?.toPublishedPercentile[alt.score?.bestField] ?? null, burden: alt.burden, check: alt.review?.verdict})), {onRow: row => go('alternatives', row.id)}));
  }
  render();
  return h('div', null, bar, holder);
}

// ---------- Measures ----------

// What each measure on the Results and Alternatives tabs is, who produces it and how to read it.
// The panels elsewhere keep only a line on how to read the chart and link here for the rest.
function renderMeasures(data) {
  const {summary} = data, dist = summary.distance, stab = summary.stability;
  const labels = data.fields.map(f => f.label);
  const fieldList = `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`.toLowerCase();
  const years = `${data.corpusWindow.fromYear}–${Math.min(data.corpusWindow.toYear, Number(yearOf(data.paper.identity.year)) || data.corpusWindow.toYear)}`;
  const scorings = stab?.method === 'replicates' ? stab.replicates : 1;
  const fromOriginal = data.alternatives.map(a => a.distance?.fromOriginal).filter(v => v !== null && v !== undefined);
  const scale = (...bands) => h('ul', {class: 'scale'}, bands.map(([range, text]) => h('li', null, h('span', {class: 'range'}, range), text)));
  const entry = (id, title, by, ...body) => h('section', {class: 'measure', id: `measure-${id}`},
    h('h3', null, title), h('p', {class: 'measure-by'}, by), ...body);

  const link = id => `#/${state.caseId}/measures/${id}`;

  // Where each measure comes from: one card per call (or the embeddings), the measures it produces,
  // and the measures derived from them by a rule. The cross-checks below link the model-free
  // measures to the Claude measures they check.
  const item = (id, name, note) => h('li', null, h('a', {href: link(id)}, name), h('span', null, note));
  const source = (kind, name, what, measures, derived) => h('div', {class: 'mm-source'},
    h('p', {class: 'mm-kind'}, kind), h('h3', null, name), h('p', {class: 'mm-what'}, what),
    h('ul', {class: 'mm-measures'}, measures),
    derived ? h('div', {class: 'mm-derived'}, h('p', {class: 'mm-rule'}, h('span', {'aria-hidden': 'true'}, '↓ '), derived[2]), h('ul', {class: 'mm-measures'}, item(derived[0], derived[1], 'Derived by a rule'))) : null);
  const map = h('figure', {class: 'measure-map'},
    h('div', {class: 'mm-sources'},
      source('Claude', 'Scoring call', `The focal paper and each AI alternative, ${scorings > 1 ? `${scorings} times each` : 'once each'}. Claude reads the most similar published papers in the corpus from each field, found by word overlap${dist ? ' and text embeddings' : ''}, and is not told which is the focal paper.`,
        [item('fit', 'Fit', '0 to 1, in each field'), item('novelty', 'Novelty', '0 to 1, in the field that scoring names best')],
        ['field', 'Field it fits best', 'The field with the highest mean Fit']),
      source('Claude', 'Review call', 'Each AI alternative once, beside the focal paper and its reported results. The focal paper is not reviewed, since it would be compared with itself.',
        [item('comparison', "Claude's comparison", 'Same paper, close variant or different paper'), item('part-ratings', 'Part ratings', `Unchanged to replaced, for each of ${data.parts.length} parts`), item('evidence', 'Evidence check', 'Consistent or misstates a result')],
        ['parts', 'Parts replaced', 'Count of parts rated “replaced”']),
      dist ? source('No model judgement', 'Text embeddings', 'The title and abstract of the focal paper, of each AI alternative and of the published papers in the corpus.',
        [item('distance', 'Distance from the focal paper', 'Cosine distance'), item('published', 'Distance from the published corpus', 'Percentile, in each field'), item('neighbours', 'Field of the nearest published papers', 'One field')]) : null),
    dist ? h('figcaption', null, h('strong', null, 'Model-free checks. '),
      h('a', {href: link('distance')}, 'Distance from the focal paper'), ' checks ', h('a', {href: link('comparison')}, "Claude's comparison"), '; ',
      h('a', {href: link('neighbours')}, 'field of the nearest published papers'), ' checks ', h('a', {href: link('field')}, 'field it fits best'), '; ',
      h('a', {href: link('published')}, 'distance from the published corpus'), ' is shown beside ', h('a', {href: link('novelty')}, 'Novelty'), '. None feeds into the measure it checks.') : null);
  const group = title => h('h2', {class: 'measure-group'}, title);

  return h('div', {class: 'prose measures'},
    h('p', {class: 'lede'}, `Every measure comes from one of ${dist ? 'three' : 'two'} sources. Claude's scoring call scores the focal paper and every AI alternative without being told which is the focal paper. Claude's review call compares each AI alternative with the focal paper, so its measures apply only to AI alternatives.${dist ? ' Text embeddings compare texts with no model judgement.' : ''} Two measures are derived from the others by a rule. The measured ones come first below, then the derived ones.`),
    map,

    group('Measured in the scoring call'),
    entry('fit', 'Fit', `Claude · 0 to 1 · scored for each of the ${data.fields.length} fields`,
      h('p', null, `Would editors and reviewers in a field see the focal paper, or an AI alternative, as belonging in their field, given its question, unit of analysis, theory, outcomes and evidence? The fields are ${fieldList}. For each field Claude gets a short description of it and the six most similar published papers in the corpus from that field's leading journals, published ${years}, found by word overlap and by similarity of meaning.`),
      scale(['0.90–1.00', 'A natural fit for the field'], ['0.70–0.89', 'Clearly positionable with some adjustment'], ['0.40–0.69', 'Could be positioned, but reviewers would ask why it belongs'], ['0.10–0.39', 'A poor fit'], ['0.00–0.09', 'Does not belong']),
      h('p', null, scorings > 1
        ? `The focal paper and every AI alternative are each scored ${scorings} times in separate calls, and the Fit shown is the mean. Two scorings of the same one differ by ${fmt(stab.meanAbsFitDifference)} on average; each scoring is shown under the mean on the AI alternatives tab.`
        : 'The focal paper and each AI alternative were scored once in this run.')),

    entry('novelty', 'Novelty', 'Claude · 0 to 1 · in the field it fits best',
      h('p', null, 'How new the question or explanation of the focal paper, or of an AI alternative, is within the field it fits best, judged against the most similar published papers in the corpus from that field and Claude\'s knowledge of it. It is scored in the same call as Fit, in the field that call names best.'),
      scale(['0.90–1.00', 'A clearly new question or explanation'], ['0.70–0.89', 'A meaningful extension'], ['0.40–0.69', 'Incremental'], ['0.10–0.39', 'Largely done before'], ['0.00–0.09', 'Duplicates existing work']),
      h('p', null, scorings > 1
        ? `The Novelty shown is the mean of the ${scorings} scorings, each in the field that scoring named best. Two scorings differ by ${fmt(stab.meanAbsNoveltyDifference)} on average.`
        : 'The focal paper and each AI alternative were scored once in this run.')),

    group('Measured in the review call'),
    entry('comparison', "Claude's comparison with the focal paper", 'Claude · one of three groups',
      h('p', null, 'The review call reads the focal paper\'s framing and the AI alternative side by side and places the AI alternative in one of three groups:'),
      scale(['Same paper', 'Question, theory and contribution are substantively the same'], ['Close variant', 'Shares the core question or theory but differs in one major respect'], ['Different paper', 'Differs in two or more of question, theory and contribution']),
      h('p', null, 'Sharing the data and the vocabulary does not make it the same paper.')),

    entry('part-ratings', 'Part ratings', `Claude · one of four steps · for each of ${data.parts.length} parts`,
      h('p', null, `The review call also compares the AI alternative with the focal paper part by part: ${data.parts.map(p => PART_LABEL[p].toLowerCase()).join(', ')}. Each part is rated on four steps:`),
      scale(['Unchanged', 'The same substance, perhaps reworded'], ['Refined', 'The same idea, narrowed or sharpened'], ['Reframed', 'The same core idea through a different lens or emphasis'], ['Replaced', 'A different idea']),
      h('p', null, 'Each AI alternative\'s ratings are shown part by part when you open it.')),

    entry('evidence', 'Evidence check', 'Claude · consistent or misstates a result',
      h('p', null, 'The review call also checks each AI alternative against the focal paper\'s reported results. It misstates a result only if it gets the outcome or predictor wrong, reverses a direction, presents an unreported result as found, or claims stronger significance than reported.'),
      h('p', null, 'Everything else is recorded as a flag, not a failure: a mechanism theorized but not measured, causal language the design cannot support, or a central hypothesis that needs re-analysis or new data.'),
      h('p', null, 'What it needs is taken from the AI alternative\'s own hypotheses: “new data” if any needs new data, otherwise “re-analysis” if any needs a re-analysis of the existing data, otherwise “reported results”.')),

    dist ? group('Measured with text embeddings') : null,
    dist ? entry('distance', 'Distance from the focal paper', `Text embeddings · cosine distance · no model judgement`,
      h('p', null, `The title and abstract of the focal paper and of each AI alternative are turned into text embeddings with ${dist.model}. Distance from the focal paper is the cosine distance between an AI alternative's embedding and the focal paper's: 0 means the same meaning, and larger is further apart.${fromOriginal.length ? ` Here the AI alternatives range from ${fmt(Math.min(...fromOriginal))} to ${fmt(Math.max(...fromOriginal))}.` : ''} For scale, a published paper in the corpus is on average ${fmt(dist.referenceMedian?.all)} from its ${dist.settings.neighbours} nearest published papers in the corpus (median published paper).`),
      h('p', null, `The focal paper is represented by ${dist.originalAbstract === 'own' ? "its authors' own abstract" : 'a summary written from it'}, and the AI alternatives by abstracts Claude wrote. Compare the AI alternatives with each other rather than reading the numbers as absolute. Distance measures how far apart two texts are, not whether the ideas differ, so it is a check on Claude's comparison rather than a replacement for it.`)) : null,

    dist ? entry('published', 'Distance from the published corpus', 'Text embeddings · percentile · for each field',
      h('p', null, `For each field: the mean distance of the focal paper, or of an AI alternative, to its ${dist.settings.neighbours} nearest published papers in that field (of ${dist.corpusArticles.toLocaleString('en')} published papers in the corpus up to ${dist.corpusMaxYear}), as a percentile of the same distance for the published papers in that field (up to ${dist.settings.referenceSample.toLocaleString('en')} sampled per field).`),
      scale(['50', 'As far from its nearest published papers as the typical published paper in the field'], ['Above 50', 'Further from the field\'s published papers than most of them are from each other'], ['Below 50', 'Closer to the field\'s published papers than most of them are to each other']),
      h('p', null, 'It is not Novelty: the focal paper or an AI alternative can sit among many published papers and still ask a new question. The panels show it beside Novelty so the two can be compared.')) : null,

    dist ? entry('neighbours', 'Field of the nearest published papers', 'Text embeddings · one field',
      h('p', null, `Of the ${dist.settings.fieldNeighbours} published papers in the whole corpus nearest to the focal paper or an AI alternative, the field most over-represented relative to its share of the corpus. Taking shares into account keeps larger fields from winning only because they have more published papers.`),
      h('p', null, 'It is a model-free check on the field Claude says the focal paper or an AI alternative fits best; it is not used to assign the field.')) : null,

    group('Derived from other measures'),
    entry('field', 'Field it fits best', 'A rule on Fit, not a separate judgement',
      h('p', null, `The field of the focal paper, or of an AI alternative, is the one with the highest mean Fit. If two fields tie, it is the one the scorings named most often.${scorings > 1 && stab.bestFieldAgreement !== undefined ? ` Two scorings of the same one named the same best field ${Math.round(stab.bestFieldAgreement * 100)}% of the time.` : ''}`),
      h('p', null, dist
        ? 'Distance plays no part in assigning the field. Embeddings help choose which published papers in the corpus Claude reads before scoring, and they give a separate, model-free check: the field of the nearest published papers (above).'
        : 'Distance plays no part in assigning the field.'),
      h('p', null, '“Where each AI alternative went” places each dot in the sector of this field.')),

    entry('parts', 'Parts replaced', `A count of the part ratings · 0 to ${data.parts.length}`,
      h('p', null, `The number of the ${data.parts.length} parts rated “replaced” in the part ratings above. On “Where each AI alternative went”, the more parts replaced, the farther the dot sits from the center.`))
  );
}

// ---------- Method ----------

function renderMethod(data) {
  const {summary} = data;
  const cost = Object.values(summary.costByStage).reduce((sum, stage) => sum + stage.costUsd, 0);
  const calls = Object.values(summary.costByStage).reduce((sum, stage) => sum + stage.calls, 0);
  return h('div', {class: 'prose'},
    h('h2', null, 'How the AI alternatives are made'),
    h('ol', null,
      h('li', null, h('strong', null, 'Deconstruct. '), 'Claude reads the PDF twice. One pass records the framing in the authors\' terms and lists the constructs they name. The other records only data and results, in measurement terms, with those constructs banned. An automatic check rejects any leak.'),
      h('li', null, h('strong', null, 'Generate. '), 'Each AI alternative is a separate call that sees only the evidence. Open runs choose freely; theory runs get one theory; field runs are aimed at one field\'s journals.'),
      h('li', null, h('strong', null, 'Review. '), 'A separate review call checks each AI alternative against the focal paper\'s reported results. It fails only if it misstates a result; untested mechanisms, causal language and needs for new data are recorded as flags. The review call also compares the AI alternative with the focal paper as a whole and part by part.'),
      h('li', null, h('strong', null, 'Score. '), 'A scoring call scores the focal paper and every AI alternative for Fit to each field and for Novelty. It is not told which is the focal paper.'),
      summary.distance ? h('li', null, h('strong', null, 'Measure distance. '), 'Separately, and with no model judgement, the title and abstract of each AI alternative are compared with the focal paper\'s, and both with the published corpus, using text embeddings.') : null),
    h('p', null, 'The ', h('a', {href: `#/${state.caseId}/measures`}, 'Measures'), ' tab explains each measure and its scale.'),
    h('h2', null, 'How far to trust it'),
    h('ul', null,
      h('li', null, `The evidence check found ${summary.evidence.verdicts.contradicts || 0} of ${data.alternatives.length} AI alternatives misstating a reported result.`),
      h('li', null, 'One model writes, checks and scores. Consistency is not accuracy: expert ratings of a blind sample are the real check.'),
      h('li', null, 'Fit and Novelty are model judgements, not publication probabilities.')),
    h('h2', null, 'Cost and reproducibility'),
    h('p', null, `This case took ${calls} calls to ${data.model || 'Claude'} and cost $${cost.toFixed(2)}. Every request and response is saved in the run folder; the report and this explorer rebuild from them without an API key.`));
}

// ---------- Alternative detail ----------

// Variances of 0-1 scores are small, so they get four decimals.
const fmtVariance = value => value === null || value === undefined ? '–' : Number(value).toFixed(4);

// Each of Claude's scorings of a paper, their mean and their variance, for Fit in every field and
// for Novelty. The Fit and Novelty shown elsewhere are these means.
function scoringsTable(sc, data) {
  if (!sc) return null;
  const n = sc.scorings || 1;
  const columns = Array.from({length: n}, (_, i) => n > 1 ? `Scoring ${i + 1}` : 'Scoring');
  const row = (label, entry) => h('tr', null,
    h('th', {scope: 'row'}, label),
    // Bundles built before scorings were listed carry only the score of a paper scored once.
    ...columns.map((_, i) => h('td', {class: 'num'}, fmt(entry?.scores?.[i] ?? (n === 1 ? entry?.score : null)))),
    h('td', {class: 'num'}, h('strong', null, fmt(entry?.score))),
    h('td', {class: 'num'}, fmtVariance(entry?.variance)));
  const votes = Object.entries(sc.bestFieldVotes || {}).sort((a, b) => b[1] - a[1]).map(([field, count]) => `${fieldLabel(data, field)} ${count}`).join(', ');
  return [
    h('h3', null, 'Scorings'),
    h('p', {class: 'small muted'}, n > 1 ? 'Fit and Novelty above are the means of these scorings.' : 'Claude scored this once, so there is no variance.'),
    h('table', {class: 'data-table scorings'},
      h('thead', null, h('tr', null, h('th', {scope: 'col'}, ''), ...columns.map(label => h('th', {class: 'num', scope: 'col'}, label)), h('th', {class: 'num', scope: 'col'}, 'Mean'), h('th', {class: 'num', scope: 'col'}, 'Variance'))),
      h('tbody', null,
        data.fields.map(field => row(`Fit: ${field.label}`, sc.fit[field.id])),
        row('Novelty', sc.novelty))),
    n > 1 ? h('p', {class: 'small muted'}, `Each scoring judges Novelty within the best field it named: ${votes}.`) : null
  ];
}

// Published papers in the corpus, with journal, year and DOI link.
const citedList = (data, ids) => h('ul', {class: 'cites'}, ids.map(id => {
  const rec = data.records[id.id || id];
  return h('li', null, h('div', {class: 'serif'}, rec?.title || (id.id || id)), rec ? h('div', null, h('span', {class: 'small muted'}, `${rec.journal}, ${rec.year}. `), rec.doi ? h('a', {href: `https://doi.org/${rec.doi}`, target: '_blank', rel: 'noopener'}, 'DOI') : null) : null, id.relation ? h('div', {class: 'small muted'}, id.relation) : null);
}));

function openDrawer(alt, data) {
  if (drawer.getAttribute('aria-hidden') === 'true') lastFocus = document.activeElement;
  const o = alt.outline, r = alt.review, sc = alt.score, f = data.paper.framing;
  const original = data.original;
  const pips = change => h('span', {class: 'change'}, h('span', {class: 'pips', 'aria-hidden': 'true'}, [1, 2, 3].map(i => h('i', {class: i <= (CHANGE_STEPS[change] ?? 0) ? 'on' : null}))), change ? change[0].toUpperCase() + change.slice(1) : 'Not compared');
  const paperText = {question: f.researchQuestion, conversation: f.conversation, theory: f.theory, mechanism: f.mechanism, interpretation: f.interpretation, contribution: f.contribution, audience: f.audience};
  const altText = {question: o.researchQuestion, conversation: o.conversation, theory: [o.theory.primary, ...o.theory.secondary].join('; '), mechanism: o.mechanism, interpretation: o.interpretation, contribution: o.contribution, audience: `${fieldLabel(data, o.field)}: ${o.targetJournals.join(', ')}`};
  const cited = ids => citedList(data, ids);

  document.getElementById('drawer-kind').textContent = kindText(alt);
  // Sections may be lists of nodes or null; replaceChildren would print those as text.
  drawerBody.replaceChildren(...[
    h('h2', {id: 'drawer-title'}, o.title),
    h('p', {class: 'abstract'}, o.abstract),
    h('h3', null, 'Fit by field'),
    h('div', {class: 'fitbars'}, data.fields.map(field => {
      const value = sc?.fit[field.id]?.score ?? 0, own = original?.fit[field.id]?.score;
      return [h('span', null, field.label),
        h('div', {class: 'track', title: sc?.fit[field.id]?.reason || ''}, h('div', {class: 'bar', style: {width: `${value * 100}%`, background: fieldColor(field.id)}}), own !== undefined ? h('div', {class: 'tick', style: {left: `calc(${own * 100}% - 1px)`}, title: `Focal paper: ${fmt(own)}`}) : null),
        h('span', {class: 'val'}, fmt(value))];
    })),
    h('p', {class: 'small muted'}, 'The dark tick marks the focal paper\'s fit.'),
    h('h3', null, `Novelty in ${fieldLabel(data, sc?.bestField).toLowerCase()}: ${fmt(sc?.novelty.score)}`),
    h('p', {class: 'notes'}, sc?.novelty.reason),
    sc?.novelty.closest?.length ? cited(sc.novelty.closest) : null,
    scoringsTable(sc, data),
    distanceBlock(alt, data, cited),
    h('h3', null, 'Compared with the focal paper'),
    r?.summary ? h('p', {class: 'notes'}, r.summary) : null,
    h('table', {class: 'compare'},
      h('thead', null, h('tr', null, h('th', null, 'Part'), h('th', null, 'Focal paper'), h('th', null, 'This AI alternative'))),
      h('tbody', null, data.parts.map(part => h('tr', null,
        h('th', {scope: 'row'}, PART_LABEL[part], h('br'), pips(r?.components?.[part])),
        h('td', null, paperText[part]),
        h('td', null, altText[part]))))),
    h('h3', null, 'Hypotheses'),
    h('ul', {class: 'hyps'}, o.hypotheses.map(hyp => h('li', null, h('div', {class: 'serif'}, hyp.statement),
      h('div', null, hyp.resultIds.map(id => h('span', {class: 'res-chip', title: resultTitle(data, id)}, id)), h('span', {class: 'small muted'}, ` ${hyp.status === 'reported' ? 'rests on reported results' : hyp.status === 'needs-reanalysis' ? 'needs a re-analysis' : 'needs new data'}`))))),
    h('h3', null, 'Evidence check'),
    h('div', {class: 'verdict'}, checkIcon(r?.verdict === 'consistent'), h('div', null,
      h('strong', null, r?.verdict === 'consistent' ? 'Consistent with the reported results' : 'Misstates a reported result'),
      r?.contradictions?.length ? h('ul', {class: 'notes'}, r.contradictions.map(c => h('li', null, c))) : null,
      h('p', {class: 'notes'}, ['untestedMechanism', 'causalOverreach', 'needsReanalysis', 'needsNewData'].filter(k => r?.flags?.[k]).map(k => ({untestedMechanism: 'Mechanism theorized, not tested', causalOverreach: 'Causal language beyond the design', needsReanalysis: 'A hypothesis needs re-analysis', needsNewData: 'A hypothesis needs new data'})[k]).join('. ') || 'No flags.'))),
    o.changesNeeded.length ? [h('h3', null, 'What it would need'), h('ul', {class: 'notes'}, o.changesNeeded.map(c => h('li', null, c)))] : null,
    o.extensions?.length ? [h('h3', null, 'Possible extensions'), h('ul', {class: 'notes'}, o.extensions.map(c => h('li', null, c)))] : null
  ].flat(Infinity).filter(Boolean));
  drawer.setAttribute('aria-hidden', 'false');
  drawer.querySelector('.drawer-panel').scrollTop = 0;
  drawer.querySelector('.drawer-close').focus();
}

// The alternative's Distance measures beside the paper's, and the published articles nearest to it.
function distanceBlock(alt, data, cited) {
  const d = alt.distance, own = data.original?.distance, dist = data.summary.distance;
  if (!d || !dist) return null;
  const familyMean = dist.fromOriginal?.byFamily?.[alt.review?.family]?.mean;
  const [topField, topShare] = Object.entries(d.neighbourFields || {}).sort((a, b) => b[1] - a[1])[0] || [];
  return [
    h('h3', null, `Distance from the focal paper: ${fmt(d.fromOriginal)}`),
    familyMean !== undefined && familyMean !== null ? h('p', {class: 'small muted'}, `AI alternatives Claude calls a ${familyText(alt.review.family).toLowerCase()} are ${fmt(familyMean)} from the focal paper on average.`) : null,
    h('table', {class: 'data-table scorings'},
      h('thead', null, h('tr', null, h('th', {scope: 'col'}, 'Distance from published corpus (percentile)'), h('th', {class: 'num', scope: 'col'}, 'This AI alternative'), h('th', {class: 'num', scope: 'col'}, 'Focal paper'))),
      h('tbody', null, [...data.fields, {id: 'all', label: 'All fields'}].map(field => h('tr', null,
        h('th', {scope: 'row'}, field.label),
        h('td', {class: 'num'}, field.id === alt.score?.bestField ? h('strong', null, pct(d.toPublishedPercentile[field.id])) : pct(d.toPublishedPercentile[field.id])),
        h('td', {class: 'num'}, pct(own?.toPublishedPercentile?.[field.id])))))),
    h('p', {class: 'small muted'}, `Bold is the field Claude says it fits best.${topField ? ` ${Math.round(topShare * 100)}% of its ${dist.settings.fieldNeighbours} nearest published papers in the corpus are in ${fieldLabel(data, topField).toLowerCase()}.` : ''}`),
    d.nearest?.length ? [h('h3', null, 'Nearest published papers in the corpus'), cited(d.nearest)] : null
  ];
}

function resultTitle(data, id) {
  const result = data.paper.evidence.results.find(r => r.id === id);
  return result ? `${result.term}: ${result.estimate}, ${result.significance} (${result.location})` : id;
}

function closeDrawer(updateHash = true) {
  if (drawer.getAttribute('aria-hidden') === 'true') return;
  drawer.setAttribute('aria-hidden', 'true');
  hideTooltip();
  if (updateHash) go(state.view);
  lastFocus?.focus?.();
}

drawer.addEventListener('click', event => { if (event.target.closest('[data-close]')) closeDrawer(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeDrawer(); });
document.getElementById('case-select').addEventListener('change', event => { location.hash = `#/${event.target.value}/${state.view}`; });
window.addEventListener('hashchange', () => route().catch(showError));

// No focal paper has been run yet: say how to add one.
function renderWelcome() {
  document.querySelector('.case-picker').hidden = true;
  document.querySelector('.tabs').hidden = true;
  document.getElementById('paper-title').textContent = 'No focal papers yet';
  document.getElementById('paper-byline').textContent = 'The explorer shows each focal paper you run, with its AI alternatives and how they were scored.';
  const step = (text, command) => h('li', null, text, command && h('pre', null, h('code', null, command)));
  main.replaceChildren(h('div', {class: 'panel welcome'},
    h('h2', null, 'Add a focal paper'),
    h('p', null, 'Follow the README. In short, from the tool\'s folder:'),
    h('ol', null,
      step('Put your API key in .env and check it.', 'npm run check-key'),
      step('Build the published corpus (and, for Distance, its embeddings).', 'npm run build-corpus\nnpm run build-embeddings'),
      step('Put the PDF in papers/ and extract it. Then read the extraction it prints.', 'npm run extract -- --case my-paper --pdf papers/paper.pdf'),
      step('Run a pilot, then the full test.', 'npm run test-run -- --case my-paper --pilot\nnpm run test-run -- --case my-paper'),
      step('Reload this page.'))));
}

function showError(error) {
  main.replaceChildren(h('div', {class: 'panel'}, h('h2', null, 'The results could not be loaded'), h('p', null, error.message)));
}

loadCases().then(route).catch(showError);
