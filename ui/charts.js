// Charts for the results view, drawn as SVG. Every mark is focusable, shows a tooltip on hover and
// focus, and selects the alternative on click (app.js then highlights it in every chart); every
// chart has a table twin (see app.js).
import {h, s, fieldColor, fmt, hash01, bindMark, prefersReducedMotion} from './dom.js';

const KIND_LABEL = {open: 'Open run', theory: 'Theory run', field: 'Field run'};
const FAMILY_LABEL = {'same-paper': 'Same paper', 'close-variant': 'Close variant', 'different-paper': 'Different paper'};

export const bestFit = alt => alt.score ? alt.score.fit[alt.score.bestField]?.score ?? null : null;
// Open runs from before the request and format variants have no target.
export const kindText = alt => alt.kind === 'open' && !alt.target ? KIND_LABEL.open : `${KIND_LABEL[alt.kind]}: ${alt.target}`;
export const familyText = family => FAMILY_LABEL[family] || 'Not compared';

export function altTooltip(alt, fields) {
  const field = fields.find(f => f.id === alt.score?.bestField);
  return h('div', null,
    h('div', {class: 'tt-title'}, alt.outline.title),
    h('div', {class: 'tt-row'}, h('span', {class: 'tt-key', style: {background: fieldColor(alt.score?.bestField)}}), `Fits ${field?.label || '–'} best:`, h('b', null, fmt(bestFit(alt)))),
    h('div', {class: 'tt-row'}, 'Novelty in that field:', h('b', null, fmt(alt.score?.novelty.score))),
    alt.distance ? h('div', {class: 'tt-row'}, 'Distance percentile there:', h('b', null, pct(alt.distance.toPublishedPercentile[alt.score?.bestField]))) : null,
    h('div', {class: 'tt-row'}, 'Parts replaced:', h('b', null, `${alt.partsReplaced ?? '–'} of 7`)),
    h('div', {class: 'tt-row'}, kindText(alt))
  );
}

