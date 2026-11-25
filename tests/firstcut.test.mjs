// firstcut.js 单元测试：按分镜生成初剪、素材匹配、预演资产、报告
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFirstCut, makePrevizAsset } from '../src/engine/firstcut.js';
import { applyOps } from '../src/engine/ops.js';
import { layoutVideo } from '../src/engine/timeline.js';
import {
  createProject, createAsset, createBrief, createShot, createPrevizSpec, createTextClip, normalizeProject,
} from '../src/engine/model.js';

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** 类似 createSampleProject 的手工数据：咖啡店 4 个分镜 */
function sampleProject() {
  const p = createProject({ name: '咖啡店', aspect: '16:9' });
  p.brief = createBrief({
    title: '晨光咖啡', style: '温暖治愈的生活方式短片', mood: '温暖、松弛', look: 'film-warm', pacing: 'medium', aspect: '16:9', avoid: ['冷白光'],
  });
  p.storyboard = [
    createShot({ id: 's1', index: 1, title: '晨光里的店招', duration: 4.5, movement: 'tilt-down', transitionIn: 'dip-black', location: '咖啡店门口', subject: '店招', caption: '早上七点半', previz: createPrevizSpec({ setting: 'street' }) }),
    createShot({ id: 's2', index: 2, title: '推门走进店里', duration: 3.5, movement: 'tracking', transitionIn: 'crossfade', subject: '顾客推门', caption: '' }),
    createShot({ id: 's3', index: 3, title: '磨豆特写', duration: 4, movement: 'push-in', transitionIn: 'cut', subject: '咖啡豆与磨豆机', caption: '每一杯都从现磨开始', look: 'none' }),
    createShot({ id: 's4', index: 4, title: '第一口的微笑', duration: 4, movement: 'handheld', transitionIn: 'whip-pan', subject: '顾客喝咖啡微笑' }),
  ];
  return p;
}

function withAssets(p) {
  const out = { ...p, assets: { ...p.assets } };
  out.assets.grind = createAsset({ id: 'grind', kind: 'video', name: 'IMG_0012.MOV', duration: 12, tags: ['磨豆', '咖啡豆'], description: '磨豆机研磨咖啡豆的特写' });
  out.assets.sign = createAsset({ id: 'sign', kind: 'image', name: '店招照片.jpg', duration: 0, tags: ['店招', '门口'] });
  out.assets.short = createAsset({ id: 'short', kind: 'video', name: '顾客微笑', duration: 2, tags: ['顾客', '微笑'] });
  out.assets.music = createAsset({ id: 'music', kind: 'audio', name: '吉他', duration: 60, tags: ['咖啡'] });
  out.assets.other = createAsset({ id: 'other', kind: 'video', name: '海边日落', duration: 10, tags: ['海边'] });
  return out;
}

test('没有分镜：返回原项目和提示，不抛错', () => {
  const p = createProject();
  const r = buildFirstCut(p);
  assert.equal(r.project, p);
  assert.match(r.report[0], /还没有分镜/);
  assert.match(buildFirstCut(null).report[0], /没有可用的项目/);
});

test('全部缺素材：每镜一个预演资产，参数按分镜映射', () => {
  const p = deepFreeze(sampleProject());
  const { project, report } = buildFirstCut(p);
  const video = project.tracks.video;
  assert.equal(video.length, 4);
  const assets = video.map((c) => project.assets[c.assetId]);
  assert.ok(assets.every((a) => a.kind === 'previz' && a.path === null && a.previz));
  assert.equal(assets[0].previz.setting, 'street');
  assert.equal(assets[0].shotId, 's1');
  assert.deepEqual(layoutVideo(project).map((it) => it.duration), [4.5, 3.5, 4, 4]);
  assert.deepEqual(video.map((c) => c.motion.preset), ['tilt-down', 'drift', 'push-in', 'shake']);
  assert.equal(video[3].motion.intensity, 0.2, '手持低强度晃动');
  assert.deepEqual(video.map((c) => c.transitionIn.type), ['dip-black', 'crossfade', 'cut', 'whip-pan']);
  assert.equal(video[3].transitionIn.duration, 0.3);
  assert.ok(video.every((c) => c.color.look === 'film-warm'), '使用简报的调色风格');
  assert.deepEqual(video[0].caption, { text: '早上七点半', style: 'subtitle', position: 'bottom' });
  assert.equal(video[0].shotId, 's1');
  assert.equal(video[0].label, '晨光里的店招');
  assert.equal(report[0], '第1镜「晨光里的店招」：使用预演动画（缺实拍素材）');
  assert.match(report[report.length - 1], /初剪完成：共 4 镜/);
  assert.ok(project.storyboard.every((s) => s.status === 'has-previz'));
  assert.equal(p.tracks.video.length, 0, '不修改入参');
});

