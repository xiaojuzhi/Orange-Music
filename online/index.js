'use strict';
/**
 * 在线音乐模块（主进程侧）。
 *
 * 职责：
 *  1. 各站官方登录窗与 Cookie 持久化（userData/online-accounts.json）
 *  2. 三家音源的统一调用与错误归一
 *  3. 给渲染进程的 IPC
 *  4. 在线音频的 Referer / CORS 头注入（否则 WebAudio 会静音）
 *
 * 数据分层：
 *  - 平台侧（需要登录）：每日推荐、我喜欢的音乐、账号歌单
 *  - 公开侧（免登录）：搜索、歌单广场 / 榜单、歌单曲目详情
 */
const { BrowserWindow, session, ipcMain, app, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const netease = require('./netease');
const qq = require('./qq');
const kugou = require('./kugou');
const { mergeLyrics } = require('./net');
const { probeAudio, formatLabel } = require('./probe');

const PROVIDERS = { netease, qq, kugou };
const PROVIDER_IDS = Object.keys(PROVIDERS);

const STATE_FILE = path.join(app.getPath('userData'), 'online-accounts.json');
/** @type {Record<string, {cookie: string, profile: object|null}>} */
let accounts = {};
/** 正在登录的窗口，避免重复点击开出多个 */
const loginWindows = {};
/** 每日推荐缓存：一天之内反复切页不重复请求（key 见 dailyFor） */
const dailyCache = new Map();

/* ------------------------------ 短时缓存 ------------------------------ */
/**
 * 歌单曲目要串「歌单详情 + 曲目列表 + 逐首补封面」好几个接口，
 * 搜索结果同理，而它们在几分钟内几乎不会变。加一层 TTL 缓存：
 * 返回上一页再点回来、同一个词按两次回车，都不再打一遍接口。
 * 只缓存成功结果；失败照常抛错，不把错误写进缓存。
 */
const CACHE_TTL_SEARCH = 3 * 60 * 1000;
const CACHE_TTL_PLAYLIST = 10 * 60 * 1000;
const ttlCache = new Map();

function cached(key, ttl, loader) {
  const now = Date.now();
  const hit = ttlCache.get(key);
  if (hit && hit.expires > now) return Promise.resolve(hit.value);
  return loader().then(value => {
    // 先清过期的，再兜一个硬上限，长时间运行不会越攒越多
    if (ttlCache.size > 80) {
      for (const [name, entry] of ttlCache) if (entry.expires <= now) ttlCache.delete(name);
      while (ttlCache.size > 80) ttlCache.delete(ttlCache.keys().next().value);
    }
    ttlCache.set(key, { value, expires: now + ttl });
    return value;
  });
}

/* ------------------------------ 账号持久化 ------------------------------ */

function loadAccounts() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (data && typeof data === 'object') accounts = data;
  } catch {
    accounts = {};
  }
}

function saveAccounts() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(accounts, null, 2), 'utf8');
  } catch (error) {
    console.warn('Unable to persist online accounts', error);
  }
}

const cookieOf = providerId => accounts[providerId]?.cookie || '';
const isLoggedIn = providerId => Boolean(accounts[providerId]);

/** 从某个 partition 的 Cookie 里挑出该音源需要的那部分，拼成请求头用的字符串 */
async function collectCookie(provider) {
  const ses = session.fromPartition(`persist:orange-online-${provider.id}`);
  const list = await ses.cookies.get({});
  const wanted = list.filter(item => {
    const domain = String(item.domain || '').replace(/^\./, '');
    return provider.cookieDomains.some(suffix => domain === suffix || domain.endsWith(`.${suffix}`));
  });
  return wanted.map(item => `${item.name}=${item.value}`).join('; ');
}

function hasLoginCookie(provider, cookieString) {
  if (!cookieString) return false;
  const names = cookieString.split(';').map(part => part.split('=')[0].trim());
  return provider.cookieNames.some(name => names.includes(name));
}

/* ------------------------------- 登录窗口 ------------------------------- */

/**
 * 打开官方登录页。登录成功（出现标志性 Cookie 且账号接口能返回信息）后自动关窗并回传账号。
 * 用户直接关窗则视为取消，但关窗前会再确认一次登录态，避免漏判。
 */
