package main

import (
	"context"
	"encoding/json"
	"sync"
	"time"
)

// hubClientBuffer 每个客户端的发送缓冲；写满说明客户端消费过慢，直接断开。
const hubClientBuffer = 64

// sseClient 是一条 SSE 连接在 Hub 中的句柄。
type sseClient struct {
	ID   string
	Role string

	ch   chan []byte
	done chan struct{}
	once sync.Once
}

// Events 返回待发送事件通道（按顺序）。
func (c *sseClient) Events() <-chan []byte { return c.ch }

// Done 在客户端被 Hub 关闭/断开时关闭。
func (c *sseClient) Done() <-chan struct{} { return c.done }

func (c *sseClient) close() { c.once.Do(func() { close(c.done) }) }

// Hub 管理所有 SSE 客户端。
// 广播对每个客户端只做非阻塞写入，慢客户端会被直接摘除，绝不阻塞全局广播。
type Hub struct {
	mu       sync.Mutex
	clients  map[string]*sseClient
	pingFreq time.Duration
	onCounts func(displays, editors int)
}

// NewHub 创建 Hub（默认 20s 保活 ping）。
func NewHub() *Hub {
	return &Hub{clients: make(map[string]*sseClient), pingFreq: 20 * time.Second}
}

// SetPingInterval 调整 ping 周期（测试用）。
func (h *Hub) SetPingInterval(d time.Duration) {
	if d <= 0 {
		return
	}
	h.mu.Lock()
	h.pingFreq = d
	h.mu.Unlock()
}

// SetCountsCallback 设置连接数变化回调；回调在 Hub 锁外执行，可安全地再广播。
func (h *Hub) SetCountsCallback(fn func(displays, editors int)) {
	h.mu.Lock()
	h.onCounts = fn
	h.mu.Unlock()
}

// Run 启动 20s 保活 ping，ctx 取消后退出。
func (h *Hub) Run(ctx context.Context) {
	h.mu.Lock()
	interval := h.pingFreq
	h.mu.Unlock()
	if interval <= 0 {
		interval = 20 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.Broadcast("ping", []byte("{}"))
		}
	}
}

// Register 注册客户端：hello 作为第一条事件入队，随后通知连接数变化。
func (h *Hub) Register(id, role string, hello []byte) *sseClient {
	c := &sseClient{
		ID:   id,
		Role: role,
		ch:   make(chan []byte, hubClientBuffer),
		done: make(chan struct{}),
	}
	h.mu.Lock()
	h.clients[id] = c
	c.ch <- hello
	h.mu.Unlock()
	h.notifyCounts()
	return c
}

// Unregister 移除客户端（幂等），关闭它的 Done 通道并通知连接数变化。
func (h *Hub) Unregister(c *sseClient) {
	if c == nil {
		return
	}
	h.mu.Lock()
	_, exists := h.clients[c.ID]
	delete(h.clients, c.ID)
	h.mu.Unlock()
	if !exists {
		return
	}
	c.close()
	h.notifyCounts()
}

// Broadcast 向所有客户端推送一条 SSE 事件。慢客户端（缓冲满）会被断开。
func (h *Hub) Broadcast(event string, data []byte) {
	msg := encodeSSE(event, data)
	h.mu.Lock()
	dropped := 0
	for id, c := range h.clients {
		select {
		case c.ch <- msg:
		default:
			delete(h.clients, id)
			c.close()
			dropped++
		}
	}
	h.mu.Unlock()
	if dropped > 0 {
		h.notifyCounts()
	}
}

// Counts 返回在线展示端 / 编辑端数量。
func (h *Hub) Counts() (displays, editors int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.countsLocked()
}

func (h *Hub) countsLocked() (displays, editors int) {
	for _, c := range h.clients {
		if c.Role == "display" {
			displays++
		} else {
			editors++
		}
	}
	return displays, editors
}

func (h *Hub) notifyCounts() {
	h.mu.Lock()
	cb := h.onCounts
	d, e := h.countsLocked()
	h.mu.Unlock()
	if cb != nil {
		cb(d, e)
	}
}

// encodeSSE 生成 `event: xxx\ndata: {...}\n\n` 格式的单条事件。
func encodeSSE(event string, data []byte) []byte {
	if len(data) == 0 {
		data = []byte("{}")
	}
	buf := make([]byte, 0, len(event)+len(data)+16)
	buf = append(buf, "event: "...)
	buf = append(buf, event...)
	buf = append(buf, '\n')
	buf = append(buf, "data: "...)
	buf = append(buf, data...)
	buf = append(buf, '\n', '\n')
	return buf
}

// mustJSON 序列化 JSON，失败时返回空对象（调用方数据均为内部结构体）。
func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte("{}")
	}
	return b
}
