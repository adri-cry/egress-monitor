const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel, callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('deck', {
  isDesktop: true,

  // state + actions
  getState: () => ipcRenderer.invoke('deck:state'),
  refresh: () => ipcRenderer.invoke('deck:refresh'),
  rotate: () => ipcRenderer.invoke('deck:rotate'),
  selectConfig: (name) => ipcRenderer.invoke('deck:select-config', String(name)),
  clearLogs: (tab) => ipcRenderer.invoke('deck:logs:clear', String(tab)),
  connect: () => ipcRenderer.invoke('deck:connect'),
  disconnect: () => ipcRenderer.invoke('deck:disconnect'),
  setToggle: (id, enabled) => ipcRenderer.invoke('deck:toggle', String(id), Boolean(enabled)),
  launch: (kind) => ipcRenderer.invoke('deck:launch', String(kind)),

  // paths
  choosePoolDir: () => ipcRenderer.invoke('deck:pool:choose'),
  chooseClientLog: () => ipcRenderer.invoke('deck:log:choose'),
  openPool: () => ipcRenderer.invoke('deck:pool:open'),
  openLogs: () => ipcRenderer.invoke('deck:logs:open'),
  copyText: (text) => ipcRenderer.invoke('deck:copy', String(text)),

  // subscriptions
  onState: (callback) => subscribe('deck:state', callback),
  onLog: (callback) => subscribe('deck:log', callback),

  // frameless window
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    onMaximizedChange: (callback) => subscribe('window:maximized-state', callback),
  },
});
