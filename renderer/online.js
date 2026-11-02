'use strict';
/**
 * 在线音乐前端模块（渲染进程）。
 *
 * 与 app.js 的分工：
 *  - app.js 负责播放器内核（播放、歌词、队列、均衡器），在线曲目以 `_online` 标记复用这套内核
 *  - 本文件负责在线音源的界面、账号状态、以及「在线资料库」的持久化
 *
 * 在线资料库（localStorage: orange-online-lib）包含：
 *  - tracks：解析过的在线曲目元数据（收藏 / 歌单 / 最近播放引用的部分）
 *  - favorites：本地收藏（红心）
 *  - playlists：本地自建的在线歌单
 *  - recent：在线播放历史
 * 这样重启后收藏与歌单里的在线歌曲仍然可见、可播，不需要重新搜索。
 */

const OL_SOURCES = [
  { id: 'netease', name: '网易云音乐', short: '网易云', color: '#e8443c' },
  { id: 'qq', name: 'QQ 音乐', short: 'QQ 音乐', color: '#31c27c' },
  { id: 'kugou', name: '酷狗音乐', short: '酷狗', color: '#2aa5ff' }
];

const OL_LIB_KEY = 'orange-online-lib';
/** 在线直链有有效期（几分钟到几十分钟），过期就重新解析 */
const OL_SRC_TTL = 10 * 60 * 1000;
/** 在线库最多保留的曲目条数，超出后先淘汰没被引用的 */
const OL_TRACK_LIMIT = 1200;

const olSourceMeta = id => OL_SOURCES.find(item => item.id === id) || OL_SOURCES[0];
const olAccountOf = id => (state.onlineAccounts || []).find(item => item.id === id) || null;

/** 界面状态（不进 localStorage，只影响当前会话的展示） */
const OL = {
  view: 'daily',
  daily: [], dailyMode: '', dailyError: '', dailyLoading: false,
  picked: [], pickedError: '', pickedLoading: false,
  search: [], searchLoading: false, searchTitle: '', searchError: '',
  liked: [], likedMode: 'local', likedError: '', likedLoading: false,
  // 纯账号红心（不含本地收藏），「喜爱」页要单独分一段展示
  likedAccount: [], likedLoaded: false, likedSource: '', likedTried: false,
  platformPlaylists: [], platformError: '', platformLoading: false,
  detail: null, detailLoading: false,
  modal: null
};

/* ==========================================================================
   在线资料库（持久化）
   ========================================================================== */

function emptyOnlineLib() {
  return { tracks: {}, favorites: [], playlists: [], recent: [] };
}

