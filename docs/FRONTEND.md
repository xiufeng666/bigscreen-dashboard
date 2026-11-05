# BigScreen 前端协作契约（v1）

> 读取顺序：`docs/API.md` → 本文件 → `server/model.go` → `server/web/js/util.js` / `widgets.js` / `css/base.css`。
> 以下为 **Lead 已完成的公共底座**，页面侧只允许“使用”，不要修改；需要调整先给 Lead 发消息。
> 前端禁止引入任何构建工具、npm 包、外网 CDN、外网字体。纯 HTML/CSS/原生 JS，由 Go `embed` 打进二进制。

## 1. 文件所有权

| 文件 | 所有者 | 说明 |
|---|---|---|
| `server/web/js/util.js` | Lead | BS 公共工具：API/SSE/时间/缩放/舞台骨架 |
| `server/web/js/widgets.js` | Lead | 组件渲染、默认属性、场景渲染 |
| `server/web/css/base.css` | Lead | 阶段/组件结构样式 + 主题变量 fallback |
| `server/web/index.html` + `js/display.js` + `css/display.css` | 大屏展示端 | 替换占位文件 |
| `server/web/css/themes.css` | 大屏展示端 | 三套主题的全部皮肤（本轮重点） |
| `server/web/editor.html` + `js/editor.js` + `css/editor.css` | 编辑器端 | 替换占位文件 |
| `server/web/assets/*` | 大屏展示端（图片素材仅编辑器需要时另议） | 装饰素材可选，必须离线 |

页面加载顺序固定：

```html
<link rel="stylesheet" href="/css/base.css">
<link rel="stylesheet" href="/css/themes.css">   <!-- 展示页；编辑器也必须引入以所见即所得 -->
<link rel="stylesheet" href="/css/display.css">  <!-- 或 editor.css -->
...
<script src="/js/util.js"></script>
<script src="/js/widgets.js"></script>
<script src="/js/display.js"></script>           <!-- 或 editor.js -->
```

## 2. 舞台骨架（两端共用，保证所见即所得）

```js
container.innerHTML = BS.stageSkeleton();       // 生成 .stage 结构
const stage = container.querySelector('.stage');
BS.applyStageConfig(stage, config);             // 画布尺寸/主题/标题/进度条（会写入 stage 宽高与 data-canvas-w/h）
const fit = BS.fitStage(wrapper, stage);        // 按画布实际尺寸等比缩放居中，返回 {update, scale(), designW, designH}
BS.renderScene(stage.querySelector('.scene-layer[data-layer="a"]'), scene, {mode:'display'});
```

**画布尺寸不再固定 1920×1080**：`config.canvas = {width,height}`（默认 1920×1080，支持 4:3、3:2、16:10、21:9、竖屏等任意比例）。`BS.applyStageConfig` 负责把画布宽高写入 `.stage`，`BS.fitStage` / `BS.stagePoint` 自动读取 `.stage` 的实际画布尺寸。`BS.canvasOf(config)` 可获取归一化后的画布尺寸；`BS.normalizeCanvas(canvas)` 与服务端规则一致（宽 640..7680，高 360..4320）。

舞台 DOM（由 `BS.stageSkeleton()` 生成，类名契约）：

```
.stage[data-theme="tech|red|festive"]
├─ .stage-deco                      主题装饰层（themes.css 负责画）
├─ .stage-header (hidden?)          标题区
│  └─ .stage-title / .stage-subtitle / .stage-title-deco
├─ .stage-scenes
│  ├─ .scene-layer[data-layer="a"]  场景层（.is-active 显示）
│  └─ .scene-layer[data-layer="b"]  双缓冲层（做过渡动画用；可留空）
├─ .stage-progress > .stage-progress-bar
└─ .stage-toasts
```

- 设计画布来自 `config.canvas`（默认 1920×1080）；组件坐标是该画布坐标系下的 px，缩放由 `BS.fitStage` 完成。切换画布尺寸后必须重新 `applyStageConfig` + `fit.update()`。
- `.scene-layer.is-active` 表示可见；过渡动画类自定，但不要改 base.css 的结构规则。
- 标题为空时 `.stage-header[hidden]`，大屏只显示组件。
- 展示页必须调用 `BS.applyStageConfig`，编辑器画布同样调用，保证 WYSIWYG。

## 3. 主题（themes.css）规范

所有皮肤必须严格限定作用域为 `.stage[data-theme="..."]`，**不得污染 `html/body` 或编辑器管理界面**。推荐结构：

```css
.stage[data-theme="tech"]      { --accent:#35e0ff; ... background:...; }
.stage[data-theme="red"]       { --accent:#ffd166; ... background:...; }
.stage[data-theme="festive"]   { --accent:#ffcf5c; ... background:...; }
.stage[data-theme="tech"] .stage-deco { ... }     /* 装饰：网格/电路/光晕 */
.stage[data-theme="red"] .widget-table .widget-inner { ... } /* 面板皮肤 */
```

必须覆盖的主题变量（base.css 会消费）：

