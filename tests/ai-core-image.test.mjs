// ai-core：出图（ai:image）——即梦 Seedream（火山方舟 Ark）与 OpenAI 兼容接口。
// 全部用伪造的 fetch，不联网、不花钱；文件都写在系统临时目录。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const registerAI = require('../electron/ipc/ai.cjs');
const AI = registerAI._internals;

const ARK_URL = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';
const IMG_URL = 'https://ark-content.example.com/out/abc.jpeg?sig=1';

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-ai-image-')); });
after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

// ───────────────────────── 伪造的图片与响应 ─────────────────────────
function fakeJpeg(w, h) {
  const head = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.from([0xFF, 0xC0, 0x00, 0x11, 0x08, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([head, sof, Buffer.alloc(200, 0x55), Buffer.from([0xFF, 0xD9])]);
}
function fakePng(w, h) {
  const b = Buffer.alloc(160, 0x11);
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const arkErr = (status, code, message, extra = {}, headers = {}) => json(status, { error: { code, message, type: 'BadRequest', ...extra } }, headers);
const arkOk = (url = IMG_URL) => json(200, { model: 'doubao-seedream-4-0-250828', created: 1, data: [{ url, size: '2560x1440' }], usage: { generated_images: 1 } });
const image = (buf, status = 200) => new Response(buf, { status, headers: { 'content-type': 'image/jpeg' } });

/**
 * 搭一个假的主进程环境。
 * @param {{ai?:object, secrets?:object, videogen?:object, responses?:Array<Response|Error|Function>}} o
 *   responses 按调用顺序依次返回；元素是函数时用它的返回值（可以拿到 url 和 init）
 */
function setup({ ai = {}, secrets = {}, videogen = {}, responses = [] } = {}) {
  const root = fs.mkdtempSync(path.join(dir, 'case-'));
  const calls = [];
  const sleeps = [];
  const started = [];
  const registered = [];
  const queue = [...responses];
  const ctx = {
    settings: {
      get: () => ({ ai, videogen }),
      getSecret: (name) => secrets[name] || '',
    },
    paths: { tmp: path.join(root, 'tmp'), userData: root, cache: path.join(root, 'cache'), projectCache: (id) => path.join(root, 'projects', id, 'cache') },
    registerMediaPath: (p) => registered.push(p),
    fetch: async (url, init = {}) => {
      const call = { url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null };
      calls.push(call);
      if (init.signal && init.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (!queue.length) throw new Error(`测试没有为第 ${calls.length} 次请求准备响应：${url}`);
      let r = queue.shift();
      if (typeof r === 'function') r = await r(call, init);
      if (r instanceof Error) throw r;
      return r;
    },
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      if (signal && signal.aborted) throw Object.assign(new Error('已取消'), { code: 'CANCELLED' });
    },
    jobs: {
      start(kind, fn, meta = {}) {
        const controller = new AbortController();
        const sent = [];
        const job = {
          meta, signal: controller.signal, cancelled: false, sent,
          progress: (stage, progress, message) => sent.push({ stage, progress, message }),
          throwIfCancelled() { if (controller.signal.aborted) throw Object.assign(new Error('已取消'), { code: 'CANCELLED' }); },
          cancel() { job.cancelled = true; controller.abort(); },
        };
        // 先登记再执行：伪造响应里可以拿到 started[n].job（用来模拟「生成到一半用户点了取消」）
        const entry = { kind, meta, job, promise: null };
        started.push(entry);
        entry.promise = fn(job);
        entry.promise.catch(() => {});
        return { jobId: `job${started.length}` };
      },
    },
  };
  const handlers = {};
  registerAI({ handle: (ch, fn) => { handlers[ch] = fn; }, ctx });
  /** 发起出图并等结果 */
  const run = async (payload) => {
    const r = await handlers['ai:image'](payload);
    assert.match(r.jobId, /^job\d+$/);
    return started[started.length - 1].promise;
  };
  return { root, ctx, handlers, calls, sleeps, started, registered, run, left: () => queue.length };
}

const ARK = { secrets: { arkKey: 'ark-test-key' } };
const OPENAI = { ai: { openaiBaseUrl: 'https://api.example.com/v1/', openaiModel: 'gpt-x', openaiImageModel: 'gpt-image-1' }, secrets: { openaiKey: 'sk-test' } };

// ───────────────────────── 纯函数 ─────────────────────────
test('画幅 → 即梦尺寸：用户要求的五种映射，以及推断与就近取整', () => {
  assert.equal(AI.ARK_IMAGE_SIZES['16:9'], '2560x1440');
  assert.equal(AI.ARK_IMAGE_SIZES['9:16'], '1440x2560');
  assert.equal(AI.ARK_IMAGE_SIZES['1:1'], '2048x2048');
  assert.equal(AI.ARK_IMAGE_SIZES['4:3'], '2304x1728');
  assert.equal(AI.ARK_IMAGE_SIZES['3:4'], '1728x2304');
  // 每个尺寸的比例都和画幅一致
  for (const [aspect, size] of Object.entries(AI.ARK_IMAGE_SIZES)) {
    const [aw, ah] = aspect.split(':').map(Number);
    const [w, h] = size.split('x').map(Number);
    assert.ok(Math.abs(w / h - aw / ah) < 0.005, `${aspect} → ${size}`);
  }
  assert.equal(AI.imageAspect('9:16'), '9:16');
  assert.equal(AI.imageAspect('9：16'), '9:16', '全角冒号');
  assert.equal(AI.imageAspect('', '1024x1536'), '9:16', '旧调用方只传 OpenAI 尺寸');
  assert.equal(AI.imageAspect('', '1536x1024'), '16:9');
  assert.equal(AI.imageAspect(undefined, '1024x1024'), '1:1');
  assert.equal(AI.imageAspect('4:5'), '3:4', '不在表里的比例取最接近的');
  assert.equal(AI.imageAspect('2.35:1'), '21:9');
  assert.equal(AI.imageAspect('', '1920x1080'), '16:9');
  assert.equal(AI.imageAspect('乱写', '也乱写'), '16:9');
  assert.equal(AI.imageAspect(null, null), '16:9');
  assert.deepEqual(AI.arkImageSizes('16:9'), ['2560x1440', '2K', '1280x720']);
  assert.deepEqual(AI.arkImageSizes('没有这个'), ['2560x1440', '2K', '1280x720']);
  assert.equal(AI.openaiImageSize('1024x1536', '16:9'), '1024x1536', '调用方给的合法尺寸优先');
  assert.equal(AI.openaiImageSize('', '9:16'), '1024x1536');
  assert.equal(AI.openaiImageSize('', '4:3'), '1536x1024');
  assert.equal(AI.openaiImageSize('2560x1440', '1:1'), '1024x1024');
});

test('pickImageProvider：auto 有火山方舟 Key 用即梦，否则用 OpenAI；指定的那家没配好不改走另一家', () => {
  const P = AI.pickImageProvider;
  assert.equal(P('auto', { hasArk: true, hasOpenai: true }), 'ark');
  assert.equal(P('auto', { hasArk: true, hasOpenai: false }), 'ark');
  assert.equal(P('auto', { hasArk: false, hasOpenai: true }), 'openai');
  assert.equal(P('auto', { hasArk: false, hasOpenai: false }), 'none');
  assert.equal(P('ark', { hasArk: false, hasOpenai: true }), 'none');
  assert.equal(P('ark', { hasArk: true, hasOpenai: true }), 'ark');
  assert.equal(P('openai', { hasArk: true, hasOpenai: false }), 'none');
  assert.equal(P('openai', { hasArk: true, hasOpenai: true }), 'openai');
  assert.equal(P(undefined, {}), 'none');
});

test('normalizeArkBaseUrl：留空用默认地址，多写的路径去掉', () => {
  assert.equal(AI.normalizeArkBaseUrl(''), AI.ARK_BASE_URL);
  assert.equal(AI.normalizeArkBaseUrl('不是网址'), AI.ARK_BASE_URL);
  assert.equal(AI.normalizeArkBaseUrl('https://ark.cn-beijing.volces.com/api/v3/'), 'https://ark.cn-beijing.volces.com/api/v3');
  assert.equal(AI.normalizeArkBaseUrl('https://proxy.example.com/api/v3/images/generations'), 'https://proxy.example.com/api/v3');
  assert.equal(AI.normalizeArkBaseUrl('https://proxy.example.com/api/v3/contents/generations/tasks'), 'https://proxy.example.com/api/v3');
});

test('arkImageError：火山方舟的报错翻成人话，并给出下一步', () => {
  const E = (status, code, message, extra, headers) => AI.arkImageError(status, JSON.stringify({ error: { code, message, ...(extra || {}) } }), headers);

  const notOpen = E(404, 'ModelNotOpen', 'Your account 2100000 has not activated the model doubao-seedream-4-0-250828.');
  assert.ok(notOpen.message.includes('请在火山方舟控制台『开通管理』里开通 Seedream 图片模型'), notOpen.message);
  assert.equal(notOpen.code, 'IMAGE_SETUP');
  assert.equal(notOpen.apiCode, 'ModelNotOpen');
  assert.equal(notOpen.status, 404);
  assert.ok(notOpen.detail.includes('has not activated'));
  assert.equal(notOpen.retryable, false);

  const auth = E(401, 'AuthenticationError', 'The API key format is incorrect.');
  assert.match(auth.message, /API Key 不对或已失效/);
  assert.match(auth.message, /API Key 管理/);
  assert.equal(auth.code, 'IMAGE_SETUP');
  assert.match(AI.arkImageError(401, 'Unauthorized').message, /API Key 不对或已失效/, '只有状态码也认得出');

  assert.match(E(403, 'AccountOverdueError', 'The request failed because your account has an overdue balance.').message, /余额不足或已欠费/);
  assert.equal(E(403, 'AccountOverdueError', 'x').code, 'IMAGE_BALANCE');
  assert.match(E(429, 'QuotaExceeded', 'free trial quota used up').message, /免费额度已用完/);
  assert.equal(E(429, 'QuotaExceeded', 'x').retryable, false, '额度用完不是限流，重试没用');
  assert.match(E(429, 'SetLimitExceeded', 'x').message, /安全体验模式/);
  assert.match(AI.arkImageError(402, '').message, /余额不足或已欠费/);

  const inSens = E(400, 'InputTextSensitiveContentDetected', 'The request failed because the input text may contain sensitive information.');
  assert.match(inSens.message, /画面描述没通过内容审核/);
  assert.match(inSens.message, /换个说法/);
  assert.equal(inSens.code, 'IMAGE_BLOCKED');
  assert.match(E(400, 'OutputImageSensitiveContentDetected', 'x').message, /生成的图片没通过内容审核/);
  assert.match(E(400, 'SensitiveContentDetected', 'x').message, /内容审核未通过/);
  assert.match(E(400, '', '内容审核未通过').message, /换个描述/);

  const rate = E(429, 'RateLimitExceeded.EndpointRPMExceeded', 'rpm limit', null, new Headers({ 'retry-after': '3' }));
  assert.match(rate.message, /稍等一两分钟/);
  assert.equal(rate.retryable, true);
  assert.equal(rate.retryAfterMs, 3000);
  assert.equal(E(429, 'RateLimitExceeded', 'x').retryAfterMs, 5000, '没给等待时间按 5 秒');
  assert.equal(E(429, 'RateLimitExceeded', 'x', null, new Headers({ 'retry-after': '600' })).retryAfterMs, 20000, '最多等 20 秒');
  assert.equal(AI.arkImageError(429, '').retryable, true);
  assert.equal(E(503, 'ServerOverloaded', 'x').retryable, true);
  assert.equal(E(500, 'InternalServiceError', 'x').retryable, false, '可能已经出图：不自动重发，避免重复扣费');
  assert.match(E(500, 'InternalServiceError', 'x').message, /服务繁忙/);

  const size = E(400, 'InvalidParameter', 'The parameter `size` specified in the request is not valid: image size must be at least 921600 pixels.', { param: 'size' });
  assert.equal(size.sizeInvalid, true);
  assert.equal(size.code, 'IMAGE_SIZE');
  assert.equal(E(400, 'InvalidParameter', 'the size 2560x1440 is not supported by this model').sizeInvalid, true);
  assert.equal(E(400, 'InvalidParameter', 'prompt is required').sizeInvalid, false);
  assert.equal(E(400, 'InputTextSensitiveContentDetected', 'size').sizeInvalid, false, '错误码优先');

  assert.match(E(404, 'InvalidEndpointOrModel.NotFound', 'The model or endpoint xxx does not exist').message, /找不到这个图片模型/);
  assert.match(E(403, 'AccessDenied', 'x').message, /同一个账号/);

  const other = E(400, 'SomethingNew', 'weird thing happened');
  assert.equal(other.code, 'IMAGE_FAILED');
  assert.match(other.message, /火山方舟返回了错误（HTTP 400）：weird thing happened/);
  // 不是 JSON 的错误体（网关报错页）也不会崩
  assert.match(AI.arkImageError(502, '<html>Bad Gateway</html>').message, /服务繁忙/);
  assert.equal(AI.classifyArkImageError('', '', 0), 'other');
});

test('arkResultError：HTTP 200 但没出图时也给出原因', () => {
  assert.equal(AI.arkResultError({ data: [{ url: IMG_URL }] }), null);
  assert.equal(AI.arkResultError({ data: [{ b64_json: 'abcd' }] }), null);
  assert.match(AI.arkResultError({ data: [{ error: { code: 'OutputImageSensitiveContentDetected', message: 'x' } }] }).message, /生成的图片没通过内容审核/);
  assert.match(AI.arkResultError({ error: { code: 'ModelNotOpen', message: 'x' } }).message, /开通管理/);
  assert.match(AI.arkResultError({ data: [] }).message, /没有返回图片/);
  assert.match(AI.arkResultError(null).message, /没有返回图片/);
});

test('sniffImage：按文件头认格式和宽高，认不出的不当图片', () => {
  assert.deepEqual(AI.sniffImage(fakeJpeg(2560, 1440)), { ext: '.jpg', width: 2560, height: 1440 });
  assert.deepEqual(AI.sniffImage(fakePng(1536, 1024)), { ext: '.png', width: 1536, height: 1024 });
  const gif = Buffer.alloc(40);
  gif.write('GIF89a', 0, 'latin1'); gif.writeUInt16LE(320, 6); gif.writeUInt16LE(200, 8);
  assert.deepEqual(AI.sniffImage(gif), { ext: '.gif', width: 320, height: 200 });
  const webp = Buffer.alloc(40);
  webp.write('RIFF', 0, 'latin1'); webp.write('WEBP', 8, 'latin1'); webp.write('VP8X', 12, 'latin1');
  webp.writeUIntLE(2047, 24, 3); webp.writeUIntLE(1151, 27, 3);
  assert.deepEqual(AI.sniffImage(webp), { ext: '.webp', width: 2048, height: 1152 });
  assert.equal(AI.sniffImage(Buffer.from('<html><body>403 Forbidden</body></html> 填充到够长为止')), null);
  assert.equal(AI.sniffImage(Buffer.alloc(4)), null);
  assert.equal(AI.sniffImage(null), null);
  assert.equal(AI.sniffImage('不是 Buffer'), null);
});

// ───────────────────────── ai:image：即梦 ─────────────────────────
test('ai:image 即梦：按用户要求的接口、鉴权、参数出图，下载后按真实格式存盘', async () => {
  const s = setup({ ...ARK, responses: [arkOk(), image(fakeJpeg(2560, 1440))] });
  const out = await s.run({ prompt: '  咖啡拉花特写，暖色窗光  ', aspect: '16:9', projectId: 'p1' });

  assert.equal(s.calls.length, 2);
  const gen = s.calls[0];
  assert.equal(gen.url, ARK_URL);
  assert.equal(gen.method, 'POST');
  assert.equal(gen.headers.Authorization, 'Bearer ark-test-key');
  assert.deepEqual(gen.body, {
    model: 'doubao-seedream-4-0-250828', prompt: '咖啡拉花特写，暖色窗光', size: '2560x1440', response_format: 'url', watermark: false,
  });
  assert.equal(s.calls[1].url, IMG_URL);
  assert.equal(s.calls[1].headers.Authorization, undefined, '下载图片不带 Key');

  assert.equal(out.provider, 'ark');
  assert.equal(out.model, 'doubao-seedream-4-0-250828');
  assert.equal(out.width, 2560);
  assert.equal(out.height, 1440);
  assert.equal(out.aspect, '16:9');
  assert.equal(out.size, '2560x1440');
  assert.equal(path.extname(out.path), '.jpg', '即梦返回的是 JPEG，不能存成 .png');
  assert.ok(out.path.startsWith(path.join(s.root, 'projects', 'p1', 'cache', 'ai-images')));
  assert.ok(fs.readFileSync(out.path).equals(fakeJpeg(2560, 1440)));
  assert.ok(!fs.existsSync(out.path + '.tmp'));
  assert.deepEqual(s.registered, [out.path]);

  const { job, kind, meta } = s.started[0];
  assert.equal(kind, 'ai-image');
  assert.equal(meta.provider, 'ark');
  const stages = job.sent.map((x) => x.stage);
  for (const st of ['生成图片', '下载图片', '完成']) assert.ok(stages.includes(st), st);
  assert.equal(job.sent[job.sent.length - 1].progress, 1);
  assert.equal(meta.phase, '完成');

  // 用时统计里记一条 image，不含描述内容
  const m = await s.handlers['ai:metrics']();
  assert.equal(m.tasks[0].task, 'image');
  assert.equal(m.tasks[0].ok, 1);
  assert.deepEqual(m.tasks[0].providers, { ark: 1 });
  assert.ok(!fs.readFileSync(m.file, 'utf8').includes('咖啡'));
});

test('ai:image 即梦：画幅映射、模型名覆盖、接口地址沿用即梦视频的设置', async () => {
  const cases = [['9:16', '1440x2560'], ['1:1', '2048x2048'], ['4:3', '2304x1728'], ['3:4', '1728x2304']];
  for (const [aspect, size] of cases) {
    const s = setup({ ...ARK, responses: [arkOk(), image(fakeJpeg(8, 8))] });
    const out = await s.run({ prompt: '测试', aspect });
    assert.equal(s.calls[0].body.size, size, aspect);
    assert.equal(out.aspect, aspect);
    assert.ok(out.path.startsWith(path.join(s.root, 'cache', 'ai-images')), '没有 projectId 时放公共缓存');
  }
  // 旧调用方只传 size（OpenAI 的写法）：按横竖方换算
  const legacy = setup({ ...ARK, responses: [arkOk(), image(fakeJpeg(8, 8))] });
  await legacy.run({ prompt: '测试', size: '1024x1536' });
  assert.equal(legacy.calls[0].body.size, '1440x2560');

  // 模型名覆盖 + 自定义接口地址（和即梦视频共用）
  const custom = setup({
    ai: { imageModels: { ark: '  ep-20251101-abcde  ' } },
    secrets: { arkKey: '  ark-test-key  ' },
    videogen: { overrides: { seedance: { baseUrl: 'https://proxy.example.com/api/v3/' } } },
    responses: [arkOk(), image(fakeJpeg(8, 8))],
  });
  const out = await custom.run({ prompt: '测试' });
  assert.equal(custom.calls[0].url, 'https://proxy.example.com/api/v3/images/generations');
  assert.equal(custom.calls[0].body.model, 'ep-20251101-abcde');
  assert.equal(custom.calls[0].headers.Authorization, 'Bearer ark-test-key', 'Key 两头的空格去掉');
  assert.equal(out.model, 'ep-20251101-abcde');
});

test('ai:image 即梦：尺寸不被接受时退回 2K（比例写进描述），再不行用老模型的小尺寸', async () => {
  const sizeErr = () => arkErr(400, 'InvalidParameter', 'The parameter `size` specified in the request is not valid.', { param: 'size' });
  const s = setup({ ...ARK, responses: [sizeErr(), arkOk(), image(fakeJpeg(2848, 1600))] });
  const out = await s.run({ prompt: '海边日落', aspect: '9:16' });
  assert.equal(s.calls.length, 3);
  assert.equal(s.calls[0].body.size, '1440x2560');
  assert.equal(s.calls[1].body.size, '2K');
  assert.match(s.calls[1].body.prompt, /^海边日落\n画面比例：竖屏 9:16。$/);
  assert.equal(s.calls[1].body.watermark, false);
  assert.equal(out.size, '2K');
  assert.equal(out.width, 2848);
  assert.ok(s.started[0].job.sent.some((x) => x.stage === '换个尺寸重试'));
  assert.deepEqual(s.sleeps, [], '换尺寸不用等');

  // 老一代模型：两种都不认，最后用小尺寸
  const old = setup({ ai: { imageModels: { ark: 'doubao-seedream-3-0-t2i-250415' } }, ...{ secrets: ARK.secrets }, responses: [sizeErr(), sizeErr(), arkOk(), image(fakeJpeg(1280, 720))] });
  const o = await old.run({ prompt: '海边日落', aspect: '16:9' });
  assert.deepEqual(old.calls.slice(0, 3).map((c) => c.body.size), ['2560x1440', '2K', '1280x720']);
  assert.equal(old.calls[2].body.prompt, '海边日落');
  assert.equal(o.size, '1280x720');

  // 三种都不行：把原因告诉用户，不再重试
  const bad = setup({ ...ARK, responses: [sizeErr(), sizeErr(), sizeErr()] });
  await assert.rejects(bad.run({ prompt: '海边日落' }), (e) => e.code === 'IMAGE_SIZE' && /不支持当前的画面尺寸/.test(e.message));
  assert.equal(bad.calls.length, 3);
});

test('ai:image 即梦：限流（429）自动退避重试一次，再限流就告诉用户稍后再试', async () => {
  const limited = (headers) => arkErr(429, 'RateLimitExceeded.EndpointRPMExceeded', 'Requests exceeded the RPM limit.', {}, headers);
  const s = setup({ ...ARK, responses: [limited({ 'retry-after': '2' }), arkOk(), image(fakeJpeg(8, 8))] });
  const out = await s.run({ prompt: '测试' });
  assert.equal(out.provider, 'ark');
  assert.deepEqual(s.sleeps, [2000], '按服务商给的时间等');
  assert.equal(s.calls.length, 3);
  assert.deepEqual(s.calls[1].body, s.calls[0].body, '重试发的是同一个请求');
  assert.ok(s.started[0].job.sent.some((x) => x.stage === '服务繁忙，正在自动重试'));

  const twice = setup({ ...ARK, responses: [limited(), limited()] });
  await assert.rejects(twice.run({ prompt: '测试' }), (e) => e.code === 'IMAGE_BUSY' && /请求太频繁/.test(e.message) && /稍等一两分钟/.test(e.message));
  assert.deepEqual(twice.sleeps, [5000]);
  assert.equal(twice.calls.length, 2, '只重试一次');

  // 额度用完也是 429，但重试没用：不等、不重试
  const quota = setup({ ...ARK, responses: [arkErr(429, 'QuotaExceeded', 'quota')] });
  await assert.rejects(quota.run({ prompt: '测试' }), (e) => e.code === 'IMAGE_BALANCE' && /免费额度已用完/.test(e.message));
  assert.deepEqual(quota.sleeps, []);
  assert.equal(quota.calls.length, 1);
});

test('ai:image 即梦：未开通、Key 不对、余额不足、审核未通过——各给一句能照着做的话，不重试', async () => {
  const cases = [
    [arkErr(404, 'ModelNotOpen', 'Your account has not activated the model.'), 'IMAGE_SETUP', /请在火山方舟控制台『开通管理』里开通 Seedream 图片模型/],
    [arkErr(401, 'AuthenticationError', 'The API key format is incorrect.'), 'IMAGE_SETUP', /API Key 不对或已失效.*API Key 管理/],
    [arkErr(403, 'AccountOverdueError', 'overdue'), 'IMAGE_BALANCE', /余额不足或已欠费.*充值/],
    [arkErr(400, 'InputTextSensitiveContentDetected', 'sensitive'), 'IMAGE_BLOCKED', /没通过内容审核.*换个说法/],
    [json(200, { data: [{ error: { code: 'OutputImageSensitiveContentDetected', message: 'blocked' } }] }), 'IMAGE_BLOCKED', /生成的图片没通过内容审核/],
    [arkErr(500, 'InternalServiceError', 'oops'), 'IMAGE_BUSY', /服务繁忙/],
  ];
  for (const [res, code, re] of cases) {
    const s = setup({ ...ARK, responses: [res] });
    await assert.rejects(s.run({ prompt: '测试' }), (e) => { assert.equal(e.code, code); assert.match(e.message, re); return true; });
    assert.equal(s.calls.length, 1, code);
    assert.deepEqual(s.sleeps, []);
    assert.deepEqual(s.registered, []);
  }
  // 失败也记进用时统计（带错误分类，不带描述）
  const s = setup({ ...ARK, responses: [arkErr(404, 'ModelNotOpen', 'x')] });
  await assert.rejects(s.run({ prompt: '测试' }));
  const m = await s.handlers['ai:metrics']();
  assert.equal(m.tasks[0].failed, 1);
});

test('ai:image 即梦：连不上、超时给出能看懂的原因，且不自动重发', async () => {
  const offline = setup({ ...ARK, responses: [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })] });
  await assert.rejects(offline.run({ prompt: '测试' }), (e) => e.code === 'NETWORK' && /无法连接火山方舟：请检查网络（ENOTFOUND）/.test(e.message));
  assert.equal(offline.calls.length, 1);

  const notJson = setup({ ...ARK, responses: [new Response('<html>ok</html>', { status: 200 })] });
  await assert.rejects(notJson.run({ prompt: '测试' }), /火山方舟返回了无效响应/);
});

test('ai:image：图片下载失败只重新下载，不重新生成（不重复扣费）', async () => {
  const s = setup({ ...ARK, responses: [arkOk(), new TypeError('fetch failed'), image(Buffer.alloc(0), 502), image(fakeJpeg(8, 8))] });
  const out = await s.run({ prompt: '测试' });
  assert.equal(s.calls.filter((c) => c.url === ARK_URL).length, 1, '只生成一次');
  assert.equal(s.calls.filter((c) => c.url === IMG_URL).length, 3);
  assert.deepEqual(s.sleeps, [1500, 4000]);
  assert.ok(fs.existsSync(out.path));

  const dead = setup({ ...ARK, responses: [arkOk(), new TypeError('fetch failed'), new TypeError('fetch failed'), new TypeError('fetch failed')] });
  await assert.rejects(dead.run({ prompt: '测试' }), /图片已生成，但下载失败：请检查网络后重试/);
  assert.equal(dead.calls.filter((c) => c.url === ARK_URL).length, 1);

  // 链接失效（403）再下也一样：马上报错
  const expired = setup({ ...ARK, responses: [arkOk(), image(Buffer.alloc(0), 403)] });
  await assert.rejects(expired.run({ prompt: '测试' }), /下载失败（HTTP 403）/);
  assert.equal(expired.calls.length, 2);

  // 地址不是 http(s)：不去请求
  const weird = setup({ ...ARK, responses: [arkOk('file:///C:/Windows/win.ini')] });
  await assert.rejects(weird.run({ prompt: '测试' }), /图片地址无效/);
  assert.equal(weird.calls.length, 1);
});

test('ai:image：下载到的不是图片（报错网页）时不存盘', async () => {
  const s = setup({ ...ARK, responses: [arkOk(), new Response('<html><body>AccessDenied：链接已过期，请重新生成后再下载</body></html>', { status: 200 })] });
  await assert.rejects(s.run({ prompt: '测试', projectId: 'p9' }), /收到的不是图片/);
  assert.deepEqual(s.registered, []);
  assert.ok(!fs.existsSync(path.join(s.root, 'projects', 'p9', 'cache', 'ai-images')), '没有留下文件');
});

test('ai:image：取消后不再继续，报「已取消」', async () => {
  // 服务商刚返回结果，用户点了取消：不下载、不存盘
  const s = setup({ ...ARK, responses: [() => { s.started[0].job.cancel(); return arkOk(); }] });
  const r = await s.handlers['ai:image']({ prompt: '测试' });
  assert.ok(r.jobId);
  await assert.rejects(s.started[0].promise, (e) => e.code === 'CANCELLED' && e.message === '已取消');
  assert.equal(s.calls.length, 1, '取消后不下载');
  assert.deepEqual(s.registered, []);
  const m = await s.handlers['ai:metrics']();
  assert.equal(m.tasks[0].failed, 1);

  // 被限流、正要退避等待时取消：不再重试
  const s2 = setup({ ...ARK, responses: [() => { s2.started[0].job.cancel(); return arkErr(429, 'RateLimitExceeded', 'x'); }] });
  await s2.handlers['ai:image']({ prompt: '测试' });
  await assert.rejects(s2.started[0].promise, (e) => e.code === 'CANCELLED');
  assert.equal(s2.calls.length, 1);

  // 请求还在路上就取消（fetch 被中断）
  const s3 = setup({ ...ARK, responses: [() => { s3.started[0].job.cancel(); return Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }); }] });
  await s3.handlers['ai:image']({ prompt: '测试' });
  await assert.rejects(s3.started[0].promise, (e) => e.code === 'CANCELLED');
});

