'use strict';
// 字节跳动 Seedance（火山方舟 Ark）。Bearer 鉴权，模型名可覆盖（设置里可填自己开通的模型名或接入点 ID）。
// 错误码对照火山方舟文档「错误码」（https://www.volcengine.com/docs/82379/1299023），翻译成大白话给用户看。
const { requestJson, trimSlash, clampDur, VideogenError, sleep } = require('./util.cjs');

const DEFAULT_BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_MODEL = 'doubao-seedance-1-0-pro-250528';
const base = (cfg) => trimSlash(cfg.baseUrl) || DEFAULT_BASE;
const auth = (cfg) => ({ Authorization: `Bearer ${cfg.key}` });
// 提交被限流 / 服务繁忙时的重试等待（毫秒）。网络超时不重试提交：服务商可能其实已经收到，重提会重复扣费
const SUBMIT_RETRY_DELAYS = [2000, 6000];
const ACTIVATE_HINT = '请在火山方舟控制台『开通管理』里开通 Seedance 视频模型';

// 先按错误码认，认不出再看英文说明
const BY_CODE = [
  [/^ModelNotOpen/i, () => `模型未开通：${ACTIVATE_HINT}`],
  [/^InvalidEndpointOrModel/i, () => `找不到这个模型：请检查「设置 → AI 视频生成」里的模型名，或${ACTIVATE_HINT}`],
  [/^AuthenticationError|^InvalidApiKey|^Unauthorized/i, () => '火山方舟 API Key 无效：请到火山方舟控制台『API Key 管理』复制完整的 Key，填到「设置 → AI 视频生成」'],
  [/Overdue/i, () => '火山方舟账户已欠费：请充值后重试'],
  [/^SetLimitExceeded/i, () => '已达到「安全体验模式」设置的用量上限：请在火山方舟控制台『开通管理』调高上限或关闭安全体验模式'],
  [/^QuotaExceeded/i, () => '额度已用完：免费额度用完后，需要在火山方舟控制台开通付费或充值才能继续生成'],
  [/PrivacyInformation/i, () => '参考图里可能有真人照片：服务商不允许直接用真人照片生成视频，请换一张参考图（插画、风景或 AI 生成的人像）'],
  [/^InputImageSensitive/i, () => '参考图可能含有敏感内容，被服务商拦截了：请换一张参考图'],
  [/^InputText\w*Sensitive|^SensitiveContentDetected/i, () => '画面描述里可能有敏感词，被服务商拦截了：请换个说法再试'],
  [/^Output\w*Sensitive/i, () => '生成的视频没通过服务商的内容审核：请调整画面描述后重试'],
  [/Sensitive/i, () => '内容可能涉及敏感信息，被服务商拦截了：请修改画面描述或参考图后重试'],
  [/RateLimit/i, () => '请求太频繁：火山方舟限制了同时生成的数量，请稍等一两分钟再试'],
  [/^ServerOverloaded|^InternalServiceError|^ServiceUnavailable/i, () => '火山方舟服务繁忙：请稍后重试'],
];
const BY_MESSAGE = [
  [/not (been )?activated|未开通/i, BY_CODE[0][1]],
  [/real person|真人/i, BY_CODE[6][1]],
  [/sensitive|敏感|审核/i, BY_CODE[10][1]],
  [/free trial|quota|额度/i, BY_CODE[5][1]],
  [/api ?key/i, BY_CODE[2][1]],
];

/**
 * 火山方舟错误 → 大白话。认不出返回 null（调用方保留原始说明）。
 * @param {string} [code] 错误码，如 ModelNotOpen、InputImageSensitiveContentDetected.PrivacyInformation
 * @param {string} [message] 服务商原始说明
 * @param {number} [status] HTTP 状态码
 */
function friendlyError(code, message, status) {
  const c = String(code || '');
  const m = String(message || '');
  for (const [re, f] of BY_CODE) if (c && re.test(c)) return f();
  for (const [re, f] of BY_MESSAGE) if (m && re.test(m)) return f();
  const st = Number(status) || 0;
  if (st === 401) return BY_CODE[2][1]();
  if (st === 403) return `没有权限使用这个模型：${ACTIVATE_HINT}，并确认 API Key 和开通模型的是同一个账号`;
  if (st === 402) return BY_CODE[3][1]();
  if (st === 429) return BY_CODE[11][1]();
  if (st >= 500) return BY_CODE[12][1]();
  return null;
}

/** 稍后重试可能成功的错误：限流、服务繁忙（额度用完、安全体验上限重试也没用） */
function isRetryable(code, status) {
  const c = String(code || '');
  if (/^QuotaExceeded|^SetLimitExceeded|Overdue/i.test(c)) return false;
  if (/RateLimit|^ServerOverloaded|^InternalServiceError|^ServiceUnavailable/i.test(c)) return true;
  const st = Number(status) || 0;
  return st === 429 || st >= 500;
}

