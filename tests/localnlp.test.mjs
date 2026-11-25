// localnlp.js 单元测试：中文白话 → Op[]。每条用例同时检查 applyOps 能成功应用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../src/engine/localnlp.js';
import { applyOps } from '../src/engine/ops.js';
import {
  createProject, createAsset, createClip, createTextClip, createAudioClip,
} from '../src/engine/model.js';

/** 5 个 4 秒镜头（第 n 镜时间 [4n-4, 4n]）+ 1 条标题 + 1 段音乐 */
function fixture() {
  const p = createProject({ name: '测试' });
  const v = createAsset({ id: 'v1', kind: 'video', duration: 20, stats: { luma: 0.4, contrast: 0.4, saturation: 0.4, warmth: 0, tint: 0, palette: [] } });
  const m = createAsset({ id: 'm', kind: 'audio', duration: 60, name: '配乐' });
  p.assets = { v1: v, m };
  p.tracks.video = [1, 2, 3, 4, 5].map((i) => createClip(v, { id: `c${i}`, in: 0, out: 4 }));
  p.tracks.text = [createTextClip({ id: 't1', text: '旧标题', preset: 'title' })];
  p.tracks.audio = [createAudioClip(m, { id: 'a1', out: 30, volume: 1 })];
  return p;
}

const PROJECT = fixture();

function parse(text, { selected = [], range = null, playhead = 6, project = PROJECT } = {}) {
  const ctx = { project, selectedClipIds: selected, range, playhead };
  const r = parseCommand(text, ctx);
  assert.ok(Array.isArray(r.ops) && Array.isArray(r.understood) && Array.isArray(r.unknown));
  return { ...r, ctx };
}

/** 解析成功：没有 unknown、有操作，且 applyOps 能应用 */
function understood(text, opts) {
  const r = parse(text, opts);
  assert.deepEqual(r.unknown, [], `「${text}」不应有无法理解的部分`);
  assert.ok(r.ops.length > 0, `「${text}」应生成操作`);
  assert.ok(r.understood.length > 0);
  const applied = applyOps(r.ctx.project, r.ops, r.ctx);
  assert.equal(applied.ok, true, `「${text}」生成的操作应能应用：${applied.errors.join('；')}`);
  return { ...r, result: applied.project };
}

const tgt = (op) => `${op.target.mode}:${op.target.mode === 'ids' ? op.target.ids.join(',') : op.target.indices.join(',')}`;

// ---------- 调色 ----------

test('第二段暖一点：中文数字 + 程度词「一点」', () => {
  const { ops } = understood('第二段暖一点');
  assert.equal(ops.length, 1);
  assert.equal(ops[0].type, 'setColor');
  assert.equal(tgt(ops[0]), 'index:2');
  assert.deepEqual(ops[0].color, { temperature: 0.15 });
  assert.equal(ops[0].relative, true);
});

test('复合句：把第3段调暖一点，第四段压暗', () => {
  const { ops, understood: u } = understood('把第3段调暖一点，第四段压暗');
  assert.deepEqual(ops.map(tgt), ['index:3', 'index:4']);
  assert.deepEqual(ops[0].color, { temperature: 0.15 });
  assert.deepEqual(ops[1].color, { exposure: -0.25 });
  assert.equal(u.length, 2);
});

test('程度词：很/非常 → 0.4', () => {
  assert.deepEqual(understood('第一段非常暖').ops[0].color, { temperature: 0.4 });
  assert.deepEqual(understood('整体很冷').ops[0].color, { temperature: -0.4 });
});

test('抱怨句「太亮了 / 画面太暗了」反向调整', () => {
  assert.deepEqual(understood('太亮了').ops[0].color, { exposure: -0.25 });
  assert.deepEqual(understood('画面太暗了').ops[0].color, { exposure: 0.25 });
});

