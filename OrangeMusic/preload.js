const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * 向渲染进程暴露的唯一桥接对象。
 * 渲染进程开启 contextIsolation + sandbox，拿不到 Node，只能通过这里的白名单方法与主进程通信。
 * 命名与返回值一律「失败返回 null / false / 空串」，调用侧无需再包 try/catch。
 */
contextBridge.exposeInMainWorld('orangeDesktop', {
  platform: process.platform,
  isDesktop: true,

  /** 拖放进来的 File 对象 -> 磁盘绝对路径（新版 Electron 用 webUtils，旧版回落到 file.path） */
  getPathForFile: file => {
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') return webUtils.getPathForFile(file);
    } catch (error) {}
    return file && file.path ? file.path : '';
  },

  // ---------- 音频 / 封面 / 歌词 ----------
  convertAudio: sourcePath => ipcRenderer.invoke('convert-audio', sourcePath),
  extractArtwork: sourcePath => ipcRenderer.invoke('extract-artwork', sourcePath),
  toFileUrl: filePath => ipcRenderer.invoke('to-file-url', filePath),
  coverThumbnail: filePath => ipcRenderer.invoke('cover-thumbnail', filePath),
  pathExists: filePath => ipcRenderer.invoke('path-exists', filePath),
  pathsExist: paths => ipcRenderer.invoke('paths-exist', paths),
  saveCover: dataUrl => ipcRenderer.invoke('save-cover', dataUrl),
  /** 传入资料库仍在引用的封面文件名，主进程据此回收其余孤儿封面 */
  pruneCovers: keepNames => ipcRenderer.invoke('prune-covers', keepNames),
  readSidecarLyrics: audioPath => ipcRenderer.invoke('read-sidecar-lyrics', audioPath),
  readLyrics: audioPath => ipcRenderer.invoke('read-lyrics', audioPath),

  // ---------- 扫描与批量元信息 ----------
  scanFolders: folders => ipcRenderer.invoke('scan-folders', folders),
  readPathsMeta: paths => ipcRenderer.invoke('read-paths-meta', paths),

  // ---------- 系统对话框与文件操作 ----------
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  pickImage: () => ipcRenderer.invoke('pick-image'),
  saveImageAsCover: sourcePath => ipcRenderer.invoke('save-image-as-cover', sourcePath),
  showInFolder: filePath => ipcRenderer.invoke('show-in-folder', filePath),
  saveM3u: payload => ipcRenderer.invoke('save-m3u', payload),
  openM3u: () => ipcRenderer.invoke('open-m3u'),

  // ---------- 窗口与托盘 ----------
  setWindowBehavior: options => ipcRenderer.send('window-behavior', options),
  onTrayCommand: handler => ipcRenderer.on('tray-command', (_event, command) => handler(command)),
  setTitleBarOverlay: options => ipcRenderer.send('set-title-bar-overlay', options),
  toggleMaximize: () => ipcRenderer.send('window-toggle-maximize'),
  minimize: () => ipcRenderer.send('window-minimize')
});
