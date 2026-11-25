// 时间线纯工具函数（无 React、无 store 依赖，node 可测）。
// 坐标约定：x 为相对轨道区域左缘的像素，t 为时间线秒，pps = 像素/秒。

export const MIN_CLIP = 0.2;
export const MIN_TEXT = 0.2;
export const MAX_TIMELINE = 600;
export const ZOOM_MIN = 8;
export const ZOOM_MAX = 400;

const STILL_KINDS = new Set(['image', 'previz', 'generated-image']);

/** 图片 / 预演 / AI 画面：没有固定源时长，可任意改时长 */
export function isStillAsset(asset) {
  return !asset || STILL_KINDS.has(asset.kind);
}

export function clampNum(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

export function round3(v) { return Math.round(Number(v) * 1000) / 1000; }

// ---------------- 刻度 ----------------
const TICK_TABLE = [
  [0.1, 0.02], [0.2, 0.05], [0.5, 0.1], [1, 0.2], [2, 0.5], [5, 1], [10, 2],
  [15, 5], [30, 5], [60, 10], [120, 30], [300, 60], [600, 120],
];

/** 根据缩放选择主/次刻度间隔（秒）。主刻度间距不小于 minPx 像素；次刻度太密时返回 0 */
export function chooseTickStep(pps, minPx = 72) {
  const p = Number(pps) > 0 ? Number(pps) : 60;
  let pick = TICK_TABLE[TICK_TABLE.length - 1];
  for (const row of TICK_TABLE) { if (row[0] * p >= minPx) { pick = row; break; } }
  const [major, minor] = pick;
  return { major, minor: minor * p >= 6 ? minor : 0 };
}

/** 生成 [start, end] 内按 step 的刻度时间（整数计数，避免浮点累积误差），最多 limit 个 */
export function ticksInView(start, end, step, limit = 3000) {
  if (!(step > 0) || !(end > start)) return [];
  const out = [];
  const i0 = Math.max(0, Math.floor(start / step));
  const i1 = Math.ceil(end / step);
  for (let i = i0; i <= i1 && out.length < limit; i += 1) out.push(Math.round(i * step * 1e6) / 1e6);
  return out;
}

/** 标尺文字：主刻度 < 1 秒时带十分位 */
export function formatRulerTime(t, major = 1) {
  const s = Math.max(0, Number(t) || 0);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  const whole = Math.floor(sec + 1e-6);
  const base = `${String(m).padStart(2, '0')}:${String(whole).padStart(2, '0')}`;
  if (major >= 1) return base;
  const tenth = Math.floor((sec - whole) * 10 + 1e-6);
  return `${base}.${Math.max(0, Math.min(9, tenth))}`;
}

// ---------------- 缩放 ----------------
/** 像素/秒 ↔ 滑杆 0..100（对数映射，手感更均匀） */
export function zoomToSlider(pps) {
  const p = clampNum(pps, ZOOM_MIN, ZOOM_MAX);
  return Math.round((Math.log(p / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN)) * 1000) / 10;
}
export function sliderToZoom(v) {
  const x = clampNum(v, 0, 100) / 100;
  return ZOOM_MIN * Math.pow(ZOOM_MAX / ZOOM_MIN, x);
}
/** 让 [start, end] 占满 widthPx 的 fill 比例所需的缩放 */
export function zoomToFit(start, end, widthPx, fill = 0.92) {
  const span = Math.max(0.5, (Number(end) || 0) - (Number(start) || 0));
  const w = Math.max(100, Number(widthPx) || 0);
  return clampNum((w * fill) / span, ZOOM_MIN, ZOOM_MAX);
}

// ---------------- 吸附 ----------------
/**
 * 把 t 吸附到最近的点（距离 ≤ threshold 秒）。exclude 中的点（拖动对象自身边界）忽略。
 * @returns {{ t:number, snapped:boolean, point:number|null }}
 */
export function snapTime(t, points, threshold, exclude = []) {
  if (!Array.isArray(points) || !points.length || !(threshold > 0)) return { t, snapped: false, point: null };
  let best = null; let bestD = Infinity;
  for (const p of points) {
    if (!Number.isFinite(p)) continue;
    if (exclude.some((e) => Math.abs(e - p) < 1e-6)) continue;
    const d = Math.abs(p - t);
    if (d < bestD) { bestD = d; best = p; }
  }
  if (best != null && bestD <= threshold) return { t: best, snapped: true, point: best };
  return { t, snapped: false, point: null };
}

/** 拖动一段 [start, start+duration]：起点或终点谁更近就吸附谁，返回新的 start */
export function snapSpan(start, duration, points, threshold, exclude = []) {
  const a = snapTime(start, points, threshold, exclude);
  const b = snapTime(start + duration, points, threshold, exclude);
  if (a.snapped && (!b.snapped || Math.abs(a.t - start) <= Math.abs(b.t - (start + duration)))) return { start: a.t, point: a.point };
  if (b.snapped) return { start: b.t - duration, point: b.point };
  return { start, point: null };
}

// ---------------- 主轨插入 / 重排 ----------------
/** 落点 t 对应的插入槽位（0..n）：中心点在 t 左侧的镜头个数 */
export function dropSlot(items, t) {
  if (!Array.isArray(items)) return 0;
  let slot = 0;
  for (const it of items) { if ((it.start + it.end) / 2 < t) slot += 1; }
  return slot;
}

/** 槽位对应的竖线位置（秒） */
export function slotTime(items, slot) {
  if (!Array.isArray(items) || !items.length) return 0;
  if (slot <= 0) return items[0].start;
  if (slot >= items.length) return items[items.length - 1].end;
  return items[slot].start;
}

/** 从 fromIndex 拖到槽位 slot 后的最终索引（0 起） */
export function moveTargetIndex(fromIndex, slot) {
  return slot > fromIndex ? slot - 1 : slot;
}

// ---------------- 裁剪 ----------------
/**
 * 主轨镜头拖边：返回新的 { in, out, duration, still }。
 * 视频：左边改 in、右边改 out（不超素材），按 speed 换算；图片/预演：改时长（保持 in）。
 * dt 为时间线上的位移（秒，向右为正）。
 */
export function trimVideoClip(clip, asset, edge, dt) {
  const speed = Number(clip.speed) > 0 ? Number(clip.speed) : 1;
  const cin = Number(clip.in) || 0;
  const cout = Number.isFinite(Number(clip.out)) ? Number(clip.out) : cin + 5;
  const isFreeze = !!(clip && clip.still);
  const still = isFreeze || isStillAsset(asset);
  const d = Number(dt) || 0;
  if (still) {
    const dur = isFreeze
      ? (Number.isFinite(Number(clip.duration)) ? Number(clip.duration) : 2)
      : (cout - cin) / speed;
    const nd = clampNum(dur + (edge === 'left' ? -d : d), MIN_CLIP, MAX_TIMELINE);
    const nextDur = round3(nd);
    if (isFreeze) return { in: cin, out: cout, duration: nextDur, still: true };
    return { in: cin, out: round3(cin + nd * speed), duration: nextDur, still: true };
  }
  const maxOut = asset && Number(asset.duration) > 0 ? Number(asset.duration) : Infinity;
  if (edge === 'left') {
    const nin = clampNum(cin + d * speed, 0, Math.max(0, cout - MIN_CLIP * speed));
    return { in: round3(nin), out: cout, duration: round3((cout - nin) / speed), still: false };
  }
  const nout = clampNum(cout + d * speed, cin + MIN_CLIP * speed, maxOut);
  return { in: cin, out: round3(nout), duration: round3((nout - cin) / speed), still: false };
}

/** 文字块拖边：左边保持终点改起点，右边改时长 */
export function trimTextClip(start, duration, edge, dt) {
  const s = Math.max(0, Number(start) || 0);
  const du = Math.max(MIN_TEXT, Number(duration) || 0);
  const d = Number(dt) || 0;
  if (edge === 'left') {
    const end = s + du;
    const ns = clampNum(s + d, 0, end - MIN_TEXT);
    return { start: round3(ns), duration: round3(end - ns) };
  }
  return { start: s, duration: round3(clampNum(du + d, MIN_TEXT, MAX_TIMELINE)) };
}

/** 音频块拖边：左边同时改 start 与 in（内容不动），右边改 out（不超素材） */
export function trimAudioClip(audio, assetDuration, edge, dt) {
  const start = Math.max(0, Number(audio.start) || 0);
  const ain = Math.max(0, Number(audio.in) || 0);
  const maxOut = Number(assetDuration) > 0 ? Number(assetDuration) : Infinity;
  const aout = Number.isFinite(Number(audio.out)) ? Number(audio.out) : (Number.isFinite(maxOut) ? maxOut : ain + 10);
  const d = Number(dt) || 0;
  if (edge === 'left') {
    const lo = -Math.min(ain, start);
    const hi = aout - ain - MIN_CLIP;
    const k = clampNum(d, lo, Math.max(lo, hi));
    return { start: round3(start + k), in: round3(ain + k), out: aout };
  }
  return { start, in: ain, out: round3(clampNum(aout + d, ain + MIN_CLIP, maxOut)) };
}

// ---------------- 自由轨道排行 ----------------
function validRow(v, maxRows) {
  const n = Number(v);
  return v != null && v !== '' && Number.isInteger(n) && n >= 0 && n < maxRows ? n : null;
}

function spansOverlap(a, b) { return a.start < b.end - 1e-6 && b.start < a.end - 1e-6; }

/**
 * 把可能重叠的块分到多行，行号尽量稳定（契约 C18）。
 * items: [{ id, start, end, row?, prefRow? }]
 *  - row：强偏好（工程里保存的行号，或用户刚拖到的行），这一行空着就一定放这里；
 *  - prefRow：弱偏好（上一次排布时所在的行），增删、挪动别的块时其它块不跳行；
 *  - 都没有或有冲突时放到最低的空闲行；行全满时叠在最后一行。
 * 返回 { rows: {id: 显示行}, count, logical: {id: 逻辑行}, order: [显示行 → 逻辑行] }。
 * 没有块的逻辑行不占高度（显示行是压缩后的连续编号）。
 */
export function packRows(items, { maxRows = 8 } = {}) {
  const max = Math.max(1, maxRows | 0);
  const list = (items || []).filter((x) => x && x.id != null).map((x) => {
    const start = Number(x.start) || 0;
    return { id: x.id, start, end: Math.max(start, Number(x.end) || 0), row: validRow(x.row, max), pref: validRow(x.prefRow, max) };
  }).sort((a, b) => (a.start - b.start) || (a.end - b.end));
  const lanes = [];
  const logical = {};
  const free = (r, it) => !(lanes[r] || []).some((s) => spansOverlap(s, it));
  const put = (r, it) => { (lanes[r] || (lanes[r] = [])).push(it); logical[it.id] = r; };
  const rest = [];
  for (const it of list) { if (it.row != null && free(it.row, it)) put(it.row, it); else rest.push(it); }
  const rest2 = [];
  for (const it of rest) { if (it.pref != null && free(it.pref, it)) put(it.pref, it); else rest2.push(it); }
  for (const it of rest2) {
    let r = 0;
    while (r < max - 1 && !free(r, it)) r += 1;
    put(r, it);
  }
  const order = [...new Set(Object.values(logical))].sort((a, b) => a - b);
  const rank = new Map(order.map((r, i) => [r, i]));
  const rows = {};
  for (const it of list) rows[it.id] = rank.get(logical[it.id]);
  return { rows, count: Math.max(1, order.length), logical, order };
}

/**
 * 给一个块找落脚的逻辑行：prefer 行在 [start, end) 上没有别的块就用它，否则用最低的空闲行；全满返回 -1。
 * items 同 packRows 的输入（含 logical 行号 row），id 为正在移动的块（不和自己比）。
 */
export function freeRow(items, id, start, end, prefer, maxRows = 8) {
  const span = { start: Number(start) || 0, end: Number(end) || 0 };
  const busy = (r) => (items || []).some((x) => x && x.id !== id && x.row === r && spansOverlap(span, { start: Number(x.start) || 0, end: Number(x.end) || 0 }));
  if (Number.isInteger(prefer) && prefer >= 0 && prefer < maxRows && !busy(prefer)) return prefer;
  for (let r = 0; r < maxRows; r += 1) if (!busy(r)) return r;
  return -1;
}

// ---------------- 胶片条 / 波形 ----------------
/** 胶片条应请求的总帧数（覆盖整段素材，按 2 的幂分档以复用缓存） */
export function filmstripRequestCount(slots, assetDuration, srcLen) {
  const ad = Math.max(0.1, Number(assetDuration) || 0.1);
  const sl = Math.max(0.05, Number(srcLen) || 0.05);
  const need = clampNum(Math.ceil(Math.max(1, slots) * (ad / sl)), 1, 32);
  let n = 1; while (n < need) n *= 2;
  return Math.min(32, Math.max(4, n));
}

/** 每个格子取胶片条中的哪一帧（帧 k 对应素材时间 (k+0.5)/N × 时长） */
export function pickFilmFrames(frameCount, assetDuration, srcIn, srcOut, slots) {
  const n = Math.max(1, frameCount | 0);
  const ad = Math.max(0.001, Number(assetDuration) || 0.001);
  const a = Math.max(0, Number(srcIn) || 0);
  const b = Math.max(a + 0.001, Number(srcOut) || a + 0.001);
  const s = Math.max(1, slots | 0);
  const out = [];
  for (let j = 0; j < s; j += 1) {
    const t = a + ((j + 0.5) / s) * (b - a);
    out.push(clampNum(Math.floor((t / ad) * n), 0, n - 1));
  }
  return out;
}

/** 一块胶片条请求多少帧：按缩略图宽度铺满，取 2 的幂（缩放 2 倍以内不重新取帧），最多 32 帧 */
export function filmFrameCount(width, thumbW) {
  const need = Math.max(1, (Number(width) || 0) / Math.max(8, Number(thumbW) || 8));
  return clampNum(2 ** Math.ceil(Math.log2(need) - 1e-9), 1, 32);
}

/**
 * 胶片条分块（契约 C5）：把片段块按 chunkW 像素切块，只返回 [fromChunk, toChunk] 范围内（看得见的）块。
 * 每块给出在块内的位置与对应的素材区间 [a, b]（倒放时从出点往回），以及要取的帧数 n。
 * 定格片段只有一块，区间退化为入点那一帧。
 */
export function filmChunks({ width, srcIn, srcOut, reverse = false, still = false, thumbW, fromChunk = 0, toChunk = Infinity, chunkW = 1024 }) {
  const w = Math.max(1, Number(width) || 1);
  const a0 = Math.max(0, Number(srcIn) || 0);
  const b0 = Math.max(a0, Number(srcOut) || 0);
  if (still || !(b0 - a0 > 0.01)) return [{ i: 0, left: 0, width: w, a: a0, b: a0, n: 1, still: true }];
  const len = b0 - a0;
  const total = Math.max(1, Math.ceil(w / chunkW));
  const lo = Number.isFinite(Number(fromChunk)) ? clampNum(Math.floor(fromChunk), 0, total - 1) : 0;
  const hi = Number.isFinite(Number(toChunk)) ? clampNum(Math.floor(toChunk), lo, total - 1) : total - 1;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const out = [];
  for (let i = lo; i <= hi; i += 1) {
    const x0 = i * chunkW;
    const x1 = Math.min(w, x0 + chunkW);
    const a = reverse ? b0 - (x1 / w) * len : a0 + (x0 / w) * len;
    const b = reverse ? b0 - (x0 / w) * len : a0 + (x1 / w) * len;
    out.push({ i, left: x0, width: x1 - x0, a: r3(a), b: r3(b), n: filmFrameCount(x1 - x0, thumbW), still: false });
  }
  return out;
}

/** 从整段波形峰值中取 [srcIn, srcOut] 并归并到 bins 个柱 */
export function slicePeaks(peaks, peaksPerSecond, srcIn, srcOut, bins) {
  const arr = Array.isArray(peaks) ? peaks : [];
  const pps = Number(peaksPerSecond) > 0 ? Number(peaksPerSecond) : 50;
  const n = Math.max(1, bins | 0);
  const a = Math.max(0, Number(srcIn) || 0) * pps;
  const b = Math.max(a + 1e-6, (Number(srcOut) || 0) * pps);
  const out = new Array(n).fill(0);
  if (!arr.length) return out;
  const per = (b - a) / n;
  for (let i = 0; i < n; i += 1) {
    const lo = Math.floor(a + i * per);
    const hi = Math.max(lo + 1, Math.ceil(a + (i + 1) * per));
    let m = 0;
    for (let k = lo; k < hi && k < arr.length; k += 1) { const v = Math.abs(Number(arr[k]) || 0); if (v > m) m = v; }
    out[i] = Math.min(1, m);
  }
  return out;
}

// ---------------- 并发队列 / 缓存 ----------------
/** 简单并发队列：限制同时进行的媒体请求（胶片条、波形），避免 200 个镜头同时打 ffmpeg */
export function createQueue(concurrency = 2) {
  let running = 0;
  const waiting = [];
  const next = () => {
    while (running < concurrency && waiting.length) {
      const { fn, resolve, reject } = waiting.shift();
      running += 1;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => { running -= 1; next(); });
    }
  };
  return {
    push(fn) { return new Promise((resolve, reject) => { waiting.push({ fn, resolve, reject }); next(); }); },
    get size() { return waiting.length + running; },
  };
}

