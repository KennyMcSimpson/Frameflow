<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/hero-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="docs/images/hero-light.svg" />
  <img src="docs/images/hero-dark.svg" alt="镜流 Frameflow — 本地优先、可嵌入编码 Agent 的桌面视频创作、多轨精修与智能拆片工作站" width="100%" />
</picture>

<br />

<p>
  <a href="https://github.com/KennyMcSimpson/Frameflow/actions/workflows/ci.yml"><img src="https://github.com/KennyMcSimpson/Frameflow/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="./.github/workflows/windows-release.yml"><img src="https://img.shields.io/badge/Windows%20Release-NSIS%20%2B%20Portable-0ea5e9?style=flat-square" alt="Windows Release: NSIS + Portable" /></a>
  <a href="./docs/AGENT-INTEGRATION.md"><img src="https://img.shields.io/badge/Agent%20CLI%20%2B%20MCP-Live%20Watch-8b5cf6?style=flat-square" alt="Agent CLI + MCP: Live Watch" /></a>
  <img src="https://img.shields.io/badge/Electron-45-6cb2ff?style=flat-square" alt="Electron 45" />
  <img src="https://img.shields.io/badge/React-19-06b6d4?style=flat-square" alt="React 19" />
  <a href="#测试与打包"><img src="https://img.shields.io/badge/Tests-738%2B%20Node%20%2B%20E2E-10b981?style=flat-square" alt="Tests: 738+ Node + E2E" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-f59e0b?style=flat-square" alt="License: MIT" /></a>
</p>

<p>
  <strong>镜流 Frameflow v2.1.0 — 可嵌入任意编码 Agent 的本地优先桌面视频工作站（Windows）。</strong><br />
  分镜创作 · 多轨非线性精修 · 智能拆片拉片 · 无头 Agent CLI 与实时热重载 · 硬件加速 LGPL FFmpeg 导出 — 中英双语界面、无账号、零遥测、完整离线剪辑。
</p>

<p>
  <a href="./README.md">English</a> · <strong>简体中文</strong> &nbsp;|&nbsp;
  <a href="#为什么选择-frameflow">为什么选择</a> ·
  <a href="#三大一体化工作区">三大工作区</a> ·
  <a href="#将-frameflow-嵌入任意编码-agent">Agent 协作</a> ·
  <a href="#ai-与免密钥素材生态">AI 与素材生态</a> ·
  <a href="#架构与安全设计">架构与安全</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="./CHANGELOG.md">更新日志</a>
</p>

</div>

<p align="center">
  <img src="docs/images/studio-editor.png" alt="镜流 Frameflow 精修工作区界面：展示清晨咖啡示例工程、素材库、实时 Canvas2D 预览、多轨时间线与参数检查器" width="100%" />
  <br />
  <sub><strong>精修工作区（Refine）</strong> — 内置「清晨咖啡（Morning Coffee）」示例工程，含素材箱、统一 Canvas2D 实时预览、多轨时间线、片段参数检查器，并支持顶栏/设置一键切换中英双语界面。</sub>
</p>

---

## 为什么选择 Frameflow

相比云端 AI 视频工具和传统重型剪辑软件，**镜流 Frameflow v2.1** 把「本地隐私、Outside-In Agent 协同剪辑、多模型中立生态与可审计桌面安全边界」合为一体：

