// ai-core：主进程 AI 底座——codex --json 事件解析、能力降级、阶段进度 + 90 秒看门狗、NO_AI 不建任务、用时统计。
// 用一个假的 codex（临时目录里的 node 脚本）跑真实子进程链路；所有文件都写在系统临时目录。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const codex = require('../electron/lib/codex.cjs');
const registerAI = require('../electron/ipc/ai.cjs');
const { parseCodexEvent, runCodex } = codex;
const CX = codex._internals;
const AI = registerAI._internals;

const SCHEMA = { type: 'object', additionalProperties: false, required: ['ok', 'echo'], properties: { ok: { type: 'boolean' }, echo: { type: 'string' } } };

// ───────────────────────── 假 codex ─────────────────────────
const FAKE = `'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE || 'ok';
if (args[0] === '--version') { process.stdout.write('codex-cli 0.99.0\\n'); return; }
if (args[0] === 'login' && args[1] === 'status') { process.stdout.write('Logged in using ChatGPT\\n'); return; }
const has = (a) => args.includes(a);
const val = (a) => { const i = args.indexOf(a); return i >= 0 ? args[i + 1] : null; };
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const retry = input.includes('【上一次的输出无法解析】');
  if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, retry }) + '\\n');
  const effort = args.find((a) => a.startsWith('model_reasoning_effort='));
  if (mode === 'nojson' && has('--json')) { process.stderr.write("error: unexpected argument '--json' found\\n"); process.exitCode = 2; return; }
  if (mode === 'noeffort' && effort) { process.stderr.write('Error: unknown variant \`' + effort.split('=')[1] + '\` for model_reasoning_effort\\n'); process.exitCode = 1; return; }
  if (mode === 'fail') { process.stderr.write('stream disconnected before completion: error sending request\\n'); process.exitCode = 1; return; }
  const json = has('--json');
  const ev = (o) => { if (json) process.stdout.write(JSON.stringify(o) + '\\n'); };
  ev({ type: 'thread.started', thread_id: 't1' });
  ev({ type: 'turn.started' });
  ev({ type: 'item.started', item: { id: 'i0', type: 'reasoning', text: '' } });
  ev({ type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: '想一想' } });
  let result = JSON.stringify({ ok: true, echo: '镜流连接正常' });
  if (mode === 'badjson' && !retry) result = '好的，下面是结果：（没有 JSON）';
  ev({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: result } });
  ev({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 90 } });
  if (mode === 'noout') { if (!json) process.stdout.write(result); }
  else fs.writeFileSync(val('-o'), result, 'utf8');
});
`;

let dir;
let fakeBin;
let logFile;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-aicore-'));
  fs.writeFileSync(path.join(dir, 'fake-codex.cjs'), FAKE, 'utf8');
  if (process.platform === 'win32') {
    fakeBin = path.join(dir, 'codex.cmd');
    fs.writeFileSync(fakeBin, `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.cjs" %*\r\nexit /b %ERRORLEVEL%\r\n`, 'utf8');
  } else {
    fakeBin = path.join(dir, 'codex');
    fs.writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-codex.cjs" "$@"\n`, 'utf8');
    fs.chmodSync(fakeBin, 0o755);
  }
  logFile = path.join(dir, 'calls.jsonl');
  process.env.FAKE_CODEX_LOG = logFile;
});

