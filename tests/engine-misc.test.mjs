// colormatch / pacing / consistency / history / techniques / summary 单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorParamsFromStats, statsWithColor } from '../src/engine/colormatch.js';
import { pacingDurations, beatGridDurations, PACING_NAMES } from '../src/engine/pacing.js';
import { projectBaseline, harmonizeOps, consistencyReport } from '../src/engine/consistency.js';
import { createHistory } from '../src/engine/history.js';
import { searchTechniques, techniqueToOps } from '../src/engine/techniques.js';
import { BUILTIN_TECHNIQUES } from '../src/engine/builtinTechniques.js';
import { projectSummary } from '../src/engine/summary.js';
import { applyOps } from '../src/engine/ops.js';
import {
  createProject, createAsset, createClip, createTextClip, createAudioClip, createBrief, TECHNIQUE_CATEGORIES,
} from '../src/engine/model.js';

const stats = (luma, extra = {}) => ({ luma, contrast: 0.4, saturation: 0.4, warmth: 0, tint: 0, palette: ['#111111'], ...extra });

function colorProject(lumas) {
  const p = createProject({ name: '色彩' });
  lumas.forEach((luma, i) => {
    p.assets[`a${i}`] = createAsset({ id: `a${i}`, name: `素材${i + 1}`, kind: 'video', duration: 10, stats: luma === null ? undefined : stats(luma) });
    p.tracks.video.push(createClip(p.assets[`a${i}`], { id: `c${i + 1}`, in: 0, out: 4 }));
  });
  return p;
}

// ---------- colormatch ----------

test('colorParamsFromStats：相同统计返回 0，差距按强度缩放并夹紧', () => {
  assert.deepEqual(colorParamsFromStats(stats(0.5), stats(0.5)), { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0 });
  const p = colorParamsFromStats(stats(0.6), stats(0.4));
  assert.equal(p.exposure, 0.5);
  assert.equal(colorParamsFromStats(stats(0.6), stats(0.4), 0.5).exposure, 0.25);
  assert.equal(colorParamsFromStats(stats(1), stats(0.01)).exposure, 1, '极暗素材不会算出夸张值');
  const warm = colorParamsFromStats(stats(0.5, { warmth: 0.2 }), stats(0.5, { warmth: 0 }));
  assert.equal(warm.temperature, 0.3);
  assert.deepEqual(colorParamsFromStats(null, stats(0.5)), { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0 });
});

test('statsWithColor：近似逆运算', () => {
  const base = stats(0.4);
  const params = colorParamsFromStats(stats(0.6), base);
  const after = statsWithColor(base, params);
  assert.ok(Math.abs(after.luma - 0.6) < 1e-3);
  assert.equal(statsWithColor(null, {}), null);
});

// ---------- pacing ----------

test('pacingDurations：快/中/慢与显式时长，视频不超过素材长度', () => {
  const asset = createAsset({ id: 'v', kind: 'video', duration: 6 });
  const img = createAsset({ id: 'i', kind: 'image' });
  const clips = [createClip(asset, { in: 0, out: 4 }), createClip(img, { in: 0, out: 4 })];
  const assets = { v: asset, i: img };
  assert.deepEqual(pacingDurations(clips, 'fast', assets), [2.8, 2.8]);
  assert.deepEqual(pacingDurations(clips, 'medium', assets), [4, 4]);
  assert.deepEqual(pacingDurations(clips, 'slow', assets), [5.4, 5.4]);
  assert.deepEqual(pacingDurations(clips, [10, 10], assets), [6, 10]);
  assert.deepEqual(pacingDurations(clips, [0.05], assets), [0.2, 4]);
  assert.throws(() => pacingDurations(clips, 'turbo', assets), /节奏只能是/);
  assert.deepEqual(pacingDurations([], 'fast', assets), []);
  assert.deepEqual(PACING_NAMES, ['fast', 'medium', 'slow']);
});

test('pacingDurations：反复加快会收敛到下限', () => {
  const img = createAsset({ id: 'i', kind: 'image' });
  let clip = createClip(img, { in: 0, out: 4 });
  for (let k = 0; k < 10; k += 1) clip = { ...clip, out: pacingDurations([clip], 'fast', { i: img })[0] };
  assert.equal(clip.out, 0.8);
});

