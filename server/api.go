package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	maxConfigBody  = 32 << 20 // PUT /api/config 请求体上限
	maxImportBody  = 20 << 20 // 导入 JSON 上限
	maxUploadSize  = 20 << 20 // 单张上传图片上限（20MB）
	maxControlBody = 1 << 20  // 控制请求体上限
	maxLoginBody   = 8 << 10  // 登录请求体上限
	maxNotifyRunes = 200      // notify / reload 提示文案上限
)

// ServerOptions 是 NewServer 的启动参数。
type ServerOptions struct {
	Version      string
	DataDir      string
	Port         int
	Password     string
	Logger       *log.Logger
	TickInterval time.Duration // 轮播调度 tick（默认 250ms，测试可调小）
}

// Server 是 HTTP 层 + 配置/运行态 + 轮播调度的组合体。
// 配置与运行态统一由 mu 保护；持锁期间只做内存操作，广播一律在锁外进行。
type Server struct {
	version   string
	startTime time.Time
	port      int
	hostname  string
	dataDir   string
	store     *Store
	hub       *Hub
	auth      *Auth
	logger    *log.Logger
	tickEvery time.Duration
	urls      []string

	mu             sync.Mutex
	cfg            Dashboard
	playing        bool
	scene          int
	sceneStartedAt int64 // unix ms，服务端权威场景开始时间
	runtimeUpdated int64 // unix ms，Runtime.UpdatedAt
	prevDisplays   int
}

// NewServer 初始化数据目录、加载/初始化配置并构造服务。
func NewServer(opts ServerOptions) (*Server, error) {
	logger := opts.Logger
	if logger == nil {
		logger = log.New(io.Discard, "", 0)
	}
	version := opts.Version
	if version == "" {
		version = defaultVersion
	}
	store, err := NewStore(opts.DataDir)
	if err != nil {
		return nil, err
	}
	hostname, _ := os.Hostname()
	s := &Server{
		version:   version,
		startTime: time.Now(),
		port:      opts.Port,
		hostname:  hostname,
		dataDir:   store.DataDir(),
		store:     store,
		hub:       NewHub(),
		auth:      NewAuth(opts.Password),
		logger:    logger,
		tickEvery: opts.TickInterval,
	}
	if s.tickEvery <= 0 {
		s.tickEvery = 250 * time.Millisecond
	}
	if opts.Port > 0 {
		s.urls = collectURLs(opts.Port)
	}

	cfg, exists, loadErr := store.Load()
	if loadErr != nil {
		logger.Printf("[bigscreen] 警告: %v", loadErr)
	}
	if !exists {
		cfg = DefaultPreset()
		// 首次启动：先归一化（补全 canvas=1920x1080 等默认值并按画布钳制组件），再落盘，
		// 保证生成的 dashboard.json 完整、GET /api/config 不会返回 canvas 0x0。
		if normErr := cfg.Normalize(); normErr != nil {
			return nil, fmt.Errorf("初始化默认配置失败: %w", normErr)
		}
		cfg.Rev = 1
		cfg.UpdatedAt = time.Now()
		if saveErr := store.Save(cfg); saveErr != nil {
			return nil, fmt.Errorf("写入初始配置失败: %w", saveErr)
		}
		logger.Printf("[bigscreen] 首次启动：已使用「科技风示例」初始化 dashboard.json（画布 %dx%d）",
			cfg.Canvas.Width, cfg.Canvas.Height)
	} else {
		loadedRev := cfg.Rev
		loadedUpdatedAt := cfg.UpdatedAt
		before := mustJSON(cfg)
		// 旧版本数据可能缺少 canvas、坐标系仍按 1920x1080：先归一化（回退默认画布 + 钳制组件）。
		_ = cfg.Normalize()
		// rev/updatedAt 只能由服务端业务操作分配，加载/归一化时保留落盘值，不能借归一化“重置”版本。
		if loadedRev > 0 {
			cfg.Rev = loadedRev
		}
		if cfg.Rev <= 0 {
			cfg.Rev = 1
		}
		if loadedUpdatedAt.IsZero() {
			cfg.UpdatedAt = time.Now()
		} else {
			cfg.UpdatedAt = loadedUpdatedAt
		}
		if !bytes.Equal(before, mustJSON(cfg)) {
			// 旧格式迁移：仅当归一化确实修正了内容（如缺 canvas）时才写回，保持 rev/updatedAt 不变。
			if saveErr := store.Save(cfg); saveErr != nil {
				logger.Printf("[bigscreen] 警告: 归一化配置写回失败: %v", saveErr)
			} else {
				logger.Printf("[bigscreen] 已归一化旧配置并写回（画布 %dx%d，rev=%d）",
					cfg.Canvas.Width, cfg.Canvas.Height, cfg.Rev)
			}
		}
	}

	s.cfg = cfg
	s.playing = true
	s.scene = 0
	now := nowMillis()
	s.sceneStartedAt = now
	s.runtimeUpdated = now
	s.hub.SetCountsCallback(s.onClientsChanged)
	return s, nil
}

