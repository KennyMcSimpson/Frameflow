// 导出驱动：逐帧精确 seek → renderFrame(mode:'export') → JPEG → 主进程 ffmpeg 编码（SPEC §2.2、CONTRACTS §C）。
//
// 流水线深度 1：第 i 帧在编码 / 传输时，第 i+1 帧已经在 seek 和合成，顺序严格保持。
// 取消：signal 触发后立即通知主进程 export:cancel，并抛出 Error{cancelled:true}。
// 进度：以 ffmpeg 实际编码的帧数为准（主进程在 job:progress 的 meta 里带上 encoded / outSec），
// 画面全部编码完后进入收尾封装，剩余时间显示「即将完成」。
// AI 标识（契约 C10）：工程用到 AI 素材时默认在画面角上加「AI 生成」并写入隐式元数据（GB 45438-2025）。
// 显卡编码中途出错时自动改用 CPU 重新导出一次。

import api from '../ui/api.js';
import { layoutVideo, projectDuration } from '../engine/timeline.js';
import { isCaptionText } from '../engine/model.js';
import { renderFrame, releaseRenderCache } from '../render/compositor.js';
import { createMediaPool } from '../render/mediaPool.js';
import { buildAudioPlan } from './audioPlan.js';
import * as Captions from '../engine/captions.js';
import * as License from '../engine/license.js';
import { resolveExportOptions } from './presets.js';
import { createExportProgress } from './exportProgress.js';
import { createJpegEncoder } from './jpegEncoder.js';
import { AI_LABEL_DEFAULT, normalizeAiLabel, drawAiLabel, projectUsesAiLoose, buildAigcMeta, makeProduceId } from './aigc.js';

// 中间帧质量与最终码率脱钩：文件大小由 ffmpeg 的质量参数决定，JPEG 只是传输环节，
// 各档都保持 ≥0.95，避免小体积档在暗部和渐变上出现二次压缩的色块
const JPEG_QUALITY = { high: 0.96, standard: 0.95, small: 0.95 };
const PROGRESS_INTERVAL = 100;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const even = (v) => Math.max(16, Math.round(num(v) / 2) * 2);

function cancelledError() {
  const e = new Error('导出已取消');
  e.cancelled = true;
  e.code = 'CANCELLED';
  return e;
}

/** 去掉 Electron IPC 附加的前缀，只保留给用户看的那句话 */
function readable(err) {
  const raw = String((err && err.message) || err || '未知错误');
  const msg = raw.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^(Error|TypeError|RangeError):\s*/, '');
  return msg || '未知错误';
}

function createCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (ctx) return { canvas, ctx };
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (ctx) return { canvas, ctx };
  }
  throw new Error('无法创建导出画布：当前环境不支持 Canvas');
}

function usedPaths(project, layout) {
  const assets = project.assets || {};
  const paths = new Set();
  for (const item of layout) {
    const a = assets[item.clip && item.clip.assetId];
    if (a && a.path) paths.add(a.path);
  }
  const audio = (project.tracks && project.tracks.audio) || [];
  for (const clip of audio) {
    const a = assets[clip.assetId];
    if (a && a.path) paths.add(a.path);
  }
  for (const o of Array.isArray(project.overlays) ? project.overlays : []) {
    const a = assets[o && o.assetId];
    if (a && a.path) paths.add(a.path);
  }
  return [...paths];
}

/** 导出时的 AI 角标：显式传了按传的（false 关闭）；没传时工程用到 AI 素材就默认打开（契约 C10） */
export function resolveAiLabel(project, aiLabel) {
  if (aiLabel === undefined) {
    let uses = false;
    try { uses = projectUsesAiLoose(project); } catch { uses = false; }
    return uses ? { ...AI_LABEL_DEFAULT } : null;
  }
  return normalizeAiLabel(aiLabel);
}

/** 隐式标识（文件元数据）：aigc === false 不写；传对象按对象；否则用到 AI 素材或打开了角标时写入 */
export function resolveAigcMeta(project, aigc, label) {
  if (aigc === false || aigc === null) return null;
  if (aigc && typeof aigc === 'object') return buildAigcMeta({ ...aigc, produceId: aigc.produceId || makeProduceId() });
  let uses = false;
  try { uses = projectUsesAiLoose(project); } catch { uses = false; }
  return uses || label || aigc === true ? buildAigcMeta({ produceId: makeProduceId() }) : null;
}

