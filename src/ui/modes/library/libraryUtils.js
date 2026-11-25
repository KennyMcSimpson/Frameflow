// 拆片库纯函数工具：URL 提取、分类猜测、统计描述、刻度计算、数据规范化。
// 不依赖 DOM / store / api，node 可测（tests/libraryUtils.test.mjs）。
import { uid } from '../../../engine/ids.js';

export const TECHNIQUE_CATEGORY_KEYS = ['transition', 'lighting', 'camera', 'rhythm', 'composition', 'color', 'dialogue', 'vfx', 'product', 'narrative', 'sound'];
export const ANALYSIS_CATEGORY_KEYS = ['film', 'tutorial', 'interview', 'short', 'ad', 'vfx', 'other'];

export const PLATFORM_LABELS = {
  bilibili: 'B站', youtube: 'YouTube', douyin: '抖音', kuaishou: '快手', xiaohongshu: '小红书', vimeo: 'Vimeo', weibo: '微博', other: '网页',
};

const n01 = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : d; };
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// ------------------------------------------------------------------
// URL 提取
// ------------------------------------------------------------------
const STOP = '\\s"\'<>，。！？、；：（）【】《》「」『』“”‘’';
const URL_RE = new RegExp(`https?:\\/\\/[^${STOP}]+`, 'gi');
const BARE_RE = new RegExp(`(?:^|[^\\w./:])((?:www\\.|m\\.|v\\.)?(?:bilibili\\.com|b23\\.tv|youtube\\.com|youtu\\.be|douyin\\.com|iesdouyin\\.com|xhslink\\.com|xiaohongshu\\.com|kuaishou\\.com|vimeo\\.com)\\/[^${STOP}]+)`, 'gi');
const BV_RE = /(?:^|[^0-9A-Za-z])(BV[0-9A-Za-z]{10})(?![0-9A-Za-z])/g;

function cleanUrl(u) {
  return String(u || '').replace(/[)\].,!?;:'"]+$/g, '').replace(/[，。！？]+$/g, '');
}

/** 根据 URL 判断平台 */
export function detectPlatform(url) {
  const u = String(url || '').toLowerCase();
  if (/bilibili\.com|b23\.tv/.test(u)) return 'bilibili';
  if (/youtube\.com|youtu\.be/.test(u)) return 'youtube';
  if (/douyin\.com|iesdouyin\.com/.test(u)) return 'douyin';
  if (/kuaishou\.com|gifshow\.com/.test(u)) return 'kuaishou';
  if (/xiaohongshu\.com|xhslink\.com/.test(u)) return 'xiaohongshu';
  if (/vimeo\.com/.test(u)) return 'vimeo';
  if (/weibo\.com|weibo\.cn/.test(u)) return 'weibo';
  return 'other';
}

/** 从分享文本里猜标题（B站「【标题-哔哩哔哩】」、抖音「【xx的作品】标题 #话题」） */
function guessTitleFromLine(line, url) {
  const text = String(line || '');
  const m = /【([^】]{1,120})】/.exec(text);
  let title = '';
  if (m) {
    title = m[1].replace(/[-_\s]*(哔哩哔哩|bilibili)[_\s-]*(bilibili)?$/i, '').trim();
    if (/的作品$/.test(title)) {
      const after = text.slice(m.index + m[0].length);
      const cut = after.split(/https?:\/\/|#|复制此链接|打开抖音/)[0].replace(/\s+/g, ' ').trim();
      if (cut.length >= 2) title = cut;
    }
  } else {
    const rest = text.replace(url, ' ').replace(URL_RE, ' ').replace(/\s+/g, ' ').trim();
    if (rest.length >= 2 && rest.length <= 80 && !/^[\d\s.:/]+$/.test(rest) && !/复制|打开|看看/.test(rest)) title = rest;
  }
  title = title.replace(/^\d+\.\d+\s+/, '').trim();
  return title.length >= 2 ? title.slice(0, 120) : '';
}

/**
 * 从任意文本提取视频链接（每行可以是纯链接，也可以是 B站/YouTube/抖音 的分享文本）。
 * @returns {{url:string, platform:string, title:string}[]} 去重
 */
export function extractUrls(text) {
  const out = [];
  const seen = new Set();
  const push = (url, line) => {
    const u = cleanUrl(url);
    if (!u || u.length < 12) return;
    const key = u.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url: u, platform: detectPlatform(u), title: guessTitleFromLine(line, url) });
  };
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let found = false;
    for (const m of line.matchAll(URL_RE)) { push(m[0], line); found = true; }
    if (!found) {
      for (const m of line.matchAll(BARE_RE)) { push('https://' + m[1], line); found = true; }
    }
    if (!found) {
      for (const m of line.matchAll(BV_RE)) { push(`https://www.bilibili.com/video/${m[1]}`, line); found = true; }
    }
  }
  return out;
}