// Run 启动 SSE 保活与轮播调度协程（ctx 取消后退出）。
func (s *Server) Run(ctx context.Context) {
	go s.hub.Run(ctx)
	go s.schedulerLoop(ctx)
}

// Routes 构造全部路由（含请求日志中间件）。
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()

	// 公共只读接口（展示页/编辑器初始化均无需登录）
	mux.HandleFunc("GET /api/health", s.handleHealth)
	mux.HandleFunc("GET /api/info", s.handleInfo)
	mux.HandleFunc("GET /api/config", s.handleGetConfig)
	mux.HandleFunc("GET /api/events", s.handleEvents)
	mux.HandleFunc("GET /api/presets", s.handlePresetList)
	mux.HandleFunc("GET /api/presets/{id}", s.handlePresetGet)
	mux.HandleFunc("GET /api/export", s.handleExport)
	mux.HandleFunc("GET /api/auth", s.handleAuthInfo)
	mux.HandleFunc("POST /api/login", s.handleLogin)
	mux.HandleFunc("POST /api/logout", s.handleLogout)

	// 写操作/控制/上传/模板/导入/reset：启用密码后需要登录 Cookie
	mux.HandleFunc("PUT /api/config", s.auth.Require(s.handleSaveConfig))
	mux.HandleFunc("POST /api/control", s.auth.Require(s.handleControl))
	mux.HandleFunc("POST /api/presets/{id}/apply", s.auth.Require(s.handlePresetApply))
	mux.HandleFunc("POST /api/upload", s.auth.Require(s.handleUpload))
	mux.HandleFunc("GET /api/uploads", s.auth.Require(s.handleUploadList))
	mux.HandleFunc("DELETE /api/uploads/{name}", s.auth.Require(s.handleUploadDelete))
	mux.HandleFunc("POST /api/import", s.auth.Require(s.handleImport))
	mux.HandleFunc("POST /api/reset", s.auth.Require(s.handleReset))

	// 未知 /api 路径返回 JSON 404
	mux.HandleFunc("/api/", s.handleAPINotFound)
	// 上传图片走磁盘目录，其余走内嵌前端
	mux.Handle("/uploads/", http.HandlerFunc(s.handleUploads))
	mux.Handle("/", http.HandlerFunc(s.handleWeb))

	return logRequests(s.logger, mux)
}

// ---------- 运行态 / 调度 ----------

func (s *Server) runtimeLocked() Runtime {
	displays, editors := s.hub.Counts()
	scene := s.scene
	duration := 10
	if len(s.cfg.Scenes) > 0 {
		if scene < 0 {
			scene = 0
		}
		if scene >= len(s.cfg.Scenes) {
			scene = len(s.cfg.Scenes) - 1
		}
		duration = s.cfg.SceneDuration(s.cfg.Scenes[scene])
	} else {
		scene = 0
	}
	return Runtime{
		Playing:        s.playing,
		Scene:          scene,
		Duration:       duration,
		SceneStartedAt: s.sceneStartedAt,
		Displays:       displays,
		Editors:        editors,
		UpdatedAt:      s.runtimeUpdated,
	}
}

