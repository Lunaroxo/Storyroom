const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('../core');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'storyroom-'));

test('audioName accepts audio by extension or mime and rejects the rest', () => {
  assert.equal(core.audioName('boom.mp3', 'application/octet-stream'), 'boom.mp3');
  assert.equal(core.audioName('download', 'audio/mpeg; charset=x'), 'download.mp3');
  assert.equal(core.audioName('setup.exe', 'application/octet-stream'), null);
  assert.equal(core.audioName('pack.zip', 'application/zip'), null);
});

test('resultFileName uses the URL extension, then the mime type', () => {
  assert.equal(core.resultFileName('A: B', 'https://x.co/a.mp3?t=1', ''), 'A_ B.mp3');
  assert.equal(core.resultFileName('Song', 'https://x.co/track/1/stream/', 'audio/mpeg'), 'Song.mp3');
  assert.equal(core.resultFileName('Page', 'https://x.co/p', 'text/html'), null);
});

test('cleanResults drops bad rows and non-web links', () => {
  const out = core.cleanResults([null, { title: 'ok', audio: 'https://a/b.mp3', duration: 3 }, { title: 'x', audio: 'javascript:alert(1)', page: 'file:///c' }, { audio: 'https://a/c.mp3' }], { name: 'S', license: 'L' });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { title: 'ok', artist: '', source: 'S', license: 'L', audio: 'https://a/b.mp3', page: '', duration: 3 });
  assert.deepEqual(core.cleanResults('nope', { name: 'S' }), []);
});

test('safeName strips directories and illegal characters', () => {
  assert.equal(core.safeName('..\\..\\evil.mp3'), 'evil.mp3');
  assert.equal(core.safeName('a:b?.wav'), 'a_b_.wav');
  assert.equal(core.safeName('...'), 'file');
});

test('uniquePath never returns an existing file', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.mp3'), '');
  assert.equal(path.basename(core.uniquePath(dir, 'a.mp3')), 'a (2).mp3');
  assert.equal(path.basename(core.uniquePath(dir, 'b.mp3')), 'b.mp3');
});

test('atomicWrite replaces content and leaves no temp file', () => {
  const file = path.join(tmp(), 'p.json');
  core.atomicWrite(file, 'one');
  core.atomicWrite(file, 'two');
  assert.equal(fs.readFileSync(file, 'utf8'), 'two');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['p.json']);
});

test('inside refuses paths that escape the project', () => {
  const root = tmp();
  assert.equal(core.inside(root, 'images/a.png'), path.join(root, 'images', 'a.png'));
  assert.throws(() => core.inside(root, '../secret.txt'));
  assert.throws(() => core.inside(root, 'C:\\Windows\\win.ini'));
  assert.throws(() => core.inside(root, '.'));
});

test('isWebUrl only allows http and https', () => {
  assert.ok(core.isWebUrl('https://pixabay.com/x'));
  assert.ok(!core.isWebUrl('file:///C:/x'));
  assert.ok(!core.isWebUrl('--exec=calc'));
});

test('parseYtdlp reads progress and the finished-file line', () => {
  assert.deepEqual(core.parseYtdlp('[download]  42.5% of 3.00MiB'), { pct: 42.5 });
  assert.deepEqual(core.parseYtdlp('C:\\lib\\a.m4a\tSong\tNA\t61.0'), { done: { file: 'C:\\lib\\a.m4a', title: 'Song', artist: '', duration: 61 } });
  assert.equal(core.parseYtdlp('[youtube] extracting'), null);
});
