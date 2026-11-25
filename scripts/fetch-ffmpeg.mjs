#!/usr/bin/env node
// 构建期脚本（不在用户机器上运行）：下载固定版本的 FFmpeg LGPL 构建到 vendor/ffmpeg。
//   来源：FFmpeg-Builds/FFmpeg-Builds 的 win64-lgpl-shared（动态库版，用户可自行替换 DLL，满足 LGPL 要求）。
//   校验：写死 SHA-256，流式计算，不一致立刻失败；若滚动 autobuild 标签已下线（HTTP 404），
//        自动回退到 GitHub Releases API 查询最新 win64-lgpl-shared 构建并按官方 checksums.sha256 校验；
//        解压后核对编码器、滤镜与许可配置，经临时目录暂存校验通过后再切换至 vendor/ffmpeg。
//   产物：
//     vendor/ffmpeg/bin/{ffmpeg.exe,ffprobe.exe,*.dll,ffmpeg-build.json}  → 打包时进 resources/ffmpeg/
//     vendor/ffmpeg/{LICENSE.txt,COPYING.GPLv3,SOURCE.txt}                → 打包时进 resources/licenses/ffmpeg/
// 用法：
//   node scripts/fetch-ffmpeg.mjs [--dl=<下载用的新建空目录>] [--force] [--keep-dl]
//   更新版本：改下面的 PIN（tag、文件名、SHA-256、scriptsCommit）后重跑。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'vendor', 'ffmpeg');
const BIN = path.join(OUT, 'bin');

export const PIN = {
  tag: 'autobuild-2026-11-08-12-35',
  file: 'ffmpeg-n8.1.3-34-ga35157abb9-win64-lgpl-shared-8.1.zip',
  sha256: 'f2ff0b5756af156ca291da018c3cc1985fc43041388e09a5b0bd9901faa511b3',
  version: 'n8.1.3-34-ga35157abb9',
  ffmpegCommit: 'a35157abb9',
  scriptsCommit: 'c9fe5114060e507409f7ee07edfd82efaf25d767',
};

const REPO = 'https://github.com/FFmpeg-Builds/FFmpeg-Builds';
const REPO_API = 'https://api.github.com/repos/FFmpeg-Builds/FFmpeg-Builds';
export const urlOf = (pin) => pin.url || `${REPO}/releases/download/${pin.tag}/${pin.file}`;

// 工程实际用到的能力。缺其中任何一项都不能发行，脚本直接失败。
export const REQUIRED_ENCODERS = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'aac', 'libmp3lame', 'mpeg4'];
export const REQUIRED_FILTERS = [
  'scale', 'setsar', 'format', 'fps', 'split', 'select', 'showinfo', 'pad', 'tile', 'palettegen', 'paletteuse',
  'color', 'gradients', 'anullsrc', 'amix', 'apad', 'atrim', 'asetpts', 'atempo', 'aresample', 'aformat', 'afade',
  'afftdn', 'volume', 'concat', 'drawtext',
];

// 解析 `ffmpeg -encoders`：` V....D h264_nvenc   说明`
export function parseEncoders(text) {
  const out = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s([VAS][F.][S.][X.][B.][D.])\s+(\S+)/.exec(line);
    if (m && m[2] !== '=') out.add(m[2]);
  }
  return out;
}

// 解析 `ffmpeg -filters`：` T.. scale   V->V   说明`（标记位各版本宽度不同）
export function parseFilters(text) {
  const out = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s([T.][S.][C.]?)\s+([a-zA-Z0-9_]+)\s+(\S+->\S+)/.exec(line);
    if (m) out.add(m[2]);
  }
  return out;
}

