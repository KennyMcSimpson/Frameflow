// 实拍参考素材（免费可商用的库存视频）：为分镜生成英文搜索词、从搜索结果里挑最合适的一条。纯函数。
// 来源优先 Pexels / Pixabay（需免费 API Key），没有 Key 时退回 Wikimedia Commons。

const CJK = /[㐀-鿿]/;

// 常见画面元素中→英。按词长从长到短匹配，避免「咖啡」先吃掉「咖啡店」。
const ZH_EN = {
  咖啡店: 'coffee shop', 咖啡馆: 'cafe', 咖啡豆: 'coffee beans', 咖啡机: 'espresso machine', 拉花: 'latte art', 手冲: 'pour over coffee',
  意式浓缩: 'espresso', 浓缩: 'espresso', 拿铁: 'latte', 咖啡师: 'barista', 咖啡杯: 'coffee cup', 咖啡: 'coffee', 研磨: 'grinding', 磨豆: 'coffee grinder',
  蒸汽: 'steam', 热气: 'steam', 奶泡: 'milk foam', 牛奶: 'milk', 茶: 'tea', 杯子: 'cup', 甜点: 'dessert', 蛋糕: 'cake', 面包: 'bread', 烘焙: 'baking',
  早餐: 'breakfast', 美食: 'food', 食物: 'food', 厨房: 'kitchen', 做饭: 'cooking', 餐厅: 'restaurant', 吧台: 'bar counter', 柜台: 'counter',
  顾客: 'customer', 店员: 'staff', 女孩: 'young woman', 女生: 'young woman', 女人: 'woman', 男孩: 'young man', 男生: 'young man', 男人: 'man',
  老人: 'elderly person', 孩子: 'child', 小孩: 'child', 朋友: 'friends', 情侣: 'couple', 家人: 'family', 人群: 'crowd', 行人: 'pedestrians',
  双手: 'hands', 手部: 'hands', 手指: 'fingers', 微笑: 'smiling', 笑容: 'smile', 眼睛: 'eyes', 脸: 'face', 人物: 'person',
  城市: 'city', 街道: 'street', 街头: 'street', 马路: 'road', 夜景: 'city night', 夜晚: 'night', 夜里: 'night', 清晨: 'morning', 早晨: 'morning',
  黄昏: 'sunset', 日落: 'sunset', 日出: 'sunrise', 阳光: 'sunlight', 窗户: 'window', 窗边: 'window', 窗外: 'window view', 下雨: 'rain', 雨天: 'rain',
  雨: 'rain', 雪: 'snow', 天空: 'sky', 云: 'clouds', 大海: 'ocean', 海边: 'beach', 海浪: 'waves', 沙滩: 'beach', 湖: 'lake', 河: 'river', 山: 'mountains',
  森林: 'forest', 树林: 'forest', 草地: 'meadow', 花: 'flowers', 植物: 'plants', 公园: 'park', 乡村: 'countryside', 田野: 'fields',
  办公室: 'office', 会议: 'meeting', 电脑: 'laptop', 笔记本: 'laptop', 键盘: 'keyboard', 手机: 'smartphone', 屏幕: 'screen', 工作: 'working',
  书: 'book', 阅读: 'reading', 写字: 'writing', 学习: 'studying', 教室: 'classroom', 学校: 'school', 图书馆: 'library',
  汽车: 'car', 开车: 'driving', 地铁: 'subway', 火车: 'train', 飞机: 'airplane', 自行车: 'bicycle', 机场: 'airport', 车站: 'station',
  跑步: 'running', 运动: 'sport', 健身: 'workout', 瑜伽: 'yoga', 跳舞: 'dancing', 音乐: 'music', 吉他: 'guitar', 唱歌: 'singing',
  猫: 'cat', 狗: 'dog', 宠物: 'pet', 鸟: 'birds', 产品: 'product', 包装: 'packaging', 礼物: 'gift', 购物: 'shopping', 商店: 'store',
  房间: 'room', 卧室: 'bedroom', 客厅: 'living room', 家: 'home', 门口: 'doorway', 招牌: 'storefront sign', 门店: 'storefront', 店面: 'storefront',
  灯光: 'lights', 霓虹: 'neon lights', 烛光: 'candle light', 火: 'fire', 水: 'water', 倒: 'pouring', 倒入: 'pouring', 搅拌: 'stirring', 喝: 'drinking',
  品尝: 'tasting', 走路: 'walking', 散步: 'walking', 奔跑: 'running', 坐: 'sitting', 聊天: 'talking', 拥抱: 'hug', 握手: 'handshake',
  // v3 扩充：常见短视频/宣传片题材
  店招: 'storefront sign', 门头: 'storefront', 推门: 'opening door', 进门: 'entering', 玻璃门: 'glass door', 晨光: 'morning light', 逆光: 'backlight',
  特写: 'close up', 微距: 'macro', 慢动作: 'slow motion', 背影: 'from behind', 侧脸: 'profile face', 头发: 'hair', 发丝: 'hair', 眼神: 'eyes',
  咖啡粉: 'ground coffee', 奶缸: 'milk pitcher', 冰块: 'ice cubes', 奶茶: 'milk tea', 果汁: 'juice', 啤酒: 'beer', 红酒: 'wine', 鸡尾酒: 'cocktail',
  火锅: 'hot pot', 烧烤: 'barbecue', 面条: 'noodles', 米饭: 'rice', 寿司: 'sushi', 水果: 'fruit', 蔬菜: 'vegetables', 切菜: 'chopping vegetables',
  化妆: 'makeup', 口红: 'lipstick', 护肤: 'skincare', 香水: 'perfume', 衣服: 'clothes', 服装: 'fashion', 模特: 'model', 试衣: 'trying on clothes',
  鞋: 'shoes', 首饰: 'jewelry', 手表: 'watch', 包: 'handbag', 美甲: 'manicure', 理发: 'haircut', 花店: 'flower shop', 书店: 'bookstore',
  超市: 'supermarket', 市场: 'market', 菜市场: 'street market', 夜市: 'night market', 商场: 'shopping mall', 健身房: 'gym', 游泳: 'swimming',
  篮球: 'basketball', 足球: 'football', 骑行: 'cycling', 登山: 'hiking', 露营: 'camping', 旅行: 'travel', 旅游: 'travel', 风景: 'landscape',
  城市天际线: 'city skyline', 高楼: 'skyscrapers', 车流: 'traffic', 延时: 'timelapse', 航拍: 'aerial', 无人机: 'drone', 星空: 'starry sky', 月亮: 'moon',
  婚礼: 'wedding', 生日: 'birthday', 派对: 'party', 节日: 'festival', 烟花: 'fireworks', 新年: 'new year', 春节: 'chinese new year', 灯笼: 'lanterns',
  宝宝: 'baby', 妈妈: 'mother', 爸爸: 'father', 学生: 'student', 老师: 'teacher', 医生: 'doctor', 厨师: 'chef', 工人: 'worker', 程序员: 'programmer',
  打字: 'typing', 开会: 'meeting', 演讲: 'presentation', 采访: 'interview', 拍照: 'taking photo', 自拍: 'selfie', 直播: 'live streaming',
  看书: 'reading book', 翻书: 'turning pages', 喝咖啡: 'drinking coffee', 喝茶: 'drinking tea', 吃饭: 'eating', 做饭菜: 'cooking', 洗手: 'washing hands',
  开心: 'happy', 悲伤: 'sad', 思考: 'thinking', 放松: 'relaxing', 治愈: 'cozy', 温暖: 'warm', 安静: 'calm', 忙碌: 'busy',
  桌子: 'table', 桌面: 'tabletop', 椅子: 'chair', 沙发: 'sofa', 床: 'bed', 灯: 'lamp', 蜡烛: 'candle', 绿植: 'houseplant', 盆栽: 'potted plant',
};
const ZH_KEYS = Object.keys(ZH_EN).sort((a, b) => b.length - a.length);

