/* ==========================================================================
 * BigScreen 共享前端工具库（display/editor 共用）
 * 纯原生 JS，无构建、无外网依赖。所有用户内容必须用 textContent 渲染。
 * ========================================================================== */
(function () {
  'use strict';

  var BS = window.BS = window.BS || {};

  // 兼容旧代码的默认设计尺寸；实际画布尺寸见 BS.canvasOf(config)
  BS.DESIGN_W = 1920;
  BS.DESIGN_H = 1080;
  BS.DEFAULT_CANVAS = { width: 1920, height: 1080 };
  BS.MIN_CANVAS = { width: 640, height: 360 };
  BS.MAX_CANVAS = { width: 7680, height: 4320 };

  /** 归一化画布尺寸（与服务端 model.go 保持一致） */
  BS.normalizeCanvas = function (canvas) {
    var w = Math.round(Number(canvas && canvas.width) || 0);
    var h = Math.round(Number(canvas && canvas.height) || 0);
    if (w <= 0) w = BS.DEFAULT_CANVAS.width;
    if (h <= 0) h = BS.DEFAULT_CANVAS.height;
    w = Math.min(BS.MAX_CANVAS.width, Math.max(BS.MIN_CANVAS.width, w));
    h = Math.min(BS.MAX_CANVAS.height, Math.max(BS.MIN_CANVAS.height, h));
    return { width: w, height: h };
  };

  /** 读取配置的设计画布尺寸 */
  BS.canvasOf = function (config) {
    return BS.normalizeCanvas(config && config.canvas);
  };

  /* ---------------- 基础工具 ---------------- */

  BS.uid = function (prefix) {
    return (prefix || 'id') + '-' +
      Math.random().toString(36).slice(2, 7) +
      Date.now().toString(36).slice(-4);
  };

  BS.pad2 = function (n) { return (n < 10 ? '0' : '') + n; };

  BS.clamp = function (v, lo, hi) { return Math.min(hi, Math.max(lo, v)); };

  BS.deepClone = function (obj) {
    if (window.structuredClone) { try { return structuredClone(obj); } catch (e) { /* fall */ } }
    return JSON.parse(JSON.stringify(obj));
  };

  BS.debounce = function (fn, ms) {
    var t = 0;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms || 120);
    };
  };

  /** 允许的外链图片协议，与服务端保持一致 */
  BS.safeImageSrc = function (src) {
    if (!src || typeof src !== 'string') return '';
    if ((src.indexOf('/uploads/') === 0 || src.indexOf('/assets/') === 0) && src.indexOf('..') === -1) return src;
    if (/^https?:\/\//i.test(src) && !/[\s"'<>]/.test(src)) return src;
    return '';
  };

  /* ---------------- 时间格式化 ---------------- */

  var WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];

  BS.fmtClock = function (date, format) {
    format = format || 'YYYY-MM-DD HH:mm:ss';
    var y = date.getFullYear(), M = date.getMonth() + 1, d = date.getDate();
    var h = date.getHours(), m = date.getMinutes(), s = date.getSeconds();
    var w = date.getDay();
    return format.replace(/YYYY|MM|DD|HH|mm|ss|dddd|ddd/g, function (tok) {
      switch (tok) {
        case 'YYYY': return String(y);
        case 'MM': return BS.pad2(M);
        case 'DD': return BS.pad2(d);
        case 'HH': return BS.pad2(h);
        case 'mm': return BS.pad2(m);
        case 'ss': return BS.pad2(s);
        case 'dddd': return '星期' + WEEK_CN[w];
        case 'ddd': return '周' + WEEK_CN[w];
        default: return tok;
      }
    });
  };

  BS.fmtUnix = function (ms) {
    var d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    return BS.fmtClock(d, 'YYYY-MM-DD HH:mm:ss');
  };

  /** 全局时钟循环：自动更新页面上所有 [data-clock] / [data-clock-week] 节点 */
  function tickClocks() {
    var now = new Date();
    var nodes = document.querySelectorAll('[data-clock]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      el.textContent = BS.fmtClock(now, el.getAttribute('data-clock') || 'HH:mm:ss');
    }
    var weeks = document.querySelectorAll('[data-clock-week]');
    for (var j = 0; j < weeks.length; j++) {
      weeks[j].textContent = '星期' + WEEK_CN[now.getDay()];
    }
  }
  BS.tickClocks = tickClocks;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { tickClocks(); setInterval(tickClocks, 500); });
    } else {
      tickClocks(); setInterval(tickClocks, 500);
    }
  }

  /* ---------------- HTTP / SSE ---------------- */

  /**
   * BS.api(path, {method, body, form, headers})
   * 返回解析后的 JSON/文本；非 2xx 抛出 err.status / err.data。
   */
  BS.api = function (path, options) {
    options = options || {};
    var init = {
      method: options.method || 'GET',
      credentials: 'same-origin',
      headers: Object.assign({ 'Accept': 'application/json' }, options.headers || {})
    };
    if (options.form !== undefined) {
      init.body = options.form;
    } else if (options.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    return fetch(path, init).then(function (res) {
      var ct = res.headers.get('content-type') || '';
      var parse = ct.indexOf('json') >= 0 ? res.json() : res.text();
      return parse.then(function (data) {
        if (!res.ok) {
          var msg = (data && data.error) || ('HTTP ' + res.status);
          var err = new Error(msg);
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  };

  /**
   * 订阅 SSE：BS.connectSSE(role, {hello,config,runtime,command,open,error})
   */
  BS.connectSSE = function (role, handlers) {
    handlers = handlers || {};
    var es = new EventSource('/api/events?role=' + encodeURIComponent(role || 'editor'));
    ['hello', 'config', 'runtime', 'command'].forEach(function (name) {
      es.addEventListener(name, function (ev) {
        var data;
        try { data = JSON.parse(ev.data); } catch (e) { return; }
        if (typeof handlers[name] === 'function') handlers[name](data);
      });
    });
    es.addEventListener('ping', function () { if (handlers.ping) handlers.ping(); });
    es.onopen = function () { if (handlers.open) handlers.open(); };
    es.onerror = function () { if (handlers.error) handlers.error(es.readyState); };
    return es;
  };

  /* ---------------- 轻提示 ---------------- */

  BS.toast = function (message, kind, duration) {
    var host = document.querySelector('.bs-toast-host');
    if (!host) {
      host = document.createElement('div');
      host.className = 'bs-toast-host';
      document.body.appendChild(host);
    }
    var el = document.createElement('div');
    el.className = 'bs-toast' + (kind ? ' bs-toast-' + kind : '');
    el.textContent = String(message);
    host.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('is-show'); });
    setTimeout(function () {
      el.classList.remove('is-show');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 260);
    }, duration || 2600);
  };

  /* ---------------- 画布等比缩放 ---------------- */

  /**
   * 把任意尺寸的 stage（默认取 stage 自身的宽高）等比缩放并居中放进 wrap。
   * 返回 {update, scale(), designW, designH}；stage 使用 transform-origin: top left。
   */
  BS.fitStage = function (wrapEl, stageEl, designW, designH) {
    function update() {
      var r = wrapEl.getBoundingClientRect();
      if (!r.width || !r.height) return;
      var dw = Number(designW) || Number(stageEl.dataset.canvasW) || parseFloat(stageEl.style.width) || BS.DEFAULT_CANVAS.width;
      var dh = Number(designH) || Number(stageEl.dataset.canvasH) || parseFloat(stageEl.style.height) || BS.DEFAULT_CANVAS.height;
      var scale = Math.min(r.width / dw, r.height / dh);
      stageEl.style.transform = 'scale(' + scale + ')';
      stageEl.style.left = Math.round((r.width - dw * scale) / 2) + 'px';
      stageEl.style.top = Math.round((r.height - dh * scale) / 2) + 'px';
      stageEl.dataset.scale = String(scale);
      stageEl.dataset.designW = String(dw);
      stageEl.dataset.designH = String(dh);
    }
    var ro = null;
    if (window.ResizeObserver) {
      ro = new ResizeObserver(update);
      ro.observe(wrapEl);
    }
    window.addEventListener('resize', update);
    update();
    return {
      update: update,
      scale: function () { return parseFloat(stageEl.dataset.scale || '1') || 1; },
      get designW() { return Number(stageEl.dataset.designW) || designW || BS.DEFAULT_CANVAS.width; },
      get designH() { return Number(stageEl.dataset.designH) || designH || BS.DEFAULT_CANVAS.height; },
      destroy: function () {
        if (ro) ro.disconnect();
        window.removeEventListener('resize', update);
      }
    };
  };

  /** 指针坐标 -> stage 设计坐标（支持任意画布尺寸） */
  BS.stagePoint = function (stageEl, ev) {
    var r = stageEl.getBoundingClientRect();
    var dw = Number(stageEl.dataset.canvasW) || parseFloat(stageEl.style.width) || BS.DEFAULT_CANVAS.width;
    var dh = Number(stageEl.dataset.canvasH) || parseFloat(stageEl.style.height) || BS.DEFAULT_CANVAS.height;
    var scale = r.width / dw || 1;
    return {
      x: (ev.clientX - r.left) / scale,
      y: (ev.clientY - r.top) / scale,
      scale: scale,
      designW: dw,
      designH: dh
    };
  };

  /* ---------------- 舞台骨架 ---------------- */

  /**
   * 舞台公共骨架（display 与 editor 的画布共用，保证所见即所得）。
   * 插入容器后使用 BS.applyStageConfig(stage, config) 应用标题/主题/进度条。
   */
  BS.stageSkeleton = function () {
    return '' +
      '<div class="stage" data-theme="tech">' +
      '  <div class="stage-deco" aria-hidden="true"></div>' +
      '  <header class="stage-header" hidden>' +
      '    <div class="stage-heading">' +
      '      <div class="stage-title-row">' +
      '        <span class="stage-title-deco"></span>' +
      '        <h1 class="stage-title"></h1>' +
      '        <span class="stage-title-deco is-right"></span>' +
      '      </div>' +
      '      <p class="stage-subtitle"></p>' +
      '    </div>' +
      '  </header>' +
      '  <div class="stage-scenes">' +
      '    <section class="scene-layer" data-layer="a"></section>' +
      '    <section class="scene-layer" data-layer="b"></section>' +
      '  </div>' +
      '  <div class="stage-progress" hidden><div class="stage-progress-bar"></div></div>' +
      '  <div class="stage-toasts" aria-live="polite"></div>' +
      '</div>';
  };

  /** 应用画布尺寸、标题、主题、进度条等舞台级配置 */
  BS.applyStageConfig = function (stageEl, config) {
    if (!stageEl || !config) return;
    var canvas = BS.canvasOf(config);
    stageEl.style.width = canvas.width + 'px';
    stageEl.style.height = canvas.height + 'px';
    stageEl.dataset.canvasW = String(canvas.width);
    stageEl.dataset.canvasH = String(canvas.height);
    stageEl.style.setProperty('--canvas-w', canvas.width + 'px');
    stageEl.style.setProperty('--canvas-h', canvas.height + 'px');
    stageEl.dataset.theme = config.theme || 'tech';
    var header = stageEl.querySelector('.stage-header');
    var titleEl = stageEl.querySelector('.stage-title');
    var subEl = stageEl.querySelector('.stage-subtitle');
    var hasTitle = !!(config.title && String(config.title).trim());
    if (header) header.hidden = !hasTitle;
    if (titleEl) titleEl.textContent = config.title || '';
    var sub = (config.subtitle || '').trim();
    if (subEl) {
      subEl.textContent = sub;
      subEl.hidden = !sub;
    }
    var progress = stageEl.querySelector('.stage-progress');
    if (progress) progress.hidden = !(config.rotation && config.rotation.showProgress);
  };

  /** 设置场景背景（layerEl 对应 .scene-layer） */
  BS.applySceneBackground = function (layerEl, scene) {
    if (!layerEl) return;
    var src = scene && BS.safeImageSrc(scene.background) || '';
    if (src) {
      layerEl.style.backgroundImage = 'url("' + src.replace(/"/g, '%22') + '")';
      layerEl.classList.add('has-scene-bg');
    } else {
      layerEl.style.backgroundImage = '';
      layerEl.classList.remove('has-scene-bg');
    }
  };

  /** 在舞台中显示一条提示（大屏通知/连接提示） */
  BS.stageToast = function (stageEl, message, kind, duration) {
    if (!stageEl) return;
    var host = stageEl.querySelector('.stage-toasts');
    if (!host) return;
    var el = document.createElement('div');
    el.className = 'stage-toast' + (kind ? ' stage-toast-' + kind : '');
    el.textContent = String(message);
    host.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('is-show'); });
    setTimeout(function () {
      el.classList.remove('is-show');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
    }, duration || 3200);
  };

  /* ---------------- 杂项 ---------------- */

  /** 元素查找简写 */
  BS.qs = function (sel, root) { return (root || document).querySelector(sel); };

  BS.byId = function (id) { return document.getElementById(id); };

  /** 从 URL 读取查询参数 */
  BS.query = function (name) {
    return new URLSearchParams(location.search).get(name);
  };
})();