test('参数名词：饱和度高一点、对比度再降低一点、提高对比度、阴影压暗一点、高光降低', () => {
  assert.deepEqual(understood('饱和度高一点').ops[0].color, { saturation: 0.15 });
  assert.deepEqual(understood('对比度再降低一点').ops[0].color, { contrast: -0.15 });
  assert.deepEqual(understood('提高对比度').ops[0].color, { contrast: 0.25 });
  assert.deepEqual(understood('阴影压暗一点').ops[0].color, { shadows: -0.15 });
  assert.deepEqual(understood('高光降低').ops[0].color, { highlights: -0.25 });
});

test('复合：画面稍微冷一点，饱和度降低', () => {
  const { ops } = understood('画面稍微冷一点，饱和度降低');
  assert.deepEqual(ops.map((o) => o.color), [{ temperature: -0.15 }, { saturation: -0.25 }]);
});

test('无目标的调色类：没选中时作用于全部，选中时作用于所选，框选时作用于范围', () => {
  assert.equal(tgt(understood('整体再亮一点').ops[0]), 'all:');
  assert.equal(tgt(understood('亮一点', { selected: ['c2'] }).ops[0]), 'selected:');
  assert.equal(tgt(understood('亮一点', { range: { start: 1, end: 5 } }).ops[0]), 'range:');
});

test('调色风格：电影感、青橙、赛博朋克、日系清新、高级感、黑白', () => {
  const { ops } = understood('把第1到3段调成电影感');
  assert.equal(ops[0].type, 'setLook');
  assert.equal(ops[0].look, 'cinematic');
  assert.equal(tgt(ops[0]), 'index:1,2,3');
  assert.equal(understood('第2段青橙').ops[0].look, 'cinematic');
  assert.equal(understood('来点赛博朋克').ops[0].look, 'cyberpunk');
  assert.equal(understood('日系清新').ops[0].look, 'soft-pastel');
  assert.equal(understood('高级感').ops[0].look, 'moody');
  assert.equal(understood('复古一点').ops[0].lookStrength, 0.5);
});

test('去色：第二、四段去色', () => {
  const { ops } = understood('第二、四段去色');
  assert.equal(tgt(ops[0]), 'index:2,4');
  assert.deepEqual(ops[0].color, { saturation: -1 });
  assert.equal(ops[0].relative, false);
});

test('「也是」：第2段黑白，第3段也是', () => {
  const { ops } = understood('第2段黑白，第3段也是');
  assert.deepEqual(ops.map(tgt), ['index:2', 'index:3']);
  assert.ok(ops.every((o) => o.type === 'setLook' && o.look === 'bw'));
});

test('目标合并与沿用：第二段和第三段暖一点，第四段冷一点', () => {
  const { ops } = understood('第二段和第三段暖一点，第四段冷一点');
  assert.deepEqual(ops.map(tgt), ['index:2,3', 'index:4']);
  assert.deepEqual(ops[1].color, { temperature: -0.15 });
});

test('目标沿用：第2段调暖，再加点颗粒', () => {
  const { ops } = understood('第2段调暖，加点颗粒');
  assert.deepEqual(ops.map(tgt), ['index:2', 'index:2']);
  assert.equal(ops[1].type, 'setFx');
});

test('「再把」分句：第2段调暖再把第3段调亮', () => {
  const { ops } = understood('第2段调暖再把第3段调亮');
  assert.deepEqual(ops.map(tgt), ['index:2', 'index:3']);
});

test('统一色调：强度随程度词变化', () => {
  const a = understood('统一色调').ops[0];
  assert.equal(a.type, 'harmonize');
  assert.equal(a.strength, 0.6);
  assert.equal(understood('色调统一一点').ops[0].strength, 0.4);
  assert.equal(understood('颜色要一致').ops[0].type, 'harmonize');
});

test('暗角：加暗角、去掉暗角', () => {
  assert.deepEqual(understood('加暗角').ops[0].color, { vignette: 0.4 });
  assert.deepEqual(understood('去掉暗角').ops[0].color, { vignette: 0 });
});

// ---------- 运镜、转场、特效 ----------

