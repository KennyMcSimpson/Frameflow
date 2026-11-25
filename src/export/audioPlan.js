// 音频计划：把时间线翻译成 ffmpeg 能直接混音的片段清单。纯函数，node 可测。
// AudioPlan = { duration, segments: [{ path, timelineStart, srcIn, srcOut, speed, volume, fadeIn, fadeOut, role }] }
//  - 主轨：asset.hasAudio && !clip.mute && volume>0 的镜头
//  - 音频轨：全部有源文件的 AudioClip
//  - 主轨转场重叠区：出画镜头淡出、入画镜头淡入，与画面同步交叉，声音不会在转场处突然跳变
//  - 硬切处两端各至少 30ms 淡变（EDGE_FADE），消除切点爆音；同一素材分割开、首尾无缝相接时不加

import * as TL from '../engine/timeline.js';

const { layoutVideo } = TL;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const round3 = (v) => Math.round(v * 1000) / 1000;

/** 把片段裁到 [0, duration] 内，并让淡入淡出不超过片段自身。完全在范围外时返回 null */
function fit(seg, duration) {
  let { timelineStart, srcIn, srcOut } = seg;
  const speed = seg.speed > 0 ? seg.speed : 1;
  let volumeKeys = Array.isArray(seg.volumeKeys) ? seg.volumeKeys : undefined;
  if (Array.isArray(seg.speedParts) && seg.speedParts.length) {
    const total = seg.speedParts[seg.speedParts.length - 1].t1;
    const lo = Math.max(0, -timelineStart);
    const hi = Math.min(total, duration - timelineStart);
    const parts = clipParts(seg.speedParts, lo, hi, seg.reverse);
    if (!parts.length) return null;
    if (volumeKeys && lo > 0) volumeKeys = volumeKeys.map((k) => ({ t: round3(k.t - lo), v: k.v }));
    const length = parts[parts.length - 1].t1;
    let fi = Math.max(0, seg.fadeIn);
    let fo = Math.max(0, seg.fadeOut);
    if (fi + fo > length) { const k = length / (fi + fo); fi *= k; fo *= k; }
    const sIn = Math.min(...parts.map((p) => p.srcIn));
    const sOut = Math.max(...parts.map((p) => p.srcOut));
    return {
      ...seg,
      timelineStart: round3(timelineStart + lo),
      srcIn: round3(sIn),
      srcOut: round3(sOut),
      speed: (sOut - sIn) / length,
      speedParts: parts.map((p) => ({ srcIn: round3(p.srcIn), srcOut: round3(p.srcOut), speed: Math.round(p.speed * 1e6) / 1e6, dur: Math.round((p.t1 - p.t0) * 1e6) / 1e6 })),
      fadeIn: round3(fi),
      fadeOut: round3(fo),
      ...(volumeKeys && volumeKeys.length ? { volumeKeys } : {}),
    };
  }
  if (timelineStart < 0) {
    if (volumeKeys) volumeKeys = volumeKeys.map((k) => ({ t: round3(k.t + timelineStart), v: k.v }));
    if (seg.reverse) srcOut -= -timelineStart * speed; else srcIn += -timelineStart * speed;
    timelineStart = 0;
  }
  let length = (srcOut - srcIn) / speed;
  if (timelineStart + length > duration) {
    length = duration - timelineStart;
    if (seg.reverse) srcIn = srcOut - length * speed; else srcOut = srcIn + length * speed;
  }
  if (!(length > 0.001)) return null;
  let fadeIn = Math.max(0, seg.fadeIn);
  let fadeOut = Math.max(0, seg.fadeOut);
  if (fadeIn + fadeOut > length) {
    const k = length / (fadeIn + fadeOut);
    fadeIn *= k;
    fadeOut *= k;
  }
  return {
    ...seg,
    timelineStart: round3(timelineStart),
    srcIn: round3(srcIn),
    srcOut: round3(srcOut),
    speed,
    fadeIn: round3(fadeIn),
    fadeOut: round3(fadeOut),
    ...(volumeKeys && volumeKeys.length ? { volumeKeys } : {}),
  };
}

