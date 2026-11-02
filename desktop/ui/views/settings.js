/* Accio Bridge — 设置视图: 主题、版本与路径、窗口与退出. */
window.AB = window.AB || {};

(function (AB) {
  'use strict';

  var el = AB.el;
  var ui = AB.ui;

  var THEMES = [
    { id: 'auto', label: '跟随系统' },
    { id: 'light', label: '浅色' },
    { id: 'dark', label: '深色' }
  ];

  AB.registerView('settings', {
    title: '设置',

    mount: function (root, ctx) {
      var alive = true;
      var lastSignature = '';
      var host = el('div', { class: 'stack' });
      root.appendChild(host);

      var themeRow = el('div', { class: 'segmented', role: 'group', 'aria-label': '主题' });
      var themeButtons = {};

      THEMES.forEach(function (item) {
        var btn = el('button', {
          type: 'button',
          class: 'seg-btn',
          'aria-pressed': 'false',
          text: item.label,
          onclick: function () {
            AB.theme.set(item.id);
            applyThemeState();
            ui.toast('主题已切换为「' + item.label + '」', 'ok');
          }
        });
        themeButtons[item.id] = btn;
        themeRow.appendChild(btn);
      });

      function applyThemeState() {
        var current = AB.theme.get();
        THEMES.forEach(function (item) {
          themeButtons[item.id].setAttribute('aria-pressed', item.id === current ? 'true' : 'false');
        });
      }

      ctx.dispose(function () { alive = false; });

      function render() {
        if (!alive) return;
        var state = AB.state;
        /* 内容没变就不重建，避免每 3 秒轮询把整页 DOM 换掉 */
        var signature = [state.mock, state.scenario, state.version, state.root, state.logFile,
          state.node && state.node.path, state.hostError ? state.hostError.message : '', AB.theme.get()].join('|');
        if (signature === lastSignature) { applyThemeState(); return; }
        lastSignature = signature;
        host.innerHTML = '';

        if (state.mock) {
          host.appendChild(ui.alert({
            tone: 'warn',
            title: '演示数据（mock）',
            message: '当前页面使用内存模拟数据（mock=1 或 file:// 打开），没有连接真实的 Go 宿主与 Node 网关。' +
              (state.scenario ? ' 模拟场景：' + state.scenario + '。' : '')
          }));
        }
        if (state.hostError) {
          host.appendChild(ui.alert({
            tone: 'error',
            title: '无法连接宿主服务',
            message: state.hostError.message || '未知错误'
          }));
        }

        /* 外观 */
        var themeCard = el('section', { class: 'card' });
        themeCard.appendChild(el('div', { class: 'card-head' }, [
          el('span', { class: 'card-title', text: '外观' })
        ]));
        var themeBody = el('div', { class: 'card-body' });
        themeBody.appendChild(el('div', { class: 'settings-grid' }, [
          el('div', { class: 'def-key', text: '主题' }),
          el('div', { class: 'row' }, [
            themeRow,
            el('span', { class: 'muted', text: '选择后立即生效并保存在本机' })
          ])
        ]));
        themeCard.appendChild(themeBody);
        host.appendChild(themeCard);
        applyThemeState();

        /* 版本与路径 */
        var infoCard = el('section', { class: 'card' });
        infoCard.appendChild(el('div', { class: 'card-head' }, [
          el('span', { class: 'card-title', text: '版本与路径' })
        ]));
        var infoBody = el('div', { class: 'card-body' });
        infoBody.appendChild(el('div', { class: 'kv-list' }, [
          el('div', { class: 'def-key', text: '界面版本' }),
          el('div', { class: 'def-val mono', text: AB.UI_VERSION }),
          el('div', { class: 'def-key', text: '宿主版本' }),
          el('div', { class: 'def-val mono', text: state.version || (state.hostError ? '—' : '未知') }),
          el('div', { class: 'def-key', text: '运行模式' }),
          el('div', { class: 'def-val', text: state.mock ? '演示模式（内存模拟数据）' : '桌面窗口（WebView2 + Go 宿主）' }),
          el('div', { class: 'def-key', text: '项目根路径' }),
          el('div', { class: 'def-val ellipsis', title: state.root || '' }, [
            el('span', { class: 'mono', text: state.root || '—' })
          ]),
          el('div', { class: 'def-key', text: '日志文件' }),
          el('div', { class: 'def-val ellipsis', title: state.logFile || '' }, [
            el('span', { class: 'mono', text: state.logFile || '—' })
          ]),
          el('div', { class: 'def-key', text: 'Node 运行时' }),
          el('div', { class: 'def-val ellipsis', title: (state.node && state.node.path) || '' }, [
            el('span', { class: 'mono', text: (state.node && state.node.path) || '—' })
          ])
        ]));
        infoBody.appendChild(el('div', { class: 'row', style: 'margin-top:10px' }, [
          ui.button('打开项目根目录', {
            size: 'sm', icon: 'folder',
            disabled: !state.root && !state.mock,
            onClick: function () {
              AB.api.open('root').then(function () {
                ui.toast('已请求打开项目根目录', 'ok');
              }, function (err) {
                ui.toast(err.message || '打开失败', 'error');
              });
            }
          }),
          ui.button('打开日志文件', {
            size: 'sm', icon: 'logs',
            disabled: !state.logFile && !state.mock,
            onClick: function () {
              AB.api.open('logs').then(function () {
                ui.toast('已请求打开日志文件', 'ok');
              }, function (err) {
                ui.toast(err.message || '打开失败', 'error');
              });
            }
          })
        ]));
        infoCard.appendChild(infoBody);
        host.appendChild(infoCard);

        /* 窗口与退出 */
        var winCard = el('section', { class: 'card' });
        winCard.appendChild(el('div', { class: 'card-head' }, [
          el('span', { class: 'card-title', text: '窗口与退出' })
        ]));
        var winBody = el('div', { class: 'card-body stack-sm' });
        winBody.appendChild(el('div', {
          class: 'muted',
          text: '点击窗口的关闭按钮只会把窗口隐藏到系统托盘，程序与网关继续在后台运行；' +
            '使用托盘菜单「退出」或下面的按钮才会真正结束程序（同时停止由本程序启动的网关）。'
        }));
        winBody.appendChild(el('div', { class: 'row', style: 'margin-top:4px' }, [
          ui.button('隐藏窗口到托盘', {
            size: 'sm', icon: 'hide',
            onClick: function () {
              var text = state.mock
                ? '演示模式：已模拟隐藏窗口（真实运行时窗口会收到托盘）'
                : '窗口已隐藏到系统托盘，可从托盘菜单恢复';
              ui.toast(text, 'info');
              AB.api.windowHide().catch(function (err) {
                ui.toast(err.message || '隐藏窗口失败', 'error');
              });
            }
          }),
          ui.button('退出程序', {
            variant: 'danger', size: 'sm', icon: 'quit',
            onClick: function () {
              ui.confirm({
                title: '退出 Accio Bridge',
                message: '确定要退出程序吗？',
                detail: state.mock
                  ? '演示模式：只会模拟退出请求，不会真的关闭窗口。'
                  : '退出会同时停止由本程序启动的网关进程（外部进程不受影响）。',
                confirmText: '退出',
                danger: true
              }).then(function (ok) {
                if (!ok) return;
                return AB.api.appQuit().then(function () {
                  if (state.mock) ui.toast('演示模式：已模拟退出请求', 'info');
                }, function (err) {
                  ui.toast(err.message || '退出失败', 'error');
                });
              });
            }
          })
        ]));
        winCard.appendChild(winBody);
        host.appendChild(winCard);
      }

      render();

      return {
        update: function () { render(); },
        onHostError: function () { render(); },
        onHostRecover: function () { render(); }
      };
    }
  });
})(window.AB);