function readOnlineLib() {
  try {
    const raw = JSON.parse(localStorage.getItem(OL_LIB_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return emptyOnlineLib();
    return {
      tracks: raw.tracks && typeof raw.tracks === 'object' ? raw.tracks : {},
      favorites: Array.isArray(raw.favorites) ? raw.favorites.filter(id => typeof id === 'string') : [],
      playlists: Array.isArray(raw.playlists)
        ? raw.playlists
            .filter(item => item && item.id)
            .map(item => ({
              id: String(item.id),
              name: String(item.name || '未命名歌单'),
              tracks: Array.isArray(item.tracks) ? item.tracks.filter(id => typeof id === 'string') : [],
              createdAt: Number(item.createdAt) || Date.now()
            }))
        : [],
      recent: Array.isArray(raw.recent) ? raw.recent.filter(id => typeof id === 'string') : []
    };
  } catch {
    return emptyOnlineLib();
  }
}

let onlineLib = readOnlineLib();

function saveOnlineLib() {
  try {
    const keys = Object.keys(onlineLib.tracks);
    if (keys.length > OL_TRACK_LIMIT) {
      const used = new Set([
        ...onlineLib.favorites,
        ...onlineLib.recent,
        ...state.playlists.flatMap(item => item.tracks)
      ]);
      keys.slice(0, keys.length - OL_TRACK_LIMIT).forEach(id => {
        if (!used.has(id)) delete onlineLib.tracks[id];
      });
    }
    localStorage.setItem(OL_LIB_KEY, JSON.stringify(onlineLib));
  } catch (error) {
    console.warn('在线库保存失败', error);
  }
}

/** 只存元数据：直链、歌词这些运行时缓存每次重新拿，避免本地数据过期 */
function persistableTrack(track) {
  return {
    source: track.source,
    key: track.key,
    songId: track.songId || '',
    mid: track.mid || '',
    hash: track.hash || '',
    albumId: track.albumId || '',
    albumAudioId: track.albumAudioId || '',
    mediaMid: track.mediaMid || '',
    title: track.title || '',
    artist: track.artist || '',
    album: track.album || '',
    duration: Math.round(Number(track.duration) || 0),
    cover: track.cover || '',
    vip: Boolean(track.vip),
    quality: Array.isArray(track.quality) ? track.quality : [],
    qualityLabel: track.qualityLabel || '',
    savedAt: Date.now()
  };
}

/** 平台返回的封面有些还是 http，统一升到 https，别在控制台刷混合内容警告 */
function secureUrl(url) {
  return typeof url === 'string' ? url.replace(/^http:/i, 'https:') : url;
}

function makeTrack(record) {
  const key = record.key || `${record.source}:${record.songId || record.mid || record.hash || ''}`;
  return {
    ...record,
    cover: secureUrl(record.cover),
    key,
    id: `online:${key}`,
    format: '在线',
    qualityLabel: record.qualityLabel || (record.quality && record.quality.length ? record.quality[record.quality.length - 1] : '在线'),
    vip: Boolean(record.vip),
    _online: true,
    _path: '',
    _src: '',
    _srcAt: 0,
    _lyrics: []
  };
}

/** 接口返回的曲目 -> 播放器曲目，并登记进 state.online / 在线库 */
function normalizeTrack(item) {
  const track = makeTrack(item);
  const existing = state.online.find(entry => entry.id === track.id);
  if (existing) {
    // 已有对象要保留 _src / _lyrics 等运行时缓存，只补空字段
    if (!existing.cover && track.cover) existing.cover = track.cover;
    if (!existing.duration && track.duration) existing.duration = track.duration;
    if (!existing.album && track.album) existing.album = track.album;
    if (!onlineLib.tracks[existing.id]) onlineLib.tracks[existing.id] = persistableTrack(existing);
    return existing;
  }
  state.online.push(track);
  onlineLib.tracks[track.id] = persistableTrack(track);
  return track;
}

/** 启动时把持久化的在线曲目恢复到内存，保证收藏 / 歌单 / 最近播放里的歌能查到 */
/**
 * 老版本把在线歌单存在 onlineLib.playlists 里，跟本地歌单是两张表。
 * 启动时搬进 state.playlists，之后只认这一张。
 */
function migrateOnlinePlaylists() {
  if (!Array.isArray(onlineLib.playlists) || !onlineLib.playlists.length) return;
  let moved = 0;
  onlineLib.playlists.forEach(item => {
    if (!item || !item.id) return;
    const tracks = Array.isArray(item.tracks) ? item.tracks.filter(Boolean) : [];
    const existing = state.playlists.find(entry => entry.id === item.id);
    if (existing) {
      tracks.forEach(id => { if (!existing.tracks.includes(id)) existing.tracks.push(id); });
    } else {
      state.playlists.push({
        id: String(item.id),
        name: String(item.name || '未命名歌单'),
        tracks: [...tracks],
        createdAt: Number(item.createdAt) || Date.now()
      });
    }
    moved += 1;
  });
  onlineLib.playlists = [];
  saveState();
  saveOnlineLib();
  if (typeof renderPlaylists === 'function') renderPlaylists();
  console.log('[online] 已把 ' + moved + ' 个在线歌单并入本地歌单');
}

function restoreOnlineTracks() {
  const ids = [
    ...onlineLib.favorites,
    ...onlineLib.recent,
    ...state.playlists.flatMap(item => item.tracks)
  ];
  ids.forEach(id => {
    const record = onlineLib.tracks[id];
    if (record) normalizeTrack(record);
  });
}

/* ==========================================================================
   收藏与歌单
   ========================================================================== */

const isOnlineFavorite = id => onlineLib.favorites.includes(id);

function favoriteTracksLocal() {
  return onlineLib.favorites.map(id => getTrack(id)).filter(Boolean);
}

function toggleOnlineFavorite(id) {
  const index = onlineLib.favorites.indexOf(id);
  if (index >= 0) {
    onlineLib.favorites.splice(index, 1);
    showToast('已从我喜欢中移除');
  } else {
    const track = getTrack(id);
    if (!track) return;
    if (!state.online.includes(track)) state.online.push(track);
    onlineLib.tracks[id] = onlineLib.tracks[id] || persistableTrack(track);
    onlineLib.favorites.unshift(id);
    showToast('已加入我喜欢');
  }
  saveOnlineLib();
  renderOnlinePage();
  if (state.page === 'favorites' && typeof renderFavorites === 'function') renderFavorites();
  if (typeof updateFavoriteUi === 'function') updateFavoriteUi();
}

/** 在线歌单变了：在线页和本地「歌单」页是同一份数据，两边都得重画 */
function syncPlaylistViews() {
  renderOnlinePage();
  if (typeof renderPlaylists === 'function') renderPlaylists();
  if (typeof renderCounts === 'function') renderCounts();
}

/**
 * 建歌单。
 * 歌单只有一份：state.playlists（「歌单」页和在线页读的是同一张表）。
 * 以前在线页写 onlineLib.playlists、本地页读 state.playlists，
 * 结果在在线页建的歌单在「歌单」页里根本看不到，网络歌曲也加不进本地歌单。
 */
function createOnlinePlaylist(name) {
  const title = String(name || '').trim() || `我的歌单 ${state.playlists.length + 1}`;
  const playlist = { id: `olp-${Date.now().toString(36)}`, name: title, tracks: [], createdAt: Date.now() };
  state.playlists.unshift(playlist);
  saveState();
  syncPlaylistViews();
  return playlist;
}

function addTrackToPlaylist(playlistId, id) {
  const playlist = state.playlists.find(item => item.id === playlistId);
  const track = getTrack(id);
  if (!playlist || !track) return;
  if (playlist.tracks.includes(id)) {
    showToast(`已经在「${playlist.name}」里了`);
    return;
  }
  playlist.tracks.push(id);
  // 在线曲目要落一份元数据，否则重启后按 id 找不到这首歌
  if (track._online) onlineLib.tracks[id] = onlineLib.tracks[id] || persistableTrack(track);
  saveState();
  saveOnlineLib();
  showToast(`已加入「${playlist.name}」`);
  syncPlaylistViews();
}

function removeTrackFromPlaylist(playlistId, id) {
  const playlist = state.playlists.find(item => item.id === playlistId);
  if (!playlist) return;
  playlist.tracks = playlist.tracks.filter(trackId => trackId !== id);
  saveState();
  saveOnlineLib();
  showToast('已从歌单移除');
  if (OL.detail?.kind === 'mine' && OL.detail.id === playlistId) openOnlineDetail('mine', playlistId);
  syncPlaylistViews();
}

function deleteOnlinePlaylist(playlistId) {
  state.playlists = state.playlists.filter(item => item.id !== playlistId);
  saveState();
  saveOnlineLib();
  if (OL.detail?.id === playlistId) closeOnlineDetail();
  syncPlaylistViews();
}

/** 把平台歌单整张复制到本地（曲目元数据一起落盘） */
async function importPlaylistToMine(name, tracks) {
  if (!tracks.length) return;
  const playlist = createOnlinePlaylist(name);
  tracks.forEach(track => {
    const normalized = normalizeTrack(track);
    if (!playlist.tracks.includes(normalized.id)) playlist.tracks.push(normalized.id);
  });
  saveOnlineLib();
  showToast(`已收藏歌单「${playlist.name}」，共 ${playlist.tracks.length} 首`);
  switchOnlineView('playlists');
}

/* ==========================================================================
   播放桥接（供 app.js 的播放内核调用）
   ========================================================================== */

/** 只传主进程解析需要的字段，避免整对象来回序列化 */
function trackPayload(track) {
  return {
    source: track.source,
    songId: track.songId,
    mid: track.mid,
    hash: track.hash,
    albumId: track.albumId,
    albumAudioId: track.albumAudioId,
    mediaMid: track.mediaMid,
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: track.duration,
    cover: track.cover,
    vip: track.vip
  };
}

/* ==========================================================================
   音质
   档位按平台各自的真实选项来给（不是硬凑三档）：
     网易云 standard / higher / exhigh / lossless
     QQ     C400 标准 / M500 高品质 / F000 无损
     酷狗   128 / 320 / 999(flac)
   主进程按 id 映射成各平台参数（online/netease.js、qq.js、kugou.js）。
   直链带音质参数，所以换档必须作废已缓存的直链。
   本地曲目没有音质可选，播放条上的徽标只对在线曲目可点。
   ========================================================================== */

const QUALITY_KEY = 'orange-online-quality';
const QUALITY_STORE = source => `orange-online-quality:${source}`;

const QUALITY_CATALOG = {
  netease: {
    defaultId: 'exhigh',
    items: [
      { id: 'standard', label: '标准', hint: '128K', bitrate: 128 },
      { id: 'higher', label: '较高', hint: '192K', bitrate: 192 },
      { id: 'exhigh', label: '极高', hint: '320K', bitrate: 320 },
      { id: 'lossless', label: '无损', hint: 'FLAC', bitrate: 900, vip: true },
      { id: 'hires', label: 'Hi-Res', hint: '24bit', bitrate: 1400, vip: true },
      { id: 'jymaster', label: '超清母带', hint: '母带级', bitrate: 2000, vip: true }
    ]
  },
  qq: {
    defaultId: 'high',
    items: [
      { id: 'standard', label: '标准', hint: 'M4A', bitrate: 128 },
      { id: 'high', label: '高品质', hint: 'MP3 320K', bitrate: 320 },
      { id: 'lossless', label: '无损', hint: 'SQ FLAC', bitrate: 900, vip: true },
      { id: 'hires', label: 'Hi-Res', hint: '24bit', bitrate: 1400, vip: true },
      { id: 'master', label: '臻品母带', hint: '母带级', bitrate: 2000, vip: true }
    ]
  },
  kugou: {
    defaultId: 'high',
    items: [
      { id: 'standard', label: '标准', hint: '128K', bitrate: 128 },
      { id: 'high', label: '高品', hint: '320K', bitrate: 320 },
      { id: 'lossless', label: '无损', hint: 'FLAC', bitrate: 900, vip: true }
    ]
  }
};

const qualityCatalog = source => QUALITY_CATALOG[source] || QUALITY_CATALOG.netease;
const qualityItems = source => qualityCatalog(source).items;
const qualityItemOf = (source, id) => qualityItems(source).find(item => item.id === id) || null;
/** 当前生效的平台：在线页看 state.onlineSource，搜索页看 GS.source */
const qualitySource = () => state.onlineSource || 'netease';

/**
 * 取某个平台当前选中的音质档位。
 * 老版本只存了全局 key（没有分平台），这里做一次兼容读取，不改用户已有习惯。
 */
function onlineQuality(source) {
  const src = source || qualitySource();
  let stored = '';
  try { stored = localStorage.getItem(QUALITY_STORE(src)) || localStorage.getItem(QUALITY_KEY) || ''; } catch {}
  return qualityItemOf(src, stored) ? stored : qualityCatalog(src).defaultId;
}

function onlineQualityLabel(source, id) {
  const item = qualityItemOf(source || qualitySource(), id || onlineQuality(source));
  return item ? item.label : '高品质';
}

/** 换档后所有该平台的直链都失效（直链里带着音质参数） */
function invalidateOnlineSource(source) {
  const hit = track => source ? track.source === source : true;
  state.online.filter(hit).forEach(track => { track._src = ''; track._srcAt = 0; track._quality = ''; });
  (typeof GS !== 'undefined' ? GS.results : []).filter(hit).forEach(track => { track._src = ''; track._srcAt = 0; track._quality = ''; });
}

function renderQualityPickerInto(box, source) {
  if (!box) return;
  const list = qualityItems(source);
  const current = onlineQuality(source);
  box.innerHTML = `<span class="ol-quality-label">音质</span>${list.map(item => `
    <button class="ol-quality-opt ${item.id === current ? 'active' : ''}" data-ol-quality="${item.id}" data-ol-quality-source="${source}"
      title="${item.label} · ${item.hint}${item.vip ? '（需要该平台会员）' : ''}" aria-pressed="${item.id === current}">${item.label}</button>`).join('')}`;
}

/** 在线页与搜索页各有一份选择器，各按自己平台的档位重绘 */
function renderQualityPickers() {
  renderQualityPickerInto($('#olQuality'), qualitySource());
  renderQualityPickerInto($('#gsQuality'), typeof gsSource === 'function' ? gsSource() : qualitySource());
}

function setOnlineQuality(id, source) {
  const src = source || qualitySource();
  if (!qualityItemOf(src, id) || id === onlineQuality(src)) return;
  try { localStorage.setItem(QUALITY_STORE(src), id); } catch {}
  invalidateOnlineSource(src);
  renderQualityPickers();
  const label = onlineQualityLabel(src, id);
  const current = getTrack(state.currentId);
  // 正在放的就是这个平台的歌 → 直接重解析并续播，不用用户手动重播
  if (current?._online && current.source === src) {
    applyTrackQuality(id);
    return;
  }
  showToast(`音质已切换为${label}`);
}

/**
 * 判断「用户选的档位」和「实际拿到的码流」是否一致。
 * 会员档位没权限时主进程会逐级回退，光看 _src 是看不出来的，
 * 所以这里按档位名 + 码率一起判定，徽标才有东西可显示。
 */
function qualityDelivery(track) {
  const source = track?.source || 'netease';
  const wanted = qualityItemOf(source, track?._quality || onlineQuality(source));
  if (!wanted) return { wanted: null, delivered: true, actual: '' };
  const actualLabel = String(track.qualityLabel || '');
  const bitrate = Math.round(Number(track.bitrate) || 0);
  const actual = actualLabel || (bitrate ? `${bitrate}K` : '');
  if (!actual) return { wanted, delivered: true, actual };
  // 平台回的是档位名（极高 / 无损 / Hi-Res）就按名字比；
  // 只回码率的（酷狗「320K」）才按码率比。FLAC 码率浮动很大，不能用码率判断无损。
  const delivered = /^\d+\s*K$/i.test(actualLabel)
    ? (!wanted.bitrate || bitrate >= wanted.bitrate * 0.95)
    : actualLabel === wanted.label;
  return { wanted, delivered, actual };
}

/**
 * 播放条徽标上显示的音质文案。
 * 主要显示「用户选的档位」，拿不到时把实际码流带上，别让人以为点了没反应。
 */
function onlineQualityText(track) {
  if (!track?._online) return '';
  // makeTrack 给的 format 占位值是「在线」，它不是一个格式，
  // 直接拼上去就成了「超清母带 · 在线」这种又长又丑的尾巴，这里当空处理。
  const rawFormat = String(track.format || '').toUpperCase();
  const format = rawFormat === '在线' || rawFormat === 'ONLINE' ? '' : rawFormat;
  const bitrate = Math.round(Number(track.bitrate) || 0);
  const { wanted, delivered, actual } = qualityDelivery(track);
  let text;
  if (wanted && !delivered) {
    // 选了母带 / Hi-Res 但只拿到低档：写成「超清母带 → MP3 320K」，一眼看出降级
    text = `${wanted.label} → ${actual}`;
  } else if (wanted) {
    text = format && format !== wanted.label.toUpperCase() ? `${wanted.label} · ${format}` : wanted.label;
  } else if (format && bitrate) {
    text = `${format} · ${bitrate}K`;
  } else {
    text = format || '在线';
  }
  if (track.trial) text += ' · 试听';
  return text;
}

/* ---------------------- 播放条音质菜单（点徽标弹出） ---------------------- */

let qualityMenuNode = null;

function closeQualityMenu() {
  if (qualityMenuNode) {
    qualityMenuNode.remove();
    qualityMenuNode = null;
  }
  document.removeEventListener('click', onQualityMenuOutside, true);
  document.removeEventListener('keydown', onQualityMenuKeydown, true);
}

function onQualityMenuOutside(event) {
  if (qualityMenuNode && !qualityMenuNode.contains(event.target) && event.target.id !== 'fullContext' && !event.target.closest?.('#fullContext')) {
    closeQualityMenu();
  }
}

function onQualityMenuKeydown(event) {
  if (event.key === 'Escape') closeQualityMenu();
}

/**
 * 菜单底部那句说明。
 * 账号状态可能还没拉过（直接在全屏播放页点徽标、没进过在线页），
 * 这时不能断言「还没登录」—— 之前就因为这个误报，明明登录着却说游客只发标准音质。
 */
function qualityMenuNote(source) {
  const account = olAccountOf(source);
  const short = olSourceMeta(source).short;
  if (!account) return '会员档位需要该平台会员，账号没有权限时会自动回落到可用档位。';
  if (account.loggedIn) return '无损 / 较高档位需要该平台会员，账号没有权限时会自动回落到可用档位。';
  return `还没登录${short}账号，目前只能拿到标准音质；登录后可切到更高档位。`;
}

/**
 * 点播放条上的音质徽标 → 弹菜单。
 * 只对在线曲目生效；本地曲目直接返回，保持原来的「不可交互」观感。
 */
function openQualityMenu() {
  const track = getTrack(state.currentId);
  if (!track?._online) return;
  if (qualityMenuNode) { closeQualityMenu(); return; }
  const badge = $('#fullContext');
  if (!badge) return;

  const source = track.source || 'netease';
  const list = qualityItems(source);
  const current = onlineQuality(source);
  const delivery = qualityDelivery(track);
  // 选了会员档却只拿到低档时写「实听」，和徽标保持一致
  const headRight = delivery.actual
    ? `${delivery.delivered ? '当前' : '实听'} ${delivery.actual}`
    : '';
  const short = olSourceMeta(source).short;
  const note = qualityMenuNote(source);

  const menu = document.createElement('div');
  menu.className = 'qm-menu';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', '选择音质');
  menu.innerHTML = `
    <div class="qm-head">
      <span>音质</span>
      <em>${escapeHtml(short)}${headRight ? ` · ${escapeHtml(headRight)}` : ''}</em>
    </div>
    <div class="qm-list">${list.map(item => `
      <button type="button" class="qm-opt ${item.id === current ? 'active' : ''}" data-qm-quality="${item.id}">
        <i class="qm-dot" aria-hidden="true"></i>
        <b>${item.label}</b>
        <span>${item.hint}</span>
        ${item.vip ? '<em class="qm-vip">会员</em>' : ''}
      </button>`).join('')}</div>
    <p class="qm-note">${escapeHtml(note)}</p>`;

  document.body.appendChild(menu);
  qualityMenuNode = menu;

  // 账号状态还没拉过就先拉一次，回来把说明文字改成准确的
  if (!state.onlineAccounts.length) {
    refreshOnlineAccounts(true).then(() => {
      const noteNode = qualityMenuNode?.querySelector('.qm-note');
      if (noteNode) noteNode.textContent = qualityMenuNote(source);
    });
  }

  // 贴在徽标上方居中，超出窗口就贴边
  const rect = badge.getBoundingClientRect();
  const width = menu.offsetWidth;
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8);
  const top = rect.top - menu.offsetHeight - 10;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top > 8 ? top : rect.bottom + 10)}px`;

  menu.addEventListener('click', event => {
    const button = event.target.closest('[data-qm-quality]');
    if (!button) return;
    event.stopPropagation();
    applyTrackQuality(button.dataset.qmQuality);
  });

  // 下一帧再挂关闭监听，避免这一下点击立刻把菜单关掉
  setTimeout(() => {
    document.addEventListener('click', onQualityMenuOutside, true);
    document.addEventListener('keydown', onQualityMenuKeydown, true);
  }, 0);
}

/**
 * 切档并就地续播：记住当前进度，重新解析直链，再跳回原位继续放。
 * 只有在线曲目会走到这里（本地曲目没有音质可选）。
 */
async function applyTrackQuality(id) {
  const track = getTrack(state.currentId);
  if (!track?._online) { closeQualityMenu(); return; }
  const source = track.source || 'netease';
  const label = onlineQualityLabel(source, id);
  if (id === onlineQuality(source) && track._quality === id) { closeQualityMenu(); return; }

  try { localStorage.setItem(QUALITY_STORE(source), id); } catch {}
  closeQualityMenu();
  renderQualityPickers();

  const position = Math.max(0, Number(audio.currentTime) || 0);
  const wasPlaying = !audio.paused;
  track._src = '';
  track._srcAt = 0;
  track._quality = '';
  track.qualityNotified = false;
  track.trialNotified = false;
  // 旧的容器 / 码率 / 档位标签属于上一档，别再拿来拼徽标，
  // 否则会出现「档位已经换了、格式还是上一次的」这种自相矛盾的显示
  track.format = '在线';
  track.bitrate = 0;
  track.qualityLabel = '';
  updatePlayerUi();
  showToast(`正在切换到${label}…`);

  let src = '';
  try {
    src = await resolveOnlineSource(track);
  } catch (error) {
    showToast(error?.message || '切换音质失败');
    updatePlayerUi();
    return;
  }
  // 解析期间用户可能已经换了歌，别把新歌顶掉
  if (state.currentId !== track.id) return;

  audio.src = src;
  audio.load();
  const seek = () => { try { audio.currentTime = position; } catch {} };
  if (audio.readyState >= 1) seek();
  else audio.addEventListener('loadedmetadata', seek, { once: true });
  if (wasPlaying) audio.play().catch(() => {});
  updatePlayerUi();
  // 说「已切换为 X」之前先确认真的拿到了 X，否则就是在骗人
  const delivery = qualityDelivery(track);
  if (delivery.wanted && !delivery.delivered) {
    showToast(`${delivery.wanted.label}需要会员或该平台未开放，当前实听${delivery.actual}`);
  } else {
    showToast(`音质已切换为${onlineQualityLabel(source, onlineQuality(source))}`);
  }
}

function initQualityBadge() {
  const badge = $('#fullContext');
  if (!badge) return;
  badge.addEventListener('click', event => {
    event.stopPropagation();
    openQualityMenu();
  });
  badge.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openQualityMenu();
    }
  });
}

/**
 * 解析在线直链（app.js 的 resolveTrackSource 会调到这里）。
 * 直链有有效期，过期后重新解析；顺带把封面与歌词补上。
 */
async function resolveOnlineSource(track) {
  const quality = onlineQuality(track.source);
  const fresh = track._src && track._srcAt && (Date.now() - track._srcAt < OL_SRC_TTL) && track._quality === quality;
  if (fresh) return track._src;
  if (!window.orangeDesktop?.onlineResolve) throw new Error('在线播放需要在客户端中使用');
  const info = await window.orangeDesktop.onlineResolve(trackPayload(track), { quality });
  track._quality = quality;
  if (!info?.url) throw new Error('没有取到播放地址');
  track._src = info.url;
  track._srcAt = Date.now();
  if (info.cover) track.cover = info.cover;
  if (info.type) track.format = String(info.type).toUpperCase();
  if (info.level) track.qualityLabel = info.level;
  if (info.bitrate) track.bitrate = info.bitrate;
  if (info.lyric) {
    track._lyrics = parseLyrics(info.lyric);
    track._lyricChecked = true;
    track._lyricSource = 'online';
  }
  if (info.trial && !track.trialNotified) {
    track.trialNotified = true;
    showToast('当前只拿到了试听片段，登录该平台账号后可完整播放');
  }
  // 选了会员档位（无损 / Hi-Res / 母带）却拿到更低档：说清楚是账号权限问题，
  // 别让用户以为设置没生效。逐档回退的实现在主进程里。
  const wanted = qualityItemOf(track.source, quality);
  if (wanted?.vip && info.level && info.level !== wanted.label && !track.qualityNotified) {
    track.qualityNotified = true;
    showToast(`当前账号只能拿到${info.level}，${wanted.label}需要该平台会员`);
  }
  if (onlineLib.tracks[track.id] && info.cover) {
    onlineLib.tracks[track.id].cover = info.cover;
    saveOnlineLib();
  }
  return info.url;
}

/**
 * 歌词单独补一次。
 * 直链解析里会顺手带歌词，但两种情况会漏：解析走了缓存（同一首重新播放不重新请求）、
 * 或者直链解析本身失败。歌词接口和码流接口是两回事，不该被绑在一起，
 * 所以这里单独兜底一次，失败不清标记的语义也保留：下次播放会再试。
 */
async function ensureOnlineLyrics(track) {
  if (!track?._online || track._lyricChecked || !window.orangeDesktop?.onlineLyric) return;
  if (typeof getLyrics === 'function' && getLyrics(track).length) { track._lyricChecked = true; return; }
  track._lyricChecked = true;
  try {
    const text = await window.orangeDesktop.onlineLyric(trackPayload(track));
    if (!text) return;
    track._lyrics = parseLyrics(text);
    track._lyricSource = 'online';
    if (state.currentId === track.id) {
      renderLyricSource();
      renderLyrics();
      if (typeof pushDesktopLyricsState === 'function') pushDesktopLyricsState();
    }
  } catch (error) {
    // 接口临时失败：放开标记，下次播放 / 再点这首歌时会重试
    track._lyricChecked = false;
    console.warn('online lyric failed', error);
  }
}

async function playOnlineTrack(id) {
  const track = getTrack(id);
  if (!track) return;
  if (!state.online.includes(track)) state.online.push(track);
  if (state.currentId === id && track._src) {
    if (audio.paused) togglePlayback();
    return;
  }
  await playTrack(id);
}

/** 收藏页要混合展示在线收藏，由 app.js 的 renderFavorites 调用 */
function renderOnlineFavorites() {
  // 账号红心里已经有的歌交给下面那段展示，这里去掉免得同一首出现两遍
  const accountIds = new Set((OL.likedAccount || []).map(track => track.id));
  const tracks = favoriteTracksLocal().filter(track => !accountIds.has(track.id));
  if (!tracks.length) return '';
  return `
    <div class="ol-fav-divider">来自在线音乐（${tracks.length}）</div>
    ${tracks.map((track, index) => olRowHtml(track, index, { context: 'fav' })).join('')}
  `;
}

/**
 * 「喜爱」页要展示哪个平台的账号红心：
 * 当前音源已登录就用它，否则挑第一个已登录的平台（不然在 QQ 页时网易云红心就看不见了）。
 */
function favoritesPlatformSource() {
  if (olAccountOf(state.onlineSource)?.loggedIn) return state.onlineSource;
  const logged = (state.onlineAccounts || []).find(item => item.loggedIn);
  return logged ? logged.id : '';
}

/**
 * 本地「歌单」页里列在线歌单。
 * 两处歌单本来就是同一份数据（onlineLib.playlists），只是以前只有在线页能看到，
 * 在本地页翻歌单的人会以为在线建的歌单丢了。
 */
/**
 * 账号红心分区。平台红心列表本身就是「已在红心」，所以这里不再按本地收藏过滤
 * （否则用户点一下心，这首歌就从这段里消失了，看着像被删了）。
 */
function renderPlatformFavorites() {
  const source = OL.likedSource || favoritesPlatformSource();
  if (!source) return '';
  const account = olAccountOf(source);
  if (!account?.loggedIn) return '';
  const meta = olSourceMeta(source);
  const all = OL.likedAccount || [];
  // 红心歌单动辄上千首，全铺在喜爱页会把 DOM 撑爆；先给前 200 首，其余去在线页看
  const LIMIT = 200;
  const tracks = all.slice(0, LIMIT);

  if (!tracks.length) {
    if (OL.likedLoading) return `<div class="ol-fav-divider">${escapeHtml(meta.short)} 账号红心 · 正在读取…</div>`;
    if (OL.likedError) return '';
    return `<div class="ol-fav-divider">${escapeHtml(meta.short)} 账号红心</div>
      <div class="ol-empty">账号里还没有红心歌曲，在在线音乐页点红心试试</div>`;
  }
  const more = all.length > tracks.length
    ? `<div class="ol-empty">还有 ${all.length - tracks.length} 首，去在线音乐页的「喜爱」看完整列表</div>`
    : '';
  return `
    <div class="ol-fav-divider">${escapeHtml(meta.short)} 账号红心 · ${all.length} 首</div>
    ${tracks.map((track, index) => olRowHtml(track, index, { context: 'fav', platformFav: true })).join('')}
    ${more}
  `;
}

/**
 * 喜爱页打开时按需拉一次账号红心，拉完重绘。
 * 只试一次：失败不反复请求，用户可以去在线页手动刷新。
 */
function ensureFavoritesPlatform(force = false) {
  const source = favoritesPlatformSource();
  if (!source) return Promise.resolve();
  if (!force && OL.likedTried && OL.likedSource === source && OL.likedLoaded) return Promise.resolve();
  if (OL.likedLoading) return Promise.resolve();
  OL.likedTried = true;
  return loadLiked(force || OL.likedSource !== source, source)
    .finally(() => {
      if (state.page === 'favorites' && typeof renderFavorites === 'function') renderFavorites();
    });
}

/* ==========================================================================
   渲染：平台 / 账号
   ========================================================================== */

function renderPlatforms() {
  const target = $('#olPlatforms');
  if (!target) return;
  target.innerHTML = OL_SOURCES.map(source => {
    const account = olAccountOf(source.id);
    const active = state.onlineSource === source.id;
    const logged = Boolean(account?.loggedIn);
    return `<button class="ol-platform ${active ? 'active' : ''}" data-ol-source="${source.id}" role="tab" aria-selected="${active}">
      <span class="ol-platform-dot" style="background:${source.color}"></span>
      <span>${escapeHtml(source.short)}</span>
      <span class="ol-platform-state ${logged ? 'online' : ''}" title="${logged ? '已登录' : '未登录'}"></span>
    </button>`;
  }).join('');
}

function renderAccount() {
  const target = $('#olAccount');
  if (!target) return;
  const source = olSourceMeta(state.onlineSource);
  const account = olAccountOf(source.id);
  const profile = account?.profile || {};
  const logged = Boolean(account?.loggedIn);
  const initial = String(profile.nickname || source.short).slice(0, 1);

  target.className = `ol-account ${logged ? 'logged' : ''}`;
  target.innerHTML = `
    <div class="ol-avatar">${logged && profile.avatar
      ? `<img src="${escapeHtml(profile.avatar)}" alt="" />`
      : logged ? escapeHtml(initial) : '<svg class="icon"><use href="#i-user"/></svg>'}</div>
    <div class="ol-account-copy">
      <strong>${logged ? escapeHtml(profile.nickname || '已登录') : `还没有登录 ${escapeHtml(source.name)}`}
        ${logged && profile.vip ? '<span class="ol-badge">VIP</span>' : ''}</strong>
      <span>${logged
        ? `已连接 ${escapeHtml(source.name)}，可播放会员曲目、读取账号歌单`
        : '登录后能播会员曲目与「我喜欢的音乐」；不登录也能搜索、试听免费歌曲'}</span>
    </div>
    <div class="ol-account-actions">
      ${logged
        ? `<button class="button secondary small" data-ol-logout="${source.id}">退出登录</button>`
        : `<button class="button primary small" data-ol-login="${source.id}"><svg class="icon"><use href="#i-login"/></svg>登录 ${escapeHtml(source.short)}</button>`}
    </div>`;
}

function refreshOnlineAccounts(force = false) {
  if (!window.orangeDesktop?.onlineProviders) return Promise.resolve();
  if (state.onlineAccounts.length && !force) return Promise.resolve();
  return window.orangeDesktop.onlineProviders()
    .then(list => { state.onlineAccounts = list; })
    .catch(error => { state.onlineAccounts = []; console.warn(error); });
}

/* ==========================================================================
   渲染：曲目行 / 卡片
   ========================================================================== */

function olRowHtml(track, index, options = {}) {
  const current = state.currentId === track.id;
  // 歌单合并后，同一个歌单里既有网络歌曲也有本地文件，行样式要分开处理，
  // 否则本地 wav 会被标成「免费 · 网易云」
  const isOnline = Boolean(track._online);
  // 账号红心列表里的歌本来就在红心里，心形直接点亮，不依赖本地收藏
  const platformFav = Boolean(options.platformFav);
  const favorite = isOnline
    ? (platformFav || isOnlineFavorite(track.id))
    : state.favorites.has(track.id);
  const badge = isOnline
    ? (track.vip ? '<span class="ol-badge">VIP</span>' : '<span class="ol-badge free">免费</span>')
    : `<span class="ol-badge free">${escapeHtml(track.format || '本地')}</span>`;
  const meta = isOnline ? olSourceMeta(track.source) : { short: '本地文件', name: '本地文件' };
  const removable = options.context === 'mine' && options.playlistId;
  return `
    <div class="ol-row ${current ? 'playing' : ''}" data-ol-track="${track.id}">
      <div class="ol-row-index">
        <span>${String(index + 1).padStart(2, '0')}</span>
        <button class="icon-button" data-ol-play="${track.id}" aria-label="播放 ${escapeHtml(track.title)}">
          <svg class="icon filled"><use href="#${current && state.playing ? 'i-pause' : 'i-play'}"/></svg>
        </button>
      </div>
      <div class="ol-row-main">
        <img src="${escapeHtml(track.cover || DEFAULT_COVER)}" alt="" loading="lazy" />
        <div class="ol-row-text">
          <div class="ol-row-title"><span>${escapeHtml(track.title)}</span>${badge}</div>
          <div class="ol-row-sub">${escapeHtml(track.artist)}${track.album ? ` · ${escapeHtml(track.album)}` : ''} · ${escapeHtml(meta.short)}</div>
        </div>
      </div>
      ${options.context === 'fav' ? `
      <div class="track-album">${escapeHtml(track.album || '—')}</div>
      <span class="track-format">在线</span>` : ''}
      <div class="ol-row-dur">${formatTime(track.duration)}</div>
      <div class="ol-row-actions">
        <button class="icon-button favorite ${favorite ? 'active' : ''}" ${isOnline ? `data-ol-fav="${track.id}"` : `data-favorite="${track.id}"`} ${platformFav ? 'data-ol-fav-account="1"' : ''} title="${platformFav ? '来自账号红心' : favorite ? '取消喜欢' : '加入我喜欢'}" aria-label="喜欢">
          <svg class="icon"><use href="#i-heart"/></svg>
        </button>
        <button class="icon-button" data-ol-queue="${track.id}" title="加入播放队列" aria-label="加入队列">
          <svg class="icon"><use href="#i-plus"/></svg>
        </button>
        <button class="icon-button" data-ol-add="${track.id}" title="加入歌单" aria-label="加入歌单">
          <svg class="icon"><use href="#i-list"/></svg>
        </button>
        ${removable
          ? `<button class="icon-button danger" data-ol-remove="${track.id}" data-ol-remove-from="${options.playlistId}" title="从歌单移除" aria-label="移除">
              <svg class="icon"><use href="#i-x"/></svg>
            </button>`
          : (isOnline ? `<button class="icon-button" data-ol-site="${track.id}" title="在源站打开" aria-label="源站">
              <svg class="icon"><use href="#i-info"/></svg>
            </button>` : '')}
      </div>
    </div>`;
}

function olListHtml(tracks, options = {}) {
  if (!tracks.length) return '';
  return tracks.map((track, index) => olRowHtml(track, index, options)).join('');
}

function olEmptyHtml(title, detail, action = '') {
  return `<div class="ol-empty"><strong>${escapeHtml(title)}</strong>${escapeHtml(detail)}${action}</div>`;
}

function olCardHtml(item, kind) {
  const cover = item.cover
    ? `<img src="${escapeHtml(item.cover)}" alt="" loading="lazy" />`
    : `<div class="ol-card-fallback"><svg class="icon"><use href="#i-list"/></svg></div>`;
  const countText = item.count ? `${item.count} 首` : (item.creator || '');
  const meta = [countText, item.creator && item.count ? item.creator : ''].filter(Boolean).join(' · ');
  return `
    <article class="ol-card" data-ol-open="${kind}:${item.id}" tabindex="0">
      <div class="ol-card-cover">
        ${cover}
        <button class="ol-card-play" data-ol-play-set="${kind}:${item.id}" aria-label="播放 ${escapeHtml(item.name)}">
          <svg class="icon"><use href="#i-play"/></svg>
        </button>
      </div>
      <div class="ol-card-name">${escapeHtml(item.name)}</div>
      <div class="ol-card-meta">${escapeHtml(meta || '歌单')}</div>
    </article>`;
}

/* ==========================================================================
   渲染：四个视图
   ========================================================================== */

function renderTabs() {
  $$('#olTabs .ol-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.olView === OL.view));
  $$('[data-ol-panel]').forEach(panel => panel.classList.toggle('active', panel.dataset.olPanel === OL.view));
}

function renderOnlinePage() {
  renderQualityPickers();
  if (state.page !== 'online') return;
  renderPlatforms();
  renderAccount();
  renderTabs();
  if (OL.view === 'daily') renderDaily();
  else if (OL.view === 'search') renderSearch();
  else if (OL.view === 'liked') renderLiked();
  else if (OL.view === 'playlists') renderOnlinePlaylists();
}

/**
 * 加载占位。以前统一是一行「正在加载…」，页面高度会先塌下去再撑开，
 * 而且那行字在慢网下一挂就是几秒，看着像卡住。骨架块能占住版面，
 * 数据回来时只是内容换掉，不会整页跳一下。
 */
function olSkeletonRows(count = 6) {
  const row = `<div class="sk-row">
      <span class="sk-block"></span>
      <span><span class="sk-line"></span><span class="sk-line tiny"></span></span>
      <span class="sk-line short"></span>
    </div>`;
  return `<div class="ol-skeleton" aria-hidden="true">${row.repeat(count)}</div>`;
}

function olSkeletonCards(count = 6) {
  return `<div class="sk-cards" aria-hidden="true">${'<span class="sk-block"></span>'.repeat(count)}</div>`;
}

function olSkeletonHero() {
  return `<div class="ol-skeleton" aria-hidden="true">
    <div class="sk-hero">
      <span class="sk-block"></span>
      <div class="sk-hero-copy">
        <span class="sk-line short"></span>
        <span class="sk-line"></span>
        <span class="sk-line short"></span>
      </div>
    </div>
  </div>`;
}

function renderDaily() {
  const source = olSourceMeta(state.onlineSource);
  const hero = $('#olDailyHero');
  const note = $('#olDailyNote');
  const list = $('#olDailyList');
  const first = OL.daily[0];

  if (hero) {
    if (!first) {
      hero.innerHTML = OL.dailyLoading
        ? olSkeletonHero()
        : olEmptyHtml('还没有拿到推荐', OL.dailyError || '点「换一批」重新获取', `<button class="button secondary small" data-ol-refresh-daily>重新获取</button>`);
    } else {
      const modeText = OL.dailyMode === 'account'
        ? `来自 ${source.name} 账号的每日推荐`
        : OL.dailyMode === 'local'
          ? '根据你本地的收藏与播放记录挑选'
          : `${source.name} 热榜精选`;
      hero.innerHTML = `
        <div class="ol-hero">
          <div class="ol-hero-cover"><img src="${escapeHtml(first.cover || DEFAULT_COVER)}" alt="" /></div>
          <div class="ol-hero-copy">
            <span class="ol-hero-tag"><svg class="icon"><use href="#i-sparkle"/></svg>今日推荐</span>
            <h2>${escapeHtml(first.title)}</h2>
            <p class="ol-hero-sub">${escapeHtml(first.artist)} · ${escapeHtml(modeText)} · 共 ${OL.daily.length} 首</p>
            <div class="ol-hero-actions">
              <button class="button primary" data-ol-play-daily><svg class="icon filled"><use href="#i-play"/></svg>播放全部</button>
              <button class="button secondary" data-ol-queue-daily><svg class="icon"><use href="#i-plus"/></svg>加入队列</button>
            </div>
          </div>
        </div>`;
    }
  }

  if (note) {
    note.textContent = OL.dailyMode === 'account'
      ? '已登录 · 按账号偏好推荐'
      : OL.dailyMode === 'local'
        ? '未登录 · 按本地偏好挑选'
        : OL.dailyMode === 'chart' ? '未登录 · 平台热榜' : '';
  }
  if (list) list.innerHTML = olListHtml(OL.daily);

  renderPicked();
}

function renderPicked() {
  const grid = $('#olPickedGrid');
  if (!grid) return;
  const title = $('#olPickedTitle');
  const note = $('#olPickedNote');
  const source = olSourceMeta(state.onlineSource);
  const isKugou = state.onlineSource === 'kugou';
  if (title) title.textContent = isKugou ? '酷狗榜单' : `${source.name}精选歌单`;
  if (note) note.textContent = OL.pickedLoading ? '正在加载…' : (OL.pickedError || '');

  if (OL.pickedLoading && !OL.picked.length) {
    grid.innerHTML = olSkeletonCards(6);
    return;
  }
  if (!OL.picked.length) {
    grid.innerHTML = olEmptyHtml('没有可显示的歌单', OL.pickedError || '换个平台试试');
    return;
  }
  grid.innerHTML = OL.picked.map(item => olCardHtml(item, 'platform')).join('');
}

function renderSearch() {
  const list = $('#olSearchList');
  const title = $('#olSearchTitle');
  const note = $('#olSearchNote');
  if (title) title.textContent = OL.searchTitle || '搜索结果';
  if (note) note.textContent = OL.searchLoading ? '正在搜索…' : (OL.searchError || (OL.search.length ? `${OL.search.length} 首` : ''));
  if (!list) return;
  if (OL.searchLoading) {
    list.innerHTML = Array.from({ length: 5 }).map(() => `
      <div class="ol-row"><div class="ol-row-index"><span>--</span></div><div class="ol-row-main"><img src="${DEFAULT_COVER}" alt=""><div class="ol-row-text"><div class="ol-row-title"><span>正在搜索…</span></div></div></div><div class="ol-row-dur"></div><div class="ol-row-actions"></div></div>`).join('');
    return;
  }
  list.innerHTML = OL.search.length
    ? olListHtml(OL.search)
    : olEmptyHtml(OL.searchError ? '搜索失败' : '搜点什么听听', OL.searchError || '输入歌名、歌手或专辑，然后回车');
}

function renderLiked() {
  const list = $('#olLikedList');
  const hero = $('#olLikedHero');
  const note = $('#olLikedNote');
  const source = olSourceMeta(state.onlineSource);
  const account = olAccountOf(state.onlineSource);
  const localCount = favoriteTracksLocal().length;

  if (note) {
    note.textContent = OL.likedLoading
      ? '正在读取…'
      : OL.likedMode === 'account'
        ? `已同步 ${source.name} 账号红心 · 本地收藏 ${localCount} 首`
        : OL.likedError ? OL.likedError : `未登录 · 显示本地收藏 ${localCount} 首`;
  }

  if (hero) {
    if (!OL.liked.length) {
      hero.innerHTML = '';
    } else {
      const covers = OL.liked.slice(0, 4).map(track => track.cover).filter(Boolean);
      hero.innerHTML = `
        <div class="ol-hero">
          <div class="ol-hero-cover">${covers[0] ? `<img src="${escapeHtml(covers[0])}" alt="" />` : `<div class="ol-card-fallback"><svg class="icon"><use href="#i-heart"/></svg></div>`}</div>
          <div class="ol-hero-copy">
            <span class="ol-hero-tag"><svg class="icon"><use href="#i-heart"/></svg>我喜欢的音乐</span>
            <h2>${OL.liked.length} 首喜欢的歌</h2>
            <p class="ol-hero-sub">${account?.loggedIn ? `${escapeHtml(account.profile?.nickname || source.name)} 的红心歌单 + 本地收藏` : '未登录，显示的是本地收藏；登录后可同步平台红心'}</p>
            <div class="ol-hero-actions">
              <button class="button primary" data-ol-play-liked><svg class="icon filled"><use href="#i-play"/></svg>播放全部</button>
              <button class="button secondary" data-ol-queue-liked><svg class="icon"><use href="#i-plus"/></svg>加入队列</button>
            </div>
          </div>
        </div>`;
    }
  }

  if (!list) return;
  if (OL.likedLoading) {
    list.innerHTML = olSkeletonRows(8);
    return;
  }
  list.innerHTML = OL.liked.length
    ? olListHtml(OL.liked)
    : olEmptyHtml(
      '还没有喜欢的歌',
      account?.loggedIn ? '在歌曲旁点红心，或在平台里红心收藏' : '点歌曲旁的红心就能收藏到这里，不登录也能用',
      account?.loggedIn ? '' : `<button class="button primary small" data-ol-login="${state.onlineSource}">登录 ${escapeHtml(source.short)} 同步红心</button>`
    );
}

function renderOnlinePlaylists() {
  const mineGrid = $('#olMyPlaylistGrid');
  const platformGrid = $('#olPlatformGrid');
  const platformTitle = $('#olPlatformTitle');
  const platformNote = $('#olPlatformNote');
  const source = olSourceMeta(state.onlineSource);

  if (mineGrid) {
    const cards = state.playlists.map(item => {
      // 封面优先用歌单自己的（用户设过封面就该显示），没有才退回第一首歌的封面。
      // 之前只读第一首歌，导致设了封面的歌单在在线页反而显示成空封面。
      const own = item.cover && item.cover !== DEFAULT_COVER ? item.cover : '';
      const fromTrack = (onlineLib.tracks[item.tracks[0]] || {}).cover || '';
      return olCardHtml({
        id: item.id,
        name: item.name,
        cover: own || fromTrack,
        count: item.tracks.length,
        creator: '本地'
      }, 'mine');
    });
    cards.push(`
      <article class="ol-card create" data-ol-new-playlist tabindex="0">
        <div class="ol-card-cover"><svg class="icon"><use href="#i-plus"/></svg></div>
        <div class="ol-card-name">新建歌单</div>
        <div class="ol-card-meta">把在线歌曲收进来</div>
      </article>`);
    mineGrid.innerHTML = cards.join('');
  }

  if (platformTitle) platformTitle.textContent = state.onlineSource === 'kugou' ? '酷狗榜单' : `${source.name}歌单广场`;
  if (platformNote) platformNote.textContent = OL.platformLoading ? '正在加载…' : (OL.platformError || '');
  if (!platformGrid) return;
  platformGrid.innerHTML = OL.platformLoading
    ? olSkeletonCards(6)
    : OL.platformPlaylists.length
      ? OL.platformPlaylists.map(item => olCardHtml(item, 'platform')).join('')
      : olEmptyHtml('没有可显示的歌单', OL.platformError || '换个平台试试');
}

/* ==========================================================================
   数据加载
   ========================================================================== */

/** 从本地曲库提取偏好歌手：最近播放权重更高，收藏次之 */
function localArtistSeeds() {
  const weights = new Map();
  const add = (id, weight) => {
    const track = getTrack(id);
    if (!track || track._online) return;
    String(track.artist || '').split(/\s*\/\s*|\s*&\s*/).forEach(name => {
      const key = name.trim();
      if (key && key !== '未知歌手') weights.set(key, (weights.get(key) || 0) + weight);
    });
  };
  state.recent.slice(0, 20).forEach((id, index) => add(id, Math.max(1, 6 - index)));
  state.favorites.forEach(id => add(id, 3));
  return [...weights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(entry => entry[0]);
}

async function loadDaily(force = false) {
  if (OL.dailyLoading) return;
  if (!force && OL.daily.length) return;
  const source = state.onlineSource;
  OL.dailyLoading = true;
  OL.dailyError = '';
  renderDaily();
  try {
    const result = await window.orangeDesktop.onlineDaily(source, { artists: localArtistSeeds() });
    if (source !== state.onlineSource) return;
    OL.daily = (result?.tracks || []).map(normalizeTrack);
    OL.dailyMode = result?.mode || '';
    saveOnlineLib();
  } catch (error) {
    if (source !== state.onlineSource) return;
    OL.daily = [];
    OL.dailyError = error.message || '获取推荐失败';
  } finally {
    OL.dailyLoading = false;
    if (source === state.onlineSource) renderDaily();
  }
}

async function loadPicked(force = false) {
  if (OL.pickedLoading) return;
  if (!force && OL.picked.length) return;
  const source = state.onlineSource;
  OL.pickedLoading = true;
  OL.pickedError = '';
  renderPicked();
  try {
    const list = await window.orangeDesktop.onlineRecommendPlaylists(source);
    if (source !== state.onlineSource) return;
    OL.picked = (list || []).filter(item => item && item.id);
  } catch (error) {
    if (source !== state.onlineSource) return;
    OL.picked = [];
    OL.pickedError = error.message || '加载歌单失败';
  } finally {
    OL.pickedLoading = false;
    if (source === state.onlineSource) renderPicked();
  }
}

async function runSearch(keyword) {
  const query = String(keyword || '').trim();
  if (!query) { showToast('请输入歌名或歌手'); return; }
  if (!window.orangeDesktop?.onlineSearch) { showToast('在线功能需要在客户端中使用'); return; }
  const source = state.onlineSource;
  OL.searchLoading = true;
  OL.searchError = '';
  OL.searchTitle = `“${query}” 的搜索结果`;
  renderSearch();
  try {
    const items = await window.orangeDesktop.onlineSearch(source, query, { limit: 40 });
    if (source !== state.onlineSource) return;
    OL.search = (items || []).map(normalizeTrack);
    saveOnlineLib();
  } catch (error) {
    if (source !== state.onlineSource) return;
    OL.search = [];
    OL.searchError = error.message || '搜索失败';
  } finally {
    OL.searchLoading = false;
    if (source === state.onlineSource) renderSearch();
  }
}

let likedToken = 0;

/**
 * 拉「我喜欢的音乐」。
 * source 默认当前音源；本地「喜爱」页会显式传它自己挑的平台，
 * 所以结果是否过期用 token 判断，不能只看 state.onlineSource。
 */
async function loadLiked(force = false, source = state.onlineSource) {
  if (OL.likedLoading) return;
  if (!force && OL.likedLoaded && OL.likedSource === source) return;
  const token = ++likedToken;
  const account = olAccountOf(source);
  const local = favoriteTracksLocal();

  if (!account?.loggedIn) {
    if (source === state.onlineSource) {
      OL.liked = local;
      OL.likedMode = 'local';
    }
    OL.likedError = '';
    OL.likedAccount = [];
    OL.likedLoaded = true;
    OL.likedSource = source;
    renderLiked();
    return;
  }

  OL.likedLoading = true;
  OL.likedError = '';
  renderLiked();
  try {
    const tracks = await window.orangeDesktop.onlineLiked(source);
    if (token !== likedToken) return;
    const normalized = (tracks || []).map(normalizeTrack);
    // 平台红心 + 本地收藏合并去重，避免本地收藏过的歌从列表里消失
    const seen = new Set(normalized.map(track => track.id));
    const merged = [...normalized, ...local.filter(track => !seen.has(track.id))];
    // 只有「当前音源」的结果才写进在线页用的那份；其他平台的只给喜爱页用
    if (source === state.onlineSource) {
      OL.liked = merged;
      OL.likedMode = 'account';
    }
    // 单独留一份纯账号红心：本地「喜爱」页要用它，混进本地收藏会重复显示
    OL.likedAccount = normalized;
    OL.likedLoaded = true;
    OL.likedSource = source;
    saveOnlineLib();
  } catch (error) {
    if (token !== likedToken) return;
    if (source === state.onlineSource) {
      OL.liked = local;
      OL.likedMode = 'local';
    }
    OL.likedError = error.message || '读取平台红心失败';
    OL.likedAccount = [];
    OL.likedLoaded = false;
    OL.likedSource = source;
  } finally {
    OL.likedLoading = false;
    if (token === likedToken) renderLiked();
  }
}

async function loadPlatformPlaylists(force = false) {
  if (OL.platformLoading) return;
  if (!force && OL.platformPlaylists.length) return;
  const source = state.onlineSource;
  OL.platformLoading = true;
  OL.platformError = '';
  renderOnlinePlaylists();
  try {
    const list = await window.orangeDesktop.onlineRecommendPlaylists(source);
    if (source !== state.onlineSource) return;
    OL.platformPlaylists = (list || []).filter(item => item && item.id);
  } catch (error) {
    if (source !== state.onlineSource) return;
    OL.platformPlaylists = [];
    OL.platformError = error.message || '加载歌单失败';
  } finally {
    OL.platformLoading = false;
    if (source === state.onlineSource) renderOnlinePlaylists();
  }
}

/* ==========================================================================
   歌单详情
   ========================================================================== */

async function openOnlineDetail(kind, id) {
  // 本地歌单有自己的详情页（歌单 → 点卡片），在线页不再重复实现一套
  if (kind === 'mine' && typeof openPlaylistPage === 'function') {
    openPlaylistPage(id);
    return;
  }
  const page = $('#onlinePage');
  const head = $('#olDetailHead');
  const list = $('#olDetailList');
  const note = $('#olDetailNote');
  const titleEl = $('#olDetailTitle');
  if (!page) return;
  page.classList.add('showing-detail');
  window.scrollTo({ top: 0 });
  OL.detail = { kind, id };
  if (note) note.textContent = '加载中…';
  if (titleEl) titleEl.textContent = '';
  if (list) list.innerHTML = olSkeletonRows(8);
  if (head) head.innerHTML = '';

  let name = '';
  let tracks = [];
  let cover = '';
  let description = '';

  try {
    if (kind === 'mine') {
      const playlist = state.playlists.find(item => item.id === id);
      if (!playlist) throw new Error('歌单不存在');
      name = playlist.name;
      tracks = playlist.tracks.map(trackId => getTrack(trackId)).filter(Boolean);
      // 封面跟歌单卡片保持一致：优先自定义，否则用最后加进来的那首歌
      cover = playlist.cover && playlist.cover !== DEFAULT_COVER
        ? playlist.cover
        : (tracks[tracks.length - 1]?.cover || '');
    } else {
      const item = [...OL.platformPlaylists, ...OL.picked].find(entry => String(entry.id) === String(id));
      name = item?.name || '平台歌单';
      cover = item?.cover || '';
      description = item?.description || '';
      tracks = (await window.orangeDesktop.onlinePlaylistTracks(state.onlineSource, id)).map(normalizeTrack);
      saveOnlineLib();
    }
  } catch (error) {
    OL.detail = null;
    if (note) note.textContent = '';
    if (head) head.innerHTML = '';
    if (list) list.innerHTML = olEmptyHtml('打不开这个歌单', error.message || '请稍后再试', `<button class="button secondary small" data-ol-close>返回</button>`);
    return;
  }

  OL.detailName = name;
  if (note) note.textContent = `${tracks.length} 首`;
  if (titleEl) titleEl.textContent = name;
  if (head) {
    head.innerHTML = `
      ${cover ? `<img src="${escapeHtml(cover)}" alt="" />` : `<div class="ol-detail-cover"><svg class="icon"><use href="#i-list"/></svg></div>`}
      <div class="ol-detail-copy">
        <h2>${escapeHtml(name)}</h2>
        <p>${escapeHtml(description || (kind === 'mine' ? '本地与在线曲目都在这里' : olSourceMeta(state.onlineSource).name))}</p>
        <div class="ol-hero-actions">
          <button class="button primary small" data-ol-play-detail><svg class="icon filled"><use href="#i-play"/></svg>播放全部</button>
          ${kind === 'platform'
            ? `<button class="button secondary small" data-ol-import-detail>收藏整个歌单</button>`
            : `<button class="button secondary small danger" data-ol-delete-playlist="${id}">删除歌单</button>`}
        </div>
      </div>`;
  }
  if (list) {
    list.innerHTML = tracks.length
      ? olListHtml(tracks, kind === 'mine' ? { context: 'mine', playlistId: id } : {})
      : olEmptyHtml('这个歌单是空的', kind === 'mine' ? '去搜索或推荐里把歌加进来' : '换一个歌单试试');
  }
  // 详情里的播放列表按当前展示顺序走，播放全部 / 队列都基于它
  OL.detailTracks = tracks;
  observeDetailHead();
}

/**
 * 歌单大标题滚出视口后，才让吸顶返回条补上歌单名。
 * 用元素位置判断而不是写死滚动阈值：标题高度会随描述换行变化，
 * 写死像素值在长描述的歌单上会提前/延后显示。
 */
let detailPinBound = false;
function syncDetailPinned() {
  const head = $('#olDetailHead');
  const bar = document.querySelector('.ol-detail-bar');
  if (!head || !bar) return;
  if (!$('#onlinePage')?.classList.contains('showing-detail')) {
    bar.classList.remove('is-pinned');
    return;
  }
  // 70 = 标题栏高度 + 一点余量；头部顶边越过这条线就认为它已经滚出去了
  bar.classList.toggle('is-pinned', head.getBoundingClientRect().top < 70);
}

function observeDetailHead() {
  syncDetailPinned();
  if (detailPinBound) return;
  const scroller = document.querySelector('.main-content');
  if (!scroller) return;
  detailPinBound = true;
  scroller.addEventListener('scroll', syncDetailPinned, { passive: true });
  window.addEventListener('resize', syncDetailPinned);
}

function closeOnlineDetail() {
  $('#onlinePage')?.classList.remove('showing-detail');
  document.querySelector('.ol-detail-bar')?.classList.remove('is-pinned');
  OL.detail = null;
  OL.detailTracks = [];
}

/* ==========================================================================
   弹层：选歌单 / 新建歌单
   ========================================================================== */

function openOnlineModal({ title, body, onOk, okText = '确定', hideOk = false }) {
  const modal = $('#olModal');
  if (!modal) return;
  OL.modal = { onOk };
  $('#olModalTitle').textContent = title;
  $('#olModalBody').innerHTML = body;
  const okButton = $('[data-ol-modal-ok]', modal);
  okButton.hidden = hideOk;
  okButton.textContent = okText;
  modal.hidden = false;
  const input = $('.ol-input', modal);
  if (input) setTimeout(() => input.focus(), 30);
}

function closeOnlineModal() {
  const modal = $('#olModal');
  if (modal) modal.hidden = true;
  OL.modal = null;
}

function openAddToPlaylist(trackId) {
  const track = getTrack(trackId);
  if (!track) return;
  const items = state.playlists.map(item => `
    <button class="ol-picker-item" data-ol-pick="${item.id}">
      <svg class="icon"><use href="#i-list"/></svg>
      <span>${escapeHtml(item.name)}</span>
      <span class="ol-picker-count">${item.tracks.length} 首</span>
    </button>`).join('');
  openOnlineModal({
    title: `把《${track.title}》加到`,
    body: `${items || '<div class="ol-empty">还没有歌单，先新建一个</div>'}
      <button class="ol-picker-item" data-ol-pick-new>
        <svg class="icon"><use href="#i-plus"/></svg><span>新建歌单…</span>
      </button>`,
    hideOk: true
  });
}

function openNewPlaylistModal(trackId = '') {
  openOnlineModal({
    title: '新建在线歌单',
    body: `<input class="ol-input" id="olNewPlaylistName" placeholder="歌单名称，例如：通勤循环" maxlength="40" />`,
    okText: '创建',
    onOk: () => {
      const input = $('#olNewPlaylistName');
      const playlist = createOnlinePlaylist(input ? input.value : '');
      if (trackId) addTrackToPlaylist(playlist.id, trackId);
      closeOnlineModal();
      renderOnlinePage();
      showToast(`已创建「${playlist.name}」`);
    }
  });
}

/* ==========================================================================
   播放列表操作
   ========================================================================== */

function playSequence(tracks, startId) {
  if (!tracks.length) { showToast('列表是空的'); return; }
  const ids = tracks.map(track => track.id);
  state.queue = [...ids];
  saveLibrary();
  renderQueue();
  playOnlineTrack(startId || ids[0]);
}

function enqueueTracks(tracks) {
  if (!tracks.length) return;
  let added = 0;
  tracks.forEach(track => {
    if (!state.queue.includes(track.id)) {
      state.queue.push(track.id);
      added += 1;
    }
  });
  saveLibrary();
  renderQueue();
  showToast(added ? `已加入 ${added} 首到播放队列` : '这些歌已经在队列里了');
}

function openSourceSite(id) {
  const track = getTrack(id);
  if (!track) return;
  const urls = {
    netease: `https://music.163.com/#/song?id=${track.songId || ''}`,
    qq: `https://y.qq.com/n/ryqq/songDetail/${track.mid || ''}`,
    kugou: `https://www.kugou.com/song/#hash=${track.hash || ''}`
  };
  const url = urls[track.source];
  if (url) window.orangeDesktop?.onlineOpenExternal?.(url);
}

