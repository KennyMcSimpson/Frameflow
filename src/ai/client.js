// AI 调用客户端（CONTRACTS §D / C9）：统一走主进程 ai:run 后台任务。
// 主进程 provider=local/none 时立即失败（code==='NO_AI'，不建任务），这里转成 NoAIError，调用方据此回退到本地规则。
// 错误穿过 contextBridge 时自定义的 code 可能丢失，所以 isNoAI 也认消息里的「未连接 AI」/ NO_AI。
// 进度（C9）：onProgress 收到的对象保留 jobId/stage/progress/message，另带 phase（简短中文阶段）、elapsedMs、slow。
// 出图（ai:image）不走 runAI，但出错怎么认在这里统一：isNoImageAI（还没配出图服务）、imageErrorKind（该引导用户做什么）。
import api from '../ui/api.js';

export const NO_AI_MESSAGE = '未连接 AI，已使用本地规则';

export class NoAIError extends Error {
  constructor(message = NO_AI_MESSAGE) {
    super(message || NO_AI_MESSAGE);
    this.name = 'NoAIError';
    this.code = 'NO_AI';
  }
}

const NO_AI_TEXT = /未连接\s*AI|\bNO_AI\b/;

/** 是否「没有可用 AI」类错误（调用方应回退本地逻辑）：认 code、name、固定文案，也往 cause 里看几层 */
export function isNoAI(err, depth = 0) {
  if (!err || depth > 3) return false;
  if (typeof err === 'string') return NO_AI_TEXT.test(err);
  if (err instanceof NoAIError || err.code === 'NO_AI' || err.name === 'NoAIError') return true;
  if (typeof err.message === 'string' && NO_AI_TEXT.test(err.message)) return true;
  return typeof err === 'object' && err.cause ? isNoAI(err.cause, depth + 1) : false;
}

// 出图（ai:image）没配好服务时，主进程不建任务、直接报 NO_IMAGE_AI，消息固定以「还没有可用的出图服务」开头
const NO_IMAGE_AI_TEXT = /还没有可用的出图服务|当前 AI 不支持生成图片|\bNO_IMAGE_AI\b/;

/**
 * 是否「没有可用的出图服务」（既没填火山方舟 API Key，也没配 OpenAI 兼容接口的图片模型）。
 * 调用方应退回示意画面，并引导用户去设置里填即梦的 Key。和 isNoAI 一样：code 丢了也能凭文案认出来。
 */
export function isNoImageAI(err, depth = 0) {
  if (!err || depth > 3) return false;
  if (typeof err === 'string') return NO_IMAGE_AI_TEXT.test(err);
  if (err.code === 'NO_IMAGE_AI') return true;
  if (typeof err.message === 'string' && NO_IMAGE_AI_TEXT.test(err.message)) return true;
  return typeof err === 'object' && err.cause ? isNoImageAI(err.cause, depth + 1) : false;
}

const IMAGE_ERROR_KINDS = { IMAGE_SETUP: 'setup', IMAGE_SIZE: 'setup', IMAGE_BALANCE: 'balance', IMAGE_BLOCKED: 'blocked', IMAGE_BUSY: 'busy' };
// 任务通道的错误码一般都在；万一丢了，按主进程固定的中文说法兜底
const IMAGE_ERROR_TEXT = [
  [/未开通|找不到这个(?:图片)?模型|API Key (?:无效|不对)|没有权限使用|不支持当前的画面尺寸/, 'setup'],
  [/欠费|余额不足|额度已用完|用量上限/, 'balance'],
  [/内容审核|敏感/, 'blocked'],
  [/请求太频繁|服务繁忙/, 'busy'],
];

/**
 * 出图失败后该引导用户做什么（界面据此决定按钮）：
 * 'none' 还没配出图服务 → 去设置；'setup' Key / 模型没配对 → 去设置或火山方舟控制台；'balance' 欠费、额度用完 → 去充值；
 * 'blocked' 没过内容审核 → 改画面描述；'busy' 限流、服务繁忙 → 稍后重试；'cancelled' 用户取消；'other' 其他（原样显示错误）。
 */
export function imageErrorKind(err) {
  if (!err) return 'other';
  if (isCancelled(err)) return 'cancelled';
  if (isNoImageAI(err)) return 'none';
  const byCode = IMAGE_ERROR_KINDS[err.code];
  if (byCode) return byCode;
  const msg = typeof err === 'string' ? err : String(err.message || '');
  for (const [re, kind] of IMAGE_ERROR_TEXT) if (re.test(msg)) return kind;
  return 'other';
}

/** 是否用户取消 */
export function isCancelled(err) {
  return !!err && (err.cancelled === true || err.code === 'CANCELLED');
}

function cancelledError() {
  const e = new Error('已取消');
  e.cancelled = true;
  e.code = 'CANCELLED';
  return e;
}

/** 去掉 Electron 给 invoke 错误加的英文前缀，留下给人看的那句 */
function cleanMessage(msg) {
  return String(msg || '').replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(?:Error|NoAIError):\s*/, '').trim();
}

/**
 * 把主进程 job:progress 的 meta（phase/elapsedMs/slow）摊平到进度对象上（C9）。
 * 主进程还没带 meta 时：phase 退回 stage，elapsedMs 用本地计时。
 */
export function flattenProgress(p, startedAt = Date.now()) {
  if (!p || typeof p !== 'object') return p;
  const m = p.meta && typeof p.meta === 'object' ? p.meta : {};
  const out = { ...p };
  if (typeof out.phase !== 'string' || !out.phase) out.phase = (typeof m.phase === 'string' && m.phase) || (typeof p.stage === 'string' ? p.stage : '');
  if (!Number.isFinite(out.elapsedMs)) out.elapsedMs = Number.isFinite(m.elapsedMs) ? m.elapsedMs : Math.max(0, Date.now() - startedAt);
  if (typeof out.slow !== 'boolean') out.slow = m.slow === true;
  return out;
}

