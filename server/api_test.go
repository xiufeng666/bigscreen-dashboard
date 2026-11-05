package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

// ---------- HTTP 测试辅助 ----------

type httpResult struct {
	Status int
	Header http.Header
	Body   []byte
}

func doRequest(t *testing.T, client *http.Client, method, url string, body []byte, contentType string) httpResult {
	t.Helper()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		t.Fatalf("构造请求失败 %s %s: %v", method, url, err)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("%s %s 请求失败: %v", method, url, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("读取响应失败: %v", err)
	}
	return httpResult{Status: resp.StatusCode, Header: resp.Header, Body: data}
}

func jsonBody(t *testing.T, v any) []byte {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("JSON 序列化失败: %v", err)
	}
	return data
}

func decodeInto[T any](t *testing.T, data []byte) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatalf("JSON 解析失败: %v, body=%s", err, string(data))
	}
	return v
}

type configResponse struct {
	Config  Dashboard `json:"config"`
	Runtime Runtime   `json:"runtime"`
}

func getConfig(t *testing.T, client *http.Client, baseURL string) configResponse {
	t.Helper()
	res := doRequest(t, client, http.MethodGet, baseURL+"/api/config", nil, "")
	if res.Status != http.StatusOK {
		t.Fatalf("GET /api/config 状态码 %d, body=%s", res.Status, string(res.Body))
	}
	return decodeInto[configResponse](t, res.Body)
}

func postJSON(t *testing.T, client *http.Client, url string, payload any) httpResult {
	t.Helper()
	return doRequest(t, client, http.MethodPost, url, jsonBody(t, payload), "application/json")
}

func putJSON(t *testing.T, client *http.Client, url string, payload any) httpResult {
	t.Helper()
	return doRequest(t, client, http.MethodPut, url, jsonBody(t, payload), "application/json")
}

// ---------- 健康 / 信息 / 配置读取 ----------

func TestAPIHealthInfoConfig(t *testing.T) {
	_, ts := newTestServer(t, "")

	health := decodeInto[struct {
		Status        string `json:"status"`
		Version       string `json:"version"`
		UptimeSeconds int64  `json:"uptimeSeconds"`
	}](t, doRequest(t, ts.Client(), http.MethodGet, ts.URL+"/api/health", nil, "").Body)
	if health.Status != "ok" || health.Version != "1.0.0-test" || health.UptimeSeconds < 0 {
		t.Fatalf("health 响应错误: %+v", health)
	}

	res := doRequest(t, ts.Client(), http.MethodGet, ts.URL+"/api/info", nil, "")
	info := decodeInto[map[string]any](t, res.Body)
	for _, field := range []string{"version", "hostname", "port", "os", "arch", "urls",
		"displayUrl", "editorUrl", "goVersion", "dataDir", "authRequired", "serverTime"} {
		if _, ok := info[field]; !ok {
			t.Fatalf("info 缺少字段 %s: %s", field, string(res.Body))
		}
	}
	if urls, ok := info["urls"].([]any); !ok || len(urls) == 0 {
		t.Fatalf("info.urls 应为非空数组: %v", info["urls"])
	}

	cfg := getConfig(t, ts.Client(), ts.URL)
	if cfg.Config.Rev < 1 {
		t.Fatalf("初始配置 rev 应 >=1, got %d", cfg.Config.Rev)
	}
	if len(cfg.Config.Scenes) != 3 {
		t.Fatalf("首次启动应使用科技风预设（3 场景）, got %d", len(cfg.Config.Scenes))
	}
	if !cfg.Runtime.Playing || cfg.Runtime.Displays != 0 || cfg.Runtime.Editors != 0 {
		t.Fatalf("初始运行态错误: %+v", cfg.Runtime)
	}
	if cfg.Runtime.SceneStartedAt <= 0 || cfg.Runtime.UpdatedAt <= 0 {
		t.Fatalf("runtime 时间戳缺失: %+v", cfg.Runtime)
	}
}

// ---------- 保存配置 / rev 冲突 ----------

