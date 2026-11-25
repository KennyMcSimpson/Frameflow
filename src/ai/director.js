// AI 导演：创意对话、生成分镜、单镜修改（CONTRACTS §D director.js）。纯函数：只负责构造提示词与解析结果。
import {
  LOOKS, LOOK_LABELS, SHOT_SIZES, SHOT_SIZE_LABELS, ANGLES, ANGLE_LABELS, SHOT_MOVEMENTS, SHOT_MOVEMENT_LABELS, TRANSITIONS,
  PREVIZ_SETTINGS, PREVIZ_SUBJECTS, PREVIZ_ACTIONS, TECHNIQUE_CATEGORY_LABELS, ASPECTS,
  createShot, createPrevizSpec, createBrief,
} from '../engine/model.js';
import { uid } from '../engine/ids.js';
import {
  DIRECTOR_SCHEMA, STORYBOARD_SCHEMA, SHOT_SCHEMA, PLATFORMS, PACINGS, ASPECT_KEYS,
  TIMES_OF_DAY, LIGHT_DIRECTIONS, LIGHT_KEYS, LIGHT_MOODS,
} from './schemas.js';

// ---------------------------------------------------------------------------
// 通用小工具（本模块与 editor/analyze/localDirector 共用的导出放在末尾）
// ---------------------------------------------------------------------------
const FIRST_SHOT_TRANSITIONS = ['cut', 'dip-black', 'dip-white', 'crossfade'];

function oneOf(v, list, dflt) { return typeof v === 'string' && list.includes(v) ? v : dflt; }
function numIn(v, lo, hi, dflt) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}
function text(v, max = 400) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }
function strList(v, maxItems = 10, maxLen = 200) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const s of v) {
    const t = text(s, maxLen);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= maxItems) break;
  }
  return out;
}
function isHex(c) { return typeof c === 'string' && /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.test(c.trim()); }
function hasCJK(s) { return /[一-龥]/.test(s); }
function hasLatin(s) { return /[a-z]/i.test(s) && !hasCJK(s); }

export const LOOK_PALETTES = {
  none: ['#2b2f3a', '#e0a96d', '#f4efe6'],
  cinematic: ['#12343b', '#e08a4b', '#f2d0a4'],
  'film-warm': ['#3b2a20', '#e0a96d', '#f6e3c4'],
  'film-cool': ['#1f2c38', '#7fa6c4', '#e4edf3'],
  bw: ['#111111', '#808080', '#eeeeee'],
  noir: ['#0b0b0d', '#4a4a50', '#d8d8d8'],
  vintage: ['#4a3b2a', '#c79a5f', '#efe0c0'],
  'cool-night': ['#0d1526', '#3c5a8a', '#a9c3e8'],
  vivid: ['#1d3557', '#e63946', '#f1faee'],
  'soft-pastel': ['#e8d5c4', '#a8d5ba', '#fdf6ec'],
  'high-contrast': ['#000000', '#c0392b', '#ffffff'],
  moody: ['#1b1f24', '#5b6b73', '#c9b79c'],
  'golden-hour': ['#4a2c17', '#f2a541', '#ffe3b3'],
  cyberpunk: ['#120b2e', '#ff2e88', '#00e5ff'],
};

const SETTING_HINTS = [
  [/咖啡|奶茶|茶饮|饮品|cafe|coffee/i, 'cafe'],
  [/厨房|做饭|烹饪|kitchen/i, 'kitchen'],
  [/店|商场|门店|货架|shop|store/i, 'shop'],
  [/健身|运动|gym/i, 'gym'],
  [/办公|工位|会议|office/i, 'office'],
  [/家|卧室|客厅|沙发|home/i, 'home'],
  [/夜|霓虹|night/i, 'night-city'],
  [/海|沙滩|beach/i, 'beach'],
  [/山|森林|公园|草地|户外|自然|nature|park/i, 'nature'],
  [/街|路|门口|门头|street/i, 'street'],
  [/棚|背景纸|studio/i, 'studio'],
];

function guessSetting(...texts) {
  const s = texts.filter(Boolean).join(' ');
  for (const [re, setting] of SETTING_HINTS) if (re.test(s)) return setting;
  return 'studio';
}

