// 创作模式的纯函数：分镜增删改、简报合并、搜索计划、轻量 markdown。无 DOM、无 store，node 可测。
import { uid, clamp, deepClone } from '../../../engine/ids.js';
import {
  ASPECTS, LOOKS, SHOT_SIZES, ANGLES, SHOT_MOVEMENTS, TRANSITIONS, PREVIZ_SETTINGS, PREVIZ_SUBJECTS, PREVIZ_ACTIONS,
  SHOT_SIZE_LABELS, ANGLE_LABELS, LOOK_LABELS,
  createBrief, createShot, createPrevizSpec,
} from '../../../engine/model.js';
import { PLATFORMS, PACING_LABELS, TIME_OF_DAY, LIGHT_DIRECTIONS, LIGHT_KEYS, LIGHT_MOODS } from './createLabels.js';

export const MIN_SHOT_SECONDS = 0.5;
export const MAX_SHOT_SECONDS = 60;
export const MAX_SUBJECTS = 4;
const MAX_REFERENCE_RESULTS = 24;

const oneOf = (v, list, dflt) => (list.includes(v) ? v : dflt);
const str = (v) => (v == null ? '' : String(v).trim());

export function strList(v) {
  if (!Array.isArray(v)) return [];
  return v.map(str).filter(Boolean);
}

// ---------- 分镜规范化 ----------

function normalizeSubject(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    ...s,
    kind: oneOf(s.kind, PREVIZ_SUBJECTS, 'person'),
    x: clamp(s.x ?? 0.5, 0, 1),
    y: clamp(s.y ?? 0.62, 0, 1),
    scale: clamp(s.scale ?? 1, 0.2, 2),
    color: str(s.color) || '#e0a96d',
    action: oneOf(s.action, PREVIZ_ACTIONS, 'idle'),
    label: str(s.label),
  };
}

function normalizePreviz(raw, camera) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const base = createPrevizSpec();
  const light = { ...base.light, ...(p.light || {}) };
  return createPrevizSpec({
    ...p,
    setting: oneOf(p.setting, PREVIZ_SETTINGS, base.setting),
    timeOfDay: oneOf(p.timeOfDay, TIME_OF_DAY, base.timeOfDay),
    palette: Array.isArray(p.palette) && p.palette.length ? p.palette : base.palette,
    subjects: Array.isArray(p.subjects) && p.subjects.length ? p.subjects.map(normalizeSubject) : base.subjects,
    camera,
    light: {
      direction: oneOf(light.direction, LIGHT_DIRECTIONS, base.light.direction),
      key: oneOf(light.key, LIGHT_KEYS, base.light.key),
      mood: oneOf(light.mood, LIGHT_MOODS, base.light.mood),
    },
    overlayText: str(p.overlayText),
  });
}

/** 把 AI 或表单给的分镜夹回合法枚举与范围。保留 previzAssetId 等额外字段。 */
export function normalizeShot(raw, index = 1, seenIds) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const shotSize = oneOf(s.shotSize, SHOT_SIZES, 'medium');
  const angle = oneOf(s.angle, ANGLES, 'eye-level');
  const movement = oneOf(s.movement, SHOT_MOVEMENTS, 'static');
  const id = s.id && !(seenIds && seenIds.has(s.id)) ? s.id : uid('sht');
  if (seenIds) seenIds.add(id);
  return createShot({
    ...s,
    id,
    index,
    title: str(s.title) || `镜头 ${index}`,
    duration: clamp(Number(s.duration) > 0 ? s.duration : 4, MIN_SHOT_SECONDS, MAX_SHOT_SECONDS),
    shotSize,
    angle,
    movement,
    lighting: str(s.lighting),
    location: str(s.location),
    subject: str(s.subject),
    action: str(s.action),
    caption: str(s.caption),
    voiceover: str(s.voiceover),
    shootingTips: strList(s.shootingTips),
    transitionIn: oneOf(s.transitionIn, TRANSITIONS, 'cut'),
    look: oneOf(s.look, LOOKS, 'none'),
    referenceQueries: strList(s.referenceQueries),
    techniqueIds: strList(s.techniqueIds),
    previz: normalizePreviz(s.previz, { shotSize, movement, angle }),
    assetId: s.assetId || null,
    status: oneOf(s.status, ['planned', 'has-reference', 'has-previz', 'has-footage'], 'planned'),
  });
}

