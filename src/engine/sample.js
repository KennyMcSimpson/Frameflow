// 示例项目「示例：咖啡店宣传片」。
// 启动页「从示例创建」使用；tracks 为空，由启动页再调用 buildFirstCut 生成初剪。
// 每个镜头引用随安装包附带的真人实拍素材（build/sample-media → resources/sample-media），
// 时间线用实拍；只有素材目录未知或文件缺失时才由 buildFirstCut 回退到 previz 占位。
import { createProject, createBrief, createShot, createPrevizSpec, createAsset } from './model.js';
import { uid } from './ids.js';

const BRAND = '晨光咖啡';

const STYLE_GUIDE = [
  `全片基调：温暖、松弛、治愈，像清晨走进一家熟悉的小店。调色统一使用「暖调胶片」（强度约 0.8），轻微胶片颗粒，避免高饱和与冷色。`,
  '光线：以自然窗光和清晨低角度阳光为主，室内镜头尽量让窗在主体侧后方（侧逆光），暗部用白板轻补，不使用顶部大白灯。',
  '运镜：以缓慢推近、跟随和轻微手持为主，速度慢而稳；拉花和磨豆用 0.5 倍慢动作，全片不用甩镜、冲击变焦等强烈转场。',
  '剪辑：中速节奏，平均每镜约 4 秒；开头从黑场淡入，中段以硬切和短叠化为主，结尾叠化到品牌落版。',
  '字幕与声音：字幕简短（每条不超过 12 字），白色细字放画面下方；背景音乐用轻柔原声吉他/钢琴，底下保留咖啡机、磨豆、杯碟的环境声。',
].join('\n');

function shot(partial) {
  const { previz, ...rest } = partial;
  return createShot({
    ...rest,
    previz: createPrevizSpec({
      ...previz,
      camera: { shotSize: rest.shotSize, movement: rest.movement, angle: rest.angle },
    }),
  });
}