/* ==========================================================================
   平台切换 / 登录
   ========================================================================== */

function switchOnlineSource(id) {
  if (!id || id === state.onlineSource) return;
  state.onlineSource = id;
  // 换了平台，之前那一份数据都属于别的平台，清掉重新拉
  Object.assign(OL, {
    daily: [], dailyMode: '', dailyError: '', dailyLoading: false,
    picked: [], pickedError: '', pickedLoading: false,
    search: [], searchTitle: '', searchError: '', searchLoading: false,
    liked: [], likedMode: 'local', likedError: '', likedLoading: false,
    platformPlaylists: [], platformError: '', platformLoading: false,
    detail: null, detailTracks: []
  });
  closeOnlineDetail();
  renderOnlinePage();
  // 换平台 → 音质档位跟着换（网易云 4 档、QQ / 酷狗 3 档）
  renderQualityPickers();
  if (OL.view === 'daily') loadDaily();
  else if (OL.view === 'liked') loadLiked();
  else if (OL.view === 'playlists') loadPlatformPlaylists();
  // 首页跟着换平台：清掉旧平台那份，立刻按新平台拉
  HOME.tracks = [];
  HOME.mode = '';
  HOME.source = '';
  HOME.day = '';
  HOME.tried = false;
  loadHomeDaily(true);
}

