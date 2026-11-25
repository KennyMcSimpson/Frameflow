// release：构建期脚本里的纯函数（fetch-ffmpeg、fetch-builtin-audio、gen-licenses、make-icon、check-artifacts、after-pack）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseEncoders, parseFilters, licenseFromVersionText, REQUIRED_ENCODERS, REQUIRED_FILTERS, PIN } from '../scripts/fetch-ffmpeg.mjs';
import { base32, parseLoudnorm, parseVolume, sfxGain, sweepCommands, sfxChain, manifestItem, TRACKS, SFX, CC0 } from '../scripts/fetch-builtin-audio.mjs';
import { licenseOf, isAllowed, bareSpecifiers, pkgNameOf, mdToText, checkPackages, buildDocument, PORTED, unregisteredPorts } from '../scripts/gen-licenses.mjs';
import { badAsarEntries, checkAudioManifest, EXPECTED_FUSES } from '../scripts/check-artifacts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { readIco, ico } = require('../scripts/make-icon.cjs');
const { checkResources } = require('../scripts/after-pack.cjs');

// ---------- fetch-ffmpeg ----------
test('fetch-ffmpeg：解析编码器与滤镜列表', () => {
  const enc = parseEncoders([
    'Encoders:',
    ' V..... = Video',
    ' ------',
    ' V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)',
    ' V....D libopenh264          OpenH264 H.264 / AVC / MPEG-4 AVC (codec h264)',
    ' A....D aac                  AAC (Advanced Audio Coding)',
  ].join('\n'));
  assert.deepEqual([...enc], ['h264_nvenc', 'libopenh264', 'aac']);
  const flt = parseFilters([
    'Filters:',
    '  T.. = Timeline support',
    ' TSC scale             V->V       Scale the input video size and/or convert the image format.',
    ' ... amix              N->A       Audio mixing.',
    ' T.C drawtext          V->V       Draw text on top of video frames using libfreetype library.',
  ].join('\n'));
  assert.deepEqual([...flt], ['scale', 'amix', 'drawtext']);
});

test('fetch-ffmpeg：按构建配置判断许可', () => {
  assert.equal(licenseFromVersionText('configuration: --enable-version3 --enable-shared').detail, 'LGPL v3');
  assert.equal(licenseFromVersionText('configuration: --enable-shared').license, 'LGPL');
  assert.equal(licenseFromVersionText('configuration: --enable-gpl --enable-libx264').license, 'GPL');
  assert.equal(licenseFromVersionText('configuration: --enable-nonfree').license, 'unknown');
  assert.equal(licenseFromVersionText('ffmpeg version x').license, 'unknown');
});

test('fetch-ffmpeg：固定版本信息完整，必需能力包含导出与字幕所需项', () => {
  assert.match(PIN.sha256, /^[0-9a-f]{64}$/);
  assert.match(PIN.file, /lgpl-shared/);
  for (const e of ['aac', 'h264_mf', 'h264_nvenc', 'h264_qsv']) assert.ok(REQUIRED_ENCODERS.includes(e), e);
  for (const f of ['drawtext', 'amix']) assert.ok(REQUIRED_FILTERS.includes(f), f);
});