test('beatGridDurations：吸附到节拍网格', () => {
  const img = createAsset({ id: 'i', kind: 'image' });
  const d = beatGridDurations([createClip(img, { out: 4 }), createClip(img, { out: 1.3 })], { i: img }, 0.5);
  assert.deepEqual(d, [3, 1]);
});

// ---------- consistency ----------

test('projectBaseline：按时长加权，没有色彩数据时为 null', () => {
  const p = colorProject([0.2, 0.6]);
  p.tracks.video[1] = { ...p.tracks.video[1], out: 12 };
  assert.equal(projectBaseline(p).luma, 0.5);
  assert.deepEqual(projectBaseline(p).palette, ['#111111']);
  assert.equal(projectBaseline(colorProject([null, null])), null);
  assert.equal(projectBaseline(createProject()), null);
});

test('harmonizeOps：偏暗提亮、偏亮压暗，跳过锁定和无数据镜头', () => {
  const p = colorProject([0.2, 0.4, 0.6, null]);
  p.tracks.video[2] = { ...p.tracks.video[2], locked: true };
  const ops = harmonizeOps(p);
  assert.deepEqual(ops.map((o) => o.target.indices[0]), [1, 2]);
  assert.ok(ops[0].color.exposure > 0);
  assert.equal(ops[0].relative, false);
  const all = harmonizeOps(p, [0, 2], 1);
  assert.ok(all[1].color.exposure < 0);
  const r = applyOps(p, ops, {});
  assert.equal(r.ok, true, r.errors.join('；'));
  assert.deepEqual(harmonizeOps(createProject()), []);
});

test('harmonizeOps：优先使用已确认的基准，保留全片平均调色', () => {
  const p = colorProject([0.4, 0.4]);
  p.memory = { ...p.memory, colorBaseline: stats(0.6) };
  p.tracks.video = p.tracks.video.map((c) => ({ ...c, color: { ...c.color, temperature: 0.2 } }));
  const ops = harmonizeOps(p);
  assert.equal(ops[0].color.exposure, 0.3);
  assert.equal(ops[0].color.temperature, 0.2);
});

test('consistencyReport：指出明显偏暗的镜头与风格不一致', () => {
  const p = colorProject([0.5, 0.5, 0.15, 0.5, null]);
  p.tracks.video = p.tracks.video.map((c, i) => ({ ...c, color: { ...c.color, look: i === 1 ? 'bw' : 'film-warm' } }));
  const report = consistencyReport(p);
  assert.ok(report.some((r) => r.index === 2 && r.issue === '第3镜明显偏暗' && r.severity === 'warn'));
  assert.ok(report.some((r) => r.index === 1 && /黑白/.test(r.issue)));
  assert.ok(report.some((r) => r.index === 4 && /还没有色彩数据/.test(r.issue)));
  assert.deepEqual(consistencyReport(createProject()), []);
  const fixed = applyOps(p, harmonizeOps(p, [2], 1), {}).project;
  // 曝光最多 +1，极暗素材只能部分校正：警告降为提示
  const after = consistencyReport(fixed).filter((r) => r.index === 2 && /偏暗/.test(r.issue));
  assert.ok(after.every((r) => r.severity === 'info' && r.issue === '第3镜略偏暗'), '统一后不再明显偏暗');
});

// ---------- history ----------

test('history：撤销、重做、标签、新修改清空重做栈', () => {
  const h = createHistory();
  const s0 = { v: 0 };
  const s1 = { v: 1 };
  const s2 = { v: 2 };
  assert.equal(h.canUndo, false);
  assert.equal(h.undo(s0), null);
  h.push(s0, '调色');
  h.push(s1, '删除');
  assert.equal(h.canUndo, true);
  assert.equal(h.undoLabel(), '删除');
  const u = h.undo(s2);
  assert.deepEqual(u, { state: s1, label: '删除', selection: null });
  assert.equal(h.canRedo, true);
  assert.equal(h.redoLabel(), '删除');
  const r = h.redo(s1);
  assert.equal(r.state, s2);
  assert.equal(h.undo(s2).state, s1);
  h.push(s1, '新修改');
  assert.equal(h.canRedo, false);
  h.clear();
  assert.equal(h.canUndo, false);
});