func TestAPISaveConfigAndConflict(t *testing.T) {
	_, ts := newTestServer(t, "")
	client := ts.Client()

	current := getConfig(t, client, ts.URL)
	cfg := current.Config
	cfg.Title = "保存后的标题"
	res := putJSON(t, client, ts.URL+"/api/config", cfg)
	if res.Status != http.StatusOK {
		t.Fatalf("保存配置状态码 %d, body=%s", res.Status, string(res.Body))
	}
	saved := decodeInto[struct {
		Config Dashboard `json:"config"`
	}](t, res.Body)
	if saved.Config.Rev != cfg.Rev+1 {
		t.Fatalf("保存后 rev 应 +1: before=%d after=%d", cfg.Rev, saved.Config.Rev)
	}
	if saved.Config.Title != "保存后的标题" {
		t.Fatalf("保存标题错误: %q", saved.Config.Title)
	}

	// 用旧 rev 再次保存 → 409，并返回当前配置
	res = putJSON(t, client, ts.URL+"/api/config", cfg)
	if res.Status != http.StatusConflict {
		t.Fatalf("版本冲突应返回 409, got %d body=%s", res.Status, string(res.Body))
	}
	conflict := decodeInto[struct {
		Error  string    `json:"error"`
		Config Dashboard `json:"config"`
	}](t, res.Body)
	if conflict.Error != "revision conflict" {
		t.Fatalf("冲突错误信息错误: %q", conflict.Error)
	}
	if conflict.Config.Rev != saved.Config.Rev {
		t.Fatalf("409 应返回当前配置, got rev=%d", conflict.Config.Rev)
	}

	// 非法 JSON → 400
	res = doRequest(t, client, http.MethodPut, ts.URL+"/api/config", []byte("{not-json"), "application/json")
	if res.Status != http.StatusBadRequest {
		t.Fatalf("非法 JSON 应返回 400, got %d", res.Status)
	}
}

func TestAPIRevZeroForceSave(t *testing.T) {
	_, ts := newTestServer(t, "")
	client := ts.Client()
	current := getConfig(t, client, ts.URL)

	draft := current.Config
	draft.Rev = 0
	draft.Title = "模板草稿发布"
	res := putJSON(t, client, ts.URL+"/api/config", draft)
	if res.Status != http.StatusOK {
		t.Fatalf("rev=0 草稿保存应返回 200, got %d body=%s", res.Status, string(res.Body))
	}
	saved := decodeInto[struct {
		Config Dashboard `json:"config"`
	}](t, res.Body)
	if saved.Config.Rev != current.Config.Rev+1 {
		t.Fatalf("草稿保存后 rev 应由服务端分配: before=%d after=%d", current.Config.Rev, saved.Config.Rev)
	}
	if saved.Config.Title != "模板草稿发布" {
		t.Fatalf("草稿标题未生效: %q", saved.Config.Title)
	}
}

// ---------- 远程控制 ----------

func TestAPIControl(t *testing.T) {
	_, ts := newTestServer(t, "")
	client := ts.Client()
	initial := getConfig(t, client, ts.URL)
	sceneCount := len(initial.Config.Scenes)

	next := decodeInto[struct {
		Runtime Runtime `json:"runtime"`
	}](t, postJSON(t, client, ts.URL+"/api/control", map[string]any{"action": "next"}).Body)
	if next.Runtime.Scene != (initial.Runtime.Scene+1)%sceneCount {
		t.Fatalf("next 后场景错误: %d", next.Runtime.Scene)
	}

	gotoRes := decodeInto[struct {
		Runtime Runtime `json:"runtime"`
	}](t, postJSON(t, client, ts.URL+"/api/control", map[string]any{"action": "goto", "sceneIndex": 2}).Body)
	if gotoRes.Runtime.Scene != 2 {
		t.Fatalf("goto 后场景错误: %d", gotoRes.Runtime.Scene)
	}
	if gotoRes.Runtime.SceneStartedAt <= 0 {
		t.Fatal("goto 后应重置场景计时")
	}

	if res := postJSON(t, client, ts.URL+"/api/control", map[string]any{"action": "goto", "sceneIndex": 99}); res.Status != http.StatusBadRequest {
		t.Fatalf("非法 sceneIndex 应返回 400, got %d", res.Status)
	}
	if res := postJSON(t, client, ts.URL+"/api/control", map[string]any{"action": "goto"}); res.Status != http.StatusBadRequest {
		t.Fatalf("goto 缺少 sceneIndex 应返回 400, got %d", res.Status)
	}
	if res := postJSON(t, client, ts.URL+"/api/control", map[string]any{"action": "notify"}); res.Status != http.StatusBadRequest {
		t.Fatalf("notify 缺少 message 应返回 400, got %d", res.Status)
	}
	if res := postJSON(t, client, ts.URL+"/api/control", map[string]any{"action": "notify", "message": "今晚 20:00 系统升级"}); res.Status != http.StatusOK {
		t.Fatalf("notify 应返回 200, got %d", res.Status)
	}
	if res := postJSON(t, client, ts.URL+"/api/control", map[string]any{"action": "reload", "message": "刷新一下"}); res.Status != http.StatusOK {
		t.Fatalf("reload 应返回 200, got %d", res.Status)
	}
	if res := postJSON(t, client, ts.URL+"/api/control", map[string]any{"action": "explode"}); res.Status != http.StatusBadRequest {
		t.Fatalf("未知动作应返回 400, got %d", res.Status)
	}

	paused := decodeInto[struct {
		Runtime Runtime `json:"runtime"`
	}](t, postJSON(t, client, ts.URL+"/api/control", map[string]any{"action": "pause"}).Body)
	if paused.Runtime.Playing {
		t.Fatal("pause 后 playing 应为 false")
	}
	played := decodeInto[struct {
		Runtime Runtime `json:"runtime"`
	}](t, postJSON(t, client, ts.URL+"/api/control", map[string]any{"action": "play"}).Body)
	if !played.Runtime.Playing {
		t.Fatal("play 后 playing 应为 true")
	}
}

