'use strict';
// B 站原生搜索（不依赖 yt-dlp）：buvid3 → WBI 签名 → /x/web-interface/wbi/search/type。
// WBI 签名算法参考 yt-dlp（Unlicense，公有领域）yt_dlp/extractor/bilibili.py 的 _get_wbi_key / _sign_wbi，
// 用 JS 重写；混淆表与签名结果已用公开示例校验（见 tests/sources-bilibili.test.mjs）。
// 风控（HTTP 412 / code -352 / -412）时退避 60 秒并刷新 buvid3，调用方再退回 yt-dlp 搜索。
const crypto = require('node:crypto');

const API = 'https://api.bilibili.com';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const WEB_LICENSE = '版权归原作者，仅供学习参考';
const BUVID_TTL = 7 * 24 * 3600 * 1000;
const WBI_TTL = 10 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;

// WBI 混淆表（64 项，是 0..63 的一个排列）
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

const state = {
  buvid: null, // { b3, b4, at }
  wbi: null, // { imgKey, subKey, at }
  cooldownUntil: 0,
};

function resetState() {
  state.buvid = null;
  state.wbi = null;
  state.cooldownUntil = 0;
}

function getMixinKey(orig) {
  return MIXIN_KEY_ENC_TAB.map((n) => orig[n]).join('').slice(0, 32);
}

