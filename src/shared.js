'use strict';
// Used by both the desktop app and the phone page: raw recording, WAV files, and script lines.

function encodeWav(channels, sampleRate, bits = 24) {
  const bytes = bits / 8;
  const frames = channels[0].length;
  const n = channels.length;
  const buf = new ArrayBuffer(44 + frames * n * bytes);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + frames * n * bytes, true); str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, n, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * n * bytes, true); v.setUint16(32, n * bytes, true); v.setUint16(34, bits, true);
  str(36, 'data'); v.setUint32(40, frames * n * bytes, true);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < n; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      if (bytes === 2) { v.setInt16(o, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true); o += 2; continue; }
      const x = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
      v.setUint8(o, x & 255); v.setUint8(o + 1, (x >> 8) & 255); v.setUint8(o + 2, (x >> 16) & 255);
      o += 3;
    }
  }
  return buf;
}

// Raw microphone: echo cancelling, noise removal and auto volume are all off.
async function startRawRecording({ workletUrl, deviceId, bits = 24, onLevel = () => {} }) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 },
  } });
  const track = stream.getAudioTracks()[0].getSettings();
  let ctx;
  try { ctx = new AudioContext({ sampleRate: track.sampleRate || 48000 }); } catch { ctx = new AudioContext(); } // some phones refuse a set rate
  await ctx.audioWorklet.addModule(workletUrl);
  const channels = Math.min(2, track.channelCount || 1);
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
  if (ctx.state === 'suspended') await ctx.resume();
  return {
    started: Date.now(),
    async stop() {
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close();
      const frames = blocks.reduce((sum, b) => sum + b[0].length, 0);
      const out = Array.from({ length: channels }, () => new Float32Array(frames));
      let at = 0;
      for (const b of blocks) { out.forEach((ch, c) => ch.set(b[c] || b[0], at)); at += b[0].length; }
      return { wav: encodeWav(out, ctx.sampleRate, bits), secs: frames / ctx.sampleRate, peak, rate: ctx.sampleRate, channels };
    },
  };
}

function hashText(s) {
  let h = 5381;
  for (const ch of s) h = ((h << 5) + h + ch.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
}

// Splits a part into lines to record. Script dialogue keeps its speaker; other paragraphs are lines too.
// A line's key comes from its words, so it stays the same when other lines are added or moved.
function scriptLines(html, partId) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  const out = [];
  let who = '';
  for (const block of doc.body.children) {
    const text = block.textContent.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const kind = block.className;
    if (kind === 'char') { who = text.replace(/\s*\(.*?\)\s*$/, '').toUpperCase(); continue; }
    if (kind === 'paren') continue;
    const speaker = kind === 'dlg' ? who : '';
    if (kind !== 'dlg') who = '';
    out.push({ key: `${partId}:${hashText(`${speaker}|${text}`)}`, who: speaker, text, kind: kind || 'text' });
  }
  return out;
}

const takeName = (line) => `${line.who ? `${line.who} - ` : ''}${line.text.slice(0, 60)}`.replace(/[\\/:*?"<>|]/g, '').trim();
