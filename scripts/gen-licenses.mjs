#!/usr/bin/env node
// 生成 build/THIRD_PARTY_LICENSES.txt（第三方软件与素材许可声明）和 build/privacy.txt（隐私说明的纯文本版）。
// 打包时两者都进入 resources/licenses/，安装包和“关于”页面会引用它们。
//
// 收录范围：
//   1. 打包进程序的 npm 包：package.json 的 dependencies（含传递依赖），以及界面代码 src/ 里实际 import 的包
//      （vite 会把它们打进 dist-renderer）。每个包附上许可全文。许可不在白名单内、或找不到许可文件时直接失败。
//   2. FFmpeg：读取 vendor/ffmpeg/bin/ffmpeg-build.json，必须是 LGPL 构建。
//   3. Electron / Chromium：指向安装目录里的 LICENSE.electron.txt 和 LICENSES.chromium.html。
//   4. 移植进源码的开源代码（PORTED，手工登记；源码里出现「移植自」却没登记时失败）。
//   5. 内置音乐与音效（build/builtin-audio/manifest.json）、示例素材（build/sample-media/manifest.json）。
//   6. 用户按需下载、不随安装包分发的组件（yt-dlp、whisper.cpp 与模型）。
// privacy.txt 由 docs/PRIVACY.md 转换而来，两边只维护 docs/PRIVACY.md。
// 用法：node scripts/gen-licenses.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 允许打包分发的许可（SPDX）。其它许可需要先评估再加入。
export const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'Unlicense', 'CC0-1.0', 'BlueOak-1.0.0', 'Zlib']);

// 允许的 SPDX WITH 附加例外白名单；未列入的限制性或未知例外一律拒绝。
export const ALLOWED_EXCEPTIONS = new Set([
  'LLVM-exception',
  'Classpath-exception-2.0',
  'GCC-exception-3.1',
  'Swift-exception',
  'Universal-FOSS-exception-1.0',
  'Font-exception-2.0',
]);

