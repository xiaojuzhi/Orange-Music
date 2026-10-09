'use strict';

// 标签与歌词解析逻辑集中在 tags.js，主进程与渲染进程共用。
// 这里只解构本文件真正调用到的成员（原先把 tags.js 的 17 个导出全解构了，
// 其中 9 个在本文件里一次都没用到）。
const OrangeTags = window.OrangeTags || {};
const {
  decodeTextBuffer, readVorbisTags, readMp4Tags, readWavTags, readId3,
  parseLyrics, splitFileName, readTechInfo
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
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

const defaultPrefs = {
  fade: true,
  resume: true,
  autoNext: true,
  waveform: false,
  lyricsSize: 30,
  lyricBackdrop: true,
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
  eqPreset: 'flat',
  // 与 EQ_BANDS 一一对应的 10 段增益（旧版这里只写了 5 项，是均衡器的一个 bug，详见 normalizedEqGains）
  eqGains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
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
  sidebarOpacity: 78
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
  search: 'Ctrl+K'
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

const state = {
  page: 'home',
  tab: 'playlists',
  format: 'all',
  query: '',
  songs: [],
  favorites: new Set(readStored('orange-favorites', [])),
  recent: readStored('orange-recent', []),
  playlists: readStored('orange-playlists-clean', []),
  queue: [],
  currentId: null,
  playing: false,
  shuffle: false,
  repeat: 0,
  volume: .78,
  muted: false,
  progress: readStored('orange-progress', {}),
  prefs: { ...defaultPrefs, ...readStored('orange-prefs', {}) },
  recommendationOffset: 0,
  importedIds: [],
  pendingAddId: null,
  pendingAddIds: [],
  selectMode: false,
  selection: new Set(),
  lyricImportId: null,
  searchScope: 'all'
};

let demoUrl = null;
let demoForId = null;
let toastTimer = null;
let seeking = false;
let audioContext = null;
let analyser = null;
let ambientAnalyser = null;
let sourceNode = null;
let eqFilters = [];
let gainNode = null;
let fadeTimer = null;
let pendingResume = 0;
// 续播范围收窄：只有「本次启动、且正是上次关闭时在播的那一首」才恢复进度。
// 其余任何切歌 / 装载一律从 0:00 开始，避免每首歌都接着上次的位置播。
let bootResumeId = null;
let bootResumeUsed = false;
let lastProgressSave = 0;
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
  localStorage.setItem('orange-favorites', JSON.stringify([...state.favorites]));
  localStorage.setItem('orange-recent', JSON.stringify(state.recent));
  localStorage.setItem('orange-playlists-clean', JSON.stringify(state.playlists));
}

function savePrefs() {
  localStorage.setItem('orange-prefs', JSON.stringify(state.prefs));
}

function savePlaybackModes() {
  localStorage.setItem('orange-playback', JSON.stringify({ shuffle: state.shuffle, repeat: state.repeat }));
}

function saveProgress() {
  try {
    localStorage.setItem('orange-progress', JSON.stringify(state.progress));
  } catch {}
}

function songRecord(song) {
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
    lyricOffset: Number.isFinite(Number(song._lyricOffset)) && song._lyricOffset !== null ? Number(song._lyricOffset) : null
  };
}

function saveLibrary() {
  try {
    const records = state.songs.filter(song => song._path).map(songRecord);
    localStorage.setItem('orange-library', JSON.stringify(records));
    localStorage.setItem('orange-queue', JSON.stringify(state.queue.filter(id => getTrack(id))));
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
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || !record.path) continue;
    if (existing) {
      if (!existing[index]) continue;
    } else if (desktop?.pathExists) {
      const exists = await desktop.pathExists(record.path).catch(() => true);
      if (!exists) continue;
    }
    songs.push({
      id: record.id || `f${songs.length}${Date.now()}`,
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
      _lyricOffset: Number.isFinite(Number(record.lyricOffset)) && record.lyricOffset !== null && record.lyricOffset !== ''
        ? Number(record.lyricOffset)
        : null,
      _lyrics: []
    });
  }
  state.songs = songs;
  // 队列里只保留仍存在于资料库的 id。用 Set 查表，避免对每个队列项都遍历一次 songs
  const validIds = new Set(songs.map(song => song.id));
  const savedQueue = readStored('orange-queue', []).filter(id => validIds.has(id));
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
  }
  return lyrics;
}

