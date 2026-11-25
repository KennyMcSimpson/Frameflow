// 编辑操作协议（SPEC §4）：AI、本地指令、检查器、技法卡共用的唯一修改入口。
//
// 约定：
// - 原子性：所有操作在工作副本上依次执行，任何一条失败都返回原 project（同一对象）。
//   入参绝不被修改；未改动的部分与原对象结构共享。
// - 同一批操作按顺序生效：后一条的 index 指向前一条执行后的主轨。
//   只有 range 目标例外：它在批次开始时解析一次，避免「先变速再调色」时范围内镜头漂移。
// - 参数里的 null 视为未提供（AI 严格 Schema 用可空字段表达「不改」）。
import { uid, deepClone, round } from './ids.js';
import {
  ASPECTS, LOOKS, LOOK_LABELS, MOTIONS, MOTION_LABELS, TRANSITIONS, TRANSITION_LABELS, FX_KEYS, FX_LABELS, COLOR_LABELS,
  CAPTION_STYLES, TEXT_PRESETS, TEXT_ANIMATIONS, LIMITS,
  createClip, createTextClip, createAudioClip, createSettings,
  SPEED_CURVE_PRESETS, normalizeSpeedCurve, MASK_SHAPES, MASK_LABELS, FIT_MODES, FIT_LABELS, CANVAS_TYPES, BLEND_MODES, BLEND_LABELS,
  OVERLAY_KINDS, MARKER_COLORS, createOverlay, createMarker, normalizeTrackState, isCaptionText, normalizeClip,
} from './model.js';
import {
  clipDuration, layoutVideo, projectDuration, itemsInRange, overlayDuration, sourceTimeAt, subClip, shiftAfter, trackFlags,
  beatTimes, nearestBeat, rollEdit, slipEdit, slideEdit, rippleDelete, trimLeftAt, trimRightAt, autoDuck, isLinked, syncLinked,
  volumeKeyAt, trackLockMessage,
} from './timeline.js';
import { isKeyPath, setKey, removeKey, hasKeyAt, shiftKeys, EASES, KEY_EPS, KEY_PATH_LABELS } from './keyframes.js';
import { colorParamsFromStats } from './colormatch.js';
import { harmonizeOps } from './consistency.js';
import { pacingDurations, PACING_NAMES } from './pacing.js';

const CLIP_OPS = [
  'setColor', 'setLook', 'setMotion', 'setTransform', 'setFx', 'setTransition', 'setCaption', 'setSpeed', 'setVolume',
  'trim', 'setDuration', 'split', 'delete', 'duplicate', 'move', 'replaceAsset', 'lock', 'unlock',
  'matchColor', 'harmonize', 'applyPacing',
];
const GLOBAL_OPS = ['insertAsset', 'addText', 'updateText', 'removeText', 'addAudio', 'updateAudio', 'removeAudio', 'setProject'];
/** v3 扩展操作（PLAN-v3 §3）：按 id/ids/at 定位，不使用 target */
export const EXT_OPS = [
  'setClipProps', 'freezeFrame', 'setSpeedCurve', 'setKeyframe', 'removeKeyframe', 'roll', 'slip', 'slide', 'rippleDelete', 'trimLeft', 'trimRight',
  'addOverlay', 'updateOverlay', 'removeOverlay', 'setTrack', 'addMarker', 'updateMarker', 'removeMarker', 'addCaptions', 'updateCaptionStyle', 'clearCaptions',
  'autoDuck', 'detachAudio', 'snapCutsToBeats', 'setTransitionAll', 'pasteAttributes',
];

export const OP_TYPES = [...CLIP_OPS, ...GLOBAL_OPS, ...EXT_OPS];
const EXT_SET = new Set(EXT_OPS);