/** 署名文字（契约 C3）：传字符串就用它；false 不写；没传时按素材许可自动生成（没有需要署名的素材时为空） */
export function resolveCredits(project, credits) {
  if (credits === false || credits === null) return '';
  if (typeof credits === 'string') return credits.trim() ? credits : '';
  try {
    return typeof License.creditsText === 'function' ? String(License.creditsText(project) || '') : '';
  } catch {
    return '';
  }
}

const HW_FALLBACK_NOTICE = '显卡编码出错，已自动改用 CPU 重新导出';

/**
 * 导出整个项目。
 * @param {{project:object, outPath:string, width?:number, height?:number, fps?:number, quality?:'high'|'standard'|'small',
 *          onProgress?:(p:{phase:'render'|'encode',frame:number,total:number,fps:number,etaSec:number|null,etaLabel?:string,progress:number,notice?:string})=>void,
 *          signal?:AbortSignal, preset?:string, format?:string, bitrate?:number, srt?:boolean, hwaccel?:'auto'|'off',
 *          aiLabel?:false|{text?:string,corner?:string}, credits?:string|false, aigc?:boolean|object}} opts
 *   aiLabel 不传：工程用到 AI 素材时默认在右上角加「AI 生成」；credits 不传：按素材许可自动生成署名文字。
 *   onProgress 的 etaLabel 有值时（「即将完成」）界面应优先显示它。
 * @returns {Promise<{path:string,size:number,duration:number,encoder:string|null,srtPath:string|null,format:string,
 *          creditsPath:string|null,aiLabel:boolean,aigc:boolean,hw:boolean,encoderLabel:string,notice:string,fallback:boolean}>}
 */
