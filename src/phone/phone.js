'use strict';
// Phone page served by the Storyroom PC: pick a part, tap a line, record a raw take, upload it to
// the PC's Voice Takes. Also reads the script and the character / world pages.
const state = { show: null, tab: 'record', part: localStorage.getItem('part') || '', line: null, takes: [], live: null, page: null };
const $ = (s) => document.querySelector(s);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v != null && v !== false) el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter((x) => x != null && x !== false));
  return el;
}

// Shows the show's own formatted text without anything that could run.
function safeHtml(html) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  doc.querySelectorAll('script, iframe, object, embed, style').forEach((x) => x.remove());
  doc.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes]) if (/^on/i.test(a.name) || /^javascript:/i.test(a.value)) el.removeAttribute(a.name);
    if (el.tagName === 'IMG' && /^images\//.test(el.getAttribute('src') || '')) el.setAttribute('src', `files/${el.getAttribute('src')}`);
    if (el.tagName === 'A') el.removeAttribute('href');
  });
  const box = h('div', { class: 'doc' });
  box.append(...doc.body.childNodes);
  return box;
}

const flat = (parts, depth = 0) => parts.flatMap((p) => [{ p, depth }, ...flat(p.children || [], depth + 1)]);
function currentPart() {
  const [epId, partId] = state.part.split('|');
  const ep = state.show?.episodes.find((e) => e.id === epId);
  const found = ep && flat(ep.parts).find((x) => x.p.id === partId);
  return found ? { ep, part: found.p } : null;
}

function partPicker() {
  const sel = h('select', { 'aria-label': 'Part', onchange: (e) => { state.part = e.target.value; localStorage.setItem('part', state.part); state.line = null; draw(); } },
    h('option', { value: '' }, 'Pick a part to read...'),
    state.show.episodes.map((e) => h('optgroup', { label: e.title }, flat(e.parts).map(({ p, depth }) => h('option', { value: `${e.id}|${p.id}` }, `${'  '.repeat(depth)}${p.title}`)))));
  sel.value = state.part;
  return sel;
}

async function load() {
  const res = await fetch('api/show', { cache: 'no-store' });
  if (!res.ok) throw new Error('The PC did not answer. Is the phone link still on?');
  state.show = await res.json();
  $('#showTitle').textContent = state.show.title;
}

function status(text, bad) {
  $('#status').textContent = text;
  $('#status').className = bad ? 'bad' : '';
}

// --- Recording ---------------------------------------------------------------------------------
async function toggleRecord() {
  if (state.live) {
    const live = state.live;
    state.live = null;
    clearInterval(state.timer);
    const take = await live.stop();
    const name = state.line ? takeName(state.line) : `Phone take ${state.takes.length + 1}`;
    state.takes.unshift({ ...take, name, line: state.line, url: URL.createObjectURL(new Blob([take.wav], { type: 'audio/wav' })), sent: false });
    draw();
    return;
  }
  try {
    state.live = await startRawRecording({ workletUrl: 'app/rec-worklet.js', bits: 24, onLevel: (p) => { state.level = Math.max(state.level || 0, p); } });
  } catch (err) {
    status(err.name === 'NotAllowedError' ? 'Allow the microphone for this page, then try again.' : `Microphone problem: ${err.message}`, true);
    return;
  }
  state.timer = setInterval(() => {
    const s = (Date.now() - state.live.started) / 1000;
    const t = $('#recTime');
    if (t) t.textContent = `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${Math.floor((s % 1) * 10)}`;
    const bar = $('#recLevel');
    if (bar) bar.style.width = `${Math.min(100, Math.sqrt(state.level || 0) * 100)}%`;
    state.level = (state.level || 0) * 0.8;
  }, 100);
  draw();
}

async function upload(take) {
  take.sent = 'sending';
  draw();
  try {
    const q = new URLSearchParams({ name: take.name, line: take.line?.key || '' });
    const res = await fetch(`api/take?${q}`, { method: 'POST', body: new Blob([take.wav], { type: 'audio/wav' }) });
    if (!res.ok) throw new Error(await res.text());
    take.sent = true;
    if (take.line) state.show.taken.push(take.line.key);
    status('Saved to Voice Takes on the PC');
  } catch (err) {
    take.sent = false;
    status(`Upload failed: ${err.message}`, true);
  }
  draw();
}

