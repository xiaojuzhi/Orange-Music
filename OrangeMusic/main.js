const { app, BrowserWindow, shell, nativeImage, Menu, ipcMain, Tray, dialog } = require('electron');
const path = require('path');
const fsNode = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
let ffmpeg = null;
try { ffmpeg = require('@ffmpeg-installer/ffmpeg'); } catch (error) { console.warn('ffmpeg unavailable', error); }

let mainWindow = null;

const appIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'app.ico'));
const TITLE_BAR_HEIGHT = 52;
const tags = require('./renderer/tags.js');

let tray = null;
let windowBehavior = { closeToTray: false, minimizeToTray: false, autoStart: false };
const AUDIO_PATTERN = /\.(mp3|flac|aac|m4a|mp4|wav|alac|ogg|oga|opus|aiff|aif|wma|ape)$/i;

function readSidecarFor(filePath) {
  try {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, path.extname(filePath));
    const clean = value => value.toLowerCase().replace(/\s+/g, '');
    const entries = fsNode.readdirSync(dir).filter(name => /\.lrc$/i.test(name));
    const keys = new Map(entries.map(name => [clean(name.replace(/\.lrc$/i, '')), name]));
    const normalized = clean(base);
    const stripped = clean(base.replace(/^\d+[\s._\-]+/, ''));
    let match = keys.get(normalized) || keys.get(stripped);
    if (!match) {
      match = entries.find(name => {
        const key = clean(name.replace(/\.lrc$/i, ''));
        return key.startsWith(stripped) || stripped.startsWith(key);
      });
    }
    if (!match) return null;
    const text = decodeTextBuffer(fsNode.readFileSync(path.join(dir, match)));
    return text ? { text, path: path.join(dir, match) } : null;
  } catch (error) {
    return null;
  }
}

function fileLike(filePath) {
  const stat = fsNode.statSync(filePath);
  return {
    name: path.basename(filePath),
    size: stat.size,
    slice(start, end) {
      const from = start || 0;
      const length = Math.max(0, (end === undefined ? stat.size : end) - from);
      return {
        arrayBuffer: async () => {
          const fd = fsNode.openSync(filePath, 'r');
          try {
            const buffer = Buffer.alloc(Math.min(length, stat.size - from));
            fsNode.readSync(fd, buffer, 0, buffer.length, from);
            return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
          } finally {
            fsNode.closeSync(fd);
          }
        }
      };
    }
  };
}

function saveDataUrlCover(dataUrl) {
  try {
    const match = /^data:image\/([a-zA-Z+]+);base64,(.+)$/.exec(String(dataUrl || ''));
    if (!match) return '';
    const raw = Buffer.from(match[2], 'base64');
    if (!raw.length || raw.length > 12 * 1024 * 1024) return '';
    const ext = match[1].toLowerCase().includes('png') ? 'png' : 'jpg';
    const target = path.join(coversDir(), `cover-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.${ext}`);
    fsNode.writeFileSync(target, raw);
    return pathToFileURL(target).toString();
  } catch (error) {
    return '';
  }
}

async function readAudioMeta(filePath) {
  const file = fileLike(filePath);
  const name = path.basename(filePath);
  let meta = {};
  if (/\.mp3$/i.test(name)) meta = await tags.readId3(file).catch(() => ({}));
  else if (/\.(flac|ogg|oga|opus)$/i.test(name)) meta = await tags.readVorbisTags(file).catch(() => ({}));
  else if (/\.(m4a|mp4|aac|alac)$/i.test(name)) meta = await tags.readMp4Tags(file).catch(() => ({}));
  else if (/\.wav$/i.test(name)) meta = await tags.readWavTags(file).catch(() => ({}));
  const parts = tags.splitFileName(name);
  const extension = name.split('.').pop().toUpperCase();
  const aliases = { M4A: 'AAC', MP4: 'AAC', OGA: 'OGG', AIF: 'AIFF' };
  let duration = 0;
  try { duration = await tags.readDuration(file, filePath); } catch {}
  let tech = {};
  try { tech = await tags.readTechInfo(file, filePath); } catch {}
  let cover = meta.artwork ? saveDataUrlCover(meta.artwork) : '';
  if (!cover) cover = await extractArtworkToFile(filePath);
  const sidecar = readSidecarFor(filePath);
  const lyrics = (meta.lyrics && meta.lyrics.length)
    ? meta.lyrics
    : (meta.lyricsText ? tags.parseLyrics(meta.lyricsText) : (sidecar ? tags.parseLyrics(sidecar.text) : []));
  return {
    path: filePath,
    fileName: name,
    title: meta.title || parts.title || name.replace(/\.[^.]+$/, ''),
    artist: meta.artist || parts.artist || '',
    album: meta.album || path.basename(path.dirname(filePath)) || '',
    format: aliases[extension] || extension,
    duration: Math.round(duration || 0),
    cover: cover || '',
    size: fsNode.statSync(filePath).size,
    tech,
    lyrics,
    hasTags: Boolean(meta.title && meta.artist)
  };
}

