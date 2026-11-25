// 唯一 id 生成（浏览器与 node 都可用）
export function uid(prefix = 'id') {
  const rnd = (globalThis.crypto && globalThis.crypto.randomUUID)
    ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
  return `${prefix}_${rnd}`;
}

export function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

export function round(v, d = 3) {
  const f = 10 ** d;
  return Math.round(Number(v) * f) / f;
}

export function deepClone(o) {
  return o == null ? o : JSON.parse(JSON.stringify(o));
}
