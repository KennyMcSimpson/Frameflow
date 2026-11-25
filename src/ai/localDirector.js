// 本地导演（CONTRACTS §D localDirector.js）：没有 AI 时的兜底。
// 基于关键词抽取需求、提问，用主题模板 × 时长生成分镜，并从拆片统计数据推断技法卡。纯函数。
import { createBrief, createShot, createPrevizSpec, ASPECTS, LOOK_LABELS } from '../engine/model.js';
import { uid } from '../engine/ids.js';
import { LOOK_PALETTES } from './director.js';

// ===========================================================================
// 需求抽取
// ===========================================================================
const PLATFORM_RULES = [
  [/抖音|douyin|tiktok/i, '抖音'],
  [/小红书|红书|xhs/i, '小红书'],
  [/b站|哔哩|bilibili|阿b/i, 'B站'],
  [/youtube|油管/i, 'YouTube'],
  [/朋友圈|视频号|微信/i, '朋友圈'],
];
const PLATFORM_ASPECT = { 抖音: '9:16', 小红书: '9:16', 朋友圈: '9:16', B站: '16:9', YouTube: '16:9', 其他: '16:9' };
const PLATFORM_DURATION = { 抖音: 20, 小红书: 30, 朋友圈: 20, B站: 60, YouTube: 60, 其他: 30 };

const ASPECT_RULES = [
  [/竖屏|竖版|竖着|竖向|9\s*[:：比]\s*16/, '9:16'],
  [/横屏|横版|横着|横向|16\s*[:：比]\s*9/, '16:9'],
  [/方形|正方形|1\s*[:：比]\s*1/, '1:1'],
  [/宽银幕|21\s*[:：比]\s*9/, '21:9'],
  [/4\s*[:：比]\s*3/, '4:3'],
];

const STYLE_RULES = [
  [/赛博|霓虹|未来感/, { look: 'cyberpunk', style: '赛博霓虹', mood: '酷、未来感' }],
  [/黑白/, { look: 'bw', style: '黑白影像', mood: '沉静、有力量' }],
  [/黑色电影|悬疑|暗黑/, { look: 'noir', style: '黑色悬疑', mood: '神秘、紧张' }],
  [/复古|怀旧|胶片感?|老电影|港风/, { look: 'vintage', style: '复古胶片', mood: '怀旧、有故事' }],
  [/日系|清新|小清新|干净/, { look: 'soft-pastel', style: '日系清新', mood: '干净、轻盈' }],
  [/黄金|日落|夕阳/, { look: 'golden-hour', style: '黄金时刻', mood: '浪漫、温暖' }],
  [/电影感|大片|史诗|质感/, { look: 'cinematic', style: '电影感', mood: '沉浸、高级' }],
  [/高级|简约|极简|冷淡/, { look: 'film-cool', style: '高级简约', mood: '克制、精致' }],
  [/情绪|文艺|伤感|孤独|深夜/, { look: 'moody', style: '文艺情绪', mood: '安静、有心事' }],
  [/活力|鲜艳|潮|热闹|青春|可爱|搞笑/, { look: 'vivid', style: '活力潮流', mood: '明快、有趣' }],
  [/温暖|治愈|温馨|暖|舒服|松弛/, { look: 'film-warm', style: '温暖治愈', mood: '温暖、松弛' }],
  // 只定情绪不定色调：「节奏轻快」的咖啡店仍用主题默认的暖色
  [/轻快|明快|欢快|俏皮|元气/, { style: '轻快明亮', mood: '轻快、明亮' }],
];

const PACING_RULES = [
  [/快节奏|卡点|节奏快|动感|炸裂|燃|快剪|轻快|明快|欢快|紧凑|利落/, 'fast'],
  [/慢节奏|舒缓|安静|节奏慢|缓慢|慢一点/, 'slow'],
  [/中等节奏|节奏适中/, 'medium'],
];

const AUDIENCE_WORDS = ['大学生', '学生党', '学生', '上班族', '白领', '打工人', '年轻人', '宝妈', '妈妈', '家长', '中老年', '老人', '女生', '男生', '情侣', '小朋友', '孩子', '游客', '吃货', '健身党', '新手', '小白', '创业者', '附近居民'];

const FORCE_WORDS = /你定|你来定|随便|都行|直接(出|给|生成|开始)|先出|生成分镜|出分镜|给我分镜|写分镜|开始吧|就这样|可以开始|没问题/;
const STORYBOARD_WORDS = /生成分镜|出分镜|给我分镜|写分镜|直接出|直接给|开始吧/;

const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnToNumber(s) {
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === '十') return 10;
  let total = 0; let cur = 0; let seen = false;
  for (const ch of s) {
    if (ch in CN_DIGIT) { cur = CN_DIGIT[ch]; seen = true; }
    else if (ch === '十') { total += (cur || 1) * 10; cur = 0; seen = true; }
    else if (ch === '百') { total += (cur || 1) * 100; cur = 0; seen = true; }
    else return null;
  }
  return seen ? total + cur : null;
}

/** 从文本中抽取目标时长（秒）。忽略「前 3 秒」「3 秒钩子」这类描述 */
export function extractDuration(textIn) {
  const s = String(textIn || '');
  let found = null;
  const NUM = '(\\d+(?:\\.\\d+)?|[一二两三四五六七八九十百]+)';
  const minRe = new RegExp(`${NUM}\\s*(?:个)?\\s*(?:分钟|min)(半)?|${NUM}\\s*分半|半\\s*分钟`, 'gi');
  let m;
  while ((m = minRe.exec(s))) {
    if (/^半/.test(m[0])) { found = 30; continue; }
    const v = cnToNumber(m[1] || m[3]);
    if (v == null) continue;
    const half = !!m[2] || /分半$/.test(m[0]);
    found = v * 60 + (half ? 30 : 0);
  }
  const secRe = new RegExp(`${NUM}\\s*(?:秒钟?|s\\b|sec\\b)`, 'gi');
  while ((m = secRe.exec(s))) {
    const before = s.slice(Math.max(0, m.index - 2), m.index);
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 3);
    if (/前|开头|每|头|第/.test(before) || /钩子|内|一镜|一个镜头|一条/.test(after)) continue;
    const v = cnToNumber(m[1]);
    if (v != null) found = v;
  }
  return found == null ? null : Math.max(5, Math.min(600, Math.round(found)));
}

// ===========================================================================
// 主题
// ===========================================================================
const TOPIC_RULES = [
  ['unboxing', /开箱|拆箱|拆快递/],
  ['wedding', /婚礼|婚纱|婚庆|结婚|求婚/],
  ['pet', /宠物|猫咪|小猫|狗狗|小狗|萌宠|猫|狗/],
  ['fitness', /健身|瑜伽|跑步|撸铁|减脂|增肌|运动/],
  ['tutorial', /教程|教学|教你|教大家|怎么做|技巧|干货|科普|知识/],
  ['travel', /旅行|旅游|旅拍|景点|打卡|风景|度假|自驾/],
  ['drink', /咖啡|奶茶|茶饮|饮品|果茶|甜品|面包|烘焙|酒吧/],
  ['food', /美食|做饭|餐厅|火锅|烧烤|料理|小吃|探店|饭店|下厨|菜谱/],
  ['fashion', /穿搭|服装|衣服|时尚|美妆|化妆|护肤|发型/],
  ['vlog', /vlog|日常|一天|生活记录|记录生活/i],
  ['product', /产品|好物|种草|带货|广告|宣传|新品|品牌|商品|店/],
];

export const TOPIC_LABELS = {
  drink: '饮品店 / 咖啡探店', food: '美食', travel: '旅行', product: '产品宣传', unboxing: '开箱测评', vlog: '生活 vlog',
  fitness: '健身运动', pet: '萌宠', wedding: '婚礼', tutorial: '教程干货', fashion: '穿搭美妆', generic: '短视频',
};

const TOPIC_KIND = {
  drink: '宣传', food: '美食宣传', travel: '旅行', product: '产品宣传', unboxing: '开箱测评', vlog: '生活记录',
  fitness: '运动', pet: '萌宠', wedding: '婚礼纪实', tutorial: '教程', fashion: '穿搭', generic: '',
};

export function detectTopic(textIn) {
  const s = String(textIn || '');
  for (const [key, re] of TOPIC_RULES) if (re.test(s)) return key;
  return null;
}

/** 主题的默认风格 */
const TOPIC_DEFAULTS = {
  drink: { look: 'film-warm', pacing: 'medium', style: '温暖治愈的探店短片', mood: '温暖、松弛', music: '轻柔原声吉他或 Lo-fi，保留制作过程的环境声', goal: '让附近的人看完想来店里喝一杯', audience: '附近的上班族和喜欢探店的年轻人', key: '这家店值得专门来一趟' },
  food: { look: 'vivid', pacing: 'medium', style: '诱人有烟火气的美食短片', mood: '诱人、满足', music: '轻快的 Funk 或爵士，保留切菜、滋啦的声音', goal: '让人看饿、想吃、想来', audience: '喜欢美食的年轻人和周边食客', key: '好吃，而且看得见用料' },
  travel: { look: 'cinematic', pacing: 'medium', style: '有呼吸感的旅行大片', mood: '向往、自由', music: '大气的民谣或电子氛围乐，在高潮处上鼓点', goal: '记录旅途并让人产生向往', audience: '喜欢旅行、想去同款目的地的人', key: '这个地方值得亲自来一次' },
  product: { look: 'high-contrast', pacing: 'fast', style: '干净利落的产品广告', mood: '自信、高级', music: '节奏明确的电子或 Hip-Hop 律动', goal: '让观众快速记住产品卖点并产生购买欲', audience: '对这类产品有需求的目标用户', key: '一句话说清它解决什么问题' },
  unboxing: { look: 'vivid', pacing: 'fast', style: '节奏明快的开箱测评', mood: '期待、惊喜', music: '轻快律动，开箱瞬间加音效', goal: '真实展示产品并给出购买建议', audience: '正在考虑购买这款产品的人', key: '值不值得买，一句话告诉你' },
  vlog: { look: 'soft-pastel', pacing: 'medium', style: '真实松弛的生活 vlog', mood: '轻松、真实', music: '轻快的 Lo-fi 或独立民谣', goal: '记录生活并让人产生共鸣', audience: '喜欢看日常生活的同龄人', key: '普通的一天也可以很好看' },
  fitness: { look: 'high-contrast', pacing: 'fast', style: '燃而有力量的运动短片', mood: '热血、坚持', music: '强鼓点的电子或 Trap，动作对齐重拍', goal: '展示训练成果并激励观众开始运动', audience: '想开始运动或正在健身的年轻人', key: '坚持的样子最好看' },
  pet: { look: 'soft-pastel', pacing: 'medium', style: '软萌治愈的宠物日常', mood: '可爱、治愈', music: '俏皮的尤克里里或木琴', goal: '展示宠物的可爱瞬间，治愈观众', audience: '喜欢猫狗的人和铲屎官', key: '今天也被它治愈了' },
  wedding: { look: 'golden-hour', pacing: 'slow', style: '浪漫深情的婚礼纪实', mood: '浪漫、感动', music: '钢琴与弦乐，誓词段落压低音乐', goal: '记录最珍贵的时刻，留给两个人和家人', audience: '新人、亲友', key: '把这一天完整地留下来' },
  tutorial: { look: 'none', pacing: 'medium', style: '清晰直接的干货讲解', mood: '清楚、可信', music: '音量很低的轻音乐，不抢人声', goal: '让观众看完就能学会并愿意收藏', audience: '想学这项技能的新手', key: '跟着做就能学会' },
  fashion: { look: 'film-cool', pacing: 'fast', style: '有态度的穿搭/美妆短片', mood: '自信、有型', music: '有律动的 R&B 或电子，换装对齐鼓点', goal: '展示搭配效果并让人想收藏同款', audience: '同龄、同身形的时尚爱好者', key: '这样穿/这样化，马上变好看' },
  generic: { look: 'cinematic', pacing: 'medium', style: '清晰有质感的短片', mood: '专注、有质感', music: '节奏适中的轻音乐，在重点段落加强', goal: '把想说的事情讲清楚并让人记住', audience: '对这个主题感兴趣的人', key: '一句话说清你最想让观众记住什么' },
};

/** 从一段文本抽取简报字段（只返回真正提到的） */
export function extractBriefPatch(textIn) {
  const s = String(textIn || '');
  const patch = {};
  for (const [re, p] of PLATFORM_RULES) if (re.test(s)) { patch.platform = p; break; }
  for (const [re, a] of ASPECT_RULES) if (re.test(s)) { patch.aspect = a; break; }
  const d = extractDuration(s);
  if (d != null) patch.duration = d;
  const styles = [];
  for (const [re, st] of STYLE_RULES) {
    if (re.test(s)) {
      if (!patch.look && st.look) patch.look = st.look;
      if (!patch.mood) patch.mood = st.mood;
      styles.push(st.style);
    }
  }
  if (styles.length) patch.style = styles.slice(0, 2).join('、');
  for (const [re, p] of PACING_RULES) if (re.test(s)) { patch.pacing = p; break; }
  const aud = AUDIENCE_WORDS.filter((w) => s.includes(w));
  if (aud.length) patch.audience = Array.from(new Set(aud)).slice(0, 3).join('、');
  return patch;
}

// 「咖啡店」「奶茶店」这类通称不是店名：可以进标题，但不能当成品牌名写进字幕（事实边界）
const SUBJECT_ADJ = '(?:小|新开的?|老|社区|街角|楼下|附近|网红|宝藏|私房|独立|精品|本地)?';
const SUBJECT_CATEGORY = '(?:咖啡|奶茶|茶饮|饮品|甜品|面包|烘焙|蛋糕|美食|火锅|烧烤|小吃|西餐|中餐|日料|快餐|早餐|酒|花|鲜花|服装|书|宠物|健身|理发|美甲|美容|水果|零食|茶|面)?';
const GENERIC_SHOP_RE = new RegExp(`^${SUBJECT_ADJ}${SUBJECT_CATEGORY}(?:店|馆|餐厅|工作室|餐吧)$`);
const NAME_PREFIX_RE = /^(?:我想给|我想为|我想|我要给|我要|帮我|帮忙|给我|请你|想给|想为|想要|想|打算|准备|给|为|做个|做一个|做一支|做一条|拍个|拍一个|拍一支|拍一条|剪个|剪一个|来个|来一个|搞个|搞一个|我的|我们家的|我们的|我家的|我家|我们|一家|一个|这家|那家|自己的|家里的)+/;
// 「30 秒的咖啡店」里的「秒的」
const DURATION_PREFIX_RE = /^[\d.一二两三四五六七八九十百半]*(?:秒钟?|分钟|分半?)的?/;

