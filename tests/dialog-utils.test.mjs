// 对话框与快捷键纯工具单元测试：exportDialogUtils / settingsDialogUtils / versionHistoryUtils / customKeys。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLATFORM_PRESET_IDS, estimateExportBytes, fmtApproxSize, splitOutPath,
  fmtEta, fmtElapsed, groupRestricted, shortList, hasBlockingIssue,
} from '../src/ui/dialogs/exportDialogUtils.js';
import {
  VG_IDS, ovOf, toDraft, validate, toPatch, mergeVgProviders, applyArkKey,
  describeImageSource, arkTroubleshoot, stockTestResult, keyReady, providerReady,
  cliStatusOf, applyApiPreset,
} from '../src/ui/dialogs/settingsDialogUtils.js';
import {
  fmtAgo, fmtSnapshotTime, normalizeSnapshots, isMissingHandler, groupSnapshotsByDay,
} from '../src/ui/dialogs/versionHistoryUtils.js';
import {
  LOCAL_KEY, overridesFromSettings, applyShortcutSettings, saveShortcutOverrides, resetAllShortcuts,
} from '../src/ui/shortcuts/customKeys.js';
import { getShortcutOverrides, setShortcutOverrides, shortcutById } from '../src/ui/shortcuts/registry.js';
import api from '../src/ui/api.js';
import useStore from '../src/ui/store.js';

const origLocalStorage = globalThis.localStorage;
const origApiCall = api.call;

function makeMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => { map.clear(); },
  };
}