export function normalizeShots(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).filter(Boolean).map((s, i) => normalizeShot(s, i + 1, seen));
}

export function reindexShots(shots) {
  return shots.map((s, i) => (s.index === i + 1 ? s : { ...s, index: i + 1 }));
}

// ---------- 状态 ----------

const hasAsset = (id, assets) => !!id && (!assets || !!assets[id]);

/** 单一状态（写入 shot.status）：素材 > 预演 > 参考 > 已规划 */
export function deriveStatus(shot, refs, assets) {
  if (hasAsset(shot.assetId, assets)) return 'has-footage';
  if (hasAsset(shot.previzAssetId, assets)) return 'has-previz';
  if (refs && refs.length) return 'has-reference';
  return 'planned';
}

/** 卡片上显示的全部徽标（一个分镜可以同时有参考、预演和素材） */
export function shotBadges(shot, refs, assets) {
  const out = [];
  if (hasAsset(shot.assetId, assets)) out.push('has-footage');
  if (hasAsset(shot.footageAssetId, assets) && !hasAsset(shot.assetId, assets)) out.push('has-stock');
  else if (hasAsset(shot.previzAssetId, assets)) out.push('has-previz');
  if (refs && refs.length) out.push('has-reference');
  return out.length ? out : ['planned'];
}

// ---------- 分镜增删改（返回新 project，找不到目标返回 null） ----------

function shotIndex(project, shotId) {
  return (project.storyboard || []).findIndex((s) => s.id === shotId);
}

/** 合并字段并重算状态；若已生成预演资产，同步其 spec 与时长，保证时间线上的预演跟着更新 */
export function withShotPatch(project, shotId, patch) {
  const i = shotIndex(project, shotId);
  if (i < 0) return null;
  const shot = project.storyboard[i];
  const merged = { ...shot, ...patch, id: shot.id, index: shot.index };
  merged.status = deriveStatus(merged, project.references && project.references[shotId], project.assets);
  const storyboard = [...project.storyboard];
  storyboard[i] = merged;
  let assets = project.assets;
  const linked = merged.previzAssetId && assets ? assets[merged.previzAssetId] : null;
  if (linked && linked.kind === 'previz' && (linked.previz !== merged.previz || linked.duration !== merged.duration)) {
    assets = { ...assets, [linked.id]: { ...linked, previz: merged.previz, duration: merged.duration } };
  }
  return { ...project, storyboard, assets };
}

/** 写入一镜的联网参考结果（不进撤销历史） */
export function withReferences(project, shotId, results) {
  const next = { ...project, references: { ...(project.references || {}), [shotId]: results } };
  return withShotPatch(next, shotId, {}) || next;
}

/** 把预演资产挂到分镜上（shot.assetId 不变） */
export function linkPreviz(project, shotId, asset) {
  const next = { ...project, assets: { ...(project.assets || {}), [asset.id]: asset } };
  return withShotPatch(next, shotId, { previzAssetId: asset.id });
}

export function moveShotTo(shots, shotId, toIndex) {
  const from = shots.findIndex((s) => s.id === shotId);
  if (from < 0) return shots;
  const to = clamp(Math.round(toIndex), 0, shots.length - 1);
  if (to === from) return shots;
  const next = [...shots];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return reindexShots(next);
}

export function moveShotBy(shots, shotId, delta) {
  const from = shots.findIndex((s) => s.id === shotId);
  return from < 0 ? shots : moveShotTo(shots, shotId, from + delta);
}

