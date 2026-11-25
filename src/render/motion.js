// 运镜：纯函数，无 DOM，node 可测。
// 约定：x / y 是画面内容相对画幅宽 / 高的位移比例（正值 = 内容向右 / 向下移动）；
// 例如「向左摇」是摄影机向左转，所以画面内容向右滑动，x 由负变正。
// 所有带位移的预设都会同时放大到刚好不露边：内容放大 s 倍后，可位移 ±(s-1)/2 而不露边。

const DEG = Math.PI / 180;

export function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** 平滑起止（smoothstep） */
export function easeInOut(t) {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/** 更利落的起止，用于转场 */
export function easeInOutCubic(t) {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - ((-2 * x + 2) ** 3) / 2;
}

export function easeOutCubic(t) {
  const x = clamp01(t);
  return 1 - (1 - x) ** 3;
}

export function easeInCubic(t) {
  const x = clamp01(t);
  return x * x * x;
}

/** 非运镜类型（分镜里才有的 movement）折算到 motion 预设，保证任何输入都有合理表现 */
const ALIASES = { static: 'none', handheld: 'shake', orbit: 'drift', tracking: 'pan-right' };

/** 确定性多频晃动：三个不成整数比的正弦叠加，避免看出周期 */
function wobble(seconds, f1, f2, f3, phase) {
  const tau = Math.PI * 2;
  return (Math.sin(tau * f1 * seconds + phase)
    + 0.6 * Math.sin(tau * f2 * seconds + phase * 1.7 + 1.3)
    + 0.3 * Math.sin(tau * f3 * seconds + phase * 2.3 + 0.7)) / 1.9;
}

/**
 * @param {string} preset    MOTIONS 之一（也接受 static/handheld/orbit/tracking）
 * @param {number} intensity 0..1
 * @param {number} progress  0..1 镜头内进度
 * @param {number} [duration=4] 镜头时长（秒）。只影响 shake 的真实频率，让长短镜头的抖动速度一致
 * @returns {{scale:number,x:number,y:number,rotation:number}} rotation 单位：度
 */
export function motionTransform(preset, intensity = 0.5, progress = 0, duration = 4) {
  const name = ALIASES[preset] || preset;
  const i = clamp01(intensity);
  const p = clamp01(progress);
  const e = easeInOut(p);
  switch (name) {
    case 'push-in':
      return { scale: 1 + 0.18 * i * e, x: 0, y: 0, rotation: 0 };
    case 'pull-out':
      return { scale: 1 + 0.18 * i * (1 - e), x: 0, y: 0, rotation: 0 };
    case 'pan-left':
    case 'pan-right': {
      const a = 0.12 * i;
      const dir = name === 'pan-left' ? 1 : -1;
      return { scale: 1 + 2 * a + 0.002, x: dir * a * (2 * e - 1), y: 0, rotation: 0 };
    }
    case 'tilt-up':
    case 'tilt-down': {
      const a = 0.12 * i;
      const dir = name === 'tilt-up' ? 1 : -1;
      return { scale: 1 + 2 * a + 0.002, x: 0, y: dir * a * (2 * e - 1), rotation: 0 };
    }
    case 'shake': {
      const seconds = p * (Number(duration) > 0 ? Number(duration) : 4);
      const amp = 0.018 * i;
      const rot = 0.9 * i;
      return {
        // 旋转也会露角：按最宽常用画幅（21:9）留出余量
        scale: 1 + 2 * amp + Math.abs(Math.sin(rot * DEG)) * 2.4,
        x: amp * wobble(seconds, 1.7, 3.1, 7.3, 0.4),
        y: amp * wobble(seconds, 2.3, 4.1, 6.7, 2.1),
        rotation: rot * wobble(seconds, 1.1, 2.9, 5.3, 1.2),
      };
    }
    case 'zoom-punch': {
      const peak = 0.34 * i;
      const rest = 0.06 * i;
      if (p < 0.15) return { scale: 1 + peak * easeOutCubic(p / 0.15), x: 0, y: 0, rotation: 0 };
      const q = (p - 0.15) / 0.85;
      // 阻尼回弹：冲到峰值后略微跌破静止值再稳住
      const spring = Math.exp(-5 * q) * Math.cos(9 * q);
      return { scale: 1 + rest + (peak - rest) * spring, x: 0, y: 0, rotation: 0 };
    }
    case 'drift': {
      const a = 0.05 * i;
      const k = 2 * p - 1;
      return { scale: 1 + 2 * a + 0.01 + 0.02 * i * p, x: a * k, y: -a * 0.6 * k, rotation: 0 };
    }
    default:
      return { scale: 1, x: 0, y: 0, rotation: 0 };
  }
}

/** 把镜头的静态 transform 与运镜结果叠加 */
export function composeTransform(transform, motion) {
  const t = transform || {};
  const m = motion || {};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    scale: num(t.scale, 1) * num(m.scale, 1),
    x: num(t.x, 0) + num(m.x, 0),
    y: num(t.y, 0) + num(m.y, 0),
    rotation: num(t.rotation, 0) + num(m.rotation, 0),
    flipH: !!t.flipH,
  };
}