// ───────────────────────── 提供方选择 ─────────────────────────
test('ai:image：两家都没配时立即失败 NO_IMAGE_AI，不建任务、不联网', async () => {
  const cases = [
    [{}, /还没有可用的出图服务：请到设置的「即梦（火山方舟）」里填写 API Key/],
    [{ ai: { imageProvider: 'ark', ...OPENAI.ai }, secrets: OPENAI.secrets }, /出图来源选的是「即梦」，但还没有填写火山方舟 API Key/],
    [{ ai: { imageProvider: 'openai' }, secrets: ARK.secrets }, /出图来源选的是「OpenAI 兼容接口」/],
    // 只填了 OpenAI 的 Key，没填图片模型：不算能出图
    [{ ai: { openaiBaseUrl: 'https://api.example.com/v1', openaiModel: 'gpt-x' }, secrets: OPENAI.secrets }, /还没有可用的出图服务/],
  ];
  for (const [opts, re] of cases) {
    const s = setup(opts);
    await assert.rejects(() => s.handlers['ai:image']({ prompt: '测试' }), (e) => {
      assert.equal(e.code, 'NO_IMAGE_AI');
      assert.match(e.message, /^还没有可用的出图服务/, '固定开头：错误码丢了界面也能认出来');
      assert.match(e.message, re);
      return true;
    });
    assert.equal(s.started.length, 0);
    assert.equal(s.calls.length, 0);
  }
  await assert.rejects(() => setup(ARK).handlers['ai:image']({ prompt: '   ' }), /请提供图片描述/);
  await assert.rejects(() => setup(ARK).handlers['ai:image']({}), /请提供图片描述/);
});

