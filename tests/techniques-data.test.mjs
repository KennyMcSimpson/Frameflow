// 内置技法卡与示例项目的数据完整性测试（E-ai-knowledge）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_TECHNIQUES, BUILTIN_TECHNIQUE_MAP, getBuiltinTechnique } from '../src/engine/builtinTechniques.js';
import { createSampleProject } from '../src/engine/sample.js';
import { applyOps, OP_TYPES } from '../src/engine/ops.js';
import { buildFirstCut } from '../src/engine/firstcut.js';
import {
  TECHNIQUE_CATEGORIES, SHOT_SIZES, ANGLES, SHOT_MOVEMENTS, TRANSITIONS, LOOKS, MOTIONS,
  PREVIZ_SETTINGS, PREVIZ_SUBJECTS, PREVIZ_ACTIONS, createProject, createAsset, createClip,
} from '../src/engine/model.js';

const nonEmpty = (s) => typeof s === 'string' && s.trim().length > 0;

test('内置技法卡数量 ≥ 48 且 id 唯一、以 bt_ 开头', () => {
  assert.ok(BUILTIN_TECHNIQUES.length >= 48, `只有 ${BUILTIN_TECHNIQUES.length} 张`);
  const ids = new Set();
  for (const t of BUILTIN_TECHNIQUES) {
    assert.match(t.id, /^bt_[a-z0-9_]+$/, `id 格式错误：${t.id}`);
    assert.ok(!ids.has(t.id), `id 重复：${t.id}`);
    ids.add(t.id);
  }
  assert.equal(Object.keys(BUILTIN_TECHNIQUE_MAP).length, BUILTIN_TECHNIQUES.length);
  assert.equal(getBuiltinTechnique('bt_three_point').id, 'bt_three_point');
  assert.equal(getBuiltinTechnique('not_exist') ?? null, null);
});

test('每张技法卡字段完整', () => {
  for (const t of BUILTIN_TECHNIQUES) {
    const where = `技法 ${t.id}`;
    assert.ok(nonEmpty(t.title), `${where} 缺 title`);
    assert.ok(nonEmpty(t.summary), `${where} 缺 summary`);
    assert.ok(Array.isArray(t.steps) && t.steps.length >= 3, `${where} steps 少于 3 步`);
    assert.ok(t.steps.every(nonEmpty), `${where} steps 有空项`);
    assert.ok(nonEmpty(t.whenToUse), `${where} 缺 whenToUse`);
    assert.ok(Array.isArray(t.tags) && t.tags.length >= 1 && t.tags.every(nonEmpty), `${where} tags 不合法`);
    assert.equal(t.builtin, true, `${where} builtin 应为 true`);
    assert.ok(t.apply === null || (typeof t.apply === 'object' && Array.isArray(t.apply.ops)), `${where} apply 结构错误`);
  }
});

test('category 均合法且 11 类全部覆盖', () => {
  const seen = new Set();
  for (const t of BUILTIN_TECHNIQUES) {
    assert.ok(TECHNIQUE_CATEGORIES.includes(t.category), `${t.id} 的分类 ${t.category} 不合法`);
    seen.add(t.category);
  }
  for (const c of TECHNIQUE_CATEGORIES) assert.ok(seen.has(c), `分类 ${c} 没有任何技法卡`);
});

test('apply.ops 的 type 均在 OP_TYPES 内，参数枚举合法', () => {
  assert.ok(Array.isArray(OP_TYPES) && OP_TYPES.length > 0);
  let withApply = 0;
  for (const t of BUILTIN_TECHNIQUES) {
    if (!t.apply) continue;
    withApply++;
    assert.ok(t.apply.ops.length >= 1, `${t.id} apply.ops 为空却不是 null`);
    assert.equal(typeof t.apply.note, 'string', `${t.id} apply.note 不是字符串`);
    for (const op of t.apply.ops) {
      assert.ok(OP_TYPES.includes(op.type), `${t.id} 使用了未知操作 ${op.type}`);
      assert.ok(op.target && ['selected', 'all', 'index', 'ids', 'range', 'none'].includes(op.target.mode), `${t.id} target 不合法`);
      if (op.type === 'setLook') assert.ok(LOOKS.includes(op.look), `${t.id} look ${op.look} 不合法`);
      if (op.type === 'setMotion') assert.ok(MOTIONS.includes(op.preset), `${t.id} motion ${op.preset} 不合法`);
      if (op.type === 'setTransition') assert.ok(TRANSITIONS.includes(op.transition && op.transition.type), `${t.id} 转场不合法`);
      if (op.type === 'applyPacing') assert.ok(['slow', 'medium', 'fast'].includes(op.pacing), `${t.id} 节奏不合法`);
    }
  }
  assert.ok(withApply >= 30, `可一键套用的技法只有 ${withApply} 张`);
});

