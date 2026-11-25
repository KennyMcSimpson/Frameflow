// 通用 UI 组件（W1 设计系统，PLAN-v3 §6）。各模块统一使用，保持风格一致。
// 导出：Icon Button SplitButton Menu Drawer Segmented Tabs Tooltip EmptyState(Empty) KeyframeButton Slider
//      Select Switch Field Modal ProgressBar Spinner Chip Kbd fmtTime fmtBytes ICON_NAMES hasIcon
// 图标路径：部分移植自 Lucide（ISC License，https://lucide.dev，© Lucide Contributors）
//          与 Feather（MIT License，https://feathericons.com，© Cole Bemis），按 24 网格改写为单条 path。
// 无障碍（Frameflow4 · design）：Modal/Drawer 共用浮层栈，Esc 只关最上层；Modal 焦点圈定、关闭后焦点回到键盘用户的触发处；
//          Menu ↑↓/Home/End；Segmented/Tabs 方向键切换（单一 Tab 停靠点）；Slider 点数值可直接输入、Shift+方向键大步。
import React, { cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// ---------- 图标（内联 SVG，24 网格，Lucide 风格 1.5px 描边） ----------
const P = {
  // 播放
  play: 'M7 4.5l12.5 7.5L7 19.5z',
  pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
  stop: 'M6 6h12v12H6z',
  skipBack: 'M19 20L9 12l10-8zM5 19V5',
  skipFwd: 'M5 4l10 8-10 8zM19 5v14',
  stepBack: 'M18 6l-7 6 7 6M8 6v12',
  stepFwd: 'M6 6l7 6-7 6M16 6v12',
  loop: 'M17 2l4 4-4 4M3 11V10a4 4 0 014-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 01-4 4H3',
  // 历史
  undo: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 010 11H11',
  redo: 'M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 000 11H13',
  // 剪辑
  scissors: 'M6 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12',
  split: 'M12 3v18M8 7H4v10h4M16 7h4v10h-4',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
  ripple: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M9 13h6M12 10l3 3-3 3',
  snowflake: 'M12 2v20M4.93 4.93l14.14 14.14M2 12h20M4.93 19.07L19.07 4.93M9 4l3 2 3-2M9 20l3-2 3 2M4 9l2 3-2 3M20 9l-2 3 2 3',
  rewind: 'M11 19l-9-7 9-7zM22 19l-9-7 9-7z',
  flip: 'M12 3v18M8 7L3 17h5zM16 7l5 10h-5z',
  flipV: 'M3 12h18M7 8L17 3v5zM7 16l10 5v-5z',
  crop: 'M6 2v14a2 2 0 002 2h14M18 22V8a2 2 0 00-2-2H2',
  magnet: 'M6 15l-4-4 6.75-6.77a7.79 7.79 0 0111 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 00-3-3zM5 8l4 4M12 15l4 4',
  zoom: 'M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4',
  zoomIn: 'M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4M11 8v6M8 11h6',
  zoomOut: 'M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4M8 11h6',
  fit: 'M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5',
  keyframe: 'M12 3l9 9-9 9-9-9z',
  keyframeFill: 'M12 3l9 9-9 9-9-9z',
  speed: 'M12 14l4-4M3.34 19a10 10 0 1117.32 0',
  rotate: 'M21 12a9 9 0 11-3-6.7L21 8M21 3v5h-5',
  mask: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 3v18',
  blend: 'M9 15a6 6 0 100-12 6 6 0 000 12zM15 21a6 6 0 100-12 6 6 0 000 12z',
  pip: 'M3 5h18v14H3zM12 12h7v5h-7z',
  marker: 'M6 3h12v13l-6 5-6-5z',
  link: 'M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71',
  unlink: 'M18.84 12.25l1.72-1.71a5 5 0 00-7.07-7.07l-1.72 1.71M5.17 11.75l-1.71 1.71a5 5 0 007.07 7.07l1.71-1.71M8 2v3M2 8h3M16 22v-3M22 16h-3',
  duck: 'M3 12h4l3-7 4 14 3-7h4',
  beat: 'M2 12h3l2-6 3 12 3-9 2 3h7',
  detach: 'M3 5h18v6H3zM3 15h8v4H3zM15 17h6M18 14v6',
  // 素材
  film: 'M3 3h18v18H3zM7 3v18M17 3v18M3 7.5h4M3 12h18M3 16.5h4M17 7.5h4M17 16.5h4',
  video: 'M2 6h14v12H2zM16 10l6-4v12l-6-4',
  image: 'M3 4h18v16H3zM3 16l5-5 4 4 3-3 6 6M15.5 9.5a1.5 1.5 0 100-.01',
  music: 'M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zM21 16a3 3 0 11-6 0 3 3 0 016 0z',
  mic: 'M12 2a3 3 0 00-3 3v7a3 3 0 006 0V5a3 3 0 00-3-3zM19 10v2a7 7 0 01-14 0v-2M12 19v3',
  text: 'M4 7V4h16v3M9 20h6M12 4v16',
  type: 'M4 7V4h16v3M9 20h6M12 4v16',
  captions: 'M3 5h18v14H3zM7 15h4M15 15h2M7 11h2M13 11h4',
  sticker: 'M15.5 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V8.5zM15 3v6h6M8 13h.01M16 13h.01M10 16.5a3 3 0 004 0',
  layers: 'M12 2l10 5-10 5L2 7zM2 17l10 5 10-5M2 12l10 5 10-5',
  transition: 'M4 6h7v12H4zM13 6h7v12h-7zM11 12h2',
  palette: 'M12 22a10 10 0 110-20c5.5 0 10 4 10 9a5 5 0 01-5 5h-1.8a1.5 1.5 0 00-1.1 2.5A1.5 1.5 0 0112 22zM7.5 11.5h.01M10.5 7.5h.01M15.5 7.5h.01M17.5 11.5h.01',
  filter: 'M22 3H2l8 9.46V19l4 2v-8.54z',
  // AI
  sparkles: 'M9.94 14.06L4 12l5.94-2.06L12 4l2.06 5.94L20 12l-5.94 2.06L12 20zM20 3v4M22 5h-4M4 17v4M6 19H2',
  wand: 'M15 4V2M15 10V8M11 6h2M17 6h2M3 21L14 10M12.5 6.5l5 5',
  brain: 'M9.5 2A2.5 2.5 0 007 4.5v.1A3 3 0 004.5 8 3 3 0 003 11a3 3 0 001.2 2.4A3 3 0 006 18a3 3 0 003.5 3 2.5 2.5 0 002.5-2.5V4.5A2.5 2.5 0 009.5 2zM14.5 2A2.5 2.5 0 0117 4.5v.1A3 3 0 0119.5 8 3 3 0 0121 11a3 3 0 01-1.2 2.4A3 3 0 0118 18a3 3 0 01-3.5 3 2.5 2.5 0 01-2.5-2.5',
  chat: 'M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
  // 通用
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  close: 'M6 6l12 12M18 6L6 18',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4',
  upload: 'M12 15V3M7 8l5-5 5 5M4 15v4a2 2 0 002 2h12a2 2 0 002-2v-4',
  download: 'M12 3v12M7 10l5 5 5-5M4 15v4a2 2 0 002 2h12a2 2 0 002-2v-4',
  export: 'M12 3v12M7 8l5-5 5 5M4 15v4a2 2 0 002 2h12a2 2 0 002-2v-4',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z',
  help: 'M12 22a10 10 0 100-20 10 10 0 000 20zM9.1 9a3 3 0 015.8 1c0 2-3 3-3 3M12 17h.01',
  info: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 16v-4M12 8h.01',
  alert: 'M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0zM12 9v4M12 17h.01',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 018 0v4',
  unlock: 'M5 11h14v10H5zM8 11V7a4 4 0 017.8-1.2',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z',
  eyeOff: 'M9.88 9.88a3 3 0 104.24 4.24M10.73 5.08A10.4 10.4 0 0112 5c6.4 0 10 7 10 7a13.2 13.2 0 01-1.67 2.68M6.61 6.61A13.5 13.5 0 002 12s3.6 7 10 7a9.7 9.7 0 005.39-1.61M2 2l20 20',
  volume: 'M11 5L6 9H2v6h4l5 4zM15.54 8.46a5 5 0 010 7.07M19.07 4.93a10 10 0 010 14.14',
  mute: 'M11 5L6 9H2v6h4l5 4zM22 9l-6 6M16 9l6 6',
  folder: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z',
  external: 'M15 3h6v6M21 3l-9 9M18 14v5a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h5',
  globe: 'M12 22a10 10 0 100-20 10 10 0 000 20zM2 12h20M12 2a15 15 0 010 20M12 2a15 15 0 000 20',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  book: 'M4 19.5A2.5 2.5 0 016.5 17H20V3H6.5A2.5 2.5 0 004 5.5zM4 19.5A2.5 2.5 0 006.5 22H20v-5',
  camera: 'M3 8a2 2 0 012-2h2l2-2h6l2 2h2a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2zM12 17a4 4 0 100-8 4 4 0 000 8z',
  focus: 'M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5M12 15a3 3 0 100-6 3 3 0 000 6z',
  copy: 'M9 9h11v11H9zM5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1',
  paste: 'M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2M9 2h6v4H9z',
  refresh: 'M21 12a9 9 0 11-2.64-6.36L21 8M21 3v5h-5',
  reset: 'M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8M3 3v5h5',
  chevronDown: 'M6 9l6 6 6-6',
  chevronUp: 'M18 15l-6-6-6 6',
  chevronRight: 'M9 6l6 6-6 6',
  chevronLeft: 'M15 6l-6 6 6 6',
  // 三个实心圆点（在 FILLED 中）：原来是 0.01 长的圆头线段，16px 下几乎看不见（v-create B1）
  dots: 'M5 10.25a1.75 1.75 0 110 3.5 1.75 1.75 0 010-3.5zM12 10.25a1.75 1.75 0 110 3.5 1.75 1.75 0 010-3.5zM19 10.25a1.75 1.75 0 110 3.5 1.75 1.75 0 010-3.5z',
  more: 'M5 10.25a1.75 1.75 0 110 3.5 1.75 1.75 0 010-3.5zM12 10.25a1.75 1.75 0 110 3.5 1.75 1.75 0 010-3.5zM19 10.25a1.75 1.75 0 110 3.5 1.75 1.75 0 010-3.5z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  home: 'M3 10.5L12 3l9 7.5M5 9v12h14V9',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  sun: 'M12 17a5 5 0 100-10 5 5 0 000 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  clock: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 6v6l4 2',
  log: 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M8 13h8M8 17h5',
  maximize: 'M8 3H5a2 2 0 00-2 2v3M21 8V5a2 2 0 00-2-2h-3M3 16v3a2 2 0 002 2h3M16 21h3a2 2 0 002-2v-3',
  panelLeft: 'M3 4h18v16H3zM9 4v16',
  panelRight: 'M3 4h18v16H3zM15 4v16',
  pin: 'M12 17v5M5 17h14l-2-4V4H7v9z',
  // ---- Frameflow4 新增（契约 C2）----
  // 设备 / 平台
  smartphone: 'M7 2h10a2 2 0 012 2v16a2 2 0 01-2 2H7a2 2 0 01-2-2V4a2 2 0 012-2zM12 18h.01',
  monitor: 'M4 3h16a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2zM8 21h8M12 17v4',
  tv: 'M4 7h16a2 2 0 012 2v11a2 2 0 01-2 2H4a2 2 0 01-2-2V9a2 2 0 012-2zM17 2l-5 5-5-5',
  keyboard: 'M4 4h16a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2zM6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10',
  headphones: 'M3 18v-6a9 9 0 0118 0v6M21 19a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3zM3 19a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3z',
  hardDrive: 'M22 12H2M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11zM6 16h.01M10 16h.01',
  cpu: 'M6 4h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2zM9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3',
  power: 'M18.36 6.64a9 9 0 11-12.73 0M12 2v10',
  cloud: 'M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z',
  cloudOff: 'M22.61 16.95A5 5 0 0018 10h-1.26a8 8 0 00-7.05-6M5 5a8 8 0 004 15h9a5 5 0 001.7-.3M1 1l22 22',
  // 状态
  heart: 'M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z',
  star: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z',
  flag: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7',
  tag: 'M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82zM7 7h.01',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  checkCircle: 'M12 22a10 10 0 100-20 10 10 0 000 20zM9 12l2 2 4-4',
  xCircle: 'M12 22a10 10 0 100-20 10 10 0 000 20zM15 9l-6 6M9 9l6 6',
  alertTriangle: 'M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0zM12 9v4M12 17h.01',
  // 文件 / 操作
  history: 'M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8M3 3v5h5M12 7v5l4 2',
  share: 'M18 8a3 3 0 100-6 3 3 0 000 6zM6 15a3 3 0 100-6 3 3 0 000 6zM18 22a3 3 0 100-6 3 3 0 000 6zM8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98',
  edit: 'M17 3a2.83 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5z',
  folderOpen: 'M6 14l1.5-2.9A2 2 0 019.24 10H20a2 2 0 011.94 2.5l-1.54 6a2 2 0 01-1.95 1.5H4a2 2 0 01-2-2V5a2 2 0 012-2h3.9a2 2 0 011.69.9l.81 1.2a2 2 0 001.67.9H18a2 2 0 012 2v2',
  fileText: 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8',
  // 方向 / 变换
  arrowLeft: 'M19 12H5M12 19l-7-7 7-7',
  arrowRight: 'M5 12h14M12 5l7 7-7 7',
  arrowUp: 'M12 19V5M5 12l7-7 7 7',
  arrowDown: 'M12 5v14M19 12l-7 7-7-7',
  expand: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
  shrink: 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7',
  move: 'M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20',
  hand: 'M18 11V6a2 2 0 00-2-2 2 2 0 00-2 2M14 10V4a2 2 0 00-2-2 2 2 0 00-2 2v2M10 10.5V6a2 2 0 00-2-2 2 2 0 00-2 2v8M18 8a2 2 0 114 0v6a8 8 0 01-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 012.83-2.82L7 15',
  // 影像 / 创作
  clapperboard: 'M20.2 6L3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3zM6.2 5.3l3.1 3.9M12.4 3.4l3.1 4M3 11h18v8a2 2 0 01-2 2H5a2 2 0 01-2-2z',
  aperture: 'M12 22a10 10 0 100-20 10 10 0 000 20zM14.31 8l5.74 9.94M9.69 8h11.48M7.38 12l5.74-9.94M9.69 16L3.95 6.06M14.31 16H2.83M16.62 12l-5.74 9.94',
  lightbulb: 'M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 006 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5M9 18h6M10 22h4',
  moon: 'M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z',
  timer: 'M10 2h4M12 14l3-3M12 22a8 8 0 100-16 8 8 0 000 16z',
  gauge: 'M12 14l4-4M3.34 19a10 10 0 1117.32 0M12 5.5V7M6 8l1.05 1.05M18 8l-1.05 1.05',
  wave: 'M2 10v4M6 6v12M10 3v18M14 8v8M18 5v14M22 10v4',
};
const FILLED = new Set(['play', 'pause', 'stop', 'keyframeFill', 'dots', 'more']);

export const ICON_NAMES = Object.keys(P);
/** 图标名是否存在（调用方可据此选备用图标） */
export const hasIcon = (name) => typeof name === 'string' && Object.prototype.hasOwnProperty.call(P, name);

// 未知图标名：画一个中性小圆点，开发模式下每个名字只提醒一次，绝不抛错（契约 C2）
const warnedIcons = new Set();
const IS_DEV = (() => { try { return !!(import.meta.env && import.meta.env.DEV); } catch { return false; } })();
function warnUnknownIcon(name) {
  if (!IS_DEV || warnedIcons.has(name)) return;
  warnedIcons.add(name);
  try { console.warn(`[Icon] 未知图标名「${name}」，已用占位圆点代替。可用图标见 ui.jsx 的 ICON_NAMES。`); } catch { /* 忽略 */ }
}

export function Icon({ name, size = 16, stroke = 1.5, className = '', style, title }) {
  const known = hasIcon(name);
  if (!known && name) warnUnknownIcon(String(name));
  const d = known ? P[name] : null;
  const filled = known && FILLED.has(name);
  return (
    <svg className={'icon ' + className} width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={filled ? (name === 'keyframeFill' ? stroke : 0) : stroke} strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none', ...style }} aria-hidden={title ? undefined : 'true'} role={title ? 'img' : undefined} data-icon={known ? undefined : 'unknown'}>
      {title && <title>{title}</title>}
      {d ? <path d={d} /> : (name ? <circle cx="12" cy="12" r="2.25" fill="currentColor" stroke="none" opacity="0.55" /> : null)}
    </svg>
  );
}

export function Kbd({ children }) { return <kbd>{children}</kbd>; }

// ---------- Tooltip ----------
/** 悬停 400ms 显示，支持快捷键与一行说明。包裹单个子元素。 */
export function Tooltip({ label, kbd, desc, side = 'bottom', children, disabled }) {
  const ref = useRef(null);
  const timer = useRef(null);
  const [pos, setPos] = useState(null);
  const show = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({ x: r.left + r.width / 2, y: side === 'top' ? r.top - 8 : r.bottom + 8 });
    }, 400);
  }, [side]);
  const hide = useCallback(() => { clearTimeout(timer.current); setPos(null); }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  // 提示出现时按 Esc 先收起提示（不拦截，Esc 照常传给对话框等）
  useEffect(() => {
    if (!pos) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') hide(); };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pos, hide]);
  if (disabled || (!label && !desc)) return children;
  return (
    <span className="tip-wrap" ref={ref} onMouseEnter={show} onMouseLeave={hide} onMouseDown={hide} onFocus={show} onBlur={hide}>
      {children}
      {pos && typeof document !== 'undefined' && createPortal(<TipBubble pos={pos} side={side} label={label} kbd={kbd} desc={desc} />, document.body)}
    </span>
  );
}

function TipBubble({ pos, side, label, kbd, desc }) {
  const ref = useRef(null);
  const [x, setX] = useState(pos.x);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    setX(Math.max(8 + w / 2, Math.min(window.innerWidth - 8 - w / 2, pos.x)));
  }, [pos.x]);
  return (
    <div ref={ref} className="tooltip" role="tooltip" style={{ left: x, top: pos.y, transform: `translate(-50%, ${side === 'top' ? '-100%' : '0'})` }}>
      <span>{label}{desc && <span className="tip-desc">{desc}</span>}</span>
      {kbd && <kbd>{kbd}</kbd>}
    </div>
  );
}

