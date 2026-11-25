// electron/lib/ff.cjs 单元测试：用 ffmpeg lavfi 生成测试素材，验证 probe / thumb / colorStats / waveform / needsProxy / makeProxy。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ff = require('../electron/lib/ff.cjs');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-test-'));
const paths = {
  ffmpeg: ffmpegPath,
  ffprobe: ffprobePath,
  cache: path.join(root, 'cache'),
  thumbs: path.join(root, 'cache', 'thumbs'),
  waveforms: path.join(root, 'cache', 'waveforms'),
};
const media = path.join(root, 'media');
const files = {
  mp4: path.join(media, '测试 视频.mp4'),
  avi: path.join(media, 'legacy.avi'),
  red: path.join(media, 'red.png'),
  mp3: path.join(media, 'song.mp3'),
  silent: path.join(media, 'silent.mp4'),
};

function ffmpeg(args) {
  const r = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
  if (r.status !== 0) throw new Error('生成测试素材失败：' + String(r.stderr));
}

before(() => {
  fs.mkdirSync(media, { recursive: true });
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', files.mp4]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100:duration=3',
    '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'libmp3lame', '-shortest', files.avi]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:size=64x36', '-frames:v', '1', files.red]);
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100:duration=2', '-i', files.red,
    '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic', '-id3v2_version', '3', files.mp3]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:size=160x90:rate=30:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', files.silent]);
});

after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

test('hashKey：稳定的 16 位十六进制', () => {
  const a = ff.hashKey('a', 1, { x: 2 });
  assert.equal(a, ff.hashKey('a', 1, { x: 2 }));
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, ff.hashKey('a', 2));
});

test('parseRate', () => {
  assert.equal(ff.parseRate('30/1'), 30);
  assert.ok(Math.abs(ff.parseRate('30000/1001') - 29.97) < 0.01);
  assert.equal(ff.parseRate('0/0'), 0);
  assert.equal(ff.parseRate(''), 0);
});

test('probe：H.264 视频', async () => {
  const p = await ff.probe(paths, files.mp4);
  assert.equal(p.kind, 'video');
  assert.equal(p.hasVideo, true);
  assert.equal(p.hasAudio, true);
  assert.equal(p.vcodec, 'h264');
  assert.equal(p.acodec, 'aac');
  assert.equal(p.width, 320);
  assert.equal(p.height, 240);
  assert.equal(p.fps, 30);
  assert.ok(Math.abs(p.duration - 3) < 0.15, `duration=${p.duration}`);
  assert.ok(p.size > 0);
});

test('probe：图片按扩展名判定，duration=5', async () => {
  const p = await ff.probe(paths, files.red);
  assert.equal(p.kind, 'image');
  assert.equal(p.duration, 5);
  assert.equal(p.width, 64);
  assert.equal(p.hasAudio, false);
});

test('probe：带封面的 mp3 判定为音频', async () => {
  const p = await ff.probe(paths, files.mp3);
  assert.equal(p.kind, 'audio');
  assert.equal(p.hasVideo, false);
  assert.equal(p.hasAudio, true);
  assert.equal(p.acodec, 'mp3');
  assert.equal(p.hasCover, true);
  assert.ok(Math.abs(p.duration - 2) < 0.2);
});

test('probe：文件不存在给出中文错误', async () => {
  await assert.rejects(() => ff.probe(paths, path.join(media, 'nope.mp4')), /文件不存在/);
});

test('probe：非媒体文件给出中文错误', async () => {
  const bad = path.join(media, 'bad.mp4');
  fs.writeFileSync(bad, 'this is not a video');
  await assert.rejects(() => ff.probe(paths, bad), /无法识别|没有可用/);
});

test('thumb：生成并缓存', async () => {
  const t1 = await ff.thumb(paths, files.mp4, 1, 160);
  assert.ok(fs.existsSync(t1));
  assert.ok(t1.startsWith(paths.thumbs));
  assert.ok(fs.statSync(t1).size > 500);
  const mtime = fs.statSync(t1).mtimeMs;
  const t2 = await ff.thumb(paths, files.mp4, 1, 160);
  assert.equal(t1, t2);
  assert.equal(fs.statSync(t2).mtimeMs, mtime);
  const [a, b] = await Promise.all([ff.thumb(paths, files.mp4, 2, 120), ff.thumb(paths, files.mp4, 2, 120)]);
  assert.equal(a, b);
});

test('thumb：超出片尾的时间点自动回退', async () => {
  const t = await ff.thumb(paths, files.mp4, 99, 120);
  assert.ok(fs.existsSync(t));
});

