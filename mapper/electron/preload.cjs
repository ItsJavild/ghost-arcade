const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('mapper', {
  status: () => ipcRenderer.invoke('ndi:status'),
  sources: () => ipcRenderer.invoke('ndi:sources'),
  connect: name => ipcRenderer.invoke('ndi:connect', name),
  disconnect: () => ipcRenderer.invoke('ndi:disconnect'),
  frame: () => ipcRenderer.invoke('ndi:frame'),
  displays: () => ipcRenderer.invoke('displays'),
  openOutput: (id, displayId) => ipcRenderer.invoke('output:open', { id, displayId }),
  closeOutputs: () => ipcRenderer.invoke('output:close'),
  ready: info => ipcRenderer.invoke('smoke:ready', info).catch(() => undefined),
});