const MIN_PART = 0.25;
const MAX_PARTS = 48;

/**
 * 曲线变速 → 分段常速（预览与导出共用）。
 * 返回 [{ t0, t1, srcIn, srcOut, speed }]：t 为片段本地秒（时间线顺序），src 为源秒（srcIn<srcOut），
 * 段端点由曲线积分精确得到，故分段总时长与画面映射一致；每段 ≥0.25s（片段过短时整段一段）。
 * 非曲线变速 / 定格 / 无效片段返回 []。
 */
export function speedSegments(clip, timelineDuration) {
  const c = clip || {};
  if (c.still || !Array.isArray(c.speedCurve) || c.speedCurve.length < 2) return [];
  const cin = num(c.in);
  const len = Math.max(0, num(c.out) - cin);
  let dur = num(timelineDuration);
  if (!(dur > 0)) { try { dur = num(TL.clipDuration(c)); } catch { dur = 0; } }
  if (!(len > 0.001) || !(dur > 0.001)) return [];
  const n = Math.max(1, Math.min(MAX_PARTS, Math.floor(dur / MIN_PART)));
  const offAt = (t) => {
    if (t <= 0) return 0;
    if (t >= dur) return len;
    let o;
    if (typeof TL.curveIntegral === 'function') o = dur * num(TL.curveIntegral(c.speedCurve, t / dur));
    else o = num(TL.sourceTimeAt({ ...c, reverse: false }, t)) - cin;
    return Math.min(len, Math.max(0, o));
  };
  const out = [];
  let prevT = 0;
  let prevO = 0;
  for (let i = 1; i <= n; i += 1) {
    const t = i === n ? dur : (dur * i) / n;
    const o = offAt(t);
    const dt = t - prevT;
    const ds = Math.max(0, o - prevO);
    if (dt > 1e-6 && ds > 1e-6) {
      const a = c.reverse ? cin + len - o : cin + prevO;
      const b = c.reverse ? cin + len - prevO : cin + o;
      out.push({ t0: prevT, t1: t, srcIn: a, srcOut: b, speed: ds / dt });
    }
    prevT = t;
    prevO = o;
  }
  return out;
}

/** 把分段裁到本地 [lo, hi]（线性插值） */
function clipParts(parts, lo, hi, reverse) {
  const res = [];
  for (const p of parts) {
    const a = Math.max(lo, p.t0);
    const b = Math.min(hi, p.t1);
    if (!(b - a > 1e-4)) continue;
    const ds0 = (a - p.t0) * p.speed;
    const ds1 = (p.t1 - b) * p.speed;
    const srcIn = reverse ? p.srcIn + ds1 : p.srcIn + ds0;
    const srcOut = reverse ? p.srcOut - ds0 : p.srcOut - ds1;
    res.push({ t0: a - lo, t1: b - lo, srcIn, srcOut, speed: p.speed });
  }
  return res;
}

/** 片段平均速度：曲线变速时 = 源长度 / 时间线时长（音频按平均速度 atempo 保调近似） */
export function effectiveSpeed(clip, timelineDuration) {
  const c = clip || {};
  const base = num(c.speed, 1) > 0 ? num(c.speed, 1) : 1;
  if (!Array.isArray(c.speedCurve) || !c.speedCurve.length) return base;
  const srcLen = Math.max(0, num(c.out) - num(c.in));
  let dur = num(timelineDuration);
  if (!(dur > 0) && typeof TL.clipDuration === 'function') {
    try { dur = num(TL.clipDuration(c)); } catch { dur = 0; }
  }
  if (!(dur > 0)) {
    // 本地积分：时长 = ∫ srcLen / v(t) dt（t 为归一化源进度）
    const pts = c.speedCurve.slice().sort((a, b) => a.t - b.t);
    const vAt = (t) => {
      if (t <= pts[0].t) return pts[0].v;
      for (let i = 0; i < pts.length - 1; i += 1) if (t <= pts[i + 1].t) { const a = pts[i]; const b = pts[i + 1]; return a.v + (b.v - a.v) * ((t - a.t) / Math.max(1e-6, b.t - a.t)); }
      return pts[pts.length - 1].v;
    };
    let acc = 0;
    for (let i = 0; i < 64; i += 1) acc += 1 / Math.max(0.1, vAt((i + 0.5) / 64) * base);
    dur = (acc / 64) * srcLen;
  }
  return dur > 0 && srcLen > 0 ? srcLen / dur : base;
}