test('extractFrame：指定输出路径；图片也可', async () => {
  const out = path.join(root, 'frames', 'f.jpg');
  const r = await ff.extractFrame(paths, files.mp4, 0.5, out, { width: 200 });
  assert.equal(r, out);
  assert.ok(fs.statSync(out).size > 0);
  const out2 = path.join(root, 'frames', 'img.jpg');
  await ff.extractFrame(paths, files.red, 3, out2);
  assert.ok(fs.statSync(out2).size > 0);
});

test('frameAtHeight：定高缓存帧', async () => {
  const p = await ff.frameAtHeight(paths, files.mp4, 1.5, 48);
  assert.ok(fs.existsSync(p));
});

function checkStats(s) {
  for (const k of ['luma', 'contrast', 'saturation']) assert.ok(s[k] >= 0 && s[k] <= 1, `${k}=${s[k]}`);
  for (const k of ['warmth', 'tint']) assert.ok(s[k] >= -1 && s[k] <= 1, `${k}=${s[k]}`);
  assert.equal(s.palette.length, 5);
  for (const h of s.palette) assert.match(h, /^#[0-9a-f]{6}$/);
}

test('colorStats：视频多时间点', async () => {
  const list = await ff.colorStats(paths, files.mp4, [0.5, 1.5, 50]);
  assert.equal(list.length, 3);
  for (const s of list) { assert.ok(s); checkStats(s); }
  // testsrc 彩条：饱和度、对比度明显
  assert.ok(list[0].saturation > 0.3);
  assert.ok(list[0].contrast > 0.1);
  assert.ok(new Set(list[0].palette).size >= 3);
});

test('colorStatsFromImage：纯红图', async () => {
  const s = await ff.colorStatsFromImage(paths, files.red);
  checkStats(s);
  assert.ok(s.warmth > 0.85, `warmth=${s.warmth}`);
  assert.ok(s.saturation > 0.9);
  assert.ok(s.tint < -0.3);
  assert.ok(s.contrast < 0.05);
  assert.ok(Math.abs(s.luma - 0.2126) < 0.06, `luma=${s.luma}`);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(s.palette[0].slice(i, i + 2), 16));
  assert.ok(r > 200 && g < 50 && b < 50, s.palette[0]);
});

test('colorStats：音频文件报错', async () => {
  await assert.rejects(() => ff.colorStats(paths, files.mp3, [0]), /音频/);
});

test('waveform：峰值数量、归一化与缓存', async () => {
  const w = await ff.waveform(paths, files.mp4, 50);
  assert.ok(Math.abs(w.duration - 3) < 0.2, `duration=${w.duration}`);
  assert.ok(Math.abs(w.peaks.length - 150) <= 6, `peaks=${w.peaks.length}`);
  assert.equal(Math.max(...w.peaks), 1);
  assert.ok(w.peaks.every((p) => p >= 0 && p <= 1));
  assert.ok(w.maxPeak > 0 && w.maxPeak <= 1);
  const files0 = fs.readdirSync(paths.waveforms).filter((f) => f.endsWith('.json'));
  assert.equal(files0.length, 1);
  const w2 = await ff.waveform(paths, files.mp4, 50);
  assert.deepEqual(w2.peaks, w.peaks);
  const w10 = await ff.waveform(paths, files.mp4, 10);
  assert.ok(Math.abs(w10.peaks.length - 30) <= 2);
});

test('waveform：无声视频返回空峰值', async () => {
  const w = await ff.waveform(paths, files.silent);
  assert.deepEqual(w.peaks, []);
  assert.ok(w.duration > 0.5);
});

test('needsProxy', async () => {
  assert.equal(ff.needsProxy(await ff.probe(paths, files.mp4), files.mp4), false);
  assert.equal(ff.needsProxy(await ff.probe(paths, files.avi), files.avi), true);
  assert.equal(ff.needsProxy(await ff.probe(paths, files.red), files.red), false);
  assert.equal(ff.needsProxy(await ff.probe(paths, files.mp3), files.mp3), false);
  assert.equal(ff.needsProxy({ kind: 'audio', hasVideo: false, hasAudio: true, acodec: 'wmav2' }, 'x.wma'), true);
  assert.equal(ff.needsProxy({ kind: 'audio', hasVideo: false, hasAudio: true, acodec: 'alac' }, 'x.m4a'), true);
  assert.equal(ff.needsProxy({ kind: 'video', hasVideo: true, vcodec: 'h264', hasAudio: true, acodec: 'aac' }, 'x.mkv'), true);
  assert.equal(ff.needsProxy({ kind: 'video', hasVideo: true, vcodec: 'hevc', hasAudio: false }, 'x.mp4'), true);
  assert.equal(ff.needsProxy({ kind: 'video', hasVideo: true, vcodec: 'vp9', hasAudio: true, acodec: 'opus' }, 'x.webm'), false);
  assert.equal(ff.needsProxy({ kind: 'video', hasVideo: true, vcodec: 'h264', pixFmt: 'yuv420p10le', hasAudio: false }, 'x.mp4'), true);
  assert.equal(ff.needsProxy({ kind: 'video', hasVideo: true, vcodec: 'h264', hasAudio: true, acodec: 'ac3' }, 'x.mov'), true);
});

