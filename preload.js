'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Use ipcRenderer.send (NOT invoke) so renderer doesn't block waiting for return
  startScrape:   (opts) => ipcRenderer.send('scrape', opts),
  stop:          ()     => ipcRenderer.send('stop'),
  doneScrolling: ()     => ipcRenderer.send('done-scrolling'),

  pickFolder:    ()     => ipcRenderer.invoke('pick-folder'),
  revealFile:    (p)    => ipcRenderer.invoke('reveal-file', p),
  minimize:      ()     => ipcRenderer.invoke('win-min'),
  maximize:      ()     => ipcRenderer.invoke('win-max'),
  close:         ()     => ipcRenderer.invoke('win-close'),

  on: (ch, fn) => {
    const allowed = ['log', 'state', 'row', 'progress', 'total', 'done'];
    if (allowed.includes(ch)) ipcRenderer.on(ch, (_, d) => fn(d));
  }
});
