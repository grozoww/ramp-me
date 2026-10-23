const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rampme', {
  getContext: () => ipcRenderer.invoke('rampme:getContext'),
  applyRamp: (payload) => ipcRenderer.invoke('rampme:applyRamp', payload),
  clearRamp: (payload) => ipcRenderer.invoke('rampme:clearRamp', payload),
  applyFx: (payload) => ipcRenderer.invoke('rampme:applyFx', payload),
  clearFx: (payload) => ipcRenderer.invoke('rampme:clearFx', payload),
  getPrefs: () => ipcRenderer.invoke('rampme:getPrefs'),
  setPrefs: (prefs) => ipcRenderer.invoke('rampme:setPrefs', prefs),
  setPinned: (on) => ipcRenderer.invoke('rampme:setPinned', on),
  onContext: (cb) => {
    const handler = (_event, ctx) => cb(ctx);
    ipcRenderer.on('rampme:context', handler);
    return () => ipcRenderer.removeListener('rampme:context', handler);
  },
});
