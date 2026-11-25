'use strict';
// Runway Gen-4。需要 X-Runway-Version 头。
const { requestJson, trimSlash, clampDur, VideogenError } = require('./util.cjs');

const DEFAULT_BASE = 'https://api.dev.runwayml.com';
const VERSION = '2024-11-06';
const base = (cfg) => trimSlash(cfg.baseUrl) || DEFAULT_BASE;
const auth = (cfg) => ({ Authorization: `Bearer ${cfg.key}`, 'X-Runway-Version': VERSION });
const RATIO = { '16:9': '1280:720', '9:16': '720:1280', '1:1': '960:960', '4:3': '1104:832', '3:4': '832:1104', '21:9': '1584:672' };

module.exports = {
  id: 'runway',
  label: 'Runway Gen-4',
  vendor: 'Runway',
  needs: ['key'],
  keyFields: { key: 'runwayKey' },
  defaultModel: 'gen4_turbo',
  defaultBaseUrl: DEFAULT_BASE,
  VERSION,
  caps: { text: true, image: true, durations: [5, 10], ratios: Object.keys(RATIO), res: ['720p'] },
  priceHint: '约 $0.25–0.5 / 5 秒',
  keyUrl: 'https://dev.runwayml.com/',

  buildBody(input, cfg) {
    const body = { promptText: input.prompt || '', ratio: RATIO[input.ratio] || RATIO['16:9'], duration: clampDur(Number(input.duration) || 5, this.caps.durations) };
    if (input.image) { body.model = cfg.model || 'gen4_turbo'; body.promptImage = input.image; }
    else body.model = cfg.model || 'gen4.5';
    return body;
  },

  async submit(input, cfg, { fetch, signal }) {
    const ep = input.image ? 'image_to_video' : 'text_to_video';
    const r = await requestJson(fetch, `${base(cfg)}/v1/${ep}`, { method: 'POST', headers: auth(cfg), body: this.buildBody(input, cfg), signal });
    if (!r || !r.id) throw new VideogenError('Runway 未返回任务 ID');
    return { taskId: r.id };
  },

  parseStatus(r) {
    const s = String((r && r.status) || '');
    if (s === 'SUCCEEDED') return { state: 'succeeded', progress: 1, url: Array.isArray(r.output) ? r.output[0] : null };
    if (s === 'FAILED' || s === 'CANCELLED') return { state: 'failed', error: r.failure || (s === 'CANCELLED' ? '任务已取消' : '生成失败') };
    if (s === 'RUNNING') return { state: 'running', progress: Number(r.progress) || 0 };
    return { state: 'queued' };
  },

  async poll(taskId, cfg, { fetch, signal }) {
    return this.parseStatus(await requestJson(fetch, `${base(cfg)}/v1/tasks/${encodeURIComponent(taskId)}`, { headers: auth(cfg), signal }));
  },

  async cancel(taskId, cfg, { fetch, signal }) {
    await requestJson(fetch, `${base(cfg)}/v1/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE', headers: auth(cfg), signal }).catch(() => {});
  },

  async fetchResult(taskId, cfg, deps, last) {
    if (!last || !last.url) throw new VideogenError('Runway 未返回视频地址');
    return { url: last.url };
  },

  async test(cfg, { fetch, signal }) {
    await requestJson(fetch, `${base(cfg)}/v1/organization`, { headers: auth(cfg), signal });
    return { ok: true };
  },
};
