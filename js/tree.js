// Left "Browser" tree: origin, bodies and sketches with visibility toggles.

import { el, contextMenu } from './ui.js';
import { ICONS } from './icons.js';
import { featureMenu } from './timeline.js';

function eye(visible, onToggle) {
  const b = el('button', { class: 'eye', title: visible ? 'Hide' : 'Show', html: visible ? ICONS.eye : ICONS.eyeOff });
  b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onToggle(); });
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

// Bodies dropped on a folder (or on Bodies) are moved there.
function dropTarget(target, onDrop) {
  const has = (e) => e.dataTransfer.types.includes('text/newfiecad-bodies');
  target.addEventListener('dragover', (e) => { if (has(e)) { e.preventDefault(); target.classList.add('drop'); } });
  target.addEventListener('dragleave', () => target.classList.remove('drop'));
  target.addEventListener('drop', (e) => {
    target.classList.remove('drop');
    if (!has(e)) return;
    e.preventDefault();
    onDrop(JSON.parse(e.dataTransfer.getData('text/newfiecad-bodies')));
  });
}

// Rename in place: the label becomes a text box. Enter or clicking away keeps it, Esc doesn't.
export function editLabel(row, value, onDone) {
  const label = row.querySelector('.tree-label');
  if (!label) return;
  const input = el('input', { class: 'tree-rename', value });
  label.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    input.replaceWith(label);
    if (keep && input.value.trim() && input.value.trim() !== value) onDone(input.value);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
}

// A new folder opens with its name ready to type.
function renameNewFolder(app, fid) {
  const sum = document.querySelector(`[data-folder="${fid}"] > summary`);
  const f = app.doc.folders.find((x) => x.id === fid);
  if (sum && f) editLabel(sum, f.name, (v) => app.renameFolder(fid, v));
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

  // Bodies, in your folders and then loose. Drag bodies onto a folder (or onto Bodies to
  // take them out); right-click or double-click to rename.
  const bodyNode = (b) => {
    const visible = !doc.hiddenBodies.includes(b.id);
    const vol = b.volume != null ? `${(b.volume / 1000).toFixed(2)} cm³` : '';
    const n = node('body', b.name, {
      eye: eye(visible, () => app.toggleBody(b.id)), title: vol,
      cls: `body-node ${app.isBodySelected(b.id) ? 'selected' : ''}`,
    });
    n.draggable = true;
    n.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/newfiecad-bodies', JSON.stringify(app.bodiesFor(b.id))); });
    n.addEventListener('click', (e) => app.bodyClicked(b.id, e.ctrlKey || e.metaKey));
    n.addEventListener('dblclick', () => editLabel(n, b.name, (v) => app.renameBody(b.id, v)));
    n.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const ids = app.bodiesFor(b.id), here = app.folderOf(b.id);
      contextMenu(e.clientX, e.clientY, [
        { label: 'Rename', onClick: () => editLabel(n, b.name, (v) => app.renameBody(b.id, v)) },
        null,
        ...doc.folders.filter((f) => f.id !== here).map((f) => ({ label: `Move to ${f.name}`, onClick: () => app.moveToFolder(ids, f.id) })),
        ...(here ? [{ label: 'Move out of the folder', onClick: () => app.moveToFolder(ids, null) }] : []),
        { label: ids.length > 1 ? `New folder with these ${ids.length}` : 'New folder with this body', onClick: () => renameNewFolder(app, app.newFolder(ids)) },
        null,
        { label: 'Export STL…', onClick: () => app.exportBodies('stl', [b.id], b.name) },
        { label: 'Export 3MF…', onClick: () => app.exportBodies('3mf', [b.id], b.name) },
        { label: 'Export STEP…', onClick: () => app.exportBodies('step', [b.id], b.name) },
        { label: 'Remove', onClick: () => app.removeBodies([b.id]) },
      ]);
    });
    return n;
  };

  const folderNodes = doc.folders.map((f) => {
    const ids = app.folderBodies(f.id);
    const visible = ids.some((id) => !doc.hiddenBodies.includes(id));
    const d = el('details', { open: f.open, class: 'user-folder', 'data-folder': f.id });
    const label = el('span', { class: 'tree-label' }, `${f.name} (${ids.length})`);
    const sum = el('summary', {}, eye(visible, () => app.toggleFolder(f.id)), el('span', { class: 'tree-icon', html: ICONS.folder }), label);
    d.append(sum, ...app.bodies.filter((b) => ids.includes(b.id)).map(bodyNode));
    if (!ids.length) d.append(el('div', { class: 'muted tree-empty' }, 'Empty: drag bodies here'));
    d.addEventListener('toggle', () => app.setFolderOpen(f.id, d.open));
    sum.addEventListener('dblclick', (e) => { e.preventDefault(); editLabel(sum, f.name, (v) => app.renameFolder(f.id, v)); });
    sum.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: 'Rename', onClick: () => editLabel(sum, f.name, (v) => app.renameFolder(f.id, v)) },
        { label: 'Select all', onClick: () => app.selectFolder(f.id) },
        { label: visible ? 'Hide all' : 'Show all', onClick: () => app.toggleFolder(f.id) },
        null,
        { label: 'Delete folder (keeps the bodies)', onClick: () => app.deleteFolder(f.id) },
      ]);
    });
    dropTarget(sum, (ids2) => app.moveToFolder(ids2, f.id));
    return d;
  });
  const loose = app.bodies.filter((b) => !app.folderOf(b.id)).map(bodyNode);
  const bodiesFolder = folder(`Bodies (${app.bodies.length})`, true,
    folderNodes.length || loose.length ? [...folderNodes, ...loose] : [el('div', { class: 'muted tree-empty' }, 'None yet')]);
  const head = bodiesFolder.querySelector('summary');
  head.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [{ label: 'New folder', onClick: () => renameNewFolder(app, app.newFolder()) }]);
  });
  dropTarget(head, (ids) => app.moveToFolder(ids, null));
  container.append(bodiesFolder);

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
