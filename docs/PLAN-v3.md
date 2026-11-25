# 镜流 Frameflow v3 实施方案与共享约定（与 CONTRACTS.md 同等约束力）

目标：可上架。①界面重设计（剪映式四区、单一主按钮、首次引导）；②真人实拍优先 + AI 真人视频生成；③补齐 PR/剪映核心剪辑能力；④修 completeness 报告的 bug。
12 个工作包并行，**每个文件只属于一个包**。跨包只能通过本文 §1–§7 的接口协作；需要别人的东西时按接口先写调用，对方未完成时用 `?.` / 默认值兜底，不得改别人的文件。

## 1. 数据模型扩展（W5 实现于 model.js / normalizeProject，旧工程自动迁移，全部字段可缺省）
clip 新增：
- `reverse:boolean=false`，`mirror:{h:false,v:false}`，`still:boolean=false`（定格片段，in===out 取同一帧）
- `speedCurve:null | [{t:0..1, v:0.1..10}]`（归一化，t 升序，首尾 t=0/1）；LIMITS.speed 放宽为 0.1–10
- `crop:{l,t,r,b}`（0..0.45 比例，默认 0），`fit:'contain'|'cover'|'fill'='cover'`
- `canvas:{type:'none'|'blur'|'color'|'image', value}`（默认 none；value 为颜色或 assetId）
- `opacity:0..1=1`，`blend:'normal'|'multiply'|'screen'|'overlay'|'darken'|'lighten'|'add'`
- `mask:null|{shape:'linear'|'mirror'|'circle'|'rect',cx,cy,w,h,rot,feather,invert}`
- `keys:{ [path]: [{t,v,ease:'linear'|'ease'|'easeIn'|'easeOut'|'hold'}] }`，t 为片段本地秒。可动画 path：`transform.x|y|scale|rotate`、`opacity`、`volume`、`color.<key>`
- `muted:boolean`（原声静音），`volume` 保持现有
project 新增：
- `overlays:[{id, assetId, kind:'video'|'image'|'sticker', track:1..4, start, in, out, speed, transform, opacity, blend, mask, crop, keys, volume, muted}]`（画中画轨，track 越大越上层）
- `tracks:{ video:{locked,hidden,muted}, overlay:{1..4:{locked,hidden,muted}}, text:{...}, audio:{...} }`
- `markers:[{id,t,label,color}]`
- `exportPreset:string`（见 §5）
text 新增：`group:'caption'|null`，`stroke:{color,width}`，`shadow`，`bg`，`animIn/animOut/animLoop:{type,dur}`
audio 新增：`volumeKeys:[{t,v}]`，`denoise:boolean`，`fadeIn/fadeOut` 保持
asset 新增：`source:'stock'|'videogen'|'previz'|'local'|'web'`，`credit`，`beats?:number[]`，`proxyPath?`，`meta.videogen?:{provider,prompt,taskId}`
shot（创作分镜）新增：`aiVideoAssetId`、`aiVideoTask:{provider,taskId,state,progress,error}|null`、`mediaSource:'stock'|'ai'|'local'|'previz'`

## 2. 纯函数（W5：src/engine/timeline.js、keyframes.js；均需单测）
- `keyframes.js`：`valueAt(keys, path, t, base)`、`setKey(keys,path,t,v,ease)`、`removeKey(keys,path,t)`、`neighborKeys(keys,path,t)->{prev,next}`、`allKeyTimes(keys)`
- `timeline.js` 新增：`sourceTimeAt(clip, localT)`（处理 speed/speedCurve/reverse/still）、`clipDuration(clip)`（曲线积分）、`overlaysAt(project,t)`、`snapPoints` 含 overlay 边界、markers、`asset.beats`
- `timeline.js` 编辑纯函数：`rollEdit`、`slipEdit`、`slideEdit`、`rippleDelete`、`trimLeftAt(project,t)`（Q）、`trimRightAt(project,t)`（W）
- `timeline.js` 音频：`autoDuck(project,{amount=0.25,attack=0.2,release=0.4})->{[audioId]:volumeKeys}`，`nearestBeat(beats,t)`
- `src/engine/captions.js`（W10）：`segmentsToTexts(segments,{preset,aspect})`、`textsToSrt(texts)`、`parseSrt(str)`、`mergeSegments/splitSegment`

