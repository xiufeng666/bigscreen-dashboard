# BigScreen 大屏看板 — 接口与数据模型契约（v1）

> 本文件是后端、大屏端、编辑器端共同遵守的接口契约。任何字段变更请先修改本文件并在 Pull Request 中说明。
> 技术约束：Go 标准库实现（无第三方依赖），前端零构建、零外网 CDN，全部资源内嵌进单二进制。

## 1. 目录与页面

| 路径 | 说明 |
|---|---|
| `/` | 大屏展示页（display） |
| `/editor` | 远程编辑/控制台（editor） |
| `/js/*` `/css/*` `/assets/*` | 内嵌静态资源 |
| `/uploads/<file>` | 用户上传图片（磁盘目录 `data/uploads/`） |
| `/api/*` | JSON API |

服务默认监听 `0.0.0.0:8080`。CLI：

```
bigscreen-server -port 8080 -data ./data -password "" -open
  -port int          监听端口 (default 8080)
  -data string       数据目录 (default "./data")
  -password string   编辑/控制鉴权密码，空=不鉴权
  -open              启动后自动打开浏览器展示大屏
  -version           打印版本
```

## 2. 数据模型（dashboard.json）

设计画布尺寸由 `canvas` 配置，默认 **1920 × 1080（16:9）**，支持任意宽高比（4:3、3:2、16:10、21:9、竖屏等）。
所有组件坐标单位为设计像素（px），均相对该画布左上角。前端按视口等比缩放并居中（letterbox，留边使用主题背景色）。

```jsonc
{
  "rev": 7,                                  // 服务端维护的版本号，客户端保存时必须回传
  "canvas": { "width": 1920, "height": 1080 }, // 设计画布尺寸：宽 640..7680、高 360..4320；缺省回退 1920x1080
  "title": "智慧运营数据驾驶舱",              // 自定义主标题
  "subtitle": "SMART OPERATION CENTER",      // 自定义副标题，可空
  "theme": "tech",                           // tech | red | festive
  "rotation": {
    "auto": true,                            // 是否自动轮询
    "interval": 10,                          // 场景默认停留秒数（3..600）
    "transition": "fade",                    // fade | slide | zoom | none
    "showProgress": true                     // 大屏底部进度条
  },
  "scenes": [
    {
      "id": "scene-1",
      "name": "总览",
      "duration": 0,                         // 0=使用 rotation.interval，否则 3..3600 秒
      "background": "",                      // 可选场景背景图 URL（/uploads/... 或 http(s)）
      "widgets": [
        {
          "id": "w-xxx",
          "type": "text",                    // text | table | image | clock | notice
          "x": 60, "y": 150, "w": 700, "h": 260,
          "z": 1,
          "title": "运营总览",               // 组件面板标题，可空
          "style": {
            "bg": "",                        // CSS 背景色/渐变，空=主题默认
            "color": "",                     // 文本主色，空=主题默认
            "border": true,                  // 是否显示主题描边
            "glow": false,                  // 是否辉光
            "padding": 24,
            "radius": 0                      // 圆角 px，0=主题默认
          },
          "text":  { "content": "多行文本", "fontSize": 26, "fontWeight": 400,
                     "align": "left", "lineHeight": 1.6, "letterSpacing": 0, "color": "" },
          "table": { "columns": ["指标", "数值"], "rows": [["用户总数", "12,840"]],
                     "fontSize": 20, "align": "left", "headerBg": "", "striped": true },
          "image": { "src": "/uploads/demo.png", "fit": "cover", "caption": "" },
          "clock": { "format": "YYYY-MM-DD HH:mm:ss", "showWeek": true,
                     "fontSize": 46, "color": "", "align": "center",
                     "label": "当前时间", "mode": "digital" },
          "notice":{ "content": "通知内容", "speed": 80, "fontSize": 22, "icon": true }
        }
      ]
    }
  ],
  "updatedAt": "2026-01-01T08:00:00+08:00"
}
```

说明：

