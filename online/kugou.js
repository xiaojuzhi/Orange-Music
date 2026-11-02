'use strict';
/**
 * 酷狗音乐：搜索 / 播放地址 / 歌词 / 账号 / 每日推荐 / 我喜欢的音乐 / 榜单。
 *
 * 酷狗 web 接口需要 signature（参数字典序拼接 + md5），播放接口还要求带上登录 token。
 * 榜单（rank）接口免登录可用，每日推荐就基于它按日期轮换生成。
 */
const { UA_DESKTOP, UA_MOBILE, getJson, request, kugouSign, parseCookie, md5 } = require('./net');

const HEADERS = { 'User-Agent': UA_DESKTOP, Referer: 'https://www.kugou.com/' };

/** 取一个稳定的设备标识：优先用 Cookie 里酷狗下发的 kg_mid / kg_dfid */
function deviceFrom(cookie) {
  const jar = parseCookie(cookie);
  return { mid: jar.kg_mid || md5(`orange-mid-${Date.now()}`), dfid: jar.kg_dfid || '-' };
}

function loginToken(cookie) {
  const jar = parseCookie(cookie);
  return {
    token: jar.token || jar.KuGooToken || '',
    userid: jar.userid || ''
  };
}

/** 榜单 / 喜欢列表返回的条目 -> 播放器曲目 */
function mapSong(item) {
  const hash = item.hash || item.FileHash || '';
  // filename 通常是「歌手 - 歌名」
  const raw = item.filename || item.FileName || '';
  const dash = raw.indexOf(' - ');
  const nameFromFile = dash > 0 ? raw.slice(dash + 3) : raw.replace(/\.[^.]+$/, '');
  return {
    source: 'kugou',
    key: `kugou:${hash}`,
    songId: String(item.album_audio_id || item.audio_id || item.mixsongid || ''),
    mid: hash,
    hash,
    albumId: String(item.album_id || ''),
    albumAudioId: String(item.album_audio_id || ''),
    title: item.songname || item.SongName || nameFromFile || '',
    artist: item.singername || item.SingerName || (dash > 0 ? raw.slice(0, dash) : '') || '未知歌手',
    album: item.album_name || item.AlbumName || '',
    duration: Math.round(Number(item.duration) || 0),
    cover: '',
    // pay_type: 3 表示付费曲目
    vip: Number(item.pay_type) === 3 || Number(item.privilege) === 10,
    quality: [item.sqhash ? '无损' : '', item['320hash'] ? '320K' : '', '128K'].filter(Boolean),
    hash320: item['320hash'] || '',
    hashSq: item.sqhash || ''
  };
}

function mapRank(item) {
  const cover = Array.isArray(item.imgurl) ? item.imgurl[0] : item.imgurl;
  return {
    id: `rank-${item.rankid}`,
    name: item.rankname || '未命名榜单',
    cover: cover || '',
    count: Number(item.album_audio_count || item.song_count || 0),
    playCount: Number(item.visit_count || 0),
    creator: '酷狗榜单',
    description: String(item.intro || '').slice(0, 120)
  };
}

/* -------------------------------- 搜索 -------------------------------- */

async function search(keyword, { limit = 30, offset = 0 } = {}) {
  const page = Math.floor(offset / limit) + 1;
  // 酷狗的移动端搜索域名只支持 http，https 会连接失败
  const url = `http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(keyword)}&page=${page}&pagesize=${limit}&showtype=1`;
  const data = await getJson(url, { headers: { 'User-Agent': UA_MOBILE } });
  return (data?.data?.info || []).map(mapSong);
}

/* ------------------------------ 播放与歌词 ------------------------------ */

/** 请求 play/songinfo（新接口，需签名 + 登录 token） */
/** 界面音质 -> 酷狗 quality 参数（128 / 320 / 999 无损）。酷狗实际给什么码流仍由账号权限决定 */
const QUALITY_PARAM = { standard: '128', high: '320', lossless: '999' };

async function songInfo(track, cookie, quality = '') {
  const { mid, dfid } = deviceFrom(cookie);
  const { token, userid } = loginToken(cookie);
  const params = {
    srcappid: '2919', clientver: '20000', clienttime: String(Date.now()),
    mid, uuid: mid, dfid, appid: '1014', platid: '4',
    encode_album_audio_id: track.albumAudioId || '',
    token, userid: userid || '0'
  };
  if (QUALITY_PARAM[quality]) params.quality = QUALITY_PARAM[quality];
  params.signature = kugouSign(params);
  return getJson(`https://wwwapi.kugou.com/play/songinfo?${new URLSearchParams(params).toString()}`, {
    headers: { ...HEADERS, Cookie: cookie || `kg_mid=${mid}; kg_dfid=${dfid}` }
  });
}

