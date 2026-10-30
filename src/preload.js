const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  list: () => ipcRenderer.invoke('library:list'),
  inspect: (url) => ipcRenderer.invoke('inspect', url),
  add: (payload) => ipcRenderer.invoke('library:add', payload),
  play: (id) => ipcRenderer.invoke('library:play', id),
  openWindow: (id) => ipcRenderer.invoke('library:openWindow', id),
  openBrowser: () => ipcRenderer.invoke('browser:open'),
  remove: (id) => ipcRenderer.invoke('library:remove', id),
  reveal: (id) => ipcRenderer.invoke('library:reveal', id),
  importSwf: () => ipcRenderer.invoke('library:import'),
  importPath: (p) => ipcRenderer.invoke('library:importPath', p),
  cacheStats: (id) => ipcRenderer.invoke('library:cacheStats', id),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
  onProgress: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on('inspect:progress', handler);
    return () => ipcRenderer.removeListener('inspect:progress', handler);
  },
  onLibraryChanged: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('library:changed', handler);
    return () => ipcRenderer.removeListener('library:changed', handler);
  }
});