function recordView() {
  const found = currentPart();
  const lines = found ? scriptLines(found.part.html, found.part.id) : [];
  const done = (key) => state.show.taken.filter((k) => k === key).length;
  return h('div', { class: 'record' },
    partPicker(),
    h('div', { class: 'lines' }, lines.length ? lines.map((l) => h('button', {
      type: 'button', class: `line ${state.line?.key === l.key ? 'on' : ''} ${l.who ? 'dlg' : ''}`,
      onclick: () => { state.line = state.line?.key === l.key ? null : l; draw(); },
    }, l.who && h('span', { class: 'who' }, l.who), h('span', { class: 'text' }, l.text), done(l.key) > 0 && h('span', { class: 'done' }, `✓ ${done(l.key)}`)))
      : h('p', { class: 'muted' }, found ? 'This part has no lines yet.' : 'Pick a part, then tap the line you are recording.')),
    state.takes.length > 0 && h('div', { class: 'takes' }, h('h3', {}, 'Takes'), state.takes.map((t) => h('div', { class: 'take' },
      h('audio', { src: t.url, controls: '', preload: 'metadata' }),
      h('div', { class: 'take-name' }, t.name, h('small', {}, ` ${t.secs.toFixed(1)}s${t.peak >= 0.99 ? ' | too loud' : ''}`)),
      h('div', { class: 'take-actions' },
        t.sent === true ? h('span', { class: 'sent' }, 'Saved on PC') : h('button', { type: 'button', class: 'primary', disabled: t.sent === 'sending', onclick: () => upload(t) }, t.sent === 'sending' ? 'Uploading...' : 'Save to PC'),
        h('button', { type: 'button', onclick: () => { URL.revokeObjectURL(t.url); state.takes.splice(state.takes.indexOf(t), 1); draw(); } }, 'Delete'))))),
    // Stays on screen while scrolling the script.
    h('div', { class: 'deck' },
      h('div', { class: 'now' }, state.line ? [state.line.who && h('b', {}, `${state.line.who}: `), state.line.text] : h('span', { class: 'muted' }, 'No line picked')),
      h('div', { class: 'deck-row' },
        h('button', { type: 'button', class: `rec ${state.live ? 'on' : ''}`, onclick: toggleRecord }, state.live ? 'Stop' : 'Record'),
        h('div', { class: 'meter-box' }, h('div', { id: 'recTime' }, state.live ? '0:00.0' : 'Ready'), h('div', { class: 'meter' }, h('i', { id: 'recLevel' }))))));
}

function scriptView() {
  const found = currentPart();
  return h('div', { class: 'script' }, partPicker(), found ? safeHtml(found.part.html) : h('p', { class: 'muted' }, 'Pick a part to read it.'));
}

function pagesView() {
  if (state.page) {
    const p = state.page;
    return h('div', { class: 'page' },
      h('button', { type: 'button', class: 'back', onclick: () => { state.page = null; draw(); } }, '← All pages'),
      p.image && h('img', { class: 'portrait', src: `files/${p.image}`, alt: '' }),
      h('h2', {}, p.name),
      h('dl', {}, (p.fields || []).filter((f) => f.v).map((f) => [h('dt', {}, f.k), h('dd', {}, f.v)])),
      safeHtml(p.html));
  }
  const group = (title, pages) => pages.length > 0 && [h('h3', {}, title), pages.map((p) => h('button', { type: 'button', class: 'page-link', onclick: () => { state.page = p; draw(); } }, p.parent ? `↳ ${p.name}` : p.name))];
  return h('div', { class: 'pages' },
    group('Characters', state.show.pages.filter((p) => p.kind === 'character')),
    group('World', state.show.pages.filter((p) => p.kind !== 'character')),
    !state.show.pages.length && h('p', { class: 'muted' }, 'No pages yet.'));
}

function draw() {
  const scroll = $('#view').scrollTop;
  $('#view').replaceChildren(state.tab === 'record' ? recordView() : state.tab === 'script' ? scriptView() : pagesView());
  $('#view').scrollTop = scroll;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
}

document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', async () => {
  state.tab = b.dataset.tab;
  if (!state.live) await load().catch((e) => status(e.message, true)); // fresh script each time you switch
  draw();
}));

load().then(draw).catch((e) => { status(e.message, true); $('#view').replaceChildren(h('p', { class: 'muted pad' }, e.message)); });
