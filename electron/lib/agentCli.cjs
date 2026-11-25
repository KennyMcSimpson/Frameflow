'use strict';
// 本地 AI Agent CLI 统一适配层（Claude Code / Codex CLI / Gemini CLI）。
// 纯 Node 模块，零 Electron 依赖；安全护栏与 codex.cjs 保持完全一致。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const codex = require('./codex.cjs');

const {
  isUncPath,
  hasNtfsAdsColon,
  hasTrailingDotOrSpaceSegment,
  isAbsoluteCliPath,
  resolveCmdShim,
  quoteForCmd,
  killTree,
  parseJsonLoose,
  normalizeUsage: normalizeCodexUsage,
  isValidCodexPath,
} = codex._internals;

const IS_WIN = process.platform === 'win32';
const DETECT_CACHE_MS = 30 * 1000;
const DEFAULT_TIMEOUT_MS = 240 * 1000;
const PROBE_TIMEOUT_MS = 15 * 1000;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;

const AGENT_CLIS = Object.freeze({
  claude: Object.freeze({
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude',
    installHint: 'npm install -g @anthropic-ai/claude-code',
  }),
  codex: Object.freeze({
    id: 'codex',
    name: 'Codex CLI',
    bin: 'codex',
    installHint: 'npm install -g @openai/codex',
  }),
  gemini: Object.freeze({
    id: 'gemini',
    name: 'Gemini CLI',
    bin: 'gemini',
    installHint: 'npm install -g @google/gemini-cli',
  }),
});

const CLI_BIN_RE = Object.freeze({
  claude: /^claude(\.exe|\.cmd|\.bat)?$/i,
  gemini: /^gemini(\.exe|\.cmd|\.bat)?$/i,
});

const CLI_MODEL_RE = /^[A-Za-z0-9._:/-]{1,128}$/;

function isFile(p) {
  try { return !!p && !isUncPath(p) && fs.statSync(p).isFile(); } catch { return false; }
}

