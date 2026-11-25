// 拆片：规则法镜头检测（shotdetect.cjs）单元测试。运行：node --test tests/library-shotdetect.test.mjs
// 合成帧覆盖：硬切、闪光不切、黑场淡入淡出、叠化、平移不误报、关键帧避开黑/糊帧、MMCQ 主色、分块喂数据一致；
// 有 ffmpeg-static 时再用真实视频测一遍（worker 与主线程两条路径结果一致、按帧号批量导出关键帧）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const sd = require('../electron/lib/shotdetect.cjs');

const W = sd.SCAN_W; const H = sd.SCAN_H; const FB = W * H * 3;

function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
function texture(seed, w = W, h = H) {
  const rnd = rng(seed);
  const img = new Uint8Array(w * h * 3);
  const bg = [rnd() * 255, rnd() * 255, rnd() * 255];
  for (let p = 0; p < w * h; p++) { img[p * 3] = bg[0]; img[p * 3 + 1] = bg[1]; img[p * 3 + 2] = bg[2]; }
  for (let k = 0; k < 18; k++) {
    const rw = 6 + Math.floor(rnd() * w / 3); const rh = 4 + Math.floor(rnd() * h / 3);
    const x0 = Math.floor(rnd() * (w - rw)); const y0 = Math.floor(rnd() * (h - rh));
    const c = [rnd() * 255, rnd() * 255, rnd() * 255];
    for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) { const p = (y * w + x) * 3; img[p] = c[0]; img[p + 1] = c[1]; img[p + 2] = c[2]; }
  }
  return img;
}
function solid(r, g, b) { const f = new Uint8Array(FB); for (let p = 0; p < W * H; p++) { f[p * 3] = r; f[p * 3 + 1] = g; f[p * 3 + 2] = b; } return f; }
function jitter(img, seed, amp = 3) { const rnd = rng(seed); const o = new Uint8Array(img.length); for (let i = 0; i < img.length; i++) o[i] = Math.max(0, Math.min(255, img[i] + Math.round((rnd() - 0.5) * 2 * amp))); return o; }
function mix(a, b, al) { const o = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) o[i] = Math.round(a[i] * (1 - al) + b[i] * al); return o; }
function scale(a, k) { const o = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) o[i] = Math.max(0, Math.min(255, Math.round(a[i] * k))); return o; }
function crop(big, bw, x0) { const o = new Uint8Array(FB); for (let y = 0; y < H; y++) o.set(big.subarray((y * bw + x0) * 3, (y * bw + x0 + W) * 3), y * W * 3); return o; }

function collect(frames, rate = 25) {
  const c = sd.createCollector({ rate });
  for (const f of frames) c.feed(f);
  return c.st;
}
function shotOf(img, n, seed) { return Array.from({ length: n }, (_, i) => jitter(img, seed * 1000 + i)); }

test('硬切：三个镜头切在第 30、60 帧', () => {
  const frames = [...shotOf(texture(1), 30, 1), ...shotOf(texture(2), 30, 2), ...shotOf(texture(3), 30, 3)];
  const f = collect(frames);
  const { cuts } = sd.detectCuts(f);
  assert.deepEqual(cuts.map((c) => c.frame), [30, 60]);
  assert.ok(cuts.every((c) => c.kind === 'hard' && c.transition === 'cut'));
  assert.deepEqual(cuts.map((c) => c.t), [1.2, 2.4]);
});

test('闪光：白闪 2 帧、亮度猛增 2 帧都不产生切点', () => {
  const A = texture(4);
  const white = [...shotOf(A, 40, 4), solid(255, 255, 255), solid(250, 250, 250), ...shotOf(A, 40, 5)];
  assert.deepEqual(sd.detectCuts(collect(white)).cuts, []);
  const bright = [...shotOf(A, 40, 6), scale(A, 1.9), scale(A, 1.6), ...shotOf(A, 40, 7)];
  assert.deepEqual(sd.detectCuts(collect(bright)).cuts, []);
  // 闪光期间换了画面 → 仍然是切点
  const B = texture(5);
  const flashCut = [...shotOf(A, 40, 8), solid(255, 255, 255), solid(255, 255, 255), ...shotOf(B, 40, 9)];
  assert.equal(sd.detectCuts(collect(flashCut)).cuts.length, 1);
});

test('淡入淡出：渐黑 → 黑场 → 渐亮，标为 fade / 黑场过渡', () => {
  const A = texture(6); const B = texture(7);
  const frames = [...shotOf(A, 40, 10)];
  for (let i = 1; i <= 10; i++) frames.push(scale(A, 1 - i / 10));
  for (let i = 0; i < 4; i++) frames.push(solid(0, 0, 0));
  for (let i = 1; i <= 10; i++) frames.push(scale(B, i / 10));
  frames.push(...shotOf(B, 40, 11));
  const { cuts, spans } = sd.detectCuts(collect(frames));
  assert.equal(cuts.length, 1, JSON.stringify(cuts));
  assert.equal(cuts[0].kind, 'fade');
  assert.equal(cuts[0].transition, 'dip-black');
  assert.ok(cuts[0].frame >= 49 && cuts[0].frame <= 55, '切点 ' + cuts[0].frame);
  assert.ok(cuts[0].duration >= 0.6, '时长 ' + cuts[0].duration);
  assert.ok(spans.some(([a, b]) => a <= 45 && b >= 58));
});