const GLOBAL_SET = new Set(GLOBAL_OPS);
// 这些操作的目标可缺省：harmonize/applyPacing 缺省作用于全部镜头
const DEFAULT_ALL = new Set(['harmonize', 'applyPacing']);
const FIRST_CLIP_TRANSITIONS = new Set(['cut', 'dip-black', 'dip-white', 'crossfade']);
const SIGNED_COLOR_KEYS = new Set(['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'highlights', 'shadows']);
const CAPTION_POSITIONS = ['bottom', 'center', 'top'];
const AUDIO_ROLES = ['music', 'sfx', 'voice'];
const EPS = 1e-6;

const CAPTION_STYLE_LABELS = { subtitle: '字幕', title: '标题', 'lower-third': '下三分之一条', none: '不显示' };
const CAPTION_POSITION_LABELS = { bottom: '底部', center: '中间', top: '顶部' };
const PACING_LABELS = { slow: '舒缓', medium: '适中', fast: '紧凑' };

class OpError extends Error {}
function fail(message) {
  throw new OpError(message);
}

// ---------- 参数校验 ----------

function isRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 去掉值为 null/undefined 的键 */
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

function given(v) {
  return v !== null && v !== undefined;
}

function requireNumber(v, label, lo = -Infinity, hi = Infinity) {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${label}必须是数字`);
  if (v < lo || v > hi) {
    if (Number.isFinite(lo) && Number.isFinite(hi)) fail(`${label}必须在 ${lo} 到 ${hi} 之间`);
    if (Number.isFinite(lo)) fail(`${label}不能小于 ${lo}`);
    fail(`${label}不能大于 ${hi}`);
  }
  return v;
}

function requireEnum(v, list, label) {
  if (!list.includes(v)) fail(`${label}「${v}」不受支持`);
  return v;
}

function requireBool(v, label) {
  if (typeof v !== 'boolean') fail(`${label}必须是布尔值`);
  return v;
}

function requirePatch(v, label) {
  if (!isRecord(v)) fail(`缺少${label}参数`);
  const patch = compact(v);
  if (!Object.keys(patch).length) fail(`${label}没有要修改的内容`);
  return patch;
}

function requireString(v, label, maxLength) {
  if (typeof v !== 'string') fail(`${label}必须是文字`);
  if (v.length > maxLength) fail(`${label}不能超过 ${maxLength} 个字符`);
  return v;
}

function requireHexColor(v, label) {
  if (typeof v !== 'string' || !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) fail(`${label}必须是 #RRGGBB 形式的颜色`);
  return v;
}

function optionalStrength(op, dflt) {
  return given(op.strength) ? requireNumber(op.strength, '强度', 0, 1) : dflt;
}

function assetLabel(asset) {
  return asset ? asset.name || '素材' : '素材';
}

function requireAsset(project, assetId) {
  if (typeof assetId !== 'string' || !assetId) fail('缺少素材 id');
  const asset = project.assets && project.assets[assetId];
  if (!asset) fail(`找不到素材（${assetId}），它可能还没有加入项目`);
  return asset;
}

function requireVisualAsset(project, assetId) {
  const asset = requireAsset(project, assetId);
  if (asset.kind === 'audio') fail(`「${assetLabel(asset)}」是音频素材，只能放到音频轨`);
  return asset;
}

/** 视频受素材长度限制；图片/预演可以任意长 */
function maxSourceTime(asset) {
  if (asset && asset.kind === 'video' && Number.isFinite(asset.duration) && asset.duration > 0) return asset.duration;
  return Infinity;
}

// ---------- 目标解析 ----------

function normalizeTarget(target) {
  if (typeof target === 'string') return { mode: target, indices: [], ids: [] };
  if (!isRecord(target)) return null;
  return { mode: target.mode, indices: target.indices || [], ids: target.ids || [] };
}

function normalizeCtx(ctx) {
  const c = ctx || {};
  return {
    selectedClipIds: Array.isArray(c.selectedClipIds) ? c.selectedClipIds : [],
    range: isRecord(c.range) ? c.range : null,
    playhead: Number.isFinite(c.playhead) ? c.playhead : 0,
  };
}

/**
 * 把 target 解析为 0 起的主轨索引（升序去重）。
 * mode 为 none 或选中/范围内没有镜头时返回空数组；编号或 id 无效时 throw。
 */
export function resolveTargets(project, target, ctx, layout) {
  const clips = (project && project.tracks && project.tracks.video) || [];
  const t = normalizeTarget(target) || { mode: 'selected', indices: [], ids: [] };
  const c = normalizeCtx(ctx);
  let result;
  switch (t.mode) {
    case 'none':
      return [];
    case 'all':
      return clips.map((_, i) => i);
    case 'selected': {
      const wanted = new Set(c.selectedClipIds);
      result = [];
      clips.forEach((clip, i) => { if (wanted.has(clip.id)) result.push(i); });
      return result;
    }
    case 'index':
      if (!Array.isArray(t.indices)) throw new OpError('镜头编号格式不正确');
      result = t.indices.map((n) => {
        if (!Number.isInteger(n)) throw new OpError(`镜头编号「${n}」不正确，应为从 1 开始的整数`);
        if (n < 1 || n > clips.length) throw new OpError(`第${n}镜不存在（当前共 ${clips.length} 镜）`);
        return n - 1;
      });
      break;
    case 'ids':
      if (!Array.isArray(t.ids)) throw new OpError('镜头 id 格式不正确');
      result = t.ids.map((id) => {
        const i = clips.findIndex((clip) => clip.id === id);
        if (i < 0) throw new OpError(`找不到镜头（${id}），它可能已被删除`);
        return i;
      });
      break;
    case 'range': {
      if (!c.range) throw new OpError('还没有框选时间范围');
      const items = itemsInRange(layout || layoutVideo(project), c.range.start, c.range.end);
      return items.map((it) => it.index);
    }
    default:
      throw new OpError(`不支持的目标方式「${t.mode}」`);
  }
  return [...new Set(result)].sort((a, b) => a - b);
}

/** 解析操作的目标并执行锁定检查；run.stableRange 保证 range 在批次内稳定 */
function targetsForOp(draft, op, run) {
  let target = normalizeTarget(op.target);
  if (!target && DEFAULT_ALL.has(op.type)) target = { mode: 'all', indices: [], ids: [] };
  if (target && target.mode === 'none') {
    if (DEFAULT_ALL.has(op.type)) target = { mode: 'all', indices: [], ids: [] };
    else fail('这个操作需要指定镜头');
  }
  if (!target) target = { mode: 'selected', indices: [], ids: [] };

  const clips = draft.tracks.video;
  if (!clips.length) fail('时间线上还没有镜头');

  let indices;
  if (target.mode === 'range') {
    if (!run.ctx.range) fail('还没有框选时间范围');
    const stable = new Set(run.stableRangeIds);
    indices = [];
    clips.forEach((clip, i) => { if (stable.has(clip.id)) indices.push(i); });
    if (!indices.length) fail('框选范围内没有镜头');
  } else {
    indices = resolveTargets(draft, target, run.ctx);
    if (!indices.length) fail('请先选中要修改的镜头，或说明是第几段');
  }
  return indices;
}

function checkLocked(draft, indices) {
  for (const i of indices) {
    if (draft.tracks.video[i].locked) fail(`第 ${i + 1} 镜已锁定`);
  }
}

// ---------- 不可变更新助手 ----------

function withVideo(draft, video) {
  return { ...draft, tracks: { ...draft.tracks, video } };
}

function mapClips(draft, indices, fn) {
  const set = new Set(indices);
  return withVideo(draft, draft.tracks.video.map((clip, i) => (set.has(i) ? fn(clip, i) : clip)));
}

function ensureMinDuration(sourceLength, speed, n) {
  if (sourceLength / (speed || 1) < LIMITS.minClip - EPS) fail(`第${n}镜时长不能少于 ${LIMITS.minClip} 秒`);
}

/** 保持入点，把镜头改到时间线时长 duration。视频不超过素材长度（夹紧并返回提示）。 */
function clipWithDuration(clip, duration, asset, n) {
  if (clip.still) return { clip: { ...clip, duration: round(Math.max(LIMITS.minClip, duration), 4) }, note: null };
  const cd = clipDuration(clip);
  const speed = clip.speedCurve && cd > 0 ? (clip.out - clip.in) / cd : clip.speed || 1;
  const max = maxSourceTime(asset);
  let out = clip.in + duration * speed;
  let note = null;
  if (out > max + EPS) {
    out = max;
    note = `第${n}镜素材不够长，已用到最长 ${round((max - clip.in) / speed, 2)} 秒`;
  }
  ensureMinDuration(out - clip.in, speed, n);
  return { clip: { ...clip, out: round(out, 4) }, note };
}

// ---------- 主轨镜头操作 ----------

function colorKeyRange(key) {
  return SIGNED_COLOR_KEYS.has(key) ? [-1, 1] : [0, 1];
}

function validateColorPatch(patch, relative) {
  for (const [key, v] of Object.entries(patch)) {
    if (key === 'look') {
      requireEnum(v, LOOKS, '调色风格');
    } else if (key === 'lookStrength' || key === 'vignette' || SIGNED_COLOR_KEYS.has(key)) {
      const label = key === 'lookStrength' ? '调色风格强度' : COLOR_LABELS[key];
      if (relative) requireNumber(v, `${label}增量`, -2, 2);
      else {
        const [lo, hi] = colorKeyRange(key);
        requireNumber(v, label, lo, hi);
      }
    } else {
      fail(`不支持的调色参数「${key}」`);
    }
  }
}

function applyColorPatch(color, patch, relative) {
  const next = { ...color };
  for (const [key, v] of Object.entries(patch)) {
    if (key === 'look') next.look = v;
    else if (relative) {
      const [lo, hi] = colorKeyRange(key);
      const base = Number.isFinite(next[key]) ? next[key] : (key === 'lookStrength' ? 1 : 0);
      next[key] = round(Math.min(hi, Math.max(lo, base + v)), 3);
    } else next[key] = v;
  }
  return next;
}

const clipHandlers = {
  setColor(draft, op, indices) {
    const patch = requirePatch(op.color, '调色');
    const relative = !!op.relative;
    validateColorPatch(patch, relative);
    return { project: mapClips(draft, indices, (clip) => ({ ...clip, color: applyColorPatch(clip.color, patch, relative) })) };
  },

  setLook(draft, op, indices) {
    if (!given(op.look) && !given(op.lookStrength)) fail('缺少调色风格参数');
    if (given(op.look)) requireEnum(op.look, LOOKS, '调色风格');
    if (given(op.lookStrength)) requireNumber(op.lookStrength, '调色风格强度', 0, 1);
    return {
      project: mapClips(draft, indices, (clip) => ({
        ...clip,
        color: {
          ...clip.color,
          ...(given(op.look) ? { look: op.look } : null),
          ...(given(op.lookStrength) ? { lookStrength: op.lookStrength } : null),
        },
      })),
    };
  },

  setMotion(draft, op, indices) {
    if (!given(op.preset) && !given(op.intensity)) fail('缺少运镜参数');
    if (given(op.preset)) requireEnum(op.preset, MOTIONS, '运镜');
    if (given(op.intensity)) requireNumber(op.intensity, '运镜强度', 0, 1);
    return {
      project: mapClips(draft, indices, (clip) => ({
        ...clip,
        motion: {
          ...clip.motion,
          ...(given(op.preset) ? { preset: op.preset } : null),
          ...(given(op.intensity) ? { intensity: op.intensity } : null),
        },
      })),
    };
  },

  setTransform(draft, op, indices) {
    const patch = requirePatch(op.transform, '画面变换');
    for (const [key, v] of Object.entries(patch)) {
      if (key === 'scale') requireNumber(v, '缩放', 0.05, 5);
      else if (key === 'x') requireNumber(v, '水平位置', -2, 2);
      else if (key === 'y') requireNumber(v, '垂直位置', -2, 2);
      else if (key === 'rotation') requireNumber(v, '旋转角度', -180, 180);
      else if (key === 'flipH') requireBool(v, '水平翻转');
      else fail(`不支持的画面变换参数「${key}」`);
    }
    return {
      project: mapClips(draft, indices, (clip) => {
        const next = { ...clip, transform: { ...clip.transform, ...patch } };
        if ('flipH' in patch) next.mirror = { ...(clip.mirror || { h: false, v: false }), h: !!patch.flipH };
        return next;
      }),
    };
  },

  setFx(draft, op, indices) {
    const patch = requirePatch(op.fx, '特效');
    const relative = !!op.relative;
    for (const [key, v] of Object.entries(patch)) {
      if (!FX_KEYS.includes(key)) fail(`不支持的特效「${key}」`);
      if (relative) requireNumber(v, `${FX_LABELS[key]}增量`, -1, 1);
      else requireNumber(v, FX_LABELS[key], 0, 1);
    }
    return {
      project: mapClips(draft, indices, (clip) => {
        const fx = { ...clip.fx };
        for (const [key, v] of Object.entries(patch)) {
          fx[key] = relative ? round(Math.min(1, Math.max(0, (Number(fx[key]) || 0) + v)), 3) : v;
        }
        return { ...clip, fx };
      }),
    };
  },

  setTransition(draft, op, indices) {
    const tr = requirePatch(op.transition, '转场');
    for (const key of Object.keys(tr)) if (key !== 'type' && key !== 'duration') fail(`不支持的转场参数「${key}」`);
    if (given(tr.type)) requireEnum(tr.type, TRANSITIONS, '转场类型');
    if (given(tr.duration)) requireNumber(tr.duration, '转场时长', LIMITS.minTransition, LIMITS.maxTransition);
    let list = indices;
    let note = null;
    if (given(tr.type) && !FIRST_CLIP_TRANSITIONS.has(tr.type) && indices.includes(0)) {
      if (indices.length === 1) fail(`第一镜不能用「${TRANSITION_LABELS[tr.type]}」，只能用硬切、黑场、白场或叠化淡入`);
      list = indices.filter((i) => i !== 0);
      note = '第一镜前面没有镜头，保持原入场方式';
    }
    return {
      note,
      project: mapClips(draft, list, (clip) => ({ ...clip, transitionIn: { ...clip.transitionIn, ...tr } })),
    };
  },

  setCaption(draft, op, indices) {
    const patch = requirePatch(op.caption, '字幕');
    for (const [key, v] of Object.entries(patch)) {
      if (key === 'text') requireString(v, '字幕内容', 300);
      else if (key === 'style') requireEnum(v, CAPTION_STYLES, '字幕样式');
      else if (key === 'position') requireEnum(v, CAPTION_POSITIONS, '字幕位置');
      else fail(`不支持的字幕参数「${key}」`);
    }
    return { project: mapClips(draft, indices, (clip) => ({ ...clip, caption: { ...clip.caption, ...patch } })) };
  },

  setSpeed(draft, op, indices) {
    const speed = requireNumber(op.speed, '播放速度', LIMITS.minSpeed, LIMITS.maxSpeed);
    const notes = [];
    const project = mapClips(draft, indices, (clip, i) => {
      if (clip.still) {
        if (indices.length === 1) fail(`第${i + 1}镜是定格画面，不能变速`);
        notes.push(`第${i + 1}镜是定格画面，已跳过变速`);
        return clip;
      }
      ensureMinDuration(clip.out - clip.in, speed, i + 1);
      return { ...clip, speed, speedCurve: null };
    });
    return { project, note: notes.join('；') || null };
  },

  setVolume(draft, op, indices) {
    const relative = !!op.relative;
    if (![op.volume, op.mute, op.audioFadeIn, op.audioFadeOut].some(given)) fail('缺少音频参数');
    if (given(op.volume)) {
      if (relative) requireNumber(op.volume, '音量增量', -2, 2);
      else requireNumber(op.volume, '音量', 0, 2);
    }
    if (given(op.mute)) requireBool(op.mute, '静音');
    if (given(op.audioFadeIn)) requireNumber(op.audioFadeIn, '声音淡入时长', 0, 30);
    if (given(op.audioFadeOut)) requireNumber(op.audioFadeOut, '声音淡出时长', 0, 30);
    return {
      project: mapClips(draft, indices, (clip) => {
        const next = { ...clip };
        if (given(op.volume)) {
          next.volume = relative ? round(Math.min(2, Math.max(0, (Number(clip.volume) || 0) + op.volume)), 3) : op.volume;
        }
        if (given(op.mute)) { next.mute = op.mute; next.muted = op.mute; }
        if (given(op.audioFadeIn)) next.audioFadeIn = op.audioFadeIn;
        if (given(op.audioFadeOut)) next.audioFadeOut = op.audioFadeOut;
        return next;
      }),
    };
  },

  trim(draft, op, indices) {
    if (!given(op.in) && !given(op.out)) fail('裁剪需要入点或出点');
    const relative = !!op.relative;
    if (given(op.in)) requireNumber(op.in, relative ? '入点增量' : '入点');
    if (given(op.out)) requireNumber(op.out, relative ? '出点增量' : '出点');
    return {
      project: mapClips(draft, indices, (clip, i) => {
        const n = i + 1;
        if (clip.still) {
          if (relative) {
            const dIn = given(op.in) ? op.in : 0;
            const dOut = given(op.out) ? op.out : 0;
            const nextDur = clipDuration(clip) - dIn + dOut;
            if (nextDur < LIMITS.minClip - EPS) fail(`第${n}镜时长不能少于 ${LIMITS.minClip} 秒`);
            if (nextDur > LIMITS.maxDuration + EPS) fail(`第${n}镜时长不能超过 ${LIMITS.maxDuration} 秒`);
            const hasKeys = clip.keys && Object.keys(clip.keys).length > 0;
            const nextKeys = hasKeys && (Math.abs(dIn) > EPS || dOut < -EPS) ? shiftKeys(clip.keys, -dIn, nextDur) : clip.keys;
            return { ...clip, duration: round(nextDur, 4), keys: nextKeys };
          }
          fail(`第${n}镜是定格画面，请直接调整时长而不是裁剪入出点`);
        }
        const max = maxSourceTime(draft.assets[clip.assetId]);
        let nextIn = clip.in;
        let nextOut = clip.out;
        if (relative) {
          // 增量模式夹紧到素材范围，便于拖动类操作
          if (given(op.in)) nextIn = Math.max(0, clip.in + op.in);
          if (given(op.out)) nextOut = Math.min(max, clip.out + op.out);
        } else {
          if (given(op.in)) nextIn = op.in;
          if (given(op.out)) nextOut = op.out;
          if (nextIn < 0) fail(`第${n}镜入点不能小于 0`);
          if (nextOut > max + EPS) fail(`第${n}镜出点超过了素材长度（${round(max, 2)} 秒）`);
        }
        if (nextOut <= nextIn) fail(`第${n}镜出点必须晚于入点`);
        const next = { ...clip, in: round(nextIn, 4), out: round(nextOut, 4) };
        const nextDur = clipDuration(next);
        if (nextDur < LIMITS.minClip - EPS) fail(`第${n}镜时长不能少于 ${LIMITS.minClip} 秒`);
        if (clip.keys && Object.keys(clip.keys).length) {
          const oldDur = clipDuration(clip);
          const effSpeed = oldDur > 0 ? (clip.out - clip.in) / oldDur : (clip.speed || 1);
          const headDeltaSrc = clip.reverse ? (clip.out - next.out) : (next.in - clip.in);
          const headDeltaTime = headDeltaSrc / (effSpeed || 1);
          if (Math.abs(headDeltaTime) > EPS || nextDur < oldDur - EPS) {
            next.keys = shiftKeys(clip.keys, -headDeltaTime, nextDur);
          }
        }
        return next;
      }),
    };
  },

  setDuration(draft, op, indices) {
    const duration = requireNumber(op.duration, '时长');
    if (duration < LIMITS.minClip) fail(`镜头时长不能少于 ${LIMITS.minClip} 秒`);
    if (duration > LIMITS.maxDuration) fail(`镜头时长不能超过 ${LIMITS.maxDuration} 秒`);
    const notes = [];
    const project = mapClips(draft, indices, (clip, i) => {
      const r = clipWithDuration(clip, duration, draft.assets[clip.assetId], i + 1);
      if (r.note) notes.push(r.note);
      return r.clip;
    });
    return { project, note: notes.join('；') || null };
  },

  delete(draft, op, indices) {
    if (indices.length >= draft.tracks.video.length) fail('至少要保留 1 个镜头，不能全部删除');
    const set = new Set(indices);
    return { project: withVideo(draft, draft.tracks.video.filter((_, i) => !set.has(i))) };
  },

  duplicate(draft, op, indices) {
    const video = [...draft.tracks.video];
    for (const i of [...indices].sort((a, b) => b - a)) {
      video.splice(i + 1, 0, { ...deepClone(video[i]), id: uid('clp') });
    }
    return { project: withVideo(draft, video) };
  },

  move(draft, op, indices) {
    const n = draft.tracks.video.length;
    if (!Number.isInteger(op.toIndex)) fail('目标位置必须是从 1 开始的整数');
    if (op.toIndex < 1 || op.toIndex > n) fail(`目标位置超出范围（当前共 ${n} 镜）`);
    const set = new Set(indices);
    const moved = indices.map((i) => draft.tracks.video[i]);
    const rest = draft.tracks.video.filter((_, i) => !set.has(i));
    rest.splice(Math.min(op.toIndex - 1, rest.length), 0, ...moved);
    return { project: withVideo(draft, rest) };
  },

  replaceAsset(draft, op, indices) {
    const asset = requireVisualAsset(draft, op.assetId);
    const max = maxSourceTime(asset);
    const notes = [];
    const project = mapClips(draft, indices, (clip, i) => {
      if (clip.still) {
        const frame = max === Infinity ? 0 : Math.min(Math.max(0, Number(clip.in) || 0), Math.max(0, max - 1 / 60));
        return { ...clip, assetId: asset.id, in: round(frame, 4), out: round(frame, 4) };
      }
      const length = clip.out - clip.in;
      let nextIn = clip.in;
      let nextOut = clip.out;
      if (max === Infinity || nextOut > max + EPS) {
        nextIn = 0;
        nextOut = Math.min(length, max);
        if (nextOut < length - EPS) notes.push(`第${i + 1}镜新素材较短，时长缩到 ${round(nextOut / (clip.speed || 1), 2)} 秒`);
      }
      const next = { ...clip, assetId: asset.id, in: round(nextIn, 4), out: round(nextOut, 4) };
      if (clipDuration(next) < LIMITS.minClip - EPS) fail(`第${i + 1}镜时长不能少于 ${LIMITS.minClip} 秒`);
      return next;
    });
    return { project, note: notes.join('；') || null };
  },

  lock(draft, op, indices) {
    return { project: mapClips(draft, indices, (clip) => ({ ...clip, locked: true })) };
  },

  unlock(draft, op, indices) {
    return { project: mapClips(draft, indices, (clip) => ({ ...clip, locked: false })) };
  },

  matchColor(draft, op, indices) {
    const reference = op.reference;
    if (!isRecord(reference) || !Number.isFinite(reference.luma)) fail('缺少参考色彩数据');
    const strength = optionalStrength(op, 1);
    return {
      project: mapClips(draft, indices, (clip, i) => {
        const asset = draft.assets[clip.assetId];
        if (!asset || !asset.stats) fail(`第${i + 1}镜还没有色彩数据`);
        return { ...clip, color: { ...clip.color, ...colorParamsFromStats(reference, asset.stats, strength) } };
      }),
    };
  },

  harmonize(draft, op, indices) {
    const strength = optionalStrength(op, 0.6);
    const generated = harmonizeOps(draft, indices, strength);
    if (!generated.length) fail('所选镜头还没有色彩数据，暂时无法统一色调');
    const touched = new Set();
    let project = draft;
    for (const g of generated) {
      const i = g.target.indices[0] - 1;
      touched.add(i);
      project = mapClips(project, [i], (clip) => ({ ...clip, color: { ...clip.color, ...g.color } }));
    }
    const skipped = indices.filter((i) => !touched.has(i)).map((i) => i + 1);
    return { project, note: skipped.length ? `${indexLabel(skipped)}暂无色彩数据，已跳过` : null };
  },

  applyPacing(draft, op, indices) {
    const clips = indices.map((i) => draft.tracks.video[i]);
    let spec;
    if (given(op.durations)) {
      if (!Array.isArray(op.durations)) fail('镜头时长表格式不正确');
      if (op.durations.length !== indices.length) fail(`镜头时长表有 ${op.durations.length} 项，但目标镜头有 ${indices.length} 个`);
      op.durations.forEach((d, k) => requireNumber(d, `第${indices[k] + 1}镜时长`, LIMITS.minClip, LIMITS.maxDuration));
      spec = op.durations;
    } else if (given(op.pacing)) {
      spec = requireEnum(op.pacing, PACING_NAMES, '节奏');
    } else {
      fail('缺少节奏参数');
    }
    const durations = pacingDurations(clips, spec, draft.assets);
    const byIndex = new Map(indices.map((i, k) => [i, durations[k]]));
    return {
      project: mapClips(draft, indices, (clip, i) => clipWithDuration(clip, byIndex.get(i), draft.assets[clip.assetId], i + 1).clip),
    };
  },
};

/** split 自己选择目标镜头：目标里 at 落在内部且两边都够长的那一个 */
function applySplit(draft, op, run) {
  const clips = draft.tracks.video;
  if (!clips.length) fail('时间线上还没有镜头');
  const at = given(op.at) ? requireNumber(op.at, '分割时间', 0) : run.ctx.playhead;
  const layout = layoutVideo(draft);
  const target = normalizeTarget(op.target);

  let candidates = null;
  if (target && target.mode !== 'none') {
    candidates = target.mode === 'range'
      ? targetsForOp(draft, op, run)
      : resolveTargets(draft, target, run.ctx, layout);
    // 没有选中时等同于「播放头所在镜头」；其他目标方式解析为空属于用户指定错误
    if (!candidates.length && target.mode === 'selected') candidates = null;
  }
  const allowed = candidates ? new Set(candidates) : null;

  for (let i = layout.length - 1; i >= 0; i -= 1) {
    const item = layout[i];
    if (allowed && !allowed.has(i)) continue;
    if (at - item.start < LIMITS.minClip - EPS || item.end - at < LIMITS.minClip - EPS) continue;
    if (item.clip.locked) fail(`第 ${i + 1} 镜已锁定`);
    const clip = item.clip;
    const local = at - item.start;
    const left = { ...subClip(clip, 0, local), audioFadeOut: 0 };
    const right = {
      ...deepClone(subClip(clip, local, item.duration)),
      id: uid('clp'),
      audioFadeIn: 0,
      transitionIn: { ...clip.transitionIn, type: 'cut' },
    };
    const video = [...clips];
    video.splice(i, 1, left, right);
    let project = withVideo(draft, video);
    // 联动：跟随这个镜头的文字和音频按分割点分给左右两半。
    // 先算分割后的真实 layout（左半变短可能缩短其入场转场重叠），把右半真实起点传给联动拆分，避免错位。
    if (isLinked(draft)) {
      const afterLayout = layoutVideo(project);
      const rightStart = afterLayout[i + 1] ? afterLayout[i + 1].start : at;
      project = splitLinkedItems(project, clip.id, right.id, at, rightStart);
    }
    return { project, index: i };
  }
  return fail(`分割点 ${round(at, 2)} 秒不在目标镜头内部，或离镜头边缘不足 ${LIMITS.minClip} 秒`);
}

const SPLIT_EPS = 0.05;

/** 把跟随 clipId 的文字/音频按时间线时刻 at 分给左半（clipId）与右半（rightId），右半按 rightStart 对齐。锁定的片段和锁定的轨道不动 */
function splitLinkedItems(project, clipId, rightId, at, rightStart = at) {
  let next = project;
  const rightShift = rightStart - at;
  const texts = Array.isArray(project.tracks.text) ? project.tracks.text : [];
  if (!trackFlags(project, 'text').locked && texts.some((t) => t && t.linkShotId === clipId)) {
    const out = [];
    for (const t of texts) {
      if (!t || t.linkShotId !== clipId || t.locked) { out.push(t); continue; }
      const ts = Number(t.start) || 0;
      const te = ts + (Number(t.duration) || 0);
      if (ts >= at - SPLIT_EPS) out.push({ ...t, start: round(Math.max(0, ts + rightShift), 4), linkShotId: rightId });
      else if (te > at + SPLIT_EPS) {
        out.push({ ...t, duration: round(at - ts, 4) });
        out.push({ ...deepClone(t), id: uid('txt'), start: round(rightStart, 4), duration: round(te - at, 4), linkShotId: rightId });
      } else out.push(t);
    }
    next = { ...next, tracks: { ...next.tracks, text: out } };
  }
  const audios = Array.isArray(project.tracks.audio) ? project.tracks.audio : [];
  const linkKey = (a) => (a && a.linkClipId === clipId ? 'linkClipId' : a && a.linkedClipId === clipId ? 'linkedClipId' : null);
  if (!trackFlags(project, 'audio').locked && audios.some((a) => linkKey(a))) {
    const out = [];
    for (const a of audios) {
      const key = linkKey(a);
      if (!key || a.locked) { out.push(a); continue; }
      const as = Number(a.start) || 0;
      const ae = as + Math.max(0, (Number(a.out) || 0) - (Number(a.in) || 0));
      if (as >= at - SPLIT_EPS) out.push({ ...a, start: round(Math.max(0, as + rightShift), 4), [key]: rightId });
      else if (ae > at + SPLIT_EPS) {
        const cut = at - as; // 片段本地秒
        const mid = round((Number(a.in) || 0) + cut, 4);
        const keys = Array.isArray(a.volumeKeys) ? a.volumeKeys : [];
        const edge = keys.length ? volumeKeyAt(keys, cut) : null;
        const leftKeys = keys.length ? [...keys.filter((k) => k.t < cut - KEY_EPS), { t: round(cut, 3), v: edge }] : keys;
        const rightKeys = keys.length
          ? [{ t: 0, v: edge }, ...keys.filter((k) => k.t > cut + KEY_EPS).map((k) => ({ ...k, t: round(k.t - cut, 3) }))]
          : [];
        out.push({ ...a, out: mid, fadeOut: 0, volumeKeys: leftKeys });
        out.push({ ...deepClone(a), id: uid('aud'), start: round(rightStart, 4), in: mid, fadeIn: 0, volumeKeys: rightKeys, [key]: rightId });
      } else out.push(a);
    }
    next = { ...next, tracks: { ...next.tracks, audio: out } };
  }
  return next;
}

// ---------- 全局操作（素材、文字、音频、项目设置） ----------

const CLEARABLE_TEXT_KEYS = new Set(['stroke', 'shadow', 'bg', 'animIn', 'animOut', 'animLoop', 'group']);

function validateTextPatch(raw) {
  let patch;
  if (typeof raw === 'string') {
    patch = { text: raw };
  } else {
    if (!isRecord(raw)) fail('缺少文字参数');
    patch = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v === undefined) continue;
      if (v === null) {
        if (CLEARABLE_TEXT_KEYS.has(k)) patch[k] = null;
        continue;
      }
      patch[k] = v;
    }
    if (!Object.keys(patch).length) fail('文字没有要修改的内容');
  }
  for (const [key, v] of Object.entries(patch)) {
    switch (key) {
      case 'id': break;
      case 'text':
        requireString(v, '文字内容', 500);
        if (!v.trim()) fail('文字内容不能为空');
        break;
      case 'start': requireNumber(v, '文字开始时间', 0, LIMITS.maxDuration); break;
      case 'duration': requireNumber(v, '文字时长', 0.1, LIMITS.maxDuration); break;
      case 'preset': requireEnum(v, TEXT_PRESETS, '文字样式'); break;
      case 'x': requireNumber(v, '文字水平位置', 0, 1); break;
      case 'y': requireNumber(v, '文字垂直位置', 0, 1); break;
      case 'size': requireNumber(v, '文字大小', 0.2, 5); break;
      case 'color': requireHexColor(v, '文字颜色'); break;
      case 'animation': requireEnum(v, TEXT_ANIMATIONS, '文字动画'); break;
      case 'locked': requireBool(v, '锁定状态'); break;
      case 'group': if (v !== 'caption' && v !== null) fail('文字分组只能是 caption'); break;
      case 'stroke': case 'shadow': case 'bg': case 'animIn': case 'animOut': case 'animLoop':
        if (v !== null && v !== false && !isRecord(v)) fail(`文字参数「${key}」格式不正确`);
        break;
      case 'font': requireString(v, '字体', 80); break;
      case 'align': requireEnum(v, ['left', 'center', 'right'], '对齐方式'); break;
      default: fail(`不支持的文字参数「${key}」`);
    }
  }
  return patch;
}

