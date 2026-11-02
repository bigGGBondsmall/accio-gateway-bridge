/* Accio Bridge — UI core: shell, theme, routing, host polling.
   Globals on window.AB. No build step, no dependencies. */
window.AB = window.AB || {};

(function (AB) {
  'use strict';

  AB.UI_VERSION = '0.1.0';

  AB.views = {};
  AB.registerView = function (name, def) { AB.views[name] = def; };

  AB.NAV = [
    { id: 'overview', label: '概览', icon: 'overview' },
    { id: 'providers', label: '供应商', icon: 'providers' },
    { id: 'models', label: '模型', icon: 'models' },
    { id: 'gateway', label: '网关', icon: 'gateway' },
    { id: 'logs', label: '日志', icon: 'logs' },
    { id: 'test', label: '测试', icon: 'test' },
    { id: 'settings', label: '设置', icon: 'settings' }
  ];

  /* Host state mirrors GET /host/state (desktop/CONTRACT.md §2). */
  AB.state = {
    host: null,
    hostError: null,
    hostLoading: true,
    hostTimeout: false,
    gateway: { state: 'unknown', managed: true, pid: 0, port: 0, url: '', startedAt: '', lastError: '' },
    node: null,
    root: '',
    version: '',
    logFile: '',
    mock: false,
    scenario: ''
  };

  AB.HOST_POLL_MS = 3000;

  AB.reportError = function (err) {
    console.error('[accio-bridge-ui]', err);
  };

  /* ---------- formatting helpers ---------- */
  AB.fmt = {
    num: function (n) {
      if (n === null || n === undefined || isNaN(n)) return '—';
      return Number(n).toLocaleString('zh-CN');
    },
    contextWindow: function (n) {
      var v = Number(n);
      if (!v || v <= 0) return '—';
      if (v >= 1000000) return (v / 1000000).toFixed(v % 1000000 === 0 ? 0 : 1) + 'M';
      if (v >= 1000) return Math.round(v / 1000) + 'K';
      return String(v);
    },
    ms: function (v) {
      var n = Number(v);
      if (!n || n < 0) return '—';
      if (n < 1000) return Math.round(n) + ' ms';
      return (n / 1000).toFixed(n < 10000 ? 2 : 1) + ' s';
    },
    clockTime: function (iso) {
      if (!iso) return '—';
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '—';
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    },
    dateTime: function (iso) {
      if (!iso) return '—';
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '—';
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
        ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    },
    relative: function (iso) {
      if (!iso) return '从未';
      var t = new Date(iso).getTime();
      if (isNaN(t)) return '从未';
      var s = Math.max(0, Math.round((Date.now() - t) / 1000));
      if (s < 60) return s + ' 秒前';
      if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
      if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
      return Math.floor(s / 86400) + ' 天前';
    },
    uptime: function (iso) {
      if (!iso) return '';
      var t = new Date(iso).getTime();
      if (isNaN(t)) return '';
      var s = Math.max(0, Math.round((Date.now() - t) / 1000));
      if (s < 60) return s + ' 秒';
      if (s < 3600) return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
      return Math.floor(s / 3600) + ' 小时 ' + Math.floor((s % 3600) / 60) + ' 分';
    }
  };

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /* ---------- gateway helpers ---------- */
  AB.gatewayLabel = function (g) {
    g = g || {};
    switch (g.state) {
      case 'running':
        return '网关运行中' + (g.port ? ' :' + g.port : '');
      case 'starting':
        return '启动中…';
      case 'stopping':
        return '停止中…';
      case 'error':
        return '网关异常';
      case 'stopped':
        return '网关已停止';
      default:
        return '状态未知';
    }
  };

  AB.gatewayTone = function (g) {
    switch ((g || {}).state) {
      case 'running': return 'ok';
      case 'starting':
      case 'stopping': return 'accent';
      case 'error': return 'danger';
      case 'stopped': return 'muted';
      default: return 'muted';
    }
  };

  AB.gatewayStateText = function (g) {
    switch ((g || {}).state) {
      case 'running': return '运行中';
      case 'starting': return '启动中';
      case 'stopping': return '停止中';
      case 'error': return '异常';
      case 'stopped': return '已停止';
      default: return '未知';
    }
  };

  AB.gatewayDown = function () {
    var s = (AB.state.gateway || {}).state;
    return s !== 'running' && s !== 'starting';
  };

  AB.isGatewayDownError = function (err) {
    if (!err) return false;
    if (err.gatewayDown === true) return true;
    if (AB.gatewayDown() && (err.status === 503 || err.status === 502 || err.status === 504)) return true;
    return AB.gatewayDown() && err.network === true;
  };

  /* ---------- theme ---------- */
  AB.theme = (function () {
    var KEY = 'ab.theme';
    var VALID = { auto: 1, light: 1, dark: 1 };
    function get() {
      var v = null;
      try { v = window.localStorage.getItem(KEY); } catch (e) { v = null; }
      return VALID[v] ? v : 'auto';
    }
    function apply(v) {
      document.documentElement.setAttribute('data-theme', VALID[v] ? v : 'auto');
    }
    function set(v) {
      if (!VALID[v]) v = 'auto';
      try { window.localStorage.setItem(KEY, v); } catch (e) { /* storage unavailable */ }
      apply(v);
      return v;
    }
    return { get: get, set: set, apply: apply, options: ['auto', 'light', 'dark'] };
  })();

  /* ---------- router ---------- */
  var els = {};
  var current = null;
  var hostTimer = null;
  var hostPolling = false;

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      for (var k in props) {
        var v = props[k];
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'dataset') { for (var d in v) node.dataset[d] = v[d]; }
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'value') node.value = v;
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    AB.appendChildren(node, children);
    return node;
  }

  AB.appendChildren = function (node, children) {
    if (children === undefined || children === null || children === false) return;
    if (Array.isArray(children)) {
      children.forEach(function (c) { AB.appendChildren(node, c); });
      return;
    }
    if (children instanceof Node) { node.appendChild(children); return; }
    node.appendChild(document.createTextNode(String(children)));
  };

  AB.el = el;

  function viewFromHash() {
    var m = /^#\/?([a-zA-Z]+)/.exec(window.location.hash || '');
    var name = m ? m[1] : 'overview';
    return AB.views[name] ? name : 'overview';
  }

  AB.navigate = function (name) {
    if (!AB.views[name]) name = 'overview';
    if (window.location.hash === '#/' + name) showView(name, { force: true });
    else window.location.hash = '#/' + name;
  };

  function setActiveNav(name) {
    if (!els.navItems) return;
    els.navItems.forEach(function (btn) {
      var on = btn.dataset.view === name;
      btn.classList.toggle('is-active', on);
      if (on) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
  }

  function makeCtx(name) {
    var timers = [];
    var timeouts = [];
    var listeners = [];
    var disposers = [];

    return {
      name: name,
      state: AB.state,
      actions: els.headerActions,
      setActions: function (nodes) {
        els.headerActions.innerHTML = '';
        AB.appendChildren(els.headerActions, nodes);
      },
      /* timers tracked here are cleared on view teardown — no leaks across views */
      setInterval: function (fn, ms) {
        var id = window.setInterval(fn, ms);
        timers.push(id);
        return id;
      },
      setTimeout: function (fn, ms) {
        var id = window.setTimeout(fn, ms);
        timeouts.push(id);
        return id;
      },
      on: function (target, type, handler, opts) {
        target.addEventListener(type, handler, opts);
        listeners.push({ target: target, type: type, handler: handler, opts: opts });
      },
      dispose: function (fn) { disposers.push(fn); },
      _teardown: function () {
        timers.forEach(function (id) { window.clearInterval(id); });
        timeouts.forEach(function (id) { window.clearTimeout(id); });
        listeners.forEach(function (l) { l.target.removeEventListener(l.type, l.handler, l.opts); });
        disposers.forEach(function (fn) {
          try { fn(); } catch (e) { AB.reportError(e); }
        });
        timers = []; timeouts = []; listeners = []; disposers = [];
      }
    };
  }

  function teardown() {
    if (!current) return;
    current.alive = false;
    var ctx = current.ctx;
    if (current.handle && typeof current.handle.destroy === 'function') {
      try { current.handle.destroy(); } catch (e) { AB.reportError(e); }
    }
    try { ctx._teardown(); } catch (e) { AB.reportError(e); }
    if (AB.ui && AB.ui.closeAllLayers) AB.ui.closeAllLayers();
    current = null;
  }

  function showView(name, opts) {
    opts = opts || {};
    if (current && current.name === name && !opts.force) return;
    teardown();

    var def = AB.views[name];
    if (!def) { name = 'overview'; def = AB.views[name]; }

    var ctx = makeCtx(name);
    current = { name: name, def: def, ctx: ctx, handle: null, alive: true };

    els.viewTitle.textContent = def.title || '';
    document.title = 'Accio Bridge — ' + (def.title || '');
    els.headerActions.innerHTML = '';
    els.viewRoot.innerHTML = '';
    els.viewRoot.scrollTop = 0;
    setActiveNav(name);

    var mountResult;
    try {
      mountResult = def.mount(els.viewRoot, ctx);
    } catch (err) {
      AB.reportError(err);
      renderViewError(err, name);
      return;
    }
    if (mountResult && typeof mountResult.then === 'function') {
      mountResult.then(function (handle) {
        if (!current || current.name !== name || !current.alive) return;
        current.handle = handle || {};
      }, function (err) {
        if (!current || current.name !== name || !current.alive) return;
        AB.reportError(err);
        renderViewError(err, name);
      });
    } else {
      current.handle = mountResult || {};
    }
  }

  function renderViewError(err, name) {
    els.viewRoot.innerHTML = '';
    if (AB.ui && AB.ui.viewError) {
      els.viewRoot.appendChild(AB.ui.viewError(err, function () { showView(name, { force: true }); }));
    } else {
      els.viewRoot.textContent = '加载失败：' + (err && err.message ? err.message : String(err));
    }
  }

  /* ---------- host polling ---------- */
  function renderGatewayChip() {
    if (!els.gatewayChipText) return;
    var dot = els.gatewayDot;
    var text = els.gatewayChipText;
    dot.className = 'dot';
    if (AB.state.hostError) {
      dot.classList.add('dot-danger');
      text.textContent = '无法连接宿主服务';
      els.gatewayChip.title = AB.state.hostError.message || '宿主服务无响应';
      els.gatewayChip.setAttribute('aria-label', '宿主服务不可用，点击查看网关页');
      return;
    }
    if (AB.state.hostLoading) {
      text.textContent = '正在读取状态…';
      return;
    }
    var g = AB.state.gateway;
    var tone = AB.gatewayTone(g);
    dot.classList.add('dot-' + tone);
    if (g.state === 'starting' || g.state === 'stopping') dot.classList.add('is-pulse');
    text.textContent = AB.gatewayLabel(g);
    els.gatewayChip.title = AB.gatewayLabel(g) + (g.managed === false ? '（外部进程）' : '');
    els.gatewayChip.setAttribute('aria-label', AB.gatewayLabel(g) + '，打开网关页面');
  }

  function applyHostState(data) {
    var prevGateway = AB.state.gateway.state;
    var hadError = !!AB.state.hostError;

    AB.state.host = data;
    AB.state.hostError = null;
    AB.state.hostLoading = false;
    AB.state.version = data.version || AB.state.version;
    AB.state.root = data.root || AB.state.root;
    AB.state.logFile = data.logFile || AB.state.logFile;
    AB.state.node = data.node || AB.state.node;
    if (data.gateway) AB.state.gateway = data.gateway;

    renderGatewayChip();

    if (current && current.handle) {
      var h = current.handle;
      if (typeof h.update === 'function') {
        try { h.update(AB.state); } catch (e) { AB.reportError(e); }
      }
      if (prevGateway !== AB.state.gateway.state && typeof h.onGatewayChange === 'function') {
        try { h.onGatewayChange(prevGateway, AB.state.gateway.state); } catch (e) { AB.reportError(e); }
      }
      if (hadError && typeof h.onHostRecover === 'function') {
        try { h.onHostRecover(); } catch (e) { AB.reportError(e); }
      }
    }
  }

  AB.refreshHost = function () {
    if (AB.state.mock && AB.mock && AB.mock.flushLogs) AB.mock.flushLogs();
    return pollHost();
  };

  function pollHost() {
    if (hostPolling) return Promise.resolve();
    hostPolling = true;
    return AB.api.getState().then(function (data) {
      hostPolling = false;
      applyHostState(data);
    }, function (err) {
      hostPolling = false;
      var wasError = !!AB.state.hostError;
      AB.state.hostError = err;
      AB.state.hostLoading = false;
      renderGatewayChip();
      if (!wasError && current && current.handle && typeof current.handle.onHostError === 'function') {
        try { current.handle.onHostError(err); } catch (e) { AB.reportError(e); }
      }
    });
  }

  /* ---------- mock banner ---------- */
  function insertMockBanner() {
    if (!AB.state.mock) return;
    var label = '演示数据（mock）：未连接真实网关，本页显示的是内存模拟数据。';
    if (AB.state.scenario) label += ' 模拟场景：' + scenarioLabel(AB.state.scenario) + '。';
    var banner = el('div', { class: 'mock-banner', role: 'note' }, [
      AB.icon('info', 14),
      el('span', { text: label })
    ]);
    var main = document.querySelector('.main');
    if (main && els.viewRoot) main.insertBefore(banner, els.viewRoot);
  }

  function scenarioLabel(s) {
    switch (s) {
      case 'stopped': return '网关已停止';
      case 'noaccio': return '未安装 Accio';
      case 'empty': return '没有供应商';
      case 'error': return '接口失败';
      default: return s;
    }
  }

  /* ---------- boot ---------- */
  function buildNav() {
    els.nav.innerHTML = '';
    els.navItems = [];
    AB.NAV.forEach(function (item) {
      var btn = el('button', {
        type: 'button',
        class: 'nav-item',
        dataset: { view: item.id },
        onclick: function () { AB.navigate(item.id); }
      }, [AB.icon(item.icon, 15), el('span', { text: item.label })]);
      els.nav.appendChild(btn);
      els.navItems.push(btn);
    });
  }

  function start() {
    els.app = document.getElementById('app');
    els.nav = document.getElementById('nav');
    els.gatewayChip = document.getElementById('gatewayChip');
    els.gatewayChipText = document.getElementById('gatewayChipText');
    els.gatewayDot = document.getElementById('gatewayDot');
    els.viewTitle = document.getElementById('viewTitle');
    els.headerActions = document.getElementById('headerActions');
    els.viewRoot = document.getElementById('viewRoot');
    els.brandMark = document.getElementById('brandMark');

    AB.state.mock = !!(AB.mock && AB.mock.enabled());
    AB.state.scenario = AB.state.mock && AB.mock.scenario ? AB.mock.scenario() : '';

    AB.theme.apply(AB.theme.get());
    els.brandMark.appendChild(AB.icon('brand', 13));

    AB.ui.init({
      layer: document.getElementById('layer'),
      toastStack: document.getElementById('toastStack')
    });

    buildNav();
    setActiveNav(viewFromHash());
    insertMockBanner();

    els.gatewayChip.addEventListener('click', function () { AB.navigate('gateway'); });
    window.addEventListener('hashchange', function () { showView(viewFromHash(), { force: true }); });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) pollHost();
    });

    renderGatewayChip();
    showView(viewFromHash(), { force: true });
    pollHost();
    if (hostTimer) window.clearInterval(hostTimer);
    hostTimer = window.setInterval(function () {
      if (!document.hidden) pollHost();
    }, AB.HOST_POLL_MS);
  }

  AB.start = start;
  AB.showView = showView;

  /* defer 脚本执行时 readyState 已是 'interactive'，此时 ui/icons/views 还没加载，
     必须等到 DOMContentLoaded 再启动（只有页面已经 complete 时才立即启动）。 */
  if (document.readyState === 'complete') {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start);
  }
})(window.AB);