/** 带失败过期的 Promise 缓存：失败结果 retryMs 后可重试 */
export function createPromiseCache({ retryMs = 20000, max = 400 } = {}) {
  const map = new Map();
  return {
    get(key, loader) {
      if (map.has(key)) return map.get(key);
      const p = Promise.resolve().then(loader);
      map.set(key, p);
      if (map.size > max) map.delete(map.keys().next().value);
      p.catch(() => { setTimeout(() => { if (map.get(key) === p) map.delete(key); }, retryMs); });
      return p;
    },
    has(key) { return map.has(key); },
    clear() { map.clear(); },
  };
}

// ---------------- 拖动辅助（浏览器） ----------------
/**
 * 从 pointerdown 开始一次拖动。onMove(dx, dy, ev, moved)、onEnd(dx, dy, ev, moved, cancelled)。
 * 位移超过 threshold 像素才算 moved。Esc 取消。返回 cancel()。
 * raf: true 时一帧内的多次移动合并成一次 onMove（高刷新率鼠标不会一帧重渲染多次）；松手前会先补上最后一次移动。
 */
export function startDrag(downEvent, { onMove, onEnd, threshold = 3, cursor, raf = false } = {}) {
  const x0 = downEvent.clientX; const y0 = downEvent.clientY;
  let moved = false; let done = false;
  let pending = null; let frame = 0;
  const useRaf = !!raf && typeof requestAnimationFrame === 'function';
  const prevCursor = typeof document !== 'undefined' ? document.body.style.cursor : '';
  if (cursor && typeof document !== 'undefined') document.body.style.cursor = cursor;
  const emit = () => {
    frame = 0;
    const ev = pending; pending = null;
    if (ev && !done && onMove) onMove(ev.clientX - x0, ev.clientY - y0, ev, true);
  };
  const move = (ev) => {
    const dx = ev.clientX - x0; const dy = ev.clientY - y0;
    if (!moved && Math.abs(dx) < threshold && Math.abs(dy) < threshold) return;
    moved = true;
    if (!onMove) return;
    if (!useRaf) { onMove(dx, dy, ev, moved); return; }
    pending = ev;
    if (!frame) frame = requestAnimationFrame(emit);
  };
  const finish = (ev, cancelled) => {
    if (done) return;
    if (frame) {
      cancelAnimationFrame(frame); frame = 0;
      if (!cancelled && pending) emit();
    }
    pending = null;
    done = true;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', key, true);
    window.removeEventListener('blur', cancel);
    if (typeof document !== 'undefined') document.body.style.cursor = prevCursor;
    const dx = ev && Number.isFinite(ev.clientX) ? ev.clientX - x0 : 0;
    const dy = ev && Number.isFinite(ev.clientY) ? ev.clientY - y0 : 0;
    if (onEnd) onEnd(dx, dy, ev, moved, !!cancelled);
  };
  const up = (ev) => finish(ev, false);
  const cancel = (ev) => finish(ev, true);
  const key = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); finish(null, true); } };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', key, true);
  window.addEventListener('blur', cancel);
  return () => finish(null, true);
}

