// 渲染与导出的纯函数单元测试。运行：node --test tests/render.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { motionTransform, composeTransform, coverSize, easeInOut } from '../src/render/motion.js';
import { transitionState, introOverlay } from '../src/render/transitions.js';
import { effectiveColor, isNeutral, primaryFilter, LOOK_PRESETS } from '../src/render/looks.js';
import { textAnimState, wrapText } from '../src/render/text.js';
import { previzCamera } from '../src/render/previz.js';
import { buildAudioPlan } from '../src/export/audioPlan.js';
import { TRANSITIONS, MOTIONS, LOOKS, SHOT_SIZES, createProject, createAsset, createClip, createAudioClip, createPrevizSpec } from '../src/engine/model.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------------- motionTransform ----------------

test('motionTransform: none / 未知预设为恒等变换', () => {
  for (const preset of ['none', 'static', 'not-a-preset', undefined]) {
    for (const p of [0, 0.5, 1]) {
      assert.deepEqual(motionTransform(preset, 0.8, p), { scale: 1, x: 0, y: 0, rotation: 0 });
    }
  }
});

test('motionTransform: 推近 / 拉远的起止', () => {
  assert.ok(near(motionTransform('push-in', 0.5, 0).scale, 1));
  assert.ok(near(motionTransform('push-in', 0.5, 1).scale, 1 + 0.18 * 0.5));
  assert.ok(motionTransform('push-in', 0.5, 0.5).scale > 1 && motionTransform('push-in', 0.5, 0.5).scale < 1.09);
  assert.ok(near(motionTransform('pull-out', 1, 0).scale, 1.18));
  assert.ok(near(motionTransform('pull-out', 1, 1).scale, 1));
});

test('motionTransform: 所有预设在任意进度下都不露边', () => {
  for (const preset of MOTIONS) {
    for (const intensity of [0, 0.3, 1]) {
      for (let i = 0; i <= 20; i += 1) {
        const m = motionTransform(preset, intensity, i / 20, 6);
        for (const v of Object.values(m)) assert.ok(Number.isFinite(v), `${preset} 输出非有限值`);
        assert.ok(m.scale >= 1 - 1e-9, `${preset} 缩小会露边`);
        // 放大 s 倍后可平移 (s-1)/2 不露边
        assert.ok(Math.abs(m.x) <= (m.scale - 1) / 2 + 1e-9, `${preset} x 位移超出安全范围 p=${i / 20}`);
        assert.ok(Math.abs(m.y) <= (m.scale - 1) / 2 + 1e-9, `${preset} y 位移超出安全范围 p=${i / 20}`);
      }
    }
  }
});

test('motionTransform: 摇镜方向与约定一致（向左摇 = 画面内容向右移）', () => {
  assert.ok(motionTransform('pan-left', 1, 0).x < 0 && motionTransform('pan-left', 1, 1).x > 0);
  assert.ok(motionTransform('pan-right', 1, 0).x > 0 && motionTransform('pan-right', 1, 1).x < 0);
  assert.ok(motionTransform('tilt-up', 1, 1).y > 0);
});

test('motionTransform: 晃动确定性、冲击变焦先冲后稳', () => {
  assert.deepEqual(motionTransform('shake', 0.7, 0.37, 5), motionTransform('shake', 0.7, 0.37, 5));
  assert.notDeepEqual(motionTransform('shake', 0.7, 0.37, 5), motionTransform('shake', 0.7, 0.41, 5));
  const peak = motionTransform('zoom-punch', 1, 0.15).scale;
  assert.ok(near(peak, 1.34, 1e-9));
  assert.ok(Math.abs(motionTransform('zoom-punch', 1, 1).scale - 1.06) < 0.01);
  assert.ok(motionTransform('zoom-punch', 1, 0.05).scale < peak);
});

test('motionTransform: 非法输入夹紧', () => {
  assert.deepEqual(motionTransform('push-in', 5, 9), motionTransform('push-in', 1, 1));
  assert.deepEqual(motionTransform('push-in', NaN, NaN), motionTransform('push-in', 0, 0));
});

