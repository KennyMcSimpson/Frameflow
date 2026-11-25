'use strict';
// 项目文件实时监听（Live Watch）：监听父目录并按精确文件名过滤，兼容 Windows 原子临时文件重命名，
// 通过 SHA-256 摘要 + 自写标记杜绝回声重载。纯 Node 实现，零 Electron 依赖，可直接单测。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isUncPath } = require('./urlSafety.cjs');

const MAX_PROJECT_BYTES = 200 * 1024 * 1024;
const RETRY_DELAY_MS = 60;
const SELF_WRITE_TTL_MS = 10000;
const MAX_TRACKED_PATHS = 16;
const MAX_DIGESTS_PER_PATH = 12;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;
const TRANSIENT_FS_CODES = new Set(['EBUSY', 'ENOENT', 'EPERM', 'EACCES']);

function unrefTimer(t) {
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

function sleepUnref(ms) {
  return new Promise((resolve) => {
    unrefTimer(setTimeout(resolve, ms));
  });
}

function normPath(p) {
  const abs = path.resolve(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

function sameBase(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function computeDigest(contentOrHash) {
  if (contentOrHash == null) return null;
  if (Buffer.isBuffer(contentOrHash)) {
    return crypto.createHash('sha256').update(contentOrHash).digest('hex');
  }
  if (typeof contentOrHash === 'string') {
    if (SHA256_HEX_RE.test(contentOrHash)) return contentOrHash.toLowerCase();
    return crypto.createHash('sha256').update(contentOrHash, 'utf8').digest('hex');
  }
  return null;
}

function realpathNative(p) {
  const fn = (fs.realpathSync && typeof fs.realpathSync.native === 'function')
    ? fs.realpathSync.native
    : fs.realpathSync;
  return fn(p);
}

function hasUnsafePathSyntax(p) {
  if (typeof p !== 'string' || !p || p !== p.trim()) return true;
  if (/[\0\r\n]/.test(p)) return true;
  if (isUncPath(p) || /^\\\?\?\\/i.test(p) || /^\\\\[.?]\\/.test(p)) return true;
  const afterDrive = /^[A-Za-z]:/.test(p) ? p.slice(2) : p;
  if (afterDrive.includes(':')) return true;
  const segs = afterDrive.split(/[\\/]+/).filter(Boolean);
  for (const seg of segs) {
    if (seg !== '.' && seg !== '..' && /[. ]$/.test(seg)) return true;
  }
  return false;
}

function assertNoUnsafeSymlinksRootToLeaf(targetPath) {
  const parsed = path.parse(targetPath);
  if (!parsed.root) return;
  const segs = targetPath.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);
  const stack = [];
  for (const s of segs) {
    if (s === '.') continue;
    if (s === '..') {
      if (stack.length) stack.pop();
      continue;
    }
    stack.push(s);
    const cur = path.join(parsed.root, ...stack);
    let lst;
    try {
      lst = fs.lstatSync(cur);
    } catch (e) {
      if (e && e.code === 'ENOENT') return; // 尚未创建的路径段允许继续
      const err = new Error('监听路径状态检查失败，已拒绝');
      err.code = 'UNSAFE_PATH';
      throw err;
    }
    if (lst.isSymbolicLink()) {
      try {
        const linkTarget = fs.readlinkSync(cur);
        if (isUncPath(linkTarget) || /^\\\?\?\\UNC\\/i.test(linkTarget)) {
          const err = new Error('出于安全考虑，不允许监听指向网络路径（UNC）的符号链接');
          err.code = 'UNSAFE_PATH';
          throw err;
        }
      } catch (e) {
        if (e && e.code === 'UNSAFE_PATH') throw e;
        const err = new Error('无法安全解析监听路径中的符号链接，已拒绝');
        err.code = 'UNSAFE_PATH';
        throw err;
      }
      try {
        const real = realpathNative(cur);
        if (!real || isUncPath(real)) {
          const err = new Error('出于安全考虑，不允许监听指向网络路径（UNC）的文件');
          err.code = 'UNSAFE_PATH';
          throw err;
        }
      } catch (e) {
        if (e && e.code === 'UNSAFE_PATH') throw e;
        const err = new Error('监听路径包含悬空或不可解析的符号链接，已拒绝');
        err.code = 'UNSAFE_PATH';
        throw err;
      }
    }
  }
}

function assertSafeLocalFile(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    const err = new Error('监听文件路径无效');
    err.code = 'INVALID_PATH';
    throw err;
  }
  if (isUncPath(filePath)) {
    const err = new Error('出于安全考虑，不允许监听网络路径（UNC）');
    err.code = 'UNSAFE_PATH';
    throw err;
  }
  if (hasUnsafePathSyntax(filePath)) {
    const err = new Error('监听路径包含不安全字符、尾部点/空格或备用数据流，已拒绝');
    err.code = 'UNSAFE_PATH';
    throw err;
  }
  if (!path.isAbsolute(filePath)) {
    const err = new Error('监听文件路径必须是完整的绝对路径');
    err.code = 'INVALID_PATH';
    throw err;
  }
  const abs = path.resolve(filePath);
  if (hasUnsafePathSyntax(abs)) {
    const err = new Error('监听文件路径包含不安全片段，已拒绝');
    err.code = 'UNSAFE_PATH';
    throw err;
  }
  // 先按根到叶顺序校验原始路径段与规范化绝对路径，遇到 UNC 或不可解析链接一律失败关闭
  assertNoUnsafeSymlinksRootToLeaf(filePath);
  assertNoUnsafeSymlinksRootToLeaf(abs);
  return abs;
}

function readInitialDigestSync(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size > MAX_PROJECT_BYTES) return null;
    const buf = fs.readFileSync(filePath);
    return computeDigest(buf);
  } catch {
    return null;
  }
}

