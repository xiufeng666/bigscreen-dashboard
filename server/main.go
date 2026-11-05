package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"
)

// defaultVersion 是默认版本号；scripts/build-all.sh 通过 -X main.version=... 注入。
const defaultVersion = "1.0.0"

var version = defaultVersion

func main() {
	port := flag.Int("port", 8080, "监听端口")
	dataDir := flag.String("data", "./data", "数据目录（配置与上传图片）")
	password := flag.String("password", "", "编辑/控制鉴权密码，空=不鉴权")
	autoOpen := flag.Bool("open", false, "启动后自动打开浏览器展示大屏")
	showVersion := flag.Bool("version", false, "打印版本号后退出")
	flag.Parse()

	if *showVersion {
		fmt.Printf("bigscreen-server %s (%s %s/%s)\n", version, runtime.Version(), runtime.GOOS, runtime.GOARCH)
		return
	}

	if err := run(*port, *dataDir, *password, *autoOpen); err != nil {
		fmt.Fprintf(os.Stderr, "[bigscreen] 启动失败: %v\n", err)
		os.Exit(1)
	}
}

func run(port int, dataDir, password string, autoOpen bool) error {
	logger := log.New(os.Stdout, "", log.LstdFlags)
	srv, err := NewServer(ServerOptions{
		Version:  version,
		DataDir:  dataDir,
		Port:     port,
		Password: password,
		Logger:   logger,
	})
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	listener, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		return fmt.Errorf("端口 %d 监听失败（可能已被占用，可用 -port 换一个端口）: %w", port, err)
	}
	if tcpAddr, ok := listener.Addr().(*net.TCPAddr); ok {
		srv.port = tcpAddr.Port
	}
	srv.urls = collectURLs(srv.port)

	srv.Run(ctx)

	httpServer := &http.Server{
		Handler:           srv.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		// 不设置 WriteTimeout：SSE 长连接需要持续写，写超时会误杀展示端。
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- httpServer.Serve(listener) }()

	srv.PrintBanner()
	if autoOpen {
		go func() {
			time.Sleep(400 * time.Millisecond)
			url := fmt.Sprintf("http://127.0.0.1:%d/", srv.port)
			if openErr := openInBrowser(url); openErr != nil {
				logger.Printf("[bigscreen] 自动打开浏览器失败: %v", openErr)
			}
		}()
	}

	select {
	case <-ctx.Done():
		logger.Println("[bigscreen] 收到退出信号，正在关闭服务…")
	case err := <-serveErr:
		if err != nil && err != http.ErrServerClosed {
			return err
		}
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		logger.Printf("[bigscreen] 优雅关闭超时: %v", err)
	}
	logger.Println("[bigscreen] 服务已停止")
	return nil
}

// PrintBanner 打印启动横幅：版本、数据目录、鉴权状态、局域网访问地址。
func (s *Server) PrintBanner() {
	line := strings.Repeat("=", 64)
	fmt.Println()
	fmt.Println(line)
	fmt.Printf("  BigScreen 大屏看板  v%s  (%s %s/%s)\n", s.version, runtime.Version(), runtime.GOOS, runtime.GOARCH)
	fmt.Println(line)
	fmt.Printf("  数据目录 : %s\n", s.dataDir)
	if s.auth.Enabled() {
		fmt.Println("  编辑密码 : 已启用（编辑器/控制接口需要登录）")
	} else {
		fmt.Println("  编辑密码 : 未启用（局域网内可直接编辑，建议加 -password 设置密码）")
	}
	fmt.Println("  展示大屏 :")
	for _, u := range s.urls {
		fmt.Printf("    %s/\n", u)
	}
	fmt.Println("  远程编辑 :")
	for _, u := range s.urls {
		fmt.Printf("    %s/editor\n", u)
	}
	fmt.Printf("  本机访问 : http://127.0.0.1:%d/editor\n", s.port)
	fmt.Println(line)
	fmt.Println("  数据文件 : data/dashboard.json（自动备份 .bak）、data/uploads/")
	fmt.Println("  停止服务 : 按 Ctrl+C")
	fmt.Println(line)
	fmt.Println()
}

// collectURLs 收集本机所有非回环 IPv4 地址，用于局域网访问提示。
func collectURLs(port int) []string {
	seen := make(map[string]bool)
	urls := make([]string, 0, 4)
	ifaces, err := net.Interfaces()
	if err == nil {
		for _, iface := range ifaces {
			if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
				continue
			}
			addrs, addrErr := iface.Addrs()
			if addrErr != nil {
				continue
			}
			for _, addr := range addrs {
				ipNet, ok := addr.(*net.IPNet)
				if !ok {
					continue
				}
				ip := ipNet.IP.To4()
				if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
					continue
				}
				u := fmt.Sprintf("http://%s:%d", ip.String(), port)
				if !seen[u] {
					seen[u] = true
					urls = append(urls, u)
				}
			}
		}
	}
	sort.Strings(urls)
	if len(urls) == 0 {
		urls = []string{fmt.Sprintf("http://127.0.0.1:%d", port)}
	}
	return urls
}

// openInBrowser 按平台调用系统默认浏览器（离线环境，失败只告警）。
func openInBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	return cmd.Start()
}

// ---------- 请求日志（只记录 /api 与 /uploads，简洁） ----------

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	if r.status == 0 {
		r.status = status
	}
	r.ResponseWriter.WriteHeader(status)
}

func (r *statusRecorder) Write(p []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	return r.ResponseWriter.Write(p)
}

// Flush 保证 SSE 在日志中间件包裹后仍可即时推送。
func (r *statusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func logRequests(logger *log.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if !strings.HasPrefix(p, "/api/") && !strings.HasPrefix(p, "/uploads/") {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)
		status := rec.status
		if status == 0 {
			status = http.StatusOK
		}
		logger.Printf("[api] %s %s %d %s %s", r.Method, p, status,
			time.Since(start).Round(time.Millisecond), clientIP(r))
	})
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i >= 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
