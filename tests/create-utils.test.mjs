import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createShot, createBrief, createPrevizSpec } from '../src/engine/model.js';
import {
  normalizeShot, normalizeShots, reindexShots, deriveStatus, shotBadges, withShotPatch, withReferences, linkPreviz,
  moveShotTo, moveShotBy, duplicateShot, insertShotAfter, removeShot, cleanBriefPatch, baseBrief, nextStyleGuide,
  applyStoryboard, pickSources, shotQueries, buildSearchPlan, normalizeThumbUrl, resultKey, mergeResults,
  findAssetForResult, guessCategory, imageSizeForAspect, buildImagePrompt, boardStats, mediaLayout, frameSize,
  summarizeReport, isQuestionLike, parseInline, parseMarkdownLite,
} from '../src/ui/modes/create/createUtils.js';

const board = (n = 3) => normalizeShots(Array.from({ length: n }, (_, i) => ({ title: `镜${i + 1}` })));
const projectWith = (shots) => ({ ...createProject(), storyboard: shots });

test('normalizeShot 夹回非法枚举与时长，并保留额外字段', () => {
  const s = normalizeShot({ shotSize: '乱写', angle: 'x', movement: 'y', transitionIn: 'z', look: 'q', duration: 999, previzAssetId: 'ast_1', shootingTips: ['  站稳 ', '', null] }, 2);
  assert.equal(s.shotSize, 'medium');
  assert.equal(s.angle, 'eye-level');
  assert.equal(s.movement, 'static');
  assert.equal(s.transitionIn, 'cut');
  assert.equal(s.look, 'none');
  assert.equal(s.duration, 60);
  assert.equal(s.index, 2);
  assert.equal(s.title, '镜头 2');
  assert.equal(s.previzAssetId, 'ast_1');
  assert.deepEqual(s.shootingTips, ['站稳']);
});

test('normalizeShot 把分镜的景别运镜同步到预演摄影机', () => {
  const s = normalizeShot({ shotSize: 'close-up', movement: 'orbit', angle: 'low', previz: { setting: '火星', subjects: [{ kind: '外星人', action: 'fly', scale: 99 }] } });
  assert.deepEqual(s.previz.camera, { shotSize: 'close-up', movement: 'orbit', angle: 'low' });
  assert.equal(s.previz.setting, 'studio');
  assert.equal(s.previz.subjects[0].kind, 'person');
  assert.equal(s.previz.subjects[0].action, 'idle');
  assert.equal(s.previz.subjects[0].scale, 2);
});

test('normalizeShots 处理空输入与重复 id', () => {
  assert.deepEqual(normalizeShots(null), []);
  const list = normalizeShots([{ id: 'a' }, { id: 'a' }, null, {}]);
  assert.equal(list.length, 3);
  assert.equal(new Set(list.map((s) => s.id)).size, 3);
  assert.deepEqual(list.map((s) => s.index), [1, 2, 3]);
});

test('状态优先级：素材 > 预演 > 参考 > 已规划；失效的资产 id 不算', () => {
  const assets = { a: {}, p: {} };
  assert.equal(deriveStatus({ assetId: 'a', previzAssetId: 'p' }, [1], assets), 'has-footage');
  assert.equal(deriveStatus({ previzAssetId: 'p' }, [1], assets), 'has-previz');
  assert.equal(deriveStatus({}, [1], assets), 'has-reference');
  assert.equal(deriveStatus({}, [], assets), 'planned');
  assert.equal(deriveStatus({ assetId: 'gone' }, null, assets), 'planned');
  assert.deepEqual(shotBadges({ assetId: 'a', previzAssetId: 'p' }, [1], assets), ['has-footage', 'has-previz', 'has-reference']);
  assert.deepEqual(shotBadges({}, null, assets), ['planned']);
});

