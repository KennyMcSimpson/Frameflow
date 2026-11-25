'use strict';
// yt-dlp 管理：安装（固定版本 + SHA-256 校验）、版本、站内搜索（YouTube / B 站）、下载（含字幕）、VTT 解析。
// 另外提供通用的 HTTP 流式下载工具（web.cjs 复用）。不在顶层 require electron，便于 node 测试。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { run } = require('./proc.cjs');

// 固定版本：升级时同时改 YTDLP_TAG 和 YTDLP_SHA256（取自该版本发布页的 SHA2-256SUMS 里 yt-dlp.exe 那一行）
const YTDLP_REPO = 'https://github.com/yt-dlp/yt-dlp';
const YTDLP_TAG = '2026.10.26';
const YTDLP_SHA256 = 'f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d';
const YTDLP_ASSET = 'yt-dlp.exe';
const USER_AGENT = 'FrameflowStudio/2.0 (desktop app)';
const WEB_LICENSE = '版权归原作者，仅供学习参考';
const FORMAT = 'bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/bv*[height<=1080]+ba/b';
const SUB_LANGS = 'zh-Hans,zh-CN,zh.*,en.*';
const MEDIA_EXTS = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v', '.flv', '.m4a', '.mp3', '.opus', '.ogg', '.wav']);
const YTDLP_ENV = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };

// ───────────────────────── 通用工具 ─────────────────────────

function cancelledError() {
  const e = new Error('已取消');
  e.code = 'CANCELLED';
  return e;
}

function isCancelled(err, signal) {
  return !!((err && err.code === 'CANCELLED') || (signal && signal.aborted));
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw cancelledError();
}

/** 在 Electron 主进程中优先用 net.fetch（遵循系统代理），否则用 Node 内置 fetch。 */
async function httpFetch(url, opts = {}) {
  const headers = { 'User-Agent': USER_AGENT, ...(opts.headers || {}) };
  const init = { method: opts.method || 'GET', headers, signal: opts.signal, redirect: 'follow' };
  if (process.versions && process.versions.electron && process.type === 'browser') {
    try {
      const electron = require('electron');
      if (electron && electron.net && typeof electron.net.fetch === 'function' && electron.app && electron.app.isReady()) {
        try {
          return await electron.net.fetch(url, init);
        } catch (e) {
          if (opts.signal && opts.signal.aborted) throw e;
          // net.fetch 偶发不支持的情况，回退到 Node fetch
        }
      }
    } catch (e) {
      if (opts.signal && opts.signal.aborted) throw cancelledError();
    }
  }
  return fetch(url, init);
}

function networkErrorMessage(err) {
  const code = (err && err.cause && (err.cause.code || err.cause.name)) || (err && err.code) || '';
  const map = {
    ENOTFOUND: '无法解析域名，请检查网络连接',
    EAI_AGAIN: '域名解析暂时失败，请检查网络连接',
    ECONNREFUSED: '连接被拒绝',
    ECONNRESET: '连接被重置（可能被网络拦截，可尝试使用代理）',
    ETIMEDOUT: '连接超时',
    UND_ERR_CONNECT_TIMEOUT: '连接超时（可能需要代理才能访问）',
    UND_ERR_SOCKET: '网络连接中断',
    CERT_HAS_EXPIRED: '证书校验失败',
  };
  if (map[code]) return map[code];
  const msg = (err && err.message) || String(err);
  if (/fetch failed/i.test(msg)) return '网络连接失败，请检查网络或代理设置';
  return msg;
}

/**
 * 流式下载到文件：写 .part 再 rename；支持进度、取消、空闲超时、大小上限。
 * sha256：给出时边下边算，不一致就删掉 .part 并抛 code='CHECKSUM_MISMATCH'。
 * fetchImpl：测试注入用，默认 httpFetch。
 * @returns {Promise<{ file, size, contentType, sha256 }>}
 */
