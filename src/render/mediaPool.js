// 媒体池（浏览器端）：管理 <video> / <audio> / 图片解码，给 compositor 提供可绘制的画面。
//
// - 每个视频素材最多 2 个 <video>（同一素材在转场两侧同时出现时各用一个），总数超过 12 个时回收最久未用的；
// - 预览：sync() 每帧调用，播放中让视频自己播放、偏差 > 0.25s 才纠正；暂停时合并 seek 到精确帧（只追最新目标）；
//   同时负责声音（主轨活动镜头取消静音 + 渐入渐出 + 转场交叉，音频轨用 <audio>），并预热相邻片段（正放预热下一段，倒退播放预热上一段）；
// - 旧帧缓存（只用于预览）：seek 过程中视频元素 readyState 会掉到 1、drawImage 画不出东西，
//   所以每个元素把最后一帧存进一张小画布，seek 期间 getFrame 返回同素材 0.5 秒内的旧帧，画面不再闪「加载中」；
// - seek 看门狗：1 秒等不到 seeked 就用最新目标重发一次，事件丢失或解码卡住时能自己恢复；
// - 导出：seekExact() 等待每个活动源真正停在目标帧（seeked + requestVideoFrameCallback，最长 1.5 秒）。

import * as TL from '../engine/timeline.js';
import * as KF from '../engine/keyframes.js';
import { speedSegments } from '../export/audioPlan.js';

const { layoutVideo, activeAt, audioAt } = TL;

const MAX_VIDEOS = 12;
const MAX_IMAGES = 64;
const MAX_AUDIOS = 8;
const SEEK_TIMEOUT = 1500;
const META_TIMEOUT = 10000;
const DRIFT = 0.25;
const PREHEAT = 2;
/** 预览 seek 的安全超时（毫秒） */
const SEEK_WATCHDOG = 1000;
/** seek 期间允许沿用的旧帧范围（秒，源时间） */
const HOLD_WINDOW = 0.5;
/** 旧帧缓存的长边上限：只用于 seek 期间撑住画面，不需要原片分辨率 */
const HOLD_MAX_SIDE = 1280;
/** 播放中刷新旧帧的最小间隔（毫秒） */
const HOLD_REFRESH_MS = 100;

const STILL_KINDS = new Set(['image', 'generated-image']);

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const nowMs = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());

/** 旧帧缓存用的画布：优先 OffscreenCanvas，不可用时退回普通 canvas */
function makeHoldCanvas(w, h) {
  if (typeof OffscreenCanvas === 'function') {
    try { return new OffscreenCanvas(w, h); } catch { /* 回退普通 canvas */ }
  }
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return null;
}

/**
 * 播放头向视频的实际时钟靠拢（commandedTime → playerTime）。
 * extrapolated：按墙钟外推的时间线时刻；clock：主视频实际时钟换算到时间线的时刻；step：这一帧外推前进的量。
 * 每帧最多修正 step 的一半（播放头不会倒退、也看不出顿挫）；差距过大多半是切片段或卡顿，交给 sync 的漂移纠正。
 */
export function slewToClock(extrapolated, clock, step) {
  if (!Number.isFinite(clock)) return extrapolated;
  const diff = clock - extrapolated;
  const abs = Math.abs(diff);
  if (abs < 0.005 || abs > 0.5) return extrapolated;
  const limit = Math.max(0, num(step)) * 0.5;
  return extrapolated + Math.min(limit, Math.max(-limit, diff));
}

function assetName(asset) {
  return (asset && (asset.name || (asset.path && String(asset.path).split(/[\\/]/).pop()))) || '未命名素材';
}

function mediaErrorText(el) {
  const code = el && el.error && el.error.code;
  if (code === 1) return '读取被中断';
  if (code === 2) return '读取文件时出错（文件可能已被移动或删除）';
  if (code === 3) return '解码失败（文件可能已损坏）';
  if (code === 4) return '格式不受支持或文件不存在';
  return '未知错误';
}

function isVideoAsset(asset) {
  return !!asset && !!asset.path && asset.kind !== 'previz' && asset.kind !== 'audio' && !STILL_KINDS.has(asset.kind);
}

/** 片段内音量包络：clip 自身的渐入渐出 */
function envelope(local, length, fadeIn, fadeOut) {
  let g = 1;
  if (fadeIn > 0) g = Math.min(g, Math.max(0, local / fadeIn));
  if (fadeOut > 0) g = Math.min(g, Math.max(0, (length - local) / fadeOut));
  return g;
}

/** 播放/取帧用的文件：有代理（低码率预览文件）时优先代理 */
export function mediaPath(asset) {
  return (asset && (asset.proxyPath || asset.path)) || '';
}

