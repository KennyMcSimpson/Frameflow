// timeline.js 单元测试：布局、转场重叠、activeAt / textAt / audioAt / 区间查询 / 吸附点
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clipDuration, layoutVideo, projectDuration, activeAt, textAt, audioAt, indexAtTime, itemsInRange, snapPoints,
} from '../src/engine/timeline.js';
import { createProject, createAsset, createClip, createTextClip, createAudioClip } from '../src/engine/model.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

function makeProject(specs) {
  const p = createProject({ name: '测试' });
  const asset = createAsset({ id: 'a1', kind: 'video', duration: 30 });
  p.assets.a1 = asset;
  p.tracks.video = specs.map((s, i) => createClip(asset, { id: `c${i + 1}`, in: 0, out: s.len, speed: s.speed || 1, transitionIn: s.tr || { type: 'cut', duration: 0.5 } }));
  return p;
}

test('clipDuration：考虑速度，缺字段不返回 NaN 或负数', () => {
  assert.equal(clipDuration({ in: 1, out: 5, speed: 2 }), 2);
  assert.equal(clipDuration({ in: 0, out: 3 }), 3);
  assert.equal(clipDuration({ in: 5, out: 3, speed: 1 }), 0);
  assert.equal(clipDuration({ in: 'x', out: 4, speed: 0 }), 4);
  assert.equal(clipDuration(null), 0);
});

test('layoutVideo：硬切首尾相接', () => {
  const layout = layoutVideo(makeProject([{ len: 4 }, { len: 3 }, { len: 5 }]));
  assert.deepEqual(layout.map((it) => [it.start, it.end, it.overlap]), [[0, 4, 0], [4, 7, 0], [7, 12, 0]]);
  assert.equal(layout[1].index, 1);
});

test('layoutVideo：转场重叠 = min(转场时长, 本镜/2, 上一镜/2)', () => {
  const p = makeProject([
    { len: 4 },
    { len: 4, tr: { type: 'crossfade', duration: 1 } }, // 重叠 1
    { len: 1, tr: { type: 'dip-black', duration: 2 } }, // 本镜一半 0.5
    { len: 6, tr: { type: 'slide-left', duration: 1.5 } }, // 上一镜一半 0.5
  ]);
  const layout = layoutVideo(p);
  assert.deepEqual(layout.map((it) => it.overlap), [0, 1, 0.5, 0.5]);
  assert.deepEqual(layout.map((it) => it.start), [0, 3, 6.5, 7]);
  assert.equal(layout[3].end, 13);
  assert.equal(projectDuration(p), 13);
});

test('layoutVideo：第一镜入场不产生重叠，速度影响时长', () => {
  const p = makeProject([{ len: 4, speed: 2, tr: { type: 'dip-black', duration: 1 } }, { len: 2 }]);
  const layout = layoutVideo(p);
  assert.equal(layout[0].start, 0);
  assert.equal(layout[0].duration, 2);
  assert.equal(layout[1].start, 2);
});

test('空项目与缺失轨道', () => {
  assert.deepEqual(layoutVideo(createProject()), []);
  assert.deepEqual(layoutVideo({}), []);
  assert.equal(projectDuration(createProject()), 0);
  assert.deepEqual(activeAt([], 1), { out: null, in: null, transition: null });
  assert.equal(indexAtTime([], 3), -1);
});

test('projectDuration：取主轨、文字、音频的最大结束时间', () => {
  const p = makeProject([{ len: 4 }]);
  p.tracks.text = [createTextClip({ start: 3, duration: 5 })];
  assert.equal(projectDuration(p), 8);
  p.assets.m = createAsset({ id: 'm', kind: 'audio', duration: 20 });
  p.tracks.audio = [createAudioClip(p.assets.m, { start: 2, in: 1, out: 11 })];
  assert.equal(projectDuration(p), 12);
});

