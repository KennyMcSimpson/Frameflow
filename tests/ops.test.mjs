// ops.js 单元测试：每种操作、原子回滚、锁定、目标解析、批次语义、不修改入参
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps, resolveTargets, describeOp, OP_TYPES } from '../src/engine/ops.js';
import { layoutVideo, projectDuration } from '../src/engine/timeline.js';
import {
  createProject, createAsset, createClip, createTextClip, createAudioClip, LIMITS,
} from '../src/engine/model.js';

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const idx = (...indices) => ({ mode: 'index', indices, ids: [] });

/** 3 个视频镜头（各 4 秒，素材 10 秒、入点 1）+ 1 张图片 + 1 段音乐 + 1 条文字 */
function fixture({ freeze = true } = {}) {
  const p = createProject({ name: '测试项目' });
  const v1 = createAsset({ id: 'v1', kind: 'video', name: '街景', duration: 10, stats: { luma: 0.3, contrast: 0.4, saturation: 0.4, warmth: 0, tint: 0, palette: [] } });
  const v2 = createAsset({ id: 'v2', kind: 'video', name: '咖啡', duration: 10, stats: { luma: 0.6, contrast: 0.4, saturation: 0.4, warmth: 0.1, tint: 0, palette: [] } });
  const img = createAsset({ id: 'img', kind: 'image', name: '海报', duration: 0 });
  const pv = createAsset({ id: 'pv', kind: 'previz', name: '预演', duration: 6 });
  const music = createAsset({ id: 'm', kind: 'audio', name: '音乐', duration: 60 });
  p.assets = { v1, v2, img, pv, m: music };
  p.tracks.video = [
    createClip(v1, { id: 'c1', in: 1, out: 5 }),
    createClip(v2, { id: 'c2', in: 1, out: 5 }),
    createClip(v1, { id: 'c3', in: 1, out: 5 }),
  ];
  p.tracks.text = [createTextClip({ id: 't1', text: '标题', start: 0, duration: 3 })];
  p.tracks.audio = [createAudioClip(music, { id: 'a1', start: 0, in: 0, out: 12 })];
  return freeze ? deepFreeze(p) : p;
}

function ok(project, ops, ctx) {
  const r = applyOps(project, ops, ctx);
  assert.equal(r.ok, true, `应当成功：${r.errors.join('；')}`);
  assert.equal(r.errors.length, 0);
  return r;
}

function bad(project, ops, ctx, pattern) {
  const r = applyOps(project, ops, ctx);
  assert.equal(r.ok, false, '应当失败');
  assert.equal(r.project, project, '失败时返回原对象');
  assert.deepEqual(r.applied, []);
  if (pattern) assert.ok(r.errors.some((e) => pattern.test(e)), `错误信息 ${JSON.stringify(r.errors)} 应匹配 ${pattern}`);
  return r;
}

const ids = (p) => p.tracks.video.map((c) => c.id);

test('OP_TYPES 覆盖 SPEC §4 全部操作', () => {
  for (const t of ['setColor', 'setLook', 'setMotion', 'setTransform', 'setFx', 'setTransition', 'setCaption', 'setSpeed', 'setVolume', 'trim', 'setDuration', 'split', 'delete', 'duplicate', 'move', 'insertAsset', 'replaceAsset', 'addText', 'updateText', 'removeText', 'addAudio', 'updateAudio', 'removeAudio', 'lock', 'unlock', 'matchColor', 'harmonize', 'applyPacing', 'setProject']) {
    assert.ok(OP_TYPES.includes(t), t);
  }
});

test('空操作列表：成功且返回同一对象', () => {
  const p = fixture();
  const r = applyOps(p, [], {});
  assert.equal(r.ok, true);
  assert.equal(r.project, p);
});

test('非法输入：project 或 ops 不正确时给出中文错误', () => {
  assert.equal(applyOps(null, [], {}).ok, false);
  assert.match(applyOps(fixture(), 'x', {}).errors[0], /操作列表/);
  bad(fixture(), [{ type: 'explode', target: 'all' }], {}, /不支持的操作类型/);
  bad(fixture(), [null], {}, /格式不正确/);
});

test('setColor：相对值累加并夹紧，绝对值越界报错', () => {
  const p = fixture();
  const r = ok(p, [{ type: 'setColor', target: idx(2), color: { temperature: 0.3, exposure: -0.2 }, relative: true }]);
  assert.equal(r.project.tracks.video[1].color.temperature, 0.3);
  assert.equal(r.project.tracks.video[1].color.exposure, -0.2);
  assert.equal(r.project.tracks.video[0], p.tracks.video[0], '未改动的镜头结构共享');
  const r2 = ok(r.project, [{ type: 'setColor', target: idx(2), color: { temperature: 0.9 }, relative: true }]);
  assert.equal(r2.project.tracks.video[1].color.temperature, 1);
  const r3 = ok(p, [{ type: 'setColor', target: 'all', color: { vignette: 0.4, contrast: null } }]);
  assert.ok(r3.project.tracks.video.every((c) => c.color.vignette === 0.4 && c.color.contrast === 0));
  bad(p, [{ type: 'setColor', target: idx(1), color: { exposure: 1.5 } }], {}, /曝光/);
  bad(p, [{ type: 'setColor', target: idx(1), color: { foo: 1 } }], {}, /不支持的调色参数/);
  bad(p, [{ type: 'setColor', target: idx(1), color: {} }], {}, /没有要修改的内容/);
});

