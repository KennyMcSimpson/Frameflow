// AI 知识层单元测试：严格 schema、请求构造、响应解析、本地导演、拆片、客户端（E-ai-knowledge）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_SCHEMAS, DIRECTOR_SCHEMA, STORYBOARD_SCHEMA, SHOT_SCHEMA, EDIT_SCHEMA, ANALYZE_SCHEMA, AI_OP_SCHEMA,
  normalizeAiOp, normalizeAiOps, flattenOp,
} from '../src/ai/schemas.js';
import {
  buildDirectorRequest, parseDirectorResponse, buildStoryboardRequest, parseStoryboardResponse,
  buildShotRefineRequest, parseShotRefineResponse, normalizeBriefPatch, normalizeAiShot, fitShotDurations, techniqueCatalog,
} from '../src/ai/director.js';
import { localDirectorReply, localStoryboard, localAnalyzeTechniques, extractDuration, extractBriefPatch, detectTopic, LOCAL_TOPICS } from '../src/ai/localDirector.js';
import { buildAnalyzeRequest, mergeAnalyzeResponse } from '../src/ai/analyze.js';
import { runAI, runWithFallback, NoAIError, isNoAI, isCancelled } from '../src/ai/client.js';
import api from '../src/ui/api.js';
import { BUILTIN_TECHNIQUES, BUILTIN_TECHNIQUE_MAP } from '../src/engine/builtinTechniques.js';
import {
  SHOT_SIZES, ANGLES, SHOT_MOVEMENTS, TRANSITIONS, LOOKS, PREVIZ_SETTINGS, PREVIZ_SUBJECTS, PREVIZ_ACTIONS, TECHNIQUE_CATEGORIES,
  createProject, createAsset, createClip, createShot, createBrief,
} from '../src/engine/model.js';

const VALID_IDS = new Set(BUILTIN_TECHNIQUES.map((t) => t.id));

// ---------------------------------------------------------------------------
// 严格 schema 校验器（OpenAI / Codex strict 结构化输出规则）
// ---------------------------------------------------------------------------
const FORBIDDEN = ['minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'format', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'default', 'oneOf', 'allOf', 'not', '$ref', 'uniqueItems', 'minProperties', 'maxProperties'];
const ALLOWED_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];

function checkStrict(schema, path, errors) {
  if (!schema || typeof schema !== 'object') { errors.push(`${path}：不是对象`); return; }
  for (const k of FORBIDDEN) if (k in schema) errors.push(`${path}：使用了不允许的关键字 ${k}`);
  if (schema.anyOf) {
    if (!Array.isArray(schema.anyOf) || !schema.anyOf.length) errors.push(`${path}：anyOf 为空`);
    else schema.anyOf.forEach((s, i) => checkStrict(s, `${path}.anyOf[${i}]`, errors));
    return;
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.length || types.some((t) => !ALLOWED_TYPES.includes(t))) { errors.push(`${path}：type 不合法 ${JSON.stringify(schema.type)}`); return; }
  if (schema.enum) {
    if (!Array.isArray(schema.enum) || !schema.enum.length) errors.push(`${path}：enum 为空`);
    if (schema.enum.some((v) => v === null) && !types.includes('null')) errors.push(`${path}：enum 含 null 但 type 不含 null`);
  }
  if (types.includes('object')) {
    if (schema.additionalProperties !== false) errors.push(`${path}：缺少 additionalProperties:false`);
    const props = schema.properties || {};
    const keys = Object.keys(props);
    if (!keys.length) errors.push(`${path}：对象没有任何属性`);
    const req = Array.isArray(schema.required) ? schema.required : [];
    for (const k of keys) if (!req.includes(k)) errors.push(`${path}.${k}：未列入 required`);
    for (const k of req) if (!keys.includes(k)) errors.push(`${path}：required 含不存在的属性 ${k}`);
    for (const k of keys) checkStrict(props[k], `${path}.${k}`, errors);
  }
  if (types.includes('array')) {
    if (!schema.items) errors.push(`${path}：数组缺少 items`);
    else checkStrict(schema.items, `${path}[]`, errors);
  }
}

test('所有 AI schema 满足严格结构化输出规则', () => {
  assert.ok(Object.keys(ALL_SCHEMAS).length >= 6);
  for (const [name, s] of Object.entries(ALL_SCHEMAS)) {
    const errors = [];
    checkStrict(s, name, errors);
    assert.deepEqual(errors, [], `${name} 不满足严格规则`);
    assert.equal(s.type, 'object', `${name} 顶层必须是 object`);
  }
});

test('schema 能被 JSON 序列化且体积合理', () => {
  for (const [name, s] of Object.entries(ALL_SCHEMAS)) {
    const json = JSON.stringify(s);
    assert.ok(json.length < 60000, `${name} 过大：${json.length}`);
    assert.deepEqual(JSON.parse(json), s);
  }
});

// ---------------------------------------------------------------------------
// normalizeAiOps
// ---------------------------------------------------------------------------
function flat(partial) {
  const f = {};
  for (const k of Object.keys(AI_OP_SCHEMA.properties)) f[k] = null;
  f.indices = []; f.ids = []; f.targetMode = 'selected';
  return { ...f, ...partial };
}

