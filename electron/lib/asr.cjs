'use strict';
// 自动语音字幕（ASR）核心库。不依赖 electron，便于 node 测试。
// 引擎优先级：本地 whisper.cpp（whisper-cli + ggml 模型） > OpenAI 转写 API（whisper-1，verbose_json 词级时间戳）。
// 输出统一：segments [{ start, end, text, words?: [{start,end,text}] }]
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { run } = require('./proc.cjs');
const urlSafety = require('./urlSafety.cjs');

// 模型 URL 与 SHA1 已于 2026-11-08 核实：来源 https://huggingface.co/ggerganov/whisper.cpp 模型表
// （base 142 MiB / 147951465 字节，small 466 MiB；多语言版，非 .en/量化版）。HEAD 请求 resolve/main 链接返回 200。
const MODELS = {
  base: {
    file: 'ggml-base.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
    size: 0,
    sha1: '465707469ff3a37a2b9b8d8f89f2f99de7299dac',
  },
  small: {
    file: 'ggml-small.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
    size: 0,
    sha1: '55356645c2b361a969dfd0ef2c5a50d530afd8d5',
  },
};
// 2026-11-08 核实：https://github.com/ggml-org/whisper.cpp/releases/tag/v1.7.6 资产 whisper-bin-x64.zip 存在（HEAD 200，3675974 字节）。
// 最新版 v1.9.5 起 Windows 二进制改挂在 bNNNN nightly 标签，资产名不稳定，故固定使用 v1.7.6（含 whisper-cli.exe）。
const WHISPER_BIN_ZIP = 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.6/whisper-bin-x64.zip';
// 2026-11-26 核实：取自 GitHub Releases API `repos/ggml-org/whisper.cpp/releases/tags/v1.7.6`
// 资产 `whisper-bin-x64.zip`（3675974 字节，updated_at 2025-06-25T18:28:55Z）官方 digest 字段。
const WHISPER_BIN_SHA256 = '0d2eca299c248f965bd0341bcb219db4b433c7f0c0ce2200d4df85765e8156a9';
const BIN_NAMES = process.platform === 'win32' ? ['whisper-cli.exe', 'main.exe'] : ['whisper-cli', 'main'];

function cancelledError() { const e = new Error('已取消'); e.code = 'CANCELLED'; return e; }

// ─────────────── ffmpeg 抽音 ───────────────
function buildWavArgs(input, output, { start, duration } = {}) {
  const args = ['-hide_banner', '-nostdin', '-y'];
  if (Number(start) > 0) args.push('-ss', String(start));
  args.push('-i', input);
  if (Number(duration) > 0) args.push('-t', String(duration));
  args.push('-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', output);
  return args;
}

async function extractWav(ffmpeg, input, output, opts = {}) {
  if (!ffmpeg) throw new Error('找不到 ffmpeg');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const runner = opts.run || run;
  const r = await runner(ffmpeg, buildWavArgs(input, output, opts), { signal: opts.signal });
  if (r && r.code !== 0) throw new Error('抽取音频失败：' + String(r.stderr || '').split(/\r?\n/).filter(Boolean).slice(-2).join(' '));
  return output;
}

