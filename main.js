const { app, BrowserWindow, ipcMain, dialog, session, shell, Menu, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const core = require('./core');
const SOURCES = require('./sources');
const { autoUpdater } = require('electron-updater');

let win;
let root; // the open show's folder (or a guest's temporary copy while writing together)
let guestMode = false;
const cfg = { backupEvery: 2, keepDays: 2, autoUpdate: true, disabledSources: [] }; // from Settings
let backupTimer = null;

const configFile = () => path.join(app.getPath('userData'), 'config.json');
const projectFile = () => path.join(root, 'project.json');
const libDir = () => path.join(root, 'library');
const ytBin = () => path.join(app.getPath('userData'), 'bin', 'yt-dlp.exe');
const send = (channel, data) => { if (win && !win.isDestroyed()) win.webContents.send(channel, data); };

// New files get a random tag while visiting someone's show, so they can never replace the host's files.
const freshPath = (dir, name) => {
  if (!guestMode) return core.uniquePath(dir, name);
  const { name: stem, ext } = path.parse(name);
  return core.uniquePath(dir, `${stem} ${Math.random().toString(36).slice(2, 7)}${ext}`);
};
// Lets the page pass new files on to the host when writing together.
const noteWrite = (full) => send('file:written', path.relative(root, full).split(path.sep).join('/'));

function openRoot(dir) {
  root = dir;
  for (const d of ['images', 'library', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  core.atomicWrite(configFile(), JSON.stringify({ root }));
}

function startingRoot() {
  try {
    const saved = JSON.parse(fs.readFileSync(configFile(), 'utf8')).root;
    if (saved && fs.existsSync(saved)) return saved;
  } catch { /* first run */ }
  return path.join(app.getPath('documents'), 'Storyroom', 'My Show');
}

function loadProject() {
  if (!fs.existsSync(projectFile())) return null;
  const text = fs.readFileSync(projectFile(), 'utf8');
  try {
    return JSON.parse(text);
  } catch {
    // Keep the unreadable file for recovery, then fall back to the newest daily backup.
    fs.renameSync(projectFile(), `${projectFile()}.corrupt-${Date.now()}`);
    const newest = fs.readdirSync(path.join(root, 'backups')).sort().pop();
    return newest ? JSON.parse(fs.readFileSync(path.join(root, 'backups', newest), 'utf8')) : null;
  }
}

function saveProject(text) {
  JSON.parse(text); // never replace a good file with invalid JSON
  core.atomicWrite(projectFile(), text);
}

// About 60,000 common English words (SCOWL sizes 10-50), loaded on first use for spacing fixes.
let words = null;
const commonWords = () => (words ||= new Set(['10', '20', '35', '40', '50'].flatMap((n) => require('wordlist-english')[`english/${n}`]).map((w) => w.toLowerCase())));

function restartBackups() {
  clearInterval(backupTimer);
  backupTimer = setInterval(() => { try { backupNow(false); } catch { /* disk busy: next round */ } }, cfg.backupEvery * 60 * 1000);
}

// --- Backups: a silent copy every few minutes (Settings) when something changed ---------------------------
const backupsDir = () => path.join(root, 'backups');
let lastBackup = null;

function backupNow(force) {
  if (guestMode || !fs.existsSync(projectFile())) return;
  const text = fs.readFileSync(projectFile(), 'utf8');
  if (lastBackup === null) {
    const newest = fs.readdirSync(backupsDir()).filter((n) => n.startsWith('project-')).sort().pop();
    lastBackup = newest ? fs.readFileSync(path.join(backupsDir(), newest), 'utf8') : '';
  }
  if (!force && text === lastBackup) return;
  fs.writeFileSync(path.join(backupsDir(), core.backupName(new Date())), text);
  lastBackup = text;
  for (const name of core.backupsToPrune(fs.readdirSync(backupsDir()), Date.now(), cfg.keepDays)) fs.rmSync(path.join(backupsDir(), name), { force: true });
}

function listBackups() {
  return fs.readdirSync(backupsDir()).filter((n) => /^project-[\d_-]+\.json$/.test(n)).sort().reverse()
    .map((name) => ({ name, size: fs.statSync(path.join(backupsDir(), name)).size }));
}

// Restores a backup (by name) or an imported file. The current state is backed up first.
async function restoreBackup(name) {
  let source;
  if (name) {
    if (!/^project-[\d_-]+\.json$/.test(name)) throw new Error('Unknown backup.');
    source = core.inside(root, `backups/${name}`);
  } else {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { title: 'Import a Storyroom backup', filters: [{ name: 'Storyroom backup', extensions: ['json'] }], properties: ['openFile'] });
    if (canceled) return false;
    source = filePaths[0];
  }
  const text = fs.readFileSync(source, 'utf8');
  const data = JSON.parse(text);
  if (!data?.show || !Array.isArray(data.episodes)) throw new Error('That file is not a Storyroom backup.');
  backupNow(true);
  core.atomicWrite(projectFile(), text);
  win.reload();
  return true;
}

function copyIntoLibrary(src) {
  const dest = freshPath(libDir(), core.safeName(path.basename(src)));
  fs.copyFileSync(src, dest);
  noteWrite(dest);
  return { file: `library/${path.basename(dest)}`, title: path.parse(dest).name, source: 'Imported' };
}

function audioFilesIn(p) {
  if (fs.statSync(p).isDirectory()) return fs.readdirSync(p).flatMap((n) => audioFilesIn(path.join(p, n)));
  return core.isAudio(p) ? [p] : [];
}

function setupSoundBrowser() {
  const ses = session.fromPartition('persist:sounds');
  // Several sound sites refuse browsers whose user agent names Electron.
  ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|Storyroom|storyroom)\/\S+/g, ''));
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'fullscreen'));

  ses.on('will-download', (event, item, wc) => {
    const id = `dl${Date.now()}${Math.random()}`;
    const name = core.audioName(item.getFilename(), item.getMimeType());
    if (!name) {
      event.preventDefault(); // only audio may enter the library; blocks installers and archives
      send('dl:update', { id, name: item.getFilename(), state: 'blocked' });
      return;
    }
    const dest = freshPath(libDir(), name);
    item.setSavePath(dest);
    const pageUrl = wc && !wc.isDestroyed() ? wc.getURL() : item.getURL();
    item.on('updated', () => {
      const total = item.getTotalBytes();
      send('dl:update', { id, name, state: 'running', pct: total ? (100 * item.getReceivedBytes()) / total : null });
    });
    item.once('done', (_e, state) => {
      if (state !== 'completed') return send('dl:update', { id, name, state: 'failed' });
      send('dl:update', { id, name, state: 'done' });
      noteWrite(dest);
      send('dl:done', { file: `library/${path.basename(dest)}`, title: path.parse(dest).name, source: new URL(pageUrl).hostname.replace(/^www\./, ''), sourceUrl: pageUrl });
    });
  });
}