const SIZE_HINT = {
  'extreme-close-up': 'close up', 'close-up': 'close up',
  'extreme-close': 'close up', close: 'close up',
  'extreme-wide': 'aerial', wide: 'wide shot',
};
const EN_STOP = new Set(['the', 'a', 'an', 'of', 'and', 'with', 'in', 'on', 'at', 'to', 'for', 'shot', 'video', 'footage', 'cinematic', 'scene', 'camera', 'slow', 'motion', 'b-roll', 'broll', '4k', 'hd']);

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** 把中文描述翻成英文关键词（按词典最长匹配，保持出现顺序，去重） */
export function zhToEnTerms(text, max = 4) {
  const s = str(text);
  if (!s) return [];
  const hits = [];
  let rest = s;
  for (const k of ZH_KEYS) {
    let i = rest.indexOf(k);
    while (i >= 0) {
      hits.push({ at: i, en: ZH_EN[k] });
      rest = rest.slice(0, i) + '\u0000'.repeat(k.length) + rest.slice(i + k.length);
      i = rest.indexOf(k);
    }
  }
  hits.sort((a, b) => a.at - b.at);
  const out = [];
  for (const h of hits) if (!out.includes(h.en)) out.push(h.en);
  return out.slice(0, max);
}

/** 英文搜索词清洗：去掉停用词，最多 maxWords 个词 */
export function cleanEnQuery(q, maxWords = 5) {
  const words = String(q || '').toLowerCase().replace(/[^a-z0-9\s'-]+/g, ' ').split(/\s+/).filter((w) => w && !EN_STOP.has(w));
  const out = [];
  for (const w of words) if (!out.includes(w)) out.push(w);
  return out.slice(0, maxWords).join(' ');
}

/**
 * 为分镜生成英文素材搜索词（从具体到宽泛，最多 3 条，去重）。
 * 依次使用：AI 导演给的英文参考词 → 主体/标题/场景的词典翻译（+ 景别提示）→ 只用最核心的一个词。
 * @param {object} shot
 * @param {{brief?: object, extra?: string[]}} [opts] extra：AI 额外生成的英文词，放最前
 * @returns {string[]}
 */
export function buildFootageQueries(shot, { brief, extra } = {}) {
  const s = shot || {};
  const out = [];
  const push = (q) => { const c = cleanEnQuery(q); if (c && c.split(' ').length >= 1 && !out.includes(c)) out.push(c); };
  for (const q of Array.isArray(extra) ? extra : []) if (!CJK.test(q)) push(q);
  const refs = Array.isArray(s.referenceQueries) ? s.referenceQueries : [];
  for (const q of refs) if (!CJK.test(String(q || ''))) push(q);

  const core = [str(s.subject), str(s.title)].join(' ');
  const coreTerms = zhToEnTerms(core, 3);
  const placeTerms = zhToEnTerms([str(s.location), str(s.action)].join(' '), 2).filter((t) => !coreTerms.includes(t));
  const hint = SIZE_HINT[s.shotSize] || '';
  if (coreTerms.length || placeTerms.length) {
    push([...coreTerms.slice(0, 2), ...placeTerms.slice(0, 1), hint].filter(Boolean).join(' '));
    push([...coreTerms, ...placeTerms].slice(0, 2).join(' '));
  }
  // 最宽泛的一条：画面里反复出现的主题词（如「咖啡师 / 咖啡店」→ coffee），小素材库也能搜到
  const briefText = brief ? [str(brief.title), str(brief.style), str(brief.goal)].join(' ') : '';
  const topic = topicTerm([core, str(s.location), str(s.action)].join(' ')) || topicTerm(briefText);
  // 英文写的主体（用户手填）也能用
  if (!out.length && !topic) for (const t of [s.subject, s.title, s.location]) if (str(t) && !CJK.test(t)) push(t);
  const head = out.slice(0, topic ? 2 : 3);
  const c = topic ? cleanEnQuery(topic) : '';
  if (c && !head.includes(c)) head.push(c);
  else if (c) for (const q of out) if (head.length < 3 && !head.includes(q)) head.push(q);
  return head.slice(0, 3);
}

/** 文本里出现次数最多的词典词（允许重叠计数，同次数取更短、更通用的词） */
export function topicTerm(text) {
  const s = str(text);
  if (!s) return '';
  // 长词的覆盖区间：短词落在长词中间/结尾（「拉花」里的「花」）不算，落在开头（「咖啡师」里的「咖啡」）算
  const spans = [];
  for (const k of ZH_KEYS) for (let i = s.indexOf(k); i >= 0; i = s.indexOf(k, i + 1)) spans.push([i, i + k.length]);
  const inside = (i, len) => spans.some(([a, b]) => b - a > len && i > a && i + len <= b);
  let best = null;
  for (const k of ZH_KEYS) {
    let n = 0;
    for (let i = s.indexOf(k); i >= 0; i = s.indexOf(k, i + 1)) {
      if (inside(i, k.length)) continue;
      // 作为更长词的前缀出现，说明它是更通用的主题（咖啡 ⊂ 咖啡师/咖啡店），额外加分
      n += spans.some(([a, b]) => a === i && b - a > k.length) ? 1.5 : 1;
    }
    if (!n) continue;
    if (!best || n > best.n || (n === best.n && k.length < best.k.length)) best = { k, n };
  }
  return best ? ZH_EN[best.k] : '';
}

/** 画幅的方向：landscape / portrait / square */
export function orientationOf(w, h) {
  const W = Number(w); const H = Number(h);
  if (!(W > 0 && H > 0)) return null;
  const r = W / H;
  if (r > 1.15) return 'landscape';
  if (r < 0.87) return 'portrait';
  return 'square';
}

function aspectOrientation(aspect) {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(aspect || '16:9'));
  return m ? orientationOf(Number(m[1]), Number(m[2])) : 'landscape';
}

// 来源加分：Pexels / Pixabay 画质最稳；互联网档案馆多为老影像，同等条件下靠后
// NASA 画质好但题材窄，略靠后
const SOURCE_BONUS = { pexels: 1, pixabay: 0.8, commons: 0, openverse: 0, nasa: -0.2, archive: -0.5 };
export const MAX_FOOTAGE_BYTES = 80 * 1048576;

/**
 * 给一条搜索结果打分（越高越合适；返回 -Infinity 表示不能用）。
 * 考虑：横竖屏是否匹配画幅、时长是否够这一镜、分辨率、文件大小、来源。
 */
export function scoreFootage(r, { aspect = '16:9', duration = 4 } = {}) {
  if (!r || r.kind !== 'video' || !r.downloadUrl || !/^https?:\/\//i.test(String(r.downloadUrl))) return -Infinity;
  if (Number(r.size) > MAX_FOOTAGE_BYTES) return -Infinity;
  let score = SOURCE_BONUS[r.source] || 0;
  const want = aspectOrientation(aspect);
  const got = orientationOf(r.width, r.height);
  if (got && want) {
    if (got === want) score += 3;
    else if (got === 'square' || want === 'square') score += 0.5;
    else score -= 3;
  }
  const d = Number(r.duration);
  const need = Number(duration) > 0 ? Number(duration) : 4;
  if (d > 0) {
    if (d >= need) score += 2;
    else if (d >= need * 0.6) score += 0.5;
    else score -= 2;
    if (d > 90) score -= 1;
  }
  const short = Math.min(Number(r.width) || 0, Number(r.height) || 0);
  if (short >= 540) score += 1;
  else if (short > 0 && short < 360) score -= 2;
  // 只是预演，超大原片下载和转码都慢
  if (Math.max(Number(r.width) || 0, Number(r.height) || 0) > 2560) score -= 1;
  return score;
}

const SAME_AUTHOR_BONUS = 1.5;
const authorKey = (a) => str(typeof a === 'string' ? a : a && a.name).toLowerCase().replace(/\s+/g, ' ');

/** 已配素材里出现过的作者（按出现次数降序），用于「同摄影师优先」 */
export function footageAuthors(project) {
  const count = new Map();
  for (const shot of (project && project.storyboard) || []) {
    const a = shot && shot.footageAssetId && project.assets ? project.assets[shot.footageAssetId] : null;
    const src = a && (a.stock || (typeof a.source === 'object' ? a.source : null));
    const k = src && str(src.author);
    if (k) count.set(k, (count.get(k) || 0) + 1);
  }
  return [...count.entries()].sort((x, y) => y[1] - x[1]).map(([k]) => k);
}

/** 已配素材的搜索结果 id（批量配素材时同一条不给两个镜头用） */
export function usedFootageIds(project, { exceptShotId } = {}) {
  const out = [];
  for (const shot of (project && project.storyboard) || []) {
    if (!shot || shot.id === exceptShotId) continue;
    const a = shot.footageAssetId && project.assets ? project.assets[shot.footageAssetId] : null;
    const src = a && (a.stock || (typeof a.source === 'object' ? a.source : null));
    if (src && src.resultId) out.push(String(src.resultId));
  }
  return out;
}

/**
 * 从搜索结果挑最合适的一条。preferAuthors：已用摄影师（同摄影师加分）。excludeIds 为已经用过/换掉的结果 id。
 * 同分时保留原排序（搜索引擎的相关度）。
 * @returns {object|null}
 */
export function pickFootage(results, { aspect, duration, excludeIds, preferAuthors } = {}) {
  const ex = new Set((Array.isArray(excludeIds) ? excludeIds : []).filter(Boolean).map(String));
  const authors = new Set((Array.isArray(preferAuthors) ? preferAuthors : []).map(authorKey).filter(Boolean));
  let best = null;
  let bestScore = -Infinity;
  (Array.isArray(results) ? results : []).forEach((r, i) => {
    if (!r || ex.has(String(r.id)) || (r.downloadUrl && ex.has(String(r.downloadUrl)))) return;
    // 同一摄影师的素材色调/机位更统一，整片观感更像一次拍摄
    const same = authors.size && authors.has(authorKey(r.author || (r.user && r.user.name))) ? SAME_AUTHOR_BONUS : 0;
    const sc = scoreFootage(r, { aspect, duration }) + same - i * 0.05;
    if (sc > bestScore) { best = r; bestScore = sc; }
  });
  return best && Number.isFinite(bestScore) ? best : null;
}

/**
 * 从多个清晰度里挑「低清预览版」：长边最接近 target（默认 1280），且不低于 640。
 * variants: [{url,width,height}]
 */
export function pickVariant(variants, target = 1280) {
  const list = (Array.isArray(variants) ? variants : []).filter((v) => v && v.url && Number(v.width) > 0 && Number(v.height) > 0);
  if (!list.length) return null;
  const long = (v) => Math.max(Number(v.width), Number(v.height));
  const ok = list.filter((v) => long(v) >= 640);
  const pool = ok.length ? ok : list;
  return pool.slice().sort((a, b) => Math.abs(long(a) - target) - Math.abs(long(b) - target) || long(a) - long(b))[0];
}

/** 卡片上的署名：「Pexels / 作者」。v3 资产 source 为字符串 'stock'，详情在 asset.stock；兼容旧版对象 source 和契约 C3 的 source.provider。 */
const CREDIT_LABELS = {
  pexels: 'Pexels', pixabay: 'Pixabay', commons: 'Wikimedia Commons', mixkit: 'Mixkit',
  openverse: 'Openverse', archive: '互联网档案馆', nasa: 'NASA',
};
export function footageCredit(asset) {
  if (asset && str(asset.credit)) return str(asset.credit).slice(0, 80);
  const src = (asset && (asset.stock || (typeof asset.source === 'object' ? asset.source : null))) || {};
  const platform = str(src.platform || src.provider);
  const label = CREDIT_LABELS[platform.toLowerCase()] || platform || '网络';
  const author = str(src.author).replace(/\s+/g, ' ').slice(0, 40);
  return author ? `${label} / ${author}` : label;
}

// ---------- 用 AI 生成英文关键词（可选） ----------

/** 让大模型生成英文素材搜索词的请求（交给 ai:run / runAI）。 */
export function buildFootageQueryRequest(shot, { brief } = {}) {
  const s = shot || {};
  const lines = [
    ['标题', s.title], ['主体', s.subject], ['动作', s.action], ['场景', s.location], ['光线', s.lighting], ['景别', s.shotSize], ['运镜', s.movement],
    ['项目风格', brief && brief.style],
  ].filter(([, v]) => str(v)).map(([k, v]) => `${k}：${str(v)}`);
  return {
    task: 'footage-queries',
    system: 'You write search queries for free stock video sites (Pexels/Pixabay). Reply with JSON only: {"queries":["..."]}. 3 queries, English, 2-5 words each, concrete visual nouns + action, most specific first, real live-action footage (no animation, no illustration).',
    prompt: lines.join('\n'),
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['queries'],
      properties: { queries: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 } },
    },
    timeoutMs: 30000,
  };
}