function findOrFail(list, id, label) {
  if (typeof id !== 'string' || !id) fail(`缺少${label} id`);
  const index = list.findIndex((item) => item.id === id);
  if (index < 0) fail(`找不到这个${label}（${id}），它可能已被删除`);
  return index;
}

function validateAudioPatch(raw) {
  const patch = requirePatch(raw, '音频');
  for (const [key, v] of Object.entries(patch)) {
    switch (key) {
      case 'id': break;
      case 'assetId': if (typeof v !== 'string' || !v) fail('缺少素材 id'); break;
      case 'start': requireNumber(v, '音频开始时间', 0, LIMITS.maxDuration); break;
      case 'in': requireNumber(v, '音频入点', 0); break;
      case 'out': requireNumber(v, '音频出点', 0); break;
      case 'volume': requireNumber(v, '音量', 0, 2); break;
      case 'fadeIn': requireNumber(v, '淡入时长', 0, 30); break;
      case 'fadeOut': requireNumber(v, '淡出时长', 0, 30); break;
      case 'role': requireEnum(v, AUDIO_ROLES, '音频类型'); break;
      case 'locked': requireBool(v, '锁定状态'); break;
      case 'denoise': requireBool(v, '降噪'); break;
      case 'muted': requireBool(v, '静音'); break;
      case 'volumeKeys':
        if (!Array.isArray(v)) fail('音量关键帧格式不正确');
        patch.volumeKeys = v.map((k) => {
          if (!isRecord(k)) fail('音量关键帧格式不正确');
          return { t: round(requireNumber(k.t, '关键帧时间', 0), 3), v: requireNumber(k.v, '关键帧音量', 0, 2) };
        }).sort((a, b) => a.t - b.t);
        break;
      case 'linkedClipId': break;
      default: fail(`不支持的音频参数「${key}」`);
    }
  }
  return patch;
}

function checkAudioSpan(clip, asset) {
  if (clip.out <= clip.in) fail('音频出点必须晚于入点');
  if (Number.isFinite(asset.duration) && asset.duration > 0 && clip.out > asset.duration + EPS) {
    fail(`音频出点超过了素材长度（${round(asset.duration, 2)} 秒）`);
  }
}

