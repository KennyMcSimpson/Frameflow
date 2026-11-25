// 实拍参考素材：搜索词生成、素材挑选、清晰度挑选，以及一键初剪优先使用实拍素材。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  zhToEnTerms, topicTerm, cleanEnQuery, buildFootageQueries, orientationOf, scoreFootage, pickFootage, pickVariant, footageCredit,
} from '../src/engine/stockFootage.js';
import { buildFirstCut } from '../src/engine/firstcut.js';
import { createProject, createAsset, createShot } from '../src/engine/model.js';

test('zhToEnTerms：最长匹配、保持顺序、去重', () => {
  assert.deepEqual(zhToEnTerms('咖啡店里咖啡师在做拉花'), ['coffee shop', 'barista', 'latte art']);
  assert.deepEqual(zhToEnTerms('咖啡 咖啡'), ['coffee']);
  assert.deepEqual(zhToEnTerms(''), []);
});

test('topicTerm：取反复出现的主题词', () => {
  assert.equal(topicTerm('咖啡师做拉花 咖啡店'), 'coffee');
  assert.equal(topicTerm(''), '');
  const qs = buildFootageQueries(createShot({ title: '拉花', subject: '咖啡师做拉花', location: '咖啡店' }));
  assert.equal(qs[qs.length - 1], 'coffee');
});

test('cleanEnQuery：去停用词并限制词数', () => {
  assert.equal(cleanEnQuery('Cinematic close-up shot of the Latte Art, 4K!'), 'close-up latte art');
  assert.equal(cleanEnQuery('a b c d e f g h', 3), 'b c d');
});

test('buildFootageQueries：优先 AI 英文参考词，再用词典翻译主体/场景', () => {
  const shot = createShot({ title: '拉花特写', subject: '咖啡师手冲拉花', location: '咖啡店吧台', shotSize: 'close', referenceQueries: ['咖啡拉花 特写', 'barista latte art close up'] });
  const qs = buildFootageQueries(shot);
  assert.equal(qs[0], 'barista latte art close up');
  assert.ok(qs.length >= 2 && qs.length <= 3);
  assert.ok(qs.some((q) => q.includes('latte art')));
  assert.equal(new Set(qs).size, qs.length);
  for (const q of qs) assert.ok(!/[一-鿿]/.test(q));
});

test('buildFootageQueries：没有参考词也能生成；完全无描述时返回空', () => {
  const qs = buildFootageQueries(createShot({ title: '清晨的街道', subject: '', location: '城市' }));
  assert.ok(qs.length >= 1);
  assert.ok(qs.some((q) => q.includes('street')));
  assert.deepEqual(buildFootageQueries(createShot({ title: '镜头', subject: '' })), []);
  assert.deepEqual(buildFootageQueries(createShot({ title: 'Ocean waves' })), ['ocean waves']);
});

test('orientationOf', () => {
  assert.equal(orientationOf(1920, 1080), 'landscape');
  assert.equal(orientationOf(1080, 1920), 'portrait');
  assert.equal(orientationOf(1000, 1000), 'square');
  assert.equal(orientationOf(0, 0), null);
});

const R = (o) => ({ kind: 'video', downloadUrl: 'https://x/v.mp4', width: 1280, height: 720, duration: 10, source: 'commons', ...o });

test('scoreFootage：横竖屏、时长、分辨率、大小', () => {
  assert.ok(scoreFootage(R(), { aspect: '16:9', duration: 4 }) > scoreFootage(R({ width: 720, height: 1280 }), { aspect: '16:9', duration: 4 }));
  assert.ok(scoreFootage(R({ width: 720, height: 1280 }), { aspect: '9:16' }) > scoreFootage(R(), { aspect: '9:16' }));
  assert.ok(scoreFootage(R({ duration: 10 }), { duration: 6 }) > scoreFootage(R({ duration: 2 }), { duration: 6 }));
  assert.ok(scoreFootage(R({ width: 1280, height: 720 }), {}) > scoreFootage(R({ width: 320, height: 180 }), {}));
  assert.equal(scoreFootage(R({ size: 500 * 1048576 }), {}), -Infinity);
  assert.equal(scoreFootage(R({ downloadUrl: '' }), {}), -Infinity);
  assert.equal(scoreFootage(R({ kind: 'image' }), {}), -Infinity);
});