function needsShell(bin) {
  return IS_WIN && /\.(cmd|bat)$/i.test(String(bin || ''));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function tail(text, n = 400) {
  const s = String(text || '').trim();
  return s.length > n ? '…' + s.slice(-n) : s;
}

function cancelledError() {
  const e = new Error('已取消');
  e.code = 'CANCELLED';
  return e;
}

function readSettings(settings) {
  if (!settings) return {};
  try {
    if (typeof settings.get === 'function') return settings.get() || {};
  } catch {
    return {};
  }
  return settings;
}

/**
 * 校验模型名称：仅允许字母、数字及 . _ : / -，长度 1–128，且不能以 - 开头（防参数注入）。
 */
function validateCliModel(model) {
  if (model == null || model === '') return null;
  const s = String(model).trim();
  if (!s) return null;
  if (!CLI_MODEL_RE.test(s) || s.startsWith('-')) {
    const e = new Error('CLI 模型名称无效：仅允许字母、数字及 . _ : / -（不超过 128 个字符，且不能以 - 开头）');
    e.code = 'INVALID_MODEL';
    throw e;
  }
  return s;
}

/**
 * 校验自定义 CLI 可执行路径：
 * - 在 trim/path.resolve 及任何 fs.* 之前拒绝首尾空白、控制字符、UNC、相对路径、尾点/尾空格路径段及 NTFS ADS 冒号
 * - 校验可执行文件名精确匹配对应 CLI（claude / gemini / codex）
 * - 若路径已存在，校验 realpath 非 UNC/ADS/尾点空格且指向合法可执行文件或可解析的标准 npm .cmd shim
 */
function isValidCliPath(kind, p, { allowTestBin = false } = {}) {
  const k = String(kind || '').trim().toLowerCase();
  if (k === 'codex') return isValidCodexPath(p, { allowTestBin });
  const binRe = CLI_BIN_RE[k];
  if (!binRe) return false;
  if (typeof p !== 'string' || !p) return false;
  if (/[\r\n\0]/.test(p)) return false;
  if (p !== p.trim()) return false;
  if (isUncPath(p)) return false;
  if (!isAbsoluteCliPath(p)) return false;
  if (hasNtfsAdsColon(p) || hasTrailingDotOrSpaceSegment(p)) return false;
  const resolved = path.resolve(p);
  if (isUncPath(resolved) || hasNtfsAdsColon(resolved) || hasTrailingDotOrSpaceSegment(resolved)) return false;
  if (allowTestBin) {
    try {
      const real = fs.realpathSync(resolved);
      if (isUncPath(real) || hasNtfsAdsColon(real) || hasTrailingDotOrSpaceSegment(real)) return false;
    } catch (e) {
      if (e && e.code !== 'ENOENT') return false;
    }
    return true;
  }
  if (!binRe.test(path.basename(p)) || !binRe.test(path.basename(resolved))) return false;
  let exists = false;
  try {
    fs.lstatSync(resolved);
    exists = true;
  } catch (e) {
    if (e && e.code !== 'ENOENT') return false;
  }
  if (exists) {
    let real;
    try { real = fs.realpathSync(resolved); } catch { return false; }
    if (isUncPath(real) || hasNtfsAdsColon(real) || hasTrailingDotOrSpaceSegment(real)) return false;
    if (!binRe.test(path.basename(real))) {
      if (!(/\.cmd$/i.test(resolved) && resolveCmdShim(real))) return false;
    }
  }
  return true;
}

/**
 * 安全执行子进程：
 * - Windows npm `.cmd` shim 解析为 `node <script>` + `shell: false`
 * - 其余 `.cmd`/`.bat` 回退时经 `quoteForCmd` 严格拒绝 `%` 及批处理元字符
 * - 超时或取消通过 `System32\taskkill.exe /T /F` 终止整棵进程树
 */
function execCli(bin, args, { input, timeoutMs, signal, cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      const shim = needsShell(bin) ? resolveCmdShim(bin) : null;
      const shell = !shim && needsShell(bin);
      const cmd = shim ? shim.bin : (shell ? [bin, ...args].map(quoteForCmd).join(' ') : bin);
      const finalArgs = shim ? [...shim.prefixArgs, ...args] : (shell ? [] : args);
      child = spawn(cmd, finalArgs, {
        cwd,
        env: { ...process.env, NO_COLOR: '1', ...(env || {}) },
        windowsHide: true,
        shell,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      reject(e);
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let timer = null;
    const cap = (s, max) => (s.length > max ? s.slice(-max) : s);
    const onAbort = () => { cancelled = true; killTree(child); };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (s) => { stdout = cap(stdout + s, MAX_STDOUT_BYTES); });
    child.stderr.on('data', (s) => { stderr = cap(stderr + s, MAX_STDERR_BYTES); });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code: code == null ? -1 : code, stdout, stderr, timedOut, cancelled });
    });

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    if (timeoutMs) {
      timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    }
    child.stdin.on('error', () => {});
    if (input != null) child.stdin.end(input, 'utf8');
    else child.stdin.end();
  });
}

// ───────────────────────── 路径与版本探测 ─────────────────────────

async function whereBin(binName) {
  try {
    const winWhere = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'where.exe');
    const locator = IS_WIN ? (isFile(winWhere) ? winWhere : 'where.exe') : 'which';
    const r = await execCli(locator, [binName], { timeoutMs: PROBE_TIMEOUT_MS });
    if (r.code !== 0) return [];
    const list = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).filter(isFile);
    const rank = (p) => (/\.exe$/i.test(p) ? 0 : /\.(cmd|bat)$/i.test(p) ? 1 : 2);
    return list.filter((p) => !IS_WIN || rank(p) < 2).sort((a, b) => rank(a) - rank(b));
  } catch {
    return [];
  }
}

