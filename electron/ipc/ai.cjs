'use strict';
// AI 提供方：codex（本机 Codex CLI）/ openai（OpenAI 兼容接口）/ local（本地规则，抛 NO_AI 由渲染端回退）。
// channel：ai:status、ai:test、ai:run（job）、ai:image（job）、ai:imageTest、ai:metrics。见 SPEC §2.2 ai.cjs、CONTRACTS-w4 C9。
// 进度（C9）：job:progress 的 stage/message 是中文阶段，meta 里带 { phase, phaseKey, elapsedMs, slow }；
//   Codex 走 --json 真实事件，OpenAI 只有「等待回复 → 校验结果」两段；连续 90 秒没有新事件时提示「响应较慢，可以取消」。
// 出图（ai:image）：即梦 Seedream（火山方舟 Ark，和即梦视频共用一个 API Key）或 OpenAI 兼容接口的图片模型，
//   由 settings ai.imageProvider（auto / ark / openai）决定；都没配时抛 code = 'NO_IMAGE_AI'，创作模式退回示意画面。
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { detectCodex, runCodex, _internals: codexInternals } = require('../lib/codex.cjs');
const { run } = require('../lib/proc.cjs');

const { parseJsonLoose, normalizeUsage } = codexInternals;

const OPENAI_TIMEOUT_MS = 120 * 1000;
const IMAGE_TIMEOUT_MS = 180 * 1000;
const IMAGE_SIZES = ['1536x1024', '1024x1536', '1024x1024'];
const TEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'echo'],
  properties: { ok: { type: 'boolean' }, echo: { type: 'string' } },
};

// ───────────────────── 进度阶段（P0-5 L1） ─────────────────────
/** 阶段键 → 中文（简短，界面直接显示） */
const PHASE_TEXT = {
  connecting: '连接 AI',
  connected: '已连接',
  reading: '读取需求',
  thinking: '思考中',
  tool: '查阅资料',
  search: '查资料',
  planning: '规划步骤',
  waiting: '等待回复',
  writing: '整理结果',
  checking: '校验结果',
  retrying: '重新整理',
  fallback: '改用备用接口',
  image: '生成图片',
  resize: '换个尺寸重试',
  backoff: '服务繁忙，正在自动重试',
  download: '下载图片',
  done: '完成',
};
/** 「写」这一步按任务说具体在写什么 */
const WRITING_TEXT = {
  director: '写回复', storyboard: '写分镜', shot: '改分镜', edit: '写方案', analyze: '写分析', tags: '写标签', connection_test: '整理结果',
};
/** 每个阶段的进度起点：进度只跟真实阶段走，阶段内随时间缓慢爬升但不越过下一档 */
const PHASE_FLOOR = {
  connecting: 0.03, connected: 0.08, reading: 0.12, waiting: 0.15, fallback: 0.15, thinking: 0.22, planning: 0.3, tool: 0.35, search: 0.35,
  retrying: 0.5, writing: 0.7, image: 0.2, resize: 0.2, backoff: 0.2, download: 0.8, checking: 0.93, done: 1,
};
const SLOW_AFTER_MS = 90 * 1000;
const SLOW_HINT = '响应较慢，可以取消';

/**
 * 推理强度（Codex model_reasoning_effort，P0-5 L5）。简单任务 low，精修/对话 medium，出整套分镜 high。
 * 对话（director）用 medium 而不是 high：每轮都要等，快一些更重要；整套分镜只出一次，质量优先。
 */
const TASK_EFFORT = {
  connection_test: 'low', tags: 'low', analyze: 'low', shot: 'medium', edit: 'medium', director: 'medium', storyboard: 'high',
};
const USER_EFFORTS = ['low', 'medium', 'high'];

function phaseText(key, task) {
  if (key === 'writing') return WRITING_TEXT[task] || PHASE_TEXT.writing;
  return PHASE_TEXT[key] || '处理中';
}

/** 任务推理强度：设置里指定了 low/medium/high 就用设置，否则按任务映射；请求里显式给的优先 */
function effortFor(task, requested, setting) {
  if (USER_EFFORTS.includes(requested)) return requested;
  if (USER_EFFORTS.includes(setting)) return setting;
  return TASK_EFFORT[task] || null;
}

/**
 * 进度上报器：阶段 + 已用时 + 90 秒看门狗。每秒刷新一次已用时。
 * @param {{progress:Function, meta?:object}} job
 * @param {{task?:string, now?:()=>number, tickMs?:number}} [opts]  tickMs=0 不起定时器（测试用，配合 tick()）
 */
function createProgress(job, { task = '', now = Date.now, tickMs = 1000 } = {}) {
  const t0 = now();
  let key = 'connecting';
  let keyAt = t0;
  let lastEventAt = t0;
  let value = 0;
  let timer = null;
  let stopped = false;
  let shownSlow = false;
  const meta = (job && job.meta && typeof job.meta === 'object') ? job.meta : {};

  function snapshot() {
    const at = now();
    const floor = PHASE_FLOOR[key] != null ? PHASE_FLOOR[key] : 0.2;
    const ceil = key === 'done' ? 1 : Math.min(0.96, floor + 0.14);
    const creep = (ceil - floor) * (1 - Math.exp(-(at - keyAt) / 30000));
    value = Math.max(value, Math.min(ceil, floor + creep));
    const slow = key !== 'done' && at - lastEventAt >= SLOW_AFTER_MS;
    const text = phaseText(key, task);
    return { key, text, value, elapsedMs: at - t0, slow };
  }

  function emit() {
    if (stopped) return null;
    const s = snapshot();
    meta.phase = s.text;
    meta.phaseKey = s.key;
    meta.elapsedMs = s.elapsedMs;
    meta.slow = s.slow;
    shownSlow = s.slow;
    // message 给只认 message 的老界面用：阶段 + 已用时（+ 慢提示）
    const sec = Math.floor(s.elapsedMs / 1000);
    const message = s.key === 'done' ? s.text
      : `${s.text} · 已用 ${sec} 秒${s.slow ? `，${SLOW_HINT}` : ''}`;
    try { job.progress(s.text, s.value, message); } catch {}
    return s;
  }

  return {
    start() {
      emit();
      if (!timer && tickMs > 0) { timer = setInterval(emit, tickMs); if (timer.unref) timer.unref(); }
      return this;
    },
    /** 手动刷新一次（定时器做的就是这个） */
    tick() { return emit(); },
    /**
     * 收到一个真实事件：重置看门狗；阶段变了立即上报，没变就等每秒的刷新
     * （codex --json 的增量事件很密，逐条上报会刷屏 IPC）。
     */
    event(nextKey) {
      lastEventAt = now();
      const changed = !!(nextKey && nextKey !== key && PHASE_TEXT[nextKey]);
      if (changed) { key = nextKey; keyAt = lastEventAt; }
      return changed || shownSlow ? emit() : null;
    },
    set(nextKey) { return this.event(nextKey); },
    snapshot,
    stop() { stopped = true; if (timer) clearInterval(timer); timer = null; },
  };
}

function noAIError(detail) {
  // 消息里固定带「未连接 AI」：错误经过 contextBridge 时 code 会丢，渲染端靠这几个字兜底识别（C9）
  const d = String(detail || '').replace(/[。.\s]+$/, '');
  const e = new Error(d ? `未连接 AI（${d}），已使用本地规则` : '未连接 AI，已使用本地规则');
  e.code = 'NO_AI';
  return e;
}

function cancelledError() {
  const e = new Error('已取消');
  e.code = 'CANCELLED';
  return e;
}

function isCancel(err) {
  return !!err && (err.code === 'CANCELLED' || err.name === 'AbortError' && err.cancelled);
}

