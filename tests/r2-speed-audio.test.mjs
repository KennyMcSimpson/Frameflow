// R2 清单11：曲线变速音频分段（speedSegments）与 ffmpeg 导出时长一致性
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createProject, createAsset, createClip } from '../src/engine/model.js';
import { clipDuration, sourceTimeAt } from '../src/engine/timeline.js';
import { speedSegments, buildAudioPlan } from '../src/export/audioPlan.js';

const require = createRequire(import.meta.url);
const { buildExportArgs } = require('../electron/ipc/export.cjs')._internals;
const FRAME = 1 / 30;
const CURVE = [{ t: 0, v: 0.5 }, { t: 0.4, v: 3 }, { t: 0.7, v: 0.3 }, { t: 1, v: 1.5 }];

function curvedProject(file, extra = {}) {
  const p = createProject({ name: '曲线变速' });
  const v = createAsset({ id: 'v1', kind: 'video', path: file, duration: 12, hasAudio: true });
  p.assets = { v1: v };
  p.tracks.video = [createClip(v, { id: 'c1', in: 1, out: 9, speedCurve: CURVE, ...extra })];
  return p;
}

test('speedSegments: 段长≥0.25s，总时长 / 源映射与画面一致（误差<1帧）', () => {
  const clip = createClip(createAsset({ id: 'v', kind: 'video', path: 'x', duration: 12 }), { in: 1, out: 9, speedCurve: CURVE });
  const dur = clipDuration(clip);
  const parts = speedSegments(clip);
  assert.ok(parts.length > 4);
  let audioDur = 0;
  for (const p of parts) {
    assert.ok(p.t1 - p.t0 >= 0.25 - 1e-9, '每段≥0.25s');
    assert.ok(p.speed > 0);
    audioDur += (p.srcOut - p.srcIn) / p.speed;
    // 段起点源时刻与画面映射一致
    assert.ok(Math.abs(p.srcIn - sourceTimeAt(clip, p.t0)) < FRAME, `t=${p.t0}`);
  }
  assert.ok(Math.abs(audioDur - dur) < FRAME, `音频 ${audioDur} vs 画面 ${dur}`);
  assert.ok(Math.abs(parts.at(-1).srcOut - 9) < 1e-6);
  // 段中点：常速线性插值与曲线映射差 < 1 帧
  for (const p of parts) {
    const m = (p.t0 + p.t1) / 2;
    assert.ok(Math.abs(p.srcIn + (m - p.t0) * p.speed - sourceTimeAt(clip, m)) < FRAME * 2);
  }
  // 倒放：源区间覆盖完整且时长不变
  const rev = speedSegments({ ...clip, reverse: true });
  assert.ok(Math.abs(rev[0].srcOut - 9) < 1e-6);
  assert.ok(Math.abs(rev.reduce((a, p) => a + (p.srcOut - p.srcIn) / p.speed, 0) - dur) < FRAME);
  // 非曲线 / 定格 / 过短
  assert.deepEqual(speedSegments({ in: 0, out: 4, speed: 2 }), []);
  assert.deepEqual(speedSegments({ ...clip, still: true }), []);
  assert.equal(speedSegments({ in: 0, out: 0.1, speedCurve: CURVE }).length, 1);
});

test('buildAudioPlan: 曲线片段带 speedParts，裁剪后仍一致；常速片段不带', () => {
  const p = curvedProject('C:/m/a.mp4');
  const dur = clipDuration(p.tracks.video[0]);
  const seg = buildAudioPlan(p, { duration: 60 }).segments[0];
  assert.ok(seg.speedParts.length > 4);
  assert.ok(Math.abs(seg.speedParts.reduce((a, q) => a + q.dur, 0) - dur) < FRAME);
  const cut = buildAudioPlan(p, { duration: dur / 2 }).segments[0];
  assert.ok(Math.abs(cut.speedParts.reduce((a, q) => a + q.dur, 0) - dur / 2) < FRAME);
  assert.ok(Math.abs(cut.srcOut - sourceTimeAt(p.tracks.video[0], dur / 2)) < FRAME);
  const plain = curvedProject('C:/m/a.mp4', { speedCurve: null, speed: 2 });
  assert.equal(buildAudioPlan(plain, { duration: 60 }).segments[0].speedParts, undefined);
  const args = buildExportArgs({ output: 'o.wav', format: 'wav', duration: 20, audioPlan: buildAudioPlan(p, { duration: 20 }) });
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.match(fc, /asplit=\d+/);
  assert.match(fc, /concat=n=\d+:v=0:a=1/);
  assert.match(fc, /atempo=2,atempo=[\d.]+.*atempo=0\.5,atempo=/, '超出 0.5–2 的倍速串联');
});

