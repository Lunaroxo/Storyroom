'use strict';
// App-wide settings (not per show). Stored in this PC's app data; main-process ones are pushed over IPC.
const SETTINGS_DEFAULTS = {
  theme: 'cozy', accent: '', zoom: '1', waves: 'on', motion: true, glass: true,
  paper: 'cream', docFont: '', docSize: '12', pageWidth: 'normal', spellcheck: true, proofMode: 'off', refs: true, wordCount: true,
  backupEvery: '2', backupKeepDays: '2',
  addFolder: '', disabledSources: [],
  recFolder: 'Voice Takes', recBits: '24', micDevice: '', outputDevice: '',
  autoUpdate: true,
  myName: '', askJoin: true, guestDefault: 'view', turnUrl: '', turnUser: '', turnPass: '',
  customTheme: null, // set from a preset the first time Custom is picked
};

// The colors behind each preset, so Custom can start from any of them.
const THEME_COLORS = {
  cozy: { bg: '#17181c', panel: '#1f2026', panel2: '#272930', line: '#33353e', text: '#ece9e2', muted: '#a0a2ab', accent: '#f0a94b', paper: '#fbf8f1' },
  midnight: { bg: '#11151f', panel: '#182033', panel2: '#202a40', line: '#2c3852', text: '#e6ebf5', muted: '#98a3b9', accent: '#6ea8fe', paper: '#fbf8f1' },
  forest: { bg: '#141a16', panel: '#1b241e', panel2: '#232f27', line: '#304036', text: '#e5ede6', muted: '#9aab9e', accent: '#8fcf7a', paper: '#fbf8f1' },
  plum: { bg: '#1a1520', panel: '#241d2c', panel2: '#2d2537', line: '#3c3149', text: '#efe6f3', muted: '#ab9db7', accent: '#e58fc3', paper: '#fbf8f1' },
  paper: { bg: '#f4f1ea', panel: '#fffdf8', panel2: '#efeae0', line: '#ddd5c6', text: '#2a2723', muted: '#756e63', accent: '#c7741f', paper: '#fbf8f1' },
  contrast: { bg: '#000000', panel: '#0d0d0d', panel2: '#1a1a1a', line: '#8a8a8a', text: '#ffffff', muted: '#d0d0d0', accent: '#ffd400', paper: '#fbf8f1' },
};
const CUSTOM_PARTS = [['bg', 'Background'], ['panel', 'Side panels'], ['panel2', 'Boxes and inputs'], ['line', 'Lines and borders'], ['text', 'Text'], ['muted', 'Faded text'], ['accent', 'Accent'], ['paper', 'Writing paper']];
const brightness = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); return 0.299 * r + 0.587 * g + 0.114 * b; };
const inkFor = (hex) => (brightness(hex) > 150 ? '#1d1c1a' : '#f2efe8');

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('settings') || '{}');
    if (!('proofMode' in saved) && localStorage.getItem('proofMode')) saved.proofMode = localStorage.getItem('proofMode'); // older versions
    return { ...SETTINGS_DEFAULTS, ...saved };
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}
const settings = loadSettings();
let redrawSettings = null; // set while the Settings page is open

function setSetting(key, value) {
  settings[key] = value;
  try { localStorage.setItem('settings', JSON.stringify(settings)); } catch { /* still applies for this run */ }
  applySettings();
}

function applySettings() {
  const b = document.body;
  const root = b.style; // on body, so it beats the theme's own colors
  b.dataset.theme = settings.theme;
  b.dataset.waves = settings.waves;
  b.dataset.paper = settings.paper;
  b.dataset.width = settings.pageWidth;
  b.classList.toggle('no-motion', !settings.motion);
  b.classList.toggle('solid', !settings.glass);
  b.classList.toggle('no-wordcount', !settings.wordCount);
  const custom = settings.theme === 'custom' && settings.customTheme;
  for (const [key] of CUSTOM_PARTS) {
    if (custom) root.setProperty(`--${key}`, custom[key]); else root.removeProperty(`--${key}`);
  }
  if (custom) {
    root.setProperty('--glass', `${custom.panel}c9`);
    root.setProperty('--paper-ink', inkFor(custom.paper));
    root.colorScheme = brightness(custom.bg) > 150 ? 'light' : 'dark';
  } else {
    ['--glass', '--paper-ink'].forEach((v) => root.removeProperty(v));
    root.colorScheme = '';
  }
  const accent = settings.accent || custom?.accent;
  if (accent) {
    root.setProperty('--accent', accent);
    root.setProperty('--accent-ink', brightness(accent) > 150 ? '#1d1508' : '#ffffff');
  } else {
    root.removeProperty('--accent');
    root.removeProperty('--accent-ink');
  }
  if (settings.docFont) root.setProperty('--doc-font', `'${settings.docFont}', Georgia, serif`); else root.removeProperty('--doc-font');
  root.setProperty('--doc-size', `${settings.docSize}pt`);
  api.setZoom(+settings.zoom || 1);
  document.querySelectorAll('.rte').forEach((e) => { e.spellcheck = settings.spellcheck; });
  applyOutput();
  api['settings:main']({ backupEvery: +settings.backupEvery, keepDays: +settings.backupKeepDays, autoUpdate: settings.autoUpdate, disabledSources: settings.disabledSources, spellcheck: settings.spellcheck });
}

