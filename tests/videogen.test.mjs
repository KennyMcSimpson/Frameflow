import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const vg = require('../electron/lib/videogen/index.cjs');
const util = require('../electron/lib/videogen/util.cjs');

/** 假 fetch：routes = [[method, urlRegex, responder(body, url, init) -> {status, json|text}]] */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const method = init.method || 'GET';
    let body = init.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
    calls.push({ url, method, headers: init.headers || {}, body });
    const r = routes.find(([m, re]) => m === method && re.test(url));
    if (!r) return new Response(JSON.stringify({ error: { message: 'no route ' + url } }), { status: 404 });
    const out = await r[2](body, url, init);
    const status = out.status || 200;
    if (out.bytes) return new Response(out.bytes, { status, headers: { 'content-length': String(out.bytes.length) } });
    return new Response(out.text !== undefined ? out.text : JSON.stringify(out.json || {}), { status });
  };
  fn.calls = calls;
  return fn;
}

const fastPoll = { interval: 1, maxInterval: 2, timeout: 5000 };
const run = (id, input, cfg, fetch, extra = {}) => vg.runTask(vg.getProvider(id), input, cfg, { fetch, ...extra }, { pollOpts: fastPoll });

test('registry 包含 9 家且接口完整', () => {
  assert.deepEqual(vg.PROVIDERS.map((p) => p.id), ['seedance', 'kling', 'minimax', 'runway', 'veo', 'sora', 'luma', 'fal', 'mock']);
  for (const p of vg.PROVIDERS) {
    for (const k of ['id', 'label', 'needs', 'caps', 'submit', 'poll', 'fetchResult', 'test']) assert.ok(p[k] !== undefined, `${p.id}.${k}`);
  }
});

test('resolveConfig / describe：密钥、覆盖、Sora 回退 openaiKey', () => {
  const secrets = { arkKey: 'ark', openaiKey: 'sk-1', klingAk: 'a' };
  const settings = { get: () => ({ videogen: { overrides: { seedance: { model: 'my-model', baseUrl: 'https://x' } } } }), getSecret: (k) => secrets[k] || '' };
  assert.deepEqual(vg.resolveConfig(settings, 'seedance'), { baseUrl: 'https://x', model: 'my-model', key: 'ark' });
  assert.equal(vg.resolveConfig(settings, 'sora').key, 'sk-1');
  const d = Object.fromEntries(vg.describe(settings).map((x) => [x.id, x.configured]));
  assert.equal(d.seedance, true); assert.equal(d.sora, true); assert.equal(d.kling, false); assert.equal(d.mock, true); assert.equal(d.runway, false);
});

test('jwtHS256 可被独立校验，可灵 token 字段正确', () => {
  const tok = vg.getProvider('kling').token({ ak: 'AK1', sk: 'SK1' }, 1000);
  const [h, p, s] = tok.split('.');
  const exp = crypto.createHmac('sha256', 'SK1').update(`${h}.${p}`).digest('base64url');
  assert.equal(s, exp);
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'HS256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url')), { iss: 'AK1', exp: 2800, nbf: 995 });
  assert.throws(() => vg.getProvider('kling').token({ ak: 'x' }), /SecretKey/);
});

