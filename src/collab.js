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
  role: null, peer: null, code: '', guests: new Map(), known: new Map(), banned: new Set(), host: null, hostName: '', perms: null,
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
  clearTimeout(collab.timer);
  collab.timer = setTimeout(() => {
    commitEditors();
    const ops = diff(collab.snapshot, S);
    collab.snapshot = structuredClone(S);
    if (!ops.length) return;
    if (collab.role === 'host') relay(ops, null);
    else collab.host?.send({ t: 'ops', ops });
  }, 250);
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
  rerenderSoon();
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
  });
  peer.on('error', (e) => {
    if (e.type === 'unavailable-id') { peer.destroy(); startHosting(); return; }
    toast(`Sharing problem: ${e.message}`, true);
  });
  peer.on('disconnected', () => { if (collab.role === 'host' && !peer.destroyed) peer.reconnect(); }); // keeps the code reachable
  peer.on('connection', (conn) => conn.on('open', () => admit(conn)));
}

async function admit(conn) {
  const { name, clientId } = conn.metadata || {};
  const who = String(name || 'Guest').slice(0, 40);
  if (!clientId || collab.banned.has(clientId)) return conn.close();
  if (settings.askJoin && !collab.known.has(clientId)) {
    conn.send({ t: 'wait' });
    const ok = await dialogBox({ title: `${who} wants to join`, text: 'They will see and edit only what their permissions allow. You can change that any time in Settings > Collaboration.', okText: 'Let them in' });
    if (!ok || !conn.open) { conn.send({ t: 'denied' }); setTimeout(() => conn.close(), 300); return; }
  }
  const g = { conn, name: who, clientId, perms: collab.known.get(clientId) || presetPerms(settings.guestDefault), doc: null };
  collab.known.set(clientId, g.perms);
  api['backup:now'](); // a restore point from before this person changed anything
  collab.guests.get(clientId)?.conn.close();
  collab.guests.set(clientId, g);
  sendState(g);
  conn.on('data', (d) => onGuestData(g, d));
  conn.on('close', () => {
    if (collab.guests.get(clientId) !== g) return;
    collab.guests.delete(clientId);
    toast(`${who} left`);
    shareLocks();
    refreshCollabUI();
  });
  toast(`${who} joined`);
  refreshCollabUI();
}

function sendState(g) {
  g.conn.send({ t: 'state', state: visibleState(g.perms), perms: g.perms, host: myName(), locks: collab.locks });
}

async function onGuestData(g, d) {
  if (d.t === 'ops' && Array.isArray(d.ops)) {
    // Deleting whole episodes, pages, panels or tasks needs its own permission (off unless the host turns it on).
    const ok = d.ops.filter((op) => Array.isArray(op?.p) && opLevel(g.perms, op, S) === 'edit' && (!isDeletion(op) || g.perms.canDelete));
    if (ok.length) { applyRemote(ok); relay(ok, g); }
    if (ok.length !== d.ops.length) sendState(g); // undo what they were not allowed to change
  } else if (d.t === 'focus') {
    g.doc = typeof d.doc === 'string' ? d.doc : null;
    shareLocks();
  } else if (d.t === 'getFile' && sharedPath(d.rel)) {
    g.conn.send({ t: 'file', rel: d.rel, data: await api['file:read'](d.rel) });
  } else if (d.t === 'putFile' && sharedPath(d.rel) && JSON.stringify(g.perms).includes('"edit"')) {
    await api['file:write'](d.rel, d.data);
  }
}

function setGuestPerms(g, perms) {
  g.perms = perms;
  collab.known.set(g.clientId, perms);
  sendState(g);
}

