'use strict';
// Raw mic recording: echo cancellation, noise suppression and auto gain are all off, and takes
// are kept as uncompressed 24-bit WAV.
const WORKLET_URL = new URL('rec-worklet.js', document.currentScript.src).href;
const rec = { takes: [], device: '', live: null, count: 0 };

function encodeWav(channels, sampleRate) {
  const frames = channels[0].length;
  const n = channels.length;
  const buf = new ArrayBuffer(44 + frames * n * 3);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + frames * n * 3, true); str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, n, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * n * 3, true); v.setUint16(32, n * 3, true); v.setUint16(34, 24, true);
  str(36, 'data'); v.setUint32(40, frames * n * 3, true);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < n; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      const x = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
      v.setUint8(o, x & 255); v.setUint8(o + 1, (x >> 8) & 255); v.setUint8(o + 2, (x >> 16) & 255);
      o += 3;
    }
  }
  return buf;
}

async function startRecording(onLevel) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: {
    deviceId: rec.device ? { exact: rec.device } : undefined,
    echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 },
  } });
  const settings = stream.getAudioTracks()[0].getSettings();
  const ctx = new AudioContext({ sampleRate: settings.sampleRate || 48000 });
  await ctx.audioWorklet.addModule(WORKLET_URL);
  const channels = settings.channelCount || 1;
  const node = new AudioWorkletNode(ctx, 'rec', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: channels, channelCountMode: 'explicit' });
  const blocks = [];
  let peak = 0;
  node.port.onmessage = (e) => {
    blocks.push(e.data);
    let p = 0;
    for (const ch of e.data) for (const s of ch) p = Math.max(p, Math.abs(s));
    peak = Math.max(peak, p);
    onLevel(p);
  };
  ctx.createMediaStreamSource(stream).connect(node);
  const started = Date.now();
  rec.live = {
    started,
    async stop() {
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close();
      const frames = blocks.reduce((sum, b) => sum + b[0].length, 0);
      const out = Array.from({ length: channels }, () => new Float32Array(frames));
      let at = 0;
      for (const b of blocks) { out.forEach((ch, c) => ch.set(b[c] || b[0], at)); at += b[0].length; }
      const wav = encodeWav(out, ctx.sampleRate);
      rec.count++;
      return { id: uid(), name: `Take ${rec.count}`, wav, url: URL.createObjectURL(new Blob([wav], { type: 'audio/wav' })), secs: frames / ctx.sampleRate, peak, rate: ctx.sampleRate, channels, saved: false };
    },
  };
}

function saveTakeDialog(take) {
  return new Promise((resolve) => {
    const L = S.library;
    const name = h('input', { value: take.name, class: 'wide', 'aria-label': 'Take name' });
    const NEW = '\u0000new';
    const folder = select([...L.folders.map((f) => [f, f]), ['', 'No folder'], [NEW, '+ New folder...']], L.folders.includes('Voice Takes') ? 'Voice Takes' : (L.folders[0] || ''), () => { newName.classList.toggle('off', folder.value !== NEW); }, { 'aria-label': 'Folder', class: 'wide' });
    const newName = h('input', { class: 'wide off', placeholder: 'Folder name', value: 'Voice Takes', 'aria-label': 'New folder name' });
    const close = (v) => { overlay.remove(); resolve(v); };
    const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true' },
      h('form', { class: 'dialog', onsubmit: (e) => { e.preventDefault(); close({ name: name.value.trim() || take.name, folder: folder.value === NEW ? newName.value.trim() : folder.value }); }, onkeydown: (e) => { if (e.key === 'Escape') close(null); } },
        h('h3', {}, 'Save take to library'),
        h('label', { class: 'field' }, h('span', {}, 'Name'), name),
        h('label', { class: 'field' }, h('span', {}, 'Folder'), folder, newName),
        h('div', { class: 'row end' }, h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, 'Cancel'), h('button', { type: 'submit', class: 'btn primary' }, 'Save'))));
    if (!L.folders.includes('Voice Takes')) { folder.value = NEW; newName.classList.remove('off'); } // defaults to a new "Voice Takes"
    document.body.append(overlay);
    name.select();
  });
}

