'use strict';
// electron-builder afterPack 钩子：打包完成、签名之前的快速自检。
// 这一步在翻转 fuses 之前运行，所以 fuses 状态由 scripts/check-artifacts.mjs 在打包结束后检查。
// 这里缺东西就直接让构建失败，避免打出不完整的安装包：
//   - ffmpeg / ffprobe 不在 resources/ffmpeg、或不是 LGPL 构建（先跑 npm run fetch:ffmpeg）
//   - 许可与隐私文件缺失（先跑 npm run gen:licenses）
//   - app.asar 里混入了 ffmpeg-static / ffprobe-static 或 .map 文件
const fs = require('node:fs');
const path = require('node:path');

function assertFile(p, hint) {
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error(`[after-pack] 缺少文件：${p}${hint ? `（${hint}）` : ''}`);
}

function checkResources(resources) {
  assertFile(path.join(resources, 'ffmpeg', 'ffmpeg.exe'), '请先运行 npm run fetch:ffmpeg');
  assertFile(path.join(resources, 'ffmpeg', 'ffprobe.exe'), '请先运行 npm run fetch:ffmpeg');
  const build = JSON.parse(fs.readFileSync(path.join(resources, 'ffmpeg', 'ffmpeg-build.json'), 'utf8'));
  if (build.license !== 'LGPL') throw new Error(`[after-pack] FFmpeg 不是 LGPL 构建：${build.licenseDetail || build.license}`);
  assertFile(path.join(resources, 'licenses', 'ffmpeg', 'LICENSE.txt'));
  assertFile(path.join(resources, 'licenses', 'ffmpeg', 'COPYING.GPLv3'));
  assertFile(path.join(resources, 'licenses', 'ffmpeg', 'SOURCE.txt'));
  assertFile(path.join(resources, 'licenses', 'THIRD_PARTY_LICENSES.txt'), '请先运行 npm run gen:licenses');
  assertFile(path.join(resources, 'licenses', 'privacy.txt'));
  if (!fs.existsSync(path.join(resources, 'builtin-audio', 'manifest.json'))) {
    console.warn('[after-pack] 提示：未打入内置音频（build/builtin-audio/manifest.json 不存在）');
  }
}

function checkAsar(resources) {
  // asar 模块由 electron-builder 带入 node_modules；缺失时必须明确失败，避免静默跳过检查
  let asar;
  try {
    asar = require('@electron/asar');
  } catch (e) {
    throw new Error(`[after-pack] 无法加载 @electron/asar，无法检查 app.asar：${e.message || e}`);
  }
  const entries = asar.listPackage(path.join(resources, 'app.asar'));
  const bad = entries.filter((e) => /\.map$/i.test(e) || /[\\/]node_modules[\\/](ffmpeg-static|ffprobe-static)([\\/]|$)/.test(e));
  if (bad.length) throw new Error(`[after-pack] app.asar 含不应打包的文件：${bad.slice(0, 10).join(', ')}`);
}

module.exports = async function afterPack(context) {
  const resources = path.join(context.appOutDir, 'resources');
  checkResources(resources);
  checkAsar(resources);
  console.log('[after-pack] 自检通过：', resources);
};

module.exports.checkResources = checkResources;
module.exports.checkAsar = checkAsar;
