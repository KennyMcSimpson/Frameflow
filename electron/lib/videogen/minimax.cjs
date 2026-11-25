'use strict';
// MiniMax 海螺 Hailuo。三步：提交 → 查询得到 file_id → files/retrieve 取下载地址。
const { requestJson, trimSlash, clampDur, VideogenError } = require('./util.cjs');

const DEFAULT_BASE = 'https://api.minimaxi.com';
const DEFAULT_MODEL = 'MiniMax-Hailuo-02';
const base = (cfg) => trimSlash(cfg.baseUrl) || DEFAULT_BASE;
const auth = (cfg) => ({ Authorization: `Bearer ${cfg.key}` });

function checkBase(r) {
  const b = r && r.base_resp;
  if (b && b.status_code && b.status_code !== 0) throw new VideogenError(`MiniMax 返回错误：${b.status_msg || '未知错误'}（${b.status_code}）`, b.status_code === 1004 ? 'AUTH' : 'HTTP');
  return r;
}

module.exports = {
  id: 'minimax',
  label: '海螺 Hailuo（MiniMax）',
  vendor: 'MiniMax',
  needs: ['key'],
  keyFields: { key: 'minimaxKey' },
  defaultModel: DEFAULT_MODEL,
  defaultBaseUrl: DEFAULT_BASE,
  caps: { text: true, image: true, durations: [6, 10], ratios: ['16:9'], res: ['768p', '1080p'] },
  priceHint: '约 ¥2–3.5 / 6 秒',
  keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',

  buildBody(input, cfg) {
    const body = { model: cfg.model || DEFAULT_MODEL, prompt: input.prompt || '', duration: clampDur(Number(input.duration) || 6, this.caps.durations), resolution: input.res === '1080p' ? '1080P' : '768P' };
    if (input.image) body.first_frame_image = input.image;
    return body;
  },

  async submit(input, cfg, { fetch, signal }) {
    const r = checkBase(await requestJson(fetch, `${base(cfg)}/v1/video_generation`, { method: 'POST', headers: auth(cfg), body: this.buildBody(input, cfg), signal }));
    if (!r.task_id) throw new VideogenError('MiniMax 未返回任务 ID');
    return { taskId: r.task_id };
  },

  parseStatus(r) {
    checkBase(r);
    const s = String(r.status || '');
    if (s === 'Success') return { state: 'succeeded', progress: 1, fileId: r.file_id };
    if (s === 'Fail') return { state: 'failed', error: (r.base_resp && r.base_resp.status_msg) || '生成失败' };
    if (s === 'Processing') return { state: 'running' };
    return { state: 'queued' };
  },

  async poll(taskId, cfg, { fetch, signal }) {
    return this.parseStatus(await requestJson(fetch, `${base(cfg)}/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`, { headers: auth(cfg), signal }));
  },

  async fetchResult(taskId, cfg, { fetch, signal }, last) {
    if (!last || !last.fileId) throw new VideogenError('MiniMax 未返回文件 ID');
    const r = checkBase(await requestJson(fetch, `${base(cfg)}/v1/files/retrieve?file_id=${encodeURIComponent(last.fileId)}`, { headers: auth(cfg), signal }));
    const url = r.file && r.file.download_url;
    if (!url) throw new VideogenError('MiniMax 未返回下载地址');
    return { url };
  },

  async test(cfg, { fetch, signal }) {
    // 查询一个不存在的任务：鉴权失败会报 1004/401，其余视为连通
    try {
      checkBase(await requestJson(fetch, `${base(cfg)}/v1/query/video_generation?task_id=0`, { headers: auth(cfg), signal }));
    } catch (e) { if (e.code === 'AUTH' || e.code === 'NETWORK' || e.code === 'CANCELLED') throw e; }
    return { ok: true };
  },
};
