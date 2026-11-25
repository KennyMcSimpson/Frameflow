// AI 安全护栏单元测试：budget（调用预算）、diff（改动对比与确认规则）、lint（操作预检）、memory（结构化项目记忆）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LLM_BUDGET, BudgetExceededError, isBudgetExceeded, budgetLimit, createBudget, withBudget,
} from '../src/ai/budget.js';
import { diffProject, summarizeDiff, needsConfirm, CONFIRM_RULES } from '../src/ai/diff.js';
import {
  LINT_CODES, friendlyMessage, classifyOpError, lintOps, repairableDiagnostics, skippedLines,
} from '../src/ai/lint.js';
import {
  looksLikeRule, ruleFromCommand, normalizeMemoryEntry, memoryEntries,
  compactMemory, addMemory, setMemoryKind, memoryPromptBlock,
} from '../src/ai/memory.js';
import { createProject, createAsset, createClip, createTextClip, createMarker } from '../src/engine/model.js';
import { applyOps } from '../src/engine/ops.js';

function makeProject(n = 4) {
  const p = createProject({ name: '安全测试' });
  for (let i = 0; i < n; i += 1) {
    const a = createAsset({
      id: `a${i + 1}`,
      kind: 'video',
      name: `片段${i + 1}.mp4`,
      duration: 10,
      hasAudio: true,
      stats: { luma: 0.25 + i * 0.15, contrast: 0.4, saturation: 0.4, warmth: 0, tint: 0, palette: ['#334455'] },
    });
    p.assets[a.id] = a;
    p.tracks.video.push(createClip(a, { id: `c${i + 1}`, in: 0, out: 4 }));
  }
  return p;
}

// ───────────────────────── budget.js ─────────────────────────

test('budget：额度计数、超限抛 BudgetExceededError 且不执行底层调用', async () => {
  assert.equal(LLM_BUDGET.edit, 2);
  assert.equal(budgetLimit('edit'), 2);
  assert.equal(budgetLimit('unknown_action'), 1);

  const b = createBudget('edit');
  assert.equal(b.used, 0);
  assert.equal(b.remaining(), 2);
  assert.equal(b.canSpend(2), true);
  assert.equal(b.spend('understand'), 1);
  assert.equal(b.spend('repair'), 2);
  assert.equal(b.remaining(), 0);
  assert.equal(b.canSpend(), false);
  assert.deepEqual(b.calls(), ['understand', 'repair']);
  assert.throws(() => b.spend('extra'), (e) => e instanceof BudgetExceededError && isBudgetExceeded(e) && e.code === 'LLM_BUDGET');

  let called = 0;
  const b2 = createBudget('director', 1);
  const wrapped = withBudget(b2, async (x) => { called += 1; return x * 2; }, 'chat');
  assert.equal(await wrapped(21), 42);
  await assert.rejects(() => wrapped(99), (e) => isBudgetExceeded(e));
  assert.equal(called, 1, '超出预算时绝不能再调用 fn');
});

// ───────────────────────── diff.js ─────────────────────────

test('diffProject & summarizeDiff：无改动、片段/文字/画幅/标记（markers）差异', () => {
  const before = makeProject(3);
  const same = diffProject(before, before);
  assert.equal(same.empty, true);
  assert.deepEqual(summarizeDiff(same), ['没有实际改动']);

  // 标记（markers）新增、修改、删除
  const withMarker = applyOps(before, [{ type: 'addMarker', t: 2, label: '高潮' }]).project;
  const dAdd = diffProject(before, withMarker);
  assert.equal(dAdd.empty, false);
  assert.equal(dAdd.markers.added.length, 1);
  assert.equal(dAdd.markers.added[0].name, '高潮');
  assert.ok(summarizeDiff(dAdd).some((l) => l.includes('标记：新增 1 条')));

  const markerId = withMarker.markers[0].id;
  const modMarker = {
    ...withMarker,
    markers: [createMarker({ id: markerId, t: 3, label: '高潮点', color: '#ff0000' })],
  };
  const dMod = diffProject(withMarker, modMarker);
  assert.equal(dMod.markers.changed.length, 1);
  assert.deepEqual(dMod.markers.changed[0].fields.sort(), ['名称', '时间', '颜色'].sort());
  assert.ok(summarizeDiff(dMod).some((l) => l.includes('标记：修改 1 条')));

  const dDel = diffProject(withMarker, before);
  assert.equal(dDel.markers.removed.length, 1);
  assert.ok(summarizeDiff(dDel).some((l) => l.includes('标记：删除 1 条')));

  // 画幅变化 + 文字新增 + 顺序重排
  const mutated = {
    ...before,
    settings: { ...before.settings, aspect: '9:16' },
    tracks: {
      ...before.tracks,
      video: [before.tracks.video[1], before.tracks.video[0], before.tracks.video[2]],
      text: [createTextClip({ id: 't1', start: 0, duration: 2, text: '标题' })],
    },
  };
  const dMulti = diffProject(before, mutated);
  assert.equal(dMulti.clips.reordered, true);
  assert.deepEqual(dMulti.aspect, { from: '16:9', to: '9:16' });
  assert.equal(dMulti.texts.added.length, 1);
  const summary = summarizeDiff(dMulti);
  assert.ok(summary.includes('调整了片段顺序'));
  assert.ok(summary.some((l) => l.includes('画幅：16:9 → 9:16')));
});

