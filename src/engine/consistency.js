// 全片色彩一致性：基准色、统一色调操作、问题报告（CONTRACTS §B）。纯函数。
import { LOOK_LABELS } from './model.js';
import { clipDuration } from './timeline.js';
import { colorParamsFromStats, statsWithColor } from './colormatch.js';

const PARAM_KEYS = ['exposure', 'contrast', 'saturation', 'temperature', 'tint'];
const STAT_KEYS = ['luma', 'contrast', 'saturation', 'warmth', 'tint'];

function videoClips(project) {
  const list = project && project.tracks && project.tracks.video;
  return Array.isArray(list) ? list : [];
}

function statsOfClip(project, clip) {
  const asset = project && project.assets ? project.assets[clip.assetId] : null;
  return asset && asset.stats && Number.isFinite(Number(asset.stats.luma)) ? asset.stats : null;
}

function round3(v) {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
}

function mergePalette(weighted) {
  const out = [];
  const ordered = [...weighted].sort((a, b) => b.weight - a.weight);
  for (let rank = 0; out.length < 5 && rank < 5; rank += 1) {
    for (const { stats } of ordered) {
      const hex = Array.isArray(stats.palette) ? stats.palette[rank] : null;
      if (hex && !out.includes(hex) && out.length < 5) out.push(hex);
    }
  }
  return out;
}

function weightedStats(entries) {
  const total = entries.reduce((sum, e) => sum + e.weight, 0);
  if (!(total > 0)) return null;
  const result = {};
  for (const key of STAT_KEYS) {
    const sum = entries.reduce((acc, e) => acc + (Number(e.stats[key]) || 0) * e.weight, 0);
    result[key] = round3(sum / total);
  }
  result.palette = mergePalette(entries);
  return result;
}

function weight(clip) {
  return Math.max(clipDuration(clip), 0.01);
}

/** 全片色彩基准：主轨镜头素材 stats 按镜头时长加权；没有任何数据时返回 null。 */
export function projectBaseline(project) {
  const entries = [];
  for (const clip of videoClips(project)) {
    const stats = statsOfClip(project, clip);
    if (stats) entries.push({ stats, weight: weight(clip) });
  }
  return weightedStats(entries);
}

/** 全片现有的平均调色参数（按时长加权）。统一色调时保留它，只消除单镜的偏差。 */
function averageGrade(project) {
  const clips = videoClips(project).filter((c) => statsOfClip(project, c));
  const total = clips.reduce((sum, c) => sum + weight(c), 0);
  const grade = {};
  for (const key of PARAM_KEYS) {
    const sum = clips.reduce((acc, c) => acc + (Number(c.color && c.color[key]) || 0) * weight(c), 0);
    grade[key] = total > 0 ? sum / total : 0;
  }
  return grade;
}

/**
 * 生成统一色调的操作：每个目标镜头一条 setColor（绝对值）。
 * 参数 = 全片平均调色 + 把该素材拉向基准所需的校正，所以已有的全片风格不会被抹掉。
 * 优先用 project.memory.colorBaseline（用户/AI 确认过的基准），否则现算。
 * @param {number[]} [indices] 0 起；缺省时为全部未锁定镜头
 * @returns {object[]} Op[]；无基准或目标都没有色彩数据时为空数组
 */
export function harmonizeOps(project, indices, strength = 0.6) {
  const clips = videoClips(project);
  const baseline = (project && project.memory && project.memory.colorBaseline) || projectBaseline(project);
  if (!baseline) return [];
  const grade = averageGrade(project);
  const targets = Array.isArray(indices)
    ? indices
    : clips.map((_, i) => i).filter((i) => !clips[i].locked);
  const ops = [];
  for (const i of targets) {
    const clip = clips[i];
    const stats = clip ? statsOfClip(project, clip) : null;
    if (!stats) continue;
    const params = colorParamsFromStats(baseline, stats, strength);
    const color = {};
    for (const key of PARAM_KEYS) color[key] = round3(Math.min(1, Math.max(-1, grade[key] + params[key])));
    ops.push({ type: 'setColor', target: { mode: 'index', indices: [i + 1], ids: [] }, color, relative: false });
  }
  return ops;
}

// 与基准的差距阈值：[提示, 警告]
const THRESHOLDS = {
  luma: [0.12, 0.2],
  warmth: [0.1, 0.18],
  saturation: [0.15, 0.25],
  contrast: [0.12, 0.2],
};
const WORDS = {
  luma: ['偏亮', '偏暗'],
  warmth: ['偏暖', '偏冷'],
  saturation: ['饱和度偏高', '饱和度偏低'],
  contrast: ['对比偏强', '对比偏弱'],
};

function dominantLook(project) {
  const byLook = new Map();
  let total = 0;
  for (const clip of videoClips(project)) {
    const look = (clip.color && clip.color.look) || 'none';
    const w = weight(clip);
    byLook.set(look, (byLook.get(look) || 0) + w);
    total += w;
  }
  let best = null;
  for (const [look, w] of byLook) if (!best || w > best.w) best = { look, w };
  return best && total > 0 && best.w / total > 0.5 ? best.look : null;
}

/**
 * 找出和全片不协调的镜头。比较的是「素材统计 + 当前调色」的估算结果。
 * @returns {{index:number, issue:string, severity:'info'|'warn'}[]} index 为 0 起
 */
export function consistencyReport(project) {
  const clips = videoClips(project);
  const report = [];
  const entries = [];
  for (const clip of clips) {
    const stats = statsOfClip(project, clip);
    if (stats) entries.push({ stats: statsWithColor(stats, clip.color), weight: weight(clip) });
  }
  const baseline = weightedStats(entries);
  const mainLook = clips.length >= 2 ? dominantLook(project) : null;

  clips.forEach((clip, index) => {
    const n = index + 1;
    const raw = statsOfClip(project, clip);
    const asset = project.assets ? project.assets[clip.assetId] : null;
    if (!raw) {
      if (asset && asset.kind === 'video' && baseline) report.push({ index, issue: `第${n}镜还没有色彩数据，无法判断是否协调`, severity: 'info' });
    } else if (baseline && entries.length >= 2) {
      const graded = statsWithColor(raw, clip.color);
      for (const key of Object.keys(THRESHOLDS)) {
        const delta = (Number(graded[key]) || 0) - (Number(baseline[key]) || 0);
        const [info, warn] = THRESHOLDS[key];
        const abs = Math.abs(delta);
        if (abs < info) continue;
        const word = WORDS[key][delta > 0 ? 0 : 1];
        if (abs >= warn) report.push({ index, issue: `第${n}镜明显${word}`, severity: 'warn' });
        else report.push({ index, issue: `第${n}镜略${word}`, severity: 'info' });
      }
    }
    const look = (clip.color && clip.color.look) || 'none';
    if (mainLook && look !== mainLook) {
      report.push({ index, issue: `第${n}镜的调色风格是「${LOOK_LABELS[look] || look}」，与全片的「${LOOK_LABELS[mainLook] || mainLook}」不同`, severity: 'info' });
    }
  });
  return report;
}
