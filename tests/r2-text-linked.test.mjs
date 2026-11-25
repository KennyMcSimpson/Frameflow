// R2 工作包 A：初剪文案生成文字轨 + 主轨联动文字/音频
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFirstCut, migrateShotCaptions } from '../src/engine/firstcut.js';
import { applyOps } from '../src/engine/ops.js';
import { layoutVideo } from '../src/engine/timeline.js';
import { createProject, createShot, createAsset, createAudioClip, normalizeProject } from '../src/engine/model.js';

function base() {
  const p = createProject({ name: '联动', aspect: '16:9' });
  p.storyboard = [
    createShot({ id: 's1', index: 1, title: 'A', duration: 4, caption: '第一句' }),
    createShot({ id: 's2', index: 2, title: 'B', duration: 3, caption: '' }),
    createShot({ id: 's3', index: 3, title: 'C', duration: 5, caption: '第三句' }),
  ];
  return buildFirstCut(p).project;
}
const ids = (p) => p.tracks.video.map((c) => c.id);
const cap = (p, clipId) => p.tracks.text.find((t) => t.linkShotId === clipId);

test('初剪为有文案的镜头生成对齐的 shot-caption 文字', () => {
  const p = base();
  const layout = layoutVideo(p);
  assert.equal(p.tracks.text.length, 2);
  for (const t of p.tracks.text) {
    assert.equal(t.source, 'shot-caption');
    const it = layout.find((x) => x.clip.id === t.linkShotId);
    assert.ok(it);
    assert.ok(Math.abs(t.start - it.start) < 0.02 && Math.abs(t.start + t.duration - it.end) < 0.02);
  }
  assert.equal(cap(p, ids(p)[0]).text, '第一句');
  // 重新初剪不重复生成
  const again = buildFirstCut(p).project;
  assert.equal(again.tracks.text.filter((t) => t.source === 'shot-caption').length, 2);
  // 经过 normalize 仍保留关联字段
  const n = normalizeProject(p);
  assert.equal(n.tracks.text[0].source, 'shot-caption');
  assert.ok(n.tracks.text[0].linkShotId);
});

test('旧工程迁移：文字轨为空才生成一次', () => {
  const p = base();
  // 初剪本身会标记 captionsMigrated；模拟第 3 版之前没有这个标记的旧工程
  assert.equal(p.timeline.captionsMigrated, true);
  const old = { ...p, timeline: {}, tracks: { ...p.tracks, text: [] } };
  const m = migrateShotCaptions(old);
  assert.equal(m.tracks.text.length, 2);
  assert.equal(m.timeline.captionsMigrated, true);
  assert.equal(migrateShotCaptions({ ...m, tracks: { ...m.tracks, text: [] } }).tracks.text.length, 0);
  assert.equal(migrateShotCaptions(p), p);
  // 初剪后删光字幕，再打开也不会复活
  const cleared = { ...p, tracks: { ...p.tracks, text: [] } };
  assert.equal(migrateShotCaptions(cleared), cleared);
});

test('联动：删除镜头一并删除其文字与关联音频，后续文字随之前移', () => {
  let p = base();
  const [c1, , c3] = ids(p);
  p = { ...p, assets: { ...p.assets, vo: createAsset({ id: 'vo', kind: 'audio', name: 'vo', duration: 10 }) } };
  p.tracks = { ...p.tracks, audio: [createAudioClip(p.assets.vo, { id: 'a1', start: 0, out: 4, linkClipId: c1 })] };
  const r = applyOps(p, [{ type: 'delete', target: { mode: 'ids', indices: [], ids: [c1] } }]);
  assert.ok(r.ok, r.errors.join());
  assert.equal(cap(r.project, c1), undefined);
  assert.equal(r.project.tracks.audio.length, 0);
  const it3 = layoutVideo(r.project).find((x) => x.clip.id === c3);
  assert.ok(Math.abs(cap(r.project, c3).start - it3.start) < 0.02);
});

test('联动：移动镜头文字跟随；关闭联动则不跟随', () => {
  const p = base();
  const [c1, , c3] = ids(p);
  const mv = [{ type: 'move', target: { mode: 'ids', indices: [], ids: [c3] }, toIndex: 1 }];
  const r = applyOps(p, mv);
  assert.ok(r.ok, r.errors.join());
  const it = layoutVideo(r.project).find((x) => x.clip.id === c3);
  assert.ok(Math.abs(cap(r.project, c3).start - it.start) < 0.02);
  assert.ok(Math.abs(cap(r.project, c1).start - layoutVideo(r.project).find((x) => x.clip.id === c1).start) < 0.02);

  const off = applyOps(p, [{ type: 'setProject', target: { mode: 'none', indices: [], ids: [] }, settings: { linked: false } }]);
  assert.ok(off.ok, off.errors.join());
  assert.equal(off.project.timeline.linked, false);
  const r2 = applyOps(off.project, mv);
  assert.ok(r2.ok, r2.errors.join());
  assert.equal(cap(r2.project, c3).start, cap(p, c3).start);
  const d = applyOps(off.project, [{ type: 'delete', target: { mode: 'ids', indices: [], ids: [c1] } }]);
  assert.ok(cap(d.project, c1));
});

test('联动：裁剪镜头时对齐的文字随之调整时长', () => {
  const p = base();
  const [c1] = ids(p);
  const r = applyOps(p, [{ type: 'setDuration', target: { mode: 'ids', indices: [], ids: [c1] }, duration: 2 }]);
  assert.ok(r.ok, r.errors.join());
  const it = layoutVideo(r.project)[0];
  const t = cap(r.project, c1);
  assert.ok(Math.abs(t.start + t.duration - it.end) < 0.02);
});
