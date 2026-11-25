// 关键帧。纯函数、不可变，node 可测。
//
// keys 结构：{ [path]: [{ t, v, ease }] }，t 为片段本地秒（升序），ease 描述「从这一帧到下一帧」的插值方式：
//   linear | ease（缓入缓出）| easeIn | easeOut | hold（保持到下一帧再跳变）
// 可动画 path：transform.x|y|scale|rotate、opacity、volume、color.<key>

export const EASES = ['linear', 'ease', 'easeIn', 'easeOut', 'hold'];
export const EASE_LABELS = { linear: '线性', ease: '缓入缓出', easeIn: '缓入', easeOut: '缓出', hold: '定格' };
export const KEY_PATHS = [
  'transform.x', 'transform.y', 'transform.scale', 'transform.rotate', 'opacity', 'volume',
  'color.exposure', 'color.contrast', 'color.saturation', 'color.temperature', 'color.tint', 'color.highlights', 'color.shadows', 'color.vignette',
];
export const KEY_PATH_LABELS = {
  'transform.x': '水平位置', 'transform.y': '垂直位置', 'transform.scale': '缩放', 'transform.rotate': '旋转', opacity: '不透明度', volume: '音量',
  'color.exposure': '曝光', 'color.contrast': '对比度', 'color.saturation': '饱和度', 'color.temperature': '色温', 'color.tint': '色调',
  'color.highlights': '高光', 'color.shadows': '阴影', 'color.vignette': '暗角',
};

/** 同一时刻判定容差（约半帧 @60fps） */
export const KEY_EPS = 1 / 120;

function finite(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }

export function isKeyPath(path) {
  return typeof path === 'string' && (KEY_PATHS.includes(path) || /^color\.[a-zA-Z]+$/.test(path));
}

export function easeFn(ease, p) {
  const x = Math.min(1, Math.max(0, p));
  switch (ease) {
    case 'hold': return 0;
    case 'ease': return x * x * (3 - 2 * x);
    case 'easeIn': return x * x * x;
    case 'easeOut': return 1 - (1 - x) ** 3;
    default: return x;
  }
}

function listOf(keys, path) {
  const l = keys && typeof keys === 'object' ? keys[path] : null;
  return Array.isArray(l) ? l : [];
}

/** path 在本地时刻 t 的值；没有关键帧返回 base。首帧之前取首帧值，末帧之后取末帧值。 */
export function valueAt(keys, path, t, base) {
  const list = listOf(keys, path);
  if (!list.length) return base;
  const time = finite(t);
  if (time <= list[0].t) return finite(list[0].v, base);
  const last = list[list.length - 1];
  if (time >= last.t) return finite(last.v, base);
  let i = 0;
  while (i < list.length - 1 && list[i + 1].t <= time) i += 1;
  const a = list[i];
  const b = list[i + 1];
  const span = b.t - a.t;
  if (span <= 0) return finite(b.v, base);
  const k = easeFn(a.ease, (time - a.t) / span);
  return finite(a.v) + (finite(b.v) - finite(a.v)) * k;
}

/** 在 t 处设置关键帧（同一时刻已有则替换值/缓动）。返回新的 keys 对象。 */
export function setKey(keys, path, t, v, ease) {
  const time = Math.max(0, Math.round(finite(t) * 1000) / 1000);
  const value = finite(v);
  const list = listOf(keys, path);
  const idx = list.findIndex((k) => Math.abs(k.t - time) <= KEY_EPS);
  let next;
  if (idx >= 0) {
    next = [...list];
    next[idx] = { t: list[idx].t, v: value, ease: EASES.includes(ease) ? ease : list[idx].ease || 'linear' };
  } else {
    next = [...list, { t: time, v: value, ease: EASES.includes(ease) ? ease : 'linear' }].sort((a, b) => a.t - b.t);
  }
  return { ...(keys || {}), [path]: next };
}

/** 删除 t 处的关键帧；该 path 删空时移除这个键。 */
export function removeKey(keys, path, t) {
  const list = listOf(keys, path);
  const time = finite(t);
  const next = list.filter((k) => Math.abs(k.t - time) > KEY_EPS);
  const out = { ...(keys || {}) };
  if (next.length) out[path] = next;
  else delete out[path];
  return out;
}

export function hasKeyAt(keys, path, t) {
  return listOf(keys, path).some((k) => Math.abs(k.t - finite(t)) <= KEY_EPS);
}

/** t 之前/之后最近的关键帧（不含 t 本身），用于「上一帧 / 下一帧」按钮。 */
export function neighborKeys(keys, path, t) {
  const time = finite(t);
  const paths = path ? [path] : Object.keys(keys || {});
  let prev = null;
  let next = null;
  for (const p of paths) {
    for (const k of listOf(keys, p)) {
      if (k.t < time - KEY_EPS && (!prev || k.t > prev.t)) prev = { ...k, path: p };
      if (k.t > time + KEY_EPS && (!next || k.t < next.t)) next = { ...k, path: p };
    }
  }
  return { prev, next };
}

/** 全部 path 的关键帧时刻，升序去重。 */
export function allKeyTimes(keys) {
  const times = [];
  for (const p of Object.keys(keys || {})) {
    for (const k of listOf(keys, p)) if (!times.some((x) => Math.abs(x - k.t) <= KEY_EPS)) times.push(k.t);
  }
  return times.sort((a, b) => a - b);
}

