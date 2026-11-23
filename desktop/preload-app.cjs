// The main window gets these calls and nothing else from the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('freeaitokens', {
  status: () => ipcRenderer.invoke('app:status'),
  chat: (messages, model) => ipcRenderer.invoke('app:chat', messages, model),
  usage: (days) => ipcRenderer.invoke('app:usage', days),
  login: (on) => ipcRenderer.invoke('app:login', on),
  updates: () => ipcRenderer.invoke('app:updates'),
  open: (url) => ipcRenderer.invoke('app:open', url),
  launch: (tool) => ipcRenderer.invoke('app:launch', tool),
  copy: (what) => ipcRenderer.invoke('app:copy', what),
  add: (id) => ipcRenderer.invoke('app:add', id),
});
