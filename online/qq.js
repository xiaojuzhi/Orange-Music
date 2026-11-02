'use strict';
/**
 * QQ 音乐：搜索 / vkey 播放地址 / 歌词 / 账号 / 每日推荐 / 我喜欢的音乐 / 歌单。
 *
 * 播放地址需要通过 musicu.fcg 的 vkey.GetVkeyServer 模块换取，
 * 未登录（uin=0）时付费曲目会返回空 purl。
 * 每日推荐在未登录时用热歌榜按日期切片生成，登录后仍是同一套逻辑（避免不稳定的私有推荐接口）。
 */
const { UA_DESKTOP, getJson, postJson, parseCookie } = require('./net');

const HEADERS = { 'User-Agent': UA_DESKTOP, Referer: 'https://y.qq.com/' };
const API_HEADERS = { ...HEADERS, Referer: 'https://y.qq.com/portal/player.html' };

/** 从 Cookie 里取登录 uin（QQ 音乐登录后会写 uin / wxuin / p_uin） */
function uinFromCookie(cookie) {
  const jar = parseCookie(cookie);
  const raw = jar.uin || jar.wxuin || jar.p_uin || '';
  const digits = String(raw).replace(/\D/g, '');
  return digits || '0';
}

const coverUrl = albumMid => (albumMid ? `https://y.qq.com/music/photo_new/T002R500x500M000${albumMid}.jpg` : '');

/** 搜索 / 榜单返回的 song 对象 -> 播放器曲目 */
function mapSong(song) {
  const albumMid = song.album?.mid || song.albummid || song.albumMid || '';
  return {
    source: 'qq',
    key: `qq:${song.mid || song.songmid}`,
    songId: String(song.id || song.songid || ''),
    mid: song.mid || song.songmid,
    mediaMid: song.file?.media_mid || song.strMediaMid || song.mid || song.songmid,
    title: song.title || song.name || song.songname || '',
    artist: (song.singer || []).map(item => item.name).filter(Boolean).join(' / ') || '未知歌手',
    album: song.album?.name || song.album?.title || song.albumname || '',
    duration: Number(song.interval) || 0,
    cover: coverUrl(albumMid),
    vip: Boolean(song.pay?.pay_play) || Number(song.pay?.price_track) > 0,
    reason: String(song.reason || '')
  };
}

/** 「我喜欢」接口返回的老结构（字段命名和搜索接口不同） */
function mapFavorite(song) {
  const albumMid = song.album?.mid || song.albummid || '';
  const singers = Array.isArray(song.singer) ? song.singer : [];
  return {
    source: 'qq',
    key: `qq:${song.mid}`,
    songId: String(song.id || ''),
    mid: song.mid,
    mediaMid: song.media_mid || song.mid,
    title: song.name || song.title || song.songname || '',
    artist: singers.map(item => item.name).filter(Boolean).join(' / ') || '未知歌手',
    album: song.album?.name || song.albumname || '',
    duration: Number(song.interval) || 0,
    cover: coverUrl(albumMid),
    vip: false
  };
}

function mapPlaylist(item) {
  return {
    id: String(item.dissid || item.disstid || ''),
    name: item.dissname || item.diss_name || '未命名歌单',
    cover: item.imgurl || item.logo || item.picurl || '',
    count: Number(item.song_count || item.song_cnt || 0),
    playCount: Number(item.listennum || item.visitnum || 0),
    creator: item.creator?.name || item.nick || '',
    description: String(item.introduction || '').slice(0, 120)
  };
}

/* -------------------------------- 搜索 -------------------------------- */