/** 按景别/运镜/角度给出通用拍法，用于 AI 漏写时补足 */
export function genericTips(shotSize, movement, angle) {
  const tips = [];
  const size = {
    'extreme-wide': '用 0.5x 超广角，站远一些把环境全部收进画面，地平线放在上或下三分线。',
    wide: '用 1x 主摄，退到能看到主体全身和周围环境的距离（约 3–5 米）。',
    full: '用 1x 主摄，让主体从头到脚完整入画，头顶留一点空间。',
    medium: '用 1x 或 2x，取景到人物腰部附近，主体放在三分线上。',
    'medium-close': '用 2x 焦段拍胸部以上，背景自然虚化，对焦在眼睛。',
    'close-up': '用 2x 焦段靠近到 30–50 厘米，画面只留主体最重要的部分。',
    'extreme-close-up': '用微距模式或 2x–3x 焦段，离主体 10–15 厘米拍细节纹理。',
    insert: '用 2x 焦段拍一个手部或物件的细节动作，作为插入镜头。',
  }[shotSize];
  if (size) tips.push(size);
  const move = {
    'push-in': '身体带着手机缓慢向前移动 30–50 厘米，4 秒左右匀速完成，不要用手指变焦。',
    'pull-out': '从近处开始，身体匀速后退 1 米左右，结尾稳定停 1 秒。',
    'pan-left': '双脚站稳，以腰为轴从右向左匀速转动手机，4 秒完成。',
    'pan-right': '双脚站稳，以腰为轴从左向右匀速转动手机，4 秒完成。',
    'tilt-up': '手肘夹紧身体，手机从下往上匀速抬起，像点头一样慢。',
    'tilt-down': '手肘夹紧身体，手机从上往下匀速下摇，最后停在主体上。',
    shake: '轻微手持晃动即可，晃动来自身体起伏而不是手腕。',
    'zoom-punch': '先正常拍一段，后期再加冲击变焦；拍摄时让主体在画面正中。',
    drift: '手机贴着桌面或胸口极慢地横移 20 厘米，营造漂浮感。',
    handheld: '双手握持、手肘贴身，保留自然的呼吸晃动，开启普通防抖。',
    orbit: '以主体为圆心侧向小步走 60–90° 弧线，镜头始终对准主体。',
    tracking: '与主体保持 1–2 米同步移动，膝盖微屈走「忍者步」，开启防抖。',
    static: '把手机固定在三脚架或靠在稳固的物体上，录制时不要碰手机。',
    none: '把手机固定在三脚架或靠在稳固的物体上，录制时不要碰手机。',
  }[movement];
  if (move) tips.push(move);
  const ang = {
    high: '手机举高略向下拍，适合交代桌面和操作。',
    low: '把手机倒过来让镜头贴近地面向上拍，主体会显得更有气势。',
    'top-down': '手机举到正上方垂直向下拍，打开网格线保证画面边缘与桌边平行。',
    dutch: '把手机倾斜 10–15°，制造不安或动感。',
    'over-shoulder': '站在前景人物肩膀后方，肩膀占画面一侧约 1/4，对焦对面的人。',
    pov: '把手机放在眼睛高度，模拟主角第一视角。',
  }[angle];
  if (ang) tips.push(ang);
  tips.push('录制前长按画面锁定对焦和曝光，每个镜头前后多录 1–2 秒方便剪辑。');
  return tips;
}

function defaultRefs(title, subject, action, shotSize) {
  const zh = [subject || title, SHOT_SIZE_LABELS[shotSize] || '', '镜头 参考'].filter(Boolean).join(' ').slice(0, 40);
  const en = `${shotSize ? shotSize.replace(/-/g, ' ') : ''} shot cinematic b-roll`.trim();
  return [zh, en];
}

function normalizeSubjects(list, fallbackColor) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    out.push({
      kind: oneOf(s.kind, PREVIZ_SUBJECTS, 'person'),
      x: numIn(s.x, 0, 1, 0.5),
      y: numIn(s.y, 0, 1, 0.7),
      scale: numIn(s.scale, 0.2, 2, 1),
      color: isHex(s.color) ? s.color.trim() : fallbackColor,
      action: oneOf(s.action, PREVIZ_ACTIONS, 'idle'),
      label: text(s.label, 24),
    });
    if (out.length >= 4) break;
  }
  return out.length ? out : null;
}

