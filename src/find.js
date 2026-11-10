'use strict';
// Search tab: one box, every source, results listed here, Add sends the file to Library > Sounds.
// Browse tab: a real browser pane for sites that need a login. Downloads made there are captured too.
const BROWSE_SITES = [
  { name: 'Zapsplat', home: 'https://www.zapsplat.com/', search: 'https://www.zapsplat.com/?s={q}' },
  { name: 'YouTube Audio Library', home: 'https://studio.youtube.com/channel/UC/music', search: '' },
  { name: 'Uppbeat', home: 'https://uppbeat.io/', search: '' },
  { name: 'Incompetech', home: 'https://incompetech.com/music/royalty-free/music.html', search: '' },
  { name: 'Orange Free Sounds', home: 'https://orangefreesounds.com/', search: 'https://orangefreesounds.com/?s={q}' },
  { name: 'Pixabay', home: 'https://pixabay.com/sound-effects/', search: 'https://pixabay.com/sound-effects/search/{q}/' },
  { name: 'Freesound', home: 'https://freesound.org/', search: 'https://freesound.org/search/?q={q}' },
  { name: 'YouTube', home: 'https://www.youtube.com/', search: 'https://www.youtube.com/results?search_query={q}' },
  { name: 'Bandcamp', home: 'https://bandcamp.com/', search: 'https://bandcamp.com/search?q={q}' },
];

const finder = { built: false, tab: 'search', site: BROWSE_SITES[0], token: 0, results: [], counts: new Map(), left: 0, only: '', downloads: new Map() };

function onSearchResults(d) {
  if (d.token !== finder.token) return;
  finder.left = d.left;
  finder.counts.set(d.source, d.items.length);
  d.items.forEach((item, rank) => finder.results.push({ ...item, rank, state: inLibrary(item) ? 'added' : 'idle', isNew: true }));
  finder.results.sort((a, b) => a.rank - b.rank); // mixes sources instead of one long block each
  finder.draw?.();
}

const inLibrary = (r) => !!r.page && S.library.items.some((i) => i.sourceUrl === r.page && i.title === r.title);

function onDownloadUpdate(d) {
  finder.downloads.set(d.id, d);
  if (d.state === 'blocked') toast(`Skipped ${d.name}: not an audio file`, true);
  if (d.state === 'failed') {
    toast(`Download failed: ${d.error || d.name}`, true);
    finder.results.filter((r) => r.page === d.name && r.state === 'adding').forEach((r) => { r.state = 'idle'; });
    finder.draw?.();
  }
  finder.drawDownloads?.();
}

function onDownloadDone(info) {
  addToLibrary([info], { kind: 'sound' });
  refreshLibTitles();
  toast(`Added to Sounds: ${info.title}`);
  finder.results.filter((r) => r.page === info.sourceUrl).forEach((r) => { r.state = 'added'; });
  finder.draw?.();
}

async function ensureYt() {
  if (await api['yt:ready']()) return true;
  const ok = await dialogBox({ title: 'One-time setup', text: 'This source needs yt-dlp, a free open-source tool. Storyroom will download yt-dlp.exe from github.com/yt-dlp once.', okText: 'Install' });
  if (!ok) return false;
  toast('Installing yt-dlp...');
  await api['yt:install']();
  return true;
}

async function addResult(r) {
  if (r.state !== 'idle') return;
  r.state = 'adding';
  finder.draw();
  try {
    if (r.audio) {
      addToLibrary([await api['find:add']({ audio: r.audio, title: r.title, artist: r.artist, license: r.license, page: r.page, source: r.source })], { kind: 'sound' });
      refreshLibTitles();
      r.state = 'added';
      toast(`Added to Sounds: ${r.title}`);
    } else if (await ensureYt()) {
      await api['yt:grab'](r.page); // finishes later through onDownloadDone
    } else r.state = 'idle';
  } catch (err) {
    r.state = 'idle';
    throw err;
  } finally {
    finder.draw();
  }
}

