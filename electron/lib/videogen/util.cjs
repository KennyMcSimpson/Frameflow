'use strict';
// AI 视频生成公共工具：轮询、下载、JWT、图片转 data URL、HTTP 错误归一化。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertSafePublicUrl, assertSafePublicUrlAsync } = require('../urlSafety.cjs');

/** 判断 fetch 实现是否指向真实网络（而非离线单测注入的 mock fetch），用于在真实联网路径始终强制执行异步 DNS SSRF 校验 */
function isRealNetworkFetch(fn) {
  if (!fn || fn === globalThis.fetch) return true;
  if (typeof fn !== 'function') return true;
  const src = Function.prototype.toString.call(fn).trim();
  if (src.includes('[native code]')) return true;
  if (/^\([^)]*\)\s*=>\s*(?:globalThis|global|window)\.fetch\s*\(/.test(src)) return true;
  return false;
}

class VideogenError extends Error {
  constructor(message, code, status) { super(message); this.code = code || 'VIDEOGEN'; if (status) this.status = status; }
}

function cancelled() { const e = new Error('已取消'); e.code = 'CANCELLED'; return e; }

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(cancelled());
    const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(t); reject(cancelled()); }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 反复调用 check() 直到返回非 undefined/null 值。
 * 间隔从 interval 开始按 factor 指数退避到 maxInterval；总超时 timeout；支持 AbortSignal。
 */
async function pollUntil(check, { interval = 5000, maxInterval = 15000, factor = 1.5, timeout = 10 * 60 * 1000, signal, sleepFn = sleep, now = Date.now } = {}) {
  const start = now();
  let wait = interval;
  for (let i = 0; ; i++) {
    if (signal && signal.aborted) throw cancelled();
    const r = await check(i);
    if (r !== undefined && r !== null) return r;
    if (now() - start + wait > timeout) throw new VideogenError(`生成超时（超过 ${Math.round(timeout / 60000)} 分钟），任务可能仍在服务商处排队，可稍后重试`, 'TIMEOUT');
    await sleepFn(wait, signal);
    wait = Math.min(maxInterval, Math.round(wait * factor));
  }
}

function httpMessage(status, body) {
  let detail = '';
  if (body && typeof body === 'object') {
    const e = body.error || body.base_resp || body;
    detail = (typeof e === 'string' ? e : (e.message || e.msg || e.status_msg || body.message || body.detail || '')) || '';
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } else if (typeof body === 'string') detail = body.slice(0, 200);
  const hint = status === 401 || status === 403 ? '密钥无效或无权限' : status === 402 ? '余额不足' : status === 429 ? '请求过于频繁或额度用尽' : status >= 500 ? '服务商暂时不可用' : '请求失败';
  return `${hint}（HTTP ${status}）${detail ? '：' + detail : ''}`;
}

const DEFAULT_MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const SENSITIVE_HEADER_RE = /^(authorization|proxy-authorization|cookie|x-goog-api-key|x-api-key|api-key)$|api[-_]?key|auth|token/i;

function stripSensitiveHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (!SENSITIVE_HEADER_RE.test(k)) out[k] = v;
  }
  return out;
}

function stripBodyHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (!/^(content-type|content-length)$/i.test(k)) out[k] = v;
  }
  return out;
}