function switchOnlineView(view) {
  if (!['daily', 'search', 'liked', 'playlists'].includes(view)) return;
  OL.view = view;
  closeOnlineDetail();
  renderTabs();
  if (view === 'daily') { renderDaily(); loadDaily(); loadPicked(); }
  else if (view === 'search') renderSearch();
  else if (view === 'liked') { renderLiked(); loadLiked(); }
  else if (view === 'playlists') { renderOnlinePlaylists(); loadPlatformPlaylists(); }
}

async function doOnlineLogin(source) {
  if (!window.orangeDesktop?.onlineLogin) return;
  const meta = olSourceMeta(source);
  showToast(`请在弹出的 ${meta.name} 窗口里扫码登录`);
  try {
    const result = await window.orangeDesktop.onlineLogin(source);
    if (!result) { showToast('已取消登录'); return; }
    await refreshOnlineAccounts(true);
    renderPlatforms();
    renderAccount();
    showToast(`已登录 ${meta.name}：${result.profile?.nickname || ''}`);
    // 登录后个人化推荐与红心都能拿了，强制刷一次
    if (OL.view === 'daily') loadDaily(true);
    if (OL.view === 'liked') loadLiked(true);
    // 首页的每日推荐也要从「本地口味」换成「账号口味」
    if (source === state.onlineSource) loadHomeDaily(true);
  } catch (error) {
    showToast(error?.message || '登录失败');
  }
}

