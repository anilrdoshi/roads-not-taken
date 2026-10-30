// Small DOM helpers. All text from the data goes in through textContent, never innerHTML:
// alternatives and reviews are model output and are treated as untrusted text.
const SVG_NS = 'http://www.w3.org/2000/svg';

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function setAttrs(node, attrs) {
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.setAttribute('class', value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  return node;
}

export const h = (tag, attrs, ...children) => append(setAttrs(document.createElement(tag), attrs), children);
export const s = (tag, attrs, ...children) => append(setAttrs(document.createElementNS(SVG_NS, tag), attrs), children);

export const fieldColor = fieldId => `var(--f-${fieldId})`;
export const fmt = value => value === null || value === undefined ? '–' : Number(value).toFixed(2);

// Deterministic pseudo-random number in [0, 1) from a string, for stable layouts.
export function hash01(text) {
  let h1 = 2166136261;
  for (let i = 0; i < text.length; i++) { h1 ^= text.charCodeAt(i); h1 = Math.imul(h1, 16777619); }
  return ((h1 >>> 0) % 100000) / 100000;
}

export const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- Tooltip (one for the whole page) ----------
const tooltip = () => document.getElementById('tooltip');

export function showTooltip(anchor, content, event) {
  const tip = tooltip();
  tip.replaceChildren(content);
  tip.hidden = false;
  const rect = event && event.clientX !== undefined ? {left: event.clientX, top: event.clientY, width: 0, height: 0} : anchor.getBoundingClientRect();
  const width = tip.offsetWidth, height = tip.offsetHeight;
  let left = rect.left + rect.width / 2 + 14, top = rect.top + rect.height / 2 + 14;
  if (left + width > window.innerWidth - 8) left = rect.left - width - 14;
  if (top + height > window.innerHeight - 8) top = rect.top - height - 14;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}

export function hideTooltip() {
  tooltip().hidden = true;
}

// Binds hover, focus and click behaviour to a chart mark. `id` names the AI alternative it stands
// for, so every mark of the same one can be highlighted together.
export function bindMark(node, {tooltip: content, onSelect, label, id}) {
  node.setAttribute('tabindex', '0');
  node.setAttribute('role', 'button');
  if (label) node.setAttribute('aria-label', label);
  if (id) node.setAttribute('data-alt', id);
  node.addEventListener('pointerenter', event => showTooltip(node, content(), event));
  node.addEventListener('pointermove', event => showTooltip(node, content(), event));
  node.addEventListener('pointerleave', hideTooltip);
  node.addEventListener('focus', () => showTooltip(node, content()));
  node.addEventListener('blur', hideTooltip);
  node.addEventListener('click', () => { hideTooltip(); onSelect?.(); });
  node.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); hideTooltip(); onSelect?.(); }
  });
}

// A table twin for any chart: rows of plain values, sortable by clicking a header.
// A numeric column is right-aligned and may also carry its own class (for example hide-md).
const cellClass = column => [column.num ? 'num' : null, column.className].filter(Boolean).join(' ') || null;

export function dataTable(columns, rows, {onRow} = {}) {
  let sortKey = null, direction = 1;
  const tbody = h('tbody');
  const headCells = columns.map(column => {
    const th = h('th', {class: cellClass(column), scope: 'col'});
    const button = h('button', {type: 'button'}, column.label);
    button.addEventListener('click', () => {
      direction = sortKey === column.key ? -direction : (column.num ? -1 : 1);
      sortKey = column.key;
      headCells.forEach(cell => cell.removeAttribute('aria-sort'));
      th.setAttribute('aria-sort', direction === 1 ? 'ascending' : 'descending');
      render();
    });
    th.append(button);
    return th;
  });
  const render = () => {
    const sorted = sortKey === null ? rows : [...rows].sort((a, b) => {
      const x = a[sortKey], y = b[sortKey];
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (x > y ? 1 : -1) * direction;
    });
    tbody.replaceChildren(...sorted.map(row => {
      const tr = h('tr', {tabindex: onRow ? '0' : null, 'data-alt': onRow && row.id}, columns.map(column => h('td', {class: cellClass(column)}, column.render ? column.render(row) : (column.num ? fmt(row[column.key]) : row[column.key] ?? '–'))));
      if (onRow) {
        tr.addEventListener('click', () => onRow(row));
        tr.addEventListener('keydown', event => { if (event.key === 'Enter') onRow(row); });
      }
      return tr;
    }));
  };
  render();
  return h('table', {class: 'data-table'}, h('thead', null, h('tr', null, headCells)), tbody);
}

export function withTableToggle(chartNode, makeTable) {
  const wrapper = h('div', {class: 'chart'}, chartNode);
  let table = null;
  const button = h('button', {type: 'button', class: 'link-button table-toggle small'}, 'Show as table');
  button.addEventListener('click', () => {
    if (table) { table.remove(); table = null; button.textContent = 'Show as table'; return; }
    table = makeTable();
    button.after(table);
    button.textContent = 'Hide table';
  });
  return h('div', null, wrapper, button);
}