test('composeTransform / coverSize', () => {
  const c = composeTransform({ scale: 2, x: 0.1, y: -0.2, rotation: 5, flipH: true }, { scale: 1.1, x: 0.05, y: 0, rotation: 1 });
  assert.ok(near(c.scale, 2.2) && near(c.x, 0.15) && near(c.y, -0.2) && near(c.rotation, 6) && c.flipH === true);
  assert.deepEqual(composeTransform(null, null), { scale: 1, x: 0, y: 0, rotation: 0, flipH: false });
  assert.deepEqual(coverSize(1920, 1080, 1080, 1920), { width: 1920 * (1920 / 1080), height: 1920 });
  assert.deepEqual(coverSize(0, 0, 100, 50), { width: 100, height: 50 });
});

// ---------------- transitionState ----------------

/** 图层在画面内是否完全不可见 */
function layerHidden(L) {
  if (L.alpha <= 1e-6) return true;
  if (Math.abs(L.x) >= 1 - 1e-9 || Math.abs(L.y) >= 1 - 1e-9) return true;
  if (L.clip) {
    const { edge, keep, feather } = L.clip;
    return keep === 'before' ? edge + feather / 2 <= 1e-9 : edge - feather / 2 >= 1 - 1e-9;
  }
  return false;
}

/** 图层是否以原样完整显示（无位移、缩放、旋转、模糊、裁切） */
function layerFull(L) {
  const clipOk = !L.clip || (L.clip.keep === 'before' ? L.clip.edge - L.clip.feather / 2 >= 1 - 1e-9 : L.clip.edge + L.clip.feather / 2 <= 1e-9);
  return near(L.alpha, 1, 1e-6) && near(L.x, 0, 1e-6) && near(L.y, 0, 1e-6) && near(L.scale, 1, 1e-6)
    && near(L.rotation, 0, 1e-6) && L.blur < 1e-6 && L.streakX < 1e-6 && L.streakY < 1e-6 && L.radial < 1e-6 && clipOk;
}

test('transitionState: 16 种转场齐全且都有独立实现', () => {
  assert.equal(TRANSITIONS.length, 16);
  const cut = JSON.stringify(transitionState('cut', 0.3));
  for (const type of TRANSITIONS) {
    if (type === 'cut') continue;
    assert.notEqual(JSON.stringify(transitionState(type, 0.3)), cut, `${type} 退化成了硬切`);
  }
});

test('transitionState: p=0 只看到出画镜头，p=1 只看到入画镜头', () => {
  for (const type of TRANSITIONS) {
    const s0 = transitionState(type, 0);
    assert.ok(layerFull(s0.outgoing), `${type} p=0 出画镜头不完整`);
    assert.ok(layerHidden(s0.incoming), `${type} p=0 入画镜头已可见`);
    assert.ok(!s0.overlay || s0.overlay.alpha < 1e-6, `${type} p=0 有覆盖色`);
    const s1 = transitionState(type, 1);
    assert.ok(layerFull(s1.incoming), `${type} p=1 入画镜头不完整`);
    // 'over' 叠放时，完整不透明的入画镜头盖在上面，出画镜头即使仍在底层也看不到
    const occluded = s1.mix === 'over' && layerFull(s1.incoming);
    assert.ok(occluded || layerHidden(s1.outgoing), `${type} p=1 出画镜头仍可见`);
    assert.ok(!s1.overlay || s1.overlay.alpha < 1e-6, `${type} p=1 有覆盖色`);
  }
});