function normalizeBaseUrl(url) {
  let s = String(url || '').trim();
  if (!s) return 'https://api.openai.com/v1';
  s = s.replace(/\/+$/, '');
  s = s.replace(/\/(chat\/completions|images\/generations)$/i, '');
  return s;
}

function schemaName(task) {
  const s = String(task || 'frameflow_result').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
  return s || 'frameflow_result';
}

// ───────────────────── 本地用时统计（P0-5 验收：各任务 p50/p90 耗时与 cached_input_tokens） ─────────────────────
// 每次 AI 任务结束追加一行 JSONL（只记任务类型、耗时、token 数，不记任何提示词或结果内容），超过上限只保留最近的记录。
const METRICS_FILE = 'ai-metrics.jsonl';
const METRICS_MAX_BYTES = 512 * 1024;
const METRICS_KEEP_LINES = 1500;

/** 最近秩百分位（p 取 0–100）；没有数据返回 null */
function percentile(values, p) {
  const list = (Array.isArray(values) ? values : []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!list.length) return null;
  const rank = Math.ceil((Math.max(0, Math.min(100, p)) / 100) * list.length);
  return list[Math.min(list.length, Math.max(1, rank)) - 1];
}

function parseMetricsLines(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && typeof e === 'object' && !Array.isArray(e)) out.push(e); } catch {}
  }
  return out;
}

/** 按任务汇总：次数、失败数、成功任务的 p50/p90 耗时、token 合计与缓存命中率 */
function summarizeMetrics(entries) {
  const groups = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== 'object') continue;
    const task = String(e.task || 'ai');
    let g = groups.get(task);
    if (!g) { g = { task, count: 0, ok: 0, ms: [], input: 0, cached: 0, output: 0, providers: {} }; groups.set(task, g); }
    g.count++;
    if (e.ok) { g.ok++; if (Number.isFinite(e.ms)) g.ms.push(e.ms); }
    const u = e.usage && typeof e.usage === 'object' ? e.usage : {};
    g.input += Number(u.inputTokens) || 0;
    g.cached += Number(u.cachedInputTokens) || 0;
    g.output += Number(u.outputTokens) || 0;
    const pv = String(e.provider || 'unknown');
    g.providers[pv] = (g.providers[pv] || 0) + 1;
  }
  return Array.from(groups.values()).map((g) => ({
    task: g.task,
    count: g.count,
    ok: g.ok,
    failed: g.count - g.ok,
    p50Ms: percentile(g.ms, 50),
    p90Ms: percentile(g.ms, 90),
    inputTokens: g.input,
    cachedInputTokens: g.cached,
    outputTokens: g.output,
    cachedRatio: g.input > 0 ? Math.round((g.cached / g.input) * 1000) / 1000 : null,
    providers: g.providers,
  })).sort((a, b) => b.count - a.count || a.task.localeCompare(b.task));
}

/** 追加一条统计；文件过大时只保留最近 keep 行。出错静默（统计不能影响主流程） */
async function appendMetric(file, entry, { maxBytes = METRICS_MAX_BYTES, keep = METRICS_KEEP_LINES } = {}) {
  if (!file || !entry) return false;
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.appendFile(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
    const st = await fsp.stat(file);
    if (st.size > maxBytes) {
      const lines = (await fsp.readFile(file, 'utf8')).split(/\r?\n/).filter((l) => l.trim());
      await fsp.writeFile(file + '.tmp', lines.slice(-keep).join('\n') + '\n', 'utf8');
      await fsp.rename(file + '.tmp', file);
    }
    return true;
  } catch {
    return false;
  }
}

// ───────────────────── 出图：即梦 Seedream（火山方舟 Ark）与 OpenAI 兼容接口 ─────────────────────
// 火山方舟的图片接口是 OpenAI 兼容写法：POST <base>/images/generations，Bearer 鉴权。
// API Key 和即梦视频（Seedance）共用，加密存在 settings 的 arkKey 里。错误码对照火山方舟文档「错误码」。
const ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const ARK_IMAGE_MODEL = 'doubao-seedream-4-0-250828';
const IMAGE_PROVIDERS = ['auto', 'ark', 'openai'];
/** 画幅 → Seedream 推荐像素（火山方舟文档给的推荐宽高） */
const ARK_IMAGE_SIZES = {
  '16:9': '2560x1440', '9:16': '1440x2560', '1:1': '2048x2048', '4:3': '2304x1728', '3:4': '1728x2304',
  '3:2': '2496x1664', '2:3': '1664x2496', '21:9': '3024x1296',
};
/** 老一代图片模型最大只到 2048x2048：前两种尺寸都不被接受时，最后用这组小尺寸 */
const ARK_IMAGE_SIZES_SMALL = {
  '16:9': '1280x720', '9:16': '720x1280', '1:1': '1024x1024', '4:3': '1152x864', '3:4': '864x1152',
  '3:2': '1248x832', '2:3': '832x1248', '21:9': '1512x648',
};
const ASPECT_WORDS = {
  '16:9': '横屏 16:9', '9:16': '竖屏 9:16', '1:1': '方形 1:1', '4:3': '横屏 4:3', '3:4': '竖屏 3:4',
  '3:2': '横屏 3:2', '2:3': '竖屏 2:3', '21:9': '宽银幕 21:9',
};
/** 旧调用方只传 OpenAI 的尺寸：按横竖方换算成画幅 */
const LEGACY_SIZE_ASPECT = { '1536x1024': '16:9', '1792x1024': '16:9', '1024x1536': '9:16', '1024x1792': '9:16', '1024x1024': '1:1' };
const ARK_ACTIVATE_HINT = '请在火山方舟控制台『开通管理』里开通 Seedream 图片模型';
const NO_IMAGE_AI_PREFIX = '还没有可用的出图服务';
const ARK_RETRY_DEFAULT_MS = 5000;
const ARK_RETRY_MAX_MS = 20000;
const IMAGE_MAX_BYTES = 40 * 1024 * 1024;
const IMAGE_PROMPT_MAX = 4000;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 60 * 1000;
const IMAGE_DOWNLOAD_TRIES = 3;
const IMAGE_TEST_TIMEOUT_MS = 100 * 1000;
const IMAGE_TEST_PROMPT = '一杯放在木桌上的热拿铁，清晨的窗光，电影感写实摄影。画面中不要出现文字。';

/**
 * 画幅：调用方给了 aspect 就用它；没给时从 size（「宽x高」）推断，都认不出按 16:9。
 * 不在表里的比例取最接近的一个（例如 4:5 → 3:4）。
 */
function imageAspect(aspect, size) {
  const a = String(aspect || '').trim().replace('：', ':');
  if (ARK_IMAGE_SIZES[a]) return a;
  const s = String(size || '').trim().toLowerCase();
  if (LEGACY_SIZE_ASPECT[s]) return LEGACY_SIZE_ASPECT[s];
  const m = /^(\d+(?:\.\d+)?)\s*[:x×*]\s*(\d+(?:\.\d+)?)$/.exec(a) || /^(\d+)\s*[x×*]\s*(\d+)$/.exec(s);
  if (m && Number(m[1]) > 0 && Number(m[2]) > 0) {
    const want = Math.log(Number(m[1]) / Number(m[2]));
    let best = '16:9';
    let bestGap = Infinity;
    for (const k of Object.keys(ARK_IMAGE_SIZES)) {
      const [w, h] = k.split(':').map(Number);
      const gap = Math.abs(Math.log(w / h) - want);
      if (gap < bestGap - 1e-9) { bestGap = gap; best = k; }
    }
    return best;
  }
  return '16:9';
}

