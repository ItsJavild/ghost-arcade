const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('mapper', {
  readRig: () => ipcRenderer.invoke('rig:read'),
  saveRig: text => ipcRenderer.invoke('rig:save',text),
  outputStatus: () => ipcRenderer.invoke('output:status'),
  status: () => ipcRenderer.invoke('ndi:status'),
  statistics: () => ipcRenderer.invoke('ndi:statistics'),
  sources: () => ipcRenderer.invoke('ndi:sources'),
  connect: name => ipcRenderer.invoke('ndi:connect', name),
  disconnect: () => ipcRenderer.invoke('ndi:disconnect'),
  frame: () => ipcRenderer.invoke('ndi:frame'),
  displays: () => ipcRenderer.invoke('displays'),
  openOutput: (id, displayId) => ipcRenderer.invoke('output:open', { id, displayId }),
  closeOutputs: () => ipcRenderer.invoke('output:close'),
  ready: info => ipcRenderer.invoke('smoke:ready', info).catch(() => undefined),
});
