'use strict';
// Rich text editor. contenteditable + execCommand is deprecated on paper, but it is what Chromium
// ships and it keeps native undo and paste without a heavy editor dependency.
let fontList = ['Arial', 'Calibri', 'Cambria', 'Comic Sans MS', 'Consolas', 'Courier New', 'Georgia', 'Impact', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'];
window.queryLocalFonts?.().then((fonts) => {
  const names = [...new Set(fonts.map((f) => f.family))].sort();
  if (names.length) fontList = names;
}).catch(() => {});

const live = []; // editors currently on screen
let activeEd = null;
let savedRange = null;
let liveBar = null;

const commitEditors = () => live.forEach((e) => e.commit());
function closeEditors() {
  commitEditors();
  live.length = 0;
  activeEd = savedRange = liveBar = null;
}

document.addEventListener('selectionchange', () => {
  const sel = getSelection();
  if (!sel.rangeCount) return;
  const node = sel.anchorNode;
  const ed = (node?.nodeType === 1 ? node : node?.parentElement)?.closest('.rte');
  if (!ed) return;
  activeEd = ed;
  savedRange = sel.getRangeAt(0).cloneRange();
  liveBar?.sync();
});

function restoreSelection() {
  if (!activeEd) activeEd = live[0]?.el;
  activeEd.focus();
  if (savedRange) { const s = getSelection(); s.removeAllRanges(); s.addRange(savedRange); }
}
const changed = () => activeEd?.dispatchEvent(new Event('input', { bubbles: true }));

function exec(name, value) {
  restoreSelection();
  document.execCommand('styleWithCSS', false, true);
  document.execCommand(name, false, value);
  changed();
}

// execCommand only knows sizes 1-7, so mark the text with size 7 and swap that for exact pixels.
function setFontSize(px) {
  restoreSelection();
  document.execCommand('styleWithCSS', false, false);
  const sel = getSelection();
  if (sel.isCollapsed) {
    document.execCommand('insertHTML', false, '<font size="7">​</font>');
    const f = activeEd.querySelector('font[size="7"]');
    f.removeAttribute('size');
    f.style.fontSize = `${px}px`;
    const r = document.createRange();
    r.selectNodeContents(f);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  } else {
    document.execCommand('fontSize', false, '7');
    activeEd.querySelectorAll('font[size="7"]').forEach((f) => {
      f.removeAttribute('size');
      f.style.fontSize = `${px}px`;
      f.querySelectorAll('[style*="font-size"]').forEach((c) => { c.style.fontSize = ''; });
    });
  }
  changed();
}

function selectedBlocks() {
  restoreSelection();
  const blocks = [...activeEd.children].filter((b) => savedRange.intersectsNode(b));
  return blocks.length ? blocks : [...activeEd.children].slice(0, 1);
}

// shortcut: DOM edits skip the native undo stack, so letter spacing cannot be undone with Ctrl+Z; pick another value to change it.
function setLetterSpacing(value) {
  const blocks = selectedBlocks();
  const { startContainer, startOffset, endContainer, endOffset, collapsed, commonAncestorContainer: top } = savedRange;
  if (blocks.length > 1 || collapsed) {
    blocks.forEach((b) => { b.style.letterSpacing = value; });
    return changed();
  }
  const walker = document.createTreeWalker(top.nodeType === 3 ? top.parentNode : top, NodeFilter.SHOW_TEXT);
  const texts = [];
  while (walker.nextNode()) if (savedRange.intersectsNode(walker.currentNode)) texts.push(walker.currentNode);
  const spans = texts.flatMap((node) => {
    const from = node === startContainer ? startOffset : 0;
    const to = node === endContainer ? endOffset : node.length;
    if (from >= to) return [];
    const target = from > 0 ? node.splitText(from) : node;
    if (to - from < target.length) target.splitText(to - from);
    const span = h('span', { style: `letter-spacing:${value}` });
    target.replaceWith(span);
    span.append(target);
    return [span];
  });
  if (spans.length) {
    savedRange = document.createRange();
    savedRange.setStartBefore(spans[0]);
    savedRange.setEndAfter(spans.at(-1));
    restoreSelection();
  }
  changed();
}

function setBlockStyle(value) {
  const [kind, name] = value.split(':');
  exec('formatBlock', kind === 'tag' ? name : 'p');
  // formatBlock can replace nodes, so re-read the selection before tagging blocks.
  savedRange = getSelection().getRangeAt(0).cloneRange();
  selectedBlocks().forEach((b) => { b.className = kind === 'script' ? name : ''; });
  changed();
}

function changeCase(mode) {
  restoreSelection();
  const text = getSelection().toString();
  if (!text) return toast('Select some text first');
  const out = mode === 'upper' ? text.toUpperCase() : mode === 'lower' ? text.toLowerCase() : text.toLowerCase().replace(/(^|[\s(\-"])(\p{L})/gu, (_m, a, b) => a + b.toUpperCase());
  document.execCommand('insertText', false, out);
  changed();
}

// Whole-window writing. The app itself goes fullscreen (not just the editor) so dialogs and toasts still show.
function toggleFullscreen(editor) {
  if (editor.classList.toggle('focus')) document.documentElement.requestFullscreen().catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen();
}
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) $('.editor.focus')?.classList.remove('focus');
});

const SCRIPT_NEXT = { scene: 'action', action: 'action', char: 'dlg', paren: 'dlg', dlg: 'action', trans: 'scene' };
const SCRIPT_CYCLE = ['action', 'char', 'dlg', 'paren', 'trans', 'scene'];
const currentBlock = (ed) => {
  let n = getSelection().anchorNode;
  while (n && n.parentNode !== ed) n = n.parentNode;
  return n?.nodeType === 1 ? n : null;
};

function replaceAll(ed, find, repl) {
  const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
  let count = 0;
  while (walker.nextNode()) {
    const parts = walker.currentNode.nodeValue.split(find);
    if (parts.length > 1) { count += parts.length - 1; walker.currentNode.nodeValue = parts.join(repl); }
  }
  return count;
}

const STYLES = [['tag:p', 'Normal'], ['tag:h1', 'Title'], ['tag:h2', 'Heading'], ['tag:h3', 'Subheading'], ['tag:blockquote', 'Quote'],
  ['script:scene', 'Script: Scene heading'], ['script:action', 'Script: Action'], ['script:char', 'Script: Character'], ['script:paren', 'Script: Parenthetical'], ['script:dlg', 'Script: Dialogue'], ['script:trans', 'Script: Transition']];

function makeToolbar(getEd) {
  const tool = (label, title, fn, cls = '') => h('button', { type: 'button', class: `tool ${cls}`, title, 'aria-label': title, onmousedown: (e) => e.preventDefault(), onclick: fn }, label);
  const toggles = {};
  const toggle = (cmd, label, title, cls) => (toggles[cmd] = tool(label, title, () => { exec(cmd); bar.sync(); }, cls));
  const sep = () => h('span', { class: 'sep' });

  const style = select(STYLES, 'tag:p', setBlockStyle, { title: 'Paragraph style', 'aria-label': 'Paragraph style', class: 'tb-select style' });
  const font = select([['', 'Font'], ...fontList.map((f) => [f, f])], '', (v) => { if (v) exec('fontName', v); }, { title: 'Font', 'aria-label': 'Font', class: 'tb-select font' });
  const size = h('input', { type: 'number', min: 6, max: 200, value: 16, class: 'tb-size', title: 'Font size', 'aria-label': 'Font size', onchange: (e) => setFontSize(+e.target.value || 16) });
  const bump = (d) => { size.value = Math.max(6, +size.value + d); setFontSize(+size.value); };
  const colorIn = (title, label, fn, value) => h('label', { class: 'tool color', title }, label, h('input', { type: 'color', value, 'aria-label': title, onchange: (e) => fn(e.target.value) }));
  const blockSel = (label, options, apply) => select([['', label], ...options], '', (v) => { if (v) { selectedBlocks().forEach((b) => apply(b, v)); changed(); bar.querySelectorAll('select.reset').forEach((s) => { s.value = ''; }); } }, { class: 'tb-select reset', title: label, 'aria-label': label });
  const charSel = select([['', 'Insert name'], ...S.pages.filter((p) => p.kind === 'character').map((p) => [p.name, p.name])], '', (v) => { if (v) { exec('insertText', v); charSel.value = ''; } }, { class: 'tb-select', title: 'Insert a character name', 'aria-label': 'Insert a character name' });

  const linkSel = select([['', 'Link to page'], ...S.pages.map((p) => [p.id, p.name]), ['-', 'Remove link']], '', (v) => {
    if (v === '-') exec('unlink');
    else if (v) linkSelectionTo(v);
    linkSel.value = '';
  }, { class: 'tb-select', title: 'Link the selected words to a character or world page (Ctrl+click opens it)', 'aria-label': 'Link to page' });
  const proofSel = select([['off', 'Proofread: off'], ['local', 'Proofread: spelling + spacing'], ['grammar', 'Proofread: + grammar']], proofMode(), async (v) => {
    if (v === 'grammar' && proofMode() !== 'grammar') {
      const ok = await dialogBox({ title: 'Use online grammar checking?', text: 'Grammar checks send the text you are proofreading to LanguageTool (languagetool.org). Spelling and spacing fixes stay on this PC.', okText: 'Use LanguageTool' });
      if (!ok) { proofSel.value = proofMode(); return; }
    }
    setProofMode(v);
  }, { class: 'tb-select proof-sel', title: 'Wavy blue lines mark fixes. Right-click one to fix it.', 'aria-label': 'Proofread' });

  const findIn = h('input', { placeholder: 'Find', 'aria-label': 'Find' });
  const replIn = h('input', { placeholder: 'Replace with', 'aria-label': 'Replace with' });
  const findRow = h('div', { class: 'toolbar find-row off' }, findIn, replIn,
    btn('Next', () => { window.find(findIn.value, false, false, true) || toast('Not found'); }),
    btn('Replace all', () => { const n = replaceAll(getEd(), findIn.value, replIn.value); getEd().dispatchEvent(new Event('input', { bubbles: true })); toast(`Replaced ${n}`); }));

  const bar = h('div', { class: 'toolbars' }, h('div', { class: 'toolbar' },
    tool('Undo', 'Undo (Ctrl+Z)', () => exec('undo'), 'text'), tool('Redo', 'Redo (Ctrl+Y)', () => exec('redo'), 'text'), sep(),
    style, font, tool('-', 'Smaller', () => bump(-1)), size, tool('+', 'Bigger', () => bump(1)), sep(),
    toggle('bold', 'B', 'Bold (Ctrl+B)', 'b'), toggle('italic', 'I', 'Italic (Ctrl+I)', 'i'), toggle('underline', 'U', 'Underline (Ctrl+U)', 'u'), toggle('strikeThrough', 'S', 'Strikethrough', 's'),
    toggle('superscript', 'x²', 'Superscript'), toggle('subscript', 'x₂', 'Subscript'), sep(),
    colorIn('Text color', 'A', (v) => exec('foreColor', v), '#c8321e'), colorIn('Highlight color', 'H', (v) => exec('hiliteColor', v), '#ffe066'),
    tool('No H', 'Remove highlight', () => exec('hiliteColor', 'transparent'), 'text'), sep(),
    toggle('justifyLeft', 'Left', 'Align left', 'text'), toggle('justifyCenter', 'Center', 'Align center', 'text'), toggle('justifyRight', 'Right', 'Align right', 'text'), toggle('justifyFull', 'Justify', 'Justify', 'text'), sep(),
    toggle('insertUnorderedList', 'Bullets', 'Bullet list', 'text'), toggle('insertOrderedList', 'Numbers', 'Numbered list', 'text'), tool('Indent', 'Indent', () => exec('indent'), 'text'), tool('Outdent', 'Outdent', () => exec('outdent'), 'text'), sep(),
    blockSel('Line spacing', ['1', '1.15', '1.5', '2', '2.5', '3'].map((v) => [v, v]), (b, v) => { b.style.lineHeight = v; }),
    blockSel('Paragraph gap', [['0', 'None'], ['.5em', 'Small'], ['1em', 'Medium'], ['2em', 'Large']], (b, v) => { b.style.marginBottom = v; }),
    select([['', 'Letter spacing'], ['-.5px', 'Tight'], ['normal', 'Normal'], ['1px', 'Wide'], ['3px', 'Wider'], ['6px', 'Widest']], '', (v) => { if (v) setLetterSpacing(v); }, { class: 'tb-select', title: 'Letter spacing', 'aria-label': 'Letter spacing' }),
    select([['', 'Change case'], ['upper', 'UPPERCASE'], ['lower', 'lowercase'], ['title', 'Title Case']], '', (v) => { if (v) changeCase(v); }, { class: 'tb-select', title: 'Change case', 'aria-label': 'Change case' }), sep(),
    charSel, linkSel, proofSel,
    tool('Image', 'Insert image', async () => { const rel = await api['image:pick'](); if (rel) exec('insertImage', url(rel)); }, 'text'),
    tool('Table', 'Insert table', () => exec('insertHTML', `<table>${'<tr><td><br></td><td><br></td><td><br></td></tr>'.repeat(3)}</table><p><br></p>`), 'text'),
    tool('Line', 'Insert divider', () => exec('insertHorizontalRule'), 'text'),
    tool('Clear', 'Clear formatting', () => exec('removeFormat'), 'text'),
    tool('Find', 'Find and replace', () => { findRow.classList.toggle('off'); findIn.focus(); }, 'text'), sep(),
    tool('Fullscreen', 'Fullscreen writing (Esc to leave)', () => toggleFullscreen(bar.closest('.editor')), 'text fs')), findRow);

  bar.sync = () => {
    for (const [cmd, el] of Object.entries(toggles)) el.classList.toggle('on', document.queryCommandState(cmd));
    const block = currentBlock(activeEd);
    if (block) style.value = block.classList.length && SCRIPT_NEXT[block.className] ? `script:${block.className}` : (STYLES.some(([v]) => v === `tag:${block.tagName.toLowerCase()}`) ? `tag:${block.tagName.toLowerCase()}` : 'tag:p');
    const node = getSelection().anchorNode;
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    if (!el) return;
    const css = getComputedStyle(el);
    if (document.activeElement !== size) size.value = Math.round(parseFloat(css.fontSize));
    const family = css.fontFamily.split(',')[0].replace(/["']/g, '');
    font.value = fontList.includes(family) ? family : '';
  };
  return bar;
}

// Floating controls that appear when an inserted image is clicked.
function imageTools(paper, ed) {
  let current = null;
  const set = (fn) => () => { fn(current); ed.dispatchEvent(new Event('input', { bubbles: true })); place(); };
  const float = (v) => (img) => { img.style.float = v; img.style.margin = v === 'none' ? '' : v === 'left' ? '0 1em .5em 0' : '0 0 .5em 1em'; };
  const box = h('div', { class: 'imgtools off' },
    [25, 50, 75, 100].map((w) => btn(`${w}%`, set((img) => { img.style.width = `${w}%`; }))),
    btn('Left', set(float('left'))), btn('Center', set((img) => { float('none')(img); img.style.display = 'block'; img.style.margin = '0 auto'; })), btn('Right', set(float('right'))),
    btn('Delete', () => { current.remove(); box.classList.add('off'); ed.dispatchEvent(new Event('input', { bubbles: true })); }, 'danger'));
  const place = () => {
    const a = current.getBoundingClientRect();
    const b = paper.getBoundingClientRect();
    box.style.left = `${Math.max(0, a.left - b.left)}px`;
    box.style.top = `${a.top - b.top + paper.scrollTop + 6}px`;
  };
  ed.addEventListener('click', (e) => {
    if (e.target.tagName === 'IMG') { current = e.target; box.classList.remove('off'); place(); } else box.classList.add('off');
  });
  return box;
}

function makeEditor(obj, key, { onInput, placeholder, tall } = {}) {
  const ed = h('div', { class: 'rte', contentEditable: 'true', spellcheck: true, role: 'textbox', 'aria-multiline': 'true', 'data-placeholder': placeholder || '' });
  ed.innerHTML = obj[key] || '<p><br></p>';
  const commit = () => { if (obj[key] !== ed.innerHTML) obj[key] = ed.innerHTML; };
  live.push({ el: ed, commit });
  document.execCommand('defaultParagraphSeparator', false, 'p');

  ed.addEventListener('input', () => {
    ed.classList.toggle('empty', !ed.textContent.trim() && !ed.querySelector('img,table,hr'));
    touch();
    onInput?.(ed);
    proofSoon(ed);
  });
  setTimeout(() => proofread(ed), 300);
  ed.classList.toggle('empty', !ed.textContent.trim() && !ed.querySelector('img,table,hr'));

  ed.addEventListener('keydown', (e) => {
    const block = currentBlock(ed);
    const scriptClass = block && SCRIPT_NEXT[block.className] ? block.className : null;
    if (e.key === 'Enter' && !e.shiftKey && scriptClass) {
      setTimeout(() => { const b = currentBlock(ed); if (b) { b.className = SCRIPT_NEXT[scriptClass]; changed(); } });
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (scriptClass && block) {
        block.className = SCRIPT_CYCLE[(SCRIPT_CYCLE.indexOf(scriptClass) + (e.shiftKey ? 5 : 1)) % 6];
        changed();
        liveBar?.sync();
      } else exec(e.shiftKey ? 'outdent' : 'indent');
    }
  });

  liveBar = makeToolbar(() => ed);
  const paper = h('div', { class: `paper-wrap ${tall ? 'tall' : ''}` }, h('div', { class: 'paper' }, ed));
  paper.firstChild.append(imageTools(paper.firstChild, ed));
  return h('div', { class: `editor ${tall ? 'tall' : ''}` }, liveBar, paper);
}
