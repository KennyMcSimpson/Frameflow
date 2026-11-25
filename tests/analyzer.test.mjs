// 拆片流水线 + VTT 解析 + 搜索映射 单元测试。运行：node --test tests/analyzer.test.mjs
// 需要 node_modules 里的 ffmpeg-static / ffprobe-static；真实网络测试需设置 FF_NET_TEST=1。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const analyzer = require('../electron/lib/analyzer.cjs');
const ytdlp = require('../electron/lib/ytdlp.cjs');
const { buildShotBounds, findPeaks, statsFromRgb, mergeColorProfile, computeRhythm, computeCurves, shotMotion } = analyzer._internals;

function binPaths() {
  let ffmpeg = null;
  let ffprobe = null;
  try { ffmpeg = require('ffmpeg-static'); } catch {}
  try { ffprobe = require('ffprobe-static').path; } catch {}
  return { ffmpeg: ffmpeg && fs.existsSync(ffmpeg) ? ffmpeg : null, ffprobe: ffprobe && fs.existsSync(ffprobe) ? ffprobe : null };
}
const BIN = binPaths();
const ffExists = fs.existsSync(path.join(path.dirname(require.resolve('../electron/lib/analyzer.cjs')), 'ff.cjs'));

function makeTestVideo(dir) {
  const out = path.join(dir, 'three_scenes.mp4');
  const args = [
    '-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=3',
    '-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=25:duration=3',
    '-f', 'lavfi', '-i', 'color=c=0xC03020:size=640x360:rate=25:duration=3',
    '-f', 'lavfi', '-i', "sine=frequency=440:sample_rate=44100:duration=9,volume='if(lt(mod(t\\,3)\\,0.4)\\,1\\,0.05)':eval=frame",
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]',
    '-map', '[v]', '-map', '3:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac', '-shortest', out,
  ];
  const r = spawnSync(BIN.ffmpeg, args, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error('生成测试视频失败：' + r.stderr);
  return out;
}

// ───────────── 纯函数 ─────────────

test('buildShotBounds：合并过短镜头、尾部并入、无切点整段/等分', () => {
  const b = buildShotBounds([3, 3.2, 6, 8.9], 9);
  assert.deepEqual(b.map((s) => [s.start, s.end]), [[0, 3], [3, 6], [6, 9]]);
  assert.deepEqual(buildShotBounds([], 8), [{ start: 0, end: 8 }]);
  const eq = buildShotBounds([], 30);
  assert.equal(eq.length, 5);
  assert.ok(eq.every((s) => Math.abs(s.end - s.start - 6) < 1e-6));
  assert.deepEqual(buildShotBounds([NaN, -1, 100], 5), [{ start: 0, end: 5 }]);
  assert.deepEqual(buildShotBounds([1], 0), []);
});

test('buildShotBounds：超过上限时合并最短镜头', () => {
  const cuts = Array.from({ length: 999 }, (_, i) => i + 1);
  const b = buildShotBounds(cuts, 1000, { maxShots: 300 });
  assert.equal(b.length, 300);
  assert.equal(b[0].start, 0);
  assert.equal(b[b.length - 1].end, 1000);
  for (let i = 1; i < b.length; i++) assert.equal(b[i].start, b[i - 1].end);
});

test('computeCurves / shotMotion：静止为 0，变化有运动', () => {
  const fs2 = 4;
  const buf = Buffer.alloc(fs2 * 4);
  buf.fill(100, 0, 8);   // 帧 0、1 相同
  buf.fill(200, 8, 16);  // 帧 2、3 相同
  const { luma, diff } = computeCurves(buf, fs2);
  assert.equal(luma.length, 4);
  assert.ok(Math.abs(luma[0] - 100 / 255) < 1e-9);
  assert.equal(diff[1], 0);
  assert.ok(diff[2] > 0.3);
  assert.equal(shotMotion([0, 0, 0, 0], 0, 2), 0);
  assert.ok(shotMotion([0, 0.1, 0.1, 0.1], 0, 2) > 0.8);
});

