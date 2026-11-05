package main

import (
	"context"
	"io"
	"log"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------- 测试辅助 ----------

// newTestServer 启动一个临时数据目录 + 真实 HTTP 测试服务器（含调度器与 SSE Hub）。
func newTestServer(t *testing.T, password string) (*Server, *httptest.Server) {
	t.Helper()
	srv, err := NewServer(ServerOptions{
		Version:      "1.0.0-test",
		DataDir:      t.TempDir(),
		Password:     password,
		Logger:       log.New(io.Discard, "", 0),
		TickInterval: 10 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("创建测试服务器失败: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	srv.Run(ctx)
	ts := httptest.NewServer(srv.Routes())
	t.Cleanup(func() {
		cancel()
		ts.Close()
	})
	return srv, ts
}

func waitFor(t *testing.T, timeout time.Duration, desc string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("等待条件超时: %s", desc)
}

// ---------- 数据模型 Normalize ----------

func TestNormalizeWidgetClamp(t *testing.T) {
	d := Dashboard{
		Title:    strings.Repeat("标", 130),
		Theme:    "rainbow",
		Rotation: Rotation{Interval: 1, Transition: "spin"},
		Scenes: []Scene{{
			ID:   "s1",
			Name: "场景",
			Widgets: []Widget{
				{ID: "w1", Type: "text", X: -10, Y: -20, W: 5000, H: 5000,
					Text: &TextProps{Content: "hi", FontSize: 9999, FontWeight: 123, Align: "middle", LineHeight: 0}},
				{ID: "w2", Type: WidgetTable, X: 1900, Y: 1000, W: 900, H: 900,
					Table: &TableProps{Columns: []string{"A", "", "C"}, Rows: [][]string{{"1"}, {"2", "x", "y", "z"}}}},
				{ID: "w3", Type: WidgetImage, X: 60, Y: 200, W: 400, H: 300,
					Image: &ImageProps{Src: "javascript:alert(1)", Fit: "weird"}},
				{ID: "w4", Type: WidgetClock, X: 60, Y: 600, W: 400, H: 200,
					Clock: &ClockProps{Format: "", FontSize: 0, Align: "bad", Mode: "analog"}},
				{ID: "w5", Type: WidgetNotice, X: 60, Y: 900, W: 1800, H: 70,
					Notice: &NoticeProps{Content: strings.Repeat("通", 6000), Speed: 9999, FontSize: 1}},
			},
		}},
	}
	if err := d.Normalize(); err != nil {
		t.Fatalf("Normalize 返回错误: %v", err)
	}
	if d.Theme != ThemeTech {
		t.Errorf("非法主题应回退 tech, got %s", d.Theme)
	}
	if d.Rotation.Interval != 3 || d.Rotation.Transition != TransitionFade {
		t.Errorf("rotation 钳制错误: %+v", d.Rotation)
	}
	if len([]rune(d.Title)) != 120 {
		t.Errorf("标题应截断到 120 字符, got %d", len([]rune(d.Title)))
	}
	w := d.Scenes[0].Widgets
	// w1：负坐标归零，超大尺寸收缩到画布
	if w[0].X != 0 || w[0].Y != 0 || w[0].W != 1920 || w[0].H != 1080 {
		t.Errorf("w1 坐标钳制错误: %+v", w[0])
	}
	if w[0].Text.FontSize != 200 || w[0].Text.FontWeight != 300 || w[0].Text.Align != "left" || w[0].Text.LineHeight != 1.5 {
		t.Errorf("w1 文本属性钳制错误: %+v", w[0].Text)
	}
	// w2：x 挪入画布后宽度收缩到边界
	if w[1].X != 1840 || w[1].W != 80 || w[1].Y+w[1].H > 1080 {
		t.Errorf("w2 坐标钳制错误: %+v", w[1])
	}
	// 表格列名补默认、行长度补齐
	if w[1].Table.Columns[1] != "列 2" {
		t.Errorf("空列名应补默认值, got %q", w[1].Table.Columns[1])
	}
	if len(w[1].Table.Rows[0]) != 3 || len(w[1].Table.Rows[1]) != 3 {
		t.Errorf("表格行应补齐到列数: %+v", w[1].Table.Rows)
	}
	// 图片非法协议置空、fit 回退 cover
	if w[2].Image.Src != "" || w[2].Image.Fit != "cover" {
		t.Errorf("图片属性清洗错误: %+v", w[2].Image)
	}
	// 时钟默认值/模式
	if w[3].Clock.Format == "" || w[3].Clock.Mode != "digital" || w[3].Clock.Align != "left" {
		t.Errorf("时钟属性钳制错误: %+v", w[3].Clock)
	}
	// 通知速度/字号钳制、内容截断
	if w[4].Notice.Speed != 400 || w[4].Notice.FontSize != 10 || len([]rune(w[4].Notice.Content)) != 5000 {
		t.Errorf("通知属性钳制错误: speed=%d font=%v len=%d",
			w[4].Notice.Speed, w[4].Notice.FontSize, len([]rune(w[4].Notice.Content)))
	}
}

func TestNormalizeDefaultsAndLimits(t *testing.T) {
	d := Dashboard{}
	if err := d.Normalize(); err != nil {
		t.Fatalf("Normalize 返回错误: %v", err)
	}
	if len(d.Scenes) != 1 || d.Scenes[0].ID == "" || d.Scenes[0].Name == "" {
		t.Fatalf("空配置应补一个场景: %+v", d.Scenes)
	}
	if d.Rotation.Interval != 10 {
		t.Errorf("默认轮播间隔应为 10, got %d", d.Rotation.Interval)
	}

	// 场景数 >50 截断、每场景组件 >200 截断
	many := Dashboard{}
	for i := 0; i < 60; i++ {
		scene := Scene{ID: "s", Name: "场景", Widgets: make([]Widget, 0, 250)}
		for j := 0; j < 250; j++ {
			scene.Widgets = append(scene.Widgets, Widget{ID: "w", Type: WidgetText})
		}
		many.Scenes = append(many.Scenes, scene)
	}
	if err := many.Normalize(); err != nil {
		t.Fatalf("Normalize 返回错误: %v", err)
	}
	if len(many.Scenes) != 50 {
		t.Errorf("场景数应截断到 50, got %d", len(many.Scenes))
	}
	if len(many.Scenes[0].Widgets) != 200 {
		t.Errorf("每场景组件应截断到 200, got %d", len(many.Scenes[0].Widgets))
	}
	// 重复 ID 会被重新生成，保证唯一
	ids := make(map[string]bool)
	for _, w := range many.Scenes[0].Widgets {
		if ids[w.ID] {
			t.Fatalf("组件 ID 未去重: %s", w.ID)
		}
		ids[w.ID] = true
	}
}

func TestSanitizeImageSrc(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", ""},
		{"/uploads/a.png", "/uploads/a.png"},
		{"/assets/demo/demo-tech.svg", "/assets/demo/demo-tech.svg"},
		{"/uploads/../secret.png", ""},
		{"http://192.168.1.10/a.png", "http://192.168.1.10/a.png"},
		{"https://example.com/a.png", "https://example.com/a.png"},
		{"javascript:alert(1)", ""},
		{"data:image/png;base64,xxx", ""},
		{"ftp://example.com/a.png", ""},
		{`http://evil.com/a b.png`, ""},
	}
	for _, c := range cases {
		if got := sanitizeImageSrc(c.in); got != c.want {
			t.Errorf("sanitizeImageSrc(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	if got := sanitizeImageSrc("/assets/" + strings.Repeat("x", 600)); len([]rune(got)) != 500 {
		t.Errorf("超长图片地址应截断到 500, got %d", len([]rune(got)))
	}
}

func TestSceneDuration(t *testing.T) {
	d := Dashboard{Rotation: Rotation{Interval: 15}}
	if got := d.SceneDuration(Scene{Duration: 0}); got != 15 {
		t.Errorf("duration=0 应使用 rotation.interval, got %d", got)
	}
	if got := d.SceneDuration(Scene{Duration: 30}); got != 30 {
		t.Errorf("duration=30 应使用场景自身时长, got %d", got)
	}
	d.Rotation.Interval = 1
	if got := d.SceneDuration(Scene{Duration: 0}); got != 10 {
		t.Errorf("兜底时长应为 10, got %d", got)
	}
}

// ---------- Store ----------

func TestStoreSaveLoadAndBackup(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	if _, ok, loadErr := store.Load(); ok || loadErr != nil {
		t.Fatalf("空目录 Load 应为 (false,nil), got ok=%v err=%v", ok, loadErr)
	}
	if _, statErr := os.Stat(store.UploadDir()); statErr != nil {
		t.Fatalf("uploads 目录未创建: %v", statErr)
	}

	first := DefaultPreset()
	first.Rev = 1
	first.Title = "第一版标题"
	if err := store.Save(first); err != nil {
		t.Fatalf("首次保存失败: %v", err)
	}
	got, ok, err := store.Load()
	if err != nil || !ok {
		t.Fatalf("Load 失败: ok=%v err=%v", ok, err)
	}
	if got.Rev != 1 || got.Title != "第一版标题" {
		t.Fatalf("读取内容不一致: rev=%d title=%q", got.Rev, got.Title)
	}

	second := got
	second.Rev = 2
	second.Title = "第二版标题"
	if err := store.Save(second); err != nil {
		t.Fatalf("第二次保存失败: %v", err)
	}
	bak, err := os.ReadFile(filepath.Join(dir, configFileName+".bak"))
	if err != nil {
		t.Fatalf("未生成 .bak 备份: %v", err)
	}
	if !strings.Contains(string(bak), "第一版标题") {
		t.Fatalf(".bak 应保存上一版本内容")
	}
	// 不应残留临时文件
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("读取数据目录失败: %v", err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatalf("残留临时文件: %s", entry.Name())
		}
	}
}

func TestStoreCorruptFallbackToBackup(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	first := DefaultPreset()
	first.Rev = 1
	if err := store.Save(first); err != nil {
		t.Fatalf("保存失败: %v", err)
	}
	second := first
	second.Rev = 2
	second.Title = "第二版"
	if err := store.Save(second); err != nil {
		t.Fatalf("保存失败: %v", err)
	}
	// 主文件损坏 → 应从 .bak 恢复并返回错误提示
	if err := os.WriteFile(store.ConfigPath(), []byte("{broken json"), 0o644); err != nil {
		t.Fatalf("写入损坏文件失败: %v", err)
	}
	got, ok, loadErr := store.Load()
	if !ok {
		t.Fatal("主文件损坏时应从 .bak 恢复")
	}
	if loadErr == nil {
		t.Fatal("从备份恢复时应返回告警错误")
	}
	if got.Rev != 1 || got.Title != first.Title {
		t.Fatalf("备份内容不符合预期: rev=%d title=%q", got.Rev, got.Title)
	}
}

// ---------- Hub ----------

func TestEncodeSSE(t *testing.T) {
	got := string(encodeSSE("config", []byte(`{"a":1}`)))
	want := "event: config\ndata: {\"a\":1}\n\n"
	if got != want {
		t.Fatalf("SSE 编码错误: %q", got)
	}
	if got := string(encodeSSE("ping", nil)); got != "event: ping\ndata: {}\n\n" {
		t.Fatalf("空数据编码错误: %q", got)
	}
}

func TestHubRegisterBroadcastCounts(t *testing.T) {
	hub := NewHub()
	var mu sync.Mutex
	var snapshots [][2]int
	hub.SetCountsCallback(func(displays, editors int) {
		mu.Lock()
		snapshots = append(snapshots, [2]int{displays, editors})
		mu.Unlock()
	})

	c1 := hub.Register("c1", "display", encodeSSE("hello", []byte("{}")))
	c2 := hub.Register("c2", "editor", encodeSSE("hello", []byte("{}")))
	if d, e := hub.Counts(); d != 1 || e != 1 {
		t.Fatalf("连接数统计错误: displays=%d editors=%d", d, e)
	}
	hub.Broadcast("config", []byte(`{"rev":1}`))
	for _, c := range []*sseClient{c1, c2} {
		if got := string(<-c.Events()); got != "event: hello\ndata: {}\n\n" {
			t.Fatalf("首条事件应为 hello, got %q", got)
		}
		if got := string(<-c.Events()); got != "event: config\ndata: {\"rev\":1}\n\n" {
			t.Fatalf("广播事件错误: %q", got)
		}
	}
	hub.Unregister(c1)
	if d, e := hub.Counts(); d != 0 || e != 1 {
		t.Fatalf("注销后连接数错误: displays=%d editors=%d", d, e)
	}
	hub.Unregister(c1) // 幂等
	mu.Lock()
	last := snapshots[len(snapshots)-1]
	mu.Unlock()
	if last != [2]int{0, 1} {
		t.Fatalf("连接数回调快照错误: %v", last)
	}
}

func TestHubDropsSlowClient(t *testing.T) {
	hub := NewHub()
	slow := hub.Register("slow", "display", []byte("hello"))
	// 客户端不消费，缓冲区写满后应被断开，且不阻塞广播
	for i := 0; i < hubClientBuffer+16; i++ {
		hub.Broadcast("ping", []byte("{}"))
	}
	select {
	case <-slow.Done():
	default:
		t.Fatal("慢客户端应被 Hub 断开")
	}
	if d, _ := hub.Counts(); d != 0 {
		t.Fatalf("断开后展示端计数应为 0, got %d", d)
	}
}

func TestHubPing(t *testing.T) {
	hub := NewHub()
	hub.SetPingInterval(20 * time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go hub.Run(ctx)
	client := hub.Register("c", "editor", []byte("hello"))
	timeout := time.After(2 * time.Second)
	for {
		select {
		case ev := <-client.Events():
			if strings.Contains(string(ev), "event: ping") {
				return
			}
		case <-timeout:
			t.Fatal("未收到保活 ping 事件")
		}
	}
}

// ---------- 调度器 ----------

func TestSchedulerAutoRotation(t *testing.T) {
	srv, _ := newTestServer(t, "")
	display := srv.hub.Register("test-display", "display", encodeSSE("hello", []byte("{}")))
	waitFor(t, time.Second, "展示端上线", func() bool {
		_, rt := srv.snapshot()
		return rt.Displays == 1
	})

	// 把场景计时拨回 11 秒，等调度器按 10s duration 推进到下一场景
	srv.mu.Lock()
	sceneBefore := srv.scene
	srv.sceneStartedAt = nowMillis() - 11_000
	srv.mu.Unlock()
	waitFor(t, 2*time.Second, "自动轮播推进", func() bool {
		_, rt := srv.snapshot()
		return rt.Scene != sceneBefore
	})

	// 暂停后不应再推进
	srv.mu.Lock()
	srv.playing = false
	srv.scene = 0
	srv.sceneStartedAt = nowMillis() - 11_000
	srv.mu.Unlock()
	time.Sleep(120 * time.Millisecond)
	if _, rt := srv.snapshot(); rt.Scene != 0 {
		t.Fatalf("暂停播放后场景不应推进, got %d", rt.Scene)
	}

	// 暂停恢复 + 无展示端 → 不推进
	srv.mu.Lock()
	srv.playing = true
	srv.sceneStartedAt = nowMillis() - 11_000
	srv.mu.Unlock()
	srv.hub.Unregister(display)
	waitFor(t, time.Second, "展示端下线", func() bool {
		_, rt := srv.snapshot()
		return rt.Displays == 0
	})
	srv.mu.Lock()
	srv.sceneStartedAt = nowMillis() - 11_000
	srv.mu.Unlock()
	time.Sleep(120 * time.Millisecond)
	if _, rt := srv.snapshot(); rt.Scene != 0 {
		t.Fatalf("无展示端时不应推进, got %d", rt.Scene)
	}
}

func TestSchedulerBroadcastsAutoCommand(t *testing.T) {
	srv, _ := newTestServer(t, "")
	display := srv.hub.Register("test-display", "display", encodeSSE("hello", []byte("{}")))
	defer srv.hub.Unregister(display)
	// 清空 hello + 上线 runtime 事件
	for len(display.Events()) > 0 {
		<-display.Events()
	}
	srv.mu.Lock()
	srv.sceneStartedAt = nowMillis() - 11_000
	srv.mu.Unlock()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case ev := <-display.Events():
			if strings.Contains(string(ev), "event: command") && strings.Contains(string(ev), `"action":"auto"`) {
				return
			}
		case <-deadline:
			t.Fatal("未收到自动轮播 command 事件")
		}
	}
}