test('activeAt：普通时刻只有 in，srcTime 按速度换算', () => {
  const p = makeProject([{ len: 4 }, { len: 6, speed: 2 }]);
  p.tracks.video[1].in = 2;
  p.tracks.video[1].out = 8;
  const layout = layoutVideo(p);
  const a = activeAt(layout, 1);
  assert.equal(a.out, null);
  assert.equal(a.in.index, 0);
  near(a.in.srcTime, 1);
  assert.equal(a.transition, null);
  const b = activeAt(layout, 5);
  assert.equal(b.in.index, 1);
  near(b.in.srcTime, 2 + 1 * 2);
  near(b.in.progress, 1 / 3);
});

test('activeAt：转场期间 out=上一镜，in=本镜，p 从 0 到 1', () => {
  const p = makeProject([{ len: 4 }, { len: 4, tr: { type: 'crossfade', duration: 1 } }]);
  const layout = layoutVideo(p);
  const a = activeAt(layout, 3.5);
  assert.equal(a.out.index, 0);
  assert.equal(a.in.index, 1);
  assert.equal(a.transition.type, 'crossfade');
  near(a.transition.p, 0.5);
  assert.equal(a.transition.duration, 1);
  near(a.out.srcTime, 3.5);
  near(a.in.srcTime, 0.5);
  const start = activeAt(layout, 3);
  near(start.transition.p, 0);
  const after = activeAt(layout, 4);
  assert.equal(after.out, null);
  assert.equal(after.transition, null);
});

test('activeAt：第一镜从黑场淡入', () => {
  const p = makeProject([{ len: 4, tr: { type: 'dip-black', duration: 1 } }, { len: 4 }]);
  const layout = layoutVideo(p);
  const a = activeAt(layout, 0.25);
  assert.equal(a.out, null);
  assert.equal(a.in.index, 0);
  assert.equal(a.transition.type, 'dip-black');
  near(a.transition.p, 0.25);
  assert.equal(activeAt(layout, 1.5).transition, null);
});

test('activeAt：越界返回空，恰好等于总时长返回最后一镜末帧', () => {
  const p = makeProject([{ len: 4 }, { len: 2 }]);
  const layout = layoutVideo(p);
  assert.deepEqual(activeAt(layout, -0.1), { out: null, in: null, transition: null });
  assert.deepEqual(activeAt(layout, 6.01), { out: null, in: null, transition: null });
  const end = activeAt(layout, 6);
  assert.equal(end.in.index, 1);
  assert.ok(end.in.srcTime < 2, '末帧不越过出点');
  assert.deepEqual(activeAt(layout, Number.NaN), { out: null, in: null, transition: null });
});

test('textAt / audioAt：按时间筛选并给出进度与源时间', () => {
  const p = makeProject([{ len: 10 }]);
  p.tracks.text = [createTextClip({ id: 't1', start: 1, duration: 2 }), createTextClip({ id: 't2', start: 2, duration: 4 })];
  const hits = textAt(p, 2.5);
  assert.deepEqual(hits.map((h) => h.text.id), ['t1', 't2']);
  near(hits[0].progress, 0.75);
  assert.deepEqual(textAt(p, 0.5), []);
  p.assets.m = createAsset({ id: 'm', kind: 'audio', duration: 30 });
  p.tracks.audio = [createAudioClip(p.assets.m, { id: 'au', start: 2, in: 5, out: 10 })];
  const a = audioAt(p, 4);
  assert.equal(a.length, 1);
  near(a[0].srcTime, 7);
  assert.deepEqual(audioAt(p, 8), []);
});

test('indexAtTime：重叠区返回后一镜，越界夹紧', () => {
  const p = makeProject([{ len: 4 }, { len: 4, tr: { type: 'crossfade', duration: 1 } }, { len: 4 }]);
  const layout = layoutVideo(p);
  assert.equal(indexAtTime(layout, 0), 0);
  assert.equal(indexAtTime(layout, 2), 0);
  assert.equal(indexAtTime(layout, 3.2), 1);
  assert.equal(indexAtTime(layout, 8), 2);
  assert.equal(indexAtTime(layout, 100), 2);
  assert.equal(indexAtTime(layout, -5), 0);
});