export async function exportProject({ project, outPath, width, height, fps, quality = 'high', onProgress, signal, preset, format, bitrate, srt = false, hwaccel = 'auto', aiLabel, credits, aigc } = {}) {
  if (!project) throw new Error('没有可导出的项目');
  if (typeof outPath !== 'string' || !outPath.trim()) throw new Error('请选择导出保存位置');
  if (!api.available) throw new Error('导出需要在镜流桌面版中进行');
  if (signal && signal.aborted) throw cancelledError();

  const settings = project.settings || {};
  const resolved = preset || format ? resolveExportOptions(preset || 'custom', settings, { w: width, h: height, fps, bitrate, format }) : null;
  const W = even((resolved && resolved.w) || width || settings.width || 1920);
  const H = even((resolved && resolved.h) || height || settings.height || 1080);
  const F = Math.min(120, Math.max(1, resolved ? resolved.fps : num(fps) > 0 ? num(fps) : num(settings.fps) > 0 ? num(settings.fps) : 30));
  const audioOnly = !!(resolved && resolved.audioOnly);
  // 外挂字幕：字幕组文字不烧进画面，改写 .srt
  const srtTexts = srt ? captionTexts(project) : [];
  const renderProject = srt && srtTexts.length ? withoutCaptions(project) : project;
  const srtText = srtTexts.length ? toSrt(srtTexts) : '';
  const q = JPEG_QUALITY[quality] || JPEG_QUALITY.high;
  const label = audioOnly ? null : resolveAiLabel(project, aiLabel);
  const aigcMeta = resolveAigcMeta(project, aigc, label);
  const creditsText = resolveCredits(project, credits);

  const layout = layoutVideo(project);
  const duration = projectDuration(project, layout);
  if (!(duration > 0)) throw new Error('时间线为空，无法导出：请先把镜头放到时间线上');
  const total = Math.max(1, Math.ceil(duration * F - 1e-6));
  const audioPlan = buildAudioPlan(project, { duration: total / F });

  const report = (p) => {
    if (typeof onProgress !== 'function') return;
    try { onProgress(p); } catch { /* 进度回调出错不影响导出 */ }
  };

  // 让主进程放行这些文件的读取（已注册的路径重复注册无害）
  try {
    const paths = usedPaths(project, layout);
    if (paths.length) await api.call('media:register', { paths });
  } catch { /* 旧版本主进程没有这个通道时忽略 */ }

  const { canvas, ctx } = audioOnly ? {} : createCanvas(W, H);
  const encoder = canvas ? await createJpegEncoder(canvas) : null;
  const pool = createMediaPool({ mediaUrl: (p) => api.mediaUrl(p), useProxy: false });
  let jobId = null;
  let cancelSent = false;
  const sendCancel = () => {
    if (!jobId || cancelSent) return;
    cancelSent = true;
    api.call('export:cancel', { jobId }).catch(() => {});
  };
  const onAbort = () => {
    sendCancel();
    encoder?.dispose(cancelledError());
  };
  if (signal) signal.addEventListener('abort', onAbort);
  const aborted = () => !!(signal && signal.aborted);

  let tracker = null;
  let notice = '';
  let lastReport = 0;
  const emit = (force = false) => {
    if (!tracker) return;
    const now = performance.now();
    if (!force && now - lastReport < PROGRESS_INTERVAL) return;
    lastReport = now;
    const snap = tracker.snapshot();
    report(notice ? { ...snap, notice } : snap);
  };
  // 主进程的进度事件带着 ffmpeg 实际编码到的帧数；收尾阶段渲染循环已停，靠它刷新进度和剩余时间
  let unsubscribe = null;
  try {
    unsubscribe = api.onJobs((type, d) => {
      if (type !== 'progress' || !d || !jobId || d.jobId !== jobId || !tracker) return;
      tracker.encoded(d.meta);
      if (audioOnly || tracker.isEnding()) emit(false);
    });
  } catch { unsubscribe = null; }

  let lastEncoder = null;
  /** 一遍完整导出：begin → 逐帧 → end。hwMode = 'off' 时只用 CPU 编码 */
  const runPass = async (hwMode, failedEncoder) => {
    if (aborted()) throw cancelledError();
    tracker = createExportProgress({ total, duration: total / F, audioOnly });
    jobId = null;
    cancelSent = false;
    lastReport = 0;
    report({ phase: audioOnly ? 'encode' : 'render', frame: 0, total, fps: 0, etaSec: null, progress: 0, ...(notice ? { notice } : {}) });
    const begin = await api.call('export:begin', {
      outPath, width: W, height: H, fps: F, quality, audioPlan, totalFrames: total,
      preset: resolved ? resolved.presetId : preset, format: resolved ? resolved.format : 'mp4',
      bitrate: resolved ? resolved.bitrate : num(bitrate), audioOnly, gif: !!(resolved && resolved.gif),
      srt: !!srtText, srtText, hwaccel: hwMode,
      ...(creditsText ? { credits: creditsText } : {}),
      ...(aigcMeta ? { aigc: aigcMeta } : {}),
      ...(failedEncoder ? { failedEncoder } : {}),
    });
    jobId = begin && begin.jobId;
    if (!jobId) throw new Error('导出启动失败：主进程没有返回任务编号');
    lastEncoder = (begin && begin.encoder) || null;
    if (aborted()) throw cancelledError();

    let send = Promise.resolve();
    for (let i = 0; i < (audioOnly ? 0 : total); i += 1) {
      if (aborted()) throw cancelledError();
      const t = i / F;
      await pool.seekExact(renderProject, t, layout);
      if (aborted()) throw cancelledError();
      // 帧序号由合成器按工程帧率从 t 推算（导出帧率与工程帧率不同时颗粒 / 抖动仍与预览一致）
      renderFrame(ctx, renderProject, t, pool, { width: W, height: H, layout, mode: 'export' });
      if (label) drawAiLabel(ctx, W, H, t, label);
      const jpeg = encoder.encode(q);
      jpeg.catch(() => {}); // 等上一帧时，这一帧的编码也可能先失败
      await send; // 上一帧送达后才排下一帧，内存里最多压两帧（主进程写不进编码器时这里会等）
      tracker.sent(i);
      const frameJobId = jobId;
      send = jpeg.then((data) => {
        if (aborted()) throw cancelledError();
        return api.call('export:frame', { jobId: frameJobId, data });
      });
      send.catch(() => {}); // 错误在下一次 await 时抛出，这里只避免未处理拒绝的告警
      emit(false);
    }
    await send;
    if (aborted()) throw cancelledError();
    tracker.sent(audioOnly ? 0 : total);
    tracker.ending();
    emit(true);
    const result = await api.call('export:end', { jobId });
    if (aborted()) throw cancelledError();
    if (!result || !result.path) throw new Error('导出失败：没有生成输出文件');
    return result;
  };

  try {
    let result;
    try {
      result = await runPass(hwaccel, null);
    } catch (err) {
      // 显卡编码中途出错（驱动问题、同时编码路数超限等）：自动改用 CPU 重新导出一次
      if (!err || err.code !== 'HW_ENCODER_FAILED' || err.cancelled || aborted() || hwaccel === 'off') throw err;
      sendCancel();
      notice = HW_FALLBACK_NOTICE;
      result = await runPass('off', lastEncoder);
    }
    report({ phase: 'encode', frame: total, total, fps: tracker ? tracker.fps() : 0, etaSec: 0, progress: 1, ...(notice ? { notice } : {}) });
    jobId = null;
    const out = {
      path: result.path,
      size: num(result.size),
      duration: num(result.duration, total / F),
      encoder: result.encoder || null,
      srtPath: result.srtPath || null,
      format: result.format || 'mp4',
      creditsPath: result.creditsPath || null,
      aiLabel: !!label,
      aigc: !!result.aigc,
      hw: !!result.hw,
      encoderLabel: result.encoderLabel || '',
      notice,
      fallback: !!notice,
    };
    if (result.srtError) out.srtError = result.srtError;
    if (result.creditsError) out.creditsError = result.creditsError;
    if (Array.isArray(result.missing) && result.missing.length) out.missing = result.missing;
    return out;
  } catch (err) {
    if (aborted() || (err && err.cancelled)) {
      sendCancel();
      throw cancelledError();
    }
    sendCancel();
    const e = new Error(readable(err));
    if (err && err.code) e.code = err.code;
    throw e;
  } finally {
    if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch { /* 忽略 */ } }
    if (signal) signal.removeEventListener('abort', onAbort);
    encoder?.dispose();
    pool.dispose();
    releaseRenderCache();
  }
}

