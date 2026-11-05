package main

import (
	"crypto/rand"
	"encoding/hex"
	"strings"
	"time"
	"unicode/utf8"
)

// ---------- 主题 / 组件类型枚举 ----------

const (
	ThemeTech    = "tech"
	ThemeRed     = "red"
	ThemeFestive = "festive"

	WidgetText   = "text"
	WidgetTable  = "table"
	WidgetImage  = "image"
	WidgetClock  = "clock"
	WidgetNotice = "notice"

	TransitionFade  = "fade"
	TransitionSlide = "slide"
	TransitionZoom  = "zoom"
	TransitionNone  = "none"
)

// 设计画布默认尺寸（16:9）；支持任意宽高比，见 Dashboard.Canvas。
const (
	DefaultCanvasWidth  = 1920
	DefaultCanvasHeight = 1080
	MinCanvasWidth      = 640
	MaxCanvasWidth      = 7680
	MinCanvasHeight     = 360
	MaxCanvasHeight     = 4320
)

// Canvas 是设计画布尺寸（逻辑像素）。展示端按屏幕等比缩放；编辑器按此坐标系排版。
// 非 16:9 的大屏（如 4:3 / 3:2 / 16:10 / 21:9 / 竖屏）通过调整 Width/Height 适配。
type Canvas struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