/** 复制一镜（放在原镜后面）。副本有独立的预演，不共用预演资产。 */
export function duplicateShot(shots, shotId) {
  const i = shots.findIndex((s) => s.id === shotId);
  if (i < 0) return null;
  const copy = deepClone(shots[i]);
  copy.id = uid('sht');
  copy.title = `${shots[i].title} 副本`;
  delete copy.previzAssetId;
  delete copy.footageAssetId;
  delete copy.footageTried;
  copy.status = copy.assetId ? 'has-footage' : 'planned';
  const next = [...shots];
  next.splice(i + 1, 0, copy);
  return { shots: reindexShots(next), shotId: copy.id };
}

/** 在 afterId 后面插入新镜（afterId 为空时加到末尾），沿用前一镜的场景与风格 */
export function insertShotAfter(shots, afterId) {
  const i = afterId ? shots.findIndex((s) => s.id === afterId) : shots.length - 1;
  const prev = i >= 0 ? shots[i] : null;
  const shot = createShot({
    title: '新镜头',
    location: prev ? prev.location : '',
    look: prev ? prev.look : 'none',
    previz: prev ? createPrevizSpec({ ...deepClone(prev.previz), overlayText: '' }) : createPrevizSpec(),
  });
  const next = [...shots];
  next.splice(i + 1, 0, shot);
  return { shots: reindexShots(next), shotId: shot.id };
}

/** 删除一镜及其参考结果。素材和预演资产保留，时间线可能还在用。 */
export function removeShot(project, shotId) {
  if (shotIndex(project, shotId) < 0) return null;
  const references = { ...(project.references || {}) };
  delete references[shotId];
  return { ...project, references, storyboard: reindexShots(project.storyboard.filter((s) => s.id !== shotId)) };
}

// ---------- 简报 ----------

const BRIEF_TEXT_KEYS = ['title', 'goal', 'audience', 'style', 'mood', 'music', 'keyMessage'];

/**
 * 清洗 AI 给的 briefPatch：丢掉空值与非法枚举。
 * 严格 schema 里模型常用 '' / null / 'none' / '其他' 表示「没提到」，这些不能覆盖用户已有的内容。
 */
export function cleanBriefPatch(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  for (const k of BRIEF_TEXT_KEYS) {
    const v = str(patch[k]);
    if (v) out[k] = v;
  }
  if (PLATFORMS.includes(patch.platform) && patch.platform !== '其他') out.platform = patch.platform;
  const duration = Number(patch.duration);
  if (Number.isFinite(duration) && duration > 0) out.duration = clamp(Math.round(duration), 3, 600);
  if (ASPECTS[patch.aspect]) out.aspect = patch.aspect;
  if (LOOKS.includes(patch.look) && patch.look !== 'none') out.look = patch.look;
  if (PACING_LABELS[patch.pacing]) out.pacing = patch.pacing;
  for (const k of ['mustHave', 'avoid']) {
    const list = strList(patch[k]);
    if (list.length) out[k] = list;
  }
  return out;
}

/** 当前简报；还没有时按项目画幅给一份默认值 */
export function baseBrief(project) {
  if (project && project.brief) return project.brief;
  return createBrief({ aspect: (project && project.settings && project.settings.aspect) || '16:9' });
}

/** 把 AI 新写的风格指南写入记忆。用户改过的内容不覆盖。 */
export function nextStyleGuide(memory, generated) {
  const m = memory || {};
  const text = str(generated);
  const current = m.styleGuide || '';
  if (!text) return m;
  if (current && current !== m.autoStyleGuide) return m;
  return { ...m, styleGuide: text, autoStyleGuide: text };
}

/** 用新分镜替换旧分镜。旧分镜的参考结果一并清掉（撤销可恢复）。 */
export function applyStoryboard(project, shots, { styleGuide } = {}) {
  return {
    ...project,
    brief: baseBrief(project),
    storyboard: normalizeShots(shots),
    references: {},
    memory: nextStyleGuide(project.memory, styleGuide),
  };
}

// ---------- 联网参考 ----------

const SITE_SOURCES = ['bilibili', 'youtube'];
const hasCJK = (s) => /[㐀-鿿]/.test(s);