test('pickFootage：选最合适的、跳过排除项、无可用返回 null', () => {
  const list = [
    R({ id: 'a', width: 720, height: 1280 }),
    R({ id: 'b', source: 'pexels' }),
    R({ id: 'c', duration: 1 }),
  ];
  assert.equal(pickFootage(list, { aspect: '16:9', duration: 4 }).id, 'b');
  assert.equal(pickFootage(list, { aspect: '16:9', duration: 4, excludeIds: ['b'] }).id, 'c');
  assert.equal(pickFootage(list, { aspect: '9:16', duration: 4 }).id, 'a');
  assert.equal(pickFootage([R({ id: 'x', kind: 'image' })], {}), null);
  assert.equal(pickFootage(null, {}), null);
});

test('pickVariant：挑接近 1280 的低清版本，不低于 640', () => {
  const v = [{ url: '4k', width: 3840, height: 2160 }, { url: 'hd', width: 1920, height: 1080 }, { url: 'sd', width: 960, height: 540 }, { url: 'tiny', width: 426, height: 240 }];
  assert.equal(pickVariant(v).url, 'sd');
  assert.equal(pickVariant(v, 1920).url, 'hd');
  assert.equal(pickVariant([{ url: 'tiny', width: 426, height: 240 }]).url, 'tiny');
  assert.equal(pickVariant([]), null);
});

test('footageCredit', () => {
  assert.equal(footageCredit({ source: { platform: 'pexels', author: 'Jane Doe' } }), 'Pexels / Jane Doe');
  assert.equal(footageCredit({ source: { platform: 'commons' } }), 'Wikimedia Commons');
  // 契约 C3 的新写法：source.provider
  assert.equal(footageCredit({ source: { kind: 'stock', provider: 'archive', author: 'Prelinger' } }), '互联网档案馆 / Prelinger');
  assert.equal(footageCredit({ source: { kind: 'stock', provider: 'openverse' } }), 'Openverse');
});

test('scoreFootage：同等条件下互联网档案馆的老影像排在 Pexels 后面', () => {
  assert.ok(scoreFootage(R({ source: 'pexels' })) > scoreFootage(R({ source: 'archive' })));
});

test('buildFirstCut：优先使用分镜的实拍参考素材，且不给其他分镜抢用', () => {
  const p = createProject({ name: 't', aspect: '16:9' });
  p.storyboard = [
    createShot({ id: 's1', index: 1, title: '拉花', subject: '拉花', duration: 4, footageAssetId: 'stock1' }),
    createShot({ id: 's2', index: 2, title: '拉花特写', subject: '拉花', duration: 4 }),
  ];
  p.assets = {
    stock1: { ...createAsset({ id: 'stock1', kind: 'video', name: '参考素材 · 拉花', duration: 12, tags: ['参考素材', '拉花'] }), stockForShot: 's1' },
    old: { ...createAsset({ id: 'old', kind: 'video', name: '参考素材 · 拉花 旧', duration: 12, tags: ['拉花'] }), stockForShot: 's2' },
  };
  const { project, report } = buildFirstCut(p);
  const [c1, c2] = project.tracks.video;
  assert.equal(c1.assetId, 'stock1');
  assert.notEqual(c2.assetId, 'stock1');
  assert.notEqual(c2.assetId, 'old'); // 已换掉/恢复预演的实拍素材不参与自动匹配
  assert.equal(project.assets[c2.assetId].kind, 'previz');
  assert.ok(report.some((l) => l.includes('实拍参考素材')));
  assert.equal(project.storyboard[0].assetId, null); // 不把参考素材写成用户指定素材
  assert.equal(project.storyboard[0].footageAssetId, 'stock1');
  assert.ok(c1.in > 0); // 从素材中段截取
});

test('buildFirstCut：用户指定素材优先于实拍参考素材', () => {
  const p = createProject({ name: 't', aspect: '16:9' });
  p.storyboard = [createShot({ id: 's1', index: 1, title: 'x', duration: 4, assetId: 'mine', footageAssetId: 'stock1' })];
  p.assets = {
    mine: createAsset({ id: 'mine', kind: 'video', name: 'mine', duration: 8 }),
    stock1: { ...createAsset({ id: 'stock1', kind: 'video', name: 'stock', duration: 8 }), stockForShot: 's1' },
  };
  const { project } = buildFirstCut(p);
  assert.equal(project.tracks.video[0].assetId, 'mine');
});

// ---------- v3：默认源顺序、同摄影师优先、AI 关键词、示例实拍素材 ----------
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  DEFAULT_STOCK_SOURCES, autoFootageSources, buildFootageQueriesLLM, parseFootageQueries, buildFootageQueryRequest,
  footageAuthors, usedFootageIds, shotMediaPick,
} from '../src/engine/stockFootage.js';
import { createSampleProject, SAMPLE_MEDIA, sampleMediaDir } from '../src/engine/sample.js';

