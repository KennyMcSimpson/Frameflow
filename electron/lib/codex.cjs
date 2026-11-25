'use strict';
// 本机 Codex CLI：路径探测、登录状态、结构化调用（codex exec --output-schema）。
// 不依赖 electron，可在纯 node 中使用（system.cjs 的 app:info、ai.cjs、测试脚本）。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const IS_WIN = process.platform === 'win32';
const DETECT_CACHE_MS = 30 * 1000;
const DEFAULT_TIMEOUT_MS = 240 * 1000;
const PROBE_TIMEOUT_MS = 15 * 1000;
const LOGIN_HINT = 'Codex 未登录：请在终端运行 codex login';

// ───────────────────────── 工具函数 ─────────────────────────

const CODEX_MODEL_RE = /^[A-Za-z0-9._:/-]{1,128}$/;
const CODEX_BIN_RE = /^codex(\.exe|\.cmd|\.bat)?$/i;
const CMD_FORBIDDEN_RE = /[\r\n\0"&|<>^!`%]/;
const UNC_RE = /^[\\/]{2}/;

function isUncPath(p) {
  return typeof p === 'string' && (UNC_RE.test(p) || UNC_RE.test(p.trim()));
}

function hasNtfsAdsColon(p) {
  const rest = /^[A-Za-z]:/.test(p) ? p.slice(2) : p;
  return rest.includes(':');
}

function hasTrailingDotOrSpaceSegment(p) {
  const rest = /^[A-Za-z]:/.test(p) ? p.slice(2) : p;
  for (const seg of rest.split(/[\\/]+/)) {
    if (!seg || seg === '.' || seg === '..') continue;
    if (/[. ]$/.test(seg)) return true;
  }
  return false;
}

function isAbsoluteCliPath(p) {
  if (IS_WIN) return /^[A-Za-z]:[\\/]/.test(p);
  return path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p);
}

function isFile(p) {
  try { return !!p && !isUncPath(p) && fs.statSync(p).isFile(); } catch { return false; }
}

function validateModel(model) {
  if (model == null || model === '') return null;
  const s = String(model).trim();
  if (!s) return null;
  if (!CODEX_MODEL_RE.test(s) || s.startsWith('-')) {
    const e = new Error('Codex 模型名称无效：仅允许字母、数字及 . _ : / -（不超过 128 个字符）');
    e.code = 'INVALID_MODEL';
    throw e;
  }
  return s;
}

function isValidCodexPath(p, { allowTestBin = false } = {}) {
  if (typeof p !== 'string' || !p) return false;
  if (/[\r\n\0]/.test(p)) return false;
  if (p !== p.trim()) return false;
  // 拒绝 UNC 及混用斜杠 UNC（\\、//、\/、/\）——在 path.resolve 与任何 fs.* 之前
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
  if (!CODEX_BIN_RE.test(path.basename(p)) || !CODEX_BIN_RE.test(path.basename(resolved))) return false;
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
    if (!CODEX_BIN_RE.test(path.basename(real))) {
      if (!(/\.cmd$/i.test(resolved) && resolveCmdShim(real))) return false;
    }
  }
  return true;
}

function needsShell(bin) {
  return IS_WIN && /\.(cmd|bat)$/i.test(String(bin || ''));
}

function isValidNodeBin(p) {
  if (typeof p !== 'string' || !p || isUncPath(p)) return false;
  const resolved = path.resolve(p);
  if (isUncPath(resolved) || !isFile(resolved)) return false;
  try {
    const real = fs.realpathSync(resolved);
    if (isUncPath(real)) return false;
    return /^node(?:js)?(\.exe)?$/i.test(path.basename(real));
  } catch {
    return false;
  }
}

