'use strict';
// Recording: raw mic takes (24-bit WAV) next to the script. Click a line and takes are named after it;
// Save drops them straight into the Voice Takes folder. A guest's takes go to the host's library.
const WORKLET_URL = new URL('rec-worklet.js', document.currentScript.src).href;
const rec = { takes: [], live: null, count: 0, part: '', line: null, ask: null }; // microphone choice lives in settings.micDevice

const takesFor = (key) => S.library.items.filter((i) => i.line === key).length;

// Unsaved takes are also kept on disk until saved, sent or deleted (see takes:keep in main.js).
const takeMeta = (t) => ({ id: t.id, name: t.name, line: t.line, secs: t.secs, peak: t.peak, rate: t.rate, channels: t.channels });
const forgetTake = (t) => api['takes:drop'](t.id);
async function restoreTakes() {
  try { rec.ask = JSON.parse(localStorage.getItem('recAsk') || 'null'); } catch { rec.ask = null; }
  const kept = await api['takes:all']();
  for (const { meta, wav } of kept) {
    const buf = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);
    rec.takes.push({ ...meta, wav: buf, url: URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })), saved: false });
  }
  rec.count = rec.takes.length;
  if (kept.length) toast(`${kept.length} unsaved take${kept.length > 1 ? 's were' : ' was'} kept from last time. They are in Recording.`);
}
const setAsk = (ask) => {
  rec.ask = ask;
  try { ask ? localStorage.setItem('recAsk', JSON.stringify(ask)) : localStorage.removeItem('recAsk'); } catch { /* only for this run */ }
};

function saveTakeDialog(take) {
  return new Promise((resolve) => {
    const L = S.library;
    const name = h('input', { value: take.name, class: 'wide', 'aria-label': 'Take name' });
    const NEW = '\u0000new';
    const want = settings.recFolder || 'Voice Takes';
    const folder = select([...L.folders.map((f) => [f, f]), ['', 'No folder'], [NEW, '+ New folder...']], L.folders.includes(want) ? want : (L.folders[0] || ''), () => { newName.classList.toggle('off', folder.value !== NEW); }, { 'aria-label': 'Folder', class: 'wide' });
    const newName = h('input', { class: 'wide off', placeholder: 'Folder name', value: want, 'aria-label': 'New folder name' });
    const close = (v) => { overlay.remove(); resolve(v); };
    const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true' },
      h('form', { class: 'dialog', onsubmit: (e) => { e.preventDefault(); close({ name: name.value.trim() || take.name, folder: folder.value === NEW ? newName.value.trim() : folder.value }); }, onkeydown: (e) => { if (e.key === 'Escape') close(null); } },
        h('h3', {}, 'Save take to library'),
        h('label', { class: 'field' }, h('span', {}, 'Name'), name),
        h('label', { class: 'field' }, h('span', {}, 'Folder'), folder, newName),
        h('div', { class: 'row end' }, h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, 'Cancel'), h('button', { type: 'submit', class: 'btn primary' }, 'Save'))));
    if (!L.folders.includes(want)) { folder.value = NEW; newName.classList.remove('off'); }
    document.body.append(overlay);
    name.select();
  });
}

// Saves a take to this show's library, or sends it to the host when visiting someone's show.
async function keepTake(take, name, folder) {
  if (collab.role === 'guest') {
    if (!collab.host) return toast('Reconnecting to the host. Send it again in a moment; the take is kept.', true);
    take.saved = 'sending';
    collab.host.send({ t: 'take', id: take.id, name, line: take.line?.key || '', data: take.wav });
    return;
  }
  if (folder && !S.library.folders.includes(folder)) S.library.folders.push(folder);
  const info = await api['lib:saveAudio'](name, take.wav);
  addToLibrary([{ ...info, source: 'Recorded', line: take.line?.key || '' }], { kind: 'sound', folder });
  refreshLibTitles();
  take.saved = true;
  forgetTake(take);
  toast(`Saved "${name}" to ${folder || 'Library'}`);
}

