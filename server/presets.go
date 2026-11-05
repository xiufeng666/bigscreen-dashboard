package main

// 三套内置预设模板（tech / red / festive）。
// 设计原则：
//   - 统一 1920x1080 设计画布，标题区 0-176 由舞台渲染，组件从 y=200 开始；
//   - 左右边距 60，行间距 20-30，底部滚动通知条 y=970 / 高 70；
//   - 每个场景都包含 text/table/image/clock/notice 五类组件，内容为真实业务文案；
//   - 预设返回 rev=0 的草稿（由编辑器载入，保存时服务端重新分配 rev）。

const (
	presetMarginX  = 60
	presetContentW = 1800
	presetNoticeY  = 970
	presetNoticeH  = 70
)

// PresetMeta 用于 GET /api/presets 列表。
type PresetMeta struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Theme      string `json:"theme"`
	SceneCount int    `json:"sceneCount"`
}

var presetOrder = []string{ThemeTech, ThemeRed, ThemeFestive}

var presetMetas = map[string]PresetMeta{
	ThemeTech:    {ID: ThemeTech, Name: "科技风示例", Theme: ThemeTech, SceneCount: 3},
	ThemeRed:     {ID: ThemeRed, Name: "红色风格示例", Theme: ThemeRed, SceneCount: 3},
	ThemeFestive: {ID: ThemeFestive, Name: "节日喜庆示例", Theme: ThemeFestive, SceneCount: 3},
}

// PresetList 返回内置模板列表（顺序固定）。
func PresetList() []PresetMeta {
	out := make([]PresetMeta, 0, len(presetOrder))
	for _, id := range presetOrder {
		out = append(out, presetMetas[id])
	}
	return out
}

// PresetByID 返回指定模板的深拷贝草稿；rev=0、updatedAt 为零值。
func PresetByID(id string) (Dashboard, bool) {
	switch id {
	case ThemeTech:
		return presetTech(), true
	case ThemeRed:
		return presetRed(), true
	case ThemeFestive:
		return presetFestive(), true
	default:
		return Dashboard{}, false
	}
}

// DefaultPreset 首次启动 / 恢复出厂使用科技风模板。
func DefaultPreset() Dashboard { return presetTech() }

// ---------- 组件构造辅助 ----------

func presetBase(id, widgetType, title string, x, y, w, h float64) Widget {
	return Widget{
		ID:    id,
		Type:  widgetType,
		X:     x,
		Y:     y,
		W:     w,
		H:     h,
		Z:     10,
		Title: title,
		Style: Style{Border: true, Padding: 24, Radius: 10},
	}
}

func presetText(id, title string, x, y, w, h float64, content string, fontSize, lineHeight float64) Widget {
	widget := presetBase(id, WidgetText, title, x, y, w, h)
	widget.Text = &TextProps{
		Content:    content,
		FontSize:   fontSize,
		FontWeight: 400,
		Align:      "left",
		LineHeight: lineHeight,
	}
	return widget
}

func presetTable(id, title string, x, y, w, h float64, columns []string, rows [][]string, fontSize float64) Widget {
	widget := presetBase(id, WidgetTable, title, x, y, w, h)
	widget.Table = &TableProps{
		Columns:  columns,
		Rows:     rows,
		FontSize: fontSize,
		Align:    "left",
		Striped:  true,
	}
	return widget
}

func presetImage(id, title string, x, y, w, h float64, src, caption string) Widget {
	widget := presetBase(id, WidgetImage, title, x, y, w, h)
	widget.Style.Padding = 12
	widget.Image = &ImageProps{Src: src, Fit: "cover", Caption: caption}
	return widget
}

func presetClock(id, title string, x, y, w, h float64, label string, fontSize float64) Widget {
	widget := presetBase(id, WidgetClock, title, x, y, w, h)
	widget.Style.Padding = 8
	widget.Style.Glow = true
	widget.Clock = &ClockProps{
		Format:   "YYYY-MM-DD HH:mm:ss",
		ShowWeek: true,
		FontSize: fontSize,
		Align:    "center",
		Label:    label,
		Mode:     "digital",
	}
	return widget
}