// resetRuntimeLocked 重置场景计时（配置保存/手动控制后调用），并在场景数变化时钳制索引。
func (s *Server) resetRuntimeLocked() {
	if len(s.cfg.Scenes) == 0 {
		s.scene = 0
	} else if s.scene < 0 {
		s.scene = 0
	} else if s.scene >= len(s.cfg.Scenes) {
		s.scene = len(s.cfg.Scenes) - 1
	}
	now := nowMillis()
	s.sceneStartedAt = now
	s.runtimeUpdated = now
}

// replaceConfigLocked 归一化并持久化新配置，然后重置运行态计时（调用方需持有 s.mu）。
func (s *Server) replaceConfigLocked(next Dashboard) (Dashboard, Runtime, error) {
	if err := next.Normalize(); err != nil {
		return Dashboard{}, Runtime{}, err
	}
	next.Rev = s.cfg.Rev + 1
	next.UpdatedAt = time.Now()
	if err := s.store.Save(next); err != nil {
		return Dashboard{}, Runtime{}, err
	}
	s.cfg = next
	s.resetRuntimeLocked()
	return s.cfg, s.runtimeLocked(), nil
}

// snapshot 返回当前配置与运行态的一致性快照。
func (s *Server) snapshot() (Dashboard, Runtime) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfg, s.runtimeLocked()
}

func (s *Server) broadcastConfig(cfg Dashboard, rt Runtime) {
	s.hub.Broadcast("config", mustJSON(map[string]any{"config": cfg, "runtime": rt}))
}

func (s *Server) broadcastRuntime(rt Runtime) {
	s.hub.Broadcast("runtime", mustJSON(map[string]any{"runtime": rt}))
}

// onClientsChanged 在展示端/编辑端连接数变化时广播 runtime。
// 展示端从 0 变成 >0 时重置场景计时，实现“无展示端时暂停计时”。
func (s *Server) onClientsChanged(displays, editors int) {
	now := nowMillis()
	s.mu.Lock()
	if displays > 0 && s.prevDisplays == 0 {
		s.sceneStartedAt = now
	}
	s.prevDisplays = displays
	s.runtimeUpdated = now
	rt := s.runtimeLocked()
	s.mu.Unlock()
	s.broadcastRuntime(rt)
}

func (s *Server) schedulerLoop(ctx context.Context) {
	ticker := time.NewTicker(s.tickEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.tick()
		}
	}
}

// tick 是服务端权威轮播：playing && rotation.auto && displays>0 时按场景 duration 推进。
func (s *Server) tick() {
	now := nowMillis()
	s.mu.Lock()
	displays, _ := s.hub.Counts()
	if !s.playing || !s.cfg.Rotation.Auto || displays <= 0 || len(s.cfg.Scenes) == 0 {
		s.mu.Unlock()
		return
	}
	scene := s.scene
	if scene < 0 || scene >= len(s.cfg.Scenes) {
		scene = 0
		s.scene = 0
	}
	duration := s.cfg.SceneDuration(s.cfg.Scenes[scene])
	if s.sceneStartedAt <= 0 {
		s.sceneStartedAt = now
		s.mu.Unlock()
		return
	}
	if now-s.sceneStartedAt < int64(duration)*1000 {
		s.mu.Unlock()
		return
	}
	s.scene = (scene + 1) % len(s.cfg.Scenes)
	s.sceneStartedAt = now
	s.runtimeUpdated = now
	rt := s.runtimeLocked()
	sceneIndex := s.scene
	s.mu.Unlock()

	s.hub.Broadcast("command", mustJSON(map[string]any{
		"action":     "auto",
		"sceneIndex": sceneIndex,
		"message":    "",
		"runtime":    rt,
		"serverTime": now,
	}))
	s.logger.Printf("[bigscreen] 自动轮播切换到场景 %d", sceneIndex)
}