after(() => {
  delete process.env.FAKE_CODEX_LOG;
  delete process.env.FAKE_CODEX_MODE;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

function calls() {
  try { return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
function reset(mode) {
  process.env.FAKE_CODEX_MODE = mode;
  try { fs.rmSync(logFile, { force: true }); } catch {}
  CX.clearCapabilityCache();
}
async function callCodex(extra = {}) {
  const events = [];
  const data = await runCodex({ codexPath: fakeBin, system: '系统', prompt: '提示', schema: SCHEMA, tmpRoot: dir, timeoutMs: 60000, onEvent: (e) => events.push(e), ...extra });
  return { data, events };
}

// ───────────────────────── 事件解析 ─────────────────────────
test('parseCodexEvent：新版事件映射到阶段，turn.completed 带用量', () => {
  assert.equal(parseCodexEvent('{"type":"thread.started","thread_id":"x"}').phase, 'connected');
  assert.equal(parseCodexEvent('{"type":"turn.started"}').phase, 'reading');
  assert.equal(parseCodexEvent('{"type":"item.started","item":{"type":"reasoning"}}').phase, 'thinking');
  assert.equal(parseCodexEvent('{"type":"item.updated","item":{"type":"command_execution"}}').phase, 'tool');
  assert.equal(parseCodexEvent('{"type":"item.started","item":{"type":"web_search"}}').phase, 'search');
  const msg = parseCodexEvent('{"type":"item.completed","item":{"type":"agent_message","text":"{\\"a\\":1}"}}');
  assert.equal(msg.phase, 'writing');
  assert.equal(msg.text, '{"a":1}');
  const done = parseCodexEvent('{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":60,"output_tokens":20}}');
  assert.equal(done.phase, 'checking');
  assert.deepEqual(done.usage, { inputTokens: 100, cachedInputTokens: 60, outputTokens: 20, reasoningTokens: 0 });
  assert.match(parseCodexEvent('{"type":"turn.failed","error":{"message":"boom"}}').error, /boom/);
  assert.match(parseCodexEvent('{"type":"error","message":"oops"}').error, /oops/);
});

test('parseCodexEvent：旧版 msg 事件、垃圾行与未知事件', () => {
  assert.equal(parseCodexEvent('{"id":"1","msg":{"type":"agent_reasoning","text":"x"}}').phase, 'thinking');
  const tc = parseCodexEvent('{"id":"2","msg":{"type":"token_count","info":{"total_token_usage":{"input_tokens":50,"cached_input_tokens":10,"output_tokens":5}}}}');
  assert.equal(tc.cumulative, true);
  assert.equal(tc.usage.cachedInputTokens, 10);
  for (const junk of ['', 'hello', '[1,2]', '{bad json', '{"type":"something.new"}', '{"id":"3","msg":{"type":"unknown_kind"}}', null, undefined]) {
    assert.equal(parseCodexEvent(junk), null, String(junk));
  }
});

test('normalizeUsage / addUsage：兼容 OpenAI 字段，全 0 返回 null', () => {
  assert.deepEqual(CX.normalizeUsage({ prompt_tokens: 30, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 12 } }),
    { inputTokens: 30, cachedInputTokens: 12, outputTokens: 7, reasoningTokens: 0 });
  assert.equal(CX.normalizeUsage({}), null);
  assert.equal(CX.normalizeUsage(null), null);
  const a = { inputTokens: 1, cachedInputTokens: 2, outputTokens: 3, reasoningTokens: 4 };
  assert.deepEqual(CX.addUsage(a, a), { inputTokens: 2, cachedInputTokens: 4, outputTokens: 6, reasoningTokens: 8 });
  assert.deepEqual(CX.addUsage(null, a), a);
  assert.equal(CX.addUsage(a, null), a);
});

test('buildCodexArgs：--json 与推理强度只在需要时出现，未知强度不传', () => {
  const base = { tmpDir: 'T', schemaPath: 'S', outPath: 'O', images: ['a.png'] };
  const plain = CX.buildCodexArgs(base);
  assert.ok(!plain.includes('--json'));
  assert.ok(!plain.some((a) => /model_reasoning_effort/.test(a)));
  assert.deepEqual(plain.slice(-5), ['--output-schema', 'S', '-o', 'O', '-']);
  const full = CX.buildCodexArgs({ ...base, json: true, effort: 'high', model: 'gpt-x' });
  assert.ok(full.includes('--json'));
  assert.equal(full[full.indexOf('-c') + 1], 'model_reasoning_effort=high');
  assert.ok(full.indexOf('-i') < full.indexOf('--output-schema'));
  assert.ok(!CX.buildCodexArgs({ ...base, effort: 'turbo' }).includes('-c'));
  assert.equal(CX.quoteForCmd('model_reasoning_effort=high'), '"model_reasoning_effort=high"');
});

// ───────────────────────── 真实子进程链路（假 codex） ─────────────────────────
test('runCodex：--json 事件流 → 阶段、用量；推理强度传给 codex', async () => {
  reset('ok');
  const { data, events } = await callCodex({ effort: 'high' });
  assert.deepEqual(data, { ok: true, echo: '镜流连接正常' });
  const phases = events.map((e) => e.phase).filter(Boolean);
  for (const k of ['connected', 'reading', 'thinking', 'writing', 'checking']) assert.ok(phases.includes(k), k);
  const done = events.find((e) => e.type === 'ff.done');
  assert.deepEqual(done.usage, { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 90, reasoningTokens: 0 });
  assert.equal(done.attempts, 1);
  const [c] = calls();
  assert.ok(c.args.includes('--json'));
  assert.ok(c.args.includes('model_reasoning_effort=high'));
});

test('runCodex：不认 --json 的旧 codex 自动降级，之后不再传', async () => {
  reset('nojson');
  const { data, events } = await callCodex();
  assert.equal(data.ok, true);
  let list = calls();
  assert.equal(list.length, 2);
  assert.ok(list[0].args.includes('--json'));
  assert.ok(!list[1].args.includes('--json'));
  assert.ok(events.some((e) => e.type === 'ff.attempt' && e.reason === 'no-json'));
  fs.rmSync(logFile, { force: true });
  await callCodex();
  list = calls();
  assert.equal(list.length, 1, '记住了能力缺口，不再白跑一趟');
  assert.ok(!list[0].args.includes('--json'));
});

test('runCodex：模型不支持推理强度时去掉再跑', async () => {
  reset('noeffort');
  const { data } = await callCodex({ effort: 'xhigh' });
  assert.equal(data.ok, true);
  const list = calls();
  assert.equal(list.length, 2);
  assert.ok(list[0].args.includes('model_reasoning_effort=xhigh'));
  assert.ok(!list[1].args.some((a) => /model_reasoning_effort/.test(a)));
});

test('runCodex：输出不是 JSON 时带上解析错误重问一次', async () => {
  reset('badjson');
  const { data, events } = await callCodex();
  assert.equal(data.ok, true);
  const list = calls();
  assert.equal(list.length, 2);
  assert.equal(list[0].retry, false);
  assert.equal(list[1].retry, true);
  assert.ok(events.some((e) => e.type === 'ff.attempt' && e.reason === 'bad-json' && e.phase === 'retrying'));
  assert.equal(events.find((e) => e.type === 'ff.done').attempts, 2);
});

test('runCodex：-o 文件为空时用最后一条 agent_message', async () => {
  reset('noout');
  const { data } = await callCodex();
  assert.deepEqual(data, { ok: true, echo: '镜流连接正常' });
});

test('runCodex：网络类失败给出能看懂的中文原因，不盲目重发', async () => {
  reset('fail');
  await assert.rejects(() => callCodex(), (e) => e.code === 'CODEX_FAILED' && /连不上服务器/.test(e.message));
  assert.equal(calls().length, 1);
});

test('runCodex：已取消的 signal 不启动进程', async () => {
  reset('ok');
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(() => callCodex({ signal: ctrl.signal }), (e) => e.code === 'CANCELLED');
  assert.equal(calls().length, 0);
});

// ───────────────────────── 进度上报器 ─────────────────────────
function fakeJob(meta = {}) {
  const sent = [];
  return { meta, sent, progress: (stage, progress, message) => sent.push({ stage, progress, message, meta: { ...meta } }) };
}

test('createProgress：阶段文字按任务翻译，进度单调，已用时写进 meta', () => {
  let t = 0;
  const job = fakeJob({ task: 'storyboard' });
  const p = AI.createProgress(job, { task: 'storyboard', now: () => t, tickMs: 0 }).start();
  t = 1500; p.event('connected');
  t = 4000; p.event('thinking');
  t = 9000; p.event('writing');
  t = 9100; assert.equal(p.event('writing'), null, '阶段没变不重复上报');
  t = 9500; p.event('connecting'); // 重试回到连接：文字变，进度不倒退
  assert.deepEqual(job.sent.map((s) => s.stage), ['连接 AI', '已连接', '思考中', '写分镜', '连接 AI']);
  for (let i = 1; i < job.sent.length; i++) assert.ok(job.sent[i].progress >= job.sent[i - 1].progress, '进度不倒退');
  const last = job.sent[job.sent.length - 1];
  assert.equal(last.meta.elapsedMs, 9500);
  assert.equal(last.meta.phaseKey, 'connecting');
  assert.equal(last.meta.phase, '连接 AI');
  assert.equal(last.meta.task, 'storyboard', '原有 meta 字段保留');
  assert.match(last.message, /^连接 AI · 已用 9 秒$/);
  p.stop();
});

test('createProgress：停止后不再上报', () => {
  let t = 0;
  const job = fakeJob();
  const p = AI.createProgress(job, { task: 'director', now: () => t, tickMs: 0 }).start();
  p.stop();
  const n = job.sent.length;
  t = 5000;
  p.event('thinking');
  p.tick();
  assert.equal(job.sent.length, n);
});

test('createProgress：90 秒没有新事件提示「响应较慢，可以取消」，来了事件就撤掉', () => {
  let t = 0;
  const job = fakeJob();
  const q = AI.createProgress(job, { task: 'edit', now: () => t, tickMs: 0 }).start();
  q.event('thinking');
  t = 89000; assert.equal(q.tick().slow, false);
  t = AI.SLOW_AFTER_MS + 1000;
  const s = q.tick();
  assert.equal(s.slow, true);
  assert.ok(s.value < 0.37, '慢的时候进度也不会冲到头');
  assert.match(job.sent[job.sent.length - 1].message, /响应较慢，可以取消/);
  assert.equal(job.meta.slow, true);
  const n = job.sent.length;
  q.event(null); // 同阶段的增量事件：有动静了，立即撤掉慢提示
  assert.equal(job.sent.length, n + 1);
  assert.doesNotMatch(job.sent[job.sent.length - 1].message, /响应较慢/);
  assert.equal(job.meta.slow, false);
  q.set('writing');
  assert.equal(job.sent[job.sent.length - 1].stage, '写方案');
  q.event('done');
  const end = job.sent[job.sent.length - 1];
  assert.equal(end.progress, 1);
  assert.equal(end.message, '完成');
  q.stop();
});

test('phaseText / effortFor / noAIError', () => {
  assert.equal(AI.phaseText('writing', 'storyboard'), '写分镜');
  assert.equal(AI.phaseText('writing', 'director'), '写回复');
  assert.equal(AI.phaseText('writing', 'unknown'), '整理结果');
  assert.equal(AI.phaseText('nope'), '处理中');
  assert.equal(AI.effortFor('storyboard'), 'high');
  assert.equal(AI.effortFor('director'), 'medium');
  assert.equal(AI.effortFor('tags'), 'low');
  assert.equal(AI.effortFor('director', 'high'), 'high');
  assert.equal(AI.effortFor('storyboard', null, 'low'), 'low');
  assert.equal(AI.effortFor('storyboard', 'turbo', 'nope'), 'high');
  assert.equal(AI.effortFor('whatever'), null);
  const e = AI.noAIError('Codex 未登录：请在终端运行 codex login。');
  assert.equal(e.code, 'NO_AI');
  assert.equal(e.message, '未连接 AI（Codex 未登录：请在终端运行 codex login），已使用本地规则');
  assert.equal(AI.noAIError().message, '未连接 AI，已使用本地规则');
});

// ───────────────────────── 用时统计 ─────────────────────────
test('percentile / summarizeMetrics：p50/p90、失败不计耗时、缓存命中率', () => {
  assert.equal(AI.percentile([], 50), null);
  assert.equal(AI.percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(AI.percentile([5, 1, 3, 2, 4], 90), 5);
  assert.equal(AI.percentile([10], 90), 10);
  const rows = AI.summarizeMetrics([
    { task: 'director', ok: true, ms: 1000, provider: 'codex', usage: { inputTokens: 1000, cachedInputTokens: 600, outputTokens: 50 } },
    { task: 'director', ok: true, ms: 3000, provider: 'codex', usage: { inputTokens: 1000, cachedInputTokens: 900, outputTokens: 50 } },
    { task: 'director', ok: false, ms: 99999, provider: 'codex' },
    { task: 'storyboard', ok: true, ms: 20000, provider: 'openai' },
    null, 'junk',
  ]);
  const d = rows.find((r) => r.task === 'director');
  assert.equal(d.count, 3);
  assert.equal(d.failed, 1);
  assert.equal(d.p50Ms, 1000);
  assert.equal(d.p90Ms, 3000);
  assert.equal(d.cachedInputTokens, 1500);
  assert.equal(d.cachedRatio, 0.75);
  assert.equal(rows[0].task, 'director', '次数多的在前');
  assert.equal(rows.find((r) => r.task === 'storyboard').cachedRatio, null);
});

test('appendMetric：追加 JSONL，超过上限只留最近几行；parseMetricsLines 跳过坏行', async () => {
  const file = path.join(dir, 'm', 'ai-metrics.jsonl');
  for (let i = 0; i < 30; i++) await AI.appendMetric(file, { task: 't', ok: true, ms: i }, { maxBytes: 600, keep: 5 });
  const entries = AI.parseMetricsLines(fs.readFileSync(file, 'utf8') + '\n{bad\n');
  assert.ok(entries.length <= 10 && entries.length >= 1);
  assert.equal(entries[entries.length - 1].ms, 29);
  assert.ok(entries.every((e) => !('prompt' in e)));
  assert.equal(await AI.appendMetric(null, { a: 1 }), false);
});

// ───────────────────────── ai:run 通道 ─────────────────────────
function fakeCtx(aiSettings, root) {
  const started = [];
  const ctx = {
    settings: { get: () => ({ ai: aiSettings }), getSecret: () => '' },
    paths: { tmp: root, userData: root, cache: root },
    jobs: {
      start(kind, fn, meta = {}) {
        const controller = new AbortController();
        const sent = [];
        const job = {
          meta, signal: controller.signal, cancelled: false, sent,
          progress: (stage, progress, message) => sent.push({ stage, progress, message, meta: { ...meta } }),
          throwIfCancelled() { if (controller.signal.aborted) { const e = new Error('已取消'); e.code = 'CANCELLED'; throw e; } },
        };
        const promise = fn(job);
        started.push({ kind, meta, job, promise });
        return { jobId: `job${started.length}` };
      },
    },
  };
  const handlers = {};
  registerAI({ handle: (ch, fn) => { handlers[ch] = fn; }, ctx });
  return { ctx, handlers, started };
}

test('ai:run：本地规则 / none 立即失败 NO_AI，不建任务也不探测 Codex', async () => {
  for (const [setting, requested] of [['local', undefined], ['auto', 'none'], ['auto', 'local'], ['none', undefined]]) {
    const { handlers, started } = fakeCtx({ provider: setting }, dir);
    await assert.rejects(() => handlers['ai:run']({ task: 'director', prompt: 'p', schema: SCHEMA, provider: requested }),
      (e) => e.code === 'NO_AI' && /未连接 AI/.test(e.message));
    assert.equal(started.length, 0, `${setting}/${requested}`);
  }
});

test('ai:run：走 Codex 时上报真实阶段（含「写分镜」），结果带用量，写入用时统计', async () => {
  reset('ok');
  CX.clearDetectCache();
  const root = fs.mkdtempSync(path.join(dir, 'run-'));
  const { handlers, started } = fakeCtx({ provider: 'codex', codexPath: fakeBin }, root);
  const r = await handlers['ai:run']({ task: 'storyboard', system: 's', prompt: 'p', schema: SCHEMA });
  assert.equal(r.jobId, 'job1');
  const { job, promise, meta } = started[0];
  const res = await promise;
  assert.deepEqual(res.data, { ok: true, echo: '镜流连接正常' });
  assert.equal(res.provider, 'codex');
  assert.equal(res.usage.cachedInputTokens, 800);
  assert.ok(!('attempts' in res));
  assert.equal(meta.task, 'storyboard');
  const stages = job.sent.map((s) => s.stage);
  for (const s of ['连接 AI', '已连接', '思考中', '写分镜', '校验结果', '完成']) assert.ok(stages.includes(s), s);
  const last = job.sent[job.sent.length - 1];
  assert.equal(last.progress, 1);
  assert.equal(last.meta.phase, '完成');
  assert.ok(Number.isFinite(last.meta.elapsedMs));
  // 整套分镜默认用 high
  assert.ok(calls()[0].args.includes('model_reasoning_effort=high'));
  const m = await handlers['ai:metrics']();
  assert.equal(m.total, 1);
  assert.equal(m.tasks[0].task, 'storyboard');
  assert.equal(m.tasks[0].cachedInputTokens, 800);
  assert.ok(m.file.startsWith(root));
  const raw = fs.readFileSync(m.file, 'utf8');
  assert.ok(!raw.includes('"p"') && !raw.includes('prompt'), '统计里不含提示词');
});

test('ai:run：Codex 失败且没配 API 时，错误带中文原因并记一条失败统计', async () => {
  reset('fail');
  CX.clearDetectCache();
  const root = fs.mkdtempSync(path.join(dir, 'fail-'));
  const { handlers, started } = fakeCtx({ provider: 'codex', codexPath: fakeBin }, root);
  await handlers['ai:run']({ task: 'director', system: 's', prompt: 'p', schema: SCHEMA });
  await assert.rejects(started[0].promise, (e) => e.code === 'CODEX_FAILED');
  const m = await handlers['ai:metrics']();
  assert.equal(m.tasks[0].failed, 1);
  assert.equal(m.tasks[0].p50Ms, null);
});