test('素材匹配：按标签/名称/描述关键词，每个素材只用一次，音频不上画面轨', () => {
  const p = withAssets(sampleProject());
  const { project, report } = buildFirstCut(p);
  const ids = project.tracks.video.map((c) => c.assetId);
  assert.equal(ids[0], 'sign');
  assert.equal(ids[2], 'grind');
  assert.equal(ids[3], 'short');
  assert.equal(project.assets[ids[1]].kind, 'previz');
  assert.ok(!ids.includes('music'));
  assert.equal(new Set(ids).size, ids.length);
  assert.match(report.join('\n'), /第3镜「磨豆特写」：匹配到素材「IMG_0012.MOV」/);
  assert.match(report.join('\n'), /有 1 个素材没有用上：「海边日落」/);
  assert.equal(project.storyboard[2].status, 'has-footage');
  assert.equal(project.storyboard[2].assetId, 'grind');
});

test('视频截取：长素材取中段，短素材整段使用并报告', () => {
  const { project, report } = buildFirstCut(withAssets(sampleProject()));
  const grind = project.tracks.video[2];
  assert.deepEqual([grind.in, grind.out], [4, 8]);
  const short = project.tracks.video[3];
  assert.deepEqual([short.in, short.out], [0, 2]);
  assert.ok(report.some((r) => /素材只有 2 秒/.test(r)));
  const sign = project.tracks.video[0];
  assert.equal(layoutVideo(project)[0].duration, 4.5, '图片按分镜时长');
  assert.equal(sign.in, 0);
});

test('分镜指定素材优先；指定的素材不存在时自动匹配', () => {
  const p = withAssets(sampleProject());
  p.storyboard = p.storyboard.map((s) => (s.id === 's1' ? { ...s, assetId: 'other' } : s.id === 's2' ? { ...s, assetId: 'gone' } : s));
  const { project, report } = buildFirstCut(p);
  assert.equal(project.tracks.video[0].assetId, 'other');
  assert.match(report.join('\n'), /第1镜「晨光里的店招」：使用指定素材「海边日落」/);
  assert.match(report.join('\n'), /第2镜：指定的素材已不在素材库中/);
});

test('节奏：fast 缩短镜头、转场更短；首镜不合法的入场改为硬切', () => {
  const p = sampleProject();
  p.brief = { ...p.brief, pacing: 'fast' };
  p.storyboard = p.storyboard.map((s) => (s.id === 's1' ? { ...s, transitionIn: 'slide-left' } : s));
  const { project } = buildFirstCut(p);
  assert.equal(layoutVideo(project)[2].duration, 3.4);
  assert.equal(project.tracks.video[0].transitionIn.type, 'cut');
  assert.equal(project.tracks.video[1].transitionIn.duration, 0.3);
});

test('重复初剪复用已有预演资产，不重复堆积', () => {
  const first = buildFirstCut(sampleProject()).project;
  const count = Object.keys(first.assets).length;
  const second = buildFirstCut(first).project;
  assert.equal(Object.keys(second.assets).length, count);
  assert.deepEqual(second.tracks.video.map((c) => c.assetId), first.tracks.video.map((c) => c.assetId));
});

test('usePreviz=false：缺素材的分镜用剩余素材占位，否则跳过', () => {
  const p = sampleProject();
  const none = buildFirstCut(p, { usePreviz: false });
  assert.equal(none.project, p, '没有任何镜头时返回原项目');
  assert.ok(none.report.some((r) => /已跳过/.test(r)));
  const withOne = { ...p, assets: { x: createAsset({ id: 'x', kind: 'video', name: '随便拍的', duration: 10 }) } };
  const r = buildFirstCut(withOne, { usePreviz: false });
  assert.equal(r.project.tracks.video.length, 1);
  assert.ok(r.report.some((line) => /暂用「随便拍的」占位/.test(line)));
  assert.ok(!Object.values(r.project.assets).some((a) => a.kind === 'previz'));
});

