'use strict';
// 编码器探测与选择（_ff4_notes/CONTRACTS-w4.md C12）。纯 node 模块（不依赖 electron），便于单测。
//
// 为什么要“真编码 1 帧”：ffmpeg -encoders 只说明“编译进来了”，不代表这台机器能用。
// 实测 AMF 会出现“列出来但用不了”（缺 amfrt64.dll），没有对应显卡的 nvenc/qsv 同理。
// 思路参考 openreel-video（MIT）的 encoder-probe（解析 -encoders 列表）；openreel 只看列表，我们额外逐个试编码。
//
// 选择顺序：h264_nvenc > h264_qsv > h264_amf > h264_mf > libx264 > libopenh264。
// h264_mf（Windows Media Foundation）分两种：带 -hw_encoding 1 试编码通过 = 显卡编码，按上面的顺序排；
// 只有软件编码器可用时画质不如 x264，排到最后兜底（LGPL 构建没有 x264，也没有 openh264 时才会用到）。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('./proc.cjs');

const H264_ORDER = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'libx264', 'libopenh264'];
const HEVC_ORDER = ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_mf', 'libx265'];
const HW_H264 = new Set(['h264_nvenc', 'h264_qsv', 'h264_amf']);
const CPU_H264 = ['libx264', 'libopenh264'];
const QUALITIES = ['high', 'standard', 'small', 'proxy'];
const PURPOSES = ['export', 'proxy', 'videogen', 'preview'];

// 质量映射。high 对齐 x264 crf18（docs/research/export-perf.md §2.7 的初值，来自合成素材，待真实素材校准）
const X264_CRF = { high: 18, standard: 21, small: 26, proxy: 23 };
const NVENC_CQ = { high: 26, standard: 28, small: 31, proxy: 30 };
const QSV_GQ = { high: 21, standard: 24, small: 28, proxy: 26 };
const AMF_QP = { high: 20, standard: 23, small: 27, proxy: 26 };
const MF_Q = { high: 85, standard: 75, small: 62, proxy: 65 };
// 没有恒定质量模式的编码器（openh264）按每像素码率估算目标码率
const BPP = { high: 0.14, standard: 0.1, small: 0.07, proxy: 0.08 };

const LABELS = {
  h264_nvenc: 'NVIDIA 显卡加速',
  h264_qsv: 'Intel 核显加速',
  h264_amf: 'AMD 显卡加速',
  h264_mf: 'Windows 显卡加速',
  h264_mf_sw: 'Windows 系统编码',
  libx264: 'CPU 编码（高画质）',
  libopenh264: 'CPU 编码（兼容模式）',
};

const CACHE_VERSION = 2; // 候选列表或试编码参数变化时 +1，旧缓存自动作废
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000; // 一周重新探测一次（换了显卡/驱动也能发现）
const TRIAL_TIMEOUT_MS = 8000;
const TRIAL_CONCURRENCY = 3;

let cacheFile = null;
const memo = new Map(); // ffmpegPath(规范化) -> Promise<probeResult>
const failed = new Map(); // ffmpegPath(规范化) -> Map<encoder, 次数>：本次运行中实际编码失败（换别的编码器成功）的次数
// 失败 2 次才停用：显卡编码偶尔会因为同时开的编码任务太多（消费级 N 卡有路数限制）临时失败，不能一次就判死
const FAIL_LIMIT = 2;

function normKey(p) {
  const abs = path.resolve(String(p || ''));
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/** 指定探测结果的磁盘缓存文件（主进程启动时由 ipc/media.cjs 设为 userData/encoders.json） */
function setCacheFile(file) {
  cacheFile = file ? String(file) : null;
}

/** 解析 `ffmpeg -encoders` 输出，返回其中出现的视频编码器名（纯函数） */
function parseEncoderList(text) {
  const found = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*V[A-Z.]{5}\s+(\S+)/.exec(line);
    if (m) found.add(m[1]);
  }
  return found;
}