## 3. ops（W5 实现 validate+apply+describe；UI 只能经 `store.apply(op)` 调用）
新 op 类型（参数对象字段名即合同）：
`setClipProps{id,patch}`（reverse/mirror/crop/fit/canvas/opacity/blend/mask/muted）、`freezeFrame{at,duration=2}`、`setSpeedCurve{id,curve|null,preset?}`、`setKeyframe{target:'clip'|'overlay'|'audio',id,path,t,v,ease}`、`removeKeyframe{target,id,path,t}`、`roll{at,delta}`、`slip{id,delta}`、`slide{id,delta}`、`rippleDelete{ids}`、`trimLeft{at}`、`trimRight{at}`、`addOverlay{assetId,start,track}`、`updateOverlay{id,patch}`、`removeOverlay{id}`、`setTrack{track,patch}`、`addMarker{t,label}`、`removeMarker{id}`、`addCaptions{segments,preset}`、`updateCaptionStyle{patch}`、`clearCaptions{}`、`autoDuck{amount}`、`detachAudio{id}`、`snapCutsToBeats{assetId}`、`setTransitionAll{type,duration}`、`pasteAttributes{from,toIds,keys}`
history.js：`apply(op,{label,mergeKey})`，相同 mergeKey 且 <600ms 合并为一步；`undoLabel()/redoLabel()` 返回中文描述；选区随撤销恢复。

## 4. IPC / preload / api.js（W4 拥有 preload.cjs 与 src/ui/api.js，按此表暴露；实现方见括号）
- `videogen:providers` → `[{id,label,caps,configured,priceHint}]`（W4）
- `videogen:test {provider}` → `{ok,error?}`（W4）
- `videogen:generate {projectId,shotId?,provider,prompt,negative?,imageAssetId?,duration,ratio,res}` → `{jobId}`；完成时 job 结果 `{asset}`（已导入，asset.source='videogen'）（W4）
- `videogen:resume {projectId,tasks}` → 恢复轮询（W4）
- `asr:status` → `{ready,engine,model,downloadable}`；`asr:transcribe {projectId,assetId|audioPath,lang='zh'}` → `{jobId}`，结果 `{segments:[{start,end,text,words?}]}`（W10）
- `asr:installModel` → `{jobId}`（W10）
- `export:frame {projectId,t}` → png 路径；`export:start` 新增 `preset`、`srt:boolean`、`audioOnly`、`gif`、`hwaccel:'auto'|'off'`（W6）
- `stock:search` 维持 web.cjs 现有通道，默认源顺序改为 `['pexels','pixabay','commons']`（W3）
- api.js 导出：`videogen.{providers,test,generate,resume}`、`asr.{status,transcribe,installModel}`、`exportFrame`
- main.cjs（W12）负责 `require('./ipc/videogen.cjs')` 与 `require('./ipc/asr.cjs')` 注册（模块导出 `register(ctx)`，与现有 ipc 一致）。

## 5. 导出预设（W6 定义于 src/export/presets.js，ExportDialog 与 InspProject 共用）
`EXPORT_PRESETS=[{id:'douyin',label:'抖音/快手 1080×1920 30fps'},{id:'bilibili',label:'B站 1080p60'},{id:'shipinhao'},{id:'youtube4k'},{id:'custom'},{id:'audio-mp3'},{id:'gif'}]`，每项含 `{w,h,fps,bitrate,format}`。

