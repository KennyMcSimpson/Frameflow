'use strict';
// Google Veo（Gemini API predictLongRunning）。
const { requestJson, trimSlash, splitDataUrl, VideogenError } = require('./util.cjs');

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'veo-3.1-fast-generate-preview';
const base = (cfg) => trimSlash(cfg.baseUrl) || DEFAULT_BASE;
const auth = (cfg) => ({ 'x-goog-api-key': cfg.key });

module.exports = {
  id: 'veo',
  label: 'Google Veo',
  vendor: 'Google',
  needs: ['key'],
  keyFields: { key: 'geminiKey' },
  defaultModel: DEFAULT_MODEL,
  defaultBaseUrl: DEFAULT_BASE,
  caps: { text: true, image: true, durations: [8], ratios: ['16:9', '9:16'], res: ['720p', '1080p'] },
  priceHint: '约 $0.15–0.4 / 秒（含声音）',
  keyUrl: 'https://aistudio.google.com/apikey',

  buildBody(input) {
    const inst = { prompt: input.prompt || '' };
    const d = splitDataUrl(input.image);
    if (d) inst.image = { bytesBase64Encoded: d.base64, mimeType: d.mime };
    const parameters = { aspectRatio: input.ratio === '9:16' ? '9:16' : '16:9' };
    if (input.negative) parameters.negativePrompt = input.negative;
    if (input.res === '1080p' && parameters.aspectRatio === '16:9') parameters.resolution = '1080p';
    return { instances: [inst], parameters };
  },

  async submit(input, cfg, { fetch, signal }) {
    const model = cfg.model || DEFAULT_MODEL;
    const r = await requestJson(fetch, `${base(cfg)}/models/${encodeURIComponent(model)}:predictLongRunning`, { method: 'POST', headers: auth(cfg), body: this.buildBody(input), signal });
    if (!r || !r.name) throw new VideogenError('Veo 未返回任务 ID');
    return { taskId: r.name };
  },

  parseStatus(r) {
    if (r && r.error) return { state: 'failed', error: r.error.message || '生成失败' };
    if (!r || !r.done) return { state: 'running' };
    const resp = r.response && (r.response.generateVideoResponse || r.response);
    const sample = resp && (resp.generatedSamples || resp.generatedVideos || [])[0];
    const uri = sample && sample.video && sample.video.uri;
    if (!uri) {
      const filtered = resp && resp.raiMediaFilteredReasons;
      return { state: 'failed', error: filtered ? `内容被安全策略拦截：${[].concat(filtered).join('；')}` : 'Veo 未返回视频' };
    }
    return { state: 'succeeded', progress: 1, url: uri };
  },

  async poll(taskId, cfg, { fetch, signal }) {
    return this.parseStatus(await requestJson(fetch, `${base(cfg)}/${String(taskId).replace(/^\/+/, '')}`, { headers: auth(cfg), signal }));
  },

  async fetchResult(taskId, cfg, deps, last) {
    if (!last || !last.url) throw new VideogenError('Veo 未返回视频地址');
    return { url: last.url, headers: auth(cfg) };
  },

  async test(cfg, { fetch, signal }) {
    await requestJson(fetch, `${base(cfg)}/models?pageSize=1`, { headers: auth(cfg), signal });
    return { ok: true };
  },
};