/**
 * 创建项目文件实时监听器。
 * @param {{ debounceMs?: number, onChange?: (ev: { filePath: string, project: object, digest: string }) => void, onError?: (err: Error) => void }} [opts]
 */
function createProjectWatcher({ debounceMs = 180, onChange, onError } = {}) {
  const waitMs = Math.max(0, Number.isFinite(Number(debounceMs)) ? Number(debounceMs) : 180);
  const selfWrites = new Map(); // normPath -> Map<digest, expiresAt>

  let watcher = null;
  let watchedFile = null;
  let watchedNorm = null;
  let watchedBase = null;
  let lastDigest = null;
  let debounceTimer = null;
  let generation = 0;
  let reading = false;
  let readingGen = 0;
  let rerunPending = false;
  let disposed = false;

  function reportError(err) {
    if (typeof onError === 'function') {
      try { onError(err); } catch {}
    }
  }

  function pruneSelfWrites(now = Date.now()) {
    for (const [p, map] of selfWrites) {
      for (const [d, exp] of map) {
        if (exp <= now) map.delete(d);
      }
      if (!map.size) selfWrites.delete(p);
    }
  }

  function isSelfDigest(normKey, digest) {
    const now = Date.now();
    const map = selfWrites.get(normKey);
    if (!map) return false;
    const exp = map.get(digest);
    if (!exp) return false;
    if (exp <= now) {
      map.delete(digest);
      if (!map.size) selfWrites.delete(normKey);
      return false;
    }
    return true;
  }

  function clearDebounce() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function unwatch() {
    generation += 1;
    clearDebounce();
    reading = false;
    readingGen = 0;
    rerunPending = false;
    if (watcher) {
      try { watcher.close(); } catch {}
      watcher = null;
    }
    watchedFile = null;
    watchedNorm = null;
    watchedBase = null;
    lastDigest = null;
    return { active: false, filePath: null };
  }

  function scheduleCheck(gen) {
    if (disposed || gen !== generation || !watcher) return;
    if (reading && readingGen === gen) {
      rerunPending = true;
      return;
    }
    clearDebounce();
    debounceTimer = unrefTimer(setTimeout(() => {
      debounceTimer = null;
      void runRead(gen);
    }, waitMs));
  }

  async function readAndParseOnce(filePath) {
    const st = await fs.promises.stat(filePath);
    if (!st.isFile() || st.size > MAX_PROJECT_BYTES) return { skip: true };
    const buf = await fs.promises.readFile(filePath);
    const digest = computeDigest(buf);
    const text = buf.toString('utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(text);
    return { skip: false, digest, parsed };
  }

  async function runRead(gen) {
    if (disposed || gen !== generation || !watcher || !watchedFile) return;
    const targetFile = watchedFile;
    const targetNorm = watchedNorm;
    reading = true;
    readingGen = gen;
    rerunPending = false;

    try {
      let result = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (disposed || gen !== generation || !watcher) return;
        try {
          result = await readAndParseOnce(targetFile);
          break;
        } catch (err) {
          const isTransientFs = !!(err && TRANSIENT_FS_CODES.has(err.code));
          const isPartialJson = err instanceof SyntaxError;
          if ((isTransientFs || isPartialJson) && attempt === 0) {
            await sleepUnref(RETRY_DELAY_MS);
            continue;
          }
          if (!isTransientFs && !isPartialJson) reportError(err);
          return;
        }
      }

      if (disposed || gen !== generation || !watcher || !result || result.skip) return;
      const { digest, parsed } = result;
      if (!digest || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;

      if (digest === lastDigest) return;
      if (isSelfDigest(targetNorm, digest)) {
        lastDigest = digest;
        return;
      }

      lastDigest = digest;
      // 收到外部变更后清掉旧的自写记录，避免外部再次回退到旧内容时被误判成回声
      selfWrites.delete(targetNorm);

      if (typeof onChange === 'function') {
        try {
          await onChange({ filePath: targetFile, project: parsed, digest });
        } catch (err) {
          reportError(err);
        }
      }
    } finally {
      if (readingGen === gen) {
        reading = false;
        readingGen = 0;
        if (rerunPending && !disposed && watcher && gen === generation) {
          rerunPending = false;
          scheduleCheck(generation);
        }
      }
    }
  }

  function watch(filePath) {
    if (disposed) {
      const err = new Error('项目监听器已释放');
      err.code = 'DISPOSED';
      throw err;
    }
    const abs = assertSafeLocalFile(filePath);
    const nextNorm = normPath(abs);
    if (watcher && watchedNorm === nextNorm) {
      if (!lastDigest) lastDigest = readInitialDigestSync(abs);
      return { active: true, filePath: watchedFile };
    }

    unwatch();

    const dir = path.dirname(abs);
    const base = path.basename(abs);
    const st = fs.statSync(dir);
    if (!st.isDirectory()) {
      const err = new Error('监听目标的父目录无效');
      err.code = 'INVALID_DIR';
      throw err;
    }

    const gen = generation;
    watchedFile = abs;
    watchedNorm = nextNorm;
    watchedBase = base;
    lastDigest = readInitialDigestSync(abs);

    const w = fs.watch(dir, { persistent: false }, (_eventType, filename) => {
      if (disposed || gen !== generation) return;
      if (filename != null) {
        const name = Buffer.isBuffer(filename) ? filename.toString('utf8') : String(filename);
        if (!sameBase(name, watchedBase)) return;
      }
      scheduleCheck(gen);
    });

    w.on('error', (err) => {
      if (gen !== generation) return;
      reportError(err);
      unwatch();
    });

    watcher = w;
    return { active: true, filePath: watchedFile };
  }

  function markSelfWrite(filePath, contentOrHash) {
    if (disposed || typeof filePath !== 'string' || !filePath.trim() || isUncPath(filePath)) return null;
    const digest = computeDigest(contentOrHash);
    if (!digest) return null;
    const abs = path.resolve(filePath);
    if (isUncPath(abs)) return null;
    const key = normPath(abs);
    const now = Date.now();
    pruneSelfWrites(now);

    let map = selfWrites.get(key);
    if (!map) {
      if (selfWrites.size >= MAX_TRACKED_PATHS) {
        const oldest = selfWrites.keys().next().value;
        if (oldest !== undefined) selfWrites.delete(oldest);
      }
      map = new Map();
      selfWrites.set(key, map);
    }
    map.set(digest, now + Math.max(SELF_WRITE_TTL_MS, waitMs * 10));
    while (map.size > MAX_DIGESTS_PER_PATH) {
      const oldestDigest = map.keys().next().value;
      if (oldestDigest !== undefined) map.delete(oldestDigest);
    }
    // 不在此处提前改写 lastDigest：仅在磁盘实际读到该摘要或显式确认写盘成功后推进，
    // 防止写盘失败时 lastDigest 与磁盘真实内容脱节。
    return digest;
  }

  function unmarkSelfWrite(filePath, contentOrHash) {
    if (disposed || typeof filePath !== 'string' || !filePath.trim() || isUncPath(filePath)) return false;
    const digest = computeDigest(contentOrHash);
    if (!digest) return false;
    const abs = path.resolve(filePath);
    if (isUncPath(abs)) return false;
    const key = normPath(abs);
    const map = selfWrites.get(key);
    if (!map) return false;
    const removed = map.delete(digest);
    if (!map.size) selfWrites.delete(key);
    return removed;
  }

  function confirmSelfWrite(filePath, contentOrHash) {
    if (disposed || typeof filePath !== 'string' || !filePath.trim() || isUncPath(filePath)) return false;
    const digest = computeDigest(contentOrHash);
    if (!digest) return false;
    const abs = path.resolve(filePath);
    if (isUncPath(abs)) return false;
    const key = normPath(abs);
    if (watchedNorm && watchedNorm === key) {
      lastDigest = digest;
      return true;
    }
    return false;
  }

  function status() {
    return { active: !!watcher, filePath: watcher ? watchedFile : null };
  }

  function dispose() {
    disposed = true;
    unwatch();
    selfWrites.clear();
  }

  return {
    watch,
    unwatch,
    markSelfWrite,
    unmarkSelfWrite,
    confirmSelfWrite,
    status,
    dispose,
  };
}

module.exports = {
  createProjectWatcher,
  computeDigest,
};
