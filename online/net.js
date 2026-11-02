'use strict';
/**
 * 在线音源底层工具：HTTP 请求、加密签名、文本解码。
 * 只在主进程使用（渲染进程开启沙箱，拿不到 Node / 网络）。
 */
const crypto = require('crypto');

const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const UA_MOBILE = 'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const UA_KUGOU_APP = 'Android712-AndroidPhone-11451-269-0-kuyuexingqiu-categorySearch-wifi';

const md5 = value => crypto.createHash('md5').update(value).digest('hex');

/**
 * 统一的 fetch 封装：超时、JSON 解析、错误归一。
 * 任何失败都抛出带可读信息的 Error，由上层转成界面提示。
 */
async function request(url, options = {}) {
  const { timeout = 12000, ...rest } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...rest, signal: controller.signal });
    const text = await response.text();
    return { response, text };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('网络请求超时，请检查网络或代理');
    throw new Error(`网络请求失败：${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, options = {}) {
  const { text } = await request(url, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('接口返回了无法解析的内容');
  }
}

async function postJson(url, body, options = {}) {
  const { text } = await request(url, {
    ...options,
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('接口返回了无法解析的内容');
  }
}

/* ------------------------------ 网易云 weapi ------------------------------ */
const NE_IV = Buffer.from('0102030405060708');
const NE_PRESET = Buffer.from('0CoJUm6Qyw8W8jud');
const NE_MODULUS = '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';

const aesEncrypt = (buffer, key) => {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, NE_IV);
  return Buffer.concat([cipher.update(buffer), cipher.final()]).toString('base64');
};

/** wapi 的 RSA：把随机密钥倒序后做模幂，输出 256 位十六进制 */
function rsaEncrypt(text) {
  const reversed = Buffer.from(text.split('').reverse().join(''));
  let base = BigInt('0x' + reversed.toString('hex')) % BigInt('0x' + NE_MODULUS);
  let result = 1n;
  let exponent = BigInt('0x010001');
  const modulus = BigInt('0x' + NE_MODULUS);
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % modulus;
    base = (base * base) % modulus;
    exponent >>= 1n;
  }
  return result.toString(16).padStart(256, '0');
}

/** weapi 参数加密：AES 两次 + RSA，返回可直接提交的表单体 */
function weapi(payload) {
  const text = JSON.stringify(payload);
  const secret = crypto.randomBytes(8).toString('hex').slice(0, 16);
  const params = aesEncrypt(Buffer.from(aesEncrypt(Buffer.from(text), NE_PRESET)), Buffer.from(secret));
  return new URLSearchParams({ params, encSecKey: rsaEncrypt(secret) }).toString();
}

/* ------------------------------ 酷狗签名 ------------------------------ */
const KUGOU_SECRET = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';

/** 酷狗 web 接口签名：参数字典序拼接，前后各加一段固定密钥再 md5 */
function kugouSign(params) {
  const raw = KUGOU_SECRET + Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('') + KUGOU_SECRET;
  return md5(raw);
}

/** 把 Cookie 字符串解析成对象，便于按名取值 */
function parseCookie(cookie) {
  const jar = {};
  String(cookie || '').split(';').forEach(part => {
    const index = part.indexOf('=');
    if (index > 0) jar[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  });
  return jar;
}

/** 把毫秒格式化成 0:00 */
function mmss(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** 合并原文 / 译文两段 LRC：同时间戳的行会被歌词解析层自动识别成译文 */
function mergeLyrics(original, translated) {
  const clean = value => String(value || '').replace(/\r/g, '').trim();
  const main = clean(original);
  const extra = clean(translated);
  if (!main) return '';
  if (!extra) return main;
  return `${main}\n${extra}`;
}

module.exports = {
  UA_DESKTOP, UA_MOBILE, UA_KUGOU_APP,
  md5, request, getJson, postJson,
  weapi, kugouSign, parseCookie, mmss, mergeLyrics
};
