// 拆片 AI 提示词：片内分档（V4）、切入先验、联系表编号（V1）、节拍与卡点行（F1/F2）。
// 运行：node --test tests/library-analyze-bands.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { percentileBands, cutInLabel, beatSyncLabel, buildAnalyzeRequest } from '../src/ai/analyze.js';

test('percentileBands：按片内分布分三档；全相同/单个为中；无效值为空', () => {
  assert.deepEqual(percentileBands([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]), ['低', '低', '中', '中', '高', '高']);
  assert.deepEqual(percentileBands([0.5, 0.5, 0.5]), ['中', '中', '中']);
  assert.deepEqual(percentileBands([0.9]), ['中']);
  assert.deepEqual(percentileBands([0.2, null, 'x', 0.8]), ['低', '', '', '高']);
  assert.deepEqual(percentileBands([]), []);
  // 绝对值都很小也照样分出高低（片内相对）
  assert.deepEqual(percentileBands([0.01, 0.02, 0.03]), ['低', '中', '高']);
});

test('cutInLabel / beatSyncLabel', () => {
  assert.equal(cutInLabel(null), '');
  assert.equal(cutInLabel({ kind: 'hard', transition: 'cut' }), '硬切');
  assert.equal(cutInLabel({ kind: 'dissolve', transition: 'crossfade', duration: 0.6 }), '叠化约 0.6 秒');
  assert.equal(cutInLabel({ kind: 'fade', transition: 'dip-black' }), '黑场过渡');
  assert.equal(cutInLabel({ kind: 'split', transition: null }), '长镜头等分（不是切点）');
  assert.equal(beatSyncLabel(null), null);
  assert.equal(beatSyncLabel({ cuts: 10, significance: 3.1 }).level, 'strong');
  assert.equal(beatSyncLabel({ cuts: 10, significance: 1.5 }).text, '部分踩点');
  assert.equal(beatSyncLabel({ cuts: 10, significance: 0.9 }).text, '没有刻意踩点');
});

function makeAnalysis(extra = {}) {
  const shots = Array.from({ length: 6 }, (_, i) => ({
    index: i, start: i * 2, end: i * 2 + 2, duration: 2,
    stats: { luma: 0.1 * (i + 1), contrast: 0.3, saturation: 0.4, warmth: i % 2 ? 0.3 : -0.3, tint: 0, palette: ['#000000', '#111111', '#222222', '#333333', '#444444'] },
    motion: [0.05, 0.9, 0.1, 0.5, 0.7, 0.2][i],
    loudness: 0.5,
    cutIn: i === 0 ? null : i === 3 ? { kind: 'dissolve', transition: 'crossfade', duration: 0.5 } : { kind: 'hard', transition: 'cut' },
  }));
  return {
    title: '测试', category: 'other', duration: 12, width: 1080, height: 1920,
    shots, contactSheets: ['C:/tmp/sheet_1.jpg'], contactSheetShots: [[0, 1, 2, 3, 4, 5]],
    rhythm: { avgShot: 2, medianShot: 2, cutsPerMinute: 25 },
    audio: { curve: [0.5, 0.6], peaks: [1.2] },
    colorProfile: { luma: 0.4, contrast: 0.3, saturation: 0.4, warmth: 0, tint: 0, palette: ['#000000'] },
    ...extra,
  };
}

test('buildAnalyzeRequest：镜头行用片内档位、带切入先验，不再给原始小数', () => {
  const req = buildAnalyzeRequest({ analysis: makeAnalysis() });
  const lines = req.prompt.split('\n').filter((l) => l.startsWith('index '));
  assert.equal(lines.length, 6);
  assert.match(lines[0], /^index 0｜0:00\.0–0:02\.0（2秒）｜亮度低 偏冷｜运动低｜响度中$/);
  assert.match(lines[1], /运动高/);
  assert.match(lines[1], /切入：硬切/);
  assert.match(lines[3], /切入：叠化约 0\.5 秒/);
  assert.ok(!/运动0\.|响度0\./.test(req.prompt), '不应再出现原始小数');
  assert.match(req.system, /先验/);
  // 没有音频曲线时不写响度档位
  const silent = buildAnalyzeRequest({ analysis: makeAnalysis({ audio: { curve: [], peaks: [] } }) });
  assert.ok(!/响度[低中高]/.test(silent.prompt));
});

test('buildAnalyzeRequest：联系表有编号时说明「#序号 = index + 1」', () => {
  const plain = buildAnalyzeRequest({ analysis: makeAnalysis() });
  assert.ok(!plain.prompt.includes('#序号'));
  const numbered = buildAnalyzeRequest({ analysis: makeAnalysis({ contactSheetsNumbered: true }) });
  assert.match(numbered.prompt, /#序号 = index \+ 1/);
  assert.match(numbered.prompt, /依次是镜头 index 0、1、2、3、4、5/);
});

test('buildAnalyzeRequest：节拍与卡点行', () => {
  const none = buildAnalyzeRequest({ analysis: makeAnalysis() });
  assert.ok(!none.prompt.includes('音乐节拍'), '没有节拍数据时不写');
  const noBeat = buildAnalyzeRequest({ analysis: makeAnalysis({ audio: { curve: [0.5], peaks: [], tempo: { bpm: null, confidence: 0.05 } } }) });
  assert.match(noBeat.prompt, /没有明显的节拍/);
  const synced = buildAnalyzeRequest({
    analysis: makeAnalysis({
      audio: { curve: [0.5], peaks: [], tempo: { bpm: 120.2, confidence: 0.8 } },
      rhythm: { avgShot: 2, medianShot: 2, cutsPerMinute: 25, beatSync: { bpm: 120.2, cuts: 5, hits: 5, hitRate: 1, baseline: 0.32, significance: 3.13 } },
    }),
  });
  assert.match(synced.prompt, /约 120 BPM/);
  assert.match(synced.prompt, /比例 100%（随便剪约 32%），判断：明显踩点/);
});