test('needsConfirm：高影响改动需要确认，harmonize 统一全片色调免确认', () => {
  const before = makeProject(4);

  // 1. 删除 ≥3 个片段需要确认；删除 1 个不需要
  assert.equal(CONFIRM_RULES.removeClips, 3);
  const del3 = { ...before, tracks: { ...before.tracks, video: [before.tracks.video[0]] } };
  const cDel3 = needsConfirm({ before, after: del3 });
  assert.equal(cDel3.need, true);
  assert.ok(cDel3.reasons.some((r) => r.includes('删除 3 个片段')));

  // 2. 全片 setLook 需要确认
  const setLookAll = applyOps(before, [{ type: 'setLook', target: { mode: 'all', indices: [], ids: [] }, look: 'cinematic', lookStrength: 0.8 }]).project;
  const cLook = needsConfirm({ ops: [{ type: 'setLook', target: { mode: 'all', indices: [], ids: [] }, look: 'cinematic' }], before, after: setLookAll });
  assert.equal(cLook.need, true);
  assert.ok(cLook.reasons.some((r) => r.includes('调色')));

  // 3. harmonize 即使改动全部 ≥3 个片段的调色，也不应触发全片调色确认（豁免）
  const harmOp = { type: 'harmonize', target: { mode: 'all', indices: [], ids: [] }, strength: 0.8 };
  const harmAfter = applyOps(before, [harmOp]).project;
  const harmDiff = diffProject(before, harmAfter);
  assert.ok(harmDiff.clips.changed.length >= 3, 'harmonize 实际修改了至少 3 个片段调色');
  const cHarm = needsConfirm({ ops: [harmOp], before, after: harmAfter, diff: harmDiff });
  assert.equal(cHarm.need, false, `harmonize 不应触发确认，实际原因：${cHarm.reasons.join('；')}`);

  // 4. 全片转场 / 解锁 / 清空字幕 / 改画幅均需确认
  assert.equal(needsConfirm({ ops: [{ type: 'setTransitionAll', transition: { type: 'crossfade', duration: 0.5 } }], before }).need, true);
  assert.equal(needsConfirm({ ops: [{ type: 'unlock', target: { mode: 'index', indices: [1], ids: [] } }], before }).need, true);
  assert.equal(needsConfirm({ ops: [{ type: 'clearCaptions' }], before }).need, true);
  assert.equal(needsConfirm({ ops: [{ type: 'setProject', settings: { aspect: '9:16' } }], before }).need, true);
});

// ───────────────────────── lint.js ─────────────────────────