function audioAsset(draft, assetId) {
  const asset = requireAsset(draft, assetId);
  if (asset.kind !== 'audio' && asset.kind !== 'video') fail(`「${assetLabel(asset)}」没有声音，不能放到音频轨`);
  return asset;
}

function isOnlyUnlock(patch) {
  return patch.locked === false && Object.keys(patch).length === 1;
}

const globalHandlers = {
  insertAsset(draft, op) {
    const asset = requireVisualAsset(draft, op.assetId);
    const clips = draft.tracks.video;
    const atIndex = given(op.atIndex) ? op.atIndex : clips.length + 1;
    if (!Number.isInteger(atIndex)) fail('插入位置必须是从 1 开始的整数');
    if (atIndex < 1 || atIndex > clips.length + 1) fail(`插入位置超出范围（当前共 ${clips.length} 镜）`);

    // 粘贴整段镜头：带 op.clip 时按它还原调色/特效/变速/定格等，只换新 id 并解锁
    if (isRecord(op.clip)) {
      if (op.clip.assetId !== op.assetId) fail('镜头内容和素材对不上');
      const clip = normalizeClip(deepClone(op.clip), asset);
      clip.id = uid('clp');
      clip.locked = false;
      return { project: withVideo(draft, [...clips.slice(0, atIndex - 1), clip, ...clips.slice(atIndex - 1)]) };
    }

    const max = maxSourceTime(asset);
    const base = createClip(asset);
    const srcIn = given(op.in) ? requireNumber(op.in, '入点', 0) : 0;
    let srcOut;
    let note = null;
    if (given(op.out)) {
      srcOut = requireNumber(op.out, '出点', 0);
      if (srcOut > max + EPS) fail(`出点超过了素材长度（${round(max, 2)} 秒）`);
    } else if (given(op.duration)) {
      srcOut = srcIn + requireNumber(op.duration, '时长', LIMITS.minClip, LIMITS.maxDuration);
      if (srcOut > max + EPS) {
        srcOut = max;
        note = `素材不够长，已用到最长 ${round(max - srcIn, 2)} 秒`;
      }
    } else {
      const defaultLength = asset.kind === 'previz' && asset.duration > 0 ? asset.duration : base.out - base.in;
      srcOut = Math.min(max, srcIn + defaultLength);
    }
    if (srcOut <= srcIn) fail('出点必须晚于入点');
    if (srcOut - srcIn < LIMITS.minClip - EPS) fail(`镜头时长不能少于 ${LIMITS.minClip} 秒`);

    const video = [...clips];
    video.splice(atIndex - 1, 0, { ...base, in: srcIn, out: round(srcOut, 4) });
    return { project: withVideo(draft, video), note };
  },

  addText(draft, op, run) {
    const patch = validateTextPatch(op.text);
    const { id, ...rest } = patch;
    const clip = createTextClip({ start: run.ctx.playhead, ...rest });
    if (typeof id === 'string' && id && !draft.tracks.text.some((t) => t.id === id)) clip.id = id;
    return { project: { ...draft, tracks: { ...draft.tracks, text: [...draft.tracks.text, clip] } } };
  },

  updateText(draft, op) {
    const index = findOrFail(draft.tracks.text, op.textId, '文字');
    const patch = validateTextPatch(op.text);
    delete patch.id;
    const current = draft.tracks.text[index];
    if (current.locked && !isOnlyUnlock(patch)) fail(`文字「${current.text}」已锁定`);
    const text = [...draft.tracks.text];
    text[index] = { ...current, ...patch };
    return { project: { ...draft, tracks: { ...draft.tracks, text } } };
  },

  removeText(draft, op) {
    const index = findOrFail(draft.tracks.text, op.textId, '文字');
    const current = draft.tracks.text[index];
    if (current.locked) fail(`文字「${current.text}」已锁定`);
    return { project: { ...draft, tracks: { ...draft.tracks, text: draft.tracks.text.filter((_, i) => i !== index) } } };
  },

  addAudio(draft, op) {
    const patch = validateAudioPatch(op.audio);
    const { id, ...rest } = patch;
    const asset = audioAsset(draft, rest.assetId);
    const clip = createAudioClip(asset, rest);
    if (typeof id === 'string' && id && !draft.tracks.audio.some((a) => a.id === id)) clip.id = id;
    let note = null;
    if (!given(rest.out)) {
      // 没指定出点时，长音乐自动裁到不超过项目时长上限
      const room = Math.max(0, LIMITS.maxDuration - clip.start);
      if (clip.out - clip.in > room) {
        clip.out = round(clip.in + room, 4);
        note = `音频太长，已裁到项目 ${LIMITS.maxDuration} 秒上限内`;
      }
    }
    checkAudioSpan(clip, asset);
    return { project: { ...draft, tracks: { ...draft.tracks, audio: [...draft.tracks.audio, clip] } }, note };
  },

  updateAudio(draft, op) {
    const index = findOrFail(draft.tracks.audio, op.audioId, '音频');
    const patch = validateAudioPatch(op.audio);
    delete patch.id;
    const current = draft.tracks.audio[index];
    if (current.locked && !isOnlyUnlock(patch)) fail('这段音频已锁定');
    const next = { ...current, ...patch };
    checkAudioSpan(next, audioAsset(draft, next.assetId));
    const audio = [...draft.tracks.audio];
    audio[index] = next;
    return { project: { ...draft, tracks: { ...draft.tracks, audio } } };
  },

  removeAudio(draft, op) {
    const index = findOrFail(draft.tracks.audio, op.audioId, '音频');
    if (draft.tracks.audio[index].locked) fail('这段音频已锁定');
    return { project: { ...draft, tracks: { ...draft.tracks, audio: draft.tracks.audio.filter((_, i) => i !== index) } } };
  },

  setProject(draft, op) {
    const patch = requirePatch(op.settings, '项目设置');
    let settings = { ...draft.settings };
    let timeline = draft.timeline;
    for (const [key, v] of Object.entries(patch)) {
      if (key === 'linked') {
        timeline = { ...(draft.timeline || {}), linked: requireBool(v, '联动') };
      } else if (key === 'aspect') {
        requireEnum(v, Object.keys(ASPECTS), '画幅');
        const { aspect, width, height } = createSettings(v);
        settings = { ...settings, aspect, width, height };
      } else if (key === 'fps') {
        settings.fps = requireNumber(v, '帧率', 12, 60);
      } else if (key === 'background') {
        settings.background = requireHexColor(v, '背景色');
      } else {
        fail(`不支持的项目设置「${key}」`);
      }
    }
    return { project: timeline === draft.timeline ? { ...draft, settings } : { ...draft, settings, timeline } };
  },
};

// ---------- v3 扩展操作（PLAN-v3 §3）：均不走 target 语义，按 id/ids 指定对象 ----------

const CLIP_PROP_KEYS = ['reverse', 'mirror', 'crop', 'fit', 'canvas', 'opacity', 'blend', 'mask', 'muted', 'denoise'];
const CLIP_PROP_LABELS = { reverse: '倒放', mirror: '镜像', crop: '裁切', fit: '画面适配', canvas: '背景画布', opacity: '不透明度', blend: '混合模式', mask: '蒙版', muted: '原声静音', audioFadeIn: '声音淡入', audioFadeOut: '声音淡出', denoise: '降噪' };
const OVERLAY_PATCH_KEYS = ['start', 'in', 'out', 'speed', 'track', 'transform', 'opacity', 'blend', 'mask', 'crop', 'mirror', 'fit', 'volume', 'muted', 'audioFadeIn', 'audioFadeOut', 'denoise', 'locked', 'kind', 'keys'];
export const PASTE_KEYS = ['color', 'fx', 'transform', 'motion', 'transitionIn', 'speed', 'speedCurve', 'volume', 'caption', 'crop', 'mirror', 'opacity', 'blend', 'mask', 'keys', 'canvas', 'fit', 'reverse'];
const PASTE_LABELS = { color: '调色', fx: '特效', transform: '变换', motion: '运镜', transitionIn: '转场', speed: '速度', speedCurve: '曲线变速', volume: '音量', caption: '字幕', crop: '裁切', mirror: '镜像', opacity: '不透明度', blend: '混合模式', mask: '蒙版', keys: '关键帧', canvas: '背景画布', fit: '画面适配', reverse: '倒放' };
const TRACK_LABELS = { video: '主轨', text: '文字轨', audio: '音频轨' };
const FLAG_LABELS = { locked: ['锁定', '解锁'], hidden: ['隐藏', '显示'], muted: ['静音', '取消静音'] };

function wrapEngine(fn) {
  try { return fn(); } catch (e) { if (e instanceof OpError) throw e; return fail(e && e.message ? e.message : String(e)); }
}

/** 扩展操作的镜头定位：id > ids > target（缺省为所选镜头） */
function extClipIndices(draft, op, run) {
  if (given(op.id)) return [findOrFail(draft.tracks.video, op.id, '镜头')];
  if (Array.isArray(op.ids) && op.ids.length) return [...new Set(op.ids.map((id) => findOrFail(draft.tracks.video, id, '镜头')))].sort((a, b) => a - b);
  return targetsForOp(draft, op, run);
}

