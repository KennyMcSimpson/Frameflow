// frameflow-mcp：薄 stdio MCP Server 真实进程 JSON-RPC 2.0 端到端单测。
// 覆盖 ndjson 与 Content-Length 双协议帧、全部 6 个工具、--readonly 只读门禁、UNC 拒绝与 stdin 关闭干净退出。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OP_TYPES } from '../src/engine/ops.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const MCP_PATH = path.join(ROOT, 'bin', 'frameflow-mcp.mjs');

const tmpDirs = [];
function makeTmpDir(prefix = 'ff-mcp-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  tmpDirs.length = 0;
});

/**
 * 启动真实 `node bin/frameflow-mcp.mjs` 子进程并提供双模式（ndjson / content-length）JSON-RPC 客户端。
 */
function startMcpServer({ args = [], framing = 'ndjson' } = {}) {
  const child = spawn(process.execPath, [MCP_PATH, ...args], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' },
  });

  let stdoutBuf = Buffer.alloc(0);
  let stderrText = '';
  const pending = new Map();
  let nextId = 1;
  let exitInfo = null;
  const exitPromise = new Promise((resolve) => {
    child.on('close', (code, signal) => {
      exitInfo = { code, signal };
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`MCP 进程提前退出 (code=${code}, signal=${signal})\nstderr=${stderrText}`));
      }
      pending.clear();
      resolve(exitInfo);
    });
  });

  function dispatchMessage(msg) {
    if (msg && Object.prototype.hasOwnProperty.call(msg, 'id') && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      entry.resolve(msg);
    }
  }

  function drainStdout() {
    while (stdoutBuf.length > 0) {
      if (framing === 'content-length') {
        const sep = stdoutBuf.indexOf('\r\n\r\n');
        if (sep === -1) break;
        const header = stdoutBuf.subarray(0, sep).toString('ascii');
        const m = /^content-length\s*:\s*(\d+)$/im.exec(header);
        assert.ok(m, `收到非法的 Content-Length 响应头: ${header}`);
        const len = Number.parseInt(m[1], 10);
        const end = sep + 4 + len;
        if (stdoutBuf.length < end) break;
        const body = stdoutBuf.subarray(sep + 4, end).toString('utf8');
        stdoutBuf = stdoutBuf.subarray(end);
        dispatchMessage(JSON.parse(body));
      } else {
        const nl = stdoutBuf.indexOf(0x0a);
        if (nl === -1) break;
        const line = stdoutBuf.subarray(0, nl).toString('utf8').trim();
        stdoutBuf = stdoutBuf.subarray(nl + 1);
        if (line) dispatchMessage(JSON.parse(line));
      }
    }
  }

  child.stdout.on('data', (chunk) => {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stdoutBuf = stdoutBuf.length === 0 ? part : Buffer.concat([stdoutBuf, part]);
    drainStdout();
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (s) => { stderrText += s; });

  function writeMessage(obj) {
    const body = JSON.stringify(obj);
    if (framing === 'content-length') {
      const bytes = Buffer.byteLength(body, 'utf8');
      child.stdin.write(`Content-Length: ${bytes}\r\n\r\n${body}`);
    } else {
      child.stdin.write(`${body}\n`);
    }
  }

  function request(method, params, timeoutMs = 15000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`RPC 超时: ${method} (id=${id})\nstderr=${stderrText}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      const msg = { jsonrpc: '2.0', id, method };
      if (params !== undefined) msg.params = params;
      writeMessage(msg);
    });
  }

  function notify(method, params) {
    const msg = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    writeMessage(msg);
  }

  async function callTool(name, toolArgs = {}) {
    const res = await request('tools/call', { name, arguments: toolArgs });
    assert.equal(res.error, undefined, `tools/call ${name} 不应返回协议级 error: ${JSON.stringify(res.error)}`);
    assert.ok(res.result && Array.isArray(res.result.content) && res.result.content.length > 0);
    const payload = JSON.parse(res.result.content[0].text);
    return { isError: Boolean(res.result.isError), payload, raw: res };
  }

  async function closeAndWait(timeoutMs = 5000) {
    if (!exitInfo) {
      try { child.stdin.end(); } catch {}
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    try {
      return await exitPromise;
    } finally {
      clearTimeout(timer);
    }
  }

  return { child, request, notify, callTool, closeAndWait, getStderr: () => stderrText };
}

test('MCP stdio（ndjson）：initialize、tools/list（6 工具）、全工具链与 stdin 关闭干净退出 0', async () => {
  const dir = makeTmpDir('ff-mcp-ndjson-');
  const projPath = path.join(dir, 'mcp-demo.ffproj');
  const bakPath = path.join(dir, 'mcp-demo.bak.ffproj');
  const srtPath = path.join(dir, 'mcp-out.srt');
  const client = startMcpServer({ framing: 'ndjson' });

  try {
    // 1. initialize & notifications/initialized
    const init = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'frameflow-test', version: '1.0.0' },
    });
    assert.equal(init.jsonrpc, '2.0');
    assert.equal(init.error, undefined);
    assert.equal(init.result.protocolVersion, '2024-11-05');
    assert.equal(init.result.serverInfo.name, 'frameflow');

    client.notify('notifications/initialized');
    const pong = await client.request('ping');
    assert.deepEqual(pong.result, {});

    // 2. tools/list 验证全部 6 个工具
    const list = await client.request('tools/list');
    assert.equal(list.error, undefined);
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'frameflow_apply_ops',
      'frameflow_export_srt',
      'frameflow_inspect',
      'frameflow_ops_schema',
      'frameflow_stock_search',
      'frameflow_storyboard',
    ]);

    // 3. frameflow_ops_schema
    const schemaRes = await client.callTool('frameflow_ops_schema', {});
    assert.equal(schemaRes.isError, false);
    assert.equal(schemaRes.payload.ok, true);
    assert.equal(schemaRes.payload.opCount, OP_TYPES.length);
    assert.deepEqual(schemaRes.payload.opTypes, OP_TYPES);

    // 4. frameflow_storyboard（不存在则自动创建 + firstCut）
    const sbRes = await client.callTool('frameflow_storyboard', {
      filePath: projPath,
      brief: '30s warm specialty coffee shop promo',
      duration: 30,
      aspect: '16:9',
      firstCut: true,
      agent: 'mcp-test',
    });
    assert.equal(sbRes.isError, false);
    assert.equal(sbRes.payload.ok, true);
    assert.equal(sbRes.payload.created, true);
    assert.ok(sbRes.payload.shotCount >= 3);
    assert.ok(sbRes.payload.clipCount >= 3);
    assert.ok(sbRes.payload.duration > 0);
    assert.ok(fs.existsSync(projPath));

    // 5. frameflow_inspect
    const insRes = await client.callTool('frameflow_inspect', { filePath: projPath });
    assert.equal(insRes.isError, false);
    assert.equal(insRes.payload.ok, true);
    assert.ok(insRes.payload.duration > 0);
    assert.equal(insRes.payload.clips.length, sbRes.payload.clipCount);
    assert.equal(typeof insRes.payload.summary, 'string');
    assert.ok(insRes.payload.summary.length > 10);

    // 6. frameflow_apply_ops（dryRun: true 不改文件；dryRun: false 写盘 + .bak + meta.lastAgentEdit）
    const beforeRaw = fs.readFileSync(projPath, 'utf8');
    const ops = [
      { type: 'setLook', target: { mode: 'index', indices: [1] }, look: 'film-warm', lookStrength: 0.75 },
      {
        type: 'addCaptions',
        preset: 'subtitle',
        segments: [
          { start: 0, end: 2.2, text: 'Morning espresso ritual' },
          { start: 2.4, end: 4.8, text: 'Handcrafted in small batches' },
        ],
      },
    ];
    const dryRes = await client.callTool('frameflow_apply_ops', {
      filePath: projPath,
      ops,
      dryRun: true,
    });
    assert.equal(dryRes.isError, false);
    assert.equal(dryRes.payload.ok, true);
    assert.equal(dryRes.payload.dryRun, true);
    assert.ok(dryRes.payload.diff && dryRes.payload.diff.empty === false);
    assert.equal(fs.readFileSync(projPath, 'utf8'), beforeRaw, 'dryRun 不得修改原文件');
    assert.equal(fs.existsSync(bakPath), false);

    const applyRes = await client.callTool('frameflow_apply_ops', {
      filePath: projPath,
      ops,
      dryRun: false,
      agent: 'mcp-worker-9',
      label: 'Warm first clip and add captions',
    });
    assert.equal(applyRes.isError, false);
    assert.equal(applyRes.payload.ok, true);
    assert.equal(applyRes.payload.dryRun, false);
    assert.equal(applyRes.payload.backupPath, bakPath);
    assert.ok(fs.existsSync(bakPath));
    const diskProj = JSON.parse(fs.readFileSync(projPath, 'utf8'));
    assert.equal(diskProj.tracks.video[0].color.look, 'film-warm');
    assert.equal(diskProj.meta.lastAgentEdit.agent, 'mcp-worker-9');
    assert.equal(diskProj.meta.lastAgentEdit.source, 'mcp');

    // 破坏性编辑未带 allowDestructive 应被安全闸门拦截
    const destructRes = await client.callTool('frameflow_apply_ops', {
      filePath: projPath,
      ops: [{ type: 'delete', target: { mode: 'index', indices: [1, 2, 3] } }],
      dryRun: false,
    });
    assert.equal(destructRes.isError, true);
    assert.equal(destructRes.payload.code, 'CONFIRM_REQUIRED');

    // UNC 路径应被拒绝
    const uncRes = await client.callTool('frameflow_inspect', {
      filePath: '\\\\attacker.invalid\\share\\evil.ffproj',
    });
    assert.equal(uncRes.isError, true);
    assert.match(uncRes.payload.error, /UNC/i);

    // 7. frameflow_export_srt（内存返回 + 写出到文件）
    const srtRes = await client.callTool('frameflow_export_srt', {
      filePath: projPath,
      outPath: srtPath,
    });
    assert.equal(srtRes.isError, false);
    assert.equal(srtRes.payload.ok, true);
    assert.ok(srtRes.payload.cueCount >= 2);
    assert.match(srtRes.payload.srt, /\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/);
    assert.ok(srtRes.payload.srt.includes('Morning espresso ritual'));
    assert.equal(fs.readFileSync(srtPath, 'utf8'), srtRes.payload.srt);

    // 8. 关闭 stdin → 进程以退出码 0 干净结束
    const exit = await client.closeAndWait();
    assert.equal(exit.code, 0, `期望退出码 0，实际 ${exit.code} (stderr=${client.getStderr()})`);
  } finally {
    await client.closeAndWait().catch(() => {});
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('MCP stdio（Content-Length 帧）：支持 LSP/MCP 字节长度头并干净退出 0', async () => {
  const client = startMcpServer({ framing: 'content-length' });
  try {
    const init = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'cl-client', version: '1.0.0' },
    });
    assert.equal(init.result.serverInfo.name, 'frameflow');

    const schemaRes = await client.callTool('frameflow_ops_schema', {});
    assert.equal(schemaRes.isError, false);
    assert.equal(schemaRes.payload.opCount, OP_TYPES.length);

    const exit = await client.closeAndWait();
    assert.equal(exit.code, 0);
  } finally {
    await client.closeAndWait().catch(() => {});
  }
});

test('MCP --readonly：隐藏写工具、拒绝 frameflow_apply_ops 与 frameflow_storyboard，允许只读读取', async () => {
  const dir = makeTmpDir('ff-mcp-ro-');
  const projPath = path.join(dir, 'ro.ffproj');
  fs.writeFileSync(projPath, JSON.stringify({
    version: 3,
    id: 'prj_ro',
    name: 'ReadOnlyProject',
    settings: { aspect: '16:9', width: 1920, height: 1080, fps: 30, background: '#000000' },
    assets: {},
    tracks: {
      video: [],
      text: [
        { id: 'txt_1', start: 0, duration: 2, text: 'Hello readonly', preset: 'subtitle', group: 'caption' },
      ],
      audio: [],
    },
    overlays: [],
    markers: [],
    storyboard: [],
  }), 'utf8');

  const client = startMcpServer({ args: ['--readonly'], framing: 'ndjson' });
  try {
    const init = await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    assert.equal(init.result.serverInfo.name, 'frameflow');

    const list = await client.request('tools/list');
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'frameflow_export_srt',
      'frameflow_inspect',
      'frameflow_ops_schema',
      'frameflow_stock_search',
    ]);
    assert.ok(!names.includes('frameflow_apply_ops'));
    assert.ok(!names.includes('frameflow_storyboard'));

    // 强制调用 frameflow_apply_ops 必须被拒绝
    const applyRes = await client.callTool('frameflow_apply_ops', {
      filePath: projPath,
      ops: [{ type: 'addMarker', t: 1, label: 'ShouldFail' }],
    });
    assert.equal(applyRes.isError, true);
    assert.equal(applyRes.payload.ok, false);
    assert.equal(applyRes.payload.code, 'READONLY_MODE');

    // 强制调用 frameflow_storyboard 必须被拒绝
    const sbRes = await client.callTool('frameflow_storyboard', {
      filePath: projPath,
      brief: 'blocked in readonly',
    });
    assert.equal(sbRes.isError, true);
    assert.equal(sbRes.payload.code, 'READONLY_MODE');

    // frameflow_export_srt 带 outPath 在只读模式下被拒绝，不带 outPath 允许内存返回
    const srtWriteRes = await client.callTool('frameflow_export_srt', {
      filePath: projPath,
      outPath: path.join(dir, 'should-not-exist.srt'),
    });
    assert.equal(srtWriteRes.isError, true);
    assert.equal(srtWriteRes.payload.code, 'READONLY_MODE');
    assert.equal(fs.existsSync(path.join(dir, 'should-not-exist.srt')), false);

    const srtMemRes = await client.callTool('frameflow_export_srt', { filePath: projPath });
    assert.equal(srtMemRes.isError, false);
    assert.equal(srtMemRes.payload.cueCount, 1);
    assert.ok(srtMemRes.payload.srt.includes('Hello readonly'));

    const exit = await client.closeAndWait();
    assert.equal(exit.code, 0);
  } finally {
    await client.closeAndWait().catch(() => {});
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('MCP stdio（Content-Length）：单次写入流水线混用 \\n\\n 与 \\r\\n\\r\\n 帧头且准确处理多字节 UTF-8 中文长度（RT1 P1-7）', async () => {
  const dir = makeTmpDir('ff-mcp-cl-edge-');
  const projPath = path.join(dir, 'cn-demo.ffproj');
  const client = startMcpServer({ framing: 'content-length' });

  try {
    // 1) 在一次 stdin.write 中连续发送 \n\n 与 \r\n\r\n 两种头结束符的 Content-Length 帧
    const req1 = JSON.stringify({
      jsonrpc: '2.0',
      id: 101,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pipe-test', version: '1.0.0' } },
    });
    const req2 = JSON.stringify({ jsonrpc: '2.0', id: 102, method: 'ping' });

    const frame1 = Buffer.from(`Content-Length: ${Buffer.byteLength(req1, 'utf8')}\n\n${req1}`, 'utf8');
    const frame2 = Buffer.from(`Content-Length: ${Buffer.byteLength(req2, 'utf8')}\r\n\r\n${req2}`, 'utf8');

    const received = new Map();
    const waitPair = new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const timer = setTimeout(() => reject(new Error('流水线双帧响应超时')), 10000);
      const onData = (chunk) => {
        buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        while (buf.length > 0) {
          const sep = buf.indexOf('\r\n\r\n');
          if (sep === -1) break;
          const m = /^content-length\s*:\s*(\d+)$/im.exec(buf.subarray(0, sep).toString('ascii'));
          if (!m) { clearTimeout(timer); reject(new Error('无效响应头')); return; }
          const len = Number.parseInt(m[1], 10);
          if (buf.length < sep + 4 + len) break;
          const msg = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString('utf8'));
          buf = buf.subarray(sep + 4 + len);
          received.set(msg.id, msg);
          if (received.has(101) && received.has(102)) {
            clearTimeout(timer);
            client.child.stdout.off('data', onData);
            resolve();
            return;
          }
        }
      };
      client.child.stdout.on('data', onData);
    });

    client.child.stdin.write(Buffer.concat([frame1, frame2]));
    await waitPair;
    assert.equal(received.get(101).result.serverInfo.name, 'frameflow');
    assert.deepEqual(received.get(102).result, {});

    // 2) 多字节 UTF-8 中文载荷（字节长度远大于字符串 .length）：验证 Content-Length 按字节精准切帧与中文往返完整
    const chineseBrief = '三十秒清晨精品手冲咖啡馆暖调电影感短片，镜头温柔推进呈现蒸汽与拉花细节';
    assert.ok(Buffer.byteLength(chineseBrief, 'utf8') > chineseBrief.length);
    const sbRes = await client.callTool('frameflow_storyboard', {
      filePath: projPath,
      brief: chineseBrief,
      duration: 20,
      aspect: '16:9',
      firstCut: true,
      agent: '中文测试代理',
    });
    assert.equal(sbRes.isError, false);
    assert.equal(sbRes.payload.ok, true);
    assert.equal(sbRes.payload.lastAgentEdit.agent, '中文测试代理');

    const cnMarker = '清晨第一缕阳光切入点';
    const applyRes = await client.callTool('frameflow_apply_ops', {
      filePath: projPath,
      ops: [{ type: 'addMarker', t: 1.2, label: cnMarker }],
      label: '添加中文节拍标记',
    });
    assert.equal(applyRes.isError, false);
    assert.equal(applyRes.payload.ok, true);

    const insRes = await client.callTool('frameflow_inspect', { filePath: projPath });
    assert.equal(insRes.isError, false);
    assert.ok(insRes.payload.markers.some((m) => m.label === cnMarker), '多字节 UTF-8 中文内容应完整保留');

    const exit = await client.closeAndWait();
    assert.equal(exit.code, 0);
  } finally {
    await client.closeAndWait().catch(() => {});
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('MCP 安全加固：悬空符号链接/目录联接失败关闭拒绝（RT1 P1-2），超 16 MB 无换行 NDJSON 拒绝并退出 1', async () => {
  const dir = makeTmpDir('ff-mcp-sec-');
  const linkDir = path.join(dir, 'dangling-mcp-link');

  // 1) 悬空目录联接（Windows junction 免管理员权限 / POSIX dir symlink）
  const targetDir = path.join(dir, 'removed-target');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.symlinkSync(targetDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
  fs.rmSync(targetDir, { recursive: true, force: true });

  const client = startMcpServer({ framing: 'ndjson' });
  try {
    await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });

    const insDangling = await client.callTool('frameflow_inspect', {
      filePath: path.join(linkDir, 'ghost.ffproj'),
    });
    assert.equal(insDangling.isError, true);
    assert.equal(insDangling.payload.ok, false);
    assert.match(insDangling.payload.error, /UNSAFE_PATH|dangling|symlink/i);

    const sbDangling = await client.callTool('frameflow_storyboard', {
      filePath: path.join(linkDir, 'ghost.ffproj'),
      brief: 'should be blocked',
    });
    assert.equal(sbDangling.isError, true);
    assert.equal(sbDangling.payload.ok, false);
    assert.match(sbDangling.payload.error, /UNSAFE_PATH|dangling|symlink/i);

    const exit = await client.closeAndWait();
    assert.equal(exit.code, 0);
  } finally {
    await client.closeAndWait().catch(() => {});
    try { fs.unlinkSync(linkDir); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  // 2) 超 16 MB 无换行 NDJSON 流：立即返回 -32700 错误并以非零码 1 退出（复用 1 MiB 缓冲块控制内存与耗时）
  const floodChild = spawn(process.execPath, [MCP_PATH], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' },
  });
  let outText = '';
  let exited = false;
  const exitP = new Promise((resolve) => {
    floodChild.on('close', (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });
  floodChild.stdout.setEncoding('utf8');
  floodChild.stdout.on('data', (s) => { outText += s; });
  floodChild.stdin.on('error', () => {});

  const killTimer = setTimeout(() => { try { floodChild.kill('SIGKILL'); } catch {} }, 15000);
  try {
    const oneMb = Buffer.alloc(1024 * 1024, 0x78); // 'x'，无换行符
    const headChunk = Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":1,"pad":"', 'utf8'), oneMb.subarray(31)]);
    for (let i = 0; i < 18 && !exited && !floodChild.stdin.destroyed; i += 1) {
      const buf = i === 0 ? headChunk : oneMb;
      let ok = false;
      try { ok = floodChild.stdin.write(buf); } catch { break; }
      if (!ok) {
        await Promise.race([
          new Promise((resolve) => floodChild.stdin.once('drain', resolve)),
          exitP,
        ]);
      }
    }
    if (!exited) {
      try { floodChild.stdin.end(); } catch {}
    }
    const res = await exitP;
    assert.equal(res.code, 1, `超限无换行 NDJSON 应退出 1，实际 code=${res.code}`);
    const errLine = outText.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    assert.ok(errLine, '超限无换行 NDJSON 应输出 JSON-RPC 错误帧');
    const parsed = JSON.parse(errLine);
    assert.equal(parsed.error.code, -32700);
    assert.match(parsed.error.message, /too large/i);
  } finally {
    clearTimeout(killTimer);
    if (!exited) {
      try { floodChild.kill('SIGKILL'); } catch {}
      await exitP;
    }
  }
});