// ---------- 通用 JSON 辅助 ----------

func writeJSON(w http.ResponseWriter, status int, payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

func writeErrorJSON(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

// decodeJSONBody 读取并限制请求体大小，且只接受单个 JSON 值。
func decodeJSONBody(w http.ResponseWriter, r *http.Request, dst any, limit int64) error {
	if r.Body == nil {
		return errors.New("请求体为空")
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(dst); err != nil {
		return err
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		return errors.New("请求体包含多余内容")
	}
	return nil
}

func nowMillis() int64 { return time.Now().UnixNano() / int64(time.Millisecond) }

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%06x", time.Now().UnixNano()&0xffffff)
	}
	return hex.EncodeToString(b)
}

// ---------- 健康 / 信息 ----------

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":        "ok",
		"version":       s.version,
		"uptimeSeconds": int64(time.Since(s.startTime).Seconds()),
	})
}

func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
	urls := s.urls
	if len(urls) == 0 {
		host := r.Host
		if host == "" {
			host = fmt.Sprintf("127.0.0.1:%d", s.port)
		}
		urls = []string{"http://" + host}
	}
	base := urls[0]
	writeJSON(w, http.StatusOK, map[string]any{
		"version":      s.version,
		"hostname":     s.hostname,
		"port":         s.port,
		"os":           runtime.GOOS,
		"arch":         runtime.GOARCH,
		"urls":         urls,
		"displayUrl":   base + "/",
		"editorUrl":    base + "/editor",
		"goVersion":    runtime.Version(),
		"dataDir":      s.dataDir,
		"authRequired": s.auth.Enabled(),
		"serverTime":   nowMillis(),
	})
}

// ---------- 配置读写 ----------

func (s *Server) handleGetConfig(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	cfg := s.cfg
	rt := s.runtimeLocked()
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"config": cfg, "runtime": rt})
}

// handleSaveConfig 保存配置。
// rev==0 视为模板草稿/强制覆盖（编辑器载入预设后直接保存）；rev>0 且不匹配返回 409。
func (s *Server) handleSaveConfig(w http.ResponseWriter, r *http.Request) {
	var incoming Dashboard
	if err := decodeJSONBody(w, r, &incoming, maxConfigBody); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, "请求体不是合法的 Dashboard JSON: "+err.Error())
		return
	}
	clientRev := incoming.Rev

	s.mu.Lock()
	if clientRev != 0 && clientRev != s.cfg.Rev {
		current := s.cfg
		s.mu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":  "revision conflict",
			"config": current,
		})
		return
	}
	cfg, rt, err := s.replaceConfigLocked(incoming)
	s.mu.Unlock()
	if err != nil {
		s.logger.Printf("[bigscreen] 保存配置失败: %v", err)
		writeErrorJSON(w, http.StatusInternalServerError, "保存配置失败: "+err.Error())
		return
	}
	s.broadcastConfig(cfg, rt)
	s.logger.Printf("[bigscreen] 配置已保存 rev=%d scenes=%d", cfg.Rev, len(cfg.Scenes))
	writeJSON(w, http.StatusOK, map[string]any{"config": cfg})
}

// ---------- 远程控制 ----------