test('运镜：推近、左摇、手持感、拉远一点、去掉运镜、固定镜头', () => {
  const push = understood('第2段推近').ops[0];
  assert.deepEqual([push.type, push.preset, push.intensity, tgt(push)], ['setMotion', 'push-in', 0.5, 'index:2']);
  assert.equal(understood('第2到4段左摇').ops[0].preset, 'pan-left');
  assert.deepEqual([understood('加点手持感').ops[0].preset, understood('加点手持感').ops[0].intensity], ['shake', 0.3]);
  assert.equal(understood('拉远一点').ops[0].intensity, 0.3);
  assert.equal(understood('去掉运镜').ops[0].preset, 'none');
  assert.equal(understood('第一段固定镜头').ops[0].preset, 'none');
});

test('转场：叠化 1 秒、两段之间黑场、白场 2 秒、甩镜、模糊、去掉转场', () => {
  const x = understood('第2段加个叠化转场1秒').ops[0];
  assert.deepEqual([x.type, x.transition, tgt(x)], ['setTransition', { type: 'crossfade', duration: 1 }, 'index:2']);
  const between = understood('第2段和第3段之间加个黑场');
  assert.equal(tgt(between.ops[0]), 'index:3', '两段之间的转场属于后一镜');
  assert.equal(between.ops[0].transition.type, 'dip-black');
  assert.deepEqual(understood('第4段加个2秒的白场').ops[0].transition, { type: 'dip-white', duration: 2 });
  assert.deepEqual(understood('第2段甩镜').ops[0].transition, { type: 'whip-pan', duration: 0.3 });
  assert.equal(understood('第2段的转场改成模糊').ops[0].transition.type, 'blur');
  assert.equal(understood('最后一段淡入淡出').ops[0].transition.type, 'crossfade');
  assert.deepEqual(understood('去掉转场').ops[0].transition, { type: 'cut' });
  assert.equal(tgt(understood('开头加个黑场').ops[0]), 'index:1');
});

test('特效：胶片颗粒、VHS + 色差、闪白特效、减少颗粒、去掉特效', () => {
  assert.deepEqual(understood('全部加胶片颗粒').ops[0].fx, { grain: 0.4 });
  const both = understood('第2段加个VHS效果，并且加点色差').ops;
  assert.deepEqual(both.map((o) => o.fx), [{ vhs: 0.4 }, { chromatic: 0.2 }]);
  assert.deepEqual(understood('第一段加个闪白特效').ops[0].fx, { flash: 0.5 });
  const less = understood('减少颗粒').ops[0];
  assert.deepEqual([less.fx, less.relative], [{ grain: -0.2 }, true]);
  const none = understood('第3段去掉特效').ops[0];
  assert.ok(Object.values(none.fx).every((v) => v === 0));
});

test('画面变换：放大到 150%、水平翻转', () => {
  assert.deepEqual(understood('第2段放大到150%').ops[0].transform, { scale: 1.5 });
  assert.deepEqual(understood('水平翻转第3段').ops[0].transform, { flipH: true });
});

// ---------- 字幕、标题、声音 ----------

test('字幕：引号内容保留逗号，没有引号也能取到内容', () => {
  const quoted = understood('把字幕改成「早安，城市」', { selected: ['c2'] }).ops[0];
  assert.deepEqual([quoted.type, quoted.caption, tgt(quoted)], ['setCaption', { text: '早安，城市' }, 'selected:']);
  const bare = understood('第三段的字幕改成你好世界').ops[0];
  assert.deepEqual([bare.caption.text, tgt(bare)], ['你好世界', 'index:3']);
  const mixed = understood('把第2段的字幕改成"你好，世界"然后调暖').ops;
  assert.deepEqual(mixed.map((o) => o.type), ['setCaption', 'setColor']);
  assert.equal(mixed[0].caption.text, '你好，世界');
});

test('字幕：去掉字幕、字幕放上面', () => {
  assert.deepEqual(understood('去掉第2段的字幕').ops[0].caption, { text: '' });
  assert.deepEqual(understood('字幕放上面').ops[0].caption, { position: 'top' });
  assert.deepEqual(understood('把字幕移到中间', { selected: ['c1'] }).ops[0].caption, { position: 'center' });
});