// 读取歌词：内嵌标签优先，其次同名 lrc（重启后也能重新读到内嵌歌词）
async function loadTrackLyrics(track) {
  if (!track) return [];
  if (track._lyrics?.length) return track._lyrics;
  if (window.orangeDesktop?.readLyrics && track._path) {
    const result = await window.orangeDesktop.readLyrics(track._path).catch(() => null);
    if (result?.lyrics?.length) {
      track._lyrics = result.lyrics;
      track._lyricSource = result.source;
      track._lyricPath = result.path || '';
      return result.lyrics;
    }
  }
  return loadSidecarLyrics(track);
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
  return state.songs.find(song => song.id === id);
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
  const text = fallbackText || qualityLabel(track);
  badge.innerHTML = `<svg class="icon"><use href="#i-audio-lines"/></svg><b>${escapeHtml(text)}</b>`;
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

function trackRowHtml(track, index) {
  const favorite = state.favorites.has(track.id);
  const isCurrent = state.currentId === track.id;
  const selected = state.selection.has(track.id);
  return `
    <div class="track-row ${isCurrent ? 'playing' : ''} ${selected ? 'selected' : ''}" data-track="${track.id}">
      ${state.selectMode ? `<label class="row-check" title="选择"><input type="checkbox" data-select="${track.id}" ${selected ? 'checked' : ''} /></label>` : ''}
      <div class="track-index">
        <span>${String(index + 1).padStart(2,'0')}</span>
        <button class="icon-button row-play" data-play="${track.id}" aria-label="播放 ${escapeHtml(track.title)}">
          <svg class="icon filled"><use href="#${isCurrent && state.playing ? 'i-pause' : 'i-play'}"/></svg>
        </button>
      </div>
      <div class="track-main">
        <img src="${track.cover}" alt="" />
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
    const queryMatch = !query || [song.title,song.artist,song.album,song.format].some(value => value.toLowerCase().includes(query));
    return formatMatch && queryMatch;
  });
}

function cardHtml(track) {
  if (!track) return '';
  return `
    <article class="recommend-card" data-track-card="${track.id}" tabindex="0">
      <div class="recommend-cover">
        <img src="${track.cover}" alt="${escapeHtml(track.album)} 封面" />
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

function renderRecommendations() {
  const target = $('#recommendRow');
  if (!target) return;
  if (!state.songs.length) {
    target.innerHTML = emptyHtml('资料库还是空的', '导入本地音乐后这里会出现推荐卡片');
    return;
  }
  const list = [];
  for (let i = 0; i < 4; i += 1) {
    list.push(state.songs[(state.recommendationOffset + i) % state.songs.length]);
  }
  target.innerHTML = list.map(cardHtml).join('');
}

function renderFeature() {
  const card = $('#featureCard');
  if (!card) return;
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
  target.innerHTML = songs.length
    ? songs.map(trackRowHtml).join('')
    : emptyHtml('还没有喜爱的歌曲', '点击歌曲旁的心形按钮收藏');
}

function playlistCoverHtml(playlist) {
  const songs = playlist.tracks.map(getTrack).filter(Boolean).slice(0,4);
  if (!songs.length) {
    return `<div class="playlist-cover single"><div class="playlist-symbol"><svg class="icon"><use href="#i-list"/></svg></div></div>`;
  }
  if (songs.length === 1) return `<div class="playlist-cover single"><img src="${songs[0].cover}" alt="" /></div>`;
  return `<div class="playlist-cover">${songs.slice(0,4).map(song => `<img src="${song.cover}" alt="" />`).join('')}</div>`;
}

function renderPlaylists() {
  const grid = $('#playlistGrid');
  const side = $('#sidebarPlaylists');
  if (!grid && !side) return;
  const html = state.playlists.map(playlist => `
    <article class="playlist-card" data-playlist="${playlist.id}" tabindex="0">
      ${playlistCoverHtml(playlist)}
      <button class="playlist-play" data-play-playlist="${playlist.id}" aria-label="播放 ${escapeHtml(playlist.name)}">
        <svg class="icon"><use href="#i-play"/></svg>
      </button>
      <button class="playlist-delete" data-delete-playlist="${playlist.id}" aria-label="删除歌单 ${escapeHtml(playlist.name)}" title="删除歌单">
        <svg class="icon"><use href="#i-x"/></svg>
      </button>
      <button class="playlist-edit" data-edit-playlist="${playlist.id}" aria-label="编辑歌单" title="重命名 / 换封面">
        <svg class="icon"><use href="#i-audio-lines"/></svg>
      </button>
      <button class="playlist-export" data-export-playlist="${playlist.id}" aria-label="导出歌单" title="导出 m3u 歌单">
        <svg class="icon"><use href="#i-upload"/></svg>
      </button>
      <div class="playlist-info">
        <strong>${escapeHtml(playlist.name)}</strong>
        <span>${playlist.tracks.length} 首歌曲</span>
      </div>
    </article>`).join('');
  if (grid) grid.innerHTML = html || emptyHtml('还没有歌单', '新建一个歌单来整理音乐');
  if (side) side.innerHTML = state.playlists.map(playlist => `
    <button class="sidebar-link" data-play-playlist="${playlist.id}">
      <svg class="icon"><use href="#i-list"/></svg>${escapeHtml(playlist.name)}<span>${playlist.tracks.length}</span>
    </button>`).join('');
}

function renderAlbums() {
  const target = $('#albumGrid');
  if (!target) return;
  const map = new Map();
  state.songs.forEach(song => {
    if (!map.has(song.album)) map.set(song.album, []);
    map.get(song.album).push(song);
  });
  target.innerHTML = [...map.entries()].map(([album,songs]) => `
    <article class="album-card" data-track-card="${songs[0].id}" tabindex="0">
      <img src="${songs[0].cover}" alt="${escapeHtml(album)} 封面" />
      <button class="playlist-play" data-play="${songs[0].id}" aria-label="播放 ${escapeHtml(album)}">
        <svg class="icon"><use href="#i-play"/></svg>
      </button>
      <div class="playlist-info"><strong>${escapeHtml(album)}</strong><span>${songs.length} 首 · ${escapeHtml(songs[0].artist)}</span></div>
    </article>`).join('');
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
      <img src="${song.cover}" alt="" />
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
}

function renderImported() {
  const songs = state.importedIds.map(getTrack).filter(Boolean);
  const target = $('#importedTrackList');
  if (!target) return;
  target.innerHTML = songs.length
    ? songs.map(trackRowHtml).join('')
    : emptyHtml('还没有导入歌曲', '从上方选择歌曲或音乐文件夹开始扫描');
}

function renderSearchResults() {
  const target = $('#searchRecentRow');
  const heading = $('#searchHeading');
  if (!target || !heading) return;
  const query = state.query.trim().toLowerCase();
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
    if (scope === 'title') return song.title.toLowerCase().includes(query);
    if (scope === 'artist') return song.artist.toLowerCase().includes(query);
    if (scope === 'album') return song.album.toLowerCase().includes(query);
    return [song.title, song.artist, song.album, song.format].some(value => String(value).toLowerCase().includes(query));
  });
  heading.textContent = `搜索结果 · ${matches.length} 首`;
  if (!matches.length) {
    target.innerHTML = emptyHtml('没有找到歌曲', '换个关键词或切换筛选试试');
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
  renderQueue();
  renderCounts();
  renderSelectionUi();
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

function updatePlayerUi() {
  const track = getTrack(state.currentId);
  if (!track) {
    $('#miniCover').src = DEFAULT_COVER;
    $('#miniTitle').textContent = '未播放';
    $('#miniArtist').textContent = '导入歌曲后即可播放';
    $('#fullCover').src = DEFAULT_COVER;
    $('#fullTitle').textContent = '未播放';
    $('#fullArtist').textContent = '导入歌曲后即可播放';
    const emptyFormat = $('#fullFormat');
    if (emptyFormat) emptyFormat.textContent = '—';
    setQualityBadge(null, '暂无音轨');
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
    return;
  }
  $('#miniCover').src = track.cover;
  $('#miniTitle').textContent = track.title;
  $('#miniArtist').textContent = track.artist;
  $('#fullCover').src = track.cover;
  // 取封面主色写进 --cover-accent，供歌词倾斜的辉光上色
  applyCoverAccent(track.cover);
  applyLyricTheme();
  $('#fullTitle').textContent = track.title;
  $('#fullArtist').textContent = `${track.artist} · ${track.album}`;
  const formatLabel = $('#fullFormat');
  if (formatLabel) formatLabel.textContent = track.format;
  setQualityBadge(track);
  updateFavoriteUi();
  updatePlayIcons();
  renderLyrics();
  renderLocalTracks();
  renderFavorites();
  renderQueue();
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
    node.connect(gainNode);
    gainNode.connect(analyser);
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
  } catch (error) {
    console.warn('Visualizer unavailable', error);
  }
}

function applyEq() {
  if (!eqFilters.length) return;
  // 关闭均衡等价于「10 段全 0 dB」；开启时走归一化，避免旧数据缺项时写进 NaN
  const gains = state.prefs.eqEnabled ? normalizedEqGains() : EQ_BANDS.map(() => 0);
  eqFilters.forEach((filter, index) => {
    filter.gain.value = Math.max(-12, Math.min(12, gains[index]));
  });
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
  const source = changed ? await resolveTrackSource(track) : '';
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
    audio.src = source;
    audio.load();
    applyReplayGain(track);
    applyPlaybackRate();
    localStorage.setItem('orange-last-track', JSON.stringify(id));
    state.recent = [id, ...state.recent.filter(item => item !== id)].slice(0,12);
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
        showToast(track._lyricSource === 'embedded' ? '已读取歌曲内嵌歌词' : '已自动载入同名歌词文件');
      }
    });
  }
  ensureAudioGraph();
  if (audioContext?.state === 'suspended') await audioContext.resume();
  if (forcePlay) {
    try {
      if (state.prefs.fade) audio.volume = 0;
      await audio.play();
      state.playing = true;
      if (state.prefs.fade) fadeVolume(state.volume, fadeDuration());
      else applyVolume();
    } catch (error) {
      const recovered = await recoverUnsupportedTrack(track).catch(() => false);
      if (recovered) {
        audio.src = track._src;
        audio.load();
        try {
          if (state.prefs.fade) audio.volume = 0;
          await audio.play();
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
    playTrack(state.currentId);
    return;
  }
  if (audio.paused) {
    ensureAudioGraph();
    if (state.prefs.fade) audio.volume = 0;
    audio.play().then(() => {
      state.playing = true;
      updatePlayIcons();
      if (state.prefs.fade) fadeVolume(state.volume, fadeDuration());
      else applyVolume();
    }).catch(() => showToast('音频开始播放失败'));
  } else {
    if (state.prefs.fade) fadeVolume(0, Math.max(40, fadeDuration() * .75), () => audio.pause());
    else audio.pause();
    state.playing = false;
    updatePlayIcons();
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
    audio.play();
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
}

// 从资料库移除歌曲（只删除记录，不动磁盘上的音乐文件）
/**
 * 把一首歌从资料库的各个引用点摘干净（不负责 UI 刷新与当前播放状态）。
 * removeTrack 与 cleanDuplicates 共用这一份规则 —— 原先两处各写一遍，
 * cleanDuplicates 那份漏掉了 state.importedIds，被清理的 id 会一直留在「本次导入」列表里。
 */
function detachTrack(id) {
  state.songs = state.songs.filter(song => song.id !== id);
  state.queue = state.queue.filter(item => item !== id);
  state.favorites.delete(id);
  state.recent = state.recent.filter(item => item !== id);
  state.importedIds = state.importedIds.filter(item => item !== id);
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
    saveState();
    saveProgress();
    saveLibrary();
    updatePlayerUi();
    updatePlayIcons();
    renderAll();
  }
  return true;
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
  state.importedIds = [];
  state.progress = {};
  state.currentId = null;
  state.playlists.forEach(playlist => { playlist.tracks = []; });
  saveState();
  saveProgress();
  saveLibrary();
  updatePlayerUi();
  updatePlayIcons();
  renderAll();
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
    if (!audio.paused) {
      audio.pause();
      state.playing = false;
      updatePlayIcons();
    }
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
      state.prefs.sleepTimer = 0;
      savePrefs();
      const select = $('#sleepTimer');
      if (select) select.value = '0';
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
    clearSleepTimer();
    showToast('睡眠定时器：播完本曲已停止');
    return;
  }
  if (state.prefs.autoNext || state.repeat === 2) nextTrack(true);
  else {
    state.playing = false;
    updatePlayIcons();
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

function paintRange(slider, ratio) {
  if (!slider) return;
  const safe = Number.isFinite(ratio) ? ratio : 0;
  slider.style.setProperty('--range-pct', `${Math.max(0, Math.min(100, safe * 100)).toFixed(2)}%`);
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
  if (!seeking) {
    $('#seekSlider').value = Math.round(ratio * 1000);
    $('#fullSeekSlider').value = Math.round(ratio * 1000);
  }
  paintRange($('#seekSlider'), seeking ? Number($('#seekSlider').value) / 1000 : ratio);
  paintRange($('#fullSeekSlider'), seeking ? Number($('#fullSeekSlider').value) / 1000 : ratio);
  $('#currentTime').textContent = formatTime(audio.currentTime);
  $('#fullCurrentTime').textContent = formatTime(audio.currentTime);
  $('#totalTime').textContent = formatTime(duration);
  $('#fullTotalTime').textContent = formatTime(duration);
  updateLyricsActive();
  rememberProgress();
}

async function importFiles(fileList) {
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
    const extension = file.name.split('.').pop().toUpperCase();
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
    const sidecarLyrics = lyricMap.get(sidecarKey.replace(/\s+/g, ''))
      || lyricMap.get(relativeKey.replace(/\s+/g, ''))
      || lyricMap.get(sidecarKey.replace(/\s+/g, '').split(/[./]/)[0]);
    let lyrics = metadata.lyrics || (sidecarLyrics ? parseLyrics(sidecarLyrics) : []);
    if (!lyrics.length && sourcePath && window.orangeDesktop?.readSidecarLyrics) {
      const sidecar = await window.orangeDesktop.readSidecarLyrics(sourcePath).catch(() => null);
      if (sidecar?.text) lyrics = parseLyrics(sidecar.text);
    }
    const duration = await probeDuration(url);
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
    state.songs.push({
      id,
      title,
      artist,
      album: metadata.album || file.webkitRelativePath?.split('/').slice(-2,-1)[0] || '本地文件',
      format,
      duration: duration || 0,
      cover: coverUrl,
      source:'本地导入',
      _src:url,
      _fileName:file.name,
      _file:file,
      _path:sourcePath,
      _size: file.size || 0,
      _tech: tech,
      _lyrics:lyrics
    });
    state.queue.push(id);
    added += 1;
    state.importedIds.push(id);
    knownPaths.add(sourcePath.toLowerCase());
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
  if (state.prefs.autoplayImport && state.importedIds.length) {
    playTrack(state.importedIds[0]);
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
  if (!track?._file || track._recovered) return false;
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
  lyrics.forEach(line => { delete line._charTimes; });
  cacheLyricNodes(container);
  updateLyricsActive();
}

// 每个字的点亮时间：优先用逐字时间轴，没有就按整句时长均分
function charTimeline(line, nextLine) {
  if (line._charTimes) return line._charTimes;
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
  line._charTimes = times;
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

function updateLyricsActive(forceScroll = false) {
  // 歌词的 DOM 全都挂在 #fullPlayer 里，它没打开时这轮同步纯粹是白做
  // （timeupdate 每秒触发约 4 次，每次都还要遍历歌词行 + 更新逐字状态）。
  // 全屏页一打开就会走 renderLyrics() → 这里被重新调用一次，不会漏掉同步。
  if (!forceScroll && !$('#fullPlayer')?.classList.contains('open')) return;
  const lyrics = getLyrics(getTrack(state.currentId));
  if (!lyrics.length) return;
  const offset = currentLyricOffset();
  const position = audio.currentTime + .18 + offset;
  let active = 0;
  for (let i = 0; i < lyrics.length; i += 1) {
    if (position >= lyrics[i].time) active = i;
  }
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
  updateKaraoke(lyrics, active, position);
  if (state.playing && (changed || forceScroll) && (!lyricsManualScroll || forceScroll)) {
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

// 动画帧级的逐字刷新（只更新当前句，避免频繁滚动）
function karaokeTick() {
  if (!state.playing || !$('#fullPlayer')?.classList.contains('open')) return;
  const lyrics = getLyrics(getTrack(state.currentId));
  if (!lyrics.length) return;
  const offset = currentLyricOffset();
  const position = audio.currentTime + .18 + offset;
  let active = 0;
  for (let i = 0; i < lyrics.length; i += 1) {
    if (position >= lyrics[i].time) active = i;
  }
  updateKaraoke(lyrics, active, position);
}

// 逐字点亮 + 轻微漂浮
function updateKaraoke(lyrics, active, position) {
  const line = lyrics[active];
  if (!line) return;
  // 逐字节点已在 renderLyrics 里缓存好，不再每 80ms 按属性选择器查一次
  const chars = lyricCharNodes[active];
  if (!chars || !chars.length) return;
  const times = charTimeline(line, lyrics[active + 1]);
  const revealed = state.playing ? times.filter(time => position >= time).length : chars.length;
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

function showPage(page) {
  state.page = page;
  $$('.page').forEach(section => section.classList.toggle('active', section.id === `${page}Page`));
  $$( '.nav-item, .sidebar-link[data-page]' ).forEach(button => button.classList.toggle('active', button.dataset.page === page));
  window.scrollTo({ top:0, behavior:'smooth' });
}

function showTab(tab) {
  state.tab = tab;
  $$('.library-tab').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  $$('.library-panel').forEach(panel => panel.classList.toggle('active', panel.dataset.panel === tab));
}

function setTitleBarTone(mode) {
  const desktop = window.orangeDesktop;
  if (!desktop?.setTitleBarOverlay) return;
  // 标题栏整体透明，只有符号（最小化/最大化/关闭）随页面深浅换色；
  // 高度与主进程建窗时用的 TITLE_BAR_HEIGHT 保持一致。
  desktop.setTitleBarOverlay({
    color: 'rgba(0,0,0,0)',
    symbolColor: mode === 'full' ? '#f4f4f5' : '#17181b',
    height: TITLE_BAR_HEIGHT
  });
  document.body.classList.toggle('tone-full', mode === 'full');
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
  setTimeout(() => setTitleBarTone('full'), 80);
  $('#fullPlayer').setAttribute('aria-hidden','false');
  document.body.style.overflow = 'hidden';
  renderLyrics();
  const track = getTrack(state.currentId);
  if (track && track._path && !getLyrics(track).length && !track._lyricChecked) {
    track._lyricChecked = true;
    loadTrackLyrics(track).then(lines => {
      if (lines.length) renderLyrics();
    });
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
  const playlist = state.playlists.find(item => item.id === id);
  if (!playlist?.tracks.length) {
    showToast('这个歌单还是空的');
    return;
  }
  state.queue = [...playlist.tracks];
  renderQueue();
  saveLibrary();
  playTrack(playlist.tracks[0]);
  showToast(`正在播放歌单“${playlist.name}”`);
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

function applyLyricTheme() {
  const player = $('#fullPlayer');
  const image = $('#fullCover');
  if (!player || !image) return;
  const mode = state.prefs.lyricTheme || 'cover';

  // 浅色 / 固定深色：不使用封面取色，交给 CSS 变量控制
  if (mode !== 'cover') {
    player.style.backgroundColor = '';
    player.style.removeProperty('--lyric-cover-url');
    player.classList.add('lyric-plain');
    player.classList.toggle('lyric-light', mode === 'light');
    document.body.classList.toggle('lyric-light', mode === 'light');
    if (player.classList.contains('open')) setTimeout(() => setTitleBarTone('full'), 0);
    return;
  }
  player.classList.remove('lyric-plain', 'lyric-light');
  document.body.classList.remove('lyric-light');

  const update = () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0, 32, 32);
      const pixels = context.getImageData(0, 0, 32, 32).data;
      let r = 0, g = 0, b = 0, count = 0;
      for (let i = 0; i < pixels.length; i += 16) {
        if (pixels[i + 3] > 20) {
          r += pixels[i];
          g += pixels[i + 1];
          b += pixels[i + 2];
          count += 1;
        }
      }
      if (count) {
        r = Math.round(r / count);
        g = Math.round(g / count);
        b = Math.round(b / count);
        const darkR = Math.round(r * .30 + 12);
        const darkG = Math.round(g * .30 + 16);
        const darkB = Math.round(b * .30 + 14);
        player.style.backgroundColor = `rgb(${darkR}, ${darkG}, ${darkB})`;
        player.style.setProperty('--lyric-theme-color', `rgb(${r}, ${g}, ${b})`);
        // 塞进 CSS 的 url("...") 里，路径中的引号 / 反斜杠必须转义，否则整条声明会失效
        player.style.setProperty('--lyric-cover-url', `url("${String(image.src).replace(/["\\]/g, '\\$&')}")`);
        // --lyric-theme-color 取的是平均值，容易偏灰；这里再算一份「主色」存进
        // --cover-accent 给歌词辉光用。applyCoverAccent 内部有去重，重复调用无开销。
        applyCoverAccent(image.src);
        if (player.classList.contains('open')) setTimeout(() => setTitleBarTone('full'), 0);
      }
    } catch (error) {
      console.warn('Unable to sample cover colors', error);
    }
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

  const editPlaylistButton = event.target.closest('[data-edit-playlist]');
  if (editPlaylistButton) {
    event.stopPropagation();
    openPlaylistEdit(editPlaylistButton.dataset.editPlaylist);
    return;
  }

  const exportPlaylistButton = event.target.closest('[data-export-playlist]');
  if (exportPlaylistButton) {
    event.stopPropagation();
    exportPlaylist(exportPlaylistButton.dataset.exportPlaylist);
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

  const playlistPlay = event.target.closest('[data-play-playlist]');
  if (playlistPlay) {
    event.stopPropagation();
    playPlaylist(playlistPlay.dataset.playPlaylist);
    return;
  }

  const playlistDelete = event.target.closest('[data-delete-playlist]');
  if (playlistDelete) {
    event.stopPropagation();
    const playlist = state.playlists.find(item => item.id === playlistDelete.dataset.deletePlaylist);
    if (playlist && window.confirm(`确定要删除歌单“${playlist.name}”吗？歌曲文件不会被删除。`)) {
      state.playlists = state.playlists.filter(item => item.id !== playlist.id);
      saveState();
      renderPlaylists();
      renderCounts();
      showToast('已删除歌单');
    }
    return;
  }

  const playlistCard = event.target.closest('[data-playlist]');
  if (playlistCard) {
    playPlaylist(playlistCard.dataset.playlist);
    return;
  }

  const addTo = event.target.closest('[data-add-to]');
  if (addTo) {
    addToPlaylist(addTo.dataset.addTo);
    return;
  }

  if (event.target.closest('[data-add-new]')) {
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
  if (action === 'show-favorites') {
    showPage('library');
    showTab('favorites');
  }
  if (action === 'refresh-recommend') {
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
  if (action === 'open-queue') toggleQueue(true);
  if (action === 'close-queue') toggleQueue(false);
  if (action === 'open-lyrics') openFullPlayer();
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

[$('#shuffleButton'),$('#fullShuffle')].forEach(button => button.addEventListener('click', toggleShuffleMode));

[$('#repeatButton'),$('#fullRepeat')].forEach(button => button.addEventListener('click', cycleRepeatMode));

[$('#seekSlider'),$('#fullSeekSlider')].forEach(slider => {
  slider.addEventListener('pointerdown', () => { seeking = true; });
  slider.addEventListener('change', () => { seekFromSlider(slider); seeking = false; });
  slider.addEventListener('pointerup', () => { seekFromSlider(slider); seeking = false; });
});

['#volumeSlider', '#fullVolumeSlider'].forEach(selector => {
  $(selector)?.addEventListener('input', event => setVolume(Number(event.target.value) / 100, { muted: false }));
});
['#volumeButton', '#fullVolumeButton'].forEach(selector => {
  $(selector)?.addEventListener('click', toggleMute);
});

$('#globalSearch').addEventListener('input', event => {
  state.query = event.target.value;
  renderSearchResults();
  showPage('search');
});

$$('#searchScopes .chip').forEach(chip => chip.addEventListener('click', () => {
  state.searchScope = chip.dataset.scope;
  $$('#searchScopes .chip').forEach(item => item.classList.toggle('active', item === chip));
  renderSearchResults();
}));
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

function handleShortcut(event) {
  const key = event.key;
  const lower = typeof key === 'string' ? key.toLowerCase() : '';
  const ctrl = event.ctrlKey || event.metaKey;

  if (key === 'Escape') {
    if (!$('#lyricMenu')?.hidden) {
      closeLyricMenu();
      return true;
    }
    if ($('#fullPlayer').classList.contains('open')) closeFullPlayer();
    else if ($('#queueDrawer').classList.contains('open')) toggleQueue(false);
    return true;
  }
  if (event.code === 'MediaPlayPause' || event.code === 'MediaStop') {
    event.preventDefault();
    togglePlayback();
    return true;
  }
  if (event.code === 'MediaTrackNext') {
    event.preventDefault();
    nextTrack();
    return true;
  }
  if (event.code === 'MediaTrackPrevious') {
    event.preventDefault();
    previousTrack();
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
    case 'search':
      showPage('search');
      setTimeout(() => $('#globalSearch').focus(), 50);
      break;
    default: break;
  }
}

document.addEventListener('keydown', handleShortcut);

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
  if (!state.songs.length) {
    showPage('import');
    return;
  }
  const track = getTrack(state.currentId) || state.songs[0];
  playTrack(track.id);
});
$('#featureImport')?.addEventListener('click', () => showPage('import'));

audio.addEventListener('play', () => { state.playing = true; updatePlayIcons(); updateLyricsActive(); });
audio.addEventListener('pause', () => { state.playing = false; updatePlayIcons(); updateLyricsActive(); });
audio.addEventListener('timeupdate', updateProgress);
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
$('#pageFileInput').addEventListener('change', event => importFiles(event.target.files));
$('#pageFolderInput').addEventListener('change', event => importFiles(event.target.files));
['dragenter','dragover'].forEach(type => $('#pageDropZone').addEventListener(type, event => {
  event.preventDefault();
  $('#pageDropZone').classList.add('drag');
}));
['dragleave','drop'].forEach(type => $('#pageDropZone').addEventListener(type, event => {
  event.preventDefault();
  $('#pageDropZone').classList.remove('drag');
}));
$('#pageDropZone').addEventListener('drop', event => importFiles(event.dataTransfer.files));

$('#playlistForm').addEventListener('submit', event => {
  event.preventDefault();
  const name = $('#playlistName').value.trim();
  if (!name) return;
  state.playlists.push({ id:`p${Date.now()}`, name, tracks:[] });
  saveState();
  renderPlaylists();
  renderCounts();
  $('#playlistName').value = '';
  $('#playlistModal').close();
  showPage('library');
  showTab('playlists');
  showToast(`已创建歌单“${name}”`);
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
  const picked = await window.orangeDesktop?.pickImage?.();
  if (!picked) return;
  const saved = await window.orangeDesktop?.saveImageAsCover?.(picked);
  if (!saved) {
    showToast('封面保存失败');
    return;
  }
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
  if (infoTrackId) state.currentId = infoTrackId;
  $('#infoModal')?.close();
  $('#lyricsFileInput').click();
});
$('#infoPasteLyrics')?.addEventListener('click', () => {
  if (infoTrackId) state.currentId = infoTrackId;
  $('#infoModal')?.close();
  $('#lyricsModal').showModal();
});

window.orangeDesktop?.onTrayCommand?.(command => {
  if (command === 'play-pause') togglePlayback();
  else if (command === 'prev') previousTrack();
  else if (command === 'next') nextTrack();
});

$('#lyricsScroll').addEventListener('click', event => {
  const line = event.target.closest('[data-time]');
  if (line) {
    audio.currentTime = Math.max(0, Number(line.dataset.time) - currentLyricOffset());
    if (audio.paused) togglePlayback();
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
  showToast(lines.length
    ? (track._lyricSource === 'embedded' ? `已从文件内读取到 ${lines.length} 行歌词` : `已从同名歌词文件读取到 ${lines.length} 行歌词`)
    : '这首歌里没有找到歌词文件或内嵌歌词');
});
$('#lyricsFileInput').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  const text = await file.text();
  const track = getTrack(state.currentId);
  track._lyrics = parseLyrics(text);
  track._lyricManual = true;
  track._lyricSource = 'manual';
  renderLyrics();
  showToast(`已导入歌词：${file.name}`);
});
$('#pasteLyricsButton')?.addEventListener('click', () => $('#lyricsModal').showModal());
$('#lyricsForm').addEventListener('submit', event => {
  event.preventDefault();
  const text = $('#lyricsInput').value.trim();
  if (!text) return;
  const track = getTrack(state.currentId);
  track._lyrics = parseLyrics(text);
  track._lyricManual = true;
  track._lyricSource = 'manual';
  renderLyrics();
  $('#lyricsModal').close();
  $('#lyricsInput').value = '';
  showToast('歌词已保存');
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
  bindSwitch('#eqToggle', 'eqEnabled', () => applyEq());
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
    preset.value = state.prefs.eqPreset || 'flat';
    preset.addEventListener('change', () => {
      state.prefs.eqPreset = preset.value;
      state.prefs.eqGains = [...(EQ_PRESETS[preset.value] || EQ_PRESETS.flat)];
      applyEq();
      renderEqSliders();
      savePrefs();
    });
  }
  $$('.eq-slider').forEach(slider => {
    slider.addEventListener('input', () => {
      const gains = normalizedEqGains();
      gains[Number(slider.dataset.band)] = Number(slider.value);
      state.prefs.eqGains = gains;
      state.prefs.eqEnabled = true;
      const toggle = $('#eqToggle');
      if (toggle) toggle.checked = true;
      applyEq();
      savePrefs();
    });
  });
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

function renderEqSliders() {
  const gains = normalizedEqGains();
  $$('.eq-slider').forEach(slider => {
    const value = gains[Number(slider.dataset.band)] || 0;
    slider.value = String(value);
    slider.title = `${value > 0 ? '+' : ''}${value} dB`;
  });
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
async function applyCoverAccent(cover) {
  const url = String(cover || '');
  if (url === coverAccentUrl) return;
  coverAccentUrl = url;
  const rgb = await sampleDominantColor(url);
  // 采样是异步的，期间可能已经切歌，过期结果直接丢掉
  if (coverAccentUrl !== url) return;
  const value = rgb ? glowColor(rgb) : '';
  [$('#fullPlayer'), document.body, document.documentElement].forEach(node => {
    if (!node) return;
    if (value) node.style.setProperty('--cover-accent', value);
    else node.style.removeProperty('--cover-accent');
  });
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
  return { ...DEFAULT_SHORTCUTS, ...(state.prefs.shortcutKeys || {}) };
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
  search: '搜索'
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

async function pickEditCover() {
  const picked = await window.orangeDesktop?.pickImage?.();
  if (!picked) return;
  const saved = await window.orangeDesktop?.saveImageAsCover?.(picked);
  if (!saved) {
    showToast('封面保存失败');
    return;
  }
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
  track.cover = editingCoverUrl || track.cover;
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
  state.playlists.push({ id: `p${Date.now()}`, name: result.name || '导入的歌单', tracks });
  saveState();
  saveLibrary();
  renderAll();
  showPage('library');
  showTab('playlists');
  showToast(`已导入歌单，共 ${tracks.length} 首`);
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
    _tech: record.tech || {}
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
  const records = await window.orangeDesktop.scanFolders(folders).catch(() => []);
  let added = 0;
  // 已收录路径先建表，避免在循环里对每条记录都遍历一次资料库（曲库大时是 O(n×m)）
  const knownPaths = new Set(state.songs.map(song => String(song._path || '').toLowerCase()).filter(Boolean));
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
  document.body.classList.toggle('show-waveform', Boolean(state.prefs.waveform));
  initPlayerStyleControls();
}

async function bootstrap() {
  const restored = await restoreLibrary().catch(() => 0);
  state.favorites = new Set([...state.favorites].filter(id => getTrack(id)));
  state.recent = state.recent.filter(id => getTrack(id));
  if (restored) {
    saveState();
    saveLibrary();
    // 只有资料库确实读出来了才回收封面；读失败（restored = 0）时宁可什么都不做
    pruneOrphanCovers();
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
  renderAll();
  updatePlayerUi();

  const currentTrack = getTrack(state.currentId);
  if (currentTrack && !getLyrics(currentTrack).length && currentTrack._path) {
    currentTrack._lyricChecked = true;
    loadTrackLyrics(currentTrack).then(lines => {
      if (lines.length) {
        renderLyricSource();
        renderLyrics();
      }
    });
  }

  showTab('playlists');
  initSettings();
  syncTransportModes();
  applyPlaybackRate();
  applyEq();
  applyReplayGain(getTrack(state.currentId));
  initTitleBar();
  setTitleBarTone('main');
  initAutoScrollbar();
  relocateFullPlayerControls();
  drawVisualizer();

  if (restored) showToast(`已恢复 ${restored} 首本地歌曲`);
  if (state.prefs.autoScanOnStart && (state.prefs.watchFolders || []).length) {
    setTimeout(() => runAutoScan({ silent: true }), 1200);
  }
}

bootstrap();
