package main

import (
	"embed"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// 前端资源全部内嵌进单二进制（all: 保证包含以 _ / . 开头的隐藏文件）。
//
//go:embed all:web
var embeddedWeb embed.FS

// webRoot 指向内嵌资源里的 web 目录。
var webRoot fs.FS = mustSubFS(embeddedWeb, "web")

func mustSubFS(fsys fs.FS, dir string) fs.FS {
	sub, err := fs.Sub(fsys, dir)
	if err != nil {
		panic("内嵌前端资源不可用: " + err.Error())
	}
	return sub
}

// imageExtContentTypes 上传/展示允许的图片扩展名（同时用于静态资源 MIME）。
var imageExtContentTypes = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".bmp":  "image/bmp",
}

var staticContentTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".js":    "text/javascript; charset=utf-8",
	".mjs":   "text/javascript; charset=utf-8",
	".json":  "application/json; charset=utf-8",
	".map":   "application/json; charset=utf-8",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".jpg":   "image/jpeg",
	".jpeg":  "image/jpeg",
	".gif":   "image/gif",
	".webp":  "image/webp",
	".ico":   "image/x-icon",
	".bmp":   "image/bmp",
	".woff":  "font/woff",
	".woff2": "font/woff2",
	".ttf":   "font/ttf",
	".txt":   "text/plain; charset=utf-8",
}

func contentTypeForFile(name string) string {
	ext := strings.ToLower(path.Ext(name))
	if ct, ok := staticContentTypes[ext]; ok {
		return ct
	}
	if ct := mime.TypeByExtension(ext); ct != "" {
		return ct
	}
	return "application/octet-stream"
}

// serveEmbeddedFile 输出内嵌静态文件（含 MIME/缓存头）。
func serveEmbeddedFile(w http.ResponseWriter, r *http.Request, name string) {
	data, err := fs.ReadFile(webRoot, name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", contentTypeForFile(name))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if strings.HasSuffix(name, ".html") {
		w.Header().Set("Cache-Control", "no-cache")
	} else {
		w.Header().Set("Cache-Control", "public, max-age=300")
	}
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(data)
}

// handleWeb 处理 / 、/editor 以及 /css /js /assets 等内嵌静态资源。
func (s *Server) handleWeb(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api") {
		writeErrorJSON(w, http.StatusNotFound, "not found")
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeErrorJSON(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	switch r.URL.Path {
	case "/", "/index.html":
		serveEmbeddedFile(w, r, "index.html")
		return
	case "/editor", "/editor/", "/editor.html":
		serveEmbeddedFile(w, r, "editor.html")
		return
	}

	// path.Clean 会消解 .. 与重复分隔符，再做二次校验，杜绝路径穿越。
	clean := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if clean == "" || clean == "." || strings.HasPrefix(clean, "uploads/") || strings.Contains(clean, "..") {
		http.NotFound(w, r)
		return
	}
	info, err := fs.Stat(webRoot, clean)
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	serveEmbeddedFile(w, r, clean)
}

// handleUploads 输出 data/uploads 下的用户图片。
func (s *Server) handleUploads(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeErrorJSON(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/uploads/")
	if !validUploadFileName(name) {
		http.NotFound(w, r)
		return
	}
	ext := strings.ToLower(filepath.Ext(name))
	ct, ok := imageExtContentTypes[ext]
	if !ok {
		http.NotFound(w, r)
		return
	}
	full := filepath.Join(s.store.UploadDir(), name)
	f, err := os.Open(full)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, name, st.ModTime(), f)
}

// validUploadFileName 上传文件名只允许单层、无路径分隔符、非隐藏文件名。
func validUploadFileName(name string) bool {
	if name == "" || len(name) > 255 {
		return false
	}
	if name != filepath.Base(name) || strings.ContainsAny(name, "/\\") {
		return false
	}
	if name == "." || name == ".." || strings.HasPrefix(name, ".") || strings.Contains(name, "..") {
		return false
	}
	return true
}