| 对比维度 | 云端 AI 视频工具 | 传统重型剪辑软件（NLE） | **镜流 Frameflow v2.1** |
| :--- | :--- | :--- | :--- |
| **隐私与资产主权** | 素材与草稿上传厂商云端，强绑定账号与按月点数消耗。 | 文件保存在本地，但常附带账号登录、后台更新器或遥测。 | **100% 本地优先** — 工程、素材、缓存与日志均留在本机磁盘；无账号、零遥测，BYOK 密钥经 Windows DPAPI 加密，不填密钥即可离线剪辑与导出。 |
| **Agent 嵌入协同** | 封闭网页画布，无法由外部编码 Agent 编程驱动或审查工程结构。 | 私有二进制工程与重型原生插件 SDK，难以融入 LLM Agent 工作流。 | **Outside-In 协作架构** — 无头 `frameflow` CLI + 跨宿主 `SKILL.md` + 按需薄 MCP（支持 `--readonly`）原子修改 `.ffproj` 工程，桌面端 **Live Watch `<100ms` 实时热重载**并进撤销栈，随时 **`Ctrl+Z` 撤回**。 |
| **从创意到时间线** | 生成单条片段很快，但绑定单一厂商模型且多轨精修薄弱。 | 精修能力强，但 AI 分镜、动态预演与参考拉片分散在多个工具中。 | **中立多引擎流水线** — 8 个中立 API 预设 + 3 个平权可选本机 Agent CLI + 8 家 AI 视频引擎 + 免密钥素材 → 一键粗剪 → 多轨精修，全部修改经 `applyOps` 原子落盘。 |
| **预览与导出一致性** | 云端重渲染易与网页预览偏色/错帧，且常限制分辨率与码率。 | 画面精准，但安装包动辄数 GB，学习与硬件门槛高。 | **单一 Canvas2D 合成器**同时驱动实时播放与精准逐帧导出，通过 Web Worker JPEG 管道喂给 **SHA-256 校验的 LGPL v3 FFmpeg**，支持 GPU 探测（`nvenc`/`qsv`/`amf`/`mf`）与 CPU 自动回退。 |
| **拉片学习与安全边界** | 黑盒云端服务，缺少本地拆片知识库与可验证的本地隔离边界。 | 拉片笔记靠手工整理；原生插件权限面宽。 | **内置拆片库**（自适应切镜/叠化检测、MMCQ 配色提取、70 张离线技法卡），运行于 **Electron 45 加固沙箱**（严格 CSP、异步 DNS SSRF 防护、5 项 Electron Fuses）。 |

---

## 三大一体化工作区

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/workflow-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="docs/images/workflow-light.svg" />
    <img src="docs/images/workflow-dark.svg" alt="镜流 Frameflow 四阶段创作流水线：创作、精修、拆片库与硬件加速导出" width="100%" />
  </picture>
</p>

| 工作区 | 核心能力 |
| :--- | :--- |
| **创作（Create）** | 与 AI 导演（或离线模板导演）对话生成结构化创意简报与逐镜分镜表；为每个镜头填入免密钥开源素材、AI 出图、AI 生成视频或带预演水印的 Canvas2D 动态预演，一键拼装为多轨粗剪时间线。 |
| **精修（Refine）** | 支持磁吸主视频轨、最多 4 条画中画/图片/贴纸叠层轨、多行字幕与标题轨、以及带波形与节拍标记的多片段音轨；内置 14 种调色风格、10 种运镜、16 种转场、8 种特效、蒙版、关键帧、变速曲线，以及区间聚焦 AI / 本地中文自然语言改片。 |
| **拆片库（Breakdown Library）** | 通过单遍扫描自适应切镜与叠化检测、MMCQ 主色调提取、运动/响度/节拍曲线与可选 AI 视觉标注，将本地视频或下载的参考视频拆解为分镜；沉淀可复用**技法卡**（内置 70 张离线技法卡），一键套用到时间线片段。 |

---

## 将 Frameflow 嵌入任意编码 Agent

Frameflow v2.1 采用 **Outside-In（由外向内）** 协作架构，让 Antigravity、Claude Code、Codex CLI、Gemini CLI、OpenCode、PI、Cursor 或 Claude Desktop 都能直接与桌面剪辑界面实时协同编辑多轨 `.ffproj` 视频工程——**默认零后台守护进程、零常驻 MCP 工具表 Token 税**。

```text
  编码 Agent（Antigravity / Claude Code / Codex / Gemini / OpenCode / PI / Cursor / Claude Desktop）
        │
        ├─▶ 默认推荐（0 守护、0 Token 税）：skills/frameflow/SKILL.md + bin/frameflow.mjs
        └─▶ 按需启用（纯 MCP 客户端）：     bin/frameflow-mcp.mjs [--readonly]（6 个强类型 stdio 工具）
        │
        ▼  lintOps → applyOps → diffProject → needsConfirm → 原子写入 + .bak.ffproj + meta.lastAgentEdit
  桌面端 Live Watch（electron/lib/projectWatch.cjs — SHA-256 防回声监听）
        │
        └─▶ 创作/精修界面 <100ms 实时热重载 + 压入撤销栈（按 Ctrl+Z 一键撤回整批 Agent 修改）
```

