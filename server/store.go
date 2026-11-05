package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
)

const (
	configFileName = "dashboard.json"
	uploadsDirName = "uploads"
)

// Store 负责 dashboard.json 的持久化与上传目录管理。
// 写入策略：临时文件 + fsync + 旧文件轮转为 .bak + rename，避免出现半截 JSON。
type Store struct {
	dir     string
	path    string
	bakPath string
	mu      sync.Mutex
}

// NewStore 创建数据目录（含 uploads 子目录）。
func NewStore(dir string) (*Store, error) {
	if dir == "" {
		dir = "."
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, fmt.Errorf("解析数据目录失败: %w", err)
	}
	if err := os.MkdirAll(filepath.Join(abs, uploadsDirName), 0o755); err != nil {
		return nil, fmt.Errorf("创建数据目录失败: %w", err)
	}
	return &Store{
		dir:     abs,
		path:    filepath.Join(abs, configFileName),
		bakPath: filepath.Join(abs, configFileName+".bak"),
	}, nil
}

// DataDir 返回数据目录绝对路径。
func (s *Store) DataDir() string { return s.dir }

// UploadDir 返回上传文件目录绝对路径。
func (s *Store) UploadDir() string { return filepath.Join(s.dir, uploadsDirName) }

// ConfigPath 返回 dashboard.json 绝对路径。
func (s *Store) ConfigPath() string { return s.path }

// Load 读取配置。ok=false 表示首次运行（文件不存在）。
// 主文件损坏时尝试从 .bak 回退，并以错误形式提示调用方（此时 ok=true）。
func (s *Store) Load() (Dashboard, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var d Dashboard
	data, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return d, false, nil
		}
		return d, false, err
	}
	if uerr := json.Unmarshal(data, &d); uerr != nil {
		if bak, bakErr := s.readBackupLocked(); bakErr == nil {
			return bak, true, fmt.Errorf("%s 解析失败，已回退到备份文件: %w", s.path, uerr)
		}
		return d, false, fmt.Errorf("%s 解析失败: %w", s.path, uerr)
	}
	return d, true, nil
}

func (s *Store) readBackupLocked() (Dashboard, error) {
	var d Dashboard
	data, err := os.ReadFile(s.bakPath)
	if err != nil {
		return d, err
	}
	if err := json.Unmarshal(data, &d); err != nil {
		return d, err
	}
	return d, nil
}

// Save 原子写入配置，并把上一版文件备份为 dashboard.json.bak。
func (s *Store) Save(d Dashboard) error {
	data, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化配置失败: %w", err)
	}
	data = append(data, '\n')

	s.mu.Lock()
	defer s.mu.Unlock()

	tmpPath := s.path + ".tmp"
	f, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return fmt.Errorf("创建临时文件失败: %w", err)
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fmt.Errorf("写入临时文件失败: %w", err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fmt.Errorf("同步临时文件失败: %w", err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("关闭临时文件失败: %w", err)
	}

	// 旧配置备份为 .bak；备份失败不阻塞保存。
	if _, statErr := os.Stat(s.path); statErr == nil {
		_ = copyFile(s.path, s.bakPath)
	}
	if err := replaceFile(tmpPath, s.path); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("替换配置文件失败: %w", err)
	}
	// 尽力把 rename 落盘（目录 fsync 在部分平台不支持，忽略错误）。
	if dir, derr := os.Open(s.dir); derr == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return nil
}

// replaceFile 用 src 替换 dst；Windows 上 rename 不能覆盖已存在文件，退化为先删后改。
func replaceFile(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	if err := os.Remove(dst); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.Rename(src, dst)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := out.Sync(); err != nil {
		_ = out.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return replaceFile(tmp, dst)
}
