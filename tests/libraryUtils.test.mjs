// 拆片库纯函数测试：node --test tests/libraryUtils.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractUrls, detectPlatform, guessCategory, fmtSec, fmtClock, pct, fmtDate,
  niceStep, niceTicks, timeStep, validHex, motionLevel, describeTone, describeRhythm,
  computeRhythm, shotIndexAt, transcriptIndexAt, normalizeAnalysis, filterAnalyses,
  techniquesForAnalysis, simpleFilterTechniques, parseLines, parseTags,
  sanitizeTechnique, attachTechniqueToAnalysis, copyTechniqueDraft, mergeIds,
  filterLibrary, techCategoryCounts, buildAnalysisReport, reportFileName,
} from '../src/ui/modes/library/libraryUtils.js';

test('extractUrls：纯链接、分享文本、裸域名、BV 号、去重', () => {
  const text = [
    'https://www.bilibili.com/video/BV1xx411c7mD',
    '【电影级调色教程-哔哩哔哩】 https://b23.tv/abcd123',
    '7.43 复制打开抖音，看看【小王的作品】夏日运镜合集 #运镜 https://v.douyin.com/iAbCdEf/ 复制此链接',
    'youtu.be/dQw4w9WgXcQ',
    'BV1ab411c7XY',
    'https://www.bilibili.com/video/BV1xx411c7mD/',
    '',
    '没有链接的一行',
  ].join('\n');
  const r = extractUrls(text);
  assert.equal(r.length, 5);
  assert.equal(r[0].platform, 'bilibili');
  assert.equal(r[1].url, 'https://b23.tv/abcd123');
  assert.equal(r[1].title, '电影级调色教程');
  assert.equal(r[2].platform, 'douyin');
  assert.equal(r[2].title, '夏日运镜合集');
  assert.equal(r[3].url, 'https://youtu.be/dQw4w9WgXcQ');
  assert.equal(r[3].platform, 'youtube');
  assert.equal(r[4].url, 'https://www.bilibili.com/video/BV1ab411c7XY');
  assert.deepEqual(extractUrls(''), []);
  assert.deepEqual(extractUrls(null), []);
});

test('detectPlatform / guessCategory', () => {
  assert.equal(detectPlatform('https://www.youtube.com/watch?v=1'), 'youtube');
  assert.equal(detectPlatform('https://example.com/a'), 'other');
  assert.equal(guessCategory('手机怎么拍电影感'), 'tutorial');
  assert.equal(guessCategory('诺兰电影名场面'), 'film');
  assert.equal(guessCategory('品牌宣传片'), 'ad');
  assert.equal(guessCategory('vlog 日常'), 'short');
  assert.equal(guessCategory(''), 'other');
});

test('格式化函数', () => {
  assert.equal(fmtSec(2.44), '2.4 秒');
  assert.equal(fmtSec(3), '3 秒');
  assert.equal(fmtSec(192), '3 分 12 秒');
  assert.equal(fmtSec(120), '2 分钟');
  assert.equal(fmtSec(-5), '0 秒');
  assert.equal(fmtClock(65), '1:05');
  assert.equal(fmtClock(3725), '1:02:05');
  assert.equal(fmtClock('abc'), '0:00');
  assert.equal(pct(0.456), '46%');
  assert.equal(pct(3), '100%');
  const now = new Date(2026, 2, 10, 15, 0);
  assert.equal(fmtDate(new Date(2026, 2, 10, 9, 5).toISOString(), now), '今天 09:05');
  assert.equal(fmtDate(new Date(2026, 2, 9, 23, 1).toISOString(), now), '昨天 23:01');
  assert.equal(fmtDate(new Date(2026, 0, 2, 8, 0).toISOString(), now), '2026-01-02');
  assert.equal(fmtDate('', now), '');
  assert.equal(fmtDate('not a date', now), '');
});

test('刻度计算', () => {
  assert.equal(niceStep(10, 4), 5);
  assert.equal(niceStep(0), 1);
  assert.deepEqual(niceTicks(10, 4), [0, 5, 10]);
  assert.equal(timeStep(60, 700), 10);
  assert.equal(timeStep(600, 700), 60);
  assert.ok(timeStep(100000, 10) === 3600);
});

test('validHex / motionLevel', () => {
  assert.ok(validHex('#a1b2c3'));
  assert.ok(validHex('#fff'));
  assert.ok(!validHex('red'));
  assert.ok(!validHex(null));
  assert.equal(motionLevel(0.1), 0);
  assert.equal(motionLevel(0.5), 1);
  assert.equal(motionLevel(0.9), 2);
  assert.equal(motionLevel(undefined), 0);
});