// ---------------- 本地存储 ----------------
export function readPref(key, fallback) {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    if (raw == null) return fallback;
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch { return fallback; }
}
export function writePref(key, value) {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(value)); } catch { /* 存储不可用时忽略 */ }
}

// ---------------- v3：虚拟化 / 剪辑点 / 精修拖拽 ----------------
/** 片段 [start,end] 是否与可见窗口 [viewStart, viewEnd]（含 margin 秒）相交 */
export function spanInView(start, end, viewStart, viewEnd, margin = 0) {
  return Number(end) >= Number(viewStart) - margin && Number(start) <= Number(viewEnd) + margin;
}

/** 可见区域虚拟化：只保留与视窗相交的条目（getSpan(it) → [start,end]） */
export function visibleItems(items, viewStart, viewEnd, getSpan, margin = 2) {
  if (!Array.isArray(items)) return [];
  const span = getSpan || ((it) => [it.start, it.end]);
  return items.filter((it) => { const [a, b] = span(it); return spanInView(a, b, viewStart, viewEnd, margin); });
}

/** 剪辑点列表（升序去重） */
export function editPoints(layout, extra = []) {
  const set = new Set();
  for (const it of layout || []) { set.add(round3(it.start)); set.add(round3(it.end)); }
  for (const p of extra || []) if (Number.isFinite(Number(p))) set.add(round3(p));
  return Array.from(set).sort((a, b) => a - b);
}

