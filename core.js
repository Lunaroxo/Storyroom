// Pure helpers with no Electron dependency, so `npm test` can cover them.
const fs = require('fs');
const path = require('path');

const AUDIO = new Set(['.mp3', '.wav', '.ogg', '.oga', '.flac', '.m4a', '.aac', '.opus', '.webm', '.mp4', '.aiff', '.aif', '.wma']);
const MIME_EXT = {
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav',
  'audio/ogg': '.ogg', 'audio/flac': '.flac', 'audio/x-flac': '.flac', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a',
  'audio/aac': '.aac', 'audio/opus': '.opus', 'audio/webm': '.webm',
};

const isAudio = (name) => AUDIO.has(path.extname(name).toLowerCase());

// Returns a safe file name with an audio extension, or null when the download is not audio.
function audioName(filename, mime) {
  const base = safeName(filename);
  if (isAudio(base)) return base;
  const ext = MIME_EXT[(mime || '').split(';')[0].trim().toLowerCase()];
  return ext ? base + ext : null;
}

// File name for a search result: its title plus an extension from the URL or, failing that, the mime type.
function resultFileName(title, url, mime) {
  const urlExt = path.extname(new URL(url).pathname).toLowerCase();
  const ext = AUDIO.has(urlExt) ? urlExt : MIME_EXT[(mime || '').split(';')[0].trim().toLowerCase()];
  return ext ? safeName(title).slice(0, 120) + ext : null;
}

// Search results come from remote pages, so keep only well-formed fields and web links.
function cleanResults(raw, source) {
  const text = (v) => (typeof v === 'string' ? v.trim().slice(0, 200) : '');
  return (Array.isArray(raw) ? raw : []).filter(Boolean).map((r) => ({
    title: text(r.title), artist: text(r.artist), source: source.name, license: text(r.license) || source.license || 'Unknown: check before using',
    audio: isWebUrl(r.audio) ? r.audio : '', page: isWebUrl(r.page) ? r.page : '', duration: Number.isFinite(r.duration) && r.duration > 0 ? r.duration : 0,
  })).filter((r) => r.title && (r.audio || r.page)).slice(0, 15);
}

function safeName(name) {
  const base = String(name).split(/[\\/]/).pop().replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 150);
  return base && !/^\.+$/.test(base) ? base : 'file';
}

function uniquePath(dir, name) {
  const { name: stem, ext } = path.parse(name);
  let candidate = path.join(dir, name);
  for (let n = 2; fs.existsSync(candidate); n++) candidate = path.join(dir, `${stem} (${n})${ext}`);
  return candidate;
}

// Write-then-rename so a crash mid-save cannot corrupt the existing project file.
function atomicWrite(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// Resolves a project-relative path and refuses anything that escapes the project folder.
function inside(root, rel) {
  const full = path.resolve(root, String(rel));
  const prefix = path.resolve(root) + path.sep;
  if (!full.startsWith(prefix)) throw new Error(`Path outside project: ${rel}`);
  return full;
}

const isWebUrl = (url) => { try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; } };

function parseYtdlp(line) {
  const pct = line.match(/^\[download\]\s+([\d.]+)%/);
  if (pct) return { pct: parseFloat(pct[1]) };
  const parts = line.split('\t');
  if (parts.length === 4 && path.isAbsolute(parts[0])) {
    const secs = parseFloat(parts[3]);
    return { done: { file: parts[0], title: parts[1], artist: parts[2] === 'NA' ? '' : parts[2], duration: secs || 0 } };
  }
  return null;
}

// Backup file name for a moment in local time: project-2026-11-10_14-02-00.json
const backupName = (d) => `project-${[d.getFullYear(), d.getMonth() + 1, d.getDate()].map((n) => String(n).padStart(2, '0')).join('-')}_${[d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join('-')}.json`;

// Which backups to delete: everything from the last 2 days stays, older days keep their last one.
function backupsToPrune(names, now) {
  const recent = now - 2 * 24 * 3600 * 1000;
  const keepPerDay = new Map();
  const doomed = [];
  for (const name of [...names].sort()) {
    const m = /^project-(\d{4})-(\d\d)-(\d\d)(?:_(\d\d)-(\d\d)-(\d\d))?\.json$/.exec(name);
    if (!m) continue;
    const t = new Date(+m[1], m[2] - 1, +m[3], +(m[4] || 23), +(m[5] || 59), +(m[6] || 59)).getTime();
    if (t >= recent) continue;
    const day = name.slice(8, 18);
    if (keepPerDay.has(day)) doomed.push(keepPerDay.get(day));
    keepPerDay.set(day, name);
  }
  return doomed;
}

module.exports = { backupName, backupsToPrune, resultFileName, cleanResults, isAudio, audioName, safeName, uniquePath, atomicWrite, inside, isWebUrl, parseYtdlp };