test('itemsInRange：区间相交、颠倒自动交换、零长度区间', () => {
  const layout = layoutVideo(makeProject([{ len: 4 }, { len: 4 }, { len: 4 }]));
  assert.deepEqual(itemsInRange(layout, 3, 5).map((it) => it.index), [0, 1]);
  assert.deepEqual(itemsInRange(layout, 9, 2).map((it) => it.index), [0, 1, 2]);
  assert.deepEqual(itemsInRange(layout, 4, 4).map((it) => it.index), [1]);
  assert.deepEqual(itemsInRange(layout, 4, 8).map((it) => it.index), [1]);
  assert.deepEqual(itemsInRange(layout, 20, 30), []);
  assert.deepEqual(itemsInRange(layout, 'a', 3), []);
});

test('snapPoints：升序去重，包含文字与音频边界', () => {
  const p = makeProject([{ len: 4 }, { len: 2 }]);
  p.tracks.text = [createTextClip({ start: 1, duration: 2 })];
  const points = snapPoints(layoutVideo(p), p);
  for (const v of [0, 1, 3, 4, 6]) assert.ok(points.includes(v), `包含 ${v}`);
  assert.deepEqual(points, [...points].sort((a, b) => a - b));
  assert.equal(new Set(points).size, points.length);
});

test('布局不修改入参', () => {
  const p = makeProject([{ len: 4 }, { len: 4, tr: { type: 'crossfade', duration: 1 } }]);
  const before = JSON.stringify(p);
  layoutVideo(p);
  activeAt(layoutVideo(p), 3.5);
  projectDuration(p);
  assert.equal(JSON.stringify(p), before);
});


// ---------------------------------------------------------------------------
// v3：变速曲线 / 倒放 / 定格 / 画中画 / 编辑纯函数 / 自动闪避
// ---------------------------------------------------------------------------
import {
  sourceTimeAt, overlaysAt, rollEdit, slipEdit, slideEdit, rippleDelete, trimLeftAt, trimRightAt, autoDuck, nearestBeat,
  curveMeanSpeed, sliceCurve, beatTimes, subClip, volumeKeyAt,
} from '../src/engine/timeline.js';
import { createOverlay } from '../src/engine/model.js';

test('sourceTimeAt：普通 / 变速 / 倒放 / 定格，结果夹在范围内', () => {
  near(sourceTimeAt({ in: 2, out: 6, speed: 1 }, 1), 3);
  near(sourceTimeAt({ in: 2, out: 6, speed: 2 }, 1), 4);
  near(sourceTimeAt({ in: 2, out: 6, speed: 1, reverse: true }, 1), 5);
  assert.equal(sourceTimeAt({ in: 3, out: 3, still: true, duration: 2 }, 1.5), 3);
  assert.ok(sourceTimeAt({ in: 0, out: 4 }, 99) < 4, '末尾留一帧');
  assert.equal(sourceTimeAt({ in: 0, out: 4 }, -1), 0);
});

test('clipDuration / sourceTimeAt：曲线变速按积分计算', () => {
  const curve = [{ t: 0, v: 1 }, { t: 1, v: 3 }]; // 平均速度 2
  near(curveMeanSpeed(curve), 2);
  const clip = { in: 0, out: 8, speed: 1, speedCurve: curve };
  near(clipDuration(clip), 4);
  // u=0.5 处积分 = 0.5*(1+2)/2 = 0.75 → 源 = 4*0.75 = 3
  near(sourceTimeAt(clip, 2), 3);
  near(sourceTimeAt(clip, 4 - 1e-9), 8 - 1 / 60, 1e-6);
  assert.equal(clipDuration({ still: true, duration: 2.5, in: 1, out: 1 }), 2.5);
  const sl = sliceCurve([{ t: 0, v: 1 }, { t: 1, v: 3 }], 0.5, 1);
  assert.equal(sl[0].v, 2);
  assert.equal(sl[sl.length - 1].v, 3);
  // 布局使用 clipDuration
  const p = makeProject([{ len: 4 }]);
  p.tracks.video[0].speedCurve = [{ t: 0, v: 2 }, { t: 1, v: 2 }];
  near(layoutVideo(p)[0].duration, 2);
});

