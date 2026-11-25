// 工程版本迁移（src/engine/migrations.js）单元测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_VERSION, MIGRATIONS, migrateProject, loadProject } from '../src/engine/migrations.js';
import { PROJECT_VERSION, createProject, createAsset, createClip } from '../src/engine/model.js';

function v2ProjectWithCaptions() {
  const p = createProject({ name: '旧版工程' });
  p.version = 2;
  const a = createAsset({ id: 'a1', kind: 'video', name: '片段.mp4', duration: 10 });
  p.assets = { a1: a };
  p.tracks.video = [
    createClip(a, { id: 'c1', in: 0, out: 3, caption: { text: '开场白', style: 'subtitle', position: 'bottom' } }),
    createClip(a, { id: 'c2', in: 3, out: 6, caption: { text: '第二句', style: 'subtitle', position: 'bottom' } }),
  ];
  p.tracks.text = [];
  delete p.timeline;
  return p;
}

test('CURRENT_VERSION 与 PROJECT_VERSION 对齐且迁移表递增', () => {
  assert.equal(CURRENT_VERSION, PROJECT_VERSION);
  assert.ok(Array.isArray(MIGRATIONS) && MIGRATIONS.length >= 1);
  assert.equal(MIGRATIONS[MIGRATIONS.length - 1].to, CURRENT_VERSION);
});

test('migrateProject：v2 镜头文案迁入文字轨、不修改入参、具备幂等性', () => {
  const v2 = v2ProjectWithCaptions();
  const snap = JSON.stringify(v2);

  const r1 = migrateProject(v2);
  assert.equal(JSON.stringify(v2), snap, 'migrateProject 不得修改入参');
  assert.equal(r1.changed, true);
  assert.equal(r1.from, 2);
  assert.equal(r1.to, CURRENT_VERSION);
  assert.equal(r1.project.version, CURRENT_VERSION);
  assert.equal(r1.project.timeline.captionsMigrated, true);
  assert.equal(r1.project.tracks.text.length, 2);
  assert.deepEqual(r1.project.tracks.text.map((t) => t.text), ['开场白', '第二句']);
  assert.ok(r1.notes.some((n) => n.includes('2 条镜头文案')));

  // 幂等性：再次迁移不再重复执行
  const r2 = migrateProject(r1.project);
  assert.equal(r2.changed, false);
  assert.equal(r2.project, r1.project);
  assert.deepEqual(r2.notes, []);

  // 用户删掉迁移后的字幕再重开，字幕不得复活
  const deleted = { ...r1.project, tracks: { ...r1.project.tracks, text: [] } };
  const r3 = migrateProject(deleted);
  assert.equal(r3.changed, false);
  assert.equal(r3.project.tracks.text.length, 0);
});

test('migrateProject：未来版本不降级，非法输入安全返回', () => {
  const future = { ...createProject({ name: '新版' }), version: CURRENT_VERSION + 5 };
  const rf = migrateProject(future);
  assert.equal(rf.changed, false);
  assert.equal(rf.from, CURRENT_VERSION + 5);
  assert.equal(rf.to, CURRENT_VERSION + 5);
  assert.equal(rf.project.version, CURRENT_VERSION + 5);

  const bad = migrateProject(null);
  assert.equal(bad.changed, false);
  assert.equal(bad.project, null);
  assert.deepEqual(bad.notes, []);
});

test('loadProject：先规范化再迁移，并对缺失素材生成修复提示', () => {
  const raw = {
    version: 2,
    name: '缺素材的旧工程',
    assets: { a1: { id: 'a1', kind: 'video', name: '存在.mp4', duration: 8 } },
    tracks: {
      video: [
        { id: 'c1', assetId: 'a1', in: 0, out: 3, mute: true, caption: { text: '你好' } },
        { id: 'c2', assetId: 'ast_missing_video', in: 0, out: 3 },
      ],
      text: [],
      audio: [],
    },
    overlays: [{ id: 'ov1', assetId: 'ast_missing_ov', track: 1, start: 0, in: 0, out: 2 }],
  };
  const loaded = loadProject(raw);
  assert.equal(loaded.migrated, true);
  assert.equal(loaded.project.version, CURRENT_VERSION);
  assert.equal(loaded.project.tracks.video[0].muted, true);
  assert.equal(loaded.project.tracks.text.length, 1);
  assert.equal(loaded.project.tracks.text[0].text, '你好');
  assert.ok(loaded.project.assets.ast_missing_video && loaded.project.assets.ast_missing_video.missing === true);
  assert.ok(loaded.project.assets.ast_missing_ov && loaded.project.assets.ast_missing_ov.missing === true);
  assert.equal(loaded.repairs.length, 1);
  assert.match(loaded.repairs[0], /2 个片段找不到素材记录/);
  assert.ok(loaded.notes.length >= 1);

  // 已迁移的干净工程再次 loadProject 不再标记 migrated，也无修复提示
  const clean = createProject({ name: '干净工程' });
  const reloaded = loadProject(clean);
  assert.equal(reloaded.migrated, false);
  assert.deepEqual(reloaded.repairs, []);
  assert.deepEqual(reloaded.notes, []);
});
