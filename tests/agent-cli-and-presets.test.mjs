// agent-cli-and-presets：AI API 预设、本地免密钥检测、Anthropic 编解码、多 CLI 安全校验、以及 ai.cjs API 优先路由。
// 100% 离线、确定性；临时文件均落在 os.tmpdir() 并在 after() 中彻底清理。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const aiPresets = require('../electron/lib/aiPresets.cjs');
const agentCli = require('../electron/lib/agentCli.cjs');
const codex = require('../electron/lib/codex.cjs');
const registerAI = require('../electron/ipc/ai.cjs');

const {
  ANTHROPIC_VERSION,
  API_PRESETS,
  getPreset,
  isLocalKeylessUrl,
  anthropicMessagesUrl,
  buildAnthropicHeaders,
  buildAnthropicRequest,
  parseAnthropicResponse,
} = aiPresets;

const {
  AGENT_CLIS,
  validateCliModel,
  isValidCliPath,
  runAgentCli,
} = agentCli;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'reply'],
  properties: { ok: { type: 'boolean' }, reply: { type: 'string' } },
};

const tmpDirs = [];
function makeTmpDir(prefix = 'ff-aipresets-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  tmpDirs.length = 0;
});

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function setupAiIpc({ ai = {}, secrets = {}, responses = [], detectCodex, detectAgentCli, useRealFetch = false } = {}) {
  const root = makeTmpDir('ff-ai-route-');
  const calls = [];
  const started = [];
  const queue = [...responses];
  const ctx = {
    settings: {
      get: () => ({ ai }),
      getSecret: (name) => secrets[name] || '',
    },
    paths: { tmp: path.join(root, 'tmp'), userData: root, cache: path.join(root, 'cache') },
    detectCodex,
    detectAgentCli,
    ...(useRealFetch ? {} : {
      fetch: async (url, init = {}) => {
        const call = {
          url: String(url),
          method: init.method || 'GET',
          headers: init.headers || {},
          body: init.body ? JSON.parse(init.body) : null,
        };
        calls.push(call);
        if (!queue.length) throw new Error(`未准备第 ${calls.length} 次 fetch 响应：${url}`);
        const next = queue.shift();
        return typeof next === 'function' ? next(call, init) : next;
      },
    }),
    jobs: {
      start(kind, fn, meta = {}) {
        const controller = new AbortController();
        const sent = [];
        const job = {
          meta,
          signal: controller.signal,
          cancelled: false,
          sent,
          progress: (stage, progress, message) => sent.push({ stage, progress, message }),
          throwIfCancelled() {
            if (controller.signal.aborted) {
              const e = new Error('已取消');
              e.code = 'CANCELLED';
              throw e;
            }
          },
        };
        const entry = { kind, meta, job, promise: null };
        started.push(entry);
        entry.promise = fn(job);
        entry.promise.catch(() => {});
        return { jobId: `job${started.length}` };
      },
    },
  };
  const handlers = {};
  registerAI({ handle: (ch, fn) => { handlers[ch] = fn; }, ctx });
  return { root, handlers, calls, started };
}

// ───────────────────────── 1. aiPresets.cjs ─────────────────────────

