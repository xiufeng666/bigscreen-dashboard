# 参与贡献 / Contributing

感谢对 BigScreen 大屏看板的关注！欢迎提交 Issue 与 Pull Request。

## 开发环境

- Go **1.22+**（纯标准库，无第三方依赖，`go build` 即可）
- Node.js 仅用于前端 JS 语法检查（`node --check`），运行时不需要
- 现代 Chromium / Firefox 浏览器

## 本地运行

```bash
git clone https://github.com/xiufeng666/bigscreen-dashboard.git
cd bigscreen-dashboard
go build -o bigscreen-server ./server
./bigscreen-server -port 8080 -data ./data
# 大屏：http://127.0.0.1:8080/
# 编辑器：http://127.0.0.1:8080/editor
```

## 提交前检查

```bash
gofmt -l server/                 # 应无输出
go vet ./...
go test -count=1 ./...
go test -race -count=1 ./...
node --check server/web/js/util.js
node --check server/web/js/widgets.js
node --check server/web/js/display.js
node --check server/web/js/editor.js
```

修改前端后必须重新 `go build` 才能内嵌生效。

## 目录约定

- `server/*.go`：Go 后端（HTTP API、SSE、调度、存储、鉴权、预设）
- `server/web/`：内嵌前端（原生 HTML/CSS/JS，无构建步骤）
- `docs/API.md`：接口与数据模型契约（改接口必须同步更新）
- `docs/FRONTEND.md`：前端结构与主题变量契约
- `scripts/build-all.sh`：六平台交叉编译
- `screenshots/`：README / 验收报告截图

## 代码要求

- **保持零第三方 Go 依赖与离线可用**：不引入 npm 包、外部 CDN、在线字体或图标库。
- 前端不引入构建工具；资源必须可被 `go:embed` 内嵌。
- 用户内容一律使用 `textContent` / `value` 渲染，禁止 `innerHTML` 拼接用户输入。
- 主题相关改动需要覆盖科技风、红色风格、节日喜庆三套主题，并验证 16:9 与至少一种非 16:9 画布（4:3 / 3:2 / 竖屏）。
- 新增/修改接口、字段必须同步更新 `docs/API.md` 与测试。

## Pull Request

1. Fork 仓库并从 `main` 切出分支；
2. 保持提交聚焦，写清楚动机与改动；
3. 在 PR 描述中附上测试方式；涉及 UI 的请附改前/改后截图；
4. 确保 CI 全绿。

## 提交信息

参考 Conventional Commits：`feat:`、`fix:`、`docs:`、`refactor:`、`test:`、`chore:`。