async function doOnlineLogout(source) {
  if (!window.orangeDesktop?.onlineLogout) return;
  try {
    state.onlineAccounts = await window.orangeDesktop.onlineLogout(source);
    renderPlatforms();
    renderAccount();
    if (OL.view === 'daily') loadDaily(true);
    if (OL.view === 'liked') loadLiked(true);
    // 退出后首页回到「按本地口味挑选」
    if (source === state.onlineSource) loadHomeDaily(true);
    showToast(`已退出 ${olSourceMeta(source).name}`);
  } catch (error) {
    showToast('退出失败');
  }
}

/* ==========================================================================
   事件
   ========================================================================== */

function onOnlinePageClick(event) {
  const target = event.target;
  const pick = selector => target.closest(selector);

  // 弹层内部优先处理，避免被底下的行点击抢走
  if (pick('[data-ol-modal-ok]')) { OL.modal?.onOk?.(); return; }
  if (pick('[data-ol-modal-cancel]')) { closeOnlineModal(); return; }
  if (target.id === 'olModal') { closeOnlineModal(); return; }

  const qualityButton = pick('[data-ol-quality]');
  if (qualityButton) { setOnlineQuality(qualityButton.dataset.olQuality, qualityButton.dataset.olQualitySource); return; }

  const gsSourceButton = pick('[data-gs-source]');
  if (gsSourceButton) { switchGsSource(gsSourceButton.dataset.gsSource); return; }

  const sourceButton = pick('[data-ol-source]');
  if (sourceButton) { switchOnlineSource(sourceButton.dataset.olSource); return; }

  const viewTab = pick('[data-ol-view]');
  if (viewTab) { switchOnlineView(viewTab.dataset.olView); return; }

  const loginButton = pick('[data-ol-login]');
  if (loginButton) { doOnlineLogin(loginButton.dataset.olLogin); return; }

  const logoutButton = pick('[data-ol-logout]');
  if (logoutButton) { doOnlineLogout(logoutButton.dataset.olLogout); return; }

  if (pick('[data-ol-refresh-daily]')) { loadDaily(true); return; }
  if (pick('#olDailyRefresh') || pick('[data-ol-refresh]')) { loadDaily(true); loadPicked(true); return; }

  const pickItem = pick('[data-ol-pick]');
  if (pickItem) {
    const trackId = OL.pendingAddId;
    addTrackToPlaylist(pickItem.dataset.olPick, trackId);
    closeOnlineModal();
    return;
  }
  if (pick('[data-ol-pick-new]')) { openNewPlaylistModal(OL.pendingAddId || ''); return; }

  if (pick('[data-ol-new-playlist]')) { openNewPlaylistModal(); return; }

  if (pick('[data-ol-close]')) { closeOnlineDetail(); return; }

  if (pick('[data-ol-import-detail]') && OL.detail) {
    const item = [...OL.platformPlaylists, ...OL.picked].find(entry => String(entry.id) === String(OL.detail.id));
    importPlaylistToMine(item?.name || OL.detailName || '平台歌单', OL.detailTracks || []);
    return;
  }

  const deleteButton = pick('[data-ol-delete-playlist]');
  if (deleteButton) {
    deleteOnlinePlaylist(deleteButton.dataset.olDeletePlaylist);
    return;
  }

  const removeButton = pick('[data-ol-remove]');
  if (removeButton) {
    removeTrackFromPlaylist(removeButton.dataset.olRemoveFrom, removeButton.dataset.olRemove);
    return;
  }

  const favButton = pick('[data-ol-fav]');
  if (favButton) {
    // 账号红心来自平台，这里不做同步写回（各家接口差别大），点一下说明白就好
    if (favButton.dataset.olFavAccount) {
      showToast('这是账号里的红心，取消请到在线音乐页的「喜爱」里操作');
      return;
    }
    toggleOnlineFavorite(favButton.dataset.olFav);
    return;
  }

  const queueButton = pick('[data-ol-queue]');
  if (queueButton) {
    const track = getTrack(queueButton.dataset.olQueue);
    if (track) enqueueTracks([track]);
    return;
  }

  const addButton = pick('[data-ol-add]');
  if (addButton) { OL.pendingAddId = addButton.dataset.olAdd; openAddToPlaylist(addButton.dataset.olAdd); return; }

  const siteButton = pick('[data-ol-site]');
  if (siteButton) { openSourceSite(siteButton.dataset.olSite); return; }

  if (pick('[data-ol-play-daily]')) { playSequence(OL.daily, OL.daily[0]?.id); return; }
  if (pick('[data-ol-queue-daily]')) { enqueueTracks(OL.daily); return; }
  if (pick('[data-ol-play-liked]')) { playSequence(OL.liked, OL.liked[0]?.id); return; }
  if (pick('[data-ol-queue-liked]')) { enqueueTracks(OL.liked); return; }
  if (pick('[data-ol-play-detail]')) { playSequence(OL.detailTracks || [], (OL.detailTracks || [])[0]?.id); return; }

  const playSet = pick('[data-ol-play-set]');
  if (playSet) {
    event.stopPropagation();
    openPlaylistAndPlay(playSet.dataset.olPlaySet);
    return;
  }

  const openCard = pick('[data-ol-open]');
  if (openCard) {
    const [kind, id] = openCard.dataset.olOpen.split(':');
    // 歌单页 / 喜爱页里也有在线卡片，不在线页时先切过去再打开详情
    if (state.page !== 'online' && typeof showPage === 'function') {
      showPage('online');
      setTimeout(() => openOnlineDetail(kind, id), 80);
    } else {
      openOnlineDetail(kind, id);
    }
    return;
  }

  const playButton = pick('[data-ol-play]');
  if (playButton) { playOnlineTrack(playButton.dataset.olPlay); return; }

  const row = pick('[data-ol-track]');
  if (row) { playOnlineTrack(row.dataset.olTrack); }
}

