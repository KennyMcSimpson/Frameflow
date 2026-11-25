// 转场状态：纯函数，无 DOM，node 可测。compositor 按这里返回的状态绘制两个镜头。
//
// transitionState(type, p) → {
//   outgoing: Layer, incoming: Layer, overlay: {color, alpha}|null, mix: 'over'|'add',
// }
// Layer = {
//   alpha, x, y /*画幅比例位移*/, scale, blur /*0..1*/, rotation /*度*/,
//   clip: { edge, keep:'before'|'after', feather } | null  /*沿 x 轴的软边擦除，edge/feather 为画幅宽度比例*/,
//   streakX, streakY /*运动模糊长度，画幅比例*/, radial /*径向缩放模糊 0..1*/, tile /*缩小/旋转露边时用镜像平铺补边*/,
// }
// mix='add'：两层按 alpha 线性相加（真正的叠化，中点亮度不塌陷）；mix='over'：入画层盖在出画层上。

import { clamp01, easeInOutCubic, easeInCubic, easeOutCubic, easeInOut } from './motion.js';

function layer(partial) {
  return { alpha: 1, x: 0, y: 0, scale: 1, blur: 0, rotation: 0, clip: null, streakX: 0, streakY: 0, radial: 0, tile: false, ...partial };
}

const hidden = (partial) => layer({ alpha: 0, ...partial });

/** 在 [a,b] 区间内从 0 平滑过渡到 1 */
function ramp(p, a, b) {
  return easeInOut((p - a) / (b - a));
}

/** 中点最大、两端为 0 的钟形曲线 */
function bell(p) {
  return Math.sin(Math.PI * clamp01(p));
}

/** 速度曲线：easeInOutCubic 的归一化导数，用来驱动运动模糊 */
function speed(p) {
  const x = clamp01(p);
  return x < 0.5 ? 4 * x * x : 4 * (1 - x) * (1 - x);
}

function slide(p, dx, dy) {
  const e = easeInOutCubic(p);
  const v = speed(p) * 0.06;
  return {
    outgoing: layer({ x: -dx * e, y: -dy * e, streakX: Math.abs(dx) * v, streakY: Math.abs(dy) * v }),
    incoming: layer({ x: dx * (1 - e), y: dy * (1 - e), streakX: Math.abs(dx) * v, streakY: Math.abs(dy) * v }),
    overlay: null,
    mix: 'over',
  };
}

function dip(p, color) {
  // 前半段压到纯色，后半段从纯色出来；纯色最浓时切换镜头
  const a = 1 - Math.abs(2 * clamp01(p) - 1);
  const alpha = easeInOut(a);
  const first = p < 0.5;
  return {
    outgoing: first ? layer({}) : hidden({}),
    incoming: first ? hidden({}) : layer({}),
    overlay: alpha > 0 ? { color, alpha } : null,
    mix: 'over',
  };
}

function wipe(p, dir) {
  const feather = 0.07;
  const e = easeInOut(p);
  // 边缘从画外走到另一侧画外，保证 p=0 完全看不到、p=1 完全覆盖
  const edge = dir === 'left'
    ? 1 + feather - e * (1 + 2 * feather)
    : -feather + e * (1 + 2 * feather);
  return {
    outgoing: layer({}),
    incoming: layer({ clip: { edge, keep: dir === 'left' ? 'after' : 'before', feather } }),
    overlay: null,
    mix: 'over',
  };
}