test('lint：报错分类、友好文案、部分应用、结构依赖跳过与时间越界检查', () => {
  assert.ok(LINT_CODES.locked && LINT_CODES.dependency);
  assert.equal(friendlyMessage('第2镜镜头不存在（共3镜）'), '第 2 个片段片段不存在（共 3 个片段）');
  assert.equal(classifyOpError('第 2 镜已锁定'), 'locked');
  assert.equal(classifyOpError('找不到素材（ast_x），它可能还没有加入项目'), 'missing_asset');
  assert.equal(classifyOpError('第9镜不存在（当前共 3 镜）'), 'out_of_range');
  assert.equal(classifyOpError('请先选中要修改的镜头'), 'no_target');
  assert.equal(classifyOpError('主轨最多 200 段'), 'limit');

  const p = makeProject(3);
  p.tracks.video[1].locked = true;

  // 混合操作：有效操作通过、锁定操作不可自动修复、越界编号可修复、超出总时长被拦截
  const res = lintOps(p, [
    { type: 'setLook', target: { mode: 'index', indices: [1], ids: [] }, look: 'film-warm', lookStrength: 0.7 },
    { type: 'setLook', target: { mode: 'index', indices: [2], ids: [] }, look: 'bw', lookStrength: 1 },
    { type: 'setColor', target: { mode: 'index', indices: [9], ids: [] }, color: { exposure: 0.2 } },
    { type: 'addMarker', t: 99, label: '太远了' },
  ]);
  assert.equal(res.ok, false);
  assert.deepEqual(res.passIndex, [0]);
  assert.equal(res.project.tracks.video[0].color.look, 'film-warm');
  assert.equal(res.project.tracks.video[1].color.look, 'none');
  assert.equal(res.diagnostics.length, 3);
  assert.equal(res.diagnostics[0].code, 'locked');
  assert.equal(res.diagnostics[0].repairable, false);
  assert.equal(res.diagnostics[1].code, 'out_of_range');
  assert.equal(res.diagnostics[1].repairable, true);
  assert.equal(res.diagnostics[2].code, 'out_of_range');
  assert.equal(repairableDiagnostics(res.diagnostics).length, 2);
  assert.equal(skippedLines(res.diagnostics, (d) => `第 ${d.opIndex + 1} 步`).length, 3);

  // 结构性操作失败后，后续按编号定位的操作因 dependency 跳过
  const dep = lintOps(p, [
    { type: 'delete', target: { mode: 'index', indices: [2], ids: [] } }, // 第 2 镜锁定 → 失败
    { type: 'setColor', target: { mode: 'index', indices: [3], ids: [] }, color: { exposure: 0.1 } },
  ]);
  assert.equal(dep.diagnostics.length, 2);
  assert.equal(dep.diagnostics[1].code, 'dependency');
  assert.equal(dep.diagnostics[1].repairable, false);

  // 空项目安全处理
  const noProj = lintOps(null, [{ type: 'addMarker', t: 1, label: 'x' }]);
  assert.equal(noProj.ok, false);
  assert.equal(noProj.diagnostics[0].code, 'precondition');
});

// ───────────────────────── memory.js ─────────────────────────

test('memory：规矩识别、去重升级、压缩不删规矩与提示词输出', () => {
  assert.equal(looksLikeRule('以后都不要用转场'), true);
  assert.equal(looksLikeRule('把第一段调暖了一点'), false);
  assert.equal(ruleFromCommand('以后都不要用转场'), '以后都不要用转场');
  assert.equal(ruleFromCommand('把第 2 段调暖一点'), null);
  assert.equal(ruleFromCommand('短'), null);

  assert.equal(normalizeMemoryEntry(null), null);
  assert.equal(normalizeMemoryEntry('   '), null);
  const r0 = normalizeMemoryEntry('不要使用甩镜转场');
  assert.equal(r0.kind, 'rule');
  const n0 = normalizeMemoryEntry({ text: '第一段加了胶片颗粒', at: '2026-01-01T00:00:00Z' });
  assert.equal(n0.kind, 'note');

  // 去重并刷新，note 可升级为 rule
  let list = addMemory([], { text: '全片用暖调胶片', kind: 'note', at: '2026-01-01T00:00:00Z' });
  list = addMemory(list, { text: '全片用暖调胶片！', kind: 'rule', at: '2026-01-02T00:00:00Z' });
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, 'rule');
  assert.equal(list[0].at, '2026-01-02T00:00:00Z');

  // setMemoryKind 切换类型
  const toggled = setMemoryKind(list, list[0].id, 'note');
  assert.equal(toggled[0].kind, 'note');

  // compactMemory：超过上限时只合并旧 note，所有 rule 一条不动
  const entries = [
    { id: 'r1', kind: 'rule', text: '禁止使用白场转场', at: '2026-01-01' },
    { id: 'r2', kind: 'rule', text: '始终保留原声', at: '2026-01-01' },
    ...Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, kind: 'note', text: `第 ${i} 次调色暖一点`, at: `2026-01-${String(i + 2).padStart(2, '0')}` })),
  ];
  const compacted = compactMemory(entries, { maxNotes: 6, keepRecent: 4 });
  const rules = compacted.filter((e) => e.kind === 'rule');
  const digest = compacted.find((e) => e.digest);
  const keptNotes = compacted.filter((e) => e.kind === 'note' && !e.digest);
  assert.equal(rules.length, 2, '所有规矩必须完整保留');
  assert.equal(keptNotes.length, 4);
  assert.ok(digest && digest.count === 6 && digest.text.includes('调色 6 条'));

  // setMemoryKind 不会破坏 digest
  assert.equal(setMemoryKind(compacted, digest.id, 'rule').find((e) => e.digest).kind, 'note');

  // memoryPromptBlock 输出规矩、最近记录与较早摘要
  const block = memoryPromptBlock({ decisions: compacted }, { maxNotes: 2 });
  assert.ok(block.includes('禁止使用白场转场'));
  assert.ok(block.includes('始终保留原声'));
  assert.ok(block.includes('较早的 6 条记录已合并'));
  assert.ok(block.includes('另有 2 条较早的记录没有列出'));
  assert.equal(memoryEntries({ decisions: compacted }).length, compacted.length);
});