// ---------- 模板 ----------

func TestAPIPresets(t *testing.T) {
	_, ts := newTestServer(t, "")
	client := ts.Client()

	list := decodeInto[struct {
		Presets []PresetMeta `json:"presets"`
	}](t, doRequest(t, client, http.MethodGet, ts.URL+"/api/presets", nil, "").Body)
	if len(list.Presets) != 3 {
		t.Fatalf("模板列表应为 3 套, got %d", len(list.Presets))
	}

	preset := decodeInto[struct {
		Config Dashboard `json:"config"`
	}](t, doRequest(t, client, http.MethodGet, ts.URL+"/api/presets/red", nil, "").Body)
	if preset.Config.Theme != ThemeRed || preset.Config.Rev != 0 || len(preset.Config.Scenes) != 3 {
		t.Fatalf("GET 模板内容错误: theme=%s rev=%d scenes=%d",
			preset.Config.Theme, preset.Config.Rev, len(preset.Config.Scenes))
	}

	if res := doRequest(t, client, http.MethodGet, ts.URL+"/api/presets/unknown", nil, ""); res.Status != http.StatusNotFound {
		t.Fatalf("未知模板应返回 404, got %d", res.Status)
	}

	before := getConfig(t, client, ts.URL)
	applied := decodeInto[struct {
		Config Dashboard `json:"config"`
	}](t, postJSON(t, client, ts.URL+"/api/presets/festive/apply", map[string]any{}).Body)
	if applied.Config.Theme != ThemeFestive {
		t.Fatalf("应用模板后主题错误: %s", applied.Config.Theme)
	}
	if applied.Config.Rev != before.Config.Rev+1 {
		t.Fatalf("应用模板后 rev 应 +1: before=%d after=%d", before.Config.Rev, applied.Config.Rev)
	}
	after := getConfig(t, client, ts.URL)
	if after.Config.Theme != ThemeFestive || after.Config.Rev != applied.Config.Rev {
		t.Fatalf("应用模板未生效: %+v", after.Config)
	}
}

// ---------- 上传 ----------