// Sends all app sound to the chosen speakers or headphones. An unplugged device falls back to the default.
let outputWarned = false;
function applyOutput() {
  if (!audio.setSinkId) return;
  audio.setSinkId(settings.outputDevice || '').catch(() => {
    audio.setSinkId('').catch(() => {});
    if (!outputWarned) toast('Your chosen speakers are not connected, so the default ones are used.', true);
    outputWarned = true;
  });
}

// Device names stay blank until the microphone has been allowed once, so ask briefly if needed.
async function audioDevices() {
  let list = await navigator.mediaDevices.enumerateDevices();
  if (list.some((d) => d.kind.startsWith('audio') && !d.label)) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      list = await navigator.mediaDevices.enumerateDevices();
    } catch { /* names stay generic */ }
  }
  const pick = (kind, fallback) => list.filter((d) => d.kind === kind && d.deviceId && !['default', 'communications'].includes(d.deviceId))
    .map((d, i) => [d.deviceId, d.label || `${fallback} ${i + 1}`]);
  return { inputs: pick('audioinput', 'Microphone'), outputs: pick('audiooutput', 'Speakers') };
}

async function playTestSound() {
  const ctx = new AudioContext();
  try { if (settings.outputDevice) await ctx.setSinkId(settings.outputDevice); } catch { /* default output */ }
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  [523.25, 659.25, 783.99].forEach((f, i) => { // a soft three-note chime
    const osc = ctx.createOscillator();
    osc.frequency.value = f;
    osc.connect(gain);
    osc.start(ctx.currentTime + i * 0.18);
    osc.stop(ctx.currentTime + i * 0.18 + 0.35);
  });
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.25 * audio.volume + 0.05, ctx.currentTime + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.9);
  setTimeout(() => ctx.close(), 1200);
}

const THEMES = [
  ['cozy', 'Cozy', ['#17181c', '#1f2026', '#f0a94b']],
  ['midnight', 'Midnight', ['#11151f', '#182033', '#6ea8fe']],
  ['forest', 'Forest', ['#141a16', '#1b241e', '#8fcf7a']],
  ['plum', 'Plum', ['#1a1520', '#241d2c', '#e58fc3']],
  ['paper', 'Paper (light)', ['#f4f1ea', '#fffdf8', '#c7741f']],
  ['contrast', 'High contrast', ['#000000', '#0d0d0d', '#ffd400']],
];