test('setLook / setMotion / setTransform / setFx', () => {
  const p = fixture();
  const r = ok(p, [
    { type: 'setLook', target: idx(1), look: 'film-warm', lookStrength: 0.8 },
    { type: 'setMotion', target: idx(1), preset: 'push-in', intensity: 0.6 },
    { type: 'setTransform', target: idx(1), transform: { scale: 1.5, flipH: true } },
    { type: 'setFx', target: idx(1), fx: { grain: 0.3 } },
    { type: 'setFx', target: idx(1), fx: { grain: 0.9 }, relative: true },
  ]);
  const c = r.project.tracks.video[0];
  assert.equal(c.color.look, 'film-warm');
  assert.equal(c.color.lookStrength, 0.8);
  assert.deepEqual(c.motion, { preset: 'push-in', intensity: 0.6 });
  assert.equal(c.transform.scale, 1.5);
  assert.equal(c.transform.flipH, true);
  assert.equal(c.fx.grain, 1);
  assert.equal(r.applied.length, 5);
  bad(p, [{ type: 'setLook', target: idx(1), look: 'rainbow' }], {}, /调色风格/);
  bad(p, [{ type: 'setMotion', target: idx(1), preset: 'fly' }], {}, /运镜/);
  bad(p, [{ type: 'setTransform', target: idx(1), transform: { scale: 9 } }], {}, /缩放/);
  bad(p, [{ type: 'setFx', target: idx(1), fx: { sparkle: 1 } }], {}, /不支持的特效/);
});

test('setTransition：时长范围、第一镜规则', () => {
  const p = fixture();
  const r = ok(p, [{ type: 'setTransition', target: idx(2), transition: { type: 'crossfade', duration: 1 } }]);
  assert.deepEqual(r.project.tracks.video[1].transitionIn, { type: 'crossfade', duration: 1 });
  bad(p, [{ type: 'setTransition', target: idx(2), transition: { type: 'crossfade', duration: 5 } }], {}, /转场时长/);
  bad(p, [{ type: 'setTransition', target: idx(1), transition: { type: 'whip-pan' } }], {}, /第一镜/);
  ok(p, [{ type: 'setTransition', target: idx(1), transition: { type: 'dip-black', duration: 0.8 } }]);
  const all = ok(p, [{ type: 'setTransition', target: 'all', transition: { type: 'slide-left', duration: 0.5 } }]);
  assert.equal(all.project.tracks.video[0].transitionIn.type, 'cut');
  assert.equal(all.project.tracks.video[2].transitionIn.type, 'slide-left');
  assert.ok(all.applied.some((t) => /第一镜/.test(t)));
});

test('setCaption / setSpeed / setVolume', () => {
  const p = fixture();
  const r = ok(p, [
    { type: 'setCaption', target: idx(3), caption: { text: '你好', position: 'top' } },
    { type: 'setSpeed', target: idx(3), speed: 2 },
    { type: 'setVolume', target: idx(3), volume: 0.5, mute: true, audioFadeIn: 1 },
    { type: 'setVolume', target: idx(3), volume: 0.2, relative: true },
  ]);
  const c = r.project.tracks.video[2];
  assert.deepEqual(c.caption, { text: '你好', style: 'subtitle', position: 'top' });
  assert.equal(c.speed, 2);
  assert.equal(c.volume, 0.7);
  assert.equal(c.mute, true);
  assert.equal(c.audioFadeIn, 1);
  assert.equal(layoutVideo(r.project)[2].duration, 2);
  bad(p, [{ type: 'setSpeed', target: idx(1), speed: 11 }], {}, /播放速度/);
  bad(p, [{ type: 'setCaption', target: idx(1), caption: { text: 'x'.repeat(301) } }], {}, /300/);
  bad(p, [{ type: 'setVolume', target: idx(1) }], {}, /缺少音频参数/);
});

test('trim：绝对值越界报错，相对值夹紧', () => {
  const p = fixture();
  const r = ok(p, [{ type: 'trim', target: idx(1), in: 2, out: 6 }]);
  assert.deepEqual([r.project.tracks.video[0].in, r.project.tracks.video[0].out], [2, 6]);
  const rel = ok(p, [{ type: 'trim', target: idx(1), in: -5, out: 20, relative: true }]);
  assert.deepEqual([rel.project.tracks.video[0].in, rel.project.tracks.video[0].out], [0, 10]);
  bad(p, [{ type: 'trim', target: idx(1), out: 11 }], {}, /素材长度/);
  bad(p, [{ type: 'trim', target: idx(1), in: 4, out: 4.1 }], {}, /0.2/);
  bad(p, [{ type: 'trim', target: idx(1), in: 5, out: 3 }], {}, /晚于入点/);
});

test('setDuration：保持入点，视频夹紧到素材长度，太短报错', () => {
  const p = fixture();
  const r = ok(p, [{ type: 'setDuration', target: idx(1), duration: 2.5 }]);
  assert.equal(r.project.tracks.video[0].out, 3.5);
  const long = ok(p, [{ type: 'setDuration', target: idx(1), duration: 20 }]);
  assert.equal(long.project.tracks.video[0].out, 10);
  assert.ok(long.applied[0].includes('素材不够长'));
  bad(p, [{ type: 'setDuration', target: idx(1), duration: 0.1 }], {}, /不能少于/);
});

