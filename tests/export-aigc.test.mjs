// AIGC 显式/隐式标识（aigc.js）与导出进度估计（exportProgress.js）单元测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_LABEL_DEFAULT, AI_LABEL_CORNERS, AI_LABEL_INTRO_SEC, AIGC_FIELDS, AIGC_PRODUCER,
  isAiAssetLoose, aiAssetSummary, projectUsesAiLoose,
  isCompliantLabelText, normalizeAiLabel, aiLabelLayout, drawAiLabel,
  aigcSafe, makeProduceId, buildAigcMeta, aigcMetaString,
} from '../src/export/aigc.js';
import { createExportProgress, ETA_ALMOST_DONE } from '../src/export/exportProgress.js';
import { createProject, createAsset, createClip } from '../src/engine/model.js';

// ───────────────────────── aigc.js ─────────────────────────

test('isCompliantLabelText：必须同时含 AI/人工智能 与 生成/合成', () => {
  for (const ok of ['AI 生成', 'ai 合成', 'ＡＩ生成', '本视频由人工智能生成', '人工智能合成内容']) {
    assert.equal(isCompliantLabelText(ok), true, ok);
  }
  for (const bad of ['', null, undefined, 'AI 视频', '人工智能', '自动生成', '合成画面', 'Made by Frameflow']) {
    assert.equal(isCompliantLabelText(bad), false, String(bad));
  }
});

test('normalizeAiLabel：关闭值返回 null，非法文字/角落回退合规默认值', () => {
  for (const off of [false, null, 0, 'off', undefined]) {
    assert.equal(normalizeAiLabel(off), null, String(off));
  }
  assert.deepEqual(normalizeAiLabel(true), AI_LABEL_DEFAULT);
  assert.deepEqual(normalizeAiLabel({}), AI_LABEL_DEFAULT);
  assert.deepEqual(normalizeAiLabel({ text: '  人工智能   合成  ', corner: 'bottom-left' }), {
    text: '人工智能 合成',
    corner: 'bottom-left',
  });
  // 文字不合规时自动换回默认文字，但保留合法角落
  assert.deepEqual(normalizeAiLabel({ text: '水印', corner: 'top-left' }), {
    text: AI_LABEL_DEFAULT.text,
    corner: 'top-left',
  });
  // 非法角落回退 top-right
  assert.deepEqual(normalizeAiLabel({ text: 'AI 合成', corner: 'center' }), {
    text: 'AI 合成',
    corner: 'top-right',
  });
  for (const corner of AI_LABEL_CORNERS) {
    assert.equal(normalizeAiLabel({ text: 'AI 生成', corner }).corner, corner);
  }
});

test('aiLabelLayout：阶段切换、竖屏避让、以及 NaN/异常输入安全', () => {
  // 横屏 1080p：开头 intro（字高 ≥5% 短边），3.25s shrink，4s 常驻 badge
  const intro = aiLabelLayout(1920, 1080, 0);
  assert.equal(intro.phase, 'intro');
  assert.equal(intro.offsetY, 0);
  assert.ok(intro.fontPx >= Math.ceil(1080 * 0.05), `intro fontPx=${intro.fontPx}`);
  assert.ok(Math.abs(intro.alpha - 0.94) < 1e-6);

  const atIntroEnd = aiLabelLayout(1920, 1080, AI_LABEL_INTRO_SEC);
  assert.equal(atIntroEnd.phase, 'intro');

  const shrink = aiLabelLayout(1920, 1080, AI_LABEL_INTRO_SEC + 0.25);
  assert.equal(shrink.phase, 'shrink');

  const badge = aiLabelLayout(1920, 1080, AI_LABEL_INTRO_SEC + 1);
  assert.equal(badge.phase, 'badge');
  assert.ok(badge.fontPx < intro.fontPx);
  assert.ok(shrink.fontPx <= intro.fontPx && shrink.fontPx >= badge.fontPx);
  assert.ok(Math.abs(badge.alpha - 0.85) < 1e-6);

  // 竖屏 1080x1920：上下角自动避让短视频平台 UI
  const pTop = aiLabelLayout(1080, 1920, 0, { corner: 'top-right' });
  const pBot = aiLabelLayout(1080, 1920, 0, { corner: 'bottom-right' });
  assert.ok(pTop.offsetY > 0);
  assert.ok(pBot.offsetY > pTop.offsetY);

  // NaN / Infinity / undefined 均不得污染排版数值
  for (const bad of [
    aiLabelLayout(1920, 1080, NaN),
    aiLabelLayout(1920, 1080, Infinity),
    aiLabelLayout(1920, 1080, 'bad'),
    aiLabelLayout(NaN, NaN, NaN, null),
    aiLabelLayout(0, -100, undefined),
  ]) {
    for (const k of ['fontPx', 'margin', 'offsetY', 'padX', 'padY', 'radius', 'alpha', 'bgAlpha', 'shadowBlur']) {
      assert.ok(Number.isFinite(bad[k]), `${k} 应为有限数，得到 ${bad[k]}`);
    }
  }
  assert.equal(aiLabelLayout(1920, 1080, NaN).phase, 'intro');
});