| 变量 | 用途 |
|---|---|
| `--accent` / `--accent-2` / `--accent-soft` / `--accent-glow` | 主强调色、辅助色、半透明色、光晕 |
| `--text-1` / `--text-2` / `--text-3` | 主/次/弱文本 |
| `--panel-bg` / `--panel-border` / `--panel-radius` / `--panel-shadow` | 面板底/描边/圆角/内阴影 |
| `--title-gradient` / `--title-sub` | 标题渐变、副标题色 |
| `--table-head-bg` / `--table-line` / `--table-stripe` | 表格配色 |
| `--stage-bg` / `--font-cn` / `--font-num` | 舞台底色、中文字体栈、数字字体栈 |
| `--stage-progress-h` | 进度条高度（默认 4px） |

三套主题验收要点：

1. **科技风 tech**：深空蓝黑底 + 青蓝霓虹，透视网格/HUD 角标/光晕，面板带切角或角标装饰，整体冷色，未来感。
2. **红色风格 red**：庄重党建/政务红（深红渐变、金色描边、光带/绸缎暗纹、金色分隔线），大气稳重。
3. **节日喜庆 festive**：中国红 + 鎏金 + 灯笼/烟花/祥云/彩带等喜庆元素，暖色、明亮、有节日氛围；与“红色风格”要有明显区分。
- 装饰用纯 CSS（渐变、伪元素、内联 SVG data-uri 或 `/assets/*.svg`）实现，禁止外链图片。
- 中文/数字字体只用系统字体栈；数字可用 `--font-num`（DIN/Bahnschrift/Mono 等回退）。
- 三套主题都要保证 1920×1080 截图美观、文字可读、面板不糊、标题与进度条协调。
- `contain` 缩放产生的留边（letterbox）区域应当延续主题背景（例如把 `.stage-fit` 背景设置为与 `.stage` 相同的主题底纹/渐变），避免出现突兀的纯黑边；展示端负责实现。

## 4. 组件渲染（widgets.js 已实现）

```js
const el = BS.renderWidget(widget, {mode:'display'|'editor'});  // DOM
BS.renderScene(layer, scene, {mode});   // 清空并渲染场景（按 z 排序 + 应用背景图）
BS.createWidget('text', index);         // 新建默认组件数据
BS.WIDGET_TYPES;                        // [{type,label,w,h,...}] 组件面板元数据
BS.widgetProps(w);                      // 取 w[type] 属性对象
```

- `mode:'editor'` 会为空的文本/图片/表格显示占位提示；展示模式不显示占位。
- 组件外框已支持：`style.bg`（CSS 背景）、`style.border`、`style.glow`、`style.padding`、`style.radius`、`style.color`。
- 时钟由 `util.js` 内全局 `setInterval` 自动刷新（`[data-clock]`），页面无需额外处理。
- 滚动通知使用 CSS 动画 `--notice-duration`，无需 JS 定时器。

## 5. 展示页（display.js）要求

- 流程：`GET /api/config` → 挂舞台 → `BS.connectSSE('display', ...)` → 渲染 `runtime.scene` 场景。
- `hello` 事件带 `config` + `runtime`；断线后浏览器会自动重连，`hello` 全量刷新。
- `config` 事件更新配置并重渲染当前场景（保存配置不打断当前场景动画）。
- `runtime` 事件：`scene` 变化时播放切换动画（双 layer 实现 fade/slide/zoom/none，全部由 `config.rotation.transition` 控制）；`playing` 变化同步本地 UI。
- `command` 事件：`reload` → `location.reload()`；`notify` → `BS.stageToast(stage, message)`；场景切换命令按 `runtime.scene` 渲染。
- 进度条：按 `runtime.sceneStartedAt + runtime.duration` 计算，用 `requestAnimationFrame` 平滑推进；`playing=false` 时暂停。需校正服务端/本机时钟偏差（hello 中的 `serverTime`）。
- `?kiosk=1`：隐藏鼠标/控制按钮，适合大屏上墙；普通模式鼠标移动时显示悬浮控制条（上一屏/播放暂停/下一屏/全屏/刷新）。
- 右下角/角落显示连接状态（断线重连提示）与在线设备数可选；断线不能白屏，保留最后一帧。
- 禁止滚动条；1920×1080 之外任意窗口尺寸保持 16:9 letterbox 居中。
- 支持 `?scene=N` 打开时直接定位场景（仅首次）。

## 6. 编辑器页（editor.js）要求

布局建议（桌面优先，最小 1280px）：