test('withShotPatch 不改 id/序号，并同步预演资产', () => {
  const shots = board(2);
  const asset = { id: 'p1', kind: 'previz', previz: shots[0].previz, duration: 4 };
  const project = { ...projectWith(shots.map((s, i) => (i === 0 ? { ...s, previzAssetId: 'p1' } : s))), assets: { p1: asset } };
  const spec = createPrevizSpec({ setting: 'cafe' });
  const next = withShotPatch(project, shots[0].id, { id: 'evil', index: 9, duration: 7, previz: spec });
  assert.equal(next.storyboard[0].id, shots[0].id);
  assert.equal(next.storyboard[0].index, 1);
  assert.equal(next.storyboard[0].status, 'has-previz');
  assert.equal(next.assets.p1.previz, spec);
  assert.equal(next.assets.p1.duration, 7);
  assert.equal(project.assets.p1.duration, 4, '不修改原对象');
  assert.equal(withShotPatch(project, 'nope', {}), null);
});

test('withReferences 写入结果并更新状态；linkPreviz 不动 assetId', () => {
  const shots = board(1);
  const project = projectWith(shots);
  const withRefs = withReferences(project, shots[0].id, [{ url: 'u' }]);
  assert.equal(withRefs.storyboard[0].status, 'has-reference');
  const linked = linkPreviz(withRefs, shots[0].id, { id: 'p1', kind: 'previz' });
  assert.equal(linked.storyboard[0].previzAssetId, 'p1');
  assert.equal(linked.storyboard[0].assetId, null);
  assert.equal(linked.storyboard[0].status, 'has-previz');
  assert.ok(linked.assets.p1);
});

test('移动分镜重排序号，越界夹紧，原地不动返回原数组', () => {
  const shots = board(3);
  const moved = moveShotBy(shots, shots[0].id, 1);
  assert.deepEqual(moved.map((s) => s.title), ['镜2', '镜1', '镜3']);
  assert.deepEqual(moved.map((s) => s.index), [1, 2, 3]);
  assert.deepEqual(moveShotTo(shots, shots[0].id, 99).map((s) => s.title), ['镜2', '镜3', '镜1']);
  assert.equal(moveShotBy(shots, shots[0].id, -1), shots);
  assert.equal(moveShotBy(shots, 'nope', 1), shots);
});

test('复制分镜：新 id、紧跟原镜、不共用预演资产、不共享引用', () => {
  const shots = board(2).map((s, i) => (i === 0 ? { ...s, previzAssetId: 'p1', status: 'has-previz' } : s));
  const { shots: next, shotId } = duplicateShot(shots, shots[0].id);
  assert.equal(next.length, 3);
  assert.equal(next[1].id, shotId);
  assert.notEqual(shotId, shots[0].id);
  assert.equal(next[1].previzAssetId, undefined);
  assert.equal(next[1].status, 'planned');
  assert.notEqual(next[1].previz, shots[0].previz);
  assert.deepEqual(next.map((s) => s.index), [1, 2, 3]);
  assert.equal(duplicateShot(shots, 'nope'), null);
});

test('插入新镜：沿用前一镜场景；空板和无锚点都能插入', () => {
  const shots = board(2).map((s) => ({ ...s, location: '店内', look: 'vivid' }));
  const a = insertShotAfter(shots, shots[0].id);
  assert.equal(a.shots[1].id, a.shotId);
  assert.equal(a.shots[1].location, '店内');
  assert.equal(a.shots[1].look, 'vivid');
  assert.deepEqual(a.shots.map((s) => s.index), [1, 2, 3]);
  const b = insertShotAfter([], null);
  assert.equal(b.shots.length, 1);
  assert.equal(b.shots[0].index, 1);
  const c = insertShotAfter(shots, null);
  assert.equal(c.shots[2].id, c.shotId);
});

test('删除分镜同时清掉它的参考', () => {
  const shots = board(2);
  const project = { ...projectWith(shots), references: { [shots[0].id]: [{ url: 'u' }], [shots[1].id]: [{ url: 'v' }] } };
  const next = removeShot(project, shots[0].id);
  assert.equal(next.storyboard.length, 1);
  assert.equal(next.storyboard[0].index, 1);
  assert.deepEqual(Object.keys(next.references), [shots[1].id]);
  assert.equal(removeShot(project, 'nope'), null);
});

