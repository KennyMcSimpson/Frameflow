'use strict';
// fal.ai 聚合（队列 API）。模型路径可填，例如 fal-ai/kling-video/v2.1/standard/text-to-video。
const { requestJson, trimSlash, VideogenError, b64url } = require('./util.cjs');

const DEFAULT_BASE = 'https://queue.fal.run';
const DEFAULT_MODEL = 'fal-ai/kling-video/v2.1/standard/text-to-video';
const DEFAULT_I2V = 'fal-ai/kling-video/v2.1/standard/image-to-video';
const base = (cfg) => trimSlash(cfg.baseUrl) || DEFAULT_BASE;
const auth = (cfg) => ({ Authorization: `Key ${cfg.key}` });
const appId = (model) => String(model).split('/').slice(0, 2).join('/');

function encodeTask(o) { return 'fal1.' + b64url(JSON.stringify(o)); }
function decodeTask(t) {
  const s = String(t || '');
  if (!s.startsWith('fal1.')) throw new VideogenError('fal 任务 ID 无效');
  return JSON.parse(Buffer.from(s.slice(5).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

module.exports = {
  id: 'fal',
  label: 'fal.ai 聚合',
  vendor: 'fal.ai',
  needs: ['key'],
  keyFields: { key: 'falKey' },
  defaultModel: DEFAULT_MODEL,
  defaultBaseUrl: DEFAULT_BASE,
  caps: { text: true, image: true, durations: [5, 10], ratios: ['16:9', '9:16', '1:1'], res: ['720p', '1080p'] },
  priceHint: '按所选模型计价（约 $0.25–1 / 5 秒）',
  keyUrl: 'https://fal.ai/dashboard/keys',
  encodeTask,
  decodeTask,

  modelFor(input, cfg) {
    if (cfg.model) return cfg.model.replace(/^\/+|\/+$/g, '');
    return input.image ? DEFAULT_I2V : DEFAULT_MODEL;
  },

  buildBody(input) {
    const body = { prompt: input.prompt || '', duration: String(Number(input.duration) >= 8 ? 10 : 5), aspect_ratio: input.ratio || '16:9' };
    if (input.negative) body.negative_prompt = input.negative;
    if (input.image) body.image_url = input.image;
    return body;
  },

  async submit(input, cfg, { fetch, signal }) {
    const model = this.modelFor(input, cfg);
    const r = await requestJson(fetch, `${base(cfg)}/${model}`, { method: 'POST', headers: auth(cfg), body: this.buildBody(input), signal });
    if (!r || !r.request_id) throw new VideogenError('fal 未返回任务 ID');
    const app = appId(model);
    return { taskId: encodeTask({ id: r.request_id, s: r.status_url || `${base(cfg)}/${app}/requests/${r.request_id}/status`, r: r.response_url || `${base(cfg)}/${app}/requests/${r.request_id}` }) };
  },

  parseStatus(r) {
    const s = String((r && r.status) || '');
    if (s === 'COMPLETED') return r.error ? { state: 'failed', error: String(r.error) } : { state: 'succeeded', progress: 1 };
    if (s === 'IN_PROGRESS') return { state: 'running' };
    if (s === 'FAILED' || s === 'ERROR') return { state: 'failed', error: r.error || '生成失败' };
    return { state: 'queued' };
  },

  async poll(taskId, cfg, { fetch, signal }) {
    const t = decodeTask(taskId);
    return this.parseStatus(await requestJson(fetch, t.s, { headers: auth(cfg), signal }));
  },

  async cancel(taskId, cfg, { fetch, signal }) {
    const t = decodeTask(taskId);
    await requestJson(fetch, `${t.r}/cancel`, { method: 'PUT', headers: auth(cfg), signal }).catch(() => {});
  },

  parseResult(r) {
    const url = (r && r.video && r.video.url) || (r && Array.isArray(r.videos) && r.videos[0] && r.videos[0].url) || (r && r.output && r.output.video && r.output.video.url);
    if (!url) throw new VideogenError('fal 结果中没有视频地址');
    return { url };
  },

  async fetchResult(taskId, cfg, { fetch, signal }) {
    const t = decodeTask(taskId);
    return this.parseResult(await requestJson(fetch, t.r, { headers: auth(cfg), signal }));
  },

  async test(cfg, { fetch, signal }) {
    // 查询一个不存在的请求：401/403 说明密钥错误，其余（404 等）说明密钥可用
    try {
      await requestJson(fetch, `${base(cfg)}/fal-ai/fast-sdxl/requests/00000000-0000-0000-0000-000000000000/status`, { headers: auth(cfg), signal });
    } catch (e) { if (e.code === 'AUTH' || e.code === 'NETWORK' || e.code === 'CANCELLED') throw e; }
    return { ok: true };
  },
};
