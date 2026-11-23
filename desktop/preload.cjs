// The add window gets these calls and nothing else from the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('freeaitokens', {
  strings: () => ipcRenderer.invoke('strings'),
  providers: () => ipcRenderer.invoke('providers'),
  open: (url) => ipcRenderer.invoke('open', url),
  save: (id, key, account) => ipcRenderer.invoke('save', id, key, account),
  connect: (id) => ipcRenderer.invoke('connect', id),
});
