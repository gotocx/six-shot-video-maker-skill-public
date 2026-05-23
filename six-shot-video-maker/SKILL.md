---
name: six-shot-video-maker
description: 将一句视频创作需求落地为完整六图15秒流程或显式快速一图4秒流程、gpt 或 jimeng 生图、图片完整度校验、最终视频提示词和视频提交。Use when the user asks for a 15 second six-shot film, quick 4 second one-image video, storyboard images, connected video prompt, or local browser video submission workflow.
version: 1.3.0
---

# Six Shot Video Maker

<!-- @类型: 标准操作流程(SOP) -->
<!-- @目的: 用一句创作需求稳定产出六张分镜图和一个总时长约 15 秒的视频提交任务 -->

> **一句话**: 默认把短片需求拆成六个连续分镜并生成 15 秒视频；用户明确要求快速模式时只生成 1 张关键图并生成 4 秒视频。两种模式都先验收图片，再写少于 2000 字的视频提示词，最后提交视频。
> **版本**: v1.3.0
> **用途**: 六图完整短片创作、快速一图短片创作、双模式图片生成、图片到视频提交、分镜资产状态管理。
> **适用范围**: 需要 6 张连续参考图的 15 秒短片，或明确要求快速模式的一图 4 秒短片。

## 触发示例

- "做一个 15 秒赛车视频"
- "一句话生成 6 张分镜图并合成视频"
- "用即梦模式做一个 15 秒城市追逐短片"
- "用 gpt 模式先出六张图，再合成视频"
- "快速模式做一个黑白中国画鸟飞出逐渐有了色彩"

## @工作流: 六图短片制作

<!-- @类型: 标准操作流程(SOP) -->
<!-- @目的: 严格按分镜、图片、视频提示词、视频提交四阶段执行 -->
<!-- @场景: 用户给一句短片主题、故事、人物或风格，并希望自动完成六图到视频 -->
<!-- @前置条件: 当前机器已有可用浏览器生图流程；本机 Node.js 可运行；视频提交脚本位于 E:\648\fang\6\jimengVideoSubmit.mjs -->
<!-- @后置验证: 6 张图片已验收；video_prompt.txt 小于 2000 字；6 张图一次性提交到视频脚本；状态文件记录到 submitted 或 ready_for_review -->
<!-- @ID: wf-six-shot-video -->

### @步骤1: 创建独立资产目录

<!-- @类型: 操作步骤 -->
<!-- @优先级: 必须 -->
<!-- @验证点: 所有产物在 skill 包外，且存在 state.json -->
<!-- @验证方式: 运行 `node scripts/asset_state.mjs init --run <run-dir>` -->
<!-- @ID: step-create-run -->