test('ai:image：auto 没有火山方舟 Key 时走 OpenAI 兼容接口；设置或调用方可以指定用哪家', async () => {
  const s = setup({ ...OPENAI, responses: [json(200, { data: [{ b64_json: fakePng(1536, 1024).toString('base64') }] })] });
  const out = await s.run({ prompt: '测试', aspect: '4:3' });
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].url, 'https://api.example.com/v1/images/generations');
  assert.equal(s.calls[0].headers.Authorization, 'Bearer sk-test');
  assert.deepEqual(s.calls[0].body, { model: 'gpt-image-1', prompt: '测试', size: '1536x1024', n: 1 });
  assert.equal(out.provider, 'openai');
  assert.equal(out.model, 'gpt-image-1');
  assert.equal(path.extname(out.path), '.png');
  assert.equal(out.width, 1536);
  assert.equal(out.height, 1024);

  // 两家都配了：auto 用即梦；设置成 openai 用 OpenAI；调用方显式指定优先于设置
  const both = { ai: { ...OPENAI.ai }, secrets: { ...OPENAI.secrets, ...ARK.secrets } };
  const a = setup({ ...both, responses: [arkOk(), image(fakeJpeg(8, 8))] });
  assert.equal((await a.run({ prompt: '测试' })).provider, 'ark');
  const b = setup({ ai: { ...both.ai, imageProvider: 'openai' }, secrets: both.secrets, responses: [json(200, { data: [{ url: IMG_URL }] }), image(fakePng(8, 8))] });
  const bo = await b.run({ prompt: '测试', size: '1024x1536' });
  assert.equal(bo.provider, 'openai');
  assert.equal(b.calls[0].body.size, '1024x1536');
  const c = setup({ ai: { ...both.ai, imageProvider: 'openai' }, secrets: both.secrets, responses: [arkOk(), image(fakeJpeg(8, 8))] });
  assert.equal((await c.run({ prompt: '测试', provider: 'ark' })).provider, 'ark');
  // 乱填的设置值按 auto
  const d = setup({ ai: { ...both.ai, imageProvider: '随便' }, secrets: both.secrets, responses: [arkOk(), image(fakeJpeg(8, 8))] });
  assert.equal((await d.run({ prompt: '测试' })).provider, 'ark');
});