test('history：容量上限与重复状态', () => {
  const h = createHistory(3);
  for (let i = 0; i < 5; i += 1) h.push({ i }, `第${i}步`);
  const seen = [];
  let cur = { i: 5 };
  for (let r = h.undo(cur); r; r = h.undo(cur)) { seen.push(r.state.i); cur = r.state; }
  assert.deepEqual(seen, [4, 3, 2]);
  const h2 = createHistory();
  const s = { a: 1 };
  h2.push(s, '一');
  h2.push(s, '二');
  assert.equal(h2.undo({}).state, s);
  assert.equal(h2.canUndo, false);
});

// ---------- techniques ----------

const sel = { mode: 'selected', indices: [], ids: [] };
const TECHS = [
  { id: 't1', category: 'transition', title: '甩镜转场', summary: '快速横摇制造动感衔接', steps: ['前一镜结尾快速右摇'], whenToUse: '旅行快剪', tags: ['甩镜', '动感'], builtin: true, apply: { ops: [{ type: 'setTransition', target: sel, transition: { type: 'whip-pan', duration: 0.3 } }] } },
  { id: 't2', category: 'lighting', title: '逆光剪影', summary: '主体背对光源拍出轮廓', steps: ['让太阳在主体身后'], whenToUse: '日落', tags: ['逆光', '剪影'], builtin: true, apply: null },
  { id: 't3', category: 'color', title: '暖调胶片色', summary: '温暖怀旧的颜色', steps: ['套用暖调胶片', '加一点颗粒'], whenToUse: '生活方式', tags: ['调色', '胶片'], builtin: true, apply: { ops: [{ type: 'setLook', target: { mode: 'index', indices: [1], ids: [] }, look: 'film-warm', lookStrength: 0.8 }, { type: 'setFx', target: 'all', fx: { grain: 0.2 }, relative: false }] } },
  { id: 't4', category: 'transition', title: '叠化过渡', summary: '两个画面柔和交融', steps: ['设置 0.8 秒叠化'], whenToUse: '情绪段落', tags: ['叠化'], builtin: false, apply: null },
  { id: 't5', category: 'rhythm', title: '音乐卡点', summary: '按节拍切换画面', steps: ['找到重拍'], whenToUse: '快节奏短视频', tags: ['卡点', '节奏'], builtin: true, apply: null },
];

test('searchTechniques：标题优先，同义词扩展，分类过滤，空查询按原顺序', () => {
  assert.equal(searchTechniques(TECHS, '甩镜')[0].id, 't1');
  assert.equal(searchTechniques(TECHS, '逆光')[0].id, 't2');
  const trans = searchTechniques(TECHS, '过渡').map((t) => t.id);
  assert.equal(trans[0], 't4');
  assert.ok(trans.includes('t1'), '过渡 ↔ 转场 同义扩展');
  assert.deepEqual(searchTechniques(TECHS, '转场', { category: 'transition' }).map((t) => t.id).sort(), ['t1', 't4']);
  assert.deepEqual(searchTechniques(TECHS, '', { category: 'all' }).map((t) => t.id), ['t1', 't2', 't3', 't4', 't5']);
  assert.deepEqual(searchTechniques(TECHS, '', { limit: 2 }).map((t) => t.id), ['t1', 't2']);
  assert.deepEqual(searchTechniques(TECHS, '量子力学'), []);
  assert.equal(searchTechniques(TECHS, '想拍一个卡点视频')[0].id, 't5');
  assert.equal(searchTechniques(TECHS, '光')[0].id, 't2', '单字查询');
  assert.deepEqual(searchTechniques(null, '甩镜'), []);
});

test('techniqueToOps：目标统一为所选镜头，深拷贝，没有 apply 时为空', () => {
  const ops = techniqueToOps(TECHS[2]);
  assert.equal(ops.length, 2);
  assert.ok(ops.every((o) => o.target.mode === 'selected'));
  ops[0].look = 'bw';
  assert.equal(TECHS[2].apply.ops[0].look, 'film-warm');
  assert.deepEqual(techniqueToOps(TECHS[1]), []);
  assert.deepEqual(techniqueToOps(null), []);
  const p = colorProject([0.5, 0.5]);
  const r = applyOps(p, techniqueToOps(TECHS[2]), { selectedClipIds: ['c2'] });
  assert.equal(r.ok, true, r.errors.join('；'));
  assert.equal(r.project.tracks.video[1].color.look, 'film-warm');
  assert.equal(r.project.tracks.video[0].color.look, 'none');
});