test('drawAiLabel：绘制返回边界框，关闭时返回 null', () => {
  const calls = [];
  const ctx = {
    filter: '',
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    setTransform: () => {},
    measureText: (s) => ({ width: s.length * 20 }),
    beginPath: () => {},
    roundRect: () => {},
    fill: () => calls.push('fill'),
    fillText: (text) => calls.push(`text:${text}`),
  };
  assert.equal(drawAiLabel(ctx, 1920, 1080, 0, false), null);
  assert.equal(drawAiLabel(null, 1920, 1080, 0, true), null);
  const box = drawAiLabel(ctx, 1920, 1080, 1, { text: 'AI 生成', corner: 'bottom-left' });
  assert.ok(box && box.w > 0 && box.h > 0 && box.fontPx > 0);
  assert.ok(calls.includes('save') && calls.includes('restore') && calls.includes('text:AI 生成'));
});

test('buildAigcMeta / aigcMetaString / aigcSafe / makeProduceId：符合附录 E 顺序与字符集', () => {
  assert.equal(aigcSafe('Frame flow "中文" \\ok!~'), 'Frameflowok!~');
  const pid = makeProduceId(new Date(2026, 10, 9, 15, 30, 12));
  assert.match(pid, /^FF-20261109T153012-[0-9a-f]{8}$/);

  const def = buildAigcMeta();
  assert.deepEqual(Object.keys(def), [...AIGC_FIELDS]);
  assert.equal(def.Label, '1');
  assert.equal(def.ContentProducer, AIGC_PRODUCER);
  assert.equal(def.ContentPropagator, AIGC_PRODUCER);
  assert.equal(def.PropagateID, def.ProduceID);
  assert.equal(def.ReservedCode1, '');
  assert.equal(def.ReservedCode2, '');

  const custom = buildAigcMeta({ producer: 'My "App" 测试', produceId: 'ID-01\\bad', label: '2' });
  assert.equal(custom.Label, '2');
  assert.equal(custom.ContentProducer, 'MyApp');
  assert.equal(custom.ProduceID, 'ID-01bad');
  assert.equal(buildAigcMeta({ label: '9' }).Label, '1');

  const json = aigcMetaString({ Label: 'invalid', ContentProducer: 'Studio A', ProduceID: 'P1', ReservedCode1: 'x"y', ContentPropagator: 'Studio A', PropagateID: 'P1', ReservedCode2: '' });
  const parsed = JSON.parse(json);
  assert.deepEqual(Object.keys(parsed), [...AIGC_FIELDS]);
  assert.equal(parsed.Label, '1');
  assert.equal(parsed.ContentProducer, 'StudioA');
  assert.equal(parsed.ReservedCode1, 'xy');
  assert.equal(JSON.parse(aigcMetaString(null)).ContentProducer, AIGC_PRODUCER);
});

test('isAiAssetLoose / projectUsesAiLoose：识别时间线实际使用的 AI 素材', () => {
  assert.equal(isAiAssetLoose(null), false);
  assert.equal(isAiAssetLoose({ kind: 'video', source: 'local' }), false);
  assert.equal(isAiAssetLoose({ kind: 'video', source: 'videogen' }), true);
  assert.equal(isAiAssetLoose({ kind: 'generated-image' }), true);
  assert.equal(isAiAssetLoose({ kind: 'image', tags: ['AI 画面'] }), true);

  const p = createProject({ name: 'aigc' });
  const local = createAsset({ id: 'a1', kind: 'video', name: '实拍.mp4', duration: 5 });
  const ai = createAsset({ id: 'a2', kind: 'video', name: '即梦生成.mp4', duration: 5, source: 'videogen' });
  p.assets = { a1: local, a2: ai };
  p.tracks.video = [createClip(local, { id: 'c1', in: 0, out: 3 })];
  assert.equal(projectUsesAiLoose(p), false, '未上时间线的 AI 素材不算');
  p.tracks.video.push(createClip(ai, { id: 'c2', in: 0, out: 3 }));
  assert.equal(projectUsesAiLoose(p), true);
  assert.deepEqual(aiAssetSummary(p), { count: 1, names: ['即梦生成.mp4'] });
});