## 6. 界面约定（W1 设计系统，其他包只消费）
- 令牌（tokens.css）：`--bg-0..3 --line --line-strong --text-0..3 --accent(#c8e250) --ai(#9d8cff) --ok --warn --danger --track-video --track-overlay --track-text --track-audio --fs-11/12/13/15/18/24 --space-1..8(4px 网格) --radius-xs4/sm8/md12/lg16 --shadow-float`
- ui.jsx 导出：`Button{variant:'primary'|'secondary'|'ghost'|'icon',size:'sm'|'md'|'lg'}`、`SplitButton{label,onClick,items:[{id,label,icon,onClick}]}`、`Drawer{open,side,width,title,onClose}`、`Segmented{options,value,onChange}`、`Tabs`、`Tooltip{label,kbd}`、`Icon{name,size:14|16|20}`（Lucide 风格 1.5px 描边）、`EmptyState{icon,title,desc,action}`、`KeyframeButton{active,onToggle,onPrev,onNext}`、`Slider{label,value,min,max,onChange,onReset,keyframe?}`
- 每屏仅一个 primary 按钮：全局「导出」在顶栏；创作模式主按钮为「生成全部画面」；精修主按钮即顶栏导出。
- store 新增（W1 写 store.js）：`onboarding:{create,refine,library}:boolean`、`layout:{refineLeft,refineRight,timelineH,createChatCollapsed}`（持久化到 settings.ui）、`drawer:'ai'|'brief'|null`、`selection` 保持现有结构并支持 `{kind:'overlay'|'caption'|'marker'}`。
- Coachmark：`<Coachmark mode steps=[{target:'[data-tour=xxx]',title,desc}]/>`；各模式在关键元素加 `data-tour` 属性：create：`create-chat`、`create-generate`、`create-go-refine`；refine：`refine-media`、`refine-timeline`、`refine-inspector`、`export`；library：`library-add`。
- 样式文件归属：tokens/base/shell→W1，create.css→W2，refine-side.css→W7（素材区+AI 抽屉），refine.css→W8（时间线），refine-inspector.css（新）→W9（属性区+播放器），library.css→W11。App.jsx（W1）负责 import 全部 css 和 React.lazy 拆分三个模式与对话框。
- 精修四区 DOM（W7 RefineMode 提供）：`.rf-grid > .rf-media | .rf-preview | .rf-inspector / .rf-timeline`，分隔条可拖，尺寸写 `store.layout`。

## 7. 真人实拍约定
- 自动配素材链：用户素材 > AI 视频(aiVideoAssetId) > 实拍(footageAssetId) > previz（仅占位，渲染时带「示意」水印，由 W6 compositor 在 asset.source==='previz' 时绘制）。
- 示例项目：`build/sample-media/*.mp4`（Pexels 许可视频，720p，4–6s，6–8 段，总 ≤40MB）+ `build/sample-media/manifest.json [{file,shotIndex,credit,url,license}]`；electron-builder `extraResources` 打包；运行时由 W3 sample.js 通过 `api.appInfo().resources` 路径引用。
- 无 Pexels key 时提示「实拍素材需填写免费 Pexels Key（30 秒申请）」，入口打开设置对应字段，**不再回退成卡通作为成品**。

## 8. 工作包总览
见 workflow 输出 packages（W1–W12）。验收通用：`npx vite build` 成功；`node --test tests\*.test.mjs` 全绿；涉及界面的包须用 `node e2e/smoke.mjs`（W12 修好后）或自写 harness 截图，并用 Read 自查截图。

## R2. 第二轮共享约定
- 初剪文案字幕：firstcut 生成 `project.timeline.texts[]` TextClip，带 `source:'shot-caption'`、`linkShotId`（对应主轨片段 id）；预览不再从镜头文案直接画字幕，只渲染文字轨（避免双份）。
- 联动：`timeline.linked`（默认 true）为真时，主轨片段移动/裁剪/删除，ops 内同步处理 `linkShotId` 相同的文字与 `linkClipId` 相同的音频片段（平移同等偏移、删除一并删除）。一次 op 一步撤销。
- 贴纸：沿用现有数据字段，渲染在 compositor 的文字层之前（贴纸在下、文字在上），导出走同一 compositor。
- 变速音频：audioPlan 对曲线变速片段输出分段 atempo 链（每段 ≥0.25s，倍速钳在 0.5–2，超出串联），预览与导出共用 `speedSegments(clip)`（放在 src/export/audioPlan.js 导出）。
- 播放倍速：usePlayback 暴露 `rate`（可负），J/K/L 档位 ±1/2/4。
- e2e 新流程脚本为 e2e/full-flow.mjs，smoke.mjs 保持不变以免冲突。
