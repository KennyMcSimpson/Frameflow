'use strict';
// 联网：yt-dlp 管理、多源搜索（维基共享资源 / Openverse / 互联网档案馆 / NASA 免 Key；Pexels / Pixabay 需 Key；B 站 / YouTube 仅供参考）、下载为素材。
// 视频站（B 站 / YouTube / 粘贴链接）的搜索和下载需要先同意使用须知（契约 C4，consent:grant）。
// 素材写入统一的 source / license / reference 字段（契约 C3）。
// 见 SPEC §2.2 web.cjs。主进程模块，但不在顶层 require electron（ctx 提供一切），便于 node 直接测试搜索函数。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yt = require('../lib/ytdlp.cjs');
const consent = require('../lib/consent.cjs');
const openverse = require('../lib/openverse.cjs');
const bili = require('../lib/bilibili.cjs');
const urlSafety = require('../lib/urlSafety.cjs');

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const ARCHIVE_API = 'https://archive.org';
const NASA_API = 'https://images-api.nasa.gov';
const ALL_SOURCES = ['commons', 'openverse', 'archive', 'nasa', 'pexels', 'pixabay', 'bilibili', 'youtube'];
// 不需要任何 Key 的开放许可来源（Pexels 已暂停发放新 Key，所以这些排在最前面）
const FREE_SOURCES = ['commons', 'openverse', 'archive', 'nasa'];
// 默认顺序：免 Key 的在前；Pexels / Pixabay 在后，填了 Key 才会用；B站/YouTube 仅在调用方显式指定时用于「参考」，不进入自动配素材
const DEFAULT_SOURCES = ['commons', 'openverse', 'archive', 'nasa', 'pexels', 'pixabay'];
const REFERENCE_ONLY_SOURCES = ['bilibili', 'youtube'];
const KEY_SOURCES = { pexels: ['pexelsKey', 'pexels'], pixabay: ['pixabayKey', 'pixabay'] };
// 每个来源能搜的类型
const SOURCE_KINDS = {
  youtube: ['video'], bilibili: ['video'], commons: ['video', 'image', 'audio'], pexels: ['video', 'image'],
  pixabay: ['video', 'image'], openverse: ['image', 'audio'], archive: ['video'], nasa: ['video', 'image'],
};
// 标注以英文为主的来源：中文关键词换成英文再搜（英文由渲染端按词表翻好，放在 payload.queryEn）
const ENGLISH_SOURCES = ['commons', 'openverse', 'archive', 'nasa'];
const PEXELS_ORIENTATIONS = ['landscape', 'portrait', 'square'];
const KINDS = ['video', 'image', 'audio'];
const SOURCE_LABELS = { youtube: 'YouTube', bilibili: 'B 站', commons: '维基共享资源', pexels: 'Pexels', pixabay: 'Pixabay', openverse: 'Openverse', archive: '互联网档案馆', nasa: 'NASA 影像库' };
const SOURCE_TIMEOUT = { commons: 25000, pexels: 25000, pixabay: 25000, openverse: 25000, archive: 40000, nasa: 30000, youtube: 150000, bilibili: 150000 };
const KIND_LABEL = { video: '视频', image: '图片', audio: '音频' };
const STOCK_PROVIDERS = ['commons', 'pexels', 'pixabay', 'openverse', 'archive', 'nasa'];
// 实拍视频的取舍（用户要求）：太短剪不动，太长多半是讲座 / 整段录像，太小放进成片会糊
const CLIP_MIN_SECONDS = 3;
const CLIP_MAX_SECONDS = 120;
const CLIP_MIN_WIDTH = 640;
const NASA_MAX_SECONDS = 300;
const MB = 1048576;

// ───────────────────────── 工具 ─────────────────────────

function loadFf() {
  try {
    return require('../lib/ff.cjs');
  } catch (e) {
    throw new Error('媒体处理模块不可用，请重新安装应用');
  }
}

function rid(prefix, n = 12) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex').slice(0, n)}`;
}

function shortHash(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8);
}

function hasCjk(s) { return /[㐀-鿿]/.test(String(s || '')); }

function isTimeoutError(e) {
  return !!(e && (e.name === 'TimeoutError' || (e.cause && e.cause.name === 'TimeoutError')));
}

/** GET JSON，带超时与中文错误 */
async function fetchJson(url, { headers, signal, timeoutMs = 20000, label = '' } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res;
  try {
    res = await yt.httpFetch(url, { headers: { Accept: 'application/json', ...(headers || {}) }, signal: sig });
  } catch (e) {
    if (signal && signal.aborted) throw yt.cancelledError();
    if (timeout.aborted || isTimeoutError(e)) throw new Error(`${label}请求超时，请检查网络`);
    throw new Error(`${label}连接失败：${yt.networkErrorMessage(e)}`);
  }
  if (!res.ok) {
    const err = new Error(`${label}返回错误（HTTP ${res.status}）`);
    err.status = res.status;
    throw err;
  }
  try {
    return await res.json();
  } catch (e) {
    if (signal && signal.aborted) throw yt.cancelledError();
    if (timeout.aborted) throw new Error(`${label}请求超时，请检查网络`);
    throw new Error(`${label}返回的数据无法解析`);
  }
}

/** 从标题/查询词提取标签 */
function makeTags(...texts) {
  const out = [];
  const seen = new Set();
  for (const t of texts.flat()) {
    if (!t) continue;
    const parts = String(t).split(/[\s,，。、;；:：|/\\()（）【】[\]《》<>"'“”‘’!?！？#@&+*=~`^…·_-]+/);
    for (let p of parts) {
      p = p.trim();
      if (!p) continue;
      if (/^[a-z0-9.]+$/i.test(p)) {
        p = p.toLowerCase();
        if (p.length < 2 || /^\d+$/.test(p) || STOP_WORDS.has(p)) continue;
      } else if (p.length < 2 && hasCjk(p)) continue;
      if (p.length > 20) p = p.slice(0, 20);
      if (!seen.has(p)) { seen.add(p); out.push(p); }
      if (out.length >= 12) return out;
    }
  }
  return out;
}
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'of', 'in', 'on', 'to', 'a', 'an', 'is', 'by', 'at', 'or', 'mp4', 'webm', 'ogv', 'jpg', 'png', 'video', 'file']);