/** 老接口兜底：yy/index.php?r=play/getdata */
async function legacySongData(track, cookie) {
  const { mid, dfid } = deviceFrom(cookie);
  const { token, userid } = loginToken(cookie);
  const params = {
    r: 'play/getdata', hash: track.hash, album_id: track.albumId || '',
    dfid, mid, platid: '4', appid: '1014', token, userid: userid || '0'
  };
  params.signature = kugouSign(params);
  return getJson(`https://wwwapi.kugou.com/yy/index.php?${new URLSearchParams(params).toString()}`, {
    headers: { ...HEADERS, Cookie: cookie || `kg_mid=${mid}; kg_dfid=${dfid}` }
  });
}

async function songUrl(track, { cookie = '', quality = 'high' } = {}) {
  const attempts = [];
  // 1) 新接口
  try {
    const data = await songInfo(track, cookie, quality);
    const info = data?.data || {};
    const url = info.play_url || info.play_backup_url || '';
    if (url) {
      return {
        url,
        type: info.extname || 'mp3',
        bitrate: Number(info.bitrate) || 128,
        size: Number(info.file_size) || 0,
        level: Number(info.bitrate) >= 900 ? '无损' : Number(info.bitrate) >= 320 ? '320K' : '128K',
        trial: Number(info.privilege) === 10,
        lyric: info.lyrics || ''
      };
    }
    attempts.push(`songinfo err_code=${data?.err_code ?? '?'}`);
  } catch (error) {
    attempts.push(`songinfo ${error.message}`);
  }
  // 2) 老接口兜底
  try {
    const data = await legacySongData(track, cookie);
    const info = data?.data || {};
    if (info.play_url) {
      return {
        url: info.play_url,
        type: info.extname || 'mp3',
        bitrate: Number(info.bitrate) || 128,
        size: Number(info.file_size) || 0,
        level: '128K',
        trial: true,
        lyric: info.lyrics || ''
      };
    }
    attempts.push(`getdata err_code=${data?.err_code ?? data?.status ?? '?'}`);
  } catch (error) {
    attempts.push(`getdata ${error.message}`);
  }
  throw new Error(`酷狗没有返回可播放地址（${attempts.join('；')}）。付费曲目需要在酷狗登录会员账号`);
}

/** 歌词：先按 hash 找，找不到再按「歌名 - 歌手」搜 */
async function lyric(track) {
  const candidates = [];
  try {
    const byHash = await getJson(`http://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=&duration=${(track.duration || 0) * 1000}&hash=${track.hash}`, {
      headers: { 'User-Agent': UA_MOBILE }
    });
    candidates.push(...(byHash?.candidates || []));
  } catch {}
  if (!candidates.length) {
    const keyword = encodeURIComponent(`${track.title} - ${track.artist}`);
    try {
      const byName = await getJson(`http://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=${keyword}&duration=&hash=`, {
        headers: { 'User-Agent': UA_MOBILE }
      });
      candidates.push(...(byName?.candidates || []));
    } catch {}
  }
  for (const candidate of candidates.slice(0, 3)) {
    try {
      const { text } = await request(`http://lyrics.kugou.com/download?ver=1&client=pc&id=${candidate.id}&accesskey=${candidate.accesskey}&fmt=lrc&charset=utf8`, {
        headers: { 'User-Agent': UA_MOBILE }
      });
      const data = JSON.parse(text);
      if (data?.content) {
        return { original: Buffer.from(data.content, 'base64').toString('utf8'), translated: '', romanized: '' };
      }
    } catch {}
  }
  return { original: '', translated: '', romanized: '' };
}

async function profile(cookie) {
  if (!cookie) return null;
  const { token, userid } = loginToken(cookie);
  if (!token) return null;
  try {
    const { mid, dfid } = deviceFrom(cookie);
    const params = {
      srcappid: '2919', clientver: '20000', clienttime: String(Date.now()),
      mid, uuid: mid, dfid, appid: '1014', platid: '4', token, userid: userid || '0'
    };
    params.signature = kugouSign(params);
    const data = await getJson(`https://wwwapi.kugou.com/v1/get_user_info?${new URLSearchParams(params).toString()}`, {
      headers: { ...HEADERS, Cookie: cookie }
    });
    const info = data?.data || {};
    if (info.nickname || info.username) {
      return {
        nickname: info.nickname || info.username,
        avatar: info.pic || '',
        vip: Boolean(info.vip_type || info.is_vip),
        uid: userid
      };
    }
  } catch {}
  return { nickname: `酷狗用户 ${userid}`.trim(), avatar: '', vip: false, uid: userid };
}

