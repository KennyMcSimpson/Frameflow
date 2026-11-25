// i18n：双语词典键完全对等、非空校验、{{var}} 插值、语言切换订阅与 normalizeLocale。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUPPORTED_LOCALES,
  DICTS,
  normalizeLocale,
  getLocale,
  setLocale,
  subscribeLocale,
  t,
} from '../src/ui/i18n.js';

after(() => {
  setLocale('zh-CN');
});

test('i18n：SUPPORTED_LOCALES 包含 zh-CN 与 en-US，两套词典 100% 键对等且所有值为非空字符串', () => {
  assert.ok(Array.isArray(SUPPORTED_LOCALES));
  assert.ok(SUPPORTED_LOCALES.includes('zh-CN'));
  assert.ok(SUPPORTED_LOCALES.includes('en-US'));
  assert.ok(DICTS && DICTS['zh-CN'] && DICTS['en-US']);

  const zhKeys = Object.keys(DICTS['zh-CN']).sort();
  const enKeys = Object.keys(DICTS['en-US']).sort();
  assert.ok(zhKeys.length > 0, '词典不应为空');
  assert.deepEqual(zhKeys, enKeys, 'zh-CN 与 en-US 的词条键必须 100% 完全一致');

  for (const locale of ['zh-CN', 'en-US']) {
    for (const key of Object.keys(DICTS[locale])) {
      const val = DICTS[locale][key];
      assert.equal(typeof val, 'string', `${locale}.${key} 必须是字符串`);
      assert.ok(val.trim().length > 0, `${locale}.${key} 不应为空白字符串`);
    }
  }
});

test('i18n：normalizeLocale 规范化常见语言码并默认回落 zh-CN', () => {
  assert.equal(normalizeLocale('en'), 'en-US');
  assert.equal(normalizeLocale('EN'), 'en-US');
  assert.equal(normalizeLocale('en-US'), 'en-US');
  assert.equal(normalizeLocale('en_GB'), 'en-US');
  assert.equal(normalizeLocale('en-au'), 'en-US');
  assert.equal(normalizeLocale('zh'), 'zh-CN');
  assert.equal(normalizeLocale('zh-CN'), 'zh-CN');
  assert.equal(normalizeLocale('zh_Hans'), 'zh-CN');
  assert.equal(normalizeLocale('fr-FR'), 'zh-CN');
  assert.equal(normalizeLocale(''), 'zh-CN');
  assert.equal(normalizeLocale(null), 'zh-CN');
  assert.equal(normalizeLocale(undefined), 'zh-CN');
});

test('i18n：t() 插值（含 {{name}}）、localeOverride 覆盖与未知键回退', () => {
  setLocale('zh-CN');
  try {
    // 确认 history.namedThen 含有 {{name}} 占位符并在双语下均正确插值
    assert.ok(DICTS['en-US']['history.namedThen'].includes('{{name}}'));
    assert.ok(DICTS['zh-CN']['history.namedThen'].includes('{{name}}'));

    const zhNamed = t('history.namedThen', { name: 'Coffee Cut' });
    assert.ok(zhNamed.includes('Coffee Cut'));
    assert.ok(!zhNamed.includes('{{name}}'));

    const enNamed = t('history.namedThen', { name: 'Coffee Cut' }, 'en-US');
    assert.equal(enNamed, 'Named "Coffee Cut"');

    // 多个变量或数字变量插值
    assert.equal(t('status.clipCount', { count: 7 }, 'en-US'), '7 clips');
    assert.equal(t('status.clipCount', { count: 0 }, 'en-US'), '0 clips');

    // 缺失变量时保留原占位符；未知键回退为键名本身
    assert.equal(t('history.namedThen', {}, 'en-US'), 'Named "{{name}}"');
    assert.equal(t('nonexistent.i18n.key', { name: 'x' }), 'nonexistent.i18n.key');
  } finally {
    setLocale('zh-CN');
  }
});

test('i18n：setLocale 切换语言、通知订阅者、重复设置不误触发且退订生效', () => {
  setLocale('zh-CN');
  assert.equal(getLocale(), 'zh-CN');

  const received = [];
  const unsub1 = subscribeLocale((loc) => received.push(`a:${loc}`));
  // 抛错的订阅者不应影响后续订阅者
  const unsubBad = subscribeLocale(() => { throw new Error('subscriber boom'); });
  const unsub2 = subscribeLocale((loc) => received.push(`b:${loc}`));

  try {
    // 切换到 en-US
    assert.equal(setLocale('en-US'), 'en-US');
    assert.equal(getLocale(), 'en-US');
    assert.deepEqual(received, ['a:en-US', 'b:en-US']);
    assert.equal(t('app.save'), DICTS['en-US']['app.save']);

    // 重复设置同一语言不重复触发通知
    setLocale('en');
    assert.deepEqual(received, ['a:en-US', 'b:en-US']);

    // 退订第一个后再切回 zh-CN
    unsub1();
    assert.equal(setLocale('zh-CN'), 'zh-CN');
    assert.equal(getLocale(), 'zh-CN');
    assert.deepEqual(received, ['a:en-US', 'b:en-US', 'b:zh-CN']);
    assert.equal(t('app.save'), DICTS['zh-CN']['app.save']);
  } finally {
    unsub1();
    unsubBad();
    unsub2();
    setLocale('zh-CN');
  }
});
