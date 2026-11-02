/* Accio Bridge — 网关视图: 状态、操作、Accio 配置说明. */
window.AB = window.AB || {};

(function (AB) {
  'use strict';

  var el = AB.el;
  var ui = AB.ui;

  AB.registerView('gateway', {
    title: '网关',

    mount: function (root, ctx) {
      var alive = true;
      var host = el('div', { class: 'stack' });
      root.appendChild(host);

      var lastGatewaySignature = '';

      ctx.setActions([
        ui.button('刷新', { size: 'sm', icon: 'refresh', onClick: function () { AB.refreshHost().then(render); } })
      ]);
      ctx.dispose(function () { alive = false; });

      function startButton() {
        var btn = ui.button('启动', { variant: 'primary', icon: 'power' });
        btn.addEventListener('click', function () { ui.startGateway(btn).then(render); });
        return btn;
      }

      function stopButton() {
        var btn = ui.button('停止', { icon: 'stop' });
        btn.addEventListener('click', function () {
          ui.setBusy(btn, true);
          AB.api.gatewayStop().then(function () {
            ui.toast('已发送停止网关请求', 'info');
            return AB.refreshHost();
          }, function (err) {
            ui.toast(err.message || '停止网关失败', 'error');
          }).then(function () {
            ui.setBusy(btn, false);
            render();
          });
        });
        return btn;
      }

      function restartButton() {
        var btn = ui.button('重启', { icon: 'refresh' });
        btn.addEventListener('click', function () {
          ui.setBusy(btn, true);
          AB.api.gatewayRestart().then(function () {
            ui.toast('已发送重启网关请求', 'info');
            return AB.refreshHost();
          }, function (err) {
            ui.toast(err.message || '重启失败', 'error');
          }).then(function () {
            ui.setBusy(btn, false);
            render();
          });
        });
        return btn;
      }

      function openButton(label, target, icon) {
        return ui.button(label, {
          size: 'sm', icon: icon,
          onClick: function () {
            AB.api.open(target).then(function () {
              ui.toast('已请求打开：' + label.replace('打开', ''), 'ok');
            }, function (err) {
              ui.toast(err.message || '打开失败', 'error');
            });
          }
        });
      }

      function render() {
        if (!alive) return;
        var state = AB.state;
        var gateway = state.gateway || {};
        var running = gateway.state === 'running';
        var managed = gateway.managed !== false;

        /* 只要网关状态没变化就不重建 DOM（避免每 3 秒闪烁） */
        var signature = [gateway.state, gateway.managed, gateway.pid, gateway.port, gateway.startedAt, gateway.lastError,
          state.node && state.node.path, state.node && state.node.found, state.root, state.logFile, state.version,
          state.hostError ? state.hostError.message : ''].join('|');
        if (signature === lastGatewaySignature) return;
        lastGatewaySignature = signature;

        host.innerHTML = '';

        if (state.hostError) {
          host.appendChild(ui.alert({
            tone: 'error',
            title: '无法连接宿主服务',
            message: state.hostError.message || '未知错误'
          }));
        }

        /* 状态 + 操作 */
        var card = el('section', { class: 'card' });
        var sBtn = startButton();
        var tBtn = stopButton();
        var rBtn = restartButton();
        sBtn.disabled = running || gateway.state === 'starting';
        tBtn.disabled = !running || !managed;
        rBtn.disabled = !running || !managed;
        if (!managed) {
          tBtn.title = '外部进程，本程序不会停止它';
          rBtn.title = '外部进程，本程序不会停止它';
        }

        card.appendChild(el('div', { class: 'card-head' }, [
          el('span', { class: 'card-title', text: 'Node 网关' }),
          ui.pill(AB.gatewayStateText(gateway), AB.gatewayTone(gateway)),
          el('span', { class: 'card-sub', text: gateway.lastError ? '上次错误：' + gateway.lastError : '' }),
          el('div', { class: 'card-actions' }, [sBtn, tBtn, rBtn])
        ]));

        var body = el('div', { class: 'card-body' });
        card.appendChild(body);

        body.appendChild(el('div', { class: 'defs' }, [
          el('div', { class: 'def-key', text: '状态' }),
          el('div', { class: 'def-val' }, [
            el('span', { class: 'row', style: 'display:inline-flex;gap:8px' }, [
              ui.dot(AB.gatewayTone(gateway)),
              el('span', { text: AB.gatewayLabel(gateway) })
            ])
          ]),
          el('div', { class: 'def-key', text: '端口' }),
          el('div', { class: 'def-val mono', text: gateway.port ? String(gateway.port) : '—' }),
          el('div', { class: 'def-key', text: 'PID' }),
          el('div', { class: 'def-val mono', text: gateway.pid ? String(gateway.pid) : '—' }),
          el('div', { class: 'def-key', text: '进程归属' }),
          el('div', { class: 'def-val' }, [
            managed
              ? el('span', { class: 'row', style: 'display:inline-flex;gap:8px' }, [
                ui.tag('受本程序管理'),
                el('span', { class: 'muted', text: '停止 / 重启可用' })
              ])
              : el('span', { class: 'row', style: 'display:inline-flex;gap:8px' }, [
                ui.pill('外部进程', 'warn'),
                el('span', { class: 'muted', text: '外部进程，本程序不会停止它' })
              ])
          ]),
          el('div', { class: 'def-key', text: '启动时间' }),
          el('div', {
            class: 'def-val',
            text: gateway.startedAt
              ? AB.fmt.dateTime(gateway.startedAt) + '（已运行 ' + AB.fmt.uptime(gateway.startedAt) + '）'
              : '—'
          }),
          el('div', { class: 'def-key', text: 'Node 路径' }),
          el('div', { class: 'def-val ellipsis', title: (state.node && state.node.path) || '' }, [
            el('span', { class: 'mono', text: (state.node && state.node.path) || '未找到 Node 运行时' }),
            state.node && state.node.found === false ? ui.pill('未找到', 'danger') : null
          ]),
          el('div', { class: 'def-key', text: '项目根' }),
          el('div', { class: 'def-val ellipsis', title: state.root || '' }, [
            el('span', { class: 'mono', text: state.root || '—' })
          ]),
          el('div', { class: 'def-key', text: '日志文件' }),
          el('div', { class: 'def-val ellipsis', title: state.logFile || '' }, [
            el('span', { class: 'mono', text: state.logFile || '—' })
          ])
        ]));

        card.appendChild(el('div', { class: 'card-foot' }, [
          openButton('打开配置文件', 'config', 'edit'),
          openButton('打开日志', 'logs', 'logs'),
          openButton('打开目录', 'root', 'folder')
        ]));
        host.appendChild(card);

        /* lastError 醒目显示 */
        if (gateway.lastError) {
          var alert = ui.alert({
            tone: 'error',
            title: '网关上报了错误',
            message: gateway.lastError,
            mono: true
          });
          host.appendChild(alert);
        }

        /* Accio 配置说明 */
        var baseValue = (gateway.url || ('http://127.0.0.1:' + (gateway.port || 8080)));
        var configCard = el('section', { class: 'card' });
        configCard.appendChild(el('div', { class: 'card-head' }, [
          el('span', { class: 'card-title', text: 'Accio 客户端配置' })
        ]));
        var cbody = el('div', { class: 'card-body stack-sm' });
        cbody.appendChild(el('div', { class: 'muted', text: '把 Accio Work 的网关地址指向下面的值（环境变量 GATEWAY_BASE_URL），或直接使用项目根目录的 launch-accio.bat 启动。' }));
        cbody.appendChild(el('div', { class: 'code-block' }, [
          el('span', { class: 'mono', text: 'GATEWAY_BASE_URL=' + baseValue }),
          el('div', { class: 'spacer' }),
          ui.copyButton(function () { return baseValue; }, { label: '复制地址' })
        ]));
        cbody.appendChild(el('div', { class: 'code-block' }, [
          el('span', { class: 'grow mono', text: 'set GATEWAY_BASE_URL=' + baseValue + ' && %LOCALAPPDATA%\\Accio\\Accio.exe' }),
          ui.copyButton(function () { return 'set GATEWAY_BASE_URL=' + baseValue + ' && %LOCALAPPDATA%\\Accio\\Accio.exe'; }, { label: '复制命令' })
        ]));
        configCard.appendChild(cbody);
        host.appendChild(configCard);

        /* 说明：查看日志的跳转 */
        host.appendChild(el('div', { class: 'row' }, [
          ui.button('查看实时日志', { size: 'sm', icon: 'logs', onClick: function () { AB.navigate('logs'); } }),
          ui.button('测试模型', { size: 'sm', icon: 'test', onClick: function () { AB.navigate('test'); } })
        ]));
      }

      render();

      return {
        /* 宿主状态每 3 秒轮询，这里按需重建 */
        update: function () { render(); },
        onHostError: function () { lastGatewaySignature = ''; render(); }
      };
    }
  });
})(window.AB);