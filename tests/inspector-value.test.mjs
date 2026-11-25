// inspector 包：属性面板数值工具（src/ui/modes/refine/inspValue.js）的单测。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toHalfWidth, parseNum, parseSeconds, clamp, stepDecimals, trimNum, nudge, makeFormat, FMT, fmtSecs, normHex,
  sizeToPt, ptToSize, ptRange, TEXT_PRESET_SIZE, bpmFromBeats, normalizeBeats, beatInfo, describeBeats, movedCuts,
  upsertKey, localTime,
} from '../src/ui/modes/refine/inspValue.js';

test('parseNum：全角、单位、正负号都能识别', () => {
  assert.equal(toHalfWidth('１２０％'), '120%');
  assert.equal(parseNum('120%'), 120);
  assert.equal(parseNum('×1.5'), 1.5);
  assert.equal(parseNum('－３'), -3);
  assert.equal(parseNum('+0.25'), 0.25);
  assert.equal(parseNum(' 2.5 秒 '), 2.5);
  assert.equal(parseNum('.5'), 0.5);
  assert.equal(parseNum('１。５'), 1.5);
  assert.equal(parseNum('abc'), null);
  assert.equal(parseNum(''), null);
  assert.equal(parseNum(null), null);
});

test('parseSeconds：秒、分:秒、时:分:秒、中文分秒', () => {
  assert.equal(parseSeconds('65.5'), 65.5);
  assert.equal(parseSeconds('1:05.5'), 65.5);
  assert.equal(parseSeconds('1:02:03'), 3723);
  assert.equal(parseSeconds('1分30秒'), 90);
  assert.equal(parseSeconds('2分'), 120);
  assert.equal(parseSeconds('2.5秒'), 2.5);
  assert.equal(parseSeconds('１：３０'), 90);
  assert.equal(parseSeconds('x'), null);
});

test('clamp / stepDecimals / trimNum / nudge', () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(clamp(5, null, undefined), 5);
  assert.equal(clamp(NaN, 0, 1), 0);
  assert.equal(stepDecimals(0.05), 2);
  assert.equal(stepDecimals(1), 0);
  assert.equal(stepDecimals(0.005), 3);
  assert.equal(stepDecimals(1e-7), 7);
  assert.equal(trimNum(1.5), '1.5');
  assert.equal(trimNum(-0.0001), '0');
  assert.equal(trimNum(2.345, 1), '2.3');
  // 0.1 + 0.2 不留浮点尾差；Shift 大步 = 10 倍；夹在范围内
  assert.equal(nudge(0.1, 1, 0.2), 0.3);
  assert.equal(nudge(0.5, 1, 0.01, true, 0, 1), 0.6);
  assert.equal(nudge(0.95, 1, 0.01, true, 0, 1), 1);
  assert.equal(nudge(0, -1, 1, false, 0, 10), 0);
  assert.equal(nudge(0.333, 1, 0.01), 0.343);
});

test('FMT：显示、输入框文字、解析互相对应', () => {
  assert.equal(FMT.pct(0.5), '50%');
  assert.equal(FMT.pct.edit(0.125), '12.5');
  assert.equal(FMT.pct.parse('120'), 1.2);
  assert.equal(FMT.pct.parse('120%'), 1.2);
  assert.equal(FMT.pct.unit, '%');
  assert.equal(FMT.signed(0.25), '+0.25');
  assert.equal(FMT.signed(-0.001), '0.00');
  assert.equal(FMT.signed(-0.5), '-0.50');
  assert.equal(FMT.signed.parse('-0.3'), -0.3);
  assert.equal(FMT.sec(1.5), '1.50 秒');
  assert.equal(FMT.sec.parse('1:30'), 90);
  assert.equal(FMT.times(1.234), '×1.23');
  assert.equal(FMT.times.parse('×2'), 2);
  assert.equal(FMT.deg(44.6), '45°');
  assert.equal(FMT.deg.parse('-90°'), -90);
  assert.equal(FMT.px1(2), '2.0 px');
  assert.equal(FMT.pct.parse('不是数字'), null);
  // 自定义换算（对数刻度）
  const log = makeFormat((p) => `${(2 ** p).toFixed(2)}×`, { toEdit: (p) => 2 ** p, fromEdit: (n) => Math.log2(n), unit: '×' });
  assert.equal(log.edit(1), '2');
  assert.equal(log.parse('4'), 2);
});

test('fmtSecs：头部时长统一一位小数', () => {
  assert.equal(fmtSecs(2.2), '2.2 秒');
  assert.equal(fmtSecs(0.8), '0.8 秒');
  assert.equal(fmtSecs(0.04), '0.0 秒');
  assert.equal(fmtSecs(59.96), '1 分 00.0 秒');
  assert.equal(fmtSecs(65.3), '1 分 05.3 秒');
  assert.equal(fmtSecs(-1), '0.0 秒');
});

test('normHex：颜色输入规范化', () => {
  assert.equal(normHex('#ABC'), '#aabbcc');
  assert.equal(normHex('ff8800'), '#ff8800');
  assert.equal(normHex('＃ＦＦ００００'), '#ff0000');
  assert.equal(normHex('#12345'), null);
  assert.equal(normHex('red'), null);
});