VIEW.record = (root) => {
  const meter = h('div', { class: 'rec-meter' }, h('i', {}));
  const time = h('div', { class: 'rec-time' }, '0:00.0');
  const devices = h('span', {});
  const list = h('div', { class: 'take-list' });
  let raf = 0;
  let level = 0;

  async function drawDevices() {
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    devices.replaceChildren(select([['', 'Default microphone'], ...inputs.filter((d) => d.deviceId && d.deviceId !== 'default').map((d) => [d.deviceId, d.label || 'Microphone'])], rec.device, (v) => { rec.device = v; }, { 'aria-label': 'Microphone' }));
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
      const take = await rec.live.stop();
      rec.live = null;
      rec.takes.unshift(take);
      meter.firstChild.style.width = '0%';
      draw();
      return;
    }
    try {
      await startRecording((p) => { level = Math.max(level, p); });
    } catch (err) {
      return toast(err.name === 'NotAllowedError' ? 'Microphone blocked. Allow it in Windows Settings > Privacy > Microphone.' : `Could not start the microphone: ${err.message}`, true);
    }
    drawDevices();
    tick();
    draw();
  }

  function draw() {
    big.textContent = rec.live ? 'Stop' : 'Record';
    big.classList.toggle('on', !!rec.live);
    root.classList.toggle('recording', !!rec.live);
    list.replaceChildren(...(rec.takes.length ? rec.takes.map((t) => h('div', { class: `take-row ${t.saved ? 'saved' : ''}` },
      h('button', { class: 'row-play', type: 'button', title: 'Play', 'aria-label': `Play ${t.name}`, onclick: () => playRemote(t.url, t.name) }, '▶'),
      h('input', { class: 'grow take-name', value: t.name, 'aria-label': 'Take name', oninput: (e) => { t.name = e.target.value; } }),
      h('span', { class: 'muted' }, `${t.secs < 60 ? `${t.secs.toFixed(1)}s` : clock(t.secs)} | ${(t.rate / 1000).toFixed(1)} kHz ${t.channels === 1 ? 'mono' : 'stereo'}`),
      t.peak >= 0.99 && h('span', { class: 'clip-tag', title: 'Too loud: the mic hit its limit' }, 'Clipped'),
      t.saved ? h('span', { class: 'saved-tag' }, 'Saved') : btn('Save', async () => {
        const choice = await saveTakeDialog(t);
        if (!choice) return;
        if (choice.folder && !S.library.folders.includes(choice.folder)) S.library.folders.push(choice.folder);
        const info = await api['lib:saveAudio'](choice.name, t.wav);
        addToLibrary([{ ...info, source: 'Recorded' }], { kind: 'sound', folder: choice.folder });
        refreshLibTitles();
        t.name = choice.name;
        t.saved = true;
        toast(`Saved "${choice.name}" to ${choice.folder || 'Library'}`);
        draw();
      }, 'primary'),
      h('button', { class: 'x show', type: 'button', title: 'Delete take', onclick: () => { URL.revokeObjectURL(t.url); rec.takes.splice(rec.takes.indexOf(t), 1); draw(); } }, '×')))
      : [h('div', { class: 'empty-state small' }, h('p', {}, 'Press Record, do a take, press Stop. Keep going until one feels right.'))]));
  }

  const big = h('button', { class: 'rec-btn', type: 'button', onclick: toggle }, 'Record');
  root.append(h('section', { class: 'pane' }, h('div', { class: 'scroll' }, h('div', { class: 'column' },
    h('div', { class: 'row between' }, h('h1', { class: 'view-title' }, 'Recording'), devices),
    h('p', { class: 'muted' }, 'Raw microphone: no noise removal, echo cancelling or auto volume. Takes stay here until you save them, and are lost when the app closes.'),
    h('div', { class: 'rec-deck' }, big, h('div', { class: 'grow' }, time, meter)),
    h('h2', { class: 'section-title' }, 'Takes'),
    list))));
  drawDevices();
  draw();
  if (rec.live) tick();
};