// 由 `-version` 的 configuration 判断许可。--enable-gpl → GPL；否则 LGPL（--enable-version3 时为 v3）。
export function licenseFromVersionText(text) {
  const s = String(text);
  if (/--enable-gpl\b/.test(s)) return { license: 'GPL', detail: /--enable-version3\b/.test(s) ? 'GPL v3' : 'GPL v2+' };
  if (/--enable-nonfree\b/.test(s)) return { license: 'unknown', detail: 'nonfree（禁止分发）' };
  if (!/configuration:/.test(s)) return { license: 'unknown', detail: '未找到构建配置' };
  return { license: 'LGPL', detail: /--enable-version3\b/.test(s) ? 'LGPL v3' : 'LGPL v2.1+' };
}

// 解析 checksums.sha256 中指定文件的 SHA-256
export function parseChecksum(text, fileName) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (m && path.basename(m[2]) === fileName) return m[1].toLowerCase();
  }
  return null;
}

const log = (...a) => console.log('[fetch-ffmpeg]', ...a);
const fail = (msg) => { console.error('[fetch-ffmpeg] 失败：', msg); process.exit(1); };
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

// 下载目录必须是新建的空目录（或只含本次脚本的压缩包 / 解压目录，用于续用）
function prepareDl(dir) {
  if (fs.existsSync(dir)) {
    const isAllowedName = (n) => n === 'x'
      || n === PIN.file
      || n === `${PIN.file}.part`
      || /^ffmpeg-.*win64-lgpl-shared.*\.zip(\.part)?$/i.test(n);
    const rest = fs.readdirSync(dir).filter((n) => !isAllowedName(n));
    if (rest.length) fail(`下载目录不是空目录：${dir}（含 ${rest.join(', ')}）`);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'frameflow-build' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}（${url}）`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'frameflow-build' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}（${url}）`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

// 当固定 autobuild 标签返回 404 时，通过 GitHub Releases API 查找最新 win64-lgpl-shared 并核对 checksums.sha256
async function resolveLatestRelease() {
  const candidates = [];
  try {
    candidates.push(await fetchJson(`${REPO_API}/releases/latest`));
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  try {
    const list = await fetchJson(`${REPO_API}/releases?per_page=10`);
    if (Array.isArray(list)) candidates.push(...list);
  } catch (e) {
    if (!candidates.length) throw e;
  }

  for (const rel of candidates) {
    const assets = Array.isArray(rel?.assets) ? rel.assets : [];
    const sumAsset = assets.find((a) => a.name === 'checksums.sha256');
    const zips = assets.filter((a) => /^ffmpeg-.*win64-lgpl-shared.*\.zip$/i.test(a.name));
    if (!sumAsset || !zips.length) continue;

    // 优先选择带版本号的稳定分支构建（如 ffmpeg-n8.1...-win64-lgpl-shared...zip），再回退到其它 win64-lgpl-shared zip
    const zipAsset = zips.find((a) => /^ffmpeg-n\d+/i.test(a.name))
      || zips.find((a) => /latest-win64-lgpl-shared\.zip$/i.test(a.name))
      || zips[0];

    const sumText = await fetchText(sumAsset.browser_download_url);
    const sha256 = parseChecksum(sumText, zipAsset.name);
    if (!sha256) throw new Error(`release ${rel.tag_name} 的 checksums.sha256 中找不到 ${zipAsset.name}`);

    const verMatch = /^ffmpeg-([^-]+(?:-\d+-g([0-9a-f]+))?)-win64-lgpl-shared/i.exec(zipAsset.name);
    return {
      tag: rel.tag_name,
      file: zipAsset.name,
      sha256,
      url: zipAsset.browser_download_url,
      version: verMatch ? verMatch[1] : rel.tag_name,
      ffmpegCommit: verMatch?.[2] || '',
      scriptsCommit: rel.target_commitish || PIN.scriptsCommit,
    };
  }
  throw new Error(`在 ${REPO} Releases 中未找到带 checksums.sha256 的 win64-lgpl-shared 构建`);
}

async function download(url, dest) {
  const part = `${dest}.part`;
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'frameflow-build' }, signal: AbortSignal.timeout(30 * 60000) });
  if (!res.ok || !res.body) {
    const err = new Error(`HTTP ${res.status}（${url}）`);
    err.status = res.status;
    throw err;
  }
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = createHash('sha256');
  const out = fs.createWriteStream(part);
  const reader = res.body.getReader();
  let got = 0;
  let lastLog = Date.now();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      got += value.length;
      if (!out.write(value)) await once(out, 'drain');
      if (Date.now() - lastLog > 5000) {
        lastLog = Date.now();
        log('下载中', mb(got), total ? `/ ${mb(total)}` : '');
      }
    }
    await new Promise((resolve, reject) => { out.on('error', reject); out.end(resolve); });
  } catch (e) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw e;
  }
  if (total && got !== total) {
    fs.rmSync(part, { force: true });
    throw new Error(`下载不完整：${got}/${total}`);
  }
  fs.renameSync(part, dest);
  return hash.digest('hex');
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

