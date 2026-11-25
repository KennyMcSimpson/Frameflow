// 精修侧栏共享数据：技法卡池、素材库查询、色彩统计补全、编号描述等。纯逻辑 + 少量 IPC。
import api from '../../api.js';
import useStore from '../../store.js';
import { BUILTIN_TECHNIQUES } from '../../../engine/builtinTechniques.js';
import { fmtTime } from '../../components/ui.jsx';

// ---------------- 技法卡 ----------------
let userTechCache = { at: 0, list: null, pending: null };

/** 读取「我的拆片库」技法卡（30 秒缓存；失败返回空数组，不抛错） */
export async function loadUserTechniques(force = false) {
  const now = Date.now();
  if (!force && userTechCache.list && now - userTechCache.at < 30000) return userTechCache.list;
  if (userTechCache.pending) return userTechCache.pending;
  userTechCache.pending = api.call('library:techniques', {})
    .then((list) => {
      const arr = Array.isArray(list) ? list.filter((t) => t && t.id && t.title) : [];
      userTechCache = { at: Date.now(), list: arr, pending: null };
      return arr;
    })
    .catch(() => {
      userTechCache = { ...userTechCache, pending: null };
      return userTechCache.list || [];
    });
  return userTechCache.pending;
}

export function invalidateUserTechniques() { userTechCache = { at: 0, list: null, pending: null }; }

export function builtinTechniques() {
  return Array.isArray(BUILTIN_TECHNIQUES) ? BUILTIN_TECHNIQUES : [];
}

/** 内置 + 我的拆片库，去重 */
export async function allTechniques() {
  const user = await loadUserTechniques();
  const seen = new Set();
  const out = [];
  for (const t of [...user, ...builtinTechniques()]) {
    if (!t || !t.id || seen.has(t.id)) continue;
    seen.add(t.id); out.push(t);
  }
  return out;
}

// ---------------- 素材库 ----------------
/** 查询素材库（失败抛出中文错误） */
export async function queryLibraryAssets(query) {
  const list = await api.call('library:assets', { query: (query || '').trim() || undefined });
  return Array.isArray(list) ? list.filter((a) => a && a.id) : [];
}

// ---------------- 色彩统计 ----------------
const STAT_KINDS = new Set(['video', 'image', 'generated-image']);

/**
 * 为缺少 stats 的素材补算代表帧色彩统计（不进撤销历史）。
 * @param {string[]} [assetIds] 缺省 = 主轨用到的全部素材
 * @returns {Promise<{missing:number, filled:number}>}
 */
export async function ensureAssetStats(assetIds) {
  const st = useStore.getState();
  const p = st.project;
  if (!p) return { missing: 0, filled: 0 };
  const ids = assetIds && assetIds.length ? assetIds : Array.from(new Set(p.tracks.video.map((c) => c.assetId)));
  const need = ids.map((id) => p.assets[id]).filter((a) => a && !a.stats && a.path && STAT_KINDS.has(a.kind));
  if (!need.length) return { missing: 0, filled: 0 };
  const results = await Promise.all(need.map(async (a) => {
    try {
      const t = a.kind === 'video' ? Math.max(0, (Number(a.duration) || 1) / 2) : 0;
      const arr = await api.call('media:colorStats', { path: a.path, times: [t] });
      const s = Array.isArray(arr) ? arr[0] : null;
      return s && typeof s === 'object' ? [a.id, s] : null;
    } catch { return null; }
  }));
  const found = Object.fromEntries(results.filter(Boolean));
  const filled = Object.keys(found).length;
  if (filled) {
    useStore.getState().update((proj) => {
      const assets = { ...proj.assets };
      for (const [id, s] of Object.entries(found)) if (assets[id]) assets[id] = { ...assets[id], stats: s };
      return { ...proj, assets };
    });
  }
  return { missing: need.length, filled };
}

// ---------------- 文案工具 ----------------
/** [1,2,3] → 「第1–3镜」；[1,3,5] → 「第1、3、5镜」；太多 → 「N 个镜头」 */
export function describeIndices(nums) {
  const arr = Array.from(new Set((nums || []).filter((n) => Number.isFinite(n)))).sort((a, b) => a - b);
  if (!arr.length) return '';
  if (arr.length === 1) return `第${arr[0]}镜`;
  const contiguous = arr.every((n, i) => i === 0 || n === arr[i - 1] + 1);
  if (contiguous) return `第${arr[0]}–${arr[arr.length - 1]}镜`;
  if (arr.length <= 5) return `第${arr.join('、')}镜`;
  return `${arr.length} 个镜头`;
}

export function fmtRange(r) {
  if (!r) return '';
  return `${fmtTime(r.start, false)}–${fmtTime(r.end, false)}`;
}

