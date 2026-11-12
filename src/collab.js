'use strict';
// Write together. The host's PC holds the show; guests connect straight to it over WebRTC (PeerJS).
// The public PeerJS server only introduces the two PCs using the 6-character code; the writing
// itself goes PC to PC, encrypted.
//
// Sync: every local change becomes small operations (diff of the show against the last synced copy).
// The host checks each guest operation against that guest's permissions, applies it and passes it
// on. One person writes in a document at a time: others see who is in it and it is read-only for them.
const PEER_PREFIX = 'storyroom-';
const SECTION_LIST = [['show', 'Show'], ['writing', 'Writing'], ['characters', 'Characters'], ['world', 'World'], ['storyboard', 'Storyboard'], ['library', 'Library & sounds'], ['todo', 'To Do'], ['production', 'Production']];
const collab = {
  // Each device (not name) that was let in keeps its permissions, even after Storyroom restarts.
  role: null, peer: null, code: '', guests: new Map(), known: new Map(Object.entries(settings.knownGuests || {}).map(([id, v]) => [id, v.perms])), banned: new Set(), host: null, hostName: '', perms: null,
  locks: [], myDoc: null, snapshot: null, timer: 0, pendingRender: false,
  clientId: (() => { try { return localStorage.getItem('clientId') || (localStorage.setItem('clientId', uid() + uid()), localStorage.getItem('clientId')); } catch { return uid() + uid(); } })(),
};
const myName = () => settings.myName || 'Someone';
const presetPerms = (level) => ({ sections: Object.fromEntries(SECTION_LIST.map(([k]) => [k, level])), items: {}, canDelete: false });
// Two public STUN servers find each PC's address; a relay (TURN) from Settings carries data when a network blocks direct links.
const iceConfig = () => ({ config: { iceServers: [
  { urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' },
  ...(settings.turnUrl ? [{ urls: settings.turnUrl.split(/[\s,]+/).filter(Boolean), username: settings.turnUser, credential: settings.turnPass }] : []),
] } });
const isDeletion = (op) => 'rm' in op || op.del === true;

// --- Operations --------------------------------------------------------------------------------
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const isIdArray = (a, b) => Array.isArray(a) && Array.isArray(b) && [...a, ...b].every((x) => isObj(x) && typeof x.id === 'string');

function diff(a, b, p = [], out = []) {
  if (a === b) return out;
  if (isIdArray(a, b)) {
    const am = new Map(a.map((x) => [x.id, x]));
    const bm = new Map(b.map((x) => [x.id, x]));
    for (const x of a) if (!bm.has(x.id)) out.push({ p, rm: x.id });
    b.forEach((x, i) => (am.has(x.id) ? diff(am.get(x.id), x, [...p, { id: x.id }], out) : out.push({ p, add: x, after: i ? b[i - 1].id : null })));
    const before = a.filter((x) => bm.has(x.id)).map((x) => x.id).join();
    const after = b.filter((x) => am.has(x.id)).map((x) => x.id).join();
    if (before !== after) out.push({ p, order: b.map((x) => x.id) });
    return out;
  }
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in b)) out.push({ p: [...p, k], del: true });
      else diff(a[k], b[k], [...p, k], out);
    }
    return out;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ p, v: b });
  return out;
}

function resolve(root, path) {
  let o = root;
  for (const s of path) {
    o = isObj(s) ? (Array.isArray(o) ? o.find((x) => x.id === s.id) : undefined) : o?.[s];
    if (o == null) return undefined;
  }
  return o;
}

function applyOps(root, ops) {
  for (const op of ops) {
    if ('add' in op || 'rm' in op || 'order' in op) {
      const arr = resolve(root, op.p);
      if (!Array.isArray(arr)) continue;
      if ('add' in op) {
        if (arr.some((x) => x.id === op.add.id)) continue;
        const i = op.after == null ? 0 : arr.findIndex((x) => x.id === op.after) + 1;
        arr.splice(i > 0 || op.after == null ? i : arr.length, 0, structuredClone(op.add));
      } else if ('rm' in op) {
        const i = arr.findIndex((x) => x.id === op.rm);
        if (i >= 0) arr.splice(i, 1);
      } else {
        const rank = new Map(op.order.map((id, i) => [id, i]));
        arr.sort((x, y) => (rank.get(x.id) ?? 1e9) - (rank.get(y.id) ?? 1e9));
      }
      continue;
    }
    const parent = resolve(root, op.p.slice(0, -1));
    const last = op.p.at(-1);
    if (parent == null) continue;
    if (isObj(last)) {
      const i = Array.isArray(parent) ? parent.findIndex((x) => x.id === last.id) : -1;
      if (i < 0) continue;
      if (op.del) parent.splice(i, 1); else parent[i] = structuredClone(op.v);
    } else if (op.del) delete parent[last];
    else parent[last] = structuredClone(op.v);
  }
}

// --- Permissions -------------------------------------------------------------------------------
function classify(op, state) {
  const [top, sel, sub] = op.p;
  const arrayLevel = op.p.length === 1;
  const id = arrayLevel ? (op.add?.id ?? op.rm ?? null) : sel?.id;
  if (top === 'episodes') return { section: sub === 'panels' ? 'storyboard' : 'writing', item: id };
  if (top === 'pages') {
    const page = state.pages.find((x) => x.id === id) || op.add;
    return { section: page?.kind === 'character' ? 'characters' : 'world', item: id };
  }
  const map = { todos: 'todo', tasks: 'production', columns: 'production', show: 'show', library: 'library', sources: 'library' };
  return { section: map[top] || 'other', item: null };
}
const effective = (perms, section, item) => (item && perms.items[item]) || perms.sections[section] || 'hidden';
const opLevel = (perms, op, state) => { const c = classify(op, state); return effective(perms, c.section, c.item); };

// What a guest is allowed to see: hidden things never leave the host.
function visibleState(perms) {
  commitEditors();
  const s = structuredClone(S);
  const eff = (sec, id) => effective(perms, sec, id);
  s.episodes = s.episodes.filter((e) => eff('writing', e.id) !== 'hidden' || eff('storyboard', e.id) !== 'hidden');
  s.episodes.forEach((e) => {
    if (eff('writing', e.id) === 'hidden') e.parts = [];
    if (eff('storyboard', e.id) === 'hidden') e.panels = [];
  });
  s.pages = s.pages.filter((p) => eff(p.kind === 'character' ? 'characters' : 'world', p.id) !== 'hidden');
  if (eff('todo') === 'hidden') s.todos = [];
  if (eff('production') === 'hidden') { s.tasks = []; s.columns = []; }
  if (eff('library') === 'hidden') { s.library = { folders: [], items: [] }; s.sources = []; }
  if (eff('show') === 'hidden') s.show = { ...s.show, logline: '', bible: '<p><br></p>' };
  return s;
}

// --- Local changes out, remote changes in ------------------------------------------------------
function collabChanged() {
  if (!collab.role || !collab.snapshot) return;
  if (collab.timer) return; // sends every 200 ms while someone types, instead of waiting for a pause
  collab.timer = setTimeout(() => {
    collab.timer = 0;
    commitEditors();
    const ops = diff(collab.snapshot, S);
    collab.snapshot = structuredClone(S);
    if (!ops.length) return;
    if (collab.role === 'host') relay(ops, null);
    else collab.host?.send({ t: 'ops', ops });
  }, 200);
}