test('describeTone / describeRhythm', () => {
  assert.equal(describeTone({ warmth: 0.2, saturation: 0.3, luma: 0.3, contrast: 0.35 }), '偏暖、中等饱和、低调');
  assert.equal(describeTone({ warmth: -0.3, saturation: 0.6, luma: 0.7, contrast: 0.6 }), '偏冷、高饱和、高调、高反差');
  assert.equal(describeTone(null), '暂无色彩数据');
  assert.match(describeRhythm(1.2), /极快/);
  assert.match(describeRhythm(4), /中等/);
  assert.equal(describeRhythm(0), '暂无节奏数据');
});

test('computeRhythm', () => {
  const r = computeRhythm([{ start: 0, end: 2 }, { start: 2, end: 6 }, { start: 6, end: 12 }], 12);
  assert.equal(r.avgShot, 4);
  assert.equal(r.medianShot, 4);
  assert.equal(r.cutsPerMinute, 10);
  assert.deepEqual(computeRhythm([], 0), { avgShot: 0, medianShot: 0, cutsPerMinute: 0, durations: [] });
});

test('shotIndexAt：区间内、边界、末尾、空列表', () => {
  const shots = [{ start: 0, end: 2 }, { start: 2, end: 5 }, { start: 5, end: 9 }];
  assert.equal(shotIndexAt(shots, 0), 0);
  assert.equal(shotIndexAt(shots, 2), 1);
  assert.equal(shotIndexAt(shots, 4.99), 1);
  assert.equal(shotIndexAt(shots, 9), 2); // 视频末尾仍落在最后一镜
  assert.equal(shotIndexAt(shots, 100), 2);
  assert.equal(shotIndexAt(shots, -1), 0);
  assert.equal(shotIndexAt([], 3), -1);
});

test('transcriptIndexAt：命中、间隙、短字幕最少 0.5 秒', () => {
  const items = [{ start: 1, end: 3, text: 'a' }, { start: 4, end: 4, text: 'b' }, { start: 6, end: 8, text: 'c' }];
  assert.equal(transcriptIndexAt(items, 0.5), -1);
  assert.equal(transcriptIndexAt(items, 1), 0);
  assert.equal(transcriptIndexAt(items, 3.5), -1);
  assert.equal(transcriptIndexAt(items, 4.3), 1);
  assert.equal(transcriptIndexAt(items, 7.9), 2);
  assert.equal(transcriptIndexAt(items, 8), -1);
  assert.equal(transcriptIndexAt([], 1), -1);
  assert.equal(transcriptIndexAt(null, 1), -1);
});

test('normalizeAnalysis：补齐缺失字段', () => {
  assert.equal(normalizeAnalysis(null), null);
  const a = normalizeAnalysis({
    id: 'an_1',
    category: 'weird',
    shots: [
      { start: 3, end: 6, stats: { luma: 2, palette: ['#fff', 'bad'] }, keyframes: ['k2.jpg'] },
      { start: 0, duration: 3 },
    ],
    transcript: [{ start: 5, end: 6, text: ' 你好 ' }, { start: 1, text: '' }],
    ai: { structure: [{ label: '开场', start: 0, end: 3 }], highlights: ['x', null] },
  });
  assert.equal(a.title, '未命名视频');
  assert.equal(a.category, 'other');
  assert.equal(a.shots.length, 2);
  assert.equal(a.shots[0].start, 0);
  assert.equal(a.shots[0].end, 3);
  assert.equal(a.shots[1].thumb, 'k2.jpg');
  assert.equal(a.shots[1].stats.luma, 1);
  assert.deepEqual(a.shots[1].stats.palette, ['#fff']);
  assert.equal(a.duration, 6);
  assert.equal(a.rhythm.avgShot, 3);
  assert.deepEqual(a.transcript, [{ start: 5, end: 6, text: '你好' }]);
  assert.deepEqual(a.ai.highlights, ['x']);
  assert.deepEqual(a.audio, { curve: [], peaks: [] });
  assert.deepEqual(a.techniqueIds, []);
  assert.equal(a.colorProfile, null);
});

test('filterAnalyses / techniquesForAnalysis / simpleFilterTechniques', () => {
  const list = [{ id: 1, title: '调色教程', category: 'tutorial' }, { id: 2, title: '电影片段', category: 'film' }, null];
  assert.equal(filterAnalyses(list, '调色', 'all').length, 1);
  assert.equal(filterAnalyses(list, '', 'film').length, 1);
  assert.equal(filterAnalyses(list, '', '').length, 2);
  const techs = [{ id: 't1' }, { id: 't2', source: { analysisId: 'a1' } }, { id: 't3' }];
  assert.deepEqual(techniquesForAnalysis(techs, { id: 'a1', techniqueIds: ['t1'] }).map((t) => t.id), ['t1', 't2']);
  assert.deepEqual(techniquesForAnalysis(techs, null), []);
  const cards = [{ title: '匹配剪辑', category: 'transition', tags: ['转场'] }, { title: '伦勃朗光', category: 'lighting', steps: ['侧光 45 度'] }];
  assert.equal(simpleFilterTechniques(cards, '转场').length, 1);
  assert.equal(simpleFilterTechniques(cards, '侧光').length, 1);
  assert.equal(simpleFilterTechniques(cards, '', 'lighting').length, 1);
});