function cleanCommonsTitle(t) {
  return String(t || '')
    .replace(/^(File|文件):/i, '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/_/g, ' ')
    .trim();
}

/**
 * 许可文字 / 链接 → 许可 id（与 src/engine/license.js 的许可表一致；主进程是 CJS，不能直接引用那边的 ESM）。
 * 认不出返回 'unknown'。
 */
function licenseIdOf(text, url) {
  const t = `${text || ''} ${url || ''}`.toLowerCase().replace(/_/g, ' ');
  if (/仅供(学习|参考)/.test(t)) return 'reference';
  if (/pexels/.test(t)) return 'pexels';
  if (/pixabay/.test(t)) return 'pixabay';
  if (/mixkit/.test(t)) return 'mixkit';
  if (/publicdomain\/zero|\bcc0\b|cc-zero/.test(t)) return 'cc0';
  if (/publicdomain\/mark|public ?domain|\bpd\b|\bpd-|公有领域|公共领域/.test(t)) return 'pdm';
  const m = t.match(/creativecommons\.org\/licenses\/(by(?:-(?:nc|nd|sa))*)\//) || t.match(/\bcc[\s-]*(by(?:[\s-]+(?:nc|nd|sa)\b)*)/);
  if (m) {
    const parts = m[1].split(/[\s-]+/);
    const out = ['by'];
    if (parts.includes('nc')) out.push('nc');
    if (parts.includes('nd')) out.push('nd');
    else if (parts.includes('sa')) out.push('sa');
    return 'cc-' + out.join('-');
  }
  if (/gfdl|gnu free documentation/.test(t)) return 'gfdl';
  return 'unknown';
}

/** 禁止商用或禁止改编的许可：自动配素材时不能用 */
function isRestrictedLicenseId(id) {
  return /-nc\b|-nc-|-nd\b/.test(String(id || '')) || id === 'reference';
}

/** 给搜索结果补上结构化许可（licenseId / licenseUrl），已有就不动 */
function withLicenseInfo(r) {
  if (!r) return r;
  if (!r.licenseId) r.licenseId = REFERENCE_ONLY_SOURCES.includes(r.source) ? 'reference' : licenseIdOf(r.license, r.licenseUrl);
  if (REFERENCE_ONLY_SOURCES.includes(r.source)) r.reference = true;
  return r;
}

function slugTitle(url, fallback) {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    const words = decodeURIComponent(seg).replace(/-\d+$/, '').replace(/[-_]+/g, ' ').trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : fallback;
  } catch {
    return fallback;
  }
}

// ───────────────────────── 各搜索源 ─────────────────────────

/** 横竖屏：landscape / portrait / square；尺寸不明返回 null（与 src/engine/stockFootage.js 的 orientationOf 一致） */
function orientationOfSize(w, h) {
  const W = Number(w); const H = Number(h);
  if (!(W > 0 && H > 0)) return null;
  const r = W / H;
  return r > 1.15 ? 'landscape' : r < 0.87 ? 'portrait' : 'square';
}

/** 维基共享资源的转码版本 → [{url,width,height,size}]，从小到大。只要 WebM（360p 的 .mov 是老编码，不要）；size 按码率估算 */
function commonsVariants(vi, duration) {
  const list = Array.isArray(vi && vi.derivatives) ? vi.derivatives : [];
  const out = [];
  for (const d of list) {
    if (!d || !d.src || !d.transcodekey) continue; // 没有 transcodekey 的那条是原片
    if (!/\.webm$/i.test(String(d.transcodekey)) || !/^video\/webm/i.test(String(d.type || ''))) continue;
    const width = Number(d.width) || 0;
    const height = Number(d.height) || 0;
    if (!(width > 0 && height > 0)) continue;
    const bw = Number(d.bandwidth) || 0;
    out.push({ url: yt._internals.toHttps(String(d.src)), width, height, size: bw > 0 && duration > 0 ? Math.round((bw * duration) / 8) : null });
  }
  return out.sort((a, b) => a.width * a.height - b.width * b.height);
}

/**
 * 给一条维基共享资源视频挑下载版本：原片不大（长边 ≤1920、≤80 MB）就用原片；
 * 4K / 上百 MB 的原片改用长边 ≤1920 的最大转码版本。挑不出够清晰的返回 null。
 */
function pickCommonsVideo(ii, variants) {
  const w = Number(ii.width) || 0;
  const h = Number(ii.height) || 0;
  const size = Number(ii.size) || 0;
  const original = { url: ii.url, width: w || null, height: h || null, size: size || null };
  if ((Math.max(w, h) <= 1920 && size <= 80 * MB) || !variants.length) return size > 200 * MB ? null : original;
  const fit = variants.filter((v) => Math.max(v.width, v.height) <= 1920 && v.width >= CLIP_MIN_WIDTH);
  if (fit.length) return fit[fit.length - 1];
  return size > 200 * MB ? null : original;
}

/** 超大原图（上万像素 / 几十 MB）放进剪辑里又慢又占内存：改用 1920 宽的预览图（维基只提供固定档位，1920 是其中一档） */
function pickCommonsImage(ii) {
  const w = Number(ii.width) || 0;
  const h = Number(ii.height) || 0;
  const size = Number(ii.size) || 0;
  const thumb = String(ii.thumburl || '');
  if ((w > 2560 || size > 12 * MB) && w > 0 && /\/\d+px-/.test(thumb)) {
    return { url: thumb.replace(/\/\d+px-/, '/1920px-'), width: 1920, height: Math.round((h * 1920) / w) || null, size: null };
  }
  return { url: ii.url, width: w || null, height: h || null, size: size || null };
}

/** 从「作者」那段 HTML 里取主页链接 */
function firstHref(html) {
  const m = /href="([^"]+)"/i.exec(String(html || ''));
  if (!m) return null;
  const u = yt._internals.toHttps(m[1].replace(/&amp;/g, '&'));
  return /^https:\/\//i.test(u || '') && !/redlink=1/.test(u) ? u : null;
}

/**
 * Wikimedia Commons（MediaWiki API），免 Key。
 * 视频：去掉太短（<3 秒）、太长（>120 秒）、太小（宽 <640）的；带上各清晰度的转码版本；
 * 画幅方向一致、达到 720p、许可明确的排前面，其余保持搜索引擎的相关度顺序。
 * @param {{ signal?: AbortSignal, orientation?: 'landscape'|'portrait'|'square', fetchJsonImpl?: Function }} opts fetchJsonImpl 供测试注入
 */