const spParts = (c, d) => { const p = speedSegments(c, d); return p.length ? { speedParts: p } : {}; };

/**
 * 硬切处的最短淡入淡出（秒）。声音在切点处突然开始或中断，波形跳变会发出「咔哒」声；
 * 30 毫秒的过渡听不出淡变，但能消除爆音（K1）。转场重叠区和用户设置的淡入淡出更长时以它们为准。
 */
export const EDGE_FADE = 0.03;

const SEAM_EPS = 0.02;

/** 两段声音是否首尾无缝相接（同一文件、源时间连续、常速正放、音量相同）：分割开的片段之间不能加淡变，否则会有一下凹陷 */
function seamless(a, b) {
  if (!a || !b || a.path !== b.path) return false;
  if (a.reverse || b.reverse || a.curve || b.curve || a.keys || b.keys) return false;
  if (Math.abs(a.speed - b.speed) > 1e-3 || Math.abs(a.volume - b.volume) > 1e-3) return false;
  return Math.abs(a.end - b.start) < SEAM_EPS && Math.abs(a.srcOut - b.srcIn) < SEAM_EPS * Math.max(1, a.speed);
}

/** 主轨镜头的声音描述（不出声时为 null），用于判断相邻镜头是否无缝相接 */
function mainVoice(item, assets) {
  const clip = item && item.clip;
  const asset = clip && assets[clip.assetId];
  const volume = num(clip && clip.volume, 1);
  if (!asset || !asset.hasAudio || !asset.path || clip.mute || clip.muted || clip.still || volume <= 0) return null;
  return {
    path: asset.path,
    start: num(item.start),
    end: num(item.end, num(item.start) + num(item.duration)),
    srcIn: num(clip.in),
    srcOut: num(clip.out),
    speed: num(clip.speed, 1) > 0 ? num(clip.speed, 1) : 1,
    volume,
    reverse: !!clip.reverse,
    curve: Array.isArray(clip.speedCurve) && clip.speedCurve.length > 0,
    keys: !!(clip.keys && Array.isArray(clip.keys.volume) && clip.keys.volume.length),
  };
}

