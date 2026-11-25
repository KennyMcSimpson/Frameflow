'use strict';
// 演示用 provider：无需密钥，返回本地样例 mp4（供 e2e 与无 key 演示）。
const fs = require('node:fs');
const { VideogenError } = require('./util.cjs');

const tasks = new Map(); // taskId -> {created, input, polls}

module.exports = {
  id: 'mock',
  label: '演示模式',
  vendor: '镜流',
  needs: [],
  keyFields: {},
  defaultModel: 'mock',
  defaultBaseUrl: '',
  caps: { text: true, image: true, durations: [4, 5, 6, 8, 10], ratios: ['16:9', '9:16', '1:1'], res: ['720p'] },
  priceHint: '免费 · 仅演示，返回内置实拍样例',
  keyUrl: '',
  isMock: true,

  async submit(input) {
    const taskId = 'mock_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    tasks.set(taskId, { created: Date.now(), input: { ...input, image: input.image ? '[image]' : undefined }, polls: 0 });
    return { taskId };
  },

  async poll(taskId, cfg, deps = {}) {
    const t = tasks.get(taskId) || { created: 0, polls: 0 };
    t.polls += 1;
    tasks.set(taskId, t);
    const need = Number.isFinite(deps.mockPolls) ? deps.mockPolls : 2;
    if (t.polls >= need) return { state: 'succeeded', progress: 1 };
    return { state: t.polls === 1 ? 'queued' : 'running', progress: t.polls / need };
  },

  async cancel(taskId) { tasks.delete(taskId); },

  /** deps.mockSource(input, taskId) 由 IPC 层提供，返回本地 mp4 路径 */
  async fetchResult(taskId, cfg, deps = {}) {
    const t = tasks.get(taskId);
    const src = deps.mockSource ? await deps.mockSource(t ? t.input : {}, taskId) : null;
    if (!src || !fs.existsSync(src)) throw new VideogenError('没有可用的演示样例视频', 'NO_SAMPLE');
    tasks.delete(taskId);
    return { localPath: src };
  },

  async test() { return { ok: true }; },
};