function ffBins() {
  let ffmpeg = null; let ffprobe = null;
  try { ffmpeg = require('ffmpeg-static'); } catch {}
  try { ffprobe = require('ffprobe-static').path; } catch {}
  return { ffmpeg: ffmpeg && fs.existsSync(ffmpeg) ? ffmpeg : null, ffprobe: ffprobe && fs.existsSync(ffprobe) ? ffprobe : null };
}

test('ffmpeg 实导：曲线变速片段音频时长与画面差<0.1s', (t) => {
  const { ffmpeg, ffprobe } = ffBins();
  if (!ffmpeg) { t.skip('无 ffmpeg'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffspd-'));
  const src = path.join(dir, 'src.mp4');
  let r = spawnSync(ffmpeg, ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=30:duration=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', src]);
  assert.equal(r.status, 0, String(r.stderr));
  for (const reverse of [false, true]) {
    const p = curvedProject(src, { reverse });
    const vDur = clipDuration(p.tracks.video[0]);
    const D = vDur + 2;
    const out = path.join(dir, `o${reverse ? 'r' : ''}.wav`);
    const args = buildExportArgs({ output: out, format: 'wav', duration: D, audioPlan: buildAudioPlan(p, { duration: D }) });
    r = spawnSync(ffmpeg, args);
    assert.equal(r.status, 0, String(r.stderr));
    if (ffprobe) {
      const pr = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]);
      assert.ok(Math.abs(Number(String(pr.stdout).trim()) - D) < 0.1, `ffprobe ${pr.stdout} ${pr.stderr} vs ${D}`);
    }
    // 有声部分的结束点 = 曲线片段音频时长
    r = spawnSync(ffmpeg, ['-hide_banner', '-i', out, '-af', 'silencedetect=n=-50dB:d=0.3', '-f', 'null', '-']);
    const m = /silence_start: ([\d.]+)/.exec(String(r.stderr));
    assert.ok(m, '未检测到尾部静音');
    assert.ok(Math.abs(Number(m[1]) - vDur) < 0.1, `音频 ${m[1]} vs 画面 ${vDur}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('常速倒放导出：滤镜含 areverse+asetpts，且按段长截齐', () => {
  const p = curvedProject('C:/m/a.mp4', { speedCurve: null, reverse: true, speed: 1 });
  const args = buildExportArgs({ output: 'o.wav', format: 'wav', duration: 10, audioPlan: buildAudioPlan(p, { duration: 10 }) });
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.match(fc, /asetpts=PTS-STARTPTS,areverse,asetpts=N\/SR\/TB/);
  assert.match(fc, /apad,atrim=end=8(\.0+)?,asetpts=N\/SR\/TB/);
});

test('ffmpeg 实导：常速倒放（1×/2×）时长正确、内容确实倒序', (t) => {
  const { ffmpeg, ffprobe } = ffBins();
  if (!ffmpeg) { t.skip('无 ffmpeg'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffrev-'));
  const src = path.join(dir, 'src.mp4');
  // 源：0–6s 静音，6–12s 正弦。片段 in=1,out=9 倒放后：前 3s(源 9→6) 有声，后 5s 静音
  let r = spawnSync(ffmpeg, ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=30:duration=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12', '-af', 'volume=enable=lt(t\\,6):volume=0',
    '-shortest', '-c:v', 'libx264', '-c:a', 'aac', src]);
  assert.equal(r.status, 0, String(r.stderr));
  for (const speed of [1, 2]) {
    const p = curvedProject(src, { speedCurve: null, reverse: true, speed });
    const vDur = clipDuration(p.tracks.video[0]);
    assert.ok(Math.abs(vDur - 8 / speed) < 1e-6);
    const D = vDur + 2;
    const out = path.join(dir, `rev${speed}.wav`);
    const args = buildExportArgs({ output: out, format: 'wav', duration: D, audioPlan: buildAudioPlan(p, { duration: D }) });
    r = spawnSync(ffmpeg, args);
    assert.equal(r.status, 0, String(r.stderr));
    if (ffprobe) {
      const pr = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]);
      assert.ok(Math.abs(Number(String(pr.stdout).trim()) - D) < 0.05, `ffprobe ${pr.stdout} vs ${D}`);
    }
    r = spawnSync(ffmpeg, ['-hide_banner', '-i', out, '-af', 'silencedetect=n=-50dB:d=0.3', '-f', 'null', '-']);
    const starts = [...String(r.stderr).matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
    assert.ok(starts.length, '未检测到静音');
    // 倒序：有声段在前，静音从 3/speed 秒开始
    assert.ok(Math.abs(starts[0] - 3 / speed) < 0.1, `speed=${speed} 静音起点 ${starts[0]} 期望 ${3 / speed}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