/** 根据主题文字猜测拆片分类 */
export function guessCategory(topic) {
  const t = String(topic || '').toLowerCase();
  if (!t.trim()) return 'other';
  if (/教程|教学|怎么拍|如何拍|技巧|入门|干货|攻略|tutorial|how to|howto|教你|学会/.test(t)) return 'tutorial';
  if (/访谈|采访|对谈|专访|幕后|interview|演员谈/.test(t)) return 'interview';
  if (/电影|影片|大片|片段|名场面|导演|film|movie|cinema|预告/.test(t)) return 'film';
  if (/特效|vfx|cg|ai视频|ai 视频|ai生成|合成|motion graphics|mg动画/.test(t)) return 'vfx';
  if (/广告|宣传片|商业片|tvc|commercial|品牌片/.test(t)) return 'ad';
  if (/短视频|抖音|快手|vlog|reels|shorts|小红书|口播/.test(t)) return 'short';
  if (/产品|开箱|种草|带货|测评/.test(t)) return 'ad';
  return 'other';
}

// ------------------------------------------------------------------
// 数值 / 时间 格式
// ------------------------------------------------------------------
/** 秒 → 「2.4 秒」/「3 分 12 秒」 */
export function fmtSec(s, digits = 1) {
  const v = Math.max(0, num(s, 0));
  if (v < 60) return `${v.toFixed(digits).replace(/\.0+$/, '')} 秒`;
  const m = Math.floor(v / 60);
  const r = Math.round(v - m * 60);
  if (m >= 60) { const h = Math.floor(m / 60); return `${h} 小时 ${m % 60} 分`; }
  return r ? `${m} 分 ${r} 秒` : `${m} 分钟`;
}

/** 秒 → 「m:ss」紧凑格式 */
export function fmtClock(s) {
  const v = Math.max(0, Math.round(num(s, 0)));
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const sec = v % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

export function pct(v) { return `${Math.round(n01(v) * 100)}%`; }

/** ISO 时间 → 「今天 14:20」「昨天」「2026-03-02」 */
export function fmtDate(iso, now = new Date()) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  const pad = (x) => String(x).padStart(2, '0');
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, now)) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 坐标轴「好看」的步长（1/2/5 × 10^k） */
export function niceStep(max, targetCount = 4) {
  const m = num(max, 0);
  if (m <= 0) return 1;
  const raw = m / Math.max(1, targetCount);
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  const k = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return k * p;
}

/** 返回 0..max 的刻度 */
export function niceTicks(max, targetCount = 4) {
  const step = niceStep(max, targetCount);
  const ticks = [];
  for (let v = 0; v <= max + 1e-9 && ticks.length < 50; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return ticks;
}

/** 时间轴刻度步长（秒），保证相邻刻度至少 minPx 像素 */
export function timeStep(duration, widthPx, minPx = 70) {
  const d = num(duration, 0);
  const w = Math.max(1, num(widthPx, 1));
  const cands = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  for (const c of cands) if ((d / c) * minPx <= w) return c;
  return cands[cands.length - 1];
}

export function validHex(c) { return typeof c === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c.trim()); }

/** 运动强度分档 0 低 / 1 中 / 2 高 */
export function motionLevel(m) { const v = n01(m); return v < 0.33 ? 0 : v < 0.66 ? 1 : 2; }
export const MOTION_LEVEL_LABELS = ['低运动', '中运动', '高运动'];

// ------------------------------------------------------------------
// 统计描述
// ------------------------------------------------------------------
/** 整体色调描述，如「偏暖、中等饱和、低调」 */
export function describeTone(cs) {
  if (!cs || typeof cs !== 'object') return '暂无色彩数据';
  const parts = [];
  const w = num(cs.warmth, 0);
  parts.push(w > 0.06 ? '偏暖' : w < -0.06 ? '偏冷' : '色温中性');
  const s = n01(cs.saturation, 0);
  parts.push(s < 0.22 ? '低饱和' : s < 0.45 ? '中等饱和' : '高饱和');
  const l = n01(cs.luma, 0.5);
  parts.push(l < 0.36 ? '低调' : l > 0.62 ? '高调' : '中间调');
  const c = n01(cs.contrast, 0.35);
  if (c > 0.5) parts.push('高反差');
  else if (c < 0.22) parts.push('低反差');
  return parts.join('、');
}

