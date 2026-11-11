'use strict';
// Two text helpers for every editor:
//  - References: hold Ctrl to see names of characters and world pages in blue; Ctrl+click opens
//    that page. Text can also be linked to a page by hand from the toolbar ("Link to page").
//  - Proofread: offline spelling and word-spacing fixes, plus grammar from LanguageTool if chosen.
// Both draw with the CSS Highlight API, so the saved text is never touched.

// --- References --------------------------------------------------------------------------------
let refs = [];
let ctrlTimer = 0;

function refTargets() {
  const map = new Map();
  const ordered = [...S.pages].sort((a, b) => !!a.parent - !!b.parent); // originals win shared names
  for (const p of ordered) {
    for (const n of [p.name, p.name.replace(/\s*\(.*\)\s*$/, '')]) {
      const key = n.trim().toLowerCase();
      if (key.length > 1 && !map.has(key)) map.set(key, p);
    }
  }
  return map;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function showRefs() {
  const targets = refTargets();
  refs = [];
  const names = [...targets.keys()].sort((a, b) => b.length - a.length);
  const pattern = names.length && new RegExp(`(?<![\\p{L}\\p{N}])(${names.map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  for (const ed of document.querySelectorAll('.rte')) {
    ed.querySelectorAll('a[href^="#ref:"]').forEach((a) => {
      const page = S.pages.find((p) => `#ref:${p.id}` === a.getAttribute('href'));
      if (!page) return;
      const range = document.createRange();
      range.selectNodeContents(a);
      refs.push({ range, page });
    });
    if (!pattern) continue;
    const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      for (const m of node.nodeValue.matchAll(pattern)) {
        const range = document.createRange();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        refs.push({ range, page: targets.get(m[0].toLowerCase()) });
      }
    }
  }
  CSS.highlights.set('refs', new Highlight(...refs.map((r) => r.range)));
  document.body.classList.add('ctrl-refs');
}

function hideRefs() {
  clearTimeout(ctrlTimer);
  CSS.highlights.delete('refs');
  document.body.classList.remove('ctrl-refs', 'over-ref');
  refs = [];
}

function refAt(e) {
  const link = e.target.closest?.('a[href^="#ref:"]');
  if (link) return S.pages.find((p) => `#ref:${p.id}` === link.getAttribute('href'));
  const pos = document.caretRangeFromPoint(e.clientX, e.clientY);
  return pos && refs.find((r) => r.range.isPointInRange(pos.startContainer, pos.startOffset) && r.range.toString())?.page;
}

function openPage(page) {
  if (document.fullscreenElement) document.exitFullscreen();
  const view = page.kind === 'character' ? 'characters' : 'world';
  ui[view === 'characters' ? 'page_Characters' : 'page_World'] = page.id;
  hideRefs();
  go(view);
}

// Waits a moment, so Ctrl+B and other shortcuts do not flash every name blue.
addEventListener('keydown', (e) => {
  if (e.key === 'Control' && !e.repeat) ctrlTimer = setTimeout(showRefs, 180);
  else if (e.key !== 'Control') clearTimeout(ctrlTimer);
});
addEventListener('keyup', (e) => { if (e.key === 'Control') hideRefs(); });
addEventListener('blur', hideRefs);
document.addEventListener('mousemove', (e) => {
  if (document.body.classList.contains('ctrl-refs')) document.body.classList.toggle('over-ref', !!(e.target.closest?.('.rte') && refAt(e)));
});
document.addEventListener('mousedown', (e) => {
  if (!e.ctrlKey || !e.target.closest?.('.rte')) return;
  if (!refs.length) showRefs();
  const page = refAt(e);
  if (!page) return;
  e.preventDefault();
  openPage(page);
}, true);

function linkSelectionTo(pageId) {
  restoreSelection();
  if (getSelection().isCollapsed) return toast('Select the words to link first');
  exec('createLink', `#ref:${pageId}`);
}

// --- Proofreading ------------------------------------------------------------------------------
const issues = new WeakMap(); // editor -> [{range, message, replacements}]
const proofTimers = new WeakMap();
const proofMode = () => { try { return localStorage.getItem('proofMode') || 'off'; } catch { return 'off'; } };
let grammarWarned = false;

function setProofMode(mode) {
  try { localStorage.setItem('proofMode', mode); } catch { /* setting just won't stick */ }
  document.querySelectorAll('.rte').forEach((ed) => (mode === 'off' ? issues.delete(ed) : proofread(ed)));
  if (mode === 'off') drawProof();
}

// One string per editor plus a map back to text nodes, so service offsets become DOM ranges.
function textMap(ed) {
  const map = [];
  let text = '';
  let lastBlock = null;
  const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const block = currentBlockOf(node, ed);
    if (lastBlock && block !== lastBlock) text += '\n';
    lastBlock = block;
    map.push({ start: text.length, node });
    text += node.nodeValue;
  }
  return { text, map };
}
const currentBlockOf = (node, ed) => { while (node.parentNode && node.parentNode !== ed) node = node.parentNode; return node; };

function rangeFor(map, start, end) {
  const find = (offset) => {
    for (let i = map.length - 1; i >= 0; i--) if (map[i].start <= offset) return map[i];
    return null;
  };
  const a = find(start);
  const b = find(end);
  if (!a || !b || start - a.start > a.node.length || end - b.start > b.node.length) return null;
  const range = document.createRange();
  range.setStart(a.node, start - a.start);
  range.setEnd(b.node, end - b.start);
  return range;
}

