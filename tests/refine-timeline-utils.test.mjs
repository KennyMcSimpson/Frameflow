// H1 精修时间线纯函数测试：node --test tests/refine-timeline-utils.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseTickStep, ticksInView, formatRulerTime, zoomToSlider, sliderToZoom, zoomToFit,
  snapTime, snapSpan, dropSlot, slotTime, moveTargetIndex, trimVideoClip, trimTextClip, trimAudioClip,
  packRows, filmstripRequestCount, pickFilmFrames, slicePeaks, createQueue, createPromiseCache,
  shotRangeLabel, clampNum, isStillAsset, ZOOM_MIN, ZOOM_MAX, MIN_CLIP,
} from '../src/ui/modes/refine/timelineUtils.js';

test('刻度：主刻度间距不小于 72px，次刻度过密时为 0', () => {
  const a = chooseTickStep(60);
  assert.ok(a.major * 60 >= 72);
  assert.equal(a.major, 2);
  const b = chooseTickStep(8);
  assert.ok(b.major * 8 >= 72);
  assert.equal(chooseTickStep(0.01).major, 600);
  const c = chooseTickStep(400);
  assert.equal(c.major, 0.2);
  assert.ok(c.minor === 0 || c.minor * 400 >= 6);
});

test('ticksInView 无浮点累积误差且受上限限制', () => {
  const t = ticksInView(0, 1, 0.1);
  assert.equal(t.length, 11);
  assert.equal(t[3], 0.3);
  assert.deepEqual(ticksInView(5, 5, 1), []);
  assert.deepEqual(ticksInView(0, 10, 0), []);
  assert.equal(ticksInView(0, 1e6, 1, 50).length, 50);
});

test('formatRulerTime', () => {
  assert.equal(formatRulerTime(0), '00:00');
  assert.equal(formatRulerTime(75, 5), '01:15');
  assert.equal(formatRulerTime(1.5, 0.5), '00:01.5');
  assert.equal(formatRulerTime(-3), '00:00');
  assert.equal(formatRulerTime(NaN), '00:00');
});

test('缩放滑杆对数映射可逆，适配缩放受限', () => {
  assert.equal(zoomToSlider(ZOOM_MIN), 0);
  assert.equal(zoomToSlider(ZOOM_MAX), 100);
  for (const z of [10, 60, 150, 333]) assert.ok(Math.abs(sliderToZoom(zoomToSlider(z)) - z) / z < 0.03);
  assert.equal(zoomToFit(0, 10, 1000, 1), 100);
  assert.equal(zoomToFit(0, 0, 1000), ZOOM_MAX);
  assert.equal(zoomToFit(0, 10000, 1000), ZOOM_MIN);
});

test('吸附：阈值内吸附，排除自身边界', () => {
  assert.deepEqual(snapTime(4.95, [0, 5, 10], 0.1), { t: 5, snapped: true, point: 5 });
  assert.equal(snapTime(4.5, [0, 5, 10], 0.1).snapped, false);
  assert.equal(snapTime(4.95, [0, 5, 10], 0.1, [5]).snapped, false);
  assert.equal(snapTime(3, [], 1).snapped, false);
  assert.deepEqual(snapSpan(2.05, 3, [0, 2, 10], 0.1), { start: 2, point: 2 });
  assert.deepEqual(snapSpan(6.97, 3, [0, 10], 0.1), { start: 7, point: 10 });
  assert.equal(snapSpan(4, 3, [0, 10], 0.1).point, null);
});

test('重排槽位与目标索引', () => {
  const items = [{ start: 0, end: 4 }, { start: 4, end: 6 }, { start: 6, end: 10 }];
  assert.equal(dropSlot(items, 1), 0);
  assert.equal(dropSlot(items, 5.5), 2);
  assert.equal(dropSlot(items, 99), 3);
  assert.equal(dropSlot(null, 3), 0);
  assert.equal(slotTime(items, 0), 0);
  assert.equal(slotTime(items, 2), 6);
  assert.equal(slotTime(items, 3), 10);
  assert.equal(slotTime([], 1), 0);
  assert.equal(moveTargetIndex(0, 3), 2);
  assert.equal(moveTargetIndex(2, 0), 0);
  assert.equal(moveTargetIndex(1, 1), 1);
});