// ---------- 按钮 ----------
/**
 * variant: 'primary' | 'secondary'(默认) | 'ghost' | 'icon' | 'ai' | 'danger'
 * size: 'sm'(24px) | 'md'(30px，默认) | 'lg'(38px)
 * loading: 显示转圈并暂时不可点（aria-busy），文字保持不变，避免按钮宽度跳动。
 * 传 tip/kbd 时使用自绘 Tooltip（否则用原生 title）。
 */
export function Button({ variant, size, icon, iconRight, children, className = '', active, title, tip, kbd, loading, disabled, ...rest }) {
  const iconOnly = !children && (icon || loading);
  const cls = ['btn', variant === 'icon' ? '' : variant, size, iconOnly || variant === 'icon' ? 'icon' : '', active ? 'active' : '', loading ? 'loading' : '', className].filter(Boolean).join(' ');
  const useTip = !!(tip || kbd);
  const label = tip || title;
  const iconSize = size === 'sm' ? 14 : size === 'lg' ? 18 : 16;
  const btn = (
    <button type="button" className={cls} title={useTip ? undefined : title} aria-label={label || undefined} aria-pressed={active == null ? undefined : !!active} aria-busy={loading ? true : undefined} disabled={disabled || !!loading} {...rest}>
      {loading ? <span className="spinner btn-spinner" aria-hidden="true" /> : (icon && <Icon name={icon} size={iconSize} />)}
      {children}
      {iconRight && <Icon name={iconRight} size={14} />}
    </button>
  );
  return useTip ? <Tooltip label={label} kbd={kbd}>{btn}</Tooltip> : btn;
}