/**
 * 从文本里找拍摄对象。name 是真名（用户说了店名/品牌），kind 是通称（咖啡店）。
 * 只有 name 能写进字幕和必拍清单；只有通称时字幕用「（店名待填）」占位。
 */
function extractSubject(textIn) {
  const src = String(textIn || '');
  const named = /(?:叫做?|名字是|品牌是)\s*[「“"《]?([一-龥A-Za-z0-9·&]{2,12}?)[」”"》]?(?:的|，|,|。|\s|$)/.exec(src);
  if (named) return { name: named[1], kind: '' };
  const quoted = /[「“"《]([^「」“”"《》]{2,12})[」”"》]/.exec(src);
  if (quoted) return { name: quoted[1], kind: '' };
  // 取最近的那个「店」，并排除「探店」
  const m = /[一-龥A-Za-z0-9]{1,8}?(?<!探)(?:店|馆|餐厅|工作室|餐吧)/.exec(src);
  if (!m) return { name: '', kind: '' };
  let s = m[0];
  for (let i = 0; i < 4; i++) {
    const next = s.replace(NAME_PREFIX_RE, '').replace(DURATION_PREFIX_RE, '').replace(/^的/, '');
    if (next === s) break;
    s = next;
  }
  // 「楼下新开的咖啡店」「阿明的咖啡店」：只看最后一个「的」后面
  s = s.split('的').pop();
  if (s.length < 2) return { name: '', kind: '' };
  return GENERIC_SHOP_RE.test(s) ? { name: '', kind: s } : { name: s, kind: '' };
}

function detectFootage(s) {
  if (/没(有)?(拍|素材)|还没拍|没拍过|零素材|从头拍/.test(s)) return false;
  if (/已经?拍(好|了)|拍好了|有(现成的?)?(素材|视频|片子)|手上有/.test(s)) return true;
  return null;
}
function detectDevice(s) {
  if (/手机|iphone|苹果|华为|小米|安卓/i.test(s)) return 'phone';
  if (/相机|单反|微单|摄像机|gopro|无人机|稳定器/i.test(s)) return 'camera';
  return null;
}

function userTexts(messages, userText) {
  const list = Array.isArray(messages) ? messages.filter((m) => m && m.role === 'user' && typeof m.text === 'string').map((m) => m.text) : [];
  const last = typeof userText === 'string' ? userText.trim() : '';
  if (last && list[list.length - 1] !== last) list.push(last);
  return list;
}

function topicHook(topic) {
  return {
    drink: '开头可以直接放一个奶盖/拉花/冰块落杯的慢动作特写，3 秒内让人想喝。',
    food: '开头直接上最诱人的一口：拉丝、冒热气或一勺浇下去的慢动作。',
    travel: '开头用目的地最震撼的一个画面，配一句「如果只能来一次，一定要看这里」。',
    product: '开头先抛痛点或最惊艳的使用结果，让人好奇它怎么做到的。',
    unboxing: '开头先放成品上手的一幕，再回到拆箱，悬念感更强。',
    vlog: '开头用一句很有共鸣的话配一个有动作的画面，别用慢慢的空镜开场。',
    fitness: '开头放前后对比或者最燃的一个动作，配合重鼓点。',
    pet: '开头放它最搞笑或最可爱的一个瞬间，让人直接笑出来。',
    wedding: '开头用誓词或父亲牵手的声音铺底，配一个细节特写，一下子把情绪拉住。',
    tutorial: '开头直接展示学会后的效果，并说「30 秒教你做到」。',
    fashion: '开头来一个遮挡转场换装，前后反差立刻抓眼球。',
    generic: '开头放全片最吸引人的画面或一个问题，前 3 秒决定观众会不会留下来。',
  }[topic] || '';
}

/**
 * 本地导演对话。返回与 parseDirectorResponse 同形。
 */
export function localDirectorReply({ brief, messages, userText } = {}) {
  const texts = userTexts(messages, userText);
  const all = texts.join('\n');
  const latest = texts[texts.length - 1] || '';
  // 按时间顺序抽取，后说的覆盖先说的
  const extracted = {};
  for (const t of texts) {
    const p = extractBriefPatch(t);
    if (p.style && extracted.style && !extracted.style.includes(p.style)) p.style = `${extracted.style}、${p.style}`.split('、').slice(-2).join('、');
    Object.assign(extracted, p);
  }
  const base = brief ? createBrief(brief) : null;
  const topic = detectTopic(all) || detectTopic(base ? `${base.title} ${base.goal} ${base.style}` : '');
  const { name, kind } = extractSubject(all);
  const tanDian = /探店/.test(all);

  // 简报里的默认值（30 秒 / 16:9 / 其他）不算「用户已确定」，除非简报已经基本填好
  const briefFilled = !!(base && base.style && base.platform && base.platform !== '其他');
  const known = {
    platform: extracted.platform || (base && base.platform && base.platform !== '其他' ? base.platform : null),
    duration: extracted.duration || (base && base.duration && (base.duration !== 30 || briefFilled) ? base.duration : null),
    style: extracted.style || (base && base.style) || null,
    audience: extracted.audience || (base && base.audience) || null,
    aspect: extracted.aspect || (base && base.aspect && (base.aspect !== '16:9' || briefFilled) ? base.aspect : null),
  };
  const footage = detectFootage(all);
  const device = detectDevice(all);
  const force = FORCE_WORDS.test(latest);
  const askedStoryboard = STORYBOARD_WORDS.test(latest);

  const patch = { ...extracted };
  const topicKey = topic || 'generic';
  const dflt = TOPIC_DEFAULTS[topicKey];

  if (known.platform && !extracted.aspect && !known.aspect) patch.aspect = PLATFORM_ASPECT[known.platform] || '16:9';
  if (topic) {
    // 标题：真名优先；只有通称（咖啡店）时用「咖啡店探店」这类描述，不编店名
    const label = name || (kind ? `${kind}${tanDian ? '探店' : ''}` : `${TOPIC_LABELS[topic]}${tanDian && !/探店/.test(TOPIC_LABELS[topic]) ? '探店' : ''}`);
    if (!base || !base.title) patch.title = `${label}${/视频|短片|片$/.test(label) ? '' : (/宣传片/.test(all) ? '宣传片' : '短片')}`;
    if (!base || !base.goal) patch.goal = dflt.goal;
    if (!patch.look && (!base || !base.look || base.look === 'none') && dflt.look !== 'none') patch.look = dflt.look;
    if (!patch.pacing && (!base || (base.pacing === 'medium' && !briefFilled))) patch.pacing = dflt.pacing;
    if (!base || !base.music) patch.music = dflt.music;
    if (!base || !base.keyMessage) patch.keyMessage = dflt.key;
    if (!patch.mood && (!base || !base.mood)) patch.mood = dflt.mood;
    const must = name ? `${name}的名字与门面/产品` : kind ? '门头招牌与店名' : '';
    if (must) patch.mustHave = Array.from(new Set([...(base && base.mustHave) || [], must]));
  }

  const hasAspect = !!(known.aspect || patch.aspect);
  // 主题 + 平台/画幅 + 时长就够出分镜；风格、受众没说就按主题默认，并在回复里交代
  const ready = !!topic && !!(known.platform || hasAspect) && !!known.duration;
  let readyForStoryboard = ready;
  if (ready) {
    if (!known.style) patch.style = dflt.style;
    if (!known.audience) patch.audience = dflt.audience;
  }

  // 用户说「你定」时，用专业默认补全
  if (force && (topic || base)) {
    const platform = known.platform || '抖音';
    if (!known.platform) patch.platform = platform;
    if (!hasAspect) patch.aspect = PLATFORM_ASPECT[platform] || '9:16';
    if (!known.duration) patch.duration = PLATFORM_DURATION[platform] || 30;
    if (!known.style) patch.style = dflt.style;
    if (!known.audience) patch.audience = dflt.audience;
    readyForStoryboard = true;
  }

  // 问题：先问出分镜必需的（主题、平台、时长），再最多补一个可选的，一次不超过 3 个
  const questions = [];
  if (!readyForStoryboard) {
    if (!topic) questions.push('这次想拍什么？比如一家店、一款产品、一次旅行、日常 vlog，或者一个教程？');
    if (!known.platform && !hasAspect) questions.push('打算发在哪个平台？抖音/小红书适合竖屏，B站/YouTube 适合横屏。');
    if (!known.duration) questions.push('希望成片多长？短视频常见 15–30 秒，讲解类可以 1–3 分钟。');
    if (questions.length < 3) {
      if (!known.style) questions.push('想要什么感觉？比如温暖治愈、电影感、活力快节奏、高级简约。');
      else if (footage == null && device == null) questions.push('你手上已有拍好的素材吗？准备用手机还是相机拍？');
      else if (!known.audience) questions.push('主要想给谁看？比如附近的上班族、学生、宝妈。');
    }
  }

  // 回复：先复述用户说过的，再交代替用户定下的默认值，最后给下一步
  const merged = createBrief({ ...(base || {}), ...patch });
  const aspectLabel = (a) => (ASPECTS[a] ? ASPECTS[a].label : a);
  const facts = [];
  if (topic) facts.push(name ? `一支「${name}」的${TOPIC_KIND[topic]}视频` : kind ? `一支${kind}${tanDian ? '探店' : '宣传'}视频` : `一支${TOPIC_LABELS[topic]}${tanDian && !/探店/.test(TOPIC_LABELS[topic]) ? '探店' : ''}视频`);
  const shownAspect = known.aspect || (known.platform ? patch.aspect : null);
  if (known.platform) facts.push(`发在${known.platform}${shownAspect ? `（${aspectLabel(shownAspect)}）` : ''}`);
  else if (shownAspect) facts.push(aspectLabel(shownAspect));
  if (known.duration) facts.push(`时长约 ${known.duration} 秒`);
  if (known.style) facts.push(`风格${known.style}`);
  if (extracted.pacing) facts.push({ fast: '节奏偏快', medium: '节奏适中', slow: '节奏舒缓' }[extracted.pacing]);
  const assumed = [];
  if (patch.platform && !known.platform) assumed.push(`发${patch.platform}（${aspectLabel(patch.aspect || PLATFORM_ASPECT[patch.platform])}）`);
  if (patch.duration && !known.duration) assumed.push(`约 ${patch.duration} 秒`);
  if (patch.style && !known.style) assumed.push(`「${patch.style}」的风格`);
  const parts = [];
  if (facts.length) parts.push(`收到！我理解你想做${facts.join('，')}。`);
  else if (latest) parts.push('好的，我先了解一下你的想法。');
  else parts.push('你好，我是你的 AI 导演，我们从你想拍什么开始聊。');
  if (assumed.length) parts.push(`没说到的我先按常见做法定了：${assumed.join('、')}，想改随时告诉我。`);
  if (topic && texts.length <= 2) parts.push(`一个小建议：${topicHook(topic)}`);
  if (footage === true) parts.push('你已经有素材，我们可以先用「精修」把它们剪起来，缺的镜头再按分镜补拍。');
  let storyboard = null;
  if (readyForStoryboard && askedStoryboard) {
    storyboard = localStoryboard(merged).shots;
  }
  if (storyboard) {
    parts.push(`我先按本地模板出了 ${storyboard.length} 个分镜，每个镜头都写好了手机拍法和参考搜索词，你可以逐个查看或直接一键初剪。`);
    const note = placeholderNote(storyboard);
    if (note) parts.push(note);
  } else if (readyForStoryboard) parts.push('信息够了，可以点下面的「生成分镜」，我会给每个镜头写好手机拍法和参考搜索词。');
  else if (questions.length) parts.push(questions.length === 1 ? '还想确认一件事：' : '还想确认几件事：');

  return {
    reply: parts.join('\n'),
    briefPatch: patch,
    questions: questions.slice(0, 4),
    storyboard,
    readyForStoryboard,
  };
}

// ===========================================================================
// 模板分镜
// ===========================================================================
/**
 * B：节拍定义的紧凑写法
 * cam=[景别, 角度, 运镜]；sub=[kind,x,y,scale,action,label]；light=[方向, 色温, 氛围]
 */
function B(title, cam, lighting, location, subject, action, caption, tips, refs, tech, pv) {
  return { title, cam, lighting, location, subject, action, caption, tips, refs, tech, pv };
}
const P = (setting, timeOfDay, subs, light, overlay = '') => ({ setting, timeOfDay, subs, light, overlay });