test('字幕改文字没有目标时不猜，报告需要选中', () => {
  const r = parse('字幕改成「你好」');
  assert.equal(r.ops.length, 0);
  assert.match(r.unknown[0], /请先选中/);
});

test('标题：添加、跟随镜头开始时间、修改已有标题、删除标题', () => {
  const add = understood('加个标题「晨光咖啡」').ops[0];
  assert.deepEqual([add.type, add.text.text, add.text.preset], ['addText', '晨光咖啡', 'title']);
  assert.equal(add.text.start, undefined, '默认用播放头');
  assert.equal(understood('第3段加个标题「欢迎光临」').ops[0].text.start, 8);
  const upd = understood('标题改成「新标题」').ops[0];
  assert.deepEqual([upd.type, upd.textId, upd.text], ['updateText', 't1', { text: '新标题' }]);
  const rm = understood('去掉标题');
  assert.deepEqual([rm.ops[0].type, rm.ops[0].textId], ['removeText', 't1']);
  assert.equal(rm.result.tracks.text.length, 0);
  assert.ok(parse('加标题').unknown.length > 0, '没有内容的标题不应用');
});

test('声音：静音、取消静音、音量 50%、音量大一点、声音淡出', () => {
  assert.equal(understood('静音').ops[0].mute, true);
  assert.equal(understood('取消静音').ops[0].mute, false);
  assert.equal(understood('音量调到50%').ops[0].volume, 0.5);
  const louder = understood('音量大一点').ops[0];
  assert.deepEqual([louder.volume, louder.relative], [0.15, true]);
  assert.equal(understood('把第2段的音量调小').ops[0].volume, -0.25);
  assert.equal(understood('声音淡出').ops[0].audioFadeOut, 1);
});

test('音乐轨：音乐小一点、音乐音量 30%、去掉背景音乐', () => {
  const quieter = understood('音乐小一点');
  assert.deepEqual([quieter.ops[0].type, quieter.ops[0].audioId, quieter.ops[0].audio], ['updateAudio', 'a1', { volume: 0.85 }]);
  assert.equal(understood('音乐音量30%').ops[0].audio.volume, 0.3);
  const removed = understood('把背景音乐去掉');
  assert.equal(removed.ops[0].type, 'removeAudio');
  assert.equal(removed.result.tracks.audio.length, 0);
  const empty = { ...PROJECT, tracks: { ...PROJECT.tracks, audio: [] } };
  assert.match(parse('音乐小一点', { project: empty }).unknown[0], /没有音乐/);
});

// ---------- 速度、时长、节奏 ----------

test('速度：加速、慢动作、2 倍速、0.5 倍速、半速、恢复原速', () => {
  assert.equal(understood('第2段加速').ops[0].speed, 1.5);
  assert.equal(understood('慢动作', { selected: ['c3'] }).ops[0].speed, 0.5);
  assert.equal(understood('第3段2倍速').ops[0].speed, 2);
  assert.equal(understood('0.5倍速').ops[0].speed, 0.5);
  assert.equal(understood('半速').ops[0].speed, 0.5);
  assert.equal(understood('恢复原速').ops[0].speed, 1);
  assert.equal(understood('后两段慢一点').ops[0].speed, 0.5);
  assert.equal(tgt(understood('后两段慢一点').ops[0]), 'index:4,5');
});

test('时长：改成 3 秒、缩短一点、延长一点、去掉开头 2 秒', () => {
  const set = understood('第2段改成3秒').ops[0];
  assert.deepEqual([set.type, set.duration, tgt(set)], ['setDuration', 3, 'index:2']);
  assert.equal(understood('第3段变成5秒').ops[0].duration, 5);
  assert.equal(understood('第三段缩短一点').ops[0].duration, 3.4);
  assert.equal(understood('第2段延长一点').ops[0].duration, 4.6);
  const trim = understood('去掉开头的2秒', { selected: ['c2'] });
  assert.deepEqual([trim.ops[0].type, trim.ops[0].in, trim.ops[0].relative], ['trim', 2, true]);
  assert.equal(trim.result.tracks.video[1].in, 2);
  assert.equal(understood('剪掉最后1秒', { selected: ['c2'] }).ops[0].out, -1);
});

