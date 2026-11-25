#!/usr/bin/env node
// 发行产物体检：只读检查 electron-builder 的输出目录，不启动应用。
// 用法：node scripts/check-artifacts.mjs [--dir=<win-unpacked 目录>]（默认 dist/win-unpacked）
// 检查项：五个 fuse 的状态、ffmpeg 在位且为 LGPL、许可与隐私文件、内置音频清单、
//         app.asar 里没有 .map 和 ffmpeg-static / ffprobe-static、语言包数量、体积上限。
// 有任一项失败时以退出码 1 结束。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));

// 体积上限用于发现回归，超过时检查是不是打进了不该打的东西
export const LIMITS = {
  asarBytes: 16 * 1048576,
  asarEntries: 300,
  ffmpegDirBytes: 220 * 1048576,
  totalBytes: 620 * 1048576,
  locales: 2,
};

export const EXPECTED_FUSES = {
  RunAsNode: 'DISABLE',
  EnableNodeOptionsEnvironmentVariable: 'DISABLE',
  EnableNodeCliInspectArguments: 'DISABLE',
  EnableEmbeddedAsarIntegrityValidation: 'ENABLE',
  OnlyLoadAppFromAsar: 'ENABLE',
};

function dirBytes(dir) {
  let total = 0;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    total += d.isDirectory() ? dirBytes(p) : fs.statSync(p).size;
  }
  return total;
}

const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

function fuseState(v) {
  if (v === 49) return 'ENABLE';
  if (v === 48) return 'DISABLE';
  if (v === 114) return 'REMOVED';
  if (v === 144) return 'INHERIT';
  return String(v);
}

// 判定 asar 条目是否违规（纯函数，便于测试）
export function badAsarEntries(entries) {
  return entries.filter((e) => /\.map$/i.test(e) || /[\\/]node_modules[\\/](ffmpeg-static|ffprobe-static)([\\/]|$)/.test(e));
}

// 校验内置音频清单（纯函数，exists 可注入）
export function checkAudioManifest(manifest, exists) {
  const problems = [];
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.items)) return ['清单结构不符合 { version: 1, items: [] }'];
  const seen = new Set();
  for (const it of manifest.items) {
    const label = it && it.id ? it.id : JSON.stringify(it);
    if (!it || !it.id || !it.title || !it.file || !(it.duration > 0)) { problems.push(`条目字段不全：${label}`); continue; }
    if (seen.has(it.id)) problems.push(`id 重复：${it.id}`);
    seen.add(it.id);
    if (it.kind !== 'music' && it.kind !== 'sfx') problems.push(`kind 非法：${label}`);
    if (!it.license || !it.license.id) problems.push(`缺少许可：${label}`);
    if (!exists(it.file)) problems.push(`文件缺失：${it.file}`);
  }
  return problems;
}

export async function inspect(dir) {
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
  const resources = path.join(dir, 'resources');
  const exe = path.join(dir, 'Frameflow.exe');

  if (!fs.existsSync(exe)) {
    check('Frameflow.exe 存在', false, exe);
    return results;
  }
  check('Frameflow.exe 存在', true);

  // fuses
  const fuses = require('@electron/fuses');
  const wire = await fuses.getCurrentFuseWire(exe);
  for (const [name, want] of Object.entries(EXPECTED_FUSES)) {
    const got = fuseState(wire[fuses.FuseV1Options[name]]);
    check(`fuse ${name} = ${want}`, got === want, got);
  }

  // ffmpeg
  const ffDir = path.join(resources, 'ffmpeg');
  check('ffmpeg.exe 在位', fs.existsSync(path.join(ffDir, 'ffmpeg.exe')));
  check('ffprobe.exe 在位', fs.existsSync(path.join(ffDir, 'ffprobe.exe')));
  let build = null;
  try { build = JSON.parse(fs.readFileSync(path.join(ffDir, 'ffmpeg-build.json'), 'utf8')); } catch {}
  check('FFmpeg 为 LGPL 构建', build && build.license === 'LGPL', build ? `${build.licenseDetail} ${build.version}` : '缺少 ffmpeg-build.json');
  const unpackedNm = path.join(resources, 'app.asar.unpacked', 'node_modules');
  check('安装包里没有 ffmpeg-static / ffprobe-static', !fs.existsSync(path.join(unpackedNm, 'ffmpeg-static')) && !fs.existsSync(path.join(unpackedNm, 'ffprobe-static')));

  // 许可与隐私
  for (const rel of ['licenses/THIRD_PARTY_LICENSES.txt', 'licenses/privacy.txt', 'licenses/ffmpeg/LICENSE.txt', 'licenses/ffmpeg/SOURCE.txt']) {
    check(`${rel} 存在`, fs.existsSync(path.join(resources, rel)));
  }

  // 内置音频（允许没有；有清单就要完整）
  const audioDir = path.join(resources, 'builtin-audio');
  const manifestPath = path.join(audioDir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const problems = checkAudioManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), (f) => fs.existsSync(path.join(audioDir, f)));
    check('内置音频清单完整', problems.length === 0, problems.slice(0, 5).join('；'));
  } else {
    check('内置音频清单完整', true, '未打入内置音频');
  }

  // app.asar
  const asar = require('@electron/asar');
  const asarPath = path.join(resources, 'app.asar');
  const entries = asar.listPackage(asarPath);
  const bad = badAsarEntries(entries);
  check('app.asar 没有 .map 与 ffmpeg-static', bad.length === 0, bad.slice(0, 5).join(', '));
  check('app.asar 含入口文件', entries.some((e) => /[\\/]electron[\\/]main\.cjs$/.test(e)) && entries.some((e) => /[\\/]dist-renderer[\\/]index\.html$/.test(e)));
  const asarBytes = fs.statSync(asarPath).size;
  check(`app.asar 体积 ≤ ${mb(LIMITS.asarBytes)}`, asarBytes <= LIMITS.asarBytes, mb(asarBytes));
  check(`app.asar 条目数 ≤ ${LIMITS.asarEntries}`, entries.length <= LIMITS.asarEntries, String(entries.length));

  // 语言包与总体积
  const locales = fs.readdirSync(path.join(dir, 'locales')).filter((n) => n.endsWith('.pak'));
  check(`语言包 ≤ ${LIMITS.locales} 个`, locales.length <= LIMITS.locales, locales.join(', '));
  if (fs.existsSync(ffDir)) {
    const ffBytes = dirBytes(ffDir);
    check(`resources/ffmpeg 体积 ≤ ${mb(LIMITS.ffmpegDirBytes)}`, ffBytes <= LIMITS.ffmpegDirBytes, mb(ffBytes));
  }
  const total = dirBytes(dir);
  check(`总体积 ≤ ${mb(LIMITS.totalBytes)}`, total <= LIMITS.totalBytes, mb(total));
  return results;
}

async function main() {
  const dirArg = (process.argv.find((a) => a.startsWith('--dir=')) || '').slice(6);
  const dir = path.resolve(dirArg || path.join(ROOT, 'dist', 'win-unpacked'));
  console.log('检查目录：', dir);
  if (!fs.existsSync(dir)) {
    console.error('目录不存在，请先运行 electron-builder。');
    process.exit(1);
  }
  const results = await inspect(dir);
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed += 1;
    console.log(`${r.ok ? '通过' : '失败'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
  }
  console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