func TestAPIUploadFlow(t *testing.T) {
	srv, ts := newTestServer(t, "")
	client := ts.Client()

	pngData := append([]byte("\x89PNG\r\n\x1a\n"), []byte("fake-png-payload")...)
	upload := func(filename string, data []byte) httpResult {
		var buf bytes.Buffer
		writer := multipart.NewWriter(&buf)
		part, err := writer.CreateFormFile("file", filename)
		if err != nil {
			t.Fatalf("构造 multipart 失败: %v", err)
		}
		if _, err := part.Write(data); err != nil {
			t.Fatalf("写入 multipart 失败: %v", err)
		}
		if err := writer.Close(); err != nil {
			t.Fatalf("关闭 multipart 失败: %v", err)
		}
		return doRequest(t, client, http.MethodPost, ts.URL+"/api/upload", buf.Bytes(), writer.FormDataContentType())
	}

	// 合法 PNG
	res := upload("demo.png", pngData)
	if res.Status != http.StatusOK {
		t.Fatalf("上传 PNG 应成功, got %d body=%s", res.Status, string(res.Body))
	}
	up := decodeInto[struct {
		Name string `json:"name"`
		URL  string `json:"url"`
		Size int64  `json:"size"`
	}](t, res.Body)
	if !strings.HasSuffix(up.Name, ".png") || up.URL != "/uploads/"+up.Name || up.Size != int64(len(pngData)) {
		t.Fatalf("上传响应字段错误: %+v", up)
	}
	if _, err := os.ReadFile(srv.store.UploadDir() + "/" + up.Name); err != nil {
		t.Fatalf("上传文件未落盘: %v", err)
	}

	// 静态访问
	static := doRequest(t, client, http.MethodGet, ts.URL+up.URL, nil, "")
	if static.Status != http.StatusOK || !strings.HasPrefix(static.Header.Get("Content-Type"), "image/png") {
		t.Fatalf("上传图片静态访问错误: %d %s", static.Status, static.Header.Get("Content-Type"))
	}

	// 列表
	list := decodeInto[struct {
		Files []struct {
			Name  string `json:"name"`
			URL   string `json:"url"`
			Size  int64  `json:"size"`
			Mtime int64  `json:"mtime"`
		} `json:"files"`
	}](t, doRequest(t, client, http.MethodGet, ts.URL+"/api/uploads", nil, "").Body)
	if len(list.Files) != 1 || list.Files[0].Name != up.Name {
		t.Fatalf("上传列表错误: %+v", list.Files)
	}

	// 非法类型 / 伪造内容
	if res := upload("evil.txt", []byte("hello")); res.Status != http.StatusBadRequest {
		t.Fatalf("非法扩展名应返回 400, got %d", res.Status)
	}
	if res := upload("fake.png", []byte("<html>not image</html>")); res.Status != http.StatusBadRequest {
		t.Fatalf("伪造图片内容应返回 400, got %d", res.Status)
	}

	// 删除
	if res := doRequest(t, client, http.MethodDelete, ts.URL+"/api/uploads/"+up.Name, nil, ""); res.Status != http.StatusOK {
		t.Fatalf("删除上传文件应返回 200, got %d", res.Status)
	}
	if res := doRequest(t, client, http.MethodDelete, ts.URL+"/api/uploads/"+up.Name, nil, ""); res.Status != http.StatusNotFound {
		t.Fatalf("重复删除应返回 404, got %d", res.Status)
	}
}

// ---------- 导出 / 导入 / 恢复出厂 ----------

func TestAPIExportImportReset(t *testing.T) {
	_, ts := newTestServer(t, "")
	client := ts.Client()

	export := doRequest(t, client, http.MethodGet, ts.URL+"/api/export", nil, "")
	if export.Status != http.StatusOK {
		t.Fatalf("导出状态码 %d", export.Status)
	}
	if cd := export.Header.Get("Content-Disposition"); !strings.Contains(cd, "bigscreen-config.json") {
		t.Fatalf("导出 Content-Disposition 错误: %q", cd)
	}
	exported := decodeInto[Dashboard](t, export.Body)
	if exported.Title != "智慧运营数据驾驶舱" {
		t.Fatalf("导出内容错误: %q", exported.Title)
	}

	importCfg := exported
	importCfg.Rev = 999 // 导入时忽略客户端 rev
	importCfg.Title = "导入覆盖后的标题"
	importCfg.Theme = ThemeRed
	imported := decodeInto[struct {
		Config Dashboard `json:"config"`
	}](t, postJSON(t, client, ts.URL+"/api/import", importCfg).Body)
	if imported.Config.Title != "导入覆盖后的标题" || imported.Config.Theme != ThemeRed {
		t.Fatalf("导入未生效: %+v", imported.Config)
	}
	if imported.Config.Rev == 999 || imported.Config.Rev <= exported.Rev {
		t.Fatalf("导入后 rev 应由服务端重新分配, got %d", imported.Config.Rev)
	}

	if res := doRequest(t, client, http.MethodPost, ts.URL+"/api/import", []byte("{bad"), "application/json"); res.Status != http.StatusBadRequest {
		t.Fatalf("非法导入应返回 400, got %d", res.Status)
	}

	reset := decodeInto[struct {
		Config Dashboard `json:"config"`
	}](t, postJSON(t, client, ts.URL+"/api/reset", map[string]any{}).Body)
	if reset.Config.Theme != ThemeTech || reset.Config.Title != "智慧运营数据驾驶舱" {
		t.Fatalf("恢复出厂应回到科技风模板: %+v", reset.Config)
	}
}