// ---------- fetch-builtin-audio ----------
test('fetch-builtin-audio：base32 与 RFC 4648 一致', () => {
  assert.equal(base32(Buffer.from('')), '');
  assert.equal(base32(Buffer.from('f')), 'MY');
  assert.equal(base32(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.equal(base32(Buffer.alloc(20, 0xff)).length, 32);
});

test('fetch-builtin-audio：解析 loudnorm 与 volumedetect 输出', () => {
  const ln = parseLoudnorm('[Parsed_loudnorm_0 @ 0] \n{\n "input_i" : "-20.10",\n "input_tp" : "-2.00",\n "input_lra" : "6.30",\n "input_thresh" : "-30.40",\n "target_offset" : "0.20"\n}\n');
  assert.equal(ln.input_i, '-20.10');
  assert.equal(parseLoudnorm('{ "input_i" : "-inf", "input_tp": "-inf", "input_lra": "0", "input_thresh": "-70", "target_offset": "0" }'), null);
  assert.equal(parseLoudnorm('no json'), null);
  const vd = '[Parsed_volumedetect_0 @ 0] mean_volume: -24.5 dB\n[Parsed_volumedetect_0 @ 0] max_volume: -6.0 dB\n';
  assert.equal(parseVolume(vd, 'max'), -6);
  assert.equal(parseVolume(vd, 'mean'), -24.5);
  assert.equal(parseVolume('max_volume: -inf dB', 'max'), null);
});

test('fetch-builtin-audio：音效增益同时受峰值和平均电平约束', () => {
  assert.equal(sfxGain(-6, -30), 3);
  assert.equal(sfxGain(-3, -6), -12);
  assert.equal(sfxGain(-9, null), 6);
});

test('fetch-builtin-audio：扫频命令与滤镜链格式', () => {
  const cmd = sweepCommands('bandpass', 0.1, () => 1000, 0.05);
  assert.equal(cmd, "asendcmd=c='0.000 bandpass f 1000;0.050 bandpass f 1000'");
  const mono = sfxChain({ d: 0.5, af: ['lowpass=f=3000'] });
  assert.match(mono, /^afade=t=in:d=0\.002,afade=t=out:st=0\.488:d=0\.012,lowpass=f=3000,pan=stereo\|c0=c0\|c1=c0$/);
  assert.doesNotMatch(sfxChain({ d: 0.5, af: [], stereo: true }), /pan=/);
});

test('fetch-builtin-audio：曲目都固定了哈希，id 唯一，条目符合契约 C16', () => {
  const ids = new Set();
  for (const t of TRACKS) {
    assert.match(t.sha256, /^[0-9a-f]{64}$/, t.id);
    assert.match(t.sha1, /^[A-Z2-7]{32}$/, t.id);
    assert.match(t.ts, /^\d{14}$/, t.id);
    assert.ok(t.author && t.mood && t.page, t.id);
    ids.add(t.id);
  }
  for (const s of SFX) ids.add(s.id);
  assert.equal(ids.size, TRACKS.length + SFX.length, 'id 不能重复');
  const m = manifestItem('music', TRACKS[0], 12.5);
  assert.deepEqual(Object.keys(m).sort(), ['author', 'duration', 'file', 'id', 'kind', 'license', 'mood', 'sourceUrl', 'title'].sort());
  assert.deepEqual(m.license, CC0);
  assert.equal(m.file, `${TRACKS[0].id}.m4a`);
  const s = manifestItem('sfx', SFX[0], 0.9);
  assert.equal(s.kind, 'sfx');
  assert.equal(s.sourceUrl, undefined);
});

test('内置音频清单通过体检规则（有磁盘音频或要求素材时一并验文件存在）', () => {
  const dir = path.join(ROOT, 'build', 'builtin-audio');
  const file = path.join(dir, 'manifest.json');
  assert.ok(fs.existsSync(file), '缺少 build/builtin-audio/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(checkAudioManifest(manifest, () => true), []);
  assert.ok(manifest.items.some((i) => i.kind === 'sfx'));
  const hasAudioFiles = fs.readdirSync(dir).some((f) => /\.m4a$/i.test(f));
  if (hasAudioFiles || process.env.FF_REQUIRE_ASSETS === '1') {
    assert.deepEqual(checkAudioManifest(manifest, (f) => fs.existsSync(path.join(dir, f))), []);
  }
});

// ---------- gen-licenses ----------
test('gen-licenses：许可字段与白名单判断', () => {
  assert.equal(licenseOf({ license: 'MIT' }), 'MIT');
  assert.equal(licenseOf({ license: { type: 'ISC' } }), 'ISC');
  assert.equal(licenseOf({ licenses: [{ type: 'MIT' }, 'Apache-2.0'] }), 'MIT OR Apache-2.0');
  assert.equal(licenseOf({}), '');
  assert.ok(isAllowed('MIT'));
  assert.ok(isAllowed('(MIT OR GPL-3.0)'));
  assert.ok(!isAllowed('MIT AND GPL-3.0'));
  assert.ok(!isAllowed('(MIT OR Apache-2.0) AND GPL-3.0'));
  assert.ok(!isAllowed('GPL-3.0-or-later'));
  assert.ok(!isAllowed(''));
  assert.ok(!isAllowed('MIT WITH NonCommercial-Restriction'));
  assert.ok(!isAllowed('mit or apache-2.0'));
  assert.ok(isAllowed('Apache-2.0 WITH LLVM-exception'));
  assert.deepEqual(checkPackages([{ name: 'a', version: '1', license: 'MIT', text: 'x' }]), []);
  assert.equal(checkPackages([{ name: 'b', version: '1', license: 'GPL-3.0', text: 'x' }]).length, 1);
  assert.equal(checkPackages([{ name: 'c', version: '1', license: 'MIT', text: '' }]).length, 1);
});

test('gen-licenses：从源码找出打包进界面的 npm 包', () => {
  const code = "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport x from './x.js';\nconst m = import('@scope/pkg/sub');\nexport { y } from 'zustand';\nimport 'node:fs';";
  assert.deepEqual([...bareSpecifiers(code)].map(pkgNameOf).sort(), ['@scope/pkg', 'react', 'react-dom', 'zustand']);
});

test('gen-licenses：Markdown 转纯文本', () => {
  const t = mdToText('# 标题\n\n## 小节\n\n- **加粗** 与 `代码`\n- [链接](https://a.b)\n\n\n\n### 三级');
  assert.equal(t, '【标题】\n\n【小节】\n\n· 加粗 与 代码\n· 链接（https://a.b）\n\n■ 三级');
});

test('gen-licenses：声明文件包含 FFmpeg、Electron、开源库全文与内置音频署名', () => {
  const doc = buildDocument({
    app: { productName: 'Frameflow', version: '9.9.9' },
    ffmpeg: { version: 'n8', file: 'f.zip', source: 'https://github.com/BtbN/FFmpeg-Builds', tag: 't', ffmpegCommit: 'abc' },
    electron: { version: '45.0.0' },
    pkgs: [{ name: 'react', version: '1', license: 'MIT', homepage: '', text: 'MIT TEXT' }, { name: 'react-dom', version: '1', license: 'MIT', homepage: '', text: 'MIT TEXT' }],
    audio: [{ kind: 'music', title: 'Song', author: 'Someone', mood: '轻快', sourceUrl: 'https://x' }, { kind: 'sfx', title: '叮' }],
    samples: [{ file: 'a.mp4', credit: 'Mixkit · A', url: 'https://m', license: 'Mixkit Free License' }],
  });
  for (const s of ['LGPL', 'resources\\licenses\\ffmpeg\\SOURCE.txt', 'Electron 45.0.0', 'LICENSES.chromium.html', 'Song — Someone', 'CC0 1.0', 'a.mp4', 'yt-dlp', '9.9.9']) {
    assert.ok(doc.includes(s), `缺少：${s}`);
  }
  assert.equal(doc.split('MIT TEXT').length - 1, 1, '相同的许可全文只出现一次');
  for (const p of PORTED) {
    assert.ok(doc.includes(`${p.name} — ${p.license}`), `移植代码 ${p.name} 没有列出`);
    assert.ok(doc.includes(p.text), `移植代码 ${p.name} 的许可全文缺失`);
  }
});

test('gen-licenses：移植代码登记表完整，未登记的移植会被发现', () => {
  for (const p of PORTED) {
    assert.ok(isAllowed(p.license), p.name);
    assert.match(p.text, /Copyright/, p.name);
    for (const f of p.files) assert.ok(fs.existsSync(path.join(ROOT, f)), `${p.name} 登记的文件 ${f} 不存在`);
  }
  const sources = [
    { file: 'src/ui/components/ui.jsx', code: '// 部分移植自 Lucide' },
    { file: 'src/new.js', code: '// 移植自 某某库（MIT）' },
    { file: 'src/plain.js', code: '// 自写' },
  ];
  assert.deepEqual(unregisteredPorts(sources), ['src/new.js']);
});

// ---------- make-icon ----------
test('make-icon：ICO 读写往返一致', () => {
  const png = (n) => Buffer.from([0x89, 0x50, 0x4e, 0x47, n]);
  const buf = ico([{ size: 16, buf: png(1) }, { size: 256, buf: png(2) }]);
  const back = readIco(buf);
  assert.deepEqual(back.map((e) => e.size), [16, 256]);
  assert.deepEqual([...back[1].buf], [...png(2)]);
});

test('build/icon.ico 含 Windows 常用的全部尺寸', () => {
  const sizes = readIco(fs.readFileSync(path.join(ROOT, 'build', 'icon.ico'))).map((e) => e.size);
  for (const s of [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]) assert.ok(sizes.includes(s), `缺少 ${s}px`);
});

// ---------- check-artifacts / after-pack ----------
test('check-artifacts：asar 违规条目与音频清单校验', () => {
  assert.deepEqual(badAsarEntries(['\\dist-renderer\\a.js', '\\dist-renderer\\a.js.map', '\\node_modules\\ffmpeg-static\\index.js', '\\node_modules\\ffmpeg-static-x\\a']), ['\\dist-renderer\\a.js.map', '\\node_modules\\ffmpeg-static\\index.js']);
  const ok = { version: 1, items: [{ id: 'a', kind: 'sfx', title: 'A', file: 'a.m4a', duration: 1, license: { id: 'cc0' } }] };
  assert.deepEqual(checkAudioManifest(ok, () => true), []);
  assert.equal(checkAudioManifest({ version: 2, items: [] }, () => true).length, 1);
  const bad = { version: 1, items: [ok.items[0], { ...ok.items[0], kind: 'x', license: null }, { id: 'b', title: 'B', file: 'b.m4a', duration: 0 }] };
  const problems = checkAudioManifest(bad, (f) => f !== 'b.m4a');
  assert.ok(problems.some((p) => p.includes('id 重复')));
  assert.ok(problems.some((p) => p.includes('kind 非法')));
  assert.ok(problems.some((p) => p.includes('缺少许可')));
  assert.ok(problems.some((p) => p.includes('字段不全')));
});

test('check-artifacts：期望的 fuse 名称都存在于 @electron/fuses', () => {
  const { FuseV1Options } = require('@electron/fuses');
  for (const name of Object.keys(EXPECTED_FUSES)) assert.equal(typeof FuseV1Options[name], 'number', name);
});

test('after-pack：资源齐全才放行，GPL 构建与缺许可文件会失败', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-afterpack-'));
  try {
    const res = path.join(base, 'resources');
    const put = (rel, data = 'x') => { fs.mkdirSync(path.dirname(path.join(res, rel)), { recursive: true }); fs.writeFileSync(path.join(res, rel), data); };
    put('ffmpeg/ffmpeg.exe');
    put('ffmpeg/ffprobe.exe');
    put('ffmpeg/ffmpeg-build.json', JSON.stringify({ license: 'LGPL' }));
    put('licenses/ffmpeg/LICENSE.txt');
    put('licenses/ffmpeg/COPYING.GPLv3');
    put('licenses/ffmpeg/SOURCE.txt');
    put('licenses/privacy.txt');
    assert.throws(() => checkResources(res), /THIRD_PARTY_LICENSES/);
    put('licenses/THIRD_PARTY_LICENSES.txt');
    fs.unlinkSync(path.join(res, 'licenses', 'ffmpeg', 'COPYING.GPLv3'));
    assert.throws(() => checkResources(res), /COPYING\.GPLv3/);
    put('licenses/ffmpeg/COPYING.GPLv3');
    const warn = console.warn;
    console.warn = () => {};
    try { assert.doesNotThrow(() => checkResources(res)); } finally { console.warn = warn; }
    put('ffmpeg/ffmpeg-build.json', JSON.stringify({ license: 'GPL', licenseDetail: 'GPL v3' }));
    assert.throws(() => checkResources(res), /不是 LGPL/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
