'use strict';
/**
 * 网易云音乐：搜索 / 播放直链 / 歌词 / 账号 / 每日推荐 / 我喜欢的音乐 / 歌单。
 *
 * 全部走非公开 Web 接口。未登录时搜索、歌词、歌单浏览、每日推荐都可用；
 * 播放完整曲目与「我喜欢的音乐」需要登录（Cookie 里要有 MUSIC_U）。
 */
const { UA_DESKTOP, getJson, request, weapi, parseCookie } = require('./net');

const HEADERS = { 'User-Agent': UA_DESKTOP, Referer: 'https://music.163.com/' };
/** 未登录时也要带上，接口才会按网页端返回 JSON */
const GUEST_COOKIE = 'appver=8.9.70; os=pc';
const LEVELS = {
  standard: '标准', higher: '较高', exhigh: '极高', lossless: '无损',
  hires: 'Hi-Res', jymaster: '超清母带', sky: '沉浸环绕', jyeffect: '空间音频'
};
/** 界面上的音质档位 -> 网易云 weapi 的 level 参数（都是官方档位，按账号权限给流） */
const QUALITY_LEVEL = {
  standard: 'standard', higher: 'higher', exhigh: 'exhigh', high: 'exhigh',
  lossless: 'lossless', hires: 'hires', jymaster: 'jymaster'
};
/**
 * 档位回退链：账号没有更高档权限时，接口会返回空 url。
 * 一层层往下试，既能保住「会员档位能拿到就拿」，也不会像以前那样直接掉到 128k 外链。
 */
const QUALITY_CHAIN = {
  standard: ['standard'],
  higher: ['higher', 'standard'],
  exhigh: ['exhigh', 'higher', 'standard'],
  lossless: ['lossless', 'exhigh', 'higher', 'standard'],
  hires: ['hires', 'lossless', 'exhigh', 'higher', 'standard'],
  jymaster: ['jymaster', 'hires', 'lossless', 'exhigh', 'higher', 'standard']
};

function cookieHeaders(cookie) {
  return { ...HEADERS, Cookie: cookie || GUEST_COOKIE };
}

/**
 * 取码流时必须让服务端以为这是 PC 客户端，否则 Hi-Res / 超清母带一律返空
 * （只带 MUSIC_U 时 hires、jymaster 永远是 null，实测加 os=pc + appver 才会放流）。
 */
function pcCookie(cookie) {
  const base = cookie || GUEST_COOKIE;
  if (/os=pc/.test(base)) return base;
  return `${base}; os=pc; appver=8.9.70`;
}

function weapiHeaders(cookie) {
  return {
    ...HEADERS,
    Cookie: cookie || GUEST_COOKIE,
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: 'https://music.163.com'
  };
}

/** 把接口返回的 song 对象统一成播放器用的曲目结构 */
function mapSong(song, extra = {}) {
  const artistList = song.ar || song.artists || [];
  const album = song.al || song.album || {};
  const pic = album.picUrl || album.blurPicUrl || '';
  const durationMs = Number(song.dt || song.duration) || 0;
  return {
    source: 'netease',
    key: `netease:${song.id}`,
    songId: String(song.id),
    title: song.name || '',
    artist: artistList.map(item => item.name).filter(Boolean).join(' / ') || '未知歌手',
    album: album.name || '',
    duration: Math.round(durationMs / 1000),
    cover: pic ? `${pic}?param=600y600` : '',
    vip: Number(song.fee) === 1,
    albumId: album.id || 0,
    reason: String(extra.reason || song.reason || '')
  };
}

function mapPlaylist(item) {
  const cover = item.coverImgUrl || item.picUrl || '';
  return {
    id: String(item.id),
    name: item.name || '未命名歌单',
    cover: cover ? `${cover}?param=400y400` : '',
    count: Number(item.trackCount || 0),
    playCount: Number(item.playCount || 0),
    creator: item.creator?.nickname || item.creator?.name || '',
    description: String(item.description || '').slice(0, 120)
  };
}

/* -------------------------------- 搜索 -------------------------------- */

async function search(keyword, { limit = 30, offset = 0, cookie = '' } = {}) {
  const url = `https://music.163.com/api/search/get/web?s=${encodeURIComponent(keyword)}&type=1&limit=${limit}&offset=${offset}`;
  const data = await getJson(url, { headers: cookieHeaders(cookie) });
  return (data?.result?.songs || []).map(song => mapSong(song));
}

