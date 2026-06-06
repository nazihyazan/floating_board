const { contextBridge, ipcRenderer, webUtils } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('floatingBoard', {
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  togglePin: () => ipcRenderer.send('window:toggle-pin'),
  getWindowState: () => ipcRenderer.invoke('window:get-state'),
  getWindowBounds: () => ipcRenderer.invoke('window:get-bounds'),
  setWindowBounds: (bounds) => ipcRenderer.send('window:set-bounds', bounds),
  onWindowStatus: (callback) => subscribe('window:status', callback),

  loadBoard: () => ipcRenderer.invoke('board:load'),
  saveBoard: (data) => ipcRenderer.invoke('board:save', data),
  importMedia: (payload) => ipcRenderer.invoke('media:import', payload),
  importMediaUrl: (payload) => ipcRenderer.invoke('media:import-url', payload),
  isPremium: () => ipcRenderer.invoke('license:is-premium'),
  activateLicense: (key) => ipcRenderer.invoke('license:activate', key),
  openExternal: (url) => ipcRenderer.send('open-external', url),

  getFilePath: (file) => {
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        return webUtils.getPathForFile(file);
      }
      return file && typeof file.path === 'string' ? file.path : '';
    } catch (_error) {
      return '';
    }
  }
});