function resolveNodeForShim(shimDir, explicitNode) {
  if (explicitNode && /^node(\.exe)?$/i.test(path.basename(explicitNode)) && isValidNodeBin(explicitNode)) {
    return explicitNode;
  }
  const localNode = path.join(shimDir, IS_WIN ? 'node.exe' : 'node');
  if (isValidNodeBin(localNode)) return localNode;
  if (!process.versions.electron && /^node(\.exe)?$/i.test(path.basename(process.execPath)) && isValidNodeBin(process.execPath)) {
    return process.execPath;
  }
  for (const d of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(d, IS_WIN ? 'node.exe' : 'node');
    if (isValidNodeBin(candidate)) return candidate;
  }
  return null;
}

/**
 * 识别标准 npm/node `.cmd` 包装脚本并解析出目标 `.js` 入口，直接用 node 以 `shell: false` 运行，
 * 彻底绕开 cmd.exe 的命令行解析与注入面。无法识别时返回 null（回退到严格校验的 quoteForCmd）。
 */
function resolveCmdShim(bin) {
  if (!IS_WIN || !/\.cmd$/i.test(String(bin || ''))) return null;
  if (isUncPath(bin)) return null;
  const resolvedBin = path.resolve(bin);
  if (isUncPath(resolvedBin)) return null;
  try {
    const realBin = fs.realpathSync(resolvedBin);
    if (isUncPath(realBin)) return null;
    const st = fs.statSync(realBin);
    if (!st.isFile() || st.size > 8192) return null;
    const content = fs.readFileSync(realBin, 'utf8');
    // 若包含除标准 npm shim（dp0/_prog/PATHEXT）以外的自定义 SET，不跳过批处理脚本
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (/^set\s+/i.test(line) && !/^set\s+(?:dp0=|"_prog=|pathext=)/i.test(line)) return null;
    }
    const shimDir = path.dirname(realBin);
    let explicitNode = null;
    let relScript = null;
    const npmMatch = /"%_prog%"\s+"%(?:~dp0|dp0%)[\\/]?([^"\r\n]+?\.(?:c?js|mjs))"\s+%\*/i.exec(content);
    if (npmMatch) {
      relScript = npmMatch[1];
    } else {
      const directMatch = /"([^"\r\n]*node(?:\.exe)?)"\s+"%(?:~dp0|dp0%)[\\/]?([^"\r\n]+?\.(?:c?js|mjs))"\s+%\*/i.exec(content);
      if (directMatch) {
        explicitNode = directMatch[1];
        relScript = directMatch[2];
      }
    }
    if (!relScript || isUncPath(relScript)) return null;
    const scriptPath = path.resolve(shimDir, relScript);
    if (isUncPath(scriptPath) || !isFile(scriptPath)) return null;
    const realScript = fs.realpathSync(scriptPath);
    if (isUncPath(realScript) || !/\.(?:c?js|mjs)$/i.test(realScript) || !isFile(realScript)) return null;
    const nodeBin = resolveNodeForShim(shimDir, explicitNode);
    if (!nodeBin) return null;
    return { bin: nodeBin, prefixArgs: [realScript] };
  } catch {
    return null;
  }
}

/** cmd.exe 参数转义（仅 .cmd/.bat 无法直启而走 shell 时使用）。带 = 的参数（-c key=value）也加引号，批处理会把 = 当分隔符 */
function quoteForCmd(arg) {
  const s = String(arg);
  if (/[\r\n\0]/.test(s)) throw new Error('命令行参数包含非法换行或空字符');
  if (CMD_FORBIDDEN_RE.test(s)) throw new Error('命令行参数包含不允许的批处理特殊字符');
  if (s === '') return '""';
  if (!/[\s(),;=]/.test(s)) return s;
  return `"${s}"`;
}

function taskkillPath() {
  return path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'taskkill.exe');
}

