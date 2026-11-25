// 联动：分割镜头拆分跨点文字；关联音频随镜头裁剪
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps } from '../src/engine/ops.js';
import { layoutVideo } from '../src/engine/timeline.js';
import { createProject, createAsset, createClip, createTextClip, createAudioClip } from '../src/engine/model.js';

function proj({ linked = true } = {}) {
  const p = createProject({ name: '分割', aspect: '16:9' });
  const v = createAsset({ id: 'v', kind: 'video', name: 'v', duration: 30 });
  const vo = createAsset({ id: 'vo', kind: 'audio', name: 'vo', duration: 30 });
  p.assets = { v, vo };
  const c1 = createClip(v, { id: 'c1', in: 2, out: 8 });
  const c2 = createClip(v, { id: 'c2', in: 10, out: 14 });
  p.tracks = {
    ...p.tracks,
    video: [c1, c2],
    text: [createTextClip({ id: 't1', start: 0, duration: 6, text: '跨点', linkShotId: 'c1' }), createTextClip({ id: 't2', start: 6, duration: 4, linkShotId: 'c2' })],
    audio: [createAudioClip(vo, { id: 'a1', start: 0, in: 0, out: 6, linkClipId: 'c1' })],
  };
  p.timeline = { ...(p.timeline || {}), linked };
  return p;
}
const ids = (o) => ({ mode: 'ids', indices: [], ids: [o] });
const near = (a, b) => Math.abs(a - b) < 0.011;

test('分割镜头：跨分割点的关联文字拆成两条，右半关联新镜头', () => {
  const r = applyOps(proj(), [{ type: 'split', target: ids('c1'), at: 2.5 }]);
  assert.ok(r.ok, r.errors.join());
  const [l, rt] = r.project.tracks.video;
  assert.equal(l.id, 'c1');
  const texts = r.project.tracks.text.filter((t) => t.text === '跨点');
  assert.equal(texts.length, 2);
  const a = texts.find((t) => t.linkShotId === 'c1');
  const b = texts.find((t) => t.linkShotId === rt.id);
  assert.ok(a && b);
  assert.ok(near(a.start, 0) && near(a.duration, 2.5));
  assert.ok(near(b.start, 2.5) && near(b.duration, 3.5));
  assert.notEqual(a.id, b.id);
  // 不跨点的文字不受影响
  assert.equal(r.project.tracks.text.filter((t) => t.linkShotId === 'c2').length, 1);
  // 关联音频跟着拆成两段：内容连续、总长不变，右半跟随新镜头
  const [al, ar] = r.project.tracks.audio;
  assert.equal(r.project.tracks.audio.length, 2);
  assert.equal(al.id, 'a1');
  assert.ok(near(al.start, 0) && near(al.in, 0) && near(al.out, 2.5), JSON.stringify(al));
  assert.ok(near(ar.start, 2.5) && near(ar.in, 2.5) && near(ar.out, 6), JSON.stringify(ar));
  assert.equal(al.linkClipId, 'c1');
  assert.equal(ar.linkClipId, rt.id);
  assert.notEqual(ar.id, al.id);
  assert.equal(al.fadeOut, 0);
  assert.equal(ar.fadeIn, 0);
});

test('分割后删除左半：右半的字幕和声音留下并前移；删除右半：只删右半的', () => {
  const s = applyOps(proj(), [{ type: 'split', target: ids('c1'), at: 2.5 }]);
  assert.ok(s.ok, s.errors.join());
  const rt = s.project.tracks.video[1];

  const dl = applyOps(s.project, [{ type: 'delete', target: ids('c1') }]);
  assert.ok(dl.ok, dl.errors.join());
  const kept = dl.project.tracks.text.filter((t) => t.text === '跨点');
  assert.equal(kept.length, 1);
  assert.equal(kept[0].linkShotId, rt.id);
  assert.ok(near(kept[0].start, 0) && near(kept[0].duration, 3.5), JSON.stringify(kept[0]));
  assert.equal(dl.project.tracks.audio.length, 1);
  const au = dl.project.tracks.audio[0];
  assert.ok(near(au.start, 0) && near(au.in, 2.5) && near(au.out, 6), JSON.stringify(au));

  const dr = applyOps(s.project, [{ type: 'delete', target: ids(rt.id) }]);
  assert.ok(dr.ok, dr.errors.join());
  assert.equal(dr.project.tracks.audio.length, 1);
  const al = dr.project.tracks.audio[0];
  assert.ok(near(al.start, 0) && near(al.in, 0) && near(al.out, 2.5), JSON.stringify(al));
  const lt = dr.project.tracks.text.filter((t) => t.text === '跨点');
  assert.equal(lt.length, 1);
  assert.ok(near(lt[0].duration, 2.5));
});