/** 即梦出图依次尝试的尺寸：推荐像素 → '2K'（比例写进描述，由模型自己定宽高）→ 老模型的小尺寸 */
function arkImageSizes(aspect) {
  const a = ARK_IMAGE_SIZES[aspect] ? aspect : '16:9';
  return [ARK_IMAGE_SIZES[a], '2K', ARK_IMAGE_SIZES_SMALL[a]];
}

/** OpenAI 兼容接口只认三种尺寸：调用方给的合法就用，否则按画幅的横竖方挑 */
function openaiImageSize(size, aspect) {
  if (IMAGE_SIZES.includes(size)) return size;
  const [w, h] = imageAspect(aspect, size).split(':').map(Number);
  return w === h ? '1024x1024' : w > h ? '1536x1024' : '1024x1536';
}

function normalizeArkBaseUrl(url) {
  let s = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/\S+$/i.test(s)) return ARK_BASE_URL;
  s = s.replace(/\/(images\/generations|contents\/generations(\/tasks)?|chat\/completions)$/i, '');
  return s || ARK_BASE_URL;
}

/**
 * 出图走哪一家。want 是设置 ai.imageProvider：auto 有火山方舟 Key 就用即梦，否则用 OpenAI 兼容接口的图片模型；
 * 明确选了某一家而它没配好时不改走另一家（返回 none），免得用户以为自己选的生效了。
 * @returns {'ark'|'openai'|'none'}
 */
function pickImageProvider(want, { hasArk = false, hasOpenai = false } = {}) {
  if (want === 'ark') return hasArk ? 'ark' : 'none';
  if (want === 'openai') return hasOpenai ? 'openai' : 'none';
  return hasArk ? 'ark' : hasOpenai ? 'openai' : 'none';
}

/** 没有可用的出图服务时的说明（按出图来源设置给出下一步） */
function noImageDetail(want) {
  if (want === 'ark') return '出图来源选的是「即梦」，但还没有填写火山方舟 API Key。请到设置的「即梦（火山方舟）」里填写';
  if (want === 'openai') return '出图来源选的是「OpenAI 兼容接口」，但还没有填好它的 API Key 和图片模型。请到「设置 → AI 助手」里填写，或把出图来源改成「即梦」';
  return '请到设置的「即梦（火山方舟）」里填写 API Key（推荐），或在「设置 → AI 助手」里给 OpenAI 兼容接口填写图片模型';
}

function noImageAIError(detail) {
  // 消息固定以「还没有可用的出图服务」开头：code 丢了渲染端也能认出来（client.js 的 isNoImageAI）
  const d = String(detail || '').replace(/[。.\s]+$/, '');
  const e = new Error(d ? `${NO_IMAGE_AI_PREFIX}：${d}` : NO_IMAGE_AI_PREFIX);
  e.code = 'NO_IMAGE_AI';
  return e;
}

const ARK_ERROR_BY_CODE = [
  [/Sensitive|RiskDetect|ContentFilter|ContentSecurity|Moderation/i, 'moderation'],
  [/^ModelNotOpen/i, 'not-open'],
  [/^InvalidEndpointOrModel|^ModelNotFound|^EndpointNotFound|^UnsupportedModel/i, 'model'],
  [/^AuthenticationError|^InvalidApiKey|^Unauthorized|^InvalidAccessKey|^MissingAuthentication/i, 'auth'],
  [/Overdue|InsufficientBalance|BalanceNotEnough|Arrears/i, 'balance'],
  [/^SetLimitExceeded/i, 'limit'],
  [/^QuotaExceeded|^InsufficientQuota|FreeTrialEnded/i, 'quota'],
  [/RateLimit|TooManyRequests|RequestBurstTooFast/i, 'rate'],
  [/^ServerOverloaded|^InternalServiceError|^ServiceUnavailable|^InternalError/i, 'busy'],
  [/^AccessDenied|^Forbidden|^OperationDenied|PermissionDenied/i, 'denied'],
];
const ARK_ERROR_BY_MESSAGE = [
  [/has not activated|not (?:been )?activated|未开通/i, 'not-open'],
  [/sensitive|敏感|审核|违规|content policy/i, 'moderation'],
  [/overdue|balance|欠费|余额/i, 'balance'],
  [/free trial|quota|额度/i, 'quota'],
  [/api ?key|credential/i, 'auth'],
  [/rate limit|too many requests|限流|频繁/i, 'rate'],
];
const ARK_SIZE_CODE = /InvalidParameter|InvalidArgument|MissingParameter|BadRequest|InvalidRequest/i;
const ARK_SIZE_MESSAGE = /\bsize\b|尺寸|分辨率|resolution|pixels?\b|\bwidth\b|\bheight\b|aspect ratio/i;
// 明确表示「这次请求没被处理」的错误才自动重试；其余 5xx 和超时不自动重试，免得图片其实已经生成、再发一次重复扣费
const ARK_NOT_PROCESSED = /^ServerOverloaded|^ServiceUnavailable/i;
const ARK_ERROR_TEXT = {
  'not-open': `模型未开通：${ARK_ACTIVATE_HINT}`,
  model: `找不到这个图片模型，或者还没有开通：${ARK_ACTIVATE_HINT}；如果在设置里填了图片模型名，请检查有没有填错（留空会使用默认模型）`,
  auth: '火山方舟 API Key 不对或已失效：请到火山方舟控制台『API Key 管理』重新复制完整的 Key，再填到设置的「即梦（火山方舟）」里',
  balance: '火山方舟账户余额不足或已欠费：请到火山引擎控制台充值后重试',
  limit: '已达到「安全体验模式」设置的用量上限：请在火山方舟控制台『开通管理』里调高上限，或关闭安全体验模式',
  quota: '免费额度已用完：请在火山方舟控制台开通付费或充值后再生成',
  moderation: '内容审核未通过：请换个描述再试（去掉可能敏感的人名、品牌或词语）',
  rate: '请求太频繁，火山方舟暂时限流了：请稍等一两分钟再试',
  busy: '火山方舟服务繁忙：请稍后重试',
  denied: `没有权限使用这个图片模型：${ARK_ACTIVATE_HINT}，并确认 API Key 和开通模型用的是同一个账号`,
  size: '这个图片模型不支持当前的画面尺寸：请在设置的「即梦（火山方舟）」里清空图片模型名（使用默认的 Seedream 模型）后重试',
};
/** 给界面用的粗分类：SETUP 去设置或控制台处理，BALANCE 充值，BLOCKED 换描述，BUSY 等一会儿 */
const ARK_ERROR_CODE = {
  'not-open': 'IMAGE_SETUP', model: 'IMAGE_SETUP', auth: 'IMAGE_SETUP', denied: 'IMAGE_SETUP',
  balance: 'IMAGE_BALANCE', limit: 'IMAGE_BALANCE', quota: 'IMAGE_BALANCE',
  moderation: 'IMAGE_BLOCKED', rate: 'IMAGE_BUSY', busy: 'IMAGE_BUSY', size: 'IMAGE_SIZE', other: 'IMAGE_FAILED',
};

/** 火山方舟出图错误归类。先认错误码，再看是不是尺寸问题，再看英文说明，最后按 HTTP 状态码 */
function classifyArkImageError(code, message, status, param) {
  const c = String(code || '');
  const m = String(message || '');
  const st = Number(status) || 0;
  for (const [re, kind] of ARK_ERROR_BY_CODE) if (c && re.test(c)) return kind;
  if (/^size$/i.test(String(param || ''))) return 'size';
  if ((ARK_SIZE_CODE.test(c) || (!c && st === 400)) && ARK_SIZE_MESSAGE.test(m)) return 'size';
  for (const [re, kind] of ARK_ERROR_BY_MESSAGE) if (m && re.test(m)) return kind;
  if (st === 401) return 'auth';
  if (st === 402) return 'balance';
  if (st === 403) return 'denied';
  if (st === 404) return 'model';
  if (st === 429) return 'rate';
  if (st >= 500) return 'busy';
  return 'other';
}