/** 规范化 AI 给的 PrevizSpec（缺字段补默认） */
export function normalizePreviz(raw, { shotSize = 'medium', movement = 'static', angle = 'eye-level', look = 'none', hint = '' } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const lookPalette = LOOK_PALETTES[look] || LOOK_PALETTES.none;
  const palette = Array.isArray(r.palette) ? r.palette.filter(isHex).map((c) => c.trim()).slice(0, 3) : [];
  while (palette.length < 3) palette.push(lookPalette[palette.length]);
  const light = r.light && typeof r.light === 'object' ? r.light : {};
  const timeOfDay = oneOf(r.timeOfDay, TIMES_OF_DAY, 'day');
  return createPrevizSpec({
    setting: oneOf(r.setting, PREVIZ_SETTINGS, guessSetting(hint)),
    timeOfDay,
    palette,
    subjects: normalizeSubjects(r.subjects, palette[1]) || [{ kind: 'person', x: 0.5, y: 0.75, scale: 1, color: palette[1], action: 'idle', label: '' }],
    camera: { shotSize, movement, angle },
    light: {
      direction: oneOf(light.direction, LIGHT_DIRECTIONS, 'left'),
      key: oneOf(light.key, LIGHT_KEYS, timeOfDay === 'night' || timeOfDay === 'blue' ? 'cool' : 'warm'),
      mood: oneOf(light.mood, LIGHT_MOODS, timeOfDay === 'night' ? 'night' : 'soft'),
    },
    overlayText: text(r.overlayText, 60),
  });
}

/**
 * 规范化一个 AI 分镜 → Shot。
 * @param {object} raw
 * @param {number} index 1 起
 * @param {{look?:string, validTechniqueIds?:Iterable<string>, keep?:object}} [opts] keep：保留原镜头的 id/assetId/status
 */
export function normalizeAiShot(raw, index = 1, opts = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const keep = opts.keep || null;
  const shotSize = oneOf(r.shotSize, SHOT_SIZES, keep ? keep.shotSize : 'medium');
  const angle = oneOf(r.angle, ANGLES, keep ? keep.angle : 'eye-level');
  const movement = oneOf(r.movement, SHOT_MOVEMENTS, keep ? keep.movement : 'static');
  const look = oneOf(r.look, LOOKS, keep ? keep.look : (opts.look && LOOKS.includes(opts.look) ? opts.look : 'none'));
  const title = text(r.title, 40) || (keep && keep.title) || `镜头 ${index}`;
  const subject = text(r.subject, 120) || (keep ? keep.subject : '');
  const action = text(r.action, 300) || (keep ? keep.action : '');
  const location = text(r.location, 80) || (keep ? keep.location : '');

  let tips = strList(r.shootingTips, 6, 160);
  if (!tips.length && keep && Array.isArray(keep.shootingTips)) tips = strList(keep.shootingTips, 6, 160);
  if (tips.length < 3) {
    for (const t of genericTips(shotSize, movement, angle)) { if (tips.length >= 4) break; if (!tips.includes(t)) tips.push(t); }
  }

  let refs = strList(r.referenceQueries, 4, 80);
  if (!refs.length && keep && Array.isArray(keep.referenceQueries)) refs = strList(keep.referenceQueries, 4, 80);
  const [dzh, den] = defaultRefs(title, subject, action, shotSize);
  if (!refs.some(hasCJK)) refs.unshift(dzh);
  if (!refs.some(hasLatin)) refs.push(den);
  const zh = refs.find(hasCJK); const en = refs.find(hasLatin);
  refs = [zh, en, ...refs.filter((q) => q !== zh && q !== en)].filter(Boolean).slice(0, 3);

  let techniqueIds = strList(Array.isArray(r.techniqueIds) ? r.techniqueIds : (keep ? keep.techniqueIds : []), 6, 64).filter((id) => /^[A-Za-z0-9_-]+$/.test(id));
  if (opts.validTechniqueIds) {
    const valid = opts.validTechniqueIds instanceof Set ? opts.validTechniqueIds : new Set(opts.validTechniqueIds);
    techniqueIds = techniqueIds.filter((id) => valid.has(id));
  }
  techniqueIds = techniqueIds.slice(0, 4);

  let transitionIn = oneOf(r.transitionIn, TRANSITIONS, keep ? oneOf(keep.transitionIn, TRANSITIONS, 'cut') : 'cut');
  if (index === 1 && !FIRST_SHOT_TRANSITIONS.includes(transitionIn)) transitionIn = 'cut';

  return createShot({
    id: keep ? keep.id : uid('sht'),
    index,
    title,
    duration: Math.round(numIn(r.duration, 0.8, 30, keep ? keep.duration : 3.5) * 10) / 10,
    shotSize, angle, movement,
    lighting: text(r.lighting, 120) || (keep ? keep.lighting : ''),
    location,
    subject,
    action,
    caption: typeof r.caption === 'string' ? text(r.caption, 80) : (keep ? keep.caption || '' : ''),
    voiceover: typeof r.voiceover === 'string' ? text(r.voiceover, 400) : (keep ? keep.voiceover || '' : ''),
    shootingTips: tips,
    transitionIn,
    look,
    referenceQueries: refs,
    techniqueIds,
    previz: normalizePreviz(r.previz, { shotSize, movement, angle, look, hint: `${location} ${subject} ${action}` }),
    assetId: keep ? keep.assetId ?? null : null,
    status: keep ? keep.status || 'planned' : 'planned',
  });
}

