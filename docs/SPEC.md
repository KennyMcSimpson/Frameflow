# 镜流 Frameflow Studio 2.0 — 技术规格（所有模块以此为准）

> 本文件是各模块开发者的**唯一合同**。改动接口前先改这里。界面全部中文。
> 产品原文需求见 `docs/VISION.md`。旧原型（只作参考，可借鉴算法，不要复制其架构）在 `..\Frameflow-Desktop\public\*.js` 和 `..\Frameflow-App-Kit\docs\*.md`。

## 0. 产品一句话

给不会剪辑的人用的**桌面 AI 视频工作站**。三个模式：

1. **创作（Create）**：和 AI 导演用白话讨论想拍什么 → 生成创意简报 + 分镜 → 每个分镜：联网找参考视频 / 生成「AI 预演」动画（教你怎么拍，也能直接当占位素材）→ 一键初剪成时间线。
2. **精修（Refine）**：多轨时间线剪辑器。白话指令或检查器修改素材、动作(运镜)、转场、光影(调色)、特效、字幕、音频。可以**框选一段放大聚焦**单独精修，但 AI 带着**全片记忆**（风格指南、全片色彩基准、前后镜头），保证改完仍符合整体。缺素材时先搜本地素材库，没有就联网抓取（免版权素材库 / 视频站），尽量不让用户自己找。
3. **拆片库（Library）**：把视频（URL 或本地文件：电影片段、拍摄教程、演员访谈、短视频、广告、特效视频）**肢解分析**：镜头切分、关键帧、节奏、色彩/光线、运动强度、响度、台词字幕 → AI 看关键帧标注景别/角度/运镜/光线/转场/用途 → 沉淀为「技法卡」。技法卡可以一键应用到时间线，也会被创作/精修 AI 检索引用。内置 40+ 条精选技法卡，离线即可用。

AI 引擎：**优先本机 Codex CLI**（ChatGPT 登录，无需 API Key），可选 OpenAI 兼容接口（更快，支持图片生成），无 AI 时退回本地规则（本地中文指令解析、本地分镜模板、本地统计拆片）。不需要专门的视频生成模型。

诚实原则（保留旧版精神）：界面上「AI 预演」明确标注为预演动画而非实拍；未分析的东西不说分析过；失败操作不改时间线（原子性）；导出真实进度。

## 1. 技术栈与目录

- Electron 45（`electron/main.cjs`，CommonJS），preload `electron/preload.cjs`（sandbox + contextIsolation）。
- 渲染进程：React 19 + Vite 7 + zustand 5，**纯 JavaScript（.js/.jsx），不用 TypeScript**。Vite root = `src`，输出 `dist-renderer/`，`base: './'`。
- 二进制：`ffmpeg-static`、`ffprobe-static`（打包时 asarUnpack，路径需把 `app.asar` 替换为 `app.asar.unpacked`）；`yt-dlp.exe` 首次使用时下载到 `<userData>/bin/`。
- 测试：`node --test tests/`（纯模块，ESM）。端到端：`e2e/smoke.mjs` 用 `playwright` 的 `_electron` 启动应用、截图到 `e2e/shots/`。

```
electron/
  main.cjs            窗口、协议、加载各 ipc 模块（已搭好骨架）
  preload.cjs         暴露 window.ff（已搭好）
  lib/paths.cjs       数据目录、二进制路径（骨架）
  lib/jobs.cjs        后台任务（进度/取消/结果）（骨架）
  lib/proc.cjs        spawn 封装：run(bin,args,{signal,onStderr,input}) → {code,stdout,stderr}
  ipc/store.cjs       项目、设置、密钥(safeStorage)
  ipc/media.cjs       ffprobe、缩略图、胶片条、波形、代理转码、导入、色彩统计
  ipc/web.cjs         yt-dlp 管理/搜索/下载/字幕；Wikimedia Commons、Pexels、Pixabay
  ipc/analysis.cjs    拆片流水线 + 技法库存储
  ipc/ai.cjs          AI 提供方：codex / openai / local；ai:run 通用结构化调用；ai:image
  ipc/export.cjs      ffmpeg 帧管道导出 + 音频混音
  ipc/system.cjs      对话框、shell、app:info
src/
  index.html, main.jsx
  engine/   纯函数，无 DOM，node 可测
    ids.js model.js timeline.js ops.js history.js localnlp.js firstcut.js
    colormatch.js pacing.js consistency.js techniques.js builtinTechniques.js summary.js
  render/   画面合成（Canvas2D），尽量纯函数
    compositor.js looks.js transitions.js motion.js text.js previz.js mediaPool.js
  ai/       提示词与 JSON Schema（纯函数）
    schemas.js director.js editor.js analyze.js localDirector.js client.js
  export/   exporter.js（逐帧渲染驱动）audioPlan.js（纯函数）
  ui/       React
    App.jsx store.js api.js  components/  modes/create/ modes/refine/ modes/library/  dialogs/
  styles/   tokens.css base.css（已给出设计令牌）+ 各模块 css
tests/      *.test.mjs
e2e/        smoke.mjs
```