function walkAudioFiles(dir, out, depth) {
  if (depth > 8 || out.length > 20000) return out;
  let entries = [];
  try { entries = fsNode.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkAudioFiles(full, out, depth + 1);
    else if (AUDIO_PATTERN.test(entry.name)) out.push(full);
  }
  return out;
}

async function extractArtworkToFile(sourcePath) {
  try {
    if (!ffmpeg?.path || !fsNode.existsSync(sourcePath)) return '';
    const output = path.join(coversDir(), `cover-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.jpg`);
    await runFfmpeg(['-y', '-i', sourcePath, '-map', '0:v:0', '-frames:v', '1', '-an', output]);
    return fsNode.existsSync(output) ? pathToFileURL(output).toString() : '';
  } catch (error) {
    return '';
  }
}

function windowFor(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

ipcMain.on('window-toggle-maximize', event => {
  const win = windowFor(event);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});

ipcMain.on('window-minimize', event => {
  windowFor(event)?.minimize();
});

function coversDir() {
  const dir = path.join(app.getPath('userData'), 'covers');
  try { fsNode.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function decodeTextBuffer(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes);
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    try {
      return new TextDecoder('gbk').decode(bytes);
    } catch (innerError) {
      return bytes.toString('utf8');
    }
  }
}

ipcMain.handle('to-file-url', (_event, filePath) => (filePath ? pathToFileURL(filePath).toString() : null));

ipcMain.handle('path-exists', (_event, filePath) => Boolean(filePath && fsNode.existsSync(filePath)));

// 读取一首歌的歌词：优先内嵌标签，其次同名 .lrc
ipcMain.handle('read-lyrics', async (_event, filePath) => {
  if (!filePath || !fsNode.existsSync(filePath)) return null;
  const result = { lyrics: [], source: '', text: '' };
  try {
    const file = fileLike(filePath);
    const name = path.basename(filePath);
    let meta = {};
    if (/\.mp3$/i.test(name)) meta = await tags.readId3(file).catch(() => ({}));
    else if (/\.(flac|ogg|oga|opus)$/i.test(name)) meta = await tags.readVorbisTags(file).catch(() => ({}));
    else if (/\.(m4a|mp4|aac|alac)$/i.test(name)) meta = await tags.readMp4Tags(file).catch(() => ({}));
    else if (/\.wav$/i.test(name)) meta = await tags.readWavTags(file).catch(() => ({}));
    if (meta.lyrics && meta.lyrics.length) {
      result.lyrics = meta.lyrics;
      result.source = 'embedded';
      return result;
    }
    if (meta.lyricsText) {
      result.lyrics = tags.parseLyrics(meta.lyricsText);
      result.text = meta.lyricsText;
      result.source = 'embedded';
      return result;
    }
  } catch (error) {
    // 忽略解析错误，继续尝试同名歌词文件
  }
  const sidecar = readSidecarFor(filePath);
  if (sidecar && sidecar.text) {
    result.lyrics = tags.parseLyrics(sidecar.text);
    result.text = sidecar.text;
    result.source = 'sidecar';
    result.path = sidecar.path;
  }
  return result;
});

ipcMain.handle('paths-exist', (_event, paths) => {
  if (!Array.isArray(paths)) return [];
  return paths.map(item => Boolean(item && fsNode.existsSync(item)));
});

ipcMain.handle('save-cover', (_event, dataUrl) => {
  try {
    const match = /^data:image\/([a-zA-Z+]+);base64,(.+)$/.exec(String(dataUrl || ''));
    if (!match) return null;
    const ext = match[1].toLowerCase().includes('png') ? 'png' : 'jpg';
    const raw = Buffer.from(match[2], 'base64');
    if (!raw.length || raw.length > 12 * 1024 * 1024) return null;
    const target = path.join(coversDir(), `cover-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.${ext}`);
    fsNode.writeFileSync(target, raw);
    return pathToFileURL(target).toString();
  } catch (error) {
    return null;
  }
});

// 找不到内嵌歌词时，去歌曲同目录找同名 .lrc（支持 GBK / UTF-8 编码）
ipcMain.handle('read-sidecar-lyrics', (_event, audioPath) => {
  try {
    if (!audioPath || !fsNode.existsSync(audioPath)) return null;
    const dir = path.dirname(audioPath);
    const base = path.basename(audioPath, path.extname(audioPath));
    const entries = fsNode.readdirSync(dir).filter(name => /\.lrc$/i.test(name));
    if (!entries.length) return null;
    const clean = value => value.toLowerCase().replace(/\s+/g, '');
    const keys = new Map(entries.map(name => [clean(name.replace(/\.lrc$/i, '')), name]));
    const normalized = clean(base);
    const stripped = clean(base.replace(/^\d+[\s._\-]+/, ''));
    let match = keys.get(normalized) || keys.get(stripped);
    if (!match) {
      match = entries.find(name => {
        const key = clean(name.replace(/\.lrc$/i, ''));
        return key.startsWith(stripped) || stripped.startsWith(key)
          || key.startsWith(normalized) || normalized.startsWith(key);
      });
    }
    if (!match) return null;
    const file = path.join(dir, match);
    const text = decodeTextBuffer(fsNode.readFileSync(file));
    return text ? { text, path: file } : null;
  } catch (error) {
    return null;
  }
});

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpeg?.path) {
      reject(new Error('ffmpeg is unavailable'));
      return;
    }
    const child = spawn(ffmpeg.path, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || ('ffmpeg exit ' + code))));
  });
}

