'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['viewer-join', 'viewer-leave', 'viewer-resume', 'signal', 'log', 'displays-changed', 'net-status'];

contextBridge.exposeInMainWorld('host', {
  state: () => ipcRenderer.invoke('state'),
  setPassword: pw => ipcRenderer.invoke('set-password', pw),
  setAutoStart: on => ipcRenderer.invoke('set-autostart', on),
  setKeepAwake: on => ipcRenderer.invoke('set-keepawake', on),
  setPort: p => ipcRenderer.invoke('set-port', p),
  setUpnp: on => ipcRenderer.invoke('set-upnp', on),
  recheckNet: () => ipcRenderer.invoke('recheck-net'),
  sources: () => ipcRenderer.invoke('sources'),
  qr: text => ipcRenderer.invoke('qr', text),
  toViewer: (id, data) => ipcRenderer.send('to-viewer', { id, data }),
  input: msg => ipcRenderer.send('input', msg),
  kick: id => ipcRenderer.send('kick', id),
  clipGet: () => ipcRenderer.invoke('clip-get'),
  clipSet: text => ipcRenderer.send('clip-set', text),
  openExternal: url => ipcRenderer.send('open-external', url),
  on: (ch, fn) => {
    if (EVENTS.includes(ch)) ipcRenderer.on(ch, (_e, d) => fn(d));
  }
});