async function search(keyword, { limit = 30, offset = 0 } = {}) {
  const page = Math.floor(offset / limit) + 1;
  const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=${page}&n=${limit}&w=${encodeURIComponent(keyword)}&format=json&cr=1&new_json=1&t=0`;
  const data = await getJson(url, { headers: HEADERS });
  return (data?.data?.song?.list || []).map(mapSong);
}

/* ------------------------------ 播放与歌词 ------------------------------ */

/** 用 vkey 换真实播放地址；返回 sip + purl，需要拼起来 */
/**
 * QQ 音乐的码流由 vkey 请求里的 filename 前缀决定：
 *   C400 + mid + mediaMid + .m4a  → 标准
 *   M500 + mid + mediaMid + .mp3  → 高品质
 *   F000 + mid + mediaMid + .flac → 无损（SQ）
 *   RS01 + mid + mediaMid + .flac → Hi-Res
 *   AI00 + mid + mediaMid + .flac → 臻品母带
 * 不传 filename 时服务端给默认码流（一般是 m4a），作为最后一层兜底。
 */
const QUALITY_TIERS = {
  standard: { prefix: 'C400', ext: '.m4a', label: '标准', type: 'm4a', bitrate: 128 },
  high: { prefix: 'M500', ext: '.mp3', label: '高品质', type: 'mp3', bitrate: 320 },
  lossless: { prefix: 'F000', ext: '.flac', label: '无损', type: 'flac', bitrate: 900 },
  hires: { prefix: 'RS01', ext: '.flac', label: 'Hi-Res', type: 'flac', bitrate: 1500 },
  master: { prefix: 'AI00', ext: '.flac', label: '臻品母带', type: 'flac', bitrate: 2000 }
};

/** 会员档位拿不到时逐级回退，别直接掉到默认码流让用户以为设置没生效 */
const QUALITY_CHAIN = {
  master: ['master', 'hires', 'lossless', 'high', 'standard', ''],
  hires: ['hires', 'lossless', 'high', 'standard', ''],
  lossless: ['lossless', 'high', 'standard', ''],
  high: ['high', 'standard', ''],
  standard: ['standard', '']
};

function fileNameOf(quality, mid, mediaMid) {
  const tier = QUALITY_TIERS[quality];
  return tier ? `${tier.prefix}${mid}${mediaMid}${tier.ext}` : '';
}

/** 按 purl 实际扩展名反推真实音质：会员被降级时，这里的标签才是真话 */
function actualQuality(purl) {
  if (/\.flac/i.test(purl)) return { type: 'flac', bitrate: 900, level: '无损' };
  if (/\.ape/i.test(purl)) return { type: 'ape', bitrate: 900, level: '无损' };
  if (/\.mp3/i.test(purl)) return { type: 'mp3', bitrate: 320, level: '320K' };
  return { type: 'm4a', bitrate: 128, level: '标准' };
}

async function requestVkey(track, cookie, quality) {
  const uin = uinFromCookie(cookie);
  const guid = String(Math.floor(Math.random() * 9000000000) + 1000000000);
  const mediaMid = track.mediaMid || track.mid;
  const param = { guid, songmid: [track.mid], songtype: [0], uin, loginflag: 1, platform: '20' };
  const fileName = fileNameOf(quality, track.mid, mediaMid);
  if (fileName) param.filename = [fileName];
  const payload = {
    req_0: { module: 'vkey.GetVkeyServer', method: 'CgiGetVkey', param },
    comm: { uin: Number(uin) || 0, format: 'json', ct: 24, cv: 0 }
  };
  const data = await postJson('https://u.y.qq.com/cgi-bin/musicu.fcg', payload, {
    headers: { ...HEADERS, ...(cookie ? { Cookie: cookie } : {}) }
  });
  return {
    info: data?.req_0?.data?.midurlinfo?.[0],
    sip: data?.req_0?.data?.sip?.[0] || 'https://dl.stream.qqmusic.qq.com/'
  };
}

async function songUrl(track, { cookie = '', quality = 'high' } = {}) {
  const wanted = QUALITY_TIERS[quality] ? quality : 'high';
  // 没登录时任何会员档位都是空的，直接问一次默认码流：拿到就放（免费曲），
  // 拿不到就明确要求登录，别把整条回退链问一遍
  if (!/qm_keyst=/.test(cookie || '')) {
    const { info, sip } = await requestVkey(track, cookie, '');
    if (!info?.purl) throw new Error('QQ 音乐需要先登录账号才能播放（会员曲目还需要会员）');
    const actual = actualQuality(info.purl);
    return { url: sip + info.purl, type: actual.type, bitrate: actual.bitrate, size: 0, level: actual.level, trial: false };
  }
  const chain = QUALITY_CHAIN[wanted] || QUALITY_CHAIN.high;
  for (const level of chain) {
    const { info, sip } = await requestVkey(track, cookie, level);
    if (!info?.purl) continue;
    // 走到这一层就说明「这一档真的拿到了」，标签按这一档报，比按扩展名猜准
    const tier = QUALITY_TIERS[level];
    const actual = tier
      ? { type: tier.type, bitrate: tier.bitrate, level: tier.label }
      : actualQuality(info.purl);
    return {
      url: sip + info.purl,
      type: actual.type,
      bitrate: actual.bitrate,
      size: 0,
      level: actual.level,
      trial: false
    };
  }
  throw new Error(track.vip ? '这首歌需要 QQ 音乐会员，请先在在线音乐页登录会员账号' : 'QQ 音乐没有返回可播放地址');
}

async function lyric(track) {
  const url = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${track.mid}&format=json&nobase64=1&g_tk=5381&loginUin=0&hostUin=0&platform=yqq&needNewCode=0`;
  const data = await getJson(url, { headers: API_HEADERS });
  const decode = value => (value
    ? String(value).replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    : '');
  return { original: decode(data?.lyric), translated: decode(data?.trans), romanized: '' };
}