// presetNotice 底部滚动通知条（固定版式）。
func presetNotice(id, content string) Widget {
	widget := presetBase(id, WidgetNotice, "", presetMarginX, presetNoticeY, presetContentW, presetNoticeH)
	widget.Z = 50
	widget.Style = Style{Border: true, Glow: true, Padding: 0, Radius: 999}
	widget.Notice = &NoticeProps{Content: content, Speed: 70, FontSize: 22, Icon: true}
	return widget
}

func presetRotation(interval int, transition string) Rotation {
	return Rotation{Auto: true, Interval: interval, Transition: transition, ShowProgress: true}
}

// ==========================================================================
// 科技风：智慧运营数据驾驶舱
// ==========================================================================

func presetTech() Dashboard {
	return Dashboard{
		Title:    "智慧运营数据驾驶舱",
		Subtitle: "SMART OPERATION COMMAND CENTER",
		Theme:    ThemeTech,
		Rotation: presetRotation(10, TransitionFade),
		Scenes: []Scene{
			{
				ID:   "tech-s1",
				Name: "运营总览",
				Widgets: []Widget{
					presetClock("tech-s1-clock", "系统时间", 60, 200, 520, 250, "当前时间", 46),
					presetText("tech-s1-kpi", "核心运营指标", 605, 200, 700, 250,
						"在线设备：12,846 台\n今日受理工单：3,278 件\n服务响应达标率：99.2%\n数据接入节点：486 个", 22, 1.6),
					presetImage("tech-s1-image", "园区实景", 1330, 200, 530, 250,
						"/assets/demo/demo-tech.svg", "智慧园区 · 实时监控画面"),
					presetTable("tech-s1-table", "重点业务运行指标", 60, 475, 1800, 465,
						[]string{"业务板块", "今日处理", "环比", "达标率"},
						[][]string{
							{"智慧安防", "1,286", "+2.4%", "99.6%"},
							{"能源管理", "968", "+1.8%", "98.9%"},
							{"环境监测", "742", "-0.6%", "99.1%"},
							{"通行调度", "1,536", "+3.2%", "97.8%"},
							{"设备运维", "428", "+0.9%", "98.4%"},
							{"数据服务", "2,318", "+5.6%", "99.3%"},
						}, 20),
					presetNotice("tech-s1-notice",
						"系统运行平稳，各业务链路正常。今日 18:00 进行例行数据备份，请提前保存编辑内容。值班电话：8001。"),
				},
			},
			{
				ID:   "tech-s2",
				Name: "业务分析",
				Widgets: []Widget{
					presetTable("tech-s2-table", "各区域业务量对比", 60, 200, 1100, 740,
						[]string{"区域", "业务量", "同比", "平均处理时长", "达标率"},
						[][]string{
							{"东区", "6,428", "+9.2%", "1.8 分钟", "99.1%"},
							{"南区", "5,376", "+7.4%", "2.1 分钟", "98.6%"},
							{"西区", "4,912", "+6.1%", "2.3 分钟", "97.9%"},
							{"北区", "4,686", "+11.8%", "1.6 分钟", "99.4%"},
							{"中心区", "3,204", "+4.5%", "2.6 分钟", "96.8%"},
							{"开发区", "2,876", "+6.9%", "2.0 分钟", "98.2%"},
							{"高新区", "2,148", "+8.3%", "1.9 分钟", "98.9%"},
							{"临港区", "1,836", "+5.2%", "2.4 分钟", "97.5%"},
						}, 20),
					presetImage("tech-s2-image", "数据中台运行视图", 1185, 200, 675, 330,
						"/assets/demo/demo-tech.svg", "数据中台 · 实时链路状态"),
					presetText("tech-s2-trend", "趋势研判", 1185, 550, 675, 250,
						"近 7 日平台累计处理业务 2.14 万件，较上周增长 8.6%。\n智慧安防与通行调度贡献主要增量，建议高峰时段增配值守力量。", 22, 1.6),
					presetClock("tech-s2-clock", "数据更新", 1185, 820, 675, 120, "", 34),
					presetNotice("tech-s2-notice",
						"本周业务分析报告已发布，可在数据驾驶舱「分析报告」栏目查看；月度复盘会定于周五 15:00 召开。"),
				},
			},
			{
				ID:   "tech-s3",
				Name: "安全与告警",
				Widgets: []Widget{
					presetImage("tech-s3-image", "安防联勤画面", 60, 200, 700, 280,
						"/assets/demo/demo-tech.svg", "联勤指挥 · 现场画面"),
					presetText("tech-s3-status", "安全运行态势", 785, 200, 1075, 280,
						"平台整体安全评分 98.6 分，连续 126 天零重大事故。\n今日告警 23 条，已处置 21 条，处置率 91.3%，剩余 2 条正在跟进。\n重点关注 3 号机房温度波动与东区门禁异常。", 24, 1.7),
					presetTable("tech-s3-table", "实时告警事件", 60, 505, 1150, 435,
						[]string{"时间", "等级", "来源", "事件描述", "状态"},
						[][]string{
							{"10:42", "重要", "能源管理", "3 号机房温度偏高", "处理中"},
							{"10:18", "一般", "智慧安防", "东区门禁连续 3 次识别失败", "已处置"},
							{"09:56", "一般", "环境监测", "南区 PM2.5 短时超标", "已处置"},
							{"09:24", "提示", "设备运维", "2 号空调滤网需更换", "待派单"},
							{"08:47", "一般", "通行调度", "地下车库道闸通信抖动", "已处置"},
						}, 20),
					presetClock("tech-s3-clock", "值班信息", 1235, 505, 625, 190, "当前值班", 40),
					presetText("tech-s3-plan", "处置要求", 1235, 720, 625, 250,
						"1. 3 号机房温度告警：运维班组已到场处理，30 分钟内反馈结果。\n2. 东区门禁异常：今日内完成设备更换并复测。\n3. 各值班岗位保持通讯畅通，重大情况 5 分钟内上报。", 20, 1.7),
					presetNotice("tech-s3-notice",
						"今日 14:00 开展消防应急演练，请各值班岗位提前做好准备，演练期间保持通讯畅通。"),
				},
			},
		},
	}
}