async function searchCommons(query, kind = 'video', limit = 8, { signal, orientation, fetchJsonImpl = fetchJson } = {}) {
  const isVideo = kind !== 'image' && kind !== 'audio';
  const ft = kind === 'image' ? 'filetype:bitmap' : kind === 'audio' ? 'filetype:audio' : `filetype:video filew:>${CLIP_MIN_WIDTH - 1}`;
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrsearch: `${ft} ${query}`,
    gsrnamespace: '6',
    // 视频要筛掉不少（多数太长），所以多要一些候选
    gsrlimit: String(isVideo ? Math.min(50, Math.max(24, limit * 4)) : Math.min(50, limit * 2)),
    prop: isVideo ? 'imageinfo|videoinfo' : 'imageinfo',
    iiprop: 'url|size|mime|extmetadata|mediatype',
    iiurlwidth: '320',
    iiextmetadatafilter: 'LicenseShortName|LicenseUrl|License|AttributionRequired|Artist|ObjectName|ImageDescription',
  });
  if (isVideo) params.set('viprop', 'derivatives');
  const data = await fetchJsonImpl(`${COMMONS_API}?${params}`, { signal, timeoutMs: SOURCE_TIMEOUT.commons, label: '维基共享资源' });
  if (data && data.error) throw new Error('维基共享资源搜索失败：' + (data.error.info || data.error.code || '未知错误'));
  const pages = (data && data.query && Array.isArray(data.query.pages)) ? data.query.pages.slice() : [];
  pages.sort((a, b) => (a.index || 0) - (b.index || 0));
  const out = [];
  for (const p of pages) {
    const ii = Array.isArray(p.imageinfo) ? p.imageinfo[0] : null;
    if (!ii || !ii.url) continue;
    const mt = String(ii.mediatype || '').toUpperCase();
    const mime = String(ii.mime || '').toLowerCase();
    const okKind = kind === 'image' ? (mt === 'BITMAP' || mime.startsWith('image/'))
      : kind === 'audio' ? (mt === 'AUDIO' || mime.startsWith('audio/'))
        : (mt === 'VIDEO' || mime.startsWith('video/'));
    if (!okKind) continue;
    const duration = Number(ii.duration) > 0 ? Math.round(Number(ii.duration) * 100) / 100 : null;
    let pick = { url: ii.url, width: Number(ii.width) || null, height: Number(ii.height) || null, size: Number(ii.size) || null };
    let variants = null;
    if (isVideo) {
      // 时长 / 尺寸明确不合适的去掉；极少数老文件没有记录，留着
      if (duration && (duration < CLIP_MIN_SECONDS || duration > CLIP_MAX_SECONDS)) continue;
      if (Number(ii.width) > 0 && Number(ii.width) < CLIP_MIN_WIDTH) continue;
      variants = commonsVariants(Array.isArray(p.videoinfo) ? p.videoinfo[0] : null, duration || 0);
      pick = pickCommonsVideo(ii, variants);
      if (!pick) continue;
    } else if (kind === 'image') {
      pick = pickCommonsImage(ii);
    }
    const em = ii.extmetadata || {};
    const objName = em.ObjectName && yt.stripHtml(em.ObjectName.value);
    const title = (objName && objName.length <= 120 ? objName : '') || cleanCommonsTitle(p.title) || '维基共享资源素材';
    const licText = (em.LicenseShortName && yt.stripHtml(em.LicenseShortName.value)) || '';
    const licUrl = (em.LicenseUrl && yt.stripHtml(em.LicenseUrl.value)) || '';
    const licCode = (em.License && yt.stripHtml(em.License.value)) || '';
    const r = {
      source: 'commons',
      id: `commons_${p.pageid}`,
      title,
      url: ii.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(String(p.title || '').replace(/ /g, '_'))}`,
      thumb: kind === 'audio' ? null : (ii.thumburl || (kind === 'image' ? ii.url : null)),
      duration,
      width: pick.width,
      height: pick.height,
      author: (em.Artist && yt.stripHtml(em.Artist.value).slice(0, 120)) || null,
      authorUrl: em.Artist ? firstHref(em.Artist.value) : null,
      license: licText || '许可不明，请看原页面',
      licenseId: licenseIdOf(`${licText} ${licCode}`, licUrl),
      licenseUrl: licUrl || null,
      attributionRequired: em.AttributionRequired ? String(em.AttributionRequired.value) === 'true' : null,
      downloadUrl: pick.url,
      size: pick.size,
      kind,
    };
    if (variants && variants.length) r.variants = variants.filter((v) => Math.max(v.width, v.height) <= 1920).map((v) => ({ url: v.url, width: v.width, height: v.height }));
    out.push(r);
  }
  if (!isVideo) return out.slice(0, limit);
  const want = PEXELS_ORIENTATIONS.includes(orientation) ? orientation : null;
  const penalty = (r) => {
    let n = 0;
    const got = orientationOfSize(r.width, r.height);
    if (want && got && got !== want) n += got === 'square' || want === 'square' ? 1 : 4;
    if (Math.min(Number(r.width) || 0, Number(r.height) || 0) < 720) n += 2;
    if (r.licenseId === 'unknown') n += 1;
    return n;
  };
  return out
    .map((r, i) => ({ r, i, n: penalty(r) }))
    .sort((a, b) => a.n - b.n || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.r);
}

function stockHttpError(e, name) {
  if (e && (e.status === 401 || e.status === 403)) return new Error(`${name} 不认这个 API Key（可能填错了、多了空格，或者已经失效）。请到「设置 → 素材」里重新粘贴一次；暂时用不了也不影响其他免 Key 的来源`);
  if (e && e.status === 429) return new Error(`请求过于频繁（${name} 限流），请稍后再试`);
  if (e && e.status === 400) return new Error(`${name} 不接受这个搜索词，请换个说法`);
  return e;
}

/** Pexels（视频 / 图片） */
async function searchPexels(key, query, kind = 'video', limit = 8, { signal, orientation, size = 'medium' } = {}) {
  // Pexels 已暂停发放新 Key（2026-11），所以不再引导用户去申请：有就填，没有就用免 Key 的来源
  if (!key) throw new Error('还没有填写 Pexels 的 API Key。Pexels 已暂停发放新 Key：以前申请过的可以在「设置 → 素材」里填上；没有也不影响，维基共享资源、互联网档案馆、NASA 这些来源不用 Key');
  const params = new URLSearchParams({ query, per_page: String(Math.min(80, limit)) });
  if (PEXELS_ORIENTATIONS.includes(orientation)) params.set('orientation', orientation);
  if (['large', 'medium', 'small'].includes(size)) params.set('size', size);
  if (hasCjk(query)) params.set('locale', 'zh-CN');
  const url = kind === 'image' ? `https://api.pexels.com/v1/search?${params}` : `https://api.pexels.com/videos/search?${params}`;
  let data;
  try {
    data = await fetchJson(url, { headers: { Authorization: key }, signal, timeoutMs: SOURCE_TIMEOUT.pexels, label: 'Pexels ' });
  } catch (e) { throw stockHttpError(e, 'Pexels'); }
  if (kind === 'image') {
    return (Array.isArray(data.photos) ? data.photos : []).slice(0, limit).map((p) => ({
      source: 'pexels',
      id: `pexels_img_${p.id}`,
      title: (p.alt && String(p.alt).trim()) || slugTitle(p.url, `Pexels 图片 #${p.id}`),
      url: p.url,
      thumb: (p.src && (p.src.medium || p.src.small)) || null,
      duration: null,
      width: Number(p.width) || null,
      height: Number(p.height) || null,
      author: p.photographer || null,
      license: 'Pexels License',
      downloadUrl: (p.src && (p.src.large2x || p.src.large || p.src.original)) || null,
      kind: 'image',
    })).filter((r) => r.downloadUrl);
  }
  return (Array.isArray(data.videos) ? data.videos : []).map((v) => {
    const files = (Array.isArray(v.video_files) ? v.video_files : []).filter((f) => f && f.link && /mp4/i.test(String(f.file_type || f.link)));
    const fit = files.filter((f) => Number(f.width) > 0 && Number(f.width) <= 1920).sort((a, b) => Number(b.width) - Number(a.width));
    const pick = fit[0] || files.sort((a, b) => Number(a.width || 0) - Number(b.width || 0))[0];
    if (!pick) return null;
    return {
      source: 'pexels',
      id: `pexels_${v.id}`,
      title: slugTitle(v.url, `Pexels 视频 #${v.id}`),
      url: v.url,
      thumb: v.image || null,
      duration: Number(v.duration) || null,
      width: Number(pick.width) || Number(v.width) || null,
      height: Number(pick.height) || Number(v.height) || null,
      author: (v.user && v.user.name) || null,
      license: 'Pexels License',
      downloadUrl: pick.link,
      variants: files.filter((f) => Number(f.width) > 0).map((f) => ({ url: f.link, width: Number(f.width), height: Number(f.height) || 0 })),
      kind: 'video',
    };
  }).filter(Boolean).slice(0, limit);
}

/** Pixabay（视频 / 图片） */
async function searchPixabay(key, query, kind = 'video', limit = 8, { signal } = {}) {
  if (!key) throw new Error('还没有填写 Pixabay 的 API Key（在「设置 → 素材」里填写）。不填也不影响，维基共享资源、互联网档案馆、NASA 这些来源不用 Key');
  const params = new URLSearchParams({ key, q: query.slice(0, 100), per_page: String(Math.max(3, Math.min(200, limit))), safesearch: 'true' });
  if (hasCjk(query)) params.set('lang', 'zh');
  if (kind === 'image') params.set('image_type', 'photo');
  const url = kind === 'image' ? `https://pixabay.com/api/?${params}` : `https://pixabay.com/api/videos/?${params}`;
  let data;
  try {
    data = await fetchJson(url, { signal, timeoutMs: SOURCE_TIMEOUT.pixabay, label: 'Pixabay ' });
  } catch (e) { throw stockHttpError(e, 'Pixabay'); }
  const hits = Array.isArray(data.hits) ? data.hits : [];
  const titleOf = (h, fb) => {
    const tags = String(h.tags || '').split(',').map((s) => s.trim()).filter(Boolean);
    return tags.length ? tags.slice(0, 4).join(' · ') : fb;
  };
  if (kind === 'image') {
    return hits.slice(0, limit).map((h) => ({
      source: 'pixabay',
      id: `pixabay_img_${h.id}`,
      title: titleOf(h, `Pixabay 图片 #${h.id}`),
      url: h.pageURL,
      thumb: h.webformatURL || h.previewURL || null,
      duration: null,
      width: Number(h.imageWidth) || null,
      height: Number(h.imageHeight) || null,
      author: h.user || null,
      license: 'Pixabay Content License',
      downloadUrl: h.largeImageURL || h.webformatURL || null,
      kind: 'image',
    })).filter((r) => r.downloadUrl);
  }
  return hits.map((h) => {
    const vids = h.videos || {};
    const cands = [vids.large, vids.medium, vids.small, vids.tiny].filter((x) => x && x.url);
    const pick = cands.find((x) => !(Number(x.width) > 1920)) || cands[cands.length - 1];
    if (!pick) return null;
    const thumb = (vids.medium && vids.medium.thumbnail) || (vids.small && vids.small.thumbnail) || (pick.thumbnail)
      || (h.picture_id ? `https://i.vimeocdn.com/video/${h.picture_id}_640x360.jpg` : null);
    return {
      source: 'pixabay',
      id: `pixabay_${h.id}`,
      title: titleOf(h, `Pixabay 视频 #${h.id}`),
      url: h.pageURL,
      thumb,
      duration: Number(h.duration) || null,
      width: Number(pick.width) || null,
      height: Number(pick.height) || null,
      author: h.user || null,
      license: 'Pixabay Content License',
      downloadUrl: pick.url,
      variants: cands.filter((x) => Number(x.width) > 0).map((x) => ({ url: x.url, width: Number(x.width), height: Number(x.height) || 0 })),
      kind: 'video',
    };
  }).filter(Boolean).slice(0, limit);
}