VIEW.record = (root) => {
  const meter = h('div', { class: 'rec-meter' }, h('i', {}));
  const time = h('div', { class: 'rec-time' }, '0:00.0');
  const devices = h('span', {});
  const list = h('div', { class: 'take-list' });
  const now = h('div', { class: 'rec-now' });
  const script = h('div', { class: 'script-lines' });
  const scriptHead = h('div', { class: 'script-head' });
  let raf = 0;
  let level = 0;

  async function drawDevices() {
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    devices.replaceChildren(select([['', 'Default microphone'], ...inputs.filter((d) => d.deviceId && d.deviceId !== 'default').map((d) => [d.deviceId, d.label || 'Microphone'])], settings.micDevice, (v) => setSetting('micDevice', v), { 'aria-label': 'Microphone' }));
  }

  function tick() {
    if (!rec.live) return;
    const s = (Date.now() - rec.live.started) / 1000;
    time.textContent = `${clock(s)}.${Math.floor((s % 1) * 10)}`;
    meter.firstChild.style.width = `${Math.min(100, Math.sqrt(level) * 100)}%`;
    meter.classList.toggle('clip', level >= 0.99);
    level *= 0.85;
    raf = requestAnimationFrame(tick);
  }

  async function toggle() {
    if (rec.live) {
      cancelAnimationFrame(raf);
      const result = await rec.live.stop();
      rec.live = null;
      rec.count++;
      const line = rec.line;
      const take = { ...result, id: uid(), line, name: line ? takeName(line) : `Take ${rec.count}`, url: URL.createObjectURL(new Blob([result.wav], { type: 'audio/wav' })), saved: false };
      rec.takes.unshift(take);
      api['takes:keep'](takeMeta(take), take.wav);
      meter.firstChild.style.width = '0%';
      draw();
      return;
    }
    try {
      rec.live = await startRawRecording({ workletUrl: WORKLET_URL, deviceId: settings.micDevice, bits: +settings.recBits || 24, onLevel: (p) => { level = Math.max(level, p); } });
    } catch (err) {
      rec.live = null;
      return toast(err.name === 'NotAllowedError' ? 'Microphone blocked. Allow it in Windows Settings > Privacy > Microphone.' : `Could not start the microphone: ${err.message}`, true);
    }
    drawDevices();
    tick();
    draw();
  }

  // The script: a part picked here, or lines someone asked this person to record.
  function linesNow() {
    if (rec.ask) return { title: `${rec.ask.from} asked you to record: ${rec.ask.part}`, lines: rec.ask.lines };
    const [epId, partId] = rec.part.split('|');
    const ep = S.episodes.find((e) => e.id === epId);
    const part = ep && allParts(ep).find((p) => p.id === partId);
    return part ? { title: `${ep.title} / ${part.title}`, lines: scriptLines(part.html, part.id), ep, part } : { title: '', lines: [] };
  }

  function drawScript() {
    const now_ = linesNow();
    const partChoices = S.episodes.flatMap((e) => partOptions(e).map(([id, label]) => [`${e.id}|${id}`, `${e.title}: ${label.trim()}`]));
    scriptHead.replaceChildren(
      rec.ask ? h('div', { class: 'ask-banner' }, h('b', {}, now_.title), btn('Close', () => { setAsk(null); drawScript(); }))
        : select([['', 'Pick the script to read...'], ...partChoices], rec.part, (v) => { rec.part = v; rec.line = null; drawScript(); draw(); }, { 'aria-label': 'Script to read', class: 'wide' }),
      collab.role === 'host' && collab.guests.size > 0 && now_.lines.length > 0 && !rec.ask && btn('Ask someone to record', () => askToRecord(now_), 'primary'));
    script.replaceChildren(...(now_.lines.length ? now_.lines.map((line) => {
      const n = takesFor(line.key);
      return h('button', { type: 'button', class: `line-row ${rec.line?.key === line.key ? 'on' : ''} ${line.kind === 'dlg' ? 'dlg' : ''}`, onclick: () => { rec.line = rec.line?.key === line.key ? null : line; drawScript(); draw(); } },
        line.who && h('span', { class: 'line-who' }, line.who),
        h('span', { class: 'line-text' }, line.text),
        n > 0 && h('span', { class: 'line-done', title: `${n} saved take${n > 1 ? 's' : ''}` }, `✓ ${n}`));
    }) : [h('p', { class: 'muted pad' }, rec.part ? 'This part has no text yet.' : 'Pick a part to see its lines here. Click a line before recording and the take is named after it.')]));
  }

  function draw() {
    big.textContent = rec.live ? 'Stop' : 'Record';
    big.classList.toggle('on', !!rec.live);
    root.classList.toggle('recording', !!rec.live);
    now.replaceChildren(rec.line ? h('span', {}, h('span', { class: 'muted' }, 'Recording line: '), h('b', {}, takeName(rec.line))) : h('span', { class: 'muted' }, 'No line picked: takes are named Take 1, Take 2...'));
    list.replaceChildren(...(rec.takes.length ? rec.takes.map((t) => h('div', { class: `take-row ${t.saved ? 'saved' : ''}` },
      h('button', { class: 'row-play', type: 'button', title: 'Play', 'aria-label': `Play ${t.name}`, onclick: () => playRemote(t.url, t.name) }, '▶'),
      h('input', { class: 'grow take-name', value: t.name, 'aria-label': 'Take name', oninput: (e) => { t.name = e.target.value; } }),
      h('span', { class: 'muted' }, `${t.secs < 60 ? `${t.secs.toFixed(1)}s` : clock(t.secs)} | ${(t.rate / 1000).toFixed(1)} kHz ${t.channels === 1 ? 'mono' : 'stereo'}`),
      t.peak >= 0.99 && h('span', { class: 'clip-tag', title: 'Too loud: the mic hit its limit' }, 'Clipped'),
      t.saved === 'sending' ? h('span', { class: 'saved-tag' }, 'Sending...')
        : t.saved ? h('span', { class: 'saved-tag' }, collab.role === 'guest' ? 'Sent' : 'Saved')
          : [btn(collab.role === 'guest' ? 'Send' : 'Save', async () => { await keepTake(t, t.name, settings.recFolder || 'Voice Takes'); draw(); drawScript(); }, 'primary'),
            collab.role !== 'guest' && h('button', { class: 'link small-link', type: 'button', onclick: async () => {
              const choice = await saveTakeDialog(t);
              if (!choice) return;
              t.name = choice.name;
              await keepTake(t, choice.name, choice.folder);
              draw(); drawScript();
            } }, 'Save as...')],
      h('button', { class: 'x show', type: 'button', title: 'Delete take', onclick: () => { URL.revokeObjectURL(t.url); forgetTake(t); rec.takes.splice(rec.takes.indexOf(t), 1); draw(); } }, '×')))
      : [h('div', { class: 'empty-state small' }, h('p', {}, 'Press Record, do a take, press Stop. Keep going until one feels right.'))]));
  }
  rec.redraw = () => { if (ui.view === 'record') { draw(); drawScript(); } };

  const big = h('button', { class: 'rec-btn', type: 'button', onclick: toggle }, 'Record');
  root.append(h('section', { class: 'pane' }, h('div', { class: 'rec-layout' },
    h('div', { class: 'scroll rec-main' }, h('div', { class: 'column' },
      h('div', { class: 'row between' }, h('h1', { class: 'view-title' }, 'Recording'), devices),
      h('p', { class: 'muted' }, 'Raw microphone: no noise removal, echo cancelling or auto volume. Takes stay here until you save them, and are lost when the app closes.'),
      h('div', { class: 'rec-deck' }, big, h('div', { class: 'grow' }, time, meter, now)),
      h('h2', { class: 'section-title' }, 'Takes'),
      list)),
    h('aside', { class: 'rec-script' }, h('h2', {}, 'Script'), scriptHead, script))));
  drawDevices();
  draw();
  drawScript();
  if (rec.live) tick();
};

