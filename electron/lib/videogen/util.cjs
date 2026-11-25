'use strict';
// AI 视频生成公共工具：轮询、下载、JWT、图片转 data URL、HTTP 错误归一化。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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

/** fetch JSON；非 2xx 抛出带中文说明的错误（附 status、body、apiCode，供各家把错误码翻译成大白话；retryable 表示稍后重试可能成功） */
async function requestJson(fetchFn, url, { method = 'GET', headers = {}, body, signal } = {}) {
  let res;
  try {
    res = await fetchFn(url, { method, headers: body !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal });
  } catch (e) {
    if (signal && signal.aborted) throw cancelled();
    const err = new VideogenError(`网络连接失败：${e.message || e}`, 'NETWORK');
    err.retryable = true;
    throw err;
  }
  const text = await res.text();
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

/** 流式下载到文件（先写 .part 再改名） */
async function downloadTo(fetchFn, url, dest, { headers = {}, signal, onProgress } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let res;
  try { res = await fetchFn(url, { headers, signal, redirect: 'follow' }); } catch (e) {
    if (signal && signal.aborted) throw cancelled();
    throw new VideogenError(`下载失败：${e.message || e}`, 'NETWORK');
  }
  if (!res.ok) {
    const gone = res.status === 403 || res.status === 404 || res.status === 410;
    throw new VideogenError(gone ? `视频下载链接已失效（HTTP ${res.status}），服务商通常只保留 24 小时，请重新生成` : `下载视频失败（HTTP ${res.status}）`, 'HTTP', res.status);
  }
  const total = Number(res.headers && res.headers.get && res.headers.get('content-length')) || 0;
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  let got = 0;
  try {
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      for (;;) {
        if (signal && signal.aborted) throw cancelled();
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
        if (onProgress && total) onProgress(got / total);
      }
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      got = buf.length;
      out.write(buf);
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  } catch (e) {
    out.destroy();
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
  if (!got) { try { fs.unlinkSync(tmp); } catch {} throw new VideogenError('下载到的视频为空', 'EMPTY'); }
  fs.renameSync(tmp, dest);
  return dest;
}

/**
 * 带重试的下载：网络中断、服务器 5xx、下到空文件时等一会儿再试（默认共 3 次）；
 * 链接失效（403/404/410）等重试也没用的错误直接抛出。
 */
async function downloadWithRetry(fetchFn, url, dest, { tries = 3, delays = [1500, 4000], sleepFn = sleep, ...opts } = {}) {
  let last = null;
  for (let i = 0; i < Math.max(1, tries); i++) {
    try { return await downloadTo(fetchFn, url, dest, opts); } catch (e) {
      if (e && e.code === 'CANCELLED') throw e;
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
