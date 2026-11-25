'use strict';
// AI 真人视频生成：provider 注册表 + 配置解析 + 通用执行流程（提交 → 轮询 → 取结果）。
const util = require('./util.cjs');

const PROVIDERS = ['seedance', 'kling', 'minimax', 'runway', 'veo', 'sora', 'luma', 'fal', 'mock'].map((id) => require(`./${id}.cjs`));
const BY_ID = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));

function getProvider(id) {
  const p = BY_ID[id];
  if (!p) throw new util.VideogenError(`未知的视频生成服务：${id}`, 'BAD_PROVIDER');
  return p;
}

/** 从 settings 存储（getSecret/get）解析某个 provider 的配置 */
function resolveConfig(settings, id) {
  const p = getProvider(id);
  const vg = (settings.get && settings.get().videogen) || {};
  const ov = (vg.overrides && vg.overrides[id]) || {};
  const cfg = { baseUrl: ov.baseUrl || '', model: ov.model || '' };
  for (const [field, secret] of Object.entries(p.keyFields || {})) {
    if (field === 'fallback') continue;
    cfg[field] = (settings.getSecret && settings.getSecret(secret)) || '';
  }
  if (p.keyFields && p.keyFields.fallback && !cfg.key) cfg.key = (settings.getSecret && settings.getSecret(p.keyFields.fallback)) || '';
  return cfg;
}

function isConfigured(p, cfg) {
  return (p.needs || []).every((f) => !!(cfg && cfg[f]));
}

function describe(settings) {
  return PROVIDERS.map((p) => {
    let configured = false;
    try { configured = isConfigured(p, resolveConfig(settings, p.id)); } catch {}
    return { id: p.id, label: p.label, vendor: p.vendor, caps: p.caps, configured, priceHint: p.priceHint, needs: p.needs, keyFields: p.keyFields, keyUrl: p.keyUrl, defaultModel: p.defaultModel, defaultBaseUrl: p.defaultBaseUrl, isMock: !!p.isMock };
  });
}

const STAGE = { queued: '排队中', running: '生成中' };

// 查询进度时网络抖动 / 服务商限流 / 5xx：连续失败这么多次以内不中断任务，继续按退避间隔查
const POLL_TOLERATE = 4;

/**
 * 轮询已提交的任务直到完成并取回结果。
 * 轮询间隔逐步拉长、有总超时（provider.pollOpts 可按家覆盖，调用方 pollOpts 优先）。
 * @returns {Promise<{url?,headers?,localPath?}>}
 */
async function waitTask(p, taskId, cfg, deps, { onStatus, pollOpts } = {}) {
  let fails = 0;
  const last = await util.pollUntil(async () => {
    let st;
    try {
      st = await p.poll(taskId, cfg, deps);
      fails = 0;
    } catch (e) {
      if (e && e.code === 'CANCELLED') throw e;
      if (e && e.retryable && ++fails <= POLL_TOLERATE) return null;
      throw e;
    }
    if (onStatus) onStatus(st);
    if (st.state === 'succeeded') return st;
    if (st.state === 'failed') throw new util.VideogenError(`${p.label} 生成失败：${st.error || '未知原因'}`, 'GEN_FAILED');
    return null;
  }, { signal: deps.signal, ...(p.pollOpts || {}), ...(pollOpts || {}) });
  return p.fetchResult(taskId, cfg, deps, last);
}

async function runTask(p, input, cfg, deps, opts = {}) {
  if (!isConfigured(p, cfg)) throw new util.VideogenError(`尚未配置 ${p.label} 的密钥，请在「设置 → AI 视频生成」填写`, 'NO_KEY');
  if (!String(input.prompt || '').trim() && !input.image) throw new util.VideogenError('请填写画面描述', 'BAD_INPUT');
  if (input.image && !p.caps.image && !(p.caps.imageUrlOnly && /^https?:/.test(input.image))) input = { ...input, image: undefined };
  const { taskId } = await p.submit(input, cfg, deps);
  if (opts.onSubmitted) opts.onSubmitted(taskId);
  try {
    const result = await waitTask(p, taskId, cfg, deps, opts);
    return { taskId, result };
  } catch (e) {
    if (e && e.code === 'CANCELLED' && p.cancel) { try { await p.cancel(taskId, cfg, { ...deps, signal: undefined }); } catch {} }
    throw e;
  }
}

/** 简单的每 provider 并发闸门 */
function createLimiter(max = 2) {
  const running = new Map();
  const queues = new Map();
  return {
    async run(key, fn, onWait) {
      const n = running.get(key) || 0;
      if (n >= max) {
        if (onWait) onWait();
        // 槽位由释放方直接移交，计数不变
        await new Promise((resolve) => { const q = queues.get(key) || []; q.push(resolve); queues.set(key, q); });
      } else running.set(key, n + 1);
      try { return await fn(); } finally {
        const q = queues.get(key);
        if (q && q.length) q.shift()();
        else running.set(key, running.get(key) - 1);
      }
    },
    active(key) { return running.get(key) || 0; },
  };
}

module.exports = { PROVIDERS, BY_ID, getProvider, resolveConfig, isConfigured, describe, runTask, waitTask, createLimiter, STAGE, util };
