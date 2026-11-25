// keyframes.js 单元测试：插值、增删、邻帧、时刻汇总、运镜预设
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  valueAt, setKey, removeKey, neighborKeys, allKeyTimes, easeFn, animatedProps, motionPresetKeys, shiftKeys, isKeyPath,
} from '../src/engine/keyframes.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('valueAt：无关键帧返回 base，首帧前/末帧后取端点值', () => {
  assert.equal(valueAt({}, 'opacity', 1, 0.7), 0.7);
  assert.equal(valueAt(null, 'opacity', 1, 0.7), 0.7);
  const keys = { opacity: [{ t: 1, v: 0, ease: 'linear' }, { t: 3, v: 1, ease: 'linear' }] };
  assert.equal(valueAt(keys, 'opacity', 0, 0.5), 0);
  assert.equal(valueAt(keys, 'opacity', 5, 0.5), 1);
  near(valueAt(keys, 'opacity', 2, 0.5), 0.5);
});

test('valueAt：ease / easeIn / easeOut / hold', () => {
  const mk = (ease) => ({ 'transform.x': [{ t: 0, v: 0, ease }, { t: 1, v: 1, ease: 'linear' }] });
  near(valueAt(mk('linear'), 'transform.x', 0.25), 0.25);
  near(valueAt(mk('ease'), 'transform.x', 0.5), 0.5);
  assert.ok(valueAt(mk('ease'), 'transform.x', 0.25) < 0.25);
  assert.ok(valueAt(mk('easeIn'), 'transform.x', 0.5) < 0.5);
  assert.ok(valueAt(mk('easeOut'), 'transform.x', 0.5) > 0.5);
  assert.equal(valueAt(mk('hold'), 'transform.x', 0.99), 0);
  assert.equal(valueAt(mk('hold'), 'transform.x', 1), 1);
  assert.equal(easeFn('ease', 0), 0);
  assert.equal(easeFn('easeOut', 1), 1);
});

test('setKey：不可变、按时间排序、同一时刻替换', () => {
  const k0 = Object.freeze({});
  const k1 = setKey(k0, 'opacity', 2, 0.5);
  const k2 = setKey(k1, 'opacity', 1, 1, 'ease');
  const k3 = setKey(k2, 'opacity', 2.001, 0.2);
  assert.deepEqual(k0, {});
  assert.deepEqual(k2.opacity.map((k) => k.t), [1, 2]);
  assert.equal(k2.opacity[0].ease, 'ease');
  assert.equal(k3.opacity.length, 2);
  assert.equal(k3.opacity[1].v, 0.2);
  assert.equal(k1.opacity[0].v, 0.5, '旧对象不变');
});

test('removeKey：删除指定时刻，删空移除 path', () => {
  let k = setKey(setKey({}, 'volume', 0, 1), 'volume', 1, 0);
  k = removeKey(k, 'volume', 1);
  assert.equal(k.volume.length, 1);
  k = removeKey(k, 'volume', 0);
  assert.equal('volume' in k, false);
  assert.deepEqual(removeKey({}, 'volume', 3), {});
});

test('neighborKeys / allKeyTimes', () => {
  let k = setKey({}, 'opacity', 1, 1);
  k = setKey(k, 'opacity', 3, 0);
  k = setKey(k, 'transform.scale', 2, 1.2);
  const n = neighborKeys(k, 'opacity', 2);
  assert.equal(n.prev.t, 1);
  assert.equal(n.next.t, 3);
  const at = neighborKeys(k, 'opacity', 1);
  assert.equal(at.prev, null, '不含当前时刻');
  assert.equal(at.next.t, 3);
  const any = neighborKeys(k, null, 1.5);
  assert.equal(any.next.t, 2);
  assert.equal(any.next.path, 'transform.scale');
  assert.deepEqual(allKeyTimes(k), [1, 2, 3]);
  assert.deepEqual(allKeyTimes(null), []);
});

test('animatedProps：transform.rotate 对应 rotation，颜色与不透明度', () => {
  const item = {
    transform: { scale: 1, x: 0, y: 0, rotation: 10 }, opacity: 1, volume: 1, color: { exposure: 0 },
    keys: { 'transform.rotate': [{ t: 0, v: 0, ease: 'linear' }, { t: 2, v: 90, ease: 'linear' }], 'color.exposure': [{ t: 0, v: 0.4, ease: 'linear' }], opacity: [{ t: 0, v: 0.5, ease: 'linear' }] },
  };
  const p = animatedProps(item, 1);
  near(p.transform.rotation, 45);
  assert.equal(p.transform.scale, 1);
  assert.equal(p.color.exposure, 0.4);
  assert.equal(p.opacity, 0.5);
  assert.equal(p.volume, 1);
});

test('motionPresetKeys / shiftKeys / isKeyPath', () => {
  const push = motionPresetKeys('push-in', 0.5, 4);
  assert.equal(push['transform.scale'][0].v, 1);
  assert.ok(push['transform.scale'][1].v > 1);
  assert.equal(push['transform.scale'][1].t, 4);
  assert.deepEqual(motionPresetKeys('none'), {});
  assert.ok(motionPresetKeys('shake', 1, 2)['transform.x'].length > 3);
  const s = shiftKeys({ opacity: [{ t: 0, v: 1 }, { t: 2, v: 0 }] }, -1);
  assert.deepEqual(s.opacity.map((k) => k.t), [1]);
  assert.ok(isKeyPath('color.exposure'));
  assert.ok(!isKeyPath('foo.bar'));
});