test('parseLines / parseTags', () => {
  assert.deepEqual(parseLines('1. 第一步\n- 第二步\n\n• 第三步\n2、第四步'), ['第一步', '第二步', '第三步', '第四步']);
  assert.deepEqual(parseTags('转场, 运镜、#调色 转场'), ['转场', '运镜', '调色']);
  assert.deepEqual(parseTags(''), []);
});

test('sanitizeTechnique / attachTechniqueToAnalysis / copyTechniqueDraft', () => {
  const t = sanitizeTechnique({ id: 'bt_x', title: '  ', category: 'nope', steps: '一\n二', tags: 'a,b', apply: { foo: 1 }, builtin: true });
  assert.ok(t.id.startsWith('tq_'));
  assert.equal(t.title, '未命名技法');
  assert.equal(t.category, 'narrative');
  assert.deepEqual(t.steps, ['一', '二']);
  assert.deepEqual(t.tags, ['a', 'b']);
  assert.equal(t.apply, null);
  assert.equal(t.builtin, false);
  assert.equal('source' in t, false);
  const kept = sanitizeTechnique({ id: 'tq_1', title: 'x', apply: { ops: [] }, source: { analysisId: 'a', start: 5, end: 2 } });
  assert.equal(kept.id, 'tq_1');
  assert.deepEqual(kept.apply, { ops: [] });
  assert.equal(kept.source.end, 5);
  const att = attachTechniqueToAnalysis({ title: '卡点', source: { start: 2 } }, { id: 'an_9', title: '视频', duration: 30 });
  assert.deepEqual(att.source, { analysisId: 'an_9', title: '视频', start: 2, end: 30 });
  const d = copyTechniqueDraft({ id: 'bt_1', builtin: true, title: '推镜' });
  assert.equal(d.id, null);
  assert.equal(d.builtin, false);
  assert.equal(d.title, '推镜（我的版本）');
  assert.deepEqual(mergeIds(['a', 'b'], ['b', null, 'c']), ['a', 'b', 'c']);
});

test('filterLibrary：关键词命中技法标签、按类型与技法类别筛选', () => {
  const list = [
    { id: 'a1', title: '咖啡广告', category: 'ad' },
    { id: 'a2', title: '旅行 vlog', category: 'short' },
  ];
  const techniques = [
    { id: 't1', category: 'lighting', title: '逆光剪影', tags: ['黄昏'], source: { analysisId: 'a1' } },
    { id: 't2', category: 'transition', title: '甩镜转场', tags: [], source: { analysisId: 'a2' } },
  ];
  assert.deepEqual(filterLibrary(list, {}).map((a) => a.id), ['a1', 'a2']);
  assert.deepEqual(filterLibrary(list, { query: '黄昏', techniques }).map((a) => a.id), ['a1']);
  assert.deepEqual(filterLibrary(list, { category: 'short' }).map((a) => a.id), ['a2']);
  assert.deepEqual(filterLibrary(list, { techCategory: 'transition', techniques }).map((a) => a.id), ['a2']);
  assert.deepEqual(filterLibrary(list, { techCategory: 'color', techniques }), []);
  assert.deepEqual(filterLibrary(null, {}), []);
  assert.deepEqual(techCategoryCounts(techniques), { lighting: 1, transition: 1 });
});

test('buildAnalysisReport：包含指标、镜头表、技法与台词', () => {
  const md = buildAnalysisReport({
    id: 'a1', title: '咖啡|广告', category: 'ad', duration: 10,
    shots: [{ start: 0, end: 4, ai: { shotSize: '特写', movement: '推' } }, { start: 4, end: 10 }],
    transcript: [{ start: 1, end: 2, text: '早安' }],
    ai: { summary: '温暖', highlights: ['逆光'], structure: [{ label: '开场', start: 0, end: 4 }] },
  }, [{ id: 't1', title: '逆光剪影', category: 'lighting', steps: ['机位背光'], source: { analysisId: 'a1', start: 0, end: 4 } }],
  { category: { ad: '广告' }, techCategory: { lighting: '光线' } });
  assert.match(md, /^# 拆片报告：咖啡\|广告/);
  assert.match(md, /类型：广告/);
  assert.match(md, /\| 镜头数 \| 2 \|/);
  assert.match(md, /特写/);
  assert.match(md, /### 逆光剪影（光线）/);
  assert.match(md, /1\. 机位背光/);
  assert.match(md, /早安/);
  assert.equal(buildAnalysisReport(null), '');
  assert.equal(reportFileName({ title: 'a/b:c' }), 'a b c - 拆片报告.md');
});