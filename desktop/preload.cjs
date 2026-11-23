// The add window gets these four calls and nothing else from the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('freeaitokens', {
  providers: () => ipcRenderer.invoke('providers'),
  open: (url) => ipcRenderer.invoke('open', url),
  save: (id, key) => ipcRenderer.invoke('save', id, key),
  connect: (id) => ipcRenderer.invoke('connect', id),
});