/** 剪辑节奏描述 */
export function describeRhythm(avgShot) {
  const a = num(avgShot, 0);
  if (a <= 0) return '暂无节奏数据';
  if (a < 1.5) return '极快（卡点/快剪风格）';
  if (a < 3) return '快节奏（短视频常见）';
  if (a < 6) return '中等节奏（叙事流畅）';
  if (a < 12) return '舒缓（注重氛围）';
  return '长镜头为主（沉浸、克制）';
}

/** 从镜头列表计算节奏（主进程数据缺失时兜底） */
export function computeRhythm(shots, totalDuration) {
  const durations = (shots || []).map((s) => Math.max(0, num(s.duration, num(s.end, 0) - num(s.start, 0))));
  const n = durations.length;
  if (!n) return { avgShot: 0, medianShot: 0, cutsPerMinute: 0, durations: [] };
  const sum = durations.reduce((a, b) => a + b, 0);
  const sorted = [...durations].sort((a, b) => a - b);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const total = num(totalDuration, 0) > 0 ? num(totalDuration, 0) : sum;
  return {
    avgShot: sum / n,
    medianShot: median,
    cutsPerMinute: total > 0 ? (Math.max(0, n - 1) / total) * 60 : 0,
    durations,
  };
}

/** 时间 t 所在镜头的数组下标；空列表 -1 */
export function shotIndexAt(shots, t) {
  const list = shots || [];
  if (!list.length) return -1;
  const v = num(t, 0);
  let lo = 0; let hi = list.length - 1;
  if (v < num(list[0].start, 0)) return 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = list[mid];
    if (v < num(s.start, 0)) hi = mid - 1;
    else if (v >= num(s.end, 0)) lo = mid + 1;
    else return mid;
  }
  return Math.max(0, Math.min(list.length - 1, hi));
}

