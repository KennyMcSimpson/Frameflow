// 素材来源与许可（契约 C3）：src/engine/license.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  licenseIdFromText, normalizeLicense, describeSource, assetLicense, isReferenceAsset, isAiAsset, isVideoSite, providerLabel,
  assetRestriction, findRestrictedUsage, creditLine, creditsText, licenseBadge, projectUsesAi,
} from '../src/engine/license.js';

test('licenseIdFromText：链接、Openverse 代号、许可文字', () => {
  assert.equal(licenseIdFromText('https://creativecommons.org/licenses/by-sa/4.0/'), 'cc-by-sa');
  assert.equal(licenseIdFromText('https://creativecommons.org/publicdomain/zero/1.0/'), 'cc0');
  assert.equal(licenseIdFromText('https://creativecommons.org/publicdomain/mark/1.0/'), 'pdm');
  assert.equal(licenseIdFromText('by-nc-nd'), 'cc-by-nc-nd');
  assert.equal(licenseIdFromText('CC BY-SA 4.0'), 'cc-by-sa');
  assert.equal(licenseIdFromText('CC-BY-NC-3.0'), 'cc-by-nc');
  assert.equal(licenseIdFromText('Creative Commons Attribution-ShareAlike 3.0'), 'cc-by-sa');
  assert.equal(licenseIdFromText('Attribution-NonCommercial-NoDerivs'), 'cc-by-nc-nd');
  assert.equal(licenseIdFromText('Public domain'), 'pdm');
  assert.equal(licenseIdFromText('CC0'), 'cc0');
  assert.equal(licenseIdFromText('Pexels License'), 'pexels');
  assert.equal(licenseIdFromText('版权归原作者，仅供学习参考'), 'reference');
  assert.equal(licenseIdFromText('GFDL'), 'gfdl');
  assert.equal(licenseIdFromText('随便写的'), '');
  assert.equal(licenseIdFromText(''), '');
});

test('normalizeLicense：对象 / id / 文字；认不出时保留原文', () => {
  const a = normalizeLicense('CC BY-SA 4.0');
  assert.equal(a.id, 'cc-by-sa');
  assert.equal(a.name, 'CC BY-SA 4.0'); // 带版本号的原文更具体，保留
  assert.equal(a.attribution, true);
  assert.equal(a.commercial, true);
  const b = normalizeLicense({ id: 'cc-by-nc', name: 'CC BY-NC 2.0', url: 'https://example.org/l' });
  assert.equal(b.id, 'cc-by-nc');
  assert.equal(b.commercial, false);
  assert.equal(b.name, 'CC BY-NC 2.0');
  assert.equal(b.url, 'https://example.org/l');
  assert.equal(normalizeLicense('pexels').id, 'pexels');
  assert.equal(normalizeLicense({ id: 'by-nd' }).id, 'cc-by-nd');
  assert.equal(normalizeLicense({ name: 'CC0 1.0' }).id, 'cc0');
  const u = normalizeLicense('奇怪的许可');
  assert.equal(u.id, 'unknown');
  assert.equal(u.text, '奇怪的许可');
  assert.equal(u.commercial, null);
  assert.equal(normalizeLicense(null).id, 'unknown');
  assert.equal(normalizeLicense('').id, 'unknown');
});

test('describeSource：旧写法与新写法统一', () => {
  const d = describeSource({ source: { type: 'web', platform: 'youtube', url: 'https://youtu.be/x', author: 'C' } });
  assert.equal(d.kind, 'videosite');
  assert.equal(d.provider, 'youtube');
  assert.equal(d.author, 'C');
  assert.equal(d.pageUrl, 'https://youtu.be/x');
  assert.equal(describeSource({ source: { type: 'web', platform: 'pexels' } }).kind, 'stock');
  assert.equal(describeSource({ source: 'stock', stock: { platform: 'Pexels', author: 'P' } }).provider, 'pexels');
  assert.equal(describeSource({ source: 'stock', stock: { sample: true } }).kind, 'sample');
  assert.equal(describeSource({ source: 'videogen' }).kind, 'ai');
  assert.equal(describeSource({}).kind, 'local');
  assert.equal(describeSource({ source: { kind: 'weird' } }).kind, 'unknown');
  assert.ok(isVideoSite('bilibili') && isVideoSite('YouTube') && !isVideoSite('openverse'));
  assert.equal(providerLabel('archive'), '互联网档案馆');
  assert.equal(providerLabel('bilibili'), '哔哩哔哩');
  assert.equal(providerLabel('somewhere'), 'somewhere');
});

