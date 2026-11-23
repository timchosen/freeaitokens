// The main window gets these calls and nothing else from the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('freeaitokens', {
  status: () => ipcRenderer.invoke('app:status'),
  chat: (messages) => ipcRenderer.invoke('app:chat', messages),
  launch: (tool) => ipcRenderer.invoke('app:launch', tool),
  copy: (what) => ipcRenderer.invoke('app:copy', what),
  add: (id) => ipcRenderer.invoke('app:add', id),
});