/** 上一个 / 下一个剪辑点（dir=-1/1）；没有则返回 null */
export function nextEditPoint(points, t, dir = 1) {
  const list = (points || []).filter(Number.isFinite).slice().sort((a, b) => a - b);
  const eps = 1e-3;
  if (dir > 0) { for (const p of list) if (p > t + eps) return p; return null; }
  for (let i = list.length - 1; i >= 0; i -= 1) if (list[i] < t - eps) return list[i];
  return null;
}

function clipLen(clip) {
  if (clip && clip.still) return Math.max(0, Number.isFinite(Number(clip.duration)) ? Number(clip.duration) : 2);
  const sp = Number(clip.speed) > 0 ? Number(clip.speed) : 1;
  return Math.max(0, ((Number(clip.out) || 0) - (Number(clip.in) || 0)) / sp);
}

/**
 * roll（滚动剪辑点）可用位移范围（时间线秒）：左镜出点与右镜入点同时移动，总长不变。
 * 负值 = 剪辑点左移（左镜变短、右镜往前取素材）。
 */
export function rollLimits(leftClip, leftAsset, rightClip, rightAsset) {
  const ls = Number(leftClip.speed) > 0 ? Number(leftClip.speed) : 1;
  const rs = Number(rightClip.speed) > 0 ? Number(rightClip.speed) : 1;
  const lMin = -(clipLen(leftClip) - MIN_CLIP);
  const rMax = clipLen(rightClip) - MIN_CLIP;
  const lRoom = (leftClip && leftClip.still) || isStillAsset(leftAsset) ? Infinity
    : Math.max(0, ((Number(leftAsset && leftAsset.duration) || Infinity) - (Number(leftClip.out) || 0)) / ls);
  const rRoom = (rightClip && rightClip.still) || isStillAsset(rightAsset) ? Infinity : Math.max(0, (Number(rightClip.in) || 0) / rs);
  return { min: round3(Math.max(lMin, -rRoom)), max: round3(Math.min(rMax, lRoom)) };
}