/** 杀掉进程树（Windows 用 System32\\taskkill.exe /T /F，其他平台 SIGKILL） */
function killTree(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  const pid = child.pid;
  if (IS_WIN && pid) {
    try {
      const k = spawn(taskkillPath(), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on('error', () => { try { child.kill('SIGKILL'); } catch {} });
    } catch {
      try { child.kill('SIGKILL'); } catch {}
    }
  } else {
    try { child.kill('SIGKILL'); } catch {}
  }
}

/**
 * 启动子进程并收集输出。
 * onLine：stdout 每出一整行就回调一次（codex --json 的事件流），回调里抛错不影响进程。
 * @returns {Promise<{code:number, stdout:string, stderr:string, timedOut:boolean, cancelled:boolean}>}
 */
function exec(bin, args, { input, timeoutMs, signal, cwd, env, onLine } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      const shim = needsShell(bin) ? resolveCmdShim(bin) : null;
      const shell = !shim && needsShell(bin);
      // 优先把标准 npm/node .cmd shim 解析为直接执行 node <script>（shell: false）；
      // 其余 .cmd/.bat 才经 cmd.exe 运行，并由 quoteForCmd 拒绝危险元字符后拼接
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
    const cap = (s) => (s.length > 256 * 1024 ? s.slice(-256 * 1024) : s);
    const onAbort = () => { cancelled = true; killTree(child); };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    // 按行切分 stdout；单行最长保留 2MB（一条 agent 消息就是整份 JSON）
    let lineBuf = '';
    const emitLine = (line) => {
      if (!onLine || !line.trim()) return;
      try { onLine(line); } catch {}
    };
    const feed = (s) => {
      if (!onLine) return;
      lineBuf += s;
      let i;
      while ((i = lineBuf.indexOf('\n')) >= 0) {
        emitLine(lineBuf.slice(0, i).replace(/\r$/, ''));
        lineBuf = lineBuf.slice(i + 1);
      }
      if (lineBuf.length > 2 * 1024 * 1024) lineBuf = '';
    };
    // setEncoding 让多字节中文跨数据块时不乱码
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (s) => { stdout = cap(stdout + s); feed(s); });
    child.stderr.on('data', (s) => { stderr = cap(stderr + s); });
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
      if (lineBuf) { emitLine(lineBuf.replace(/\r$/, '')); lineBuf = ''; }
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

/** 宽松解析 JSON：去 BOM、去 ```json 包裹、截取最外层 {} */
function parseJsonLoose(text) {
  if (text == null) throw new Error('AI 没有返回内容');
  let s = String(text).replace(/^\uFEFF/, '').trim();
  if (!s) throw new Error('AI 返回了空内容');
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(s);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try { return JSON.parse(s.slice(a, b + 1)); } catch {}
    }
    throw new Error('AI 返回的内容不是有效的 JSON');
  }
}

function tail(text, n = 600) {
  const s = String(text || '').trim();
  return s.length > n ? '…' + s.slice(-n) : s;
}

function looksNotLoggedIn(text) {
  const s = String(text || '');
  return /not\s+logged\s+in|codex\s+login|please\s+(?:run\s+)?(?:log\s*in|login)|login\s+required|unauthori[sz]ed|\b401\b|authentication\s+(?:failed|required)|token\s+(?:expired|is\s+invalid)|refresh\s+token/i.test(s);
}

// ───────────────────────── 路径探测 ─────────────────────────

function readSettings(settings) {
  if (!settings) return {};
  try {
    if (typeof settings.get === 'function') return settings.get() || {};
  } catch { return {}; }
  return settings;
}

function newestLocalAppDataCodex() {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin') : null;
  if (!base) return null;
  let best = null;
  let bestTime = -1;
  let entries = [];
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return null; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const exe = path.join(base, ent.name, IS_WIN ? 'codex.exe' : 'codex');
    try {
      const st = fs.statSync(exe);
      if (st.isFile() && st.mtimeMs > bestTime) { best = exe; bestTime = st.mtimeMs; }
    } catch {}
  }
  return best;
}