/**
 * 搜索接口只返回数字 picId，封面要单独查。
 * song/detail 支持一次传多个 id，所以整页 40 首只需要一次请求。
 */
async function attachCovers(tracks, cookie = '') {
  const ids = tracks.map(track => track.songId).filter(Boolean).slice(0, 60);
  if (!ids.length) return tracks;
  try {
    const data = await getJson(`https://music.163.com/api/song/detail?ids=[${ids.join(',')}]`, { headers: cookieHeaders(cookie) });
    const map = new Map((data?.songs || []).map(song => [String(song.id), song.album?.picUrl || '']));
    tracks.forEach(track => {
      const pic = map.get(String(track.songId));
      if (pic) track.cover = `${pic}?param=600y600`;
    });
  } catch {
    // 封面只是锦上添花，失败就留空用默认封面
  }
  return tracks;
}

async function coverFor(track, cookie = '') {
  if (track.cover) return track.cover;
  try {
    const data = await getJson(`https://music.163.com/api/song/detail?ids=[${track.songId}]`, { headers: cookieHeaders(cookie) });
    const pic = data?.songs?.[0]?.album?.picUrl || '';
    return pic ? `${pic}?param=600y600` : '';
  } catch {
    return '';
  }
}

/* ------------------------------ 播放与歌词 ------------------------------ */

/**
 * 播放直链。优先 weapi 的 player/url/v1（登录后能拿会员音质），
 * 按档位回退链逐级尝试；全都没 url 时才回落到外链接口
 * （免费曲目可用，付费曲目会 302 到 404）。
 */
async function songUrl(track, { cookie = '', quality = 'high' } = {}) {
  const wanted = quality === 'high' ? 'exhigh' : (QUALITY_LEVEL[quality] ? quality : 'exhigh');
  // 未登录时只试「请求档位 + 标准」两档：会员档位对游客一律返空，
  // 沿整条回退链问六遍纯属浪费请求
  const loggedIn = /MUSIC_U=/.test(cookie || '');
  const chain = loggedIn
    ? (QUALITY_CHAIN[wanted] || QUALITY_CHAIN.exhigh)
    : [...new Set([wanted, 'standard'])];
  let trialUrl = null;
  for (const levelName of chain) {
    try {
      const data = await getJson('https://music.163.com/weapi/song/enhance/player/url/v1?csrf_token=', {
        method: 'POST',
        headers: weapiHeaders(pcCookie(cookie)),
        body: weapi({ ids: `[${track.songId}]`, level: QUALITY_LEVEL[levelName], encodeType: 'flac' })
      });
      const item = data?.data?.[0];
      if (!item?.url) continue;
      const result = {
        url: item.url,
        type: item.type || 'mp3',
        bitrate: Math.round((Number(item.br) || 0) / 1000),
        size: Number(item.size) || 0,
        level: LEVELS[item.level] || LEVELS[levelName] || '',
        trial: Boolean(item.freeTrialInfo)
      };
      // 试听片段先留着，继续往下找有没有完整可播的档位
      if (result.trial) { trialUrl = trialUrl || result; continue; }
      return result;
    } catch {
      // 单档失败不影响后面的档位
    }
  }
  if (trialUrl) return trialUrl;

  const outer = await request(`https://music.163.com/song/media/outer/url?id=${track.songId}.mp3`, {
    headers: HEADERS,
    redirect: 'manual'
  });
  const location = outer.response.headers.get('location') || '';
  if (location && !/music\.163\.com\/404/.test(location)) {
    return { url: location, type: 'mp3', bitrate: 128, size: 0, level: '标准', trial: true };
  }
  throw new Error(track.vip ? '这首歌需要网易云会员，请先在在线音乐页登录会员账号' : '网易云没有返回可播放地址');
}

/** 歌词：lrc 原文 + tlyric 译文，合并后交给渲染层解析 */
async function lyric(track, { cookie = '' } = {}) {
  const data = await getJson(`https://music.163.com/api/song/lyric?id=${track.songId}&lv=-1&kv=-1&tv=-1`, {
    headers: cookieHeaders(cookie)
  });
  return {
    original: data?.lrc?.lyric || '',
    translated: data?.tlyric?.lyric || '',
    romanized: data?.romalrc?.lyric || ''
  };
}