test('split：在播放头处分割，右半新 id、硬切入场', () => {
  const p = fixture();
  const r = ok(p, [{ type: 'split', target: { mode: 'none' } }], { playhead: 5 });
  const v = r.project.tracks.video;
  assert.equal(v.length, 4);
  assert.deepEqual([v[1].id, v[1].in, v[1].out], ['c2', 1, 2]);
  assert.notEqual(v[2].id, 'c2');
  assert.deepEqual([v[2].in, v[2].out], [2, 5]);
  assert.equal(v[2].transitionIn.type, 'cut');
  assert.equal(projectDuration(r.project, layoutVideo(r.project)), 12);
  const explicit = ok(p, [{ type: 'split', target: idx(3), at: 10 }]);
  assert.deepEqual([explicit.project.tracks.video[2].out, explicit.project.tracks.video[3].in], [3, 3]);
  bad(p, [{ type: 'split', target: idx(1), at: 3.95 }], {}, /分割点/);
  bad(p, [{ type: 'split', target: 'selected', at: 6 }], { selectedClipIds: ['c1'] }, /分割点/);
  const noTarget = ok(p, [{ type: 'split', at: 6 }], { selectedClipIds: ['c1'] }).project;
  assert.equal(noTarget.tracks.video[1].out, 3, '不写目标时分割播放头所在镜头');
});

test('delete / duplicate / move', () => {
  const p = fixture();
  assert.deepEqual(ids(ok(p, [{ type: 'delete', target: idx(2) }]).project), ['c1', 'c3']);
  bad(p, [{ type: 'delete', target: 'all' }], {}, /至少要保留/);
  const dup = ok(p, [{ type: 'duplicate', target: idx(1, 3) }]).project;
  assert.equal(dup.tracks.video.length, 5);
  assert.equal(dup.tracks.video[0].id, 'c1');
  assert.notEqual(dup.tracks.video[1].id, 'c1');
  assert.equal(dup.tracks.video[1].assetId, 'v1');
  assert.deepEqual(ids(ok(p, [{ type: 'move', target: idx(3), toIndex: 1 }]).project), ['c3', 'c1', 'c2']);
  assert.deepEqual(ids(ok(p, [{ type: 'move', target: idx(1), toIndex: 3 }]).project), ['c2', 'c3', 'c1']);
  assert.deepEqual(ids(ok(p, [{ type: 'move', target: idx(1, 2), toIndex: 2 }]).project), ['c3', 'c1', 'c2']);
  bad(p, [{ type: 'move', target: idx(1), toIndex: 4 }], {}, /目标位置/);
});

test('insertAsset / replaceAsset', () => {
  const p = fixture();
  const r = ok(p, [{ type: 'insertAsset', assetId: 'img', atIndex: 2, duration: 3 }]);
  assert.equal(r.project.tracks.video.length, 4);
  assert.equal(r.project.tracks.video[1].assetId, 'img');
  assert.equal(layoutVideo(r.project)[1].duration, 3);
  const end = ok(p, [{ type: 'insertAsset', assetId: 'pv' }]);
  assert.equal(end.project.tracks.video[3].out, 6, '预演默认用资产时长');
  const longVideo = ok(p, [{ type: 'insertAsset', assetId: 'v2', in: 8, duration: 5 }]);
  assert.equal(longVideo.project.tracks.video[3].out, 10);
  bad(p, [{ type: 'insertAsset', assetId: 'm' }], {}, /音频/);
  bad(p, [{ type: 'insertAsset', assetId: 'nope' }], {}, /找不到素材/);
  bad(p, [{ type: 'insertAsset', assetId: 'img', atIndex: 9 }], {}, /插入位置/);

  const withFx = ok(p, [{ type: 'setLook', target: idx(1), look: 'bw' }]).project;
  const rep = ok(withFx, [{ type: 'replaceAsset', target: idx(1), assetId: 'v2' }]).project;
  assert.equal(rep.tracks.video[0].assetId, 'v2');
  assert.equal(rep.tracks.video[0].color.look, 'bw', '保留调色');
  assert.deepEqual([rep.tracks.video[0].in, rep.tracks.video[0].out], [1, 5]);
  const toImg = ok(p, [{ type: 'replaceAsset', target: idx(1), assetId: 'img' }]).project;
  assert.deepEqual([toImg.tracks.video[0].in, toImg.tracks.video[0].out], [0, 4]);
});

test('文字操作：添加（默认在播放头）、修改、删除、锁定', () => {
  const p = fixture();
  const r = ok(p, [{ type: 'addText', text: { text: '欢迎', preset: 'big-bold' } }], { playhead: 2.5 });
  const added = r.project.tracks.text[1];
  assert.equal(added.text, '欢迎');
  assert.equal(added.start, 2.5);
  assert.equal(added.preset, 'big-bold');
  ok(p, [{ type: 'addText', text: '纯文字' }]);
  const up = ok(p, [{ type: 'updateText', textId: 't1', text: { text: '新标题', y: 0.2 } }]).project;
  assert.equal(up.tracks.text[0].text, '新标题');
  assert.equal(up.tracks.text[0].y, 0.2);
  assert.equal(ok(p, [{ type: 'removeText', textId: 't1' }]).project.tracks.text.length, 0);
  bad(p, [{ type: 'removeText', textId: 'zzz' }], {}, /找不到/);
  bad(p, [{ type: 'addText', text: { text: '  ' } }], {}, /不能为空/);
  const locked = ok(p, [{ type: 'updateText', textId: 't1', text: { locked: true } }]).project;
  bad(locked, [{ type: 'updateText', textId: 't1', text: { text: 'x' } }], {}, /已锁定/);
  bad(locked, [{ type: 'removeText', textId: 't1' }], {}, /已锁定/);
  assert.equal(ok(locked, [{ type: 'updateText', textId: 't1', text: { locked: false } }]).project.tracks.text[0].locked, false);
});