function useOutside(ref, open, onClose) {
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('mousedown', onDown, true); window.removeEventListener('keydown', onKey, true); };
  }, [ref, open, onClose]);
}

/**
 * 弹出菜单项列表。items: [{id,label,icon,kbd,onClick,disabled,sep,danger}]
 * 键盘：↑↓ 移动、Home/End 首尾、Enter/空格 执行、Tab 关闭；autoFocus 时打开即聚焦第一项（键盘打开菜单时用）。
 */
export function Menu({ items = [], onClose, align = 'left', style, autoFocus, className = '', label }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!autoFocus || !ref.current) return;
    const first = ref.current.querySelector('.menu-item:not(:disabled)');
    if (first) first.focus({ preventScroll: true });
  }, [autoFocus]);
  const onKeyDown = (e) => {
    const root = ref.current;
    if (!root) return;
    if (e.key === 'Tab') { if (onClose) onClose(); return; }
    const list = [...root.querySelectorAll('.menu-item:not(:disabled)')];
    if (!list.length) return;
    const i = list.indexOf(document.activeElement);
    let n = -1;
    if (e.key === 'ArrowDown') n = i < 0 ? 0 : (i + 1) % list.length;
    else if (e.key === 'ArrowUp') n = i < 0 ? list.length - 1 : (i - 1 + list.length) % list.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = list.length - 1;
    if (n < 0) return;
    e.preventDefault();
    e.stopPropagation();
    list[n].focus({ preventScroll: true });
  };
  return (
    <div ref={ref} className={'menu ' + (align === 'right' ? 'right ' : '') + className} role="menu" aria-label={label} style={style} onKeyDown={onKeyDown}>
      {items.map((it, i) => (it.sep
        ? <div key={'sep' + i} className="menu-sep" role="separator" />
        : (
          <button key={it.id || i} type="button" role="menuitem" className={'menu-item' + (it.danger ? ' danger' : '')} disabled={it.disabled} title={it.title} onClick={() => { onClose && onClose(); it.onClick && it.onClick(); }}>
            {it.icon ? <Icon name={it.icon} size={14} /> : <span style={{ width: 14 }} />}
            <span className="grow ellipsis">{it.label}</span>
            {it.kbd && <kbd>{it.kbd}</kbd>}
          </button>
        )))}
    </div>
  );
}