test('字号：倍数与整数字号互换，默认字号回到倍数 1', () => {
  assert.equal(sizeToPt(1, 'title'), Math.round(1080 * TEXT_PRESET_SIZE.title));
  assert.equal(sizeToPt(undefined, 'subtitle'), 54);
  assert.equal(sizeToPt(0.8, 'subtitle'), 43);
  assert.equal(sizeToPt(1, '未知预设'), sizeToPt(1, 'title'));
  assert.equal(ptToSize(99, 'title'), 1);
  assert.equal(ptToSize(54, 'subtitle'), 1);
  assert.equal(ptToSize(108, 'subtitle'), 2);
  assert.equal(ptToSize(0, 'subtitle'), null);
  const r = ptRange('subtitle');
  assert.deepEqual(r, { min: 17, max: 162, def: 54 });
  // 范围两端换回倍数仍在引擎允许的 0.2–5 之内
  assert.ok(ptToSize(r.min, 'subtitle') >= 0.2 && ptToSize(r.max, 'subtitle') <= 5);
  // 往返稳定：字号 → 倍数 → 字号 不变
  for (const pt of [17, 40, 43, 77, 162]) assert.equal(sizeToPt(ptToSize(pt, 'subtitle'), 'subtitle'), pt);
});

test('节拍：旧数组 / 新对象都能整理，估算每分钟拍数', () => {
  const beats = Array.from({ length: 16 }, (_, i) => i * 0.5);
  assert.equal(bpmFromBeats(beats), 120);
  assert.equal(bpmFromBeats([0, 1]), null);
  const a = normalizeBeats(beats);
  assert.equal(a.bpm, 120);
  assert.equal(a.beats.length, 16);
  assert.equal(a.confidence, null);
  const b = normalizeBeats({ beats: [2, 1, 'x', -1, 3], bpm: 98.26, confidence: 0.8 });
  assert.deepEqual(b.beats, [1, 2, 3]);
  assert.equal(b.bpm, 98.3);
  assert.equal(b.confidence, 0.8);
  const c = normalizeBeats({ beats: [], tempo: { bpm: 0, confidence: 0.1 } });
  assert.equal(c.bpm, null);
  assert.equal(c.confidence, 0.1);
  assert.deepEqual(normalizeBeats(null), { beats: [], bpm: null, confidence: null, noTempo: false });
  // 检测器明确说「没有明显节拍」（bpm:null）：不再用节拍间隔硬估每分钟拍数
  const d = normalizeBeats({ beats, bpm: null, confidence: 0.12 });
  assert.equal(d.bpm, null);
  assert.equal(d.noTempo, true);
  assert.equal(normalizeBeats({ beats, tempo: { bpm: null } }).noTempo, true);
  assert.equal(normalizeBeats({ beats, tempo: undefined }).bpm, 120);
});

test('beatInfo / describeBeats：没分析、没有明显节拍、可以踩点', () => {
  assert.equal(beatInfo(null).status, 'unknown');
  assert.equal(beatInfo({ id: 'a' }).status, 'unknown');
  assert.equal(beatInfo({ beats: [] }).status, 'none');
  assert.equal(beatInfo({ beats: [0, 0.5, 1, 1.5], tempo: { bpm: 120, confidence: 0.1 } }).status, 'none');
  assert.equal(beatInfo({ beats: Array.from({ length: 8 }, (_, i) => i * 0.5), tempo: { bpm: null, confidence: 0.2 } }).status, 'none');
  const ok = beatInfo({ beats: Array.from({ length: 8 }, (_, i) => i * 0.5) });
  assert.equal(ok.status, 'ok');
  assert.equal(describeBeats(ok), '每分钟约 120 拍 · 共 8 拍');
  assert.equal(describeBeats(beatInfo({ beats: [] })), '没有明显节拍');
  assert.equal(describeBeats(beatInfo({})), '还没分析节拍');
  assert.equal(movedCuts({ ok: true, applied: ['剪辑点对齐音乐节拍（已对齐 3 个剪辑点）'] }), 3);
  assert.equal(movedCuts({ ok: true, applied: ['修改'] }), null);
  assert.equal(movedCuts(null), null);
});

test('upsertKey：同一时刻只改值并保留缓动，新帧按时间排序', () => {
  const list = [{ t: 0, v: 1, ease: 'linear' }, { t: 2, v: 3, ease: 'ease' }];
  const a = upsertKey(list, 2.004, 5);
  assert.deepEqual(a, [{ t: 0, v: 1, ease: 'linear' }, { t: 2, v: 5, ease: 'ease' }]);
  const b = upsertKey(list, 1, 2);
  assert.deepEqual(b.map((k) => k.t), [0, 1, 2]);
  assert.equal(b[1].ease, 'ease');
  assert.deepEqual(upsertKey([], 0.5, 0.8, { audio: true }), [{ t: 0.5, v: 0.8 }]);
  assert.equal(list[1].v, 3, '不改原数组');
});

test('localTime：播放头在片段外时夹到片段内（末端留一帧）', () => {
  assert.deepEqual(localTime(3, 2, 4, 30), { lt: 1, inside: true });
  const before = localTime(1, 2, 4, 30);
  assert.equal(before.inside, false);
  assert.equal(before.lt, 0);
  const after = localTime(9, 2, 4, 25);
  assert.equal(after.inside, false);
  assert.ok(Math.abs(after.lt - (4 - 1 / 25)) < 1e-9);
  assert.equal(localTime(6, 2, 4).inside, false, '片段终点属于下一个片段');
});