function getSecret(settings, names) {
  if (!settings || typeof settings.getSecret !== 'function') return '';
  for (const n of names) {
    try { const v = settings.getSecret(n); if (v) return String(v).trim(); } catch {}
  }
  return '';
}

function interleave(lists) {
  const out = [];
  const seen = new Set();
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) {
    for (const l of lists) {
      const r = l[i];
      if (r && !seen.has(r.id)) { seen.add(r.id); out.push(r); }
    }
  }
  return out;
}

/**
 * 整理设置里的来源偏好（settings.web.preferredSources）：不认识的来源忽略；
 * 后来新增的免 Key 来源（Openverse / 互联网档案馆 / NASA）补到需要 Key 的图库和视频站前面。空的用默认顺序。
 */
function normalizeSources(list) {
  const known = [...new Set((Array.isArray(list) ? list : []).filter((s) => ALL_SOURCES.includes(s)))];
  if (!known.length) return DEFAULT_SOURCES.slice();
  const missing = FREE_SOURCES.filter((s) => !known.includes(s));
  if (!missing.length) return known;
  const at = known.findIndex((s) => !FREE_SOURCES.includes(s));
  return at < 0 ? [...known, ...missing] : [...known.slice(0, at), ...missing, ...known.slice(at)];
}

/**
 * 多源并行搜索：单源失败进 errors。
 * payload: { query, queryEn?, kind?, limit?, sources?, auto?, orientation?, preferOrientation?, size?, fallback? }
 *   queryEn  中文关键词对应的英文（渲染端按词表翻好），用于标注以英文为主的免 Key 来源
 *   auto     自动配素材：不搜视频站，去掉禁止商用 / 禁止改编的结果；维基共享资源没结果时再搜 NASA 和互联网档案馆（fallback:false 关掉）
 */
async function search(ctx, payload = {}) {
  const query = String(payload.query || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!query) throw new Error('请输入搜索关键词');
  const kind = KINDS.includes(payload.kind) ? payload.kind : 'video';
  const limit = Math.max(1, Math.min(30, Math.round(Number(payload.limit) || 8)));
  const explicit = Array.isArray(payload.sources) && payload.sources.length > 0;
  const prefs = ctx.settings && typeof ctx.settings.get === 'function' ? ctx.settings.get() : null;
  let sources = explicit
    ? [...new Set(payload.sources.filter((s) => ALL_SOURCES.includes(s)))]
    // 没指定来源：按设置里的偏好；视频站只在调用方明确指定时才搜（需要先同意使用须知）
    : normalizeSources(prefs && prefs.web && prefs.web.preferredSources).filter((s) => !REFERENCE_ONLY_SOURCES.includes(s));
  let usingDefaults = !explicit;
  // 自动配素材（payload.auto）只用可商用图库
  if (payload.auto) {
    sources = sources.filter((s) => !REFERENCE_ONLY_SOURCES.includes(s));
    if (!sources.length) { sources = DEFAULT_SOURCES.slice(); usingDefaults = true; }
  }
  const orientation = PEXELS_ORIENTATIONS.includes(payload.orientation) ? payload.orientation : undefined;
  // preferOrientation：只影响排序（维基共享资源里画幅方向一致的排前面），不像 orientation 那样让 Pexels 只返回这一种方向
  const prefer = orientation || (PEXELS_ORIENTATIONS.includes(payload.preferOrientation) ? payload.preferOrientation : undefined);
  if (!sources.length) throw new Error('请至少选择一个搜索来源');
  const pexelsKey = getSecret(ctx.settings, KEY_SOURCES.pexels);
  const pixabayKey = getSecret(ctx.settings, KEY_SOURCES.pixabay);
  // 没指定来源时（用默认/偏好），没填 Key 的图库直接跳过，不报错
  if (usingDefaults) sources = sources.filter((s) => !(s === 'pexels' && !pexelsKey) && !(s === 'pixabay' && !pixabayKey));
  // 每个来源只搜它支持的类型（例如音乐只有维基共享资源和 Openverse）
  sources = sources.filter((s) => (SOURCE_KINDS[s] || []).includes(kind));
  if (!sources.length) sources = kind === 'video' ? ['commons', 'archive', 'nasa'] : kind === 'image' ? ['openverse', 'commons', 'nasa'] : ['openverse', 'commons'];
  // 视频站搜索：未同意使用须知时拦截（渲染端 withConsent 会弹同意框后重试）
  if (sources.some((s) => REFERENCE_ONLY_SOURCES.includes(s))) {
    consent.requireConsent(prefs, 'videoSites');
  }
  // 开放素材库的标注以英文为主：中文关键词换成英文再搜
  const cjk = hasCjk(query);
  const queryEn = cjk ? String(payload.queryEn || '').replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  const qFor = (source) => (queryEn && ENGLISH_SOURCES.includes(source) ? queryEn : query);
  const runOne = async (source, timeoutMs) => {
    const timeout = AbortSignal.timeout(timeoutMs || SOURCE_TIMEOUT[source] || 30000);
    const q = qFor(source);
    try {
      switch (source) {
        case 'commons': {
          const list = await searchCommons(q, kind, limit, { signal: timeout, orientation: prefer });
          // 英文没搜到时再用原来的中文试一次（维基共享资源有一部分中文说明）
          return list.length || q === query ? list : await searchCommons(query, kind, limit, { signal: timeout, orientation: prefer });
        }
        case 'pexels': return await searchPexels(pexelsKey, query, kind, limit, { signal: timeout, orientation, size: payload.size || 'medium' });
        case 'pixabay': return await searchPixabay(pixabayKey, query, kind, limit, { signal: timeout });
        case 'openverse': return await openverse.searchOpenverse(q, kind, limit, { signal: timeout, fetchImpl: yt.httpFetch });
        // 这两个库几乎只有英文标注：中文又翻不出英文时不白跑一趟
        case 'archive': return cjk && !queryEn ? [] : await searchArchive(q, limit, { signal: timeout });
        case 'nasa': return cjk && !queryEn ? [] : await searchNasa(q, kind, limit, { signal: timeout, maxSeconds: payload.auto ? CLIP_MAX_SECONDS : NASA_MAX_SECONDS });
        case 'bilibili': return await searchBilibiliWithFallback(ctx, query, limit, timeout);
        case 'youtube': return await yt.searchSite(ctx.paths, source, query, limit, { signal: timeout });
        default: return [];
      }
    } catch (e) {
      if (timeout.aborted) throw new Error(`${SOURCE_LABELS[source]} 搜索超时，请稍后重试`);
      throw e;
    }
  };
  const settled = await Promise.allSettled(sources.map((s) => runOne(s)));
  const lists = [];
  const errors = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') lists.push((s.value || []).map(withLicenseInfo));
    else errors.push({ source: sources[i], error: (s.reason && s.reason.message) || String(s.reason), ...(s.reason && s.reason.code ? { code: s.reason.code } : {}) });
  });
  let results = interleave(lists);
  // 自动配素材：去掉禁止商用 / 禁止改编的结果
  if (payload.auto) results = results.filter((r) => !isRestrictedLicenseId(r.licenseId));
  // 自动配素材时维基共享资源搜得通但一条合适的都没有：再试 NASA 和互联网档案馆（同样免 Key），最多等 15 秒。
  // 这两个库的搜索比较宽，只留标题或标签里把搜索词都对上的，免得给镜头配上不相干的画面
  const commonsAt = sources.indexOf('commons');
  if (payload.auto && payload.fallback !== false && kind === 'video' && !results.length && commonsAt >= 0 && settled[commonsAt].status === 'fulfilled') {
    const extra = ['nasa', 'archive'].filter((s) => !sources.includes(s));
    const more = await Promise.allSettled(extra.map((s) => runOne(s, 15000)));
    results = interleave(more.filter((s) => s.status === 'fulfilled').map((s) => (s.value || []).map(withLicenseInfo)))
      .filter((r) => !isRestrictedLicenseId(r.licenseId) && mentionsQuery(r, qFor(r.source)));
  }
  return { results, errors };
}

