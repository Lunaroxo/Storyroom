'use strict';
// Shared state and small UI helpers used by every section.
let S = null; // the whole show; saved to project.json
const ui = {}; // what is selected right now; not saved
const VIEW = {};

const $ = (sel, root = document) => root.querySelector(sel);
const uid = () => Math.random().toString(36).slice(2, 10);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  el.append(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  for (const [k, v] of Object.entries(props || {})) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k in el && k !== 'list') el[k] = v;
    else if (v != null && v !== false) el.setAttribute(k, v);
  }
  return el;
}

const btn = (label, onclick, cls = '', title = '') => h('button', { class: `btn ${cls}`, onclick, title, type: 'button' }, label);
const url = (rel) => rel.split('/').map(encodeURIComponent).join('/');

// An input or textarea whose value lives in obj[key].
const bind = (obj, key, props = {}, tag = 'input') => h(tag, {
  ...props,
  value: obj[key] ?? '',
  oninput(e) { obj[key] = e.target.value; touch(); props.oninput?.(e); },
});

function select(options, value, onchange, props = {}) {
  return h('select', { ...props, value, onchange: (e) => onchange(e.target.value) },
    options.map((o) => (Array.isArray(o) ? h('option', { value: o[0] }, o[1]) : h('option', { value: o }, o))));
}

function toast(text, isError) {
  const el = h('div', { class: `toast ${isError ? 'err' : ''}` }, text);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), isError ? 7000 : 3000);
}
addEventListener('unhandledrejection', (e) => toast(String(e.reason?.message || e.reason).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true));

// window.prompt does not exist in Electron, and window.confirm can leave text fields unfocusable.
function dialogBox({ title, text, input, okText = 'OK', danger }) {
  return new Promise((resolve) => {
    const field = input != null ? h('input', { value: input, class: 'wide' }) : null;
    const close = (result) => { overlay.remove(); resolve(result); };
    const ok = () => close(field ? field.value.trim() || null : true);
    const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true' },
      h('form', { class: 'dialog', onsubmit: (e) => { e.preventDefault(); ok(); }, onkeydown: (e) => { if (e.key === 'Escape') close(field ? null : false); } },
        h('h3', {}, title), text && h('p', {}, text), field,
        h('div', { class: 'row end' },
          h('button', { type: 'button', class: 'btn', onclick: () => close(field ? null : false) }, 'Cancel'),
          h('button', { type: 'submit', class: `btn ${danger ? 'danger' : 'primary'}` }, okText))));
    document.body.append(overlay);
    (field || $('button[type=submit]', overlay)).focus();
  });
}
const confirmDelete = (name) => dialogBox({ title: `Delete "${name}"?`, text: 'This cannot be undone.', okText: 'Delete', danger: true });

// --- Saving ------------------------------------------------------------------------------------
let saveTimer;
let dirty = false;
let switching = false;

function touch() {
  dirty = true;
  $('#saveState') && ($('#saveState').textContent = 'Saving...');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 600);
}

function saveNow() {
  clearTimeout(saveTimer);
  if (!dirty || switching) return;
  commitEditors();
  const error = api.save(JSON.stringify(S));
  if (error) return toast(`Could not save: ${error}`, true);
  dirty = false;
  $('#saveState') && ($('#saveState').textContent = 'Saved');
}
addEventListener('beforeunload', saveNow);

// --- Drag to reorder ---------------------------------------------------------------------------
let dragging = null;
function sortable(handle, target, arr, item, done) {
  handle.draggable = true;
  handle.addEventListener('dragstart', (e) => {
    dragging = { arr, item };
    e.stopPropagation();
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setDragImage(target, 12, 12);
  });
  handle.addEventListener('dragend', () => { dragging = null; });
  target.addEventListener('dragover', (e) => {
    if (dragging?.arr !== arr) return;
    e.preventDefault();
    e.stopPropagation();
    target.classList.add('drop');
  });
  target.addEventListener('dragleave', () => target.classList.remove('drop'));
  target.addEventListener('drop', (e) => {
    if (dragging?.arr !== arr) return;
    e.preventDefault();
    e.stopPropagation();
    target.classList.remove('drop');
    const to = arr.indexOf(item); // read before removing, so dragging down lands after the target
    arr.splice(to, 0, ...arr.splice(arr.indexOf(dragging.item), 1));
    touch();
    done();
  });
}

const plainText = (html) => new DOMParser().parseFromString(html, 'text/html').body.textContent;
const countWords = (html) => (plainText(html.replace(/<\/(p|h\d|li|div|td|blockquote)>/g, ' ')).trim().match(/\S+/g) || []).length;
const clock = (s) => `${Math.floor((s || 0) / 60)}:${String(Math.floor((s || 0) % 60)).padStart(2, '0')}`;

