// Tiny DOM helpers shared by the panels.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  if (attrs.value != null && 'value' in node) node.value = attrs.value;
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

export function field(label, input) {
  return el('label', { class: 'field' }, el('span', {}, label), input);
}

// Numbers can be typed as simple arithmetic, e.g. "40/2 + 3".
export function num(text) {
  const s = String(text).trim().replace(/mm$/i, '').trim();
  if (!/^[\d\s.+\-*/()]+$/.test(s)) return NaN;
  try {
    const v = Function(`"use strict"; return (${s});`)();
    return Number.isFinite(v) ? v : NaN;
  } catch {
    return NaN;
  }
}

export function contextMenu(x, y, items) {
  document.querySelector('.context-menu')?.remove();
  const menu = el('div', { class: 'context-menu' });
  for (const it of items) {
    if (!it) { menu.append(el('hr')); continue; }
    menu.append(el('button', { onclick: () => { menu.remove(); it.onClick(); } }, it.label));
  }
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.append(menu);
  // Keep it on screen: near the bottom or right edge it opens up or to the left.
  const r = menu.getBoundingClientRect();
  if (r.bottom > window.innerHeight - 4) menu.style.top = `${Math.max(4, y - r.height)}px`;
  if (r.right > window.innerWidth - 4) menu.style.left = `${Math.max(4, x - r.width)}px`;
  const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); window.removeEventListener('pointerdown', close, true); } };
  setTimeout(() => window.addEventListener('pointerdown', close, true));
}