test('视频镜头拖边：不超素材、不短于最小时长、按速度换算', () => {
  const asset = { kind: 'video', duration: 10 };
  const clip = { in: 2, out: 6, speed: 1 };
  assert.deepEqual(trimVideoClip(clip, asset, 'right', 10), { in: 2, out: 10, duration: 8, still: false });
  assert.deepEqual(trimVideoClip(clip, asset, 'left', -5), { in: 0, out: 6, duration: 6, still: false });
  const r = trimVideoClip(clip, asset, 'left', 100);
  assert.ok(r.duration >= MIN_CLIP - 1e-9);
  const fast = trimVideoClip({ in: 0, out: 4, speed: 2 }, asset, 'right', 1);
  assert.equal(fast.out, 6);
  assert.equal(fast.duration, 3);
  const still = trimVideoClip({ in: 0, out: 3 }, { kind: 'image' }, 'left', 1);
  assert.equal(still.still, true);
  assert.equal(still.duration, 2);
  assert.equal(isStillAsset(null), true);
});

test('文字与音频拖边', () => {
  assert.deepEqual(trimTextClip(2, 3, 'left', 1), { start: 3, duration: 2 });
  assert.deepEqual(trimTextClip(2, 3, 'left', -5), { start: 0, duration: 5 });
  assert.equal(trimTextClip(2, 3, 'right', -10).duration, 0.2);
  assert.deepEqual(trimAudioClip({ start: 5, in: 1, out: 8 }, 10, 'left', -3), { start: 4, in: 0, out: 8 });
  assert.deepEqual(trimAudioClip({ start: 5, in: 1, out: 8 }, 10, 'right', 5), { start: 5, in: 1, out: 10 });
  const l = trimAudioClip({ start: 0, in: 0, out: 2 }, 10, 'left', 9);
  assert.ok(l.out - l.in >= MIN_CLIP - 1e-9);
});

test('packRows 重叠分行', () => {
  const { rows, count } = packRows([
    { id: 'a', start: 0, end: 3 }, { id: 'b', start: 1, end: 2 }, { id: 'c', start: 3, end: 4 }, null,
  ]);
  assert.equal(count, 2);
  assert.equal(rows.a, 0);
  assert.equal(rows.b, 1);
  assert.equal(rows.c, 0);
  assert.equal(packRows([]).count, 1);
});

test('胶片条帧数与取帧、波形切片', () => {
  const n = filmstripRequestCount(5, 10, 10);
  assert.ok(n >= 4 && n <= 32 && (n & (n - 1)) === 0);
  assert.equal(filmstripRequestCount(200, 100, 1), 32);
  const frames = pickFilmFrames(8, 10, 0, 10, 4);
  assert.deepEqual(frames, [1, 3, 5, 7]);
  assert.ok(pickFilmFrames(8, 10, 9, 20, 3).every((f) => f >= 0 && f <= 7));
  const peaks = slicePeaks([0, 0.5, 1, 0.25, -0.8, 0], 2, 0, 3, 3);
  assert.deepEqual(peaks, [0.5, 1, 0.8]);
  assert.deepEqual(slicePeaks(null, 50, 0, 1, 2), [0, 0]);
});

test('并发队列限制同时运行数', async () => {
  const q = createQueue(2);
  let running = 0; let peak = 0;
  const job = () => new Promise((r) => { running += 1; peak = Math.max(peak, running); setTimeout(() => { running -= 1; r(1); }, 5); });
  const results = await Promise.all(Array.from({ length: 6 }, () => q.push(job)));
  assert.equal(results.length, 6);
  assert.equal(peak, 2);
  await assert.rejects(q.push(() => { throw new Error('x'); }));
  assert.equal(await q.push(() => 7), 7);
});