async function whereCodex() {
  try {
    const winWhere = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'where.exe');
    const whereBin = IS_WIN ? (isFile(winWhere) ? winWhere : 'where.exe') : 'which';
    const r = await exec(whereBin, ['codex'], { timeoutMs: PROBE_TIMEOUT_MS });
    if (r.code !== 0) return [];
    const list = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).filter(isFile);
    // 优先 .exe，其次 .cmd，最后其他（如无扩展名的 shell 脚本在 Windows 上不可直接执行）
    const rank = (p) => (/\.exe$/i.test(p) ? 0 : /\.(cmd|bat)$/i.test(p) ? 1 : 2);
    return list.filter((p) => !IS_WIN || rank(p) < 2).sort((a, b) => rank(a) - rank(b));
  } catch {
    return [];
  }
}

async function candidatePaths(settings) {
  const s = readSettings(settings);
  const fromSettings = s && s.ai && typeof s.ai.codexPath === 'string' ? s.ai.codexPath.trim() : '';
  const out = [];
  const push = (p) => {
    if (p && isValidCodexPath(p) && !out.some((x) => x.toLowerCase() === p.toLowerCase())) out.push(p);
  };
  if (fromSettings) push(fromSettings);
  if (process.env.CODEX_CLI_PATH) push(process.env.CODEX_CLI_PATH.trim());
  push(newestLocalAppDataCodex());
  for (const p of await whereCodex()) push(p);
  return out;
}

async function codexVersion(bin) {
  try {
    const r = await exec(bin, ['--version'], { timeoutMs: PROBE_TIMEOUT_MS });
    if (r.code !== 0) return null;
    const line = (r.stdout || r.stderr).trim().split(/\r?\n/)[0] || '';
    const m = /(\d+\.\d+\.\d+[\w.+-]*)/.exec(line);
    return m ? m[1] : (line || 'unknown');
  } catch {
    return null;
  }
}

async function codexLoggedIn(bin) {
  try {
    const r = await exec(bin, ['login', 'status'], { timeoutMs: PROBE_TIMEOUT_MS });
    const text = `${r.stdout}\n${r.stderr}`;
    if (/not\s+logged\s+in/i.test(text)) return false;
    return r.code === 0 || /Logged in/.test(text);
  } catch {
    return false;
  }
}

let detectCache = null; // { key, at, promise }

async function detectUncached(settings) {
  const candidates = await candidatePaths(settings);
  const existing = candidates.filter(isFile);
  for (const p of existing) {
    const version = await codexVersion(p);
    if (version) {
      const loggedIn = await codexLoggedIn(p);
      return { ok: true, path: p, version, loggedIn };
    }
  }
  return { ok: false, path: existing[0] || null, version: null, loggedIn: false };
}

/**
 * 探测本机 Codex CLI。结果缓存 30 秒；永不 throw。
 * @param {object} settings  设置对象或带 get() 的设置存储
 * @param {{force?:boolean}} [opts]
 * @returns {Promise<{ok:boolean, path:string|null, version:string|null, loggedIn:boolean}>}
 */
async function detectCodex(settings, opts = {}) {
  try {
    const s = readSettings(settings);
    const key = `${(s.ai && s.ai.codexPath) || ''}|${process.env.CODEX_CLI_PATH || ''}`;
    const now = Date.now();
    if (!opts.force && detectCache && detectCache.key === key && now - detectCache.at < DETECT_CACHE_MS) {
      return await detectCache.promise;
    }
    const promise = detectUncached(settings).catch(() => ({ ok: false, path: null, version: null, loggedIn: false }));
    detectCache = { key, at: now, promise };
    return await promise;
  } catch {
    return { ok: false, path: null, version: null, loggedIn: false };
  }
}

function clearDetectCache() { detectCache = null; }