/** fetch JSON；手动处理最多 5 跳重定向并在跨域时剥离敏感鉴权头；非 2xx 抛出带中文说明的错误（附 status、body、apiCode，供各家把错误码翻译成大白话；retryable 表示稍后重试可能成功） */
async function requestJson(fetchFn, url, { method = 'GET', headers = {}, body, signal, maxRedirects = 5, lookup } = {}) {
  let curParsed;
  try {
    curParsed = new URL(String(url || ''));
  } catch {
    throw new VideogenError('请求地址无效', 'BAD_URL');
  }
  if (curParsed.protocol !== 'http:' && curParsed.protocol !== 'https:') {
    throw new VideogenError('仅支持 http 或 https 协议的网址', 'UNSAFE_URL');
  }
  const doFetch = typeof fetchFn === 'function' ? fetchFn : globalThis.fetch;
  const checkUrl = (!lookup && !isRealNetworkFetch(fetchFn))
    ? (u, o) => assertSafePublicUrl(u, o)
    : (u, o) => assertSafePublicUrlAsync(u, { ...o, lookup });
  const initialOrigin = curParsed.origin;
  const redirectLimit = Math.max(0, Number.isFinite(Number(maxRedirects)) ? Number(maxRedirects) : 5);
  let curUrl = curParsed.href;
  let curMethod = String(method || 'GET').toUpperCase();
  let curBody = body !== undefined ? JSON.stringify(body) : undefined;
  let curHeaders = body !== undefined ? { 'Content-Type': 'application/json', ...(headers || {}) } : { ...(headers || {}) };

  let res;
  let text;
  for (let hop = 0; ; hop++) {
    try {
      res = await doFetch(curUrl, { method: curMethod, headers: curHeaders, body: curBody, signal, redirect: 'manual' });
    } catch (e) {
      if (signal && signal.aborted) throw cancelled();
      const err = new VideogenError(`网络连接失败：${e.message || e}`, 'NETWORK');
      err.retryable = true;
      throw err;
    }
    if (res && res.url) {
      try {
        await checkUrl(res.url, { allowedOrigins: [initialOrigin] });
      } catch (e) {
        throw new VideogenError(e.message || '重定向地址不受信任', e.code || 'UNSAFE_URL');
      }
    }
    const status = Number(res && res.status) || 0;
    const loc = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
    if (status >= 300 && status < 400 && loc) {
      try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch {}
      if (hop >= redirectLimit) {
        throw new VideogenError('请求重定向次数过多', 'REDIRECT');
      }
      let resolved;
      try {
        resolved = new URL(loc, curUrl).href;
      } catch {
        throw new VideogenError('重定向地址无效', 'BAD_URL');
      }
      let nextParsed;
      try {
        nextParsed = await checkUrl(resolved, { allowedOrigins: [initialOrigin] });
      } catch (e) {
        throw new VideogenError(e.message || '重定向地址不受信任', e.code || 'UNSAFE_URL');
      }
      if (nextParsed.origin !== curParsed.origin) {
        curHeaders = stripSensitiveHeaders(curHeaders);
      }
      if ((status === 303 && curMethod !== 'HEAD') || ((status === 301 || status === 302) && curMethod === 'POST')) {
        curMethod = 'GET';
        curBody = undefined;
        curHeaders = stripBodyHeaders(curHeaders);
      }
      curParsed = nextParsed;
      curUrl = nextParsed.href;
      continue;
    }
    break;
  }
  try {
    text = await res.text();
  } catch (e) {
    if (signal && signal.aborted) throw cancelled();
    const err = new VideogenError(`网络连接失败：${e.message || e}`, 'NETWORK');
    err.retryable = true;
    throw err;
  }
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
  if (!res.ok) {
    const err = new VideogenError(httpMessage(res.status, data), res.status === 401 || res.status === 403 ? 'AUTH' : 'HTTP', res.status);
    err.body = data;
    const apiErr = data && typeof data === 'object' ? (data.error || data) : null;
    if (apiErr && typeof apiErr === 'object' && apiErr.code) err.apiCode = String(apiErr.code);
    err.retryable = res.status === 429 || res.status === 408 || res.status >= 500;
    throw err;
  }
  return data;
}

async function waitStreamClose(closedRef, closePromise, ms = 2000) {
  if (closedRef.closed || !closePromise) return;
  let t;
  try {
    await Promise.race([
      closePromise,
      new Promise((r) => { t = setTimeout(r, ms); if (t.unref) t.unref(); }),
    ]);
  } finally {
    clearTimeout(t);
  }
}