function relay(ops, except) {
  for (const g of collab.guests.values()) {
    if (g === except) continue;
    const visible = ops.filter((op) => opLevel(g.perms, op, S) !== 'hidden');
    if (visible.length) g.conn.send({ t: 'ops', ops: visible });
  }
}

function applyRemote(ops) {
  commitEditors();
  applyOps(S, ops);
  applyOps(collab.snapshot, ops);
  if (collab.role === 'host') touch();
  liveRefresh(ops);
}

// Long text that others are only typing into (scripts, descriptions, notes) never needs a redraw.
const TEXT_KEYS = new Set(['html', 'bible', 'notes', 'action', 'dialogue', 'logline', 'v', 'text', 'secs']);

// Shows what others type right away: writing boxes and fields on screen are updated in place.
// Only changes to lists and layout (new pages, moved parts) redraw the section.
function liveRefresh(ops) {
  const shown = new Map(); // object -> key -> elements showing it
  const add = (obj, key, el) => {
    if (!shown.has(obj)) shown.set(obj, new Map());
    const keys = shown.get(obj);
    if (!keys.has(key)) keys.set(key, []);
    keys.get(key).push(el);
  };
  for (const e of live) if (e.el.isConnected) add(e.obj, e.key, e.el);
  document.querySelectorAll('#main input, #main textarea').forEach((el) => { const b = bindings.get(el); if (b) add(b.obj, b.key, el); });
  let redraw = false;
  for (const op of ops) {
    const key = op.p.at(-1);
    if (!('v' in op) || typeof key !== 'string') { redraw = true; continue; }
    const els = shown.get(resolve(S, op.p.slice(0, -1)))?.get(key);
    if (!els) { if (!TEXT_KEYS.has(key)) redraw = true; continue; }
    for (const el of els) {
      if (el === document.activeElement) continue; // never touch the box this person is typing in
      if (el.classList.contains('rte')) {
        const html = op.v || '<p><br></p>';
        if (el.innerHTML !== html) el.innerHTML = html;
        el.classList.toggle('empty', !el.textContent.trim() && !el.querySelector('img,table,hr'));
      } else if (el.value !== String(op.v ?? '')) el.value = op.v ?? '';
    }
  }
  if (redraw) rerenderSoon();
}

function rerenderSoon() {
  const a = document.activeElement;
  if (a && $('#main').contains(a) && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) { collab.pendingRender = true; return; }
  rerender();
}
document.addEventListener('focusout', () => setTimeout(() => { if (collab.pendingRender && !$('#main').contains(document.activeElement)) { collab.pendingRender = false; rerender(); } }, 0));

function rerender() {
  if (!ui.view || ui.view === 'find') return;
  const scrolls = [...document.querySelectorAll('#main .scroll, #main .paper-wrap, #main .side-body')].map((e) => e.scrollTop);
  go(ui.view, { quiet: true });
  document.querySelectorAll('#main .scroll, #main .paper-wrap, #main .side-body').forEach((e, i) => { e.scrollTop = scrolls[i] || 0; });
}

// --- Who is writing where ----------------------------------------------------------------------
function collabFocus(doc) {
  if (!collab.role || collab.myDoc === doc) return;
  collab.myDoc = doc;
  if (collab.role === 'host') shareLocks(); else collab.host?.send({ t: 'focus', doc });
}
function shareLocks() {
  collab.locks = [[collab.myDoc, myName(), 'host'], ...[...collab.guests.values()].map((g) => [g.doc, g.name, g.clientId])].filter((l) => l[0]);
  for (const g of collab.guests.values()) g.conn.send({ t: 'locks', locks: collab.locks });
  refreshLocks();
}
const myLockId = () => (collab.role === 'host' ? 'host' : collab.clientId);
function refreshLocks() {
  for (const ed of document.querySelectorAll('.rte[data-doc]')) {
    const lock = collab.role && collab.locks.find((l) => l[0] === ed.dataset.doc && l[2] !== myLockId());
    const readOnly = !!lock || !!ed.closest('.ro');
    const want = readOnly ? 'false' : 'true';
    if (ed.contentEditable !== want) ed.contentEditable = want;
    // Only touch the badge when it changes, so the page watcher below does not loop.
    const paper = ed.parentElement;
    const badge = paper.querySelector('.lock-badge');
    const text = lock ? `${lock[1]} is writing here` : '';
    if ((badge?.textContent || '') === text) continue;
    badge?.remove();
    if (lock) paper.prepend(h('div', { class: 'lock-badge' }, text));
  }
}

// --- Files (images, sounds) live on the host ---------------------------------------------------
const fileWaiters = new Map();
const sharedPath = (rel) => typeof rel === 'string' && /^(images|library)\/[^\\]+$/.test(rel) && !rel.includes('..');
function requestFile(rel) {
  if (collab.role !== 'guest' || !sharedPath(rel)) return Promise.resolve();
  if (!fileWaiters.has(rel)) fileWaiters.set(rel, new Promise((resolve) => { collab.host.send({ t: 'getFile', rel }); fileWaiters.set(`${rel}#done`, resolve); }));
  return fileWaiters.get(rel);
}
function fileArrived(rel) {
  fileWaiters.get(`${rel}#done`)?.();
  fileWaiters.delete(`${rel}#done`);
  document.querySelectorAll('img').forEach((img) => { if (decodeURIComponent(img.getAttribute('src') || '').split('?')[0] === rel || img.getAttribute('src')?.split('?')[0] === url(rel)) img.src = `${url(rel)}?f=${Date.now()}`; });
}
// Missing pictures in a guest's copy are fetched from the host as they appear.
document.addEventListener('error', (e) => {
  if (collab.role !== 'guest' || e.target.tagName !== 'IMG' || e.target.dataset.asked) return;
  e.target.dataset.asked = '1';
  requestFile(decodeURIComponent((e.target.getAttribute('src') || '').split('?')[0]));
}, true);

async function onFileWritten(rel) {
  if (collab.role !== 'guest' || !sharedPath(rel)) return;
  const data = await api['file:read'](rel);
  if (data) collab.host.send({ t: 'putFile', rel, data });
}

// --- Hosting -----------------------------------------------------------------------------------
function newCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return [...crypto.getRandomValues(new Uint8Array(6))].map((n) => abc[n % abc.length]).join('');
}

// --- Backup link (Cloudflare Quick Tunnel) ------------------------------------------------------
// A WebSocket that behaves like a PeerJS connection: send / on('data') / on('close') / open.
// Binary file data travels as base64, and big messages are split into parts.
const PART = 512 * 1024;
const toB64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(s); };
const fromB64 = (b64) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
const pack = (obj) => JSON.stringify(obj, (_k, v) => (v instanceof ArrayBuffer ? { __b: toB64(new Uint8Array(v)) } : ArrayBuffer.isView(v) ? { __b: toB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) } : v));
const unpack = (text) => JSON.parse(text, (_k, v) => (v && typeof v === 'object' && typeof v.__b === 'string' ? fromB64(v.__b).buffer : v));