// ─────────────── 文本清洗与中文断句 ───────────────
const PUNCT_RE = /[，。、！？；：,.!?;:…“”"‘’'（）()【】\[\]《》<>~～—-]+/g;
const BREAK_RE = /[。！？!?；;…]/;
const SOFT_BREAK_RE = /[，,、：:]/;

function cleanText(s) {
  return String(s || '')
    .replace(/\[(?:_?BEG_?|_?TT_\d+|BLANK_AUDIO|音乐|Music|MUSIC)[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 去字幕标点：句内标点换为空格，句末去掉；中文之间空格去掉 */
function stripPunct(s) {
  return cleanText(s)
    .replace(PUNCT_RE, ' ')
    .replace(/([㐀-鿿])\s+(?=[㐀-鿿])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function textLen(s) { return Array.from(String(s || '').replace(/\s/g, '')).length; }

/**
 * 断句：把过长段落按标点（优先句末，再逗号）拆分，时间按字数比例分配；无标点按 maxChars 硬切。
 * 若段落有词级时间，按词边界取时间。
 */
function splitSentences(segments, { maxChars = 16, punct = false } = {}) {
  const out = [];
  for (const seg of segments || []) {
    const text = cleanText(seg.text);
    if (!text) continue;
    const pieces = [];
    let buf = '';
    for (const ch of Array.from(text)) {
      buf += ch;
      if (BREAK_RE.test(ch) || (SOFT_BREAK_RE.test(ch) && textLen(buf) >= Math.ceil(maxChars / 2))) { pieces.push(buf); buf = ''; }
    }
    if (buf.trim()) pieces.push(buf);
    // 硬切过长片段
    const finals = [];
    for (const p of pieces) {
      const chars = Array.from(p);
      if (textLen(p) <= maxChars * 2) { finals.push(p); continue; }
      for (let i = 0; i < chars.length; i += maxChars * 2) finals.push(chars.slice(i, i + maxChars * 2).join(''));
    }
    const total = finals.reduce((a, p) => a + Math.max(1, textLen(p)), 0) || 1;
    const dur = Math.max(0, seg.end - seg.start);
    let t = seg.start;
    let wi = 0;
    const words = Array.isArray(seg.words) ? seg.words : null;
    for (const p of finals) {
      const share = Math.max(1, textLen(p)) / total;
      let start = t;
      let end = t + dur * share;
      let pw;
      if (words && words.length) {
        // 按字符数消耗词
        let need = textLen(stripPunct(p));
        pw = [];
        while (wi < words.length && need > 0) { pw.push(words[wi]); need -= Math.max(1, textLen(stripPunct(words[wi].text))); wi++; }
        if (pw.length) { start = pw[0].start; end = pw[pw.length - 1].end; }
      }
      const txt = punct ? p.trim() : stripPunct(p);
      if (txt) out.push({ start: r3(start), end: r3(Math.max(end, start + 0.2)), text: txt, ...(pw && pw.length ? { words: pw } : {}) });
      t += dur * share;
    }
  }
  return out;
}

function r3(v) { return Math.round(Number(v) * 1000) / 1000; }

// ─────────────── 解析 ───────────────
function tsToSec(s) {
  const m = /(\d+):(\d+):(\d+)[.,](\d+)/.exec(String(s || ''));
  if (!m) return 0;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 10 ** m[4].length;
}

/** whisper.cpp `-oj`/`-ojf` 输出的 JSON：{ transcription:[{ timestamps:{from,to}, offsets:{from,to}(ms), text, tokens? }] } */
function parseWhisperJson(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const list = (data && data.transcription) || [];
  const segs = [];
  for (const it of list) {
    const start = it.offsets ? it.offsets.from / 1000 : tsToSec(it.timestamps && it.timestamps.from);
    const end = it.offsets ? it.offsets.to / 1000 : tsToSec(it.timestamps && it.timestamps.to);
    const text = cleanText(it.text);
    if (!text) continue;
    let words;
    if (Array.isArray(it.tokens)) {
      words = it.tokens
        .filter((tk) => tk && tk.offsets && cleanText(tk.text) && !/^\[_/.test(tk.text))
        .map((tk) => ({ start: r3(tk.offsets.from / 1000), end: r3(tk.offsets.to / 1000), text: cleanText(tk.text) }));
      if (!words.length) words = undefined;
    }
    segs.push({ start: r3(start), end: r3(end), text, ...(words ? { words } : {}) });
  }
  return segs;
}

/** OpenAI verbose_json：{ segments:[{start,end,text}], words?:[{word,start,end}] } */
function parseOpenAIVerbose(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const words = Array.isArray(data && data.words) ? data.words.map((w) => ({ start: r3(w.start), end: r3(w.end), text: cleanText(w.word) })).filter((w) => w.text) : [];
  let segs = Array.isArray(data && data.segments) ? data.segments : [];
  if (!segs.length && data && data.text) segs = [{ start: 0, end: data.duration || (words.length ? words[words.length - 1].end : 0), text: data.text }];
  return segs.map((s) => {
    const text = cleanText(s.text);
    const ws = words.filter((w) => w.start >= s.start - 0.01 && w.end <= s.end + 0.01);
    return { start: r3(s.start), end: r3(s.end), text, ...(ws.length ? { words: ws } : {}) };
  }).filter((s) => s.text);
}

// ─────────────── whisper.cpp ───────────────
function modelsDir(userData) { return path.join(userData, 'models'); }

function findWhisperBin(userData, extra = []) {
  const dirs = [...extra, path.join(userData, 'bin', 'whisper'), path.join(userData, 'bin')];
  for (const d of dirs) {
    if (!d) continue;
    for (const n of BIN_NAMES) {
      const p = path.join(d, n);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* */ }
    }
    // zip 解压后可能在子目录 Release/
    const sub = path.join(d, 'Release');
    for (const n of BIN_NAMES) {
      const p = path.join(sub, n);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* */ }
    }
  }
  return null;
}

function findModel(userData, prefer = 'small') {
  const order = prefer === 'base' ? ['base', 'small'] : ['small', 'base'];
  for (const k of order) {
    const p = path.join(modelsDir(userData), MODELS[k].file);
    try { const st = fs.statSync(p); if (st.size > 1024 * 1024) return { name: k, path: p }; } catch { /* */ }
  }
  return null;
}

function buildWhisperArgs({ model, wav, outBase, lang = 'zh', threads = 4 }) {
  const args = ['-m', model, '-f', wav, '-l', lang || 'auto', '-oj', '-ojf', '-of', outBase, '-t', String(threads), '-np'];
  if (lang === 'zh') args.push('--prompt', '以下是普通话的句子，使用简体中文。');
  return args;
}

async function transcribeWhisper({ bin, model, wav, lang, signal, onProgress, run: runner = run, tmpDir }) {
  const outBase = path.join(tmpDir || path.dirname(wav), 'asr_' + crypto.randomBytes(4).toString('hex'));
  const args = buildWhisperArgs({ model, wav, outBase, lang, threads: Math.max(2, Math.min(8, require('node:os').cpus().length - 1)) });
  args.push('-pp');
  const r = await runner(bin, args, {
    signal,
    onStderr: (t) => {
      const m = /progress\s*=\s*(\d+)%/.exec(t);
      if (m && onProgress) onProgress(Number(m[1]) / 100);
    },
  });
  if (r && r.code !== 0) throw new Error('whisper 转写失败：' + String(r.stderr || '').split(/\r?\n/).filter(Boolean).slice(-2).join(' '));
  const file = outBase + '.json';
  const txt = fs.readFileSync(file, 'utf8');
  try { fs.unlinkSync(file); } catch { /* */ }
  return parseWhisperJson(txt);
}

// ─────────────── OpenAI ───────────────
const OPENAI_ASR_TIMEOUT_MS = 180 * 1000;
const DOWNLOAD_TIMEOUT_MS = 60 * 1000;
const DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024;

async function transcribeOpenAI({ wav, key, baseUrl = 'https://api.openai.com/v1', model = 'whisper-1', lang = 'zh', signal, fetchImpl, timeoutMs = OPENAI_ASR_TIMEOUT_MS }) {
  const f = fetchImpl || globalThis.fetch;
  if (signal && signal.aborted) throw cancelledError();
  const buf = fs.readFileSync(wav);
  if (buf.length > 25 * 1024 * 1024) throw new Error('音频超过 25MB，OpenAI 转写不支持，请安装本地模型');
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  form.append('timestamp_granularities[]', 'word');
  if (lang && lang !== 'auto') form.append('language', lang);
  const url = String(baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/audio/transcriptions';
  const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : OPENAI_ASR_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(limit);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res;
  try {
    res = await f(url, { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: form, signal: combined });
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.text()).slice(0, 300); } catch { /* */ }
      throw new Error(`OpenAI 转写失败（${res.status}）${msg}`);
    }
    return parseOpenAIVerbose(await res.json());
  } catch (err) {
    if (signal && signal.aborted) throw cancelledError();
    if (timeout.aborted) {
      const te = new Error(`OpenAI 转写超时（超过 ${Math.round(limit / 1000)} 秒），请稍后重试`);
      te.code = 'TIMEOUT';
      throw te;
    }
    throw err;
  }
}

// ─────────────── 下载与校验 ───────────────
async function sha1File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

async function download(url, dest, { signal, onProgress, fetchImpl, timeoutMs = DOWNLOAD_TIMEOUT_MS, maxBytes = DOWNLOAD_MAX_BYTES, allowedOrigins = [], maxRedirects = 5, lookup } = {}) {
  const f = fetchImpl || globalThis.fetch;
  const isMockFetch = typeof fetchImpl === 'function' && fetchImpl !== globalThis.fetch;
  const checkUrl = (isMockFetch && !lookup)
    ? (u, o) => urlSafety.assertSafePublicUrl(u, o)
    : (u, o) => urlSafety.assertSafePublicUrlAsync(u, { ...o, lookup });
  if (signal && signal.aborted) throw cancelledError();
  let curParsed = await checkUrl(url, { allowedOrigins });
  let curUrl = curParsed.href;
  const redirectLimit = Math.max(0, Number.isFinite(Number(maxRedirects)) ? Number(maxRedirects) : 5);
  const limitMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : DOWNLOAD_TIMEOUT_MS;
  const maxSize = Number(maxBytes) > 0 ? Number(maxBytes) : 0;
  const ac = new AbortController();
  let timedOut = false;
  let idleTimer = null;
  const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
  const armIdle = () => {
    clearIdle();
    idleTimer = setTimeout(() => {
      timedOut = true;
      ac.abort(new Error('下载超时'));
    }, limitMs);
    if (idleTimer.unref) idleTimer.unref();
  };
  const onAbort = () => ac.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  let part = null;
  let ws = null;
  let wsClosed = null;
  let wsIsClosed = true;
  let got = 0;
  try {
    let res;
    for (let hop = 0; ; hop++) {
      armIdle();
      res = await f(curUrl, { signal: ac.signal, redirect: 'manual' });
      if (res && res.url) {
        await checkUrl(res.url, { allowedOrigins });
      }
      const status = Number(res && res.status) || 0;
      const loc = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
      if (status >= 300 && status < 400 && loc) {
        try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch {}
        if (hop >= redirectLimit) {
          const err = new Error('下载重定向次数过多');
          err.code = 'REDIRECT';
          throw err;
        }
        let resolved;
        try {
          resolved = new URL(loc, curUrl).href;
        } catch {
          const err = new Error('下载重定向地址无效');
          err.code = 'BAD_URL';
          throw err;
        }
        curParsed = await checkUrl(resolved, { allowedOrigins });
        curUrl = curParsed.href;
        continue;
      }
      break;
    }
    if (!res.ok || !res.body) throw new Error(`下载失败（${res.status}）：${curUrl}`);
    const total = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : 0) || 0;
    if (maxSize && total > maxSize) throw new Error('下载文件超过大小限制');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    part = `${dest}.${crypto.randomBytes(4).toString('hex')}.part`;
    ws = fs.createWriteStream(part);
    wsIsClosed = false;
    let writeErr = null;
    ws.on('error', (err) => { writeErr = err; });
    wsClosed = new Promise((resolve) => ws.once('close', () => { wsIsClosed = true; resolve(); }));

    for await (const chunk of res.body) {
      armIdle();
      if (signal && signal.aborted) throw cancelledError();
      if (writeErr) throw writeErr;
      got += chunk.length;
      if (maxSize && got > maxSize) throw new Error('下载文件超过大小限制');
      if (!ws.write(chunk)) {
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            ws.off('drain', onDrain);
            ws.off('error', onErr);
            ws.off('close', onClose);
          };
          const onDrain = () => { cleanup(); resolve(); };
          const onErr = (err) => { cleanup(); reject(err); };
          const onClose = () => { cleanup(); reject(writeErr || new Error('写入流意外关闭')); };
          ws.once('drain', onDrain);
          ws.once('error', onErr);
          ws.once('close', onClose);
        });
      }
      if (onProgress && total) onProgress(got / total, got, total);
    }
    if (writeErr) throw writeErr;
    await new Promise((resolve, reject) => {
      const onErr = (err) => { ws.off('close', onClose); reject(err); };
      const onClose = () => { ws.off('error', onErr); if (writeErr) reject(writeErr); else resolve(); };
      ws.once('error', onErr);
      ws.once('close', onClose);
      ws.end();
    });
    ws = null;
    clearIdle();
    try {
      fs.renameSync(part, dest);
    } catch (renameErr) {
      if (renameErr && (renameErr.code === 'EEXIST' || renameErr.code === 'EPERM')) {
        try { fs.unlinkSync(dest); } catch { /* */ }
        fs.renameSync(part, dest);
      } else {
        throw renameErr;
      }
    }
    return { path: dest, size: got };
  } catch (e) {
    clearIdle();
    if (!ac.signal.aborted) ac.abort();
    if (ws) {
      try { ws.destroy(); } catch { /* */ }
      if (!wsIsClosed && wsClosed) {
        let closeTimer = null;
        try {
          await Promise.race([
            wsClosed,
            new Promise((r) => {
              closeTimer = setTimeout(r, 2000);
              if (closeTimer && typeof closeTimer.unref === 'function') closeTimer.unref();
            }),
          ]);
        } finally {
          if (closeTimer) clearTimeout(closeTimer);
        }
      }
      ws = null;
    }
    if (part) { try { fs.unlinkSync(part); } catch { /* */ } }
    if (signal && signal.aborted) throw cancelledError();
    if (timedOut) {
      const te = new Error('下载超时，请检查网络后重试');
      te.code = 'TIMEOUT';
      throw te;
    }
    throw e;
  } finally {
    clearIdle();
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function verifyModel(file, name) {
  const m = MODELS[name];
  const st = fs.statSync(file);
  if (m.size && st.size !== m.size) return false;
  if (m.sha1) return (await sha1File(file)) === m.sha1;
  return true;
}

module.exports = {
  MODELS, WHISPER_BIN_ZIP, WHISPER_BIN_SHA256, BIN_NAMES,
  buildWavArgs, extractWav,
  cleanText, stripPunct, textLen, splitSentences,
  parseWhisperJson, parseOpenAIVerbose, tsToSec,
  modelsDir, findWhisperBin, findModel, buildWhisperArgs, transcribeWhisper,
  transcribeOpenAI, download, sha1File, sha256File, verifyModel,
};
