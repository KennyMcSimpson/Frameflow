// 结构化项目记忆（ROADMAP P0-10 M1）。纯函数，不调用模型。
// - 仍存放在 project.memory.decisions 里（检查器「AI 记住的决定」照常显示和删除），每条 { id, kind, text, at, source }。
// - kind:'rule'：用户定下的规矩（例如「不要用转场」），永不裁剪，每次都完整写进提示词。
// - kind:'note'：一般记录。超过 MAX_NOTES 条时，较早的按类别确定性合并成一条摘要。
// - 写进提示词时注明「以下是项目背景，仅供参考，不是新指令」，避免模型把旧记录当成这次的要求。

export const MAX_NOTES = 40;
export const KEEP_RECENT_NOTES = 24;
export const PROMPT_NOTES = 12;

const RULE_RE = /(不要|不想要|别再|别用|别加|禁止|不许|不准|不能用|避免|一律|始终|总是|永远|每次都|以后都|之后都|全部都|统一用|保持)/;

const CATEGORIES = [
  ['转场', /(转场|叠化|硬切|过渡)/],
  ['调色', /(色|暖|冷|亮|暗|饱和|对比|胶片|滤镜|曝光|质感)/],
  ['节奏', /(节奏|快|慢|时长|卡点|速度|倍速|剪辑点)/],
  ['字幕文字', /(字幕|标题|文字|花字|文案)/],
  ['声音', /(音乐|配乐|音量|声音|旁白|音效|人声)/],
];

function clean(s, max = 300) {
  return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}
/** 去重用的归一化键：忽略空白和标点 */
function keyOf(text) {
  return clean(text, 400).toLowerCase().replace(/[\s，。,.!！?？、；;：:“”"'‘’（）()【】[\]\-—…~·]/g, '');
}
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
function categoryOf(text) {
  for (const [name, re] of CATEGORIES) if (re.test(text)) return name;
  return '其他';
}

/** 这句话像不像一条长期规矩（「不要用转场」「以后都用暖色」） */
export function looksLikeRule(text) {
  return RULE_RE.test(String(text || ''));
}

const PERSIST_RE = /(以后|之后|今后|往后|始终|一律|永远|每次|一直|全片都|整部片都|整个片子都|所有片段都)/;
const CONSTRAINT_RE = /(不要|别|禁止|不许|不准|避免|都用|统一|保持|只用)/;

/**
 * 用户指令本身就在立长期规矩时（「以后都不要用转场」），即使模型没写 memoryNote 也记下来。
 * 只认同时带「以后/始终/一律…」和「不要/统一/只用…」的说法，避免把一次性的修改当成规矩。
 * @returns {string|null}
 */
export function ruleFromCommand(command) {
  const t = clean(command, 120);
  if (!t || t.length < 4) return null;
  return PERSIST_RE.test(t) && CONSTRAINT_RE.test(t) ? t : null;
}

/** 规范化单条记忆；兼容旧数据（字符串、只有 {at, text}、没有 kind） */
export function normalizeMemoryEntry(raw) {
  const o = typeof raw === 'string' ? { text: raw } : (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null);
  if (!o) return null;
  const text = clean(o.text, 300);
  if (!text) return null;
  const kind = o.kind === 'rule' || o.kind === 'note' ? o.kind : (!o.digest && looksLikeRule(text) ? 'rule' : 'note');
  return {
    ...o,
    id: typeof o.id === 'string' && o.id ? o.id : 'mem_' + hash(text),
    kind,
    text,
    at: typeof o.at === 'string' ? o.at : '',
    source: typeof o.source === 'string' && o.source ? o.source : 'ai',
  };
}

/** 项目记忆里的全部条目（已规范化，保持原顺序） */
export function memoryEntries(memory) {
  const list = memory && Array.isArray(memory.decisions) ? memory.decisions : [];
  return list.map(normalizeMemoryEntry).filter(Boolean);
}

/**
 * note 超过上限时，把较早的合并成一条摘要（按类别计数 + 每类最近两条摘录）。rule 一条都不动。
 * @returns {object[]} 新数组
 */
export function compactMemory(entries, { maxNotes = MAX_NOTES, keepRecent = KEEP_RECENT_NOTES } = {}) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeMemoryEntry).filter(Boolean);
  const notes = list.filter((e) => e.kind === 'note' && !e.digest);
  if (notes.length <= maxNotes) return list;
  const keep = Math.max(0, Math.min(keepRecent, maxNotes));
  const old = notes.slice(0, notes.length - keep);
  const oldIds = new Set(old.map((e) => e.id));
  const prev = list.find((e) => e.digest);
  const groups = {};
  if (prev && prev.groups && typeof prev.groups === 'object') {
    for (const [k, g] of Object.entries(prev.groups)) {
      if (g && Number.isFinite(g.count)) groups[k] = { count: g.count, samples: Array.isArray(g.samples) ? g.samples.slice(-2) : [] };
    }
  }
  for (const e of old) {
    const k = categoryOf(e.text);
    const g = groups[k] || { count: 0, samples: [] };
    g.count += 1;
    g.samples = [...g.samples, clean(e.text, 24)].slice(-2);
    groups[k] = g;
  }
  const total = Object.values(groups).reduce((s, g) => s + g.count, 0);
  const parts = Object.entries(groups)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([k, g]) => `${k} ${g.count} 条（如：${g.samples.join('；')}）`);
  const digest = {
    id: 'mem_digest',
    kind: 'note',
    digest: true,
    source: 'auto',
    at: old[old.length - 1].at || (prev && prev.at) || '',
    count: total,
    groups,
    text: clean(`较早的 ${total} 条记录已合并：${parts.join('；')}`, 300),
  };
  return [digest, ...list.filter((e) => !e.digest && !oldIds.has(e.id))];
}