function estimateKbps(width, height, fps, quality = 'high') {
  const w = Number(width) > 0 ? Number(width) : 1920;
  const h = Number(height) > 0 ? Number(height) : 1080;
  const f = Number(fps) > 0 ? Math.min(120, Number(fps)) : 30;
  const k = Math.round((w * h * f * (BPP[quality] || BPP.high)) / 1000);
  return Math.max(300, Math.min(80000, k));
}

/**
 * 某个 H.264 编码器的完整参数（含 -c:v、码率/质量、-pix_fmt；可选 GOP）。纯函数。
 * @param {string} encoder
 * @param {{quality?:string, purpose?:string, bitrateKbps?:number, width?:number, height?:number, fps?:number, gop?:number, mfHw?:boolean}} o
 */
function h264Args(encoder, o = {}) {
  const q = QUALITIES.includes(o.quality) ? o.quality : 'high';
  const purpose = PURPOSES.includes(o.purpose) ? o.purpose : 'export';
  const fastest = purpose === 'proxy'; // 剪辑代理：越快越好
  const quick = purpose === 'preview' || purpose === 'videogen';
  const br = Math.max(0, Math.round(Number(o.bitrateKbps) || 0));
  const rate = (k) => ['-b:v', `${k}k`, '-maxrate', `${Math.round(k * 1.5)}k`, '-bufsize', `${k * 2}k`];
  const args = ['-c:v', encoder];
  switch (encoder) {
    case 'h264_nvenc':
      args.push('-preset', fastest ? 'p2' : quick ? 'p4' : 'p5', '-tune', 'hq');
      if (br) args.push('-rc', 'vbr', ...rate(br));
      else args.push('-rc', 'vbr', '-cq', String(NVENC_CQ[q]), '-b:v', '0');
      args.push('-profile:v', 'high', '-pix_fmt', 'yuv420p');
      break;
    case 'h264_qsv':
      args.push('-preset', fastest ? 'veryfast' : quick ? 'faster' : 'medium');
      if (br) args.push(...rate(br));
      else args.push('-global_quality', String(QSV_GQ[q]));
      args.push('-pix_fmt', 'nv12');
      break;
    case 'h264_amf':
      args.push('-quality', fastest || quick ? 'speed' : 'balanced');
      if (br) args.push('-rc', 'vbr_peak', ...rate(br));
      else {
        const qp = AMF_QP[q];
        args.push('-rc', 'cqp', '-qp_i', String(qp), '-qp_p', String(qp + 2), '-qp_b', String(qp + 4));
      }
      args.push('-pix_fmt', 'yuv420p');
      break;
    case 'h264_mf':
      if (o.mfHw) args.push('-hw_encoding', '1');
      if (br) args.push('-rate_control', 'u_vbr', '-b:v', `${br}k`);
      else args.push('-rate_control', 'quality', '-quality', String(MF_Q[q]));
      args.push('-pix_fmt', 'nv12');
      break;
    case 'libopenh264': {
      const k = br || estimateKbps(o.width, o.height, o.fps, q);
      args.push('-b:v', `${k}k`, '-maxrate', `${Math.round(k * 1.5)}k`, '-pix_fmt', 'yuv420p');
      break;
    }
    case 'libx264':
    default:
      args[1] = 'libx264';
      args.push('-preset', fastest ? 'ultrafast' : 'veryfast');
      if (fastest) args.push('-tune', 'fastdecode');
      if (br) args.push(...rate(br));
      else args.push('-crf', String(X264_CRF[q]));
      args.push('-pix_fmt', 'yuv420p');
      break;
  }
  const gop = Math.round(Number(o.gop) || 0);
  if (gop > 0) {
    // 短 GOP（代理素材拖动更跟手）：固定关键帧间隔、不插场景切换关键帧、不用 B 帧
    args.push('-g', String(gop), '-bf', '0');
    if (args[1] === 'libx264') args.push('-keyint_min', String(gop), '-sc_threshold', '0');
  }
  return args;
}

