# 跨模块接口合同（CONTRACTS）—— 与 SPEC.md 同等约束力

> SPEC.md 描述「做什么」，本文件钉死**模块之间互相调用的精确导出名与签名**。各组并行开发，只能依赖这里写明的导出；自己模块内部怎么写随意。
> 如果你需要别组的东西而这里没写 → 在自己模块里写私有实现，不要去改别人的文件。

## A. 主进程共享库（electron/lib/）

已存在：`paths.cjs`、`jobs.cjs`、`proc.cjs`、`settings.cjs`（读源码了解）。新增：

### `electron/lib/ff.cjs`（A 组写，B 组可用）
```js
probe(paths, file) → Promise<{ duration, width, height, fps, hasVideo, hasAudio, vcodec, acodec, size, kind:'video'|'image'|'audio' }>
extractFrame(paths, file, time, outPath, { width = 320 } = {}) → Promise<outPath>       // 单帧 jpg
thumb(paths, file, time = 0, width = 320) → Promise<path>                                 // 带缓存，<cache>/thumbs/<hash>.jpg
colorStatsFromImage(paths, imagePath) → Promise<ColorStats>                               // 缩到 32x18 rawvideo rgb24 计算
colorStats(paths, file, times) → Promise<ColorStats[]>
waveform(paths, file, peaksPerSecond = 50) → Promise<{ peaks:number[], duration }>        // 带缓存
needsProxy(probeResult, file) → boolean
makeProxy(paths, file, outPath, { signal, onProgress(p0to1) }) → Promise<outPath>         // H.264 + AAC mp4，最长边 1280
hashKey(...parts) → string                                                                // sha1 前 16 位
```
`ColorStats = { luma, contrast, saturation, warmth, tint, palette:[hex×5] }`（SPEC §3.6）。

### `electron/lib/codex.cjs`（C 组写，A 组 system 的 app:info 用）
```js
detectCodex(settings) → Promise<{ ok, path, version, loggedIn }>   // 结果缓存 30 秒；永不 throw
runCodex({ codexPath, model, system, prompt, schema, images, timeoutMs, signal, tmpRoot }) → Promise<object>
```
### `electron/lib/ytdlp.cjs`（B 组写，A 组 app:info 用）
```js
ytdlpStatus(paths) → Promise<{ installed, path, version }>   // 永不 throw
```
A 组 `app:info` 用 `try { require('../lib/codex.cjs') } catch {}` 方式容错加载这两个文件。

## B. 渲染端引擎（src/engine/）—— D 组写（builtinTechniques/sample 为 E 组）

