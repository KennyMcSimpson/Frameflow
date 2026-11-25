'use strict';
// Google Veo（Gemini API predictLongRunning）。
const { requestJson, trimSlash, splitDataUrl, VideogenError } = require('./util.cjs');

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'veo-3.1-fast-generate-preview';
const base = (cfg) => trimSlash(cfg && cfg.baseUrl) || DEFAULT_BASE;
const auth = (cfg) => ({ 'x-goog-api-key': cfg.key });

function validateTaskId(taskId) {
  const raw = String(taskId || '');
  if (!raw || /\s/.test(raw)) throw new VideogenError('Veo 任务 ID 无效', 'BAD_TASK');
  if (/[?#\\]/.test(raw) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) || raw.startsWith('//')) {
    throw new VideogenError('Veo 任务 ID 无效', 'BAD_TASK');
  }
  const clean = raw.replace(/^\/+/, '');
  if (!clean || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(clean)) throw new VideogenError('Veo 任务 ID 无效', 'BAD_TASK');
  let decoded;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    throw new VideogenError('Veo 任务 ID 编码无效', 'BAD_TASK');
  }
  if (/\s|[?#\\]/.test(decoded) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(decoded)) {
    throw new VideogenError('Veo 任务 ID 无效', 'BAD_TASK');
  }
  const segs = decoded.split('/');
  if (segs.some((s) => !s || s === '.' || s === '..')) {
    throw new VideogenError('Veo 任务 ID 包含非法路径', 'BAD_TASK');
  }
  return clean;
}

function isSameOriginAsBase(urlStr, cfg) {
  try {
    const target = new URL(String(urlStr || ''));
    const b = new URL(base(cfg));
    return (target.protocol === 'http:' || target.protocol === 'https:') && target.origin === b.origin;
  } catch {
    return false;
  }
}

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
    return { taskId: validateTaskId(r.name) };
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
    const cleanId = validateTaskId(taskId);
    const url = `${base(cfg)}/${cleanId}`;
    if (!isSameOriginAsBase(url, cfg)) throw new VideogenError('Veo 任务查询地址不受信任', 'UNTRUSTED_URL');
    return this.parseStatus(await requestJson(fetch, url, { headers: auth(cfg), signal }));
  },

  async fetchResult(taskId, cfg, deps, last) {
    if (!last || !last.url) throw new VideogenError('Veo 未返回视频地址');
    return isSameOriginAsBase(last.url, cfg) ? { url: last.url, headers: auth(cfg) } : { url: last.url };
  },

  async test(cfg, { fetch, signal }) {
    await requestJson(fetch, `${base(cfg)}/models?pageSize=1`, { headers: auth(cfg), signal });
    return { ok: true };
  },
};