test('makeProxy：mpeg4/avi → H.264/AAC mp4，并报告进度', async () => {
  const out = path.join(root, 'proxy', 'legacy.proxy.mp4');
  const progress = [];
  const r = await ff.makeProxy(paths, files.avi, out, { onProgress: (p) => progress.push(p) });
  assert.equal(r, out);
  const p = await ff.probe(paths, out);
  assert.equal(p.vcodec, 'h264');
  assert.equal(p.acodec, 'aac');
  assert.equal(p.width, 320);
  assert.equal(p.height, 240);
  assert.ok(Math.abs(p.duration - 3) < 0.2);
  assert.equal(ff.needsProxy(p, out), false);
  assert.equal(progress[0], 0);
  assert.equal(progress[progress.length - 1], 1);
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i] >= progress[i - 1]);
  assert.deepEqual(fs.readdirSync(path.dirname(out)).filter((f) => f.endsWith('.part')), []);
});

test('makeProxy：大画面缩到最长边 1280（竖屏）', async () => {
  const tall = path.join(media, 'tall.avi');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=1080x1920:rate=30:duration=0.5', '-c:v', 'mpeg4', '-q:v', '8', tall]);
  const out = path.join(root, 'proxy', 'tall.mp4');
  await ff.makeProxy(paths, tall, out);
  const p = await ff.probe(paths, out);
  assert.equal(p.height, 1280);
  assert.equal(p.width % 2, 0);
  assert.ok(Math.abs(p.width - 720) <= 2, `width=${p.width}`);
  assert.equal(p.hasAudio, false);
});

test('makeProxy：取消后不留残余文件', async () => {
  const out = path.join(root, 'proxy-cancel', 'c.mp4');
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => ff.makeProxy(paths, files.avi, out, { signal: ac.signal }), (e) => e.code === 'CANCELLED');
  assert.equal(fs.existsSync(out), false);
  const ac2 = new AbortController();
  const pr = ff.makeProxy(paths, files.avi, out, { signal: ac2.signal, onProgress: () => {} });
  setTimeout(() => ac2.abort(), 30);
  await assert.rejects(() => pr, (e) => e.code === 'CANCELLED');
  await new Promise((r) => setTimeout(r, 300));
  const dir = path.dirname(out);
  const left = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  assert.equal(left.filter((f) => f.endsWith('.part')).length, 0, left.join(','));
  assert.equal(fs.existsSync(out), false);
});

test('makeProxy：音频转 AAC', async () => {
  const wma = path.join(media, 'voice.wav');
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=500:duration=1', wma]);
  const out = path.join(root, 'proxy', 'voice.m4a');
  await ff.makeProxy(paths, wma, out);
  const p = await ff.probe(paths, out);
  assert.equal(p.kind, 'audio');
  assert.equal(p.acodec, 'aac');
});

test('v3 parseHwEncoders / hwTestArgs / detectHwEncoders 回退', async () => {
  const text = ' V....D h264_nvenc           NVIDIA NVENC H.264 encoder\n V....D libx264 x\n V....D h264_amf AMD\n';
  assert.deepEqual(ff.parseHwEncoders(text), ['h264_nvenc', 'h264_amf']);
  assert.deepEqual(ff.parseHwEncoders(''), []);
  assert.ok(ff.hwTestArgs('h264_qsv').includes('nv12'));
  const list = await ff.detectHwEncoders(paths, { force: true });
  assert.ok(Array.isArray(list));
  for (const e of list) assert.ok(ff.HW_ENCODERS.includes(e));
  assert.equal(await ff.pickVideoEncoder(paths, 'off'), 'libx264');
  const auto = await ff.pickVideoEncoder(paths, 'auto');
  assert.ok(auto === 'libx264' || ff.HW_ENCODERS.includes(auto));
});