const BUILDERS = {
  cut(p) {
    const first = p < 0.5;
    return { outgoing: first ? layer({}) : hidden({}), incoming: first ? hidden({}) : layer({}), overlay: null, mix: 'over' };
  },
  crossfade(p) {
    const c = clamp01(p);
    return { outgoing: layer({ alpha: 1 - c }), incoming: layer({ alpha: c }), overlay: null, mix: 'add' };
  },
  'dip-black': (p) => dip(p, '#000000'),
  'dip-white': (p) => dip(p, '#ffffff'),
  'slide-left': (p) => slide(p, 1, 0),
  'slide-right': (p) => slide(p, -1, 0),
  'slide-up': (p) => slide(p, 0, 1),
  'slide-down': (p) => slide(p, 0, -1),
  'zoom-in'(p) {
    // 向画面深处穿越：旧镜头加速冲向镜头，新镜头从远处减速到位，镜像补边不露黑
    const c = ramp(p, 0.42, 0.58); // 切换藏在径向模糊峰值里，避免长时间双重曝光
    return {
      outgoing: layer({ alpha: 1 - c, scale: 1 + 1.6 * easeInCubic(p), radial: 0.9 * bell(p) * ramp(p, 0, 0.5), tile: true }),
      incoming: layer({ alpha: c, scale: 0.55 + 0.45 * easeOutCubic(p), radial: 0.9 * bell(p) * (1 - ramp(p, 0.5, 1)), tile: true }),
      overlay: null,
      mix: 'add',
    };
  },
  'zoom-out'(p) {
    const c = ramp(p, 0.42, 0.58); // 切换藏在径向模糊峰值里，避免长时间双重曝光
    return {
      outgoing: layer({ alpha: 1 - c, scale: 1 - 0.45 * easeInCubic(p), radial: 0.9 * bell(p) * ramp(p, 0, 0.5), tile: true }),
      incoming: layer({ alpha: c, scale: 1 + 1.4 * (1 - easeOutCubic(p)), radial: 0.9 * bell(p) * (1 - ramp(p, 0.5, 1)), tile: true }),
      overlay: null,
      mix: 'add',
    };
  },
  'wipe-left': (p) => wipe(p, 'left'),
  'wipe-right': (p) => wipe(p, 'right'),
  blur(p) {
    const c = ramp(p, 0.3, 0.7);
    return {
      outgoing: layer({ alpha: 1 - c, blur: easeInOut(clamp01(p) / 0.7) }),
      incoming: layer({ alpha: c, blur: 1 - easeInOut((clamp01(p) - 0.3) / 0.7) }),
      overlay: null,
      mix: 'add',
    };
  },
  'whip-pan'(p) {
    // 速度集中在中段：两端几乎静止，中段被运动模糊抹成一片，接缝藏在模糊里
    const x = clamp01(p);
    const e = x < 0.5 ? 16 * x ** 5 : 1 - ((-2 * x + 2) ** 5) / 2;
    const streak = 0.34 * bell(x) ** 2;
    return {
      outgoing: layer({ x: -e, streakX: streak, scale: 1 + 0.05 * bell(x) }),
      incoming: layer({ x: 1 - e, streakX: streak, scale: 1 + 0.05 * bell(x) }),
      overlay: null,
      mix: 'over',
    };
  },
  flash(p) {
    const c = ramp(p, 0.42, 0.58);
    const alpha = bell(p) ** 1.6;
    return {
      outgoing: layer({ alpha: 1 - c }),
      incoming: layer({ alpha: c }),
      overlay: alpha > 0.0005 ? { color: '#ffffff', alpha } : null,
      mix: 'add',
    };
  },
  spin(p) {
    const e = easeInOutCubic(p);
    const c = ramp(p, 0.42, 0.58);
    const blur = 0.55 * bell(p) ** 2;
    return {
      outgoing: layer({ alpha: 1 - c, rotation: 150 * e, scale: 1 + 0.8 * e, blur, tile: true }),
      incoming: layer({ alpha: c, rotation: -150 * (1 - e), scale: 1 + 0.8 * (1 - e), blur, tile: true }),
      overlay: null,
      mix: 'add',
    };
  },
};

/**
 * @param {string} type TRANSITIONS 之一；未知类型按硬切处理
 * @param {number} p 0..1 转场进度
 */
export function transitionState(type, p) {
  const build = BUILDERS[type] || BUILDERS.cut;
  return build(clamp01(p));
}

/**
 * 第一个镜头的入场（没有上一个镜头）：从黑 / 白淡入。
 * @returns {{color:string, alpha:number}|null} 盖在镜头上的纯色层
 */
export function introOverlay(type, p) {
  if (type !== 'dip-black' && type !== 'dip-white' && type !== 'crossfade') return null;
  const alpha = 1 - easeInOut(p);
  if (alpha <= 0) return null;
  return { color: type === 'dip-white' ? '#ffffff' : '#000000', alpha };
}