/** 卡片右下角的播放按钮：读歌单后直接播放第一首 */
async function openPlaylistAndPlay(key) {
  const [kind, id] = key.split(':');
  // 本地歌单：播放键就是「整单开播」，不跳详情页
  if (kind === 'mine') {
    playPlaylist(id);
    return;
  }
  await openOnlineDetail(kind, id);
  const tracks = OL.detailTracks || [];
  if (tracks.length) playSequence(tracks, tracks[0].id);
}

/* ==========================================================================
   首页：登录账号的每日推荐（1.6.9）

   以前首页永远是「本地音乐库当前那首 + 本地曲库轮换 4 张卡」，
   在线曲库再全也用不上。现在首页优先展示当前平台的每日推荐：
     - 已登录：平台按账号口味生成的那一份（mode=account，网易云是真正的个人化每日推荐）
     - 未登录：按本地收藏 / 播放记录里的歌手拼一份（mode=local），没有记录才退回平台热榜
   拿不到（断网 / 接口失败 / 一首都没有）时不弹错误，安静回落到原来的本地推荐。
   ========================================================================== */

const HOME_DAILY_CACHE = 'orange-home-daily';
/** 首页最多铺 8 张卡（两行四列），再多要滚动才能看全，反而没人看 */
const HOME_CARD_LIMIT = 8;

