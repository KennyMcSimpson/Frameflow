'use strict';
// 快手可灵 Kling。AccessKey/SecretKey 自签 HS256 JWT（30 分钟有效）。
const { requestJson, trimSlash, clampDur, jwtHS256, splitDataUrl, VideogenError } = require('./util.cjs');

const DEFAULT_BASE = 'https://api-beijing.klingai.com';
const DEFAULT_MODEL = 'kling-v2-1';
const base = (cfg) => trimSlash(cfg.baseUrl) || DEFAULT_BASE;

function token(cfg, now = Math.floor(Date.now() / 1000)) {
  if (!cfg.ak || !cfg.sk) throw new VideogenError('可灵需要同时填写 AccessKey 和 SecretKey', 'NO_KEY');
  return jwtHS256({ iss: cfg.ak, exp: now + 1800, nbf: now - 5 }, cfg.sk);
}
const auth = (cfg) => ({ Authorization: `Bearer ${token(cfg)}` });

function ensureOk(r) {
  if (!r || (r.code !== undefined && r.code !== 0)) throw new VideogenError(`可灵返回错误：${(r && r.message) || '未知错误'}（code ${r && r.code}）`);
  return r.data || {};
}

module.exports = {
  id: 'kling',
  label: '可灵 Kling',
  vendor: '快手',
  needs: ['ak', 'sk'],
  keyFields: { ak: 'klingAk', sk: 'klingSk' },
  defaultModel: DEFAULT_MODEL,
  defaultBaseUrl: DEFAULT_BASE,
  caps: { text: true, image: true, durations: [5, 10], ratios: ['16:9', '9:16', '1:1'], res: ['720p', '1080p'] },
  priceHint: '约 ¥1–3.5 / 5 秒（标准/高品质模式）',
  keyUrl: 'https://app.klingai.com/cn/dev/console/application',
  token,

  buildBody(input, cfg) {
    const body = {
      model_name: cfg.model || DEFAULT_MODEL,
      prompt: input.prompt || '',
      negative_prompt: input.negative || undefined,
      duration: String(clampDur(Number(input.duration) || 5, this.caps.durations)),
      mode: input.res === '1080p' ? 'pro' : 'std',
    };
    if (input.image) {
      const d = splitDataUrl(input.image);
      body.image = d ? d.base64 : input.image;
    } else body.aspect_ratio = input.ratio || '16:9';
    return body;
  },

  async submit(input, cfg, { fetch, signal }) {
    const kind = input.image ? 'image2video' : 'text2video';
    const data = ensureOk(await requestJson(fetch, `${base(cfg)}/v1/videos/${kind}`, { method: 'POST', headers: auth(cfg), body: this.buildBody(input, cfg), signal }));
    if (!data.task_id) throw new VideogenError('可灵未返回任务 ID');
    return { taskId: `${kind}:${data.task_id}` };
  },

  parseStatus(r) {
    const d = ensureOk(r);
    const s = d.task_status;
    if (s === 'succeed') {
      const v = d.task_result && d.task_result.videos && d.task_result.videos[0];
      return { state: 'succeeded', progress: 1, url: v && v.url };
    }
    if (s === 'failed') return { state: 'failed', error: d.task_status_msg || '生成失败' };
    if (s === 'processing') return { state: 'running' };
    return { state: 'queued' };
  },

  async poll(taskId, cfg, { fetch, signal }) {
    const s = String(taskId == null ? '' : taskId);
    const idx = s.indexOf(':');
    const kind = idx >= 0 ? s.slice(0, idx) : 'text2video';
    const id = idx >= 0 ? s.slice(idx + 1) : s;
    if ((kind !== 'text2video' && kind !== 'image2video') || !id || !id.trim()) {
      throw new VideogenError('非法的任务标识', 'BAD_TASK');
    }
    return this.parseStatus(await requestJson(fetch, `${base(cfg)}/v1/videos/${kind}/${encodeURIComponent(id)}`, { headers: auth(cfg), signal }));
  },

  async fetchResult(taskId, cfg, deps, last) {
    if (!last || !last.url) throw new VideogenError('可灵未返回视频地址');
    return { url: last.url };
  },

  async test(cfg, { fetch, signal }) {
    ensureOk(await requestJson(fetch, `${base(cfg)}/v1/videos/text2video?pageNum=1&pageSize=1`, { headers: auth(cfg), signal }));
    return { ok: true };
  },
};
