const { contextBridge, ipcRenderer, webUtils } = require('electron');

const channels = ['project:load', 'project:switch', 'project:open', 'image:pick', 'image:write', 'image:read', 'lib:pick', 'lib:import', 'lib:trash', 'lib:reveal', 'web:external', 'yt:ready', 'yt:install', 'yt:grab', 'yt:stream', 'find:search', 'find:add', 'update:install', 'pdf:export'];
const api = Object.fromEntries(channels.map((c) => [c, (...args) => ipcRenderer.invoke(c, ...args)]));

contextBridge.exposeInMainWorld('api', {
  ...api,
  save: (text) => ipcRenderer.sendSync('project:save', text),
  pathOf: (file) => webUtils.getPathForFile(file),
  onUpdate: (fn) => ipcRenderer.on('update:ready', (_e, version) => fn(version)),
  onResults:(fn) => ipcRenderer.on('find:results', (_e, d) => fn(d)),
  onDownload: (update, done) => {
    ipcRenderer.on('dl:update', (_e, d) => update(d));
    ipcRenderer.on('dl:done', (_e, d) => done(d));
  },
});