test('ai:image OpenAI：报错沿用通用接口的中文提示', async () => {
  const s = setup({ ...OPENAI, responses: [json(401, { error: { message: 'Incorrect API key provided' } })] });
  await assert.rejects(s.run({ prompt: '测试' }), /API Key 无效或已过期（HTTP 401）/);
  const empty = setup({ ...OPENAI, responses: [json(200, { data: [] })] });
  await assert.rejects(empty.run({ prompt: '测试' }), /图片服务没有返回图片/);
});

// ───────────────────────── 状态与测试出图 ─────────────────────────
test('ai:status：带出图状态，界面据此显示「画面由谁生成」', async () => {
  const none = (await setup({ ai: { provider: 'local' } }).handlers['ai:status']()).image;
  assert.equal(none.provider, 'none');
  assert.equal(none.ready, false);
  assert.equal(none.want, 'auto');
  assert.match(none.detail, /^还没有可用的出图服务/);
  assert.deepEqual([none.hasArk, none.hasOpenai], [false, false]);

  const ark = (await setup({ ai: { provider: 'local' }, ...{ secrets: ARK.secrets } }).handlers['ai:status']()).image;
  assert.deepEqual({ provider: ark.provider, ready: ark.ready, model: ark.model, hasArk: ark.hasArk }, { provider: 'ark', ready: true, model: 'doubao-seedream-4-0-250828', hasArk: true });
  assert.match(ark.detail, /即梦（Seedream）/);
  assert.ok(!JSON.stringify(ark).includes('ark-test-key'), '状态里不带 Key');

  const oa = (await setup({ ai: { provider: 'local', ...OPENAI.ai }, secrets: OPENAI.secrets }).handlers['ai:status']()).image;
  assert.deepEqual({ provider: oa.provider, model: oa.model, hasOpenai: oa.hasOpenai }, { provider: 'openai', model: 'gpt-image-1', hasOpenai: true });

  const wrong = (await setup({ ai: { provider: 'local', imageProvider: 'ark', ...OPENAI.ai }, secrets: OPENAI.secrets }).handlers['ai:status']()).image;
  assert.deepEqual({ want: wrong.want, provider: wrong.provider, ready: wrong.ready }, { want: 'ark', provider: 'none', ready: false });
});