const segCache = new WeakMap();
/** 曲线变速片段在本地时刻 localT 所在分段的常速倍率（与导出共用 speedSegments） */
export function curveRateAt(clip, localT, duration) {
  let parts = segCache.get(clip);
  if (!parts) { parts = speedSegments(clip, Number(duration) > 0 ? Number(duration) : undefined); segCache.set(clip, parts); }
  if (!parts.length) return Number(clip && clip.speed) > 0 ? Number(clip.speed) : 1;
  for (const p of parts) if (localT < p.t1) return p.speed;
  return parts[parts.length - 1].speed;
}
/** 片段本地时刻 → 源时刻：优先 timeline.sourceTimeAt（倒放 / 曲线变速 / 定格） */
export function entrySourceTime(clip, localT, fallback) {
  if (typeof TL.sourceTimeAt === 'function') {
    try {
      const v = TL.sourceTimeAt(clip, localT);
      if (Number.isFinite(v)) return v;
    } catch { /* 回退 */ }
  }
  return Number.isFinite(fallback) ? fallback : num(clip && clip.in) + Math.max(0, localT);
}

export function createMediaPool({ mediaUrl, useProxy = true } = {}) {
  // 预览优先代理文件（流畅）；导出传 useProxy:false 用原片（画质）
  const pathOf = (asset) => (useProxy ? mediaPath(asset) : (asset && asset.path) || '');
  const toUrl = typeof mediaUrl === 'function' ? mediaUrl : (p) => p;
  // 旧帧缓存只给预览用：导出每一帧都精确 seek，多存一张图只会拖慢
  const holdEnabled = useProxy !== false;
  const hasDom = typeof document !== 'undefined' && typeof document.createElement === 'function';
  const videos = new Map(); // `${assetId}#${slot}` → rec
  const images = new Map(); // assetId → rec
  const audios = new Map(); // audioClipId → rec
  let container = null;
  let clock = 0;
  let audioCtx = null;
  let disposed = false;
  let lastSyncTime = null;
  let lastDir = 1;
  /** 主轨活动片段的时钟映射（只在播放时有值），见 clockTime() */
  let mainClock = null;
  const readyListeners = new Set();
  let readyQueued = false;
  /** 素材首帧 / seek 完成时通知界面重画（暂停状态下首帧不再黑屏） */
  function notifyReady() {
    if (readyQueued || !readyListeners.size) return;
    readyQueued = true;
    const run = () => { readyQueued = false; for (const cb of [...readyListeners]) { try { cb(); } catch { /* 忽略 */ } } };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run); else setTimeout(run, 16);
  }
  function onFrameReady(cb) {
    if (typeof cb !== 'function') return () => {};
    readyListeners.add(cb);
    return () => readyListeners.delete(cb);
  }

  function host() {
    if (container || !hasDom) return container;
    container = document.createElement('div');
    container.setAttribute('aria-hidden', 'true');
    // 放进文档但不可见：部分浏览器只给挂在文档里的视频回调 requestVideoFrameCallback
    container.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0.001;pointer-events:none;z-index:-1;';
    (document.body || document.documentElement).appendChild(container);
    return container;
  }

  function release(el) {
    try {
      el.pause();
      el.removeAttribute('src');
      el.load();
      el.remove();
    } catch {
      // 元素已失效，忽略
    }
  }

  function disconnectAudioNodes(rec) {
    if (!rec) return;
    try { if (rec.source) rec.source.disconnect(); } catch { /* 忽略 */ }
    try { if (rec.gain) rec.gain.disconnect(); } catch { /* 忽略 */ }
    rec.source = null;
    rec.gain = null;
  }

  function releaseVideo(rec) {
    clearWatchdog(rec);
    disconnectAudioNodes(rec);
    rec.hold = null;
    rec.holdCtx = null;
    release(rec.el);
  }

  function releaseAudio(rec) {
    disconnectAudioNodes(rec);
    release(rec.el);
  }

  // ---------------- 旧帧缓存 ----------------

  /** 把视频当前帧存进旧帧画布。只在元素确实有画面、且不在 seek 途中时存 */
  function captureHold(rec) {
    const el = rec.el;
    if (rec.error || el.seeking || el.readyState < 2) return;
    const vw = el.videoWidth;
    const vh = el.videoHeight;
    if (!(vw > 0 && vh > 0)) return;
    rec.everFramed = true;
    if (!holdEnabled) return;
    const k = Math.min(1, HOLD_MAX_SIDE / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * k));
    const h = Math.max(1, Math.round(vh * k));
    if (!rec.hold || rec.hold.width !== w || rec.hold.height !== h) {
      rec.hold = null;
      rec.holdCtx = null;
      rec.holdTime = null;
      const c = makeHoldCanvas(w, h);
      let ctx = null;
      try { ctx = c ? c.getContext('2d', { alpha: false }) : null; } catch { ctx = null; }
      if (!ctx) return;
      rec.hold = c;
      rec.holdCtx = ctx;
    }
    try {
      rec.holdCtx.drawImage(el, 0, 0, w, h);
      rec.holdTime = el.currentTime;
      rec.holdAt = nowMs();
    } catch { /* 这一帧暂时读不出来，下次再存 */ }
  }

  /** 正常取帧时顺手刷新旧帧：同一帧不重复存，播放中限频 */
  function refreshHold(rec) {
    rec.everFramed = true;
    if (!holdEnabled) return;
    if (rec.hold && rec.holdTime != null) {
      if (Math.abs(rec.holdTime - rec.el.currentTime) < 1e-4) return;
      if (nowMs() - rec.holdAt < HOLD_REFRESH_MS) return;
    }
    captureHold(rec);
  }

  // ---------------- 视频 ----------------

  function ensureVideo(asset, slot = 0, keep = null) {
    if (disposed || !hasDom || !isVideoAsset(asset)) return null;
    const key = `${asset.id}#${slot}`;
    let rec = videos.get(key);
    if (rec && rec.path !== pathOf(asset)) {
      releaseVideo(rec);
      videos.delete(key);
      rec = null;
    }
    if (!rec) {
      const el = document.createElement('video');
      el.preload = 'auto';
      el.playsInline = true;
      el.crossOrigin = 'anonymous';
      el.muted = true;
      el.defaultMuted = true;
      el.disablePictureInPicture = true;
      el.setAttribute('playsinline', '');
      el.style.cssText = 'width:2px;height:2px;';
      rec = {
        key, el, assetId: asset.id, path: pathOf(asset), name: assetName(asset), slot, lastUsed: ++clock, error: null,
        pending: null, commanded: null, watchdog: null,
        hold: null, holdCtx: null, holdTime: null, holdAt: 0, everFramed: false, createdAt: nowMs(),
        rvfcSeen: false, source: null, gain: null, fps: num(asset.fps) > 0 ? num(asset.fps) : 30,
      };
      const r = rec;
      el.addEventListener('error', () => { r.error = mediaErrorText(el); clearWatchdog(r); notifyReady(); });
      el.addEventListener('loadeddata', () => { captureHold(r); notifyReady(); });
      el.addEventListener('seeked', () => {
        clearWatchdog(r);
        r.retries = 0;
        // 先把这一帧存下来，再去追下一个目标：连续 seek（倒退播放、拖动播放头）时画面总有最新可用的帧
        captureHold(r);
        // 合并 seek：只追最后一个目标，不排队
        if (r.pending != null) {
          const target = r.pending;
          r.pending = null;
          if (Math.abs(el.currentTime - target) > 0.5 / r.fps) issueSeek(r, target);
        }
        if (el.paused) notifyReady();
      });
      try {
        el.src = toUrl(pathOf(asset));
      } catch (e) {
        rec.error = `无法生成素材地址：${e && e.message ? e.message : e}`;
      }
      const box = host();
      if (box) box.appendChild(el);
      videos.set(key, rec);
      const keepSet = keep ? new Set(keep) : new Set();
      keepSet.add(rec);
      keepSet.add(key);
      evictVideos(keepSet);
    }
    rec.lastUsed = ++clock;
    return rec;
  }

  function evictVideos(keep) {
    if (videos.size <= MAX_VIDEOS) return;
    const list = [...videos.values()].filter((r) => !keep || (!keep.has(r) && !keep.has(r.key))).sort((a, b) => a.lastUsed - b.lastUsed);
    while (videos.size > MAX_VIDEOS && list.length) {
      const r = list.shift();
      releaseVideo(r);
      videos.delete(r.key);
    }
  }

  function clearWatchdog(rec) {
    if (rec.watchdog != null) {
      clearTimeout(rec.watchdog);
      rec.watchdog = null;
    }
  }

  /** 真正发出一次 seek：清掉等待中的目标，并启动 1 秒看门狗 */
  function issueSeek(rec, target, retry = false) {
    rec.pending = null;
    rec.commanded = target;
    if (!retry) rec.retries = 0;
    clearWatchdog(rec);
    rec.watchdog = setTimeout(() => {
      rec.watchdog = null;
      if (disposed || rec.error || videos.get(rec.key) !== rec) return;
      // 1 秒还等不到 seeked：事件丢了或解码器卡住，用最新目标重发（最多连续 3 次，坏文件不会无限重试）
      const next = rec.pending != null ? rec.pending : (rec.el.seeking ? rec.commanded : null);
      if (next == null) {
        // seeked 事件丢了但元素其实已经停下：补存这一帧并通知重画，暂停时画面不会卡在旧帧
        captureHold(rec);
        notifyReady();
        return;
      }
      if (num(rec.retries) >= 3) return;
      rec.retries = num(rec.retries) + 1;
      issueSeek(rec, next, true);
    }, SEEK_WATCHDOG);
    try { rec.el.currentTime = target; } catch { /* 元数据未就绪 */ }
  }

  function seekTo(rec, target) {
    const el = rec.el;
    if (el.readyState < 1) {
      rec.pending = target;
      if (!rec.metaHooked) {
        rec.metaHooked = true;
        el.addEventListener('loadedmetadata', () => {
          if (rec.pending != null) issueSeek(rec, rec.pending);
        }, { once: true });
      }
      return;
    }
    if (el.seeking) {
      rec.pending = target;
      return;
    }
    if (Math.abs(el.currentTime - target) > 0.5 / rec.fps) {
      issueSeek(rec, target);
    } else {
      // 已经停在目标帧：丢弃过期目标，免得之后的 seeked 把画面拉回旧位置
      rec.pending = null;
    }
  }

  function frameTarget(rec, srcTime, asset) {
    const fps = rec.fps;
    const el = rec.el;
    const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : num(asset && asset.duration, Infinity);
    // 对准源视频帧的中点：浮点误差不会让解码器落到相邻帧
    let target = (Math.floor(srcTime * fps + 1e-4) + 0.5) / fps;
    if (Number.isFinite(duration)) target = Math.min(target, Math.max(0, duration - 0.5 / fps));
    return Math.max(0, target);
  }

  function waitMetadata(rec, asset) {
    const el = rec.el;
    if (rec.error) return Promise.reject(new Error(`素材无法读取：${assetName(asset)}（${rec.error}）`));
    if (el.readyState >= 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        el.removeEventListener('loadedmetadata', ok);
        el.removeEventListener('error', bad);
      };
      const ok = () => { cleanup(); resolve(); };
      const bad = () => { cleanup(); reject(new Error(`素材无法读取：${assetName(asset)}（${mediaErrorText(el)}）`)); };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`素材读取超时：${assetName(asset)}（文件可能过大或已损坏）`));
      }, META_TIMEOUT);
      el.addEventListener('loadedmetadata', ok);
      el.addEventListener('error', bad);
    });
  }

  async function seekVideoExact(rec, asset, srcTime) {
    await waitMetadata(rec, asset);
    const el = rec.el;
    rec.pending = null;
    clearWatchdog(rec);
    if (!el.paused) el.pause();
    const target = frameTarget(rec, srcTime, asset);
    rec.commanded = target;
    if (!el.seeking && el.readyState >= 2 && Math.abs(el.currentTime - target) < 0.25 / rec.fps) return;
    await new Promise((resolve) => {
      let finished = false;
      let seeked = false;
      let painted = false;
      let grace = null;
      let rvfcId = null;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (grace) clearTimeout(grace);
        if (rvfcId != null && typeof el.cancelVideoFrameCallback === 'function') {
          try { el.cancelVideoFrameCallback(rvfcId); } catch { /* 忽略 */ }
        }
        rvfcId = null;
        el.removeEventListener('seeked', onSeeked);
        el.removeEventListener('error', finish);
        resolve();
      };
      const timer = setTimeout(finish, SEEK_TIMEOUT);
      const onSeeked = () => {
        seeked = true;
        // seeked 之后画面已可读；若这个元素以前确实会回调帧事件，再等它确认新帧已出图
        if (painted || !rec.rvfcSeen || typeof el.requestVideoFrameCallback !== 'function') finish();
        else grace = setTimeout(finish, 120);
      };
      if (typeof el.requestVideoFrameCallback === 'function') {
        try {
          rvfcId = el.requestVideoFrameCallback(() => {
            rvfcId = null;
            rec.rvfcSeen = true;
            painted = true;
            if (seeked) finish();
          });
        } catch { /* 不支持时只靠 seeked */ }
      }
      el.addEventListener('seeked', onSeeked);
      el.addEventListener('error', finish);
      try {
        el.currentTime = target;
      } catch {
        finish();
      }
    });
    if (rec.error) throw new Error(`素材无法读取：${assetName(asset)}（${rec.error}）`);
  }

  // ---------------- 图片 ----------------

  function ensureImage(asset) {
    if (disposed || !hasDom || !asset || !asset.path) return null;
    let rec = images.get(asset.id);
    if (rec && rec.path !== pathOf(asset)) {
      images.delete(asset.id);
      rec = null;
    }
    if (rec) {
      rec.lastUsed = ++clock;
      return rec;
    }
    const img = new Image();
    img.decoding = 'async';
    img.crossOrigin = 'anonymous';
    rec = { img, path: pathOf(asset), ready: false, error: null, lastUsed: ++clock, promise: null, createdAt: nowMs() };
    const r = rec;
    r.promise = new Promise((resolve, reject) => {
      img.onload = () => {
        const done = () => { r.ready = true; resolve(img); notifyReady(); };
        if (typeof img.decode === 'function') img.decode().then(done, done);
        else done();
      };
      img.onerror = () => {
        r.error = '图片无法读取（文件可能已被移动或删除）';
        reject(new Error(`素材无法读取：${assetName(asset)}（${r.error}）`));
      };
    });
    r.promise.catch(() => {});
    try {
      img.src = toUrl(pathOf(asset));
    } catch (e) {
      r.error = String(e && e.message ? e.message : e);
    }
    images.set(asset.id, rec);
    if (images.size > MAX_IMAGES) {
      const oldest = [...images.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (oldest) images.delete(oldest[0]);
    }
    return rec;
  }

  // ---------------- 声音 ----------------

  function setGain(rec, el, gain) {
    const g = Math.max(0, gain);
    if (g > 1 && !rec.gain && typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) {
      // 超过 100% 的音量需要走 WebAudio 增益节点；一旦接入就一直走这条路
      try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioCtx.createMediaElementSource(el);
        const node = audioCtx.createGain();
        source.connect(node).connect(audioCtx.destination);
        rec.source = source;
        rec.gain = node;
      } catch {
        rec.source = null;
        rec.gain = null;
      }
    }
    if (rec.gain) {
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      el.volume = 1;
      rec.gain.gain.value = g;
    } else {
      el.volume = Math.min(1, g);
    }
    const mute = g <= 0.001;
    if (el.muted !== mute) el.muted = mute;
  }

  function silence(rec) {
    const el = rec.el;
    if (!el.muted) el.muted = true;
    if (!el.paused) el.pause();
  }

  function playSafe(el) {
    try {
      const p = el.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* 自动播放受限时保持静止画面 */ }
  }

  function clipGain(project, entry, asset, active, master) {
    const clip = entry.clip;
    if (!asset || asset.hasAudio === false || clip.mute || clip.muted) return 0;
    if (typeof TL.trackFlags === 'function') {
      if (entry.overlay) {
        if (TL.trackFlags(project, 'overlay', entry.track || clip.track || 1).muted) return 0;
      } else if (TL.trackFlags(project, 'video').muted) {
        return 0;
      }
    }
    const local = entry.progress * entry.duration;
    const hasVolKeys = !!(clip.keys && Array.isArray(clip.keys.volume) && clip.keys.volume.length);
    const baseVol = hasVolKeys ? KF.valueAt(clip.keys, 'volume', local, num(clip.volume, 1)) : num(clip.volume, 1);
    let g = Math.max(0, num(baseVol, 1)) * master;
    g *= envelope(local, entry.duration, num(clip.audioFadeIn), num(clip.audioFadeOut));
    if (active.transition && active.out && (entry === active.out || entry === active.in)) {
      const p = active.transition.p;
      g *= entry === active.out ? 1 - p : p;
    }
    return g;
  }

  function syncAudioTrack(project, t, playing, master, pr = 1) {
    const assets = project.assets || {};
    const live = new Set();
    const trackMuted = typeof TL.trackFlags === 'function' && TL.trackFlags(project, 'audio').muted;
    if (playing && !trackMuted) {
      for (const { audio, srcTime } of audioAt(project, t)) {
        if (audio.muted || audio.mute) continue;
        const asset = assets[audio.assetId];
        if (!asset || !asset.path) continue;
        let rec = audios.get(audio.id);
        if (rec && rec.path !== pathOf(asset)) {
          releaseAudio(rec);
          audios.delete(audio.id);
          rec = null;
        }
        if (!rec) {
          const el = document.createElement('audio');
          el.preload = 'auto';
          el.crossOrigin = 'anonymous';
          try { el.src = toUrl(pathOf(asset)); } catch { continue; }
          const box = host();
          if (box) box.appendChild(el);
          rec = { el, path: pathOf(asset), source: null, gain: null, lastUsed: 0 };
          audios.set(audio.id, rec);
        }
        rec.lastUsed = ++clock;
        live.add(rec);
        const el = rec.el;
        const length = Math.max(0, num(audio.out) - num(audio.in));
        const local = Math.max(0, srcTime - num(audio.in));
        const keyMul = typeof TL.volumeKeyAt === 'function' ? Math.max(0, num(TL.volumeKeyAt(audio.volumeKeys, local), 1)) : 1;
        const g = Math.max(0, num(audio.volume, 1)) * keyMul * master * envelope(local, length, num(audio.fadeIn), num(audio.fadeOut));
        if (Math.abs(el.playbackRate - pr) > 1e-3) el.playbackRate = pr;
        if (el.preservesPitch === false) el.preservesPitch = true;
        if (el.readyState >= 1 && (el.paused || Math.abs(el.currentTime - srcTime) > DRIFT * pr)) {
          try { el.currentTime = srcTime; } catch { /* 忽略 */ }
        }
        setGain(rec, el, g);
        if (el.paused) playSafe(el);
      }
    }
    for (const rec of audios.values()) if (!live.has(rec)) silence(rec);
    if (audios.size > MAX_AUDIOS) {
      const old = [...audios.entries()].filter(([, r]) => !live.has(r)).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      while (audios.size > MAX_AUDIOS && old.length) {
        const [id, r] = old.shift();
        releaseAudio(r);
        audios.delete(id);
      }
    }
  }

  // ---------------- 活动源 ----------------

  function resolveActive(project, t, layout) {
    const lay = Array.isArray(layout) ? layout : layoutVideo(project);
    let active = activeAt(lay, t);
    if (!active.in && lay.length) {
      const end = lay[lay.length - 1].end;
      if (t > end && t - end < 0.05) active = activeAt(lay, end);
    }
    active = { ...active, time: t };
    return { lay, active };
  }

  /** 时刻 t 可见的画中画，包装成与主轨 entry 同形的对象 */
  function overlayEntries(project, t) {
    const list = Array.isArray(project && project.overlays) ? project.overlays : [];
    const out = [];
    for (const o of list) {
      if (!o) continue;
      const track = o.track || 1;
      if (typeof TL.trackFlags === 'function' && TL.trackFlags(project, 'overlay', track).hidden) continue;
      const start = num(o.start);
      const len = Math.max(0.05, (num(o.out, num(o.in) + 3) - num(o.in)) / Math.max(0.1, num(o.speed, 1) || 1));
      if (!(t >= start && t < start + len)) continue;
      const local = t - start;
      const clip = { ...o };
      out.push({ overlay: true, track, clip, progress: local / len, duration: len, srcTime: entrySourceTime(clip, local) });
    }
    return out;
  }

  /** 给活动镜头分配视频元素：同一素材同时出现多次时按序分配独立 slot，并预载图片画布背景 */
  function bindEntries(project, active) {
    const assets = project.assets || {};
    const slots = new Map();
    const keep = new Set();
    const plan = [];
    const bgSeen = new Set();
    const ovs = overlayEntries(project, active.time);
    for (const entry of [active.out, active.in, ...ovs]) {
      if (!entry) continue;
      if (!entry.overlay) entry.srcTime = entrySourceTime(entry.clip, num(entry.progress) * num(entry.duration), entry.srcTime);
      const asset = assets[entry.clip.assetId];
      if (asset) {
        if (STILL_KINDS.has(asset.kind)) {
          plan.push({ entry, asset, kind: 'image' });
        } else if (isVideoAsset(asset)) {
          const slot = slots.get(asset.id) || 0;
          slots.set(asset.id, slot + 1);
          keep.add(`${asset.id}#${slot}`);
          plan.push({ entry, asset, kind: 'video', slot });
        }
      }
      if (!entry.overlay && entry.clip && entry.clip.canvas && entry.clip.canvas.type === 'image' && entry.clip.canvas.value) {
        const bgId = entry.clip.canvas.value;
        if (!bgSeen.has(bgId)) {
          bgSeen.add(bgId);
          const bgAsset = assets[bgId];
          if (bgAsset && bgAsset.path && (STILL_KINDS.has(bgAsset.kind) || !bgAsset.kind)) {
            plan.push({ entry, asset: bgAsset, kind: 'image', bg: true });
          }
        }
      }
    }
    const out = [];
    for (const item of plan) {
      if (item.kind === 'image') {
        out.push({ entry: item.entry, asset: item.asset, image: ensureImage(item.asset) });
      } else {
        out.push({ entry: item.entry, asset: item.asset, video: ensureVideo(item.asset, item.slot, keep) });
      }
    }
    return out;
  }

  function sync(project, t, layout, { playing = false, volume = 1, rate: shuttleRate = 1, direction } = {}) {
    // 预览倍速（J/K/L 快进 2×/4×）：媒体元素 playbackRate 乘以该倍数、音调不变；只接受正值
    const pr = Math.min(8, Math.max(0.25, num(shuttleRate, 1) || 1));
    if (disposed || !hasDom || !project) return;
    const time = Math.max(0, num(t));
    const master = Math.max(0, num(volume, 1));
    // 移动方向：调用方明确给出时用它（倒放），否则按相邻两次调用的时间推断（往回拖播放头也算倒退）
    if (Number(direction) < 0 || Number(direction) > 0) lastDir = Number(direction) < 0 ? -1 : 1;
    else if (playing) lastDir = 1;
    else if (lastSyncTime != null && Math.abs(time - lastSyncTime) > 1e-6) lastDir = time < lastSyncTime ? -1 : 1;
    lastSyncTime = time;
    const dir = lastDir;
    mainClock = null;
    const { lay, active } = resolveActive(project, time, layout);
    const bound = bindEntries(project, active);
    const used = new Set();
    for (const b of bound) {
      if (!b.video) continue;
      const rec = b.video;
      used.add(rec);
      const el = rec.el;
      const clip = b.entry.clip;
      // 倒放 / 曲线变速 / 定格无法靠 playbackRate 实现：逐帧 seek
      // 曲线变速（正放）按 speedSegments 当前段设置 playbackRate（音调不变），漂移由下方校正
      const curved = Array.isArray(clip.speedCurve) && clip.speedCurve.length > 1;
      const frameStepped = !!(clip.reverse || clip.still);
      if (playing && !rec.error && !frameStepped) {
        const base = curved ? curveRateAt(clip, num(b.entry.progress) * num(b.entry.duration), b.entry.duration) : num(clip.speed, 1);
        const rate = Math.min(16, Math.max(0.0625, (base || 1) * pr));
        if (Math.abs(el.playbackRate - rate) > 1e-3) el.playbackRate = rate;
        if (el.preservesPitch === false) el.preservesPitch = true;
        // 播放中不叠加 seek：上一次纠正还没完成就先等它
        if (el.readyState >= 1 && !el.seeking) {
          const drift = Math.abs(el.currentTime - b.entry.srcTime);
          if ((el.paused && drift > 0.08) || drift > DRIFT * pr) issueSeek(rec, b.entry.srcTime);
        }
        setGain(rec, el, clipGain(project, b.entry, b.asset, active, master));
        if (el.paused) playSafe(el);
        // 主轨正放常速片段：记下「源时间 ↔ 时间线时间」的对应，供 clockTime() 读视频的实际时钟
        if (b.entry === active.in && !active.out && !curved && !b.entry.overlay) {
          mainClock = { rec, time, srcTime: b.entry.srcTime, speed: base > 0 ? base : 1 };
        }
      } else {
        if (!el.paused) el.pause();
        if (!el.muted) el.muted = true;
        seekTo(rec, frameTarget(rec, b.entry.srcTime, b.asset));
      }
    }

    // 预热相邻片段：正放时提前 2 秒把下一段停在入点；倒退（倒放 / 往回拖）时把上一段停在出点，
    // 切过去时第一帧立即可用，不会闪「加载中」
    const cur = active.in;
    if (cur) {
      const assets = project.assets || {};
      let target = null;
      if (dir >= 0) {
        const next = lay[cur.index + 1];
        if (next && next.start - time < PREHEAT && next.start - time > -0.01) target = { item: next, local: 0 };
      } else {
        const prev = lay[cur.index - 1];
        const item = lay[cur.index];
        if (prev && item && time - item.start < PREHEAT && time - item.start > -0.01) {
          const fps = num(project.settings && project.settings.fps) > 0 ? num(project.settings.fps) : 30;
          target = { item: prev, local: Math.max(0, num(prev.duration) - 0.5 / fps) };
        }
      }
      if (target) {
        const asset = assets[target.item.clip.assetId];
        if (asset && STILL_KINDS.has(asset.kind)) ensureImage(asset);
        else if (isVideoAsset(asset)) {
          const usedSlots = new Set(bound.filter((b) => b.video && b.asset.id === asset.id).map((b) => b.video.slot));
          let preheatSlot = 0;
          while (usedSlots.has(preheatSlot)) preheatSlot += 1;
          const rec = ensureVideo(asset, preheatSlot, used);
          if (rec && !used.has(rec)) {
            used.add(rec);
            if (!rec.el.paused) rec.el.pause();
            rec.el.muted = true;
            const src = target.local > 0 ? entrySourceTime(target.item.clip, target.local) : num(target.item.clip.in);
            seekTo(rec, frameTarget(rec, src, asset));
          }
        }
      }
    }
    for (const rec of videos.values()) if (!used.has(rec)) silence(rec);
    evictVideos(used);
    syncAudioTrack(project, time, playing, master, pr);
  }

  /**
   * 主视频的实际时钟换算成时间线时刻（playerTime）。只在主轨正放常速片段平稳播放时有值，否则 null。
   * Preview 用它把按墙钟外推的播放头（commandedTime）慢慢拉向视频真实进度，画面和声音不再越跑越偏。
   */
  function clockTime() {
    const c = mainClock;
    if (!c || disposed) return null;
    const el = c.rec.el;
    if (videos.get(c.rec.key) !== c.rec || c.rec.error || el.paused || el.seeking || el.readyState < 3) return null;
    const v = c.time + (el.currentTime - c.srcTime) / c.speed;
    return Number.isFinite(v) ? v : null;
  }

  async function seekExact(project, t, layout) {
    if (disposed) throw new Error('媒体池已释放');
    if (!project) return;
    const time = Math.max(0, num(t));
    const { active } = resolveActive(project, time, layout);
    if (!hasDom) return;
    const bound = bindEntries(project, active);
    const used = new Set();
    const tasks = [];
    for (const b of bound) {
      if (b.video) {
        used.add(b.video);
        b.video.el.muted = true;
        tasks.push(seekVideoExact(b.video, b.asset, b.entry.srcTime));
      } else if (b.image) {
        tasks.push(b.image.promise);
      }
    }
    for (const rec of videos.values()) if (!used.has(rec)) silence(rec);
    evictVideos(used);
    await Promise.all(tasks);
  }

  function getFrame(asset, srcTime) {
    if (disposed || !asset) return null;
    if (STILL_KINDS.has(asset.kind)) {
      const rec = ensureImage(asset);
      return rec && rec.ready ? rec.img : null;
    }
    if (!isVideoAsset(asset)) return null;
    const t = num(srcTime);
    let live = null;
    let liveDiff = Infinity;
    let held = null;
    let heldDiff = Infinity;
    for (const rec of videos.values()) {
      if (rec.assetId !== asset.id || rec.path !== pathOf(asset) || rec.error) continue;
      const el = rec.el;
      if (el.readyState >= 2 && (!el.seeking || !rec.hold)) {
        const diff = Math.abs(el.currentTime - t);
        if (diff < liveDiff) { live = rec; liveDiff = diff; }
      } else if (rec.hold && rec.holdTime != null) {
        // seek 途中元素画不出东西：沿用它存下的最后一帧。只在旧帧离目标 0.5 秒内，
        // 或这个元素正往目标赶（同一片段内的大跳转）时用，免得同一素材的两个片段（转场两侧）互相串画面
        const diff = Math.abs(rec.holdTime - t);
        const heading = rec.pending != null ? rec.pending : rec.commanded;
        const ok = diff <= HOLD_WINDOW || (heading != null && Math.abs(heading - t) <= HOLD_WINDOW);
        if (ok && diff < heldDiff) { held = rec; heldDiff = diff; }
      }
    }
    if (live && (!held || liveDiff <= heldDiff + 1 / live.fps)) {
      live.lastUsed = ++clock;
      refreshHold(live);
      return live.el;
    }
    if (held) {
      held.lastUsed = ++clock;
      return held.hold;
    }
    // 没有人调用 sync（例如单独渲染一帧）时也开始加载，下次就有画面
    const rec = ensureVideo(asset, 0);
    if (rec && rec.el.readyState >= 1 && !rec.el.seeking) seekTo(rec, frameTarget(rec, t, asset));
    return null;
  }

  /**
   * 取不到画面时给合成器的等待信息：framed 这个素材出过画面没有；waitMs 从开始加载到现在多久；error 读取错误。
   * 合成器据此决定：出过画面的只是 seek 慢一点，不画「加载中」；从没出过画面且等了 400ms 以上才画占位。
   */
  function waitInfo(asset) {
    const info = { framed: false, waitMs: 0, error: null };
    if (disposed || !asset) return info;
    const now = nowMs();
    if (STILL_KINDS.has(asset.kind)) {
      const rec = images.get(asset.id);
      if (rec) {
        info.framed = !!rec.ready;
        info.waitMs = Math.max(0, now - num(rec.createdAt, now));
        info.error = rec.error || null;
      }
      return info;
    }
    let since = Infinity;
    for (const rec of videos.values()) {
      if (rec.assetId !== asset.id || rec.path !== pathOf(asset)) continue;
      if (rec.everFramed) info.framed = true;
      if (rec.error && !info.error) info.error = rec.error;
      since = Math.min(since, num(rec.createdAt, now));
    }
    if (Number.isFinite(since)) info.waitMs = Math.max(0, now - since);
    return info;
  }

  /** 素材的加载错误（没有则为 null），供界面提示 */
  function errorOf(asset) {
    if (!asset) return null;
    if (STILL_KINDS.has(asset.kind)) {
      const rec = images.get(asset.id);
      return rec ? rec.error : null;
    }
    for (const rec of videos.values()) {
      if (rec.assetId === asset.id && rec.error) return rec.error;
    }
    return null;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    mainClock = null;
    for (const rec of videos.values()) releaseVideo(rec);
    for (const rec of audios.values()) releaseAudio(rec);
    videos.clear();
    audios.clear();
    for (const rec of images.values()) {
      rec.img.onload = null;
      rec.img.onerror = null;
      rec.img.src = '';
    }
    images.clear();
    if (container) {
      try { container.remove(); } catch { /* 忽略 */ }
      container = null;
    }
    if (audioCtx) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
    }
  }

  return { sync, seekExact, getFrame, waitInfo, clockTime, errorOf, dispose, onFrameReady, get size() { return videos.size; } };
}
