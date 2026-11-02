/* Accio Bridge — 概览视图: Accio 客户端卡片 + 关键指标. */
window.AB = window.AB || {};

(function (AB) {
  'use strict';

  var el = AB.el;

  var EDITION = {
    cn: { label: '中国版', tone: 'accent' },
    global: { label: '海外版', tone: 'warn' },
    unknown: { label: '未知', tone: null },
    none: { label: '未安装', tone: null }
  };

  function editionInfo(accio) {
    var edition = (accio && accio.edition) || 'unknown';
    var info = EDITION[edition] || EDITION.unknown;
    var label = (accio && accio.editionLabel) || info.label;
    return { label: label, tone: info.tone, edition: edition };
  }

  function evidencePill(target) {
    if (target === 'cn') return AB.ui.pill('中国版', 'accent');
    if (target === 'global') return AB.ui.pill('海外版', 'warn');
    return AB.ui.pill('无关', null);
  }

  function runningText(accio) {
    if (!accio.running) return '未运行';
    var pids = (accio.runningPids || []).filter(function (p) { return p; });
    return pids.length ? '运行中 · PID ' + pids.join(', ') : '运行中';
  }

  function takeOverInfo(accio, gateway) {
    if (!accio.installed) return { label: '未安装', tone: null, note: '未检测到客户端可执行文件' };
    if (!accio.running) return { label: '未接管', tone: 'warn', note: '客户端未运行，接管后由本程序提供网关' };
    var accioPort = accio.gatewayPort;
    if (!accioPort) return { label: '未知', tone: null, note: '无法读取客户端网关端口' };
    if (gateway && gateway.port && accioPort === gateway.port) {
      return { label: '已接管', tone: 'ok', note: 'Accio 网关指向 :' + accioPort };
    }
    return { label: '未接管', tone: 'warn', note: 'Accio 网关端口 :' + accioPort + '，本程序 :' + ((gateway && gateway.port) || '—') };
  }

  AB.registerView('overview', {
    title: '概览',

    mount: function (root, ctx) {
      var alive = true;
      var data = {
        accio: null,
        accioError: null,
        providers: null,
        models: null,
        usage: null,
        providersError: null,
        usageError: null
      };
      var metrics = null;
      var cardHost = el('div', { class: 'stack' });
      var metricsHost = el('div', { class: 'metrics' });

      ctx.dispose(function () { alive = false; });
      root.appendChild(cardHost);
      root.appendChild(metricsHost);

      cardHost.appendChild(AB.ui.loading('正在读取 Accio 客户端状态…'));
      metricsHost.appendChild(metricTile('网关状态', '—', '正在读取…'));

      var refreshBtn = AB.ui.button('刷新', {
        size: 'sm',
        icon: 'refresh',
        title: '重新执行 Accio 版本识别',
        onClick: function () { load(true); }
      });

      function load(force) {
        cardHost.innerHTML = '';
        cardHost.appendChild(AB.ui.loading('正在读取 Accio 客户端状态…'));
        return AB.api.getAccio(force === true).then(function (res) {
          if (!alive) return;
          data.accio = res.accio;
          data.accioError = null;
          renderCard();
        }, function (err) {
          if (!alive) return;
          data.accio = null;
          data.accioError = err;
          renderCard();
        }).then(loadAux);
      }

      function loadAux() {
        var jobs = [
          AB.api.getProviders().then(function (res) { data.providers = res.providers || []; data.providersError = null; },
            function (err) { data.providers = null; data.providersError = err; }),
          AB.api.getModels().then(function (res) { data.models = res.models || []; },
            function (err) { data.models = null; }),
          AB.api.getUsage().then(function (res) { data.usage = res.usage || {}; data.usageError = null; },
            function (err) { data.usage = null; data.usageError = err; })
        ];
        return Promise.all(jobs).then(function () {
          if (!alive) return;
          renderMetrics();
        });
      }

      /* ---------- Accio card ---------- */
      function renderCard() {
        cardHost.innerHTML = '';
        var card = el('section', { class: 'card' });
        cardHost.appendChild(card);

        if (!data.accio) {
          var head = el('div', { class: 'card-head' }, [
            el('span', { class: 'card-title', text: 'Accio 客户端' }),
            el('div', { class: 'card-actions' }, [refreshBtn])
          ]);
          card.appendChild(head);
          var body = el('div', { class: 'card-body' });
          card.appendChild(body);
          if (data.accioError && AB.isGatewayDownError(data.accioError)) {
            body.appendChild(AB.ui.downPanel({
              desc: '网关未运行，无法读取 Accio 客户端信息。启动网关后这里会自动刷新。'
            }));
          } else {
            body.appendChild(AB.ui.alert({
              tone: 'error',
              title: '无法读取 Accio 客户端状态',
              message: (data.accioError && data.accioError.message) || '未知错误'
            }));
            body.appendChild(el('div', { class: 'row', style: 'margin-top:8px' }, [
              AB.ui.button('重试', { size: 'sm', icon: 'refresh', onClick: function () { load(false); } })
            ]));
          }
          return;
        }

        var accio = data.accio;
        var info = editionInfo(accio);
        var takeover = takeOverInfo(accio, AB.state.gateway);
        var launchBtn = AB.ui.button('启动 Accio 并接管', {
          variant: 'primary',
          icon: 'play',
          disabled: !accio.installed,
          title: accio.installed ? '' : '未检测到 Accio Work 客户端',
          onClick: function () { launch(launchBtn, false); }
        });

        card.appendChild(el('div', { class: 'card-head' }, [
          el('span', { class: 'card-title', text: 'Accio 客户端' }),
          AB.ui.pill(info.label, info.tone),
          el('span', { class: 'card-sub', text: accio.installed ? (accio.path || '') : '未检测到安装' }),
          el('div', { class: 'card-actions' }, [
            refreshBtn,
            launchBtn
          ])
        ]));

        var body = el('div', { class: 'card-body' });
        card.appendChild(body);

        if (!accio.installed) {
          body.appendChild(AB.ui.alert({
            tone: 'warn',
            title: '未安装 Accio Work',
            message: '在标准安装路径与注册表中都没有找到 Accio Work 客户端，请先安装后再回到此页面。'
          }));
        }

        body.appendChild(el('div', { class: 'defs' }, [
          el('div', { class: 'def-key', text: '版本号' }),
          el('div', { class: 'def-val' }, [
            el('span', { class: 'mono', text: accio.version || '—' }),
            info.edition === 'unknown' ? el('span', { class: 'muted', text: ' · 版本识别不确定' }) : null
          ]),
          el('div', { class: 'def-key', text: '路径' }),
          el('div', { class: 'def-val ellipsis', title: accio.path || '' }, [
            el('span', { class: 'mono', text: accio.path || '—' })
          ]),
          el('div', { class: 'def-key', text: '运行状态' }),
          el('div', { class: 'def-val' }, [
            el('span', { class: 'row', style: 'display:inline-flex;gap:6px' }, [
              AB.ui.dot(accio.running ? 'ok' : 'muted'),
              el('span', { text: runningText(accio) })
            ])
          ]),
          el('div', { class: 'def-key', text: '登录状态' }),
          el('div', { class: 'def-val', text: accio.signedIn ? ('已登录 · ' + (accio.accountCount || 0) + ' 个账号') : '未登录' }),
          el('div', { class: 'def-key', text: '接管状态' }),
          el('div', { class: 'def-val' }, [
            el('span', { class: 'row', style: 'display:inline-flex;gap:8px' }, [
              AB.ui.pill(takeover.label, takeover.tone),
              el('span', { class: 'muted', text: takeover.note })
            ])
          ])
        ]));

        /* 识别依据 */
        var list = el('div', { class: 'ev-list' });
        var open = false;
        var collapsible = el('div', { class: 'collapsible', id: 'overview-evidence' }, [list]);
        var summary = '共 ' + (accio.evidence || []).length + ' 条 · 中国版评分 ' +
          ((accio.scores && accio.scores.cn) || 0) + ' / 海外版评分 ' + ((accio.scores && accio.scores.global) || 0);

        var disclosure = el('button', {
          type: 'button',
          class: 'disclosure',
          'aria-expanded': 'false',
          'aria-controls': 'overview-evidence',
          onclick: function () {
            open = !open;
            collapsible.classList.toggle('is-open', open);
            disclosure.setAttribute('aria-expanded', open ? 'true' : 'false');
          }
        }, [
          el('span', { class: 'row', style: 'display:inline-flex' }, [AB.icon('chevronRight', 13)]),
          el('span', { text: '识别依据' }),
          el('span', { class: 'muted', text: summary })
        ]);
        var chev = disclosure.querySelector('svg');
        if (chev) chev.setAttribute('class', 'chev');

        (accio.evidence || []).forEach(function (item) {
          list.appendChild(el('div', { class: 'ev-row' + (item.targetEdition === 'neutral' ? ' is-neutral' : '') }, [
            el('span', { class: 'ev-src', text: item.source + ' · ' + (item.field || '') }),
            evidencePill(item.targetEdition),
            el('span', { class: 'ev-weight', text: item.weight ? '权重 ' + item.weight : '' }),
            el('span', { class: 'ev-desc', text: item.description || '' }),
            el('span', { class: 'ev-val ellipsis', title: item.value || '' , text: item.value || '' })
          ]));
        });

        card.appendChild(el('div', { class: 'evidence' }, [disclosure, collapsible]));
      }

      /* ---------- launch flow ---------- */
      function launch(btn, force) {
        var accio = data.accio;
        if (!accio) return;

        if (!force) {
          if (!accio.installed) {
            AB.ui.toast('未检测到 Accio Work 客户端，无法接管', 'warn');
            return;
          }
          var needForce = accio.running || accio.edition !== 'cn';
          if (needForce) {
            AB.ui.confirm({
              title: '确认接管 Accio',
              message: accio.edition !== 'cn'
                ? '检测到的客户端不是 Accio Work 中国版（当前为「' + accio.editionLabel + '」），强制接管可能不兼容。'
                : 'Accio Work 正在运行（PID ' + (accio.runningPids || []).join(', ') + '），接管会先结束当前进程。',
              detail: '接管后 Accio 的网关地址会指向本程序 http://127.0.0.1:' + ((AB.state.gateway || {}).port || '—') + '。',
              confirmText: '强制接管',
              danger: accio.edition !== 'cn'
            }).then(function (ok) {
              if (ok) launch(btn, true);
            });
            return;
          }
        }

        AB.ui.setBusy(btn, true);
        AB.api.launchAccio({ force: force }).then(function (res) {
          AB.ui.toast('已启动 Accio 并接管网关 ' + (res.gatewayBaseUrl || ''), 'ok');
          return load(false);
        }, function (err) {
          var payload = err.payload || {};
          if (payload.needsForce && !force) {
            return AB.ui.confirm({
              title: '需要强制接管',
              message: err.message,
              confirmText: '仍然接管',
              danger: true
            }).then(function (ok) { if (ok) launch(btn, true); });
          }
          AB.ui.toast(err.message || '启动 Accio 失败', 'error');
        }).then(function () {
          AB.ui.setBusy(btn, false);
        }, function () {
          AB.ui.setBusy(btn, false);
        });
      }

      /* ---------- metrics ---------- */
      function metricTile(label, value, note, title) {
        var node = el('div', { class: 'metric', title: title || null }, [
          el('div', { class: 'metric-label' }, [el('span', { text: label })]),
          el('div', { class: 'metric-value' }, value instanceof Node ? value : el('span', { text: value })),
          el('div', { class: 'metric-note', text: note || '' })
        ]);
        return node;
      }

      function renderMetrics() {
        metricsHost.innerHTML = '';
        metrics = {};

        /* 1. 网关状态 */
        var gw = AB.state.gateway || {};
        var gwValue = AB.ui.pill(AB.gatewayStateText(gw), AB.gatewayTone(gw));
        var gwNote = gw.state === 'running'
          ? (':' + (gw.port || '—') + (gw.managed === false ? ' · 外部进程' : (gw.pid ? ' · PID ' + gw.pid : '')))
          : (gw.lastError || '启动后模型请求才会被转发');
        metrics.gateway = metricTile('网关状态', gwValue, gwNote, gw.lastError || '');

        /* 2. 启用模型数 */
        var models = data.models;
        var enabledCount = models ? models.filter(function (m) { return m.enabled; }).length : null;
        metrics.models = metricTile(
          '启用模型数',
          enabledCount === null ? '—' : String(enabledCount),
          models ? '共 ' + models.length + ' 个模型' : (data.providersError ? '网关未运行' : '—')
        );

        /* 3. 供应商数 */
        var providers = data.providers;
        var cloud = 0;
        var local = 0;
        (providers || []).forEach(function (p) { if (p.local) local += 1; else cloud += 1; });
        metrics.providers = metricTile(
          '供应商',
          providers === null ? '—' : String(providers.length),
          providers === null ? (data.providersError ? '网关未运行' : '—') : (local + ' 个本地 · ' + cloud + ' 个云端')
        );

        /* 4. 本次运行请求数 */
        var totalRequests = 0;
        if (data.usage) {
          Object.keys(data.usage).forEach(function (key) {
            totalRequests += Number(data.usage[key].requests || 0);
          });
        }
        metrics.usage = metricTile(
          '请求数',
          data.usage ? AB.fmt.num(totalRequests) : '—',
          '本次运行（usage 累计，进程重启清零）',
          '来源：GET /api/bridge/usage'
        );

        Object.keys(metrics).forEach(function (key) { metricsHost.appendChild(metrics[key]); });
      }

      load(false);

      return {
        update: function () { renderMetrics(); },
        /* 网关状态变化后重新拉取数据（尤其是从停止变为运行） */
        onGatewayChange: function (prev, next) {
          if (prev !== next) load(false);
        }
      };
    }
  });
})(window.AB);