VIEW.settings = (root) => {
  ui.settingsTab ||= 'Appearance';
  const groups = ['Appearance', 'Writing', 'Saving & backups', 'Sounds & library', 'Recording', 'Collaboration', 'Updates', 'About'];
  const body = h('div', { class: 'set-body' });
  const nav = h('nav', { class: 'set-nav', 'aria-label': 'Settings sections' });

  const row = (label, help, control) => h('div', { class: 'set-row' }, h('div', { class: 'set-text' }, h('div', { class: 'set-label' }, label), help && h('div', { class: 'muted' }, help)), control);
  const sel = (key, options, after) => select(options, String(settings[key]), (v) => { setSetting(key, v); after?.(v); }, { 'aria-label': key });
  const tog = (key) => h('input', { type: 'checkbox', class: 'switch', checked: !!settings[key], 'aria-label': key, onchange: (e) => setSetting(key, e.target.checked) });

  const pages = {
    Appearance: () => [
      h('div', { class: 'theme-grid' }, THEMES.map(([id, label, [bg, panel, accent]]) => h('button', { type: 'button', class: `theme-card ${settings.theme === id ? 'on' : ''}`, onclick: () => { setSetting('theme', id); draw(); } },
        h('div', { class: 'theme-swatch', style: `background:${bg}` }, h('i', { style: `background:${panel}` }), h('b', { style: `background:${accent}` })), label)),
      (() => {
        const c = settings.customTheme || THEME_COLORS.cozy;
        return h('button', { type: 'button', class: `theme-card ${settings.theme === 'custom' ? 'on' : ''}`, onclick: () => {
          if (!settings.customTheme) settings.customTheme = { ...(THEME_COLORS[settings.theme] || THEME_COLORS.cozy) };
          setSetting('theme', 'custom');
          draw();
        } }, h('div', { class: 'theme-swatch custom-swatch', style: `background:${c.bg}` }, h('i', { style: `background:${c.panel}` }), h('b', { style: `background:${c.accent}` })), 'Custom');
      })()),
      settings.theme === 'custom' && customEditor(),
      row('Accent color', 'Buttons, highlights and the active section.', h('div', { class: 'row' },
        h('input', { type: 'color', value: settings.accent || '#f0a94b', 'aria-label': 'Accent color', onchange: (e) => setSetting('accent', e.target.value) }),
        btn('Use theme color', () => { setSetting('accent', ''); draw(); }))),
      row('Interface size', 'Makes everything bigger or smaller.', sel('zoom', [['0.85', 'Small'], ['1', 'Normal'], ['1.15', 'Large'], ['1.3', 'Extra large']])),
      row('Background waves', null, sel('waves', [['on', 'On'], ['soft', 'Softer'], ['off', 'Off']])),
      row('Animations', 'Fades, slides and hover motion.', tog('motion')),
      row('See-through panels', 'Lets the background show through side panels.', tog('glass')),
    ],
    Writing: () => [
      row('Paper', 'The page you write on.', sel('paper', [['cream', 'Cream'], ['white', 'White'], ['dark', 'Dark']])),
      row('Default font', 'Text you have not given a font yet.', select([['', 'Georgia (default)'], ...fontList.map((f) => [f, f])], settings.docFont, (v) => setSetting('docFont', v), { 'aria-label': 'Default font' })),
      row('Default text size', null, sel('docSize', ['10', '11', '12', '13', '14', '16', '18', '20'].map((s) => [s, `${s} pt`]))),
      row('Page width', null, sel('pageWidth', [['narrow', 'Narrow'], ['normal', 'Normal (letter)'], ['wide', 'Wide']])),
      row('Spell check', 'Red underlines and right-click fixes.', tog('spellcheck')),
      row('Proofread', 'Spacing fixes stay on this PC. Grammar sends text to languagetool.org.', select([['off', 'Off'], ['local', 'Spelling + spacing'], ['grammar', '+ Grammar (LanguageTool)']], proofMode(), async (v) => {
        if (v === 'grammar' && proofMode() !== 'grammar' && !(await dialogBox({ title: 'Use online grammar checking?', text: 'Grammar checks send the text you are proofreading to LanguageTool (languagetool.org).', okText: 'Use LanguageTool' }))) return draw();
        setProofMode(v);
      }, { 'aria-label': 'Proofread' })),
      row('Ctrl shows references', 'Hold Ctrl to see character and world names in blue.', tog('refs')),
      row('Word count', 'The count under the writing page.', tog('wordCount')),
    ],
    'Saving & backups': () => [
      row('Back up every', 'Only when something changed. Your work also saves the moment you type.', sel('backupEvery', [['1', '1 minute'], ['2', '2 minutes'], ['5', '5 minutes'], ['10', '10 minutes'], ['30', '30 minutes']])),
      row('Keep every backup for', 'After that, one per day is kept.', sel('backupKeepDays', [['2', '2 days'], ['7', '1 week'], ['30', '1 month']])),
      row('Backups', 'Go back to any saved time, or import a backup file.', btn('Open backups', openBackups, 'primary')),
      row('Show folder', 'Where this show and its files live.', btn('Open folder', () => api['app:openFolder']('show'))),
    ],
    'Sounds & library': () => [
      row('Added sounds go to', 'Folder for sounds added from Find Sounds.', sel('addFolder', [['', 'No folder'], ...S.library.folders.map((f) => [f, f])])),
      h('h3', { class: 'set-sub' }, 'Search these sites'),
      sourceList,
    ],
    Recording: () => [
      row('Speakers / headphones', 'Where all sound from Storyroom plays: library, previews and takes.', h('div', { class: 'row' }, outputSlot, btn('Play test sound', playTestSound))),
      row('Microphone', 'Used by the Recording tab.', micSlot),
      row('Save takes to', 'Default library folder for new takes.', h('input', { value: settings.recFolder, 'aria-label': 'Default take folder', onchange: (e) => setSetting('recFolder', e.target.value.trim() || 'Voice Takes') })),
      row('Bit depth', '24-bit keeps the most detail. 16-bit files are smaller.', sel('recBits', [['24', '24-bit'], ['16', '16-bit']])),
    ],
    Collaboration: () => [collabPanel()],
    Updates: () => [
      row('Update automatically', 'Checks when the app opens and every minute.', tog('autoUpdate')),
      row('Check now', null, btn('Check for updates', async () => toast(await api['update:check']()), 'primary')),
      versionRow,
    ],
    About: () => [
      versionRow,
      row('Show folder', null, btn('Open folder', () => api['app:openFolder']('show'))),
      row('Reset settings', 'Back to how they were when you installed.', btn('Reset', async () => {
        if (!(await dialogBox({ title: 'Reset all settings?', text: 'Your shows are not touched.', okText: 'Reset', danger: true }))) return;
        Object.keys(settings).forEach((k) => delete settings[k]);
        Object.assign(settings, structuredClone(SETTINGS_DEFAULTS));
        setSetting('theme', settings.theme);
        draw();
      }, 'danger-text')),
    ],
  };

  const outputSlot = h('span', { class: 'muted' }, 'Finding devices...');
  const micSlot = h('span', { class: 'muted' }, 'Finding devices...');
  if (ui.settingsTab === 'Recording') {
    audioDevices().then(({ inputs, outputs }) => {
      outputSlot.replaceWith(select([['', 'System default'], ...outputs], settings.outputDevice, (v) => { outputWarned = false; setSetting('outputDevice', v); }, { 'aria-label': 'Speakers or headphones', class: 'device-sel' }));
      micSlot.replaceWith(select([['', 'System default'], ...inputs], settings.micDevice, (v) => setSetting('micDevice', v), { 'aria-label': 'Microphone', class: 'device-sel' }));
    });
  }
  // Every color of the Custom theme, plus a way to start over from any preset.
  function customEditor() {
    const c = settings.customTheme;
    const update = (key, value) => setSetting('customTheme', { ...settings.customTheme, [key]: value });
    return h('div', { class: 'custom-theme' },
      h('div', { class: 'row between' }, h('h3', { class: 'set-sub' }, 'Your colors'),
        select([['', 'Start from a preset...'], ...THEMES.map(([id, label]) => [id, label])], '', (v) => { if (v) { setSetting('customTheme', { ...THEME_COLORS[v] }); draw(); } }, { 'aria-label': 'Start from a preset' })),
      h('div', { class: 'custom-grid' }, CUSTOM_PARTS.map(([key, label]) => h('label', { class: 'custom-color' },
        h('input', { type: 'color', value: c[key], 'aria-label': label, oninput: (e) => update(key, e.target.value), onchange: () => draw() }),
        h('span', {}, label)))),
      h('p', { class: 'muted' }, 'Changes show right away. The Accent color above overrides this accent unless you press "Use theme color".'));
  }

  const versionRow = row('Version', null, h('span', { class: 'muted' }, '...'));
  api['app:version']().then((v) => { versionRow.lastChild.textContent = `Storyroom ${v}`; });
  const sourceList = h('div', { class: 'source-list' });
  api['find:sources']().then((names) => sourceList.replaceChildren(...names.map((n) => h('label', { class: 'source-item' },
    h('input', { type: 'checkbox', checked: !settings.disabledSources.includes(n), onchange: (e) => setSetting('disabledSources', e.target.checked ? settings.disabledSources.filter((x) => x !== n) : [...settings.disabledSources, n]) }), n))));

  function draw() {
    nav.replaceChildren(...groups.map((g) => h('button', { type: 'button', class: `set-tab ${ui.settingsTab === g ? 'on' : ''}`, onclick: () => { ui.settingsTab = g; draw(); } }, g)));
    body.replaceChildren(h('h1', { class: 'view-title' }, ui.settingsTab), ...pages[ui.settingsTab]());
  }
  draw();
  root.append(h('aside', { class: 'side set-side' }, h('div', { class: 'side-head' }, h('h2', {}, 'Settings')), nav), h('section', { class: 'pane' }, h('div', { class: 'scroll' }, h('div', { class: 'column' }, body))));
  redrawSettings = draw;
};
