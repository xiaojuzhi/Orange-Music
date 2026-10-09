/**
 * Orange Music —— Electron 主进程
 * 职责：窗口 / 托盘 / 菜单、本地文件扫描与标签解析、封面与歌词落盘、ffmpeg 转码。
 */
const { app, BrowserWindow, shell, nativeImage, Menu, ipcMain, Tray, dialog } = require('electron');
const path = require('path');
const fsNode = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

// 标签 / 歌词解析与渲染进程共用同一份实现，避免两边各写一套（主进程负责自动扫描时用）
const tags = require('./renderer/tags.js');
// 主进程直接复用 tags.js 里的文本解码（自动处理 BOM / UTF-8 / GBK），不再重复实现一份
const { decodeTextBuffer } = tags;

let ffmpeg = null;
try {
  ffmpeg = require('@ffmpeg-installer/ffmpeg');
} catch (error) {
  console.warn('ffmpeg unavailable', error);
}

const appIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'app.ico'));
const TITLE_BAR_HEIGHT = 52;

/** @type {BrowserWindow | null} 主窗口（关闭后置空） */
let mainWindow = null;
/** @type {Tray | null} 托盘图标 */
let tray = null;
/** 托盘 / 关闭行为的用户偏好，由渲染进程通过 window-behavior 通道同步 */
let windowBehavior = { closeToTray: false, minimizeToTray: false, autoStart: false };

/** 扫描时识别的音频扩展名 */
const AUDIO_PATTERN = /\.(mp3|flac|aac|m4a|mp4|wav|alac|ogg|oga|opus|aiff|aif|wma|ape)$/i;
/** 自动扫描的规模上限：单目录递归深度、总文件数 */
const SCAN_MAX_DEPTH = 8;
const SCAN_MAX_FILES = 20000;
/** ffmpeg 单次调用的最长等待时间，避免个别损坏文件把进程一直挂住 */
const FFMPEG_TIMEOUT_MS = 5 * 60 * 1000;
/** 转码产物落在系统临时目录时统一使用的前缀，便于启动时清理旧文件 */
const TEMP_AUDIO_PREFIX = 'orange-music-';
/** 启动时清理超过该时长的历史转码产物 */
const TEMP_AUDIO_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** 封面目录里由本程序写出的文件名：cover-*.jpg / .png / .webp / .bmp（含历史命名与抽取过程中的临时名） */
const COVER_NAME_PATTERN = /^cover-[\w.-]+\.(?:jpe?g|png|webp|bmp)$/i;

/**
 * 归一化歌词文件名，得到用于比对的键。
 * 除大小写与空格外，还要抹平「多歌手署名分隔符」的差异：
 * 曲库里的音频与 .lrc 常由不同工具生成，同一个歌手列表可能写成
 * `A, B` / `A;B` / `A、B` / `A&B`，只要分隔符不同，同名歌词就会对不上。
 * 这些符号在文件名里只起分隔作用，统一剔除不影响区分度。
 * @param {string} value 文件名（不含扩展名）
 * @returns {string} 归一化后的比对键
 */
function normalizeLyricKey(value) {
  return String(value)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[,;、&/／|·・]+/g, '');
}

/**
 * 在音频同目录查找「同名 .lrc」歌词。
 * 比对策略（由严到宽）：完全同名 → 去掉开头序号后同名 → 前缀互相包含。
 * 直连读取和整库扫描都走这一个实现，避免两处匹配规则不一致。
 * @returns {{text: string, path: string} | null}
 */