function buildShots() {
  const list = [
    shot({
      title: '晨光里的店招',
      duration: 4.5,
      shotSize: 'wide',
      angle: 'low',
      movement: 'tilt-down',
      lighting: '清晨低角度阳光，从店招斜后方照来，暖金色轮廓光',
      location: '咖啡店门口街道',
      subject: `「${BRAND}」店招与门面`,
      action: '镜头从洒满晨光的天空和树梢缓缓下摇，落到店招上，街边有行人走过',
      caption: '早上七点半，城市还没醒',
      voiceover: '',
      shootingTips: [
        '日出后 30–60 分钟去拍，太阳在店招斜后方时最出片；用天气 App 查好日出时间。',
        '手机竖着贴近胸口、镜头略仰，先对着天空和树叶，录制后用 4 秒匀速向下摇到店招。',
        '点击店招测光后把曝光滑块往下拉一点，保住天空层次，不要让招牌过曝发白。',
        '用 1x 主摄，打开网格线，让店招落在画面下三分线上，左右留出街道作为引导线。',
        '多录 2–3 条，挑一条有行人自然走过、但不挡店招的版本。',
      ],
      transitionIn: 'dip-black',
      look: 'film-warm',
      referenceQueries: ['咖啡店 门头 清晨 阳光 空镜', 'coffee shop storefront morning sunlight b-roll'],
      techniqueIds: ['bt_golden_backlight', 'bt_leading_lines', 'bt_dip_black_chapter'],
      previz: {
        setting: 'street',
        timeOfDay: 'golden',
        palette: ['#3b2a20', '#f2b766', '#fbe9cf'],
        subjects: [
          { kind: 'text', x: 0.5, y: 0.42, scale: 1.1, color: '#f6e3c4', action: 'idle', label: BRAND },
          { kind: 'person', x: 0.18, y: 0.82, scale: 0.6, color: '#5a4636', action: 'walk-right', label: '路人' },
          { kind: 'plant', x: 0.86, y: 0.8, scale: 0.9, color: '#6f8f5a', action: 'idle', label: '门口绿植' },
        ],
        light: { direction: 'back', key: 'warm', mood: 'soft' },
        overlayText: '',
      },
    }),
    shot({
      title: '推门走进店里',
      duration: 3.5,
      shotSize: 'medium',
      angle: 'eye-level',
      movement: 'tracking',
      lighting: '门外明亮、室内暖黄，门框形成天然框中框',
      location: '咖啡店入口',
      subject: '一位顾客（背影）',
      action: '顾客推开玻璃门走进店内，门上的铃铛轻轻晃动，镜头跟在身后一起进门',
      caption: '',
      voiceover: '',
      shootingTips: [
        '站在顾客身后 1–1.5 米，手机放胸口高度，打开防抖或「运动模式」。',
        '跟拍时膝盖微屈、脚跟先着地（忍者步），和顾客保持同样的步速。',
        '让门框出现在画面两侧形成框中框，进门瞬间室内灯光要提前打开。',
        '提前对着室内锁定曝光（长按出现 AE/AF 锁定），避免进门时画面忽暗忽亮。',
        '门铃声很好听，记得保持安静，录下真实的开门声做 J-cut。',
      ],
      transitionIn: 'cut',
      look: 'film-warm',
      referenceQueries: ['推门进咖啡店 跟拍 背影', 'walking into cafe follow shot from behind'],
      techniqueIds: ['bt_follow_shot', 'bt_frame_in_frame', 'bt_jl_cut'],
      previz: {
        setting: 'cafe',
        timeOfDay: 'day',
        palette: ['#2e2119', '#d79a5b', '#f3dfc1'],
        subjects: [
          { kind: 'person', x: 0.48, y: 0.86, scale: 1.2, color: '#4a3a2e', action: 'walk-right', label: '顾客' },
        ],
        light: { direction: 'front', key: 'warm', mood: 'soft' },
        overlayText: '',
      },
    }),
    shot({
      title: '磨豆特写',
      duration: 4,
      shotSize: 'extreme-close-up',
      angle: 'high',
      movement: 'push-in',
      lighting: '窗光从侧后方掠过，突出咖啡豆油亮的纹理',
      location: '吧台磨豆机旁',
      subject: '咖啡豆与磨豆机',
      action: '咖啡豆倒入磨豆机，咖啡粉细细落下，粉末在光里飘散',
      caption: '每一杯，都从现磨开始',
      voiceover: '',
      shootingTips: [
        '用手机「微距」模式，或 2x 焦段离磨豆机出粉口约 15 厘米。',
        '让窗户在磨豆机的侧后方，粉末在逆光里会发亮；必要时在对面用白纸板补光。',
        '打开慢动作（120 帧）拍粉末落下，前后多录 1 秒方便剪辑。',
        '手机靠在吧台或杯子上做支撑，只做 3 秒非常慢的前推。',
        '单独录 10 秒磨豆声音，后期作为环境音铺底。',
      ],
      transitionIn: 'cut',
      look: 'film-warm',
      referenceQueries: ['咖啡 磨豆 特写 慢动作', 'coffee grinder close up slow motion'],
      techniqueIds: ['bt_macro_detail', 'bt_window_side_back', 'bt_ambience_bed'],
      previz: {
        setting: 'cafe',
        timeOfDay: 'day',
        palette: ['#24170f', '#8a5a34', '#e9c79a'],
        subjects: [
          { kind: 'product', x: 0.5, y: 0.7, scale: 1.6, color: '#3a3330', action: 'idle', label: '磨豆机' },
          { kind: 'food', x: 0.5, y: 0.9, scale: 0.8, color: '#6b4226', action: 'pour', label: '咖啡粉' },
        ],
        light: { direction: 'back', key: 'warm', mood: 'dramatic' },
        overlayText: '',
      },
    }),
    shot({
      title: '拉花成形',
      duration: 5,
      shotSize: 'close-up',
      angle: 'top-down',
      movement: 'static',
      lighting: '柔和窗光从画面左侧照入，奶泡高光细腻',
      location: '吧台',
      subject: '咖啡师的手与拿铁',
      action: '咖啡师把奶缸贴近杯面，一朵叶子拉花在杯中慢慢成形',
      caption: '慢一点，刚刚好',
      voiceover: '',
      shootingTips: [
        '手机举到杯子正上方约 40 厘米，打开网格线，杯口放在画面正中央。',
        '用支架或两摞书固定手机，避免手的影子落进杯子；光从侧面来。',
        '开 120 帧慢动作，从奶缸进入画面开始录，到拉花完全成形后再停 2 秒。',
        '提前和咖啡师约好多拉 2–3 杯，挑形状最漂亮的一条。',
        '杯碟和吧台提前擦干净，只留一两件木质小道具。',
      ],
      transitionIn: 'crossfade',
      look: 'film-warm',
      referenceQueries: ['咖啡拉花 特写 慢动作', 'latte art close up slow motion'],
      techniqueIds: ['bt_slow_motion', 'bt_top_down', 'bt_window_side_back'],
      previz: {
        setting: 'cafe',
        timeOfDay: 'day',
        palette: ['#3a2618', '#c98d58', '#f7ead6'],
        subjects: [
          { kind: 'cup', x: 0.5, y: 0.62, scale: 1.5, color: '#f4efe6', action: 'idle', label: '拿铁' },
          { kind: 'product', x: 0.66, y: 0.42, scale: 0.8, color: '#c0c4c8', action: 'pour', label: '奶缸' },
        ],
        light: { direction: 'left', key: 'warm', mood: 'soft' },
        overlayText: '',
      },
    }),
    shot({
      title: '第一口的微笑',
      duration: 4,
      shotSize: 'medium-close',
      angle: 'eye-level',
      movement: 'handheld',
      lighting: '窗光侧逆，脸部被柔和照亮，发丝有暖色轮廓',
      location: '靠窗座位',
      subject: '顾客',
      action: '顾客双手捧起咖啡喝下第一口，放下杯子后自然地笑了',
      caption: '是熟悉的味道',
      voiceover: '',
      shootingTips: [
        '让顾客坐在窗边，窗在她的侧后方；手机在窗户的对侧，用 2x 焦段拍中近景。',
        '在镜头前 20 厘米放一盆绿植或杯子做虚化前景，对焦点在人物眼睛上。',
        '轻轻手持，保留呼吸感，不要大幅移动；可以缓慢向右平移制造视差。',
        '不要让顾客“表演”笑，先聊天让她放松，连续录 30 秒挑最自然的瞬间。',
      ],
      transitionIn: 'cut',
      look: 'film-warm',
      referenceQueries: ['咖啡店 女生 喝咖啡 微笑 窗边 逆光', 'woman drinking coffee smiling window light cafe'],
      techniqueIds: ['bt_foreground_frame', 'bt_handheld_breath', 'bt_window_side_back'],
      previz: {
        setting: 'cafe',
        timeOfDay: 'day',
        palette: ['#2f241d', '#e0a96d', '#fbeee0'],
        subjects: [
          { kind: 'person', x: 0.6, y: 0.9, scale: 1.4, color: '#e0a96d', action: 'raise', label: '顾客' },
          { kind: 'plant', x: 0.1, y: 0.95, scale: 1.1, color: '#5e7d4c', action: 'idle', label: '前景绿植' },
        ],
        light: { direction: 'back', key: 'warm', mood: 'soft' },
        overlayText: '',
      },
    }),
    shot({
      title: '窗边的阅读时光',
      duration: 5,
      shotSize: 'medium',
      angle: 'eye-level',
      movement: 'drift',
      lighting: '大面积窗光，画面明亮通透，人物在光里',
      location: '窗边长桌',
      subject: '顾客与书、咖啡',
      action: '顾客靠窗翻书，咖啡冒着热气，窗外偶尔有行人经过',
      caption: '给自己留一段慢时光',
      voiceover: '',
      shootingTips: [
        '把人物放在画面右三分线上，左侧留出明亮的窗户作为负空间（之后放字幕）。',
        '手机贴着桌面边缘缓慢横移 20–30 厘米，4–5 秒，越慢越治愈。',
        '曝光以人物脸部为准，窗外略过曝没关系，营造通透感。',
        '让咖啡刚倒好时拍，热气在逆光下会很明显；也可以对杯子轻轻哈气。',
      ],
      transitionIn: 'crossfade',
      look: 'film-warm',
      referenceQueries: ['咖啡店 窗边 看书 治愈 空镜', 'reading book by cafe window cozy cinematic'],
      techniqueIds: ['bt_negative_space', 'bt_crossfade_time', 'bt_window_side_back'],
      previz: {
        setting: 'cafe',
        timeOfDay: 'day',
        palette: ['#3a2c22', '#e6b77e', '#fff4e3'],
        subjects: [
          { kind: 'person', x: 0.68, y: 0.88, scale: 1.1, color: '#d8a06a', action: 'idle', label: '阅读的顾客' },
          { kind: 'cup', x: 0.5, y: 0.86, scale: 0.6, color: '#f4efe6', action: 'idle', label: '咖啡' },
        ],
        light: { direction: 'left', key: 'warm', mood: 'bright' },
        overlayText: '',
      },
    }),
    shot({
      title: '品牌落版',
      duration: 4,
      shotSize: 'full',
      angle: 'eye-level',
      movement: 'pull-out',
      lighting: '吧台暖光，背景柔和虚化',
      location: '吧台/店内全景',
      subject: `${BRAND} Logo 与一杯拿铁`,
      action: '镜头从桌上的拿铁缓缓拉远，画面留白处出现品牌名和营业信息',
      caption: '',
      voiceover: '',
      shootingTips: [
        '拿铁放在画面下三分之一，上方留出干净的墙面或虚化的吧台用于放 Logo。',
        '从杯子特写开始，身体缓慢后退约 1 米，5 秒内匀速完成，结尾稳定停 1 秒。',
        '背景灯串或暖灯虚化成光斑会更好看，用人像模式或 2x 焦段。',
        '字幕写清地址/营业时间/到店福利，例如「每天 7:30 开门｜到店说“晨光”送曲奇」。',
      ],
      transitionIn: 'crossfade',
      look: 'film-warm',
      referenceQueries: ['咖啡店 宣传片 结尾 品牌 落版', 'coffee shop commercial ending logo shot'],
      techniqueIds: ['bt_cta_ending', 'bt_pull_out_reveal', 'bt_negative_space'],
      previz: {
        setting: 'cafe',
        timeOfDay: 'day',
        palette: ['#2a1d15', '#c8874f', '#f6e6cf'],
        subjects: [
          { kind: 'cup', x: 0.5, y: 0.82, scale: 0.9, color: '#f4efe6', action: 'idle', label: '拿铁' },
          { kind: 'text', x: 0.5, y: 0.36, scale: 1.2, color: '#fbeee0', action: 'idle', label: BRAND },
        ],
        light: { direction: 'front', key: 'warm', mood: 'soft' },
        overlayText: `${BRAND} · 每天 7:30 开门`,
      },
    }),
  ];
  return list.map((s, i) => ({ ...s, index: i + 1, status: 'planned' }));
}

