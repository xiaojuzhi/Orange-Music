'use strict';
// 音频标签 / 歌词解析：浏览器端（渲染进程）与 Node 端（主进程，用于自动扫描）共用
const LYRICS_KEYS = [
  'LYRICS', 'LYRIC', 'UNSYNCEDLYRICS', 'UNSYNCED LYRICS', 'UNSYNCHRONISEDLYRICS',
  'SYNCEDLYRICS', 'LRC', 'LYRICS_ENG', 'LYRICSZHO', '歌词', 'LYRICS-XXX'
];

// MP4 / M4A 里承载标签的原子名 -> 统一字段名
const MP4_TAG_ATOMS = {
  '\u00a9nam': 'title',
  '\u00a9ART': 'artist',
  'aART': 'artist',
  '\u00a9alb': 'album',
  '\u00a9lyr': 'lyricsText',
  'covr': 'artwork'
};

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OrangeTags = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
/**
 * 按 BOM / 内容把字节流解码成文本。
 * 顺序：UTF-16 BOM → UTF-8 BOM 剔除 → 严格 UTF-8 → GBK 兜底。
 */
function decodeTextBuffer(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes);
  }
  const body = (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    ? bytes.subarray(3)
    : bytes;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch (error) {
    try {
      return new TextDecoder('gbk').decode(body);
    } catch (innerError) {
      return new TextDecoder('utf-8').decode(body);
    }
  }
}

/**
 * 在字节流中查找 ASCII 串（等价于 bytes.indexOf(text) 的字节版）。
 * @returns {number} 首次出现的下标，找不到返回 -1
 */
function findBytes(bytes, text, from = 0, limit = 0) {
  const length = text.length;
  const end = limit ? Math.min(bytes.length, limit) : bytes.length;
  for (let i = Math.max(0, from); i + length <= end; i += 1) {
    let match = true;
    for (let j = 0; j < length; j += 1) {
      if (bytes[i + j] !== text.charCodeAt(j)) { match = false; break; }
    }
    if (match) return i;
  }
  return -1;
}

/** 从字节流里按小端读出 4 字节无符号整数 */
function readUint32LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

