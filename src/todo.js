'use strict';
VIEW.todo = (root) => {
  const list = h('div', { class: 'todo-list' });
  const left = h('span', { class: 'muted' });
  ui.todoFilter ||= 'open';
  const tabs = h('div', { class: 'row tight' });

  function add(field) {
    const text = field.value.trim();
    if (!text) return;
    S.todos.unshift({ id: uid(), text, done: false, ep: '' });
    field.value = '';
    touch();
    draw(true);
  }

  function row(item, isNew) {
    const el = h('div', { class: `todo-row ${item.done ? 'done' : ''} ${isNew ? 'fresh' : ''}` },
      h('span', { class: 'grip', title: 'Drag to reorder' }, '⠇'),
      h('input', { type: 'checkbox', checked: item.done, 'aria-label': 'Done', onchange: (e) => {
        item.done = e.target.checked;
        el.classList.toggle('done', item.done);
        touch();
        setTimeout(() => draw(), 350); // lets the check animation finish before the row leaves
      } }),
      bind(item, 'text', { class: 'grow todo-text wrap-box', rows: 1, 'aria-label': 'To do' }, 'textarea'),
      select([['', 'Whole show'], ...S.episodes.map((e) => [e.id, e.title])], item.ep, (v) => { item.ep = v; touch(); }, { 'aria-label': 'Episode' }),
      h('button', { class: 'x show', type: 'button', title: 'Delete', onclick: () => { S.todos.splice(S.todos.indexOf(item), 1); touch(); draw(); } }, '×'));
    sortable(el.firstChild, el, S.todos, item, draw);
    return el;
  }

  function draw(firstIsNew) {
    const n = S.todos.filter((t) => !t.done).length;
    left.textContent = `${n} left to do`;
    tabs.replaceChildren(...[['open', 'To do'], ['done', 'Done'], ['all', 'All']].map(([id, label]) => btn(label, () => { ui.todoFilter = id; draw(); }, ui.todoFilter === id ? 'on' : '')));
    const shown = S.todos.filter((t) => ui.todoFilter === 'all' || t.done === (ui.todoFilter === 'done'));
    list.replaceChildren(...(shown.length ? shown.map((t, i) => row(t, firstIsNew && i === 0)) : [h('div', { class: 'empty-state small' }, h('p', {}, ui.todoFilter === 'done' ? 'Nothing finished yet.' : 'All clear.'))]));
  }

  const field = h('input', { class: 'grow big', placeholder: 'Animate the treehouse scene...', 'aria-label': 'New to do', onkeydown: (e) => { if (e.key === 'Enter') add(field); } });
  root.append(h('section', { class: 'pane' }, h('div', { class: 'scroll' }, h('div', { class: 'column' },
    h('div', { class: 'row between' }, h('h1', { class: 'view-title' }, 'To Do'), left),
    h('div', { class: 'row todo-add' }, field, btn('Add', () => add(field), 'primary')),
    tabs,
    list))));
  draw();
  field.focus();
};