function commonCliPaths(kind) {
  const out = [];
  const home = os.homedir();
  const appData = process.env.APPDATA || '';
  const localAppData = process.env.LOCALAPPDATA || '';
  if (kind === 'claude') {
    if (IS_WIN) {
      if (home) out.push(path.join(home, '.local', 'bin', 'claude.exe'));
      if (localAppData) out.push(path.join(localAppData, 'Programs', 'claude', 'claude.exe'));
      if (appData) out.push(path.join(appData, 'npm', 'claude.cmd'));
    } else if (home) {
      out.push(path.join(home, '.local', 'bin', 'claude'));
      out.push(path.join(home, '.npm-global', 'bin', 'claude'));
    }
  } else if (kind === 'gemini') {
    if (IS_WIN) {
      if (appData) out.push(path.join(appData, 'npm', 'gemini.cmd'));
      if (home) out.push(path.join(home, '.local', 'bin', 'gemini.exe'));
    } else if (home) {
      out.push(path.join(home, '.local', 'bin', 'gemini'));
      out.push(path.join(home, '.npm-global', 'bin', 'gemini'));
    }
  }
  return out;
}

async function candidateCliPaths(kind, settingsStore) {
  const s = readSettings(settingsStore);
  const ai = (s && s.ai) || {};
  const fromSettings = kind === 'claude'
    ? (typeof ai.claudePath === 'string' ? ai.claudePath.trim() : '')
    : kind === 'gemini'
      ? (typeof ai.geminiPath === 'string' ? ai.geminiPath.trim() : '')
      : '';
  const envKey = kind === 'claude' ? 'CLAUDE_CLI_PATH' : kind === 'gemini' ? 'GEMINI_CLI_PATH' : '';
  const fromEnv = envKey && process.env[envKey] ? String(process.env[envKey]).trim() : '';

  const out = [];
  const push = (p) => {
    if (p && isValidCliPath(kind, p) && !out.some((x) => x.toLowerCase() === p.toLowerCase())) out.push(p);
  };
  if (fromSettings) push(fromSettings);
  if (fromEnv) push(fromEnv);
  for (const p of commonCliPaths(kind)) push(p);
  const meta = AGENT_CLIS[kind];
  if (meta) {
    for (const p of await whereBin(meta.bin)) push(p);
  }
  return out;
}

async function probeCliVersion(bin) {
  try {
    const r = await execCli(bin, ['--version'], { timeoutMs: PROBE_TIMEOUT_MS });
    if (r.code !== 0) return null;
    const line = (r.stdout || r.stderr).trim().split(/\r?\n/)[0] || '';
    const m = /(\d+\.\d+\.\d+[\w.+-]*)/.exec(line);
    return m ? m[1] : (line || 'unknown');
  } catch {
    return null;
  }
}

const detectCaches = new Map(); // kind -> { key, at, promise }

async function detectCliUncached(kind, settingsStore) {
  const candidates = await candidateCliPaths(kind, settingsStore);
  const existing = candidates.filter(isFile);
  for (const p of existing) {
    const version = await probeCliVersion(p);
    if (version) {
      return { id: kind, ok: true, path: p, version, loggedIn: true };
    }
  }
  return { id: kind, ok: false, path: existing[0] || null, version: null, loggedIn: false };
}

/**
 * 探测单个本地 Agent CLI（结果缓存 30 秒，永不抛错）。
 * @param {'claude'|'codex'|'gemini'} kind
 * @param {object} settingsStore
 * @param {{force?:boolean}} [opts]
 * @returns {Promise<{id:string, ok:boolean, path:string|null, version:string|null, loggedIn:boolean}>}
 */
async function detectAgentCli(kind, settingsStore, opts = {}) {
  const k = String(kind || '').trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(AGENT_CLIS, k)) {
    return { id: k, ok: false, path: null, version: null, loggedIn: false };
  }
  if (k === 'codex') {
    const r = await codex.detectCodex(settingsStore, opts);
    return { id: 'codex', ok: !!r.ok, path: r.path || null, version: r.version || null, loggedIn: !!r.loggedIn };
  }
  try {
    const s = readSettings(settingsStore);
    const ai = (s && s.ai) || {};
    const customPath = k === 'claude' ? (ai.claudePath || '') : (ai.geminiPath || '');
    const envPath = k === 'claude' ? (process.env.CLAUDE_CLI_PATH || '') : (process.env.GEMINI_CLI_PATH || '');
    const key = `${customPath}|${envPath}`;
    const now = Date.now();
    const cached = detectCaches.get(k);
    if (!opts.force && cached && cached.key === key && now - cached.at < DETECT_CACHE_MS) {
      return await cached.promise;
    }
    const promise = detectCliUncached(k, settingsStore)
      .catch(() => ({ id: k, ok: false, path: null, version: null, loggedIn: false }));
    detectCaches.set(k, { key, at: now, promise });
    return await promise;
  } catch {
    return { id: k, ok: false, path: null, version: null, loggedIn: false };
  }
}