test('内置技法卡：都能检索，可套用的操作都能应用', () => {
  const builtin = BUILTIN_TECHNIQUES;
  assert.ok(Array.isArray(builtin) && builtin.length > 0);
  for (const t of builtin) assert.ok(TECHNIQUE_CATEGORIES.includes(t.category), t.id);
  assert.ok(searchTechniques(builtin, '转场').length > 0);
  const p = colorProject([0.4, 0.5, 0.6]);
  for (const t of builtin) {
    const ops = techniqueToOps(t);
    if (!ops.length) continue;
    const r = applyOps(p, ops, { selectedClipIds: ['c2', 'c3'] });
    assert.equal(r.ok, true, `${t.id}：${r.errors.join('；')}`);
  }
});

// ---------- summary ----------

function summaryProject(n = 6) {
  const p = colorProject(Array.from({ length: n }, (_, i) => 0.3 + (i % 3) * 0.1));
  p.brief = createBrief({ title: '晨光咖啡', goal: '吸引上班族', look: 'film-warm', pacing: 'fast', mustHave: ['店招'] });
  p.memory = { styleGuide: '温暖治愈', decisions: [{ at: '', text: '全片暖调' }], colorBaseline: null };
  p.tracks.video[1] = { ...p.tracks.video[1], locked: true, caption: { text: '早上好', style: 'subtitle', position: 'bottom' }, motion: { preset: 'push-in', intensity: 0.5 }, transitionIn: { type: 'crossfade', duration: 0.5 }, color: { ...p.tracks.video[1].color, temperature: 0.3, look: 'film-warm' } };
  p.tracks.text = [createTextClip({ id: 'txt1', text: '晨光咖啡', start: 0, duration: 3 })];
  p.assets.mu = createAsset({ id: 'mu', kind: 'audio', name: '吉他曲', duration: 30 });
  p.assets.unused = createAsset({ id: 'unused', kind: 'image', name: '没用上的照片', description: '咖啡杯特写' });
  p.tracks.audio = [createAudioClip(p.assets.mu, { id: 'au1', out: 20 })];
  return p;
}

test('projectSummary：包含项目、简报、镜头细节、轨道和素材信息', () => {
  const s = projectSummary(summaryProject());
  assert.match(s, /项目「色彩」/);
  assert.match(s, /主轨 6 镜/);
  assert.match(s, /简报：「晨光咖啡」/);
  assert.match(s, /风格指南：温暖治愈/);
  assert.match(s, /色彩基准（自动）/);
  assert.match(s, /已定决策：全片暖调/);
  assert.match(s, /第2镜 \[00:03\.5–00:07\.5, 4\.0s\] id=c2/);
  assert.match(s, /素材「素材2」\(视频,a1\)/);
  assert.match(s, /风格暖调胶片/);
  assert.match(s, /色温\+0\.3/);
  assert.match(s, /运镜缓慢推近/);
  assert.match(s, /入场叠化0\.5s/);
  assert.match(s, /字幕「早上好」/);
  assert.match(s, /已锁定/);
  assert.match(s, /文字轨（1）/);
  assert.match(s, /txt1/);
  assert.match(s, /音频轨（1）/);
  assert.match(s, /au1 音乐「吉他曲」/);
  assert.match(s, /未用 unused 图片「没用上的照片」/);
});