test('分割：整段落在右半的文字和音频改为跟随右半；音量关键帧在分割点接上；锁定的不动', () => {
  const p = proj();
  p.tracks.text.push(createTextClip({ id: 'tR', start: 4, duration: 1.5, text: '右半', linkShotId: 'c1' }));
  p.tracks.text.push(createTextClip({ id: 'tLock', start: 1, duration: 4, text: '锁', linkShotId: 'c1', locked: true }));
  p.tracks.audio[0].volumeKeys = [{ t: 0, v: 1 }, { t: 5, v: 0 }];
  p.tracks.audio.push(createAudioClip(p.assets.vo, { id: 'aR', start: 3, in: 0, out: 2, linkedClipId: 'c1' }));
  const r = applyOps(p, [{ type: 'split', target: ids('c1'), at: 2.5 }]);
  assert.ok(r.ok, r.errors.join());
  const rt = r.project.tracks.video[1];
  assert.equal(r.project.tracks.text.find((t) => t.id === 'tR').linkShotId, rt.id);
  const lock = r.project.tracks.text.filter((t) => t.text === '锁');
  assert.equal(lock.length, 1);
  assert.equal(lock[0].duration, 4);
  assert.equal(r.project.tracks.audio.find((a) => a.id === 'aR').linkedClipId, rt.id);
  const al = r.project.tracks.audio.find((a) => a.id === 'a1');
  const ar = r.project.tracks.audio.find((a) => a.linkClipId === rt.id);
  assert.deepEqual(al.volumeKeys, [{ t: 0, v: 1 }, { t: 2.5, v: 0.5 }]);
  assert.deepEqual(ar.volumeKeys, [{ t: 0, v: 0.5 }, { t: 2.5, v: 0 }]);
  // 删除左半：右半的文字、两段音频都还在
  const dl = applyOps(r.project, [{ type: 'delete', target: ids('c1') }]);
  assert.ok(dl.ok, dl.errors.join());
  assert.ok(dl.project.tracks.text.some((t) => t.id === 'tR'));
  assert.ok(dl.project.tracks.audio.some((a) => a.id === 'aR'));
});

test('分割镜头：关闭联动时文字和音频都不拆', () => {
  const r = applyOps(proj({ linked: false }), [{ type: 'split', target: ids('c1'), at: 2.5 }]);
  assert.ok(r.ok, r.errors.join());
  assert.equal(r.project.tracks.text.length, 2);
  assert.equal(r.project.tracks.audio.length, 1);
});

test('关联音频随镜头尾部裁剪而裁剪', () => {
  const r = applyOps(proj(), [{ type: 'setDuration', target: ids('c1'), duration: 4 }]);
  assert.ok(r.ok, r.errors.join());
  const au = r.project.tracks.audio[0];
  assert.ok(near(au.start, 0), JSON.stringify(au));
  assert.ok(near(au.in, 0) && near(au.out, 4), JSON.stringify(au));
});

test('关联音频随镜头头部裁剪而裁剪（音频内容保持与画面同步）', () => {
  const p = proj();
  const r = applyOps(p, [{ type: 'trimLeft', target: ids('c1'), at: 1.5 }], { playhead: 1.5 });
  assert.ok(r.ok, r.errors.join());
  const it = layoutVideo(r.project)[0];
  assert.ok(near(it.end - it.start, 4.5));
  const au = r.project.tracks.audio[0];
  assert.ok(near(au.start, it.start), JSON.stringify(au));
  assert.ok(near(au.in, 1.5) && near(au.out, 6), JSON.stringify(au));
});

test('关闭联动时关联音频不随裁剪变化', () => {
  const r = applyOps(proj({ linked: false }), [{ type: 'setDuration', target: ids('c1'), duration: 4 }]);
  assert.ok(r.ok, r.errors.join());
  const au = r.project.tracks.audio[0];
  assert.ok(near(au.out - au.in, 6));
});