/** 把分镜总时长缩放到目标时长附近（误差 >15% 时） */
export function fitShotDurations(shots, targetDuration) {
  const target = Number(targetDuration);
  if (!shots.length || !Number.isFinite(target) || target <= 0) return shots;
  const total = shots.reduce((s, x) => s + x.duration, 0);
  if (!total || Math.abs(total - target) / target <= 0.15) return shots;
  const k = target / total;
  return shots.map((s) => ({ ...s, duration: Math.max(1, Math.round(s.duration * k * 2) / 2) }));
}

/** 规范化简报补丁：只保留合法且非空的字段 */
export function normalizeBriefPatch(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const k of ['title', 'goal', 'audience', 'style', 'mood', 'music', 'keyMessage']) {
    const v = text(r[k], k === 'goal' || k === 'keyMessage' ? 400 : 120);
    if (v) out[k] = v;
  }
  if (PLATFORMS.includes(r.platform)) out.platform = r.platform;
  if (ASPECT_KEYS.includes(r.aspect)) out.aspect = r.aspect;
  if (LOOKS.includes(r.look)) out.look = r.look;
  if (PACINGS.includes(r.pacing)) out.pacing = r.pacing;
  const d = numIn(r.duration, 5, 600, null);
  if (d != null) out.duration = Math.round(d);
  if (Array.isArray(r.mustHave)) { const l = strList(r.mustHave, 12, 60); if (l.length) out.mustHave = l; }
  if (Array.isArray(r.avoid)) { const l = strList(r.avoid, 12, 60); if (l.length) out.avoid = l; }
  return out;
}

// ---------------------------------------------------------------------------
// 提示词片段
// ---------------------------------------------------------------------------
function compactBrief(brief) {
  if (!brief) return '（还没有简报）';
  const b = createBrief(brief);
  const lines = [
    `片名：${b.title || '未定'}`,
    `目的：${b.goal || '未定'}`,
    `受众：${b.audience || '未定'}`,
    `平台：${b.platform || '未定'}　画幅：${b.aspect}（${(ASPECTS[b.aspect] || {}).label || ''}）　时长：${b.duration} 秒`,
    `风格：${b.style || '未定'}　情绪：${b.mood || '未定'}　调色：${b.look}（${LOOK_LABELS[b.look] || ''}）　节奏：${b.pacing}`,
    `音乐：${b.music || '未定'}`,
    `核心信息：${b.keyMessage || '未定'}`,
  ];
  if (b.mustHave && b.mustHave.length) lines.push(`必须有：${b.mustHave.join('、')}`);
  if (b.avoid && b.avoid.length) lines.push(`避免：${b.avoid.join('、')}`);
  return lines.join('\n');
}

function compactMessages(messages, limit = 12) {
  if (!Array.isArray(messages) || !messages.length) return '（这是第一轮对话）';
  return messages.slice(-limit).map((m) => {
    const who = m && m.role === 'user' ? '用户' : '导演';
    const body = text(m && m.text, 600).replace(/\s+/g, ' ');
    const q = m && Array.isArray(m.questions) && m.questions.length ? `（当时问了：${m.questions.join(' / ')}）` : '';
    return `${who}：${body}${q}`;
  }).join('\n');
}

/** 技法卡清单：id｜分类｜标题｜一句话 */
export function techniqueCatalog(techniques, limit = 80) {
  if (!Array.isArray(techniques) || !techniques.length) return { text: '（无）', ids: [] };
  const list = techniques.filter((t) => t && t.id && t.title).slice(0, limit);
  const lines = list.map((t) => {
    const first = text(t.summary, 200).split(/[。！？]/)[0];
    return `${t.id}｜${TECHNIQUE_CATEGORY_LABELS[t.category] || t.category || ''}｜${t.title}｜${first}`;
  });
  return { text: lines.join('\n'), ids: list.map((t) => t.id) };
}

