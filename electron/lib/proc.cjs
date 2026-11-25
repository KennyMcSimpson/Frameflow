'use strict';
// 子进程封装。run() 收集输出；spawnProc() 返回原始进程（流式用途）。
// - 所有子进程登记在案，退出镜流时 killAll() 统一结束：Windows 上父进程退出不会带走子进程，
//   不处理的话 ffmpeg 会在后台继续跑、继续写文件。
// - 取消/超时时连同它启动的子进程一起结束（例如 yt-dlp 调起的 ffmpeg）。
// - 每次运行把命令行（自动脱敏）、耗时、退出码写进日志；失败时附上 stderr 的最后一段。
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const log = require('./log.cjs');

const children = new Set();

function track(child) {
  if (!child) return child;
  children.add(child);
  const drop = () => children.delete(child);
  child.once('exit', drop);
  child.on('error', drop);
  return child;
}

function taskkillPath() {
  return path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'taskkill.exe');
}

const isRunning = (child) => !!child && child.exitCode == null && child.signalCode == null;
// 已经发出结束请求的进程（taskkill 已启动），killAll 不再重复处理
const reaped = new WeakSet();

/** 结束子进程及它启动的进程（Windows 用 taskkill /T，失败时退回只结束它本身） */
function killTree(child) {
  if (!isRunning(child) || reaped.has(child)) return;
  reaped.add(child);
  const fallback = () => { try { child.kill('SIGKILL'); } catch {} };
  if (process.platform !== 'win32' || !child.pid) { fallback(); return; }
  try {
    const k = spawn(taskkillPath(), ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' });
    k.on('error', fallback);
    k.on('exit', (code) => { if (code !== 0) fallback(); });
  } catch { fallback(); }
}

/** 退出前结束所有还在运行的子进程，返回结束的个数。同步执行：will-quit 之后进程马上就没了 */
function killAll() {
  const list = [...children].filter((c) => isRunning(c) && !reaped.has(c));
  children.clear();
  if (!list.length) return 0;
  if (process.platform === 'win32') {
    // 一次 taskkill 结束全部进程树（每启动一次 taskkill 都要花时间，不要逐个调用）
    const args = ['/F', '/T'];
    for (const c of list) if (c.pid) args.push('/PID', String(c.pid));
    try { spawnSync(taskkillPath(), args, { windowsHide: true, stdio: 'ignore', timeout: 5000 }); } catch {}
  }
  // 兜底：已经结束的进程再 kill 不会出错
  for (const c of list) { reaped.add(c); try { c.kill('SIGKILL'); } catch {} }
  log.info(`[proc] 退出前结束了 ${list.length} 个子进程`);
  return list.length;
}

function quoteArg(a) {
  const s = String(a);
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}
/** 日志用的命令行：程序名 + 参数，过长截断（脱敏由 log.cjs 统一处理） */
function describe(bin, args) {
  const text = [path.basename(String(bin || '')), ...(Array.isArray(args) ? args : []).map(quoteArg)].join(' ');
  return text.length > 1000 ? `${text.slice(0, 1000)}…（共 ${text.length} 字符）` : text;
}
function tail(text, n = 2000) {
  const s = String(text || '').trim();
  return s.length > n ? '…' + s.slice(-n) : s;
}
function cancelledError() {
  const e = new Error('已取消');
  e.code = 'CANCELLED';
  return e;
}

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {{signal?:AbortSignal, cwd?:string, input?:string|Buffer, env?:object, onStdout?:(chunk:Buffer)=>void, onStderr?:(text:string)=>void, encoding?:'utf8'|'buffer', timeoutMs?:number, maxBuffer?:number}} opts
 * @returns {Promise<{code:number, stdout:string|Buffer, stderr:string}>}
 */
function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!bin) return reject(new Error('找不到可执行文件'));
    // 已经取消了就不再启动进程（循环里连续调用时省掉“启动又马上结束”）
    if (opts.signal && opts.signal.aborted) return reject(cancelledError());
    const t0 = Date.now();
    const name = path.basename(String(bin));
    let child;
    try {
      child = track(spawn(bin, args, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }));
    } catch (e) {
      log.warn('[proc] 无法启动', describe(bin, args), e && e.message);
      return reject(e);
    }
    const out = [];
    let outLen = 0;
    let err = '';
    const maxBuffer = opts.maxBuffer || 512 * 1024 * 1024;
    let timer = null;
    let killWait = null;
    let killing = null; // 取消/超时后要报的错：等进程真正退出再报，调用方随后清理临时文件时文件已不被占用
    let settled = false;
    let onAbort = null;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killWait) clearTimeout(killWait);
      if (opts.signal && onAbort) {
        try { opts.signal.removeEventListener('abort', onAbort); } catch {}
        onAbort = null;
      }
      fn(v);
    };
    const killThenReject = (e) => {
      if (settled || killing) return;
      killing = e;
      if (timer) { clearTimeout(timer); timer = null; }
      killTree(child);
      if (!isRunning(child)) return finish(reject, e);
      killWait = setTimeout(() => finish(reject, e), 3000); // 最多等 3 秒
      child.once('exit', () => finish(reject, e));
    };
    // 调用方的进度回调出错只记日志：解析进度的小毛病不该变成主进程崩溃
    const safeCall = (fn, v, label) => {
      try { fn(v); } catch (e) { log.error(`[proc] ${label} 回调出错`, name, e); }
    };

    child.stdout.on('data', (c) => {
      if (opts.onStdout) safeCall(opts.onStdout, c, 'onStdout');
      else if (outLen < maxBuffer) { out.push(c); outLen += c.length; }
    });
    child.stderr.on('data', (c) => {
      const t = c.toString('utf8');
      if (err.length < 2 * 1024 * 1024) err += t;
      if (opts.onStderr) safeCall(opts.onStderr, t, 'onStderr');
    });
    child.on('error', (e) => {
      if (killing) return; // 正在结束进程（取消/超时），以那个错误为准
      log.warn('[proc] 运行出错', describe(bin, args), e && e.message);
      finish(reject, e);
    });
    child.on('close', (code) => {
      if (killing) return finish(reject, killing);
      const ms = Date.now() - t0;
      if (!settled) {
        if (code === 0) log.debug('[proc]', describe(bin, args), `→ 0，${ms}ms`);
        else log.warn('[proc]', describe(bin, args), `→ 退出码 ${code}，${ms}ms`, tail(err));
      }
      const buf = Buffer.concat(out);
      finish(resolve, { code: code == null ? -1 : code, stdout: opts.encoding === 'buffer' ? buf : buf.toString('utf8'), stderr: err });
    });
    if (opts.signal) {
      onAbort = () => {
        if (settled || killing) return;
        log.info('[proc] 已取消', name, `${Date.now() - t0}ms`);
        killThenReject(cancelledError());
      };
      if (opts.signal.aborted) onAbort(); else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timer = null;
        log.warn('[proc] 超时', describe(bin, args), `${opts.timeoutMs}ms`, tail(err, 1000));
        killThenReject(new Error('处理超时'));
      }, opts.timeoutMs);
    }
    child.stdin.on('error', () => {});
    if (opts.input != null) child.stdin.end(opts.input); else child.stdin.end();
  });
}

function spawnProc(bin, args, opts = {}) {
  log.info('[proc] 启动', describe(bin, args));
  return track(spawn(bin, args, { cwd: opts.cwd, env: opts.env ? { ...process.env, ...opts.env } : process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
}

module.exports = { run, spawnProc, killAll, killTree };