/** 主操作 + 下拉更多选项 */
export function SplitButton({ label, onClick, items = [], variant = 'secondary', size, icon, disabled, title, className = '' }) {
  const [open, setOpen] = useState(false);
  const [byKey, setByKey] = useState(false);
  const ref = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useOutside(ref, open, close);
  return (
    <div className={'split-btn ' + className} ref={ref}>
      <Button variant={variant} size={size} icon={icon} onClick={onClick} disabled={disabled} title={title}>{label}</Button>
      <Button variant={variant} size={size} className="split-caret" icon="chevronDown" title="更多选项" onClick={(e) => { setByKey(e.detail === 0); setOpen(!open); }} disabled={disabled || !items.length} aria-haspopup="menu" aria-expanded={open} />
      {open && <Menu items={items} onClose={close} align="right" autoFocus={byKey} style={{ top: 'calc(100% + 4px)' }} />}
    </div>
  );
}

// ---------- 浮层栈：Modal / Drawer 共用，Esc 只关最上层 ----------
const layerStack = [];
let layerSeq = 0;
/** 注册一个浮层；返回 isTop()。active 为 false 时不占位。 */
function useLayer(active) {
  const idRef = useRef(0);
  useEffect(() => {
    if (!active) return undefined;
    layerSeq += 1;
    const id = layerSeq;
    idRef.current = id;
    layerStack.push(id);
    return () => {
      const i = layerStack.lastIndexOf(id);
      if (i >= 0) layerStack.splice(i, 1);
      if (idRef.current === id) idRef.current = 0;
    };
  }, [active]);
  return useCallback(() => idRef.current !== 0 && layerStack[layerStack.length - 1] === idRef.current, []);
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
function focusablesIn(root) {
  if (!root) return [];
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.tabIndex >= 0 && !el.closest('[inert]') && el.getClientRects().length > 0);
}
/** Tab / Shift+Tab 在 root 内循环 */
function trapTab(e, root) {
  if (!root) return;
  const list = focusablesIn(root);
  const a = document.activeElement;
  if (!list.length) { e.preventDefault(); root.focus({ preventScroll: true }); return; }
  const first = list[0];
  const last = list[list.length - 1];
  if (!root.contains(a)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
  if (e.shiftKey && (a === first || a === root)) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
}

/** 始终拿到最新的值（回调放进 ref，监听器只注册一次，调用方传内联箭头函数也不会反复重绑） */
function useLatest(v) {
  const r = useRef(v);
  useLayoutEffect(() => { r.current = v; });
  return r;
}

// ---------- 抽屉 ----------
/** 在最近的 position:relative 容器内滑出。Esc 关闭；上面还有对话框或更晚打开的浮层时让给它们。 */
export function Drawer({ open, side = 'right', width = 380, title, icon, onClose, children, actions, backdrop = false, className = '' }) {
  const isTop = useLayer(!!open);
  const closeRef = useLatest(onClose);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      if (!closeRef.current || !isTop() || document.querySelector('.modal-backdrop')) return;
      closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, isTop, closeRef]);
  if (!open) return null;
  return (
    <>
      {backdrop && <div className="drawer-backdrop" onMouseDown={() => onClose && onClose()} />}
      <aside className={`drawer ${side} ${className}`} style={{ width }} role="complementary" aria-label={typeof title === 'string' ? title : undefined}>
        {(title || onClose) && (
          <div className="drawer-head">
            <h3>{icon && <Icon name={icon} size={16} />}{title}</h3>
            {actions}
            {onClose && <Button variant="ghost" size="sm" icon="close" title="关闭（Esc）" onClick={onClose} />}
          </div>
        )}
        <div className="drawer-body">{children}</div>
      </aside>
    </>
  );
}