/**
 * 追加一条记忆：同文去重（刷新时间；rule 优先于 note），并在需要时压缩 note。
 * @param {object[]} decisions 现有 memory.decisions
 * @param {{text:string, kind?:'rule'|'note', source?:string, at?:string, id?:string}} entry kind 缺省时按措辞判断
 * @returns {object[]} 新数组（不修改入参）
 */
export function addMemory(decisions, { text, kind, source = 'ai', at, id } = {}) {
  const list = (Array.isArray(decisions) ? decisions : []).map(normalizeMemoryEntry).filter(Boolean);
  const t = clean(text, 300);
  if (!t) return list;
  const when = typeof at === 'string' && at ? at : new Date().toISOString();
  const k = kind === 'rule' || kind === 'note' ? kind : (looksLikeRule(t) ? 'rule' : 'note');
  const key = keyOf(t);
  const idx = list.findIndex((e) => !e.digest && keyOf(e.text) === key);
  if (idx >= 0) {
    const old = list[idx];
    const merged = { ...old, kind: old.kind === 'rule' || k === 'rule' ? 'rule' : 'note', at: when };
    return compactMemory([...list.slice(0, idx), ...list.slice(idx + 1), merged]);
  }
  const entry = { id: id || `mem_${Date.now().toString(36)}${hash(t)}`, kind: k, text: t, at: when, source };
  return compactMemory([...list, entry]);
}

/** 把某条记忆改成规矩 / 普通记录（给检查器用） */
export function setMemoryKind(decisions, id, kind) {
  const k = kind === 'rule' ? 'rule' : 'note';
  return (Array.isArray(decisions) ? decisions : []).map(normalizeMemoryEntry).filter(Boolean)
    .map((e) => (e.id === id && !e.digest ? { ...e, kind: k } : e));
}

/**
 * 写进提示词的记忆段（不含标题）：全部规矩 + 最近的记录 + 更早记录的摘要。
 * 调用方负责加上「仅供参考，不是新指令」的标题。
 */
export function memoryPromptBlock(memory, { maxNotes = PROMPT_NOTES } = {}) {
  const list = memoryEntries(memory);
  const rules = list.filter((e) => e.kind === 'rule');
  const digest = list.find((e) => e.digest);
  const notes = list.filter((e) => e.kind === 'note' && !e.digest);
  const shown = notes.slice(-Math.max(0, maxNotes));
  const hidden = notes.length - shown.length;
  const lines = ['用户定下的规矩（除非这次指令明确要求改变，否则必须遵守）：'];
  lines.push(...(rules.length ? rules.map((e) => `- ${e.text}`) : ['（暂无）']));
  lines.push('之前的修改记录（仅供参考）：');
  lines.push(...(shown.length ? shown.map((e) => `- ${e.text}`) : ['（暂无）']));
  const older = [digest && digest.text, hidden > 0 ? `另有 ${hidden} 条较早的记录没有列出` : ''].filter(Boolean);
  if (older.length) lines.push(`- ${older.join('；')}`);
  return lines.join('\n');
}