test('normalizeAiOp：扁平字段转为 SPEC §4 Op', () => {
  const c = normalizeAiOp(flat({ type: 'setColor', targetMode: 'index', indices: [2, 2, 3], exposure: 0.3, saturation: 5 }));
  assert.deepEqual(c.target, { mode: 'index', indices: [2, 3], ids: [] });
  assert.equal(c.color.exposure, 0.3);
  assert.equal(c.color.saturation, 1, '越界数值应被夹紧');
  assert.equal(c.relative, false);

  const l = normalizeAiOp(flat({ type: 'setLook', targetMode: 'all', look: 'film-warm', lookStrength: 0.7 }));
  assert.deepEqual(l, { type: 'setLook', target: { mode: 'all', indices: [], ids: [] }, look: 'film-warm', lookStrength: 0.7 });

  const t = normalizeAiOp(flat({ type: 'setTransition', transitionType: 'crossfade', transitionDuration: 0.8 }));
  assert.deepEqual(t.transition, { type: 'crossfade', duration: 0.8 });

  const txt = normalizeAiOp(flat({ type: 'addText', targetMode: 'none', textContent: '新品上市', textStart: 1, textDuration: 2 }));
  assert.equal(txt.target.mode, 'none');
  assert.equal(txt.text.text, '新品上市');

  const pj = normalizeAiOp(flat({ type: 'setProject', aspect: '9:16' }));
  assert.deepEqual(pj.settings, { aspect: '9:16' });
});

test('normalizeAiOps：丢弃非法操作，兼容 §4 形状', () => {
  const ops = normalizeAiOps([
    flat({ type: 'setLook', look: 'not-a-look' }),
    flat({ type: 'unknownOp' }),
    flat({ type: 'setColor', targetMode: 'index', indices: [] , exposure: 0.1 }),
    flat({ type: 'setColor' }),
    flat({ type: 'setSpeed', speed: 2 }),
    { type: 'setMotion', target: { mode: 'selected', indices: [], ids: [] }, preset: 'push-in', intensity: 0.4 },
    null,
    'x',
  ]);
  assert.deepEqual(ops.map((o) => o.type), ['setSpeed', 'setMotion']);
  assert.deepEqual(normalizeAiOps(null), []);
  assert.equal(normalizeAiOps(Array.from({ length: 80 }, () => flat({ type: 'delete' }))).length, 60);
});

test('flattenOp 与 normalizeAiOp 往返一致（所有内置技法）', () => {
  for (const tq of BUILTIN_TECHNIQUES) {
    if (!tq.apply) continue;
    for (const op of tq.apply.ops) {
      const f = flattenOp(op);
      assert.deepEqual(Object.keys(f).sort(), Object.keys(AI_OP_SCHEMA.properties).sort(), `${tq.id} 扁平字段不完整`);
      const back = normalizeAiOp(f);
      assert.ok(back, `${tq.id} 的 ${op.type} 往返后无效`);
      assert.equal(back.type, op.type);
    }
  }
});

test('规范化后的 AI 操作能通过 ops.applyOps（ops.js 存在时）', async (t) => {
  let ops = null;
  try { ops = await import('../src/engine/ops.js'); } catch { ops = null; }
  if (!ops || typeof ops.applyOps !== 'function') { t.skip('ops.js 尚不可用'); return; }
  const p = makeProject(3);
  const list = normalizeAiOps([
    flat({ type: 'setLook', targetMode: 'all', look: 'cinematic', lookStrength: 0.8 }),
    flat({ type: 'setColor', targetMode: 'index', indices: [1], exposure: 0.1, contrast: 0.1 }),
    flat({ type: 'setTransition', targetMode: 'index', indices: [2], transitionType: 'crossfade', transitionDuration: 0.6 }),
    flat({ type: 'setMotion', targetMode: 'ids', ids: ['clp_2'], preset: 'push-in', intensity: 0.5 }),
    flat({ type: 'addText', targetMode: 'none', textContent: '晨光咖啡', textStart: 0, textDuration: 2 }),
    flat({ type: 'applyPacing', targetMode: 'all', pacing: 'fast' }),
  ]);
  assert.equal(list.length, 6);
  const r = ops.applyOps(p, list, { selectedClipIds: [] });
  assert.ok(r.ok, `应用失败：${r.errors.join('；')}`);
});

// ---------------------------------------------------------------------------
// 导演
// ---------------------------------------------------------------------------
function aiShot(partial = {}) {
  return {
    title: '开场', duration: 3, shotSize: 'close-up', angle: 'high', movement: 'push-in', lighting: '窗光', location: '吧台', subject: '奶茶',
    action: '奶盖落下', caption: '', voiceover: '', shootingTips: ['手机竖拿', '用 2x', '开慢动作'], transitionIn: 'cut', look: 'film-warm',
    referenceQueries: ['奶茶 特写', 'bubble tea close up'], techniqueIds: ['bt_hook_3s', 'bt_fake_id'],
    previz: { setting: 'cafe', timeOfDay: 'day', palette: ['#111111', '#e0a96d', '#f4efe6'], subjects: [{ kind: 'cup', x: 0.5, y: 0.7, scale: 1.5, color: '#ffffff', action: 'pour', label: '奶茶' }], light: { direction: 'back', key: 'warm', mood: 'soft' }, overlayText: '' },
    ...partial,
  };
}

