// 创作模式的中文文案与枚举标签。无依赖，纯数据。

export const PLATFORMS = ['抖音', 'B站', '小红书', 'YouTube', '朋友圈', '其他'];

export const PACING_LABELS = { slow: '舒缓', medium: '适中', fast: '快节奏' };

export const SETTING_LABELS = {
  cafe: '咖啡店', street: '街道', nature: '自然户外', studio: '摄影棚', office: '办公室', home: '家居',
  'night-city': '城市夜景', beach: '海边', kitchen: '厨房', shop: '店铺', gym: '健身房', abstract: '抽象背景',
};
export const TIME_OF_DAY = ['day', 'golden', 'night', 'blue'];
export const TIME_LABELS = { day: '白天', golden: '黄金时刻', night: '夜晚', blue: '蓝调时刻' };
export const SUBJECT_LABELS = {
  person: '人物', product: '产品', cup: '杯子', phone: '手机', car: '汽车', plant: '植物', box: '盒子', text: '文字', food: '食物', laptop: '笔记本电脑',
};
export const ACTION_LABELS = {
  idle: '静止', 'walk-left': '向左走', 'walk-right': '向右走', turn: '转身', raise: '抬起', rotate: '旋转', pour: '倾倒', talk: '说话', jump: '跳跃',
};
export const LIGHT_DIRECTIONS = ['left', 'right', 'top', 'back', 'front'];
export const LIGHT_DIRECTION_LABELS = { left: '左侧光', right: '右侧光', top: '顶光', back: '逆光', front: '正面光' };
export const LIGHT_KEYS = ['warm', 'cool', 'neutral'];
export const LIGHT_KEY_LABELS = { warm: '暖色', cool: '冷色', neutral: '中性' };
export const LIGHT_MOODS = ['bright', 'soft', 'dramatic', 'night'];
export const LIGHT_MOOD_LABELS = { bright: '明亮', soft: '柔和', dramatic: '戏剧感', night: '夜景' };

export const SOURCE_LABELS = { bilibili: 'B站', youtube: 'YouTube', commons: 'Wikimedia Commons', pexels: 'Pexels', pixabay: 'Pixabay' };
export const PROVIDER_LABELS = { codex: 'Codex', openai: 'API', local: '本地规则' };

export const STATUS_META = {
  planned: { label: '已规划', kind: '' },
  'has-reference': { label: '有参考', kind: 'info' },
  'has-previz': { label: '有预演', kind: 'ai' },
  'has-footage': { label: '有素材', kind: 'ok' },
  'has-stock': { label: '实拍参考', kind: 'ok' },
};

/** look 色块示意：[暗部, 中间调, 亮部] */
export const LOOK_SWATCHES = {
  none: ['#3a3d45', '#7d8390', '#d5d8de'],
  cinematic: ['#12343f', '#5b7c7a', '#e7a35a'],
  'film-warm': ['#3b2a1e', '#a9764a', '#f0d6a8'],
  'film-cool': ['#1c2b3a', '#5f7f93', '#c9dbe0'],
  bw: ['#0e0e0e', '#7a7a7a', '#ededed'],
  noir: ['#050505', '#3a3a3a', '#c4c4c4'],
  vintage: ['#3d3226', '#9a8a5f', '#e6d6a6'],
  'cool-night': ['#0b1630', '#2d4c7c', '#8fb2d9'],
  vivid: ['#d7263d', '#f4b81c', '#1b98e0'],
  'soft-pastel': ['#d9c7d9', '#f2d6c9', '#cfe6e0'],
  'high-contrast': ['#000000', '#505050', '#ffffff'],
  moody: ['#14171c', '#3a4048', '#8a7f6e'],
  'golden-hour': ['#5b2c14', '#d9822b', '#ffd27a'],
  cyberpunk: ['#2a0a4a', '#e0218a', '#19e3ff'],
};

export const EXAMPLE_PROMPTS = [
  '我要给我的咖啡店拍个 30 秒抖音宣传片',
  '帮我拍一个周末露营 vlog',
  '新款蓝牙耳机的产品展示',
  '教人做番茄炒蛋的竖屏教程',
];

export const REFINE_SUGGESTIONS = [
  '改成仰拍，更有气势',
  '只用一部手机、一个人也能拍',
  '换成黄金时刻的暖光',
  '把时长缩短到 3 秒，节奏紧一点',
];

/** 把枚举列表 + 标签表转成 Select 的 options */
export function toOptions(list, labels) {
  return list.map((value) => ({ value, label: (labels && labels[value]) || value }));
}