/** signal 取消时立即结束等待，并通知主进程取消任务 */
function raceAbort(promise, signal, onAbort) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => { try { onAbort(); } catch { /* 取消失败也照常结束等待 */ } reject(cancelledError()); };
    if (signal.aborted) { abort(); promise.catch(() => {}); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', abort); resolve(v); },
      (e) => { signal.removeEventListener('abort', abort); reject(e); },
    );
  });
}

const TASK_LABELS = {
  director: 'AI 导演', storyboard: '生成分镜', shot: '修改分镜', edit: 'AI 精修', analyze: 'AI 拆片分析', tags: '素材打标签',
};

const DEFAULT_TIMEOUT = { director: 180000, storyboard: 300000, shot: 150000, edit: 180000, analyze: 420000, tags: 90000 };

function friendly(err, task) {
  const label = TASK_LABELS[task] || 'AI';
  const raw = (err && err.message) || String(err || '');
  let msg = raw;
  if (/timeout|timed out|超时/i.test(raw)) msg = `${label}响应超时，请稍后重试，或在设置里换成更快的 AI 提供方`;
  else if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|network|fetch failed|网络/i.test(raw)) msg = `${label}连接失败：网络不可用或服务无响应（${raw}）`;
  else if (/401|unauthori[sz]ed|login|登录/i.test(raw)) msg = `${label}需要重新登录或检查密钥（${raw}）`;
  else if (!/[一-龥]/.test(raw)) msg = `${label}请求失败：${raw || '未知错误'}`;
  const e = new Error(msg);
  e.code = err && err.code;
  e.cancelled = isCancelled(err);
  e.cause = err;
  return e;
}

/**
 * 运行一次结构化 AI 请求。
 * @param {{task:string, system:string, prompt:string, schema:object, images?:string[], timeoutMs?:number, provider?:string, effort?:'low'|'medium'|'high'}} request
 * @param {{onProgress?:Function, onStart?:Function, signal?:AbortSignal}} [hooks]
 * @returns {Promise<{data:object, provider:string, model:string, ms:number, usage?:object, attempts?:number}>}
 */
export async function runAI(request, { onProgress, onStart, signal } = {}) {
  const { task = 'ai', system = '', prompt = '', schema, images, timeoutMs, provider, effort } = request || {};
  if (!schema || typeof schema !== 'object') throw new Error('AI 请求缺少输出格式（schema）');
  if (!prompt && !system) throw new Error('AI 请求内容为空');
  if (signal && signal.aborted) throw cancelledError();
  if (!api.available) throw new NoAIError('未连接 AI（当前不在桌面环境中运行），已使用本地规则');
  const payload = {
    task,
    system,
    prompt,
    schema,
    images: Array.isArray(images) ? images.filter((p) => typeof p === 'string' && p).slice(0, 8) : [],
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : (DEFAULT_TIMEOUT[task] || 180000),
  };
  if (provider) payload.provider = provider;
  if (effort) payload.effort = effort;
  const started = Date.now();
  let jobId = null;
  const cancelJob = (id) => { try { Promise.resolve(api.cancel(id)).catch(() => {}); } catch { /* 主进程不在时忽略 */ } };
  const startHook = (id) => {
    jobId = id;
    if (signal && signal.aborted) cancelJob(id);
    if (onStart) { try { onStart(id); } catch { /* 调用方回调出错不影响任务 */ } }
  };
  const progressHook = typeof onProgress === 'function'
    ? (p) => { try { onProgress(flattenProgress(p, started)); } catch { /* 同上 */ } }
    : undefined;
  let res;
  try {
    const pending = api.job('ai:run', payload, progressHook, startHook);
    res = await raceAbort(pending, signal, () => { if (jobId) cancelJob(jobId); });
  } catch (err) {
    if (isNoAI(err)) {
      const msg = cleanMessage(err && err.message);
      throw new NoAIError(msg || undefined);
    }
    if (isCancelled(err) || (signal && signal.aborted)) throw cancelledError();
    throw friendly(err, task);
  }
  const data = res && typeof res === 'object' && 'data' in res ? res.data : res;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${TASK_LABELS[task] || 'AI'}返回的内容不是有效的 JSON 对象，请重试`);
  }
  const out = {
    data,
    provider: (res && res.provider) || 'unknown',
    model: (res && res.model) || '',
    ms: (res && Number.isFinite(res.ms)) ? res.ms : Date.now() - started,
  };
  // 只在主进程给了时才带上，保持旧结果结构不变
  if (res && res.usage && typeof res.usage === 'object') out.usage = res.usage;
  if (res && Number(res.attempts) > 1) out.attempts = Number(res.attempts);
  return out;
}

/**
 * 便捷封装：先试 AI，没有 AI（NoAIError）时调用本地回退。其他错误照常抛出。
 * @returns {Promise<{result:any, provider:string, fallback:boolean, model?:string, ms?:number}>}
 */
export async function runWithFallback(request, parse, fallback, hooks) {
  try {
    const r = await runAI(request, hooks);
    return { result: parse(r.data), provider: r.provider, model: r.model, ms: r.ms, fallback: false };
  } catch (err) {
    if (!isNoAI(err) || typeof fallback !== 'function') throw err;
    return { result: await fallback(err), provider: 'local', fallback: true };
  }
}
