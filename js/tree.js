// Left "Browser" tree: origin, bodies and sketches with visibility toggles.

import { el, contextMenu } from './ui.js';
import { ICONS } from './icons.js';
import { featureMenu } from './timeline.js';

function eye(visible, onToggle) {
  const b = el('button', { class: 'eye', title: visible ? 'Hide' : 'Show', html: visible ? ICONS.eye : ICONS.eyeOff });
  b.addEventListener('click', (e) => { e.stopPropagation(); onToggle(); });
  return b;
}

function node(icon, label, extra = {}) {
  return el('div', { class: `tree-node ${extra.cls || ''}`, title: extra.title || '' },
    extra.eye || el('span', { class: 'eye-spacer' }),
    el('span', { class: 'tree-icon', html: ICONS[icon] }),
    el('span', { class: 'tree-label' }, label));
}

function folder(label, open, children) {
  const d = el('details', { open });
  d.append(el('summary', {}, el('span', { class: 'tree-icon', html: ICONS.folder }), label));
  d.append(...children);
  return d;
}

export function renderTree(app, container) {
  const { doc } = app;
  container.replaceChildren();
  const nameInput = el('input', { class: 'doc-name', value: doc.name, title: 'Document name' });
  nameInput.addEventListener('change', () => app.renameDocument(nameInput.value));
  container.append(nameInput);

  container.append(folder('Origin', false, [
    node('origin', 'Origin planes', { eye: eye(app.showOrigin, () => app.toggleOrigin()) }),
  ]));

  const bodies = app.bodies.map((b) => {
    const visible = !doc.hiddenBodies.includes(b.id);
    const vol = b.volume != null ? `${(b.volume / 1000).toFixed(2)} cm³` : '';
    const n = node('body', b.name, {
      eye: eye(visible, () => app.toggleBody(b.id)), title: vol,
      cls: `body-node ${app.isBodySelected(b.id) ? 'selected' : ''}`,
    });
    n.addEventListener('click', (e) => app.bodyClicked(b.id, e.ctrlKey || e.metaKey));
    n.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: 'Export STL…', onClick: () => app.exportBodies('stl', [b.id], b.name) },
        { label: 'Export 3MF…', onClick: () => app.exportBodies('3mf', [b.id], b.name) },
        { label: 'Remove', onClick: () => app.removeBodies([b.id]) },
      ]);
    });
    return n;
  });
  container.append(folder(`Bodies (${bodies.length})`, true, bodies.length ? bodies : [el('div', { class: 'muted tree-empty' }, 'None yet')]));

  const sketches = [];
  doc.features.forEach((f, i) => {
    if (f.type !== 'sketch') return;
    const n = node('sketch', f.name, {
      eye: eye(!f.hidden, () => app.toggleSketch(i)),
      cls: app.errors[f.id] ? 'error' : '',
    });
    n.addEventListener('dblclick', () => app.editFeature(i));
    n.addEventListener('contextmenu', (e) => { e.preventDefault(); contextMenu(e.clientX, e.clientY, featureMenu(app, i)); });
    sketches.push(n);
  });
  container.append(folder(`Sketches (${sketches.length})`, true, sketches.length ? sketches : [el('div', { class: 'muted tree-empty' }, 'None yet')]));
}