## 2. 进程间接口（IPC）

渲染进程只通过 `window.ff`：

```js
window.ff.invoke(channel, payload) // → Promise<result>，出错 reject(Error(message))
window.ff.on(event, cb)            // → unsubscribe()
window.ff.mediaUrl(absPath)        // → 'ffmedia://local/<encodeURIComponent(absPath)>'
```

主进程模块写法：`module.exports = function register({ handle, ctx })`，用 `handle('channel', async (payload, event) => result)` 注册。`ctx = { paths, jobs, send(event, data), getWindow(), settings, registerMediaPath(p) }`（见 main.cjs）。**每个 channel 只在一个模块里注册。**错误一律 `throw new Error('中文可读原因')`。

渲染端包装 `src/ui/api.js`（骨架已给）：`api.call(channel, payload)`、`api.job(channel, payload, onProgress) → Promise<result>`（启动任务并等待 `job:done`/`job:error`）、`api.cancel(jobId)`。

### 2.1 后台任务协议

长任务的 channel 返回 `{ jobId }`，之后主进程推送：
- `job:progress` `{ jobId, kind, stage, progress /*0..1*/, message }`
- `job:done` `{ jobId, kind, result }`
- `job:error` `{ jobId, kind, error /*中文*/, cancelled /*bool*/ }`
- 取消：`invoke('job:cancel', { jobId })`。主进程 `jobs.start(kind, async (job) => {...})`，`job.progress(stage, p, msg)`、`job.signal`(AbortSignal)、`job.throwIfCancelled()`。

### 2.2 Channel 清单（payload → result）

**system.cjs**
- `app:info` → `{ version, dataRoot, ffmpeg:{ok,path}, ffprobe:{ok,path}, ytdlp:{ok,path,version}, codex:{ok,path,version,loggedIn}, platform }`
- `dialog:openFiles` `{ title, filters:[{name,extensions}], multi }` → `string[]`
- `dialog:saveFile` `{ title, defaultPath, filters }` → `string|null`
- `dialog:openFolder` → `string|null`
- `shell:openExternal` `{ url }`、`shell:showItem` `{ path }`、`shell:openPath` `{ path }`
- `media:register` `{ paths: string[] }` → `true`（允许协议读取这些文件）

**store.cjs**
- `settings:get` → Settings（不含密钥明文，改为 `hasOpenaiKey`, `hasPexelsKey`, `hasPixabayKey` 布尔）
- `settings:set` `{ ...partial, openaiKey?, pexelsKey?, pixabayKey? }` → Settings（密钥用 `safeStorage` 加密存 `<userData>/secrets.json`；传空字符串表示删除）
- `project:list` → `[{ id, name, updatedAt, duration, clipCount, thumb /*路径或null*/ }]`（按 updatedAt 降序）
- `project:create` `{ name, project? }` → Project（若给 project 则以其为内容，换新 id）
- `project:load` `{ id }` → Project
- `project:save` `{ project }` → `{ updatedAt }`（原子写：写 tmp 再 rename；保留 `project.prev.json` 备份）
- `project:delete` `{ id }` → true
- `project:saveThumb` `{ id, dataUrl }` → path
- `project:exportJson` `{ project, path }`、`project:importJson` `{ path }` → Project
- `project:dir` `{ id }` → 项目目录绝对路径（媒体缓存放 `<dir>/cache/`）

**media.cjs**
- `media:probe` `{ path }` → `{ duration, width, height, fps, hasVideo, hasAudio, vcodec, acodec, size, kind:'video'|'image'|'audio' }`
- `media:import` `{ paths, projectId }` → job → `Asset[]`（probe；生成缩略图；浏览器无法解码的编码（非 h264/vp8/vp9/av1）或容器（非 mp4/webm/mov/m4v）生成 H.264 mp4 代理放 `<project>/cache/`，Asset.path 用代理、`originalPath` 记原文件；图片 duration=5；音频 kind='audio'）。导入**不复制**原文件，直接引用；自动 `media:register`。
- `media:thumb` `{ path, time, width }` → 图片路径（缓存：`<dataRoot>/cache/thumbs/<hash>.jpg`）
- `media:filmstrip` `{ path, duration, count, height }` → 路径数组
- `media:waveform` `{ path, peaksPerSecond /*默认50*/ }` → `{ peaks: number[] /*0..1*/, duration }`（缓存）
- `media:colorStats` `{ path, times: number[] }` → `ColorStats[]`（见 §3.6）

