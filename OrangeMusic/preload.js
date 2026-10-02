const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('orangeDesktop', {
  platform: process.platform,
  isDesktop: true,
  getPathForFile: file => {
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') return webUtils.getPathForFile(file);
    } catch (error) {}
    return file && file.path ? file.path : '';
  },
  convertAudio: sourcePath => ipcRenderer.invoke('convert-audio', sourcePath),
  extractArtwork: sourcePath => ipcRenderer.invoke('extract-artwork', sourcePath),
  toFileUrl: filePath => ipcRenderer.invoke('to-file-url', filePath),
  pathExists: filePath => ipcRenderer.invoke('path-exists', filePath),
  pathsExist: paths => ipcRenderer.invoke('paths-exist', paths),
  saveCover: dataUrl => ipcRenderer.invoke('save-cover', dataUrl),
  readSidecarLyrics: audioPath => ipcRenderer.invoke('read-sidecar-lyrics', audioPath),
  readLyrics: audioPath => ipcRenderer.invoke('read-lyrics', audioPath),
  scanFolders: folders => ipcRenderer.invoke('scan-folders', folders),
  readPathsMeta: paths => ipcRenderer.invoke('read-paths-meta', paths),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  pickImage: () => ipcRenderer.invoke('pick-image'),
  saveImageAsCover: sourcePath => ipcRenderer.invoke('save-image-as-cover', sourcePath),
  showInFolder: filePath => ipcRenderer.invoke('show-in-folder', filePath),
  saveM3u: payload => ipcRenderer.invoke('save-m3u', payload),
  openM3u: () => ipcRenderer.invoke('open-m3u'),
  setWindowBehavior: options => ipcRenderer.send('window-behavior', options),
  onTrayCommand: handler => ipcRenderer.on('tray-command', (_event, command) => handler(command)),
  setTitleBarOverlay: options => ipcRenderer.send('set-title-bar-overlay', options),
  toggleMaximize: () => ipcRenderer.send('window-toggle-maximize'),
  minimize: () => ipcRenderer.send('window-minimize')
});