async function profile(cookie) {
  if (!cookie) return null;
  const jar = parseCookie(cookie);
  const uin = uinFromCookie(cookie);
  // 未登录时 uin 是 o0000000000 这类占位值，去掉前导零后只剩 0，一律按未登录处理
  if (!uin || /^0+$/.test(uin)) return null;
  // QQ 登录后会把昵称写在 ptnick_<uin> 里（URL 编码）
  let nickname = '';
  Object.keys(jar).forEach(name => {
    if (name.startsWith('ptnick_')) {
      try { nickname = decodeURIComponent(jar[name]); } catch { nickname = jar[name]; }
    }
  });
  return {
    nickname: nickname || `QQ ${uin.replace(/^(\d{3})\d+(\d{2})$/, '$1****$2')}`,
    avatar: '',
    vip: Boolean(jar.qqmusic_vip || jar.qm_vip),
    uid: uin
  };
}

/* --------------------------- 每日推荐 / 收藏 / 歌单 --------------------------- */

async function topList(topId = 26, limit = 100) {
  const url = `https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid=${topId}&page=detail&type=top&tpl=3&format=json&inCharset=utf8&outCharset=utf-8&platform=yqq.json`;
  const data = await getJson(url, { headers: HEADERS });
  return (data?.songlist || []).slice(0, limit).map(item => mapSong(item.data || item));
}

/**
 * 每日推荐：取热歌榜（topid=26）并按当天日期错开起点，
 * 这样每天看到的是不同的一段，不需要依赖 QQ 那个经常变签名的私有推荐接口。
 */
async function daily({ cookie = '', limit = 30 } = {}) {
  const list = await topList(26, 200);
  if (!list.length) throw new Error('QQ 音乐暂时没有返回推荐歌曲');
  const dayIndex = Math.floor(Date.now() / 86400000);
  const start = (dayIndex * 7) % Math.max(1, list.length - limit);
  const sliced = list.slice(start, start + limit);
  return (sliced.length >= limit ? sliced : list.slice(0, limit)).map((track, index) => ({
    ...track,
    reason: index < 3 ? '热歌榜 Top' : ''
  }));
}

