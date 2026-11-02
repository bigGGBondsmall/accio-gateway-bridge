/* Accio Bridge — shared UI primitives: overlays (drawer/dialog), toast, form
   controls, and the empty / error / gateway-down states.

   Every piece of dynamic text goes through textContent (via AB.el) — never
   innerHTML — so model names, log lines and upstream errors cannot inject markup. */
window.AB = window.AB || {};

(function (AB) {
  'use strict';

  var el = AB.el;

  var refs = { layer: null, toastStack: null };
  var layers = [];
  var appRoot = null;

  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),' +
    'select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  function init(options) {
    refs.layer = options.layer;
    refs.toastStack = options.toastStack;
    appRoot = document.querySelector('.app');
  }

  function focusables(panel) {
    var nodes = Array.prototype.slice.call(panel.querySelectorAll(FOCUSABLE));
    return nodes.filter(function (n) {
      return n.offsetParent !== null || n.getClientRects().length > 0;
    });
  }

  /* ---------- layers ---------- */
  function openLayer(options) {
    var isDrawer = options.kind === 'drawer';
    var overlay = el('div', { class: 'overlay' });
    var panel = el(isDrawer ? 'aside' : 'div', {
      class: isDrawer ? 'drawer' : ('dialog' + (options.wide ? ' dialog-wide' : '')),
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': options.title || '对话框'
    });

    var head = el('div', { class: isDrawer ? 'drawer-head' : 'dialog-head' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: isDrawer ? 'drawer-title' : 'dialog-title', text: options.title || '' }),
        options.subtitle ? el('div', { class: 'drawer-sub', text: options.subtitle }) : null
      ]),
      options.headExtra || null,
      el('button', {
        type: 'button',
        class: 'close-btn',
        'aria-label': '关闭',
        onclick: function () { handle.close(); }
      }, [AB.icon('x', 14)])
    ]);

    var body = el('div', { class: isDrawer ? 'drawer-body' : 'dialog-body' },
      options.body === undefined ? null : options.body);

    panel.appendChild(head);
    panel.appendChild(body);
    if (options.footer) {
      panel.appendChild(el('div', { class: isDrawer ? 'drawer-foot' : 'dialog-foot' }, options.footer));
    }

    refs.layer.appendChild(overlay);
    refs.layer.appendChild(panel);
    refs.layer.classList.add('is-open');
    if (appRoot) appRoot.inert = true;

    var entry = {
      panel: panel,
      overlay: overlay,
      open: true,
      onClose: options.onClose,
      onEscape: options.onEscape,
      dismissible: options.dismissible !== false
    };
    layers.push(entry);

    var handle = {
      panel: panel,
      body: body,
      open: true,
      close: function () { closeLayer(entry, false); },
      setTitle: function (text) {
        var node = panel.querySelector(isDrawer ? '.drawer-title' : '.dialog-title');
        if (node) node.textContent = text;
      }
    };

    /* 开态类同步加上：入场动画由 CSS animation 承担，不依赖 rAF 是否被调度 */
    overlay.classList.add('is-open');
    panel.classList.add('is-open');
    var focusTarget = panel.querySelector('[data-autofocus]') || focusables(panel)[0];
    if (focusTarget) focusTarget.focus();
    else panel.focus();

    if (entry.dismissible) {
      overlay.addEventListener('click', function () { handle.close(); });
    }

    document.addEventListener('keydown', onKeyDown);
    function onKeyDown(event) {
      if (!handle.open) return;
      if (event.key === 'Escape') {
        if (entry.onEscape) { entry.onEscape(event, handle); return; }
        if (entry.dismissible) { event.stopPropagation(); handle.close(); }
        return;
      }
      if (event.key !== 'Tab') return;
      var items = focusables(panel);
      if (!items.length) { event.preventDefault(); panel.focus(); return; }
      var first = items[0];
      var last = items[items.length - 1];
      var active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !panel.contains(active)) { event.preventDefault(); last.focus(); }
      } else if (active === last || !panel.contains(active)) {
        event.preventDefault(); first.focus();
      }
    }
    entry.keydown = onKeyDown;

    return handle;
  }

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function closeLayer(entry, immediate) {
    if (!entry || !entry.open) return;
    entry.open = false;
    var index = layers.indexOf(entry);
    if (index >= 0) layers.splice(index, 1);
    document.removeEventListener('keydown', entry.keydown);

    var isLast = !layers.length;
    if (isLast) refs.layer.classList.remove('is-open');
    /* 退出过渡：先摘掉各自的开态类，动画结束再移出 DOM */
    entry.panel.classList.remove('is-open');
    entry.overlay.classList.remove('is-open');

    var delay = immediate || prefersReducedMotion() ? 0 : 240;
    window.setTimeout(function () {
      entry.panel.remove();
      entry.overlay.remove();
      if (isLast && !layers.length) refs.layer.classList.remove('is-open');
    }, delay);

    if (isLast && appRoot) appRoot.inert = false;
    if (entry.onClose) {
      try { entry.onClose(); } catch (e) { AB.reportError(e); }
    }
  }

  function closeAllLayers() {
    layers.slice().forEach(function (entry) { closeLayer(entry, true); });
  }

  function topLayer() { return layers[layers.length - 1] || null; }

  /* ---------- toast ---------- */
  function toast(message, tone) {
    tone = tone || 'info';
    var iconName = tone === 'ok' ? 'checkCircle'
      : tone === 'error' ? 'alert'
      : tone === 'warn' ? 'alert' : 'info';
    var node = el('div', { class: 'toast toast-' + tone, role: tone === 'error' ? 'alert' : 'status' }, [
      AB.icon(iconName, 14),
      el('div', { class: 'toast-text', text: String(message === undefined ? '' : message) })
    ]);
    refs.toastStack.appendChild(node);

    while (refs.toastStack.children.length > 4) {
      refs.toastStack.removeChild(refs.toastStack.firstChild);
    }

    var timer = window.setTimeout(dismiss, tone === 'error' ? 7000 : 4200);
    node.addEventListener('click', dismiss);

    function dismiss() {
      window.clearTimeout(timer);
      if (!node.parentNode) return;
      node.classList.add('is-leaving');
      window.setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 220);
    }
    return dismiss;
  }

  /* ---------- confirm dialog ---------- */
  function confirm(options) {
    options = options || {};
    return new Promise(function (resolve) {
      var settled = false;
      function finish(value, handle) {
        if (settled) return;
        settled = true;
        handle.close();
        resolve(value);
      }

      var body = [
        el('div', { text: options.message || '' }),
        options.detail ? el('div', { class: 'alert alert-warn' }, [
          AB.icon('alert', 15),
          el('div', { class: 'alert-body' }, [el('div', { text: options.detail })])
        ]) : null,
        options.list ? el('ul', { class: 'stack-sm', style: 'font-size:12.5px;color:var(--text-2)' },
          options.list.map(function (item) { return el('li', { text: '· ' + item }); })) : null
      ];

      var cancelBtn = el('button', {
        type: 'button', class: 'btn', text: options.cancelText || '取消',
        onclick: function () { finish(false, handleRef); }
      });
      var okBtn = el('button', {
        type: 'button',
        class: 'btn ' + (options.danger ? 'btn-solid-danger' : 'btn-primary'),
        text: options.confirmText || '确定',
        'data-autofocus': '',
        onclick: function () { finish(true, handleRef); }
      });

      var handleRef = openLayer({
        kind: 'dialog',
        title: options.title || '确认',
        body: body,
        footer: [el('div', { class: 'spacer' }), cancelBtn, okBtn],
        onClose: function () { if (!settled) { settled = true; resolve(false); } }
      });
    });
  }

  /* ---------- small building blocks ---------- */
  function button(label, options) {
    options = options || {};
    var cls = 'btn';
    if (options.variant) cls += ' btn-' + options.variant;
    if (options.size) cls += ' btn-' + options.size;
    if (options.iconOnly) cls += ' btn-icon';
    var kids = [];
    if (options.icon) kids.push(AB.icon(options.icon, options.size === 'sm' ? 13 : 14));
    if (label !== null && label !== undefined && label !== '') {
      kids.push(el('span', { class: 'btn-label', text: String(label) }));
    }
    var node = el('button', {
      type: 'button',
      class: cls,
      title: options.title || null,
      'aria-label': options.ariaLabel || null,
      disabled: options.disabled ? true : null,
      onclick: options.onClick
    }, kids);
    if (options.disabled) node.setAttribute('disabled', '');
    return node;
  }

  function setBusy(node, busy) {
    if (!node) return;
    node.classList.toggle('is-busy', !!busy);
    if (node.tagName === 'BUTTON') {
      node.disabled = !!busy || node.dataset.disabled === '1';
      if (busy) node.setAttribute('aria-busy', 'true');
      else node.removeAttribute('aria-busy');
    } else {
      node.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
  }

  function switchControl(options) {
    options = options || {};
    var node = el('button', {
      type: 'button',
      class: 'switch' + (options.small ? ' switch-sm' : ''),
      role: 'switch',
      'aria-checked': options.checked ? 'true' : 'false',
      'aria-label': options.label || '启用',
      title: options.title || null,
      disabled: options.disabled ? true : null,
      onclick: function () {
        if (node.disabled || node.getAttribute('aria-busy') === 'true') return;
        var next = node.getAttribute('aria-checked') !== 'true';
        node.setChecked(next);
        if (options.onChange) options.onChange(next, node);
      }
    }, [el('span', { class: 'switch-knob' })]);

    node.setChecked = function (v) { node.setAttribute('aria-checked', v ? 'true' : 'false'); };
    node.setSwitchBusy = function (v) {
      if (v) node.setAttribute('aria-busy', 'true');
      else node.removeAttribute('aria-busy');
    };
    return node;
  }

  function pill(text, tone) {
    return el('span', { class: 'pill' + (tone ? ' pill-' + tone : ''), text: text });
  }

  function tag(text, cls) {
    return el('span', { class: 'tag' + (cls ? ' ' + cls : ''), text: text });
  }

  function dot(tone) {
    return el('span', { class: 'dot' + (tone ? ' dot-' + tone : '') });
  }

  function field(options) {
    var control = options.control;
    return el('label', { class: 'field' }, [
      options.label ? el('span', { class: 'field-label', text: options.label }) : null,
      control,
      options.hint ? el('span', { class: 'field-hint', text: options.hint }) : null
    ]);
  }

  function passwordField(options) {
    var input = el('input', {
      type: 'password',
      class: 'input mono',
      placeholder: options.placeholder || '',
      value: options.value || '',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': options.label || 'API Key'
    });
    var reveal = el('button', {
      type: 'button',
      class: 'reveal-btn',
      'aria-label': '显示或隐藏内容',
      title: '显示 / 隐藏',
      onclick: function () {
        var show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        reveal.innerHTML = '';
        reveal.appendChild(AB.icon(show ? 'eyeOff' : 'eye', 14));
        reveal.setAttribute('aria-pressed', show ? 'true' : 'false');
        input.focus();
      }
    }, [AB.icon('eye', 14)]);

    var wrap = el('span', { class: 'reveal-wrap' }, [input, reveal]);
    return { control: wrap, input: input };
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
    }
    return Promise.resolve().then(function () { return legacyCopy(text); });
  }

  function legacyCopy(text) {
    var area = el('textarea', { class: 'visually-hidden', value: text });
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(area);
    if (!ok) throw new Error('复制失败：当前环境不允许访问剪贴板');
    return true;
  }

  function copyButton(getText, options) {
    options = options || {};
    var label = options.label || '复制';
    var btn = button(label, {
      size: options.size || 'sm',
      icon: options.icon || 'copy',
      title: options.title || null,
      onClick: function () {
        Promise.resolve().then(getText).then(function (text) {
          return copyText(text);
        }).then(function () {
          toast('已复制到剪贴板', 'ok');
        }, function (err) {
          toast(err.message || '复制失败', 'error');
        });
      }
    });
    return btn;
  }

  /* ---------- states ---------- */
  function loading(text) {
    return el('div', { class: 'loading-block', role: 'status' }, [
      el('span', { class: 'spinner' }),
      el('span', { text: text || '正在加载…' })
    ]);
  }

  function empty(options) {
    options = options || {};
    return el('div', { class: 'empty' }, [
      options.icon ? el('div', { class: 'empty-icon' }, [AB.icon(options.icon, 26)]) : null,
      el('div', { class: 'empty-title', text: options.title || '暂无数据' }),
      options.desc ? el('div', { class: 'empty-desc', text: options.desc }) : null,
      options.actions ? el('div', { class: 'empty-actions' }, options.actions) : null
    ]);
  }

  function alertBlock(options) {
    options = options || {};
    var tone = options.tone || 'info';
    var iconName = tone === 'error' ? 'alert' : tone === 'ok' ? 'checkCircle' : tone === 'warn' ? 'alert' : 'info';
    return el('div', { class: 'alert alert-' + tone, role: tone === 'error' ? 'alert' : 'note' }, [
      AB.icon(iconName, 15),
      el('div', { class: 'alert-body' }, [
        options.title ? el('div', { class: 'alert-title', text: options.title }) : null,
        options.message ? el('div', { class: options.mono ? 'alert-mono' : null, text: options.message }) : null,
        options.extra || null
      ])
    ]);
  }

  function downPanel(options) {
    options = options || {};
    var port = (AB.state.gateway && AB.state.gateway.port) || options.port;
    var hostError = AB.state && AB.state.hostError;
    var action;

    if (hostError && !options.actionLabel) {
      action = button('重新连接', {
        variant: 'primary',
        icon: 'refresh',
        onClick: function () { AB.refreshHost(); }
      });
    } else {
      action = button(options.actionLabel || '启动网关', {
        variant: 'primary',
        icon: 'power',
        onClick: function () { startGateway(action); }
      });
    }

    var title = options.title || (hostError ? '无法连接宿主服务' : '网关未运行');
    var desc = options.desc || (hostError
      ? (hostError.message || '宿主服务无响应，请确认桌面客户端仍在运行。')
      : ('Node 网关尚未监听' + (port ? '（:' + port + '）' : '') + '，启动后这里会自动刷新。'));

    var node = el('div', { class: 'down-panel' }, [
      dot(hostError ? 'danger' : 'muted'),
      el('div', { class: 'grow' }, [
        el('div', { class: 'down-title', text: title }),
        el('div', { class: 'down-desc', text: desc })
      ]),
      action,
      options.extraAction || null
    ]);
    return node;
  }

  function viewError(err, onRetry) {
    var wrap = el('div', { class: 'stack' });
    var isDown = AB.isGatewayDownError(err);
    if (isDown) {
      wrap.appendChild(downPanel({}));
      var retryDown = button('重新加载', {
        icon: 'refresh',
        onClick: function () { if (onRetry) onRetry(); }
      });
      wrap.appendChild(el('div', { class: 'row' }, [retryDown]));
      return wrap;
    }
    wrap.appendChild(alertBlock({
      tone: 'error',
      title: '读取数据失败',
      message: (err && err.message) || '未知错误',
      extra: err && err.status ? el('div', { class: 'muted', text: 'HTTP ' + err.status }) : null
    }));
    wrap.appendChild(el('div', { class: 'row' }, [
      button('重试', { icon: 'refresh', onClick: function () { if (onRetry) onRetry(); } })
    ]));
    return wrap;
  }

  /* ---------- gateway start helper (shared by every view) ---------- */
  function startGateway(btn) {
    setBusy(btn, true);
    return AB.api.gatewayStart().then(function (state) {
      toast('已发送启动网关请求', 'info');
      if (state && state.gateway) {
        AB.state.gateway = state.gateway;
      }
      var tries = 0;
      var timer = window.setInterval(function () {
        tries += 1;
        AB.refreshHost().then(function () {
          if (!AB.gatewayDown() || tries >= 8) window.clearInterval(timer);
        });
      }, 1000);
      return state;
    }).catch(function (err) {
      toast(err.message || '启动网关失败', 'error');
    }).then(function () {
      setBusy(btn, false);
      AB.refreshHost();
    });
  }

  /* ---------- misc table helpers ---------- */
  function cell(text, options) {
    options = options || {};
    var cls = options.class ? options.class : null;
    var node = el('td', {
      class: cls,
      title: options.title === undefined ? (text || '') : options.title
    }, [
      options.mono ? el('span', { class: 'mono', text: text === undefined || text === null ? '—' : String(text) })
        : (text === undefined || text === null ? '—' : String(text))
    ]);
    return node;
  }

  AB.ui = {
    init: init,
    openLayer: openLayer,
    closeAllLayers: closeAllLayers,
    topLayer: topLayer,
    focusables: focusables,
    toast: toast,
    confirm: confirm,
    button: button,
    setBusy: setBusy,
    switchControl: switchControl,
    pill: pill,
    tag: tag,
    dot: dot,
    field: field,
    passwordField: passwordField,
    copyText: copyText,
    copyButton: copyButton,
    loading: loading,
    empty: empty,
    alert: alertBlock,
    downPanel: downPanel,
    viewError: viewError,
    startGateway: startGateway,
    cell: cell
  };
})(window.AB);