// --- Navigation --------------------------------------------------------------------------------
const icon = (path) => `<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
const SECTIONS = [
  ['show', 'Show', '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5M9 8h6"/>'],
  ['writing', 'Writing', '<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>'],
  ['characters', 'Characters', '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-5 4-7 8-7s7 2 8 7"/>'],
  ['world', 'World', '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3.5 15 0 18M12 3c-3 3-3.5 15 0 18"/>'],
  ['storyboard', 'Storyboard', '<rect x="3" y="4" width="8" height="7" rx="1"/><rect x="13" y="4" width="8" height="7" rx="1"/><rect x="3" y="13" width="8" height="7" rx="1"/><rect x="13" y="13" width="8" height="7" rx="1"/>'],
  ['library', 'Library', '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>'],
  ['record', 'Recording', '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'],
  ['find', 'Find Sounds','<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/>'],
  ['todo', 'To Do', '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 12.5l2.5 2.5 4.5-5.5"/>'],
  ['production', 'Production','<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="10" rx="1"/><rect x="17" y="4" width="4" height="13" rx="1"/>'],
];

function buildRail() {
  $('#rail').append(...SECTIONS.map(([id, label, path]) => {
    const b = h('button', { class: 'rail-btn', type: 'button', onclick: () => go(id), 'data-view': id });
    b.innerHTML = icon(path);
    b.append(h('span', {}, label));
    return b;
  }), h('div', { class: 'spring' }), h('div', { id: 'saveState' }, 'Saved'));
}

function go(id) {
  saveNow();
  closeEditors();
  ui.view = id;
  document.querySelectorAll('.rail-btn').forEach((b) => b.classList.toggle('on', b.dataset.view === id));
  $('#main').classList.toggle('off', id === 'find');
  $('#find').classList.toggle('off', id !== 'find');
  const host = $(id === 'find' ? '#find' : '#main');
  if (id === 'find') VIEW.find();
  else { host.replaceChildren(); VIEW[id](host); }
  // Only on section change: inner redraws happen on every keystroke and must not re-animate.
  host.classList.remove('view-in');
  void host.offsetWidth;
  host.classList.add('view-in');
  setTimeout(() => host.classList.remove('view-in'), 800);
}

// --- Backups -----------------------------------------------------------------------------------
async function openBackups() {
  saveNow();
  const restore = async (name, label) => {
    const ok = await dialogBox({ title: `Go back to ${label}?`, text: 'Your show returns to how it was then. Right now gets backed up first, so you can come back to it.', okText: 'Restore' });
    if (!ok) return;
    switching = true;
    try {
      if (!(await api['backup:restore'](name))) switching = false;
    } catch (err) {
      switching = false;
      throw err;
    }
  };
  const when = (name) => {
    const m = /^project-(\d{4})-(\d\d)-(\d\d)(?:_(\d\d)-(\d\d)-(\d\d))?/.exec(name);
    const d = new Date(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) + (m[4] ? `, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })}` : ' (daily)');
  };
  const list = h('div', { class: 'backup-list' });
  const draw = async () => {
    const backups = await api['backup:list']();
    list.replaceChildren(...(backups.length ? backups.map((b) => h('div', { class: 'backup-row' },
      h('span', { class: 'grow' }, when(b.name)), h('span', { class: 'muted' }, `${Math.max(1, Math.round(b.size / 1024))} KB`),
      btn('Restore', () => restore(b.name, when(b.name)))))
      : [h('p', { class: 'muted' }, 'No backups yet. One is made every 2 minutes while things change.')]));
  };
  const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', onkeydown: (e) => { if (e.key === 'Escape') overlay.remove(); } },
    h('div', { class: 'dialog wide-dialog' },
      h('div', { class: 'row between' }, h('h3', {}, 'Backups'), h('button', { class: 'x show', type: 'button', title: 'Close', onclick: () => overlay.remove() }, '×')),
      h('p', {}, 'Saved every 2 minutes while you work. Everything from the last 2 days is kept, then one per day. Covers your writing, pages, boards and lists. Images and sound files stay in their folders.'),
      list,
      h('div', { class: 'row end' },
        btn('Import backup file...', () => restore(null, 'an imported backup')),
        btn('Back up now', async () => { await api['backup:now'](); toast('Backed up'); draw(); }, 'primary'))));
  document.body.append(overlay);
  await draw();
  $('.btn', overlay)?.focus();
}

// --- Show overview ------------------------------------------------------------------------------
VIEW.show = (root) => {
  const s = S.show;
  const words = S.episodes.reduce((n, e) => n + allParts(e).reduce((m, p) => m + countWords(p.html), 0), 0);
  const panels = S.episodes.reduce((n, e) => n + e.panels.length, 0);
  const stats = [['Episodes', S.episodes.length], ['Words', words.toLocaleString()], ['Panels', panels], ['Characters', S.pages.filter((p) => p.kind === 'character').length], ['Tracks', S.library.items.length]];
  const switchShow = async (create) => {
    const dir = await api['project:switch'](create);
    if (!dir) return;
    saveNow();
    switching = true;
    await api['project:open'](dir);
  };
  const info = (label, key, placeholder) => h('label', { class: 'field' }, h('span', {}, label), bind(s, key, { placeholder }));
  root.append(h('div', { class: 'scroll' }, h('div', { class: 'column' },
    h('div', { class: 'row between' },
      h('p', { class: 'eyebrow' }, 'Series overview'),
      h('div', { class: 'row' }, btn('Backups', openBackups), btn('New show...', () => switchShow(true)), btn('Open show...', () => switchShow(false)))),
    bind(s, 'title', { class: 'title-input', placeholder: 'Show title', 'aria-label': 'Show title' }),
    bind(s, 'logline', { class: 'wide logline', placeholder: 'One-sentence logline', rows: 2, 'aria-label': 'Logline' }, 'textarea'),
    h('div', { class: 'stats' }, stats.map(([k, v]) => h('div', { class: 'stat' }, h('b', {}, String(v)), h('span', {}, k)))),
    h('div', { class: 'grid3' },
      info('Genre', 'genre', 'Comedy, adventure...'), info('Audience', 'audience', 'Ages 7-12, adult...'), info('Rating', 'rating', 'TV-Y7, TV-14...'),
      info('Episode length', 'runtime', '11 min, 22 min...'), info('Episodes planned', 'planned', '10'), info('Animation style', 'style', '2D, cut-out, 3D...')),
    h('h2', { class: 'section-title' }, 'Series bible'),
    makeEditor(s, 'bible', { placeholder: 'Premise, themes, tone, rules of the world, season arc...' }))));
};