**web.cjs**
- `web:ytdlpStatus` → `{ installed, path, version }`；`web:ytdlpInstall` → job → status（从 `https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe` 下载，进度可见）
- `web:search` `{ query, sources:['youtube'|'bilibili'|'commons'|'pexels'|'pixabay'], kind:'video'|'image'|'audio', limit /*每源默认8*/ }` → `{ results: WebResult[], errors: [{source,error}] }`（各源并行，单源失败不影响其他）
- `web:download` `{ result?: WebResult, url?: string, target:'project'|'library', projectId?, maxSeconds? /*默认 180*/, withSubs /*bool*/ }` → job → `{ asset: Asset, subtitles: [{start,end,text}] | null }`
- `WebResult = { source, id, title, url /*页面*/, thumb, duration, width, height, author, license /*如 'CC BY-SA 4.0' / 'Pexels License' / '版权归原作者，仅供学习参考'*/, downloadUrl? /*直链（commons/pexels/pixabay）*/, kind }`

**analysis.cjs**（库存于 `<dataRoot>/library/`）
- `analysis:start` `{ path? , url?, title?, category /*'film'|'tutorial'|'interview'|'short'|'ad'|'vfx'|'other'*/, useAI /*默认 true*/, maxSeconds /*默认 600*/ }` → job → Analysis（url 时先用 yt-dlp 下载到库，带字幕）
- `analysis:list` → `[{ id, title, category, duration, shotCount, thumb, createdAt, techniqueCount, status }]`
- `analysis:get` `{ id }` → Analysis；`analysis:delete` `{ id }`
- `library:techniques` `{ query?, category? }` → `Technique[]`（用户/拆片生成的卡；内置卡在渲染端 builtinTechniques.js，不经主进程）
- `library:saveTechnique` `{ technique }` → Technique；`library:deleteTechnique` `{ id }`
- `library:assets` `{ query? }` → `Asset[]`（素材库：拆片下载的视频、联网下载到库的素材，带 tags）
- `library:addAssets` `{ assets }` → `Asset[]`

**ai.cjs**
- `ai:status` → `{ provider:'codex'|'openai'|'local', ready, model, detail, codex:{ok,loggedIn,path}, openai:{configured, baseUrl, model, visionModel, imageModel} }`
- `ai:test` `{ provider }` → `{ ok, ms, detail }`
- `ai:run` `{ task /*用于日志*/, system, prompt, images?: string[] /*绝对路径*/, schema /*JSON Schema 对象，严格模式*/, timeoutMs?, provider? }` → job → `{ data /*已按 schema 解析的对象*/, provider, model, ms }`
  - codex：写临时目录 `schema.json`（**UTF-8 无 BOM**）+ 把 system+prompt 经 stdin 传入；参数：`exec --skip-git-repo-check --ephemeral -s read-only -C <tmp> --output-schema <schema> -o <out.json> [-m model] [-i img ...] -`；读 out.json 解析；解析失败重试 1 次。codex 路径探测顺序：设置里的路径 → `CODEX_CLI_PATH` 环境变量 → `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`（取最新）→ PATH 中的 `codex`/`codex.cmd`。
  - openai：`POST {baseUrl}/chat/completions`，`response_format:{type:'json_schema', json_schema:{name, strict:true, schema}}`（失败可回退 `json_object`），图片转 data URL（先用 ffmpeg 缩到 ≤1024 宽 jpeg）。
  - local：直接 throw `'未连接 AI，已使用本地规则'` 的特殊错误码 `{code:'NO_AI'}`，由渲染端回退到本地逻辑。
- `ai:image` `{ prompt, size:'1536x1024'|'1024x1536'|'1024x1024', projectId }` → job → `{ path }`（仅 openai 且配置了 imageModel；否则抛错「当前 AI 不支持生成图片」）

**export.cjs**
- `export:begin` `{ outPath, width, height, fps, quality /*'high'|'standard'|'small'*/, audioPlan: AudioPlan, totalFrames }` → `{ jobId }`（spawn ffmpeg：`-f image2pipe -framerate fps -c:v mjpeg -i -` + 音频输入与 filter_complex，`-c:v libx264 -pix_fmt yuv420p -preset veryfast -crf (18|21|26) -c:a aac -b:a 192k -movflags +faststart -shortest`）
- `export:frame` `{ jobId, data: ArrayBuffer /*JPEG*/ }` → true（写入 stdin 并等待 drain，实现背压）
- `export:end` `{ jobId }` → `{ path, size, duration }`
- `export:cancel` `{ jobId }`；进度通过 `job:progress`（kind:'export'）推送