// 许可正文（不含版权行），与上游 LICENSE 文件逐字一致
const MIT_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
const ISC_BODY = `Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`;
const BSD3_BODY = `Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

// 移植进本软件源码的开源代码（不是 npm 依赖，所以要在这里手工登记）。
// 版权行取自上游 LICENSE 文件（2026-11-09 核对）。files 是用到它的源码文件，文件头里写着来源。
// 有人新移植了代码，要在这里补一条；main() 会扫描源码里的「移植自」字样并提醒没登记的文件。
export const PORTED = [
  {
    name: 'Lucide 图标', license: 'ISC', url: 'https://github.com/lucide-icons/lucide',
    use: '界面图标的部分路径', files: ['src/ui/components/ui.jsx'],
    text: `ISC License\n\nCopyright (c) 2026 Lucide Icons and Contributors\n\n${ISC_BODY}`,
  },
  {
    name: 'Feather 图标', license: 'MIT', url: 'https://github.com/feathericons/feather',
    use: '界面图标的部分路径', files: ['src/ui/components/ui.jsx'],
    text: `The MIT License (MIT)\n\nCopyright (c) 2013-2023 Cole Bemis\n\n${MIT_BODY}`,
  },
  {
    name: 'Color Thief / quantize.js', license: 'MIT', url: 'https://github.com/lokesh/color-thief',
    use: '拆片分析里的主色提取（改进中位切分）', files: ['electron/lib/shotdetect.cjs'],
    text: `The MIT License (MIT)\n\nCopyright (c) 2015 Lokesh Dhakar\nquantize.js Copyright 2008 Nick Rabinowitz\n\n${MIT_BODY}`,
  },
  {
    name: 'PySceneDetect', license: 'BSD-3-Clause', url: 'https://github.com/Breakthrough/PySceneDetect',
    use: '拆片分析里的镜头切换检测（按其算法用 JavaScript 重写）', files: ['electron/lib/shotdetect.cjs'],
    text: `BSD 3-Clause License\n\nCopyright (C) 2014-2024 Brandon Castellano\n\n${BSD3_BODY}`,
  },
];

// 源码里声明“移植”了第三方代码、但没在 PORTED 里登记的文件（相对 ROOT，用 / 分隔）
export function unregisteredPorts(sources, ported = PORTED) {
  const known = new Set(ported.flatMap((p) => p.files));
  return sources.filter(({ file, code }) => /移植自|部分移植|改编自|改写自|ported from|adapted from/i.test(code) && !known.has(file)).map((s) => s.file);
}

// 读取 package.json 里的许可字段，统一成 SPDX 表达式字符串
export function licenseOf(pkg) {
  if (!pkg) return '';
  if (typeof pkg.license === 'string') return pkg.license.trim();
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type.trim();
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => (typeof l === 'string' ? l : l && l.type)).filter(Boolean).join(' OR ');
  return '';
}

// SPDX 布尔表达式判断：支持括号、优先级 () > AND > OR，严格区分运算符大小写（仅允许大写 AND/OR/WITH），
// 以及 `<license> WITH <exception>` 双白名单核验（主许可须在 ALLOWED、例外须在 ALLOWED_EXCEPTIONS）。
// 解析失败或存在多余符号时按严格原则返回 false。
export function isAllowed(expr) {
  const tokens = String(expr || '').match(/[()]|[^\s()]+/g);
  if (!tokens || !tokens.length) return false;
  let pos = 0;

  const isKeyword = (t) => t === 'AND' || t === 'OR' || t === 'WITH';

  function parseOr() {
    let val = parseAnd();
    while (pos < tokens.length && tokens[pos] === 'OR') {
      pos += 1;
      const rhs = parseAnd();
      val = val || rhs;
    }
    return val;
  }

  function parseAnd() {
    let val = parsePrimary();
    while (pos < tokens.length && tokens[pos] === 'AND') {
      pos += 1;
      const rhs = parsePrimary();
      val = val && rhs;
    }
    return val;
  }

  function parsePrimary() {
    if (pos >= tokens.length) throw new Error('unexpected end');
    const tok = tokens[pos];
    if (tok === '(') {
      pos += 1;
      const val = parseOr();
      if (tokens[pos] !== ')') throw new Error('missing )');
      pos += 1;
      return val;
    }
    if (tok === ')' || isKeyword(tok)) throw new Error(`unexpected token ${tok}`);
    pos += 1;
    // 支持 `<license> WITH <exception>`：主许可与附加例外必须同时命中各自白名单
    if (pos < tokens.length && tokens[pos] === 'WITH') {
      pos += 1;
      const exc = tokens[pos];
      if (!exc || exc === '(' || exc === ')' || isKeyword(exc)) throw new Error('missing exception');
      pos += 1;
      return ALLOWED.has(tok) && ALLOWED_EXCEPTIONS.has(exc);
    }
    return ALLOWED.has(tok);
  }

  try {
    const result = parseOr();
    return pos === tokens.length && result;
  } catch {
    return false;
  }
}

// 从源码中找出裸模块名（import x from 'pkg' / import('pkg') / export ... from 'pkg'）
export function bareSpecifiers(code) {
  // 先剥离 JS 单行与块级注释（同时跳过字符串与模板字面量，避免误伤其中的 // 或 /*）
  const stripped = String(code || '').replace(
    /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
    (m) => (m.startsWith('//') || m.startsWith('/*') ? ' ' : m),
  );
  const out = new Set();
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(stripped))) {
    const spec = m[1];
    if (spec.startsWith('.') || spec.startsWith('/') || /^[a-z]+:/i.test(spec)) continue;
    out.add(spec);
  }
  return out;
}

export function pkgNameOf(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function walk(dir, exts, list = []) {
  if (!fs.existsSync(dir)) return list;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, exts, list);
    else if (exts.test(d.name)) list.push(p);
  }
  return list;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
}

function findLicenseFile(dir) {
  const names = fs.readdirSync(dir).filter((n) => /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i.test(n));
  return names.length ? path.join(dir, names[0]) : null;
}

// 收集要声明的 npm 包：入口名单 + 它们的 dependencies（传递）
export function collectPackages(rootNames, nodeModules) {
  const seen = new Map();
  const queue = [...rootNames];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    const dir = path.join(nodeModules, ...name.split('/'));
    const pj = path.join(dir, 'package.json');
    if (!fs.existsSync(pj)) throw new Error(`找不到依赖 ${name}（${pj}），请先安装依赖`);
    const pkg = readJson(pj);
    const licenseFile = findLicenseFile(dir);
    seen.set(name, {
      name,
      version: pkg.version,
      license: licenseOf(pkg),
      homepage: pkg.homepage || (pkg.repository && (pkg.repository.url || pkg.repository)) || '',
      text: licenseFile ? fs.readFileSync(licenseFile, 'utf8').replace(/^\uFEFF/, '').trim() : '',
    });
    for (const dep of Object.keys(pkg.dependencies || {})) queue.push(dep);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function checkPackages(pkgs) {
  const problems = [];
  for (const p of pkgs) {
    if (!isAllowed(p.license)) problems.push(`${p.name}@${p.version} 的许可「${p.license || '未声明'}」不在允许名单内`);
    else if (!p.text) problems.push(`${p.name}@${p.version} 没有许可文件`);
  }
  return problems;
}

// 把 Markdown 转成适合记事本阅读的纯文本（只处理本项目文档用到的语法）
export function mdToText(md) {
  return String(md)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) return h[1].length <= 2 ? `【${h[2].trim()}】` : `■ ${h[2].trim()}`;
      return line
        .replace(/^\s*[-*]\s+/, (m) => m.replace(/[-*]/, '·'))
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => (t === u ? u : `${t}（${u}）`));
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const RULE = '─'.repeat(60);

export function buildDocument({ app, ffmpeg, electron, pkgs, ported = PORTED, audio, samples }) {
  const L = [];
  const push = (...xs) => L.push(...xs);
  push(`${app.productName}（镜流 Frameflow）${app.version} 第三方软件与素材许可声明`, '');
  push('本软件包含或随附下列第三方软件与素材，它们的版权归各自的作者所有，并按各自的许可提供。');
  push('本文件位于安装目录 resources\\licenses\\THIRD_PARTY_LICENSES.txt。', '');

  push(RULE, '一、FFmpeg（音视频处理）', RULE);
  push(`版本：${ffmpeg.version}`);
  push(`构建：${ffmpeg.file}（${ffmpeg.source}，Windows 64 位 LGPL 共享库构建）`);
  push(`许可：GNU 宽通用公共许可证（${ffmpeg.licenseDetail || 'LGPL v3'}）`);
  push('文件：安装目录 resources\\ffmpeg 下的 ffmpeg.exe、ffprobe.exe 以及 av*.dll、sw*.dll。');
  push('本软件以独立程序的方式调用 FFmpeg，没有修改其源代码。你可以用自己编译的兼容版本替换上述文件。');
  push('许可全文：resources\\licenses\\ffmpeg\\LICENSE.txt（以及随附的 GNU GPL v3 文本 resources\\licenses\\ffmpeg\\COPYING.GPLv3）');
  push('源代码获取方式：resources\\licenses\\ffmpeg\\SOURCE.txt');
  push(`构建来源：${ffmpeg.source}/releases/tag/${ffmpeg.tag}`);
  push(`FFmpeg 源代码：https://github.com/FFmpeg/FFmpeg/tree/${ffmpeg.ffmpegCommit}`);
  push('FFmpeg 是 FFmpeg 项目创始人 Fabrice Bellard 的商标，本软件与 FFmpeg 项目没有隶属关系。', '');

  push(RULE, '二、Electron 与 Chromium（应用运行环境）', RULE);
  push(`Electron ${electron.version}，MIT 许可，版权所有 (c) Electron contributors / GitHub Inc.`);
  push('Electron 许可全文：安装目录 LICENSE.electron.txt');
  push('Chromium 及其组件的许可：安装目录 LICENSES.chromium.html', '');

  push(RULE, '三、打包进程序的开源库', RULE);
  for (const p of pkgs) push(`${p.name} ${p.version} — ${p.license}${p.homepage ? `（${String(p.homepage).replace(/^git\+/, '').replace(/\.git$/, '')}）` : ''}`);
  push('各库的许可全文见本文件末尾的附录。', '');

  push(RULE, '四、移植进本软件的开源代码', RULE);
  if (ported.length) {
    push('本软件的部分源代码改写自下列开源项目，按其许可保留版权声明：');
    for (const p of ported) push(`  · ${p.name} — ${p.license}，${p.url}`, `    用于：${p.use}`);
    push('许可全文见本文件末尾的附录。');
  } else {
    push('（无）');
  }
  push('');

  push(RULE, '五、内置音乐与音效', RULE);
  const music = (audio || []).filter((a) => a.kind === 'music');
  const sfx = (audio || []).filter((a) => a.kind === 'sfx');
  if (music.length) {
    push('内置音乐来自 FreePD.com，该站声明全部音乐按 CC0 1.0 公有领域贡献发布（可免费商用、可修改、无需署名）。');
    push('FreePD.com 已于 2025 年关闭，许可声明与曲目页面的存档：https://web.archive.org/web/2021/https://freepd.com/');
    push('本软件对音乐做了响度统一和格式转换。署名不是必需的，但我们仍列出作者以示感谢：');
    for (const m of music) push(`  · ${m.title} — ${m.author || '佚名'}（${m.mood || ''}）${m.sourceUrl ? ` ${m.sourceUrl}` : ''}`);
    push('');
  }
  if (sfx.length) {
    push(`内置音效（${sfx.length} 个）由镜流 Frameflow 使用 FFmpeg 合成，按 CC0 1.0 提供，可在你的作品中自由使用：`);
    push(`  ${sfx.map((s) => s.title).join('、')}`);
    push('');
  }
  if (!music.length && !sfx.length) push('（本版本未附带内置音乐与音效）', '');

  push(RULE, '六、示例素材', RULE);
  if (samples && samples.length) {
    push('新手引导和示例工程使用的视频片段按各自的许可提供，可在你的作品中使用，但不得单独再分发或转售素材本身：');
    for (const s of samples) {
      push(`  · ${s.file} — ${s.credit || ''} ${s.url || ''}`.trimEnd());
      if (s.license) push(`    许可：${s.license}`);
    }
  } else {
    push('（本版本未附带示例素材）');
  }
  push('');

  push(RULE, '七、按需下载的组件（不随安装包分发）', RULE);
  push('以下组件只有在你主动使用相关功能时才会下载到本机，按各自的许可使用：');
  push('  · yt-dlp — Unlicense（公有领域），https://github.com/yt-dlp/yt-dlp ，用于下载你提供链接的视频。');
  push('  · whisper.cpp — MIT，https://github.com/ggml-org/whisper.cpp ，用于本机语音转文字。');
  push('  · Whisper 语音识别模型 — MIT（OpenAI），从 https://huggingface.co/ggerganov/whisper.cpp 下载。');
  push('从视频网站、素材网站或 AI 服务获得的内容，其权利归原作者或服务条款约定的一方，请在使用前确认授权。', '');

  push(RULE, '附录：开源库与移植代码的许可全文', RULE);
  // 许可正文相同的库合并展示
  const groups = new Map();
  for (const p of pkgs) {
    const key = p.text;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  for (const [text, list] of groups) {
    push('', `■ ${list.map((p) => `${p.name} ${p.version}`).join('、')}`, '', text, '');
  }
  for (const p of ported) push('', `■ ${p.name}（移植代码）`, '', p.text, '');
  return L.join('\n');
}

