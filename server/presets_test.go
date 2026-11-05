package main

import "testing"

// ---------- 内置模板验收：每套 3 场景、5 类组件、排版不重叠不越界 ----------

var allWidgetTypes = []string{WidgetText, WidgetTable, WidgetImage, WidgetClock, WidgetNotice}

func TestPresetList(t *testing.T) {
	list := PresetList()
	if len(list) != 3 {
		t.Fatalf("内置模板应为 3 套，got %d", len(list))
	}
	wantIDs := []string{ThemeTech, ThemeRed, ThemeFestive}
	for i, meta := range list {
		if meta.ID != wantIDs[i] {
			t.Fatalf("模板顺序错误: 期望 %s, got %s", wantIDs[i], meta.ID)
		}
		if meta.Name == "" || meta.Theme == "" || meta.SceneCount != 3 {
			t.Fatalf("模板元数据不完整: %+v", meta)
		}
	}
}

func TestPresetByID(t *testing.T) {
	for _, id := range []string{ThemeTech, ThemeRed, ThemeFestive} {
		cfg, ok := PresetByID(id)
		if !ok {
			t.Fatalf("模板 %s 不存在", id)
		}
		if cfg.Theme != id {
			t.Fatalf("模板 %s 主题错误: %s", id, cfg.Theme)
		}
	}
	if _, ok := PresetByID("unknown"); ok {
		t.Fatal("未知模板应返回 false")
	}
}

// TestPresetContentQuality 校验三套模板的版面与内容质量。
func TestPresetContentQuality(t *testing.T) {
	for _, meta := range PresetList() {
		meta := meta
		t.Run(meta.ID, func(t *testing.T) {
			cfg, ok := PresetByID(meta.ID)
			if !ok {
				t.Fatalf("模板 %s 不存在", meta.ID)
			}
			if cfg.Rev != 0 {
				t.Fatalf("模板草稿 rev 必须为 0, got %d", cfg.Rev)
			}
			if cfg.Title == "" || cfg.Subtitle == "" {
				t.Fatalf("模板标题/副标题不能为空")
			}
			if cfg.Rotation.Interval < 3 || cfg.Rotation.Interval > 600 {
				t.Fatalf("rotation.interval 越界: %d", cfg.Rotation.Interval)
			}
			if err := cfg.Normalize(); err != nil {
				t.Fatalf("Normalize 失败: %v", err)
			}
			if len(cfg.Scenes) != 3 {
				t.Fatalf("模板应包含 3 个场景, got %d", len(cfg.Scenes))
			}

			sceneIDs := make(map[string]bool)
			widgetIDs := make(map[string]bool)
			globalTypes := make(map[string]bool)
			for _, scene := range cfg.Scenes {
				if scene.ID == "" || sceneIDs[scene.ID] {
					t.Fatalf("场景 ID 为空或重复: %q", scene.ID)
				}
				sceneIDs[scene.ID] = true
				if scene.Name == "" {
					t.Fatalf("场景 %s 缺少名称", scene.ID)
				}
				if len(scene.Widgets) < 5 {
					t.Fatalf("场景 %s 组件过少: %d", scene.ID, len(scene.Widgets))
				}
				sceneTypes := make(map[string]bool)
				for _, w := range scene.Widgets {
					sceneTypes[w.Type] = true
					globalTypes[w.Type] = true
					if w.ID == "" || widgetIDs[w.ID] {
						t.Fatalf("组件 ID 为空或重复: %q", w.ID)
					}
					widgetIDs[w.ID] = true
					// 滚动通知条以内容为主，不强制标题；其它面板组件需有标题
					if w.Title == "" && w.Type != WidgetNotice {
						t.Errorf("场景 %s 组件 %s(%s) 缺少标题", scene.ID, w.ID, w.Type)
					}
					checkWidgetBounds(t, scene.ID, w)
					if w.Y < 200 {
						t.Errorf("组件 %s 侵入顶部标题区: y=%v", w.ID, w.Y)
					}
					if w.X < presetMarginX-0.001 || w.X+w.W > 1920-presetMarginX+0.001 {
						t.Errorf("组件 %s 未保持左右边距 60: x=%v w=%v", w.ID, w.X, w.W)
					}
					if w.Type == WidgetImage {
						want := "/assets/demo/demo-" + meta.Theme + ".svg"
						if w.Image == nil || w.Image.Src != want {
							t.Errorf("组件 %s 图片素材应为 %s, got %+v", w.ID, want, w.Image)
						}
					}
					if w.Type == WidgetNotice {
						if w.Y != presetNoticeY || w.H != presetNoticeH || w.X != presetMarginX || w.W != presetContentW {
							t.Errorf("滚动通知条版式不符合约定: x=%v y=%v w=%v h=%v", w.X, w.Y, w.W, w.H)
						}
						if w.Notice == nil || w.Notice.Content == "" {
							t.Errorf("滚动通知内容为空")
						}
					}
				}
				// 同一场景内组件不得重叠
				for i := 0; i < len(scene.Widgets); i++ {
					for j := i + 1; j < len(scene.Widgets); j++ {
						if widgetsOverlap(scene.Widgets[i], scene.Widgets[j]) {
							t.Errorf("场景 %s 组件重叠: %s 与 %s",
								scene.ID, scene.Widgets[i].ID, scene.Widgets[j].ID)
						}
					}
				}
				// 每个场景都必须包含全部 5 种组件类型
				for _, typ := range allWidgetTypes {
					if !sceneTypes[typ] {
						t.Errorf("场景 %s 缺少组件类型 %s", scene.ID, typ)
					}
				}
			}
			for _, typ := range allWidgetTypes {
				if !globalTypes[typ] {
					t.Errorf("模板 %s 缺少组件类型 %s", meta.ID, typ)
				}
			}
		})
	}
}

// TestPresetIsolation 校验每次调用返回独立副本，避免运行时污染内置模板。
func TestPresetIsolation(t *testing.T) {
	first, _ := PresetByID(ThemeTech)
	if len(first.Scenes) == 0 || len(first.Scenes[0].Widgets) == 0 {
		t.Fatal("模板内容为空")
	}
	first.Scenes[0].Widgets[0].Title = "被修改"
	second, _ := PresetByID(ThemeTech)
	if second.Scenes[0].Widgets[0].Title == "被修改" {
		t.Fatal("PresetByID 返回了共享引用")
	}
}

func checkWidgetBounds(t *testing.T, sceneID string, w Widget) {
	t.Helper()
	if w.X < 0 || w.Y < 0 {
		t.Errorf("场景 %s 组件 %s 坐标为负: %v,%v", sceneID, w.ID, w.X, w.Y)
	}
	if w.W < 80 || w.H < 40 {
		t.Errorf("场景 %s 组件 %s 尺寸过小: %vx%v", sceneID, w.ID, w.W, w.H)
	}
	if w.X+w.W > 1920 {
		t.Errorf("场景 %s 组件 %s 超出右边界: x+w=%v", sceneID, w.ID, w.X+w.W)
	}
	if w.Y+w.H > 1080 {
		t.Errorf("场景 %s 组件 %s 超出下边界: y+h=%v", sceneID, w.ID, w.Y+w.H)
	}
}

func widgetsOverlap(a, b Widget) bool {
	return a.X < b.X+b.W && b.X < a.X+a.W && a.Y < b.Y+b.H && b.Y < a.Y+a.H
}