// Dashboard 是线上唯一的看板配置，序列化到 <data>/dashboard.json。
type Dashboard struct {
	Rev       int64     `json:"rev"`
	Canvas    Canvas    `json:"canvas"`
	Title     string    `json:"title"`
	Subtitle  string    `json:"subtitle,omitempty"`
	Theme     string    `json:"theme"`
	Rotation  Rotation  `json:"rotation"`
	Scenes    []Scene   `json:"scenes"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type Rotation struct {
	Auto         bool   `json:"auto"`
	Interval     int    `json:"interval"`     // 默认场景停留秒数 3..600
	Transition   string `json:"transition"`   // fade | slide | zoom | none
	ShowProgress bool   `json:"showProgress"` // 底部进度条
}

type Scene struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Duration   int      `json:"duration"` // 0 = 使用 Rotation.Interval
	Background string   `json:"background,omitempty"`
	Widgets    []Widget `json:"widgets"`
}

type Widget struct {
	ID     string       `json:"id"`
	Type   string       `json:"type"`
	X      float64      `json:"x"`
	Y      float64      `json:"y"`
	W      float64      `json:"w"`
	H      float64      `json:"h"`
	Z      int          `json:"z"`
	Title  string       `json:"title,omitempty"`
	Style  Style        `json:"style"`
	Text   *TextProps   `json:"text,omitempty"`
	Table  *TableProps  `json:"table,omitempty"`
	Image  *ImageProps  `json:"image,omitempty"`
	Clock  *ClockProps  `json:"clock,omitempty"`
	Notice *NoticeProps `json:"notice,omitempty"`
}

type Style struct {
	BG      string `json:"bg,omitempty"`    // CSS 背景，空=主题默认
	Color   string `json:"color,omitempty"` // 覆盖正文颜色
	Border  bool   `json:"border"`          // 主题描边
	Glow    bool   `json:"glow"`            // 辉光
	Padding int    `json:"padding"`         // 内容内边距 px
	Radius  int    `json:"radius"`          // 圆角 px
}

type TextProps struct {
	Content       string  `json:"content"`
	FontSize      float64 `json:"fontSize"`
	FontWeight    int     `json:"fontWeight"`
	Align         string  `json:"align"`
	LineHeight    float64 `json:"lineHeight"`
	LetterSpacing float64 `json:"letterSpacing"`
	Color         string  `json:"color,omitempty"`
}

type TableProps struct {
	Columns  []string   `json:"columns"`
	Rows     [][]string `json:"rows"`
	FontSize float64    `json:"fontSize"`
	Align    string     `json:"align"`
	HeaderBg string     `json:"headerBg,omitempty"`
	Striped  bool       `json:"striped"`
}

type ImageProps struct {
	Src     string `json:"src"`
	Fit     string `json:"fit"` // cover | contain | fill | scale-down
	Caption string `json:"caption,omitempty"`
}

type ClockProps struct {
	Format   string  `json:"format"` // YYYY-MM-DD HH:mm:ss 中的占位符组合
	ShowWeek bool    `json:"showWeek"`
	FontSize float64 `json:"fontSize"`
	Color    string  `json:"color,omitempty"`
	Align    string  `json:"align"`
	Label    string  `json:"label,omitempty"`
	Mode     string  `json:"mode,omitempty"` // digital
}

type NoticeProps struct {
	Content  string  `json:"content"`
	Speed    int     `json:"speed"` // px/s 20..400
	FontSize float64 `json:"fontSize"`
	Icon     bool    `json:"icon"`
}

// Runtime 是服务端持有的运行态（不落盘）。
type Runtime struct {
	Playing        bool  `json:"playing"`
	Scene          int   `json:"scene"`
	Duration       int   `json:"duration"`
	SceneStartedAt int64 `json:"sceneStartedAt"` // unix ms
	Displays       int   `json:"displays"`
	Editors        int   `json:"editors"`
	UpdatedAt      int64 `json:"updatedAt"`
}

// SceneDuration 返回场景实际停留秒数。
func (d *Dashboard) SceneDuration(s Scene) int {
	if s.Duration >= 3 {
		return s.Duration
	}
	if d.Rotation.Interval >= 3 {
		return d.Rotation.Interval
	}
	return 10
}

// ---------- 归一化 / 校验 ----------

// Normalize 将客户端提交的配置约束到安全范围。返回错误仅用于结构性不可恢复问题；
// 绝大多数非法值会被静默钳制/修正，保证编辑器一次保存不会失败。
func (d *Dashboard) Normalize() error {
	d.Rev = 0 // rev 只能由服务端分配
	d.normalizeCanvas()
	d.Title = truncRunes(strings.TrimSpace(d.Title), 120)
	d.Subtitle = truncRunes(strings.TrimSpace(d.Subtitle), 200)
	if !validTheme(d.Theme) {
		d.Theme = ThemeTech
	}
	if d.Rotation.Interval < 3 || d.Rotation.Interval > 600 {
		if d.Rotation.Interval == 0 {
			d.Rotation.Interval = 10
		} else if d.Rotation.Interval < 3 {
			d.Rotation.Interval = 3
		} else {
			d.Rotation.Interval = 600
		}
	}
	if !validTransition(d.Rotation.Transition) {
		d.Rotation.Transition = TransitionFade
	}
	if len(d.Scenes) == 0 {
		d.Scenes = []Scene{{ID: newID("scene"), Name: "场景 1"}}
	}
	if len(d.Scenes) > 50 {
		d.Scenes = d.Scenes[:50]
	}
	sceneIDs := make(map[string]bool, len(d.Scenes))
	for i := range d.Scenes {
		s := &d.Scenes[i]
		s.ID = strings.TrimSpace(s.ID)
		if s.ID == "" || sceneIDs[s.ID] {
			s.ID = newID("scene")
		}
		sceneIDs[s.ID] = true
		s.Name = truncRunes(strings.TrimSpace(s.Name), 60)
		if s.Name == "" {
			s.Name = "场景 " + itoa(i+1)
		}
		if s.Duration != 0 {
			if s.Duration < 3 {
				s.Duration = 3
			} else if s.Duration > 3600 {
				s.Duration = 3600
			}
		}
		s.Background = sanitizeImageSrc(strings.TrimSpace(s.Background))
		if len(s.Widgets) > 200 {
			s.Widgets = s.Widgets[:200]
		}
		seen := make(map[string]bool, len(s.Widgets))
		for j := range s.Widgets {
			w := &s.Widgets[j]
			if !validWidgetType(w.Type) {
				w.Type = WidgetText
			}
			w.ID = strings.TrimSpace(w.ID)
			if w.ID == "" || seen[w.ID] {
				w.ID = newID(w.Type)
			}
			seen[w.ID] = true
			w.Title = truncRunes(strings.TrimSpace(w.Title), 80)
			normalizeWidget(w, d.Canvas.Width, d.Canvas.Height)
		}
	}
	return nil
}

// normalizeCanvas 归一化画布尺寸；缺省（老版本数据/模板）回退 1920x1080。
func (d *Dashboard) normalizeCanvas() {
	if d.Canvas.Width <= 0 {
		d.Canvas.Width = DefaultCanvasWidth
	}
	if d.Canvas.Height <= 0 {
		d.Canvas.Height = DefaultCanvasHeight
	}
	d.Canvas.Width = clampInt(d.Canvas.Width, MinCanvasWidth, MaxCanvasWidth)
	d.Canvas.Height = clampInt(d.Canvas.Height, MinCanvasHeight, MaxCanvasHeight)
}

// CanvasSize 返回画布尺寸（对未归一化数据也安全）。
func (d *Dashboard) CanvasSize() (int, int) {
	w, h := d.Canvas.Width, d.Canvas.Height
	if w <= 0 {
		w = DefaultCanvasWidth
	}
	if h <= 0 {
		h = DefaultCanvasHeight
	}
	return clampInt(w, MinCanvasWidth, MaxCanvasWidth), clampInt(h, MinCanvasHeight, MaxCanvasHeight)
}

func normalizeWidget(w *Widget, canvasW, canvasH int) {
	// 坐标钳制到当前设计画布内
	maxX := float64(canvasW - 80)
	maxY := float64(canvasH - 40)
	w.X = clampFloat(round2(w.X), 0, maxX)
	w.Y = clampFloat(round2(w.Y), 0, maxY)
	w.W = clampFloat(round2(w.W), 80, float64(canvasW)-w.X)
	w.H = clampFloat(round2(w.H), 40, float64(canvasH)-w.Y)
	if w.Z < 0 {
		w.Z = 0
	}
	if w.Z > 9999 {
		w.Z = 9999
	}
	w.Style.Padding = clampInt(w.Style.Padding, 0, 200)
	w.Style.Radius = clampInt(w.Style.Radius, 0, 200)
	w.Style.BG = truncRunes(strings.TrimSpace(w.Style.BG), 400)
	w.Style.Color = truncRunes(strings.TrimSpace(w.Style.Color), 120)

	switch w.Type {
	case WidgetText:
		if w.Text == nil {
			w.Text = &TextProps{}
		}
		t := w.Text
		t.Content = truncRunes(t.Content, 20000)
		if t.FontSize == 0 {
			t.FontSize = 26
		}
		t.FontSize = clampFloat(t.FontSize, 8, 200)
		t.FontWeight = normalizeFontWeight(t.FontWeight)
		t.Align = normalizeAlign(t.Align)
		if t.LineHeight == 0 {
			t.LineHeight = 1.5
		}
		t.LineHeight = clampFloat(t.LineHeight, 0.8, 4)
		t.LetterSpacing = clampFloat(t.LetterSpacing, -5, 50)
		t.Color = truncRunes(strings.TrimSpace(t.Color), 120)
	case WidgetTable:
		if w.Table == nil {
			w.Table = &TableProps{}
		}
		normalizeTable(w.Table)
	case WidgetImage:
		if w.Image == nil {
			w.Image = &ImageProps{}
		}
		im := w.Image
		im.Src = sanitizeImageSrc(strings.TrimSpace(im.Src))
		switch im.Fit {
		case "cover", "contain", "fill", "scale-down":
		default:
			im.Fit = "cover"
		}
		im.Caption = truncRunes(strings.TrimSpace(im.Caption), 200)
	case WidgetClock:
		if w.Clock == nil {
			w.Clock = &ClockProps{}
		}
		c := w.Clock
		if strings.TrimSpace(c.Format) == "" {
			c.Format = "YYYY-MM-DD HH:mm:ss"
		}
		c.Format = truncRunes(c.Format, 80)
		if c.FontSize == 0 {
			c.FontSize = 44
		}
		c.FontSize = clampFloat(c.FontSize, 12, 240)
		c.Align = normalizeAlign(c.Align)
		c.Label = truncRunes(strings.TrimSpace(c.Label), 40)
		c.Color = truncRunes(strings.TrimSpace(c.Color), 120)
		c.Mode = "digital"
	case WidgetNotice:
		if w.Notice == nil {
			w.Notice = &NoticeProps{}
		}
		n := w.Notice
		n.Content = truncRunes(n.Content, 5000)
		if n.Speed == 0 {
			n.Speed = 80
		}
		n.Speed = clampInt(n.Speed, 20, 400)
		if n.FontSize == 0 {
			n.FontSize = 22
		}
		n.FontSize = clampFloat(n.FontSize, 10, 80)
	}
}

func normalizeTable(t *TableProps) {
	if len(t.Columns) == 0 {
		t.Columns = []string{"列 1"}
	}
	if len(t.Columns) > 20 {
		t.Columns = t.Columns[:20]
	}
	for i := range t.Columns {
		t.Columns[i] = truncRunes(strings.TrimSpace(t.Columns[i]), 40)
		if t.Columns[i] == "" {
			t.Columns[i] = "列 " + itoa(i+1)
		}
	}
	if len(t.Rows) > 500 {
		t.Rows = t.Rows[:500]
	}
	cols := len(t.Columns)
	for i := range t.Rows {
		row := t.Rows[i]
		if len(row) > cols {
			row = row[:cols]
		}
		for len(row) < cols {
			row = append(row, "")
		}
		for j := range row {
			row[j] = truncRunes(strings.TrimSpace(row[j]), 500)
		}
		t.Rows[i] = row
	}
	if t.FontSize == 0 {
		t.FontSize = 20
	}
	t.FontSize = clampFloat(t.FontSize, 10, 80)
	t.Align = normalizeAlign(t.Align)
	t.HeaderBg = truncRunes(strings.TrimSpace(t.HeaderBg), 120)
}

// sanitizeImageSrc 只允许本站上传资源与内网/局域网 http(s) 图片地址。
func sanitizeImageSrc(src string) string {
	if src == "" {
		return ""
	}
	lower := strings.ToLower(src)
	switch {
	case (strings.HasPrefix(src, "/uploads/") || strings.HasPrefix(src, "/assets/")) && !strings.Contains(src, ".."):
		return truncRunes(src, 500)
	case strings.HasPrefix(lower, "http://"), strings.HasPrefix(lower, "https://"):
		if strings.ContainsAny(src, " \t\r\n\"'<>") {
			return ""
		}
		return truncRunes(src, 500)
	default:
		return ""
	}
}

// ---------- 工具 ----------

func newID(prefix string) string {
	b := make([]byte, 5)
	if _, err := rand.Read(b); err != nil {
		return prefix + "-" + itoa(int(time.Now().UnixNano()%1000000))
	}
	return prefix + "-" + hex.EncodeToString(b)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func truncRunes(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	r := []rune(s)
	return string(r[:max])
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func clampFloat(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func round2(v float64) float64 {
	return float64(int64(v*100+0.5)) / 100
}

func normalizeAlign(a string) string {
	switch a {
	case "left", "center", "right", "justify":
		return a
	default:
		return "left"
	}
}

func normalizeFontWeight(w int) int {
	switch {
	case w <= 0:
		return 400
	case w < 300:
		return 300
	case w > 900:
		return 900
	default:
		return (w / 100) * 100
	}
}

func validTheme(t string) bool { return t == ThemeTech || t == ThemeRed || t == ThemeFestive }

func validTransition(t string) bool {
	return t == TransitionFade || t == TransitionSlide || t == TransitionZoom || t == TransitionNone
}

func validWidgetType(t string) bool {
	switch t {
	case WidgetText, WidgetTable, WidgetImage, WidgetClock, WidgetNotice:
		return true
	}
	return false
}