/** 流式下载到文件（先写随机 .part 再改名；手动处理重定向并在跨域时剥离鉴权头；限流大小与超时） */
async function downloadTo(fetchFn, url, dest, {
  headers = {},
  signal,
  onProgress,
  maxBytes = DEFAULT_MAX_DOWNLOAD_BYTES,
  timeoutMs = 60000,
  idleTimeoutMs,
  maxRedirects = 10,
  allowedOrigins = [],
  lookup,
} = {}) {
  if (signal && signal.aborted) throw cancelled();
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new VideogenError('视频下载地址无效', 'BAD_URL');
  }
  const doFetch = typeof fetchFn === 'function' ? fetchFn : globalThis.fetch;
  const checkUrl = (!lookup && !isRealNetworkFetch(fetchFn))
    ? (u, o) => assertSafePublicUrl(u, o)
    : (u, o) => assertSafePublicUrlAsync(u, { ...o, lookup });
  const validateUrl = async (u) => {
    if (typeof u !== 'string' || !/^https?:\/\//i.test(u)) throw new VideogenError('视频下载地址无效', 'BAD_URL');
    try {
      return await checkUrl(u, { allowedOrigins });
    } catch (e) {
      throw new VideogenError(e.message || '视频下载地址不受信任', e.code || 'UNSAFE_URL');
    }
  };
  let curParsed = await validateUrl(url);
  let curUrl = curParsed.href;
  let curHeaders = { ...(headers || {}) };

  const ac = new AbortController();
  let timedOut = false;
  let timer = null;
  const idleMs = Math.max(1000, Number(idleTimeoutMs || timeoutMs) || 60000);
  const reqMs = Math.max(1000, Number(timeoutMs) || 60000);
  const arm = (ms) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; ac.abort(); }, ms);
    if (timer.unref) timer.unref();
  };
  const onAbort = () => ac.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  const limitBytes = Number(maxBytes) > 0 ? Number(maxBytes) : DEFAULT_MAX_DOWNLOAD_BYTES;
  let tmp = null;
  let out = null;
  const closedRef = { closed: true };
  let closedPromise = null;

  try {
    let res;
    for (let hop = 0; ; hop++) {
      arm(reqMs);
      try {
        res = await doFetch(curUrl, { headers: curHeaders, signal: ac.signal, redirect: 'manual' });
      } catch (e) {
        if (signal && signal.aborted) throw cancelled();
        if (timedOut) throw new VideogenError('下载超时：服务器长时间没有响应', 'TIMEOUT');
        throw new VideogenError(`下载失败：${e.message || e}`, 'NETWORK');
      }
      if (res && res.url) {
        await validateUrl(res.url);
      }
      const status = Number(res && res.status) || 0;
      const loc = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
      if (status >= 300 && status < 400 && loc) {
        if (hop >= maxRedirects) throw new VideogenError('视频下载重定向次数过多', 'REDIRECT');
        try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch {}
        let resolved;
        try { resolved = new URL(loc, curUrl).href; } catch { throw new VideogenError('重定向地址无效', 'BAD_URL'); }
        const nextParsed = await validateUrl(resolved);
        if (nextParsed.origin !== curParsed.origin) curHeaders = stripSensitiveHeaders(curHeaders);
        curParsed = nextParsed;
        curUrl = nextParsed.href;
        continue;
      }
      break;
    }

    if (!res.ok) {
      const gone = res.status === 403 || res.status === 404 || res.status === 410;
      throw new VideogenError(gone ? `视频下载链接已失效（HTTP ${res.status}），服务商通常只保留 24 小时，请重新生成` : `下载视频失败（HTTP ${res.status}）`, 'HTTP', res.status);
    }
    const total = Number(res.headers && res.headers.get && res.headers.get('content-length')) || 0;
    if (total > limitBytes) {
      try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch {}
      throw new VideogenError(`视频文件过大（超过 ${Math.round(limitBytes / 1048576)}MB）`, 'TOO_LARGE');
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.part`;
    out = fs.createWriteStream(tmp);
    closedRef.closed = false;
    closedPromise = new Promise((resolve) => {
      out.once('close', () => { closedRef.closed = true; resolve(); });
    });
    let outErr = null;
    const outError = new Promise((_, reject) => {
      out.on('error', (err) => { outErr = err; reject(err); });
    });
    outError.catch(() => {});

    let got = 0;
    arm(idleMs);
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      for (;;) {
        if (signal && signal.aborted) throw cancelled();
        if (outErr) throw outErr;
        arm(idleMs);
        let chunkRes;
        try {
          chunkRes = await reader.read();
        } catch (e) {
          if (signal && signal.aborted) throw cancelled();
          if (timedOut) throw new VideogenError('下载超时：网络长时间没有数据', 'TIMEOUT');
          throw new VideogenError(`下载中断：${e.message || e}`, 'NETWORK');
        }
        if (chunkRes.done) break;
        const value = chunkRes.value;
        got += value.length;
        if (got > limitBytes) {
          try { await reader.cancel(); } catch {}
          throw new VideogenError(`视频文件过大（超过 ${Math.round(limitBytes / 1048576)}MB）`, 'TOO_LARGE');
        }
        if (!out.write(Buffer.from(value))) {
          await Promise.race([new Promise((r) => out.once('drain', r)), outError]);
        }
        if (onProgress && total) onProgress(Math.min(1, got / total));
      }
    } else {
      let buf;
      try {
        buf = Buffer.from(await res.arrayBuffer());
      } catch (e) {
        if (signal && signal.aborted) throw cancelled();
        if (timedOut) throw new VideogenError('下载超时：网络长时间没有数据', 'TIMEOUT');
        throw new VideogenError(`下载中断：${e.message || e}`, 'NETWORK');
      }
      got = buf.length;
      if (got > limitBytes) throw new VideogenError(`视频文件过大（超过 ${Math.round(limitBytes / 1048576)}MB）`, 'TOO_LARGE');
      if (outErr) throw outErr;
      if (got > 0 && !out.write(buf)) {
        await Promise.race([new Promise((r) => out.once('drain', r)), outError]);
      }
    }
    if (timer) { clearTimeout(timer); timer = null; }
    await Promise.race([new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve()))), outError]);
    await waitStreamClose(closedRef, closedPromise);
    out = null;

    if (!got) {
      try { fs.unlinkSync(tmp); } catch {}
      throw new VideogenError('下载到的视频为空', 'EMPTY');
    }
    fs.renameSync(tmp, dest);
    return dest;
  } catch (e) {
    if (out) {
      try { out.destroy(); } catch {}
      await waitStreamClose(closedRef, closedPromise);
      out = null;
    }
    if (tmp) { try { fs.unlinkSync(tmp); } catch {} }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 带重试的下载：网络中断、服务器 5xx、下到空文件时等一会儿再试（默认共 3 次）；
 * 链接失效（403/404/410）或地址不合法/过大等重试也没用的错误直接抛出。
 */
async function downloadWithRetry(fetchFn, url, dest, { tries = 3, delays = [1500, 4000], sleepFn = sleep, ...opts } = {}) {
  let last = null;
  const noRetryCodes = new Set(['CANCELLED', 'BAD_URL', 'UNSAFE_URL', 'TOO_LARGE', 'REDIRECT']);
  for (let i = 0; i < Math.max(1, tries); i++) {
    try { return await downloadTo(fetchFn, url, dest, opts); } catch (e) {
      if (e && noRetryCodes.has(e.code)) throw e;
      last = e;
      const st = Number(e && e.status) || 0;
      if (st >= 400 && st < 500 && st !== 408 && st !== 429) break;
      if (i < tries - 1) await sleepFn(delays[Math.min(i, delays.length - 1)], opts.signal);
    }
  }
  throw last;
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function jwtHS256(payload, secret, header = {}) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', ...header }));
  const p = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', String(secret)).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
}

const IMG_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };
function imageToDataUrl(file, { maxBytes = 10 * 1024 * 1024 } = {}) {
  if (!file) return null;
  if (/^data:/.test(file) || /^https?:/.test(file)) return file;
  const mime = IMG_MIME[path.extname(file).toLowerCase()];
  if (!mime) throw new VideogenError('参考图只支持 PNG/JPG/WebP', 'BAD_IMAGE');
  const buf = fs.readFileSync(file);
  if (buf.length > maxBytes) throw new VideogenError(`参考图过大（${(buf.length / 1048576).toFixed(1)}MB），请小于 ${Math.round(maxBytes / 1048576)}MB`, 'BAD_IMAGE');
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/** data URL → {mime, base64} */
function splitDataUrl(u) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(u || '');
  return m ? { mime: m[1], base64: m[2] } : null;
}

const trimSlash = (u) => String(u || '').trim().replace(/\/+$/, '');
const clampDur = (d, allowed) => allowed.reduce((best, v) => (Math.abs(v - d) < Math.abs(best - d) ? v : best), allowed[0]);

module.exports = { VideogenError, sleep, pollUntil, requestJson, downloadTo, downloadWithRetry, jwtHS256, b64url, imageToDataUrl, splitDataUrl, httpMessage, trimSlash, clampDur, cancelled };