function openLoginWindow(provider) {
  if (loginWindows[provider.id]) {
    loginWindows[provider.id].focus();
    return loginWindows[provider.id].result;
  }

  const win = new BrowserWindow({
    width: 1020,
    height: 760,
    title: `登录 ${provider.name}`,
    parent: BrowserWindow.getAllWindows()[0] || undefined,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      partition: `persist:orange-online-${provider.id}`,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.setMenu(null);

  // 站点内的 target=_blank 一律在当前窗口打开，避免登录流程被弹到系统浏览器里丢掉 Cookie
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) win.loadURL(url);
    return { action: 'deny' };
  });

  loginWindows[provider.id] = win;
  // 默认按「用户自己关窗」处理；登录成功走 finish() 时会把它改成 false
  win.closedByUser = true;

  win.result = new Promise(resolve => {
    let settled = false;
    let timer = null;

    const finish = async value => {
      if (settled) return;
      settled = true;
      win.closedByUser = false;
      clearInterval(timer);
      delete loginWindows[provider.id];
      if (!win.isDestroyed()) win.close();
      resolve(value);
    };

    const check = async () => {
      if (settled) return;
      try {
        const cookie = await collectCookie(provider);
        if (!hasLoginCookie(provider, cookie)) return;
        const profile = await provider.profile(cookie).catch(() => null);
        if (!profile) return;
        accounts[provider.id] = { cookie, profile };
        saveAccounts();
        finish({ id: provider.id, name: provider.name, profile });
      } catch (error) {
        console.warn('online login check failed', error);
      }
    };

    timer = setInterval(check, 1200);
    win.webContents.on('did-navigate', check);
    win.webContents.on('did-navigate-in-page', check);

    win.on('closed', async () => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      delete loginWindows[provider.id];
      if (win.closedByUser) {
        const cookie = await collectCookie(provider).catch(() => '');
        const profile = cookie ? await provider.profile(cookie).catch(() => null) : null;
        if (profile) {
          accounts[provider.id] = { cookie, profile };
          saveAccounts();
          resolve({ id: provider.id, name: provider.name, profile });
          return;
        }
      }
      resolve(null);
    });

    win.webContents.on('did-fail-load', (_event, code, description, url) => {
      if (url && url !== 'about:blank') console.warn('login page failed', code, description, url);
    });
  });

  // QQ 音乐 / 酷狗的登录入口在首页右上角，直接帮用户点一下，省得他在窗口里再找
  if (provider.id !== 'netease') {
    let clicked = false;
    win.webContents.on('did-finish-load', () => {
      if (clicked) return;
      clicked = true;
      win.webContents.executeJavaScript(`(() => {
        const nodes = [...document.querySelectorAll('a,button,div,span')];
        const target = nodes.find(node => node.children.length === 0
          && node.offsetParent
          && /^登\\s*录$/.test((node.textContent || '').trim()));
        if (target) { target.click(); return 'clicked'; }
        return 'none';
      })()`).catch(() => {});
    });
  }

  win.loadURL(provider.loginUrl);
  return win.result;
}

/* -------------------------------- 业务接口 -------------------------------- */

function providerList() {
  return PROVIDER_IDS.map(id => {
    const provider = PROVIDERS[id];
    return {
      id,
      name: provider.name,
      color: provider.color,
      loggedIn: isLoggedIn(id),
      profile: accounts[id]?.profile || null,
      guest: provider.guest || { search: true, daily: true, charts: true, liked: false, playlists: false }
    };
  });
}

async function searchTracks(source, keyword, options = {}) {
  const provider = PROVIDERS[source];
  if (!provider) throw new Error('未知的音源');
  const word = String(keyword || '').trim();
  if (!word) return [];
  // 同一个词短时间内重复搜（切走再切回来、按回车两次）直接给上次的结果
  return cached(`search:${source}:${word}:${options.limit || ''}`, CACHE_TTL_SEARCH, async () => {
    const cookie = cookieOf(source);
    const items = await provider.search(word, { ...options, cookie });
    if (provider.attachCovers) await provider.attachCovers(items, cookie).catch(() => items);
    return items;
  });
}

/**
 * 解析一首在线歌曲为可播放音源：直链 + 封面 + 歌词。
 * 歌词单独失败不影响播放，只有直链失败才抛错。
 */