function arkImageMessage(kind, code, raw, status) {
  if (kind === 'moderation' && /^Input/i.test(code)) return '画面描述没通过内容审核：请换个说法再试（去掉可能敏感的人名、品牌或词语）';
  if (kind === 'moderation' && /^Output/i.test(code)) return '生成的图片没通过内容审核：请调整描述后再试';
  if (ARK_ERROR_TEXT[kind]) return ARK_ERROR_TEXT[kind];
  const head = status ? `火山方舟返回了错误（HTTP ${status}）` : '火山方舟没能生成图片';
  return raw ? `${head}：${raw.slice(0, 200)}` : head;
}

function retryAfterMs(headers) {
  let v = null;
  try { v = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null; } catch {}
  const sec = Number(v);
  if (!Number.isFinite(sec) || sec <= 0) return ARK_RETRY_DEFAULT_MS;
  return Math.max(1000, Math.min(ARK_RETRY_MAX_MS, Math.round(sec * 1000)));
}

/** 取出火山方舟错误体里的 { code, message, param }（兼容 error 对象、顶层字段和 ResponseMetadata.Error 三种写法） */
function arkErrorBody(body) {
  let j = body;
  if (typeof body === 'string') { try { j = JSON.parse(body); } catch { return { code: '', message: body.trim().slice(0, 300), param: '' }; } }
  if (!j || typeof j !== 'object') return { code: '', message: '', param: '' };
  const meta = j.ResponseMetadata && j.ResponseMetadata.Error;
  const e = (j.error && typeof j.error === 'object' ? j.error : null) || (meta && typeof meta === 'object' ? meta : null) || j;
  const code = e.code || e.Code || (typeof j.error === 'string' ? j.error : '') || '';
  const message = e.message || e.Message || '';
  return { code: String(code || ''), message: String(message || '').trim().slice(0, 600), param: String(e.param || '') };
}

/**
 * 火山方舟出图的错误 → 大白话。
 * 返回的 Error 带：status、apiCode（方舟错误码）、detail（原始说明）、kind、code（IMAGE_*）、
 * sizeInvalid（换个尺寸可能就行）、retryable（等几秒重试可能成功，且不会重复扣费）、retryAfterMs。
 */
function arkImageError(status, body, headers) {
  const { code, message, param } = arkErrorBody(body);
  const kind = classifyArkImageError(code, message, status, param);
  const e = new Error(arkImageMessage(kind, code, message, status));
  e.code = ARK_ERROR_CODE[kind] || 'IMAGE_FAILED';
  e.kind = kind;
  if (status) e.status = status;
  if (code) e.apiCode = code;
  if (message) e.detail = message;
  e.sizeInvalid = kind === 'size';
  e.retryable = kind === 'rate' || (kind === 'busy' && (ARK_NOT_PROCESSED.test(code) || Number(status) === 503));
  if (e.retryable) e.retryAfterMs = retryAfterMs(headers);
  return e;
}

/**
 * HTTP 200 但其实没出图的情况：顶层带 error，或 data[0] 里是 error（比如单张图没过审核）。
 * 有图返回 null；没图返回翻译好的 Error。
 */
function arkResultError(result) {
  const r = result && typeof result === 'object' ? result : {};
  const first = Array.isArray(r.data) ? r.data[0] : null;
  if (first && typeof first === 'object' && (first.url || first.b64_json)) return null;
  const inner = (first && typeof first === 'object' && first.error) || r.error;
  if (inner) return arkImageError(0, { error: inner });
  const e = new Error('火山方舟没有返回图片，请重试');
  e.code = 'IMAGE_FAILED';
  return e;
}