test('音频操作：添加、修改、删除、越界', () => {
  const p = fixture();
  const r = ok(p, [{ type: 'addAudio', audio: { assetId: 'm', start: 1, in: 0, out: 10, role: 'sfx' } }]);
  assert.equal(r.project.tracks.audio.length, 2);
  assert.equal(r.project.tracks.audio[1].role, 'sfx');
  const up = ok(p, [{ type: 'updateAudio', audioId: 'a1', audio: { volume: 0.3, fadeOut: 2 } }]).project;
  assert.equal(up.tracks.audio[0].volume, 0.3);
  assert.equal(ok(p, [{ type: 'removeAudio', audioId: 'a1' }]).project.tracks.audio.length, 0);
  bad(p, [{ type: 'updateAudio', audioId: 'a1', audio: { out: 100 } }], {}, /素材长度/);
  bad(p, [{ type: 'addAudio', audio: { assetId: 'img' } }], {}, /没有声音/);
  bad(p, [{ type: 'updateAudio', audioId: 'a1', audio: { role: 'noise' } }], {}, /音频类型/);
});

test('setProject：画幅联动宽高、帧率范围', () => {
  const p = fixture();
  const r = ok(p, [{ type: 'setProject', settings: { aspect: '9:16', fps: 25 } }]);
  assert.deepEqual([r.project.settings.aspect, r.project.settings.width, r.project.settings.height, r.project.settings.fps], ['9:16', 1080, 1920, 25]);
  bad(p, [{ type: 'setProject', settings: { aspect: '3:2' } }], {}, /画幅/);
  bad(p, [{ type: 'setProject', settings: { fps: 240 } }], {}, /帧率/);
});

test('lock / unlock：锁定后其他修改被拒绝，解锁恢复', () => {
  const p = fixture();
  const locked = ok(p, [{ type: 'lock', target: idx(2) }]).project;
  assert.equal(locked.tracks.video[1].locked, true);
  bad(locked, [{ type: 'setColor', target: idx(2), color: { exposure: 0.1 }, relative: true }], {}, /第 2 镜已锁定/);
  bad(locked, [{ type: 'delete', target: idx(2) }], {}, /已锁定/);
  bad(locked, [{ type: 'split', target: idx(2), at: 6 }], {}, /已锁定/);
  bad(locked, [{ type: 'setColor', target: 'all', color: { exposure: 0.1 } }], {}, /已锁定/);
  const unlocked = ok(locked, [{ type: 'unlock', target: idx(2) }]).project;
  assert.equal(unlocked.tracks.video[1].locked, false);
  ok(unlocked, [{ type: 'delete', target: idx(2) }]);
});

test('matchColor / harmonize / applyPacing', () => {
  const p = fixture();
  const m = ok(p, [{ type: 'matchColor', target: idx(1), reference: { luma: 0.6, contrast: 0.4, saturation: 0.4, warmth: 0, tint: 0 } }]).project;
  assert.equal(m.tracks.video[0].color.exposure, 1);
  bad(p, [{ type: 'matchColor', target: idx(1), reference: {} }], {}, /参考色彩/);
  const noStats = ok(p, [{ type: 'insertAsset', assetId: 'img' }]).project;
  bad(noStats, [{ type: 'matchColor', target: idx(4), reference: { luma: 0.5 } }], {}, /色彩数据/);

  const h = ok(p, [{ type: 'harmonize' }]);
  const exps = h.project.tracks.video.map((c) => c.color.exposure);
  assert.ok(exps[0] > 0, '偏暗的镜头被提亮');
  assert.ok(exps[1] < 0, '偏亮的镜头被压暗');
  const hn = ok(noStats, [{ type: 'harmonize', target: 'all' }]);
  assert.ok(hn.applied.some((t) => /跳过/.test(t)));

  const fast = ok(p, [{ type: 'applyPacing', pacing: 'fast' }]).project;
  assert.ok(layoutVideo(fast).every((it) => Math.abs(it.duration - 2.8) < 1e-6));
  const list = ok(p, [{ type: 'applyPacing', target: idx(1, 2), durations: [2, 3] }]).project;
  assert.deepEqual(layoutVideo(list).map((it) => it.duration), [2, 3, 4]);
  bad(p, [{ type: 'applyPacing', target: idx(1, 2), durations: [2] }], {}, /时长表/);
  bad(p, [{ type: 'applyPacing', pacing: 'turbo' }], {}, /节奏/);
});

test('原子性：任一操作失败则全部不生效，并收集所有错误', () => {
  const p = fixture();
  const r = bad(p, [
    { type: 'setColor', target: idx(1), color: { exposure: 0.2 } },
    { type: 'setSpeed', target: idx(9), speed: 2 },
    { type: 'setLook', target: idx(1), look: 'unknown' },
  ], {});
  assert.equal(r.errors.length, 2);
  assert.match(r.errors[0], /第9镜不存在/);
  assert.equal(p.tracks.video[0].color.exposure, 0);
});