func (s *Server) handleControl(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Action     string `json:"action"`
		SceneIndex *int   `json:"sceneIndex"`
		Message    string `json:"message"`
	}
	if err := decodeJSONBody(w, r, &req, maxControlBody); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, "请求体不合法: "+err.Error())
		return
	}
	action := strings.TrimSpace(req.Action)
	message := truncRunes(strings.TrimSpace(req.Message), maxNotifyRunes)
	now := nowMillis()

	s.mu.Lock()
	sceneCount := len(s.cfg.Scenes)
	switch action {
	case "play":
		s.playing = true
	case "pause":
		s.playing = false
	case "toggle":
		s.playing = !s.playing
	case "next":
		if sceneCount > 0 {
			s.scene = (s.scene + 1) % sceneCount
		}
	case "prev":
		if sceneCount > 0 {
			s.scene = (s.scene - 1 + sceneCount) % sceneCount
		}
	case "goto":
		if req.SceneIndex == nil {
			s.mu.Unlock()
			writeErrorJSON(w, http.StatusBadRequest, "goto 必须携带 sceneIndex")
			return
		}
		idx := *req.SceneIndex
		if idx < 0 || idx >= sceneCount {
			s.mu.Unlock()
			writeErrorJSON(w, http.StatusBadRequest, "sceneIndex 超出范围")
			return
		}
		s.scene = idx
	case "reload":
	case "notify":
		if message == "" {
			s.mu.Unlock()
			writeErrorJSON(w, http.StatusBadRequest, "notify 必须携带 message")
			return
		}
	default:
		s.mu.Unlock()
		writeErrorJSON(w, http.StatusBadRequest, "不支持的控制动作: "+action)
		return
	}
	// 播放控制与场景切换都重置当前场景计时；reload/notify 不打断轮播节奏。
	if action != "reload" && action != "notify" {
		s.sceneStartedAt = now
	}
	s.runtimeUpdated = now
	rt := s.runtimeLocked()
	sceneIndex := rt.Scene
	s.mu.Unlock()

	s.hub.Broadcast("command", mustJSON(map[string]any{
		"action":     action,
		"sceneIndex": sceneIndex,
		"message":    message,
		"runtime":    rt,
		"serverTime": now,
	}))
	s.hub.Broadcast("runtime", mustJSON(map[string]any{"runtime": rt}))
	writeJSON(w, http.StatusOK, map[string]any{"runtime": rt})
}

// ---------- SSE ----------

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	role := strings.TrimSpace(r.URL.Query().Get("role"))
	if role != "display" {
		role = "editor"
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErrorJSON(w, http.StatusInternalServerError, "当前服务器不支持 SSE")
		return
	}
	header := w.Header()
	header.Set("Content-Type", "text/event-stream; charset=utf-8")
	header.Set("Cache-Control", "no-cache, no-transform")
	header.Set("Connection", "keep-alive")
	header.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	// hello 必须先于其它事件到达：Register 内部把 hello 作为第一条事件入队。
	clientID := newID("c")
	hello := s.helloPayload(clientID, role)
	client := s.hub.Register(clientID, role, hello)
	defer s.hub.Unregister(client)

	for {
		select {
		case <-r.Context().Done():
			return
		case <-client.Done():
			return
		case msg := <-client.Events():
			if _, err := w.Write(msg); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (s *Server) helloPayload(clientID, role string) []byte {
	s.mu.Lock()
	cfg := s.cfg
	rt := s.runtimeLocked()
	s.mu.Unlock()
	return encodeSSE("hello", mustJSON(map[string]any{
		"clientId":     clientID,
		"role":         role,
		"config":       cfg,
		"runtime":      rt,
		"serverTime":   nowMillis(),
		"authRequired": s.auth.Enabled(),
	}))
}

// ---------- 模板 ----------

func (s *Server) handlePresetList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"presets": PresetList()})
}

func (s *Server) handlePresetGet(w http.ResponseWriter, r *http.Request) {
	preset, ok := PresetByID(r.PathValue("id"))
	if !ok {
		writeErrorJSON(w, http.StatusNotFound, "模板不存在")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"config": preset})
}

func (s *Server) handlePresetApply(w http.ResponseWriter, r *http.Request) {
	preset, ok := PresetByID(r.PathValue("id"))
	if !ok {
		writeErrorJSON(w, http.StatusNotFound, "模板不存在")
		return
	}
	s.mu.Lock()
	cfg, rt, err := s.replaceConfigLocked(preset)
	s.mu.Unlock()
	if err != nil {
		s.logger.Printf("[bigscreen] 应用模板失败: %v", err)
		writeErrorJSON(w, http.StatusInternalServerError, "应用模板失败: "+err.Error())
		return
	}
	s.broadcastConfig(cfg, rt)
	s.logger.Printf("[bigscreen] 已应用模板 rev=%d", cfg.Rev)
	writeJSON(w, http.StatusOK, map[string]any{"config": cfg})
}