/**
 * 示例素材清单（与 build/sample-media/manifest.json 保持一致，由 scripts/fetch-sample-media.mjs 生成；
 * 这里内嵌一份是为了在渲染进程里同步创建示例项目，tests/stock-footage.test.mjs 校验两者一致）。
 */
export const SAMPLE_MEDIA = [
  { file: 'shot01-storefront.mp4', shotIndex: 1, duration: 4.5, credit: 'Mixkit · A calm street in paris', url: 'https://mixkit.co/free-stock-video/a-calm-street-in-paris-4348/' },
  { file: 'shot02-enter.mp4', shotIndex: 2, duration: 4, credit: 'Mixkit · Customers in a minimalist style restaurant', url: 'https://mixkit.co/free-stock-video/customers-in-a-minimalist-style-restaurant-4385/' },
  { file: 'shot03-grind.mp4', shotIndex: 3, duration: 4, credit: 'Mixkit · Coffee powder being poured on the coffee maker filter', url: 'https://mixkit.co/free-stock-video/coffee-powder-being-poured-on-the-coffee-maker-filter-4984/' },
  { file: 'shot04-latte-art.mp4', shotIndex: 4, duration: 5, credit: 'Mixkit · Latte art', url: 'https://mixkit.co/free-stock-video/latte-art-810/' },
  { file: 'shot05-first-sip.mp4', shotIndex: 5, duration: 4, credit: 'Mixkit · Woman sips from a coffee cup', url: 'https://mixkit.co/free-stock-video/woman-sips-from-a-coffee-cup-46568/' },
  { file: 'shot06-window.mp4', shotIndex: 6, duration: 5, credit: 'Mixkit · Writing on a notebook at a coffee shop', url: 'https://mixkit.co/free-stock-video/writing-on-a-notebook-at-a-coffee-shop-1741/' },
  { file: 'shot07-ending.mp4', shotIndex: 7, duration: 4.5, credit: 'Mixkit · Serving a sparkling cappuccino in a cup', url: 'https://mixkit.co/free-stock-video/serving-a-sparkling-cappuccino-in-a-cup-41859/' },
  { file: 'broll-milk-froth.mp4', shotIndex: null, duration: 5, credit: 'Mixkit · Frothing milk seen in detail', url: 'https://mixkit.co/free-stock-video/frothing-milk-seen-in-detail-3576/' },
].map((m) => ({ ...m, license: 'Mixkit Free License（可免费商用，无需署名）', width: 1280, height: 720 }));