test('buildDirectorRequest 结构正确并包含技法 id 与用户消息', () => {
  const req = buildDirectorRequest({ brief: createBrief({ platform: '抖音' }), messages: [{ role: 'user', text: '你好' }], userText: '我想给我的奶茶店拍一个抖音视频', techniques: BUILTIN_TECHNIQUES, assets: {} });
  assert.equal(req.task, 'director');
  assert.equal(req.schema, DIRECTOR_SCHEMA);
  assert.ok(req.system.length > 200);
  assert.ok(req.prompt.includes('奶茶店'));
  assert.ok(req.prompt.includes('bt_hook_3s'));
  assert.ok(req.timeoutMs > 0);
  // 空参数不崩溃
  const empty = buildDirectorRequest();
  assert.ok(empty.prompt.includes('还没有简报'));
});

test('parseDirectorResponse：过滤非法字段、编造的技法 id，并补全分镜', () => {
  const r = parseDirectorResponse({
    reply: '好的', questions: ['发哪个平台？', '', '多长？'],
    briefPatch: { title: '奶茶店', platform: '抖音', aspect: '9:16', duration: 30, look: 'bad-look', pacing: null, mustHave: null, avoid: ['杂乱'], goal: null, audience: null, style: null, mood: null, music: null, keyMessage: null },
    readyForStoryboard: false,
    storyboard: [aiShot({ transitionIn: 'whip-pan', shootingTips: [] }), aiShot({ title: '', shotSize: 'weird', previz: null })],
  }, { brief: createBrief({ look: 'film-warm' }), validTechniqueIds: VALID_IDS });
  assert.deepEqual(r.questions, ['发哪个平台？', '多长？']);
  assert.deepEqual(r.briefPatch, { title: '奶茶店', platform: '抖音', aspect: '9:16', duration: 30, avoid: ['杂乱'] });
  assert.equal(r.storyboard.length, 2);
  assert.equal(r.readyForStoryboard, true);
  const [s1, s2] = r.storyboard;
  assert.equal(s1.transitionIn, 'cut', '第一镜不允许甩镜等转场');
  assert.ok(s1.shootingTips.length >= 3, '缺少拍法时应补全通用拍法');
  assert.deepEqual(s1.techniqueIds, ['bt_hook_3s']);
  assert.equal(s2.title, '镜头 2');
  assert.equal(s2.shotSize, 'medium');
  assert.ok(PREVIZ_SETTINGS.includes(s2.previz.setting));
  assert.equal(s2.previz.camera.shotSize, s2.shotSize);
  const total = r.storyboard.reduce((a, s) => a + s.duration, 0);
  assert.ok(Math.abs(total - 30) / 30 <= 0.2, `总时长应接近 30 秒，实际 ${total}`);
});

test('parseDirectorResponse：完全无效输入也返回安全结构', () => {
  for (const bad of [null, undefined, 'x', 42, [], {}]) {
    const r = parseDirectorResponse(bad);
    assert.equal(typeof r.reply, 'string');
    assert.ok(r.reply.length > 0);
    assert.deepEqual(r.briefPatch, {});
    assert.deepEqual(r.questions, []);
    assert.equal(r.storyboard, null);
    assert.equal(r.readyForStoryboard, false);
  }
});

test('buildStoryboardRequest / parseStoryboardResponse', () => {
  const brief = createBrief({ title: '奶茶', duration: 20, aspect: '9:16', pacing: 'fast', look: 'vivid' });
  const req = buildStoryboardRequest({ brief, techniques: BUILTIN_TECHNIQUES });
  assert.equal(req.task, 'storyboard');
  assert.equal(req.schema, STORYBOARD_SCHEMA);
  assert.ok(req.prompt.includes('手机竖拿'));
  assert.throws(() => parseStoryboardResponse({ shots: [] }), /没有返回任何分镜/);
  const r = parseStoryboardResponse({ reply: '', styleGuide: '统一鲜艳', shots: [aiShot(), aiShot(), aiShot()] }, { brief, validTechniqueIds: VALID_IDS });
  assert.equal(r.shots.length, 3);
  assert.deepEqual(r.shots.map((s) => s.index), [1, 2, 3]);
  assert.equal(r.styleGuide, '统一鲜艳');
  assert.ok(r.reply.includes('3'));
  assert.equal(new Set(r.shots.map((s) => s.id)).size, 3);
});

