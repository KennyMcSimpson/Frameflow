// 时间线布局与时间查询（SPEC §3.3、CONTRACTS §B）。纯函数，不修改入参。
//
// 主轨是磁吸顺序排列的：第 i 个镜头开始时间 start_i = end_{i-1} - overlap_i，
// 其中非 cut 转场 overlap_i = min(转场时长, dur_i/2, dur_{i-1}/2)，cut 为 0；第 0 个镜头 overlap 恒为 0。
// 因为 overlap 不超过相邻两镜时长的一半，同一时刻最多只会有两个镜头同时活动。

const FIRST_CLIP_FADES = new Set(['dip-black', 'dip-white', 'crossfade']);
const FRAME = 1 / 60;

function finite(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function videoTrack(project) {
  const list = project && project.tracks && project.tracks.video;
  return Array.isArray(list) ? list : [];
}
function textTrack(project) {
  const list = project && project.tracks && project.tracks.text;
  return Array.isArray(list) ? list : [];
}
function audioTrack(project) {
  const list = project && project.tracks && project.tracks.audio;
  return Array.isArray(list) ? list : [];
}

const MIN_SPEED = 0.1;
const MAX_SPEED = 10;

function validCurve(curve) {
  return Array.isArray(curve) && curve.length >= 2 && curve.every((p) => p && Number.isFinite(Number(p.t)) && Number(p.v) > 0);
}
function curveV(p) { return Math.min(MAX_SPEED, Math.max(MIN_SPEED, Number(p.v))); }

/** 变速曲线在 [0,u] 上 v 的积分（曲线定义在片段时间线进度 u∈[0,1] 上，分段线性）。 */
export function curveIntegral(curve, u) {
  const x = Math.min(1, Math.max(0, finite(u)));
  let sum = 0;
  for (let i = 0; i < curve.length - 1; i += 1) {
    const a = curve[i];
    const b = curve[i + 1];
    const t0 = Number(a.t);
    const t1 = Number(b.t);
    if (t1 <= t0) continue;
    if (x <= t0) break;
    const end = Math.min(x, t1);
    const va = curveV(a);
    const vb = curveV(b);
    const ve = va + (vb - va) * ((end - t0) / (t1 - t0));
    sum += ((va + ve) / 2) * (end - t0);
    if (x <= t1) break;
  }
  return sum;
}

/** 曲线平均速度（= ∫0^1 v du） */
export function curveMeanSpeed(curve) {
  if (!validCurve(curve)) return 1;
  const m = curveIntegral(curve, 1);
  return m > 0 ? m : 1;
}

/** 曲线在进度 u 处的瞬时速度 */
export function curveSpeedAt(curve, u) {
  if (!validCurve(curve)) return 1;
  const x = Math.min(1, Math.max(0, finite(u)));
  for (let i = 0; i < curve.length - 1; i += 1) {
    const a = curve[i]; const b = curve[i + 1];
    if (x <= Number(b.t) || i === curve.length - 2) {
      const span = Number(b.t) - Number(a.t);
      return span > 0 ? curveV(a) + (curveV(b) - curveV(a)) * ((x - Number(a.t)) / span) : curveV(b);
    }
  }
  return 1;
}

/** 取曲线 [u0,u1] 子段并重新归一化到 [0,1]（分割/修剪曲线变速片段用） */
export function sliceCurve(curve, u0, u1) {
  if (!validCurve(curve)) return null;
  const a = Math.min(1, Math.max(0, u0));
  const b = Math.min(1, Math.max(a + 1e-6, u1));
  const pts = [{ t: 0, v: curveSpeedAt(curve, a) }];
  for (const p of curve) if (p.t > a && p.t < b) pts.push({ t: (p.t - a) / (b - a), v: curveV(p) });
  pts.push({ t: 1, v: curveSpeedAt(curve, b) });
  return pts.map((p) => ({ t: Math.round(p.t * 10000) / 10000, v: Math.round(p.v * 1000) / 1000 }));
}

/**
 * 镜头在时间线上的时长。
 * - still（定格）：clip.duration（默认 2 秒）
 * - speedCurve：(out-in) / 曲线平均速度（曲线存在时忽略 speed）
 * - 其他：(out-in)/speed
 * 缺字段或非法值按 0 / 1 倍速处理，绝不返回负数或 NaN。
 */
export function clipDuration(clip) {
  if (!clip) return 0;
  if (clip.still) return Math.max(0, finite(clip.duration, 2));
  const len = Math.max(0, finite(clip.out) - finite(clip.in));
  if (validCurve(clip.speedCurve)) return len / curveMeanSpeed(clip.speedCurve);
  const speed = finite(clip.speed, 1) > 0 ? finite(clip.speed, 1) : 1;
  return len / speed;
}

/**
 * 片段本地时刻 localT（秒，0=片段开始）对应的素材源时间。
 * 处理 still（恒为 in）、speedCurve（积分）、speed、reverse（从 out 往回）。
 * 结果夹在 [in, out-1帧]，保证可解码。
 */
export function sourceTimeAt(clip, localT) {
  if (!clip) return 0;
  const clipIn = finite(clip.in);
  if (clip.still) return clipIn;
  const clipOut = finite(clip.out);
  const len = Math.max(0, clipOut - clipIn);
  const dur = clipDuration(clip);
  const t = Math.min(dur, Math.max(0, finite(localT)));
  let offset;
  if (validCurve(clip.speedCurve) && dur > 0) {
    offset = dur * curveIntegral(clip.speedCurve, t / dur);
  } else {
    const speed = finite(clip.speed, 1) > 0 ? finite(clip.speed, 1) : 1;
    offset = t * speed;
  }
  offset = Math.min(len, Math.max(0, offset));
  const maxSrc = Math.max(clipIn, clipOut - FRAME);
  const src = clip.reverse ? clipOut - offset : clipIn + offset;
  return Math.min(maxSrc, Math.max(clipIn, src));
}

/** sourceTimeAt 的逆运算（非 reverse、非 still）：素材源时间 → 片段本地秒。用于分割时把源时间换回时间线。 */
export function localTimeAtSource(clip, src) {
  const dur = clipDuration(clip);
  if (!clip || clip.still || dur <= 0) return 0;
  const len = Math.max(1e-9, finite(clip.out) - finite(clip.in));
  const target = Math.min(len, Math.max(0, (clip.reverse ? finite(clip.out) - finite(src) : finite(src) - finite(clip.in))));
  let lo = 0; let hi = dur;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    const off = Math.abs(sourceTimeAt({ ...clip, reverse: false }, mid) - finite(clip.in));
    if (off < target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function overlapBetween(prevDuration, clip, duration) {
  const tr = clip && clip.transitionIn;
  if (!tr || !tr.type || tr.type === 'cut') return 0;
  return Math.max(0, Math.min(finite(tr.duration, 0), duration / 2, prevDuration / 2));
}

/** 计算主轨布局。返回 LayoutItem[] = { clip, index, start, end, duration, overlap } */
export function layoutVideo(project) {
  const items = [];
  let cursor = 0;
  let prevDuration = 0;
  videoTrack(project).forEach((clip, index) => {
    const duration = clipDuration(clip);
    const overlap = index === 0 ? 0 : overlapBetween(prevDuration, clip, duration);
    const start = Math.max(0, cursor - overlap);
    const end = start + duration;
    items.push({ clip, index, start, end, duration, overlap });
    cursor = end;
    prevDuration = duration;
  });
  return items;
}

function textEnd(t) {
  return finite(t.start) + Math.max(0, finite(t.duration));
}
function audioLength(a) {
  return Math.max(0, finite(a.out) - finite(a.in));
}
function audioEnd(a) {
  return finite(a.start) + audioLength(a);
}

/** 项目总时长：max(主轨 end, 文字 end, 音频 end)；空项目 0。 */
export function projectDuration(project, layout) {
  const items = layout || layoutVideo(project);
  let total = items.length ? items[items.length - 1].end : 0;
  for (const t of textTrack(project)) total = Math.max(total, textEnd(t));
  for (const a of audioTrack(project)) total = Math.max(total, audioEnd(a));
  for (const o of overlayList(project)) total = Math.max(total, overlayEnd(o));
  return total;
}

function makeEntry(item, t) {
  const { clip, index, start, end, duration } = item;
  const srcTime = sourceTimeAt(clip, t - start);
  const progress = duration > 0 ? Math.min(1, Math.max(0, (t - start) / duration)) : 0;
  return { clip, index, start, end, duration, srcTime, progress };
}

const EMPTY_ACTIVE = Object.freeze({ out: null, in: null, transition: null });

/**
 * 查询时刻 t 的活动镜头。
 * - 普通时刻：out=null, in=当前镜头, transition=null
 * - 转场 i-1→i（t ∈ [start_i, start_i+overlap_i)）：out=镜头 i-1, in=镜头 i
 * - 第一镜入场 dip-black/dip-white/crossfade：out=null, in=镜头 0, transition 有值（从黑/白淡入）
 *   淡入时长最多到第二镜转场开始之前，避免两个效果抢同一段时间。
 * - t<0 或超出主轨总时长：三者皆 null。t 恰好等于总时长时仍返回最后一镜（播放头停在末尾时显示末帧）。
 */
export function activeAt(layout, t) {
  const time = Number(t);
  if (!Array.isArray(layout) || layout.length === 0 || !Number.isFinite(time) || time < 0) return { ...EMPTY_ACTIVE };
  const last = layout[layout.length - 1];
  if (time > last.end) return { ...EMPTY_ACTIVE };

  let i = layout.length - 1;
  while (i > 0 && layout[i].start > time) i -= 1;
  const item = layout[i];

  if (i > 0 && item.overlap > 0 && time < item.start + item.overlap) {
    const tr = item.clip.transitionIn;
    return {
      out: makeEntry(layout[i - 1], time),
      in: makeEntry(item, time),
      transition: { type: tr.type, p: Math.min(1, Math.max(0, (time - item.start) / item.overlap)), duration: item.overlap },
    };
  }

  if (i === 0) {
    const tr = item.clip.transitionIn;
    if (tr && FIRST_CLIP_FADES.has(tr.type)) {
      const next = layout[1];
      const fade = Math.min(finite(tr.duration, 0), next ? next.start : item.duration);
      if (fade > 0 && time < fade) {
        return { out: null, in: makeEntry(item, time), transition: { type: tr.type, p: Math.min(1, Math.max(0, time / fade)), duration: fade } };
      }
    }
  }
  return { out: null, in: makeEntry(item, time), transition: null };
}

/** 时刻 t 活动的文字层，按轨道顺序（后者盖前者）。 */
export function textAt(project, t) {
  const time = Number(t);
  if (!Number.isFinite(time)) return [];
  const out = [];
  for (const text of textTrack(project)) {
    const start = finite(text.start);
    const duration = Math.max(0, finite(text.duration));
    if (duration > 0 && time >= start && time < start + duration) {
      out.push({ text, progress: (time - start) / duration, local: time - start });
    }
  }
  return out;
}

/** 时刻 t 活动的音频片段。音频轨不变速：srcTime = in + (t-start)。 */
export function audioAt(project, t) {
  const time = Number(t);
  if (!Number.isFinite(time)) return [];
  const out = [];
  for (const audio of audioTrack(project)) {
    const start = finite(audio.start);
    const length = audioLength(audio);
    if (length > 0 && time >= start && time < start + length) {
      out.push({ audio, srcTime: finite(audio.in) + (time - start) });
    }
  }
  return out;
}

/** 时刻 t 所在镜头的索引（0 起）。转场重叠期算后一镜；t 越界夹到首尾；空主轨 -1。 */
export function indexAtTime(layout, t) {
  if (!Array.isArray(layout) || layout.length === 0) return -1;
  const time = Number(t);
  if (!Number.isFinite(time) || time <= 0) return 0;
  let i = layout.length - 1;
  while (i > 0 && layout[i].start > time) i -= 1;
  return i;
}

/** 与 [start, end] 有重叠的布局项；首尾颠倒时自动交换。零长度区间等于查询该时刻落在哪些镜头内。 */
export function itemsInRange(layout, start, end) {
  if (!Array.isArray(layout)) return [];
  const a = Number(start);
  const b = Number(end);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return [];
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (lo === hi) return layout.filter((it) => it.start <= lo && it.end > lo);
  return layout.filter((it) => it.start < hi && it.end > lo);
}

// ---------------------------------------------------------------------------
// 画中画轨（overlays）
// ---------------------------------------------------------------------------
function overlayList(project) {
  const list = project && project.overlays;
  return Array.isArray(list) ? list : [];
}
/** 画中画片段时长：(out-in)/speed */
export function overlayDuration(o) {
  if (!o) return 0;
  const speed = finite(o.speed, 1) > 0 ? finite(o.speed, 1) : 1;
  return Math.max(0, (finite(o.out) - finite(o.in)) / speed);
}
function overlayEnd(o) { return finite(o.start) + overlayDuration(o); }

/** 轨道状态（锁定/隐藏/静音）。kind：video|text|audio|overlay；overlay 需给 n=1..4 */
export function trackFlags(project, kind, n) {
  const st = (project && project.trackState) || {};
  const f = kind === 'overlay' ? st.overlay && st.overlay[n] : st[kind];
  return { locked: !!(f && f.locked), hidden: !!(f && f.hidden), muted: !!(f && f.muted) };
}

/** 时刻 t 活动的画中画，按 track 升序（后者在上层），隐藏轨被跳过。 */
export function overlaysAt(project, t) {
  const time = Number(t);
  if (!Number.isFinite(time)) return [];
  const out = [];
  for (const o of overlayList(project)) {
    if (trackFlags(project, 'overlay', o.track || 1).hidden) continue;
    const start = finite(o.start);
    const d = overlayDuration(o);
    if (d > 0 && time >= start && time < start + d) {
      const speed = finite(o.speed, 1) > 0 ? finite(o.speed, 1) : 1;
      const local = time - start;
      out.push({ overlay: o, local, progress: local / d, srcTime: Math.min(finite(o.out) - FRAME, finite(o.in) + local * speed) });
    }
  }
  return out.sort((a, b) => (a.overlay.track || 1) - (b.overlay.track || 1));
}

// ---------------------------------------------------------------------------
// 节拍与吸附
// ---------------------------------------------------------------------------
/** 音频轨上所有素材节拍（asset.beats，素材秒）映射到时间线，升序。 */
export function beatTimes(project) {
  const assets = (project && project.assets) || {};
  const out = [];
  for (const a of audioTrack(project)) {
    const asset = assets[a.assetId];
    if (!asset || !Array.isArray(asset.beats)) continue;
    for (const b of asset.beats) {
      const n = Number(b);
      if (Number.isFinite(n) && n >= finite(a.in) && n <= finite(a.out)) out.push(finite(a.start) + n - finite(a.in));
    }
  }
  return out.sort((x, y) => x - y);
}

/** 最近的节拍；beats 为空或超出 maxDist 返回 null。 */
export function nearestBeat(beats, t, maxDist = Infinity) {
  if (!Array.isArray(beats) || !beats.length) return null;
  const time = finite(t);
  let best = null;
  for (const b of beats) {
    const n = Number(b);
    if (!Number.isFinite(n)) continue;
    if (best === null || Math.abs(n - time) < Math.abs(best - time)) best = n;
  }
  return best !== null && Math.abs(best - time) <= maxDist ? best : null;
}

/** 吸附点：0、镜头边界、文字/音频/画中画边界、标记点、音乐节拍，升序去重。 */
export function snapPoints(layout, project) {
  const points = new Set([0]);
  for (const it of layout || []) {
    points.add(it.start);
    points.add(it.end);
  }
  for (const t of textTrack(project)) {
    points.add(finite(t.start));
    points.add(textEnd(t));
  }
  for (const a of audioTrack(project)) {
    points.add(finite(a.start));
    points.add(audioEnd(a));
  }
  for (const o of overlayList(project)) {
    points.add(finite(o.start));
    points.add(overlayEnd(o));
  }
  for (const m of (project && Array.isArray(project.markers) ? project.markers : [])) points.add(finite(m.t));
  for (const b of beatTimes(project)) points.add(b);
  return [...points].map((x) => Math.round(x * 10000) / 10000).filter((x, i, arr) => arr.indexOf(x) === i).sort((x, y) => x - y);
}

// ---------------------------------------------------------------------------
// 编辑纯函数（PR/剪映式：滚动、内滑、外滑、波纹删除、Q/W）。
// 均返回新 project，不修改入参；无法执行时 throw Error（中文信息）。
// ---------------------------------------------------------------------------
const MIN_CLIP = 0.2;
const EPS = 1e-6;

function r4(v) { return Math.round(v * 10000) / 10000; }
function assetOf(project, clip) { return project && project.assets ? project.assets[clip.assetId] : null; }
function srcMax(asset) {
  return asset && asset.kind === 'video' && Number(asset.duration) > 0 ? Number(asset.duration) : Infinity;
}
function isVideoAsset(asset) { return !!asset && asset.kind === 'video'; }
/** 每秒时间线消耗的源秒数 */
function effSpeed(clip) {
  const d = clipDuration(clip);
  return clip.still || d <= 0 ? 0 : (finite(clip.out) - finite(clip.in)) / d;
}
/** 尾部最多还能延长多少时间线秒 */
function tailRoom(clip, asset) {
  if (clip.still || !isVideoAsset(asset)) return Infinity;
  const e = effSpeed(clip) || 1;
  return clip.reverse ? finite(clip.in) / e : (srcMax(asset) - finite(clip.out)) / e;
}
/** 头部最多还能向前延长多少时间线秒 */
function headRoom(clip, asset) {
  if (clip.still || !isVideoAsset(asset)) return Infinity;
  const e = effSpeed(clip) || 1;
  return clip.reverse ? (srcMax(asset) - finite(clip.out)) / e : finite(clip.in) / e;
}
/** 尾部改变 dt 时间线秒（正=延长） */
function changeTail(clip, asset, dt) {
  if (clip.still) return { ...clip, duration: r4(clipDuration(clip) + dt) };
  const ds = dt * (effSpeed(clip) || 1);
  if (clip.reverse && isVideoAsset(asset)) return { ...clip, in: r4(Math.max(0, finite(clip.in) - ds)) };
  return { ...clip, out: r4(finite(clip.out) + ds) };
}
/** 头部改变 dt 时间线秒（正=向前延长）；关键帧随之平移 */
function changeHead(clip, asset, dt) {
  const keys = shiftKeyTimes(clip.keys, dt);
  if (clip.still) return { ...clip, keys, duration: r4(clipDuration(clip) + dt) };
  const ds = dt * (effSpeed(clip) || 1);
  if (!isVideoAsset(asset)) return { ...clip, keys, out: r4(finite(clip.out) + ds) };
  if (clip.reverse) return { ...clip, keys, out: r4(Math.min(srcMax(asset), finite(clip.out) + ds)) };
  return { ...clip, keys, in: r4(Math.max(0, finite(clip.in) - ds)) };
}
function shiftKeyTimes(keys, dt) {
  if (!keys || typeof keys !== 'object' || !Object.keys(keys).length) return keys || {};
  const out = {};
  for (const [p, list] of Object.entries(keys)) {
    if (!Array.isArray(list)) continue;
    const l = list.map((k) => ({ ...k, t: r4(k.t + dt) })).filter((k) => k.t >= -EPS).map((k) => ({ ...k, t: Math.max(0, k.t) }));
    if (l.length) out[p] = l;
  }
  return out;
}
function withVideo(project, video) { return { ...project, tracks: { ...project.tracks, video } }; }
function checkUnlocked(clip, n) { if (clip && clip.locked) throw new Error(`第 ${n} 镜已锁定`); }
/** 轨道锁定的统一提示（C15）：kind video|text|audio|overlay，overlay 需给 n */
export function trackLockMessage(kind, n) {
  const name = kind === 'video' ? '主轨' : kind === 'text' ? '文字轨' : kind === 'audio' ? '音频轨' : `画中画 ${n || 1} 轨`;
  return `${name}已锁定，先在轨道头解锁再修改`;
}
function videoLocked(project) { if (trackFlags(project, 'video').locked) throw new Error(trackLockMessage('video')); }

/** 联动是否开启（timeline.linked 缺省为 true，PLAN-v3 R2） */
export function isLinked(project) {
  return !(project && project.timeline && project.timeline.linked === false);
}

function linkIdOf(item, key) {
  if (key === 'text') return item && item.linkShotId;
  return item && (item.linkClipId || item.linkedClipId);
}

const DROP = Object.freeze({ drop: true });

/** 镜头头部被裁掉的时间线秒数（正=裁掉，负=向前延长）；无法判断时返回 0 */
function headCutOf(project, cb, ca) {
  if (!cb || !ca || cb.still || ca.still) return 0;
  const asset = assetOf(project, cb);
  if (!isVideoAsset(asset)) return 0;
  const eb = effSpeed(cb) || 1;
  const ea = effSpeed(ca) || 1;
  if (Math.abs(eb - ea) > 1e-3) return 0; // 变速改动：不推断裁剪
  return cb.reverse ? (finite(cb.out) - finite(ca.out)) / eb : (finite(ca.in) - finite(cb.in)) / eb;
}

/**
 * 关联音频随镜头裁剪：音频与镜头内容保持相对位置，镜头被裁掉的部分对应的音频也裁掉。
 * 原本就伸出镜头之外的一侧不裁（例如提前进入的旁白）。
 */
function trimLinkedAudio(before, after, prev, cur, ob, oa) {
  const len = audioLength(prev);
  if (len <= 0) return null;
  const head = headCutOf(before, ob.clip, oa.clip);
  const shift = oa.start - head - ob.start; // 镜头内容原点的平移
  const s = finite(prev.start) + shift;
  const e = s + len;
  const lo = finite(prev.start) < ob.start - 0.05 ? -Infinity : oa.start;
  const hi = finite(prev.start) + len > ob.end + 0.05 ? Infinity : oa.end;
  const ns = Math.max(s, lo, 0);
  const ne = Math.min(e, hi);
  if (ne - ns < 0.05) return DROP;
  const inP = finite(prev.in) + (ns - s);
  return { ...cur, start: r4(ns), in: r4(inP), out: r4(inP + (ne - ns)) };
}

/**
 * 联动：主轨镜头在 before→after 之间发生的移动/裁剪/删除，同步到 linkShotId 文字与 linkClipId/linkedClipId 音频。
 * 关联对象一律以 before 中的位置为基准重新计算，避免与 shiftAfter 等已做的平移叠加。
 */
export function syncLinked(before, after) {
  const lb = layoutVideo(before);
  const la = layoutVideo(after);
  const changed = lb.length !== la.length || lb.some((it, i) => it.clip.id !== la[i].clip.id
    || Math.abs(it.start - la[i].start) > EPS || Math.abs(it.end - la[i].end) > EPS);
  if (!changed) return after;
  const spanB = new Map(lb.map((it) => [it.clip.id, it]));
  const spanA = new Map(la.map((it) => [it.clip.id, it]));
  const grew = la.length > lb.length;
  const sync = (key) => {
    const list = key === 'text' ? textTrack(after) : audioTrack(after);
    // 锁定的轨道不跟随（与轨道头的锁一致：锁住的内容任何操作都不动它）
    if (trackFlags(after, key).locked) return list;
    const prevById = new Map((key === 'text' ? textTrack(before) : audioTrack(before)).map((x) => [x.id, x]));
    const out = [];
    let touched = false;
    for (const cur of list) {
      const link = linkIdOf(cur, key);
      const prev = prevById.get(cur.id);
      const ob = link && spanB.get(link);
      if (!link || !prev || !ob || cur.locked) { out.push(cur); continue; }
      const oa = spanA.get(link);
      if (!oa) { touched = true; continue; } // 关联镜头被删除：一并删除
      const delta = oa.start - ob.start;
      let next = { ...cur, start: r4(Math.max(0, finite(prev.start) + delta)) };
      if (key === 'text') {
        const pd = finite(prev.duration);
        const aligned = Math.abs(finite(prev.start) - ob.start) < 0.05 && Math.abs(finite(prev.start) + pd - ob.end) < 0.05;
        if (aligned && !grew) next = { ...next, start: r4(oa.start), duration: r4(Math.max(0.1, oa.end - oa.start)) };
        else next.duration = grew ? cur.duration : prev.duration;
      } else if (!grew) {
        next = trimLinkedAudio(before, after, prev, cur, ob, oa) || next;
        if (next === DROP) { touched = true; continue; }
      }
      if (next.start !== cur.start || next.duration !== cur.duration || next.in !== cur.in || next.out !== cur.out) touched = true;
      out.push(next);
    }
    return touched ? out : list;
  };
  const text = sync('text');
  const audio = sync('audio');
  if (text === textTrack(after) && audio === audioTrack(after)) return after;
  return { ...after, tracks: { ...after.tracks, text, audio } };
}

/** 时间线上 from 之后（含）的文字、音频、画中画、标记整体平移 delta 秒；锁定的片段和锁定的轨道不动 */
export function shiftAfter(project, from, delta) {
  if (!delta) return project;
  const mv = (s) => (finite(s) >= from - EPS ? r4(Math.max(0, finite(s) + delta)) : s);
  const tracks = project.tracks || {};
  const textLocked = trackFlags(project, 'text').locked;
  const audioLocked = trackFlags(project, 'audio').locked;
  const overlayLocked = (o) => trackFlags(project, 'overlay', o.track || 1).locked;
  return {
    ...project,
    tracks: {
      ...tracks,
      text: textLocked ? textTrack(project) : textTrack(project).map((t) => (t.locked ? t : { ...t, start: mv(t.start) })),
      audio: audioLocked ? audioTrack(project) : audioTrack(project).map((a) => (a.locked ? a : { ...a, start: mv(a.start) })),
    },
    overlays: overlayList(project).map((o) => (o.locked || overlayLocked(o) ? o : { ...o, start: mv(o.start) })),
    markers: (Array.isArray(project.markers) ? project.markers : []).map((m) => ({ ...m, t: mv(m.t) })),
  };
}

/** 找到离 at 最近的剪辑点：返回后一镜索引 i（1..n-1），没有剪辑点返回 -1 */
export function nearestCut(layout, at) {
  let best = -1;
  for (let i = 1; i < (layout || []).length; i += 1) {
    if (best < 0 || Math.abs(layout[i].start - at) < Math.abs(layout[best].start - at)) best = i;
  }
  return best;
}

function twoSidedClamp(project, prev, next, delta) {
  const ap = assetOf(project, prev);
  const an = assetOf(project, next);
  const dp = clipDuration(prev);
  const dn = clipDuration(next);
  const hi = Math.min(tailRoom(prev, ap), dn - MIN_CLIP);
  const lo = -Math.min(dp - MIN_CLIP, headRoom(next, an));
  return Math.min(Math.max(finite(delta), Math.min(0, lo)), Math.max(0, hi));
}

/** 滚动编辑：剪辑点 at 前后两镜此消彼长，总时长不变。返回 { project, delta, index } */
export function rollEdit(project, at, delta) {
  videoLocked(project);
  const layout = layoutVideo(project);
  const i = nearestCut(layout, finite(at));
  if (i < 0) throw new Error('至少需要两个镜头才能滚动剪辑点');
  const video = [...videoTrack(project)];
  const prev = video[i - 1];
  const next = video[i];
  checkUnlocked(prev, i); checkUnlocked(next, i + 1);
  const d = twoSidedClamp(project, prev, next, delta);
  if (Math.abs(d) < 1e-4) throw new Error('剪辑点已到素材边界，无法继续滚动');
  video[i - 1] = changeTail(prev, assetOf(project, prev), d);
  video[i] = changeHead(next, assetOf(project, next), -d);
  return { project: withVideo(project, video), delta: r4(d), index: i };
}

/** 内滑（slip）：时间线位置和时长不变，只平移素材取景段 delta 源秒。 */
export function slipEdit(project, id, delta) {
  videoLocked(project);
  const video = [...videoTrack(project)];
  const i = video.findIndex((c) => c.id === id);
  if (i < 0) throw new Error('找不到要内滑的镜头');
  const clip = video[i];
  checkUnlocked(clip, i + 1);
  const asset = assetOf(project, clip);
  if (!isVideoAsset(asset)) throw new Error('图片镜头没有可内滑的素材范围');
  const max = srcMax(asset);
  const lo = -finite(clip.in);
  const hi = clip.still ? max - finite(clip.in) : max - finite(clip.out);
  const d = Math.min(Math.max(finite(delta), lo), hi);
  if (Math.abs(d) < 1e-4) throw new Error('已到素材边界，无法继续内滑');
  video[i] = { ...clip, in: r4(finite(clip.in) + d), out: r4(finite(clip.out) + d) };
  return { project: withVideo(project, video), delta: r4(d) };
}

/** 外滑（slide）：镜头内容不变，在前后两镜之间移动 delta 秒（前一镜变长/短，后一镜相应变短/长）。 */
export function slideEdit(project, id, delta) {
  videoLocked(project);
  const video = [...videoTrack(project)];
  const i = video.findIndex((c) => c.id === id);
  if (i < 0) throw new Error('找不到要外滑的镜头');
  if (i === 0 || i === video.length - 1) throw new Error('外滑需要镜头前后都有相邻镜头');
  const prev = video[i - 1];
  const clip = video[i];
  const next = video[i + 1];
  checkUnlocked(prev, i); checkUnlocked(clip, i + 1); checkUnlocked(next, i + 2);
  const d = twoSidedClamp(project, prev, next, delta);
  if (Math.abs(d) < 1e-4) throw new Error('相邻镜头已到边界，无法继续外滑');
  video[i - 1] = changeTail(prev, assetOf(project, prev), d);
  video[i + 1] = changeHead(next, assetOf(project, next), -d);
  return { project: withVideo(project, video), delta: r4(d) };
}

/**
 * 波纹删除：删除 ids（主轨镜头 / 文字 / 音频 / 画中画），主轨删除留下的空隙由后面所有轨道内容一起前移填补。
 */
export function rippleDelete(project, ids) {
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  if (!set.size) throw new Error('没有要删除的内容');
  const layout = layoutVideo(project);
  const spans = layout.filter((it) => set.has(it.clip.id));
  if (spans.length) videoLocked(project);
  spans.forEach((it) => checkUnlocked(it.clip, it.index + 1));
  if (spans.length && spans.length >= layout.length) throw new Error('至少要保留 1 个镜头，不能全部删除');
  // 文字 / 音频 / 画中画：片段自身或所在轨道锁定时不能删
  const texts = textTrack(project).filter((t) => set.has(t.id));
  if (texts.length && trackFlags(project, 'text').locked) throw new Error(trackLockMessage('text'));
  const lockedText = texts.find((t) => t.locked);
  if (lockedText) throw new Error(`文字「${String(lockedText.text || '').slice(0, 12)}」已锁定`);
  const audios = audioTrack(project).filter((a) => set.has(a.id));
  if (audios.length && trackFlags(project, 'audio').locked) throw new Error(trackLockMessage('audio'));
  if (audios.some((a) => a.locked)) throw new Error('这段音频已锁定');
  for (const o of overlayList(project)) {
    if (!set.has(o.id)) continue;
    if (trackFlags(project, 'overlay', o.track || 1).locked) throw new Error(trackLockMessage('overlay', o.track || 1));
    if (o.locked) throw new Error('这个画中画已锁定');
  }
  let next = project;
  // 从后往前平移，避免前面的平移影响后面的判断
  for (const it of [...spans].sort((a, b) => b.start - a.start)) {
    const removed = it.end - it.start - (layout[it.index + 1] ? layout[it.index + 1].overlap : 0);
    next = shiftAfter(next, it.end - EPS, -Math.max(0, removed));
  }
  const found = spans.length
    + textTrack(project).filter((t) => set.has(t.id)).length
    + audioTrack(project).filter((a) => set.has(a.id)).length
    + overlayList(project).filter((o) => set.has(o.id)).length;
  if (!found) throw new Error('找不到要删除的内容，它可能已被删除');
  return {
    ...next,
    tracks: {
      ...next.tracks,
      video: videoTrack(next).filter((c) => !set.has(c.id)),
      text: textTrack(next).filter((t) => !set.has(t.id)),
      audio: audioTrack(next).filter((a) => !set.has(a.id)),
    },
    overlays: overlayList(next).filter((o) => !set.has(o.id)),
  };
}

function itemAtForTrim(project, t) {
  const layout = layoutVideo(project);
  const time = finite(t);
  for (let i = layout.length - 1; i >= 0; i -= 1) {
    const it = layout[i];
    if (time > it.start + EPS && time < it.end - EPS) return it;
  }
  return null;
}

/** 把片段切成本地 [a,b] 段（正确处理 still / reverse / speedCurve / 关键帧） */
export function subClip(clip, a, b) {
  const dur = clipDuration(clip);
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(dur, Math.max(a, b));
  const keys = shiftKeyTimes(clip.keys, -lo);
  const keysTrim = {};
  for (const [p, l] of Object.entries(keys || {})) { const f = l.filter((k) => k.t <= hi - lo + EPS); if (f.length) keysTrim[p] = f; }
  if (clip.still) return { ...clip, duration: r4(hi - lo), keys: keysTrim };
  const s0 = sourceTimeAt({ ...clip, reverse: false }, lo);
  const s1 = hi >= dur - EPS ? finite(clip.out) : sourceTimeAt({ ...clip, reverse: false }, hi);
  const next = { ...clip, keys: keysTrim };
  if (validCurve(clip.speedCurve) && dur > 0) next.speedCurve = sliceCurve(clip.speedCurve, lo / dur, hi / dur);
  const len = finite(clip.out) - finite(clip.in);
  if (clip.reverse) {
    // reverse 的时间线前段对应源的后段
    next.out = r4(finite(clip.out) - (s0 - finite(clip.in)));
    next.in = r4(finite(clip.out) - (s1 - finite(clip.in)));
  } else {
    next.in = r4(s0);
    next.out = r4(Math.min(finite(clip.in) + len, s1));
  }
  return next;
}

/** Q：删除播放头左侧（片段开头到 t）部分，后续内容前移。 */
export function trimLeftAt(project, t) {
  videoLocked(project);
  const it = itemAtForTrim(project, t);
  if (!it) throw new Error('播放头不在任何镜头内部');
  checkUnlocked(it.clip, it.index + 1);
  const cut = finite(t) - it.start;
  if (it.duration - cut < MIN_CLIP - EPS) throw new Error(`剩余部分不足 ${MIN_CLIP} 秒`);
  const video = [...videoTrack(project)];
  video[it.index] = subClip(it.clip, cut, it.duration);
  return shiftAfter(withVideo(project, video), finite(t) - EPS, -cut);
}

/** W：删除播放头右侧（t 到片段结尾）部分，后续内容前移。 */
export function trimRightAt(project, t) {
  videoLocked(project);
  const it = itemAtForTrim(project, t);
  if (!it) throw new Error('播放头不在任何镜头内部');
  checkUnlocked(it.clip, it.index + 1);
  const keep = finite(t) - it.start;
  if (keep < MIN_CLIP - EPS) throw new Error(`保留部分不足 ${MIN_CLIP} 秒`);
  const removed = it.duration - keep;
  const video = [...videoTrack(project)];
  video[it.index] = subClip(it.clip, 0, keep);
  return shiftAfter(withVideo(project, video), it.end - EPS, -removed);
}

// ---------------------------------------------------------------------------
// 自动闪避（人声出现时压低背景音乐）
// ---------------------------------------------------------------------------
function mergeIntervals(list, gap) {
  const sorted = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1] + gap) last[1] = Math.max(last[1], iv[1]);
    else out.push([...iv]);
  }
  return out;
}