/* --------------------------- 每日推荐 / 收藏 / 榜单 --------------------------- */

async function rankList() {
  const data = await getJson('http://mobilecdn.kugou.com/api/v3/rank/list?apiver=2&plat=0&withsong=1&parentid=0&version=8000', {
    headers: { 'User-Agent': UA_MOBILE }
  });
  return (data?.data?.info || []).map(mapRank);
}

async function rankSongs(rankId, limit = 100) {
  const data = await getJson(`http://mobilecdn.kugou.com/api/v3/rank/song?rankid=${encodeURIComponent(rankId)}&page=1&pagesize=${limit}&format=json`, {
    headers: { 'User-Agent': UA_MOBILE }
  });
  return (data?.data?.info || []).map(mapSong);
}

/** 每日推荐：按日期在榜单里轮换取一个榜的前 50 首 */
async function daily({ limit = 30 } = {}) {
  const ranks = await rankList();
  if (!ranks.length) throw new Error('酷狗暂时没有返回榜单');
  const dayIndex = Math.floor(Date.now() / 86400000);
  const picked = ranks[dayIndex % ranks.length];
  const list = await rankSongs(picked.id.replace('rank-', ''), 100);
  if (!list.length) throw new Error('酷狗榜单暂时没有歌曲');
  const start = (dayIndex * 3) % Math.max(1, list.length - limit);
  const sliced = list.slice(start, start + limit);
  return (sliced.length >= limit ? sliced : list.slice(0, limit)).map((track, index) => ({
    ...track,
    reason: index === 0 ? picked.name : ''
  }));
}

/** 我喜欢的音乐：酷狗网关接口，需要 token + 签名 */
async function liked({ cookie = '' } = {}) {
  const { token, userid } = loginToken(cookie);
  if (!token || !userid) throw new Error('需要先登录酷狗才能读取「我喜欢的音乐」');
  const { mid, dfid } = deviceFrom(cookie);
  const params = {
    appid: '1014', clientver: '20000', clienttime: String(Date.now()),
    mid, uuid: mid, dfid, userid, token,
    page: '1', pagesize: '100', filter: '10', need_sort: '1', type: '0'
  };
  params.signature = kugouSign(params);
  const data = await getJson(`https://gateway.kugou.com/v2/get_user_like_songs?${new URLSearchParams(params).toString()}`, {
    headers: { 'User-Agent': UA_MOBILE, Cookie: cookie, 'x-router': 'cloudlist.service.kugou.com' }
  });
  const list = data?.data?.info || data?.data?.songs || [];
  if (!list.length) throw new Error('酷狗没有返回收藏列表，请确认登录状态');
  return list.map(item => mapSong(item.song_info || item));
}

/** 酷狗的账号歌单接口不稳定，这里明确报错，界面上给「不支持」提示而不是空白 */
async function playlists() {
  throw new Error('酷狗暂不支持在客户端读取账号歌单，可以先去「榜单」浏览或把喜欢的歌收藏到本地');
}

/** 榜单详情：id 形如 rank-8888 */
async function playlistTracks(id, { limit = 100 } = {}) {
  const rankId = String(id).replace(/^rank-/, '');
  const list = await rankSongs(rankId, limit);
  if (!list.length) throw new Error('这个榜单暂时没有歌曲');
  return list;
}

/** 榜单列表作为「平台精选」 */
async function recommendPlaylists() {
  return rankList();
}

module.exports = {
  id: 'kugou',
  name: '酷狗音乐',
  color: '#2aa5ff',
  loginUrl: 'https://www.kugou.com/',
  cookieDomains: ['kugou.com'],
  // 酷狗网页登录后写的是 token / KuGooToken，个别入口只写 userid
  cookieNames: ['token', 'KuGooToken', 'userid'],
  guest: { search: true, daily: true, charts: true, liked: false, playlists: false },
  search, songUrl, lyric, profile,
  daily, liked, playlists, playlistTracks, recommendPlaylists
};