test('入参不被修改（深冻结的项目也能正常处理）', () => {
  const p = fixture();
  const snapshot = JSON.stringify(p);
  const all = [
    { type: 'setColor', target: 'all', color: { exposure: 0.1 }, relative: true },
    { type: 'split', target: idx(1), at: 2 },
    { type: 'duplicate', target: idx(2) },
    { type: 'move', target: idx(1), toIndex: 3 },
    { type: 'addText', text: '新的' },
    { type: 'updateAudio', audioId: 'a1', audio: { volume: 0.5 } },
    { type: 'setProject', settings: { aspect: '1:1' } },
  ];
  ok(p, all, { playhead: 1 });
  assert.equal(JSON.stringify(p), snapshot);
});

test('目标解析：selected / range / ids / all / 缺省', () => {
  const p = fixture();
  assert.deepEqual(resolveTargets(p, { mode: 'selected' }, { selectedClipIds: ['c3', 'c1'] }), [0, 2]);
  assert.deepEqual(resolveTargets(p, { mode: 'range' }, { range: { start: 3.5, end: 4.5 } }), [0, 1]);
  assert.deepEqual(resolveTargets(p, { mode: 'ids', ids: ['c2'] }, {}), [1]);
  assert.deepEqual(resolveTargets(p, 'all', {}), [0, 1, 2]);
  assert.deepEqual(resolveTargets(p, { mode: 'none' }, {}), []);
  assert.throws(() => resolveTargets(p, { mode: 'ids', ids: ['x'] }, {}), /找不到镜头/);
  assert.throws(() => resolveTargets(p, { mode: 'index', indices: [0] }, {}), /不存在/);
  bad(p, [{ type: 'setLook', look: 'bw' }], {}, /请先选中/);
  const sel = ok(p, [{ type: 'setLook', look: 'bw' }], { selectedClipIds: ['c2'] }).project;
  assert.equal(sel.tracks.video[1].color.look, 'bw');
  assert.equal(sel.tracks.video[0].color.look, 'none');
  bad(p, [{ type: 'setLook', target: 'range', look: 'bw' }], {}, /框选/);
});

test('批次语义：index 指向前一条执行后的主轨；range 在批次开始时固定', () => {
  const p = fixture();
  const r = ok(p, [
    { type: 'delete', target: idx(1) },
    { type: 'setLook', target: idx(1), look: 'bw' },
  ]);
  assert.equal(r.project.tracks.video[0].id, 'c2');
  assert.equal(r.project.tracks.video[0].color.look, 'bw');

  const range = ok(p, [
    { type: 'setSpeed', target: 'range', speed: 0.5 },
    { type: 'setLook', target: 'range', look: 'vivid' },
  ], { range: { start: 0, end: 3 } }).project;
  assert.equal(range.tracks.video[0].color.look, 'vivid');
  assert.equal(range.tracks.video[1].color.look, 'none', '变速后范围内的镜头不漂移');
});

test('第一镜规则：移动后不合法的入场改为硬切', () => {
  const p = fixture();
  const r = ok(p, [
    { type: 'setTransition', target: idx(3), transition: { type: 'whip-pan', duration: 0.3 } },
    { type: 'move', target: idx(3), toIndex: 1 },
  ]);
  assert.equal(r.project.tracks.video[0].id, 'c3');
  assert.equal(r.project.tracks.video[0].transitionIn.type, 'cut');
  assert.ok(r.applied.some((t) => /硬切/.test(t)));
});

test('上限：超过 600 秒或 200 镜的操作被拒绝', () => {
  const p = fixture({ freeze: false });
  const img = p.assets.img;
  p.tracks.video = Array.from({ length: LIMITS.maxClips }, (_, i) => createClip(img, { id: `x${i}`, in: 0, out: 1 }));
  deepFreeze(p);
  bad(p, [{ type: 'duplicate', target: idx(1) }], {}, /200/);
  bad(p, [{ type: 'setDuration', target: idx(1), duration: 500 }], {}, /600/);
});

test('describeOp：中文描述', () => {
  const p = fixture();
  assert.equal(describeOp({ type: 'setColor', target: idx(2), color: { temperature: 0.3 }, relative: true }), '第2镜：色温 +0.3');
  assert.match(describeOp({ type: 'setTransition', target: idx(1, 2, 3), transition: { type: 'crossfade', duration: 0.5 } }), /第1–3镜：入场转场 叠化 0.5 秒/);
  assert.match(describeOp({ type: 'move', target: { mode: 'ids', ids: ['c3'] }, toIndex: 1 }, p), /第3镜：移到第 1 位/);
  assert.match(describeOp({ type: 'addText', text: { text: '你好' } }), /添加文字「你好」/);
  assert.match(describeOp({ type: 'harmonize' }), /全部镜头/);
  assert.match(describeOp({ type: 'boom' }), /未知操作/);
  assert.equal(describeOp(null), '无效操作');
});


// ---------------------------------------------------------------------------
// v3 扩展操作（PLAN-v3 §3）
// ---------------------------------------------------------------------------
import { EXT_OPS } from '../src/engine/ops.js';
import { clipDuration, overlaysAt } from '../src/engine/timeline.js';

function fx3({ beats } = {}) {
  const p = fixture({ freeze: false });
  p.assets.v1.hasAudio = true;
  p.assets.v2.hasAudio = true;
  if (beats) p.assets.m.beats = beats;
  return deepFreeze(p);
}

test('EXT_OPS 都在 OP_TYPES 内，且都有中文描述', () => {
  const p = fx3();
  for (const t of EXT_OPS) {
    assert.ok(OP_TYPES.includes(t), t);
    const d = describeOp({ type: t, id: 'c1', ids: ['c1'], toIds: ['c2'], patch: {}, track: 'video', segments: [], at: 1, t: 1, delta: 1 }, p);
    assert.ok(d && !/未知操作/.test(d), `${t} → ${d}`);
  }
});