test('activeAt：倒放镜头 srcTime 从出点往回走', () => {
  const p = makeProject([{ len: 4 }]);
  p.tracks.video[0].reverse = true;
  const a = activeAt(layoutVideo(p), 1);
  near(a.in.srcTime, 3);
});

function edProject() {
  const p = createProject({ name: '编辑' });
  p.assets.a1 = createAsset({ id: 'a1', kind: 'video', duration: 10 });
  p.assets.m = createAsset({ id: 'm', kind: 'audio', duration: 60, beats: [1, 2.1, 3.9, 6, 8] });
  p.tracks.video = [
    createClip(p.assets.a1, { id: 'c1', in: 2, out: 6 }),
    createClip(p.assets.a1, { id: 'c2', in: 2, out: 6 }),
    createClip(p.assets.a1, { id: 'c3', in: 2, out: 6 }),
  ];
  p.tracks.text = [createTextClip({ id: 't1', start: 9, duration: 1 })];
  p.tracks.audio = [createAudioClip(p.assets.m, { id: 'mus', start: 0, in: 0, out: 12, role: 'music' })];
  return p;
}

test('rollEdit：前一镜变长、后一镜变短，总时长不变，越界夹紧', () => {
  const p = edProject();
  const r = rollEdit(p, 4.1, 1);
  const L = layoutVideo(r.project);
  near(L[0].duration, 5);
  near(L[1].duration, 3);
  near(projectDuration(r.project), projectDuration(p));
  assert.equal(r.project.tracks.video[1].in, 3);
  const big = rollEdit(p, 4, 100);
  near(big.delta, 3.8, 1e-6); // 后一镜只能缩到 0.2 秒
  assert.throws(() => rollEdit({ ...p, tracks: { ...p.tracks, video: [p.tracks.video[0]] } }, 2, 1), /两个镜头/);
  assert.equal(p.tracks.video[0].out, 6, '入参不变');
});

test('slipEdit：时长不变，取景段平移，夹到素材边界；图片报错', () => {
  const p = edProject();
  const r = slipEdit(p, 'c2', 1.5);
  assert.equal(r.project.tracks.video[1].in, 3.5);
  assert.equal(r.project.tracks.video[1].out, 7.5);
  near(slipEdit(p, 'c2', 99).delta, 4);
  near(slipEdit(p, 'c2', -99).delta, -2);
  p.assets.img = createAsset({ id: 'img', kind: 'image' });
  p.tracks.video[1] = createClip(p.assets.img, { id: 'c2', in: 0, out: 4 });
  assert.throws(() => slipEdit(p, 'c2', 1), /图片/);
});

test('slideEdit：镜头内容不变，前后邻镜此消彼长；首尾镜不可外滑', () => {
  const p = edProject();
  const r = slideEdit(p, 'c2', 1);
  const L = layoutVideo(r.project);
  near(L[0].duration, 5);
  near(L[1].duration, 4);
  near(L[2].duration, 3);
  near(L[1].start, 5);
  assert.deepEqual([r.project.tracks.video[1].in, r.project.tracks.video[1].out], [2, 6]);
  assert.throws(() => slideEdit(p, 'c1', 1), /相邻/);
});

test('rippleDelete：删除主轨镜头后，后续文字/音频/标记一起前移', () => {
  const p = edProject();
  p.markers = [{ id: 'mk', t: 10, label: '', color: '#fff' }];
  const r = rippleDelete(p, ['c2']);
  assert.deepEqual(r.tracks.video.map((c) => c.id), ['c1', 'c3']);
  near(r.tracks.text[0].start, 5);
  near(r.markers[0].t, 6);
  assert.equal(r.tracks.audio[0].start, 0, '开始于删除段之前的不动');
  const r2 = rippleDelete(p, ['t1']);
  assert.equal(r2.tracks.text.length, 0);
  assert.throws(() => rippleDelete(p, ['c1', 'c2', 'c3']), /至少/);
  assert.throws(() => rippleDelete(p, ['nope']), /找不到/);
});

