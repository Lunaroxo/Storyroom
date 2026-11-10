'use strict';
const SHOTS = ['Wide', 'Full', 'Medium', 'Close-up', 'Extreme close-up', 'Over the shoulder', 'POV', 'Two shot', 'Establishing', 'Bird\'s eye', 'Low angle', 'High angle', 'Dutch angle'];
const MOVES = ['Static', 'Pan', 'Tilt', 'Zoom in', 'Zoom out', 'Truck', 'Dolly', 'Crane', 'Shake', 'Follow', 'Whip pan', 'Rack focus'];
const newPanel = (part) => ({ id: uid(), part: part || '', image: '', v: 0, shot: 'Medium', move: 'Static', secs: 3, action: '', dialogue: '', sound: '' });

VIEW.storyboard = (root) => {
  const eps = h('div', { class: 'side-body' });
  const pane = h('section', { class: 'pane' });
  const ep = () => S.episodes.find((e) => e.id === ui.boardEp) || S.episodes[0];

  function drawEps() {
    eps.replaceChildren(...S.episodes.map((e) => h('div', { class: `tree-ep ${e === ep() ? 'on' : ''}`, onclick: () => { ui.boardEp = e.id; ui.boardPart = ''; drawEps(); drawBoard(); } },
      h('span', { class: 'grow ellipsis' }, e.title), h('span', { class: 'badge' }, String(e.panels.length)))));
  }

  function exportBoard(e) {
    const sheet = h('div', {}, h('p', { class: 'sheet-title' }, `${e.title} storyboard`), h('p', { class: 'sheet-sub' }, S.show.title),
      h('div', { class: 'panels' }, e.panels.map((p, i) => h('div', { class: 'panel' },
        p.image ? h('img', { src: url(p.image) }) : h('div', { class: 'blank' }),
        h('p', {}, h('b', {}, `${i + 1}`), ` ${p.shot}, ${p.move}, ${p.secs}s`),
        p.action && h('p', {}, p.action), p.dialogue && h('p', {}, h('i', {}, p.dialogue)), p.sound && h('p', {}, `Sound: ${p.sound}`)))));
    api['pdf:export'](sheet.outerHTML, `${S.show.title} - ${e.title} storyboard`);
  }

  function drawBoard() {
    const e = ep();
    if (!e) return pane.replaceChildren(h('div', { class: 'empty-state' }, h('h2', {}, 'Add an episode in Writing first')));
    const total = e.panels.reduce((n, p) => n + (+p.secs || 0), 0);
    const add = () => { e.panels.push(newPanel(ui.boardPart)); touch(); drawEps(); drawBoard(); };
    const shown = e.panels.filter((p) => !ui.boardPart || p.part === ui.boardPart);
    pane.replaceChildren(
      h('div', { class: 'pane-head' },
        h('h2', {}, e.title),
        select([['', 'All parts'], ...partOptions(e)], ui.boardPart || '', (v) => { ui.boardPart = v; drawBoard(); }, { 'aria-label': 'Filter by part' }),
        h('span', { class: 'muted' }, `${e.panels.length} panels | ${clock(total)} planned`),
        h('div', { class: 'spring' }),
        btn('Export PDF', () => exportBoard(e)),
        btn('+ Panel', add, 'primary')),
      h('div', { class: 'scroll' }, shown.length
        ? h('div', { class: 'panel-grid' }, shown.map((p) => panelCard(e, p)))
        : h('div', { class: 'empty-state' }, h('h2', {}, 'No panels here yet'), btn('Add the first panel', add, 'primary'))));
  }

  function panelCard(e, p) {
    const n = e.panels.indexOf(p) + 1;
    const f = (label, control) => h('label', { class: 'mini' }, h('span', {}, label), control);
    const grip = h('div', { class: 'panel-num', title: 'Drag to reorder' }, `${n}`);
    const card = h('article', { class: 'panel-card' },
      h('div', { class: 'panel-top' }, grip,
        select([['', 'No part'], ...partOptions(e)], p.part, (v) => { p.part = v; touch(); }, { class: 'part-pick', 'aria-label': 'Part' }),
        h('div', { class: 'spring' }),
        h('button', { class: 'x show', type: 'button', title: 'Insert panel after', onclick: () => { e.panels.splice(n, 0, newPanel(p.part)); touch(); drawEps(); drawBoard(); } }, '+'),
        h('button', { class: 'x show', type: 'button', title: 'Duplicate', onclick: async () => {
          const copy = { ...p, id: uid() };
          if (p.image) { copy.image = `images/panel-${copy.id}.png`; await api['image:write'](copy.image, await api['image:read'](p.image)); }
          e.panels.splice(n, 0, copy); touch(); drawEps(); drawBoard();
        } }, '⧉'),
        h('button', { class: 'x show', type: 'button', title: 'Delete panel', onclick: async () => {
          if (await confirmDelete(`Panel ${n}`)) { e.panels.splice(e.panels.indexOf(p), 1); touch(); drawEps(); drawBoard(); }
        } }, '×')),
      h('button', { class: 'panel-art', type: 'button', title: 'Draw', onclick: () => openDraw(e, p, drawBoard) },
        p.image ? h('img', { src: `${url(p.image)}?v=${p.v}`, alt: `Panel ${n} drawing` }) : h('span', {}, 'Click to draw')),
      h('div', { class: 'mini-row' },
        f('Shot', select(SHOTS, p.shot, (v) => { p.shot = v; touch(); })),
        f('Camera', select(MOVES, p.move, (v) => { p.move = v; touch(); })),
        f('Sec', bind(p, 'secs', { type: 'number', min: 0, step: 0.5, class: 'secs' }))),
      bind(p, 'action', { placeholder: 'Action', rows: 2, 'aria-label': 'Action' }, 'textarea'),
      bind(p, 'dialogue', { placeholder: 'Dialogue', rows: 2, 'aria-label': 'Dialogue' }, 'textarea'),
      h('div', { class: 'row tight' },
        bind(p, 'sound', { list: 'libTitles', placeholder: 'Sound or music from library', class: 'grow', 'aria-label': 'Sound or music' }),
        h('button', { class: 'x show', type: 'button', title: 'Play', onclick: () => { const item = S.library.items.find((i) => i.title === p.sound); item ? playItem(item) : toast('That title is not in the library'); } }, '▶')));
    sortable(grip, card, e.panels, p, drawBoard);
    return card;
  }

  refreshLibTitles();
  root.append(h('aside', { class: 'side' }, h('div', { class: 'side-head' }, h('h2', {}, 'Episodes')), eps), pane);
  drawEps();
  drawBoard();
};