test('setClipProps：倒放/镜像/裁切/混合/蒙版/静音；非法值报错', () => {
  const p = fx3();
  const r = ok(p, [{ type: 'setClipProps', id: 'c2', patch: { reverse: true, mirror: { h: true }, crop: { l: 0.1 }, blend: 'screen', opacity: 0.5, muted: true, fit: 'contain', mask: { shape: 'circle' }, canvas: { type: 'blur' } } }]);
  const c = r.project.tracks.video[1];
  assert.equal(c.reverse, true);
  assert.deepEqual(c.mirror, { h: true, v: false });
  assert.equal(c.crop.l, 0.1);
  assert.equal(c.blend, 'screen');
  assert.equal(c.mute, true);
  assert.equal(c.mask.shape, 'circle');
  assert.match(r.applied[0], /第2镜：倒放/);
  const cleared = ok(r.project, [{ type: 'setClipProps', id: 'c2', patch: { mask: null } }]);
  assert.equal(cleared.project.tracks.video[1].mask, null);
  bad(p, [{ type: 'setClipProps', id: 'c2', patch: { opacity: 2 } }], {}, /不透明度/);
  bad(p, [{ type: 'setClipProps', id: 'c2', patch: { blend: 'xx' } }], {}, /混合模式/);
  bad(p, [{ type: 'setClipProps', id: 'c2', patch: { crop: { l: 0.9 } } }], {}, /裁切/);
  // 也支持 target（所选镜头）
  const sel = ok(p, [{ type: 'setClipProps', patch: { reverse: true } }], { selectedClipIds: ['c3'] });
  assert.equal(sel.project.tracks.video[2].reverse, true);
});

test('freezeFrame：在播放头分割并插入定格片段，后续轨道内容后移', () => {
  const p = fx3();
  const r = ok(p, [{ type: 'freezeFrame', duration: 1.5 }], { playhead: 6 });
  const v = r.project.tracks.video;
  assert.equal(v.length, 5);
  assert.equal(v[2].still, true);
  assert.equal(v[2].in, v[2].out);
  assert.equal(v[2].in, 3, '第2镜 2 秒处 → 源 3 秒');
  assert.equal(clipDuration(v[2]), 1.5);
  assert.equal(v[1].out, 3);
  assert.equal(v[3].in, 3);
  assert.equal(projectDuration(r.project), projectDuration(p) + 1.5);
  assert.match(r.applied[0], /定格 1\.5 秒/);
  // 播放头在镜头开头 → 直接插在前面
  const head = ok(p, [{ type: 'freezeFrame', at: 0 }]);
  assert.equal(head.project.tracks.video[0].still, true);
  assert.equal(head.project.tracks.video.length, 4);
});

test('setSpeedCurve：预设 / 自定义 / 取消；setSpeed 清除曲线', () => {
  const p = fx3();
  const r = ok(p, [{ type: 'setSpeedCurve', id: 'c1', preset: 'bullet' }]);
  assert.ok(Array.isArray(r.project.tracks.video[0].speedCurve));
  assert.notEqual(clipDuration(r.project.tracks.video[0]), 4);
  const custom = ok(p, [{ type: 'setSpeedCurve', id: 'c1', curve: [{ t: 0, v: 2 }, { t: 1, v: 2 }] }]);
  assert.equal(clipDuration(custom.project.tracks.video[0]), 2);
  const off = ok(custom.project, [{ type: 'setSpeedCurve', id: 'c1', curve: null }]);
  assert.equal(off.project.tracks.video[0].speedCurve, null);
  const sp = ok(custom.project, [{ type: 'setSpeed', target: idx(1), speed: 0.1 }]);
  assert.equal(sp.project.tracks.video[0].speedCurve, null);
  assert.equal(clipDuration(sp.project.tracks.video[0]), 40);
  bad(p, [{ type: 'setSpeedCurve', id: 'c1', preset: 'nope' }], {}, /预设/);
  bad(p, [{ type: 'setSpeedCurve', id: 'c1', curve: [{ t: 0, v: 20 }, { t: 1, v: 1 }] }], {}, /曲线速度/);
});

test('setKeyframe / removeKeyframe：镜头、画中画、音频', () => {
  const p = fx3();
  let r = ok(p, [
    { type: 'setKeyframe', target: 'clip', id: 'c1', path: 'transform.scale', t: 0, v: 1 },
    { type: 'setKeyframe', target: 'clip', id: 'c1', path: 'transform.scale', t: 2, v: 1.5, ease: 'ease' },
  ]);
  assert.deepEqual(r.project.tracks.video[0].keys['transform.scale'].map((k) => k.v), [1, 1.5]);
  assert.match(r.applied[1], /缩放关键帧/);
  r = ok(r.project, [{ type: 'removeKeyframe', target: 'clip', id: 'c1', path: 'transform.scale', t: 2 }]);
  assert.equal(r.project.tracks.video[0].keys['transform.scale'].length, 1);
  bad(p, [{ type: 'setKeyframe', target: 'clip', id: 'c1', path: 'opacity', t: 9, v: 1 }], {}, /超出/);
  bad(p, [{ type: 'setKeyframe', target: 'clip', id: 'c1', path: 'opacity', t: 1, v: 3 }], {}, /不透明度/);
  bad(p, [{ type: 'setKeyframe', target: 'clip', id: 'c1', path: 'bogus', t: 1, v: 1 }], {}, /不能设置关键帧/);
  bad(p, [{ type: 'removeKeyframe', target: 'clip', id: 'c1', path: 'opacity', t: 1 }], {}, /没有关键帧/);
  const a = ok(p, [{ type: 'setKeyframe', target: 'audio', id: 'a1', path: 'volume', t: 1, v: 0.5 }]);
  assert.deepEqual(a.project.tracks.audio[0].volumeKeys, [{ t: 1, v: 0.5 }]);
  const o = ok(p, [{ type: 'addOverlay', assetId: 'img', start: 0, track: 2, overlayId: 'ov' }, { type: 'setKeyframe', target: 'overlay', id: 'ov', path: 'opacity', t: 1, v: 0 }]);
  assert.equal(o.project.overlays[0].keys.opacity[0].v, 0);
});