const requireCjs = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = path.join(ROOT, 'build');
const SAMPLE_MEDIA_DIR = path.join(BUILD_DIR, 'sample-media');

test('默认源顺序：自动配素材时有 Key 的图库在前、免 Key 来源兜底；B站/YouTube 不进自动配素材', () => {
  assert.deepEqual([...DEFAULT_STOCK_SOURCES], ['pexels', 'pixabay', 'commons', 'nasa', 'archive']);
  const web = requireCjs('../electron/ipc/web.cjs')._internals;
  // 联网搜索默认把免 Key 的来源放前面（Pexels 已停发新 Key）；Openverse 只有图片/音乐，自动配实拍视频不用它
  assert.deepEqual(web.DEFAULT_SOURCES, ['commons', 'openverse', 'archive', 'nasa', 'pexels', 'pixabay']);
  assert.ok(!web.DEFAULT_SOURCES.includes('bilibili') && !web.DEFAULT_SOURCES.includes('youtube'));
  assert.deepEqual(autoFootageSources({ hasPexelsKey: true, hasPixabayKey: true }), ['pexels', 'pixabay', 'commons', 'nasa', 'archive']);
  assert.deepEqual(autoFootageSources({ hasPixabayKey: true }), ['pixabay', 'commons', 'nasa', 'archive']);
  assert.deepEqual(autoFootageSources({}), ['commons', 'nasa', 'archive']);
});

test('web:search auto=true 时过滤 B站/YouTube', async () => {
  const web = requireCjs('../electron/ipc/web.cjs')._internals;
  const ctx = { settings: { get: () => ({ web: {} }), getSecret: () => '' }, paths: {} };
  const out = await web.search(ctx, { query: 'x', sources: ['bilibili', 'youtube', 'pixabay'], auto: true, kind: 'video' });
  assert.deepEqual(out.errors.map((e) => e.source), ['pixabay']); // 只剩 pixabay（无 key 报错），没有去搜 B站/YouTube
});

test('pickFootage：同摄影师优先、excludeIds 去重（含数字 id）', () => {
  const v = (id, author) => ({ id, author, kind: 'video', source: 'pexels', downloadUrl: `https://x/${id}.mp4`, width: 1280, height: 720, duration: 8 });
  const list = [v('a', 'Alice'), v('b', 'Bob')];
  assert.equal(pickFootage(list, { aspect: '16:9', duration: 4 }).id, 'a');
  assert.equal(pickFootage(list, { aspect: '16:9', duration: 4, preferAuthors: ['bob'] }).id, 'b');
  assert.equal(pickFootage([v(7, 'A'), v(8, 'B')], { excludeIds: ['7'] }).id, 8);
});

test('footageAuthors / usedFootageIds / shotMediaPick 优先级', () => {
  const p = createProject({ name: 't' });
  p.assets = {
    s1: createAsset({ id: 's1', source: 'stock', stock: { author: 'Ann', resultId: 'pexels_1' } }),
    s2: createAsset({ id: 's2', source: 'stock', stock: { author: 'Ann', resultId: 'pexels_2' } }),
    ai: createAsset({ id: 'ai', source: 'videogen' }),
    mine: createAsset({ id: 'mine' }),
    pv: createAsset({ id: 'pv', kind: 'previz', source: 'previz' }),
  };
  p.storyboard = [
    createShot({ id: 'x', index: 1, footageAssetId: 's1' }),
    createShot({ id: 'y', index: 2, footageAssetId: 's2' }),
  ];
  assert.deepEqual(footageAuthors(p), ['Ann']);
  assert.deepEqual(usedFootageIds(p, { exceptShotId: 'y' }), ['pexels_1']);
  assert.equal(shotMediaPick({ assetId: 'mine', aiVideoAssetId: 'ai', footageAssetId: 's1' }, p.assets).kind, 'local');
  assert.equal(shotMediaPick({ aiVideoAssetId: 'ai', footageAssetId: 's1', previzAssetId: 'pv' }, p.assets).kind, 'ai');
  assert.equal(shotMediaPick({ aiVideoAssetId: 'gone', footageAssetId: 's1' }, p.assets).kind, 'stock');
  assert.equal(shotMediaPick({ previzAssetId: 'pv' }, p.assets).kind, 'previz');
});

