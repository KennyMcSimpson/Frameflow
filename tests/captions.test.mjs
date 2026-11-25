import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentsToTexts, textsToSrt, parseSrt, mergeSegments, splitSegment, wrapCaption, captionY } from '../src/engine/captions.js';

const segs = [
  { start: 0, end: 1.5, text: '大家好' },
  { start: 1.5, end: 4, text: '今天我们来聊一聊如何用手机拍出电影感的画面' },
];

test('segmentsToTexts: caption group, 安全区, 拆行', () => {
  const t = segmentsToTexts(segs, { aspect: '9:16' });
  assert.equal(t.length, 2);
  assert.equal(t[0].group, 'caption');
  assert.equal(t[0].y, captionY('9:16'));
  assert.ok(t[0].y > 0.7);
  for (const line of t[1].text.split('\n')) assert.ok(Array.from(line).length <= 16);
  assert.ok(t[1].text.includes('\n'));
  assert.equal(t[1].duration, 2.5);
});

test('wrapCaption 短文本不变', () => { assert.equal(wrapCaption('你好'), '你好'); });

test('SRT 往返', () => {
  const srt = textsToSrt(segmentsToTexts(segs));
  assert.match(srt, /00:00:01,500 --> 00:00:04,000/);
  const back = parseSrt(srt);
  assert.equal(back.length, 2);
  assert.equal(back[1].start, 1.5);
  assert.equal(back[1].text.replace(/\n/g, ''), segs[1].text);
});

test('parseSrt 兼容 BOM/CRLF/VTT 点号', () => {
  const r = parseSrt('﻿1\r\n00:00:01.2 --> 00:00:02.000\r\n<i>嗨</i>\r\n\r\n');
  assert.deepEqual(r, [{ start: 1.2, end: 2, text: '嗨' }]);
});

test('merge / split', () => {
  const m = mergeSegments(segs, 0);
  assert.equal(m.length, 1);
  assert.equal(m[0].end, 4);
  assert.ok(m[0].text.startsWith('大家好今天'));
  const s = splitSegment(m, 0, { charIndex: 3 });
  assert.equal(s.length, 2);
  assert.equal(s[0].text, '大家好');
  assert.ok(s[0].end > 0 && s[0].end < 4 && s[1].start === s[0].end);
  const w = splitSegment([{ start: 0, end: 2, text: 'ab', words: [{ start: 0, end: 1, text: 'a' }, { start: 1.1, end: 2, text: 'b' }] }], 0, { at: 1.05 });
  assert.equal(w[0].text, 'a'); assert.equal(w[1].start, 1.1);
});