async function resolveTrack(track, options = {}) {
  const provider = PROVIDERS[track?.source];
  if (!provider) throw new Error('未知的音源');
  const cookie = cookieOf(provider.id);
  // quality: standard / higher / exhigh / lossless / hires / jymaster / master，
  // 由界面上的音质选择决定；具体支持哪些、拿不到怎么降级，都交给各 provider 处理。
  // ⚠️ 这里不要做白名单过滤，否则新加的 Hi-Res / 母带档位会被悄悄改成高品质。
  const quality = typeof options.quality === 'string' && options.quality ? options.quality : 'high';
  const info = await provider.songUrl(track, { cookie, quality });
  // 档位名只是营销标签，真实是 16bit/44.1k 还是 24bit/96k 要看文件头。
  // 和歌词并行探测，失败不影响播放。
  const probePromise = probeAudio(info.url, info).catch(() => null);
  let cover = track.cover || '';
  if (!cover && provider.coverFor) cover = await provider.coverFor(track, cookie).catch(() => '');
  let lyricText = info.lyric || '';
  if (!lyricText) {
    try {
      const raw = await provider.lyric(track, { cookie });
      lyricText = mergeLyrics(raw.original, raw.translated);
    } catch (error) {
      console.warn('online lyric failed', error.message);
    }
  }
  // trial / size 也要透传：徽标要标「试听」，界面也要能提示只拿到片段
  // format / bits / sampleRate 是探测到的实听参数（探测失败时 bits/sampleRate 为 0）
  const probe = (await probePromise) || {};
  return {
    url: info.url,
    type: info.type,
    bitrate: info.bitrate,
    level: info.level,
    trial: Boolean(info.trial),
    format: formatLabel(probe.format) || formatLabel(info.type),
    bits: Number(probe.bits) || 0,
    sampleRate: Number(probe.sampleRate) || 0,
    cover,
    lyric: lyricText
  };
}

async function lyricOf(track) {
  const provider = PROVIDERS[track?.source];
  if (!provider) throw new Error('未知的音源');
  const raw = await provider.lyric(track, { cookie: cookieOf(provider.id) });
  return mergeLyrics(raw.original, raw.translated);
}

/**
 * 每日推荐。规则：
 *  - 该音源已登录：用它账号里的个人化推荐（网易云是真正的个人化每日推荐）
 *  - 未登录：不上传个人偏好，改用「本地播放历史 / 收藏里的歌手」去搜索拼一份，
 *    本地还没有任何数据时才退回平台通用推荐
 */
async function dailyFor(source, options = {}) {
  const provider = PROVIDERS[source];
  if (!provider) throw new Error('未知的音源');
  const cookie = cookieOf(source);
  const loggedIn = isLoggedIn(source);
  const artists = (options.artists || []).map(name => String(name || '').trim()).filter(Boolean).slice(0, 4);
  const day = new Date().toISOString().slice(0, 10);
  const cacheKey = [source, day, loggedIn ? 'user' : 'guest', artists.join('|')].join('#');
  if (dailyCache.has(cacheKey)) return { tracks: dailyCache.get(cacheKey), mode: loggedIn ? 'account' : 'local' };

  let tracks = [];
  let mode = loggedIn ? 'account' : 'local';

  if (!loggedIn && artists.length) {
    // 按本地喜好歌手搜索：每家取前 8 首，轮转合并，避免某个歌手刷屏
    const lists = await Promise.all(artists.map(name => provider.search(name, { limit: 12, cookie }).catch(() => [])));
    const seen = new Set();
    const maxLen = Math.max(0, ...lists.map(list => list.length));
    for (let index = 0; index < maxLen && tracks.length < 36; index += 1) {
      for (const list of lists) {
        const track = list[index];
        if (!track || seen.has(track.key)) continue;
        seen.add(track.key);
        tracks.push(track);
        if (tracks.length >= 36) break;
      }
    }
    if (provider.attachCovers) await provider.attachCovers(tracks, cookie).catch(() => tracks);
  }

  if (tracks.length < 12) {
    // 本地没有可用偏好 / 登录态：用平台的每日推荐或热榜
    tracks = await provider.daily({ cookie });
    mode = loggedIn ? 'account' : 'chart';
  } else if (tracks.length < 24) {
    // 本地只记得住一两个歌手时，数量会偏少：用平台推荐补到 30 首，偏好仍排在最前面
    const extra = await provider.daily({ cookie }).catch(() => []);
    const seen = new Set(tracks.map(track => track.key));
    extra.forEach(track => {
      if (tracks.length >= 30 || seen.has(track.key)) return;
      seen.add(track.key);
      tracks.push(track);
    });
  }

  // 只留最近 6 个 key，避免长期运行时缓存无限增长
  if (dailyCache.size > 12) dailyCache.clear();
  dailyCache.set(cacheKey, tracks);
  return { tracks, mode };
}

async function likedFor(source) {
  const provider = PROVIDERS[source];
  if (!provider) throw new Error('未知的音源');
  return provider.liked({ cookie: cookieOf(source) });
}

