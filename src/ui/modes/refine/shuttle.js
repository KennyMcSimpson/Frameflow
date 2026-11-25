// J/K/L 穿梭倍速纯函数（node 可测，不依赖 React / store / DOM）。
export const SHUTTLE_STEPS = [1, 2, 4];

/** 纯状态机：给定当前 rate 与按键（'J'|'K'|'L'）返回新 rate */
export function nextShuttleRate(rate, key) {
  if (key === 'K') return 0;
  const dir = key === 'L' ? 1 : -1;
  const cur = Number(rate) || 0;
  if (Math.sign(cur) !== dir) return dir;
  const i = SHUTTLE_STEPS.indexOf(Math.abs(cur));
  return dir * SHUTTLE_STEPS[Math.min(SHUTTLE_STEPS.length - 1, i + 1)];
}

/**
 * 预览左上角的倍速角标（纯函数）：倒放显示「◀ 1×」「◀◀ 4×」，快进显示「▶▶ 2×」；正常播放 / 停止时为 null。
 * @returns {{dir:'back'|'fwd', rate:number, arrows:string, text:string, title:string}|null}
 */
export function shuttleBadge(rate, playing) {
  const r = Number(rate) || 0;
  if (r < 0) {
    const n = Math.abs(r);
    const arrows = n > 1 ? '◀◀' : '◀';
    return { dir: 'back', rate: n, arrows, text: `${arrows} ${n}×`, title: `倒放 ${n}×（倒放预览没有声音；按 K 停止，再按 J 加速）` };
  }
  if (r > 1 && playing) {
    return { dir: 'fwd', rate: r, arrows: '▶▶', text: `▶▶ ${r}×`, title: `快进 ${r}×（声音音调不变；按 K 停止，再按 L 加速）` };
  }
  return null;
}