// ---------- 分段 / 页签 ----------
const normOpt = (o) => (typeof o === 'string' ? { value: o, label: o } : o);

/**
 * 一组按钮只占一个 Tab 停靠点：←→↑↓ 切换并选中，Home/End 跳到首尾（WAI-ARIA radiogroup / tablist 惯例）。
 * 按钮上带 data-idx，pick(idx) 选中对应选项。preventDefault 后精修快捷键不会再把方向键当成逐帧移动。
 */
function onRovingKey(e, pick) {
  const k = e.key;
  if (k !== 'ArrowLeft' && k !== 'ArrowRight' && k !== 'ArrowUp' && k !== 'ArrowDown' && k !== 'Home' && k !== 'End') return;
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const btns = [...e.currentTarget.querySelectorAll(':scope > button[data-idx]:not(:disabled)')];
  if (!btns.length) return;
  const i = btns.indexOf(document.activeElement);
  let n;
  if (k === 'Home') n = 0;
  else if (k === 'End') n = btns.length - 1;
  else {
    const d = k === 'ArrowRight' || k === 'ArrowDown' ? 1 : -1;
    n = i < 0 ? 0 : (i + d + btns.length) % btns.length;
  }
  e.preventDefault();
  e.stopPropagation();
  btns[n].focus();
  pick(Number(btns[n].dataset.idx));
}
/** 当前选中项可 Tab 到；都没选中时第一个可用项可 Tab 到 */
function rovingIndex(list, value, disabled) {
  const sel = list.findIndex((o) => o.value === value && !o.disabled);
  if (sel >= 0) return sel;
  return disabled ? -1 : list.findIndex((o) => !o.disabled);
}