function validateCrop(v) {
  if (!isRecord(v)) fail('裁切参数格式不正确');
  const out = {};
  for (const k of ['l', 't', 'r', 'b']) out[k] = given(v[k]) ? requireNumber(v[k], '裁切比例', 0, LIMITS.maxCrop) : 0;
  return out;
}
function validateMask(v) {
  if (v === null) return null;
  if (!isRecord(v)) fail('蒙版参数格式不正确');
  requireEnum(v.shape, MASK_SHAPES, '蒙版形状');
  const n = (x, lo, hi, d, label) => (given(x) ? requireNumber(x, label, lo, hi) : d);
  return {
    shape: v.shape, cx: n(v.cx, 0, 1, 0.5, '蒙版中心'), cy: n(v.cy, 0, 1, 0.5, '蒙版中心'), w: n(v.w, 0, 2, 0.5, '蒙版宽度'), h: n(v.h, 0, 2, 0.5, '蒙版高度'),
    rot: n(v.rot, -180, 180, 0, '蒙版旋转'), feather: n(v.feather, 0, 1, 0.1, '蒙版羽化'), invert: given(v.invert) ? requireBool(v.invert, '蒙版反转') : false,
  };
}
function validateVisualProps(raw, allowed) {
  if (!isRecord(raw)) fail('缺少属性参数');
  const out = {};
  for (const [key, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    if (!allowed.includes(key)) fail(`不支持的属性「${key}」`);
    if (v === null && key !== 'mask') continue;
    switch (key) {
      case 'reverse': case 'muted': case 'locked': case 'denoise': out[key] = requireBool(v, CLIP_PROP_LABELS[key] || key); break;
      case 'mirror':
        if (!isRecord(v)) fail('镜像参数格式不正确');
        out.mirror = { h: given(v.h) ? requireBool(v.h, '水平镜像') : false, v: given(v.v) ? requireBool(v.v, '垂直镜像') : false };
        break;
      case 'crop': out.crop = validateCrop(v); break;
      case 'fit': out.fit = requireEnum(v, FIT_MODES, '画面适配'); break;
      case 'canvas':
        if (!isRecord(v)) fail('背景画布参数格式不正确');
        out.canvas = { type: requireEnum(v.type, CANVAS_TYPES, '背景画布'), value: given(v.value) ? v.value : null };
        if (out.canvas.type === 'color' && out.canvas.value) requireHexColor(out.canvas.value, '画布颜色');
        break;
      case 'opacity': out.opacity = requireNumber(v, '不透明度', 0, 1); break;
      case 'blend': out.blend = requireEnum(v, BLEND_MODES, '混合模式'); break;
      case 'mask': out.mask = validateMask(v); break;
      case 'volume': out.volume = requireNumber(v, '音量', 0, 2); break;
      case 'audioFadeIn': out.audioFadeIn = requireNumber(v, '声音淡入时长', 0, 30); break;
      case 'audioFadeOut': out.audioFadeOut = requireNumber(v, '声音淡出时长', 0, 30); break;
      case 'speed': out.speed = requireNumber(v, '播放速度', LIMITS.minSpeed, LIMITS.maxSpeed); break;
      case 'start': out.start = requireNumber(v, '开始时间', 0, LIMITS.maxDuration); break;
      case 'in': out.in = requireNumber(v, '入点', 0); break;
      case 'out': out.out = requireNumber(v, '出点', 0); break;
      case 'track':
        if (!Number.isInteger(v) || v < 1 || v > LIMITS.maxOverlayTrack) fail(`画中画轨只能是 1–${LIMITS.maxOverlayTrack}`);
        out.track = v; break;
      case 'kind': out.kind = requireEnum(v, OVERLAY_KINDS, '画中画类型'); break;
      case 'transform': {
        if (!isRecord(v)) fail('变换参数格式不正确');
        const t = {};
        if (given(v.scale)) t.scale = requireNumber(v.scale, '缩放', 0.05, 5);
        if (given(v.x)) t.x = requireNumber(v.x, '水平位置', -2, 2);
        if (given(v.y)) t.y = requireNumber(v.y, '垂直位置', -2, 2);
        if (given(v.rotation)) t.rotation = requireNumber(v.rotation, '旋转', -360, 360);
        if (given(v.flipH)) t.flipH = requireBool(v.flipH, '水平翻转');
        out.transform = t; break;
      }
      case 'keys': {
        if (!isRecord(v)) fail('关键帧格式不正确');
        const norm = {};
        for (const [path, list] of Object.entries(v)) {
          if (!isKeyPath(path)) fail(`「${path}」不能设置关键帧`);
          if (!Array.isArray(list)) fail('关键帧格式不正确');
          const [lo, hi] = keyRange(path);
          const cleaned = list.map((k) => {
            if (!isRecord(k)) fail('关键帧格式不正确');
            return {
              t: round(requireNumber(k.t, '关键帧时间', 0), 3),
              v: requireNumber(k.v, KEY_PATH_LABELS[path] || '关键帧值', lo, hi),
              ease: given(k.ease) ? requireEnum(k.ease, EASES, '缓动方式') : 'linear',
            };
          }).sort((a, b) => a.t - b.t);
          if (cleaned.length) norm[path] = cleaned;
        }
        out.keys = norm;
        break;
      }
      default: fail(`不支持的属性「${key}」`);
    }
  }
  if (!Object.keys(out).length && !('mask' in raw)) fail('没有要修改的内容');
  return out;
}

function keyRange(path) {
  if (path === 'opacity') return [0, 1];
  if (path === 'volume') return [0, 2];
  if (path === 'transform.scale') return [0.05, 5];
  if (path === 'transform.x' || path === 'transform.y') return [-2, 2];
  if (path === 'transform.rotate') return [-360, 360];
  if (path === 'color.vignette') return [0, 1];
  return [-1, 1];
}

/** 关键帧目标：返回 { list, index, set(item) } */
function keyTarget(draft, op) {
  const target = op.target || 'clip';
  if (target === 'clip') {
    const i = findOrFail(draft.tracks.video, op.id, '镜头');
    const item = draft.tracks.video[i];
    if (item.locked) fail(`第 ${i + 1} 镜已锁定`);
    return { item, duration: clipDuration(item), put: (next) => { const v = [...draft.tracks.video]; v[i] = next; return withVideo(draft, v); } };
  }
  if (target === 'overlay') {
    const list = draft.overlays || [];
    const i = findOrFail(list, op.id, '画中画');
    const item = list[i];
    if (item.locked) fail('这个画中画已锁定');
    return { item, duration: overlayDuration(item), put: (next) => { const l = [...list]; l[i] = next; return { ...draft, overlays: l }; } };
  }
  if (target === 'audio') {
    const i = findOrFail(draft.tracks.audio, op.id, '音频');
    const item = draft.tracks.audio[i];
    if (item.locked) fail('这段音频已锁定');
    return { item, duration: Math.max(0, item.out - item.in), audio: true, put: (next) => { const a = [...draft.tracks.audio]; a[i] = next; return { ...draft, tracks: { ...draft.tracks, audio: a } }; } };
  }
  return fail(`关键帧目标「${target}」不受支持`);
}

function parseTrack(track) {
  if (track === 'video' || track === 'text' || track === 'audio') return { kind: track };
  const m = typeof track === 'string' ? /^overlay[:\s-]?([1-4])$/.exec(track) : null;
  if (m) return { kind: 'overlay', n: Number(m[1]) };
  if (isRecord(track) && track.kind === 'overlay' && Number.isInteger(track.n) && track.n >= 1 && track.n <= 4) return { kind: 'overlay', n: track.n };
  if (isRecord(track) && ['video', 'text', 'audio'].includes(track.kind)) return { kind: track.kind };
  return fail(`轨道「${typeof track === 'string' ? track : JSON.stringify(track)}」不存在`);
}
function trackName(t) { return t.kind === 'overlay' ? `画中画 ${t.n}` : TRACK_LABELS[t.kind]; }

/** 内联版 segmentsToTexts（W10 的 captions.js 提供同名函数；这里保持零依赖，行为一致） */
export function captionTextsFromSegments(segments, { preset = 'subtitle', aspect = '16:9', style = null } = {}) {
  const y = aspect === '9:16' ? 0.72 : 0.86;
  const out = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    if (!isRecord(seg)) continue;
    const start = Number(seg.start);
    const end = Number(seg.end);
    const text = String(seg.text || '').trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 0.1 || !text) continue;
    out.push(createTextClip({
      start: round(Math.max(0, start), 3), duration: round(Math.min(LIMITS.maxDuration, end - start), 3), text: text.slice(0, 500),
      preset: TEXT_PRESETS.includes(preset) ? preset : 'subtitle', y, size: aspect === '9:16' ? 0.9 : 0.8, animation: 'none', group: 'caption',
      stroke: { color: '#000000', width: 3 }, ...(isRecord(style) ? style : {}),
    }));
  }
  return out.sort((a, b) => a.start - b.start);
}

function freezeImpl(draft, op, run) {
  const at = given(op.at) ? requireNumber(op.at, '定格时间', 0) : run.ctx.playhead;
  const duration = given(op.duration) ? requireNumber(op.duration, '定格时长', LIMITS.minClip, 30) : 2;
  const layout = layoutVideo(draft);
  if (!layout.length) fail('时间线上还没有镜头');
  let it = null;
  if (given(op.id)) it = layout[findOrFail(draft.tracks.video, op.id, '镜头')];
  else for (let i = layout.length - 1; i >= 0; i -= 1) if (at >= layout[i].start - EPS && at <= layout[i].end + EPS) { it = layout[i]; break; }
  if (!it) fail(`${round(at, 2)} 秒处没有镜头可以定格`);
  if (it.clip.locked) fail(`第 ${it.index + 1} 镜已锁定`);
  const local = Math.min(it.duration, Math.max(0, at - it.start));
  const frame = round(sourceTimeAt(it.clip, Math.min(local, Math.max(0, it.duration - 1 / 60))), 4);
  const still = {
    ...deepClone(it.clip), id: uid('clp'), still: true, in: frame, out: frame, duration, speed: 1, speedCurve: null, reverse: false,
    keys: {}, motion: { preset: 'none', intensity: 0.5 }, transitionIn: { type: 'cut', duration: 0.5 }, mute: true, muted: true, audioFadeIn: 0, audioFadeOut: 0, label: '定格',
  };
  const video = [...draft.tracks.video];
  let project;
  if (local < LIMITS.minClip - EPS) {
    video.splice(it.index, 0, still);
    const base = withVideo(draft, video);
    const afterLayout = layoutVideo(base);
    const delta = afterLayout[it.index + 1] ? afterLayout[it.index + 1].start - it.start : duration;
    project = shiftAfter(base, it.start - EPS, delta);
  } else if (it.duration - local < LIMITS.minClip - EPS) {
    video.splice(it.index + 1, 0, still);
    const base = withVideo(draft, video);
    const afterLayout = layoutVideo(base);
    const delta = it.index + 1 < layout.length && afterLayout[it.index + 2]
      ? afterLayout[it.index + 2].start - layout[it.index + 1].start
      : duration;
    project = shiftAfter(base, it.end - EPS, delta);
  } else {
    const left = { ...subClip(it.clip, 0, local), audioFadeOut: 0 };
    const right = { ...deepClone(subClip(it.clip, local, it.duration)), id: uid('clp'), audioFadeIn: 0, transitionIn: { ...it.clip.transitionIn, type: 'cut' } };
    video.splice(it.index, 1, left, still, right);
    const base = withVideo(draft, video);
    const afterLayout = layoutVideo(base);
    const splitAt = it.start + local;
    const rightStart = afterLayout[it.index + 2] ? afterLayout[it.index + 2].start : splitAt + duration;
    const shiftDelta = rightStart - splitAt;
    if (isLinked(draft)) {
      // 非当前镜头的关联/独立项与画中画、标记随定格后移；当前镜头的关联文字和音频按定格点拆成左右两段，避开静帧
      const shifted = shiftAfter(base, splitAt - EPS, shiftDelta);
      const isOwnText = (t) => t && t.linkShotId === it.clip.id;
      const isOwnAudio = (a) => a && (a.linkClipId === it.clip.id || a.linkedClipId === it.clip.id);
      const preTexts = base.tracks.text || [];
      const preAudios = base.tracks.audio || [];
      const merged = {
        ...shifted,
        tracks: {
          ...shifted.tracks,
          text: shifted.tracks.text.map((t, idx) => (isOwnText(preTexts[idx]) ? preTexts[idx] : t)),
          audio: shifted.tracks.audio.map((a, idx) => (isOwnAudio(preAudios[idx]) ? preAudios[idx] : a)),
        },
      };
      project = splitLinkedItems(merged, it.clip.id, right.id, splitAt, rightStart);
    } else {
      project = shiftAfter(base, splitAt - EPS, shiftDelta);
    }
  }
  return { project, note: null, at: round(it.start + local, 2), duration };
}

function snapCutsImpl(draft, op) {
  let beats;
  if (given(op.assetId)) {
    const asset = requireAsset(draft, op.assetId);
    if (!Array.isArray(asset.beats) || !asset.beats.length) fail(`「${assetLabel(asset)}」还没有节拍数据，请先分析音乐节拍`);
    const placed = draft.tracks.audio.filter((a) => a.assetId === asset.id);
    beats = placed.length
      ? beatTimes({ ...draft, tracks: { ...draft.tracks, audio: placed } })
      : asset.beats.map(Number).filter(Number.isFinite);
  } else {
    beats = beatTimes(draft);
  }
  if (!beats.length) fail('没有可用的音乐节拍：请先添加音乐并分析节拍');
  let project = draft;
  let moved = 0;
  const n = project.tracks.video.length;
  for (let i = 1; i < n; i += 1) {
    const layout = layoutVideo(project);
    const prevItem = layout[i - 1];
    const cut = layout[i].start;
    const candidates = beats.filter((b) => b > prevItem.start + LIMITS.minClip && b < layout[i].end - LIMITS.minClip);
    const b = nearestBeat(candidates, cut, 1.5);
    if (b === null || Math.abs(b - cut) < 1e-3) continue;
    if (prevItem.clip.locked || layout[i].clip.locked) continue;
    try {
      project = rollEdit(project, cut, b - cut).project;
      moved += 1;
    } catch { /* 到边界的剪辑点保持不动 */ }
  }
  if (!moved) fail('剪辑点已经在节拍上，或素材长度不允许调整');
  return { project, note: `已对齐 ${moved} 个剪辑点`, moved };
}

