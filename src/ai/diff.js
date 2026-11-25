// 改动对比与确认规则（ROADMAP P0-10 L3）。纯函数，不调用模型。
// - diffProject：比较 AI 修改前后的工程，列出新增/删除/修改了哪些片段、文字、声音、画中画，以及总时长变化。
// - summarizeDiff：把对比结果写成给用户看的中文短句。
// - needsConfirm：由本地规则决定这次修改要不要先给用户确认（大范围删除、时长大变、全片调色/转场、解锁等），
//   不让模型自己评估风险；其余修改直接生效，用户随时可以撤销。
import { projectDuration } from '../engine/timeline.js';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function same(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a == b; // null 与 undefined 视为相同
  if (typeof a !== typeof b) return false;
  if (typeof a === 'number') return Math.abs(a - b) < 1e-6;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (!same(a[k], b[k])) return false;
  return true;
}
function list(project, kind) {
  const l = project && project.tracks && project.tracks[kind];
  return Array.isArray(l) ? l : [];
}
function overlays(project) {
  return project && Array.isArray(project.overlays) ? project.overlays : [];
}
function r1(n) { return Math.round((Number(n) || 0) * 10) / 10; }
function short(s, max = 16) {
  const t = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
function safeDuration(project) {
  try { return project ? projectDuration(project) : 0; } catch { return 0; }
}
function joinNums(nums, max = 6) {
  const shown = nums.slice(0, max).join('、');
  return nums.length > max ? `${shown} 等` : shown;
}

/** 片段字段 → 用户能懂的类别 */
const CLIP_GROUPS = [
  ['换素材', ['assetId']],
  ['时长', ['in', 'out', 'duration', 'still']],
  ['速度', ['speed', 'speedCurve']],
  ['调色', ['color']],
  ['运镜', ['motion']],
  ['画面位置', ['transform', 'crop', 'fit', 'canvas']],
  ['特效', ['fx']],
  ['转场', ['transitionIn']],
  ['字幕', ['caption']],
  ['声音', ['volume', 'mute', 'muted', 'audioFadeIn', 'audioFadeOut']],
  ['画面属性', ['reverse', 'mirror', 'opacity', 'blend', 'mask']],
  ['关键帧', ['keys']],
  ['锁定', ['locked']],
];
const TEXT_GROUPS = [['文字内容', ['text']], ['出现时间', ['start', 'duration']]];
const AUDIO_GROUPS = [['时间', ['start', 'in', 'out']], ['音量', ['volume', 'mute', 'fadeIn', 'fadeOut', 'duck']]];
const OVERLAY_GROUPS = [['时间', ['start', 'in', 'out', 'speed']], ['位置大小', ['transform', 'x', 'y', 'scale', 'rotation']]];
const IGNORE = new Set(['id', 'updatedAt']);

/** 两个对象之间变化的类别（未归类的字段算「其他设置」） */
function changedGroups(a, b, groups, other = '其他设置') {
  const out = [];
  const covered = new Set();
  for (const [label, keys] of groups) {
    keys.forEach((k) => covered.add(k));
    if (keys.some((k) => !same(a[k], b[k]))) out.push(label);
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (covered.has(k) || IGNORE.has(k)) continue;
    if (!same(a[k], b[k])) { out.push(other); break; }
  }
  return out;
}

function clipName(clip, project) {
  const a = clip && project && project.assets ? project.assets[clip.assetId] : null;
  return short((clip && clip.label) || (a && a.name) || '', 16);
}

/** 按 id 对比一条轨道上的条目 */
function diffItems(beforeList, afterList, groups, nameOf) {
  const bMap = new Map(beforeList.filter((x) => x && x.id).map((x) => [x.id, x]));
  const aMap = new Map(afterList.filter((x) => x && x.id).map((x) => [x.id, x]));
  const added = []; const removed = []; const changed = [];
  for (const [id, x] of aMap) {
    if (!bMap.has(id)) added.push({ id, name: nameOf(x) });
    else {
      const fields = changedGroups(bMap.get(id), x, groups);
      if (fields.length) changed.push({ id, name: nameOf(x), fields });
    }
  }
  for (const [id, x] of bMap) if (!aMap.has(id)) removed.push({ id, name: nameOf(x) });
  return { added, removed, changed };
}

// ---------------------------------------------------------------------------
// diffProject
// ---------------------------------------------------------------------------
/**
 * 对比修改前后的工程。
 * @returns {{
 *   clips:{added:object[], removed:object[], changed:object[], reordered:boolean},
 *   texts:object, audio:object, overlays:object, assetsAdded:object[],
 *   aspect:{from:string,to:string}|null, durationBefore:number, durationAfter:number, durationDelta:number,
 *   clipCountBefore:number, clipCountAfter:number, empty:boolean
 * }}
 * 片段条目带 index（从 1 开始；删除的按修改前编号，其余按修改后编号）。
 */
export function diffProject(before, after) {
  const bv = list(before, 'video');
  const av = list(after, 'video');
  const bIdx = new Map(bv.map((c, i) => [c.id, i]));
  const aIdx = new Map(av.map((c, i) => [c.id, i]));

  const added = av.filter((c) => !bIdx.has(c.id)).map((c) => ({ id: c.id, index: aIdx.get(c.id) + 1, name: clipName(c, after) }));
  const removed = bv.filter((c) => !aIdx.has(c.id)).map((c) => ({ id: c.id, index: bIdx.get(c.id) + 1, name: clipName(c, before) }));
  const changed = [];
  for (const c of av) {
    if (!bIdx.has(c.id)) continue;
    const fields = changedGroups(bv[bIdx.get(c.id)], c, CLIP_GROUPS);
    if (fields.length) changed.push({ id: c.id, index: aIdx.get(c.id) + 1, name: clipName(c, after), fields });
  }
  const keptBefore = bv.filter((c) => aIdx.has(c.id)).map((c) => c.id);
  const keptAfter = av.filter((c) => bIdx.has(c.id)).map((c) => c.id);
  const reordered = keptBefore.some((id, i) => keptAfter[i] !== id);

  const texts = diffItems(list(before, 'text'), list(after, 'text'), TEXT_GROUPS, (t) => short(t.text, 12));
  const audio = diffItems(list(before, 'audio'), list(after, 'audio'), AUDIO_GROUPS, (a) => {
    const asset = after && after.assets ? after.assets[a.assetId] : null;
    return short((asset && asset.name) || (before && before.assets && before.assets[a.assetId] && before.assets[a.assetId].name) || '', 16);
  });
  const ovs = diffItems(overlays(before), overlays(after), OVERLAY_GROUPS, (o) => {
    const asset = after && after.assets ? after.assets[o.assetId] : null;
    return short((asset && asset.name) || '', 16);
  });

  const bAssets = (before && before.assets) || {};
  const assetsAdded = Object.values((after && after.assets) || {})
    .filter((a) => a && a.id && !bAssets[a.id])
    .map((a) => ({ id: a.id, name: short(a.name, 20), kind: a.kind }));

  const fromAspect = before && before.settings && before.settings.aspect;
  const toAspect = after && after.settings && after.settings.aspect;
  const aspect = fromAspect && toAspect && fromAspect !== toAspect ? { from: fromAspect, to: toAspect } : null;

  const durationBefore = safeDuration(before);
  const durationAfter = safeDuration(after);
  const nothing = (d) => !d.added.length && !d.removed.length && !d.changed.length;
  const empty = !added.length && !removed.length && !changed.length && !reordered
    && nothing(texts) && nothing(audio) && nothing(ovs) && !assetsAdded.length && !aspect
    && Math.abs(durationAfter - durationBefore) < 0.01;

  return {
    clips: { added, removed, changed, reordered },
    texts,
    audio,
    overlays: ovs,
    assetsAdded,
    aspect,
    durationBefore,
    durationAfter,
    durationDelta: durationAfter - durationBefore,
    clipCountBefore: bv.length,
    clipCountAfter: av.length,
    empty,
  };
}

// ---------------------------------------------------------------------------
// summarizeDiff
// ---------------------------------------------------------------------------
function itemLine(label, d) {
  const parts = [];
  if (d.added.length) parts.push(`新增 ${d.added.length} 条`);
  if (d.changed.length) parts.push(`修改 ${d.changed.length} 条`);
  if (d.removed.length) parts.push(`删除 ${d.removed.length} 条`);
  return parts.length ? `${label}：${parts.join('、')}` : '';
}

/** 给用户看的改动清单（每条一句中文，最多约 8 条） */
export function summarizeDiff(diff) {
  if (!diff || diff.empty) return ['没有实际改动'];
  const lines = [];
  const { clips } = diff;
  if (clips.added.length) {
    const names = clips.added.map((c) => c.name).filter(Boolean);
    lines.push(`新增 ${clips.added.length} 个片段${names.length ? `：${names.slice(0, 3).join('、')}${names.length > 3 ? ' 等' : ''}` : ''}`);
  }
  if (clips.removed.length) lines.push(`删除 ${clips.removed.length} 个片段（原第 ${joinNums(clips.removed.map((c) => c.index))} 个）`);
  if (clips.changed.length) {
    const fields = Array.from(new Set(clips.changed.flatMap((c) => c.fields)));
    const all = clips.changed.length === diff.clipCountAfter && diff.clipCountAfter > 1;
    const where = all ? '全部片段' : `第 ${joinNums(clips.changed.map((c) => c.index))} 个片段`;
    lines.push(`修改${where}的${fields.slice(0, 4).join('、')}${fields.length > 4 ? '等' : ''}`);
  }
  if (clips.reordered) lines.push('调整了片段顺序');
  const t = itemLine('文字', diff.texts); if (t) lines.push(t);
  const a = itemLine('音乐和声音', diff.audio); if (a) lines.push(a);
  const o = itemLine('画中画', diff.overlays); if (o) lines.push(o);
  if (diff.assetsAdded.length) lines.push(`从素材库加入：${diff.assetsAdded.slice(0, 3).map((x) => x.name || '素材').join('、')}${diff.assetsAdded.length > 3 ? ' 等' : ''}`);
  if (diff.aspect) lines.push(`画幅：${diff.aspect.from} → ${diff.aspect.to}`);
  if (Math.abs(diff.durationDelta) >= 0.05) {
    const d = r1(diff.durationDelta);
    lines.push(`总时长：${r1(diff.durationBefore)} 秒 → ${r1(diff.durationAfter)} 秒（${d > 0 ? '+' : ''}${d} 秒）`);
  }
  return lines.length ? lines : ['没有实际改动'];
}

// ---------------------------------------------------------------------------
// needsConfirm
// ---------------------------------------------------------------------------
export const CONFIRM_RULES = Object.freeze({
  removeClips: 3,        // 一次删除 ≥3 个片段
  durationRatio: 0.2,    // 总时长变化超过两成
  minDurationDelta: 2,   // 且至少变化 2 秒（很短的片子不因零点几秒就打扰用户）
});

const COLOR_TYPES = new Set(['setColor', 'setLook', 'harmonize', 'matchColor']);

function targetsAll(op, clipCount) {
  const t = op && op.target;
  if (!t) return false;
  if (t.mode === 'all') return true;
  if (clipCount > 1 && t.mode === 'index' && Array.isArray(t.indices) && new Set(t.indices).size >= clipCount) return true;
  return false;
}

/**
 * 这次修改要不要先给用户确认（纯本地规则）。
 * @param {{ops?:object[], before:object, after?:object, diff?:object}} args
 * @returns {{need:boolean, reasons:string[]}}
 */
export function needsConfirm({ ops = [], before, after, diff } = {}) {
  const d = diff || (after ? diffProject(before, after) : null);
  const reasons = [];
  const clipCount = list(before, 'video').length;
  const list_ = Array.isArray(ops) ? ops : [];

  if (d && d.clips.removed.length >= CONFIRM_RULES.removeClips) reasons.push(`会删除 ${d.clips.removed.length} 个片段`);
  if (d && d.durationBefore > 0) {
    const delta = Math.abs(d.durationDelta);
    if (delta / d.durationBefore > CONFIRM_RULES.durationRatio && delta >= CONFIRM_RULES.minDurationDelta) {
      reasons.push(`总时长会从 ${r1(d.durationBefore)} 秒变成 ${r1(d.durationAfter)} 秒`);
    }
  }
  const colorAll = list_.some((op) => COLOR_TYPES.has(op.type) && op.type !== 'harmonize' && targetsAll(op, clipCount))
    || (d && clipCount > 2 && d.clips.changed.filter((c) => c.fields.includes('调色')).length >= clipCount);
  if (colorAll) reasons.push('会改动全片的调色');
  const transitionAll = list_.some((op) => op.type === 'setTransitionAll' || (op.type === 'setTransition' && targetsAll(op, clipCount)));
  if (transitionAll) reasons.push('会改动全片的转场');
  if (list_.some((op) => op.type === 'unlock')) reasons.push('会解锁被锁定的片段');
  if (list_.some((op) => op.type === 'clearCaptions')) reasons.push('会清空全部自动字幕');
  if ((d && d.aspect) || (!d && list_.some((op) => op.type === 'setProject' && op.settings && op.settings.aspect))) reasons.push('会改变画幅');

  return { need: reasons.length > 0, reasons: Array.from(new Set(reasons)) };
}
