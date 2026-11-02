// Bottom timeline: one icon per feature, in build order.

import { el, contextMenu } from './ui.js';
import { ICONS } from './icons.js';
import { FEATURE_TYPES } from './features.js';

export function renderTimeline(app, container) {
  const scroll = container.scrollLeft, before = Number(container.dataset.count) || 0;
  container.dataset.count = app.doc.features.length;
  container.replaceChildren();
  const { features } = app.doc;
  if (!features.length) {
    container.append(el('span', { class: 'muted' }, 'Timeline: features appear here as you add them. Double-click one to edit it.'));
    return;
  }
  features.forEach((f, i) => {
    const err = app.errors[f.id];
    const warn = app.warnings[f.id];
    const cls = ['tl-item', err && 'error', !err && warn && 'warning', f.suppressed && 'suppressed', app.editingIndex === i && 'editing']
      .filter(Boolean).join(' ');
    const title = `${f.name}${f.suppressed ? ' (suppressed)' : ''}${err ? `\n⚠ ${err}` : warn ? `\n${warn}` : ''}`;
    const item = el('button', { class: cls, title, html: ICONS[FEATURE_TYPES[f.type].icon] });
    item.addEventListener('dblclick', () => app.editFeature(i));
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, featureMenu(app, i));
    });
    container.append(item);
  });
  // A new step scrolls to the end, so the latest are in view; the step being edited is
  // kept in view; otherwise the timeline stays where it was.
  const editing = container.querySelector('.tl-item.editing');
  if (features.length > before) container.scrollLeft = container.scrollWidth;
  else {
    container.scrollLeft = scroll;
    editing?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

export function featureMenu(app, i) {
  const f = app.doc.features[i];
  return [
    { label: `Edit ${f.name}`, onClick: () => app.editFeature(i) },
    { label: 'Rename', onClick: () => app.renameFeature(i) },
    { label: f.suppressed ? 'Unsuppress' : 'Suppress', onClick: () => app.toggleSuppress(i) },
    null,
    { label: 'Delete', onClick: () => app.deleteFeature(i) },
  ];
}
