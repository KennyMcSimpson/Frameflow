// frameflow-cli：无头 CLI 全流程端到端单测（真实子进程 `node bin/frameflow.mjs`）。
// 纯离线、确定性、全部文件落在 os.tmpdir() 并在 finally / after 中彻底清理。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OP_TYPES } from '../src/engine/ops.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(ROOT, 'bin', 'frameflow.mjs');

const tmpDirs = [];
function makeTmpDir(prefix = 'ff-cli-') {
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

function runCliProc(args, { cwd = ROOT, input } = {}) {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  assert.equal(res.error, undefined, `子进程启动失败: ${res.error && res.error.message}`);
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

function parseJsonStdout(res, context = '') {
  try {
    return JSON.parse(res.stdout);
  } catch (err) {
    assert.fail(`${context} stdout 不是合法 JSON: ${err.message}\nstdout=${res.stdout}\nstderr=${res.stderr}`);
  }
}

test('CLI doctor --json：退出码 0，包含 node / ffmpeg / engine 检查项', () => {
  const res = runCliProc(['doctor', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const data = parseJsonStdout(res, 'doctor');
  assert.equal(data.ok, true);
  assert.equal(data.command, 'doctor');
  assert.ok(data.checks && typeof data.checks === 'object');
  assert.equal(data.checks.node.ok, true);
  assert.ok(typeof data.checks.node.version === 'string' && data.checks.node.version.length > 0);
  assert.ok('ffmpeg' in data.checks && typeof data.checks.ffmpeg.ok === 'boolean');
  assert.equal(data.checks.engine.ok, true);
  assert.equal(data.checks.engine.opCount, OP_TYPES.length);
});

test('CLI ops-schema --json：退出码 0 并完整列出全部 OP_TYPES', () => {
  const res = runCliProc(['ops-schema', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const data = parseJsonStdout(res, 'ops-schema');
  assert.equal(data.ok, true);
  assert.equal(data.command, 'ops-schema');
  assert.equal(data.count, OP_TYPES.length);
  assert.deepEqual(data.opTypes, OP_TYPES);
  assert.ok(data.categories && typeof data.categories === 'object');
  assert.ok(data.enums && Array.isArray(data.enums.looks) && data.enums.looks.length > 0);
});

test('CLI 完整工作流：init → 拒覆写 → storyboard --first-cut → inspect → apply (dry-run / 实写 / 破坏性门禁) → export-srt → export-plan', () => {
  const dir = makeTmpDir('ff-cli-flow-');
  try {
    const projPath = path.join(dir, 'demo.ffproj');
    const bakPath = path.join(dir, 'demo.bak.ffproj');
    const srtPath = path.join(dir, 'out.srt');

    // 1. init 创建有效 .ffproj
    const initRes = runCliProc(['init', projPath, '--name', 'Demo', '--aspect', '16:9', '--json'], { cwd: dir });
    assert.equal(initRes.status, 0, initRes.stderr);
    const initData = parseJsonStdout(initRes, 'init');
    assert.equal(initData.ok, true);
    assert.equal(initData.project.name, 'Demo');
    assert.equal(initData.project.settings.aspect, '16:9');
    assert.ok(fs.existsSync(projPath));
    const initFile = JSON.parse(fs.readFileSync(projPath, 'utf8'));
    assert.equal(initFile.name, 'Demo');
    assert.equal(initFile.settings.width, 1920);
    assert.equal(initFile.settings.height, 1080);

    // 不带 --force 重复 init 必须退出 2 且不覆盖
    const dupRes = runCliProc(['init', projPath, '--name', 'OverwriteAttempt', '--json'], { cwd: dir });
    assert.equal(dupRes.status, 2);
    const dupData = parseJsonStdout(dupRes, 'init duplicate');
    assert.equal(dupData.ok, false);
    assert.equal(dupData.code, 'FILE_EXISTS');
    assert.equal(JSON.parse(fs.readFileSync(projPath, 'utf8')).name, 'Demo');

    // 带 --force 允许覆写
    const forceRes = runCliProc(['init', projPath, '--name', 'Demo', '--aspect', '16:9', '--force', '--json'], { cwd: dir });
    assert.equal(forceRes.status, 0, forceRes.stderr);
    assert.equal(parseJsonStdout(forceRes, 'init --force').overwritten, true);

    // 2. storyboard --first-cut 填充镜头分镜与主轨时间线
    const sbRes = runCliProc([
      'storyboard', projPath,
      '--brief', '30s coffee shop promo',
      '--first-cut',
      '--agent', 'test-agent',
      '--json',
    ], { cwd: dir });
    assert.equal(sbRes.status, 0, sbRes.stderr);
    const sbData = parseJsonStdout(sbRes, 'storyboard');
    assert.equal(sbData.ok, true);
    assert.ok(sbData.shotCount >= 3, `应生成多条分镜，实际 ${sbData.shotCount}`);
    assert.equal(sbData.firstCut.ran, true);
    assert.ok(sbData.firstCut.clipCount >= 3, `初剪应填充视频轨，实际 ${sbData.firstCut.clipCount}`);
    assert.ok(sbData.firstCut.duration > 0);

    // 3. inspect 返回 duration > 0、clips 数组与紧凑 summary
    const insRes = runCliProc(['inspect', projPath, '--json'], { cwd: dir });
    assert.equal(insRes.status, 0, insRes.stderr);
    const insData = parseJsonStdout(insRes, 'inspect');
    assert.equal(insData.ok, true);
    assert.ok(insData.duration > 0);
    assert.ok(Array.isArray(insData.clips) && insData.clips.length === sbData.firstCut.clipCount);
    assert.equal(typeof insData.summary, 'string');
    assert.ok(insData.summary.length > 10);

    // 4. apply --dry-run 返回 diff 且不修改磁盘文件与已有备份
    assert.equal(fs.existsSync(bakPath), true, 'storyboard 更新既有 .ffproj 后应已建立 .bak.ffproj 备份');
    const beforeDryRaw = fs.readFileSync(projPath, 'utf8');
    const beforeDryBakRaw = fs.readFileSync(bakPath, 'utf8');
    const safeOps = [
      { type: 'setLook', target: { mode: 'index', indices: [1] }, look: 'cinematic', lookStrength: 0.85 },
      {
        type: 'addCaptions',
        preset: 'subtitle',
        segments: [
          { start: 0, end: 2.5, text: 'Fresh espresso poured at dawn' },
          { start: 2.6, end: 5.0, text: 'Warm aroma fills the room' },
        ],
      },
    ];
    const dryRes = runCliProc([
      'apply', projPath,
      '--ops-json', JSON.stringify(safeOps),
      '--dry-run',
      '--json',
    ], { cwd: dir });
    assert.equal(dryRes.status, 0, dryRes.stderr);
    const dryData = parseJsonStdout(dryRes, 'apply --dry-run');
    assert.equal(dryData.ok, true);
    assert.equal(dryData.dryRun, true);
    assert.equal(dryData.written, false);
    assert.equal(dryData.backupPath, null);
    assert.ok(dryData.diff && dryData.diff.empty === false);
    assert.ok(Array.isArray(dryData.diffSummary) && dryData.diffSummary.length > 0);
    assert.equal(fs.readFileSync(projPath, 'utf8'), beforeDryRaw, 'dry-run 不应修改原文件');
    assert.equal(fs.readFileSync(bakPath, 'utf8'), beforeDryBakRaw, 'dry-run 必须保持已有 .bak.ffproj 字节级不变');

    // 5. 正式 apply：落盘、生成 .bak.ffproj、打上 meta.lastAgentEdit
    const applyRes = runCliProc([
      'apply', projPath,
      '--ops-json', JSON.stringify(safeOps),
      '--agent', 'worker-9-cli',
      '--label', 'Grade first shot and add captions',
      '--json',
    ], { cwd: dir });
    assert.equal(applyRes.status, 0, applyRes.stderr);
    const applyData = parseJsonStdout(applyRes, 'apply');
    assert.equal(applyData.ok, true);
    assert.equal(applyData.dryRun, false);
    assert.equal(applyData.written, true);
    assert.equal(applyData.backupPath, bakPath);
    assert.ok(fs.existsSync(bakPath), '正式 apply 必须生成 .bak.ffproj 备份');
    assert.equal(fs.readFileSync(bakPath, 'utf8'), beforeDryRaw, '备份内容应与改前一致');

    const afterProj = JSON.parse(fs.readFileSync(projPath, 'utf8'));
    assert.equal(afterProj.tracks.video[0].color.look, 'cinematic');
    assert.ok(afterProj.meta && afterProj.meta.lastAgentEdit, '必须写入 meta.lastAgentEdit');
    assert.equal(afterProj.meta.lastAgentEdit.agent, 'worker-9-cli');
    assert.equal(afterProj.meta.lastAgentEdit.label, 'Grade first shot and add captions');
    assert.ok(typeof afterProj.meta.lastAgentEdit.at === 'string' && afterProj.meta.lastAgentEdit.at.length > 0);

    // 6. 破坏性操作未传 --allow-destructive 必须退出 2 且不改动文件
    const beforeDestructRaw = fs.readFileSync(projPath, 'utf8');
    const destructiveOps = [{ type: 'delete', target: { mode: 'index', indices: [1, 2, 3] } }];
    const blockedRes = runCliProc([
      'apply', projPath,
      '--ops-json', JSON.stringify(destructiveOps),
      '--json',
    ], { cwd: dir });
    assert.equal(blockedRes.status, 2);
    const blockedData = parseJsonStdout(blockedRes, 'apply destructive blocked');
    assert.equal(blockedData.ok, false);
    assert.equal(blockedData.code, 'CONFIRM_REQUIRED');
    assert.equal(blockedData.needsConfirm, true);
    assert.ok(Array.isArray(blockedData.confirmReasons) && blockedData.confirmReasons.length > 0);
    assert.ok(Array.isArray(blockedData.reasons) && blockedData.reasons.length > 0);
    assert.deepEqual(blockedData.reasons, blockedData.confirmReasons);
    assert.equal(fs.readFileSync(projPath, 'utf8'), beforeDestructRaw, '被拦下的破坏性操作绝不能改写磁盘');

    // 7. export-srt 写出合法 SRT 文件
    const srtRes = runCliProc(['export-srt', projPath, '--out', srtPath, '--json'], { cwd: dir });
    assert.equal(srtRes.status, 0, srtRes.stderr);
    const srtData = parseJsonStdout(srtRes, 'export-srt');
    assert.equal(srtData.ok, true);
    assert.equal(srtData.outPath, srtPath);
    assert.ok(srtData.cueCount >= 2);
    assert.ok(fs.existsSync(srtPath));
    const srtText = fs.readFileSync(srtPath, 'utf8');
    assert.match(srtText, /\d+\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/);
    assert.ok(srtText.includes('Fresh espresso poured at dawn'));

    // 8. export-plan 返回 preset 与 audioPlan
    const planRes = runCliProc(['export-plan', projPath, '--preset', 'douyin', '--json'], { cwd: dir });
    assert.equal(planRes.status, 0, planRes.stderr);
    const planData = parseJsonStdout(planRes, 'export-plan');
    assert.equal(planData.ok, true);
    assert.ok(planData.preset && planData.preset.presetId === 'douyin');
    assert.equal(planData.preset.format, 'mp4');
    assert.ok(planData.preset.w > 0 && planData.preset.h > 0);
    assert.ok(planData.audioPlan && Array.isArray(planData.audioPlan.segments));
    assert.ok(typeof planData.audioPlan.duration === 'number' && planData.audioPlan.duration > 0);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('CLI 安全护栏：UNC 路径与混用斜杠 UNC 均退出码 2', () => {
  const uncPaths = [
    '\\\\attacker.invalid\\share\\x.ffproj',
    '//attacker.invalid/share/x.ffproj',
    '\\/attacker.invalid\\share\\x.ffproj',
    '/\\attacker.invalid\\share\\x.ffproj',
  ];
  for (const bad of uncPaths) {
    for (const args of [
      ['inspect', bad, '--json'],
      ['init', bad, '--json'],
      ['export-plan', bad, '--json'],
    ]) {
      const res = runCliProc(args);
      assert.equal(res.status, 2, `期望退出码 2 (${args.join(' ')})，实际 ${res.status}`);
      const data = parseJsonStdout(res, `UNC ${args[0]}`);
      assert.equal(data.ok, false);
      assert.equal(data.code, 'UNC_PATH');
    }
  }
});

test('CLI 安全闸门：封堵全部 needsConfirm 绕过（mode:ids 全片转场、harmonize+setLook 混批、2 镜 setLook、解锁已锁定轨道）与空 ops', () => {
  const dir = makeTmpDir('ff-cli-gates-');
  try {
    // 构造 3 镜含色彩统计且锁定文字轨的工程，验证各类绕过均退出 2 (CONFIRM_REQUIRED)
    const proj3Path = path.join(dir, 'three.ffproj');
    const makeAsset = (id, luma, warmth) => ({
      id,
      kind: 'video',
      name: `${id}.mp4`,
      path: path.join(dir, `${id}.mp4`),
      duration: 10,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: false,
      stats: { luma, contrast: 0.45, saturation: 0.5, warmth },
    });
    const makeClip = (id, assetId) => ({
      id,
      assetId,
      in: 0,
      out: 4,
      speed: 1,
      label: id,
      color: { look: 'none', lookStrength: 1, exposure: 0, contrast: 0, saturation: 0, temperature: 0, vignette: 0 },
      transitionIn: { type: 'cut', duration: 0.5 },
    });
    const proj3 = {
      version: 3,
      id: 'prj_gate3',
      name: 'Gate3',
      settings: { aspect: '16:9', width: 1920, height: 1080, fps: 30, background: '#000000' },
      assets: {
        a1: makeAsset('a1', 0.25, -0.35),
        a2: makeAsset('a2', 0.78, 0.35),
        a3: makeAsset('a3', 0.52, 0.05),
      },
      tracks: {
        video: [makeClip('c1', 'a1'), makeClip('c2', 'a2'), makeClip('c3', 'a3')],
        text: [],
        audio: [],
      },
      trackState: {
        video: { muted: false, locked: false, hidden: false },
        text: { muted: false, locked: true, hidden: false },
        audio: { muted: false, locked: false, hidden: false },
      },
      overlays: [],
      markers: [],
      storyboard: [],
    };
    const raw3 = JSON.stringify(proj3, null, 2);
    fs.writeFileSync(proj3Path, raw3, 'utf8');

    // 1) mode:'ids' 指定全片做 setTransition
    const idsTransRes = runCliProc([
      'apply', proj3Path,
      '--ops-json', JSON.stringify([{ type: 'setTransition', target: { mode: 'ids', ids: ['c1', 'c2', 'c3'] }, transition: { type: 'crossfade', duration: 0.4 } }]),
      '--json',
    ], { cwd: dir });
    assert.equal(idsTransRes.status, 2, idsTransRes.stdout);
    const idsTransData = parseJsonStdout(idsTransRes, 'mode:ids setTransition');
    assert.equal(idsTransData.code, 'CONFIRM_REQUIRED');
    assert.ok(idsTransData.confirmReasons.length > 0);
    assert.deepEqual(idsTransData.reasons, idsTransData.confirmReasons);

    // 2) harmonize + setLook 混批（不能借 harmonize 豁免夹带非 harmonize 调色）
    const mixRes = runCliProc([
      'apply', proj3Path,
      '--ops-json', JSON.stringify([
        { type: 'harmonize', target: { mode: 'all' }, strength: 0.7 },
        { type: 'setLook', target: { mode: 'index', indices: [1] }, look: 'cinematic', lookStrength: 0.85 },
      ]),
      '--json',
    ], { cwd: dir });
    assert.equal(mixRes.status, 2, mixRes.stdout);
    const mixData = parseJsonStdout(mixRes, 'harmonize + setLook');
    assert.equal(mixData.code, 'CONFIRM_REQUIRED');
    assert.ok(mixData.confirmReasons.length > 0);

    // 3) setTrack { locked: false } 解锁已锁定轨道
    const unlockTrackRes = runCliProc([
      'apply', proj3Path,
      '--ops-json', JSON.stringify([{ type: 'setTrack', track: 'text', patch: { locked: false } }]),
      '--json',
    ], { cwd: dir });
    assert.equal(unlockTrackRes.status, 2, unlockTrackRes.stdout);
    const unlockTrackData = parseJsonStdout(unlockTrackRes, 'unlock locked track');
    assert.equal(unlockTrackData.code, 'CONFIRM_REQUIRED');
    assert.ok(unlockTrackData.confirmReasons.length > 0);

    // 4) 空 ops: [] 必须退出 2 且返回 EMPTY_OPS
    const emptyRes = runCliProc([
      'apply', proj3Path,
      '--ops-json', '[]',
      '--json',
    ], { cwd: dir });
    assert.equal(emptyRes.status, 2);
    const emptyData = parseJsonStdout(emptyRes, 'empty ops');
    assert.equal(emptyData.ok, false);
    assert.equal(emptyData.code, 'EMPTY_OPS');

    // 被拦下后原文件必须保持不变
    assert.equal(fs.readFileSync(proj3Path, 'utf8'), raw3);

    // 5) 2 镜工程全片 setLook 也必须触发 CONFIRM_REQUIRED
    const proj2Path = path.join(dir, 'two.ffproj');
    const proj2 = {
      ...proj3,
      id: 'prj_gate2',
      name: 'Gate2',
      tracks: { ...proj3.tracks, video: [makeClip('c1', 'a1'), makeClip('c2', 'a2')] },
    };
    fs.writeFileSync(proj2Path, JSON.stringify(proj2, null, 2), 'utf8');
    const twoLookRes = runCliProc([
      'apply', proj2Path,
      '--ops-json', JSON.stringify([{ type: 'setLook', target: { mode: 'all' }, look: 'film-warm', lookStrength: 0.8 }]),
      '--json',
    ], { cwd: dir });
    assert.equal(twoLookRes.status, 2, twoLookRes.stdout);
    const twoLookData = parseJsonStdout(twoLookRes, '2-clip setLook');
    assert.equal(twoLookData.code, 'CONFIRM_REQUIRED');
    assert.ok(twoLookData.confirmReasons.length > 0);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('CLI 路径加固：尾点、尾空格与悬空符号链接/目录联接均退出码 2', () => {
  const dir = makeTmpDir('ff-cli-path-hard-');
  const linkDir = path.join(dir, 'dangling-link');
  try {
    // 1) 尾点文件名
    const dotRes = runCliProc(['init', path.join(dir, 'dot.ffproj.'), '--json'], { cwd: dir });
    assert.equal(dotRes.status, 2);
    assert.equal(parseJsonStdout(dotRes, 'trailing dot').code, 'UNSAFE_PATH');

    // 2) 尾空格文件名
    const spaceRes = runCliProc(['init', path.join(dir, 'trailing.ffproj '), '--json'], { cwd: dir });
    assert.equal(spaceRes.status, 2);
    assert.equal(parseJsonStdout(spaceRes, 'trailing space').code, 'UNSAFE_PATH');

    // 3) 悬空目录联接（Windows junction 免管理员权限 / POSIX dir symlink）
    const vanishTarget = path.join(dir, 'vanish-target');
    fs.mkdirSync(vanishTarget, { recursive: true });
    fs.symlinkSync(vanishTarget, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    fs.rmSync(vanishTarget, { recursive: true, force: true });

    const danglingInit = runCliProc(['init', path.join(linkDir, 'demo.ffproj'), '--json'], { cwd: dir });
    assert.equal(danglingInit.status, 2);
    assert.equal(parseJsonStdout(danglingInit, 'dangling init').code, 'UNSAFE_PATH');

    const danglingInspect = runCliProc(['inspect', path.join(linkDir, 'demo.ffproj'), '--json'], { cwd: dir });
    assert.equal(danglingInspect.status, 2);
    assert.equal(parseJsonStdout(danglingInspect, 'dangling inspect').code, 'UNSAFE_PATH');
  } finally {
    try { fs.unlinkSync(linkDir); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('CLI 兼容性：storyboard 自动建档、inspect --focus 0:15、apply --ops -、export-srt 标题过滤与 --include-all-text、任意 cwd 运行', () => {
  const dir = makeTmpDir('ff-cli-compat-');
  try {
    // 1) storyboard 在 .ffproj 不存在时自动创建
    const autoProj = path.join(dir, 'auto-created.ffproj');
    assert.equal(fs.existsSync(autoProj), false);
    const sbRes = runCliProc([
      'storyboard', autoProj,
      '--brief', '20s neon night street food tour',
      '--first-cut',
      '--json',
    ], { cwd: dir });
    assert.equal(sbRes.status, 0, sbRes.stderr);
    const sbData = parseJsonStdout(sbRes, 'storyboard auto-create');
    assert.equal(sbData.ok, true);
    assert.equal(sbData.created, true);
    assert.equal(sbData.backupPath, null);
    assert.equal(fs.existsSync(autoProj), true);

    // 2) inspect --focus 0:15 --json
    const insRes = runCliProc(['inspect', autoProj, '--focus', '0:15', '--json'], { cwd: dir });
    assert.equal(insRes.status, 0, insRes.stderr);
    const insData = parseJsonStdout(insRes, 'inspect --focus 0:15');
    assert.equal(insData.ok, true);
    assert.deepEqual(insData.focus, { start: 0, end: 15 });

    // 3) apply --ops - --dry-run --json（从 stdin 读取操作列表）
    const beforeStdinRaw = fs.readFileSync(autoProj, 'utf8');
    const stdinOps = [{ type: 'addMarker', t: 1.5, label: 'StdinMarker' }];
    const stdinRes = runCliProc(
      ['apply', autoProj, '--ops', '-', '--dry-run', '--json'],
      { cwd: dir, input: JSON.stringify(stdinOps) },
    );
    assert.equal(stdinRes.status, 0, stdinRes.stderr);
    const stdinData = parseJsonStdout(stdinRes, 'apply --ops -');
    assert.equal(stdinData.ok, true);
    assert.equal(stdinData.dryRun, true);
    assert.equal(stdinData.written, false);
    assert.equal(stdinData.diff.empty, false);
    assert.equal(fs.readFileSync(autoProj, 'utf8'), beforeStdinRaw);

    // 4) export-srt 默认排除 title 叠加文字，带 --include-all-text 时一并导出
    const srtProj = path.join(dir, 'srt-filter.ffproj');
    fs.writeFileSync(srtProj, JSON.stringify({
      version: 3,
      id: 'prj_srt_filter',
      name: 'SrtFilter',
      settings: { aspect: '16:9', width: 1920, height: 1080, fps: 30, background: '#000000' },
      assets: {},
      tracks: {
        video: [],
        text: [
          { id: 'txt_title', start: 0, duration: 3, text: 'Opening Main Title', preset: 'title' },
          { id: 'txt_cap', start: 1, duration: 2.5, text: 'Spoken subtitle line', preset: 'subtitle', group: 'caption' },
        ],
        audio: [],
      },
      overlays: [],
      markers: [],
      storyboard: [],
    }, null, 2), 'utf8');

    const srtDefault = runCliProc(['export-srt', srtProj, '--json'], { cwd: dir });
    assert.equal(srtDefault.status, 0, srtDefault.stderr);
    const srtDefData = parseJsonStdout(srtDefault, 'export-srt default');
    assert.equal(srtDefData.cueCount, 1);
    assert.equal(srtDefData.nonCaptionTextCount, 1);
    assert.equal(srtDefData.includeAllText, false);
    assert.ok(srtDefData.srt.includes('Spoken subtitle line'));
    assert.ok(!srtDefData.srt.includes('Opening Main Title'), '默认 export-srt 不应包含 title 标题文字');

    const srtAll = runCliProc(['export-srt', srtProj, '--include-all-text', '--json'], { cwd: dir });
    assert.equal(srtAll.status, 0, srtAll.stderr);
    const srtAllData = parseJsonStdout(srtAll, 'export-srt --include-all-text');
    assert.equal(srtAllData.cueCount, 2);
    assert.equal(srtAllData.includeAllText, true);
    assert.ok(srtAllData.srt.includes('Spoken subtitle line'));
    assert.ok(srtAllData.srt.includes('Opening Main Title'), '--include-all-text 应包含 title 标题文字');

    // 5) 从 os.tmpdir() 作为 cwd 运行 CLI
    const tmpCwdDoctor = runCliProc(['doctor', '--json'], { cwd: os.tmpdir() });
    assert.equal(tmpCwdDoctor.status, 0, tmpCwdDoctor.stderr);
    const tmpDocData = parseJsonStdout(tmpCwdDoctor, 'doctor from os.tmpdir()');
    assert.equal(tmpDocData.ok, true);
    assert.equal(tmpDocData.checks.engine.ok, true);
    assert.equal(tmpDocData.checks.skill.ok, true);
    assert.equal(tmpDocData.checks.mcpServer.ok, true);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
