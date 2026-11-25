// 视频站使用须知的同意（契约 C4）：electron/lib/consent.cjs + web.cjs 里的门禁
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const consent = require('../electron/lib/consent.cjs');
const web = require('../electron/ipc/web.cjs')._internals;

function merge(a, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b;
  const out = { ...(a && typeof a === 'object' ? a : {}) };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(out[k], v) : v;
  return out;
}

/** 内存里的设置仓库（不碰真实用户数据） */
function fakeSettings(initial = {}) {
  let data = merge({}, initial);
  return { get: () => data, set(patch) { data = merge(data, patch); return data; }, getSecret: () => '' };
}

test('requireConsent：没同意时抛 NEED_CONSENT，同意后放行，可撤回', () => {
  const store = fakeSettings({ web: {} });
  assert.equal(consent.hasConsent(store.get()), false);
  assert.throws(() => consent.requireConsent(store.get(), 'videoSites'), (e) => e.code === 'NEED_CONSENT' && e.consentKey === 'videoSites' && /同意/.test(e.message));
  const rec = consent.grantConsent(store, 'videoSites');
  assert.equal(rec.key, 'videoSites');
  assert.equal(rec.version, consent.CONSENT_VERSION);
  assert.ok(!Number.isNaN(Date.parse(rec.at)));
  assert.equal(store.get().consent.videoSites.version, consent.CONSENT_VERSION);
  assert.equal(store.get().web && typeof store.get().web, 'object'); // 其它设置不受影响
  assert.equal(consent.requireConsent(store.get()), true);
  assert.deepEqual(consent.consentStatus(store.get()), { videoSites: true });
  assert.equal(consent.revokeConsent(store, 'videoSites'), true);
  assert.equal(consent.hasConsent(store.get()), false);
  assert.throws(() => consent.grantConsent(store, 'whatever'), (e) => e.code === 'BAD_CONSENT_KEY');
});

test('旧版本的同意记录需要重新同意', () => {
  assert.equal(consent.hasConsent({ consent: { videoSites: { version: 0 } } }), false);
  assert.equal(consent.hasConsent({ consent: { videoSites: { version: consent.CONSENT_VERSION } } }), true);
  assert.equal(consent.hasConsent(null), false);
});

test('web:search：搜视频站前检查同意；自动配素材时去掉视频站，不需要同意', async () => {
  const settings = fakeSettings({ web: {} });
  const ctx = { settings, paths: {} }; // paths 里没有 yt-dlp：不会真的联网
  await assert.rejects(web.search(ctx, { query: '咖啡', sources: ['youtube'], kind: 'video' }), (e) => e.code === 'NEED_CONSENT');
  // 自动配素材：视频站被过滤，只剩没填 Key 的 Pixabay（直接报错，不联网）
  const auto = await web.search(ctx, { query: '咖啡', sources: ['bilibili', 'pixabay'], kind: 'video', auto: true });
  assert.deepEqual(auto.errors.map((e) => e.source), ['pixabay']);
  // 同意之后放行：YouTube 因为没装 yt-dlp 返回带 code 的错误
  consent.grantConsent(settings, 'videoSites');
  const out = await web.search(ctx, { query: '咖啡', sources: ['youtube'], kind: 'video' });
  assert.deepEqual(out.results, []);
  assert.equal(out.errors[0].source, 'youtube');
  assert.equal(out.errors[0].code, 'NO_YTDLP');
});

test('needsVideoSiteConsent：没有直链的下载（视频站 / 粘贴的链接）需要同意', () => {
  assert.equal(web.needsVideoSiteConsent({ result: { source: 'pexels', downloadUrl: 'https://cdn.example/v.mp4' } }), false);
  assert.equal(web.needsVideoSiteConsent({ result: { source: 'bilibili', url: 'https://www.bilibili.com/video/BV1xx411c7mD' } }), true);
  assert.equal(web.needsVideoSiteConsent({ url: 'https://www.youtube.com/watch?v=abc' }), true);
  assert.equal(web.needsVideoSiteConsent({}), true);
});

test('assetProvenance：下载的素材带上统一来源和许可', () => {
  const bili = web.assetProvenance({
    target: 'project', srcName: 'bilibili', result: { id: 'bilibili_BV1xx411c7mD', source: 'bilibili' },
    pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD', direct: null, author: 'UP主', title: '拉花教程',
  });
  assert.equal(bili.source.kind, 'videosite');
  assert.equal(bili.source.provider, 'bilibili');
  assert.equal(bili.source.id, 'BV1xx411c7mD');
  assert.equal(bili.source.author, 'UP主');
  assert.equal(bili.license.id, 'reference');
  assert.equal(bili.reference, true);
  assert.match(bili.source.license, /仅供学习/); // 旧字段保留，旧界面也能显示

  const ov = web.assetProvenance({
    target: 'project', srcName: 'openverse',
    result: { id: 'openverse_img_abc', license: 'CC BY 4.0', licenseId: 'cc-by', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', authorUrl: 'https://example.org/ann' },
    pageUrl: 'https://example.org/photo', direct: 'https://cdn.example/abc.jpg', author: 'Ann', title: 'Sunset',
  });
  assert.equal(ov.source.kind, 'stock');
  assert.equal(ov.source.id, 'abc');
  assert.equal(ov.source.platform, 'openverse');
  assert.equal(ov.source.downloadUrl, 'https://cdn.example/abc.jpg');
  assert.deepEqual(ov.license, { id: 'cc-by', name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' });
  assert.equal(ov.reference, false);
});

test('licenseIdOf / isRestrictedLicenseId：主进程里的许可识别与自动配素材过滤', () => {
  assert.equal(web.licenseIdOf('CC BY-NC-SA 4.0'), 'cc-by-nc-sa');
  assert.equal(web.licenseIdOf('', 'https://creativecommons.org/licenses/by-nd/2.0/'), 'cc-by-nd');
  assert.equal(web.licenseIdOf('Public domain'), 'pdm');
  assert.equal(web.licenseIdOf('Pexels License'), 'pexels');
  assert.equal(web.licenseIdOf('版权归原作者，仅供学习参考'), 'reference');
  assert.equal(web.licenseIdOf('???'), 'unknown');
  assert.ok(web.isRestrictedLicenseId('cc-by-nc'));
  assert.ok(web.isRestrictedLicenseId('cc-by-nc-sa'));
  assert.ok(web.isRestrictedLicenseId('cc-by-nd'));
  assert.ok(web.isRestrictedLicenseId('reference'));
  assert.ok(!web.isRestrictedLicenseId('cc-by-sa'));
  assert.ok(!web.isRestrictedLicenseId('cc0'));
  assert.deepEqual(web.SOURCE_KINDS.openverse, ['image', 'audio']);
  assert.deepEqual(web.SOURCE_KINDS.archive, ['video']);
});
