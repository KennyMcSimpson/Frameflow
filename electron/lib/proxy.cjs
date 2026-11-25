'use strict';
// 剪辑代理：>1080p 或 HEVC/ProRes 等重解码素材后台转 540p 全 I 帧 H.264，时间线拖动/逐帧更流畅。
// 纯 node 模块（不 require electron）。导出成品时仍使用原片。
// 编码器由 encoders.cjs 选（显卡优先，失败自动换下一个；契约 C12）。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const encoders = require('./encoders.cjs');

const PROXY_HEIGHT = 540;
const HEAVY_CODECS = new Set(['hevc', 'h265', 'prores', 'av1', 'vp9', 'dnxhd', 'mpeg2video']);

/** 是否需要剪辑代理（依据 probe 结果） */
function needsEditProxy(info) {
  if (!info || info.kind !== 'video') return false;
  const w = Number(info.width) || 0;
  const h = Number(info.height) || 0;
  const shortSide = Math.min(w, h);
  if (shortSide > 1080) return true;
  const v = String(info.vcodec || '').toLowerCase();
  return HEAVY_CODECS.has(v);
}

/** 代理输出路径（同一源文件签名稳定） */
function proxyPathFor(dir, file, sig = '') {
  const stem = path.basename(file, path.extname(file)).replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40) || 'media';
  const h = crypto.createHash('sha1').update(`${path.resolve(file)}|${sig}|edit540`).digest('hex').slice(0, 10);
  return path.join(dir, `${stem}-${h}.edit540.mp4`);
}

/** 默认视频编码参数（不探测编码器时用）：x264 最快档、全 I 帧 */
function defaultVideoArgs() {
  return encoders.h264Args('libx264', { quality: 'proxy', purpose: 'proxy', gop: 1 });
}

/**
 * ffmpeg 参数：540p（按短边）、全 I 帧、AAC。
 * @param {object} [enc] encoders.pickH264 的结果（须带 gop:1）；缺省用 x264
 */
function proxyArgs(input, output, info = {}, enc = null) {
  const portrait = (Number(info.height) || 0) > (Number(info.width) || 0);
  const scale = portrait ? `scale=${PROXY_HEIGHT}:-2` : `scale=-2:${PROXY_HEIGHT}`;
  const venc = enc && Array.isArray(enc.args) && enc.args.length ? enc.args : defaultVideoArgs();
  return ['-hide_banner', '-nostdin', '-v', 'error', '-stats', '-y', '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
    '-vf', `${scale}:flags=bilinear,format=${encoders.pixFmtOf(venc)}`,
    ...venc,
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', '+faststart', '-f', 'mp4', output];
}

function parseTime(text) {
  const re = /time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/g;
  let m; let last = null;
  while ((m = re.exec(text))) last = m;
  return last ? Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]) : null;
}

/**
 * 生成代理。已存在且非空则直接复用。编码器按优先级选，某个编码器失败自动换下一个。
 * @param {{ffmpeg:string, input:string, output:string, info?:object, signal?:AbortSignal, onProgress?:Function, preferHw?:boolean}} o
 * @returns {Promise<string>} 代理路径
 */
async function makeEditProxy({ ffmpeg, input, output, info = {}, signal, onProgress, preferHw = true } = {}) {
  if (!ffmpeg) throw new Error('找不到 ffmpeg，无法生成剪辑代理');
  try { const st = await fs.promises.stat(output); if (st.size > 0) { onProgress && onProgress(1); return output; } } catch {}
  if (signal && signal.aborted) { const e = new Error('已取消'); e.code = 'CANCELLED'; throw e; }
  await fs.promises.mkdir(path.dirname(output), { recursive: true });
  const dur = Number(info.duration) || 0;
  let best = 0; // 换编码器重来时进度不倒退
  const once = (enc) => {
    if (signal && signal.aborted) { const e = new Error('已取消'); e.code = 'CANCELLED'; return Promise.reject(e); }
    const tmp = `${output}.${crypto.randomBytes(3).toString('hex')}.part.mp4`;
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) { const e = new Error('已取消'); e.code = 'CANCELLED'; reject(e); return; }
      let settled = false;
      const p = spawn(ffmpeg, proxyArgs(input, tmp, info, enc), { windowsHide: true });
      let tail = '';
      const onAbort = () => { try { p.kill(); } catch {} };
      const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort); };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      p.stderr.on('data', (d) => {
        tail = (tail + d).slice(-600);
        const t = parseTime(tail);
        if (dur && t != null && onProgress) {
          const v = Math.min(0.99, t / dur);
          if (v > best) { best = v; try { onProgress(v); } catch {} }
        }
      });
      p.on('error', (e) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(e);
      });
      p.on('close', (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (signal && signal.aborted) { const e = new Error('已取消'); e.code = 'CANCELLED'; reject(e); return; }
        if (code === 0) resolve(tmp);
        else reject(new Error(`生成剪辑代理失败（${tail.split(/\r?\n/).filter((l) => l && !/time=/.test(l)).slice(-1)[0] || code}）`));
      });
    }).catch(async (e) => { await fs.promises.rm(tmp, { force: true }).catch(() => {}); throw e; });
  };
  const w = Number(info.width) || 0;
  const h = Number(info.height) || 0;
  const k = w && h ? PROXY_HEIGHT / Math.min(w, h) : 1;
  const tmp = await encoders.withH264({
    ffmpegPath: ffmpeg, purpose: 'proxy', quality: 'proxy', gop: 1, preferHw,
    width: w ? Math.round(w * k) : 960, height: h ? Math.round(h * k) : 540, fps: info.fps,
  }, once);
  await fs.promises.rm(output, { force: true }).catch(() => {});
  await fs.promises.rename(tmp, output);
  if (onProgress) onProgress(1);
  return output;
}

module.exports = { needsEditProxy, proxyPathFor, proxyArgs, makeEditProxy, PROXY_HEIGHT, _internals: { parseTime } };