// --- Drawing window ----------------------------------------------------------------------------
async function openDraw(ep, panel, onClose) {
  const W = 1280;
  const H = 720;
  const cv = h('canvas', { width: W, height: H, class: 'draw-canvas' });
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.lineCap = ctx.lineJoin = 'round';
  const undo = [];
  const redo = [];
  const snap = () => ctx.getImageData(0, 0, W, H);
  const checkpoint = () => { undo.push(snap()); if (undo.length > 30) undo.shift(); redo.length = 0; };
  const swap = (from, to) => { if (from.length) { to.push(snap()); ctx.putImageData(from.pop(), 0, 0); } };

  const loadInto = (src) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
  if (panel.image) ctx.drawImage(await loadInto(await api['image:read'](panel.image)), 0, 0, W, H);

  let tool = 'pen';
  let color = '#1d1c1a';
  let size = 5;
  const tools = [['pen', 'Pen'], ['eraser', 'Eraser'], ['line', 'Line'], ['rect', 'Box'], ['ellipse', 'Circle'], ['fill', 'Fill']];
  const toolBtns = tools.map(([id, label]) => h('button', { class: `btn ${id === tool ? 'on' : ''}`, type: 'button', onclick: (e) => { tool = id; toolBtns.forEach((b) => b.classList.remove('on')); e.target.classList.add('on'); } }, label));

  function floodFill(x0, y0) {
    const image = snap();
    const d = image.data;
    const idx = (x, y) => (y * W + x) * 4;
    const start = idx(x0, y0);
    const target = [d[start], d[start + 1], d[start + 2], d[start + 3]];
    const c = [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16), 255];
    if (target.every((v, i) => v === c[i])) return;
    const near = (i) => Math.abs(d[i + 3] - target[3]) < 90 && (target[3] < 20 || (Math.abs(d[i] - target[0]) < 60 && Math.abs(d[i + 1] - target[1]) < 60 && Math.abs(d[i + 2] - target[2]) < 60));
    const stack = [[x0, y0]];
    while (stack.length) {
      const [x, y] = stack.pop();
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = idx(x, y);
      if (d[i + 3] === 255 && d[i] === c[0] && d[i + 1] === c[1] && d[i + 2] === c[2]) continue;
      if (!near(i)) continue;
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    ctx.putImageData(image, 0, 0);
  }

  const pos = (e) => {
    const r = cv.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * H) / r.height, p: e.pointerType === 'pen' ? e.pressure : 0.5 };
  };
  let start = null;
  let last = null;
  let base = null;

  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    start = last = pos(e);
    checkpoint();
    if (tool === 'fill') { floodFill(Math.floor(start.x), Math.floor(start.y)); start = null; return; }
    base = snap();
    ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    // A dot, so a single click leaves a mark.
    if (tool === 'pen' || tool === 'eraser') { ctx.beginPath(); ctx.arc(start.x, start.y, size / 2, 0, 7); ctx.fill(); }
  });

  cv.addEventListener('pointermove', (e) => {
    if (!start) return;
    if (tool === 'pen' || tool === 'eraser') {
      for (const ev of e.getCoalescedEvents?.() ?? [e]) {
        const p = pos(ev);
        ctx.lineWidth = tool === 'pen' ? size * (0.4 + p.p * 1.2) : size * 3;
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        last = p;
      }
      return;
    }
    const p = pos(e);
    ctx.putImageData(base, 0, 0);
    ctx.lineWidth = size;
    ctx.beginPath();
    if (tool === 'line') { ctx.moveTo(start.x, start.y); ctx.lineTo(p.x, p.y); }
    if (tool === 'rect') ctx.rect(start.x, start.y, p.x - start.x, p.y - start.y);
    if (tool === 'ellipse') ctx.ellipse((start.x + p.x) / 2, (start.y + p.y) / 2, Math.abs(p.x - start.x) / 2, Math.abs(p.y - start.y) / 2, 0, 0, 7);
    ctx.stroke();
  });

  const finish = () => { start = null; ctx.globalCompositeOperation = 'source-over'; };
  cv.addEventListener('pointerup', finish);
  cv.addEventListener('pointercancel', finish);

  const onKey = (e) => {
    if (!e.ctrlKey) return;
    if (e.key === 'z') { e.preventDefault(); swap(undo, redo); }
    if (e.key === 'y') { e.preventDefault(); swap(redo, undo); }
  };
  addEventListener('keydown', onKey);

  async function save() {
    panel.image = `images/panel-${panel.id}.png`;
    await api['image:write'](panel.image, cv.toDataURL('image/png'));
    panel.v = Date.now();
    touch();
  }
  const close = () => { removeEventListener('keydown', onKey); overlay.remove(); onClose(); };
  const stepTo = async (delta) => {
    await save();
    const next = ep.panels[ep.panels.indexOf(panel) + delta];
    removeEventListener('keydown', onKey);
    overlay.remove();
    next ? openDraw(ep, next, onClose) : onClose();
  };

  const index = ep.panels.indexOf(panel);
  const prev = ep.panels[index - 1];
  const onion = prev?.image ? h('img', { class: 'onion off', src: `${url(prev.image)}?v=${prev.v}`, alt: '' }) : null;
  const overlay = h('div', { class: 'overlay draw', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Draw panel ${index + 1}` },
    h('div', { class: 'draw-bar' },
      h('b', {}, `Panel ${index + 1}`), toolBtns,
      h('label', { class: 'row tight' }, 'Color', h('input', { type: 'color', value: color, oninput: (e) => { color = e.target.value; } })),
      h('label', { class: 'row tight' }, 'Size', h('input', { type: 'range', min: 1, max: 80, value: size, oninput: (e) => { size = +e.target.value; } })),
      btn('Undo', () => swap(undo, redo)), btn('Redo', () => swap(redo, undo)),
      btn('Clear', () => { checkpoint(); ctx.clearRect(0, 0, W, H); }),
      btn('Import image', async () => {
        const data = await api['image:pick'](true);
        if (!data) return;
        const img = await loadInto(data);
        const k = Math.min(W / img.width, H / img.height);
        checkpoint();
        ctx.drawImage(img, (W - img.width * k) / 2, (H - img.height * k) / 2, img.width * k, img.height * k);
      }),
      onion && btn('Onion skin', (e) => { e.target.classList.toggle('on'); onion.classList.toggle('off'); }),
      h('div', { class: 'spring' }),
      prev && btn('Save + previous', () => stepTo(-1)),
      btn('Save + next', () => stepTo(1)),
      btn('Cancel', close),
      btn('Save', async () => { await save(); close(); }, 'primary')),
    h('div', { class: 'draw-stage' }, h('div', { class: 'draw-frame' }, onion, cv)));
  document.body.append(overlay);
}