function readSidecarFor(filePath) {
  try {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, path.extname(filePath));
    const entries = fsNode.readdirSync(dir).filter(name => /\.lrc$/i.test(name));
    if (!entries.length) return null;

    const keys = new Map(entries.map(name => [normalizeLyricKey(name.replace(/\.lrc$/i, '')), name]));
    const normalized = normalizeLyricKey(base);
    // 有些曲库会给文件加「01. 」这类序号前缀，去掉后再比对一次
    const stripped = normalizeLyricKey(base.replace(/^\d+[\s._\-]+/, ''));

    let match = keys.get(normalized) || keys.get(stripped);
    if (!match) {
      match = entries.find(name => {
        const key = normalizeLyricKey(name.replace(/\.lrc$/i, ''));
        return key.startsWith(stripped)
          || stripped.startsWith(key)
          || key.startsWith(normalized)
          || normalized.startsWith(key);
      });
    }
    if (!match) return null;

    const target = path.join(dir, match);
    const text = decodeTextBuffer(fsNode.readFileSync(target));
    return text ? { text, path: target } : null;
  } catch (error) {
    return null;
  }
}

/**
 * 把 Node 文件包装成 tags.js 需要的「类 File」对象。
 * tags.js 由渲染进程与主进程共用，渲染进程拿到的是浏览器 File；
 * 主进程里用这个薄壳提供同名的 name / size / slice().arrayBuffer() 接口。
 */
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
          const target = Buffer.alloc(Math.min(length, Math.max(0, stat.size - from)));
          if (!target.length) return target.buffer;
          const fd = fsNode.openSync(filePath, 'r');
          try {
            // readSync 在个别情况下会短读，循环读到填满为止
            let offset = 0;
            while (offset < target.length) {
              const read = fsNode.readSync(fd, target, offset, target.length - offset, from + offset);
              if (read <= 0) break;
              offset += read;
            }
            return target.buffer.slice(target.byteOffset, target.byteOffset + offset);
          } finally {
            fsNode.closeSync(fd);
          }
        }
      };
    }
  };
}

/** 计算二进制内容的 md5（只用于给封面命名，让同一张图落到同一个文件） */
function md5Hex(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

/**
 * 生成封面文件名。
 * 用「图片内容」而不是时间戳 + 随机数命名：同一张图算出来的名字必然相同，
 * 于是反复导入 / 重新扫描整库都只会命中同一个文件，封面目录不会再各存一份副本。
 * （历史版本用的是 cover-<时间戳>-<随机数>.jpg，每保存一次就是一个新文件、且全程没有
 *   任何回收逻辑，正是这个目录能堆到几百 MB 的根因。）
 * @param {Buffer} bytes 图片二进制内容
 * @param {string} ext 扩展名（不含点）
 */
function coverFileName(bytes, ext) {
  return `cover-${md5Hex(bytes)}.${ext}`;
}

/** 删除一个可能存在也可能不存在的文件（失败静默，清理路径专用） */
function removeFileIfExists(target) {
  try { if (fsNode.existsSync(target)) fsNode.unlinkSync(target); } catch {}
}

/** 抽取封面过程中使用的临时文件名；无论成功失败都会被改名或清掉 */
function tempCoverName() {
  return `cover-tmp-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.jpg`;
}

/**
 * 把 data:image/...;base64,... 写成用户数据目录下的封面文件。
 * 内容相同的图片会命中同一个文件名，已经存在就直接复用，不再重写。
 * @returns {string} 成功后返回 file:// URL，失败返回空串
 */
function saveDataUrlCover(dataUrl) {
  try {
    const match = /^data:image\/([a-zA-Z+]+);base64,(.+)$/.exec(String(dataUrl || ''));
    if (!match) return '';
    const raw = Buffer.from(match[2], 'base64');
    if (!raw.length || raw.length > 12 * 1024 * 1024) return '';
    const ext = match[1].toLowerCase().includes('png') ? 'png' : 'jpg';
    const target = path.join(coversDir(), coverFileName(raw, ext));
    if (!fsNode.existsSync(target)) fsNode.writeFileSync(target, raw);
    return pathToFileURL(target).toString();
  } catch (error) {
    return '';
  }
}

/**
 * 解析单个音频文件的完整元信息（标题 / 歌手 / 时长 / 封面 / 歌词 / 技术参数）。
 * 自动扫描与「按路径补全资料」都走这里。
 */
async function readAudioMeta(filePath) {
  const file = fileLike(filePath);
  const name = path.basename(filePath);
  let meta = {};
  if (/\.mp3$/i.test(name)) meta = await tags.readId3(file).catch(() => ({}));
  else if (/\.(flac|ogg|oga|opus)$/i.test(name)) meta = await tags.readVorbisTags(file).catch(() => ({}));
  else if (/\.(m4a|mp4|aac|alac)$/i.test(name)) meta = await tags.readMp4Tags(file).catch(() => ({}));
  else if (/\.wav$/i.test(name)) meta = await tags.readWavTags(file).catch(() => ({}));

  const parts = tags.splitFileName(name);
  const extension = name.includes('.') ? name.split('.').pop().toUpperCase() : name.toUpperCase();
  const aliases = { M4A: 'AAC', MP4: 'AAC', OGA: 'OGG', AIF: 'AIFF' };

  let duration = 0;
  try { duration = await tags.readDuration(file, filePath); } catch {}
  let tech = {};
  try { tech = await tags.readTechInfo(file, filePath); } catch {}

  // 封面优先用内嵌图片，没有再让 ffmpeg 从文件里抽一帧
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
    size: file.size,
    tech,
    lyrics,
    hasTags: Boolean(meta.title && meta.artist)
  };
}