test('联系表格子：横屏 4×3、竖屏 6×2、方形 4×3', () => {
  const { sheetLayout } = analyzer._internals;
  assert.deepEqual(sheetLayout(1920, 1080), { cw: 320, ch: 180, cols: 4, rows: 3 });
  assert.deepEqual(sheetLayout(1080, 1920), { cw: 180, ch: 320, cols: 6, rows: 2 });
  assert.deepEqual(sheetLayout(1080, 1080), { cw: 240, ch: 240, cols: 4, rows: 3 });
  assert.deepEqual(sheetLayout(0, 0), { cw: 320, ch: 180, cols: 4, rows: 3 });
});

test('findPeaks / computeRhythm / mergeColorProfile', () => {
  const curve = [0.1, 0.1, 0.9, 0.2, 0.1, 0.1, 0.1, 0.95, 0.3, 0.1];
  const peaks = findPeaks(curve, 0.5);
  assert.deepEqual(peaks, [1.25, 3.75]);
  const rh = computeRhythm([{ start: 0, end: 2 }, { start: 2, end: 6 }, { start: 6, end: 12 }], 12);
  assert.equal(rh.avgShot, 4);
  assert.equal(rh.medianShot, 4);
  assert.equal(rh.cutsPerMinute, 10);
  assert.deepEqual(rh.durations, [2, 4, 6]);
  const cp = mergeColorProfile([
    { weight: 1, stats: { luma: 0.2, contrast: 0.2, saturation: 0.1, warmth: 0, tint: 0, palette: ['#000000', '#111111', '#222222', '#333333', '#444444'] } },
    { weight: 3, stats: { luma: 0.6, contrast: 0.4, saturation: 0.5, warmth: 0.2, tint: 0, palette: ['#ff0000', '#ee1111', '#00ff00', '#0000ff', '#ffffff'] } },
  ]);
  assert.equal(cp.luma, 0.5);
  assert.equal(cp.palette.length, 5);
  assert.ok(cp.palette.every((h) => /^#[0-9a-f]{6}$/.test(h)));
});

test('statsFromRgb：纯红', () => {
  const buf = Buffer.alloc(32 * 18 * 3);
  for (let i = 0; i < 32 * 18; i++) { buf[i * 3] = 255; buf[i * 3 + 1] = 0; buf[i * 3 + 2] = 0; }
  const s = statsFromRgb(buf);
  assert.equal(s.saturation, 1);
  assert.equal(s.warmth, 1);
  assert.equal(s.contrast, 0);
  assert.equal(s.palette[0], '#ff0000');
});

// ───────────── VTT ─────────────

test('parseVtt：基础解析、去标签、实体', () => {
  const vtt = `WEBVTT
Kind: captions
Language: zh-Hans

NOTE 这是注释

1
00:00:01.000 --> 00:00:03.500 align:start position:0%
<c.colorE5E5E5>你好</c>，<b>世界</b> &amp; 朋友

00:00:04.000 --> 00:00:05.000
第二句
`;
  const cues = ytdlp.parseVtt(vtt);
  assert.deepEqual(cues, [
    { start: 1, end: 3.5, text: '你好，世界 & 朋友' },
    { start: 4, end: 5, text: '第二句' },
  ]);
});

test('parseVtt：YouTube 自动字幕滚动去重', () => {
  const vtt = `WEBVTT

00:00:00.000 --> 00:00:02.000
hello<00:00:00.500><c> everyone</c>

00:00:02.000 --> 00:00:02.010
hello everyone

00:00:02.010 --> 00:00:04.000
hello everyone
welcome<00:00:02.500><c> to</c><00:00:03.000><c> the show</c>

00:00:04.000 --> 00:00:04.010
welcome to the show

00:00:04.010 --> 00:00:06.000
welcome to the show
today we cook
`;
  const cues = ytdlp.parseVtt(vtt);
  assert.deepEqual(cues.map((c) => c.text), ['hello everyone', 'welcome to the show', 'today we cook']);
  assert.equal(cues[0].start, 0);
  assert.ok(cues[0].end >= 2);
  assert.equal(cues[1].start, 2.01);
  assert.equal(cues[2].end, 6);
});

test('parseVtt：SRT 逗号毫秒、空输入', () => {
  assert.deepEqual(ytdlp.parseVtt(''), []);
  assert.deepEqual(ytdlp.parseVtt(null), []);
  const srt = '1\r\n00:00:01,200 --> 00:00:02,000\r\n字幕一\r\n\r\n2\r\n00:01:02,5 --> 00:01:03,000\r\n字幕二\r\n';
  assert.deepEqual(ytdlp.parseVtt(srt), [{ start: 1.2, end: 2, text: '字幕一' }, { start: 62.5, end: 63, text: '字幕二' }]);
});

test('ytdlp 映射：搜索条目 → WebResult', () => {
  const { mapEntry } = ytdlp._internals;
  const yt = mapEntry('youtube', { id: 'abc123', title: 'Coffee <b>cinematic</b>', duration: 61.5, channel: 'Cafe', thumbnails: [{ url: 'https://i.ytimg.com/a.jpg' }, { url: 'https://i.ytimg.com/b.jpg' }] });
  assert.equal(yt.url, 'https://www.youtube.com/watch?v=abc123');
  assert.equal(yt.thumb, 'https://i.ytimg.com/b.jpg');
  assert.equal(yt.title, 'Coffee cinematic');
  assert.equal(yt.license, '版权归原作者，仅供学习参考');
  const bili = mapEntry('bilibili', { id: 'BV1xx411c7mD', url: 'http://www.bilibili.com/video/BV1xx411c7mD', thumbnail: '//i0.hdslb.com/x.jpg', duration: '3:20' });
  assert.equal(bili.url, 'https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(bili.thumb, 'https://i0.hdslb.com/x.jpg');
  assert.equal(bili.duration, 200);
  assert.equal(bili.id, 'bilibili_BV1xx411c7mD');
});

test('explainYtdlpError：中文原因', () => {
  assert.match(ytdlp.explainYtdlpError('ERROR: [BiliBili] xx: HTTP Error 412: Precondition Failed'), /412/);
  assert.match(ytdlp.explainYtdlpError('ERROR: Unsupported URL: https://a.b'), /不支持/);
  assert.match(ytdlp.explainYtdlpError('ERROR: something odd happened'), /something odd/);
});

test('ytdlpStatus：未安装时不抛错', async () => {
  const st = await ytdlp.ytdlpStatus({ ytdlp: path.join(os.tmpdir(), 'nope', 'yt-dlp.exe') });
  assert.equal(st.installed, false);
  assert.equal(await ytdlp.ytdlpStatus(null).then((s) => s.installed), false);
});

// ───────────── 端到端：真实 ffmpeg ─────────────

test('analyzeVideo：三场景 9 秒视频', { skip: !BIN.ffmpeg && '缺少 ffmpeg-static', timeout: 180000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-analyzer-'));
  try {
    const video = makeTestVideo(dir);
    const vtt = path.join(dir, 'subs.vtt');
    fs.writeFileSync(vtt, 'WEBVTT\n\n00:00:00.500 --> 00:00:02.000\n第一幕\n\n00:00:03.500 --> 00:00:05.000\n第二幕\n\n00:00:20.000 --> 00:00:21.000\n超出范围\n');
    const outDir = path.join(dir, 'out');
    const stages = [];
    // 核心算法不依赖 ff.cjs：强制使用私有实现测一次
    analyzer._internals.setFf(null);
    const res = await analyzer.analyzeVideo({
      paths: BIN, file: video, outDir, maxSeconds: 600, subtitlesFile: vtt,
      onProgress: (stage, p) => stages.push([stage, p]),
    });
    analyzer._internals.setFf(undefined);
    assert.ok(res.shots.length >= 3, `镜头数 ${res.shots.length}`);
    assert.ok(Math.abs(res.duration - 9) < 0.3, `时长 ${res.duration}`);
    assert.equal(res.width, 640);
    assert.equal(res.height, 360);
    assert.ok(res.fps > 24 && res.fps < 26);
    // 切点应在 3 秒和 6 秒附近
    const starts = res.shots.map((s) => s.start);
    assert.ok(starts.some((t) => Math.abs(t - 3) < 0.25), '缺少 3 秒切点：' + starts);
    assert.ok(starts.some((t) => Math.abs(t - 6) < 0.25), '缺少 6 秒切点：' + starts);
    for (const s of res.shots) {
      assert.ok(s.thumb && fs.existsSync(s.thumb), '缺少关键帧');
      assert.equal(s.keyframes[0], s.thumb);
      assert.ok(s.stats && s.stats.palette.length === 5);
      assert.ok(s.motion >= 0 && s.motion <= 1);
      assert.ok(s.loudness >= 0 && s.loudness <= 1);
      assert.equal(s.ai, null);
    }
    // 红色镜头应偏暖、饱和
    const last = res.shots[res.shots.length - 1];
    assert.ok(last.stats.warmth > 0.3, '红色镜头 warmth=' + last.stats.warmth);
    assert.ok(last.stats.saturation > 0.5);
    // 节奏
    assert.equal(res.rhythm.durations.length, res.shots.length);
    assert.ok(res.rhythm.avgShot > 1 && res.rhythm.avgShot <= 3.1);
    assert.ok(res.rhythm.cutsPerMinute >= 12);
    // 音频：每 0.5 秒一个点，有峰值
    assert.ok(Math.abs(res.audio.curve.length - 18) <= 1, '曲线长度 ' + res.audio.curve.length);
    assert.ok(res.audio.curve.every((v) => v >= 0 && v <= 1));
    assert.ok(res.audio.peaks.length >= 2, '峰值 ' + res.audio.peaks);
    assert.ok(Math.max(...res.audio.curve) > 0.6);
    // 字幕
    assert.deepEqual(res.transcript.map((c) => c.text), ['第一幕', '第二幕']);
    // 联系表
    assert.ok(res.contactSheets.length >= 1);
    assert.ok(res.contactSheets.every((p) => fs.existsSync(p) && fs.statSync(p).size > 1000));
    assert.deepEqual(res.contactSheetShots[0], res.shots.map((s) => s.index).slice(0, 12));
    assert.ok(!fs.existsSync(path.join(outDir, '_sheet_tmp')));
    // 色彩档案、状态
    assert.equal(res.colorProfile.palette.length, 5);
    assert.ok(['done', 'partial'].includes(res.status));
    assert.deepEqual(res.errors, []);
    assert.equal(res.curves.luma.length, 18);
    // 切入方式：第一镜没有切入，后面是硬切；关键帧有得分；联系表编号标记是布尔值
    assert.equal(res.shots[0].cutIn, null);
    assert.ok(res.shots.slice(1).every((s) => s.cutIn && s.cutIn.kind === 'hard'), JSON.stringify(res.shots.map((s) => s.cutIn)));
    assert.ok(res.shots.every((s) => typeof s.keyframeScore === 'number'));
    assert.equal(typeof res.contactSheetsNumbered, 'boolean');
    // 3 秒一次的提示音不是音乐节拍 → 无明显节拍，不算卡点
    assert.ok(res.audio.tempo && res.audio.tempo.bpm === null, JSON.stringify(res.audio.tempo));
    assert.equal(res.rhythm.beatSync, null);
    // 进度单调、以 1 结束
    for (let i = 1; i < stages.length; i++) assert.ok(stages[i][1] >= stages[i - 1][1]);
    assert.equal(stages[stages.length - 1][1], 1);

    // maxSeconds：只分析前 4 秒（同时走「按帧号再解码一遍」导出关键帧）
    const part = await analyzer.analyzeVideo({ paths: BIN, file: video, outDir: path.join(dir, 'out2'), maxSeconds: 4, keyframeMode: 'batch' });
    assert.ok(Math.abs(part.duration - 4) < 0.2, '部分时长 ' + part.duration);
    assert.ok(part.shots.length >= 2 && part.shots.length <= 3);
    assert.equal(part.status, 'partial'); // 记录了「只分析了前 4 秒」
    assert.match(part.errors[0], /只分析了前 4 秒/);
    assert.equal(part.errors.length, 1, part.errors.join('；'));
    assert.ok(part.shots.every((s) => s.thumb && fs.statSync(s.thumb).size > 500 && s.keyframes[0] === s.thumb));
    assert.ok(!fs.existsSync(path.join(dir, 'out2', '_kf_tmp')));

    // 与 A 组 ff.cjs 集成（存在时）
    if (ffExists) {
      const viaFf = await analyzer.analyzeVideo({ paths: BIN, file: video, outDir: path.join(dir, 'out3') });
      assert.ok(viaFf.shots.length >= 3);
      assert.ok(viaFf.shots.every((s) => s.thumb && s.stats && s.stats.palette.length >= 1));
    }
  } finally {
    analyzer._internals.setFf(undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('analyzeVideo：取消与错误输入', { skip: !BIN.ffmpeg && '缺少 ffmpeg-static', timeout: 60000 }, async () => {
  await assert.rejects(analyzer.analyzeVideo({ paths: BIN, file: path.join(os.tmpdir(), 'nope.mp4'), outDir: os.tmpdir() }), /找不到要分析的视频文件/);
  await assert.rejects(analyzer.analyzeVideo({ paths: {}, file: 'x', outDir: 'y' }), /ffmpeg/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-analyzer-c-'));
  try {
    const video = makeTestVideo(dir);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(analyzer.analyzeVideo({ paths: BIN, file: video, outDir: path.join(dir, 'o'), signal: ac.signal }), (e) => e.code === 'CANCELLED');
    // 纯音频文件 → 无画面
    const audioOnly = path.join(dir, 'a.m4a');
    spawnSync(BIN.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=duration=1', '-c:a', 'aac', audioOnly], { windowsHide: true });
    await assert.rejects(analyzer.analyzeVideo({ paths: BIN, file: audioOnly, outDir: path.join(dir, 'o2') }), /没有视频画面/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────── 真实网络（可选） ─────────────

test('Wikimedia Commons 搜索（真实网络）', { skip: process.env.FF_NET_TEST !== '1' && '设置 FF_NET_TEST=1 才运行', timeout: 60000 }, async () => {
  const web = require('../electron/ipc/web.cjs');
  const res = await web._internals.searchCommons('coffee', 'video', 5, {});
  assert.ok(res.length > 0, '没有结果');
  for (const r of res) {
    assert.equal(r.source, 'commons');
    assert.ok(/^https:\/\/upload\.wikimedia\.org\//.test(r.downloadUrl));
    assert.ok(r.license);
  }
});

// ───── 节拍检测（W12） ─────
function clickTrack(bpm, seconds, rate = 11025) {
  const n = Math.floor(seconds * rate);
  const s = new Int16Array(n);
  const period = (60 / bpm) * rate;
  for (let b = 0; b * period < n; b++) {
    const start = Math.round(b * period);
    for (let k = 0; k < 400 && start + k < n; k++) s[start + k] = Math.round(20000 * Math.exp(-k / 80) * Math.sin(k * 0.6));
  }
  return s;
}

test('beatsFromPcm：120BPM 点击音轨估计正确（误差 < 1 BPM）', () => {
  const { bpm, beats, confidence } = analyzer.beatsFromPcm(clickTrack(120, 12));
  assert.ok(Math.abs(bpm - 120) < 1, `bpm=${bpm}`);
  assert.ok(confidence >= 0.1, `confidence=${confidence}`);
  assert.ok(beats.length >= 20 && beats.length <= 26, `beats=${beats.length}`);
  const gaps = beats.slice(1).map((t, i) => t - beats[i]);
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  assert.ok(Math.abs(avg - 0.5) < 0.03, `avg gap=${avg}`);
  // 节拍落在点击上（±40ms）
  assert.ok(beats.every((t) => Math.abs(t - Math.round(t / 0.5) * 0.5) < 0.04), beats.join(','));
});

test('beatsFromPcm：其它速度与带噪声的节拍', () => {
  for (const target of [90, 128, 150]) {
    const { bpm } = analyzer.beatsFromPcm(clickTrack(target, 15));
    assert.ok(Math.abs(bpm - target) < 1, `目标 ${target}，得到 ${bpm}`);
  }
  const noisy = clickTrack(100, 15);
  const rnd = mulberry(7);
  for (let i = 0; i < noisy.length; i++) noisy[i] = Math.max(-32768, Math.min(32767, noisy[i] + Math.round((rnd() - 0.5) * 6000)));
  const r = analyzer.beatsFromPcm(noisy);
  assert.ok(r.bpm && Math.abs(r.bpm - 100) < 1.5, `带噪声 bpm=${r.bpm} conf=${r.confidence}`);
});

test('beatsFromPcm：静音、白噪声、随机敲击 → 无明显节拍', () => {
  const silent = analyzer.beatsFromPcm(new Int16Array(11025 * 5));
  assert.deepEqual(silent.beats, []);
  assert.equal(silent.bpm, null);
  const rnd = mulberry(3);
  const noise = new Int16Array(11025 * 12);
  for (let i = 0; i < noise.length; i++) noise[i] = Math.round((rnd() - 0.5) * 20000);
  const rn = analyzer.beatsFromPcm(noise);
  assert.equal(rn.bpm, null, `白噪声 bpm=${rn.bpm} conf=${rn.confidence}`);
  assert.deepEqual(rn.beats, []);
  // 随机间隔的敲击（像说话或环境声）
  const n = 11025 * 15;
  const irregular = new Int16Array(n);
  for (let t = 0.2; t < 15; t += 0.15 + rnd() * 0.9) {
    const start = Math.round(t * 11025);
    for (let k = 0; k < 400 && start + k < n; k++) irregular[start + k] = Math.round(20000 * Math.exp(-k / 80) * Math.sin(k * 0.6));
  }
  const ri = analyzer.beatsFromPcm(irregular);
  assert.equal(ri.bpm, null, `随机敲击 bpm=${ri.bpm} conf=${ri.confidence}`);
  // 像说话一样的音节（随机长短、随机音高）
  for (const seed of [4, 5]) {
    const rs = analyzer.beatsFromPcm(speechLike(seed, 20));
    assert.equal(rs.bpm, null, `说话声 ${seed} bpm=${rs.bpm} conf=${rs.confidence}`);
  }
  // 持续和弦（两音拍频）+ 缓慢起伏，没有起音
  const pad = new Int16Array(11025 * 20);
  for (let i = 0; i < pad.length; i++) pad[i] = Math.round(5600 * (Math.sin(2 * Math.PI * 220 * i / 11025) + Math.sin(2 * Math.PI * 277 * i / 11025)) * (1 + 0.3 * Math.sin(2 * Math.PI * 0.2 * i / 11025)));
  assert.equal(analyzer.beatsFromPcm(pad).bpm, null);
});

test('beatsFromPcm：鼓点配乐（底鼓/军鼓/踩镲 + 和弦铺底）', () => {
  for (const target of [72, 95, 140]) {
    const r = analyzer.beatsFromPcm(drumLoop(target, 20));
    assert.ok(r.bpm && Math.abs(r.bpm - target) < 1, `目标 ${target}，得到 ${r.bpm}（conf=${r.confidence}）`);
  }
});

function speechLike(seed, seconds, rate = 11025) {
  const rnd = mulberry(seed);
  const n = seconds * rate;
  const p = new Int16Array(n);
  let t = 0.1;
  while (t < seconds) {
    const d = 0.08 + rnd() * 0.2; const f = 120 + rnd() * 100; const st = Math.round(t * rate);
    for (let i = 0; i < d * rate && st + i < n; i++) p[st + i] = Math.round(8400 * Math.sin(2 * Math.PI * f * i / rate) * Math.sin(Math.PI * i / (d * rate)));
    t += d + 0.03 + rnd() * 0.25;
    if (rnd() < 0.1) t += 0.4;
  }
  return p;
}

function drumLoop(bpm, seconds, rate = 11025) {
  const rnd = mulberry(5);
  const n = seconds * rate;
  const s = new Float64Array(n);
  const beat = 60 / bpm;
  for (let k = 0; k * beat / 2 < seconds; k++) {
    const t0 = Math.round(k * beat / 2 * rate);
    const bi = k >> 1;
    for (let i = 0; i < 300 && t0 + i < n; i++) s[t0 + i] += (rnd() - 0.5) * 0.25 * Math.exp(-i / 40);
    if (k % 2 === 0 && bi % 2 === 0) for (let i = 0; i < 2500 && t0 + i < n; i++) s[t0 + i] += 0.8 * Math.sin(2 * Math.PI * (60 + 60 * Math.exp(-i / 300)) * i / rate) * Math.exp(-i / 900);
    if (k % 2 === 0 && bi % 2 === 1) for (let i = 0; i < 1800 && t0 + i < n; i++) s[t0 + i] += (rnd() - 0.5) * 0.9 * Math.exp(-i / 500);
  }
  for (let i = 0; i < n; i++) s[i] += 0.15 * (Math.sin(2 * Math.PI * 220 * i / rate) + Math.sin(2 * Math.PI * 277 * i / rate) + Math.sin(2 * Math.PI * 330 * i / rate));
  return Int16Array.from(s, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 14000))));
}

test('computeBeatSync：踩点剪辑显著度 > 2，随机剪辑 ≈ 1，数据不足返回 null', () => {
  const beats = Array.from({ length: 120 }, (_, i) => r3(0.25 + i * 0.5)); // 120 BPM，60 秒
  const onBeat = [2.25, 4.25, 6.75, 9.25, 12.25, 15.75, 18.25, 22.25, 25.75, 30.25];
  const s1 = analyzer.computeBeatSync(onBeat, beats, 120, 25);
  assert.equal(s1.hitRate, 1);
  assert.ok(s1.significance > 2, JSON.stringify(s1));
  assert.equal(s1.onBeatCuts.length, onBeat.length);
  // 随机剪辑：大量随机切点，命中率接近随机基线
  const rnd = mulberry(11);
  const randomCuts = Array.from({ length: 400 }, () => r3(0.5 + rnd() * 59));
  const s2 = analyzer.computeBeatSync(randomCuts, beats, 120, 25);
  assert.ok(s2.significance > 0.7 && s2.significance < 1.35, JSON.stringify({ ...s2, beats: undefined, onBeatCuts: undefined }));
  assert.equal(analyzer.computeBeatSync(onBeat, beats, null, 25), null);
  assert.equal(analyzer.computeBeatSync([1, 2], beats, 120, 25), null);
  assert.equal(analyzer.computeBeatSync(onBeat, [1, 2], 120, 25), null);
});

function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function r3(v) { return Math.round(v * 1000) / 1000; }

test('detectBeats：ffmpeg 解码真实 wav', async () => {
  let ffmpeg; try { ffmpeg = require('ffmpeg-static'); } catch { return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-beats-'));
  const pcm = clickTrack(100, 10);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length * 2, 4); header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(11025, 24);
  header.writeUInt32LE(22050, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length * 2, 40);
  const file = path.join(dir, 'click.wav');
  fs.writeFileSync(file, Buffer.concat([header, Buffer.from(pcm.buffer)]));
  const beats = await analyzer.detectBeats(file, { ffmpeg });
  assert.ok(beats.length >= 14 && beats.length <= 19, `beats=${beats.length}`);
  const tempo = await analyzer.detectTempo(file, { ffmpeg });
  assert.ok(Math.abs(tempo.bpm - 100) < 1, `bpm=${tempo.bpm}`);
  await assert.rejects(analyzer.detectBeats(file, {}), /找不到 ffmpeg/);
  fs.rmSync(dir, { recursive: true, force: true });
});