function assetCatalog(assets, limit = 40) {
  const list = Array.isArray(assets) ? assets : (assets && typeof assets === 'object' ? Object.values(assets) : []);
  const valid = list.filter((a) => a && a.id).slice(0, limit);
  if (!valid.length) return '（暂无素材）';
  return valid.map((a) => {
    const dur = Number.isFinite(a.duration) ? `${Math.round(a.duration * 10) / 10}秒` : '';
    const tags = Array.isArray(a.tags) && a.tags.length ? `｜标签：${a.tags.slice(0, 6).join('、')}` : '';
    const desc = a.description ? `｜${text(a.description, 60)}` : '';
    return `${a.id}｜${text(a.name, 40) || '素材'}｜${a.kind || ''}｜${dur}${tags}${desc}`;
  }).join('\n');
}

const ENUM_HELP = [
  `shotSize：${SHOT_SIZES.map((k) => `${k}=${SHOT_SIZE_LABELS[k]}`).join('，')}`,
  `angle：${ANGLES.map((k) => `${k}=${ANGLE_LABELS[k]}`).join('，')}`,
  `movement：${SHOT_MOVEMENTS.map((k) => `${k}=${SHOT_MOVEMENT_LABELS[k]}`).join('，')}`,
  `look：${LOOKS.map((k) => `${k}=${LOOK_LABELS[k]}`).join('，')}`,
].join('\n');

// 常用结构原型（P1）：给 AI 一个按时长分配的骨架，比「常用结构」一句话更好落地。百分比是占总时长的大致比例。
export const STRUCTURE_PROTOTYPES = [
  { id: 'product', name: '产品种草/发布', beats: '钩子：结果或反差画面（10%）→ 痛点或场景（15%）→ 产品登场与外观（20%）→ 2–3 个卖点各一镜演示（35%）→ 使用后的效果/情绪（10%）→ 落版与行动号召（10%）' },
  { id: 'store', name: '探店/美食', beats: '钩子：招牌菜或最诱人的特写（10%）→ 门头与环境（15%）→ 制作过程/细节（30%）→ 上桌与试吃反应（25%）→ 价格位置等信息与推荐语（20%）' },
  { id: 'tutorial', name: '教程/知识', beats: '钩子：先给最终效果或一个反常识结论（10%）→ 准备什么（10%）→ 3–5 个步骤各一镜，关键处特写（60%）→ 易错点提醒（10%）→ 成品回看与总结（10%）' },
  { id: 'travel', name: '旅行/vlog', beats: '钩子：最壮观或最有代入感的画面（10%）→ 出发/抵达交代（15%）→ 3–4 个场景段落，远景+细节+人（55%）→ 情绪高点（10%）→ 收尾：回望、夕阳或一句感受（10%）' },
  { id: 'story', name: '剧情/纪录', beats: '钩子：冲突或悬念（10%）→ 人物与处境（20%）→ 推进与转折（40%）→ 高潮（15%）→ 落点：结果或余味（15%）' },
  { id: 'music', name: '音乐/卡点混剪', beats: '前奏：氛围空镜（15%）→ 主歌：中景动作，跟着鼓点切（35%）→ 副歌：最强画面快切、速度变化（35%）→ 尾奏：慢下来、落版（15%）' },
];

const STRUCTURE_HELP = STRUCTURE_PROTOTYPES.map((s) => `- ${s.name}：${s.beats}`).join('\n');