/** 秒 → 0:05 / 1:23 / 1:02:03 */
export function fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${m}:${String(r).padStart(2, '0')}`;
}

export const KIND_LABELS = { video: '视频', image: '图片', audio: '音频', previz: 'AI 预演', 'generated-image': 'AI 画面' };

/** localStorage 小工具（失败静默） */
export function readPref(key, dflt) {
  try {
    const raw = window.localStorage.getItem('ff.' + key);
    return raw == null ? dflt : JSON.parse(raw);
  } catch { return dflt; }
}
export function writePref(key, value) {
  try { window.localStorage.setItem('ff.' + key, JSON.stringify(value)); } catch {}
}

// ---------------- 素材来源分类 ----------------
/** 素材来源类型：'stock'|'videogen'|'previz'|'local'|'web'|'builtin'|'ai'…（优先取 source.kind，兼容旧对象形式 source:{type|platform}） */
export function assetSourceType(a) {
  if (!a) return '';
  if (typeof a.source === 'string') return a.source;
  if (a.kind === 'previz') return 'previz';
  if (a.source && typeof a.source === 'object') return a.source.kind || a.source.type || (a.source.platform ? 'web' : 'local');
  return 'local';
}
export function isAIAsset(a) {
  const s = assetSourceType(a);
  return !!a && (a.kind === 'previz' || a.kind === 'generated-image' || s === 'videogen' || s === 'previz' || s === 'ai' || !!(a.ai && a.ai.provider));
}
export function isRealAsset(a) {
  return !!a && (a.kind === 'video' || a.kind === 'image') && !isAIAsset(a);
}
/** 卡片显示名：去掉「预演：」等内部前缀 */
export function displayAssetName(a) {
  const n = String((a && a.name) || '未命名素材');
  return n.replace(/^\s*(AI\s*)?预演\s*[:：·\-]\s*/i, '').trim() || '未命名素材';
}

// ---------------- 内置音乐与音效 ----------------
// 清单条目来自 media:builtinAudio：{ id, kind:'music'|'sfx', title, mood?, bpm?, duration, file, license:{id,name,url}, author?, sourceUrl?, path }

/** 许可：接受对象或字符串 id，统一成 { id, name?, url? }；缺省按未知处理 */
export function normalizeBuiltinLicense(raw) {
  if (raw && typeof raw === 'object' && raw.id) {
    const out = { id: String(raw.id) };
    if (raw.name) out.name = String(raw.name);
    if (raw.url) out.url = String(raw.url);
    return out;
  }
  if (typeof raw === 'string' && raw.trim()) return { id: raw.trim() };
  return { id: 'unknown' };
}

/** 许可的短名（列表角标用）：CC0 / CC BY / Pixabay … */
export function builtinLicenseShort(lic) {
  const l = normalizeBuiltinLicense(lic);
  const id = l.id.toLowerCase();
  if (id === 'cc0' || id === 'cc0-1.0' || id === 'public-domain' || id === 'pd') return 'CC0';
  const cc = /^cc[-_ ]?(by(?:[-_ ](?:sa|nd|nc))*)/.exec(id);
  if (cc) return 'CC ' + cc[1].replace(/[-_ ]/g, '-').toUpperCase();
  if (id === 'unknown') return '';
  if (l.name && l.name.length <= 12) return l.name;
  return l.id.charAt(0).toUpperCase() + l.id.slice(1);
}

/** 规范化清单：丢掉缺 id/标题/路径的条目，kind 只认 music/sfx（缺省 music） */
export function normalizeBuiltinList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const id = String(it.id || '').trim();
    const title = String(it.title || '').trim();
    const p = typeof it.path === 'string' ? it.path : '';
    if (!id || !title || !p || seen.has(id)) continue;
    seen.add(id);
    const duration = Number(it.duration);
    const bpm = Number(it.bpm);
    out.push({
      id,
      kind: it.kind === 'sfx' ? 'sfx' : 'music',
      title,
      mood: typeof it.mood === 'string' ? it.mood.trim() : '',
      bpm: Number.isFinite(bpm) && bpm > 0 ? Math.round(bpm) : 0,
      duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
      path: p,
      license: normalizeBuiltinLicense(it.license),
      author: typeof it.author === 'string' ? it.author.trim() : '',
      sourceUrl: typeof it.sourceUrl === 'string' ? it.sourceUrl : '',
    });
  }
  return out;
}

/** 当前分类下出现过的情绪（保持清单顺序，去重） */
export function builtinMoods(items, kind = 'all') {
  const seen = new Set();
  for (const it of items || []) {
    if (kind !== 'all' && it.kind !== kind) continue;
    if (it.mood && !seen.has(it.mood)) seen.add(it.mood);
  }
  return Array.from(seen);
}

/** 筛选：kind（all/music/sfx）+ 情绪 + 关键词（空格分隔，全部命中；匹配标题、情绪、作者、类别） */
export function filterBuiltinAudio(items, { kind = 'all', mood = '', query = '' } = {}) {
  const words = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return (items || []).filter((it) => {
    if (kind !== 'all' && it.kind !== kind) return false;
    if (mood && it.mood !== mood) return false;
    if (!words.length) return true;
    const hay = [it.title, it.mood, it.author, it.kind === 'sfx' ? '音效' : '音乐', it.bpm ? `${it.bpm}bpm` : ''].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** 项目里已经加过的同一条内置音频（避免重复建素材） */
export function findBuiltinAssetId(project, builtinId) {
  const assets = (project && project.assets) || {};
  for (const a of Object.values(assets)) {
    if (a && a.source && typeof a.source === 'object' && a.source.kind === 'builtin' && a.source.id === builtinId) return a.id;
  }
  return null;
}

/** 清单条目 → 项目素材（source.kind='builtin' 并带许可） */
export function builtinAudioAsset(item, existingId) {
  const safe = String(item.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'audio';
  const source = { kind: 'builtin', id: item.id, title: item.title };
  if (item.author) source.author = item.author;
  if (item.sourceUrl) source.url = item.sourceUrl;
  return {
    id: existingId || `a_bi_${safe}_${Date.now().toString(36).slice(-5)}`,
    kind: 'audio',
    name: item.title,
    path: item.path,
    originalPath: item.path,
    duration: Number(item.duration) > 0 ? Number(item.duration) : 0,
    width: 0,
    height: 0,
    fps: 0,
    hasAudio: true,
    size: 0,
    thumb: null,
    tags: [item.kind === 'sfx' ? '音效' : '音乐', item.mood].filter(Boolean),
    description: '',
    codec: { video: null, audio: null },
    source,
    license: normalizeBuiltinLicense(item.license),
  };
}

/**
 * 放到音频轨的片段参数。音效：原长、不淡入淡出；
 * 音乐：成片比音乐短时裁到成片结尾并 1.5 秒淡出（成片为空或很短时保留原长）。
 * @returns {{ start, out, role, fadeIn, fadeOut, trimmed }}
 */
export function planBuiltinClip({ duration, at = 0, total = 0, kind = 'music' }) {
  const dur = Math.max(0, Number(duration) || 0);
  const start = Math.max(0, Number(at) || 0);
  if (kind === 'sfx') return { start, out: dur, role: 'sfx', fadeIn: 0, fadeOut: 0, trimmed: false };
  const room = (Number(total) || 0) - start;
  const trimmed = room >= 2 && dur > room + 0.05;
  const out = trimmed ? Math.round(room * 1000) / 1000 : dur;
  return { start, out, role: 'music', fadeIn: Math.min(0.5, out / 4), fadeOut: trimmed ? Math.min(1.5, out / 3) : Math.min(0.8, out / 4), trimmed };
}

// ---------------- 从资源管理器拖入 ----------------
/** 外部文件拖入：有 Files 且不是应用内素材拖拽 */
export function isExternalFileDrag(dataTransfer, internalType = 'application/x-ff-asset') {
  const types = Array.from((dataTransfer && dataTransfer.types) || []);
  return types.includes('Files') && !types.includes(internalType);
}

/** 当前环境能不能拿到拖入文件的路径（外壳提供 pathForFile 时才能直接导入） */
export function canResolveDroppedPaths() {
  try {
    if (typeof api.pathForFile === 'function') return true;
    const ff = typeof window !== 'undefined' ? window.ff : null;
    return !!(ff && typeof ff.pathForFile === 'function');
  } catch { return false; }
}

/** 拖入文件 → 绝对路径列表（拿不到路径的跳过）。getPath 缺省用 api.pathForFile / window.ff.pathForFile */
export function droppedFilePaths(dataTransfer, getPath) {
  const files = Array.from((dataTransfer && dataTransfer.files) || []);
  const pick = getPath || ((f) => {
    try {
      if (typeof api.pathForFile === 'function') return api.pathForFile(f) || '';
      const ff = typeof window !== 'undefined' ? window.ff : null;
      if (ff && typeof ff.pathForFile === 'function') return ff.pathForFile(f) || '';
    } catch { /* 取不到路径时交给外壳的导入窗口兜底 */ }
    return '';
  });
  const out = [];
  for (const f of files) {
    let p = '';
    try { p = pick(f) || ''; } catch { p = ''; }
    if (typeof p === 'string' && p && !out.includes(p)) out.push(p);
  }
  return out;
}