- 每个 widget 只有与 `type` 对应的属性对象有效（`text/table/image/clock/notice` 之一），其余可省略。
- `style.bg/color`、`text.color`、`clock.color`、`table.headerBg` 支持任意合法 CSS 颜色/渐变。
- **画布非 16:9 时**：把 `canvas.width/height` 设置为实际大屏分辨率比例（编辑器提供 16:9 / 16:10 / 3:2 / 4:3 / 21:9 / 竖屏预设和自定义宽高），组件坐标按新画布重新排版即可；展示端会按屏等比缩放完整显示。旧数据缺少 `canvas` 字段时自动按 1920×1080 处理，向后兼容。
- 组件坐标约束：`x,y >= 0`，`w >= 80`，`h >= 40`，`x+w <= canvas.width`，`y+h <= canvas.height`；超出时服务端做钳制而不是报错（x/y 挪入画布，w/h 收缩到边界）。坐标保留 2 位小数。
- `z` 为层叠顺序，0..9999，默认 1。
- 编辑器中文本使用多行纯文本（`\n` 换行），表格单元格为纯文本；**前端必须使用 textContent 渲染，禁止 innerHTML 注入用户内容**。
- 图片 `src` 允许 `/uploads/`、`/assets/` 开头，或 `http://`、`https://`（内网图床）。服务端校验长度 ≤ 500，其余协议（含 data:）一律置空。
- 内置示例图（供三套预设模板使用，展示端负责提供）：`/assets/demo/demo-tech.svg`、`/assets/demo/demo-red.svg`、`/assets/demo/demo-festive.svg`。
- 第三套主题枚举固定为 `tech`（科技风）、`red`（红色风格）、`festive`（节日喜庆风格）。

### 2.1 校验规则（服务端强制执行）

| 字段 | 规则 |
|---|---|
| canvas.width | 缺省 1920；钳制 640..7680 |
| canvas.height | 缺省 1080；钳制 360..4320 |
| title | ≤ 120 字符，可空（空则不显示标题区） |
| subtitle | ≤ 200 字符 |
| theme | 枚举否则 `tech` |
| rotation.interval | 3..600，越界钳制，默认 10 |
| rotation.transition | 枚举否则 `fade` |
| scenes | 1..50 个；不足 1 个时补一个空场景 |
| scene.id | 非空且全局唯一（空则服务端生成） |
| scene.name | ≤ 60 字符 |
| scene.duration | 0 或 3..3600 |
| widgets/scene | ≤ 200 个；id 全局唯一（空则生成） |
| text.content | ≤ 20000 字符 |
| table | columns ≤ 20 列，每列 ≤ 40 字符；rows ≤ 500 行，每格 ≤ 500 字符；行长度不足补空串 |
| image.src | ≤ 500 字符，协议白名单同上；不合法则置空 |
| notice.content | ≤ 5000 字符 |
| clock.format | ≤ 80 字符 |

保存时服务端会 `rev = old.rev + 1`、`updatedAt = now`，并广播给所有 SSE 客户端。

## 3. REST API

除特别说明外，请求/响应均为 `application/json; charset=utf-8`。
启用 `-password` 后，下列标记 🔒 的接口需要登录 Cookie（`bs_auth`，HttpOnly，SameSite=Lax，30 天）。
未登录返回 `401 {"error":"unauthorized"}`。展示页与只读接口无需登录。

### 3.1 健康与信息

`GET /api/health` → `{"status":"ok","version":"1.0.0","uptimeSeconds":12}`

`GET /api/info`
```json
{"version":"1.0.0","hostname":"display-pc","port":8080,"os":"linux","arch":"arm64",
 "urls":["http://192.168.1.20:8080"],"displayUrl":"http://192.168.1.20:8080/",
 "editorUrl":"http://192.168.1.20:8080/editor","goVersion":"go1.22",
 "dataDir":"/opt/bigscreen/data","authRequired":false,"serverTime":1767225600000}
```

`GET /api/config` → `{"config": Dashboard, "runtime": Runtime}`
（展示页初始化用；无需登录）

### 3.2 保存配置

`PUT /api/config` 🔒
请求体：Dashboard（必须携带客户端读到的 `rev`）。
- `rev > 0`：正常乐观锁校验（客户端从 `GET /api/config` 拿到的 rev 恒 ≥1）。
- `rev == 0`：视为“新草稿/模板首次发布”，直接覆盖保存，不校验冲突（编辑器载入内置模板后保存走这条路径）。
- `200 {"config": Dashboard}` 保存成功；服务端已广播。
- `409 {"error":"revision conflict","config": Dashboard}` 版本冲突，响应中返回当前配置，客户端应提示用户重新加载。
- `400 {"error":"..."}` 校验失败（仅结构性错误，坐标类越界自动钳制）。

### 3.3 远程控制

`POST /api/control` 🔒
```json
{"action":"play|pause|toggle|next|prev|goto|reload|notify","sceneIndex":2,"message":"今晚 20:00 系统升级"}
```
- `play/pause/toggle`：控制自动轮询。
- `next/prev/goto`：切换场景（`goto` 必须带 `sceneIndex`，0 基）。切换后重置当前场景计时。
- `reload`：所有展示端整页刷新（`message` 可选）。
- `notify`：在展示端弹出提示条（`message` 必填，≤200 字，同时用于 reload 提示）。
响应：`{"runtime": Runtime}`。动作通过 SSE `command` + `runtime` 广播。