// Host: send some lines to one person in the session to record.
async function askToRecord({ title, lines }) {
  const people = [...collab.guests.values()];
  const who = select(people.map((g) => [g.clientId, g.name]), people[0].clientId, () => {}, { 'aria-label': 'Who should record', class: 'wide' });
  const boxes = lines.map((l) => h('label', { class: 'ask-line' }, h('input', { type: 'checkbox', checked: takesFor(l.key) === 0 }), h('span', {}, takeName(l))));
  const ok = await new Promise((resolve) => {
    const close = (v) => { overlay.remove(); resolve(v); };
    const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true' },
      h('form', { class: 'dialog wide-dialog', onsubmit: (e) => { e.preventDefault(); close(true); }, onkeydown: (e) => { if (e.key === 'Escape') close(false); } },
        h('h3', {}, 'Ask someone to record'),
        h('label', { class: 'field' }, h('span', {}, 'Who'), who),
        h('div', { class: 'field' }, h('span', {}, `Lines from ${title} (ticked ones are sent; lines with no takes yet start ticked)`), h('div', { class: 'ask-lines' }, boxes)),
        h('div', { class: 'row end' }, h('button', { type: 'button', class: 'btn', onclick: () => close(false) }, 'Cancel'), h('button', { type: 'submit', class: 'btn primary' }, 'Send request'))));
    document.body.append(overlay);
  });
  const picked = lines.filter((_, i) => boxes[i].querySelector('input').checked);
  if (!ok || !picked.length) return;
  const g = collab.guests.get(who.value);
  g?.conn.send({ t: 'recordAsk', from: myName(), part: title, lines: picked });
  toast(`Asked ${g?.name} to record ${picked.length} line${picked.length > 1 ? 's' : ''}`);
}

// Guest: a request from the host appears as a note with a button that opens the lines.
function showRecordAsk(ask) {
  const note = h('div', { class: 'toast update' }, `${ask.from} asks you to record ${ask.lines.length} line${ask.lines.length > 1 ? 's' : ''}. `,
    btn('Open', () => { setAsk(ask); note.remove(); go('record'); }, 'primary'),
    btn('Later', () => note.remove()));
  $('#toasts').append(note);
  notify(`${ask.from} asks you to record`, `${ask.lines.length} line${ask.lines.length > 1 ? 's' : ''}: ${takeName(ask.lines[0])}`, () => { setAsk(ask); note.remove(); go('record'); });
}