function socketConn(sendText, closeSocket) {
  const handlers = {};
  const parts = new Map();
  const c = {
    open: true, metadata: null, isLink: true,
    send(obj) {
      if (!c.open) return;
      const text = pack(obj);
      if (text.length <= PART) return sendText(text);
      const id = uid();
      const n = Math.ceil(text.length / PART);
      for (let i = 0; i < n; i++) sendText(JSON.stringify({ __part: id, i, n, s: text.slice(i * PART, (i + 1) * PART) }));
    },
    receive(text) {
      let m;
      try { m = unpack(text); } catch { return null; }
      if (!m?.__part) return m;
      const got = parts.get(m.__part) || [];
      got[m.i] = m.s;
      parts.set(m.__part, got);
      if (got.filter((x) => x != null).length < m.n) return null;
      parts.delete(m.__part);
      return unpack(got.join(''));
    },
    close() { c.open = false; closeSocket(); },
    on(ev, fn) { (handlers[ev] ||= []).push(fn); },
    emit(ev, x) { (handlers[ev] || []).forEach((f) => f(x)); },
  };
  return c;
}

const linkConns = new Map();
function tunnelOpened(id) {
  if (collab.role !== 'host') return api['tunnel:kick'](id);
  linkConns.set(id, socketConn((t) => api['tunnel:send'](id, t), () => api['tunnel:kick'](id)));
}
function tunnelData({ id, text }) {
  const c = linkConns.get(id);
  const msg = c?.receive(text);
  if (!msg) return;
  if (c.metadata) return c.emit('data', msg);
  if (msg.t === 'hello') { // the first message says who is joining, like PeerJS metadata
    c.metadata = { name: msg.name, clientId: msg.clientId };
    admit(c);
  }
}
function tunnelClosed(id) {
  const c = linkConns.get(id);
  if (!c) return;
  linkConns.delete(id);
  c.open = false;
  c.emit('close');
}

// The link tool (cloudflared.exe) downloads once, after the person agrees.
async function ensureLinkTool(why) {
  if (await api['tunnel:ready']()) return true;
  const ok = await dialogBox({ title: 'Download the link tool?', text: `${why} Storyroom uses Cloudflare's free Quick Tunnel for this (no account needed). It downloads cloudflared.exe from github.com/cloudflare once.`, okText: 'Download and turn on' });
  if (!ok) return false;
  toast('Downloading the link tool...');
  await api['tunnel:install']();
  return true;
}

async function startBackupLink() {
  if (collab.role !== 'host' || !settings.backupLink || collab.linkState === 'starting') return;
  collab.linkState = 'starting';
  refreshCollabUI();
  try {
    if (!(await ensureLinkTool('Some networks block direct links between PCs, so friends join through a backup link instead.'))) { collab.linkState = 'off'; setSetting('backupLink', false); refreshCollabUI(); return; }
    if (collab.role !== 'host') return;
    collab.tunnelUrl = await api['tunnel:start']();
    collab.linkState = 'ready';
    (collab.pendingHints || []).forEach(sendLinkHint);
    collab.pendingHints = [];
  } catch (err) {
    collab.linkState = `failed: ${String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`;
  }
  refreshCollabUI();
}

// Tells a joining guest the backup address through the matchmaking server, so the code still works
// even when the direct link never opens.
function sendLinkHint(guestPeerId) {
  if (!collab.tunnelUrl) { (collab.pendingHints ||= []).push(guestPeerId); return; }
  const hint = collab.peer?.connect(guestPeerId, { metadata: { storyroomLink: collab.tunnelUrl } });
  setTimeout(() => hint?.close(), 60000);
}

function startHosting() {
  if (!settings.myName) return toast('Type your name first', true);
  const code = newCode();
  const peer = new Peer(PEER_PREFIX + code, iceConfig());
  collab.peer = peer;
  peer.on('open', () => {
    collab.role = 'host';
    collab.code = code;
    saveNow();
    api['backup:now'](); // a restore point from before anyone joined
    collab.snapshot = structuredClone(S);
    refreshCollabUI();
    startBackupLink();
  });
  peer.on('error', (e) => {
    if (e.type === 'unavailable-id') { peer.destroy(); startHosting(); return; }
    toast(`Sharing problem: ${e.message}`, true);
  });
  peer.on('disconnected', () => { if (collab.role === 'host' && !peer.destroyed) peer.reconnect(); }); // keeps the code reachable
  peer.on('connection', (conn) => {
    sendLinkHint(conn.peer);
    conn.on('open', () => admit(conn));
  });
}

async function admit(conn) {
  const { name, clientId } = conn.metadata || {};
  const who = String(name || 'Guest').slice(0, 40);
  if (!clientId || collab.banned.has(clientId)) return conn.close();
  if (settings.askJoin && !collab.known.has(clientId)) {
    conn.send({ t: 'wait' });
    notify('Someone wants to join', `${who} wants to join your show.`, () => {});
    const ok = await dialogBox({ title: `${who} wants to join`, text: 'They will see and edit only what their permissions allow. You can change that any time in Settings > Collaboration.', okText: 'Let them in' });
    if (!ok || !conn.open) { conn.send({ t: 'denied' }); setTimeout(() => conn.close(), 300); return; }
  }
  const g = { conn, name: who, clientId, perms: collab.known.get(clientId) || presetPerms(settings.guestDefault), doc: null };
  collab.known.set(clientId, g.perms);
  rememberDevice(g);
  api['backup:now'](); // a restore point from before this person changed anything
  collab.guests.get(clientId)?.conn.close();
  collab.guests.set(clientId, g);
  sendState(g);
  conn.on('data', (d) => onGuestData(g, d));
  conn.on('close', () => {
    if (collab.guests.get(clientId) !== g) return;
    collab.guests.delete(clientId);
    toast(`${who} left`);
    drawPresence();
    shareLocks();
    refreshCollabUI();
  });
  toast(`${who} joined`);
  drawPresence();
  notify(`${who} joined`, 'They are writing with you now.', () => { ui.settingsTab = 'Collaboration'; go('settings'); });
  refreshCollabUI();
}

function sendState(g) {
  g.conn.send({ t: 'state', state: visibleState(g.perms), perms: g.perms, host: myName(), locks: collab.locks });
}

