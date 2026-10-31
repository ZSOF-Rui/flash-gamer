const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('browserApi', {
  parse: (url) => ipcRenderer.invoke('browser:parse', url),
  openGameWindow: (id) => ipcRenderer.invoke('library:openWindow', id),
  flashState: () => ipcRenderer.invoke('browser:flashState'),
  onFlashReady: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('browser:flash-ready', handler);
    return () => ipcRenderer.removeListener('browser:flash-ready', handler);
  },
  onProgress: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on('browser:progress', handler);
    return () => ipcRenderer.removeListener('browser:progress', handler);
  }
});