/** 结果的标题 / 标签里是不是搜索词里的每个词都出现了（只看 3 个字母以上的英文词；搜索词里没有这样的词时不做限制） */
function mentionsQuery(r, q) {
  const words = [...new Set(String(q || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP_WORDS.has(w)))];
  if (!words.length) return true;
  const hay = `${(r && r.title) || ''} ${Array.isArray(r && r.tags) ? r.tags.join(' ') : ''}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** B 站：先用原生搜索（不需要 yt-dlp）；失败且装了 yt-dlp 时退回 yt-dlp 搜索 */
async function searchBilibiliWithFallback(ctx, query, limit, signal) {
  try {
    return await bili.searchBilibili(query, limit, { signal });
  } catch (e) {
    if (signal.aborted || (e && e.code === 'CANCELLED')) throw e;
    let st = null;
    try { st = await yt.ytdlpStatus(ctx.paths); } catch {}
    if (st && st.installed) return yt.searchSite(ctx.paths, 'bilibili', query, limit, { signal });
    throw e;
  }
}

/** 互联网档案馆（archive.org）：公有领域 / CC BY / CC BY-SA 的短视频，免 Key */
async function searchArchive(query, limit = 8, { signal, fetchJsonImpl = fetchJson } = {}) {
  const kw = String(query || '').replace(/["\\()[\]{}:^~*?]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!kw) return [];
  const q = `(${kw}) AND mediatype:(movies) AND licenseurl:(*publicdomain* OR *licenses/by/* OR *licenses/by-sa/*)`;
  const params = new URLSearchParams({ q, rows: String(Math.min(30, limit * 3)), output: 'json' });
  for (const f of ['identifier', 'title', 'creator', 'licenseurl', 'downloads']) params.append('fl[]', f);
  params.append('sort[]', 'downloads desc');
  const data = await fetchJsonImpl(`${ARCHIVE_API}/advancedsearch.php?${params}`, { signal, timeoutMs: 20000, label: '互联网档案馆' });
  const docs = (data && data.response && Array.isArray(data.response.docs)) ? data.response.docs : [];
  const picked = docs.filter((d) => d && d.identifier).slice(0, Math.min(12, limit * 2));
  const settled = await Promise.allSettled(picked.map(async (d) => {
    const meta = await fetchJsonImpl(`${ARCHIVE_API}/metadata/${encodeURIComponent(d.identifier)}`, { signal, timeoutMs: 15000, label: '互联网档案馆' });
    return archiveResult(d, meta);
  }));
  const out = [];
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value) out.push(s.value);
    if (out.length >= limit) break;
  }
  if (!out.length && settled.length && settled.every((s) => s.status === 'rejected')) throw settled[0].reason;
  return out;
}

/** 从 archive.org 元数据里挑一个可直接下载的 mp4（不超过 15 分钟、400 MB） */
function archiveResult(doc, meta) {
  const files = Array.isArray(meta && meta.files) ? meta.files : [];
  const mp4s = files.filter((f) => f && f.name && /\.mp4$/i.test(f.name) && !/thumb/i.test(f.name));
  const rank = (f) => (/h\.264/i.test(f.format || '') ? 0 : /512kb/i.test(f.format || '') ? 1 : 2);
  const fit = mp4s
    .filter((f) => !(Number(f.size) > 400 * 1048576))
    .filter((f) => { const d = Number(yt._internals.parseDuration(f.length)); return !(d > 900); })
    .sort((a, b) => rank(a) - rank(b));
  const f = fit[0];
  if (!f) return null;
  const id = String(doc.identifier);
  const licUrl = String(doc.licenseurl || (meta.metadata && meta.metadata.licenseurl) || '');
  const licenseId = licenseIdOf('', licUrl);
  if (!['cc0', 'pdm', 'cc-by', 'cc-by-sa'].includes(licenseId)) return null;
  const title = Array.isArray(doc.title) ? doc.title[0] : doc.title;
  const creator = Array.isArray(doc.creator) ? doc.creator[0] : doc.creator;
  const names = { cc0: 'CC0', pdm: '公共领域', 'cc-by': 'CC BY', 'cc-by-sa': 'CC BY-SA' };
  return {
    source: 'archive',
    id: `archive_${id}`,
    title: String(title || id).slice(0, 120),
    url: `https://archive.org/details/${encodeURIComponent(id)}`,
    thumb: `https://archive.org/services/img/${encodeURIComponent(id)}`,
    duration: yt._internals.parseDuration(f.length),
    width: Number(f.width) || null,
    height: Number(f.height) || null,
    author: creator ? String(creator).slice(0, 120) : null,
    license: names[licenseId],
    licenseId,
    licenseUrl: licUrl || null,
    downloadUrl: `https://archive.org/download/${encodeURIComponent(id)}/${f.name.split('/').map(encodeURIComponent).join('/')}`,
    size: Number(f.size) || null,
    kind: 'video',
  };
}

// ───────────────────────── NASA 影像库 ─────────────────────────

const NASA_LICENSE_URL = 'https://www.nasa.gov/nasa-brand-center/images-and-media/';
// NASA 给每条视频转好的几档 mp4：short 是画面短边的上限，mbps 是大致码率（只用来估算文件大小，实际以下载为准）
const NASA_RENDITIONS = [
  { tag: 'small', short: 360, mbps: 1.45 },
  { tag: 'medium', short: 720, mbps: 2.3 },
  { tag: 'large', short: 1080, mbps: 5 },
];
const NASA_CACHE_MS = 10 * 60 * 1000;
const nasaCache = new Map(); // key -> { at, results }

/** NASA 的资源地址是 http:// 开头、文件名里还带空格：换成 https 并转义 */
function nasaUrl(u) {
  const s = String(u || '').trim().replace(/^http:\/\//i, 'https://');
  if (!/^https:\/\//i.test(s)) return '';
  try { return encodeURI(decodeURI(s)); } catch { return s.replace(/ /g, '%20'); }
}

/** metadata.json 里的时长（秒）：'0:01:00' / '15.02 s' / { Value, Scale } 都认；读不出返回 null */
function nasaDuration(meta) {
  if (!meta || typeof meta !== 'object') return null;
  for (const k of ['QuickTime:Duration', 'Composite:Duration', 'QuickTime:TrackDuration', 'QuickTime:MediaDuration', 'XMP:Duration']) {
    const v = meta[k];
    if (v == null || v === '') continue;
    let n = null;
    if (typeof v === 'object') n = Number(v.Value) * (Number(v.Scale) || 1);
    else {
      const s = String(v).trim();
      const m = /^(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?$/i.exec(s);
      n = m ? Number(m[1]) : yt._internals.parseDuration(s);
    }
    if (Number.isFinite(n) && n > 0) return Math.round(n * 100) / 100;
  }
  return null;
}

/** metadata.json 里原片的画面尺寸 */
function nasaSourceSize(meta) {
  const num = (k) => Number(meta && meta[k]) || 0;
  let w = num('QuickTime:ImageWidth') || num('QuickTime:SourceImageWidth') || num('File:ImageWidth');
  let h = num('QuickTime:ImageHeight') || num('QuickTime:SourceImageHeight') || num('File:ImageHeight');
  if (!(w > 0 && h > 0)) {
    const m = /(\d{2,5})\s*x\s*(\d{2,5})/i.exec(String((meta && meta['Composite:ImageSize']) || ''));
    if (m) { w = Number(m[1]); h = Number(m[2]); }
  }
  return w > 0 && h > 0 ? { w, h } : null;
}

/** '132 MB' / '1.2 GB' / '850 kB' → 字节数 */
function parseByteSize(v) {
  const m = /^([\d.]+)\s*(bytes?|[kmg]i?b)$/i.exec(String(v == null ? '' : v).trim());
  if (!m) return null;
  const unit = m[2].toLowerCase()[0];
  const mul = unit === 'k' ? 1024 : unit === 'm' ? MB : unit === 'g' ? 1024 * MB : 1;
  const n = Number(m[1]) * mul;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** 按短边上限等比缩小后的尺寸（原片尺寸不明时按 16:9 估） */
function scaleToShort(size, short) {
  const base = size || { w: Math.round((short * 16) / 9), h: short };
  const k = Math.min(1, short / Math.min(base.w, base.h));
  const even = (n) => Math.max(2, Math.round((n * k) / 2) * 2);
  return { width: even(base.w), height: even(base.h) };
}

/** NASA 自己的内容属于公共领域；写着第三方版权的条目（合作机构、商业公司供图）不收 */
function nasaLooksCopyrighted(d) {
  const text = `${d.secondary_creator || ''} ${d.photographer || ''} ${d.description || ''}`
    .replace(/no copyright (protection )?is asserted|not copyrighted|copyright[- ]free/gi, ' ');
  return /©|\(c\)\s*(19|20)\d\d|copyright|all rights reserved/i.test(text);
}

function nasaBase(d, kind) {
  const id = String(d.nasa_id);
  const author = [d.photographer, d.secondary_creator].map((s) => String(s || '').trim()).find(Boolean)
    || (d.center ? `NASA/${String(d.center).trim()}` : 'NASA');
  return {
    source: 'nasa',
    id: `nasa_${kind === 'image' ? 'img_' : ''}${id}`,
    title: String(d.title || id).replace(/\s+/g, ' ').trim().slice(0, 120),
    url: `https://images.nasa.gov/details/${encodeURIComponent(id)}`,
    author: author.slice(0, 120),
    license: '公共领域（NASA）',
    licenseId: 'pdm',
    licenseUrl: NASA_LICENSE_URL,
    attributionRequired: false,
    tags: (Array.isArray(d.keywords) ? d.keywords : []).map((k) => String(k || '').trim()).filter(Boolean).slice(0, 8),
    kind,
  };
}

function nasaThumb(it) {
  const links = Array.isArray(it && it.links) ? it.links.filter((l) => l && l.href) : [];
  const l = links.find((x) => x.rel === 'preview') || links.find((x) => /~(thumb|small)\.(jpe?g|png)$/i.test(String(x.href)));
  return l ? nasaUrl(l.href) || null : null;
}

/** 一条 NASA 视频 → 搜索结果。manifest 是 collection.json（文件地址数组），meta 是 metadata.json。不合适返回 null */
function nasaVideoResult(it, manifest, meta, { maxSeconds = NASA_MAX_SECONDS } = {}) {
  const d = it && Array.isArray(it.data) ? it.data[0] : null;
  if (!d || !d.nasa_id) return null;
  const urls = (Array.isArray(manifest) ? manifest : []).map(nasaUrl).filter(Boolean);
  const find = (tag) => urls.find((u) => new RegExp(`~${tag}\\.mp4$`, 'i').test(u));
  // 时长读不出来的不收：这个库里有不少一小时的发布会录像
  const duration = nasaDuration(meta);
  if (!duration || duration < CLIP_MIN_SECONDS || duration > maxSeconds) return null;
  const src = nasaSourceSize(meta);
  if (src && src.w < CLIP_MIN_WIDTH) return null;
  const variants = [];
  for (const r of NASA_RENDITIONS) {
    const url = find(r.tag);
    if (!url) continue;
    const dim = scaleToShort(src, r.short);
    if (dim.width < CLIP_MIN_WIDTH) continue;
    variants.push({ url, width: dim.width, height: dim.height, size: Math.round(duration * r.mbps * 125000), tag: r.tag });
  }
  if (!variants.length) {
    // 老条目没有转好的清晰度：原片是 mp4 且不大时直接用原片
    const orig = find('orig');
    const bytes = parseByteSize(meta && meta['File:FileSize']);
    if (!orig || !src || !bytes || bytes > 200 * MB) return null;
    variants.push({ url: orig, width: src.w, height: src.h, size: bytes, tag: 'orig' });
  }
  const by = (tag) => variants.find((v) => v.tag === tag);
  // 一分钟以内的短片用最清晰的一档；更长的用 720p，文件小一半
  const pick = (duration <= 60 && by('large')) || by('medium') || by('large') || variants[0];
  return {
    ...nasaBase(d, 'video'),
    thumb: nasaThumb(it),
    duration,
    width: pick.width,
    height: pick.height,
    downloadUrl: pick.url,
    variants: variants.map((v) => ({ url: v.url, width: v.width, height: v.height })),
    size: pick.size,
  };
}

/** 一条 NASA 图片 → 搜索结果。优先用搜索结果自带的 1920 宽版本；没有时从 manifest 里找 */
function nasaImageResult(it, manifest) {
  const d = it && Array.isArray(it.data) ? it.data[0] : null;
  if (!d || !d.nasa_id) return null;
  const links = Array.isArray(it.links) ? it.links.filter((l) => l && l.href) : [];
  const isImg = (u) => /\.(jpe?g|png)$/i.test(String(u).split('?')[0]);
  const linkOf = (tag) => links.find((l) => new RegExp(`~${tag}\\.(jpe?g|png)$`, 'i').test(String(l.href)));
  let pick = linkOf('large') || linkOf('medium') || links.find((l) => l.rel === 'canonical' && isImg(l.href)) || null;
  if (!pick && Array.isArray(manifest)) {
    const urls = manifest.map(String);
    const href = urls.find((u) => /~large\.(jpe?g|png)$/i.test(u)) || urls.find((u) => /~medium\.(jpe?g|png)$/i.test(u)) || urls.find((u) => /~orig\.(jpe?g|png)$/i.test(u));
    if (href) pick = { href };
  }
  const downloadUrl = pick ? nasaUrl(pick.href) : '';
  if (!downloadUrl) return null;
  return {
    ...nasaBase(d, 'image'),
    thumb: nasaThumb(it) || downloadUrl,
    duration: null,
    width: Number(pick.width) || null,
    height: Number(pick.height) || null,
    downloadUrl,
    size: Number(pick.size) || null,
  };
}

/**
 * NASA 影像库（images.nasa.gov），免 Key。NASA 自己拍摄制作的内容不受版权限制，可以用在成片里
 * （不能用来暗示 NASA 为你的产品背书）。视频只收 3 秒～5 分钟、宽度不低于 640 的。
 * @param {{ signal?: AbortSignal, fetchJsonImpl?: Function, maxSeconds?: number }} opts fetchJsonImpl 供测试注入（注入时不走缓存）
 */
async function searchNasa(query, kind = 'video', limit = 8, { signal, fetchJsonImpl = fetchJson, maxSeconds = NASA_MAX_SECONDS } = {}) {
  const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!q || (kind !== 'video' && kind !== 'image')) return [];
  const n = Math.max(1, Math.min(20, Math.round(Number(limit) || 8)));
  const useCache = fetchJsonImpl === fetchJson;
  const cacheKey = `${kind}|${q.toLowerCase()}|${n}|${maxSeconds}`;
  if (useCache) {
    const hit = nasaCache.get(cacheKey);
    if (hit && Date.now() - hit.at < NASA_CACHE_MS) return hit.results.map((r) => ({ ...r }));
  }
  const params = new URLSearchParams({ q, media_type: kind, page_size: String(Math.min(40, n * 3)) });
  let data;
  try {
    data = await fetchJsonImpl(`${NASA_API}/search?${params}`, { signal, timeoutMs: 20000, label: 'NASA 影像库' });
  } catch (e) {
    if (e && e.status === 400) throw new Error('NASA 影像库不接受这个搜索词，请换个说法（英文关键词效果更好）');
    throw e;
  }
  const items = (data && data.collection && Array.isArray(data.collection.items)) ? data.collection.items : [];
  const cands = items.filter((it) => {
    const d = it && Array.isArray(it.data) ? it.data[0] : null;
    return !!(d && d.nasa_id && String(d.media_type || kind) === kind && !nasaLooksCopyrighted(d));
  }).slice(0, Math.min(14, n + 6));
  const getJson = (url) => fetchJsonImpl(url, { signal, timeoutMs: 12000, label: 'NASA 影像库' });
  const settled = await Promise.allSettled(cands.map(async (it) => {
    if (kind === 'image') {
      const direct = nasaImageResult(it, null);
      if (direct || !it.href) return direct;
      return nasaImageResult(it, await getJson(nasaUrl(it.href)));
    }
    const href = nasaUrl(it.href);
    if (!href) return null;
    // 每条视频要再取两个小文件：文件清单（各清晰度的地址）和元数据（时长、尺寸）。元数据取不到就当作时长不明，不收这一条
    const [manifest, meta] = await Promise.all([
      getJson(href),
      getJson(href.replace(/collection\.json$/i, 'metadata.json')).catch((e) => { if (signal && signal.aborted) throw e; return null; }),
    ]);
    return nasaVideoResult(it, manifest, meta, { maxSeconds });
  }));
  const out = [];
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value) out.push(s.value);
    if (out.length >= n) break;
  }
  if (!out.length && settled.length && settled.every((s) => s.status === 'rejected')) throw settled[0].reason;
  if (useCache) {
    if (nasaCache.size >= 60) nasaCache.delete(nasaCache.keys().next().value);
    nasaCache.set(cacheKey, { at: Date.now(), results: out });
  }
  return out.map((r) => ({ ...r }));
}

// ───────────────────────── 下载 → Asset ─────────────────────────

function isInside(child, parent) {
  const c = path.resolve(child).toLowerCase();
  const p = path.resolve(parent).toLowerCase();
  return c === p || c.startsWith(p + path.sep);
}

/**
 * 把磁盘上的媒体文件组装成 Asset：probe → 需要时生成代理 → 缩略图 → 色彩统计。
 * opts: { name, source, tags, description, proxyDir, signal, onProgress(stage,p,msg) }
 */
async function buildAssetFromFile(ctx, file, opts = {}) {
  const ff = loadFf();
  const { paths } = ctx;
  const signal = opts.signal;
  const report = (stage, p, msg) => { if (opts.onProgress) opts.onProgress(stage, p, msg); };
  report('probe', 0, '正在读取媒体信息…');
  const info = await ff.probe(paths, file, { signal });
  let assetPath = file;
  let originalPath;
  if (info.kind !== 'image' && ff.needsProxy(info, file)) {
    const dir = opts.proxyDir || path.dirname(file);
    const proxy = path.join(dir, `${path.basename(file, path.extname(file))}_proxy.mp4`);
    report('proxy', 0, '正在转成兼容格式…');
    await ff.makeProxy(paths, file, proxy, { signal, onProgress: (p) => report('proxy', p, `正在转成兼容格式 ${Math.round(p * 100)}%`) });
    assetPath = proxy;
    originalPath = file;
  }
  if (signal && signal.aborted) throw yt.cancelledError();
  report('thumb', 0, '正在生成缩略图…');
  let thumb = null;
  let stats;
  if (info.kind !== 'audio') {
    try {
      const t = info.kind === 'image' ? 0 : Math.min(1, (info.duration || 0) / 2);
      thumb = await ff.thumb(paths, assetPath, t, 320);
    } catch { thumb = null; }
    if (thumb) {
      try { stats = await ff.colorStatsFromImage(paths, thumb, { signal }); } catch { stats = undefined; }
    }
  }
  let size = info.size || 0;
  try { size = (await fs.promises.stat(assetPath)).size; } catch {}
  const asset = {
    id: rid('ast'),
    kind: info.kind,
    name: String(opts.name || path.basename(file, path.extname(file))).slice(0, 120),
    path: assetPath,
    duration: info.kind === 'image' ? 5 : (info.duration || 0),
    width: info.width || 0,
    height: info.height || 0,
    fps: info.fps || (info.kind === 'audio' ? 0 : 30),
    hasAudio: !!info.hasAudio,
    size,
    thumb,
    source: opts.source || { type: 'local' },
    tags: Array.isArray(opts.tags) ? opts.tags : [],
    description: opts.description || '',
  };
  if (originalPath) asset.originalPath = originalPath;
  if (stats) asset.stats = stats;
  for (const p of [asset.path, asset.originalPath, asset.thumb]) if (p) ctx.registerMediaPath(p);
  return asset;
}

function extFromUrl(u, kind) {
  let ext = '';
  try { ext = path.extname(new URL(u).pathname).toLowerCase(); } catch {}
  if (/^\.[a-z0-9]{2,5}$/.test(ext)) return ext;
  return kind === 'image' ? '.jpg' : kind === 'audio' ? '.ogg' : '.mp4';
}

function sourceType(target, src) {
  if (target === 'library') return 'library';
  return STOCK_PROVIDERS.includes(src) ? 'stock' : 'web';
}

/**
 * 下载结果 → 素材上的 source / license / reference（契约 C3）。
 * 同时保留旧字段（type / platform / license 文字 / downloadUrl），老代码照常读取。
 */
function assetProvenance({ target, srcName, result, pageUrl, direct, author, title, info }) {
  const viaYtdlp = !direct; // 没有直链 = 走 yt-dlp 解析视频站
  const kind = viaYtdlp || REFERENCE_ONLY_SOURCES.includes(srcName) ? 'videosite' : STOCK_PROVIDERS.includes(srcName) ? 'stock' : 'web';
  const licenseText = viaYtdlp || kind === 'videosite' ? yt.WEB_LICENSE : ((result && result.license) || '');
  const licenseId = kind === 'videosite' ? 'reference' : ((result && result.licenseId) || licenseIdOf(licenseText, result && result.licenseUrl));
  const rawId = String((result && result.id) || '');
  const source = {
    kind,
    provider: srcName || '',
    id: rawId.replace(/^[a-z]+_(img_|aud_)?/, '') || undefined,
    url: pageUrl || direct,
    pageUrl: pageUrl || undefined,
    author: author || undefined,
    authorUrl: (result && result.authorUrl) || (info && info.uploader_url) || undefined,
    title: title || undefined,
    // 旧字段
    type: sourceType(target, srcName),
    platform: srcName,
    license: licenseText || yt.WEB_LICENSE,
    ...(direct ? { downloadUrl: direct } : {}),
  };
  for (const k of Object.keys(source)) if (source[k] === undefined) delete source[k];
  const license = { id: licenseId || 'unknown', name: licenseText || '许可不明', ...(result && result.licenseUrl ? { url: result.licenseUrl } : {}) };
  return { source, license, reference: kind === 'videosite' };
}

/** 是否需要走 yt-dlp（视频站链接）：需要先同意使用须知 */
function needsVideoSiteConsent(payload) {
  const result = payload && payload.result && typeof payload.result === 'object' ? payload.result : null;
  return !(result && String(result.downloadUrl || '').trim());
}

async function readSubtitles(file, maxSeconds) {
  if (!file) return null;
  try {
    const cues = yt.parseVtt(await fs.promises.readFile(file, 'utf8'));
    const list = maxSeconds > 0 ? cues.filter((c) => c.start < maxSeconds) : cues;
    return list.length ? list : null;
  } catch {
    return null;
  }
}

/** web:download 的实际执行体（也被 analysis.cjs 复用的部分见 buildAssetFromFile） */
async function download(ctx, job, payload = {}) {
  const { paths } = ctx;
  const result = payload.result && typeof payload.result === 'object' ? payload.result : null;
  const target = payload.target === 'library' ? 'library' : payload.target === 'project' || payload.target == null ? 'project' : null;
  if (!target) throw new Error('下载位置无效（只能是项目或素材库）');
  if (target === 'project' && !payload.projectId) throw new Error('下载到项目需要先打开一个项目');
  const settingsMax = ctx.settings && ctx.settings.get().web ? Number(ctx.settings.get().web.maxDownloadSeconds) : 180;
  const maxSeconds = payload.maxSeconds == null ? (settingsMax > 0 ? settingsMax : 180) : Math.max(0, Number(payload.maxSeconds) || 0);
  const withSubs = !!payload.withSubs;
  const pageUrl = String((result && result.url) || payload.url || '').trim();
  const direct = result && result.downloadUrl ? String(result.downloadUrl).trim() : '';
  const allowedOrigins = (ctx && ctx.allowedOrigins) || [];
  if (!direct && !pageUrl) throw new Error('缺少要下载的网址');
  urlSafety.assertSafePublicUrl(direct || pageUrl, { allowedOrigins });

  const outDir = target === 'library' ? paths.libraryMedia : path.join(paths.projectCache(payload.projectId), 'web');
  await fs.promises.mkdir(outDir, { recursive: true });
  const srcName = (result && result.source) || yt.platformOf(pageUrl);
  const kind = (result && KINDS.includes(result.kind)) ? result.kind : 'video';
  const query = String(payload.query || '').trim();

  // 素材库里已有同一来源 → 直接复用
  if (target === 'library') {
    const lib = require('./analysis.cjs').libraryStore;
    const key = direct || pageUrl;
    const exists = async (f) => { try { await fs.promises.access(f); return true; } catch { return false; } };
    let existing = null;
    for (const a of await lib.listAssets(paths)) {
      if (a.source && (a.source.url === pageUrl || a.source.downloadUrl === key) && a.path
        && (!a.clipSeconds || !maxSeconds || a.clipSeconds >= maxSeconds) && await exists(a.path)) { existing = a; break; }
    }
    if (existing) {
      for (const p of [existing.path, existing.originalPath, existing.thumb]) if (p) ctx.registerMediaPath(p);
      job.progress('done', 1, '素材库里已有这个素材');
      return { asset: existing, subtitles: withSubs ? await readSubtitles(existing.subtitlesPath, maxSeconds) : null };
    }
  }

  let title = String((result && result.title) || '').trim();
  const base = `${yt.safeBase(title || srcName || 'web')}_${shortHash((direct || pageUrl) + Date.now())}`;
  const created = [];
  let file;
  let subtitlesFile = null;
  let info = null;
  try {
    if (direct) {
      const dest = path.join(outDir, base + extFromUrl(direct, kind));
      job.progress('download', 0, `正在从 ${SOURCE_LABELS[srcName] || srcName} 下载…`);
      await yt.downloadUrlToFile(direct, dest, {
        signal: job.signal,
        allowedOrigins,
        onProgress: (p, received, total) => job.progress('download', p * 0.8,
          total ? `正在下载 ${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB` : `正在下载 ${(received / 1048576).toFixed(1)} MB`),
      });
      file = dest;
      created.push(dest);
    } else {
      job.progress('download', 0, '正在解析视频…');
      const dl = await yt.downloadVideo(paths, pageUrl, outDir, {
        maxSeconds, withSubs, signal: job.signal, fileBase: base, allowedOrigins,
        onProgress: (p, msg) => job.progress('download', p * 0.8, msg),
      });
      file = dl.file;
      subtitlesFile = dl.subtitlesFile;
      info = dl.info;
      created.push(file);
      if (subtitlesFile) created.push(subtitlesFile);
      if (!title) title = info.title || '';
    }
    job.throwIfCancelled();
    const name = title || (info && info.title) || `${SOURCE_LABELS[srcName] || '网络'}${KIND_LABEL[kind] || '素材'}`;
    const author = (result && result.author) || (info && info.uploader) || null;
    const prov = assetProvenance({ target, srcName, result, pageUrl, direct, author, title: name, info });
    const asset = await buildAssetFromFile(ctx, file, {
      name,
      proxyDir: outDir,
      signal: job.signal,
      source: prov.source,
      tags: makeTags(query, title, info && info.tags, result && result.tags),
      description: [
        author ? `作者：${author}` : '',
        `授权：${prov.source.license}`,
        info && info.description ? info.description.slice(0, 200) : '',
      ].filter(Boolean).join('；'),
      onProgress: (stage, p, msg) => job.progress(stage, stage === 'proxy' ? 0.8 + p * 0.15 : 0.96, msg),
    });
    asset.license = prov.license;
    if (prov.reference) asset.reference = true;
    if (asset.originalPath) created.push(asset.path);
    if (!direct && maxSeconds > 0) asset.clipSeconds = maxSeconds;
    if (subtitlesFile) asset.subtitlesPath = subtitlesFile;
    const subtitles = withSubs ? await readSubtitles(subtitlesFile, maxSeconds) : null;
    let saved = asset;
    if (target === 'library') {
      const lib = require('./analysis.cjs').libraryStore;
      const [stored] = await lib.addAssets(paths, [asset], { copy: false });
      saved = stored || asset;
    }
    job.progress('done', 1, '下载完成');
    return { asset: saved, subtitles };
  } catch (e) {
    for (const f of created) { try { fs.rmSync(f, { force: true }); } catch {} }
    throw e;
  }
}

// ───────────────────────── 注册 ─────────────────────────

module.exports = function register({ handle, ctx }) {
  const { paths, jobs } = ctx;

  handle('web:ytdlpStatus', async () => yt.ytdlpStatus(paths));

  // payload.latest=true：更新到 GitHub 上的最新版本（用同版本的 SHA2-256SUMS 校验，失败保留旧版）；默认安装固定版本
  handle('web:ytdlpInstall', async (payload) => jobs.start('ytdlp-install', async (job) => {
    job.progress('download', 0, '正在准备下载 yt-dlp…');
    return yt.installYtdlp(paths, { latest: !!(payload && payload.latest), signal: job.signal, onProgress: (p, msg) => job.progress('download', p, msg) });
  }, { title: payload && payload.latest ? '更新 yt-dlp' : '安装 yt-dlp' }));

  handle('web:search', async (payload) => search(ctx, payload));

  // 视频站使用须知（契约 C4）
  handle('consent:grant', async (payload) => consent.grantConsent(ctx.settings, (payload && payload.key) || 'videoSites'));
  handle('consent:revoke', async (payload) => consent.revokeConsent(ctx.settings, (payload && payload.key) || 'videoSites'));
  handle('consent:status', async () => consent.consentStatus(ctx.settings ? ctx.settings.get() : null));

  handle('web:download', async (payload) => {
    const title = (payload && payload.result && payload.result.title) || (payload && payload.url) || '网络素材';
    // 先做同步校验，让明显错误直接报出来
    if (payload && payload.target === 'project' && !payload.projectId) throw new Error('下载到项目需要先打开一个项目');
    const directUrl = payload && payload.result && payload.result.downloadUrl ? String(payload.result.downloadUrl).trim() : '';
    const pageUrl = String((payload && payload.result && payload.result.url) || (payload && payload.url) || '').trim();
    if (!directUrl && !pageUrl) throw new Error('缺少要下载的网址');
    const allowedOrigins = (ctx && ctx.allowedOrigins) || [];
    urlSafety.assertSafePublicUrl(directUrl || pageUrl, { allowedOrigins });
    // 视频站链接（走 yt-dlp）：未同意使用须知时在启动任务前拦截，错误码才能原样传回渲染端
    if (needsVideoSiteConsent(payload)) consent.requireConsent(ctx.settings ? ctx.settings.get() : null, 'videoSites');
    return jobs.start('web-download', (job) => download(ctx, job, payload), { title: String(title).slice(0, 80) });
  });
};

module.exports.buildAssetFromFile = buildAssetFromFile;
module.exports.makeTags = makeTags;
module.exports._internals = {
  ALL_SOURCES, FREE_SOURCES, DEFAULT_SOURCES, REFERENCE_ONLY_SOURCES, SOURCE_KINDS, SOURCE_LABELS, normalizeSources,
  searchCommons, commonsVariants, pickCommonsVideo, pickCommonsImage, orientationOfSize,
  searchPexels, searchPixabay, searchArchive, archiveResult,
  searchNasa, nasaVideoResult, nasaImageResult, nasaDuration, nasaSourceSize, nasaUrl, nasaLooksCopyrighted, parseByteSize, nasaCache,
  search, interleave, mentionsQuery,
  makeTags, cleanCommonsTitle, slugTitle, extFromUrl, isInside, licenseIdOf, isRestrictedLicenseId, assetProvenance, needsVideoSiteConsent,
};