### timeline.js
```js
clipDuration(clip) → number                          // (out-in)/speed
layoutVideo(project) → LayoutItem[]                  // LayoutItem = { clip, index /*0 起*/, start, end, duration, overlap }
projectDuration(project, layout?) → number           // max(主轨 end, 文字 end, 音频 end)；空项目 0
activeAt(layout, t) → { out: Entry|null, in: Entry|null, transition: { type, p /*0..1*/, duration }|null }
   // Entry = { clip, index, start, end, duration, srcTime /*源时间，in + (t-start)*speed，夹在 [in, out-1/60]*/, progress /*0..1 镜头内*/ }
   // 非转场：out=null, in=当前镜头, transition=null
   // 转场 i-1→i 期间（t ∈ [start_i, start_i+overlap_i)）：out=镜头 i-1, in=镜头 i
   // 第一个镜头的入场 dip-black/dip-white/crossfade（t < transitionIn.duration）：out=null, in=镜头0, transition 有值（从黑/白淡入）
   // t 超出总时长 → { out:null, in:null, transition:null }
textAt(project, t) → [{ text: TextClip, progress /*0..1*/, local /*秒*/ }]
audioAt(project, t) → [{ audio: AudioClip, srcTime }]
indexAtTime(layout, t) → number                      // 0 起；空 -1
itemsInRange(layout, start, end) → LayoutItem[]      // 与区间重叠
snapPoints(layout, project) → number[]               // 镜头边界、文字/音频边界
```
### ops.js
```js
applyOps(project, ops, ctx) → { ok, project, applied: string[], errors: string[] }    // SPEC §4，原子
resolveTargets(project, target, ctx, layout?) → number[]   // 0 起的主轨索引；越界 throw Error
describeOp(op, project?) → string                          // 中文一句话，如「第2镜：色温 +0.3」
OP_TYPES: string[]
```
### 其他
```js
// localnlp.js
parseCommand(text, { project, selectedClipIds, range, playhead }) → { ops: Op[], understood: string[], unknown: string[] }
// firstcut.js
buildFirstCut(project, { usePreviz = true } = {}) → { project, report: string[] }   // 也会为缺素材的分镜创建 kind='previz' 资产
makePrevizAsset(shot, project) → Asset                                             // kind:'previz', path:null, previz:shot.previz, duration:shot.duration
// colormatch.js
colorParamsFromStats(target: ColorStats, current: ColorStats, strength = 1) → { exposure, contrast, saturation, temperature, tint }
// consistency.js
projectBaseline(project) → ColorStats|null                       // 用 asset.stats（按镜头时长加权）
harmonizeOps(project, indices /*0 起，缺省全部*/, strength = 0.6) → Op[]
consistencyReport(project) → [{ index, issue, severity:'info'|'warn' }]   // 例：「第3镜明显偏暗」
// pacing.js
pacingDurations(clips, pacingOrDurations, assets) → number[]     // 'slow'|'medium'|'fast' 或数组
// techniques.js
searchTechniques(all, query, { category, limit = 30 } = {}) → Technique[]
techniqueToOps(technique) → Op[]                                 // target 统一 'selected'
// history.js
createHistory(limit = 100) → { push(state,label), undo(current), redo(current), canUndo, canRedo, clear }
// summary.js
projectSummary(project, { range, focus, maxClips = 60 } = {}) → string
// builtinTechniques.js（E 组）
export const BUILTIN_TECHNIQUES: Technique[]   // ≥40，id 前缀 'bt_'，builtin:true
// sample.js（E 组）
createSampleProject() → Project                // 「示例：咖啡店宣传片」：brief + 6~8 个分镜（含 previz、拍法、参考搜索词）+ director 欢迎对话；tracks 为空（启动页再调 buildFirstCut）
```

## C. 渲染（src/render/）与导出（src/export/）—— F 组写
```js
// compositor.js
renderFrame(ctx2d, project, t, pool, { width, height, layout?, mode:'preview'|'export' = 'preview', frameIndex? }) → void
   // 画主轨（含转场、调色、look、运镜、特效、transform）→ 片内字幕(caption) → 文字轨。背景 project.settings.background。
   // 资产 kind==='previz' → previz.drawPreviz；pool.getFrame 返回 null 时画深灰占位 + 「素材加载中」（导出模式下不应出现）
// mediaPool.js
createMediaPool({ mediaUrl }) → pool
pool.sync(project, t, layout, { playing, volume = 1 }) → void     // 每个 rAF 调用：让活动镜头的 <video> 对齐 t（播放中 play()+playbackRate=speed，偏差>0.25s 才 seek；暂停时 seek 到精确帧）；
                                                                   // 播放中负责声音：主轨活动镜头 video 取消静音并设 volume（clip.mute/volume、渐入渐出），音频轨用 <audio> 元素同步；暂停全部静音/暂停；预热下一个镜头
pool.seekExact(project, t, layout) → Promise<void>                // 导出用：所有活动源精确 seek（等 seeked + requestVideoFrameCallback/超时 1.5s）
pool.getFrame(asset, srcTime) → CanvasImageSource|null
pool.dispose()
// previz.js
drawPreviz(ctx, spec, progress, w, h, { label?, watermark = true, shotSize?, movement? } = {}) → void
// motion.js / transitions.js（纯函数，可测）
motionTransform(preset, intensity, progress) → { scale, x, y, rotation }
transitionState(type, p) → { outgoing:{alpha,x,y,scale,blur,rotation,clip?}, incoming:{...}, overlay:{color,alpha}|null }
// looks.js
LOOK_PRESETS: { [look]: { exposure, contrast, saturation, temperature, tint, splitShadow?:hex, splitHighlight?:hex, fade? } }
effectiveColor(color) → 合并 look × lookStrength 后的最终参数
// text.js
drawCaption(ctx, caption, w, h, progress) ; drawTextClip(ctx, textClip, w, h, progress, local)
// export/audioPlan.js（纯函数）
buildAudioPlan(project, { duration }) → AudioPlan
   // AudioPlan = { duration, segments: [{ path, timelineStart, srcIn, srcOut, speed, volume, fadeIn, fadeOut }] }
   //  主轨：asset.hasAudio && !clip.mute && volume>0 的镜头；音频轨：全部 AudioClip
// export/exporter.js
exportProject({ project, outPath, width, height, fps, quality, onProgress, signal }) → Promise<{ path, size, duration }>
   // onProgress({ phase:'render'|'encode', frame, total, fps, etaSec, progress /*0..1*/ })；signal 为 AbortSignal，取消时调用 export:cancel 并 throw Error{cancelled:true}
   // 内部：OffscreenCanvas/canvas + 独立 mediaPool + renderFrame(mode:'export') → canvas.convertToBlob/toBlob('image/jpeg', 0.92) → api.call('export:frame')
```