const withBom = (s) => `\uFEFF${s.replace(/\r?\n/g, '\r\n')}\r\n`;

function main() {
  const pkgJson = readJson(path.join(ROOT, 'package.json'));
  const nodeModules = path.join(ROOT, 'node_modules');

  // 1. npm 包
  const rendererNames = new Set();
  for (const f of walk(path.join(ROOT, 'src'), /\.(m?jsx?|tsx?)$/)) {
    for (const spec of bareSpecifiers(fs.readFileSync(f, 'utf8'))) rendererNames.add(pkgNameOf(spec));
  }
  const roots = [...new Set([...Object.keys(pkgJson.dependencies || {}), ...rendererNames])];
  const pkgs = collectPackages(roots, nodeModules);
  const problems = checkPackages(pkgs);

  // 1b. 移植代码：PORTED 里登记的文件必须还在；源码里新出现的「移植自」要提醒补登记
  for (const p of PORTED) {
    for (const f of p.files) if (!fs.existsSync(path.join(ROOT, f))) console.warn(`提醒：${p.name} 登记的文件 ${f} 已不存在，请核对 PORTED`);
  }
  const sources = [...walk(path.join(ROOT, 'src'), /\.(m?jsx?|tsx?|css)$/), ...walk(path.join(ROOT, 'electron'), /\.(c?js|mjs)$/)]
    .map((f) => ({ file: path.relative(ROOT, f).split(path.sep).join('/'), code: fs.readFileSync(f, 'utf8') }));
  for (const f of unregisteredPorts(sources)) problems.push(`${f} 声明移植了第三方代码，但没有登记到 scripts/gen-licenses.mjs 的 PORTED`);

  // 2. FFmpeg
  const buildInfoPath = path.join(ROOT, 'vendor', 'ffmpeg', 'bin', 'ffmpeg-build.json');
  if (!fs.existsSync(buildInfoPath)) problems.push('缺少 vendor/ffmpeg/bin/ffmpeg-build.json，请先运行 npm run fetch:ffmpeg');
  const ffmpeg = fs.existsSync(buildInfoPath) ? readJson(buildInfoPath) : null;
  if (ffmpeg && ffmpeg.license !== 'LGPL') problems.push(`FFmpeg 不是 LGPL 构建：${ffmpeg.licenseDetail || ffmpeg.license}`);
  for (const f of ['LICENSE.txt', 'COPYING.GPLv3', 'SOURCE.txt']) {
    if (!fs.existsSync(path.join(ROOT, 'vendor', 'ffmpeg', f))) problems.push(`缺少 vendor/ffmpeg/${f}`);
  }

  if (problems.length) {
    console.error('无法生成许可声明：');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  // 3. 其它资料
  const electron = readJson(path.join(nodeModules, 'electron', 'package.json'));
  const audioManifest = path.join(ROOT, 'build', 'builtin-audio', 'manifest.json');
  const audio = fs.existsSync(audioManifest) ? readJson(audioManifest).items || [] : [];
  const sampleManifest = path.join(ROOT, 'build', 'sample-media', 'manifest.json');
  const samples = fs.existsSync(sampleManifest) ? readJson(sampleManifest) : [];

  const doc = buildDocument({ app: { productName: pkgJson.productName || 'Frameflow', version: pkgJson.version }, ffmpeg, electron, pkgs, audio, samples });
  fs.writeFileSync(path.join(ROOT, 'build', 'THIRD_PARTY_LICENSES.txt'), withBom(doc), 'utf8');
  console.log(`已生成 build/THIRD_PARTY_LICENSES.txt（${pkgs.length} 个开源库：${pkgs.map((p) => p.name).join('、')}）`);

  // 4. 隐私说明
  const privacyMd = path.join(ROOT, 'docs', 'PRIVACY.md');
  if (!fs.existsSync(privacyMd)) {
    console.error('缺少 docs/PRIVACY.md');
    process.exit(1);
  }
  fs.writeFileSync(path.join(ROOT, 'build', 'privacy.txt'), withBom(mdToText(fs.readFileSync(privacyMd, 'utf8'))), 'utf8');
  console.log('已生成 build/privacy.txt');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