const extHandlers = {
  setClipProps(draft, op, run) {
    const indices = extClipIndices(draft, op, run);
    checkLocked(draft, indices);
    const patch = validateVisualProps(op.patch, CLIP_PROP_KEYS);
    return {
      project: mapClips(draft, indices, (clip) => {
        const next = { ...clip, ...patch };
        if ('muted' in patch) next.mute = patch.muted;
        if (patch.mirror) next.transform = { ...(clip.transform || {}), flipH: !!patch.mirror.h };
        return next;
      }),
    };
  },

  freezeFrame(draft, op, run) {
    const r = freezeImpl(draft, op, run);
    return { project: r.project, note: r.note };
  },

  setSpeedCurve(draft, op, run) {
    const indices = extClipIndices(draft, op, run);
    checkLocked(draft, indices);
    let curve = null;
    if (given(op.preset)) {
      const p = SPEED_CURVE_PRESETS[op.preset];
      if (!p) fail(`变速曲线预设「${op.preset}」不存在`);
      curve = p.curve;
    } else if (given(op.curve)) {
      if (!Array.isArray(op.curve)) fail('变速曲线格式不正确');
      op.curve.forEach((pt) => { if (!isRecord(pt)) fail('变速曲线点格式不正确'); requireNumber(pt.t, '曲线时间', 0, 1); requireNumber(pt.v, '曲线速度', LIMITS.minSpeed, LIMITS.maxSpeed); });
      curve = normalizeSpeedCurve(op.curve);
      if (!curve) fail('变速曲线至少需要 2 个点');
    }
    return {
      project: mapClips(draft, indices, (clip, i) => {
        if (clip.still) fail(`第${i + 1}镜是定格画面，不能变速`);
        const next = { ...clip, speedCurve: curve ? curve.map((pt) => ({ ...pt })) : null };
        if (clipDuration(next) < LIMITS.minClip - EPS) fail(`第${i + 1}镜变速后不足 ${LIMITS.minClip} 秒`);
        return next;
      }),
    };
  },

  setKeyframe(draft, op) {
    if (!isKeyPath(op.path)) fail(`「${op.path}」不能设置关键帧`);
    const tgt = keyTarget(draft, op);
    const t = requireNumber(op.t, '关键帧时间', 0);
    if (t > tgt.duration + EPS) fail(`关键帧时间超出片段长度（${round(tgt.duration, 2)} 秒）`);
    const [lo, hi] = keyRange(op.path);
    const v = requireNumber(op.v, KEY_PATH_LABELS[op.path] || '关键帧值', lo, hi);
    if (given(op.ease)) requireEnum(op.ease, EASES, '缓动方式');
    if (tgt.audio) {
      if (op.path !== 'volume') fail('音频只能设置音量关键帧');
      const list = (tgt.item.volumeKeys || []).filter((k) => Math.abs(k.t - t) > KEY_EPS);
      return { project: tgt.put({ ...tgt.item, volumeKeys: [...list, { t: round(t, 3), v }].sort((a, b) => a.t - b.t) }) };
    }
    return { project: tgt.put({ ...tgt.item, keys: setKey(tgt.item.keys || {}, op.path, t, v, op.ease || undefined) }) };
  },

  removeKeyframe(draft, op) {
    const tgt = keyTarget(draft, op);
    const t = requireNumber(op.t, '关键帧时间', 0);
    if (tgt.audio) {
      const list = tgt.item.volumeKeys || [];
      const next = list.filter((k) => Math.abs(k.t - t) > KEY_EPS);
      if (next.length === list.length) fail('这个时间点没有关键帧');
      return { project: tgt.put({ ...tgt.item, volumeKeys: next }) };
    }
    if (!isKeyPath(op.path)) fail(`「${op.path}」不能设置关键帧`);
    if (!hasKeyAt(tgt.item.keys, op.path, t)) fail('这个时间点没有关键帧');
    return { project: tgt.put({ ...tgt.item, keys: removeKey(tgt.item.keys, op.path, t) }) };
  },

  roll(draft, op, run) {
    const at = given(op.at) ? requireNumber(op.at, '剪辑点', 0) : run.ctx.playhead;
    const delta = requireNumber(op.delta, '滚动量', -LIMITS.maxDuration, LIMITS.maxDuration);
    const r = wrapEngine(() => rollEdit(draft, at, delta));
    return { project: r.project, note: Math.abs(r.delta - delta) > 1e-3 ? `已到素材边界，实际移动 ${round(r.delta, 2)} 秒` : null };
  },

  slip(draft, op) {
    const delta = requireNumber(op.delta, '内滑量', -3600, 3600);
    const r = wrapEngine(() => slipEdit(draft, op.id, delta));
    return { project: r.project, note: Math.abs(r.delta - delta) > 1e-3 ? `已到素材边界，实际内滑 ${round(r.delta, 2)} 秒` : null };
  },

  slide(draft, op) {
    const delta = requireNumber(op.delta, '外滑量', -LIMITS.maxDuration, LIMITS.maxDuration);
    const r = wrapEngine(() => slideEdit(draft, op.id, delta));
    return { project: r.project, note: Math.abs(r.delta - delta) > 1e-3 ? `已到边界，实际移动 ${round(r.delta, 2)} 秒` : null };
  },

  rippleDelete(draft, op, run) {
    let ids = Array.isArray(op.ids) ? op.ids : given(op.id) ? [op.id] : [];
    // 没有 ids 但给了 target（AI 精修）：按镜头目标解析
    if (!ids.length && op.target) ids = targetsForOp(draft, op, run).map((i) => draft.tracks.video[i].id);
    if (!ids.length) fail('请先选中要删除的内容');
    return { project: wrapEngine(() => rippleDelete(draft, ids)) };
  },

  trimLeft(draft, op, run) {
    const at = given(op.at) ? requireNumber(op.at, '播放头位置', 0) : run.ctx.playhead;
    return { project: wrapEngine(() => trimLeftAt(draft, at)) };
  },

  trimRight(draft, op, run) {
    const at = given(op.at) ? requireNumber(op.at, '播放头位置', 0) : run.ctx.playhead;
    return { project: wrapEngine(() => trimRightAt(draft, at)) };
  },

  addOverlay(draft, op, run) {
    const asset = requireVisualAsset(draft, op.assetId);
    const track = given(op.track) ? op.track : 1;
    if (!Number.isInteger(track) || track < 1 || track > LIMITS.maxOverlayTrack) fail(`画中画轨只能是 1–${LIMITS.maxOverlayTrack}`);
    if (trackFlags(draft, 'overlay', track).locked) fail(trackLockMessage('overlay', track));
    const start = given(op.start) ? requireNumber(op.start, '开始时间', 0, LIMITS.maxDuration) : run.ctx.playhead;
    const o = createOverlay(asset, { start: round(start, 4), track });
    if (typeof op.overlayId === 'string' && op.overlayId && !(draft.overlays || []).some((x) => x.id === op.overlayId)) o.id = op.overlayId;
    return { project: { ...draft, overlays: [...(draft.overlays || []), o] } };
  },

  updateOverlay(draft, op) {
    const list = draft.overlays || [];
    const i = findOrFail(list, op.id, '画中画');
    const cur = list[i];
    const patch = validateVisualProps(op.patch, OVERLAY_PATCH_KEYS);
    const srcTrack = cur.track || 1;
    if (trackFlags(draft, 'overlay', srcTrack).locked) fail(trackLockMessage('overlay', srcTrack));
    if (given(patch.track) && patch.track !== srcTrack && trackFlags(draft, 'overlay', patch.track).locked) {
      fail(trackLockMessage('overlay', patch.track));
    }
    if (cur.locked && !isOnlyUnlock(patch)) fail('这个画中画已锁定');
    const next = { ...cur, ...patch, transform: patch.transform ? { ...cur.transform, ...patch.transform } : cur.transform };
    if (patch.transform && 'flipH' in patch.transform && !patch.mirror) {
      next.mirror = { ...(cur.mirror || { h: false, v: false }), h: !!patch.transform.flipH };
    }
    if (patch.mirror) {
      next.transform = { ...(next.transform || {}), flipH: !!patch.mirror.h };
    }
    if (next.out <= next.in) fail('画中画出点必须晚于入点');
    const asset = draft.assets[next.assetId];
    const max = maxSourceTime(asset);
    if (next.out > max + EPS) fail(`出点超过了素材长度（${round(max, 2)} 秒）`);
    if (overlayDuration(next) < LIMITS.minClip - EPS) fail(`画中画时长不能少于 ${LIMITS.minClip} 秒`);
    const l = [...list];
    l[i] = next;
    return { project: { ...draft, overlays: l } };
  },

  removeOverlay(draft, op) {
    const list = draft.overlays || [];
    const i = findOrFail(list, op.id, '画中画');
    const cur = list[i];
    if (trackFlags(draft, 'overlay', cur.track || 1).locked) fail(trackLockMessage('overlay', cur.track || 1));
    if (cur.locked) fail('这个画中画已锁定');
    return { project: { ...draft, overlays: list.filter((_, k) => k !== i) } };
  },

  setTrack(draft, op) {
    const t = parseTrack(op.track);
    if (!isRecord(op.patch)) fail('缺少轨道参数');
    const patch = {};
    for (const [k, v] of Object.entries(op.patch)) {
      if (v === null || v === undefined) continue;
      if (!FLAG_LABELS[k]) fail(`不支持的轨道参数「${k}」`);
      patch[k] = requireBool(v, FLAG_LABELS[k][0]);
    }
    if (!Object.keys(patch).length) fail('没有要修改的轨道状态');
    const st = normalizeTrackState(draft.trackState);
    if (t.kind === 'overlay') st.overlay = { ...st.overlay, [t.n]: { ...st.overlay[t.n], ...patch } };
    else st[t.kind] = { ...st[t.kind], ...patch };
    return { project: { ...draft, trackState: st } };
  },

  addMarker(draft, op, run) {
    const t = given(op.t) ? requireNumber(op.t, '标记时间', 0, LIMITS.maxDuration) : run.ctx.playhead;
    const label = given(op.label) ? requireString(op.label, '标记名称', 60) : '';
    const color = given(op.color) ? requireHexColor(op.color, '标记颜色') : MARKER_COLORS[0];
    const m = createMarker({ t: round(t, 3), label, color });
    if (typeof op.markerId === 'string' && op.markerId && !(draft.markers || []).some((x) => x.id === op.markerId)) m.id = op.markerId;
    return { project: { ...draft, markers: [...(draft.markers || []), m].sort((a, b) => a.t - b.t) } };
  },

  updateMarker(draft, op) {
    const list = draft.markers || [];
    const i = findOrFail(list, op.id, '标记');
    const p = requirePatch(op.patch, '标记');
    const next = { ...list[i] };
    for (const [k, v] of Object.entries(p)) {
      if (k === 't') next.t = round(requireNumber(v, '标记时间', 0, LIMITS.maxDuration), 3);
      else if (k === 'label') next.label = requireString(v, '标记名称', 60);
      else if (k === 'color') next.color = requireHexColor(v, '标记颜色');
      else fail(`不支持的标记参数「${k}」`);
    }
    const l = [...list];
    l[i] = next;
    return { project: { ...draft, markers: l.sort((a, b) => a.t - b.t) } };
  },

  removeMarker(draft, op) {
    const list = draft.markers || [];
    const i = findOrFail(list, op.id, '标记');
    return { project: { ...draft, markers: list.filter((_, k) => k !== i) } };
  },

  addCaptions(draft, op) {
    if (!Array.isArray(op.segments) || !op.segments.length) fail('没有可添加的字幕片段');
    if (given(op.preset)) requireEnum(op.preset, TEXT_PRESETS, '字幕样式');
    const existing = draft.tracks.text.filter((t) => t.group === 'caption');
    // 复用当前字幕样式，避免重新识别后丢失用户改过的样式
    const sample = existing[0];
    const style = sample ? { preset: sample.preset, y: sample.y, size: sample.size, color: sample.color, stroke: sample.stroke, shadow: sample.shadow, bg: sample.bg } : null;
    const texts = captionTextsFromSegments(op.segments, { preset: op.preset || (sample && sample.preset) || 'subtitle', aspect: draft.settings && draft.settings.aspect, style: given(op.preset) ? null : style });
    if (!texts.length) fail('字幕片段都为空或时间不正确');
    if (existing.some((t) => t.locked)) fail('有字幕已锁定，无法替换');
    const text = [...draft.tracks.text.filter((t) => t.group !== 'caption'), ...texts];
    return { project: { ...draft, tracks: { ...draft.tracks, text } }, note: `共 ${texts.length} 条` };
  },

  updateCaptionStyle(draft, op) {
    const patch = validateTextPatch(op.patch);
    for (const k of ['id', 'text', 'start', 'duration', 'group']) delete patch[k];
    if (!Object.keys(patch).length) fail('没有要修改的字幕样式');
    let n = 0;
    const text = draft.tracks.text.map((t) => { if (!isCaptionText(t) || t.locked) return t; n += 1; return { ...t, ...patch }; });
    if (!n) fail('还没有字幕');
    return { project: { ...draft, tracks: { ...draft.tracks, text } } };
  },

  clearCaptions(draft) {
    const before = draft.tracks.text.length;
    const text = draft.tracks.text.filter((t) => !isCaptionText(t) || t.locked);
    if (text.length === before) fail(draft.tracks.text.some(isCaptionText) ? '字幕都已锁定，先解锁再清空' : '还没有字幕');
    return { project: { ...draft, tracks: { ...draft.tracks, text } } };
  },

  autoDuck(draft, op) {
    const amount = given(op.amount) ? requireNumber(op.amount, '闪避强度', 0, 1) : 0.25;
    const map = autoDuck(draft, { amount, attack: given(op.attack) ? requireNumber(op.attack, '起音', 0, 5) : 0.2, release: given(op.release) ? requireNumber(op.release, '释音', 0, 5) : 0.4 });
    const ids = Object.keys(map);
    if (!ids.length) fail('没有可以闪避的背景音乐');
    let ducked = 0;
    const audio = draft.tracks.audio.map((a) => {
      if (!(a.id in map) || a.locked) return a;
      if (map[a.id].length) ducked += 1;
      return { ...a, volumeKeys: map[a.id] };
    });
    return { project: { ...draft, tracks: { ...draft.tracks, audio } }, note: ducked ? null : '没有检测到与音乐重叠的人声，已清除闪避' };
  },

  detachAudio(draft, op, run) {
    const indices = extClipIndices(draft, op, run);
    checkLocked(draft, indices);
    const layout = layoutVideo(draft);
    const added = [];
    const project = mapClips(draft, indices, (clip, i) => {
      const asset = draft.assets[clip.assetId];
      if (!asset || asset.kind !== 'video' || asset.hasAudio === false) fail(`第${i + 1}镜没有原声可分离`);
      if (clip.still || clip.reverse || clip.speedCurve || Math.abs((clip.speed || 1) - 1) > 1e-6) fail(`第${i + 1}镜有变速/倒放/定格，暂不支持分离音频`);
      const it = layout[i];
      const volKeys = clip.keys && Array.isArray(clip.keys.volume)
        ? clip.keys.volume
          .filter((k) => k && Number.isFinite(Number(k.t)) && Number.isFinite(Number(k.v)))
          .map((k) => ({ t: round(Math.max(0, Number(k.t)), 3), v: Number(k.v) }))
          .sort((a, b) => a.t - b.t)
        : [];
      added.push(createAudioClip(asset, {
        start: round(it.start, 4), in: clip.in, out: clip.out, volume: clip.volume ?? 1,
        fadeIn: clip.audioFadeIn || 0, fadeOut: clip.audioFadeOut || 0, role: 'voice', linkedClipId: clip.id,
        ...(volKeys.length ? { volumeKeys: volKeys } : null),
      }));
      return { ...clip, mute: true, muted: true };
    });
    return { project: { ...project, tracks: { ...project.tracks, audio: [...project.tracks.audio, ...added] } }, note: `已生成 ${added.length} 段音频` };
  },

  snapCutsToBeats(draft, op) {
    const r = snapCutsImpl(draft, op);
    return { project: r.project, note: r.note };
  },

  setTransitionAll(draft, op) {
    // op.type 已被操作类型占用：转场类型放在 transition（字符串或 {type,duration}）或 transitionType
    const spec = transitionAllSpec(op);
    const type = requireEnum(spec.type, TRANSITIONS, '转场');
    const duration = given(spec.duration) ? requireNumber(spec.duration, '转场时长', LIMITS.minTransition, LIMITS.maxTransition) : 0.5;
    if (!draft.tracks.video.length) fail('时间线上还没有镜头');
    let skipped = 0;
    const video = draft.tracks.video.map((clip, i) => {
      if (clip.locked) { skipped += 1; return clip; }
      if (i === 0 && !FIRST_CLIP_TRANSITIONS.has(type)) return clip;
      return { ...clip, transitionIn: { type, duration } };
    });
    return { project: withVideo(draft, video), note: skipped ? `${skipped} 个锁定镜头未修改` : null };
  },

  pasteAttributes(draft, op) {
    const fromIndex = findOrFail(draft.tracks.video, op.from, '源镜头');
    const src = draft.tracks.video[fromIndex];
    if (!Array.isArray(op.toIds) || !op.toIds.length) fail('请选择要粘贴到的镜头');
    const keys = Array.isArray(op.keys) && op.keys.length ? op.keys : ['color', 'fx', 'transform', 'motion'];
    keys.forEach((k) => requireEnum(k, PASTE_KEYS, '属性'));
    const indices = [...new Set(op.toIds.map((id) => findOrFail(draft.tracks.video, id, '镜头')))].filter((i) => i !== fromIndex);
    if (!indices.length) fail('不能粘贴到源镜头自己');
    checkLocked(draft, indices);
    return {
      project: mapClips(draft, indices, (clip, i) => {
        const next = { ...clip };
        const pastingCurve = keys.includes('speedCurve') && !!src.speedCurve;
        for (const k of keys) {
          if (k === 'transitionIn' && i === 0 && src.transitionIn && !FIRST_CLIP_TRANSITIONS.has(src.transitionIn.type)) continue;
          if (k === 'speedCurve' && src.speedCurve && clip.still) fail(`第${i + 1}镜是定格画面，不能粘贴变速曲线`);
          next[k] = deepClone(src[k] === undefined ? null : src[k]);
          if (k === 'speed' && !pastingCurve) next.speedCurve = null;
          if (k === 'transform') next.mirror = { ...(next.mirror || { h: false, v: false }), h: !!(next.transform && next.transform.flipH) };
          if (k === 'mirror') next.transform = { ...(next.transform || {}), flipH: !!(next.mirror && next.mirror.h) };
        }
        const dur = clipDuration(next);
        if (dur < LIMITS.minClip - EPS) fail(`第${i + 1}镜粘贴速度后不足 ${LIMITS.minClip} 秒`);
        if (keys.includes('keys') && next.keys && Object.keys(next.keys).length) {
          next.keys = shiftKeys(next.keys, 0, dur);
        }
        return next;
      }),
    };
  },
};