## D. AI（src/ai/）—— E 组写
```js
// client.js
class NoAIError extends Error {}  ;  isNoAI(err) → boolean
runAI({ task, system, prompt, schema, images, timeoutMs }, { onProgress, onStart } = {}) → Promise<{ data, provider, model, ms }>
   // 内部 api.job('ai:run', ...)；err.code==='NO_AI' → throw NoAIError
// director.js
buildDirectorRequest({ brief, messages, userText, techniques, assets }) → { task:'director', system, prompt, schema }
parseDirectorResponse(data) → { reply, briefPatch /*Brief 部分字段*/, questions: string[], storyboard: Shot[]|null, readyForStoryboard }
buildStoryboardRequest({ brief, messages, techniques, assets, project }) → { task:'storyboard', system, prompt, schema }
parseStoryboardResponse(data) → { shots: Shot[], styleGuide: string, reply: string }
buildShotRefineRequest({ brief, shot, instruction }) → {...}; parseShotRefineResponse(data, shot) → Shot   // 单镜修改
// editor.js
buildEditRequest({ project, command, selection /*clipIds*/, range, focus, techniques, libraryAssets }) → { task:'edit', system, prompt, schema }
parseEditResponse(data, project) → { reply, ops: Op[], materialRequests: [{ query, purpose, atIndex, duration }], memoryNote: string|null }
// analyze.js
buildAnalyzeRequest({ analysis }) → { task:'analyze', system, prompt, schema, images /*analysis.contactSheets 路径，最多 4 张*/ }
mergeAnalyzeResponse(analysis, data) → { analysis /*填好 shots[].ai 与 ai*/, techniques: Technique[] /*source.analysisId 指向它*/ }
// localDirector.js（无 AI 时）
localDirectorReply({ brief, messages, userText }) → 与 parseDirectorResponse 同形
localStoryboard(brief) → { shots: Shot[], styleGuide, reply }
localAnalyzeTechniques(analysis) → Technique[]   // 从统计数据推断（平均镜头时长→节奏卡，色彩→调色卡…）
// schemas.js
DIRECTOR_SCHEMA, STORYBOARD_SCHEMA, SHOT_SCHEMA, EDIT_SCHEMA, ANALYZE_SCHEMA ; normalizeAiOps(rawOps) → Op[]
```

## E. 主进程新增 channel（补充 SPEC §2.2）
- `analysis:update` `{ analysis }` → Analysis（B 组；渲染端做完 AI 标注后保存）
- Analysis 额外字段：`contactSheets: string[]`（每张 4×3 关键帧拼图 jpg，按镜头顺序；最多 4 张）、`contactSheetShots: number[][]`（每张图包含的镜头 index）
- `media:import` 返回的 Asset 需带 `stats`（一张中间帧的 ColorStats，失败为 undefined）与 `thumb`。
- `library:assets` 的 Asset：`source.type:'library'`，path 为库内文件绝对路径。