async function detectAllAgentClis(settingsStore, opts = {}) {
  const [claudeInfo, codexInfo, geminiInfo] = await Promise.all([
    detectAgentCli('claude', settingsStore, opts),
    detectAgentCli('codex', settingsStore, opts),
    detectAgentCli('gemini', settingsStore, opts),
  ]);
  return { claude: claudeInfo, codex: codexInfo, gemini: geminiInfo };
}

function clearDetectCache() {
  detectCaches.clear();
  codex._internals.clearDetectCache();
}

// ───────────────────────── 提示词、参数与输出解析 ─────────────────────────

function buildCliPrompt({ system, prompt, schema }) {
  const parts = [];
  if (system != null && String(system).trim()) parts.push(String(system).trim());
  if (prompt != null && String(prompt).trim()) parts.push(String(prompt).trim());
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    parts.push(
      '【输出格式要求】请只输出一个严格符合以下 JSON Schema 的 JSON 对象，不要输出任何解释、Markdown 或代码块标记：\n'
      + JSON.stringify(schema),
    );
  }
  return parts.join('\n\n');
}

function buildClaudeArgs({ model } = {}) {
  const validModel = validateCliModel(model);
  const args = ['-p', '--output-format', 'json', '--no-session-persistence'];
  if (validModel) args.push('--model', validModel);
  return args;
}

function buildGeminiArgs({ model } = {}) {
  const validModel = validateCliModel(model);
  const args = ['-p', '', '--output-format', 'json'];
  if (validModel) args.push('-m', validModel);
  return args;
}

function normalizeCliUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const src = u.total_token_usage && typeof u.total_token_usage === 'object' ? u.total_token_usage : u;
  const usage = {
    inputTokens: num(src.input_tokens ?? src.inputTokens ?? src.prompt_tokens ?? src.prompt ?? src.input),
    cachedInputTokens: num(
      src.cache_read_input_tokens
      ?? src.cached_input_tokens
      ?? src.cachedInputTokens
      ?? src.cached
      ?? src.cached_tokens
      ?? (src.prompt_tokens_details && src.prompt_tokens_details.cached_tokens),
    ),
    outputTokens: num(src.output_tokens ?? src.outputTokens ?? src.completion_tokens ?? src.candidates ?? src.output),
    reasoningTokens: num(
      src.reasoning_output_tokens
      ?? src.reasoningTokens
      ?? src.thoughts
      ?? (src.completion_tokens_details && src.completion_tokens_details.reasoning_tokens),
    ),
  };
  return usage.inputTokens || usage.outputTokens || usage.cachedInputTokens ? usage : null;
}

function extractEnvelopeJson(stdout) {
  const raw = String(stdout || '').replace(/^\uFEFF/, '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  // 兼容前置日志行或 NDJSON 输出：优先从末尾向前找 JSON 对象
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i][0] !== '{') continue;
    try {
      const obj = JSON.parse(lines[i]);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    } catch {}
  }
  const a = raw.indexOf('{');
  const b = raw.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      const obj = JSON.parse(raw.slice(a, b + 1));
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    } catch {}
  }
  return null;
}