test('buildShotRefineRequest / parseShotRefineResponse 保留 id、素材与预演', () => {
  const shot = createShot({ id: 'sht_keep', index: 4, title: '原镜头', assetId: 'ast_1', status: 'shot', shootingTips: ['a', 'b', 'c'], techniqueIds: ['bt_orbit'] });
  const req = buildShotRefineRequest({ brief: createBrief(), shot, instruction: '改成仰拍', techniques: BUILTIN_TECHNIQUES });
  assert.equal(req.task, 'shot');
  assert.equal(req.schema, SHOT_SCHEMA);
  assert.ok(req.prompt.includes('改成仰拍'));
  assert.ok(!req.prompt.includes('sht_keep'), '提示词里不应暴露内部 id');
  const out = parseShotRefineResponse({ ...aiShot({ angle: 'low', title: '仰拍版' }), previz: null }, shot, { validTechniqueIds: VALID_IDS });
  assert.equal(out.id, 'sht_keep');
  assert.equal(out.index, 4);
  assert.equal(out.assetId, 'ast_1');
  assert.equal(out.status, 'shot');
  assert.equal(out.angle, 'low');
  assert.equal(out.previz.camera.angle, 'low');
  // 完全无效输入：保留原镜头内容
  const same = parseShotRefineResponse(null, shot);
  assert.equal(same.title, '原镜头');
  assert.deepEqual(same.techniqueIds, ['bt_orbit']);
});

test('normalizeBriefPatch / fitShotDurations / techniqueCatalog 边界', () => {
  assert.deepEqual(normalizeBriefPatch({ duration: 3, platform: '快手', aspect: '2:1', title: '  ' }), { duration: 5 }, '时长被夹到 5–600 秒，非法枚举被丢弃');
  assert.deepEqual(normalizeBriefPatch({ duration: null, title: null }), {});
  assert.deepEqual(normalizeBriefPatch({ duration: '45' }), { duration: 45 });
  assert.deepEqual(fitShotDurations([], 30), []);
  const shots = [createShot({ duration: 10 }), createShot({ duration: 10 })];
  const fitted = fitShotDurations(shots, 10);
  assert.equal(fitted.reduce((a, s) => a + s.duration, 0), 10);
  assert.deepEqual(techniqueCatalog([]), { text: '（无）', ids: [] });
  const s = normalizeAiShot({}, 1);
  assert.ok(s.shootingTips.length >= 3 && s.referenceQueries.length >= 2);
});

// ---------------------------------------------------------------------------
// 本地导演
// ---------------------------------------------------------------------------
test('extractDuration 识别常见中文时长并忽略「前 3 秒」', () => {
  const cases = { '30秒': 30, '一分钟': 60, '一分半': 90, '半分钟': 30, '2分钟': 120, '十五秒': 15, '三十秒左右': 30, '前3秒要抓人，整体45秒': 45, '15s': 15, '没说时长': null };
  for (const [s, v] of Object.entries(cases)) assert.equal(extractDuration(s), v, s);
});

test('extractBriefPatch 抽取平台、画幅、风格、节奏、受众', () => {
  const p = extractBriefPatch('发小红书，竖屏，日系清新一点，快节奏，给大学生看');
  assert.equal(p.platform, '小红书');
  assert.equal(p.aspect, '9:16');
  assert.equal(p.look, 'soft-pastel');
  assert.equal(p.pacing, 'fast');
  assert.ok(p.audience.includes('大学生'));
  assert.deepEqual(extractBriefPatch(''), {});
});

test('detectTopic 覆盖至少 10 个主题', () => {
  const samples = { drink: '奶茶店', food: '火锅店探店', travel: '去大理旅行', product: '新品耳机广告', unboxing: '开箱新手机', vlog: '我的一天 vlog', fitness: '健身打卡', pet: '我家的猫咪', wedding: '婚礼跟拍', tutorial: '教你做蛋糕的教程', fashion: '秋季穿搭' };
  for (const [k, s] of Object.entries(samples)) assert.equal(detectTopic(s), k, s);
  assert.equal(detectTopic('嗯'), null);
  assert.ok(LOCAL_TOPICS.length >= 9 && LOCAL_TOPICS.includes('generic'));
});

test('localDirectorReply：信息不足时提问，信息足够且要求时出分镜', () => {
  const r1 = localDirectorReply({ brief: null, messages: [], userText: '我想给我的奶茶店拍一个抖音视频' });
  assert.equal(r1.briefPatch.platform, '抖音');
  assert.equal(r1.briefPatch.aspect, '9:16');
  assert.ok(r1.questions.length >= 1 && r1.questions.length <= 4);
  assert.ok(r1.questions.some((q) => q.includes('多长')));
  assert.equal(r1.readyForStoryboard, false);
  assert.equal(r1.storyboard, null);
  assert.ok(r1.reply.includes('奶茶店'));

  const r2 = localDirectorReply({
    brief: createBrief(r1.briefPatch),
    messages: [{ role: 'user', text: '我想给我的奶茶店拍一个抖音视频' }, { role: 'assistant', text: r1.reply }],
    userText: '30秒，温暖治愈一点，直接生成分镜',
  });
  assert.equal(r2.briefPatch.duration, 30);
  assert.equal(r2.readyForStoryboard, true);
  assert.ok(Array.isArray(r2.storyboard) && r2.storyboard.length >= 4 && r2.storyboard.length <= 8);
  assert.deepEqual(r2.questions, []);
});

