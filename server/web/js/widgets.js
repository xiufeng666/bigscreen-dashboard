/* ==========================================================================
 * BigScreen 组件渲染库（Lead 维护，display/editor 共用）
 * 渲染约定：BS.renderWidget(widget, {mode:'display'|'editor'}) -> HTMLElement
 * 用户数据一律通过 textContent / DOM 属性写入，禁止 innerHTML 拼接。
 * ========================================================================== */
(function () {
  'use strict';

  var BS = window.BS = window.BS || {};

  var ICONS = {
    text: '<path d="M4 6h16M4 12h10M4 18h14"/>',
    table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11M15 9v11"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 15-5-5-6 6-3-3-4 4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    notice: '<path d="M4 10v4a1 1 0 0 0 1 1h2l4 4V5L7 9H5a1 1 0 0 0-1 1Z"/><path d="M15 8.5a5 5 0 0 1 0 7M18 6a8 8 0 0 1 0 12"/>'
  };

  BS.svgIcon = function (name, size) {
    var body = ICONS[name] || ICONS.text;
    return '<svg class="bs-icon" viewBox="0 0 24 24" width="' + (size || 20) + '" height="' + (size || 20) +
      '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';
  };

  /* ---------------- 组件类型元数据 ---------------- */

  BS.WIDGET_TYPES = [
    {
      type: 'text', label: '文本', desc: '多行文字 / 标题说明', w: 560, h: 240,
      style: { border: false, glow: false, padding: 8, radius: 0 },
      props: {
        content: '这里是文本内容，可自由换行、调整字号、颜色与对齐方式。',
        fontSize: 28, fontWeight: 400, align: 'left', lineHeight: 1.6, letterSpacing: 0, color: ''
      }
    },
    {
      type: 'table', label: '表格', desc: '指标 / 榜单 / 明细数据', w: 680, h: 380,
      style: { border: true, glow: false, padding: 24, radius: 0 },
      props: {
        columns: ['指标', '今日', '环比'],
        rows: [
          ['在线设备', '1,286', '+2.4%'],
          ['累计访问', '86,420', '+8.1%'],
          ['处理效率', '99.2%', '+0.3%']
        ],
        fontSize: 20, align: 'left', headerBg: '', striped: true
      }
    },
    {
      type: 'image', label: '图片', desc: '照片 / 海报 / 示意图', w: 560, h: 340,
      style: { border: true, glow: false, padding: 12, radius: 0 },
      props: { src: '', fit: 'cover', caption: '' }
    },
    {
      type: 'clock', label: '时钟', desc: '实时时间 / 日期', w: 560, h: 200,
      style: { border: false, glow: false, padding: 8, radius: 0 },
      props: {
        format: 'YYYY-MM-DD HH:mm:ss', showWeek: true, fontSize: 52,
        color: '', align: 'center', label: '', mode: 'digital'
      }
    },
    {
      type: 'notice', label: '滚动通知', desc: '跑马灯 / 值班信息', w: 1200, h: 72,
      style: { border: true, glow: false, padding: 0, radius: 0 },
      props: { content: '这里是一条滚动通知，请在右侧属性面板修改内容。', speed: 80, fontSize: 24, icon: true }
    }
  ];

  BS.widgetMeta = function (type) {
    for (var i = 0; i < BS.WIDGET_TYPES.length; i++) {
      if (BS.WIDGET_TYPES[i].type === type) return BS.WIDGET_TYPES[i];
    }
    return BS.WIDGET_TYPES[0];
  };

  BS.widgetLabel = function (type) { return BS.widgetMeta(type).label; };

  /** 组件对应的属性对象 */
  BS.widgetProps = function (w) {
    if (!w) return {};
    return w[w.type] || {};
  };

  /** 创建带默认属性的新组件 */
  BS.createWidget = function (type, index) {
    var meta = BS.widgetMeta(type);
    var n = index || 0;
    var props = BS.deepClone(meta.props);
    var w = {
      id: BS.uid(type),
      type: meta.type,
      x: 140 + (n % 5) * 48,
      y: 210 + (n % 5) * 48,
      w: meta.w,
      h: meta.h,
      z: 10 + n,
      title: '',
      style: Object.assign({ bg: '', color: '', border: false, glow: false, padding: 24, radius: 0 }, meta.style),
      text: null, table: null, image: null, clock: null, notice: null
    };
    w[meta.type] = props;
    return w;
  };

  /* ---------------- 渲染 ---------------- */

  function setCommonStyle(el, w) {
    var st = w.style || {};
    el.style.left = (Number(w.x) || 0) + 'px';
    el.style.top = (Number(w.y) || 0) + 'px';
    el.style.width = (Number(w.w) || 80) + 'px';
    el.style.height = (Number(w.h) || 40) + 'px';
    el.style.zIndex = String(Number(w.z) || 0);
    if (st.border) el.classList.add('has-border');
    if (st.glow) el.classList.add('has-glow');
    if (st.bg) {
      el.classList.add('has-bg');
      el.style.setProperty('--w-bg', st.bg);
    }
    if (st.radius > 0) el.style.setProperty('--w-radius', st.radius + 'px');
    if (st.color) el.style.setProperty('--w-color', st.color);
  }

  function buildText(w, mode) {
    var p = w.text || {};
    var el = document.createElement('div');
    el.className = 'text-content';
    el.style.fontSize = (p.fontSize || 26) + 'px';
    el.style.fontWeight = String(p.fontWeight || 400);
    el.style.textAlign = p.align || 'left';
    el.style.lineHeight = String(p.lineHeight || 1.5);
    el.style.letterSpacing = (p.letterSpacing || 0) + 'px';
    if (p.color) el.style.color = p.color;
    el.textContent = p.content || '';
    if (!p.content && mode === 'editor') {
      el.classList.add('is-empty');
      el.textContent = '空文本 · 在右侧输入内容';
    }
    return el;
  }

  function buildTable(w, mode) {
    var p = w.table || {};
    var cols = p.columns || [];
    var rows = p.rows || [];
    var wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    wrap.style.textAlign = p.align || 'left';

    // 根据组件高度自动微调字号，避免行数过多时溢出
    var titleH = w.title ? 44 : 0;
    var pad = (w.style && w.style.padding) || 0;
    var avail = Math.max(60, (w.h || 300) - pad * 2 - titleH - 24);
    var fs = p.fontSize || 20;
    var rowUnit = 2.05 * fs + 6;
    var needed = (rows.length + 1) * rowUnit;
    if (needed > avail) fs = Math.max(10, Math.floor(fs * avail / needed));
    wrap.style.fontSize = fs + 'px';

    var table = document.createElement('table');
    table.className = 'bs-table' + (p.striped ? ' is-striped' : '');
    var thead = document.createElement('thead');
    var trh = document.createElement('tr');
    for (var c = 0; c < cols.length; c++) {
      var th = document.createElement('th');
      th.textContent = cols[c];
      if (p.headerBg) th.style.background = p.headerBg;
      trh.appendChild(th);
    }
    thead.appendChild(trh);
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    for (var r = 0; r < rows.length; r++) {
      var tr = document.createElement('tr');
      for (var c2 = 0; c2 < cols.length; c2++) {
        var td = document.createElement('td');
        td.textContent = (rows[r] && rows[r][c2] != null) ? rows[r][c2] : '';
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    if (!rows.length && mode === 'editor') {
      var hint = document.createElement('div');
      hint.className = 'ed-widget-hint';
      hint.textContent = '在右侧添加表格行/列';
      wrap.appendChild(hint);
    }
    return wrap;
  }

  function buildImage(w, mode) {
    var p = w.image || {};
    var wrap = document.createElement('div');
    wrap.className = 'image-wrap';
    var src = BS.safeImageSrc(p.src);
    if (src) {
      var img = document.createElement('img');
      img.src = src;
      img.alt = p.caption || '';
      img.style.objectFit = p.fit || 'cover';
      img.draggable = false;
      wrap.appendChild(img);
    } else if (mode === 'editor') {
      var ph = document.createElement('div');
      ph.className = 'image-placeholder';
      ph.innerHTML = BS.svgIcon('image', 36) + '<span>在右侧上传图片或填写内网图片地址</span>';
      wrap.appendChild(ph);
    }
    var holder = document.createElement('div');
    holder.className = 'image-body';
    holder.appendChild(wrap);
    if (p.caption) {
      var cap = document.createElement('div');
      cap.className = 'image-caption';
      cap.textContent = p.caption;
      holder.appendChild(cap);
    }
    return holder;
  }

  function buildClock(w) {
    var p = w.clock || {};
    var box = document.createElement('div');
    box.className = 'clock-widget';
    box.style.textAlign = p.align || 'center';
    box.style.alignItems = p.align === 'left' ? 'flex-start' : (p.align === 'right' ? 'flex-end' : 'center');
    if (p.label) {
      var label = document.createElement('div');
      label.className = 'clock-label';
      label.textContent = p.label;
      box.appendChild(label);
    }
    var time = document.createElement('div');
    time.className = 'clock-time';
    time.style.fontSize = (p.fontSize || 44) + 'px';
    if (p.color) time.style.color = p.color;
    time.setAttribute('data-clock', p.format || 'YYYY-MM-DD HH:mm:ss');
    box.appendChild(time);
    if (p.showWeek) {
      var week = document.createElement('div');
      week.className = 'clock-week';
      week.setAttribute('data-clock-week', '1');
      box.appendChild(week);
    }
    return box;
  }

  function buildNotice(w, mode) {
    var p = w.notice || {};
    var box = document.createElement('div');
    box.className = 'notice-widget';
    if (p.icon !== false) {
      var icon = document.createElement('span');
      icon.className = 'notice-icon';
      icon.innerHTML = BS.svgIcon('notice', 22);
      box.appendChild(icon);
    }
    var viewport = document.createElement('div');
    viewport.className = 'notice-viewport';
    var track = document.createElement('div');
    track.className = 'notice-track';
    var content = p.content || '';
    if (!content && mode === 'editor') content = '空通知 · 在右侧输入内容';
    var width = 0;
    for (var i = 0; i < content.length; i++) width += /[\u4e00-\u9fa5\uff00-\uffef]/.test(content[i]) ? 1 : 0.58;
    var fontSize = p.fontSize || 22;
    var pad = (w.style && w.style.padding) || 0;
    var iconW = p.icon !== false ? 40 : 0;
    var available = (w.w || 1200) - pad * 2 - iconW;
    var contentWidth = width * fontSize;
    // 内容较短时静态居中展示，避免两段文字同时出现在视口内
    var isStatic = contentWidth <= available * 0.9;
    if (isStatic) track.classList.add('is-static');
    var duration = Math.max(6, contentWidth / (p.speed || 80));
    track.style.setProperty('--notice-duration', duration.toFixed(1) + 's');
    track.style.setProperty('--notice-font-size', fontSize + 'px');
    var copies = isStatic ? 1 : 2;
    for (var k = 0; k < copies; k++) {
      var item = document.createElement('span');
      item.className = 'notice-item';
      item.textContent = content;
      if (k === 1) item.setAttribute('aria-hidden', 'true');
      track.appendChild(item);
    }
    viewport.appendChild(track);
    box.appendChild(viewport);
    return box;
  }

  /**
   * 渲染单个组件
   * @param {object} w 组件数据
   * @param {{mode?:'display'|'editor'}} opts
   */
  BS.renderWidget = function (w, opts) {
    opts = opts || {};
    var mode = opts.mode || 'display';
    var el = document.createElement('div');
    el.className = 'widget widget-' + w.type;
    el.dataset.widgetId = w.id || '';
    setCommonStyle(el, w);

    var inner = document.createElement('div');
    inner.className = 'widget-inner';
    var st = w.style || {};
    inner.style.padding = (st.padding != null ? st.padding : 24) + 'px';
    el.appendChild(inner);

    if (w.title) {
      var title = document.createElement('div');
      title.className = 'widget-title';
      title.textContent = w.title;
      inner.appendChild(title);
    }

    var body = document.createElement('div');
    body.className = 'widget-body';

    switch (w.type) {
      case 'text': body.appendChild(buildText(w, mode)); break;
      case 'table': body.appendChild(buildTable(w, mode)); break;
      case 'image': body.appendChild(buildImage(w, mode)); break;
      case 'clock': body.appendChild(buildClock(w)); break;
      case 'notice': body.appendChild(buildNotice(w, mode)); break;
      default: break;
    }
    inner.appendChild(body);
    return el;
  };

  /** 渲染整个场景（按 z 升序），返回组件数量 */
  BS.renderScene = function (layerEl, scene, opts) {
    if (!layerEl) return 0;
    layerEl.textContent = '';
    var widgets = (scene && scene.widgets) || [];
    var sorted = widgets.map(function (w, i) { return { w: w, i: i }; })
      .sort(function (a, b) { return ((a.w.z || 0) - (b.w.z || 0)) || (a.i - b.i); });
    for (var i = 0; i < sorted.length; i++) {
      layerEl.appendChild(BS.renderWidget(sorted[i].w, opts));
    }
    BS.applySceneBackground(layerEl, scene);
    return sorted.length;
  };
})();