/** 账号信息：判断是否真的处于登录态，顺带拿到 uid（拉「我喜欢的音乐」要用） */
async function profile(cookie) {
  if (!cookie) return null;
  if (!parseCookie(cookie).MUSIC_U) return null;
  try {
    const data = await getJson('https://music.163.com/api/nuser/account/get', { headers: cookieHeaders(cookie) });
    const user = data?.profile;
    if (!user) return { nickname: '网易云用户', avatar: '', vip: false, uid: '' };
    return {
      nickname: user.nickname || '网易云用户',
      avatar: user.avatarUrl || '',
      vip: Boolean(user.vipType),
      uid: String(user.userId || '')
    };
  } catch {
    return { nickname: '网易云用户', avatar: '', vip: false, uid: '' };
  }
}

async function uidOf(cookie) {
  const info = await profile(cookie);
  if (!info?.uid) throw new Error('网易云登录已失效，请重新登录');
  return info.uid;
}

/* --------------------------- 每日推荐 / 收藏 / 歌单 --------------------------- */

/**
 * 每日推荐：登录后是个人化推荐，未登录也会返回一份通用推荐（实测 30 首可用）。
 */
async function daily({ cookie = '' } = {}) {
  const data = await getJson('https://music.163.com/weapi/v3/discovery/recommend/songs?csrf_token=', {
    method: 'POST',
    headers: weapiHeaders(cookie),
    body: weapi({ limit: 50, offset: 0, total: true })
  });
  const songs = data?.data?.dailySongs;
  if (!Array.isArray(songs) || !songs.length) {
    throw new Error('网易云暂时没有返回每日推荐，请稍后再试');
  }
  return songs.map(song => mapSong(song));
}

/** 我喜欢的音乐：uid -> 红心歌单（specialType=5） -> 歌单详情 */
async function liked({ cookie = '' } = {}) {
  if (!cookie) throw new Error('需要先登录网易云才能读取「我喜欢的音乐」');
  const uid = await uidOf(cookie);
  const listData = await getJson(`https://music.163.com/api/user/playlist?uid=${uid}&limit=200&offset=0`, {
    headers: cookieHeaders(cookie)
  });
  const love = (listData?.playlist || []).find(item => Number(item.specialType) === 5);
  if (!love) return [];
  return playlistTracks(love.id, { cookie });
}

/** 当前账号创建 / 收藏的歌单 */
async function playlists({ cookie = '' } = {}) {
  if (!cookie) throw new Error('需要先登录网易云才能读取账号歌单');
  const uid = await uidOf(cookie);
  const data = await getJson(`https://music.163.com/api/user/playlist?uid=${uid}&limit=200&offset=0`, {
    headers: cookieHeaders(cookie)
  });
  return (data?.playlist || []).map(mapPlaylist);
}

/** 歌单详情（免登录也能读公开歌单） */
async function playlistTracks(id, { cookie = '' } = {}) {
  const data = await getJson(`https://music.163.com/api/v6/playlist/detail?id=${encodeURIComponent(id)}&n=1000&s=0`, {
    headers: cookieHeaders(cookie)
  });
  const tracks = data?.playlist?.tracks || [];
  return tracks.map(song => mapSong(song));
}

/** 推荐歌单（免登录可用），用于「歌单」页的平台精选 */
async function recommendPlaylists({ cookie = '', limit = 12 } = {}) {
  const data = await getJson(`https://music.163.com/api/personalized/playlist?limit=${limit}`, {
    headers: cookieHeaders(cookie)
  });
  return (data?.result || []).map(mapPlaylist);
}

module.exports = {
  id: 'netease',
  name: '网易云音乐',
  color: '#e8443c',
  loginUrl: 'https://music.163.com/login?targetUrl=%2Fdiscover',
  cookieDomains: ['music.163.com', '163.com'],
  cookieNames: ['MUSIC_U'],
  /** 未登录时能拿到哪些数据，用于界面提示 */
  guest: { search: true, daily: true, charts: true, liked: false, playlists: false },
  search, attachCovers, coverFor, songUrl, lyric, profile,
  daily, liked, playlists, playlistTracks, recommendPlaylists
};