| 协作层 | 入口文件 | 核心能力 |
| :--- | :--- | :--- |
| **无头 Agent CLI** | `bin/frameflow.mjs` | 零依赖 Node.js CLI，直接调用同一套纯 JS 引擎（`src/engine/`）并支持 `--json` 结构化输出：`init`、`inspect`（`--focus <start>..<end>`）、`ops-schema`、`storyboard`（工程不存在时自动创建，覆写已有工程前写入 `.bak.ffproj` 备份，与 MCP `frameflow_storyboard` 一致）、`apply`（`--ops <ops.json> \| --ops-json '<json>' \| --stdin`，`--ops -` 可作 stdin 别名；含 `--dry-run` / `--allow-destructive`）、`breakdown`、`stock search`、`export-srt`、`export-plan` 与 `doctor`。 |
| **桌面端 Live Watch** | `electron/lib/projectWatch.cjs` | 监听当前工程文件父目录并按精确文件名过滤（兼容 Windows 原子重命名），通过 SHA-256 摘要过滤客户端自身保存，**`<100ms`** 刷新桌面时间线与画面并压入撤销栈，随时 **`Ctrl+Z`** 撤回。 |
| **跨宿主 Agent Skill** | `skills/frameflow/SKILL.md` | 零硬编码路径的跨端技能规程，适配 **Antigravity、Claude Code、Codex CLI、Gemini CLI、OpenCode 与 PI**，规范执行 inspect → `ops-schema` → `--dry-run` → 原子 `apply` 及破坏性改动确认闸门。 |
| **按需薄 MCP 服务** | `bin/frameflow-mcp.mjs` | 零依赖 stdio MCP 封装，暴露 **6 个极简强类型工具**（`frameflow_inspect`、`frameflow_ops_schema`、`frameflow_apply_ops`、`frameflow_storyboard`、`frameflow_stock_search`、`frameflow_export_srt`），兼容 `Content-Length` 与 `ndjson` 帧协议及 `--readonly` 只读模式。 |

```powershell
# 1. 创建竖屏短视频工程，自动生成分镜与预演粗剪
#    （demo.ffproj 不存在时自动创建；覆写已有工程前写入 demo.bak.ffproj 备份，与 MCP frameflow_storyboard 一致）
node bin/frameflow.mjs storyboard demo.ffproj --brief "25s warm specialty coffee promo" --duration 25 --aspect 9:16 --first-cut --agent "claude-code" --json

# 2. 查看工程结构（可用 --focus 0..15 聚焦时间区间，亦兼容 0:15）、免密钥素材检索与本地拆片分析
node bin/frameflow.mjs inspect demo.ffproj --focus 0..15 --json
node bin/frameflow.mjs stock search "coffee pour slow motion" --kind video --limit 8 --json
node bin/frameflow.mjs breakdown sample.mp4 --json

# 3. 先演练校验不落盘（支持 --ops <ops.json> | --ops-json '<json>' | --stdin，--ops - 为 stdin 别名），确认无误后原子提交（<100ms 热重载 + Ctrl+Z）
node bin/frameflow.mjs apply demo.ffproj --ops edits.json --dry-run --json
node bin/frameflow.mjs apply demo.ffproj --ops edits.json --agent "claude-code" --label "暖色调色 + 叠化转场" --json

# 4. 直接从字幕轨导出 .srt 文件
node bin/frameflow.mjs export-srt demo.ffproj --out demo.srt --json
```

> **完整接入指南：** 详见 **[docs/AGENT-INTEGRATION.md](docs/AGENT-INTEGRATION.md)**（含完整 CLI 参数、`ops-schema` 载荷、`needsConfirm` 安全闸门、跨宿主 `SKILL.md` 安装及 Claude Desktop / Cursor / Windsurf 的 MCP 配置）。

---

## AI 与免密钥素材生态

Frameflow 将外部服务配置与核心剪辑引擎彻底解耦——你可以自由混搭中立 API 预设、本地无密钥模型、平权可选本机 Agent CLI 与免密钥开放版权素材，也可以全程离线创作。