## 3. 数据模型（engine/model.js 定义默认值与 normalize）

所有时间单位：秒（浮点）。所有 id：`ids.js` 的 `uid(prefix)`。

### 3.1 Project
```js
{
  version: 2, id, name, createdAt, updatedAt,
  settings: { aspect: '16:9'|'9:16'|'1:1'|'4:3'|'21:9', width, height, fps: 30, background: '#000000' },
  assets: { [assetId]: Asset },
  tracks: {
    video: Clip[],      // 主轨，磁吸顺序排列，无空隙
    text: TextClip[],   // 文字/标题层，自由定位时间
    audio: AudioClip[]  // 音乐/音效/配音，自由定位时间
  },
  brief: Brief|null,          // 创作线产出
  storyboard: Shot[],         // 分镜（创作线）
  memory: { styleGuide: '', decisions: [ {at, text} ], colorBaseline: ColorStats|null },
  chats: { director: Message[], editor: Message[] },
  references: { [shotId]: WebResult[] }
}
```
画幅尺寸：16:9→1920×1080，9:16→1080×1920，1:1→1080×1080，4:3→1440×1080，21:9→2560×1080（预览时按容器缩放，导出按此尺寸，导出对话框可选 720p 档 = 尺寸 ×2/3 取偶数）。

### 3.2 Asset
```js
{ id, kind:'video'|'image'|'audio'|'previz'|'generated-image', name, path /*绝对路径；previz 为 null*/, originalPath?,
  duration, width, height, fps, hasAudio, size, thumb /*路径或 null*/,
  source: { type:'local'|'web'|'stock'|'previz'|'ai-image'|'library', url?, platform?, license?, author? },
  tags: string[], description?: string,
  previz?: PrevizSpec,   // kind==='previz'
  analysisId?: string,   // 拆片库中的分析
  stats?: ColorStats }   // 代表性色彩统计（导入后异步补）
```

### 3.3 Clip（主轨）
```js
{ id, assetId, in: 0, out: 5, speed: 1, label: '',
  caption: { text:'', style:'subtitle'|'title'|'lower-third'|'none', position:'bottom'|'center'|'top' },
  color: { exposure:0, contrast:0, saturation:0, temperature:0, tint:0, highlights:0, shadows:0, vignette:0, look:'none', lookStrength:1 },
  //  exposure/contrast/saturation/temperature/tint/highlights/shadows ∈ [-1,1]；vignette ∈ [0,1]
  transform: { scale:1 /*1..3*/, x:0, y:0 /*-1..1 画面宽高的比例偏移*/, rotation:0 /*度*/, flipH:false },
  motion: { preset:'none', intensity:0.5 },
  //  preset: 'none'|'push-in'|'pull-out'|'pan-left'|'pan-right'|'tilt-up'|'tilt-down'|'shake'|'zoom-punch'|'drift'
  fx: { blur:0, grain:0, glow:0, sharpen:0, letterbox:0, chromatic:0, vhs:0, flash:0 }, // 均 0..1
  transitionIn: { type:'cut', duration:0.5 },
  //  type: 'cut'|'crossfade'|'dip-black'|'dip-white'|'slide-left'|'slide-right'|'slide-up'|'slide-down'|'zoom-in'|'zoom-out'|'wipe-left'|'wipe-right'|'blur'|'whip-pan'|'flash'|'spin'
  //  duration ∈ [0.1, 2]；第一个镜头的 transitionIn 只允许 cut 或 dip-black/dip-white/crossfade(=从黑淡入)
  volume: 1 /*0..2*/, mute: false, audioFadeIn: 0, audioFadeOut: 0,
  locked: false, notes: '', shotId: null /*来自哪个分镜*/ }
```
时间线布局（timeline.js `layoutVideo(project)`）：clip 时长 `dur = (out-in)/speed`；第 i 个镜头开始时间 `start_i = end_{i-1} - overlap_i`，其中非 cut 转场 `overlap_i = min(transitionIn.duration, dur_i/2, dur_{i-1}/2)`，cut 为 0（i=0 时 overlap=0，转场在开头表现为从黑/白淡入）。总时长 = 最后一个 end。限制：≤200 镜，总时长 ≤ 600 秒，单镜 ≥ 0.2 秒。