// ---------- 鉴权 ----------

func TestAPIAuth(t *testing.T) {
	_, ts := newTestServer(t, "s3cret")
	client := ts.Client()

	current := getConfig(t, client, ts.URL)
	// 未登录：读接口放行，写接口 401
	if res := putJSON(t, client, ts.URL+"/api/config", current.Config); res.Status != http.StatusUnauthorized {
		t.Fatalf("未登录保存应返回 401, got %d", res.Status)
	}
	if res := postJSON(t, client, ts.URL+"/api/control", map[string]any{"action": "next"}); res.Status != http.StatusUnauthorized {
		t.Fatalf("未登录控制应返回 401, got %d", res.Status)
	}
	if res := doRequest(t, client, http.MethodGet, ts.URL+"/api/uploads", nil, ""); res.Status != http.StatusUnauthorized {
		t.Fatalf("未登录上传列表应返回 401, got %d", res.Status)
	}
	authInfo := decodeInto[struct {
		Required      bool `json:"required"`
		Authenticated bool `json:"authenticated"`
	}](t, doRequest(t, client, http.MethodGet, ts.URL+"/api/auth", nil, "").Body)
	if !authInfo.Required || authInfo.Authenticated {
		t.Fatalf("未登录 auth 状态错误: %+v", authInfo)
	}

	// 错误密码
	if res := postJSON(t, client, ts.URL+"/api/login", map[string]any{"password": "wrong"}); res.Status != http.StatusUnauthorized {
		t.Fatalf("错误密码应返回 401, got %d", res.Status)
	}

	// 正确密码 + Cookie
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("创建 cookie jar 失败: %v", err)
	}
	authClient := &http.Client{Jar: jar}
	login := postJSON(t, authClient, ts.URL+"/api/login", map[string]any{"password": "s3cret"})
	if login.Status != http.StatusOK {
		t.Fatalf("登录应返回 200, got %d body=%s", login.Status, string(login.Body))
	}
	if cookies := jar.Cookies(parseURL(t, ts.URL)); len(cookies) == 0 || cookies[0].Name != authCookieName {
		t.Fatalf("登录后未写入 Cookie: %+v", cookies)
	}
	authInfo = decodeInto[struct {
		Required      bool `json:"required"`
		Authenticated bool `json:"authenticated"`
	}](t, doRequest(t, authClient, http.MethodGet, ts.URL+"/api/auth", nil, "").Body)
	if !authInfo.Authenticated {
		t.Fatal("登录后 authenticated 应为 true")
	}
	// 带 Cookie 的写操作成功
	fresh := getConfig(t, authClient, ts.URL)
	fresh.Config.Title = "已登录保存"
	if res := putJSON(t, authClient, ts.URL+"/api/config", fresh.Config); res.Status != http.StatusOK {
		t.Fatalf("登录后保存应成功, got %d body=%s", res.Status, string(res.Body))
	}

	// 登出后恢复未授权
	if res := postJSON(t, authClient, ts.URL+"/api/logout", map[string]any{}); res.Status != http.StatusOK {
		t.Fatalf("登出应返回 200, got %d", res.Status)
	}
	if res := putJSON(t, authClient, ts.URL+"/api/config", fresh.Config); res.Status != http.StatusUnauthorized {
		t.Fatalf("登出后保存应返回 401, got %d", res.Status)
	}
}

// ---------- SSE ----------