/** slip（滑动内容）可用的源时间位移范围：in ≥ 0，out ≤ 素材时长 */
export function slipLimits(clip, asset) {
  if (isStillAsset(asset)) return { min: 0, max: 0 };
  const cin = Number(clip.in) || 0;
  const cout = Number(clip.out) || 0;
  const dur = Number(asset && asset.duration) > 0 ? Number(asset.duration) : cout;
  return { min: round3(-cin), max: round3(Math.max(0, dur - cout)) };
}

/** 转场方块拖动：dx 像素 → 新转场时长（两侧对称展开，故 ×2），限制在 [0.1, maxDur] */
export function transitionDurationFromDrag(d0, dx, pps, maxDur = 3) {
  const z = Number(pps) > 0 ? Number(pps) : 60;
  const v = (Number(d0) || 0) + (2 * (Number(dx) || 0)) / z;
  return round3(clampNum(v, 0.1, Math.max(0.1, maxDur)));
}

/** 淡入/淡出拖柄：把拖柄到边缘的距离（秒）限制在 [0, min(len/2, 30)] */
export function fadeFromDrag(len, seconds) {
  return round3(clampNum(seconds, 0, Math.min(30, Math.max(0, Number(len) || 0) / 2)));
}

/** 音量 0..2 ↔ 块内 y 像素（上为大）。1.0 位于 1/2 高度 */
export function volumeToY(v, h) { return round3((1 - clampNum(v, 0, 2) / 2) * h); }
export function yToVolume(y, h) { return round3(clampNum((1 - (Number(y) || 0) / Math.max(1, h)) * 2, 0, 2)); }