test('cleanBriefPatch 丢掉空值和非法值，不让「没提到」覆盖已有内容', () => {
  const out = cleanBriefPatch({
    title: '  咖啡 ', goal: '', audience: null, platform: '其他', look: 'none', pacing: '快', aspect: '7:5', duration: 0, mustHave: [], avoid: ['  俗气 ', ''], unknown: 'x',
  });
  assert.deepEqual(out, { title: '咖啡', avoid: ['俗气'] });
  assert.deepEqual(cleanBriefPatch({ platform: '抖音', look: 'vivid', pacing: 'fast', aspect: '9:16', duration: 30.4 }), { platform: '抖音', look: 'vivid', pacing: 'fast', aspect: '9:16', duration: 30 });
  assert.deepEqual(cleanBriefPatch({ duration: 9999 }), { duration: 600 });
  assert.deepEqual(cleanBriefPatch(null), {});
});

test('baseBrief 没有简报时用项目画幅', () => {
  assert.equal(baseBrief(createProject({ aspect: '9:16' })).aspect, '9:16');
  const brief = createBrief({ title: 't' });
  assert.equal(baseBrief({ ...createProject(), brief }), brief);
});

test('nextStyleGuide 只覆盖 AI 自己写的内容', () => {
  const a = nextStyleGuide({ styleGuide: '' }, '暖调');
  assert.equal(a.styleGuide, '暖调');
  const b = nextStyleGuide(a, '冷调');
  assert.equal(b.styleGuide, '冷调');
  const edited = { ...b, styleGuide: '我自己写的' };
  assert.equal(nextStyleGuide(edited, '新版').styleGuide, '我自己写的');
  assert.equal(nextStyleGuide(edited, '  '), edited);
  assert.equal(nextStyleGuide(undefined, '').styleGuide, undefined);
});

test('applyStoryboard 替换分镜、清旧参考、补简报', () => {
  const p = { ...createProject({ aspect: '9:16' }), references: { old: [1] } };
  const next = applyStoryboard(p, [{ title: 'A' }], { styleGuide: '暖调' });
  assert.equal(next.storyboard.length, 1);
  assert.deepEqual(next.references, {});
  assert.equal(next.brief.aspect, '9:16');
  assert.equal(next.memory.styleGuide, '暖调');
  assert.deepEqual(p.references, { old: [1] });
});

test('pickSources 依据 yt-dlp 与设置', () => {
  assert.deepEqual(pickSources({ ytdlpInstalled: true }), ['bilibili', 'youtube']);
  assert.deepEqual(pickSources({ ytdlpInstalled: false }), ['commons']);
  assert.deepEqual(pickSources(), ['commons']);
  const settings = { web: { preferredSources: ['commons', 'pexels', 'youtube'] }, hasPexelsKey: true, hasPixabayKey: true };
  assert.deepEqual(pickSources({ ytdlpInstalled: true, settings }), ['youtube']);
  assert.deepEqual(pickSources({ ytdlpInstalled: false, settings }), ['commons', 'pexels']);
  assert.deepEqual(pickSources({ ytdlpInstalled: true, settings: { web: { preferredSources: ['commons'] } } }), ['commons']);
});

test('搜索计划：B站用中文词，其他源优先英文词，同词合并', () => {
  const shot = createShot({ referenceQueries: ['咖啡拉花 特写', 'latte art close up'] });
  assert.deepEqual(buildSearchPlan(shot, ['bilibili', 'youtube', 'commons']), [
    { query: '咖啡拉花 特写', sources: ['bilibili'] },
    { query: 'latte art close up', sources: ['youtube', 'commons'] },
  ]);
  const zhOnly = createShot({ referenceQueries: ['咖啡'] });
  assert.deepEqual(buildSearchPlan(zhOnly, ['bilibili', 'youtube']), [{ query: '咖啡', sources: ['bilibili', 'youtube'] }]);
  assert.deepEqual(buildSearchPlan(shot, ['commons'], ' 自定义 '), [{ query: '自定义', sources: ['commons'] }]);
  assert.deepEqual(buildSearchPlan(shot, []), []);
});

test('没有搜索词时用主体动作景别拼一个', () => {
  assert.equal(shotQueries(createShot({ subject: '咖啡师', action: '拉花', shotSize: 'close-up' })).zh, '咖啡师 拉花 近景特写');
  assert.equal(shotQueries(createShot({ title: '开场' })).zh, '开场 中景');
});