test('projectSummary：聚焦时只详写聚焦镜头及前后两镜，其余压缩', () => {
  const p = summaryProject(12);
  const s = projectSummary(p, { focus: { start: 24.5, end: 27 } });
  assert.match(s, /聚焦镜头：第7镜/);
  assert.match(s, /第7镜 .*★聚焦/);
  for (const n of [5, 6, 8, 9]) assert.match(s, new RegExp(`第${n}镜 \\[`));
  assert.match(s, /第1–4镜 \[.*略写 4 镜/);
  assert.match(s, /第10–12镜 \[.*略写 3 镜/);
  assert.ok(!/第2镜 \[/.test(s));
  const viaRange = projectSummary(p, { range: { start: 27, end: 24.5 } });
  assert.match(viaRange, /聚焦镜头：第7镜/);
});

test('projectSummary：镜头过多时压缩中段；空项目也有输出', () => {
  const s = projectSummary(summaryProject(30), { maxClips: 10 });
  assert.match(s, /第1镜 \[/);
  assert.match(s, /第30镜 \[/);
  assert.match(s, /第6–25镜 .*略写 20 镜/);
  const empty = projectSummary(createProject({ name: '空' }));
  assert.match(empty, /主轨 0 镜/);
  assert.match(empty, /还没有镜头/);
  assert.equal(projectSummary(null), '（没有打开的项目）');
});


// ---------- v3：迁移与历史合并 ----------
import { normalizeProject as normV3, LIMITS as LIM3, SPEED_CURVE_PRESETS } from '../src/engine/model.js';
import { pacingDurations as pacing3 } from '../src/engine/pacing.js';

test('normalizeProject：旧工程迁移出 overlays / trackState / markers 与新 clip 字段', () => {
  const old = {
    name: '旧', settings: { aspect: '9:16' }, assets: { a: { kind: 'video', duration: 10 } },
    tracks: { video: [{ id: 'c', assetId: 'a', in: 0, out: 3, mute: true, transform: { flipH: true }, speed: 8 }], text: [{ id: 't', text: 'x' }], audio: [] },
  };
  const p = normV3(old);
  assert.deepEqual(p.overlays, []);
  assert.deepEqual(p.markers, []);
  assert.equal(p.trackState.video.locked, false);
  assert.equal(p.trackState.overlay[4].hidden, false);
  const c = p.tracks.video[0];
  assert.equal(c.muted, true, 'mute → muted');
  assert.equal(c.mirror.h, true, 'flipH → mirror.h');
  assert.equal(c.speed, 8, '速度上限放宽到 10');
  assert.equal(c.reverse, false);
  assert.equal(c.fit, 'cover');
  assert.deepEqual(c.crop, { l: 0, t: 0, r: 0, b: 0 });
  assert.equal(c.opacity, 1);
  assert.equal(c.blend, 'normal');
  assert.equal(c.mask, null);
  assert.deepEqual(c.keys, {});
  assert.equal(c.speedCurve, null);
  assert.equal(p.tracks.text[0].group, null);
  assert.equal(LIM3.speed.min, 0.1);
  assert.equal(LIM3.speed.max, 10);
  // 定格片段 in===out 保留
  const s = normV3({ assets: { a: { kind: 'video', duration: 10 } }, tracks: { video: [{ id: 's', assetId: 'a', in: 2, out: 9, still: true, duration: 3 }] } });
  assert.deepEqual([s.tracks.video[0].in, s.tracks.video[0].out, s.tracks.video[0].duration], [2, 2, 3]);
  // 曲线规范化；画中画素材记录丢失时保留片段、补「缺失的素材」占位（不再悄悄丢掉）
  const reports = [];
  const q = normV3({
    assets: { a: { kind: 'video', duration: 10 } },
    tracks: { video: [{ id: 'q', assetId: 'a', in: 0, out: 4, speedCurve: [{ t: 0.9, v: 50 }, { t: 0.2, v: 1 }] }] },
    overlays: [{ id: 'o', assetId: 'a', track: 7 }, { id: 'gone', assetId: 'zz' }],
    markers: [{ t: 3, label: 'b' }, { t: 1 }],
  }, { report: (m) => reports.push(m) });
  assert.deepEqual(q.tracks.video[0].speedCurve, [{ t: 0, v: 1 }, { t: 1, v: 10 }]);
  assert.equal(q.overlays.length, 2);
  assert.equal(q.overlays[0].track, 4);
  assert.equal(q.assets.zz.missing, true);
  assert.equal(reports.length, 1);
  assert.deepEqual(q.markers.map((m) => m.t), [1, 3]);
  assert.ok(Object.keys(SPEED_CURVE_PRESETS).length >= 4);
});

test('pacing：曲线变速与定格镜头兼容', () => {
  const d = pacing3([{ in: 0, out: 3, still: true, duration: 3 }], 'fast', {});
  assert.equal(d.length, 1);
  assert.ok(d[0] > 0);
});

test('history：mergeKey 600ms 内合并、空操作去重、标签与选区随撤销恢复', () => {
  let clock = 0;
  const h = createHistory(100, { clock: () => clock });
  const s0 = { v: 0 }; const s1 = { v: 1 }; const s2 = { v: 2 };
  assert.equal(h.push(s0, { label: '曝光', mergeKey: 'exp', selection: { clipIds: ['a'] } }), 'pushed');
  clock = 300;
  assert.equal(h.push(s1, { label: '曝光', mergeKey: 'exp' }), 'merged');
  clock = 1200;
  assert.equal(h.push(s2, { label: '曝光', mergeKey: 'exp' }), 'pushed', '超过 600ms 单独成步');
  assert.equal(h.push({ v: 3 }, { label: '空', next: { v: 3 } }), 'noop');
  assert.equal(h.size.past, 2);
  h.undo({ v: 3 });
  const u = h.undo(s2, { clipIds: ['b'] });
  assert.equal(u.state, s0, '合并后撤销回到最早状态');
  assert.deepEqual(u.selection, { clipIds: ['a'] });
  assert.equal(h.redoLabel(), '曝光');
  const r = h.redo(s0);
  assert.deepEqual(r.selection, { clipIds: ['b'] });
  h.seal();
  clock = 1300;
  assert.equal(h.push(s1, { label: '曝光', mergeKey: 'exp' }), 'pushed', 'seal 后不再合并');
});

test('history.apply：执行 op、中文标签、空操作不入栈、失败不入栈', async () => {
  const { createProject: cp, createAsset: ca, createClip: cc } = await import('../src/engine/model.js');
  const p = cp({ name: 'h' });
  p.assets.a = ca({ id: 'a', kind: 'video', duration: 10 });
  p.tracks.video = [cc(p.assets.a, { id: 'c1', in: 0, out: 4 })];
  const h = createHistory();
  const r = h.apply(p, { type: 'addMarker', t: 1, label: '开场' });
  assert.equal(r.ok, true);
  assert.match(h.undoLabel(), /开场/);
  const f = h.apply(r.project, { type: 'removeMarker', id: 'nope' });
  assert.equal(f.ok, false);
  assert.equal(h.size.past, 1);
  const n = h.apply(r.project, { type: 'setClipProps', id: 'c1', patch: { reverse: false } });
  assert.equal(n.recorded, 'noop');
  assert.equal(n.project, r.project);
  assert.equal(h.size.past, 1);
});


test('AI 精修：新 op 规范化后可被引擎执行', async () => {
  const { normalizeAiOps, flattenOp, AI_OP_SCHEMA } = await import('../src/ai/schemas.js');
  const { applyOps } = await import('../src/engine/ops.js');
  const { createProject: cp, createAsset: ca, createClip: cc } = await import('../src/engine/model.js');
  const p = cp({ name: 'ai' });
  p.assets.a = ca({ id: 'a', kind: 'video', duration: 10 });
  p.tracks.video = [cc(p.assets.a, { id: 'c1', in: 0, out: 4 }), cc(p.assets.a, { id: 'c2', in: 0, out: 4 })];
  const ops = normalizeAiOps([
    { type: 'setClipProps', targetMode: 'index', indices: [1], reverse: true, mirrorH: true },
    { type: 'setSpeedCurve', targetMode: 'index', indices: [2], speedPreset: 'hero' },
    { type: 'freezeFrame', at: 1, freezeDuration: 1 },
    { type: 'addMarker', at: 2, markerLabel: '重点' },
    { type: 'setTransitionAll', transitionType: 'crossfade', transitionDuration: 0.3 },
    { type: 'rippleDelete', targetMode: 'index', indices: [1] },
  ]);
  assert.equal(ops.length, 6);
  const r = applyOps(p, ops, {});
  assert.equal(r.ok, true, r.errors.join('；'));
  assert.equal(r.project.markers.length, 1);
  for (const op of ops) assert.deepEqual(Object.keys(flattenOp(op)).sort(), Object.keys(AI_OP_SCHEMA.properties).sort());
});
