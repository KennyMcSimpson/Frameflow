'use strict';
// OpenAI Sora 2（/v1/videos）。未单独填写时复用 OpenAI 兼容接口的 Key。
const { requestJson, trimSlash, clampDur, splitDataUrl, VideogenError, httpMessage, cancelled } = require('./util.cjs');

const DEFAULT_BASE = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'sora-2';
const base = (cfg) => trimSlash(cfg.baseUrl) || DEFAULT_BASE;
const auth = (cfg) => ({ Authorization: `Bearer ${cfg.key}` });
const SIZE = { '16:9': '1280x720', '9:16': '720x1280' };

module.exports = {
  id: 'sora',
  label: 'OpenAI Sora 2',
  vendor: 'OpenAI',
  needs: ['key'],
  keyFields: { key: 'soraKey', fallback: 'openaiKey' },
  defaultModel: DEFAULT_MODEL,
  defaultBaseUrl: DEFAULT_BASE,
  caps: { text: true, image: true, durations: [4, 8, 12], ratios: ['16:9', '9:16'], res: ['720p'] },
  priceHint: '约 $0.1 / 秒（sora-2）',
  keyUrl: 'https://platform.openai.com/api-keys',

  buildFields(input, cfg) {
    return { model: cfg.model || DEFAULT_MODEL, prompt: input.prompt || '', seconds: String(clampDur(Number(input.duration) || 4, this.caps.durations)), size: SIZE[input.ratio] || SIZE['16:9'] };
  },

  async submit(input, cfg, { fetch, signal }) {
    const fields = this.buildFields(input, cfg);
    const d = splitDataUrl(input.image);
    let r;
    if (d) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      fd.append('input_reference', new Blob([Buffer.from(d.base64, 'base64')], { type: d.mime }), 'reference.' + (d.mime.split('/')[1] || 'png'));
      let res;
      let text;
      try {
        res = await fetch(`${base(cfg)}/videos`, { method: 'POST', headers: auth(cfg), body: fd, signal });
        text = await res.text();
      } catch (e) {
        if (signal && signal.aborted) throw cancelled();
        const err = new VideogenError(`网络连接失败：${e.message || e}`, 'NETWORK');
        err.retryable = true;
        throw err;
      }
      try { r = JSON.parse(text); } catch { r = text; }
      if (!res.ok) throw new VideogenError(httpMessage(res.status, r), res.status === 401 || res.status === 403 ? 'AUTH' : 'HTTP', res.status);
    } else {
      r = await requestJson(fetch, `${base(cfg)}/videos`, { method: 'POST', headers: auth(cfg), body: fields, signal });
    }
    if (!r || !r.id) throw new VideogenError('Sora 未返回任务 ID');
    return { taskId: r.id };
  },

  parseStatus(r) {
    const s = String((r && r.status) || '');
    const p = Number(r && r.progress);
    if (s === 'completed') return { state: 'succeeded', progress: 1 };
    if (s === 'failed') return { state: 'failed', error: (r.error && r.error.message) || '生成失败' };
    if (s === 'in_progress') return { state: 'running', progress: Number.isFinite(p) ? p / 100 : 0 };
    return { state: 'queued' };
  },

  async poll(taskId, cfg, { fetch, signal }) {
    return this.parseStatus(await requestJson(fetch, `${base(cfg)}/videos/${encodeURIComponent(taskId)}`, { headers: auth(cfg), signal }));
  },

  async fetchResult(taskId, cfg) {
    return { url: `${base(cfg)}/videos/${encodeURIComponent(taskId)}/content`, headers: auth(cfg) };
  },

  async test(cfg, { fetch, signal }) {
    await requestJson(fetch, `${base(cfg)}/models`, { headers: auth(cfg), signal });
    return { ok: true };
  },
};