### 3.4 TextClip / AudioClip
```js
TextClip = { id, start, duration, text, preset:'title'|'subtitle'|'lower-third'|'caption-box'|'big-bold'|'handwrite'|'neon',
  x:0.5, y:0.5 /*0..1 中心点*/, size:1 /*相对字号*/, color:'#ffffff', animation:'fade'|'pop'|'slide-up'|'typewriter'|'none', locked:false }
AudioClip = { id, assetId, start, in, out, volume:1, fadeIn:0.5, fadeOut:0.8, role:'music'|'sfx'|'voice', locked:false }
```

### 3.5 Brief / Shot / PrevizSpec（创作线）
```js
Brief = { title, goal, audience, platform /*'抖音'|'B站'|'小红书'|'YouTube'|'朋友圈'|'其他'*/, duration /*秒*/, aspect,
  style, mood, look /*与 color.look 同集合*/, pacing /*'slow'|'medium'|'fast'*/, music, keyMessage, mustHave: string[], avoid: string[] }
Shot = { id, index, title, duration, shotSize /*'extreme-wide'|'wide'|'full'|'medium'|'medium-close'|'close-up'|'extreme-close-up'|'insert'*/,
  angle /*'eye-level'|'high'|'low'|'top-down'|'dutch'|'over-shoulder'|'pov'*/,
  movement /*与 motion.preset 同集合 + 'handheld'|'orbit'|'tracking'|'static'*/,
  lighting /*自由文本，如「侧逆光，暖色，窗光」*/, location, subject, action, caption /*字幕/台词*/, voiceover,
  shootingTips: string[] /*给小白的拍法：手机怎么拿、站哪、几倍焦段、提前做什么*/,
  transitionIn /*转场类型*/, look, referenceQueries: string[] /*联网找参考的搜索词，中英各一*/, techniqueIds: string[],
  previz: PrevizSpec, assetId: null /*用户为该分镜指定的素材*/, status:'planned'|'has-reference'|'has-previz'|'has-footage' }
PrevizSpec = { setting:'cafe'|'street'|'nature'|'studio'|'office'|'home'|'night-city'|'beach'|'kitchen'|'shop'|'gym'|'abstract',
  timeOfDay:'day'|'golden'|'night'|'blue', palette: [hex,hex,hex], subjects: [{ kind:'person'|'product'|'cup'|'phone'|'car'|'plant'|'box'|'text'|'food'|'laptop',
  x, y /*0..1*/, scale /*0.2..2*/, color, action:'idle'|'walk-left'|'walk-right'|'turn'|'raise'|'rotate'|'pour'|'talk'|'jump', label? }],
  camera: { shotSize, movement, angle }, light: { direction:'left'|'right'|'top'|'back'|'front', key:'warm'|'cool'|'neutral', mood:'bright'|'soft'|'dramatic'|'night' },
  overlayText?: string }
```

### 3.6 ColorStats / Analysis / Technique（拆片库）
```js
ColorStats = { luma /*0..1 平均亮度*/, contrast /*0..1 亮度标准差×2*/, saturation /*0..1*/, warmth /*-1..1 (R-B)*/, tint /*-1..1 (G-(R+B)/2)*/, palette: [hex×5] /*主色*/ }
Analysis = { id, title, category, source:{ type:'url'|'file', url?, platform?, path }, assetPath, duration, width, height, fps, createdAt,
  status:'done'|'partial', errors: string[],
  shots: [{ index, start, end, duration, thumb, keyframes:[path], stats: ColorStats, motion /*0..1*/, loudness /*0..1*/,
            ai: { shotSize, angle, movement, lighting, composition, subject, transitionIn, purpose, notes } | null }],
  rhythm: { avgShot, medianShot, cutsPerMinute, durations: number[] },
  audio: { curve: number[] /*每0.5秒响度0..1*/, peaks: number[] /*秒*/ },
  transcript: [{ start, end, text }],
  colorProfile: ColorStats,
  ai: { summary, style, structure: [{ label, start, end, description }], highlights: string[] } | null,
  techniqueIds: string[] }
Technique = { id, category:'transition'|'lighting'|'camera'|'rhythm'|'composition'|'color'|'dialogue'|'vfx'|'product'|'narrative'|'sound',
  title, summary, steps: string[], whenToUse, tags: string[], builtin: bool,
  source?: { analysisId, title, start, end },
  apply?: { ops: Op[] /*对目标镜头执行的操作模板，target 统一用 'selected'*/, note? } | null }
```

## 4. 编辑操作协议（engine/ops.js）——AI、本地指令、检查器、技法卡共用

`applyOps(project, ops, ctx) → { ok, project /*新对象，失败时为原对象*/, applied: string[] /*中文描述*/, errors: string[] }`
**原子性：任何一条失败 → 全部不应用。** `ctx = { selectedClipIds: string[], range: {start,end}|null, playhead }`。