- @动作: 在 skill 包外创建独立运行目录，默认放到 `E:\648\26-3\统计数据\six-shot-video-skill-workspace\runs\<date>-<slug>`。
- @动作: 目录内固定使用 `storyboard.json`、`images\`、`checks\`、`video_prompt.txt`、`state.json`、`logs\`。
- @动作: 不把生成图片、视频、浏览器 profile、下载结果或临时缓存放进 skill 目录。

```powershell
node scripts\asset_state.mjs init --run "E:\648\26-3\统计数据\six-shot-video-skill-workspace\runs\20260524-racing-video-15s"
```

### @步骤2: 选择流程模式、生图模式并写图片分镜

<!-- @类型: 操作步骤 -->
<!-- @优先级: 必须 -->
<!-- @依赖: step-create-run -->
<!-- @验证点: storyboard.json 的 workflowMode、imageMode、场景数量、图片提示词长度和总时长合法 -->
<!-- @验证方式: 运行 `node scripts/asset_state.mjs validate --run <run-dir> --stage storyboard` -->
<!-- @ID: step-storyboard -->

- @动作: 先写 `storyboard.json`，不要先写视频提示词。
- @动作: `workflowMode` 默认 `full`，必须有 6 个场景；只有用户明确说“快速模式”“快版”“只生成一张图”时才使用 `quick`，且只写 1 个关键场景。
- @动作: 用户可以明确选择 `imageMode` 为 `gpt` 或 `jimeng`。用户未指定时默认 `gpt`；用户说即梦时使用 `jimeng`。
- @动作: 完整模式生成 6 段 100 字内图片提示词；快速模式生成 1 段 100 字内关键视觉提示词。画风、主体、角色、镜头语言必须清晰统一。
- @动作: 每个场景包含 `id`、`title`、`imagePrompt`、`copy`、`durationSec`、`imagePath`。
- @动作: 完整模式总时长固定 15 秒，6 张图默认各 2.5 秒；快速模式总时长固定 4 秒，1 张图 durationSec 写 4。
- @动作: 默认不安排人物开口说话；只有用户明确要求口播时才写短句对白。

最小结构：

```json
{
  "title": "classic short film",
  "brief": "user brief",
  "workflowMode": "full",
  "imageMode": "gpt",
  "style": "consistent cinematic style",
  "totalDurationSec": 15,
  "speaking": "none",
  "scenes": [
    {
      "id": "scene01",
      "title": "opening",
      "imagePrompt": "100 字内图片提示词",
      "copy": "短文案",
      "durationSec": 2.5,
      "imagePath": "images/scene01.png"
    }
  ]
}
```

快速模式最小结构：

```json
{
  "title": "quick short film",
  "brief": "user brief",
  "workflowMode": "quick",
  "imageMode": "gpt",
  "style": "consistent cinematic style",
  "totalDurationSec": 4,
  "speaking": "none",
  "scenes": [
    {
      "id": "scene01",
      "title": "key image",
      "imagePrompt": "100 字内关键画面提示词",
      "copy": "短文案",
      "durationSec": 4,
      "imagePath": "images/scene01.png"
    }
  ]
}
```

### @步骤3: 生成并验收图片

<!-- @类型: 操作步骤 -->
<!-- @优先级: 必须 -->
<!-- @依赖: step-storyboard -->
<!-- @验证点: 完整模式 6 张图或快速模式 1 张图都存在、可读取尺寸、文件大小达标，并通过人工视觉检查 -->
<!-- @验证方式: 先运行 `node scripts/asset_state.mjs validate --run <run-dir> --stage images`，再逐张查看图片 -->
<!-- @ID: step-images -->

- @动作: `gpt` 模式复用当前机器已验证的浏览器图像队列脚本，按 `storyboard.json` 生成任务并顺序执行。
- @动作: `jimeng` 模式复用当前机器已验证的即梦队列 worker，必须使用其抓错图防护和任务状态日志。
- @动作: 完整模式严格按 6 条 `imagePrompt` 顺序生成，保存到 `images\scene01.*` 至 `images\scene06.*`；快速模式只生成 `images\scene01.*`。
- @动作: 每生成一张就核对主体、构图、画风、裁切、文字水印和前后连续性。
- @动作: 只有目标图片都通过完整度和画风检查后，才进入视频提示词阶段。

### @步骤4: 查看图片后写视频提示词

<!-- @类型: 操作步骤 -->
<!-- @优先级: 必须 -->
<!-- @依赖: step-images -->
<!-- @验证点: video_prompt.txt 存在且总长度小于 2000 字，内容准确描述图片如何驱动视频 -->
<!-- @验证方式: 运行 `node scripts/asset_state.mjs validate --run <run-dir> --stage video` -->
<!-- @ID: step-video-prompt -->

- @动作: 必须先查看最终图片，再写 `video_prompt.txt`；快速模式尤其要根据单图可见主体、光线、构图和动作潜力来扩写视频运动。
- @动作: 视频提示词必须最后写，且总长度小于 2000 字。
- @动作: 完整模式明确描述六张图片的关系、镜头转场、运动方向、情绪推进和总时长 15 秒。
- @动作: 快速模式明确描述单张关键图如何扩展成 4 秒视频：起势、主体运动、镜头运动、环境变化、高潮和收束；不要假装存在 6 张参考图。
- @动作: 如果用户没有要求人物说话，写成无口型对白；使用环境声、旁白氛围或字幕感文案即可。
- @动作: 复杂动作、跨场景一致性高、或角色一致性要求高时，提交使用 `--model "Seedance 2.0 VIP"`；普通任务可使用默认模型。

### @步骤5: 提交视频

<!-- @类型: 操作步骤 -->
<!-- @优先级: 必须 -->
<!-- @依赖: step-video-prompt -->
<!-- @验证点: 视频脚本收到 6 个 --image 参数，prompt 读取自 video_prompt.txt，日志落到 run 目录 -->
<!-- @验证方式: 查看 logs\video_submit.log 和浏览器提交结果 -->
<!-- @ID: step-submit-video -->

- @动作: 使用 `E:\648\fang\6\jimengVideoSubmit.mjs`，并在 `E:\648\fang\6` 作为工作目录运行，复用本地 `node_modules`。
- @动作: 完整模式 6 张图必须在同一次命令中上传；快速模式只上传 `scene01.*` 且 `--duration 4`。不要一张图启动多次视频任务。
- @动作: Node.js 进程会阻塞等待浏览器提交完成；不要并行启动同一浏览器 profile 或同一 workspace。
- @动作: 页面输入优先使用脚本内 DOM 写入；不要手动占用剪贴板粘贴。
- @动作: 快速模式默认使用 `--model "Seedance 2.0 Fast VIP"` 和 `--duration 4`；只有用户明确指定高质量/复杂运动/更难任务时才改用 `Seedance 2.0 VIP`。
- @动作: 完整模式默认用 `Seedance 2.0 VIP` 和 `--duration 15`，除非用户明确要求使用更快模型。
- @动作: 模型和时长必须走页面状态初始化，不默认点击下拉。目标为 `Seedance 2.0 VIP` 时，页面状态应写入 `modelKey=dreamina_seedance_40_pro_vision`，`lastDefaultModelKey=dreamina_seedance_40_vision`，`durationMs=15000`。
- @动作: 目标为 `Seedance 2.0 Fast VIP` 时，页面状态应写入 `modelKey=dreamina_seedance_40_vision`，`lastDefaultModelKey=dreamina_seedance_40_vision`；快速模式 `durationMs=4000`。
- @动作: 提交前必须校验可见控件显示目标模型与目标时长；不匹配就停止，不上传、不提交。
- @动作: 提交完成后把 `state.json` 标记为 `submitted`；如果浏览器只显示已发送但没有接口确认，标记为 `ready_for_review`。

```powershell
Set-Location "E:\648\fang\6"
$run = "E:\648\26-3\统计数据\six-shot-video-skill-workspace\runs\20260524-racing-video-15s"
$prompt = Get-Content -Raw -Encoding UTF8 (Join-Path $run "video_prompt.txt")
node .\jimengVideoSubmit.mjs `
  --image (Join-Path $run "images\scene01.png") `
  --image (Join-Path $run "images\scene02.png") `
  --image (Join-Path $run "images\scene03.png") `
  --image (Join-Path $run "images\scene04.png") `
  --image (Join-Path $run "images\scene05.png") `
  --image (Join-Path $run "images\scene06.png") `
  --prompt $prompt `
  --duration 15 `
  --model "Seedance 2.0 VIP" *> (Join-Path $run "logs\video_submit.log")
```