- **顶部工具栏**：产品名 / 当前看板标题输入 / 主题切换（三个带色块的按钮）/ 自动轮播开关 / 间隔秒数 / 过渡效果 / 保存(发布) / 预览 / 全屏展示链接 / 在线大屏数 / 保存状态。
- **左栏**：场景列表（新增、复制、删除、重命名、拖动排序可用按钮上下移动实现）、场景停留时长、场景背景图（上传/URL/清除）；组件面板（文本/表格/图片/时钟/滚动通知，点击添加到画布）。
- **中间画布**：白/灰工作区里放 `BS.stageSkeleton()` + `BS.fitStage`（按 `config.canvas` 尺寸，画布尺寸变化后重新 fit），编辑模式下叠加选择框、8 个缩放手柄、拖动移动、网格吸附（10px 或 20px，可按住 Alt 关闭吸附）、键盘方向键微调（Shift=10px）、Delete 删除、Ctrl+Z/Y 撤销重做、Ctrl+S 保存；拖动时显示 x/y/w/h 浮层。所有坐标钳制/换算必须使用动态画布宽高（禁止再写死 1920/1080）。
- **画布尺寸设置**（未选中组件时的看板设置中）：显示当前画布尺寸；提供比例预设 16:9（1920×1080）、16:10（1920×1200）、3:2（1920×1280）、4:3（1920×1440）、21:9（2560×1080）、竖屏（1080×1920）与自定义宽高输入；提供“按当前浏览器窗口比例”快捷换算（仅用于本地预览参考，正式部署建议按展示屏实际分辨率填写）。修改画布尺寸时提供“按比例缩放现有组件布局”选项（默认开启，按新旧画布宽高比例缩放所有组件的 x/y/w/h，并更新选择框/网格/撤销历史）；取消缩放则保留原坐标并做边界钳制。保存时画布随配置一起发布，展示端实时适配。
- **内置模板适配**：模板本身为 1920×1080；载入到自定义画布时，需按当前画布宽高比例缩放模板组件坐标后再载入（画布尺寸保持用户当前设置，不被模板覆盖）。
- **右栏属性面板**：通用（标题、X/Y/W/H/Z、背景色、文字色、描边/辉光/内边距/圆角）；文本（内容 textarea、字号、字重、对齐、行高、字距、颜色）；表格（表头列编辑、单元格表格编辑器、增删行列、字号、对齐、斑马纹）；图片（上传按钮 + 图库列表 + URL 输入 + 填充方式 + 图注）；时钟（格式模板、显示星期、字号、标签、对齐）；滚动通知（内容、速度、字号、图标开关）。场景属性在未选中组件时显示。
- **远程控制面板**（工具栏或右栏底部）：播放/暂停、上一屏/下一屏、场景跳转列表、在线大屏数量、发送通知（调用 `notify`）、刷新所有大屏（`reload`）。
- **保存**：`PUT /api/config` 携带本地 rev；成功更新 rev 并 toast；`409` 提示“配置已被其他终端修改”，提供“载入最新配置 / 覆盖保存（重新拉取 rev 后重试）”选项；`401` 弹登录框（密码输入 → `/api/login`）。未保存时 `beforeunload` 提示；页面显示“未发布修改”角标。
- **模板**：`GET /api/presets` 列出三套示例（科技风/红色风格/节日喜庆），加载后成为草稿（rev=0），保存即发布；另有“恢复默认示例”（`POST /api/reset`）需二次确认。
- **SSE（role=editor）**：在线大屏数、当前场景高亮、外部配置变更提示；禁止远程控制事件重渲染画布导致编辑丢失。
- 编辑器自身 UI 使用中性深色管理后台风格（与主题解耦），画布内部展示真实主题效果。
- 所有用户文本使用 `textContent`/`.value`；图片 `src` 用 `BS.safeImageSrc`。

## 7. 本地开发与截图验收

后端就绪后：

```bash
cd bigscreen
go build -o /tmp/bigscreen ./server
/tmp/bigscreen -port 18081 -data /tmp/bsdata-display &
# 浏览器页面： http://127.0.0.1:18081/  http://127.0.0.1:18081/editor
```

截图（macOS 本机可用，无需外网）：

```bash
scripts/screenshot.sh http://127.0.0.1:18081/ /tmp/display-tech.png 1920 1080
```

- 大屏展示端必须自行完成三套主题 × 至少两个场景的截图检查（`/api/presets/{id}/apply` 切换后截图，或直接改 `data/dashboard.json` 后重启），并额外验证 4:3 / 3:2 / 21:9 / 竖屏画布适配。
- 编辑器必须完成：加载页面、选中组件、拖动/缩放、保存、切换主题、远程控制按钮、模板加载的截图或 DOM 检查。
- 用 `node --check server/web/js/xxx.js` 做语法校验；用浏览器控制台无报错为准（可用 `chrome-headless-shell --dump-dom` 或截图辅助）。
- 端口分配：后端 18080、大屏端 18081、编辑器端 18082，避免互相冲突；数据目录用 `/tmp/bsdata-<role>`。

## 8. 无障碍与兼容

- 目标浏览器：Chrome/Edge 90+、Firefox 90+、国产浏览器（Chromium 内核，如奇安信/360 极速）。避免使用过新的语法（可选链/空值合并可用，避免顶层 await、CSS `@container` 等）。
- 不依赖网络请求（除本机服务外）；不引用任何外部 URL。
- 大屏性能：避免每帧重建 DOM；组件数量控制在 200/场景内；过渡用 transform/opacity。