/**
 * 音量线（SVG polyline points）：基础音量 base，叠加 volumeKeys[{t,v}]（片段本地秒）与淡入淡出。
 * 返回 "x,y x,y ..."（像素，相对块左上角）
 */
export function volumeLinePoints({ base = 1, keys = [], fadeIn = 0, fadeOut = 0, len, pps, h }) {
  const L = Math.max(0, Number(len) || 0);
  const z = Number(pps) > 0 ? Number(pps) : 60;
  const ks = (keys || []).filter((k) => k && Number.isFinite(Number(k.t))).map((k) => ({ t: clampNum(k.t, 0, L), v: clampNum(k.v, 0, 2) })).sort((a, b) => a.t - b.t);
  const valueAt = (t) => {
    if (!ks.length) return clampNum(base, 0, 2);
    if (t <= ks[0].t) return ks[0].v;
    for (let i = 1; i < ks.length; i += 1) {
      if (t <= ks[i].t) { const a = ks[i - 1]; const b = ks[i]; const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1; return a.v + (b.v - a.v) * f; }
    }
    return ks[ks.length - 1].v;
  };
  const fi = fadeFromDrag(L, fadeIn); const fo = fadeFromDrag(L, fadeOut);
  const ts = new Set([0, L, fi, L - fo, ...ks.map((k) => k.t)]);
  const pts = Array.from(ts).filter((t) => t >= 0 && t <= L).sort((a, b) => a - b);
  return pts.map((t) => {
    let v = valueAt(t);
    if (fi > 0 && t < fi) v *= t / fi;
    if (fo > 0 && t > L - fo) v *= (L - t) / fo;
    return `${round3(t * z)},${volumeToY(v, h)}`;
  }).join(' ');
}

