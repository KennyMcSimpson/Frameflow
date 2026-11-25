'use strict';
// 主进程日志（契约 C7，路线图 P0-8 / C1）。自己实现，不依赖 electron，单测里可以直接 require。
// - 写到 <dir>/main.log；超过 2MB 轮转为 main.1.log … main.4.log，一共保留 5 份。
// - 内存队列 + 异步追加，避免并发写坏文件；进程退出或致命错误时 flushSync() 同步落盘。
// - 统一脱敏：sk- 开头的 Key、Bearer/Authorization、各类 key/token/secret 字段、用户目录换成 ~、
//   超长 base64 只留开头。
// - takeOverConsole()：console.log/info/warn/error 原样输出，同时写一份到文件（打包版也能落盘）。
// 用法：const log = require('./log.cjs'); log.info('[export]', '开始', file); log.error('[ipc x]', err);

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const util = require('node:util');

const FILE = 'main.log';
const MAX_BYTES = 2 * 1024 * 1024;   // 单个文件上限
const MAX_FILES = 5;                 // main.log + 4 份历史
const MAX_ENTRY = 16 * 1024;         // 单条上限，超出截断
const MAX_QUEUE = 1024 * 1024;       // 还没写盘的内容上限（目录未就绪时防止无限增长）
const FLUSH_DELAY = 120;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const raw = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

let dir = null;
let echoLevel = LEVELS.warn; // warn/error 同时打到控制台（stderr），info 只写文件
let queue = [];
let queued = 0;
let dropped = 0;
let timer = null;
let writing = false;
let inflight = null; // 正在异步写入的批次 { data, flushedSync }，崩溃/flushSync 时可同步补落盘
let consoleTaken = false;
let exitHooked = false;
let inLog = false; // 防止 console 接管后递归