test('localDirectorReply：「你定」时用默认值补全；空输入不崩溃', () => {
  const r = localDirectorReply({ messages: [{ role: 'user', text: '给我的宠物猫拍个视频' }], userText: '你定吧' });
  assert.equal(r.readyForStoryboard, true);
  assert.ok(r.briefPatch.platform && r.briefPatch.duration && r.briefPatch.aspect && r.briefPatch.style);
  const e = localDirectorReply();
  assert.ok(e.reply.length > 0 && e.questions.length >= 1);
  assert.equal(e.storyboard, null);
  // 已填好的简报（示例项目）+「生成分镜」：不再追问默认值，直接出分镜
  const filled = createBrief({ title: '晨光咖啡｜清晨', platform: 'B站', duration: 30, aspect: '16:9', style: '温暖治愈', pacing: 'medium' });
  const f = localDirectorReply({ brief: filled, messages: [], userText: '生成分镜' });
  assert.equal(f.readyForStoryboard, true);
  assert.ok(Array.isArray(f.storyboard) && f.storyboard.length >= 4);
  assert.equal(f.briefPatch.pacing, undefined, '已填好的节奏不应被模板默认值覆盖');
  const shape = Object.keys(parseDirectorResponse({})).sort();
  assert.deepEqual(Object.keys(e).sort(), shape, '本地导演返回形状应与 parseDirectorResponse 一致');
});

function assertValidShot(s, where) {
  assert.ok(s.title && s.action && s.lighting && s.subject, `${where} 文案缺失`);
  assert.ok(SHOT_SIZES.includes(s.shotSize), `${where} 景别`);
  assert.ok(ANGLES.includes(s.angle), `${where} 角度`);
  assert.ok(SHOT_MOVEMENTS.includes(s.movement), `${where} 运镜`);
  assert.ok(TRANSITIONS.includes(s.transitionIn), `${where} 转场`);
  assert.ok(LOOKS.includes(s.look), `${where} 色调`);
  assert.ok(s.shootingTips.length >= 3, `${where} 拍法`);
  assert.ok(s.referenceQueries.length >= 2 && /[一-龥]/.test(s.referenceQueries[0]) && /[a-z]/i.test(s.referenceQueries[1]), `${where} 参考词`);
  assert.ok(s.techniqueIds.length >= 1, `${where} 技法`);
  for (const id of s.techniqueIds) assert.ok(BUILTIN_TECHNIQUE_MAP[id], `${where} 引用了不存在的技法 ${id}`);
  assert.ok(!/\{name\}/.test(JSON.stringify(s)), `${where} 有未替换的占位符`);
  const pv = s.previz;
  assert.ok(PREVIZ_SETTINGS.includes(pv.setting), `${where} 预演场景`);
  assert.ok(['day', 'golden', 'night', 'blue'].includes(pv.timeOfDay), `${where} 时段`);
  assert.equal(pv.palette.length, 3);
  for (const sub of pv.subjects) {
    assert.ok(PREVIZ_SUBJECTS.includes(sub.kind), `${where} 主体 ${sub.kind}`);
    assert.ok(PREVIZ_ACTIONS.includes(sub.action), `${where} 动作 ${sub.action}`);
  }
  assert.deepEqual(pv.camera, { shotSize: s.shotSize, movement: s.movement, angle: s.angle });
  assert.ok(['left', 'right', 'top', 'back', 'front'].includes(pv.light.direction), `${where} 光向`);
  assert.ok(['warm', 'cool', 'neutral'].includes(pv.light.key));
  assert.ok(['bright', 'soft', 'dramatic', 'night'].includes(pv.light.mood));
}

test('localStoryboard：每个主题 × 多种时长都生成 4–8 个完整分镜', () => {
  const titles = { drink: '奶茶店', food: '美食探店', travel: '旅行', product: '产品广告', unboxing: '开箱', vlog: 'vlog', fitness: '健身', pet: '宠物猫', wedding: '婚礼', tutorial: '教程', fashion: '穿搭', generic: '我的短片' };
  for (const topic of LOCAL_TOPICS) {
    for (const [duration, pacing, aspect] of [[8, 'fast', '9:16'], [30, 'medium', '16:9'], [90, 'slow', '1:1']]) {
      const r = localStoryboard({ title: titles[topic], duration, pacing, aspect });
      const where = `${topic}/${duration}s`;
      assert.ok(r.shots.length >= 4 && r.shots.length <= 8, `${where} 镜头数 ${r.shots.length}`);
      const total = r.shots.reduce((a, s) => a + s.duration, 0);
      assert.ok(Math.abs(total - duration) < 0.5, `${where} 总时长 ${total}`);
      r.shots.forEach((s, i) => { assert.equal(s.index, i + 1); assertValidShot(s, `${where} 第 ${i + 1} 镜`); });
      assert.ok(['cut', 'dip-black', 'dip-white', 'crossfade'].includes(r.shots[0].transitionIn));
      if (aspect === '9:16') assert.ok(r.shots[0].shootingTips[0].includes('竖'), `${where} 竖屏提示`);
      assert.ok(r.styleGuide.length > 20 && r.reply.length > 10);
    }
  }
  // 空简报也能出
  const r = localStoryboard();
  assert.ok(r.shots.length >= 4);
  // 色调沿用简报
  assert.ok(localStoryboard({ title: '奶茶', look: 'cyberpunk' }).shots.every((s) => s.look === 'cyberpunk'));
});