// ---------- 上传 ----------

func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize+(1<<20))
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, "上传内容过大或表单格式错误")
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeErrorJSON(w, http.StatusBadRequest, "缺少 file 字段")
		return
	}
	defer file.Close()

	ext := strings.ToLower(filepath.Ext(header.Filename))
	if _, ok := imageExtContentTypes[ext]; !ok {
		writeErrorJSON(w, http.StatusBadRequest, "仅支持 png/jpg/jpeg/gif/webp/bmp 图片")
		return
	}
	peek := make([]byte, 512)
	n, readErr := io.ReadFull(file, peek)
	if readErr != nil && readErr != io.ErrUnexpectedEOF && readErr != io.EOF {
		writeErrorJSON(w, http.StatusBadRequest, "读取上传文件失败")
		return
	}
	peek = peek[:n]
	if !validImageMagic(ext, peek) {
		writeErrorJSON(w, http.StatusBadRequest, "文件内容不是有效的图片")
		return
	}

	name, size, err := s.saveUpload(ext, io.MultiReader(bytes.NewReader(peek), file))
	if err != nil {
		if errors.Is(err, errFileTooLarge) {
			writeErrorJSON(w, http.StatusBadRequest, "文件超过 20MB 限制")
			return
		}
		s.logger.Printf("[bigscreen] 保存上传文件失败: %v", err)
		writeErrorJSON(w, http.StatusInternalServerError, "保存上传文件失败")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"name": name,
		"url":  "/uploads/" + name,
		"size": size,
	})
}

var errFileTooLarge = errors.New("file too large")