// --- Search every source --------------------------------------------------------------------
let searchToken = 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function setupSearchSession() {
  const ses = session.fromPartition('persist:search');
  ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|Storyroom|storyroom)\/\S+/g, ''));
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  ses.on('will-download', (e) => e.preventDefault()); // hidden pages may never save anything
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (d, cb) => cb({ cancel: ['image', 'media', 'font'].includes(d.resourceType) }));
}

async function searchSource(src, query, token) {
  const hidden = new BrowserWindow({ show: false, width: 1300, height: 900, webPreferences: { partition: 'persist:search' } });
  hidden.webContents.setAudioMuted(true);
  hidden.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    hidden.loadURL(src.url(encodeURIComponent(query))).catch(() => {});
    const code = `(() => { try { return (${src.extract})(); } catch { return []; } })()`;
    for (let i = 0; i < 16 && token === searchToken; i++) {
      await wait(800);
      const raw = await Promise.race([hidden.webContents.executeJavaScript(code).catch(() => []), wait(4000)]);
      const items = core.cleanResults(raw, src);
      if (items.length) return items;
    }
    return [];
  } finally {
    hidden.destroy();
  }
}

function startSearch(query) {
  const token = ++searchToken;
  const active = SOURCES.filter((s) => !cfg.disabledSources.includes(s.name));
  const queue = [...active];
  let left = active.length;
  const worker = async () => {
    while (queue.length && token === searchToken) {
      const src = queue.shift();
      const items = await searchSource(src, query, token).catch(() => []);
      left--;
      if (token === searchToken) send('find:results', { token, source: src.name, items, left });
    }
  };
  for (let i = 0; i < 5; i++) worker();
  return { token, total: active.length };
}