async function fetchZipForPin(pin, zip) {
  const url = urlOf(pin);
  let lastErr;
  for (let i = 1; i <= 3; i += 1) {
    try {
      log(`下载（第 ${i} 次）`, url);
      const digest = await download(url, zip);
      if (digest !== pin.sha256) throw new Error(`SHA-256 不一致：期望 ${pin.sha256}，实际 ${digest}`);
      log('SHA-256 校验通过', digest);
      return;
    } catch (e) {
      lastErr = e;
      log('下载失败：', e.message);
      fs.rmSync(zip, { force: true });
      fs.rmSync(`${zip}.part`, { force: true });
      if (e.status === 404) break;
    }
  }
  throw lastErr;
}

function unzip(zip, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const r = spawnSync(tar, ['-xf', zip, '-C', dest], { cwd: ROOT, stdio: 'pipe', windowsHide: true });
  if (r.status !== 0) throw new Error(`解压失败：${String(r.stderr || r.error || '')}`);
}

function findBuildDir(x) {
  const hit = fs.readdirSync(x, { withFileTypes: true }).find((d) => d.isDirectory() && fs.existsSync(path.join(x, d.name, 'bin', 'ffmpeg.exe')));
  return hit ? path.join(x, hit.name) : null;
}

function run(bin, args) {
  const r = spawnSync(bin, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1048576, windowsHide: true });
  return { code: r.status, out: `${r.stdout || ''}\n${r.stderr || ''}` };
}

// 校验二进制：能运行、不是 GPL、功能齐全。返回写进 ffmpeg-build.json 的内容。
export function verifyBinaries(binDir) {
  const ffmpeg = path.join(binDir, 'ffmpeg.exe');
  const ffprobe = path.join(binDir, 'ffprobe.exe');
  const ver = run(ffmpeg, ['-hide_banner', '-version']);
  if (ver.code !== 0) throw new Error(`ffmpeg 无法运行：${ver.out.slice(0, 400)}`);
  const pver = run(ffprobe, ['-hide_banner', '-version']);
  if (pver.code !== 0) throw new Error(`ffprobe 无法运行：${pver.out.slice(0, 400)}`);

  const lic = licenseFromVersionText(ver.out);
  if (lic.license !== 'LGPL') throw new Error(`不是 LGPL 构建：${lic.detail}`);
  const verLine = (s) => (s.split(/\r?\n/).find((l) => /^ff(mpeg|probe) version/.test(l)) || '').trim();
  const v1 = verLine(ver.out).split(/\s+/)[2];
  const v2 = verLine(pver.out).split(/\s+/)[2];
  if (!v1 || v1 !== v2) throw new Error(`ffmpeg(${v1}) 与 ffprobe(${v2}) 不是同一构建`);

  const encoders = parseEncoders(run(ffmpeg, ['-hide_banner', '-encoders']).out);
  const filters = parseFilters(run(ffmpeg, ['-hide_banner', '-filters']).out);
  const missEnc = REQUIRED_ENCODERS.filter((e) => !encoders.has(e));
  const missFil = REQUIRED_FILTERS.filter((f) => !filters.has(f));
  if (missEnc.length) throw new Error(`缺少编码器：${missEnc.join(', ')}`);
  if (missFil.length) throw new Error(`缺少滤镜：${missFil.join(', ')}`);

  return {
    license: lic.license,
    licenseDetail: lic.detail,
    version: v1,
    configuration: (ver.out.split(/\r?\n/).find((l) => /^\s*configuration:/.test(l)) || '').trim(),
    h264Encoders: [...encoders].filter((e) => /h264/.test(e)).sort(),
    hasLibx264: encoders.has('libx264'),
    hasOpenh264: encoders.has('libopenh264'),
  };
}