// saveUpload 以“时间戳-随机串.扩展名”落盘，并保证不超过 20MB。
func (s *Server) saveUpload(ext string, content io.Reader) (string, int64, error) {
	for attempt := 0; attempt < 5; attempt++ {
		name := fmt.Sprintf("%d-%s%s", time.Now().UnixMilli(), randomHex(3), ext)
		full := filepath.Join(s.store.UploadDir(), name)
		out, err := os.OpenFile(full, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err != nil {
			if errors.Is(err, os.ErrExist) {
				continue
			}
			return "", 0, err
		}
		written, copyErr := io.Copy(out, io.LimitReader(content, maxUploadSize+1))
		closeErr := out.Close()
		if copyErr != nil {
			_ = os.Remove(full)
			return "", 0, copyErr
		}
		if closeErr != nil {
			_ = os.Remove(full)
			return "", 0, closeErr
		}
		if written > maxUploadSize {
			_ = os.Remove(full)
			return "", 0, errFileTooLarge
		}
		return name, written, nil
	}
	return "", 0, errors.New("生成唯一文件名失败")
}

func validImageMagic(ext string, head []byte) bool {
	switch ext {
	case ".png":
		return bytes.HasPrefix(head, []byte("\x89PNG\r\n\x1a\n"))
	case ".jpg", ".jpeg":
		return bytes.HasPrefix(head, []byte{0xFF, 0xD8, 0xFF})
	case ".gif":
		return bytes.HasPrefix(head, []byte("GIF87a")) || bytes.HasPrefix(head, []byte("GIF89a"))
	case ".webp":
		return len(head) >= 12 && bytes.HasPrefix(head, []byte("RIFF")) && string(head[8:12]) == "WEBP"
	case ".bmp":
		return bytes.HasPrefix(head, []byte("BM"))
	}
	return false
}

func (s *Server) handleUploadList(w http.ResponseWriter, r *http.Request) {
	entries, err := os.ReadDir(s.store.UploadDir())
	if err != nil {
		s.logger.Printf("[bigscreen] 读取上传目录失败: %v", err)
		writeErrorJSON(w, http.StatusInternalServerError, "读取上传目录失败")
		return
	}
	type uploadItem struct {
		Name  string `json:"name"`
		URL   string `json:"url"`
		Size  int64  `json:"size"`
		Mtime int64  `json:"mtime"`
	}
	files := make([]uploadItem, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if _, ok := imageExtContentTypes[strings.ToLower(filepath.Ext(name))]; !ok {
			continue
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			continue
		}
		files = append(files, uploadItem{
			Name:  name,
			URL:   "/uploads/" + name,
			Size:  info.Size(),
			Mtime: info.ModTime().Unix(),
		})
	}
	sort.Slice(files, func(i, j int) bool {
		if files[i].Mtime != files[j].Mtime {
			return files[i].Mtime > files[j].Mtime
		}
		return files[i].Name > files[j].Name
	})
	writeJSON(w, http.StatusOK, map[string]any{"files": files})
}

func (s *Server) handleUploadDelete(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !validUploadFileName(name) {
		writeErrorJSON(w, http.StatusBadRequest, "文件名不合法")
		return
	}
	full := filepath.Join(s.store.UploadDir(), name)
	if err := os.Remove(full); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeErrorJSON(w, http.StatusNotFound, "文件不存在")
			return
		}
		s.logger.Printf("[bigscreen] 删除上传文件失败: %v", err)
		writeErrorJSON(w, http.StatusInternalServerError, "删除文件失败")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ---------- 导入 / 导出 / 恢复出厂 ----------

func (s *Server) handleExport(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	cfg := s.cfg
	s.mu.Unlock()
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		writeErrorJSON(w, http.StatusInternalServerError, "导出配置失败")
		return
	}
	data = append(data, '\n')
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="bigscreen-config.json"`)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (s *Server) handleImport(w http.ResponseWriter, r *http.Request) {
	var incoming Dashboard
	if err := decodeJSONBody(w, r, &incoming, maxImportBody); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, "导入内容不是合法的 Dashboard JSON: "+err.Error())
		return
	}
	incoming.Rev = 0 // 导入忽略客户端 rev，由服务端重新分配
	s.mu.Lock()
	cfg, rt, err := s.replaceConfigLocked(incoming)
	s.mu.Unlock()
	if err != nil {
		s.logger.Printf("[bigscreen] 导入配置失败: %v", err)
		writeErrorJSON(w, http.StatusInternalServerError, "导入配置失败: "+err.Error())
		return
	}
	s.broadcastConfig(cfg, rt)
	s.logger.Printf("[bigscreen] 已导入配置 rev=%d", cfg.Rev)
	writeJSON(w, http.StatusOK, map[string]any{"config": cfg})
}

func (s *Server) handleReset(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	cfg, rt, err := s.replaceConfigLocked(DefaultPreset())
	s.mu.Unlock()
	if err != nil {
		s.logger.Printf("[bigscreen] 恢复默认模板失败: %v", err)
		writeErrorJSON(w, http.StatusInternalServerError, "恢复默认模板失败: "+err.Error())
		return
	}
	s.broadcastConfig(cfg, rt)
	s.logger.Printf("[bigscreen] 已恢复默认模板 rev=%d", cfg.Rev)
	writeJSON(w, http.StatusOK, map[string]any{"config": cfg})
}

// ---------- 鉴权 ----------

func (s *Server) handleAuthInfo(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{
		"required":      s.auth.Enabled(),
		"authenticated": s.auth.Authenticated(r),
	})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if !s.auth.Enabled() {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}
	var req struct {
		Password string `json:"password"`
	}
	if err := decodeJSONBody(w, r, &req, maxLoginBody); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, "请求体不合法")
		return
	}
	if !s.auth.CheckPassword(req.Password) {
		writeErrorJSON(w, http.StatusUnauthorized, "密码错误")
		return
	}
	s.auth.SetCookie(w, r)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	s.auth.ClearCookie(w, r)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleAPINotFound(w http.ResponseWriter, r *http.Request) {
	writeErrorJSON(w, http.StatusNotFound, "not found")
}