function stopHosting() {
  for (const g of collab.guests.values()) { g.conn.send({ t: 'end' }); }
  setTimeout(() => collab.peer?.destroy(), 300);
  Object.assign(collab, { role: null, code: '', snapshot: null, locks: [] });
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

function joinFailed(text) {
  clearTimeout(collab.joinTimer);
  collab.peer?.destroy();
  collab.peer = null;
  setJoinState(text, true);
  toast(text.split('. ')[0], true);
}

async function joinSession(rawCode) {
  const code = rawCode.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return toast('Codes are 6 letters and numbers', true);
  if (!settings.myName) return toast('Type your name first', true);
  saveNow();
  await api['backup:now'](); // your own show gets a restore point before you visit someone else's
  collab.peer?.destroy();
  const peer = new Peer(undefined, iceConfig());
  collab.peer = peer;
  setJoinState('Finding the session...');
  clearTimeout(collab.joinTimer);
  collab.joinTimer = setTimeout(() => { if (collab.role !== 'guest' && collab.joinState?.text !== 'Waiting for the host to let you in...') joinFailed(BLOCKED_HELP); }, 25000);
  peer.on('error', (e) => joinFailed(e.type === 'peer-unavailable' ? 'No session with that code is open right now. Check the code, and that the host still has sharing on.'
    : e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error' ? 'Could not reach the matchmaking server. Check your internet connection.' : `Could not connect: ${e.message}`));
  peer.on('open', () => {
    const conn = peer.connect(PEER_PREFIX + code, { reliable: true, metadata: { name: myName(), clientId: collab.clientId } });
    setJoinState('Reaching their PC...');
    conn.on('open', () => setJoinState('Connected. Waiting for the host to let you in...'));
    conn.on('data', (d) => onHostData(conn, d));
    conn.on('close', () => { if (collab.role === 'guest') leaveSession('The session ended.'); });
    conn.on('error', () => joinFailed(BLOCKED_HELP));
    // PeerJS creates the link a moment after connect(); a failed direct link shows up here quickly.
    const watchIce = () => {
      const pc = conn.peerConnection;
      if (!pc) return setTimeout(watchIce, 200);
      pc.addEventListener('iceconnectionstatechange', () => { if (pc.iceConnectionState === 'failed' && collab.role !== 'guest') joinFailed(BLOCKED_HELP); });
    };
    watchIce();
  });
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
  if (d.t === 'wait') setJoinState('Waiting for the host to let you in...');
  else if (d.t === 'denied') { joinFailed('The host did not let you in.'); }
  else if (d.t === 'state') {
    if (collab.role !== 'guest') {
      clearTimeout(collab.joinTimer);
      setJoinState(null);
      const { rootUrl } = await api['collab:guestRoot']();
      $('base').href = rootUrl;
      collab.role = 'guest';
      collab.host = conn;
      toast(`Joined ${d.host}'s show`);
    }
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
  if (!wasGuest) return;
  switching = true; // the shared copy must never be saved over your own show
  try { sessionStorage.setItem('afterLeave', message || 'You left the session.'); } catch { /* message only */ }
  await api['collab:leave']();
}

// --- Guest view limits -------------------------------------------------------------------------
const VIEW_SECTION = { show: 'show', writing: 'writing', characters: 'characters', world: 'world', storyboard: 'storyboard', library: 'library', find: 'library', record: 'library', todo: 'todo', production: 'production' };
const sectionOf = (view) => VIEW_SECTION[view];

function applyGuestRail() {
  document.querySelectorAll('.rail-btn').forEach((b) => {
    const sec = sectionOf(b.dataset.view);
    const someItemShared = Object.values(collab.perms?.items || {}).some((v) => v !== 'hidden');
    b.classList.toggle('off', collab.role === 'guest' && !!sec && effective(collab.perms, sec) === 'hidden' && !someItemShared);
    if (collab.role === 'guest' && ['find', 'record'].includes(b.dataset.view)) b.classList.toggle('off', effective(collab.perms, 'library') !== 'edit');
  });
  $('#livePill')?.classList.toggle('off', !collab.role);
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
  const ro = collab.role === 'guest' && !!sec && effective(collab.perms, sec, currentItem()) !== 'edit';
  main.classList.toggle('ro', ro);
  if (ro) {
    main.querySelectorAll('input, textarea, select').forEach((el) => { if (!el.closest('.side-search')) el.disabled = true; });
    main.querySelectorAll('.btn, .x, .tree-add, .panel-art').forEach((el) => { el.disabled = true; });
  }
  refreshLocks();
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
    g.doc && h('div', { class: 'muted' }, 'Writing right now'),
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
      h('div', { class: 'set-row' }, h('div', { class: 'set-text' }, h('div', { class: 'set-label' }, 'Ask before someone joins'), h('div', { class: 'muted' }, 'Recommended. Anyone with the code can ask.')), h('input', { type: 'checkbox', class: 'switch', checked: settings.askJoin, onchange: (e) => setSetting('askJoin', e.target.checked) })),
      h('div', { class: 'set-row' }, h('div', { class: 'set-text' }, h('div', { class: 'set-label' }, 'New people start with'), h('div', { class: 'muted' }, 'You can change each person below.')), select([['view', 'View only'], ['edit', 'Can edit everything']], settings.guestDefault, (v) => setSetting('guestDefault', v))),
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