export function buildAudioPlan(project, { duration } = {}) {
  const assets = (project && project.assets) || {};
  const layout = layoutVideo(project) || [];
  const lastEnd = layout.length ? layout[layout.length - 1].end : 0;
  const audioClips = (project && project.tracks && project.tracks.audio) || [];
  const total = num(duration, -1) >= 0
    ? num(duration)
    : audioClips.reduce((m, a) => Math.max(m, num(a.start) + Math.max(0, num(a.out) - num(a.in))), lastEnd);

  const segments = [];
  const voices = layout.map((item) => mainVoice(item, assets));

  layout.forEach((item, i) => {
    const { clip } = item;
    const asset = assets[clip.assetId];
    const volume = num(clip.volume, 1);
    if (!asset || !asset.hasAudio || !asset.path || clip.mute || clip.muted || clip.still || volume <= 0) return;
    const kv = clip.keys && Array.isArray(clip.keys.volume) && clip.keys.volume.length ? clip.keys.volume : null;
    const next = layout[i + 1];
    const overlapIn = num(item.overlap);
    const overlapOut = next ? num(next.overlap) : 0;
    // 硬切：没有转场重叠、也不是和相邻镜头无缝相接（同一素材被分割）时，两端各加 30ms 防爆音
    const edgeIn = overlapIn > 0 || seamless(voices[i - 1], voices[i]) ? 0 : EDGE_FADE;
    const edgeOut = overlapOut > 0 || seamless(voices[i], voices[i + 1]) ? 0 : EDGE_FADE;
    const seg = fit({
      path: asset.path,
      timelineStart: item.start,
      srcIn: num(clip.in),
      srcOut: num(clip.out),
      speed: effectiveSpeed(clip, item.duration),
      ...spParts(clip, item.duration),
      // 音量关键帧为绝对音量：此时基础音量置 1，避免重复相乘
      volume: kv ? 1 : volume,
      volumeKeys: kv ? kv.map((k) => ({ t: num(k.t), v: num(k.v, 1) })) : undefined,
      reverse: !!clip.reverse,
      denoise: !!clip.denoise,
      fadeIn: Math.max(num(clip.audioFadeIn), overlapIn, edgeIn),
      fadeOut: Math.max(num(clip.audioFadeOut), overlapOut, edgeOut),
      role: 'clip',
    }, total);
    if (seg) segments.push(seg);
  });

  // 音频轨：分割开的同一段音乐首尾相接时不加淡变，其余两端至少 30ms
  const tracks = audioClips.map((clip) => {
    const asset = assets[clip && clip.assetId];
    if (!asset || !asset.path) return null;
    const start = num(clip.start);
    const srcIn = num(clip.in);
    const srcOut = num(clip.out);
    return {
      path: asset.path, start, end: start + Math.max(0, srcOut - srcIn), srcIn, srcOut, speed: 1, volume: num(clip.volume, 1),
      reverse: false, curve: false, keys: Array.isArray(clip.volumeKeys) && clip.volumeKeys.length > 0,
    };
  });
  audioClips.forEach((clip, i) => {
    const asset = assets[clip && clip.assetId];
    if (!asset || !asset.path) return;
    const me = tracks[i];
    const joinedIn = tracks.some((v, j) => j !== i && seamless(v, me));
    const joinedOut = tracks.some((v, j) => j !== i && seamless(me, v));
    const seg = fit({
      path: asset.path,
      timelineStart: num(clip.start),
      srcIn: num(clip.in),
      srcOut: num(clip.out),
      speed: 1,
      volume: num(clip.volume, 1),
      // volumeKeys（含自动闪避 autoDuck 写入的）为相对倍数，t 为片段内秒数
      volumeKeys: Array.isArray(clip.volumeKeys) && clip.volumeKeys.length ? clip.volumeKeys.map((k) => ({ t: num(k.t), v: num(k.v, 1) })) : undefined,
      denoise: !!clip.denoise,
      fadeIn: Math.max(num(clip.fadeIn), joinedIn ? 0 : EDGE_FADE),
      fadeOut: Math.max(num(clip.fadeOut), joinedOut ? 0 : EDGE_FADE),
      role: clip.role || 'music',
    }, total);
    if (seg) segments.push(seg);
  });

  // 画中画自带的声音
  const muteOverlayTracks = (project && project.tracks && project.tracks.overlay) || {};
  for (const o of (Array.isArray(project && project.overlays) ? project.overlays : [])) {
    const asset = assets[o && o.assetId];
    if (!asset || !asset.hasAudio || !asset.path || o.muted || o.kind === 'image' || o.kind === 'sticker') continue;
    if (muteOverlayTracks[o.track] && muteOverlayTracks[o.track].muted) continue;
    const vol = num(o.volume, 1);
    if (vol <= 0) continue;
    const seg = fit({
      path: asset.path,
      timelineStart: num(o.start),
      srcIn: num(o.in),
      srcOut: num(o.out),
      speed: effectiveSpeed(o),
      ...spParts(o),
      volume: vol,
      reverse: !!o.reverse,
      fadeIn: EDGE_FADE,
      fadeOut: EDGE_FADE,
      role: 'overlay',
    }, total);
    if (seg) segments.push(seg);
  }

  return { duration: total, segments };
}