/** 从字节流里按大端读出 4 字节无符号整数（MP4 原子长度为大端） */
function readUint32BE(bytes, offset) {
  return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

// MP3 帧头查表（避免在循环里反复新建数组）
const MP3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MP3_SAMPLE_RATES = [44100, 48000, 32000, 0];

/**
 * 解析 FLAC 文件头的 STREAMINFO 块（固定为第一个元数据块）。
 * 位域排布：采样率 20bit | 声道数 3bit | 位深 5bit | 总样本数 36bit。
 * @returns {{sampleRate:number, channels:number, bits:number, totalSamples:number} | null}
 */
function parseFlacStreamInfo(bytes) {
  const p = 8; // 跳过 4 字节 'fLaC' + 4 字节块头
  if (bytes.length < p + 34) return null;
  return {
    sampleRate: (bytes[p + 10] << 12) | (bytes[p + 11] << 4) | (bytes[p + 12] >> 4),
    channels: ((bytes[p + 12] >> 1) & 0x07) + 1,
    bits: (((bytes[p + 12] & 0x01) << 4) | (bytes[p + 13] >> 4)) + 1,
    totalSamples: ((bytes[p + 13] & 0x0f) * 4294967296) + readUint32BE(bytes, p + 14)
  };
}

/**
 * 解析 Vorbis Comment 块（FLAC / OGG / Opus 通用）。
 * 结构：4 字节 vendor 长度 + vendor + 4 字节条目数 + N ×(4 字节长度 + KEY=VALUE)
 */
function parseVorbisComment(bytes, offset) {
  const result = {};
  if (offset < 0 || offset + 4 > bytes.length) return result;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = offset;
  const vendorLength = view.getUint32(p, true);
  p += 4 + vendorLength;
  if (p + 4 > bytes.length) return result;
  const count = view.getUint32(p, true);
  p += 4;
  for (let i = 0; i < count && p + 4 <= bytes.length; i += 1) {
    const len = view.getUint32(p, true);
    p += 4;
    if (p + len > bytes.length) break;
    const entry = decodeTextBuffer(bytes.subarray(p, p + len));
    p += len;
    const eq = entry.indexOf('=');
    if (eq < 0) continue;
    const key = entry.slice(0, eq).trim().toUpperCase();
    const value = entry.slice(eq + 1).trim();
    if (!value) continue;
    if (key === 'TITLE' && !result.title) result.title = value;
    if ((key === 'ARTIST' || key === 'ALBUMARTIST' || key === 'PERFORMER') && !result.artist) result.artist = value;
    if (key === 'ALBUM' && !result.album) result.album = value;
    if (LYRICS_KEYS.includes(key) && !result.lyricsText) result.lyricsText = value;
    if (key === 'REPLAYGAIN_TRACK_GAIN' && !result.replayGain) {
      const db = parseFloat(value);
      if (Number.isFinite(db)) result.replayGain = db;
    }
    if (key === 'METADATA_BLOCK_PICTURE' && !result.artwork) {
      try {
        const binary = atob(value);
        const picture = new Uint8Array(binary.length);
        for (let k = 0; k < binary.length; k += 1) picture[k] = binary.charCodeAt(k);
        const url = pictureBlockToUrl(picture);
        if (url) result.artwork = url;
      } catch {}
    }
  }
  return result;
}

/** FLAC / OGG / Opus 标签，包含封面与歌词 */
async function readVorbisTags(file) {
  if (!/\.(flac|ogg|oga|opus)$/i.test(file.name)) return {};
  const bytes = new Uint8Array(await file.slice(0, 8 * 1024 * 1024).arrayBuffer());
  const result = {};
  const isFlac = String.fromCharCode(...bytes.subarray(0, 4)) === 'fLaC';
  if (isFlac) {
    // FLAC：遍历元数据块，type 4 = VORBIS_COMMENT，type 6 = PICTURE
    let p = 4;
    while (p + 4 <= bytes.length) {
      const flag = bytes[p];
      const length = (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
      const type = flag & 0x7f;
      const block = bytes.subarray(p + 4, p + 4 + length);
      if (type === 4) Object.assign(result, parseVorbisComment(block, 0));
      if (type === 6 && !result.artwork) {
        const url = pictureBlockToUrl(block);
        if (url) result.artwork = url;
      }
      if (flag & 0x80) break; // 最高位为 1 表示最后一个块
      p += 4 + length;
    }
    return result;
  }
  // OGG / Opus：先找 OpusTags，再找 vorbis 注释头
  let offset = findBytes(bytes, 'OpusTags');
  if (offset >= 0) offset += 8;
  else {
    offset = findBytes(bytes, '\u0003vorbis');
    if (offset >= 0) offset += 7;
  }
  if (offset < 0) return {};
  return parseVorbisComment(bytes, offset);
}

/** MP4 / M4A 原子：©nam 标题、©ART 歌手、©alb 专辑、©lyr 歌词、covr 封面 */
async function readMp4Tags(file) {
  if (!/\.(m4a|mp4|aac|alac)$/i.test(file.name)) return {};
  const bytes = new Uint8Array(await file.slice(0, 8 * 1024 * 1024).arrayBuffer());
  const result = {};
  // 单次扫描所有需要的原子，避免对大文件反复全文搜索
  for (let i = 4; i + 4 <= bytes.length; i += 1) {
    const first = bytes[i];
    if (first !== 0xa9 && first !== 0x61 && first !== 0x63) continue;
    const fourcc = String.fromCharCode(first, bytes[i + 1], bytes[i + 2], bytes[i + 3]);
    const key = MP4_TAG_ATOMS[fourcc];
    if (!key || result[key]) continue;
    // 原子后面紧跟一个 'data' 子原子，限制在 96 字节内查找
    const dataAt = findBytes(bytes, 'data', i + 4, i + 96);
    if (dataAt < 4) continue;
    const dataSize = readUint32BE(bytes, dataAt - 4);
    const dataType = readUint32BE(bytes, dataAt + 4);
    const payloadStart = dataAt + 12;
    const payloadEnd = dataSize ? Math.min(dataAt - 4 + dataSize, bytes.length) : bytes.length;
    if (payloadStart >= payloadEnd) continue;
    const payload = bytes.subarray(payloadStart, payloadEnd);
    if (key === 'artwork') {
      result.artwork = bytesToDataUrl(payload, dataType === 14 ? 'image/png' : 'image/jpeg');
    } else {
      const value = decodeTextBuffer(payload).replace(/\0/g, '').trim();
      if (value) result[key] = value;
    }
  }
  return result;
}

/** WAV 的 RIFF INFO 标签（INAM / IART / IPRD） */
async function readWavTags(file) {
  if (!/\.wav$/i.test(file.name)) return {};
  const bytes = new Uint8Array(await file.slice(0, 2 * 1024 * 1024).arrayBuffer());
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF') return {};
  const readChunk = fourcc => {
    const at = findBytes(bytes, fourcc);
    if (at < 0) return '';
    const size = readUint32LE(bytes, at + 4);
    if (size <= 0 || at + 8 + size > bytes.length) return '';
    return decodeTextBuffer(bytes.subarray(at + 8, at + 8 + size)).replace(/\0/g, '').trim();
  };
  const result = { title: readChunk('INAM'), artist: readChunk('IART'), album: readChunk('IPRD') };
  Object.keys(result).forEach(key => { if (!result[key]) delete result[key]; });
  return result;
}

/**
 * ID3 SYLT：同步歌词帧（自带时间戳）。
 * 头部 6 字节为 编码 + 语言(3) + 时间戳格式 + 内容类型，其后是
 * [文本 + 0 终止符][4 字节时间戳] 的重复序列。
 */
function parseSyncLyrics(raw) {
  const encoding = raw[0];
  const timed = [];
  let p = 6;
  const width = (encoding === 1 || encoding === 2) ? 2 : 1;
  while (p + width + 4 <= raw.length) {
    let textEnd = p;
    if (width === 2) {
      while (textEnd + 1 < raw.length && !(raw[textEnd] === 0 && raw[textEnd + 1] === 0)) textEnd += 2;
    } else {
      while (textEnd < raw.length && raw[textEnd] !== 0) textEnd += 1;
    }
    const text = decodeTextBuffer(raw.subarray(p, textEnd)).trim();
    const timeStart = textEnd + width;
    if (timeStart + 4 > raw.length) break;
    const stamp = readUint32BE(raw, timeStart);
    if (text) timed.push({ time: Math.max(0, stamp) / 1000, text });
    p = timeStart + 4;
  }
  return timed.sort((a, b) => a.time - b.time);
}

/**
 * ID3 TXXX：形如「描述\0值」的用户自定义文本，部分音乐把歌词放在这里。
 * @returns {{description: string, lyrics?: string, value?: string} | null}
 */
function parseUserTextFrame(raw, decodedValue) {
  const encoding = raw[0];
  const payload = raw.subarray(1);
  const width = (encoding === 1 || encoding === 2) ? 2 : 1;
  let split = -1;
  if (width === 2) {
    for (let i = 0; i + 1 < payload.length; i += 2) {
      if (payload[i] === 0 && payload[i + 1] === 0) { split = i; break; }
    }
  } else {
    split = payload.indexOf(0);
  }
  if (split < 0) return null;
  const description = decodeTextBuffer(payload.subarray(0, split)).replace(/\0/g, '').trim().toUpperCase();
  const value = decodeTextBuffer(payload.subarray(split + width)).replace(/\0/g, '').trim() || decodedValue || '';
  if (LYRICS_KEYS.includes(description)) return { description, lyrics: value };
  return { description, value };
}

// 解析一段完整的 ID3v2 数据（从 'ID3' 头部开始）
function parseId3Block(bytes, result) {
  if (bytes.length < 10 || String.fromCharCode(bytes[0], bytes[1], bytes[2]) !== 'ID3') return result;
  const version = bytes[3];
  // ID3v2 头部长度用「同步安全整数」编码：每字节只有低 7 位有效
  const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
  const end = Math.min(10 + size, bytes.length);
  return parseId3Frames(bytes, 10, end, version, result);
}

/** 逐个解析 ID3v2 帧，把命中的字段写进 result */
function parseId3Frames(bytes, start, end, version, result) {
  let offset = start;
  while (offset + 10 <= end) {
    const frameId = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    if (!/^[A-Z0-9]{4}$/.test(frameId)) break;
    // v2.4 的帧长同样是同步安全整数；v2.2 / v2.3 是普通大端整数
    const frameSize = version === 4
      ? ((bytes[offset + 4] & 0x7f) << 21) | ((bytes[offset + 5] & 0x7f) << 14) | ((bytes[offset + 6] & 0x7f) << 7) | (bytes[offset + 7] & 0x7f)
      : readUint32BE(bytes, offset + 4);
    if (frameSize <= 0 || offset + 10 + frameSize > bytes.length) break;

    const encoding = bytes[offset + 10];
    const rawPayload = bytes.subarray(offset + 10, offset + 10 + frameSize);
    const payload = bytes.subarray(offset + 11, offset + 10 + frameSize);
    let value = '';
    try {
      const decoder = encoding === 1 || encoding === 2
        ? new TextDecoder(encoding === 1 ? 'utf-16' : 'utf-16be')
        : new TextDecoder(encoding === 3 ? 'utf-8' : 'windows-1252');
      value = decoder.decode(payload).replace(/\0/g, '');
    } catch {}

    if (frameId === 'APIC' || frameId === 'PIC') {
      const artwork = parseAttachedPicture(rawPayload, frameId);
      if (artwork) result.artwork = artwork;
    }
    if (frameId === 'USLT') {
      // USLT 结构：编码(1) + 语言(3) + 内容描述(以 0 结尾) + 歌词正文
      const lyricEncoding = rawPayload[0];
      const lyricPos = 4;
      let lyricEnd = -1;
      if (lyricEncoding === 1 || lyricEncoding === 2) {
        for (let i = lyricPos; i < rawPayload.length - 1; i += 2) {
          if (rawPayload[i] === 0 && rawPayload[i + 1] === 0) { lyricEnd = i + 2; break; }
        }
      } else {
        lyricEnd = rawPayload.indexOf(0, lyricPos) + 1;
      }
      if (lyricEnd > lyricPos) {
        try {
          const decoder = new TextDecoder(lyricEncoding === 1 ? 'utf-16' : lyricEncoding === 2 ? 'utf-16be' : lyricEncoding === 3 ? 'utf-8' : 'windows-1252');
          const lyricText = decoder.decode(rawPayload.subarray(lyricEnd)).replace(/\0/g, '').trim();
          if (lyricText) result.lyrics = parseLyrics(lyricText);
        } catch {}
      }
    }
    if (frameId === 'SYLT') {
      const timed = parseSyncLyrics(rawPayload);
      if (timed.length) result.lyrics = timed;
    }
    if (frameId === 'TXXX') {
      const described = parseUserTextFrame(rawPayload, value);
      if (described?.lyrics) result.lyrics = parseLyrics(described.lyrics);
    }
    if (frameId === 'TIT2' && !result.title) result.title = value.trim();
    if (frameId === 'TPE1' && !result.artist) result.artist = value.trim();
    if (frameId === 'TALB' && !result.album) result.album = value.trim();
    offset += 10 + frameSize;
  }
  return result;
}

/** MP3 的 ID3v2 标签（含尾部标签兜底扫描） */
async function readId3(file) {
  if (!/\.mp3$/i.test(file.name)) return {};
  const fileSize = Number(file.size) || 0;
  const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  const result = {};
  const hasHeadTag = head.length >= 10 && String.fromCharCode(head[0], head[1], head[2]) === 'ID3';
  if (hasHeadTag) {
    const tagSize = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
    const readLimit = Math.min(10 + tagSize + 16, 16 * 1024 * 1024, fileSize || Infinity);
    const bytes = new Uint8Array(await file.slice(0, readLimit).arrayBuffer());
    parseId3Block(bytes, result);
  }
  // 有些工具把 ID3v2 标签写在文件末尾，再补一次尾部扫描
  if (!result.lyricsText && !result.lyrics && fileSize > 128) {
    const tailSize = Math.min(4 * 1024 * 1024, fileSize);
    const tail = new Uint8Array(await file.slice(fileSize - tailSize).arrayBuffer());
    const at = findBytes(tail, 'ID3');
    if (at >= 0) {
      const tailed = {};
      parseId3Block(tail.subarray(at), tailed);
      if (tailed.lyricsText || tailed.lyrics) {
        result.lyricsText = tailed.lyricsText;
        if (tailed.lyrics) result.lyrics = tailed.lyrics;
      }
    }
  }
  return result;
}

/** 把图片字节转成 data: URL（分块拼接，避免超长参数把调用栈打爆） */
function bytesToDataUrl(bytes, mime = 'image/jpeg') {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mime || 'image/jpeg'};base64,${btoa(binary)}`;
}

/** 解析 ID3 的 APIC（v2.3+）/ PIC（v2.2）帧，返回封面 data: URL */
function parseAttachedPicture(raw, frameId) {
  if (!raw || raw.length < 8) return '';
  const encoding = raw[0];
  let position = 1;
  let mime = 'image/jpeg';

  if (frameId === 'PIC') {
    const format = String.fromCharCode(...raw.subarray(position, position + 3)).toUpperCase();
    position += 3;
    mime = format === 'PNG' ? 'image/png' : 'image/jpeg';
  } else {
    const mimeEnd = raw.indexOf(0, position);
    if (mimeEnd < 0) return '';
    mime = String.fromCharCode(...raw.subarray(position, mimeEnd)) || 'image/jpeg';
    position = mimeEnd + 1;
  }

  position += 1; // 跳过图片类型字节
  let descriptionEnd = -1;
  if (encoding === 1 || encoding === 2) {
    for (let i = position; i < raw.length - 1; i += 2) {
      if (raw[i] === 0 && raw[i + 1] === 0) {
        descriptionEnd = i + 2;
        break;
      }
    }
  } else {
    descriptionEnd = raw.indexOf(0, position) + 1;
  }
  if (descriptionEnd <= position) descriptionEnd = position;
  const image = raw.subarray(descriptionEnd);
  return image.length ? bytesToDataUrl(image, mime) : '';
}

/** FLAC 的 METADATA_BLOCK_PICTURE 结构 -> data: URL */
function pictureBlockToUrl(block) {
  if (block.length < 32) return '';
  let p = 4; // 跳过图片类型（4 字节）
  const mimeLength = readUint32BE(block, p);
  p += 4;
  if (p + mimeLength + 4 > block.length) return '';
  const mime = String.fromCharCode(...block.subarray(p, p + mimeLength));
  p += mimeLength;
  const descLength = readUint32BE(block, p);
  p += 4 + descLength + 16; // 跳过描述与宽/高/深/色数（各 4 字节）
  if (p + 4 > block.length) return '';
  const dataLength = readUint32BE(block, p);
  p += 4;
  const image = block.subarray(p, p + dataLength);
  return image.length ? bytesToDataUrl(image, mime || 'image/jpeg') : '';
}

/**
 * 解析 LRC 文本为 [{ time, text, words? }]。
 * 支持：标准 [mm:ss.xx]、多时间标签一行多唱、逐字卡拉OK（<mm:ss.xx> 或行内多时间）、
 * [offset:] 全局偏移、纯文本无时间轴（按每行 5 秒铺开）。
 * 时间轴为空时返回按行生成的兜底时间轴，保证歌词界面仍可滚动。
 */
function parseLyrics(text) {
  const lines = String(text).replace(/\r/g,'').split('\n');
  const timed = [];
  const plain = [];
  const timePattern = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  // 增强型歌词的逐字时间标签 <mm:ss.xx>，显示时要去掉
  const wordPattern = /<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g;
  // LRC 偏移量：[offset:500] 表示歌词整体提前 0.5 秒
  const offsetMatch = /\[offset:\s*([+-]?\d+)\s*\]/i.exec(text);
  const offset = offsetMatch ? Number(offsetMatch[1]) / 1000 : 0;
  const toSeconds = match => {
    const fraction = match[3] ? Number(`0.${match[3]}`) : 0;
    return Number(match[1]) * 60 + Number(match[2]) + fraction;
  };

  lines.forEach(line => {
    const matches = [...line.matchAll(timePattern)];
    const copy = line.replace(timePattern, '').replace(wordPattern, '').trim();
    if (!matches.length) {
      if (copy) plain.push(copy);
      return;
    }
    if (!copy) {
      // 只有时间标签的空行也保留为间隔（显示为音符）
      timed.push({ time: toSeconds(matches[0]), text: '♪' });
      return;
    }
    // 逐字卡拉OK格式：[t1]字[t2]字[t3]字 —— 只取第一个时间，避免同一句重复出现
    const firstEnd = matches[0].index + matches[0][0].length;
    const inlineStyled = matches.length > 1 && line.slice(firstEnd, matches[1].index).trim().length > 0;
    if (inlineStyled) {
      // 保留逐字时间轴，播放器可以做逐字点亮效果
      const words = [];
      matches.forEach((match, i) => {
        const wordStart = match.index + match[0].length;
        const wordEnd = i + 1 < matches.length ? matches[i + 1].index : line.length;
        const wordText = line.slice(wordStart, wordEnd).replace(wordPattern, '');
        if (wordText) words.push({ time: toSeconds(match), text: wordText });
      });
      timed.push({ time: toSeconds(matches[0]), text: copy, words: words.length > 1 ? words : undefined });
      return;
    }
    // 标准多时间标签：[t1][t2]同一句 —— 每个时间点都要出现
    matches.forEach(match => timed.push({ time: toSeconds(match), text: copy }));
  });

  let result;
  if (timed.length) {
    result = timed.sort((a, b) => a.time - b.time);
  } else {
    result = plain.map((text, index) => ({ time: index * 5, text }));
  }
  // 去掉连续重复的同一句（卡拉OK歌词常见）
  const deduped = [];
  result.forEach(line => {
    const previous = deduped[deduped.length - 1];
    if (previous && previous.text === line.text && line.text !== '♪') return;
    deduped.push(line);
  });
  if (offset) {
    deduped.forEach(line => { line.time = Math.max(0, line.time - offset); });
  }
  // 双语歌词：原文一行、译文一行，两行**共用同一个时间戳**
  // （网易云 / QQ 音乐导出的翻译 LRC 基本都是这个写法）。
  // 这里把「时间戳和前一行完全相同」的那行标记成 translation —— 解析层只负责打标，
  // 不做取舍，显不显示交给上层按偏好决定，这样开关切换不用重新解析歌词。
  // 排序用的是 Array.prototype.sort（V8 起稳定排序），同一时间戳的多行会保持文件里的
  // 先后顺序，而原文总写在译文前面，所以「保留第一个、标记后面的」是安全的。
  let previousTime = null;
  deduped.forEach(line => {
    if (line.text === '♪') return;              // 纯时间戳的空行是间隔，不参与判断
    if (previousTime !== null && Math.abs(line.time - previousTime) < 1e-3) {
      line.translation = true;
      return;                                   // 译文行不更新基准时间，连着几行译文也能全标上
    }
    previousTime = line.time;
  });
  return deduped;
}

function splitFileName(name) {
  const base = String(name)
    .replace(/\.[^.]+$/, '')
    .replace(/^\d+\s*[._\-、]\s*/, '')
    .trim();
  const hasCjk = /[\u4e00-\u9fff]/.test(base);
  const spaced = base.split(/\s+[-–—]\s+/);
  if (spaced.length >= 2 && spaced[0].trim() && spaced[1].trim()) {
    return { artist: spaced[0].trim(), title: spaced.slice(1).join(' - ').trim() };
  }
  if (hasCjk) {
    const bare = base.split(/[-–—]/);
    if (bare.length === 2 && bare[0].trim() && bare[1].trim()) {
      return { artist: bare[0].trim(), title: bare[1].trim() };
    }
  }
  return { artist: '', title: base };
}
// 直接从文件头解析时长，避免逐个用播放器探测（自动扫描时更快）
async function readDuration(file, filePath) {
  const name = file?.name || filePath || '';
  if (/\.(flac|ogg|oga|opus)$/i.test(name)) return readVorbisDuration(file, name);
  if (/\.wav$/i.test(name)) return readWavDuration(file);
  if (/\.(m4a|mp4|aac|alac)$/i.test(name)) return readMp4Duration(file);
  if (/\.mp3$/i.test(name)) return readMp3Duration(file);
  return 0;
}

/** Ogg / FLAC / Opus 时长：优先用 STREAMINFO，其次用最后一页的 granule 位置 */
async function readVorbisDuration(file, name) {
  const bytes = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
  if (String.fromCharCode(...bytes.subarray(0, 4)) === 'fLaC') {
    const info = parseFlacStreamInfo(bytes);
    return info && info.sampleRate ? info.totalSamples / info.sampleRate : 0;
  }
  // Ogg：时长 = 最后一页的 granule position / 采样率
  const tail = new Uint8Array(await file.slice(Math.max(0, (file.size || bytes.length) - 65536)).arrayBuffer());
  const opusHead = findBytes(bytes, 'OpusHead');
  const vorbisHead = opusHead >= 0 ? -1 : findBytes(bytes, '\u0001vorbis');
  // Opus 固定 48kHz；Vorbis 采样率写在标识头里
  const rate = opusHead >= 0
    ? 48000
    : (vorbisHead >= 0 ? readUint32LE(bytes, vorbisHead + 12) : 48000);
  for (let i = tail.length - 14; i >= 0; i -= 1) {
    if (tail[i] === 0x4f && tail[i + 1] === 0x67 && tail[i + 2] === 0x67 && tail[i + 3] === 0x53) {
      const low = readUint32LE(tail, i + 6);
      const high = readUint32LE(tail, i + 10);
      const granule = high * 4294967296 + low;
      if (rate && granule) return granule / rate;
    }
  }
  return 0;
}

/** WAV 时长 = data 块字节数 / 字节率 */
async function readWavDuration(file) {
  const bytes = new Uint8Array(await file.slice(0, 1024 * 1024).arrayBuffer());
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF') return 0;
  const fmt = findBytes(bytes, 'fmt ');
  const data = findBytes(bytes, 'data');
  if (fmt < 0 || data < 0) return 0;
  // fmt 块：0-3 'fmt '，4-7 块大小，8-9 编码，10-11 声道，12-15 采样率，16-19 字节率
  const byteRate = readUint32LE(bytes, fmt + 16);
  const dataSize = readUint32LE(bytes, data + 4);
  return byteRate ? dataSize / byteRate : 0;
}

/** MP4 / M4A 时长：读 mvhd 盒的 timescale 与 duration（大端，v0/v1 两套偏移） */
async function readMp4Duration(file) {
  const bytes = new Uint8Array(await file.slice(0, 4 * 1024 * 1024).arrayBuffer());
  const at = findBytes(bytes, 'mvhd');
  if (at < 0) return 0;
  const version = bytes[at + 4];
  const offset = version === 1 ? 24 : 16;
  const timescale = readUint32BE(bytes, at + offset);
  const duration = readUint32BE(bytes, at + offset + 4);
  return timescale ? duration / timescale : 0;
}

/** MP3 时长：CBR 估算 = 音频字节数 × 8 / 比特率 */
async function readMp3Duration(file) {
  const head = new Uint8Array(await file.slice(0, 16 * 1024).arrayBuffer());
  let offset = 0;
  if (String.fromCharCode(...head.subarray(0, 3)) === 'ID3') {
    offset = 10 + (((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f));
  }
  for (let i = offset; i + 4 < head.length; i += 1) {
    if (head[i] !== 0xff || (head[i + 1] & 0xe0) !== 0xe0) continue;
    const versionBits = (head[i + 1] >> 3) & 0x03;
    const layerBits = (head[i + 1] >> 1) & 0x03;
    if (versionBits === 1 || layerBits === 0) continue;
    const bitrate = MP3_BITRATES[(head[i + 2] >> 4) & 0x0f];
    const rateIndex = (head[i + 2] >> 2) & 0x03;
    if (!bitrate || !MP3_SAMPLE_RATES[rateIndex]) continue;
    const audioBytes = Math.max(0, (Number(file.size) || head.length) - offset);
    return (audioBytes * 8) / (bitrate * 1000);
  }
  return 0;
}

/** 读取技术参数：采样率 / 声道 / 位深（用于详情面板） */
async function readTechInfo(file, filePath) {
  const name = file?.name || filePath || '';
  try {
    if (/\.(flac|ogg|oga|opus)$/i.test(name)) {
      const bytes = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
      if (String.fromCharCode(...bytes.subarray(0, 4)) === 'fLaC') {
        const info = parseFlacStreamInfo(bytes);
        if (info) return { sampleRate: info.sampleRate, channels: info.channels, bits: info.bits };
      }
      const opusHead = findBytes(bytes, 'OpusHead');
      if (opusHead >= 0) return { sampleRate: 48000, channels: bytes[opusHead + 9] || 2, bits: 16 };
      const vorbisHead = findBytes(bytes, '\u0001vorbis');
      if (vorbisHead >= 0) {
        return { channels: bytes[vorbisHead + 11] || 2, sampleRate: readUint32LE(bytes, vorbisHead + 12) };
      }
    }
    if (/\.wav$/i.test(name)) {
      const bytes = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
      const fmt = findBytes(bytes, 'fmt ');
      if (fmt >= 0) {
        // fmt 块：声道在 10-11，采样率在 12-15，位深在 22-23
        return {
          channels: bytes[fmt + 10] | (bytes[fmt + 11] << 8),
          sampleRate: readUint32LE(bytes, fmt + 12),
          bits: bytes[fmt + 22] | (bytes[fmt + 23] << 8)
        };
      }
    }
    if (/\.mp3$/i.test(name)) {
      const bytes = new Uint8Array(await file.slice(0, 8192).arrayBuffer());
      for (let i = 0; i + 4 < bytes.length; i += 1) {
        if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) continue;
        const versionBits = (bytes[i + 1] >> 3) & 0x03;
        const rateIndex = (bytes[i + 2] >> 2) & 0x03;
        // MPEG1 / 2 / 2.5 的采样率缩放系数
        const scale = versionBits === 3 ? 1 : (versionBits === 2 ? .5 : .25);
        const channels = ((bytes[i + 3] >> 6) & 0x03) === 3 ? 1 : 2;
        if (MP3_SAMPLE_RATES[rateIndex]) {
          return { sampleRate: Math.round(MP3_SAMPLE_RATES[rateIndex] * scale), channels, bits: 16 };
        }
      }
    }
  } catch (error) {}
  return {};
}

  return {
    decodeTextBuffer,
    findBytes,
    parseVorbisComment,
    readVorbisTags,
    readMp4Tags,
    readWavTags,
    parseSyncLyrics,
    parseUserTextFrame,
    readId3,
    parseAttachedPicture,
    bytesToDataUrl,
    pictureBlockToUrl,
    parseLyrics,
    splitFileName,
    readDuration,
    readTechInfo
  };
});