function parseClaudeOutput(stdout) {
  const env = extractEnvelopeJson(stdout);
  let usage = null;
  let model = '';
  let payloadText = stdout;

  if (env && (env.type === 'result' || 'result' in env || 'is_error' in env || 'structured_output' in env)) {
    if (env.is_error === true) {
      const msg = typeof env.result === 'string' && env.result.trim()
        ? env.result.trim()
        : (env.error && (env.error.message || String(env.error))) || 'Claude Code 执行失败';
      const e = new Error(msg);
      e.code = 'CLI_FAILED';
      throw e;
    }
    usage = normalizeCliUsage(env.usage);
    if (!usage && env.modelUsage && typeof env.modelUsage === 'object') {
      const models = Object.keys(env.modelUsage);
      if (models.length) {
        model = models[0];
        let inp = 0; let out = 0; let cached = 0;
        for (const m of models) {
          const mu = env.modelUsage[m];
          if (!mu || typeof mu !== 'object') continue;
          inp += num(mu.inputTokens ?? mu.input_tokens);
          out += num(mu.outputTokens ?? mu.output_tokens);
          cached += num(mu.cacheReadInputTokens ?? mu.cache_read_input_tokens);
        }
        if (inp || out || cached) usage = { inputTokens: inp, cachedInputTokens: cached, outputTokens: out, reasoningTokens: 0 };
      }
    }
    if (!model && typeof env.model === 'string') model = env.model;
    if (!model && env.modelUsage && typeof env.modelUsage === 'object') {
      model = Object.keys(env.modelUsage)[0] || '';
    }
    if (env.structured_output && typeof env.structured_output === 'object' && !Array.isArray(env.structured_output)) {
      return { data: env.structured_output, usage, model };
    }
    if (env.result && typeof env.result === 'object' && !Array.isArray(env.result)) {
      return { data: env.result, usage, model };
    }
    payloadText = env.result != null ? String(env.result) : '';
  }

  const data = parseJsonLoose(payloadText);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('AI 返回的不是 JSON 对象');
  }
  return { data, usage, model };
}

function parseGeminiOutput(stdout) {
  const env = extractEnvelopeJson(stdout);
  let usage = null;
  let model = '';
  let payloadText = stdout;

  if (env && ('response' in env || 'stats' in env || 'error' in env)) {
    if (env.error) {
      const msg = typeof env.error === 'string'
        ? env.error
        : (env.error.message || JSON.stringify(env.error));
      const e = new Error(String(msg || 'Gemini CLI 执行失败'));
      e.code = 'CLI_FAILED';
      throw e;
    }
    if (env.stats && env.stats.models && typeof env.stats.models === 'object') {
      const models = Object.keys(env.stats.models);
      if (models.length) model = models[0];
      let inp = 0; let out = 0; let cached = 0; let reasoning = 0;
      for (const m of models) {
        const entry = env.stats.models[m];
        const t = entry && entry.tokens && typeof entry.tokens === 'object' ? entry.tokens : entry;
        if (!t || typeof t !== 'object') continue;
        inp += num(t.prompt ?? t.input ?? t.input_tokens ?? t.inputTokens);
        out += num(t.candidates ?? t.output ?? t.output_tokens ?? t.outputTokens);
        cached += num(t.cached ?? t.cached_tokens ?? t.cached_input_tokens ?? t.cachedInputTokens);
        reasoning += num(t.thoughts ?? t.reasoning ?? t.reasoning_tokens ?? t.reasoningTokens);
      }
      if (inp || out || cached) {
        usage = { inputTokens: inp, cachedInputTokens: cached, outputTokens: out, reasoningTokens: reasoning };
      }
    }
    if (!usage && env.usage) {
      usage = normalizeCliUsage(env.usage) || normalizeCodexUsage(env.usage);
    }
    if (!model && typeof env.model === 'string') model = env.model;
    if (env.response && typeof env.response === 'object' && !Array.isArray(env.response)) {
      return { data: env.response, usage, model };
    }
    if (typeof env.response === 'string') {
      payloadText = env.response;
    }
  }

  const data = parseJsonLoose(payloadText);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('AI 返回的不是 JSON 对象');
  }
  return { data, usage, model };
}

function looksNotLoggedIn(text) {
  const s = String(text || '');
  return /not\s+logged\s+in|please\s+(?:run\s+)?(?:log\s*in|login)|login\s+required|unauthori[sz]ed|\b401\b|authentication\s+(?:failed|required)|invalid\s+api\s*key|missing\s+api\s*key|ANTHROPIC_API_KEY|GEMINI_API_KEY/i.test(s);
}