/** 递归收集目录下的音频文件；用深度 + 数量双上限防止极端目录结构把内存撑爆 */
function walkAudioFiles(dir, out, depth) {
  if (depth > SCAN_MAX_DEPTH || out.length > SCAN_MAX_FILES) return out;
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

/**
 * 用 ffmpeg 从音频里抽一帧当封面（内嵌图片缺失时的兜底）。
 * 每次调用都会拉起一个 ffmpeg 子进程，整库扫描时开销不小，
 * 所以调用方必须先用内嵌封面兜一遍热点路径。
 *
 * ffmpeg 只能按给定文件名输出，没法直接算出内容 md5，因此先写到一个临时名，
 * 读回内容算出 md5 后再改成最终名；若同名文件已存在（同一张封面抽过）就丢弃临时文件。
 * @returns {string} 成功返回 file:// URL，失败返回空串
 */
async function extractArtworkToFile(sourcePath) {
  if (!ffmpeg?.path || !fsNode.existsSync(sourcePath)) return '';
  const dir = coversDir();
  const temp = path.join(dir, tempCoverName());
  try {
    await runFfmpeg(['-y', '-i', sourcePath, '-map', '0:v:0', '-frames:v', '1', '-an', temp]);
    if (!fsNode.existsSync(temp) || fsNode.statSync(temp).size === 0) {
      removeFileIfExists(temp);
      return '';
    }
    const target = path.join(dir, coverFileName(fsNode.readFileSync(temp), 'jpg'));
    if (fsNode.existsSync(target)) removeFileIfExists(temp);
    else fsNode.renameSync(temp, target);
    return pathToFileURL(target).toString();
  } catch (error) {
    // 失败时清掉 ffmpeg 可能已经写出的半成品文件，避免封面目录堆积垃圾
    removeFileIfExists(temp);
    return '';
  }
}

/** 由 IPC 事件反查发起请求的窗口 */
function windowFor(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

// ---------- 无边框窗口的自定义标题栏按钮 ----------
ipcMain.on('window-toggle-maximize', event => {
  const win = windowFor(event);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});

ipcMain.on('window-minimize', event => {
  windowFor(event)?.minimize();
});

/** 封面落盘目录（userData/covers），不存在时自动创建 */
function coversDir() {
  const dir = path.join(app.getPath('userData'), 'covers');
  try { fsNode.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

/**
 * 回收封面目录里不再被资料库引用的图片。
 *
 * 只有渲染进程知道「哪些封面还在用」（资料库存在 localStorage 里），所以保留名单
 * 必须由它传进来；这里只做删除动作。三条安全约束：
 *   1. 保留名单为空时直接返回 —— 资料库没能正常读出时绝不误删；
 *   2. 只处理 covers/ 下符合 COVER_NAME_PATTERN 的文件，目录里的其它东西一律不碰；
 *   3. 命中保留名单的文件原样留下。
 * @param {string[]} keepNames 需要保留的文件名（不含路径）
 * @returns {number} 实际删除的文件数
 */
ipcMain.handle('prune-covers', (_event, keepNames) => {
  const keep = new Set((Array.isArray(keepNames) ? keepNames : []).map(String));
  if (!keep.size) return 0;
  let removed = 0;
  try {
    const dir = coversDir();
    for (const name of fsNode.readdirSync(dir)) {
      if (keep.has(name) || !COVER_NAME_PATTERN.test(name)) continue;
      try { fsNode.unlinkSync(path.join(dir, name)); removed += 1; } catch {}
    }
  } catch (error) {
    console.warn('pruneCovers failed', error);
  }
  return removed;
});

/** 本地绝对路径 -> file:// URL */
ipcMain.handle('to-file-url', (_event, filePath) => (filePath ? pathToFileURL(filePath).toString() : null));

// 把封面解码成 32px 的缩略图 dataURL，供渲染进程取主色。
// 为什么要绕这一圈：file:// 的图片直接 drawImage 进 canvas 会把 canvas 标记为
// tainted，再调 getImageData 会抛 SecurityError，取色永远失败。
// 让主进程用 nativeImage 解码后转成 data: URL（同源），取像素就一定成功。
ipcMain.handle('cover-thumbnail', (_event, filePath) => {
  try {
    if (!filePath || !fsNode.existsSync(filePath)) return null;
    const image = nativeImage.createFromPath(filePath);
    if (image.isEmpty()) return null;
    const size = image.getSize();
    const longest = Math.max(size.width, size.height, 1);
    const scale = 32 / longest;
    const thumb = image.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: 'good'
    });
    return thumb.toDataURL();
  } catch (error) {
    return null;
  }
});

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

// 渲染进程把 dataURL 封面交回来落盘；失败统一回落 null
ipcMain.handle('save-cover', (_event, dataUrl) => saveDataUrlCover(dataUrl) || null);

// 找不到内嵌歌词时，去歌曲同目录找同名 .lrc（支持 GBK / UTF-8 编码）
// 匹配规则与整库扫描共用 readSidecarFor，避免两处逻辑漂移
ipcMain.handle('read-sidecar-lyrics', (_event, audioPath) => {
  if (!audioPath || !fsNode.existsSync(audioPath)) return null;
  return readSidecarFor(audioPath);
});

/**
 * 调用随包的 ffmpeg。
 * - 统一收集 stderr 便于报错，但只保留尾部片段，避免大文件把内存吃满；
 * - 加超时保护，损坏文件不会让进程一直挂着。
 */
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpeg?.path) {
      reject(new Error('ffmpeg is unavailable'));
      return;
    }
    const child = spawn(ffmpeg.path, args, { windowsHide: true });
    const stderrChunks = [];
    let stderrLength = 0;
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('ffmpeg timeout'));
    }, FFMPEG_TIMEOUT_MS);

    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderrLength += text.length;
      stderrChunks.push(text);
      // 只保留最后 ~8KB，足够定位问题又不会无限增长
      while (stderrLength > 8192 && stderrChunks.length > 1) {
        stderrLength -= stderrChunks.shift().length;
      }
    });
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (code === 0) finish();
      else finish(new Error(stderrChunks.join('') || `ffmpeg exit ${code}`));
    });
  });
}

