// 本地中文指令解析：没有 AI 时把白话变成 Op[]。纯函数，不修改入参。
//
// 流程：
//   1. 引号内容换成占位符，避免里面的逗号、「和」被当成分句；
//   2. 目标短语（第N段、前N段、这段、所有……）换成占位符，相邻目标合并；
//   3. 按标点和连接词拆成子句，子句没写目标时沿用前一子句的目标；
//   4. 每个子句依次跑规则，匹配到的文字被抹掉；抹完还剩非虚词 → 记入 unknown。
//
// 有 unknown 时调用方不应用（或转交 AI），所以这里宁可报不懂，也不猜着改时间线。
// 占位符使用私有区字符，因此不会与用户文字、数字规则冲突。
import {
  ASPECTS, COLOR_LABELS, FX_LABELS, LOOK_LABELS, MOTION_LABELS, TRANSITION_LABELS, LIMITS,
} from './model.js';
import { beatTimes, clipDuration, indexAtTime, layoutVideo } from './timeline.js';
import { applyOps, resolveTargets } from './ops.js';
import { beatGridDurations } from './pacing.js';

// ---------- 占位符 ----------

const QUOTE_BASE = 0xe000;
const TOKEN_BASE = 0xe400;
const QUOTE_CLASS = '[\\uE000-\\uE3FF]';
const isQuoteChar = (ch) => { const c = ch.charCodeAt(0); return c >= QUOTE_BASE && c < TOKEN_BASE; };
const isTokenChar = (ch) => { const c = ch.charCodeAt(0); return c >= TOKEN_BASE && c < 0xe800; };

// ---------- 词表 ----------

const CN = '零〇一二两三四五六七八九十百';
const NUM = `(?:\\d+|[${CN}]+)`;
const SECONDS = `(?:\\d+(?:\\.\\d+)?|[${CN}]+|半)`;
const UNIT = '(?:个镜头|个片段|个段落|镜头|片段|段落|段|镜|个|幕)';
const DEG = '(?:一点点|一点儿?|点儿?|一些|些许|些|稍微|稍稍|稍|略微|略|有点儿?|有些|微微|轻微|很多|很|非常|大幅度?|大大|特别|超级|极其|极|十分|相当|强烈|明显|猛|更加|更|好多|不够)';
const VERB = '(?:调整?到?成?得?|变得|变成|变|弄得?|搞得?|改成|改为|改得?|偏|提|压|温|要|做得?|显得|让它|得)';
const REMOVE = '(?:去掉|去除|删除|删掉|移除|取消|关掉|关闭|不要|清除|清掉|拿掉|消除|抹掉)';
const SET_VERB = '(?:改成|改为|换成|写成|设为|设置为|变成|改写成)';
const TO_VERB = '(?:改成|改为|变成|设为|设成|调成|调到|调整到|缩短到|延长到|拉长到|剪到|裁到|只留|保留|留|只要|改到|缩到)';
const MOVE_VERB = '(?:移动到|移到|挪到|放到|调到|搬到|拖到|换到|排到)';
const SPLIT_VERB = '(?:分割|切开|切断|剪开|切一刀|剪一刀|分成两段|拆成两段|切成两段|拆开|一分为二|断开)';
const UP = '提亮|加强|增强|提高|提升|拉高|调高|加大|增大|增加|调大|拉满|加点|加些|多一点|多点|高一点|高点|强一点|强点|大一点|大点|高些|强些|大些|更高|更强|更大|高|强|大|加|提';
const DOWN = '压暗|降低|减弱|减小|减少|调低|调小|拉低|压低|压一压|少一点|少点|低一点|低点|弱一点|弱点|小一点|小点|低些|弱些|小些|更低|更弱|更小|压|低|弱|小|减|降';
const DOWN_RE = new RegExp(`^(?:${DOWN})$`);
const STRONG_RE = /很|非常|大幅|大大|特别|超级|极|十分|相当|强烈|明显|猛|好多|拉满/;
const WEAK_RE = /一点|点|稍|略|有点|有些|些|微/;

// 只由这些虚词组成的文字不算「没听懂」
const FILLER_RE = new RegExp([
  '谢谢', '好的', '就行', '即可', '帮我', '帮忙', '麻烦', '我想', '我要', '想要', '希望', '需要', '能不能', '能否', '可不可以', '可以吗', '可以', '一下子?',
  '调整', '调成', '调为', '调到', '改成', '改为', '变成', '设置为', '设置', '设为', '加上', '加个', '添加', '来个', '来点', '使用', '换成', '这个', '那个', '这边', '整个',
  '画面', '视频', '镜头', '片段', '效果', '感觉', '风格', '特效', '转场', '过渡', '之间', '中间', '一点儿?', '一些', '样子', '速度', '播放', '稍微', '略微', '有点', '有些', '非常', '最好',
  '把', '将', '给', '让', '使', '帮', '请', '想', '吧', '呢', '啊', '呀', '哦', '嘛', '了', '的', '得', '地', '都', '全', '也', '就', '要', '更', '还', '又', '先',
  '调', '改', '变', '弄', '搞', '做', '加', '用', '换', '段', '点', '些', '里', '中', '上', '下', '放', '稍', '略', '很', '好', '再',
].join('|'), 'g');

const QUESTION_RE = /为什么|为啥|什么|怎么样|怎么办|是不是|哪里|哪个|多少/;
const NEGATION_RE = /不要|不用|无需|别/;
const SAME_RE = /^(?:也是|也一样|也这样|也同样|同样|一样|同上|也要)$/;
const DELETE_ONLY_RE = /^(?:删除|删掉|删了?|删去|去掉|去除|移除|剪掉|拿掉|砍掉|扔掉|不要了?)$/;

// ---------- 小工具 ----------

function parseCount(raw) {
  if (/^\d+$/.test(raw)) return Number(raw);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0;
  let current = 0;
  for (const ch of raw) {
    if (ch in digits) current = digits[ch];
    else if (ch === '十') { total += (current || 1) * 10; current = 0; } else if (ch === '百') { total += (current || 1) * 100; current = 0; } else return NaN;
  }
  return total + current;
}

function parseSeconds(raw) {
  if (raw === '半') return 0.5;
  const n = /^\d/.test(raw) ? Number(raw) : parseCount(raw);
  return Number.isFinite(n) ? n : NaN;
}

function degreeOf(str) {
  if (STRONG_RE.test(str)) return 0.4;
  if (WEAK_RE.test(str)) return 0.15;
  return 0.25;
}

function signed(v) {
  return v > 0 ? `+${v}` : String(v);
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function indexTarget(indices) {
  return { mode: 'index', indices, ids: [] };
}

function indexLabel(indices) {
  const sorted = [...indices].sort((a, b) => a - b);
  if (sorted.length === 1) return `第${sorted[0]}镜`;
  const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
  return contiguous ? `第${sorted[0]}–${sorted[sorted.length - 1]}镜` : `第${sorted.join('、')}镜`;
}

// ---------- 引号与目标短语 ----------

const QUOTE_RE = /「([^」]*)」|『([^』]*)』|“([^”]*)”|"([^"]*)"|‘([^’]*)’|《([^》]*)》|'([^']*)'/g;
const UNQUOTED_SET_RE = new RegExp(`(字幕|标题|文字|文案)(内容|文字|文案)?(${SET_VERB})([^，,。；;！!？?\\n\\uE000-\\uE3FF]+)`, 'g');
const UNQUOTED_ADD_RE = /((?:加上|加|添加|放上|打上)[一个]*(?:大)?(?:标题|字幕))[:：\s]*([^，,。；;！!？?\n-]+)/g;
const NOT_TEXT_RE = /^(?:放|移|挪)?(?:到|在)?(?:最)?(?:上面|上方|顶部|上边|下面|下方|底部|下边|中间|中央|居中|正中)/;

function maskQuotes(text) {
  const quotes = [];
  const stash = (value) => {
    quotes.push(value);
    return String.fromCharCode(QUOTE_BASE + quotes.length - 1);
  };
  let s = text.replace(/[-]/g, '');
  s = s.replace(QUOTE_RE, (...m) => stash(m.slice(1, 8).find((v) => v !== undefined) ?? ''));
  // 没加引号的「字幕改成 XXX」：内容取到标点或下一个连接词为止，防止内容里的「和」被拆开
  const cut = (raw) => {
    const m = raw.match(/然后|并且|接着|同时|再把|另外/);
    return m ? [raw.slice(0, m.index), raw.slice(m.index)] : [raw, ''];
  };
  s = s.replace(UNQUOTED_SET_RE, (all, noun, sub, verb, body) => {
    if (NOT_TEXT_RE.test(body)) return all;
    const [content, rest] = cut(body);
    return `${noun}${verb}${stash(content.trim())}${rest}`;
  });
  s = s.replace(UNQUOTED_ADD_RE, (all, head, body) => {
    const [content, rest] = cut(body);
    const clean = content.replace(/(?:吧|呢|啊|呀|一下)+$/, '').trim();
    if (!clean || NOT_TEXT_RE.test(clean)) return all;
    return `${head}${stash(clean)}${rest}`;
  });
  return { masked: s, quotes };
}