/** 我喜欢的音乐：需要登录，userid = uin */
async function liked({ cookie = '' } = {}) {
  const uin = uinFromCookie(cookie);
  if (!cookie || /^0+$/.test(uin)) throw new Error('需要先登录 QQ 音乐才能读取「我喜欢的音乐」');
  const url = `https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg?ct=20&cid=205360956&userid=${uin}&reqtype=2&format=json&g_tk=5381&loginUin=${uin}&hostUin=0&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`;
  const data = await getJson(url, { headers: API_HEADERS });
  const list = data?.data?.songlist || [];
  if (!list.length && Number(data?.code) !== 0) throw new Error('QQ 音乐没有返回收藏列表，请确认登录状态');
  return list.map(mapFavorite);
}

/** 当前账号的歌单 */
async function playlists({ cookie = '' } = {}) {
  const uin = uinFromCookie(cookie);
  if (!cookie || /^0+$/.test(uin)) throw new Error('需要先登录 QQ 音乐才能读取账号歌单');
  const url = `https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg?ct=20&cid=205360956&userid=${uin}&reqtype=3&format=json&g_tk=5381&loginUin=${uin}&hostUin=0&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`;
  const data = await getJson(url, { headers: API_HEADERS });
  return (data?.data?.cdlist || []).map(mapPlaylist);
}

/**
 * 歌单详情（免登录可读公开歌单）。
 * 老 qzone 的 fcg_ucc_getcdinfo 已经不下发 songlist 了，改用 fcg_v8_playlist_cp，
 * 它失败时回落到 musicu.fcg 的 DissInfo.CgiGetDiss。
 */
async function playlistTracks(id, { cookie = '' } = {}) {
  const headers = { ...API_HEADERS, ...(cookie ? { Cookie: cookie } : {}) };
  try {
    const data = await getJson(`https://c.y.qq.com/v8/fcg-bin/fcg_v8_playlist_cp.fcg?id=${encodeURIComponent(id)}&format=json&newsong=1&platform=yqq.json`, { headers });
    const songs = data?.data?.cdlist?.[0]?.songlist || [];
    if (songs.length) return songs.map(mapSong);
  } catch {
    // 走下面的兜底
  }
  const payload = {
    comm: { ct: 20, cv: 1845, uin: 0, format: 'json' },
    req_1: {
      module: 'music.srfDissInfo.DissInfo',
      method: 'CgiGetDiss',
      param: { disstid: Number(id) || id, dirid: 0, tag: 1, song_begin: 0, song_num: 100, userinfo: 1 }
    }
  };
  const data = await postJson('https://u.y.qq.com/cgi-bin/musicu.fcg', payload, { headers });
  const songs = data?.req_1?.data?.songlist || [];
  if (!songs.length) throw new Error('这个歌单没有可读取的歌曲（可能是私密歌单）');
  return songs.map(mapSong);
}

/** 歌单广场（免登录），用于「歌单」页的平台精选 */
async function recommendPlaylists({ limit = 12 } = {}) {
  const url = `https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg?picmid=1&rnd=0.1&g_tk=5381&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0&categoryId=10000000&sortId=5&sin=0&ein=${Math.max(0, limit - 1)}`;
  const data = await getJson(url, { headers: API_HEADERS });
  return (data?.data?.list || []).map(mapPlaylist).filter(item => item.id);
}

module.exports = {
  id: 'qq',
  name: 'QQ 音乐',
  color: '#31c27c',
  loginUrl: 'https://y.qq.com/',
  cookieDomains: ['qq.com', 'y.qq.com', 'music.qq.com'],
  // qm_keyst 是 QQ 音乐登录后才会下发的票据，用它判断登录最准（uin 在未登录时也有占位值）
  cookieNames: ['qm_keyst'],
  guest: { search: true, daily: true, charts: true, liked: false, playlists: false },
  search, songUrl, lyric, profile,
  daily, liked, playlists, playlistTracks, recommendPlaylists
};