const TEMPLATES = {
  drink: {
    beats: [
      B('招牌饮品钩子', ['close-up', 'high', 'push-in'], '窗光从侧后方打在杯子上', '吧台', '招牌饮品', '奶盖/拉花/冰块落入杯中的一瞬间，慢动作', '这一杯，排队也值', [
        '开 120 帧慢动作，用 2x 焦段离杯子 30 厘米，从液体倒入前 1 秒开始录。',
        '把杯子放在窗边，让窗在杯子斜后方，液体会被逆光照得发亮。',
        '提前擦干净杯壁和吧台，多做 2–3 杯挑最漂亮的一条。',
      ], ['奶茶 倒入 慢动作 特写', 'bubble tea pour slow motion close up'], ['bt_hook_3s', 'bt_slow_motion', 'bt_window_side_back'],
      P('cafe', 'day', [['cup', 0.5, 0.72, 1.6, 'pour', '招牌饮品']], ['back', 'warm', 'soft'])),
      B('店门口亮相', ['wide', 'low', 'tilt-down'], '白天自然光，招牌清晰', '店门口', '店招和门面', '镜头从上往下摇到招牌，路人走进店里', '{name}', [
        '站到马路对面，用 1x 主摄拍下完整门面，招牌放在上三分线。',
        '手臂夹紧身体，从天空或树梢匀速下摇 3 秒落到招牌。',
        '挑顾客正好进门的时候拍，画面更有生活气息。',
      ], ['奶茶店 门头 空镜', 'cafe storefront establishing shot'], ['bt_leading_lines', 'bt_rule_of_thirds'],
      P('street', 'day', [['text', 0.5, 0.4, 1, 'idle', '{name}'], ['person', 0.3, 0.86, 0.7, 'walk-right', '顾客']], ['left', 'neutral', 'bright'])),
      B('跟随走进店内', ['medium', 'eye-level', 'tracking'], '室内暖光，门框形成框中框', '店内入口', '顾客背影', '顾客推门走进来，镜头跟在身后', '', [
        '站在顾客身后 1–1.5 米，手机放胸口高度，打开防抖。',
        '膝盖微屈走「忍者步」，和顾客保持同样的速度。',
        '提前对着店内长按锁定曝光，避免进门时忽明忽暗。',
      ], ['走进咖啡店 跟拍 背影', 'walking into cafe follow shot'], ['bt_follow_shot', 'bt_frame_in_frame'],
      P('cafe', 'day', [['person', 0.5, 0.88, 1.2, 'walk-right', '顾客']], ['front', 'warm', 'soft'])),
      B('原料细节特写', ['extreme-close-up', 'eye-level', 'static'], '侧光突出质感', '操作台', '茶叶/咖啡豆/新鲜水果', '原料被舀起或倒下，能看清颗粒和新鲜度', '看得见的好原料', [
        '用微距模式或 2x–3x 焦段，离原料 10–15 厘米。',
        '让光从侧面来（窗边或一盏台灯），纹理才清楚。',
        '用手抓起再让它自然落下，开慢动作拍 3 秒。',
      ], ['咖啡豆 特写 慢动作', 'coffee beans macro slow motion'], ['bt_macro_detail', 'bt_ambience_bed'],
      P('cafe', 'day', [['food', 0.5, 0.75, 1.7, 'pour', '原料']], ['left', 'warm', 'dramatic'])),
      B('制作过程俯拍', ['close-up', 'top-down', 'static'], '柔和顶部或侧面光，无手影', '吧台', '店员的手与杯子', '店员熟练制作，从打奶到拉花/摇茶', '每一杯都现做', [
        '手机举到杯子正上方 40 厘米，打开网格线，让杯口居中。',
        '用支架或两摞书固定手机，光从侧面来避免手影。',
        '录完整过程，后期挑 3 秒最好看的；声音也要留着。',
      ], ['咖啡拉花 俯拍', 'latte art top down'], ['bt_top_down', 'bt_ambience_bed'],
      P('cafe', 'day', [['cup', 0.5, 0.6, 1.4, 'idle', '杯子'], ['product', 0.68, 0.42, 0.8, 'pour', '手与工具']], ['left', 'warm', 'soft'])),
      B('顾客第一口', ['medium-close', 'eye-level', 'handheld'], '窗光侧逆，发丝有轮廓光', '靠窗座位', '顾客', '顾客捧起饮品喝一口，自然地笑了', '就是这个味道', [
        '让顾客坐窗边，手机在窗的对侧，用 2x 焦段拍胸部以上。',
        '在镜头前放一盆绿植做虚化前景，对焦到人物眼睛。',
        '先聊天让对方放松，连续录 30 秒挑最自然的笑容。',
      ], ['女生 喝奶茶 微笑 逆光', 'woman drinking tea smiling backlight'], ['bt_foreground_frame', 'bt_handheld_breath', 'bt_window_side_back'],
      P('cafe', 'day', [['person', 0.58, 0.9, 1.4, 'raise', '顾客'], ['plant', 0.1, 0.95, 1, 'idle', '前景']], ['back', 'warm', 'soft'])),
      B('店内氛围空镜', ['full', 'eye-level', 'drift'], '店内暖灯与窗光混合', '店内', '座位、灯光、绿植', '镜头缓慢漂移，展示店内氛围和客人', '找个位子，慢下来', [
        '手机贴着桌面慢慢横移 20–30 厘米，4 秒完成。',
        '把前景放一杯饮品，背景虚化成光斑。',
        '挑人不太多的时候拍，避开杂乱的角落。',
      ], ['咖啡店 氛围 空镜', 'cozy cafe interior b-roll'], ['bt_foreground_frame', 'bt_warm_film'],
      P('cafe', 'day', [['cup', 0.3, 0.85, 0.8, 'idle', '饮品'], ['person', 0.72, 0.82, 0.8, 'idle', '客人']], ['left', 'warm', 'soft'])),
      B('门店信息落版', ['close-up', 'eye-level', 'pull-out'], '干净的暖色背景', '吧台', '饮品与店名', '饮品居中，画面留白处出现店名和地址', '{name}｜（地址待填）', [
        '把饮品放在画面下方，上方留出干净背景放文字。',
        '从特写开始缓慢后退 50 厘米，结尾稳定停 1–2 秒。',
        '字幕写清店名和地址；有真实的到店活动再加一句，没有就别写。',
      ], ['奶茶店 广告 结尾 字幕', 'cafe ad ending logo'], ['bt_cta_ending', 'bt_negative_space'],
      P('cafe', 'day', [['cup', 0.5, 0.85, 1, 'idle', '饮品'], ['text', 0.5, 0.36, 1.1, 'idle', '{name}']], ['front', 'warm', 'soft'], '{name}')),
    ],
  },
  food: {
    beats: [
      B('最诱人的一口', ['close-up', 'eye-level', 'push-in'], '侧逆光，热气清晰可见', '餐桌', '招牌菜', '筷子夹起食物，拉丝/冒热气，慢动作', '看饿了吧', [
        '开慢动作，用 2x 焦段离食物 30 厘米，把筷子夹起的瞬间录下来。',
        '光从食物侧后方来，热气和油光才看得清；背后留暗一点。',
        '刚出锅时最好看，提前对好焦，一口气多拍几次。',
      ], ['美食 拉丝 慢动作 特写', 'food close up slow motion cheese pull'], ['bt_hook_3s', 'bt_slow_motion', 'bt_macro_detail'],
      P('kitchen', 'day', [['food', 0.5, 0.75, 1.7, 'raise', '招牌菜']], ['back', 'warm', 'soft'])),
      B('门头与烟火气', ['wide', 'eye-level', 'pan-right'], '傍晚招牌亮起', '店门口', '店面与排队的人', '从街道摇到店面，门口有人排队', '{name}', [
        '傍晚招牌亮灯时拍，用 1x 主摄。',
        '腰为轴匀速右摇 3–4 秒，停在招牌上。',
        '画面里有顾客进出会更有人气。',
      ], ['餐厅 门头 傍晚 空镜', 'restaurant storefront evening'], ['bt_leading_lines', 'bt_rule_of_thirds'],
      P('street', 'golden', [['text', 0.5, 0.38, 1, 'idle', '{name}'], ['person', 0.25, 0.85, 0.7, 'idle', '排队顾客']], ['left', 'warm', 'soft'])),
      B('食材备料', ['medium-close', 'top-down', 'static'], '明亮的自然光', '操作台', '新鲜食材', '食材整齐摆在台面，手把它们切开或分类', '新鲜看得见', [
        '手机举到操作台正上方，打开网格线摆正。',
        '只留主要食材，把杂物清掉，颜色尽量丰富。',
        '切菜时保留清脆的声音，后期不要盖掉。',
      ], ['食材 俯拍 切菜', 'chopping vegetables overhead shot'], ['bt_top_down', 'bt_ambience_bed'],
      P('kitchen', 'day', [['food', 0.4, 0.6, 1.2, 'idle', '食材'], ['food', 0.65, 0.65, 1, 'idle', '配料']], ['left', 'neutral', 'bright'])),
      B('下锅高光', ['close-up', 'high', 'static'], '灶火或暖光映照，油烟可见', '灶台', '食物与锅', '食材下锅，滋啦一声，油花飞溅', '', [
        '斜上方 45° 拍摄，手机要远离油烟，用 2x 焦段。',
        '开慢动作拍下锅瞬间；声音单独再录一条。',
        '在灶台后方放一盏暖灯，让烟雾更有层次。',
      ], ['炒菜 下锅 慢动作 烟火气', 'stir fry wok flames slow motion'], ['bt_slow_motion', 'bt_ambience_bed'],
      P('kitchen', 'day', [['food', 0.5, 0.72, 1.4, 'rotate', '锅中食材']], ['back', 'warm', 'dramatic'])),
      B('成品摆盘环绕', ['medium', 'high', 'orbit'], '柔和窗光', '餐桌', '成品', '镜头绕成品缓慢转动，展示完整摆盘', '', [
        '把成品放在中心，手机离它 40 厘米，略俯拍。',
        '侧向小步移动转 60–90°，镜头始终对准菜。',
        '也可以把盘子放转盘上转，机位不动，更稳。',
      ], ['美食 摆盘 环绕 镜头', 'food plating orbit shot'], ['bt_orbit', 'bt_product_turntable'],
      P('kitchen', 'day', [['food', 0.5, 0.7, 1.4, 'idle', '成品']], ['left', 'warm', 'soft'])),
      B('客人的表情', ['medium-close', 'eye-level', 'handheld'], '店内暖光', '餐桌', '食客', '客人吃下一口后点头、笑出来', '真的好吃', [
        '手机放在客人侧前方，用 2x 拍胸部以上。',
        '先让客人吃、别喊开始，抓真实反应。',
        '轻微手持，保留现场感和环境声。',
      ], ['顾客 吃东西 真实 反应', 'people enjoying food reaction'], ['bt_handheld_breath', 'bt_foreground_frame'],
      P('cafe', 'day', [['person', 0.5, 0.9, 1.3, 'raise', '客人']], ['left', 'warm', 'soft'])),
      B('全家福与落版', ['full', 'high', 'pull-out'], '明亮暖光', '餐桌', '满桌的菜', '镜头拉远，一桌菜全部入画，字幕给出店名和地址', '{name}｜今晚来吃', [
        '站到桌边举高手机，从一道菜后退到全桌。',
        '慢慢拉 3–4 秒，结尾稳定停住。',
        '字幕写清楚地址、人均和一句邀请。',
      ], ['一桌菜 俯拍 拉远', 'table full of food wide shot'], ['bt_pull_out_reveal', 'bt_cta_ending'],
      P('kitchen', 'day', [['food', 0.35, 0.72, 1, 'idle', '菜'], ['food', 0.65, 0.72, 1, 'idle', '菜'], ['text', 0.5, 0.3, 1, 'idle', '{name}']], ['front', 'warm', 'bright'], '{name}')),
    ],
  },
  travel: {
    beats: [
      B('目的地最震撼的一眼', ['extreme-wide', 'high', 'push-in'], '黄金时刻侧逆光', '观景点', '壮阔风景', '镜头缓慢推向远方的地标，云雾或光线在流动', '如果只能来一次', [
        '提前查日出日落时间，在太阳离地一拳高时拍。',
        '用 0.5x 广角，手机举高越过前景的人或护栏。',
        '身体缓慢前移 1 米，4 秒内完成推进。',
      ], ['风景 航拍感 日落 大片', 'cinematic landscape sunset epic'], ['bt_hook_3s', 'bt_golden_backlight', 'bt_widescreen'],
      P('nature', 'golden', [['person', 0.5, 0.92, 0.3, 'idle', '远处的人']], ['back', 'warm', 'dramatic'])),
      B('出发的脚步', ['medium', 'low', 'tracking'], '自然光', '路上/车站', '背包的你', '镜头贴地跟随鞋子和背包往前走', '出发', [
        '手机倒拿贴近地面，用 0.5x 广角，跟随走路的脚。',
        '开超级防抖，膝盖放低走小步。',
        '拍 5 秒以上，挑步伐最稳的一段。',
      ], ['旅行 走路 脚步 跟拍', 'travel walking feet follow shot'], ['bt_follow_shot', 'bt_low_angle_hero'],
      P('street', 'day', [['person', 0.5, 0.88, 1.1, 'walk-right', '旅行者']], ['left', 'neutral', 'soft'])),
      B('街头人文细节', ['close-up', 'eye-level', 'handheld'], '自然光', '街巷', '当地人、小摊、招牌', '抓拍当地生活的细节：小摊、笑脸、手部动作', '', [
        '用 2x–3x 焦段站远一点，不打扰别人，先征得同意。',
        '半蹲让画面有前景，轻微手持。',
        '每个细节录 3–5 秒，方便卡点剪辑。',
      ], ['街头 人文 纪实 特写', 'street life documentary close up'], ['bt_handheld_breath', 'bt_foreground_frame'],
      P('street', 'day', [['person', 0.45, 0.85, 1.1, 'talk', '当地人'], ['box', 0.72, 0.85, 0.8, 'idle', '小摊']], ['left', 'warm', 'soft'])),
      B('人物与风景同框', ['full', 'eye-level', 'static'], '黄金时刻逆光，人物金边', '景点', '人物背影', '人物走入画面，停下来看风景，头发被风吹起', '', [
        '把手机固定在三脚架或石头上，人走入画面。',
        '人物放在三分线上，望向留白的一侧。',
        '逆光拍摄，点击人物后把曝光下拉一点。',
      ], ['旅行 人物 背影 看风景', 'traveler back view scenic view'], ['bt_rule_of_thirds', 'bt_negative_space', 'bt_golden_backlight'],
      P('nature', 'golden', [['person', 0.33, 0.88, 0.8, 'idle', '旅行者']], ['back', 'warm', 'soft'])),
      B('甩镜切换多个地点', ['medium', 'eye-level', 'pan-right'], '自然光', '多地点', '不同地点', '同方向甩镜，把两三个地点串起来', '', [
        '每个地点结尾都向右快速甩手机，下一地点开头继续从左甩入。',
        '光线充足时运动模糊才干净。',
        '剪辑时切在模糊处，时长 0.3 秒，配「嗖」的音效。',
      ], ['甩镜 转场 旅行 教程', 'whip pan transition travel'], ['bt_whip_pan', 'bt_sfx_whoosh'],
      P('street', 'day', [['person', 0.5, 0.85, 0.8, 'walk-right', '旅行者']], ['left', 'neutral', 'bright'])),
      B('当地美食的一口', ['close-up', 'eye-level', 'static'], '暖光', '小店', '当地美食', '端起当地特色美食尝一口', '', [
        '让食物占画面主体，用 2x 焦段。',
        '光从窗口或灯下斜照，热气清楚。',
        '录下真实的第一反应，声音保留。',
      ], ['旅行 当地美食 特写', 'local food travel close up'], ['bt_macro_detail'],
      P('cafe', 'day', [['food', 0.5, 0.75, 1.4, 'raise', '美食']], ['left', 'warm', 'soft'])),
      B('夜色与灯火', ['wide', 'eye-level', 'drift'], '蓝调时刻的灯光', '城市/古镇', '夜景', '天黑前的蓝调时刻，灯光亮起，人群慢慢走过', '', [
        '日落后 20 分钟的蓝调时刻最好看。',
        '手机靠在栏杆上稳定，打开夜景模式。',
        '可再拍一段延时，后期叠化表现天色变化。',
      ], ['城市 夜景 蓝调 延时', 'city blue hour timelapse'], ['bt_timelapse', 'bt_neon_night', 'bt_crossfade_time'],
      P('night-city', 'blue', [['person', 0.4, 0.88, 0.5, 'walk-right', '行人'], ['car', 0.7, 0.88, 0.6, 'idle', '街景']], ['top', 'cool', 'night'])),
      B('回望与落版', ['full', 'eye-level', 'pull-out'], '日落余晖', '景点', '人物回头', '人物回头微笑或继续往前走，画面渐暗出现片名', '下一站，见', [
        '让人物走远后回头，用 2x 焦段抓表情。',
        '结尾多停 2 秒，方便淡出。',
        '字幕一句话收尾，可以加目的地和日期。',
      ], ['旅行 结尾 回头 微笑', 'travel film ending look back'], ['bt_dip_black_chapter', 'bt_three_act'],
      P('nature', 'golden', [['person', 0.5, 0.88, 0.9, 'turn', '旅行者'], ['text', 0.5, 0.3, 1, 'idle', '下一站，见']], ['back', 'warm', 'soft'], '下一站，见')),
    ],
  },
  product: {
    beats: [
      B('痛点或惊艳钩子', ['close-up', 'eye-level', 'zoom-punch'], '干净明亮', '使用场景', '使用中的产品', '开头直接展示问题或最惊艳的效果', '还在为这个烦吗？', [
        '把全片最亮眼的使用结果放在这里，1 秒内出现主体。',
        '让主体位于画面中心，方便后期加冲击变焦。',
        '字幕用一句问题或结论，放在上方 1/3。',
      ], ['产品 广告 开头 钩子', 'product commercial hook opening'], ['bt_hook_3s', 'bt_problem_solution'],
      P('studio', 'day', [['product', 0.5, 0.72, 1.3, 'raise', '产品']], ['left', 'neutral', 'bright'])),
      B('产品英雄亮相', ['full', 'low', 'push-in'], '侧后方轮廓光，深色背景', '桌面/背景纸', '产品', '产品在暗背景中被光勾出轮廓，缓慢推近', '{name}', [
        '产品放在深色背景前，手机略低于产品、微仰 10°。',
        '台灯放在产品侧后方，白卡纸放另一侧补光。',
        '匀速推近 4 秒，结尾 Logo 正对镜头。',
      ], ['产品 英雄镜头 暗背景', 'product hero shot dark background'], ['bt_hero_product', 'bt_low_key'],
      P('studio', 'night', [['product', 0.5, 0.74, 1.4, 'rotate', '产品']], ['back', 'cool', 'dramatic'])),
      B('卖点一：细节特写', ['extreme-close-up', 'eye-level', 'push-in'], '侧光突出材质', '桌面', '产品细节', '材质、接缝、按键的微距特写，配字说明卖点', '卖点一', [
        '用微距或 2x–3x 焦段，离产品 10–15 厘米。',
        '光和镜头呈 90° 打，纹理最清楚。',
        '每个卖点只拍一处，缓慢推近 3 秒。',
      ], ['产品 微距 细节 材质', 'product macro detail shot'], ['bt_macro_detail', 'bt_keyword_caption'],
      P('studio', 'day', [['product', 0.5, 0.75, 1.8, 'idle', '细节']], ['left', 'neutral', 'dramatic'])),
      B('上手使用', ['medium', 'eye-level', 'static'], '生活化的自然光', '生活场景', '手和产品', '手拿起产品自然使用，能看出大小和操作', '一只手就能搞定', [
        '手部干净，先把产品擦干净，用 2x 焦段。',
        '动作放慢，一次只展示一个操作。',
        '背景选真实使用场景，但要整洁。',
      ], ['产品 上手 使用 展示', 'hand using product lifestyle'], ['bt_scale_reference'],
      P('home', 'day', [['person', 0.35, 0.88, 1, 'raise', '使用者'], ['product', 0.58, 0.68, 0.9, 'idle', '产品']], ['left', 'warm', 'bright'])),
      B('使用前后对比', ['medium', 'eye-level', 'static'], '两次光线保持一致', '同一机位', '前后变化', '同机位前后两条，用擦除转场呈现变化', '前后对比', [
        '手机固定不动，先拍「之前」，处理后再拍「之后」。',
        '两次光线、焦段、位置必须一致。',
        '「之后」多停留 1 秒，加文字标签。',
      ], ['使用前后对比 擦除转场', 'before after comparison wipe'], ['bt_before_after', 'bt_split_screen'],
      P('home', 'day', [['box', 0.3, 0.7, 1, 'idle', '之前'], ['product', 0.7, 0.7, 1, 'idle', '之后']], ['left', 'neutral', 'bright'])),
      B('卖点二：场景证明', ['medium-close', 'eye-level', 'handheld'], '真实环境光', '真实场景', '真实用户', '真实用户说一句使用感受', '用过都说好用', [
        '让真实用户对着镜头旁边的人说话，不要看镜头。',
        '用 2x 拍胸部以上，背景虚化。',
        '多问几个问题，只留最真诚的一句。',
      ], ['用户 证言 采访 真实', 'customer testimonial interview'], ['bt_interview_eyeline', 'bt_talking_breath_cut'],
      P('office', 'day', [['person', 0.5, 0.88, 1.3, 'talk', '用户']], ['left', 'warm', 'soft'])),
      B('快节奏混剪', ['close-up', 'eye-level', 'zoom-punch'], '干净明亮', '多场景', '产品多角度', '多个 1 秒画面卡点切换，节奏推到高潮', '', [
        '准备 4–6 个不同角度的短镜头。',
        '剪辑点对齐音乐鼓点，每段 0.5–1 秒。',
        '高潮处用冲击变焦或闪白转场。',
      ], ['产品 快闪 卡点 混剪', 'product montage beat cut'], ['bt_beat_cut', 'bt_zoom_punch_transition'],
      P('abstract', 'day', [['product', 0.5, 0.7, 1.2, 'rotate', '产品']], ['top', 'neutral', 'bright'])),
      B('行动号召落版', ['close-up', 'eye-level', 'pull-out'], '干净背景，品牌色', '背景纸', '产品与 Logo', '产品居中，字幕给出购买方式', '{name}｜（购买方式待填）', [
        '产品放在画面下方，上方留白放文字。',
        '缓慢拉远，结尾定住 2 秒。',
        '字幕写清楚具体行动（去哪里买、怎么买）；优惠只写真实有的。',
      ], ['广告 结尾 行动号召 字幕', 'ad ending call to action'], ['bt_cta_ending', 'bt_negative_space'],
      P('studio', 'day', [['product', 0.5, 0.82, 1, 'idle', '产品'], ['text', 0.5, 0.34, 1.1, 'idle', '{name}']], ['front', 'neutral', 'soft'], '{name}')),
    ],
  },
  unboxing: {
    beats: [
      B('成品上手预告', ['close-up', 'eye-level', 'zoom-punch'], '明亮均匀', '桌面', '产品上手', '先闪现产品使用中的一幕，一句话抛结论', '这东西，到底值不值？', [
        '先把上手使用拍好，挑最好看的 2 秒放开头。',
        '字幕放一句结论或疑问，放大加粗。',
        '主体放中心，后期加冲击变焦。',
      ], ['开箱 测评 开头 钩子', 'unboxing review hook'], ['bt_hook_3s', 'bt_suspense_first'],
      P('home', 'day', [['product', 0.5, 0.7, 1.4, 'raise', '产品']], ['left', 'neutral', 'bright'])),
      B('包裹登场', ['medium', 'high', 'static'], '窗边自然光', '桌面', '快递盒', '快递盒放到桌上，手入画开始拆', '', [
        '俯 45° 拍，桌面清干净，光从窗户侧面来。',
        '手机用支架固定，方便双手操作。',
        '放盒子的动作干脆一点，声音收清楚。',
      ], ['开箱 快递盒 桌面', 'package on desk unboxing'], ['bt_unboxing_rhythm'],
      P('home', 'day', [['box', 0.5, 0.72, 1.3, 'idle', '快递盒']], ['left', 'neutral', 'bright'])),
      B('拆封瞬间', ['close-up', 'top-down', 'static'], '明亮均匀', '桌面', '手与包装', '划开胶带、打开盖子，慢动作加音效', '', [
        '手机移到正上方，手的影子不要落在盒子上。',
        '拆封时开慢动作，撕胶带的声音要留着。',
        '盖子打开前停半秒，留一点悬念。',
      ], ['拆快递 开箱 俯拍 音效', 'unboxing asmr top down'], ['bt_top_down', 'bt_slow_motion', 'bt_sfx_whoosh'],
      P('home', 'day', [['box', 0.5, 0.62, 1.4, 'raise', '包装']], ['top', 'neutral', 'bright'])),
      B('第一眼全貌', ['medium', 'high', 'push-in'], '柔和明亮', '桌面', '产品', '产品从包装里取出，第一次全貌', '第一眼印象', [
        '把产品放到干净的区域，手机略俯拍。',
        '缓慢推近 3 秒，说第一印象。',
        '第一句话要真实，不用背稿。',
      ], ['开箱 产品 第一眼', 'first look product unboxing'], ['bt_push_in_emphasis', 'bt_scale_reference'],
      P('home', 'day', [['product', 0.5, 0.72, 1.3, 'rotate', '产品']], ['left', 'warm', 'soft'])),
      B('配件逐个摆开', ['medium-close', 'top-down', 'static'], '明亮均匀', '桌面', '全部配件', '配件一件件摆出来，卡点出现', '盒子里还有这些', [
        '固定俯拍，每放一件录 1–1.5 秒。',
        '后期跳切，让配件一件件「蹦」出来。',
        '摆放按对角线或九宫格，更整齐。',
      ], ['配件 摆拍 俯拍 跳切', 'accessories flat lay jump cut'], ['bt_jump_cut', 'bt_beat_cut'],
      P('home', 'day', [['box', 0.3, 0.65, 0.9, 'idle', '配件'], ['product', 0.6, 0.65, 1, 'idle', '主机'], ['phone', 0.78, 0.68, 0.7, 'idle', '配件']], ['top', 'neutral', 'bright'])),
      B('细节与做工', ['extreme-close-up', 'eye-level', 'static'], '侧光突出做工', '桌面', '产品细节', '做工、材质、接口的微距特写', '做工细节', [
        '用微距模式靠近 10 厘米。',
        '台灯从侧面打，做工和材质最清楚。',
        '指出好的地方，也说一点不足，更可信。',
      ], ['产品 做工 微距 特写', 'product build quality macro'], ['bt_macro_detail'],
      P('home', 'day', [['product', 0.5, 0.75, 1.8, 'idle', '细节']], ['left', 'neutral', 'dramatic'])),
      B('实际上手体验', ['medium', 'eye-level', 'handheld'], '真实使用环境', '使用场景', '使用者', '真实使用过程，讲一个优点一个缺点', '真实上手感受', [
        '换到真实使用的环境，手持跟拍动作。',
        '一次只讲一个点，说话时眼睛看镜头。',
        '说完剪掉气口，节奏更紧凑。',
      ], ['上手 测评 使用 体验', 'hands on review'], ['bt_talking_breath_cut', 'bt_handheld_breath'],
      P('home', 'day', [['person', 0.45, 0.88, 1.2, 'talk', '测评者'], ['product', 0.65, 0.68, 0.8, 'idle', '产品']], ['left', 'warm', 'soft'])),
      B('结论与建议', ['medium-close', 'eye-level', 'static'], '柔和正面光', '桌面前', '测评者与产品', '对镜头给出一句话结论和购买建议', '值不值？一句话：', [
        '把产品拿在手里或放桌上入画。',
        '用 2x 焦段拍胸部以上，眼睛看镜头。',
        '字幕给出结论，结尾邀请评论或下单。',
      ], ['测评 结论 口播 结尾', 'review verdict talking head'], ['bt_cta_ending', 'bt_keyword_caption'],
      P('home', 'day', [['person', 0.5, 0.88, 1.3, 'talk', '测评者'], ['text', 0.5, 0.2, 0.9, 'idle', '结论']], ['front', 'warm', 'soft'], '值不值？')),
    ],
  },
  vlog: {
    beats: [
      B('一句话开场', ['medium-close', 'eye-level', 'handheld'], '窗边自然光', '家里/路上', '你自己', '对着镜头说一句有共鸣的话，同时在做某件事', '今天，只想好好生活', [
        '手机自拍或靠在杯子上，用 1x 拍胸部以上。',
        '边做事边说，别站着背稿；选窗边光线。',
        '第一句话就说重点，不要先说「大家好」。',
      ], ['vlog 开场 自拍 窗边', 'vlog opening talking to camera'], ['bt_hook_3s', 'bt_handheld_breath'],
      P('home', 'day', [['person', 0.5, 0.88, 1.3, 'talk', '我']], ['left', 'warm', 'soft'])),
      B('清晨细节', ['close-up', 'high', 'static'], '清晨柔光', '窗边', '咖啡、书、闹钟', '咖啡倒入杯子、窗帘被风吹动等细节', '', [
        '用 2x 焦段拍 3–4 个细节，每个 2–3 秒。',
        '光从窗户来，曝光略偏亮。',
        '倒咖啡的声音很治愈，一定留着。',
      ], ['早晨 咖啡 生活 特写', 'morning routine coffee aesthetic'], ['bt_window_side_back', 'bt_japanese_fresh', 'bt_ambience_bed'],
      P('home', 'day', [['cup', 0.5, 0.72, 1.3, 'pour', '咖啡']], ['left', 'warm', 'soft'])),
      B('出门跟拍', ['full', 'low', 'tracking'], '户外自然光', '街道', '你的背影', '把手机放地上或让朋友跟拍走路', '', [
        '把手机靠在地上或台阶上，从它身边走过去。',
        '或者请朋友跟拍，走「忍者步」。',
        '走到一半转个身，让画面有变化。',
      ], ['vlog 出门 走路 跟拍', 'vlog walking follow shot'], ['bt_follow_shot', 'bt_low_angle_hero'],
      P('street', 'day', [['person', 0.5, 0.88, 1, 'walk-right', '我']], ['left', 'neutral', 'soft'])),
      B('窗外与路途', ['wide', 'eye-level', 'static'], '自然光', '车上/路上', '窗外风景', '地铁/车窗外的风景向后流动', '', [
        '手机贴近车窗减少反光，用 1x。',
        '用手或黑色衣服挡住车内反光。',
        '录 10 秒以上，后期可加速。',
      ], ['车窗外 风景 空镜', 'train window view b-roll'], ['bt_timelapse', 'bt_negative_space'],
      P('street', 'day', [['car', 0.5, 0.75, 1, 'idle', '窗外']], ['back', 'neutral', 'soft'])),
      B('今天的重点事件', ['medium', 'eye-level', 'handheld'], '环境光', '事件发生地', '正在做的事', '展示这一天最重要的那件事（工作、见朋友、探店）', '', [
        '提前想好今天的「重点」是什么，多拍这件事。',
        '多换景别：全景交代、近景看手、特写看表情。',
        '每个动作拍 3 种景别，剪起来才好看。',
      ], ['vlog 日常 工作 记录', 'day in the life vlog b-roll'], ['bt_three_act', 'bt_jump_cut'],
      P('office', 'day', [['person', 0.5, 0.88, 1.1, 'idle', '我'], ['laptop', 0.68, 0.72, 0.8, 'idle', '电脑']], ['left', 'warm', 'soft'])),
      B('小事也值得记录', ['close-up', 'eye-level', 'drift'], '傍晚暖光', '咖啡店/路上', '小确幸', '路边小猫、一朵花、一口好吃的', '', [
        '随手拍你觉得开心的小细节，每个 3 秒。',
        '用 2x 焦段，把背景虚化掉。',
        '手臂贴身，缓慢平移。',
      ], ['生活 小确幸 空镜 细节', 'small moments aesthetic b-roll'], ['bt_foreground_frame', 'bt_handheld_breath'],
      P('nature', 'golden', [['plant', 0.5, 0.78, 1.4, 'idle', '小确幸']], ['back', 'warm', 'soft'])),
      B('一天的结束', ['medium', 'eye-level', 'push-in'], '暖灯或夜景', '家/窗边', '你', '回到家，说一句今天的感受', '明天见', [
        '关掉顶灯，只开一盏暖色小灯。',
        '手机靠在桌上缓慢推近，或后期加推近。',
        '结尾用叠化或黑场，让情绪收住。',
      ], ['vlog 结尾 夜晚 独白', 'vlog ending night reflection'], ['bt_dip_black_chapter', 'bt_voiceover_rhythm'],
      P('home', 'night', [['person', 0.5, 0.88, 1.2, 'idle', '我']], ['left', 'warm', 'night'], '明天见')),
    ],
  },
  fitness: {
    beats: [
      B('最燃的一下', ['medium', 'low', 'zoom-punch'], '侧逆光，汗水可见', '健身房/户外', '运动中的人', '大重量或爆发动作的瞬间，鼓点落下', '不是天赋，是每天', [
        '手机放低仰拍，用 0.5x 广角，人物显得更高大。',
        '开慢动作拍爆发瞬间。',
        '光从侧后方来，肌肉线条和汗水才明显。',
      ], ['健身 爆发 慢动作 仰拍', 'fitness explosive slow motion low angle'], ['bt_hook_3s', 'bt_low_angle_hero', 'bt_speed_ramp'],
      P('gym', 'day', [['person', 0.5, 0.9, 1.3, 'jump', '运动者']], ['back', 'cool', 'dramatic'])),
      B('清晨出发', ['full', 'eye-level', 'tracking'], '清晨蓝调或路灯', '街道/门口', '背影', '天还没亮，走出家门去训练', '早上 6 点', [
        '在天刚亮时拍，手机放腰部高度跟随。',
        '光线不足时用夜景模式或路灯下拍。',
        '字幕打时间点，强化坚持感。',
      ], ['清晨 出门 跑步 背影', 'early morning run back view'], ['bt_follow_shot', 'bt_moody_desat'],
      P('street', 'blue', [['person', 0.5, 0.88, 0.9, 'walk-right', '我']], ['back', 'cool', 'night'])),
      B('装备特写', ['close-up', 'high', 'static'], '柔和侧光', '更衣处', '鞋带、手套、水杯', '系鞋带、缠手、灌水的细节', '', [
        '2x 焦段，每个动作拍 2 秒。',
        '动作干净利落，方便卡点。',
        '把水杯、手套放在同一个画面里更有氛围。',
      ], ['系鞋带 特写 运动 前', 'tying shoes close up workout'], ['bt_macro_detail', 'bt_beat_cut'],
      P('gym', 'day', [['box', 0.5, 0.75, 1.3, 'idle', '装备']], ['left', 'neutral', 'soft'])),
      B('训练卡点混剪', ['medium', 'eye-level', 'shake'], '顶光或侧光', '健身房', '多个动作', '多个动作每段 1 秒，卡点切换', '', [
        '每个动作拍 3 组，只用发力那一下。',
        '剪辑点对准鼓点，加一点手持晃动。',
        '不同角度交替：正面、侧面、低机位。',
      ], ['健身 混剪 卡点', 'gym montage beat cut'], ['bt_beat_cut', 'bt_zoom_punch_transition'],
      P('gym', 'day', [['person', 0.45, 0.88, 1.2, 'raise', '我'], ['product', 0.7, 0.8, 0.8, 'idle', '器械']], ['top', 'neutral', 'dramatic'])),
      B('咬牙坚持', ['extreme-close-up', 'eye-level', 'handheld'], '暗调侧光', '健身房', '表情和汗水', '力竭时的表情和喘息特写', '再来一组', [
        '用 2x–3x 靠近脸部，只拍眼睛和汗水。',
        '环境调暗，光只打在半边脸。',
        '保留喘气声，音乐这时候压低。',
      ], ['健身 力竭 表情 特写', 'athlete sweat face close up'], ['bt_rembrandt', 'bt_silence_contrast'],
      P('gym', 'night', [['person', 0.5, 0.95, 1.9, 'idle', '表情']], ['left', 'neutral', 'dramatic'])),
      B('前后对比', ['full', 'eye-level', 'static'], '同样光线', '同一地点', '身材变化', '同一地点前后对比，用遮挡转场', '90 天的变化', [
        '手机固定同一位置，穿同样的衣服拍。',
        '用手遮挡镜头作为转场。',
        '字幕写清时间跨度，真实不夸张。',
      ], ['健身 前后对比 变化', 'body transformation before after'], ['bt_before_after', 'bt_occlusion'],
      P('gym', 'day', [['person', 0.35, 0.88, 1, 'idle', '之前'], ['person', 0.68, 0.88, 1, 'idle', '之后']], ['left', 'neutral', 'bright'])),
      B('结尾力量定格', ['full', 'low', 'pull-out'], '日出逆光或聚光', '楼顶/健身房', '人物剪影', '人物站定，字幕收尾，邀请观众一起开始', '明天，一起吗？', [
        '低机位逆光拍剪影，人站在画面中央。',
        '缓慢拉远，结尾定格 2 秒。',
        '字幕邀请评论或打卡，增加互动。',
      ], ['健身 剪影 逆光 结尾', 'athlete silhouette backlight'], ['bt_low_angle_hero', 'bt_cta_ending'],
      P('nature', 'golden', [['person', 0.5, 0.88, 1.1, 'idle', '我'], ['text', 0.5, 0.28, 1, 'idle', '一起吗']], ['back', 'warm', 'dramatic'], '明天，一起吗？')),
    ],
  },
  pet: {
    beats: [
      B('最可爱的一瞬间', ['close-up', 'low', 'push-in'], '窗边柔光', '家里', '宠物的脸', '它歪头、打哈欠或看向镜头的瞬间', '谁能拒绝这张脸', [
        '趴到和它同样的高度，用 2x 焦段对焦眼睛。',
        '用零食或玩具吸引它看向镜头。',
        '连拍 + 慢动作都打开，可爱瞬间很短。',
      ], ['猫咪 特写 可爱 歪头', 'cute cat close up head tilt'], ['bt_hook_3s', 'bt_slow_motion', 'bt_window_side_back'],
      P('home', 'day', [['box', 0.5, 0.78, 1.6, 'turn', '宠物']], ['left', 'warm', 'soft'])),
      B('宠物视角出场', ['full', 'pov', 'tracking'], '自然光', '家里/公园', '宠物跑动', '手机放到地面高度跟着它跑', '', [
        '手机倒拿贴地，用 0.5x 广角。',
        '用玩具引导它跑向你或跟着它跑。',
        '开超级防抖，多拍几条。',
      ], ['狗狗 奔跑 低机位 跟拍', 'dog running low angle tracking'], ['bt_low_angle_hero', 'bt_follow_shot'],
      P('nature', 'day', [['box', 0.5, 0.82, 1.1, 'walk-right', '宠物']], ['back', 'warm', 'bright'])),
      B('爪子和小细节', ['extreme-close-up', 'eye-level', 'static'], '柔光', '家里', '肉垫、耳朵、尾巴', '用特写拍肉垫、胡须、摇尾巴', '', [
        '趁它睡觉时用微距或 2x 焦段靠近。',
        '窗边柔光，不要开闪光灯。',
        '每个细节 2–3 秒，配俏皮音效。',
      ], ['猫爪 肉垫 特写', 'cat paw close up'], ['bt_macro_detail', 'bt_sfx_whoosh'],
      P('home', 'day', [['box', 0.5, 0.78, 1.8, 'idle', '小爪子']], ['left', 'warm', 'soft'])),
      B('搞笑名场面', ['medium', 'high', 'static'], '家中自然光', '家里', '宠物捣蛋', '偷吃、打翻东西、对着自己尾巴转圈', '又来了', [
        '把手机固定在高处长录，等它捣蛋。',
        '把最搞笑的瞬间剪出来，重复播放一次。',
        '加一句吐槽字幕，节奏停顿半秒。',
      ], ['宠物 搞笑 捣蛋', 'funny pet moments'], ['bt_jump_cut', 'bt_keyword_caption'],
      P('home', 'day', [['box', 0.5, 0.8, 1.2, 'jump', '宠物'], ['plant', 0.75, 0.85, 0.8, 'idle', '被打翻的盆栽']], ['left', 'warm', 'bright'])),
      B('和主人的互动', ['medium-close', 'eye-level', 'handheld'], '柔和窗光', '沙发', '主人和宠物', '抱着它、挠下巴，它舒服地眯起眼睛', '今天也被治愈了', [
        '请家人帮你拍，或把手机靠在沙发上。',
        '让光从窗边来，用 1x 或 2x。',
        '不要摆拍，等自然的互动出现。',
      ], ['主人 抱猫 治愈 互动', 'owner cuddling cat cozy'], ['bt_handheld_breath', 'bt_warm_film'],
      P('home', 'day', [['person', 0.45, 0.9, 1.2, 'idle', '主人'], ['box', 0.58, 0.72, 0.8, 'idle', '宠物']], ['left', 'warm', 'soft'])),
      B('睡着的样子', ['close-up', 'high', 'drift'], '午后阳光', '窗边', '熟睡的宠物', '午后阳光洒在熟睡的它身上，镜头缓慢漂移', '', [
        '等它在阳光下睡着，轻轻靠近不要吵醒。',
        '手机贴着地面或沙发慢慢移动。',
        '音乐降低，只留轻轻的呼噜声。',
      ], ['猫咪 睡觉 阳光 治愈', 'cat sleeping in sunlight'], ['bt_window_side_back', 'bt_ambience_bed'],
      P('home', 'golden', [['box', 0.5, 0.78, 1.5, 'idle', '熟睡的它']], ['back', 'warm', 'soft'])),
      B('结尾：你家也这样吗', ['close-up', 'eye-level', 'static'], '柔光', '家里', '宠物看向镜头', '它看向镜头，字幕邀请评论', '你家的也这样吗？', [
        '用零食吸引它看向镜头。',
        '定格最后一帧，加字幕提问。',
        '引导观众在评论区晒自家宠物。',
      ], ['宠物 看镜头 结尾', 'pet looking at camera ending'], ['bt_cta_ending'],
      P('home', 'day', [['box', 0.5, 0.8, 1.4, 'idle', '宠物'], ['text', 0.5, 0.25, 0.9, 'idle', '你家也这样吗']], ['front', 'warm', 'soft'], '你家的也这样吗？')),
    ],
  },
  wedding: {
    beats: [
      B('誓言声音开场', ['extreme-close-up', 'eye-level', 'push-in'], '柔和暖光', '婚礼现场', '戒指或手', '戒指/相握的手特写，声音是誓词', '我愿意', [
        '先把誓词声音放进来，再出画面（J-cut）。',
        '微距或 2x 焦段拍戒指，光从侧面来。',
        '缓慢推近，开慢动作。',
      ], ['婚礼 戒指 特写 慢动作', 'wedding ring close up slow motion'], ['bt_hook_3s', 'bt_jl_cut', 'bt_macro_detail'],
      P('studio', 'golden', [['product', 0.5, 0.72, 1.7, 'idle', '戒指']], ['left', 'warm', 'soft'])),
      B('清晨的准备', ['medium', 'eye-level', 'handheld'], '窗边柔光', '化妆间', '新娘', '化妆、穿婚纱、亲友帮忙系扣子', '', [
        '让新娘靠窗化妆，手机在窗的对侧。',
        '用 2x 拍背影、镜子里的倒影。',
        '多抓亲友的表情和笑声。',
      ], ['新娘 化妆 清晨 窗光', 'bride getting ready window light'], ['bt_window_side_back', 'bt_frame_in_frame'],
      P('home', 'day', [['person', 0.55, 0.88, 1.2, 'idle', '新娘']], ['left', 'warm', 'soft'])),
      B('现场氛围空镜', ['wide', 'low', 'pan-right'], '现场灯光与自然光', '婚礼场地', '场地、花艺、桌面', '慢慢横摇展示布置和细节', '', [
        '开场前到场拍布置，人少更干净。',
        '用 0.5x 广角，低机位展示全貌。',
        '再用 2x 拍花艺和桌卡等细节。',
      ], ['婚礼 布置 空镜 花艺', 'wedding venue decoration b-roll'], ['bt_leading_lines', 'bt_symmetry'],
      P('studio', 'day', [['plant', 0.3, 0.82, 1, 'idle', '花艺'], ['box', 0.68, 0.82, 0.8, 'idle', '布置']], ['left', 'warm', 'soft'])),
      B('父亲牵手入场', ['full', 'eye-level', 'tracking'], '暖光', '通道', '新娘与父亲', '新娘挽着父亲走向新郎，配上慢动作', '', [
        '站在通道尽头，用 2x 焦段，人物走向镜头。',
        '开慢动作，手臂贴身保持稳定。',
        '切到新郎等待的表情，形成呼应。',
      ], ['婚礼 新娘 入场 慢动作', 'bride walking down aisle slow motion'], ['bt_slow_motion', 'bt_shot_reverse'],
      P('studio', 'day', [['person', 0.42, 0.88, 1.1, 'walk-right', '新娘'], ['person', 0.58, 0.88, 1.1, 'walk-right', '父亲']], ['back', 'warm', 'soft'])),
      B('新郎的反应', ['close-up', 'eye-level', 'static'], '柔光', '仪式台前', '新郎', '看到新娘时的表情，眼里有泪', '', [
        '提前站在侧面 45°，用 3x 焦段不打扰。',
        '一直开机，表情一闪而过。',
        '不要摆拍，一定要抓真实反应。',
      ], ['新郎 感动 表情', 'groom emotional reaction'], ['bt_dreamy_glow'],
      P('studio', 'day', [['person', 0.5, 0.9, 1.5, 'turn', '新郎']], ['left', 'warm', 'soft'])),
      B('誓言与拥吻', ['medium', 'eye-level', 'orbit'], '暖光与逆光', '仪式台', '新人', '交换戒指、拥吻，人群鼓掌，音乐推到高潮', '', [
        '人物放在画面中央，侧向走 60° 弧线环绕。',
        '逆光时点击人脸，把曝光调对。',
        '音乐和掌声同时推高，配闪白转场。',
      ], ['婚礼 拥吻 环绕 镜头', 'wedding kiss orbit shot'], ['bt_orbit', 'bt_flash_white'],
      P('studio', 'golden', [['person', 0.45, 0.88, 1.2, 'turn', '新郎'], ['person', 0.56, 0.88, 1.2, 'turn', '新娘']], ['back', 'warm', 'dramatic'])),
      B('欢笑与宴会', ['medium', 'eye-level', 'handheld'], '暖色灯光', '宴会厅', '亲友', '敬酒、大笑、跳舞，节奏轻快', '', [
        '手持穿梭，抓亲友笑得最开心的瞬间。',
        '光线不足时靠近灯光，用 1x 主摄。',
        '多剪几个短镜头，节奏加快。',
      ], ['婚礼 宴会 欢笑 纪实', 'wedding reception joy candid'], ['bt_handheld_breath', 'bt_jump_cut'],
      P('studio', 'night', [['person', 0.35, 0.88, 1, 'talk', '亲友'], ['person', 0.65, 0.88, 1, 'raise', '亲友']], ['top', 'warm', 'soft'])),
      B('黄昏下的两个人', ['wide', 'eye-level', 'pull-out'], '黄金时刻逆光', '户外', '新人背影', '夕阳下两人牵手走远，片名与日期淡入', '{name}', [
        '日落前一小时拍，人物走向夕阳。',
        '用 1x 拍全景，慢慢后退拉远。',
        '字幕放日期和两人名字，淡出到黑。',
      ], ['婚礼 日落 牵手 背影', 'wedding couple sunset walk'], ['bt_golden_backlight', 'bt_dip_black_chapter'],
      P('nature', 'golden', [['person', 0.46, 0.86, 0.7, 'walk-right', '新郎'], ['person', 0.54, 0.86, 0.7, 'walk-right', '新娘'], ['text', 0.5, 0.25, 1, 'idle', '{name}']], ['back', 'warm', 'soft'], '{name}')),
    ],
  },
  tutorial: {
    beats: [
      B('先看结果', ['close-up', 'eye-level', 'zoom-punch'], '明亮均匀', '操作台/桌面', '学会后的效果', '直接展示学会后的成品，并说「30 秒教会你」', '30 秒学会', [
        '把最惊艳的成品放第一镜，1 秒内出现。',
        '字幕放大放中间，一句话说收获。',
        '语气干脆，不要自我介绍。',
      ], ['教程 开头 效果展示', 'tutorial hook final result'], ['bt_hook_3s', 'bt_keyword_caption'],
      P('studio', 'day', [['product', 0.5, 0.72, 1.3, 'idle', '成果'], ['text', 0.5, 0.25, 1, 'idle', '学会']], ['front', 'neutral', 'bright'], '30 秒学会')),
      B('这个问题很常见', ['medium-close', 'eye-level', 'static'], '三点布光或窗光', '桌前', '讲解者', '一句话说清大家常犯的错', '90% 的人都做错了', [
        '人物放画面一侧，眼睛看镜头。',
        '窗在正前方侧 45°，白板在对面补光。',
        '一句话说痛点，不要超过 3 秒。',
      ], ['口播 讲解 新手 常见错误', 'common mistakes talking head'], ['bt_three_point', 'bt_problem_solution', 'bt_talking_breath_cut'],
      P('office', 'day', [['person', 0.4, 0.88, 1.3, 'talk', '讲解者']], ['left', 'neutral', 'soft'])),
      B('需要准备什么', ['medium', 'top-down', 'static'], '明亮均匀', '桌面', '工具', '工具摆在桌上，每样弹一下名字', '只需要这些', [
        '手机俯拍，桌面只放用到的东西。',
        '排列整齐，留出放文字的地方。',
        '每样工具停 1 秒，配字幕。',
      ], ['工具 俯拍 摆放 教程', 'tools flat lay overhead'], ['bt_top_down', 'bt_keyword_caption'],
      P('office', 'day', [['box', 0.3, 0.62, 0.9, 'idle', '工具1'], ['phone', 0.5, 0.62, 0.9, 'idle', '工具2'], ['laptop', 0.72, 0.62, 0.9, 'idle', '工具3']], ['top', 'neutral', 'bright'])),
      B('第一步：关键操作', ['close-up', 'top-down', 'static'], '明亮，无手影', '桌面', '手与操作', '俯拍手部操作，配数字序号', '第一步', [
        '手机固定在正上方，手的影子不要挡操作。',
        '动作放慢，重要的地方停半秒。',
        '字幕只写动作，不写长句。',
      ], ['教程 手部 操作 俯拍', 'hands on tutorial overhead'], ['bt_top_down', 'bt_slide_push'],
      P('office', 'day', [['product', 0.5, 0.64, 1.2, 'idle', '操作']], ['top', 'neutral', 'bright'])),
      B('第二步：细节放大', ['extreme-close-up', 'eye-level', 'push-in'], '侧光', '桌面', '操作细节', '关键细节放大，强调容易出错的地方', '注意这里', [
        '用微距或 2x–3x 靠近细节。',
        '后期再放大一次并加箭头或圈注。',
        '讲一句为什么，帮助理解。',
      ], ['教程 细节 放大 注意', 'tutorial detail zoom in'], ['bt_push_in_emphasis', 'bt_macro_detail'],
      P('office', 'day', [['product', 0.5, 0.74, 1.8, 'idle', '细节']], ['left', 'neutral', 'dramatic'])),
      B('第三步：完成', ['medium-close', 'eye-level', 'static'], '明亮均匀', '桌前', '手和成果', '完成最后一步，成果和做之前形成对比', '第三步', [
        '和开头保持同一机位，方便对比。',
        '可以用擦除转场直接显示前后。',
        '成果多停留 1–2 秒。',
      ], ['教程 完成 前后对比', 'tutorial before after result'], ['bt_before_after', 'bt_slide_push'],
      P('office', 'day', [['product', 0.5, 0.7, 1.2, 'raise', '成果']], ['left', 'neutral', 'bright'])),
      B('常见错误提醒', ['medium-close', 'eye-level', 'static'], '柔和正面光', '桌前', '讲解者', '说一个容易踩的坑和解决办法', '千万别这样', [
        '回到口播机位，交替放大制造伪多机位。',
        '剪掉气口，语速略快。',
        '关键词用大字弹出。',
      ], ['教程 避坑 提醒 口播', 'tutorial common pitfalls'], ['bt_talking_breath_cut', 'bt_keyword_caption'],
      P('office', 'day', [['person', 0.5, 0.88, 1.3, 'talk', '讲解者']], ['front', 'neutral', 'soft'])),
      B('总结 + 收藏', ['medium-close', 'eye-level', 'push-in'], '柔和正面光', '桌前', '讲解者与成果', '一句话总结三步，提醒收藏', '先收藏，马上试', [
        '把三步的关键词一次性列在画面上。',
        '缓慢推近，语气真诚。',
        '明确告诉观众收藏 / 关注，有什么下一集。',
      ], ['教程 结尾 总结 收藏', 'tutorial ending summary subscribe'], ['bt_cta_ending', 'bt_keyword_caption'],
      P('office', 'day', [['person', 0.5, 0.88, 1.2, 'talk', '讲解者'], ['text', 0.5, 0.22, 1, 'idle', '收藏']], ['front', 'warm', 'soft'], '先收藏，马上试')),
    ],
  },
  fashion: {
    beats: [
      B('变装钩子', ['full', 'eye-level', 'zoom-punch'], '明亮自然光', '镜前/街头', '人物', '手挡镜头一换装，前后反差', '普通人也能这么穿', [
        '手机固定，先穿普通款，用手遮住镜头。',
        '换好后从遮挡位置把手拿开，动作方向一致。',
        '变装瞬间对齐音乐重拍。',
      ], ['变装 遮挡 转场 穿搭', 'outfit change transition'], ['bt_hook_3s', 'bt_occlusion'],
      P('street', 'day', [['person', 0.5, 0.88, 1.2, 'turn', '模特']], ['left', 'neutral', 'bright'])),
      B('全身亮相', ['full', 'low', 'tracking'], '柔和逆光', '街头', '全身搭配', '低机位拍人物走向镜头', '', [
        '手机放到膝盖高度，用 1x，显腿长。',
        '让人物走向镜头，步伐放慢。',
        '背景选干净的墙面或街道。',
      ], ['穿搭 街拍 低机位 走路', 'street style low angle walk'], ['bt_low_angle_hero', 'bt_golden_backlight'],
      P('street', 'golden', [['person', 0.5, 0.9, 1.4, 'walk-left', '模特']], ['back', 'warm', 'soft'])),
      B('单品细节', ['extreme-close-up', 'eye-level', 'static'], '侧光', '室内', '面料、配饰', '面料纹理、扣子、配饰特写', '', [
        '用微距或 2x 靠近 15 厘米。',
        '窗边侧光，纹理最明显。',
        '每个单品 1–2 秒，卡点切换。',
      ], ['面料 细节 配饰 特写', 'fabric texture jewelry close up'], ['bt_macro_detail', 'bt_beat_cut'],
      P('studio', 'day', [['product', 0.5, 0.74, 1.8, 'idle', '单品']], ['left', 'neutral', 'dramatic'])),
      B('上身展示（转身）', ['medium', 'eye-level', 'orbit'], '柔光', '街头/棚内', '模特', '人物慢慢转身，或镜头环绕', '', [
        '让人物慢慢转一圈，或自己小步环绕。',
        '用 2x 焦段背景虚化。',
        '开慢动作拍头发和衣摆。',
      ], ['模特 转身 环绕 慢动作', 'model turning slow motion'], ['bt_orbit', 'bt_slow_motion'],
      P('studio', 'day', [['person', 0.5, 0.88, 1.3, 'turn', '模特']], ['back', 'warm', 'soft'])),
      B('搭配公式讲解', ['medium-close', 'eye-level', 'static'], '蝴蝶光或窗光', '镜前', '讲解者', '一句话讲清搭配公式，文字弹出', '上浅下深，显高 5 厘米', [
        '光放在手机正上方偏前，下巴放一张白纸反光。',
        '用 2x 焦段，眼睛看镜头。',
        '公式用大字弹出，停 1.5 秒。',
      ], ['穿搭 公式 口播 讲解', 'outfit formula talking head'], ['bt_butterfly', 'bt_keyword_caption'],
      P('home', 'day', [['person', 0.5, 0.88, 1.3, 'talk', '讲解者']], ['front', 'neutral', 'soft'])),
      B('多套快闪', ['full', 'eye-level', 'static'], '同样光线', '同一地点', '模特', '同一机位连续换 3–4 套，卡点跳切', '', [
        '手机固定不动，人站同一位置换衣服。',
        '每套只留 1 秒，动作相同。',
        '剪辑点对准鼓点。',
      ], ['穿搭 换装 卡点 跳切', 'outfit montage jump cut beat'], ['bt_jump_cut', 'bt_beat_cut'],
      P('studio', 'day', [['person', 0.5, 0.88, 1.2, 'idle', '模特']], ['front', 'neutral', 'bright'])),
      B('收尾与同款', ['medium', 'eye-level', 'pull-out'], '黄金时刻', '街头', '模特', '人物回头一笑，字幕给出同款信息', '同款都在主页', [
        '让人物走远回头，用 2x 焦段抓笑容。',
        '慢慢拉远，留白放字幕。',
        '字幕写同款获取方式，引导关注。',
      ], ['穿搭 结尾 回头 微笑', 'fashion video ending look back'], ['bt_cta_ending', 'bt_warm_film'],
      P('street', 'golden', [['person', 0.5, 0.88, 1.2, 'turn', '模特'], ['text', 0.5, 0.25, 1, 'idle', '同款']], ['back', 'warm', 'soft'], '同款都在主页')),
    ],
  },
  generic: {
    beats: [
      B('开场钩子', ['close-up', 'eye-level', 'zoom-punch'], '明亮有方向的光', '主要场景', '最吸引人的画面', '第一秒就出现主体和动作，并抛出一个问题', '你知道吗？', [
        '把全片最好看的画面放在第一镜。',
        '主体放在画面中心，1 秒内有动作变化。',
        '字幕用一句问题或结论，放大显示。',
      ], ['短视频 开头 钩子', 'short video hook opening'], ['bt_hook_3s', 'bt_suspense_first'],
      P('studio', 'day', [['person', 0.5, 0.82, 1.4, 'raise', '主角']], ['left', 'warm', 'soft'])),
      B('交代环境', ['wide', 'eye-level', 'pan-right'], '自然光', '主要场景', '场景全貌', '展示故事发生的地方', '', [
        '用 1x 或 0.5x 拍全景，地平线放三分线。',
        '腰为轴匀速摇 3–4 秒。',
        '人物或主体放在画面三分线上。',
      ], ['环境 全景 空镜', 'establishing wide shot b-roll'], ['bt_rule_of_thirds', 'bt_leading_lines'],
      P('street', 'day', [['person', 0.34, 0.88, 0.7, 'walk-right', '主角']], ['left', 'neutral', 'soft'])),
      B('主角登场', ['medium', 'eye-level', 'tracking'], '侧前方柔光', '主要场景', '主角', '主角走入画面开始做事', '', [
        '手机胸口高度，跟随主角 1–2 米。',
        '打开防抖，走「忍者步」。',
        '主角放在三分线，行进方向留白。',
      ], ['人物 走路 跟拍', 'person walking follow shot'], ['bt_follow_shot', 'bt_rule_of_thirds'],
      P('street', 'day', [['person', 0.45, 0.88, 1.1, 'walk-right', '主角']], ['left', 'warm', 'soft'])),
      B('关键细节', ['extreme-close-up', 'eye-level', 'push-in'], '侧光', '操作处', '关键物品', '最重要的物品或动作特写', '', [
        '用微距或 2x–3x 靠近 15 厘米。',
        '光从侧面来突出质感。',
        '缓慢推近 3 秒，强调重点。',
      ], ['特写 细节 手部', 'detail close up shot'], ['bt_macro_detail', 'bt_push_in_emphasis'],
      P('studio', 'day', [['product', 0.5, 0.74, 1.8, 'idle', '细节']], ['left', 'neutral', 'dramatic'])),
      B('过程展开', ['medium', 'high', 'static'], '明亮均匀', '主要场景', '主角与动作', '展示过程，每一步都有变化', '', [
        '机位略高或俯拍，把过程看清楚。',
        '每个步骤 2–3 秒，可以跳切。',
        '不同景别交替，避免枯燥。',
      ], ['过程 记录 跳切', 'process montage b-roll'], ['bt_three_act', 'bt_jump_cut'],
      P('studio', 'day', [['person', 0.4, 0.88, 1, 'idle', '主角'], ['box', 0.65, 0.78, 0.8, 'idle', '道具']], ['left', 'neutral', 'bright'])),
      B('情绪高潮', ['close-up', 'low', 'push-in'], '逆光或侧逆光', '主要场景', '主角表情或成果', '最有情绪/成就感的一刻，慢动作', '', [
        '光从主体后方来，点击主体调曝光。',
        '开慢动作，动作开始前多录 1 秒。',
        '配合音乐高潮，可以先静音半秒。',
      ], ['慢动作 情绪 特写 逆光', 'emotional close up slow motion backlight'], ['bt_slow_motion', 'bt_silence_contrast'],
      P('studio', 'golden', [['person', 0.5, 0.92, 1.6, 'turn', '主角']], ['back', 'warm', 'dramatic'])),
      B('结果呈现', ['medium', 'eye-level', 'orbit'], '柔和明亮', '主要场景', '最终结果', '清晰展示最后的结果', '', [
        '结果放画面中心，环绕或缓慢推近。',
        '画面清爽，把杂物清掉。',
        '多停留 1–2 秒。',
      ], ['结果 展示 环绕', 'final result reveal orbit'], ['bt_orbit', 'bt_negative_space'],
      P('studio', 'day', [['product', 0.5, 0.72, 1.3, 'rotate', '结果']], ['left', 'warm', 'soft'])),
      B('结尾与行动号召', ['medium-close', 'eye-level', 'pull-out'], '柔和正面光', '主要场景', '主角或 Logo', '一句话总结并告诉观众下一步做什么', '喜欢就关注我', [
        '留白放字幕，缓慢拉远。',
        '一句话说清楚下一步：关注、评论、到店或点击。',
        '最后定格 1–2 秒，可淡出到黑。',
      ], ['短视频 结尾 关注 引导', 'video ending call to action'], ['bt_cta_ending', 'bt_dip_black_chapter'],
      P('studio', 'day', [['person', 0.5, 0.88, 1.1, 'talk', '主角'], ['text', 0.5, 0.25, 1, 'idle', '{name}']], ['front', 'warm', 'soft'], '{name}')),
    ],
  },
};