test('roll / slip / slide / rippleDelete / trimLeft / trimRight 操作', () => {
  const p = fx3();
  const roll = ok(p, [{ type: 'roll', at: 4, delta: 1 }]);
  assert.equal(roll.project.tracks.video[0].out, 6);
  assert.equal(roll.project.tracks.video[1].in, 2);
  const slip = ok(p, [{ type: 'slip', id: 'c2', delta: -1 }]);
  assert.deepEqual([slip.project.tracks.video[1].in, slip.project.tracks.video[1].out], [0, 4]);
  const clamp = ok(p, [{ type: 'slip', id: 'c2', delta: -5 }]);
  assert.match(clamp.applied[0], /实际内滑 -1 秒/);
  const slide = ok(p, [{ type: 'slide', id: 'c2', delta: -1 }]);
  assert.equal(layoutVideo(slide.project)[1].start, 3);
  const rd = ok(p, [{ type: 'rippleDelete', ids: ['c1'] }]);
  assert.deepEqual(ids(rd.project), ['c2', 'c3']);
  const q = ok(p, [{ type: 'trimLeft' }], { playhead: 5 });
  assert.equal(q.project.tracks.video[1].in, 2);
  assert.match(q.applied[0], /Q/);
  const w = ok(p, [{ type: 'trimRight', at: 5 }]);
  assert.equal(w.project.tracks.video[1].out, 2);
  bad(p, [{ type: 'slide', id: 'c1', delta: 1 }], {}, /相邻/);
  bad(p, [{ type: 'trimLeft', at: 4 }], {}, /不在任何镜头内部/);
  bad(p, [{ type: 'rippleDelete', ids: [] }], {}, /选中/);
});

test('画中画：添加 / 修改 / 删除，轨道锁定阻止修改', () => {
  const p = fx3();
  let r = ok(p, [{ type: 'addOverlay', assetId: 'img', track: 3, overlayId: 'ov' }], { playhead: 2 });
  assert.equal(r.project.overlays[0].start, 2);
  assert.equal(r.project.overlays[0].track, 3);
  assert.equal(overlaysAt(r.project, 3).length, 1);
  r = ok(r.project, [{ type: 'updateOverlay', id: 'ov', patch: { opacity: 0.4, transform: { x: 0.3 }, blend: 'multiply' } }]);
  assert.equal(r.project.overlays[0].opacity, 0.4);
  assert.equal(r.project.overlays[0].transform.x, 0.3);
  assert.equal(r.project.overlays[0].transform.scale, 0.5, '未改的变换保留');
  const locked = ok(r.project, [{ type: 'setTrack', track: 'overlay3', patch: { locked: true } }]);
  assert.equal(locked.project.trackState.overlay[3].locked, true);
  bad(locked.project, [{ type: 'updateOverlay', id: 'ov', patch: { opacity: 1 } }], {}, /已锁定/);
  r = ok(r.project, [{ type: 'removeOverlay', id: 'ov' }]);
  assert.equal(r.project.overlays.length, 0);
  bad(p, [{ type: 'addOverlay', assetId: 'm' }], {}, /音频/);
  bad(p, [{ type: 'addOverlay', assetId: 'img', track: 9 }], {}, /1–4/);
});

test('setTrack：主轨锁定后 Q/W/roll 被拒绝', () => {
  const p = fx3();
  const r = ok(p, [{ type: 'setTrack', track: 'video', patch: { locked: true, hidden: false } }]);
  assert.equal(r.project.trackState.video.locked, true);
  assert.match(r.applied[0], /主轨：锁定/);
  bad(r.project, [{ type: 'trimLeft', at: 5 }], {}, /主轨已锁定/);
  bad(p, [{ type: 'setTrack', track: 'nope', patch: { locked: true } }], {}, /不存在/);
});

test('标记：添加（默认播放头）/ 修改 / 删除', () => {
  const p = fx3();
  let r = ok(p, [{ type: 'addMarker', label: '高潮', markerId: 'mk' }, { type: 'addMarker', t: 1 }], { playhead: 3 });
  assert.deepEqual(r.project.markers.map((m) => m.t), [1, 3]);
  assert.match(r.applied[0], /高潮/);
  r = ok(r.project, [{ type: 'updateMarker', id: 'mk', patch: { t: 0.5 } }]);
  assert.equal(r.project.markers[0].id, 'mk');
  r = ok(r.project, [{ type: 'removeMarker', id: 'mk' }]);
  assert.equal(r.project.markers.length, 1);
});

