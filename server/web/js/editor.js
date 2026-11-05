/* ==========================================================================
 * BigScreen 编辑器端（editor-dev 维护）
 * 依赖：js/util.js（BS 公共工具）、js/widgets.js（组件渲染）
 *
 * 结构：
 *   1. 常量与全局状态
 *   2. DOM / 图标 / 数据工具
 *   3. 舞台初始化与渲染
 *   4. 属性面板
 *   5. 画布交互（选择/拖动/缩放/快捷键/历史）
 *   6. 保存发布 / 冲突 / 鉴权
 *   7. SSE 实时同步与远程控制
 *   8. 场景 / 组件 / 模板 / 上传图库
 *   9. 弹窗组件与启动流程
 *
 * 约束：用户数据一律通过 textContent / value 写入，不拼接 innerHTML；
 *      唯一使用 innerHTML 的地方是静态 SVG 图标。
 * ========================================================================== */
(function () {
  'use strict';

  var BS = window.BS;
  if (!BS) { return; }

  /* ======================================================================
   * 1. 常量与全局状态
   * ==================================================================== */

  var CANVAS_W = BS.DESIGN_W;   // 1920
  var CANVAS_H = BS.DESIGN_H;   // 1080
  var GRID = 10;                // 吸附网格 10px
  var MIN_W = 80;
  var MIN_H = 40;
  var HISTORY_LIMIT = 100;      // 撤销栈上限（要求 ≥50 步）

  var THEMES = {
    tech:    { label: '科技风',   color: '#35e0ff', desc: '深空蓝黑 + 青蓝霓虹，冷色未来感' },
    red:     { label: '红色风格', color: '#ffcf5c', desc: '庄重政务红 + 鎏金描边，大气稳重' },
    festive: { label: '节日喜庆', color: '#ff7b5c', desc: '中国红 + 鎏金，灯笼烟花喜庆氛围' }
  };

  var TRANSITIONS = {
    fade: '淡化切换', slide: '滑动切换', zoom: '缩放切换', none: '无过渡'
  };

  var FONT_WEIGHTS = [
    { value: 300, label: '300 细' },
    { value: 400, label: '400 常规' },
    { value: 500, label: '500 中等' },
    { value: 600, label: '600 半粗' },
    { value: 700, label: '700 粗体' },
    { value: 800, label: '800 特粗' },
    { value: 900, label: '900 黑体' }
  ];

  var state = {
    config: null,          // 本地编辑中的 Dashboard 数据
    rev: 0,                // 客户端读到的服务端版本号
    sceneIndex: 0,         // 当前编辑场景索引
    selectedId: '',        // 当前选中组件 id
    dirty: false,          // 是否有未发布的本地修改
    savedHash: '',         // 最近一次保存/载入时的配置指纹
    runtime: { playing: false, scene: 0, duration: 10, displays: 0, editors: 1, sceneStartedAt: 0 },
    authRequired: false,   // 服务端是否启用密码
    authenticated: true,   // 当前是否已登录（无密码时为 true）
    connected: false,      // SSE 是否在线
    presets: [],           // 内置模板列表
    uploading: false,
    saving: false,
    booted: false
  };

  var undoStack = [];
  var redoStack = [];
  var lastUndoKey = '';
  var lastUndoAt = 0;
  var clipboard = null;    // 组件剪贴板
  var uploadTarget = null; // 'image' | 'background' 待上传目标
  var loginRetry = null;   // 登录成功后的重试回调

  var dom = {};            // 静态 DOM 引用
  var stage = null;        // .stage 画布元素
  var activeLayer = null;  // 当前渲染的场景层
  var stageFit = null;     // BS.fitStage 返回值
  var drag = null;         // 当前画布交互（拖动/缩放）
  var sse = null;

  /* ======================================================================
   * 2. DOM / 图标 / 数据工具
   * ==================================================================== */

  /** 轻量 DOM 构造器：props 支持 class/text/html/dataset/style 与 on* 事件 */
  function h(tag, props, children) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        var val = props[key];
        if (val === undefined || val === null || val === false) { return; }
        if (key === 'class') { el.className = val; }
        else if (key === 'text') { el.textContent = String(val); }
        else if (key === 'html') { el.innerHTML = val; } /* 仅静态图标 */
        else if (key === 'dataset') { Object.keys(val).forEach(function (k) { el.dataset[k] = String(val[k]); }); }
        else if (key === 'style' && typeof val === 'object') { Object.assign(el.style, val); }
        else if (key.indexOf('on') === 0 && typeof val === 'function') { el.addEventListener(key.slice(2).toLowerCase(), val); }
        else if (key === 'value') { el.value = val; }
        else if (key === 'checked') { el.checked = !!val; }
        else if (key === 'disabled') { el.disabled = !!val; }
        else if (val === true) { el.setAttribute(key, ''); }
        else { el.setAttribute(key, String(val)); }
      });
    }
    appendChildren(el, children);
    return el;
  }

  function appendChildren(el, children) {
    if (children === undefined || children === null) { return; }
    if (!Array.isArray(children)) { children = [children]; }
    children.forEach(function (child) {
      if (child === undefined || child === null || child === false) { return; }
      el.appendChild(typeof child === 'string' || typeof child === 'number'
        ? document.createTextNode(String(child))
        : child);
    });
  }

  function clearEl(el) {
    while (el.firstChild) { el.removeChild(el.firstChild); }
  }

  function n(v) { /* 数字显示：最多两位小数，去掉多余的 0 */
    var num = Number(v);
    if (!isFinite(num)) { return '0'; }
    num = Math.round(num * 100) / 100;
    return String(num);
  }

  function clampNum(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  var ICONS = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/>',
    up: '<path d="m6 15 6-6 6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h9a7 7 0 0 1 0 14h-2"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9h-9a7 7 0 0 0 0 14h2"/>',
    play: '<path d="M8 5v14l11-7z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    prev: '<path d="M19 20 9 12l10-8z"/><path d="M5 19V5"/>',
    next: '<path d="m5 4 10 8-10 8z"/><path d="M19 5v14"/>',
    reload: '<path d="M20 11a8 8 0 1 0-2.3 6.3"/><path d="M20 4v7h-7"/>',
    bell: '<path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 19a2 2 0 0 0 4 0"/>',
    save: '<path d="M5 3h11l3 3v15H5z"/><path d="M9 3v6h6V3M8 14h8v7H8z"/>',
    eye: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="2.6"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="m5 12 5 5L20 7"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
    link: '<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 6.3"/><path d="M20 4v7h-7"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 15-5-5-6 6-3-3-4 4"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
    arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    top: '<path d="M5 4h14"/><path d="M12 20V8M6 14l6-6 6 6"/>',
    bottom: '<path d="M5 20h14"/><path d="M12 4v12M6 10l6 6 6-6"/>',
    grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
    warn: '<path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5M12 18h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5M15 12H3"/>',
    logout: '<path d="M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>'
  };

  /** 静态 SVG 图标（name 来自内置常量，安全） */
  function icon(name, size) {
    var s = size || 16;
    return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s +
      '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      (ICONS[name] || '') + '</svg>';
  }

  /** 生成带图标的按钮 */
  function iconBtn(cls, name, title, onclick, size) {
    var btn = h('button', { type: 'button', class: cls || 'ed-mini', title: title || '', html: icon(name, size), onclick: onclick });
    return btn;
  }

  function toast(msg, kind) { if (BS.toast) { BS.toast(msg, kind); } }

  /* ---------------- 配置指纹 / 快照 ---------------- */

  /**
   * 规范化配置用于比较指纹：
   * - 剔除服务端维护的 rev / updatedAt；
   * - 剔除空字符串字段（服务端 json omitempty 会把空串省略，直接 JSON 比较会误判）；
   * - 键名排序，保证对象字面量顺序不同不影响比较。
   */
  function canonicalConfig(value) {
    if (Array.isArray(value)) {
      return value.map(canonicalConfig);
    }
    if (value && typeof value === 'object') {
      var out = {};
      Object.keys(value).sort().forEach(function (key) {
        if (key === 'rev' || key === 'updatedAt') { return; }
        var val = canonicalConfig(value[key]);
        if (val === '') { return; }
        out[key] = val;
      });
      return out;
    }
    return value;
  }

  /** 配置指纹：用于判断是否有未发布修改 / 检测外部变更 */
  function configHash(config) {
    if (!config) { return ''; }
    return JSON.stringify(canonicalConfig(config));
  }

  function snapshot() {
    return {
      config: BS.deepClone(state.config),
      sceneIndex: state.sceneIndex,
      selectedId: state.selectedId
    };
  }

  function restoreSnapshot(snap) {
    state.config = BS.deepClone(snap.config);
    state.sceneIndex = clampNum(snap.sceneIndex || 0, 0, Math.max(0, getScenes().length - 1));
    var scenes = getScenes();
    var scene = scenes[state.sceneIndex] || scenes[0];
    var exists = !!(scene && (scene.widgets || []).filter(function (w) { return w.id === snap.selectedId; }).length);
    state.selectedId = exists ? snap.selectedId : '';
  }

  /** 记录一次撤销快照；coalesceKey 用于合并连续输入（同一 key 700ms 内只记一次） */
  function pushUndo(coalesceKey) {
    if (!state.config) { return; }
    var now = Date.now();
    if (coalesceKey && lastUndoKey === coalesceKey && now - lastUndoAt < 700) {
      lastUndoAt = now;
      return;
    }
    lastUndoKey = coalesceKey || '';
    lastUndoAt = now;
    undoStack.push(snapshot());
    if (undoStack.length > HISTORY_LIMIT) { undoStack.shift(); }
    redoStack.length = 0;
    updateUndoButtons();
  }

  function undo() {
    if (!undoStack.length) { return; }
    var current = snapshot();
    var target = undoStack.pop();
    /* 跳过与当前状态完全相同的快照，避免一次撤销无效果 */
    while (target && configHash(target.config) === configHash(current.config) && undoStack.length) {
      target = undoStack.pop();
    }
    if (!target) { return; }
    redoStack.push(current);
    restoreSnapshot(target);
    afterHistoryChange();
  }

  function redo() {
    if (!redoStack.length) { return; }
    var current = snapshot();
    var target = redoStack.pop();
    while (target && configHash(target.config) === configHash(current.config) && redoStack.length) {
      target = redoStack.pop();
    }
    if (!target) { return; }
    undoStack.push(current);
    restoreSnapshot(target);
    afterHistoryChange();
  }

  function afterHistoryChange() {
    refreshDirty();
    renderAll();
  }

  function updateUndoButtons() {
    if (dom.btnUndo) { dom.btnUndo.disabled = undoStack.length === 0; }
    if (dom.btnRedo) { dom.btnRedo.disabled = redoStack.length === 0; }
  }

  /** 重新计算未发布状态并刷新角标 */
  function refreshDirty() {
    state.dirty = !!state.config && configHash(state.config) !== state.savedHash;
    if (dom.dirtyBadge) { dom.dirtyBadge.hidden = !state.dirty; }
    if (dom.saveState) {
      dom.saveState.classList.toggle('is-dirty', state.dirty);
      dom.saveState.classList.remove('is-error');
      dom.saveState.textContent = state.saving ? '发布中…' : (state.dirty ? '未发布修改' : '已发布');
    }
    if (dom.btnSave) {
      dom.btnSave.disabled = state.saving;
      dom.btnSave.classList.toggle('is-dirty', state.dirty);
    }
  }

  /* ---------------- 当前数据访问 ---------------- */

  function getScenes() {
    return (state.config && state.config.scenes) || [];
  }

  function getScene() {
    return getScenes()[state.sceneIndex] || getScenes()[0] || null;
  }

  function getWidgets() {
    var scene = getScene();
    return (scene && scene.widgets) || [];
  }

  function getWidget(id) {
    if (!id) { return null; }
    var list = getWidgets();
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) { return list[i]; } }
    return null;
  }

  function getSelected() {
    return getWidget(state.selectedId);
  }

  function widgetIndex(id) {
    var list = getWidgets();
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) { return i; } }
    return -1;
  }

  /** 保证场景数组至少有一个场景 */
  function ensureSceneData() {
    if (!state.config) { return; }
    if (!state.config.rotation) {
      state.config.rotation = { auto: true, interval: 10, transition: 'fade', showProgress: true };
    }
    if (!Array.isArray(state.config.scenes) || !state.config.scenes.length) {
      state.config.scenes = [{ id: BS.uid('scene'), name: '场景 1', duration: 0, background: '', widgets: [] }];
    }
    state.config.scenes.forEach(function (scene, i) {
      if (!scene.id) { scene.id = BS.uid('scene'); }
      if (!scene.name) { scene.name = '场景 ' + (i + 1); }
      if (typeof scene.duration !== 'number') { scene.duration = 0; }
      if (!scene.background) { scene.background = ''; }
      if (!Array.isArray(scene.widgets)) { scene.widgets = []; }
      scene.widgets.forEach(function (w) {
        if (!w.id) { w.id = BS.uid(w.type || 'w'); }
        if (!w.style) { w.style = { bg: '', color: '', border: false, glow: false, padding: 24, radius: 0 }; }
        if (typeof w.style.padding !== 'number') { w.style.padding = 24; }
        if (typeof w.style.radius !== 'number') { w.style.radius = 0; }
        w.x = Number(w.x) || 0;
        w.y = Number(w.y) || 0;
        w.w = Number(w.w) || 160;
        w.h = Number(w.h) || 100;
        w.z = Number(w.z) || 0;
      });
    });
    state.sceneIndex = clampNum(state.sceneIndex, 0, state.config.scenes.length - 1);
    if (state.selectedId && !getWidget(state.selectedId)) { state.selectedId = ''; }
  }

  /* ======================================================================
   * 3. 舞台初始化与渲染
   * ==================================================================== */

  /** 构建编辑器画布：舞台骨架 + 覆盖层（网格/空态/选择框/手柄） */
  function buildStage() {
    var handles = '';
    ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(function (dir) {
      handles += '<span class="ed-handle ed-h-' + dir + '" data-dir="' + dir + '"></span>';
    });
    /* 舞台骨架 + 编辑器覆盖层（覆盖层必须挂在 .stage 内部，才能跟随 1920×1080 缩放） */
    dom.canvasFit.innerHTML = BS.stageSkeleton();
    stage = dom.canvasFit.querySelector('.stage');
    stage.classList.add('ed-stage');
    stage.id = 'edStage';
    stage.insertAdjacentHTML('beforeend',
      '<div class="ed-overlay" id="edOverlay">' +
      '  <div class="ed-grid" id="edGrid"></div>' +
      '  <div class="ed-empty" id="edEmpty" hidden></div>' +
      '  <div class="ed-sel" id="edSel" hidden>' + handles + '<div class="ed-size-tip" id="edSizeTip"></div></div>' +
      '</div>');
    activeLayer = stage.querySelector('.scene-layer[data-layer="a"]');
    activeLayer.classList.add('is-active');
    dom.overlay = stage.querySelector('#edOverlay');
    dom.grid = stage.querySelector('#edGrid');
    if (dom.grid) {
      /* 网格放到组件层之下、舞台装饰之上，避免网格线覆盖组件 */
      stage.insertBefore(dom.grid, stage.querySelector('.stage-scenes'));
    }
    dom.empty = stage.querySelector('#edEmpty');
    dom.sel = stage.querySelector('#edSel');
    dom.sizeTip = stage.querySelector('#edSizeTip');
    dom.handles = stage.querySelectorAll('.ed-handle');

    stageFit = BS.fitStage(dom.canvasFit, stage);
    stageFit.update();
    updateZoomLabel();
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () { updateZoomLabel(); });
      ro.observe(dom.canvasFit);
    }
    window.addEventListener('resize', function () { updateZoomLabel(); updateToastOffset(); });
    updateToastOffset();
  }

  /** 轻提示顶部位置随工具栏高度（窄屏工具栏会折行变高） */
  function updateToastOffset() {
    var toolbar = dom.app ? dom.app.querySelector('.ed-toolbar') : null;
    if (!toolbar) { return; }
    document.documentElement.style.setProperty('--bs-toast-top', Math.round(toolbar.getBoundingClientRect().height + 14) + 'px');
  }

  /** 更新缩放比例显示（%）（同时把手柄/浮层尺寸换算回屏幕像素） */
  function updateZoomLabel() {
    if (!stage) { return; }
    var scale = parseFloat(stage.dataset.scale || '1') || 1;
    stage.style.setProperty('--ed-is', String(1 / scale));
    if (dom.zoomLabel) { dom.zoomLabel.textContent = Math.round(scale * 100) + '%'; }
  }

  /** 全量渲染（配置切换、撤销重做、场景切换等） */
  function renderAll() {
    ensureSceneData();
    renderCanvas();
    renderSceneList();
    renderToolbarState();
    renderPropertyPanel();
    updateUndoButtons();
    updateRuntimeUI();
    refreshDirty();
  }

  /** 渲染画布舞台（主题/标题/当前场景组件/选择框/空态） */
  function renderCanvas() {
    if (!stage || !state.config) { return; }
    BS.applyStageConfig(stage, state.config);
    BS.renderScene(activeLayer, getScene(), { mode: 'editor' });
    updateSelection();
    updateEmptyState();
    updateCanvasMeta();
  }

  function updateCanvasMeta() {
    if (!dom.canvasMeta) { return; }
    var scene = getScene();
    var count = scene ? (scene.widgets || []).length : 0;
    dom.canvasMeta.textContent = '画布 1920 × 1080 · ' + (scene ? scene.name : '-') + ' · ' + count + ' 个组件';
  }

  /** 空场景提示 */
  function updateEmptyState() {
    if (!dom.empty) { return; }
    var scene = getScene();
    var empty = !scene || !(scene.widgets || []).length;
    dom.empty.hidden = !empty;
    if (empty) {
      clearEl(dom.empty);
      dom.empty.appendChild(h('strong', { text: '当前场景还没有组件' }));
      dom.empty.appendChild(h('span', { text: '从左侧「组件」面板点击添加，或从右侧属性面板载入内置模板' }));
    }
  }

  function updateSelection() {
    if (!dom.sel) { return; }
    var w = getSelected();
    if (!w) {
      dom.sel.hidden = true;
      return;
    }
    dom.sel.hidden = false;
    dom.sel.style.left = n(w.x) + 'px';
    dom.sel.style.top = n(w.y) + 'px';
    dom.sel.style.width = n(w.w) + 'px';
    dom.sel.style.height = n(w.h) + 'px';
    dom.sel.classList.toggle('is-near-top', Number(w.y) < 90);
    dom.sizeTip.textContent = 'X ' + n(w.x) + '  Y ' + n(w.y) + '   W ' + n(w.w) + '   H ' + n(w.h) + '   Z ' + n(w.z);
  }

  /** 把当前选中组件的 DOM 元素直接按数据更新（拖动/缩放时避免整层重渲染） */
  function syncSelectedEl() {
    var w = getSelected();
    if (!w) { return null; }
    var el = stage.querySelector('.widget[data-widget-id="' + cssEscape(w.id) + '"]');
    if (!el) { return null; }
    el.style.left = n(w.x) + 'px';
    el.style.top = n(w.y) + 'px';
    el.style.width = n(w.w) + 'px';
    el.style.height = n(w.h) + 'px';
    return el;
  }

  function cssEscape(str) {
    if (window.CSS && CSS.escape) { return CSS.escape(str); }
    return String(str).replace(/["\\]/g, '\\$&');
  }

  /* ---------------- 工具栏状态 ---------------- */

  function renderToolbarState() {
    var cfg = state.config;
    if (!cfg) { return; }
    if (dom.titleInput && document.activeElement !== dom.titleInput) {
      dom.titleInput.value = cfg.title || '';
    }
    if (dom.chkAuto) { dom.chkAuto.checked = !!(cfg.rotation && cfg.rotation.auto); }
    if (dom.numInterval && document.activeElement !== dom.numInterval) {
      dom.numInterval.value = (cfg.rotation && cfg.rotation.interval) || 10;
    }
    if (dom.selTransition && document.activeElement !== dom.selTransition) {
      dom.selTransition.value = (cfg.rotation && cfg.rotation.transition) || 'fade';
    }
    var themeButtons = dom.themeGroup.querySelectorAll('.ed-theme-btn');
    for (var i = 0; i < themeButtons.length; i++) {
      themeButtons[i].classList.toggle('is-active', themeButtons[i].dataset.theme === (cfg.theme || 'tech'));
    }
    renderGotoOptions();
    refreshDirty();
  }

  /** 场景列表渲染 */
  function renderSceneList() {
    if (!dom.sceneList) { return; }
    clearEl(dom.sceneList);
    var scenes = getScenes();
    if (!scenes.length) {
      dom.sceneList.appendChild(h('div', { class: 'ed-empty-note', text: '还没有场景，点击右上角 + 新增。' }));
      return;
    }
    scenes.forEach(function (scene, idx) {
      var active = idx === state.sceneIndex;
      var live = idx === state.runtime.scene;
      var item = h('div', {
        class: 'ed-scene-item' + (active ? ' is-active' : '') + (live ? ' is-live' : ''),
        dataset: { index: idx },
        title: '单击切换编辑场景 / 双击重命名',
        onclick: function (ev) {
          if (ev.target.closest('.ed-mini')) { return; }
          selectScene(idx);
        },
        ondblclick: function (ev) {
          if (ev.target.closest('.ed-mini')) { return; }
          openSceneRenameModal(idx);
        }
      }, [
        h('span', { class: 'ed-scene-no', text: String(idx + 1) }),
        h('div', { class: 'ed-scene-info' }, [
          h('div', { class: 'ed-scene-name', text: scene.name || ('场景 ' + (idx + 1)) }),
          h('div', {
            class: 'ed-scene-meta',
            text: (scene.widgets || []).length + ' 个组件 · ' +
              (scene.duration >= 3 ? scene.duration + ' 秒' : '默认时长')
          })
        ]),
        h('span', { class: 'ed-scene-live', title: '大屏正在展示此场景' }),
        h('div', { class: 'ed-scene-actions' }, [
          iconBtn('ed-mini', 'up', '上移场景', function (ev) { ev.stopPropagation(); moveScene(idx, -1); }),
          iconBtn('ed-mini', 'down', '下移场景', function (ev) { ev.stopPropagation(); moveScene(idx, 1); }),
          iconBtn('ed-mini', 'edit', '重命名场景', function (ev) { ev.stopPropagation(); openSceneRenameModal(idx); }),
          iconBtn('ed-mini', 'copy', '复制场景', function (ev) { ev.stopPropagation(); duplicateScene(idx); }),
          iconBtn('ed-mini ed-mini-danger', 'trash', '删除场景', function (ev) { ev.stopPropagation(); deleteScene(idx); })
        ])
      ]);
      dom.sceneList.appendChild(item);
    });
    updateSceneLive();
  }

  /** 只更新场景列表上的“大屏当前场景”高亮，避免每次 runtime 事件重建列表 */
  function updateSceneLive() {
    if (!dom.sceneList) { return; }
    var items = dom.sceneList.querySelectorAll('.ed-scene-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('is-live', Number(items[i].dataset.index) === state.runtime.scene);
    }
  }

  /** 运行时状态 UI（在线数、播放状态、跳转下拉） */
  function updateRuntimeUI() {
    var rt = state.runtime;
    if (dom.displayCount) {
      dom.displayCount.textContent = '大屏 ' + (rt.displays || 0) + ' · 编辑器 ' + (rt.editors || 1);
      dom.displayCount.classList.toggle('is-live', (rt.displays || 0) > 0);
    }
    if (dom.btnToggle) {
      dom.btnToggle.innerHTML = icon(rt.playing ? 'pause' : 'play', 16);
      dom.btnToggle.title = rt.playing ? '暂停自动轮播' : '播放自动轮播';
      dom.btnToggle.classList.toggle('is-active', !!rt.playing);
    }
    updateSceneLive();
    renderGotoOptions();
  }

  function renderGotoOptions() {
    if (!dom.selGoto) { return; }
    var current = dom.selGoto.value;
    clearEl(dom.selGoto);
    dom.selGoto.appendChild(h('option', { value: '', text: '跳转场景' }));
    getScenes().forEach(function (scene, idx) {
      dom.selGoto.appendChild(h('option', {
        value: String(idx),
        text: (idx + 1) + '. ' + (scene.name || ('场景 ' + (idx + 1)))
      }));
    });
    dom.selGoto.value = current || '';
  }
  /* ======================================================================
   * 4. 属性面板
   * ==================================================================== */

  /** 重建右侧属性面板（选中组件 / 看板场景设置两种形态） */
  function renderPropertyPanel() {
    if (!dom.propPanel) { return; }
    clearEl(dom.propPanel);
    clearEl(dom.propHeadActions);
    dom.propTypeTag.hidden = true;
    var w = getSelected();
    if (w) {
      buildWidgetPanel(w);
    } else {
      buildDashboardPanel();
    }
  }

  function refreshPanelSoon() {
    setTimeout(function () { renderPropertyPanel(); }, 0);
  }

  function setPropHeader(title, tag, actions) {
    dom.propTitle.textContent = title;
    if (tag) {
      dom.propTypeTag.hidden = false;
      dom.propTypeTag.textContent = tag;
    } else {
      dom.propTypeTag.hidden = true;
    }
    clearEl(dom.propHeadActions);
    (actions || []).forEach(function (btn) { dom.propHeadActions.appendChild(btn); });
  }

  /* ---------------- 表单控件小工具 ---------------- */

  function section(title, children, note) {
    var head = h('h3', null, [title]);
    if (note) { head.appendChild(h('span', { class: 'ed-sec-note', text: note })); }
    return h('section', { class: 'ed-prop-sec' }, [head].concat(children || []));
  }

  function row(labelText, controls) {
    if (!Array.isArray(controls)) { controls = [controls]; }
    return h('div', { class: 'ed-row' }, [
      h('span', { class: 'ed-row-label', text: labelText }),
      h('div', { class: 'ed-row-ctrl' }, controls)
    ]);
  }

  function fieldBlock(labelText, control, extra) {
    var label = h('div', { class: 'ed-field-label' }, [h('span', { text: labelText })]);
    if (extra) { label.appendChild(extra); }
    return h('div', { class: 'ed-field-block' }, [label, control]);
  }

  function rawInput(type, value, props) {
    var base = { type: type, class: 'ed-input', value: value == null ? '' : String(value) };
    if (props) { Object.keys(props).forEach(function (k) { base[k] = props[k]; }); }
    return h('input', base);
  }

  /** 数字输入：输入时即时应用（范围外忽略），失焦时回写规范值 */
  function numControl(value, opts, apply) {
    opts = opts || {};
    var input = h('input', {
      type: 'number',
      class: 'ed-input ed-input-num',
      value: n(value),
      min: opts.min == null ? null : opts.min,
      max: opts.max == null ? null : opts.max,
      step: opts.step == null ? 1 : opts.step,
      title: opts.title || ''
    });
    function read(commit) {
      var v = parseFloat(input.value);
      if (isNaN(v)) { return; }
      var clamped = clampNum(v, opts.min == null ? -Infinity : opts.min, opts.max == null ? Infinity : opts.max);
      if (commit) { input.value = n(clamped); }
      apply(clamped);
    }
    input.addEventListener('input', function () { read(false); });
    input.addEventListener('change', function () { read(true); });
    input.addEventListener('blur', function () { read(true); });
    return input;
  }

  function textControl(value, opts, apply) {
    opts = opts || {};
    var input = h('input', {
      type: 'text',
      class: 'ed-input',
      value: value == null ? '' : String(value),
      placeholder: opts.placeholder || '',
      maxlength: opts.maxlength || null,
      title: opts.title || ''
    });
    input.addEventListener('input', function () { apply(input.value); });
    return input;
  }

  function areaControl(value, opts, apply, countEl) {
    opts = opts || {};
    var area = h('textarea', {
      class: 'ed-input',
      rows: opts.rows || 4,
      placeholder: opts.placeholder || '',
      maxlength: opts.maxlength || null,
      value: value == null ? '' : String(value)
    });
    if (opts.minHeight) { area.style.minHeight = opts.minHeight + 'px'; }
    area.addEventListener('input', function () {
      apply(area.value);
      if (countEl) { countEl.textContent = area.value.length + (opts.maxlength ? ' / ' + opts.maxlength : ' 字'); }
    });
    return area;
  }

  function selectControl(value, options, apply) {
    var sel = h('select', { class: 'ed-input' });
    options.forEach(function (opt) {
      sel.appendChild(h('option', { value: String(opt.value), text: opt.label }));
    });
    sel.value = String(value);
    sel.addEventListener('change', function () { apply(sel.value); });
    return sel;
  }

  /** 分段选择按钮 */
  function segControl(value, options, apply) {
    var wrap = h('div', { class: 'ed-seg' });
    options.forEach(function (opt) {
      var btn = h('button', {
        type: 'button',
        class: opt.value === value ? 'is-active' : '',
        text: opt.label,
        title: opt.title || '',
        onclick: function () {
          var btns = wrap.querySelectorAll('button');
          for (var i = 0; i < btns.length; i++) { btns[i].classList.toggle('is-active', btns[i] === btn); }
          apply(opt.value);
        }
      });
      wrap.appendChild(btn);
    });
    return wrap;
  }

  /** 复选框行 */
  function checkRow(labelText, checked, apply, title) {
    var input = h('input', { type: 'checkbox', checked: !!checked });
    input.addEventListener('change', function () { apply(input.checked); });
    return h('label', { class: 'ed-check ed-check-row', title: title || '' }, [input, labelText]);
  }

  function toHexColor(value) {
    var v = String(value || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(v)) { return v; }
    if (/^#[0-9a-f]{3}$/i.test(v)) {
      return '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
    }
    var m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(v);
    if (m) {
      return '#' + [m[1], m[2], m[3]].map(function (x) {
        var s = clampNum(parseInt(x, 10), 0, 255).toString(16);
        return s.length < 2 ? '0' + s : s;
      }).join('');
    }
    return '#4c8dff';
  }

  /** 颜色/背景控件：文本框（支持渐变等 CSS）+ 取色器 + 恢复默认 */
  function colorRow(labelText, value, apply, placeholder) {
    var text = h('input', {
      type: 'text',
      class: 'ed-input',
      value: value || '',
      placeholder: placeholder || '主题默认',
      title: '支持 CSS 颜色、rgba() 或 linear-gradient() 渐变'
    });
    var picker = h('input', { type: 'color', class: 'ed-color', value: toHexColor(value), title: '选择颜色' });
    var reset = iconBtn('ed-mini', 'close', '恢复主题默认', function () {
      text.value = '';
      apply('');
    });
    text.addEventListener('input', function () {
      apply(text.value.trim());
      picker.value = toHexColor(text.value);
    });
    picker.addEventListener('input', function () {
      text.value = picker.value;
      apply(picker.value);
    });
    return row(labelText, [text, picker, reset]);
  }

  /** 按钮组行（如图层操作、模板操作） */
  function btnRow(buttons) {
    return h('div', { class: 'ed-row' }, [
      h('span', { class: 'ed-row-label', text: '' }),
      h('div', { class: 'ed-row-ctrl' }, buttons)
    ]);
  }

  /** 让面板里的 X/Y/W/H/Z 输入框同步到最新数据（拖动/缩放后调用） */
  function syncBoundFields() {
    if (!state.selectedId || !dom.propPanel) { return; }
    var w = getSelected();
    if (!w) { return; }
    var fields = dom.propPanel.querySelectorAll('[data-bind]');
    for (var i = 0; i < fields.length; i++) {
      var el = fields[i];
      if (document.activeElement === el) { continue; }
      var key = el.dataset.bind;
      if (!key || w[key] == null) { continue; }
      el.value = n(w[key]);
      /* 位置与尺寸互相约束，拖拽/缩放后刷新输入框的动态范围 */
      if (key === 'x') { el.max = String(CANVAS_W - w.w); }
      else if (key === 'y') { el.max = String(CANVAS_H - w.h); }
      else if (key === 'w') { el.max = String(CANVAS_W - w.x); el.min = String(MIN_W); }
      else if (key === 'h') { el.max = String(CANVAS_H - w.y); el.min = String(MIN_H); }
    }
  }

  /* ---------------- 未选中：看板 / 场景设置 + 模板 ---------------- */

  function buildDashboardPanel() {
    setPropHeader('看板设置', '', []);
    var cfg = state.config;

    /* 看板信息 */
    var titleCtl = textControl(cfg.title || '', { placeholder: '留空则不显示标题区', maxlength: 120 }, function (v) {
      pushUndo('dash-title');
      cfg.title = v;
      if (dom.titleInput && document.activeElement !== dom.titleInput) { dom.titleInput.value = v; }
      if (stage) { BS.applyStageConfig(stage, cfg); }
      refreshDirty();
    });
    titleCtl.dataset.dash = 'title';
    var subtitleCtl = textControl(cfg.subtitle || '', { placeholder: '英文副标题 / 标语，可空', maxlength: 200 }, function (v) {
      pushUndo('dash-subtitle');
      cfg.subtitle = v;
      if (stage) { BS.applyStageConfig(stage, cfg); }
      refreshDirty();
    });
    subtitleCtl.dataset.dash = 'subtitle';
    dom.propPanel.appendChild(section('看板信息', [
      row('主标题', titleCtl),
      row('副标题', subtitleCtl),
      fieldBlock('主题皮肤', segControl(cfg.theme || 'tech', [
        { value: 'tech', label: '科技风', title: THEMES.tech.desc },
        { value: 'red', label: '红色风格', title: THEMES.red.desc },
        { value: 'festive', label: '节日喜庆', title: THEMES.festive.desc }
      ], function (v) { setTheme(v); }), h('span', { class: 'ed-count', text: '画布即时预览' })),
      checkRow('显示底部进度条', !!(cfg.rotation && cfg.rotation.showProgress), function (v) {
        pushUndo('dash-progress');
        cfg.rotation.showProgress = v;
        if (stage) { BS.applyStageConfig(stage, cfg); }
        refreshDirty();
      })
    ]));

    /* 轮播设置 */
    dom.propPanel.appendChild(section('自动轮播', [
      checkRow('开启自动轮播（大屏在线时生效）', !!(cfg.rotation && cfg.rotation.auto), function (v) {
        pushUndo('dash-auto');
        cfg.rotation.auto = v;
        if (dom.chkAuto) { dom.chkAuto.checked = v; }
        refreshDirty();
      }),
      row('停留间隔', [
        numControl(cfg.rotation.interval || 10, { min: 3, max: 600, title: '3 ~ 600 秒' }, function (v) {
          pushUndo('dash-interval');
          cfg.rotation.interval = v;
          if (dom.numInterval) { dom.numInterval.value = n(v); }
          refreshDirty();
        }),
        h('span', { class: 'ed-unit', text: '秒' })
      ]),
      row('过渡效果', selectControl(cfg.rotation.transition || 'fade', [
        { value: 'fade', label: '淡化切换' },
        { value: 'slide', label: '滑动切换' },
        { value: 'zoom', label: '缩放切换' },
        { value: 'none', label: '无过渡' }
      ], function (v) {
        pushUndo('dash-transition');
        cfg.rotation.transition = v;
        if (dom.selTransition) { dom.selTransition.value = v; }
        refreshDirty();
      }))
    ], '间隔可被场景单独覆盖'));

    /* 当前场景设置 */
    dom.propPanel.appendChild(buildSceneSection());

    /* 内置模板 */
    dom.propPanel.appendChild(buildPresetSection());

    /* 恢复默认 */
    dom.propPanel.appendChild(section('重置', [
      h('p', { class: 'ed-tip', style: { margin: '0 0 8px' }, text: '恢复默认将直接替换线上配置（等同于应用科技风示例模板），所有大屏会立即刷新。' }),
      h('button', {
        type: 'button',
        class: 'ed-btn ed-btn-danger ed-btn-block',
        onclick: resetConfig
      }, [h('span', { html: icon('refresh', 14) }), '恢复默认示例'])
    ]));

    /* 快捷键提示 */
    dom.propPanel.appendChild(section('快捷键', [
      h('ul', { class: 'ed-keyhints' }, [
        keyHint('移动组件 1px / 10px', '方向键 / Shift+方向键'),
        keyHint('保存发布', 'Ctrl + S'),
        keyHint('撤销 / 重做', 'Ctrl + Z / Ctrl + Shift + Z'),
        keyHint('复制 / 粘贴组件', 'Ctrl + C / Ctrl + V'),
        keyHint('删除选中组件', 'Delete'),
        keyHint('取消选中 / 关闭弹窗', 'Esc')
      ])
    ]));
  }

  function keyHint(label, keys) {
    return h('li', null, [h('span', { text: label }), h('kbd', { text: keys })]);
  }

  /* ---------------- 当前场景设置 ---------------- */

  function buildSceneSection() {
    var scene = getScene();
    if (!scene) {
      return section('当前场景', [h('div', { class: 'ed-empty-note', text: '暂无场景' })]);
    }
    var bgPreview = scene.background
      ? h('div', { class: 'ed-img-preview' }, [
        h('img', { src: BS.safeImageSrc(scene.background), alt: '场景背景' }),
        h('span', { class: 'ed-img-meta', text: scene.background }),
        iconBtn('ed-mini', 'close', '清除场景背景', function () { setSceneBackground(''); })
      ])
      : null;

    var children = [
      row('场景名称', textControl(scene.name || '', { maxlength: 60, placeholder: '场景名称' }, function (v) {
        pushUndo('scene-name');
        scene.name = v;
        updateSceneListSoft();
        updateCanvasMeta();
        refreshDirty();
      })),
      row('停留时长', [
        numControl(scene.duration || 0, { min: 0, max: 3600, title: '0 = 使用看板默认间隔；3 ~ 3600 秒' }, function (v) {
          pushUndo('scene-duration');
          scene.duration = (v > 0 && v < 3) ? 3 : v;
          updateSceneListSoft();
          refreshDirty();
        }),
        h('span', { class: 'ed-unit', text: '秒（0=默认）' })
      ]),
      row('背景图', [
        h('button', { type: 'button', class: 'ed-btn ed-btn-sm', onclick: function () { openFilePicker('background'); } },
          [h('span', { html: icon('upload', 14) }), '上传']),
        h('button', { type: 'button', class: 'ed-btn ed-btn-sm', onclick: function () { openGallery(setSceneBackground, 'background'); } },
          [h('span', { html: icon('image', 14) }), '图库']),
        h('button', { type: 'button', class: 'ed-btn ed-btn-sm', onclick: clearSceneBackground }, '清除')
      ]),
      row('图片地址', [
        textControl(scene.background || '', { placeholder: '/uploads/... 或 https:// 内网图片', maxlength: 500 }, function (v) {
          /* 输入过程中只暂存，失焦/回车时校验提交 */
          scene.background = v;
        }),
        iconBtn('ed-btn ed-btn-sm', 'check', '应用该地址', applySceneBackgroundFromField)
      ]),
      bgPreview
    ];
    var actions = h('div', { class: 'ed-tbl-tools' }, [
      h('button', { type: 'button', class: 'ed-btn ed-btn-sm', onclick: function () { duplicateScene(state.sceneIndex); } },
        [h('span', { html: icon('copy', 14) }), '复制场景']),
      h('button', { type: 'button', class: 'ed-btn ed-btn-sm ed-btn-danger', onclick: function () { deleteScene(state.sceneIndex); } },
        [h('span', { html: icon('trash', 14) }), '删除场景'])
    ]);
    children.push(actions);
    return section('当前场景', children, (state.sceneIndex + 1) + ' / ' + getScenes().length);
  }

  function applySceneBackgroundFromField() {
    var scene = getScene();
    if (!scene) { return; }
    var raw = scene.background || '';
    var safe = BS.safeImageSrc(raw);
    if (raw && !safe) {
      toast('图片地址不合法，仅支持 /uploads/、/assets/ 或 http(s) 地址', 'error');
      scene.background = '';
    } else {
      scene.background = safe;
    }
    pushUndo(null);
    renderCanvas();
    refreshPanelSoon();
    refreshDirty();
  }

  function setSceneBackground(url) {
    var scene = getScene();
    if (!scene) { return; }
    var safe = BS.safeImageSrc(url);
    if (url && !safe) { toast('图片地址不合法', 'error'); return; }
    pushUndo(null);
    scene.background = safe;
    renderCanvas();
    refreshPanelSoon();
    refreshDirty();
  }

  function clearSceneBackground() {
    setSceneBackground('');
  }

  /* ---------------- 内置模板 ---------------- */

  function buildPresetSection() {
    var wrap = h('div', { class: 'ed-preset-list' });
    if (!state.presets.length) {
      wrap.appendChild(h('div', { class: 'ed-empty-note', text: '模板加载中或加载失败，保存配置后可重试刷新页面。' }));
    }
    state.presets.forEach(function (preset) {
      var theme = THEMES[preset.theme] || THEMES.tech;
      wrap.appendChild(h('div', { class: 'ed-preset' }, [
        h('div', { class: 'ed-preset-head' }, [
          h('span', { class: 'ed-preset-dot', style: { '--c': theme.color } }),
          h('span', { class: 'ed-preset-name', text: preset.name || theme.label }),
          h('span', { class: 'ed-preset-meta', text: (preset.sceneCount || 0) + ' 个场景' })
        ]),
        h('p', { class: 'ed-preset-desc', text: theme.desc }),
        h('div', { class: 'ed-preset-actions' }, [
          h('button', {
            type: 'button',
            class: 'ed-btn ed-btn-sm',
            title: '载入为本地草稿，需点击“保存发布”才会上线',
            onclick: function () { loadPresetDraft(preset.id); }
          }, '载入为草稿'),
          h('button', {
            type: 'button',
            class: 'ed-btn ed-btn-sm ed-btn-primary',
            title: '直接替换线上配置并广播给所有大屏',
            onclick: function () { applyPreset(preset.id); }
          }, '直接发布')
        ])
      ]));
    });
    return section('内置模板', [wrap], '三套主题示例');
  }

  /* ---------------- 选中组件属性 ---------------- */

  function buildWidgetPanel(w) {
    var label = BS.widgetLabel(w.type);
    setPropHeader(w.title || label, label, [
      iconBtn('ed-btn ed-btn-sm', 'copy', '复制组件', function () { duplicateWidget(w); }),
      iconBtn('ed-btn ed-btn-sm ed-btn-danger', 'trash', '删除组件', function () { deleteWidget(w); })
    ]);

    /* 基础信息 */
    dom.propPanel.appendChild(section('基础', [
      row('标题', textControl(w.title || '', { maxlength: 80, placeholder: '组件标题，可空' }, function (v) {
        pushUndo('widget-title');
        w.title = v;
        if (dom.propTitle) { dom.propTitle.textContent = v || label; }
        scheduleCanvas();
        refreshDirty();
      })),
      row('类型', h('span', { class: 'ed-row-ctrl', text: label + ' · ' + (w.id || '') }))
    ]));

    /* 位置与尺寸 */
    var posSection = section('位置与尺寸', [
      h('div', { class: 'ed-row' }, [
        h('span', { class: 'ed-row-label', text: 'X / Y' }),
        h('div', { class: 'ed-row-ctrl' }, [
          bindNum(w, 'x', { min: 0, max: CANVAS_W - w.w, title: 'X 坐标（设计像素）' }),
          bindNum(w, 'y', { min: 0, max: CANVAS_H - w.h, title: 'Y 坐标（设计像素）' })
        ])
      ]),
      h('div', { class: 'ed-row' }, [
        h('span', { class: 'ed-row-label', text: 'W / H' }),
        h('div', { class: 'ed-row-ctrl' }, [
          bindNum(w, 'w', { min: MIN_W, max: CANVAS_W - w.x, title: '宽度' }),
          bindNum(w, 'h', { min: MIN_H, max: CANVAS_H - w.y, title: '高度' })
        ])
      ]),
      h('div', { class: 'ed-row' }, [
        h('span', { class: 'ed-row-label', text: '层级 Z' }),
        h('div', { class: 'ed-row-ctrl' }, [
          bindNum(w, 'z', { min: 0, max: 9999, title: '层叠顺序，数值越大越靠上' })
        ])
      ]),
      h('div', { class: 'ed-row' }, [
        h('span', { class: 'ed-row-label', text: '图层' }),
        h('div', { class: 'ed-row-ctrl' }, [
          iconBtn('ed-btn ed-btn-sm', 'top', '置于顶层', function () { moveLayer(w, 'top'); }),
          iconBtn('ed-btn ed-btn-sm', 'up', '上移一层', function () { moveLayer(w, 'up'); }),
          iconBtn('ed-btn ed-btn-sm', 'down', '下移一层', function () { moveLayer(w, 'down'); }),
          iconBtn('ed-btn ed-btn-sm', 'bottom', '置于底层', function () { moveLayer(w, 'bottom'); })
        ])
      ])
    ]);

    function bindNum(target, key, opts) {
      var input = numControl(target[key], opts, function (v) {
        pushUndo('widget-' + key);
        target[key] = v;
        syncSelectedEl();
        updateSelection();
        updateCanvasMeta();
        scheduleCanvas();
        refreshDirty();
      });
      input.dataset.bind = key;
      return input;
    }

    dom.propPanel.appendChild(posSection);

    /* 通用样式 */
    dom.propPanel.appendChild(section('外观样式', [
      colorRow('背景', w.style.bg || '', function (v) {
        pushUndo('style-bg');
        w.style.bg = v;
        scheduleCanvas();
        refreshDirty();
      }, '主题默认面板底'),
      colorRow('文字色', w.style.color || '', function (v) {
        pushUndo('style-color');
        w.style.color = v;
        scheduleCanvas();
        refreshDirty();
      }),
      h('div', { class: 'ed-row' }, [
        h('span', { class: 'ed-row-label', text: '效果' }),
        h('div', { class: 'ed-row-ctrl' }, [
          checkRow('主题描边', !!w.style.border, function (v) {
            pushUndo('style-border');
            w.style.border = v;
            scheduleCanvas();
            refreshDirty();
          }),
          checkRow('辉光', !!w.style.glow, function (v) {
            pushUndo('style-glow');
            w.style.glow = v;
            scheduleCanvas();
            refreshDirty();
          })
        ])
      ]),
      h('div', { class: 'ed-row' }, [
        h('span', { class: 'ed-row-label', text: '内边距/圆角' }),
        h('div', { class: 'ed-row-ctrl' }, [
          numControl(w.style.padding != null ? w.style.padding : 24, { min: 0, max: 200, title: '内边距 px' }, function (v) {
            pushUndo('style-padding');
            w.style.padding = v;
            scheduleCanvas();
            refreshDirty();
          }),
          numControl(w.style.radius || 0, { min: 0, max: 200, title: '圆角 px' }, function (v) {
            pushUndo('style-radius');
            w.style.radius = v;
            scheduleCanvas();
            refreshDirty();
          })
        ])
      ])
    ]));

    /* 类型专属属性 */
    var typeProps = w[w.type];
    if (!typeProps) {
      typeProps = {};
      w[w.type] = typeProps;
    }
    if (w.type === 'text') {
      dom.propPanel.appendChild(buildTextProps(w, typeProps));
    } else if (w.type === 'table') {
      dom.propPanel.appendChild(buildTableProps(w, typeProps));
    } else if (w.type === 'image') {
      dom.propPanel.appendChild(buildImageProps(w, typeProps));
    } else if (w.type === 'clock') {
      dom.propPanel.appendChild(buildClockProps(w, typeProps));
    } else if (w.type === 'notice') {
      dom.propPanel.appendChild(buildNoticeProps(w, typeProps));
    }

    /* 底部操作 */
    dom.propPanel.appendChild(section('操作', [
      h('div', { class: 'ed-preset-actions' }, [
        h('button', { type: 'button', class: 'ed-btn', onclick: function () { duplicateWidget(w); } },
          [h('span', { html: icon('copy', 14) }), '复制组件']),
        h('button', { type: 'button', class: 'ed-btn ed-btn-danger', onclick: function () { deleteWidget(w); } },
          [h('span', { html: icon('trash', 14) }), '删除组件'])
      ])
    ]));
  }
  /* ---------------- 文本属性 ---------------- */

  function buildTextProps(w, p) {
    var count = h('span', { class: 'ed-count', text: '0 / 20000 字' });
    var area = areaControl(p.content || '', {
      rows: 6, maxlength: 20000, placeholder: '输入文本内容，换行会原样保留'
    }, function (v) {
      pushUndo('text-content');
      p.content = v;
      scheduleCanvas();
      refreshDirty();
    }, count);
    count.textContent = (p.content || '').length + ' / 20000 字';

    return section('文本内容', [
      fieldBlock('内容', area, count),
      h('div', { class: 'ed-row' }, [
        h('span', { class: 'ed-row-label', text: '字号/字重' }),
        h('div', { class: 'ed-row-ctrl' }, [
          numControl(p.fontSize || 28, { min: 8, max: 200, title: '字号 px' }, function (v) {
            pushUndo('text-fontsize'); p.fontSize = v; scheduleCanvas(); refreshDirty();
          }),
          selectControl(p.fontWeight || 400, FONT_WEIGHTS, function (v) {
            pushUndo('text-fontweight'); p.fontWeight = parseInt(v, 10) || 400; scheduleCanvas(); refreshDirty();
          })
        ])
      ]),
      row('对齐', segControl(p.align || 'left', [
        { value: 'left', label: '左对齐' },
        { value: 'center', label: '居中' },
        { value: 'right', label: '右对齐' },
        { value: 'justify', label: '两端' }
      ], function (v) {
        pushUndo('text-align'); p.align = v; scheduleCanvas(); refreshDirty();
      })),
      h('div', { class: 'ed-row' }, [
        h('span', { class: 'ed-row-label', text: '行高/字距' }),
        h('div', { class: 'ed-row-ctrl' }, [
          numControl(p.lineHeight || 1.5, { min: 0.8, max: 4, step: 0.1, title: '行高倍数' }, function (v) {
            pushUndo('text-lineheight'); p.lineHeight = v; scheduleCanvas(); refreshDirty();
          }),
          numControl(p.letterSpacing || 0, { min: -5, max: 50, step: 0.5, title: '字间距 px' }, function (v) {
            pushUndo('text-letterspacing'); p.letterSpacing = v; scheduleCanvas(); refreshDirty();
          })
        ])
      ]),
      colorRow('文字颜色', p.color || '', function (v) {
        pushUndo('text-color'); p.color = v; scheduleCanvas(); refreshDirty();
      })
    ]);
  }

  /* ---------------- 表格属性 ---------------- */

  function buildTableProps(w, p) {
    var cols = Array.isArray(p.columns) ? p.columns : (p.columns = []);
    var rows = Array.isArray(p.rows) ? p.rows : (p.rows = []);

    var editor = h('div', { class: 'ed-tbl-scroll' });
    var table = h('table', { class: 'ed-tbl-editor' });
    var thead = h('thead');
    var headRow = h('tr');
    cols.forEach(function (col, ci) {
      var input = h('input', {
        type: 'text', value: col, maxlength: 40, placeholder: '列 ' + (ci + 1), title: '列名'
      });
      input.addEventListener('input', function () {
        pushUndo('tbl-col-' + ci);
        cols[ci] = input.value;
        scheduleCanvas();
        refreshDirty();
      });
      var head = h('div', { class: 'ed-col-head' }, [
        input,
        iconBtn('ed-mini ed-mini-danger', 'close', '删除该列', function () { deleteColumn(ci); })
      ]);
      headRow.appendChild(h('th', null, head));
    });
    headRow.appendChild(h('th', { class: 'ed-cell-x' }));
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = h('tbody');
    rows.forEach(function (rowData, ri) {
      if (!Array.isArray(rowData)) { rowData = rows[ri] = []; }
      var tr = h('tr');
      cols.forEach(function (col, ci) {
        while (rowData.length < cols.length) { rowData.push(''); }
        var cellInput = h('input', {
          type: 'text', value: rowData[ci] == null ? '' : rowData[ci], maxlength: 500, title: '第 ' + (ri + 1) + ' 行第 ' + (ci + 1) + ' 列'
        });
        cellInput.addEventListener('input', function () {
          pushUndo('tbl-cell-' + ri + '-' + ci);
          while (rowData.length < cols.length) { rowData.push(''); }
          rowData[ci] = cellInput.value;
          scheduleCanvas();
          refreshDirty();
        });
        tr.appendChild(h('td', null, cellInput));
      });
      tr.appendChild(h('td', { class: 'ed-cell-x' }, iconBtn('ed-mini ed-mini-danger', 'close', '删除该行', function () { deleteRow(ri); })));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    editor.appendChild(table);

    var tools = h('div', { class: 'ed-tbl-tools' }, [
      h('button', { type: 'button', class: 'ed-btn ed-btn-sm', onclick: addRow }, '添加行'),
      h('button', { type: 'button', class: 'ed-btn ed-btn-sm', onclick: addColumn }, '添加列'),
      h('button', { type: 'button', class: 'ed-btn ed-btn-sm', onclick: deleteLastRow }, '删除末行'),
      h('button', { type: 'button', class: 'ed-btn ed-btn-sm', onclick: deleteLastColumn }, '删除末列')
    ]);

    function addRow() {
      pushUndo(null);
      var blank = [];
      for (var i = 0; i < cols.length; i++) { blank.push(''); }
      rows.push(blank);
      renderCanvas();
      refreshPanelSoon();
      refreshDirty();
    }
    function addColumn() {
      if (cols.length >= 20) { toast('最多 20 列', 'error'); return; }
      pushUndo(null);
      cols.push('列 ' + (cols.length + 1));
      rows.forEach(function (r) { r.push(''); });
      renderCanvas();
      refreshPanelSoon();
      refreshDirty();
    }
    function deleteColumn(ci) {
      if (cols.length <= 1) { toast('至少保留一列', 'error'); return; }
      pushUndo(null);
      cols.splice(ci, 1);
      rows.forEach(function (r) { r.splice(ci, 1); });
      renderCanvas();
      refreshPanelSoon();
      refreshDirty();
    }
    function deleteRow(ri) {
      pushUndo(null);
      rows.splice(ri, 1);
      renderCanvas();
      refreshPanelSoon();
      refreshDirty();
    }
    function deleteLastRow() {
      if (!rows.length) { toast('已经没有数据行了', 'error'); return; }
      deleteRow(rows.length - 1);
    }
    function deleteLastColumn() {
      if (cols.length <= 1) { toast('至少保留一列', 'error'); return; }
      deleteColumn(cols.length - 1);
    }

    return section('表格数据', [
      h('div', { class: 'ed-row' }, [
        h('span', { class: 'ed-row-label', text: '字号/对齐' }),
        h('div', { class: 'ed-row-ctrl' }, [
          numControl(p.fontSize || 20, { min: 10, max: 80, title: '表格字号 px' }, function (v) {
            pushUndo('table-fontsize'); p.fontSize = v; scheduleCanvas(); refreshDirty();
          }),
          selectControl(p.align || 'left', [
            { value: 'left', label: '左对齐' },
            { value: 'center', label: '居中' },
            { value: 'right', label: '右对齐' }
          ], function (v) {
            pushUndo('table-align'); p.align = v; scheduleCanvas(); refreshDirty();
          })
        ])
      ]),
      colorRow('表头底色', p.headerBg || '', function (v) {
        pushUndo('table-headerbg'); p.headerBg = v; scheduleCanvas(); refreshDirty();
      }),
      checkRow('斑马纹隔行底色', !!p.striped, function (v) {
        pushUndo('table-striped'); p.striped = v; scheduleCanvas(); refreshDirty();
      }),
      h('div', { class: 'ed-divider' }),
      fieldBlock('列名与单元格（' + cols.length + ' 列 × ' + rows.length + ' 行）', editor),
      tools
    ], '增删行列修改后自动生效');
  }

  /* ---------------- 图片属性 ---------------- */

  function buildImageProps(w, p) {
    var src = BS.safeImageSrc(p.src);
    var children = [];
    if (src) {
      children.push(h('div', { class: 'ed-img-preview' }, [
        h('img', { src: src, alt: '组件图片' }),
        h('span', { class: 'ed-img-meta', text: src }),
        iconBtn('ed-mini', 'close', '清除图片', function () { setImageSrc(''); })
      ]));
    } else {
      children.push(h('div', { class: 'ed-empty-note', text: '尚未选择图片，可上传本地图片、从图库选择或填写内网图片地址。' }));
    }
    children.push(row('图片来源', [
      h('button', { type: 'button', class: 'ed-btn ed-btn-sm', onclick: function () { openFilePicker('image'); } },
        [h('span', { html: icon('upload', 14) }), '上传']),
      h('button', { type: 'button', class: 'ed-btn ed-btn-sm', onclick: function () { openGallery(setImageSrc); } },
        [h('span', { html: icon('image', 14) }), '图库']),
      h('button', { type: 'button', class: 'ed-btn ed-btn-sm', onclick: function () { setImageSrc(''); } }, '清除')
    ]));
    var urlInput = textControl(p.src || '', {
      placeholder: '/uploads/xxx.png 或 https:// 内网图片', maxlength: 500, title: '支持 /uploads/、/assets/ 与 http(s) 地址'
    }, function (v) { p.src = v; });
    children.push(row('图片地址', [
      urlInput,
      iconBtn('ed-btn ed-btn-sm', 'check', '应用该地址', function () {
        applyImageUrl(urlInput);
      })
    ]));
    children.push(row('填充方式', selectControl(p.fit || 'cover', [
      { value: 'cover', label: '裁切填充 cover' },
      { value: 'contain', label: '完整显示 contain' },
      { value: 'fill', label: '拉伸填满 fill' },
      { value: 'scale-down', label: '适应缩小 scale-down' }
    ], function (v) {
      pushUndo('image-fit'); p.fit = v; scheduleCanvas(); refreshDirty();
    })));
    children.push(row('图注', textControl(p.caption || '', { maxlength: 200, placeholder: '显示在图片下方，可空' }, function (v) {
      pushUndo('image-caption'); p.caption = v; scheduleCanvas(); refreshDirty();
    })));

    function applyImageUrl(input) {
      var raw = input.value.trim();
      var safe = BS.safeImageSrc(raw);
      if (raw && !safe) {
        toast('图片地址不合法，仅支持 /uploads/、/assets/ 与 http(s) 地址', 'error');
        return;
      }
      setImageSrc(safe);
    }

    function setImageSrc(value) {
      pushUndo(null);
      p.src = value;
      renderCanvas();
      refreshPanelSoon();
      refreshDirty();
      if (value) { toast('图片已更新', 'ok'); }
    }

    return section('图片', children);
  }

  /* ---------------- 时钟属性 ---------------- */

  function buildClockProps(w, p) {
    var formatInput = textControl(p.format || 'YYYY-MM-DD HH:mm:ss', {
      maxlength: 80, placeholder: 'YYYY-MM-DD HH:mm:ss', title: '支持 YYYY MM DD HH mm ss dddd ddd 占位符'
    }, function (v) {
      pushUndo('clock-format'); p.format = v; scheduleCanvas(); refreshDirty();
    });
    var presets = [
      { label: 'HH:mm:ss', value: 'HH:mm:ss' },
      { label: 'YYYY-MM-DD', value: 'YYYY-MM-DD' },
      { label: '完整日期时间', value: 'YYYY-MM-DD HH:mm:ss' },
      { label: '中文日期', value: 'YYYY年MM月DD日 dddd' },
      { label: '周几 + 时间', value: 'ddd HH:mm:ss' }
    ];
    var quick = h('div', { class: 'ed-seg ed-seg-wrap' }, presets.map(function (item) {
      return h('button', {
        type: 'button',
        text: item.label,
        title: '使用格式 ' + item.value,
        onclick: function () {
          formatInput.value = item.value;
          pushUndo('clock-format');
          p.format = item.value;
          scheduleCanvas();
          refreshDirty();
        }
      });
    }));

    return section('时钟', [
      fieldBlock('时间格式', formatInput),
      fieldBlock('快捷格式', quick),
      checkRow('显示星期', !!p.showWeek, function (v) {
        pushUndo('clock-week'); p.showWeek = v; scheduleCanvas(); refreshDirty();
      }),
      h('div', { class: 'ed-row' }, [
        h('span', { class: 'ed-row-label', text: '字号/对齐' }),
        h('div', { class: 'ed-row-ctrl' }, [
          numControl(p.fontSize || 52, { min: 12, max: 240, title: '时间字号 px' }, function (v) {
            pushUndo('clock-fontsize'); p.fontSize = v; scheduleCanvas(); refreshDirty();
          }),
          selectControl(p.align || 'center', [
            { value: 'left', label: '左对齐' },
            { value: 'center', label: '居中' },
            { value: 'right', label: '右对齐' }
          ], function (v) {
            pushUndo('clock-align'); p.align = v; scheduleCanvas(); refreshDirty();
          })
        ])
      ]),
      row('标签', textControl(p.label || '', { maxlength: 40, placeholder: '时间上方小标签，可空' }, function (v) {
        pushUndo('clock-label'); p.label = v; scheduleCanvas(); refreshDirty();
      })),
      colorRow('时间颜色', p.color || '', function (v) {
        pushUndo('clock-color'); p.color = v; scheduleCanvas(); refreshDirty();
      })
    ]);
  }

  /* ---------------- 滚动通知属性 ---------------- */

  function buildNoticeProps(w, p) {
    var count = h('span', { class: 'ed-count', text: '0 / 5000 字' });
    var area = areaControl(p.content || '', {
      rows: 4, maxlength: 5000, placeholder: '输入滚动播放的通知内容'
    }, function (v) {
      pushUndo('notice-content');
      p.content = v;
      scheduleCanvas();
      refreshDirty();
    }, count);
    count.textContent = (p.content || '').length + ' / 5000 字';

    return section('滚动通知', [
      fieldBlock('通知内容', area, count),
      h('div', { class: 'ed-row' }, [
        h('span', { class: 'ed-row-label', text: '速度/字号' }),
        h('div', { class: 'ed-row-ctrl' }, [
          numControl(p.speed || 80, { min: 20, max: 400, title: '滚动速度 px/s（越大越快）' }, function (v) {
            pushUndo('notice-speed'); p.speed = v; scheduleCanvas(); refreshDirty();
          }),
          numControl(p.fontSize || 22, { min: 10, max: 80, title: '字号 px' }, function (v) {
            pushUndo('notice-fontsize'); p.fontSize = v; scheduleCanvas(); refreshDirty();
          })
        ])
      ]),
      checkRow('显示喇叭图标', p.icon !== false, function (v) {
        pushUndo('notice-icon'); p.icon = v; scheduleCanvas(); refreshDirty();
      })
    ], '速度 20~400 px/s');
  }
  /* ======================================================================
   * 5. 画布交互：选择、拖动、8 向缩放、快捷键、撤销重做
   * ==================================================================== */

  var canvasTimer = 0;

  /** 合并高频画布重渲染（属性面板输入时使用） */
  function scheduleCanvas() {
    clearTimeout(canvasTimer);
    canvasTimer = setTimeout(function () {
      renderCanvas();
    }, 60);
  }

  function selectScene(index) {
    if (index < 0 || index >= getScenes().length) { return; }
    if (index === state.sceneIndex) { return; }
    state.sceneIndex = index;
    state.selectedId = '';
    renderCanvas();
    renderSceneList();
    renderPropertyPanel();
    updateCanvasMeta();
  }

  function selectWidget(id) {
    id = id || '';
    if (state.selectedId === id) { return; }
    state.selectedId = id;
    updateSelection();
    renderPropertyPanel();
  }

  function getWidgetEl(id) {
    if (!stage || !id) { return null; }
    return stage.querySelector('.widget[data-widget-id="' + cssEscape(id) + '"]');
  }

  function bindCanvasEvents() {
    stage.addEventListener('pointerdown', onCanvasPointerDown);
    Array.prototype.forEach.call(dom.handles, function (handle) {
      handle.addEventListener('pointerdown', onHandlePointerDown);
    });
    /* 点击画布外围（letterbox 区域）取消选中 */
    dom.canvasWrap.addEventListener('pointerdown', function (ev) {
      if (!stage.contains(ev.target)) { selectWidget(''); }
    });
  }

  /** 画布内按下：选择组件并开始拖动 */
  function onCanvasPointerDown(ev) {
    if (ev.button !== 0) { return; }
    if (ev.target.closest('.ed-handle')) { return; }
    var widgetEl = ev.target.closest ? ev.target.closest('.widget') : null;
    if (!widgetEl || !activeLayer.contains(widgetEl)) {
      selectWidget('');
      return;
    }
    var id = widgetEl.getAttribute('data-widget-id') || '';
    var w = getWidget(id);
    if (!w) { selectWidget(''); return; }
    ev.preventDefault();
    if (state.selectedId !== id) { selectWidget(id); }
    startDrag('move', ev, w, '');
  }

  /** 手柄按下：开始缩放 */
  function onHandlePointerDown(ev) {
    if (ev.button !== 0) { return; }
    ev.preventDefault();
    ev.stopPropagation();
    var w = getSelected();
    if (!w) { return; }
    startDrag('resize', ev, w, ev.currentTarget.getAttribute('data-dir') || 'se');
  }

  function startDrag(mode, ev, w, dir) {
    var pt = BS.stagePoint(stage, ev);
    drag = {
      mode: mode,
      dir: dir,
      widget: w,
      startX: pt.x,
      startY: pt.y,
      origin: { x: w.x, y: w.y, w: w.w, h: w.h },
      moved: false
    };
    if (dom.sel) { dom.sel.classList.add('is-dragging'); }
    document.body.classList.add('is-dragging');
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragUp);
    window.addEventListener('pointercancel', onDragUp);
    updateSelection();
  }

  function onDragMove(ev) {
    if (!drag) { return; }
    var pt = BS.stagePoint(stage, ev);
    var dx = pt.x - drag.startX;
    var dy = pt.y - drag.startY;
    if (!drag.moved && (Math.abs(dx) > 0.6 || Math.abs(dy) > 0.6)) {
      drag.moved = true;
      /* 真正产生位移时才记录撤销点：单纯点选不清空重做栈 */
      pushUndo(null);
    }
    if (drag.mode === 'move') {
      applyMove(drag, dx, dy, ev.altKey);
    } else {
      applyResize(drag, dx, dy, ev.altKey);
    }
    syncSelectedEl();
    updateSelection();
    syncBoundFields();
  }

  function applyMove(dragObj, dx, dy, alt) {
    var w = dragObj.widget;
    var o = dragObj.origin;
    var nx = o.x + dx;
    var ny = o.y + dy;
    if (!alt) {
      nx = Math.round(nx / GRID) * GRID;
      ny = Math.round(ny / GRID) * GRID;
    }
    w.x = round2(clampNum(nx, 0, CANVAS_W - w.w));
    w.y = round2(clampNum(ny, 0, CANVAS_H - w.h));
  }

  function applyResize(dragObj, dx, dy, alt) {
    var w = dragObj.widget;
    var o = dragObj.origin;
    var dir = dragObj.dir;
    var x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
    function snap(v) { return alt ? v : Math.round(v / GRID) * GRID; }
    if (dir.indexOf('w') >= 0) { x1 = clampNum(snap(o.x + dx), 0, x2 - MIN_W); }
    if (dir.indexOf('e') >= 0) { x2 = clampNum(snap(o.x + o.w + dx), x1 + MIN_W, CANVAS_W); }
    if (dir.indexOf('n') >= 0) { y1 = clampNum(snap(o.y + dy), 0, y2 - MIN_H); }
    if (dir.indexOf('s') >= 0) { y2 = clampNum(snap(o.y + o.h + dy), y1 + MIN_H, CANVAS_H); }
    w.x = round2(x1);
    w.y = round2(y1);
    w.w = round2(x2 - x1);
    w.h = round2(y2 - y1);
  }

  function onDragUp() {
    if (!drag) { return; }
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragUp);
    window.removeEventListener('pointercancel', onDragUp);
    document.body.classList.remove('is-dragging');
    if (dom.sel) { dom.sel.classList.remove('is-dragging'); }
    var changed = drag.moved;
    drag = null;
    if (!changed) { return; }
    /* 松手后整层重渲染一次，保证 DOM 与数据完全一致 */
    renderCanvas();
    renderSceneList();
    updateSelection();
    syncBoundFields();
    updateCanvasMeta();
    refreshDirty();
    updateUndoButtons();
  }

  function round2(v) {
    return Math.round(v * 100) / 100;
  }

  /** 方向键微调选中组件 */
  function nudgeSelected(dx, dy) {
    var w = getSelected();
    if (!w) { return; }
    pushUndo('nudge-' + dx + '-' + dy);
    w.x = round2(clampNum(w.x + dx, 0, CANVAS_W - w.w));
    w.y = round2(clampNum(w.y + dy, 0, CANVAS_H - w.h));
    syncSelectedEl();
    updateSelection();
    syncBoundFields();
    scheduleCanvas();
    refreshDirty();
  }

  /** 组件复制 / 粘贴（编辑器内部剪贴板，不依赖系统剪贴板权限） */
  function copySelected() {
    var w = getSelected();
    if (!w) { toast('请先选中要复制的组件', 'error'); return; }
    clipboard = BS.deepClone(w);
    toast('已复制组件：' + BS.widgetLabel(w.type), 'ok');
  }

  function pasteWidget() {
    if (!clipboard) { toast('剪贴板为空，选中组件后按 Ctrl+C 复制', 'error'); return; }
    var scene = getScene();
    if (!scene) { return; }
    pushUndo(null);
    var copy = BS.deepClone(clipboard);
    copy.id = BS.uid(copy.type || 'w');
    copy.x = round2(clampNum(copy.x + 20, 0, CANVAS_W - copy.w));
    copy.y = round2(clampNum(copy.y + 20, 0, CANVAS_H - copy.h));
    copy.z = maxZ() + 1;
    scene.widgets.push(copy);
    state.selectedId = copy.id;
    renderCanvas();
    renderSceneList();
    renderPropertyPanel();
    updateCanvasMeta();
    refreshDirty();
    toast('已粘贴组件', 'ok');
  }

  function maxZ() {
    var list = getWidgets();
    var max = 0;
    for (var i = 0; i < list.length; i++) { max = Math.max(max, Number(list[i].z) || 0); }
    return max;
  }

  /* ---------------- 键盘事件 ---------------- */

  function isEditableTarget(target) {
    if (!target || !target.tagName) { return false; }
    var tag = target.tagName.toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  function onKeyDown(ev) {
    var mod = ev.ctrlKey || ev.metaKey;
    var key = ev.key;

    if (key === 'Escape') {
      if (dom.modalHost && !dom.modalHost.hidden) { closeModal(); ev.preventDefault(); return; }
      if (state.selectedId) { selectWidget(''); ev.preventDefault(); return; }
      return;
    }
    if (dom.modalHost && !dom.modalHost.hidden) { return; }

    /* 保存：输入框内也允许 Ctrl+S */
    if (mod && (key === 's' || key === 'S')) {
      ev.preventDefault();
      save();
      return;
    }
    if (isEditableTarget(ev.target)) { return; }

    if (mod && (key === 'z' || key === 'Z')) {
      ev.preventDefault();
      if (ev.shiftKey) { redo(); } else { undo(); }
      return;
    }
    if (mod && (key === 'y' || key === 'Y')) {
      ev.preventDefault();
      redo();
      return;
    }
    if (mod && (key === 'd' || key === 'D')) {
      ev.preventDefault();
      var dup = getSelected();
      if (dup) { duplicateWidget(dup); }
      return;
    }
    if (mod && (key === 'c' || key === 'C')) {
      ev.preventDefault();
      copySelected();
      return;
    }
    if (mod && (key === 'v' || key === 'V')) {
      ev.preventDefault();
      pasteWidget();
      return;
    }
    if (mod) { return; }

    if (key === 'Delete' || key === 'Backspace') {
      var w = getSelected();
      if (w) {
        ev.preventDefault();
        deleteWidget(w);
      }
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') {
      if (!getSelected()) { return; }
      ev.preventDefault();
      var step = ev.shiftKey ? 10 : 1;
      if (key === 'ArrowLeft') { nudgeSelected(-step, 0); }
      else if (key === 'ArrowRight') { nudgeSelected(step, 0); }
      else if (key === 'ArrowUp') { nudgeSelected(0, -step); }
      else { nudgeSelected(0, step); }
    }
  }
  /* ======================================================================
   * 6. 保存发布 / 冲突处理 / 登录鉴权
   * ==================================================================== */

  function save() {
    if (!state.config || state.saving) { return; }
    state.saving = true;
    refreshDirty();
    var payload = BS.deepClone(state.config);
    payload.rev = state.rev || 0;
    BS.api('/api/config', { method: 'PUT', body: payload }).then(function (res) {
      state.saving = false;
      adoptSavedConfig(res && res.config);
      refreshDirty();
      toast('已保存并发布，所有大屏将同步更新', 'ok');
    }).catch(function (err) {
      state.saving = false;
      refreshDirty();
      if (err.status === 401) {
        showLoginModal(function () { save(); });
        return;
      }
      if (err.status === 409) {
        showConflictModal(err.data && err.data.config);
        return;
      }
      toast('保存失败：' + (err.message || '网络错误'), 'error');
    });
  }

  /** 保存成功后采用服务端返回的权威配置（可能被钳制/归一化） */
  function adoptSavedConfig(config) {
    if (!config) { return; }
    state.config = config;
    state.rev = config.rev || 0;
    ensureSceneData();
    state.savedHash = configHash(state.config);
    state.dirty = false;
    hideExternalBanner();
    renderAll();
  }

  /** 409 冲突弹窗 */
  function showConflictModal(latest) {
    if (!latest) {
      toast('保存失败：版本冲突，请刷新页面后重试', 'error');
      return;
    }
    var dialog = openModal({
      title: '保存冲突',
      body: [
        h('p', null, [
          '服务端配置已被其他终端修改：服务端版本 ',
          h('strong', { text: 'rev ' + (latest.rev || 0) }),
          '，本地编辑基于 ',
          h('strong', { text: 'rev ' + (state.rev || 0) }),
          '。'
        ]),
        h('p', { text: '你可以载入最新配置（会放弃本地未发布的修改），或直接用本地内容覆盖发布。' })
      ],
      actions: [
        { label: '取消', onClick: function () { closeModal(); } },
        {
          label: '载入最新配置',
          onClick: function () {
            closeModal();
            adoptSavedConfig(latest);
            toast('已载入服务端最新配置', 'ok');
          }
        },
        {
          label: '覆盖保存',
          class: 'ed-btn ed-btn-primary',
          onClick: function () {
            closeModal();
            state.rev = latest.rev || 0;
            toast('以本地内容重新提交…');
            save();
          }
        }
      ]
    });
    return dialog;
  }

  /* ---------------- 登录 ---------------- */

  function checkAuth() {
    return BS.api('/api/auth').then(function (data) {
      state.authRequired = !!data.required;
      state.authenticated = !state.authRequired || !!data.authenticated;
      updateAuthUI();
    }).catch(function () { /* 老版本服务无该接口时忽略 */ });
  }

  function updateAuthUI() {
    if (!dom.btnLogin) { return; }
    dom.btnLogin.hidden = !(state.authRequired && !state.authenticated);
    dom.btnLogin.textContent = state.authenticated ? '已登录' : '登录';
  }

  function showLoginModal(retry) {
    loginRetry = retry || null;
    var errorEl = h('div', { class: 'ed-dialog-error', text: '' });
    var input = h('input', {
      type: 'password', class: 'ed-input', placeholder: '请输入编辑密码', autocomplete: 'current-password'
    });
    var dialog = openModal({
      title: '需要登录',
      body: [
        h('p', { text: '服务端已开启编辑密码，保存/上传/远程控制前需要登录。' }),
        h('div', { class: 'ed-field-label', text: '编辑密码' }),
        input,
        errorEl
      ],
      actions: [
        { label: '取消', onClick: function () { loginRetry = null; closeModal(); } },
        { label: '登录', class: 'ed-btn ed-btn-primary', onClick: submit }
      ]
    });
    function submit() {
      var pwd = input.value;
      if (!pwd) { errorEl.textContent = '请输入密码'; input.focus(); return; }
      BS.api('/api/login', { method: 'POST', body: { password: pwd } }).then(function () {
        state.authenticated = true;
        updateAuthUI();
        closeModal();
        toast('登录成功', 'ok');
        var cb = loginRetry;
        loginRetry = null;
        if (typeof cb === 'function') { cb(); }
      }).catch(function (err) {
        errorEl.textContent = err.status === 401 ? '密码错误，请重试' : ('登录失败：' + (err.message || '网络错误'));
        input.select();
      });
    }
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
    });
    setTimeout(function () { input.focus(); }, 50);
    return dialog;
  }

  /* ======================================================================
   * 7. SSE 实时同步与远程控制
   * ==================================================================== */

  function connectEvents() {
    sse = BS.connectSSE('editor', {
      open: function () {
        state.connected = true;
        updateConnectionUI();
      },
      error: function () {
        state.connected = false;
        updateConnectionUI();
      },
      hello: function (data) {
        state.connected = true;
        if (typeof data.authRequired === 'boolean') {
          state.authRequired = data.authRequired;
          if (!state.authRequired) { state.authenticated = true; }
          updateAuthUI();
        }
        if (data.runtime) {
          state.runtime = data.runtime;
          updateRuntimeUI();
        }
        if (data.config) { adoptExternalConfig(data.config, false); }
        updateConnectionUI();
      },
      runtime: function (data) {
        if (!data.runtime) { return; }
        state.runtime = data.runtime;
        updateRuntimeUI();
      },
      config: function (data) {
        if (data.runtime) {
          state.runtime = data.runtime;
          updateRuntimeUI();
        }
        if (data.config) { adoptExternalConfig(data.config, false); }
      },
      command: function (data) {
        if (data && data.runtime) {
          state.runtime = data.runtime;
          updateRuntimeUI();
        }
        if (data && data.action === 'notify' && data.message) {
          /* 其他终端发送的通知在本端也给出提示 */
          toast('大屏通知：' + data.message);
        }
      }
    });
  }

  function updateConnectionUI() {
    if (!dom.displayCount) { return; }
    if (state.connected) {
      dom.displayCount.classList.remove('is-offline');
      dom.displayCount.title = '在线大屏 / 编辑器数量（SSE 已连接）';
      dom.displayCount.textContent = '大屏 ' + (state.runtime.displays || 0) + ' · 编辑器 ' + (state.runtime.editors || 1);
    } else {
      dom.displayCount.classList.add('is-offline');
      dom.displayCount.title = '与服务器的实时连接已断开，浏览器会自动重连';
      dom.displayCount.textContent = '实时连接断开 · 重连中…';
    }
  }

  /** 处理来自服务端的配置变更广播：绝不覆盖本地未保存的草稿 */
  function adoptExternalConfig(config, force) {
    if (!config) { return; }
    var incomingHash = configHash(config);
    if (incomingHash === configHash(state.config)) { return; }
    if (!force && state.dirty) {
      /* 已保存的版本发生变化才算“外部变更”，避免自身保存回声 */
      if (incomingHash !== state.savedHash) {
        showExternalBanner(config);
      }
      return;
    }
    state.config = config;
    state.rev = config.rev || 0;
    state.savedHash = incomingHash;
    state.dirty = false;
    ensureSceneData();
    hideExternalBanner();
    renderAll();
    toast('已同步其他终端发布的最新配置');
  }

  /* 外部配置变更提示条 */
  var pendingExternalConfig = null;

  function showExternalBanner(config) {
    pendingExternalConfig = config;
    if (dom.banner) { return; }
    var banner = h('div', { class: 'ed-banner' }, [
      h('span', { class: 'ed-banner-icon', html: icon('warn', 15) }),
      h('span', { class: 'ed-banner-text', text: '检测到其他终端发布了新配置，本地未保存的修改已保留。' }),
      h('button', {
        type: 'button', class: 'ed-btn ed-btn-sm', text: '载入最新配置',
        onclick: function () {
          var cfg = pendingExternalConfig;
          pendingExternalConfig = null;
          hideExternalBanner();
          adoptExternalConfig(cfg, true);
          toast('已载入最新配置', 'ok');
        }
      }),
      iconBtn('ed-mini', 'close', '忽略提示（继续保留本地草稿）', hideExternalBanner)
    ]);
    dom.banner = banner;
    var toolbar = dom.app.querySelector('.ed-toolbar');
    toolbar.parentNode.insertBefore(banner, toolbar.nextSibling);
  }

  function hideExternalBanner() {
    if (dom.banner && dom.banner.parentNode) {
      dom.banner.parentNode.removeChild(dom.banner);
    }
    dom.banner = null;
    pendingExternalConfig = null;
  }

  /* ---------------- 远程控制 ---------------- */

  function control(action, extra) {
    var payload = Object.assign({ action: action }, extra || {});
    BS.api('/api/control', { method: 'POST', body: payload }).then(function (res) {
      if (res && res.runtime) {
        state.runtime = res.runtime;
        updateRuntimeUI();
      }
      return res;
    }).catch(function (err) {
      if (err.status === 401) {
        showLoginModal(function () { control(action, extra); });
        return;
      }
      toast('远程控制失败：' + (err.message || '网络错误'), 'error');
    });
  }

  function gotoSceneBySelect() {
    if (!dom.selGoto) { return; }
    var value = dom.selGoto.value;
    if (value === '') { return; }
    var index = parseInt(value, 10);
    if (isNaN(index)) { return; }
    control('goto', { sceneIndex: index });
    dom.selGoto.value = '';
  }

  function notifyModal() {
    var count = h('span', { class: 'ed-count', text: '0 / 200 字' });
    var area = h('textarea', {
      class: 'ed-input', rows: 3, maxlength: 200, placeholder: '输入要在所有大屏上弹出的通知内容'
    });
    area.addEventListener('input', function () { count.textContent = area.value.length + ' / 200 字'; });
    openModal({
      title: '发送通知到所有大屏',
      body: [
        h('p', { text: '通知会以提示条形式显示在大屏顶部，最长 200 字。' }),
        h('div', { class: 'ed-field-label' }, [h('span', { text: '通知内容' }), count]),
        area
      ],
      actions: [
        { label: '取消', onClick: closeModal },
        {
          label: '发送', class: 'ed-btn ed-btn-primary',
          onClick: function () {
            var message = area.value.trim();
            if (!message) { area.focus(); return; }
            closeModal();
            control('notify', { message: message });
            toast('通知已发送', 'ok');
          }
        }
      ]
    });
    setTimeout(function () { area.focus(); }, 50);
  }

  function reloadAllScreens() {
    confirmModal({
      title: '刷新所有大屏',
      message: '将向所有在线大屏发送刷新指令，浏览器会重新加载展示页面。确定继续吗？',
      okText: '刷新大屏',
      onOk: function () {
        control('reload');
        toast('刷新指令已发送', 'ok');
      }
    });
  }

  /* ======================================================================
   * 8. 场景 / 组件 / 模板 / 上传图库
   * ==================================================================== */

  /* ---------------- 场景操作 ---------------- */

  function addScene() {
    pushUndo(null);
    var scenes = getScenes();
    var scene = {
      id: BS.uid('scene'),
      name: '场景 ' + (scenes.length + 1),
      duration: 0,
      background: '',
      widgets: []
    };
    scenes.splice(state.sceneIndex + 1, 0, scene);
    state.sceneIndex = state.sceneIndex + 1;
    state.selectedId = '';
    renderCanvas();
    renderSceneList();
    renderPropertyPanel();
    renderToolbarState();
    refreshDirty();
    toast('已新增场景', 'ok');
  }

  function duplicateScene(index) {
    var scenes = getScenes();
    var source = scenes[index];
    if (!source) { return; }
    pushUndo(null);
    var copy = BS.deepClone(source);
    copy.id = BS.uid('scene');
    copy.name = (source.name || '场景') + ' 副本';
    copy.widgets = (copy.widgets || []).map(function (w) {
      var clone = BS.deepClone(w);
      clone.id = BS.uid(clone.type || 'w');
      return clone;
    });
    scenes.splice(index + 1, 0, copy);
    state.sceneIndex = index + 1;
    state.selectedId = '';
    renderCanvas();
    renderSceneList();
    renderPropertyPanel();
    renderToolbarState();
    refreshDirty();
    toast('已复制场景', 'ok');
  }

  function deleteScene(index) {
    var scenes = getScenes();
    if (scenes.length <= 1) {
      toast('至少保留一个场景', 'error');
      return;
    }
    var scene = scenes[index];
    confirmModal({
      title: '删除场景',
      message: '确定删除场景「' + (scene ? scene.name : '') + '」及其中的 ' + ((scene && scene.widgets) || []).length + ' 个组件吗？此操作可以撤销。',
      okText: '删除场景',
      danger: true,
      onOk: function () {
        pushUndo(null);
        scenes.splice(index, 1);
        if (state.sceneIndex > index || state.sceneIndex >= scenes.length) {
          state.sceneIndex = clampNum(state.sceneIndex > index ? state.sceneIndex - 1 : state.sceneIndex, 0, scenes.length - 1);
        }
        state.selectedId = '';
        renderCanvas();
        renderSceneList();
        renderPropertyPanel();
        renderToolbarState();
        refreshDirty();
        toast('场景已删除', 'ok');
      }
    });
  }

  function moveScene(index, delta) {
    var scenes = getScenes();
    var target = index + delta;
    if (target < 0 || target >= scenes.length) { return; }
    pushUndo(null);
    var moved = scenes.splice(index, 1)[0];
    scenes.splice(target, 0, moved);
    state.sceneIndex = target;
    state.selectedId = '';
    renderCanvas();
    renderSceneList();
    renderPropertyPanel();
    renderToolbarState();
    refreshDirty();
  }

  function openSceneRenameModal(index) {
    var scene = getScenes()[index];
    if (!scene) { return; }
    var input = h('input', { type: 'text', class: 'ed-input', value: scene.name || '', maxlength: 60 });
    openModal({
      title: '重命名场景',
      body: [h('div', { class: 'ed-field-label', text: '场景名称（最多 60 字）' }), input],
      actions: [
        { label: '取消', onClick: closeModal },
        {
          label: '保存', class: 'ed-btn ed-btn-primary',
          onClick: function () {
            var name = input.value.trim();
            if (!name) { input.focus(); return; }
            closeModal();
            pushUndo(null);
            scene.name = name;
            renderSceneList();
            renderPropertyPanel();
            updateCanvasMeta();
            refreshDirty();
          }
        }
      ]
    });
    setTimeout(function () { input.focus(); input.select(); }, 50);
  }

  /** 场景列表在数据变化后软刷新（保留选中态） */
  function updateSceneListSoft() {
    if (!dom.sceneList) { return; }
    var items = dom.sceneList.querySelectorAll('.ed-scene-item');
    for (var i = 0; i < items.length; i++) {
      var idx = Number(items[i].dataset.index);
      var scene = getScenes()[idx];
      if (!scene) { continue; }
      var nameEl = items[i].querySelector('.ed-scene-name');
      var metaEl = items[i].querySelector('.ed-scene-meta');
      if (nameEl) { nameEl.textContent = scene.name || ('场景 ' + (idx + 1)); }
      if (metaEl) {
        metaEl.textContent = (scene.widgets || []).length + ' 个组件 · ' +
          (scene.duration >= 3 ? scene.duration + ' 秒' : '默认时长');
      }
    }
  }

  /* ---------------- 组件操作 ---------------- */

  function addWidget(type) {
    var scene = getScene();
    if (!scene) { return; }
    if ((scene.widgets || []).length >= 200) { toast('单个场景最多 200 个组件', 'error'); return; }
    pushUndo(null);
    var count = scene.widgets.length;
    var w = BS.createWidget(type, count);
    /* 居中摆放，并按数量错开 */
    var offset = (count % 6) * 24;
    w.x = round2(clampNum(Math.round((CANVAS_W - w.w) / 2 / GRID) * GRID + offset, 0, CANVAS_W - w.w));
    w.y = round2(clampNum(Math.round((CANVAS_H - w.h) / 2 / GRID) * GRID + offset, 0, CANVAS_H - w.h));
    w.z = maxZ() + 1;
    scene.widgets.push(w);
    state.selectedId = w.id;
    renderCanvas();
    renderSceneList();
    renderPropertyPanel();
    updateCanvasMeta();
    refreshDirty();
    toast('已添加' + BS.widgetLabel(type) + '组件', 'ok');
  }

  function deleteWidget(w) {
    if (!w) { return; }
    pushUndo(null);
    var scene = getScene();
    if (!scene) { return; }
    var idx = widgetIndex(w.id);
    if (idx < 0) { return; }
    scene.widgets.splice(idx, 1);
    if (state.selectedId === w.id) { state.selectedId = ''; }
    renderCanvas();
    renderSceneList();
    renderPropertyPanel();
    updateCanvasMeta();
    refreshDirty();
    toast('已删除组件');
  }

  function duplicateWidget(w) {
    if (!w) { return; }
    var scene = getScene();
    if (!scene) { return; }
    pushUndo(null);
    var copy = BS.deepClone(w);
    copy.id = BS.uid(copy.type || 'w');
    copy.x = round2(clampNum(copy.x + 20, 0, CANVAS_W - copy.w));
    copy.y = round2(clampNum(copy.y + 20, 0, CANVAS_H - copy.h));
    copy.z = maxZ() + 1;
    scene.widgets.push(copy);
    state.selectedId = copy.id;
    renderCanvas();
    renderSceneList();
    renderPropertyPanel();
    updateCanvasMeta();
    refreshDirty();
    toast('已复制组件', 'ok');
  }

  /** 图层调整：up/down 移动一层，top/bottom 置顶置底；随后重排 z 为 1..n */
  function moveLayer(w, mode) {
    var scene = getScene();
    if (!scene || !w) { return; }
    pushUndo(null);
    var list = scene.widgets;
    var sorted = list.map(function (item, i) { return { w: item, i: i }; })
      .sort(function (a, b) { return ((Number(a.w.z) || 0) - (Number(b.w.z) || 0)) || (a.i - b.i); });
    var pos = -1;
    for (var i = 0; i < sorted.length; i++) { if (sorted[i].w === w) { pos = i; break; } }
    if (pos < 0) { return; }
    var item = sorted.splice(pos, 1)[0];
    var target = pos;
    if (mode === 'up') { target = Math.min(sorted.length, pos + 1); }
    else if (mode === 'down') { target = Math.max(0, pos - 1); }
    else if (mode === 'top') { target = sorted.length; }
    else if (mode === 'bottom') { target = 0; }
    sorted.splice(target, 0, item);
    for (var k = 0; k < sorted.length; k++) {
      sorted[k].w.z = k + 1;
    }
    /* 按新 z 排序写回 scene.widgets，保持数据结构稳定 */
    scene.widgets = sorted.map(function (s) { return s.w; });
    renderCanvas();
    renderPropertyPanel();
    refreshDirty();
  }

  /* ---------------- 主题 ---------------- */

  function setTheme(theme) {
    if (!state.config || !THEMES[theme]) { return; }
    if (state.config.theme === theme) { return; }
    pushUndo(null);
    state.config.theme = theme;
    BS.applyStageConfig(stage, state.config);
    renderToolbarState();
    refreshDirty();
    toast('已切换主题：' + THEMES[theme].label);
  }

  /* ---------------- 内置模板 ---------------- */

  function loadPresets() {
    return BS.api('/api/presets').then(function (data) {
      state.presets = (data && data.presets) || [];
    }).catch(function (err) {
      state.presets = [];
      if (err.status !== 401) { toast('内置模板加载失败：' + (err.message || '网络错误'), 'error'); }
    });
  }

  function loadPresetDraft(id) {
    var preset = null;
    for (var i = 0; i < state.presets.length; i++) {
      if (state.presets[i].id === id) { preset = state.presets[i]; break; }
    }
    var name = preset ? preset.name : id;
    confirmModal({
      title: '载入模板草稿',
      message: '将「' + name + '」载入为本地草稿，会覆盖当前编辑内容（可撤销）。载入后需要点击“保存发布”才会上线。',
      okText: '载入草稿',
      onOk: function () {
        BS.api('/api/presets/' + encodeURIComponent(id)).then(function (res) {
          var config = res && res.config;
          if (!config) { throw new Error('模板数据缺失'); }
          pushUndo(null);
          config.rev = 0;
          state.config = config;
          state.rev = 0;
          state.sceneIndex = 0;
          state.selectedId = '';
          ensureSceneData();
          renderAll();
          /* 模板载入后强制同步工具栏标题（避免焦点仍在标题输入框时显示旧标题） */
          if (dom.titleInput) { dom.titleInput.value = config.title || ''; }
          toast('模板已载入为草稿，点击“保存发布”上线', 'ok');
        }).catch(function (err) {
          if (err.status === 401) { showLoginModal(function () { loadPresetDraft(id); }); return; }
          toast('模板载入失败：' + (err.message || '网络错误'), 'error');
        });
      }
    });
  }

  function applyPreset(id) {
    var preset = null;
    for (var i = 0; i < state.presets.length; i++) {
      if (state.presets[i].id === id) { preset = state.presets[i]; break; }
    }
    var name = preset ? preset.name : id;
    confirmModal({
      title: '直接发布模板',
      message: '将「' + name + '」直接替换线上配置，所有大屏会立即刷新为这个模板。确定发布吗？',
      okText: '立即发布',
      onOk: function () {
        BS.api('/api/presets/' + encodeURIComponent(id) + '/apply', { method: 'POST' }).then(function (res) {
          if (res && res.config) {
            adoptSavedConfig(res.config);
          } else {
            return reloadConfigFromServer();
          }
          toast('模板已发布', 'ok');
        }).catch(function (err) {
          if (err.status === 401) { showLoginModal(function () { applyPreset(id); }); return; }
          toast('模板发布失败：' + (err.message || '网络错误'), 'error');
        });
      }
    });
  }

  function resetConfig() {
    confirmModal({
      title: '恢复默认示例',
      message: '将线上配置恢复为默认科技风示例模板，所有大屏会立即刷新。此操作会覆盖当前线上配置（本地未保存的修改也会丢失）。',
      okText: '恢复默认',
      danger: true,
      onOk: function () {
        BS.api('/api/reset', { method: 'POST' }).then(function (res) {
          if (res && res.config) {
            adoptSavedConfig(res.config);
          } else {
            return reloadConfigFromServer();
          }
          toast('已恢复默认示例', 'ok');
        }).catch(function (err) {
          if (err.status === 401) { showLoginModal(resetConfig); return; }
          toast('恢复默认失败：' + (err.message || '网络错误'), 'error');
        });
      }
    });
  }

  function reloadConfigFromServer() {
    return BS.api('/api/config').then(function (data) {
      if (data && data.config) {
        adoptSavedConfig(data.config);
        if (data.runtime) {
          state.runtime = data.runtime;
          updateRuntimeUI();
        }
      }
    });
  }

  /* ---------------- 图片上传与图库 ---------------- */

  function openFilePicker(target) {
    uploadTarget = target || 'image';
    if (!dom.fileInput) { return; }
    dom.fileInput.value = '';
    dom.fileInput.click();
  }

  function onFileChosen() {
    var file = dom.fileInput.files && dom.fileInput.files[0];
    if (!file) { return; }
    var target = uploadTarget || 'image';
    uploadFile(file, target);
  }

  function uploadFile(file, target) {
    var form = new FormData();
    form.append('file', file);
    if (dom.saveState) { dom.saveState.textContent = '图片上传中…'; }
    BS.api('/api/upload', { method: 'POST', form: form }).then(function (res) {
      refreshDirty();
      if (!res || !res.url) { throw new Error('上传响应缺少 url'); }
      if (target === 'background') {
        setSceneBackground(res.url);
      } else {
        var w = getSelected();
        if (w && w.type === 'image') {
          pushUndo(null);
          if (!w.image) { w.image = { src: '', fit: 'cover', caption: '' }; }
          w.image.src = res.url;
          renderCanvas();
          renderPropertyPanel();
          refreshDirty();
          toast('图片上传成功', 'ok');
        } else {
          toast('图片已上传：' + res.url + '（可先在右侧选中图片组件再上传）');
        }
      }
    }).catch(function (err) {
      refreshDirty();
      if (err.status === 401) {
        showLoginModal(function () { uploadFile(file, target); });
        return;
      }
      toast('上传失败：' + (err.message || '网络错误'), 'error');
    });
  }

  /** 打开图库选择弹窗 */
  function openGallery(apply, target) {
    var galleryTarget = target || 'image';
    var grid = h('div', { class: 'ed-gallery-grid' });
    var status = h('div', { class: 'ed-dialog-error', text: '正在加载图库…' });
    openModal({
      title: '图片图库',
      body: [status, grid],
      actions: [
        { label: '上传新图片', onClick: function () { closeModal(); openFilePicker(galleryTarget); } },
        { label: '关闭', class: 'ed-btn-primary', onClick: closeModal }
      ]
    });
    BS.api('/api/uploads').then(function (data) {
      status.textContent = '';
      var files = (data && data.files) || [];
      if (!files.length) {
        status.textContent = '图库中还没有图片，可点击下方“上传新图片”。';
        return;
      }
      files.forEach(function (file) {
        var item = h('div', {
          class: 'ed-gallery-item',
          title: file.name || '',
          onclick: function () {
            var url = BS.safeImageSrc(file.url);
            if (!url) { toast('图片地址不合法', 'error'); return; }
            closeModal();
            apply(url);
          }
        }, [
          h('img', { src: BS.safeImageSrc(file.url), alt: file.name || '图片' }),
          h('span', { class: 'ed-gallery-name', text: file.name || '' })
        ]);
        grid.appendChild(item);
      });
    }).catch(function (err) {
      if (err.status === 401) {
        closeModal();
        showLoginModal(function () { openGallery(apply, target); });
        return;
      }
      status.textContent = '图库加载失败：' + (err.message || '网络错误');
    });
  }
  /* ======================================================================
   * 9. 弹窗组件与启动流程
   * ==================================================================== */

  /** 打开通用弹窗；返回 { dialog, body, close } */
  function openModal(opts) {
    opts = opts || {};
    var host = dom.modalHost;
    host.hidden = false;
    clearEl(host);
    var dialog = h('div', { class: 'ed-dialog', style: { width: opts.width ? Math.min(opts.width, 640) + 'px' : '' } });
    var head = h('div', { class: 'ed-dialog-head' }, [
      h('h3', { text: opts.title || '' })
    ]);
    if (opts.subtitle) { head.appendChild(h('span', { class: 'ed-dialog-sub', text: opts.subtitle })); }
    head.appendChild(iconBtn('ed-icon-btn', 'close', '关闭', function () { closeModal(); }));
    dialog.appendChild(head);

    var body = h('div', { class: 'ed-dialog-body' });
    (opts.body || []).forEach(function (node) {
      if (typeof node === 'string') { body.appendChild(h('p', { text: node })); }
      else if (node) { body.appendChild(node); }
    });
    dialog.appendChild(body);

    var actions = opts.actions || [];
    if (actions.length) {
      var foot = h('div', { class: 'ed-dialog-foot' });
      actions.forEach(function (action) {
        foot.appendChild(h('button', {
          type: 'button',
          class: action.class || 'ed-btn',
          text: action.label,
          onclick: function () { action.onClick(); }
        }));
      });
      dialog.appendChild(foot);
    }
    host.appendChild(dialog);
    host.onclick = function (ev) { if (ev.target === host) { closeModal(); } };
    return { dialog: dialog, body: body, close: closeModal };
  }

  function closeModal() {
    if (!dom.modalHost) { return; }
    clearEl(dom.modalHost);
    dom.modalHost.hidden = true;
    dom.modalHost.onclick = null;
  }

  function confirmModal(opts) {
    opts = opts || {};
    openModal({
      title: opts.title || '请确认',
      body: [h('p', { text: opts.message || '' })],
      actions: [
        { label: '取消', onClick: closeModal },
        {
          label: opts.okText || '确定',
          class: opts.danger ? 'ed-btn ed-btn-danger' : 'ed-btn ed-btn-primary',
          onClick: function () {
            closeModal();
            if (typeof opts.onOk === 'function') { opts.onOk(); }
          }
        }
      ]
    });
  }

  /* ======================================================================
   * 启动
   * ==================================================================== */

  function cacheDom() {
    var ids = [
      'edApp', 'edTitleInput', 'themeGroup', 'chkAuto', 'numInterval', 'selTransition',
      'btnToggle', 'btnPrev', 'btnNext', 'selGoto', 'btnNotify', 'btnReload',
      'displayCount', 'saveState', 'btnLogin', 'btnPreview', 'btnKiosk', 'btnSave', 'dirtyBadge',
      'sceneList', 'btnAddScene', 'btnDupScene', 'btnDelScene', 'widgetPalette',
      'btnUndo', 'btnRedo', 'chkGrid', 'zoomLabel', 'canvasMeta', 'canvasWrap', 'canvasFit',
      'propTitle', 'propTypeTag', 'propHeadActions', 'propPanel', 'modalHost', 'fileInput'
    ];
    ids.forEach(function (id) { dom[id] = document.getElementById(id); });
    dom.titleInput = dom.edTitleInput;
    dom.app = dom.edApp;
  }

  /** 左侧组件面板 */
  function renderWidgetPalette() {
    if (!dom.widgetPalette) { return; }
    clearEl(dom.widgetPalette);
    BS.WIDGET_TYPES.forEach(function (meta) {
      var btn = h('button', {
        type: 'button',
        class: 'ed-widget-btn' + (meta.type === 'notice' ? ' is-wide' : ''),
        title: '添加' + meta.label + '：' + meta.desc,
        onclick: function () { addWidget(meta.type); }
      });
      btn.innerHTML = BS.svgIcon(meta.type, 17); /* 静态图标 */
      btn.appendChild(h('span', { class: 'ed-widget-name' }, [
        meta.label,
        h('span', { class: 'ed-widget-desc', text: meta.desc })
      ]));
      dom.widgetPalette.appendChild(btn);
    });
  }

  /** 网格开关偏好（本地记忆，不写服务端） */
  function loadGridPref() {
    var visible = true;
    try {
      var saved = window.localStorage.getItem('bigscreen.editor.grid');
      if (saved === '0') { visible = false; }
    } catch (e) { /* 隐私模式下忽略 */ }
    if (dom.chkGrid) { dom.chkGrid.checked = visible; }
    if (dom.grid) { dom.grid.hidden = !visible; }
  }

  function saveGridPref(visible) {
    try { window.localStorage.setItem('bigscreen.editor.grid', visible ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  function bindToolbarEvents() {
    /* 标题输入：画布标题即时预览 */
    dom.titleInput.addEventListener('input', function () {
      if (!state.config) { return; }
      pushUndo('dash-title');
      state.config.title = dom.titleInput.value;
      BS.applyStageConfig(stage, state.config);
      document.title = '大屏看板 · ' + (dom.titleInput.value || '未命名看板');
      var mirror = dom.propPanel ? dom.propPanel.querySelector('[data-dash="title"]') : null;
      if (mirror && document.activeElement !== mirror) { mirror.value = dom.titleInput.value; }
      refreshDirty();
    });

    /* 主题切换 */
    dom.themeGroup.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('.ed-theme-btn') : null;
      if (!btn) { return; }
      setTheme(btn.getAttribute('data-theme'));
    });

    /* 自动轮播开关 */
    dom.chkAuto.addEventListener('change', function () {
      if (!state.config) { return; }
      pushUndo('dash-auto');
      state.config.rotation.auto = dom.chkAuto.checked;
      refreshDirty();
      if (!state.selectedId) { refreshPanelSoon(); }
    });

    /* 间隔秒数 */
    var applyInterval = function (commit) {
      if (!state.config) { return; }
      var v = parseInt(dom.numInterval.value, 10);
      if (isNaN(v)) { if (commit) { dom.numInterval.value = state.config.rotation.interval || 10; } return; }
      v = clampNum(v, 3, 600);
      if (commit) { dom.numInterval.value = v; }
      pushUndo('dash-interval');
      state.config.rotation.interval = v;
      refreshDirty();
      if (commit && !state.selectedId) { refreshPanelSoon(); }
    };
    dom.numInterval.addEventListener('input', function () { applyInterval(false); });
    dom.numInterval.addEventListener('change', function () { applyInterval(true); });
    dom.numInterval.addEventListener('blur', function () { applyInterval(true); });

    /* 过渡效果 */
    dom.selTransition.addEventListener('change', function () {
      if (!state.config) { return; }
      pushUndo('dash-transition');
      state.config.rotation.transition = dom.selTransition.value;
      refreshDirty();
      if (!state.selectedId) { refreshPanelSoon(); }
    });

    /* 保存 / 预览 / 全屏 / 登录 */
    dom.btnSave.addEventListener('click', save);
    dom.btnPreview.addEventListener('click', function () {
      window.open('/', '_blank', 'noopener');
    });
    dom.btnLogin.addEventListener('click', function () { showLoginModal(null); });

    /* 画布操作栏 */
    dom.btnUndo.addEventListener('click', undo);
    dom.btnRedo.addEventListener('click', redo);
    dom.chkGrid.addEventListener('change', function () {
      if (dom.grid) { dom.grid.hidden = !dom.chkGrid.checked; }
      saveGridPref(dom.chkGrid.checked);
    });

    /* 场景操作 */
    dom.btnAddScene.addEventListener('click', addScene);
    dom.btnDupScene.addEventListener('click', function () { duplicateScene(state.sceneIndex); });
    dom.btnDelScene.addEventListener('click', function () { deleteScene(state.sceneIndex); });

    /* 远程控制 */
    dom.btnToggle.addEventListener('click', function () { control('toggle'); });
    dom.btnPrev.addEventListener('click', function () { control('prev'); });
    dom.btnNext.addEventListener('click', function () { control('next'); });
    dom.btnNotify.addEventListener('click', notifyModal);
    dom.btnReload.addEventListener('click', reloadAllScreens);
    dom.selGoto.addEventListener('change', gotoSceneBySelect);

    /* 上传文件选择 */
    dom.fileInput.addEventListener('change', onFileChosen);

    /* 键盘 */
    document.addEventListener('keydown', onKeyDown);

    /* 离开页面前提醒未保存 */
    window.addEventListener('beforeunload', function (ev) {
      if (!state.dirty) { return; }
      ev.preventDefault();
      ev.returnValue = '有未发布的修改，确定离开吗？';
      return ev.returnValue;
    });
  }

  /** 启动失败时的兜底界面 */
  function showBootError(err) {
    var box = h('div', {
      class: 'ed-empty',
      style: { position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', pointerEvents: 'auto' }
    }, [
      h('strong', { text: '加载看板配置失败' }),
      h('span', { text: '请确认服务已启动后重试：' + (err && err.message ? err.message : '网络错误') })
    ]);
    var retry = h('button', { type: 'button', class: 'ed-btn ed-btn-primary', text: '重新加载', onclick: function () { window.location.reload(); } });
    box.appendChild(h('div', { style: { marginTop: '12px' }, text: '' }, retry));
    if (dom.canvasFit) { dom.canvasFit.appendChild(box); }
  }

  function boot() {
    cacheDom();
    if (!dom.canvasFit || !dom.modalHost) {
      /* 页面结构异常时不再继续，避免无意义报错 */
      return;
    }
    renderWidgetPalette();
    buildStage();
    bindCanvasEvents();
    bindToolbarEvents();
    loadGridPref();

    Promise.all([
      BS.api('/api/config'),
      loadPresets(),
      checkAuth()
    ]).then(function (results) {
      var data = results[0] || {};
      if (!data.config) { throw new Error('服务端未返回配置'); }
      state.config = data.config;
      state.rev = data.config.rev || 0;
      if (data.runtime) { state.runtime = data.runtime; }
      ensureSceneData();
      state.savedHash = configHash(state.config);
      state.dirty = false;
      /* 初始编辑场景尽量与大屏当前场景对齐 */
      if (typeof state.runtime.scene === 'number' && state.runtime.scene >= 0 &&
          state.runtime.scene < getScenes().length) {
        state.sceneIndex = state.runtime.scene;
      }
      renderAll();
      updateConnectionUI();
      document.title = '大屏看板 · ' + (state.config.title || '未命名看板');
      connectEvents();
      state.booted = true;
    }).catch(function (err) {
      showBootError(err);
    });
  }

  /* 暴露少量只读调试入口，便于自动化验收（不影响业务） */
  window.__bsEditor = {
    state: state,
    render: renderAll,
    save: save,
    selectWidget: selectWidget,
    selectScene: selectScene,
    undo: undo,
    redo: redo
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