function transitionAllSpec(op) {
  if (isRecord(op.transition)) return { type: op.transition.type, duration: op.transition.duration ?? op.duration };
  return { type: typeof op.transition === 'string' ? op.transition : op.transitionType, duration: op.duration };
}

function clipNo(project, id) {
  const i = ((project && project.tracks && project.tracks.video) || []).findIndex((c) => c.id === id);
  return i >= 0 ? `第${i + 1}镜` : '镜头';
}
function clipsNo(project, op) {
  if (given(op.id)) return clipNo(project, op.id);
  if (Array.isArray(op.ids) && op.ids.length) {
    const clips = (project && project.tracks && project.tracks.video) || [];
    const nums = op.ids.map((id) => clips.findIndex((c) => c.id === id) + 1).filter((n) => n > 0);
    return nums.length ? indexLabel(nums) : `${op.ids.length} 个镜头`;
  }
  return targetLabel(op, project) || '所选镜头';
}
function sec(v) { return `${fmt(v)} 秒`; }

function describeClipProps(patch) {
  const parts = [];
  for (const [k, v] of Object.entries(isRecord(patch) ? patch : {})) {
    switch (k) {
      case 'reverse': parts.push(v ? '倒放' : '取消倒放'); break;
      case 'muted': parts.push(v ? '原声静音' : '恢复原声'); break;
      case 'denoise': parts.push(v ? '开启降噪' : '关闭降噪'); break;
      case 'mirror': parts.push(v && (v.h || v.v) ? `镜像（${[v.h && '水平', v.v && '垂直'].filter(Boolean).join('+')}）` : '取消镜像'); break;
      case 'fit': parts.push(`画面${FIT_LABELS[v] || v}`); break;
      case 'blend': parts.push(`混合模式 ${BLEND_LABELS[v] || v}`); break;
      case 'opacity': parts.push(`不透明度 ${Math.round(Number(v) * 100)}%`); break;
      case 'mask': parts.push(v ? `${MASK_LABELS[v.shape] || ''}蒙版` : '移除蒙版'); break;
      case 'canvas': parts.push(v && v.type !== 'none' ? `背景画布 ${({ blur: '模糊', color: '颜色', image: '图片' })[v.type] || v.type}` : '去掉背景画布'); break;
      default: parts.push(CLIP_PROP_LABELS[k] || k);
    }
  }
  return parts.join('、') || '修改属性';
}

function describeExt(op, project) {
  switch (op.type) {
    case 'setClipProps': return `${clipsNo(project, op)}：${describeClipProps(op.patch)}`;
    case 'freezeFrame': return `在 ${sec(op.at ?? 0)}处定格 ${sec(op.duration ?? 2)}`;
    case 'setSpeedCurve':
      if (given(op.preset)) return `${clipsNo(project, op)}：曲线变速「${(SPEED_CURVE_PRESETS[op.preset] || {}).label || op.preset}」`;
      return given(op.curve) ? `${clipsNo(project, op)}：自定义曲线变速` : `${clipsNo(project, op)}：取消曲线变速`;
    case 'setKeyframe': return `${op.target === 'overlay' ? '画中画' : op.target === 'audio' ? '音频' : clipNo(project, op.id)}：在 ${sec(op.t ?? 0)}添加${KEY_PATH_LABELS[op.path] || op.path}关键帧`;
    case 'removeKeyframe': return `${op.target === 'overlay' ? '画中画' : op.target === 'audio' ? '音频' : clipNo(project, op.id)}：删除 ${sec(op.t ?? 0)}的${KEY_PATH_LABELS[op.path] || ''}关键帧`;
    case 'roll': return `滚动剪辑点 ${signed(op.delta)} 秒`;
    case 'slip': return `${clipNo(project, op.id)}：内滑 ${signed(op.delta)} 秒`;
    case 'slide': return `${clipNo(project, op.id)}：外滑 ${signed(op.delta)} 秒`;
    case 'rippleDelete': return `波纹删除 ${(op.ids || [op.id]).filter(Boolean).length} 项`;
    case 'trimLeft': return '删除播放头左侧（Q）';
    case 'trimRight': return '删除播放头右侧（W）';
    case 'addOverlay': return `添加画中画「${assetNameOf(op, project)}」到第 ${op.track || 1} 轨`;
    case 'updateOverlay': return `修改画中画：${describeClipProps(op.patch)}`;
    case 'removeOverlay': return '删除画中画';
    case 'setTrack': {
      let name = '轨道';
      try { name = trackName(parseTrack(op.track)); } catch { /* 描述不抛错 */ }
      const p = isRecord(op.patch) ? op.patch : {};
      return `${name}：${Object.entries(p).filter(([k]) => FLAG_LABELS[k]).map(([k, v]) => FLAG_LABELS[k][v ? 0 : 1]).join('、') || '修改状态'}`;
    }
    case 'addMarker': return `添加标记${op.label ? `「${op.label}」` : ''}（${sec(op.t ?? 0)}）`;
    case 'updateMarker': return '修改标记';
    case 'removeMarker': return '删除标记';
    case 'addCaptions': return `添加 ${Array.isArray(op.segments) ? op.segments.length : 0} 条字幕`;
    case 'updateCaptionStyle': return '修改全部字幕样式';
    case 'clearCaptions': return '清空字幕';
    case 'autoDuck': return `自动闪避背景音乐（人声时降到 ${Math.round((op.amount ?? 0.25) * 100)}%）`;
    case 'detachAudio': return `${clipsNo(project, op)}：分离音频`;
    case 'snapCutsToBeats': return '剪辑点对齐音乐节拍';
    case 'setTransitionAll': { const t = transitionAllSpec(op).type; return `全部转场改为${TRANSITION_LABELS[t] || t || '？'}${t && t !== 'cut' && given(transitionAllSpec(op).duration) ? ` ${sec(transitionAllSpec(op).duration)}` : ''}`; }
    case 'pasteAttributes': return `粘贴${(Array.isArray(op.keys) && op.keys.length ? op.keys : ['color', 'fx', 'transform', 'motion']).map((k) => PASTE_LABELS[k] || k).join('、')}到 ${(op.toIds || []).length} 个镜头`;
    default: return op.type;
  }
}
// ---------- 描述 ----------

function fmt(v) {
  return String(round(Number(v), 2));
}
function signed(v) {
  const n = round(Number(v), 2);
  return n > 0 ? `+${n}` : String(n);
}

/** 连续编号压缩：[1,2,3,5] → 第1–3、5镜 */
function indexLabel(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length; i += 1) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
    parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
    i = j;
  }
  return `第${parts.join('、')}镜`;
}

function targetLabel(op, project) {
  const target = normalizeTarget(op.target);
  if (!target) return DEFAULT_ALL.has(op.type) ? '全部镜头' : '所选镜头';
  switch (target.mode) {
    case 'all': return '全部镜头';
    case 'range': return '框选范围内的镜头';
    case 'selected': return '所选镜头';
    case 'none': return DEFAULT_ALL.has(op.type) ? '全部镜头' : '';
    case 'index':
      return Array.isArray(target.indices) && target.indices.length ? indexLabel(target.indices) : '所选镜头';
    case 'ids': {
      const clips = (project && project.tracks && project.tracks.video) || [];
      const numbers = (target.ids || []).map((id) => clips.findIndex((c) => c.id === id) + 1).filter((n) => n > 0);
      return numbers.length ? indexLabel(numbers) : `${(target.ids || []).length} 个镜头`;
    }
    default: return '所选镜头';
  }
}

function describeColor(op) {
  const parts = [];
  for (const [key, v] of Object.entries(compact(op.color))) {
    if (key === 'look') parts.push(`调色风格 ${LOOK_LABELS[v] || v}`);
    else {
      const label = key === 'lookStrength' ? '风格强度' : COLOR_LABELS[key] || key;
      parts.push(op.relative ? `${label} ${signed(v)}` : `${label}设为 ${fmt(v)}`);
    }
  }
  return parts.join('、') || '调色';
}

function describeFx(op) {
  const parts = [];
  for (const [key, v] of Object.entries(compact(op.fx))) {
    const label = FX_LABELS[key] || key;
    if (op.relative) parts.push(`${label} ${signed(v)}`);
    else parts.push(v === 0 ? `去掉${label}` : `${label}设为 ${fmt(v)}`);
  }
  return parts.join('、') || '特效';
}

function describeTransform(op) {
  const t = compact(op.transform);
  const parts = [];
  if (given(t.scale)) parts.push(`缩放 ${fmt(t.scale)} 倍`);
  if (given(t.x) || given(t.y)) parts.push(`位置 (${fmt(t.x ?? 0)}, ${fmt(t.y ?? 0)})`);
  if (given(t.rotation)) parts.push(`旋转 ${fmt(t.rotation)}°`);
  if (given(t.flipH)) parts.push(t.flipH ? '水平翻转' : '取消翻转');
  return parts.join('、') || '画面变换';
}