async function playlistsFor(source) {
  const provider = PROVIDERS[source];
  if (!provider) throw new Error('未知的音源');
  return provider.playlists({ cookie: cookieOf(source) });
}

async function playlistTracksFor(source, id) {
  const provider = PROVIDERS[source];
  if (!provider) throw new Error('未知的音源');
  // 歌单页来回点进点出很常见，缓存 10 分钟；换歌单时 key 不同，不会串
  return cached(`playlist:${source}:${id}`, CACHE_TTL_PLAYLIST, async () => {
    const cookie = cookieOf(source);
    const tracks = await provider.playlistTracks(id, { cookie });
    if (provider.attachCovers) await provider.attachCovers(tracks, cookie).catch(() => tracks);
    return tracks;
  });
}

async function recommendPlaylistsFor(source) {
  const provider = PROVIDERS[source];
  if (!provider) throw new Error('未知的音源');
  return provider.recommendPlaylists({ cookie: cookieOf(source) });
}

/* ------------------------- 在线音频的 Referer / CORS ------------------------- */

/**
 * 允许渲染进程直接加载各家 CDN 上的音频：
 * 1. 补上各站要求的 Referer（CDN 会校验来源）；
 * 2. 注入 CORS 头，否则 Chromium 会把「跨域音频」的 WebAudio 输出静音，
 *    均衡器 / 频谱都会失效。
 */
function installAudioHeaders() {
  const ses = session.defaultSession;
  const RULES = [
    { test: /(^|\.)qq\.com$|(^|\.)qqmusic\.qq\.com$|(^|\.)stream\.qqmusic\.qq\.com$/, referer: 'https://y.qq.com/' },
    { test: /(^|\.)kugou\.com$/, referer: 'https://www.kugou.com/' },
    { test: /(^|\.)music\.126\.net$|(^|\.)163\.com$/, referer: 'https://music.163.com/' }
  ];
  const filter = { urls: ['*://*.qq.com/*', '*://*.kugou.com/*', '*://*.126.net/*', '*://*.163.com/*'] };

  ses.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const headers = details.requestHeaders;
    try {
      const host = new URL(details.url).hostname;
      const rule = RULES.find(item => item.test.test(host));
      if (rule) headers.Referer = rule.referer;
      // 在线音频由 <audio> 直接拉取，去掉 Origin 可避免部分 CDN 走 CORS 校验分支
      delete headers.Origin;
    } catch {}
    callback({ requestHeaders: headers });
  });

  ses.webRequest.onHeadersReceived(filter, (details, callback) => {
    const headers = details.responseHeaders || {};
    const key = Object.keys(headers).find(name => name.toLowerCase() === 'access-control-allow-origin');
    if (key) headers[key] = ['*'];
    else headers['Access-Control-Allow-Origin'] = ['*'];
    callback({ responseHeaders: headers });
  });
}

/* --------------------------------- 注册 --------------------------------- */

function register() {
  loadAccounts();
  installAudioHeaders();

  ipcMain.handle('online-providers', () => providerList());
  ipcMain.handle('online-login', (_event, source) => {
    const provider = PROVIDERS[source];
    if (!provider) throw new Error('未知的音源');
    return openLoginWindow(provider);
  });
  ipcMain.handle('online-logout', async (_event, source) => {
    if (!PROVIDERS[source]) return providerList();
    delete accounts[source];
    saveAccounts();
    dailyCache.clear();
    ttlCache.clear();
    try {
      const ses = session.fromPartition(`persist:orange-online-${source}`);
      await ses.clearStorageData({ storages: ['cookies'] });
    } catch {}
    return providerList();
  });
  ipcMain.handle('online-search', (_event, source, keyword, options) => searchTracks(source, keyword, options || {}));
  ipcMain.handle('online-resolve', (_event, track, options) => resolveTrack(track, options || {}));
  ipcMain.handle('online-lyric', (_event, track) => lyricOf(track));
  ipcMain.handle('online-daily', (_event, source, options) => dailyFor(source, options || {}));
  ipcMain.handle('online-liked', (_event, source) => likedFor(source));
  ipcMain.handle('online-playlists', (_event, source) => playlistsFor(source));
  ipcMain.handle('online-playlist-tracks', (_event, source, id) => playlistTracksFor(source, id));
  ipcMain.handle('online-recommend-playlists', (_event, source) => recommendPlaylistsFor(source));
  ipcMain.handle('online-open-external', (_event, url) => {
    if (/^https?:/i.test(String(url || ''))) shell.openExternal(String(url));
  });
}

module.exports = { register };