/** 有 yt-dlp 时用视频站（按设置里的偏好），否则退到免版权素材库 */
export function pickSources({ ytdlpInstalled, settings } = {}) {
  const web = (settings && settings.web) || {};
  const preferred = Array.isArray(web.preferredSources) && web.preferredSources.length ? web.preferredSources : null;
  if (ytdlpInstalled) {
    const sites = preferred ? preferred.filter((s) => SITE_SOURCES.includes(s)) : SITE_SOURCES;
    if (sites.length) return sites;
  }
  const out = ['commons'];
  const allowed = (s) => !preferred || preferred.includes(s);
  if (settings && settings.hasPexelsKey && allowed('pexels')) out.push('pexels');
  if (settings && settings.hasPixabayKey && allowed('pixabay')) out.push('pixabay');
  return out;
}

/** 分镜的中英文搜索词。没有 AI 给的词时用主体/动作/景别拼一个。 */
export function shotQueries(shot) {
  const qs = strList(shot && shot.referenceQueries);
  let zh = qs.find(hasCJK) || '';
  const en = qs.find((q) => !hasCJK(q)) || '';
  if (!zh && !en && shot) {
    zh = [str(shot.subject) || str(shot.title), str(shot.action), SHOT_SIZE_LABELS[shot.shotSize]].filter(Boolean).join(' ').slice(0, 40);
  }
  return { zh, en };
}

/** 中文站用中文词、其他源优先英文词，同一个词的源合并成一次请求 */
export function buildSearchPlan(shot, sources, customQuery) {
  const list = Array.isArray(sources) ? sources : [];
  const custom = str(customQuery);
  if (custom) return list.length ? [{ query: custom, sources: list }] : [];
  const { zh, en } = shotQueries(shot);
  const groups = new Map();
  for (const source of list) {
    const query = source === 'bilibili' ? zh || en : en || zh;
    if (!query) continue;
    if (!groups.has(query)) groups.set(query, []);
    groups.get(query).push(source);
  }
  return Array.from(groups, ([query, grouped]) => ({ query, sources: grouped }));
}

/** 协议相对或 http 的缩略图改成 https（页面 CSP 不允许 http 图片） */
export function normalizeThumbUrl(url) {
  const u = str(url);
  if (!u) return '';
  if (u.startsWith('//')) return `https:${u}`;
  if (u.startsWith('http://')) return `https://${u.slice(7)}`;
  return u;
}

export function resultKey(r) {
  return `${(r && r.source) || 'web'}:${(r && (r.id || r.url)) || ''}`;
}

/** 合并多次搜索的结果：去重、补默认字段、限制总数；各来源交替排列，避免一个来源占满前排 */
export function mergeResults(lists) {
  const buckets = new Map();
  const seen = new Set();
  for (const list of lists || []) {
    for (const r of list || []) {
      if (!r || !(r.url || r.downloadUrl)) continue;
      const key = resultKey(r);
      if (seen.has(key)) continue;
      seen.add(key);
      const source = r.source || 'web';
      if (!buckets.has(source)) buckets.set(source, []);
      buckets.get(source).push({ ...r, source, title: str(r.title) || '未命名视频', thumb: normalizeThumbUrl(r.thumb) });
    }
  }
  const queues = Array.from(buckets.values());
  const out = [];
  while (out.length < MAX_REFERENCE_RESULTS && queues.some((q) => q.length)) {
    for (const q of queues) if (q.length && out.length < MAX_REFERENCE_RESULTS) out.push(q.shift());
  }
  return out;
}

/** 这条结果是否已下载到项目 */
export function findAssetForResult(assets, r) {
  if (!assets || !r) return null;
  const urls = [r.url, r.downloadUrl].filter(Boolean);
  return Object.values(assets).find((a) => a && a.source && urls.includes(a.source.url)) || null;
}