// ───────────────────────── --json 事件流（P0-5 L1） ─────────────────────────
// codex exec --json 把运行过程逐行输出成 JSON 事件，这里只用它显示「阶段」和统计用量，结果仍然只认 -o 文件。
// 解析一律容错：非 JSON 行、未知事件类型直接忽略，事件格式变化不会影响主流程。
// 新版事件：thread.started / turn.started / item.started|updated|completed / turn.completed（带 usage）/ turn.failed / error，
//   item.type：reasoning、agent_message、command_execution、file_change、mcp_tool_call、web_search、todo_list、error。
// 旧版（0.3x）事件：{ id, msg: { type: task_started | agent_reasoning | agent_message | exec_command_begin | token_count | task_complete | error } }。

/** 归一化后的阶段键（ai.cjs 再按任务翻译成中文） */
const ITEM_PHASES = {
  reasoning: 'thinking',
  agent_message: 'writing',
  command_execution: 'tool',
  file_change: 'tool',
  mcp_tool_call: 'tool',
  web_search: 'search',
  todo_list: 'planning',
};
const LEGACY_PHASES = {
  task_started: 'reading',
  agent_reasoning: 'thinking',
  agent_reasoning_delta: 'thinking',
  agent_reasoning_raw_content: 'thinking',
  agent_reasoning_section_break: 'thinking',
  agent_message: 'writing',
  agent_message_delta: 'writing',
  exec_command_begin: 'tool',
  mcp_tool_call_begin: 'tool',
  patch_apply_begin: 'tool',
  web_search_begin: 'search',
  plan_update: 'planning',
  task_complete: 'checking',
};

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** 统一 token 用量字段；全为 0 时返回 null */
function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const src = u.total_token_usage && typeof u.total_token_usage === 'object' ? u.total_token_usage : u;
  const usage = {
    inputTokens: num(src.input_tokens ?? src.inputTokens ?? src.prompt_tokens),
    cachedInputTokens: num(src.cached_input_tokens ?? src.cachedInputTokens ?? (src.prompt_tokens_details && src.prompt_tokens_details.cached_tokens)),
    outputTokens: num(src.output_tokens ?? src.outputTokens ?? src.completion_tokens),
    reasoningTokens: num(src.reasoning_output_tokens ?? src.reasoningTokens ?? (src.completion_tokens_details && src.completion_tokens_details.reasoning_tokens)),
  };
  return usage.inputTokens || usage.outputTokens || usage.cachedInputTokens ? usage : null;
}

function errText(v) {
  if (!v) return '';
  if (typeof v === 'string') return v.trim().slice(0, 600);
  if (typeof v === 'object') return errText(v.message || v.error || '');
  return '';
}

/**
 * 解析一行 codex --json 输出。不是事件时返回 null，永不 throw。
 * @returns {null | {type:string, phase:string|null, usage?:object, error?:string, text?:string}}
 */
function parseCodexEvent(line) {
  const s = String(line == null ? '' : line).trim();
  if (!s || s[0] !== '{') return null;
  let e;
  try { e = JSON.parse(s); } catch { return null; }
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;

  // 新版：type 在顶层
  if (typeof e.type === 'string') {
    const type = e.type;
    const out = { type, phase: null };
    if (type === 'thread.started') out.phase = 'connected';
    else if (type === 'turn.started') out.phase = 'reading';
    else if (type === 'turn.completed') { out.phase = 'checking'; const u = normalizeUsage(e.usage); if (u) out.usage = u; }
    else if (type === 'turn.failed') out.error = errText(e.error) || 'Codex 本轮执行失败';
    else if (type === 'error') out.error = errText(e.message || e.error) || 'Codex 报告了错误';
    else if (/^item\./.test(type)) {
      const item = e.item && typeof e.item === 'object' ? e.item : {};
      const itemType = String(item.type || item.item_type || '');
      out.itemType = itemType;
      if (itemType === 'error') out.warning = errText(item.message);
      else out.phase = ITEM_PHASES[itemType] || null;
      if (itemType === 'agent_message' && type === 'item.completed' && typeof item.text === 'string') out.text = item.text;
    } else {
      return null; // 未知事件：忽略
    }
    return out;
  }

  // 旧版：{ id, msg: { type, ... } }
  const msg = e.msg && typeof e.msg === 'object' ? e.msg : null;
  if (!msg || typeof msg.type !== 'string') return null;
  const type = msg.type;
  const out = { type, phase: LEGACY_PHASES[type] || null };
  if (type === 'token_count') { const u = normalizeUsage(msg.info || msg); if (u) { out.usage = u; out.cumulative = true; } }
  else if (type === 'error') out.error = errText(msg.message) || 'Codex 报告了错误';
  else if (type === 'stream_error') out.warning = errText(msg.message) || '连接中断，正在重连';
  else if (type === 'agent_message' && typeof msg.message === 'string') out.text = msg.message;
  if (!out.phase && !out.usage && !out.error && !out.warning) return null;
  return out;
}

