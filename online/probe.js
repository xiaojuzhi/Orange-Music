'use strict';
/**
 * 音频流「实听参数」探测：只读文件头（Range 请求前 96KB），解析出真实格式、
 * 位深、采样率。平台的档位名（无损 / Hi-Res / 母带）只是营销标签，同一档位
 * 可能给 16bit/44.1k，也可能给 24bit/96k，界面上要显示真实值只能看文件头。
 */
const HEAD_BYTES = 96 * 1024;

/** 读文件头：支持 Range 的 CDN 只回前 96KB；不支持时读到够数就主动断开 */
async function readHead(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { Range: `bytes=0-${HEAD_BYTES - 1}` },
      signal: controller.signal
    });
    if (!res.ok) return null;
    let buf = null;
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      while (total < HEAD_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) {
          chunks.push(Buffer.from(value));
          total += value.length;
        }
      }
      // 服务器忽略了 Range（返回 200 全量）时，读够就掐断，别把整首歌拖下来
      try { await reader.cancel(); } catch {}
      buf = Buffer.concat(chunks);
    } else {
      buf = Buffer.from(await res.arrayBuffer());
    }
    return { buf: buf.subarray(0, HEAD_BYTES), contentType: res.headers.get('content-type') || '' };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** FLAC: 'fLaC' + STREAMINFO（采样率 20bit | 声道 3bit | 位深 5bit | 总样本 36bit） */
function parseFlac(buf) {
  if (buf.length < 42 || buf.toString('latin1', 0, 4) !== 'fLaC') return null;
  const p = 8;
  const sampleRate = (buf[p + 10] << 12) | (buf[p + 11] << 4) | (buf[p + 12] >> 4);
  const channels = ((buf[p + 12] >> 1) & 0x07) + 1;
  const bits = (((buf[p + 12] & 0x01) << 4) | (buf[p + 13] >> 4)) + 1;
  if (!sampleRate) return null;
  return { format: 'FLAC', bits, sampleRate, channels };
}

/** WAV: RIFF/WAVE + fmt 块（声道 10-11、采样率 12-15、位深 22-23） */
function parseWav(buf) {
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null;
  const fmt = buf.indexOf('fmt ');
  if (fmt < 0 || fmt + 24 > buf.length) return null;
  const bits = buf.readUInt16LE(fmt + 22);
  const sampleRate = buf.readUInt32LE(fmt + 12);
  if (!sampleRate) return null;
  return { format: 'WAV', bits: bits || 16, sampleRate, channels: buf.readUInt16LE(fmt + 10) || 2 };
}

const MP3_RATES = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000]   // MPEG2.5
};

/** MP3: 跳过 ID3v2 后找第一个有效帧头 */
function parseMp3(buf) {
  let start = 0;
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    start = 10 + size + (buf[5] & 0x10 ? 10 : 0);
  }
  for (let i = Math.max(0, start); i + 4 <= buf.length; i += 1) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const version = (buf[i + 1] >> 3) & 0x03;      // 3=MPEG1 2=MPEG2 0=MPEG2.5
    const rates = MP3_RATES[version];
    const rateIndex = (buf[i + 2] >> 2) & 0x03;
    if (!rates || rateIndex === 3) continue;
    const sampleRate = rates[rateIndex];
    if (!sampleRate) continue;
    const channelMode = (buf[i + 3] >> 6) & 0x03;
    return { format: version === 3 ? 'MP3' : 'MP3', bits: 16, sampleRate, channels: channelMode === 3 ? 1 : 2 };
  }
  return null;
}

/**
 * MP4 / M4A：mdhd 里拿 timescale（= 采样率），alac 的 config 里拿位深。
 * AAC 解码输出固定 16bit，没有「源位深」概念，按 16 报。
 */
function parseMp4(buf) {
  const text = buf.toString('latin1');
  if (!text.includes('ftyp') && !text.includes('moov')) return null;
  const mdhd = text.indexOf('mdhd');
  let sampleRate = 0;
  if (mdhd >= 0 && mdhd + 28 <= buf.length) {
    const version = buf[mdhd + 4];
    sampleRate = version === 1 ? buf.readUInt32BE(mdhd + 24) : buf.readUInt32BE(mdhd + 16);
  }
  const isAlac = text.includes('alac');
  let bits = isAlac ? 0 : 16;
  if (isAlac) {
    // ALACSpecificConfig: version/flags(4) frameLength(4) compatible(1) bitDepth(1) …
    for (let at = text.indexOf('alac'); at > 0; at = text.indexOf('alac', at + 4)) {
      const value = buf[at + 13];
      if (value >= 8 && value <= 32) { bits = value; break; }
    }
  }
  if (!sampleRate && !bits) return null;
  return { format: isAlac ? 'ALAC' : 'M4A', bits: bits || 16, sampleRate, channels: 2 };
}

function parseByContentType(type) {
  if (/flac/i.test(type)) return 'FLAC';
  if (/mpeg|mp3/i.test(type)) return 'MP3';
  if (/mp4|m4a|aac/i.test(type)) return 'M4A';
  if (/wav/i.test(type)) return 'WAV';
  if (/ogg|opus/i.test(type)) return 'OGG';
  return '';
}

function formatLabel(format) {
  const value = String(format || '').trim().toUpperCase();
  if (!value || value === 'UNKNOWN') return '';
  if (value === 'AAC') return 'M4A';
  return value;
}

/**
 * 探测一首在线歌曲的真实播放参数。
 * 任何一步失败都返回 { format }（可能为空）而绝不抛错——播放不能被探测拖死。
 */
async function probeAudio(url, fallback = {}) {
  const guessFormat = formatLabel(fallback.type);
  const base = { format: guessFormat, bits: 0, sampleRate: 0, channels: 0, bitrate: Number(fallback.bitrate) || 0 };
  if (!url) return base;
  const head = await readHead(url);
  if (!head?.buf?.length) return base;
  const buf = head.buf;
  const parsed = parseFlac(buf) || parseWav(buf) || parseMp4(buf) || parseMp3(buf);
  if (parsed) {
    return {
      ...base,
      format: formatLabel(parsed.format) || guessFormat,
      bits: Number(parsed.bits) || 0,
      sampleRate: Number(parsed.sampleRate) || 0,
      channels: Number(parsed.channels) || 0
    };
  }
  return { ...base, format: guessFormat || formatLabel(parseByContentType(head.contentType)) };
}

module.exports = { probeAudio, formatLabel };