test('transitionState: p=0.5 中点状态', () => {
  const cf = transitionState('crossfade', 0.5);
  assert.ok(near(cf.outgoing.alpha, 0.5) && near(cf.incoming.alpha, 0.5));
  assert.equal(cf.mix, 'add');
  for (const type of ['dip-black', 'dip-white']) {
    const d = transitionState(type, 0.5);
    assert.ok(near(d.overlay.alpha, 1), `${type} 中点应为纯色`);
    assert.equal(d.overlay.color, type === 'dip-black' ? '#000000' : '#ffffff');
  }
  const f = transitionState('flash', 0.5);
  assert.ok(f.overlay && near(f.overlay.alpha, 1));
  const sl = transitionState('slide-left', 0.5);
  assert.ok(near(sl.outgoing.x, -0.5) && near(sl.incoming.x, 0.5), '推移中点两镜各占一半');
  assert.ok(sl.outgoing.streakX > 0, '推移中段应有运动模糊');
  const wp = transitionState('whip-pan', 0.5);
  assert.ok(wp.outgoing.streakX > 0.2, '甩镜中点应强烈模糊');
  for (const type of TRANSITIONS) {
    const s = transitionState(type, 0.5);
    for (const L of [s.outgoing, s.incoming]) {
      assert.ok(L.alpha >= 0 && L.alpha <= 1, `${type} alpha 越界`);
      assert.ok(L.blur >= 0 && L.blur <= 1, `${type} blur 越界`);
    }
  }
});

test('transitionState: 叠化的两镜 alpha 之和恒为 1（中点亮度不塌陷）', () => {
  for (const type of ['crossfade', 'blur', 'zoom-in', 'zoom-out', 'spin', 'flash']) {
    for (let i = 0; i <= 10; i += 1) {
      const s = transitionState(type, i / 10);
      assert.equal(s.mix, 'add');
      assert.ok(near(s.outgoing.alpha + s.incoming.alpha, 1, 1e-9), `${type} p=${i / 10}`);
    }
  }
});

test('transitionState: 未知类型按硬切，越界进度被夹紧', () => {
  assert.deepEqual(transitionState('???', 0.2), transitionState('cut', 0.2));
  assert.deepEqual(transitionState('crossfade', -3), transitionState('crossfade', 0));
  assert.deepEqual(transitionState('crossfade', 7), transitionState('crossfade', 1));
});

test('introOverlay: 第一镜从黑 / 白淡入', () => {
  assert.deepEqual(introOverlay('dip-black', 0), { color: '#000000', alpha: 1 });
  assert.deepEqual(introOverlay('dip-white', 0), { color: '#ffffff', alpha: 1 });
  assert.equal(introOverlay('crossfade', 1), null);
  assert.equal(introOverlay('slide-left', 0), null);
  assert.ok(near(introOverlay('crossfade', 0.5).alpha, 1 - easeInOut(0.5)));
});

// ---------------- effectiveColor ----------------

test('effectiveColor: 默认参数为中性，走无滤镜快速路径', () => {
  const g = effectiveColor({ exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0, vignette: 0, look: 'none', lookStrength: 1 });
  assert.ok(isNeutral(g));
  assert.equal(primaryFilter(g), '');
  assert.ok(isNeutral(effectiveColor(undefined)));
  assert.ok(isNeutral(effectiveColor({ look: 'not-a-look' })));
  assert.equal(effectiveColor({ look: 'not-a-look' }).look, 'none');
});

test('effectiveColor: look × lookStrength 线性插值并叠加用户参数', () => {
  const look = LOOK_PRESETS.cinematic;
  const half = effectiveColor({ look: 'cinematic', lookStrength: 0.5, contrast: 0.1 });
  assert.ok(near(half.contrast, 0.1 + look.contrast * 0.5));
  assert.ok(near(half.vignette, look.vignette * 0.5));
  assert.ok(near(half.splitStrength, 0.5));
  assert.equal(half.splitShadow, look.splitShadow);
  const zero = effectiveColor({ look: 'cinematic', lookStrength: 0 });
  assert.ok(isNeutral(zero), 'lookStrength=0 应等于不套 look');
  const dflt = effectiveColor({ look: 'vintage' });
  assert.ok(near(dflt.lookStrength, 1), '缺少 lookStrength 时按 1');
  assert.ok(near(dflt.fade, LOOK_PRESETS.vintage.fade));
});