test('字幕：addCaptions 替换旧字幕且保留样式 / updateCaptionStyle / clearCaptions', () => {
  const p = fx3();
  const segs = [{ start: 0, end: 1.5, text: '你好' }, { start: 1.5, end: 3, text: '世界' }, { start: 3, end: 3.01, text: '太短' }];
  let r = ok(p, [{ type: 'addCaptions', segments: segs }]);
  const caps = r.project.tracks.text.filter((t) => t.group === 'caption');
  assert.equal(caps.length, 2);
  assert.equal(r.project.tracks.text.length, 3, '普通文字保留');
  r = ok(r.project, [{ type: 'updateCaptionStyle', patch: { color: '#ffcc00', size: 1.2 } }]);
  assert.ok(r.project.tracks.text.filter((t) => t.group === 'caption').every((t) => t.color === '#ffcc00'));
  r = ok(r.project, [{ type: 'addCaptions', segments: [{ start: 0, end: 2, text: '重新识别' }] }]);
  const again = r.project.tracks.text.filter((t) => t.group === 'caption');
  assert.equal(again.length, 1);
  assert.equal(again[0].color, '#ffcc00', '重新识别保留样式');
  r = ok(r.project, [{ type: 'clearCaptions' }]);
  assert.equal(r.project.tracks.text.length, 1);
  bad(r.project, [{ type: 'clearCaptions' }], {}, /还没有字幕/);
  bad(p, [{ type: 'addCaptions', segments: [] }], {}, /字幕/);
});

test('autoDuck / detachAudio', () => {
  const p = fx3();
  const d = ok(p, [{ type: 'detachAudio', id: 'c2' }]);
  assert.equal(d.project.tracks.video[1].mute, true);
  const det = d.project.tracks.audio.find((a) => a.linkedClipId === 'c2');
  assert.equal(det.start, 4);
  assert.deepEqual([det.in, det.out, det.role], [1, 5, 'voice']);
  const duck = ok(d.project, [{ type: 'autoDuck', amount: 0.2 }]);
  const keys = duck.project.tracks.audio.find((a) => a.id === 'a1').volumeKeys;
  assert.ok(keys.some((k) => k.v === 0.2 && k.t === 4));
  const sp = ok(p, [{ type: 'setSpeed', target: idx(1), speed: 2 }]);
  bad(sp.project, [{ type: 'detachAudio', id: 'c1' }], {}, /变速/);
  const img = ok(p, [{ type: 'insertAsset', assetId: 'img' }]);
  bad(img.project, [{ type: 'detachAudio', id: img.project.tracks.video[3].id }], {}, /没有原声/);
});

test('snapCutsToBeats：剪辑点吸到最近节拍；无节拍报错', () => {
  const p = fx3({ beats: [3.5, 8.5] });
  const r = ok(p, [{ type: 'snapCutsToBeats', assetId: 'm' }]);
  const L = layoutVideo(r.project);
  assert.equal(L[1].start, 3.5);
  assert.equal(L[2].start, 8.5);
  assert.match(r.applied[0], /已对齐 2 个剪辑点/);
  bad(fx3(), [{ type: 'snapCutsToBeats', assetId: 'm' }], {}, /节拍/);
});

test('setTransitionAll：第一镜不支持的转场保持不变，锁定镜头跳过', () => {
  const p = fx3();
  const r = ok(p, [{ type: 'setTransitionAll', transition: 'slide-left', duration: 0.4 }]);
  assert.equal(r.project.tracks.video[0].transitionIn.type, 'cut');
  assert.deepEqual(r.project.tracks.video[2].transitionIn, { type: 'slide-left', duration: 0.4 });
  assert.match(r.applied[0], /全部转场改为向左推/);
  const all = ok(p, [{ type: 'setTransitionAll', transitionType: 'crossfade' }]);
  assert.equal(all.project.tracks.video[0].transitionIn.type, 'crossfade');
  bad(p, [{ type: 'setTransitionAll', transition: 'nope' }], {}, /转场/);
});

test('pasteAttributes：复制指定属性，深拷贝，不粘贴给自己', () => {
  const p = fx3();
  const src = ok(p, [{ type: 'setColor', target: idx(1), color: { exposure: 0.4 } }, { type: 'setClipProps', id: 'c1', patch: { mirror: { h: true } } }]).project;
  const r = ok(src, [{ type: 'pasteAttributes', from: 'c1', toIds: ['c2', 'c3', 'c1'], keys: ['color', 'mirror'] }]);
  assert.equal(r.project.tracks.video[1].color.exposure, 0.4);
  assert.equal(r.project.tracks.video[2].mirror.h, true);
  assert.notEqual(r.project.tracks.video[1].color, r.project.tracks.video[0].color);
  assert.match(r.applied[0], /粘贴调色、镜像到 3 个镜头/);
  bad(src, [{ type: 'pasteAttributes', from: 'c1', toIds: ['c1'] }], {}, /自己/);
  bad(src, [{ type: 'pasteAttributes', from: 'c1', toIds: ['c2'], keys: ['id'] }], {}, /属性/);
});

test('split：曲线变速与倒放镜头分割后源时间连续', () => {
  const p = fx3();
  const rv = ok(p, [{ type: 'setClipProps', id: 'c1', patch: { reverse: true } }, { type: 'split', target: idx(1), at: 1 }]).project;
  assert.deepEqual([rv.tracks.video[0].in, rv.tracks.video[0].out], [4, 5]);
  assert.deepEqual([rv.tracks.video[1].in, rv.tracks.video[1].out], [1, 4]);
});
