// ai-core：本地导演（没连 AI 时新用户的第一印象）——需求抽取、就绪判断、事实边界、分镜文案。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDirectorReply, localStoryboard, extractBriefPatch, LOCAL_TOPICS } from '../src/ai/localDirector.js';
import { createBrief } from '../src/engine/model.js';

const ask = (userText, brief = null, messages = []) => localDirectorReply({ brief, messages, userText });

test('一句话说全需求：标题不带「秒的」，节奏轻快算快节奏，信息够了不再追问', () => {
  const r = ask('帮我做一个 30 秒的咖啡店探店竖屏短视频，节奏轻快，适合发抖音');
  assert.equal(r.briefPatch.title, '咖啡店探店短片');
  assert.equal(r.briefPatch.platform, '抖音');
  assert.equal(r.briefPatch.aspect, '9:16');
  assert.equal(r.briefPatch.duration, 30);
  assert.equal(r.briefPatch.pacing, 'fast');
  assert.equal(r.briefPatch.style, '轻快明亮');
  assert.equal(r.briefPatch.look, 'film-warm', '「轻快」只定情绪，色调仍按主题默认');
  assert.equal(r.readyForStoryboard, true);
  assert.deepEqual(r.questions, []);
  assert.doesNotMatch(r.reply, /秒的|未连接|没有连接/);
  assert.match(r.reply, /咖啡店探店/);
  assert.match(r.reply, /生成分镜/);
  // 通称不是店名：必拍清单不写「咖啡店的名字」
  assert.deepEqual(r.briefPatch.mustHave, ['门头招牌与店名']);
});

test('主题 + 平台/画幅 + 时长就算就绪；没说的风格按主题默认并在回复里交代', () => {
  const r = ask('我们楼下新开的咖啡店想拍个宣传片，竖屏，20 秒');
  assert.equal(r.briefPatch.title, '咖啡店宣传片');
  assert.equal(r.readyForStoryboard, true);
  assert.ok(r.briefPatch.style, '风格应补上默认值');
  assert.ok(r.briefPatch.audience, '受众应补上默认值');
  assert.match(r.reply, /没说到的我先按常见做法定了/);
  assert.match(r.reply, new RegExp(r.briefPatch.style));
});

test('用户给了真名才写进必拍和字幕；只有通称时字幕用占位', () => {
  const named = ask('给「晨光咖啡」拍一个 15 秒抖音，直接生成分镜');
  assert.equal(named.briefPatch.title, '晨光咖啡短片');
  assert.ok(named.briefPatch.mustHave.includes('晨光咖啡的名字与门面/产品'));
  assert.ok(named.storyboard.some((s) => s.caption.includes('晨光咖啡')));
  assert.ok(!named.storyboard.some((s) => s.caption.includes('店名待填')));

  const generic = ask('帮我做一个 30 秒的咖啡店探店竖屏短视频，抖音，直接生成分镜');
  assert.ok(generic.storyboard.some((s) => s.caption.includes('（店名待填）')));
  assert.match(generic.reply, /（店名待填）.*换成真实信息/);
});

test('信息不够时最多问 3 个，必需的先问', () => {
  const r = ask('我想给我的奶茶店拍一个抖音视频');
  assert.equal(r.readyForStoryboard, false);
  assert.ok(r.questions.length >= 1 && r.questions.length <= 3);
  assert.match(r.questions[0], /多长/);
  assert.match(r.reply, /奶茶店/);
  const e = localDirectorReply();
  assert.ok(e.questions.length >= 1 && e.questions.length <= 3);
  assert.match(e.questions[0], /想拍什么/);
});

test('「探店」不会被当成店名；「X 秒的」前缀会被去掉', () => {
  const r = ask('帮我拍个探店视频，30秒，发小红书');
  assert.equal(r.briefPatch.title, '美食探店短片');
  assert.equal(r.briefPatch.mustHave, undefined);
  const r2 = ask('拍一个十五秒的奶茶店视频');
  assert.equal(r2.briefPatch.title, '奶茶店短片');
});

test('轻快类词：只补情绪不覆盖之前说过的色调', () => {
  const p = extractBriefPatch('轻快一点');
  assert.equal(p.style, '轻快明亮');
  assert.equal(p.pacing, 'fast');
  assert.equal('look' in p, false, '不应写入 look: undefined');
  const r = localDirectorReply({ messages: [{ role: 'user', text: '咖啡店，赛博霓虹风' }], userText: '再轻快一点' });
  assert.equal(r.briefPatch.look, 'cyberpunk');
});

test('模板分镜不编造优惠、尺寸、使用时长这类事实', () => {
  for (const topic of LOCAL_TOPICS) {
    const titles = { drink: '奶茶店', food: '美食探店', product: '产品广告', unboxing: '开箱' };
    const r = localStoryboard({ title: titles[topic] || topic, duration: 60, pacing: 'slow', aspect: '9:16' });
    for (const s of r.shots) {
      assert.doesNotMatch(`${s.caption} ${s.action}`, /到店有礼|立减|比想象的小|用了三天|到店福利/, `${topic} 第 ${s.index} 镜：${s.caption}`);
    }
  }
});

test('握持提示只写在第 1 镜和风格指南里；回复不说「未连接 AI」（手动选本地模板时也成立）', () => {
  const r = localStoryboard({ title: '咖啡店探店短片', duration: 30, pacing: 'fast', aspect: '9:16', platform: '抖音' });
  assert.match(r.shots[0].shootingTips[0], /竖/);
  for (const s of r.shots.slice(1)) {
    assert.ok(!s.shootingTips.some((t) => t.startsWith('手机竖着拿')), `第 ${s.index} 镜重复了握持提示`);
    assert.ok(s.shootingTips.length >= 3);
  }
  assert.match(r.styleGuide, /画幅：手机竖着拿/);
  assert.doesNotMatch(r.reply, /未连接|没有连接/);
  // 平均镜长按实际算，不再固定写「2–3 秒」
  const avg = Math.round((30 / r.shots.length) * 10) / 10;
  assert.match(r.styleGuide, new RegExp(`平均每镜约 ${avg} 秒`));
});

test('已填好的简报（示例项目）里的真名照常用作字幕', () => {
  const r = localStoryboard(createBrief({ title: '晨光咖啡｜清晨', platform: 'B站', duration: 30, aspect: '16:9', style: '温暖治愈' }));
  assert.ok(r.shots.some((s) => s.caption.includes('晨光咖啡｜清晨')));
  assert.ok(!r.shots.some((s) => s.caption.includes('待填）') && !s.caption.includes('地址待填')));
});