test('effectiveColor: 结果夹紧在合法区间', () => {
  const g = effectiveColor({ look: 'noir', lookStrength: 3, contrast: 0.9, saturation: -0.8, exposure: 'abc', vignette: 0.9 });
  assert.ok(g.contrast <= 1 && g.saturation >= -1 && g.exposure >= -1 && g.vignette <= 1);
  assert.ok(near(g.lookStrength, 1));
  assert.ok(near(g.saturation, -1));
  for (const look of LOOKS) {
    const e = effectiveColor({ look, lookStrength: 1 });
    for (const k of ['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'highlights', 'shadows']) {
      assert.ok(e[k] >= -1 && e[k] <= 1, `${look}.${k}`);
    }
    assert.ok(LOOK_PRESETS[look], `缺少 look 预设：${look}`);
  }
  assert.match(primaryFilter(effectiveColor({ look: 'bw' })), /saturate\(0\.0000\)/);
});

// ---------------- 文字 ----------------

test('textAnimState: 各动画的起止状态', () => {
  assert.ok(textAnimState('fade', 0, 0).alpha < 1e-9);
  assert.ok(near(textAnimState('fade', 0.5, 1.5).alpha, 1));
  assert.ok(textAnimState('pop', 0, 0).scale < 1);
  assert.ok(textAnimState('slide-up', 0, 0).dy > 0);
  const tw = textAnimState('typewriter', 0.2, 0.6);
  assert.ok(tw.typing && tw.reveal > 0 && tw.reveal < 1);
  assert.equal(textAnimState('typewriter', 0.9, 2.7).reveal, 1);
  assert.deepEqual(textAnimState('none', 0, 0), { alpha: 1, scale: 1, dy: 0, reveal: 1, typing: false });
});

test('wrapText: 中英混排换行，标点不放行首', () => {
  const ctx = { measureText: (s) => ({ width: [...s].length * 10 }) };
  const lines = wrapText(ctx, '今天的咖啡，特别香。Hello world', 60);
  for (const l of lines) assert.ok(!'，。'.includes(l[0]), `行首出现标点：${l}`);
  assert.ok(lines.includes('Hello') || lines.some((l) => l.includes('Hello')));
  assert.deepEqual(wrapText(ctx, 'a\nb', 100), ['a', 'b']);
  assert.deepEqual(wrapText(ctx, '', 100), ['']);
});

// ---------------- 预演摄影机 ----------------

test('previzCamera: 景别越紧，取景缩放越大；确定性', () => {
  const spec = createPrevizSpec ? createPrevizSpec() : {};
  const order = ['extreme-wide', 'wide', 'full', 'medium', 'medium-close', 'close-up', 'extreme-close-up'];
  let last = 0;
  for (const shotSize of order) {
    assert.ok(SHOT_SIZES.includes(shotSize));
    const cam = previzCamera(spec, 0.5, 1280, 720, { shotSize });
    assert.ok(cam.Z > last, `${shotSize} 应比上一档更紧`);
    last = cam.Z;
  }
  assert.deepEqual(
    JSON.stringify(previzCamera(spec, 0.3, 640, 360, { movement: 'push-in' })),
    JSON.stringify(previzCamera(spec, 0.3, 640, 360, { movement: 'push-in' })),
  );
  const a = previzCamera(spec, 0, 640, 360, { movement: 'push-in' });
  const b = previzCamera(spec, 1, 640, 360, { movement: 'push-in' });
  assert.ok(b.Z > a.Z, '推近时取景逐渐变紧');
  const empty = previzCamera(null, 0.5, 640, 360);
  assert.ok(Number.isFinite(empty.Z) && Number.isFinite(empty.yh));
});

// ---------------- buildAudioPlan ----------------

function audioProject() {
  const p = createProject({ name: '音频测试' });
  const v1 = createAsset({ id: 'v1', kind: 'video', path: 'C:/m/a.mp4', duration: 10, hasAudio: true });
  const v2 = createAsset({ id: 'v2', kind: 'video', path: 'C:/m/b.mp4', duration: 10, hasAudio: true });
  const img = createAsset({ id: 'i1', kind: 'image', path: 'C:/m/c.png', duration: 4, hasAudio: false });
  const music = createAsset({ id: 'm1', kind: 'audio', path: 'C:/m/music.mp3', duration: 60, hasAudio: true });
  p.assets = { v1, v2, i1: img, m1: music };
  const c1 = createClip(v1, { id: 'c1', in: 1, out: 5 });
  const c2 = createClip(v2, { id: 'c2', in: 0, out: 4, transitionIn: { type: 'crossfade', duration: 1 }, volume: 0.8, audioFadeOut: 0.3 });
  const c3 = createClip(img, { id: 'c3', in: 0, out: 3 });
  const c4 = createClip(v1, { id: 'c4', in: 0, out: 2, mute: true });
  p.tracks.video = [c1, c2, c3, c4];
  p.tracks.audio = [createAudioClip(music, { id: 'a1', start: 0, in: 2, out: 40, volume: 0.5, fadeIn: 1, fadeOut: 2 })];
  return p;
}

test('buildAudioPlan: 主轨片段、转场交叉淡化、静音与无声素材', () => {
  const p = audioProject();
  const plan = buildAudioPlan(p, { duration: 12 });
  assert.equal(plan.duration, 12);
  const clips = plan.segments.filter((s) => s.role === 'clip');
  assert.equal(clips.length, 2, '图片镜头和静音镜头不应出声');
  const [s1, s2] = clips;
  assert.equal(s1.path, 'C:/m/a.mp4');
  assert.equal(s1.timelineStart, 0);
  assert.equal(s1.srcIn, 1);
  assert.equal(s1.srcOut, 5);
  assert.equal(s1.fadeOut, 1, '出画镜头在转场重叠区淡出');
  assert.equal(s2.timelineStart, 3, '第二镜因 1 秒叠化提前 1 秒开始');
  assert.equal(s2.fadeIn, 1, '入画镜头在转场重叠区淡入');
  assert.equal(s2.fadeOut, 0.3);
  assert.equal(s2.volume, 0.8);
  const music = plan.segments.find((s) => s.role === 'music');
  assert.ok(music, '音频轨应进入计划');
  assert.equal(music.srcIn, 2);
  assert.equal(music.volume, 0.5);
  // 裁到导出时长：12 秒 → 源 2..14
  assert.equal(music.srcOut, 14);
  assert.ok(music.fadeIn + music.fadeOut <= 12);
});

test('buildAudioPlan: 变速、越界裁剪与空项目', () => {
  const p = audioProject();
  p.tracks.video[0].speed = 2; // 源 1..5 → 时间线 2 秒
  const plan = buildAudioPlan(p, { duration: 30 });
  const s1 = plan.segments.find((s) => s.role === 'clip');
  assert.equal(s1.speed, 2);
  assert.equal(s1.srcOut, 5);
  const short = buildAudioPlan(p, { duration: 1 });
  for (const s of short.segments) {
    assert.ok(s.timelineStart + (s.srcOut - s.srcIn) / s.speed <= 1 + 1e-6, '片段不能超出导出时长');
    assert.ok(s.fadeIn + s.fadeOut <= (s.srcOut - s.srcIn) / s.speed + 1e-6);
  }
  assert.deepEqual(buildAudioPlan(createProject(), { duration: 0 }), { duration: 0, segments: [] });
  assert.deepEqual(buildAudioPlan(null).segments, []);
  const missing = audioProject();
  delete missing.assets.v2;
  assert.equal(buildAudioPlan(missing, { duration: 12 }).segments.filter((s) => s.role === 'clip').length, 1, '缺失素材的镜头被跳过');
});

// ---------------- v3：关键帧 / 变速 / 画中画 / 预设 / 音频计划 ----------------
import { keyValueAt, animatedProps, fitSize } from '../src/render/motion.js';
import { srcTimeOf, cropRect, maskGeometry, blendOp, visibleOverlays } from '../src/render/compositor.js';
import { textAnimV3 } from '../src/render/text.js';
import { EXPORT_PRESETS, resolveExportOptions, presetById } from '../src/export/presets.js';
import { effectiveSpeed } from '../src/export/audioPlan.js';
import { toSrt, srtTimestamp } from '../src/export/exporter.js';

test('v3 keyValueAt: 线性 / hold / 越界', () => {
  const keys = { opacity: [{ t: 0, v: 0 }, { t: 2, v: 1 }], 'transform.x': [{ t: 0, v: 0, ease: 'hold' }, { t: 1, v: 0.5 }] };
  assert.equal(keyValueAt(keys, 'opacity', 1, 9), 0.5);
  assert.equal(keyValueAt(keys, 'opacity', -1, 9), 0);
  assert.equal(keyValueAt(keys, 'opacity', 5, 9), 1);
  assert.equal(keyValueAt(keys, 'transform.x', 0.9, 9), 0);
  assert.equal(keyValueAt(keys, 'missing', 1, 7), 7);
});

test('v3 animatedProps: transform/opacity/color 走关键帧', () => {
  const p = animatedProps({ transform: { scale: 1 }, opacity: 1, color: { exposure: 0 }, keys: { 'transform.scale': [{ t: 0, v: 1 }, { t: 1, v: 2 }], 'color.exposure': [{ t: 0, v: 0 }, { t: 1, v: 0.4 }] } }, 0.5);
  assert.ok(near(p.transform.scale, 1.5));
  assert.ok(near(p.color.exposure, 0.2));
  assert.equal(p.opacity, 1);
});

test('v3 srcTimeOf: 倒放 / 定格 / 常速（timeline.sourceTimeAt 缺失时的回退）', () => {
  const clip = { in: 2, out: 6, speed: 2 };
  const v = srcTimeOf(clip, 1);
  assert.ok(near(v, 4));
  const rev = srcTimeOf({ in: 2, out: 6, speed: 1, reverse: true }, 1);
  assert.ok(near(rev, 5), `倒放应从出点往回走，得到 ${rev}`);
  assert.equal(srcTimeOf({ in: 3, out: 3, still: true }, 1.5), 3);
});

test('v3 cropRect / fitSize / mask / blend', () => {
  assert.deepEqual(cropRect(1000, 500, { l: 0.1, r: 0.1 }), [100, 0, 800, 500]);
  assert.deepEqual(cropRect(100, 100, { l: 0.9 }).map(Math.round), [45, 0, 55, 100]);
  assert.deepEqual(fitSize(1920, 1080, 1080, 1920, 'contain'), { width: 1080, height: 607.5 });
  assert.deepEqual(fitSize(1920, 1080, 100, 100, 'fill'), { width: 100, height: 100 });
  const g = maskGeometry({ shape: 'circle', cx: 0.25, w: 0.5, feather: 1, invert: true }, 400, 200);
  assert.equal(g.cx, 100);
  assert.equal(g.invert, true);
  assert.ok(g.feather > 0);
  assert.equal(blendOp('add'), 'lighter');
  assert.equal(blendOp('screen'), 'screen');
  assert.equal(blendOp('??'), 'source-over');
});

test('v3 visibleOverlays: 时间筛选、隐藏轨、track 升序', () => {
  const project = {
    overlays: [
      { id: 'a', track: 3, start: 0, in: 0, out: 4 },
      { id: 'b', track: 1, start: 1, in: 0, out: 2 },
      { id: 'c', track: 2, start: 0, in: 0, out: 5 },
      { id: 'd', track: 1, start: 10, in: 0, out: 2 },
    ],
    tracks: { overlay: { 2: { hidden: true } } },
  };
  assert.deepEqual(visibleOverlays(project, 1.5).map((o) => o.id), ['b', 'a']);
});

test('v3 textAnimV3: 入场 / 出场 / 循环', () => {
  const clip = { animIn: { type: 'slide-up', dur: 0.5 }, animOut: { type: 'fade', dur: 0.5 }, animLoop: { type: 'pulse', dur: 1 } };
  const start = textAnimV3(clip, 0, 0);
  assert.ok(start.alpha < 0.05 && start.dy > 0.5);
  const mid = textAnimV3(clip, 0.5, 2);
  assert.ok(near(mid.alpha, 1));
  const end = textAnimV3(clip, 1, 4);
  assert.ok(end.alpha < 0.05);
});

test('v3 presets: 七个预设齐全，竖屏预设遇横屏项目不拉伸', () => {
  assert.deepEqual(EXPORT_PRESETS.map((p) => p.id), ['douyin', 'bilibili', 'shipinhao', 'youtube4k', 'custom', 'audio-mp3', 'gif']);
  for (const p of EXPORT_PRESETS) for (const k of ['w', 'h', 'fps', 'bitrate', 'format']) assert.ok(k in p, `${p.id} 缺 ${k}`);
  const d = resolveExportOptions('douyin', { width: 1080, height: 1920, fps: 30 });
  assert.deepEqual([d.w, d.h, d.fps, d.format], [1080, 1920, 30, 'mp4']);
  const land = resolveExportOptions('douyin', { width: 1920, height: 1080 });
  assert.equal(land.w, 1920);
  assert.equal(land.h, 1080);
  const b = resolveExportOptions('bilibili', { width: 1920, height: 1080, fps: 30 });
  assert.equal(b.fps, 60);
  const mp3 = resolveExportOptions('audio-mp3', {});
  assert.ok(mp3.audioOnly && mp3.ext === 'mp3');
  const gif = resolveExportOptions('gif', { width: 1920, height: 1080 });
  assert.ok(gif.gif && gif.w === 480 && gif.h === 270);
  const c = resolveExportOptions('custom', { width: 1280, height: 720, fps: 25 }, { format: 'mov', bitrate: 5000 });
  assert.deepEqual([c.w, c.h, c.fps, c.format, c.bitrate], [1280, 720, 25, 'mov', 5000]);
  assert.equal(presetById('nope').id, 'custom');
});

test('v3 audioPlan: 倒放、曲线平均速度、音量关键帧、降噪、画中画声音、静音', () => {
  assert.equal(effectiveSpeed({ in: 0, out: 4, speed: 2 }), 2);
  const sp = effectiveSpeed({ in: 0, out: 4, speed: 1, speedCurve: [{ t: 0, v: 2 }, { t: 1, v: 2 }] });
  assert.ok(near(sp, 2, 1e-3), `恒定曲线 2x 平均速度应为 2，得到 ${sp}`);
  const project = createProject({ name: 't' });
  const v = createAsset({ kind: 'video', path: 'C:/v.mp4', duration: 10, hasAudio: true });
  const m = createAsset({ kind: 'audio', path: 'C:/m.mp3', duration: 30, hasAudio: true });
  project.assets[v.id] = v;
  project.assets[m.id] = m;
  const clip = createClip({ assetId: v.id, in: 1, out: 5 });
  clip.assetId = v.id;
  clip.in = 1;
  clip.out = 5;
  clip.reverse = true;
  clip.denoise = true;
  clip.keys = { volume: [{ t: 0, v: 0 }, { t: 1, v: 1 }] };
  project.tracks.video.push(clip);
  const a = createAudioClip({ assetId: m.id, start: 0, in: 0, out: 4 });
  Object.assign(a, { assetId: m.id, start: 0, in: 0, out: 4 });
  a.volumeKeys = [{ t: 0, v: 1 }, { t: 2, v: 0.25 }];
  project.tracks.audio.push(a);
  project.overlays = [{ id: 'o1', assetId: v.id, track: 1, start: 0.5, in: 0, out: 2, kind: 'video' }, { id: 'o2', assetId: v.id, track: 1, start: 0, in: 0, out: 2, muted: true }];
  const plan = buildAudioPlan(project);
  const cs = plan.segments.find((s) => s.role === 'clip');
  assert.equal(cs.reverse, true);
  assert.equal(cs.denoise, true);
  assert.equal(cs.volume, 1);
  assert.deepEqual(cs.volumeKeys, [{ t: 0, v: 0 }, { t: 1, v: 1 }]);
  const ms = plan.segments.find((s) => s.path === 'C:/m.mp3');
  assert.equal(ms.volumeKeys.length, 2);
  const ov = plan.segments.filter((s) => s.role === 'overlay');
  assert.equal(ov.length, 1);
  assert.equal(ov[0].timelineStart, 0.5);
});

test('v3 SRT：时间戳与内联生成', () => {
  assert.equal(srtTimestamp(3725.5), '01:02:05,500');
  const srt = toSrt([{ start: 1, duration: 1.5, text: '第二句' }, { start: 0, duration: 1, text: '第一句' }]);
  assert.match(srt, /第一句/);
  assert.ok(srt.indexOf('第一句') < srt.indexOf('第二句'));
});
