const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tagApp', {
  platform: process.platform,
  setTheme: (opts) => ipcRenderer.send('theme', opts),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action) => cb(action))
});
