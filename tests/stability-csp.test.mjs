// stability：内容安全策略（P0-8.2）——发行版 CSP 足够严格；开发服务器只在开发时补上热更新地址。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');

function cspOf(text) {
  const m = text.match(/<meta[^>]*http-equiv="Content-Security-Policy"[^>]*content="([^"]+)"/i);
  return m ? m[1] : '';
}
function directives(csp) {
  const out = new Map();
  for (const part of csp.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out.set(name, values);
  }
  return out;
}

test('发行版 CSP：脚本只来自本地文件，不连外网、不嵌页面、不跑 eval', () => {
  const csp = cspOf(html);
  assert.ok(csp, 'index.html 里要有 CSP');
  const d = directives(csp);
  assert.deepEqual(d.get('default-src'), ["'self'"]);
  assert.deepEqual(d.get('script-src'), ["'self'"]);
  assert.deepEqual(d.get('object-src'), ["'none'"]);
  assert.deepEqual(d.get('base-uri'), ["'none'"]);
  assert.deepEqual(d.get('frame-src'), ["'none'"]);
  assert.deepEqual(d.get('form-action'), ["'none'"]);
  assert.deepEqual(d.get('connect-src'), ["'self'", 'ffmedia:']);
  assert.ok(!/unsafe-eval|localhost|\*/.test(csp));
  assert.ok(d.get('media-src').includes('ffmedia:') && d.get('media-src').includes('blob:'));
  assert.ok(d.get('img-src').includes('ffmedia:') && d.get('img-src').includes('data:'));
  assert.ok(d.get('worker-src').includes('blob:'));
  // CSP 必须在任何脚本之前
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script'));
});

test('开发服务器给 CSP 补上热更新地址，打包时原样不动', async () => {
  const { default: config } = await import(pathToFileURL(path.join(ROOT, 'vite.config.mjs')).href);
  const plugin = config.plugins.flat(Infinity).find((p) => p && p.name === 'frameflow-dev-csp');
  assert.ok(plugin, '缺少 frameflow-dev-csp 插件');
  const { handler, order } = plugin.transformIndexHtml;
  assert.equal(order, 'pre');
  assert.equal(handler(html, {}), html, '打包时不应改 CSP');
  assert.equal(handler(html, undefined), html);
  const dev = handler(html, { server: {} });
  const d = directives(cspOf(dev));
  assert.deepEqual(d.get('connect-src'), ["'self'", 'ffmedia:', `ws://localhost:${config.server.port}`, `http://localhost:${config.server.port}`]);
  assert.deepEqual(d.get('script-src'), ["'self'"], '开发时也不放开脚本来源');
  // 只改 CSP 那一处，注释里的文字不受影响
  assert.equal(dev.replace(/ ws:\/\/localhost:\d+ http:\/\/localhost:\d+/, ''), html);
  assert.equal(config.server.port, 5199);
  assert.equal(config.server.strictPort, true);
});