test('节奏：节奏快一点、节奏慢一点、卡点', () => {
  assert.equal(understood('节奏快一点').ops[0].pacing, 'fast');
  assert.equal(understood('节奏慢一点').ops[0].pacing, 'slow');
  const beat = understood('卡点');
  assert.equal(beat.ops[0].type, 'applyPacing');
  assert.equal(beat.ops[0].durations.length, 5);
  assert.ok(beat.ops[0].durations.every((d) => Math.abs(d / 0.5 - Math.round(d / 0.5)) < 1e-9), '吸附到 0.5 秒网格');
  assert.match(beat.understood[0], /未分析音乐实际节拍/);
});

test('画幅：改成竖屏、1:1', () => {
  const r = understood('画幅改成竖屏');
  assert.deepEqual([r.ops[0].type, r.ops[0].settings], ['setProject', { aspect: '9:16' }]);
  assert.equal(r.result.settings.height, 1920);
  assert.equal(understood('画幅改成1:1').ops[0].settings.aspect, '1:1');
});

// ---------- 结构 ----------

test('删除：删除第4段、把第二段删了、最后两段删掉、把结尾那段删掉', () => {
  const del = understood('删除第4段');
  assert.deepEqual([del.ops[0].type, tgt(del.ops[0])], ['delete', 'index:4']);
  assert.deepEqual(del.result.tracks.video.map((c) => c.id), ['c1', 'c2', 'c3', 'c5']);
  assert.equal(tgt(understood('把第二段删了').ops[0]), 'index:2');
  assert.equal(tgt(understood('最后两段删掉').ops[0]), 'index:4,5');
  assert.equal(tgt(understood('把结尾那段删掉').ops[0]), 'index:5');
});

test('删除类没有目标时不猜（不会删全部）', () => {
  const r = parse('删掉这段', { playhead: null, project: PROJECT });
  assert.equal(r.ops.length, 0);
  assert.ok(r.unknown.length > 0);
});

test('「这段」：没有选中时取播放头所在镜头', () => {
  const r = understood('复制这段');
  assert.deepEqual([r.ops[0].type, tgt(r.ops[0])], ['duplicate', 'index:2']);
  assert.equal(tgt(understood('这段暖一点', { playhead: 13 }).ops[0]), 'index:4');
});

test('移动：移到最前面、移到某段后面/前面、往前移一位、后移两位', () => {
  const front = understood('把第5段移到最前面');
  assert.deepEqual([front.ops[0].toIndex, tgt(front.ops[0])], [1, 'index:5']);
  assert.equal(front.result.tracks.video[0].id, 'c5');
  const after = understood('第1段移到第3段后面');
  assert.deepEqual(after.result.tracks.video.map((c) => c.id), ['c2', 'c3', 'c1', 'c4', 'c5']);
  const before = understood('把第二段移到第四段前面');
  assert.deepEqual(before.result.tracks.video.map((c) => c.id), ['c1', 'c3', 'c2', 'c4', 'c5']);
  assert.equal(understood('往前移一位', { selected: ['c3'] }).ops[0].toIndex, 2);
  assert.equal(understood('后移两位', { selected: ['c1'] }).ops[0].toIndex, 3);
});

test('交换：交换第1段和第2段、第1段和第3段对调', () => {
  const swap = understood('交换第1段和第2段');
  assert.deepEqual(swap.result.tracks.video.map((c) => c.id), ['c2', 'c1', 'c3', 'c4', 'c5']);
  const swap2 = understood('第1段和第3段对调');
  assert.deepEqual(swap2.result.tracks.video.map((c) => c.id), ['c3', 'c2', 'c1', 'c4', 'c5']);
});