/** 多轮用量相加（同一次 exec 正常只有一轮） */
function addUsage(a, b) {
  if (!b) return a || null;
  if (!a) return { ...b };
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

// ───────────────────────── 结构化调用 ─────────────────────────

/** 推理强度（Codex 配置项 model_reasoning_effort）。只传这几档，其余一律不传（P0-5 L5） */
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

/** 本进程里探测到的能力缺口：不认 --json 的 codex、不支持推理强度的模型，记下后不再传，避免每次都白跑一趟 */
const capability = { noJson: new Set(), noEffort: new Set() };

const JSON_FLAG_UNSUPPORTED = /unexpected argument '--json'|unrecognized (?:option|argument)[^\n]*--json|unknown (?:option|flag|argument)[^\n]*--json|found argument '--json'/i;
const EFFORT_UNSUPPORTED = /model_reasoning_effort|reasoning[._ ]effort|reasoning\.effort|unknown variant|unsupported[_ ]value[^\n]*(?:effort|reasoning)|(?:effort|reasoning)[^\n]*not supported/i;

function buildCodexArgs({ tmpDir, schemaPath, outPath, model, images, json = false, effort = null }) {
  const validModel = validateModel(model);
  const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '--color', 'never', '-C', tmpDir];
  if (json) args.push('--json');
  if (validModel) args.push('-m', validModel);
  if (effort && EFFORTS.includes(effort)) args.push('-c', `model_reasoning_effort=${effort}`);
  // -i 是多值参数：放在其他选项之前，避免把结尾的「-」（从 stdin 读提示词）当成图片
  for (const img of images || []) args.push('-i', img);
  args.push('--output-schema', schemaPath, '-o', outPath, '-');
  return args;
}

function cancelledError() {
  const e = new Error('已取消');
  e.code = 'CANCELLED';
  return e;
}

/** 把 Codex 的英文失败原因翻成能看懂的话（保留原文尾巴便于排查） */
function codexFailure(code, diag) {
  const raw = tail(diag, 400);
  let msg = `Codex 执行失败（退出码 ${code}）`;
  if (/\b429\b|rate.?limit|usage limit|quota|too many requests/i.test(diag)) msg = 'Codex 的使用额度暂时用完或请求太频繁，请稍后再试';
  else if (/stream disconnected|error sending request|connection (?:reset|refused|closed)|timed? ?out|ENOTFOUND|ECONNRESET|network/i.test(diag)) msg = 'Codex 连不上服务器：请检查网络后重试';
  else if (/\b5\d\d\b|internal server error|service unavailable|overloaded/i.test(diag)) msg = 'Codex 服务暂时不可用，请稍后重试';
  else if (/model[^\n]*(?:not found|does not exist|not supported)|unknown model/i.test(diag)) msg = 'Codex 不支持设置里填写的模型，请在设置中清空或更换模型名称';
  const e = new Error(raw ? `${msg}（${raw}）` : msg);
  e.code = 'CODEX_FAILED';
  return e;
}