/** requestJson 抛出的错误 → 带大白话说明的 VideogenError（保留 status / apiCode / 原始说明 detail） */
function arkError(e) {
  if (!e || e.code === 'CANCELLED' || e.code === 'NETWORK' || !e.status) return e;
  const body = e.body && typeof e.body === 'object' ? e.body : null;
  const apiErr = body ? (body.error && typeof body.error === 'object' ? body.error : body) : null;
  const code = e.apiCode || (apiErr && apiErr.code ? String(apiErr.code) : '');
  const raw = apiErr && apiErr.message ? String(apiErr.message) : '';
  const friendly = friendlyError(code, raw, e.status);
  const out = friendly ? new VideogenError(friendly, e.code || 'HTTP', e.status) : e;
  if (code) out.apiCode = code;
  if (raw) out.detail = raw;
  out.retryable = isRetryable(code, e.status);
  return out;
}

async function ark(fetch, url, opts) {
  try { return await requestJson(fetch, url, opts); } catch (e) { throw arkError(e); }
}

module.exports = {
  id: 'seedance',
  label: '即梦 Seedance（火山方舟）',
  vendor: '字节跳动',
  needs: ['key'],
  keyFields: { key: 'arkKey' },
  defaultModel: DEFAULT_MODEL,
  defaultBaseUrl: DEFAULT_BASE,
  caps: { text: true, image: true, durations: [5, 10], ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], res: ['480p', '720p', '1080p'] },
  priceHint: '约 ¥1.5–3.7 / 5 秒（按 token 计费）',
  keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  // 生成一般 30 秒到 3 分钟，高峰期会排队：查询间隔 4 秒起逐步拉长到 20 秒，最多等 20 分钟
  pollOpts: { interval: 4000, maxInterval: 20000, factor: 1.5, timeout: 20 * 60 * 1000 },
  friendlyError,

  buildBody(input, cfg) {
    const d = clampDur(Number(input.duration) || 5, this.caps.durations);
    const flags = [`--ratio ${input.ratio || '16:9'}`, `--duration ${d}`, `--resolution ${input.res || '720p'}`, '--watermark false'];
    const content = [{ type: 'text', text: `${input.prompt || ''} ${flags.join(' ')}`.trim() }];
    if (input.image) content.push({ type: 'image_url', image_url: { url: input.image } });
    return { model: cfg.model || DEFAULT_MODEL, content };
  },

  async submit(input, cfg, { fetch, signal, sleep: sleepFn = sleep }) {
    const body = this.buildBody(input, cfg);
    for (let i = 0; ; i++) {
      try {
        const r = await ark(fetch, `${base(cfg)}/contents/generations/tasks`, { method: 'POST', headers: auth(cfg), body, signal });
        if (!r || !r.id) throw new VideogenError('Seedance 未返回任务 ID');
        return { taskId: r.id };
      } catch (e) {
        // 只在明确被拒（限流 / 服务繁忙）时等一会儿重提
        if (!(e && e.retryable && e.code !== 'NETWORK') || i >= SUBMIT_RETRY_DELAYS.length) throw e;
        await sleepFn(SUBMIT_RETRY_DELAYS[i], signal);
      }
    }
  },

  parseStatus(r) {
    const s = String((r && r.status) || '').toLowerCase();
    if (s === 'succeeded') return { state: 'succeeded', progress: 1, url: r.content && r.content.video_url };
    if (s === 'failed' || s === 'cancelled' || s === 'expired') {
      const err = (r && r.error) || {};
      const raw = err.message ? String(err.message) : '';
      const friendly = s === 'failed' ? friendlyError(err.code, raw) : null;
      const fallback = s === 'cancelled' ? '任务已取消' : s === 'expired' ? '任务排队太久已过期，请重新生成' : '生成失败';
      const out = { state: 'failed', error: friendly || raw || fallback };
      if (err.code) out.code = String(err.code);
      return out;
    }
    if (s === 'running') return { state: 'running' };
    return { state: 'queued' };
  },

  async poll(taskId, cfg, { fetch, signal }) {
    try {
      return this.parseStatus(await ark(fetch, `${base(cfg)}/contents/generations/tasks/${encodeURIComponent(taskId)}`, { headers: auth(cfg), signal }));
    } catch (e) {
      if (e && e.status === 404 && !/Model|Endpoint/i.test(e.apiCode || '')) {
        throw new VideogenError('服务商那边找不到这个任务（可能已过期，任务只保留 7 天），请重新生成', 'GEN_FAILED', 404);
      }
      throw e;
    }
  },

  async cancel(taskId, cfg, { fetch, signal }) {
    await requestJson(fetch, `${base(cfg)}/contents/generations/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE', headers: auth(cfg), signal }).catch(() => {});
  },

  async fetchResult(taskId, cfg, deps, last) {
    if (!last || !last.url) throw new VideogenError('Seedance 未返回视频地址');
    return { url: last.url };
  },

  async test(cfg, { fetch, signal }) {
    await ark(fetch, `${base(cfg)}/contents/generations/tasks?page_num=1&page_size=1`, { headers: auth(cfg), signal });
    return { ok: true };
  },
};
