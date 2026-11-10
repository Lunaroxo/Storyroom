'use strict';
VIEW.production = (root) => {
  let draggedTask = null;
  const board = h('div', { class: 'kanban' });

  function moveTask(task, columnId, before) {
    task.column = columnId;
    S.tasks.splice(S.tasks.indexOf(task), 1);
    S.tasks.splice(before ? S.tasks.indexOf(before) : S.tasks.length, 0, task);
    touch();
    draw();
  }

  function card(task) {
    const el = h('article', { class: 'card',
      ondragover: (e) => { if (draggedTask) { e.preventDefault(); e.stopPropagation(); el.classList.add('drop'); } },
      ondragleave: () => el.classList.remove('drop'),
      ondrop: (e) => { if (draggedTask && draggedTask !== task) { e.preventDefault(); e.stopPropagation(); moveTask(draggedTask, task.column, task); } } },
    h('div', { class: 'row tight' },
      h('span', { class: 'grip', draggable: true, title: 'Drag to move', ondragstart: (e) => { draggedTask = task; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setDragImage(el, 10, 10); }, ondragend: () => { draggedTask = null; } }, '⠇'),
      bind(task, 'title', { class: 'grow card-title', placeholder: 'Task', 'aria-label': 'Task' }),
      h('button', { class: 'x show', type: 'button', title: 'Delete task', onclick: () => { S.tasks.splice(S.tasks.indexOf(task), 1); touch(); draw(); } }, '×')),
    h('div', { class: 'row tight' },
      select([['', 'Whole show'], ...S.episodes.map((e) => [e.id, e.title])], task.ep, (v) => { task.ep = v; touch(); }, { class: 'grow', 'aria-label': 'Episode' }),
      bind(task, 'due', { type: 'date', 'aria-label': 'Due date' })),
    bind(task, 'notes', { placeholder: 'Notes', rows: 1, 'aria-label': 'Notes' }, 'textarea'));
    return el;
  }

  function draw() {
    board.replaceChildren(...S.columns.map((col) => {
      const tasks = S.tasks.filter((t) => t.column === col.id);
      const grip = h('span', { class: 'grip', title: 'Drag to reorder column' }, '⠇');
      const el = h('section', { class: 'kan-col',
        ondragover: (e) => { if (draggedTask) e.preventDefault(); },
        ondrop: (e) => { if (draggedTask) { e.preventDefault(); moveTask(draggedTask, col.id); } } },
      h('div', { class: 'row tight kan-head' }, grip,
        bind(col, 'name', { class: 'grow kan-name', 'aria-label': 'Column name' }),
        h('span', { class: 'badge' }, String(tasks.length)),
        h('button', { class: 'x show', type: 'button', title: 'Delete column', onclick: async () => {
          if (tasks.length && !(await confirmDelete(`${col.name} and its ${tasks.length} tasks`))) return;
          S.tasks = S.tasks.filter((t) => t.column !== col.id);
          S.columns.splice(S.columns.indexOf(col), 1);
          touch(); draw();
        } }, '×')),
      h('div', { class: 'kan-cards' }, tasks.map(card)),
      h('button', { class: 'tree-add', type: 'button', onclick: () => { S.tasks.push({ id: uid(), title: '', column: col.id, ep: '', due: '', notes: '' }); touch(); draw(); } }, '+ Add task'));
      sortable(grip, el, S.columns, col, draw);
      return el;
    }));
  }

  root.append(h('section', { class: 'pane' },
    h('div', { class: 'pane-head' }, h('h2', {}, 'Production'), h('span', { class: 'muted' }, 'Track each job from idea to done'), h('div', { class: 'spring' }),
      btn('+ Column', () => { S.columns.push({ id: uid(), name: 'New column' }); touch(); draw(); })),
    h('div', { class: 'kan-scroll' }, board)));
  draw();
};