// ---------------------------------------------------------------------------
// 拆片
// ---------------------------------------------------------------------------
function makeAnalysis({ n = 12, shotLen = 1.2, motion = 0.6, color = {}, peaks } = {}) {
  const shots = Array.from({ length: n }, (_, i) => ({
    index: i, start: i * shotLen, end: (i + 1) * shotLen, duration: shotLen, motion, loudness: 0.5,
    stats: { luma: 0.4, contrast: 0.4, saturation: 0.3, warmth: 0, tint: 0, palette: ['#334455'] }, ai: null,
  }));
  return {
    id: 'ana_1', title: '参考视频', category: 'ad', duration: n * shotLen, width: 1080, height: 1920,
    shots, rhythm: { avgShot: shotLen, medianShot: shotLen, cutsPerMinute: 60 / shotLen, durations: shots.map(() => shotLen) },
    audio: { curve: [], peaks: peaks || shots.slice(1, 6).map((s) => s.start) },
    transcript: [{ start: 0, end: 2, text: '你知道吗' }],
    colorProfile: { luma: 0.4, contrast: 0.4, saturation: 0.3, warmth: 0, tint: 0, palette: ['#334455', '#aa8866'], ...color },
    contactSheets: ['C:/tmp/sheet1.jpg'], contactSheetShots: [shots.map((s) => s.index)], techniqueIds: [], ai: null,
  };
}

function assertValidTechnique(t, analysis) {
  assert.match(t.id, /^tq_/);
  assert.ok(TECHNIQUE_CATEGORIES.includes(t.category));
  assert.ok(t.title && t.summary && t.whenToUse);
  assert.ok(t.steps.length >= 3);
  assert.equal(t.builtin, false);
  assert.equal(t.source.analysisId, analysis.id);
  assert.ok(t.source.start >= 0 && t.source.end >= t.source.start && t.source.end <= analysis.duration + 0.01, `时间段 ${t.source.start}-${t.source.end}`);
  if (t.apply) assert.ok(t.apply.ops.length >= 1 && t.apply.ops.every((o) => o.target.mode === 'selected'));
}

test('localAnalyzeTechniques：快节奏 + 高饱和 + 卡点', () => {
  const a = makeAnalysis({ n: 16, shotLen: 1.2, motion: 0.7, color: { saturation: 0.62, warmth: 0.15 } });
  const cards = localAnalyzeTechniques(a);
  assert.ok(cards.length >= 2 && cards.length <= 4, `数量 ${cards.length}`);
  cards.forEach((c) => assertValidTechnique(c, a));
  assert.ok(cards.some((c) => c.category === 'rhythm' && c.title.includes('卡点')));
  assert.ok(cards.some((c) => c.category === 'color'));
  assert.ok(cards.some((c) => c.category === 'sound'));
});

test('localAnalyzeTechniques：长镜头 + 暗调 + 冷调', () => {
  const a = makeAnalysis({ n: 4, shotLen: 6, motion: 0.05, color: { luma: 0.2, warmth: -0.2 }, peaks: [] });
  const cards = localAnalyzeTechniques(a);
  assert.ok(cards.length >= 2 && cards.length <= 4);
  cards.forEach((c) => assertValidTechnique(c, a));
  assert.ok(cards.some((c) => c.title.includes('长镜头')));
  assert.ok(cards.some((c) => c.title.includes('暗调') || c.title.includes('冷调')));
});

test('localAnalyzeTechniques：缺字段/空数据不编造', () => {
  assert.deepEqual(localAnalyzeTechniques(null), []);
  assert.deepEqual(localAnalyzeTechniques({}), []);
  assert.deepEqual(localAnalyzeTechniques({ id: 'x', shots: [] }), []);
  const neutral = makeAnalysis({ n: 8, shotLen: 3, motion: 0.3, peaks: [] });
  const cards = localAnalyzeTechniques(neutral);
  assert.ok(cards.length >= 1 && cards.length <= 4);
  cards.forEach((c) => assertValidTechnique(c, neutral));
});