test('assetLicense：兼容新旧写法', () => {
  // v3：source='stock' + stock 详情
  assert.equal(assetLicense({ source: 'stock', stock: { platform: 'pexels', author: 'A' } }).id, 'pexels');
  assert.equal(assetLicense({ source: 'stock', stock: { platform: 'commons', license: 'CC BY-SA 3.0' } }).id, 'cc-by-sa');
  assert.equal(assetLicense({ source: 'stock', stock: { sample: true, platform: 'mixkit' } }).id, 'mixkit');
  // 旧对象写法：type=web 来自 B站 → 仅供学习
  assert.equal(assetLicense({ source: { type: 'web', platform: 'bilibili', license: '版权归原作者，仅供学习参考' } }).id, 'reference');
  // 契约 C3 新写法
  assert.equal(assetLicense({ source: { kind: 'stock', provider: 'openverse' }, license: { id: 'cc-by', name: 'CC BY 4.0' } }).id, 'cc-by');
  assert.equal(assetLicense({ source: { kind: 'videosite', provider: 'youtube' } }).id, 'reference');
  assert.equal(assetLicense({ reference: true }).id, 'reference');
  // AI / 预演 / 本地 / 素材库 / 内置
  assert.equal(assetLicense({ source: 'videogen' }).id, 'ai');
  assert.equal(assetLicense({ kind: 'generated-image' }).id, 'ai');
  assert.equal(assetLicense({ source: 'previz' }).id, 'own');
  assert.equal(assetLicense({ path: 'C:/a.mp4' }).id, 'own');
  assert.equal(assetLicense({ source: { type: 'library', platform: '' } }).id, 'own');
  assert.equal(assetLicense({ source: { kind: 'builtin' } }).id, 'builtin');
  // 写了认不出的许可 → 继续按来源推断；实在不知道就是「来源不明」
  assert.equal(assetLicense({ source: { kind: 'stock', provider: 'pexels' }, license: '奇怪' }).id, 'pexels');
  assert.equal(assetLicense({ source: { kind: 'stock', provider: 'commons', license: '许可不明，请看原页面' } }).id, 'unknown');
  assert.equal(assetLicense(null).id, 'unknown');
});

test('isReferenceAsset / isAiAsset', () => {
  assert.ok(isReferenceAsset({ license: '仅供学习参考' }));
  assert.ok(isReferenceAsset({ source: { kind: 'web', provider: 'bilibili' } }));
  assert.ok(!isReferenceAsset({ source: { kind: 'stock', provider: 'pexels' } }));
  assert.ok(!isReferenceAsset(null));
  assert.ok(isAiAsset({ ai: { provider: 'kling' } }));
  assert.ok(isAiAsset({ source: { kind: 'ai', provider: 'jimeng' } }));
  assert.ok(!isAiAsset({ source: 'previz' }));
});

test('assetRestriction：仅供学习 / 禁止商用为 block，非商用时降级', () => {
  const ref = { source: { kind: 'videosite', provider: 'bilibili' } };
  assert.equal(assetRestriction(ref).level, 'block');
  assert.equal(assetRestriction(ref, { commercial: false }).level, 'warn');
  const nc = { license: 'CC BY-NC 4.0' };
  assert.equal(assetRestriction(nc).level, 'block');
  assert.equal(assetRestriction(nc, { commercial: false }), null);
  const ncnd = { license: { id: 'cc-by-nc-nd' } };
  assert.equal(assetRestriction(ncnd).level, 'block');
  assert.match(assetRestriction(ncnd).reason, /禁止商用.*不允许改编/);
  assert.equal(assetRestriction({ license: 'CC BY-ND 4.0' }).level, 'warn');
  assert.equal(assetRestriction({ path: 'C:/mine.mp4' }), null);
  assert.equal(assetRestriction({ source: { kind: 'stock', provider: 'pexels' } }), null);
});

