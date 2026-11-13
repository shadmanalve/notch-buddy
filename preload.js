const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = ['claude', 'media', 'clipboard', 'toggle', 'store', 'attention', 'hover', 'cursor', 'ask-update', 'ask-open'];

contextBridge.exposeInMainWorld('island', {
  setSize: (w, h) => ipcRenderer.send('set-size', { w, h }),
  setInteractive: on => ipcRenderer.send('interactive', !!on),
  log: (...a) => ipcRenderer.send('log', ...a),
  focusWindow: () => ipcRenderer.send('focus-window'),
  media: cmd => ipcRenderer.send('media-cmd', cmd),
  copy: text => ipcRenderer.send('copy', text),
  clearClips: () => ipcRenderer.send('clip-clear'),
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),
  focusComplete: () => ipcRenderer.send('focus-complete'),
  getStore: () => ipcRenderer.invoke('store-get'),
  setStore: patch => ipcRenderer.invoke('store-set', patch),
  getClaude: () => ipcRenderer.invoke('claude-get'),
  getClips: () => ipcRenderer.invoke('clips-get'),
  installHooks: () => ipcRenderer.invoke('install-hooks'),
  quit: () => ipcRenderer.send('quit'),
  pickApps: () => ipcRenderer.invoke('pick-apps'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  pickIcon: () => ipcRenderer.invoke('pick-icon'),
  launch: items => ipcRenderer.invoke('launch', items),
  ask: (reqId, prompt) => ipcRenderer.send('ask', { reqId, prompt }),
  askCancel: () => ipcRenderer.send('ask-cancel'),
  askReset: () => ipcRenderer.send('ask-reset'),
  readClipboard: () => ipcRenderer.invoke('clipboard-read'),
  on: (channel, fn) => {
    if (CHANNELS.includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  }
});