// ---------------- 字幕外挂 / 单帧截图 ----------------

/** 项目里的字幕文字：语音识别的（group:'caption'）和初剪按镜头文案生成的（source:'shot-caption'） */
export function captionTexts(project) {
  const texts = (project && project.tracks && Array.isArray(project.tracks.text)) ? project.tracks.text : [];
  return texts.filter((t) => isCaptionText(t) && String(t.text || '').trim());
}

function withoutCaptions(project) {
  const tracks = project.tracks || {};
  return { ...project, tracks: { ...tracks, text: (tracks.text || []).filter((t) => !isCaptionText(t)) } };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
export function srtTimestamp(sec) {
  const ms = Math.max(0, Math.round(num(sec) * 1000));
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

/** 文字 → SRT：优先用 W10 captions.textsToSrt，缺失时内联实现 */
export function toSrt(texts) {
  if (typeof Captions.textsToSrt === 'function') {
    try {
      const out = Captions.textsToSrt(texts);
      if (typeof out === 'string') return out;
    } catch { /* 回退 */ }
  }
  return (texts || [])
    .map((t) => ({ start: num(t.start), end: num(t.start) + Math.max(0.1, num(t.duration, num(t.end) - num(t.start))), text: String(t.text || '').trim() }))
    .filter((t) => t.text)
    .sort((a, b) => a.start - b.start)
    .map((t, i) => `${i + 1}\n${srtTimestamp(t.start)} --> ${srtTimestamp(t.end)}\n${t.text}\n`)
    .join('\n');
}

/** 把时刻 t 的画面渲染成 PNG 并保存（export:frame），返回文件路径 */
export async function exportFrame({ project, t = 0, outPath, width, height } = {}) {
  if (!project) throw new Error('没有可截图的项目');
  if (!api.available) throw new Error('截图需要在镜流桌面版中进行');
  const settings = project.settings || {};
  const W = even(width || settings.width || 1920);
  const H = even(height || settings.height || 1080);
  const { canvas, ctx } = createCanvas(W, H);
  const pool = createMediaPool({ mediaUrl: (p) => api.mediaUrl(p), useProxy: false });
  try {
    try {
      const paths = usedPaths(project, layoutVideo(project));
      if (paths.length) await api.call('media:register', { paths });
    } catch { /* 忽略 */ }
    await pool.seekExact(project, t);
    renderFrame(ctx, project, t, pool, { width: W, height: H, mode: 'export' });
    const blob = typeof canvas.convertToBlob === 'function'
      ? await canvas.convertToBlob({ type: 'image/png' })
      : await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('截图编码失败'))), 'image/png'));
    const data = await blob.arrayBuffer();
    return await api.call('export:frame', { projectId: project.id, t, data, outPath });
  } catch (err) {
    throw new Error(readable(err));
  } finally {
    pool.dispose();
  }
}