test('Promise 缓存：成功复用，失败过期可重试', async () => {
  const c = createPromiseCache({ retryMs: 10 });
  let calls = 0;
  const a = await c.get('k', () => { calls += 1; return 1; });
  const b = await c.get('k', () => { calls += 1; return 2; });
  assert.equal(a, 1); assert.equal(b, 1); assert.equal(calls, 1);
  await assert.rejects(c.get('bad', () => { throw new Error('fail'); }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(c.has('bad'), false);
});

test('镜头范围文案与 clampNum', () => {
  assert.equal(shotRangeLabel([2]), '第3镜');
  assert.equal(shotRangeLabel([3, 2, 4]), '第3–5镜');
  assert.equal(shotRangeLabel([]), '');
  assert.equal(clampNum('x', 1, 5), 1);
  assert.equal(clampNum(9, 1, 5), 5);
});

// ---------------- v3：虚拟化 / 剪辑点 / roll / slip / 包络 / 快捷键注册表 ----------------
import * as U from '../src/ui/modes/refine/timelineUtils.js';
import * as R from '../src/ui/shortcuts/registry.js';

test('v3 虚拟化：只保留与视窗相交的片段', () => {
  const items = [{ start: 0, end: 5 }, { start: 5, end: 10 }, { start: 50, end: 60 }];
  assert.equal(U.visibleItems(items, 6, 20, undefined, 0).length, 1);
  assert.equal(U.visibleItems(items, 6, 20, undefined, 2).length, 2);
  assert.equal(U.visibleItems(items, 0, 100).length, 3);
  assert.ok(U.spanInView(4, 5, 6, 10, 1.5));
  assert.ok(!U.spanInView(4, 5, 6, 10, 0.5));
});

test('v3 剪辑点：上一个 / 下一个，去重升序', () => {
  const pts = U.editPoints([{ start: 0, end: 3 }, { start: 3, end: 7.5 }], [5]);
  assert.deepEqual(pts, [0, 3, 5, 7.5]);
  assert.equal(U.nextEditPoint(pts, 3, 1), 5);
  assert.equal(U.nextEditPoint(pts, 3, -1), 0);
  assert.equal(U.nextEditPoint(pts, 7.5, 1), null);
  assert.equal(U.nextEditPoint(pts, 0, -1), null);
});

test('v3 roll 范围：受左镜余量与右镜入点限制', () => {
  const L = { in: 0, out: 4, speed: 1 }; const LA = { kind: 'video', duration: 5 };
  const Rc = { in: 1, out: 4, speed: 1 }; const RA = { kind: 'video', duration: 10 };
  const lim = U.rollLimits(L, LA, Rc, RA);
  assert.equal(lim.max, 1);   // 左镜素材只剩 1 秒
  assert.equal(lim.min, -1);  // 右镜入点只能往前 1 秒
  const lim2 = U.rollLimits(L, { kind: 'image' }, Rc, { kind: 'image' });
  assert.equal(lim2.max, 3 - MIN_CLIP);
  assert.equal(lim2.min, -(4 - MIN_CLIP));
});

test('v3 slip 范围：in≥0、out≤素材时长；图片不能 slip', () => {
  assert.deepEqual(U.slipLimits({ in: 2, out: 5 }, { kind: 'video', duration: 8 }), { min: -2, max: 3 });
  assert.deepEqual(U.slipLimits({ in: 0, out: 3 }, { kind: 'image' }), { min: 0, max: 0 });
});

test('v3 转场拖动 / 淡入淡出 / 音量映射', () => {
  assert.equal(U.transitionDurationFromDrag(0.5, 30, 60), 1.5);
  assert.equal(U.transitionDurationFromDrag(0.5, -300, 60), 0.1);
  assert.equal(U.transitionDurationFromDrag(0.5, 600, 60, 2), 2);
  assert.equal(U.fadeFromDrag(4, 3), 2);
  assert.equal(U.fadeFromDrag(4, -1), 0);
  assert.equal(U.volumeToY(1, 40), 20);
  assert.equal(U.volumeToY(2, 40), 0);
  assert.equal(U.yToVolume(20, 40), 1);
  assert.equal(U.yToVolume(100, 40), 0);
});

test('v3 音量线：含淡入淡出与关键帧拐点', () => {
  const pts = U.volumeLinePoints({ base: 1, fadeIn: 1, fadeOut: 1, len: 4, pps: 10, h: 40 }).split(' ');
  assert.equal(pts[0], '0,40');
  assert.ok(pts.includes('10,20'));
  assert.equal(pts[pts.length - 1], '40,40');
  const k = U.volumeLinePoints({ base: 1, keys: [{ t: 2, v: 2 }], len: 4, pps: 10, h: 40 });
  assert.ok(k.includes('20,0'));
});

test('v3 画中画轨列表 / 时长 / 关键帧时间 / 时长文案', () => {
  assert.deepEqual(U.overlayTrackList([], 1), [1]);
  assert.deepEqual(U.overlayTrackList([{ track: 3 }], 1), [3, 2, 1]);
  assert.deepEqual(U.overlayTrackList([{ track: 1 }], 2), [2, 1]);
  assert.equal(U.overlayDuration({ in: 1, out: 5, speed: 2 }), 2);
  assert.deepEqual(U.keyframeTimes({ opacity: [{ t: 1 }, { t: 0.5 }], 'transform.x': [{ t: 1 }] }), [0.5, 1]);
  assert.equal(U.shortDur(4.25), '4.3s');
  assert.equal(U.shortDur(65), '1:05');
});

test('快捷键注册表：无冲突，e.code 匹配，中文输入法下按物理键', () => {
  assert.deepEqual(R.findConflicts(), []);
  const map = R.buildKeymap();
  const ev = (code, mods = {}) => ({ code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  assert.equal(R.matchShortcut(ev('KeyB', { ctrlKey: true }), map).id, 'split');
  assert.equal(R.matchShortcut(ev('KeyS'), map).id, 'split');
  assert.equal(R.matchShortcut(ev('KeyQ'), map).id, 'trimLeft');
  assert.equal(R.matchShortcut(ev('KeyZ', { shiftKey: true }), map).id, 'zoomFit');
  assert.equal(R.matchShortcut(ev('Slash', { shiftKey: true }), map).id, 'help');
  assert.equal(R.matchShortcut(ev('KeyD', { metaKey: true }), map).id, 'duplicate');
  assert.equal(R.matchShortcut(ev('KeyZ', { ctrlKey: true }), map), null); // 撤销由外壳处理
  assert.equal(R.matchShortcut(ev('ShiftLeft', { shiftKey: true }), map), null);
});

test('快捷键注册表：冲突检测、规范化与显示文字', () => {
  const list = [{ id: 'a', keys: ['Shift+Ctrl+KeyX'] }, { id: 'b', keys: ['Ctrl+Shift+KeyX'] }];
  assert.deepEqual(R.findConflicts(list), [{ combo: 'Ctrl+Shift+KeyX', ids: ['a', 'b'] }]);
  assert.equal(R.normalizeCombo('shift+cmd+KeyZ'), 'Ctrl+Shift+KeyZ');
  assert.equal(R.formatCombo('Ctrl+Shift+KeyZ'), 'Ctrl+Shift+Z');
  assert.equal(R.formatCombo('Shift+Slash'), '?');
  assert.equal(R.formatCombo('Space'), '空格');
  assert.equal(R.kbdOf('split'), 'Ctrl+B');
  const groups = R.groupedShortcuts();
  assert.ok(groups.length >= 4 && groups.every((g) => g.items.length));
});