test('trimLeftAt（Q）/ trimRightAt（W）', () => {
  const p = edProject();
  const q = trimLeftAt(p, 5);
  assert.equal(q.tracks.video[1].in, 3);
  near(layoutVideo(q)[1].duration, 3);
  near(q.tracks.text[0].start, 8);
  const w = trimRightAt(p, 5);
  assert.equal(w.tracks.video[1].out, 3);
  near(w.tracks.text[0].start, 6);
  assert.throws(() => trimLeftAt(p, 4), /不在任何镜头内部/);
  assert.throws(() => trimRightAt(p, 4.1), /不足/);
  // 倒放镜头：Q 去掉时间线前段 = 源的后段
  const rv = edProject();
  rv.tracks.video[1].reverse = true;
  const qr = trimLeftAt(rv, 5);
  assert.deepEqual([qr.tracks.video[1].in, qr.tracks.video[1].out], [2, 5]);
});

test('subClip：定格片段只改时长', () => {
  const s = subClip({ id: 'x', still: true, in: 3, out: 3, duration: 4, keys: {} }, 1, 3);
  assert.equal(s.duration, 2);
});

test('overlaysAt：按轨道层级排序，隐藏轨跳过', () => {
  const p = edProject();
  p.assets.img = createAsset({ id: 'img', kind: 'image' });
  p.overlays = [createOverlay(p.assets.img, { id: 'o2', track: 2, start: 1 }), createOverlay(p.assets.img, { id: 'o1', track: 1, start: 0 })];
  assert.deepEqual(overlaysAt(p, 1.5).map((x) => x.overlay.id), ['o1', 'o2']);
  assert.deepEqual(overlaysAt(p, 6).map((x) => x.overlay.id), []);
  p.trackState = { overlay: { 2: { hidden: true } } };
  assert.deepEqual(overlaysAt(p, 1.5).map((x) => x.overlay.id), ['o1']);
  assert.ok(projectDuration(p) >= 12);
});

test('snapPoints：包含画中画边界、标记与音乐节拍', () => {
  const p = edProject();
  p.assets.img = createAsset({ id: 'img', kind: 'image' });
  p.overlays = [createOverlay(p.assets.img, { id: 'o1', start: 0.5 })];
  p.markers = [{ id: 'm1', t: 7.25 }];
  const pts = snapPoints(layoutVideo(p), p);
  for (const x of [0.5, 4.5, 7.25, 2.1, 3.9]) assert.ok(pts.includes(x), `含 ${x}`);
  assert.deepEqual(beatTimes(p), [1, 2.1, 3.9, 6, 8]);
});

test('nearestBeat', () => {
  assert.equal(nearestBeat([1, 2, 3], 2.4), 2);
  assert.equal(nearestBeat([1, 2, 3], 2.6), 3);
  assert.equal(nearestBeat([], 1), null);
  assert.equal(nearestBeat([1], 5, 1), null);
});

test('autoDuck：人声段压低音乐，起音/释音；无人声时为空', () => {
  const p = edProject();
  p.assets.vo = createAsset({ id: 'vo', kind: 'audio', duration: 20 });
  p.tracks.audio.push(createAudioClip(p.assets.vo, { id: 'v', start: 2, in: 0, out: 3, role: 'voice' }));
  const map = autoDuck(p, { amount: 0.3, attack: 0.2, release: 0.5 });
  assert.equal('v' in map, false, '人声本身不闪避');
  assert.deepEqual(map.mus, [{ t: 1.8, v: 1 }, { t: 2, v: 0.3 }, { t: 5, v: 0.3 }, { t: 5.5, v: 1 }]);
  near(volumeKeyAt(map.mus, 3), 0.3);
  near(volumeKeyAt(map.mus, 1.9), 0.65);
  const none = autoDuck(edProject());
  assert.deepEqual(none.mus, [], '素材无原声、无人声音频');
});