async function addResult({ audio, title, artist, license, page, source }) {
  if (!core.isWebUrl(audio)) throw new Error('That result has no audio link.');
  const res = await session.fromPartition('persist:sounds').fetch(audio);
  if (!res.ok) throw new Error(`${source} refused the download (${res.status})`);
  const name = core.resultFileName(title, res.url || audio, res.headers.get('content-type'));
  if (!name) throw new Error('That link is not an audio file.');
  const dest = freshPath(libDir(), name);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  noteWrite(dest);
  return { file: `library/${path.basename(dest)}`, title, artist, license, source, sourceUrl: page || audio };
}

function streamUrl(url) {
  return new Promise((resolve, reject) => {
    const child = spawn(ytBin(), ['-f', 'bestaudio', '-g', '--no-playlist', '--no-warnings', '--js-runtimes', `node:${process.execPath}`, '--', url], { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', reject);
    child.on('close', () => { const link = out.trim().split('\n')[0]; core.isWebUrl(link) ? resolve(link) : reject(new Error('No preview available for this one.')); });
  });
}

function grabWithYtdlp(url) {
  const id = `yt${Date.now()}`;
  send('dl:update', { id, name: url, state: 'running', pct: null });
  const args = ['-f', 'bestaudio[ext=m4a]/bestaudio', '--no-playlist', '--newline', '--progress', '--encoding', 'utf-8', '--no-warnings',
    // YouTube needs a JavaScript runtime. Electron is one when ELECTRON_RUN_AS_NODE is set.
    '--js-runtimes', `node:${process.execPath}`,
    '-P', libDir(), '-o', '%(title).100B [%(id)s].%(ext)s',
    '--print', 'after_move:%(filepath)s\t%(title)s\t%(uploader)s\t%(duration)s', '--', url];
  const child = spawn(ytBin(), args, { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  let buffer = '';
  let errors = '';
  let finished = false;
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      const parsed = core.parseYtdlp(line);
      if (parsed?.pct != null) send('dl:update', { id, name: url, state: 'running', pct: parsed.pct });
      if (parsed?.done) {
        finished = true;
        const { file, title, artist, duration } = parsed.done;
        send('dl:update', { id, name: title, state: 'done' });
        noteWrite(file);
        send('dl:done', { file: `library/${path.basename(file)}`, title, artist, duration, source: new URL(url).hostname.replace(/^www\./, ''), sourceUrl: url, license: 'Unknown: check before using' });
      }
    }
  });
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const fail = (message) => send('dl:update', { id, name: url, state: 'failed', error: message });
  child.on('error', (err) => fail(err.message));
  child.on('close', () => { if (!finished) fail(errors.trim().split('\n').pop() || 'No audio found on this page'); });
}

// Checks GitHub Releases on launch and every minute, downloads in the background, and installs
// on restart (or the next normal quit). Skipped when running from source.
function setupUpdates() {
  if (!app.isPackaged) return;
  let busy = false; // a download is already in progress or finished
  autoUpdater.on('update-available', () => { busy = true; });
  autoUpdater.on('update-downloaded', (info) => send('update:ready', info.version));
  autoUpdater.on('error', () => { busy = false; }); // offline or GitHub hiccup: try again next minute
  const check = () => { if (!busy && cfg.autoUpdate) autoUpdater.checkForUpdates().catch(() => {}); };
  check();
  setInterval(check, 60 * 1000);
}

// --- Renderer API -------------------------------------------------------------------------------
const handlers = {
  'project:load': () => ({ root, rootUrl: `${pathToFileURL(root).href}/`, data: loadProject() }),
  'project:switch': async (_e, create) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: create ? 'Choose or make an empty folder for the new show' : 'Open a show folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled) return false;
    if (create && fs.existsSync(path.join(filePaths[0], 'project.json'))) throw new Error('That folder already has a show in it. Pick an empty folder.');
    if (!create && !fs.existsSync(path.join(filePaths[0], 'project.json'))) throw new Error('No show found in that folder.');
    return filePaths[0];
  },
  'project:open': (_e, dir) => { openRoot(dir); win.reload(); },
  'image:pick': async (_e, asDataUrl) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }], properties: ['openFile'] });
    if (canceled) return null;
    if (asDataUrl) return `data:image/${path.extname(filePaths[0]).slice(1).replace('jpg', 'jpeg')};base64,${fs.readFileSync(filePaths[0]).toString('base64')}`;
    const dest = freshPath(path.join(root, 'images'), core.safeName(path.basename(filePaths[0])));
    fs.copyFileSync(filePaths[0], dest);
    noteWrite(dest);
    return `images/${path.basename(dest)}`;
  },
  'image:write': (_e, rel, dataUrl) => {
    const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
    if (!match) throw new Error('Expected a PNG image');
    fs.writeFileSync(core.inside(root, rel), Buffer.from(match[1], 'base64'));
    noteWrite(core.inside(root, rel));
  },
  'image:read': (_e, rel) => `data:image/png;base64,${fs.readFileSync(core.inside(root, rel)).toString('base64')}`,
  'lib:pick': async (_e, folders) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: folders ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
      filters: folders ? [] : [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus', 'webm', 'mp4', 'aiff', 'aif', 'wma'] }],
    });
    return canceled ? [] : filePaths;
  },
  'lib:import': (_e, paths) => paths.flatMap(audioFilesIn).map(copyIntoLibrary),
  'lib:trash': async (_e, files) => { for (const f of files) await shell.trashItem(core.inside(root, f)).catch(() => {}); },
  'lib:reveal': (_e, rel) => shell.showItemInFolder(core.inside(root, rel)),
  'web:external': (_e, url) => { if (core.isWebUrl(url)) shell.openExternal(url); },
  'yt:ready': () => fs.existsSync(ytBin()),
  'yt:install': async () => {
    const res = await net.fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe');
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    fs.mkdirSync(path.dirname(ytBin()), { recursive: true });
    core.atomicWrite(ytBin(), Buffer.from(await res.arrayBuffer()));
  },
  'yt:grab': (_e, url) => {
    if (!core.isWebUrl(url)) throw new Error('That is not a web link.');
    grabWithYtdlp(url);
  },
  'find:search': (_e, query) => startSearch(String(query).slice(0, 200)),
  'find:add': (_e, result) => addResult(result),
  'yt:stream': (_e, url) => {
    if (!core.isWebUrl(url)) throw new Error('That is not a web link.');
    return streamUrl(url);
  },
  'update:install': () => autoUpdater.quitAndInstall(),
  'settings:main': (_e, next) => {
    const every = cfg.backupEvery;
    Object.assign(cfg, next);
    session.defaultSession.setSpellCheckerEnabled(next.spellcheck !== false);
    if (every !== cfg.backupEvery) restartBackups();
  },
  'app:version': () => app.getVersion(),
  'app:openFolder': (_e, which) => shell.openPath(which === 'backups' ? backupsDir() : root),
  'update:check': async () => {
    if (!app.isPackaged) return 'Updates only work in the installed app.';
    const result = await autoUpdater.checkForUpdates().catch(() => null);
    const latest = result?.updateInfo?.version;
    if (!latest) return 'Could not reach GitHub. Check your internet.';
    return latest === app.getVersion() ? `You have the latest version (${latest}).` : `Version ${latest} is downloading. You will be asked to restart.`;
  },
  'find:sources': () => SOURCES.map((s) => s.name),
  // Writing together: images and sounds pass between PCs. Only the show's own folders.
  'file:read': (_e, rel) => {
    if (!/^(images|library)\//.test(rel)) return null;
    const full = core.inside(root, rel);
    return fs.existsSync(full) ? fs.readFileSync(full) : null;
  },
  'file:write': (_e, rel, data) => {
    if (!/^(images|library)\/[^/]+$/.test(rel) || !data) return false;
    const full = core.inside(root, rel);
    // Never replace an existing file, except redrawn storyboard panels.
    const flag = /^images\/panel-[\w-]+\.png$/.test(rel) ? 'w' : 'wx';
    try { fs.writeFileSync(full, Buffer.from(data), { flag }); } catch (err) { if (err.code !== 'EEXIST') throw err; }
    return true;
  },
  'collab:guestRoot': () => {
    root = path.join(app.getPath('userData'), 'shared-session');
    fs.rmSync(root, { recursive: true, force: true });
    for (const d of ['images', 'library', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
    guestMode = true;
    return { rootUrl: `${pathToFileURL(root).href}/` };
  },
  'collab:leave': () => {
    guestMode = false;
    root = startingRoot();
    win.reload();
  },
  'words:known': (_e, list) => list.map((w) => commonWords().has(String(w).toLowerCase())),
  'backup:list': () => listBackups(),
  'backup:now': () => backupNow(true),
  'backup:restore': (_e, name) => restoreBackup(name),
  'lib:saveAudio': (_e, title, bytes) => {
    const dest = freshPath(libDir(), `${core.safeName(title).slice(0, 120)}.wav`);
    fs.writeFileSync(dest, Buffer.from(bytes));
    noteWrite(dest);
    return { file: `library/${path.basename(dest)}`, title };
  },
  'grammar:check': async (_e, text) => {
    const res = await net.fetch('https://api.languagetool.org/v2/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ text: String(text).slice(0, 20000), language: 'en-US' }).toString(),
    });
    if (res.status === 429) throw new Error('Grammar service is busy. It will try again after your next pause.');
    if (!res.ok) throw new Error(`Grammar service error (${res.status}).`);
    return (await res.json()).matches.map((m) => ({ offset: m.offset, length: m.length, message: m.message, replacements: m.replacements.slice(0, 6).map((r) => r.value) }));
  },
  'pdf:export': async (_e, html, name) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: `${core.safeName(name)}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (canceled) return null;
    // The temp page lives in the project folder so relative image paths resolve.
    const page = path.join(root, '.print.html');
    const css = fs.readFileSync(path.join(__dirname, 'src', 'doc.css'), 'utf8');
    fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>${css}</style><body class="print">${html}`);
    const hidden = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
    try {
      await hidden.loadFile(page);
      fs.writeFileSync(filePath, await hidden.webContents.printToPDF({ pageSize: 'Letter', printBackground: true }));
    } finally {
      hidden.destroy();
      fs.rmSync(page, { force: true });
    }
    shell.openPath(filePath);
    return filePath;
  },
};