const SHOT_RULES = `【分镜规则】
1. 镜头数量：按总时长和节奏安排，平均每镜 fast 2–3 秒、medium 3–5 秒、slow 5–7 秒；一般 4–12 镜，全部 duration 之和应约等于简报总时长。
2. 第 1 镜必须是 3 秒内抓住观众的钩子（最好看的画面、反差、结果或问题）；最后一镜给出品牌落版 / 行动号召 / 情绪落点。
3. 景别要有远—中—近—特写的变化，避免连续两镜景别和角度都相同；运镜服务于情绪，不要每镜都运动。
4. shootingTips：每镜 3–4 条，每条不超过 45 个字，写给只有手机、没学过拍摄的小白，每条一句话、可以照做。要具体到：手机横拿还是竖拿、站在哪里/离主体多远、用 0.5x/1x/2x/3x 哪个焦段、光从哪边来/灯或反光板放哪、是否开慢动作（120 帧）或延时、提前准备什么道具、一次录多长。不要写空话（如「注意构图」「拍得好看」）。
5. referenceQueries：恰好 2 条，第一条中文（适合在 B站/抖音 搜到类似镜头），第二条英文（适合在 YouTube/Pexels 搜索），描述画面内容与拍法，不要写品牌名。
6. techniqueIds：每镜 1–3 个，只能从【可用技法卡】列表里原样复制 id，禁止编造。
7. look 全片统一使用简报的调色风格（除非用户要求某镜不同）；第 1 镜 transitionIn 只能是 cut、dip-black、dip-white、crossfade；其余转场克制使用，与节奏匹配。
8. caption 是屏幕字幕（短句，不超过 14 个字，不需要时为空字符串）；voiceover 是旁白/口播（不需要时为空字符串）。
9. previz 用来生成「AI 预演」动态分镜，教用户怎么拍：setting 选最接近的场景；timeOfDay 与光线一致；palette 给 3 个与调色风格一致的十六进制颜色；subjects 1–4 个主体（x、y 为 0–1 的画面位置，y 是主体底部所在高度，通常 0.6–0.95；scale 0.2–2，特写时 1.4–2；action 与镜头动作一致；label 用 2–6 个字标注）；light.direction 与 lighting 描述一致；overlayText 只有片头标题或品牌落版时才写，否则为空字符串。
10. 如果用户已有素材，在对应镜头的 action 里注明「可用素材：素材名」。
11. 每镜都要有明确的作用（钩子、交代、卖点、步骤、情绪、收尾……），title 写成「作用·画面」，例如「钩子·拉花特写」「卖点·奶盖挂杯」；说不出作用的镜头就删掉。
12. 每镜的 subject、location、action、lighting 都要单独写完整，不写「同上」「同前」「继续上一镜」：每镜会单独拿去生成预演和 AI 视频。
13. movement 只表示手机/相机怎么动；人和物怎么动写在 action 里，action 里不要再写「镜头推近」这类运镜。需要交代开头或结尾画面时，写成静止的快照（谁在哪、什么姿态、什么光），不写过程。
14. 机位尽量少：同一场景复用 2–3 个固定机位，复用时在 shootingTips 里写「机位同第 N 镜」，省去反复搬手机和重新布光。
15. voiceover 每镜最多一句，每个人每镜最多一句台词；字数按每秒约 4 个字估算，必须能在这一镜的时长里说完。
【常用结构（按题材挑一个做骨架，再按用户的想法调整）】
${STRUCTURE_HELP}
【事实边界】
- 只根据用户说过的话、创意简报和素材清单陈述事实。店名、价格、地址、营业时间、产品参数、功效、人名、数据这类没给出的信息不要编，字幕和旁白里用「（价格待填）」这样的占位，并在 reply 里提醒用户补充。
- 广告口播、赞助商信息、片头片尾模板、预告、扫码/关注引导、平台水印属于非剧情内容：不要把用户素材里的这类片段选进分镜；行动号召只放在最后一镜，最多一句。
【枚举含义】
${ENUM_HELP}`;

const DIRECTOR_SYSTEM = `你是「镜流 Frameflow」里的 AI 导演：一位既懂拍摄又懂剪辑的资深短视频导演兼摄影指导。你熟悉抖音、小红书、视频号、B站、YouTube 的内容规律（前 3 秒钩子、完播率、竖屏构图、字幕习惯、平台常见时长），也懂产品广告、探店、vlog、教程、剧情短片的常用结构。
你的用户大多是不会拍也不会剪的小白，只有一部手机。你的任务是用白话和他们讨论想拍什么，帮他们定下创意简报，最后给出一份照着就能拍的分镜。

【说话方式】
- 中文，口语、亲切、专业、简洁；先肯定用户的想法，再给具体建议；术语要顺带一句白话解释。
- reply 控制在 2–5 句话：复述你理解的需求 → 给 1–2 个具体的创意方向或钩子点子 → 说明下一步。

【对话策略】
1. 先判断信息是否足够。关键信息：拍什么（主题/产品/店铺）、发布平台（决定画幅与时长）、目标受众、时长、风格/情绪、是否已有拍好的素材、用手机还是相机拍。
2. 信息不够时：在 questions 里提 2–4 个最关键、最好回答的问题（每个一句话，可以附选项，如「发抖音竖屏，还是 B站横屏？」），不要一次问超过 4 个，也不要重复问已经回答过的问题。此时 readyForStoryboard=false，storyboard=null。
3. 用户已回答，或说「你定」「随便」「直接出」时，用专业判断补全缺失项（例如抖音默认 9:16、15–30 秒、节奏偏快），不要反复追问。
4. briefPatch：只填写本轮新确定或要修改的字段，其余一律 null。platform 与 aspect 要一致（抖音/小红书/视频号默认 9:16，B站/YouTube 默认 16:9）；duration 单位为秒；look 从调色风格枚举中选最贴切的；title 可以帮用户起一个好记的片名。
5. readyForStoryboard：当主题、平台或画幅、时长、风格都已明确（或用户要求直接出）时为 true，并在 reply 里提示「可以点『生成分镜』了」。
6. storyboard：只有当用户明确要求出分镜（如「出分镜」「开始吧」「给我分镜」）且信息足够时，才输出完整分镜数组；其余情况为 null。

${SHOT_RULES}`;