test('缩略图地址改写为 https', () => {
  assert.equal(normalizeThumbUrl('//i0.hdslb.com/a.jpg'), 'https://i0.hdslb.com/a.jpg');
  assert.equal(normalizeThumbUrl('http://a.com/b.jpg'), 'https://a.com/b.jpg');
  assert.equal(normalizeThumbUrl('https://a.com/b.jpg'), 'https://a.com/b.jpg');
  assert.equal(normalizeThumbUrl(null), '');
});

test('mergeResults 去重、跳过无链接项、各来源交替、限制总数', () => {
  const a = { source: 'bilibili', id: '1', url: 'u1', title: '' };
  const merged = mergeResults([[a, a, { source: 'bilibili', id: '2', url: 'u2' }, { title: '无链接' }, null], [{ source: 'youtube', id: '3', url: 'u3', thumb: '//x/y.jpg' }]]);
  assert.deepEqual(merged.map((r) => r.id), ['1', '3', '2']);
  assert.equal(merged[0].title, '未命名视频');
  assert.equal(merged[1].thumb, 'https://x/y.jpg');
  const many = Array.from({ length: 40 }, (_, i) => ({ source: 'commons', id: String(i), url: `u${i}` }));
  assert.equal(mergeResults([many]).length, 24);
  assert.deepEqual(mergeResults(null), []);
  assert.equal(resultKey({ source: 'commons', url: 'u' }), 'commons:u');
});

test('findAssetForResult 按页面地址或直链匹配', () => {
  const assets = { a: { id: 'a', source: { url: 'page' } }, b: { id: 'b', source: {} } };
  assert.equal(findAssetForResult(assets, { url: 'page' }).id, 'a');
  assert.equal(findAssetForResult(assets, { url: 'x', downloadUrl: 'page' }).id, 'a');
  assert.equal(findAssetForResult(assets, { url: 'x' }), null);
  assert.equal(findAssetForResult(null, { url: 'x' }), null);
});

test('guessCategory 标题优先，其次时长', () => {
  assert.equal(guessCategory({ title: '手机怎么拍美食' }), 'tutorial');
  assert.equal(guessCategory({ title: 'Nike Commercial 2024' }), 'ad');
  assert.equal(guessCategory({ title: '无题', duration: 60 }), 'short');
  assert.equal(guessCategory({ title: '无题', duration: 900 }), 'other');
  assert.equal(guessCategory(null), 'other');
});

test('AI 画面尺寸与提示词', () => {
  assert.equal(imageSizeForAspect('9:16'), '1024x1536');
  assert.equal(imageSizeForAspect('1:1'), '1024x1024');
  assert.equal(imageSizeForAspect('21:9'), '1536x1024');
  const prompt = buildImagePrompt(createShot({ subject: '咖啡杯', shotSize: 'close-up', look: 'none' }), createBrief({ look: 'golden-hour', style: '温暖' }));
  assert.match(prompt, /咖啡杯/);
  assert.match(prompt, /近景特写/);
  assert.match(prompt, /黄金时刻/);
  assert.doesNotMatch(buildImagePrompt(createShot(), null), /色调/);
});

test('boardStats / summarizeReport / isQuestionLike', () => {
  assert.deepEqual(boardStats([{ duration: 2 }, { duration: 'x' }], { duration: 30 }), { count: 2, total: 2, target: 30 });
  assert.deepEqual(boardStats(null, null), { count: 0, total: 0, target: null });
  assert.equal(summarizeReport(['a', '', 'b', 'c', 'd']), 'a；b；c');
  assert.equal(summarizeReport(undefined), '已按分镜生成初剪时间线');
  assert.equal(isQuestionLike('发在哪？'), true);
  assert.equal(isQuestionLike('发抖音'), false);
});

test('画幅布局：竖屏按高贴合，宽银幕按宽贴合', () => {
  assert.equal(mediaLayout('9:16').fit, 'height');
  assert.equal(mediaLayout('21:9').fit, 'width');
  assert.equal(mediaLayout('16:9').fit, 'width');
  assert.equal(mediaLayout('乱写').cardMin, 248);
  assert.deepEqual(frameSize('16:9', 320), { width: 320, height: 180 });
  assert.deepEqual(frameSize('9:16', 320), { width: 180, height: 320 });
  assert.deepEqual(frameSize('1:1', 100), { width: 100, height: 100 });
});