/** 等比裁切铺满（cover）：返回源画面铺满目标时的绘制宽高。无效尺寸时退回目标尺寸 */
export function coverSize(srcW, srcH, dstW, dstH) {
  if (!(srcW > 0) || !(srcH > 0)) return { width: dstW, height: dstH };
  const s = Math.max(dstW / srcW, dstH / srcH);
  return { width: srcW * s, height: srcH * s };
}

// ---------------- 关键帧（与 engine/keyframes.js 的 valueAt 同语义；本地实现保证渲染不依赖其加载顺序） ----------------

function easeKey(kind, p) {
  switch (kind) {
    case 'hold': return 0;
    case 'easeIn': return p * p * p;
    case 'easeOut': return 1 - (1 - p) ** 3;
    case 'ease': return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
    default: return p;
  }
}

/** keys[path] 在片段本地时刻 t 的值；无关键帧时返回 base */
export function keyValueAt(keys, path, t, base) {
  const list = keys && Array.isArray(keys[path]) ? keys[path].filter((k) => k && Number.isFinite(Number(k.t))) : null;
  if (!list || !list.length) return base;
  const arr = list.slice().sort((a, b) => a.t - b.t);
  const time = Number(t) || 0;
  if (time <= arr[0].t) return Number(arr[0].v);
  const last = arr[arr.length - 1];
  if (time >= last.t) return Number(last.v);
  for (let i = 0; i < arr.length - 1; i += 1) {
    const a = arr[i];
    const b = arr[i + 1];
    if (time >= a.t && time <= b.t) {
      const span = b.t - a.t;
      const p = span > 0 ? (time - a.t) / span : 1;
      const e = easeKey(a.ease || 'linear', p);
      return Number(a.v) + (Number(b.v) - Number(a.v)) * e;
    }
  }
  return base;
}

/** 把片段的关键帧应用到 transform/opacity/color，返回新的属性快照（不修改原片段） */
export function animatedProps(item, localT) {
  const it = item || {};
  const keys = it.keys || null;
  const tf0 = it.transform || {};
  const rot0 = Number.isFinite(Number(tf0.rotation)) ? Number(tf0.rotation) : Number(tf0.rotate) || 0;
  const transform = { ...tf0 };
  if (keys) {
    transform.x = keyValueAt(keys, 'transform.x', localT, Number(tf0.x) || 0);
    transform.y = keyValueAt(keys, 'transform.y', localT, Number(tf0.y) || 0);
    transform.scale = keyValueAt(keys, 'transform.scale', localT, Number.isFinite(Number(tf0.scale)) ? Number(tf0.scale) : 1);
    transform.rotation = keyValueAt(keys, 'transform.rotate', localT, keyValueAt(keys, 'transform.rotation', localT, rot0));
  } else {
    transform.rotation = rot0;
  }
  const op0 = Number.isFinite(Number(it.opacity)) ? Number(it.opacity) : 1;
  const opacity = clamp01(keys ? keyValueAt(keys, 'opacity', localT, op0) : op0);
  let color = it.color;
  if (keys && color) {
    color = { ...color };
    for (const k of Object.keys(keys)) {
      if (k.startsWith('color.')) {
        const name = k.slice(6);
        color[name] = keyValueAt(keys, k, localT, Number(color[name]) || 0);
      }
    }
  } else if (keys) {
    const ck = Object.keys(keys).filter((k) => k.startsWith('color.'));
    if (ck.length) {
      color = {};
      for (const k of ck) color[k.slice(6)] = keyValueAt(keys, k, localT, 0);
    }
  }
  return { transform, opacity, color };
}

/** 按 fit 计算源画面绘制尺寸：cover 铺满裁切、contain 完整显示、fill 拉伸 */
export function fitSize(srcW, srcH, dstW, dstH, fit = 'cover') {
  if (!(srcW > 0) || !(srcH > 0) || fit === 'fill') return { width: dstW, height: dstH };
  const s = fit === 'contain' ? Math.min(dstW / srcW, dstH / srcH) : Math.max(dstW / srcW, dstH / srcH);
  return { width: srcW * s, height: srcH * s };
}
