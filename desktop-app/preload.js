const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopUpdates', {
  isDesktop: true,
  login: (payload) => ipcRenderer.invoke('auth:login', payload),
  logout: () => ipcRenderer.invoke('auth:logout'),
  role: () => ipcRenderer.invoke('auth:role'),
  changePassword: (payload) => ipcRenderer.invoke('auth:change-password', payload),
  sendContact: (payload) => ipcRenderer.invoke('contact:send', payload),
  getContactMessages: () => ipcRenderer.invoke('contact:list'),
  getContactThread: (clientId) => ipcRenderer.invoke('contact:thread', clientId),
  replyContactMessage: (payload) => ipcRenderer.invoke('contact:reply', payload),
  updateContactMessage: (payload) => ipcRenderer.invoke('contact:update-status', payload),
  heartbeat: () => ipcRenderer.invoke('auth:heartbeat'),
  serverStatus: () => ipcRenderer.invoke('server:status'),
  check: () => ipcRenderer.invoke('updates:check'),
  apply: () => ipcRenderer.invoke('updates:apply'),
  checkExe: () => ipcRenderer.invoke('updates:exe-check'),
  downloadExe: () => ipcRenderer.invoke('updates:exe-download'),
  installExe: () => ipcRenderer.invoke('updates:exe-install'),
  readSource: () => ipcRenderer.invoke('source:read'),
  publishSource: (payload) => ipcRenderer.invoke('source:publish', payload),
  reloadUpdated: () => ipcRenderer.invoke('app:reload-updated'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  showError: (message) => ipcRenderer.invoke('app:show-error', message)
});
