'use strict';
const audio = new Audio();
const fetchedSounds = new Set(); // guest: sounds already asked from the host
let nowPlaying = null;

function refreshLibTitles() {
  $('#libTitles').replaceChildren(...[...new Set(S.library.items.map((i) => i.title))].map((t) => h('option', { value: t })));
}

// Learns each new file's length, one at a time so a big import does not open hundreds of decoders.
async function probe(items) {
  for (const item of items) {
    const duration = await new Promise((resolve) => {
      const a = new Audio();
      a.preload = 'metadata';
      a.onloadedmetadata = () => resolve(a.duration);
      a.onerror = () => resolve(0);
      a.src = url(item.file);
    });
    if (Number.isFinite(duration) && duration) item.duration = duration;
    item.kind ||= item.duration > 45 ? 'music' : 'sound';
  }
  touch();
  if (ui.view === 'library') go('library');
}

function addToLibrary(infos, extra = {}) {
  const items = infos.map((info) => ({
    id: uid(), title: info.title, artist: info.artist || '', file: info.file, kind: extra.kind || null, folder: extra.folder || '', tags: [],
    duration: info.duration || 0, source: info.source || '', sourceUrl: info.sourceUrl || '', license: info.license || '', notes: '', fav: false, addedAt: Date.now(), line: info.line || '',
  }));
  S.library.items.push(...items);
  touch();
  probe(items);
  return items;
}

function buildPlayer() {
  const play = h('button', { class: 'play', type: 'button', title: 'Play or pause', 'aria-label': 'Play or pause', onclick: () => { if (nowPlaying) audio.paused ? audio.play() : audio.pause(); } }, '▶');
  const title = h('div', { class: 'ellipsis pl-title' }, 'Nothing playing');
  const seek = h('input', { type: 'range', min: 0, max: 1000, value: 0, class: 'grow', 'aria-label': 'Seek', oninput: (e) => { if (audio.duration) audio.currentTime = (e.target.value / 1000) * audio.duration; } });
  const time = h('span', { class: 'muted pl-time' }, '0:00 / 0:00');
  const loop = h('button', { class: 'btn', type: 'button', title: 'Repeat', onclick: (e) => { audio.loop = !audio.loop; e.target.classList.toggle('on', audio.loop); } }, 'Repeat');
  const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0.8, class: 'pl-vol', 'aria-label': 'Volume', oninput: (e) => { audio.volume = e.target.value; } });
  audio.volume = 0.8;
  audio.addEventListener('play', () => { play.textContent = '❚❚'; });
  audio.addEventListener('pause', () => { play.textContent = '▶'; });
  audio.addEventListener('timeupdate', () => {
    if (audio.duration) seek.value = (audio.currentTime / audio.duration) * 1000;
    time.textContent = `${clock(audio.currentTime)} / ${clock(audio.duration)}`;
  });
  audio.addEventListener('error', () => {
    // A guest's sounds live on the host: fetch once, then play.
    if (collab.role === 'guest' && nowPlaying?.id && !fetchedSounds.has(nowPlaying.file)) {
      const item = nowPlaying;
      fetchedSounds.add(item.file);
      toast('Getting this sound from the host...');
      requestFile(item.file).then(() => playItem(item));
      return;
    }
    if (nowPlaying) toast(nowPlaying.id ? `Cannot preview this file type: ${nowPlaying.file.split('.').pop()}. It is still in your library.` : 'This site will not play a preview here. You can still try Add.', true); });
  buildPlayer.show = (t) => { title.textContent = t; };
  $('#player').append(play, title, seek, time, loop, h('span', { class: 'muted' }, 'Vol'), vol);
}

function playRemote(link, label) {
  nowPlaying = { file: link };
  audio.src = link;
  audio.play().catch(() => {});
  buildPlayer.show(label);
}

function playItem(item) {
  nowPlaying = item;
  audio.src = url(item.file);
  audio.play().catch(() => {});
  buildPlayer.show([item.title, item.artist].filter(Boolean).join(' - '));
  document.querySelectorAll('.lib-row.playing').forEach((r) => r.classList.remove('playing'));
  document.querySelector(`.lib-row[data-id="${item.id}"]`)?.classList.add('playing');
}

