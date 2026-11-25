// Openverse 免 Key 搜索（electron/lib/openverse.cjs）：字段映射、许可过滤、缓存、限流冷却。全部用假 fetch，不联网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ov = require('../electron/lib/openverse.cjs');
const { licenseOf, cleanTitle, clearCache } = ov._internals;

const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });

const IMAGES = [
  {
    id: 'a1', title: 'Sunset_over_sea.jpg', url: 'https://cdn.example/a1.jpg', thumbnail: 'https://api.openverse.org/v1/images/a1/thumb/',
    foreign_landing_url: 'https://www.flickr.com/photos/x/1', creator: 'Ann', creator_url: 'https://www.flickr.com/people/ann',
    license: 'by', license_version: '2.0', license_url: 'https://creativecommons.org/licenses/by/2.0/', source: 'flickr', width: 1024, height: 768, filesize: 2048,
  },
  { id: 'a2', title: 'NC picture', url: 'https://cdn.example/a2.jpg', license: 'by-nc', license_version: '4.0' },
  { id: 'a3', title: 'Zero', url: 'https://cdn.example/a3.jpg', license: 'cc0', license_version: '1.0' },
  { id: 'a3', title: 'Zero again', url: 'https://cdn.example/a3.jpg', license: 'cc0', license_version: '1.0' },
  { id: 'a4', title: 'No url', license: 'cc0' },
];

test('licenseOf / cleanTitle', () => {
  assert.deepEqual(licenseOf({ license: 'by-sa', license_version: '4.0', license_url: 'u' }), { id: 'cc-by-sa', name: 'CC BY-SA 4.0', url: 'u' });
  assert.equal(licenseOf({ license: 'cc0' }).id, 'cc0');
  assert.equal(licenseOf({ license: 'pdm' }).name, '公共领域');
  assert.equal(licenseOf({ license: 'sampling+' }).id, 'unknown');
  assert.equal(cleanTitle('Sunset_over_sea.jpg', 'x'), 'Sunset over sea');
  assert.equal(cleanTitle('', '默认'), '默认');
});

test('searchOpenverse 图片：只留可商用可改编的许可、去重、字段齐全，24 小时内走缓存', async () => {
  clearCache();
  let calls = 0;
  const f = async (url, init) => {
    calls += 1;
    assert.match(url, /^https:\/\/api\.openverse\.org\/v1\/images\/\?/);
    assert.match(url, /license_type=commercial%2Cmodification/);
    assert.match(url, /mature=false/);
    assert.ok(init.headers['User-Agent']);
    return json({ results: IMAGES }, 200, { 'x-ratelimit-available-anon_burst': '10' });
  };
  const out = await ov.searchOpenverse('sunset', 'image', 8, { fetchImpl: f });
  assert.deepEqual(out.map((r) => r.id), ['openverse_img_a1', 'openverse_img_a3']);
  const a = out[0];
  assert.equal(a.source, 'openverse');
  assert.equal(a.title, 'Sunset over sea');
  assert.equal(a.url, 'https://www.flickr.com/photos/x/1');
  assert.equal(a.downloadUrl, 'https://cdn.example/a1.jpg');
  assert.equal(a.thumb, 'https://api.openverse.org/v1/images/a1/thumb/');
  assert.equal(a.license, 'CC BY 2.0');
  assert.equal(a.licenseId, 'cc-by');
  assert.equal(a.licenseUrl, 'https://creativecommons.org/licenses/by/2.0/');
  assert.equal(a.author, 'Ann');
  assert.equal(a.provider, 'flickr');
  assert.equal(a.kind, 'image');
  assert.equal(a.width, 1024);
  // 同样的搜索（大小写不同）走缓存；改了返回值也不影响缓存
  out[0].title = '被改了';
  const again = await ov.searchOpenverse('Sunset', 'image', 8, { fetchImpl: f });
  assert.equal(calls, 1);
  assert.equal(again[0].title, 'Sunset over sea');
  clearCache();
});

test('searchOpenverse 音乐：时长毫秒转秒；视频类型直接返回空', async () => {
  clearCache();
  const f = async (url) => {
    assert.match(url, /\/v1\/audio\/\?/);
    return json({ results: [{ id: 'm1', title: 'Calm piano', url: 'https://cdn.example/m1.mp3', license: 'by-sa', license_version: '3.0', duration: 125500 }] });
  };
  const songs = await ov.searchOpenverse('calm piano', 'audio', 8, { fetchImpl: f });
  assert.equal(songs.length, 1);
  assert.equal(songs[0].id, 'openverse_aud_m1');
  assert.equal(songs[0].kind, 'audio');
  assert.equal(songs[0].duration, 125.5);
  assert.equal(songs[0].thumb, null);
  assert.deepEqual(await ov.searchOpenverse('x', 'video', 8, { fetchImpl: f }), []);
  clearCache();
});

test('searchOpenverse：429 按 Retry-After 冷却，冷却中不再请求', async () => {
  clearCache();
  let calls = 0;
  const f = async () => { calls += 1; return new Response('', { status: 429, headers: { 'retry-after': '30' } }); };
  await assert.rejects(ov.searchOpenverse('cat', 'image', 8, { fetchImpl: f }), (e) => e.code === 'RATE_LIMITED' && /30 秒/.test(e.message));
  await assert.rejects(ov.searchOpenverse('dog', 'image', 8, { fetchImpl: f }), (e) => e.code === 'RATE_LIMITED' && /\d+ 秒/.test(e.message) && !/\.\d/.test(e.message));
  assert.equal(calls, 1);
  clearCache();
});

test('searchOpenverse：额度用完时提前冷却；网络错误 / 服务器错误给出中文提示', async () => {
  clearCache();
  const empty = async () => json({ results: [] }, 200, { 'x-ratelimit-available-anon_burst': '0' });
  assert.deepEqual(await ov.searchOpenverse('a', 'image', 8, { fetchImpl: empty }), []);
  await assert.rejects(ov.searchOpenverse('b', 'image', 8, { fetchImpl: empty }), (e) => e.code === 'RATE_LIMITED');
  clearCache();
  await assert.rejects(ov.searchOpenverse('c', 'image', 8, { fetchImpl: async () => { throw new TypeError('fetch failed'); } }), /连不上 Openverse/);
  await assert.rejects(ov.searchOpenverse('d', 'image', 8, { fetchImpl: async () => new Response('oops', { status: 503 }) }), /HTTP 503/);
  await assert.rejects(ov.searchOpenverse('', 'image', 8, { fetchImpl: empty }), /请输入搜索关键词/);
  clearCache();
});