/** 关键帧整体平移（分割/修剪入点后保持画面不跳），丢弃落到 [0,maxT] 外的帧；给定有限时长或显式开启 bake 时在边界烘焙插值帧。 */
export function shiftKeys(keys, dt, maxT = Infinity, { bake = Number.isFinite(maxT) } = {}) {
  if (!keys || typeof keys !== 'object') return {};
  const shift = finite(dt);
  const lo = -shift;
  const hi = Number.isFinite(maxT) ? lo + maxT : Infinity;
  const out = {};
  for (const p of Object.keys(keys)) {
    const orig = listOf(keys, p);
    if (!orig.length) continue;
    const l = orig
      .map((k) => ({ ...k, t: Math.round((k.t + shift) * 1000) / 1000 }))
      .filter((k) => k.t >= -KEY_EPS && k.t <= maxT + KEY_EPS)
      .map((k) => ({ ...k, t: Math.min(maxT, Math.max(0, k.t)) }));
    if (bake) {
      if (orig.some((k) => k.t < lo - KEY_EPS) && !l.some((k) => k.t <= KEY_EPS)) {
        let prev = null;
        for (const k of orig) if (k.t < lo - KEY_EPS) prev = k;
        const ease = prev && EASES.includes(prev.ease) ? prev.ease : 'linear';
        l.unshift({ t: 0, v: valueAt(keys, p, lo), ease });
      }
      if (Number.isFinite(hi) && maxT > KEY_EPS && orig.some((k) => k.t > hi + KEY_EPS) && !l.some((k) => Math.abs(k.t - maxT) <= KEY_EPS)) {
        l.push({ t: Math.round(maxT * 1000) / 1000, v: valueAt(keys, p, hi), ease: 'linear' });
      }
    }
    if (l.length) out[p] = l;
  }
  return out;
}

function getPath(obj, path) {
  const [a, b] = path.split('.');
  if (b === undefined) return obj ? obj[a] : undefined;
  const key = a === 'transform' && b === 'rotate' ? 'rotation' : b;
  return obj && obj[a] ? obj[a][key] : undefined;
}

/**
 * 求片段（clip/overlay）在本地时刻 t 的动画后属性：{ transform, opacity, volume, color }。
 * transform.rotate 关键帧对应 transform.rotation 字段。
 */
export function animatedProps(item, t) {
  const keys = (item && item.keys) || {};
  const transform = { ...((item && item.transform) || {}) };
  for (const f of ['x', 'y', 'scale']) transform[f] = valueAt(keys, `transform.${f}`, t, finite(transform[f], f === 'scale' ? 1 : 0));
  transform.rotation = valueAt(keys, 'transform.rotate', t, finite(transform.rotation));
  const color = { ...((item && item.color) || {}) };
  for (const p of Object.keys(keys)) {
    if (p.startsWith('color.')) { const k = p.slice(6); color[k] = valueAt(keys, p, t, finite(color[k])); }
  }
  return {
    transform,
    color,
    opacity: valueAt(keys, 'opacity', t, finite(getPath(item, 'opacity'), 1)),
    volume: valueAt(keys, 'volume', t, finite(getPath(item, 'volume'), 1)),
  };
}

/**
 * 运镜预设 → 关键帧预设（可选映射，不改变 motion 字段本身的渲染）。
 * 返回 { 'transform.scale': [...], 'transform.x': [...], ... }，供「运镜转为关键帧」按钮使用。
 */
export function motionPresetKeys(preset, intensity = 0.5, duration = 4) {
  const d = Math.max(0.2, finite(duration, 4));
  const k = Math.min(1, Math.max(0, finite(intensity, 0.5)));
  const z = 0.08 + 0.22 * k; // 推拉幅度
  const m = 0.05 + 0.15 * k; // 平移幅度
  const two = (path, a, b, ease = 'ease') => ({ [path]: [{ t: 0, v: a, ease }, { t: d, v: b, ease: 'linear' }] });
  switch (preset) {
    case 'push-in': return two('transform.scale', 1, 1 + z);
    case 'pull-out': return two('transform.scale', 1 + z, 1);
    case 'pan-left': return { ...two('transform.scale', 1 + m * 2, 1 + m * 2, 'linear'), ...two('transform.x', m, -m) };
    case 'pan-right': return { ...two('transform.scale', 1 + m * 2, 1 + m * 2, 'linear'), ...two('transform.x', -m, m) };
    case 'tilt-up': return { ...two('transform.scale', 1 + m * 2, 1 + m * 2, 'linear'), ...two('transform.y', m, -m) };
    case 'tilt-down': return { ...two('transform.scale', 1 + m * 2, 1 + m * 2, 'linear'), ...two('transform.y', -m, m) };
    case 'zoom-punch': return { 'transform.scale': [{ t: 0, v: 1, ease: 'easeOut' }, { t: Math.min(0.25, d / 3), v: 1 + z * 1.4, ease: 'ease' }, { t: d, v: 1 + z, ease: 'linear' }] };
    case 'drift': return { ...two('transform.scale', 1.04, 1.04 + z / 2), ...two('transform.x', -m / 2, m / 2) };
    case 'shake': {
      const list = [];
      const n = Math.max(2, Math.round(d * 6));
      for (let i = 0; i <= n; i += 1) list.push({ t: Math.round((d * i / n) * 1000) / 1000, v: i % 2 ? m / 3 : -m / 3, ease: 'ease' });
      return { 'transform.scale': [{ t: 0, v: 1.06, ease: 'linear' }], 'transform.x': list };
    }
    default: return {};
  }
}