/** 从文件头认图片格式和宽高（PNG / JPEG / WebP / GIF）。认不出返回 null（多半是报错网页，不能当图片存） */
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 26) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') {
    return { ext: '.png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let i = 2;
    while (i + 8 < buf.length) {
      if (buf[i] !== 0xFF) { i++; continue; }
      const m = buf[i + 1];
      if (m === 0xFF) { i++; continue; }
      if (m === 0x01 || (m >= 0xD0 && m <= 0xD8)) { i += 2; continue; }
      // SOF0–SOF15（除去 DHT、JPG、DAC）：精度 1 字节后面是 高、宽
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        return { ext: '.jpg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
    return { ext: '.jpg', width: 0, height: 0 };
  }
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const fmt = buf.toString('latin1', 12, 16);
    let width = 0;
    let height = 0;
    if (fmt === 'VP8X' && buf.length >= 30) { width = 1 + buf.readUIntLE(24, 3); height = 1 + buf.readUIntLE(27, 3); }
    else if (fmt === 'VP8 ' && buf.length >= 30) { width = buf.readUInt16LE(26) & 0x3FFF; height = buf.readUInt16LE(28) & 0x3FFF; }
    else if (fmt === 'VP8L' && buf.length >= 25) { const b = buf.readUInt32LE(21); width = 1 + (b & 0x3FFF); height = 1 + ((b >>> 14) & 0x3FFF); }
    return { ext: '.webp', width, height };
  }
  if (/^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) {
    return { ext: '.gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  return null;
}

/** 可取消的等待 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(cancelledError()); return; }
    let timer = null;
    const onAbort = () => { clearTimeout(timer); reject(cancelledError()); };
    timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, ms));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

module.exports = function register({ handle, ctx }) {
  // 联网与等待可由 ctx 注入（只给单测用：伪造响应、跳过退避等待），默认用全局 fetch
  const fetchFn = (...a) => (typeof ctx.fetch === 'function' ? ctx.fetch : globalThis.fetch)(...a);
  const sleepFn = (ms, signal) => (typeof ctx.sleep === 'function' ? ctx.sleep(ms, signal) : sleep(ms, signal));

  // ───────────────────── 配置读取 ─────────────────────
  function aiSettings() {
    const s = (ctx.settings && ctx.settings.get && ctx.settings.get()) || {};
    return s.ai || {};
  }

  function openaiKey() {
    const st = ctx.settings;
    if (!st || typeof st.getSecret !== 'function') return '';
    try { return st.getSecret('openaiKey') || st.getSecret('openai') || ''; } catch { return ''; }
  }

  function openaiConfig() {
    const ai = aiSettings();
    const key = openaiKey();
    const baseUrl = normalizeBaseUrl(ai.openaiBaseUrl);
    const model = String(ai.openaiModel || '').trim();
    return {
      configured: !!key && !!baseUrl && !!model,
      key,
      baseUrl,
      model,
      visionModel: String(ai.openaiVisionModel || '').trim(),
      imageModel: String(ai.openaiImageModel || '').trim(),
    };
  }

  function tmpRoot() {
    try { return ctx.paths.tmp; } catch { return require('node:os').tmpdir(); }
  }

  // ───────────────────── 出图配置（即梦 / OpenAI 兼容接口） ─────────────────────
  /** 火山方舟 API Key：和即梦视频（Seedance）共用，加密存在 settings 的 arkKey */
  function arkKey() {
    const st = ctx.settings;
    if (!st || typeof st.getSecret !== 'function') return '';
    try { return String(st.getSecret('arkKey') || '').trim(); } catch { return ''; }
  }

  function arkConfig() {
    const ai = aiSettings();
    let all = {};
    try { all = (ctx.settings && ctx.settings.get && ctx.settings.get()) || {}; } catch {}
    // 接口地址和即梦视频用同一个（设置里「即梦」的接口地址，一般留空）
    const seedance = (all.videogen && all.videogen.overrides && all.videogen.overrides.seedance) || {};
    const models = ai.imageModels && typeof ai.imageModels === 'object' ? ai.imageModels : {};
    const custom = String(models.ark || '').trim();
    const key = arkKey();
    return {
      configured: !!key,
      key,
      baseUrl: normalizeArkBaseUrl(ai.arkBaseUrl || seedance.baseUrl),
      model: custom || ARK_IMAGE_MODEL,
      customModel: !!custom,
    };
  }

  /** 现在出图会走哪一家：{ want, provider:'ark'|'openai'|'none', ark, openai, hasOpenai } */
  function imageState(requested) {
    const ai = aiSettings();
    const want = IMAGE_PROVIDERS.includes(requested) && requested !== 'auto' ? requested
      : IMAGE_PROVIDERS.includes(ai.imageProvider) ? ai.imageProvider : 'auto';
    const ark = arkConfig();
    const openai = openaiConfig();
    const hasOpenai = !!(openai.key && openai.baseUrl && openai.imageModel);
    return { want, provider: pickImageProvider(want, { hasArk: ark.configured, hasOpenai }), ark, openai, hasOpenai };
  }

  /** 给界面看的出图状态（ai:status 的 image 字段） */
  function imageStatus() {
    const st = imageState();
    const model = st.provider === 'ark' ? st.ark.model : st.provider === 'openai' ? st.openai.imageModel : '';
    const detail = st.provider === 'ark' ? `画面由即梦（Seedream）生成（${st.ark.model}）`
      : st.provider === 'openai' ? `画面由 OpenAI 兼容接口生成（${st.openai.imageModel}）`
        : `${NO_IMAGE_AI_PREFIX}：${noImageDetail(st.want)}`;
    return { want: st.want, provider: st.provider, ready: st.provider !== 'none', model, detail, hasArk: st.ark.configured, hasOpenai: st.hasOpenai };
  }

  // ───────────────────── 用时统计文件（<userData>/logs/ai-metrics.jsonl，与应用日志同目录） ─────────────────────
  function metricsFile() {
    let dir = null;
    try { if (ctx.paths && ctx.paths.userData) dir = path.join(ctx.paths.userData, 'logs'); } catch {}
    if (!dir) {
      try {
        const lg = require('../lib/log.cjs');
        dir = lg && typeof lg.logDir === 'function' ? lg.logDir() : null;
      } catch {}
    }
    return dir ? path.join(dir, METRICS_FILE) : null;
  }
  let metricsChain = Promise.resolve();
  function recordMetric(entry) {
    const file = metricsFile();
    if (!file) return;
    metricsChain = metricsChain.then(() => appendMetric(file, entry)).catch(() => {});
  }

  function wantedProvider(requested) {
    const ai = aiSettings();
    return requested && requested !== 'auto' ? requested : (ai.provider || 'auto');
  }

  /** 解析当前应使用的提供方 */
  async function resolveProvider(requested, { force = false } = {}) {
    const ai = aiSettings();
    const want = wantedProvider(requested);
    const codex = await detectCodex(ctx.settings, { force });
    const openai = openaiConfig();
    const codexReady = !!(codex.ok && codex.loggedIn);
    const codexModel = String(ai.codexModel || '').trim();
    const out = { want, codex, openai, codexReady, codexModel };

    if (want === 'local' || want === 'none') {
      return { ...out, provider: 'local', ready: false, model: '', detail: '本地规则模式：不连接 AI，使用内置规则处理指令与分镜' };
    }
    if (want === 'codex') {
      let detail;
      if (!codex.ok) detail = '未找到 Codex CLI：请安装 Codex 或在设置中填写 codex.exe 路径';
      else if (!codex.loggedIn) detail = 'Codex 未登录：请在终端运行 codex login';
      else detail = `Codex 已就绪（${codex.version || '已安装'}，ChatGPT 登录）`;
      return { ...out, provider: 'codex', ready: codexReady, model: codexModel || 'Codex 默认模型', detail };
    }
    if (want === 'openai') {
      const detail = openai.configured
        ? `OpenAI 兼容接口已配置（${openai.model}）`
        : !openai.key ? '未填写 API Key：请在设置中填写 OpenAI 兼容接口的密钥' : '未填写模型名称：请在设置中填写模型';
      return { ...out, provider: 'openai', ready: openai.configured, model: openai.model, detail };
    }
    // auto
    if (codexReady) {
      return { ...out, provider: 'codex', ready: true, model: codexModel || 'Codex 默认模型', detail: `Codex 已就绪（${codex.version || '已安装'}，ChatGPT 登录）` };
    }
    if (openai.configured) {
      const why = codex.ok ? '（Codex 未登录，已改用 API）' : '';
      return { ...out, provider: 'openai', ready: true, model: openai.model, detail: `使用 OpenAI 兼容接口（${openai.model}）${why}` };
    }
    let detail = '未连接 AI，使用本地规则';
    if (codex.ok && !codex.loggedIn) detail = '已找到 Codex 但未登录：在终端运行 codex login 后即可使用 AI';
    else if (!codex.ok) detail = '未找到 Codex，也未配置 API：当前使用本地规则';
    return { ...out, provider: 'local', ready: false, model: '', detail };
  }

  // ───────────────────── OpenAI 兼容接口 ─────────────────────
  function linkSignals(signal, timeoutMs) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return { combined, timeout };
  }

  function httpError(status, bodyText) {
    let detail = '';
    try {
      const j = JSON.parse(bodyText);
      detail = (j && j.error && (j.error.message || j.error.code)) || j.message || '';
    } catch {
      detail = String(bodyText || '').slice(0, 200);
    }
    detail = String(detail || '').trim().slice(0, 240);
    let msg;
    if (status === 401) msg = 'API Key 无效或已过期（HTTP 401），请在设置中检查密钥';
    else if (status === 403) msg = '没有访问该模型的权限（HTTP 403），请检查账号权限或模型名称';
    else if (status === 404) msg = '接口地址或模型名称不正确（HTTP 404），请检查 baseUrl 与模型';
    else if (status === 429) msg = '请求过于频繁或额度已用完（HTTP 429），请稍后重试或检查账户余额';
    else if (status === 400) msg = '模型服务拒绝了请求（HTTP 400）';
    else if (status === 413) msg = '请求内容过大（HTTP 413），请减少图片数量或缩短内容';
    else if (status >= 500) msg = `模型服务暂时不可用（HTTP ${status}），请稍后重试`;
    else msg = `模型接口返回错误（HTTP ${status}）`;
    const e = new Error(detail ? `${msg}：${detail}` : msg);
    e.status = status;
    return e;
  }

  /**
   * POST JSON。makeHttpError 可换成别家的错误翻译（即梦出图用 arkImageError）；service 是报错里对服务的称呼。
   * 连不上 / 超时抛的错带 code：NETWORK / TIMEOUT，方便上层决定要不要重试。
   */
  async function postJson(url, key, body, { signal, timeoutMs, makeHttpError = httpError, service = '' }) {
    const { combined, timeout } = linkSignals(signal, timeoutMs);
    const name = service || '模型服务';
    let res;
    try {
      res = await fetchFn(url, {
        method: 'POST',
        signal: combined,
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (signal && signal.aborted) throw cancelledError();
      if (timeout.aborted) {
        const e = new Error(`${service || '模型接口'}响应超时（超过 ${Math.round(timeoutMs / 1000)} 秒），请稍后重试`);
        e.code = 'TIMEOUT';
        throw e;
      }
      const e = new Error(`无法连接${name}：请检查${service ? '' : '接口地址与'}网络（${(err && err.cause && err.cause.code) || (err && err.message) || '网络错误'}）`);
      e.code = 'NETWORK';
      throw e;
    }
    let text = '';
    try { text = await res.text(); } catch (err) {
      if (signal && signal.aborted) throw cancelledError();
      throw new Error(`读取${name}响应失败，请重试`);
    }
    if (!res.ok) throw makeHttpError(res.status, text, res.headers);
    try { return JSON.parse(text); } catch { throw new Error(`${name}返回了无效响应（不是 JSON）`); }
  }

  async function imageToDataUrl(file, signal) {
    const ffmpeg = ctx.paths && ctx.paths.ffmpeg;
    if (ffmpeg && fs.existsSync(ffmpeg)) {
      const out = path.join(tmpRoot(), `aiimg-${crypto.randomBytes(6).toString('hex')}.jpg`);
      try {
        const r = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-frames:v', '1',
          '-vf', "scale='min(1024,iw)':-2", '-q:v', '4', out], { signal, timeoutMs: 30000 });
        if (r.code === 0 && fs.existsSync(out)) {
          const buf = await fsp.readFile(out);
          return `data:image/jpeg;base64,${buf.toString('base64')}`;
        }
      } catch (err) {
        if (err && err.code === 'CANCELLED') throw cancelledError();
      } finally {
        fsp.rm(out, { force: true }).catch(() => {});
      }
    }
    // 兜底：直接读原图（仅常见格式）
    const ext = path.extname(file).toLowerCase();
    const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }[ext];
    if (!mime) throw new Error(`无法处理图片：${path.basename(file)}`);
    const buf = await fsp.readFile(file);
    if (buf.length > 15 * 1024 * 1024) throw new Error(`图片过大：${path.basename(file)}`);
    return `data:${mime};base64,${buf.toString('base64')}`;
  }

  async function runOpenAI({ task, system, prompt, images, schema, timeoutMs, signal, onPhase }) {
    const cfg = openaiConfig();
    if (!cfg.configured) throw new Error('OpenAI 兼容接口未配置：请在设置中填写 API Key 与模型');
    const phase = (k) => { if (onPhase) { try { onPhase(k); } catch {} } };
    const imgs = (images || []).filter((p) => typeof p === 'string' && fs.existsSync(p));
    const model = imgs.length && cfg.visionModel ? cfg.visionModel : cfg.model;
    const limit = Number(timeoutMs) > 0 ? Math.min(Number(timeoutMs), 600000) : OPENAI_TIMEOUT_MS;
    let userContent = String(prompt || '');
    if (imgs.length) {
      phase('reading');
      const parts = [{ type: 'text', text: userContent }];
      for (const p of imgs) {
        if (signal && signal.aborted) throw cancelledError();
        parts.push({ type: 'image_url', image_url: { url: await imageToDataUrl(p, signal) } });
      }
      userContent = parts;
    }
    const url = `${cfg.baseUrl}/chat/completions`;
    const sys = String(system || '');
    const makeBody = (mode) => {
      const sysText = mode === 'json_object'
        ? `${sys}\n\n请只输出一个 JSON 对象，不要输出其他文字。JSON 必须严格符合以下 JSON Schema：\n${JSON.stringify(schema)}`
        : sys;
      const messages = [];
      if (sysText.trim()) messages.push({ role: 'system', content: sysText });
      messages.push({ role: 'user', content: userContent });
      const body = { model, messages };
      body.response_format = mode === 'json_object'
        ? { type: 'json_object' }
        : { type: 'json_schema', json_schema: { name: schemaName(task), strict: true, schema } };
      return body;
    };
    const started = Date.now();
    let result;
    phase('waiting');
    try {
      result = await postJson(url, cfg.key, makeBody('json_schema'), { signal, timeoutMs: limit });
    } catch (err) {
      if (err && err.status === 400) {
        phase('retrying');
        const remaining = Math.max(15000, limit - (Date.now() - started));
        result = await postJson(url, cfg.key, makeBody('json_object'), { signal, timeoutMs: remaining });
      } else {
        throw err;
      }
    }
    phase('checking');
    const choice = result && result.choices && result.choices[0];
    const msg = choice && choice.message;
    if (msg && msg.refusal) throw new Error(`模型拒绝了该请求：${String(msg.refusal).slice(0, 200)}`);
    let content = msg && msg.content;
    if (Array.isArray(content)) content = content.map((c) => (typeof c === 'string' ? c : c && c.text) || '').join('');
    if (typeof content !== 'string' || !content.trim()) {
      if (choice && choice.finish_reason === 'length') throw new Error('模型输出被截断（内容过长），请缩短请求后重试');
      throw new Error('模型服务没有返回内容');
    }
    let data;
    try { data = parseJsonLoose(content); } catch (e) { throw new Error(`模型返回内容无法解析：${e.message}`); }
    if (!data || typeof data !== 'object') throw new Error('模型返回的不是 JSON 对象');
    return { data, model, usage: normalizeUsage(result && result.usage) };
  }

  async function runCodexCall({ system, prompt, images, schema, timeoutMs, signal, effort, onEvent }, state) {
    if (!state.codex.ok || !state.codex.path) throw new Error('未找到 Codex CLI：请安装 Codex，或在设置中填写 codex.exe 的路径');
    if (!state.codex.loggedIn) {
      const e = new Error('Codex 未登录：请在终端运行 codex login');
      e.code = 'CODEX_LOGIN';
      throw e;
    }
    let usage = null;
    let attempts = 1;
    const data = await runCodex({
      codexPath: state.codex.path,
      model: state.codexModel || undefined,
      system,
      prompt,
      schema,
      images,
      timeoutMs,
      signal,
      tmpRoot: tmpRoot(),
      effort: effort || null,
      onEvent: (ev) => {
        if (ev && ev.type === 'ff.done') { usage = ev.usage || null; attempts = ev.attempts || 1; }
        if (onEvent) onEvent(ev);
      },
    });
    return { data, model: state.codexModel || 'codex', usage, attempts };
  }

  // ───────────────────── channels ─────────────────────
  handle('ai:status', async (payload) => {
    const st = await resolveProvider(null, { force: !!(payload && payload.refresh) });
    return {
      provider: st.provider,
      ready: st.ready,
      model: st.model,
      detail: st.detail,
      codex: { ok: !!st.codex.ok, loggedIn: !!st.codex.loggedIn, path: st.codex.path || null, version: st.codex.version || null },
      openai: {
        configured: st.openai.configured,
        baseUrl: st.openai.baseUrl,
        model: st.openai.model,
        visionModel: st.openai.visionModel,
        imageModel: st.openai.imageModel,
      },
      // 出图现在走哪一家：{ want, provider:'ark'|'openai'|'none', ready, model, detail, hasArk, hasOpenai }
      image: imageStatus(),
    };
  });

  handle('ai:test', async (payload) => {
    const requested = payload && payload.provider;
    const st = await resolveProvider(requested, { force: true });
    const t0 = Date.now();
    const req = {
      task: 'connection_test',
      system: '你是连接测试助手。只输出符合 schema 的 JSON。',
      prompt: '这是一次连接测试：把 ok 设为 true，echo 填写「镜流连接正常」。',
      schema: TEST_SCHEMA,
    };
    if (st.provider === 'local') {
      return { ok: false, ms: 0, detail: '当前为本地规则模式，未连接 AI（可在上方选择 Codex 或 OpenAI 兼容接口）' };
    }
    try {
      if (st.provider === 'codex') {
        const { data } = await runCodexCall({ ...req, timeoutMs: 120000 }, st);
        const ms = Date.now() - t0;
        if (!data || data.ok !== true) return { ok: false, ms, detail: 'Codex 有响应，但返回内容不符合预期' };
        return { ok: true, ms, detail: `Codex 连接正常（${st.codex.version || ''}，耗时 ${(ms / 1000).toFixed(1)} 秒）` };
      }
      const { data, model } = await runOpenAI({ ...req, timeoutMs: 60000 });
      const ms = Date.now() - t0;
      if (!data || data.ok !== true) return { ok: false, ms, detail: '接口有响应，但返回内容不符合预期' };
      return { ok: true, ms, detail: `接口连接正常（${model}，耗时 ${(ms / 1000).toFixed(1)} 秒）` };
    } catch (err) {
      return { ok: false, ms: Date.now() - t0, detail: (err && err.message) || String(err) };
    }
  });

  handle('ai:run', async (payload) => {
    const { task, system, prompt, images, schema, timeoutMs, provider, effort } = payload || {};
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('AI 调用缺少输出结构（schema）');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('AI 调用缺少提示词');
    const imgList = Array.isArray(images) ? images.filter((p) => typeof p === 'string' && p) : [];

    // C9：本地规则 / 不用 AI 时立即失败（code = NO_AI），不检测 Codex、不建任务，渲染端马上走本地规则
    const want = wantedProvider(provider);
    if (want === 'local' || want === 'none') throw noAIError();
    const st = await resolveProvider(provider);
    if (st.provider === 'local') throw noAIError();
    if (!st.ready) {
      // 指定的提供方不可用：codex 不可用时若 API 可用则改用 API，否则回退本地规则
      if (st.provider === 'codex' && st.openai.configured) st.provider = 'openai';
      else throw noAIError(st.detail);
    }

    const taskName = String(task || '');
    const eff = effortFor(taskName, effort, aiSettings().codexEffort);
    return ctx.jobs.start('ai', async (job) => {
      const t0 = Date.now();
      const prog = createProgress(job, { task: taskName }).start();
      const req = { task, system, prompt, images: imgList, schema, timeoutMs, signal: job.signal };
      const onPhase = (k) => prog.event(k);
      let used = st.provider;
      try {
        let out;
        if (st.provider === 'codex') {
          try {
            out = await runCodexCall({ ...req, effort: eff, onEvent: (ev) => prog.event(ev && ev.phase) }, st);
          } catch (err) {
            if (job.cancelled || isCancel(err)) throw cancelledError();
            if (!st.openai.configured) throw err;
            console.warn(`[ai ${taskName}] Codex 失败，回退 OpenAI：`, err && err.message);
            used = 'openai';
            prog.event('fallback');
            out = await runOpenAI({ ...req, onPhase });
          }
        } else {
          out = await runOpenAI({ ...req, onPhase });
        }
        job.throwIfCancelled();
        prog.event('done');
        const ms = Date.now() - t0;
        const result = { data: out.data, provider: used, model: out.model, ms };
        if (out.usage) result.usage = out.usage;
        if (out.attempts > 1) result.attempts = out.attempts;
        recordMetric({
          task: taskName || 'ai', provider: used, ok: true, ms, attempts: out.attempts || 1,
          effort: used === 'codex' ? eff : null, images: imgList.length, usage: out.usage || null,
        });
        return result;
      } catch (err) {
        const cancelled = !!(job.cancelled || isCancel(err));
        recordMetric({
          task: taskName || 'ai', provider: used, ok: false, ms: Date.now() - t0, cancelled,
          code: cancelled ? 'CANCELLED' : (err && err.code) || null, images: imgList.length,
        });
        if (cancelled) throw cancelledError();
        throw err;
      } finally {
        prog.stop();
      }
    }, { task: taskName });
  });

  /** 本机 AI 用时统计：各任务的次数、p50/p90 耗时、token 与缓存命中（不含任何提示词内容） */
  handle('ai:metrics', async () => {
    const file = metricsFile();
    let entries = [];
    if (file) {
      await metricsChain.catch(() => {});
      try { entries = parseMetricsLines(await fsp.readFile(file, 'utf8')); } catch {}
    }
    return { file: file || null, total: entries.length, tasks: summarizeMetrics(entries) };
  });

  // ───────────────────── 出图 ─────────────────────
  function imageDir(projectId) {
    try {
      return projectId ? path.join(ctx.paths.projectCache(projectId), 'ai-images') : path.join(ctx.paths.cache, 'ai-images');
    } catch (e) {
      throw new Error(`无法定位项目缓存目录：${e.message}`);
    }
  }

  /**
   * 向火山方舟要一张图。
   * - 尺寸不被接受：依次换成 '2K'（比例写进描述）、老模型的小尺寸再试，被拒绝的请求不计费；
   * - 限流 / 明确没处理的繁忙：按服务商给的等待时间（默认 5 秒）退避后重试一次；
   * - 超时和其余错误不自动重试：图片可能其实已经生成，再发一次会重复扣费。
   * @returns {Promise<{item:object, size:string}>}
   */
  async function requestArkImage(cfg, { prompt, aspect, signal, onPhase, timeoutMs }) {
    const phase = (k) => { if (onPhase) { try { onPhase(k); } catch {} } };
    const url = `${cfg.baseUrl}/images/generations`;
    const sizes = arkImageSizes(aspect);
    let backedOff = false;
    for (let i = 0; i < sizes.length; i++) {
      const size = sizes[i];
      const text = size === '2K' ? `${prompt}\n画面比例：${ASPECT_WORDS[aspect] || aspect}。` : prompt;
      const body = { model: cfg.model, prompt: text, size, response_format: 'url', watermark: false };
      let item = null;
      let sizeRejected = false;
      while (!item && !sizeRejected) {
        try {
          const result = await postJson(url, cfg.key, body, { signal, timeoutMs, makeHttpError: arkImageError, service: '火山方舟' });
          const bad = arkResultError(result);
          if (bad) throw bad;
          item = result.data[0];
        } catch (err) {
          if (isCancel(err) || (signal && signal.aborted)) throw cancelledError();
          if (err && err.retryable && !backedOff) {
            backedOff = true;
            phase('backoff');
            await sleepFn(err.retryAfterMs || ARK_RETRY_DEFAULT_MS, signal);
            phase('image');
          } else if (err && err.sizeInvalid && i < sizes.length - 1) {
            sizeRejected = true;
            phase('resize');
          } else {
            throw err;
          }
        }
      }
      if (item) return { item, size };
    }
    throw new Error('火山方舟没有返回图片，请重试');
  }

  /** 按出图状态（imageState 的结果）生成一张图，返回服务商给的那一项（url 或 b64_json），还没下载 */
  async function generateImage(st, { prompt, aspect, size, signal, onPhase, timeoutMs = IMAGE_TIMEOUT_MS }) {
    if (st.provider === 'none') throw noImageAIError(noImageDetail(st.want));
    const text = String(prompt || '').trim().slice(0, IMAGE_PROMPT_MAX);
    const asp = imageAspect(aspect, size);
    if (st.provider === 'ark') {
      const r = await requestArkImage(st.ark, { prompt: text, aspect: asp, signal, onPhase, timeoutMs });
      return { provider: 'ark', model: st.ark.model, aspect: asp, size: r.size, item: r.item };
    }
    const sz = openaiImageSize(size, asp);
    const result = await postJson(`${st.openai.baseUrl}/images/generations`, st.openai.key,
      { model: st.openai.imageModel, prompt: text, size: sz, n: 1 }, { signal, timeoutMs });
    const item = result && Array.isArray(result.data) ? result.data[0] : null;
    if (!item) throw new Error('图片服务没有返回图片');
    return { provider: 'openai', model: st.openai.imageModel, aspect: asp, size: sz, item };
  }

  /** 下载生成好的图片。地址是服务商给的临时链接：下载失败只重新下载（最多 3 次），不重新生成，免得再扣一次费 */
  async function downloadImage(url, signal) {
    if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('图片服务返回的图片地址无效');
    let lastErr = null;
    for (let i = 0; i < IMAGE_DOWNLOAD_TRIES; i++) {
      if (signal && signal.aborted) throw cancelledError();
      if (i > 0) await sleepFn(i === 1 ? 1500 : 4000, signal);
      const { combined, timeout } = linkSignals(signal, IMAGE_DOWNLOAD_TIMEOUT_MS);
      let res;
      try {
        res = await fetchFn(url, { signal: combined });
      } catch (err) {
        if (signal && signal.aborted) throw cancelledError();
        lastErr = new Error(timeout.aborted ? '图片已生成，但下载超时：请检查网络后重试' : '图片已生成，但下载失败：请检查网络后重试');
        continue;
      }
      if (!res.ok) {
        lastErr = new Error(`图片已生成，但下载失败（HTTP ${res.status}），请重试`);
        // 链接失效或无权访问：再下也一样
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) throw lastErr;
        continue;
      }
      let len = 0;
      try { len = Number(res.headers && res.headers.get && res.headers.get('content-length')) || 0; } catch {}
      if (len > IMAGE_MAX_BYTES) throw new Error('生成的图片过大，无法保存');
      try {
        return Buffer.from(await res.arrayBuffer());
      } catch (err) {
        if (signal && signal.aborted) throw cancelledError();
        lastErr = new Error(timeout.aborted ? '图片已生成，但下载超时：请检查网络后重试' : '图片已生成，但下载中断：请检查网络后重试');
      }
    }
    throw lastErr || new Error('图片已生成，但下载失败，请重试');
  }

  async function imageBytes(item, { signal, onPhase } = {}) {
    if (item && item.b64_json) return Buffer.from(String(item.b64_json), 'base64');
    if (item && item.url) {
      if (onPhase) { try { onPhase('download'); } catch {} }
      return downloadImage(item.url, signal);
    }
    throw new Error('图片服务返回的数据中没有图片');
  }

  /** 存盘：按文件头认格式（即梦返回 JPEG，OpenAI 多为 PNG），扩展名和真实格式一致；不是图片的数据不落盘 */
  async function saveImage(buf, dir, seed) {
    const info = sniffImage(buf);
    if (!info) throw new Error('生成的图片数据无效（收到的不是图片），请重试');
    if (buf.length > IMAGE_MAX_BYTES) throw new Error('生成的图片过大，无法保存');
    await fsp.mkdir(dir, { recursive: true });
    const hash = crypto.createHash('sha1').update(`${seed}|${Date.now()}|${Math.random()}`).digest('hex').slice(0, 16);
    const file = path.join(dir, `${hash}${info.ext}`);
    await fsp.writeFile(file + '.tmp', buf);
    await fsp.rename(file + '.tmp', file);
    if (typeof ctx.registerMediaPath === 'function') ctx.registerMediaPath(file);
    return { path: file, width: info.width || 0, height: info.height || 0 };
  }

  /**
   * 生成一张图片（后台任务）。
   * payload：{ prompt, projectId?, aspect?:'16:9'|'9:16'|'1:1'|'4:3'|'3:4'|…, size?:旧的 OpenAI 尺寸, provider?:'auto'|'ark'|'openai' }
   * 结果：{ path, provider:'ark'|'openai', model, width, height, size, aspect }（provider / model 供调用方写 asset.ai，契约 C10）
   */
  handle('ai:image', async (payload) => {
    const { prompt, projectId, aspect, size, provider } = payload || {};
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('请提供图片描述');
    // 没有可用的出图服务：立即失败（code = NO_IMAGE_AI），不建任务，创作模式据此退回示意画面
    const st = imageState(provider);
    if (st.provider === 'none') throw noImageAIError(noImageDetail(st.want));
    const dir = imageDir(projectId);

    return ctx.jobs.start('ai-image', async (job) => {
      const t0 = Date.now();
      const prog = createProgress(job, { task: 'image' }).start();
      prog.event('image');
      const onPhase = (k) => prog.event(k);
      try {
        const out = await generateImage(st, { prompt, aspect, size, signal: job.signal, onPhase });
        job.throwIfCancelled();
        const buf = await imageBytes(out.item, { signal: job.signal, onPhase });
        job.throwIfCancelled();
        const saved = await saveImage(buf, dir, `${out.model}|${out.size}|${prompt}`);
        prog.event('done');
        recordMetric({ task: 'image', provider: out.provider, ok: true, ms: Date.now() - t0 });
        return { path: saved.path, provider: out.provider, model: out.model, width: saved.width, height: saved.height, size: out.size, aspect: out.aspect };
      } catch (err) {
        const cancelled = !!(job.cancelled || isCancel(err));
        recordMetric({
          task: 'image', provider: st.provider, ok: false, ms: Date.now() - t0, cancelled,
          code: cancelled ? 'CANCELLED' : (err && err.code) || null,
        });
        if (cancelled) throw cancelledError();
        throw err;
      } finally {
        prog.stop();
      }
    }, { task: 'image', provider: st.provider });
  });

  /**
   * 试生成一张图（设置里的「测试出图」）。会真的调用一次出图接口，按服务商的价格计一张图的费用。
   * 不抛错，统一返回 { ok, ms, detail, provider, model, code?, path?, width?, height? }；path 可直接拿去预览。
   */
  handle('ai:imageTest', async (payload) => {
    const st = imageState(payload && payload.provider);
    if (st.provider === 'none') {
      return { ok: false, ms: 0, code: 'NO_IMAGE_AI', provider: 'none', model: '', detail: noImageAIError(noImageDetail(st.want)).message };
    }
    const model = st.provider === 'ark' ? st.ark.model : st.openai.imageModel;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), IMAGE_TEST_TIMEOUT_MS);
    const t0 = Date.now();
    try {
      const out = await generateImage(st, { prompt: IMAGE_TEST_PROMPT, aspect: '16:9', signal: ac.signal, timeoutMs: IMAGE_TEST_TIMEOUT_MS });
      const buf = await imageBytes(out.item, { signal: ac.signal });
      // 只留最近一张测试图
      const dir = path.join(tmpRoot(), 'ai-image-test');
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      const saved = await saveImage(buf, dir, 'test');
      const ms = Date.now() - t0;
      const dims = saved.width && saved.height ? `，${saved.width}×${saved.height}` : '';
      return {
        ok: true, ms, provider: out.provider, model: out.model, path: saved.path, width: saved.width, height: saved.height,
        detail: `${out.provider === 'ark' ? '即梦出图正常' : '出图接口正常'}（${out.model}${dims}，耗时 ${(ms / 1000).toFixed(1)} 秒）`,
      };
    } catch (err) {
      const timedOut = ac.signal.aborted;
      return {
        ok: false, ms: Date.now() - t0, provider: st.provider, model,
        code: timedOut ? 'TIMEOUT' : (err && err.code) || null,
        detail: timedOut ? `出图超时（超过 ${Math.round(IMAGE_TEST_TIMEOUT_MS / 1000)} 秒）：请检查网络后重试` : (err && err.message) || String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  });
};

module.exports._internals = {
  normalizeBaseUrl, schemaName, TEST_SCHEMA, noAIError, createProgress, phaseText, effortFor, TASK_EFFORT, PHASE_TEXT,
  SLOW_AFTER_MS, percentile, summarizeMetrics, parseMetricsLines, appendMetric,
  // 出图
  ARK_BASE_URL, ARK_IMAGE_MODEL, ARK_IMAGE_SIZES, imageAspect, arkImageSizes, openaiImageSize, normalizeArkBaseUrl,
  pickImageProvider, noImageAIError, classifyArkImageError, arkImageError, arkResultError, sniffImage,
};
