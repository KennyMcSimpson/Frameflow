const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('harness', {
  config: () => ipcRenderer.invoke('harness:config'),
  readDataUrl: (file) => ipcRenderer.invoke('harness:read-data-url', file),
  save: (name, dataUrl) => ipcRenderer.invoke('harness:save', name, dataUrl),
  log: (level, msg) => ipcRenderer.send('harness:log', level, String(msg)),
  done: (ok) => ipcRenderer.send('harness:done', !!ok),
});
