// 属性面板的数值小工具（纯函数，node 可测，不依赖 React / store）：
//   数字解析（全角、单位、分:秒）、步进微调与夹取、带「输入/解析」的显示格式、片段时长显示、
//   文字「字号」与倍数互换、节拍数据整理与描述、关键帧列表增改、播放头 → 片段本地时间。
// 测试：tests/inspector-value.test.mjs

// ---------------- 数字解析 ----------------

/** 全角字符转半角；中文句号、各种减号统一成 . 和 - */
export function toHalfWidth(s) {
  return String(s == null ? '' : s)
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ')
    .replace(/。/g, '.')
    .replace(/[−‒–—﹣]/g, '-');
}

/** 从输入文字里取出第一个数字：「120%」→120、「×1.5」→1.5、「－３」→-3；取不到返回 null */
export function parseNum(text) {
  const s = toHalfWidth(text).replace(/,/g, '').trim();
  if (!s) return null;
  const m = s.match(/[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?/i);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** 秒数输入：支持「65.5」「1:05.5」「1:02:03」「1分30秒」「2.5秒」；取不到返回 null */
export function parseSeconds(text) {
  const s = toHalfWidth(text).replace(/\s+/g, '');
  if (!s) return null;
  const neg = s.startsWith('-');
  const body = s.replace(/^[-+]/, '');
  const sign = (v) => (neg ? -v : v);
  let m = body.match(/^(\d+):(\d+):(\d+(?:\.\d*)?)$/);
  if (m) return sign(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
  m = body.match(/^(\d+):(\d+(?:\.\d*)?)$/);
  if (m) return sign(Number(m[1]) * 60 + Number(m[2]));
  m = body.match(/^(\d+(?:\.\d*)?)分钟?(?:(\d+(?:\.\d*)?)秒?)?$/);
  if (m) return sign(Number(m[1]) * 60 + (m[2] ? Number(m[2]) : 0));
  return parseNum(s);
}

// ---------------- 步进与夹取 ----------------

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 夹到 [min,max]；min/max 不是有限数字时视为不限 */
export function clamp(v, min, max) {
  const n = Number(v);
  const lo = isNum(min) ? min : -Infinity;
  const hi = isNum(max) ? max : Infinity;
  if (!Number.isFinite(n)) return Number.isFinite(lo) ? lo : 0;
  return Math.min(hi, Math.max(lo, n));
}

/** 步长的小数位数：0.05 → 2，1 → 0，1e-3 → 3 */
export function stepDecimals(step) {
  const s = String(Math.abs(Number(step)) || 0);
  const e = s.match(/e-(\d+)$/i);
  if (e) return Number(e[1]);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/** 最多保留 digits 位小数并去掉末尾 0：1.50 → "1.5"，-0 → "0" */
export function trimNum(n, digits = 2) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  const f = 10 ** Math.max(0, Math.min(10, digits));
  const r = Math.round(v * f) / f;
  return String(Object.is(r, -0) ? 0 : r);
}

/** 方向键微调：dir=+1/-1，big（按住 Shift）时 10 倍步长；结果夹到范围内并去掉浮点尾差 */
export function nudge(v, dir, step = 0.01, big = false, min, max) {
  const s = Math.abs(Number(step)) || 0.01;
  const raw = (Number(v) || 0) + Math.sign(Number(dir) || 0) * s * (big ? 10 : 1);
  return clamp(Number(raw.toFixed(Math.min(10, stepDecimals(s) + 4))), min, max);
}

export const nearlyEqual = (a, b, eps = 1e-9) => Math.abs((Number(a) || 0) - (Number(b) || 0)) <= eps;

// ---------------- 显示格式 ----------------

/**
 * 生成显示格式 fmt(v) → 显示文字，并附带：
 *   fmt.edit(v)  → 点开数值时输入框里的文字（按显示单位，不带单位符号）
 *   fmt.parse(s) → 输入框文字 → 参数值（无法解析返回 null）
 *   fmt.unit     → 输入框后面显示的单位
 * scale：显示单位 = 参数值 × scale（百分比为 100）。toEdit/fromEdit 可自定义换算（如变速的对数刻度）。
 */
export function makeFormat(show, { scale = 1, digits = 2, unit = '', toEdit, fromEdit, parse = parseNum } = {}) {
  const fmt = (v) => show(Number(v) || 0);
  const to = toEdit || ((v) => v * scale);
  const from = fromEdit || ((n) => n / scale);
  fmt.edit = (v) => trimNum(to(Number(v) || 0), digits);
  fmt.parse = (s) => { const n = parse(s); return n == null ? null : from(n); };
  fmt.unit = unit;
  return fmt;
}

const r2 = (v) => Math.round(v * 100) / 100;
const fixed2 = (v) => (Object.is(r2(v), -0) ? 0 : r2(v)).toFixed(2);

export const FMT = {
  signed: makeFormat((v) => (r2(v) > 0 ? '+' : '') + fixed2(v), { digits: 3 }),
  pct: makeFormat((v) => `${Math.round(v * 100)}%`, { scale: 100, digits: 1, unit: '%' }),
  sec: makeFormat((v) => `${fixed2(v)} 秒`, { digits: 2, unit: '秒', parse: parseSeconds }),
  times: makeFormat((v) => `×${fixed2(v)}`, { digits: 2, unit: '×' }),
  deg: makeFormat((v) => `${Math.round(v)}°`, { digits: 1, unit: '°' }),
  px: makeFormat((v) => `${Math.round(v)} px`, { digits: 0, unit: 'px' }),
  px1: makeFormat((v) => `${(Math.round(v * 10) / 10).toFixed(1)} px`, { digits: 1, unit: 'px' }),
  int: makeFormat((v) => String(Math.round(v)), { digits: 0 }),
};

/** 片段时长：一位小数「2.2 秒」；满一分钟「1 分 05.3 秒」 */
export function fmtSecs(v) {
  const t = Math.round(Math.max(0, Number(v) || 0) * 10) / 10;
  if (t < 60) return `${t.toFixed(1)} 秒`;
  const m = Math.floor(t / 60);
  const s = Math.round((t - m * 60) * 10) / 10;
  return `${m} 分 ${s.toFixed(1).padStart(4, '0')} 秒`;
}

/** 颜色输入规范化：「#ABC」「abc」「#aabbcc」「ＡＢＣ」→「#aabbcc」，非法返回 null */
export function normHex(s) {
  const t = toHalfWidth(s).trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(t)) return '#' + t.split('').map((c) => c + c).join('');
  if (/^[0-9a-f]{6}$/.test(t)) return '#' + t;
  return null;
}

// ---------------- 文字字号 ----------------

/** 各文字预设的基准字高（相对画面短边），与 src/render/text.js 的 PRESET_METRICS 保持一致 */
export const TEXT_PRESET_SIZE = {
  title: 0.092, subtitle: 0.05, 'lower-third': 0.042, 'caption-box': 0.044, 'big-bold': 0.12, handwrite: 0.08, neon: 0.09,
};
/** 字号以 1080p 画面为准：字号 = 1080p 成片里文字的像素高度，和分辨率无关 */
export const FONT_REF = 1080;
const presetBase = (preset) => FONT_REF * (TEXT_PRESET_SIZE[preset] || TEXT_PRESET_SIZE.title);

/** 文字倍数（text.size，缺省 1）→ 整数字号 */
export function sizeToPt(size, preset) {
  const rel = Number(size) > 0 ? Number(size) : 1;
  return Math.max(1, Math.round(presetBase(preset) * rel));
}

/** 整数字号 → 文字倍数（4 位小数）；正好是预设默认字号时返回 1 */
export function ptToSize(pt, preset) {
  const n = Number(pt);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (Math.round(n) === Math.round(presetBase(preset))) return 1;
  return Math.round((n / presetBase(preset)) * 10000) / 10000;
}

/** 字号滑杆范围（对应倍数 lo..hi）与默认字号 */
export function ptRange(preset, lo = 0.3, hi = 3) {
  const b = presetBase(preset);
  return { min: Math.ceil(b * lo), max: Math.floor(b * hi), def: Math.round(b) };
}

// ---------------- 节拍 ----------------

/** 置信度低于这个值视为「没有明显节拍」 */
export const BEAT_MIN_CONFIDENCE = 0.3;

/** 由节拍时刻估算每分钟拍数（相邻间隔的中位数）；不足 4 拍或间隔不稳定时返回 null */
export function bpmFromBeats(beats) {
  if (!Array.isArray(beats) || beats.length < 4) return null;
  const gaps = [];
  for (let i = 1; i < beats.length; i += 1) {
    const g = beats[i] - beats[i - 1];
    if (g > 0.2 && g < 2) gaps.push(g);
  }
  if (gaps.length < 3) return null;
  gaps.sort((a, b) => a - b);
  const med = gaps[Math.floor(gaps.length / 2)];
  return med > 0 ? Math.round((60 / med) * 10) / 10 : null;
}

/**
 * 整理节拍检测结果：接受旧格式（秒数数组）和新格式 { beats, bpm | tempo, confidence }
 * （tempo 也可以是 { bpm, confidence }）。返回 { beats(升序、去非法), bpm|null, confidence|null, noTempo }。
 * 新格式明确给出 bpm:null（检测器认为没有明显节拍）时 noTempo=true，也不再用节拍间隔去估算每分钟拍数。
 */
export function normalizeBeats(raw) {
  const src = Array.isArray(raw) ? { beats: raw } : (raw && typeof raw === 'object' ? raw : {});
  const beats = (Array.isArray(src.beats) ? src.beats : [])
    .map(Number).filter((t) => Number.isFinite(t) && t >= 0).sort((a, b) => a - b);
  const tempo = src.tempo && typeof src.tempo === 'object' ? src.tempo : null;
  const given = tempo ? tempo.bpm : (Object.prototype.hasOwnProperty.call(src, 'bpm') ? src.bpm : src.tempo);
  const noTempo = given === null;
  let bpm = Number(given);
  if (!(bpm > 0)) bpm = noTempo ? 0 : (bpmFromBeats(beats) || 0);
  const confRaw = tempo && tempo.confidence != null ? tempo.confidence : src.confidence;
  const confidence = confRaw == null || !Number.isFinite(Number(confRaw)) ? null : Number(confRaw);
  return { beats, bpm: bpm > 0 ? Math.round(bpm * 10) / 10 : null, confidence, noTempo };
}

/**
 * 素材的节拍状态（给「踩点」入口用）：
 *   unknown —— 还没分析过；none —— 分析过但没有明显节拍（拍子太少、置信度低或检测器给出 bpm:null）；ok —— 可以踩点
 */
export function beatInfo(asset) {
  if (!asset) return { status: 'unknown', beats: [], bpm: null, confidence: null, noTempo: false };
  const analyzed = Array.isArray(asset.beats) || asset.tempo != null;
  if (!analyzed) return { status: 'unknown', beats: [], bpm: null, confidence: null, noTempo: false };
  const info = normalizeBeats({ beats: asset.beats, tempo: asset.tempo });
  const weak = info.noTempo || (info.confidence != null && info.confidence < BEAT_MIN_CONFIDENCE);
  return { ...info, status: info.beats.length >= 2 && !weak ? 'ok' : 'none' };
}

/** 节拍的一句话描述：「每分钟约 120 拍 · 共 64 拍」/「没有明显节拍」/「还没分析节拍」 */
export function describeBeats(info) {
  if (!info || info.status === 'unknown') return '还没分析节拍';
  if (info.status === 'none') return '没有明显节拍';
  const parts = [];
  if (info.bpm) parts.push(`每分钟约 ${Math.round(info.bpm)} 拍`);
  parts.push(`共 ${info.beats.length} 拍`);
  return parts.join(' · ');
}

/** 从踩点 op 的结果里取出移动了几个剪辑点（applied 里带「已对齐 N 个剪辑点」）；取不到返回 null */
export function movedCuts(result) {
  const list = result && Array.isArray(result.applied) ? result.applied : [];
  for (const s of list) {
    const m = String(s).match(/已对齐\s*(\d+)\s*个剪辑点/);
    if (m) return Number(m[1]);
  }
  return null;
}

// ---------------- 关键帧 ----------------

/** 关键帧列表里设置 t 处的值：同一时刻（±eps）已有则只改值、保留缓动；返回升序新列表。audio=true 不写缓动 */
export function upsertKey(list, t, v, { ease = 'ease', eps = 1 / 120, audio = false } = {}) {
  const time = Math.max(0, Math.round((Number(t) || 0) * 1000) / 1000);
  const arr = Array.isArray(list) ? list : [];
  const i = arr.findIndex((k) => Math.abs(k.t - time) <= eps);
  if (i >= 0) {
    const next = [...arr];
    next[i] = { ...arr[i], v };
    return next;
  }
  return [...arr, audio ? { t: time, v } : { t: time, v, ease }].sort((a, b) => a.t - b.t);
}

/**
 * 播放头 → 片段本地时间。inside：播放头是否落在片段上；不在时 lt 夹到片段内（末端留 1 帧，避免落到下一个片段）。
 */
export function localTime(playhead, start, dur, fps = 30) {
  const d = Math.max(0, Number(dur) || 0);
  const raw = (Number(playhead) || 0) - (Number(start) || 0);
  const inside = raw >= -1e-6 && raw < d - 1e-6;
  const hi = Math.max(0, d - 1 / (Number(fps) > 0 ? Number(fps) : 30));
  return { lt: inside ? Math.max(0, raw) : Math.min(hi, Math.max(0, raw)), inside };
}
