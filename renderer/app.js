'use strict';

// 标签与歌词解析逻辑集中在 tags.js，主进程与渲染进程共用。
// 这里只解构本文件真正调用到的成员（原先把 tags.js 的 17 个导出全解构了，
// 其中 9 个在本文件里一次都没用到）。
const OrangeTags = window.OrangeTags || {};
const {
  decodeTextBuffer, readVorbisTags, readMp4Tags, readWavTags, readId3,
  parseLyrics, splitFileName, readTechInfo, readDuration
} = OrangeTags;

// 本程序只作为 PC 客户端运行：在普通浏览器中打开时直接给出提示并停止初始化
const desktopBridge = window.orangeDesktop;
if (!desktopBridge?.isDesktop) {
  document.documentElement.innerHTML = `
    <head><meta charset="UTF-8" /><title>Orange Music</title></head>
    <body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f7f9;color:#17181b;font-family:'Microsoft YaHei',system-ui,sans-serif">
      <div style="text-align:center;padding:40px">
        <img src="assets/app.png" alt="" style="width:88px;height:88px;border-radius:20px;margin-bottom:20px" />
        <h1 style="font-size:22px;margin:0 0 10px">请在 PC 客户端中打开</h1>
        <p style="margin:0;color:#6f747d">Orange Music 是本地音乐播放器桌面程序，请双击 Orange Music.exe 启动。</p>
      </div>
    </body>`;
  throw new Error('Orange Music 需要在 PC 客户端中运行');
}

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const audio = $('#audio');

const DEFAULT_COVER = 'assets/cover-default.png';

// 无边框标题栏高度（px），必须与主进程建窗时的 TITLE_BAR_HEIGHT 一致
const TITLE_BAR_HEIGHT = 52;

// 封面文件名：covers/ 目录下形如 cover-*.jpg 的地址，用于收集「仍在使用」的封面
const COVER_BASENAME_PATTERN = /[\\/](cover-[\w.-]+\.(?:jpe?g|png|webp|bmp))$/i;

const FORMAT_ALIASES = { M4A: 'AAC', MP4: 'AAC', OGA: 'OGG', AIF: 'AIFF' };

function readStored(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    if (!value) return fallback;
    const parsed = JSON.parse(value);
    // localStorage 里可能残留 "null" / "undefined" 之类的内容，
    // 直接返回会让后续的 .map / new Set() 在启动阶段抛错，统一回落到默认值。
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readStoredArray(key) {
  const value = readStored(key, []);
  return Array.isArray(value) ? value : [];
}

function readStoredObject(key) {
  const value = readStored(key, {});
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function readPlaylists() {
  return readStoredArray('orange-playlists-clean')
    .filter(playlist => playlist && typeof playlist === 'object' && playlist.id)
    .map(playlist => ({
      ...playlist,
      name: String(playlist.name || '未命名歌单'),
      tracks: Array.isArray(playlist.tracks) ? playlist.tracks.filter(Boolean) : []
    }));
}

const defaultPrefs = {
  fade: true,
  resume: true,
  autoNext: true,
  waveform: false,
  lyricsSize: 30,
  lyricBackdrop: true,
  // 页面底层的彩色光晕（radial 渐变）。关掉后 body 只剩纯色/极浅线性渐变。
  bgGlow: true,
  shortcuts: true,
  restoreLastTrack: true,
  autoplayImport: false,
  onlySongs: true,
  minSongSeconds: 30,
  playbackRate: 1,
  fadeMs: 240,
  sleepTimer: 0,
  replayGain: true,
  eqEnabled: false,
  // 人声消除（伴奏模式）：左右相减去掉居中人声，见 ensureAudioGraph 里的 karaoke 节点
  karaoke: false,
  eqPreset: 'flat',
  // 与 EQ_BANDS 一一对应的 10 段增益（旧版这里只写了 5 项，是均衡器的一个 bug，详见 normalizedEqGains）
  eqGains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  // 耳机校正：AUTOEQ_MODELS 里的型号 id（空串 = 没启用）；
  // eqPreamp 是这条曲线配套的预增益（dB），避免校正后低频抬升的地方削波
  eqHeadphone: '',
  eqPreamp: 0,
  // 用户点「保存当前设置」存下来的自定义均衡（与 EQ_BANDS 等长）。
  // 和 eqGains 分开存：eqGains 是"当前正在用的"，eqCustom 是"存档"，
  // 这样切到别的预设再切回来，用户自己存的那套不会被冲掉。
  eqCustom: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  // 用户自己命名保存的均衡预设：[{ id, name, gains[10], preamp }]，见保存/导入导出小节
  eqPresets: [],
  // 本地歌没有内嵌歌词、也没有同名 .lrc 时，去 LRCLIB 查一次（免费、无 key）
  lrclib: true,
  // 音频输出设备 deviceId；空串 = 跟随系统默认（系统切换设备时会自动跟过去）
  outputDevice: '',
  lyricOffset: 0,
  lyricBlur: 0,
  lyricTheme: 'cover',
  // 双语歌词（原文 + 译文共用同一个时间戳）默认只显示原文，打开后连译文一起显示。
  // 译文行由 tags.js 的 parseLyrics 打好 translation 标记。
  lyricTranslation: false,
  // 歌词界面「立体向内倾斜 + 投影」效果：歌词与封面区各自独立开关，
  // 且各自可选方向（right = 右侧向后，left = 左侧向后）。默认关闭。
  tiltLyrics: false,
  tiltLyricsDir: 'right',
  tiltStage: false,
  tiltStageDir: 'left',
  tiltAngle: 25,
  // 歌词界面「氛围灯」：跟封面主色同色的柔雾，跟着音乐低频涨缩。
  // 左右各一片、各自独立开关（左侧是右侧的水平镜像）。默认都开着 ——
  // 纯氛围效果，不改变任何交互，开着才看得到。
  ambientLight: true,
  ambientLeft: true,
  // 「闪光跃动」：氛围灯的动态模式开关。默认 false = 经典模式（纯慢包络的柔和呼吸，
  // 也就是加鼓点响应之前的那一版）；打开后切到低音鼓点驱动的强节律版本。
  // 详见 app.js 里「两种氛围灯模式」那一段注释。
  ambientFlash: false,
  // 氛围灯动态强度（0~180，无级可调）。100 = 标准档，也就是档位表里那一行；
  // 做连续滑块而不是离散档位，是因为不同曲子、不同人的口味差得挺远。
  ambientPower: 100,
  listDensity: 'normal',
  watchFolders: [],
  autoScanOnStart: false,
  minimizeToTray: false,
  closeToTray: false,
  autoStart: false,
  shortcutKeys: {},
  themeColor: 'default',
  // 自定义主题色（设置页色盘）：主色 = hsl(色相, 饱和度, 明暗)，
  // 底色/面板/边线由色相推导；着色强度控制整块界面被染色的程度。
  // 默认值取的就是 :root 那个 --accent（#e84b3c），所以一进「自定义」不会跳色。
  customThemeHue: 5.2,
  customThemeSat: 78.9,
  customThemeLight: 57.3,
  customThemeTint: 62,
  sidebarEffect: 'blur',
  sidebarBlur: 26,
  sidebarOpacity: 78,
  // ---------- 桌面歌词悬浮窗（Apple Music 风格）----------
  // 是否显示桌面歌词；外观参数全部下发给独立的透明悬浮窗
  desktopLyrics: false,
  dlBlur: 28,           // 背景模糊程度（px）
  dlOpacity: 35,        // 背景不透明度（0~100）
  dlFontSize: 34,       // 歌词字号（px）
  dlTextColor: '#ffffff',   // 歌词文字颜色
  dlTextDepth: 100,     // 歌词文字浓度/深度（0~100，越大文字越实越清晰）
  dlAccentColor: '#e84b3c', // 逐字点亮 / 发光强调色
  dlBgColor: '',        // 背景底色（空 = 由文字色自动推导深浅）
  dlAlign: 'center',    // 对齐：left / center / right
  dlRadius: 18,         // 圆角（px）
  dlShowMeta: true,     // 是否显示歌名/歌手
  dlLocked: false       // 是否锁定（锁定后不可拖动）
};

const THEME_COLORS = ['default', 'peach', 'mint', 'sky', 'lilac', 'lemon', 'sakura'];

const DEFAULT_SHORTCUTS = {
  playPause: 'Space',
  seekBack: 'ArrowLeft',
  seekForward: 'ArrowRight',
  volumeUp: 'ArrowUp',
  volumeDown: 'ArrowDown',
  prev: 'Ctrl+ArrowLeft',
  next: 'Ctrl+ArrowRight',
  mute: 'M',
  favorite: 'F',
  lyrics: 'L',
  queue: 'Q',
  shuffle: 'S',
  repeat: 'R',
  search: 'Ctrl+K',
  fullscreen: 'F11'
};

// 10 段均衡（ISO 标准频点）
const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  pop: [-1, -1, 0, 2, 4, 4, 2, 0, -1, -1],
  rock: [4, 3, 2, 0, -1, -1, 0, 2, 3, 4],
  classical: [3, 2, 2, 1, -1, -1, 0, 2, 3, 3],
  vocal: [-4, -3, -1, 1, 4, 5, 4, 2, 0, -1],
  bass: [7, 6, 5, 3, 1, 0, -1, -2, -3, -4],
  treble: [-5, -4, -3, -1, 0, 1, 3, 5, 6, 7],
  jazz: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3],
  electronic: [5, 4, 1, 0, -2, 1, 0, 1, 4, 5]
};

/**
 * 取出均衡器增益，并归一化成与 EQ_BANDS 等长的数组。
 *
 * 必须归一化的原因：默认值曾经只有 5 项，localStorage 里也可能留着旧版本写下的短数组。
 * 直接按下标读写 `state.prefs.eqGains[7]` 会得到一个带空洞的稀疏数组，
 * 其余频段的增益被静默当成 0，用户一拖滑块就会把之前的设置全冲掉。
 * 统一从这里取（而不是每处各写一遍容错）能保证三条路径行为一致。
 */
function normalizedEqGains() {
  const source = Array.isArray(state.prefs.eqGains) ? state.prefs.eqGains : [];
  return EQ_BANDS.map((_, index) => Number(source[index]) || 0);
}

/** 用户存档的自定义均衡，同样归一化成与 EQ_BANDS 等长 */
function normalizedCustomEq() {
  const source = Array.isArray(state.prefs.eqCustom) ? state.prefs.eqCustom : [];
  return EQ_BANDS.map((_, index) => Number(source[index]) || 0);
}

/** 把 -12 ~ +12 的增益格式化成带符号的显示文本：+3 / 0 / -5 */
function formatEqDb(value) {
  const number = Number(value) || 0;
  return `${number > 0 ? '+' : ''}${number}`;
}

const state = {
  page: 'home',
  tab: 'playlists',
  format: 'all',
  query: '',
  songs: [],
  favorites: new Set(readStoredArray('orange-favorites')),
  recent: readStoredArray('orange-recent').filter(id => typeof id === 'string'),
  playlists: readPlaylists(),
  queue: [],
  currentId: null,
  playing: false,
  shuffle: false,
  repeat: 0,
  volume: .78,
  muted: false,
  progress: readStoredObject('orange-progress'),
  prefs: { ...defaultPrefs, ...readStoredObject('orange-prefs') },
  recommendationOffset: 0,
  // 专辑 / 艺术家详情页当前看的是哪一组：{ kind: 'album'|'artist', key }
  collection: null,
  pendingAddId: null,
  pendingAddIds: [],
  selectMode: false,
  selection: new Set(),
  lyricImportId: null,
  searchScope: 'all',
  // ---------- 在线音乐 ----------
  /** 当前选中的在线音源：netease / qq / kugou */
  onlineSource: 'netease',
  /** 各音源登录状态（由主进程返回） */
  onlineAccounts: [],
  /** 在线搜索结果（正常化后的曲目对象） */
  onlineResults: [],
  /** 已经解析/播放过的在线曲目，和本地资料库分开存，避免污染「歌曲」页 */
  online: [],
  onlineKeyword: '',
  onlineLoading: false
};

let demoUrl = null;
let demoForId = null;
let toastTimer = null;
// 从「添加到歌单」弹窗点「新建歌单」时，把待加入的歌曲暂存到这里，
// 等新歌单创建完成后再真正写进去（原来提示写着「创建后加入」，实际什么也没加）。
let pendingNewPlaylistIds = [];
// 导入是逐文件 await 的长流程，重复点「导入」/ 又拖一批文件会交错写入资料库
let importingFiles = false;
let seeking = false;
let audioContext = null;
let analyser = null;
let ambientAnalyser = null;
let sourceNode = null;
let eqFilters = [];
// 耳机校正的预增益（AutoEq 的 Preamp）：单开一个增益节点，而不是折进 gainNode，
// 因为 gainNode 已经被 ReplayGain 占用了，两者混在一起会互相覆盖
let preampNode = null;
let gainNode = null;
// 人声消除（伴奏模式）节点：干声 / 湿声两条支路 + 单声道探测分析器
let karaokeDry = null;
let karaokeWet = null;
let karaokeProbeL = null;
let karaokeProbeR = null;
let fadeTimer = null;
let pendingResume = 0;
// 切歌请求序号：只允许最后一次 playTrack 的结果落到 audio 上，避免异步解析音源时被旧请求覆盖
let playRequestToken = 0;
// 续播范围收窄：只有「本次启动、且正是上次关闭时在播的那一首」才恢复进度。
// 其余任何切歌 / 装载一律从 0:00 开始，避免每首歌都接着上次的位置播。
let bootResumeId = null;
let bootResumeUsed = false;
let lastProgressSave = 0;

/* ------------------- Windows SMTC / 系统媒体控制 -------------------
 * Electron 在 Windows 上本来就会把 <audio> 的媒体会话发布到 SMTC（锁屏、音量弹窗、
 * 键盘/耳机线控的媒体键都走这条路）。但如果页面不设 navigator.mediaSession.metadata，
 * 系统里只有一条 document.title（"index.html"）的空记录：没有封面、没有歌手、按了键也没反应。
 * 这里把歌曲信息推过去，并把系统的播放控制接回来。
 * 之所以不用原生模块：实测 Electron 33 已经自带这层发布能力，只差页面这一侧的声明。
 */
let smtcLastPositionAt = 0;
// 媒体键与 SMTC 回调可能同时到达（Chromium 转发一次、页面 keydown 再收一次），
// 切歌类动作必须去重，否则按一下跳两首
let lastMediaSkipAt = 0;
// 已经推给系统的曲目指纹（id + 封面），避免每次 updatePlayerUi 都重建一遍封面
let smtcTrackKey = '';
// 封面转码是异步的，切歌快时旧结果会晚到，用序号丢弃过期的那次
let smtcArtworkToken = 0;

function smtcSupported() {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator;
}

/** 相对路径 / file:// / data: 一律转成绝对 URL —— SMTC 拿不到相对路径的封面 */
function mediaArtworkUrl(source) {
  if (!source) return '';
  try {
    return new URL(source, location.href).href;
  } catch (error) {
    return source;
  }
}

/**
 * 把封面压成 256×256 的 data URL。
 * 为什么不用原始 file:// 地址：这张图是给系统进程去取的，file:// 在浏览器进程里
 * 不一定读得到；data URL 是随元数据一起带过去的内存图，Chromium 直接解码，稳。
 *
 * 本地封面必须先过主进程：页面里 <img> 加载 file:// 后再画到 canvas 会被判成跨源，
 * toDataURL 直接抛 SecurityError（原来这里 catch 掉返回空串，表现就是「系统媒体面板
 * 永远没有封面」）。主进程用 nativeImage 读同一个文件不受同源限制。
 * 在线封面是 http(s) 且带 CORS 头，canvas 那条路走得通。
 */
function buildArtworkDataUrl(cover) {
  const raw = typeof cover === 'string' ? cover : '';
  const local = raw && (/^file:/i.test(raw) || /^[a-zA-Z]:[\\/]/.test(raw));
  const viaMain = local && window.orangeDesktop?.coverDataUrl
    ? window.orangeDesktop.coverDataUrl(raw, 256).catch(() => '')
    : Promise.resolve('');
  return viaMain.then(data => data || canvasArtworkDataUrl(raw));
}

function canvasArtworkDataUrl(cover) {
  return new Promise(resolve => {
    const url = mediaArtworkUrl(hiResCover(cover));
    if (!url) return resolve('');
    const image = new Image();
    // 本地 file:// 加 crossOrigin 反而会被 CORS 挡掉（和播放器里 <img> 的处理一致）
    if (/^https?:/i.test(url)) image.crossOrigin = 'anonymous';
    const timer = setTimeout(() => resolve(''), 2500);
    image.onload = () => {
      clearTimeout(timer);
      try {
        const size = 256;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext('2d');
        // 方形居中裁剪：非正方形封面直接拉伸会变形
        const side = Math.min(image.naturalWidth, image.naturalHeight) || size;
        const sx = Math.max(0, (image.naturalWidth - side) / 2);
        const sy = Math.max(0, (image.naturalHeight - side) / 2);
        context.drawImage(image, sx, sy, side, side, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', 0.72));
      } catch (error) {
        resolve('');
      }
    };
    image.onerror = () => {
      clearTimeout(timer);
      resolve('');
    };
    image.src = url;
  });
}

function smtcMetadata(track, artwork) {
  return new MediaMetadata({
    title: track.title || '未知歌曲',
    artist: track.artist || '未知歌手',
    album: track.album || '',
    artwork: artwork || []
  });
}

/** 把当前曲目推给系统：标题 / 歌手 / 专辑 / 封面，同时校准播放状态与进度 */
function syncMediaSession(track = getTrack(state.currentId)) {
  if (!smtcSupported()) return;
  const session = navigator.mediaSession;
  if (!track) {
    smtcTrackKey = '';
    session.metadata = null;
    session.playbackState = 'none';
    return;
  }
  const key = `${track.id}|${track.cover || ''}`;
  if (key !== smtcTrackKey) {
    smtcTrackKey = key;
    const token = ++smtcArtworkToken;
    // 先把文字信息推上去（立刻可见），封面随后补。
    // ⚠️ MediaImage 只认 http/https/data/blob —— 本地封面的 file:// 会被 Chromium
    // 直接拒掉（控制台一句 "MediaImage src can only be of ..."，面板上就是没图），
    // 所以 file:// 一律先不给，等主进程转好的 data URL 回来再补。
    const url = mediaArtworkUrl(hiResCover(track.cover));
    const usableNow = url && !/^file:/i.test(url) && !/^[a-zA-Z]:[\\/]/.test(url);
    try {
      session.metadata = smtcMetadata(track, usableNow ? [{ src: url, sizes: '512x512' }] : []);
    } catch (error) {
      console.warn('mediaSession metadata failed', error);
    }
    buildArtworkDataUrl(track.cover).then(data => {
      if (!data || token !== smtcArtworkToken) return;
      if (getTrack(state.currentId)?.id !== track.id) return;
      try {
        session.metadata = smtcMetadata(track, [{ src: data, sizes: '256x256', type: 'image/jpeg' }]);
      } catch (error) {}
    });
  }
  session.playbackState = state.playing ? 'playing' : 'paused';
  syncMediaPosition(true);
}

/** 进度条：setPositionState 会被系统用来画锁屏/音量弹窗上的进度，别每秒都推，节流到 8 秒 */
function syncMediaPosition(force = false) {
  if (!smtcSupported()) return;
  const duration = Number(audio.duration);
  if (!Number.isFinite(duration) || duration <= 0) return;
  const now = Date.now();
  if (!force && now - smtcLastPositionAt < 8000) return;
  smtcLastPositionAt = now;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      position: Math.min(duration, Math.max(0, Number(audio.currentTime) || 0)),
      playbackRate: Number(audio.playbackRate) || 1
    });
  } catch (error) {
    // 某些格式 duration 会短暂为 Infinity，抛错就别管，下一轮再说
  }
}

/** 切歌去重：媒体键 & SMTC 双通道时一次按键只跳一首 */
function mediaSkip(direction) {
  const now = Date.now();
  if (now - lastMediaSkipAt < 350) return;
  lastMediaSkipAt = now;
  if (direction > 0) nextTrack();
  else previousTrack();
}

/** 注册系统侧的播放控制。play / pause 做成幂等，重复到达也不会互相抵消 */
function initMediaSession() {
  if (!smtcSupported()) return;
  const session = navigator.mediaSession;
  const guard = (action, handler) => {
    try {
      session.setActionHandler(action, handler);
    } catch (error) {
      // 个别动作在旧版 Chromium 上不支持，跳过即可
    }
  };
  guard('play', () => { if (!state.playing) togglePlayback(); });
  guard('pause', () => { if (state.playing) togglePlayback(); });
  guard('stop', () => { if (state.playing) togglePlayback(); });
  guard('previoustrack', () => mediaSkip(-1));
  guard('nexttrack', () => mediaSkip(1));
  guard('seekto', details => {
    const target = Number(details && details.seekTime);
    if (!Number.isFinite(target) || !Number.isFinite(audio.duration)) return;
    audio.currentTime = Math.min(audio.duration, Math.max(0, target));
    updateProgress();
    syncMediaPosition(true);
  });
  guard('seekbackward', details => seekBy(-(Number(details && details.seekOffset) || 10)));
  guard('seekforward', details => seekBy(Number(details && details.seekOffset) || 10));
  syncMediaSession();
}

let sleepTimerId = null;
let sleepAtTrackEnd = false;
let sleepEndsAt = 0;

const savedVolume = readStored('orange-volume', { volume: .78, muted: false });
if (typeof savedVolume.volume === 'number') state.volume = Math.min(1, Math.max(0, savedVolume.volume));
state.muted = Boolean(savedVolume.muted);
const savedPlayback = readStored('orange-playback', { shuffle: false, repeat: 0 });
state.shuffle = Boolean(savedPlayback.shuffle);
state.repeat = Number(savedPlayback.repeat) || 0;
// 注：state 初始化时已经做过一次 { ...defaultPrefs, ...已存偏好 }，这里无需再合并一遍

function saveState() {
  try {
    localStorage.setItem('orange-favorites', JSON.stringify([...state.favorites]));
    localStorage.setItem('orange-recent', JSON.stringify(state.recent));
    localStorage.setItem('orange-playlists-clean', JSON.stringify(state.playlists));
  } catch (error) {
    // 存储满 / 被禁用时不要让一次写入失败打断播放
    console.warn('Unable to persist state', error);
  }
}

function savePrefs() {
  try {
    localStorage.setItem('orange-prefs', JSON.stringify(state.prefs));
  } catch (error) {
    console.warn('Unable to persist preferences', error);
  }
}

function savePlaybackModes() {
  try {
    localStorage.setItem('orange-playback', JSON.stringify({ shuffle: state.shuffle, repeat: state.repeat }));
  } catch (error) {
    console.warn('Unable to persist playback modes', error);
  }
}

function saveProgress() {
  try {
    localStorage.setItem('orange-progress', JSON.stringify(state.progress));
  } catch {}
}

function songRecord(song) {
  const offset = song._lyricOffset;
  const hasOffset = offset !== null && offset !== undefined && offset !== '' && Number.isFinite(Number(offset));
  const replayGain = song._replayGain;
  return {
    id: song.id,
    path: song._path || '',
    title: song.title,
    artist: song.artist,
    album: song.album,
    format: song.format,
    duration: Math.round(song.duration || 0),
    cover: song.cover || '',
    size: Number(song._size) || 0,
    tech: song._tech || {},
    replayGain: replayGain !== null && replayGain !== undefined && Number.isFinite(Number(replayGain))
      ? Number(replayGain)
      : null,
    lyricOffset: hasOffset ? Number(offset) : null,
    // 手动导入 / 粘贴的歌词没有对应的磁盘 .lrc，资料库不记的话重启就丢了。
    // 内嵌歌词和同名歌词文件每次播放都会重新读取，不需要存。
    lyricText: song._lyricManual && song._lyricText ? String(song._lyricText).slice(0, 200000) : ''
  };
}

function saveLibrary() {
  try {
    const records = state.songs.filter(song => song._path).map(songRecord);
    const known = new Set(state.songs.map(song => song.id));
    try {
      localStorage.setItem('orange-library', JSON.stringify(records));
    } catch (error) {
      // 手动歌词正文可能把 localStorage 配额撑爆。宁可丢掉歌词正文，也要保住资料库本身，
      // 否则整次写入失败 = 这次新增/编辑的歌曲全部丢失。
      console.warn('Library quota exceeded, retry without lyric text', error);
      const slim = records.map(record => (record.lyricText ? { ...record, lyricText: '' } : record));
      localStorage.setItem('orange-library', JSON.stringify(slim));
    }
    localStorage.setItem('orange-queue', JSON.stringify(state.queue.filter(id => known.has(id))));
  } catch (error) {
    console.warn('Unable to persist library', error);
  }
}

async function resolveCoverUrl(cover) {
  if (!cover) return DEFAULT_COVER;
  if (/^data:image\//i.test(cover) && window.orangeDesktop?.saveCover) {
    const saved = await window.orangeDesktop.saveCover(cover).catch(() => null);
    return saved || DEFAULT_COVER;
  }
  return cover;
}

/** 收集资料库里仍被引用的封面文件名（封面存的是绝对路径，这里只取文件名） */
function coverBasenames() {
  const names = [];
  state.songs.forEach(song => {
    const match = COVER_BASENAME_PATTERN.exec(String(song.cover || ''));
    if (match) names.push(match[1]);
  });
  return names;
}

/**
 * 请主进程回收封面目录里已经不再被任何歌曲引用的图片。
 * 只在名单非空（资料库确实读出来了）时才发，避免资料库异常为空时把封面全删掉。
 * 这是「封面越用越多」的兜底：命名改成内容 md5 后同一张图不会再重复落盘，
 * 这里再把历史遗留的孤儿文件回收掉。
 */
function pruneOrphanCovers() {
  if (!window.orangeDesktop?.pruneCovers) return;
  const names = coverBasenames();
  if (!names.length) return;
  window.orangeDesktop.pruneCovers(names).catch(() => {});
}

async function restoreLibrary() {
  const records = readStored('orange-library', []);
  if (!Array.isArray(records) || !records.length) return 0;
  const desktop = window.orangeDesktop;
  let existing = null;
  if (desktop?.pathsExist) {
    const paths = records.map(record => record?.path || '');
    existing = [];
    for (let i = 0; i < paths.length; i += 200) {
      const chunk = await desktop.pathsExist(paths.slice(i, i + 200)).catch(() => null);
      if (!chunk) { existing = null; break; }
      existing.push(...chunk);
    }
  }
  const songs = [];
  const usedIds = new Set();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || !record.path) continue;
    if (existing) {
      if (!existing[index]) continue;
    } else if (desktop?.pathExists) {
      const exists = await desktop.pathExists(record.path).catch(() => true);
      if (!exists) continue;
    }
    let id = record.id || `f${songs.length}${Date.now()}`;
    if (usedIds.has(id)) id = `f${songs.length}${Date.now()}`;
    usedIds.add(id);
    const lyricText = typeof record.lyricText === 'string' ? record.lyricText : '';
    songs.push({
      id,
      title: record.title || '未知歌曲',
      artist: record.artist || '未知音乐人',
      album: record.album || '本地文件',
      format: record.format || 'AUDIO',
      duration: Number(record.duration) || 0,
      cover: record.cover || DEFAULT_COVER,
      source: '本地导入',
      // _src 有意留空：真正播放时由 resolveTrackSource() 按 _path 惰性解析并回填。
      // 原先这里是逐首 await toFileUrl()，资料库上千首时启动就要发上千次 IPC。
      _src: '',
      _path: record.path,
      _size: Number(record.size) || 0,
      _tech: record.tech || {},
      _replayGain: record.replayGain !== null && record.replayGain !== undefined
        && Number.isFinite(Number(record.replayGain))
        ? Number(record.replayGain)
        : null,
      _lyricOffset: Number.isFinite(Number(record.lyricOffset)) && record.lyricOffset !== null && record.lyricOffset !== ''
        ? Number(record.lyricOffset)
        : null,
      // 手动导入 / 粘贴的歌词存的是原始文本，恢复时重新解析，避免把解析结果塞进 localStorage
      _lyrics: lyricText ? parseLyrics(lyricText) : [],
      _lyricText: lyricText,
      _lyricManual: Boolean(lyricText),
      _lyricSource: lyricText ? 'manual' : '',
      _lyricChecked: Boolean(lyricText)
    });
  }
  state.songs = songs;
  // 队列里只保留仍存在于资料库的 id。用 Set 查表，避免对每个队列项都遍历一次 songs
  const validIds = new Set(songs.map(song => song.id));
  const savedQueue = readStoredArray('orange-queue').filter(id => validIds.has(id));
  state.queue = savedQueue.length ? savedQueue : songs.map(song => song.id);
  return songs.length;
}

async function loadSidecarLyrics(track) {
  if (!track?._path || !window.orangeDesktop?.readSidecarLyrics) return [];
  const result = await window.orangeDesktop.readSidecarLyrics(track._path).catch(() => null);
  if (!result?.text) return [];
  const lyrics = parseLyrics(result.text);
  if (lyrics.length) {
    track._lyrics = lyrics;
    track._lyricPath = result.path || '';
    track._lyricSource = 'sidecar';
    // 重新从磁盘读到歌词后，旧的手动歌词正文不应再被当作「用户手动歌词」落库
    track._lyricManual = false;
    track._lyricText = '';
  }
  return lyrics;
}

/* 歌词缓存上限。
   歌词按需加载后就挂在曲目对象上（track._lyrics），以前是只增不减：
   一个几千首的库连着听下来，每首几十 KB 的歌词对象会一直占着内存。
   这里按「最近播放」维持一个上限，超出的淘汰掉（下次播放会重新读盘）。
   正在播放的那首永远不淘汰；_lyricChecked 不动，所以不会退化成反复查"有没有歌词"。 */
const LYRIC_CACHE_LIMIT = 16;
const lyricCacheOrder = [];

function touchLyricCache(track) {
  if (!track || !track.id) return;
  const at = lyricCacheOrder.indexOf(track.id);
  if (at >= 0) lyricCacheOrder.splice(at, 1);
  lyricCacheOrder.push(track.id);
  // guard 防死循环：极端情况下（队列全是当前曲目）不会卡住
  let guard = lyricCacheOrder.length;
  while (lyricCacheOrder.length > LYRIC_CACHE_LIMIT && guard-- > 0) {
    const staleId = lyricCacheOrder.shift();
    // 正在播放的和正在加载的都不淘汰（切歌瞬间 state.currentId 可能还没跟上）
    if (staleId === state.currentId || staleId === track.id) {
      lyricCacheOrder.push(staleId);
      continue;
    }
    const stale = getTrack(staleId);
    if (stale) {
      stale._lyrics = null;
      stale._lyricsView = null;
    }
  }
}

// 读取歌词：内嵌标签优先，其次同名 lrc（重启后也能重新读到内嵌歌词）
async function loadTrackLyrics(track) {
  if (!track) return [];
  touchLyricCache(track);
  if (track._lyrics?.length) return track._lyrics;
  if (window.orangeDesktop?.readLyrics && track._path) {
    const result = await window.orangeDesktop.readLyrics(track._path).catch(() => null);
    if (result?.lyrics?.length) {
      track._lyrics = result.lyrics;
      track._lyricSource = result.source;
      track._lyricPath = result.path || '';
      track._lyricManual = false;
      track._lyricText = '';
      return result.lyrics;
    }
  }
  // 同目录 .lrc 优先于在线库：用户手动放的歌词一定是他要的版本
  const sidecar = await loadSidecarLyrics(track);
  if (sidecar.length) return sidecar;
  return loadLrclibLyrics(track);
}

/**
 * LRCLIB 在线补词（300 万首，免费无 key）。
 * 本地歌经常既没有内嵌歌词也没有同名 .lrc，以前这种歌永远停在「暂无歌词」；
 * 现在按歌名 + 歌手 + 时长去查一次，命中就当作歌词源，界面上的来源标注为 LRCLIB。
 * 每首歌只查一次（_lyrclibTried），没查到也不会每次播放都再请求一遍。
 */
async function loadLrclibLyrics(track) {
  if (!track || state.prefs.lrclib === false) return [];
  if (!window.orangeDesktop?.lrclibLyrics) return [];
  if (track._lyrclibTried) return [];
  track._lyrclibTried = true;
  const result = await window.orangeDesktop.lrclibLyrics({
    title: track.title || '',
    artist: track.artist || '',
    album: track.album || '',
    duration: Number(track.duration) || 0
  }).catch(() => null);
  if (!result) return [];
  const text = result.synced || result.plain || '';
  if (!text) return [];
  const lyrics = parseLyrics(text);
  if (!lyrics.length) return [];
  track._lyrics = lyrics;
  track._lyricSource = result.synced ? 'lrclib' : 'lrclib-plain';
  track._lyricPath = '';
  track._lyricManual = false;
  track._lyricText = '';
  track._lyricProvider = [result.artistName, result.trackName].filter(Boolean).join(' · ');
  return lyrics;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'",'&#039;');
}

function getTrack(id) {
  // 在线曲目不进本地资料库，单独放在 state.online 里；播放器所有按 id 取曲目的地方都要能看到它
  return state.songs.find(song => song.id === id) || state.online.find(song => song.id === id);
}

function lossless(format) {
  return ['FLAC','ALAC','WAV','AIFF','APE'].includes(format);
}

// 音效 / 提示音 / 语音 的常见命名与目录特征
const SFX_NAME_PATTERN = /(^|[\s._\-([（])(sfx|se\d*|ui|clic?k|hover|tick|tap|ding|beep|blip|alert|alarm|warn(ing)?|notif(y|ication)|message|popup?|swipe|whoosh|transition|stinger|jingle|chime|bell|coin|hit|impact|explosion|gunshot|step|footstep|slide|glitch|loop|noise|silence|silent|empty|blank|test|sample|demo|voice|vocal|announcer|narration|铃声|提示音|音效|语音|警报|按键|通知|静音|空白|叮|嘟)/i;
const SFX_PATH_PATTERN = /[\\/](sounds?|sfx|se|voice|voices|vo|announcer|effects?|audio|audios)[\\/](sfx|se\d*|ui|voice|vo|effect)/i;
const SFX_DIR_PATTERN = /[\\/](sfx|sounds?|soundeffects?|audio|audios|voice|voices|announcer|dvaaudiofilters|bgm)[\\/]?$/i;

// 判断一个音频文件是不是「歌曲」：有标签、时长够长才留下，音效/提示音/语音跳过
function looksLikeSong({ name, filePath, metadata, seconds }) {
  const title = metadata?.title || '';
  const artist = metadata?.artist || '';
  const album = metadata?.album || '';
  const tagScore = (title ? 1 : 0) + (artist ? 1 : 0) + (album ? 1 : 0);
  const minSeconds = Math.max(5, Number(state.prefs.minSongSeconds) || 30);
  const length = Number(seconds) || 0;
  const base = String(name || '').replace(/\.[^.]+$/, '');
  const soundsLikeEffect = SFX_NAME_PATTERN.test(base)
    || SFX_PATH_PATTERN.test(filePath || '')
    || SFX_DIR_PATTERN.test(filePath || '');

  // 名字 / 目录就是音效、提示音、语音 → 只有标签齐全时才当作歌曲
  if (soundsLikeEffect) return tagScore >= 2;
  // 标题 + 歌手齐全 → 歌曲
  if (title && artist) return true;
  // 读不到时长：只有名字/目录像音效才排除，避免误删真正的歌曲
  if (!length) return !soundsLikeEffect;
  // 时长不足下限 → 当作音效
  if (length < minSeconds) return false;
  // 时长够长 → 歌曲
  return true;
}

// 没有标签时用文件名推断「歌手 - 歌名」，兼容 01. 前缀与中英文破折号

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds || 0));
  if (!seconds) return '0 分钟';
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} 分钟`;
}

function qualityLabel(track) {
  if (!track) return '—';
  const format = track.format || '音频';
  if (['FLAC','ALAC','WAV'].includes(format)) return `无损 · ${format}`;
  if (['AAC','M4A'].includes(format)) return `高效 · ${format}`;
  return format;
}

function setQualityBadge(track, fallbackText) {
  const badge = $('#fullContext');
  if (!badge) return;
  const online = Boolean(track?._online);
  // 在线曲目交给 online.js 组织文案（容器 + 码率 / 无损 / 试听），并且可点击切音质；
  // 本地曲目保持原样，只是一个静态标签。
  const onlineText = online && typeof onlineQualityText === 'function' ? onlineQualityText(track) : '';
  const text = fallbackText || onlineText || qualityLabel(track);
  // 选了会员档位但只拿到低档：给徽标加个琥珀色，配合「超清母带 → MP3 320K」的写法
  const fallbackQuality = online && typeof qualityDelivery === 'function'
    ? (() => { const info = qualityDelivery(track); return Boolean(info.wanted && !info.delivered); })()
    : false;
  // 只改文字，不要把 badge 的 innerHTML 整个替换掉：
  // 里面那个 <b id="fullFormat"> 被替换掉之后，updatePlayerUi 再也找不到它，
  // 后续所有「格式」更新都会静默失效（这正是旧版播放后格式标签消失的原因）。
  const label = $('#fullFormat');
  if (label) label.textContent = text;
  else badge.textContent = text;
  badge.classList.toggle('is-clickable', online);
  badge.classList.toggle('is-fallback', fallbackQuality);
  badge.tabIndex = online ? 0 : -1;
  badge.setAttribute('role', online ? 'button' : 'presentation');
  badge.title = online
    ? (fallbackQuality ? `${text} · 该档位未拿到，点击换一档` : `${text} · 点击切换音质`)
    : text;
}

// 原始歌词（未做任何过滤）
function rawLyrics(track) {
  if (track?._lyrics?.length) return track._lyrics;
  return [];
}

// 实际用来渲染 / 滚动的歌词视图。
// 双语歌词里译文行和原文行共用同一个时间戳（解析层已打 translation 标记），
// 默认只出原文 —— 以前两行都渲染，行数直接翻倍，看着「一下多出特别多」，
// 滚动也跟着变卡。这里统一在入口过滤，渲染、滚动、逐字点亮全部共用同一份数组，
// 下标才对得上。
// 过滤结果缓存在 track 上，失效判据是「源数组身份」：_lyrics 只在换歌 / 重新解析 /
// 手动导入时整体替换，换个数组对象缓存就自动作废，不用去每个赋值点清缓存。
function getLyrics(track) {
  const raw = rawLyrics(track);
  if (!raw.length) return raw;
  if (state.prefs.lyricTranslation === true) return raw;
  // 不做双语歌词的歌（绝大多数）直接原样返回，一次 some 就短路结束
  if (!raw.some(line => line.translation)) return raw;
  if (track._lyricsViewSrc === raw && track._lyricsView?.length) return track._lyricsView;
  const view = raw.filter(line => !line.translation);
  // 极端情况：整首都被判成译文（原文反而没带时间戳）→ 宁可全留着，也别显示成空白
  track._lyricsView = view.length ? view : raw;
  track._lyricsViewSrc = raw;
  return track._lyricsView;
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

/**
 * 输入一行文字的弹窗。Electron 里 window.prompt 是直接抛错的，所以用 <dialog> 自己做一个。
 * 返回 Promise<string|null>：确定返回去掉首尾空格的文本，取消 / 关闭返回 null。
 */
function askText({ title = '请输入', hint = '', value = '' } = {}) {
  const dialogEl = $('#promptModal');
  const form = $('#promptForm');
  const input = $('#promptInput');
  if (!dialogEl || !form || !input) return Promise.resolve(null);
  const titleEl = $('#promptTitle');
  const hintEl = $('#promptHint');
  if (titleEl) titleEl.textContent = title;
  if (hintEl) {
    hintEl.textContent = hint;
    hintEl.hidden = !hint;
  }
  input.value = value;
  dialogEl.showModal();
  setTimeout(() => { input.focus(); input.select(); }, 30);

  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      form.removeEventListener('submit', onSubmit);
      dialogEl.removeEventListener('close', onClose);
      if (dialogEl.open) dialogEl.close();
      resolve(result);
    };
    const onSubmit = event => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) {
        input.focus();
        return;
      }
      finish(text);
    };
    const onClose = () => finish(null);
    form.addEventListener('submit', onSubmit);
    dialogEl.addEventListener('close', onClose);
  });
}

function trackRowHtml(track, index) {
  const favorite = state.favorites.has(track.id);
  const isCurrent = state.currentId === track.id;
  const selected = state.selection.has(track.id);
  return `
    <div class="track-row ${isCurrent ? 'playing' : ''} ${isCurrent && state.playing ? 'is-playing' : ''} ${selected ? 'selected' : ''}" data-track="${track.id}">
      ${state.selectMode ? `<label class="row-check" title="选择"><input type="checkbox" data-select="${track.id}" ${selected ? 'checked' : ''} /></label>` : ''}
      <div class="track-index">
        <span>${String(index + 1).padStart(2,'0')}</span>
        <span class="eq-bars" aria-hidden="true"><i></i><i></i><i></i></span>
        <button class="icon-button row-play" data-play="${track.id}" aria-label="播放 ${escapeHtml(track.title)}">
          <svg class="icon filled"><use href="#${isCurrent && state.playing ? 'i-pause' : 'i-play'}"/></svg>
        </button>
      </div>
      <div class="track-main">
        <img src="${track.cover || DEFAULT_COVER}" alt="" />
        <div><strong>${escapeHtml(track.title)}</strong><span>${escapeHtml(track.artist)} · ${escapeHtml(track.album)}</span></div>
      </div>
      <div class="track-album">${escapeHtml(track.album)}</div>
      <span class="track-format ${lossless(track.format) ? 'lossless' : ''}">${escapeHtml(track.format)}</span>
      <div class="track-duration">${formatTime(track.duration)}</div>
      <div class="track-actions">
        <button class="icon-button favorite ${favorite ? 'active' : ''}" data-favorite="${track.id}" aria-label="喜爱" title="喜爱">
          <svg class="icon"><use href="#i-heart"/></svg>
        </button>
        <button class="icon-button" data-info="${track.id}" aria-label="歌曲信息" title="歌曲信息">
          <svg class="icon"><use href="#i-info"/></svg>
        </button>
        <button class="icon-button" data-edit="${track.id}" aria-label="编辑信息" title="编辑歌曲信息">
          <svg class="icon"><use href="#i-audio-lines"/></svg>
        </button>
        <button class="icon-button" data-add="${track.id}" aria-label="添加到歌单" title="添加到歌单">
          <svg class="icon"><use href="#i-plus"/></svg>
        </button>
        <button class="icon-button danger" data-remove="${track.id}" aria-label="从资料库移除" title="从资料库移除">
          <svg class="icon"><use href="#i-trash"/></svg>
        </button>
      </div>
    </div>`;
}

function emptyHtml(title, detail) {
  return `<div class="empty-state"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></div>`;
}

function filteredSongs() {
  const query = state.query.trim().toLowerCase();
  return state.songs.filter(song => {
    const formatMatch = state.format === 'all' || song.format === state.format;
    const queryMatch = !query || [song.title, song.artist, song.album, song.format]
      .some(value => String(value ?? '').toLowerCase().includes(query));
    return formatMatch && queryMatch;
  });
}

function cardHtml(track) {
  if (!track) return '';
  return `
    <article class="recommend-card" data-track-card="${track.id}" tabindex="0">
      <div class="recommend-cover">
        <img src="${track.cover || DEFAULT_COVER}" alt="${escapeHtml(track.album)} 封面" />
        <button class="card-play" data-play="${track.id}" aria-label="播放 ${escapeHtml(track.title)}">
          <svg class="icon"><use href="#i-play"/></svg>
        </button>
      </div>
      <div class="recommend-info">
        <strong>${escapeHtml(track.title)}</strong>
        <span>${escapeHtml(track.artist)} · ${escapeHtml(track.format)}</span>
      </div>
    </article>`;
}

/**
 * 首页从「在线每日推荐」退回「本地推荐」时要收拾干净：
 * 区块标题、右上按钮文案、主卡片的次按钮都是在线模块改过的，
 * 不还原的话会出现「标题写着今日推荐、内容却是本地歌」这种错位。
 */
function restoreHomeLocalChrome() {
  const title = $('#recommendTitle');
  if (title && title.textContent !== '推荐播放') title.textContent = '推荐播放';
  const note = $('#recommendNote');
  if (note && note.textContent) note.textContent = '';
  const refresh = $('#recommendRefresh');
  // 用值比较而不是「有没有设过」：否则在线→本地→在线反复切换后，
  // 按钮会永远停在「刷新」上，再也变不回「换一批」
  if (refresh && refresh.dataset.localMode !== '1') {
    refresh.dataset.localMode = '1';
    refresh.innerHTML = '换一批 <svg class="icon"><use href="#i-chevron-right"/></svg>';
  }
  const sub = $('#featureImport');
  if (sub && sub.dataset.onlineMode !== '0') {
    sub.dataset.onlineMode = '0';
    sub.innerHTML = '<svg class="icon"><use href="#i-folder"/></svg>导入歌曲';
  }
  // 「全部 N 首」只对每日推荐有意义，本地模式没有这个页面
  const all = $('#recommendAll');
  if (all) all.hidden = true;
}

function renderRecommendations() {
  const target = $('#recommendRow');
  if (!target) return;
  // 在线模块（online.js）后加载：一旦它拿到了每日推荐，首页这块就交给它渲染，
  // 这里的本地推荐只作为「没网 / 没登录 / 还没拉到数据」时的兜底。
  if (typeof renderHomeCardsOnline === 'function' && renderHomeCardsOnline()) return;
  restoreHomeLocalChrome();
  if (!state.songs.length) {
    target.innerHTML = emptyHtml('资料库还是空的', '导入本地音乐后这里会出现推荐卡片');
    return;
  }
  const list = [];
  const count = Math.min(4, state.songs.length);
  for (let i = 0; i < count; i += 1) {
    list.push(state.songs[(state.recommendationOffset + i) % state.songs.length]);
  }
  target.innerHTML = list.map(cardHtml).join('');
}

function renderFeature() {
  const card = $('#featureCard');
  if (!card) return;
  // 首页主卡片优先展示账号每日推荐，拿不到才回落到本地曲库
  if (typeof renderHomeHeroOnline === 'function' && renderHomeHeroOnline()) return;
  restoreHomeLocalChrome();
  const songs = state.songs;
  const cover = $('#featureCover');
  const stamp = $('#featureStamp');
  const tag = $('#featureTag');
  const title = $('#featureTitle');
  const desc = $('#featureDesc');
  const meta = $('#featureMeta');
  const play = $('#featurePlay');
  card.classList.toggle('is-empty', !songs.length);

  if (!songs.length) {
    if (cover) cover.src = DEFAULT_COVER;
    if (stamp) stamp.hidden = true;
    if (tag) tag.textContent = '等待导入';
    if (title) title.textContent = '还没有歌曲';
    if (desc) desc.textContent = '导入本机的音乐文件或整个文件夹，扫描完成后就能在这里播放。';
    if (meta) meta.innerHTML = '<span>支持 MP3 · FLAC · AAC · WAV 等常见格式</span>';
    if (play) {
      play.innerHTML = '<svg class="icon filled"><use href="#i-play"/></svg>扫描导入';
    }
    return;
  }

  const current = getTrack(state.currentId) || songs[0];
  const total = songs.reduce((sum, song) => sum + (song.duration || 0), 0);
  if (cover) cover.src = current.cover || DEFAULT_COVER;
  if (stamp) {
    stamp.hidden = false;
    stamp.innerHTML = lossless(current.format) ? 'LOSSLESS<br />LOCAL' : `${escapeHtml(current.format || 'AUDIO')}<br />LOCAL`;
  }
  if (tag) tag.textContent = '本地音乐库';
  if (title) title.textContent = current.title;
  if (desc) desc.textContent = `${current.artist} · ${current.album}`;
  if (meta) {
    meta.innerHTML = `<span>${escapeHtml(current.artist)}</span><b>·</b><span>${songs.length} 首歌曲</span><b>·</b><span>${formatDuration(total)}</span>`;
  }
  if (play) {
    play.innerHTML = '<svg class="icon filled"><use href="#i-play"/></svg>开始播放';
  }
}

function renderLocalTracks() {
  const songs = filteredSongs();
  $('#localTrackList').innerHTML = songs.length
    ? songs.map(trackRowHtml).join('')
    : emptyHtml(state.query ? '没有找到匹配歌曲' : '这个格式还没有歌曲', state.query ? '换一个关键词或格式试试' : '点击右上角“导入音乐”添加文件');
}

function renderRecent() {
  const songs = state.recent.map(getTrack).filter(Boolean).slice(0,4);
  $('#recentRow').innerHTML = songs.length
    ? songs.map(cardHtml).join('')
    : emptyHtml('还没有播放记录', '播放过的音乐会出现在这里');
}

function renderFavorites() {
  const target = $('#favoriteTrackList');
  if (!target) return;
  const songs = state.songs.filter(song => state.favorites.has(song.id));
  // 在线收藏由 online.js 维护（localStorage 里的 orange-online-lib），
  // 这里拼在本地点赞后面，收藏页就能同时看到本地与在线的红心歌曲
  const onlineHtml = typeof renderOnlineFavorites === 'function' ? renderOnlineFavorites() : '';
  // 登录账号在平台上的红心（网易云「我喜欢的音乐」等）也并进来，
  // 数据没拉过就先渲染占位，拉完由 ensureFavoritesPlatform 再重绘一次
  const platformHtml = typeof renderPlatformFavorites === 'function' ? renderPlatformFavorites() : '';
  target.innerHTML = (songs.length || onlineHtml || platformHtml)
    ? songs.map(trackRowHtml).join('') + onlineHtml + platformHtml
    : emptyHtml('还没有喜爱的歌曲', '点击歌曲旁的心形按钮收藏，或登录在线音乐账号同步红心');
  if (typeof ensureFavoritesPlatform === 'function') ensureFavoritesPlatform();
}

/**
 * 没有封面的歌单，按名字算一个稳定色相当底色。
 * 四张卡片全是同一种浅灰蓝会很闷，而随机会让同一个歌单每次刷新都变色，
 * 所以用名字的字符和取模：同名永远同色，不同歌单基本不撞色。
 */
function playlistHue(playlist) {
  const text = String(playlist?.name || '歌单');
  let sum = 0;
  for (const char of text) sum += char.codePointAt(0);
  // 乘上黄金角再取模：直接取模的话，名字相近的歌单色相会挤在一起（一片紫粉）。
  // 但取模 360 会跑出绿、青、紫、蓝 —— 歌单页四张卡四种色，和整站的红色主调冲突。
  // 收敛到红→橙→金（0°~58°）这个区间，既有区分度又不脱节。
  return (sum * 137) % 58;
}

function playlistCoverHtml(playlist, overlay = '') {
  // 1) 自定义封面优先（编辑弹窗里选的图）
  // 2) 否则用「最后加进来的那首歌」的封面 —— tracks 是 push 到末尾的，所以取最后一个
  // 3) 再不行才退回占位图标
  // 注意：没内嵌封面的歌，cover 字段就是默认占位图，不能当封面用，
  // 否则整张卡都是那张橙色的 App 图标
  const tracks = playlist.tracks.map(getTrack).filter(Boolean);
  const custom = playlist.cover && playlist.cover !== DEFAULT_COVER ? playlist.cover : '';
  const latest = tracks[tracks.length - 1] || tracks[0];
  const latestCover = latest?.cover && latest.cover !== DEFAULT_COVER ? latest.cover : '';
  const cover = custom || latestCover;
  if (!cover) {
    return `<div class="playlist-cover single"><div class="playlist-symbol" style="--pl-hue:${playlistHue(playlist)}"><svg class="icon"><use href="#i-list"/></svg></div>${overlay}</div>`;
  }
  return `<div class="playlist-cover single"><img src="${escapeHtml(cover)}" alt="" loading="lazy" />${overlay}</div>`;
}

/* ==========================================================================
   歌单：卡片 → 详情页
   以前点卡片直接就开播，想看看里面有什么歌都没办法。现在卡片只负责「打开」，
   播放交给卡片右下角的播放键；详情页里再按曲目单首播放 / 整单播放。
   ========================================================================== */

function playlistTracksOf(playlist) {
  return (playlist?.tracks || []).map(getTrack).filter(Boolean);
}

function durationText(seconds) {
  const total = Math.round(Number(seconds) || 0);
  if (total <= 0) return '';
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  if (hours) return minutes ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
  if (!minutes) return '不到 1 分钟';
  return `${minutes} 分钟`;
}

/** 卡片/详情页共用的副标题：曲目数 · 总时长 · 本地/在线构成 */
function playlistMetaParts(playlist) {
  const tracks = playlistTracksOf(playlist);
  const online = tracks.filter(track => track._online).length;
  const parts = [`${playlist.tracks.length} 首歌曲`];
  const dur = durationText(tracks.reduce((sum, track) => sum + (Number(track.duration) || 0), 0));
  if (dur) parts.push(dur);
  if (online && online < tracks.length) parts.push(`本地 ${tracks.length - online} · 在线 ${online}`);
  else if (online) parts.push('全部来自在线');
  return parts;
}

function playlistCoverSrc(playlist) {
  const tracks = playlistTracksOf(playlist);
  const custom = playlist.cover && playlist.cover !== DEFAULT_COVER ? playlist.cover : '';
  // 封面规则：自定义优先，否则用最后加进来的那首歌（默认占位图不算封面）
  const latest = tracks[tracks.length - 1] || tracks[0];
  const latestCover = latest?.cover && latest.cover !== DEFAULT_COVER ? latest.cover : '';
  return custom || latestCover;
}

function renderPlaylists() {
  const grid = $('#playlistGrid');
  if (!grid) return;
  const html = state.playlists.map(playlist => {
    const parts = playlistMetaParts(playlist);
    const meta = parts.length > 1 ? parts.slice(1).join(' · ') : '还没有歌曲';
    return `
    <article class="playlist-card" data-playlist="${playlist.id}" tabindex="0" role="button"
      aria-label="打开歌单 ${escapeHtml(playlist.name)}">
      ${playlistCoverHtml(playlist, `
        <button class="playlist-play" data-play-playlist="${playlist.id}" aria-label="播放 ${escapeHtml(playlist.name)}">
          <svg class="icon"><use href="#i-play"/></svg>
        </button>`)}
      <button class="playlist-more" data-pl-menu-toggle="${playlist.id}" aria-haspopup="menu"
        aria-expanded="false" title="更多操作" aria-label="歌单「${escapeHtml(playlist.name)}」的更多操作">
        <svg class="icon"><use href="#i-more"/></svg>
      </button>
      <div class="playlist-info">
        <strong>${escapeHtml(playlist.name)}</strong>
        <span>${escapeHtml(`${playlist.tracks.length} 首 · ${meta}`)}</span>
      </div>
    </article>`;
  }).join('');
  grid.innerHTML = html || emptyHtml('还没有歌单', '点右上角「新建歌单」建一个，或从任意歌曲的「+」加进来');
  const countNode = $('#playlistCount');
  if (countNode) countNode.textContent = state.playlists.length ? `${state.playlists.length} 个` : '';
  // 详情页开着的时候（比如在详情里移除了一首歌），同步重画
  if (state.page === 'playlist') renderPlaylistPage();
}

let currentPlaylistId = null;
// 从列表点进详情前记一下列表滚到哪了，返回时原样恢复
let libraryScrollTop = 0;

function currentPlaylist() {
  return state.playlists.find(item => item.id === currentPlaylistId) || null;
}

function openPlaylistPage(id) {
  const playlist = state.playlists.find(item => item.id === id);
  if (!playlist) {
    showToast('这个歌单已经不在了');
    return;
  }
  closePlMenu();
  const scroller = $('.main-content');
  if (state.page === 'library' && scroller) libraryScrollTop = scroller.scrollTop;
  currentPlaylistId = id;
  // showPage 里已经会渲染详情页，这里不再重复调一次
  showPage('playlist');
  scroller?.scrollTo({ top: 0 });
}

function closePlaylistPage() {
  currentPlaylistId = null;
  showPage('library');
  // 列表滚回去，别每次都从头开始找刚才那个歌单
  const scroller = $('.main-content');
  if (scroller && libraryScrollTop) {
    requestAnimationFrame(() => scroller.scrollTo({ top: libraryScrollTop }));
  }
}

function plRowHtml(track, index, options = {}) {
  const favorite = state.favorites.has(track.id);
  const current = state.currentId === track.id;
  const isOnline = Boolean(track._online);
  const source = isOnline && typeof olSourceMeta === 'function' ? olSourceMeta(track.source).short : '本地文件';
  const format = isOnline ? '在线' : (track.format || '本地');
  const badgeClass = isOnline ? 'pl-badge online' : (lossless(track.format) ? 'pl-badge lossless' : 'pl-badge');
  // 没有内嵌封面的歌，cover 就是默认占位图，整行一片橙色 App 图标；
  // 这里换成中性的音符方块，列表安静很多
  const cover = track.cover && track.cover !== DEFAULT_COVER ? track.cover : '';
  return `
    <div class="pl-row ${current ? 'playing' : ''} ${current && state.playing ? 'is-playing' : ''}" data-pl-row="${track.id}" tabindex="0">
      <div class="pl-row-index">
        <span>${String(index + 1).padStart(2, '0')}</span>
        <span class="eq-bars" aria-hidden="true"><i></i><i></i><i></i></span>
        <button class="icon-button" data-pl-play="${track.id}" aria-label="播放 ${escapeHtml(track.title)}">
          <svg class="icon filled"><use href="#${current && state.playing ? 'i-pause' : 'i-play'}"/></svg>
        </button>
      </div>
      <div class="pl-row-main">
        ${cover
          ? `<img src="${escapeHtml(cover)}" alt="" loading="lazy" />`
          : `<span class="pl-row-ph"><svg class="icon"><use href="#i-nav-note"/></svg></span>`}
        <div class="pl-row-text">
          <div class="pl-row-title"><span>${escapeHtml(track.title)}</span></div>
          <div class="pl-row-sub">${escapeHtml(track.artist || '未知歌手')} · ${escapeHtml(source)}</div>
        </div>
      </div>
      <div class="pl-row-album">${escapeHtml(track.album || '—')}</div>
      <div class="pl-row-format"><span class="${badgeClass}">${escapeHtml(format)}</span></div>
      <div class="pl-row-dur">${formatTime(track.duration)}</div>
      <div class="pl-row-actions">
        <button class="icon-button favorite ${favorite ? 'active' : ''}" data-favorite="${track.id}"
          title="${favorite ? '取消喜欢' : '加入我喜欢'}" aria-label="喜欢">
          <svg class="icon"><use href="#i-heart"/></svg>
        </button>
        <button class="icon-button" data-pl-queue="${track.id}" title="加入播放队列" aria-label="加入播放队列">
          <svg class="icon"><use href="#i-plus"/></svg>
        </button>
        <button class="icon-button" data-pl-add="${track.id}" title="加到别的歌单" aria-label="加到别的歌单">
          <svg class="icon"><use href="#i-list"/></svg>
        </button>
        ${options.hideRemove ? '' : `<button class="icon-button danger" data-pl-remove="${track.id}" title="从本歌单移除" aria-label="从本歌单移除">
          <svg class="icon"><use href="#i-x"/></svg>
        </button>`}
      </div>
    </div>`;
}

function renderPlaylistPage() {
  const hero = $('#plHero');
  const list = $('#plTrackList');
  const table = $('#plTable');
  if (!hero || !list) return;
  const playlist = currentPlaylist();
  if (!playlist) {
    // 歌单在别处被删掉了：退回列表，别留一页空白
    closePlaylistPage();
    return;
  }
  const tracks = playlistTracksOf(playlist);
  const cover = playlistCoverSrc(playlist);
  const meta = playlistMetaParts(playlist);
  const barTitle = $('#plBarTitle');
  if (barTitle) barTitle.textContent = playlist.name;
  // 顶栏面包屑跟着歌单名走（改名后重绘也能同步，不用再调一次 showPage）
  const titlebarPage = $('#titlebarPage');
  if (titlebarPage) titlebarPage.textContent = playlist.name;

  hero.innerHTML = `
    <div class="pl-hero-cover">
      ${cover
        ? `<img src="${escapeHtml(cover)}" alt="" />`
        : `<div class="pl-hero-fallback" style="--pl-hue:${playlistHue(playlist)}"><svg class="icon"><use href="#i-list"/></svg></div>`}
    </div>
    <div class="pl-hero-copy">
      <p class="pl-eyebrow">我的歌单</p>
      <h1>${escapeHtml(playlist.name)}</h1>
      <div class="pl-meta">
        ${meta.map((part, index) => `${index ? '<i></i>' : ''}<span>${escapeHtml(part)}</span>`).join('')}
      </div>
      <div class="pl-actions">
        <button class="button primary" data-pl-action="play-all" ${tracks.length ? '' : 'disabled'}>
          <svg class="icon filled"><use href="#i-play"/></svg>播放全部
        </button>
        <button class="button secondary" data-pl-action="shuffle" ${tracks.length ? '' : 'disabled'}>
          <svg class="icon"><use href="#i-shuffle"/></svg>随机播放
        </button>
        <button class="button secondary icon-only" data-pl-menu-toggle="${playlist.id}"
          aria-haspopup="menu" aria-expanded="false" title="更多操作" aria-label="更多操作">
          <svg class="icon"><use href="#i-more"/></svg>
        </button>
      </div>
    </div>`;

  if (table) table.hidden = !tracks.length;
  list.innerHTML = tracks.length ? tracks.map(plRowHtml).join('') : '';
  // 空状态放在表格外面：表格一旦 hidden，塞在里面的提示也跟着消失
  const emptyHost = $('#plEmptyHost');
  if (emptyHost) {
    emptyHost.innerHTML = tracks.length
      ? ''
      : `<div class="empty-state pl-empty"><strong>这个歌单还是空的</strong><span>去「歌曲」或「在线」里点歌曲旁的「+」，把它加进来</span>
        <div class="empty-actions">
          <button class="button secondary small" data-pl-action="go-songs">去我的歌曲</button>
          <button class="button secondary small" data-pl-action="go-online">去在线音乐</button>
        </div></div>`;
  }
}

/** 从歌单里按顺序播放；给了 startId 就从那首开始（队列仍是整张歌单） */
function playPlaylistFrom(id, startId = '', shuffled = false) {
  const playlist = state.playlists.find(item => item.id === id);
  if (!playlist) return;
  const tracks = playlistTracksOf(playlist);
  if (!tracks.length) {
    showToast('这个歌单还是空的');
    return;
  }
  const ordered = shuffled ? [...tracks].sort(() => Math.random() - .5) : tracks;
  state.queue = ordered.map(track => track.id);
  renderQueue();
  saveLibrary();
  const start = startId && state.queue.includes(startId) ? startId : state.queue[0];
  playTrack(start);
  showToast(shuffled ? `随机播放「${playlist.name}」` : `正在播放歌单「${playlist.name}」`);
}

/* ---------------------------- 歌单「更多」菜单 ---------------------------- */

function closePlMenu() {
  const menu = $('#plMenu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  menu.innerHTML = '';
  $$('[data-pl-menu-toggle][aria-expanded="true"]').forEach(button => button.setAttribute('aria-expanded', 'false'));
}

function openPlMenu(anchor, playlistId) {
  const menu = $('#plMenu');
  const playlist = state.playlists.find(item => item.id === playlistId);
  if (!menu || !playlist) return;
  const wasOpen = !menu.hidden && menu.dataset.playlist === playlistId;
  closePlMenu();
  if (wasOpen) return;
  // 已经在详情页里了就不必再给一个「打开歌单」
  const onThisPage = state.page === 'playlist' && currentPlaylistId === playlistId;
  menu.innerHTML = `
    ${onThisPage ? '' : `<button type="button" role="menuitem" data-pl-menu="open"><svg class="icon"><use href="#i-list"/></svg>打开歌单</button>`}
    <button type="button" role="menuitem" data-pl-menu="edit"><svg class="icon"><use href="#i-audio-lines"/></svg>重命名 / 换封面</button>
    <button type="button" role="menuitem" data-pl-menu="export"><svg class="icon"><use href="#i-upload"/></svg>导出 m3u 歌单</button>
    <div class="pl-menu-sep"></div>
    <button type="button" role="menuitem" class="danger" data-pl-menu="delete"><svg class="icon"><use href="#i-trash"/></svg>删除歌单</button>`;
  menu.dataset.playlist = playlistId;
  menu.hidden = false;
  anchor?.setAttribute('aria-expanded', 'true');
  // 贴着按钮弹，超出窗口就往里收 / 翻到上方
  const rect = anchor.getBoundingClientRect();
  const box = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.right - box.width, window.innerWidth - box.width - 8));
  let top = rect.bottom + 6;
  if (top + box.height > window.innerHeight - 8) top = Math.max(8, rect.top - box.height - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.querySelector('button')?.focus({ preventScroll: true });
}

function runPlMenuAction(action, playlistId) {
  const playlist = state.playlists.find(item => item.id === playlistId);
  closePlMenu();
  if (!playlist) return;
  if (action === 'open') openPlaylistPage(playlist.id);
  if (action === 'edit') openPlaylistEdit(playlist.id);
  if (action === 'export') exportPlaylist(playlist.id);
  if (action === 'delete') deletePlaylist(playlist.id);
}

function deletePlaylist(id) {
  const playlist = state.playlists.find(item => item.id === id);
  if (!playlist) return;
  if (!window.confirm(`确定要删除歌单“${playlist.name}”吗？\n歌单里的歌曲文件不会被删除。`)) return;
  state.playlists = state.playlists.filter(item => item.id !== id);
  saveState();
  if (currentPlaylistId === id) {
    currentPlaylistId = null;
    if (state.page === 'playlist') showPage('library');
  }
  renderPlaylists();
  renderCounts();
  if (typeof syncPlaylistViews === 'function' && state.page === 'online') syncPlaylistViews();
  showToast(`已删除歌单「${playlist.name}」`);
}

/* ==========================================================================
   专辑 / 艺术家视图
   本地曲库以前只有一张平铺的歌曲表：几千首歌想「听整张专辑」只能靠搜。
   这里按标签把曲目分组，卡片点进去是详情页（复用歌单详情那套排版）。
   ========================================================================== */

// 卡片上只放数组下标，点开时从缓存取分组 —— 专辑名里带引号、斜杠也不会把 data 属性弄坏
let albumGroupsCache = [];
let artistGroupsCache = [];
let libraryView = 'playlists';

const UNKNOWN_ALBUM = '未知专辑';
const UNKNOWN_ARTIST = '未知歌手';

/** 专辑内排序：优先认文件名 / 标题开头的序号（01 - xxx），没有就按标题 */
function albumTrackOrder(track) {
  const text = `${track.title || ''} ${(track._path || '').split(/[\\/]/).pop() || ''}`;
  const match = text.match(/(?:^|\s)(\d{1,3})[\s.\-_]/);
  return match ? Number(match[1]) : 9999;
}

function groupSongs(byArtist) {
  const map = new Map();
  for (const song of state.songs) {
    const artist = (song.artist || '').trim() || UNKNOWN_ARTIST;
    const album = (song.album || '').trim() || UNKNOWN_ALBUM;
    const name = byArtist ? artist : album;
    // 同名专辑不同歌手是两张专辑，key 必须带上歌手
    const key = byArtist ? artist : `${album}\u0000${artist}`;
    if (!map.has(key)) {
      map.set(key, { key, name, artist, album, tracks: [] });
    }
    map.get(key).tracks.push(song);
  }
  const groups = [...map.values()];
  for (const group of groups) {
    group.tracks.sort((a, b) => {
      const diff = albumTrackOrder(a) - albumTrackOrder(b);
      return diff || String(a.title).localeCompare(String(b.title), 'zh-CN');
    });
    // 封面取第一张有真封面的：整张专辑通常是同一张，没有就留空用占位
    group.cover = group.tracks.find(track => track.cover && track.cover !== DEFAULT_COVER)?.cover || '';
    group.duration = group.tracks.reduce((sum, track) => sum + (Number(track.duration) || 0), 0);
    group.format = group.tracks.some(track => lossless(track.format)) ? '无损' : '';
    if (byArtist) {
      group.albumCount = new Set(group.tracks.map(track => (track.album || UNKNOWN_ALBUM).trim())).size;
    }
  }
  groups.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return groups;
}

function albumCardHtml(group, index, kind) {
  const sub = kind === 'artist'
    ? `${group.albumCount} 张专辑 · ${group.tracks.length} 首`
    : `${group.tracks.length} 首 · ${group.artist}`;
  return `
    <article class="album-card" data-album-index="${index}" data-album-kind="${kind}" tabindex="0" role="button"
      aria-label="打开 ${escapeHtml(group.name)}">
      <div class="album-cover">
        ${group.cover
          ? `<img src="${escapeHtml(group.cover)}" alt="" loading="lazy" />`
          : `<div class="album-cover-fallback"><svg class="icon"><use href="#i-nav-note"/></svg></div>`}
        <button class="playlist-play" data-album-play="${index}" data-album-kind="${kind}"
          aria-label="播放 ${escapeHtml(group.name)}"><svg class="icon"><use href="#i-play"/></svg></button>
      </div>
      <div class="playlist-info">
        <strong>${escapeHtml(group.name)}</strong>
        <span>${escapeHtml(sub)}</span>
      </div>
    </article>`;
}

function renderAlbums() {
  const target = $('#albumGrid');
  if (!target) return;
  albumGroupsCache = groupSongs(false);
  target.innerHTML = albumGroupsCache.length
    ? albumGroupsCache.map((group, index) => albumCardHtml(group, index, 'album')).join('')
    : emptyHtml('还没有可归类的专辑', '导入音乐并扫描完成后，这里会按专辑标签自动分组');
  syncLibraryCounts();
}

function renderArtists() {
  const target = $('#artistGrid');
  if (!target) return;
  artistGroupsCache = groupSongs(true);
  target.innerHTML = artistGroupsCache.length
    ? artistGroupsCache.map((group, index) => albumCardHtml(group, index, 'artist')).join('')
    : emptyHtml('还没有可归类的歌手', '歌曲的标签里没有歌手信息时，会统一归到「未知歌手」');
  syncLibraryCounts();
}

function syncLibraryCounts() {
  const albumCount = $('#albumCount');
  const artistCount = $('#artistCount');
  if (albumCount) {
    const count = albumGroupsCache.length || groupSongs(false).length;
    albumCount.textContent = count;
    albumCount.hidden = !count;
  }
  if (artistCount) {
    const count = artistGroupsCache.length || groupSongs(true).length;
    artistCount.textContent = count;
    artistCount.hidden = !count;
  }
}

/** 资料库页顶部的「歌单 / 专辑 / 艺术家」切换 */
function switchLibraryView(view) {
  libraryView = view;
  $$('#librarySwitch .chip').forEach(chip => chip.classList.toggle('active', chip.dataset.libraryView === view));
  $$('#libraryPage .library-panel').forEach(panel => panel.classList.toggle('active', panel.dataset.panel === view));
  // 页头标题、说明文字跟着视图变，返回时不至于还写着「歌单」
  const heading = $('#libraryPage .page-intro h1');
  const labels = { playlists: '歌单', albums: '专辑', artists: '艺术家' };
  if (heading) {
    const count = heading.querySelector('.section-count');
    heading.textContent = labels[view] || '歌单';
    if (count) heading.appendChild(count);
  }
  const subtitle = $('#libraryPage .page-subtitle');
  if (subtitle) {
    subtitle.textContent = {
      playlists: '把本地文件和网络歌曲整理到一起，点开任意歌单查看曲目。',
      albums: '按专辑标签自动分组，点开任意一张看完整曲目。',
      artists: '按歌手标签自动分组，点开任意一位看他名下的所有作品。'
    }[view] || '';
  }
  // 「新建歌单」只属于歌单视图，藏在专辑 / 艺术家页只会让人误以为能建专辑
  const newPlaylist = document.querySelector('#libraryPage [data-action="new-playlist"]');
  if (newPlaylist) newPlaylist.hidden = view !== 'playlists';
  if (view === 'albums') renderAlbums();
  if (view === 'artists') renderArtists();
}

function collectionGroups(kind) {
  if (kind === 'artist') {
    if (!artistGroupsCache.length) artistGroupsCache = groupSongs(true);
    return artistGroupsCache;
  }
  if (!albumGroupsCache.length) albumGroupsCache = groupSongs(false);
  return albumGroupsCache;
}

function currentCollection() {
  const collection = state.collection;
  if (!collection) return null;
  const group = collectionGroups(collection.kind).find(item => item.key === collection.key);
  return group || null;
}

function openCollectionPage(kind, index) {
  const group = collectionGroups(kind)[index];
  if (!group) return;
  state.collection = { kind, key: group.key };
  showPage('collection');
  $('.main-content')?.scrollTo({ top: 0 });
}

function closeCollectionPage() {
  state.collection = null;
  showPage('library');
}

function playCollection(startId = '', shuffled = false) {
  const group = currentCollection();
  if (!group?.tracks.length) return;
  const ordered = shuffled ? [...group.tracks].sort(() => Math.random() - .5) : group.tracks;
  state.queue = ordered.map(track => track.id);
  renderQueue();
  saveLibrary();
  const start = startId && state.queue.includes(startId) ? startId : state.queue[0];
  playTrack(start);
  showToast(shuffled ? `随机播放「${group.name}」` : `正在播放「${group.name}」`);
}

function renderCollectionPage() {
  const hero = $('#colHero');
  const list = $('#colTrackList');
  const table = $('#colTable');
  if (!hero || !list) return;
  const group = currentCollection();
  if (!group) {
    // 曲库变了（删歌 / 重新扫描）之后原来的分组可能已经不存在
    closeCollectionPage();
    return;
  }
  const kind = state.collection.kind;
  const cover = group.cover;
  // 专辑详情里每行再写一遍同名专辑是纯噪音，直接把这一列收掉
  document.querySelector('#collectionPage')?.classList.toggle('is-album', kind === 'album');
  const barTitle = $('#colBarTitle');
  if (barTitle) barTitle.textContent = group.name;
  const backLabel = $('#colBarBackLabel');
  if (backLabel) backLabel.textContent = kind === 'artist' ? '艺术家' : '专辑';
  const titlebarPage = $('#titlebarPage');
  if (titlebarPage) titlebarPage.textContent = group.name;

  const meta = kind === 'artist'
    ? [`${group.albumCount} 张专辑`, `${group.tracks.length} 首歌曲`, formatDuration(group.duration)]
    : [group.artist || UNKNOWN_ARTIST, `${group.tracks.length} 首歌曲`, formatDuration(group.duration)];

  hero.innerHTML = `
    <div class="pl-hero-cover">
      ${cover
        ? `<img src="${escapeHtml(cover)}" alt="" />`
        : `<div class="pl-hero-fallback" style="--pl-hue:${kind === 'artist' ? 18 : 8}"><svg class="icon"><use href="#i-nav-note"/></svg></div>`}
    </div>
    <div class="pl-hero-copy">
      <p class="pl-eyebrow">${kind === 'artist' ? '艺术家' : '专辑'}</p>
      <h1>${escapeHtml(group.name)}</h1>
      <div class="pl-meta">
        ${meta.map((part, index) => `${index ? '<i></i>' : ''}<span>${escapeHtml(part)}</span>`).join('')}
      </div>
      <div class="pl-actions">
        <button class="button primary" data-col-action="play-all">
          <svg class="icon filled"><use href="#i-play"/></svg>播放全部
        </button>
        <button class="button secondary" data-col-action="shuffle">
          <svg class="icon"><use href="#i-shuffle"/></svg>随机播放
        </button>
      </div>
    </div>`;

  if (table) table.hidden = !group.tracks.length;
  list.innerHTML = group.tracks.map((track, index) => plRowHtml(track, index, { hideRemove: true })).join('');
  const emptyHost = $('#colEmptyHost');
  if (emptyHost) emptyHost.innerHTML = group.tracks.length ? '' : emptyHtml('这里没有歌曲', '曲库变化后这个分组可能已经空了');
}

function renderQueue() {
  const target = $('#queueList');
  if (!target) return;
  const songs = state.queue.map(getTrack).filter(Boolean);
  if (!songs.length) {
    target.innerHTML = emptyHtml('播放队列是空的', '从资料库里选择歌曲开始播放');
    return;
  }
  target.innerHTML = songs.map(song => `
    <div class="queue-row ${song.id === state.currentId ? 'active' : ''}" data-queue-track="${song.id}">
      <img src="${song.cover || DEFAULT_COVER}" alt="" />
      <div><strong>${escapeHtml(song.title)}</strong><span>${escapeHtml(song.artist)}</span></div>
      <span>${formatTime(song.duration)}</span>
      <button class="icon-button danger" data-remove="${song.id}" aria-label="从资料库移除" title="从资料库移除"><svg class="icon"><use href="#i-trash"/></svg></button>
    </div>`).join('');
}

function renderCounts() {
  const favCount = state.songs.filter(song => state.favorites.has(song.id)).length;
  const sideSongs = $('#sideSongCount');
  const sideFavs = $('#sideFavCount');
  const profileSongs = $('#profileSongCount');
  if (sideSongs) sideSongs.textContent = state.songs.length;
  if (sideFavs) sideFavs.textContent = favCount;
  if (profileSongs) profileSongs.textContent = state.songs.length;
  // 侧栏底部那一行统计：给下面那块留白一点内容，别是一片空玻璃
  const stat = $('#sidebarStat');
  if (stat) {
    stat.innerHTML = state.songs.length
      ? `<b>${state.songs.length}</b> 首歌曲<i>·</i><b>${favCount}</b> 首喜爱`
      : '资料库还是空的';
  }
}

function renderSearchResults() {
  const target = $('#searchRecentRow');
  const heading = $('#searchHeading');
  if (!target || !heading) return;
  const query = state.query.trim().toLowerCase();
  // 「查看全部」是给最近播放用的；一进搜索结果就没有意义了
  const viewAll = $('.search-recent-section .view-all');
  if (viewAll) viewAll.hidden = Boolean(query);
  // 同一个关键词也要交给在线模块：本地结果即时出，在线结果防抖后追加在下面
  if (typeof renderGlobalSearch === 'function') renderGlobalSearch(state.query);
  if (!query) {
    const recent = state.recent.map(getTrack).filter(Boolean).slice(0, 8);
    heading.textContent = '最近播放的歌曲';
    target.innerHTML = recent.length
      ? recent.map(cardHtml).join('')
      : emptyHtml('还没有播放记录', '播放过的音乐会出现在这里');
    return;
  }
  const scope = state.searchScope || 'all';
  const matches = state.songs.filter(song => {
    if (scope === 'title') return String(song.title ?? '').toLowerCase().includes(query);
    if (scope === 'artist') return String(song.artist ?? '').toLowerCase().includes(query);
    if (scope === 'album') return String(song.album ?? '').toLowerCase().includes(query);
    return [song.title, song.artist, song.album, song.format]
      .some(value => String(value ?? '').toLowerCase().includes(query));
  });
  heading.textContent = `搜索结果 · ${matches.length} 首`;
  if (!matches.length) {
    // 本地没命中时不再占一大块空态：在线结果紧跟在下面，压成一行提示更好衔接。
    // 如果只是被「歌名/歌手/专辑」范围筛掉了，顺手告诉用户在「全部」里还有几首。
    const scopeWord = { title: '歌名', artist: '歌手', album: '专辑' }[scope] || '';
    let broaden = '';
    if (scope !== 'all') {
      const wider = state.songs.filter(song => [song.title, song.artist, song.album, song.format]
        .some(value => String(value ?? '').toLowerCase().includes(query))).length;
      if (wider) broaden = ` <button class="search-empty-switch" type="button">「全部」里还有 ${wider} 首</button>`;
    }
    const where = scopeWord ? `本地曲库里没有${scopeWord}匹配「${escapeHtml(state.query.trim())}」的歌` : `本地曲库里没有匹配「${escapeHtml(state.query.trim())}」的歌曲`;
    target.innerHTML = `<div class="search-empty-inline">${where}${broaden}</div>`;
    return;
  }
  if (scope === 'artist' || scope === 'album') {
    const groups = new Map();
    matches.forEach(song => {
      const key = scope === 'artist' ? song.artist : song.album;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(song);
    });
    target.innerHTML = [...groups.entries()].map(([name, songs]) => `
      <div class="search-group">
        <div class="search-group-title"><strong>${escapeHtml(name)}</strong><span>${songs.length} 首</span></div>
        <div class="card-row compact">${songs.slice(0, 12).map(cardHtml).join('')}</div>
      </div>`).join('');
    return;
  }
  target.innerHTML = matches.map(cardHtml).join('');
}

function renderAll() {
  renderSearchResults();
  renderFeature();
  renderRecommendations();
  renderLocalTracks();
  renderRecent();
  renderFavorites();
  renderPlaylists();
  renderAlbums();
  renderArtists();
  renderQueue();
  renderCounts();
  renderSelectionUi();
  // 曲库变化（导入 / 删除）后，正在看的专辑详情可能已经空了
  if (state.page === 'collection') renderCollectionPage();
}

// ---------- 多选 / 全选 ----------
function visibleSelectableIds() {
  if (state.page === 'favorites') return state.songs.filter(song => state.favorites.has(song.id)).map(song => song.id);
  return filteredSongs().map(song => song.id);
}

function renderSelectionUi() {
  document.body.classList.toggle('select-mode', state.selectMode);
  $$('.track-head').forEach(head => {
    const existing = head.querySelector('.head-check');
    if (state.selectMode && !existing) head.insertAdjacentHTML('afterbegin', '<span class="head-check"></span>');
    if (!state.selectMode && existing) existing.remove();
  });
  const bar = $('#batchBar');
  if (bar) bar.hidden = !state.selectMode;
  const count = $('#batchCount');
  if (count) count.textContent = `已选 ${state.selection.size} 首`;
  $$('.track-row').forEach(row => {
    row.classList.toggle('selected', state.selection.has(row.dataset.track));
    const box = $('input[data-select]', row);
    if (box) box.checked = state.selection.has(row.dataset.track);
  });
  $$('[data-action="toggle-select"]').forEach(button => {
    button.classList.toggle('active', state.selectMode);
    button.innerHTML = `<svg class="icon"><use href="#i-check"/></svg>${state.selectMode ? '退出多选' : '多选'}`;
  });
}

function toggleSelectMode(force) {
  state.selectMode = typeof force === 'boolean' ? force : !state.selectMode;
  if (!state.selectMode) state.selection.clear();
  renderLocalTracks();
  renderFavorites();
  renderSelectionUi();
}

function toggleSelectedSong(id) {
  if (state.selection.has(id)) state.selection.delete(id);
  else state.selection.add(id);
  renderSelectionUi();
}

function selectAllSongs(mode) {
  const ids = visibleSelectableIds();
  if (mode === 'all') ids.forEach(id => state.selection.add(id));
  else if (mode === 'none') state.selection.clear();
  else ids.forEach(id => (state.selection.has(id) ? state.selection.delete(id) : state.selection.add(id)));
  renderSelectionUi();
}

function batchRemoveSelected() {
  const ids = [...state.selection].filter(id => getTrack(id));
  if (!ids.length) {
    showToast('还没有选择歌曲');
    return;
  }
  if (!window.confirm(`将要移除 ${ids.length} 首歌曲（磁盘上的音乐文件不会被删除）。确定继续吗？`)) return;
  ids.forEach(id => removeTrack(id, { silent: true }));
  state.selection.clear();
  // removeTrack 的 silent 分支只摘数据不落盘，批量移除必须在这里补一次，
  // 否则收藏 / 最近播放 / 歌单里的这些 id 还留在 localStorage 里。
  saveState();
  saveProgress();
  saveLibrary();
  renderAll();
  updatePlayerUi();
  // 批量移除后顺手回收不再被引用的封面（放在这里而不是 removeTrack 里，避免每首各扫一遍目录）
  pruneOrphanCovers();
  showToast(`已移除 ${ids.length} 首歌曲`);
}

function updatePlayIcons() {
  const href = state.playing ? '#i-pause' : '#i-play';
  ['#playButton','#fullPlay'].forEach(selector => {
    const button = $(selector);
    if (button) $('use', button).setAttribute('href', href);
  });
  $$('.row-play use').forEach(use => {
    const trackId = use.closest('[data-play]')?.dataset.play;
    use.setAttribute('href', trackId === state.currentId && state.playing ? '#i-pause' : '#i-play');
  });
  $('#playButton').setAttribute('aria-label', state.playing ? '暂停' : '播放');
  $('#fullPlay').setAttribute('aria-label', state.playing ? '暂停' : '播放');
}

function updateFavoriteUi() {
  const active = state.favorites.has(state.currentId);
  $('#miniFavorite').classList.toggle('active', active);
  $('#fullFavorite').classList.toggle('active', active);
}

/**
 * 只同步列表里的「正在播放」状态，不重建 DOM。
 * 之前 updatePlayerUi 每换一首歌就把歌曲 / 喜爱 / 队列三个列表整段 innerHTML 重写，
 * 大曲库下切歌明显卡顿，滚动位置和键盘焦点也会丢。
 */
function refreshTrackRows() {
  $$('.track-row').forEach(row => {
    const id = row.dataset.track;
    row.classList.toggle('playing', Boolean(id) && id === state.currentId);
    row.classList.toggle('is-playing', Boolean(id) && id === state.currentId && state.playing);
    const use = row.querySelector('.row-play use');
    if (use) use.setAttribute('href', id === state.currentId && state.playing ? '#i-pause' : '#i-play');
  });
  $$('.queue-row').forEach(row => {
    row.classList.toggle('active', row.dataset.queueTrack === state.currentId);
  });
  // 歌单详情的曲目行与资料库行是两套结构，单独同步一次
  $$('.pl-row').forEach(row => {
    const id = row.dataset.plRow;
    row.classList.toggle('playing', Boolean(id) && id === state.currentId);
    row.classList.toggle('is-playing', Boolean(id) && id === state.currentId && state.playing);
    const use = row.querySelector('.pl-row-index use');
    if (use) use.setAttribute('href', id === state.currentId && state.playing ? '#i-pause' : '#i-play');
  });
}

/**
 * 全屏页封面用高分辨率版本。
 * 列表里为了省流量存的是 600px（网易云）/ 500px（QQ），但歌词页封面最大能到 520px，
 * 再叠加高分屏就是 1:1 甚至被放大，150~300px 的老封面会糊成一片。
 * 这里就地改写 URL 参数，取平台能给到的最大尺寸；本地封面（data: / file:）原样返回。
 */
function hiResCover(url) {
  // 空封面直接给占位图。以前这里返回空串，赋给 <img>.src 会变成破图图标，
  // 全屏播放页和播放条都会显示一个「碎图」而不是默认封面。
  if (!url) return DEFAULT_COVER;
  if (/^(data|blob|file):/i.test(url)) return url;
  return url
    .replace(/([?&]param=)\d+y\d+/i, (_, prefix) => `${prefix}1024y1024`)
    .replace(/T002R\d+x\d+M000/, 'T002R800x800M000');
}

function updatePlayerUi() {
  const track = getTrack(state.currentId);
  if (!track) {
    $('#miniCover').src = DEFAULT_COVER;
    $('#miniTitle').textContent = '未播放';
    $('#miniArtist').textContent = '导入歌曲后即可播放';
    $('#fullCover').src = DEFAULT_COVER;
    $('#fullTitle').textContent = '未播放';
    $('#fullArtist').textContent = '导入歌曲后即可播放';
    setQualityBadge(null, '暂无音轨');
    // 清掉上一首残留的封面取色 / 歌词背景，否则空资料库打开歌词界面仍是上一张封面的色调
    applyCoverAccent('');
    applyLyricTheme();
    ['#currentTime', '#fullCurrentTime', '#totalTime', '#fullTotalTime'].forEach(selector => {
      const node = $(selector);
      if (node) node.textContent = '0:00';
    });
    ['#seekSlider', '#fullSeekSlider'].forEach(selector => {
      const slider = $(selector);
      if (slider) { slider.value = 0; paintRange(slider, 0); }
    });
    $('#miniFavorite').classList.remove('active');
    $('#fullFavorite').classList.remove('active');
    renderLyrics();
    refreshTrackRows();
    // 资料库空了 / 没有当前曲目：把系统媒体卡片一并清掉，别在锁屏上留上一首
    syncMediaSession();
    return;
  }
  $('#miniCover').src = track.cover || DEFAULT_COVER;
  $('#miniTitle').textContent = track.title;
  $('#miniArtist').textContent = track.artist;
  $('#fullCover').src = hiResCover(track.cover);
  // 取封面主色写进 --cover-accent，供歌词倾斜的辉光上色
  applyCoverAccent(track.cover);
  applyLyricTheme();
  $('#fullTitle').textContent = track.title;
  $('#fullArtist').textContent = `${track.artist} · ${track.album}`;
  setQualityBadge(track);
  updateFavoriteUi();
  updatePlayIcons();
  renderLyrics();
  refreshTrackRows();
  pushDesktopLyricsState();
  // 系统媒体控制（锁屏 / 音量弹窗 / 媒体键）跟着当前曲目走
  syncMediaSession(track);
}

/* ----------------------------- 音频输出设备 ----------------------------- */

/**
 * 切输出设备。
 * 注意：音频是从 AudioContext 出去的（<audio> 只是音源，已经被 createMediaElementSource 接管），
 * 所以真正要改的是 audioContext.setSinkId；只改 <audio> 是没声音变化的。
 * 空串 = 系统默认设备，Windows 切输出时它会自动跟过去。
 */
async function applyOutputDevice() {
  const id = String(state.prefs.outputDevice || '');
  try {
    if (audioContext && typeof audioContext.setSinkId === 'function') {
      await audioContext.setSinkId(id);
      return true;
    }
    if (typeof audio.setSinkId === 'function') {
      await audio.setSinkId(id);
      return true;
    }
  } catch (error) {
    // 设备被拔出 / 被别的程序独占时退回默认，别让人以为播放器坏了
    if (id) {
      state.prefs.outputDevice = '';
      savePrefs();
      const select = $('#outputDevice');
      if (select) select.value = '';
      showToast('这个输出设备现在用不了，已切回系统默认');
      try { await audioContext?.setSinkId?.(''); } catch {}
    }
  }
  return false;
}

async function refreshOutputDevices() {
  const select = $('#outputDevice');
  if (!select) return;
  const devices = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []) || [];
  // deviceId 为 "default"/"communications" 的虚拟项在 Chromium 里也会出现，去掉免得列表里三行同名
  const outputs = devices.filter(item => item.kind === 'audiooutput'
    && item.deviceId && item.deviceId !== 'default' && item.deviceId !== 'communications');
  const current = String(state.prefs.outputDevice || '');
  select.innerHTML = '<option value="">跟随系统默认</option>'
    + outputs.map((item, index) => `<option value="${escapeHtml(item.deviceId)}">${escapeHtml(item.label || `输出设备 ${index + 1}`)}</option>`).join('');
  const exists = !current || outputs.some(item => item.deviceId === current);
  if (!exists) {
    state.prefs.outputDevice = '';
    savePrefs();
  }
  select.value = exists ? current : '';
  const hint = $('#outputDeviceHint');
  if (hint) {
    hint.textContent = outputs.length
      ? `已识别 ${outputs.length} 个输出设备；「跟随系统默认」会随 Windows 切换设备自动跟着变`
      : '没有识别到独立输出设备（插上耳机 / 音箱后会自动出现）';
  }
}

function initOutputDevice() {
  const select = $('#outputDevice');
  if (!select) return;
  refreshOutputDevices();
  select.addEventListener('change', async () => {
    state.prefs.outputDevice = select.value;
    savePrefs();
    const ok = await applyOutputDevice();
    const label = select.selectedOptions?.[0]?.textContent || '';
    if (!ok && select.value) return;
    showToast(select.value ? `已切换到「${label}」` : '已切回系统默认输出');
  });
  // 插拔耳机后 deviceId 会变，列表跟着刷新一次
  navigator.mediaDevices?.addEventListener?.('devicechange', () => refreshOutputDevices());
  applyOutputDevice();
}

function ensureAudioGraph() {
  if (audioContext || !window.AudioContext) return;
  try {
    audioContext = new AudioContext();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.78;
    sourceNode = audioContext.createMediaElementSource(audio);
    gainNode = audioContext.createGain();
    eqFilters = EQ_BANDS.map((frequency, index) => {
      const filter = audioContext.createBiquadFilter();
      filter.type = index === 0 ? 'lowshelf' : (index === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking');
      filter.frequency.value = frequency;
      filter.Q.value = 1;
      filter.gain.value = 0;
      return filter;
    });
    let node = sourceNode;
    eqFilters.forEach(filter => { node.connect(filter); node = filter; });
    preampNode = audioContext.createGain();
    preampNode.gain.value = 1;
    node.connect(preampNode);
    preampNode.connect(gainNode);

    // ---------- 人声消除（伴奏模式） ----------
    // 人声、贝斯、底鼓在混音里基本都摆在正中，左右声道里是同一份信号。
    // 所以 L - R 会把人声整块减掉，剩下的 L-R 只保留左右不同的乐器（吉他、和声、混响尾巴）。
    // 链路：gain ┬─ 干声(1) ─────────────────┐
    //           └─ splitter ─(L-R)×0.85 ────┤→ karaokeOut → analyser
    //                        └─ 低频补偿 ────┘
    const karaokeSplitter = audioContext.createChannelSplitter(2);
    karaokeDry = audioContext.createGain();
    karaokeWet = audioContext.createGain();
    const karaokeOut = audioContext.createGain();
    karaokeDry.gain.value = 1;
    karaokeWet.gain.value = 0;

    gainNode.connect(karaokeDry).connect(karaokeOut);
    gainNode.connect(karaokeSplitter);

    // 差分本身能量就比原混音低（人声/贝斯被减掉了），保持 1.0 不额外放大：
    // 再乘系数会把左右差异大的段落推到削波，宁可音量略降也不要失真
    const diffLeft = audioContext.createGain();
    const diffRight = audioContext.createGain();
    diffLeft.gain.value = 1;
    diffRight.gain.value = -1;
    karaokeSplitter.connect(diffLeft, 0);
    karaokeSplitter.connect(diffRight, 1);
    diffLeft.connect(karaokeWet);
    diffRight.connect(karaokeWet);

    // 纯 L-R 会把 150Hz 以下的鼓和贝斯一起削掉，听起来像手机外放。
    // 单独把低频的中置分量补回来，牺牲一点点低频人声换整体厚度。
    const karaokeBassMix = audioContext.createGain();
    karaokeBassMix.gain.value = 0.5;
    const karaokeBassLow = audioContext.createBiquadFilter();
    karaokeBassLow.type = 'lowpass';
    karaokeBassLow.frequency.value = 150;
    karaokeBassLow.Q.value = 0.7;
    const karaokeBassGain = audioContext.createGain();
    karaokeBassGain.gain.value = 0.9;
    karaokeSplitter.connect(karaokeBassMix, 0);
    karaokeSplitter.connect(karaokeBassMix, 1);
    karaokeBassMix.connect(karaokeBassLow).connect(karaokeBassGain).connect(karaokeWet);
    karaokeWet.connect(karaokeOut);

    // 单声道探测：单声道音源 L 和 R 完全一样，相减直接静音。
    // 挂两个只有输入的分析器（不参与输出），开开关前采样几帧判断。
    karaokeProbeL = audioContext.createAnalyser();
    karaokeProbeR = audioContext.createAnalyser();
    karaokeProbeL.fftSize = 512;
    karaokeProbeR.fftSize = 512;
    karaokeSplitter.connect(karaokeProbeL, 0);
    karaokeSplitter.connect(karaokeProbeR, 1);

    karaokeOut.connect(analyser);
    analyser.connect(audioContext.destination);
    // 氛围灯专用 analyser：和波形图那个（smoothing 0.78）并联，但 smoothing 调低。
    // 原因：0.78 会把瞬时鼓点拉平、让持续音读数长期挂高 —— 这正是氛围灯
    // 「一响就顶满、且不浮动」的根源（源头数据就没瞬态）。
    // 挂一个独立的、smoothing 0.4 的 analyser，才能拿到有起落的低频能量。
    // analyser 是被动读取节点，多挂一个不会改变音频流，也不影响波形图。
    //
    // fftSize 128 → 256（bin 宽 48k 下 375Hz → 187.5Hz，前 6 档从 0~2.2kHz 收到
    // 0~1.1kHz，是更纯粹的「鼓点 + 贝斯」区间）。
    // minDecibels/maxDecibels 也必须改：默认的 -100/-30 对音乐低频来说窗口太靠上，
    // 实测（-16dBFS 的鼓点素材）有 72% 的时间读数贴着 255 上限，等于动态全被削掉。
    // 拉到 -90/-10（80dB 跨度）后饱和率降到 0。
    ambientAnalyser = audioContext.createAnalyser();
    ambientAnalyser.fftSize = 256;
    ambientAnalyser.smoothingTimeConstant = 0.4;
    ambientAnalyser.minDecibels = -90;
    ambientAnalyser.maxDecibels = -10;
    gainNode.connect(ambientAnalyser);
    applyEq();
    applyReplayGain(getTrack(state.currentId));
    applyKaraoke();
    // AudioContext 建好之后才真正有 sink 可以切：第一次播放时补一次
    applyOutputDevice();
  } catch (error) {
    console.warn('Visualizer unavailable', error);
  }
}

function applyEq() {
  if (!eqFilters.length) return;
  // 关闭均衡等价于「10 段全 0 dB」；开启时走归一化，避免旧数据缺项时写进 NaN
  const on = Boolean(state.prefs.eqEnabled);
  const gains = on ? normalizedEqGains() : EQ_BANDS.map(() => 0);
  // AutoEq 的 FixedBandEQ 是「10 个 PK，Q=1.41」算出来的；原生的 shelving + Q=1
  // 只在两端形状不同，但耳机校正要贴着官方曲线走，所以有型号时整条链切成 PK。
  const correcting = on && Boolean(findAutoEqModel(state.prefs.eqHeadphone));
  eqFilters.forEach((filter, index) => {
    const isEdge = index === 0 || index === EQ_BANDS.length - 1;
    filter.type = correcting || !isEdge
      ? 'peaking'
      : (index === 0 ? 'lowshelf' : 'highshelf');
    filter.Q.value = correcting ? 1.41 : 1;
    filter.gain.value = Math.max(-12, Math.min(12, gains[index]));
  });
  if (preampNode) {
    const db = correcting ? Number(state.prefs.eqPreamp) || 0 : 0;
    preampNode.gain.value = 10 ** (db / 20);
  }
}

/* --------------------------- 耳机校正（AutoEq） --------------------------- */

/** 滑块步进是 0.5 dB：曲线按 0.5 取整，屏幕上看到的数字才和滤波器实际增益一致 */
function roundToStep(value) {
  return Math.round(Number(value) * 2) / 2;
}

/** 按 id 取 AutoEq 型号；数据由 autoeq.js 提供（build 时随 renderer 一起打包） */
function findAutoEqModel(id) {
  if (!id || typeof AUTOEQ_MODELS === 'undefined') return null;
  return AUTOEQ_MODELS.find(item => item.id === id) || null;
}

/**
 * 耳机型号选择：几百款型号原生 <select> 翻不动，改成「胶囊按钮 + 带搜索的弹层」。
 * 选中后把曲线整条写进十段增益，之后仍可继续拖滑块微调 —— 校正只是起点，不是锁死的。
 */
function initEqHeadphone() {
  const trigger = $('#eqHeadphoneTrigger');
  const pop = $('#eqHpPop');
  const search = $('#eqHpSearch');
  if (!trigger || !pop || typeof AUTOEQ_MODELS === 'undefined') return;

  trigger.addEventListener('click', () => {
    if (pop.hidden) openEqHeadphonePicker(); else closeEqHeadphonePicker();
  });

  search.addEventListener('input', () => renderEqHeadphoneList(search.value));
  search.addEventListener('keydown', event => {
    const items = eqHpVisibleItems();
    if (event.key === 'Escape') {
      event.preventDefault();
      closeEqHeadphonePicker();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!items.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = eqHpActiveIndex < 0
        ? (step > 0 ? 0 : items.length - 1)
        : (eqHpActiveIndex + step + items.length) % items.length;
      setEqHpActive(next);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const target = items[eqHpActiveIndex] || items[0];
      if (target) applyEqHeadphoneSelection(target.dataset.id || '');
      closeEqHeadphonePicker();
    }
  });

  const listEl = $('#eqHpList');
  listEl.addEventListener('click', event => {
    const item = event.target.closest('.eq-hp-item');
    if (!item) return;
    applyEqHeadphoneSelection(item.dataset.id || '');
    closeEqHeadphonePicker();
  });
  // 滚到底自动续下一批，两千多款不用一次塞进 DOM
  listEl.addEventListener('scroll', () => {
    if (eqHpDrawnTotal() >= eqHpQueue.length) return;
    if (listEl.scrollTop + listEl.clientHeight < listEl.scrollHeight - 80) return;
    appendEqHeadphoneRows(EQ_HP_MORE);
    updateEqHpFoot(($('#eqHpSearch').value || '').trim());
  });

  // 点面板和按钮以外的地方就收起来
  document.addEventListener('pointerdown', event => {
    if (pop.hidden) return;
    if (pop.contains(event.target) || trigger.contains(event.target)) return;
    closeEqHeadphonePicker();
  }, true);
  // 面板是 fixed 定位，页面一滚就和按钮脱位了，跟着重新贴一次
  document.addEventListener('scroll', () => {
    if (!pop.hidden) positionEqHeadphonePicker();
  }, true);
  window.addEventListener('resize', () => closeEqHeadphonePicker());

  syncEqHeadphoneTrigger();
  syncEqHeadphoneHint();
}

/** 归一化：去掉空格 / 连字符 / 点，好让 "hd650" 命中 "HD 650"、"airpodspro2" 命中 "AirPods Pro 2" */
function eqHpNorm(text) {
  return String(text || '').toLowerCase().replace(/[\s\-_.()]+/g, '');
}

/**
 * 搜索型号：空格分词的多个关键词是 AND，整串也会按「去分隔符」再匹配一次。
 * 排序上品牌前缀优先，其次型号前缀，最后才是任意位置包含 —— 搜 "sony" 时
 * Sony 自家型号排在最前，而不是 "Sony" 出现在型号名里的第三方耳机。
 */
function searchAutoEqModels(query) {
  const raw = String(query || '').trim();
  if (!raw) return AUTOEQ_MODELS.slice();
  const words = raw.toLowerCase().split(/\s+/).filter(Boolean);
  const glued = eqHpNorm(raw);
  const hits = [];
  for (const model of AUTOEQ_MODELS) {
    const name = `${model.brand} ${model.model}`.toLowerCase();
    const flat = eqHpNorm(name);
    if (!words.every(word => name.includes(word) || flat.includes(eqHpNorm(word)))) continue;
    let rank = 3;
    if (model.brand.toLowerCase().startsWith(words[0])) rank = 0;
    else if (eqHpNorm(`${model.brand}${model.model}`).startsWith(glued)) rank = 1;
    else if (eqHpNorm(model.model).startsWith(glued)) rank = 2;
    hits.push({ rank, model });
  }
  hits.sort((a, b) => a.rank - b.rank || a.model.brand.localeCompare(b.model.brand) || a.model.model.localeCompare(b.model.model));
  return hits.map(hit => hit.model);
}

function eqHpVisibleItems() {
  const list = $('#eqHpList');
  return list ? [...list.querySelectorAll('.eq-hp-item')] : [];
}

let eqHpActiveIndex = -1;

function setEqHpActive(index) {
  const items = eqHpVisibleItems();
  items.forEach(item => item.classList.remove('is-active'));
  const item = items[index];
  if (!item) { eqHpActiveIndex = -1; return; }
  eqHpActiveIndex = index;
  item.classList.add('is-active');
  item.scrollIntoView({ block: 'nearest' });
}

function eqHpItem(id, brand, label, selected) {
  const item = document.createElement('div');
  item.className = 'eq-hp-item'
    + (selected ? ' is-selected' : '');
  item.dataset.id = id;
  item.setAttribute('role', 'option');
  item.setAttribute('aria-selected', selected ? 'true' : 'false');
  if (brand) {
    const b = document.createElement('span');
    b.className = 'eq-hp-brand';
    b.textContent = brand;
    item.append(b);
  }
  const m = document.createElement('span');
  m.className = 'eq-hp-model';
  m.textContent = label;
  item.append(m);
  if (selected) {
    const tick = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    tick.setAttribute('class', 'icon');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-check');
    tick.append(use);
    item.append(tick);
  }
  return item;
}

/* 列表分批渲染：两千多款一次性塞进 DOM 会明显卡顿。
   头戴和入耳各自维护一个队列，首屏两边都铺一批 —— 不然入耳要滚过 700 多条头戴才看得到 */
const EQ_HP_FIRST = 60;
const EQ_HP_MORE = 40;

let eqHpGroups = {};
let eqHpQueue = [];

function eqHpGroupHeader(kind) {
  const head = document.createElement('div');
  head.className = 'eq-hp-group';
  head.textContent = kind === 'over' ? '头戴式耳机' : '入耳式耳塞';
  return head;
}

function eqHpDrawnTotal() {
  return Object.values(eqHpGroups).reduce((sum, group) => sum + group.drawn, 0);
}

function updateEqHpFoot(query) {
  const foot = $('#eqHpFoot');
  if (!foot) return;
  const drawn = eqHpDrawnTotal();
  if (query) {
    foot.textContent = `匹配 ${eqHpQueue.length} 款 · 已显示 ${drawn}`;
    return;
  }
  const more = drawn < eqHpQueue.length ? ' · 滚动加载更多' : '';
  foot.textContent = `共 ${eqHpQueue.length} 款 · 已显示 ${drawn}${more} · AutoEq`;
}

/** 每个分组各追加 count 条，两组同时长，滚起来才不会一边长一边没 */
function appendEqHeadphoneRows(count) {
  const current = state.prefs.eqHeadphone || '';
  for (const group of Object.values(eqHpGroups)) {
    const frag = document.createDocumentFragment();
    const end = Math.min(group.queue.length, group.drawn + count);
    for (; group.drawn < end; group.drawn += 1) {
      const model = group.queue[group.drawn];
      frag.append(eqHpItem(model.id, model.brand, model.model, model.id === current));
    }
    if (frag.childNodes.length) group.body.append(frag);
  }
}

function renderEqHeadphoneList(query = '') {
  const list = $('#eqHpList');
  if (!list) return;
  const q = String(query || '').trim();
  eqHpQueue = searchAutoEqModels(q);
  eqHpGroups = {};
  eqHpActiveIndex = -1;
  list.textContent = '';

  if (!q) {
    const current = state.prefs.eqHeadphone || '';
    list.append(eqHpItem('', '', '关闭（不校正）', !current));
  }

  if (!eqHpQueue.length) {
    const empty = document.createElement('div');
    empty.className = 'eq-hp-empty';
    empty.textContent = `没找到「${q}」，换个关键词试试`;
    list.append(empty);
    updateEqHpFoot(q);
    return;
  }

  for (const kind of ['over', 'in']) {
    const queue = eqHpQueue.filter(model => model.kind === kind);
    if (!queue.length) continue;
    list.append(eqHpGroupHeader(kind));
    const body = document.createElement('div');
    body.className = 'eq-hp-group-body';
    body.dataset.kind = kind;
    list.append(body);
    eqHpGroups[kind] = { body, queue, drawn: 0 };
  }

  appendEqHeadphoneRows(EQ_HP_FIRST);
  updateEqHpFoot(q);
  list.scrollTop = 0;
}

function positionEqHeadphonePicker() {
  const pop = $('#eqHpPop');
  const trigger = $('#eqHeadphoneTrigger');
  if (!pop || !trigger) return;
  const rect = trigger.getBoundingClientRect();
  const width = pop.offsetWidth || 360;
  const height = pop.offsetHeight || 320;
  const pad = 12;
  let left = rect.right - width;
  left = Math.max(pad, Math.min(left, innerWidth - width - pad));
  let top = rect.bottom + 8;
  if (top + height > innerHeight - pad) {
    const above = rect.top - height - 8;
    top = above >= pad ? above : Math.max(pad, innerHeight - height - pad);
  }
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

function openEqHeadphonePicker() {
  const pop = $('#eqHpPop');
  const trigger = $('#eqHeadphoneTrigger');
  const search = $('#eqHpSearch');
  if (!pop || !trigger) return;
  search.value = '';
  renderEqHeadphoneList('');
  pop.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  positionEqHeadphonePicker();
  // 重新贴一次：首次打开时高度还没算出来
  positionEqHeadphonePicker();
  search.focus();
  // 已选中的那款如果正好在首批里，滚到它；在后面的批次里就不追了 ——
  // 为了一项把上千条 DOM 一次性铺出来，打开面板会明显卡一下，而按钮上本来就写着当前型号
  const selected = $('#eqHpList .eq-hp-item.is-selected');
  if (selected) selected.scrollIntoView({ block: 'center' });
}

function closeEqHeadphonePicker() {
  const pop = $('#eqHpPop');
  const trigger = $('#eqHeadphoneTrigger');
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  trigger.setAttribute('aria-expanded', 'false');
  eqHpActiveIndex = -1;
}

/** 选中（或清空）一条校正曲线 —— 按钮、键盘、点空白处都走这里 */
function applyEqHeadphoneSelection(id) {
  const model = findAutoEqModel(id);
  state.prefs.eqHeadphone = model ? model.id : '';
  if (model) {
    state.prefs.eqGains = model.gains.map(roundToStep);
    state.prefs.eqPreamp = model.preamp;
    state.prefs.eqEnabled = true;
    state.prefs.eqPreset = 'custom';
    const toggle = $('#eqToggle');
    if (toggle) toggle.checked = true;
    // 曲线已经不是任何内置预设了，下拉切到「自定义」，免得显示着「流行」却放着校正曲线
    const preset = $('#eqPreset');
    if (preset) preset.value = 'custom';
    showToast(`已应用 ${model.brand} ${model.model} 校正 · 预增益 ${model.preamp} dB`);
  } else {
    // 明确选「关闭」= 撤掉校正：十段归零回到直通，避免留下一条没有出处的曲线
    state.prefs.eqPreamp = 0;
    state.prefs.eqGains = EQ_BANDS.map(() => 0);
    state.prefs.eqPreset = 'flat';
    const preset = $('#eqPreset');
    if (preset) preset.value = 'flat';
    showToast('已关闭耳机校正');
  }
  applyEq();
  renderEqSliders();
  syncEqHeadphoneTrigger();
  syncEqHeadphoneHint();
  savePrefs();
}

/** 按钮上显示的当前型号 */
function syncEqHeadphoneTrigger() {
  const value = $('#eqHeadphoneValue');
  const trigger = $('#eqHeadphoneTrigger');
  const model = findAutoEqModel(state.prefs.eqHeadphone);
  if (value) value.textContent = model ? `${model.brand} ${model.model}` : '未校正';
  if (trigger) trigger.classList.toggle('has-value', Boolean(model));
}

/** 下拉下方那行小字：出处 + 预增益 + 有没有手动微调过 */
function syncEqHeadphoneHint() {
  const hint = $('#eqHeadphoneHint');
  if (!hint) return;
  const model = findAutoEqModel(state.prefs.eqHeadphone);
  if (!model) {
    hint.hidden = true;
    hint.textContent = '';
    return;
  }
  const gains = normalizedEqGains();
  const tweaked = model.gains.some((gain, index) => Math.abs(roundToStep(gain) - gains[index]) > 0.01);
  hint.hidden = false;
  hint.textContent = [
    model.kind === 'over' ? '头戴' : '入耳',
    `预增益 ${model.preamp} dB`,
    // 曲线还留着，但整条均衡被关掉了 —— 说明白，别让人以为校正还在生效
    state.prefs.eqEnabled ? '' : '均衡器已关闭，校正未生效',
    tweaked ? '已在曲线上手动微调' : ''
  ].filter(Boolean).join(' · ');
}

function applyReplayGain(track) {
  if (!gainNode) return;
  const db = Number(track?._replayGain);
  if (!state.prefs.replayGain || !Number.isFinite(db) || !db) {
    gainNode.gain.value = 1;
    return;
  }
  gainNode.gain.value = Math.max(0.1, Math.min(4, 10 ** (db / 20)));
}

/* ------------------------------- 人声消除 ------------------------------- */

/**
 * 干湿切换。用 setTargetAtTime 而不是直接赋值：直接赋值会在波形中间
 * 产生一个跳变，听起来就是「啪」的一声爆音。
 */
function applyKaraoke() {
  if (!karaokeDry || !karaokeWet || !audioContext) return;
  const on = Boolean(state.prefs.karaoke);
  const now = audioContext.currentTime;
  karaokeDry.gain.setTargetAtTime(on ? 0 : 1, now, 0.02);
  karaokeWet.gain.setTargetAtTime(on ? 1 : 0, now, 0.02);
}

function rmsOf(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/**
 * 判断当前音源是不是单声道：单声道时 L 和 R 完全一致，L-R 恒等于 0，
 * 一开开关就整首歌静音，必须在开启前拦下来。
 * 采样 6 帧（约 130ms）取峰值，比只看一帧靠谱：单帧可能正好落在过零点附近。
 */
function detectMonoSource() {
  return new Promise(resolve => {
    if (!karaokeProbeL || !karaokeProbeR || audio.paused || audio.readyState < 2) {
      resolve(false);
      return;
    }
    const bufL = new Float32Array(karaokeProbeL.fftSize);
    const bufR = new Float32Array(karaokeProbeR.fftSize);
    let maxL = 0;
    let maxR = 0;
    let frames = 0;
    const sample = () => {
      karaokeProbeL.getFloatTimeDomainData(bufL);
      karaokeProbeR.getFloatTimeDomainData(bufR);
      maxL = Math.max(maxL, rmsOf(bufL));
      maxR = Math.max(maxR, rmsOf(bufR));
      frames += 1;
      if (frames < 6) { setTimeout(sample, 24); return; }
      // 有声音、但右声道比左声道小 26dB 以上 → 按单声道处理
      resolve(maxL > 0.004 && maxR < maxL * 0.05);
    };
    sample();
  });
}

function updateKaraokeUi() {
  const button = $('#fullKaraoke');
  if (!button) return;
  const on = Boolean(state.prefs.karaoke);
  button.classList.toggle('active', on);
  button.setAttribute('aria-pressed', on ? 'true' : 'false');
  button.title = on ? '伴奏模式（已消除人声）· 点击恢复原声' : '人声消除（伴奏模式）';
  const use = button.querySelector('use');
  if (use) use.setAttribute('href', on ? '#i-mic-off' : '#i-mic');
}

async function toggleKaraoke() {
  // 没播过歌时音频图还没建，先建（点击本身就是用户手势，AudioContext 不会被挂起）
  ensureAudioGraph();
  if (!karaokeDry) {
    showToast('音频引擎还没准备好，先播一首歌再试');
    return;
  }
  if (!state.prefs.karaoke) {
    const mono = await detectMonoSource();
    if (mono) {
      showToast('这首是单声道音源，左右相减会直接变无声，换一首立体声的歌再试');
      return;
    }
  }
  state.prefs.karaoke = !state.prefs.karaoke;
  savePrefs();
  applyKaraoke();
  updateKaraokeUi();
  showToast(state.prefs.karaoke ? '已消除人声（伴奏模式）' : '已恢复原声');
}

function applyPlaybackRate() {
  const rate = Math.max(.25, Math.min(3, Number(state.prefs.playbackRate) || 1));
  audio.playbackRate = rate;
  audio.preservesPitch = true;
  audio.webkitPreservesPitch = true;
}

function createDemoWav(track) {
  if (demoForId === track.id && demoUrl) return demoUrl;
  if (demoUrl) URL.revokeObjectURL(demoUrl);
  const sampleRate = 8000;
  const duration = Math.min(track.duration || 180, 190);
  const sampleCount = Math.floor(sampleRate * duration);
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);
  const writeString = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeString(0,'RIFF');
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeString(8,'WAVE');
  writeString(12,'fmt ');
  view.setUint32(16,16,true);
  view.setUint16(20,1,true);
  view.setUint16(22,1,true);
  view.setUint32(24,sampleRate,true);
  view.setUint32(28,sampleRate * 2,true);
  view.setUint16(32,2,true);
  view.setUint16(34,16,true);
  writeString(36,'data');
  view.setUint32(40, sampleCount * 2, true);

  const seed = [...track.id].reduce((sum,ch) => sum + ch.charCodeAt(0), 0);
  const roots = [110, 123.47, 130.81, 146.83, 164.81, 174.61];
  const root = roots[seed % roots.length];
  const scale = [1, 1.122, 1.26, 1.498, 1.682, 1.888];
  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / sampleRate;
    const chordStep = Math.floor(t / 6) % 6;
    const melodyStep = Math.floor(t / 1.5) % scale.length;
    const gate = ((t % 1.5) < 1.15) ? 1 : .35;
    const pad = Math.sin(2*Math.PI*root*scale[chordStep]*t) * .16
      + Math.sin(2*Math.PI*root*1.5*scale[chordStep]*t + .7) * .1
      + Math.sin(2*Math.PI*root*2.01*t) * .045;
    const melody = Math.sin(2*Math.PI*root*2*scale[melodyStep]*t) * .11 * gate;
    const bass = Math.sin(2*Math.PI*root*.5*t) * .13;
    const pulse = Math.sin(2*Math.PI*2*t) * .035 * Math.max(0, Math.sin(Math.PI * ((t * 2) % 1)));
    const fade = Math.min(1, t / 2, (duration - t) / 2);
    const sample = Math.max(-1, Math.min(1, (pad + melody + bass + pulse) * fade));
    view.setInt16(44 + i * 2, sample * 32767, true);
  }
  demoUrl = URL.createObjectURL(new Blob([buffer], { type:'audio/wav' }));
  demoForId = track.id;
  return demoUrl;
}

// 取得可播放的音源：优先已解析好的 _src；否则按 _path 现场解析成 file://；
// 两者都没有才退回内置测试音（仅老资料库 / 示例数据会遇到）
async function resolveTrackSource(track) {
  if (track._online) return resolveOnlineSource(track);
  if (track._src) return track._src;
  if (track._path && window.orangeDesktop?.toFileUrl) {
    const url = await window.orangeDesktop.toFileUrl(track._path).catch(() => null);
    if (url) {
      track._src = url;
      return url;
    }
  }
  return createDemoWav(track);
}

async function playTrack(id, forcePlay = true) {
  const track = getTrack(id);
  if (!track) return;
  // 启动时 bootstrap 会把 currentId 指向上次播放的歌曲，但此时 audio 还没有
  // 任何音源。所以即使 id 与 currentId 相同，只要 audio.src 为空就必须重新
  // 装载，否则 play() 会因没有音源直接失败（表现为“刚打开软件点播放没反应”）。
  const changed = state.currentId !== id || !audio.src;
  const token = ++playRequestToken;
  let source = '';
  if (changed) {
    // 在线曲目要现取直链，网络失败 / 没有版权都在这里抛出，必须拦住并提示，
    // 否则异常会直接冒到调用栈外层，界面看起来就是「点了没反应」
    try {
      source = await resolveTrackSource(track);
    } catch (error) {
      if (token !== playRequestToken) return;
      state.playing = false;
      updatePlayIcons();
      updateLyricsActive();
      showToast(error?.message || '在线播放失败');
      console.warn(error);
      return;
    }
  }
  // 解析音源要走一次 IPC。用户连点两首歌时，先发出的请求可能后返回；
  // 如果不校验 token，它会把后点的那首覆盖掉（表现为「点了 A 却在放 B」）。
  if (token !== playRequestToken || !getTrack(id)) return;
  if (changed) {
    state.currentId = id;
    if (demoUrl && demoForId !== id) {
      URL.revokeObjectURL(demoUrl);
      demoUrl = null;
      demoForId = null;
    }
    // 只允许「启动时恢复的那首歌」在本次启动的第一次装载时续播；
    // 一旦装载过任何一首，续播窗口即关闭，之后切歌都从 0 开始。
    const canResume = state.prefs.resume && !bootResumeUsed && id === bootResumeId;
    pendingResume = canResume ? Number(state.progress[id] || 0) : 0;
    bootResumeUsed = true;
    // 在线音频来自 CDN：声明 crossOrigin 才能让 WebAudio 正常出声（否则均衡器 / 频谱会静音）。
    // 本地文件走 file://，设置 crossOrigin 反而会被 CORS 挡住，必须去掉。
    if (/^https?:/i.test(source)) audio.crossOrigin = 'anonymous';
    else audio.removeAttribute('crossorigin');
    audio.src = source;
    audio.load();
    applyReplayGain(track);
    applyPlaybackRate();
    try { localStorage.setItem('orange-last-track', JSON.stringify(id)); } catch {}
    state.recent = [id, ...state.recent.filter(item => item !== id)].slice(0,12);
    // 在线曲目另存一份到在线库，否则重启后「最近播放」里查不到这首歌
    if (track._online && typeof recordOnlineRecent === 'function') recordOnlineRecent(id);
    saveState();
    renderRecent();
    updatePlayerUi();
  }
  if (!getLyrics(track).length && track._path && !track._lyricChecked) {
    track._lyricChecked = true;
    loadTrackLyrics(track).then(lines => {
      if (lines.length && state.currentId === id) {
        renderLyricSource();
        renderLyrics();
        pushDesktopLyricsState();
        showToast(track._lyricSource === 'embedded'
          ? '已读取歌曲内嵌歌词'
          : track._lyricSource === 'lrclib'
            ? '已从 LRCLIB 匹配到同步歌词'
            : track._lyricSource === 'lrclib-plain'
              ? '已从 LRCLIB 匹配到歌词（无时间轴）'
              : '已自动载入同名歌词文件');
      }
    });
  }
  // 在线曲目：直链解析顺带带回来的歌词可能为空（走了缓存、或接口偶发返回空），
  // 独立补一次，别让「歌能放但没有歌词」变成常态
  if (!getLyrics(track).length && track._online && typeof ensureOnlineLyrics === 'function') {
    ensureOnlineLyrics(track);
  }
  ensureAudioGraph();
  if (audioContext?.state === 'suspended') await audioContext.resume();
  if (token !== playRequestToken) return;
  if (forcePlay) {
    try {
      if (state.prefs.fade) audio.volume = 0;
      await audio.play();
      // 播放启动也是异步的：期间用户可能已经切到别的歌，旧请求不要再改状态
      if (token !== playRequestToken) return;
      state.playing = true;
      if (state.prefs.fade) fadeVolume(state.volume, fadeDuration());
      else applyVolume();
    } catch (error) {
      if (token !== playRequestToken) return;
      // 在线音源有时 CDN 不给 CORS 头：去掉 crossOrigin 再试一次，
      // 代价是均衡器与频谱失效，但至少能正常出声
      if (track._online && audio.crossOrigin && source) {
        audio.removeAttribute('crossorigin');
        audio.src = source;
        audio.load();
        try {
          await audio.play();
          if (token !== playRequestToken) return;
          state.playing = true;
          updatePlayerUi();
          showToast('已切换为直连播放（音效不可用）');
          return;
        } catch (retryError) {
          console.warn(retryError);
        }
      }
      const recovered = await recoverUnsupportedTrack(track).catch(() => false);
      if (token !== playRequestToken) return;
      if (recovered) {
        audio.src = track._src;
        audio.load();
        try {
          if (state.prefs.fade) audio.volume = 0;
          await audio.play();
          if (token !== playRequestToken) return;
          state.playing = true;
          if (state.prefs.fade) fadeVolume(state.volume, fadeDuration());
          updatePlayerUi();
          return;
        } catch (retryError) {
          console.warn(retryError);
        }
      }
      state.playing = false;
      applyVolume();
      showToast('无法播放这个文件，当前系统暂不支持该音频编码');
      console.warn(error);
    }
  }
  updatePlayerUi();
}

function togglePlayback() {
  if (!audio.src) {
    if (!state.currentId) {
      showToast('还没有选择歌曲');
      return;
    }
    playTrack(state.currentId);
    return;
  }
  // 用 state.playing 而不是 audio.paused 判断：暂停带淡出时 audio 还在响，
  // 快速再按一次空格原来会被当成「再暂停一次」，结果怎么点都没声音。
  if (!state.playing) {
    ensureAudioGraph();
    cancelFade();
    if (state.prefs.fade) audio.volume = 0;
    // 先切换 UI 状态再等 play()：play() 返回前用户再按一次空格时，
    // 才能正确走到「暂停」分支，而不是又进一次播放分支。
    state.playing = true;
    updatePlayIcons();
    updateLyricsActive();
    audio.play().then(() => {
      if (!state.playing) {
        audio.pause();
        applyVolume();
        return;
      }
      if (state.prefs.fade) fadeVolume(state.volume, fadeDuration());
      else applyVolume();
    }).catch(() => {
      state.playing = false;
      updatePlayIcons();
      updateLyricsActive();
      applyVolume();
      showToast('音频开始播放失败');
    });
  } else {
    state.playing = false;
    updatePlayIcons();
    updateLyricsActive();
    if (state.prefs.fade) {
      fadeVolume(0, Math.max(40, fadeDuration() * .75), () => {
        // 淡出期间用户又点了播放：不要再把它暂停掉
        if (!state.playing) audio.pause();
      });
    } else {
      audio.pause();
    }
  }
}

function orderedQueue() {
  const queue = state.queue.filter(id => getTrack(id));
  if (state.currentId && !queue.includes(state.currentId)) queue.unshift(state.currentId);
  return queue;
}

function nextTrack(auto = false) {
  const queue = orderedQueue();
  if (!queue.length) {
    showToast('播放队列是空的');
    return;
  }
  if (state.repeat === 2 && auto) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  let index = queue.indexOf(state.currentId);
  if (state.shuffle && queue.length > 1) {
    let next = index;
    while (next === index) next = Math.floor(Math.random() * queue.length);
    index = next;
  } else {
    index += 1;
  }
  if (index >= queue.length) {
    if (state.repeat === 1) index = 0;
    else {
      state.playing = false;
      updatePlayIcons();
      return;
    }
  }
  playTrack(queue[index]);
}

function previousTrack() {
  if (audio.currentTime > 4) {
    audio.currentTime = 0;
    return;
  }
  const queue = orderedQueue();
  if (!queue.length) {
    showToast('播放队列是空的');
    return;
  }
  const index = queue.indexOf(state.currentId);
  playTrack(queue[(index - 1 + queue.length) % queue.length]);
}

function toggleFavorite(id = state.currentId) {
  if (!id || !getTrack(id)) {
    showToast('还没有正在播放的歌曲');
    return;
  }
  if (state.favorites.has(id)) {
    state.favorites.delete(id);
    showToast('已从喜爱中移除');
  } else {
    state.favorites.add(id);
    showToast('已添加到喜爱');
  }
  saveState();
  renderCounts();
  renderLocalTracks();
  renderFavorites();
  updateFavoriteUi();
  // 歌单详情里的红心跟着变，不必整页重绘
  $$('.pl-row [data-favorite]').forEach(button => {
    button.classList.toggle('active', state.favorites.has(button.dataset.favorite));
  });
}

// 从资料库移除歌曲（只删除记录，不动磁盘上的音乐文件）
/**
 * 把一首歌从资料库的各个引用点摘干净（不负责 UI 刷新与当前播放状态）。
 * removeTrack 与 cleanDuplicates 共用这一份规则，避免两处各写一遍、逻辑漂移。
 */
function detachTrack(id) {
  state.songs = state.songs.filter(song => song.id !== id);
  state.queue = state.queue.filter(item => item !== id);
  state.favorites.delete(id);
  state.recent = state.recent.filter(item => item !== id);
  state.selection.delete(id);
  delete state.progress[id];
  state.playlists.forEach(playlist => {
    playlist.tracks = playlist.tracks.filter(item => item !== id);
  });
}

function removeTrack(id, options = {}) {
  const track = getTrack(id);
  if (!track) return false;
  const wasCurrent = state.currentId === id;
  detachTrack(id);

  if (wasCurrent) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    state.playing = false;
    const nextId = state.queue.find(item => getTrack(item));
    state.currentId = nextId || state.songs[0]?.id || null;
  }

  if (!options.silent) {
    persistAndRefresh();
  }
  return true;
}

/** 改完资料库后的统一收尾：落盘 + 刷新所有依赖这些状态的界面。
    删除曲目、清空资料库原来是各写一遍这六行，漏一处就会出现「删了但界面没更新」。 */
function persistAndRefresh() {
  saveState();
  saveProgress();
  saveLibrary();
  updatePlayerUi();
  updatePlayIcons();
  renderAll();
}

function clearLibrary() {
  if (!state.songs.length) {
    showToast('资料库已经是空的');
    return;
  }
  const total = state.songs.length;
  if (!window.confirm(`确定要清空资料库吗？\n将从软件中移除 ${total} 首歌曲的记录，磁盘上的音乐文件不会被删除。`)) return;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  state.playing = false;
  state.songs = [];
  state.queue = [];
  state.favorites.clear();
  state.recent = [];
  state.progress = {};
  state.currentId = null;
  state.selection.clear();
  state.selectMode = false;
  state.playlists.forEach(playlist => { playlist.tracks = []; });
  persistAndRefresh();
  showToast(`已移除 ${total} 首歌曲记录`);
}

function seekFromSlider(slider) {
  if (!Number.isFinite(audio.duration)) return;
  audio.currentTime = (Number(slider.value) / 1000) * audio.duration;
}

function cancelFade() {
  if (fadeTimer) {
    clearInterval(fadeTimer);
    fadeTimer = null;
  }
}

function fadeDuration() {
  const value = Number(state.prefs.fadeMs);
  return Number.isFinite(value) ? Math.max(0, Math.min(2000, value)) : 240;
}

// ---------- 睡眠定时器 ----------
function clearSleepTimer() {
  if (sleepTimerId) {
    clearTimeout(sleepTimerId);
    sleepTimerId = null;
  }
  sleepEndsAt = 0;
  sleepAtTrackEnd = false;
  updateSleepChip();
}

/** 定时器触发后要把设置页的下拉和持久化值一起复位，否则下次启动还显示「15 分钟」但计时器并不存在 */
function resetSleepTimerPref() {
  state.prefs.sleepTimer = 0;
  savePrefs();
  const select = $('#sleepTimer');
  if (select) select.value = '0';
}

function applySleepTimer(minutes) {
  clearSleepTimer();
  const value = Number(minutes);
  if (!value) return;
  if (value < 0) {
    sleepAtTrackEnd = true;
    showToast('播完当前歌曲后停止播放');
    updateSleepChip();
    return;
  }
  sleepEndsAt = Date.now() + value * 60000;
  sleepTimerId = setTimeout(() => {
    if (!audio.paused) audio.pause();
    state.playing = false;
    updatePlayIcons();
    updateLyricsActive();
    resetSleepTimerPref();
    clearSleepTimer();
    showToast('睡眠定时器时间到，已暂停播放');
  }, value * 60000);
  showToast(`将在 ${value} 分钟后暂停播放`);
  updateSleepChip();
}

function updateSleepChip() {
  const tools = $('.mini-tools');
  if (!tools) return;
  let chip = $('#sleepChip');
  if (!sleepTimerId && !sleepAtTrackEnd) {
    chip?.remove();
    return;
  }
  if (!chip) {
    chip = document.createElement('span');
    chip.id = 'sleepChip';
    chip.className = 'sleep-chip';
    chip.title = '点击取消睡眠定时器';
    chip.addEventListener('click', () => {
      resetSleepTimerPref();
      clearSleepTimer();
      showToast('已取消睡眠定时器');
    });
    tools.prepend(chip);
  }
  if (sleepAtTrackEnd) {
    chip.textContent = '结束本曲';
    return;
  }
  const left = Math.max(0, Math.round((sleepEndsAt - Date.now()) / 60000));
  chip.textContent = `${left} 分后暂停`;
}

function handleTrackEnded() {
  delete state.progress[state.currentId];
  saveProgress();
  if (sleepAtTrackEnd) {
    state.playing = false;
    updatePlayIcons();
    updateLyricsActive();
    resetSleepTimerPref();
    clearSleepTimer();
    showToast('睡眠定时器：播完本曲已停止');
    pushDesktopLyricsState();
    return;
  }
  if (state.prefs.autoNext || state.repeat === 2) nextTrack(true);
  else {
    state.playing = false;
    updatePlayIcons();
    pushDesktopLyricsState();
  }
}

function fadeVolume(target, duration = 240, done) {
  cancelFade();
  const from = audio.volume;
  const steps = Math.max(1, Math.round(duration / 20));
  let step = 0;
  fadeTimer = setInterval(() => {
    step += 1;
    audio.volume = Math.min(1, Math.max(0, from + (target - from) * (step / steps)));
    if (step >= steps) {
      cancelFade();
      if (typeof done === 'function') done();
    }
  }, 20);
}

function applyVolume() {
  cancelFade();
  audio.volume = Math.min(1, Math.max(0, state.volume));
  audio.muted = state.muted;
  syncVolumeUi();
}

function setVolume(value, options = {}) {
  cancelFade();
  state.volume = Math.min(1, Math.max(0, value));
  if (typeof options.muted === 'boolean') state.muted = options.muted;
  audio.volume = state.volume;
  audio.muted = state.muted;
  syncVolumeUi();
  localStorage.setItem('orange-volume', JSON.stringify({ volume: state.volume, muted: state.muted }));
}

function toggleMute() {
  state.muted = !state.muted;
  applyVolume();
  localStorage.setItem('orange-volume', JSON.stringify({ volume: state.volume, muted: state.muted }));
  showToast(state.muted ? '已静音' : '已取消静音');
}

function syncVolumeUi() {
  const percent = Math.round(state.volume * 100);
  ['#volumeSlider', '#fullVolumeSlider'].forEach(selector => {
    const slider = $(selector);
    if (slider) {
      slider.value = percent;
      paintRange(slider, percent / 100);
    }
  });
  const href = (state.muted || state.volume === 0) ? '#i-volume-x' : '#i-volume';
  ['#volumeButton', '#fullVolumeButton'].forEach(selector => {
    const button = $(selector);
    if (button) $('use', button).setAttribute('href', href);
  });
}

// updateProgress 每秒被 timeupdate 调约 4 次，下面这几个节点在页面生命周期内不变，
// 每次都走 document.querySelector 是纯浪费，惰性缓存一份；isConnected 兜底节点被替换的情况。
const progressEls = {};
function progressEl(id) {
  const cached = progressEls[id];
  if (cached && cached.isConnected) return cached;
  return (progressEls[id] = document.getElementById(id));
}

// slider 外层那个 .bar-range 也是固定的，WeakMap 缓存（节点被替换时自动失效，不会留垃圾）
const rangeBarCache = new WeakMap();

function paintRange(slider, ratio) {
  if (!slider) return;
  const safe = Number.isFinite(ratio) ? ratio : 0;
  const clamped = Math.max(0, Math.min(1, safe));
  slider.style.setProperty('--range-pct', `${(clamped * 100).toFixed(2)}%`);
  // 0~1 的无单位值：原生 range 的手柄中心只在 (轨道宽 - 手柄宽) 的范围内走，
  // 而渐变百分比按整条轨道算，两者会差半个手柄宽 —— 用这个数在 CSS 里做补偿
  slider.style.setProperty('--range-ratio', clamped.toFixed(4));
  // 播放页那条「轨道 + 填充」是分离的两层，填充宽度要 0~1 的数字。
  // 变量只往下继承，写在内层 input 上外层的 .br-fill 读不到，所以写在容器上。
  let bar = rangeBarCache.get(slider);
  if (bar === undefined) {
    bar = slider.closest('.bar-range');
    rangeBarCache.set(slider, bar);
  }
  if (bar) bar.style.setProperty('--range-p', clamped.toFixed(4));
}

function seekBy(delta) {
  if (!Number.isFinite(audio.duration)) return;
  audio.currentTime = Math.min(audio.duration, Math.max(0, audio.currentTime + delta));
  updateProgress();
  showToast(delta > 0 ? `快进 ${delta} 秒` : `快退 ${Math.abs(delta)} 秒`);
}

function nudgeVolume(delta) {
  setVolume(state.volume + delta, { muted: false });
  showToast(`音量 ${Math.round(state.volume * 100)}%`);
}

function toggleShuffleMode() {
  state.shuffle = !state.shuffle;
  syncTransportModes();
  savePlaybackModes();
  showToast(state.shuffle ? '已开启随机播放' : '已关闭随机播放');
}

function cycleRepeatMode() {
  const labels = ['顺序播放', '列表循环', '单曲循环'];
  state.repeat = (state.repeat + 1) % 3;
  syncTransportModes();
  savePlaybackModes();
  showToast(labels[state.repeat]);
}

function syncTransportModes() {
  [$('#shuffleButton'), $('#fullShuffle')].forEach(button => button?.classList.toggle('active', state.shuffle));
  [$('#repeatButton'), $('#fullRepeat')].forEach(button => button?.classList.toggle('active', state.repeat > 0));
}

function rememberProgress(force = false) {
  if (!state.prefs.resume || !state.currentId) return;
  const now = Date.now();
  if (!force && now - lastProgressSave < 3000) return;
  lastProgressSave = now;
  if (!Number.isFinite(audio.currentTime)) return;
  state.progress[state.currentId] = Math.round(audio.currentTime);
  const keys = Object.keys(state.progress);
  if (keys.length > 300) keys.slice(0, keys.length - 300).forEach(key => delete state.progress[key]);
  saveProgress();
}

function updateProgress() {
  const duration = audio.duration;
  const ratio = Number.isFinite(duration) && duration > 0 ? audio.currentTime / duration : 0;
  const seekSlider = progressEl('seekSlider');
  const fullSeekSlider = progressEl('fullSeekSlider');
  if (!seeking) {
    if (seekSlider) seekSlider.value = Math.round(ratio * 1000);
    if (fullSeekSlider) fullSeekSlider.value = Math.round(ratio * 1000);
  }
  paintRange(seekSlider, seeking && seekSlider ? Number(seekSlider.value) / 1000 : ratio);
  paintRange(fullSeekSlider, seeking && fullSeekSlider ? Number(fullSeekSlider.value) / 1000 : ratio);
  const current = formatTime(audio.currentTime);
  const total = formatTime(duration);
  const currentTimeEl = progressEl('currentTime');
  const fullCurrentTimeEl = progressEl('fullCurrentTime');
  const totalTimeEl = progressEl('totalTime');
  const fullTotalTimeEl = progressEl('fullTotalTime');
  // 同一秒内重复赋值是白改 DOM：文本没变就不碰（currentTime 在变，total 基本不变）
  if (currentTimeEl && currentTimeEl.textContent !== current) currentTimeEl.textContent = current;
  if (fullCurrentTimeEl && fullCurrentTimeEl.textContent !== current) fullCurrentTimeEl.textContent = current;
  if (totalTimeEl && totalTimeEl.textContent !== total) totalTimeEl.textContent = total;
  if (fullTotalTimeEl && fullTotalTimeEl.textContent !== total) fullTotalTimeEl.textContent = total;
  updateLyricsActive();
  pushDesktopLyricsState();
  rememberProgress();
}

/**
 * 拖放目录时 DataTransfer.files 里只有一个「文件夹」条目，直接交给 importFiles 会被扩展名过滤掉。
 * 这里用 webkitGetAsEntry 递归把目录展开成真实文件列表（顺带补上 webkitRelativePath，
 * 让专辑名和同名 .lrc 配对沿用和「选择文件夹」一致的规则）。
 */
async function filesFromDataTransfer(dataTransfer) {
  const fallback = dataTransfer?.files ? [...dataTransfer.files] : [];
  const items = dataTransfer?.items ? [...dataTransfer.items] : [];
  const entries = items.map(item => {
    try { return item.webkitGetAsEntry?.() || null; } catch { return null; }
  }).filter(Boolean);
  if (!entries.length) return fallback;

  const files = [];
  const readEntry = entry => new Promise(resolve => {
    if (!entry) { resolve(); return; }
    if (entry.isFile) {
      entry.file(file => {
        try {
          const relative = String(entry.fullPath || '').replace(/^\//, '');
          if (relative) Object.defineProperty(file, 'webkitRelativePath', { value: relative, configurable: true });
        } catch {}
        files.push(file);
        resolve();
      }, () => resolve());
      return;
    }
    if (!entry.isDirectory) { resolve(); return; }
    const reader = entry.createReader();
    const readBatch = () => {
      reader.readEntries(async batch => {
        if (!batch.length) { resolve(); return; }
        for (const child of batch) await readEntry(child);
        readBatch();
      }, () => resolve());
    };
    readBatch();
  });

  for (const entry of entries) await readEntry(entry);
  return files.length ? files : fallback;
}

async function importFiles(fileList) {
  if (importingFiles) {
    showToast('正在导入歌曲，请稍候…');
    return;
  }
  importingFiles = true;
  try {
    await importFilesInner(fileList);
  } catch (error) {
    console.warn('import failed', error);
    showToast('导入过程中出现问题，请重试');
  } finally {
    importingFiles = false;
  }
}

async function importFilesInner(fileList) {
  const statusBox = $('#scanStatus');
  const statusTitle = $('#scanStatusTitle');
  const statusDetail = $('#scanStatusDetail');
  const progressBar = $('#scanProgressBar');
  statusBox.hidden = false;
  statusTitle.textContent = '正在扫描音乐';
  statusDetail.textContent = '正在读取歌曲标签与播放信息...';
  progressBar.style.width = '4%';
  const allFiles = [...fileList];
  const lyricMap = new Map();
  for (const lyricFile of allFiles.filter(file => /\.lrc$/i.test(file.name))) {
    try {
      const buffer = await lyricFile.arrayBuffer();
      const text = decodeTextBuffer(buffer);
      const base = lyricFile.name.replace(/\.lrc$/i, '').toLowerCase().replace(/\s+/g, '');
      const relative = (lyricFile.webkitRelativePath || lyricFile.name).replace(/\.lrc$/i, '').toLowerCase().replace(/\s+/g, '');
      if (!lyricMap.has(base)) lyricMap.set(base, text);
      if (!lyricMap.has(relative)) lyricMap.set(relative, text);
    } catch {}
  }
  const files = allFiles.filter(file => /\.(mp3|flac|aac|m4a|mp4|wav|alac|ogg|oga|opus|aiff|aif|wma|ape)$/i.test(file.name));
  if (!files.length) {
    const encrypted = allFiles.filter(file => /\.(ncm|qmc0|qmc2|qmc3|qmcflac|qmcogg|mflac|mgg|kgm|kgma|kwm|xm|tm0|tm2|tm3)$/i.test(file.name));
    if (encrypted.length) {
      statusTitle.textContent = `发现 ${encrypted.length} 个加密音乐文件`;
      statusDetail.textContent = '网易云（.ncm）、QQ音乐（.qmc/.mflac）、酷狗（.kgm）等下载的加密文件无法直接播放，请换成普通的 MP3 / FLAC 文件。';
      showToast('加密音乐文件无法播放，请使用普通 MP3 / FLAC 文件');
      return;
    }
    statusTitle.textContent = '没有识别到支持的歌曲';
    statusDetail.textContent = '请尝试选择 MP3、FLAC、AAC、M4A、WAV、ALAC、OGG、Opus 等常见音频文件。';
    progressBar.style.width = '0%';
    showToast('没有识别到支持的音频文件');
    return;
  }
  let added = 0;
  let skipped = 0;
  let duplicated = 0;
  let processed = 0;
  let firstAddedId = null;
  const skippedPreview = [];
  // 资料库里已有的路径集合（Windows 路径不区分大小写，统一小写比对）。
  // 原来是每读一个文件就对整个 songs 做一次 some() 遍历，文件多时是 O(n×m)。
  const knownPaths = new Set(state.songs.map(song => String(song._path || '').toLowerCase()).filter(Boolean));
  const reportProgress = () => {
    progressBar.style.width = `${Math.round((processed / files.length) * 88) + 8}%`;
  };
  for (const file of files) {
    processed += 1;
    const url = URL.createObjectURL(file);
    const extension = (file.name.includes('.') ? file.name.split('.').pop() : '').toUpperCase();
    const format = FORMAT_ALIASES[extension] || extension;
    const nameParts = splitFileName(file.name);
    const sourcePath = window.orangeDesktop?.getPathForFile?.(file) || '';
    // 已经在资料库里的文件直接忽略：原来这里也走 added += 1，导致「新增 N 首」把重复项也算进去
    if (sourcePath && knownPaths.has(sourcePath.toLowerCase())) {
      duplicated += 1;
      URL.revokeObjectURL(url);   // 不加入资料库的临时地址立刻释放，反复导入同一批文件才不会越攒越多
      reportProgress();
      continue;
    }
    let metadata = {};
    if (/\.mp3$/i.test(file.name)) metadata = await readId3(file).catch(() => ({}));
    else if (/\.(flac|ogg|oga|opus)$/i.test(file.name)) metadata = await readVorbisTags(file).catch(() => ({}));
    else if (/\.(m4a|mp4|aac|alac)$/i.test(file.name)) metadata = await readMp4Tags(file).catch(() => ({}));
    else if (/\.wav$/i.test(file.name)) metadata = await readWavTags(file).catch(() => ({}));
    if (!metadata.lyrics && metadata.lyricsText) metadata.lyrics = parseLyrics(metadata.lyricsText);
    if (!metadata.artwork && sourcePath && window.orangeDesktop?.extractArtwork) {
      metadata.artwork = await window.orangeDesktop.extractArtwork(sourcePath).catch(() => '');
    }
    const sidecarKey = file.name.replace(/\.[^.]+$/, '').toLowerCase();
    const relativeKey = (file.webkitRelativePath || file.name).replace(/\.[^.]+$/, '').toLowerCase();
    // 先按「相对路径」查，再退回文件名：不同文件夹里同名的 01.mp3 很常见，
    // 只按文件名查会把别的专辑的 .lrc 配到这首歌上。
    const sidecarLyrics = lyricMap.get(relativeKey.replace(/\s+/g, ''))
      || lyricMap.get(sidecarKey.replace(/\s+/g, ''))
      || lyricMap.get(sidecarKey.replace(/\s+/g, '').split(/[./]/)[0]);
    let lyrics = metadata.lyrics || (sidecarLyrics ? parseLyrics(sidecarLyrics) : []);
    if (!lyrics.length && sourcePath && window.orangeDesktop?.readSidecarLyrics) {
      const sidecar = await window.orangeDesktop.readSidecarLyrics(sourcePath).catch(() => null);
      if (sidecar?.text) lyrics = parseLyrics(sidecar.text);
    }
    // ALAC / WMA / APE 这类 Chromium 原生不支持，让 <audio> 探测时长会白等错误/超时，
    // 直接读文件头更快；其余格式仍用 <audio> 探测（对 VBR 更准），失败再退回文件头。
    let duration = 0;
    if (/\.(alac|wma|ape)$/i.test(file.name)) duration = await readDuration(file).catch(() => 0);
    else duration = await probeDuration(url);
    if (!duration) duration = await readDuration(file).catch(() => 0);
    const tech = await readTechInfo(file).catch(() => ({}));
    if (state.prefs.onlySongs && !looksLikeSong({ name: file.name, filePath: sourcePath, metadata, seconds: duration })) {
      skipped += 1;
      skippedPreview.push(file.name);
      URL.revokeObjectURL(url);   // 被判定为非歌曲、不会加入资料库，同样立刻释放临时地址
      reportProgress();
      continue;
    }
    const coverUrl = await resolveCoverUrl(metadata.artwork);
    const title = metadata.title || nameParts.title || file.name.replace(/\.[^.]+$/, '');
    const artist = metadata.artist || nameParts.artist || '未知音乐人';
    const id = `f${Date.now()}${added}`;
    const replayGain = Number(metadata.replayGain);
    state.songs.push({
      id,
      title,
      artist,
      album: metadata.album || file.webkitRelativePath?.split('/').slice(-2,-1)[0] || '本地文件',
      format,
      duration: duration || 0,
      cover: coverUrl,
      source:'本地导入',
      // 有磁盘路径时不用 blob URL：blob 会把整个 File 对象钉在内存里，
      // 导入上万首后常驻内存非常可观。播放时由 resolveTrackSource() 按路径惰性解析。
      _src: sourcePath ? '' : url,
      _fileName:file.name,
      _file:file,
      _path:sourcePath,
      _size: file.size || 0,
      _tech: tech,
      _replayGain: Number.isFinite(replayGain) ? replayGain : null,
      _lyrics:lyrics
    });
    if (sourcePath) URL.revokeObjectURL(url);
    state.queue.push(id);
    added += 1;
    if (!firstAddedId) firstAddedId = id;
    if (sourcePath) knownPaths.add(sourcePath.toLowerCase());
    reportProgress();
  }
  progressBar.style.width = '100%';
  statusTitle.textContent = `扫描完成 · 新增 ${added} 首歌曲`;
  if (skipped) {
    statusDetail.textContent = `已自动跳过 ${skipped} 个非歌曲音频（音效、提示音、语音等）：${skippedPreview.slice(0, 3).join('、')}${skipped > 3 ? ' 等' : ''}`;
  } else if (duplicated) {
    statusDetail.textContent = `其中 ${duplicated} 首已在资料库中，已自动忽略。`;
  } else {
    statusDetail.textContent = '歌曲已加入本地资料库，可以前往首页播放。';
  }
  saveLibrary();
  renderAll();
  showToast(skipped
    ? `已添加 ${added} 首歌曲，跳过 ${skipped} 个非歌曲音频`
    : (added ? `已识别 ${added} 首本地歌曲` : '没有新的歌曲需要添加'));
  // 导入结束后顺手回收不再被引用的封面，避免封面目录随着反复导入慢慢变大
  pruneOrphanCovers();
  // 导入后自动播放「本次新增的第一首」（用 firstAddedId 精确捕获，避免误放老歌）
  if (state.prefs.autoplayImport && firstAddedId) {
    playTrack(firstAddedId);
  }
}

function audioBufferToWav(buffer) {
  const channels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const frames = buffer.length;
  const dataLength = frames * channels * 2;
  const arrayBuffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(arrayBuffer);
  const writeString = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataLength, true);

  const data = [];
  for (let channel = 0; channel < channels; channel += 1) data.push(buffer.getChannelData(channel));
  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = Math.max(-1, Math.min(1, data[channel][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return arrayBuffer;
}

async function recoverUnsupportedTrack(track) {
  if (!track || track._recovered) return false;
  // 有磁盘路径就用随包的 ffmpeg 转码。注意这里不能要求 _file 存在：
  // 重启后从资料库恢复的歌曲、自动扫描进来的歌曲都没有 File 对象，
  // 原先的 `!track._file` 判断会让 ALAC / WMA / APE 在重启后全部无法播放。
  if (track._path && window.orangeDesktop?.convertAudio) {
    try {
      const convertedUrl = await window.orangeDesktop.convertAudio(track._path);
      if (convertedUrl) {
        track._src = convertedUrl;
        track._recovered = true;
        return true;
      }
    } catch (error) {
      console.warn('FFmpeg conversion failed', error);
    }
  }
  // 只有当前会话里拖进来、手头还有 File 对象的歌曲，才能走 WebAudio 解码兜底
  if (!track._file) return false;
  const context = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const encoded = await track._file.arrayBuffer();
    const decoded = await context.decodeAudioData(encoded.slice(0));
    const wav = audioBufferToWav(decoded);
    const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
    track._src = url;
    track.duration = decoded.duration;
    track._recovered = true;
    return true;
  } catch (error) {
    console.warn('Audio decode fallback failed', error);
    return false;
  } finally {
    context.close?.();
  }
}

function probeDuration(url) {
  return new Promise(resolve => {
    const probe = new Audio();
    let settled = false;
    let timer = null;
    // 结束时要清掉兜底定时器，否则批量导入会在后台堆起一串 5 秒后才触发的回调
    const done = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probe.removeAttribute('src');
      resolve(value);
    };
    probe.preload = 'metadata';
    probe.addEventListener('loadedmetadata', () => done(Number.isFinite(probe.duration) ? probe.duration : 0), { once:true });
    probe.addEventListener('error', () => done(0), { once:true });
    probe.src = url;
    timer = setTimeout(() => done(0), 5000);
  });
}

// 歌词文件常见编码：优先 BOM / UTF-8，失败时按 GBK 解码

// Vorbis Comment（FLAC / OGG / Opus 通用）：供应商串 + 若干 KEY=VALUE

// FLAC（元数据块）/ OGG / Opus

// MP4 / M4A 原子：©nam 标题、©ART 歌手、©alb 专辑、©lyr 歌词、covr 封面

// WAV 的 RIFF INFO 标签（INAM / IART / IPRD）

// ID3 SYLT：同步歌词帧（自带时间戳）

// ID3 TXXX：形如 描述=值 的用户自定义文本，部分音乐把歌词放在这里

// 把歌词区的行节点与逐字节点收进数组下标。
// 以前每帧都靠 querySelector 按 data-lyric-index 找节点，长歌词（双语歌词行数
// 直接翻倍）下属性选择器 + 全量遍历非常贵；收好之后滚动只走数组下标。
// 节点是刚重建的、不带任何状态类，所以顺手把 activeLineIndex 归零，
// 让紧接着的 updateLyricsActive 走一次完整同步。
function cacheLyricNodes(container) {
  lyricLineNodes = [...container.children];
  lyricCharNodes = lyricLineNodes.map(node => [...node.children]);
  activeLineIndex = -1;
}

function renderLyrics() {
  const track = getTrack(state.currentId);
  const lyrics = getLyrics(track);
  const container = $('#lyricsScroll');
  if (!container) return;
  renderLyricSource();
  if (!track) {
    container.innerHTML = `<p class="lyric-line active">还没有播放歌曲</p><p class="lyric-line">导入本地音乐后会自动读取歌词</p>`;
    cacheLyricNodes(container);
    return;
  }
  if (!lyrics.length) {
    container.innerHTML = `<p class="lyric-line active">这首歌还没有歌词</p><p class="lyric-line">可从歌曲信息里导入 LRC 或粘贴歌词</p>`;
    cacheLyricNodes(container);
    return;
  }
  container.innerHTML = lyrics.map((line, index) => {
    const chars = [...String(line.text)].map((char, i) =>
      `<span class="ch" data-i="${i}">${char === ' ' ? '&nbsp;' : escapeHtml(char)}</span>`).join('');
    // data-text 是「字后影子」用的：伪元素拿它复制一份同样的文字做模糊副本。
    // 空格换成 &nbsp;，跟上面 .ch 里的处理保持一致，否则副本的行宽会和正文对不齐。
    const glowText = escapeHtml(String(line.text)).replaceAll(' ', '&nbsp;');
    return `<p class="lyric-line" data-lyric-index="${index}" data-time="${line.time}" data-text="${glowText}">${chars}</p>`;
  }).join('');
  cacheLyricNodes(container);
  updateLyricsActive();
}

// 每个字的点亮时间：优先用逐字时间轴，没有就按整句时长均分。
// 这里刻意不缓存：歌词偏移量（右键微调 / 设置页滑杆）随时会变，
// 旧实现把结果存在 line._charTimes 上，改了偏移后整句会平移、逐字点亮却还停在旧位置。
function charTimeline(line, nextLine) {
  const chars = [...String(line.text)];
  const times = [];
  const start = line.time;
  const end = nextLine ? Math.max(nextLine.time, start + .4) : start + 5;
  if (line.words && line.words.length > 1) {
    let cursor = 0;
    line.words.forEach((word, index) => {
      const wordChars = [...String(word.text)];
      const nextWordTime = line.words[index + 1]?.time ?? end;
      const span = Math.max(0.05, nextWordTime - word.time);
      wordChars.forEach((_, i) => {
        times[cursor] = word.time + (span * i) / Math.max(1, wordChars.length);
        cursor += 1;
      });
    });
  }
  for (let i = 0; i < chars.length; i += 1) {
    if (times[i] === undefined) {
      times[i] = start + ((end - start) * i) / Math.max(1, chars.length);
    }
  }
  return times;
}

let lyricsManualScroll = false;
let lyricsResumeTimer = null;
let lyricScrollRaf = null;

// 自定义缓动滚动：让歌词一句一句「慢慢下滑」而不是瞬间跳过去
function animateLyricScroll(container, target, duration = 760) {
  if (!container) return;
  if (lyricScrollRaf) cancelAnimationFrame(lyricScrollRaf);
  const start = container.scrollTop;
  const delta = target - start;
  if (Math.abs(delta) < 1) {
    container.scrollTop = target;
    return;
  }
  const startedAt = performance.now();
  const step = now => {
    const progress = Math.min(1, (now - startedAt) / duration);
    // ease-in-out，前后都更柔和
    const eased = progress < .5
      ? 4 * progress * progress * progress
      : 1 - ((-2 * progress + 2) ** 3) / 2;
    container.scrollTop = start + delta * eased;
    if (progress < 1) lyricScrollRaf = requestAnimationFrame(step);
    else lyricScrollRaf = null;
  };
  lyricScrollRaf = requestAnimationFrame(step);
}

function stopLyricScrollAnimation() {
  if (lyricScrollRaf) {
    cancelAnimationFrame(lyricScrollRaf);
    lyricScrollRaf = null;
  }
}

function pauseLyricsAutoScroll() {
  stopLyricScrollAnimation();
  lyricsManualScroll = true;
  const button = $('#lyricsBackCurrent');
  if (button) button.hidden = false;
  clearTimeout(lyricsResumeTimer);
  lyricsResumeTimer = setTimeout(() => resumeLyricsAutoScroll(false), 9000);
}

function resumeLyricsAutoScroll(scrollNow = true) {
  lyricsManualScroll = false;
  clearTimeout(lyricsResumeTimer);
  const button = $('#lyricsBackCurrent');
  if (button) button.hidden = true;
  if (scrollNow) updateLyricsActive(true);
}

function renderLyricSource() {
  const label = $('#lyricSource');
  if (!label) return;
  const track = getTrack(state.currentId);
  const has = Boolean(track && getLyrics(track).length);
  // 只在没有歌词时提示原因，正常播放时保持歌词区域干净
  if (track && !has) {
    label.hidden = false;
    label.textContent = '未找到歌词 · 可在歌曲信息里导入';
    return;
  }
  label.hidden = true;
  label.textContent = '';
}

/**
 * 算出「当前播放位置落在哪一句歌词上」。
 * timeupdate 和逐字 tick 都要这份结果，原来是各写一遍完全相同的六行（含那个 0.18s 的提前量），
 * 抽出来以后歌词偏移量的口径只有一处，不会两边调不同步。
 * 返回 null 表示这首歌没有歌词。
 */
function resolveActiveLyric() {
  const lyrics = getLyrics(getTrack(state.currentId));
  if (!lyrics.length) return null;
  const position = audio.currentTime + .18 + currentLyricOffset();
  // 线性扫到最后一个「时间已到」的行；歌词量级不大，二分在这里没有收益
  let active = 0;
  for (let i = 0; i < lyrics.length; i += 1) {
    if (position >= lyrics[i].time) active = i;
  }
  return { lyrics, active, position };
}

function updateLyricsActive(forceScroll = false) {
  // 歌词的 DOM 全都挂在 #fullPlayer 里，它没打开时这轮同步纯粹是白做
  // （timeupdate 每秒触发约 4 次，每次都还要遍历歌词行 + 更新逐字状态）。
  // 全屏页一打开就会走 renderLyrics() → 这里被重新调用一次，不会漏掉同步。
  if (!forceScroll) {
    if (!fullPlayerNode || !fullPlayerNode.isConnected) fullPlayerNode = $('#fullPlayer');
    if (!fullPlayerNode || !fullPlayerNode.classList.contains('open')) return;
  }
  const resolved = resolveActiveLyric();
  if (!resolved) return;
  const { active } = resolved;
  const changed = activeLineIndex !== active;
  const playChanged = state.playing !== lyricPlayingFlag;
  lyricPlayingFlag = state.playing;
  // 只在「换了句」或「播放状态变了」时碰 DOM，而且只动上一句 + 当前句两个节点。
  // 原来每次 timeupdate（约每秒 4 次）都要 querySelectorAll 全量行、再逐行 toggle 两个类，
  // 双语歌词行数翻倍后这批无用功就是滚动卡顿的主因之一。
  if (changed || playChanged) {
    if (changed && activeLineIndex >= 0) {
      const previous = lyricLineNodes[activeLineIndex];
      if (previous) previous.classList.remove('active', 'current');
    }
    activeLineIndex = active;
    const activeNode = lyricLineNodes[active];
    if (activeNode) {
      activeNode.classList.add('active');
      activeNode.classList.toggle('current', state.playing);
    }
  }
  updateKaraoke(resolved.lyrics, active, resolved.position);
  // 暂停时点「回到当前」也应该滚过去；旧条件要求 state.playing 为真，暂停状态下按钮等于失效。
  if ((state.playing || forceScroll) && (changed || forceScroll) && (!lyricsManualScroll || forceScroll)) {
    const activeLine = lyricLineNodes[active];
    const scroller = $('#lyricsScroll');
    if (activeLine && scroller) {
      const target = activeLine.offsetTop - scroller.clientHeight / 2 + activeLine.clientHeight / 2;
      animateLyricScroll(scroller, Math.max(0, target), 780);
    }
  }
}

// 当前句下标 / 上一帧的播放状态 / 歌词行节点缓存（均与「视图歌词」一一对应）
let activeLineIndex = -1;
let lyricPlayingFlag = null;
let lyricLineNodes = [];
let lyricCharNodes = [];

// 逐字刷新要用到的两个缓存：
// - fullPlayerNode：#fullPlayer 在生命周期里只有一个节点，不必每 80ms 查一次 DOM
// - karaokeTimeline*：同一行的逐字时间轴是常量，换行才需要重算
let fullPlayerNode = null;
let karaokeTimelineLine = null;
let karaokeTimelineTimes = [];

// 动画帧级的逐字刷新（只更新当前句，避免频繁滚动）
function karaokeTick() {
  if (!state.playing) return;
  // isConnected 兜底：万一节点被替换掉，下一帧自动重新取一次
  if (!fullPlayerNode || !fullPlayerNode.isConnected) fullPlayerNode = $('#fullPlayer');
  if (!fullPlayerNode || !fullPlayerNode.classList.contains('open')) return;
  const resolved = resolveActiveLyric();
  if (!resolved) return;
  updateKaraoke(resolved.lyrics, resolved.active, resolved.position);
}

// 逐字点亮 + 轻微漂浮
function updateKaraoke(lyrics, active, position) {
  const line = lyrics[active];
  if (!line) return;
  // 逐字节点已在 renderLyrics 里缓存好，不再每 80ms 按属性选择器查一次
  const chars = lyricCharNodes[active];
  if (!chars || !chars.length) return;
  // 同一行的每个字落在什么时刻是固定的，换行时才重算（原来每次 tick 都重算，内部还有展开和数组分配）
  if (karaokeTimelineLine !== line) {
    karaokeTimelineLine = line;
    karaokeTimelineTimes = charTimeline(line, lyrics[active + 1]);
  }
  const times = karaokeTimelineTimes;
  // 原来是 times.filter(...).length —— 每 80ms 新建一个数组只为数个数，改成直接计数
  let revealed = chars.length;
  if (state.playing) {
    revealed = 0;
    for (let i = 0; i < times.length; i += 1) {
      if (position >= times[i]) revealed += 1;
    }
  }
  for (let i = 0; i < chars.length; i += 1) {
    const node = chars[i];
    const on = i < revealed;
    if (on && !node.classList.contains('on')) {
      node.classList.add('on', 'pop');
      setTimeout(() => node.classList.remove('pop'), 460);
    } else if (!on && node.classList.contains('on')) {
      node.classList.remove('on', 'pop');
    }
  }
}

const PAGE_LABELS = {
  home: '主页',
  search: '搜索',
  online: '在线',
  library: '歌单',
  playlist: '歌单详情',
  collection: '专辑',
  songs: '歌曲',
  favorites: '喜爱',
  recent: '最近添加',
  settings: '设置',
  import: '导入'
};

// 详情页不是独立的一级入口：歌单详情要算在「歌单」这个导航项下面
const PAGE_NAV_ALIAS = { playlist: 'library', collection: 'library' };

function showPage(page) {
  const changed = state.page !== page;
  state.page = page;
  // 页面切换的观察者（设置页导航高亮等）需要知道「现在在哪一页」
  window.dispatchEvent(new CustomEvent('pagechange', { detail: page }));
  $$('.page').forEach(section => section.classList.toggle('active', section.id === `${page}Page`));
  const navKey = PAGE_NAV_ALIAS[page] || page;
  $$( '.nav-item, .sidebar-link[data-page]' ).forEach(button => button.classList.toggle('active', button.dataset.page === navKey));
  // 侧栏底部那颗「设置」不是 .nav-item，单独给激活态，否则进了设置页左边一点反馈都没有
  const settingsEntry = $('.sidebar .storage-card');
  if (settingsEntry) settingsEntry.classList.toggle('active', page === 'settings');
  const titlebarPage = $('#titlebarPage');
  if (titlebarPage) titlebarPage.textContent = PAGE_LABELS[page] || '';
  if (page === 'online' && typeof refreshOnlinePage === 'function') refreshOnlinePage();
  // 首页的在线每日推荐按天 / 按平台失效，回到首页时问一下要不要重拉
  if (page === 'home' && typeof ensureHomeDaily === 'function') ensureHomeDaily();
  // 喜爱页混着本地收藏、在线收藏和账号红心，进页时重渲染一次才能拿到最新状态
  if (page === 'favorites') renderFavorites();
  // 页面 key 是 library（不是 playlists），以前这里恒不成立，切回歌单页时列表不会刷新
  if (page === 'library') { renderPlaylists(); if (typeof renderAlbums === 'function') renderAlbums(); if (typeof renderArtists === 'function') renderArtists(); }
  if (page === 'playlist') renderPlaylistPage();
  if (page === 'collection') renderCollectionPage();
  if (!changed) return;
  // 搜索词只属于搜索页。离开搜索页时不清掉的话，「歌曲」列表会继续被这个看不见的词过滤，
  // 用户会以为资料库里的歌丢了。真正的搜索结果是独立渲染的，不受影响。
  if (page !== 'search' && state.query) {
    state.query = '';
    const input = $('#globalSearch');
    if (input) input.value = '';
    renderLocalTracks();
  }
  // 整窗不滚动了（滚动收在 .main-content 里），切页要把内容区拉回顶部
  $('.main-content')?.scrollTo({ top: 0 });
  window.scrollTo({ top:0, behavior:'smooth' });
}

function showTab(tab) {
  state.tab = tab;
  $$('.library-tab').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  $$('.library-panel').forEach(panel => panel.classList.toggle('active', panel.dataset.panel === tab));
}

function setTitleBarTone(mode) {
  // 标题栏按钮已改成自绘（frame:false），颜色由 CSS 跟随主题走，
  // 系统 overlay 通道不再需要；这里只保留 body 上的语气类给样式用。
  document.body.classList.toggle('tone-full', mode === 'full');
  document.body.classList.toggle('tone-light', mode === 'light');
}

/** 自绘窗口按钮：最大化后图标换成「还原」，并让 body 知道当前状态
    主界面标题栏和歌词页右上角各有一套，两个一起同步 */
function syncMaximizeUi(maximized) {
  const on = Boolean(maximized);
  document.body.classList.toggle('is-maximized', on);
  ['#winMaximize', '#lyricsWinMax'].forEach(selector => {
    const button = $(selector);
    if (!button) return;
    button.querySelector('use')?.setAttribute('href', on ? '#i-win-restore' : '#i-win-max');
    button.setAttribute('aria-label', on ? '还原' : '最大化');
    button.title = on ? '还原' : '最大化';
  });
}

function bindWindowControls() {
  $('#winMinimize')?.addEventListener('click', () => window.orangeDesktop?.minimize?.());
  $('#winMaximize')?.addEventListener('click', () => window.orangeDesktop?.toggleMaximize?.());
  $('#winClose')?.addEventListener('click', () => window.orangeDesktop?.closeWindow?.());
  // 歌词页右上角那套三键：歌词页把标题栏整块盖住了，没有它就没法最小化 / 关窗
  $('#lyricsWinMin')?.addEventListener('click', () => window.orangeDesktop?.minimize?.());
  $('#lyricsWinMax')?.addEventListener('click', () => window.orangeDesktop?.toggleMaximize?.());
  $('#lyricsWinClose')?.addEventListener('click', () => window.orangeDesktop?.closeWindow?.());
  // 拖拽区不在拖动区之外的按钮上：双击标题栏空白处 = 最大化 / 还原
  $('#titlebar')?.addEventListener('dblclick', event => {
    if (event.target.closest('.window-controls')) return;
    window.orangeDesktop?.toggleMaximize?.();
  });
  window.orangeDesktop?.onMaximizedChange?.(syncMaximizeUi);
  window.orangeDesktop?.isMaximized?.().then(syncMaximizeUi).catch(() => {});
}

function toggleWindowMaximize() {
  const desktop = window.orangeDesktop;
  if (!desktop?.toggleMaximize) return;
  desktop.toggleMaximize();
}

function initTitleBar() {
  const regions = [$('#titlebar'), $('#lyricsDragStrip')].filter(Boolean);
  regions.forEach(region => {
    region.addEventListener('dblclick', () => {
      const before = { w: window.outerWidth, h: window.outerHeight };
      setTimeout(() => {
        const changed = window.outerWidth !== before.w || window.outerHeight !== before.h;
        if (!changed) toggleWindowMaximize();
      }, 280);
    });
  });
}

function openFullPlayer() {
  $('#fullPlayer').classList.add('open');
  // 立即按当前歌词主题切标题栏符号色，不再延时 80ms（快速开关会留下错误颜色的竞态）
  setTitleBarTone(state.prefs.lyricTheme === 'light' ? 'light' : 'full');
  $('#fullPlayer').setAttribute('aria-hidden','false');
  document.body.style.overflow = 'hidden';
  renderLyrics();
  applyLyricTheme();
  const track = getTrack(state.currentId);
  if (track && track._path && !getLyrics(track).length && !track._lyricChecked) {
    track._lyricChecked = true;
    loadTrackLyrics(track).then(lines => {
      if (lines.length) {
        renderLyrics();
        pushDesktopLyricsState();
      }
    });
  }
  // 在线曲目打开全屏页时也补一次歌词：这里常常是「还没播放就点开了歌词页」，
  // 直链解析还没跑，不补就一直是空的
  if (track && track._online && !getLyrics(track).length && typeof ensureOnlineLyrics === 'function') {
    ensureOnlineLyrics(track);
  }
}

function closeFullPlayer() {
  $('#fullPlayer').classList.remove('open');
  setTitleBarTone('main');
  $('#fullPlayer').setAttribute('aria-hidden','true');
  document.body.style.overflow = '';
}

function toggleQueue(open = !$('#queueDrawer').classList.contains('open')) {
  $('#queueDrawer').classList.toggle('open', open);
  $('.drawer-backdrop').classList.toggle('open', open);
  $('#queueDrawer').setAttribute('aria-hidden', String(!open));
}

function openAddModal(id) {
  const ids = Array.isArray(id) ? id.filter(Boolean) : [id].filter(Boolean);
  state.pendingAddIds = ids;
  state.pendingAddId = ids[0] || null;
  $('#addToPlaylistList').innerHTML = state.playlists.map(playlist => `
    <button class="add-choice" data-add-to="${playlist.id}">
      <svg class="icon"><use href="#i-list"/></svg>
      <span>${escapeHtml(playlist.name)}</span>
      <small>${playlist.tracks.length} 首${ids.length > 1 ? ` · 将加入 ${ids.length} 首` : ''}</small>
    </button>`).join('') + `
    <button class="add-choice" data-add-new="true">
      <svg class="icon"><use href="#i-plus"/></svg>
      <span>新建歌单</span>
      <small>创建后加入</small>
    </button>`;
  $('#addModal').showModal();
}

function addToPlaylist(playlistId, trackId = state.pendingAddId) {
  const playlist = state.playlists.find(item => item.id === playlistId);
  if (!playlist) return;
  const ids = (state.pendingAddIds?.length ? state.pendingAddIds : [trackId]).filter(id => getTrack(id));
  if (!ids.length) return;
  let added = 0;
  ids.forEach(id => {
    if (!playlist.tracks.includes(id)) {
      playlist.tracks.push(id);
      added += 1;
    }
    // 网络歌曲要顺手把元数据落到在线库，否则重启后按 id 查不到这首歌
    const track = getTrack(id);
    if (track && track._online && typeof persistableTrack === 'function' && typeof onlineLib !== 'undefined') {
      onlineLib.tracks[id] = onlineLib.tracks[id] || persistableTrack(track);
      if (typeof saveOnlineLib === 'function') saveOnlineLib();
    }
  });
  saveState();
  saveLibrary();
  renderPlaylists();
  if (!added) showToast(`“${playlist.name}”里已经有${ids.length > 1 ? '这些歌曲' : '这首歌'}`);
  else showToast(`已把 ${added} 首歌曲添加到“${playlist.name}”`);
  state.pendingAddIds = [];
  $('#addModal').close();
}

function playPlaylist(id) {
  playPlaylistFrom(id);
}

function applyPlayerStyle() {
  const mini = $('#miniPlayer');
  const effect = $('#playerEffect');
  const blurInput = $('#playerBlur');
  const opacityInput = $('#playerOpacity');
  if (!mini || !effect || !blurInput || !opacityInput) return;

  const mode = effect.value;
  const blur = Number(blurInput.value);
  const opacity = Number(opacityInput.value) / 100;
  mini.dataset.effect = mode;
  mini.style.setProperty('--player-blur', `${blur}px`);
  mini.style.setProperty('--player-opacity', opacity);
  let backdrop = 'none';

  if (mode === 'blur') backdrop = `blur(${blur}px)`;
  if (mode === 'acrylic') backdrop = `blur(${blur}px) saturate(185%)`;
  if (mode === 'gaussian') backdrop = `blur(${Math.min(60, blur * 1.5)}px) saturate(165%)`;

  mini.style.background = `rgba(255,255,255,${opacity})`;
  mini.style.backdropFilter = backdrop;
  mini.style.webkitBackdropFilter = backdrop;
  mini.style.borderColor = mode === 'translucent' ? 'rgba(255,255,255,.58)' : 'rgba(255,255,255,.9)';
  mini.style.boxShadow = mode === 'acrylic'
    ? '0 18px 44px rgba(35,40,49,.20), inset 0 1px 0 rgba(255,255,255,.65)'
    : mode === 'gaussian'
      ? '0 20px 52px rgba(35,40,49,.24), 0 0 0 1px rgba(255,255,255,.22)'
      : '0 16px 38px rgba(35,40,49,.16), 0 2px 8px rgba(35,40,49,.08)';
  const preview = $('#playerEffectPreview');
  if (preview) {
    preview.style.background = `rgba(255,255,255,${opacity})`;
    preview.style.backdropFilter = backdrop;
    preview.style.webkitBackdropFilter = backdrop;
  }

  const blurValue = $('#playerBlurValue');
  const opacityValue = $('#playerOpacityValue');
  if (blurValue) blurValue.textContent = `${blur} px`;
  if (opacityValue) opacityValue.textContent = `${Math.round(opacity * 100)}%`;

  localStorage.setItem('orange-player-style', JSON.stringify({ mode, blur, opacity: Math.round(opacity * 100) }));
}

function initPlayerStyleControls() {
  const effect = $('#playerEffect');
  const blurInput = $('#playerBlur');
  const opacityInput = $('#playerOpacity');
  if (!effect || !blurInput || !opacityInput) return;

  const saved = readStored('orange-player-style', { mode:'blur', blur:24, opacity:84 });
  effect.value = saved.mode || 'blur';
  blurInput.value = saved.blur ?? 24;
  opacityInput.value = saved.opacity ?? 84;

  [effect, blurInput, opacityInput].forEach(control => {
    control.oninput = applyPlayerStyle;
    control.onchange = applyPlayerStyle;
  });
  applyPlayerStyle();
}

// 当前「跟随封面」配色是按哪个封面算的；同一张封面重复调用直接跳过采样
let lyricThemeCoverKey = '';

function applyLyricTheme() {
  const player = $('#fullPlayer');
  const image = $('#fullCover');
  if (!player || !image) return;
  const mode = state.prefs.lyricTheme || 'cover';
  const syncTitleBarTone = () => {
    if (!player.classList.contains('open')) {
      setTitleBarTone('main');
      return;
    }
    setTitleBarTone(mode === 'light' ? 'light' : 'full');
  };

  // 浅色 / 固定深色：不使用封面取色，交给 CSS 变量控制
  if (mode !== 'cover') {
    lyricThemeCoverKey = '';
    player.style.backgroundColor = '';
    player.style.removeProperty('--lyric-cover-url');
    player.classList.add('lyric-plain');
    player.classList.toggle('lyric-light', mode === 'light');
    document.body.classList.toggle('lyric-light', mode === 'light');
    syncTitleBarTone();
    return;
  }
  player.classList.remove('lyric-plain', 'lyric-light');
  document.body.classList.remove('lyric-light');

  const coverUrl = String(image.src || '');
  // 占位封面（assets/cover-default.png）参与取色的后果：整页背景被染成品牌橙的
  // 一片土黄，而且它会被放大模糊后铺满背景。这首歌本来就没有封面，不该有主题色。
  const isPlaceholder = !coverUrl || /\/assets\/cover-default\.png(\?|#|$)/i.test(coverUrl);
  // 设置背景图不需要读像素，先无条件写进去。
  // 旧实现把这一步放在 canvas 取色成功之后，而 file:// 图片会污染 canvas，
  // getImageData 必然抛 SecurityError —— 结果「跟随封面」的背景永远是空的。
  if (!isPlaceholder) {
    player.style.setProperty('--lyric-cover-url', `url("${coverUrl.replace(/["\\]/g, '\\$&')}")`);
  } else {
    player.style.removeProperty('--lyric-cover-url');
  }

  const key = `${mode}|${coverUrl}`;
  if (key === lyricThemeCoverKey) {
    syncTitleBarTone();
    return;
  }
  lyricThemeCoverKey = key;

  const update = async () => {
    // 走和 --cover-accent 同一条采样链路（主进程解码成 data URL），
    // 避开 file:// 直接 drawImage 导致的 canvas 污染。
    const rgb = await applyCoverAccent(isPlaceholder ? '' : coverUrl);
    if (lyricThemeCoverKey !== key) return; // 采样期间切歌 / 换主题，丢弃过期结果
    if (Array.isArray(rgb) && rgb.length === 3) {
      const [r, g, b] = rgb;
      player.style.backgroundColor = `rgb(${Math.round(r * .30 + 12)}, ${Math.round(g * .30 + 16)}, ${Math.round(b * .30 + 14)})`;
      player.style.setProperty('--lyric-theme-color', `rgb(${r}, ${g}, ${b})`);
    } else {
      player.style.backgroundColor = '';
    }
    syncTitleBarTone();
  };

  image.onload = update;
  if (image.complete && image.naturalWidth) update();
}

function relocateFullPlayerControls() {
  const art = $('.full-art-wrap');
  const info = $('.full-info');
  if (!art || !info) return;
  const title = $('.full-title-row', info);
  const seek = $('.full-seek', info);
  const transport = $('.full-transport', info);
  if (title && title.parentElement !== art) {
    art.appendChild(title);
    if (seek) art.appendChild(seek);
    if (transport) art.appendChild(transport);
  }
}

function initAutoScrollbar() {
  const bar = $('#mainScrollbar');
  const thumb = bar?.querySelector('i');
  if (!bar || !thumb) return;
  let hideTimer = null;

  const update = () => {
    const root = document.scrollingElement || document.documentElement;
    const max = Math.max(1, root.scrollHeight - root.clientHeight);
    const ratio = Math.min(1, root.clientHeight / root.scrollHeight);
    const thumbHeight = Math.max(36, bar.clientHeight * ratio);
    const top = (root.scrollTop / max) * (bar.clientHeight - thumbHeight);
    thumb.style.height = thumbHeight + 'px';
    thumb.style.transform = 'translateY(' + top + 'px)';
  };

  const show = () => {
    update();
    bar.classList.add('visible');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => bar.classList.remove('visible'), 700);
  };

  window.addEventListener('scroll', show, { passive: true });
  window.addEventListener('resize', update, { passive: true });
  update();
}

// 波形图每帧都要用到的常量与缓冲，放到模块级复用，
// 避免在 requestAnimationFrame 回调里每帧新建数组 / 字符串（60fps 下是持续的无用分配）
const VISUALIZER_BARS = 42;
const VISUALIZER_COLORS = ['#ff6658', '#f4f4f5', '#38bdf8', '#69db9d'];
let visualizerSpectrum = null;

function drawVisualizer() {
  // 氛围灯搭这个循环的顺风车：它是常驻的 rAF（波形关了也还在跑），
  // 而波形自己在下面遇到「没开波形 / 歌词界面没打开」会提前 return，
  // 所以必须放在那两处 return 之前。
  updateAmbientLight();
  const canvas = $('#visualizer');
  if (!canvas) {
    requestAnimationFrame(drawVisualizer);
    return;
  }
  const context = canvas.getContext('2d');
  const enabled = $('#waveformToggle')?.checked;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
  }
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!enabled || !$('#fullPlayer')?.classList.contains('open')) {
    requestAnimationFrame(drawVisualizer);
    return;
  }
  const gap = 4 * dpr;
  const barWidth = Math.max(2 * dpr, (canvas.width - gap * (VISUALIZER_BARS - 1)) / VISUALIZER_BARS);
  if (!visualizerSpectrum) visualizerSpectrum = new Uint8Array(64);
  const values = visualizerSpectrum;
  if (analyser) {
    analyser.getByteFrequencyData(values);
  } else {
    for (let i = 0; i < values.length; i += 1) values[i] = 70 + Math.sin(audio.currentTime * 3 + i * .7) * 45;
  }
  context.globalAlpha = .78;
  for (let i = 0; i < VISUALIZER_BARS; i += 1) {
    const raw = values[Math.floor(i / VISUALIZER_BARS * values.length)] || 40;
    const level = state.playing ? raw / 255 : .08;
    const barHeight = Math.max(4 * dpr, level * canvas.height * .9);
    const x = i * (barWidth + gap);
    const y = canvas.height - barHeight;
    context.fillStyle = VISUALIZER_COLORS[i % VISUALIZER_COLORS.length];
    context.fillRect(x, y, barWidth, barHeight);
  }
  context.globalAlpha = 1;
  requestAnimationFrame(drawVisualizer);
}

document.addEventListener('click', event => {
  const pageButton = event.target.closest('[data-page]');
  if (pageButton) {
    showPage(pageButton.dataset.page);
    return;
  }

  // ---------- 资料库：歌单 / 专辑 / 艺术家 ----------
  const libraryViewButton = event.target.closest('[data-library-view]');
  if (libraryViewButton) {
    switchLibraryView(libraryViewButton.dataset.libraryView);
    return;
  }

  const albumCard = event.target.closest('[data-album-index]');
  if (albumCard) {
    const kind = albumCard.dataset.albumKind || 'album';
    const index = Number(albumCard.dataset.albumIndex);
    // 卡片右下角那颗播放键：直接整组开播，不进详情页
    if (event.target.closest('[data-album-play]')) {
      const group = collectionGroups(kind)[index];
      if (group?.tracks.length) {
        state.collection = { kind, key: group.key };
        playCollection('', false);
      }
      return;
    }
    openCollectionPage(kind, index);
    return;
  }

  if (event.target.closest('[data-col-back]')) {
    closeCollectionPage();
    return;
  }

  const collectionAction = event.target.closest('[data-col-action]');
  if (collectionAction) {
    const action = collectionAction.dataset.colAction;
    if (action === 'play-all') playCollection('', false);
    if (action === 'shuffle') playCollection('', true);
    return;
  }

  const scrollButton = event.target.closest('[data-scroll]');
  if (scrollButton) {
    showPage('home');
    requestAnimationFrame(() => document.getElementById(scrollButton.dataset.scroll)?.scrollIntoView({ behavior:'smooth', block:'start' }));
    return;
  }

  const playButton = event.target.closest('[data-play]');
  if (playButton) {
    event.stopPropagation();
    const id = playButton.dataset.play;
    if (id === state.currentId && !audio.paused) togglePlayback();
    else playTrack(id);
    return;
  }

  const favoriteButton = event.target.closest('[data-favorite]');
  if (favoriteButton) {
    event.stopPropagation();
    toggleFavorite(favoriteButton.dataset.favorite);
    return;
  }

  const selectBox = event.target.closest('[data-select]');
  if (selectBox) {
    event.stopPropagation();
    toggleSelectedSong(selectBox.dataset.select);
    return;
  }

  const removeButton = event.target.closest('[data-remove]');
  if (removeButton) {
    event.stopPropagation();
    const id = removeButton.dataset.remove;
    const track = getTrack(id);
    if (track && window.confirm(`确定要从资料库移除「${track.title}」吗？\n磁盘上的音乐文件不会被删除。`)) {
      removeTrack(id);
      showToast('已从资料库移除');
    }
    return;
  }

  const infoButton = event.target.closest('[data-info]');
  if (infoButton) {
    event.stopPropagation();
    openInfoModal(infoButton.dataset.info);
    return;
  }

  const editButton = event.target.closest('[data-edit]');
  if (editButton) {
    event.stopPropagation();
    openEditModal(editButton.dataset.edit);
    return;
  }

  const removeFolderButton = event.target.closest('[data-remove-folder]');
  if (removeFolderButton) {
    event.stopPropagation();
    const index = Number(removeFolderButton.dataset.removeFolder);
    state.prefs.watchFolders = (state.prefs.watchFolders || []).filter((_, i) => i !== index);
    savePrefs();
    renderWatchList();
    return;
  }

  const addButton = event.target.closest('[data-add]');
  if (addButton) {
    event.stopPropagation();
    openAddModal(addButton.dataset.add);
    return;
  }

  const trackCard = event.target.closest('[data-track-card]');
  if (trackCard) {
    playTrack(trackCard.dataset.trackCard);
    return;
  }

  const trackRow = event.target.closest('[data-track]');
  if (trackRow) {
    // 多选模式下点击整行 = 勾选 / 取消勾选
    if (state.selectMode) {
      toggleSelectedSong(trackRow.dataset.track);
      return;
    }
    playTrack(trackRow.dataset.track);
    return;
  }

  const queueRow = event.target.closest('[data-queue-track]');
  if (queueRow) {
    playTrack(queueRow.dataset.queueTrack);
    toggleQueue(false);
    return;
  }

  const playlistMenuToggle = event.target.closest('[data-pl-menu-toggle]');
  if (playlistMenuToggle) {
    event.stopPropagation();
    openPlMenu(playlistMenuToggle, playlistMenuToggle.dataset.plMenuToggle);
    return;
  }

  const playlistMenuItem = event.target.closest('[data-pl-menu]');
  if (playlistMenuItem) {
    const menu = $('#plMenu');
    runPlMenuAction(playlistMenuItem.dataset.plMenu, menu?.dataset.playlist);
    return;
  }

  if (event.target.closest('[data-pl-back]')) {
    closePlaylistPage();
    return;
  }

  const playlistAction = event.target.closest('[data-pl-action]');
  if (playlistAction) {
    const action = playlistAction.dataset.plAction;
    if (action === 'play-all') playPlaylistFrom(currentPlaylistId);
    if (action === 'shuffle') playPlaylistFrom(currentPlaylistId, '', true);
    if (action === 'go-songs') showPage('songs');
    if (action === 'go-online') showPage('online');
    return;
  }

  const playlistPlay = event.target.closest('[data-play-playlist]');
  if (playlistPlay) {
    event.stopPropagation();
    playPlaylist(playlistPlay.dataset.playPlaylist);
    return;
  }

  const rowRemove = event.target.closest('[data-pl-remove]');
  if (rowRemove) {
    event.stopPropagation();
    const playlist = currentPlaylist();
    if (playlist) {
      playlist.tracks = playlist.tracks.filter(id => id !== rowRemove.dataset.plRemove);
      saveState();
      if (typeof saveOnlineLib === 'function') saveOnlineLib();
      renderPlaylists();
      renderCounts();
      showToast('已从歌单移除');
    }
    return;
  }

  const rowQueue = event.target.closest('[data-pl-queue]');
  if (rowQueue) {
    event.stopPropagation();
    const track = getTrack(rowQueue.dataset.plQueue);
    if (track) {
      state.queue.push(track.id);
      renderQueue();
      saveLibrary();
      showToast('已加入播放队列');
    }
    return;
  }

  const rowAdd = event.target.closest('[data-pl-add]');
  if (rowAdd) {
    event.stopPropagation();
    openAddModal(rowAdd.dataset.plAdd);
    return;
  }

  const rowPlayButton = event.target.closest('[data-pl-play]');
  if (rowPlayButton) {
    event.stopPropagation();
    // 专辑 / 艺术家详情页复用同一套行模板，点播放要走当前分组，不是上一个歌单
    if (event.target.closest('#colTrackList')) {
      playCollection(rowPlayButton.dataset.plPlay);
      return;
    }
    playPlaylistFrom(currentPlaylistId, rowPlayButton.dataset.plPlay);
    return;
  }

  const playlistRow = event.target.closest('[data-pl-row]');
  if (playlistRow) {
    if (event.target.closest('#colTrackList')) {
      playCollection(playlistRow.dataset.plRow);
      return;
    }
    // 点整行 = 从这首开始按歌单顺序播放
    playPlaylistFrom(currentPlaylistId, playlistRow.dataset.plRow);
    return;
  }

  const playlistCard = event.target.closest('[data-playlist]');
  if (playlistCard) {
    openPlaylistPage(playlistCard.dataset.playlist);
    return;
  }

  const addTo = event.target.closest('[data-add-to]');
  if (addTo) {
    addToPlaylist(addTo.dataset.addTo);
    return;
  }

  if (event.target.closest('[data-add-new]')) {
    pendingNewPlaylistIds = [...(state.pendingAddIds || [])].filter(id => getTrack(id));
    $('#addModal').close();
    $('#playlistModal').showModal();
    setTimeout(() => $('#playlistName').focus(),50);
    return;
  }

  const selectButton = event.target.closest('[data-action="toggle-select"]');
  if (selectButton) {
    toggleSelectMode();
    return;
  }

  const batchBar = event.target.closest('#batchBar [data-action]');
  if (batchBar) {
    const mode = batchBar.dataset.action;
    if (mode === 'batch-all') selectAllSongs('all');
    if (mode === 'batch-none') selectAllSongs('none');
    if (mode === 'batch-invert') selectAllSongs('invert');
    if (mode === 'batch-exit') toggleSelectMode(false);
    if (mode === 'batch-remove') batchRemoveSelected();
    if (mode === 'batch-add') {
      const ids = [...state.selection].filter(id => getTrack(id));
      if (!ids.length) showToast('还没有选择歌曲');
      else openAddModal(ids);
    }
    return;
  }

  const tab = event.target.closest('[data-tab]');
  if (tab) {
    showTab(tab.dataset.tab);
    return;
  }

  const actionTarget = event.target.closest('[data-action]');
  if (!actionTarget) return;
  const action = actionTarget.dataset.action;
  if (action === 'show-settings') {
    showPage('settings');
  }
  if (action === 'import') showPage('import');
  if (action === 'new-playlist') {
    $('#playlistModal').showModal();
    setTimeout(() => $('#playlistName').focus(),50);
  }
  if (action === 'close-playlist-modal') $('#playlistModal').close();
  if (action === 'close-add-modal') $('#addModal').close();
  if (action === 'close-lyrics-modal') $('#lyricsModal').close();
  if (action === 'close-prompt') $('#promptModal').close();
  if (action === 'show-favorites') {
    showPage('library');
    showTab('favorites');
  }
  if (action === 'home-login') {
    showPage('online');
  }
  if (action === 'home-open-daily') {
    // 首页只看得到 8 首，这里把人送到在线页的每日推荐，能看到全部
    showPage('online');
    if (typeof switchOnlineView === 'function') switchOnlineView('daily');
  }
  if (action === 'refresh-recommend') {
    // 首页正在展示在线每日推荐时，「换一批」交给在线模块重新请求；
    // 它返回 false 说明当前是本地兜底状态，继续走原来的本地轮换
    if (typeof refreshHomeDaily === 'function' && refreshHomeDaily()) return;
    state.recommendationOffset = (state.recommendationOffset + 4) % Math.max(1,state.songs.length);
    renderRecommendations();
  }
  if (action === 'clear-recent') {
    state.recent = [];
    saveState();
    renderRecent();
    showToast('已清空最近播放');
  }
  if (action === 'clear-library') clearLibrary();
  if (action === 'find-duplicates') openDupeModal();
  if (action === 'import-m3u') importM3u();
  if (action === 'close-info-modal') $('#infoModal').close();
  if (action === 'close-edit-modal') $('#editModal').close();
  if (action === 'close-dupe-modal') $('#dupeModal').close();
  if (action === 'close-playlist-edit-modal') $('#playlistEditModal').close();
  if (action === 'expand-player') openFullPlayer();
  if (action === 'collapse-player') closeFullPlayer();
  if (action === 'toggle-fullscreen') toggleFullscreen();
  if (action === 'open-queue') toggleQueue(true);
  if (action === 'close-queue') toggleQueue(false);
  if (action === 'open-lyrics') openFullPlayer();
  if (action === 'open-desktop-lyrics') toggleDesktopLyrics();
  if (action === 'mini-player') toggleMiniWindow();
  if (action === 'open-more') {
    if (state.currentId && getTrack(state.currentId)) openAddModal(state.currentId);
    else showToast('还没有正在播放的歌曲');
  }
});

$('#playButton').addEventListener('click', togglePlayback);
$('#fullPlay').addEventListener('click', togglePlayback);
$('#nextButton').addEventListener('click', () => nextTrack());
$('#fullNext').addEventListener('click', () => nextTrack());
$('#prevButton').addEventListener('click', previousTrack);
$('#fullPrev').addEventListener('click', previousTrack);
$('#miniFavorite').addEventListener('click', () => toggleFavorite());
$('#fullFavorite').addEventListener('click', () => toggleFavorite());
$('#fullKaraoke').addEventListener('click', toggleKaraoke);

[$('#shuffleButton'),$('#fullShuffle')].forEach(button => button.addEventListener('click', toggleShuffleMode));

[$('#repeatButton'),$('#fullRepeat')].forEach(button => button.addEventListener('click', cycleRepeatMode));

[$('#seekSlider'),$('#fullSeekSlider')].forEach(slider => {
  slider.addEventListener('pointerdown', () => { seeking = true; });
  slider.addEventListener('change', () => { seekFromSlider(slider); seeking = false; });
  slider.addEventListener('pointerup', () => { seekFromSlider(slider); seeking = false; });
});
// 在滑块外面松手时 pointerup 不会落到滑块上，seeking 一旦卡在 true，
// 进度条就再也不跟着播放更新了。兜底在 window 上复位。
['pointerup', 'pointercancel'].forEach(type => {
  window.addEventListener(type, () => { seeking = false; }, { passive: true });
});

['#volumeSlider', '#fullVolumeSlider'].forEach(selector => {
  $(selector)?.addEventListener('input', event => setVolume(Number(event.target.value) / 100, { muted: false }));
});
['#volumeButton', '#fullVolumeButton'].forEach(selector => {
  $(selector)?.addEventListener('click', toggleMute);
});

const globalSearchInput = $('#globalSearch');
const searchClearButton = $('#searchClear');

// 输入框右侧的清空按钮：有内容才出现（原生 type=search 的 × 在各平台样式不一，自己画一个）
function syncSearchClear() {
  if (!searchClearButton) return;
  searchClearButton.hidden = !String(globalSearchInput?.value || '').trim();
}

globalSearchInput?.addEventListener('input', event => {
  state.query = event.target.value;
  renderSearchResults();
  syncSearchClear();
  showPage('search');
});

// 清空搜索时把范围也收回「全部」：否则上一条搜索留在「歌手」上，
// 下一条明明有这首歌却显示「0 首」，用户根本看不出是被范围筛掉了
function resetSearchScope() {
  state.searchScope = 'all';
  $$('#searchScopes .chip').forEach(item => item.classList.toggle('active', item.dataset.scope === 'all'));
}

globalSearchInput?.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !globalSearchInput.value) return;
  event.preventDefault();
  event.stopPropagation();
  globalSearchInput.value = '';
  state.query = '';
  resetSearchScope();
  renderSearchResults();
  syncSearchClear();
});

searchClearButton?.addEventListener('click', () => {
  if (!globalSearchInput) return;
  globalSearchInput.value = '';
  state.query = '';
  resetSearchScope();
  renderSearchResults();
  syncSearchClear();
  globalSearchInput.focus();
});

// 输入框外层改成 div 之后，点胶囊空白处也要能聚焦（原来靠 label 的默认行为）
$('.search-page-input')?.addEventListener('click', event => {
  if (event.target.closest('.search-page-clear')) return;
  globalSearchInput?.focus();
});

syncSearchClear();

$$('#searchScopes .chip').forEach(chip => chip.addEventListener('click', () => {
  state.searchScope = chip.dataset.scope;
  $$('#searchScopes .chip').forEach(item => item.classList.toggle('active', item === chip));
  renderSearchResults();
}));

// 「全部里还有 N 首」：一键把范围切回全部（不然用户只能自己发现是范围筛掉了）
$('#searchRecentRow')?.addEventListener('click', event => {
  if (!event.target.closest('.search-empty-switch')) return;
  resetSearchScope();
  renderSearchResults();
});
/* 播放快捷键统一在 handleShortcut 中处理 */

function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}

function toggleLyricsView() {
  if ($('#fullPlayer').classList.contains('open')) closeFullPlayer();
  else openFullPlayer();
}

/* ---------- 窗口全屏（F11 / 播放条右侧按钮 / 歌词页右上角按钮 / 双击顶部边框） ----------
   注意和「全屏播放页」区分：那个只是把歌词页铺满窗口，窗口本身还有标题栏和任务栏；
   这里让窗口真正占满整块屏幕，同时把自绘标题栏收掉（见 body.is-fullscreen 样式）。
   两个入口：主界面播放条最右那颗、歌词页右上角那颗 —— 同一颗按钮的两种皮肤，
   图标 / 提示文字在切换时一起换。 */
function syncFullscreenUi(on) {
  const full = Boolean(on);
  document.body.classList.toggle('is-fullscreen', full);
  ['#fullScreenBtn', '#miniFullscreenBtn'].forEach(selector => {
    const button = $(selector);
    if (!button) return;
    const use = button.querySelector('use');
    if (use) use.setAttribute('href', full ? '#i-fullscreen-exit' : '#i-fullscreen');
    button.setAttribute('aria-label', full ? '退出全屏' : '全屏');
    button.setAttribute('aria-pressed', full ? 'true' : 'false');
    button.title = full ? '退出全屏（F11）' : '全屏（F11）';
  });
}

function toggleFullscreen() {
  const desktop = window.orangeDesktop;
  // 先乐观翻自身 UI，再发命令：主进程的 leave-full-screen 在 Windows 上有时候
  // 不回调，等事件会导致退出全屏后图标还停在「向内四角」的样子。
  // 真回调晚到也只是用真实状态再校准一次，不会打架。
  const next = !document.body.classList.contains('is-fullscreen');
  syncFullscreenUi(next);
  if (desktop && typeof desktop.toggleFullscreen === 'function') {
    desktop.toggleFullscreen();
    return;
  }
  // 浏览器预览兜底：没有主进程时退回网页全屏，失败就把 UI 退回去
  if (document.fullscreenElement) document.exitFullscreen().catch(() => syncFullscreenUi(true));
  else document.documentElement.requestFullscreen?.().catch(() => syncFullscreenUi(false));
}

/* 双击顶部「窗口边框」退回窗口。
   Windows 里双击标题栏 = 最大化 / 还原，全屏后标题栏没了，多数播放器就把
   「双击最上面那条边」当成同一个手势 —— 这里照这个习惯来，主界面和歌词页都生效。
   只认顶部 24px：够得着，又不会跟页面里的双击（点歌、开卡片）抢事件；
   双击点在某些控件上时不处理，交还给控件自己。 */
const FULLSCREEN_EDGE_H = 24;
document.addEventListener('dblclick', event => {
  if (!document.body.classList.contains('is-fullscreen')) return;
  if (event.clientY > FULLSCREEN_EDGE_H) return;
  if (event.target?.closest?.('button, a, input, textarea, select, label, [contenteditable="true"]')) return;
  event.preventDefault();
  toggleFullscreen();
}, true);

if (window.orangeDesktop?.onFullscreenChange) window.orangeDesktop.onFullscreenChange(syncFullscreenUi);
// 启动时补一次：上次是全屏状态、或用户中途 Ctrl+R 重载，按钮图标不能停在「全屏」
window.orangeDesktop?.isFullscreen?.().then(syncFullscreenUi).catch(() => {});
document.addEventListener('fullscreenchange', () => syncFullscreenUi(Boolean(document.fullscreenElement)));

function handleShortcut(event) {
  const key = event.key;
  const lower = typeof key === 'string' ? key.toLowerCase() : '';
  const ctrl = event.ctrlKey || event.metaKey;

  if (key === 'Escape') {
    if (!$('#lyricMenu')?.hidden) {
      closeLyricMenu();
      return true;
    }
    // 窗口全屏时 Esc 先退全屏：歌词页还开着就留在歌词页，再按一次才退出歌词页
    if (document.body.classList.contains('is-fullscreen')) {
      toggleFullscreen();
      return true;
    }
    if ($('#fullPlayer').classList.contains('open')) closeFullPlayer();
    else if ($('#queueDrawer').classList.contains('open')) toggleQueue(false);
    // 歌单详情里按 Esc 退回歌单列表（最外层再返回）
    else if (state.page === 'playlist') closePlaylistPage();
    return true;
  }
  // Ctrl+F 也进搜索：默认绑定是 Ctrl+K，但绝大多数软件都用 Ctrl+F，
  // 两个都认，免得用户按了没反应以为搜索坏了
  if (ctrl && lower === 'f') {
    event.preventDefault();
    runShortcutAction('search');
    return true;
  }
  if (event.code === 'MediaPlayPause' || event.code === 'MediaStop') {    event.preventDefault();
    togglePlayback();
    return true;
  }
  if (event.code === 'MediaTrackNext') {
    event.preventDefault();
    mediaSkip(1);
    return true;
  }
  if (event.code === 'MediaTrackPrevious') {
    event.preventDefault();
    mediaSkip(-1);
    return true;
  }
  const combo = formatShortcutKey(event);
  const keys = shortcutMap();
  const action = combo ? Object.keys(keys).find(name => keys[name] === combo) : '';
  if (!action) return false;
  // 搜索键在输入框里也生效，其余快捷键打字时不触发
  if (action !== 'search' && (!state.prefs.shortcuts || isTypingTarget(event.target))) return false;
  event.preventDefault();
  runShortcutAction(action);
  return true;
}

function runShortcutAction(action) {
  switch (action) {
    case 'playPause': togglePlayback(); break;
    case 'seekBack': seekBy(-5); break;
    case 'seekForward': seekBy(5); break;
    case 'volumeUp': nudgeVolume(.05); break;
    case 'volumeDown': nudgeVolume(-.05); break;
    case 'prev': previousTrack(); break;
    case 'next': nextTrack(); break;
    case 'mute': toggleMute(); break;
    case 'favorite': toggleFavorite(); break;
    case 'lyrics': toggleLyricsView(); break;
    case 'queue': toggleQueue(); break;
    case 'shuffle': toggleShuffleMode(); break;
    case 'repeat': cycleRepeatMode(); break;
    case 'fullscreen': toggleFullscreen(); break;
    case 'search':
      showPage('search');
      setTimeout(() => $('#globalSearch').focus(), 50);
      break;
    default: break;
  }
}

document.addEventListener('keydown', handleShortcut);

/* 歌单：回车打开 / 播放，Esc 与点击空白处收起「更多」菜单。
   （空格留给全局「播放 / 暂停」，不再抢） */
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (!$('#plMenu')?.hidden) closePlMenu();
    return;
  }
  if (event.key !== 'Enter' || event.altKey || event.ctrlKey || event.metaKey) return;
  const card = event.target.closest?.('.playlist-card[data-playlist]');
  if (card) {
    event.preventDefault();
    openPlaylistPage(card.dataset.playlist);
    return;
  }
  const row = event.target.closest?.('.pl-row[data-pl-row]');
  if (row) {
    event.preventDefault();
    playPlaylistFrom(currentPlaylistId, row.dataset.plRow);
  }
});
document.addEventListener('click', event => {
  if (event.target.closest('#plMenu') || event.target.closest('[data-pl-menu-toggle]')) return;
  closePlMenu();
});
// 内容区滚动时：收起菜单，并让详情页的返回条长出玻璃底（静止时保持透明，
// 否则背景是渐变的，一条半透明色带压在上面反而像块补丁）
const mainScroller = $('.main-content');
mainScroller?.addEventListener('scroll', () => {
  closePlMenu();
  mainScroller.classList.toggle('is-scrolled', mainScroller.scrollTop > 6);
}, { passive: true });
window.addEventListener('resize', closePlMenu);
// 卡片上点右键 = 打开「更多」，和很多播放器一致
document.addEventListener('contextmenu', event => {
  const card = event.target.closest?.('.playlist-card[data-playlist]');
  if (!card) return;
  event.preventDefault();
  openPlMenu(card.querySelector('.playlist-more') || card, card.dataset.playlist);
});

$$('#formatFilters .chip').forEach(chip => chip.addEventListener('click', () => {
  state.format = chip.dataset.format;
  $$('#formatFilters .chip').forEach(item => item.classList.toggle('active',item === chip));
  renderLocalTracks();
}));

$('#playFavorites')?.addEventListener('click', () => {
  const favorites = state.songs.filter(song => state.favorites.has(song.id)).map(song => song.id);
  if (!favorites.length) return showToast('还没有喜爱的歌曲');
  state.queue = favorites;
  saveLibrary();
  playTrack(favorites[0]);
});
$('#featurePlay').addEventListener('click', () => {
  // 首页主卡片展示的是每日推荐时，这里播放整份推荐列表
  if (typeof playHomeDailyAll === 'function' && playHomeDailyAll()) return;
  if (!state.songs.length) {
    showPage('import');
    return;
  }
  const track = getTrack(state.currentId) || state.songs[0];
  playTrack(track.id);
});
$('#featureImport')?.addEventListener('click', () => {
  // 在线模式下这颗按钮是「刷新推荐」，本地模式下才是「导入歌曲」
  if (typeof refreshHomeDaily === 'function' && refreshHomeDaily()) return;
  showPage('import');
});

audio.addEventListener('play', () => { state.playing = true; audioErrorStreak = 0; updatePlayIcons(); updateLyricsActive(); pushDesktopLyricsState(); if (smtcSupported()) navigator.mediaSession.playbackState = 'playing'; });
audio.addEventListener('pause', () => { state.playing = false; updatePlayIcons(); updateLyricsActive(); pushDesktopLyricsState(); if (smtcSupported()) navigator.mediaSession.playbackState = 'paused'; });
audio.addEventListener('timeupdate', () => { updateProgress(); syncMediaPosition(); });
audio.addEventListener('seeked', () => syncMediaPosition(true));
audio.addEventListener('loadedmetadata', () => {
  const track = getTrack(state.currentId);
  if (track && Number.isFinite(audio.duration)) {
    track.duration = audio.duration;
    if (pendingResume > 3 && pendingResume < audio.duration - 5) {
      audio.currentTime = pendingResume;
    }
    pendingResume = 0;
    updateProgress();
    renderLocalTracks();
    renderQueue();
  }
});
audio.addEventListener('ended', handleTrackEnded);

/* 音频加载失败兜底：文件被移走 / 磁盘上被删 / 格式不受支持时，<audio> 只会默默
   触发一个 error 事件。原来没人监听，用户看到的就是「点了播放，进度条不动、
   也没声音、什么都不提示」。这里给一句明确提示，并在连播时自动跳过。
   连跳 3 首就停下来 —— 整个文件夹被移走时不能一首接一首地刷屏。 */
let audioErrorStreak = 0;
audio.addEventListener('error', () => {
  // 主动 removeAttribute('src') + load() 也会触发 error，那种情况不是「播不了」
  if (!audio.getAttribute('src')) return;
  const track = getTrack(state.currentId);
  state.playing = false;
  updatePlayIcons();
  audioErrorStreak += 1;
  if (audioErrorStreak >= 3) {
    audioErrorStreak = 0;
    showToast('连续几首都无法播放，已停止自动跳过（文件可能被移动或删除）');
    return;
  }
  showToast(`无法播放「${track?.title || '当前歌曲'}」，文件可能已被移动或格式不受支持`);
  if (track && !track._online && state.queue.length > 1) {
    setTimeout(() => nextTrack(true), 900);
  }
});

// 开着人声消除切到单声道音源会整首变哑，载入新歌后补一次检测，命中就自动关掉
audio.addEventListener('loadedmetadata', () => {
  if (!state.prefs.karaoke) return;
  setTimeout(async () => {
    if (!state.prefs.karaoke) return;
    if (!(await detectMonoSource())) return;
    state.prefs.karaoke = false;
    savePrefs();
    applyKaraoke();
    updateKaraokeUi();
    showToast('这首是单声道音源，已自动关闭人声消除');
  }, 320);
});
// 关闭软件前把当前播放位置立即落盘，保证下次打开时能准确续播
window.addEventListener('beforeunload', () => rememberProgress(true));
audio.addEventListener('volumechange', () => {
  if (!fadeTimer) syncVolumeUi();
});

$('#pageDropZone').addEventListener('click', () => $('#pageFileInput').click());
$('#pageChooseFiles').addEventListener('click', () => $('#pageFileInput').click());
$('#homeChooseFiles')?.addEventListener('click', () => $('#pageFileInput').click());
$('#pageChooseFolder').addEventListener('click', () => $('#pageFolderInput').click());
$('#homeChooseFolder')?.addEventListener('click', () => $('#pageFolderInput').click());
// 清空 value 才能再次选择同一批文件（否则 change 不会触发）。
// importFiles 会在第一个 await 之前把 FileList 复制成数组，所以这里先调用再清空是安全的。
$('#pageFileInput').addEventListener('change', event => {
  importFiles(event.target.files);
  event.target.value = '';
});
$('#pageFolderInput').addEventListener('change', event => {
  importFiles(event.target.files);
  event.target.value = '';
});
['dragenter','dragover'].forEach(type => $('#pageDropZone').addEventListener(type, event => {
  event.preventDefault();
  $('#pageDropZone').classList.add('drag');
}));
['dragleave','drop'].forEach(type => $('#pageDropZone').addEventListener(type, event => {
  event.preventDefault();
  $('#pageDropZone').classList.remove('drag');
}));
$('#pageDropZone').addEventListener('drop', async event => {
  const files = await filesFromDataTransfer(event.dataTransfer);
  importFiles(files);
});

$('#playlistForm').addEventListener('submit', event => {
  event.preventDefault();
  const name = $('#playlistName').value.trim();
  if (!name) return;
  const playlist = { id:`p${Date.now()}`, name, tracks:[] };
  // 来自「添加到歌单 → 新建歌单」时，顺手把待加入的歌曲放进新歌单
  const pending = pendingNewPlaylistIds.filter(id => getTrack(id));
  pendingNewPlaylistIds = [];
  pending.forEach(id => {
    if (!playlist.tracks.includes(id)) playlist.tracks.push(id);
  });
  state.playlists.push(playlist);
  state.pendingAddIds = [];
  state.pendingAddId = null;
  saveState();
  saveLibrary();
  renderPlaylists();
  renderCounts();
  $('#playlistName').value = '';
  $('#playlistModal').close();
  // 新建完直接把新歌单打开：刚建好就要往里加歌，停在列表上还得再点一下
  openPlaylistPage(playlist.id);
  showToast(pending.length
    ? `已创建歌单“${name}”并加入 ${pending.length} 首歌曲`
    : `已创建歌单“${name}”`);
});

// 取消弹窗时把待加入列表清掉，避免下一次「新建歌单」莫名其妙多出上次选中的歌
$('#addModal').addEventListener('close', () => {
  state.pendingAddIds = [];
  state.pendingAddId = null;
});
$('#playlistModal').addEventListener('close', () => {
  pendingNewPlaylistIds = [];
});

// ---------- 弹窗 / 托盘 相关监听 ----------
$('#editForm')?.addEventListener('submit', saveEditForm);
$('#editPickCover')?.addEventListener('click', pickEditCover);
$('#editResetCover')?.addEventListener('click', () => {
  editingCoverUrl = '';
  $('#editCoverPreview').src = DEFAULT_COVER;
});
$('#playlistEditForm')?.addEventListener('submit', savePlaylistEdit);
$('#playlistPickCover')?.addEventListener('click', async () => {
  const saved = await chooseCoverImage();
  if (!saved) return;
  editingPlaylistCover = saved;
  $('#playlistEditCover').src = saved;
});
$('#playlistResetCover')?.addEventListener('click', () => {
  editingPlaylistCover = '';
  $('#playlistEditCover').src = DEFAULT_COVER;
});
$('#dupeClean')?.addEventListener('click', cleanDuplicates);
$('#infoShowInFolder')?.addEventListener('click', () => {
  const track = getTrack(infoTrackId);
  if (!track?._path) {
    showToast('这首歌没有对应的磁盘文件');
    return;
  }
  window.orangeDesktop?.showInFolder?.(track._path);
});
$('#infoEdit')?.addEventListener('click', () => openEditModal(infoTrackId));
$('#infoImportLyrics')?.addEventListener('click', () => {
  // 歌词导入的目标是「信息弹窗里的那首歌」，不能顺手改 state.currentId：
  // 改了会让播放器的高亮 / 标题指向另一首歌，而 audio 还在放原来那首。
  state.lyricImportId = infoTrackId;
  $('#infoModal')?.close();
  $('#lyricsFileInput').click();
});
$('#infoPasteLyrics')?.addEventListener('click', () => {
  state.lyricImportId = infoTrackId;
  $('#infoModal')?.close();
  $('#lyricsModal').showModal();
});

window.orangeDesktop?.onTrayCommand?.(command => {
  if (command === 'play-pause') togglePlayback();
  else if (command === 'prev') previousTrack();
  else if (command === 'next') nextTrack();
});

// 桌面歌词窗口的播放控制命令（随机 / 上一曲 / 播放暂停 / 下一曲 / 循环）
window.orangeDesktop?.onDesktopLyricsCommand?.(action => {
  if (action === 'play-pause') togglePlayback();
  else if (action === 'prev') previousTrack();
  else if (action === 'next') nextTrack();
  else if (action === 'shuffle') toggleShuffleMode();
  else if (action === 'repeat') cycleRepeatMode();
});

$('#lyricsScroll').addEventListener('click', event => {
  const line = event.target.closest('[data-time]');
  if (line) {
    const target = Math.max(0, Number(line.dataset.time) - currentLyricOffset());
    // 还没装载音源时给 audio.currentTime 赋值会抛异常（歌词可能已经先读出来了），
    // 这时只负责开始播放，等用户下一次点击再精确跳转。
    if (audio.src) {
      audio.currentTime = target;
      if (audio.paused) togglePlayback();
    } else if (state.currentId) {
      togglePlayback();
    }
    resumeLyricsAutoScroll(true);
  }
});

// 右键歌词：按 0.25 秒微调歌词时间（按歌曲记忆）
$('.full-player')?.addEventListener('contextmenu', event => {
  event.preventDefault();
  if (!getLyrics(getTrack(state.currentId)).length) {
    showToast('这首歌还没有歌词');
    return;
  }
  openLyricMenu(event.clientX, event.clientY);
});

$('#lyricMenu')?.addEventListener('click', event => {
  event.stopPropagation();
  const adjust = event.target.closest('[data-lyric-adjust]');
  if (adjust) {
    applyLyricOffsetChange(Number(adjust.dataset.lyricAdjust));
    return;
  }
  const action = event.target.closest('[data-lyric-action]')?.dataset.lyricAction;
  // 方向分段先判断：它带 data-dir 时表示「直接切到这个方向」，
  // 没有 data-dir 时才当作来回切换（兼容旧写法）。
  const dirButton = event.target.closest('[data-lyric-dir]');
  if (dirButton) {
    if (dirButton.dataset.dir) setTiltDir(dirButton.dataset.lyricDir, dirButton.dataset.dir);
    else toggleTiltDir(dirButton.dataset.lyricDir);
    return;
  }
  const toggle = event.target.closest('[data-lyric-toggle]');
  if (toggle) {
    toggleEffectPref(toggle.dataset.lyricToggle);
    return;
  }
  if (action === 'reset') {
    const track = getTrack(state.currentId);
    if (track) {
      track._lyricOffset = null;
      saveLibrary();
      activeLineIndex = -1;
      updateLyricsActive(true);
      const label = $('#lyricMenuOffset');
      if (label) label.textContent = formatOffset(currentLyricOffset());
      showToast('已重置这首歌的歌词微调');
    }
    return;
  }
  if (action === 'apply-all') {
    state.prefs.lyricOffset = currentLyricOffset();
    state.songs.forEach(song => { song._lyricOffset = null; });
    savePrefs();
    saveLibrary();
    // 设置页滑杆 / 数值也要跟着走，否则界面显示的还是旧值
    const slider = $('#lyricOffset');
    if (slider) slider.value = String(state.prefs.lyricOffset);
    applyLyricStyle();
    activeLineIndex = -1;
    updateLyricsActive(true);
    showToast(`已把 ${formatOffset(state.prefs.lyricOffset)} 应用为所有歌曲的默认值`);
    return;
  }
  if (action === 'close') closeLyricMenu();
});

document.addEventListener('pointerdown', event => {
  if (!event.target.closest('#lyricMenu') && !event.target.closest('.full-player')) closeLyricMenu();
}, true);
// ⚠️ 歌词滚动就收起菜单 —— 但【只认手动滚动】。
// 歌曲播放中歌词是【自动滚动】的（每句滚一次，几秒就一次），原来的写法
// `addEventListener('scroll', closeLyricMenu)` 会让菜单「刚打开就自己关掉」，
// 用户根本来不及点。pauseLyricsAutoScroll 里的 lyricsManualScroll 正好能区分：
// 手动滚动（wheel / touchmove / pointerdown）会把它置 true 并保持 9 秒。
$('#lyricsScroll')?.addEventListener('scroll', () => {
  if (lyricsManualScroll) closeLyricMenu();
});

// 手动滚动时暂停自动跟随，9 秒后或点「回到当前」恢复
['wheel', 'touchmove'].forEach(type => $('#lyricsScroll').addEventListener(type, pauseLyricsAutoScroll, { passive: true }));
$('#lyricsScroll').addEventListener('pointerdown', pauseLyricsAutoScroll);
$('#lyricsBackCurrent')?.addEventListener('click', () => resumeLyricsAutoScroll(true));
setInterval(karaokeTick, 80);

$('#importLyricsButton')?.addEventListener('click', () => $('#lyricsFileInput').click());
$('#reloadLyricsButton')?.addEventListener('click', async () => {
  const track = getTrack(state.currentId);
  if (!track) {
    showToast('还没有正在播放的歌曲');
    return;
  }
  track._lyrics = [];
  track._lyricChecked = true;
  track._lyricSource = '';
  showToast('正在重新读取歌词…');
  const lines = await loadTrackLyrics(track);
  renderLyrics();
  pushDesktopLyricsState();
  showToast(lines.length
    ? (track._lyricSource === 'embedded' ? `已从文件内读取到 ${lines.length} 行歌词` : `已从同名歌词文件读取到 ${lines.length} 行歌词`)
    : '这首歌里没有找到歌词文件或内嵌歌词');
});
// 手动导入 / 粘贴的歌词统一走这里：写进歌曲对象、落库、必要时刷新当前歌词界面。
// 原来这两条路径只改内存，连 saveLibrary 都没调用，重启后手动歌词必然丢失。
function applyManualLyrics(track, text) {
  if (!track) return false;
  const value = String(text || '').slice(0, 200000);
  if (!value.trim()) return false;
  track._lyrics = parseLyrics(value);
  track._lyricManual = true;
  track._lyricText = value;
  track._lyricSource = 'manual';
  track._lyricChecked = true;
  track._lyricPath = '';
  saveLibrary();
  if (state.currentId === track.id) renderLyrics();
  return true;
}

$('#lyricsFileInput').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = ''; // 允许再次选择同一个文件
  if (!file) return;
  const track = getTrack(state.lyricImportId || state.currentId);
  state.lyricImportId = null;
  if (!track) {
    showToast('没有可以导入歌词的歌曲');
    return;
  }
  try {
    // 用 decodeTextBuffer 而不是 file.text()：后者只按 UTF-8 解码，
    // 中文用户手里大量 GBK / UTF-16 的 .lrc 会直接变成乱码。
    const text = decodeTextBuffer(await file.arrayBuffer());
    if (!applyManualLyrics(track, text)) {
      showToast('这个歌词文件是空的');
      return;
    }
    showToast(`已为「${track.title}」导入歌词：${file.name}`);
  } catch (error) {
    console.warn(error);
    showToast('读取歌词文件失败');
  }
});
$('#pasteLyricsButton')?.addEventListener('click', () => $('#lyricsModal').showModal());
$('#lyricsForm').addEventListener('submit', event => {
  event.preventDefault();
  const text = $('#lyricsInput').value.trim();
  if (!text) return;
  const track = getTrack(state.lyricImportId || state.currentId);
  state.lyricImportId = null;
  if (!track) {
    showToast('没有可以保存歌词的歌曲');
    return;
  }
  applyManualLyrics(track, text);
  $('#lyricsModal').close();
  $('#lyricsInput').value = '';
  showToast(`歌词已保存到「${track.title}」`);
});

// ============================ 新增功能：外观 / 歌词 / 详情 / 编辑 / 查重 / 歌单 / 自动扫描 ============================

// 播放 / 歌词 / 界面 / 托盘 / 自动扫描 / 快捷键 等新增设置的绑定
function bindSettingsControls() {
  const rate = $('#playbackRate');
  if (rate) {
    rate.value = String(state.prefs.playbackRate ?? 1);
    rate.addEventListener('change', () => {
      state.prefs.playbackRate = Number(rate.value);
      applyPlaybackRate();
      savePrefs();
      showToast(`播放速度 ${state.prefs.playbackRate}×`);
    });
  }

  bindRange('#fadeMs', 'fadeMs', value => `${value} ms`, () => savePrefs(), { number: true });
  bindRange('#lyricOffset', 'lyricOffset', value => (value === 0 ? '0 秒' : `${value > 0 ? '+' : ''}${Number(value).toFixed(1)} 秒`), () => {
    // 拖动设置里的滑杆 = 改全局默认，同时清掉当前歌曲的单独微调，保证立刻能看到变化
    const track = getTrack(state.currentId);
    if (track) track._lyricOffset = null;
    activeLineIndex = -1;
    applyLyricStyle();
    updateLyricsActive(true);
    savePrefs();
    saveLibrary();
  }, { number: true });
  bindRange('#lyricBlur', 'lyricBlur', value => `${value} px`, () => {
    applyLyricStyle();
    savePrefs();
  }, { number: true });

  const sleep = $('#sleepTimer');
  if (sleep) {
    sleep.value = String(state.prefs.sleepTimer ?? 0);
    sleep.addEventListener('change', () => {
      state.prefs.sleepTimer = Number(sleep.value);
      savePrefs();
      applySleepTimer(state.prefs.sleepTimer);
    });
  }

  bindSwitch('#replayGainToggle', 'replayGain', () => applyReplayGain(getTrack(state.currentId)));
  bindSwitch('#eqToggle', 'eqEnabled', () => { applyEq(); syncEqHeadphoneHint(); });
  bindSwitch('#autoScanToggle', 'autoScanOnStart');
  bindSwitch('#minimizeToTrayToggle', 'minimizeToTray', syncWindowBehavior);
  bindSwitch('#closeToTrayToggle', 'closeToTray', syncWindowBehavior);
  bindSwitch('#autoStartToggle', 'autoStart', syncWindowBehavior);

  const density = $('#listDensity');
  if (density) {
    density.value = state.prefs.listDensity || 'normal';
    density.addEventListener('change', () => {
      state.prefs.listDensity = density.value;
      applyListDensity();
      savePrefs();
    });
  }

  const lyricTheme = $('#lyricTheme');
  if (lyricTheme) {
    lyricTheme.value = state.prefs.lyricTheme || 'cover';
    lyricTheme.addEventListener('change', () => {
      state.prefs.lyricTheme = lyricTheme.value;
      applyLyricStyle();
      applyLyricTheme();
      savePrefs();
    });
  }

  const preset = $('#eqPreset');
  if (preset) {
    // 先把「我的预设」那组选项铺好，再设 value：
    // 顺序反过来的话，value 会被设成一个还不存在的 custom:<id>，下拉回落成第一项
    renderEqPresetOptions();
    preset.value = currentEqPresetValue();
    preset.addEventListener('change', () => {
      const value = preset.value;
      state.prefs.eqPreset = value;
      // 主动选了预设 = 放弃耳机校正曲线，按钮跟着回到「未校正」
      state.prefs.eqHeadphone = '';
      state.prefs.eqPreamp = 0;
      syncEqHeadphoneTrigger();
      //「自定义」取用户存档，「custom:<id>」取命名预设，其余取内置预设表
      const custom = customPresetByValue(value);
      state.prefs.eqGains = custom
        ? EQ_BANDS.map((_, index) => roundToStep(custom.gains[index] || 0))
        : value === 'custom'
          ? normalizedCustomEq()
          : [...(EQ_PRESETS[value] || EQ_PRESETS.flat)];
      if (custom) state.prefs.eqPreamp = Number(custom.preamp) || 0;
      applyEq();
      renderEqSliders();
      syncEqHeadphoneHint();
      syncEqPresetButtons();
      savePrefs();
    });
  }
  $$('.eq-slider').forEach(slider => {
    slider.addEventListener('input', () => {
      const gains = normalizedEqGains();
      const value = Number(slider.value);
      gains[Number(slider.dataset.band)] = value;
      state.prefs.eqGains = gains;
      state.prefs.eqEnabled = true;
      // 手动拖过就不等于任何内置预设了 —— 下拉切到「自定义」，
      // 免得出现"显示着『摇滚』、实际却不是摇滚那条曲线"的错位。
      if (state.prefs.eqPreset !== 'custom') {
        state.prefs.eqPreset = 'custom';
        if (preset) preset.value = 'custom';
      }
      const toggle = $('#eqToggle');
      if (toggle) toggle.checked = true;
      syncEqBandValue(slider, value);
      applyEq();
      // 拖过滑块后 hint 要变成「已在曲线上手动微调」，不然会以为还是原厂曲线
      syncEqHeadphoneHint();
      savePrefs();
    });
  });
  initEqPresets();
  initOutputDevice();
  initEqHeadphone();
  renderEqSliders();
  $('#addWatchFolder')?.addEventListener('click', addWatchFolder);
  renderWatchList();
  initShortcutRebinding();
  applyLyricStyle();
  applyListDensity();
  applyTiltEffect();
  applyAmbientLight();
  applyLyricTranslation();
  syncWindowBehavior();
}

function bindRange(selector, key, format, onChange, options = {}) {
  const input = $(selector);
  if (!input) return;
  const output = $(`${selector}Value`);
  const sync = () => {
    const raw = Number(input.value);
    if (options.number) state.prefs[key] = raw;
    if (output) output.textContent = format(raw);
    if (typeof onChange === 'function') onChange(raw);
  };
  input.value = state.prefs[key] ?? input.value;
  if (output) output.textContent = format(Number(input.value));
  input.addEventListener('input', sync);
}

/** 把滑块当前值写到它上方的 <output>；非 0 时加 is-active 标红，一眼看出哪些频段调过 */
function syncEqBandValue(slider, value) {
  const number = Number(value) || 0;
  // 轨道填充跟着实际增益走：从中线（0 dB）向上/向下生长。
  // 只靠 CSS 静态渐变的话，0 dB 也是满上半截红，看着像十段全推满了。
  const min = Number(slider.min) || -12;
  const max = Number(slider.max) || 12;
  const span = max - min;
  if (span > 0) {
    const ratio = (number - min) / span;        // 0=最低 1=最高
    const center = (0 - min) / span;            // 0 dB 在轨道上的位置
    const up = number > 0 ? (ratio - center) * 100 : 0;
    const down = number < 0 ? (center - ratio) * 100 : 0;
    slider.style.setProperty('--eq-up', `${up.toFixed(3)}%`);
    slider.style.setProperty('--eq-down', `${down.toFixed(3)}%`);
  }
  const output = slider.closest('.eq-band')?.querySelector('.eq-value');
  if (!output) return;
  output.textContent = formatEqDb(number);
  output.classList.toggle('is-active', number !== 0);
}

function renderEqSliders() {
  const gains = normalizedEqGains();
  $$('.eq-slider').forEach(slider => {
    const value = gains[Number(slider.dataset.band)] || 0;
    slider.value = String(value);
    slider.title = `${value > 0 ? '+' : ''}${value} dB`;
    syncEqBandValue(slider, value);
  });
}

/* --------------------------- 均衡预设：我的预设 --------------------------- */

const EQ_PRESET_LABELS = {
  flat: '原声', pop: '流行', rock: '摇滚', classical: '古典', vocal: '人声',
  bass: '低音增强', treble: '高音增强', jazz: '爵士', electronic: '电子', custom: '自定义'
};

function eqCustomPresets() {
  return Array.isArray(state.prefs.eqPresets)
    ? state.prefs.eqPresets.filter(item => item && item.id && item.name && Array.isArray(item.gains))
    : [];
}

/** 下拉里「我的预设」用 custom:<id> 表示，和内置预设的裸 key 区分开 */
function customPresetByValue(value) {
  const text = String(value || '');
  if (!text.startsWith('custom:')) return null;
  return eqCustomPresets().find(item => item.id === text.slice(7)) || null;
}

/** 当前选中的预设值（找不到对应自定义项时退回内置的「自定义」） */
function currentEqPresetValue() {
  const value = String(state.prefs.eqPreset || 'flat');
  if (value.startsWith('custom:')) return customPresetByValue(value) ? value : 'custom';
  return EQ_PRESETS[value] ? value : 'flat';
}

function renderEqPresetOptions() {
  const select = $('#eqPreset');
  if (!select) return;
  // 重建 optgroup 会把当前选中的 option 一起换掉，浏览器随即把选中项重置成第一项。
  // 先记下来，铺完选项再按原值恢复。
  const previous = select.value;
  const items = eqCustomPresets();
  let group = $('#eqPresetMine');
  // 一条自定义都没有时整组移除：空 optgroup 会留下一个孤零零的分组标题
  if (!items.length) {
    group?.remove();
    return;
  }
  if (!group) {
    group = document.createElement('optgroup');
    group.id = 'eqPresetMine';
    group.label = '我的预设';
    select.appendChild(group);
  }
  group.innerHTML = items
    .map(item => `<option value="custom:${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`)
    .join('');
  if (previous && [...select.options].some(option => option.value === previous)) {
    select.value = previous;
  }
}

function syncEqPresetButtons() {
  const remove = $('#eqDeletePreset');
  if (remove) remove.hidden = !customPresetByValue(currentEqPresetValue());
}

function applyEqPresetGains(gains, preamp) {
  state.prefs.eqGains = EQ_BANDS.map((_, index) => roundToStep(gains[index] || 0));
  state.prefs.eqPreamp = Number(preamp) || 0;
  state.prefs.eqEnabled = true;
  const toggle = $('#eqToggle');
  if (toggle) toggle.checked = true;
  applyEq();
  renderEqSliders();
  syncEqHeadphoneHint();
  savePrefs();
}

/** 把当前曲线存成一个命名预设；同名视为覆盖 */
async function saveEqPresetFlow() {
  const value = currentEqPresetValue();
  const current = customPresetByValue(value);
  const name = await askText({
    title: '保存均衡预设',
    hint: '给这套曲线起个名字，之后可以从「预设」下拉里选回',
    value: current?.name || ''
  });
  if (!name) return;
  const gains = normalizedEqGains().map(roundToStep);
  const list = eqCustomPresets().slice();
  const same = list.find(item => item.name.toLowerCase() === name.toLowerCase());
  const id = same?.id || `eqp${Date.now().toString(36)}`;
  const entry = { id, name, gains, preamp: Number(state.prefs.eqPreamp) || 0, savedAt: Date.now() };
  if (same) list[list.indexOf(same)] = entry;
  else list.push(entry);
  state.prefs.eqPresets = list;
  state.prefs.eqPreset = `custom:${id}`;
  // 旧的「自定义存档」也同步一份，老版本读到的仍是同一套曲线
  state.prefs.eqCustom = [...gains];
  renderEqPresetOptions();
  const select = $('#eqPreset');
  if (select) select.value = `custom:${id}`;
  syncEqPresetButtons();
  savePrefs();
  showToast(same ? `已更新预设「${name}」` : `已保存预设「${name}」`);
}

async function exportEqPresetFlow() {
  const desktop = window.orangeDesktop;
  if (!desktop?.saveEqPreset) {
    showToast('当前环境不支持导出');
    return;
  }
  const value = currentEqPresetValue();
  const current = customPresetByValue(value);
  const name = current?.name || EQ_PRESET_LABELS[value] || '自定义';
  const gains = normalizedEqGains().map(roundToStep);
  const payload = {
    app: 'Orange Music',
    type: 'eq-preset',
    version: 1,
    name,
    preamp: Number(state.prefs.eqPreamp) || 0,
    // gains 是 31Hz ~ 16kHz 十段；bands 带上频率，别的工具导入时不至于靠猜
    bands: EQ_BANDS.map((hz, index) => ({ hz, gain: gains[index] })),
    gains,
    headphones: findAutoEqModel(state.prefs.eqHeadphone)?.name || ''
  };
  const saved = await desktop.saveEqPreset({ name, content: JSON.stringify(payload, null, 2) }).catch(() => null);
  showToast(saved ? '预设已导出' : '已取消导出');
}

/**
 * 解析导入文件。三种来源：
 *   1. 本播放器导出的 JSON
 *   2. EqualizerAPO 的 Filter 行（Filter: ON PK Fc 105 Hz Gain -7.33 dB Q 0.7）
 *   3. EqualizerAPO 的 GraphicEQ 行（GraphicEQ: 31 4.5; 62 3.2; ...）
 * 后两种按「对数频率最近」映射到十段，和 AutoEq 的 FixedBandEQ 是同一套算法口径。
 */
function parseEqPresetText(text, fallbackName) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      const data = JSON.parse(raw);
      const source = Array.isArray(data) ? data : (Array.isArray(data?.gains) ? data.gains : null);
      if (!source) return null;
      return {
        name: String(data?.name || fallbackName || '导入的预设').slice(0, 30),
        gains: EQ_BANDS.map((_, index) => roundToStep(Number(source[index]) || 0)),
        preamp: Number(data?.preamp) || 0
      };
    } catch {
      return null;
    }
  }
  const lines = raw.split(/\r?\n/);
  let preamp = 0;
  const summed = EQ_BANDS.map(() => 0);
  const filled = EQ_BANDS.map(() => 0);
  let hits = 0;
  const bandIndexFor = hz => {
    const target = Math.log(Math.max(20, Number(hz) || 1000));
    let best = 0;
    let bestDiff = Infinity;
    EQ_BANDS.forEach((freq, index) => {
      const diff = Math.abs(Math.log(freq) - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = index;
      }
    });
    return best;
  };
  for (const line of lines) {
    const pre = line.match(/^\s*Preamp:\s*(-?[\d.]+)\s*dB/i);
    if (pre) preamp = Number(pre[1]) || 0;
    const filter = line.match(/Filter:\s*ON\s+\w+\s+Fc\s+([\d.]+)\s*Hz[^G]*Gain\s+(-?[\d.]+)\s*dB/i);
    if (filter) {
      const index = bandIndexFor(filter[1]);
      summed[index] += Number(filter[2]) || 0;
      filled[index] += 1;
      hits += 1;
      continue;
    }
    const graphic = line.match(/GraphicEQ:\s*(.+)$/i);
    if (graphic) {
      for (const pair of graphic[1].split(';')) {
        const [hz, gain] = pair.trim().split(/\s+/);
        if (!hz || gain === undefined) continue;
        const index = bandIndexFor(hz);
        summed[index] += Number(gain) || 0;
        filled[index] += 1;
        hits += 1;
      }
    }
  }
  if (!hits) return null;
  return {
    name: String(fallbackName || '导入的预设').slice(0, 30),
    // 多个滤波器落到同一段时取平均，避免 8 段全叠到 16k 上变成 +30dB
    gains: summed.map((sum, index) => roundToStep(filled[index] ? sum / filled[index] : 0)),
    preamp
  };
}

async function importEqPresetFlow() {
  const desktop = window.orangeDesktop;
  if (!desktop?.openEqPreset) {
    showToast('当前环境不支持导入');
    return;
  }
  const file = await desktop.openEqPreset().catch(() => null);
  if (!file) return;
  const parsed = parseEqPresetText(file.text, file.name);
  if (!parsed) {
    showToast('这个文件里没有可识别的均衡参数');
    return;
  }
  const id = `eqp${Date.now().toString(36)}`;
  const list = eqCustomPresets().slice();
  list.push({ id, name: parsed.name, gains: parsed.gains, preamp: parsed.preamp, savedAt: Date.now() });
  state.prefs.eqPresets = list;
  state.prefs.eqPreset = `custom:${id}`;
  renderEqPresetOptions();
  const select = $('#eqPreset');
  if (select) select.value = `custom:${id}`;
  applyEqPresetGains(parsed.gains, parsed.preamp);
  syncEqPresetButtons();
  showToast(`已导入预设「${parsed.name}」`);
}

function deleteEqPresetFlow() {
  const value = currentEqPresetValue();
  const current = customPresetByValue(value);
  if (!current) return;
  if (!window.confirm(`删除预设「${current.name}」？当前十段增益不会被重置。`)) return;
  state.prefs.eqPresets = eqCustomPresets().filter(item => item.id !== current.id);
  state.prefs.eqPreset = 'custom';
  state.prefs.eqCustom = normalizedEqGains();
  const select = $('#eqPreset');
  renderEqPresetOptions();
  if (select) select.value = 'custom';
  syncEqPresetButtons();
  savePrefs();
  showToast(`已删除预设「${current.name}」`);
}

/**
 * 「我的预设」相关按钮：保存 / 导入 / 导出 / 删除。
 * 以前这里只有一个「保存当前设置」，存下来的曲线没法命名、也没法带走。
 */
function initEqPresets() {
  renderEqPresetOptions();
  syncEqPresetButtons();
  $('#eqSaveCustom')?.addEventListener('click', () => { saveEqPresetFlow(); });
  $('#eqImportPreset')?.addEventListener('click', () => { importEqPresetFlow(); });
  $('#eqExportPreset')?.addEventListener('click', () => { exportEqPresetFlow(); });
  $('#eqDeletePreset')?.addEventListener('click', () => { deleteEqPresetFlow(); });
}

// ---------- 歌词时间微调（右键菜单，按歌曲记忆） ----------
function lyricOffsetFor(track) {
  const value = Number(track?._lyricOffset);
  if (track && track._lyricOffset !== null && track._lyricOffset !== undefined && Number.isFinite(value)) return value;
  return Number(state.prefs.lyricOffset) || 0;
}

function currentLyricOffset() {
  return lyricOffsetFor(getTrack(state.currentId));
}

function formatOffset(value) {
  const number = Number(value) || 0;
  return `${number > 0 ? '+' : ''}${number.toFixed(2)} 秒`;
}

// ============================================================
// 桌面歌词悬浮窗
// 独立于主窗口的透明置顶窗口，Apple Music 风格。主窗口在这里把
// 播放状态（时间 / 歌词 / 标题 / 封面）与外观配置实时推给它。
// ============================================================

let desktopLyricsOpen = false;

/** 组装当前外观配置并推给桌面歌词窗口 */
function pushDesktopLyricsConfig() {
  if (!window.orangeDesktop?.sendDesktopLyricsConfig) return;
  const p = state.prefs;
  window.orangeDesktop.sendDesktopLyricsConfig({
    blur: Number(p.dlBlur) ?? 28,
    opacity: (Number(p.dlOpacity) ?? 35) / 100,
    fontSize: Number(p.dlFontSize) ?? 34,
    textColor: p.dlTextColor || '#ffffff',
    textDepth: Number(p.dlTextDepth) ?? 100,
    accentColor: p.dlAccentColor || '#e84b3c',
    bgColor: p.dlBgColor || '',
    align: p.dlAlign || 'center',
    radius: Number(p.dlRadius) ?? 18,
    showMeta: p.dlShowMeta !== false,
    showBg: true,
    offset: currentLyricOffset(),
    locked: p.dlLocked === true
  });
}

/**
 * 组装播放状态并推给桌面歌词窗口。
 * 由 updateProgress（timeupdate 约每秒 4 次）驱动，足够歌词逐字点亮。
 * 歌词数组每次都带：之前按引用去重会导致「主进程缓存的最新状态不含 lyrics 字段」，
 * 歌词窗打开时回拉到的就是空歌词（表现为首次打开不显示、切歌才出现）。歌词几百行文本
 * 每秒 4 次 IPC 开销可忽略，正确性优先。
 */
// 上一次推送的歌词指纹：timeupdate 每秒约 4 次，歌词只在换歌/内容变化时才需要
// 跨进程结构化克隆一遍整个数组（窗口没开时更是纯浪费）。其余字段照常推。
let lastPushedLyricsKey = '';

function pushDesktopLyricsState() {
  // 不检查 desktopLyricsOpen：窗口可能由托盘直接打开，此时主窗口的
  // desktopLyricsOpen 标志还没同步，检查会漏掉推送导致「不显示歌词」。
  // 主进程在窗口未打开时会直接丢弃消息，开销可忽略。
  if (!window.orangeDesktop?.sendDesktopLyricsState) return;
  const track = getTrack(state.currentId);
  const lyrics = track ? getLyrics(track) : [];
  const payload = {
    // 带上曲目 id：歌词窗据此判断「换歌了」，切到无歌词的歌时不会继续显示上一首
    id: track ? track.id : '',
    playing: state.playing,
    time: audio.currentTime || 0,
    title: track ? track.title : '',
    artist: track ? track.artist : '',
    shuffle: Boolean(state.shuffle),
    repeat: Number(state.repeat) || 0
  };
  // 指纹和桌面歌词窗口那边的判断口径保持一致：曲目 + 行数 + 首尾时间
  const key = track
    ? `${track.id}|${lyrics.length}|${lyrics[0] ? lyrics[0].time : ''}|${lyrics.length ? lyrics[lyrics.length - 1].time : ''}`
    : '';
  if (key !== lastPushedLyricsKey) {
    lastPushedLyricsKey = key;
    payload.lyrics = lyrics;
  }
  window.orangeDesktop.sendDesktopLyricsState(payload);
}

/** 切换桌面歌词窗口的显示状态，返回是否已打开 */
/** 桌面歌词开着的时候按钮要亮起来：原来只有开 / 关两个动作，按钮永远是灰的，
    用户没法知道现在到底开没开（也可能在任务栏里找半天那块浮窗）。 */
function syncDesktopLyricsButton() {
  const button = $('#desktopLyricsButton');
  if (!button) return;
  button.classList.toggle('active', desktopLyricsOpen);
  button.setAttribute('aria-pressed', desktopLyricsOpen ? 'true' : 'false');
  button.title = desktopLyricsOpen ? '关闭桌面歌词' : '桌面歌词（置顶悬浮窗）';
}

async function toggleDesktopLyrics(open) {
  if (!window.orangeDesktop?.toggleDesktopLyrics) {
    showToast('当前环境不支持桌面歌词');
    return false;
  }
  const target = open !== undefined ? open : !desktopLyricsOpen;
  desktopLyricsOpen = await window.orangeDesktop.toggleDesktopLyrics(target);
  syncDesktopLyricsButton();
  if (desktopLyricsOpen) {
    // 窗口刚创建，先下发一次配置，再推一次当前状态
    pushDesktopLyricsConfig();
    // 歌词可能还没加载（刚启动就开歌词窗的场景），主动补一次加载，加载完会自动推状态
    const track = getTrack(state.currentId);
    if (track && track._path && !getLyrics(track).length && !track._lyricChecked) {
      track._lyricChecked = true;
      loadTrackLyrics(track).then(() => pushDesktopLyricsState());
    } else {
      pushDesktopLyricsState();
    }
  }
  return desktopLyricsOpen;
}

/* ==========================================================================
   迷你播放器小窗
   —— 主窗口只做两件事：定时把状态推过去，把那边点出来的操作翻译成本地调用。
   ========================================================================== */
let miniPlayerOpen = false;
let miniStateTimer = 0;

/** 小窗要的那点信息，字段尽量短：200ms 一次，别整对象往外扔 */
function miniStateSnapshot() {
  const track = getTrack(state.currentId);
  const duration = Number(audio.duration) || Number(track?.duration) || 0;
  const time = Number(audio.currentTime) || 0;
  const active = resolveActiveLyric();
  return {
    title: track?.title || '',
    artist: track?.artist || '',
    cover: track ? hiResCover(track.cover) : '',
    lyric: active ? (active.lyrics[active.active]?.text || '') : '',
    playing: !audio.paused && !audio.ended,
    progress: duration > 0 ? Math.round((time / duration) * 1000) : 0,
    time,
    duration
  };
}

function pushMiniState() {
  if (!miniPlayerOpen) return;
  window.orangeDesktop?.pushMiniState?.(miniStateSnapshot());
}

function startMiniHeartbeat() {
  stopMiniHeartbeat();
  // 200ms 够跟手，又不会让 IPC 忙起来（timeupdate 本身约 250ms 一次）
  miniStateTimer = setInterval(pushMiniState, 200);
}

function stopMiniHeartbeat() {
  if (miniStateTimer) clearInterval(miniStateTimer);
  miniStateTimer = 0;
}

function syncMiniButton(open) {
  miniPlayerOpen = Boolean(open);
  const button = $('#miniPlayerButton');
  if (!button) return;
  button.classList.toggle('active', miniPlayerOpen);
  button.setAttribute('aria-pressed', String(miniPlayerOpen));
  button.title = miniPlayerOpen ? '关闭迷你播放器' : '迷你播放器（桌面小窗）';
}

async function toggleMiniWindow(open) {
  if (!window.orangeDesktop?.toggleMiniPlayer) {
    showToast('当前环境不支持迷你播放器');
    return false;
  }
  const target = open !== undefined ? open : !miniPlayerOpen;
  const nowOpen = await window.orangeDesktop.toggleMiniPlayer(target);
  syncMiniButton(nowOpen);
  if (nowOpen) {
    pushMiniState();
    startMiniHeartbeat();
  } else {
    stopMiniHeartbeat();
  }
  return nowOpen;
}

function seekToRatio(ratio) {
  const duration = Number(audio.duration);
  if (!Number.isFinite(duration) || duration <= 0) return;
  const value = Math.max(0, Math.min(1, Number(ratio) || 0));
  audio.currentTime = value * duration;
  updateProgress();
  pushMiniState();
}

// 小窗关闭（自己点的 ✕、或者跟着主窗口一起销毁）时把心跳停掉
window.orangeDesktop?.onMiniClosed?.(() => {
  syncMiniButton(false);
  stopMiniHeartbeat();
});

window.orangeDesktop?.onMiniCommand?.(command => {
  if (!command) return;
  if (command === 'toggle') togglePlayback();
  else if (command === 'prev') previousTrack();
  else if (command === 'next') nextTrack();
  else if (typeof command === 'object' && command.type === 'seek') seekToRatio(command.value);
});

function openLyricMenu(x, y) {
  const menu = $('#lyricMenu');
  if (!menu) return;
  const label = $('#lyricMenuOffset');
  if (label) label.textContent = formatOffset(currentLyricOffset());
  menu.hidden = false;
  // 打开菜单时同步一次倾斜开关 / 方向的状态，避免之前在设置页改过这里显示旧值
  applyTiltEffect();
  // 同理：动态强度滑块也拉一遍，免得在设置页调过之后这里还停在旧位置
  syncAmbientPowerUI();
  const width = menu.offsetWidth || 240;
  const height = menu.offsetHeight || 200;
  menu.style.left = `${Math.max(10, Math.min(x, window.innerWidth - width - 12))}px`;
  menu.style.top = `${Math.max(10, Math.min(y, window.innerHeight - height - 12))}px`;
}

function closeLyricMenu() {
  const menu = $('#lyricMenu');
  if (menu) menu.hidden = true;
}

function applyLyricOffsetChange(delta) {
  const track = getTrack(state.currentId);
  if (!track) {
    showToast('还没有正在播放的歌曲');
    return;
  }
  const base = lyricOffsetFor(track) + delta;
  track._lyricOffset = Math.max(-20, Math.min(20, Math.round(base * 100) / 100));
  saveLibrary();
  const label = $('#lyricMenuOffset');
  if (label) label.textContent = formatOffset(track._lyricOffset);
  // 立刻重新计算当前句并滚动到位
  activeLineIndex = -1;
  updateLyricsActive(true);
  showToast(`歌词${delta > 0 ? '提前' : '延后'} 0.25 秒（当前 ${formatOffset(track._lyricOffset)}）`);
}

function applyLyricStyle() {
  const player = $('#fullPlayer');
  if (player) {
    player.style.setProperty('--lyric-blur', `${Number(state.prefs.lyricBlur) || 0}px`);
  }
  document.body.classList.toggle('lyric-light', state.prefs.lyricTheme === 'light');
  $('.full-player')?.classList.toggle('lyric-forced', state.prefs.lyricTheme !== 'cover');
  const offset = currentLyricOffset();
  const label = $('#lyricOffsetValue');
  if (label) label.textContent = offset === 0 ? '0 秒' : `${offset > 0 ? '+' : ''}${offset.toFixed(1)} 秒`;
  const blurLabel = $('#lyricBlurValue');
  if (blurLabel) blurLabel.textContent = `${Number(state.prefs.lyricBlur) || 0} px`;
}

// ---------- 封面主色采样（给歌词倾斜的辉光上色） ----------
// 记录当前已经算过主色的封面地址，同一张封面不重复解码。
let coverAccentUrl = '';

// file:// URL -> 本地路径。Windows 下 pathname 会多一个前导斜杠（/D:/x），要去掉。
function fileUrlToPath(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') return '';
    let value = decodeURIComponent(parsed.pathname);
    if (/^\/[a-zA-Z]:/.test(value)) value = value.slice(1);
    return value;
  } catch (error) {
    return '';
  }
}

function loadImage(src) {
  return new Promise(resolve => {
    const image = new Image();
    // 在线封面同样是跨域资源：不声明 crossOrigin 会把 canvas 画脏，getImageData 直接抛错
    if (/^https?:/i.test(src)) image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

// 取「主色」而不是平均值：平均值会把封面上的所有颜色混成灰褐色，用起来永远是灰的。
// 这里按色相分 12 桶投票，只有「够亮 + 够彩」的像素参与，权重是 饱和度 × 明度，
// 所以大面积灰底、黑边、白字都不会把结果带偏。
function dominantColor(pixels) {
  const BUCKETS = 12;
  const sums = Array.from({ length: BUCKETS }, () => ({ r: 0, g: 0, b: 0, w: 0 }));
  let fr = 0, fg = 0, fb = 0, fn = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], a = pixels[i + 3];
    if (a < 24) continue;
    fr += r; fg += g; fb += b; fn += 1;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    const value = max / 255;
    const saturation = max ? delta / max : 0;
    if (value < 0.18 || saturation < 0.18) continue;
    let hue = 0;
    if (delta) {
      if (max === r) hue = 60 * (((g - b) / delta) % 6);
      else if (max === g) hue = 60 * ((b - r) / delta + 2);
      else hue = 60 * ((r - g) / delta + 4);
    }
    if (hue < 0) hue += 360;
    const bucket = sums[Math.min(BUCKETS - 1, Math.floor((hue / 360) * BUCKETS))];
    const weight = saturation * value;
    bucket.r += r * weight;
    bucket.g += g * weight;
    bucket.b += b * weight;
    bucket.w += weight;
  }
  let best = null;
  for (const bucket of sums) {
    if (bucket.w > 0 && (!best || bucket.w > best.w)) best = bucket;
  }
  if (best) {
    return [Math.round(best.r / best.w), Math.round(best.g / best.w), Math.round(best.b / best.w)];
  }
  // 整张封面都是灰阶时退回平均值（此时平均色本来就是它该有的灰）
  if (fn) return [Math.round(fr / fn), Math.round(fg / fn), Math.round(fb / fn)];
  return null;
}

async function sampleDominantColor(url) {
  if (!url) return null;
  try {
    let source = url;
    const desktop = window.orangeDesktop;
    // file:// 的图直接画进 canvas 会污染画布，getImageData 必然抛错。
    // 先让主进程解码成 32px 的 data: URL 再取像素。
    if (desktop?.coverThumbnail && /^file:/i.test(url)) {
      const target = fileUrlToPath(url);
      const thumb = target ? await desktop.coverThumbnail(target).catch(() => null) : null;
      if (thumb) source = thumb;
    }
    const image = await loadImage(source);
    if (!image || !image.naturalWidth) return null;
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, 32, 32);
    return dominantColor(context.getImageData(0, 0, 32, 32).data);
  } catch (error) {
    // 取不到色就让 CSS 退回主题强调色，不影响显示
    return null;
  }
}

// 主色直接拿去发光往往偏暗（封面以人物照居多，提取出来多是暗棕 / 灰调），
// 压在深色歌词界面上亮不起来。这里统一把明度提到 0.62、饱和度至少 0.55，
// 保证换任何一张封面，辉光都是「醒得来但不过曝」的颜色。
function glowColor(rgb) {
  const [r, g, b] = rgb.map(value => value / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  let hue = 0;
  let saturation = 0;
  if (delta) {
    saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    if (max === r) hue = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
    else if (max === g) hue = ((b - r) / delta + 2) / 6;
    else hue = ((r - g) / delta + 4) / 6;
  }
  const h = Math.round(hue * 360);
  const s = Math.round(Math.max(saturation, 0.55) * 100);
  const l = Math.round(Math.max(lightness, 0.62) * 100);
  return `hsl(${h} ${s}% ${l}%)`;
}

// 把封面主色写进 --cover-accent，歌词辉光会优先用它
let coverAccentRgb = null;
let coverAccentPromise = null;

/** 相对路径（assets/...）转绝对 URL，让 track.cover 与 img.src 能命中同一份采样缓存 */
function absoluteCoverUrl(cover) {
  const value = String(cover || '');
  if (!value || /^(?:data|https?|file):/i.test(value)) return value;
  try {
    return new URL(value, window.location.href).href;
  } catch (error) {
    return value;
  }
}

async function applyCoverAccent(cover) {
  // 默认占位封面是品牌橙图标：拿它采样会把整个播放页染成一片土黄，
  // 而且它不含任何专辑信息。占位图直接跳过，回到默认氛围色。
  const url = (!cover || cover === DEFAULT_COVER) ? '' : absoluteCoverUrl(cover);
  const nodes = [$('#fullPlayer'), document.body, document.documentElement].filter(Boolean);
  if (!url) {
    coverAccentUrl = '';
    coverAccentRgb = null;
    coverAccentPromise = null;
    nodes.forEach(node => node.style.removeProperty('--cover-accent'));
    return null;
  }
  // 命中同一张封面时返回「同一个采样 Promise」，而不是立刻返回 null。
  // 否则 updatePlayerUi 里先后两次调用（主色 + 歌词背景）时，第二次会在采样完成前
  // 拿到 null，背景色就永远不更新了。
  if (url === coverAccentUrl) return coverAccentPromise;
  coverAccentUrl = url;
  coverAccentRgb = null;
  coverAccentPromise = (async () => {
    const rgb = await sampleDominantColor(url);
    // 采样是异步的，期间可能已经切歌，过期结果直接丢掉
    if (coverAccentUrl !== url) return null;
    coverAccentRgb = rgb;
    const value = rgb ? glowColor(rgb) : '';
    nodes.forEach(node => {
      if (value) node.style.setProperty('--cover-accent', value);
      else node.style.removeProperty('--cover-accent');
    });
    return rgb;
  })();
  return coverAccentPromise;
}

// ---------- 歌词界面「立体向内倾斜 + 投影」效果 ----------
// 歌词与封面区各自独立开关，各自可选「右侧向后 / 左侧向后」；
// 两个开关都关闭时完全保留原有的歌词显示效果。
const EFFECT_LABELS = {
  tiltLyrics: '歌词倾斜投影',
  tiltStage: '封面区倾斜投影',
  ambientLight: '右侧氛围灯',
  ambientLeft: '左侧氛围灯',
  ambientFlash: '闪光跃动',
  lyricTranslation: '显示翻译'
};
const TILT_DIR_KEYS = { tiltLyricsDir: '歌词倾斜方向', tiltStageDir: '封面区倾斜方向' };
// 方向 -> rotateY 的正负号（rotateY 正值 = 右侧向后倒）
const TILT_DIR_OWNER = { tiltLyricsDir: 'tiltLyrics', tiltStageDir: 'tiltStage' };

// 把偏好值归一化成 'left' / 'right'。localStorage 里可能残留旧值或非法值，
// 不归一化的话 <select> 匹配不到任何 option，会显示成第一项，与实际生效的方向不符。
function tiltDir(key) {
  return state.prefs[key] === 'left' ? 'left' : 'right';
}

function tiltDirValue(key) {
  return tiltDir(key) === 'left' ? -1 : 1;
}

function tiltDirLabel(key) {
  return tiltDir(key) === 'left' ? '左后' : '右后';
}

// 右键菜单里的开关同步显示状态；所属效果关闭时，把同一行的方向分段弱化，
// 避免用户以为方向已经生效了。倾斜与氛围灯共用这一段。
function syncLyricMenuSwitches() {
  $$('#lyricMenu [data-lyric-toggle]').forEach(button => {
    const key = button.dataset.lyricToggle;
    const on = Boolean(state.prefs[key]);
    button.classList.toggle('active', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    const row = button.closest('.lyric-menu-row');
    // .off 是「所属效果关着 → 这一项此刻不生效」的弱化，用于倾斜方向分段这类附属项。
    // 「闪光跃动」不同：它是个独立的模式开关，关着代表「用经典模式」而不是「不可用」，
    // 而且默认就是关的 —— 一并变灰会让人以为点不了。它的开关状态只由 .active 表达。
    if (row && key !== 'ambientFlash') row.classList.toggle('off', !on);
  });
}

function applyTiltEffect() {
  const angle = Math.max(0, Math.min(35, Number(state.prefs.tiltAngle) || 0));
  const player = $('#fullPlayer');
  if (player) {
    player.style.setProperty('--tilt-angle', `${angle}deg`);
    player.style.setProperty('--lyric-dir', String(tiltDirValue('tiltLyricsDir')));
    player.style.setProperty('--stage-dir', String(tiltDirValue('tiltStageDir')));
  }
  document.body.classList.toggle('tilt-lyrics', Boolean(state.prefs.tiltLyrics));
  document.body.classList.toggle('tilt-stage', Boolean(state.prefs.tiltStage));

  const slider = $('#tiltAngle');
  if (slider && Number(slider.value) !== angle) slider.value = String(angle);
  const angleLabel = $('#tiltAngleValue');
  if (angleLabel) angleLabel.textContent = `${angle}°`;

  [['#tiltLyricsDir', 'tiltLyricsDir'], ['#tiltStageDir', 'tiltStageDir']].forEach(([selector, key]) => {
    const select = $(selector);
    const value = tiltDir(key);
    if (select && select.value !== value) select.value = value;
  });

  syncLyricMenuSwitches();

  // 方向分段：高亮当前生效的那一侧
  $$('#lyricMenu [data-lyric-dir]').forEach(button => {
    const key = button.dataset.lyricDir;
    const on = tiltDir(key) === (button.dataset.dir === 'left' ? 'left' : 'right');
    button.classList.toggle('active', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

// 右键菜单 / 设置页共用的效果开关：歌词倾斜、封面区倾斜、氛围灯都走这里。
function toggleEffectPref(key) {
  if (!(key in EFFECT_LABELS)) return;
  state.prefs[key] = !state.prefs[key];
  savePrefs();
  applyTiltEffect();
  applyAmbientLight();
  applyLyricTranslation();
  showToast(`${EFFECT_LABELS[key]}已${state.prefs[key] ? '开启' : '关闭'}`);
}

// 设定倾斜方向。菜单里的「右后 / 左后」分段与设置页下拉都走这里。
// 如果所属效果还没打开，顺手把它打开，免得用户点了方向却看不出任何变化。
function setTiltDir(key, value, silent) {
  if (!(key in TILT_DIR_KEYS)) return;
  const owner = TILT_DIR_OWNER[key];
  const next = value === 'left' ? 'left' : 'right';
  // 方向已经一致、效果也开着，就没有状态要写，同步一次界面即可
  if (tiltDir(key) === next && state.prefs[owner]) {
    applyTiltEffect();
    return;
  }
  const autoOn = !state.prefs[owner];
  state.prefs[key] = next;
  if (autoOn) state.prefs[owner] = true;
  savePrefs();
  applyTiltEffect();
  if (silent) return;
  showToast(autoOn
    ? `${EFFECT_LABELS[owner]}已开启 · ${tiltDirLabel(key)}`
    : `${TILT_DIR_KEYS[key]}已切到${tiltDirLabel(key)}`);
}

// 在「右侧向后 / 左侧向后」之间来回切
function toggleTiltDir(key) {
  if (!(key in TILT_DIR_KEYS)) return;
  setTiltDir(key, tiltDir(key) === 'left' ? 'right' : 'left');
}

// ---------- 歌词界面「氛围灯」（跟着音乐的低频呼吸） ----------
// 频谱直接复用 ensureAudioGraph() 里那条链路上的 analyser
// （source -> EQ -> gain -> analyser -> destination），不用另建 AudioContext，
// 也就不会踩到「重新接一个分析节点反而没了声音」那个坑。
// 【动态靠什么表现 · 实测结论，别再走回头路】
// 用 headless 实测过（真实 DOM + 真实样式，1500×880 逐像素比对）：
//   · 纵向 scale 1.04 → 1.28（雾层**没有**纵向边界时）：整个窗口只有 2 个像素变化、
//     峰值 7 —— 等于没动。原因是雾层纵向是一片**均匀的场**：保底渐变没有纵向起伏，
//     三个色团又叠满了整个高度，对均匀场做纵向缩放 ≈ 拉伸一条恒定值，浓度处处不变。
//   · 横向 scale + origin 68%：11% 像素变化，但峰值只有 13，肉眼无感。
//   · 横向 scale + origin 100%：36% 像素变化、峰值 50，一眼可见。
// 所以：**横向、且原点必须在右缘** 是主力动态轴。
//
// 纵向要动起来，前提是先给雾层一道**上下渐隐边界**（.ambient-fog 的第二层 mask，
// 见 styles.css 里那段说明）—— 边界在窗口内，scaleY 才会让这条边界跟着上下胀缩，
// 纵向才真的看得见。没有这道边界，纵向怎么给都是死的，这条别走回头路。
//
// 亮度恒定：体积是唯一的动态来源，一旦把振幅分给 opacity，哪怕只差 .10，
// 它也会变成画面里唯一会变的东西 → 看起来就是「一闪一闪」。
// ---- 从「低频能量」到 level 的映射（2026-10-07 二次重写：自适应标准化）----
// 目标：跟着鼓点和段落起伏走，而且**任何曲子都不能长时间顶满不动**。
//
// 第一版（取 6 个 bin 的 max + (raw-envMin)/(envMax-envMin) 自适应归一化）有两个
// 致命问题，都是实测出来的：max 让 72% 的时间读数 ≥245（动态削平）；
// 自适应归一化会【反相】—— 鼓点一来 raw 冲高、envMax 跟着涨、分母变大、输出反而变小
// （实测「鼓点前 0.81 → 鼓点瞬间 0.57」），段落强弱也被抹平。
//
// 第二版（8 个 bin 的 mean + 60s 慢锚点 + 固定增益 7）修好了反相，在鼓点素材上
// 相关性能到 +0.75，但一放到真实音乐就露馅：
//   level = clamp((raw - anchor) * 7) —— 「高出锚点 0.143 就满幅」是个**固定阈值**，
//   而 60s 的锚点根本追不上段落变化。段落一持续，差值就长期大于阈值 →
//   雾团贴着满幅不动。实测四首：《爱的主打歌》17.5% 的时间贴着 1.0（最长连续 5.4s）、
//   《Welcome 2 Minneapolis》19.7%（4.5s）、《勇气》13.6%、《Paradise》10.7%。
//   反过来，动态小的曲子又会长期贴地 —— 总之「固定阈值 + 固定增益」对
//   不同混音风格的曲子不可能都合适。
//
// 这一版换成**按这首歌自己的动态范围做标准化**（也就是把它的「频响线」实时估出来）：
//   mean ← 慢速平滑(E)，时间常数 ≈18s   —— 这首歌低频能量的基准线
//   var  ← 慢速平滑(E²) - mean²         —— 这首歌的动态幅度
//   level = clamp(BASE + (1-BASE) * (E - mean) / (K * sd))
// level 的语义变成「高出基准线几个标准差」，分布被自动对齐到 0~1：
// 不管这首歌低频多满、多平，都会在 0~1 之间摆动，既不长期顶满也不长期贴地。
// 实测（真实 AnalyserNode 逐帧取数、与真实低频包络比对）：
//   顶满率 17.5/13.6/10.7/19.7% → 1.3/3.1/2.9/1.4%；
//   最长连续顶满 5.4s → 0.3s；相邻帧「在动率」68/65/63/63% → 81/69/72/79%；
//   相关性 +0.30/+0.33/+0.46/+0.31 → +0.47/+0.35/+0.53/+0.41。
const AMBIENT_WARMUP_TAU = 1.5;   // 切歌 / 重新开灯后先用这个快速度找准基准
const AMBIENT_WARMUP_SECONDS = 1.5;
const AMBIENT_BASE = .20;         // 静息保留的基础宽度：播放中「安静拍」的保底宽度
                                  // （★ 0.20 是离线扫描出来的最优点：再大峰谷差反而被压缩，
                                  //   再小则雾一半时间贴在边上、看着像「没雾」而非「在浮动」）
const AMBIENT_GATE_LO = .03;      // E 低于此值 = 没信号，直接收到静息
const AMBIENT_GATE_HI = .08;      // E 高于此值 = gate 全开
const AMBIENT_FOLLOW_TAU = .03;   // 输出平滑时间常数（秒）≈ 原来的 0.56@60fps
const AMBIENT_CLASSIC_REF_TAU = 18; // 【经典】基准线时间常数（秒）：瞬时能量的 18s 慢均值
const AMBIENT_SD_MIN = .010;      // 【经典】归一化分母下限（≈2.6/255）：静音段别把噪声放大

// ==========================================================================
// 两种氛围灯模式（2026-10-08，用户要求把强节律版收成一个开关）
// ==========================================================================
// 用户原话：「你加个开关这个版本叫闪光跃动 还用之前加光亮之前的版本 给这个版本单独
// 加个开关可以打开出来」。也就是：
//
//   prefs.ambientFlash = false（默认）→ 【经典】
//       加鼓点响应之前的那一版：瞬时能量 e 减 18s 慢均值 → z 分数 → 驱动雾宽。
//       没有高光层（flare 恒 0），整体是「跟着曲子整体响度缓慢呼吸」——
//       安静、不抢戏，适合一直开着。
//
//   prefs.ambientFlash = true        → 【闪光跃动】
//       低音鼓点包络（快攻≈14ms / 慢放≈280ms）→ z 分数 → 驱动雾宽，
//       同时快包络 − 慢包络的冲击量另走一路高光（--ambient-flare）。
//       鼓点一到，雾从边缘明显张开并提亮，节律感强、动静明显。
//
// 两套算法【共用同一组状态变量】—— 同一时刻只有一套在跑（由开关决定），刻意不做成
// 「两条流水线并行」：那样不仅白算一倍，还容易出现「切回来时基准是几个月前的」这种脏状态。
// 具体做法是：classic 模式下让 ambientBass 恒等于瞬时 e，于是下游的
// 「基准线 → 标准差 → z 分数 → gate → 雾宽」这套逻辑完全一致，差异只剩两处常量
// （基准时间常数 18s vs 12s、涨落下限 .010 vs .006）和两套档位表。
// 切换开关 / 切歌 / 重新开灯都会把基准全部丢掉重找，前 1.5s 用短时间常数快速收敛。
//
// ⚠️ 别再试图用「调参数」的办法让经典模式显现出鼓点节律 —— 真实歌曲的低频动态极窄
//    （4 首全曲实测 e 的 p10~p90 只差 1.3~1.9 倍 ≈ 3~6 dB），拿瞬时能量当输入，
//    无论怎么调都只能得到「缓慢漂移」。节律感必须靠【包络】提出来，那就是闪光跃动。

// ---------- 低音鼓点包络（2026-10-08 定稿：主通道直接由低频驱动）----------
// 用户原话：「你要不就直接改成按歌曲的鼓点震动吧 低音」。
// 此前主通道喂的是【瞬时能量 e】，减去 18s 均值算 z 分数 —— 它确实在动，但那是
// 「跟着能量缓慢漂移」，没有鼓点的棱角。而用户听的真实歌曲低频动态【极窄】：
// 实测 4 首全曲（爱的主打歌/勇气/The Other Side/Minneapolis），e 的 p10~p90
// 只在 1.3~1.9 倍之间（≈3~6 dB），全曲 90% 的帧都挤在 0.37~0.75 这个窄带里。
// 拿它直接比基准线，漂移量小到眼睛看不出节律；而此前验证用的 beat.wav 是
// 合成的强规律鼓点（涨落十几 dB），所以「测试数据好看、真实听感没有」。
//
// 现在改成先做一条【快攻慢放】包络：鼓点前沿十几毫秒冲上去、之后约 280ms 回落，
// 每一次鼓点 = 一个清晰的「冲高 → 回收」。这是「震动感」的来源。
// ⚠️ 基准线必须用【这条包络自己的】慢速均值（12s），不能再用 e 的均值 ——
//    快包络长期高于瞬时均值，若沿用旧基准，z 长期为正 → 雾一直张着不收，
//    「收-张」的对比反而消失（离线扫描实测，1s 极差会从 50%W 掉到 32%W）。
const AMBIENT_BASS_ATTACK = .014;   // 包络「快攻」≈14ms：鼓点前沿跟得住
const AMBIENT_BASS_RELEASE = .28;   // 包络「慢放」≈280ms：鼓点之间收得回去、又不发抖
const AMBIENT_BASS_REF_TAU = 12;    // 基准线时间常数（秒）：包络在 12s 尺度上的典型水平
const AMBIENT_BASS_SD_FLOOR = .006; // 归一化分母下限：静音段别把量化噪声放大成「鼓点」
const AMBIENT_BIN_COUNT = 8;      // 只取最低的几档：跟的是鼓点和贝斯，不是镲片
const AMBIENT_DB_SPAN = 80;       // analyser 的 minDecibels→maxDecibels 跨度，音量补偿用
// 横向基准：静息（level 0）时雾收成贴着右边框的一条窄雾（用户要的「不要这么大」）。
// 宽度 = SX_BASE + level × sxRange，其中 sxRange 由下面的「动态强度」滑块给。
const AMBIENT_SX_BASE = .48;
// 纵向作点缀（用户：横向刚好，纵向稍微给一点、不要多）。配上 CSS 里那道 20% 的
// 上下渐隐边界，标准档（syRange .26）实测「静息 → 拉满」峰值 29、改动面积约 5%，
// 是看得见又不过分的量级；再往上加就成雾在上下抽了。
// 注意：这个幅度只在有了纵向边界之后才有意义，之前给 .18 都是白给。
const AMBIENT_SY_BASE = 1.00;

// ---------- 鼓点加亮（2026-10-07）----------
// 用户：「有鼓点的时候雾有个轻微加亮的效果」。这条把「浓度恒定」那条老规矩放开了 ——
// 当年把 opacity 写死 .74，是因为体积一动不动时，那点亮度差就成了画面里唯一的动态，
// 看着只剩「一闪一闪」。现在横向 / 纵向已经在动，加亮跟鼓点**同相**
// （鼓点一到：同时胀开 + 提亮），同一件事的两面，才是「一震」而不是「闪」。
//
// ⚠️ 加亮必须是【瞬态】，不是段落。第一版直接把「快包络 − 慢包络」当强度用，
// 实测 mean 0.44~0.72、>0.5 占 27%~76% —— 因为音乐低频能量本身一直在波动，
// 这个差值的稳态值并不为零，于是就变成「一直在亮」而不是「鼓点在闪」。
// 正解是再套一层自适应归一化：用差值自己的慢速均值 / 方差算出 z 分数，
// 低于这首歌典型波动水平的部分（z < 0）直接归零。实测 z 的 P50 = 0、
// P90 ≈ 1.3、P99 ≈ 2.5 —— 一半时间完全不亮，只有真正的冲击才顶得上去。
//
// 四首歌（爱的主打歌 / 勇气 / The Other Side of Paradise / Minneapolis，全曲真实数据）实测：
//   平均亮度 0.17~0.19、P50 0.00~0.05、P90 0.59~0.63、P99 0.95~0.99；
//   亮起事件 0.95~1.8 次/秒（正好是鼓点速率）；与真实低频 onset 的相关性 +0.09~+0.28。
// ⚠️ 2026-10-08 实测返工：数值「对」不等于「看得见」。
//    上一版这套参数在真实渲染里逐像素测出来是 max 49~54（flare 峰值 .50），
//    客观上是有的，但用户连着两次反馈「没有亮度」。原因是这个变化是【瞬时脉冲】：
//    峰值只维持几十毫秒、每秒 1~2 次、区域在窗口右缘、弥散无轮廓、而人正盯着左边看歌词。
//    周边视野 + 无轮廓 + 无位移的短暂亮度起伏，是最难被察觉的一类视觉信号。
//    所以这一版把【强度】和【持续时间】同时拉上去，让它从「偶尔闪一下」变成
//    「跟着节奏明暗呼吸」：峰值 .50→.80，余晖 .16→.34（每次亮起拖到约 0.3s），
//    触发门槛 2.0σ→1.45σ（更多拍子亮）。
const AMBIENT_GLOW_UP_TAU = .010;   // 快包络「快攻」：鼓点前沿得跟得住
const AMBIENT_GLOW_DOWN_TAU = .34;  // 快包络「慢放」：鼓点之后留余晖，太短就只剩「闪」不成「呼吸」
const AMBIENT_GLOW_FLOOR_TAU = .80; // 慢包络 = 当前响度水平；快包络高出它多少 = 这次的冲击量
const AMBIENT_GLOW_BASE_TAU = 3.0;  // 冲击量自身均值 / 方差的慢速跟踪（自适应阈值）
const AMBIENT_GLOW_SD_FLOOR = .004; // 归一化分母的下限：静音段别把量化噪声放大成「鼓点」
const AMBIENT_GLOW_Z = 1.45;        // 高出典型波动 1.45 个标准差 = 满亮（原 2.0 太保守，亮得太稀）
const AMBIENT_GLOW_TAU = .032;      // 亮度输出的平滑：太小峰值一闪而过，太大峰值被削平

// ---------- 动态强度：无级滑块（0~180，默认 100）----------
// 设置页和歌词右键菜单各有一个滑块，写的是同一个偏好 state.prefs.ambientPower，
// 两种氛围灯模式共用这一个滑块，但各用各的档位表（见下）。
// 参数一起跟着档位走，而不是只缩幅度 —— 只缩幅度会变成「小幅快速抖动」，
// 观感比原来更怪；低档应该是「又慢又小」，高档是「又快又大」，衔接才自然。
//   sdK       ：多少倍标准差算满幅（越小越容易冲满）
//   sxRange   ：横向最大伸缩量（宽度 = SX_BASE + level × sxRange）
//   syRange   ：纵向最大伸缩量（高度 = SY_BASE + level × syRange）
//   flareRange：鼓点高光层的峰值不透明度（.lyrics-ambient::after 的 --ambient-flare）
// ⚠️ 加亮【不能】靠改雾层自己的 opacity。2026-10-07 试过：外层 opacity .74→.86，
//    实测全窗口最大像素差只有 9/255（判据：峰值 13 就已肉眼 0%），用户反馈「并没有
//    变亮的效果」。原因是外层 opacity 为整体等比压缩，而雾合成后的有效不透明度本就低。
//    改成【新增一层高光】之后，同样的观感只要 max 50 左右，实测 42~58（见 styles.css）。
//    第 5 列就是这层的峰值：0.80 → 峰值像素差 ≈ 86、0.90 → ≈ 96（真机逐像素实测），静息恒为 0。
//    ★ flareRange 只有【闪光跃动】才非零 —— 经典模式（加鼓点响应之前那版）没有高光层，
//      静息与播放中形态都与当年逐像素一致。

const AMBIENT_POWER_MIN = 0;
const AMBIENT_POWER_MAX = 180;
const AMBIENT_POWER_DEFAULT = 100;

// 【经典】= 加鼓点响应之前的版本：瞬时能量 e 的 18s 慢均值 + z 分数驱动雾宽，无高光。
// 这一版是「缓慢呼吸」，节律感弱但安静耐看 —— 也就是 defaultPrefs.ambientFlash=false 时的行为。
const AMBIENT_POWER_CURVE_CLASSIC = [
  //  power   sdK    sxRange  syRange  flareRange
  [0,       6.00,  0.12,    0.04,    0.00],
  [50,      2.50,  0.57,    0.16,    0.00],
  [100,     1.50,  0.88,    0.26,    0.00],
  [140,     1.05,  1.10,    0.33,    0.00],
  [180,     0.85,  1.30,    0.40,    0.00]
];

// 【闪光跃动】= 低音鼓点包络驱动 + 鼓点高光。
// 100% 那一行是定稿值（sdK 1.00 / sx 1.40 / sy 0.32 / flare 0.88）。
// 标定依据：离线跑 4 首真实歌【全曲】的低频能量序列，统计「1 秒滑窗内的雾宽极差」
// （= 眼睛实际感受到的浮动幅度）：
//   经典（瞬时 e + sdK1.5 + sx0.88）→ 极差 p50 = 0.615，视觉跨度 30.8% 窗宽
//   闪光跃动（低音包络 + sdK1.0 + sx1.40）→ 极差 p50 = 1.115，视觉跨度 55.7% 窗宽
//   ★ 提升 1.81 倍；当初交付的定格演示图跨度只有 0.40（20% 窗宽），新版是它的 2.8 倍。
//   静息形态完全没动：两种方案 sx 的 p10 都是 0.480（贴右边框的窄雾），
//   不播放时 level=0，雾宽恒为 AMBIENT_SX_BASE，与这些档位无关。
// 0% 几乎不动、也不加亮；180% 时鼓点峰值雾宽 0.48 + 1.96 = 2.44，铺满整个窗口有余。
const AMBIENT_POWER_CURVE_FLASH = [
  //  power   sdK    sxRange  syRange  flareRange
  [0,       6.00,  0.12,    0.04,    0.00],
  [50,      2.10,  0.90,    0.20,    0.48],
  [100,     1.00,  1.40,    0.32,    0.88],
  [140,     0.80,  1.68,    0.40,    0.96],
  [180,     0.65,  1.96,    0.48,    1.00]
];

function ambientPower() {
  // 用 typeof 而不是 Number() —— Number(null) 是 0，会把「没存过 / 存成 null」
  // 误判成 0 档（雾不动）。parseFloat(null) 是 NaN，能正确回落到默认值。
  const raw = state.prefs.ambientPower;
  const num = typeof raw === 'number' ? raw : Number.parseFloat(raw);
  const p = Number.isFinite(num) ? num : AMBIENT_POWER_DEFAULT;
  return Math.max(AMBIENT_POWER_MIN, Math.min(AMBIENT_POWER_MAX, p));
}

// 「闪光跃动」开关的当前状态。主循环每帧读一次，决定走哪套算法、用哪张档位表。
function ambientFlashOn() {
  return Boolean(state.prefs.ambientFlash);
}

// 分段线性插值：滑块停在任何位置都能拿到一组连贯的参数，不会在档位边界跳变。
// 两张档位表结构一致（sdK / sxRange / syRange / flareRange），只是数值不同，
// 经典表第 5 列恒为 0 —— 所以切模式时下游逻辑一行都不用分叉。
function ambientPowerParams() {
  const p = ambientPower();
  const table = ambientFlashOn() ? AMBIENT_POWER_CURVE_FLASH : AMBIENT_POWER_CURVE_CLASSIC;
  let i = 0;
  while (i < table.length - 2 && p > table[i + 1][0]) i += 1;
  const a = table[i];
  const b = table[i + 1];
  const span = (b[0] - a[0]) || 1;
  const t = Math.max(0, Math.min(1, (p - a[0]) / span));
  return {
    sdK: a[1] + (b[1] - a[1]) * t,
    sxRange: a[2] + (b[2] - a[2]) * t,
    syRange: a[3] + (b[3] - a[3]) * t,
    flareRange: a[4] + (b[4] - a[4]) * t
  };
}

function ambientPowerLabel(p) {
  if (p <= 1) return '静止';
  if (p < 35) return '很轻';
  if (p < 75) return '轻';
  if (p <= 125) return '标准';
  if (p <= 160) return '较强';
  return '很强';
}
let ambientLevel = 0;          // 0 = 静息，1 = 明显强于这首曲子的平均值（同一个值同时驱动两片）
let ambientBass = null;        // 主通道的驱动信号：【闪光跃动】=低音鼓点包络（快攻≈14ms/慢放≈280ms），
                               // 【经典】= 直接赋成瞬时 e（不建包络）。两套模式共用一个变量，见上面模式说明。
let ambientMean = null;        // 上面那个信号的基准线，≈12s（闪光跃动）/ 18s（经典）慢速跟踪
let ambientMean2 = null;       // 信号的平方的同速跟踪值，和 ambientMean 一起算出标准差
let ambientFast = null;        // 高光通道的快包络（快攻慢放）：鼓点前沿冲得上去
let ambientFloor = null;       // 高光通道的慢包络（≈0.8s）：当前响度水平，快包络高出它多少就是这次的冲击量
let ambientDiffMean = null;    // 冲击量自己的慢速均值（自适应阈值的中心）
let ambientDiffSq = null;      // 冲击量² 的慢速均值，和上面一起算出冲击量的「典型起伏」
let ambientGlow = 0;           // 0 = 不加亮，1 = 满亮（鼓点加亮，驱动 --ambient-flare）
let ambientFlashState = null;  // 上一帧用的模式。和当前开关不一致 = 刚切了模式，基准要全部重来
let ambientWarmup = 0;         // 切歌 / 开灯后已过去的秒数，用于快收敛
let ambientLastTime = 0;       // 上一帧时间戳（毫秒），用实际 dt 换算平滑系数
let ambientTrackId = null;     // 用来发现换歌，换歌就重找基准
let ambientSpectrum = null;    // 复用的频谱缓冲，避免每帧新建数组
// 左右两片雾的容器。缓存起来 —— 每帧都要往上写变量，别每帧 querySelector。
let ambientNodes = null;

// 时间常数（秒）→ 本次的平滑系数。按**实际帧间隔**算，帧率掉到 40 或跑到 120
// 时手感一致（用固定系数的话，掉帧就等于把时间常数一起拖长了）。
function ambientFollow(tau, dt) {
  return 1 - Math.exp(-dt / tau);
}

// 左右两片（左侧那片可能不存在）。两片由同一个 level 驱动，
// 所以每帧取一次值、两边写同样的数字，左右永远同步、不会有相位差。
function ambientLayerNodes() {
  if (!ambientNodes) {
    ambientNodes = [$('#lyricsAmbient'), $('#lyricsAmbientLeft')].filter(Boolean);
  }
  return ambientNodes;
}

function applyAmbientLight() {
  document.body.classList.toggle('ambient-light', Boolean(state.prefs.ambientLight));
  document.body.classList.toggle('ambient-left', Boolean(state.prefs.ambientLeft));
  const toggle = $('#ambientLightToggle');
  if (toggle) toggle.checked = Boolean(state.prefs.ambientLight);
  const leftToggle = $('#ambientLeftToggle');
  if (leftToggle) leftToggle.checked = Boolean(state.prefs.ambientLeft);
  // 「闪光跃动」开关（设置页）。右键菜单那个走 syncLyricMenuSwitches，
  // 两条路都会回到这个函数，所以把 UI 同步收在这一处。
  const flashToggle = $('#ambientFlashToggle');
  if (flashToggle) flashToggle.checked = ambientFlashOn();
  // 两片都关了才停掉动态；只关一边时另一片还要继续跟音乐动。
  // 关掉时把基准也丢掉 —— 重新打开时按当前这首的实际情况重新找，
  // 否则会拿着很久以前的基准，一开就是满的或者一开就是贴地的。
  if (!state.prefs.ambientLight && !state.prefs.ambientLeft) {
    ambientLevel = 0;
    ambientBass = null;
    ambientMean = null;
    ambientMean2 = null;
    ambientWarmup = 0;
    ambientFast = null;
    ambientFloor = null;
    ambientDiffMean = null;
    ambientDiffSq = null;
    ambientGlow = 0;
    // 模式标记也清掉：重新开灯时必然走一次「模式变化 → 重建基准」
    ambientFlashState = null;
  }
  syncLyricMenuSwitches();
  syncAmbientPowerUI();
}

// 氛围灯「动态强度」两组控件（设置页滑块 / 歌词右键菜单滑块）的双向同步。
// 两边读写的是同一个偏好，所以任何一边动了都要顺带刷新另一边和数值标签。
function syncAmbientPowerUI() {
  const p = ambientPower();
  const text = `${Math.round(p)}%`;
  const setting = $('#ambientPower');
  if (setting && Number(setting.value) !== p) setting.value = String(p);
  const settingValue = $('#ambientPowerValue');
  if (settingValue) settingValue.textContent = text;
  const menu = $('#lyricMenuAmbientRange');
  if (menu && Number(menu.value) !== p) menu.value = String(p);
  const menuValue = $('#lyricMenuAmbientPower');
  if (menuValue) menuValue.textContent = `${ambientPowerLabel(p)} ${text}`;
  // 两片都关掉时把菜单里这组弱化（跟方向分段同一个处理）
  const off = !state.prefs.ambientLight && !state.prefs.ambientLeft;
  ['#lyricMenuAmbientPowerRow', '#lyricMenuAmbientPowerSlider'].forEach(id => {
    const row = $(id);
    if (row) row.classList.toggle('off', off);
  });
}

// 两个滑块接同一段逻辑：拖动过程中即时生效但不落盘（免得一次拖动写几百次
// localStorage），松手才保存。updateAmbientLight 每帧读 ambientPower()，画面实时跟手。
function bindAmbientPower() {
  [$('#ambientPower'), $('#lyricMenuAmbientRange')].forEach(input => {
    if (!input) return;
    input.value = String(ambientPower());
    input.addEventListener('input', () => {
      state.prefs.ambientPower = Number(input.value);
      syncAmbientPowerUI();
    });
    input.addEventListener('change', () => {
      state.prefs.ambientPower = Number(input.value);
      syncAmbientPowerUI();
      savePrefs();
    });
  });
}

// ---------- 双语歌词：译文行显不显示 ----------
// 译文行在解析阶段就打好标了（tags.js 的 parseLyrics），这里只按偏好切视图。
// 行数会变，所以必须整段重建 DOM，不能只切 class —— getLyrics 的过滤缓存
// 也要手动作废（它的失效判据是源数组身份，偏好变化不在里面）。
function applyLyricTranslation() {
  const on = state.prefs.lyricTranslation === true;
  const toggle = $('#lyricTranslationToggle');
  if (toggle) toggle.checked = on;
  const track = getTrack(state.currentId);
  if (track) {
    track._lyricsView = null;
    track._lyricsViewSrc = null;
  }
  activeLineIndex = -1;
  renderLyrics();
  syncLyricMenuSwitches();
}

// 挂在 drawVisualizer 的动画循环里，每帧跑一次。
// 只写两个 CSS 变量（横向 + 纵向缩放）、左右两片各写一遍，雾团的漂移交给
// CSS 自己的 animation，所以每帧的工作量固定在「读一次频谱 + 四次 setProperty」。
function updateAmbientLight() {
  // 只要还有一边开着就得继续算 —— 不能只看右侧那个开关
  if (!document.body.classList.contains('ambient-light')
      && !document.body.classList.contains('ambient-left')) return;
  const nodes = ambientLayerNodes();
  if (!nodes.length) return;
  const player = $('#fullPlayer');
  if (!player || !player.classList.contains('open')) return;

  // 换歌 / 换模式都丢掉基准重找：不同曲子的整体低频电平能差十几 dB，
  // 沿用上一首的基准会让新歌前十几秒一直顶满（或者一直贴地）；
  // 而两种模式喂进去的信号根本不是一回事（瞬时 e vs 低音包络），基准更不能串。
  const trackId = state.currentId ?? null;
  const flash = ambientFlashOn();
  if (ambientTrackId !== trackId || ambientFlashState !== flash) {
    ambientTrackId = trackId;
    ambientFlashState = flash;
    ambientBass = null;
    ambientMean = null;
    ambientMean2 = null;
    ambientWarmup = 0;
    // 鼓点包络 + 鼓点加亮那两套包络一起归零 —— 换了歌 / 换了模式，
    //「典型水平 / 典型起伏」就不是原来那个了。
    ambientFast = null;
    ambientFloor = null;
    ambientDiffMean = null;
    ambientDiffSq = null;
    ambientGlow = 0;
  }

  // 实际帧间隔，用于把「时间常数」换算成这一帧的平滑系数。
  const now = performance.now();
  const dt = ambientLastTime ? Math.min(.1, (now - ambientLastTime) / 1000) : 1 / 60;
  ambientLastTime = now;

  // 这一帧的强度参数（无级滑块）。两片雾共用一份；因为是分段线性插值，
  // 滑块在两个刻度之间也不会跳变。
  const map = ambientPowerParams();

  let target = 0;
  let glowTarget = 0;   // 鼓点加亮的瞬时目标；0 = 不加亮
  // 用氛围灯专用 analyser（smoothing 0.4，能捕捉瞬态），不用波形图那个（0.78，会抹平动态）。
  const amb = ambientAnalyser || analyser;
  if (amb && state.playing) {
    if (!ambientSpectrum || ambientSpectrum.length !== amb.frequencyBinCount) {
      ambientSpectrum = new Uint8Array(amb.frequencyBinCount);
    }
    amb.getByteFrequencyData(ambientSpectrum);
    // 取最低几档的【平均】。原来这里取 max，是「不跟歌」的头号原因：
    // 6 个 bin 只要有一个高就顶满，实测 72% 的时间读数 ≥245，动态整个被削平。
    const bins = Math.min(AMBIENT_BIN_COUNT, ambientSpectrum.length);
    let sum = 0;
    for (let i = 0; i < bins; i += 1) sum += ambientSpectrum[i];
    let e = sum / bins / 255;
    // 音量补偿：analyser 挂在 gainNode 后面，用户调音量会把读数整体平移。
    // 把已知的增益折回 dB 补上去，调音量时雾团大小就不跟着变。
    // 用 state.volume 而不是 audio.volume —— 淡入淡出期间后者在渐变，会让雾团跟着漂。
    // totalGain 为 0（静音 / 音量拉到 0）时不算补偿：那不是「音量小」，是「没信号」。
    const totalGain = (state.muted ? 0 : state.volume)
      * (gainNode ? gainNode.gain.value : 1);
    const vol = Math.max(.02, totalGain);
    e = Math.max(0, Math.min(1, e + (-20 * Math.log10(vol)) / AMBIENT_DB_SPAN));

    if (ambientBass === null) {
      ambientBass = e;
      ambientMean = e;
      ambientMean2 = e * e;
      ambientFast = e;
      ambientFloor = e;
      ambientWarmup = 0;
    }
    ambientWarmup += dt;

    // ---- 主通道的驱动信号（两种模式在这里分岔）----
    // 【闪光跃动】先做一条低音鼓点包络：鼓点前沿 ≈14ms 冲上去、之后 ≈280ms 回落，
    //   每一次鼓点 = 一个清晰的「冲高 → 回收」，这就是「震动感」的来源。
    // 【经典】不做包络，直接取瞬时 e —— 也就是加鼓点响应之前的老算法，
    //   只有「跟着曲子整体响度缓慢呼吸」，没有节律。
    if (flash) {
      ambientBass += (e - ambientBass)
        * ambientFollow(e > ambientBass ? AMBIENT_BASS_ATTACK : AMBIENT_BASS_RELEASE, dt);
    } else {
      ambientBass = e;
    }

    // 基准线 = 这个信号自己的慢速均值：闪光跃动 12s / 经典 18s。
    // ⚠️ 闪光跃动必须用【包络自己的】均值，不能沿用瞬时 e 的均值 —— 快包络长期高于
    //    瞬时均值，若沿用旧基准，z 会长期为正 → 雾一直张着不收回，
    //    「收-张」的对比反而消失（离线扫描实测，1s 极差会从 50%W 掉到 32%W）。
    //    切歌 / 刚开灯 / 刚切模式时先用短时间常数快速找准基准。
    const refTau = ambientWarmup < AMBIENT_WARMUP_SECONDS
      ? AMBIENT_WARMUP_TAU : (flash ? AMBIENT_BASS_REF_TAU : AMBIENT_CLASSIC_REF_TAU);
    const refFollow = ambientFollow(refTau, dt);
    ambientMean += (ambientBass - ambientMean) * refFollow;
    ambientMean2 += (ambientBass * ambientBass - ambientMean2) * refFollow;

    if (totalGain > 0) {
      // 标准差 = sqrt(E[E²] - E[E]²)，就是这条信号当前的起伏幅度。
      // 下限兜住静音段，免得把 analyser 的量化噪声当成动态放大。
      const sd = Math.max(Math.sqrt(Math.max(0, ambientMean2 - ambientMean * ambientMean)),
        flash ? AMBIENT_BASS_SD_FLOOR : AMBIENT_SD_MIN);
      const z = (ambientBass - ambientMean) / (map.sdK * sd);
      // 真正的静音 / 极轻段落直接把雾收到静息，不要凭空摆。
      const gate = Math.max(0, Math.min(1,
        (e - AMBIENT_GATE_LO) / (AMBIENT_GATE_HI - AMBIENT_GATE_LO)));
      // 高出基准线越多、雾铺得越开；BASE 是静息保底宽度。
      target = gate * Math.max(0, Math.min(1, AMBIENT_BASE + (1 - AMBIENT_BASE) * z));

      // ---- 鼓点加亮：只有【闪光跃动】会跑这一段 ----
      // 经典模式下整段跳过：glowTarget 保持 0，高光层自然收回，
      // 档位表里 flareRange 那一列也是 0，双保险 —— 当年那版本来就没有高光。
      //
      // ① 快包络：快攻慢放。鼓点前沿冲得上去，之后留一点余晖，而不是硬台阶。
      // ② 慢包络 = 当前响度水平。快包络比它高出多少，就是这一下的冲击量。
      // ③ 但这个差值【长期为正】—— 低频能量本身一直在波动，稳态时快包络也高于慢包络。
      //    直接拿它当强度用，实测有 27%~76% 的帧亮着，就成了「一直在亮」。
      //    所以再套一层自适应归一化：跟踪它自己的均值 / 方差，算出 z 分数，
      //    只有明显超过这首歌「典型起伏水平」的冲击才顶得上去。
      if (flash) {
        ambientFast += (e - ambientFast)
          * ambientFollow(e > ambientFast ? AMBIENT_GLOW_UP_TAU : AMBIENT_GLOW_DOWN_TAU, dt);
        ambientFloor += (e - ambientFloor) * ambientFollow(AMBIENT_GLOW_FLOOR_TAU, dt);
        const diff = Math.max(0, ambientFast - ambientFloor);
        const glowFollow = ambientFollow(AMBIENT_GLOW_BASE_TAU, dt);
        if (ambientDiffMean === null) {
          ambientDiffMean = diff;
          ambientDiffSq = diff * diff;
        }
        ambientDiffMean += (diff - ambientDiffMean) * glowFollow;
        ambientDiffSq += (diff * diff - ambientDiffSq) * glowFollow;
        const diffSd = Math.max(
          Math.sqrt(Math.max(0, ambientDiffSq - ambientDiffMean * ambientDiffMean)),
          AMBIENT_GLOW_SD_FLOOR);
        glowTarget = gate * Math.max(0, Math.min(1,
          (diff - ambientDiffMean) / (AMBIENT_GLOW_Z * diffSd)));
      }
    }
  }

  // 亮度输出也平滑一道：跟得住鼓点，又不会一格一格地跳。
  // 暂停 / 静音时 glowTarget 保持 0，亮起来的部分会自己收回去。
  ambientGlow += (glowTarget - ambientGlow) * ambientFollow(AMBIENT_GLOW_TAU, dt);
  if (ambientGlow < .001) ambientGlow = 0;

  // 涨落共用同一个系数，起落是同一条曲线，观感均匀，没有「先窜一下」的顿挫。
  // 不播放时 target = 0，雾团平滑收回静息形态。
  ambientLevel += (target - ambientLevel) * ambientFollow(AMBIENT_FOLLOW_TAU, dt);
  if (ambientLevel < .001) ambientLevel = 0;

  // 动态：横向为主、纵向为辅。雾从右缘（transform-origin: 100%）向左铺开再收拢，
  // 右缘纹丝不动，所以贴边永远不受影响，视觉上就是雾团在「胀大 / 收拢」。
  // 左侧那片整层镜像（scaleX(-1)），同一组变量写进去，两边就是严格对称地一起胀缩。
  // 浓度【恒定】—— 加亮走的是高光层（.lyrics-ambient::after），不是雾自己的 opacity。
  // ⚠️ 2026-10-07 试过把外层 opacity 从 .74 提到 .86 做加亮，实测全窗口最大像素差只有
  // 9/255（判据 13 就已肉眼 0%），用户反馈「并没有变亮的效果」。外层 opacity 是整体等比
  // 压缩，雾合成后的有效不透明度本来就低，压缩量级根本不够看。
  // 高光层是【新增的一层】，叠加对比度不依赖雾本来的浓度，峰值只要 .5 就够（实测 ≈50）。
  // 四个幅度都跟着「动态强度」滑块走：SX_BASE / SY_BASE 是静息形态（不随档位变，
  // 雾的基本形态保持一致），只有伸缩量 / 高光量随档位放缩；
  // 0% 档高光为 0、伸缩也几乎为 0（选「静止」就不该再闪，也不该再动）。
  //
  // ⚠️ 横向伸缩的驱动信号由上面的 flash 分支给出：闪光跃动=低音鼓点包络，经典=瞬时 e。
  //    下面是闪光跃动那条路的演进过程，免得再走回头路：
  //    ① 最早只驱动亮度（--ambient-flare）→ 用户连续三次反馈「看不出来」。那一路是
  //       弥散、无轮廓、无位移、只维持几十毫秒的亮度脉冲，还落在窗口右缘（周边视野），
  //       而人正盯着画面中间的歌词看 —— 生理上就是最难被察觉的一类信号。
  //    ② 于是把鼓点也接到横向伸缩上（当时是一条额外的 pulseRange）。方向对了，
  //       用户反馈「有一点，但不明显」。
  //    ③ 真正的问题是主通道本身：它吃的是【瞬时能量 e】减 18s 均值，属于「跟着能量
  //       缓慢漂移」，没有鼓点的棱角；而真实歌曲的低频动态极窄（4 首全曲实测，
  //       e 的 p10~p90 只差 1.3~1.9 倍 ≈ 3~6 dB），漂移量小到看不出节律。
  //    ④ 所以改成【低频包络直接驱动】：快攻慢放的 amb 包络 → z 分数 → 主通道。
  //       4 首真实歌全曲离线仿真，1 秒内雾宽的浮动极差从 0.615（30.8% 窗宽）
  //       提到 1.115（55.7% 窗宽）＝ 1.81 倍，而静息形态逐点不变（p10 仍是 0.480）。
  //       人眼对【节律性运动】的敏感度远高于对弥散亮度的敏感度，这才是能被看见的那一路。
  const w = AMBIENT_SX_BASE + ambientLevel * map.sxRange;
  const h = AMBIENT_SY_BASE + ambientLevel * map.syRange;
  const fl = Math.min(1, ambientGlow * map.flareRange);
  const ws = w.toFixed(4);
  const hs = h.toFixed(4);
  const fs = fl.toFixed(4);
  for (let i = 0; i < nodes.length; i += 1) {
    nodes[i].style.setProperty('--ambient-sx', ws);
    nodes[i].style.setProperty('--ambient-sy', hs);
    nodes[i].style.setProperty('--ambient-flare', fs);
  }
}

function applyListDensity() {
  document.body.classList.toggle('density-compact', state.prefs.listDensity === 'compact');
}

function syncWindowBehavior() {
  window.orangeDesktop?.setWindowBehavior?.({
    closeToTray: Boolean(state.prefs.closeToTray),
    minimizeToTray: Boolean(state.prefs.minimizeToTray),
    autoStart: Boolean(state.prefs.autoStart)
  });
}

// ---------- 快捷键自定义 ----------
function shortcutMap() {
  const saved = state.prefs.shortcutKeys && typeof state.prefs.shortcutKeys === 'object'
    ? state.prefs.shortcutKeys
    : {};
  const map = { ...DEFAULT_SHORTCUTS };
  // 旧版本 / 手工改过的 localStorage 里可能存着 null、数字之类的值，
  // 直接拿去做 combo.split() 会在启动渲染快捷键列表时抛错。
  Object.keys(DEFAULT_SHORTCUTS).forEach(action => {
    if (typeof saved[action] === 'string' && saved[action]) map[action] = saved[action];
  });
  return map;
}

function formatShortcutKey(event) {
  const key = event.key;
  if (['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'Tab'].includes(key)) return '';
  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  let name = key === ' ' ? 'Space' : key;
  if (name.length === 1) name = name.toUpperCase();
  parts.push(name);
  return parts.join('+');
}

function shortcutLabel(combo) {
  if (combo === 'Space') return ['空格'];
  const parts = combo.split('+');
  const last = parts.pop();
  const names = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', Enter: 'Enter', Backspace: '⌫' };
  return [...parts, names[last] || last];
}

const SHORTCUT_ACTIONS = {
  playPause: '播放 / 暂停',
  seekBack: '快退 5 秒',
  seekForward: '快进 5 秒',
  volumeUp: '音量增大',
  volumeDown: '音量减小',
  prev: '上一首',
  next: '下一首',
  mute: '静音',
  favorite: '喜爱当前歌曲',
  lyrics: '打开 / 关闭歌词界面',
  queue: '播放队列',
  shuffle: '随机播放',
  repeat: '切换循环模式',
  search: '搜索',
  fullscreen: '窗口全屏'
};

function renderShortcutRows() {
  const list = $('#shortcutList');
  if (!list) return;
  const keys = shortcutMap();
  list.innerHTML = Object.keys(SHORTCUT_ACTIONS).map(action => `
    <div class="shortcut-row" data-shortcut="${action}" title="点击后按下新的按键组合">
      <span>${SHORTCUT_ACTIONS[action]}</span>
      ${shortcutLabel(keys[action]).map(part => `<kbd>${escapeHtml(part)}</kbd>`).join('')}
    </div>`).join('');
}

function initShortcutRebinding() {
  const list = $('#shortcutList');
  if (!list) return;
  renderShortcutRows();
  list.addEventListener('click', event => {
    const row = event.target.closest('[data-shortcut]');
    if (!row || row.classList.contains('capturing')) return;
    row.classList.add('capturing');
    row.innerHTML = `<span>${SHORTCUT_ACTIONS[row.dataset.shortcut]}</span><kbd>按下新的按键…</kbd>`;
    const onKey = keyEvent => {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      if (keyEvent.key === 'Escape') {
        document.removeEventListener('keydown', onKey, true);
        renderShortcutRows();
        return;
      }
      const combo = formatShortcutKey(keyEvent);
      if (!combo) return;
      state.prefs.shortcutKeys = { ...(state.prefs.shortcutKeys || {}), [row.dataset.shortcut]: combo };
      savePrefs();
      document.removeEventListener('keydown', onKey, true);
      renderShortcutRows();
      showToast(`已把「${SHORTCUT_ACTIONS[row.dataset.shortcut]}」设置为 ${shortcutLabel(combo).join(' + ')}`);
    };
    document.addEventListener('keydown', onKey, true);
  });
  $('#resetShortcuts')?.addEventListener('click', () => {
    state.prefs.shortcutKeys = {};
    savePrefs();
    renderShortcutRows();
    showToast('已恢复默认快捷键');
  });
}

// ---------- 歌曲详情 ----------
let infoTrackId = null;

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (!value) return '未知';
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function openInfoModal(id) {
  const track = getTrack(id);
  if (!track) return;
  infoTrackId = id;
  const tech = track._tech || {};
  const duration = Number(track.duration) || 0;
  const size = Number(track._size) || 0;
  const bitrate = duration && size ? Math.round((size * 8) / duration / 1000) : 0;
  $('#infoTitle').textContent = track.title;
  const rows = [
    ['歌手', track.artist],
    ['专辑', track.album],
    ['格式', track.format + (lossless(track.format) ? '（无损）' : '')],
    ['时长', duration ? formatTime(duration) : '未知'],
    ['文件大小', formatBytes(size)],
    ['平均码率', bitrate ? `${bitrate} kbps` : '未知'],
    ['采样率', tech.sampleRate ? `${(tech.sampleRate / 1000).toFixed(tech.sampleRate % 1000 ? 1 : 0)} kHz` : '未知'],
    ['声道', tech.channels ? (tech.channels === 1 ? '单声道' : `${tech.channels} 声道`) : '未知'],
    ['位深', tech.bits ? `${tech.bits} bit` : '未知'],
    ['文件位置', track._path || '（内存中的文件）']
  ];
  $('#infoPanel').innerHTML = rows.map(([label, value]) => `
    <div class="info-row"><span>${escapeHtml(label)}</span><b title="${escapeHtml(String(value))}">${escapeHtml(String(value || '未知'))}</b></div>`).join('');
  $('#infoModal').showModal();
}

// ---------- 编辑歌曲信息 ----------
let editingTrackId = null;
let editingCoverUrl = '';

function openEditModal(id) {
  const track = getTrack(id);
  if (!track) return;
  editingTrackId = id;
  editingCoverUrl = track.cover || '';
  $('#editTitle').value = track.title || '';
  $('#editArtist').value = track.artist || '';
  $('#editAlbum').value = track.album || '';
  $('#editCoverPreview').src = editingCoverUrl || DEFAULT_COVER;
  const info = $('#infoModal');
  if (info?.open) info.close();
  $('#editModal').showModal();
}

/**
 * 统一的「选一张图当封面」流程：弹系统选图 → 存进封面目录 → 返回可用地址。
 * 用户取消、或保存失败（已 toast）都返回 null。
 * 歌曲封面和歌单封面原来各写一遍这段一模一样的代码。
 */
async function chooseCoverImage() {
  const picked = await window.orangeDesktop?.pickImage?.();
  if (!picked) return null;
  const saved = await window.orangeDesktop?.saveImageAsCover?.(picked);
  if (!saved) {
    showToast('封面保存失败');
    return null;
  }
  return saved;
}

async function pickEditCover() {
  const saved = await chooseCoverImage();
  if (!saved) return;
  editingCoverUrl = saved;
  $('#editCoverPreview').src = saved;
}

function saveEditForm(event) {
  event.preventDefault();
  const track = getTrack(editingTrackId);
  if (!track) return;
  track.title = $('#editTitle').value.trim() || track.title;
  track.artist = $('#editArtist').value.trim() || '未知音乐人';
  track.album = $('#editAlbum').value.trim() || track.album;
  // 点「恢复默认」后 editingCoverUrl 是空串，这里必须真的换回默认封面；
  // 写成 `|| track.cover` 会让「恢复默认」静默失效。
  track.cover = editingCoverUrl || DEFAULT_COVER;
  track._edited = true;
  saveLibrary();
  renderAll();
  if (state.currentId === track.id) updatePlayerUi();
  $('#editModal').close();
  showToast('歌曲信息已更新');
}

// ---------- 重复歌曲 ----------
let duplicateGroups = [];

function normalizeForDupe(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '').replace(/[（(].*?[)）]/g, '');
}

function findDuplicateGroups() {
  const map = new Map();
  state.songs.forEach(song => {
    const key = `${normalizeForDupe(song.title)}|${normalizeForDupe(song.artist)}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(song);
  });
  return [...map.values()].filter(group => group.length > 1);
}

function openDupeModal() {
  duplicateGroups = findDuplicateGroups();
  const list = $('#dupeList');
  if (!duplicateGroups.length) {
    $('#dupeSummary').textContent = '没有发现重复歌曲';
    list.innerHTML = emptyHtml('资料库很干净', '没有标题和歌手都相同的歌曲');
    $('#dupeClean').disabled = true;
  } else {
    const total = duplicateGroups.reduce((sum, group) => sum + group.length - 1, 0);
    $('#dupeSummary').textContent = `发现 ${duplicateGroups.length} 组重复，共可清理 ${total} 首`;
    $('#dupeClean').disabled = false;
    list.innerHTML = duplicateGroups.map((group, index) => `
      <div class="dupe-group">
        <strong>${index + 1}. ${escapeHtml(group[0].title)} · ${escapeHtml(group[0].artist)}</strong>
        ${group.map((song, i) => `<div class="dupe-item ${i === 0 ? 'keep' : ''}">
          <span>${i === 0 ? '保留' : '清理'}</span>
          <b>${escapeHtml(song.format)} · ${formatTime(song.duration)} · ${escapeHtml((song._path || '').split(/[\\/]/).pop() || '未知文件')}</b>
        </div>`).join('')}
      </div>`).join('');
  }
  $('#dupeModal').showModal();
}

function cleanDuplicates() {
  if (!duplicateGroups.length) return;
  const removeIds = duplicateGroups.flatMap(group => group.slice(1).map(song => song.id));
  if (!window.confirm(`将移除 ${removeIds.length} 首重复歌曲（每组保留第一条），磁盘文件不会被删除。确定继续吗？`)) return;
  // 与「单曲移除」走同一份摘除规则，避免两边漏删不同的集合
  removeIds.forEach(id => detachTrack(id));
  if (!getTrack(state.currentId)) {
    audio.pause();
    audio.removeAttribute('src');
    state.currentId = state.songs[0]?.id || null;
    state.playing = false;
  }
  saveState();
  saveProgress();
  saveLibrary();
  updatePlayerUi();
  renderAll();
  pruneOrphanCovers();
  $('#dupeModal').close();
  showToast(`已清理 ${removeIds.length} 首重复歌曲`);
}

// ---------- 歌单：重命名 / 封面 / 导出 / 导入 ----------
let editingPlaylistId = null;
let editingPlaylistCover = '';

function openPlaylistEdit(id) {
  const playlist = state.playlists.find(item => item.id === id);
  if (!playlist) return;
  editingPlaylistId = id;
  editingPlaylistCover = playlist.cover || '';
  $('#playlistEditName').value = playlist.name;
  $('#playlistEditCover').src = editingPlaylistCover || DEFAULT_COVER;
  $('#playlistEditModal').showModal();
}

function savePlaylistEdit(event) {
  event.preventDefault();
  const playlist = state.playlists.find(item => item.id === editingPlaylistId);
  if (!playlist) return;
  playlist.name = $('#playlistEditName').value.trim() || playlist.name;
  playlist.cover = editingPlaylistCover || '';
  saveState();
  renderPlaylists();
  $('#playlistEditModal').close();
  showToast('歌单已更新');
}

async function exportPlaylist(id) {
  const playlist = state.playlists.find(item => item.id === id);
  if (!playlist) return;
  const songs = playlist.tracks.map(getTrack).filter(Boolean);
  if (!songs.length) {
    showToast('这个歌单还是空的');
    return;
  }
  const content = ['#EXTM3U', ...songs.map(song => (song._path ? song._path.replace(/\\/g, '/') : `# ${song.title} - ${song.artist}`))].join('\r\n');
  const saved = await window.orangeDesktop?.saveM3u?.({ name: playlist.name, content });
  showToast(saved ? '歌单已导出' : '已取消导出');
}

async function importM3u() {
  const result = await window.orangeDesktop?.openM3u?.();
  if (!result || !result.entries?.length) {
    showToast('没有读取到歌单内容');
    return;
  }
  const known = new Map(state.songs.filter(song => song._path).map(song => [song._path.toLowerCase(), song.id]));
  const missing = result.entries.filter(entry => !known.has(entry.toLowerCase()));
  if (missing.length && window.orangeDesktop?.readPathsMeta) {
    const meta = await window.orangeDesktop.readPathsMeta(missing).catch(() => []);
    for (const record of meta) {
      const song = await songFromScanRecord(record);
      if (song) known.set(record.path.toLowerCase(), song.id);
    }
  }
  const tracks = result.entries.map(entry => known.get(entry.toLowerCase())).filter(Boolean);
  if (!tracks.length) {
    showToast('歌单里的歌曲没有找到');
    return;
  }
  const playlist = { id: `p${Date.now()}`, name: result.name || '导入的歌单', tracks };
  state.playlists.push(playlist);
  saveState();
  saveLibrary();
  renderAll();
  showPage('library');
  showTab('playlists');
  showToast(`已导入歌单，共 ${tracks.length} 首`);
  openPlaylistPage(playlist.id);
}

// ---------- 自动扫描 ----------
function renderWatchList() {
  const list = $('#watchList');
  if (!list) return;
  const folders = state.prefs.watchFolders || [];
  list.innerHTML = folders.length
    ? folders.map((folder, index) => `
      <div class="watch-row">
        <svg class="icon"><use href="#i-folder"/></svg>
        <span title="${escapeHtml(folder)}">${escapeHtml(folder)}</span>
        <button class="icon-button danger" data-remove-folder="${index}" title="移除"><svg class="icon"><use href="#i-trash"/></svg></button>
      </div>`).join('')
    : '<div class="watch-empty">还没有添加文件夹，点右上角「添加文件夹」选择音乐目录</div>';
}

async function addWatchFolder() {
  const picked = await window.orangeDesktop?.pickFolder?.();
  if (!picked?.length) return;
  const folders = new Set([...(state.prefs.watchFolders || []), ...picked]);
  state.prefs.watchFolders = [...folders];
  savePrefs();
  renderWatchList();
  showToast(`已添加 ${picked.length} 个文件夹`);
}

/**
 * 把一条扫描结果转成资料库歌曲。
 * @param {object} record scan-folders 返回的记录
 * @param {Set<string>} [knownPaths] 已收录路径（小写）集合；传入可避免对每一条都遍历整个资料库
 */
async function songFromScanRecord(record, knownPaths) {
  if (!record || !record.path || record.error) return null;
  const key = record.path.toLowerCase();
  // 资料库里已有同一路径就跳过
  if (knownPaths) {
    if (knownPaths.has(key)) return null;
  } else if (state.songs.some(song => String(song._path || '').toLowerCase() === key)) {
    return null;
  }
  if (state.prefs.onlySongs && !looksLikeSong({
    name: record.fileName || record.path,
    filePath: record.path,
    metadata: { title: record.hasTags ? record.title : '', artist: record.hasTags ? record.artist : '', album: record.hasTags ? record.album : '' },
    seconds: record.duration
  })) return null;
  const song = {
    id: `f${Date.now()}${state.songs.length}`,
    title: record.title || splitFileName(record.fileName).title,
    artist: record.artist || '未知音乐人',
    album: record.album || '本地文件',
    format: record.format || 'AUDIO',
    duration: Number(record.duration) || 0,
    cover: record.cover || DEFAULT_COVER,
    source: '自动扫描',
    // _src 交给 resolveTrackSource() 在播放时惰性解析，扫描时不再逐首发 IPC
    _src: '',
    _path: record.path,
    _lyrics: Array.isArray(record.lyrics) ? record.lyrics : [],
    _size: Number(record.size) || 0,
    _tech: record.tech || {},
    _replayGain: Number.isFinite(Number(record.replayGain)) ? Number(record.replayGain) : null
  };
  state.songs.push(song);
  state.queue.push(song.id);
  knownPaths?.add(key);
  return song;
}

async function runAutoScan({ silent = false } = {}) {
  const folders = state.prefs.watchFolders || [];
  if (!folders.length || !window.orangeDesktop?.scanFolders) {
    if (!silent) showToast('请先在设置里添加要扫描的文件夹');
    return 0;
  }
  if (!silent) showToast('正在扫描文件夹…');
  // 已收录路径先建表：一方面主进程可以直接跳过这些文件（不用重新解析标签 / 抽封面），
  // 另一方面下面 songFromScanRecord 也复用它，避免对每条记录遍历一次资料库。
  const knownPaths = new Set(state.songs.map(song => String(song._path || '').toLowerCase()).filter(Boolean));
  const records = await window.orangeDesktop.scanFolders(folders, [...knownPaths]).catch(() => []);
  let added = 0;
  for (const record of records) {
    if (await songFromScanRecord(record, knownPaths)) added += 1;
  }
  if (added) {
    saveLibrary();
    renderAll();
    updatePlayerUi();
    pruneOrphanCovers();
  }
  if (!silent) showToast(added ? `扫描完成，新增 ${added} 首歌曲` : '扫描完成，没有发现新歌曲');
  else if (added) showToast(`自动扫描新增 ${added} 首歌曲`);
  return added;
}

function bindSwitch(selector, key, onChange) {
  const input = $(selector);
  if (!input) return;
  input.checked = Boolean(state.prefs[key]);
  input.addEventListener('change', () => {
    state.prefs[key] = input.checked;
    savePrefs();
    if (typeof onChange === 'function') onChange(input.checked);
  });
}

function applyLyricSize() {
  const size = Number(state.prefs.lyricsSize) || 30;
  const player = $('#fullPlayer');
  if (player) player.style.setProperty('--lyric-base', `${size}px`);
  const output = $('#lyricSizeValue');
  if (output) output.textContent = `${size} px`;
  const slider = $('#lyricSize');
  if (slider && Number(slider.value) !== size) slider.value = size;
}

// ---------- 主题颜色：自定义色盘 ----------
// 色盘只挑一个「主色」，底色 / 面板 / 边线再由主色的色相按同一套浅色公式推导，
// 这样自定义配色和内置那七套一样是成套的，不会出现「主色变了底色还是灰白」的割裂感。
const DEFAULT_CUSTOM_THEME = { hue: 5.2, sat: 78.9, light: 57.3, tint: 62 };
const CUSTOM_THEME_STYLE_ID = 'customThemeStyle';

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

// h: 0-360，s / l: 0-100
function hslToRgb(hue, sat, light) {
  const h = ((Number(hue) % 360) + 360) % 360;
  const s = clampNumber(sat, 0, 100) / 100;
  const l = clampNumber(light, 0, 100) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const table = h < 60 ? [c, x, 0]
    : h < 120 ? [x, c, 0]
      : h < 180 ? [0, c, x]
        : h < 240 ? [0, x, c]
          : h < 300 ? [x, 0, c]
            : [c, 0, x];
  return table.map(value => Math.round((value + m) * 255));
}

function rgbToHex(rgb) {
  return `#${rgb.map(value => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('')}`;
}

function rgbToHsl(rgb) {
  const [r, g, b] = rgb.map(value => value / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = (max + min) / 2;
  const delta = max - min;
  if (!delta) return [0, 0, light * 100];
  const sat = light > .5 ? delta / (2 - max - min) : delta / (max + min);
  let hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return [hue, sat * 100, light * 100];
}

function hexToRgb(hex) {
  let value = String(hex || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(value)) value = [...value].map(char => char + char).join('');
  if (!/^[0-9a-f]{6}$/i.test(value)) return null;
  return [0, 2, 4].map(index => parseInt(value.slice(index, index + 2), 16));
}

function customThemeSource() {
  const rawHue = Number(state.prefs.customThemeHue);
  return {
    // 色相按 360 取模而不是硬切，−30° 该落在 330°（品红）而不是 0°（红）
    hue: Number.isFinite(rawHue) ? ((rawHue % 360) + 360) % 360 : DEFAULT_CUSTOM_THEME.hue,
    sat: clampNumber(state.prefs.customThemeSat, 0, 100),
    light: clampNumber(state.prefs.customThemeLight, 26, 76),
    tint: clampNumber(state.prefs.customThemeTint, 0, 100)
  };
}

// 由主色推出一整套界面色。k = 整体着色程度：
// 「界面着色」线性控制，同时被主色鲜艳度调制——主色越灰，界面越接近中性白
//（滑到 0 就是「默认白」那种感觉）。
// ⚠️ 亮度必须跟着 k 一起往下走。第一版把底色钉在 96%、面板钉在 99%，
// 结果连 100% 饱和度染上去也只是「白里带一点点」，看上去跟没变一样。
function themePaletteFrom(source) {
  const { hue, sat, light, tint } = source;
  const h = hue.toFixed(1);
  // 主色越灰越不该往界面上染色，所以直接乘主色饱和度；着色滑到 0 则完全退回中性白。
  // 1.3 是「标准档」补偿——着色默认 62% 时正好约等于内置彩色主题的浓度。
  const k = Math.min(1, (tint / 100) * (sat / 100) * 1.3);
  // 每个槽位给一对「满着色时的饱和度 / 亮度」，再按 k 插值。
  const slot = (fullSat, fullLight, drop) =>
    `hsl(${h} ${(fullSat * k).toFixed(1)}% ${(fullLight - drop * k).toFixed(1)}%)`;
  return {
    accent: `hsl(${h} ${sat.toFixed(1)}% ${light.toFixed(1)}%)`,
    // 底色＝页面背景，要最明显
    bg: slot(100, 96.4, 3.8),
    // 面板/卡片保持近白，只借一点色相，避免整块界面糊成一片
    surface: slot(100, 99.3, 1.2),
    surface2: slot(95, 95.3, 2.6),
    surface3: slot(92, 91.0, 2.2),
    line: slot(78, 90.0, 1.4),
    deep: slot(40, 13.5, 0)
  };
}

function customThemePalette() {
  return themePaletteFrom(customThemeSource());
}

function customThemeHex(source = customThemeSource()) {
  return rgbToHex(hslToRgb(source.hue, source.sat, source.light));
}

// 变量的注入点：运行时往 <head> 追加一个 <style>，永远排在 styles.css 之后，
// 于是 theme-custom 能盖掉 :root / body.dark 上的同名变量。
// 注意 styles.css 2879 行把页面背景写成了
//   html, body { background: var(--surface) !important; }
// 内置主题的 --surface 是 98% 亮度、饱和度却拉满的浅色调，所以肉眼能看出换肤；
// 自定义主题如果照抄这个槽位，背景只会是「白里透一点点」。这里额外补一条
// 背景改读 --bg（那个槽位压得更深），让自定义主题的背景变化看得见。
function ensureCustomThemeStyle() {
  let node = document.getElementById(CUSTOM_THEME_STYLE_ID);
  if (!node) {
    node = document.createElement('style');
    node.id = CUSTOM_THEME_STYLE_ID;
    document.head.appendChild(node);
  }
  return node;
}

// 色盘 / 色值框 / 滑块 / 预览条与当前配色对齐
function syncThemePicker(palette) {
  const source = customThemeSource();
  const wheel = $('#colorWheel');
  const knob = $('#colorWheelKnob');
  if (wheel) {
    wheel.setAttribute('aria-valuenow', String(Math.round(source.hue)));
    wheel.setAttribute('aria-valuetext', `${Math.round(source.hue)}°，饱和度 ${Math.round(source.sat)}%`);
  }
  if (knob) {
    // 与 CSS 里手柄的 44% 半径映射保持一致：色相 = 角度、饱和度 = 半径
    const radian = source.hue * Math.PI / 180;
    const radius = 44 * source.sat / 100;
    knob.style.left = `${(50 + Math.cos(radian) * radius).toFixed(2)}%`;
    knob.style.top = `${(50 + Math.sin(radian) * radius).toFixed(2)}%`;
    knob.style.background = palette.accent;
  }
  const core = $('#colorWheelCore');
  if (core) core.style.background = palette.accent;
  const dot = $('#themeColorDot');
  if (dot) dot.style.background = palette.accent;
  const hexInput = $('#themeHexInput');
  if (hexInput && document.activeElement !== hexInput) hexInput.value = customThemeHex(source);
  [['#themeLight', source.light], ['#themeTint', source.tint]].forEach(([selector, value]) => {
    const input = $(selector);
    // 正在拖的时候别回写，否则会和用户的手抢
    if (input && document.activeElement !== input) input.value = String(Math.round(value));
    const output = $(`${selector}Value`);
    if (output) output.textContent = `${Math.round(value)}%`;
  });
  const preview = $('#themeMiniPreview');
  if (preview) {
    const colors = {
      bg: palette.bg,
      surface: palette.surface,
      surface2: palette.surface2,
      line: palette.line,
      deep: palette.deep,
      accent: palette.accent
    };
    $$('span[data-theme-role]', preview).forEach(chip => {
      chip.style.background = colors[chip.dataset.themeRole] || '';
    });
  }
}

function applyThemeColor() {
  const selected = state.prefs.themeColor;
  const custom = selected === 'custom';
  const theme = THEME_COLORS.includes(selected) ? selected : 'default';
  const palette = customThemePalette();
  // html 和 body 都要挂：html 决定画布底色（超长页面/弹性回弹时能看到），
  // body 决定内容区底色，两边不同步就会露出色差。
  document.documentElement.classList.toggle('theme-custom', custom);
  document.body.classList.toggle('theme-custom', custom);
  THEME_COLORS.forEach(name => document.body.classList.toggle(`theme-${name}`, !custom && name === theme));
  ensureCustomThemeStyle().textContent = custom
    ? `:root.theme-custom,body.theme-custom{--bg:${palette.bg};--surface:${palette.surface};--surface-2:${palette.surface2};--surface-3:${palette.surface3};--line:${palette.line};--accent:${palette.accent};--deep:${palette.deep};background:var(--bg) !important;}`
    : '';
  // 「自定义」色块本身也显示当前这套配色
  const icon = $('#themeSwatches .theme-swatch[data-theme="custom"] i');
  if (icon) {
    icon.style.setProperty('--sw-bg', palette.bg);
    icon.style.setProperty('--sw-accent', palette.accent);
  }
  $$('#themeSwatches .theme-swatch').forEach(button => {
    button.classList.toggle('active', button.dataset.theme === selected);
  });
  const picker = $('#themePicker');
  if (picker) {
    const wasHidden = picker.hidden;
    picker.hidden = !custom;
    // 刚从收起切到展开时把面板带进视野（拖滑块时不会重复触发）
    if (custom && wasHidden) picker.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  syncThemePicker(palette);
}

// 改主色时统一走这里：自动切到「自定义」并落盘
function setCustomTheme(partial) {
  Object.assign(state.prefs, partial, { themeColor: 'custom' });
  applyThemeColor();
  savePrefs();
}

function initThemePicker() {
  const wheel = $('#colorWheel');
  if (wheel) {
    let dragging = false;
    const pickFromEvent = event => {
      const rect = wheel.getBoundingClientRect();
      const half = rect.width / 2;
      if (!half) return;
      const dx = event.clientX - (rect.left + half);
      const dy = event.clientY - (rect.top + half);
      // 色相环 0° 在右侧、顺时针递增，正好和 atan2 的屏幕坐标一致
      let hue = Math.atan2(dy, dx) * 180 / Math.PI;
      if (hue < 0) hue += 360;
      const sat = Math.min(1, Math.hypot(dx, dy) / (half * .88)) * 100;
      setCustomTheme({ customThemeHue: hue, customThemeSat: sat });
    };
    wheel.addEventListener('pointerdown', event => {
      dragging = true;
      if (wheel.setPointerCapture) wheel.setPointerCapture(event.pointerId);
      pickFromEvent(event);
      event.preventDefault();
    });
    wheel.addEventListener('pointermove', event => {
      if (dragging) pickFromEvent(event);
    });
    const release = event => {
      if (!dragging) return;
      dragging = false;
      if (wheel.hasPointerCapture && wheel.hasPointerCapture(event.pointerId)) {
        wheel.releasePointerCapture(event.pointerId);
      }
    };
    wheel.addEventListener('pointerup', release);
    wheel.addEventListener('pointercancel', release);
    // 键盘也能转色相，方向键微调、按住 Shift 走大步
    wheel.addEventListener('keydown', event => {
      const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
      if (!keys.includes(event.key)) return;
      const step = event.shiftKey ? 10 : 2;
      const forward = event.key === 'ArrowRight' || event.key === 'ArrowUp';
      const source = customThemeSource();
      const hue = ((source.hue + (forward ? step : -step)) % 360 + 360) % 360;
      setCustomTheme({ customThemeHue: hue });
      event.preventDefault();
    });
  }
  const hexInput = $('#themeHexInput');
  if (hexInput) {
    hexInput.addEventListener('change', () => {
      const rgb = hexToRgb(hexInput.value);
      if (!rgb) {
        // 输错了就滚回当前色，不做任何改动
        hexInput.value = customThemeHex();
        return;
      }
      const [hue, sat, light] = rgbToHsl(rgb);
      setCustomTheme({
        customThemeHue: hue,
        customThemeSat: sat,
        customThemeLight: clampNumber(light, 26, 76)
      });
    });
  }
  const resetButton = $('#themeResetBtn');
  if (resetButton) {
    resetButton.addEventListener('click', () => setCustomTheme({
      customThemeHue: DEFAULT_CUSTOM_THEME.hue,
      customThemeSat: DEFAULT_CUSTOM_THEME.sat,
      customThemeLight: DEFAULT_CUSTOM_THEME.light,
      customThemeTint: DEFAULT_CUSTOM_THEME.tint
    }));
  }
  bindRange('#themeLight', 'customThemeLight', value => `${value}%`, () => setCustomTheme({}), { number: true });
  bindRange('#themeTint', 'customThemeTint', value => `${value}%`, () => setCustomTheme({}), { number: true });
}

function applySidebarStyle() {
  const effect = state.prefs.sidebarEffect || 'blur';
  const blur = Number(state.prefs.sidebarBlur ?? 26);
  const alpha = Math.min(1, Math.max(.1, Number(state.prefs.sidebarOpacity ?? 78) / 100));
  [$('.sidebar'), $('#titlebar')].forEach(element => {
    if (!element) return;
    element.dataset.effect = effect;
    element.style.setProperty('--chrome-blur', `${blur}px`);
    element.style.setProperty('--chrome-alpha', alpha);
  });
  const blurValue = $('#sidebarBlurValue');
  const opacityValue = $('#sidebarOpacityValue');
  if (blurValue) blurValue.textContent = `${blur} px`;
  if (opacityValue) opacityValue.textContent = `${Math.round(alpha * 100)}%`;
}

function initSettings() {
  bindSwitch('#fadeToggle', 'fade');
  bindSwitch('#resumeToggle', 'resume');
  bindSwitch('#autoNextToggle', 'autoNext');
  bindSwitch('#waveformToggle', 'waveform', value => {
    document.body.classList.toggle('show-waveform', value);
  });
  bindSwitch('#shortcutToggle', 'shortcuts');
  bindSwitch('#lyricBackdropToggle', 'lyricBackdrop', value => {
    document.body.classList.toggle('no-cover-backdrop', !value);
  });
  bindSwitch('#bgGlowToggle', 'bgGlow', value => {
    document.body.classList.toggle('no-bg-glow', !value);
  });
  bindSwitch('#autoplayImportToggle', 'autoplayImport');
  bindSwitch('#onlySongsToggle', 'onlySongs');
  bindSwitch('#restoreToggle', 'restoreLastTrack');

  const minSeconds = $('#minSongSeconds');
  const minSecondsValue = $('#minSongSecondsValue');
  if (minSeconds) {
    minSeconds.value = state.prefs.minSongSeconds;
    if (minSecondsValue) minSecondsValue.textContent = `${state.prefs.minSongSeconds} 秒`;
    minSeconds.addEventListener('input', () => {
      state.prefs.minSongSeconds = Number(minSeconds.value);
      if (minSecondsValue) minSecondsValue.textContent = `${state.prefs.minSongSeconds} 秒`;
      savePrefs();
    });
  }

  const lyricSlider = $('#lyricSize');
  if (lyricSlider) {
    lyricSlider.value = state.prefs.lyricsSize;
    lyricSlider.addEventListener('input', () => {
      state.prefs.lyricsSize = Number(lyricSlider.value);
      applyLyricSize();
      savePrefs();
    });
  }
  applyLyricSize();
  // 歌词界面「立体向内倾斜 + 投影」
  bindSwitch('#tiltLyricsToggle', 'tiltLyrics', applyTiltEffect);
  bindSwitch('#tiltStageToggle', 'tiltStage', applyTiltEffect);
  // 歌词界面「氛围灯」（左右各一片，独立开关）
  bindSwitch('#ambientLightToggle', 'ambientLight', applyAmbientLight);
  bindSwitch('#ambientLeftToggle', 'ambientLeft', applyAmbientLight);
  // 「闪光跃动」：氛围灯动态模式开关（默认关 = 加鼓点响应之前的柔和经典版）
  bindSwitch('#ambientFlashToggle', 'ambientFlash', applyAmbientLight);
  // 氛围灯动态强度（设置页滑块 + 歌词右键菜单滑块，无级可调）
  bindAmbientPower();
  // 双语歌词：默认只显示原文，打开后连译文一起显示
  bindSwitch('#lyricTranslationToggle', 'lyricTranslation', applyLyricTranslation);
  // 关掉后再打开：之前判定「查过了没歌词」的标记要清掉，否则这首永远不重试
  bindSwitch('#lrclibToggle', 'lrclib', enabled => {
    if (!enabled) return;
    for (const song of [...state.songs, ...state.online]) {
      if (song._lyricSource === 'lrclib' || song._lyricSource === 'lrclib-plain') continue;
      song._lyrclibTried = false;
    }
  });
  bindRange('#tiltAngle', 'tiltAngle', value => `${value}°`, () => {
    applyTiltEffect();
    savePrefs();
  }, { number: true });
  [['#tiltLyricsDir', 'tiltLyricsDir'], ['#tiltStageDir', 'tiltStageDir']].forEach(([selector, key]) => {
    const select = $(selector);
    if (!select) return;
    select.value = tiltDir(key);
    // 下拉是明确操作，不再额外弹提示，避免和菜单里的提示重复
    select.addEventListener('change', () => setTiltDir(key, select.value, true));
  });
  bindSettingsControls();
  const sidebarEffect = $('#sidebarEffect');
  const sidebarBlur = $('#sidebarBlur');
  const sidebarOpacity = $('#sidebarOpacity');
  if (sidebarEffect && sidebarBlur && sidebarOpacity) {
    sidebarEffect.value = state.prefs.sidebarEffect;
    sidebarBlur.value = state.prefs.sidebarBlur;
    sidebarOpacity.value = state.prefs.sidebarOpacity;
    sidebarEffect.addEventListener('change', () => {
      state.prefs.sidebarEffect = sidebarEffect.value;
      applySidebarStyle();
      savePrefs();
    });
    sidebarBlur.addEventListener('input', () => {
      state.prefs.sidebarBlur = Number(sidebarBlur.value);
      applySidebarStyle();
      savePrefs();
    });
    sidebarOpacity.addEventListener('input', () => {
      state.prefs.sidebarOpacity = Number(sidebarOpacity.value);
      applySidebarStyle();
      savePrefs();
    });
  }
  initThemePicker();
  $$('#themeSwatches .theme-swatch').forEach(button => {
    button.addEventListener('click', () => {
      state.prefs.themeColor = button.dataset.theme;
      applyThemeColor();
      applySidebarStyle();
      savePrefs();
    });
  });
  applyThemeColor();
  applySidebarStyle();
  document.body.classList.toggle('no-cover-backdrop', !state.prefs.lyricBackdrop);
  document.body.classList.toggle('no-bg-glow', state.prefs.bgGlow === false);
  document.body.classList.toggle('show-waveform', Boolean(state.prefs.waveform));
  initPlayerStyleControls();
  initDesktopLyricsControls();
  initSettingsNav();
}

/**
 * 设置页左侧分类导航：点击滚到对应分区，滚动时高亮当前分区。
 * 滚动容器是 .main-content（整窗不滚动），所以用它的 scrollTop 而不是 window。
 */
function initSettingsNav() {
  const scroller = $('.main-content');
  const nav = $('#settingsNav');
  const body = $('#settingsBody');
  if (!scroller || !nav || !body) return;

  const sections = $$('#settingsBody [data-settings-section]');
  if (!sections.length) return;
  const keyOf = section => section.dataset.settingsKey || section.id;
  const items = $$('.settings-nav-item', nav);

  const setActive = key => {
    items.forEach(item => item.classList.toggle('active', item.dataset.jump === key));
  };

  items.forEach(item => {
    item.addEventListener('click', () => {
      const section = sections.find(entry => keyOf(entry) === item.dataset.jump);
      if (!section) return;
      const offset = section.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      // 留 2px 余量：滚到正好贴边时 sticky 的判定会抖动，往下一格更稳
      scroller.scrollTo({ top: scroller.scrollTop + offset - 2, behavior: 'smooth' });
      setActive(item.dataset.jump);
    });
  });

  // 滚动时判断当前分区：取「顶部已越过视口上沿」的最后一个分区
  let ticking = false;
  const sync = () => {
    ticking = false;
    if (state.page !== 'settings') return;
    const line = scroller.getBoundingClientRect().top + 8;
    let current = sections[0];
    sections.forEach(section => {
      if (section.getBoundingClientRect().top <= line) current = section;
    });
    // 滚到底时最后几个分区可能都到不了判定线，强制选最后一个
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) {
      current = sections[sections.length - 1];
    }
    setActive(keyOf(current));
  };
  scroller.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(sync);
  }, { passive: true });

  // 进设置页时先把高亮摆到第一个分区（切页时内容区会滚回顶部）
  window.addEventListener('pagechange', event => {
    if (event.detail === 'settings') requestAnimationFrame(sync);
  });
  setActive(keyOf(sections[0]));
}

/** 桌面歌词设置项绑定：开关 + 各外观滑块/取色器，改动即推给悬浮窗 */
function initDesktopLyricsControls() {
  // 悬浮窗被外部关闭（点 ✕ / 托盘）时，同步主窗口的开关状态
  if (window.orangeDesktop?.onDesktopLyricsClosed) {
    window.orangeDesktop.onDesktopLyricsClosed(() => {
      desktopLyricsOpen = false;
      state.prefs.desktopLyrics = false;
      savePrefs();
      syncDesktopLyricsToggle();
      syncDesktopLyricsButton();
    });
  }
  // 悬浮窗点「设置」时，跳到设置页并定位到桌面歌词区块
  if (window.orangeDesktop?.onOpenDesktopLyricsSettings) {
    window.orangeDesktop.onOpenDesktopLyricsSettings(() => {
      showPage('settings');
      setTimeout(() => {
        const section = $('#desktopLyricsSection');
        if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 120);
    });
  }

  // 开关：显示/隐藏桌面歌词悬浮窗
  const toggle = $('#desktopLyricsToggle');
  if (toggle) {
    toggle.checked = Boolean(state.prefs.desktopLyrics);
    toggle.addEventListener('change', async () => {
      state.prefs.desktopLyrics = toggle.checked;
      savePrefs();
      await toggleDesktopLyrics(toggle.checked);
      syncDesktopLyricsToggle();
    });
  }
  // 各外观参数：改了就下发配置
  bindRange('#dlFontSize', 'dlFontSize', v => `${v} px`, () => { savePrefs(); pushDesktopLyricsConfig(); }, { number: true });
  bindRange('#dlTextDepth', 'dlTextDepth', v => `${v}%`, () => { savePrefs(); pushDesktopLyricsConfig(); }, { number: true });
  bindRange('#dlBlur', 'dlBlur', v => `${v} px`, () => { savePrefs(); pushDesktopLyricsConfig(); }, { number: true });
  bindRange('#dlOpacity', 'dlOpacity', v => `${v}%`, () => { savePrefs(); pushDesktopLyricsConfig(); }, { number: true });
  bindRange('#dlRadius', 'dlRadius', v => `${v} px`, () => { savePrefs(); pushDesktopLyricsConfig(); }, { number: true });

  const colorBind = (selector, key) => {
    const input = $(selector);
    if (!input) return;
    input.value = state.prefs[key] || (key === 'dlBgColor' ? '#121216' : '#ffffff');
    input.addEventListener('input', () => {
      state.prefs[key] = input.value;
      savePrefs();
      pushDesktopLyricsConfig();
    });
  };
  colorBind('#dlTextColor', 'dlTextColor');
  colorBind('#dlAccentColor', 'dlAccentColor');
  colorBind('#dlBgColor', 'dlBgColor');

  // 「背景颜色」的「自动」按钮：清空背景色，恢复「由歌词颜色自动推导深浅」
  const bgAutoBtn = $('#dlBgAuto');
  const bgColorInput = $('#dlBgColor');
  if (bgAutoBtn && bgColorInput) {
    bgAutoBtn.addEventListener('click', () => {
      state.prefs.dlBgColor = '';
      bgColorInput.value = '#121216'; // 仅作显示占位，实际 pref 为空走自动推导
      savePrefs();
      pushDesktopLyricsConfig();
    });
  }

  const align = $('#dlAlign');
  if (align) {
    align.value = state.prefs.dlAlign || 'center';
    align.addEventListener('change', () => {
      state.prefs.dlAlign = align.value;
      savePrefs();
      pushDesktopLyricsConfig();
    });
  }

  bindSwitch('#dlShowMetaToggle', 'dlShowMeta', () => pushDesktopLyricsConfig());
  bindSwitch('#dlLockedToggle', 'dlLocked', () => pushDesktopLyricsConfig());
}

/** 让设置页开关和悬浮窗实际开关状态保持一致 */
function syncDesktopLyricsToggle() {
  const toggle = $('#desktopLyricsToggle');
  if (toggle) toggle.checked = desktopLyricsOpen;
}

async function bootstrap() {
  const restored = await restoreLibrary().catch(() => 0);
  // 在线曲目的元数据由 online.js 管，它的恢复可能比这里晚。先把能恢复的先恢复，
  // 否则下面这段「清理失效 id」会把歌单里的网络歌曲当成脏数据整条删掉。
  if (typeof restoreOnlineTracks === 'function') restoreOnlineTracks();
  const keepId = id => {
    if (getTrack(id)) return true;
    // 在线曲目以 online: 开头（online:netease:12345）。元数据万一还没就位也先留着，
    // 等 online.js 恢复后自然就能查到；直接删掉才是真的丢数据。
    return typeof id === 'string' && id.startsWith('online:');
  };
  state.favorites = new Set([...state.favorites].filter(keepId));
  state.recent = state.recent.filter(keepId);
  // 歌单里可能留着已被移除 / 磁盘上已不存在的歌曲 id，启动时一并摘掉（只摘本地曲目）
  state.playlists.forEach(playlist => {
    playlist.tracks = playlist.tracks.filter(keepId);
  });
  if (restored) {
    saveState();
    saveLibrary();
    // 只有资料库确实读出来了才回收封面；读失败（restored = 0）时宁可什么都不做
    pruneOrphanCovers();
  }

  // 睡眠定时器是会话级的：上次关闭时即使还开着，重启后也不该显示「15 分钟」却根本不计时
  if (Number(state.prefs.sleepTimer)) {
    state.prefs.sleepTimer = 0;
    savePrefs();
  }

  const restoredTrackId = readStored('orange-last-track', '');
  bootResumeId = null;
  bootResumeUsed = false;
  if (state.prefs.restoreLastTrack && restoredTrackId && getTrack(restoredTrackId)) {
    state.currentId = restoredTrackId;
    // 只有「真正从上次播放记录恢复出来的那一首」才有资格续播
    bootResumeId = restoredTrackId;
  } else if (!getTrack(state.currentId)) {
    state.currentId = state.songs[0]?.id || null;
  }

  applyVolume();
  document.title = '';
  bindWindowControls();
  renderAll();
  updatePlayerUi();
  // 系统媒体控制：注册锁屏 / 音量弹窗 / 媒体键的回调（updatePlayerUi 里已经推过一次曲目信息）
  initMediaSession();

  const currentTrack = getTrack(state.currentId);
  if (currentTrack && !getLyrics(currentTrack).length && currentTrack._path) {
    currentTrack._lyricChecked = true;
    loadTrackLyrics(currentTrack).then(lines => {
      if (lines.length) {
        renderLyricSource();
        renderLyrics();
        pushDesktopLyricsState();
      }
    });
  }

  showTab('playlists');
  initSettings();
  syncTransportModes();
  applyPlaybackRate();
  applyEq();
  applyReplayGain(getTrack(state.currentId));
  updateKaraokeUi();
  initTitleBar();
  setTitleBarTone('main');
  initAutoScrollbar();
  relocateFullPlayerControls();
  drawVisualizer();

  if (restored) showToast(`已恢复 ${restored} 首本地歌曲`);
  if (state.prefs.autoScanOnStart && (state.prefs.watchFolders || []).length) {
    setTimeout(() => runAutoScan({ silent: true }), 1200);
  }

  // 上次关闭前开着桌面歌词的话，启动后自动恢复（窗口稍后一点再显示，避免抢焦点）
  if (state.prefs.desktopLyrics) {
    setTimeout(() => {
      toggleDesktopLyrics(true).then(syncDesktopLyricsToggle);
    }, 800);
  }
}
bootstrap();