function cliFailure(kind, code, diag) {
  const name = (AGENT_CLIS[kind] && AGENT_CLIS[kind].name) || kind;
  const bin = (AGENT_CLIS[kind] && AGENT_CLIS[kind].bin) || kind;
  if (looksNotLoggedIn(diag)) {
    const e = new Error(`${name} 未登录或凭据无效：请在终端运行 ${bin} 完成登录`);
    e.code = 'CLI_LOGIN';
    return e;
  }
  const raw = tail(diag, 400);
  let msg = `${name} 执行失败（退出码 ${code}）`;
  if (/\b429\b|rate.?limit|usage limit|quota|too many requests/i.test(diag)) {
    msg = `${name} 的使用额度暂时用完或请求太频繁，请稍后再试`;
  } else if (/connection (?:reset|refused|closed)|timed? ?out|ENOTFOUND|ECONNRESET|network|fetch failed/i.test(diag)) {
    msg = `${name} 连不上服务器：请检查网络后重试`;
  } else if (/\b5\d\d\b|internal server error|service unavailable|overloaded/i.test(diag)) {
    msg = `${name} 服务暂时不可用，请稍后重试`;
  } else if (/model[^\n]*(?:not found|does not exist|not supported)|unknown model/i.test(diag)) {
    msg = `${name} 不支持设置里填写的模型，请在设置中清空或更换模型名称`;
  }
  const e = new Error(raw ? `${msg}（${raw}）` : msg);
  e.code = 'CLI_FAILED';
  return e;
}

/**
 * 统一调用本地 Agent CLI（Claude Code / Codex CLI / Gemini CLI），返回结构化 JSON 对象与用量。
 * @param {'claude'|'codex'|'gemini'} kind
 * @param {{cliPath?:string, codexPath?:string, model?:string, system?:string, prompt:string, schema:object,
 *   images?:string[], timeoutMs?:number, signal?:AbortSignal, tmpRoot?:string, effort?:string,
 *   onEvent?:Function, onPhase?:Function, _testBin?:boolean}} req
 * @returns {Promise<{data:object, model:string, usage:object|null, attempts:number}>}
 */
