// 技法卡检索与套用。纯函数。
//
// 检索：中文两字切分 + 关键词同义扩展打分，标题 > 标签 > 摘要 > 适用场景 > 步骤。
// 不依赖分词库，离线可用；结果按分数稳定排序。

const FIELD_WEIGHTS = { title: 8, tags: 5, summary: 3, whenToUse: 2, steps: 1 };

// 同组词互相扩展：搜「过渡」也能找到标题写「转场」的卡
const SYNONYMS = [
  ['转场', '过渡', '切换', '衔接'],
  ['调色', '色调', '颜色', '色彩', '滤镜', '风格'],
  ['运镜', '镜头运动', '推拉', '摇镜', '移镜', '跟拍'],
  ['节奏', '卡点', '踩点', '剪辑节奏', '快剪'],
  ['光线', '布光', '打光', '灯光', '用光'],
  ['构图', '取景', '画面布局'],
  ['特效', '视效', '效果'],
  ['声音', '音效', '配乐', '音乐', '收音'],
  ['台词', '对白', '口播', '采访'],
  ['产品', '商品', '带货', '开箱'],
  ['叙事', '故事', '剧情', '结构'],
  ['暖色', '暖调', '温暖'],
  ['冷色', '冷调'],
  ['电影感', '电影质感', '大片感', '青橙'],
  ['逆光', '背光', '轮廓光'],
  ['手持', '晃动', '呼吸感'],
  ['慢动作', '慢放', '升格'],
  ['延时', '缩时', '延时摄影'],
  ['特写', '细节', '近景'],
  ['黑场', '淡入淡出', '淡出'],
  ['甩镜', '甩切', '快速摇'],
  ['夜景', '夜晚', '夜拍'],
  ['美食', '食物', '吃播'],
  ['vlog', '日常', '生活'],
];

const STOP_GRAMS = new Set(['一个', '怎么', '如何', '什么', '可以', '这个', '那个', '一下', '我想', '想要', '需要', '视频', '镜头', '拍摄', '的镜', '的画', '技法', '技巧', '方法']);

function grams(text) {
  const out = new Set();
  const s = String(text || '').toLowerCase();
  for (const word of s.match(/[a-z0-9]+/g) || []) if (word.length >= 2 || /\d/.test(word)) out.add(word);
  for (const run of s.match(/[一-鿿]+/g) || []) {
    if (run.length === 1) { out.add(run); continue; }
    for (let i = 0; i < run.length - 1; i += 1) out.add(run.slice(i, i + 2));
  }
  return out;
}

function queryTerms(query) {
  const q = String(query || '').toLowerCase().trim();
  const terms = new Map(); // term -> weight
  const add = (t, w) => { if (t && (!terms.has(t) || terms.get(t) < w)) terms.set(t, w); };
  for (const g of grams(q)) if (!STOP_GRAMS.has(g)) add(g, 1);
  // 单个汉字的查询（如「光」）也保留
  if (!terms.size && q) for (const ch of q.replace(/\s+/g, '')) add(ch, 1);
  for (const group of SYNONYMS) {
    if (!group.some((w) => q.includes(w))) continue;
    for (const word of group) {
      if (q.includes(word)) continue;
      for (const g of grams(word)) if (!STOP_GRAMS.has(g)) add(g, 0.5);
    }
  }
  return { q, terms };
}

function fieldText(t, key) {
  const v = t[key];
  if (Array.isArray(v)) return v.join(' ');
  return typeof v === 'string' ? v : '';
}

function scoreTechnique(t, { q, terms }) {
  let score = 0;
  for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
    const text = fieldText(t, field).toLowerCase();
    if (!text) continue;
    const g = grams(text);
    for (const [term, w] of terms) {
      if (term.length === 1 ? text.includes(term) : g.has(term)) score += weight * w;
    }
    if (q.length >= 2 && text.includes(q)) score += field === 'title' ? 20 : weight * 2;
  }
  if (q && String(t.category || '').toLowerCase() === q) score += 10;
  return score;
}

/**
 * @param {object[]} all 技法卡（内置 + 用户拆片得到的）
 * @param {string} query 自由文本；为空时按原顺序返回（仍按分类过滤）
 * @param {{category?: string, limit?: number}} [options] category 为空或 'all' 表示不过滤
 */
export function searchTechniques(all, query, { category, limit = 30 } = {}) {
  const list = (Array.isArray(all) ? all : []).filter((t) => t && typeof t === 'object');
  const filtered = category && category !== 'all' ? list.filter((t) => t.category === category) : list;
  const max = Number.isInteger(limit) && limit > 0 ? limit : 30;
  const parsed = queryTerms(query);
  if (!parsed.q) return filtered.slice(0, max);
  return filtered
    .map((t, i) => ({ t, i, score: scoreTechnique(t, parsed) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, max)
    .map((x) => x.t);
}

/** 技法卡可套用的操作；目标统一改为「所选镜头」。没有 apply 时返回空数组。 */
export function techniqueToOps(technique) {
  const ops = technique && technique.apply && Array.isArray(technique.apply.ops) ? technique.apply.ops : [];
  return ops
    .filter((op) => op && typeof op === 'object' && typeof op.type === 'string')
    .map((op) => ({ ...JSON.parse(JSON.stringify(op)), target: { mode: 'selected', indices: [], ids: [] } }));
}
