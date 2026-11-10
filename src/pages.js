'use strict';
// Character pages and world pages share one layout.
const WORLD_KINDS = [['location', 'Location'], ['lore', 'Lore'], ['art', 'Art style'], ['prop', 'Prop'], ['note', 'Note']];
const SEED_FIELDS = {
  character: ['Role', 'Age', 'Personality', 'Wants', 'Fears', 'Voice', 'Catchphrase'],
  location: ['Where', 'Mood', 'Time of day'],
  prop: ['Owner', 'Purpose'],
};

function newPage(kind, name) {
  return { id: uid(), kind, name, image: '', colors: [], html: '<p><br></p>', fields: (SEED_FIELDS[kind] || []).map((k) => ({ k, v: '' })) };
}

function appearsIn(name) {
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu');
  return S.episodes.filter((e) => allParts(e).some((p) => pattern.test(plainText(p.html.replace(/<\/p>/g, ' ')))) || e.panels.some((p) => pattern.test(`${p.action} ${p.dialogue}`)));
}

function pagesView(root, { kinds, heading, defaultKind }) {
  const key = `page_${heading}`;
  const list = h('div', { class: 'side-body' });
  const pane = h('section', { class: 'pane' });
  const pages = () => S.pages.filter((p) => kinds.includes(p.kind));
  const current = () => pages().find((p) => p.id === ui[key]) || pages()[0];
  let filter = '';

  const add = async () => {
    const name = await dialogBox({ title: `New ${heading === 'Characters' ? 'character' : 'page'}`, input: '', okText: 'Add' });
    if (!name) return;
    const page = newPage(defaultKind, name);
    S.pages.push(page);
    touch();
    pick(page);
  };

  function pick(page) {
    closeEditors();
    ui[key] = page?.id;
    drawList();
    drawPage();
  }

  // Versions (another dimension, age, costume...) are pages with `parent` set, listed under it.
  const versionsOf = (p) => pages().filter((x) => x.parent === p.id);
  const family = (p) => [p, ...versionsOf(p).flatMap(family)];

  async function addVersion(base) {
    const name = await dialogBox({ title: `New version of ${base.name}`, text: 'Another dimension, age, form or outfit. It starts as a copy you can change.', input: `${base.name} (alt)`, okText: 'Add' });
    if (!name) return;
    commitEditors();
    const version = { ...structuredClone(base), id: uid(), name, parent: base.id, html: '<p><br></p>' };
    delete version.open;
    base.open = true;
    S.pages.push(version);
    touch();
    pick(version);
  }

  function drawList() {
    const cur = current();
    const all = pages();
    const row = (p, depth, withVersions) => {
      const versions = withVersions ? versionsOf(p) : [];
      const el = h('div', { class: `page-row ${p === cur ? 'on' : ''}`, style: `margin-left:${depth * 18}px`, onclick: () => pick(p) },
        h('button', { class: `caret ${versions.length ? '' : 'hide'}`, type: 'button', title: p.open === false ? 'Show versions' : 'Hide versions', onclick: (e) => { e.stopPropagation(); p.open = p.open === false; touch(); drawList(); } }, p.open === false ? '▸' : '▾'),
        p.image ? h('img', { src: url(p.image), alt: '' }) : h('div', { class: 'thumb-blank' }, (p.name[0] || '?').toUpperCase()),
        h('div', { class: 'grow ellipsis' }, p.name || 'Untitled', kinds.length > 1 && h('small', {}, WORLD_KINDS.find(([k]) => k === p.kind)?.[1])),
        h('button', { class: 'x', type: 'button', title: 'Add a version of this', onclick: (e) => { e.stopPropagation(); addVersion(p); } }, '+'));
      sortable(el, el, S.pages, p, drawList);
      return [el, ...(p.open === false ? [] : versions.flatMap((v) => row(v, depth + 1, true)))];
    };
    const shown = filter
      ? all.filter((p) => p.name.toLowerCase().includes(filter)).flatMap((p) => row(p, 0, false))
      : all.filter((p) => !all.some((x) => x.id === p.parent)).flatMap((p) => row(p, 0, true));
    list.replaceChildren(...shown);
  }

  function exportPage(p) {
    commitEditors();
    const sheet = h('div', {},
      p.image && h('img', { class: 'portrait', src: url(p.image) }),
      h('p', { class: 'sheet-title' }, p.name),
      h('dl', {}, p.fields.filter((f) => f.v).map((f) => [h('dt', {}, f.k), h('dd', {}, f.v)])));
    sheet.insertAdjacentHTML('beforeend', p.html);
    api['pdf:export'](sheet.outerHTML, `${S.show.title} - ${p.name}`);
  }

  function drawPage() {
    const p = current();
    if (!p) return pane.replaceChildren(h('div', { class: 'empty-state' }, h('h2', {}, `No ${heading.toLowerCase()} yet`), btn(`Add ${heading === 'Characters' ? 'a character' : 'a page'}`, add, 'primary')));
    const parentPage = S.pages.find((x) => x.id === p.parent);
    const fields = h('div', { class: 'fields' });
    const drawFields = () => fields.replaceChildren(...p.fields.map((f) => h('div', { class: 'kv' },
      bind(f, 'k', { class: 'k', 'aria-label': 'Field name' }),
      bind(f, 'v', { class: 'v wrap-box', rows: 1, 'aria-label': f.k || 'Field value', placeholder: '...' }, 'textarea'),
      h('button', { class: 'x show', type: 'button', title: 'Remove field', onclick: () => { p.fields.splice(p.fields.indexOf(f), 1); touch(); drawFields(); } }, '×'))),
    btn('+ Field', () => { p.fields.push({ k: 'New field', v: '' }); touch(); drawFields(); }, 'ghost'));
    drawFields();

    const colors = h('div', { class: 'swatches' });
    const drawColors = () => colors.replaceChildren(...p.colors.map((c, i) => h('div', { class: 'swatch-box' },
      h('input', { type: 'color', value: c, title: 'Change color', 'aria-label': 'Palette color', onchange: (e) => { p.colors[i] = e.target.value; touch(); } }),
      h('button', { class: 'x show', type: 'button', title: 'Remove color', onclick: () => { p.colors.splice(i, 1); touch(); drawColors(); } }, '×'))),
    btn('+ Color', () => { p.colors.push('#c8a27a'); touch(); drawColors(); }, 'ghost'));
    drawColors();

    const setImage = async () => { const rel = await api['image:pick'](); if (rel) { p.image = rel; touch(); pick(p); } };
    const seen = appearsIn(p.name);
    pane.replaceChildren(h('div', { class: 'scroll' }, h('div', { class: 'page' },
      h('div', { class: 'page-top' },
        h('button', { class: 'portrait', type: 'button', onclick: setImage, title: 'Choose image' }, p.image ? h('img', { src: url(p.image), alt: p.name }) : 'Add image'),
        h('div', { class: 'grow' },
          h('div', { class: 'row between' },
            bind(p, 'name', { class: 'title-input', 'aria-label': 'Name', oninput: drawList }),
            h('div', { class: 'row' },
              kinds.length > 1 && select(WORLD_KINDS, p.kind, (v) => { p.kind = v; touch(); drawList(); }, { 'aria-label': 'Page type' }),
              btn('PDF', () => exportPage(p)),
              btn('+ Version', () => addVersion(p)),
              btn('Delete', async () => {
                const doomed = family(p);
                if (!(await confirmDelete(doomed.length > 1 ? `${p.name} and its ${doomed.length - 1} version(s)` : p.name))) return;
                S.pages = S.pages.filter((x) => !doomed.includes(x));
                touch();
                pick(pages()[0]);
              }, 'danger-text'))),
          parentPage && h('button', { class: 'link', type: 'button', onclick: () => pick(parentPage) }, `Version of ${parentPage.name}`),
          fields,
          h('div', { class: 'row palette' }, h('span', { class: 'muted' }, 'Palette'), colors),
          h('p', { class: 'muted' }, seen.length ? `Mentioned in: ${seen.map((e) => e.title).join(', ')}` : 'Not mentioned in any episode yet'))),
      makeEditor(p, 'html', { placeholder: 'Describe them. Backstory, look, how they talk, relationships. Add images with the toolbar.' }))));
  }

  root.append(h('aside', { class: 'side' },
    h('div', { class: 'side-head' }, h('h2', {}, heading), btn('+ Add', add)),
    h('div', { class: 'side-search' }, h('input', { placeholder: 'Search', 'aria-label': `Search ${heading}`, oninput: (e) => { filter = e.target.value.toLowerCase(); drawList(); } })),
    list), pane);
  drawList();
  drawPage();
}

VIEW.characters = (root) => pagesView(root, { kinds: ['character'], heading: 'Characters', defaultKind: 'character' });
VIEW.world = (root) => pagesView(root, { kinds: WORLD_KINDS.map(([k]) => k), heading: 'World', defaultKind: 'location' });