/** 清理历史遗留的转码产物（只删自己写出的、且超过保留时长的文件） */
function pruneTempAudioFiles() {
  try {
    const dir = os.tmpdir();
    const now = Date.now();
    for (const name of fsNode.readdirSync(dir)) {
      if (!name.startsWith(TEMP_AUDIO_PREFIX) || !name.endsWith('.wav')) continue;
      const target = path.join(dir, name);
      try {
        if (now - fsNode.statSync(target).mtimeMs > TEMP_AUDIO_MAX_AGE_MS) fsNode.unlinkSync(target);
      } catch {}
    }
  } catch (error) {
    console.warn('pruneTempAudioFiles failed', error);
  }
}

/**
 * 把不支持的音频转成 44.1kHz 立体声 WAV 落到系统临时目录，交给渲染进程播放。
 * 产物由 pruneTempAudioFiles 在下次启动时按龄清理。
 */
ipcMain.handle('convert-audio', async (_event, sourcePath) => {
  if (!sourcePath || !fsNode.existsSync(sourcePath)) throw new Error('source file not found');
  const output = path.join(os.tmpdir(), `${TEMP_AUDIO_PREFIX}${Date.now()}-${Math.random().toString(16).slice(2)}.wav`);
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
  const list = Array.isArray(folders) ? folders : [];
  for (const folder of list) {
    if (results.length >= SCAN_MAX_FILES) break;
    if (!folder || !fsNode.existsSync(folder)) continue;
    for (const filePath of walkAudioFiles(folder, [], 0)) {
      // Windows 下路径大小写不敏感，统一小写后去重
      const key = filePath.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        results.push(await readAudioMeta(filePath));
      } catch (error) {
        results.push({ path: filePath, fileName: path.basename(filePath), error: String(error && error.message) });
      }
      if (results.length >= SCAN_MAX_FILES) break;
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
    const ext = (path.extname(sourcePath) || '.jpg').slice(1).toLowerCase() || 'jpg';
    const bytes = fsNode.readFileSync(sourcePath);
    const target = path.join(coversDir(), coverFileName(bytes, ext));
    if (!fsNode.existsSync(target)) fsNode.writeFileSync(target, bytes);
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

// 按路径批量补全元信息（导入 m3u 时用来认领磁盘上已有的歌曲）
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

// 渲染进程同步「关闭到托盘 / 最小化到托盘 / 开机自启」偏好
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

/** 向主窗口推送消息（窗口已销毁时静默忽略） */
function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/** 显示并聚焦主窗口；窗口已关闭则重新创建 */
function showMainWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** 创建系统托盘与右键菜单 */
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

/**
 * 标题栏按钮配色由渲染进程按当前页面深浅决定。
 * 注册在模块级而不是 createWindow 里：窗口重建（macOS activate）时不会重复注册监听，
 * 也不会因为 mainWindow 已被置空而抛错。
 */
ipcMain.on('set-title-bar-overlay', (event, options) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && typeof win.setTitleBarOverlay === 'function') win.setTitleBarOverlay(options);
});

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

  const win = new BrowserWindow(windowOptions);
  mainWindow = win;

  win.on('page-title-updated', event => {
    event.preventDefault();
    win.setTitle('');
  });

  win.once('ready-to-show', () => {
    if (typeof win.setTitleBarOverlay === 'function') {
      win.setTitleBarOverlay({ color: 'rgba(0,0,0,0)', symbolColor: '#17181b', height: TITLE_BAR_HEIGHT });
    }
    win.show();
  });

  // 站外链接一律交给系统浏览器，不在应用窗口内打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('closed', () => {
    mainWindow = null;
  });

  // 「关闭到托盘」：真正退出（app.isQuitting）时才放行关闭
  win.on('close', event => {
    if (!app.isQuitting && windowBehavior.closeToTray) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on('minimize', event => {
    if (windowBehavior.minimizeToTray) {
      event.preventDefault();
      win.hide();
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

  // 清掉上次运行留下的转码临时文件，避免长期使用后磁盘被慢慢占满
  pruneTempAudioFiles();

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