const SAMPLE_DIR = 'sample-media';

function joinPath(dir, file) {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + file;
}

/**
 * 示例素材目录。resources 可以是 resources 根目录（打包后为 process.resourcesPath，开发态为 <repo>/build）
 * 或直接是 sample-media 目录。未知时返回 null（示例项目退回 previz 占位）。
 */
export function sampleMediaDir(resources) {
  // 兼容 app:info 的对象形式 {root, sampleMedia, sampleMediaOk}
  if (resources && typeof resources === 'object') {
    if (resources.sampleMediaOk === false) return null;
    return sampleMediaDir(resources.sampleMedia || resources.root || '');
  }
  const r = typeof resources === 'string' ? resources.trim() : '';
  if (!r) return null;
  return /[\\/]sample-media[\\/]?$/i.test(r) ? r.replace(/[\\/]+$/, '') : joinPath(r, SAMPLE_DIR);
}

/** 渲染进程拿到 appInfo 后可调用一次，createSampleProject() 不传参时使用 */
let defaultResources = null;
export function setSampleResources(resources) { defaultResources = resources || null; }

/**
 * 生成示例素材资产（asset.source='stock'，带 credit）。missing 为确认缺失的文件名，跳过它们。
 * @returns {Array<{shotIndex:number|null, asset:object}>}
 */