test('aiPresets：包含全部 8 个 API 预设且字段完整、getPreset 支持查找与兜底', () => {
  const expectedIds = ['openai', 'deepseek', 'anthropic', 'gemini', 'openrouter', 'ark', 'ollama', 'lmstudio'];
  assert.equal(API_PRESETS.length, 8);
  assert.deepEqual(API_PRESETS.map((p) => p.id), expectedIds);

  for (const id of expectedIds) {
    const p = getPreset(id);
    assert.ok(p, `应找到预设 ${id}`);
    assert.equal(p.id, id);
    assert.ok(typeof p.name === 'string' && p.name.length > 0);
    assert.ok(p.protocol === 'openai' || p.protocol === 'anthropic');
    assert.match(p.baseUrl, /^https?:\/\//);
    assert.ok(typeof p.model === 'string' && p.model.length > 0);
    assert.equal(typeof p.requiresKey, 'boolean');
  }

  assert.equal(getPreset('ANTHROPIC').protocol, 'anthropic');
  assert.equal(getPreset('ollama').requiresKey, false);
  assert.equal(getPreset('lmstudio').requiresKey, false);
  assert.equal(getPreset('openai').requiresKey, true);
  assert.equal(getPreset('deepseek').requiresKey, true);
  assert.equal(getPreset('nonexistent'), null);
  assert.equal(getPreset(null), null);
});

test('aiPresets：isLocalKeylessUrl 严格区分本机回环地址与公网/伪造地址', () => {
  assert.equal(isLocalKeylessUrl('http://127.0.0.1:11434/v1'), true);
  assert.equal(isLocalKeylessUrl('http://127.0.0.1:1234/v1'), true);
  assert.equal(isLocalKeylessUrl('http://localhost:11434/v1'), true);
  assert.equal(isLocalKeylessUrl('http://[::1]:11434/v1'), true);
  assert.equal(isLocalKeylessUrl('https://localhost:8443/v1'), true);

  assert.equal(isLocalKeylessUrl('https://api.openai.com/v1'), false);
  assert.equal(isLocalKeylessUrl('https://api.anthropic.com/v1'), false);
  assert.equal(isLocalKeylessUrl('http://127.0.0.1.evil.example/v1'), false);
  assert.equal(isLocalKeylessUrl('http://192.168.1.10:11434/v1'), false);
  assert.equal(isLocalKeylessUrl('file://localhost/tmp/x'), false);
  assert.equal(isLocalKeylessUrl(''), false);
  assert.equal(isLocalKeylessUrl(null), false);
});

test('aiPresets：buildAnthropicRequest 与 parseAnthropicResponse 支持文本、base64 图片块、JSON 提取与用量统计', () => {
  assert.equal(anthropicMessagesUrl('https://api.anthropic.com/v1'), 'https://api.anthropic.com/v1/messages');
  assert.equal(anthropicMessagesUrl('https://api.anthropic.com/'), 'https://api.anthropic.com/v1/messages');
  assert.equal(anthropicMessagesUrl('https://proxy.example.com/v1/messages'), 'https://proxy.example.com/v1/messages');

  const hdrs = buildAnthropicHeaders('sk-ant-test');
  assert.equal(hdrs['x-api-key'], 'sk-ant-test');
  assert.equal(hdrs['anthropic-version'], ANTHROPIC_VERSION);
  assert.equal(hdrs['Content-Type'], 'application/json');

  // 文本 + base64 data URL 图片块 + schema
  const reqBody = buildAnthropicRequest({
    model: 'claude-sonnet-4-20250514',
    system: '你是视频导演助手',
    prompt: '分析这张画面并返回 JSON',
    schema: SCHEMA,
    images: ['data:image/png;base64,iVBORw0KGgo='],
    maxTokens: 2048,
  });
  assert.equal(reqBody.model, 'claude-sonnet-4-20250514');
  assert.equal(reqBody.max_tokens, 2048);
  assert.match(reqBody.system, /你是视频导演助手/);
  assert.match(reqBody.system, /"reply"/);
  assert.equal(reqBody.messages.length, 1);
  assert.equal(reqBody.messages[0].role, 'user');
  assert.ok(Array.isArray(reqBody.messages[0].content));
  assert.deepEqual(reqBody.messages[0].content[0], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
  });
  assert.deepEqual(reqBody.messages[0].content[1], {
    type: 'text',
    text: '分析这张画面并返回 JSON',
  });

  // 解析 Anthropic Messages 响应（含 Markdown 代码块包裹的 JSON + cache_read_input_tokens）
  const parsed = parseAnthropicResponse({
    id: 'msg_01',
    type: 'message',
    model: 'claude-sonnet-4-20250514',
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking', thinking: 'internal' },
      { type: 'text', text: '```json\n{"ok": true, "reply": "画面温暖柔和"}\n```' },
    ],
    usage: {
      input_tokens: 520,
      output_tokens: 45,
      cache_read_input_tokens: 300,
    },
  });
  assert.deepEqual(parsed.data, { ok: true, reply: '画面温暖柔和' });
  assert.equal(parsed.model, 'claude-sonnet-4-20250514');
  assert.equal(parsed.stopReason, 'end_turn');
  assert.deepEqual(parsed.usage, { input: 520, output: 45, cached: 300 });

  // 异常响应拒绝
  assert.throws(
    () => parseAnthropicResponse({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
    /invalid x-api-key/,
  );
  assert.throws(
    () => parseAnthropicResponse({ content: [{ type: 'text', text: 'not valid json at all' }] }),
    /无法解析/,
  );
});

// ───────────────────────── 2. agentCli.cjs ─────────────────────────

test('agentCli：AGENT_CLIS 定义 claude / codex / gemini 三种本地 CLI', () => {
  assert.deepEqual(Object.keys(AGENT_CLIS).sort(), ['claude', 'codex', 'gemini']);
  for (const id of ['claude', 'codex', 'gemini']) {
    assert.equal(AGENT_CLIS[id].id, id);
    assert.equal(AGENT_CLIS[id].bin, id);
    assert.ok(typeof AGENT_CLIS[id].name === 'string' && AGENT_CLIS[id].name.length > 0);
    assert.ok(typeof AGENT_CLIS[id].installHint === 'string' && AGENT_CLIS[id].installHint.length > 0);
  }
});

test('agentCli：validateCliModel 放行合法模型名，拒绝前导 - 与 Shell 元字符', () => {
  assert.equal(validateCliModel(''), null);
  assert.equal(validateCliModel(null), null);
  assert.equal(validateCliModel(undefined), null);
  assert.equal(validateCliModel('claude-sonnet-4-20250514'), 'claude-sonnet-4-20250514');
  assert.equal(validateCliModel('gemini-2.5-pro'), 'gemini-2.5-pro');
  assert.equal(validateCliModel('openai/gpt-4.1-mini'), 'openai/gpt-4.1-mini');
  assert.equal(validateCliModel('qwen2.5:14b'), 'qwen2.5:14b');

  const badModels = [
    '-m',
    '--output-format=text',
    'gpt-4;calc.exe',
    'model && whoami',
    'model | cat',
    'model`id`',
    'model$(id)',
    'model%PATH%',
    'model with space',
    'model\ninjected',
    'a'.repeat(129),
  ];
  for (const bad of badModels) {
    assert.throws(
      () => validateCliModel(bad),
      (err) => err && err.code === 'INVALID_MODEL',
      `应拒绝非法模型名: ${JSON.stringify(bad)}`,
    );
  }
});

test('agentCli：isValidCliPath 拒绝全部 UNC 变体与不匹配可执行名，接受本地合法 CLI 路径', () => {
  const uncVariants = [
    '\\\\evil.example\\share\\claude.exe',
    '//evil.example/share/claude.exe',
    '\\/evil.example\\share\\claude.exe',
    '/\\evil.example\\share\\claude.exe',
  ];
  for (const bad of uncVariants) {
    assert.equal(isValidCliPath('claude', bad), false, `claude 应拒绝 UNC: ${bad}`);
    assert.equal(isValidCliPath('gemini', bad.replace('claude', 'gemini')), false, `gemini 应拒绝 UNC: ${bad}`);
    assert.equal(isValidCliPath('codex', bad.replace('claude', 'codex')), false, `codex 应拒绝 UNC: ${bad}`);
  }

  // 不匹配基名拒绝
  for (const wrong of ['C:\\Windows\\System32\\cmd.exe', 'C:\\Windows\\System32\\powershell.exe', 'C:\\tools\\evil.exe', 'C:\\tools\\gemini.exe']) {
    assert.equal(isValidCliPath('claude', wrong), false, `claude 不应接受 ${wrong}`);
  }
  assert.equal(isValidCliPath('gemini', 'C:\\tools\\claude.exe'), false);
  assert.equal(isValidCliPath('unknown', 'C:\\tools\\claude.exe'), false);
  assert.equal(isValidCliPath('claude', 'C:\\tools\\claude.exe\0.txt'), false);

  // 拒绝相对路径、首尾空白、尾点路径段与 NTFS ADS 冒号
  const validClaudePath = path.join(os.tmpdir(), 'nonexistent-ff-dir', process.platform === 'win32' ? 'claude.exe' : 'claude');
  const validGeminiPath = path.join(os.tmpdir(), 'nonexistent-ff-dir', process.platform === 'win32' ? 'gemini.exe' : 'gemini');
  const validCodexPath = path.join(os.tmpdir(), 'nonexistent-ff-dir', process.platform === 'win32' ? 'codex.exe' : 'codex');

  for (const rel of ['claude.cmd', 'claude.exe', 'claude', './claude', 'sub/claude']) {
    assert.equal(isValidCliPath('claude', rel), false, `claude 应拒绝相对路径: ${rel}`);
  }
  assert.equal(isValidCliPath('codex', 'codex.exe'), false);
  assert.equal(isValidCliPath('gemini', 'gemini.cmd'), false);

  assert.equal(isValidCliPath('claude', ` ${validClaudePath}`), false, '应拒绝前导空格');
  assert.equal(isValidCliPath('claude', `${validClaudePath} `), false, '应拒绝尾部空格');
  assert.equal(isValidCliPath('codex', ` ${validCodexPath} `), false, 'codex 应拒绝首尾空格');

  const trailingDotDir = path.join(os.tmpdir(), 'ff-bad-dir.', process.platform === 'win32' ? 'claude.exe' : 'claude');
  const trailingSpaceDir = path.join(os.tmpdir(), 'ff-bad-dir ', process.platform === 'win32' ? 'codex.exe' : 'codex');
  assert.equal(isValidCliPath('claude', trailingDotDir), false, '应拒绝尾点路径段');
  assert.equal(isValidCliPath('claude', `${validClaudePath}.`), false, '应拒绝文件名尾点');
  assert.equal(isValidCliPath('codex', trailingSpaceDir), false, 'codex 应拒绝尾空格路径段');
  assert.equal(isValidCliPath('gemini', path.join(os.tmpdir(), 'dir.', process.platform === 'win32' ? 'gemini.cmd' : 'gemini')), false, 'gemini 应拒绝尾点路径段');

  const adsClaude = path.join(os.tmpdir(), 'ff-ads', `${process.platform === 'win32' ? 'claude.exe' : 'claude'}:stream`);
  const adsCodex = path.join(os.tmpdir(), 'ff-ads', `${process.platform === 'win32' ? 'codex.exe' : 'codex'}:$DATA`);
  const adsGemini = path.join(os.tmpdir(), 'ff-ads', 'dir:ads', process.platform === 'win32' ? 'gemini.cmd' : 'gemini');
  assert.equal(isValidCliPath('claude', adsClaude), false, 'claude 应拒绝 NTFS ADS 冒号');
  assert.equal(isValidCliPath('codex', adsCodex), false, 'codex 应拒绝 NTFS ADS 冒号');
  assert.equal(isValidCliPath('gemini', adsGemini), false, 'gemini 应拒绝 NTFS ADS 冒号');

  // 本地合法路径接受（不存在时做路径静态校验，存在时验证 realpath；兼容 Windows 与 Linux）
  assert.equal(isValidCliPath('claude', validClaudePath), true);
  assert.equal(isValidCliPath('gemini', validGeminiPath), true);
  assert.equal(isValidCliPath('codex', validCodexPath), true);
  if (process.platform === 'win32') {
    assert.equal(isValidCliPath('claude', 'C:\\nonexistent-ff-dir\\claude.exe'), true);
    assert.equal(isValidCliPath('claude', 'C:\\nonexistent-ff-dir\\claude.cmd'), true);
    assert.equal(isValidCliPath('gemini', 'C:\\nonexistent-ff-dir\\gemini.cmd'), true);
    assert.equal(isValidCliPath('codex', 'C:\\nonexistent-ff-dir\\codex.exe'), true);
  } else {
    assert.equal(isValidCliPath('claude', '/nonexistent-ff-dir/claude'), true);
    assert.equal(isValidCliPath('gemini', '/nonexistent-ff-dir/gemini'), true);
    assert.equal(isValidCliPath('codex', '/nonexistent-ff-dir/codex'), true);
  }

  // 真实存在的本地 .cmd shim 同样通过校验，且在 Windows 上直接由 resolveCmdShim 解析为 node + 脚本
  const dir = makeTmpDir('ff-cli-shim-');
  const fakeScript = path.join(dir, 'fake-claude.cjs');
  fs.writeFileSync(fakeScript, `'use strict';
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    type: 'result',
    model: 'claude-sonnet-4-20250514',
    result: JSON.stringify({ ok: true, reply: 'claude-shim-ok' }),
    usage: { input_tokens: 120, cache_read_input_tokens: 40, output_tokens: 18 },
  }));
});
`, 'utf8');
  const shimPath = process.platform === 'win32' ? path.join(dir, 'claude.cmd') : path.join(dir, 'claude');
  if (process.platform === 'win32') {
    fs.writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "%~dp0fake-claude.cjs" %*\r\n`, 'utf8');
    const resolvedShim = codex._internals.resolveCmdShim(shimPath);
    assert.ok(resolvedShim, 'Windows 下 resolveCmdShim 应能直接解析 "%~dp0fake-claude.cjs" 包装脚本');
    assert.match(path.basename(resolvedShim.bin), /^node(?:js)?\.exe$/i);
    assert.deepEqual(resolvedShim.prefixArgs, [fs.realpathSync(fakeScript)]);
  } else {
    fs.writeFileSync(shimPath, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-claude.cjs" "$@"\n`, 'utf8');
    fs.chmodSync(shimPath, 0o755);
    assert.equal(codex._internals.resolveCmdShim(shimPath), null);
  }
  assert.equal(isValidCliPath('claude', shimPath), true);
});