const STORYBOARD_SYSTEM = `你是「镜流 Frameflow」里的 AI 导演兼摄影指导，要为一位只有手机、没有拍摄经验的用户写一份可以直接照着拍的分镜脚本。
分镜要专业（景别、角度、运镜、光线、转场有设计感、有节奏变化），同时每个镜头的拍法要具体到小白能直接执行。
reply：用 2–4 句话说明整体思路（钩子怎么抓人、节奏如何起伏、结尾如何收）和拍摄前最重要的准备。
styleGuide：写成全片风格指南，3–6 句，涵盖调色、光线、运镜、剪辑节奏、字幕样式、音乐与环境声；后续 AI 精修会严格按它保持全片一致。

${SHOT_RULES}`;

const SHOT_REFINE_SYSTEM = `你是「镜流 Frameflow」里的 AI 导演。用户想修改分镜中的一个镜头。请根据用户的要求只修改相关部分，其余内容保持原样（原样输出）；如果修改影响拍法、光线或预演，要同步更新 shootingTips、lighting、previz，保证它们彼此一致。

${SHOT_RULES}`;

function shotForPrompt(shot) {
  if (!shot) return '{}';
  const s = createShot(shot);
  const { id, index, assetId, status, previz, ...rest } = s;
  const pv = previz ? { setting: previz.setting, timeOfDay: previz.timeOfDay, palette: previz.palette, subjects: previz.subjects, light: previz.light, overlayText: previz.overlayText || '' } : null;
  return JSON.stringify({ ...rest, previz: pv });
}

// ---------------------------------------------------------------------------
// 导出：导演对话
// ---------------------------------------------------------------------------
// 提示词顺序（P0-5 L5）：越稳定的越靠前——技法卡、素材几乎每轮都一样，能命中模型的前缀缓存；
// 简报和对话逐轮变化放中间；用户最新消息永远在最后。
export function buildDirectorRequest({ brief, messages, userText, techniques, assets } = {}) {
  const cat = techniqueCatalog(techniques);
  const prompt = [
    '【可用技法卡（techniqueIds 只能用这里的 id）】',
    cat.text,
    '',
    '【用户已有素材】',
    assetCatalog(assets),
    '',
    '【当前创意简报】',
    compactBrief(brief),
    '',
    '【对话记录（最近）】',
    compactMessages(messages),
    '',
    '【用户最新消息】',
    text(userText, 2000) || '（用户没有输入文字，请主动引导）',
    '',
    '请以 AI 导演身份回复，并严格按 JSON 结构输出。',
  ].join('\n');
  return { task: 'director', system: DIRECTOR_SYSTEM, prompt, schema: DIRECTOR_SCHEMA, timeoutMs: 480000 };
}

export function parseDirectorResponse(data, opts = {}) {
  const d = data && typeof data === 'object' ? data : {};
  const briefPatch = normalizeBriefPatch(d.briefPatch);
  const questions = strList(d.questions, 4, 120);
  let storyboard = null;
  if (Array.isArray(d.storyboard) && d.storyboard.length) {
    const look = briefPatch.look || (opts.brief && opts.brief.look) || 'none';
    const shots = d.storyboard.slice(0, 30).map((s, i) => normalizeAiShot(s, i + 1, { look, validTechniqueIds: opts.validTechniqueIds }));
    const target = briefPatch.duration || (opts.brief && opts.brief.duration);
    storyboard = fitShotDurations(shots, target);
  }
  let reply = text(d.reply, 2000);
  if (!reply) reply = storyboard ? '分镜已经生成好了，你可以逐个查看拍法，或者直接一键初剪看看效果。' : (questions.length ? '我还需要了解几件事：' : '收到，我们继续聊聊你的想法。');
  return {
    reply,
    briefPatch,
    questions,
    storyboard,
    readyForStoryboard: !!storyboard || d.readyForStoryboard === true,
  };
}