function sourceText(pin, info) {
  const ffmpegRef = pin.ffmpegCommit || info.version;
  return [
    'FFmpeg 许可与源码获取说明',
    '',
    `镜流 Frameflow 随附 FFmpeg（ffmpeg.exe、ffprobe.exe 及其动态库），许可证为 ${info.licenseDetail}，全文见同目录 LICENSE.txt 及 COPYING.GPLv3。`,
    'FFmpeg 以独立程序形式被调用，未修改其源代码；动态库位于安装目录 resources\\ffmpeg，用户可自行替换。',
    '',
    `版本：${info.version}`,
    `构建：${pin.file}`,
    `构建来源：${REPO}/releases/tag/${pin.tag}`,
    `构建脚本（含全部依赖的版本与补丁）：${REPO}/tree/${pin.scriptsCommit}`,
    `FFmpeg 对应源码：https://github.com/FFmpeg/FFmpeg/tree/${ffmpegRef}`,
    'FFmpeg 官方网站：https://ffmpeg.org/',
    '',
    `构建配置：${info.configuration.replace(/^configuration:\s*/, '')}`,
    '',
  ].join('\r\n');
}

function swapStagedOutput(stageDir) {
  const parent = path.dirname(OUT);
  const backupDir = path.join(parent, `.ffmpeg-backup-${randomBytes(4).toString('hex')}`);
  fs.mkdirSync(parent, { recursive: true });
  const hadOut = fs.existsSync(OUT);
  if (hadOut) fs.renameSync(OUT, backupDir);
  try {
    fs.renameSync(stageDir, OUT);
  } catch (e) {
    if (hadOut && fs.existsSync(backupDir) && !fs.existsSync(OUT)) {
      try { fs.renameSync(backupDir, OUT); } catch { /* 保留 backupDir 以防数据丢失 */ }
    }
    throw e;
  }
  if (hadOut) fs.rmSync(backupDir, { recursive: true, force: true });
}