/** 时间 t 正在说的台词下标；不在任何一句内返回 -1（极短字幕至少停留 0.5 秒） */
export function transcriptIndexAt(items, t) {
  const list = items || [];
  const v = num(t, 0);
  let lo = 0; let hi = list.length - 1; let found = -1;
  while (lo <= hi) { // 最后一句 start <= t
    const mid = (lo + hi) >> 1;
    if (num(list[mid].start, 0) <= v) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (found < 0) return -1;
  const x = list[found];
  return v < Math.max(num(x.end, 0), num(x.start, 0) + 0.5) ? found : -1;
}

// ------------------------------------------------------------------
// 数据规范化
// ------------------------------------------------------------------
function normStats(s) {
  if (!s || typeof s !== 'object') return null;
  return {
    luma: n01(s.luma, 0.5),
    contrast: n01(s.contrast, 0.3),
    saturation: n01(s.saturation, 0.3),
    warmth: Math.max(-1, Math.min(1, num(s.warmth, 0))),
    tint: Math.max(-1, Math.min(1, num(s.tint, 0))),
    palette: Array.isArray(s.palette) ? s.palette.filter(validHex).slice(0, 5) : [],
  };
}

/** 把主进程返回的 Analysis 补齐字段，界面无需层层判空 */
export function normalizeAnalysis(a) {
  if (!a || typeof a !== 'object') return null;
  const shotsRaw = Array.isArray(a.shots) ? a.shots : [];
  const shots = shotsRaw.map((s, i) => {
    const start = Math.max(0, num(s && s.start, 0));
    const end = Math.max(start, num(s && s.end, start + num(s && s.duration, 0)));
    return {
      ...(s || {}),
      index: Number.isFinite(Number(s && s.index)) ? Number(s.index) : i,
      start,
      end,
      duration: Math.max(0, num(s && s.duration, end - start)),
      thumb: (s && s.thumb) || (s && Array.isArray(s.keyframes) && s.keyframes[0]) || null,
      keyframes: s && Array.isArray(s.keyframes) ? s.keyframes.filter(Boolean) : [],
      stats: normStats(s && s.stats),
      motion: n01(s && s.motion, 0),
      loudness: n01(s && s.loudness, 0),
      ai: s && s.ai && typeof s.ai === 'object' ? s.ai : null,
    };
  }).sort((x, y) => x.start - y.start);
  const lastEnd = shots.length ? shots[shots.length - 1].end : 0;
  const duration = num(a.duration, 0) > 0 ? num(a.duration, 0) : lastEnd;
  const r = a.rhythm && typeof a.rhythm === 'object' ? a.rhythm : null;
  const rhythm = r && Number.isFinite(Number(r.avgShot)) ? {
    avgShot: num(r.avgShot, 0),
    medianShot: num(r.medianShot, 0),
    cutsPerMinute: num(r.cutsPerMinute, 0),
    durations: Array.isArray(r.durations) ? r.durations.map((d) => num(d, 0)) : shots.map((s) => s.duration),
  } : computeRhythm(shots, duration);
  const ai = a.ai && typeof a.ai === 'object' ? {
    summary: String(a.ai.summary || ''),
    style: String(a.ai.style || ''),
    structure: Array.isArray(a.ai.structure) ? a.ai.structure.filter(Boolean).map((x) => ({
      label: String(x.label || ''), start: Math.max(0, num(x.start, 0)), end: Math.max(0, num(x.end, 0)), description: String(x.description || ''),
    })) : [],
    highlights: Array.isArray(a.ai.highlights) ? a.ai.highlights.filter(Boolean).map(String) : [],
  } : null;
  return {
    ...a,
    id: a.id,
    title: String(a.title || '未命名视频'),
    category: ANALYSIS_CATEGORY_KEYS.includes(a.category) ? a.category : 'other',
    source: a.source && typeof a.source === 'object' ? a.source : { type: 'file', path: a.assetPath },
    assetPath: a.assetPath || (a.source && a.source.path) || null,
    duration,
    width: num(a.width, 0),
    height: num(a.height, 0),
    fps: num(a.fps, 0),
    status: a.status === 'partial' ? 'partial' : 'done',
    errors: Array.isArray(a.errors) ? a.errors.filter(Boolean).map(String) : [],
    shots,
    rhythm,
    audio: {
      curve: a.audio && Array.isArray(a.audio.curve) ? a.audio.curve.map((v) => n01(v, 0)) : [],
      peaks: a.audio && Array.isArray(a.audio.peaks) ? a.audio.peaks.map((v) => num(v, 0)) : [],
    },
    transcript: Array.isArray(a.transcript) ? a.transcript.filter((x) => x && String(x.text || '').trim()).map((x) => ({
      start: Math.max(0, num(x.start, 0)), end: Math.max(0, num(x.end, num(x.start, 0))), text: String(x.text).trim(),
    })).sort((x, y) => x.start - y.start) : [],
    colorProfile: normStats(a.colorProfile),
    ai,
    techniqueIds: Array.isArray(a.techniqueIds) ? a.techniqueIds.filter(Boolean) : [],
    contactSheets: Array.isArray(a.contactSheets) ? a.contactSheets.filter(Boolean) : [],
  };
}

/** 列表筛选：关键词 + 分类 */
export function filterAnalyses(list, query, category) {
  const q = String(query || '').trim().toLowerCase();
  return (list || []).filter((a) => {
    if (!a) return false;
    if (category && category !== 'all' && a.category !== category) return false;
    if (!q) return true;
    return String(a.title || '').toLowerCase().includes(q);
  });
}

/**
 * 高级列表筛选：关键词（标题 / 关联技法标题与标签）+ 视频类型 + 技法类别。
 * opts: { query, category, techCategory, techniques }
 */
export function filterLibrary(list, opts = {}) {
  const { query = '', category = 'all', techCategory = '', techniques = [] } = opts || {};
  const q = String(query || '').trim().toLowerCase();
  const byAnalysis = new Map();
  for (const t of techniques || []) {
    const aid = t && t.source && t.source.analysisId;
    if (!aid) continue;
    if (!byAnalysis.has(aid)) byAnalysis.set(aid, []);
    byAnalysis.get(aid).push(t);
  }
  return (list || []).filter((a) => {
    if (!a) return false;
    if (category && category !== 'all' && a.category !== category) return false;
    const techs = byAnalysis.get(a.id) || [];
    if (techCategory && !techs.some((t) => t.category === techCategory)) return false;
    if (!q) return true;
    const hay = [a.title, ...techs.map((t) => [t.title, ...(t.tags || [])].join(' '))].join(' ').toLowerCase();
    return q.split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  });
}

/** 列表中各技法类别出现的次数（用于筛选芯片） */
export function techCategoryCounts(techniques) {
  const out = {};
  for (const t of techniques || []) {
    if (!t || !t.source || !t.source.analysisId) continue;
    out[t.category] = (out[t.category] || 0) + 1;
  }
  return out;
}

const mdEsc = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/**
 * 生成拆片报告 Markdown。
 * labels: { category?: {key:label}, techCategory?: {key:label} }
 */
export function buildAnalysisReport(analysis, techniques = [], labels = {}) {
  const a = normalizeAnalysis(analysis);
  if (!a) return '';
  const catL = (labels && labels.category) || {};
  const tcL = (labels && labels.techCategory) || {};
  const L = [];
  L.push(`# 拆片报告：${a.title}`, '');
  const src = a.source || {};
  L.push(`- 类型：${catL[a.category] || a.category}`);
  L.push(`- 来源：${src.url || src.path || a.assetPath || '本地视频'}`);
  L.push(`- 时长：${fmtClock(a.duration)}${a.width ? `　分辨率：${a.width}×${a.height}` : ''}${a.fps ? `　帧率：${Math.round(a.fps)}fps` : ''}`);
  if (a.createdAt) L.push(`- 分析时间：${String(a.createdAt).slice(0, 10)}`);
  L.push('');
  L.push('## 关键指标', '');
  L.push(`| 指标 | 数值 |`, `| --- | --- |`);
  L.push(`| 镜头数 | ${a.shots.length} |`);
  L.push(`| 平均镜头时长 | ${a.rhythm.avgShot > 0 ? fmtSec(a.rhythm.avgShot) : '—'} |`);
  L.push(`| 中位镜头时长 | ${a.rhythm.medianShot > 0 ? fmtSec(a.rhythm.medianShot) : '—'} |`);
  L.push(`| 每分钟切换 | ${a.rhythm.cutsPerMinute > 0 ? a.rhythm.cutsPerMinute.toFixed(1) + ' 次' : '—'} |`);
  L.push(`| 节奏 | ${mdEsc(describeRhythm(a.rhythm.avgShot))} |`);
  L.push(`| 整体色调 | ${mdEsc(describeTone(a.colorProfile))} |`);
  if (a.colorProfile && a.colorProfile.palette.length) L.push(`| 主色板 | ${a.colorProfile.palette.join(' ')} |`);
  L.push('');
  if (a.ai) {
    L.push('## AI 解读', '');
    if (a.ai.summary) L.push(a.ai.summary, '');
    if (a.ai.style) L.push(`**风格**：${a.ai.style}`, '');
    if (a.ai.highlights.length) { L.push('**值得学习的地方**', ''); a.ai.highlights.forEach((h) => L.push(`- ${h}`)); L.push(''); }
    if (a.ai.structure.length) {
      L.push('**结构分段**', '');
      a.ai.structure.forEach((s, i) => L.push(`${i + 1}. ${s.label || `第 ${i + 1} 段`}（${fmtClock(s.start)}–${fmtClock(s.end)}）${s.description ? '：' + s.description : ''}`));
      L.push('');
    }
  }
  if (a.shots.length) {
    L.push('## 镜头表', '');
    L.push('| # | 入点 | 时长 | 景别 | 运镜 | 说明 |', '| --- | --- | --- | --- | --- | --- |');
    a.shots.forEach((s, i) => {
      const ai = s.ai || {};
      L.push(`| ${i + 1} | ${fmtClock(s.start)} | ${fmtSec(s.duration)} | ${mdEsc(ai.shotSize || ai.size || '')} | ${mdEsc(ai.movement || ai.camera || '')} | ${mdEsc(ai.purpose || ai.description || '')} |`);
    });
    L.push('');
  }
  const techs = techniquesForAnalysis(techniques, a);
  if (techs.length) {
    L.push('## 技法卡', '');
    techs.forEach((t) => {
      L.push(`### ${t.title}${tcL[t.category] ? `（${tcL[t.category]}）` : ''}`, '');
      if (t.summary) L.push(t.summary, '');
      (t.steps || []).forEach((s, i) => L.push(`${i + 1}. ${s}`));
      if ((t.steps || []).length) L.push('');
      if (t.whenToUse) L.push(`适用：${t.whenToUse}`, '');
      if (t.source && t.source.end > t.source.start) L.push(`来源片段：${fmtClock(t.source.start)}–${fmtClock(t.source.end)}`, '');
    });
  }
  if (a.transcript.length) {
    L.push('## 台词', '');
    a.transcript.forEach((x) => L.push(`- \`${fmtClock(x.start)}\` ${x.text}`));
    L.push('');
  }
  L.push('---', '由 镜流 Frameflow 拆片库生成，仅供个人学习参考，视频版权归原作者所有。', '');
  return L.join('\n');
}

/** 报告文件名（去掉非法字符） */
export function reportFileName(analysis) {
  const t = String((analysis && analysis.title) || '拆片').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 60) || '拆片';
  return `${t} - 拆片报告.md`;
}