async function onGuestData(g, d) {
  g.lastSeen = Date.now();
  if (d.t === 'ping') { g.pings = true; return; }
  if (d.t === 'where') {
    const text = (v) => (typeof v === 'string' ? v.slice(0, 120) : '');
    g.where = { view: text(d.view), label: text(d.label), ep: text(d.ep), part: text(d.part), page: text(d.page) };
    drawPresence();
    return;
  }
  if (d.t === 'ops' && Array.isArray(d.ops)) {
    // Deleting whole episodes, pages, panels or tasks needs its own permission (off unless the host turns it on).
    const ok = d.ops.filter((op) => Array.isArray(op?.p) && opLevel(g.perms, op, S) === 'edit' && (!isDeletion(op) || g.perms.canDelete));
    if (ok.length) { applyRemote(ok); relay(ok, g); }
    if (ok.length !== d.ops.length) sendState(g); // undo what they were not allowed to change
  } else if (d.t === 'focus') {
    g.doc = typeof d.doc === 'string' ? d.doc : null;
    shareLocks();
    drawPresence();
  } else if (d.t === 'getFile' && sharedPath(d.rel)) {
    g.conn.send({ t: 'file', rel: d.rel, data: await api['file:read'](d.rel) });
  } else if (d.t === 'putFile' && sharedPath(d.rel) && JSON.stringify(g.perms).includes('"edit"')) {
    await api['file:write'](d.rel, d.data);
  } else if (d.t === 'take' && d.data) {
    // A voice take recorded by someone in the session goes into this show's Voice Takes folder.
    const bytes = new Uint8Array(d.data);
    const tag = (a, b) => String.fromCharCode(...bytes.subarray(a, b));
    if (bytes.length < 45 || bytes.length > 300e6 || tag(0, 4) !== 'RIFF' || tag(8, 12) !== 'WAVE') { g.conn.send({ t: 'takeSaved', id: d.id, ok: false }); return; }
    const folder = settings.recFolder || 'Voice Takes';
    if (!S.library.folders.includes(folder)) S.library.folders.push(folder);
    const name = String(d.name || 'Take').slice(0, 120);
    const info = await api['lib:saveAudio'](name, d.data);
    addToLibrary([{ ...info, source: `Recorded by ${g.name}`, line: typeof d.line === 'string' ? d.line.slice(0, 100) : '' }], { kind: 'sound', folder });
    refreshLibTitles();
    rec.redraw?.();
    toast(`${g.name} sent a take: ${name}`);
    notify('New voice take', `${g.name} sent "${name}"`, () => openLibraryFolder(folder));
    g.conn.send({ t: 'takeSaved', id: d.id, ok: true });
  }
}

function rememberDevice(g) {
  setSetting('knownGuests', { ...(settings.knownGuests || {}), [g.clientId]: { name: g.name, perms: g.perms, seen: Date.now() } });
}

function forgetDevice(clientId) {
  const next = { ...(settings.knownGuests || {}) };
  delete next[clientId];
  collab.known.delete(clientId);
  setSetting('knownGuests', next);
  refreshCollabUI();
}

// Devices let in before: they come back with the same permissions, without asking again.
function rememberedDevices() {
  const away = Object.entries(settings.knownGuests || {}).filter(([id]) => !collab.guests.has(id));
  if (!away.length) return null;
  return h('div', {},
    h('h3', { class: 'set-sub' }, 'Remembered devices'),
    h('p', { class: 'muted' }, 'When one of these reconnects, it gets back in straight away with the same permissions. Forget a device to make it ask again.'),
    away.map(([id, d]) => h('div', { class: 'row between device-row' },
      h('span', {}, h('b', {}, d.name), h('span', { class: 'muted' }, ` last here ${new Date(d.seen).toLocaleString()}`)),
      btn('Forget', () => forgetDevice(id), 'danger-text'))));
}

function lastSession() {
  try { return JSON.parse(localStorage.getItem('lastSession') || 'null'); } catch { return null; }
}

function setGuestPerms(g, perms) {
  g.perms = perms;
  collab.known.set(g.clientId, perms);
  rememberDevice(g);
  sendState(g);
}

function stopHosting() {
  for (const g of collab.guests.values()) { g.conn.send({ t: 'end' }); }
  setTimeout(() => collab.peer?.destroy(), 300);
  api['tunnel:stop']();
  Object.assign(collab, { role: null, code: '', snapshot: null, locks: [], tunnelUrl: null, linkState: null, pendingHints: [] });
  collab.guests.clear();
  refreshLocks();
  refreshCollabUI();
}

function removeGuest(g) {
  collab.banned.add(g.clientId);
  g.conn.send({ t: 'kicked' });
  setTimeout(() => g.conn.close(), 300);
}

// --- Joining -----------------------------------------------------------------------------------
const BLOCKED_HELP = 'The two PCs could not link directly. A router or network (school, work, some internet providers, phone hotspots) is blocking it. Try "Test my connection" on both PCs, another network, or add a relay server below on both PCs.';

// Shown in Settings > Collaboration while joining, so it never just sits on "Connecting".
function setJoinState(text, failed) {
  collab.joinState = text ? { text, failed: !!failed } : null;
  refreshCollabUI();
}

// True while connecting for the first time, or while getting back in after a drop.
const joining = () => collab.role !== 'guest' || collab.reconnecting;

function joinFailed(text) {
  clearTimeout(collab.joinTimer);
  clearTimeout(collab.linkTimer);
  collab.linkTrying = false;
  collab.linkSocket?.close();
  collab.peer?.destroy();
  collab.peer = null;
  if (collab.reconnecting) return; // the reconnect loop tries again quietly
  setJoinState(text, true);
  toast(text.split('. ')[0], true);
}

// --- Staying connected ---------------------------------------------------------------------------
// Both sides say "still here" every 20 s: idle links (Cloudflare closes quiet ones after ~100 s)
// stay open, and a link that went silent for a minute is treated as dropped.
setInterval(() => {
  const now = Date.now();
  if (collab.role === 'host') {
    for (const g of collab.guests.values()) {
      g.conn.send({ t: 'ping' });
      // Only for people whose app says "still here" (older versions never do).
      if (g.pings && now - (g.lastSeen || now) > 60000) g.conn.close();
    }
  } else if (collab.role === 'guest' && !collab.reconnecting) {
    collab.host?.send({ t: 'ping' });
    if (collab.hostPings && now - (collab.lastHeard || now) > 60000) hostLost();
  }
}, 20000);

// The link to the host dropped: keep the shared show on screen (read-only) and quietly reconnect,
// instead of sending the person back to their own show.
function hostLost() {
  if (collab.role !== 'guest' || collab.reconnecting) return;
  collab.reconnecting = true;
  collab.host = null;
  applyReadOnly();
  const bar = h('div', { id: 'reconnectBar' }, 'Connection lost. Reconnecting... (editing is paused so nothing is lost)');
  $('#reconnectBar')?.remove();
  document.body.append(bar);
  let tries = 0;
  const attempt = () => {
    if (!collab.reconnecting) return;
    if (++tries > 12) { // about 3 minutes
      collab.reconnecting = false;
      leaveSession('Lost the connection to the host. When they are back, use Rejoin in Settings > Collaboration. Unsent takes were kept.');
      return;
    }
    bar.textContent = `Connection lost. Reconnecting (try ${tries})... Editing is paused so nothing is lost.`;
    joinSession(collab.joinCode);
    collab.reconnectTimer = setTimeout(attempt, 15000);
  };
  attempt();
}

function reconnected() {
  collab.reconnecting = false;
  clearTimeout(collab.reconnectTimer);
  $('#reconnectBar')?.remove();
  toast('Reconnected');
}

