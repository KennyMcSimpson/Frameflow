// B 站原生搜索（electron/lib/bilibili.cjs）：WBI 签名、结果映射、风控退避。全部用假 fetch，不联网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bili = require('../electron/lib/bilibili.cjs');
const { getMixinKey, signWbi, keyFromUrl, parseClock, mapVideo, stripHtml, resetState, state, MIXIN_KEY_ENC_TAB } = bili._internals;

const IMG_KEY = '7cd084941338484aae1ad9425b84077c';
const SUB_KEY = '4932caff0ff746eab6f01bf08b70ac45';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    for (const [re, handler] of routes) if (re.test(String(url))) return handler(url, init);
    return new Response('not found', { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

const NAV = () => json({ code: -101, message: '账号未登录', data: { wbi_img: { img_url: `https://i0.hdslb.com/bfs/wbi/${IMG_KEY}.png`, sub_url: `https://i0.hdslb.com/bfs/wbi/${SUB_KEY}.png` } } });
const SPI = () => json({ code: 0, data: { b_3: 'B3-TEST', b_4: 'B4-TEST' } });

test('WBI：混淆表是 0..63 的排列，签名与公开示例一致', () => {
  assert.equal(MIXIN_KEY_ENC_TAB.length, 64);
  assert.deepEqual([...MIXIN_KEY_ENC_TAB].sort((a, b) => a - b), Array.from({ length: 64 }, (_, i) => i));
  assert.equal(getMixinKey(IMG_KEY + SUB_KEY), 'ea1db124af3c7062474693fa704f4ff8');
  assert.equal(
    signWbi({ foo: '114', bar: '514', zab: 1919810 }, IMG_KEY, SUB_KEY, 1702204169000),
    'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4',
  );
  // 值里的 !'()* 会被去掉
  assert.match(signWbi({ keyword: "a(b)'c*!" }, IMG_KEY, SUB_KEY, 1702204169000), /^keyword=abc&wts=1702204169&w_rid=[0-9a-f]{32}$/);
  assert.equal(keyFromUrl('https://i0.hdslb.com/bfs/wbi/abc123.png'), 'abc123');
});

test('parseClock / stripHtml / mapVideo', () => {
  assert.equal(parseClock('4:31'), 271);
  assert.equal(parseClock('1:02:03'), 3723);
  assert.equal(parseClock(90), 90);
  assert.equal(parseClock('abc'), null);
  assert.equal(parseClock(''), null);
  assert.equal(stripHtml('<em class="keyword">咖啡</em>&amp;拉花'), '咖啡&拉花');
  const r = mapVideo({ type: 'video', bvid: 'BV1xx411c7mD', title: '<em class="keyword">咖啡</em>教程', pic: '//i0.hdslb.com/a.jpg', duration: '4:31', author: 'UP主', mid: 42 });
  assert.equal(r.id, 'bilibili_BV1xx411c7mD');
  assert.equal(r.url, 'https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(r.title, '咖啡教程');
  assert.equal(r.thumb, 'https://i0.hdslb.com/a.jpg');
  assert.equal(r.duration, 271);
  assert.equal(r.authorUrl, 'https://space.bilibili.com/42');
  assert.equal(r.reference, true);
  assert.match(r.license, /仅供学习/);
  assert.equal(mapVideo({ type: 'bili_user', mid: 1 }), null);
  assert.equal(mapVideo({ type: 'video', aid: 170001 }).url, 'https://www.bilibili.com/video/av170001');
});

test('searchBilibili：buvid → WBI → 搜索，去重并复用缓存的 key', async () => {
  resetState();
  const f = fakeFetch([
    [/finger\/spi/, SPI],
    [/web-interface\/nav/, NAV],
    [/wbi\/search\/type/, () => json({ code: 0, data: { result: [
      { type: 'video', bvid: 'BV1xx411c7mD', title: '<em class="keyword">咖啡</em>拉花教程', pic: '//i0.hdslb.com/a.jpg', duration: '4:31', author: 'UP主', mid: 123 },
      { type: 'video', bvid: 'BV1xx411c7mD', title: '重复的结果' },
      { type: 'video', bvid: 'BV2yy411c7mE', title: '第二个', duration: '0:59' },
    ] } })],
  ]);
  const out = await bili.searchBilibili('咖啡 拉花', 8, { fetchImpl: f });
  assert.deepEqual(out.map((r) => r.id), ['bilibili_BV1xx411c7mD', 'bilibili_BV2yy411c7mE']);
  assert.equal(out[0].title, '咖啡拉花教程');
  const call = f.calls.find((c) => /search\/type/.test(c.url));
  assert.match(call.url, /search_type=video/);
  assert.match(call.url, /keyword=%E5%92%96%E5%95%A1%20%E6%8B%89%E8%8A%B1/);
  assert.match(call.url, /&w_rid=[0-9a-f]{32}$/);
  assert.match(call.init.headers.Cookie, /buvid3=B3-TEST; buvid4=B4-TEST/);
  assert.match(call.init.headers.Referer, /bilibili\.com/);
  // limit 生效；第二次搜索不再请求 spi / nav
  const one = await bili.searchBilibili('咖啡', 1, { fetchImpl: f });
  assert.equal(one.length, 1);
  assert.equal(f.calls.filter((c) => /finger\/spi/.test(c.url)).length, 1);
  assert.equal(f.calls.filter((c) => /web-interface\/nav/.test(c.url)).length, 1);
  resetState();
});

test('searchBilibili：-352 风控 → BILI_RISK，冷却期内不再发请求', async () => {
  resetState();
  const f = fakeFetch([[/finger\/spi/, SPI], [/web-interface\/nav/, NAV], [/wbi\/search\/type/, () => json({ code: -352, message: '风控校验失败' })]]);
  await assert.rejects(bili.searchBilibili('x', 8, { fetchImpl: f }), (e) => e.code === 'BILI_RISK');
  assert.equal(state.buvid, null); // 下次换一个 buvid3
  const n = f.calls.length;
  await assert.rejects(bili.searchBilibili('x', 8, { fetchImpl: f }), (e) => e.code === 'BILI_RISK' && /一分钟/.test(e.message));
  assert.equal(f.calls.length, n);
  resetState();
});

test('searchBilibili：HTTP 412 也算风控；其它错误码清掉签名缓存并给出中文提示', async () => {
  resetState();
  const f412 = fakeFetch([[/finger\/spi/, SPI], [/web-interface\/nav/, NAV], [/wbi\/search\/type/, () => new Response('', { status: 412 })]]);
  await assert.rejects(bili.searchBilibili('x', 8, { fetchImpl: f412 }), (e) => e.code === 'BILI_RISK');
  resetState();
  const fBad = fakeFetch([[/finger\/spi/, SPI], [/web-interface\/nav/, NAV], [/wbi\/search\/type/, () => json({ code: -400, message: '请求错误' })]]);
  await assert.rejects(bili.searchBilibili('x', 8, { fetchImpl: fBad }), (e) => /B 站搜索失败（请求错误）/.test(e.message) && e.code !== 'BILI_RISK');
  assert.equal(state.wbi, null);
  assert.ok(state.buvid); // buvid 还能用
  resetState();
  const fNet = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(bili.searchBilibili('x', 8, { fetchImpl: fNet }), /连不上 B 站/);
  await assert.rejects(bili.searchBilibili('   ', 8, { fetchImpl: fNet }), /请输入搜索关键词/);
  resetState();
});