// ───────────────────────── exportProgress.js ─────────────────────────

test('createExportProgress：正常编码进度、单调不回退、ETA 与收尾', () => {
  let now = 0;
  const prog = createExportProgress({ total: 100, duration: 10, now: () => now });

  // 刚启动不足 MIN_SPAN_MS(800ms) 时不给 ETA
  prog.sent(20);
  prog.encoded({ encoded: 10 });
  const s1 = prog.snapshot();
  assert.equal(s1.phase, 'render');
  assert.equal(s1.frame, 10, '按 min(sent, encoded) 计算已完成帧');
  assert.equal(s1.sent, 20);
  assert.equal(s1.etaSec, null);
  assert.ok(s1.progress > 0 && s1.progress < 0.2);

  // 推进 2 秒，编码到 50 帧 → 速度约 25 fps，剩余 50 帧 ETA 约 2 秒
  now = 2000;
  prog.sent(60);
  prog.encoded({ encoded: 50 });
  const s2 = prog.snapshot();
  assert.equal(s2.frame, 50);
  assert.ok(s2.fps >= 20 && s2.fps <= 30, `fps=${s2.fps}`);
  assert.equal(s2.etaSec, 2);
  assert.ok(s2.progress > s1.progress);

  // 单调性：即使后续编码数未变，进度不回退
  now = 2500;
  const s3 = prog.snapshot();
  assert.ok(s3.progress >= s2.progress);

  // 进入收尾且全部编码完成
  now = 4000;
  prog.sent(100);
  prog.encoded({ encoded: 100 });
  prog.ending();
  assert.equal(prog.isEnding(), true);
  const fin = prog.snapshot();
  assert.equal(fin.phase, 'encode');
  assert.equal(fin.etaSec, 0);
  assert.equal(fin.etaLabel, ETA_ALMOST_DONE);
  assert.equal(fin.progress, 0.99);
});

test('createExportProgress：仅音频模式按 outSec/duration 估算进度', () => {
  let now = 0;
  const prog = createExportProgress({ total: 100, duration: 10, audioOnly: true, now: () => now });
  now = 1000;
  prog.encoded({ outSec: 5 });
  const mid = prog.snapshot();
  assert.equal(mid.phase, 'encode');
  assert.equal(mid.frame, 0);
  assert.ok(mid.progress > 0.45 && mid.progress < 0.55);
  assert.ok(mid.etaSec >= 1);

  now = 2000;
  prog.encoded({ outSec: 10 });
  const end = prog.snapshot();
  assert.equal(end.progress, 0.99);
  assert.equal(end.etaSec, 0);
  assert.equal(end.etaLabel, ETA_ALMOST_DONE);
});

test('createExportProgress：GIF 两阶段 encoded === 0 时按已送帧平滑推进到 75%', () => {
  let now = 0;
  const prog = createExportProgress({ total: 60, duration: 4, now: () => now });
  prog.encoded({ encoded: 0 });
  prog.sent(15);
  now = 500;
  const s1 = prog.snapshot();
  assert.ok(Math.abs(s1.progress - (15 / 60) * 0.75) < 1e-6, `期望 0.1875，实际 ${s1.progress}`);

  prog.sent(60);
  now = 1500;
  const s2 = prog.snapshot();
  assert.ok(Math.abs(s2.progress - 0.75) < 1e-6, `期望 0.75，实际 ${s2.progress}`);

  // 收尾阶段 paletteuse 开始输出帧，最终到达 0.99
  prog.ending();
  prog.encoded({ encoded: 60 });
  now = 2500;
  const s3 = prog.snapshot();
  assert.equal(s3.progress, 0.99);
  assert.equal(s3.etaLabel, ETA_ALMOST_DONE);
});