export const LOCAL_TOPICS = Object.keys(TEMPLATES);

const BEAT_WEIGHT_FIRST = 0.75;
const BEAT_WEIGHT_LAST = 1.15;

function pickBeats(beats, count) {
  if (count >= beats.length) return beats.slice();
  if (count <= 1) return [beats[0]];
  const out = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.round((i * (beats.length - 1)) / (count - 1));
    out.push(beats[idx]);
  }
  return out;
}

function shotCount(duration, pacing, maxBeats) {
  const avg = { fast: 2.5, medium: 4, slow: 5.5 }[pacing] || 4;
  const n = Math.round(duration / avg);
  return Math.max(4, Math.min(8, Math.min(maxBeats, n)));
}

function distribute(duration, n) {
  const weights = Array.from({ length: n }, (_, i) => (i === 0 ? BEAT_WEIGHT_FIRST : i === n - 1 ? BEAT_WEIGHT_LAST : 1));
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = weights.map((w) => Math.max(1.2, Math.round((duration * w) / sum * 10) / 10));
  const diff = Math.round((duration - out.reduce((a, b) => a + b, 0)) * 10) / 10;
  out[n - 1] = Math.max(1.2, Math.round((out[n - 1] + diff) * 10) / 10);
  return out;
}

function transitionFor(i, n, pacing) {
  if (i === 0) return pacing === 'slow' ? 'dip-black' : 'cut';
  if (i === n - 1) return pacing === 'fast' ? 'cut' : 'crossfade';
  if (pacing === 'slow') return i % 2 === 0 ? 'crossfade' : 'cut';
  if (pacing === 'fast') return i % 3 === 2 ? 'zoom-in' : 'cut';
  return 'cut';
}