app.whenReady().then(() => {
  for (const [channel, fn] of Object.entries(handlers)) ipcMain.handle(channel, fn);
  ipcMain.on('project:save', (e, text) => {
    if (guestMode) { e.returnValue = 'Visiting a shared show: nothing is saved on this PC.'; return; }
    try { saveProject(text); e.returnValue = null; } catch (err) { e.returnValue = err.message; }
  });

  openRoot(startingRoot());
  setupSoundBrowser();
  setupSearchSession();
  Menu.setApplicationMenu(null);
  // Microphone only (for Recording); never camera or anything else.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => cb(permission === 'fullscreen' || permission === 'speaker-selection' || (permission === 'media' && (details.mediaTypes || []).every((t) => t === 'audio'))));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ['local-fonts', 'fullscreen', 'media', 'speaker-selection'].includes(permission));
  restartBackups();

  win = new BrowserWindow({
    width: 1500, height: 920, minWidth: 1050, minHeight: 640, backgroundColor: '#17181c', title: 'Storyroom',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, webviewTag: true },
  });
  win.on('closed', () => { searchToken++; }); // stops hidden search windows so the app can quit
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.webContents.once('did-finish-load', setupUpdates);
  win.webContents.on('will-navigate', (e) => e.preventDefault()); // dropping a file must not replace the app
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('context-menu', (_e, p) => {
    if (!p.isEditable) return;
    const fix = p.dictionarySuggestions.map((word) => ({ label: word, click: () => win.webContents.replaceMisspelling(word) }));
    Menu.buildFromTemplate([
      ...(p.misspelledWord ? [
        ...(fix.length ? fix : [{ label: 'No suggestions', enabled: false }]),
        { label: `Add "${p.misspelledWord}" to dictionary`, click: () => win.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord) },
        { type: 'separator' },
      ] : []),
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' },
    ]).popup({ window: win });
  });
});

app.on('web-contents-created', (_e, wc) => {
  wc.on('will-attach-webview', (event, prefs, params) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    if (params.partition !== 'persist:sounds' || !(core.isWebUrl(params.src) || params.src === 'about:blank')) event.preventDefault();
  });
  if (wc.getType() === 'webview') {
    // Sites open links and downloads in popups; keep them inside the one browser pane.
    wc.setWindowOpenHandler(({ url }) => {
      if (core.isWebUrl(url)) wc.loadURL(url);
      return { action: 'deny' };
    });
  }
});

app.on('window-all-closed', () => app.quit());