## 强规则

- 禁止并行生成、并行提交或在同一 workspace 启动多个浏览器任务。
- 禁止在图片验收前写视频提示词。
- 禁止视频提示词超过 2000 字。
- 禁止把运行资产放进 skill 包内。
- 优先复用已有成熟脚本；只使用 `scripts\asset_state.mjs` 做状态和校验。
- 完整模式最终提交必须是 6 图一起上传，总时长按 15 秒控制。
- 快速模式只有用户明确要求时启用；快速模式最终提交 1 图，总时长按 4 秒控制。
- 新任务必须让用户能选择 `gpt` 或 `jimeng` 生图模式；未指定时按 `gpt` 执行。

## 版本历史

- **v1.3.0** (2026-05-24) - 新增显式快速模式：只生成 1 张关键图，查看图片后写单图驱动视频提示词并提交 4 秒视频。
- **v1.2.0** (2026-05-24) - 明确 `gpt` 与 `jimeng` 双模式选择；补充视频模型和 15 秒时长的页面状态初始化与提交前校验规则。
- **v1.1.0** (2026-05-24) - 新增双模式图片生成，移除特化触发示例，保留资产状态和顺序校验。
- **v1.0.0** (2026-05-23) - 初始版本：建立六图分镜、资产状态、图片完整度、视频提示词长度和六图提交流程。