async function previewResult(r) {
  const label = [r.title, r.source].join(' - ');
  if (r.audio) return playRemote(r.audio, label);
  if (!(await ensureYt())) return;
  toast('Loading preview...');
  playRemote(await api['yt:stream'](r.page), label);
}

VIEW.find = () => {
  if (finder.built) return;
  finder.built = true;
  const root = $('#find');

  // --- Search ---
  const input = h('input', { class: 'grow big', placeholder: 'Search every sound site: thunder, door creak, lofi piano...', 'aria-label': 'Search all sound sites', onkeydown: (e) => { if (e.key === 'Enter') run(); } });
  const status = h('span', { class: 'muted find-status' });
  const chips = h('div', { class: 'chips' });
  const list = h('div', { class: 'results' }, h('div', { class: 'empty-state' }, h('h2', {}, 'What are you listening for?'), h('p', {}, 'Type above. Press Add on anything you like and it lands in Library, under Sounds.')));

  async function run() {
    const query = input.value.trim();
    if (!query) return input.focus();
    finder.results = [];
    finder.counts = new Map();
    finder.only = '';
    const started = await api['find:search'](query);
    finder.token = started.token;
    finder.left = started.total;
    finder.draw();
  }

  finder.draw = () => {
    status.textContent = finder.left ? `Searching... ${finder.left} sources left` : finder.token ? `${finder.results.length} results` : '';
    status.classList.toggle('busy', finder.left > 0);
    chips.replaceChildren(...(finder.counts.size ? [h('button', { type: 'button', class: `chip ${finder.only ? '' : 'on'}`, onclick: () => { finder.only = ''; finder.draw(); } }, 'All'),
      ...[...finder.counts].map(([name, n]) => h('button', { type: 'button', class: `chip ${finder.only === name ? 'on' : ''}`, disabled: !n, onclick: () => { finder.only = name; finder.draw(); } }, `${name} ${n}`))] : []));
    if (!finder.token) return;
    const shown = finder.results.filter((r) => !finder.only || r.source === finder.only);
    list.replaceChildren(...(shown.length ? shown.map((r) => {
      const el = h('div', { class: `res-row ${r.isNew ? 'fresh' : ''}` },
        h('button', { class: 'row-play', type: 'button', title: 'Preview', 'aria-label': `Preview ${r.title}`, onclick: () => previewResult(r) }, '▶'),
        h('div', { class: 'grow' }, h('div', { class: 'ellipsis strong', title: r.title }, r.title), h('div', { class: 'ellipsis muted' }, r.artist || ' ')),
        h('span', { class: 'res-source ellipsis' }, r.source),
        h('span', { class: 'res-time muted' }, r.duration ? clock(r.duration) : ''),
        h('span', { class: 'res-license ellipsis muted', title: r.license }, r.license),
        h('button', { class: `btn res-add ${r.state === 'added' ? 'done' : 'primary'}`, type: 'button', disabled: r.state !== 'idle', onclick: () => addResult(r) }, { idle: 'Add', adding: 'Adding...', added: 'Added' }[r.state]));
      r.isNew = false;
      return el;
    }) : [h('div', { class: 'empty-state small' }, h('p', {}, finder.left ? 'Looking...' : 'Nothing found. Try other words.'))]));
  };

  const searchPane = h('div', { class: 'find-pane' },
    h('div', { class: 'find-top' }, input, btn('Search', run, 'primary'), status),
    chips, list,
    h('p', { class: 'license-note wide-note' }, 'Check each license before using a sound in your show. It is saved with the file. YouTube and SoundCloud uploads are usually copyrighted.'));

  // --- Browse ---
  let web = null;
  const browsePane = h('div', { class: 'find-pane off' });
  const load = (link) => web.loadURL(link).catch(() => {}); // rejects on harmless redirects

  function buildBrowse() {
    web = h('webview', { src: finder.site.home, partition: 'persist:sounds', allowpopups: 'true', class: 'web', webpreferences: 'contextIsolation=yes' });
    const address = h('input', { class: 'grow', 'aria-label': 'Page address', placeholder: 'Paste any link', onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      const typed = address.value.trim();
      load(/^https?:\/\//i.test(typed) ? typed : `https://${typed}`);
    } });
    const siteChips = h('div', { class: 'chips' });
    const target = (s) => (input.value.trim() && s.search ? s.search.replace('{q}', encodeURIComponent(input.value.trim())) : s.home);
    const sites = () => [...BROWSE_SITES, ...S.sources];

    function drawSites() {
      siteChips.replaceChildren(...sites().map((s) => h('button', { type: 'button', class: `chip ${s === finder.site ? 'on' : ''}`, onclick: () => { finder.site = s; drawSites(); load(target(s)); } }, s.name,
        S.sources.includes(s) && h('span', { class: 'chip-x', title: 'Remove site', onclick: (e) => { e.stopPropagation(); S.sources.splice(S.sources.indexOf(s), 1); touch(); drawSites(); } }, ' ×'))),
      h('button', { type: 'button', class: 'chip add', onclick: addSite }, '+ Add site'));
    }

    async function addSite() {
      const link = await dialogBox({ title: 'Add a sound site', text: 'Paste its address. To make it searchable, put {q} where the search words go, like https://site.com/search?q={q}', input: 'https://', okText: 'Next' });
      if (!link) return;
      let host;
      try { host = new URL(link.replace('{q}', 'x')).hostname.replace(/^www\./, ''); } catch { return toast('That is not a valid address', true); }
      if (!/^https?:/i.test(link)) return toast('Address must start with http or https', true);
      const name = await dialogBox({ title: 'Name this site', input: host, okText: 'Add' });
      if (!name) return;
      const site = { name, home: link.includes('{q}') ? new URL(link.replace('{q}', 'x')).origin : link, search: link.includes('{q}') ? link : '' };
      S.sources.push(site);
      finder.site = site;
      touch();
      drawSites();
      load(target(site));
    }

    async function grab() {
      if (!(await ensureYt())) return;
      await api['yt:grab'](address.value.trim());
      toast('Getting audio from this page...');
    }

    const downloads = h('div', { class: 'dl-list' }, h('p', { class: 'muted' }, 'Click a download button on any site. The file lands in Library, under Sounds.'));
    finder.drawDownloads = () => downloads.replaceChildren(...[...finder.downloads.values()].reverse().map((d) => h('div', { class: `dl ${d.state}` },
      h('div', { class: 'ellipsis', title: d.name }, d.name),
      h('div', { class: 'dl-state' }, { running: d.pct != null ? `${Math.round(d.pct)}%` : 'Working...', done: 'In library', failed: d.error || 'Failed', blocked: 'Not audio, skipped' }[d.state]),
      d.state === 'running' && h('div', { class: 'bar' }, h('i', { style: `width:${d.pct || 3}%` })))));
    finder.drawDownloads();

    const showAddress = (e) => { address.value = e.url; };
    web.addEventListener('did-navigate', showAddress);
    web.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) showAddress(e); });

    browsePane.append(siteChips,
      h('div', { class: 'find-nav' },
        btn('←', () => web.canGoBack() && web.goBack(), '', 'Back'), btn('→', () => web.canGoForward() && web.goForward(), '', 'Forward'), btn('↻', () => web.reload(), '', 'Reload'),
        address,
        btn('Save audio from this page', grab, 'primary', 'For sites with no download button')),
      h('div', { class: 'find-body' }, web, h('aside', { class: 'dl-side' }, h('h3', {}, 'Downloads'), downloads)));
    drawSites();
  }

  const tabs = h('div', { class: 'find-tabs' });
  function drawTabs() {
    tabs.replaceChildren(...[['search', 'Search everything'], ['browse', 'Browse a site']].map(([id, label]) => h('button', { type: 'button', class: `tab ${finder.tab === id ? 'on' : ''}`, onclick: () => {
      finder.tab = id;
      if (id === 'browse' && !web) buildBrowse();
      searchPane.classList.toggle('off', id !== 'search');
      browsePane.classList.toggle('off', id !== 'browse');
      drawTabs();
    } }, label)));
  }
  drawTabs();
  root.append(tabs, searchPane, browsePane);
  input.focus();
};
