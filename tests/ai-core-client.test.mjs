// ai-core：渲染端 AI 客户端（C9）——NO_AI 兜底识别、进度摊平、signal 取消、用量透传。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAI, runWithFallback, NoAIError, isNoAI, isNoImageAI, imageErrorKind, isCancelled, flattenProgress, NO_AI_MESSAGE } from '../src/ai/client.js';
import api from '../src/ui/api.js';

const SCHEMA = { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'] };

async function withApi(patch, fn) {
  const saved = { available: api.available, job: api.job, cancel: api.cancel };
  try {
    api.available = true;
    Object.assign(api, patch);
    await fn();
  } finally {
    Object.assign(api, saved);
  }
}

test('isNoAI：认 code、name、固定文案和 cause，不误伤普通错误', () => {
  assert.equal(isNoAI(new NoAIError()), true);
  assert.equal(new NoAIError().message, NO_AI_MESSAGE);
  assert.equal(isNoAI(Object.assign(new Error('x'), { code: 'NO_AI' })), true);
  assert.equal(isNoAI({ name: 'NoAIError', message: '' }), true);
  // contextBridge 把 code 丢了，只剩消息
  assert.equal(isNoAI(new Error('未连接 AI（Codex 未登录：请在终端运行 codex login），已使用本地规则')), true);
  assert.equal(isNoAI(new Error("Error invoking remote method 'ai:run': Error: 未连接 AI，已使用本地规则")), true);
  assert.equal(isNoAI(new Error('failed: NO_AI')), true);
  assert.equal(isNoAI('未连接AI'), true);
  assert.equal(isNoAI(Object.assign(new Error('包装过的错误'), { cause: { code: 'NO_AI' } })), true);
  assert.equal(isNoAI(null), false);
  assert.equal(isNoAI(new Error('无法连接模型服务：请检查接口地址与网络')), false);
  assert.equal(isNoAI(new Error('Codex 响应超时')), false);
  assert.equal(isNoAI(Object.assign(new Error('已取消'), { code: 'CANCELLED' })), false);
});

test('isNoImageAI：认 code 和固定开头的文案；和「未连接 AI」互不误伤', () => {
  assert.equal(isNoImageAI(Object.assign(new Error('x'), { code: 'NO_IMAGE_AI' })), true);
  // 没建任务就失败的错误穿过 contextBridge 后 code 丢了，只剩消息
  const lost = new Error('还没有可用的出图服务：请到设置的「即梦（火山方舟）」里填写 API Key（推荐），或在「设置 → AI 助手」里给 OpenAI 兼容接口填写图片模型');
  assert.equal(isNoImageAI(lost), true);
  assert.equal(isNoImageAI("Error invoking remote method 'ai:image': Error: 还没有可用的出图服务"), true);
  assert.equal(isNoImageAI(new Error('当前 AI 不支持生成图片')), true, '老版本主进程的说法也认');
  assert.equal(isNoImageAI(new Error('failed: NO_IMAGE_AI')), true);
  assert.equal(isNoImageAI(Object.assign(new Error('包装过的错误'), { cause: { code: 'NO_IMAGE_AI' } })), true);
  assert.equal(isNoImageAI(null), false);
  assert.equal(isNoImageAI(new Error('内容审核未通过：请换个描述再试')), false);
  assert.equal(isNoImageAI(new NoAIError()), false);
  // 出图没配好不等于「没连 AI」：不能让调用方悄悄走本地规则那条路
  assert.equal(isNoAI(lost), false);
  assert.equal(isNoAI(Object.assign(new Error('x'), { code: 'NO_IMAGE_AI' })), false);
  assert.equal(isNoAI(new Error('failed: NO_IMAGE_AI')), false);
});

test('imageErrorKind：按错误码归类；错误码丢了按中文说法兜底', () => {
  const coded = (code, message = 'x') => Object.assign(new Error(message), { code });
  assert.equal(imageErrorKind(coded('NO_IMAGE_AI')), 'none');
  assert.equal(imageErrorKind(new Error('还没有可用的出图服务')), 'none');
  assert.equal(imageErrorKind(coded('IMAGE_SETUP')), 'setup');
  assert.equal(imageErrorKind(coded('IMAGE_SIZE')), 'setup');
  assert.equal(imageErrorKind(coded('IMAGE_BALANCE')), 'balance');
  assert.equal(imageErrorKind(coded('IMAGE_BLOCKED')), 'blocked');
  assert.equal(imageErrorKind(coded('IMAGE_BUSY')), 'busy');
  assert.equal(imageErrorKind(coded('IMAGE_FAILED')), 'other');
  assert.equal(imageErrorKind(coded('CANCELLED', '已取消')), 'cancelled');
  assert.equal(imageErrorKind({ cancelled: true, message: '已取消' }), 'cancelled');
  // 主进程 ai.cjs 里的原话（错误码丢失时）
  assert.equal(imageErrorKind(new Error('模型未开通：请在火山方舟控制台『开通管理』里开通 Seedream 图片模型')), 'setup');
  assert.equal(imageErrorKind(new Error('找不到这个图片模型，或者还没有开通：请在火山方舟控制台『开通管理』里开通 Seedream 图片模型')), 'setup');
  assert.equal(imageErrorKind(new Error('火山方舟 API Key 不对或已失效：请到火山方舟控制台『API Key 管理』重新复制完整的 Key')), 'setup');
  assert.equal(imageErrorKind(new Error('这个图片模型不支持当前的画面尺寸：请在设置里清空图片模型名')), 'setup');
  assert.equal(imageErrorKind(new Error('火山方舟账户余额不足或已欠费：请到火山引擎控制台充值后重试')), 'balance');
  assert.equal(imageErrorKind(new Error('免费额度已用完：请在火山方舟控制台开通付费或充值后再生成')), 'balance');
  assert.equal(imageErrorKind(new Error('画面描述没通过内容审核：请换个说法再试')), 'blocked');
  assert.equal(imageErrorKind('请求太频繁，火山方舟暂时限流了：请稍等一两分钟再试'), 'busy');
  assert.equal(imageErrorKind(new Error('火山方舟服务繁忙：请稍后重试')), 'busy');
  assert.equal(imageErrorKind(new Error('图片已生成，但下载失败：请检查网络后重试')), 'other');
  assert.equal(imageErrorKind(null), 'other');
});

test('runAI：任务通道丢了错误码，只凭文案也转成 NoAIError，并去掉英文前缀', async () => {
  await withApi({
    job: async () => { throw new Error("Error invoking remote method 'ai:run': Error: 未连接 AI（Codex 未登录：请在终端运行 codex login），已使用本地规则"); },
  }, async () => {
    await assert.rejects(() => runAI({ task: 'director', prompt: 'p', schema: SCHEMA }), (e) => {
      assert.ok(e instanceof NoAIError);
      assert.equal(e.code, 'NO_AI');
      assert.match(e.message, /^未连接 AI（Codex 未登录/);
      return true;
    });
    // runWithFallback 因此能自动走本地规则
    const r = await runWithFallback({ task: 'director', prompt: 'p', schema: SCHEMA }, (d) => d, () => ({ reply: '本地' }));
    assert.equal(r.fallback, true);
    assert.equal(r.result.reply, '本地');
  });
});

test('runAI：非桌面环境的 NoAIError 也带「未连接 AI」', async () => {
  await assert.rejects(() => runAI({ task: 'director', prompt: 'p', schema: SCHEMA }), (e) => e instanceof NoAIError && /未连接 AI/.test(e.message));
});

test('runAI：进度对象摊平 meta 的 phase / elapsedMs / slow，老格式退回 stage', async () => {
  const got = [];
  await withApi({
    job: async (channel, payload, onProgress, onStart) => {
      onStart('j1');
      onProgress({ jobId: 'j1', kind: 'ai', stage: '思考中', progress: 0.22, message: '思考中 · 已用 3 秒', meta: { task: 'director', phase: '思考中', elapsedMs: 3000, slow: false } });
      onProgress({ jobId: 'j1', kind: 'ai', stage: '写回复', progress: 0.7, message: '写回复 · 已用 95 秒，响应较慢，可以取消', meta: { phase: '写回复', elapsedMs: 95000, slow: true } });
      onProgress({ jobId: 'j1', kind: 'ai', stage: '旧版阶段', progress: 0.1, message: '已用时 2 秒' });
      return { data: { reply: 'ok' }, provider: 'codex', model: 'm', ms: 5 };
    },
  }, async () => {
    let started = null;
    await runAI({ task: 'director', prompt: 'p', schema: SCHEMA }, { onProgress: (p) => got.push(p), onStart: (id) => { started = id; } });
    assert.equal(started, 'j1');
    assert.equal(got.length, 3);
    assert.equal(got[0].phase, '思考中');
    assert.equal(got[0].elapsedMs, 3000);
    assert.equal(got[0].slow, false);
    assert.equal(got[0].progress, 0.22); // 原有字段保留
    assert.equal(got[0].message, '思考中 · 已用 3 秒');
    assert.equal(got[1].slow, true);
    assert.equal(got[2].phase, '旧版阶段');
    assert.ok(Number.isFinite(got[2].elapsedMs) && got[2].elapsedMs >= 0);
  });
});

test('runAI：回调抛错不影响任务；effort 透传；用量和重试次数只在有时才带', async () => {
  let seen = null;
  await withApi({
    job: async (channel, payload, onProgress) => {
      seen = payload;
      onProgress({ jobId: 'j2', stage: 'x', progress: 0.5 });
      return { data: { reply: 'ok' }, provider: 'codex', model: 'm', ms: 7, usage: { inputTokens: 10, cachedInputTokens: 6, outputTokens: 3, reasoningTokens: 0 }, attempts: 2 };
    },
  }, async () => {
    const r = await runAI({ task: 'storyboard', prompt: 'p', schema: SCHEMA, effort: 'high' }, { onProgress: () => { throw new Error('界面炸了'); } });
    assert.equal(seen.effort, 'high');
    assert.deepEqual(r.usage, { inputTokens: 10, cachedInputTokens: 6, outputTokens: 3, reasoningTokens: 0 });
    assert.equal(r.attempts, 2);
  });
  await withApi({ job: async () => ({ data: { reply: 'ok' }, provider: 'openai', model: 'm', ms: 1, attempts: 1 }) }, async () => {
    const r = await runAI({ task: 'director', prompt: 'p', schema: SCHEMA });
    assert.deepEqual(Object.keys(r).sort(), ['data', 'model', 'ms', 'provider']);
  });
});

test('runAI：signal 取消时立即结束等待，并通知主进程取消任务', async () => {
  const cancelled = [];
  await withApi({
    job: (channel, payload, onProgress, onStart) => { onStart('j9'); return new Promise(() => {}); },
    cancel: async (id) => { cancelled.push(id); return true; },
  }, async () => {
    const ctrl = new AbortController();
    const p = runAI({ task: 'director', prompt: 'p', schema: SCHEMA }, { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 10);
    await assert.rejects(p, (e) => isCancelled(e) && e.message === '已取消');
    assert.deepEqual(cancelled, ['j9']);
  });
});

test('runAI：signal 已经取消时不建任务', async () => {
  let called = false;
  await withApi({ job: async () => { called = true; return {}; } }, async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(() => runAI({ task: 'director', prompt: 'p', schema: SCHEMA }, { signal: ctrl.signal }), (e) => isCancelled(e));
    assert.equal(called, false);
  });
});

test('runAI：主进程回报取消（code 丢失但 cancelled 标记在）仍算取消', async () => {
  await withApi({ job: async () => { const e = new Error('已取消'); e.cancelled = true; throw e; } }, async () => {
    await assert.rejects(() => runAI({ task: 'edit', prompt: 'p', schema: SCHEMA }), (e) => isCancelled(e) && !isNoAI(e));
  });
});

test('flattenProgress：非对象原样返回；已有 phase 不覆盖', () => {
  assert.equal(flattenProgress(null), null);
  const p = flattenProgress({ stage: 's', phase: '自带', elapsedMs: 5, slow: true, meta: { phase: 'meta', elapsedMs: 9, slow: false } });
  assert.equal(p.phase, '自带');
  assert.equal(p.elapsedMs, 5);
  assert.equal(p.slow, true);
});