Op 结构（扁平，便于严格 JSON Schema）：
```js
{ type, target: { mode:'selected'|'index'|'ids'|'range'|'all'|'none', indices:number[] /*1 起*/, ids:string[] }, ...参数 }
```
| type | 参数 | 说明 |
|---|---|---|
| `setColor` | `color: {部分字段}` + `relative: bool` | relative=true 时为增量 |
| `setLook` | `look, lookStrength` | |
| `setMotion` | `preset, intensity` | |
| `setTransform` | `transform: {部分}` | |
| `setFx` | `fx: {部分}`, `relative` | |
| `setTransition` | `transition: {type, duration}` | 作用于目标镜头的入场转场 |
| `setCaption` | `caption: {text?, style?, position?}` | |
| `setSpeed` | `speed` | 0.25..4 |
| `setVolume` | `volume?`, `mute?`, `audioFadeIn?`, `audioFadeOut?` | |
| `trim` | `in?`, `out?`, `relative` | 源时间 |
| `setDuration` | `duration` | 保持 in，改 out（不超素材；图片/预演可任意） |
| `split` | `at` | 时间线时间；目标唯一镜头 |
| `delete` | — | 至少留 1 镜 |
| `duplicate` | — | |
| `move` | `toIndex`（1 起） | |
| `insertAsset` | `assetId, atIndex /*1 起，缺省=末尾*/, in?, out?, duration?` | target.mode='none' |
| `replaceAsset` | `assetId` | 保留效果参数 |
| `lock` / `unlock` | — | |
| `addText` | `text: TextClip 部分` | target none |
| `updateText` / `removeText` | `textId`, `text` | |
| `addAudio` | `audio: AudioClip 部分` | target none |
| `updateAudio` / `removeAudio` | `audioId`, `audio` | |
| `matchColor` | `reference: ColorStats`, `strength` | 根据参考统计算出 color 参数（colormatch.js） |
| `harmonize` | `strength` | 目标镜头向全片基准色靠拢（consistency.js） |
| `applyPacing` | `durations: number[]` 或 `pacing:'slow'|'medium'|'fast'` | pacing.js |
| `setProject` | `settings: {aspect?}` | |

锁定镜头：除 `unlock` 外任何作用于它的操作 → 整批失败，错误「第 N 镜已锁定」。`target.mode='range'`：与 ctx.range 有重叠的所有镜头。编号越界 → 失败。

## 5. 渲染（render/）

- `compositor.js`：`renderFrame(ctx2d, project, t, mediaPool, opts)`；画一帧：主轨活动镜头（转场期间 2 个）→ 文字层 → 字幕。使用 `mediaPool.getFrame(asset, sourceTime)` 返回可绘制对象（HTMLVideoElement/ImageBitmap/HTMLImageElement）或 `null`（previz 资产由 `previz.js` 直接画）。同一套代码用于预览与导出。
- 调色：`ctx.filter` 实现亮度/对比/饱和/模糊；色温/色调用 `soft-light`/`overlay` 叠色；高光/阴影用渐变 `screen`/`multiply` 近似；`looks.js` 定义 look 预设（`none, cinematic(青橙), film-warm, film-cool, bw, noir, vintage, cool-night, vivid, soft-pastel, high-contrast, moody, golden-hour, cyberpunk`）为参数组合 + 分离色调。
- 特效：暗角、颗粒（固定噪点纹理按帧号偏移，确定性）、辉光（模糊副本 screen）、锐化（可近似）、电影黑边、色差（偏移着色副本）、VHS（扫描线+色偏+抖动）、闪白。
- 运镜 `motion.js`：`motionTransform(preset, intensity, progress) → {scale, x, y, rotation}`（纯函数，可测）。
- 转场 `transitions.js`：`transitionState(type, p) → { outgoing:{alpha,x,y,scale,blur,clip?}, incoming:{...}, overlay?:{color,alpha} }`（纯函数，可测）。
- 文字 `text.js`：字幕与 TextClip 预设样式、动画。
- 预演 `previz.js`：`drawPreviz(ctx, spec, progress, w, h)`：风格化动态分镜（场景背景、光线方向与色温、主体剪影、主体动作、虚拟摄影机运动与景别取景、右上角「AI 预演」水印与景别/运镜标注）。要好看、可读，像专业动态分镜。
- `mediaPool.js`（浏览器端）：管理 `<video>` 元素池（每资产 1–2 个，crossOrigin='anonymous'，muted），`prepare(t)` 预热，`getFrame(asset, srcTime)`；导出模式下 `seekExact` 等待 `seeked` + `requestVideoFrameCallback`。图片用 `ImageBitmap` 缓存。