function describeCaption(op) {
  const c = compact(op.caption);
  const parts = [];
  if (given(c.text)) parts.push(c.text ? `字幕改为「${c.text}」` : '去掉字幕');
  if (given(c.style)) parts.push(`字幕样式 ${CAPTION_STYLE_LABELS[c.style] || c.style}`);
  if (given(c.position)) parts.push(`字幕放到${CAPTION_POSITION_LABELS[c.position] || c.position}`);
  return parts.join('、') || '字幕';
}

function describeVolume(op) {
  const parts = [];
  if (given(op.volume)) parts.push(op.relative ? `音量 ${signed(op.volume)}` : `音量设为 ${Math.round(op.volume * 100)}%`);
  if (given(op.mute)) parts.push(op.mute ? '静音' : '取消静音');
  if (given(op.audioFadeIn)) parts.push(`声音淡入 ${fmt(op.audioFadeIn)} 秒`);
  if (given(op.audioFadeOut)) parts.push(`声音淡出 ${fmt(op.audioFadeOut)} 秒`);
  return parts.join('、') || '音频';
}

function describeTrim(op) {
  const parts = [];
  if (given(op.in)) parts.push(op.relative ? `入点 ${signed(op.in)} 秒` : `入点 ${fmt(op.in)} 秒`);
  if (given(op.out)) parts.push(op.relative ? `出点 ${signed(op.out)} 秒` : `出点 ${fmt(op.out)} 秒`);
  return `裁剪：${parts.join('、') || '未指定'}`;
}

function assetNameOf(op, project) {
  const asset = project && project.assets && project.assets[op.assetId];
  return asset ? asset.name : op.assetId || '素材';
}

function describeClipBody(op, project) {
  switch (op.type) {
    case 'setColor': return describeColor(op);
    case 'setLook': {
      const parts = [];
      if (given(op.look)) parts.push(`调色风格 ${LOOK_LABELS[op.look] || op.look}`);
      if (given(op.lookStrength)) parts.push(`强度 ${fmt(op.lookStrength)}`);
      return parts.join('，') || '调色风格';
    }
    case 'setMotion': {
      const parts = [];
      if (given(op.preset)) parts.push(`运镜 ${MOTION_LABELS[op.preset] || op.preset}`);
      if (given(op.intensity)) parts.push(`强度 ${fmt(op.intensity)}`);
      return parts.join('，') || '运镜';
    }
    case 'setTransform': return describeTransform(op);
    case 'setFx': return describeFx(op);
    case 'setTransition': {
      const tr = compact(op.transition);
      const name = given(tr.type) ? TRANSITION_LABELS[tr.type] || tr.type : '转场';
      return `入场转场 ${name}${given(tr.duration) && tr.type !== 'cut' ? ` ${fmt(tr.duration)} 秒` : ''}`;
    }
    case 'setCaption': return describeCaption(op);
    case 'setSpeed': return `播放速度 ${fmt(op.speed)} 倍`;
    case 'setVolume': return describeVolume(op);
    case 'trim': return describeTrim(op);
    case 'setDuration': return `时长改为 ${fmt(op.duration)} 秒`;
    case 'split': return `在 ${fmt(op.at ?? 0)} 秒处分割`;
    case 'delete': return '删除';
    case 'duplicate': return '复制一份';
    case 'move': return `移到第 ${op.toIndex} 位`;
    case 'replaceAsset': return `替换素材为「${assetNameOf(op, project)}」`;
    case 'lock': return '锁定';
    case 'unlock': return '解锁';
    case 'matchColor': return `匹配参考色彩（强度 ${fmt(op.strength ?? 1)}）`;
    case 'harmonize': return `向全片基准色靠拢（强度 ${fmt(op.strength ?? 0.6)}）`;
    case 'applyPacing':
      if (Array.isArray(op.durations)) return `按时长表调整节奏（${op.durations.map(fmt).join('、')} 秒）`;
      return `节奏调整为${PACING_LABELS[op.pacing] || op.pacing || ''}`;
    default: return op.type;
  }
}

function textValue(op) {
  return typeof op.text === 'string' ? op.text : isRecord(op.text) ? op.text.text : '';
}

function describeGlobal(op, project) {
  switch (op.type) {
    case 'insertAsset': {
      const pos = given(op.atIndex) ? `第 ${op.atIndex} 位` : '末尾';
      return `在${pos}插入素材「${assetNameOf(op, project)}」`;
    }
    case 'addText': return textValue(op) ? `添加文字「${textValue(op)}」` : '添加文字';
    case 'updateText': return textValue(op) ? `文字改为「${textValue(op)}」` : '修改文字样式';
    case 'removeText': return '删除文字';
    case 'addAudio': {
      const asset = project && project.assets && isRecord(op.audio) ? project.assets[op.audio.assetId] : null;
      return `添加音频${asset ? `「${asset.name}」` : ''}`;
    }
    case 'updateAudio': return '修改音频片段';
    case 'removeAudio': return '删除音频片段';
    case 'setProject': {
      const s = compact(op.settings);
      const parts = [];
      if (given(s.aspect)) parts.push(`画幅改为${ASPECTS[s.aspect] ? ASPECTS[s.aspect].label : s.aspect}`);
      if (given(s.fps)) parts.push(`帧率 ${fmt(s.fps)}`);
      if (given(s.background)) parts.push(`背景色 ${s.background}`);
      if (given(s.linked)) parts.push(s.linked ? '开启联动' : '关闭联动');
      return parts.join('、') || '修改项目设置';
    }
    default: return op.type;
  }
}

/** 中文一句话描述，如「第2镜：色温 +0.3」。传入 project 时可解析 ids 与素材名。 */
export function describeOp(op, project) {
  if (!isRecord(op)) return '无效操作';
  if (GLOBAL_SET.has(op.type)) return describeGlobal(op, project);
  if (EXT_SET.has(op.type)) return describeExt(op, project);
  if (!clipHandlers[op.type] && op.type !== 'split') return `未知操作（${op.type}）`;
  const body = describeClipBody(op, project);
  const label = targetLabel(op, project);
  return label ? `${label}：${body}` : body;
}

// ---------- 主入口 ----------

// 轨道锁（契约 C15）：轨道头上了锁，这条轨道上的内容任何操作都不能改。
// 各操作会改哪条轨道在这里集中登记，新增操作时记得补上。setTrack（解锁本身）、setProject、标记不受限制。
const VIDEO_TRACK_OPS = new Set([
  ...CLIP_OPS, 'insertAsset',
  'setClipProps', 'freezeFrame', 'setSpeedCurve', 'roll', 'slip', 'slide', 'trimLeft', 'trimRight',
  'detachAudio', 'snapCutsToBeats', 'setTransitionAll', 'pasteAttributes',
]);
const TEXT_TRACK_OPS = new Set(['addText', 'updateText', 'removeText', 'addCaptions', 'updateCaptionStyle', 'clearCaptions']);
const AUDIO_TRACK_OPS = new Set(['addAudio', 'updateAudio', 'removeAudio', 'autoDuck', 'detachAudio']);

function checkTrackLocks(draft, op) {
  const type = op.type;
  const guard = (kind, n) => { if (trackFlags(draft, kind, n).locked) fail(trackLockMessage(kind, n)); };
  if (VIDEO_TRACK_OPS.has(type)) guard('video');
  if (TEXT_TRACK_OPS.has(type)) guard('text');
  if (AUDIO_TRACK_OPS.has(type)) guard('audio');
  if (type === 'setKeyframe' || type === 'removeKeyframe') {
    const target = op.target || 'clip';
    if (target === 'clip') guard('video');
    else if (target === 'audio') guard('audio');
    else if (target === 'overlay') {
      const o = (draft.overlays || []).find((x) => x && x.id === op.id);
      if (o) guard('overlay', o.track || 1);
    }
  }
  if (type === 'removeOverlay' || type === 'updateOverlay') {
    const o = (draft.overlays || []).find((x) => x && x.id === op.id);
    if (o) guard('overlay', o.track || 1);
    // 不能把画中画挪进一条锁着的轨道
    const to = type === 'updateOverlay' && isRecord(op.patch) ? Number(op.patch.track) : NaN;
    if (o && Number.isInteger(to) && to >= 1 && to !== (o.track || 1)) guard('overlay', to);
  }
}

function applyOne(draft, op, run) {
  if (!isRecord(op)) fail('操作格式不正确');
  const type = op.type;
  if (typeof type !== 'string' || !OP_TYPES.includes(type)) fail(`不支持的操作类型「${type}」`);
  checkTrackLocks(draft, op);

  if (EXT_SET.has(type)) {
    const r = extHandlers[type](draft, op, run);
    return { project: r.project, text: describeOp(type === 'freezeFrame' || type === 'trimLeft' || type === 'trimRight' || type === 'addMarker' ? { ...op, at: op.at ?? run.ctx.playhead, t: op.t ?? run.ctx.playhead } : op, draft), note: r.note };
  }
  if (GLOBAL_SET.has(type)) {
    const r = globalHandlers[type](draft, op, run);
    return { project: r.project, text: describeOp(op, draft), note: r.note };
  }
  if (type === 'split') {
    const r = applySplit(draft, op, run);
    const at = given(op.at) ? op.at : run.ctx.playhead;
    const text = describeOp({ ...op, at, target: { mode: 'index', indices: [r.index + 1], ids: [] } }, draft);
    return { project: r.project, text };
  }

  const indices = targetsForOp(draft, op, run);
  if (type !== 'unlock') checkLocked(draft, indices);
  const r = clipHandlers[type](draft, op, indices, run);
  const text = describeOp({ ...op, target: { mode: 'index', indices: indices.map((i) => i + 1), ids: [] } }, draft);
  return { project: r.project, text, note: r.note };
}

function checkLimits(before, after) {
  const errors = [];
  const count = after.tracks.video.length;
  if (count > LIMITS.maxClips && count > before.tracks.video.length) {
    errors.push(`主轨最多 ${LIMITS.maxClips} 个镜头（这次操作后会有 ${count} 个）`);
  }
  const total = projectDuration(after);
  if (total > LIMITS.maxDuration + EPS && total > projectDuration(before) + EPS) {
    errors.push(`项目总时长不能超过 ${LIMITS.maxDuration} 秒（这次操作后会有 ${round(total, 1)} 秒）`);
  }
  return errors;
}

/** 删除/移动后不是合法第一镜转场的镜头跑到了最前：改回硬切，保持第一镜规则始终成立 */
function sanitizeFirstClip(project) {
  const first = project.tracks.video[0];
  if (!first || !first.transitionIn || FIRST_CLIP_TRANSITIONS.has(first.transitionIn.type)) return { project, note: null };
  const name = TRANSITION_LABELS[first.transitionIn.type] || first.transitionIn.type;
  const video = [...project.tracks.video];
  video[0] = { ...first, transitionIn: { ...first.transitionIn, type: 'cut' } };
  return { project: withVideo(project, video), note: `新的第一镜不能用「${name}」入场，已改为硬切` };
}

function withTracks(project) {
  const tracks = project.tracks || {};
  if (Array.isArray(tracks.video) && Array.isArray(tracks.text) && Array.isArray(tracks.audio) && project.assets) return project;
  return {
    ...project,
    assets: project.assets || {},
    tracks: { ...tracks, video: tracks.video || [], text: tracks.text || [], audio: tracks.audio || [] },
  };
}

/**
 * 原子地应用一批操作。
 * @returns {{ok:boolean, project:object, applied:string[], errors:string[]}} 失败时 project 是传入的原对象。
 */
export function applyOps(project, ops, ctx) {
  const refuse = (errors) => ({ ok: false, project, applied: [], errors });
  if (!isRecord(project)) return refuse(['没有打开的项目']);
  if (!Array.isArray(ops)) return refuse(['操作列表格式不正确']);
  if (!ops.length) return { ok: true, project, applied: [], errors: [] };

  const base = withTracks(project);
  const c = normalizeCtx(ctx);
  const stableRangeIds = c.range
    ? itemsInRange(layoutVideo(base), c.range.start, c.range.end).map((it) => it.clip.id)
    : [];
  const run = { ctx: c, stableRangeIds };

  let draft = base;
  const applied = [];
  const errors = [];
  for (const op of ops) {
    try {
      const r = applyOne(draft, op, run);
      draft = isLinked(r.project) ? syncLinked(draft, r.project) : r.project;
      applied.push(r.note ? `${r.text}（${r.note}）` : r.text);
    } catch (e) {
      // 继续校验其余操作，一次把问题都告诉用户；结果不会被应用
      errors.push(e instanceof OpError ? e.message : `操作执行失败：${e && e.message ? e.message : e}`);
    }
  }
  if (errors.length) return refuse(errors);

  const limitErrors = checkLimits(base, draft);
  if (limitErrors.length) return refuse(limitErrors);

  const sanitized = sanitizeFirstClip(draft);
  if (sanitized.note) applied.push(sanitized.note);
  return { ok: true, project: sanitized.project, applied, errors: [] };
}