/** 属于某个分析的技法卡 */
export function techniquesForAnalysis(all, analysis) {
  if (!analysis) return [];
  const ids = new Set(analysis.techniqueIds || []);
  return (all || []).filter((t) => t && (ids.has(t.id) || (t.source && t.source.analysisId === analysis.id)));
}

/** 简单文本筛选（searchTechniques 不可用时的兜底） */
export function simpleFilterTechniques(list, query, category) {
  const q = String(query || '').trim().toLowerCase();
  const words = q ? q.split(/\s+/).filter(Boolean) : [];
  return (list || []).filter((t) => {
    if (!t) return false;
    if (category && t.category !== category) return false;
    if (!words.length) return true;
    const hay = [t.title, t.summary, t.whenToUse, ...(t.tags || []), ...(t.steps || [])].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

// ------------------------------------------------------------------
// 技法卡
// ------------------------------------------------------------------
/** 多行文本 → 步骤数组（去掉「1.」「-」「•」前缀） */
export function parseLines(text) {
  return String(text || '').split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:\d+[.、)）]|[-*•·])\s*/, '').trim())
    .filter(Boolean);
}

/** 「标签1, 标签2、#标签3」→ 数组 */
export function parseTags(text) {
  const seen = new Set();
  return String(text || '').split(/[,，、;；#\s]+/).map((s) => s.trim()).filter((s) => {
    if (!s || seen.has(s)) return false;
    seen.add(s); return true;
  }).slice(0, 20);
}

