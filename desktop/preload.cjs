// Bridge between the GUI (public/app.js) and the desktop shell (main.js).
// The GUI only checks for `window.jobAlertDesktop`; in a normal browser it is
// undefined and the git/Docker update path is used instead.
//
// CommonJS on purpose: sandboxed preload scripts cannot be ES modules.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jobAlertDesktop', {
  platform: process.platform,
  openDataFolder: () => ipcRenderer.invoke('app:open-data-folder'),
  update: {
    getState: () => ipcRenderer.invoke('update:get-state'),
    check: () => ipcRenderer.invoke('update:check'),
    // Downloads, stops the app's processes (asking first if a job search is
    // running) and installs. On macOS it opens the release page instead.
    install: () => ipcRenderer.invoke('update:install'),
    onState: (fn) => {
      const listener = (_e, state) => fn(state);
      ipcRenderer.on('update:state', listener);
      return () => ipcRenderer.removeListener('update:state', listener);
    },
  },
});