test('本地技法卡的 apply.ops 能通过 ops.applyOps（ops.js 存在时）', async (t) => {
  let ops = null;
  try { ops = await import('../src/engine/ops.js'); } catch { ops = null; }
  if (!ops || typeof ops.applyOps !== 'function') { t.skip('ops.js 尚不可用'); return; }
  const p = makeProject(3);
  const variants = [
    makeAnalysis({ n: 16, shotLen: 1.2, motion: 0.7, color: { saturation: 0.62, warmth: 0.15, contrast: 0.7 } }),
    makeAnalysis({ n: 4, shotLen: 6, motion: 0.05, color: { luma: 0.2, warmth: -0.2, saturation: 0.1 }, peaks: [] }),
    makeAnalysis({ n: 8, shotLen: 3, motion: 0.3, peaks: [] }),
  ];
  const failures = [];
  for (const a of variants) {
    for (const card of localAnalyzeTechniques(a)) {
      if (!card.apply) continue;
      const r = ops.applyOps(p, card.apply.ops, { selectedClipIds: ['clp_1', 'clp_2'] });
      if (!r.ok) failures.push(`${card.title}：${r.errors.join('；')}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('buildAnalyzeRequest：带联系表与镜头列表；无图时诚实降级', () => {
  const a = makeAnalysis();
  const req = buildAnalyzeRequest({ analysis: a });
  assert.equal(req.task, 'analyze');
  assert.equal(req.schema, ANALYZE_SCHEMA);
  assert.deepEqual(req.images, ['C:/tmp/sheet1.jpg']);
  assert.ok(req.prompt.includes('index 0') && req.prompt.includes('index 11'));
  assert.ok(req.prompt.includes('你知道吗'));
  const noImg = buildAnalyzeRequest({ analysis: { ...a, contactSheets: [] } });
  assert.deepEqual(noImg.images, []);
  assert.ok(noImg.prompt.includes('没有关键帧图片'));
  assert.throws(() => buildAnalyzeRequest({}), /没有可分析/);
});

test('mergeAnalyzeResponse：合入镜头标注与技法卡', () => {
  const a = makeAnalysis({ n: 3, shotLen: 2 });
  const data = {
    summary: '一条奶茶广告', style: '暖调快剪', highlights: ['0:01 甩镜'],
    structure: [{ label: '钩子', start: 0, end: 2, description: '开场' }, { label: '收尾', start: 4, end: 99, description: '' }],
    shots: [0, 1, 2].map((i) => ({ index: i, shotSize: i === 1 ? 'bogus' : 'close-up', angle: 'low', movement: 'handheld', lighting: '逆光', composition: '居中', subject: '杯子', transitionIn: 'cut', purpose: '钩子', notes: '' })),
    techniques: [
      { category: 'transition', title: '甩镜接场', summary: '用甩镜连接。', steps: ['a', 'b', 'c'], whenToUse: '换场景', tags: ['甩镜'], start: 0.5, end: 1.5, ops: [flat({ type: 'setTransition', targetMode: 'all', transitionType: 'whip-pan', transitionDuration: 0.3 })], applyNote: '加甩镜' },
      { category: 'bogus', title: '', summary: '', steps: [], whenToUse: '', tags: [], start: 0, end: 1, ops: [], applyNote: null },
    ],
  };
  const { analysis, techniques } = mergeAnalyzeResponse(a, data);
  assert.equal(analysis.shots[0].ai.shotSize, 'close-up');
  assert.equal(analysis.shots[1].ai.shotSize, 'medium', '非法景别回退默认');
  assert.equal(analysis.ai.summary, '一条奶茶广告');
  assert.equal(analysis.ai.structure[1].end, a.duration, '结构时间被夹到视频时长内');
  assert.equal(techniques.length, 1);
  const t = techniques[0];
  assertValidTechnique(t, a);
  assert.equal(t.apply.ops[0].target.mode, 'selected');
  assert.deepEqual(analysis.techniqueIds, [t.id]);
  // index 对不上且数量不同：不编造
  const m2 = mergeAnalyzeResponse(a, { shots: [{ index: 99, shotSize: 'wide' }] });
  assert.ok(m2.analysis.shots.every((s) => s.ai === null));
  // 无效数据
  const m3 = mergeAnalyzeResponse(a, null);
  assert.deepEqual(m3.techniques, []);
  assert.equal(m3.analysis.shots.length, 3);
});

// ---------------------------------------------------------------------------
// 编辑（editor.js 依赖 D 组 summary.js，缺失时跳过）
// ---------------------------------------------------------------------------
function makeProject(n) {
  const p = createProject({ name: '精修测试' });
  const assets = Array.from({ length: n }, (_, i) => createAsset({ id: `ast_${i + 1}`, name: `素材${i + 1}.mp4`, duration: 8, hasAudio: true, stats: { luma: 0.4, contrast: 0.4, saturation: 0.3, warmth: 0, tint: 0, palette: ['#334455'] } }));
  p.assets = Object.fromEntries(assets.map((a) => [a.id, a]));
  p.tracks.video = assets.map((a, i) => createClip(a, { id: `clp_${i + 1}`, in: 0, out: 3 }));
  return p;
}

async function loadEditor(t) {
  try {
    return await import('../src/ai/editor.js');
  } catch (e) {
    t.skip(`editor.js 依赖暂不可用：${e.message}`);
    return null;
  }
}

test('buildEditRequest：包含时间线、选中与锁定信息', async (t) => {
  const ed = await loadEditor(t); if (!ed) return;
  const p = makeProject(3);
  p.tracks.video[2].locked = true;
  const req = ed.buildEditRequest({ project: p, command: '整体调成电影感', selection: ['clp_2'], techniques: BUILTIN_TECHNIQUES });
  assert.equal(req.task, 'edit');
  assert.equal(req.schema, EDIT_SCHEMA);
  assert.ok(req.prompt.includes('整体调成电影感'));
  assert.ok(req.prompt.includes('clp_2'));
  assert.ok(req.prompt.includes('锁定'));
  const empty = ed.buildEditRequest({ project: createProject({}), command: '' });
  assert.equal(typeof empty.prompt, 'string');
});

test('parseEditResponse：过滤越界编号、锁定镜头、未知素材', async (t) => {
  const ed = await loadEditor(t); if (!ed) return;
  const p = makeProject(3);
  p.tracks.video[1].locked = true;
  const r = ed.parseEditResponse({
    reply: '已调整',
    ops: [
      flat({ type: 'setLook', targetMode: 'all', look: 'cinematic', lookStrength: 1 }),
      flat({ type: 'setColor', targetMode: 'index', indices: [2], exposure: 0.2 }),
      flat({ type: 'setColor', targetMode: 'index', indices: [9], exposure: 0.2 }),
      flat({ type: 'replaceAsset', targetMode: 'index', indices: [1], assetId: 'ast_missing' }),
      flat({ type: 'insertAsset', targetMode: 'none', assetId: 'lib_9', atIndex: 2 }),
      flat({ type: 'removeText', targetMode: 'none', textId: 'txt_nope' }),
    ],
    materialRequests: [{ query: '城市夜景 延时', purpose: '结尾', atIndex: 4, duration: 3 }, { query: '', purpose: '', atIndex: null, duration: null }],
    memoryNote: '用户喜欢电影感',
  }, p, { libraryAssets: [{ id: 'lib_9', name: '库素材', kind: 'video', duration: 5 }], selection: [] });
  assert.deepEqual(r.ops.map((o) => o.type), ['setLook', 'insertAsset']);
  assert.deepEqual(r.ops[0].target, { mode: 'index', indices: [1, 3], ids: [] }, '锁定的第 2 镜被剔除');
  assert.equal(r.assetsToAdd.length, 1);
  assert.equal(r.materialRequests.length, 1);
  assert.equal(r.memoryNote, '用户喜欢电影感');
  assert.ok(r.warnings.length >= 3);
  assert.ok(r.reply.includes('锁定'));
  const bad = ed.parseEditResponse(null, null);
  assert.deepEqual(bad.ops, []);
  assert.ok(bad.reply.length > 0);
});

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------
test('runAI：非桌面环境抛 NoAIError；runWithFallback 回退本地', async () => {
  const req = buildDirectorRequest({ userText: '你好' });
  await assert.rejects(() => runAI(req), (e) => isNoAI(e) && e instanceof NoAIError && e.code === 'NO_AI');
  await assert.rejects(() => runAI({ prompt: 'x' }), /schema/);
  const r = await runWithFallback(req, parseDirectorResponse, () => localDirectorReply({ userText: '你好' }));
  assert.equal(r.fallback, true);
  assert.equal(r.provider, 'local');
  assert.ok(r.result.reply);
});

test('runAI：模拟主进程的成功、取消、超时与 NO_AI', async () => {
  const saved = { available: api.available, job: api.job };
  try {
    api.available = true;
    let seen = null;
    api.job = async (channel, payload) => { seen = { channel, payload }; return { data: { reply: 'ok' }, provider: 'codex', model: 'gpt', ms: 12 }; };
    const ok = await runAI({ task: 'director', system: 's', prompt: 'p', schema: DIRECTOR_SCHEMA, images: ['a.jpg', '', 3] });
    assert.equal(seen.channel, 'ai:run');
    assert.deepEqual(seen.payload.images, ['a.jpg']);
    assert.ok(seen.payload.timeoutMs > 0);
    assert.deepEqual(ok, { data: { reply: 'ok' }, provider: 'codex', model: 'gpt', ms: 12 });

    api.job = async () => { const e = new Error('cancelled'); e.cancelled = true; throw e; };
    await assert.rejects(() => runAI({ task: 'edit', prompt: 'p', schema: EDIT_SCHEMA }), (e) => isCancelled(e) && e.message === '已取消');

    api.job = async () => { throw new Error('Request timed out after 180000ms'); };
    await assert.rejects(() => runAI({ task: 'edit', prompt: 'p', schema: EDIT_SCHEMA }), /超时/);

    api.job = async () => { const e = new Error('没有可用的 AI'); e.code = 'NO_AI'; throw e; };
    await assert.rejects(() => runAI({ task: 'edit', prompt: 'p', schema: EDIT_SCHEMA }), (e) => isNoAI(e));

    api.job = async () => 'not json';
    await assert.rejects(() => runAI({ task: 'edit', prompt: 'p', schema: EDIT_SCHEMA }), /不是有效的 JSON/);
  } finally {
    api.available = saved.available;
    api.job = saved.job;
  }
});