/** 拆片分类：标题关键词优先，否则按时长判断 */
export function guessCategory(r) {
  const t = str(r && r.title).toLowerCase();
  if (/教程|教学|怎么拍|如何|技巧|tutorial|how to/.test(t)) return 'tutorial';
  if (/访谈|采访|幕后|interview/.test(t)) return 'interview';
  if (/广告|宣传片|tvc|commercial|\bad\b/.test(t)) return 'ad';
  if (/特效|vfx|cgi|ai视频/.test(t)) return 'vfx';
  if (/电影|预告|film|movie|trailer/.test(t)) return 'film';
  const d = Number(r && r.duration);
  return d > 0 && d <= 180 ? 'short' : 'other';
}

// ---------- AI 画面 ----------

export function imageSizeForAspect(aspect) {
  if (aspect === '9:16') return '1024x1536';
  if (aspect === '1:1') return '1024x1024';
  return '1536x1024';
}

export function buildImagePrompt(shot, brief) {
  const b = brief || {};
  const look = LOOK_LABELS[shot.look !== 'none' ? shot.look : b.look];
  return [
    '电影感写实静帧，用作视频分镜画面。',
    b.title && `作品：${b.title}。`,
    (b.style || b.mood) && `风格：${[b.style, b.mood].filter(Boolean).join('，')}。`,
    shot.location && `场景：${shot.location}。`,
    shot.subject && `主体：${shot.subject}。`,
    shot.action && `动作：${shot.action}。`,
    `景别：${SHOT_SIZE_LABELS[shot.shotSize] || '中景'}，角度：${ANGLE_LABELS[shot.angle] || '平视'}。`,
    shot.lighting && `光线：${shot.lighting}。`,
    look && look !== LOOK_LABELS.none && `色调：${look}。`,
    '画面中不要出现文字、字幕、水印或 logo。',
  ].filter(Boolean).join('');
}

// ---------- 展示 ----------

export function boardStats(shots, brief) {
  const list = shots || [];
  const total = list.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
  return { count: list.length, total, target: brief && Number(brief.duration) > 0 ? Number(brief.duration) : null };
}

/** 卡片媒体区的布局：竖屏卡片更窄、媒体区更高；fit 决定画面按宽还是按高贴合 */
export function mediaLayout(aspect) {
  const { width, height } = ASPECTS[aspect] || ASPECTS['16:9'];
  const frameRatio = width / height;
  let boxRatio = frameRatio;
  let cardMin = 248;
  if (aspect === '9:16') { boxRatio = 3 / 4; cardMin = 196; }
  else if (aspect === '1:1') { cardMin = 216; }
  else if (aspect === '21:9') { boxRatio = 2; cardMin = 280; }
  return { cardMin, boxRatio, frameRatio, fit: frameRatio >= boxRatio ? 'width' : 'height' };
}

/** 画布内部分辨率：长边 = longEdge，按画幅算短边 */
export function frameSize(aspect, longEdge = 320) {
  const { width, height } = ASPECTS[aspect] || ASPECTS['16:9'];
  if (width >= height) return { width: longEdge, height: Math.round((longEdge * height) / width) };
  return { width: Math.round((longEdge * width) / height), height: longEdge };
}

export function summarizeReport(report) {
  const lines = strList(report);
  return lines.length ? lines.slice(0, 3).join('；') : '已按分镜生成初剪时间线';
}

/** 问句要用户补充答案，其余（如「发抖音」）可以直接当回复发送 */
export function isQuestionLike(text) {
  return /[?？]\s*$/.test(str(text));
}

// ---------- 轻量 markdown（AI 回复：粗体、行内代码、列表、小标题、换行） ----------