test('agentCli：runAgentCli 可通过本地假 claude shim 完成 JSON 解析与用量提取', async () => {
  const dir = makeTmpDir('ff-cli-run-');
  const fakeScript = path.join(dir, 'fake-claude.cjs');
  fs.writeFileSync(fakeScript, `'use strict';
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    type: 'result',
    model: 'claude-sonnet-4-20250514',
    result: JSON.stringify({ ok: true, reply: 'cli-ok' }),
    usage: { input_tokens: 200, cache_read_input_tokens: 50, output_tokens: 25 },
  }));
});
`, 'utf8');
  const shimPath = process.platform === 'win32' ? path.join(dir, 'claude.cmd') : path.join(dir, 'claude');
  if (process.platform === 'win32') {
    fs.writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "%~dp0fake-claude.cjs" %*\r\n`, 'utf8');
  } else {
    fs.writeFileSync(shimPath, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-claude.cjs" "$@"\n`, 'utf8');
    fs.chmodSync(shimPath, 0o755);
  }

  const res = await runAgentCli('claude', {
    cliPath: shimPath,
    model: 'claude-sonnet-4-20250514',
    system: 'sys',
    prompt: 'hi',
    schema: SCHEMA,
    tmpRoot: dir,
    timeoutMs: 30000,
  });
  assert.deepEqual(res.data, { ok: true, reply: 'cli-ok' });
  assert.equal(res.model, 'claude-sonnet-4-20250514');
  assert.deepEqual(res.usage, { inputTokens: 200, cachedInputTokens: 50, outputTokens: 25, reasoningTokens: 0 });
});

