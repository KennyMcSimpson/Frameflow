# 示例项目实拍素材许可

示例项目「晨光咖啡」使用的视频片段位于 `build/sample-media/`，随安装包放在 `resources/sample-media/`。
全部为真人实拍素材，由 `scripts/fetch-sample-media.mjs` 下载并裁剪为约 4–5 秒、1280×720、H.264、无音轨。

- Pexels License：https://www.pexels.com/license/ —— 可免费用于商业与非商业用途，无需署名（我们仍保留摄影师署名）；不得原样转售、不得暗示被摄人物/品牌背书。
- Mixkit Free License：https://mixkit.co/license/#videoFree —— 可免费用于商业与个人项目，无需署名；不得将素材单独再分发/转售。脚本会拒绝 Restricted License 条目。

| 文件 | 用途 | 署名 | 来源页 | 许可 |
| --- | --- | --- | --- | --- |
| shot01-storefront.mp4 | 第 1 镜 | Mixkit · A calm street in paris | https://mixkit.co/free-stock-video/a-calm-street-in-paris-4348/ | Mixkit Free License（可免费商用，无需署名；https://mixkit.co/license/#videoFree） |
| shot02-enter.mp4 | 第 2 镜 | Mixkit · Two girls chatting at the counter of a coffee shop | https://mixkit.co/free-stock-video/two-girls-chatting-at-the-counter-of-a-coffee-shop-41222/ | Mixkit Free License（可免费商用，无需署名；https://mixkit.co/license/#videoFree） |
| shot03-grind.mp4 | 第 3 镜 | Mixkit · Coffee powder being poured on the coffee maker filter | https://mixkit.co/free-stock-video/coffee-powder-being-poured-on-the-coffee-maker-filter-4984/ | Mixkit Free License（可免费商用，无需署名；https://mixkit.co/license/#videoFree） |
| shot04-latte-art.mp4 | 第 4 镜 | Mixkit · Latte art | https://mixkit.co/free-stock-video/latte-art-810/ | Mixkit Free License（可免费商用，无需署名；https://mixkit.co/license/#videoFree） |
| shot05-first-sip.mp4 | 第 5 镜 | Mixkit · Woman sips from a coffee cup | https://mixkit.co/free-stock-video/woman-sips-from-a-coffee-cup-46568/ | Mixkit Free License（可免费商用，无需署名；https://mixkit.co/license/#videoFree） |
| shot06-window.mp4 | 第 6 镜 | Mixkit · Writing on a notebook at a coffee shop | https://mixkit.co/free-stock-video/writing-on-a-notebook-at-a-coffee-shop-1741/ | Mixkit Free License（可免费商用，无需署名；https://mixkit.co/license/#videoFree） |
| shot07-ending.mp4 | 第 7 镜 | Mixkit · Serving a sparkling cappuccino in a cup | https://mixkit.co/free-stock-video/serving-a-sparkling-cappuccino-in-a-cup-41859/ | Mixkit Free License（可免费商用，无需署名；https://mixkit.co/license/#videoFree） |
| broll-milk-froth.mp4 | 备用 | Mixkit · Frothing milk seen in detail | https://mixkit.co/free-stock-video/frothing-milk-seen-in-detail-3576/ | Mixkit Free License（可免费商用，无需署名；https://mixkit.co/license/#videoFree） |

更新素材：`node scripts/fetch-sample-media.mjs --force`（可设置 `PEXELS_API_KEY` 优先使用 Pexels）。