| 能力模块 | 支持的服务与引擎 | 说明 |
| :--- | :--- | :--- |
| **中立多 API 预设（默认）** | **OpenAI**、**DeepSeek**、**Anthropic Claude**（原生 Messages API）、**Google Gemini**、**OpenRouter**、**火山方舟（Ark）**，以及免密钥本机 **Ollama** / **LM Studio**（`electron/lib/aiPresets.cjs`） | 严格 JSON Schema 输出并携带全工程上下文记忆；未配置时自动降级为离线本地导演与规则引擎（`localnlp`） |
| **平权可选本机 Agent CLI** | **Claude Code (`claude`)**、**Codex CLI (`codex`)**、**Gemini CLI (`gemini`)**（`electron/lib/agentCli.cjs`） | 三家平权且严格**按需显式开启**，绝不静默劫持你已配置的 API Key 或默认中立预设 |
| **AI 出图** | 火山方舟（即梦 Seedream）、OpenAI 兼容出图接口 | 未配置时自动回退为明确标注预演水印的 Canvas2D 动态预演 |
| **AI 视频生成** | Seedance（火山方舟）、Runway Gen-4、Luma Ray 2、可灵 Kling、MiniMax 海螺、Google Veo、OpenAI Sora 2、Fal.ai | 内置本机 `mock` 演示适配器与按服务商维度的并发限流 |
| **语音转字幕（ASR）** | 按需下载本机 `whisper.cpp`（ggml 模型）或云端 OpenAI Whisper API | 本机模式在首次下载模型后全程离线运行、音频不离机；支持导出 `.srt` |
| **免密钥与可选素材库** | Wikimedia Commons、Openverse、Internet Archive、NASA（免 API Key）；可选 Pexels、Pixabay 及经确认启用的 `yt-dlp` | 附带 Mixkit「清晨咖啡」示例素材与 23 首 CC0 背景音乐/音效（FreePD + 合成音效） |
| **导出与合规交付** | 内置 SHA-256 校验的 LGPL v3 FFmpeg/FFprobe（`MP4`、`MOV`、`GIF`、`MP3`、`WAV`、`SRT`） | Web Worker JPEG 编码管道、GPU 探测与 CPU 回退、BT.601→BT.709 色彩标记、素材署名清单与 GB 45438-2025 AIGC 标识 |
| **中英双语桌面界面** | 实时切换 **`English` (`en-US`)** 与 **`简体中文` (`zh-CN`)**（`src/ui/i18n.js`） | 可在 **顶栏（TopBar）** 或 **设置（Settings）** 中一键无缝切换，自动持久化且无需重启窗口 |

---

## 架构与安全设计

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/architecture-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="docs/images/architecture-light.svg" />
    <img src="docs/images/architecture-dark.svg" alt="镜流 Frameflow v2.1 Electron 分层安全、媒体与 Agent 架构图" width="100%" />
  </picture>
</p>