function normalize(s) {
  return s
    .replace(/[０-９]/g, (d) => String(d.charCodeAt(0) - 0xff10))
    .replace(/[Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/：/g, ':').replace(/％/g, '%').replace(/．/g, '.').replace(/～/g, '~')
    .replace(/[ \t　]+/g, '')
    .toLowerCase();
}

function outOfRange(raw, n) {
  return { kind: 'error', raw, message: `${raw}不存在（当前共 ${n} 镜）` };
}

function indexToken(raw, numbers, n) {
  if (numbers.some((v) => !Number.isInteger(v) || v < 1)) return { kind: 'error', raw, message: `「${raw}」的编号不正确` };
  if (n !== null && numbers.some((v) => v > n)) return outOfRange(raw, n);
  return { kind: 'index', raw, indices: [...new Set(numbers)].sort((a, b) => a - b) };
}

function needsCount(raw, n, build) {
  if (n === null) return { kind: 'error', raw, message: '当前没有项目，无法定位镜头' };
  if (n === 0) return { kind: 'error', raw, message: '时间线上还没有镜头' };
  return build(n);
}

function rangeList(from, to) {
  const out = [];
  for (let i = from; i <= to; i += 1) out.push(i);
  return out;
}

const NOT_SECONDS = `(?!的?(?:\\d|[${CN}半]+秒))`;
const TOKEN_PATTERNS = [
  { re: new RegExp(`第(${NUM})${UNIT}?(?:到|至|-|~|—|–)第?(${NUM})${UNIT}?`, 'g'),
    make: (m, n) => {
      const a = parseCount(m[1]); const b = parseCount(m[2]);
      if (!(a >= 1) || !(b >= 1)) return indexToken(m[0], [NaN], n);
      if (a > 200 || b > 200) return n === null ? indexToken(m[0], [NaN], n) : outOfRange(m[0], n);
      return indexToken(m[0], rangeList(Math.min(a, b), Math.max(a, b)), n);
    } },
  { re: new RegExp(`第${NUM}(?:(?:、|,|，|和|与|及|跟)第?${NUM})+${UNIT}`, 'g'),
    make: (m, n) => indexToken(m[0], (m[0].match(new RegExp(NUM, 'g')) || []).map(parseCount), n) },
  { re: new RegExp(`倒数第(${NUM})${UNIT}`, 'g'),
    make: (m, n) => needsCount(m[0], n, (c) => indexToken(m[0], [c - parseCount(m[1]) + 1], c)) },
  { re: new RegExp(`第(${NUM})${UNIT}`, 'g'), make: (m, n) => indexToken(m[0], [parseCount(m[1])], n) },
  { re: new RegExp(`最后(?:的|那)?(${NUM})${UNIT}`, 'g'),
    make: (m, n) => needsCount(m[0], n, (c) => indexToken(m[0], rangeList(Math.max(1, c - parseCount(m[1]) + 1), c), c)) },
  { re: /最后(?:的|那)?(?:个镜头|个片段|镜头|片段|段|镜|个)/g,
    make: (m, n) => needsCount(m[0], n, (c) => indexToken(m[0], [c], c)) },
  { re: new RegExp(`(?:前面?|头)(${NUM})${UNIT}`, 'g'),
    make: (m, n) => needsCount(m[0], n, (c) => indexToken(m[0], rangeList(1, Math.min(c, parseCount(m[1]))), c)) },
  { re: new RegExp(`后面?(${NUM})${UNIT}`, 'g'),
    make: (m, n) => needsCount(m[0], n, (c) => indexToken(m[0], rangeList(Math.max(1, c - parseCount(m[1]) + 1), c), c)) },
  { re: new RegExp(`(?:开头|片头|开场|首段|首镜)${NOT_SECONDS}(?:的?(?:那段|那个镜头|镜头|片段|部分))?`, 'g'),
    make: (m, n) => needsCount(m[0], n, () => indexToken(m[0], [1], n)) },
  { re: new RegExp(`(?:结尾|片尾|末尾|收尾)${NOT_SECONDS}(?:的?(?:那段|那个镜头|镜头|片段|部分))?`, 'g'),
    make: (m, n) => needsCount(m[0], n, (c) => indexToken(m[0], [c], c)) },
  { re: /这几(?:段|个镜头|个片段|个|镜)|这些(?:段落?|镜头|片段)?|这[一个]?(?:段|镜头|片段|镜)|当前(?:的)?(?:镜头|片段|段)|选中的?(?:镜头|片段|段)?|所选的?(?:镜头|片段|段)?|选择的(?:镜头|片段|段)/g,
    make: (m) => ({ kind: 'selected', raw: m[0] }) },
  { re: /所有的?(?:镜头|片段|段落?)?|全部的?(?:镜头|片段|段落?)?|每[一个]?(?:段|镜头|片段|镜)|整[个条部]?(?:视频|片子|时间线|影片)|全片|整片|整体|全段/g,
    make: (m) => ({ kind: 'all', raw: m[0] }) },
];

function extractTokens(masked, n) {
  const tokens = [];
  const stash = (token) => {
    tokens.push(token);
    return String.fromCharCode(TOKEN_BASE + tokens.length - 1);
  };
  let s = masked;
  for (const { re, make } of TOKEN_PATTERNS) s = s.replace(re, (...a) => stash(make(a, n)));

  // 相邻的编号目标合并：「第2段和第4段」「第1段、第3段」
  const adjacent = /([-])(?:[、,，和与及跟]|以及|还有)?([-])/;
  for (let guard = 0; guard < 64; guard += 1) {
    let merged = false;
    s = s.replace(adjacent, (all, a, b) => {
      const ta = tokens[a.charCodeAt(0) - TOKEN_BASE];
      const tb = tokens[b.charCodeAt(0) - TOKEN_BASE];
      if (ta.kind !== 'index' || tb.kind !== 'index') return all;
      merged = true;
      return stash({ kind: 'index', raw: `${ta.raw}和${tb.raw}`, indices: [...new Set([...ta.indices, ...tb.indices])].sort((x, y) => x - y) });
    });
    if (!merged) break;
  }
  return { str: s, tokens };
}

// ---------- 拆句 ----------

const SPLIT_RE = /([。！!？?\n]+)|[，,；;、]+|然后|接着|随后|并且|而且|同时|另外|此外|顺便|还有|以及|(?<!合)并(?!排)|(?<![饱柔温调缓暖平])和(?![谐缓])|再(?=把|将|给|对|让|[-])/g;

function isFillerOnly(s) {
  return !s.replace(FILLER_RE, '').replace(new RegExp(DEG, 'g'), '').trim();
}

function hasPlaceholder(s) {
  for (const ch of s) if (isTokenChar(ch) || isQuoteChar(ch)) return true;
  return false;
}

function splitClauses(str) {
  const segments = [];
  let last = 0;
  let hard = false;
  for (const m of str.matchAll(SPLIT_RE)) {
    segments.push({ text: str.slice(last, m.index), hard });
    hard = !!m[1];
    last = m.index + m[0].length;
  }
  segments.push({ text: str.slice(last), hard });

  // 只有程度词/虚词的片段（「稍微再亮一点」里的「稍微」）并入下一句
  const merged = [];
  let carry = '';
  let carryHard = false;
  for (const seg of segments) {
    const text = carry + seg.text;
    if (!text) { carryHard = carryHard || seg.hard; continue; }
    if (!hasPlaceholder(text) && isFillerOnly(text)) {
      carry = text;
      carryHard = carryHard || seg.hard;
      continue;
    }
    merged.push({ text, hard: carryHard || seg.hard });
    carry = '';
    carryHard = false;
  }
  if (carry && !merged.length) merged.push({ text: carry, hard: false });
  return merged;
}

// ---------- 目标决议 ----------

function buildEnv(options) {
  const project = options.project || null;
  const clips = (project && project.tracks && project.tracks.video) || [];
  const known = new Set(clips.map((c) => c.id));
  const rawSelected = Array.isArray(options.selectedClipIds) ? options.selectedClipIds : [];
  const selected = project ? rawSelected.filter((id) => known.has(id)) : rawSelected;
  const range = options.range && Number.isFinite(options.range.start) && Number.isFinite(options.range.end) ? options.range : null;
  const playhead = Number.isFinite(options.playhead) ? options.playhead : null;
  return {
    project,
    clips,
    n: project ? clips.length : null,
    selected,
    range,
    playhead,
    layout: project ? layoutVideo(project) : [],
    ctx: { selectedClipIds: selected, range, playhead: playhead === null ? 0 : playhead },
  };
}

function tokensToDescriptor(tokens) {
  const bad = tokens.find((t) => t.kind === 'error');
  if (bad) return bad;
  if (tokens.some((t) => t.kind === 'all')) return { kind: 'all' };
  if (tokens.some((t) => t.kind === 'selected')) return { kind: 'selected' };
  return { kind: 'index', indices: [...new Set(tokens.flatMap((t) => t.indices))].sort((a, b) => a - b) };
}

const NEED_TARGET = '请先选中镜头，或说明是第几段';

function resolveDescriptor(env, desc) {
  switch (desc.kind) {
    case 'error': return { error: desc.message };
    case 'index': return { target: indexTarget(desc.indices), label: indexLabel(desc.indices) };
    case 'all': return { target: { mode: 'all', indices: [], ids: [] }, label: '全部镜头' };
    default: break;
  }
  // 「这段」：选中 → 框选 → 播放头所在镜头
  if (env.selected.length) return { target: { mode: 'selected', indices: [], ids: [] }, label: '所选镜头' };
  if (env.range) return { target: { mode: 'range', indices: [], ids: [] }, label: '框选范围内的镜头' };
  if (env.playhead !== null && env.n) {
    const i = indexAtTime(env.layout, env.playhead) + 1;
    return { target: indexTarget([i]), label: `第${i}镜` };
  }
  return { error: NEED_TARGET };
}

function defaultTarget(env, strict) {
  if (env.selected.length) return { target: { mode: 'selected', indices: [], ids: [] }, label: '所选镜头' };
  if (env.range) return { target: { mode: 'range', indices: [], ids: [] }, label: '框选范围内的镜头' };
  if (strict) return { error: NEED_TARGET };
  return { target: { mode: 'all', indices: [], ids: [] }, label: '全部镜头' };
}

function indicesOf(env, target) {
  if (!env.project) return null;
  try {
    return resolveTargets(env.project, target, env.ctx, env.layout);
  } catch {
    return null;
  }
}

// ---------- 子句上下文 ----------

class Clause {
  constructor(env, state, tokens, text, raw) {
    this.env = env;
    this.state = state;
    this.tokens = tokens;
    this.s = text;
    this.raw = raw;
    this.original = text;
    this.items = []; // { pos, ops, text }
    this.errors = [];
    this.deleted = false;
    this.levelDir = null;
    this.targetOverride = null;
  }

  /** 决定本子句的目标：显式 > 沿用上一句 > 默认（selected → range → 全部/报错） */
  pickTarget(strict) {
    if (this.targetOverride) return resolveDescriptor(this.env, this.targetOverride);
    if (this.tokens.length) return resolveDescriptor(this.env, tokensToDescriptor(this.tokens));
    if (this.state.lastTarget) return resolveDescriptor(this.env, this.state.lastTarget);
    return defaultTarget(this.env, strict);
  }

  /** 发出需要目标的操作。build(target, indices, label) 可返回 Op、Op[] 或 null。 */
  emit(pos, strict, text, build) {
    const picked = this.pickTarget(strict);
    if (picked.error) {
      this.errors.push(`「${this.raw}」：${picked.error}`);
      return;
    }
    const ops = build(picked.target, picked.label);
    if (!ops) return;
    const list = Array.isArray(ops) ? ops : [ops];
    if (!list.length) return;
    this.items.push({ pos, ops: list, text: `${picked.label}：${text}` });
  }

  emitGlobal(pos, text, ops) {
    this.items.push({ pos, ops: Array.isArray(ops) ? ops : [ops], text });
  }

  fail(message) {
    this.errors.push(`「${this.raw}」：${message}`);
  }

  quote(ch) {
    return this.state.quotes[ch.charCodeAt(0) - QUOTE_BASE];
  }

  apply(re, fn) {
    this.s = this.s.replace(re, (...a) => {
      const pos = a[a.length - 2];
      const m = a.slice(0, a.length - 2);
      return fn(m, pos) === false ? m[0] : ' '.repeat(m[0].length);
    });
  }

  residual() {
    return this.s.replace(FILLER_RE, '').replace(new RegExp(DEG, 'g'), '').replace(/\s+/g, '');
  }

  compact() {
    return this.s.replace(/\s+/g, '');
  }
}

// ---------- 规则 ----------

function colorOp(target, patch, relative = true) {
  return { type: 'setColor', target, color: patch, relative };
}

function removalRe(noun) {
  return new RegExp(`${REMOVE}(?:掉)?的?(?:${noun})(?:特效|效果|感)?|(?:${noun})(?:特效|效果)?(?:都|全)?(?:给)?(?:${REMOVE}|删了|去了)(?:掉)?`, 'g');
}

function fxValue(deg) {
  return deg === 0.4 ? 0.7 : deg === 0.15 ? 0.2 : 0.4;
}

function lookStrength(deg) {
  return deg === 0.4 ? 1 : deg === 0.15 ? 0.5 : 0.8;
}

function motionIntensity(str) {
  if (/缓慢|慢慢|缓缓|轻轻|轻微/.test(str)) return 0.35;
  if (/快速|猛/.test(str)) return 0.8;
  const d = degreeOf(str);
  return d === 0.4 ? 0.8 : d === 0.15 ? 0.3 : 0.5;
}

const FX_NOUNS = [
  { key: 'grain', words: '胶片颗粒|颗粒感?|噪点' },
  { key: 'glow', words: '辉光|柔光|光晕|发光' },
  { key: 'sharpen', words: '锐化|更清晰|清晰一?点|清晰度' },
  { key: 'letterbox', words: '电影黑边|黑边|宽银幕|遮幅' },
  { key: 'chromatic', words: '色差|rgb分离' },
  { key: 'vhs', words: 'vhs|录像带|老录像' },
  { key: 'flash', words: '闪白特效|闪白效果' },
  { key: 'blur', words: '模糊|虚化' },
];

const LOOK_WORDS = [
  ['黑色电影|noir', 'noir'],
  ['黑白|单色', 'bw'],
  ['暖调胶片|暖色胶片|柯达', 'film-warm'],
  ['冷调胶片|冷色胶片|富士', 'film-cool'],
  ['胶片', 'film-warm'],
  ['复古|老电影|怀旧|年代感', 'vintage'],
  ['青橙|电影感|电影风格?|电影质感|电影色调|电影调色|大片感|大片', 'cinematic'],
  ['赛博朋克|赛博|霓虹', 'cyberpunk'],
  ['黄金时刻|黄金时段|夕阳|日落|落日|金色阳光', 'golden-hour'],
  ['冷夜|夜色|蓝调', 'cool-night'],
  ['日系清新|日系|小清新|清新|粉彩', 'soft-pastel'],
  ['高级感|情绪感|暗调|低调', 'moody'],
  ['鲜艳|艳丽|浓郁', 'vivid'],
  ['高反差|强反差', 'high-contrast'],
].map(([words, look]) => ({
  look,
  re: new RegExp(`(?:调成|改成|变成|换成|做成|套用|加上|来点|用|加|${DEG}|${VERB})*(?:${words})(?:风格?|感|效果|色调|调色|滤镜|调)?${DEG}*`, 'g'),
}));

const MOTION_WORDS = [
  ['推近|推进|推镜头?|向前推|往前推|慢推', 'push-in'],
  ['拉远|拉开|拉镜头?|后拉|向后拉|往后拉', 'pull-out'],
  ['向左摇|往左摇|左摇|摇向左', 'pan-left'],
  ['向右摇|往右摇|右摇|摇向右', 'pan-right'],
  ['向上摇|往上摇|上摇|摇向上|仰摇', 'tilt-up'],
  ['向下摇|往下摇|下摇|摇向下|俯摇', 'tilt-down'],
  ['手持感|手持|抖动|晃动|摇晃|呼吸感', 'shake'],
  ['冲击变焦|变焦冲击|急推变焦', 'zoom-punch'],
  ['缓慢漂移|漂移|漂浮', 'drift'],
].map(([words, preset]) => ({
  preset,
  re: new RegExp(`((?:慢慢|缓慢|缓缓|轻轻|轻微|快速|猛地?|加上?|来点?|用|${DEG})*)(?:地)?(?:镜头)?(?:${words})(?:镜头|运镜|的?效果|感)?(${DEG}*)`, 'g'),
}));

const TRANSITION_WORDS = [
  ['叠化|溶解|交叉淡化|淡入淡出|渐变过渡|淡入', 'crossfade'],
  ['黑场|黑屏过渡|淡入黑', 'dip-black'],
  ['白场', 'dip-white'],
  ['闪白|闪光转场', 'flash'],
  ['向左推|往左推|左推|向左滑|左滑|推移|推入|推(?=转场|过渡)', 'slide-left'],
  ['向右推|往右推|右推|向右滑|右滑', 'slide-right'],
  ['向上推|往上推|上推|向上滑|上滑', 'slide-up'],
  ['向下推|往下推|下推|向下滑|下滑', 'slide-down'],
  ['向右擦除|往右擦除|右擦除', 'wipe-right'],
  ['向左擦除|往左擦除|左擦除|擦除', 'wipe-left'],
  ['模糊(?=转场|过渡)', 'blur'],
  ['甩镜|甩入|甩切|whip', 'whip-pan'],
  ['旋转', 'spin'],
  ['放大(?=转场|过渡|穿越)|放大穿越', 'zoom-in'],
  ['缩小(?=转场|过渡|穿越)|缩小穿越', 'zoom-out'],
  ['硬切|直切', 'cut'],
].map(([words, type]) => ({
  type,
  re: new RegExp(`(?:(${SECONDS})秒(半)?的?)?(?:${words})(?:转场|过渡|穿越|切换|效果)?(?:(${SECONDS})秒(半)?(?:的|长)?)?`, 'g'),
}));

const CONTEXT_TRANSITIONS = { 模糊: 'blur', 放大: 'zoom-in', 缩小: 'zoom-out', 旋转: 'spin', 闪白: 'flash', 推: 'slide-left' };

const ASPECT_ALIASES = [
  ['竖屏幕?|竖版|竖构图|竖向|9:16|9比16', '9:16'],
  ['横屏幕?|横版|横构图|横向|16:9|16比9', '16:9'],
  ['方形|方屏|正方形|1:1|1比1', '1:1'],
  ['4:3|4比3', '4:3'],
  ['21:9|21比9|超宽屏', '21:9'],
].map(([words, aspect]) => ({
  aspect,
  re: new RegExp(`(?:画幅|比例|画面比例|尺寸|画面)?(?:改成|改为|换成|调成|变成|设为|改到|切到|切成|改|换|成)?(?:${words})(?:画幅|比例|尺寸|模式|视频)?`, 'g'),
}));

function emitTransition(c, type, pos, seconds, extraSeconds) {
  const dflt = type === 'flash' || type === 'whip-pan' ? 0.3 : 0.5;
  let duration = dflt;
  if (seconds) {
    const v = parseSeconds(seconds) + (extraSeconds ? 0.5 : 0);
    if (!(v > 0)) { c.fail('转场时长不正确'); return; }
    duration = Math.min(LIMITS.maxTransition, Math.max(LIMITS.minTransition, v));
  }
  const between = /之间|中间/.test(c.original);
  // 「第2段和第3段之间」的转场属于后一镜的入场
  let label = null;
  if (between && !c.targetOverride && c.tokens.length) {
    const desc = tokensToDescriptor(c.tokens);
    if (desc.kind === 'index' && desc.indices.length >= 2) {
      c.targetOverride = { kind: 'index', indices: desc.indices.slice(1) };
      label = `第${desc.indices.slice(0, -1).join('、')}镜和第${desc.indices[desc.indices.length - 1]}镜之间`;
    }
  }
  const body = type === 'cut' ? '转场改为硬切' : `转场改为${TRANSITION_LABELS[type]} ${duration} 秒`;
  c.emit(pos, false, body, (target) => ({ type: 'setTransition', target, transition: type === 'cut' ? { type } : { type, duration } }));
  if (label) {
    c.targetOverride = null;
    const last = c.items[c.items.length - 1];
    if (last) last.text = `${label}：${body}`;
  }
}

function textClips(env, predicate) {
  const list = (env.project && env.project.tracks && env.project.tracks.text) || [];
  return list.filter(predicate);
}

function musicClips(env) {
  const list = (env.project && env.project.tracks && env.project.tracks.audio) || [];
  const music = list.filter((a) => a.role === 'music');
  return music.length ? music : list;
}

/** 文字层开始时间：说了「开头/第N段」就跟着那一镜，否则交给 ops 用播放头 */
function textStartFromTokens(c) {
  if (!c.tokens.length) return {};
  const desc = tokensToDescriptor(c.tokens);
  if (desc.kind !== 'index') return {};
  const item = c.env.layout[desc.indices[0] - 1];
  return item ? { start: round2(item.start) } : {};
}

function runQuoteRules(c) {
  const Q = `(${QUOTE_CLASS})`;
  // 字幕
  c.apply(new RegExp(`(?:加上?个?|添加|配上?|写上?)?(?:字幕|台词)(?:内容|文字|文案)?(?:${SET_VERB}|写|是|用|为|:)?${Q}`, 'g'), (m, pos) => {
    const text = c.quote(m[1]);
    c.emit(pos, true, text ? `字幕改为「${text}」` : '去掉字幕', (target) => ({ type: 'setCaption', target, caption: { text } }));
  });
  c.apply(new RegExp(`${Q}(?:作为|当作?|做)字幕`, 'g'), (m, pos) => {
    const text = c.quote(m[1]);
    c.emit(pos, true, `字幕改为「${text}」`, (target) => ({ type: 'setCaption', target, caption: { text } }));
  });
  // 标题 / 文字层
  c.apply(new RegExp(`(?:加上?一?个?|添加|放上?|打上?|来个?|写个?|写上?)?(大)?(标题|文字|文案|花字)(?:内容)?(${SET_VERB}|写|是|用|为|:)?${Q}`, 'g'), (m, pos) => {
    const text = c.quote(m[4]);
    if (!text.trim()) { c.fail('标题内容是空的'); return; }
    const isChange = m[3] && /改|换|变|设/.test(m[3]);
    if (isChange) {
      const existing = textClips(c.env, (t) => t.preset === 'title' || t.preset === 'big-bold')[0] || textClips(c.env, () => true)[0];
      if (existing) {
        c.emitGlobal(pos, `标题改为「${text}」`, { type: 'updateText', target: { mode: 'none', indices: [], ids: [] }, textId: existing.id, text: { text } });
        return;
      }
    }
    const preset = m[1] ? 'big-bold' : m[2] === '花字' ? 'neon' : 'title';
    c.emitGlobal(pos, `添加标题「${text}」`, {
      type: 'addText',
      target: { mode: 'none', indices: [], ids: [] },
      text: { text, preset, ...textStartFromTokens(c) },
    });
  });
  // 字幕位置
  const POSITIONS = [
    ['上面|上方|顶部|上边|顶上|最上面', 'top', '顶部'],
    ['中间|中央|居中|正中|画面中间', 'center', '中间'],
    ['下面|下方|底部|下边|底下|最下面', 'bottom', '底部'],
  ];
  for (const [words, position, label] of POSITIONS) {
    c.apply(new RegExp(`字幕(?:位置)?(?:放|移|挪|改|调|摆)?(?:到|在|成)?(?:${words})(?:去|一点)?|(?:把)?字幕(?:放|移|挪)(?:到|在)(?:画面)?(?:${words})`, 'g'), (m, pos) => {
      c.emit(pos, false, `字幕放到${label}`, (target) => ({ type: 'setCaption', target, caption: { position } }));
    });
  }
}

function removeTextClips(c, pos, predicate, label) {
  const list = textClips(c.env, predicate);
  if (!list.length) { c.fail(`时间线上没有${label}`); return; }
  c.emitGlobal(pos, `去掉${label}`, list.map((t) => ({ type: 'removeText', target: { mode: 'none', indices: [], ids: [] }, textId: t.id })));
}

function runRemovalRules(c) {
  // 先处理「声音/静音」，否则「去掉声音」会被当成删除镜头
  c.apply(/取消静音|解除静音|恢复声音|恢复音量|打开声音|开声音|声音打开/g, (m, pos) => {
    c.emit(pos, false, '取消静音', (target) => ({ type: 'setVolume', target, mute: false }));
  });
  c.apply(new RegExp(`${REMOVE}(?:掉)?的?声音|声音(?:给)?(?:关掉|去掉|关了|去了)|静音|消音`, 'g'), (m, pos) => {
    if (/音乐|配乐|bgm/.test(c.original)) return false;
    c.emit(pos, false, '静音', (target) => ({ type: 'setVolume', target, mute: true }));
    return undefined;
  });
  // 锁定：「不要动」也算在内，必须早于否定检查
  c.apply(/解锁|取消锁定|解除锁定|解开/g, (m, pos) => {
    c.emit(pos, true, '解锁', (target) => ({ type: 'unlock', target }));
  });
  c.apply(/锁定|锁住|锁上|锁起来|不要动|别动/g, (m, pos) => {
    c.emit(pos, true, '锁定', (target) => {
      const indices = indicesOf(c.env, target);
      if (!indices) return { type: 'lock', target };
      const open = indices.filter((i) => !c.env.clips[i].locked);
      if (!open.length) return null;
      return { type: 'lock', target: open.length === indices.length ? target : indexTarget(open.map((i) => i + 1)) };
    });
    return undefined;
  });
  c.apply(new RegExp(`(?:${REMOVE}|剪掉|切掉|裁掉)(?:掉)?的?(?:前面?|开头的?|头部)(${SECONDS})秒(半)?`, 'g'), (m, pos) => {
    const seconds = parseSeconds(m[1]) + (m[2] ? 0.5 : 0);
    c.emit(pos, true, `剪掉开头 ${seconds} 秒`, (target) => {
      const indices = indicesOf(c.env, target);
      if (!indices || !indices.length) return { type: 'trim', target, in: seconds, relative: true };
      return indices.map((i) => ({ type: 'trim', target: indexTarget([i + 1]), in: round2(seconds * (c.env.clips[i].speed || 1)), relative: true }));
    });
  });
  c.apply(new RegExp(`(?:${REMOVE}|剪掉|切掉|裁掉)(?:掉)?的?(?:后面?|结尾的?|最后|尾部)(${SECONDS})秒(半)?`, 'g'), (m, pos) => {
    const seconds = parseSeconds(m[1]) + (m[2] ? 0.5 : 0);
    c.emit(pos, true, `剪掉结尾 ${seconds} 秒`, (target) => {
      const indices = indicesOf(c.env, target);
      if (!indices || !indices.length) return { type: 'trim', target, out: -seconds, relative: true };
      return indices.map((i) => ({ type: 'trim', target: indexTarget([i + 1]), out: -round2(seconds * (c.env.clips[i].speed || 1)), relative: true }));
    });
  });

  c.apply(removalRe('字幕|台词'), (m, pos) => {
    c.emit(pos, false, '去掉字幕', (target) => ({ type: 'setCaption', target, caption: { text: '' } }));
  });
  c.apply(removalRe('标题'), (m, pos) => removeTextClips(c, pos, (t) => t.preset === 'title' || t.preset === 'big-bold', '标题'));
  c.apply(removalRe('文字|花字'), (m, pos) => removeTextClips(c, pos, () => true, '文字'));
  c.apply(removalRe('背景音乐|音乐|配乐|bgm'), (m, pos) => {
    const list = musicClips(c.env);
    if (!list.length) { c.fail('时间线上没有音乐'); return; }
    c.emitGlobal(pos, '去掉音乐', list.map((a) => ({ type: 'removeAudio', target: { mode: 'none', indices: [], ids: [] }, audioId: a.id })));
  });
  c.apply(removalRe('转场|过渡'), (m, pos) => {
    c.emit(pos, false, '去掉转场（改为硬切）', (target) => ({ type: 'setTransition', target, transition: { type: 'cut' } }));
  });
  c.apply(removalRe('运镜|镜头运动|动效'), (m, pos) => {
    c.emit(pos, false, '去掉运镜', (target) => ({ type: 'setMotion', target, preset: 'none' }));
  });
  c.apply(removalRe('暗角'), (m, pos) => {
    c.emit(pos, false, '去掉暗角', (target) => colorOp(target, { vignette: 0 }, false));
  });
  for (const { key, words } of FX_NOUNS) {
    c.apply(removalRe(words), (m, pos) => {
      c.emit(pos, false, `去掉${FX_LABELS[key]}`, (target) => ({ type: 'setFx', target, fx: { [key]: 0 }, relative: false }));
    });
  }
  c.apply(new RegExp(`${REMOVE}(?:掉)?的?(?:所有的?|全部的?)?(?:特效|效果)|(?:特效|效果)(?:都|全)?(?:${REMOVE}|删了)`, 'g'), (m, pos) => {
    c.emit(pos, false, '去掉所有特效', (target) => ({
      type: 'setFx', target, fx: { blur: 0, grain: 0, glow: 0, sharpen: 0, letterbox: 0, chromatic: 0, vhs: 0, flash: 0 }, relative: false,
    }));
  });
  const resetColor = (m, pos) => {
    c.emit(pos, false, '还原调色', (target) => [
      { type: 'setLook', target, look: 'none' },
      colorOp(target, { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0 }, false),
    ]);
  };
  c.apply(removalRe('滤镜|调色|色调'), resetColor);
  c.apply(/(?:恢复|还原|重置)(?:成|为|到)?(?:原色|原片|原来的?颜色|调色|颜色)|恢复原样/g, resetColor);
}

const SNAP_TO_BEATS_OP = { type: 'snapCutsToBeats', target: { mode: 'none', indices: [], ids: [] } };

/**
 * 「卡点」能不能用音乐的真实节拍（素材的 beats，导入音乐时自动分析）：
 * 'snap' 可以对齐；'aligned' 有节拍但没有剪辑点能再挪；'partial' 有节拍但用户只指定了部分镜头（对齐会动全片，不替用户扩大范围）；
 * 'none' 没有节拍数据，退回固定网格。
 */
function realBeatSnap(c) {
  const project = c.env.project;
  if (!project) return 'none';
  let beats = [];
  try { beats = beatTimes(project); } catch { beats = []; }
  if (beats.length < 4) return 'none';
  const picked = c.pickTarget(false);
  if (picked.error || !picked.target || picked.target.mode !== 'all') return 'partial';
  let ok = false;
  try { ok = applyOps(project, [{ ...SNAP_TO_BEATS_OP }], c.env.ctx).ok === true; } catch { ok = false; }
  return ok ? 'snap' : 'aligned';
}

function runProjectRules(c) {
  c.apply(new RegExp(`(?:统一|协调)(?:一下)?的?(?:色调|颜色|色彩|调色|风格)${DEG}*|(?:色调|颜色|色彩|调色)(?:要|保持|都)?(?:统一|一致|协调)${DEG}*|(?:色调|颜色|色彩)(?:看起来)?(?:不一致|不统一)`, 'g'), (m, pos) => {
    const d = degreeOf(m[0]);
    const strength = d === 0.15 ? 0.4 : d === 0.4 ? 0.9 : 0.6;
    c.emit(pos, false, `统一色调（强度 ${strength}）`, (target) => ({ type: 'harmonize', target, strength }));
  });
  const pacing = (name, label) => (m, pos) => {
    c.emit(pos, false, `节奏调整为${label}`, (target) => ({ type: 'applyPacing', target, pacing: name }));
  };
  c.apply(new RegExp(`(?:加快|提快|加紧)${DEG}*(?:节奏)|快节奏|节奏(?:再|更|调|变|要|得|都)*${DEG}*(?:快|紧凑|紧张|明快)${DEG}*`, 'g'), pacing('fast', '紧凑'));
  c.apply(new RegExp(`(?:放慢|放缓|减缓)${DEG}*(?:节奏)|慢节奏|节奏(?:再|更|调|变|要|得|都)*${DEG}*(?:慢|舒缓|缓和|放松)${DEG}*`, 'g'), pacing('slow', '舒缓'));
  c.apply(/节奏(?:调|变|改)?(?:成|到|为)?(?:适中|正常|中等)/g, pacing('medium', '适中'));
  c.apply(/卡点|踩点|卡节拍|卡音乐/g, (m, pos) => {
    // 音乐有节拍数据（导入音乐时会自动分析）且没有指定镜头：把全片的剪辑点对齐到真实节拍
    const real = realBeatSnap(c);
    if (real === 'snap') {
      c.emitGlobal(pos, '卡点：把剪辑点对齐到音乐的实际节拍', { ...SNAP_TO_BEATS_OP });
      return undefined;
    }
    if (real === 'aligned') {
      c.fail('剪辑点已经在音乐节拍上了，或者素材长度不够再挪动，这次没有改动');
      return undefined;
    }
    const text = real === 'partial'
      ? '卡点：按 0.5 秒一拍重排镜头时长（只改指定的镜头，没有对齐音乐节拍；不选镜头时说「卡点」会把全片剪辑点对齐到音乐节拍）'
      : '卡点：按 120 BPM 节拍网格重排镜头时长（未分析音乐实际节拍）';
    c.emit(pos, false, text, (target) => {
      const indices = indicesOf(c.env, target);
      if (!indices || !indices.length) return { type: 'applyPacing', target, pacing: 'fast' };
      const durations = beatGridDurations(indices.map((i) => c.env.clips[i]), c.env.project.assets, 0.5);
      return { type: 'applyPacing', target, durations };
    });
  });
  for (const { aspect, re } of ASPECT_ALIASES) {
    c.apply(re, (m, pos) => {
      c.emitGlobal(pos, `画幅改为${ASPECTS[aspect].label}`, { type: 'setProject', target: { mode: 'none', indices: [], ids: [] }, settings: { aspect } });
    });
  }
}

function runTransformRules(c) {
  c.apply(/(?:放大|缩放)(?:到|至)?(\d+(?:\.\d+)?)(%|倍)/g, (m, pos) => {
    const scale = m[2] === '%' ? Number(m[1]) / 100 : Number(m[1]);
    c.emit(pos, false, `画面缩放到 ${round2(scale)} 倍`, (target) => ({ type: 'setTransform', target, transform: { scale: round2(scale) } }));
  });
  c.apply(/(?:水平)?(?:翻转|镜像)(?:一下)?/g, (m, pos) => {
    c.emit(pos, false, '水平翻转', (target) => ({ type: 'setTransform', target, transform: { flipH: true } }));
  });
  c.apply(/(?:旋转|转)(-?\d+)度/g, (m, pos) => {
    c.emit(pos, false, `旋转 ${m[1]}°`, (target) => ({ type: 'setTransform', target, transform: { rotation: Number(m[1]) } }));
  });
  c.apply(/(?:还原|恢复)(?:大小|缩放|构图)/g, (m, pos) => {
    c.emit(pos, false, '还原画面大小', (target) => ({ type: 'setTransform', target, transform: { scale: 1, x: 0, y: 0, rotation: 0 } }));
  });
}

function runMotionRules(c) {
  c.apply(/固定镜头|固定机位|静止镜头/g, (m, pos) => {
    c.emit(pos, false, '去掉运镜（固定机位）', (target) => ({ type: 'setMotion', target, preset: 'none' }));
  });
  for (const { preset, re } of MOTION_WORDS) {
    c.apply(re, (m, pos) => {
      let intensity = motionIntensity(`${m[1]}${m[2]}`);
      if (preset === 'shake' && /手持|呼吸/.test(m[0]) && !STRONG_RE.test(m[0])) intensity = 0.3;
      c.emit(pos, false, `运镜改为${MOTION_LABELS[preset]}（强度 ${intensity}）`, (target) => ({ type: 'setMotion', target, preset, intensity }));
    });
  }
}

function runAudioFadeRules(c) {
  c.apply(/(?:声音|音频|音量)(?:渐入|淡入)/g, (m, pos) => {
    c.emit(pos, false, '声音淡入 1 秒', (target) => ({ type: 'setVolume', target, audioFadeIn: 1 }));
  });
  c.apply(/(?:声音|音频|音量)(?:渐出|淡出)/g, (m, pos) => {
    c.emit(pos, false, '声音淡出 1 秒', (target) => ({ type: 'setVolume', target, audioFadeOut: 1 }));
  });
}

function runTransitionRules(c) {
  // 显式「转场改成模糊/放大…」
  c.apply(/(?:转场|过渡)(?:效果)?(?:用|改成|改为|换成|设为|为|是)?(模糊|放大|缩小|旋转|闪白|推)/g, (m, pos) => {
    emitTransition(c, CONTEXT_TRANSITIONS[m[1]], pos);
  });
  c.apply(/(闪白)(?:特效|效果)/g, (m, pos) => {
    c.emit(pos, false, `${FX_LABELS.flash}特效`, (target) => ({ type: 'setFx', target, fx: { flash: 0.5 }, relative: false }));
  });
  for (const { type, re } of TRANSITION_WORDS) {
    c.apply(re, (m, pos) => {
      if (m[1]) emitTransition(c, type, pos, m[1], m[2]);
      else emitTransition(c, type, pos, m[3], m[4]);
    });
  }
  // 只说「加个转场」：默认叠化
  if (!c.items.some((it) => it.ops.some((op) => op.type === 'setTransition'))) {
    c.apply(new RegExp(`(?:加上?个?|来个?|添加)(?:(${SECONDS})秒(半)?的?)?(?:转场|过渡)`, 'g'), (m, pos) => {
      emitTransition(c, 'crossfade', pos, m[1], m[2]);
    });
  }
}

function runFxRules(c) {
  for (const { key, words } of FX_NOUNS) {
    c.apply(new RegExp(`(?:减少|降低|减弱|减轻)${DEG}*的?(?:${words})|(?:${words})(?:少|弱|淡|轻)${DEG}*`, 'g'), (m, pos) => {
      c.emit(pos, false, `${FX_LABELS[key]}减弱`, (target) => ({ type: 'setFx', target, fx: { [key]: -0.2 }, relative: true }));
    });
    c.apply(new RegExp(`((?:加上?|添加|来点?|用|多|${DEG}|${VERB}|个)*)(?:${words})(?:特效|效果|感)?(${DEG}*)`, 'g'), (m, pos) => {
      const value = fxValue(degreeOf(`${m[1]}${m[2]}`));
      c.emit(pos, false, `${FX_LABELS[key]} ${value}`, (target) => ({ type: 'setFx', target, fx: { [key]: value }, relative: false }));
    });
  }
  c.apply(new RegExp(`(?:减少|降低|减弱|减轻)${DEG}*的?暗角|暗角(?:少|弱|淡|轻)${DEG}*`, 'g'), (m, pos) => {
    c.emit(pos, false, `${COLOR_LABELS.vignette}减弱`, (target) => colorOp(target, { vignette: -0.2 }));
  });
  c.apply(new RegExp(`((?:加上?|添加|来点?|用|多|${DEG}|${VERB}|个)*)暗角(?:效果)?(${DEG}*(?:重|强|深)?${DEG}*)`, 'g'), (m, pos) => {
    const value = fxValue(degreeOf(`${m[1]}${m[2]}`));
    c.emit(pos, false, `${COLOR_LABELS.vignette} ${value}`, (target) => colorOp(target, { vignette: value }, false));
  });
}

function runLookRules(c) {
  c.apply(/去色|褪色/g, (m, pos) => {
    c.emit(pos, false, '去色（饱和度设为 -1）', (target) => colorOp(target, { saturation: -1 }, false));
  });
  for (const { look, re } of LOOK_WORDS) {
    c.apply(re, (m, pos) => {
      const strength = lookStrength(degreeOf(m[0].replace(/高级感|情绪感/, '')));
      c.emit(pos, false, `调色风格改为${LOOK_LABELS[look]}（强度 ${strength}）`, (target) => ({ type: 'setLook', target, look, lookStrength: strength }));
    });
  }
}

function runLevel(c, noun, handler) {
  const pre = new RegExp(`${DEG}*(${UP}|${DOWN})${DEG}*的?(?:${noun})${DEG}*`, 'g');
  const post = new RegExp(`(?:${noun})(?:再|更|要|调|拉|变|得|也|都)*${DEG}*(${UP}|${DOWN})?${DEG}*`, 'g');
  const run = (m, pos) => {
    let dir;
    if (m[1]) {
      dir = DOWN_RE.test(m[1]) ? -1 : 1;
      c.levelDir = dir;
    } else {
      dir = c.state.lastLevelDir || 1;
    }
    handler(dir, degreeOf(m[0]), pos);
  };
  c.apply(pre, run);
  c.apply(post, run);
}

function runLevelRules(c) {
  const emitColor = (key, sign, label) => (dir, deg, pos) => {
    const delta = round2(dir * sign * deg);
    c.emit(pos, false, `${label || COLOR_LABELS[key]} ${signed(delta)}`, (target) => colorOp(target, { [key]: delta }));
  };
  runLevel(c, '对比度?|反差', emitColor('contrast', 1));
  runLevel(c, '饱和度?|色彩浓度', emitColor('saturation', 1));
  runLevel(c, '亮度', emitColor('exposure', 1));
  runLevel(c, '曝光度?', emitColor('exposure', 1));
  runLevel(c, '色温', emitColor('temperature', 1));
  runLevel(c, '高光', emitColor('highlights', 1));
  runLevel(c, '阴影|暗部', emitColor('shadows', 1));
  c.apply(/过曝/g, (m, pos) => {
    c.emit(pos, false, '曝光 -0.25', (target) => colorOp(target, { exposure: -0.25 }));
  });
  c.apply(/欠曝/g, (m, pos) => {
    c.emit(pos, false, '曝光 +0.25', (target) => colorOp(target, { exposure: 0.25 }));
  });
}

function adjectiveRe(word) {
  return new RegExp(`((?:${DEG}|${VERB})*)(太|过于|过分|过(?=[亮暗暖冷]))?((?:${DEG}|${VERB})*)${word}(?:色调|色系|调子?|色)?((?:${DEG}|了|的)*)`, 'g');
}

const ADJECTIVES = [
  { re: adjectiveRe('暖'), key: 'temperature', sign: 1, label: '调暖' },
  { re: adjectiveRe('(?:冷(?![静淡门]))'), key: 'temperature', sign: -1, label: '调冷' },
  { re: adjectiveRe('(?:(?<![漂闪透月天])亮(?![度部片]))'), key: 'exposure', sign: 1, label: '提亮' },
  { re: adjectiveRe('(?:暗(?![角部调场处]))'), key: 'exposure', sign: -1, label: '压暗' },
];

function runAdjectiveRules(c) {
  for (const { re, key, sign, label } of ADJECTIVES) {
    c.apply(re, (m, pos) => {
      // 「太暗了」是抱怨而不是要求：往反方向调
      const inverse = !!m[2];
      const degree = degreeOf(`${m[1]}${m[3]}${m[4]}`);
      const delta = round2((inverse ? -sign : sign) * degree);
      const text = inverse ? `${COLOR_LABELS[key]} ${signed(delta)}（原来${m[2]}${sign > 0 ? label.slice(1) : label.slice(1)}）` : `${label}（${COLOR_LABELS[key]} ${signed(delta)}）`;
      c.emit(pos, false, text, (target) => colorOp(target, { [key]: delta }));
    });
  }
}

function runAudioRules(c) {
  // 音乐轨
  const MUSIC = '(?:背景音乐|音乐|配乐|bgm)';
  const eachMusic = (pos, text, makePatch) => {
    const list = musicClips(c.env);
    if (!list.length) { c.fail('时间线上没有音乐'); return; }
    c.emitGlobal(pos, text, list.map((a) => ({ type: 'updateAudio', target: { mode: 'none', indices: [], ids: [] }, audioId: a.id, audio: makePatch(a) })));
  };
  c.apply(new RegExp(`${MUSIC}的?(?:音量|声音)?(?:调到|调成|改成|改为|设为|到|为)?(\\d+(?:\\.\\d+)?)%`, 'g'), (m, pos) => {
    const volume = Number(m[1]) / 100;
    eachMusic(pos, `音乐音量设为 ${m[1]}%`, () => ({ volume }));
  });
  c.apply(new RegExp(`${MUSIC}的?(?:音量|声音)?(?:再|更|调|开|得)*${DEG}*(大|高|响|小|低|轻)(?:声)?${DEG}*`, 'g'), (m, pos) => {
    const delta = (/[小低轻]/.test(m[1]) ? -1 : 1) * degreeOf(m[0]);
    eachMusic(pos, `音乐音量 ${signed(delta)}`, (a) => ({ volume: round2(Math.min(2, Math.max(0, (Number(a.volume) || 0) + delta))) }));
  });
  c.apply(new RegExp(`${MUSIC}(?:给)?(?:静音|关掉)|(?:静音|关掉)${MUSIC}`, 'g'), (m, pos) => {
    eachMusic(pos, '音乐静音', () => ({ volume: 0 }));
  });

  // 主轨音量
  c.apply(/(?:音量|声音)(?:调到|调成|改成|改为|设为|到|为|调)?(\d+(?:\.\d+)?)(%|倍)?/g, (m, pos) => {
    const n = Number(m[1]);
    const volume = m[2] === '%' || (!m[2] && n > 2) ? round2(n / 100) : n;
    c.emit(pos, false, `音量设为 ${Math.round(volume * 100)}%`, (target) => ({ type: 'setVolume', target, volume }));
  });
  c.apply(new RegExp(`(调大|调高|提高|加大|增大|调小|调低|降低|减小)${DEG}*的?(?:音量|声音)${DEG}*`, 'g'), (m, pos) => {
    const delta = round2((/小|低/.test(m[1]) ? -1 : 1) * degreeOf(m[0]));
    c.emit(pos, false, `音量 ${signed(delta)}`, (target) => ({ type: 'setVolume', target, volume: delta, relative: true }));
  });
  c.apply(new RegExp(`(?:音量|声音)(?:再|更|调|开|得)*${DEG}*(大|高|响|小|低|轻)${DEG}*|(大声|小声)${DEG}*`, 'g'), (m, pos) => {
    const word = m[1] || m[2];
    const delta = round2((/[小低轻]/.test(word) ? -1 : 1) * degreeOf(m[0]));
    c.emit(pos, false, `音量 ${signed(delta)}`, (target) => ({ type: 'setVolume', target, volume: delta, relative: true }));
  });
}

function runSpeedRules(c) {
  const speedOp = (speed, label, pos) => c.emit(pos, false, label, (target) => ({ type: 'setSpeed', target, speed }));
  c.apply(new RegExp(`(?:加速|减速|放慢|慢放|变速|速度)?(?:改成|调到|到|为|设为|成)?(\\d+(?:\\.\\d+)?|[${CN}]+)(?:倍速|倍|x)`, 'g'), (m, pos) => {
    const speed = /^\d/.test(m[1]) ? Number(m[1]) : parseCount(m[1]);
    speedOp(speed, `播放速度 ${speed} 倍`, pos);
  });
  c.apply(/半速/g, (m, pos) => speedOp(0.5, '播放速度 0.5 倍', pos));
  c.apply(/恢复原速|恢复正常速度|正常速度|原速/g, (m, pos) => speedOp(1, '恢复原速', pos));
  const degreeSpeed = (str, normal, strong, weak) => {
    if (STRONG_RE.test(str)) return strong;
    if (/稍|略|微/.test(str)) return weak;
    return normal;
  };
  c.apply(new RegExp(`${DEG}*(?:加速|加快|提速|变快|快进|快)(?:一?点儿?|些)?${DEG}*`, 'g'), (m, pos) => {
    const speed = degreeSpeed(m[0], 1.5, 2, 1.25);
    speedOp(speed, `加速到 ${speed} 倍`, pos);
  });
  c.apply(new RegExp(`${DEG}*(?:慢放|慢动作|放慢|减速|变慢|慢)(?:一?点儿?|些)?${DEG}*`, 'g'), (m, pos) => {
    const speed = degreeSpeed(m[0], 0.5, 0.25, 0.75);
    speedOp(speed, `慢放到 ${speed} 倍`, pos);
  });
}

function emitPerClipDuration(c, pos, label, compute) {
  c.emit(pos, true, label, (target) => {
    const indices = indicesOf(c.env, target);
    if (!indices || !indices.length) {
      c.fail('找不到要改时长的镜头');
      return null;
    }
    return indices.map((i) => ({
      type: 'setDuration',
      target: indexTarget([i + 1]),
      duration: round2(Math.max(LIMITS.minClip, compute(clipDuration(c.env.clips[i])))),
    }));
  });
}

function runDurationRules(c) {
  c.apply(new RegExp(`(?:时长|长度|持续)(?:时间)?(?:${TO_VERB}|为|是)?(${SECONDS})秒(半)?钟?|${TO_VERB}(${SECONDS})秒(半)?钟?(?:长)?(?:时长)?`, 'g'), (m, pos) => {
    const raw = m[1] || m[3];
    const half = m[2] || m[4];
    const seconds = parseSeconds(raw) + (half ? 0.5 : 0);
    if (!(seconds > 0)) { c.fail('时长不正确'); return; }
    c.emit(pos, true, `时长改为 ${seconds} 秒`, (target) => ({ type: 'setDuration', target, duration: seconds }));
  });
  c.apply(new RegExp(`${DEG}*(?:缩短|剪短|裁短|短)(?:一?点儿?|些)?${DEG}*`, 'g'), (m, pos) => {
    const d = degreeOf(m[0]);
    const factor = d === 0.4 ? 0.6 : d === 0.15 ? 0.85 : 0.75;
    emitPerClipDuration(c, pos, `时长缩短到 ${Math.round(factor * 100)}%`, (cur) => cur * factor);
  });
  c.apply(new RegExp(`${DEG}*(?:延长|拉长|加长|长)(?:一?点儿?|些)?${DEG}*`, 'g'), (m, pos) => {
    const d = degreeOf(m[0]);
    const factor = d === 0.4 ? 1.6 : d === 0.15 ? 1.15 : 1.3;
    emitPerClipDuration(c, pos, `时长延长到 ${Math.round(factor * 100)}%`, (cur) => cur * factor);
  });
}

function sourceDescriptor(c, tokens) {
  if (tokens.length) return tokensToDescriptor(tokens);
  return c.state.lastTarget || null;
}

function runMoveRules(c) {
  const env = c.env;
  const moveTo = (pos, srcDesc, toIndex, text) => {
    c.targetOverride = srcDesc;
    c.emit(pos, true, text, (target) => ({ type: 'move', target, toIndex }));
    c.targetOverride = null;
  };
  c.apply(new RegExp(`${MOVE_VERB}(最前面?|最开始|第一位|最后面?)`, 'g'), (m, pos) => {
    if (env.n === null) { c.fail('当前没有项目，无法移动镜头'); return; }
    const toFront = /前|开始|第一/.test(m[1]);
    moveTo(pos, sourceDescriptor(c, c.tokens), toFront ? 1 : Math.max(1, env.n), toFront ? '移到最前面' : '移到最后面');
    c.tokens = [];
  });
  c.apply(new RegExp(`${MOVE_VERB}的?(前面|之前|前边|前|后面|之后|后边|后)?`, 'g'), (m, pos) => {
    if (!c.tokens.length) return false;
    const destToken = c.tokens[c.tokens.length - 1];
    const rest = c.tokens.slice(0, -1);
    if (destToken.kind === 'error') { c.fail(destToken.message); return undefined; }
    if (destToken.kind !== 'index' || destToken.indices.length !== 1) { c.fail('要说明移到第几段'); return undefined; }
    const dest = destToken.indices[0];
    const srcDesc = sourceDescriptor(c, rest);
    const picked = srcDesc ? resolveDescriptor(env, srcDesc) : defaultTarget(env, true);
    if (picked.error) { c.fail(picked.error); return undefined; }
    const src = (indicesOf(env, picked.target) || (picked.target.indices || []).map((n) => n - 1)).map((i) => i + 1);
    if (src.includes(dest)) { c.fail('目标位置就是它自己'); return undefined; }
    let toIndex = dest;
    if (m[1]) {
      const others = rangeList(1, env.n ?? dest).filter((n) => !src.includes(n));
      const at = others.indexOf(dest);
      toIndex = /前/.test(m[1]) ? at + 1 : at + 2;
    }
    moveTo(pos, srcDesc || { kind: 'selected' }, toIndex, `移到第 ${toIndex} 位`);
    c.tokens = rest;
    return undefined;
  });
  c.apply(new RegExp(`(?:往|向)?([前后上下])移动?(?:(${NUM})(?:位|格|个位置|个))?|(?:往|向)([前后])(?:挪|调|移动?)(?:(${NUM})(?:位|格|个位置|个))?`, 'g'), (m, pos) => {
    const dir = /[前上]/.test(m[1] || m[3]) ? -1 : 1;
    const steps = (m[2] || m[4]) ? parseCount(m[2] || m[4]) : 1;
    const picked = c.pickTarget(true);
    if (picked.error) { c.fail(picked.error); return; }
    const src = indicesOf(env, picked.target);
    if (!src || !src.length) { c.fail('找不到要移动的镜头'); return; }
    const toIndex = Math.min(env.n, Math.max(1, src[0] + 1 + dir * steps));
    c.emit(pos, true, `移到第 ${toIndex} 位`, (target) => ({ type: 'move', target, toIndex }));
  });
  c.apply(/(?:交换|对调|互换|调换)(?:一下)?(?:位置|顺序)?/g, (m, pos) => {
    const desc = c.tokens.length ? tokensToDescriptor(c.tokens) : null;
    if (!desc || desc.kind !== 'index' || desc.indices.length !== 2) { c.fail('要说明交换哪两段，例如「交换第1段和第3段」'); return; }
    const [a, b] = desc.indices;
    // 无 project 时 stabilizeIndices 不会把第二条转成 ids：先将 a 移到 b 后，原第 b 镜顺移到 b-1
    const swapOps = b === a + 1
      ? [{ type: 'move', target: indexTarget([a]), toIndex: b }]
      : [
        { type: 'move', target: indexTarget([a]), toIndex: b },
        { type: 'move', target: indexTarget([env.project ? b : b - 1]), toIndex: a },
      ];
    c.emitGlobal(pos, `交换第${a}镜和第${b}镜`, swapOps);
  });
}

function runStructureRules(c) {
  const env = c.env;
  const splitAt = (pos, at, label) => {
    if (c.tokens.length || c.state.lastTarget) {
      c.emit(pos, true, label, (target) => ({ type: 'split', target, at: round2(at) }));
    } else {
      c.emitGlobal(pos, label, { type: 'split', target: { mode: 'none', indices: [], ids: [] }, at: round2(at) });
    }
  };
  c.apply(new RegExp(`(?:在|从)?(?:中间|正中|一半)(?:处|的位置|位置|的地方)?(?:把它?)?${SPLIT_VERB}`, 'g'), (m, pos) => {
    const picked = c.pickTarget(true);
    if (picked.error) { c.fail(picked.error); return; }
    const indices = indicesOf(env, picked.target);
    if (!indices || indices.length !== 1) { c.fail('从中间分割一次只能指定一段'); return; }
    const item = env.layout[indices[0]];
    c.emit(pos, true, '从中间分割', (target) => ({ type: 'split', target, at: round2((item.start + item.end) / 2) }));
  });
  c.apply(new RegExp(`(?:在|从)?第?(${SECONDS})秒(半)?(?:处|的位置|位置|的地方|这里)?(?:把它?)?${SPLIT_VERB}`, 'g'), (m, pos) => {
    const local = parseSeconds(m[1]) + (m[2] ? 0.5 : 0);
    let at = local;
    const desc = c.tokens.length ? tokensToDescriptor(c.tokens) : null;
    if (desc && desc.kind === 'index' && desc.indices.length === 1 && env.layout[desc.indices[0] - 1]) {
      at = env.layout[desc.indices[0] - 1].start + local;
    }
    splitAt(pos, at, `在 ${round2(at)} 秒处分割`);
  });
  c.apply(new RegExp(`(?:在|从)?(?:这里|这儿|此处|这个位置|这个地方|播放头|当前位置|当前时间|光标)?(?:处|的位置|位置|的地方)?(?:把它?)?${SPLIT_VERB}`, 'g'), (m, pos) => {
    if (env.playhead === null) { c.fail('不知道播放头在哪里，无法分割'); return; }
    splitAt(pos, env.playhead, `在播放头（${round2(env.playhead)} 秒）分割`);
  });
  c.apply(/复制(?:一份|一个|一段|一下|一遍)?|克隆|重复一[遍次段]|来一[段遍](?=\s|$)/g, (m, pos) => {
    c.emit(pos, true, '复制一份', (target) => ({ type: 'duplicate', target }));
  });
}

function runScaleFallbackRules(c) {
  c.apply(new RegExp(`${DEG}*放大${DEG}*`, 'g'), (m, pos) => {
    const d = degreeOf(m[0]);
    const scale = d === 0.4 ? 1.5 : d === 0.15 ? 1.15 : 1.25;
    c.emit(pos, false, `画面放大到 ${scale} 倍`, (target) => ({ type: 'setTransform', target, transform: { scale } }));
  });
  c.apply(/缩小|恢复大小|还原大小/g, (m, pos) => {
    c.emit(pos, false, '画面缩放还原', (target) => ({ type: 'setTransform', target, transform: { scale: 1 } }));
  });
}

// ---------- 子句处理 ----------

function restore(text, state) {
  let out = '';
  for (const ch of text) {
    if (isQuoteChar(ch)) out += `「${state.quotes[ch.charCodeAt(0) - QUOTE_BASE]}」`;
    else if (isTokenChar(ch)) out += state.tokens[ch.charCodeAt(0) - TOKEN_BASE].raw;
    else out += ch;
  }
  return out;
}

function retarget(op, target) {
  return target && op.target && op.target.mode !== 'none' ? { ...deepCopy(op), target } : deepCopy(op);
}

function deepCopy(o) {
  return JSON.parse(JSON.stringify(o));
}

function processClause(seg, env, state, result) {
  const tokens = [];
  let body = '';
  for (const ch of seg.text) {
    if (isTokenChar(ch)) tokens.push(state.tokens[ch.charCodeAt(0) - TOKEN_BASE]);
    else body += ch;
  }
  const raw = restore(seg.text, state);
  if (seg.hard) state.lastTarget = null;

  const c = new Clause(env, state, tokens, body, raw);
  const pendingBefore = state.pendingTarget;
  if (pendingBefore && tokens.length) result.unknown.push(`「${pendingBefore}」：只指定了镜头，没有说要改什么`);
  state.pendingTarget = null;

  if (QUESTION_RE.test(body)) {
    result.unknown.push(raw);
    return;
  }

  // 「第三段也是」：对新目标重复上一句的操作
  const bare = body.replace(/\s+/g, '');
  if (SAME_RE.test(bare) && tokens.length && state.lastOps.length) {
    const picked = resolveDescriptor(env, tokensToDescriptor(tokens));
    if (picked.error) {
      result.unknown.push(`「${raw}」：${picked.error}`);
      return;
    }
    result.ops.push(...state.lastOps.map((op) => retarget(op, picked.target)));
    result.understood.push(`${picked.label}：和上一句一样`);
    state.lastTarget = tokensToDescriptor(tokens);
    return;
  }

  const onlyDelete = () => DELETE_ONLY_RE.test(c.residualKeepingDelete());
  c.residualKeepingDelete = () => c.s
    .replace(/把|将|给|帮我|请|麻烦|吧|了(?=$)|的|都|全部|一下|镜头|片段|段/g, '')
    .replace(/\s+/g, '');

  runQuoteRules(c);
  runRemovalRules(c);

  // 否定句（「不要调暖」）不猜：整句交给 AI 或让用户换个说法。「不要第2段」属于删除，放行。
  if (NEGATION_RE.test(c.s) && !onlyDelete()) {
    result.unknown.push(raw);
    return;
  }

  runProjectRules(c);
  runTransformRules(c);
  runMotionRules(c);
  runAudioFadeRules(c);
  runTransitionRules(c);
  runScaleFallbackRules(c);
  runFxRules(c);
  runLookRules(c);
  runLevelRules(c);
  runAdjectiveRules(c);
  runAudioRules(c);
  runSpeedRules(c);
  runDurationRules(c);
  runStructureRules(c);
  runMoveRules(c);

  // 删除必须是整句唯一的意图：「第2段去掉水印」不能被理解成删掉第2段
  if (!c.items.length && !c.errors.length && onlyDelete()) {
    c.emit(0, true, '删除', (target) => ({ type: 'delete', target }));
    c.deleted = true;
    c.s = '';
  }

  result.unknown.push(...c.errors);
  const residual = c.residual();
  if (residual) {
    result.unknown.push(c.items.length ? restore(residual, state) : raw);
  } else if (!c.items.length && !c.errors.length) {
    if (tokens.length) state.pendingTarget = raw;
    else if (bare) result.unknown.push(raw);
  }

  const sorted = [...c.items].sort((a, b) => a.pos - b.pos);
  const clauseOps = [];
  for (const item of sorted) {
    result.ops.push(...item.ops);
    clauseOps.push(...item.ops);
    result.understood.push(item.text);
  }
  if (clauseOps.length) state.lastOps = clauseOps;

  if (c.deleted) state.lastTarget = null;
  else if (tokens.length) {
    const consumedAsMove = clauseOps.some((op) => op.type === 'move') && c.tokens.length === 0;
    if (!consumedAsMove) state.lastTarget = tokensToDescriptor(tokens);
  }
  state.lastLevelDir = c.levelDir;
}

const ORDER_CHANGING = new Set(['delete', 'move', 'duplicate', 'split', 'insertAsset']);

/** 一条指令里用户说的「第N段」都指当前时间线：结构操作之后的编号改用 id，不受前面增删影响 */
function stabilizeIndices(ops, env) {
  if (!env.project) return ops;
  let shifted = false;
  return ops.map((op) => {
    let next = op;
    if (shifted && op.target && op.target.mode === 'index') {
      next = { ...op, target: { mode: 'ids', indices: [], ids: op.target.indices.map((n) => env.clips[n - 1].id) } };
    }
    if (ORDER_CHANGING.has(op.type)) shifted = true;
    return next;
  });
}

/**
 * 解析中文指令。
 * @param {string} text
 * @param {{project?:object, selectedClipIds?:string[], range?:{start:number,end:number}|null, playhead?:number}} options
 * @returns {{ops:object[], understood:string[], unknown:string[]}} 有 unknown 时调用方不应用
 */
export function parseCommand(text, options = {}) {
  const result = { ops: [], understood: [], unknown: [] };
  if (typeof text !== 'string' || !text.trim()) return result;
  const env = buildEnv(options || {});
  try {
    const { masked, quotes } = maskQuotes(text);
    const normalized = normalize(masked);
    const { str, tokens } = extractTokens(normalized, env.n);
    const state = { quotes, tokens, lastTarget: null, lastOps: [], lastLevelDir: null, pendingTarget: null };
    for (const seg of splitClauses(str)) processClause(seg, env, state, result);
    if (state.pendingTarget) result.unknown.push(`「${state.pendingTarget}」：只指定了镜头，没有说要改什么`);
    result.ops = stabilizeIndices(result.ops, env);
  } catch (e) {
    return { ops: [], understood: [], unknown: [`解析出错：${e && e.message ? e.message : e}`] };
  }
  return result;
}