test('ai:imageTest：试生成一张图，成功给预览、失败给原因，都不抛错', async () => {
  const ok = setup({ ...ARK, responses: [arkOk(), image(fakeJpeg(2560, 1440))] });
  const r = await ok.handlers['ai:imageTest']({});
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'ark');
  assert.match(r.detail, /^即梦出图正常（doubao-seedream-4-0-250828，2560×1440，耗时 [\d.]+ 秒）$/);
  assert.ok(fs.existsSync(r.path));
  assert.ok(r.path.startsWith(path.join(ok.root, 'tmp', 'ai-image-test')));
  assert.equal(ok.started.length, 0, '测试出图不占任务面板');
  assert.equal(ok.calls[0].body.size, '2560x1440');

  const bad = setup({ ...ARK, responses: [arkErr(404, 'ModelNotOpen', 'not activated')] });
  const f = await bad.handlers['ai:imageTest']({ provider: 'ark' });
  assert.equal(f.ok, false);
  assert.equal(f.code, 'IMAGE_SETUP');
  assert.equal(f.provider, 'ark');
  assert.match(f.detail, /开通管理/);

  const none = await setup({}).handlers['ai:imageTest']();
  assert.deepEqual({ ok: none.ok, code: none.code, provider: none.provider }, { ok: false, code: 'NO_IMAGE_AI', provider: 'none' });
  assert.match(none.detail, /^还没有可用的出图服务/);
});
