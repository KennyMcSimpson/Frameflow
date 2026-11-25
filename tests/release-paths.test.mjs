// release：二进制定位（契约 C8）与打包配置的约束。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { locateBinary } = require('../electron/lib/paths.cjs');
const EXE = process.platform === 'win32' ? '.exe' : '';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ff-release-'));
}
function bins(dir, names = ['ffmpeg', 'ffprobe'], license) {
  fs.mkdirSync(dir, { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(dir, `${n}${EXE}`), 'x');
  if (license) fs.writeFileSync(path.join(dir, 'ffmpeg-build.json'), JSON.stringify({ license }));
  return dir;
}
const noStatic = () => null;

test('打包版只用 resources/ffmpeg，并读取构建许可', () => {
  const base = tmp();
  try {
    bins(path.join(base, 'res', 'ffmpeg'), undefined, 'LGPL');
    const hit = locateBinary('ffmpeg', { isPackaged: true, resourcesPath: path.join(base, 'res'), projectRoot: base, env: {}, staticBin: noStatic });
    assert.equal(hit.source, 'bundled');
    assert.equal(hit.license, 'LGPL');
    assert.equal(hit.path, path.join(base, 'res', 'ffmpeg', `ffmpeg${EXE}`));
    const probe = locateBinary('ffprobe', { isPackaged: true, resourcesPath: path.join(base, 'res'), projectRoot: base, env: {}, staticBin: noStatic });
    assert.equal(probe.path, path.join(base, 'res', 'ffmpeg', `ffprobe${EXE}`));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('打包版忽略环境变量、vendor 和 ffmpeg-static，缺失时返回 null', () => {
  const base = tmp();
  try {
    const envBin = path.join(bins(path.join(base, 'env')), `ffmpeg${EXE}`);
    bins(path.join(base, 'vendor', 'ffmpeg', 'bin'), undefined, 'LGPL');
    const staticHit = path.join(bins(path.join(base, 'static')), `ffmpeg${EXE}`);
    const hit = locateBinary('ffmpeg', {
      isPackaged: true, resourcesPath: path.join(base, 'res'), projectRoot: base,
      env: { FF_FFMPEG: envBin }, staticBin: () => staticHit,
    });
    assert.equal(hit, null);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('目录里 ffmpeg 与 ffprobe 必须成对出现', () => {
  const base = tmp();
  try {
    bins(path.join(base, 'res', 'ffmpeg'), ['ffmpeg'], 'LGPL');
    const hit = locateBinary('ffmpeg', { isPackaged: true, resourcesPath: path.join(base, 'res'), projectRoot: base, env: {}, staticBin: noStatic });
    assert.equal(hit, null);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('开发模式顺序：环境变量 → resources → vendor → ffmpeg-static', () => {
  const base = tmp();
  try {
    const ctx = { isPackaged: false, resourcesPath: path.join(base, 'res'), projectRoot: base, env: {}, staticBin: noStatic };
    const staticHit = path.join(bins(path.join(base, 'static')), `ffmpeg${EXE}`);
    ctx.staticBin = () => staticHit;
    let hit = locateBinary('ffmpeg', ctx);
    assert.deepEqual([hit.source, hit.license], ['static', 'GPL']);

    bins(path.join(base, 'vendor', 'ffmpeg', 'bin'), undefined, 'LGPL');
    hit = locateBinary('ffmpeg', ctx);
    assert.deepEqual([hit.source, hit.license], ['vendor', 'LGPL']);

    bins(path.join(base, 'res', 'ffmpeg'));
    hit = locateBinary('ffmpeg', ctx);
    assert.deepEqual([hit.source, hit.license], ['bundled', 'unknown'], '没有 ffmpeg-build.json 时许可记为 unknown');

    const envBin = path.join(bins(path.join(base, 'env')), `ffmpeg${EXE}`);
    hit = locateBinary('ffmpeg', { ...ctx, env: { FF_FFMPEG: envBin } });
    assert.equal(hit.source, 'env');
    assert.equal(hit.path, envBin);

    hit = locateBinary('ffmpeg', { ...ctx, env: { FF_FFMPEG: path.join(base, 'nope.exe') } });
    assert.equal(hit.source, 'bundled', '环境变量指向不存在的文件时继续往下找');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('ffmpeg-build.json 损坏或许可不认识时记为 unknown', () => {
  const base = tmp();
  try {
    const dir = bins(path.join(base, 'res', 'ffmpeg'));
    fs.writeFileSync(path.join(dir, 'ffmpeg-build.json'), '{坏的');
    const ctx = { isPackaged: true, resourcesPath: path.join(base, 'res'), projectRoot: base, env: {}, staticBin: noStatic };
    assert.equal(locateBinary('ffmpeg', ctx).license, 'unknown');
    fs.writeFileSync(path.join(dir, 'ffmpeg-build.json'), JSON.stringify({ license: 'nonfree' }));
    assert.equal(locateBinary('ffmpeg', ctx).license, 'unknown');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('package.json 打包配置：身份、加固、精简与随包资源', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const b = pkg.build;
  assert.equal(b.appId, 'com.frameflow.desktop', 'appId 冻结为旧版一致的值，保证覆盖安装');
  assert.equal(b.productName, 'Frameflow');
  assert.deepEqual(b.electronLanguages, ['zh-CN', 'en-US']);
  assert.deepEqual(b.electronFuses, {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
  });
  assert.equal(b.afterPack, 'scripts/after-pack.cjs');
  for (const ex of ['!**/*.map', '!**/node_modules/ffmpeg-static/**', '!**/node_modules/ffprobe-static/**']) assert.ok(b.files.includes(ex), `files 缺少 ${ex}`);
  const deps = Object.keys(pkg.dependencies || {});
  assert.ok(!deps.includes('ffmpeg-static') && !deps.includes('ffprobe-static'), 'ffmpeg-static / ffprobe-static 只能是开发依赖');
  const to = (b.extraResources || []).map((r) => r.to);
  for (const t of ['ffmpeg', 'licenses/ffmpeg', 'licenses/THIRD_PARTY_LICENSES.txt', 'licenses/privacy.txt', 'builtin-audio', 'sample-media']) {
    assert.ok(to.includes(t), `extraResources 缺少 ${t}`);
  }
  assert.ok(!b.asarUnpack, '不再需要 asarUnpack（ffmpeg 改为 extraResources）');
});