## 6. AI（src/ai/，渲染端构造提示词，主进程只负责传输）

- `schemas.js`：严格模式 JSON Schema（所有 object `additionalProperties:false`，所有属性 required，可空用 `type:['string','null']`）：`DIRECTOR_SCHEMA`、`STORYBOARD_SCHEMA`、`EDIT_SCHEMA`、`ANALYZE_SCHEMA`、`TAGS_SCHEMA`。Op 的严格 schema 用扁平可空字段，`normalizeAiOps()` 转为 §4 Op。
- `director.js`：`buildDirectorRequest({ brief, messages, userText, techniques, assets }) → {system, prompt, schema}`；`parseDirectorResponse(data) → { reply, briefPatch, questions, storyboard|null, readyForStoryboard }`。AI 导演：先问 2–4 个关键问题（受众/平台/时长/风格/有无素材），信息够了再给分镜。分镜面向小白：每镜给具体拍法。引用技法卡 id。
- `editor.js`：`buildEditRequest({ project, command, selection, range, techniques, libraryAssets }) → {system,prompt,schema}`；`parseEditResponse(data, project) → { reply, ops, materialRequests:[{query, purpose, atIndex, duration}], memoryNote }`。prompt 包含 `summary.js` 生成的全片摘要（每镜编号、时间、素材描述、参数要点）、风格指南、全片色彩基准、聚焦范围前后镜头。
- `analyze.js`：`buildAnalyzeRequest({ analysis, contactSheets }) → {system,prompt,schema,images}`；`mergeAnalyzeResponse(analysis, data) → { analysis, techniques: Technique[] }`。
- `localDirector.js`：无 AI 时的本地导演：基于关键词的问答 + 模板分镜（按平台/时长/风格生成 4–8 镜，含拍法、PrevizSpec）。
- `client.js`：`runAI(request, {onProgress}) → data`，内部 `api.job('ai:run', ...)`；遇到 `NO_AI` 抛出 `NoAIError` 让调用方回退。

## 7. 引擎其他模块

- `localnlp.js`：`parseCommand(text, { project, selectedClipIds, range }) → { ops, understood: string[], unknown: string[] }`。支持复合句（，、；。然后 并且 再 和），第N段/第N个镜头/第N到M段/前N段/后N段/最后一段/开头/结尾/这段/所有/全部/每段，中文数字。覆盖：暖/冷/亮/暗/对比/饱和/黑白/复古/电影感/赛博朋克等 look、推近/拉远/左右摇/上下摇/抖动/冲击变焦/缓慢漂移、各转场、字幕改写（引号内容）、标题文字、加速/慢放/x倍速、静音/音量、删除/复制/分割(在播放头)/移动、锁定/解锁、模糊/颗粒/辉光/黑边/VHS/暗角、时长「改成3秒」、「统一色调」(harmonize)、「节奏快一点」(applyPacing)。不理解的部分放入 unknown，**有 unknown 时调用方不应用**并提示用户（或交给 AI）。
- `firstcut.js`：`buildFirstCut(project, { useReferences, usePreviz }) → { project, report }`：按分镜顺序生成主轨：分镜指定素材 > 项目素材按 tags/描述/时长匹配 > 该镜预演资产（不存在就创建 kind='previz' 资产）；设置时长、字幕、运镜（shot.movement 映射 motion）、转场、look（brief.look）；节奏按 brief.pacing；旧主轨若有用户镜头先确认（由 UI 处理）。
- `colormatch.js`：`colorParamsFromStats(target, current, strength) → color 部分参数`。
- `consistency.js`：`projectBaseline(project, statsByAsset) → ColorStats`、`harmonizeOps(...)`。
- `pacing.js`：`pacingDurations(clips, pacing|durations)`。
- `techniques.js`：`searchTechniques(all, query, {category, limit}) → Technique[]`（中文关键词打分），`techniqueToOps(technique)`。
- `builtinTechniques.js`：≥40 条高质量中文技法卡（覆盖全部 category；转场/运镜/光线/调色/节奏/构图/产品展示/叙事/台词/声音/特效），能映射到操作的给出 `apply.ops`。内容要专业、具体、可执行（如「三点布光」「伦勃朗光」「窗光侧逆」「希区柯克变焦」「匹配剪辑」「J-cut/L-cut」「卡点剪辑」「产品英雄镜头」「微距细节呈现卖点」「开头3秒钩子」「过肩镜头对话」「黄金时刻逆光」「青橙电影调色」「冲击变焦转场」「甩镜转场」...）。
- `history.js`：`createHistory(limit=100)`、`push(prev, next, label)`、`undo/redo`。
- `summary.js`：`projectSummary(project, { range, maxClips }) → string`（给 AI 的紧凑中文摘要）。