/** 某参数数组里的 -pix_fmt 值（滤镜链末尾直接转到这个格式，省一次转换） */
function pixFmtOf(args, fallback = 'yuv420p') {
  const i = Array.isArray(args) ? args.indexOf('-pix_fmt') : -1;
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

/** 试编码参数：1 帧 256×256 纯色画面编到空输出 */
function trialArgs(encoder, { mfHw = false } = {}) {
  let enc;
  if (encoder.startsWith('h264_') || encoder === 'libx264' || encoder === 'libopenh264') {
    enc = h264Args(encoder, { quality: 'high', purpose: 'export', width: 256, height: 256, fps: 30, mfHw });
  } else {
    enc = ['-c:v', encoder, '-pix_fmt', /_(qsv|mf)$/.test(encoder) ? 'nv12' : 'yuv420p'];
  }
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=30',
    '-frames:v', '1', '-an', ...enc, '-f', 'null', '-'];
}

async function trial(runner, ffmpegPath, encoder, opts) {
  try {
    const r = await runner(ffmpegPath, trialArgs(encoder, opts), { timeoutMs: TRIAL_TIMEOUT_MS });
    return !!r && r.code === 0;
  } catch { return false; }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function fileSigSync(file) {
  try {
    const st = fs.statSync(file);
    return `${st.size}|${Math.round(st.mtimeMs)}|${os.release()}|v${CACHE_VERSION}`;
  } catch { return null; }
}

function readCache() {
  if (!cacheFile) return {};
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    return j && j.version === CACHE_VERSION && j.entries && typeof j.entries === 'object' ? j.entries : {};
  } catch { return {}; }
}

function writeCache(mutate) {
  if (!cacheFile) return;
  try {
    const entries = readCache();
    mutate(entries);
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, entries }, null, 1));
    fs.renameSync(tmp, cacheFile);
  } catch { /* 缓存写不进去不影响使用 */ }
}

function emptyResult(extra = {}) {
  return { h264: [], hevc: [], mfHw: false, at: Date.now(), ...extra };
}

async function doProbe(ffmpegPath, runner) {
  let listed;
  try {
    const r = await runner(ffmpegPath, ['-hide_banner', '-encoders'], { timeoutMs: 15000 });
    listed = parseEncoderList(r && r.stdout);
  } catch { return emptyResult({ error: 'ffmpeg 无法运行' }); }
  const tasks = [];
  for (const e of H264_ORDER) {
    if (!listed.has(e)) continue;
    if (e === 'h264_mf') { tasks.push({ e, mfHw: true }); tasks.push({ e, mfHw: false }); } else tasks.push({ e });
  }
  for (const e of HEVC_ORDER) if (listed.has(e)) tasks.push({ e, hevc: true });
  const ok = await mapLimit(tasks, TRIAL_CONCURRENCY, (t) => trial(runner, ffmpegPath, t.e, { mfHw: !!t.mfHw }));
  const passed = (pred) => tasks.filter((t, i) => ok[i] && pred(t)).map((t) => t.e);
  const h264 = H264_ORDER.filter((e) => passed((t) => !t.hevc).includes(e));
  const hevc = HEVC_ORDER.filter((e) => passed((t) => t.hevc).includes(e));
  const mfHw = tasks.some((t, i) => ok[i] && t.e === 'h264_mf' && t.mfHw);
  return { h264, hevc, mfHw, at: Date.now() };
}

/**
 * 探测可用编码器：只列出通过 1 帧试编码的。按 ffmpeg 路径缓存（内存 + 磁盘，磁盘缓存一周或 ffmpeg 变化后失效）。
 * @param {string} ffmpegPath
 * @param {{force?:boolean, runner?:Function}} [opts] runner 仅供单测注入
 * @returns {Promise<{h264:string[], hevc:string[], mfHw:boolean, at:number}>}
 */