test('分割：在这里切开、在第2段第1秒处切开、在5秒处切开、从中间切开第2段', () => {
  const here = understood('在这里切开');
  assert.deepEqual([here.ops[0].type, here.ops[0].at], ['split', 6]);
  assert.equal(here.result.tracks.video.length, 6);
  assert.equal(understood('在第2段第1秒处切开').ops[0].at, 5);
  assert.equal(understood('在5秒处切开').ops[0].at, 5);
  const mid = understood('从中间切开第2段');
  assert.deepEqual([mid.ops[0].at, tgt(mid.ops[0])], [6, 'index:2']);
});

test('锁定 / 解锁；已锁定的镜头不重复锁定', () => {
  const lock = understood('锁定第一段');
  assert.deepEqual([lock.ops[0].type, tgt(lock.ops[0])], ['lock', 'index:1']);
  const lockedProject = lock.result;
  const again = parse('锁定所有镜头', { project: lockedProject });
  assert.deepEqual(again.unknown, []);
  assert.equal(tgt(again.ops[0]), 'index:2,3,4,5');
  assert.equal(applyOps(lockedProject, again.ops, again.ctx).ok, true);
  assert.equal(understood('解锁第1段', { project: lockedProject }).ops[0].type, 'unlock');
});

test('结构操作之后的编号仍指原来的镜头（改用 id）', () => {
  const r = understood('删掉第2段然后把第3段调亮');
  assert.deepEqual(r.ops.map((o) => o.type), ['delete', 'setColor']);
  assert.equal(tgt(r.ops[1]), 'ids:c3');
  const c3 = r.result.tracks.video.find((c) => c.id === 'c3');
  assert.equal(c3.color.exposure, 0.25);
  assert.equal(r.result.tracks.video.find((c) => c.id === 'c4').color.exposure, 0);
});

test('复合长句：第2段推近、加叠化，字幕改成「你好」，然后第4段删掉', () => {
  const r = understood('第2段推近、加个叠化，字幕改成「你好」，然后第4段删掉');
  assert.deepEqual(r.ops.map((o) => o.type), ['setMotion', 'setTransition', 'setCaption', 'delete']);
  assert.deepEqual(r.ops.slice(0, 3).map(tgt), ['index:2', 'index:2', 'index:2']);
  assert.equal(tgt(r.ops[3]), 'index:4');
  assert.equal(r.understood.length, 4);
});

// ---------- 无法理解 ----------

test('编号超出范围：报告而不生成操作', () => {
  const r = parse('第9段调暖');
  assert.equal(r.ops.length, 0);
  assert.match(r.unknown[0], /第9段不存在（当前共 5 镜）/);
});

test('否定句、提问、闲聊、只有目标：进入 unknown', () => {
  for (const text of ['不要调暖', '为什么第二段这么暗', '随便弄弄', '你好']) {
    const r = parse(text);
    assert.equal(r.ops.length, 0, text);
    assert.ok(r.unknown.length > 0, text);
  }
  assert.match(parse('第二段').unknown[0], /只指定了镜头/);
});

test('部分理解：已理解部分给出操作，剩余进入 unknown（调用方不应用）', () => {
  const r = parse('第2段调暖，然后做个炫酷的粒子爆炸');
  assert.equal(r.ops.length, 1);
  assert.ok(r.unknown.length > 0);
});

test('边界输入：空字符串、null、没有项目', () => {
  assert.deepEqual(parseCommand('', {}), { ops: [], understood: [], unknown: [] });
  assert.deepEqual(parseCommand(null), { ops: [], understood: [], unknown: [] });
  assert.deepEqual(parseCommand('   '), { ops: [], understood: [], unknown: [] });
  const noProject = parseCommand('暖一点', {});
  assert.equal(noProject.ops.length, 1);
  assert.equal(noProject.ops[0].target.mode, 'all');
  assert.equal(parseCommand('第二段暖一点', {}).ops[0].target.indices[0], 2);
  assert.ok(parseCommand('最后一段删掉', {}).unknown.length > 0);
});

test('不修改传入的项目', () => {
  const p = fixture();
  const before = JSON.stringify(p);
  parseCommand('删掉第2段然后把第3段调亮，统一色调，卡点', { project: p, selectedClipIds: ['c1'], playhead: 3 });
  assert.equal(JSON.stringify(p), before);
});