const HOME = {
  tracks: [],
  mode: '',
  source: '',
  day: '',
  loading: false,
  error: '',
  tried: false
};

function homeToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** 首页用的平台：内容属于哪个平台就以哪个为准，避免切平台后标题写错 */
const homeSourceId = () => HOME.source || state.onlineSource;

function restoreHomeDailyCache() {
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(HOME_DAILY_CACHE) || 'null'); } catch { cached = null; }
  if (!cached || !Array.isArray(cached.tracks) || !cached.tracks.length) return false;
  // 只认「今天的、当前平台的」快照，昨天的不该再占着首页
  if (cached.day !== homeToday() || cached.source !== state.onlineSource) return false;
  HOME.tracks = cached.tracks.map(item => normalizeTrack(item)).filter(Boolean);
  HOME.mode = cached.mode || '';
  HOME.source = cached.source;
  HOME.day = cached.day;
  HOME.tried = true;
  return HOME.tracks.length > 0;
}

function writeHomeDailyCache() {
  try {
    localStorage.setItem(HOME_DAILY_CACHE, JSON.stringify({
      day: HOME.day,
      source: HOME.source,
      mode: HOME.mode,
      tracks: HOME.tracks.slice(0, 30).map(persistableTrack)
    }));
  } catch {}
}

async function loadHomeDaily(force = false) {
  if (HOME.loading) return;
  // 当天、同平台、已有数据：不用再打一次接口（主进程那层也有缓存，但少一次 IPC 更好）
  if (!force && HOME.tracks.length && HOME.day === homeToday() && HOME.source === state.onlineSource) {
    HOME.tried = true;
    return;
  }
  if (!window.orangeDesktop?.onlineDaily) return;
  const source = state.onlineSource;
  HOME.loading = true;
  HOME.error = '';
  try {
    // 账号列表可能还没拉回来。不先补一次的话会把已登录误判成未登录，
    // 拿回来的是「热榜」而不是账号的每日推荐。
    if (!(state.onlineAccounts || []).length) await refreshOnlineAccounts().catch(() => {});
    const result = await window.orangeDesktop.onlineDaily(source, { artists: localArtistSeeds() });
    if (source !== state.onlineSource) return;
    HOME.tracks = (result?.tracks || []).map(normalizeTrack).filter(Boolean);
    HOME.mode = result?.mode || '';
    HOME.source = source;
    HOME.day = homeToday();
    if (HOME.tracks.length) writeHomeDailyCache();
  } catch (error) {
    HOME.error = error?.message || '获取每日推荐失败';
  } finally {
    HOME.loading = false;
    HOME.tried = true;
    if (source === state.onlineSource) {
      renderFeature();
      renderRecommendations();
    }
  }
}

/** 首页主卡片：有在线推荐就接管，返回 true；否则让 app.js 继续画本地曲库 */
function renderHomeHeroOnline() {
  const card = $('#featureCard');
  if (!card || !HOME.tracks.length) return false;
  const first = HOME.tracks[0];
  const meta = olSourceMeta(homeSourceId());
  const account = olAccountOf(homeSourceId());
  const signed = Boolean(account?.loggedIn);
  const nick = account?.profile?.nickname || '';

  card.classList.remove('is-empty');

  const cover = $('#featureCover');
  if (cover) cover.src = secureUrl(first.cover) || DEFAULT_COVER;

  const stamp = $('#featureStamp');
  if (stamp) {
    stamp.hidden = false;
    const quality = String(first.qualityLabel || '在线').toUpperCase();
    stamp.innerHTML = `${escapeHtml(quality)}<br />ONLINE`;
  }

  const tag = $('#featureTag');
  if (tag) tag.textContent = signed ? `每日推荐 · ${nick || meta.short}` : `每日推荐 · ${meta.short}`;

  const title = $('#featureTitle');
  if (title) title.textContent = first.title || '今日推荐';

  const desc = $('#featureDesc');
  if (desc) desc.textContent = [first.artist, first.album].filter(Boolean).join(' · ') || `${meta.name} 在线曲库`;

  const metaBox = $('#featureMeta');
  if (metaBox) {
    const head = signed
      ? `${escapeHtml(nick || meta.short)} 的账号推荐`
      : '未登录 · 按本地口味挑选';
    metaBox.innerHTML = [
      `<span>${head}</span>`,
      '<b>·</b>',
      `<span>共 ${HOME.tracks.length} 首</span>`,
      '<b>·</b>',
      '<span>每日更新</span>'
    ].join('');
  }

  const play = $('#featurePlay');
  if (play) play.innerHTML = '<svg class="icon filled"><use href="#i-play"/></svg>播放全部';

  const sub = $('#featureImport');
  if (sub) {
    sub.dataset.onlineMode = '1';
    sub.innerHTML = '<svg class="icon"><use href="#i-refresh"/></svg>刷新推荐';
  }
  return true;
}

function homeSongCardHtml(track) {
  const quality = track.qualityLabel && track.qualityLabel !== '在线' ? track.qualityLabel : '';
  const sub = [track.artist, quality].filter(Boolean).join(' · ') || '在线';
  return `
    <article class="recommend-card" data-track-card="${track.id}" tabindex="0">
      <div class="recommend-cover">
        <img src="${escapeHtml(track.cover || DEFAULT_COVER)}" alt="" loading="lazy" />
        <button class="card-play" data-play="${track.id}" aria-label="播放 ${escapeHtml(track.title)}">
          <svg class="icon"><use href="#i-play"/></svg>
        </button>
      </div>
      <div class="recommend-info">
        <strong>${escapeHtml(track.title)}</strong>
        <span>${escapeHtml(sub)}</span>
      </div>
    </article>`;
}

function renderHomeCardsOnline() {
  const target = $('#recommendRow');
  if (!target || !HOME.tracks.length) return false;
  const meta = olSourceMeta(homeSourceId());

  const title = $('#recommendTitle');
  if (title) title.textContent = '今日推荐';

  const note = $('#recommendNote');
  if (note) {
    // 大卡里已经写了「谁的账号 + 共几首」，这里只说清「这批歌是怎么来的」，
    // 未登录时顺手给一个能去登录的入口，否则用户不知道点哪才能拿到账号推荐
    if (HOME.mode === 'account') {
      note.textContent = `来自 ${meta.name} 账号的每日推荐 · 每天更新`;
    } else if (HOME.mode === 'local') {
      note.innerHTML = '还没登录 · 先按本地收藏与播放记录挑选'
        + '<button class="section-note-link" type="button" data-action="home-login">登录后按账号口味推荐</button>';
    } else {
      note.textContent = `${meta.name} 热榜精选 · 每天更新`;
    }
  }

  const refresh = $('#recommendRefresh');
  if (refresh) {
    refresh.dataset.localMode = '0';
    refresh.innerHTML = '刷新 <svg class="icon"><use href="#i-chevron-right"/></svg>';
  }
  // 首页只铺 8 张，剩下的在这里给个出口，否则「共 30 首」看得见摸不着
  const all = $('#recommendAll');
  if (all) {
    all.hidden = false;
    all.innerHTML = `全部 ${HOME.tracks.length} 首 <svg class="icon"><use href="#i-chevron-right"/></svg>`;
  }

  target.innerHTML = HOME.tracks.slice(0, HOME_CARD_LIMIT).map(homeSongCardHtml).join('');
  return true;
}

function playHomeDailyAll() {
  if (!HOME.tracks.length) return false;
  playSequence(HOME.tracks, HOME.tracks[0].id);
  return true;
}

/** 点「刷新 / 换一批」：当前是本地兜底就返回 false，交回 app.js 的本地轮换 */
function refreshHomeDaily() {
  if (!HOME.tried && !HOME.tracks.length) return false;
  loadHomeDaily(true);
  return true;
}

/** 切页 / 切平台 / 跨天时按需刷新，不重复打接口 */
function ensureHomeDaily() {
  if (HOME.loading) return;
  if (!HOME.tracks.length || HOME.day !== homeToday() || HOME.source !== state.onlineSource) {
    loadHomeDaily();
  }
}