func TestAPIEventsSSE(t *testing.T) {
	_, ts := newTestServer(t, "")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/api/events?role=display", nil)
	if err != nil {
		t.Fatalf("构造 SSE 请求失败: %v", err)
	}
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("建立 SSE 连接失败: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("SSE 状态码 %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("SSE Content-Type 错误: %q", ct)
	}
	if resp.Header.Get("Cache-Control") == "" || resp.Header.Get("X-Accel-Buffering") != "no" {
		t.Fatalf("SSE 响应头不完整: %+v", resp.Header)
	}

	reader := bufio.NewReader(resp.Body)
	readEvent := func() (string, string) {
		var event, data string
		for {
			line, readErr := reader.ReadString('\n')
			if readErr != nil {
				t.Fatalf("读取 SSE 失败: %v", readErr)
			}
			line = strings.TrimRight(line, "\r\n")
			if line == "" {
				if event != "" {
					return event, data
				}
				continue
			}
			if strings.HasPrefix(line, "event: ") {
				event = strings.TrimPrefix(line, "event: ")
			} else if strings.HasPrefix(line, "data: ") {
				data = strings.TrimPrefix(line, "data: ")
			}
		}
	}

	event, data := readEvent()
	if event != "hello" {
		t.Fatalf("首条 SSE 事件应为 hello, got %q", event)
	}
	hello := decodeInto[struct {
		ClientID     string    `json:"clientId"`
		Role         string    `json:"role"`
		Config       Dashboard `json:"config"`
		Runtime      Runtime   `json:"runtime"`
		ServerTime   int64     `json:"serverTime"`
		AuthRequired bool      `json:"authRequired"`
	}](t, []byte(data))
	if hello.ClientID == "" || hello.Role != "display" || hello.ServerTime <= 0 {
		t.Fatalf("hello 内容错误: %+v", hello)
	}
	if len(hello.Config.Scenes) == 0 || hello.Config.Rev < 1 {
		t.Fatalf("hello 未携带完整 config: %+v", hello.Config)
	}

	// 展示端上线后应收到 runtime 事件（displays=1）
	event, data = readEvent()
	if event != "runtime" {
		t.Fatalf("第二条 SSE 事件应为 runtime, got %q", event)
	}
	runtimeEvent := decodeInto[struct {
		Runtime Runtime `json:"runtime"`
	}](t, []byte(data))
	if runtimeEvent.Runtime.Displays != 1 {
		t.Fatalf("上线后 displays 应为 1, got %d", runtimeEvent.Runtime.Displays)
	}

	// 保存配置后应收到 config 广播
	saveCfg := hello.Config
	saveCfg.Title = "SSE 广播测试"
	if res := putJSON(t, ts.Client(), ts.URL+"/api/config", saveCfg); res.Status != http.StatusOK {
		t.Fatalf("SSE 测试保存配置失败: %d body=%s", res.Status, string(res.Body))
	}
	for i := 0; i < 5; i++ {
		event, data = readEvent()
		if event != "config" {
			continue
		}
		msg := decodeInto[struct {
			Config  Dashboard `json:"config"`
			Runtime Runtime   `json:"runtime"`
		}](t, []byte(data))
		if msg.Config.Title != "SSE 广播测试" {
			t.Fatalf("config 广播内容错误: %q", msg.Config.Title)
		}
		return
	}
	t.Fatal("未收到 config 广播事件")
}

// ---------- 静态资源 / 路径穿越 ----------

func TestAPIStaticAndPathTraversal(t *testing.T) {
	_, ts := newTestServer(t, "")
	client := ts.Client()

	for _, p := range []string{"/", "/editor", "/index.html", "/editor.html", "/css/base.css", "/js/util.js", "/assets/favicon.svg"} {
		res := doRequest(t, client, http.MethodGet, ts.URL+p, nil, "")
		if res.Status != http.StatusOK {
			t.Fatalf("静态资源 %s 状态码 %d", p, res.Status)
		}
		if res.Header.Get("Content-Type") == "" {
			t.Fatalf("静态资源 %s 缺少 Content-Type", p)
		}
	}
	if res := doRequest(t, client, http.MethodGet, ts.URL+"/not-exist.js", nil, ""); res.Status != http.StatusNotFound {
		t.Fatalf("不存在的资源应返回 404, got %d", res.Status)
	}

	srv, _ := newTestServer(t, "")
	cases := []struct {
		path    string
		handler http.HandlerFunc
	}{
		{"/uploads/..%2f..%2fetc%2fpasswd", srv.handleUploads},
		{"/uploads/../../etc/passwd", srv.handleUploads},
		{"/uploads/1793891743278-a1b2c3.png", srv.handleUploads},
		{"/css/../../server/model.go", srv.handleWeb},
		{"/uploads/../etc/passwd", srv.handleWeb},
	}
	for _, c := range cases {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, c.path, nil)
		c.handler(recorder, req)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("路径 %s 应被拒绝(404), got %d", c.path, recorder.Code)
		}
	}

	// 未知 API 返回 JSON 404
	res := doRequest(t, client, http.MethodGet, ts.URL+"/api/unknown", nil, "")
	if res.Status != http.StatusNotFound || !strings.Contains(string(res.Body), "error") {
		t.Fatalf("未知 API 应返回 JSON 404, got %d body=%s", res.Status, string(res.Body))
	}
}

func parseURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("解析 URL 失败: %v", err)
	}
	return u
}