test('pollUntil：指数退避、超时、取消', async () => {
  const waits = [];
  let t = 0;
  const r = await util.pollUntil(async (i) => (i === 4 ? 'ok' : null), { sleepFn: async (ms) => { waits.push(ms); t += ms; }, now: () => t });
  assert.equal(r, 'ok');
  assert.deepEqual(waits, [5000, 7500, 11250, 15000]);

  t = 0;
  await assert.rejects(util.pollUntil(async () => null, { timeout: 60000, sleepFn: async (ms) => { t += ms; }, now: () => t }), (e) => e.code === 'TIMEOUT');

  const ac = new AbortController();
  const p = util.pollUntil(async () => null, { interval: 10000, signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, (e) => e.code === 'CANCELLED');
});

test('seedance：Bearer、--ratio 参数、图生视频、成功解析', async () => {
  let n = 0;
  const f = fakeFetch([
    ['POST', /contents\/generations\/tasks$/, () => ({ json: { id: 'cgt-1' } })],
    ['GET', /tasks\/cgt-1$/, () => (++n < 2 ? { json: { status: 'running' } } : { json: { status: 'succeeded', content: { video_url: 'https://v/1.mp4' } } })],
  ]);
  const r = await run('seedance', { prompt: '海边奔跑的女孩', ratio: '9:16', duration: 7, image: 'data:image/png;base64,AAA' }, { key: 'K', model: 'm-x' }, f);
  assert.equal(r.taskId, 'cgt-1');
  assert.equal(r.result.url, 'https://v/1.mp4');
  const sub = f.calls[0];
  assert.equal(sub.headers.Authorization, 'Bearer K');
  assert.equal(sub.body.model, 'm-x');
  assert.match(sub.body.content[0].text, /--ratio 9:16 --duration 5/);
  assert.equal(sub.body.content[1].image_url.url, 'data:image/png;base64,AAA');
  assert.match(vg.getProvider('seedance').parseStatus({ status: 'failed', error: { message: '敏感' } }).error, /敏感.*被服务商拦截/);
});

test('kling：t2v/i2v 路由、去掉 data 前缀、succeed 解析与 code 错误', async () => {
  const f = fakeFetch([
    ['POST', /\/v1\/videos\/image2video$/, () => ({ json: { code: 0, data: { task_id: 'T9', task_status: 'submitted' } } })],
    ['GET', /\/v1\/videos\/image2video\/T9$/, () => ({ json: { code: 0, data: { task_status: 'succeed', task_result: { videos: [{ url: 'https://k/v.mp4' }] } } } })],
  ]);
  const r = await run('kling', { prompt: 'x', image: 'data:image/jpeg;base64,QUJD' }, { ak: 'a', sk: 's' }, f);
  assert.equal(r.taskId, 'image2video:T9');
  assert.equal(r.result.url, 'https://k/v.mp4');
  assert.equal(f.calls[0].body.image, 'QUJD');
  assert.match(f.calls[0].headers.Authorization, /^Bearer ey/);
  assert.throws(() => vg.getProvider('kling').parseStatus({ code: 1102, message: '余额不足' }), /余额不足/);
  assert.equal(vg.getProvider('kling').parseStatus({ code: 0, data: { task_status: 'failed', task_status_msg: '违规' } }).error, '违规');
});

test('minimax：三步取 file 下载地址', async () => {
  const f = fakeFetch([
    ['POST', /\/v1\/video_generation$/, () => ({ json: { task_id: 'M1', base_resp: { status_code: 0 } } })],
    ['GET', /query\/video_generation\?task_id=M1/, () => ({ json: { status: 'Success', file_id: 'F7', base_resp: { status_code: 0 } } })],
    ['GET', /files\/retrieve\?file_id=F7/, () => ({ json: { file: { download_url: 'https://mm/f.mp4' }, base_resp: { status_code: 0 } } })],
  ]);
  const r = await run('minimax', { prompt: 'x', duration: 9, res: '1080p' }, { key: 'K' }, f);
  assert.equal(r.result.url, 'https://mm/f.mp4');
  assert.equal(f.calls[0].body.duration, 10);
  assert.equal(f.calls[0].body.resolution, '1080P');
  assert.throws(() => vg.getProvider('minimax').parseStatus({ base_resp: { status_code: 1004, status_msg: 'auth' } }), /auth/);
});

test('runway：版本头、ratio 映射、失败抛错', async () => {
  const f = fakeFetch([
    ['POST', /\/v1\/image_to_video$/, () => ({ json: { id: 'R1' } })],
    ['GET', /\/v1\/tasks\/R1$/, () => ({ json: { status: 'FAILED', failure: '内容审核未通过' } })],
  ]);
  await assert.rejects(run('runway', { prompt: 'x', image: 'data:image/png;base64,AA', ratio: '9:16' }, { key: 'K' }, f), /内容审核未通过/);
  assert.equal(f.calls[0].headers['X-Runway-Version'], '2024-11-06');
  assert.equal(f.calls[0].body.ratio, '720:1280');
  assert.equal(f.calls[0].body.model, 'gen4_turbo');
  const ok = vg.getProvider('runway').parseStatus({ status: 'SUCCEEDED', output: ['https://r/o.mp4'] });
  assert.equal(ok.url, 'https://r/o.mp4');
  assert.equal(vg.getProvider('runway').parseStatus({ status: 'THROTTLED' }).state, 'queued');
});

test('veo：predictLongRunning、operation 轮询、同源下载带 key 头且跨域不泄 key', async () => {
  const sameOriginUrl = 'https://generativelanguage.googleapis.com/v1beta/files/v?alt=media';
  const f = fakeFetch([
    ['POST', /models\/veo-3\.1-fast-generate-preview:predictLongRunning$/, () => ({ json: { name: 'models/veo/operations/op1' } })],
    ['GET', /operations\/op1$/, () => ({ json: { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: sameOriginUrl } }] } } } })],
  ]);
  const r = await run('veo', { prompt: 'x', image: 'data:image/png;base64,QQ==', negative: '卡通' }, { key: 'G' }, f);
  assert.equal(r.result.url, sameOriginUrl);
  assert.equal(r.result.headers['x-goog-api-key'], 'G');
  // 跨域结果 URL 不得附带 x-goog-api-key，防止密钥外泄
  const fCross = fakeFetch([
    ['POST', /models\/veo-3\.1-fast-generate-preview:predictLongRunning$/, () => ({ json: { name: 'models/veo/operations/op2' } })],
    ['GET', /operations\/op2$/, () => ({ json: { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://cdn.example.com/v.mp4' } }] } } } })],
  ]);
  const rCross = await run('veo', { prompt: 'x' }, { key: 'G' }, fCross);
  assert.equal(rCross.result.url, 'https://cdn.example.com/v.mp4');
  assert.equal(rCross.result.headers, undefined);
  assert.deepEqual(f.calls[0].body.instances[0].image, { bytesBase64Encoded: 'QQ==', mimeType: 'image/png' });
  assert.equal(f.calls[0].body.parameters.negativePrompt, '卡通');
  assert.equal(vg.getProvider('veo').parseStatus({ done: false }).state, 'running');
  assert.match(vg.getProvider('veo').parseStatus({ done: true, response: { generateVideoResponse: { raiMediaFilteredReasons: ['人物'] } } }).error, /安全策略/);
});

test('sora：/v1/videos、seconds 字符串、content 下载地址', async () => {
  const f = fakeFetch([
    ['POST', /\/v1\/videos$/, () => ({ json: { id: 'video_1', status: 'queued' } })],
    ['GET', /\/v1\/videos\/video_1$/, () => ({ json: { status: 'completed', progress: 100 } })],
  ]);
  const r = await run('sora', { prompt: 'x', duration: 10, ratio: '9:16' }, { key: 'S' }, f);
  assert.equal(f.calls[0].body.seconds, '8');
  assert.equal(f.calls[0].body.size, '720x1280');
  assert.equal(r.result.url, 'https://api.openai.com/v1/videos/video_1/content');
  assert.equal(r.result.headers.Authorization, 'Bearer S');
  assert.equal(vg.getProvider('sora').parseStatus({ status: 'in_progress', progress: 40 }).progress, 0.4);
});

test('luma：dreaming→completed，data URL 参考图被忽略', async () => {
  let n = 0;
  const f = fakeFetch([
    ['POST', /\/generations$/, () => ({ json: { id: 'L1', state: 'queued' } })],
    ['GET', /\/generations\/L1$/, () => (++n < 2 ? { json: { state: 'dreaming' } } : { json: { state: 'completed', assets: { video: 'https://l/v.mp4' } } })],
  ]);
  const r = await run('luma', { prompt: 'x', duration: 8, image: 'data:image/png;base64,AA' }, { key: 'L' }, f);
  assert.equal(r.result.url, 'https://l/v.mp4');
  assert.equal(f.calls[0].body.duration, '9s');
  assert.equal(f.calls[0].body.keyframes, undefined);
});

test('fal：队列 status_url/response_url，模型可覆盖', async () => {
  const f = fakeFetch([
    ['POST', /queue\.fal\.run\/fal-ai\/minimax\/video-01$/, () => ({ json: { request_id: 'q1', status_url: 'https://queue.fal.run/fal-ai/minimax/requests/q1/status', response_url: 'https://queue.fal.run/fal-ai/minimax/requests/q1' } })],
    ['GET', /requests\/q1\/status$/, () => ({ json: { status: 'COMPLETED' } })],
    ['GET', /requests\/q1$/, () => ({ json: { video: { url: 'https://fal/v.mp4' } } })],
  ]);
  const r = await run('fal', { prompt: 'x' }, { key: 'F', model: 'fal-ai/minimax/video-01' }, f);
  assert.equal(r.result.url, 'https://fal/v.mp4');
  assert.equal(f.calls[0].headers.Authorization, 'Key F');
  assert.deepEqual(vg.getProvider('fal').decodeTask(r.taskId).id, 'q1');
});

test('HTTP 401 归一化为中文“密钥无效”', async () => {
  const f = fakeFetch([['GET', /models/, () => ({ status: 401, json: { error: { message: 'Incorrect API key' } } })]]);
  await assert.rejects(vg.getProvider('sora').test({ key: 'bad' }, { fetch: f }), (e) => e.code === 'AUTH' && /密钥无效/.test(e.message));
});

test('未配置密钥 / 取消时调用 provider.cancel', async () => {
  await assert.rejects(run('runway', { prompt: 'x' }, {}, fakeFetch([])), (e) => e.code === 'NO_KEY');
  let cancelled = false;
  const f = fakeFetch([
    ['POST', /\/generations$/, () => ({ json: { id: 'L2' } })],
    ['GET', /\/generations\/L2$/, () => ({ json: { state: 'queued' } })],
    ['DELETE', /\/generations\/L2$/, () => { cancelled = true; return { json: {} }; }],
  ]);
  const ac = new AbortController();
  const p = vg.runTask(vg.getProvider('luma'), { prompt: 'x' }, { key: 'L' }, { fetch: f, signal: ac.signal }, { pollOpts: { interval: 50, maxInterval: 50 } });
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(p, (e) => e.code === 'CANCELLED');
  assert.equal(cancelled, true);
});

test('mock 全流程 + downloadTo + 并发闸门', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-'));
  const sample = path.join(dir, 'sample.mp4');
  fs.writeFileSync(sample, Buffer.from('fake-mp4'));
  const states = [];
  const r = await vg.runTask(vg.getProvider('mock'), { prompt: '城市夜景' }, {}, { mockSource: async () => sample, mockPolls: 3 }, { pollOpts: fastPoll, onStatus: (s) => states.push(s.state) });
  assert.deepEqual(states, ['queued', 'running', 'succeeded']);
  assert.equal(r.result.localPath, sample);

  const f = fakeFetch([['GET', /dl/, () => ({ bytes: Buffer.from('0123456789') })]]);
  const out = await util.downloadTo(f, 'https://x/dl', path.join(dir, 'sub', 'a.mp4'));
  assert.equal(fs.readFileSync(out, 'utf8'), '0123456789');

  const lim = vg.createLimiter(2);
  let peak = 0, cur = 0, waited = 0;
  const task = () => lim.run('p', async () => { cur++; peak = Math.max(peak, cur); await util.sleep(10); cur--; }, () => waited++);
  await Promise.all([task(), task(), task(), task(), task()]);
  assert.equal(peak, 2); assert.equal(waited, 3); assert.equal(lim.active('p'), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('imageToDataUrl 与 clampDur', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-'));
  const f = path.join(dir, 'a.png');
  fs.writeFileSync(f, Buffer.from([1, 2, 3]));
  assert.equal(util.imageToDataUrl(f), 'data:image/png;base64,AQID');
  assert.throws(() => util.imageToDataUrl(path.join(dir, 'a.txt')), /参考图/);
  assert.equal(util.clampDur(7, [5, 10]), 5);
  assert.equal(util.clampDur(8, [5, 10]), 10);
  fs.rmSync(dir, { recursive: true, force: true });
});