function probeEncoders(ffmpegPath, opts = {}) {
  if (!ffmpegPath) return Promise.resolve(emptyResult({ error: '找不到 ffmpeg' }));
  const key = normKey(ffmpegPath);
  const runner = opts.runner || run;
  if (!opts.force && memo.has(key)) return memo.get(key);
  const p = (async () => {
    const sig = fileSigSync(ffmpegPath);
    if (!opts.force && !opts.runner && sig) {
      const hit = readCache()[key];
      if (hit && hit.sig === sig && Date.now() - (hit.at || 0) < CACHE_TTL_MS && Array.isArray(hit.h264)) {
        return { h264: hit.h264, hevc: Array.isArray(hit.hevc) ? hit.hevc : [], mfHw: !!hit.mfHw, at: hit.at, cached: true };
      }
    }
    const res = await doProbe(ffmpegPath, runner);
    if (sig && !res.error && !opts.runner) writeCache((entries) => { entries[key] = { sig, ...res }; });
    return res;
  })();
  memo.set(key, p);
  p.catch(() => memo.delete(key));
  return p;
}

/** 按优先级排好的候选（纯函数） */
function rankH264(avail, { preferHw = true, mfHw = false, exclude = [] } = {}) {
  const list = Array.isArray(avail) ? avail : [];
  const ex = new Set(exclude || []);
  const ok = (e) => list.includes(e) && !ex.has(e);
  const isHw = (e) => HW_H264.has(e) || (e === 'h264_mf' && mfHw);
  const hw = preferHw ? H264_ORDER.filter((e) => ok(e) && isHw(e)) : [];
  const cpu = CPU_H264.filter(ok);
  // 兜底：软件 MF，以及“只用 CPU”但机器上没有 CPU 编码器时的显卡编码器
  const tail = H264_ORDER.filter((e) => ok(e) && !hw.includes(e) && !cpu.includes(e));
  return [...hw, ...cpu, ...tail];
}

function labelOf(encoder, mfHw) {
  if (encoder === 'h264_mf') return mfHw ? LABELS.h264_mf : LABELS.h264_mf_sw;
  return LABELS[encoder] || encoder;
}

function isHwEncoder(encoder, mfHw) {
  return HW_H264.has(encoder) || (encoder === 'h264_mf' && !!mfHw);
}

/**
 * 选 H.264 编码器并给出完整参数。
 * @param {{ffmpegPath?:string, quality?:'high'|'standard'|'small'|'proxy', preferHw?:boolean, purpose?:'export'|'proxy'|'videogen'|'preview',
 *          bitrateKbps?:number, width?:number, height?:number, fps?:number, gop?:number, exclude?:string[]}} o
 * @returns {Promise<{encoder:string, args:string[], hw:boolean, label:string, degraded?:boolean}>}
 *   args 已含 -c:v、码率/质量参数、-pix_fmt（gop>0 时还含 -g/-bf 等）；调用方不要再加自己的 -c:v/-crf/-preset/-pix_fmt。
 */
async function pickH264(o = {}) {
  const preferHw = o.preferHw !== false;
  let probed = emptyResult();
  if (o.ffmpegPath) { try { probed = await probeEncoders(o.ffmpegPath); } catch { /* 用兜底 */ } }
  const bad = o.ffmpegPath ? failed.get(normKey(o.ffmpegPath)) : null;
  const exclude = [...(o.exclude || []), ...(bad ? [...bad].filter(([, n]) => n >= FAIL_LIMIT).map(([e]) => e) : [])];
  const ranked = rankH264(probed.h264, { preferHw, mfHw: probed.mfHw, exclude });
  const encoder = ranked[0] || 'libx264';
  const mfHw = encoder === 'h264_mf' && probed.mfHw;
  const out = {
    encoder,
    args: h264Args(encoder, { ...o, mfHw }),
    hw: isHwEncoder(encoder, probed.mfHw),
    label: labelOf(encoder, probed.mfHw),
  };
  if (!ranked.length) out.degraded = true; // 没有任何编码器通过试编码：仍按 x264 试一次（与改造前一致）
  return out;
}

/**
 * 某编码器在实际任务中失败、换别的编码器又成功了：记一次。累计 2 次后本次运行不再选它，
 * 并删掉磁盘缓存，下次启动重新探测（驱动更新后可能又能用了）。
 */