test('buildFootageQueriesLLM：AI 词在前，失败/无 AI 回退本地词表', async () => {
  const shot = { title: '拉花', subject: '咖啡师的手与拿铁', shotSize: 'close' };
  const local = await buildFootageQueriesLLM(shot, {});
  assert.equal(local.via, 'local');
  assert.ok(local.queries.length > 0);
  const ai = await buildFootageQueriesLLM(shot, { run: async () => ({ queries: ['barista latte art pour', '中文不要'] }) });
  assert.equal(ai.via, 'ai');
  assert.equal(ai.queries[0], 'barista latte art pour');
  const bad = await buildFootageQueriesLLM(shot, { run: async () => { throw new Error('no ai'); } });
  assert.equal(bad.via, 'local');
  assert.deepEqual(bad.queries, local.queries);
  assert.deepEqual(parseFootageQueries('["latte art","coffee beans"]'), ['latte art', 'coffee beans']);
  assert.ok(buildFootageQueryRequest(shot).schema);
});

test('zhToEnTerms 扩充词表', () => {
  assert.deepEqual(zhToEnTerms('推门 背影 晨光'), ['opening door', 'from behind', 'morning light']);
});

test('示例素材：manifest 与内置清单一致、真人实拍许可（有磁盘视频或要求素材时一并验体积）', () => {
  const manifestPath = path.join(SAMPLE_MEDIA_DIR, 'manifest.json');
  assert.ok(fs.existsSync(manifestPath), `缺少 ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.ok(manifest.length >= 6 && manifest.length <= 8);
  assert.deepEqual(manifest.map((m) => [m.file, m.shotIndex]), SAMPLE_MEDIA.map((m) => [m.file, m.shotIndex]));
  for (const m of manifest) {
    assert.ok(m.credit && m.url && m.license, m.file);
  }
  const hasMp4 = fs.readdirSync(SAMPLE_MEDIA_DIR).some((f) => /\.mp4$/i.test(f));
  if (hasMp4 || process.env.FF_REQUIRE_ASSETS === '1') {
    let total = 0;
    for (const m of manifest) {
      total += fs.statSync(path.join(SAMPLE_MEDIA_DIR, m.file)).size;
    }
    assert.ok(total <= 40 * 1048576);
  }
});

test('示例项目：每个镜头引用实拍素材（source=stock），初剪不用 previz', () => {
  assert.equal(sampleMediaDir('C:\\app\\resources'), 'C:\\app\\resources\\sample-media');
  assert.equal(sampleMediaDir('/x/build/sample-media/'), '/x/build/sample-media');
  const tmpResources = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-sample-media-'));
  try {
    const tmpSampleDir = path.join(tmpResources, 'sample-media');
    fs.mkdirSync(tmpSampleDir, { recursive: true });
    for (const m of SAMPLE_MEDIA) {
      fs.writeFileSync(path.join(tmpSampleDir, m.file), Buffer.from('dummy-mp4'));
    }
    const p = createSampleProject({ resources: tmpResources });
    for (const s of p.storyboard) {
      const a = p.assets[s.footageAssetId];
      assert.ok(a, `第 ${s.index} 镜缺实拍`);
      assert.equal(a.source, 'stock');
      assert.ok(a.credit);
      assert.ok(fs.existsSync(a.path), a.path);
    }
    const { project, report } = buildFirstCut(p);
    assert.equal(project.tracks.video.length, p.storyboard.length);
    for (const c of project.tracks.video) assert.equal(project.assets[c.assetId].source, 'stock');
    assert.ok(!report.some((r) => /预演/.test(r)));
    // 素材目录未知 / 文件缺失时兜底 previz
    const q = createSampleProject({ resources: tmpResources, missing: ['shot04-latte-art.mp4'] });
    const cut = buildFirstCut(q).project;
    assert.equal(cut.tracks.video.filter((c) => cut.assets[c.assetId].kind === 'previz').length, 1);
  } finally {
    fs.rmSync(tmpResources, { recursive: true, force: true });
  }
  const hasRealMp4 = fs.existsSync(SAMPLE_MEDIA_DIR) && fs.readdirSync(SAMPLE_MEDIA_DIR).some((f) => /\.mp4$/i.test(f));
  if (hasRealMp4 || process.env.FF_REQUIRE_ASSETS === '1') {
    const pReal = createSampleProject({ resources: BUILD_DIR });
    for (const s of pReal.storyboard) {
      const a = pReal.assets[s.footageAssetId];
      assert.ok(a && fs.existsSync(a.path), a ? a.path : `第 ${s.index} 镜缺实拍`);
    }
  }
});