ipcMain.handle('convert-audio', async (_event, sourcePath) => {
  if (!sourcePath || !fsNode.existsSync(sourcePath)) throw new Error('source file not found');
  const output = path.join(os.tmpdir(), 'orange-music-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.wav');
  await runFfmpeg(['-y', '-i', sourcePath, '-vn', '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2', output]);
  return pathToFileURL(output).toString();
});

ipcMain.handle('extract-artwork', async (_event, sourcePath) => {
  if (!sourcePath || !fsNode.existsSync(sourcePath)) return null;
  return (await extractArtworkToFile(sourcePath)) || null;
});

// 自动扫描：遍历文件夹并解析标签（主进程完成，速度快且不占用渲染进程）
ipcMain.handle('scan-folders', async (_event, folders) => {
  const results = [];
  const seen = new Set();
  for (const folder of Array.isArray(folders) ? folders : []) {
    if (!folder || !fsNode.existsSync(folder)) continue;
    for (const filePath of walkAudioFiles(folder, [], 0)) {
      const key = filePath.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        results.push(await readAudioMeta(filePath));
      } catch (error) {
        results.push({ path: filePath, fileName: path.basename(filePath), error: String(error && error.message) });
      }
      if (results.length > 20000) break;
    }
  }
  return results;
});

ipcMain.handle('pick-folder', async (event) => {
  const win = windowFor(event) || mainWindow;
  const result = await dialog.showOpenDialog(win, {
    title: '选择要自动扫描的音乐文件夹',
    properties: ['openDirectory', 'multiSelections']
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('pick-image', async (event) => {
  const win = windowFor(event) || mainWindow;
  const result = await dialog.showOpenDialog(win, {
    title: '选择图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle('save-image-as-cover', (_event, sourcePath) => {
  try {
    if (!sourcePath || !fsNode.existsSync(sourcePath)) return null;
    const ext = (path.extname(sourcePath) || '.jpg').toLowerCase();
    const target = path.join(coversDir(), `cover-${Date.now()}-${Math.random().toString(16).slice(2, 8)}${ext}`);
    fsNode.copyFileSync(sourcePath, target);
    return pathToFileURL(target).toString();
  } catch (error) {
    return null;
  }
});

ipcMain.handle('show-in-folder', (_event, filePath) => {
  try {
    if (!filePath || !fsNode.existsSync(filePath)) return false;
    shell.showItemInFolder(filePath);
    return true;
  } catch (error) {
    return false;
  }
});

ipcMain.handle('save-m3u', async (event, payload) => {
  const win = windowFor(event) || mainWindow;
  const result = await dialog.showSaveDialog(win, {
    title: '导出歌单',
    defaultPath: `${(payload && payload.name) || 'playlist'}.m3u`,
    filters: [{ name: 'M3U 歌单', extensions: ['m3u', 'm3u8'] }]
  });
  if (result.canceled || !result.filePath) return null;
  try {
    fsNode.writeFileSync(result.filePath, String((payload && payload.content) || ''), 'utf8');
    return result.filePath;
  } catch (error) {
    return null;
  }
});

ipcMain.handle('open-m3u', async (event) => {
  const win = windowFor(event) || mainWindow;
  const result = await dialog.showOpenDialog(win, {
    title: '导入歌单',
    properties: ['openFile'],
    filters: [{ name: 'M3U 歌单', extensions: ['m3u', 'm3u8'] }]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  try {
    const filePath = result.filePaths[0];
    const text = decodeTextBuffer(fsNode.readFileSync(filePath));
    const dir = path.dirname(filePath);
    const entries = text.split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .map(line => (path.isAbsolute(line) ? line : path.resolve(dir, line)));
    return { name: path.basename(filePath, path.extname(filePath)), entries };
  } catch (error) {
    return null;
  }
});

ipcMain.handle('read-paths-meta', async (_event, paths) => {
  const list = Array.isArray(paths) ? paths.slice(0, 5000) : [];
  const out = [];
  for (const filePath of list) {
    if (!filePath || !fsNode.existsSync(filePath)) continue;
    try {
      out.push(await readAudioMeta(filePath));
    } catch {}
  }
  return out;
});

ipcMain.on('window-behavior', (_event, options) => {
  windowBehavior = {
    closeToTray: Boolean(options?.closeToTray),
    minimizeToTray: Boolean(options?.minimizeToTray),
    autoStart: Boolean(options?.autoStart)
  };
  try {
    app.setLoginItemSettings({ openAtLogin: windowBehavior.autoStart, path: process.execPath });
  } catch (error) {
    console.warn('setLoginItemSettings failed', error);
  }
});

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray || appIcon.isEmpty()) return;
  try {
    tray = new Tray(appIcon.resize({ width: 16, height: 16 }));
    tray.setToolTip('Orange Music');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示 / 隐藏窗口', click: () => (mainWindow && mainWindow.isVisible() ? mainWindow.hide() : showMainWindow()) },
      { type: 'separator' },
      { label: '播放 / 暂停', click: () => sendToRenderer('tray-command', 'play-pause') },
      { label: '上一首', click: () => sendToRenderer('tray-command', 'prev') },
      { label: '下一首', click: () => sendToRenderer('tray-command', 'next') },
      { type: 'separator' },
      { label: '退出 Orange Music', click: () => { app.isQuitting = true; app.quit(); } }
    ]));
    tray.on('double-click', showMainWindow);
    tray.on('click', () => {
      if (mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized()) mainWindow.hide();
      else showMainWindow();
    });
  } catch (error) {
    console.warn('tray unavailable', error);
  }
}

function createWindow() {
  const windowOptions = {
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: 'rgba(0,0,0,0)', symbolColor: '#17181b', height: TITLE_BAR_HEIGHT },
    backgroundColor: '#ffffff',
    title: '',
    icon: appIcon.isEmpty() ? nativeImage.createEmpty() : appIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  };

  if (process.platform === 'win32') {
    windowOptions.backgroundMaterial = 'none';
  }

  mainWindow = new BrowserWindow(windowOptions);

  ipcMain.on('set-title-bar-overlay', (event, options) => {
    if (event.sender === mainWindow.webContents && typeof mainWindow.setTitleBarOverlay === 'function') {
      mainWindow.setTitleBarOverlay(options);
    }
  });

  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
    mainWindow.setTitle('');
  });

  mainWindow.once('ready-to-show', () => {
    if (typeof mainWindow.setTitleBarOverlay === 'function') {
      mainWindow.setTitleBarOverlay({ color: 'rgba(0,0,0,0)', symbolColor: '#17181b', height: TITLE_BAR_HEIGHT });
    }
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('close', event => {
    if (!app.isQuitting && windowBehavior.closeToTray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('minimize', event => {
    if (windowBehavior.minimizeToTray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    Menu.setApplicationMenu(null);
  }
  if (process.platform === 'win32' && app.setAppUserModelId) {
    app.setAppUserModelId('com.orange.music.desktop');
  }

  createWindow();
  createTray();

  app.on('before-quit', () => { app.isQuitting = true; });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
