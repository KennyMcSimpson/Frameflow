// electron/lib/encoders.cjs 单元测试：列表解析、排序、选型、失败降级、命令行参数与像素格式。
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const encoders = require('../electron/lib/encoders.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-encoders-test-'));
const cacheFile = path.join(tmpDir, 'encoders.json');
const fakeFfmpeg = path.join(tmpDir, 'ffmpeg-fake.exe');
fs.writeFileSync(fakeFfmpeg, 'fake-binary');

beforeEach(() => {
  encoders._reset();
  encoders.setCacheFile(cacheFile);
  try { fs.unlinkSync(cacheFile); } catch {}
});

after(() => {
  encoders._reset();
  encoders.setCacheFile(null);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('parseEncoderList：仅提取视频编码器，忽略音频/字幕与表头', () => {
  const sample = [
    'Encoders:',
    ' ------',
    ' V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)',
    ' VFS..D h264_qsv             H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (Intel Quick Sync Video)',
    ' V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10',
    ' A....D aac                  AAC (Advanced Audio Coding)',
    ' S..... srt                  SubRip subtitle',
  ].join('\n');
  const set = encoders.parseEncoderList(sample);
  assert.deepEqual([...set].sort(), ['h264_nvenc', 'h264_qsv', 'libx264']);
  assert.equal(encoders.parseEncoderList('').size, 0);
  assert.equal(encoders.parseEncoderList(null).size, 0);
});

test('rankH264：显卡优先、CPU 优先、h264_mf 软硬区分与 exclude 排除', () => {
  const all = ['libopenh264', 'h264_mf', 'libx264', 'h264_amf', 'h264_qsv', 'h264_nvenc'];
  // mfHw=true：h264_mf 归入显卡序列，在 libx264 之前
  assert.deepEqual(
    encoders.rankH264(all, { preferHw: true, mfHw: true }),
    ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'libx264', 'libopenh264'],
  );
  // mfHw=false：软件 MF 排到 CPU 编码器之后兜底
  assert.deepEqual(
    encoders.rankH264(all, { preferHw: true, mfHw: false }),
    ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264', 'libopenh264', 'h264_mf'],
  );
  // preferHw=false：CPU 编码器优先，硬件编码器留作末尾兜底
  assert.deepEqual(
    encoders.rankH264(['h264_nvenc', 'libx264', 'libopenh264'], { preferHw: false }),
    ['libx264', 'libopenh264', 'h264_nvenc'],
  );
  // 排除指定编码器
  assert.deepEqual(
    encoders.rankH264(['h264_nvenc', 'h264_qsv', 'libx264'], { preferHw: true, exclude: ['h264_nvenc'] }),
    ['h264_qsv', 'libx264'],
  );
  // 非法输入安全返回空数组
  assert.deepEqual(encoders.rankH264(null), []);
});

test('h264Args 与 pixFmtOf：覆盖各编码器质量/码率模式、GOP 与像素格式', () => {
  const nv = encoders.h264Args('h264_nvenc', { quality: 'high', purpose: 'export' });
  assert.equal(nv[0], '-c:v');
  assert.equal(nv[1], 'h264_nvenc');
  assert.ok(nv.includes('-cq') && nv.includes('p5'));
  assert.equal(encoders.pixFmtOf(nv), 'yuv420p');

  const nvProxy = encoders.h264Args('h264_nvenc', { purpose: 'proxy', bitrateKbps: 6000 });
  assert.ok(nvProxy.includes('p2') && nvProxy.includes('6000k') && !nvProxy.includes('-cq'));

  const qsv = encoders.h264Args('h264_qsv', { quality: 'standard' });
  assert.ok(qsv.includes('-global_quality'));
  assert.equal(encoders.pixFmtOf(qsv), 'nv12');

  const amf = encoders.h264Args('h264_amf', { quality: 'small' });
  assert.ok(amf.includes('cqp') && amf.includes('-qp_i'));
  assert.equal(encoders.pixFmtOf(amf), 'yuv420p');

  const mfHw = encoders.h264Args('h264_mf', { mfHw: true, quality: 'high' });
  assert.ok(mfHw.includes('-hw_encoding') && mfHw.includes('1'));
  assert.equal(encoders.pixFmtOf(mfHw), 'nv12');

  const mfSw = encoders.h264Args('h264_mf', { mfHw: false, bitrateKbps: 5000 });
  assert.ok(!mfSw.includes('-hw_encoding') && mfSw.includes('5000k'));

  const openh264 = encoders.h264Args('libopenh264', { width: 1280, height: 720, fps: 30, quality: 'high' });
  assert.ok(openh264.includes('-b:v') && openh264.includes('-maxrate'));
  assert.equal(encoders.pixFmtOf(openh264), 'yuv420p');

  const x264 = encoders.h264Args('libx264', { quality: 'standard', purpose: 'proxy', gop: 15 });
  assert.ok(x264.includes('ultrafast') && x264.includes('fastdecode') && x264.includes('-crf') && x264.includes('21'));
  assert.ok(x264.includes('-g') && x264.includes('15') && x264.includes('-bf') && x264.includes('-sc_threshold'));

  // 未知编码器安全回退 libx264；pixFmtOf 缺参数时回退默认值
  assert.equal(encoders.h264Args('unknown_enc')[1], 'libx264');
  assert.equal(encoders.pixFmtOf(['-c:v', 'libx264']), 'yuv420p');
  assert.equal(encoders.pixFmtOf(null, 'nv12'), 'nv12');
});

test('probeEncoders + pickH264 + markFailed：试编码过滤、失败两次停用', async () => {
  const runner = async (_bin, args) => {
    if (args.includes('-encoders')) {
      return {
        code: 0,
        stdout: [
          ' V....D h264_nvenc  NVIDIA',
          ' V....D h264_amf    AMD',
          ' V....D libx264     x264',
        ].join('\n'),
      };
    }
    const idx = args.indexOf('-c:v');
    const enc = idx >= 0 ? args[idx + 1] : '';
    // 模拟 AMF 列出但试编码失败
    return { code: enc === 'h264_amf' ? 1 : 0, stdout: '', stderr: '' };
  };

  const probed = await encoders.probeEncoders(fakeFfmpeg, { force: true, runner });
  assert.deepEqual(probed.h264, ['h264_nvenc', 'libx264']);

  // 默认选显卡编码器
  const pickedHw = await encoders.pickH264({ ffmpegPath: fakeFfmpeg, preferHw: true });
  assert.equal(pickedHw.encoder, 'h264_nvenc');
  assert.equal(pickedHw.hw, true);
  assert.ok(!pickedHw.degraded);

  // preferHw=false 选 libx264
  const pickedCpu = await encoders.pickH264({ ffmpegPath: fakeFfmpeg, preferHw: false });
  assert.equal(pickedCpu.encoder, 'libx264');
  assert.equal(pickedCpu.hw, false);

  // 失败 1 次尚不停用（防止偶发路数占用误判）
  encoders.markFailed(fakeFfmpeg, 'h264_nvenc');
  assert.equal((await encoders.pickH264({ ffmpegPath: fakeFfmpeg, preferHw: true })).encoder, 'h264_nvenc');

  // 失败第 2 次后停用 h264_nvenc，自动切到 libx264
  encoders.markFailed(fakeFfmpeg, 'h264_nvenc');
  const afterTwoFails = await encoders.pickH264({ ffmpegPath: fakeFfmpeg, preferHw: true });
  assert.equal(afterTwoFails.encoder, 'libx264');
  assert.equal(afterTwoFails.hw, false);

  // 未提供 ffmpegPath 时降级兜底 libx264
  const fallback = await encoders.pickH264({});
  assert.equal(fallback.encoder, 'libx264');
  assert.equal(fallback.degraded, true);
});

test('withH264：编码器失败自动换下一个，取消或 noRetry 不重试', async () => {
  const runner = async (_bin, args) => {
    if (args.includes('-encoders')) return { code: 0, stdout: ' V....D h264_nvenc x\n V....D libx264 x\n' };
    return { code: 0, stdout: '', stderr: '' };
  };
  await encoders.probeEncoders(fakeFfmpeg, { force: true, runner });

  const tried = [];
  const res = await encoders.withH264({ ffmpegPath: fakeFfmpeg }, async (enc) => {
    tried.push(enc.encoder);
    if (enc.encoder === 'h264_nvenc') throw new Error('nvenc busy');
    return `ok:${enc.encoder}`;
  });
  assert.deepEqual(tried, ['h264_nvenc', 'libx264']);
  assert.equal(res, 'ok:libx264');

  // CANCELLED 不重试
  const cancelTried = [];
  await assert.rejects(
    encoders.withH264({ ffmpegPath: fakeFfmpeg }, async (enc) => {
      cancelTried.push(enc.encoder);
      const err = new Error('已取消');
      err.code = 'CANCELLED';
      throw err;
    }),
    (e) => e.code === 'CANCELLED',
  );
  assert.equal(cancelTried.length, 1);
});