// ==========================================================================
// 红色风格：党建引领高质量发展指挥中心
// ==========================================================================

func presetRed() Dashboard {
	return Dashboard{
		Title:    "党建引领高质量发展指挥中心",
		Subtitle: "党建引领 · 高质量发展",
		Theme:    ThemeRed,
		Rotation: presetRotation(12, TransitionSlide),
		Scenes: []Scene{
			{
				ID:   "red-s1",
				Name: "党建总览",
				Widgets: []Widget{
					presetClock("red-s1-clock", "系统时间", 60, 200, 520, 250, "当前时间", 46),
					presetText("red-s1-kpi", "核心党建指标", 605, 200, 700, 250,
						"基层党组织：326 个\n在册党员：12,680 名\n本月主题党日：128 场\n服务群众事项：3,460 件", 22, 1.6),
					presetImage("red-s1-image", "党建阵地", 1330, 200, 530, 250,
						"/assets/demo/demo-red.svg", "党群服务中心 · 实景"),
					presetTable("red-s1-table", "重点工作推进情况", 60, 475, 1800, 465,
						[]string{"重点工作", "责任单位", "责任人", "进度", "完成时限"},
						[][]string{
							{"老旧小区改造", "住建局", "张建国", "86%", "11-30"},
							{"社区养老服务站建设", "民政局", "李慧敏", "72%", "12-15"},
							{"基层治理数字化平台", "政务服务中心", "王海涛", "94%", "11-20"},
							{"文明城区创建", "宣传部", "赵文博", "68%", "12-31"},
							{"困难群众帮扶", "民政局", "陈晓芸", "91%", "11-25"},
						}, 20),
					presetNotice("red-s1-notice",
						"党建引领聚合力，服务群众零距离。今日 16:00 召开重点工作调度会，请各责任单位准时参会。"),
				},
			},
			{
				ID:   "red-s2",
				Name: "重点工作",
				Widgets: []Widget{
					presetTable("red-s2-table", "民生实事项目清单", 60, 200, 1100, 740,
						[]string{"项目名称", "牵头单位", "当前进度", "预计完成", "群众评价"},
						[][]string{
							{"社区食堂扩容", "民政局", "88%", "11-20", "满意"},
							{"老旧小区加装电梯", "住建局", "76%", "12-10", "满意"},
							{"便民服务圈建设", "政务服务中心", "93%", "11-15", "满意"},
							{"农村饮水提质工程", "水务局", "81%", "12-20", "基本满意"},
							{"就业帮扶专项行动", "人社局", "69%", "12-31", "满意"},
							{"社区养老服务站", "民政局", "72%", "12-15", "满意"},
							{"背街小巷提升", "城管局", "84%", "11-28", "满意"},
							{"15 分钟健身圈", "体育局", "77%", "12-05", "基本满意"},
						}, 20),
					presetImage("red-s2-image", "项目现场", 1185, 200, 675, 330,
						"/assets/demo/demo-red.svg", "老旧小区改造 · 现场巡查"),
					presetText("red-s2-trend", "推进情况研判", 1185, 550, 675, 250,
						"年度 12 项重点任务已完成 9 项，整体进度 82.4%，超序时进度 4.2 个百分点。\n下一步聚焦民生实事项目，确保年底前兑现全部承诺事项。", 22, 1.6),
					presetClock("red-s2-clock", "数据更新", 1185, 820, 675, 120, "", 34),
					presetNotice("red-s2-notice",
						"请各单位于每周五 17:00 前上报重点任务进度，确保数据真实准确、更新及时。"),
				},
			},
			{
				ID:   "red-s3",
				Name: "民生服务",
				Widgets: []Widget{
					presetImage("red-s3-image", "服务现场", 60, 200, 700, 280,
						"/assets/demo/demo-red.svg", "党群服务中心 · 便民服务窗口"),
					presetText("red-s3-status", "民生服务成效", 785, 200, 1075, 280,
						"本月累计办理群众诉求 3,460 件，办结率 98.7%，群众满意度 96.4%。\n“一网通办”事项覆盖率 92.8%，平均办理时长压缩至 1.6 个工作日。\n志愿服务队伍开展活动 286 场，参与群众 1.2 万人次。", 24, 1.7),
					presetTable("red-s3-table", "群众诉求办理情况", 60, 505, 1150, 435,
						[]string{"诉求类型", "受理量", "办结量", "满意度"},
						[][]string{
							{"政策咨询", "1,286", "1,268", "97.2%"},
							{"生活服务", "842", "826", "96.8%"},
							{"环境治理", "536", "518", "95.4%"},
							{"交通出行", "428", "412", "94.9%"},
							{"社会保障", "368", "356", "97.6%"},
						}, 20),
					presetClock("red-s3-clock", "值班信息", 1235, 505, 625, 190, "当前值班", 40),
					presetText("red-s3-plan", "服务承诺", 1235, 720, 625, 220,
						"民有所呼、我有所应，件件有回音、事事有着落。\n一般诉求 3 个工作日内办结，紧急诉求 24 小时内响应。\n12345 热线 7×24 小时受理群众诉求，欢迎监督反馈。", 20, 1.7),
					presetNotice("red-s3-notice",
						"民有所呼、我有所应。12345 热线 7×24 小时受理群众诉求，欢迎监督反馈。"),
				},
			},
		},
	}
}