export function sampleMediaAssets(resources, { missing = [] } = {}) {
  const dir = sampleMediaDir(resources);
  if (!dir) return [];
  const skip = new Set(missing);
  return SAMPLE_MEDIA.filter((m) => !skip.has(m.file)).map((m) => ({
    shotIndex: m.shotIndex,
    asset: createAsset({
      kind: 'video',
      name: m.shotIndex ? `实拍 · 第 ${m.shotIndex} 镜` : '实拍 · 奶泡空镜',
      path: joinPath(dir, m.file),
      duration: m.duration,
      width: m.width,
      height: m.height,
      fps: 25,
      hasAudio: false,
      // source 保留旧字符串（多处按 'stock' 判断实拍）；显式写入许可字段，导出署名和商用检查直接可用
      source: 'stock',
      credit: m.credit,
      stock: { platform: 'mixkit', url: m.url, license: m.license, author: '', sample: true },
      license: { id: 'mixkit', name: 'Mixkit 免费许可', url: 'https://mixkit.co/license/' },
      tags: ['实拍', '示例素材'],
      description: m.credit,
    }),
  }));
}

/**
 * @param {{resources?: string, appInfo?: {resources?: string}, missing?: string[]}} [opts]
 *   resources：api.appInfo().resources；missing：已确认不存在的素材文件名。
 */