export function parseInline(text) {
  const parts = [];
  const re = /\*\*([^*\n]+?)\*\*|`([^`\n]+)`/g;
  const src = String(text == null ? '' : text);
  let last = 0;
  let m = re.exec(src);
  while (m) {
    if (m.index > last) parts.push({ type: 'text', text: src.slice(last, m.index) });
    parts.push(m[1] != null ? { type: 'bold', text: m[1] } : { type: 'code', text: m[2] });
    last = m.index + m[0].length;
    m = re.exec(src);
  }
  if (last < src.length) parts.push({ type: 'text', text: src.slice(last) });
  return parts;
}

/** → [{type:'p', lines:[inline[]]} | {type:'ul'|'ol', items:[inline[]]} | {type:'h', inline}] */
export function parseMarkdownLite(src) {
  const blocks = [];
  let open = null;
  const push = (type) => {
    if (!open || open.type !== type) {
      open = type === 'p' ? { type, lines: [] } : { type, items: [] };
      blocks.push(open);
    }
    return open;
  };
  for (const raw of String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) { open = null; continue; }
    const heading = /^#{1,4}\s+(.+)$/.exec(line);
    const bullet = /^[-*•]\s+(.+)$/.exec(line);
    const ordered = /^\d+[.、)）]\s*(.+)$/.exec(line);
    if (heading) { blocks.push({ type: 'h', inline: parseInline(heading[1]) }); open = null; }
    else if (bullet) push('ul').items.push(parseInline(bullet[1]));
    else if (ordered) push('ol').items.push(parseInline(ordered[1]));
    else push('p').lines.push(parseInline(line));
  }
  return blocks;
}

// ---------- v3：画面来源 / 卡片元信息 / 异常状态 ----------

const SIZE_SHORT = { 'extreme-wide': '大远景', wide: '远景', full: '全景', medium: '中景', 'medium-close': '中近景', close: '近景', 'close-up': '特写', 'extreme-close': '大特写', insert: '插入镜头' };
const ANGLE_SHORT = { eye: '平视', 'eye-level': '平视', high: '俯拍', low: '仰拍', overhead: '顶拍', 'birds-eye': '鸟瞰', dutch: '斜角', pov: '主观', ots: '过肩' };
const MOVE_SHORT = { static: '固定', locked: '固定', pan: '摇', tilt: '俯仰摇', push: '推', 'push-in': '推', pull: '拉', 'pull-out': '拉', dolly: '移', track: '跟随', tracking: '跟随', follow: '跟随', handheld: '手持', orbit: '环绕', crane: '升降', zoom: '变焦', gimbal: '稳定器' };

const usableAsset = (assets, id) => {
  const a = id && assets ? assets[id] : null;
  return a && !a.missing ? a : null;
};

/**
 * 素材本身的出处，只分三类：'ai'（AI 生成）、'stock'（免版权实拍/示例/内置素材）、'local'（用户自己挑的）。
 * 同时认旧写法（source 是字符串 'videogen' / 'stock'）和契约 C3 的对象写法（source.kind / asset.ai）。
 * 从网页或视频站下载的素材（kind 'web' / 'videosite'）算用户自己挑的：版权不明，也不能被「换一批实拍」自动替换。
 */
export function assetOrigin(asset) {
  if (!asset) return 'local';
  const src = asset.source;
  const kind = src && typeof src === 'object' ? src.kind || src.type : src;
  if (asset.ai || asset.kind === 'generated-image' || kind === 'ai' || kind === 'ai-image' || kind === 'videogen') return 'ai';
  if (kind === 'stock' || kind === 'sample' || kind === 'builtin') return 'stock';
  if (asset.stock && !kind) return 'stock';
  return 'local';
}

/**
 * 「没有连接 AI」类错误：AI 那边会退回本地规则，这不是真正的失败。
 * 任务通道有时会丢掉错误码，只剩中文提示，所以文案也要认（契约 C9）。
 */
export function isNoAIError(e) {
  if (!e) return false;
  if (e.code === 'NO_AI' || e.name === 'NoAIError') return true;
  const msg = String((e && e.message) || (typeof e === 'string' ? e : ''));
  return /未连接\s*AI|NO_AI/i.test(msg);
}

/** aiStatus 已检测完、且没有可用的大模型（检测中为 null，不算） */
export function isLocalOnlyAI(status) {
  return !!status && (status.provider === 'local' || status.provider === 'none' || !status.ready);
}

/**
 * 分镜当前画面来源，优先级见 PLAN-v3 §7：用户素材 > AI 视频 > 实拍 > 示意(previz)。
 * 返回 { kind:'local'|'ai'|'stock'|'previz'|'none', asset }
 */
export function shotSource(shot, assets) {
  if (!shot) return { kind: 'none', asset: null };
  const own = usableAsset(assets, shot.assetId);
  if (own && own.kind !== 'previz') return { kind: assetOrigin(own), asset: own };
  const ai = usableAsset(assets, shot.aiVideoAssetId);
  if (ai) return { kind: 'ai', asset: ai };
  const stock = usableAsset(assets, shot.footageAssetId);
  if (stock) return { kind: 'stock', asset: stock };
  const pv = own || usableAsset(assets, shot.previzAssetId);
  if (pv) return { kind: 'previz', asset: pv };
  if (shot.previz) return { kind: 'previz', asset: null };
  return { kind: 'none', asset: null };
}

/** 是否已有可当成片使用的画面（示意不算） */
export function hasRealFootage(shot, assets) {
  const k = shotSource(shot, assets).kind;
  return k === 'local' || k === 'ai' || k === 'stock';
}

/** 卡片一行弱文字：「中景 · 平视 · 跟随」 */
export function shotMetaLine(shot, labels = {}) {
  if (!shot) return '';
  const pick = (map, fallback, key) => (key && ((map && map[key]) || fallback[key])) || '';
  return [
    pick(labels.size, SIZE_SHORT, shot.shotSize),
    pick(labels.angle, ANGLE_SHORT, shot.angle),
    pick(labels.movement, MOVE_SHORT, shot.movement),
  ].filter(Boolean).join(' · ');
}

/**
 * 只在异常时返回状态，正常（有实拍/AI/本地画面）返回 null。
 * busy: createUI.shotBusy[id]；返回 { kind:'busy'|'error'|'missing', label, progress? }
 */
export function shotIssue(shot, assets, busy) {
  if (!shot) return null;
  const task = shot.aiVideoTask;
  if (busy) return { kind: 'busy', label: busy.label || '处理中', progress: typeof busy.progress === 'number' ? busy.progress : null };
  if (task && (task.state === 'running' || task.state === 'queued' || task.state === 'pending')) {
    const p = typeof task.progress === 'number' ? Math.max(0, Math.min(1, task.progress > 1 ? task.progress / 100 : task.progress)) : null;
    return { kind: 'busy', label: p == null ? 'AI 生成中' : `生成中 ${Math.round(p * 100)}%`, progress: p };
  }
  if (task && (task.state === 'failed' || task.state === 'error')) return { kind: 'error', label: '生成失败，点此重试', error: task.error || '' };
  if (!hasRealFootage(shot, assets)) return { kind: 'missing', label: '缺画面' };
  return null;
}

/** 全部分镜都有真实画面时才返回 true（空分镜板返回 false） */
export function allShotsReady(shots, assets) {
  return Array.isArray(shots) && shots.length > 0 && shots.every((s) => hasRealFootage(s, assets));
}

/** 分镜当前选用的素材 id：用户素材 > AI 视频 > 实拍 > 示意（与一键初剪的取材顺序一致） */
function pickedAssetId(shot, assets) {
  const ok = (id) => !!(id && assets && assets[id]);
  return [shot.assetId, shot.aiVideoAssetId, shot.footageAssetId, shot.previzAssetId].find(ok) || null;
}

/**
 * 主轨是否还是按当前分镜剪出来的：带 shotId 的片段顺序和分镜一致，且每段用的素材就是分镜现在选的素材。
 * 一致时「进入剪辑」直接切过去，不再弹「覆盖时间线」。
 */
export function timelineMatchesBoard(project) {
  const board = Array.isArray(project && project.storyboard) ? project.storyboard : [];
  const clips = (project && project.tracks && Array.isArray(project.tracks.video)) ? project.tracks.video : [];
  const linked = clips.filter((c) => c && c.shotId);
  if (!board.length || linked.length !== board.length) return false;
  const assets = (project && project.assets) || {};
  return board.every((s, i) => {
    const c = linked[i];
    if (!s || c.shotId !== s.id) return false;
    const want = pickedAssetId(s, assets);
    return !want || c.assetId === want;
  });
}