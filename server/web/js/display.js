/* ==========================================================================
 * BigScreen 大屏展示端（display）
 * 职责：舞台缩放 / 服务端权威轮播 / 双 scene-layer 过渡 / SSE 远程控制
 * 依赖：util.js（BS.*）、widgets.js（BS.renderScene）
 * 约束：只用 textContent 写用户内容；动画只用 transform/opacity。
 * ========================================================================== */
(function () {
  'use strict';

  var BS = window.BS;

  var TRANSITION_MS = 760;   // 与 display.css 中场景动画时长保持一致
  var IDLE_MS = 3000;        // 鼠标静止 3s 后隐藏控制条与光标
  var RECONNECT_MS = 4000;

  var state = {
    config: null,
    configRev: -1,
    canvasKey: '',
    runtime: null,
    mounted: false,
    hasRendered: false,
    renderedScene: -1,
    serverScene: 0,
    pinnedScene: null,
    activeKey: 'a',
    playing: true,
    progress: 0,
    progressFreeze: 0,
    clockOffset: 0,
    kiosk: false,
    everConnected: false,
    connected: false,
    displays: 0,
    switchTimer: 0,
    rafId: 0,
    lastProgress: -1,
    idleTimer: 0,
    bootFailures: 0,
    reloading: false
  };

  var el = {};

  /* ---------------- 基础 ---------------- */

  function nowServer() { return Date.now() + state.clockOffset; }

  function sceneList() { return (state.config && state.config.scenes) || []; }

  function clampSceneIndex(i) {
    var n = sceneList().length;
    if (!n) return 0;
    i = Math.round(Number(i) || 0);
    return BS.clamp(i, 0, n - 1);
  }

  function syncClockOffset(serverTime) {
    if (!serverTime || !isFinite(Number(serverTime))) return;
    state.clockOffset = Number(serverTime) - Date.now();
  }

  /* ---------------- 启动遮罩 ---------------- */

  function setBootText(main, sub) {
    if (el.bootText && main) el.bootText.textContent = main;
    if (el.bootSub && sub != null) el.bootSub.textContent = sub;
  }

  function hideBoot() {
    if (!el.boot) return;
    el.boot.hidden = true;
    if (el.stageFit) el.stageFit.classList.add('is-ready');
  }

  function showBoot(main, sub) {
    if (!el.boot) return;
    el.boot.hidden = false;
    if (el.stageFit) el.stageFit.classList.remove('is-ready');
    setBootText(main, sub);
    if (el.bootRing) el.bootRing.classList.remove('is-error');
  }

  /* ---------------- 舞台挂载 ---------------- */

  function mountStage(config) {
    if (el.stageFit) el.stageFit.innerHTML = BS.stageSkeleton();
    var stage = el.stageFit.querySelector('.stage');
    if (!stage) return;
    state.stage = stage;
    stage.dataset.transition = 'fade';
    BS.applyStageConfig(stage, config);
    state.layers = {
      a: stage.querySelector('.scene-layer[data-layer="a"]'),
      b: stage.querySelector('.scene-layer[data-layer="b"]')
    };
    state.scenesWrap = stage.querySelector('.stage-scenes');
    state.progressEl = stage.querySelector('.stage-progress');
    state.progressBar = stage.querySelector('.stage-progress-bar');
    state.fit = BS.fitStage(el.stageFit, stage);
    state.mounted = true;
    applyChrome(config);
    syncLetterbox();
    bindControls();
    bindIdle();
    startProgressLoop();
    // 入场淡入
    requestAnimationFrame(function () { el.stageFit.classList.add('is-ready'); });
  }

  function applyChrome(config) {
    var theme = (config && config.theme) || 'tech';
    document.body.setAttribute('data-theme', theme);
    if (config && config.title) document.title = config.title + ' · 大屏看板';
    else document.title = '大屏看板';
  }

  /**
   * letterbox 留边延续主题背景：把 .stage 计算后的主题背景层同步到 .stage-fit，
   * 这样窗口比例与画布比例不一致时，黑边也是主题底纹而不是突兀纯黑。
   */
  function syncLetterbox() {
    if (!state.stage || !el.stageFit) return;
    var cs = window.getComputedStyle(state.stage);
    if (!cs) return;
    el.stageFit.style.backgroundImage = cs.backgroundImage || '';
    el.stageFit.style.backgroundColor = cs.backgroundColor || '';
    el.stageFit.style.backgroundSize = cs.backgroundSize || 'auto';
    el.stageFit.style.backgroundPosition = cs.backgroundPosition || '0% 0%';
    el.stageFit.style.backgroundRepeat = cs.backgroundRepeat || 'repeat';
  }

  /* ---------------- 配置 / 运行态消费 ---------------- */

  /**
   * 写入配置（首次挂载 or config 事件）
   * @param {object} cfg Dashboard
   * @param {object} rt  Runtime
   */
  function consumeConfig(cfg, rt) {
    if (!cfg) return;
    var first = !state.mounted;
    if (first) mountStage(cfg);

    // 任意画布比例：config.canvas 变化时重新应用舞台尺寸并重新贴合窗口
    var canvas = BS.canvasOf(cfg);
    var canvasKey = canvas.width + 'x' + canvas.height;
    var canvasChanged = !first && state.canvasKey !== canvasKey;

    var revChanged = (cfg.rev !== state.configRev) || !state.hasRendered;
    state.config = cfg;
    state.configRev = cfg.rev;
    state.canvasKey = canvasKey;
    BS.applyStageConfig(state.stage, cfg);
    applyChrome(cfg);
    syncLetterbox();
    if (canvasChanged && state.fit) state.fit.update();

    if (rt) {
      state.runtime = rt;
      syncClockOffset(rt.serverTime);
    }

    var scenes = sceneList();

    if (first) {
      state.serverScene = clampSceneIndex(rt ? rt.scene : 0);
      var idx = state.serverScene;
      // ?scene=N：仅首次定位（0 基，与 runtime.scene 一致），服务端推进场景后自动接管
      var qs = parseInt(BS.query('scene'), 10);
      if (isFinite(qs) && qs >= 0 && scenes.length) {
        state.pinnedScene = clampSceneIndex(qs);
        idx = state.pinnedScene;
      }
      renderDirect(idx);
      state.hasRendered = true;
      updatePlaying(rt ? rt.playing !== false : true);
      refreshSceneLabel();
      refreshProgress();
      return;
    }

    var target = state.renderedScene;
    if (target < 0 || target >= scenes.length) target = clampSceneIndex(rt ? rt.scene : 0);

    if (revChanged || canvasChanged) {
      // 配置保存/模板切换/画布比例变化：直接重绘当前层（无过渡动画），并按服务端运行态校正场景
      var renderIdx = target;
      if (state.pinnedScene != null) renderIdx = clampSceneIndex(state.pinnedScene);
      else if (rt) renderIdx = clampSceneIndex(rt.scene);
      stopTransition();
      renderDirect(renderIdx);
    }

    if (rt) {
      // config 事件同样携带 runtime：同步播放状态、在线数与服务端权威场景
      state.runtime = rt;
      updatePlaying(rt.playing !== false);
      updateDisplays(rt.displays);
      state.serverScene = clampSceneIndex(rt.scene);
      if (state.pinnedScene == null && state.serverScene !== state.renderedScene) {
        stopTransition();
        renderDirect(state.serverScene);
      }
    }
    refreshSceneLabel();
    refreshProgress();
  }

  /**
   * 写入运行态（runtime / command 事件）
   */
  function consumeRuntime(rt, opts) {
    if (!rt || !state.config) return;
    opts = opts || {};
    var scenes = sceneList();
    if (!scenes.length) return;

    var prevServerScene = state.serverScene;
    var sceneChanged = (rt.scene !== prevServerScene);

    // 服务端 pause 会把 sceneStartedAt 重置为当前时刻，必须在切换 runtime 前
    // 用旧时钟冻结住当前进度，否则进度条会瞬间归零。
    var frozenOnPause = null;
    if (state.playing && rt.playing === false) frozenOnPause = rawProgress();

    state.runtime = rt;
    updatePlaying(rt.playing !== false);
    if (frozenOnPause != null) state.progressFreeze = frozenOnPause;
    updateDisplays(rt.displays);

    if (state.pinnedScene != null) {
      // ?scene=N 首屏钉住，直到服务端真正切换场景
      if (!sceneChanged) { refreshProgress(); return; }
      state.pinnedScene = null;
    }

    var idx = clampSceneIndex(rt.scene);
    state.serverScene = idx;

    if (sceneChanged || opts.force) {
      var trans = opts.transition ||
        (state.config.rotation && state.config.rotation.transition) || 'fade';
      var direction = opts.direction;
      if (direction == null) direction = idx > state.renderedScene ? 1 : (idx < state.renderedScene ? -1 : 1);
      switchScene(idx, trans, direction);
    } else {
      refreshSceneLabel();
      refreshProgress();
    }
  }

  /* ---------------- 场景渲染与过渡 ---------------- */

  function buildEmpty(layerEl) {
    var box = document.createElement('div');
    box.className = 'scene-empty';
    var icon = document.createElement('div');
    icon.className = 'scene-empty-icon';
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 9h18M9 9v9"/></svg>';
    box.appendChild(icon);
    var t = document.createElement('div');
    t.className = 'scene-empty-title';
    t.textContent = '本场景暂无内容';
    box.appendChild(t);
    var s = document.createElement('div');
    s.className = 'scene-empty-sub';
    s.textContent = '请在编辑器中添加组件，保存后大屏自动刷新';
    box.appendChild(s);
    layerEl.appendChild(box);
  }

  function renderLayer(layerEl, idx) {
    var scenes = sceneList();
    var scene = scenes[idx];
    BS.renderScene(layerEl, scene || { widgets: [] }, { mode: 'display' });
    if (!scene || !scene.widgets || !scene.widgets.length) buildEmpty(layerEl);
  }

  /** 直接把场景画进当前活动层（无过渡），用于初始化/配置更新 */
  function renderDirect(idx) {
    if (!state.mounted) return;
    idx = clampSceneIndex(idx);
    var layerEl = state.layers[state.activeKey];
    if (!layerEl) return;
    renderLayer(layerEl, idx);
    layerEl.classList.add('is-active');
    var other = state.layers[state.activeKey === 'a' ? 'b' : 'a'];
    if (other) other.classList.remove('is-active');
    layerEl.style.removeProperty('--slide-from');
    layerEl.style.removeProperty('--slide-to');
    state.renderedScene = idx;
    syncProgressOrigin();
  }

  function stopTransition() {
    if (state.switchTimer) { clearTimeout(state.switchTimer); state.switchTimer = 0; }
    ['a', 'b'].forEach(function (key) {
      var layer = state.layers && state.layers[key];
      if (!layer) return;
      layer.classList.remove('is-anim-in', 'is-anim-out');
      layer.removeAttribute('data-transition');
      if (key !== state.activeKey) layer.classList.remove('is-active');
    });
  }

  /**
   * 双缓冲切换：incoming 渲染新场景并播放 CSS 过渡，outgoing 淡出后隐藏。
   */
  function switchScene(idx, transition, direction) {
    if (!state.mounted) return;
    idx = clampSceneIndex(idx);
    if (idx === state.renderedScene) { refreshSceneLabel(); syncProgressOrigin(); return; }
    stopTransition();

    var scenes = sceneList();
    var scene = scenes[idx];
    var fromKey = state.activeKey;
    var toKey = fromKey === 'a' ? 'b' : 'a';
    var fromEl = state.layers[fromKey];
    var toEl = state.layers[toKey];
    if (!fromEl || !toEl) return;

    renderLayer(toEl, idx);
    toEl.style.removeProperty('--slide-from');
    toEl.style.removeProperty('--slide-to');
    fromEl.style.removeProperty('--slide-from');
    fromEl.style.removeProperty('--slide-to');

    var mode = transition || 'fade';
    if (mode !== 'slide' && mode !== 'zoom' && mode !== 'none') mode = 'fade';

    state.activeKey = toKey;
    state.renderedScene = idx;

    if (mode === 'none') {
      fromEl.classList.remove('is-active');
      toEl.classList.add('is-active');
      finishSwitch(fromEl, toEl);
    } else {
      var dir = direction || 1;
      // 位移方向：新场景从运动方向外侧进入，旧场景反向退出
      toEl.style.setProperty('--slide-from', (dir > 0 ? '7%' : '-7%'));
      fromEl.style.setProperty('--slide-to', (dir > 0 ? '-7%' : '7%'));
      toEl.dataset.transition = mode;
      fromEl.dataset.transition = mode;
      toEl.classList.add('is-active');
      fromEl.classList.add('is-active');
      // 强制 reflow 后再触发动画，保证首帧从起始态开始
      void toEl.offsetWidth;
      toEl.classList.add('is-anim-in');
      fromEl.classList.add('is-anim-out');
      state.switchTimer = setTimeout(function () {
        state.switchTimer = 0;
        finishSwitch(fromEl, toEl);
      }, TRANSITION_MS + 40);
    }
    refreshSceneLabel();
    syncProgressOrigin();
  }

  function finishSwitch(fromEl, toEl) {
    if (!fromEl || !toEl) return;
    fromEl.classList.remove('is-active', 'is-anim-in', 'is-anim-out');
    fromEl.removeAttribute('data-transition');
    toEl.classList.remove('is-anim-in', 'is-anim-out');
    toEl.removeAttribute('data-transition');
    toEl.classList.add('is-active');
  }

  /* ---------------- 进度条 ---------------- */

  function sceneDurationMs() {
    var rt = state.runtime;
    var rot = (state.config && state.config.rotation) || {};
    var sec = rt && rt.duration > 0 ? rt.duration : (rot.interval || 10);
    return Math.max(1, sec) * 1000;
  }

  function syncProgressOrigin() {
    state.lastProgress = -1;
    refreshProgress();
  }

  function progressVisible() {
    if (!state.config) return false;
    var rot = state.config.rotation || {};
    return !!rot.showProgress && sceneList().length > 1;
  }

  function refreshProgress() {
    if (!state.progressEl) return;
    var visible = progressVisible();
    state.progressEl.hidden = !visible;
    if (!visible) return;
    var p = computeProgress();
    state.progress = p;
    updateProgressBar(p);
  }

  /** 按服务端时钟计算进度（不受 playing 影响） */
  function rawProgress() {
    var rt = state.runtime;
    if (!rt || !rt.sceneStartedAt) return state.progress || 0;
    var elapsed = nowServer() - Number(rt.sceneStartedAt);
    if (elapsed < 0) elapsed = 0;
    return BS.clamp(elapsed / sceneDurationMs(), 0, 1);
  }

  function computeProgress() {
    if (!state.runtime) return 0;
    return state.runtime.playing ? rawProgress() : state.progressFreeze;
  }

  function updateProgressBar(p) {
    if (!state.progressBar) return;
    p = BS.clamp(p, 0, 1);
    if (Math.abs(p - state.lastProgress) < 0.0004 && p !== 0 && p !== 1) return;
    state.lastProgress = p;
    state.progressBar.style.transform = 'scaleX(' + p.toFixed(4) + ')';
  }

  function startProgressLoop() {
    if (state.rafId) cancelAnimationFrame(state.rafId);
    function frame() {
      state.rafId = requestAnimationFrame(frame);
      if (!state.mounted || !progressVisible()) return;
      if (!state.playing) return;
      updateProgressBar(computeProgress());
    }
    state.rafId = requestAnimationFrame(frame);
  }

  /* ---------------- 播放状态 / UI ---------------- */

  function updatePlaying(playing) {
    var next = playing !== false;
    if (state.playing && !next) {
      state.progressFreeze = rawProgress();
    }
    state.playing = next;
    if (el.controls) {
      el.controls.classList.toggle('is-paused', !next);
      var btn = el.controls.querySelector('[data-act="toggle"]');
      if (btn) {
        btn.title = next ? '暂停轮播' : '继续轮播';
        btn.setAttribute('aria-label', next ? '暂停轮播' : '继续轮播');
        btn.setAttribute('aria-pressed', next ? 'false' : 'true');
      }
    }
    if (next) refreshProgress();
  }

  function updateDisplays(n) {
    state.displays = Number(n) || 0;
    if (state.connected) updateConnOnline();
  }

  function refreshSceneLabel() {
    if (!el.sceneLabel) return;
    var scenes = sceneList();
    var idx = state.renderedScene;
    var name = (scenes[idx] && scenes[idx].name) || '';
    el.sceneLabel.textContent = (idx + 1) + ' / ' + scenes.length + (name ? ' · ' + name : '');
  }

  /* ---------------- 连接状态 ---------------- */

  function connText(connected, reconnecting) {
    if (!el.conn || !el.connText) return;
    if (connected) {
      var txt = '已连接';
      if (state.displays > 0) txt += ' · ' + state.displays + ' 台大屏在线';
      el.connText.textContent = txt;
      el.conn.classList.remove('is-offline');
      el.conn.classList.add('is-online');
      el.conn.hidden = state.kiosk;
    } else {
      el.connText.textContent = reconnecting ? '连接中断 · 正在自动重连…' : '正在连接大屏服务…';
      el.conn.classList.remove('is-online');
      el.conn.classList.add('is-offline');
      el.conn.hidden = false;
    }
  }

  function updateConnOnline() { connText(true, false); }

  function setConnected(ok, reconnecting) {
    var was = state.connected;
    state.connected = !!ok;
    if (ok) {
      state.everConnected = true;
      connText(true, false);
      if (!was && state.everConnected && el.stage && state.hasRendered) {
        // 重连成功提示（首次连接不提示）
        if (state.reconnectNoticed) {
          BS.stageToast(state.stage, '已重新连接，配置同步完成', 'ok', 2600);
          state.reconnectNoticed = false;
        }
      }
    } else {
      state.reconnectNoticed = state.hasRendered;
      connText(false, !!reconnecting || state.everConnected);
    }
  }

  /* ---------------- 远程命令 ---------------- */

  function handleCommand(data) {
    if (!data || !data.action) return;
    if (data.serverTime) syncClockOffset(data.serverTime);
    var action = data.action;

    if (action === 'reload') {
      var msg = data.message || '大屏配置已更新，即将刷新…';
      if (state.stage) BS.stageToast(state.stage, msg, 'ok', 1800);
      if (!state.reloading) {
        state.reloading = true;
        setTimeout(function () { location.reload(); }, 900);
      }
      if (data.runtime) consumeRuntime(data.runtime, { force: false, transition: 'none' });
      return;
    }

    if (action === 'notify') {
      if (data.message && state.stage) BS.stageToast(state.stage, data.message, 'ok', 4600);
      if (data.runtime) consumeRuntime(data.runtime, { transition: 'none' });
      return;
    }

    if (data.runtime) {
      var trans = null;
      if (action === 'next' || action === 'prev' || action === 'goto' || action === 'auto') trans = null;
      consumeRuntime(data.runtime, { transition: trans });
    }
  }

  /* ---------------- 控制条 ---------------- */

  function controlRemote(action) {
    var body = { action: action };
    return BS.api('/api/control', { method: 'POST', body: body }).then(function (res) {
      if (res && res.runtime) consumeRuntime(res.runtime, { transition: null });
      return true;
    }).catch(function (err) {
      // 需要鉴权或服务异常时，退化为本机预览操作，不打断大屏画面
      if (err && err.status === 401) {
        localPreviewControl(action);
      } else {
        localPreviewControl(action);
      }
      return false;
    });
  }

  function localPreviewControl(action) {
    if (!state.config) return;
    var scenes = sceneList();
    if (!scenes.length) return;
    var rt = BS.deepClone(state.runtime || {
      playing: true, scene: 0, duration: 10,
      sceneStartedAt: nowServer(), displays: 0, editors: 0
    });
    if (action === 'next' || action === 'prev') {
      var step = action === 'next' ? 1 : -1;
      var idx = (clampSceneIndex(rt.scene) + step + scenes.length) % scenes.length;
      var fake = {
        playing: rt.playing, scene: idx,
        duration: state.config.rotation.interval || 10,
        sceneStartedAt: nowServer(), displays: rt.displays, editors: rt.editors
      };
      state.runtime = fake;
      state.pinnedScene = null;
      state.serverScene = idx;
      switchScene(idx, state.config.rotation.transition || 'fade', step);
    } else if (action === 'toggle' || action === 'play' || action === 'pause') {
      var playing = action === 'toggle' ? !(rt.playing !== false) : (action === 'play');
      rt.playing = playing;
      state.runtime = rt;
      updatePlaying(playing);
      if (playing) {
        rt.sceneStartedAt = nowServer() - state.progressFreeze * sceneDurationMs();
      } else {
        state.progressFreeze = computeProgress();
      }
    } else if (action === 'reload') {
      location.reload();
    }
  }

  function bindControls() {
    if (!el.controls || el.controls.dataset.bound === '1') return;
    el.controls.dataset.bound = '1';
    el.controls.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      if (act === 'fullscreen') { toggleFullscreen(); return; }
      if (act === 'reload') { location.reload(); return; }
      controlRemote(act);
    });

    document.addEventListener('fullscreenchange', function () {
      var on = !!document.fullscreenElement;
      if (el.controls) el.controls.classList.toggle('is-fullscreen', on);
      var btn = el.controls && el.controls.querySelector('[data-act="fullscreen"]');
      if (btn) btn.title = on ? '退出全屏' : '全屏';
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && el.controls) el.controls.classList.remove('is-fullscreen');
    });
  }

  function toggleFullscreen() {
    var doc = document;
    var root = doc.documentElement;
    try {
      if (!doc.fullscreenElement && !doc.webkitFullscreenElement) {
        var p = root.requestFullscreen ? root.requestFullscreen() :
          (root.webkitRequestFullscreen ? root.webkitRequestFullscreen() : null);
        if (p && p.catch) p.catch(function () { BS.toast('当前浏览器不允许全屏', 'error'); });
      } else {
        if (doc.exitFullscreen) doc.exitFullscreen();
        else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen();
      }
    } catch (e) { /* 忽略 */ }
  }

  /* ---------------- 鼠标静止隐藏 / kiosk ---------------- */

  function bindIdle() {
    if (state.kiosk) {
      document.body.classList.add('is-kiosk');
      return;
    }
    function wake() {
      document.body.classList.remove('is-idle');
      if (el.controls) el.controls.classList.remove('is-idle');
      clearTimeout(state.idleTimer);
      state.idleTimer = setTimeout(function () {
        document.body.classList.add('is-idle');
        if (el.controls) el.controls.classList.add('is-idle');
      }, IDLE_MS);
    }
    document.addEventListener('mousemove', wake, { passive: true });
    document.addEventListener('mousedown', wake, { passive: true });
    document.addEventListener('touchstart', wake, { passive: true });
    wake();
  }

  /* ---------------- 加载 & SSE ---------------- */

  function loadConfig() {
    BS.api('/api/config').then(function (data) {
      if (!data || !data.config) throw new Error('配置为空');
      hideBoot();
      if (data.runtime && data.runtime.serverTime) syncClockOffset(data.runtime.serverTime);
      consumeConfig(data.config, data.runtime);
    }).catch(function (err) {
      state.bootFailures++;
      var msg = (err && err.message) ? err.message : '网络错误';
      showBoot('无法加载大屏配置（' + msg + '）', '正在自动重试…');
      if (el.bootRing) el.bootRing.classList.add('is-error');
      setTimeout(loadConfig, RECONNECT_MS);
    });
  }

  function connect() {
    BS.connectSSE('display', {
      open: function () {
        if (state.hasRendered) setConnected(true, false);
        else connText(false, false);
      },
      hello: function (data) {
        if (!data) return;
        syncClockOffset(data.serverTime);
        hideBoot();
        consumeConfig(data.config, data.runtime);
        setConnected(true, false);
      },
      config: function (data) {
        if (!data || !data.config) return;
        consumeConfig(data.config, data.runtime);
      },
      runtime: function (data) {
        if (!data || !data.runtime) return;
        consumeRuntime(data.runtime, { transition: null });
      },
      command: handleCommand,
      error: function () {
        setConnected(false, true);
        // EventSource 会自动重连；兜底做一次配置拉取，防止事件丢失
        setTimeout(function () {
          if (!state.connected) loadConfig();
        }, RECONNECT_MS + 1200);
      }
    });
  }

  /* ---------------- 启动 ---------------- */

  function init() {
    el.stageFit = document.getElementById('stageFit');
    el.boot = document.getElementById('boot');
    el.bootText = document.getElementById('bootText');
    el.bootSub = document.getElementById('bootSub');
    el.bootRing = document.querySelector('.display-boot-ring');
    el.conn = document.getElementById('conn');
    el.connText = document.getElementById('connText');
    el.controls = document.getElementById('controls');
    el.sceneLabel = document.getElementById('sceneLabel');

    var kiosk = BS.query('kiosk');
    state.kiosk = !!(kiosk && kiosk !== '0' && kiosk !== 'false');
    if (state.kiosk) document.body.classList.add('is-kiosk');

    loadConfig();
    connect();

    window.addEventListener('resize', function () {
      if (state.fit) state.fit.update();
    });

    window.addEventListener('beforeunload', function () {
      if (state.rafId) cancelAnimationFrame(state.rafId);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