test('保留文字轨与音频轨；风格指南为空时根据简报写一句', () => {
  const p = sampleProject();
  p.tracks.text = [createTextClip({ id: 't1' })];
  const { project } = buildFirstCut(p);
  assert.ok(project.tracks.text.some((t) => t.id === 't1'), '原有文字保留');
  assert.equal(project.tracks.text.filter((t) => t.source === 'shot-caption').length, project.tracks.text.length - 1);
  assert.match(project.memory.styleGuide, /温暖治愈/);
  assert.match(project.memory.styleGuide, /暖调胶片/);
  const kept = buildFirstCut({ ...p, memory: { ...p.memory, styleGuide: '已有指南' } }).project;
  assert.equal(kept.memory.styleGuide, '已有指南');
});

test('简报画幅与项目不一致：只提示，不改设置', () => {
  const p = sampleProject();
  p.brief = { ...p.brief, aspect: '9:16' };
  const { project, report } = buildFirstCut(p);
  assert.equal(project.settings.aspect, '16:9');
  assert.ok(report.some((r) => /9:16/.test(r)));
});

test('初剪结果可被 normalizeProject 接受，且能继续用 applyOps 编辑', () => {
  const { project } = buildFirstCut(withAssets(sampleProject()));
  const normalized = normalizeProject(JSON.parse(JSON.stringify(project)));
  assert.equal(normalized.tracks.video.length, 4);
  const r = applyOps(project, [{ type: 'setLook', target: { mode: 'all' }, look: 'bw' }], {});
  assert.equal(r.ok, true, r.errors.join('；'));
});

test('缺字段的分镜也能处理（无 id、无时长、乱写的运镜和转场）', () => {
  const p = createProject();
  p.storyboard = [{ title: '奇怪的分镜', movement: 'fly', transitionIn: { type: 'bogus' } }, { index: 2, duration: -1, transitionIn: { type: 'crossfade', duration: 1.2 } }];
  const { project } = buildFirstCut(p);
  assert.equal(project.tracks.video.length, 2);
  assert.equal(project.tracks.video[0].motion.preset, 'none');
  assert.equal(project.tracks.video[0].transitionIn.type, 'cut');
  assert.deepEqual(project.tracks.video[1].transitionIn, { type: 'crossfade', duration: 1.2 });
  assert.equal(layoutVideo(project)[1].duration, 4);
});

test('makePrevizAsset：字段完整', () => {
  const shot = createShot({ id: 'sx', title: '拉花', duration: 5, subject: '拿铁', previz: createPrevizSpec({ setting: 'cafe' }) });
  const a = makePrevizAsset(shot, createProject({ aspect: '9:16' }));
  assert.equal(a.kind, 'previz');
  assert.equal(a.path, null);
  assert.equal(a.duration, 5);
  assert.equal(a.previz.setting, 'cafe');
  assert.notEqual(a.previz, shot.previz, '深拷贝 previz');
  assert.deepEqual([a.width, a.height], [1080, 1920]);
  assert.equal(a.name, '预演：拉花');
  assert.match(a.id, /^ast_/);
  const fallback = makePrevizAsset({}, null);
  assert.equal(fallback.duration, 4);
  assert.ok(fallback.previz.subjects.length > 0);
});

test('buildFirstCut 优先级：assetId > aiVideoAssetId > footageAssetId > previz', () => {
  const p = createProject({ name: 'prio' });
  const v = (id, extra) => createAsset({ id, kind: 'video', name: id, duration: 8, ...extra });
  p.assets = { mine: v('mine'), ai: v('ai', { source: 'videogen' }), st: v('st', { source: 'stock' }), st2: v('st2', { source: 'stock' }), ai3: v('ai3', { source: 'videogen' }) };
  p.storyboard = [
    createShot({ id: 's1', index: 1, title: 'a', duration: 4, assetId: 'mine', aiVideoAssetId: 'ai', footageAssetId: 'st' }),
    createShot({ id: 's2', index: 2, title: 'b', duration: 4, aiVideoAssetId: 'ai3', footageAssetId: 'st2' }),
    createShot({ id: 's3', index: 3, title: 'c', duration: 4 }),
  ];
  const { project, report } = buildFirstCut(p);
  const ids = project.tracks.video.map((c) => c.assetId);
  assert.equal(ids[0], 'mine');
  assert.equal(ids[1], 'ai3');
  assert.equal(project.assets[ids[2]].kind, 'previz');
  assert.ok(report.some((r) => /AI 生成视频/.test(r)));
  // AI 视频缺失时退回实拍
  const q = structuredClone(p);
  delete q.assets.ai3;
  assert.equal(buildFirstCut(q).project.tracks.video[1].assetId, 'st2');
});
