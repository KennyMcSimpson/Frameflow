'use strict';
// fal.ai 聚合（队列 API）。模型路径可填，例如 fal-ai/kling-video/v2.1/standard/text-to-video。
const { requestJson, trimSlash, VideogenError, b64url } = require('./util.cjs');
const { isTrustedHostForBase } = require('../urlSafety.cjs');

const DEFAULT_BASE = 'https://queue.fal.run';
const DEFAULT_MODEL = 'fal-ai/kling-video/v2.1/standard/text-to-video';
const DEFAULT_I2V = 'fal-ai/kling-video/v2.1/standard/image-to-video';
const OFFICIAL_FAL_HOSTS = ['queue.fal.run', 'rest.fal.run'];
const OFFICIAL_FAL_HOST_SET = new Set(OFFICIAL_FAL_HOSTS);
const base = (cfg) => trimSlash(cfg && cfg.baseUrl) || DEFAULT_BASE;
const auth = (cfg) => ({ Authorization: `Key ${cfg.key}` });
const appId = (model) => String(model).split('/').slice(0, 2).join('/');

function assertTrustedUrl(url, cfg, label) {
  if (typeof url !== 'string' || !url) {
    throw new VideogenError(`fal ${label || '任务'}地址不受信任或格式无效`, 'UNTRUSTED_URL');
  }
  let u;
  let b;
  try {
    u = new URL(url);
    b = new URL(base(cfg));
  } catch {
    throw new VideogenError(`fal ${label || '任务'}地址不受信任或格式无效`, 'UNTRUSTED_URL');
  }
  if (u.username || u.password) {
    throw new VideogenError(`fal ${label || '任务'}地址不受信任或格式无效`, 'UNTRUSTED_URL');
  }
  const baseHost = b.hostname.toLowerCase().replace(/\.+$/, '');
  const targetHost = u.hostname.toLowerCase().replace(/\.+$/, '');
  const isOfficialBase = b.protocol === 'https:' && !b.port && OFFICIAL_FAL_HOST_SET.has(baseHost);
  let trusted = false;
  if (isOfficialBase) {
    // 仅在官方队列/REST 域名下放行精确的 queue.fal.run / rest.fal.run（HTTPS 默认端口），拒绝第三方 *.fal.run 子域
    trusted = u.protocol === 'https:' && !u.port && OFFICIAL_FAL_HOST_SET.has(targetHost)
      && isTrustedHostForBase(url, base(cfg), OFFICIAL_FAL_HOSTS);
  } else {
    // 自定义代理 baseUrl：仅信任与 base(cfg) 精确同源的地址
    trusted = (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === b.origin
      && isTrustedHostForBase(url, base(cfg), []);
  }
  if (!trusted) {
    throw new VideogenError(`fal ${label || '任务'}地址不受信任或格式无效`, 'UNTRUSTED_URL');
  }
  return url;
}

function encodeTask(o) { return 'fal1.' + b64url(JSON.stringify(o)); }
function decodeTask(t, cfg) {
  const s = String(t || '');
  if (!s.startsWith('fal1.')) throw new VideogenError('fal 任务 ID 无效', 'BAD_TASK');
  let obj;
  try {
    obj = JSON.parse(Buffer.from(s.slice(5).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    throw new VideogenError('fal 任务 ID 解析失败', 'BAD_TASK');
  }
  if (!obj || typeof obj !== 'object') throw new VideogenError('fal 任务 ID 无效', 'BAD_TASK');
  assertTrustedUrl(obj.s, cfg, '状态查询');
  assertTrustedUrl(obj.r, cfg, '结果查询');
  return obj;
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
    const statusUrl = assertTrustedUrl(r.status_url || `${base(cfg)}/${app}/requests/${r.request_id}/status`, cfg, '状态查询');
    const responseUrl = assertTrustedUrl(r.response_url || `${base(cfg)}/${app}/requests/${r.request_id}`, cfg, '结果查询');
    return { taskId: encodeTask({ id: r.request_id, s: statusUrl, r: responseUrl }) };
  },

  parseStatus(r) {
    const s = String((r && r.status) || '');
    if (s === 'COMPLETED') return r.error ? { state: 'failed', error: String(r.error) } : { state: 'succeeded', progress: 1 };
    if (s === 'IN_PROGRESS') return { state: 'running' };
    if (s === 'FAILED' || s === 'ERROR') return { state: 'failed', error: r.error || '生成失败' };
    return { state: 'queued' };
  },

  async poll(taskId, cfg, { fetch, signal }) {
    const t = decodeTask(taskId, cfg);
    assertTrustedUrl(t.s, cfg, '状态查询');
    return this.parseStatus(await requestJson(fetch, t.s, { headers: auth(cfg), signal }));
  },

  async cancel(taskId, cfg, { fetch, signal }) {
    const t = decodeTask(taskId, cfg);
    const cancelUrl = assertTrustedUrl(`${trimSlash(t.r)}/cancel`, cfg, '取消');
    await requestJson(fetch, cancelUrl, { method: 'PUT', headers: auth(cfg), signal }).catch(() => {});
  },

  parseResult(r) {
    const url = (r && r.video && r.video.url) || (r && Array.isArray(r.videos) && r.videos[0] && r.videos[0].url) || (r && r.output && r.output.video && r.output.video.url);
    if (!url) throw new VideogenError('fal 结果中没有视频地址');
    return { url };
  },

  async fetchResult(taskId, cfg, { fetch, signal }) {
    const t = decodeTask(taskId, cfg);
    assertTrustedUrl(t.r, cfg, '结果查询');
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
