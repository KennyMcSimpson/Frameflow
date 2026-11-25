'use strict';
// Luma Dream Machine（Ray 2）。参考图只接受公网 URL。
const { requestJson, trimSlash, clampDur, VideogenError } = require('./util.cjs');

const DEFAULT_BASE = 'https://api.lumalabs.ai/dream-machine/v1';
const DEFAULT_MODEL = 'ray-2';
const base = (cfg) => trimSlash(cfg.baseUrl) || DEFAULT_BASE;
const auth = (cfg) => ({ Authorization: `Bearer ${cfg.key}` });

module.exports = {
  id: 'luma',
  label: 'Luma Ray 2',
  vendor: 'Luma AI',
  needs: ['key'],
  keyFields: { key: 'lumaKey' },
  defaultModel: DEFAULT_MODEL,
  defaultBaseUrl: DEFAULT_BASE,
  caps: { text: true, image: false, imageUrlOnly: true, durations: [5, 9], ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], res: ['540p', '720p', '1080p'] },
  priceHint: '约 $0.4–1.6 / 5 秒',
  keyUrl: 'https://lumalabs.ai/dream-machine/api/keys',

  buildBody(input, cfg) {
    const body = { prompt: input.prompt || '', model: cfg.model || DEFAULT_MODEL, aspect_ratio: input.ratio || '16:9', duration: `${clampDur(Number(input.duration) || 5, this.caps.durations)}s`, resolution: input.res || '720p' };
    if (input.image && /^https?:/.test(input.image)) body.keyframes = { frame0: { type: 'image', url: input.image } };
    return body;
  },

  async submit(input, cfg, { fetch, signal }) {
    const r = await requestJson(fetch, `${base(cfg)}/generations`, { method: 'POST', headers: auth(cfg), body: this.buildBody(input, cfg), signal });
    if (!r || !r.id) throw new VideogenError('Luma 未返回任务 ID');
    return { taskId: r.id };
  },

  parseStatus(r) {
    const s = String((r && r.state) || '');
    if (s === 'completed') return { state: 'succeeded', progress: 1, url: r.assets && r.assets.video };
    if (s === 'failed') return { state: 'failed', error: r.failure_reason || '生成失败' };
    if (s === 'dreaming') return { state: 'running' };
    return { state: 'queued' };
  },

  async poll(taskId, cfg, { fetch, signal }) {
    return this.parseStatus(await requestJson(fetch, `${base(cfg)}/generations/${encodeURIComponent(taskId)}`, { headers: auth(cfg), signal }));
  },

  async cancel(taskId, cfg, { fetch, signal }) {
    await requestJson(fetch, `${base(cfg)}/generations/${encodeURIComponent(taskId)}`, { method: 'DELETE', headers: auth(cfg), signal }).catch(() => {});
  },

  async fetchResult(taskId, cfg, deps, last) {
    if (!last || !last.url) throw new VideogenError('Luma 未返回视频地址');
    return { url: last.url };
  },

  async test(cfg, { fetch, signal }) {
    await requestJson(fetch, `${base(cfg)}/generations?limit=1`, { headers: auth(cfg), signal });
    return { ok: true };
  },
};