## 8. 界面（src/ui/）

暗色专业剪辑台，令牌见 `src/styles/tokens.css`。宽屏优先（1366×768 起可用）。
- 顶栏：「镜流 Frameflow」、项目名（可编辑）、模式切换 **创作 / 精修 / 拆片库**、保存状态、AI 状态芯片（Codex 已就绪 / API / 本地规则）、导入、导出（主按钮）、设置、帮助。
- 启动页（无项目打开时）：最近项目网格、新建空白项目（选画幅）、从「示例：咖啡店宣传片」创建（含预演分镜）。
- 创作模式：左「AI 导演」对话；中「分镜板」（分镜卡：预演动画小预览、时长、景别/角度/运镜/光线、拍法、参考视频条、状态）；右「创意简报」可编辑 + 操作按钮（生成分镜 / 全部生成预演 / 为全部分镜找参考 / 一键初剪 → 跳到精修）。分镜卡上：查找参考（展示联网结果缩略图，可「打开原网页」「下载到素材」「下载并拆片学习」）、生成预演（previz 资产）、AI 画面（可选：openai 图片生成 → 静帧 + 运镜）、指定我的素材。
- 精修模式：左「素材」（项目素材 / 素材库 / 联网素材 三个页签，搜索，拖到时间线或点「+」）；中：预览（画布 + 播放控制 + 时码 + 画幅）；下：多轨时间线（标尺、播放头、视频主轨缩略图块显示转场/运镜/锁定标记、文字轨、音频轨波形；缩放；拖动排序；拖边裁剪；分割；**框选范围 → 聚焦此段**：时间线放大到该范围并在 AI 面板显示「聚焦：00:12–00:18（第3–4镜）」）；右：页签「AI 精修」（对话 + 快捷指令 + 显示将执行的操作 + 撤销）/「检查器」（镜头参数分组：画面、调色、运镜、特效、转场、字幕、音频；即时预览，`应用`前为草稿——本版改为**直接修改并可撤销**，滑杆拖动结束时提交一步历史）/「技法」（搜索技法卡，应用到所选镜头）。
- 拆片库模式：左：添加（粘贴一个或多个 URL / 选择本地视频 / 分类 / 是否用 AI）+ 任务队列（进度条、取消）+ 已分析列表；中：分析详情（视频播放器 + 镜头条（关键帧缩略图，点击跳转）+ 节奏图（镜头时长柱状）+ 亮度/运动/响度曲线 + 色板 + 台词 + AI 结构分段）；右：技法卡（来自此视频 / 全部 / 内置），可编辑、删除、「应用到精修中所选镜头」。另有「主题学习」：输入主题（如「咖啡产品短视频」）→ 联网搜 N 条 → 依次下载拆片（队列）。
- 设置对话框：AI（提供方选择；Codex 路径/状态/测试；OpenAI 兼容 baseUrl、key、model、visionModel、imageModel、测试）、联网（yt-dlp 安装/更新、Pexels/Pixabay key、默认最长下载秒数）、存储（数据目录、打开目录）、导出默认值。
- 导出对话框：分辨率档、帧率、质量、保存位置 → 进度（帧数、预计剩余时间）、取消 → 完成后「打开文件夹」「播放」。
- 快捷键：Space 播放/暂停、Ctrl+Z / Ctrl+Shift+Z 撤销重做、Ctrl+S 保存、S 在播放头分割、Delete 删除所选、← → 逐帧、J/K/L。
- Toast：右下角；失败红色。
- zustand store（`src/ui/store.js`，骨架已给）：`project, selection{clipIds, textId, audioId}, range, focus, playhead, playing, mode, history, saveState, aiStatus, jobs{}, appInfo, settings`，动作：`commit(ops|fn, label)`（走 applyOps，成功推入历史并自动保存 debounce 800ms）、`undo/redo`、`setMode`… 详见骨架注释。

## 9. 数据目录

`dataRoot = <文档>/Frameflow`（设置可改）：`projects/<id>/project.json`、`projects/<id>/cache/`、`library/analyses/<id>.json`、`library/analyses/<id>/`（关键帧、联系表）、`library/media/`（下载的视频）、`library/techniques.json`、`library/assets.json`、`cache/thumbs/`、`cache/waveforms/`。`<userData>/settings.json`、`<userData>/secrets.json`、`<userData>/bin/yt-dlp.exe`。