async function main() {
  if (process.platform !== 'win32') fail('当前只提供 Windows 构建');
  const force = process.argv.includes('--force');
  const stamp = path.join(BIN, 'ffmpeg-build.json');
  if (!force && fs.existsSync(stamp)) {
    const cur = JSON.parse(fs.readFileSync(stamp, 'utf8'));
    const ready = cur.sha256 === PIN.sha256
      && fs.existsSync(path.join(BIN, 'ffmpeg.exe'))
      && fs.existsSync(path.join(BIN, 'ffprobe.exe'))
      && fs.existsSync(path.join(OUT, 'LICENSE.txt'))
      && fs.existsSync(path.join(OUT, 'COPYING.GPLv3'))
      && fs.existsSync(path.join(OUT, 'SOURCE.txt'));
    if (ready) {
      log('已是目标版本，跳过（需要重下请加 --force）：', cur.version);
      return;
    }
  }

  const customDl = arg('dl');
  const dl = prepareDl(customDl || path.join(os.tmpdir(), `frameflow-ffmpeg-${randomBytes(4).toString('hex')}`));
  const stageDir = path.join(path.dirname(OUT), `.ffmpeg-stage-${randomBytes(4).toString('hex')}`);

  try {
    let activePin = PIN;
    let zip = path.join(dl, activePin.file);
    if (fs.existsSync(zip) && (await sha256File(zip)) === activePin.sha256) {
      log('复用已下载且校验通过的文件', zip);
    } else {
      try {
        await fetchZipForPin(activePin, zip);
      } catch (e) {
        if (e.status !== 404) throw e;
        log(`固定标签 ${activePin.tag} 已失效（HTTP 404），通过 GitHub Releases API 查询最新 win64-lgpl-shared 构建`);
        activePin = await resolveLatestRelease();
        log(`回退构建：${activePin.tag} / ${activePin.file}`);
        zip = path.join(dl, activePin.file);
        if (fs.existsSync(zip) && (await sha256File(zip)) === activePin.sha256) {
          log('复用已下载且校验通过的回退文件', zip);
        } else {
          await fetchZipForPin(activePin, zip);
        }
      }
    }

    const x = path.join(dl, 'x');
    log('解压到', x);
    unzip(zip, x);
    const buildDir = findBuildDir(x);
    if (!buildDir) throw new Error('压缩包结构不符合预期：找不到 bin/ffmpeg.exe');

    log('核对编码器、滤镜与许可');
    const info = verifyBinaries(path.join(buildDir, 'bin'));
    log('许可', info.licenseDetail, '版本', info.version, 'H.264 编码器', info.h264Encoders.join(', '));

    const lic = ['LICENSE.txt', 'LICENSE', 'COPYING.LGPLv3', 'COPYING.LGPLv2.1'].map((n) => path.join(buildDir, n)).find((p) => fs.existsSync(p));
    if (!lic) throw new Error('压缩包里没有 LICENSE 文件');

    const gplSrc = ['COPYING.GPLv3', 'COPYING.GPLv3.txt']
      .map((n) => path.join(buildDir, n))
      .concat([path.join(OUT, 'COPYING.GPLv3')])
      .find((p) => fs.existsSync(p));
    if (!gplSrc) throw new Error('缺少 COPYING.GPLv3（LGPL v3 §4(b) 要求随附 GNU GPL v3 全文）');

    // 先完整暂存到同盘临时目录，所有文件写入无误后再切换进 vendor/ffmpeg，避免失败时破坏已跟踪的许可文件
    const stageBin = path.join(stageDir, 'bin');
    fs.mkdirSync(stageBin, { recursive: true });
    for (const name of fs.readdirSync(path.join(buildDir, 'bin'))) {
      if (name === 'ffplay.exe' || !/\.(exe|dll)$/i.test(name)) continue;
      fs.copyFileSync(path.join(buildDir, 'bin', name), path.join(stageBin, name));
    }
    fs.copyFileSync(lic, path.join(stageDir, 'LICENSE.txt'));
    fs.copyFileSync(gplSrc, path.join(stageDir, 'COPYING.GPLv3'));
    fs.writeFileSync(path.join(stageDir, 'SOURCE.txt'), '\uFEFF' + sourceText(activePin, info), 'utf8');
    fs.writeFileSync(path.join(stageBin, 'ffmpeg-build.json'), JSON.stringify({
      variant: 'lgpl-shared',
      source: REPO,
      tag: activePin.tag,
      file: activePin.file,
      sha256: activePin.sha256,
      scriptsCommit: activePin.scriptsCommit,
      ffmpegCommit: activePin.ffmpegCommit || info.version,
      ...info,
    }, null, 2) + '\n', 'utf8');

    swapStagedOutput(stageDir);

    const size = fs.readdirSync(BIN).reduce((s, n) => s + fs.statSync(path.join(BIN, n)).size, 0);
    log('完成：', BIN, mb(size));
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
    if (!process.argv.includes('--keep-dl') && !customDl) fs.rmSync(dl, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => fail(e.message));
}
