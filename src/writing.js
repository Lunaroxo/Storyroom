'use strict';
const EP_STATUS = ['Idea', 'Outline', 'First draft', 'Revisions', 'Locked'];
const newPart = (title) => ({ id: uid(), title, html: '<p><br></p>', children: [], open: true });
const flatParts = (parts, depth = 0) => parts.flatMap((part) => [{ part, depth }, ...flatParts(part.children, depth + 1)]);
const allParts = (ep) => flatParts(ep.parts).map((x) => x.part);
const partOptions = (ep) => flatParts(ep.parts).map(({ part, depth }) => [part.id, '   '.repeat(depth) + part.title]);
const newEpisode = (title) => ({ id: uid(), title, status: 'Idea', logline: '', open: true, panels: [], parts: ['Outline', 'Cold Open', 'Act One', 'Act Two', 'Act Three'].map(newPart) });

function currentEp() {
  const ep = S.episodes.find((e) => e.id === ui.ep) || S.episodes[0];
  return { ep, part: (ep && allParts(ep).find((p) => p.id === ui.part)) || ep?.parts[0] };
}

VIEW.writing = (root) => {
  const tree = h('div', { class: 'side-body' });
  const pane = h('section', { class: 'pane' });
  let justOpened = null; // only the part just expanded plays the unfold animation

  const addEpisode = async () => {
    const title = await dialogBox({ title: 'New episode', input: S.episodes.length ? `Episode ${S.episodes.length + 1}` : 'Pilot', okText: 'Add' });
    if (!title) return;
    const ep = newEpisode(title);
    S.episodes.push(ep);
    touch();
    pick(ep, ep.parts[0]);
  };

  function pick(ep, part) {
    closeEditors();
    ui.ep = ep?.id;
    ui.part = part?.id;
    drawTree();
    drawPane();
  }

  function drawTree() {
    const { ep: curEp, part: curPart } = currentEp();
    setTimeout(() => { justOpened = null; }, 300);
    tree.replaceChildren(...S.episodes.map((ep) => {
      const head = h('div', { class: `tree-ep ${ep === curEp ? 'on' : ''}`, onclick: () => pick(ep, ep.parts[0]) },
        h('button', { class: 'caret', type: 'button', title: ep.open ? 'Collapse' : 'Expand', onclick: (e) => { e.stopPropagation(); ep.open = !ep.open; touch(); drawTree(); } }, ep.open ? '▾' : '▸'),
        h('span', { class: 'grow ellipsis' }, ep.title || 'Untitled'),
        h('span', { class: 'badge' }, ep.status),
        h('button', { class: 'x', type: 'button', title: 'Delete episode', onclick: async (e) => {
          e.stopPropagation();
          if (!(await confirmDelete(ep.title))) return;
          S.episodes.splice(S.episodes.indexOf(ep), 1);
          touch();
          pick(S.episodes[0], S.episodes[0]?.parts[0]);
        } }, '×'));
      const partBox = (part, siblings, depth) => {
        const hasKids = part.children.length > 0;
        const row = h('div', { class: `tree-part ${part === curPart && ep === curEp ? 'on' : ''}`, style: `margin-left:${22 + depth * 16}px`, onclick: () => pick(ep, part) },
          h('button', { class: `caret ${hasKids ? '' : 'hide'}`, type: 'button', title: part.open ? 'Collapse' : 'Expand', onclick: (e) => { e.stopPropagation(); part.open = !part.open; justOpened = part.open ? part : null; touch(); drawTree(); } }, part.open ? '▾' : '▸'),
          h('span', { class: 'grow ellipsis' }, part.title || 'Untitled'),
          h('button', { class: 'x', type: 'button', title: 'Add a child under this', onclick: async (e) => {
            e.stopPropagation();
            const title = await dialogBox({ title: `Add under ${part.title}`, input: `Section ${part.children.length + 1}`, okText: 'Add' });
            if (!title) return;
            const child = newPart(title);
            part.children.push(child);
            part.open = true;
            justOpened = part;
            touch();
            pick(ep, child);
          } }, '+'),
          h('button', { class: 'x', type: 'button', title: 'Delete', onclick: async (e) => {
            e.stopPropagation();
            if (!(await confirmDelete(hasKids ? `${part.title} and everything under it` : part.title))) return;
            siblings.splice(siblings.indexOf(part), 1);
            touch();
            pick(ep, ep.parts[0]);
          } }, '×'));
        sortable(row, row, siblings, part, () => { commitEditors(); drawTree(); });
        const kids = part.open && hasKids && h('div', { class: part === justOpened ? 'kids-open' : '' }, part.children.map((c) => partBox(c, part.children, depth + 1)));
        return h('div', {}, row, kids);
      };
      const parts = ep.open ? ep.parts.map((part) => partBox(part, ep.parts, 0)) : [];
      const add = ep.open && h('button', { class: 'tree-add', type: 'button', onclick: async () => {
        const title = await dialogBox({ title: `New part in ${ep.title}`, input: `Part ${ep.parts.length + 1}`, okText: 'Add' });
        if (!title) return;
        const part = newPart(title);
        ep.parts.push(part);
        touch();
        pick(ep, part);
      } }, '+ Add part');
      const box = h('div', { class: 'tree-group' }, head, parts, add);
      sortable(head, box, S.episodes, ep, drawTree);
      return box;
    }));
  }

  function exportEpisode(ep) {
    commitEditors();
    const parts = flatParts(ep.parts).filter(({ part: p }) => countWords(p.html) || /<img/.test(p.html))
      .map(({ part: p, depth }) => (depth
        ? `<h3>${h('i', {}, p.title).innerHTML}</h3>${p.html}`
        : `<section class="part"><h2>${h('i', {}, p.title).innerHTML}</h2>${p.html}</section>`)).join('');
    api['pdf:export'](`<p class="sheet-title">${h('i', {}, ep.title).innerHTML}</p><p class="sheet-sub">${h('i', {}, S.show.title).innerHTML}${ep.logline ? ` - ${h('i', {}, ep.logline).innerHTML}` : ''}</p>${parts}`, `${S.show.title} - ${ep.title}`);
  }

  function drawPane() {
    const { ep, part } = currentEp();
    if (!ep) return pane.replaceChildren(h('div', { class: 'empty-state' }, h('h2', {}, 'No episodes yet'), btn('Add your pilot', addEpisode, 'primary')));
    if (!part) {
      return pane.replaceChildren(h('div', { class: 'empty-state' }, h('h2', {}, `${ep.title} has no parts`), h('p', {}, 'Use "+ Add part" in the list.')));
    }
    const count = h('span', { class: 'muted' });
    const updateCount = () => {
      commitEditors();
      const all = allParts(ep).reduce((n, p) => n + countWords(p.html), 0);
      count.textContent = `${countWords(part.html).toLocaleString()} words in this part | ${all.toLocaleString()} in episode | about ${Math.max(1, Math.round(all / 150))} min read aloud`;
    };
    const editor = makeEditor(part, 'html', { tall: true, onInput: updateCount, placeholder: 'Start writing. Pick a Script style from the toolbar for screenplay format; Tab switches the line type.' });
    pane.replaceChildren(
      h('div', { class: 'pane-head' },
        bind(ep, 'title', { class: 'ep-title', 'aria-label': 'Episode title', oninput: drawTree }),
        h('span', { class: 'slash' }, '/'),
        bind(part, 'title', { class: 'part-title', 'aria-label': 'Part title', oninput: drawTree }),
        h('div', { class: 'spring' }),
        select(EP_STATUS, ep.status, (v) => { ep.status = v; touch(); drawTree(); }, { 'aria-label': 'Episode status' }),
        btn('Export PDF', () => exportEpisode(ep))),
      bind(ep, 'logline', { class: 'ep-logline', placeholder: 'Episode logline', 'aria-label': 'Episode logline' }),
      editor,
      h('div', { class: 'pane-foot' }, count));
    updateCount();
  }

  root.append(h('aside', { class: 'side' }, h('div', { class: 'side-head' }, h('h2', {}, 'Episodes'), btn('+ Episode', addEpisode)), tree), pane);
  drawTree();
  drawPane();
};