async function runAgentCli(kind, req = {}) {
  const k = String(kind || '').trim().toLowerCase();
  const meta = AGENT_CLIS[k];
  if (!meta) {
    const e = new Error(`不支持的本地 CLI 类型：${kind}`);
    e.code = 'UNSUPPORTED_CLI';
    throw e;
  }

  if (k === 'codex') {
    let usage = null;
    let attempts = 1;
    const data = await codex.runCodex({
      ...req,
      codexPath: req.cliPath || req.codexPath,
      onEvent: (ev) => {
        if (ev && ev.type === 'ff.done') {
          usage = ev.usage || null;
          attempts = ev.attempts || 1;
        }
        if (typeof req.onEvent === 'function') req.onEvent(ev);
      },
    });
    return { data, model: String(req.model || '').trim() || 'codex', usage, attempts };
  }

  const {
    cliPath,
    model,
    system,
    prompt,
    schema,
    images,
    timeoutMs,
    signal,
    tmpRoot,
    onPhase,
    onEvent,
    _testBin = false,
  } = req;

  if (!cliPath) throw new Error(`未找到 ${meta.name}：请安装（${meta.installHint}），或在设置中填写可执行文件路径`);
  if (!isValidCliPath(k, cliPath, { allowTestBin: !!_testBin })) {
    throw new Error(`${meta.name} 路径无效：必须指向本地的 ${meta.bin} 可执行文件`);
  }
  const validatedCliPath = path.resolve(cliPath);
  if (!isValidCliPath(k, validatedCliPath, { allowTestBin: !!_testBin })) {
    throw new Error(`${meta.name} 路径无效：必须指向本地的 ${meta.bin} 可执行文件`);
  }
  if (!isFile(validatedCliPath)) throw new Error(`找不到 ${meta.name} 程序：${validatedCliPath}`);
  const validModel = validateCliModel(model);
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('AI 调用缺少输出结构（schema）');
  }
  if (signal && signal.aborted) throw cancelledError();

  const baseInput = buildCliPrompt({ system, prompt, schema });
  if (!baseInput.trim()) throw new Error('AI 调用缺少提示词');

  const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
  const root = tmpRoot || os.tmpdir();
  await fsp.mkdir(root, { recursive: true });
  const tmpDir = await fsp.mkdtemp(path.join(root, `${k}-cli-`));
  const phase = (p, detail) => {
    if (typeof onPhase === 'function') { try { if (detail !== undefined) onPhase(p, detail); else onPhase(p); } catch {} }
    if (typeof onEvent === 'function') { try { onEvent({ type: 'cli.phase', phase: p, ...(detail !== undefined ? { detail } : {}) }); } catch {} }
  };

  if (Array.isArray(images) && images.length > 0) {
    const warnMsg = `${meta.name} 本地 CLI 当前以纯文本模式运行，已忽略 ${images.length} 张图片附件`;
    console.warn(`[agentCli] ${warnMsg}`);
    if (typeof onPhase === 'function') { try { onPhase('text_only_warning', warnMsg); } catch {} }
    if (typeof onEvent === 'function') { try { onEvent({ type: 'cli.warning', phase: null, warning: warnMsg, ignoredImages: images.length }); } catch {} }
  }

  let input = baseInput;
  let attempts = 0;
  const started = Date.now();
  const args = k === 'claude' ? buildClaudeArgs({ model: validModel }) : buildGeminiArgs({ model: validModel });
  const parseOutput = k === 'claude' ? parseClaudeOutput : parseGeminiOutput;

  try {
    for (let round = 0; round < 2; round++) {
      if (signal && signal.aborted) throw cancelledError();
      const remaining = limit - (Date.now() - started);
      if (round === 0 ? remaining <= 0 : remaining < 5000) {
        const e = new Error(`${meta.name} 响应超时（超过 ${Math.round(limit / 1000)} 秒），请稍后重试或缩短请求`);
        e.code = 'TIMEOUT';
        throw e;
      }
      attempts++;
      phase(round === 0 ? 'waiting' : 'retrying');
      let r;
      try {
        r = await execCli(validatedCliPath, args, { input, timeoutMs: remaining, signal, cwd: tmpDir });
      } catch (e) {
        throw new Error(`无法启动 ${meta.name}：${(e && e.message) || e}`);
      }
      if (r.cancelled || (signal && signal.aborted)) throw cancelledError();
      if (r.timedOut) {
        const e = new Error(`${meta.name} 响应超时（超过 ${Math.round(limit / 1000)} 秒），请稍后重试或缩短请求`);
        e.code = 'TIMEOUT';
        throw e;
      }
      if (r.code !== 0) {
        const diag = [r.stderr, r.stdout].filter(Boolean).join('\n');
        throw cliFailure(k, r.code, diag);
      }

      phase('checking');
      try {
        const parsed = parseOutput(r.stdout);
        const usedModel = parsed.model || validModel || k;
        if (typeof onEvent === 'function') {
          try { onEvent({ type: 'ff.done', phase: 'checking', usage: parsed.usage, attempts }); } catch {}
        }
        return { data: parsed.data, model: usedModel, usage: parsed.usage || null, attempts };
      } catch (e) {
        if (e && (e.code === 'CLI_FAILED' || e.code === 'CLI_LOGIN')) throw e;
        if (round === 1) {
          const err = new Error(`${meta.name} 返回内容无法解析：${e.message}`);
          err.code = 'BAD_JSON';
          throw err;
        }
        input = `${baseInput}\n\n【上一次的输出无法解析】${e.message}。这次只输出一个严格符合 JSON Schema 的 JSON 对象，不要输出解释、Markdown 或代码块标记。`;
      }
    }
    const e = new Error(`${meta.name} 多次尝试仍未成功，请稍后重试`);
    e.code = 'CLI_FAILED';
    throw e;
  } finally {
    fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  AGENT_CLIS,
  isValidCliPath,
  validateCliModel,
  detectAgentCli,
  detectAllAgentClis,
  runAgentCli,
  _internals: {
    buildCliPrompt,
    buildClaudeArgs,
    buildGeminiArgs,
    parseClaudeOutput,
    parseGeminiOutput,
    normalizeCliUsage,
    execCli,
    clearDetectCache,
    candidateCliPaths,
    cliFailure,
    looksNotLoggedIn,
  },
};
