// The main window gets these calls and nothing else from the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('freeaitokens', {
  strings: () => ipcRenderer.invoke('strings'),
  lang: (code) => ipcRenderer.invoke('app:lang', code),
  status: () => ipcRenderer.invoke('app:status'),
  chat: (messages, model) => ipcRenderer.invoke('app:chat', messages, model),
  image: (prompt, model) => ipcRenderer.invoke('app:image', prompt, model),
  imageData: (image) => ipcRenderer.invoke('app:imageData', image),
  copyImage: (png) => ipcRenderer.invoke('app:copyImage', png),
  saveImage: (what) => ipcRenderer.invoke('app:saveImage', what),
  dropImages: (list) => ipcRenderer.invoke('app:dropImages', list),
  sort: (text) => ipcRenderer.invoke('app:sort', text),
  speech: (text) => ipcRenderer.invoke('app:speech', text),
  audioData: (audio) => ipcRenderer.invoke('app:audioData', audio),
  saveAudio: (audio) => ipcRenderer.invoke('app:saveAudio', audio),
  transcribe: () => ipcRenderer.invoke('app:transcribe'),
  usage: (days) => ipcRenderer.invoke('app:usage', days),
  login: (on) => ipcRenderer.invoke('app:login', on),
  updates: () => ipcRenderer.invoke('app:updates'),
  open: (url) => ipcRenderer.invoke('app:open', url),
  launch: (tool) => ipcRenderer.invoke('app:launch', tool),
  copy: (what) => ipcRenderer.invoke('app:copy', what),
  add: (id) => ipcRenderer.invoke('app:add', id),
});