// 只有通称、没有真名时，字幕里的名字用占位（事实边界：不编店名/产品名）
const NAME_PLACEHOLDER = { drink: '（店名待填）', food: '（店名待填）', product: '（产品名待填）', unboxing: '（产品名待填）' };
const GENERIC_TITLE_RE = /^(?:新品|产品|商品|好物|品牌)(?:广告|宣传|推广|种草|测评|开箱)?$|^(?:开箱|测评|开箱测评|探店)$/;

/** 本地分镜：按主题模板 × 时长生成 4–8 镜 */
export function localStoryboard(brief) {
  const b = createBrief(brief || {});
  const duration = Math.max(5, Math.min(600, Number(b.duration) || 30));
  const topic = detectTopic(`${b.title} ${b.goal} ${b.style} ${b.keyMessage}`) || 'generic';
  const tpl = TEMPLATES[topic] || TEMPLATES.generic;
  const dflt = TOPIC_DEFAULTS[topic];
  const pacing = b.pacing || dflt.pacing;
  const count = shotCount(duration, pacing, tpl.beats.length);
  const beats = pickBeats(tpl.beats, count);
  const durations = distribute(duration, beats.length);
  const look = b.look && b.look !== 'none' ? b.look : dflt.look;
  const palette = LOOK_PALETTES[look] || LOOK_PALETTES.none;
  const vertical = b.aspect === '9:16';
  const hold = vertical ? '手机竖着拿（9:16），主体放画面中部，下方 1/4 留给字幕。' : `手机横着拿（${(ASPECTS[b.aspect] || ASPECTS['16:9']).label}），开网格线对齐水平线。`;
  // 标题只是通称（咖啡店探店）时，字幕里的店名/产品名用占位，不替用户编名字
  const rawName = (b.title || '').replace(/(宣传片|短片|视频|短视频)$/, '').replace(/探店$/, '').trim();
  const generic = !rawName || GENERIC_SHOP_RE.test(rawName) || GENERIC_TITLE_RE.test(rawName) || Object.values(TOPIC_LABELS).includes(rawName);
  const name = (generic && NAME_PLACEHOLDER[topic]) || (b.title || TOPIC_LABELS[topic] || '').replace(/(宣传片|短片|视频|短视频)$/, '') || TOPIC_LABELS[topic];
  const fill = (s) => String(s || '').replace(/\{name\}/g, name);

  const shots = beats.map((beat, i) => {
    const [shotSize, angle, movement] = beat.cam;
    const subs = beat.pv.subs.map(([kind, x, y, scale, action, label], k) => ({
      kind, x, y, scale, action, label: fill(label), color: palette[k % 2 === 0 ? 1 : 2],
    }));
    return createShot({
      id: uid('sht'),
      index: i + 1,
      title: fill(beat.title),
      duration: durations[i],
      shotSize, angle, movement,
      lighting: beat.lighting,
      location: beat.location,
      subject: fill(beat.subject),
      action: fill(beat.action),
      caption: fill(beat.caption),
      voiceover: '',
      // 握持方式全片一样：只在第 1 镜写，其余镜头留给各自的拍法（风格指南里也有一条）
      shootingTips: i === 0 ? [hold, ...beat.tips.map(fill)] : beat.tips.map(fill),
      transitionIn: transitionFor(i, beats.length, pacing),
      look,
      referenceQueries: beat.refs.slice(),
      techniqueIds: beat.tech.slice(),
      previz: createPrevizSpec({
        setting: beat.pv.setting,
        timeOfDay: beat.pv.timeOfDay,
        palette: palette.slice(0, 3),
        subjects: subs,
        camera: { shotSize, movement, angle },
        light: { direction: beat.pv.light[0], key: beat.pv.light[1], mood: beat.pv.light[2] },
        overlayText: fill(beat.pv.overlay),
      }),
      assetId: null,
      status: 'planned',
    });
  });

  // 平均镜长按实际算（镜头数有上限，快节奏 30 秒也只有 8 镜）
  const avg = Math.round((duration / Math.max(1, shots.length)) * 10) / 10;
  const pacingText = {
    fast: `快节奏，平均每镜约 ${avg} 秒，剪辑点尽量对齐音乐重拍${avg > 3 ? '；单个镜头可以再拆成 2–3 个更短的切点' : ''}`,
    medium: `中速节奏，平均每镜约 ${avg} 秒，段落之间有起伏`,
    slow: `慢节奏，平均每镜约 ${avg} 秒，用叠化和长镜头留出情绪`,
  }[pacing];
  const styleGuide = [
    `全片基调：${b.style || dflt.style}，情绪${b.mood || dflt.mood}。`,
    `画幅：${hold}`,
    `调色：统一使用「${LOOK_LABELS[look] || look}」，所有镜头强度一致，避免个别镜头跳色。`,
    `光线与运镜：尽量使用同一方向的自然光，运镜服务于重点，不用的镜头就保持稳定。`,
    `剪辑：${pacingText}。`,
    `字幕与声音：字幕简短统一；音乐建议${b.music || dflt.music}。`,
  ].join('\n');

  const total = Math.round(shots.reduce((s, x) => s + x.duration, 0));
  const reply = [
    `已按「${TOPIC_LABELS[topic]}」模板生成 ${shots.length} 个分镜，总时长约 ${total} 秒，每个镜头都写好了手机拍法和参考搜索词。`,
    placeholderNote(shots),
    '这版是本地模板，适合先搭个骨架，再逐个镜头改成你的版本。',
  ].filter(Boolean).join('\n');

  return { shots, styleGuide, reply };
}