/** 生成带 wts 与 w_rid 的查询串（参数按键名排序，值里去掉 !'()*） */
function signWbi(params, imgKey, subKey, now = Date.now()) {
  const mixinKey = getMixinKey(String(imgKey) + String(subKey));
  const all = { ...params, wts: Math.round(now / 1000) };
  const query = Object.keys(all).sort().map((k) => {
    const v = String(all[k]).replace(/[!'()*]/g, '');
    return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
  }).join('&');
  const wRid = crypto.createHash('md5').update(query + mixinKey).digest('hex');
  return `${query}&w_rid=${wRid}`;
}

function keyFromUrl(u) {
  const name = String(u || '').split('/').pop() || '';
  return name.split('.')[0] || '';
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** "4:31" / "1:02:03" / 271 → 秒 */
function parseClock(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function toHttps(u) {
  if (!u || typeof u !== 'string') return null;
  if (u.startsWith('//')) return 'https:' + u;
  if (u.startsWith('http://')) return 'https://' + u.slice(7);
  return u;
}

function riskError(msg) {
  const e = new Error(msg || 'B 站暂时拒绝了搜索请求（风控），请过一分钟再试');
  e.code = 'BILI_RISK';
  return e;
}

function cookieHeader() {
  if (!state.buvid) return '';
  const parts = [`buvid3=${state.buvid.b3}`];
  if (state.buvid.b4) parts.push(`buvid4=${state.buvid.b4}`);
  return parts.join('; ');
}

async function getJson(fetchImpl, url, { signal, timeoutMs = 15000 } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res;
  try {
    res = await fetchImpl(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://search.bilibili.com/',
        Origin: 'https://search.bilibili.com',
        ...(state.buvid ? { Cookie: cookieHeader() } : {}),
      },
      signal: sig,
    });
  } catch (e) {
    if (signal && signal.aborted) { const c = new Error('已取消'); c.code = 'CANCELLED'; throw c; }
    if (timeout.aborted) throw new Error('B 站搜索超时，请检查网络');
    throw new Error('连不上 B 站，请检查网络');
  }
  if (res.status === 412) throw riskError();
  if (!res.ok) {
    const e = new Error(`B 站返回错误（HTTP ${res.status}）`);
    e.status = res.status;
    throw e;
  }
  try {
    return await res.json();
  } catch {
    throw new Error('B 站返回的数据无法解析');
  }
}

async function ensureBuvid(fetchImpl, opts) {
  if (state.buvid && Date.now() - state.buvid.at < BUVID_TTL) return state.buvid;
  const data = await getJson(fetchImpl, `${API}/x/frontend/finger/spi`, opts);
  const b3 = data && data.data && data.data.b_3;
  if (!b3) throw new Error('B 站初始化失败，请稍后再试');
  state.buvid = { b3: String(b3), b4: String((data.data && data.data.b_4) || ''), at: Date.now() };
  return state.buvid;
}

async function ensureWbiKeys(fetchImpl, opts) {
  if (state.wbi && Date.now() - state.wbi.at < WBI_TTL) return state.wbi;
  // 未登录时 nav 返回 code -101，但 wbi_img 仍然有效
  const data = await getJson(fetchImpl, `${API}/x/web-interface/nav`, opts);
  const img = data && data.data && data.data.wbi_img;
  const imgKey = keyFromUrl(img && img.img_url);
  const subKey = keyFromUrl(img && img.sub_url);
  if (!imgKey || !subKey) throw new Error('B 站搜索签名获取失败，请稍后再试');
  state.wbi = { imgKey, subKey, at: Date.now() };
  return state.wbi;
}

function mapVideo(item) {
  if (!item || item.type !== 'video') return null;
  const bvid = String(item.bvid || '').trim();
  const aid = item.aid || item.id;
  const vid = bvid || (aid ? `av${aid}` : '');
  if (!vid) return null;
  const url = bvid ? `https://www.bilibili.com/video/${bvid}` : `https://www.bilibili.com/video/av${aid}`;
  return {
    source: 'bilibili',
    id: `bilibili_${vid}`,
    title: stripHtml(item.title) || 'B 站视频',
    url,
    thumb: toHttps(item.pic),
    duration: parseClock(item.duration),
    width: null,
    height: null,
    author: stripHtml(item.author) || null,
    authorUrl: item.mid ? `https://space.bilibili.com/${item.mid}` : null,
    license: WEB_LICENSE,
    kind: 'video',
    reference: true,
  };
}

/**
 * B 站原生视频搜索。
 * @returns {Promise<WebResult[]>}
 * 出错时抛中文错误；风控时 err.code === 'BILI_RISK'。
 */
async function searchBilibili(query, limit = 8, { signal, fetchImpl = globalThis.fetch, now } = {}) {
  const q = String(query || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 100);
  if (!q) throw new Error('请输入搜索关键词');
  if (typeof fetchImpl !== 'function') throw new Error('当前环境不支持联网');
  if (Date.now() < state.cooldownUntil) throw riskError('B 站暂时限制了搜索（风控），请过一分钟再试');
  const n = Math.max(1, Math.min(30, Math.round(Number(limit) || 8)));
  const opts = { signal };
  try {
    await ensureBuvid(fetchImpl, opts);
    const keys = await ensureWbiKeys(fetchImpl, opts);
    const qs = signWbi({ search_type: 'video', keyword: q, page: 1 }, keys.imgKey, keys.subKey, now || Date.now());
    const data = await getJson(fetchImpl, `${API}/x/web-interface/wbi/search/type?${qs}`, opts);
    const code = Number(data && data.code);
    if (code === -352 || code === -412) throw riskError();
    if (code !== 0) {
      // 签名过期等：清掉缓存，下次重新取
      state.wbi = null;
      throw new Error(`B 站搜索失败（${(data && data.message) || '错误码 ' + code}）`);
    }
    const list = Array.isArray(data.data && data.data.result) ? data.data.result : [];
    const seen = new Set();
    const out = [];
    for (const item of list) {
      const r = mapVideo(item);
      if (r && !seen.has(r.id)) { seen.add(r.id); out.push(r); }
      if (out.length >= n) break;
    }
    return out;
  } catch (e) {
    if (e && e.code === 'BILI_RISK') {
      state.cooldownUntil = Date.now() + COOLDOWN_MS;
      state.buvid = null; // 下次换一个 buvid3
      state.wbi = null;
    }
    throw e;
  }
}

module.exports = {
  searchBilibili,
  _internals: { MIXIN_KEY_ENC_TAB, getMixinKey, signWbi, keyFromUrl, parseClock, mapVideo, stripHtml, resetState, state },
};