test('parseInline 解析粗体与行内代码', () => {
  assert.deepEqual(parseInline('先**拍**再`剪`'), [
    { type: 'text', text: '先' }, { type: 'bold', text: '拍' }, { type: 'text', text: '再' }, { type: 'code', text: '剪' },
  ]);
  assert.deepEqual(parseInline('2 * 3 ** 4'), [{ type: 'text', text: '2 * 3 ** 4' }]);
  assert.deepEqual(parseInline(null), []);
});

test('parseMarkdownLite 分块：段落换行、列表、小标题', () => {
  const blocks = parseMarkdownLite('第一行\n第二行\n\n- 甲\n* 乙\n\n1. 一\n2、二\n### 标题\r\n结尾');
  assert.deepEqual(blocks.map((b) => b.type), ['p', 'ul', 'ol', 'h', 'p']);
  assert.equal(blocks[0].lines.length, 2);
  assert.equal(blocks[1].items.length, 2);
  assert.equal(blocks[2].items.length, 2);
  assert.deepEqual(parseMarkdownLite(''), []);
  assert.deepEqual(parseMarkdownLite(undefined), []);
});

test('reindexShots 不动已经正确的对象', () => {
  const shots = board(2);
  assert.equal(reindexShots(shots)[0], shots[0]);
  assert.equal(reindexShots([shots[1], shots[0]])[0].index, 1);
});

// ---------- v3 卡片辅助 ----------
import { shotSource, hasRealFootage, shotMetaLine, shotIssue, allShotsReady } from '../src/ui/modes/create/createUtils.js';

test('shotSource 按 用户素材 > AI 视频 > 实拍 > 示意 排序', () => {
  const assets = {
    l: { id: 'l', kind: 'video' }, g: { id: 'g', kind: 'video', source: 'videogen' },
    s: { id: 's', kind: 'video', source: 'stock' }, p: { id: 'p', kind: 'previz' },
  };
  assert.equal(shotSource({ assetId: 'l', aiVideoAssetId: 'g', footageAssetId: 's' }, assets).kind, 'local');
  assert.equal(shotSource({ aiVideoAssetId: 'g', footageAssetId: 's' }, assets).kind, 'ai');
  assert.equal(shotSource({ footageAssetId: 's', previzAssetId: 'p' }, assets).kind, 'stock');
  assert.equal(shotSource({ previzAssetId: 'p' }, assets).kind, 'previz');
  assert.equal(shotSource({ assetId: 'p' }, assets).kind, 'previz');
  assert.equal(shotSource({ assetId: 'gone' }, assets).kind, 'none');
  assert.equal(shotSource({ assetId: 'g' }, assets).kind, 'ai');
  assert.equal(hasRealFootage({ previzAssetId: 'p' }, assets), false);
  assert.equal(hasRealFootage({ footageAssetId: 's' }, assets), true);
});

test('shotMetaLine 输出「景别 · 角度 · 运镜」', () => {
  assert.equal(shotMetaLine({ shotSize: 'medium', angle: 'eye-level', movement: 'tracking' }), '中景 · 平视 · 跟随');
  assert.equal(shotMetaLine({ shotSize: 'wide' }, { size: { wide: 'W' } }), 'W');
  assert.equal(shotMetaLine(null), '');
});

test('shotIssue 只在异常时返回', () => {
  const assets = { s: { id: 's', kind: 'video', source: 'stock' } };
  assert.equal(shotIssue({ footageAssetId: 's' }, assets, null), null);
  assert.equal(shotIssue({}, assets, null).kind, 'missing');
  assert.equal(shotIssue({ aiVideoTask: { state: 'running', progress: 42 } }, assets, null).label, '生成中 42%');
  assert.equal(shotIssue({ aiVideoTask: { state: 'failed', error: 'x' } }, assets, null).kind, 'error');
  assert.equal(shotIssue({ footageAssetId: 's' }, assets, { label: '配素材' }).kind, 'busy');
  assert.equal(allShotsReady([], assets), false);
  assert.equal(allShotsReady([{ footageAssetId: 's' }], assets), true);
  assert.equal(allShotsReady([{ footageAssetId: 's' }, {}], assets), false);
});