// ---------------------------------------------------------------------------
// 导出：生成分镜
// ---------------------------------------------------------------------------
export function buildStoryboardRequest({ brief, messages, techniques, assets, project } = {}) {
  const b = createBrief(brief || (project && project.brief) || {});
  const cat = techniqueCatalog(techniques);
  const avg = { fast: 2.5, medium: 4, slow: 6 }[b.pacing] || 4;
  const suggested = Math.max(4, Math.min(12, Math.round(b.duration / avg)));
  const old = project && Array.isArray(project.storyboard) && project.storyboard.length
    ? project.storyboard.map((s, i) => `${i + 1}. ${s.title}（${s.duration}秒，${SHOT_SIZE_LABELS[s.shotSize] || s.shotSize}）`).join('\n')
    : '';
  const prompt = [
    '【可用技法卡（techniqueIds 只能用这里的 id）】',
    cat.text,
    '',
    '【用户已有素材】',
    assetCatalog(assets || (project && project.assets)),
    '',
    '【风格指南（已有，可沿用并完善）】',
    (project && project.memory && project.memory.styleGuide) || '（暂无）',
    '',
    '【创意简报】',
    compactBrief(b),
    '',
    `【硬性要求】总时长约 ${b.duration} 秒，画幅 ${b.aspect}，建议 ${suggested} 个镜头左右；调色统一用 ${b.look}。${b.aspect === '9:16' ? '竖屏：主体放在画面中部偏上，字幕区留在下方 1/4，拍法里提醒「手机竖拿」。' : '横屏：拍法里提醒「手机横拿」。'}`,
    '',
    '【和用户的讨论（最近）】',
    compactMessages(messages, 10),
    '',
    old ? `【之前的分镜（用户要求重新生成，可参考但要改进）】\n${old}\n` : '',
    '请先按题材选一个常用结构做骨架，再输出完整分镜（shots 按播放顺序）、全片风格指南和给用户的说明，严格按 JSON 结构。',
  ].filter((x) => x !== '').join('\n');
  return { task: 'storyboard', system: STORYBOARD_SYSTEM, prompt, schema: STORYBOARD_SCHEMA, timeoutMs: 720000 };
}

export function parseStoryboardResponse(data, opts = {}) {
  const d = data && typeof data === 'object' ? data : {};
  const rawShots = Array.isArray(d.shots) ? d.shots.filter((s) => s && typeof s === 'object') : [];
  if (!rawShots.length) throw new Error('AI 没有返回任何分镜，请重试或补充更多想法');
  const look = (opts.brief && opts.brief.look) || opts.look || 'none';
  let shots = rawShots.slice(0, 30).map((s, i) => normalizeAiShot(s, i + 1, { look, validTechniqueIds: opts.validTechniqueIds }));
  shots = fitShotDurations(shots, (opts.brief && opts.brief.duration) || opts.targetDuration);
  return {
    shots,
    styleGuide: text(d.styleGuide, 2000),
    reply: text(d.reply, 2000) || `已生成 ${shots.length} 个分镜，每个镜头都附有拍法和参考搜索词。`,
  };
}

// ---------------------------------------------------------------------------
// 导出：单镜修改
// ---------------------------------------------------------------------------
export function buildShotRefineRequest({ brief, shot, instruction, techniques } = {}) {
  const cat = techniqueCatalog(techniques);
  const prompt = [
    '【可用技法卡（techniqueIds 只能用这里的 id）】',
    cat.text,
    '',
    '【创意简报】',
    compactBrief(brief),
    '',
    `【要修改的镜头（第 ${(shot && shot.index) || 1} 镜）】`,
    shotForPrompt(shot),
    '',
    '【用户的修改要求】',
    text(instruction, 1000) || '请把这个镜头优化得更好拍、更好看。',
    '',
    '请输出修改后的完整镜头，严格按 JSON 结构。',
  ].join('\n');
  return { task: 'shot', system: SHOT_REFINE_SYSTEM, prompt, schema: SHOT_SCHEMA, timeoutMs: 240000 };
}

export function parseShotRefineResponse(data, shot, opts = {}) {
  const base = createShot(shot || {});
  const d = data && typeof data === 'object' ? data : {};
  const out = normalizeAiShot(d, base.index || 1, { look: base.look, validTechniqueIds: opts.validTechniqueIds, keep: base });
  // 预演没给就保留原预演
  if (!d.previz || typeof d.previz !== 'object') out.previz = createPrevizSpec({ ...base.previz, camera: { shotSize: out.shotSize, movement: out.movement, angle: out.angle } });
  return out;
}