### 3.4 SSE 事件流

`GET /api/events?role=display|editor`（`text/event-stream`；展示页 role=display，编辑器 role=editor；缺省 editor）

连接后立即收到：
```
event: hello
data: {"clientId":"c-8f3a","role":"display","config":{...},"runtime":{...},"serverTime":1767225600000,"authRequired":false}
```
随后事件：

| event | data |
|---|---|
| `config` | `{"config":Dashboard,"runtime":Runtime}` 配置保存/恢复模板后广播 |
| `runtime` | `{"runtime":Runtime}` 运行态变化（场景、播放状态、在线数变化） |
| `command` | `{"action":"next","sceneIndex":1,"message":"","runtime":Runtime,"serverTime":...}` 离散控制/自动轮播/刷新/通知；展示端据此播放过渡动画或 toast |
| `ping` | `{}` 每 20s 一次，用于保活与断线检测 |

`Runtime`：
```jsonc
{
  "playing": true,
  "scene": 1,                     // 当前场景索引（0 基，服务端权威）
  "duration": 10,                 // 当前场景应停留秒数
  "sceneStartedAt": 1767225600000,// 当前场景开始时间（unix ms，服务端时钟）
  "displays": 2,                  // 在线展示端数量（display 角色的 SSE 连接数）
  "editors": 1,                   // 在线编辑端数量
  "updatedAt": 1767225600000
}
```
服务端定时推进规则：`playing && rotation.auto && displays > 0` 时，按当前场景 duration 推进到下一个场景并广播 `command{action:"auto"}`；无展示端时暂停计时但保留状态。配置保存后若场景数变化则钳制当前场景并重置计时。

### 3.5 模板（内置示例）

`GET /api/presets` → `{"presets":[{"id":"tech","name":"科技风示例","theme":"tech","sceneCount":3}, ...]}`
（三个：`tech`、`red`、`festive`；内置模板为 1920×1080，编辑器载入到自定义画布时会按比例平移/缩放组件以适配当前画布）

`GET /api/presets/{id}` → `{"config": Dashboard}`（rev 为 0，编辑器载入后作为草稿，保存时服务端重新分配 rev）
`POST /api/presets/{id}/apply` 🔒 → 直接替换线上配置并广播，返回 `{"config":Dashboard}`

### 3.6 图片上传

`POST /api/upload` 🔒 `multipart/form-data`，字段名 `file`：
- 允许 `.png .jpg .jpeg .gif .webp .bmp`，≤ 20MB；
- 返回 `{"name":"1767225600123-a1b2c3.png","url":"/uploads/1767225600123-a1b2c3.png","size":12345}`
- `400` 类型/大小错误。

`GET /api/uploads` 🔒 → `{"files":[{"name":"...","url":"...","size":123,"mtime":1767225600}]}`
`DELETE /api/uploads/{name}` 🔒 → `{"ok":true}`

### 3.7 导入导出

`GET /api/export` → 下载当前 Dashboard JSON（`Content-Disposition: attachment; filename="bigscreen-config.json"`）
`POST /api/import` 🔒 请求体为 Dashboard JSON（可含 rev，忽略）→ 校验后替换并广播，返回 `{"config":Dashboard}`

### 3.8 鉴权（仅当配置了 -password）

- `GET /api/auth` → `{"required":true,"authenticated":false}`
- `POST /api/login` `{"password":"..."}` → `200 {"ok":true}` + Set-Cookie；`401 {"error":"密码错误"}`
- `POST /api/logout` → `{"ok":true}` 清除 Cookie

Cookie 值 = 服务端启动时随机密钥的 HMAC-SHA256，重启后失效需重新登录。

### 3.9 恢复出厂

`POST /api/reset` 🔒 → 恢复默认科技风示例（等同于 tech 模板 apply）。

## 4. 静态页面约定

- 展示页 `index.html`：封面即大屏，加载后全屏铺满（16:9 letterbox），监听 SSE，按 `runtime.scene` 渲染场景；地址可加 `?kiosk=1`（隐藏鼠标/本地按钮，适合上墙）、`?scene=N`（仅首次定位）。
- 编辑器 `editor.html`：左侧场景栏、中间 1920×1080 等比缩放画布、右侧属性面板、顶部工具栏（标题/主题/轮播/保存/预览/远程控制）。
- 页面不依赖任何外网资源；字体使用系统字体栈；图标用内联 SVG。
- 公共 CSS 变量/类名契约见 `docs/FRONTEND.md`。