export function Segmented({ options = [], value, onChange, full, size, className = '', disabled, label }) {
  const list = options.map(normOpt);
  const tabStop = rovingIndex(list, value, disabled);
  const pick = (i) => { const o = list[i]; if (o && o.value !== value && onChange) onChange(o.value); };
  return (
    <div className={'segmented ' + (full ? 'full ' : '') + (size || '') + ' ' + className} role="radiogroup" aria-label={label} onKeyDown={(e) => onRovingKey(e, pick)}>
      {list.map((o, i) => (
        <button key={String(o.value)} type="button" role="radio" data-idx={i} aria-checked={value === o.value} tabIndex={i === tabStop ? 0 : -1} aria-label={!o.label && o.title ? o.title : undefined} className={value === o.value ? 'active' : ''} title={o.title} disabled={disabled || o.disabled} onClick={() => onChange && onChange(o.value)}>
          {o.icon && <Icon name={o.icon} size={14} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** items 或 options 二选一；variant='underline' 为下划线式。 */
export function Tabs({ value, onChange, items, options, variant, className = '', label }) {
  const list = (items || options || []).map(normOpt);
  const tabStop = rovingIndex(list, value, false);
  const pick = (i) => { const o = list[i]; if (o && o.value !== value && onChange) onChange(o.value); };
  return (
    <div className={'tabs ' + (variant || '') + ' ' + className} role="tablist" aria-label={label} onKeyDown={(e) => onRovingKey(e, pick)}>
      {list.map((it, i) => (
        <button key={it.value} type="button" role="tab" data-idx={i} aria-selected={value === it.value} tabIndex={i === tabStop ? 0 : -1} aria-label={!it.label && it.title ? it.title : undefined} className={'tab' + (value === it.value ? ' active' : '')} disabled={it.disabled} onClick={() => onChange && onChange(it.value)} title={it.title} data-tour={it.tour}>
          {it.icon && <Icon name={it.icon} size={14} />}
          {it.label}
          {it.badge != null && <span className="chip tab-badge">{it.badge}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------- 关键帧按钮 ----------
/** ◆ 添加/删除当前时间的关键帧，‹ › 跳到上/下一关键帧。 */
export function KeyframeButton({ active, onToggle, onPrev, onNext, disabled, hasKeys, label, count }) {
  const what = label ? `「${label}」` : '';
  const tip = disabled ? '当前不可打关键帧'
    : active ? `删除此处${what}关键帧（此参数共 ${count || 1} 个关键帧）`
      : hasKeys ? `在播放头处为${what}添加关键帧（已有 ${count || 0} 个，参数会在关键帧之间渐变）`
        : `在播放头处为${what}添加关键帧：打两个以上关键帧即可做出动画`;
  return (
    <span className={'kf-btn' + (hasKeys ? ' has-keys' : '')}>
      {onPrev && <button type="button" className="kf-nav" title={hasKeys ? `跳到上一个${what}关键帧` : '还没有关键帧'} aria-label="上一个关键帧" onClick={onPrev} disabled={disabled || !hasKeys}><Icon name="chevronLeft" size={12} /></button>}
      <button type="button" className={'kf-toggle' + (active ? ' on' : '') + (hasKeys ? ' has' : '')} title={tip} aria-label={tip} onClick={onToggle} disabled={disabled} aria-pressed={!!active}>
        <Icon name={active ? 'keyframeFill' : 'keyframe'} size={16} stroke={2} />
      </button>
      {onNext && <button type="button" className="kf-nav" title={hasKeys ? `跳到下一个${what}关键帧` : '还没有关键帧'} aria-label="下一个关键帧" onClick={onNext} disabled={disabled || !hasKeys}><Icon name="chevronRight" size={12} /></button>}
    </span>
  );
}

// ---------- 滑杆 ----------
/** 输入框文字 → 数字：认全角数字与中文标点（「５０％」「1。5」「－3」），取不到返回 null */
function readNumber(text) {
  const s = String(text == null ? '' : text)
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/。/g, '.')
    .replace(/[−‒–—﹣]/g, '-')
    .replace(/,/g, '')
    .trim();
  const m = s.match(/[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?/i);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}
/** 小数位数：0.05 → 2，1 → 0 */
function decimalsOf(x) {
  const s = String(Math.abs(Number(x)) || 0);
  const e = s.match(/e-(\d+)$/i);
  if (e) return Number(e[1]);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}
/** 最多 d 位小数并去掉末尾 0 */
function trimTo(v, d) {
  const f = 10 ** Math.max(0, Math.min(10, d));
  const r = Math.round(v * f) / f;
  return String(Object.is(r, -0) ? 0 : r);
}
/**
 * 数值能否直接输入、怎么换算：
 * 1) format 自带 edit/parse/unit（属性面板 inspValue.makeFormat 生成）→ 直接用；
 * 2) 没有 format → 按原值输入；
 * 3) format 是普通函数 → 试探它是不是「原值」或「×100」的线性显示，能还原才允许输入；否则返回 null（只能拖动）。
 */
function sliderEditSpec(format, unit, min, max, step) {
  const d = Math.max(2, decimalsOf(step));
  if (!format) return { edit: (v) => trimTo(v, d), parse: readNumber, unit: unit || '' };
  if (typeof format.parse === 'function') {
    return { edit: typeof format.edit === 'function' ? format.edit : (v) => trimTo(v, d), parse: format.parse, unit: format.unit || '' };
  }
  const samples = [min, max, (min + max) / 2, min + (max - min) * 0.37].filter(Number.isFinite);
  if (!samples.length) return null;
  for (const k of [1, 100]) {
    let ok = true;
    let shownUnit = '';
    for (const v of samples) {
      let txt = '';
      try { txt = String(format(v)); } catch { ok = false; break; }
      const m = txt.match(/[-+]?(?:\d+(?:\.\d*)?|\.\d+)/);
      if (!m) { ok = false; break; }
      const dd = (m[0].split('.')[1] || '').length;
      if (Math.abs(Number(m[0]) - v * k) > 0.5 * 10 ** -dd + 1e-9) { ok = false; break; }
      if (!shownUnit) shownUnit = txt.replace(m[0], '').replace(/\s+/g, '').trim();
    }
    if (ok) {
      const kd = k === 100 ? Math.max(0, d - 2) : d;
      return { edit: (v) => trimTo(v * k, kd), parse: (s) => { const n = readNumber(s); return n == null ? null : n / k; }, unit: shownUnit };
    }
  }
  return null;
}

/**
 * 带标签、数值、重置与可选关键帧的滑杆。
 * onChange 拖动中持续触发（即时预览），onCommit 松手时触发（提交历史）。
 * onReset 或 resetValue 任一存在时显示重置按钮；keyframe 为 KeyframeButton 的 props。
 * 数值可直接输入：单击数值（或在滑杆上按 Enter）→ 输入 → Enter 确认、Esc 取消；双击数值恢复默认。
 * 键盘：←→ 一步，Shift+←→ 十步，PageUp/PageDown 十分之一量程，Home/End 最小/最大。
 */
export function Slider({ label, value, min = -1, max = 1, step = 0.01, onChange, onCommit, onReset, format, disabled, resetValue, keyframe, unit }) {
  const [local, setLocal] = useState(value);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [bad, setBad] = useState(false);
  const dragging = useRef(false);
  const latest = useRef(Number(value) || 0);
  const clickTimer = useRef(0);
  const editRef = useRef(null);
  const valueRef = useRef(null);
  const refocus = useRef(false);
  useEffect(() => { if (!dragging.current) { setLocal(value); latest.current = Number(value) || 0; } }, [value]);
  useEffect(() => () => clearTimeout(clickTimer.current), []);
  useLayoutEffect(() => {
    if (editing && editRef.current) { editRef.current.focus({ preventScroll: true }); editRef.current.select(); }
    if (!editing && refocus.current && valueRef.current) { refocus.current = false; valueRef.current.focus({ preventScroll: true }); }
  }, [editing]);
  const num = Number(local) || 0;
  const shown = format ? format(num) : `${Math.round(num * 100) / 100}${unit || ''}`;
  const spec = sliderEditSpec(format, unit, min, max, step);
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const st = Math.abs(Number(step)) || 0.01;
  /** 夹到范围内并对齐步长，去掉浮点尾差 */
  const fit = (v) => {
    const c = Math.min(hi, Math.max(lo, Number(v) || 0));
    const snapped = lo + Math.round((c - lo) / st) * st;
    return Number(Math.min(hi, Math.max(lo, snapped)).toFixed(Math.min(10, decimalsOf(st) + 4)));
  };
  const commit = (v) => { dragging.current = false; if (onCommit) onCommit(v); };
  const apply = (v) => { latest.current = v; setLocal(v); if (onChange) onChange(v); };
  const canReset = !!onReset || resetValue != null;
  const isDefault = resetValue != null && Math.abs(num - resetValue) < 1e-9;
  const doReset = () => {
    if (disabled) return;
    if (onReset) { onReset(); return; }
    apply(resetValue); commit(resetValue);
  };
  const openEdit = () => {
    if (disabled || !spec) return;
    let txt = '';
    try { txt = spec.edit(num); } catch { txt = String(num); }
    setDraft(txt); setBad(false); setEditing(true);
  };
  /** 确认输入；文字无效时 keep=true 留在输入框并标红，keep=false（失焦）放弃 */
  const finishEdit = (keep) => {
    let v = null;
    try { v = spec ? spec.parse(draft) : null; } catch { v = null; }
    if (v == null || !Number.isFinite(Number(v))) {
      if (keep) { setBad(true); return; }
      setEditing(false); return;
    }
    const nv = fit(v);
    setEditing(false);
    if (Math.abs(nv - num) > 1e-12) { apply(nv); commit(nv); }
  };
  const onValueClick = (e) => {
    clearTimeout(clickTimer.current);
    if (e.detail === 0) { refocus.current = true; openEdit(); return; } // 键盘 Enter/空格
    if (e.detail === 1) clickTimer.current = setTimeout(openEdit, 220); // 等一下，区分双击复位
  };
  const onValueDouble = () => { clearTimeout(clickTimer.current); if (canReset) doReset(); };
  const onRangeKey = (e) => {
    if (disabled || e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key;
    if (k === 'Enter' && spec) { e.preventDefault(); openEdit(); return; }
    const big = (hi - lo) / 10;
    let v = null;
    if (k === 'ArrowRight' || k === 'ArrowUp') v = num + st * (e.shiftKey ? 10 : 1);
    else if (k === 'ArrowLeft' || k === 'ArrowDown') v = num - st * (e.shiftKey ? 10 : 1);
    else if (k === 'PageUp') v = num + big;
    else if (k === 'PageDown') v = num - big;
    else if (k === 'Home') v = lo;
    else if (k === 'End') v = hi;
    if (v == null) return;
    e.preventDefault(); // 自己处理，也让精修快捷键不再把方向键当成逐帧移动
    const nv = fit(v);
    dragging.current = true;
    if (Math.abs(nv - num) > 1e-12) apply(nv);
  };
  const pct = hi > lo ? ((Math.min(hi, Math.max(lo, num)) - lo) / (hi - lo)) * 100 : 0;
  const name = typeof label === 'string' ? label : '';
  const editable = !!spec && !disabled;
  return (
    <div className={'slider-field' + (disabled ? ' disabled' : '')}>
      <div className="slider-head">
        <span className="label">{label}</span>
        {editing ? (
          <span className={'slider-edit-wrap' + (bad ? ' bad' : '')}>
            <input
              ref={editRef} className="slider-edit" type="text" inputMode="decimal" spellCheck={false} autoComplete="off"
              value={draft} aria-label={name ? `输入「${name}」的数值` : '输入数值'} aria-invalid={bad || undefined}
              title={bad ? '请输入数字，例如 50' : 'Enter 确认，Esc 取消'}
              onChange={(e) => { setDraft(e.target.value); if (bad) setBad(false); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); refocus.current = true; finishEdit(true); }
                else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); refocus.current = true; setEditing(false); }
              }}
              onBlur={() => { if (editing) finishEdit(false); }}
            />
            {spec && spec.unit && <span className="slider-edit-unit" aria-hidden="true">{spec.unit}</span>}
          </span>
        ) : editable ? (
          <button
            ref={valueRef} type="button" className="slider-value editable" onClick={onValueClick} onDoubleClick={onValueDouble}
            title={canReset ? '单击输入数值，双击恢复默认' : '单击输入数值'} aria-label={`${name ? name + ' ' : ''}${shown}，单击输入数值`}
          >{shown}</button>
        ) : (
          <span className="slider-value" onDoubleClick={canReset ? doReset : undefined} title={canReset && !disabled ? '双击恢复默认' : undefined}>{shown}</span>
        )}
        {canReset && <button type="button" className="slider-reset" title="恢复默认" aria-label={name ? `「${name}」恢复默认` : '恢复默认'} onClick={doReset} disabled={disabled || isDefault}><Icon name="reset" size={11} stroke={1.8} /></button>}
        {keyframe && <KeyframeButton disabled={disabled} {...keyframe} label={keyframe.label || name} />}
      </div>
      <input
        type="range" className="slider" min={lo} max={hi} step={st} value={num} disabled={disabled} aria-label={name || undefined} aria-valuetext={typeof shown === 'string' ? shown : undefined}
        style={{ '--pct': `${pct}%` }}
        onChange={(e) => { dragging.current = true; apply(Number(e.target.value)); }}
        onKeyDown={onRangeKey}
        onPointerUp={() => { if (dragging.current) commit(latest.current); }}
        onKeyUp={() => { if (dragging.current) commit(latest.current); }}
        onBlur={() => { if (dragging.current) commit(latest.current); }}
      />
    </div>
  );
}

export function Select({ value, onChange, options = [], disabled, className = '', style, size, ...rest }) {
  return (
    <select className={'select ' + (size === 'sm' ? 'sm ' : '') + className} value={value} disabled={disabled} onChange={(e) => onChange && onChange(e.target.value)} style={style} {...rest}>
      {options.map((o) => (typeof o === 'string'
        ? <option key={o} value={o}>{o}</option>
        : <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>))}
    </select>
  );
}

/** 开关：读屏软件读作「开关，已打开/已关闭」。label 给读屏用（默认取 title）。 */
export function Switch({ checked, onChange, disabled, title, label, className = '', ...rest }) {
  return (
    <button
      type="button" role="switch" aria-checked={!!checked} aria-label={label || title || undefined}
      className={'switch' + (checked ? ' on' : '') + (className ? ' ' + className : '')}
      disabled={disabled} title={title} onClick={() => onChange && onChange(!checked)} {...rest}
    />
  );
}

const LABELABLE = new Set(['input', 'select', 'textarea']);
/** 表单字段：label 自动关联到唯一的输入控件（原生 input/select/textarea 或 Select），点标签即可聚焦，读屏能读出名称和提示。 */
export function Field({ label, children, hint, htmlFor, className = '' }) {
  const autoId = useId();
  const hintId = hint ? autoId + '-hint' : undefined;
  let id = htmlFor;
  let child = children;
  if (!id && isValidElement(children) && (LABELABLE.has(children.type) || children.type === Select)) {
    id = children.props.id || autoId;
    const extra = {};
    if (!children.props.id) extra.id = id;
    if (hintId && !children.props['aria-describedby']) extra['aria-describedby'] = hintId;
    if (Object.keys(extra).length) child = cloneElement(children, extra);
  }
  return (
    <div className={'field' + (className ? ' ' + className : '')}>
      {label && <label htmlFor={id}>{label}</label>}
      {child}
      {hint && <div className="hint" id={hintId}>{hint}</div>}
    </div>
  );
}

/**
 * 对话框。Esc 只关最上层；Tab 在框内循环；打开时焦点进框，关闭后焦点回到用键盘打开它的那个按钮。
 * onClose 不传（如正在处理中）时 Esc 和点遮罩都不关闭。
 */
export function Modal({ title, onClose, children, footer, wide, className = '' }) {
  const boxRef = useRef(null);
  const titleId = useId();
  const isTop = useLayer(true);
  const closeRef = useLatest(onClose);
  // 打开前的焦点（渲染时读取，早于框内 autoFocus）；只有键盘用户（:focus-visible）才把焦点还回去
  const [opener] = useState(() => {
    if (typeof document === 'undefined') return null;
    const a = document.activeElement;
    if (!a || a === document.body) return null;
    let kb = false;
    try { kb = a.matches(':focus-visible'); } catch { kb = false; }
    return { el: a, kb };
  });
  useEffect(() => {
    const box = boxRef.current;
    if (box && !box.contains(document.activeElement)) box.focus({ preventScroll: true });
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || !isTop()) return;
      e.preventDefault();
      if (closeRef.current) closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const a = document.activeElement;
      if (opener && opener.kb && opener.el.isConnected && (!a || a === document.body || (box && box.contains(a)))) {
        try { opener.el.focus({ preventScroll: true }); } catch { /* 元素已不可聚焦 */ }
      }
    };
  }, [isTop, closeRef, opener]);
  const content = (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); if (onClose) onClose(); } }}
      onKeyDown={(e) => { if (e.key === 'Tab' && isTop()) trapTab(e, boxRef.current); }}
    >
      <div ref={boxRef} tabIndex={-1} className={'modal ' + (wide ? 'wide ' : '') + className} role="dialog" aria-modal="true" aria-labelledby={title ? titleId : undefined}>
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          {onClose && <Button variant="ghost" icon="close" title="关闭（Esc）" onClick={onClose} />}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
  return typeof document !== 'undefined' && document.body ? createPortal(content, document.body) : content;
}

/** 空状态：图标 + 标题 + 一句说明 + 一个动作 */
export function EmptyState({ icon = 'film', title, desc, action, children, className = '' }) {
  return (
    <div className={'empty ' + className}>
      <div className="empty-icon"><Icon name={icon} size={24} stroke={1.4} /></div>
      {title && <h3>{title}</h3>}
      {(desc || children) && <p>{desc || children}</p>}
      {action}
    </div>
  );
}
/** 兼容旧名 */
export function Empty({ icon = 'film', title, children, action }) {
  return <EmptyState icon={icon} title={title} desc={children} action={action} />;
}

/** 进度条：value 为 0–1；indeterminate 为不确定进度（来回滑动）。label 给读屏用。 */
export function ProgressBar({ value, ai, indeterminate, label }) {
  const pct = Math.max(0, Math.min(100, Math.round((Number(value) || 0) * 100)));
  return (
    <div
      className={'progress' + (ai ? ' ai' : '') + (indeterminate ? ' indeterminate' : '')}
      role="progressbar" aria-label={label || '进度'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={indeterminate ? undefined : pct}
    >
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

/** 转圈。默认对读屏隐藏（旁边一般有「正在…」文字）；单独使用时传 label。 */
export function Spinner({ ai, label, size }) {
  const a11y = label ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true };
  return <span className={'spinner' + (ai ? ' ai' : '') + (size === 'sm' ? ' sm' : size === 'lg' ? ' lg' : '')} {...a11y} />;
}

export function Chip({ kind, children, title, dot, onClick, active }) {
  const cls = 'chip ' + (kind || '') + (active ? ' active' : '');
  if (onClick) return <button type="button" className={cls} title={title} onClick={onClick} aria-pressed={!!active}>{dot && <span className="dot" />}{children}</button>;
  return <span className={cls} title={title}>{dot && <span className="dot" />}{children}</span>;
}

/** 秒 → 00:00.0（向下取到 0.1 秒；先换算成整数个 0.1 秒，避免 0.3 显示成 00:00.2 这类浮点误差） */
export function fmtTime(t, withTenths = true) {
  const s = Math.max(0, Number(t) || 0);
  const pad = (n) => String(n).padStart(2, '0');
  if (!withTenths) {
    const whole = Math.floor(s + 1e-6);
    return `${pad(Math.floor(whole / 60))}:${pad(whole % 60)}`;
  }
  const tenths = Math.floor(s * 10 + 1e-6);
  return `${pad(Math.floor(tenths / 600))}:${pad(Math.floor((tenths % 600) / 10))}.${tenths % 10}`;
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