after(() => {
  setShortcutOverrides({});
  api.call = origApiCall;
  if (origLocalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = origLocalStorage;
});

// ───────────────────────── exportDialogUtils.js ─────────────────────────

test('exportDialogUtils：体积估算、路径拆分、时间格式化与预检分组', () => {
  assert.deepEqual(PLATFORM_PRESET_IDS, ['douyin', 'bilibili', 'shipinhao', 'youtube4k']);
  assert.equal(estimateExportBytes({ duration: 0 }), 0);
  assert.equal(estimateExportBytes({ duration: -5 }), 0);
  assert.equal(estimateExportBytes({ duration: 10, format: 'wav' }), 10 * 48000 * 4 + 44);
  assert.equal(estimateExportBytes({ duration: 10, format: 'mp3', bitrate: 128 }), Math.round((10 * 128 * 1000) / 8));
  assert.equal(estimateExportBytes({ duration: 10, audioOnly: true, bitrate: 999 }), Math.round((10 * 320 * 1000) / 8));
  assert.ok(estimateExportBytes({ duration: 5, w: 480, h: 270, fps: 15, format: 'gif' }) > 0);
  const hi = estimateExportBytes({ duration: 30, w: 1920, h: 1080, fps: 30, quality: 'high' });
  const std = estimateExportBytes({ duration: 30, w: 1920, h: 1080, fps: 30, quality: 'standard' });
  const sm = estimateExportBytes({ duration: 30, w: 1920, h: 1080, fps: 30, quality: 'small' });
  assert.ok(hi > std && std > sm);
  assert.equal(estimateExportBytes({ duration: 8, bitrate: 10000 }), Math.round((8 * (10000 + 192) * 1000) / 8));

  assert.equal(fmtApproxSize(0), '');
  assert.equal(fmtApproxSize(2048), '约 2 KB');
  assert.equal(fmtApproxSize(2.5 * 1024 * 1024), '约 2.5 MB');
  assert.equal(fmtApproxSize(25 * 1024 * 1024), '约 25 MB');
  assert.equal(fmtApproxSize(1.5 * 1024 ** 3), '约 1.5 GB');

  assert.deepEqual(splitOutPath('C:\\Videos\\out.mp4'), { dir: 'C:\\Videos', file: 'out.mp4' });
  assert.deepEqual(splitOutPath('/tmp/out.mp4'), { dir: '/tmp', file: 'out.mp4' });
  assert.deepEqual(splitOutPath('out.mp4'), { dir: '', file: 'out.mp4' });

  assert.equal(fmtEta(10, 'encode'), '即将完成');
  assert.equal(fmtEta(NaN), '计算中…');
  assert.equal(fmtEta(0.4), '不到 1 秒');
  assert.equal(fmtEta(45), '45 秒');
  assert.equal(fmtEta(125), '2 分 5 秒');
  assert.equal(fmtEta(3665), '1 小时 1 分');
  assert.equal(fmtElapsed(-1), '—');
  assert.equal(fmtElapsed(12), '12 秒');

  const g = groupRestricted([
    { assetId: 'a1', title: '片段1', reason: '非商用', level: 'warn' },
    { assetId: 'a1', title: '片段1', reason: '禁止商用', level: 'block' },
    { assetId: 'a2', title: '片段2', reason: '需署名', level: 'warn' },
    null,
  ]);
  assert.equal(g.block.length, 1);
  assert.equal(g.block[0].assetId, 'a1');
  assert.equal(g.warn.length, 1);
  assert.equal(g.warn[0].assetId, 'a2');

  assert.equal(shortList([]), '');
  assert.equal(shortList(['甲', '乙']), '「甲」、「乙」');
  assert.equal(shortList(['甲', '乙', '丙', '丁'], 2), '「甲」、「乙」 等 4 个');
  assert.equal(hasBlockingIssue([{ level: 'warn' }, { level: 'danger' }]), true);
  assert.equal(hasBlockingIssue([{ level: 'warn' }]), false);
});

// ───────────────────────── settingsDialogUtils.js ─────────────────────────

test('settingsDialogUtils：草稿校验、补丁转换、服务商合并与排错指引', () => {
  const draft = toDraft({
    ai: { provider: 'openai', openaiBaseUrl: 'https://api.example.com/v1/', imageProvider: 'ark', imageModels: { ark: 'm1' } },
    web: { maxDownloadSeconds: 120 },
    editing: { imageDuration: 4, transitionDuration: 0.5 },
    videogen: { provider: 'mock', overrides: { seedance: { baseUrl: 'https://ark.example.com/', model: 'ep-1' } } },
  });
  assert.equal(draft.provider, 'openai');
  assert.equal(draft.arkKey, '');
  assert.deepEqual(ovOf(draft, 'seedance'), { baseUrl: 'https://ark.example.com/', model: 'ep-1' });
  assert.equal(validate(draft), null);

  // 各类非法草稿路由到对应 tab
  assert.equal(validate({ ...draft, openaiBaseUrl: 'ftp://bad' }).tab, 'ai');
  assert.equal(validate({ ...draft, vgOverrides: { seedance: { baseUrl: 'not-url', model: '' } } }).tab, 'videogen');
  assert.equal(validate({ ...draft, openaiKey: 'sk bad key' }).tab, 'ai');
  assert.equal(validate({ ...draft, pexelsKey: 'pk\n123' }).tab, 'media');
  assert.equal(validate({ ...draft, arkKey: 'ark key' }).tab, 'videogen');
  assert.equal(validate({ ...draft, maxDownloadSeconds: 5 }).tab, 'media');
  assert.equal(validate({ ...draft, edImageDuration: 99 }).tab, 'editing');
  assert.equal(validate({ ...draft, edTransitionDuration: 9 }).tab, 'editing');

  // toPatch 去掉末尾斜杠并处理清除密钥
  const patch = toPatch({ ...draft, arkKey: 'ark-123' }, { openaiKey: true, klingAk: true });
  assert.equal(patch.ai.openaiBaseUrl, 'https://api.example.com/v1');
  assert.equal(patch.videogen.overrides.seedance.baseUrl, 'https://ark.example.com');
  assert.equal(patch.videogen.keys.arkKey, 'ark-123');
  assert.equal(patch.videogen.keys.klingAk, '');
  assert.equal(patch.openaiKey, '');

  // mergeVgProviders：seedance 第一且推荐，额外上报项在 mock 前，mock 最后
  const merged = mergeVgProviders([{ id: 'jimeng-visual', label: '即梦视觉', configured: true }]);
  assert.equal(merged[0].id, 'seedance');
  assert.equal(merged[0].recommended, true);
  assert.equal(merged[merged.length - 1].id, 'mock');
  assert.equal(merged[merged.length - 2].id, 'jimeng-visual');
  assert.equal(VG_IDS[0], 'seedance');

  // applyArkKey：演示模式自动切到即梦；已选别家保持不变
  assert.equal(applyArkKey({ vgProvider: 'mock', arkKey: '' }, 'ark-k').vgProvider, 'seedance');
  assert.equal(applyArkKey({ vgProvider: 'kling', arkKey: '' }, 'ark-k').vgProvider, 'kling');

  // describeImageSource
  assert.equal(describeImageSource({ imageProvider: 'auto', hasArk: true }).source, 'ark');
  assert.equal(describeImageSource({ imageProvider: 'auto', hasOpenai: true }).source, 'openai');
  assert.equal(describeImageSource({ imageProvider: 'auto' }).warn, true);
  assert.equal(describeImageSource({ imageProvider: 'ark', hasArk: false }).warn, true);
  assert.match(describeImageSource({ imageProvider: 'openai', hasOpenaiKey: true, hasOpenai: false }).text, /图片模型/);

  // arkTroubleshoot
  assert.deepEqual(arkTroubleshoot(''), []);
  assert.ok(arkTroubleshoot('NO_KEY')[0].includes('API Key'));
  assert.ok(arkTroubleshoot('HTTP 401 Unauthorized')[0].includes('API Key'));
  assert.ok(arkTroubleshoot('HTTP 404 InvalidEndpointOrModel')[0].includes('模型名'));
  assert.ok(arkTroubleshoot('HTTP 402 余额不足，请到开通管理调整')[0].includes('余额'));
  assert.ok(arkTroubleshoot('HTTP 429 rate limit')[0].includes('繁忙'));
  assert.ok(arkTroubleshoot('fetch failed ECONNREFUSED')[0].includes('网络'));
  assert.ok(arkTroubleshoot('ModelNotOpen 未开通')[0].includes('开通'));
  // 日期 250528 不应误判为 5xx
  assert.ok(!arkTroubleshoot('doubao-seedance-1-0-pro-250528 未知异常')[0].includes('繁忙'));

  // stockTestResult / keyReady / providerReady
  assert.equal(stockTestResult({ results: [{ id: 1 }] }, 'pexels').ok, true);
  assert.deepEqual(stockTestResult({ results: [], errors: [{ source: 'pexels', error: 'Key 无效' }] }, 'pexels'), { ok: false, error: 'Key 无效' });
  assert.match(stockTestResult({ results: [] }, 'commons', { needsKey: false }).error, /网络/);
  assert.equal(keyReady({ arkKey: '' }, { arkKey: true }, 'arkKey', true), false);
  assert.equal(keyReady({ arkKey: 'new' }, { arkKey: true }, 'arkKey', false), true);
  const seedance = merged[0];
  assert.equal(providerReady(seedance, { hasKey: (k) => k === 'arkKey' }), true);
  assert.equal(providerReady(merged[merged.length - 1], {}), false);
});

test('settingsDialogUtils：cliStatusOf 兼容真实 ai:status.clis 与 app:info.agentClis；applyApiPreset 支持 provider=api；toPatch 同步清理 anthropicKey', () => {
  // 1) 真实 ai:status 载荷（{ clis: { claude, codex, gemini } }）：三家 CLI 均非空解析
  const aiStatusPayload = {
    provider: 'openai',
    ready: true,
    clis: {
      claude: { id: 'claude', ok: true, path: '/usr/local/bin/claude', version: '1.0.24', loggedIn: true },
      codex: { id: 'codex', ok: true, path: '/usr/local/bin/codex', version: '0.99.0', loggedIn: true },
      gemini: { id: 'gemini', ok: true, path: '/usr/local/bin/gemini', version: '0.5.1', loggedIn: true },
    },
    codex: { ok: true, path: '/usr/local/bin/codex', version: '0.99.0', loggedIn: true },
  };
  for (const id of ['claude', 'codex', 'gemini']) {
    const info = cliStatusOf(id, aiStatusPayload, null);
    assert.ok(info, `ai:status 载荷下 cliStatusOf('${id}') 不应为 null`);
    assert.equal(info.ok, true);
    assert.equal(info.id, id);
  }

  // 2) 真实 app:info 载荷（{ agentClis: { claude, codex, gemini } }）：三家 CLI 均非空解析
  const appInfoPayload = {
    agentClis: {
      claude: { id: 'claude', ok: true, path: '/opt/bin/claude', version: '1.1.0', loggedIn: true },
      codex: { id: 'codex', ok: false, path: null, version: null, loggedIn: false },
      gemini: { id: 'gemini', ok: true, path: '/opt/bin/gemini', version: '0.6.0', loggedIn: true },
    },
  };
  for (const id of ['claude', 'codex', 'gemini']) {
    const info = cliStatusOf(id, null, appInfoPayload);
    assert.ok(info, `app:info 载荷下 cliStatusOf('${id}') 不应为 null`);
    assert.equal(info.id, id);
  }
  assert.equal(cliStatusOf('claude', null, appInfoPayload).version, '1.1.0');
  assert.equal(cliStatusOf('gemini', null, appInfoPayload).version, '0.6.0');
  assert.equal(cliStatusOf('codex', null, appInfoPayload).ok, false);

  // 3) aiStatus.clis 未探测时（ok: false），优先回退到 appInfo.agentClis 中已探测到的条目（RT2 P1-2）
  const unprobedAiStatus = {
    clis: {
      claude: { id: 'claude', ok: false, path: null, version: null, loggedIn: false },
      codex: { id: 'codex', ok: false, path: null, version: null, loggedIn: false },
      gemini: { id: 'gemini', ok: false, path: null, version: null, loggedIn: false },
    },
  };
  assert.equal(cliStatusOf('claude', unprobedAiStatus, appInfoPayload).ok, true);
  assert.equal(cliStatusOf('gemini', unprobedAiStatus, appInfoPayload).ok, true);
  assert.equal(cliStatusOf('', unprobedAiStatus, appInfoPayload), null);

  // 4) applyApiPreset 当 provider === 'api' 时同步更新 provider 与 apiProtocol（RT2 P3-3）
  const baseDraft = toDraft({ ai: { provider: 'api', apiProtocol: 'openai', openaiBaseUrl: 'https://api.openai.com/v1' } });
  const toAnthropic = applyApiPreset(baseDraft, 'anthropic');
  assert.equal(toAnthropic.provider, 'anthropic');
  assert.equal(toAnthropic.apiProtocol, 'anthropic');
  assert.equal(toAnthropic.apiPreset, 'anthropic');
  assert.equal(toAnthropic.openaiBaseUrl, 'https://api.anthropic.com/v1');

  const toDeepseek = applyApiPreset({ ...baseDraft, provider: 'api', apiProtocol: 'anthropic' }, 'deepseek');
  assert.equal(toDeepseek.provider, 'openai');
  assert.equal(toDeepseek.apiProtocol, 'openai');
  assert.equal(toDeepseek.apiPreset, 'deepseek');

  // 非 API 模式（auto）下应用预设不强改 provider
  const autoPreset = applyApiPreset(toDraft({ ai: { provider: 'auto' } }), 'anthropic');
  assert.equal(autoPreset.provider, 'auto');
  assert.equal(autoPreset.apiProtocol, 'anthropic');

  // 5) toPatch 清理 anthropicKey：清除 openaiKey 或在 anthropic 协议下录入新 Key 时同步清空旧 anthropicKey（RT2 P3-2）
  const patchClearOpenai = toPatch(baseDraft, { openaiKey: true });
  assert.equal(patchClearOpenai.openaiKey, '');
  assert.equal(patchClearOpenai.anthropicKey, '');

  const patchNewAnthropicKey = toPatch({ ...baseDraft, apiProtocol: 'anthropic', openaiKey: 'sk-ant-fresh-123' }, {});
  assert.equal(patchNewAnthropicKey.openaiKey, 'sk-ant-fresh-123');
  assert.equal(patchNewAnthropicKey.anthropicKey, '');

  const patchClearAnthropic = toPatch(baseDraft, { anthropicKey: true });
  assert.equal(patchClearAnthropic.anthropicKey, '');

  const patchNewOpenaiKey = toPatch({ ...baseDraft, apiProtocol: 'openai', openaiKey: 'sk-openai-fresh-456' }, {});
  assert.equal(patchNewOpenaiKey.openaiKey, 'sk-openai-fresh-456');
  assert.equal('anthropicKey' in patchNewOpenaiKey, false, 'openai 协议录入新 Key 时不应误清 anthropicKey');
});

// ───────────────────────── versionHistoryUtils.js ─────────────────────────

test('versionHistoryUtils：相对时间、快照格式化、排序与按天分组', () => {
  const now = new Date(2026, 10, 20, 15, 30, 0).getTime();
  assert.equal(fmtAgo(NaN, now), '');
  assert.equal(fmtAgo(now - 20 * 1000, now), '刚刚');
  assert.equal(fmtAgo(now - 5 * 60 * 1000, now), '5 分钟前');
  assert.equal(fmtAgo(now - 3 * 3600 * 1000, now), '3 小时前');
  assert.equal(fmtAgo(now - 4 * 86400 * 1000, now), '4 天前');
  assert.equal(fmtAgo(now - 40 * 86400 * 1000, now), '');

  assert.deepEqual(fmtSnapshotTime('', now), { main: '时间未知', rel: '' });
  const todayIso = new Date(2026, 10, 20, 14, 5, 0).toISOString();
  const yestIso = new Date(2026, 10, 19, 9, 10, 0).toISOString();
  const earlierYearIso = new Date(2026, 9, 3, 20, 15, 0).toISOString();
  const lastYearIso = new Date(2025, 9, 3, 20, 15, 0).toISOString();
  assert.equal(fmtSnapshotTime(todayIso, now).main, '今天 14:05');
  assert.equal(fmtSnapshotTime(yestIso, now).main, '昨天 09:10');
  assert.equal(fmtSnapshotTime(earlierYearIso, now).main, '10月3日 20:15');
  assert.equal(fmtSnapshotTime(lastYearIso, now).main, '2025年10月3日 20:15');

  const norm = normalizeSnapshots([
    { snapshotId: 'old', createdAt: yestIso, size: 100, clipCount: 2, duration: 8 },
    null,
    { createdAt: todayIso },
    { snapshotId: 'new', createdAt: todayIso, size: -5, clipCount: 3.6, duration: 'bad' },
  ]);
  assert.deepEqual(norm.map((s) => s.snapshotId), ['new', 'old']);
  assert.equal(norm[0].size, 0);
  assert.equal(norm[0].clipCount, 4);
  assert.equal(norm[0].duration, null);

  assert.equal(isMissingHandler(new Error("No handler registered for 'project:snapshots'")), true);
  assert.equal(isMissingHandler(new Error('未知的 IPC 通道')), true);
  assert.equal(isMissingHandler(new Error('磁盘已满')), false);

  const grouped = groupSnapshotsByDay([
    { snapshotId: '1', createdAt: todayIso },
    { snapshotId: '2', createdAt: new Date(2026, 10, 20, 10, 0, 0).toISOString() },
    { snapshotId: '3', createdAt: yestIso },
  ], now);
  assert.deepEqual(grouped.map((g) => [g.label, g.items.length]), [['今天', 2], ['昨天', 1]]);
});

// ───────────────────────── customKeys.js ─────────────────────────

test('customKeys：设置优先于本机缓存、保存发 null 墓碑并支持离线回退与重置', async () => {
  const ls = makeMemoryStorage();
  globalThis.localStorage = ls;
  setShortcutOverrides({});
  useStore.setState({ settings: { shortcuts: { overrides: {} } } });

  try {
    // 1. 设置里没有时回退 localStorage
    ls.setItem(LOCAL_KEY, JSON.stringify({ playPause: ['KeyP'] }));
    assert.deepEqual(overridesFromSettings(null), { playPause: ['KeyP'] });
    // 设置里有非空有效覆盖时以设置为准
    assert.deepEqual(overridesFromSettings({ shortcuts: { overrides: { playPause: ['KeyF'] } } }), { playPause: ['KeyF'] });

    // 2. applyShortcutSettings 应用覆盖并检测冲突
    const conflicts = applyShortcutSettings({ shortcuts: { overrides: { playPause: ['KeyJ'] } } });
    assert.ok(conflicts.some((c) => c.combo === 'KeyJ' && c.ids.includes('playPause') && c.ids.includes('shuttleBack')));
    assert.deepEqual(shortcutById('playPause').keys, ['KeyJ']);

    // 3. saveShortcutOverrides 写入设置、同步 localStorage、去掉旧键发 null 墓碑
    const calls = [];
    api.call = async (ch, payload) => { calls.push({ ch, payload }); return { ok: true }; };
    const r1 = await saveShortcutOverrides({ split: ['Ctrl+KeyK'] });
    assert.deepEqual(r1, { ok: true, settings: true, local: true });
    assert.equal(calls[0].ch, 'settings:set');
    assert.deepEqual(calls[0].payload.shortcuts.overrides, { split: ['Ctrl+KeyK'], playPause: null });
    assert.deepEqual(JSON.parse(ls.getItem(LOCAL_KEY)), { split: ['Ctrl+KeyK'] });
    assert.deepEqual(getShortcutOverrides(), { split: ['Ctrl+KeyK'] });

    // 4. 设置写入失败时仍保留本机缓存，ok=true
    api.call = async () => { throw new Error('ipc down'); };
    const r2 = await resetAllShortcuts();
    assert.deepEqual(r2, { ok: true, settings: false, local: true });
    assert.equal(ls.getItem(LOCAL_KEY), null);
    assert.deepEqual(getShortcutOverrides(), {});
  } finally {
    setShortcutOverrides({});
    api.call = origApiCall;
    if (origLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = origLocalStorage;
  }
});
