/* Accio Bridge — 模型视图: 扁平模型表格 + 搜索 + 行内启用开关. */
window.AB = window.AB || {};

(function (AB) {
  'use strict';

  var el = AB.el;
  var ui = AB.ui;

  var COLUMNS = [
    ['名称', '22%'],
    ['id', '18%'],
    ['供应商', '11%'],
    ['上下文', '8%'],
    ['多模态', '8%'],
    ['默认', '7%'],
    ['请求数', '8%'],
    ['最后延迟', '10%'],
    ['启用', '8%']
  ];

  AB.registerView('models', {
    title: '模型',

    mount: function (root, ctx) {
      var alive = true;
      var models = [];
      var usage = {};
      var query = '';
      var error = null;

      var host = el('div', { class: 'stack' });
      root.appendChild(host);

      var searchInput = el('input', {
        type: 'search',
        class: 'input',
        placeholder: '搜索名称、id 或供应商',
        'aria-label': '搜索模型',
        style: 'width:220px',
        oninput: function () {
          query = searchInput.value.trim().toLowerCase();
          render();
        }
      });

      var refreshBtn = ui.button('刷新', {
        size: 'sm', icon: 'refresh', title: '重新读取模型列表',
        onClick: function () { load(); }
      });

      ctx.setActions([searchInput, refreshBtn]);
      ctx.dispose(function () { alive = false; });

      function load() {
        host.innerHTML = '';
        host.appendChild(ui.loading('正在读取模型列表…'));
        return Promise.all([
          AB.api.getModels().then(function (res) { models = res.models || []; error = null; },
            function (err) { models = []; error = err; }),
          AB.api.getUsage().then(function (res) { usage = res.usage || {}; },
            function () { usage = {}; })
        ]).then(function () {
          if (!alive) return;
          render();
        });
      }

      function filteredModels() {
        if (!query) return models;
        return models.filter(function (model) {
          return (model.displayName || '').toLowerCase().indexOf(query) >= 0 ||
            (model.id || '').toLowerCase().indexOf(query) >= 0 ||
            (model.provider || '').toLowerCase().indexOf(query) >= 0 ||
            (model.upstreamModel || '').toLowerCase().indexOf(query) >= 0;
        });
      }

      function render() {
        host.innerHTML = '';

        if (error) {
          host.appendChild(ui.viewError(error, function () { load(); }));
          return;
        }

        var list = filteredModels();
        var card = el('section', { class: 'card' });
        card.appendChild(el('div', { class: 'card-head' }, [
          el('span', { class: 'card-title', text: '模型' }),
          el('span', {
            class: 'card-sub',
            text: query
              ? '匹配 ' + list.length + ' / ' + models.length + ' 个模型'
              : '共 ' + models.length + ' 个模型 · ' + models.filter(function (m) { return m.enabled; }).length + ' 个已启用'
          })
        ]));

        if (!models.length) {
          card.appendChild(ui.empty({
            icon: 'models',
            title: '还没有模型',
            desc: '在「供应商」页面添加供应商并拉取模型后，它们会出现在这里。',
            actions: [ui.button('去添加供应商', { variant: 'primary', icon: 'plus', onClick: function () { AB.navigate('providers'); } })]
          }));
          host.appendChild(card);
          return;
        }

        var tbl = el('table', { class: 'table' });
        var colgroup = el('colgroup');
        COLUMNS.forEach(function (column) {
          colgroup.appendChild(el('col', { style: 'width:' + column[1] }));
        });
        tbl.appendChild(colgroup);
        var thead = el('thead');
        var headRow = el('tr');
        COLUMNS.forEach(function (column) {
          headRow.appendChild(el('th', { text: column[0], scope: 'col' }));
        });
        thead.appendChild(headRow);
        tbl.appendChild(thead);

        var tbody = el('tbody');
        if (!list.length) {
          var emptyRow = el('tr');
          var td = el('td', { colspan: String(COLUMNS.length), class: 'tbl-empty', text: '没有匹配「' + searchInput.value + '」的模型' });
          emptyRow.appendChild(td);
          tbody.appendChild(emptyRow);
        }
        list.forEach(function (model) {
          tbody.appendChild(row(model));
        });
        tbl.appendChild(tbody);
        card.appendChild(el('div', { class: 'tbl-wrap' }, [tbl]));
        host.appendChild(card);
      }

      function row(model) {
        var stat = usage[model.id] || {};
        var tr = el('tr', { dataset: { id: model.id } });

        tr.appendChild(el('td', { class: 'cell-title' }, [
          el('span', { class: 'ellipsis', title: model.displayName || model.id, text: model.displayName || model.id })
        ]));
        tr.appendChild(el('td', { class: 'mono' }, [
          el('span', { class: 'ellipsis', title: model.id, text: model.id })
        ]));
        tr.appendChild(el('td', {}, [
          el('span', { class: 'ellipsis', title: model.baseUrl || '', text: model.provider || '—' })
        ]));
        tr.appendChild(el('td', { class: 'cell-num', text: AB.fmt.contextWindow(model.contextWindow) }));
        tr.appendChild(el('td', { class: 'cell-center' }, [
          model.multimodal ? ui.tag('是') : el('span', { class: 'muted', text: '否' })
        ]));

        var starCell = el('td', { class: 'cell-center' });
        starCell.appendChild(starButton(model));
        tr.appendChild(starCell);

        tr.appendChild(el('td', {
          class: 'cell-num',
          title: stat.lastUsedAt ? '最后使用：' + AB.fmt.dateTime(stat.lastUsedAt) : '本次运行未使用',
          text: AB.fmt.num(stat.requests || 0)
        }));
        tr.appendChild(el('td', {
          class: 'cell-num',
          title: model.lastLatencyTitle || '',
          text: stat.lastLatencyMs ? AB.fmt.ms(stat.lastLatencyMs) : '—'
        }));

        var switchCell = el('td', { class: 'cell-center' });
        switchCell.appendChild(switchControl(model, tr));
        tr.appendChild(switchCell);

        return tr;
      }

      function starButton(model) {
        var btn = el('button', {
          type: 'button',
          class: 'star' + (model.isDefault ? ' is-on' : ''),
          'aria-label': model.isDefault ? model.displayName + ' 是默认模型' : '设为默认：' + model.displayName,
          'aria-pressed': model.isDefault ? 'true' : 'false',
          title: model.isDefault ? '默认模型' : '设为默认',
          onclick: function () {
            if (model.isDefault) return;
            AB.api.patchModel(model.id, { isDefault: true }).then(function (res) {
              ui.toast('默认模型已切换为 ' + model.displayName, 'ok');
              applyDefaultFrom(res);
              render();
            }, function (err) {
              ui.toast(err.message || '设置默认失败', 'error');
            });
          }
        }, [AB.icon('star', 15)]);
        return btn;
      }

      function applyDefaultFrom(res) {
        var defaultId = (res.model && res.model.id) || '';
        if (res.model && res.model.isDefault === false) defaultId = '';
        models.forEach(function (item) { item.isDefault = item.id === defaultId; });
      }

      function switchControl(model, tr) {
        var sw = ui.switchControl({
          checked: model.enabled,
          small: true,
          label: (model.enabled ? '停用' : '启用') + ' ' + (model.displayName || model.id),
          title: '启用 / 停用该模型',
          onChange: function (next, node) {
            /* 乐观更新：先改本地，失败再回滚 */
            model.enabled = next;
            node.setSwitchBusy(true);
            AB.api.patchModel(model.id, { enabled: next }).then(function () {
              if (!alive) return;
              node.setSwitchBusy(false);
              ui.toast((next ? '已启用 ' : '已停用 ') + (model.displayName || model.id), next ? 'ok' : 'info');
              render();
            }, function (err) {
              model.enabled = !next;
              node.setSwitchBusy(false);
              node.setChecked(!next);
              ui.toast((err.message || '更新失败') + '（已回滚）', 'error');
            });
          }
        });
        return sw;
      }

      load();

      return {
        onGatewayChange: function (prev, next) {
          if (prev !== next) load();
        }
      };
    }
  });
})(window.AB);