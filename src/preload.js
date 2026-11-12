'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['viewer-join', 'viewer-leave', 'viewer-resume', 'signal', 'log', 'displays-changed', 'net-status', 'relay-status'];

contextBridge.exposeInMainWorld('host', {
  state: () => ipcRenderer.invoke('state'),
  setPassword: pw => ipcRenderer.invoke('set-password', pw),
  setAutoStart: on => ipcRenderer.invoke('set-autostart', on),
  setUnattended: on => ipcRenderer.invoke('set-unattended', on),
  openViewer: () => ipcRenderer.send('open-viewer'),
  copyText: t => ipcRenderer.send('copy-text', t),
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