// ───────────────────────── 3. electron/ipc/ai.cjs API-first 路由 ─────────────────────────

test('ai:presets：返回全部 8 个 API 预设与 3 个 CLI 元数据', async () => {
  const s = setupAiIpc();
  const res = await s.handlers['ai:presets']();
  assert.equal(res.api.length, 8);
  assert.equal(res.cli.length, 3);
  assert.deepEqual(res.cli.map((c) => c.id).sort(), ['claude', 'codex', 'gemini']);
});

test('ai.cjs auto 路由：API Key + 模型已配置且 Codex 就绪时，优先走 API 而非 Codex', async () => {
  let codexProbed = 0;
  const s = setupAiIpc({
    ai: {
      provider: 'auto',
      apiPreset: 'openai',
      openaiBaseUrl: 'https://api.openai.com/v1',
      openaiModel: 'gpt-4.1-mini',
    },
    secrets: { openaiKey: 'sk-test-priority' },
    detectCodex: async () => {
      codexProbed += 1;
      return { ok: true, loggedIn: true, path: 'C:\\mock\\codex.exe', version: '0.99.0' };
    },
    responses: [
      jsonResponse(200, {
        choices: [{ message: { content: JSON.stringify({ ok: true, reply: 'from-api' }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
    ],
  });

  const status = await s.handlers['ai:status']();
  assert.equal(status.provider, 'openai', 'auto 模式下 API 必须优先于 Codex');
  assert.equal(status.ready, true);
  assert.equal(status.model, 'gpt-4.1-mini');

  await s.handlers['ai:run']({ task: 'director', system: 's', prompt: 'p', schema: SCHEMA });
  const out = await s.started[0].promise;
  assert.equal(out.provider, 'openai');
  assert.deepEqual(out.data, { ok: true, reply: 'from-api' });
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(s.calls[0].headers.Authorization, 'Bearer sk-test-priority');
  assert.equal(codexProbed, 0, 'API 已就绪时 auto 模式不应白探测 Codex');
});

test('ai.cjs auto 路由：本机 Ollama（http://127.0.0.1:11434/v1）无 API Key 仍判定已配置并直连本地 API', async () => {
  const s = setupAiIpc({
    ai: {
      provider: 'auto',
      apiPreset: 'ollama',
      openaiBaseUrl: 'http://127.0.0.1:11434/v1',
      openaiModel: 'qwen2.5:14b',
    },
    secrets: {}, // 故意不填任何 API Key
    detectCodex: async () => ({ ok: true, loggedIn: true, path: 'C:\\mock\\codex.exe', version: '0.99.0' }),
    responses: [
      jsonResponse(200, {
        choices: [{ message: { content: JSON.stringify({ ok: true, reply: 'from-ollama' }) } }],
        usage: { prompt_tokens: 80, completion_tokens: 15 },
      }),
    ],
  });

  const status = await s.handlers['ai:status']();
  assert.equal(status.provider, 'openai');
  assert.equal(status.ready, true);
  assert.equal(status.api.configured, true);
  assert.equal(status.api.keylessLocal, true);

  await s.handlers['ai:run']({ task: 'director', system: 's', prompt: 'p', schema: SCHEMA });
  const out = await s.started[0].promise;
  assert.equal(out.provider, 'openai');
  assert.equal(out.model, 'qwen2.5:14b');
  assert.deepEqual(out.data, { ok: true, reply: 'from-ollama' });
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(s.calls[0].headers.Authorization, undefined, '免密钥本地服务不发送 Authorization 头');
});

test('ai.cjs auto 路由：protocol 为 anthropic 时调用 /v1/messages 并携带 x-api-key 与 anthropic-version 请求头', async () => {
  const s = setupAiIpc({
    ai: {
      provider: 'auto',
      apiPreset: 'anthropic',
      apiProtocol: 'anthropic',
      openaiBaseUrl: 'https://api.anthropic.com/v1',
      openaiModel: 'claude-sonnet-4-20250514',
    },
    secrets: { anthropicKey: 'sk-ant-live-test' },
    detectCodex: async () => ({ ok: true, loggedIn: true, path: 'C:\\mock\\codex.exe', version: '0.99.0' }),
    responses: [
      jsonResponse(200, {
        id: 'msg_99',
        type: 'message',
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({ ok: true, reply: 'from-anthropic' }) }],
        usage: { input_tokens: 400, output_tokens: 30, cache_read_input_tokens: 150 },
      }),
    ],
  });

  const status = await s.handlers['ai:status']();
  assert.equal(status.provider, 'anthropic');
  assert.equal(status.protocol, 'anthropic');
  assert.equal(status.ready, true);

  await s.handlers['ai:run']({ task: 'director', system: '导演系统提示', prompt: '给个镜头建议', schema: SCHEMA });
  const out = await s.started[0].promise;
  assert.equal(out.provider, 'anthropic');
  assert.equal(out.model, 'claude-sonnet-4-20250514');
  assert.deepEqual(out.data, { ok: true, reply: 'from-anthropic' });
  assert.deepEqual(out.usage, { inputTokens: 400, cachedInputTokens: 150, outputTokens: 30, reasoningTokens: 0 });

  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(s.calls[0].headers['x-api-key'], 'sk-ant-live-test');
  assert.equal(s.calls[0].headers['anthropic-version'], ANTHROPIC_VERSION);
  assert.equal(s.calls[0].headers.Authorization, undefined);
  assert.equal(s.calls[0].body.model, 'claude-sonnet-4-20250514');
  assert.ok(s.calls[0].body.max_tokens > 0);
});

test('ai.cjs：307 跨域重定向被拒绝，攻击服务器收到 0 请求且零 x-api-key 泄露', async () => {
  const originHits = [];
  const attackerHits = [];

  const attackerSrv = http.createServer((req, res) => {
    attackerHits.push({ url: req.url, method: req.method, headers: { ...req.headers } });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ stolen: true }));
  });

  let attackerUrl = '';
  const originSrv = http.createServer((req, res) => {
    originHits.push({ url: req.url, method: req.method, hasKey: Boolean(req.headers['x-api-key']) });
    res.writeHead(307, { Location: `${attackerUrl}/v1/messages` });
    res.end();
  });

  let s;
  try {
    await new Promise((resolve) => attackerSrv.listen(0, '127.0.0.1', resolve));
    const attackerPort = attackerSrv.address().port;
    attackerUrl = `http://127.0.0.1:${attackerPort}`;

    await new Promise((resolve) => originSrv.listen(0, '127.0.0.1', resolve));
    const originPort = originSrv.address().port;
    const originBaseUrl = `http://127.0.0.1:${originPort}/v1`;

    s = setupAiIpc({
      useRealFetch: true,
      ai: {
        provider: 'anthropic',
        apiPreset: 'anthropic',
        apiProtocol: 'anthropic',
        openaiBaseUrl: originBaseUrl,
        openaiModel: 'claude-sonnet-4-20250514',
      },
      secrets: { anthropicKey: 'sk-ant-top-secret-do-not-leak' },
    });

    const res = await s.handlers['ai:test']({ provider: 'anthropic' });
    assert.equal(res.ok, false, '跨域 307 重定向必须被拒绝');
    assert.match(res.detail, /跨域重定向|凭据泄露/);
    assert.equal(originHits.length, 1, '原始服务器应仅收到 1 次请求');
    assert.equal(originHits[0].hasKey, true);
    assert.equal(attackerHits.length, 0, '攻击服务器不得收到任何请求（零 x-api-key 泄露）');
  } finally {
    await Promise.all([
      new Promise((resolve) => originSrv.close(() => resolve())),
      new Promise((resolve) => attackerSrv.close(() => resolve())),
    ]);
    if (s && s.root) try { fs.rmSync(s.root, { recursive: true, force: true }); } catch {}
  }
});

test('ai.cjs：Ollama 预设即使残留 openaiKey 也不发送 Authorization；自定义 apiPreset 为空串时原样保留', async () => {
  // 1) Ollama 预设 + 残留 openaiKey：不得向本地接口发送 Authorization 头
  const ollama = setupAiIpc({
    ai: {
      provider: 'auto',
      apiPreset: 'ollama',
      openaiBaseUrl: 'http://127.0.0.1:11434/v1',
      openaiModel: 'qwen2.5:14b',
    },
    secrets: { openaiKey: 'sk-leftover-openai-secret' },
    responses: [
      jsonResponse(200, {
        choices: [{ message: { content: JSON.stringify({ ok: true, reply: 'ollama-clean' }) } }],
        usage: { prompt_tokens: 40, completion_tokens: 10 },
      }),
    ],
  });
  let custom;
  try {
    const ollamaStatus = await ollama.handlers['ai:status']();
    assert.equal(ollamaStatus.ready, true);
    assert.equal(ollamaStatus.provider, 'openai');
    assert.equal(ollamaStatus.api.keylessLocal, true);

    await ollama.handlers['ai:run']({ task: 'director', system: 's', prompt: 'p', schema: SCHEMA });
    const out = await ollama.started[0].promise;
    assert.deepEqual(out.data, { ok: true, reply: 'ollama-clean' });
    assert.equal(ollama.calls.length, 1);
    assert.equal(ollama.calls[0].headers.Authorization, undefined, 'Ollama 预设存在残留 openaiKey 时绝不能发送 Authorization 头');
    assert.equal(ollama.calls[0].headers.authorization, undefined);

    // 2) apiPreset 显式为空字符串时，ai:status 必须保留 '' 而不是回退成 'openai'
    custom = setupAiIpc({
      ai: {
        provider: 'openai',
        apiPreset: '',
        openaiBaseUrl: 'https://custom-gateway.example.com/v1',
        openaiModel: 'custom-chat-v1',
      },
      secrets: { openaiKey: 'sk-custom-key' },
    });
    const customStatus = await custom.handlers['ai:status']();
    assert.equal(customStatus.preset, '');
    assert.equal(customStatus.api.preset, '');
    assert.equal(customStatus.openai.preset, '');
    assert.equal(customStatus.ready, true);

    // 3) 自定义本机回环鉴权代理（apiPreset: '' + 127.0.0.1 + 显式 openaiKey）：必须正常携带 Authorization
    const localProxy = setupAiIpc({
      ai: {
        provider: 'openai',
        apiPreset: '',
        openaiBaseUrl: 'http://127.0.0.1:4000/v1',
        openaiModel: 'litellm-claude',
      },
      secrets: { openaiKey: 'sk-litellm-proxy-secret' },
      responses: [
        jsonResponse(200, {
          choices: [{ message: { content: JSON.stringify({ ok: true, reply: 'from-local-proxy' }) } }],
          usage: { prompt_tokens: 20, completion_tokens: 8 },
        }),
      ],
    });
    try {
      await localProxy.handlers['ai:run']({ task: 'director', system: 's', prompt: 'p', schema: SCHEMA });
      const proxyOut = await localProxy.started[0].promise;
      assert.deepEqual(proxyOut.data, { ok: true, reply: 'from-local-proxy' });
      assert.equal(localProxy.calls.length, 1);
      assert.equal(localProxy.calls[0].headers.Authorization, 'Bearer sk-litellm-proxy-secret');
    } finally {
      try { fs.rmSync(localProxy.root, { recursive: true, force: true }); } catch {}
    }
  } finally {
    try { fs.rmSync(ollama.root, { recursive: true, force: true }); } catch {}
    if (custom && custom.root) try { fs.rmSync(custom.root, { recursive: true, force: true }); } catch {}
  }
});