/** 画中画轨编号（1..4）列表：已使用的轨道 + 至少 minCount 条 */
export function overlayTrackList(overlays, minCount = 1, max = 4) {
  let top = Math.max(0, ...((overlays || []).map((o) => clampNum(o && o.track, 1, max))));
  top = Math.min(max, Math.max(minCount, top));
  const out = [];
  for (let i = top; i >= 1; i -= 1) out.push(i); // 上层在上
  return out;
}

/** 画中画片段在时间线上的时长 */
export function overlayDuration(ov) {
  const sp = Number(ov && ov.speed) > 0 ? Number(ov.speed) : 1;
  return Math.max(MIN_CLIP, ((Number(ov && ov.out) || 0) - (Number(ov && ov.in) || 0)) / sp);
}

/** 关键帧时间（片段本地秒，去重升序），用于在片段上画小菱形 */
export function keyframeTimes(keys) {
  const set = new Set();
  if (keys && typeof keys === 'object') {
    for (const list of Object.values(keys)) for (const k of (Array.isArray(list) ? list : [])) if (k && Number.isFinite(Number(k.t))) set.add(round3(k.t));
  }
  return Array.from(set).sort((a, b) => a - b);
}

/** 时长短文案：4.2s / 1:05 */
export function shortDur(sec) {
  const s = Math.max(0, Number(sec) || 0);
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60); const r = Math.floor(s - m * 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

/** 镜头号范围文案：第3镜 / 第3–5镜 */
export function shotRangeLabel(indices) {
  const list = (indices || []).filter((i) => Number.isFinite(i));
  if (!list.length) return '';
  const a = Math.min(...list) + 1; const b = Math.max(...list) + 1;
  return a === b ? `第${a}镜` : `第${a}–${b}镜`;
}