test('findRestrictedUsage：只看用到的素材，block 排在前面', () => {
  const project = {
    assets: {
      ref: { id: 'ref', name: 'B站片段', source: { kind: 'videosite', provider: 'bilibili' } },
      nc: { id: 'nc', name: '非商用', source: { kind: 'stock', provider: 'commons' }, license: 'CC BY-NC 4.0' },
      nd: { id: 'nd', name: '禁止演绎', license: { id: 'cc-by-nd' } },
      unk: { id: 'unk', name: '不明', source: { kind: 'web', provider: 'example' } },
      ok: { id: 'ok', name: '自己拍的', path: 'C:/a.mp4' },
      unused: { id: 'unused', name: '没用到', reference: true },
    },
    tracks: { video: [{ assetId: 'unk' }, { assetId: 'nd' }, { assetId: 'ok' }, { assetId: 'nc' }], audio: [{ assetId: 'ref' }] },
    overlays: [],
  };
  const list = findRestrictedUsage(project);
  assert.deepEqual(list.slice(0, 2).map((x) => x.level), ['block', 'block']);
  assert.deepEqual(list.filter((x) => x.level === 'block').map((x) => x.assetId).sort(), ['nc', 'ref']);
  assert.deepEqual(list.filter((x) => x.level === 'warn').map((x) => x.assetId).sort(), ['nd', 'unk']);
  assert.ok(!list.some((x) => x.assetId === 'ok' || x.assetId === 'unused'));
  assert.equal(list.find((x) => x.assetId === 'ref').title, 'B站片段');
  // 非商用用途：仅供学习降为 warn，CC BY-NC 不再拦
  const personal = findRestrictedUsage(project, { commercial: false });
  assert.equal(personal.find((x) => x.assetId === 'ref').level, 'warn');
  assert.ok(!personal.some((x) => x.assetId === 'nc'));
  assert.deepEqual(findRestrictedUsage(null), []);
});

test('creditsText：只列需要署名的素材，去重，固定标题行', () => {
  const project = {
    assets: {
      a: { id: 'a', name: 'Sunset', source: { kind: 'stock', provider: 'openverse', author: 'Ann', pageUrl: 'https://example.org/sunset' }, license: { id: 'cc-by', name: 'CC BY 4.0' } },
      b: { id: 'b', name: 'Pexels clip', source: { kind: 'stock', provider: 'pexels', author: 'Bob' } },
      c: { id: 'c', name: '自己拍', path: 'C:/c.mp4' },
    },
    tracks: { video: [{ assetId: 'a' }, { assetId: 'a' }, { assetId: 'b' }, { assetId: 'c' }], audio: [] },
  };
  const lines = creditsText(project).split('\n');
  assert.equal(lines[0], '素材来源与署名');
  assert.equal(lines.length, 2);
  assert.equal(lines[1], '· 「Sunset」，作者：Ann，许可：CC BY 4.0，来源：Openverse，https://example.org/sunset');
  assert.equal(creditLine(project.assets.b), ''); // Pexels 不要求署名
  assert.equal(creditsText({ assets: { c: project.assets.c }, tracks: { video: [{ assetId: 'c' }], audio: [] } }), '');
  assert.equal(creditsText(null), '');
});

test('licenseBadge：搜索结果卡片上的标签', () => {
  const ref = licenseBadge('reference');
  assert.equal(ref.text, '仅供学习');
  assert.equal(ref.tone, 'danger');
  assert.equal(ref.title, '版权归原作者。未经授权，不得用于公开发布或商用。');
  assert.equal(licenseBadge('CC BY-NC 4.0').text, '禁止商用');
  assert.equal(licenseBadge('CC BY-ND 4.0').text, '不可改编');
  assert.equal(licenseBadge('CC BY-SA 4.0').text, '需署名');
  assert.equal(licenseBadge('CC BY-SA 4.0').tone, 'info');
  assert.equal(licenseBadge('cc0').text, '可商用');
  assert.equal(licenseBadge({ id: 'pexels' }).tone, 'ok');
  assert.equal(licenseBadge(normalizeLicense('pdm')).text, '可商用');
  assert.equal(licenseBadge('谁知道').text, '来源不明');
});

test('projectUsesAi：只看用到的素材', () => {
  const p = { assets: { x: { source: 'videogen' }, y: { path: 'C:/y.mp4' } }, tracks: { video: [{ assetId: 'y' }], audio: [] } };
  assert.equal(projectUsesAi(p), false);
  p.tracks.video.push({ assetId: 'x' });
  assert.equal(projectUsesAi(p), true);
});