test('片头黑场淡入：不算切点，第一个镜头标为淡入', () => {
  const A = texture(8);
  const frames = [solid(0, 0, 0), solid(0, 0, 0), solid(2, 2, 2)];
  for (let i = 1; i <= 8; i++) frames.push(scale(A, i / 8));
  frames.push(...shotOf(A, 50, 12));
  const r = sd.finishScan(collect(frames));
  assert.equal(r.cuts.length, 0);
  assert.equal(r.shots.length, 1);
  assert.equal(r.shots[0].cutIn && r.shots[0].cutIn.kind, 'fade');
});

test('叠化：15 帧线性混合标为 dissolve，切点在混合中段', () => {
  const A = texture(9); const B = texture(10);
  const frames = [...shotOf(A, 40, 13)];
  for (let i = 1; i <= 15; i++) frames.push(jitter(mix(A, B, i / 16), 500 + i));
  frames.push(...shotOf(B, 40, 14));
  const { cuts } = sd.detectCuts(collect(frames));
  assert.equal(cuts.length, 1, JSON.stringify(cuts));
  assert.equal(cuts[0].kind, 'dissolve');
  assert.equal(cuts[0].transition, 'crossfade');
  assert.ok(cuts[0].frame >= 44 && cuts[0].frame <= 51, '切点 ' + cuts[0].frame);
  assert.ok(cuts[0].duration >= 0.3 && cuts[0].duration <= 0.8, '时长 ' + cuts[0].duration);
});

test('平移镜头：不误报切点', () => {
  const bw = 512;
  const big = texture(11, bw, H);
  const frames = [];
  for (let i = 0; i < 120; i++) frames.push(crop(big, bw, i * 3));
  const { cuts } = sd.detectCuts(collect(frames));
  assert.deepEqual(cuts, []);
});

test('关键帧：避开黑场与模糊帧；纯色镜头也有一张；长镜头最多 3 张且第一张得分最高', () => {
  const A = texture(12);
  const frames = [...shotOf(A, 15, 15)];
  for (let i = 0; i < 21; i++) frames.push(solid(0, 0, 0));
  for (let i = 0; i < 14; i++) frames.push(solid(128, 128, 128));
  const f = collect(frames);
  const [k] = sd.pickKeyframes(f, [{ start: 0, end: 2 }]);
  assert.equal(k.frames.length, 1);
  assert.ok(k.frames[0] >= 8 && k.frames[0] <= 14, '选中了第 ' + k.frames[0] + ' 帧');
  const flat = collect(Array.from({ length: 30 }, () => solid(192, 48, 32)));
  const [kf] = sd.pickKeyframes(flat, [{ start: 0, end: 1.2 }]);
  assert.equal(kf.frames.length, 1);
  // 6 秒镜头，内容逐段变化
  const long = [];
  for (let s = 0; s < 3; s++) long.push(...shotOf(texture(20 + s), 50, 30 + s));
  const lf = collect(long);
  const [kl] = sd.pickKeyframes(lf, [{ start: 0, end: 6 }]);
  assert.ok(kl.frames.length >= 2 && kl.frames.length <= 3, '张数 ' + kl.frames.length);
  assert.equal(new Set(kl.frames).size, kl.frames.length);
});

test('MMCQ：按像素数排序、代表色精确', () => {
  const px = [];
  for (let i = 0; i < 50; i++) px.push(255, 0, 0);
  for (let i = 0; i < 30; i++) px.push(0, 200, 0);
  for (let i = 0; i < 20; i++) px.push(20, 40, 230);
  const q = sd.quantize(Uint8Array.from(px), 8);
  assert.deepEqual(q.slice(0, 3).map((c) => [c.rgb.map(Math.round), c.count]), [[[255, 0, 0], 50], [[0, 200, 0], 30], [[20, 40, 230], 20]]);
  const s = sd.statsFromRgb(Uint8Array.from(px));
  assert.deepEqual(s.palette.slice(0, 3), ['#ff0000', '#00c800', '#1428e6']);
  assert.equal(s.palette.length, 5);
  assert.equal(s.paletteEx[0].ratio, 0.5);
  const red = sd.statsFromRgb(solid(255, 0, 0));
  assert.equal(red.palette[0], '#ff0000');
  assert.equal(red.saturation, 1);
  assert.deepEqual(sd.quantize(new Uint8Array(0)), []);
});

