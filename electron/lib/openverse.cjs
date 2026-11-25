'use strict';
// Openverse（openverse.org，WordPress 基金会运营）免 Key 的开放许可图片 / 音频搜索。
// 文档：https://api.openverse.org/v1/  匿名限额约每分钟 20 次、每天 200 次 → 结果缓存 24 小时，429 时按 Retry-After 冷却。
// 只要「可商用且可改编」的许可（license_type=commercial,modification），所以这里的结果都能放进成片。
const OPENVERSE_API = 'https://api.openverse.org/v1';
const CACHE_MS = 24 * 3600 * 1000;
const CACHE_MAX = 200;
const USER_AGENT = 'FrameflowStudio/2.0 (desktop app; https://openverse.org)';

const cache = new Map(); // key -> { at, results }
let cooldownUntil = 0;

function clearCache() {
  cache.clear();
  cooldownUntil = 0;
}

const CC_NAMES = { by: 'CC BY', 'by-sa': 'CC BY-SA', 'by-nd': 'CC BY-ND', 'by-nc': 'CC BY-NC', 'by-nc-sa': 'CC BY-NC-SA', 'by-nc-nd': 'CC BY-NC-ND' };

/** Openverse 许可代号 → { id, name, url }（id 与 src/engine/license.js 的许可表一致） */
function licenseOf(item) {
  const code = String((item && item.license) || '').toLowerCase();
  const ver = String((item && item.license_version) || '').trim();
  const url = String((item && item.license_url) || '');
  if (code === 'cc0') return { id: 'cc0', name: `CC0${ver ? ' ' + ver : ''}`, url };
  if (code === 'pdm') return { id: 'pdm', name: '公共领域', url };
  if (CC_NAMES[code]) return { id: 'cc-' + code, name: `${CC_NAMES[code]}${ver ? ' ' + ver : ''}`, url };
  return { id: 'unknown', name: code ? code.toUpperCase() : '许可不明', url };
}

function cleanTitle(t, fallback) {
  const s = String(t || '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 120) : fallback;
}

function mapItem(item, kind) {
  if (!item || !item.url || !item.id) return null;
  const lic = licenseOf(item);
  const isAudio = kind === 'audio';
  const durMs = Number(item.duration);
  return {
    source: 'openverse',
    id: `openverse_${isAudio ? 'aud' : 'img'}_${item.id}`,
    title: cleanTitle(item.title, isAudio ? 'Openverse 音乐' : 'Openverse 图片'),
    url: item.foreign_landing_url || item.detail_url || item.url,
    thumb: item.thumbnail || (isAudio ? null : item.url) || null,
    duration: isAudio && durMs > 0 ? Math.round(durMs / 10) / 100 : null,
    width: Number(item.width) || null,
    height: Number(item.height) || null,
    author: item.creator ? String(item.creator).slice(0, 120) : null,
    authorUrl: item.creator_url || null,
    license: lic.name,
    licenseId: lic.id,
    licenseUrl: lic.url,
    provider: item.source || item.provider || null,
    attribution: item.attribution ? String(item.attribution).slice(0, 400) : null,
    downloadUrl: item.url,
    size: Number(item.filesize) || null,
    kind: isAudio ? 'audio' : 'image',
  };
}

function rateLimitError(retryAfterSec) {
  const sec = Math.max(10, Math.min(3600, Math.ceil(Number(retryAfterSec) || 60)));
  cooldownUntil = Date.now() + sec * 1000;
  const e = new Error(sec >= 120
    ? `Openverse 今天的免费搜索次数快用完了，请 ${Math.ceil(sec / 60)} 分钟后再试，或换用其他来源`
    : `Openverse 搜索太频繁，请 ${sec} 秒后再试`);
  e.code = 'RATE_LIMITED';
  return e;
}

/**
 * 搜索 Openverse 图片或音频。
 * @param {string} query
 * @param {'image'|'audio'} kind
 * @param {number} limit 1..20
 * @param {{ signal?: AbortSignal, fetchImpl?: Function, timeoutMs?: number }} opts
 */
async function searchOpenverse(query, kind = 'image', limit = 8, { signal, fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!q) throw new Error('请输入搜索关键词');
  if (kind !== 'image' && kind !== 'audio') return [];
  const n = Math.max(1, Math.min(20, Math.round(Number(limit) || 8)));
  const key = `${kind}|${q.toLowerCase()}|${n}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.results.map((r) => ({ ...r }));
  if (Date.now() < cooldownUntil) throw rateLimitError((cooldownUntil - Date.now()) / 1000);
  if (typeof fetchImpl !== 'function') throw new Error('当前环境不支持联网');

  const params = new URLSearchParams({
    q,
    page_size: String(Math.min(20, Math.max(n, 10))),
    license_type: 'commercial,modification',
    mature: 'false',
  });
  const url = `${OPENVERSE_API}/${kind === 'audio' ? 'audio' : 'images'}/?${params}`;
  const timeout = AbortSignal.timeout(timeoutMs);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res;
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, signal: sig });
  } catch (e) {
    if (signal && signal.aborted) { const c = new Error('已取消'); c.code = 'CANCELLED'; throw c; }
    if (timeout.aborted) throw new Error('Openverse 搜索超时，请检查网络');
    throw new Error('连不上 Openverse，请检查网络或代理');
  }
  if (res.status === 429) throw rateLimitError(res.headers && res.headers.get && res.headers.get('retry-after'));
  if (!res.ok) {
    const e = new Error(`Openverse 返回错误（HTTP ${res.status}），请稍后再试`);
    e.status = res.status;
    throw e;
  }
  // 额度快用完时提前冷却，避免后面连续失败
  try {
    const left = Number(res.headers.get('x-ratelimit-available-anon_burst'));
    if (Number.isFinite(left) && left <= 0) cooldownUntil = Date.now() + 60 * 1000;
  } catch {}
  let data;
  try { data = await res.json(); } catch { throw new Error('Openverse 返回的数据无法解析'); }
  const list = Array.isArray(data && data.results) ? data.results : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const r = mapItem(item, kind);
    // 双保险：只留可商用、可改编的许可
    if (!r || seen.has(r.id) || !['cc0', 'pdm', 'cc-by', 'cc-by-sa'].includes(r.licenseId)) continue;
    seen.add(r.id);
    out.push(r);
    if (out.length >= n) break;
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), results: out });
  return out.map((r) => ({ ...r }));
}

module.exports = { searchOpenverse, OPENVERSE_API, _internals: { licenseOf, mapItem, cleanTitle, clearCache, cache } };
