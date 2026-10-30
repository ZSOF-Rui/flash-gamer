const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('browserApi', {
  parse: (url) => ipcRenderer.invoke('browser:parse', url),
  openGameWindow: (id) => ipcRenderer.invoke('library:openWindow', id),
  onProgress: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on('browser:progress', handler);
    return () => ipcRenderer.removeListener('browser:progress', handler);
  }
});