async function downloadUrlToFile(url, dest, { signal, onProgress, headers, idleTimeoutMs = 30000, connectTimeoutMs = 30000, maxBytes = 4 * 1024 * 1024 * 1024, sha256, fetchImpl } = {}) {
  throwIfAborted(signal);
  const ctrl = new AbortController();
  let timedOut = false;
  let timer = null;
  const arm = (ms) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, ms);
  };
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const part = dest + '.part';
  const hasher = crypto.createHash('sha256');
  let ws = null;
  try {
    arm(connectTimeoutMs);
    let res;
    try {
      res = await (typeof fetchImpl === 'function' ? fetchImpl(url, { headers, signal: ctrl.signal }) : httpFetch(url, { headers, signal: ctrl.signal }));
    } catch (e) {
      if (signal && signal.aborted) throw cancelledError();
      if (timedOut) throw new Error('下载超时：服务器长时间没有响应');
      throw new Error('下载失败：' + networkErrorMessage(e));
    }
    if (!res.ok) {
      if (res.status === 404) throw new Error('下载失败：文件不存在（HTTP 404）');
      if (res.status === 403) throw new Error('下载失败：服务器拒绝访问（HTTP 403）');
      if (res.status === 429) throw new Error('下载失败：请求过于频繁（HTTP 429），请稍后再试');
      throw new Error(`下载失败（HTTP ${res.status}）`);
    }
    const total = Number(res.headers.get('content-length')) || 0;
    if (total && total > maxBytes) throw new Error(`文件过大（${Math.round(total / 1048576)} MB），已放弃下载`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    ws = fs.createWriteStream(part);
    const wsError = new Promise((_, reject) => ws.once('error', reject));
    wsError.catch(() => {});
    let received = 0;
    let lastReport = 0;
    arm(idleTimeoutMs);
    if (!res.body) throw new Error('下载失败：服务器没有返回内容');
    try {
      for await (const chunk of res.body) {
        arm(idleTimeoutMs);
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += buf.length;
        if (received > maxBytes) throw new Error('文件过大，已停止下载');
        hasher.update(buf);
        if (!ws.write(buf)) await Promise.race([once(ws, 'drain'), wsError]);
        const now = Date.now();
        if (onProgress && now - lastReport > 200) {
          lastReport = now;
          onProgress(total ? Math.min(0.999, received / total) : 0, received, total);
        }
      }
    } catch (e) {
      if (signal && signal.aborted) throw cancelledError();
      if (timedOut) throw new Error('下载超时：网络长时间没有数据');
      if (e && /文件过大/.test(e.message)) throw e;
      throw new Error('下载中断：' + networkErrorMessage(e));
    }
    if (timer) { clearTimeout(timer); timer = null; }
    await Promise.race([new Promise((resolve) => ws.end(resolve)), wsError]);
    ws = null;
    if (total && received < total) throw new Error('下载不完整，请重试');
    if (received === 0) throw new Error('下载失败：文件为空');
    const digest = hasher.digest('hex');
    if (sha256 && digest !== String(sha256).trim().toLowerCase()) {
      const err = new Error('下载的文件校验不一致（可能被网络篡改或损坏），已删除');
      err.code = 'CHECKSUM_MISMATCH';
      err.expected = String(sha256).toLowerCase();
      err.actual = digest;
      throw err;
    }
    try { fs.rmSync(dest, { force: true }); } catch {}
    fs.renameSync(part, dest);
    if (onProgress) onProgress(1, received, total || received);
    return { file: dest, size: received, contentType: res.headers.get('content-type') || '', sha256: digest };
  } catch (e) {
    if (ws) { try { ws.destroy(); } catch {} }
    try { fs.rmSync(part, { force: true }); } catch {}
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// ───────────────────────── 状态与安装 ─────────────────────────

const statusCache = { file: '', mtimeMs: 0, version: '' };
const verifyCache = { file: '', size: 0, mtimeMs: 0, result: null };

function releaseAssetUrl(tag, name = YTDLP_ASSET) {
  return `${YTDLP_REPO}/releases/download/${encodeURIComponent(tag)}/${name}`;
}

/** 安装记录（与 yt-dlp.exe 同目录的 yt-dlp.exe.json：{ tag, sha256, installedAt }）；旧版安装没有这个文件 */
function readInstallMeta(file) {
  try {
    const m = JSON.parse(fs.readFileSync(file + '.json', 'utf8'));
    return m && typeof m === 'object' ? m : null;
  } catch {
    return null;
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** 校验已安装的 yt-dlp 是否与安装时记录的 SHA-256 一致（按大小+修改时间缓存）；没有记录时视为「未校验」 */
async function verifyInstalled(file) {
  const meta = readInstallMeta(file);
  if (!meta || !/^[0-9a-f]{64}$/i.test(String(meta.sha256 || ''))) return { ok: true, verified: false, tag: '' };
  const st = fs.statSync(file);
  if (verifyCache.file === file && verifyCache.size === st.size && verifyCache.mtimeMs === st.mtimeMs && verifyCache.result) return verifyCache.result;
  const actual = await sha256File(file);
  const result = { ok: actual === String(meta.sha256).toLowerCase(), verified: true, tag: String(meta.tag || '') };
  Object.assign(verifyCache, { file, size: st.size, mtimeMs: st.mtimeMs, result });
  return result;
}

/** 永不 throw */
async function ytdlpStatus(paths) {
  let file = '';
  try {
    file = paths && paths.ytdlp;
    if (!file || !fs.existsSync(file)) return { installed: false, path: file || '', version: '', pinnedTag: YTDLP_TAG };
    const st = fs.statSync(file);
    if (st.size < 1024 * 1024) return { installed: false, path: file, version: '', pinnedTag: YTDLP_TAG };
    const meta = readInstallMeta(file);
    const extra = { tag: (meta && meta.tag) || '', verified: !!(meta && meta.sha256), pinnedTag: YTDLP_TAG };
    if (statusCache.file === file && statusCache.mtimeMs === st.mtimeMs && statusCache.version) {
      return { installed: true, path: file, version: statusCache.version, ...extra };
    }
    const r = await run(file, ['--version'], { timeoutMs: 20000, env: YTDLP_ENV });
    const version = String(r.stdout || '').trim().split(/\r?\n/)[0] || '';
    if (r.code !== 0 || !version) return { installed: false, path: file, version: '', pinnedTag: YTDLP_TAG };
    Object.assign(statusCache, { file, mtimeMs: st.mtimeMs, version });
    return { installed: true, path: file, version, ...extra };
  } catch {
    return { installed: false, path: file || '', version: '', pinnedTag: YTDLP_TAG };
  }
}

/** 解析 SHA2-256SUMS 文本，取某个文件的哈希 */
function parseSums(text, name = YTDLP_ASSET) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
    if (m && m[2] === name) return m[1].toLowerCase();
  }
  return '';
}

/** 查 GitHub 上的最新版本号和对应 yt-dlp.exe 的 SHA-256（用于「更新 yt-dlp」） */
async function resolveLatestRelease({ signal, fetchImpl } = {}) {
  const get = (url, accept) => (typeof fetchImpl === 'function' ? fetchImpl : httpFetch)(url, { headers: { Accept: accept }, signal });
  const res = await get('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', 'application/vnd.github+json');
  if (!res.ok) throw new Error(`查询新版本失败（HTTP ${res.status}）`);
  const rel = await res.json();
  const tag = String((rel && rel.tag_name) || '').trim();
  if (!/^[\w.-]{4,40}$/.test(tag)) throw new Error('查询新版本失败：版本号无效');
  const sums = await get(releaseAssetUrl(tag, 'SHA2-256SUMS'), 'text/plain');
  if (!sums.ok) throw new Error(`下载校验清单失败（HTTP ${sums.status}）`);
  const sha = parseSums(await sums.text(), YTDLP_ASSET);
  if (!sha) throw new Error('校验清单里没有 yt-dlp.exe');
  return { tag, sha256: sha };
}

function writeLicenseNotice(dir, tag, sha) {
  const text = [
    'yt-dlp（https://github.com/yt-dlp/yt-dlp）',
    `版本：${tag}`,
    `SHA-256：${sha}`,
    '',
    'yt-dlp 以 Unlicense 发布（作者放弃版权，进入公有领域）。',
    '官方发布的 Windows 可执行文件由 PyInstaller 打包，内含以 GPLv3+ 等许可发布的第三方组件，',
    `完整许可与源码见：${YTDLP_REPO}/blob/${tag}/LICENSE 以及 ${YTDLP_REPO}/blob/${tag}/THIRD_PARTY_LICENSES.txt`,
    '',
    '镜流 Frameflow 只在你同意视频站使用须知后，从 GitHub 官方发布页下载这个独立程序并校验 SHA-256，没有修改它。',
    '',
  ].join('\r\n');
  try { fs.writeFileSync(path.join(dir, 'yt-dlp.LICENSE.txt'), text, 'utf8'); } catch {}
}

/**
 * 安装 yt-dlp.exe 到 paths.ytdlp。
 * 默认装固定版本（YTDLP_TAG）并核对内置的 SHA-256；latest=true 时先查最新版本，用同版本的 SHA2-256SUMS 核对。
 * 下载放进新建的空临时目录，校验通过后才替换旧文件；任何一步失败都保留旧版本。
 */
async function installYtdlp(paths, { signal, onProgress, latest = false, fetchImpl, skipRunCheck = false } = {}) {
  if (!paths || !paths.ytdlp) throw new Error('无法确定 yt-dlp 的安装位置');
  const dest = paths.ytdlp;
  const report = (p, msg) => { if (onProgress) onProgress(p, msg); };
  let tag = YTDLP_TAG;
  let sha = YTDLP_SHA256;
  if (latest) {
    report(0, '正在查询 yt-dlp 最新版本…');
    try {
      ({ tag, sha256: sha } = await resolveLatestRelease({ signal, fetchImpl }));
    } catch (e) {
      if (isCancelled(e, signal)) throw cancelledError();
      throw new Error(`${e.message}（已保留当前版本）`);
    }
  }
  report(0, '正在连接 GitHub…');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const work = fs.mkdtempSync(path.join(path.dirname(dest), '.ytdlp-dl-'));
  const tmp = path.join(work, YTDLP_ASSET);
  const cleanup = () => { try { fs.rmSync(work, { recursive: true, force: true }); } catch {} };
  try {
    await downloadUrlToFile(releaseAssetUrl(tag), tmp, {
      signal,
      fetchImpl,
      sha256: sha,
      idleTimeoutMs: 45000,
      connectTimeoutMs: 45000,
      maxBytes: 200 * 1024 * 1024,
      onProgress: (p, received, total) => {
        const mb = (received / 1048576).toFixed(1);
        report(p * 0.95, total ? `正在下载 yt-dlp：${mb} / ${(total / 1048576).toFixed(1)} MB` : `正在下载 yt-dlp：${mb} MB`);
      },
    });
  } catch (e) {
    cleanup();
    if (isCancelled(e, signal)) throw cancelledError();
    if (e && e.code === 'CHECKSUM_MISMATCH') {
      const err = new Error('下载的 yt-dlp 和官方发布的文件不一致（可能被网络篡改或下载损坏），已删除，请稍后重试');
      err.code = 'YTDLP_CHECKSUM';
      throw err;
    }
    throw new Error(`${e.message}（安装 yt-dlp 需要能访问 github.com，如无法访问请配置系统代理后重试）`);
  }
  try {
    const fd = fs.openSync(tmp, 'r');
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    if (head.toString('latin1') !== 'MZ') throw new Error('bad');
  } catch {
    cleanup();
    throw new Error('下载的 yt-dlp 文件无效（不是 Windows 程序），请稍后重试');
  }
  report(0.96, '正在安装…');
  try {
    fs.rmSync(dest, { force: true });
  } catch {
    cleanup();
    throw new Error('旧版 yt-dlp 正在使用中，请等待当前下载任务结束后再更新');
  }
  try {
    fs.renameSync(tmp, dest);
  } catch (e) {
    cleanup();
    throw new Error('安装 yt-dlp 失败：' + ((e && e.message) || '无法写入文件'));
  }
  cleanup();
  try { fs.writeFileSync(dest + '.json', JSON.stringify({ tag, sha256: sha, installedAt: new Date().toISOString() }, null, 2), 'utf8'); } catch {}
  writeLicenseNotice(path.dirname(dest), tag, sha);
  statusCache.file = '';
  verifyCache.file = '';
  if (skipRunCheck) return { installed: true, path: dest, version: tag, tag, verified: true, pinnedTag: YTDLP_TAG };
  const st = await ytdlpStatus(paths);
  if (!st.installed) throw new Error('yt-dlp 已下载但无法运行，可能被安全软件拦截，请把它加入白名单后重试');
  report(1, `已安装 yt-dlp ${st.version}`);
  return st;
}

async function requireYtdlp(paths) {
  const st = await ytdlpStatus(paths);
  if (!st.installed) {
    const e = new Error('尚未安装 yt-dlp（视频站下载组件），请在「设置 → 联网」中一键安装');
    e.code = 'NO_YTDLP';
    throw e;
  }
  let v = null;
  try { v = await verifyInstalled(st.path); } catch { v = null; }
  if (v && !v.ok) {
    const e = new Error('视频下载组件 yt-dlp 的文件被改动过（和安装时的校验不一致），为安全起见已停止使用，请在「设置 → 联网」里重新安装');
    e.code = 'YTDLP_CHECKSUM';
    throw e;
  }
  return st.path;
}

// ───────────────────────── 系统代理 ─────────────────────────

/**
 * Chromium 代理描述 → yt-dlp --proxy 参数。
 * "PROXY 127.0.0.1:7890; DIRECT" → "http://127.0.0.1:7890"；"SOCKS5 h:1080" → "socks5://h:1080"；DIRECT → null
 */
function proxyFromPac(spec) {
  const first = String(spec || '').split(';').map((s) => s.trim()).filter(Boolean)[0] || '';
  const m = /^(PROXY|HTTPS|SOCKS5|SOCKS4|SOCKS)\s+([^\s;]+)$/i.exec(first);
  if (!m) return null;
  const scheme = { PROXY: 'http', HTTPS: 'https', SOCKS5: 'socks5', SOCKS4: 'socks4', SOCKS: 'socks4' }[m[1].toUpperCase()];
  return `${scheme}://${m[2]}`;
}

/** 用 Electron 解析系统代理（含 PAC）；不在 Electron 主进程或直连时返回 null */
async function systemProxyFor(url) {
  if (!(process.versions && process.versions.electron && process.type === 'browser')) return null;
  try {
    const electron = require('electron');
    if (!electron.app || !electron.app.isReady() || !electron.session || !electron.session.defaultSession) return null;
    const spec = await electron.session.defaultSession.resolveProxy(url);
    return proxyFromPac(spec);
  } catch {
    return null;
  }
}

// ───────────────────────── 错误解释 ─────────────────────────

function lastErrorLine(stderr) {
  const lines = String(stderr || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const errs = lines.filter((l) => /^ERROR:/i.test(l));
  return (errs[errs.length - 1] || lines[lines.length - 1] || '').replace(/^ERROR:\s*/i, '').slice(0, 220);
}

function explainYtdlpError(stderr, url = '') {
  const s = String(stderr || '');
  const isBili = /bilibili\.com|b23\.tv/i.test(url) || /bilibili/i.test(s);
  if (/Sign in to confirm|not a bot|confirm you.re not a bot/i.test(s)) return 'YouTube 要求登录验证（触发了反爬），请稍后重试或换一个视频';
  if (/Fresh cookies|cookies are needed/i.test(s)) {
    return /douyin|iesdouyin/i.test(url) || /douyin/i.test(s)
      ? '抖音需要登录信息才能解析，本软件不会读取浏览器的登录信息。请换一个其他网站的链接'
      : '这个网站需要登录信息才能解析，本软件不会读取浏览器的登录信息。请换一个链接';
  }
  if (/initial state|initial_state/i.test(s) && (/xiaohongshu|xhslink/i.test(url) || /xiaohongshu/i.test(s))) return '小红书页面解析失败（网站改版或需要登录），请稍后再试或换一个链接';
  if (/JavaScript runtime|JS runtime|n challenge|nsig|PO Token|po_token/i.test(s)) return 'YouTube 改了验证方式，当前版本暂时解析不了这个视频。请换一个视频，或在设置里更新 yt-dlp 后再试';
  if (/-352\b|code\s*-352|风控校验失败/i.test(s)) return 'B 站触发了风控（-352），请过几分钟再试';
  if (/HTTP Error 412|412 Precondition/i.test(s)) return 'B 站拒绝了请求（412 风控），请稍后再试，或换一个视频';
  if (/HTTP Error 429|Too Many Requests/i.test(s)) return '请求过于频繁（429），请过几分钟再试';
  if (/HTTP Error 403|Forbidden/i.test(s)) return isBili ? 'B 站拒绝访问（403），可能需要登录或该视频有地区限制' : '视频站拒绝访问（403），请稍后重试或更新 yt-dlp';
  if (/Private video|private/i.test(s) && /video/i.test(s)) return '这是私密视频，无法下载';
  if (/Video unavailable|This video is unavailable|has been removed|不存在|啥都木有/i.test(s)) return '视频不可用（已删除、私密或有地区限制）';
  if (/age[- ]restricted|confirm your age/i.test(s)) return '视频有年龄限制，需要登录才能观看';
  if (/members[- ]only|join this channel|大会员|premium/i.test(s)) return '会员专享视频，无法下载';
  if (/Unsupported URL/i.test(s)) return '不支持这个网址，请粘贴视频播放页的链接';
  if (/is not a valid URL|Invalid URL/i.test(s)) return '网址格式不正确';
  if (/Requested format is not available|No video formats found/i.test(s)) return '找不到可下载的视频格式（可能需要登录或更新 yt-dlp）';
  if (/ffmpeg.*not (found|installed)|ffprobe.*not found/i.test(s)) return '找不到 ffmpeg，无法合并音视频';
  if (/getaddrinfo|Name or service not known|Failed to resolve|nodename nor servname/i.test(s)) return '网络连接失败：无法解析域名，请检查网络';
  if (/timed out|Read timed out|ETIMEDOUT/i.test(s)) return '网络超时，请检查网络或代理后重试';
  if (/Connection reset|ECONNRESET|RemoteDisconnected|ConnectionResetError/i.test(s)) return '网络连接被重置，可能需要代理才能访问该网站';
  if (/SSL|CERTIFICATE_VERIFY_FAILED/i.test(s)) return '安全连接失败（证书错误），请检查系统时间或代理设置';
  if (/No space left|Errno 28/i.test(s)) return '磁盘空间不足';
  if (/live event|is live|premieres in/i.test(s)) return '直播或尚未首映的视频无法下载';
  const last = lastErrorLine(s);
  return last ? `下载失败：${last}` : '下载失败（未知原因），请更新 yt-dlp 后重试';
}

// ───────────────────────── 搜索 ─────────────────────────

function toHttps(u) {
  if (!u || typeof u !== 'string') return null;
  if (u.startsWith('//')) return 'https:' + u;
  if (u.startsWith('http://')) return 'https://' + u.slice(7);
  return u;
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDuration(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function pickThumb(entry) {
  const list = Array.isArray(entry.thumbnails) ? entry.thumbnails.filter((t) => t && t.url) : [];
  if (list.length) return toHttps(list[list.length - 1].url);
  return toHttps(entry.thumbnail) || null;
}

function entryUrl(site, entry) {
  const raw = entry.webpage_url || entry.url || '';
  if (/^https?:\/\//i.test(raw)) return toHttps(raw);
  if (site === 'youtube' && entry.id) return `https://www.youtube.com/watch?v=${entry.id}`;
  if (site === 'bilibili') {
    const id = String(entry.id || raw || '');
    if (/^BV/i.test(id)) return `https://www.bilibili.com/video/${id}`;
    if (/^\d+$/.test(id)) return `https://www.bilibili.com/video/av${id}`;
  }
  return raw || null;
}

function mapEntry(site, entry) {
  if (!entry) return null;
  const url = entryUrl(site, entry);
  if (!url) return null;
  let id = String(entry.id || '');
  if (!id) {
    const m = /(BV[0-9A-Za-z]+)|[?&]v=([\w-]+)/.exec(url);
    id = m ? (m[1] || m[2]) : url;
  }
  return {
    source: site,
    id: `${site}_${id}`,
    title: stripHtml(entry.title || entry.fulltitle || '') || (site === 'bilibili' ? 'B 站视频' : 'YouTube 视频'),
    url,
    thumb: pickThumb(entry),
    duration: parseDuration(entry.duration),
    width: Number(entry.width) || null,
    height: Number(entry.height) || null,
    author: stripHtml(entry.channel || entry.uploader || entry.creator || '') || null,
    license: WEB_LICENSE,
    kind: 'video',
  };
}

async function runYtdlpJson(bin, args, { signal, timeoutMs }) {
  let r;
  try {
    r = await run(bin, args, { signal, timeoutMs, env: YTDLP_ENV, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    if (isCancelled(e, signal)) throw cancelledError();
    if (/超时/.test(e.message)) throw new Error('搜索超时，请检查网络后重试');
    throw new Error('无法运行 yt-dlp：' + e.message);
  }
  const text = String(r.stdout || '').trim();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch {
      // 多行 JSON（不应出现）时取第一行
      try { data = JSON.parse(text.split(/\r?\n/)[0]); } catch {}
    }
  }
  if (!data) throw new Error(explainYtdlpError(r.stderr));
  return data;
}

/** 在 YouTube / B 站搜索，返回 WebResult[] */
async function searchSite(paths, site, query, limit = 8, { signal } = {}) {
  if (site !== 'youtube' && site !== 'bilibili') throw new Error('不支持的视频站：' + site);
  const q = String(query || '').replace(/[\r\n]+/g, ' ').trim();
  if (!q) throw new Error('请输入搜索关键词');
  const n = Math.max(1, Math.min(30, Math.round(Number(limit) || 8)));
  const bin = await requireYtdlp(paths);
  const prefix = site === 'youtube' ? `ytsearch${n}:` : `bilisearch${n}:`;
  const base = ['--flat-playlist', '-J', '--no-warnings', '--encoding', 'utf-8', '--socket-timeout', '20'];
  if (site === 'bilibili') base.push('--referer', 'https://www.bilibili.com/');
  // 系统代理（含 PAC 自动配置）：直连时不加
  const proxy = await systemProxyFor(site === 'youtube' ? 'https://www.youtube.com/' : 'https://www.bilibili.com/');
  const proxyArgs = proxy ? ['--proxy', proxy] : [];
  base.push(...proxyArgs);
  let data = await runYtdlpJson(bin, [...base, prefix + q], { signal, timeoutMs: 60000 });
  let entries = Array.isArray(data.entries) ? data.entries.filter(Boolean) : [];
  // B 站的扁平搜索结果常常只有链接没有标题/封面 → 做一次完整解析补全
  if (entries.length && entries.filter((e) => !e.title).length > entries.length / 2) {
    throwIfAborted(signal);
    try {
      const full = await runYtdlpJson(bin, ['-J', '--no-warnings', '--ignore-errors', '--skip-download', '--encoding', 'utf-8', '--socket-timeout', '20',
        ...(site === 'bilibili' ? ['--referer', 'https://www.bilibili.com/'] : []), ...proxyArgs, prefix + q], { signal, timeoutMs: 120000 });
      const fullEntries = Array.isArray(full.entries) ? full.entries.filter(Boolean) : [];
      if (fullEntries.length) entries = fullEntries;
    } catch (e) {
      if (isCancelled(e, signal)) throw e;
      // 补全失败就用扁平结果
    }
  }
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    const r = mapEntry(site, e);
    if (r && !seen.has(r.id)) { seen.add(r.id); out.push(r); }
  }
  return out.slice(0, n);
}

// ───────────────────────── 下载 ─────────────────────────

function platformOf(url) {
  const u = String(url || '').toLowerCase();
  if (/youtube\.com|youtu\.be/.test(u)) return 'youtube';
  if (/bilibili\.com|b23\.tv/.test(u)) return 'bilibili';
  if (/douyin\.com/.test(u)) return 'douyin';
  if (/kuaishou\.com/.test(u)) return 'kuaishou';
  if (/xiaohongshu\.com|xhslink/.test(u)) return 'xiaohongshu';
  if (/vimeo\.com/.test(u)) return 'vimeo';
  if (/tiktok\.com/.test(u)) return 'tiktok';
  if (/twitter\.com|x\.com/.test(u)) return 'twitter';
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'web'; }
}

function safeBase(name) {
  return String(name || 'video').replace(/[\\/:*?"<>|\x00-\x1f%#]+/g, '_').replace(/\s+/g, '_').replace(/^\.+/, '').slice(0, 60) || 'video';
}

function pickSubtitle(files, base) {
  const subs = files.filter((f) => f.startsWith(base + '.') && f.toLowerCase().endsWith('.vtt'));
  if (!subs.length) return null;
  const lang = (f) => f.slice(base.length + 1, -4).toLowerCase();
  const order = [/^zh-hans/, /^zh-cn/, /^zh-hant/, /^zh/, /^en/];
  for (const re of order) {
    const hit = subs.find((f) => re.test(lang(f)) && !/danmaku/.test(lang(f)));
    if (hit) return hit;
  }
  return subs.find((f) => !/danmaku/i.test(f)) || null;
}

function cleanupPartials(outDir, base) {
  try {
    for (const f of fs.readdirSync(outDir)) {
      if (f.startsWith(base + '.') && (/\.part$|\.ytdl$|\.temp\./i.test(f) || /\.f\d+\./.test(f))) {
        try { fs.rmSync(path.join(outDir, f), { force: true }); } catch {}
      }
    }
  } catch {}
}

/**
 * 用 yt-dlp 下载视频（可选字幕），返回 { file, subtitlesFile, info }。
 * opts.fileBase：输出文件名（不含扩展名），缺省按时间生成。
 */
async function downloadVideo(paths, url, outDir, { maxSeconds = 0, withSubs = false, signal, onProgress, fileBase } = {}) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('请提供以 http(s):// 开头的视频网址');
  const bin = await requireYtdlp(paths);
  if (!paths.ffmpeg || !fs.existsSync(paths.ffmpeg)) throw new Error('找不到 ffmpeg，无法下载与合并视频');
  fs.mkdirSync(outDir, { recursive: true });
  const base = safeBase(fileBase || `web_${Date.now().toString(36)}`);
  const platform = platformOf(url);
  // 系统代理（含 PAC 自动配置）：直连时不加
  const proxy = await systemProxyFor(url);

  const attempt = async (subs) => {
    const args = [
      '--no-playlist', '--newline', '--no-warnings', '--no-mtime', '--encoding', 'utf-8',
      '--ffmpeg-location', path.dirname(paths.ffmpeg),
      '-f', FORMAT, '--merge-output-format', 'mp4',
      '--retries', '3', '--fragment-retries', '3', '--socket-timeout', '20', '--concurrent-fragments', '4',
      '--write-info-json', '--no-write-playlist-metafiles',
      '-o', path.join(outDir, base + '.%(ext)s'),
    ];
    if (proxy) args.push('--proxy', proxy);
    const ms = Number(maxSeconds) || 0;
    if (ms > 0) args.push('--download-sections', `*0-${Math.ceil(ms)}`);
    if (subs) args.push('--write-subs', '--write-auto-subs', '--sub-langs', SUB_LANGS, '--sub-format', 'vtt', '--convert-subs', 'vtt');
    if (platform === 'bilibili') args.push('--referer', 'https://www.bilibili.com/');
    args.push(url);

    let part = -1;
    let best = 0;
    const report = (p, msg) => {
      const v = Math.max(best, Math.min(0.99, p));
      best = v;
      if (onProgress) onProgress(v, msg);
    };
    const handleLine = (line) => {
      if (/\[download\]\s+Destination:/.test(line)) { part += 1; return; }
      let m = /\[download\]\s+([\d.]+)%/.exec(line);
      if (m) {
        const p = Number(m[1]) / 100;
        const idx = Math.max(0, Math.min(1, part));
        report((idx + p) / 2, `正在下载 ${m[1]}%`);
        return;
      }
      m = /time=(\d+):(\d+):([\d.]+)/.exec(line);
      if (m && ms > 0) {
        const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        const idx = Math.max(0, Math.min(1, part));
        report((idx + Math.min(1, t / ms)) / 2, `正在下载片段 ${Math.round(t)} / ${Math.ceil(ms)} 秒`);
        return;
      }
      if (/\[Merger\]|\[FixupM3u8\]|\[VideoConvertor\]/.test(line)) report(0.97, '正在合并音视频…');
      else if (/\[info\].*subtitles|Writing video subtitles/i.test(line)) report(best, '正在下载字幕…');
    };
    const lineReader = () => {
      let buf = '';
      return (t) => {
        buf += t;
        const lines = buf.split(/\r?\n|\r/);
        buf = lines.pop();
        for (const l of lines) handleLine(l);
      };
    };
    const onOut = lineReader();
    const onErr = lineReader();
    report(0, '正在解析视频信息…');
    let r;
    try {
      r = await run(bin, args, {
        signal,
        env: YTDLP_ENV,
        timeoutMs: 45 * 60 * 1000,
        onStdout: (c) => onOut(c.toString('utf8')),
        onStderr: onErr,
      });
    } catch (e) {
      cleanupPartials(outDir, base);
      if (isCancelled(e, signal)) throw cancelledError();
      if (/超时/.test(e.message)) throw new Error('下载超时（超过 45 分钟），请缩短下载时长后重试');
      throw new Error('无法运行 yt-dlp：' + e.message);
    }
    return r;
  };

  const findMedia = (list) => list.find((f) => f.startsWith(base + '.') && MEDIA_EXTS.has(path.extname(f).toLowerCase())
    && !/\.f\d+(-\d+)?\.[^.]+$/.test(f) && !/\.temp\.[^.]+$/i.test(f));
  let r = await attempt(!!withSubs);
  let files = safeReaddir(outDir);
  let media = findMedia(files);
  if (!media && withSubs && /subtitle/i.test(r.stderr)) {
    // 字幕下载失败会让整个下载失败 → 不带字幕重试
    cleanupPartials(outDir, base);
    r = await attempt(false);
    files = safeReaddir(outDir);
    media = findMedia(files);
  }
  if (!media) {
    cleanupPartials(outDir, base);
    throw new Error(explainYtdlpError(r.stderr, url));
  }
  const file = path.join(outDir, media);
  const subName = withSubs ? pickSubtitle(files, base) : null;
  let info = { title: '', uploader: '', duration: null, webpageUrl: url, extractor: platform, id: '', thumbnail: null, description: '', width: null, height: null };
  const infoFile = path.join(outDir, base + '.info.json');
  try {
    const j = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
    info = {
      title: stripHtml(j.title || j.fulltitle || ''),
      uploader: stripHtml(j.uploader || j.channel || j.creator || ''),
      duration: parseDuration(j.duration),
      webpageUrl: j.webpage_url || url,
      extractor: j.extractor_key || j.extractor || platform,
      id: String(j.id || ''),
      thumbnail: toHttps(j.thumbnail) || null,
      description: String(j.description || '').slice(0, 1000),
      width: Number(j.width) || null,
      height: Number(j.height) || null,
      tags: Array.isArray(j.tags) ? j.tags.slice(0, 20).map(String) : [],
    };
  } catch {}
  try { fs.rmSync(infoFile, { force: true }); } catch {}
  // 其他语言字幕清理掉，只保留选中的
  for (const f of files) {
    if (f.startsWith(base + '.') && f.toLowerCase().endsWith('.vtt') && f !== subName) {
      try { fs.rmSync(path.join(outDir, f), { force: true }); } catch {}
    }
  }
  if (onProgress) onProgress(1, '下载完成');
  return { file, subtitlesFile: subName ? path.join(outDir, subName) : null, info, platform };
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

// ───────────────────────── VTT 解析 ─────────────────────────

function parseTimestamp(s) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(String(s).trim());
  if (!m) return NaN;
  const h = Number(m[1] || 0);
  const mi = Number(m[2]);
  const se = Number(m[3]);
  const ms = m[4] ? Number(m[4].padEnd(3, '0')) : 0;
  return h * 3600 + mi * 60 + se + ms / 1000;
}

function cleanCueLine(line) {
  return stripHtml(String(line).replace(/<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}>/g, '').replace(/\{\\[^}]*\}/g, ''))
    .replace(/^\s*-\s*/, '')
    .trim();
}

/** 解析 WebVTT（也兼容 SRT），去标签、去重滚动字幕。 */
function parseVtt(text) {
  const src = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const blocks = src.split(/\n{2,}/);
  const raw = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split('-->');
    const start = parseTimestamp(a);
    const end = parseTimestamp(String(b || '').trim().split(/\s+/)[0]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const textLines = lines.slice(ti + 1).map(cleanCueLine).filter(Boolean);
    raw.push({ start, end: Math.max(end, start), lines: textLines });
  }
  raw.sort((x, y) => x.start - y.start);
  const out = [];
  let prevLines = [];
  for (const cue of raw) {
    const lines = cue.lines;
    if (!lines.length) { prevLines = []; continue; }
    const fresh = lines.filter((l) => !prevLines.includes(l));
    prevLines = lines;
    const last = out[out.length - 1];
    if (!fresh.length) {
      // 滚动字幕的「保持」帧：延长上一条
      if (last && lines.includes(last.text) && cue.end > last.end) last.end = cue.end;
      continue;
    }
    const t = fresh.join(' ').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (last && last.text === t && cue.start - last.end < 0.5) {
      last.end = Math.max(last.end, cue.end);
      continue;
    }
    // 极短的过渡帧（YouTube 自动字幕常见 10ms 帧）若与下一条重复，会在下一轮被合并
    out.push({ start: round3(cue.start), end: round3(cue.end), text: t });
  }
  // 去掉被后续条目完全覆盖的极短重复
  return out.filter((c, i) => !(c.end - c.start < 0.05 && out[i + 1] && out[i + 1].text.startsWith(c.text)))
    .map((c) => ({ start: round3(c.start), end: round3(Math.max(c.end, c.start + 0.01)), text: c.text }));
}

function round3(v) { return Math.round(v * 1000) / 1000; }

module.exports = {
  ytdlpStatus,
  installYtdlp,
  requireYtdlp,
  searchSite,
  downloadVideo,
  parseVtt,
  // 供 web.cjs / analysis.cjs 复用
  httpFetch,
  downloadUrlToFile,
  explainYtdlpError,
  platformOf,
  stripHtml,
  safeBase,
  cancelledError,
  isCancelled,
  networkErrorMessage,
  systemProxyFor,
  USER_AGENT,
  WEB_LICENSE,
  YTDLP_TAG,
  YTDLP_SHA256,
  _internals: { mapEntry, parseTimestamp, pickSubtitle, parseDuration, toHttps, proxyFromPac, parseSums, releaseAssetUrl, verifyInstalled, readInstallMeta, resolveLatestRelease, sha256File },
};