// ==========================================================================
// 节日喜庆：新春文旅嘉年华指挥中心
// ==========================================================================

func presetFestive() Dashboard {
	return Dashboard{
		Title:    "喜迎新春 · 文旅嘉年华",
		Subtitle: "HAPPY CHINESE NEW YEAR",
		Theme:    ThemeFestive,
		Rotation: presetRotation(8, TransitionFade),
		Scenes: []Scene{
			{
				ID:   "festive-s1",
				Name: "节日总览",
				Widgets: []Widget{
					presetClock("festive-s1-clock", "节日时刻", 60, 200, 520, 250, "当前时间", 46),
					presetText("festive-s1-kpi", "新春活动总览", 605, 200, 700, 250,
						"全市文旅活动：128 场\n重点景区预约：36.8 万人次\n商圈客流：128.6 万人次\n节日消费总额：9.86 亿元", 22, 1.6),
					presetImage("festive-s1-image", "节日盛景", 1330, 200, 530, 250,
						"/assets/demo/demo-festive.svg", "新春灯会 · 现场画面"),
					presetTable("festive-s1-table", "重点活动人气榜", 60, 475, 1800, 465,
						[]string{"活动名称", "举办地点", "今日客流", "预约率"},
						[][]string{
							{"新春灯会", "中心广场", "3.8 万人次", "96%"},
							{"民俗庙会", "老城街区", "2.6 万人次", "92%"},
							{"非遗市集", "文化中心", "1.9 万人次", "88%"},
							{"冰雪嘉年华", "滨江公园", "1.5 万人次", "85%"},
							{"国潮演出", "大剧院", "0.9 万人次", "98%"},
						}, 20),
					presetNotice("festive-s1-notice",
						"新春快乐！节日期间景区实行预约限流，请合理安排出行时间，注意保暖与出行安全。"),
				},
			},
			{
				ID:   "festive-s2",
				Name: "活动安排",
				Widgets: []Widget{
					presetTable("festive-s2-table", "新春活动排期", 60, 200, 1100, 740,
						[]string{"时间", "活动名称", "地点", "预计参与", "保障等级"},
						[][]string{
							{"10:00", "民俗巡游", "中心广场", "1.2 万人次", "一级"},
							{"11:30", "非遗手作体验", "文化中心", "0.6 万人次", "二级"},
							{"14:00", "国潮专场演出", "大剧院", "0.9 万人次", "一级"},
							{"15:30", "亲子花灯制作", "图书馆广场", "0.5 万人次", "二级"},
							{"17:00", "美食年货市集", "老城街区", "1.8 万人次", "一级"},
							{"19:00", "新春灯会亮灯仪式", "中心广场", "3.5 万人次", "特级"},
							{"20:30", "烟花秀", "滨江公园", "2.8 万人次", "特级"},
							{"21:30", "元宵灯谜会", "文化中心", "0.7 万人次", "二级"},
						}, 20),
					presetImage("festive-s2-image", "灯会现场", 1185, 200, 675, 330,
						"/assets/demo/demo-festive.svg", "新春灯会 · 璀璨夜景"),
					presetText("festive-s2-tip", "观演提示", 1185, 550, 675, 250,
						"灯会亮灯仪式将于 19:00 举行，建议提前 30 分钟入场。\n中心广场周边 17:00-22:00 实施交通管制，请优先选择公共交通。\n现场设置 6 处志愿服务点，提供热水、急救与引导服务。", 22, 1.6),
					presetClock("festive-s2-clock", "活动时间", 1185, 820, 675, 120, "", 34),
					presetNotice("festive-s2-notice",
						"灯会亮灯仪式将于 19:00 准时开始，请提前 30 分钟到达指定观赏区，服从现场引导。"),
				},
			},
			{
				ID:   "festive-s3",
				Name: "客流与服务",
				Widgets: []Widget{
					presetImage("festive-s3-image", "服务驿站", 60, 200, 700, 280,
						"/assets/demo/demo-festive.svg", "游客服务中心 · 现场"),
					presetText("festive-s3-status", "客流与服务概览", 785, 200, 1075, 280,
						"今日全市重点景区接待游客 36.8 万人次，同比增长 42.6%。\n景区最大承载量 52 万人次，实时舒适度指数 82，处于舒适区间。\n游客服务中心受理咨询 3,268 件，办结率 99.6%。", 24, 1.7),
					presetTable("festive-s3-table", "重点景区实时客流", 60, 505, 1150, 435,
						[]string{"景区", "在园人数", "最大承载量", "舒适度"},
						[][]string{
							{"中心广场灯会", "38,600", "60,000", "舒适"},
							{"老城街区庙会", "26,200", "45,000", "较舒适"},
							{"滨江公园灯展", "18,900", "40,000", "舒适"},
							{"文化中心市集", "12,600", "20,000", "舒适"},
							{"冰雪嘉年华", "9,800", "15,000", "较舒适"},
						}, 20),
					presetClock("festive-s3-clock", "实时客流", 1235, 505, 625, 190, "数据更新时间", 40),
					presetText("festive-s3-tip", "温馨提示", 1235, 720, 625, 220,
						"1. 夜间气温较低，请游客注意保暖，照顾好老人和儿童。\n2. 文明观灯，不拥挤、不攀爬，服从现场工作人员引导。\n3. 如需帮助请拨打服务热线 12345 或联系就近志愿者。", 20, 1.7),
					presetNotice("festive-s3-notice",
						"游客服务中心提供热水、急救、母婴等便民服务，咨询热线：12345。"),
				},
			},
		},
	}
}