VIEW.library = (root) => {
  const L = S.library;
  ui.lib ||= { scope: 'all', search: '', sort: 'addedAt', dir: -1, picked: new Set() };
  const lib = ui.lib;
  const side = h('div', { class: 'side-body' });
  const table = h('div', { class: 'lib-table' });
  const detail = h('aside', { class: 'lib-detail' });
  const count = h('span', { class: 'muted' });

  // Where each recorded line sits in the script: episode order, then parts top to bottom, then line.
  const script = new Map();
  let order = 0;
  for (const e of S.episodes) {
    for (const p of allParts(e)) {
      scriptLines(p.html, p.id).forEach((l, i) => { if (!script.has(l.key)) script.set(l.key, { n: order++, label: `${e.title} / ${p.title} · line ${i + 1}` }); });
    }
  }
  const lineOf = (i) => (i.line ? script.get(i.line) : null);

  const visible = () => {
    const q = lib.search.toLowerCase();
    const inScope = (i) => (lib.scope === 'all' ? true : lib.scope === 'fav' ? i.fav : lib.scope === 'music' || lib.scope === 'sound' ? i.kind === lib.scope : i.folder === lib.scope);
    const text = (i) => [i.title, i.artist, i.source, i.license, i.notes, ...i.tags].join(' ').toLowerCase();
    const value = (i) => (lib.sort === 'line' ? lineOf(i)?.n ?? null : Array.isArray(i[lib.sort]) ? i[lib.sort].join() : i[lib.sort] ?? '');
    return L.items.filter((i) => inScope(i) && text(i).includes(q)).sort((a, b) => {
      const [x, y] = [value(a), value(b)];
      if (x === null || y === null) return (x === null) - (y === null) || (b.addedAt || 0) - (a.addedAt || 0); // takes without a line go last
      const diff = lib.dir * (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true }));
      return diff || (a.addedAt || 0) - (b.addedAt || 0); // several takes of one line: oldest first
    });
  };
  const added = (t) => (t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

  function redraw() { drawSide(); drawTable(); drawDetail(); }

  async function importPaths(paths) {
    if (!paths.length) return;
    const added = await api['lib:import'](paths);
    if (!added.length) return toast('No audio files found there', true);
    const scope = lib.scope;
    addToLibrary(added, { kind: scope === 'music' || scope === 'sound' ? scope : null, folder: L.folders.includes(scope) ? scope : '' });
    toast(`Added ${added.length} file${added.length > 1 ? 's' : ''}`);
    redraw();
  }

  async function deletePicked() {
    const items = L.items.filter((i) => lib.picked.has(i.id));
    if (!items.length) return toast('Select a file first');
    const ok = await dialogBox({ title: `Delete ${items.length} file${items.length > 1 ? 's' : ''}?`, text: 'Files go to the Recycle Bin.', okText: 'Delete', danger: true });
    if (!ok) return;
    await api['lib:trash'](items.map((i) => i.file));
    L.items = L.items.filter((i) => !lib.picked.has(i.id));
    lib.picked.clear();
    touch();
    refreshLibTitles();
    redraw();
  }

  function dropTarget(el, fn) {
    el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('storyroom/items')) { e.preventDefault(); el.classList.add('drop'); } });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', (e) => {
      if (!e.dataTransfer.types.includes('storyroom/items')) return;
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('drop');
      L.items.filter((i) => lib.picked.has(i.id)).forEach(fn);
      touch();
      redraw();
    });
    return el;
  }

  function drawSide() {
    const row = (scope, label, n, apply, extra) => {
      const el = h('div', { class: `lib-scope ${lib.scope === scope ? 'on' : ''}`, onclick: () => { lib.scope = scope; lib.picked.clear(); redraw(); } }, h('span', { class: 'grow ellipsis' }, label), extra, h('span', { class: 'badge' }, String(n)));
      return apply ? dropTarget(el, apply) : el;
    };
    const count_ = (fn) => L.items.filter(fn).length;
    side.replaceChildren(
      row('all', 'All files', L.items.length),
      row('fav', 'Favorites', count_((i) => i.fav), (i) => { i.fav = true; }),
      row('music', 'Music', count_((i) => i.kind === 'music'), (i) => { i.kind = 'music'; }),
      row('sound', 'Sounds', count_((i) => i.kind === 'sound'), (i) => { i.kind = 'sound'; }),
      h('div', { class: 'side-label' }, 'Folders'),
      ...L.folders.map((f) => row(f, f, count_((i) => i.folder === f), (i) => { i.folder = f; }, [
        h('button', { class: 'x', type: 'button', title: 'Rename folder', onclick: async (e) => {
          e.stopPropagation();
          const name = await dialogBox({ title: 'Rename folder', input: f, okText: 'Rename' });
          if (!name || L.folders.includes(name)) return;
          L.folders[L.folders.indexOf(f)] = name;
          L.items.forEach((i) => { if (i.folder === f) i.folder = name; });
          if (lib.scope === f) lib.scope = name;
          touch(); redraw();
        } }, '✎'),
        h('button', { class: 'x', type: 'button', title: 'Delete folder, keep files', onclick: async (e) => {
          e.stopPropagation();
          if (!(await dialogBox({ title: `Delete folder "${f}"?`, text: 'Files stay in your library.', okText: 'Delete folder', danger: true }))) return;
          L.folders.splice(L.folders.indexOf(f), 1);
          L.items.forEach((i) => { if (i.folder === f) i.folder = ''; });
          if (lib.scope === f) lib.scope = 'all';
          touch(); redraw();
        } }, '×')])),
      h('button', { class: 'tree-add', type: 'button', onclick: async () => {
        const name = await dialogBox({ title: 'New folder', input: '', okText: 'Create' });
        if (name && !['all', 'fav', 'music', 'sound'].includes(name) && !L.folders.includes(name)) { L.folders.push(name); touch(); redraw(); }
      } }, '+ New folder'));
  }

  function drawTable() {
    const items = visible();
    count.textContent = `${items.length} shown`;
    const col = (key, label, cls = '') => h('button', { type: 'button', class: `th ${cls} ${lib.sort === key ? 'sorted' : ''}`, onclick: () => { lib.dir = lib.sort === key ? -lib.dir : 1; lib.sort = key; drawTable(); } }, label + (lib.sort === key ? (lib.dir > 0 ? ' ↑' : ' ↓') : ''));
    const head = h('div', { class: 'lib-row head' }, h('span', {}), h('span', {}), col('title', 'Title'), col('line', 'Line in script'), col('artist', 'Artist'), col('kind', 'Type'), col('folder', 'Folder'), col('tags', 'Tags'), col('duration', 'Length'), col('addedAt', 'Added'), col('source', 'Source'));
    let anchor = null;
    const rows = items.map((item, index) => {
      const row = h('div', { class: `lib-row ${lib.picked.has(item.id) ? 'picked' : ''} ${nowPlaying === item ? 'playing' : ''}`, 'data-id': item.id, draggable: true,
        ondblclick: () => playItem(item),
        onclick: (e) => {
          if (e.shiftKey && anchor != null) items.slice(Math.min(anchor, index), Math.max(anchor, index) + 1).forEach((i) => lib.picked.add(i.id));
          else if (e.ctrlKey) lib.picked.has(item.id) ? lib.picked.delete(item.id) : lib.picked.add(item.id);
          else { lib.picked.clear(); lib.picked.add(item.id); }
          anchor = index;
          document.querySelectorAll('.lib-row[data-id]').forEach((r) => r.classList.toggle('picked', lib.picked.has(r.dataset.id)));
          drawDetail();
        },
        ondragstart: (e) => {
          if (!lib.picked.has(item.id)) { lib.picked.clear(); lib.picked.add(item.id); }
          e.dataTransfer.setData('storyroom/items', '1');
          e.dataTransfer.effectAllowed = 'move';
        } },
      h('button', { class: 'row-play', type: 'button', title: 'Play', 'aria-label': `Play ${item.title}`, onclick: (e) => { e.stopPropagation(); playItem(item); } }, '▶'),
      h('button', { class: `star ${item.fav ? 'on' : ''}`, type: 'button', title: 'Favorite', 'aria-label': 'Favorite', onclick: (e) => { e.stopPropagation(); item.fav = !item.fav; touch(); e.target.classList.toggle('on', item.fav); drawSide(); } }, '★'),
      h('span', { class: 'ellipsis strong' }, item.title), h('span', { class: 'ellipsis muted', title: lineOf(item)?.label || '' }, lineOf(item)?.label || ''), h('span', { class: 'ellipsis' }, item.artist), h('span', {}, item.kind === 'music' ? 'Music' : item.kind === 'sound' ? 'Sound' : ''),
      h('span', { class: 'ellipsis' }, item.folder), h('span', { class: 'ellipsis' }, item.tags.join(', ')), h('span', {}, clock(item.duration)), h('span', { class: 'ellipsis muted' }, added(item.addedAt)), h('span', { class: 'ellipsis' }, item.source));
      return row;
    });
    table.replaceChildren(head, ...(items.length ? rows : [h('div', { class: 'empty-state small' }, h('p', {}, L.items.length ? 'Nothing matches.' : 'Drop audio files here, or use Find Sounds to get some.'))]));
  }

  function drawDetail() {
    const picked = L.items.filter((i) => lib.picked.has(i.id));
    if (picked.length !== 1) return detail.replaceChildren(h('p', { class: 'muted pad' }, picked.length > 1 ? `${picked.length} files selected. Drag them onto a folder, or Delete.` : 'Select a file to edit its details.'));
    const item = picked[0];
    const field = (label, control) => h('label', { class: 'field' }, h('span', {}, label), control);
    const refresh = () => drawTable();
    detail.replaceChildren(h('div', { class: 'pad' },
      field('Title', bind(item, 'title', { oninput: () => { refresh(); refreshLibTitles(); } })),
      field('Artist', bind(item, 'artist', { oninput: refresh })),
      field('Type', select([['music', 'Music'], ['sound', 'Sound']], item.kind || 'sound', (v) => { item.kind = v; touch(); redraw(); })),
      field('Folder', select([['', 'None'], ...L.folders.map((f) => [f, f])], item.folder, (v) => { item.folder = v; touch(); redraw(); })),
      field('Tags (comma separated)', h('input', { value: item.tags.join(', '), oninput: (e) => { item.tags = e.target.value.split(',').map((t) => t.trim()).filter(Boolean); touch(); refresh(); } })),
      field('License or credit', bind(item, 'license', { placeholder: 'e.g. CC0, Pixabay License' })),
      field('Notes', bind(item, 'notes', { rows: 4, placeholder: 'Mood, where to use it...' }, 'textarea')),
      item.sourceUrl && h('button', { class: 'link', type: 'button', onclick: () => api['web:external'](item.sourceUrl) }, `Open source page: ${item.source}`),
      h('button', { class: 'link', type: 'button', onclick: () => api['lib:reveal'](item.file) }, 'Show file on PC')));
  }

  const body = h('section', { class: 'pane',
    ondragover: (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); },
    ondrop: (e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); importPaths([...e.dataTransfer.files].map((f) => api.pathOf(f))); } },
  h('div', { class: 'pane-head' },
    h('input', { class: 'grow', placeholder: 'Search titles, artists, tags, license...', value: lib.search, 'aria-label': 'Search library', oninput: (e) => { lib.search = e.target.value; drawTable(); } }),
    count,
    btn('Import files', async () => importPaths(await api['lib:pick'](false)), 'primary'),
    btn('Import folder', async () => importPaths(await api['lib:pick'](true))),
    btn('Find sounds', () => go('find')),
    btn('Delete', deletePicked, 'danger-text')),
  h('div', { class: 'lib-body' }, h('div', { class: 'lib-scroll' }, table), detail));

  root.append(h('aside', { class: 'side' }, h('div', { class: 'side-head' }, h('h2', {}, 'Library')), side), body);
  redraw();
};