// ---------------------------------------------------------------------------
// 脱敏
// ---------------------------------------------------------------------------
// 字段名以这些词结尾时视为密钥（apiKey、openai_key、accessToken、clientSecret、klingAk、jimengSk…）
const KEY_NAMES = 'key|token|secret|password|passwd|pwd|authorization|cookie|sessdata|signature|klingak|klingsk|jimengak|jimengsk|accesskeyid';
const RULES = [
  // 超长 base64（图片 data URL 等）
  [/(data:[a-z]+\/[a-z0-9.+-]+;base64,)[A-Za-z0-9+/=]{48,}/gi, '$1…'],
  // OpenAI / Anthropic / OpenRouter 风格的 Key
  [/\b(sk-[A-Za-z0-9]{0,4})[A-Za-z0-9_-]{12,}/g, '$1***'],
  // Google / Gemini API Key
  [/\b(AIza)[0-9A-Za-z_-]{35,}/g, '$1***'],
  // Bearer / Basic 凭据
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 ***'],
  // fal.ai 等服务的 Key <token> 凭据（区分大小写避免误伤普通英文）
  [/\b(Key)\s+[A-Za-z0-9._~+/:=-]{6,}/g, '$1 ***'],
  // URL userinfo 密码：https://user:password@host/path、socks5://user:pass@proxy:1080、ws(s)://...
  [/((?:https?|socks[45][ah]?|wss?):\/\/[^/\s:@?#"'`]+:)[^\s/?#"'`]+@/gi, '$1***@'],
  // 请求头：Authorization: xxx、X-Api-Key: xxx、Cookie: xxx（带引号的值交给下面两条）
  [/\b((?:x-)?(?:api-?key|goog-api-key|authorization|cookie)\s*:[ \t]*)(?![\s'"`]|\*\*\*)[^\r\n,;"'}]+/gi, '$1***'],
  // JSON 字段："arkKey":"xxx"、"access_token": "xxx"（支持值内转义引号 \"）
  [new RegExp(`("[A-Za-z0-9_-]*(?:${KEY_NAMES})"\\s*:\\s*")(?!\\*\\*\\*")(?:\\\\.|[^"\\\\\\r\\n])*"`, 'gi'), '$1***"'],
  // util.inspect 输出的对象：{ apiKey: 'xxx', 'x-goog-api-key': 'xxx', "x-api-key": 'xxx' }（支持值内转义引号）
  [new RegExp(`((?:^|[^A-Za-z0-9_$'"])(?:'[A-Za-z0-9_$-]*(?:${KEY_NAMES})'|"[A-Za-z0-9_$-]*(?:${KEY_NAMES})"|[A-Za-z0-9_$-]*(?:${KEY_NAMES}))\\s*:\\s*)(?!['"\`]\\*\\*\\*['"\`])(?:'(?:\\\\.|[^'\\\\\\r\\n])*'|"(?:\\\\.|[^"\\\\\\r\\n])*"|\`(?:\\\\.|[^\`\\\\\\r\\n])*\`)`, 'gi'), "$1'***'"],
  // 查询串 / 表单 / 命令行：key=xxx、access_token=xxx、X-Amz-Signature=xxx
  [new RegExp(`((?:^|[?&\\s;,])[A-Za-z0-9_-]*(?:${KEY_NAMES}|sig)=)(?!\\*\\*\\*)[^&\\s"';,]{3,}`, 'gi'), '$1***'],
];

let homeRe;
function homePattern() {
  if (homeRe !== undefined) return homeRe;
  homeRe = null;
  try {
    const home = os.homedir();
    if (home && home.length >= 4) {
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const variants = new Set([home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\')]);
      const alt = [...variants].sort((a, b) => b.length - a.length).map(esc).join('|');
      homeRe = new RegExp(`(?:${alt})(?![A-Za-z0-9_.-])`, 'gi');
    }
  } catch { homeRe = null; }
  return homeRe;
}

/** 脱敏：去掉密钥、令牌和用户目录。只处理字符串，其他类型原样返回。 */
function redact(text) {
  if (typeof text !== 'string' || !text) return text;
  let s = text;
  for (const [re, rep] of RULES) s = s.replace(re, rep);
  const h = homePattern();
  if (h) s = s.replace(h, '~');
  return s;
}

// ---------------------------------------------------------------------------
// 格式化
// ---------------------------------------------------------------------------
function formatArgs(args) {
  let text;
  try {
    text = util.formatWithOptions({ depth: 4, breakLength: Infinity, maxArrayLength: 40, maxStringLength: 4000 }, ...args);
  } catch {
    text = args.map((a) => { try { return String(a); } catch { return '[无法显示]'; } }).join(' ');
  }
  if (text.length > MAX_ENTRY) text = text.slice(0, MAX_ENTRY) + `…（已截断，原长 ${text.length} 字符）`;
  return redact(text);
}

function line(level, text) {
  return `${new Date().toISOString()} [${level}] ${text}\n`;
}

// ---------------------------------------------------------------------------
// 写盘与轮转
// ---------------------------------------------------------------------------
function filePath() { return dir ? path.join(dir, FILE) : null; }
function rotatedName(i) { return path.join(dir, `main.${i}.log`); }

/** 当前文件加上即将写入的字节数超过上限时轮转：main.log → main.1.log → … → main.4.log（最老的删除） */
function rotateIfNeeded(incoming) {
  const f = filePath();
  if (!f) return;
  let size = 0;
  try { size = fs.statSync(f).size; } catch { return; }
  if (size + incoming <= MAX_BYTES || size === 0) return;
  try {
    try { fs.unlinkSync(rotatedName(MAX_FILES - 1)); } catch {}
    for (let i = MAX_FILES - 2; i >= 1; i--) {
      try { fs.renameSync(rotatedName(i), rotatedName(i + 1)); } catch {}
    }
    fs.renameSync(f, rotatedName(1));
  } catch {
    // 文件被占用等原因改名失败：超过 4 倍上限时清空，避免无限增长
    try { if (size > MAX_BYTES * 4) fs.truncateSync(f, 0); } catch {}
  }
}

function takeQueue() {
  let data = queue.join('');
  if (dropped) { data = line('warn', `[log] 写盘过慢，丢弃了 ${dropped} 条日志`) + data; dropped = 0; }
  queue = [];
  queued = 0;
  return data;
}

function ensureDir() {
  try { fs.mkdirSync(dir, { recursive: true }); return true; } catch { return false; }
}

function schedule() {
  if (timer || writing || !dir) return;
  timer = setTimeout(flushAsync, FLUSH_DELAY);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

function flushAsync() {
  timer = null;
  if (!dir || writing || !queue.length) return;
  const batch = { data: takeQueue(), flushedSync: false };
  inflight = batch;
  writing = true;
  const targetDir = dir;
  const targetFile = filePath();
  const bytes = Buffer.byteLength(batch.data);
  if (!ensureDir()) {
    if (inflight === batch) inflight = null;
    writing = false;
    return;
  }
  rotateIfNeeded(bytes);
  fs.appendFile(targetFile, batch.data, 'utf8', () => {
    if (inflight === batch) {
      inflight = null;
      writing = false;
      if (queue.length && dir === targetDir) schedule();
    }
  });
}

/** 同步写出队列里剩余的日志（退出、致命错误时调用）；若有异步写入正在进行，一并同步落盘避免丢失 */
function flushSync() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!dir) return;
  let data = '';
  if (inflight && !inflight.flushedSync) {
    inflight.flushedSync = true;
    data += inflight.data;
  }
  if (queue.length || dropped) {
    data += takeQueue();
  }
  if (!data) return;
  try {
    if (!ensureDir()) return;
    rotateIfNeeded(Buffer.byteLength(data));
    fs.appendFileSync(filePath(), data, 'utf8');
  } catch {}
}

function enqueue(level, text) {
  const l = line(level, text);
  if (queued + l.length > MAX_QUEUE) {
    // 目录还没就绪或写盘卡住：丢最老的，保留最新的
    while (queue.length && queued + l.length > MAX_QUEUE) { queued -= queue.shift().length; dropped++; }
  }
  queue.push(l);
  queued += l.length;
  schedule();
}

function write(level, args, { echo = true } = {}) {
  if (inLog) return;
  inLog = true;
  try {
    const text = formatArgs(args);
    enqueue(level, text);
    if (echo && (LEVELS[level] || 0) >= echoLevel) {
      const out = level === 'error' ? raw.error : level === 'warn' ? raw.warn : raw.log;
      out(text);
    }
  } catch {} finally { inLog = false; }
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------
const log = {
  debug: (...a) => write('debug', a),
  info: (...a) => write('info', a),
  warn: (...a) => write('warn', a),
  error: (...a) => write('error', a),
};

/** 带模块前缀的日志：const l = scope('export'); l.info('开始') → "[export] 开始" */
function scope(name) {
  const tag = `[${name}]`;
  return {
    debug: (...a) => log.debug(tag, ...a),
    info: (...a) => log.info(tag, ...a),
    warn: (...a) => log.warn(tag, ...a),
    error: (...a) => log.error(tag, ...a),
  };
}

/**
 * 初始化日志目录。可以在 app ready 之前调用（userData 路径那时已可用）。
 * @param {{dir:string, echo?:'debug'|'info'|'warn'|'error'|'none'}} opts
 */
function init(opts = {}) {
  if (opts.echo) echoLevel = opts.echo === 'none' ? Infinity : (LEVELS[opts.echo] || LEVELS.warn);
  if (!opts.dir) return dir;
  dir = path.resolve(opts.dir);
  ensureDir();
  // 旧版的单份备份文件（main.log.1）不再使用
  try { fs.unlinkSync(path.join(dir, FILE + '.1')); } catch {}
  if (!exitHooked) {
    exitHooked = true;
    process.on('exit', flushSync);
  }
  schedule();
  return dir;
}

function logDir() { return dir; }
function logFile() { return filePath(); }

/** 接管 console：脱敏后输出到控制台，同时写一份到日志文件。重复调用无副作用。 */
function takeOverConsole() {
  if (consoleTaken) return;
  consoleTaken = true;
  const wrap = (name, level) => {
    const orig = raw[name];
    console[name] = (...a) => {
      if (inLog) return;
      inLog = true;
      try {
        const text = formatArgs(a);
        orig(text);
        enqueue(level, text);
      } catch {} finally { inLog = false; }
    };
  };
  wrap('log', 'info');
  wrap('info', 'info');
  wrap('warn', 'warn');
  wrap('error', 'error');
}

/** 单测用：恢复初始状态 */
function _reset() {
  if (timer) clearTimeout(timer);
  timer = null;
  flushSync();
  queue = [];
  queued = 0;
  dropped = 0;
  inflight = null;
  writing = false;
  dir = null;
  echoLevel = LEVELS.warn;
}

module.exports = {
  log,
  ...log,
  scope,
  init,
  logDir,
  logFile,
  flushSync,
  redact,
  formatArgs,
  takeOverConsole,
  MAX_BYTES,
  MAX_FILES,
  _reset,
};
