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
  scanFolders: (folders, knownPaths) => ipcRenderer.invoke('scan-folders', folders, knownPaths),
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
  minimize: () => ipcRenderer.send('window-minimize'),

  // ---------- 桌面歌词悬浮窗 ----------
  // 主窗口用：开/关桌面歌词窗口
  toggleDesktopLyrics: open => ipcRenderer.invoke('toggle-desktop-lyrics', open),
  // 主窗口用：实时推送播放状态
  sendDesktopLyricsState: state => ipcRenderer.send('desktop-lyrics-state', state),
  // 主窗口用：推送外观配置
  sendDesktopLyricsConfig: config => ipcRenderer.send('desktop-lyrics-config', config),
  // 歌词窗口用：接收播放状态
  onDesktopLyricsState: handler => ipcRenderer.on('desktop-lyrics-state', (_event, state) => handler(state)),
  // 歌词窗口用：接收外观配置
  onDesktopLyricsConfig: handler => ipcRenderer.on('desktop-lyrics-config', (_event, config) => handler(config)),
  // 歌词窗口用：拉取当前配置
  getDesktopLyricsConfig: () => ipcRenderer.invoke('desktop-lyrics-get-config'),
  // 歌词窗口用：拉取最近一次播放状态
  getDesktopLyricsState: () => ipcRenderer.invoke('desktop-lyrics-get-state'),
  // 歌词窗口用：请求关闭自己
  hideDesktopLyrics: () => ipcRenderer.invoke('desktop-lyrics-hide'),
  // 歌词窗口用：跳到主窗口的桌面歌词设置区块
  openDesktopLyricsSettings: () => ipcRenderer.send('open-desktop-lyrics-settings'),
  // 歌词窗口用：接收主进程推来的「光标是否悬停在窗口内」状态（驱动发光光圈 + 工具按钮）
  onDesktopLyricsHover: handler => ipcRenderer.on('desktop-lyrics-hover', (_event, hovering) => handler(hovering)),
  // 歌词窗口用：手动缩放窗口（透明窗口无原生 resize 边框，由渲染层边缘手柄驱动）
  resizeDesktopLyrics: bounds => ipcRenderer.send('desktop-lyrics-resize', bounds),
  // 歌词窗口用：播放控制命令（shuffle / prev / play-pause / next / repeat）→ 经主进程转给主窗口
  sendDesktopLyricsControl: action => ipcRenderer.send('desktop-lyrics-control', action),
  // 主窗口用：接收桌面歌词窗口发来的播放控制命令
  onDesktopLyricsCommand: handler => ipcRenderer.on('desktop-lyrics-command', (_event, action) => handler(action)),
  // 主窗口用：桌面歌词窗口被关闭（悬浮窗✕ / 托盘）时回调，用于同步开关状态
  onDesktopLyricsClosed: handler => ipcRenderer.on('desktop-lyrics-closed', () => handler()),
  // 主窗口用：桌面歌词窗口请求跳转到设置区块
  onOpenDesktopLyricsSettings: handler => ipcRenderer.on('open-desktop-lyrics-settings', () => handler())
});