export function createSampleProject(opts = {}) {
  const project = createProject({ name: '示例：咖啡店宣传片', aspect: '16:9' });
  const now = new Date().toISOString();
  project.brief = createBrief({
    title: `${BRAND}｜一杯咖啡的清晨`,
    goal: '为社区精品咖啡店做一支 30 秒宣传片，吸引附近上班族和年轻人到店，提升店铺在 B站/抖音 的曝光（横版成片，可再裁成竖版发抖音）。',
    audience: '附近 22–35 岁的上班族、学生和喜欢探店的年轻人',
    platform: 'B站',
    duration: 30,
    aspect: '16:9',
    style: '温暖治愈的生活方式短片，自然光、慢节奏、细节特写',
    mood: '温暖、松弛、治愈',
    look: 'film-warm',
    pacing: 'medium',
    music: '轻柔原声吉他或钢琴，BPM 80–95，底下保留咖啡机与杯碟的环境声',
    keyMessage: '每天清晨，一杯认真做的咖啡，给你一段慢下来的时光。',
    mustHave: ['店招门面', '现磨咖啡豆', '拉花过程', '顾客真实的笑容', '品牌名与营业时间'],
    avoid: ['刺眼的冷白光', '花哨的特效转场', '杂乱的吧台背景', '过长的口播'],
  });
  project.storyboard = buildShots();
  const resources = opts.resources || (opts.appInfo && opts.appInfo.resources) || defaultResources
    || (globalThis.__FRAMEFLOW_APPINFO__ && globalThis.__FRAMEFLOW_APPINFO__.resources)
    || (typeof process !== 'undefined' && process.versions && process.versions.electron && process.resourcesPath && !/node_modules/i.test(process.resourcesPath) && process.resourcesPath) || null;
  const media = sampleMediaAssets(resources, { missing: opts.missing });
  for (const { shotIndex, asset } of media) {
    project.assets[asset.id] = asset;
    const shotIdx = project.storyboard.findIndex((s) => s.index === shotIndex);
    if (shotIdx >= 0) {
      project.storyboard[shotIdx] = { ...project.storyboard[shotIdx], footageAssetId: asset.id, mediaSource: 'stock', status: 'has-footage' };
    }
  }
  project.memory = {
    styleGuide: STYLE_GUIDE,
    decisions: [
      { at: now, text: '全片统一暖调胶片色调，平均每镜约 4 秒，中速节奏。' },
      { at: now, text: '开头黑场淡入，结尾叠化到品牌落版。' },
    ],
    colorBaseline: null,
  };
  project.chats = {
    director: [
      {
        id: uid('msg'),
        role: 'assistant',
        at: now,
        provider: 'local',
        text: `你好，我是你的 AI 导演。这是一个示例项目：为「${BRAND}」拍一支 30 秒的温暖宣传片，我已经帮你写好了创意简报和 7 个分镜，每个分镜都配好了真人实拍素材，也写了手机就能完成的拍法。\n\n你可以：\n1. 点开任意分镜看「拍法要点」，或点「查找参考」看看网上类似的镜头；\n2. 点右下角「下一步：进入剪辑」，看看已经剪好的初剪，试试改字幕、调色、换音乐；\n3. 或者告诉我你自己的店和想法，比如「我想给我的奶茶店拍一个抖音视频」，我们从头聊。`,
        // 快捷回复用用户的口吻，点一下直接发给导演
        questions: ['换成我自己的店', '我想拍竖屏发抖音', '我手上有自己拍的素材'],
      },
    ],
    editor: [],
  };
  return project;
}

export default createSampleProject;