- **纯净可测的核心引擎（`src/engine/`）** — 零 DOM 与 Electron 依赖；时间线排布、原子编辑协议（`applyOps`）、色彩匹配、节奏对齐、变速曲线与本地自然语言解析在桌面端、`bin/frameflow.mjs` 与 `node --test` 中完全一致地运行。工程保存采用临时文件 + `fsync` + 原子重命名及 `.prev.json` 断电恢复。
- **Agent CLI、Live Watch 与按需薄 MCP（`bin/`、`electron/lib/projectWatch.cjs`）** — `bin/frameflow.mjs` 与 `bin/frameflow-mcp.mjs` 共享同一套 `lintOps` → `applyOps` → `diffProject` → `needsConfirm` 流水线与 `.bak.ffproj` 原子备份；`projectWatch.cjs` 通过父目录监听与 SHA-256 摘要过滤自身保存，`<100ms` 捕捉外部原子写入并压入可撤销历史栈。
- **预览与导出共享同一合成器（`src/render/`、`src/export/`）** — 单一 Canvas2D 渲染管线同时服务实时预览与精确寻帧导出，通过内联 Web Worker（`jpegEncoder.worker.js`）异步压缩 JPEG，并以有界 32 帧背压队列写入 FFmpeg `image2pipe`。
- **Electron 45 加固沙箱与严格 CSP（`electron/main.cjs`、`src/index.html`）** — 强制开启 `contextIsolation: true`、`sandbox: true`（`app.enableSandbox()`）与主帧来源校验（`isTrustedSender`）；生产 CSP 设置 `connect-src 'self' ffmedia:` 阻断渲染进程直连外部 API 的 XHR/fetch/WebSocket 请求，同时 `img-src` / `media-src` 放行 `https:` 以渲染素材缩略图与预览。
- **本地路径与出站网络双重防线（`electron/ipc/system.cjs`、`electron/lib/urlSafety.cjs`）** — `ffmedia://` 仅向白名单内的工程/媒体路径提供 Range 流式读取（越界返回 `403`）；`shell:openPath` 强制校验 18 个扩展名白名单（`ALLOWED_OPEN_EXT`）并执行 fail-closed `realpath` 解析、UNC 路径拦截及尾部点/空格防护；异步 DNS SSRF 防护拦截环回、内网、链路本地、CGNAT 及 IPv6 映射地址，同时通过 `isTrustedHostForBase` 防止鉴权头跨站泄露。
- **凭据加密与 5 项 Electron Fuses** — 用户 API Key 经 Electron `safeStorage`（Windows DPAPI）加密存于 `%APPDATA%\Frameflow\secrets.json`，永不以明文返回渲染进程，日志写入前由 `log.redact()` 自动脱敏；本机 Agent CLI 适配层严格校验可执行文件路径（UNC/realpath 防护）与模型名（防参数注入），并设输出上限与取消时进程树清理。打包阶段自动校验全部 5 项 Electron Fuses（`RunAsNode`、`NodeOptions`、`NodeCliInspect`、`EmbeddedAsarIntegrityValidation`、`OnlyLoadAppFromAsar`）。
- **深入阅读** — 详细模块边界与 IPC 协议见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，Agent 协作接入见 [docs/AGENT-INTEGRATION.md](docs/AGENT-INTEGRATION.md)，本地存储与联网披露见 [docs/PRIVACY.md](docs/PRIVACY.md)（[English](docs/PRIVACY.en.md)），安全漏洞上报流程见 [SECURITY.md](SECURITY.md)。

---

## 快速开始

> **中英双语界面：** 桌面客户端现已完整内置 **简体中文（`zh-CN`）** 与 **English（`en-US`）** 双语界面，可随时在**顶栏**或**设置**中即时切换，无需重启应用。

### 方式一：下载自动构建的 Windows 发行版
每次推送版本标签（`v*`）时，[.github/workflows/windows-release.yml](.github/workflows/windows-release.yml) 会自动完成全套测试与安全审计，并在 GitHub Releases 发布三件套 Windows x64 产物：
- **NSIS 安装包**（`Frameflow-<version>-x64.exe`）
- **绿色便携版**（`Frameflow-Portable-<version>.exe`）
- **校验清单**（`SHA256SUMS.txt`）