/** 字幕里有「（店名待填）」这类占位时，提醒用户换成真实信息 */
function placeholderNote(shots) {
  for (const s of shots || []) {
    const m = /（[^（）]{1,8}待填）/.exec(String((s && s.caption) || ''));
    if (m) return `字幕里的「${m[0]}」这类占位，记得换成真实信息再发。`;
  }
  return '';
}

// ===========================================================================
// 本地技法推断（无 AI 时，从统计数据生成有据可依的技法卡）
// ===========================================================================
const SEL = () => ({ mode: 'selected', indices: [], ids: [] });
function r1(n) { return Math.round((Number(n) || 0) * 10) / 10; }
function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function fmt(t) {
  const s = Math.max(0, Number(t) || 0);
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s - m * 60)).padStart(2, '0')}`;
}
function mean(list) { return list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0; }
function stdev(list) {
  if (list.length < 2) return 0;
  const m = mean(list);
  return Math.sqrt(mean(list.map((x) => (x - m) ** 2)));
}

function analysisCard(analysis, category, title, summary, steps, whenToUse, tags, ops, note, start, end) {
  return {
    id: uid('tq'),
    category,
    title,
    summary,
    steps,
    whenToUse,
    tags,
    builtin: false,
    source: { analysisId: analysis.id || null, title: analysis.title || '', start: r2(start), end: r2(end) },
    apply: ops && ops.length ? { ops: ops.map((o) => ({ ...o, target: SEL() })), note: note || '' } : null,
  };
}

/** 切点最密集的时间窗 */
function densestWindow(shots, duration) {
  const win = Math.min(10, Math.max(2, duration));
  const cuts = shots.map((s) => Number(s.start) || 0).filter((t) => t > 0);
  let best = { start: 0, end: win, count: -1 };
  for (const start of [0, ...cuts]) {
    const end = Math.min(duration, start + win);
    const count = cuts.filter((c) => c >= start && c < end).length;
    if (count > best.count) best = { start, end, count };
  }
  return best;
}

function colorCards(analysis, shots, duration) {
  const cp = analysis.colorProfile;
  if (!cp || typeof cp !== 'object') return [];
  const luma = Number(cp.luma); const sat = Number(cp.saturation); const warm = Number(cp.warmth); const contrast = Number(cp.contrast);
  const extreme = (selector) => {
    let bestShot = shots[0] || null; let best = -Infinity;
    for (const s of shots) {
      const v = s && s.stats ? selector(s.stats) : -Infinity;
      if (v > best) { best = v; bestShot = s; }
    }
    return bestShot ? { start: Number(bestShot.start) || 0, end: Number(bestShot.end) || 0 } : { start: 0, end: duration };
  };
  const cards = [];
  if (Number.isFinite(luma) && luma < 0.3) {
    const t = extreme((st) => -Number(st.luma));
    cards.push({ score: (0.3 - luma) * 3, card: analysisCard(analysis, 'lighting', `暗调氛围（平均亮度 ${r2(luma)}）`,
      `这段视频整体亮度只有 ${r2(luma)}，大部分画面压在暗部，只露出关键信息。这种低调光让观众注意力集中，氛围更有张力。`,
      ['关掉多余的灯，只保留一个方向的主光，打在主体关键部位。', '手机曝光补偿降到 -0.7 到 -1.3，防止暗部发灰。', '让背景远离光源保持黑暗，主体与背景拉开距离。', '后期压暗阴影并加一点暗角，全片保持一致。'],
      '悬疑、情绪、高端产品、深夜氛围内容。', ['暗调', '低调光', '氛围'],
      [{ type: 'setLook', look: 'moody', lookStrength: 0.8 }, { type: 'setColor', color: { exposure: -0.1, contrast: 0.15, vignette: 0.35 }, relative: false }], '套用情绪暗调并压暗', t.start, t.end) });
  }
  if (Number.isFinite(sat) && sat > 0.5) {
    const t = extreme((st) => Number(st.saturation));
    cards.push({ score: (sat - 0.5) * 2.5, card: analysisCard(analysis, 'color', `高饱和吸睛配色（饱和度 ${r2(sat)}）`,
      `平均饱和度达到 ${r2(sat)}，色彩鲜明跳跃。高饱和让画面在信息流里第一眼就抓人。`,
      ['拍摄时选择色彩丰富的场景和道具，避免灰暗背景。', '光线要足，色彩才会「亮」。', '后期提高饱和度并略提对比，注意肤色不要过红。', '全片饱和度保持一致，避免忽浓忽淡。'],
      '美食、潮流、促销、活力型短视频。', ['高饱和', '鲜艳', '配色'],
      [{ type: 'setLook', look: 'vivid', lookStrength: 0.8 }], '套用鲜艳色调', t.start, t.end) });
  } else if (Number.isFinite(sat) && sat < 0.18) {
    const t = extreme((st) => -Number(st.saturation));
    cards.push({ score: (0.18 - sat) * 3, card: analysisCard(analysis, 'color', `低饱和克制色调（饱和度 ${r2(sat)}）`,
      `平均饱和度只有 ${r2(sat)}，色彩被有意压低。低饱和让画面安静克制，注意力回到内容和情绪上。`,
      ['拍摄时选择中性色、灰色系的服装和场景。', '后期降低饱和度 15–30%，略提黑位营造褪色感。', '只留一个强调色（如红色杯子）当视觉焦点。', '配合慢节奏和轻音乐。'],
      '文艺、纪实、高级品牌、情绪片。', ['低饱和', '克制', '文艺'],
      [{ type: 'setLook', look: 'moody', lookStrength: 0.6 }, { type: 'setColor', color: { saturation: -0.2 }, relative: false }], '情绪暗调并降低饱和', t.start, t.end) });
  }
  if (Number.isFinite(warm) && warm > 0.08) {
    const t = extreme((st) => Number(st.warmth));
    cards.push({ score: warm * 1.6, card: analysisCard(analysis, 'color', `统一暖调（冷暖值 +${r2(warm)}）`,
      `全片冷暖值约 +${r2(warm)}，整体偏暖。暖调让画面亲切、有人情味，也让不同镜头更容易连贯。`,
      ['拍摄选择早晚的暖光或开暖灯，白平衡设为阴天模式。', '后期套用暖调胶片，强度全片一致。', '服装和道具选择米色、木色、橙色系，强化暖调。', '检查白色物体不要偏得太黄。'],
      '生活方式、餐饮、家庭、治愈类内容。', ['暖调', '胶片', '治愈'],
      [{ type: 'setLook', look: 'film-warm', lookStrength: 0.8 }], '套用暖调胶片', t.start, t.end) });
  } else if (Number.isFinite(warm) && warm < -0.08) {
    const t = extreme((st) => -Number(st.warmth));
    cards.push({ score: -warm * 1.6, card: analysisCard(analysis, 'color', `统一冷调（冷暖值 ${r2(warm)}）`,
      `全片冷暖值约 ${r2(warm)}，整体偏冷。冷调让画面显得冷静、科技、都市感强。`,
      ['拍摄选择阴天、蓝调时刻或冷色灯光。', '后期套用冷调胶片，让暗部偏青。', '保留一点暖色（肤色或灯光）做冷暖对比。', '全片强度一致。'],
      '科技产品、都市、夜景、悬疑内容。', ['冷调', '都市', '科技'],
      [{ type: 'setLook', look: 'film-cool', lookStrength: 0.8 }], '套用冷调胶片', t.start, t.end) });
  }
  if (Number.isFinite(contrast) && contrast > 0.55) {
    cards.push({ score: (contrast - 0.55) * 2, card: analysisCard(analysis, 'color', `高反差视觉冲击（对比度 ${r2(contrast)}）`,
      `对比度达到 ${r2(contrast)}，明暗分明。高反差让画面硬朗、有力量，缩略图也更醒目。`,
      ['用硬光（直射光、窄光束）拍摄，阴影边缘清晰。', '暗部压黑，高光保留细节。', '搭配黑白或深色背景更明显。', '人脸注意不要过曝。'],
      '运动、潮流、广告、海报感镜头。', ['高反差', '硬光', '冲击力'],
      [{ type: 'setLook', look: 'high-contrast', lookStrength: 0.75 }], '套用高反差', 0, duration) });
  }
  return cards.sort((a, b) => b.score - a.score).map((c) => c.card);
}

/**
 * 从拆片统计数据推断技法卡（2–4 条），每条的 source 指向分析与时间段；完全没有数据时返回空数组（不编造）。
 */
export function localAnalyzeTechniques(analysis) {
  if (!analysis || typeof analysis !== 'object') return [];
  const shots = Array.isArray(analysis.shots) ? analysis.shots.filter(Boolean) : [];
  const rhythm = analysis.rhythm || {};
  const durations = Array.isArray(rhythm.durations) && rhythm.durations.length
    ? rhythm.durations.map(Number).filter(Number.isFinite)
    : shots.map((s) => Number(s.duration) || ((Number(s.end) || 0) - (Number(s.start) || 0))).filter((d) => d > 0);
  const duration = Number(analysis.duration) > 0
    ? Number(analysis.duration)
    : (shots.length ? Number(shots[shots.length - 1].end) || 0 : 0);
  const avgShot = Number(rhythm.avgShot) > 0 ? Number(rhythm.avgShot) : mean(durations);
  const hasData = shots.length > 0 || durations.length > 0 || (analysis.colorProfile && typeof analysis.colorProfile === 'object');
  if (!hasData) return [];

  const cards = [];

  // —— 节奏 ——
  if (durations.length && avgShot > 0) {
    const cpm = Number(rhythm.cutsPerMinute) > 0 ? Number(rhythm.cutsPerMinute) : (avgShot > 0 ? 60 / avgShot : 0);
    if (avgShot < 1.5) {
      const w = densestWindow(shots, duration);
      cards.push(analysisCard(analysis, 'rhythm', `快节奏卡点（平均 ${r1(avgShot)} 秒一镜）`,
        `这段视频平均 ${r1(avgShot)} 秒切一次，每分钟约 ${Math.round(cpm)} 次切换。高密度剪辑让观众没有走神的空隙，能量感很强。`,
        ['先定音乐，在时间线标记鼓点。', '准备比鼓点更多的素材，每段 0.5–1.5 秒，只留动作最强的瞬间。', '剪辑点对齐鼓点，副歌可以 1 拍一切。', `可以参考 ${fmt(w.start)}–${fmt(w.end)} 这一段的切换密度。`],
        '混剪、产品快闪、运动、活动回顾。', ['卡点', '快节奏', '高密度剪辑'],
        [{ type: 'applyPacing', pacing: 'fast' }, { type: 'setTransition', transition: { type: 'cut', duration: 0.5 } }], '快节奏时长 + 硬切', w.start, w.end));
    } else if (avgShot > 4) {
      let longest = shots[0] || null;
      for (const s of shots) if (((Number(s.end) || 0) - (Number(s.start) || 0)) > ((Number(longest.end) || 0) - (Number(longest.start) || 0))) longest = s;
      const start = longest ? Number(longest.start) || 0 : 0;
      const end = longest ? Number(longest.end) || duration : duration;
      cards.push(analysisCard(analysis, 'rhythm', `长镜头沉浸（平均 ${r1(avgShot)} 秒一镜）`,
        `这段视频平均 ${r1(avgShot)} 秒才切一次，最长的镜头约 ${r1(end - start)} 秒。长镜头留给观众进入情绪的时间，沉浸感更强。`,
        ['在拍摄前设计好镜头内的调度，让主体或光线有变化，防止沉闷。', '手机用稳定器或双手贴身，运动保持缓慢匀速。', '配合环境音和低频音乐，不要频繁切换。', `可以参考 ${fmt(start)}–${fmt(end)} 这一段的长镜头处理。`],
        '情绪片、纪录片、治愈系、品牌故事。', ['长镜头', '沉浸', '慢节奏'],
        [{ type: 'applyPacing', pacing: 'slow' }, { type: 'setMotion', preset: 'drift', intensity: 0.3 }], '放慢节奏并加缓慢漂移', start, end));
    } else {
      const sd = stdev(durations);
      if (avgShot > 0 && sd / avgShot > 0.6 && shots.length >= 3) {
        const sorted = shots.slice().sort((a, b) => ((Number(a.end) - Number(a.start)) || 0) - ((Number(b.end) - Number(b.start)) || 0));
        const short = sorted[0]; const long = sorted[sorted.length - 1];
        cards.push(analysisCard(analysis, 'rhythm', `张弛有度（平均 ${r1(avgShot)} 秒，长短交替）`,
          `镜头时长从 ${r1(Number(short.end) - Number(short.start))} 秒到 ${r1(Number(long.end) - Number(long.start))} 秒不等，形成明显的快慢交替。节奏变化能持续制造新鲜感，比匀速剪辑更抓人。`,
          ['把信息密集的段落剪短（1–2 秒），把情绪重点留长（4 秒以上）。', '快段之后紧跟一个长镜头，让观众喘口气。', '节奏变化的位置对齐音乐段落。'],
          '宣传片、故事短片、vlog。', ['节奏变化', '张弛', '剪辑'],
          [{ type: 'applyPacing', pacing: 'medium' }], '均衡节奏', Number(long.start) || 0, Number(long.end) || duration));
      }
    }
  }

  // —— 色彩 ——
  const colors = colorCards(analysis, shots, duration);
  if (colors.length) cards.push(colors[0]);

  // —— 响度峰值与切点 ——
  const peaks = analysis.audio && Array.isArray(analysis.audio.peaks) ? analysis.audio.peaks.map(Number).filter(Number.isFinite) : [];
  if (peaks.length >= 3 && shots.length >= 3) {
    const boundaries = shots.map((s) => Number(s.start) || 0).filter((t) => t > 0);
    const aligned = peaks.filter((p) => boundaries.some((b) => Math.abs(b - p) <= 0.2));
    const ratio = aligned.length / peaks.length;
    if (ratio >= 0.4 && aligned.length >= 2) {
      cards.push(analysisCard(analysis, 'sound', `音乐重拍对齐剪辑点（${Math.round(ratio * 100)}% 峰值落在切点）`,
        `检测到 ${peaks.length} 个响度峰值，其中 ${aligned.length} 个落在剪辑点 0.2 秒内。声音和画面同时变化，让剪辑显得非常「顺」。`,
        ['先听音乐，在时间线标出重拍位置。', '把切换镜头、动作落点放在重拍上。', '段落切换用音乐的起落做分隔。', `可以参考 ${fmt(aligned[0])}–${fmt(aligned[aligned.length - 1])} 这段的对位。`],
        '所有带音乐的短视频和混剪。', ['卡点', '音乐', '剪辑点'],
        [{ type: 'applyPacing', pacing: 'medium' }], '按中等节奏排列，再手动对齐重拍', aligned[0], aligned[aligned.length - 1]));
    } else {
      // 响度峰值作为情绪高潮
      const top = peaks[Math.floor(peaks.length / 2)];
      cards.push(analysisCard(analysis, 'sound', `响度峰值塑造高潮（约 ${fmt(top)} 处）`,
        `这段视频有 ${peaks.length} 个响度峰值，集中在关键段落。声音的起伏带动情绪，高潮前后的响度反差尤其重要。`,
        ['在高潮前 0.5–1 秒压低音乐或静音，制造反差。', '高潮瞬间让音量和画面同时放大。', '高潮之后留一个安静的镜头收尾。'],
        '宣传片高潮段落、产品揭晓、运动瞬间。', ['响度', '声音设计', '高潮'],
        null, '', Math.max(0, top - 1), Math.min(duration || top + 1, top + 1)));
    }
  } else if (peaks.length >= 1) {
    const top = peaks[0];
    cards.push(analysisCard(analysis, 'sound', `声音重音设计（约 ${fmt(top)} 处）`,
      `检测到响度峰值出现在 ${fmt(top)} 附近。把最重要的画面放在这个声音重音上，记忆点更强。`,
      ['找到音频最响的那一刻，让它和最重要的画面同时出现。', '重音前略微压低其他声音。', '结尾不要再出现比高潮更响的声音。'],
      '任何有明显声音起伏的片段。', ['响度', '重音'],
      null, '', Math.max(0, top - 1), Math.min(duration || top + 1, top + 1)));
  }

  // —— 运动 ——
  const motions = shots.map((s) => Number(s.motion)).filter(Number.isFinite);
  if (motions.length) {
    const avgMotion = mean(motions);
    let peakIdx = 0;
    shots.forEach((s, i) => { if ((Number(s.motion) || 0) > (Number(shots[peakIdx].motion) || 0)) peakIdx = i; });
    const peakShot = shots[peakIdx];
    if (avgMotion > 0.5) {
      cards.push(analysisCard(analysis, 'camera', `高运动镜头（平均运动强度 ${r2(avgMotion)}）`,
        `平均运动强度 ${r2(avgMotion)}，大部分镜头都有明显移动，峰值在第 ${peakIdx + 1} 镜。持续的运动带来强烈临场感和速度感。`,
        ['手机打开防抖，手持跟随主体走动或奔跑。', '多用推、跟、甩，保持动作方向一致。', '在高运动镜头之间穿插短暂稳定的镜头，让观众喘息。'],
        '运动、街拍、动作、活力宣传片。', ['运动', '手持', '临场感'],
        [{ type: 'setMotion', preset: 'shake', intensity: 0.35 }], '加手持晃动', Number(peakShot.start) || 0, Number(peakShot.end) || duration));
    } else if (avgMotion < 0.12) {
      cards.push(analysisCard(analysis, 'camera', `稳定固定机位（平均运动强度 ${r2(avgMotion)}）`,
        `平均运动强度只有 ${r2(avgMotion)}，几乎全是固定机位。稳定的画面显得克制、精致，让注意力落在构图和内容上。`,
        ['手机用三脚架或靠在稳固的物体上。', '提前设计构图和画面内的动作，让主体动而机位不动。', '用剪辑节奏而不是镜头运动带动观感。'],
        '产品片、访谈、精致生活类内容。', ['固定机位', '稳定', '构图'],
        [{ type: 'setMotion', preset: 'none', intensity: 0 }], '去掉运镜保持固定', 0, duration || Number(peakShot.end) || 0));
    }
  }

  // —— 第二张色彩卡 ——
  if (colors[1] && cards.length < 4) cards.push(colors[1]);

  // —— 兜底：数据不足 2 条时，按实际统计给节奏/配色参考 ——
  if (cards.length < 2 && durations.length && avgShot > 0) {
    cards.push(analysisCard(analysis, 'rhythm', `节奏参考（平均 ${r1(avgShot)} 秒一镜，共 ${durations.length} 镜）`,
      `这段视频共 ${durations.length} 镜，平均 ${r1(avgShot)} 秒一镜。把这个节奏作为同类内容的参考基准，可以少走很多弯路。`,
      [`把自己成片的平均镜头时长控制在 ${r1(avgShot * 0.8)}–${r1(avgShot * 1.2)} 秒。`, '重点段落可以放慢，过渡段落可以加快。', '剪完后整体看一遍，感觉拖沓的镜头继续缩短。'],
      '想模仿这条视频节奏时。', ['节奏', '参考'],
      [{ type: 'applyPacing', pacing: avgShot < 2.5 ? 'fast' : avgShot > 4 ? 'slow' : 'medium' }], '按相近节奏排列', 0, duration));
  }
  if (cards.length < 2 && analysis.colorProfile && Array.isArray(analysis.colorProfile.palette) && analysis.colorProfile.palette.length) {
    const cp = analysis.colorProfile;
    cards.push(analysisCard(analysis, 'color', '配色参考（主色提取）',
      `这段视频的主色是 ${cp.palette.slice(0, 5).join('、')}，亮度 ${r2(cp.luma)}、饱和度 ${r2(cp.saturation)}。沿用同样的配色和明暗，可以快速接近它的视觉感觉。`,
      ['拍摄时让服装、道具、背景靠近这几个主色。', '后期让全片亮度和饱和度接近上面的数值。', '用「统一色调」让不同镜头向基准靠拢。'],
      '想模仿这条视频色调时。', ['配色', '色彩参考'],
      [{ type: 'harmonize', strength: 0.6 }], '向全片基准色靠拢', 0, duration));
  }

  return cards.slice(0, 4);
}
