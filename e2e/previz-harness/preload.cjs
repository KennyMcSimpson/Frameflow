const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ph', {
  config: () => ipcRenderer.invoke('ph:config'),
  save: (name, dataUrl) => ipcRenderer.invoke('ph:save', name, dataUrl),
  log: (level, msg) => ipcRenderer.send('ph:log', level, String(msg)),
  done: (ok) => ipcRenderer.send('ph:done', !!ok),
});