### 方式二：从源码运行
**环境要求：** Windows 10/11（x64）与 [Node.js 22+](https://nodejs.org/)。

```powershell
git clone https://github.com/KennyMcSimpson/Frameflow.git
cd Frameflow
npm ci

# 可选：拉取「清晨咖啡」示例视频与内置 CC0 音频素材库
npm run fetch:sample-media
npm run fetch:builtin-audio

# 启动 Vite 开发服务器与 Electron 客户端
npm run dev
```

开发模式下，Frameflow 会优先从 `vendor/ffmpeg/bin` 解析 FFmpeg（若已运行 `npm run fetch:ffmpeg`），否则自动回退到 npm 安装的 `ffmpeg-static` / `ffprobe-static`。正式打包构建严格仅随包分发经 SHA-256 校验的 LGPL v3 动态链接版 FFmpeg，并彻底排除 GPL 静态包。

---

## 测试与打包

```powershell
# 单元测试与模块测试（引擎、Agent CLI、薄 MCP、中立预设、双语 i18n、Live Watch 与安全回归）
npm test

# 构建生产版渲染进程资源（Vite -> dist-renderer/）
npm run build:renderer

# Playwright + Electron 端到端冒烟测试
npm run e2e

# 全链路端到端测试（导入素材 -> 多轨编辑 -> 导出 MP4 -> FFprobe 校验）
npm run e2e:full

# 构建 Windows NSIS 安装包与绿色便携版（含 LGPL FFmpeg 拉取、许可清单生成、Fuses 与 ASAR 审计）
npm run dist
npm run dist:portable
```

打包流程会自动执行 `scripts/after-pack.cjs` 与 `scripts/check-artifacts.mjs`，逐项核验 5 项 Electron Fuses、LGPL v3 FFmpeg 合规性、第三方许可文件、`app.asar` 中无 sourcemap 或 GPL 静态二进制文件以及体积预算。打版本标签时，[.github/workflows/windows-release.yml](.github/workflows/windows-release.yml) 会自动执行完整构建并产出 NSIS 安装包、Portable `.exe` 及 `SHA256SUMS.txt`。

---

## 项目结构

```text
Frameflow/
├── .github/workflows/
│   ├── ci.yml                  # 跨平台 Node 22/24 持续集成（单测 + Vite 渲染构建）
│   └── windows-release.yml     # 标签触发自动构建 Windows NSIS + Portable .exe + SHA256SUMS.txt
├── bin/
│   ├── frameflow.mjs           # 无头 Agent CLI（init、inspect、storyboard、apply、breakdown、stock、export-srt）
│   └── frameflow-mcp.mjs       # 按需启用的薄 stdio MCP 服务（复用 CLI 原语）
├── skills/
│   └── frameflow/
│       └── SKILL.md            # 跨宿主编码 Agent 技能包（Claude Code、Codex、Gemini、Cursor、Antigravity、PI）
├── electron/
│   ├── main.cjs                # 加固 Electron 主进程、ffmedia:// 协议、Live Watch 接入、崩溃恢复
│   ├── preload.cjs             # 沙箱 contextBridge，暴露最小化 window.ff 接口
│   ├── ipc/                    # 9 个业务域 IPC 模块（store、media、export、ai、videogen、asr、analysis、web、system）
│   └── lib/                    # projectWatch.cjs、aiPresets.cjs、agentCli.cjs、FFmpeg/编码器探测、拆片 worker、urlSafety、safeStorage、视频生成适配器
├── src/
│   ├── engine/                 # 纯 JS 剪辑引擎（model、timeline、ops、history、keyframes、localnlp、70 张技法卡）
│   ├── render/                 # Canvas2D 合成器、14 种风格、转场、运镜、文字、动态预演、mediaPool
│   ├── ai/                     # 严格 JSON Schema、导演/精修/拆片提示词、离线 localDirector
│   ├── export/                 # 导出驱动、Web Worker JPEG 编码器、audioPlan、预设、AIGC 标识元数据
│   ├── ui/                     # React 19 双语界面（i18n.js EN/ZH、创作/精修/拆片库工作区、弹窗、Zustand 状态库）
│   └── styles/                 # 暗色工作室设计令牌与样式表
├── scripts/                    # 开发启动器、LGPL FFmpeg 拉取脚本、示例/音频拉取脚本、许可与产物审计
├── tests/                      # Node 单元与集成测试套件（*.test.mjs）
├── e2e/                        # Playwright Electron 冒烟、全流程、打包产物与渲染测试套件
├── build/                      # 应用图标、MIT 安装许可、隐私说明、生成的 THIRD_PARTY_LICENSES.txt
└── docs/                       # ARCHITECTURE.md、AGENT-INTEGRATION.md、双语隐私说明、深浅自适应 SVG 图与素材许可
```

---

## 开源协议与第三方声明

- **源代码协议：** 采用 [MIT License](LICENSE) 开源。
- **随包 FFmpeg：** 未经修改地分发动态链接版 **LGPL v3** 构建（`resources/ffmpeg/`），用户可按 LGPL 条款自行替换；固定源码来源与许可详情见 [build/THIRD_PARTY_LICENSES.txt](build/THIRD_PARTY_LICENSES.txt)。
- **示例素材与内置音频：** Mixkit 免费许可示例视频（[docs/licenses/sample-media.md](docs/licenses/sample-media.md)）及 23 首 CC0 1.0 FreePD 背景音乐 / 合成音效。
- **隐私与社区文档：** [Agent 协作指南](docs/AGENT-INTEGRATION.md) · [系统架构](docs/ARCHITECTURE.md) · [隐私说明 (中文)](docs/PRIVACY.md) · [Privacy Notice (English)](docs/PRIVACY.en.md) · [安全策略](SECURITY.md) · [贡献指南](CONTRIBUTING.md) · [更新日志](CHANGELOG.md)
