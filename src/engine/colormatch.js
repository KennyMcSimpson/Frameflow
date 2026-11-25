// 色彩匹配：把「素材统计 → 目标统计」的差距换算成调色参数（CONTRACTS §B）。纯函数。
//
// 统计量与参数的近似关系（与 compositor 的 ctx.filter 语义一致）：
//   亮度  brightness(1+exposure)   → exposure ≈ 目标/当前 - 1
//   对比  contrast(1+contrast)     → contrast ≈ 目标/当前 - 1
//   饱和  saturate(1+saturation)   → saturation ≈ 目标/当前 - 1
//   色温/色调为叠色近似，统计差 × 增益。
// 分母设下限，防止接近全黑/全灰的素材算出夸张参数。

const WARMTH_GAIN = 1.5;
const TINT_GAIN = 1.5;

function value(stats, key) {
  const n = stats ? Number(stats[key]) : NaN;
  return Number.isFinite(n) ? n : null;
}

function clampUnit(v) {
  return Math.min(1, Math.max(-1, v));
}

function round3(v) {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
}

function ratioDelta(target, current, floor) {
  if (target === null || current === null) return 0;
  return (target - current) / Math.max(current, floor);
}

function diffDelta(target, current) {
  if (target === null || current === null) return 0;
  return target - current;
}

/**
 * 计算让 current 统计接近 target 统计的调色参数（绝对值，相对素材原貌）。
 * @param {object} target  目标 ColorStats
 * @param {object} current 当前素材 ColorStats
 * @param {number} strength 0..1，匹配强度
 * @returns {{exposure:number, contrast:number, saturation:number, temperature:number, tint:number}}
 */
export function colorParamsFromStats(target, current, strength = 1) {
  const s = Number.isFinite(Number(strength)) ? Math.min(1, Math.max(0, Number(strength))) : 1;
  const scale = (delta) => round3(clampUnit(delta * s));
  return {
    exposure: scale(ratioDelta(value(target, 'luma'), value(current, 'luma'), 0.2)),
    contrast: scale(ratioDelta(value(target, 'contrast'), value(current, 'contrast'), 0.1)),
    saturation: scale(ratioDelta(value(target, 'saturation'), value(current, 'saturation'), 0.1)),
    temperature: scale(diffDelta(value(target, 'warmth'), value(current, 'warmth')) * WARMTH_GAIN),
    tint: scale(diffDelta(value(target, 'tint'), value(current, 'tint')) * TINT_GAIN),
  };
}

/** colorParamsFromStats 的近似逆运算：估算素材套上 clip.color 后的统计量（供一致性检查）。 */
export function statsWithColor(stats, color) {
  if (!stats) return null;
  const c = color || {};
  const unit = (v) => Math.min(1, Math.max(0, v));
  const n = (k) => (Number.isFinite(Number(c[k])) ? Number(c[k]) : 0);
  return {
    ...stats,
    luma: unit((value(stats, 'luma') ?? 0) * (1 + n('exposure'))),
    contrast: unit((value(stats, 'contrast') ?? 0) * (1 + n('contrast'))),
    saturation: unit((value(stats, 'saturation') ?? 0) * (1 + n('saturation'))),
    warmth: clampUnit((value(stats, 'warmth') ?? 0) + n('temperature') / WARMTH_GAIN),
    tint: clampUnit((value(stats, 'tint') ?? 0) + n('tint') / TINT_GAIN),
  };
}