test('分块喂数据：任意切块结果一致；2fps 曲线长度正确', () => {
  const frames = [...shotOf(texture(13), 26, 16), ...shotOf(texture(14), 24, 17)];
  const whole = collect(frames);
  const c = sd.createCollector({ rate: 25 });
  const all = new Uint8Array(frames.length * FB);
  frames.forEach((f, i) => all.set(f, i * FB));
  for (let off = 0; off < all.length;) { const len = 1000 + (off % 7919); c.feed(all.subarray(off, off + len)); off += len; }
  assert.equal(c.st.n, 50);
  assert.deepEqual(Array.from(c.st.content.subarray(0, 50)), Array.from(whole.content.subarray(0, 50)));
  assert.deepEqual(c.st.curveLuma, whole.curveLuma);
  assert.equal(whole.curveLuma.length, 4); // 50 帧 @25fps = 2 秒 → 0、0.5、1、1.5
  assert.equal(whole.thumbs.length, 4);
});

test('buildShotBounds：静态长视频等分、镜头数上限', () => {
  assert.deepEqual(sd.buildShotBounds([3, 3.2, 6, 8.9], 9), [{ start: 0, end: 3 }, { start: 3, end: 6 }, { start: 6, end: 9 }]);
  assert.equal(sd.buildShotBounds([], 30).length, 5);
  const r = sd.finishScan(collect(Array.from({ length: 400 }, (_, i) => jitter(texture(15), i))), { durationHint: 16 });
  assert.equal(r.shots.length, 3);
  assert.equal(r.shots[1].cutIn.kind, 'split');
});

// ───────────── 真实 ffmpeg ─────────────

function ffmpegBin() { try { const p = require('ffmpeg-static'); return p && fs.existsSync(p) ? p : null; } catch { return null; } }
const FF = ffmpegBin();

function makeTransitions(dir) {
  const out = path.join(dir, 'transitions.mp4');
  const graph = [
    '[0:v][1:v]xfade=transition=fade:duration=1:offset=3[x]',
    '[x]fade=t=out:st=6.4:d=0.6[xo]',
    '[2:v]fade=t=in:st=0:d=0.6[ci]',
    "[xo][ci]concat=n=2:v=1:a=0,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(t,9,9.05)',format=yuv420p[v]",
  ].join(';');
  const r = spawnSync(FF, ['-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=4',
    '-f', 'lavfi', '-i', 'smptebars=size=320x180:rate=25:duration=4',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=4',
    '-filter_complex', graph, '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', out], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error('生成测试视频失败：' + r.stderr);
  return out;
}

test('真实视频：叠化、黑场、闪光；worker 与主线程结果一致；批量导出关键帧', { skip: !FF && '缺少 ffmpeg-static', timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-shotdetect-'));
  try {
    const video = makeTransitions(dir);
    const fracs = [];
    const a = await sd.scanVideo({ ffmpeg: FF }, video, { seconds: 11, rate: 25, durationHint: 11, onFrac: (x) => fracs.push(x) });
    const b = await sd.scanVideo({ ffmpeg: FF }, video, { seconds: 11, rate: 25, durationHint: 11, noWorker: true });
    assert.equal(a.usedWorker, true);
    assert.equal(b.usedWorker, false);
    assert.deepEqual(a.cuts, b.cuts);
    assert.deepEqual(a.shots.map((s) => s.keyframes), b.shots.map((s) => s.keyframes));
    assert.ok(a.n >= 270 && a.n <= 280, '帧数 ' + a.n);
    assert.ok(fracs.length > 0 && fracs.every((x) => x >= 0 && x <= 1));
    const kinds = a.cuts.map((c) => `${c.kind}@${c.t}`).join(' ');
    const dis = a.cuts.find((c) => Math.abs(c.t - 3.5) < 0.4);
    assert.ok(dis && dis.kind === 'dissolve', '叠化：' + kinds);
    const fade = a.cuts.find((c) => Math.abs(c.t - 7) < 0.3);
    assert.ok(fade && fade.kind === 'fade', '黑场：' + kinds);
    assert.ok(!a.cuts.some((c) => Math.abs(c.t - 9) < 0.5), '闪光不该切：' + kinds);
    assert.equal(a.cuts.length, 2, kinds);
    assert.equal(a.shots.length, 3);
    for (const s of a.shots) {
      assert.ok(s.keyframes.length >= 1);
      assert.ok(s.stats && s.stats.palette.length === 5);
    }
    assert.equal(a.curves.luma.length, 22);
    // 批量导出
    const items = a.shots.map((s, i) => ({ frame: s.keyframes[0].frame, out: path.join(dir, `kf_${i}.jpg`) }));
    const ok = await sd.extractFramesBatch({ ffmpeg: FF }, video, items, { rate: 25, seconds: 11 });
    assert.equal(ok.size, items.length);
    for (const it of items) assert.ok(fs.statSync(it.out).size > 500);
    assert.ok(!fs.existsSync(path.join(dir, '_kf_tmp')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('真实视频：取消与坏文件', { skip: !FF && '缺少 ffmpeg-static', timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-shotdetect-'));
  try {
    const bad = path.join(dir, 'bad.mp4');
    fs.writeFileSync(bad, 'not a video');
    await assert.rejects(() => sd.scanVideo({ ffmpeg: FF }, bad, { seconds: 5, rate: 25 }), /没有读到任何画面/);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(() => sd.scanVideo({ ffmpeg: FF }, bad, { seconds: 5, rate: 25, signal: ac.signal }), (e) => e.code === 'CANCELLED');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