// Rejoins and re-splits misspelled neighbours: "stupiddog" or "stu piddog" -> "stupid dog".
// Every way to cut a joined string into 2 or 3 pieces (short strings only).
function splits(joined) {
  const out = [];
  if (joined.length > 24) return out;
  for (let i = 1; i < joined.length; i++) {
    out.push([joined.slice(0, i), joined.slice(i)]);
    for (let j = i + 1; j < joined.length; j++) out.push([joined.slice(0, i), joined.slice(i, j), joined.slice(j)]);
  }
  return out;
}
// Longer real words beat short ones: "stupid dog" (36+9) wins over "pi d dog".
const splitScore = (parts) => parts.reduce((n, p) => n + p.length * p.length, 0) - parts.length * 4;
function respace(joined, isWord) {
  let best = null;
  for (const parts of splits(joined)) {
    if (parts.every(isWord) && (!best || splitScore(parts) > best.score)) best = { text: parts.join(' '), score: splitScore(parts) };
  }
  return best;
}

// Words come from a built-in list of about 60,000 common English words (SCOWL).
async function spacingIssues(text) {
  const names = new Set([...refTargets().keys()]);
  const words = [...text.matchAll(/[\p{L}']+/gu)].map((m) => ({ w: m[0], start: m.index, end: m.index + m[0].length }));
  const lookup = async (list) => {
    const uniq = [...new Set(list.map((w) => w.toLowerCase()))];
    const answers = await api['words:known'](uniq);
    return new Set(uniq.filter((_, i) => answers[i]));
  };
  const known = await lookup(words.map((x) => x.w));
  // Capitalised words are usually names, so they are left alone.
  const unknown = (x) => !known.has(x.w.toLowerCase()) && !names.has(x.w.toLowerCase()) && x.w === x.w.toLowerCase();
  const adjacent = (a, b) => /^[ \t]+$/.test(text.slice(a.end, b.start));
  const plans = [];
  words.forEach((cur, i) => {
    if (!unknown(cur)) return;
    const windows = [[cur]];
    if (words[i + 1] && adjacent(cur, words[i + 1])) windows.push([cur, words[i + 1]]);
    if (words[i - 1] && adjacent(words[i - 1], cur)) windows.push([words[i - 1], cur]);
    plans.push(windows);
  });
  const pieces = await lookup(plans.flat().flatMap((win) => splits(win.map((x) => x.w).join('').toLowerCase()).flat()));
  const isWord = (p) => (p.length > 1 || /^[ai]$/i.test(p)) && pieces.has(p.toLowerCase());
  const out = [];
  for (const windows of plans) {
    const best = windows.map((win) => ({ win, fix: respace(win.map((x) => x.w).join(''), isWord) }))
      .filter((c) => c.fix && c.fix.text !== c.win.map((x) => x.w).join(' '))
      .sort((a, b) => a.win.length - b.win.length || b.fix.score - a.fix.score)[0]; // fewest words touched wins
    if (best && !out.some((o) => o.start === best.win[0].start)) out.push({ start: best.win[0].start, end: best.win.at(-1).end, message: 'Spacing looks off', replacements: [best.fix.text] });
  }
  return out;
}

async function proofread(ed) {
  const mode = proofMode();
  if (mode === 'off' || !ed.isConnected) return;
  const { text, map } = textMap(ed);
  const found = await spacingIssues(text);
  if (mode === 'grammar' && text.trim()) {
    try {
      const matches = await api['grammar:check'](text.slice(0, 20000));
      found.push(...matches.map((m) => ({ start: m.offset, end: m.offset + m.length, message: m.message, replacements: m.replacements })));
    } catch (err) {
      if (!grammarWarned) toast(String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
      grammarWarned = true;
    }
  }
  if (textMap(ed).text !== text) return; // typed meanwhile; the next pause checks again
  issues.set(ed, found.map((f) => ({ ...f, range: rangeFor(map, f.start, f.end) })).filter((f) => f.range));
  drawProof();
}

function drawProof() {
  const ranges = [...document.querySelectorAll('.rte')].flatMap((ed) => (issues.get(ed) || []).map((i) => i.range));
  CSS.highlights.set('proof', new Highlight(...ranges));
}

function proofSoon(ed) {
  if (proofMode() === 'off') return;
  clearTimeout(proofTimers.get(ed));
  proofTimers.set(ed, setTimeout(() => proofread(ed), 2500));
}

function closeProofMenu() { $('.proof-menu')?.remove(); }
document.addEventListener('mousedown', (e) => { if (!e.target.closest?.('.proof-menu')) closeProofMenu(); });
document.addEventListener('contextmenu', (e) => {
  const ed = e.target.closest?.('.rte');
  const pos = ed && document.caretRangeFromPoint(e.clientX, e.clientY);
  const hit = pos && (issues.get(ed) || []).find((i) => i.range.toString() && i.range.isPointInRange(pos.startContainer, pos.startOffset));
  if (!hit) return; // the normal spelling menu handles everything else
  e.preventDefault();
  closeProofMenu();
  const fix = (value) => {
    closeProofMenu();
    activeEd = ed;
    savedRange = hit.range.cloneRange();
    exec('insertText', value);
    issues.set(ed, issues.get(ed).filter((i) => i !== hit));
    drawProof();
    proofSoon(ed);
  };
  const menu = h('div', { class: 'proof-menu', role: 'menu', style: `left:${Math.min(e.clientX, innerWidth - 280)}px;top:${Math.min(e.clientY, innerHeight - 220)}px` },
    h('div', { class: 'proof-msg' }, hit.message),
    hit.replacements.length ? hit.replacements.map((r) => h('button', { type: 'button', role: 'menuitem', onclick: () => fix(r) }, r)) : h('div', { class: 'muted' }, 'No suggestions'),
    h('button', { type: 'button', role: 'menuitem', class: 'ignore', onclick: () => { issues.set(ed, issues.get(ed).filter((i) => i !== hit)); drawProof(); closeProofMenu(); } }, 'Ignore'));
  document.body.append(menu);
}, true);