// ---------- The map of roads not taken ----------
// The focal paper sits at the center. Each AI alternative sits in the sector of the field it fits
// best; its distance from the center is the number of the focal paper's seven parts it replaced.
export function possibilityMap({alternatives, fields, homeField, passes, onSelect}) {
  const size = 680, cx = size / 2, cy = size / 2;
  const ringRadius = k => 62 + k * 33;
  const order = [homeField, ...fields.map(f => f.id).filter(id => id !== homeField)];
  const span = 360 / order.length;
  const centerAngle = index => -90 + index * span;
  const rad = degrees => degrees * Math.PI / 180;
  const point = (angle, r) => [cx + r * Math.cos(rad(angle)), cy + r * Math.sin(rad(angle))];

  const root = s('svg', {viewBox: `-70 -36 ${size + 140} ${size + 72}`, role: 'group', 'aria-label': 'Map of AI alternatives by best-fitting field and number of parts replaced'});
  // Rings and sector boundaries.
  for (let k = 0; k <= 7; k++) root.append(s('circle', {class: 'ring', cx, cy, r: ringRadius(k)}));
  order.forEach((_, index) => {
    const [x1, y1] = point(centerAngle(index) - span / 2, ringRadius(0));
    const [x2, y2] = point(centerAngle(index) - span / 2, ringRadius(7) + 8);
    root.append(s('line', {class: 'sector-line', x1, y1, x2, y2}));
  });
  // Ring numbers run along the boundary to the right of the home sector.
  for (const k of [1, 3, 5, 7]) {
    const [x, y] = point(centerAngle(0) + span / 2, ringRadius(k));
    root.append(s('text', {class: 'ring-label', x: x + 6, y: y - 4}, k === 7 ? '7 parts replaced' : String(k)));
  }

  // Lay out each (field, rings) bucket evenly across its sector so dots don't overlap.
  const buckets = new Map();
  for (const alt of alternatives) {
    if (!alt.score) continue;
    const key = `${alt.score.bestField}|${alt.partsReplaced ?? 0}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(alt);
  }
  const placed = [];
  for (const [key, group] of buckets) {
    const [fieldId, partsText] = key.split('|');
    const parts = Number(partsText), index = order.indexOf(fieldId);
    group.sort((a, b) => hash01(a.id) - hash01(b.id));
    const usable = span - 14, r = ringRadius(parts);
    const perRow = Math.max(1, Math.floor((rad(usable) * r) / 15));
    group.forEach((alt, i) => {
      const row = Math.floor(i / perRow), inRow = Math.min(perRow, group.length - row * perRow), slot = i % perRow;
      const angle = centerAngle(index) + (inRow === 1 ? 0 : -usable / 2 + (usable * slot) / (inRow - 1));
      const radius = r + (row === 0 ? 0 : (row % 2 ? 9 : -9) * Math.ceil(row / 2));
      placed.push({alt, x: point(angle, radius)[0], y: point(angle, radius)[1]});
    });
  }

  // Sector labels with counts.
  order.forEach((fieldId, index) => {
    const field = fields.find(f => f.id === fieldId);
    const count = placed.filter(p => p.alt.score.bestField === fieldId).length;
    const [x, y] = point(centerAngle(index), ringRadius(7) + 30);
    const anchor = Math.abs(x - cx) < 40 ? 'middle' : x > cx ? 'start' : 'end';
    // Long field names break onto two lines so they stay inside the map's margin.
    const words = field.label.split(' ');
    const lines = field.label.length > 16 && words.length > 1
      ? [words.slice(0, Math.ceil(words.length / 2)).join(' '), words.slice(Math.ceil(words.length / 2)).join(' ')]
      : [field.label];
    const label = s('text', {class: 'sector-label', x, y: y - (lines.length - 1) * 8, 'text-anchor': anchor},
      lines.map((line, i) => s('tspan', {x, dy: i ? '1.15em' : 0}, line)));
    const sub = s('text', {class: 'sector-count', x, y: y + 16 + (lines.length - 1) * 8, 'text-anchor': anchor}, count === 0 ? 'none fit best here' : `${count} AI ${count === 1 ? 'alternative' : 'alternatives'}`);
    root.append(label, sub);
  });

  const roads = s('g'), marks = s('g');
  root.append(roads, marks);
  const animate = !prefersReducedMotion();
  const markNodes = [];
  for (const {alt, x, y} of placed) {
    const length = Math.hypot(x - cx, y - cy);
    const road = s('line', {class: 'road', 'data-alt': alt.id, x1: cx, y1: cy, x2: x, y2: y});
    if (animate) { road.style.strokeDasharray = `${length}`; road.style.strokeDashoffset = `${length}`; }
    roads.append(road);
    const mark = s('g', {class: 'mark'},
      s('circle', {class: 'hit', r: 12}),
      s('circle', {class: 'dot', r: 6, fill: fieldColor(alt.score.bestField)}));
    mark.style.transform = animate ? `translate(${cx}px, ${cy}px)` : `translate(${x}px, ${y}px)`;
    bindMark(mark, {
      id: alt.id,
      tooltip: () => altTooltip(alt, fields),
      onSelect: () => onSelect(alt),
      label: `${alt.outline.title}. ${kindText(alt)}.`
    });
    mark.addEventListener('pointerenter', () => road.classList.add('active'));
    mark.addEventListener('pointerleave', () => road.classList.remove('active'));
    mark.addEventListener('focus', () => road.classList.add('active'));
    mark.addEventListener('blur', () => road.classList.remove('active'));
    marks.append(mark);
    markNodes.push({alt, mark, road, x, y});
  }

  // The focal paper.
  root.append(
    s('circle', {class: 'origin-ring', cx, cy, r: 17}),
    s('circle', {class: 'origin-disc', cx, cy, r: 10}),
    s('text', {class: 'origin-label', x: cx, y: cy + 38, 'text-anchor': 'middle'}, 'Focal paper')
  );

  // Measure each sector label once rendered: pull it back inside the view box and put its count
  // line just below it, whatever the font size (it grows on small screens).
  const [vbX, , vbW] = root.getAttribute('viewBox').split(' ').map(Number);
  const fitLabels = () => {
    if (!root.isConnected) return;
    for (const label of root.querySelectorAll('.sector-label')) {
      const sub = label.nextElementSibling, box = label.getBBox();
      const shift = box.x < vbX + 4 ? vbX + 4 - box.x : box.x + box.width > vbX + vbW - 4 ? vbX + vbW - 4 - box.x - box.width : 0;
      if (shift) for (const node of [label, ...label.querySelectorAll('tspan'), sub]) node.setAttribute('x', Number(node.getAttribute('x')) + shift);
      const after = label.getBBox();
      sub.setAttribute('y', after.y + after.height + parseFloat(getComputedStyle(sub).fontSize) * 0.95);
    }
  };
  requestAnimationFrame(fitLabels);
  window.addEventListener('resize', () => requestAnimationFrame(fitLabels));

  const update = () => {
    for (const {alt, mark, road} of markNodes) {
      const visible = passes(alt);
      mark.classList.toggle('faded', !visible);
      road.style.opacity = visible ? '1' : '0';
    }
  };
  update();
  const figure = h('figure', {class: `map-figure${animate ? ' animate' : ''}`}, root);
  if (animate) {
    // Animation frames don't run in background tabs, so a timer also places the dots.
    const finish = () => {
      for (const {mark, road, x, y} of markNodes) {
        mark.style.transform = `translate(${x}px, ${y}px)`;
        road.style.strokeDashoffset = '0';
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 1200);
  }
  return {node: figure, update};
}

// ---------- Does it come back? ----------
export function convergenceStrip({alternatives, fields, onSelect}) {
  const open = alternatives.filter(alt => alt.kind === 'open');
  const groups = ['same-paper', 'close-variant', 'different-paper'];
  const notes = {
    'same-paper': 'Same question, theory and contribution as the focal paper.',
    'close-variant': 'Shares the core question or theory, but differs in one major respect.',
    'different-paper': 'Differs in at least two of question, theory and contribution.'
  };
  return h('div', {class: 'strip'}, groups.map(family => {
    const members = open.filter(alt => alt.review?.family === family);
    return h('div', {class: 'strip-group'},
      h('h3', null, FAMILY_LABEL[family]),
      h('span', {class: 'count'}, String(members.length)),
      h('div', {class: 'strip-dots'}, members.map(alt => {
        const button = h('button', {type: 'button', style: {background: fieldColor(alt.score?.bestField)}});
        bindMark(button, {id: alt.id, tooltip: () => altTooltip(alt, fields), onSelect: () => onSelect(alt), label: alt.outline.title});
        button.removeAttribute('role');
        return button;
      })),
      h('p', null, notes[family]));
  }));
}

// ---------- Where could it go? ----------
// For each field: the paper's own overall fit, every run aimed at that field, and the best of them.
export function fieldReach({fields, alternatives, original, onSelect}) {
  const rowH = 58, left = 200, plotW = 430, right = 250, top = 22;
  const width = left + plotW + right, height = top + fields.length * rowH + 30;
  const x = value => left + value * plotW;
  const root = s('svg', {viewBox: `0 0 ${width} ${height}`, width, height, role: 'group', 'aria-label': 'Overall fit in each field: the focal paper and the AI alternatives aimed at that field'});
  const grid = s('g', {class: 'grid'});
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    grid.append(s('line', {x1: x(t), x2: x(t), y1: top - 10, y2: height - 26}));
    root.append(s('text', {class: 'tick', x: x(t), y: height - 8, 'text-anchor': 'middle'}, t === 0 ? '0' : t === 1 ? '1' : String(t)));
  }
  root.append(grid);
  root.append(s('text', {x: left + plotW + 16, y: top - 6, class: 'small'}, 'Highest-fit run aimed here'));

  fields.forEach((field, index) => {
    const y = top + index * rowH + rowH / 2;
    const aimed = alternatives.filter(alt => alt.kind === 'field' && alt.targetId === field.id && alt.score?.fit[field.id]);
    const best = [...aimed].sort((a, b) => b.score.fit[field.id].score - a.score.fit[field.id].score)[0];
    const own = original?.fit[field.id]?.score;
    root.append(s('text', {x: 0, y: y + 4, class: 'label-strong'}, field.label));
    root.append(s('line', {class: 'baseline', x1: left, x2: left + plotW, y1: y, y2: y, 'stroke-width': 1}));
    if (best && own !== undefined) root.append(s('line', {class: 'connector', x1: x(own), x2: x(best.score.fit[field.id].score), y1: y, y2: y}));
    for (const alt of aimed) {
      const value = alt.score.fit[field.id].score, isBest = alt === best;
      const mark = s('g', {class: 'mark', transform: `translate(${x(value)} ${y})`},
        s('circle', {class: 'hit', r: 12}),
        s('circle', {class: `dot${isBest ? '' : ' hollow'}`, r: isBest ? 7 : 5, fill: fieldColor(field.id), stroke: isBest ? null : fieldColor(field.id)}));
      if (!isBest) mark.querySelector('.dot').style.stroke = fieldColor(field.id);
      bindMark(mark, {id: alt.id, tooltip: () => altTooltip(alt, fields), onSelect: () => onSelect(alt), label: `${alt.outline.title}, overall fit ${fmt(value)}`});
      root.append(mark);
    }
    if (own !== undefined) {
      const d = 8;
      root.append(s('path', {class: 'paper-mark', d: `M${x(own)} ${y - d}L${x(own) + d} ${y}L${x(own)} ${y + d}L${x(own) - d} ${y}Z`}));
      root.append(s('text', {x: x(own), y: y + 24, 'text-anchor': 'middle'}, `focal paper ${fmt(own)}`));
    }
    if (best) {
      const value = best.score.fit[field.id].score;
      root.append(s('text', {x: x(value), y: y - 13, 'text-anchor': 'middle', class: 'label-strong'}, fmt(value)));
      root.append(s('text', {x: left + plotW + 16, y: y - 2}, `${best.partsReplaced} of 7 parts replaced`));
      root.append(s('text', {x: left + plotW + 16, y: y + 15, class: 'muted'}, `needs ${best.burden}`));
    }
  });
  return root;
}

// ---------- Where did it land? ----------
// Field runs only. Rows are the field each run was aimed at, columns the field the scorer says it fits
// best; the shaded diagonal is where a run landed where it was aimed.
export function aimLanding({fields, alternatives, onSelect}) {
  const runs = alternatives.filter(alt => alt.kind === 'field' && alt.score);
  const grid = h('div', {class: 'aim-grid', role: 'group', 'aria-label': 'Field runs by the field they were aimed at and the field they fit best', style: {gridTemplateColumns: `minmax(130px, 1.2fr) repeat(${fields.length}, minmax(84px, 1fr))`}},
    h('div', {class: 'aim-corner'}, h('span', null, 'Aimed at ↓'), h('span', null, 'Fits best →')),
    fields.map(field => h('div', {class: 'aim-col'}, h('i', {class: 'swatch', style: {background: fieldColor(field.id)}}), field.label)));
  for (const aim of fields) {
    const row = runs.filter(alt => alt.targetId === aim.id);
    grid.append(h('div', {class: 'aim-row'}, h('strong', null, aim.label), h('span', {class: 'muted small'}, `${row.length} ${row.length === 1 ? 'run' : 'runs'}`)));
    for (const land of fields) {
      const members = row.filter(alt => alt.score.bestField === land.id);
      grid.append(h('div', {class: `aim-cell${aim.id === land.id ? ' on-target' : ''}`},
        members.length ? h('span', {class: 'aim-count'}, String(members.length)) : null,
        h('div', {class: 'strip-dots'}, members.map(alt => {
          const button = h('button', {type: 'button', style: {background: fieldColor(land.id)}});
          bindMark(button, {id: alt.id, tooltip: () => altTooltip(alt, fields), onSelect: () => onSelect(alt), label: `${alt.outline.title}. Aimed at ${aim.label}, fits ${land.label} best.`});
          button.removeAttribute('role');
          return button;
        }))));
    }
  }
  return h('div', {class: 'aim-scroll'}, grid);
}

// ---------- Which theories carry it? ----------
export function theoryChart({alternatives, fields, homeField, original, onSelect}) {
  const rows = alternatives.filter(alt => alt.kind === 'theory' && alt.score)
    .sort((a, b) => (b.score.fit[homeField]?.score ?? 0) - (a.score.fit[homeField]?.score ?? 0));
  const rowH = 28, left = 230, plotW = 470, top = 34;
  const width = left + plotW + 40, height = top + rows.length * rowH + 28;
  const x = value => left + value * plotW;
  const root = s('svg', {viewBox: `0 0 ${width} ${height}`, width, height, role: 'group', 'aria-label': 'Overall fit of each theory run'});
  const grid = s('g', {class: 'grid'});
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    grid.append(s('line', {x1: x(t), x2: x(t), y1: top - 8, y2: height - 22}));
    root.append(s('text', {class: 'tick', x: x(t), y: height - 6, 'text-anchor': 'middle'}, t === 0 ? '0' : t === 1 ? '1' : String(t)));
  }
  root.append(grid);
  const own = original?.fit[homeField]?.score;
  if (own !== undefined) {
    root.append(s('line', {class: 'ref-line', x1: x(own), x2: x(own), y1: top - 12, y2: height - 22}));
    root.append(s('text', {x: x(own), y: top - 18, 'text-anchor': 'middle', class: 'label-strong'}, `Focal paper ${fmt(own)}`));
  }
  rows.forEach((alt, index) => {
    const y = top + index * rowH + rowH / 2;
    const home = alt.score.fit[homeField]?.score ?? 0;
    const bestField = alt.score.bestField, best = bestFit(alt);
    const row = s('g', {class: 'mark'});
    row.append(s('rect', {class: 'hit', x: 0, y: y - rowH / 2, width, height: rowH}));
    row.append(s('text', {x: left - 14, y: y + 4, 'text-anchor': 'end'}, alt.target));
    if (bestField !== homeField) row.append(s('line', {class: 'connector', x1: x(home), x2: x(best), y1: y, y2: y}));
    row.append(s('circle', {class: 'dot', cx: x(home), cy: y, r: 6, fill: fieldColor(homeField)}));
    if (bestField !== homeField) row.append(s('circle', {class: 'dot', cx: x(best), cy: y, r: 6, fill: fieldColor(bestField)}));
    bindMark(row, {id: alt.id, tooltip: () => altTooltip(alt, fields), onSelect: () => onSelect(alt), label: `${alt.target}: overall fit ${fmt(home)} in ${fields.find(f => f.id === homeField).label}`});
    root.append(row);
  });
  return root;
}

// ---------- Distance (embeddings) ----------
// Distance comes from text embeddings with no model judgement. These charts keep it apart from
// Claude's overall fit and novelty and set it beside Claude's own comparisons.
export const pct = value => value === null || value === undefined ? '–' : String(Math.round(value));

function distanceTooltip(alt, fields) {
  const field = fields.find(f => f.id === alt.score?.bestField);
  return h('div', null,
    h('div', {class: 'tt-title'}, alt.outline.title),
    h('div', {class: 'tt-row'}, 'Distance from the focal paper:', h('b', null, fmt(alt.distance?.fromOriginal))),
    h('div', {class: 'tt-row'}, `Distance percentile in ${field?.label || '–'}:`, h('b', null, pct(alt.distance?.toPublishedPercentile[alt.score?.bestField]))),
    h('div', {class: 'tt-row'}, "Claude's comparison:", h('b', null, familyText(alt.review?.family))),
    h('div', {class: 'tt-row'}, kindText(alt))
  );
}

// For the field-agreement grid: says plainly that the dot is an AI alternative, and where its nearest
// published papers in the corpus come from.
function neighbourTooltip(alt, fields) {
  const label = id => fields.find(f => f.id === id)?.label || id;
  const shares = Object.entries(alt.distance?.neighbourFields || {}).filter(([, share]) => share > 0).sort((a, b) => b[1] - a[1]);
  return h('div', null,
    h('div', {class: 'tt-row'}, h('span', {class: 'muted'}, 'AI alternative')),
    h('div', {class: 'tt-title'}, alt.outline.title),
    h('div', {class: 'tt-row'}, h('span', {class: 'tt-key', style: {background: fieldColor(alt.score?.bestField)}}), 'Fits best (overall fit):', h('b', null, label(alt.score?.bestField))),
    h('div', {class: 'tt-row'}, 'Its nearest published papers:', h('b', null, shares.map(([id, share]) => `${label(id)} ${Math.round(share * 100)}%`).join(', ')))
  );
}

// Spreads dots that would overlap on one row across a few lanes above and below it.
function lanes(items, xOf, gap = 11, step = 8) {
  const offsets = [0, -1, 1, -2, 2, -3, 3], last = new Map();
  return [...items].sort((a, b) => xOf(a) - xOf(b)).map((item, i) => {
    const lane = offsets.find(k => (last.get(k) ?? -Infinity) < xOf(item) - gap) ?? offsets[i % offsets.length];
    last.set(lane, xOf(item));
    return {item, dy: lane * step};
  });
}

// How far each alternative moved from the paper, grouped by Claude's own comparison with it.
export function distanceFromOriginal({alternatives, fields, referenceMedian, onSelect}) {
  const measured = alternatives.filter(alt => alt.distance && alt.review);
  const groups = ['same-paper', 'close-variant', 'different-paper'];
  const rowH = 76, left = 170, plotW = 520, top = 30;
  const width = left + plotW + 70, height = top + groups.length * rowH + 30;
  const max = Math.max(0.25, Math.ceil(Math.max(...measured.map(a => a.distance.fromOriginal), referenceMedian || 0) * 20) / 20);
  const x = value => left + value / max * plotW;
  const root = s('svg', {viewBox: `0 0 ${width} ${height}`, width, height, role: 'group', 'aria-label': "Distance of each AI alternative from the focal paper, by Claude's comparison with the focal paper"});
  const grid = s('g', {class: 'grid'});
  for (let t = 0; t <= max + 1e-9; t += 0.05) {
    grid.append(s('line', {x1: x(t), x2: x(t), y1: top - 8, y2: height - 26}));
    root.append(s('text', {class: 'tick', x: x(t), y: height - 8, 'text-anchor': 'middle'}, t === 0 ? '0' : t.toFixed(2)));
  }
  root.append(grid);
  if (referenceMedian) {
    root.append(s('line', {class: 'ref-line', x1: x(referenceMedian), x2: x(referenceMedian), y1: top - 12, y2: height - 26, 'stroke-dasharray': '4 4', opacity: 0.6}));
    root.append(s('text', {x: x(referenceMedian), y: top - 16, 'text-anchor': 'middle', class: 'small muted'}, `typical published paper to its nearest published papers ${fmt(referenceMedian)}`));
  }
  groups.forEach((family, index) => {
    const y = top + index * rowH + rowH / 2;
    const members = measured.filter(alt => alt.review.family === family);
    root.append(s('text', {x: 0, y: y - 2, class: 'label-strong'}, FAMILY_LABEL[family]));
    root.append(s('text', {x: 0, y: y + 15, class: 'small muted'}, `${members.length} AI ${members.length === 1 ? 'alternative' : 'alternatives'}`));
    root.append(s('line', {class: 'baseline', x1: left, x2: left + plotW, y1: y, y2: y, 'stroke-width': 1}));
    for (const {item: alt, dy} of lanes(members, a => x(a.distance.fromOriginal))) {
      const mark = s('g', {class: 'mark', transform: `translate(${x(alt.distance.fromOriginal)} ${y + dy})`},
        s('circle', {class: 'hit', r: 9}),
        s('circle', {class: 'dot', r: 5, fill: fieldColor(alt.score?.bestField)}));
      bindMark(mark, {id: alt.id, tooltip: () => distanceTooltip(alt, fields), onSelect: () => onSelect(alt), label: `${alt.outline.title}, distance ${fmt(alt.distance.fromOriginal)} from the focal paper`});
      root.append(mark);
    }
    if (members.length) {
      const mean = members.reduce((sum, alt) => sum + alt.distance.fromOriginal, 0) / members.length;
      root.append(s('line', {class: 'ref-line', x1: x(mean), x2: x(mean), y1: y - 30, y2: y + 30, 'stroke-width': 3, 'pointer-events': 'none'}));
      root.append(s('text', {x: left + plotW + 12, y: y + 4, class: 'label-strong'}, `mean ${fmt(mean)}`));
    }
  });
  return root;
}

// For each field, each AI alternative's distance from that field's published papers as a percentile,
// with the focal paper's own and the AI alternatives' median.
export function distanceFromPublished({alternatives, fields, original, onSelect}) {
  const measured = alternatives.filter(alt => alt.distance);
  const rows = [...fields, {id: 'all', label: 'All fields'}];
  const rowH = 64, left = 200, plotW = 470, right = 170, top = 30;
  const width = left + plotW + right, height = top + rows.length * rowH + 30;
  const x = value => left + value / 100 * plotW;
  const root = s('svg', {viewBox: `0 0 ${width} ${height}`, width, height, role: 'group', 'aria-label': 'Distance from the published corpus in each field, as a percentile'});
  const grid = s('g', {class: 'grid'});
  for (const t of [0, 25, 50, 75, 100]) {
    grid.append(s('line', {x1: x(t), x2: x(t), y1: top - 8, y2: height - 26}));
    root.append(s('text', {class: 'tick', x: x(t), y: height - 8, 'text-anchor': 'middle'}, String(t)));
  }
  root.append(grid);
  root.append(s('line', {class: 'ref-line', x1: x(50), x2: x(50), y1: top - 12, y2: height - 26, 'stroke-dasharray': '4 4', opacity: 0.6}));
  root.append(s('text', {x: x(50), y: top - 16, 'text-anchor': 'middle', class: 'small muted'}, 'typical published paper'));
  root.append(s('text', {x: left + plotW + 16, y: top - 16, class: 'small'}, 'Focal paper · AI alternatives\' median'));
  rows.forEach((field, index) => {
    const y = top + index * rowH + rowH / 2;
    const values = measured.map(alt => alt.distance.toPublishedPercentile[field.id]).filter(v => v !== undefined).sort((a, b) => a - b);
    root.append(s('text', {x: 0, y: y + 4, class: 'label-strong'}, field.label));
    root.append(s('line', {class: 'baseline', x1: left, x2: left + plotW, y1: y, y2: y, 'stroke-width': 1}));
    for (const {item: alt, dy} of lanes(measured, a => x(a.distance.toPublishedPercentile[field.id]), 8, 6)) {
      const mark = s('g', {class: 'mark', transform: `translate(${x(alt.distance.toPublishedPercentile[field.id])} ${y + dy})`},
        s('circle', {class: 'hit', r: 7}),
        s('circle', {class: 'dot', r: 4, fill: fieldColor(alt.score?.bestField)}));
      bindMark(mark, {id: alt.id, tooltip: () => distanceTooltip(alt, fields), onSelect: () => onSelect(alt), label: `${alt.outline.title}, percentile ${pct(alt.distance.toPublishedPercentile[field.id])} in ${field.label}`});
      root.append(mark);
    }
    const median = values.length ? values[Math.floor((values.length - 1) / 2)] / 2 + values[Math.ceil((values.length - 1) / 2)] / 2 : null;
    if (median !== null) root.append(s('line', {class: 'ref-line', x1: x(median), x2: x(median), y1: y - 24, y2: y + 24, 'stroke-width': 3, 'pointer-events': 'none'}));
    const own = original?.distance?.toPublishedPercentile[field.id];
    if (own !== undefined) {
      const d = 8;
      root.append(s('path', {class: 'paper-mark', d: `M${x(own)} ${y - d}L${x(own) + d} ${y}L${x(own)} ${y + d}L${x(own) - d} ${y}Z`}));
    }
    root.append(s('text', {x: left + plotW + 16, y: y + 4}, `${pct(own)} · ${pct(median)}`));
  });
  return root;
}

// Claude's best field for each alternative against the field most of its nearest published articles
// come from. The shaded diagonal is where the two agree.
export function neighbourAgreement({fields, alternatives, onSelect}) {
  const measured = alternatives.filter(alt => alt.distance && alt.score);
  const columns = fields;
  const grid = h('div', {class: 'aim-grid', role: 'group', 'aria-label': "AI alternatives by Claude's best field and by the field of their nearest published papers", style: {gridTemplateColumns: `minmax(130px, 1.2fr) repeat(${columns.length}, minmax(84px, 1fr))`}},
    h('div', {class: 'aim-corner'}, h('span', null, 'Fits best (overall fit) ↓'), h('span', null, 'Its nearest published papers (distance) →')),
    columns.map(field => h('div', {class: 'aim-col'}, h('i', {class: 'swatch', style: {background: fieldColor(field.id)}}), field.label)));
  for (const row of fields) {
    const inRow = measured.filter(alt => alt.score.bestField === row.id);
    grid.append(h('div', {class: 'aim-row'}, h('strong', null, row.label), h('span', {class: 'muted small'}, `${inRow.length} AI ${inRow.length === 1 ? 'alternative' : 'alternatives'}`)));
    for (const column of columns) {
      const members = inRow.filter(alt => alt.distance.topNeighbourField === column.id);
      grid.append(h('div', {class: `aim-cell${row.id === column.id ? ' on-target' : ''}`},
        members.length ? h('span', {class: 'aim-count'}, String(members.length)) : null,
        h('div', {class: 'strip-dots'}, members.map(alt => {
          const button = h('button', {type: 'button', style: {background: fieldColor(row.id)}});
          bindMark(button, {id: alt.id, tooltip: () => neighbourTooltip(alt, fields), onSelect: () => onSelect(alt), label: `AI alternative: ${alt.outline.title}. Fits ${row.label} best; its nearest published papers are mostly ${column.label}.`});
          button.removeAttribute('role');
          return button;
        }))));
    }
  }
  return h('div', {class: 'aim-scroll dense'}, grid);
}

// ---------- Two measures against each other ----------
// Overall fit and novelty are Claude's scores in the field where a paper fits best. Distance is the
// embedding measure for that same field: distance from its published papers in the corpus, as a percentile.
// Each getter takes an AI alternative, or the focal paper as {score, distance}.
export const MEASURES = {
  fit: {label: 'Overall fit', axis: 'Overall fit in the field where it fits best', short: 'Overall fit (best field)', get: p => p.score?.fit[p.score.bestField]?.score ?? null, scale: 1, format: fmt},
  novelty: {label: 'Novelty', axis: 'Novelty within that field', short: 'Novelty (best field)', get: p => p.score?.novelty.score ?? null, scale: 1, format: fmt},
  distance: {label: 'Distance', axis: 'Distance from the published corpus in that field (percentile)', short: 'Distance from published corpus (pct.)', get: p => p.distance?.toPublishedPercentile?.[p.score?.bestField] ?? null, scale: 100, format: pct}
};

// An axis range that pads the data a little and snaps to round ticks within the measure's scale.
function niceRange(values, scale) {
  const step = scale / 10, lo = Math.min(...values), hi = Math.max(...values);
  let a = Math.max(0, Math.floor((lo - step / 2) / step) * step), b = Math.min(scale, Math.ceil((hi + step / 2) / step) * step);
  if (b - a < 3 * step - step / 1000) { a = Math.max(0, a - step); b = Math.min(scale, b + step); }
  return [a, b, step];
}

// Spearman rank correlation, with tied values given their mean rank.
export function rankCorrelation(xs, ys) {
  const mean = values => values.reduce((sum, v) => sum + v, 0) / values.length;
  const ranks = values => {
    const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]), out = [];
    for (let i = 0; i < order.length;) {
      let j = i; while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
      for (let k = i; k <= j; k++) out[order[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return out;
  };
  if (xs.length < 3) return null;
  const rx = ranks(xs), ry = ranks(ys), mx = mean(rx), my = mean(ry);
  let sxy = 0, sxx = 0, syy = 0;
  rx.forEach((r, i) => { sxy += (r - mx) * (ry[i] - my); sxx += (r - mx) ** 2; syy += (ry[i] - my) ** 2; });
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

// One small scatter plot per pair of measures, side by side. Pointing at a dot outlines the same
// alternative in every plot. Each plot gives the rank correlation of its two
// measures across the alternatives the filters show; the paper is marked but not counted.
export function measureTrio({alternatives, fields, original, passes, onSelect, pairs}) {
  const node = h('div', {class: 'trio'});
  const paper = original && {score: original, distance: original.distance};
  const byId = new Map();
  const link = id => {
    for (const [altId, marks] of byId) marks.forEach(mark => mark.classList.toggle('linked', altId === id));
  };
  const plots = pairs.map(([xKey, yKey]) => {
    const X = MEASURES[xKey], Y = MEASURES[yKey];
    const width = 380, height = 340, m = {l: 52, r: 18, t: 18, b: 50};
    const placed = alternatives.filter(alt => X.get(alt) !== null && Y.get(alt) !== null);
    const all = [...placed, ...(paper && X.get(paper) !== null && Y.get(paper) !== null ? [paper] : [])];
    const [x0, x1, xStep] = niceRange(all.map(X.get), X.scale), [y0, y1, yStep] = niceRange(all.map(Y.get), Y.scale);
    const x = v => m.l + (v - x0) / (x1 - x0) * (width - m.l - m.r);
    const y = v => height - m.b - (v - y0) / (y1 - y0) * (height - m.t - m.b);
    const tick = (v, scale) => scale === 1 ? v.toFixed(1) : String(Math.round(v));
    const root = s('svg', {viewBox: `0 0 ${width} ${height}`, width, height, role: 'group', 'aria-label': `${X.label} against ${Y.label.toLowerCase()}`});
    const grid = s('g', {class: 'grid'});
    for (let t = x0; t <= x1 + xStep / 100; t += xStep) {
      grid.append(s('line', {x1: x(t), x2: x(t), y1: m.t, y2: height - m.b}));
      root.append(s('text', {class: 'tick', x: x(t), y: height - m.b + 18, 'text-anchor': 'middle'}, tick(t, X.scale)));
    }
    for (let t = y0; t <= y1 + yStep / 100; t += yStep) {
      grid.append(s('line', {x1: m.l, x2: width - m.r, y1: y(t), y2: y(t)}));
      root.append(s('text', {class: 'tick', x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end'}, tick(t, Y.scale)));
    }
    root.append(grid);
    root.append(s('text', {x: (m.l + width - m.r) / 2, y: height - 8, 'text-anchor': 'middle'}, X.short));
    root.append(s('text', {x: -(m.t + height - m.b) / 2, y: 14, transform: 'rotate(-90)', 'text-anchor': 'middle'}, Y.short));
    // Scores are given to two decimals, so several alternatives can share a point; spread those
    // around a small circle so each stays visible and selectable.
    const groups = new Map();
    for (const alt of placed) {
      const key = `${X.get(alt)}|${Y.get(alt)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(alt);
    }
    const offset = new Map();
    for (const group of groups.values()) group.forEach((alt, i) => {
      const r = group.length === 1 ? 0 : 5 + 2 * Math.floor(i / 6), a = (i % 6) * Math.PI / 3 + (Math.floor(i / 6) * Math.PI / 6);
      offset.set(alt.id, [r * Math.cos(a), r * Math.sin(a)]);
    });
    const marks = placed.map(alt => {
      const [dx, dy] = offset.get(alt.id);
      const mark = s('g', {class: 'mark', transform: `translate(${x(X.get(alt)) + dx} ${y(Y.get(alt)) + dy})`},
        s('circle', {class: 'hit', r: 9}),
        s('circle', {class: 'dot', r: 5, fill: fieldColor(alt.score.bestField)}));
      bindMark(mark, {id: alt.id, tooltip: () => altTooltip(alt, fields), onSelect: () => onSelect(alt), label: `${alt.outline.title}: ${X.label.toLowerCase()} ${X.format(X.get(alt))}, ${Y.label.toLowerCase()} ${Y.format(Y.get(alt))}`});
      for (const type of ['pointerenter', 'focus']) mark.addEventListener(type, () => link(alt.id));
      for (const type of ['pointerleave', 'blur']) mark.addEventListener(type, () => link(null));
      if (!byId.has(alt.id)) byId.set(alt.id, []);
      byId.get(alt.id).push(mark);
      root.append(mark);
      return {alt, mark};
    });
    if (all.includes(paper)) {
      const ox = x(X.get(paper)), oy = y(Y.get(paper));
      const star = Array.from({length: 10}, (_, i) => {
        const r = i % 2 ? 4 : 9, a = -Math.PI / 2 + i * Math.PI / 5;
        return `${i ? 'L' : 'M'}${ox + r * Math.cos(a)} ${oy + r * Math.sin(a)}`;
      }).join('') + 'Z';
      root.append(s('path', {class: 'paper-mark', d: star}));
    }
    const rho = h('p', {class: 'trio-rho'});
    const figure = h('figure', {class: 'trio-plot'}, h('figcaption', null, `${X.label} vs ${Y.label.toLowerCase()}`), root, rho);
    const update = () => {
      const shown = marks.filter(({alt, mark}) => { mark.classList.toggle('faded', !passes(alt)); return passes(alt); }).map(({alt}) => alt);
      const r = rankCorrelation(shown.map(X.get), shown.map(Y.get));
      rho.replaceChildren('Rank correlation ', h('strong', null, r === null ? '–' : fmt(r)), ` · ${shown.length} AI alternatives`);
    };
    return {figure, update};
  });
  node.append(...plots.map(plot => plot.figure));
  const update = () => plots.forEach(plot => plot.update());
  update();
  return {node, update};
}