async function joinSession(rawCode) {
  const code = rawCode.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return toast('Codes are 6 letters and numbers', true);
  collab.joinCode = code;
  if (!settings.myName) return toast('Type your name first', true);
  if (collab.role !== 'guest') {
    saveNow();
    await api['backup:now'](); // your own show gets a restore point before you visit someone else's
  }
  collab.linkSocket?.close();
  collab.peer?.destroy();
  const peer = new Peer(undefined, iceConfig());
  collab.peer = peer;
  setJoinState('Finding the session...');
  clearTimeout(collab.joinTimer);
  collab.linkHint = null;
  collab.linkTrying = false;
  let directOpen = false;
  // A blocked direct link switches to the host's backup link when the host has one.
  const blocked = () => (collab.linkHint ? joinViaLink(collab.linkHint) : joinFailed(BLOCKED_HELP));
  collab.joinTimer = setTimeout(() => { if (joining() && !directOpen && !collab.linkTrying) blocked(); }, 25000);
  peer.on('connection', (hint) => {
    const link = hint.metadata?.storyroomLink;
    if (!link || !/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(link) || !joining()) return;
    collab.linkHint = link;
    clearTimeout(collab.linkTimer);
    collab.linkTimer = setTimeout(() => { if (!directOpen && joining()) joinViaLink(link); }, 7000);
  });
  peer.on('error', (e) => joinFailed(e.type === 'peer-unavailable' ? 'No session with that code is open right now. Check the code, and that the host still has sharing on.'
    : e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error' ? 'Could not reach the matchmaking server. Check your internet connection.' : `Could not connect: ${e.message}`));
  peer.on('open', () => {
    const conn = peer.connect(PEER_PREFIX + code, { reliable: true, metadata: { name: myName(), clientId: collab.clientId } });
    setJoinState('Reaching their PC...');
    conn.on('open', () => { directOpen = true; clearTimeout(collab.linkTimer); setJoinState('Connected. Waiting for the host to let you in...'); });
    conn.on('data', (d) => onHostData(conn, d));
    conn.on('close', () => { if (collab.role === 'guest' && collab.host === conn) hostLost(); });
    conn.on('error', () => { if (!directOpen) blocked(); });
    // PeerJS creates the link a moment after connect(); a failed direct link shows up here quickly.
    const watchIce = () => {
      const pc = conn.peerConnection;
      if (!pc) return setTimeout(watchIce, 200);
      pc.addEventListener('iceconnectionstatechange', () => { if (pc.iceConnectionState === 'failed' && joining() && collab.host !== conn) blocked(); });
    };
    watchIce();
  });
}

function joinViaLink(link) {
  if (collab.linkTrying || !joining()) return;
  collab.linkTrying = true;
  clearTimeout(collab.joinTimer);
  setJoinState("Direct link blocked, so connecting through the host's backup link...");
  let tries = 0;
  const attempt = () => {
    const ws = new WebSocket(link.replace(/^https:/, 'wss:'));
    const c = socketConn((t) => ws.send(t), () => ws.close());
    let opened = false;
    collab.linkSocket = ws;
    ws.onopen = () => {
      opened = true;
      ws.send(JSON.stringify({ t: 'hello', name: myName(), clientId: collab.clientId }));
      setJoinState('Connected. Waiting for the host to let you in...');
    };
    ws.onmessage = (e) => { const m = c.receive(e.data); if (m) onHostData(c, m); };
    ws.onclose = () => {
      c.open = false;
      if (collab.role === 'guest' && collab.host === c) hostLost();
      else if (!opened && collab.linkTrying && ++tries < 10) setTimeout(attempt, 2500); // a new address takes a few seconds to go live
      else if (joining() && collab.linkTrying) joinFailed('Could not reach the host through the backup link either. Ask them to check Settings > Collaboration on their PC.');
    };
  };
  attempt();
}

// Tells people whether their network allows direct links, and whether a relay is working.
async function networkCheck() {
  const pc = new RTCPeerConnection(iceConfig().config);
  const found = [];
  pc.onicecandidate = (e) => { if (e.candidate) found.push(e.candidate); };
  pc.createDataChannel('check');
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => setTimeout(r, 5000));
  pc.close();
  const outside = found.filter((c) => c.type === 'srflx');
  const relay = found.some((c) => c.type === 'relay');
  // Different outside ports for the same inside port means the router hides each link differently ("strict").
  const byBase = new Map();
  outside.forEach((c) => byBase.set(c.relatedPort, new Set([...(byBase.get(c.relatedPort) || []), c.port])));
  const strict = [...byBase.values()].some((ports) => ports.size > 1);
  const relayNote = settings.turnUrl ? (relay ? ' Your relay server works.' : ' Your relay server did not answer: check its address and login.') : '';
  if (!outside.length) return `Direct links are blocked on this network.${relayNote || ' You need a relay server (below) to write together from here.'}`;
  if (strict) return `This network is strict: direct links often fail.${relayNote || ' Adding a relay server (below) on both PCs fixes it.'}`;
  return `This network is fine for direct links.${relayNote}`;
}

async function onHostData(conn, d) {
  collab.lastHeard = Date.now();
  if (d.t === 'ping') { collab.hostPings = true; return; }
  if (d.t === 'wait') setJoinState('Waiting for the host to let you in...');
  else if (d.t === 'denied') { collab.reconnecting = false; joinFailed('The host did not let you in.'); }
  else if (d.t === 'state') {
    if (joining()) {
      clearTimeout(collab.joinTimer);
      clearTimeout(collab.linkTimer);
      collab.linkTrying = false;
      setJoinState(null);
      if (conn.isLink) collab.peer?.destroy(); // joined through the backup link: the direct attempt is no longer needed
    }
    if (collab.reconnecting) reconnected();
    if (collab.role !== 'guest') {
      const { rootUrl } = await api['collab:guestRoot']();
      $('base').href = rootUrl;
      collab.role = 'guest';
      toast(`Joined ${d.host}'s show`);
      try { localStorage.setItem('lastSession', JSON.stringify({ code: collab.joinCode, host: d.host })); } catch { /* no Rejoin button */ }
    }
    collab.host = conn;
    S = upgrade(d.state);
    collab.snapshot = structuredClone(S);
    collab.perms = d.perms;
    collab.hostName = d.host;
    collab.locks = d.locks || [];
    applyGuestRail();
    if (!ui.view || sectionOf(ui.view) && effective(collab.perms, sectionOf(ui.view)) === 'hidden') go('settings'); else rerender();
    refreshCollabUI();
  } else if (d.t === 'ops' && collab.role === 'guest') applyRemote(d.ops);
  else if (d.t === 'locks') { collab.locks = d.locks; refreshLocks(); }
  else if (d.t === 'recordAsk' && Array.isArray(d.lines)) showRecordAsk({ from: String(d.from || 'The host'), part: String(d.part || ''), lines: d.lines.filter((l) => typeof l?.text === 'string').map((l) => ({ key: String(l.key), who: String(l.who || ''), text: l.text, kind: String(l.kind || 'text') })) });
  else if (d.t === 'takeSaved') {
    const take = rec.takes.find((t) => t.id === d.id);
    if (take) take.saved = d.ok ? true : false;
    if (take && d.ok) forgetTake(take); // safely on the host now
    toast(d.ok ? `Take sent to ${collab.hostName}'s library` : 'The host could not save that take.', !d.ok);
    rec.redraw?.();
  }
  else if (d.t === 'file') {
    if (d.data) await api['file:write'](d.rel, d.data);
    fileArrived(d.rel);
  } else if (d.t === 'end') leaveSession('The host stopped sharing.');
  else if (d.t === 'kicked') leaveSession('The host removed you from the session.');
}

async function leaveSession(message) {
  const wasGuest = collab.role === 'guest';
  collab.role = null;
  collab.peer?.destroy();
  collab.linkSocket?.close();
  if (!wasGuest) return;
  switching = true; // the shared copy must never be saved over your own show
  try { sessionStorage.setItem('afterLeave', message || 'You left the session.'); } catch { /* message only */ }
  await api['collab:leave']();
}

// --- Guest view limits -------------------------------------------------------------------------
const VIEW_SECTION = { show: 'show', writing: 'writing', characters: 'characters', world: 'world', storyboard: 'storyboard', library: 'library', find: 'library', todo: 'todo', production: 'production' };
const sectionOf = (view) => VIEW_SECTION[view];

function applyGuestRail() {
  document.querySelectorAll('.rail-btn').forEach((b) => {
    const sec = sectionOf(b.dataset.view);
    const someItemShared = Object.values(collab.perms?.items || {}).some((v) => v !== 'hidden');
    b.classList.toggle('off', collab.role === 'guest' && !!sec && effective(collab.perms, sec) === 'hidden' && !someItemShared);
    if (collab.role === 'guest' && b.dataset.view === 'find') b.classList.toggle('off', effective(collab.perms, 'library') !== 'edit');
    if (b.dataset.view === 'record') b.classList.remove('off'); // anyone in a session can record and send takes
  });
  $('#livePill')?.classList.toggle('off', !collab.role);
  $('#phoneBtn')?.classList.toggle('off', collab.role === 'guest'); // the phone link serves your own show, not one you are visiting
  if ($('#livePill')) $('#livePill').textContent = collab.role === 'host' ? `Live: ${collab.guests.size}` : collab.role === 'guest' ? 'Joined' : '';
}

function currentItem() {
  if (ui.view === 'writing') return currentEp().ep?.id;
  if (ui.view === 'storyboard') return (S.episodes.find((e) => e.id === ui.boardEp) || S.episodes[0])?.id;
  if (ui.view === 'characters') return ui.page_Characters || S.pages.find((p) => p.kind === 'character' && !p.parent)?.id;
  if (ui.view === 'world') return ui.page_World || S.pages.find((p) => p.kind !== 'character' && !p.parent)?.id;
  return null;
}

// Greys out editing in places a guest may only look at. The host still checks every change.
function applyReadOnly() {
  const main = $('#main');
  const sec = sectionOf(ui.view);
  const ro = collab.role === 'guest' && (collab.reconnecting || (!!sec && effective(collab.perms, sec, currentItem()) !== 'edit'));
  main.classList.toggle('ro', ro);
  if (ro) {
    main.querySelectorAll('input, textarea, select').forEach((el) => { if (!el.closest('.side-search')) el.disabled = true; });
    main.querySelectorAll('.btn, .x, .tree-add, .panel-art').forEach((el) => { el.disabled = true; });
  }
  refreshLocks();
  if (collab.role === 'guest') shareWhere();
  if (collab.role === 'host') drawPresence();
}

// --- Where everyone is ---------------------------------------------------------------------------
// Guests tell the host which section and item they have open; the host sees it in a live bar and
// as coloured dots on those parts and pages, and can click a name to go to the same place.
function whereNow() {
  const section = SECTIONS.find((s) => s[0] === ui.view)?.[1] || (ui.view === 'settings' ? 'Settings' : ui.view || '');
  let detail = '';
  let ep = '';
  let part = '';
  let page = '';
  if (ui.view === 'writing') {
    const c = currentEp();
    ep = c.ep?.id || ''; part = c.part?.id || '';
    detail = c.ep ? `${c.ep.title} / ${c.part?.title || ''}` : '';
  } else if (ui.view === 'storyboard') {
    const e = S.episodes.find((x) => x.id === ui.boardEp) || S.episodes[0];
    ep = e?.id || ''; detail = e?.title || '';
  } else if (ui.view === 'characters' || ui.view === 'world') {
    page = currentItem() || ''; detail = S.pages.find((p) => p.id === page)?.name || '';
  } else if (ui.view === 'record') {
    [ep, part] = (rec.part || '|').split('|');
    const e = S.episodes.find((x) => x.id === ep);
    detail = rec.ask ? `lines from ${rec.ask.part}` : e ? `${e.title} / ${allParts(e).find((p) => p.id === part)?.title || ''}` : '';
  } else if (ui.view === 'settings') detail = ui.settingsTab || '';
  return { view: ui.view || '', label: detail ? `${section}: ${detail}` : section, ep, part, page };
}

function shareWhere() {
  if (!collab.host) return;
  const where = whereNow();
  const key = JSON.stringify(where);
  if (key === collab.lastWhere) return;
  collab.lastWhere = key;
  collab.host.send({ t: 'where', ...where });
}

const presenceColor = (id) => { let n = 0; for (const ch of id) n = (n * 31 + ch.charCodeAt(0)) % 360; return `hsl(${n} 70% 62%)`; };

function followGuest(g) {
  const w = g.where;
  if (!w?.view || !VIEW[w.view]) return;
  if (w.view === 'writing') { ui.ep = w.ep; ui.part = w.part; }
  if (w.view === 'storyboard') ui.boardEp = w.ep;
  if (w.view === 'characters') ui.page_Characters = w.page;
  if (w.view === 'world') ui.page_World = w.page;
  go(w.view);
}

const whereText = (g) => (g.where?.label ? `Now in ${g.where.label}${g.doc ? ' (typing)' : ''}` : 'Just joined');

// Where each person is: shown on their card in Settings > Collaboration (updated in place, so
// the permission controls there are not redrawn), plus dots on the parts and pages they have open.
function drawPresence() {
  const people = collab.role === 'host' ? [...collab.guests.values()] : [];
  for (const g of people) {
    document.querySelectorAll(`[data-where-of="${CSS.escape(g.clientId)}"]`).forEach((el) => {
      if (el.textContent !== whereText(g)) el.textContent = whereText(g);
      el.classList.toggle('typing', !!g.doc);
    });
  }
  // Dots on the parts and pages people have open. Only changed rows are touched, so this cannot loop.
  const at = new Map();
  for (const g of people) {
    const id = g.where?.part || g.where?.page;
    if (id) at.set(id, [...(at.get(id) || []), g]);
  }
  document.querySelectorAll('#main [data-presence-id]').forEach((row) => {
    const here = at.get(row.dataset.presenceId) || [];
    const key = here.map((g) => g.clientId).join();
    if ((row.dataset.pkey || '') === key) return;
    row.dataset.pkey = key;
    row.querySelectorAll('.pdot').forEach((d) => d.remove());
    here.forEach((g) => row.append(h('span', { class: 'pdot', title: `${g.name} is here`, style: `background:${presenceColor(g.clientId)}` })));
  });
}
let roQueued = false;
new MutationObserver(() => {
  if (roQueued || !collab.role) return;
  roQueued = true;
  setTimeout(() => { roQueued = false; applyReadOnly(); }); // a timer, not a frame: frames pause while the window is covered
}).observe(document.getElementById('main'), { childList: true, subtree: true });

// --- Settings > Collaboration ------------------------------------------------------------------
function refreshCollabUI() {
  applyGuestRail();
  if (ui.view === 'settings' && ui.settingsTab === 'Collaboration') redrawSettings?.();
}

function permsEditor(g) {
  const custom = h('div', { class: 'perm-custom' });
  const level = (value, onchange, withDefault) => select([...(withDefault ? [['', 'Default']] : []), ['hidden', 'Hidden'], ['view', 'View only'], ['edit', 'Can edit']], value || '', onchange, { class: `perm-sel perm-${value || 'default'}` });
  const preset = Object.values(g.perms.sections).every((v) => v === 'view') && !Object.keys(g.perms.items).length ? 'view'
    : Object.values(g.perms.sections).every((v) => v === 'edit') && !Object.keys(g.perms.items).length ? 'edit' : 'custom';
  const drawCustom = () => custom.replaceChildren(
    h('div', { class: 'perm-grid' }, SECTION_LIST.map(([k, label]) => [h('span', {}, label), level(g.perms.sections[k], (v) => { g.perms.sections[k] = v; setGuestPerms(g, g.perms); drawCustom(); })])),
    h('h4', { class: 'set-sub' }, 'Specific episodes and pages'),
    h('p', { class: 'muted' }, '"Default" follows the section above. Use these to share just one episode, or hide one character.'),
    h('div', { class: 'perm-grid' },
      S.episodes.map((e) => [h('span', {}, `Episode: ${e.title}`), level(g.perms.items[e.id], (v) => { v ? (g.perms.items[e.id] = v) : delete g.perms.items[e.id]; setGuestPerms(g, g.perms); drawCustom(); }, true)]),
      S.pages.map((p) => [h('span', {}, `${p.kind === 'character' ? 'Character' : 'World'}: ${p.name}`), level(g.perms.items[p.id], (v) => { v ? (g.perms.items[p.id] = v) : delete g.perms.items[p.id]; setGuestPerms(g, g.perms); drawCustom(); }, true)])));
  if (preset === 'custom') drawCustom();
  return h('div', { class: 'guest-card' },
    h('div', { class: 'row between' }, h('b', {}, g.name), h('div', { class: 'row' },
      select([['view', 'View everything'], ['edit', 'Edit everything'], ['custom', 'Custom...']], preset, (v) => {
        if (v === 'custom') { if (!custom.firstChild) drawCustom(); return; }
        setGuestPerms(g, { ...presetPerms(v), canDelete: g.perms.canDelete });
        custom.replaceChildren();
      }, { 'aria-label': `Permissions for ${g.name}` }),
      btn('Remove', () => removeGuest(g), 'danger-text'))),
    h('label', { class: 'row tight delete-perm' }, h('input', { type: 'checkbox', class: 'switch', checked: !!g.perms.canDelete, onchange: (e) => { g.perms.canDelete = e.target.checked; setGuestPerms(g, g.perms); } }),
      h('span', {}, 'Can delete whole episodes, pages, panels and tasks'), h('span', { class: 'muted' }, '(off keeps your work safe: they can still edit what you allow)')),
    h('div', { class: 'row where-row' },
      h('i', { class: 'where-dot', style: `background:${presenceColor(g.clientId)}` }),
      h('span', { class: `muted where-text ${g.doc ? 'typing' : ''}`, 'data-where-of': g.clientId }, whereText(g)),
      btn('Go there', () => followGuest(g))),
    custom);
}

function collabPanel() {
  const name = h('input', { value: settings.myName, placeholder: 'Your name', 'aria-label': 'Your name', onchange: (e) => setSetting('myName', e.target.value.trim().slice(0, 40)) });
  const nameRow = h('div', { class: 'set-row' }, h('div', { class: 'set-text' }, h('div', { class: 'set-label' }, 'Your name'), h('div', { class: 'muted' }, 'Shown to the people you write with.')), name);
  if (collab.role === 'host') {
    const copy = () => {
      const t = h('textarea', { value: collab.code, style: 'position:fixed;opacity:0' });
      document.body.append(t); t.select(); document.execCommand('copy'); t.remove();
      toast('Code copied');
    };
    return h('div', {},
      h('div', { class: 'code-box' }, h('div', { class: 'muted' }, 'Share this code. Your PC is the host: keep Storyroom open while others write.'),
        h('div', { class: 'code' }, collab.code), h('div', { class: 'row' }, btn('Copy code', copy, 'primary'), btn('Stop sharing', async () => { if (await dialogBox({ title: 'Stop sharing?', text: 'Everyone in the session is disconnected.', okText: 'Stop', danger: true })) stopHosting(); }, 'danger-text'))),
      h('div', { class: 'set-row' }, h('div', { class: 'set-text' }, h('div', { class: 'set-label' }, 'Backup link for blocked networks'),
        h('div', { class: `muted ${String(collab.linkState).startsWith('failed') ? 'link-failed' : ''}` }, collab.linkState === 'ready' ? 'Ready. Friends whose network blocks direct links are connected through it automatically (Cloudflare Quick Tunnel).'
          : collab.linkState === 'starting' ? 'Starting...' : String(collab.linkState || '').startsWith('failed') ? `Could not start: ${collab.linkState.slice(8)}` : 'Off. Friends on strict networks will not be able to join.'),
        String(collab.linkState || '').startsWith('failed') && h('button', { class: 'link', type: 'button', onclick: () => api['app:openFolder']('linklog') }, 'Open the link log')),
        h('input', { type: 'checkbox', class: 'switch', checked: settings.backupLink, 'aria-label': 'Backup link', onchange: (e) => {
          setSetting('backupLink', e.target.checked);
          if (e.target.checked) startBackupLink();
          else { api['tunnel:stop'](); collab.tunnelUrl = null; collab.linkState = 'off'; refreshCollabUI(); }
        } })),
      h('div', { class: 'set-row' }, h('div', { class: 'set-text' }, h('div', { class: 'set-label' }, 'Ask before someone joins'), h('div', { class: 'muted' }, 'Recommended. Anyone with the code can ask.')), h('input', { type: 'checkbox', class: 'switch', checked: settings.askJoin, onchange: (e) => setSetting('askJoin', e.target.checked) })),
      h('div', { class: 'set-row' }, h('div', { class: 'set-text' }, h('div', { class: 'set-label' }, 'New people start with'), h('div', { class: 'muted' }, 'You can change each person below.')), select([['view', 'View only'], ['edit', 'Can edit everything']], settings.guestDefault, (v) => setSetting('guestDefault', v))),
      rememberedDevices(),
      h('h3', { class: 'set-sub' }, `People here (${collab.guests.size})`),
      collab.guests.size ? [...collab.guests.values()].map(permsEditor) : h('p', { class: 'muted' }, 'Nobody yet. Send them the code.'),
      h('p', { class: 'muted' }, 'A backup is made when you start sharing and each time someone joins. Settings > Saving & backups > Open backups goes back to any of them.'),
      connectionTools());
  }
  if (collab.role === 'guest') {
    const can = (k) => effective(collab.perms, k);
    return h('div', {},
      h('div', { class: 'code-box' }, h('div', { class: 'set-label' }, `Connected to ${collab.hostName}'s show`),
        h('div', { class: 'muted' }, SECTION_LIST.map(([k, label]) => `${label}: ${{ hidden: 'hidden', view: 'view only', edit: 'can edit' }[can(k)]}`).join(' | ')),
        h('div', { class: 'row' }, btn('Leave session', () => leaveSession('You left the session.'), 'danger-text'))));
  }
  const codeIn = h('input', { class: 'code-input', placeholder: 'ABC123', maxLength: 6, value: collab.lastCode || '', 'aria-label': 'Session code', oninput: (e) => { collab.lastCode = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') joinSession(codeIn.value); } });
  return h('div', {}, nameRow,
    h('div', { class: 'collab-cards' },
      h('div', { class: 'code-box' }, h('div', { class: 'set-label' }, 'Host this show'), h('div', { class: 'muted' }, 'Get a code to send. You choose what each person can see and edit.'), btn('Start sharing', startHosting, 'primary')),
      h('div', { class: 'code-box' }, h('div', { class: 'set-label' }, 'Join someone'), h('div', { class: 'muted' }, 'Type the code they sent you. Your own show is backed up first and is never changed while you visit.'), h('div', { class: 'row' }, codeIn, btn('Join', () => joinSession(codeIn.value), 'primary')),
        lastSession() && btn(`Rejoin ${lastSession().host}'s session (${lastSession().code})`, () => joinSession(lastSession().code)),
        collab.joinState && h('div', { class: `join-state ${collab.joinState.failed ? 'failed' : 'busy'}` }, collab.joinState.text))),
    h('p', { class: 'muted' }, 'Connections go straight between PCs and are encrypted. A free public server (PeerJS) only matches up the code.'),
    connectionTools());
}

// Network test and optional relay server, for networks that block direct links.
function connectionTools() {
  const result = h('div', { class: 'muted' });
  const field = (key, label, type = 'text') => h('label', { class: 'field' }, h('span', {}, label), h('input', { type, value: settings[key] || '', autocomplete: 'off', onchange: (e) => setSetting(key, e.target.value.trim()) }));
  return h('div', {},
    h('h3', { class: 'set-sub' }, 'Connection trouble?'),
    h('div', { class: 'set-row' }, h('div', { class: 'set-text' }, h('div', { class: 'set-label' }, 'Test my connection'), h('div', { class: 'muted' }, 'Run this on both PCs if joining gets stuck.'), result),
      btn('Test', async (e) => { e.target.disabled = true; result.textContent = 'Testing for 5 seconds...'; result.textContent = await networkCheck(); e.target.disabled = false; })),
    h('details', { class: 'relay-box', open: !!settings.turnUrl },
      h('summary', {}, 'Relay server (for networks that block direct links)'),
      h('p', { class: 'muted' }, 'A relay passes the writing through a server when two PCs cannot link directly. Get a free one at metered.ca (Open Relay, 20 GB a month free) or Cloudflare Calls, then paste its TURN address, username and password here on both PCs. It is saved only on this PC.'),
      field('turnUrl', 'TURN address, like turn:global.relay.metered.ca:443'),
      field('turnUser', 'Username'),
      field('turnPass', 'Password', 'password')));
}

// --- Phone link ------------------------------------------------------------------------------
// A private website from this PC for recording and reading on a phone, from anywhere.
const phoneLink = { url: null, state: null };
const redrawPhone = () => { if (ui.view === 'settings' && ui.settingsTab === 'Phone link') redrawSettings?.(); document.querySelector('#phoneBtn')?.classList.toggle('live', !!phoneLink.url); };

async function startPhoneLink() {
  if (phoneLink.state === 'starting') return;
  try {
    if (!(await ensureLinkTool('Your phone reaches this PC over the internet through a private link.'))) return;
    phoneLink.state = 'starting';
    redrawPhone();
    phoneLink.url = await api['phone:start']();
    phoneLink.state = 'ready';
  } catch (err) {
    phoneLink.state = `failed: ${String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`;
  }
  redrawPhone();
}

function stopPhoneLink() {
  api['phone:stop']();
  Object.assign(phoneLink, { url: null, state: null });
  redrawPhone();
}

// Takes uploaded from the phone land in the Voice Takes folder like any other take.
function phoneTakeArrived(info) {
  const folder = settings.recFolder || 'Voice Takes';
  if (!S.library.folders.includes(folder)) S.library.folders.push(folder);
  addToLibrary([{ ...info, source: 'Phone' }], { kind: 'sound', folder });
  refreshLibTitles();
  rec.redraw?.();
  toast(`Phone take saved: ${info.title}`);
  notify('New take from your phone', info.title, () => openLibraryFolder(folder));
}

function openLibraryFolder(folder) {
  ui.lib = { search: '', sort: 'addedAt', dir: -1, picked: new Set(), ...(ui.lib || {}), scope: folder };
  go('library');
}

function phonePanel() {
  if (phoneLink.state === 'ready') {
    const qr = qrcode(0, 'M');
    qr.addData(phoneLink.url);
    qr.make();
    const code = h('div', { class: 'qr' });
    code.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); // generated locally from the link, no outside content
    const copy = () => { const t = h('textarea', { value: phoneLink.url, style: 'position:fixed;opacity:0' }); document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); toast('Link copied'); };
    return h('div', {},
      h('div', { class: 'phone-box' }, code, h('div', { class: 'grow' },
        h('div', { class: 'set-label' }, 'Scan this with your phone camera'),
        h('p', { class: 'muted' }, 'Or send yourself the link. It works anywhere with internet: record takes, pick lines, read the script and pages.'),
        h('div', { class: 'phone-url' }, phoneLink.url),
        h('div', { class: 'row' }, btn('Copy link', copy, 'primary'), btn('Turn off', stopPhoneLink, 'danger-text')))),
      h('p', { class: 'muted' }, 'Keep Storyroom open on this PC. It stops the PC from going to sleep while the link is on (closing a laptop lid can still sleep it). Takes saved on the phone go straight into Library > Voice Takes here.'),
      h('p', { class: 'muted' }, 'Anyone with this link can read your show and send takes, so keep it private. Each time you turn it on you get a new link and the old one stops working.'));
  }
  return h('div', {},
    h('div', { class: 'phone-box' }, h('div', { class: 'grow' },
      h('div', { class: 'set-label' }, 'Record on your phone, from anywhere'),
      h('p', { class: 'muted' }, 'Turns this PC into a private website your phone can open, even at school or a friend\'s house. On the phone: pick a part, tap a line, record (raw, no filters) and save. Takes come straight here.'),
      phoneLink.state === 'starting' ? h('p', {}, 'Starting the link...')
        : btn('Turn on phone link', startPhoneLink, 'primary'),
      String(phoneLink.state || '').startsWith('failed') && [h('p', { class: 'link-failed' }, `Could not start: ${phoneLink.state.slice(8)}`),
        h('button', { class: 'link', type: 'button', onclick: () => api['app:openFolder']('linklog') }, 'Open the link log (send it to me if this keeps happening)')])));
}

// Recording is never read-only: it only sends takes, and the host saves them into its own Voice Takes.