/** 规范化一张要保存的技法卡（用户卡，builtin=false） */
export function sanitizeTechnique(t) {
  const src = t && typeof t === 'object' ? t : {};
  const steps = Array.isArray(src.steps) ? src.steps.map((s) => String(s || '').trim()).filter(Boolean) : parseLines(src.steps);
  const tags = Array.isArray(src.tags) ? src.tags.map((s) => String(s || '').trim()).filter(Boolean) : parseTags(src.tags);
  const out = {
    ...src,
    id: src.id && !String(src.id).startsWith('bt_') ? src.id : uid('tq'),
    category: TECHNIQUE_CATEGORY_KEYS.includes(src.category) ? src.category : 'narrative',
    title: String(src.title || '').trim().slice(0, 80) || '未命名技法',
    summary: String(src.summary || '').trim().slice(0, 600),
    steps: steps.slice(0, 30),
    whenToUse: String(src.whenToUse || '').trim().slice(0, 400),
    tags,
    builtin: false,
    apply: src.apply && Array.isArray(src.apply.ops) ? src.apply : null,
  };
  if (src.source && typeof src.source === 'object' && src.source.analysisId) {
    out.source = {
      analysisId: src.source.analysisId,
      title: String(src.source.title || ''),
      start: Math.max(0, num(src.source.start, 0)),
      end: Math.max(0, num(src.source.end, num(src.source.start, 0))),
    };
    if (out.source.end < out.source.start) out.source.end = out.source.start;
  } else {
    delete out.source;
  }
  return out;
}

/** 拆片生成的技法卡：强制关联到该分析 */
export function attachTechniqueToAnalysis(t, analysis) {
  const src = (t && t.source) || {};
  const dur = analysis ? num(analysis.duration, 0) : 0;
  const start = Number.isFinite(Number(src.start)) ? Number(src.start) : 0;
  const end = Number.isFinite(Number(src.end)) && Number(src.end) > start ? Number(src.end) : (dur > start ? dur : start);
  return sanitizeTechnique({
    ...(t || {}),
    source: { analysisId: analysis.id, title: analysis.title || src.title || '', start, end },
  });
}

/** 内置卡复制为用户卡的草稿 */
export function copyTechniqueDraft(t) {
  const { id, builtin, ...rest } = t || {};
  return { ...rest, id: null, builtin: false, title: `${(t && t.title) || '技法'}（我的版本）` };
}

/** 去重合并 id 列表 */
export function mergeIds(...lists) {
  return Array.from(new Set(lists.flat().filter(Boolean)));
}