function markFailed(ffmpegPath, encoder) {
  if (!ffmpegPath || !encoder) return;
  const key = normKey(ffmpegPath);
  if (!failed.has(key)) failed.set(key, new Map());
  const m = failed.get(key);
  const n = (m.get(encoder) || 0) + 1;
  m.set(encoder, n);
  if (n === FAIL_LIMIT) writeCache((entries) => { delete entries[key]; });
}

/**
 * 按优先级依次用编码器执行 fn(enc)，失败就换下一个（最多 3 次）。
 * 只有“换了编码器后成功”才把之前失败的编码器记为坏的——素材本身有问题时不会误伤显卡编码。
 * @template T
 * @param {object} pickOpts 同 pickH264
 * @param {(enc:{encoder:string,args:string[],hw:boolean,label:string}) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withH264(pickOpts, fn) {
  const tried = [];
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    const enc = await pickH264({ ...pickOpts, exclude: [...((pickOpts && pickOpts.exclude) || []), ...tried] });
    if (tried.includes(enc.encoder)) break;
    try {
      const r = await fn(enc);
      if (tried.length && pickOpts && pickOpts.ffmpegPath) tried.forEach((e) => markFailed(pickOpts.ffmpegPath, e));
      return r;
    } catch (e) {
      // 取消、或与编码器无关的错误（如保存文件失败，调用方设 noRetry）：不换编码器
      if (e && (e.code === 'CANCELLED' || e.noRetry)) throw e;
      lastErr = e;
      tried.push(enc.encoder);
      if (enc.degraded) break;
    }
  }
  throw lastErr || new Error('没有可用的视频编码器');
}

/**
 * 设置项 media.encoder → 是否优先显卡编码。
 * 'cpu' 只用 CPU；'gpu' 有显卡编码就用；'auto'（默认）一般也优先显卡，
 * 唯一例外：导出 1080p 及以下、机器 ≥8 核且有 x264 时用 CPU——此时编码不是瓶颈，x264 同画质文件更小（export-perf §2.7）。
 */
function preferHwFor(setting, { purpose = 'export', width, height, available } = {}) {
  if (setting === 'cpu') return false;
  if (setting === 'gpu') return true;
  if (purpose === 'export' && Array.isArray(available) && available.includes('libx264')) {
    const shortSide = Math.min(Number(width) || 1920, Number(height) || 1080);
    let cores = 8;
    try { cores = os.cpus().length || 8; } catch {}
    if (shortSide < 1440 && cores >= 8) return false;
  }
  return true;
}

/** 给设置页看的摘要 */
async function describeEncoders(ffmpegPath, { setting = 'auto', force = false } = {}) {
  const probed = await probeEncoders(ffmpegPath, { force });
  const auto = await pickH264({ ffmpegPath, preferHw: setting !== 'cpu' });
  return {
    setting: ['auto', 'gpu', 'cpu'].includes(setting) ? setting : 'auto',
    h264: probed.h264,
    hevc: probed.hevc,
    hasGpu: probed.h264.some((e) => isHwEncoder(e, probed.mfHw)),
    options: rankH264(probed.h264, { preferHw: true, mfHw: probed.mfHw }).map((e) => ({ encoder: e, label: labelOf(e, probed.mfHw), hw: isHwEncoder(e, probed.mfHw) })),
    selected: { encoder: auto.encoder, label: auto.label, hw: auto.hw, degraded: !!auto.degraded },
    checkedAt: probed.at || null,
  };
}

/** 仅供单测：清空内存缓存与失败记录 */
function _reset() { memo.clear(); failed.clear(); }

module.exports = {
  probeEncoders,
  pickH264,
  withH264,
  markFailed,
  preferHwFor,
  describeEncoders,
  setCacheFile,
  h264Args,
  pixFmtOf,
  rankH264,
  parseEncoderList,
  trialArgs,
  estimateKbps,
  labelOf,
  H264_ORDER,
  HEVC_ORDER,
  _reset,
};