/** 解析 AI 返回：接受 {queries:[]} / 数组 / 换行文本 */
export function parseFootageQueries(data) {
  let v = data;
  if (typeof v === 'string') {
    const t = v.trim();
    try { v = JSON.parse(t.replace(/^```(?:json)?|```$/g, '').trim()); } catch { v = t.split(/\r?\n|;/); }
  }
  const list = Array.isArray(v) ? v : v && Array.isArray(v.queries) ? v.queries : [];
  const out = [];
  for (const q of list) {
    const c = typeof q === 'string' && !CJK.test(q) ? cleanEnQuery(q) : '';
    if (c && !out.includes(c)) out.push(c);
  }
  return out.slice(0, 3);
}

/**
 * 英文搜索词：先试 AI（run 为可选的 async (request)=>data，通常封装 ai:run），失败/无 AI 时回退本地词表。
 * AI 给的词放最前，再补本地词，最多 3 条。
 * @returns {Promise<{queries:string[], via:'ai'|'local'}>}
 */
export async function buildFootageQueriesLLM(shot, { brief, run, timeoutMs = 20000 } = {}) {
  const local = () => buildFootageQueries(shot, { brief });
  if (typeof run !== 'function') return { queries: local(), via: 'local' };
  try {
    let timer = null;
    const data = await Promise.race([
      run(buildFootageQueryRequest(shot, { brief })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
    const extra = parseFootageQueries(data);
    if (!extra.length) return { queries: local(), via: 'local' };
    return { queries: buildFootageQueries(shot, { brief, extra }), via: 'ai' };
  } catch {
    return { queries: local(), via: 'local' };
  }
}

/** 自动配实拍视频用的搜索源顺序（web.cjs 的默认源另含只有图片/音乐的 Openverse；B站/YouTube 不参与自动配素材） */
// 填了 Key 的图库先搜（画质最稳），免 Key 来源兜底
export const FREE_STOCK_SOURCES = Object.freeze(['commons', 'nasa', 'archive']);
export const DEFAULT_STOCK_SOURCES = Object.freeze(['pexels', 'pixabay', ...FREE_STOCK_SOURCES]);
export const AUTO_FOOTAGE_FORBIDDEN = Object.freeze(['bilibili', 'youtube']);

/** 按设置得到自动配素材用的源（有 key 的商用图库在前，Commons 兜底；永不含 B站/YouTube） */
export function autoFootageSources(settings = {}) {
  const s = settings || {};
  return DEFAULT_STOCK_SOURCES.filter((id) => (id === 'pexels' ? !!s.hasPexelsKey : id === 'pixabay' ? !!s.hasPixabayKey : true));
}

/**
 * 分镜画面来源优先级（PLAN-v3 §7）：用户素材 > AI 视频 > 实拍 > previz。
 * @returns {{kind:'local'|'ai'|'stock'|'previz'|null, assetId:string|null}}
 */
export function shotMediaPick(shot, assets = {}) {
  const ok = (id) => !!(id && assets && assets[id]);
  if (!shot) return { kind: null, assetId: null };
  if (ok(shot.assetId)) return { kind: 'local', assetId: shot.assetId };
  if (ok(shot.aiVideoAssetId)) return { kind: 'ai', assetId: shot.aiVideoAssetId };
  if (ok(shot.footageAssetId)) return { kind: 'stock', assetId: shot.footageAssetId };
  if (ok(shot.previzAssetId)) return { kind: 'previz', assetId: shot.previzAssetId };
  return { kind: null, assetId: null };
}