// 节奏：把「快/中/慢」或显式时长表换算为每个镜头的目标时长（CONTRACTS §B）。纯函数。
import { LIMITS } from './model.js';
import { clipDuration } from './timeline.js';

// factor：相对当前时长的缩放；min/max：该节奏下单镜时长的合理区间（秒）。
// 区间让反复说「节奏快一点」会收敛，而不是把镜头压到不可看。
const PACING = {
  fast: { factor: 0.7, min: 0.8, max: 3 },
  medium: { factor: 1, min: 1.5, max: 6 },
  slow: { factor: 1.35, min: 3, max: 10 },
};

export const PACING_NAMES = Object.keys(PACING);

function round2(v) {
  return Math.round(v * 100) / 100;
}

/** 镜头在时间线上能达到的最长时长：视频受素材长度限制（保持入点），图片/预演不限。 */
function maxDurationFor(clip, assets) {
  const asset = assets && clip ? assets[clip.assetId] : null;
  const dur = asset ? Number(asset.duration) : NaN;
  if (!asset || asset.kind !== 'video' || !Number.isFinite(dur) || dur <= 0) return Infinity;
  if (clip.still) return Infinity;
  // 曲线变速时用等效速度（源长度 / 时间线时长）
  const d = clipDuration(clip);
  const speed = clip.speedCurve && d > 0 ? (Number(clip.out) - Number(clip.in)) / d : Number(clip.speed) > 0 ? Number(clip.speed) : 1;
  return Math.max(0, (dur - (Number(clip.in) || 0)) / speed);
}

function fit(duration, clip, assets) {
  const max = maxDurationFor(clip, assets);
  return round2(Math.max(LIMITS.minClip, Math.min(duration, max)));
}

/**
 * @param {object[]} clips 目标镜头
 * @param {'slow'|'medium'|'fast'|number[]} pacingOrDurations 节奏名，或与 clips 对应的时长数组
 * @param {object} assets project.assets
 * @returns {number[]} 每镜目标时长（秒）。数组不足的部分保持原时长。
 */
export function pacingDurations(clips, pacingOrDurations, assets) {
  const list = Array.isArray(clips) ? clips : [];
  if (Array.isArray(pacingOrDurations)) {
    return list.map((clip, i) => {
      const wanted = Number(pacingOrDurations[i]);
      return fit(Number.isFinite(wanted) && wanted > 0 ? wanted : clipDuration(clip), clip, assets);
    });
  }
  const profile = PACING[pacingOrDurations];
  if (!profile) throw new Error('节奏只能是 slow（舒缓）、medium（适中）或 fast（紧凑）');
  return list.map((clip) => {
    const scaled = clipDuration(clip) * profile.factor;
    return fit(Math.max(profile.min, Math.min(profile.max, scaled)), clip, assets);
  });
}

/**
 * 卡点时长：每镜吸附到固定节拍网格的整数倍（默认 0.5 秒 = 120 BPM）。
 * 这里没有分析音乐实际节拍，调用方应如实告知用户。
 */
export function beatGridDurations(clips, assets, beat = 0.5) {
  const grid = Number(beat) > 0 ? Number(beat) : 0.5;
  return (Array.isArray(clips) ? clips : []).map((clip) => {
    const wanted = Math.max(grid, Math.min(PACING.fast.max, clipDuration(clip) * PACING.fast.factor));
    const max = maxDurationFor(clip, assets);
    let beats = Math.max(1, Math.round(wanted / grid));
    while (beats > 1 && beats * grid > max) beats -= 1;
    return fit(beats * grid, clip, assets);
  });
}