/**
 * 调用 Codex CLI，按 JSON Schema 返回结构化对象。
 * 失败策略：不原样重发。只有两种情况会再跑一次——
 *   1) 能力降级：这个 codex 不认 --json，或模型不支持推理强度，去掉对应参数重跑（记住，之后不再传）；
 *   2) 输出不是合法 JSON：带上解析错误重问 1 次。
 * 其余失败（退出码非 0、超时、未登录）直接返回，交给上层提示用户。
 * @param {{codexPath:string, model?:string, system?:string, prompt:string, schema:object, images?:string[], timeoutMs?:number,
 *   signal?:AbortSignal, tmpRoot?:string, effort?:string, json?:boolean, onEvent?:(ev:object)=>void}} opts
 *   onEvent 收到 parseCodexEvent 的结果，外加两种本地事件：{type:'ff.attempt', attempt, reason} 与 {type:'ff.done', usage, attempts}。
 * @returns {Promise<object>}
 */
async function runCodex({ codexPath, model, system, prompt, schema, images, timeoutMs, signal, tmpRoot, effort, json = true, onEvent, _testBin = false } = {}) {
  if (!codexPath) throw new Error('未找到 Codex CLI：请安装 Codex，或在设置中填写 codex.exe 的路径');
  if (!isValidCodexPath(codexPath, { allowTestBin: !!_testBin })) throw new Error('Codex 路径无效：必须指向本地的 codex 可执行文件');
  const validatedCodexPath = path.resolve(codexPath);
  if (!isValidCodexPath(validatedCodexPath, { allowTestBin: !!_testBin })) throw new Error('Codex 路径无效：必须指向本地的 codex 可执行文件');
  if (!isFile(validatedCodexPath)) throw new Error(`找不到 Codex 程序：${validatedCodexPath}`);
  const validModel = validateModel(model);
  if (!schema || typeof schema !== 'object') throw new Error('AI 调用缺少输出结构（schema）');
  if (signal && signal.aborted) throw cancelledError();
  const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
  const baseInput = [system, prompt].filter((x) => x != null && String(x).trim() !== '').join('\n\n');
  if (!baseInput.trim()) throw new Error('AI 调用缺少提示词');
  const root = tmpRoot || os.tmpdir();
  await fsp.mkdir(root, { recursive: true });
  const tmpDir = await fsp.mkdtemp(path.join(root, 'codex-'));
  const schemaPath = path.join(tmpDir, 'schema.json');
  const outPath = path.join(tmpDir, 'out.json');
  // 必须是 UTF-8 无 BOM，否则 codex 解析 schema 失败
  fs.writeFileSync(schemaPath, JSON.stringify(schema), { encoding: 'utf8' });
  const imgs = (Array.isArray(images) ? images : []).filter((p) => typeof p === 'string' && isFile(p));

  const emit = (ev) => { if (onEvent) { try { onEvent(ev); } catch {} } };
  const capKey = String(validatedCodexPath).toLowerCase();
  const effortKey = `${capKey}|${validModel || ''}`;
  let useJson = json !== false && !capability.noJson.has(capKey);
  let useEffort = effort && EFFORTS.includes(effort) && !capability.noEffort.has(effortKey) ? effort : null;
  let input = baseInput;
  let parseRetried = false;
  let usage = null;
  let attempts = 0;
  const started = Date.now();
  try {
    // 最多 4 轮：--json 降级、推理强度降级、JSON 修正各至多 1 次
    for (let round = 0; round < 4; round++) {
      if (signal && signal.aborted) throw cancelledError();
      const remaining = limit - (Date.now() - started);
      if (round === 0 ? remaining <= 0 : remaining < 5000) {
        const e = new Error(`Codex 响应超时（超过 ${Math.round(limit / 1000)} 秒），请稍后重试或缩短请求`);
        e.code = 'TIMEOUT';
        throw e;
      }
      try { fs.rmSync(outPath, { force: true }); } catch {}
      attempts++;
      const args = buildCodexArgs({ tmpDir, schemaPath, outPath, model: validModel, images: imgs, json: useJson, effort: useEffort });
      const eventErrors = [];
      let agentText = '';
      const onLine = useJson ? (line) => {
        const ev = parseCodexEvent(line);
        if (!ev) return;
        if (ev.error) eventErrors.push(ev.error);
        if (ev.usage) usage = ev.cumulative ? { ...ev.usage } : addUsage(usage, ev.usage);
        if (ev.text) agentText = ev.text;
        emit(ev);
      } : undefined;
      let r;
      try {
        r = await exec(validatedCodexPath, args, { input, timeoutMs: remaining, signal, cwd: tmpDir, onLine });
      } catch (e) {
        throw new Error(`无法启动 Codex：${(e && e.message) || e}`);
      }
      if (r.cancelled || (signal && signal.aborted)) throw cancelledError();
      if (r.timedOut) {
        const e = new Error(`Codex 响应超时（超过 ${Math.round(limit / 1000)} 秒），请稍后重试或缩短请求`);
        e.code = 'TIMEOUT';
        throw e;
      }
      if (r.code !== 0) {
        const diag = [r.stderr, eventErrors.join('\n'), useJson ? '' : r.stdout].filter(Boolean).join('\n');
        if (looksNotLoggedIn(diag)) {
          const e = new Error(LOGIN_HINT);
          e.code = 'CODEX_LOGIN';
          throw e;
        }
        if (useJson && JSON_FLAG_UNSUPPORTED.test(diag)) {
          capability.noJson.add(capKey);
          useJson = false;
          emit({ type: 'ff.attempt', phase: 'connecting', attempt: attempts + 1, reason: 'no-json' });
          continue;
        }
        if (useEffort && EFFORT_UNSUPPORTED.test(diag)) {
          capability.noEffort.add(effortKey);
          useEffort = null;
          emit({ type: 'ff.attempt', phase: 'connecting', attempt: attempts + 1, reason: 'no-effort' });
          continue;
        }
        throw codexFailure(r.code, diag || r.stdout);
      }
      let text = '';
      try { text = fs.readFileSync(outPath, 'utf8'); } catch {}
      if (!text.trim()) text = agentText || (useJson ? '' : r.stdout); // 兜底：最后一条消息
      try {
        const data = parseJsonLoose(text);
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('AI 返回的不是 JSON 对象');
        emit({ type: 'ff.done', phase: 'checking', usage, attempts });
        return data;
      } catch (e) {
        if (parseRetried) {
          const err = new Error(`Codex 返回内容无法解析：${e.message}`);
          err.code = 'BAD_JSON';
          throw err;
        }
        parseRetried = true;
        input = `${baseInput}\n\n【上一次的输出无法解析】${e.message}。这次只输出一个严格符合 JSON Schema 的 JSON 对象，不要输出解释、Markdown 或代码块标记。`;
        emit({ type: 'ff.attempt', phase: 'retrying', attempt: attempts + 1, reason: 'bad-json' });
      }
    }
    const e = new Error('Codex 多次尝试仍未成功，请稍后重试');
    e.code = 'CODEX_FAILED';
    throw e;
  } finally {
    fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function clearCapabilityCache() {
  capability.noJson.clear();
  capability.noEffort.clear();
}

module.exports = {
  detectCodex,
  runCodex,
  parseCodexEvent,
  EFFORTS,
  _internals: {
    parseJsonLoose, buildCodexArgs, killTree, exec, quoteForCmd, looksNotLoggedIn, clearDetectCache, candidatePaths, LOGIN_HINT,
    parseCodexEvent, normalizeUsage, addUsage, codexFailure, clearCapabilityCache, capability, JSON_FLAG_UNSUPPORTED, EFFORT_UNSUPPORTED,
    validateModel, isValidCodexPath, resolveCmdShim, isUncPath, hasNtfsAdsColon, hasTrailingDotOrSpaceSegment, isAbsoluteCliPath,
  },
};