test('可套用技法在真实项目上通过 applyOps', () => {
  const p = createProject({ name: '技法套用测试' });
  const assets = [0, 1, 2].map((i) => createAsset({ id: `ast_${i}`, kind: 'video', name: `素材${i}.mp4`, path: `C:/v/${i}.mp4`, duration: 8, width: 1920, height: 1080, hasAudio: true,
    stats: { luma: 0.4 + i * 0.1, contrast: 0.4, saturation: 0.3 + i * 0.05, warmth: 0.05 * (i - 1), tint: 0, palette: ['#334455', '#aa8866', '#eeddcc'] } }));
  p.assets = Object.fromEntries(assets.map((a) => [a.id, a]));
  p.tracks.video = assets.map((a, i) => createClip(a, { id: `clp_${i}`, in: 0, out: 4 }));
  const failures = [];
  for (const tq of BUILTIN_TECHNIQUES) {
    if (!tq.apply) continue;
    const r = applyOps(p, tq.apply.ops, { selectedClipIds: ['clp_1'] });
    if (!r.ok) failures.push(`${tq.id}：${r.errors.join('；')}`);
  }
  assert.deepEqual(failures, []);
});

test('示例项目：7 个分镜、字段完整、技法 id 均存在、预演枚举合法', () => {
  const p = createSampleProject();
  assert.equal(p.name, '示例：咖啡店宣传片');
  assert.equal(p.storyboard.length, 7);
  const total = p.storyboard.reduce((s, x) => s + x.duration, 0);
  assert.ok(Math.abs(total - p.brief.duration) < 0.01, `分镜总时长 ${total} 与简报 ${p.brief.duration} 不一致`);
  p.storyboard.forEach((s, i) => {
    const where = `第 ${i + 1} 镜`;
    assert.equal(s.index, i + 1);
    assert.ok(nonEmpty(s.id) && nonEmpty(s.title) && nonEmpty(s.action) && nonEmpty(s.lighting), `${where} 文案缺失`);
    assert.ok(SHOT_SIZES.includes(s.shotSize), `${where} 景别不合法`);
    assert.ok(ANGLES.includes(s.angle), `${where} 角度不合法`);
    assert.ok(SHOT_MOVEMENTS.includes(s.movement), `${where} 运镜不合法`);
    assert.ok(TRANSITIONS.includes(s.transitionIn), `${where} 转场不合法`);
    assert.ok(LOOKS.includes(s.look), `${where} 色调不合法`);
    assert.ok(s.shootingTips.length >= 3, `${where} 拍法少于 3 条`);
    assert.ok(s.referenceQueries.length >= 2, `${where} 参考词不足`);
    assert.ok(/[a-z]/i.test(s.referenceQueries.join(' ')), `${where} 缺少英文参考词`);
    assert.ok(s.techniqueIds.length >= 1, `${where} 没有关联技法`);
    for (const id of s.techniqueIds) assert.ok(BUILTIN_TECHNIQUE_MAP[id], `${where} 引用了不存在的技法 ${id}`);
    const pv = s.previz;
    assert.ok(PREVIZ_SETTINGS.includes(pv.setting), `${where} 预演场景不合法`);
    assert.ok(['day', 'golden', 'night', 'blue'].includes(pv.timeOfDay), `${where} 时段不合法`);
    assert.equal(pv.palette.length, 3);
    assert.ok(pv.subjects.length >= 1);
    for (const sub of pv.subjects) {
      assert.ok(PREVIZ_SUBJECTS.includes(sub.kind), `${where} 主体 ${sub.kind} 不合法`);
      assert.ok(PREVIZ_ACTIONS.includes(sub.action), `${where} 动作 ${sub.action} 不合法`);
      assert.ok(sub.x >= 0 && sub.x <= 1 && sub.y >= 0 && sub.y <= 1, `${where} 主体坐标越界`);
    }
    assert.equal(pv.camera.shotSize, s.shotSize);
    assert.equal(pv.camera.movement, s.movement);
    assert.equal(pv.camera.angle, s.angle);
    assert.ok(['left', 'right', 'top', 'back', 'front'].includes(pv.light.direction));
    assert.ok(['warm', 'cool', 'neutral'].includes(pv.light.key));
    assert.ok(['bright', 'soft', 'dramatic', 'night'].includes(pv.light.mood));
  });
  assert.equal(p.tracks.video.length, 0, '示例项目的时间线应为空，由启动页生成初剪');
  assert.ok(p.chats.director.length >= 1 && nonEmpty(p.chats.director[0].text));
  assert.ok(nonEmpty(p.memory.styleGuide));
  // 每次调用返回新的对象
  const q = createSampleProject();
  assert.notEqual(q.id, p.id);
  assert.notEqual(q.storyboard[0].id, p.storyboard[0].id);
});

test('示例项目能被 firstcut 生成初剪', () => {
  const p = createSampleProject();
  const r = buildFirstCut(p);
  const project = r && r.project ? r.project : r;
  assert.ok(project && project.tracks && project.tracks.video.length === 7, '初剪应有 7 个片段');
});
