import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// 只抽取纯函数，避免加载 zustand/store
const src = readFileSync(new URL('../src/ui/modes/refine/usePlayback.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('export const SHUTTLE_STEPS'), src.indexOf('let shuttleRaf')).replace(/export const useShuttle[^\n]*\n/, '').replace(/export /g, '');
const { nextShuttleRate, shuttleBadge } = new Function(body + '; return { nextShuttleRate, shuttleBadge };')();
test('J/K/L 穿梭状态机', () => {
  let r = 0; const seq = (k) => (r = nextShuttleRate(r, k));
  assert.equal(seq('L'), 1); assert.equal(seq('L'), 2); assert.equal(seq('L'), 4); assert.equal(seq('L'), 4);
  assert.equal(seq('J'), -1); assert.equal(seq('J'), -2); assert.equal(seq('J'), -4); assert.equal(seq('J'), -4);
  assert.equal(seq('K'), 0); assert.equal(seq('J'), -1); assert.equal(seq('L'), 1);
});
test('预览左上角倍速角标：倒放 / 快进显示，正常播放与停止不显示', () => {
  const back1 = shuttleBadge(-1, false);
  assert.equal(back1.dir, 'back'); assert.equal(back1.rate, 1); assert.equal(back1.text, '◀ 1×');
  assert.match(back1.title, /倒放/); assert.match(back1.title, /没有声音/);
  assert.equal(shuttleBadge(-4, false).text, '◀◀ 4×');
  assert.equal(shuttleBadge(-2, true).dir, 'back', '倒放时 store 的 playing 为 false，也不依赖它');
  const fwd = shuttleBadge(2, true);
  assert.equal(fwd.dir, 'fwd'); assert.equal(fwd.text, '▶▶ 2×'); assert.match(fwd.title, /快进/);
  assert.equal(shuttleBadge(4, false), null, '快进被空格暂停后角标消失');
  assert.equal(shuttleBadge(1, true), null, '正常播放不显示');
  assert.equal(shuttleBadge(0, false), null);
  assert.equal(shuttleBadge(undefined, false), null);
  // 界面文字不出现术语
  for (const b of [back1, fwd]) assert.doesNotMatch(b.title, /保调|rAF|GOP/);
});