function initHomeDaily() {
  if (!window.orangeDesktop?.onlineDaily) return;
  if (!HOME.tracks.length) restoreHomeDailyCache();
  if (HOME.tracks.length) {
    renderFeature();
    renderRecommendations();
  }
  // 缓存只在「当天 + 同平台」有效，其余情况直接联网拉一次
  if (!HOME.tracks.length) loadHomeDaily();
}

function initOnline() {
  const page = $('#onlinePage');
  if (!page) return;

  migrateOnlinePlaylists();
  restoreOnlineTracks();
  // 上次用的音源优先，没有就用网易云（曲库最全、免登录也能搜）
  const remembered = localStorage.getItem('orange-online-source');
  if (remembered && OL_SOURCES.some(item => item.id === remembered)) state.onlineSource = remembered;
  // 音质选择器按平台给档位，必须等音源确定之后再画
  renderQualityPickers();

  // 在线曲目的行按钮也会出现在「喜爱」页里，所以委托挂到 document 上，
  // 只处理 data-ol-* 这类专属属性，不会和 app.js 的委托打架
  document.addEventListener('click', onOnlinePageClick);

  page.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target.closest('[data-ol-open], [data-ol-new-playlist]');
    if (!card) return;
    event.preventDefault();
    card.click();
  });

  const searchInput = $('#olSearchInput');
  const searchButton = $('#olSearchBtn');
  if (searchButton) searchButton.addEventListener('click', () => runSearch(searchInput?.value));
  if (searchInput) {
    searchInput.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      runSearch(searchInput.value);
    });
  }

  // 记住音源选择，下次打开还是它
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-ol-source]');
    if (button) localStorage.setItem('orange-online-source', button.dataset.olSource);
  });

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (OL.modal) { closeOnlineModal(); return; }
    if (OL.detail) closeOnlineDetail();
  });

  renderOnlinePage();
  // 预热登录状态：全屏播放页的音质菜单、列表里的会员标记都要用它，
  // 不能等用户点进在线页才知道登没登录
  refreshOnlineAccounts();
}

/** 进入在线页时调用（app.js 的 showPage 会触发） */
async function refreshOnlinePage() {
  await refreshOnlineAccounts(true);
  renderOnlinePage();
  if (OL.view === 'daily') { loadDaily(); loadPicked(); }
  else if (OL.view === 'liked') loadLiked();
  else if (OL.view === 'playlists') loadPlatformPlaylists();
}

/* ==========================================================================
   搜索页里的在线结果
   app.js 的 renderSearchResults 每次渲染都会调用 renderGlobalSearch(query)，
   输入用防抖，同一个关键词只打一次接口，切平台走缓存。
   ========================================================================== */

const GS = {
  query: '',
  /** 搜索页单独记音源；默认跟随在线页当前音源 */
  source: '',
  results: [],
  loading: false,
  error: '',
  timer: 0,
  /** 请求序号：慢请求回来时如果用户已经改了关键词，直接丢掉 */
  token: 0,
  enabled: true,
  cache: new Map()
};

const GS_LIMIT = 20;
const GS_CACHE_LIMIT = 30;

const gsEl = id => document.getElementById(id);

function gsSource() {
  return GS.source || state.onlineSource || 'netease';
}

function gsCacheKey(source, query) {
  return `${source}|${String(query).toLowerCase()}`;
}

function renderGsPlatforms() {
  const target = $('#gsPlatforms');
  if (!target) return;
  const current = gsSource();
  target.innerHTML = OL_SOURCES.map(source => {
    const account = olAccountOf(source.id);
    const active = source.id === current;
    const title = `${source.name} · ${account?.loggedIn ? '已登录' : '未登录'}`;
    return `<button class="ol-platform ${active ? 'active' : ''}" data-gs-source="${source.id}" role="tab" aria-selected="${active}" title="${escapeHtml(title)}">
      <span class="ol-platform-dot" style="background:${source.color}"></span>
      <span>${escapeHtml(source.short)}</span>
      <span class="ol-platform-state ${account?.loggedIn ? 'online' : ''}"></span>
    </button>`;
  }).join('');
}

function renderGsResults() {
  const section = gsEl('gsSection');
  if (!section) return;
  const query = GS.query.trim();
  // 有关键词就一定要露脸：即便「同时搜在线」被关掉，也要留下面板 +
  // 显眼的「开启在线搜索」，否则开关会跟着面板一起隐藏，关了就在也点不回来
  const visible = Boolean(query);
  section.hidden = !visible;
  if (!visible) return;

  const off = !GS.enabled;
  section.classList.toggle('is-off', off);
  const offNote = gsEl('gsOff');
  if (offNote) offNote.hidden = !off;
  const toggle = gsEl('gsToggle');
  if (toggle && toggle.checked !== GS.enabled) toggle.checked = GS.enabled;

  const meta = olSourceMeta(gsSource());
  const heading = gsEl('gsHeading');
  const note = gsEl('gsNote');
  if (heading) heading.textContent = off ? '在线音乐' : `在线 · ${meta.name}`;
  // 关闭态的说明由下面的兜底行负责，副标题留空免得同一句话说两遍
  if (note) note.textContent = '';

  if (off) {
    const list = gsEl('gsList');
    if (list) list.innerHTML = '';
    return;
  }

  renderGsPlatforms();
  renderQualityPickers();

  const account = olAccountOf(gsSource());
  if (note) {
    const parts = [];
    if (GS.loading) parts.push('正在搜索…');
    else if (GS.error) parts.push(GS.error);
    else if (GS.results.length) parts.push(`${GS.results.length} 首`);
    if (!account?.loggedIn) parts.push('未登录，VIP 曲目只能试听');
    note.textContent = parts.join(' · ');
  }

  const list = gsEl('gsList');
  if (!list) return;
  if (GS.loading && !GS.results.length) {
    list.innerHTML = `<div class="gs-loading"><span class="ol-spinner"></span>正在从 ${escapeHtml(meta.name)} 搜索…</div>`;
    return;
  }
  if (GS.error) {
    list.innerHTML = `<div class="gs-loading gs-error">${escapeHtml(GS.error)}</div>`;
    return;
  }
  if (!GS.results.length) {
    list.innerHTML = `<div class="gs-loading">${escapeHtml(meta.name)} 里没有找到这首歌，换个关键词或切到其它平台</div>`;
    return;
  }
  list.innerHTML = olListHtml(GS.results, { context: 'gs' });
}

async function runGsSearch() {
  const query = GS.query.trim();
  if (!query || !GS.enabled) return;
  const source = gsSource();
  const key = gsCacheKey(source, query);
  const token = ++GS.token;

  const cached = GS.cache.get(key);
  if (cached) {
    GS.results = cached;
    GS.loading = false;
    GS.error = '';
    renderGsResults();
    return;
  }

  GS.loading = true;
  GS.error = '';
  GS.results = [];
  renderGsResults();

  try {
    const items = await window.orangeDesktop.onlineSearch(source, query, { limit: GS_LIMIT });
    if (token !== GS.token) return;
    // normalizeTrack 会把在线曲目登记进 state.online，行内按钮和播放器才认得出
    GS.results = (items || []).map(item => normalizeTrack(item));
    GS.cache.set(key, GS.results);
    if (GS.cache.size > GS_CACHE_LIMIT) GS.cache.delete(GS.cache.keys().next().value);
  } catch (error) {
    if (token !== GS.token) return;
    GS.results = [];
    GS.error = error?.message || '在线搜索失败';
  } finally {
    if (token === GS.token) {
      GS.loading = false;
      renderGsResults();
    }
  }
}

/** 由 app.js 的 renderSearchResults 调用 */
function renderGlobalSearch(query) {
  const text = String(query || '').trim();
  const changed = text !== GS.query;
  GS.query = text;

  if (!GS.enabled || !text) {
    clearTimeout(GS.timer);
    GS.loading = false;
    GS.error = '';
    if (changed) GS.results = [];
    renderGsResults();
    return;
  }

  renderGsResults();
  if (!changed) return;
  clearTimeout(GS.timer);
  GS.timer = setTimeout(runGsSearch, 700);
}

/** 切到别的音源：清掉当前结果立刻重搜（缓存命中就直接出） */
function switchGsSource(id) {
  if (!id || id === gsSource()) return;
  GS.source = id;
  state.onlineSource = id;
  try { localStorage.setItem('orange-online-source', id); } catch {}
  GS.results = [];
  GS.error = '';
  renderGsResults();
  renderQualityPickers();
  GS.token += 1;
  runGsSearch();
  // 搜索页换平台同样会改 state.onlineSource，首页那份推荐也得跟着作废
  HOME.tracks = [];
  HOME.mode = '';
  HOME.source = '';
  HOME.day = '';
  HOME.tried = false;
  loadHomeDaily(true);
}

/** 把搜索页的关键词带到在线页继续看 */
async function openGsInOnlinePage() {
  const query = GS.query.trim();
  if (!query) return;
  const source = gsSource();
  if (state.onlineSource !== source) {
    state.onlineSource = source;
    renderPlatforms();
    renderAccount();
  }
  showPage('online');
  switchOnlineView('search');
  const input = gsEl('olSearchInput');
  if (input) input.value = query;
  await runSearch(query);
}

/** 在线曲目进「最近播放」时记一份到在线库，重启后还能从最近播放里直接播 */
function recordOnlineRecent(id) {
  const track = getTrack(id);
  if (!track || !track._online) return;
  if (!onlineLib.tracks[id]) onlineLib.tracks[id] = persistableTrack(track);
  onlineLib.recent = [id, ...onlineLib.recent.filter(item => item !== id)].slice(0, 40);
  saveOnlineLib();
}

function setGsEnabled(enabled, { search = true } = {}) {
  GS.enabled = Boolean(enabled);
  try { localStorage.setItem('orange-gs-enabled', GS.enabled ? '1' : '0'); } catch {}
  const toggle = gsEl('gsToggle');
  if (toggle) toggle.checked = GS.enabled;
  clearTimeout(GS.timer);
  GS.token += 1;
  if (!GS.enabled) {
    GS.results = [];
    GS.error = '';
    GS.loading = false;
    renderGsResults();
    return;
  }
  // 打开后立刻按当前关键词搜一次（命中缓存会直接出结果）；
  // 注意不能走 renderGlobalSearch：关键词没变会被判成“没变化”而直接跳过
  GS.results = [];
  GS.error = '';
  renderGsResults();
  if (search && GS.query.trim()) runGsSearch();
}

function initGlobalSearch() {
  // 1.6.7 修：旧版本把这块面板的开关藏在面板自己身上，一关掉面板就没了，
  // 开关跟着消失 → 再也开不回来，搜索页永远只剩本地结果。
  // 老版本留下来的 "0" 直接作废一次，之后关掉也能从兜底行点回来。
  try {
    if (!localStorage.getItem('orange-gs-state-fix')) {
      localStorage.removeItem('orange-gs-enabled');
      localStorage.setItem('orange-gs-state-fix', '1');
    }
  } catch {}
  if (localStorage.getItem('orange-gs-enabled') === '0') GS.enabled = false;

  const toggle = gsEl('gsToggle');
  if (toggle) {
    toggle.checked = GS.enabled;
    toggle.addEventListener('change', () => setGsEnabled(toggle.checked));
  }
  const enableButton = gsEl('gsEnable');
  if (enableButton) enableButton.addEventListener('click', () => setGsEnabled(true));
  const openButton = gsEl('gsOpenOnline');
  if (openButton) openButton.addEventListener('click', openGsInOnlinePage);
}

initGlobalSearch();

initQualityBadge();

initOnline();

// 放在 initOnline 之后：它要先用 localStorage 里记住的平台覆盖 state.onlineSource，
// 首页才知道该显示哪个平台的每日推荐
initHomeDaily();
