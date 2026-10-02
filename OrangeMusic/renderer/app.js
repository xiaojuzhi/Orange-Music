'use strict';

// 标签与歌词解析逻辑集中在 tags.js，主进程与渲染进程共用
const OrangeTags = window.OrangeTags || {};
const {
  decodeTextBuffer, findBytes, parseVorbisComment, readVorbisTags, readMp4Tags, readWavTags,
  parseSyncLyrics, parseUserTextFrame, readId3, imageBytesToDataUrl, parseAttachedPicture,
  bytesToDataUrl, pictureBlockToUrl, parseLyrics, splitFileName, readDuration, readTechInfo
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

const FORMAT_ALIASES = { M4A: 'AAC', MP4: 'AAC', OGA: 'OGG', AIF: 'AIFF' };

const baseSongs = [];

const defaultLyrics = {};

const defaultPlaylists = [];

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
  eqGains: [0, 0, 0, 0, 0],
  lyricOffset: 0,
  lyricBlur: 0,
  lyricTheme: 'cover',
  listDensity: 'normal',
  watchFolders: [],
  autoScanOnStart: false,
  minimizeToTray: false,
  closeToTray: false,
  autoStart: false,
  shortcutKeys: {},
  themeColor: 'default',
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

const state = {
  page: 'home',
  tab: 'playlists',
  format: 'all',
  query: '',
  songs: [...baseSongs],
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
let sourceNode = null;
let eqFilters = [];
let gainNode = null;
let fadeTimer = null;
let pendingResume = 0;
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
state.prefs = { ...defaultPrefs, ...state.prefs };

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
    let src = record.path;
    if (desktop?.toFileUrl) {
      src = (await desktop.toFileUrl(record.path).catch(() => null)) || record.path;
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
      _src: src,
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
  const savedQueue = readStored('orange-queue', []).filter(id => songs.some(song => song.id === id));
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
function looksLikeSong({ name, filePath, metadata, seconds, nameParts }) {
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

function getLyrics(track) {
  if (track?._lyrics?.length) return track._lyrics;
  const legacy = defaultLyrics[track?.id];
  if (legacy) return legacy.map(([time,text]) => ({time,text}));
  return [];
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
    button.innerHTML = `<svg class="icon"><use href="#${state.selectMode ? 'i-check' : 'i-check'}"/></svg>${state.selectMode ? '退出多选' : '多选'}`;
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
    applyEq();
    applyReplayGain(getTrack(state.currentId));
  } catch (error) {
    console.warn('Visualizer unavailable', error);
  }
}

function applyEq() {
  if (!eqFilters.length) return;
  const gains = state.prefs.eqEnabled ? (state.prefs.eqGains || []) : [0, 0, 0, 0, 0];
  eqFilters.forEach((filter, index) => {
    const value = Number(gains[index]) || 0;
    filter.gain.value = Math.max(-12, Math.min(12, value));
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

function getTrackSource(track) {
  return track._src || createDemoWav(track);
}

async function playTrack(id, forcePlay = true) {
  const track = getTrack(id);
  if (!track) return;
  const changed = state.currentId !== id;
  if (changed) {
    state.currentId = id;
    if (demoUrl && demoForId !== id) {
      URL.revokeObjectURL(demoUrl);
      demoUrl = null;
      demoForId = null;
    }
    pendingResume = state.prefs.resume ? Number(state.progress[id] || 0) : 0;
    audio.src = getTrackSource(track);
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
function removeTrack(id, options = {}) {
  const track = getTrack(id);
  if (!track) return false;
  const wasCurrent = state.currentId === id;
  state.songs = state.songs.filter(song => song.id !== id);
  state.queue = state.queue.filter(item => item !== id);
  state.favorites.delete(id);
  state.recent = state.recent.filter(item => item !== id);
  state.importedIds = state.importedIds.filter(item => item !== id);
  delete state.progress[id];
  state.playlists.forEach(playlist => {
    playlist.tracks = playlist.tracks.filter(item => item !== id);
  });

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

function rememberProgress() {
  if (!state.prefs.resume || !state.currentId) return;
  const now = Date.now();
  if (now - lastProgressSave < 3000) return;
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
  const skippedPreview = [];
  for (const file of files) {
    const url = URL.createObjectURL(file);
    const extension = file.name.split('.').pop().toUpperCase();
    const format = FORMAT_ALIASES[extension] || extension;
    const nameParts = splitFileName(file.name);
    const sourcePath = window.orangeDesktop?.getPathForFile?.(file) || '';
    if (sourcePath && state.songs.some(song => song._path === sourcePath)) {
      added += 1;
      progressBar.style.width = `${Math.round((added / files.length) * 88) + 8}%`;
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
    if (state.prefs.onlySongs && !looksLikeSong({ name: file.name, filePath: sourcePath, metadata, seconds: duration, nameParts })) {
      skipped += 1;
      skippedPreview.push(file.name);
      progressBar.style.width = `${Math.round(((added + skipped) / files.length) * 88) + 8}%`;
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
    progressBar.style.width = `${Math.round((added / files.length) * 88) + 8}%`;
  }
  progressBar.style.width = '100%';
  statusTitle.textContent = `扫描完成 · 新增 ${added} 首歌曲`;
  statusDetail.textContent = skipped
    ? `已自动跳过 ${skipped} 个非歌曲音频（音效、提示音、语音等）：${skippedPreview.slice(0, 3).join('、')}${skipped > 3 ? ' 等' : ''}`
    : '歌曲已加入本地资料库，可以前往首页播放。';
  saveLibrary();
  renderAll();
  showToast(skipped ? `已添加 ${added} 首歌曲，跳过 ${skipped} 个非歌曲音频` : `已识别 ${added} 首本地歌曲`);
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
    const done = value => { probe.removeAttribute('src'); resolve(value); };
    probe.preload = 'metadata';
    probe.addEventListener('loadedmetadata', () => done(Number.isFinite(probe.duration) ? probe.duration : 0), { once:true });
    probe.addEventListener('error', () => done(0), { once:true });
    probe.src = url;
    setTimeout(() => done(0), 5000);
  });
}

// 歌词文件常见编码：优先 BOM / UTF-8，失败时按 GBK 解码

// Vorbis Comment（FLAC / OGG / Opus 通用）：供应商串 + 若干 KEY=VALUE

// FLAC（元数据块）/ OGG / Opus

// MP4 / M4A 原子：©nam 标题、©ART 歌手、©alb 专辑、©lyr 歌词、covr 封面

// WAV 的 RIFF INFO 标签（INAM / IART / IPRD）

// ID3 SYLT：同步歌词帧（自带时间戳）

// ID3 TXXX：形如 描述=值 的用户自定义文本，部分音乐把歌词放在这里

function renderLyrics() {
  const track = getTrack(state.currentId);
  const lyrics = getLyrics(track);
  const container = $('#lyricsScroll');
  if (!container) return;
  renderLyricSource();
  if (!track) {
    container.innerHTML = `<p class="lyric-line active">还没有播放歌曲</p><p class="lyric-line">导入本地音乐后会自动读取歌词</p>`;
    return;
  }
  if (!lyrics.length) {
    container.innerHTML = `<p class="lyric-line active">这首歌还没有歌词</p><p class="lyric-line">可从歌曲信息里导入 LRC 或粘贴歌词</p>`;
    return;
  }
  container.innerHTML = lyrics.map((line, index) => {
    const chars = [...String(line.text)].map((char, i) =>
      `<span class="ch" data-i="${i}">${char === ' ' ? '&nbsp;' : escapeHtml(char)}</span>`).join('');
    return `<p class="lyric-line" data-lyric-index="${index}" data-time="${line.time}">${chars}</p>`;
  }).join('');
  lyrics.forEach(line => { delete line._charTimes; });
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
  const lyrics = getLyrics(getTrack(state.currentId));
  if (!lyrics.length) return;
  const offset = currentLyricOffset();
  const position = audio.currentTime + .18 + offset;
  let active = 0;
  for (let i = 0; i < lyrics.length; i += 1) {
    if (position >= lyrics[i].time) active = i;
  }
  const changed = activeLineIndex !== active;
  activeLineIndex = active;
  $$('.lyric-line', $('#lyricsScroll')).forEach((line,index) => {
    line.classList.toggle('active', index === active);
    line.classList.toggle('current', index === active && state.playing);
  });
  updateKaraoke(lyrics, active, position);
  const activeLine = $(`.lyric-line[data-lyric-index="${active}"]`, $('#lyricsScroll'));
  if (activeLine && state.playing && (changed || forceScroll) && (!lyricsManualScroll || forceScroll)) {
    const target = activeLine.offsetTop - $('#lyricsScroll').clientHeight / 2 + activeLine.clientHeight / 2;
    animateLyricScroll($('#lyricsScroll'), Math.max(0, target), 780);
  }
}

let activeLineIndex = -1;

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
  const element = $(`.lyric-line[data-lyric-index="${active}"]`, $('#lyricsScroll'));
  if (!element) return;
  const chars = element.children;
  if (!chars.length) return;
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
  const fullPlayer = $('#fullPlayer');
  const mainColor = '#ffffff';
  const fullColor = fullPlayer
    ? (getComputedStyle(fullPlayer).backgroundColor || '#101412')
    : '#101412';
  const color = 'rgba(0,0,0,0)';
  const symbolColor = mode === 'full' ? '#f4f4f5' : '#17181b';
  desktop.setTitleBarOverlay({ color, symbolColor, height: 52 });
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
    player.classList.toggle('lyric-plain', true);
    player.classList.toggle('lyric-light', mode === 'light');
    document.body.classList.toggle('lyric-light', mode === 'light');
    if (player.classList.contains('open')) setTimeout(() => setTitleBarTone('full'), 0);
    return;
  }
  player.classList.remove('lyric-plain', 'lyric-light');
  document.body.classList.toggle('lyric-light', false);

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
        player.style.setProperty('--lyric-cover-url', `url("${image.src}")`);
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

function drawVisualizer() {
  const canvas = $('#visualizer');
  const context = canvas.getContext('2d');
  const enabled = $('#waveformToggle')?.checked;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
  }
  context.clearRect(0,0,canvas.width,canvas.height);
  if (!enabled || !$('#fullPlayer').classList.contains('open')) {
    requestAnimationFrame(drawVisualizer);
    return;
  }
  const bars = 42;
  const gap = 4 * dpr;
  const barWidth = Math.max(2 * dpr, (canvas.width - gap * (bars - 1)) / bars);
  let values = new Uint8Array(64);
  if (analyser) {
    analyser.getByteFrequencyData(values);
  } else {
    for (let i = 0; i < values.length; i += 1) values[i] = 70 + Math.sin(audio.currentTime * 3 + i * .7) * 45;
  }
  const colors = ['#ff6658','#f4f4f5','#38bdf8','#69db9d'];
  for (let i = 0; i < bars; i += 1) {
    const raw = values[Math.floor(i / bars * values.length)] || 40;
    const level = state.playing ? raw / 255 : .08;
    const barHeight = Math.max(4 * dpr, level * canvas.height * .9);
    const x = i * (barWidth + gap);
    const y = canvas.height - barHeight;
    context.fillStyle = colors[i % colors.length];
    context.globalAlpha = .78;
    context.fillRect(x,y,barWidth,barHeight);
  }
  context.globalAlpha = 1;
  requestAnimationFrame(drawVisualizer);
}

function toggleTheme() {
  document.body.classList.toggle('dark');
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
$('#lyricsScroll')?.addEventListener('scroll', closeLyricMenu);

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
      const gains = [...(state.prefs.eqGains || [0, 0, 0, 0, 0])];
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
  const gains = state.prefs.eqGains || [0, 0, 0, 0, 0];
  $$('.eq-slider').forEach(slider => {
    const value = Number(gains[Number(slider.dataset.band)]) || 0;
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
  removeIds.forEach(id => {
    state.songs = state.songs.filter(song => song.id !== id);
    state.queue = state.queue.filter(item => item !== id);
    state.favorites.delete(id);
    state.recent = state.recent.filter(item => item !== id);
    delete state.progress[id];
    state.playlists.forEach(playlist => { playlist.tracks = playlist.tracks.filter(item => item !== id); });
  });
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
    meta.forEach(record => {
      const song = songFromScanRecord(record);
      if (song) known.set(record.path.toLowerCase(), song.id);
    });
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

function songFromScanRecord(record) {
  if (!record || !record.path || record.error) return null;
  if (state.songs.some(song => song._path && song._path.toLowerCase() === record.path.toLowerCase())) return null;
  if (state.prefs.onlySongs && !looksLikeSong({
    name: record.fileName || record.path,
    filePath: record.path,
    metadata: { title: record.hasTags ? record.title : '', artist: record.hasTags ? record.artist : '', album: record.hasTags ? record.album : '' },
    seconds: record.duration,
    nameParts: splitFileName(record.fileName || record.path)
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
    _path: record.path,
    _lyrics: Array.isArray(record.lyrics) ? record.lyrics : [],
    _size: Number(record.size) || 0,
    _tech: record.tech || {}
  };
  state.songs.push(song);
  state.queue.push(song.id);
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
  for (const record of records) {
    if (songFromScanRecord(record)) added += 1;
  }
  if (added) {
    saveLibrary();
    renderAll();
    updatePlayerUi();
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

function applyThemeColor() {
  const theme = THEME_COLORS.includes(state.prefs.themeColor) ? state.prefs.themeColor : 'default';
  THEME_COLORS.forEach(name => document.body.classList.toggle(`theme-${name}`, name === theme));
  $$('#themeSwatches .theme-swatch').forEach(button => {
    button.classList.toggle('active', button.dataset.theme === theme);
  });
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
  }

  const restoredTrackId = readStored('orange-last-track', '');
  if (state.prefs.restoreLastTrack && restoredTrackId && getTrack(restoredTrackId)) {
    state.currentId = restoredTrackId;
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