## F. 界面拆分（src/ui/）—— 各组只写自己的文件
| 组 | 文件 |
|---|---|
| G1 外壳 | `App.jsx`、`components/TopBar.jsx`、`components/StartPage.jsx`、`components/Toasts.jsx`、`components/JobsTray.jsx`、`dialogs/SettingsDialog.jsx`、`dialogs/ExportDialog.jsx`、`dialogs/HelpDialog.jsx`、`dialogs/NewProjectDialog.jsx`、`styles/shell.css`、`scripts/dev.mjs` |
| G2 创作 | `modes/create/*`（入口 `CreateMode.jsx` default export，无 props）、`styles/create.css` |
| H1 精修-中 | `modes/refine/RefineMode.jsx`（default，布局：左 `<MediaPanel/>` 中 `<Preview/>` 下 `<Timeline/>` 右 `<SidePanel/>`）、`Preview.jsx`、`Timeline.jsx`、`useShortcuts.js`、`styles/refine.css` |
| H2 精修-侧 | `modes/refine/MediaPanel.jsx`（default）、`modes/refine/SidePanel.jsx`（default，页签 AI 精修/检查器/技法）、`AIEditPanel.jsx`、`Inspector.jsx`、`TechniquePanel.jsx`、`styles/refine-side.css` |
| I 拆片库 | `modes/library/*`（入口 `LibraryMode.jsx` default）、`styles/library.css` |

已提供（总控写好，直接用，不要改）：
- `ui/store.js`（useStore，读源码）、`ui/api.js`、`ui/components/ui.jsx`（Icon/Button/Tabs/Slider/Select/Switch/Field/Modal/Empty/ProgressBar/Spinner/Chip/fmtTime/fmtBytes）
- `ui/components/media.jsx`：`<AssetThumb asset size? />`、`<PrevizCanvas spec playing? progress? width height label? />`
- `ui/assetActions.js`：`addAssets(assets)`（加入 project.assets，可撤销）、`insertAssets(assets, atIndex /*1 起，缺省末尾*/)`（加入并放上主轨）、`addAudioTrack(asset, start)`、`DND_ASSET = 'application/x-ff-asset'`（dataTransfer 里放 `JSON.stringify({ assets:[Asset] })`）、`readDroppedAssets(dataTransfer)`

### 消息格式
```js
DirectorMessage = { id, role:'user'|'assistant', text, at, questions?: string[], provider?: 'codex'|'openai'|'local' }
EditorMessage   = { id, role:'user'|'assistant', text, at, ops?: Op[], applied?: string[], status?: 'applied'|'proposed'|'rejected'|'error', provider?, materialRequests? }
```
存在 `project.chats.director` / `project.chats.editor`，用 `useStore.getState().update(p => ...)` 写入（不进撤销历史）。

### 模式间协作
- 精修聚焦：`store.focus = {start,end}`（时间线设置；AI 面板显示并作为 AI 上下文）。
- 拆片库技法卡「应用到精修所选镜头」：`store.commit(techniqueToOps(t), '应用技法：'+t.title)`，若无选择则 toast 提示先去精修选镜头。
- 创作「一键初剪」：`store.commit(p => buildFirstCut(p).project, '一键初剪')` 后 `store.setMode('refine')`。
- 全局快捷键（G1 在 App 里）：Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y / Ctrl+S / Ctrl+E(导出)。精修快捷键（H1 useShortcuts）：Space、S、Delete/Backspace、←/→、J/K/L、Home/End。焦点在 input/textarea/select/contenteditable 时都不触发。

## G. 验证规则（所有组）
- **不要运行 `vite build`、`npm run …`、`electron`、`npm install`**（多人并行会冲突；总控统一构建）。
- 语法检查：JS/JSX 用 `node_modules\.bin\esbuild.cmd <文件> --loader:.js=jsx --log-level=error > $null`（无输出即通过）；CJS 用 `node --check <文件>`。
- 纯模块写 `tests/<模块>.test.mjs`（`node:test` + `node:assert/strict`），只跑自己的：`node --test tests/<你的文件>`。
- 导入路径带扩展名（`./x.js`、`./X.jsx`）。React 组件文件 `import React from 'react'`。
- 中文界面文案，专业、简洁、对小白友好。

## H. v3 增补（2026-11）
数据模型扩展、新 op、videogen/asr IPC、导出预设、设计令牌与 ui.jsx 组件、store.layout/onboarding、data-tour 约定、文件归属，全部以 docs/PLAN-v3.md 为准，与本文件同等约束力；冲突时以 PLAN-v3.md 为准。