/**
 * 人声区间：role='voice' 的音频；没有人声音频时退回到带原声且未静音的主轨镜头。
 * 返回 { [musicAudioId]: volumeKeys }，volumeKeys 为相对倍率 [{t（片段本地秒）, v 0..1}]；无人声重叠时为 []。
 */
export function autoDuck(project, { amount = 0.25, attack = 0.2, release = 0.4 } = {}) {
  const level = Math.min(1, Math.max(0, finite(amount, 0.25)));
  const att = Math.max(0, finite(attack, 0.2));
  const rel = Math.max(0, finite(release, 0.4));
  const assets = (project && project.assets) || {};
  let voice = audioTrack(project).filter((a) => a.role === 'voice' && !a.muted).map((a) => [finite(a.start), audioEnd(a)]);
  if (!voice.length) {
    voice = layoutVideo(project)
      .filter((it) => { const as = assets[it.clip.assetId]; return as && as.hasAudio && !it.clip.mute && !it.clip.muted && finite(it.clip.volume, 1) > 0; })
      .map((it) => [it.start, it.end]);
  }
  const ivs = mergeIntervals(voice, att + rel);
  const result = {};
  for (const a of audioTrack(project)) {
    if (a.role === 'voice' || a.role === 'sfx') continue;
    const s = finite(a.start);
    const len = audioLength(a);
    const keys = [];
    for (const [v0, v1] of ivs) {
      if (v1 <= s || v0 >= s + len) continue;
      const pts = [[v0 - att, 1], [v0, level], [v1, level], [v1 + rel, 1]];
      for (const [t, v] of pts) {
        const lt = r4(Math.min(len, Math.max(0, t - s)));
        const prev = keys[keys.length - 1];
        if (prev && Math.abs(prev.t - lt) < 1e-3) prev.v = Math.min(prev.v, v);
        else keys.push({ t: lt, v });
      }
    }
    result[a.id] = keys;
  }
  return result;
}

/** 音频 volumeKeys 在本地时刻 t 的倍率（线性插值，无关键帧为 1） */
export function volumeKeyAt(volumeKeys, t) {
  if (!Array.isArray(volumeKeys) || !volumeKeys.length) return 1;
  const time = finite(t);
  if (time <= volumeKeys[0].t) return finite(volumeKeys[0].v, 1);
  for (let i = 0; i < volumeKeys.length - 1; i += 1) {
    const a = volumeKeys[i]; const b = volumeKeys[i + 1];
    if (time <= b.t) return b.t > a.t ? a.v + (b.v - a.v) * ((time - a.t) / (b.t - a.t)) : b.v;
  }
  return finite(volumeKeys[volumeKeys.length - 1].v, 1);
}